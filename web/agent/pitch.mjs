// Pitch Mode (Milestone 22): the director talks, the set builds itself beat by beat, and every beat gets a fast
// FLUX 3 Klein sketch of the current camera view, so the pitch turns into a storyboard while they speak.
//
//   import { PitchSession, chunkTranscript, SketchJobs, lockToShots } from "./agent/pitch.mjs";
//   const p = new PitchSession({ api, stage, director, host, onUpdate });
//   p.start(); p.hear("Night. A rainy alley in Chinatown. A detective walks toward camera"); p.hear("…", { final: true });
//   await p.idle(); p.undoBeat(); await p.previewMotion(); await p.lock(); p.stop();
//
// Pipeline per beat (stages overlap: the next beat plans while the last one's sketch renders):
//   transcript chunk -> /soundstage/director/pitch (rules, instant; optional local model refines it) -> applyOps on the
//   live stage (undoable) -> stage.capture("color") 704 px -> /upload/image -> Klein edit, 4 steps -> filmstrip.
// GPU safety: Pitch only ever deletes or interrupts prompt ids it queued itself (SketchJobs.mine). A newer beat makes
// the older sketch stale: still pending -> deleted from the queue; already running -> left to finish (skipped).
// The Director's Book (web/book/, another milestone) can lend style and intent: host.getBookContext() or
// globalThis.SoundstageBook.getBookContext() -> { style, intent } is read at each beat when present.
import { applyOps, loadScene, runLocalModel } from "./agent.mjs";

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------- chunking

const ABBR = /\b(mr|mrs|ms|dr|st|vs|int|ext|no|mt|jr|sr)\.$/i;

/**
 * Cut a running transcript into beats. A beat ends at . ! ? … ; or an ellipsis, and a long clause also ends at
 * ", then" / "and then" (a director pitching runs sentences together). Returns { beats: [...], rest } where rest is
 * the unfinished tail (kept for the next call). final: the speaker paused, so the tail is a beat too.
 */
export function chunkTranscript(text, { final = false, maxWords = 18 } = {}) {
  let t = String(text || "").replace(/\s+/g, " ").replace(/\.{3}|…/g, "… ");
  const beats = [];
  const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
  const push = (s) => { s = s.trim().replace(/^[,;…\s]+|[,\s]+$/g, "").replace(/…$/, "").trim(); if (s && /[a-z0-9]/i.test(s)) beats.push(s.replace(/\s+([.!?])/g, "$1")); };
  for (;;) {
    const m = /[.!?;…]+(\s|$)/.exec(t);
    if (!m) break;
    const head = t.slice(0, m.index + m[0].trimEnd().length);
    // "Dr. Lee" / "INT." are not the end of a beat.
    if (ABBR.test(head.trim()) && m[1]) { t = head.replace(/\.$/, "․") + t.slice(m.index + m[0].length - 1); continue; }
    if (!m[1] && !final) break;            // "…sweeps across hi" is still being said: no space after the stop yet
    push(head);
    t = t.slice(m.index + m[0].length);
  }
  // Run-on speech: split at "then" once the clause is long enough to hold a beat.
  for (;;) {
    const m = /,?\s+(?:and\s+)?then\s+/i.exec(t);
    if (!m || words(t.slice(0, m.index)) < 4) break;
    push(t.slice(0, m.index));
    t = t.slice(m.index + m[0].length);
  }
  if (words(t) > maxWords) {
    const c = t.lastIndexOf(",");
    if (c > 0 && words(t.slice(0, c)) >= 4) { push(t.slice(0, c)); t = t.slice(c + 1); }
  }
  if (final) { push(t); t = ""; }
  return { beats: beats.map((b) => b.replace(/․/g, ".")), rest: t.replace(/․/g, ".").trimStart() };
}

// ------------------------------------------------------------------------------------------- GPU jobs

/**
 * The sketch / motion jobs Pitch queued. Only these ids are ever deleted or interrupted.
 *   queue(graph, meta) -> {pid}  ·  wait(pid) -> outputs  ·  cancelStale(keepPid) -> {deleted, running}
 */
export class SketchJobs {
  constructor(api, { front = true } = {}) {
    this.api = api;
    this.front = front;
    this.mine = new Map();        // pid -> {meta, t, state: queued|running|done|error|cancelled}
    this._waiters = new Map();    // pid -> {resolve, reject}
    this._early = new Map();      // pid -> outputs that arrived before wait()
    this._onExec = (ev) => {
      const d = ev.detail || {};
      const j = this.mine.get(d.prompt_id);
      if (!j || !d.output) return;
      j.outputs = { ...(j.outputs || {}), [d.node]: d.output };
      if (j.saveNode && d.node !== j.saveNode) return;
      j.state = "done";
      const w = this._waiters.get(d.prompt_id);
      if (w) { this._waiters.delete(d.prompt_id); w.resolve(j.outputs); } else this._early.set(d.prompt_id, j.outputs);
    };
    this._onErr = (ev) => {
      const d = ev.detail || {};
      const j = this.mine.get(d.prompt_id);
      if (!j) return;
      j.state = "error";
      const w = this._waiters.get(d.prompt_id);
      if (w) { this._waiters.delete(d.prompt_id); w.reject(new Error(d.exception_message || "the GPU job failed")); }
    };
    this._onStart = (ev) => { const j = this.mine.get(ev.detail?.prompt_id); if (j && j.state === "queued") { j.state = "running"; j.started = now(); } };
    api.addEventListener?.("executed", this._onExec);
    api.addEventListener?.("execution_error", this._onErr);
    api.addEventListener?.("execution_start", this._onStart);
  }

  destroy() {
    this.api.removeEventListener?.("executed", this._onExec);
    this.api.removeEventListener?.("execution_error", this._onErr);
    this.api.removeEventListener?.("execution_start", this._onStart);
  }

  async queue(graph, meta = {}, { front = this.front } = {}) {
    const saveNode = Object.keys(graph).find((k) => /^Save(Image|Video)$/.test(graph[k].class_type));
    const r = await this.api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: this.api.clientId, front }) });
    const j = await r.json();
    if (!j.prompt_id) throw new Error(j.error?.message || "the server refused the job");
    this.mine.set(j.prompt_id, { meta, t: now(), state: "queued", saveNode });
    return { pid: j.prompt_id };
  }

  /** Resolves with the job's outputs (by node id). Falls back to /history when no event arrives (lost socket). */
  wait(pid, { timeoutMs = 240000, pollMs = 1500 } = {}) {
    if (this._early.has(pid)) { const o = this._early.get(pid); this._early.delete(pid); return Promise.resolve(o); }
    return new Promise((resolve, reject) => {
      const t0 = now();
      this._waiters.set(pid, { resolve, reject });
      const poll = async () => {
        if (!this._waiters.has(pid)) return;
        const j = this.mine.get(pid);
        if (j?.state === "cancelled") { this._waiters.delete(pid); reject(Object.assign(new Error("cancelled"), { cancelled: true })); return; }
        if (now() - t0 > timeoutMs) { this._waiters.delete(pid); reject(new Error("the GPU job took too long")); return; }
        try {
          const h = await (await this.api.fetchApi(`/history/${pid}`)).json();
          const e = h?.[pid];
          if (e?.outputs && Object.keys(e.outputs).length && this._waiters.has(pid)) {
            this._waiters.delete(pid);
            if (j) { j.state = "done"; j.outputs = e.outputs; }
            resolve(e.outputs);
            return;
          }
          if (e?.status?.status_str === "error" && this._waiters.has(pid)) { this._waiters.delete(pid); reject(new Error("the GPU job failed")); return; }
          // Gone from the queue with no history: someone cleared the queue. Say so now instead of waiting it out.
          if (!e && j && j.state !== "running") {
            const q = await (await this.api.fetchApi("/queue")).json();
            const ids = [...(q.queue_pending || []), ...(q.queue_running || [])].map((it) => (Array.isArray(it) ? it[1] : it?.prompt_id));
            j.missing = ids.includes(pid) ? 0 : (j.missing || 0) + 1;
            if (j.missing >= 2 && this._waiters.has(pid)) {
              this._waiters.delete(pid); j.state = "cancelled";
              reject(Object.assign(new Error("removed from the queue (not by Pitch)"), { cancelled: true }));
              return;
            }
          }
        } catch { /* server away: keep waiting */ }
        setTimeout(poll, pollMs);
      };
      setTimeout(poll, pollMs);
    });
  }

  /**
   * Drop Pitch's own stale jobs: pending ones are deleted from the queue, a running one is left to finish (its result
   * is skipped). Other people's queue items are never touched. -> {deleted:[pid], running:[pid]}
   */
  async cancelStale(keep = null, { kind = null, match = null } = {}) {
    const stale = [...this.mine].filter(([pid, j]) => pid !== keep && (j.state === "queued" || j.state === "running") &&
      (!kind || j.meta?.kind === kind) && (!match || match(j.meta || {}, j))).map(([pid]) => pid);
    if (!stale.length) return { deleted: [], running: [] };
    let q = { queue_running: [], queue_pending: [] };
    try { q = await (await this.api.fetchApi("/queue")).json(); } catch { /* treat as nothing pending */ }
    const pidOf = (item) => (Array.isArray(item) ? item[1] : item?.prompt_id);
    const pending = new Set((q.queue_pending || []).map(pidOf));
    const running = new Set((q.queue_running || []).map(pidOf));
    const del = stale.filter((pid) => pending.has(pid) && this.mine.has(pid));
    if (del.length) {
      await this.api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: del }) });
      for (const pid of del) this._cancel(pid);
    }
    const run = stale.filter((pid) => running.has(pid));
    for (const pid of run) { const j = this.mine.get(pid); if (j) j.stale = true; }
    // Neither pending nor running any more: finished between the events; nothing to do.
    return { deleted: del, running: run };
  }

  _cancel(pid) {
    const j = this.mine.get(pid);
    if (j) j.state = "cancelled";
    const w = this._waiters.get(pid);
    if (w) { this._waiters.delete(pid); w.reject(Object.assign(new Error("cancelled"), { cancelled: true })); }
  }

  /** Is the GPU running a job that isn't one of ours (another user's render)? Our sketches wait behind it. */
  async busyWithOthers() {
    try {
      const q = await (await this.api.fetchApi("/queue")).json();
      return (q.queue_running || []).some((it) => !this.mine.has(Array.isArray(it) ? it[1] : it?.prompt_id));
    } catch { return false; }
  }

  /** Stop: delete every pending job of ours (a running one finishes; never /interrupt someone else's). */
  async cancelAll() { return this.cancelStale(null); }
}

// ------------------------------------------------------------------------------------------- lock it

/**
 * The pitch as real shots: one shot per beat (that beat's camera and rig), the transcript as notes, the sketch as the
 * chosen first frame. Pure: returns { scene, shots: [{id, beat}] }. Shots that are already there stay.
 */
export function lockToShots(scene, beats) {
  const s = clone(scene);
  s.shots = s.shots || [];
  const used = new Set(s.shots.map((x) => x.id));
  const out = [];
  let n = 0;
  for (const b of beats || []) {
    const bs = b.after || b.scene;
    if (!bs) continue;
    const src = (bs.shots || []).find((x) => x.id === bs.active_shot) || bs.shots?.[0];
    if (!src?.camera_keys?.length) continue;
    n += 1;
    let id = `pitch_${n}`;
    while (used.has(id)) id += "b";
    used.add(id);
    const words = String(b.text || "").replace(/[.!?…]+$/, "");
    const shot = { id, name: `Beat ${n}: ${words.length > 34 ? `${words.slice(0, 32)}…` : words}`, setup: src.setup || "wide",
      camera_keys: clone(src.camera_keys), notes: b.text || "", pitch: { beat: n, transcript: b.text || "", caption: b.caption || "" } };
    if (src.rig) shot.rig = clone(src.rig);
    s.shots.push(shot);
    out.push({ id, beat: b });
  }
  if (out.length) {
    s.active_shot = out[0].id;
    s.camera_keys = s.shots.find((x) => x.id === s.active_shot).camera_keys;
  }
  return { scene: s, shots: out };
}

// ------------------------------------------------------------------------------------------- the session

export const PITCH_WORDS = "A film pitch, spoken out loud: night, day, dawn, rain, a rainy street, an alley, fog, snow, a detective, a woman, a car, headlights. The camera: low angle, high angle, handheld, steadicam, dolly, drone, close-up, wide shot, follows.";

/** Fit the capture into maxW px wide, as JPEG (sketches are 0.3 MP; a PNG of the frame is ~6x the bytes, and the
 *  upload to a remote ComfyUI was the slowest stage of a beat: 1-10 s through a tunnel, measured). */
export async function shrink(blob, maxW = 704, type = "image/jpeg") {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxW / bmp.width);
    const W = Math.round(bmp.width * k / 16) * 16, H = Math.round(bmp.height * k / 16) * 16;
    const oc = new OffscreenCanvas(W, H);
    oc.getContext("2d").drawImage(bmp, 0, 0, W, H);
    return await oc.convertToBlob(type === "image/jpeg" ? { type, quality: 0.9 } : { type });
  } catch { return blob; }
}

export class PitchSession {
  /**
   * api: ComfyUI api · stage · director (web/agent/director.mjs: its undo stack holds the whole pitch as one step)
   * host: the Director's host (pipeline for Lock it, say(), getBookContext()) · onUpdate(session, why)
   * opts: { sketch: true, warm: true (load Klein at start), steps: 4, megapixels: 0.3, model: "rules"|"auto", llmTimeoutMs: 6000 }
   */
  constructor({ api, stage, director, host = {}, onUpdate = () => {}, opts = {} } = {}) {
    Object.assign(this, { api, stage, director, host, onUpdate });
    // model: "rules" (default: instant, the GPU stays free for the sketches) or "auto" (the local Qwen also reads each
    // beat; measured 2-6 s a beat on a shared queue, so it is opt-in under the Director's ⚙).
    this.opts = { sketch: true, steps: 4, megapixels: 0.3, model: "rules", llmTimeoutMs: 6000, ...opts };
    this.jobs = new SketchJobs(api);
    this.reset();
  }

  reset() {
    this.active = false;
    this.beats = [];
    this.memory = null;
    this.ids = {};
    this.rest = "";
    this.interim = "";
    this.queue = [];             // beat texts waiting to be planned
    this._busy = null;           // the promise of the beat being planned
    this._undoEntry = null;
    this.sid = Math.random().toString(36).slice(2, 8);
    this.hud = {};
  }

  start() {
    if (this.active) return;
    if (!this.beats.length) { this.reset(); this.startScene = this.stage.toJSON(); this.startExtra = this.host.snapshot?.(); }
    this.active = true;
    this._warm();
    if (this.opts.sketch && this.opts.warm !== false) this._warmSketch();
    this.onUpdate(this, "start");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.rest.trim()) this.hear("", { final: true, force: true });
    this.onUpdate(this, "stop");
  }

  /** Keep the local model loaded: one tiny request at the start of a pitch (a cold Qwen load would cost a beat). */
  async _warm() {
    if (!(await this._useModel())) return;
    try { await runLocalModel(this.api, { system: "Answer {}", prompt: "{}", max_length: 4, model: (await this.director.info()).model }, { timeoutMs: 60000 }); }
    catch { /* the rules carry the pitch */ }
  }

  /** Load FLUX 3 Klein while the director starts talking: one tiny 1-step job (0.1 MP), so beat 1 isn't a cold load. */
  async _warmSketch() {
    try {
      const blob = await shrink(await this.stage.capture("color"), 320);
      const fd = new FormData();
      fd.append("image", blob, `pitch_${this.sid}_warm.${blob.type === "image/jpeg" ? "jpg" : "png"}`);
      fd.append("subfolder", "soundstage_pitch");
      fd.append("overwrite", "true");
      const up = await (await this.api.fetchApi("/upload/image", { method: "POST", body: fd })).json();
      const g = await this._post("/soundstage/director/pitch_graph", { kind: "sketch", image: `${up.subfolder ? `${up.subfolder}/` : ""}${up.name}`,
        prompt: "a film still", seed: 1, steps: 1, megapixels: 0.1 });
      await this.jobs.queue(g.graph, { kind: "warm" });
    } catch { /* the first sketch just loads the model itself */ }
  }

  async _useModel() {
    if (this.opts.model === "rules") return false;
    try { return !!(await this.director.info()).available; } catch { return false; }
  }

  /** Words Whisper should expect: film terms, then the last two beats (it keeps names and places consistent). */
  whisperHint() {
    return `${PITCH_WORDS} ${this.beats.slice(-2).map((b) => b.text).join(" ")}`.trim();
  }

  bookContext() {
    try { return this.host.getBookContext?.() || globalThis.SoundstageBook?.getBookContext?.() || null; } catch { return null; }
  }

  /** Feed speech: text is the newest words (interim or final). Complete beats are queued for planning. */
  hear(text, { final = false, interim = false, heardMs = 0, force = false } = {}) {
    if (!this.active && !force) return [];
    if (interim) { this.interim = String(text || ""); this.onUpdate(this, "interim"); return []; }
    this.interim = "";
    const { beats, rest } = chunkTranscript(`${this.rest} ${text || ""}`, { final });
    this.rest = rest;
    for (const b of beats) this.queue.push({ text: b, heardAt: now(), heardMs });
    if (beats.length) this._pump();
    this.onUpdate(this, "heard");
    return beats;
  }

  /** Resolves once every heard beat is planned, applied and its sketch is back (or skipped). */
  async idle() {
    for (;;) {
      if (this._busy) { await this._busy; continue; }
      if (this.queue.length) { this._pump(); await sleep(10); continue; }
      const pend = this.beats.filter((b) => b.sketch?.promise && b.sketch.status === "rendering").map((b) => b.sketch.promise.catch(() => {}));
      if (pend.length) { await Promise.all(pend); continue; }
      return;
    }
  }

  _pump() {
    if (this._busy || !this.queue.length) return;
    const item = this.queue.shift();
    this._busy = this._beat(item).catch((e) => { this.onUpdate(this, "error", e); }).finally(() => { this._busy = null; this._pump(); });
  }

  async _post(path, body) {
    const r = await this.api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
    return j;
  }

  async _plan(text, scene, llm_text = null) {
    const book = this.bookContext();
    return this._post("/soundstage/director/pitch", { text, scene, memory: this.memory, ids: this.ids, llm_text,
      style: [book?.style, book?.intent].filter(Boolean).join(". ") });
  }

  _apply(res) {
    if (res.ops?.length) applyOps(this.stage, res.ops);
    if (res.rig) { try { this.stage.setRig?.(res.rig); } catch { /* old stage */ } }
    try { this.host.onLoad?.(this.stage.toJSON()); } catch { /* panels not built */ }
  }

  _restore(scene) {
    loadScene(this.stage, scene);
    try { this.host.onLoad?.(this.stage.toJSON()); } catch { /* */ }
  }

  _undoStep() {
    // The whole pitch is one Director undo step (the scene before the first beat -> now).
    const d = this.director;
    if (!d) return;
    const after = { scene: this.stage.toJSON(), extra: this.host.snapshot?.() };
    if (!this._undoEntry || d.undoStack[d.undoStack.length - 1] !== this._undoEntry) {
      this._undoEntry = { label: "the pitch", before: { scene: this.startScene, extra: this.startExtra }, after };
      d.undoStack.push(this._undoEntry);
      d.redoStack = [];
    } else this._undoEntry.after = after;
  }

  async _beat({ text, heardAt, heardMs }) {
    const t0 = now();
    const before = this.stage.toJSON();
    const n = this.beats.length + 1;
    const beat = { n, text, before, heardMs, heardAt, timing: { heard_ms: Math.round(heardMs || 0), wait_ms: Math.round(t0 - heardAt) }, sketch: { status: "none" } };
    // Rules first: the stage moves right away.
    const tp = now();
    const res = await this._plan(text, before);
    beat.timing.plan_ms = Math.round(now() - tp);
    const ta = now();
    this._apply(res);
    beat.timing.apply_ms = Math.round(now() - ta);
    Object.assign(beat, { res, caption: res.caption, said: res.said, delta: res.delta, after: this.stage.toJSON() });
    this.memory = res.memory;
    this.ids = res.ids;
    beat.stagedAt = Date.now();
    this.beats.push(beat);
    this._undoStep();
    this.onUpdate(this, "beat", beat);
    // The local model refines it while the sketch is queued: if it adds something the words implied, re-stage + re-sketch.
    const useModel = await this._useModel();
    const sk = this.opts.sketch ? this._sketch(beat) : null;
    if (useModel) {
      const tl = now();
      try {
        const p = await this._post("/soundstage/director/pitch_prompt", { text, memory: this._memBefore(beat) });
        const llm_text = await runLocalModel(this.api, { system: p.system, prompt: p.prompt, max_length: p.max_length, model: p.model }, { timeoutMs: this.opts.llmTimeoutMs });
        beat.timing.llm_ms = Math.round(now() - tl);
        beat.llm_text = llm_text;
        const memNow = this.memory, idsNow = this.ids;
        this.memory = this._memBefore(beat); this.ids = beat.idsBefore;
        const res2 = await this._plan(text, before, llm_text);
        if (JSON.stringify(res2.delta) !== JSON.stringify(res.delta) && this.beats[this.beats.length - 1] === beat) {
          this._restore(before);
          this._apply(res2);
          Object.assign(beat, { res: res2, caption: res2.caption, said: res2.said, delta: res2.delta, after: this.stage.toJSON(), refined: true });
          this.memory = res2.memory; this.ids = res2.ids;
          this._undoStep();
          this.onUpdate(this, "beat", beat);
          if (this.opts.sketch) this._sketch(beat);       // the first sketch is stale now: cancelled if still queued
        } else { this.memory = memNow; this.ids = idsNow; }
      } catch (e) { beat.timing.llm_ms = Math.round(now() - tl); beat.llm_error = String(e.message || e); }
    }
    beat.timing.stage_ms = Math.round(now() - t0);
    await Promise.race([sk?.catch(() => {}), sleep(0)]);
    return beat;
  }

  _memBefore(beat) {
    const i = this.beats.indexOf(beat);
    if (!("memBefore" in beat)) { beat.memBefore = i > 0 ? this.beats[i - 1].res?.memory || null : null; beat.idsBefore = i > 0 ? clone(this.beats[i - 1].res?.ids || {}) : {}; }
    return beat.memBefore;
  }

  /** Sketch a beat again (a skipped one, or a new seed): its own staged scene is captured, then the stage comes back. */
  resketch(beat) {
    if (!beat?.after) return null;
    beat.heardAt = now(); beat.timing.heard_ms = 0;
    return this._sketch(beat, beat.after);
  }

  /** Capture the camera view, queue a Klein sketch, drop older sketches still waiting. */
  _sketch(beat, scene = null) {
    this._memBefore(beat);
    const job = { status: "rendering", t: now(), seq: (beat.sketch?.seq || 0) + 1 };
    beat.sketch = job;
    job.promise = (async () => {
      const tc = now();
      let shot;
      if (scene) {
        const cur = this.stage.toJSON();
        loadScene(this.stage, scene);
        try { shot = await this.stage.capture("color"); } finally { loadScene(this.stage, cur); }
      } else shot = await this.stage.capture("color");
      const blob = await shrink(shot, 704);
      job.grab_ms = Math.round(now() - tc);
      const name = `pitch_${this.sid}_${String(beat.n).padStart(2, "0")}_${job.seq}.${blob.type === "image/jpeg" ? "jpg" : "png"}`;
      const fd = new FormData();
      fd.append("image", blob, name);
      fd.append("subfolder", "soundstage_pitch");
      fd.append("overwrite", "true");
      const up = await (await this.api.fetchApi("/upload/image", { method: "POST", body: fd })).json();
      job.capture_ms = Math.round(now() - tc);
      job.upload_ms = job.capture_ms - job.grab_ms;
      const g = await this._post("/soundstage/director/pitch_graph", { kind: "sketch", image: `${up.subfolder ? `${up.subfolder}/` : ""}${up.name}`,
        prompt: beat.res.prompt, seed: 1000 + beat.n * 7919, steps: this.opts.steps, megapixels: this.opts.megapixels });
      const tq = now();
      const { pid } = await this.jobs.queue(g.graph, { kind: "sketch", beat: beat.n });
      job.pid = pid;
      // Only Pitch's own jobs, and only while still queued: this beat's older sketch (re-staged by the model or undone),
      // and a backlog when the director talks faster than the GPU paints (the newest two beats always render).
      const newer = (m) => m.beat === beat.n;
      await this.jobs.cancelStale(pid, { kind: "sketch", match: newer });
      const waiting = [...this.jobs.mine].filter(([, j]) => j.meta?.kind === "sketch" && j.state === "queued" && j.meta.beat < beat.n);
      if (waiting.length > 1) {
        const drop = new Set(waiting.slice(0, waiting.length - 1).map(([p]) => p));
        await this.jobs.cancelStale(pid, { kind: "sketch", match: (m, j) => [...drop].some((p) => this.jobs.mine.get(p) === j) });
      }
      this.jobs.busyWithOthers().then((b) => { job.blocked = b; if (b) this.onUpdate(this, "blocked", beat); });
      const out = await this.jobs.wait(pid);
      if (beat.sketch !== job) { job.status = "stale"; return null; }
      const img = Object.values(out).flatMap((o) => o.images || [])[0];
      if (!img) throw new Error("no image came back");
      job.file = img;
      job.url = this.api.apiURL ? this.api.apiURL(`/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type}`)
        : `/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type}`;
      job.gpu_ms = Math.round(now() - tq);
      job.status = "done";
      job.doneAt = Date.now();
      beat.timing.capture_ms = job.capture_ms;
      beat.timing.sketch_ms = job.gpu_ms;
      beat.timing.total_ms = Math.round(now() - beat.heardAt) + (beat.timing.heard_ms || 0);
      this.hud = { ...beat.timing, n: beat.n };
      this.onUpdate(this, "sketch", beat);
      return job;
    })().catch((e) => {
      if (beat.sketch === job) { job.status = e.cancelled ? "skipped" : "error"; job.error = String(e.message || e); this.onUpdate(this, "sketch", beat); }
      else job.status = "stale";
      throw e;
    });
    job.promise.catch(() => {});
    return job.promise;
  }

  /** Per-step undo: the last beat goes, the stage is back where it was before it. */
  undoBeat() {
    const b = this.beats.pop();
    if (!b) return null;
    this._restore(b.before);
    const prev = this.beats[this.beats.length - 1];
    this.memory = prev?.res?.memory || null;
    this.ids = clone(prev?.res?.ids || {});
    if (b.sketch?.pid) this.jobs.cancelStale(prev?.sketch?.pid || null, { kind: "sketch" }).catch(() => {});
    if (this.beats.length) this._undoStep();
    else if (this._undoEntry) { const d = this.director, i = d?.undoStack.indexOf(this._undoEntry); if (i >= 0) d.undoStack.splice(i, 1); this._undoEntry = null; }
    this.onUpdate(this, "undo", b);
    return b;
  }

  /** A very fast, low-grade LTX draft of a beat (the last by default), from its sketch. */
  async previewMotion(beat = this.beats[this.beats.length - 1], { frames = 49, width = 512, height = 288 } = {}) {
    if (!beat?.sketch?.file) throw new Error("that beat has no sketch yet");
    const f = beat.sketch.file;
    const image = `${f.subfolder ? `${f.subfolder}/` : ""}${f.filename} [${f.type || "output"}]`;
    const g = await this._post("/soundstage/director/pitch_graph", { kind: "motion", image, prompt: beat.res.motion_prompt,
      seed: 77 + beat.n, frames, width, height });
    const t = now();
    beat.motion = { status: "rendering" };
    this.onUpdate(this, "motion", beat);
    const { pid } = await this.jobs.queue(g.graph, { kind: "motion", beat: beat.n }, { front: false });
    beat.motion.pid = pid;
    try {
      const out = await this.jobs.wait(pid, { timeoutMs: 600000 });
      const v = Object.values(out).flatMap((o) => o.images || o.videos || o.gifs || [])[0];
      beat.motion = { status: "done", file: v, ms: Math.round(now() - t),
        url: v && `/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder || "")}&type=${v.type || "output"}` };
    } catch (e) { beat.motion = { status: "error", error: String(e.message || e) }; }
    this.onUpdate(this, "motion", beat);
    return beat.motion;
  }

  /** Lock it: one shot per beat, sketches as chosen first frames (through the pipeline's own "use as first frame"). */
  async lock({ waitMs = 15000 } = {}) {
    this.stop();
    await Promise.race([this.idle(), sleep(waitMs)]);      // a sketch still on the GPU after that: its shot gets no frame
    const beats = this.beats.filter((b) => b.after);
    if (!beats.length) return { shots: [] };
    const before = { scene: this.stage.toJSON(), extra: this.host.snapshot?.() };
    const { scene, shots } = lockToShots(this.stage.toJSON(), beats);
    loadScene(this.stage, scene);
    const p = this.host.pipeline;
    let frames = 0;
    for (const { id, beat } of shots) {
      if (!beat.sketch?.file || !p?.useEditedFrame) continue;
      try {
        // The pipeline animates input/ pictures: copy the sketch there under the shot's name.
        const f = beat.sketch.file;
        const blob = await (await this.api.fetchApi(`/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${f.type || "output"}`)).blob();
        const fd = new FormData();
        fd.append("image", blob, `pitch_${this.sid}_${id}.png`);
        fd.append("subfolder", "soundstage_pitch");
        fd.append("overwrite", "true");
        const up = await (await this.api.fetchApi("/upload/image", { method: "POST", body: fd })).json();
        this.stage.setActiveShot?.(id);
        const name = `${up.subfolder}/${up.name}`;
        p.useEditedFrame({ name, url: `/view?filename=${encodeURIComponent(up.name)}&subfolder=${encodeURIComponent(up.subfolder)}&type=input` });
        frames += 1;
      } catch { /* that shot keeps no first frame; Frame can paint one */ }
    }
    if (shots[0]) this.stage.setActiveShot?.(shots[0].id);
    try { this.host.onLoad?.(this.stage.toJSON()); } catch { /* */ }
    const d = this.director;
    if (d) { d.undoStack.push({ label: "lock the pitch into shots", before, after: { scene: this.stage.toJSON(), extra: this.host.snapshot?.() } }); d.redoStack = []; }
    this.locked = { shots: shots.map((s) => s.id), frames };
    this.onUpdate(this, "locked", this.locked);
    return this.locked;
  }

  /** Latency per beat (for the HUD and the evidence table). */
  latency() {
    return this.beats.map((b) => ({ n: b.n, text: b.text, ...b.timing, sketch: b.sketch?.status, refined: !!b.refined }));
  }

  destroy() { this.jobs.cancelAll().catch(() => {}); this.jobs.destroy(); }
}
