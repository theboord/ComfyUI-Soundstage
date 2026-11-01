// Director's assistant (browser side): talk to the App, it proposes a plan, Apply runs it through the App's own APIs.
//
//   import { Director } from "./agent/director.mjs";
//   const d = new Director({ api, stage, host });        // host: the App hooks (see HOST below), all optional
//   const p = await d.propose("put Mara in the sports car at night, rain, camera on the hood");   // nothing changes yet
//   const r = await d.apply(p);                          // runs each call; GPU calls need { confirmGpu: true }
//   d.undo();                                            // one Director turn back (scene, look, approvals, cut)
//
// The server (soundstage/agent/director.py) owns the tool schema and validates every call; this file runs them.
// Language models: the local Qwen3.5 4B through ComfyUI's queue (default, offline), an Ollama model on this machine
// (no queue: it answers while a render runs), or an opt-in API model (only listed with SOUNDSTAGE_PARTNER_MODELS=1).
// "rules" needs no model at all. Every backend falls back to the rules when its answer is unusable.
//
// HOST (from soundstage.js): onLoad(scene) resync the panels · look {get(), set(patch)} · pipeline · script
// {switchScene(id), script, liveKey} · sceneAgent (SceneAgent) · cut {entries(), add(ids), flatten()} · renders(sid)
// · chosen(sid) · approvals {statusOf, setTakeStatus} · snapshot() / restore(snap) for non-scene state · play()
// · shotsInOrder() [{id, name}] · say(msg) the App status line.
import { applyOps, loadScene, runLocalModel } from "./agent.mjs";

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LS = "ss_director_";
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage blocked */ } };

export const BACKENDS = {
  qwen: "Local Qwen3.5 4B (offline, on the GPU queue)",
  ollama: "Ollama on this computer",
  rules: "Rules only (instant, no model)",
  api: "API model (opt-in)",
};
export const YES_RE = /^\s*(yes|yeah|yep|yup|apply|apply it|go|go ahead|do it|confirm|ok(ay)?|sure|make it so|action|let'?s go)\b[\s.!]*$/i;
export const NO_RE = /^\s*(no|nope|cancel|never ?mind|stop|scrap that|discard|forget it)\b[\s.!]*$/i;

const MOVE = { slow: 0.18, medium: 0.33, fast: 0.5 };
const SPEED_MS = { slow: 6, medium: 12, fast: 18 };          // drive speeds, m/s
const CAR_VIEW = { hood: "windshield", windshield: "windshield", driver_pov: "driver_pov", passenger: "passenger_on_driver",
  back_seat: "back_seat", dashboard: "dash_two_shot", side: "side_tracking", top: "top_down" };
const VIEW_WORDS = { hood: "on the hood, looking back through the windscreen", windshield: "through the windscreen",
  driver_pov: "at the driver's eye line, on the road ahead", passenger: "in the passenger seat, on the driver",
  back_seat: "in the back seat", dashboard: "on the dashboard, looking back at the front seats", side: "tracking alongside",
  top: "straight overhead" };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const r3 = (a) => a.map((v) => Math.round(v * 1000) / 1000);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * An animated camera move as two keys (start = the shot's first key, end = moved), in the shot's own key space (a
 * camera riding a vehicle moves relative to it). Returns { keys, metres } or null.
 */
export function cameraMoveKeys(k0, move, speed = "medium", lastFrame = 96) {
  if (!k0?.position || !k0?.target) return null;
  const p = [...k0.position], t = [...k0.target];
  const d = sub(t, p), dist = len(d) || 1, n = mul(d, 1 / dist);
  const f = MOVE[speed] ?? MOVE.medium;
  let p1 = p, t1 = t, metres = 0;
  if (move === "push_in") { metres = Math.min(dist * f, Math.max(0, dist - 0.6)); p1 = add(p, mul(n, metres)); }
  else if (move === "pull_out") { metres = Math.max(1, dist * f * 1.5); p1 = sub(p, mul(n, metres)); }
  else if (move === "truck_left" || move === "truck_right") {
    const right = [n[2], 0, -n[0]];   // (forward x up) on the floor
    const rl = Math.hypot(right[0], right[2]) || 1;
    metres = { slow: 1, medium: 2, fast: 4 }[speed] || 2;
    const s = (move === "truck_right" ? -1 : 1) * metres / rl;
    p1 = add(p, mul(right, s)); t1 = add(t, mul(right, s));
  } else if (move === "crane_up" || move === "crane_down") {
    metres = { slow: 0.8, medium: 1.6, fast: 3 }[speed] || 1.6;
    p1 = [p[0], Math.max(0.3, p[1] + (move === "crane_up" ? metres : -metres)), p[2]];
  } else if (move === "orbit_left" || move === "orbit_right") {
    const deg = ({ slow: 15, medium: 30, fast: 60 }[speed] || 30) * (move === "orbit_right" ? -1 : 1);
    const a = deg * Math.PI / 180, ox = p[0] - t[0], oz = p[2] - t[2];
    p1 = [t[0] + ox * Math.cos(a) - oz * Math.sin(a), p[1], t[2] + ox * Math.sin(a) + oz * Math.cos(a)];
    metres = Math.abs(deg);
  } else if (move === "static") {
    return { keys: [{ frame: 0, position: r3(p), target: r3(t), focal_mm: k0.focal_mm }], metres: 0 };
  } else return null;
  return { metres: Math.round(metres * 10) / 10, keys: [
    { frame: 0, position: r3(p), target: r3(t), focal_mm: k0.focal_mm },
    { frame: lastFrame, position: r3(p1), target: r3(t1), focal_mm: k0.focal_mm }] };
}

/**
 * Keys that drive a vehicle in a straight line through point c (x, z): it passes c about 45 % into the shot at the
 * given speed, starting from where it is when that's a sensible run-up. Returns { keys, hitFrame, kmh }.
 */
export function drivePathKeys(start, c, { speed = "fast", frames = 97, fps = 24, heading = 0 } = {}) {
  const last = Math.max(1, frames - 1), v = SPEED_MS[speed] || 12, D = v * last / fps;
  let dir = [c[0] - start[0], 0, c[2] - start[2]];
  let run = Math.hypot(dir[0], dir[2]);
  if (run < 1) { dir = [Math.sin(heading), 0, Math.cos(heading)]; run = 0; }
  dir = mul(dir, 1 / (Math.hypot(dir[0], dir[2]) || 1));
  const before = run >= 6 && run <= 0.6 * D ? run : Math.max(6, Math.min(40, 0.45 * D));
  const after = Math.max(8, Math.min(40, D - before));
  const p0 = [c[0] - dir[0] * before, 0, c[2] - dir[2] * before], p1 = [c[0] + dir[0] * after, 0, c[2] + dir[2] * after];
  const hit = Math.round(last * before / (before + after));
  return { hitFrame: hit, kmh: Math.round(v * 3.6), keys: [{ frame: 0, position: r3(p0) }, { frame: last, position: r3(p1) }] };
}

/** The Ollama model to use when none is picked: a text model (not vision, not embeddings), the largest first. */
export function pickOllama(models) {
  const size = (m) => parseFloat(String(m.size || "").replace(/[^\d.]/g, "")) || 0;
  const text = (models || []).filter((m) => !/embed|vl\b|vl:|vision|llava/i.test(m.name));
  return [...(text.length ? text : models || [])].sort((a, b) => size(b) - size(a))[0] || null;
}

/** 16-bit mono PCM WAV from float samples. */
export function encodeWav(samples, rate = 16000) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Uint8Array(buf);
}

/** Linear resample (push-to-talk audio to Whisper's 16 kHz). */
export function downsample(x, from, to = 16000) {
  if (from === to) return x;
  const n = Math.round(x.length * to / from), out = new Float32Array(n), r = (x.length - 1) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) { const p = i * r, j = Math.floor(p), f = p - j; out[i] = x[j] * (1 - f) + (x[Math.min(x.length - 1, j + 1)] ?? 0) * f; }
  return out;
}

/** What the director's words say about the GPU: "go" (or "go ahead") anywhere means don't ask (mirrors director.py). */
export function wantsGo(text) {
  return /(?:^|[,.;!:]\s*|\b(?:and|then|so|just)\s+)go(?:\s+ahead|\s+for\s+it)?\s*(?:[,.;!]|$)|\bgo ahead\b|\bwithout asking\b|\bno need to (?:ask|confirm)\b|\bdon'?t ask\b/i.test(text || "");
}

// --------------------------------------------------------------------------------------------- the Director

export class Director {
  constructor({ api, stage, host = {}, onEvent } = {}) {
    Object.assign(this, { api, stage, host });
    this.onEvent = onEvent || (() => {});
    this.undoStack = [];
    this.redoStack = [];
    this.turns = [];            // [{command, backend, timing, calls, results}] (latency table, tests)
    this.backend = lsGet("backend", "auto");
    this.ollama = { url: lsGet("ollama_url", "http://127.0.0.1:11434"), model: lsGet("ollama_model", "") };
    this.apiModel = { url: lsGet("api_url", ""), model: lsGet("api_model", ""), key: "" };
    this._info = null;
  }

  async info(force = false) {
    if (!this._info || force) {
      try { this._info = await (await this.api.fetchApi("/soundstage/director/info")).json(); } catch { this._info = { available: false, tools: [] }; }
    }
    return this._info;
  }

  setBackend(b) { this.backend = b; lsSet("backend", b); }
  setOllama(o) { Object.assign(this.ollama, o); lsSet("ollama_url", this.ollama.url); lsSet("ollama_model", this.ollama.model); }
  setApiModel(o) { Object.assign(this.apiModel, o); lsSet("api_url", this.apiModel.url); lsSet("api_model", this.apiModel.model); }

  /** Ollama models reachable from this browser ([] when Ollama isn't running). */
  async ollamaModels() {
    try {
      const r = await fetch(`${this.ollama.url.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout?.(1500) });
      const j = await r.json();
      return (j.models || []).filter((m) => !/embed/i.test(m.name)).map((m) => ({ name: m.name, size: m.details?.parameter_size || "" }));
    } catch { return []; }
  }

  async resolvedBackend() {
    if (this.backend !== "auto") return this.backend;
    return (await this.info()).available ? "qwen" : "rules";
  }

  /** The App context the planner needs besides the scene: shots in strip order, script scenes, renders. */
  context() {
    const st = this.stage.toJSON();
    const shots = (this.host.shotsInOrder?.() || st.shots || []).map((s) => ({ id: s.id, name: s.name || s.id }));
    const sc = this.host.script?.script;
    const scenes = (sc?.scenes || []).map((s) => ({ id: s.id, number: s.number, heading: s.heading }));
    const renders = {};
    for (const s of shots) { try { renders[s.id] = Object.keys(this.host.renders?.(s.id) || {}); } catch { /* none */ } }
    // The Director's Book (Milestone 23): the scene's intent, style, rules and notes, read before every command.
    let book = null;
    try { book = this.host.book?.context?.() || null; } catch { book = null; }
    return { shots, active_shot: st.active_shot, scenes, live_scene: this.host.script?.liveKey || null, renders, book };
  }

  async _post(path, body) {
    const r = await this.api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 200) throw new Error(j.error || `${path} failed (${r.status})`);
    return j;
  }

  /** Is something already running on the ComfyUI queue (a render)? */
  async _gpuBusy() {
    try {
      const q = await (await this.api.fetchApi("/queue")).json();
      return (q.queue_running || []).length > 0;
    } catch { return false; }
  }

  /** Ask the chosen model for tool calls (raw text, or null to use the rules). */
  async _llm(backend, p) {
    if (backend === "qwen") {
      return runLocalModel(this.api, { system: p.system, prompt: p.prompt, max_length: p.max_length, model: p.model }, { timeoutMs: 90000 });
    }
    const messages = [{ role: "system", content: p.system }, { role: "user", content: p.prompt }];
    if (backend === "ollama") {
      let model = this.ollama.model;
      if (!model) model = pickOllama(await this.ollamaModels())?.name;
      if (!model) throw new Error("no Ollama model found");
      const r = await fetch(`${this.ollama.url.replace(/\/$/, "")}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false, format: "json", think: false, options: { temperature: 0, num_predict: 400 } }),
        signal: AbortSignal.timeout?.(60000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      return j.message?.content || "";
    }
    if (backend === "api") {
      if (!(await this.info()).partner) throw new Error("API models are off in this open-weights build (SOUNDSTAGE_PARTNER_MODELS=1 lists them)");
      if (!this.apiModel.url || !this.apiModel.key) throw new Error("set the API URL and key first");
      const r = await fetch(`${this.apiModel.url.replace(/\/$/, "")}/chat/completions`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiModel.key}` },
        body: JSON.stringify({ model: this.apiModel.model, messages, temperature: 0, response_format: { type: "json_object" } }) });
      const j = await r.json();
      return j.choices?.[0]?.message?.content || "";
    }
    return null;
  }

  /** Words -> a proposed plan. Nothing on the stage changes. */
  async propose(command, { backend = null } = {}) {
    const t0 = performance.now();
    const scene = this.stage.toJSON(), ctx = this.context();
    let be = backend || (await this.resolvedBackend());
    let llm_text = null, llm_ms = 0, llm_error = null, busyNote = null;
    // The local Qwen runs on the shared ComfyUI queue: behind a running render it would wait minutes. Then plan with an
    // Ollama model on this computer if there is one, else the rules, right away.
    if (be === "qwen" && !backend) {
      const running = await this._gpuBusy();
      if (running) {
        // Only an Ollama model you picked in ⚙ stands in (a CPU-only machine can be slower than the render).
        const ol = this.ollama.model ? await this.ollamaModels() : [];
        be = ol.some((m) => m.name === this.ollama.model) ? "ollama" : "rules";
        busyNote = `the GPU is busy rendering, so I planned with ${be === "ollama" ? `Ollama (${this.ollama.model})` : "the rules"} instead of waiting`;
      }
    }
    if (be !== "rules") {
      try {
        const p = await this._post("/soundstage/director/prompt", { command, scene, ctx });
        this.onEvent({ type: "thinking", backend: be });
        const t1 = performance.now();
        llm_text = await this._llm(be, p);
        llm_ms = performance.now() - t1;
      } catch (e) { llm_error = e.message || String(e); }
    }
    const t2 = performance.now();
    const plan = await this._post("/soundstage/director/plan", { command, scene, ctx, llm_text });
    const plan_ms = performance.now() - t2;
    plan.timing = { llm_ms: Math.round(llm_ms), plan_ms: Math.round(plan_ms), propose_ms: Math.round(performance.now() - t0) };
    plan.requested_backend = backend || this.backend;
    plan.used_backend = be;
    if (llm_error) plan.notes = [...(plan.notes || []), `model unavailable (${llm_error}); used the rules`];
    if (busyNote) plan.notes = [...(plan.notes || []), busyNote];
    plan.llm_text = llm_text;
    plan.sceneSig = JSON.stringify(scene).length + ":" + scene.active_shot;
    return plan;
  }

  _snapshot() {
    return { scene: this.stage.toJSON(), extra: this.host.snapshot?.() };
  }

  _restore(s) {
    const scene = loadScene(this.stage, s.scene);
    try { this.host.restore?.(s.extra); } catch { /* host away */ }
    try { this.host.onLoad?.(scene); } catch { /* panels not built */ }
  }

  /**
   * Run a proposal's calls in order through the App. GPU calls (frames, renders) are skipped unless confirmGpu.
   * Returns { results: [{tool, ok, said, why?}], said[], explain, next[], queued }.
   */
  async apply(plan, { confirmGpu = false, source = "panel" } = {}) {
    const t0 = performance.now();
    const before = this._snapshot();
    const results = [];
    let queued = 0;
    for (const call of plan.calls || []) {
      if (call.gpu && !confirmGpu) { results.push({ tool: call.tool, ok: false, skipped: true, said: `Skipped (needs your OK): ${call.plan.replace(/^I'll /, "")}` }); continue; }
      const ex = EXEC[call.tool];
      if (!ex) { results.push({ tool: call.tool, ok: false, said: `I don't know how to ${call.tool} yet.` }); continue; }
      this.onEvent({ type: "step", call });
      try {
        const r = (await ex.call(this, call.args || {}, call)) || {};
        if (call.gpu && r.ok !== false) queued += r.queued || 0;
        results.push({ tool: call.tool, ok: r.ok !== false, said: r.said || call.plan.replace(/^I'll /, "Done: "), why: r.why });
      } catch (e) {
        results.push({ tool: call.tool, ok: false, said: `${call.tool} didn't work: ${e.message || e}` });
      }
      await sleep(0);
    }
    const changed = results.some((r) => r.ok && !["undo", "play", "frames", "render"].includes(r.tool));
    const isUndo = (plan.calls || []).every((c) => c.tool === "undo");
    if (changed && !isUndo) {
      this.undoStack.push({ label: plan.command || plan.summary, before, after: this._snapshot() });
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.redoStack = [];
    }
    try { this.host.onLoad?.(this.stage.toJSON()); } catch { /* */ }
    // The Director's Book remembers what was decided here (a note on the scene the next commands read).
    if (changed && !isUndo) { try { this.host.book?.recordDecision?.({ command: plan.command, calls: plan.calls, results }); } catch { /* no book */ } }
    const out = { ok: results.every((r) => r.ok || r.skipped), results, said: results.map((r) => r.said), queued,
      explain: explainFor(plan.calls || [], results), next: this.nextSteps(plan), source,
      apply_ms: Math.round(performance.now() - t0), undoable: changed && !isUndo };
    this.turns.push({ command: plan.command, backend: plan.backend, requested: plan.requested_backend, used: plan.used_backend,
      timing: { ...(plan.timing || {}), apply_ms: out.apply_ms }, calls: (plan.calls || []).map((c) => c.tool), results });
    return out;
  }

  get canUndo() { return this.undoStack.length > 0; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this._restore(e.before);
    this.redoStack.push(e);
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this._restore(e.after);
    this.undoStack.push(e);
    return e.label;
  }

  /** Up to three next steps a director would take, as {label, command} chips. */
  nextSteps(plan = {}) {
    const st = this.stage.toJSON(), ctx = this.context();
    const sid = st.active_shot, n = Math.max(1, ctx.shots.findIndex((s) => s.id === sid) + 1);
    const r = ctx.renders[sid] || [];
    const chosen = (() => { try { return !!this.host.chosen?.(sid); } catch { return false; } })();
    const out = [];
    const tools = (plan.calls || []).map((c) => c.tool);
    if (!tools.includes("play")) out.push({ label: "Play it", command: "play it" });
    if (!chosen && !r.includes("look")) out.push({ label: `Paint a first frame for shot ${n}`, command: `paint frames for shot ${n}` });
    else if (!r.includes("draft")) out.push({ label: `Render a draft of shot ${n}`, command: `render a draft of shot ${n}` });
    else if (!r.some((k) => /final/.test(k))) out.push({ label: `Approve shot ${n}`, command: `approve shot ${n}` }, { label: `Render the final of shot ${n}`, command: `render the final of shot ${n}` });
    const withDraft = ctx.shots.filter((s) => (ctx.renders[s.id] || []).some((k) => /draft|final/.test(k))).length;
    if (withDraft >= 2 && !tools.includes("cut")) out.push({ label: "Cut it together", command: "cut it together with the best takes" });
    if (tools.includes("drive") || tools.includes("stunt")) out.unshift({ label: "Play the stunt", command: "play it" });
    const seen = new Set();
    return out.filter((x) => !seen.has(x.command) && seen.add(x.command)).slice(0, 3);
  }

  // ----------------------------------------------------------------- helpers the executors share
  _patch(fn) {
    const s = this.stage.toJSON();
    fn(s);
    return loadScene(this.stage, s);
  }

  _actor(id) { return (this.stage.toJSON().actors || []).find((a) => a.id === id) || null; }

  _shotIndex(sid) {
    const shots = this.context().shots;
    const i = shots.findIndex((s) => s.id === sid);
    return i < 0 ? sid : `shot ${i + 1}`;
  }

  async _waitMeshes(ids, ms = 4000) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const m = this.stage.actorMeshes;
      if (!m || ids.every((id) => m.has?.(id))) return true;
      await sleep(60);
    }
    return false;
  }
}

// --------------------------------------------------------------------------------------------- executors
// Each returns {ok, said} in plain film language (past tense: what happened on the stage).

const EDIT_SAID = {
  add: (a) => `Put a ${a.what} on set${a.near ? ` by the ${a.near}` : ""}.`,
  stack: (a) => `Stacked ${a.count} ${a.what}s${a.near ? ` by the ${a.near}` : ""}.`,
  move: (a) => `Moved ${a.target}${a.near ? ` next to the ${a.near}` : ` ${a.dir}`}.`,
  remove: (a) => `Struck ${a.target} from the set.`,
  turn: (a) => `Turned ${a.target}${a.face ? ` to face ${a.face}` : ""}.`,
  scale: (a) => `Made ${a.target} ${a.factor > 1 ? "bigger" : "smaller"}.`,
  time: (a) => ({ night: "It's night: moonlight, the practicals carry the scene.", dawn: "Dawn: cold, low light before the sun.",
    golden_am: "Early golden hour: warm, low sun from the east.", midday: "Midday: hard sun, short shadows.",
    overcast: "Overcast: soft, shadowless daylight.", magic_hour: "Magic hour: warm, low sun and long shadows.",
    blue_hour: "Blue hour: the deep blue after sunset." })[a.preset] || `Time of day: ${a.preset}.`,
  weather: (a) => (a.weather === "none" ? "Cleared the weather." : `${a.weather[0].toUpperCase()}${a.weather.slice(1)} on the set${a.weather === "rain" ? ": wet streets that catch every light" : ""}.`),
  set: (a) => `Moved to the ${a.set.replace(/_/g, " ")} set.`,
  light: (a) => `Rigged a ${a.type} light${a.on ? ` on ${a.on}` : ""}.`,
  add_shot: (a) => `Added a ${a.setup.replace(/_/g, " ")} setup${a.on ? ` on ${a.on}` : ""}.`,
  reframe: (a) => `Nudged the camera ${a.move.replace(/_/g, " ")}.`,
};

function editExec(tool) {
  return async function (a, call) {
    if (!call.ops?.length) return { ok: false, said: `Nothing to change for ${tool}.` };
    applyOps(this.stage, call.ops);
    return { ok: true, said: EDIT_SAID[tool]?.(a) || call.plan.replace(/^I'll /, "Done: ") };
  };
}

export const EXEC = {
  ...Object.fromEntries(Object.keys(EDIT_SAID).map((t) => [t, editExec(t)])),

  async mount(a) {
    const r = this._actor(a.target_id), h = this._actor(a.on_id);
    if (!r || !h) return { ok: false, said: `Couldn't find ${!r ? a.target : a.on}.` };
    if (r.mount_id === h.id) return { ok: true, said: `${r.name} is already in the ${h.name.toLowerCase()}.` };
    const vehicle = /car|truck|bus|boat/.test(h.kind);
    const ok = this.stage.mount(r.id, h.id, null, 0, vehicle ? 0 : null);
    return { ok, said: ok ? `${r.name} is ${vehicle ? "at the wheel of" : "on"} the ${h.name.toLowerCase()}.` : `${r.name} can't get on the ${h.name}.` };
  },

  async dismount(a) {
    this.stage.unmount(a.target_id);
    return { ok: true, said: `${a.target} is out and on foot.` };
  },

  async select_shot(a) {
    this.stage.setActiveShot(a.shot);
    try { this.host.pipeline?.selectShot?.(a.shot); } catch { /* the steps follow the stage */ }
    const sh = (this.stage.toJSON().shots || []).find((s) => s.id === a.shot);
    return { ok: true, said: `Working on ${this._shotIndex(a.shot)}${sh?.name ? ` (${sh.name})` : ""}.` };
  },

  async lens(a) {
    const mm = Math.round(a.mm);
    this._patch((s) => {
      const sh = (s.shots || []).find((x) => x.id === s.active_shot) || s.shots?.[0];
      for (const k of sh?.camera_keys || []) k.focal_mm = mm;
      if (sh) s.camera_keys = sh.camera_keys;
    });
    const feel = mm < 24 ? "ultra-wide: big depth, the space stretches" : mm < 35 ? "wide: plenty of world around them" :
      mm <= 60 ? "normal, close to the eye" : mm <= 110 ? "a portrait lens: the background compresses and falls soft" : "long: flat, voyeuristic, shallow";
    return { ok: true, said: `${mm} mm on ${this._shotIndex(this.stage.toJSON().active_shot)}: ${feel}.` };
  },

  async camera_move(a) {
    let info = null;
    this._patch((s) => {
      const sh = (s.shots || []).find((x) => x.id === s.active_shot) || s.shots?.[0];
      if (!sh?.camera_keys?.length) return;
      const last = Math.max(1, (s.shot?.frames || 97) - 1);
      const res = cameraMoveKeys(sh.camera_keys[0], a.move, a.speed, last);
      if (!res) return;
      sh.camera_keys = res.keys;
      s.camera_keys = sh.camera_keys;
      info = { ...res, secs: ((last + 1) / (s.shot?.fps || 24)).toFixed(1) };
    });
    if (!info) return { ok: false, said: "This shot has no camera to move." };
    const name = this._shotIndex(this.stage.toJSON().active_shot);
    const w = { push_in: `pushes in ${info.metres} m`, pull_out: `pulls out ${info.metres} m`, truck_left: `trucks ${info.metres} m left`,
      truck_right: `trucks ${info.metres} m right`, crane_up: `cranes up ${info.metres} m`, crane_down: `cranes down ${info.metres} m`,
      orbit_left: `orbits ${info.metres}° left`, orbit_right: `orbits ${info.metres}° right`, static: "is locked off" }[a.move];
    return { ok: true, said: a.move === "static" ? `${name} is locked off: one camera position for the whole take.` :
      `${name} is a ${a.speed} move now: the camera ${w} over ${info.secs} s.` };
  },

  async rig(a) {
    this.stage.setRig(a.type);
    return { ok: true, said: a.type === "handheld" ? "Handheld: a little breathing life in the frame." : `Camera on a ${a.type}.` };
  },

  async camera_on(a) {
    if (a.view === "off") { this.stage.setCameraFollow(null); return { ok: true, said: "The camera is back on the ground." }; }
    this.stage.setCameraFollow(a.target_id, CAR_VIEW[a.view] || "windshield");
    return { ok: true, said: `Camera rigged ${VIEW_WORDS[a.view] || "on the vehicle"} of the ${a.target.toLowerCase()}: it rides with the car.` };
  },

  async stunt(a) {
    const label = this.stage.applyStunt(a.target_id, a.stunt);
    if (!label) return { ok: false, said: `The ${a.target} can't do that stunt.` };
    return { ok: true, said: a.stunt === "none" ? `Cleared the ${a.target.toLowerCase()}'s stunt.` :
      `The ${a.target.toLowerCase()} does a ${label}: keys written for the whole shot, tyre smoke included.` };
  },

  async drive(a) {
    const s0 = this.stage.toJSON();
    const car = (s0.actors || []).find((x) => x.id === a.target_id);
    const hits = (s0.actors || []).filter((x) => (a.through_ids || []).includes(x.id));
    if (!car || !hits.length) return { ok: false, said: "Couldn't find the car or what to drive through." };
    const c = [hits.reduce((s, h) => s + h.position[0], 0) / hits.length, 0, hits.reduce((s, h) => s + h.position[2], 0) / hits.length];
    const start = (car.keys?.[0]?.position) || car.position;
    const res = drivePathKeys(start, c, { speed: a.speed || "fast", frames: s0.shot?.frames || 97, fps: s0.shot?.fps || 24,
      heading: ((car.rotation_deg || 0) * Math.PI) / 180 });
    this._patch((s) => {
      const v = s.actors.find((x) => x.id === car.id);
      v.keys = res.keys; v.position = [...res.keys[0].position];
      delete v.stunt; delete v.drive; delete v.position_end;
    });
    const secs = (res.hitFrame / (s0.shot?.fps || 24)).toFixed(1);
    return { ok: true, said: `The ${car.name.toLowerCase()} drives straight through the ${a.through.toLowerCase()} at about ${res.kmh} km/h, hitting at ${secs} s.` };
  },

  async physics(a) {
    const n = this.stage.setPhysics(a.target_ids || [], { mode: a.mode });
    return { ok: n > 0, said: n ? `${a.target} ${n === 1 ? "is" : "are"} ${a.mode} now${a.mode === "dynamic" ? ": they fall and get knocked about" : ""}.` : `Couldn't change ${a.target}.` };
  },

  async bake() {
    const st = this.stage.toJSON();
    await this._waitMeshes((st.actors || []).map((x) => x.id));
    const r = this.stage.simulatePhysics();
    return { ok: !!r?.ok, said: r?.message || "Nothing to simulate." };
  },

  async direct(a) {
    const note = String(a.note || "").trim();
    this._patch((s) => {
      const p = s.actors.find((x) => x.id === a.who_id);
      if (p) p.direction = note;
    });
    const line = `${a.who} is ${note}.`;
    try {
      const look = this.host.look?.get?.() || {};
      const d = String(look.description || "");
      const re = new RegExp(`\\b${a.who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is [a-z ]+\\.`, "i");
      const next = re.test(d) ? d.replace(re, line) : (d ? `${d.replace(/\s+$/, "")} ${line}` : line);
      this.host.look?.set?.({ description: next });
    } catch { /* no look panel */ }
    return { ok: true, said: `Noted for ${a.who}: ${note}. It's in the frame prompt, so the painted frame plays it.` };
  },

  async grade(a) {
    const look = this.host.look?.get?.();
    if (!look) return { ok: false, said: "The Look panel isn't loaded." };
    const g = { ...(look.grade || {}) };
    const parts = [];
    for (const k of ["warmth", "contrast", "saturation", "grain", "halation", "vignette"]) {
      if (a[k] == null) continue;
      g[k] = Math.max(-1, Math.min(1, Math.round(((g[k] || 0) + a[k]) * 100) / 100));
      parts.push(`${k} ${g[k] >= 0 ? "+" : ""}${g[k].toFixed(2)}`);
    }
    this.host.look.set({ grade: g });
    const warm = a.warmth > 0 ? "Warmer: amber skin and highlights. " : a.warmth < 0 ? "Cooler: bluer shadows. " : "";
    return { ok: true, said: `${warm}Grade now ${parts.join(", ")}. It applies to every frame you paint from here on.` };
  },

  async scene(a) {
    const r = this.host.script?.switchScene?.(a.scene);
    if (!r?.ok) return { ok: false, said: r?.why ? `Staying on this scene while ${r.why}.` : "There's no script loaded." };
    const sc = (this.host.script.script?.scenes || []).find((s) => s.id === a.scene);
    return { ok: true, said: `Scene ${sc?.number ?? ""}: ${sc?.heading || ""}.`.replace(/\s+:/, ":") };
  },

  async frames(a) {
    const p = this.host.pipeline;
    if (!p?.generateFrames) return { ok: false, said: "Frames need the ④ Frame step." };
    if (a.count && p.f) p.f.count = a.count;
    let n = 0;
    for (const sid of a.shots || []) {
      p.selectShot?.(sid);
      await p.generateFrames(false);
      n += p.f?.count || 1;
    }
    return { ok: true, queued: n, said: `Painting ${plural(n, "frame option")} on the GPU (about 6-10 s each once warm). They land in ④ Frame.` };
  },

  async render(a) {
    const p = this.host.pipeline;
    if (!p?._render) return { ok: false, said: "Renders need the ⑤ Motion step." };
    const step = a.kind === "final" ? 4 : 3;
    const prev = this.stage.toJSON().active_shot;
    let n = 0;
    for (const sid of a.shots || []) {
      p.selectShot?.(sid);
      await p._render(step, false);
      n++;
    }
    if (prev && (a.shots || []).length > 1) p.selectShot?.(prev);
    const each = step === 3 ? "about 2-4 min each" : "about 4-6 min each";
    const names = (a.shots || []).map((s) => this._shotIndex(s)).join(", ");
    return { ok: true, queued: n, said: `Queued ${plural(n, a.kind)} (${names}), ${each}. Each lands on its shot in ⑥ Review.` };
  },

  async approve(a) {
    const ap = this.host.approvals;
    if (!ap) return { ok: false, said: "Approvals aren't loaded." };
    const st = ap.statusOf(a.shot);
    if (!st?.take) return { ok: false, said: `${this._shotIndex(a.shot)} has nothing to review yet: paint a frame or render a draft first.` };
    ap.setTakeStatus(a.shot, st.take, a.status, a.note);
    const w = { approved: "Approved ✓", changes: "Needs changes ↺", rejected: "Rejected ✕" }[a.status];
    return { ok: true, said: `${w}: ${this._shotIndex(a.shot)}'s ${st.take.kind || "take"}${a.note ? ` (${a.note})` : ""}.` };
  },

  async cut() {
    const c = this.host.cut;
    if (!c?.flatten) return { ok: false, said: "The cut isn't loaded." };
    const ctx = this.context();
    const inCut = new Set((c.entries?.() || []).map((e) => e.shot_id));
    const rejected = (sid) => { try { return this.host.approvals?.statusOf(sid)?.status === "rejected"; } catch { return false; } };
    const missing = ctx.shots.map((s) => s.id).filter((id) => !inCut.has(id) && !rejected(id));
    if (missing.length) c.add?.(missing);
    const best = ctx.shots.map((s) => {
      const r = ctx.renders[s.id] || [];
      return r.some((k) => /final/.test(k)) ? "final" : r.includes("draft") ? "draft" : r.includes("look") ? "frame" : "slate";
    });
    await c.flatten();
    const count = (k) => best.filter((x) => x === k).length;
    return { ok: true, said: `Cut together: ${ctx.shots.length} shots in strip order, each with its best take (${count("final")} final, ${count("draft")} draft, ${count("frame")} still, ${count("slate")} slate).` +
      (missing.length ? ` Added ${plural(missing.length, "shot")} that weren't in the cut.` : "") };
  },

  async play() {
    if (this.host.play) { this.host.play(); return { ok: true, said: "Playing." }; }
    const st = this.stage.toJSON(), last = (st.shot?.frames || 97) - 1, fps = st.shot?.fps || 24;
    const t0 = performance.now();
    const tick = () => { const f = Math.floor((performance.now() - t0) / 1000 * fps); if (f > last) { this.stage.setFrame(0); return; } this.stage.setFrame(f); requestAnimationFrame(tick); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick);
    return { ok: true, said: "Playing the shot." };
  },

  async undo() {
    const label = this.undo();
    return { ok: !!label, said: label ? `Undid: ${label}` : "Nothing to undo." };
  },

  async build(a) {
    const ag = this.host.sceneAgent;
    if (!ag) return { ok: false, said: "The scene builder isn't loaded." };
    const res = await ag.describe(a.text);
    return { ok: true, said: `Built a new scene: ${res.scene.actors.length} objects, ${res.scene.shots.length} camera setups.` };
  },
};

// The one line a non-technical director gets about why this matters (talk-through mode).
const WHY = {
  camera_move: "A slow push-in leans the audience toward the character; it reads as tension or a realisation.",
  lens: "Longer lenses isolate a face and flatten the background; wide lenses put the world around them.",
  camera_on: "A hood mount is the classic car-scene angle: we sit with the driver through the windscreen.",
  direct: "A one-word note is how directors talk to actors: here it steers the painted frame and the motion prompt.",
  stunt: "Stunts are planned like this in previz: the keys show the timing before anyone touches a real car.",
  drive: "The crash happens in the physics: nothing is faked, so the boxes fly the way the speed says.",
  bake: "Baking freezes the simulation into keys, so every render of the shot gets the same crash.",
  grade: "The grade is the film's colour; warmer reads nostalgic, intimate or hot, cooler reads lonely or tense.",
  time: "Time of day is the biggest lighting decision on a set.",
  render: "Drafts are cheap motion tests; you only pay for finals on the takes you like.",
  cut: "The cut uses the best take of every shot (final, else draft, else the still) so you can watch the scene end to end.",
  frames: "The first frame sets the look; the video starts from the frame you pick.",
  approve: "Approvals are your dailies notes: the cut and the Review step follow them.",
};

export function explainFor(calls, results) {
  const ok = (calls || []).filter((c, i) => results?.[i]?.ok);
  const pick = ["drive", "camera_move", "camera_on", "stunt", "direct", "grade", "render", "cut", "frames", "lens", "bake", "approve", "time"]
    .find((t) => ok.some((c) => c.tool === t));
  return pick ? WHY[pick] : "";
}
