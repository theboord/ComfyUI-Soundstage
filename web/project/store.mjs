// Projects: the pure half of Save / Save As / Open / New / autosave (projectbar.mjs is the DOM and ComfyUI glue).
// No DOM; node-tested in tests/js/project.test.mjs with an in-memory stand-in for ComfyUI's userdata API.
//
//   import { ProjectStore, cleanName, untitledName, statusText, workflowSig } from "./project/store.mjs";
//
// Where things go (ComfyUI's per-user userdata folder, user/<user>/, the same API Workflow → Save uses):
//   workflows/<name>.json                       the project itself: a normal ComfyUI workflow (opens anywhere)
//   projects/<name>/project.json                small manifest {format, v, id, name, workflow, created, saved_at, saves}
//   projects/<name>/autosave/<stamp>.json       {format, v, name, saved_at, workflow: <the whole graph>}, last KEEP kept
// The project's name rides in the workflow too (extra.ss_project), so a project re-opened through Workflow → Open still
// knows which project folder its autosaves belong to. Nothing here writes into ComfyUI's output/ folder.
//
// Project id ("p_" + 8 lowercase hex, e.g. p_3fa85f64): a stable id for memory keyed to one project (Ask's memory).
// Written on purpose by save() into both project.json (id) and the workflow (extra.ss_project.id). An existing id is
// kept ONLY when the workflow being saved carries that same id. Every other save gets a fresh one: Save As to a new
// name, a workflow carrying another id, a workflow with no id at all (even one that names this project: an unrelated
// pre-id graph with the same name must not take this project's id), a workflow saved over a leftover projects/<name>/
// folder, a project saved before ids existed (it gets one on its next save). Known cost: a second tab opened before
// the first id'd save, canvas undo past it, or a restored pre-id autosave, when saved, gets a fresh id too.
// Loading never writes an id. Duplicate gives the copy a fresh id, rename and trash keep it (soundstage/project/library.py).

export const FORMAT = "soundstage-project";
export const VERSION = 1;
export const AUTOSAVE_KEEP = 20;
export const AUTOSAVE_EVERY_MS = 60_000;
export const CHANGE_DEBOUNCE_MS = 4_000;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * A project name that is safe as one folder/file name on Linux, macOS and Windows: no slashes, no "..", no leading dot,
 * no characters Windows refuses, at most 80 characters. "" when nothing usable is left.
 */
export function cleanName(s) {
  let t = String(s ?? "").normalize("NFC")
    .replace(/\.json$/i, "")
    .split(/[\\/]+/).filter((seg) => seg.replace(/[ .]/g, "") !== "").join(" ")   // "../../x" -> "x"
    .replace(/[:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^\.+/, "").replace(/\.{2,}/g, ".").replace(/[. ]+$/, "").trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = `${t}_`;
  return t.slice(0, 80).trim();
}

/** "Untitled 2026-11-04 1432": the name an unnamed project autosaves under (the time keeps two of a day apart). */
export function untitledName(d = new Date()) {
  return `Untitled ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** "20261104-143205-123": autosave file stamp. Sorts in time order as plain text. */
export function autosaveStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/** The stamp's Date back (local time), or null. */
export function stampDate(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?/.exec(String(stamp || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)) : null;
}

/**
 * A change signature of a workflow: the graph as saved, minus the canvas view (pan/zoom is not a change) and our own
 * project stamp (saving is not a change either). Same graph -> same string.
 */
export function workflowSig(wf) {
  if (!wf || typeof wf !== "object") return "";
  const { extra, ...rest } = wf;
  const { ds, ss_project, ...ex } = extra || {};   // eslint-disable-line no-unused-vars
  return hash(JSON.stringify({ ...rest, extra: ex }));
}

function hash(s) {   // FNV-1a 32 bit, hex, plus the length: cheap and good enough to spot a change
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${s.length}`;
}

/** "12 s", "4 min", "2 h", "3 days" since `then` (ms). */
export function ago(then, now = Date.now()) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/**
 * The status pill: "Saved 12 s ago · Autosave on", "Unsaved changes · autosaved 40 s ago", "Not saved yet · Autosave on".
 * Returns {text, state: "saved" | "dirty" | "new" | "error"}.
 */
export function statusText({ savedAt = null, autosavedAt = null, dirty = false, autosaveOn = true, error = null, now = Date.now() } = {}) {
  const tail = autosaveOn ? (autosavedAt && dirty ? `autosaved ${ago(autosavedAt, now)} ago` : "Autosave on") : "Autosave off";
  if (error) return { text: `Save failed: ${error} · ${tail}`, state: "error" };
  if (!savedAt) return { text: `Not saved yet · ${tail}`, state: "new" };
  if (dirty) return { text: `Unsaved changes · ${tail}`, state: "dirty" };
  return { text: `Saved ${ago(savedAt, now)} ago · ${tail}`, state: "saved" };
}

export const PROJECT_ID_RE = /^p_[0-9a-f]{8}$/;

/** A fresh project id: "p_" + 8 lowercase hex (the first 8 hex digits of a random UUID). */
export function newProjectId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) {
    try { return `p_${c.randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase()}`; } catch { /* insecure context */ }
  }
  const b = new Uint8Array(4);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 4; i++) b[i] = Math.floor(Math.random() * 256);
  return `p_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** The project id a workflow carries (extra.ss_project.id), or null when it has none or a malformed one. */
export function projectIdOf(wf) {
  const id = wf?.extra?.ss_project?.id;
  return typeof id === "string" && PROJECT_ID_RE.test(id) ? id : null;
}

/**
 * The workflow, stamped with its project name (extra.ss_project). A copy; the input is left alone. `id` defaults to
 * the id the workflow already carries (so autosaves keep it); pass null to stamp none.
 */
export function stampWorkflow(wf, name, savedAt, id = projectIdOf(wf)) {
  const out = { ...(wf || {}) };
  out.extra = { ...(out.extra || {}), ss_project: { name, saved_at: savedAt, ...(id ? { id } : {}) } };
  return out;
}

/** The project name a workflow was saved under (extra.ss_project.name), or null for any other workflow. */
export const projectNameOf = (wf) => cleanName(wf?.extra?.ss_project?.name || "") || null;

const enc = (p) => p;   // ComfyUI's api.* helpers URL-encode the path themselves

/**
 * Save / open / autosave against ComfyUI's userdata API. `api` needs storeUserData, getUserData,
 * listUserDataFullInfo and deleteUserData (ComfyUI's scripts/api.js has all four).
 */
export class ProjectStore {
  constructor({ api, now = () => Date.now(), keep = AUTOSAVE_KEEP } = {}) {
    this.api = api;
    this.now = now;
    this.keep = keep;
  }

  static workflowPath(name) { return `workflows/${name}.json`; }
  static manifestPath(name) { return `projects/${name}/project.json`; }
  static autosaveDir(name) { return `projects/${name}/autosave`; }

  async _put(path, data) {
    const r = await this.api.storeUserData(enc(path), data, { overwrite: true, stringify: true, throwOnError: true });
    if (r && r.ok === false) throw new Error(`could not write ${path} (${r.status})`);
  }

  async _get(path) {
    const r = await this.api.getUserData(enc(path));
    if (!r || !r.ok) return null;
    try { return await r.json(); } catch { return null; }
  }

  async _list(dir) {
    try { return (await this.api.listUserDataFullInfo(dir)) || []; } catch { return []; }
  }

  /**
   * Save the project: the workflow (as Workflow → Save would) and its manifest. Returns {name, id, path, saved_at,
   * workflow}. The id: the manifest's old id only when the workflow carries that same id, else a fresh one (see the top).
   */
  async save(name, workflow, { manifest = {} } = {}) {
    const n = cleanName(name);
    if (!n) throw new Error("give the project a name");
    const at = this.now();
    const old = (await this._get(ProjectStore.manifestPath(n))) || {};
    const oldId = typeof old.id === "string" && PROJECT_ID_RE.test(old.id) ? old.id : null;
    const id = oldId && projectIdOf(workflow) === oldId ? oldId : newProjectId();
    const wf = stampWorkflow(workflow, n, at, id);
    await this._put(ProjectStore.workflowPath(n), wf);
    const { id: _ignored, ...rest } = manifest || {};   // eslint-disable-line no-unused-vars
    await this._put(ProjectStore.manifestPath(n), {
      ...rest, format: FORMAT, v: VERSION, id, name: n, workflow: ProjectStore.workflowPath(n),
      created: old.created || at, saved_at: at, saves: (old.saves || 0) + 1,
    });
    return { name: n, id, path: ProjectStore.workflowPath(n), saved_at: at, workflow: wf };
  }

  /** A saved project's id (from its project.json), or null (no such project, or saved before ids existed). */
  async projectId(name) {
    const m = await this.manifest(name);
    return typeof m?.id === "string" && PROJECT_ID_RE.test(m.id) ? m.id : null;
  }

  /**
   * Is the id a workflow carries (extra.ss_project.id) the one its project's saved project.json holds? Returns
   * {id, name, graph_id, manifest_id, confirmed}: id is graph_id when confirmed, else null. Not confirmed: no id yet,
   * no project.json under that name (renamed in the library, a collected / exported / dragged-in copy from elsewhere),
   * or project.json holds another id (the name was reused, the copy forked). One small read (project.json).
   */
  async confirmProjectId(workflow) {
    const name = projectNameOf(workflow);
    const graphId = projectIdOf(workflow);
    const manifestId = name ? await this.projectId(name) : null;
    const confirmed = !!graphId && graphId === manifestId;
    return { id: confirmed ? graphId : null, name, graph_id: graphId, manifest_id: manifestId, confirmed };
  }

  /** The saved workflow of a project, or null. */
  async open(name) {
    const n = cleanName(name);
    return n ? this._get(ProjectStore.workflowPath(n)) : null;
  }

  async manifest(name) {
    const n = cleanName(name);
    return n ? this._get(ProjectStore.manifestPath(n)) : null;
  }

  /** Saved projects, newest first: [{name, saved_at}]. Read from projects/<name>/project.json. */
  async list() {
    const files = await this._list("projects");
    const out = [];
    for (const f of files) {
      const p = String(f.path ?? f).replace(/\\/g, "/");
      const m = /^([^/]+)\/project\.json$/.exec(p);
      if (m) out.push({ name: m[1], saved_at: Number(f.modified) || 0 });
    }
    return out.sort((a, b) => b.saved_at - a.saved_at || a.name.localeCompare(b.name));
  }

  /** Write one autosave and drop the oldest past `keep`. Returns {file, removed:[...]}. */
  async autosave(name, workflow) {
    const n = cleanName(name);
    if (!n) throw new Error("no project name");
    const at = this.now();
    const file = `${autosaveStamp(new Date(at))}.json`;
    await this._put(`${ProjectStore.autosaveDir(n)}/${file}`, {
      format: `${FORMAT}-autosave`, v: VERSION, name: n, saved_at: at, workflow: stampWorkflow(workflow, n, at),
    });
    const removed = await this.rotate(n);
    return { file, removed };
  }

  /** Keep the newest `keep` autosaves of a project; delete the rest. Returns the file names removed. */
  async rotate(name, keep = this.keep) {
    const all = await this.autosaves(name);
    const drop = all.slice(Math.max(0, keep));
    for (const a of drop) {
      try { await this.api.deleteUserData(enc(`${ProjectStore.autosaveDir(name)}/${a.file}`)); } catch { /* next time */ }
    }
    return drop.map((a) => a.file);
  }

  /** A project's autosaves, newest first: [{file, at}]. */
  async autosaves(name) {
    const n = cleanName(name);
    if (!n) return [];
    const files = await this._list(ProjectStore.autosaveDir(n));
    return files
      .map((f) => String(f.path ?? f).replace(/\\/g, "/").split("/").pop())
      .filter((f) => /^\d{8}-\d{6}(-\d{3})?\.json$/.test(f))
      .sort().reverse()
      .map((file) => ({ file, at: stampDate(file)?.getTime() || 0 }));
  }

  /** One autosave's workflow (the graph to load), or null. */
  async readAutosave(name, file) {
    const n = cleanName(name);
    const f = String(file || "").split("/").pop();
    if (!n || !/^\d{8}-\d{6}(-\d{3})?\.json$/.test(f)) return null;
    const a = await this._get(`${ProjectStore.autosaveDir(n)}/${f}`);
    return a?.workflow || null;
  }
}

/**
 * When to autosave. Pure: feed it ticks and changes, it says whether to write now.
 *   const t = new AutosaveClock({ every: 60000, debounce: 4000 });
 *   t.change(now)  -> a meaningful change happened
 *   t.due(now)     -> true when an autosave should be written now (then call t.wrote(now))
 */
export class AutosaveClock {
  constructor({ every = AUTOSAVE_EVERY_MS, debounce = CHANGE_DEBOUNCE_MS } = {}) {
    this.every = every;
    this.debounce = debounce;
    this.lastWrite = 0;
    this.lastChange = 0;
    this.pending = false;
  }
  change(now) { this.lastChange = now; this.pending = true; }
  due(now) {
    if (!this.pending) return false;
    if (now - this.lastChange >= this.debounce) return true;          // quiet for a moment after a change
    return now - this.lastWrite >= this.every;                        // or a minute of constant change
  }
  wrote(now) { this.lastWrite = now; this.pending = false; }
}
