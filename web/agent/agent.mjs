// Soundstage Scene agent (browser side): describe a scene in words -> the stage builds it; then edit it by chat.
//
//   import { SceneAgent } from "./agent/agent.mjs";
//   const agent = new SceneAgent({ api, stage, onStatus: (msg) => (status.textContent = msg) });
//   await agent.describe("rainy night, detective alone in his office");   // builds + loads the scene
//   await agent.edit("add a second detective by the window");            // small undoable ops
//   agent.undo(); agent.redo();
//
// The local model (Qwen3.5-4B via core TextGenerate) runs through ComfyUI's queue exactly like designObject()
// in soundstage.js; the server turns its answer into a scene / ops (soundstage/agent/*, /soundstage/agent/*).
// If the model is missing, busy or answers nonsense, the server's rules backend answers instead.
//
// Stage API used (public only): stage.toJSON(), stage.load(scene), stage.frame, stage.setFrame(f),
// stage.selected, stage.select(id), stage.onChange(scene), stage.onShots?.(), stage.onSelect?.(info).

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------- ops

function findIndex(items, id) {
  return (items || []).findIndex((x) => x.id === id);
}

/** Apply one concrete op to a scene object in place (mirror of soundstage/agent/ops.py apply_op). */
export function applyOp(s, op) {
  const actors = (s.actors ||= []);
  switch (op.op) {
    case "add_object": {
      const idx = Math.max(0, Math.min(op.index ?? actors.length, actors.length));
      actors.splice(idx, 0, clone(op.object));
      break;
    }
    case "remove_object": {
      const i = findIndex(actors, op.id);
      if (i >= 0) actors.splice(i, 1);
      break;
    }
    case "update_object":
    case "move_object":
    case "rotate_object":
    case "scale_object": {
      const a = actors.find((x) => x.id === op.id);
      // null removes the field (undo of a new field such as mount_id leaves no trace).
      if (a) for (const [k, v] of Object.entries(op.set)) { if (v === null) delete a[k]; else a[k] = clone(v); }
      break;
    }
    case "set_environment":
      s.environment = { ...(s.environment || {}), ...op.set };
      break;
    case "set_lighting":
      s.lighting = { ...(s.lighting || {}), ...clone(op.set) };
      if (op.sun) s.sun = { ...op.sun };
      // In "time" mode the stage recomputes the sun from the hour on load().
      break;
    case "add_light": {
      const L = (s.lighting ||= {});
      L.lights = [...(L.lights || []), clone(op.light)];
      break;
    }
    case "remove_light": {
      const L = (s.lighting ||= {});
      L.lights = (L.lights || []).filter((x) => x.id !== op.id);
      break;
    }
    case "add_shot": {
      const shots = (s.shots ||= []);
      shots.splice(Math.max(0, Math.min(op.index ?? shots.length, shots.length)), 0, clone(op.shot));
      break;
    }
    case "remove_shot":
      s.shots = (s.shots || []).filter((x) => x.id !== op.id);
      if (s.active_shot === op.id && s.shots.length) s.active_shot = s.shots[0].id;
      break;
    case "update_shot": {
      const sh = (s.shots || []).find((x) => x.id === op.id);
      if (sh) Object.assign(sh, clone(op.set));
      break;
    }
    case "set_active_shot":
      if ((s.shots || []).some((x) => x.id === op.id)) s.active_shot = op.id;
      break;
    default:
      break; // unknown ops are ignored (forward compatible)
  }
  // Keep the flat camera fields the stage's loader reads in step with the shots.
  const shots = s.shots || [];
  if (shots.length) {
    const act = shots.find((x) => x.id === s.active_shot) || shots[0];
    s.camera_keys = act.camera_keys;
    const k0 = shots[0].camera_keys[0], kn = shots[0].camera_keys[shots[0].camera_keys.length - 1];
    s.camera = { position: k0.position, target: k0.target, focal_mm: k0.focal_mm };
    s.camera_end = { position: kn.position, target: kn.target, focal_mm: kn.focal_mm };
  }
  return s;
}

/** Pure: a new scene with the ops applied in order. */
export function applyOpsToScene(scene, ops) {
  const s = clone(scene);
  for (const op of ops || []) applyOp(s, op);
  return s;
}

/** The ops that revert `ops` (each op carries its own `undo`). */
export function inverseOf(ops) {
  return [...(ops || [])].reverse().map((o) => o.undo).filter(Boolean);
}

/** Load a scene into the stage, keeping the playhead and selection, and tell the widget it changed. */
export function loadScene(stage, scene) {
  const frame = stage.frame || 0;
  const selected = stage.selected;
  stage.load(scene);
  stage.setFrame(Math.min(frame, Math.max(0, (scene.shot?.frames || 97) - 1)));
  if (selected && (scene.actors || []).some((a) => a.id === selected)) stage.select(selected);
  stage.onShots?.();
  stage.onChange(stage.toJSON());
  return stage.toJSON();
}

/** Apply concrete ops to the live stage. Returns the new scene JSON. */
export function applyOps(stage, ops) {
  return loadScene(stage, applyOpsToScene(stage.toJSON(), ops));
}

// ---------------------------------------------------------------------------------------------- model

/** Run the local model once through the ComfyUI queue. Resolves with its text. */
export async function runLocalModel(api, { system, prompt, max_length, model }, { timeoutMs = 120000 } = {}) {
  const graph = {
    sa1: { class_type: "CLIPLoader", inputs: { clip_name: model, type: "stable_diffusion", device: "default" } },
    sa2: { class_type: "PrimitiveStringMultiline", inputs: { value: system } },
    sa3: { class_type: "TextGenerate", inputs: { clip: ["sa1", 0], prompt, max_length, sampling_mode: "off",
      thinking: false, use_default_template: true, system_prompt: ["sa2", 0] } },
    sa4: { class_type: "PreviewAny", inputs: { source: ["sa3", 0] } },
  };
  // Register listeners before queueing so a fast answer cannot slip past.
  let pid = null;
  const early = [];
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const onExec = (ev) => {
    const d = ev.detail || {};
    if (d.node !== "sa4") return;
    if (pid === null) early.push(d);
    else if (d.prompt_id === pid) settle.resolve(d.output?.text?.[0] ?? "");
  };
  const onErr = (ev) => {
    if (pid !== null && ev.detail?.prompt_id === pid) settle.reject(new Error(ev.detail.exception_message || "generation failed"));
  };
  api.addEventListener("executed", onExec);
  api.addEventListener("execution_error", onErr);
  const timer = setTimeout(() => settle.reject(new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  try {
    const resp = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      // front: a short text job goes ahead of queued renders (it still waits for the one running).
      body: JSON.stringify({ prompt: graph, client_id: api.clientId, front: true }) });
    const j = await resp.json();
    if (!j.prompt_id) throw new Error(j.error?.message || "the server refused the model job");
    pid = j.prompt_id;
    const hit = early.find((d) => d.prompt_id === pid);
    if (hit) return hit.output?.text?.[0] ?? "";
    return await done;
  } catch (err) {
    // Gave up waiting: take the job out of the queue so it doesn't run later for nobody.
    if (pid) api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [pid] }) }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    api.removeEventListener("executed", onExec);
    api.removeEventListener("execution_error", onErr);
  }
}

async function postJSON(api, path, body) {
  const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (r.status !== 200) throw new Error(j.error || `${path} failed (${r.status})`);
  return j;
}

// ---------------------------------------------------------------------------------------------- agent

export class SceneAgent {
  /**
   * @param {object} o
   * @param {object} o.api        ComfyUI api (fetchApi, addEventListener, clientId)
   * @param {object} o.stage      the Stage instance
   * @param {function} [o.onStatus]  (message) => void, progress lines for the chat box
   * @param {boolean} [o.useModel=true]  false = rules only (instant, no GPU)
   * @param {boolean} [o.designProps=true]  ask the object designer for props the library lacks
   * @param {number} [o.modelTimeoutMs=60000]  give up on the model and use the rules after this
   * @param {function} [o.onLoad]  (scene) => void after every scene the agent loads (build, edit, undo, redo,
   *   designed prop): resync widget controls that stage.onChange does not cover (Set / Weather selects…)
   */
  constructor({ api, stage, onStatus, onLoad, useModel = true, designProps = true, modelTimeoutMs = 60000 }) {
    Object.assign(this, { api, stage, useModel, designProps, modelTimeoutMs });
    this.onStatus = onStatus || (() => {});
    this.onLoad = onLoad || (() => {});
    this.undoStack = [];
    this.redoStack = [];
    this.history = []; // [{role: "user"|"agent", text}]
    this._info = null;
  }

  async info() {
    if (!this._info) {
      try { this._info = await (await this.api.fetchApi("/soundstage/agent/info")).json(); }
      catch { this._info = { available: false }; }
    }
    return this._info;
  }

  async _ask(mode, payload) {
    if (!this.useModel || !(await this.info()).available) return null;
    const p = await postJSON(this.api, "/soundstage/agent/prompt", { mode, ...payload });
    try {
      return await runLocalModel(this.api, p, { timeoutMs: this.modelTimeoutMs });
    } catch (err) {
      this.onStatus(`Model unavailable (${err.message}); using the rules.`);
      return null;
    }
  }

  /** Words -> a whole new scene on the stage. Undo restores the previous scene. */
  async describe(text, { genre = "" } = {}) {
    const t0 = performance.now();
    this.history.push({ role: "user", text });
    this.onStatus("Reading the scene…");
    const llm_text = await this._ask("build", { text, genre });
    const res = await postJSON(this.api, "/soundstage/agent/build", { text, genre, llm_text });
    const before = this.stage.toJSON();
    this.onLoad(loadScene(this.stage, res.scene));
    this.undoStack.push({ kind: "scene", before, after: res.scene, label: `Describe: ${text}` });
    this.redoStack = [];
    const s = res.plan;
    const msg = `Built a ${s.set.replace("_", " ")} at ${s.time.replace("_", " ")}${s.weather !== "none" ? ` with ${s.weather}` : ""}: `
      + `${res.scene.actors.length} objects, ${res.scene.shots.length} camera setup${res.scene.shots.length > 1 ? "s" : ""} `
      + `(${res.backend}, ${((performance.now() - t0) / 1000).toFixed(1)} s).`;
    this.history.push({ role: "agent", text: msg });
    this.onStatus(msg);
    if (this.designProps && res.designs?.length) this._designAll(res.designs); // fills in while you look
    return res;
  }

  /** A chat command -> small undoable ops applied to the stage. */
  async edit(command) {
    const t0 = performance.now();
    this.history.push({ role: "user", text: command });
    this.onStatus("Working…");
    const scene = this.stage.toJSON();
    const llm_text = await this._ask("edit", { command, scene });
    const res = await postJSON(this.api, "/soundstage/agent/edit", { scene, command, llm_text });
    if (res.ops.length) {
      this.onLoad(applyOps(this.stage, res.ops));
      this.undoStack.push({ kind: "ops", ops: res.ops, inverse: res.inverse, label: command });
      this.redoStack = [];
    }
    const msg = res.ops.length ? `${res.summary} (${((performance.now() - t0) / 1000).toFixed(1)} s)`
      : `I couldn't turn that into a change${res.notes?.length ? `: ${res.notes.join("; ")}` : "."}`;
    this.history.push({ role: "agent", text: msg });
    this.onStatus(msg);
    if (this.designProps) {
      const designs = res.ops.filter((o) => o.op === "add_object" && o.object.recipe?.placeholder)
        .map((o) => ({ id: o.object.id, name: o.object.design }));
      if (designs.length) this._designAll(designs);
    }
    return res;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.onLoad(e.kind === "scene" ? loadScene(this.stage, e.before) : applyOps(this.stage, e.inverse));
    this.redoStack.push(e);
    this.onStatus(`Undid: ${e.label}`);
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.onLoad(e.kind === "scene" ? loadScene(this.stage, e.after) : applyOps(this.stage, e.ops));
    this.undoStack.push(e);
    this.onStatus(`Redid: ${e.label}`);
    return e.label;
  }

  /** Swap placeholder boxes for designed clay stand-ins, one at a time (cached designs are instant). */
  async _designAll(designs) {
    for (const d of designs) {
      try {
        const recipe = await this.designObject(d.name);
        const a = this.stage.toJSON().actors.find((x) => x.id === d.id);
        if (!a || !a.recipe?.placeholder) continue; // removed or already replaced meanwhile
        this.onLoad(applyOps(this.stage, [{ op: "update_object", id: d.id, set: { recipe, height_m: recipe.size_m?.[1] || a.height_m } }]));
        this.onStatus(`Designed “${d.name}”.`);
      } catch (err) {
        this.onStatus(`Kept a box for “${d.name}” (${err.message}).`);
      }
    }
  }

  /** The object designer (same routes and model as the Add box). */
  async designObject(name) {
    const cached = await this.api.fetchApi(`/soundstage/object?name=${encodeURIComponent(name)}`);
    if (cached.status === 200) return cached.json();
    const info = await (await this.api.fetchApi("/soundstage/object_designer")).json();
    if (!info.available) throw new Error(`the designer model ${info.model} isn't installed`);
    this.onStatus(`Designing “${name}”…`);
    const text = await runLocalModel(this.api, { system: info.system_prompt, prompt: `Object: ${name}`, max_length: 1600,
      model: info.model }, { timeoutMs: 180000 });
    return postJSON(this.api, "/soundstage/object", { name, text });
  }
}
