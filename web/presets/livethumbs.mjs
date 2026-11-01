// Presets (Milestone 17): card previews rendered from the real stage. A hidden scratch Stage (its own small WebGL
// canvas, never the user's) loads a copy of the current scene, applies a preset to it with its own PresetRunner and
// renders clay frames: a camera move or a stunt becomes a short loop, a lighting setup or a look a still. The user's
// stage, its history and its undo are never touched. Results are cached per scene signature, so reopening the panel,
// or undoing back to a scene seen before, shows them at once; work runs in small slices between frames.
//
//   const lt = new LiveThumbs({ stage, makeRunner: (s) => new PresetRunner({ stage: s, ... }), setups });
//   lt.want(["push_in", "golden_hour"]); lt.start();   // fills in progressively; lt.onReady(id) per finished card
//   lt.frameAt(id, t)  -> { img, sx, sy, sw, sh } | null    (draw it on the card)
//   await lt.hoverStart(preset, { w, h }); lt.hoverFrame(ctx, t, w, h)   (the preview on the shot, non-camera cards)
import { lightingPlan } from "./engine.mjs";

export const THUMB_W = 240, THUMB_H = 135;
export const LOOP_FRAMES = 10;
export const LOOP_FPS = 8;
const CACHE_MAX = 260;
const HOVER_FRAMES = 16, HOVER_FPS = 12;
/** Scene fields a camera move or a light writes: copied back instead of reloading the scratch scene. */
const SOFT_KEYS = ["shots", "active_shot", "camera_keys", "camera", "preset_log", "lighting", "sun"];

/** What a card's live preview is: "camera" | "action" (loops), "light" | "look" (stills), or null (drawn, not rendered). */
export function liveKind(p) {
  if (!p) return null;
  const a = p.apply || {};
  if (p.tab === "user") return a.user_camera ? "camera" : a.user_light ? "light" : a.user_look ? "look" : null;
  if (p.tab === "camera" && a.camera) return "camera";
  if (p.tab === "light" && a.light) return "light";
  if (p.tab === "look" && a.look) return "look";
  if (p.tab === "action" && (a.stunt || a.physics || a.mount)) return "action";
  return null;
}
export const isLoop = (kind) => kind === "camera" || kind === "action";

/** n frame numbers spread evenly over 0..last (first and last included). */
export function sampleFrames(last, n = LOOP_FRAMES) {
  last = Math.max(0, Math.round(last || 0));
  if (n <= 1 || last === 0) return [0];
  return Array.from({ length: n }, (_, i) => Math.round((i * last) / (n - 1)));
}

/** A short, stable signature of what the previews depend on: the scene, minus the preset log. */
export function sceneSig(scene) {
  if (!scene) return "none";
  const { preset_log, ...rest } = scene;   // eslint-disable-line no-unused-vars
  const s = JSON.stringify(rest);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + "." + s.length.toString(36);
}

/** A look's grade as a canvas / CSS filter (cheap enough for a still; drawn once into the cache). */
export function gradeFilter(g = {}) {
  const c = +g.contrast || 0, s = +g.saturation || 0, w = +g.warmth || 0;
  const parts = [`contrast(${(1 + c * 0.6).toFixed(3)})`, `saturate(${Math.max(0, 1 + s).toFixed(3)})`];
  if (w > 0) parts.push(`sepia(${Math.min(0.6, w * 0.6).toFixed(3)})`);
  if (w < 0) parts.push(`hue-rotate(${Math.round(w * 25)}deg)`);
  if (c > 0) parts.push(`brightness(${(1 - c * 0.08).toFixed(3)})`);
  return parts.join(" ");
}

/** Overlays a grade's warmth, vignette and grain on a 2D context (after the filter pass). */
export function gradeOverlay(c, g = {}, w, h) {
  const warm = +g.warmth || 0;
  if (warm) { c.fillStyle = warm > 0 ? `rgba(255,150,60,${Math.min(0.22, warm * 0.22)})` : `rgba(60,120,255,${Math.min(0.22, -warm * 0.22)})`; c.fillRect(0, 0, w, h); }
  if ((+g.vignette || 0) > 0 && c.createRadialGradient) {
    const v = c.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.62);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(0,0,0,${Math.min(0.75, +g.vignette)})`);
    c.fillStyle = v; c.fillRect(0, 0, w, h);
  }
  const grain = +g.grain || 0;
  if (grain > 0) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    c.fillStyle = `rgba(255,255,255,${0.04 + grain * 0.1})`;
    for (let i = 0; i < Math.round((w * h) / 400 * grain); i++) c.fillRect(rnd() * w, rnd() * h, 1, 1);
  }
}

/** The grade a card's preview carries (light presets carry one too; the scratch stage has no Look panel to take it). */
export function gradeOf(p, setups = []) {
  const a = p?.apply || {};
  if (a.light) return lightingPlan(a.light, setups).grade || {};
  if (a.user_look) return a.user_look.grade || {};
  return a.grade || {};
}

const idle = () => new Promise((r) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => r(), { timeout: 60 }) : setTimeout(r, 0)));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class LiveThumbs {
  /**
   * stage: the user's Stage (only read: toJSON, frame, view, canvas size). makeRunner(scratchStage) -> PresetRunner.
   * makeStage(container) -> a scratch Stage (default: new stage.constructor(container)). doc: the document.
   */
  constructor({ stage, makeRunner, makeStage = null, setups = [], doc = typeof document !== "undefined" ? document : null, budgetMs = 9 } = {}) {
    Object.assign(this, { stage, makeRunner, setups, doc, budgetMs });
    this.makeStage = makeStage || ((el) => new stage.constructor(el, () => {}));
    this.cache = new Map();      // `${sig}|${id}` -> entry {id, kind, frames, sprite, w, h, ok}
    this.latest = new Map();     // id -> the newest finished entry for any scene (shown while the current one renders)
    this.queue = [];             // presets to render, in priority order
    this.sig = null;
    this.scratch = null; this.runner = null; this.base = null; this.baseStr = null; this.dirty = true;
    this.running = false; this.paused = 0; this.stopped = false;
    this.onReady = null;         // (id) => void
    this.stats = { rendered: 0, frames: 0, loads: 0, ms: 0, failed: 0 };
    this._hover = null;
    this._mx = Promise.resolve();
  }

  // ------------------------------------------------------------------------------------------- the scratch stage
  _ensureScratch() {
    if (this.scratch) return this.scratch;
    const d = this.doc;
    const box = d.createElement("div");
    box.className = "ss-pre-scratch";
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed;left:-10000px;top:0;width:256px;height:144px;overflow:hidden;pointer-events:none;visibility:hidden;contain:strict";
    d.body.append(box);
    this.box = box;
    this.scratch = this.makeStage(box);
    try { this.scratch._ro?.disconnect(); } catch { /* */ }   // its size is ours to set
    // Thumbnails don't need the viewport's 2048 px sun shadow: a smaller map renders each frame about 40 % faster.
    try { const sh = this.scratch.sun?.shadow; if (sh) { sh.mapSize.set(768, 768); sh.map?.dispose?.(); sh.map = null; } } catch { /* */ }
    this.runner = this.makeRunner(this.scratch);
    return this.scratch;
  }

  /** Re-read the user's scene; a new signature starts a new set of previews. Returns true when it changed. */
  sync(scene = null) {
    const sc = scene || this.stage.toJSON();
    const sig = sceneSig(sc);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.base = sc;
    this.dirty = "load";
    return true;
  }

  _loadBase() {
    const S = this._ensureScratch();
    const t = now();
    S._muteRecord = true;
    try {
      S.load(JSON.parse(JSON.stringify(this.base)));
      S.view = "clay";
      if (S.freeView) S.freeView = false;
    } finally { S._muteRecord = false; }
    this.baseStr = JSON.stringify(S.state);
    this.dirty = false;
    this.stats.loads++;
    this.stats.ms += now() - t;
  }

  /** The scratch stage holding the base scene with preset p applied (p null: the base scene). */
  _prepare(p) {
    // One at a time: a hover preview and a card render never apply presets to the scratch stage at once.
    const run = this._mx.then(() => this._prepareNow(p));
    this._mx = run.catch(() => {});
    return run;
  }

  /**
   * Put the scratch copy back to the base scene. A camera move or a light only changed the shot / lighting fields, so
   * those are copied back (milliseconds); anything else (a stunt's keys, crates, a new set) reloads the scene.
   */
  _reset() {
    if (!this.scratch || !this.baseStr) return this._loadBase();
    const S = this.scratch, st = S.state || {};
    const base = JSON.parse(this.baseStr);
    const diff = [...new Set([...Object.keys(st), ...Object.keys(base)])].filter((k) => JSON.stringify(st[k]) !== JSON.stringify(base[k]));
    if (!diff.length) { this.dirty = false; return; }
    if (diff.some((k) => !SOFT_KEYS.includes(k))) return this._loadBase();
    for (const k of diff) { if (k in base) st[k] = base[k]; else delete st[k]; }
    S._rigCache = null;
    if (diff.includes("lighting") || diff.includes("sun")) { try { S._buildLights?.(); S._applySun?.(); } catch { return this._loadBase(); } }
    if (JSON.stringify(S.state) !== this.baseStr) return this._loadBase();
    this.dirty = false;
    this.stats.soft = (this.stats.soft || 0) + 1;
  }

  async _prepareNow(p) {
    if (!this.baseStr || this.dirty === "load") this._loadBase();
    else if (this.dirty || JSON.stringify(this.scratch.state) !== this.baseStr) this._reset();
    if (!p) return { ok: true };
    const S = this.scratch;
    S._muteRecord = true;
    let r;
    try { r = await this.runner.apply(p.id, { confirmGpu: false, source: "thumb" }); } catch (e) { r = { ok: false, said: String(e?.message || e) }; }
    finally { S._muteRecord = false; }
    this.dirty = true;   // the next preset starts from the base again
    return r || { ok: false };
  }

  /** Render the scratch stage at frame f into (ctx, dx, dy, w, h), cover-fit, in clay. */
  _renderInto(ctx, f, dx, dy, w, h, { mode = "clay", forCapture = true } = {}) {
    const S = this.scratch;
    const ar = (S.fw || 16) / (S.fh || 9);
    let rw = w, rh = Math.round(w / ar);
    if (rh < h) { rh = h; rw = Math.round(h * ar); }
    if (S.canvas.width !== rw || S.canvas.height !== rh) S.renderer.setSize(rw, rh, false);
    S.setFrameSilent(f);
    S._renderMode(mode, forCapture);
    ctx.drawImage(S.canvas, Math.max(0, (rw - w) / 2), Math.max(0, (rh - h) / 2), Math.min(w, rw), Math.min(h, rh), dx, dy, w, h);
    this.stats.frames++;
  }

  _newCanvas(w, h) {
    const c = this.doc.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  // ------------------------------------------------------------------------------------------- the queue
  get(id) { return this.cache.get(`${this.sig}|${id}`) || null; }
  /** The entry to show for a card now: this scene's if ready, else the newest one from an earlier scene. */
  shown(id) { return this.get(id) || this.latest.get(id) || null; }
  isCurrent(id) { return !!this.get(id); }

  /** Render these presets (preset objects), first ones first; drops what is already cached for this scene. */
  want(presets) {
    const seen = new Set();
    this.queue = presets.filter((p) => p && liveKind(p) && !this.get(p.id) && !seen.has(p.id) && seen.add(p.id));
    return this.queue.length;
  }

  start() {
    if (this.running || this.stopped) return;
    this.running = true;
    this._loop().catch((e) => { console.warn("[Soundstage] preset previews", e); }).finally(() => { this.running = false; });
  }

  async _loop() {
    await idle();
    while (this.queue.length && !this.stopped) {
      if (this.paused || this._hover?.busy) { await new Promise((r) => setTimeout(r, 60)); continue; }
      const p = this.queue.shift();
      if (this.get(p.id)) continue;
      const sig = this.sig;
      const e = await this._renderPreset(p);
      if (this.stopped) return;
      if (sig !== this.sig || !e) continue;   // the scene changed meanwhile: render it again for the new one
      this._store(sig, e);
      try { this.onReady?.(p.id, e); } catch { /* listener */ }
    }
  }

  _store(sig, e) {
    const key = `${sig}|${e.id}`;
    this.cache.delete(key);
    this.cache.set(key, e);
    if (e.ok) this.latest.set(e.id, e);
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
  }

  /** One preset's frames, yielding between frames so the page stays responsive. Null when the scene changed. */
  async _renderPreset(p) {
    const kind = liveKind(p);
    const sig = this.sig;
    const t0 = now();
    const n = isLoop(kind) ? LOOP_FRAMES : 1;
    const sprite = this._newCanvas(THUMB_W * n, THUMB_H);
    const ctx = sprite.getContext("2d");
    const entry = { id: p.id, kind, n, sprite, w: THUMB_W, h: THUMB_H, ok: false };
    if (kind === "look") {
      // A look changes the frames, not the set: the stage as it is, through the look's grade.
      const base = await this._baseStill();
      if (!base || sig !== this.sig) return null;
      const g = gradeOf(p, this.setups);
      try { ctx.filter = gradeFilter(g); } catch { /* no canvas filter */ }
      ctx.drawImage(base, 0, 0);
      try { ctx.filter = "none"; } catch { /* */ }
      gradeOverlay(ctx, g, THUMB_W, THUMB_H);
      entry.ok = true;
      this.stats.rendered++;
      return entry;
    }
    const r = await this._prepare(p);
    this._borrowed = false;
    if (!r.ok) { this.stats.failed++; entry.said = r.said || ""; return entry; }   // e.g. no car on set: the drawn preview stays
    const frames = isLoop(kind) ? sampleFrames(this.scratch._lastFrame?.() ?? 96, n)
      : [Math.min(this.stage.frame || 0, this.scratch._lastFrame?.() ?? 0)];
    let slice = now();
    for (let i = 0; i < frames.length; i++) {
      if (sig !== this.sig || this.stopped) return null;
      // A hover preview on the shot borrows the scratch stage while it renders: wait, then put this preset back on it.
      while (this._hover?.busy && !this.stopped && sig === this.sig) await new Promise((res) => setTimeout(res, 50));
      if (sig !== this.sig || this.stopped) return null;
      if (this._borrowed) { this._borrowed = false; const again = await this._prepare(p); if (!again.ok) return entry; }
      this._renderInto(ctx, frames[i], i * THUMB_W, 0, THUMB_W, THUMB_H);
      if (now() - slice > this.budgetMs) { await idle(); slice = now(); }
    }
    if (kind === "light") gradeOverlay(ctx, gradeOf(p, this.setups), THUMB_W, THUMB_H);
    entry.ok = true;
    this.stats.rendered++;
    this.stats.ms += now() - t0;
    return entry;
  }

  async _baseStill() {
    const k = `${this.sig}|__base`;
    if (this.cache.has(k)) return this.cache.get(k).sprite;
    await this._prepare(null);
    const c = this._newCanvas(THUMB_W, THUMB_H);
    this._renderInto(c.getContext("2d"), Math.min(this.stage.frame || 0, this.scratch._lastFrame?.() ?? 0), 0, 0, THUMB_W, THUMB_H);
    this.cache.set(k, { id: "__base", sprite: c, ok: false });
    return c;
  }

  /** The image to draw for a card at time t (seconds): { img, sx, sy, sw, sh } or null (no live preview yet). */
  frameAt(id, t = 0, { still = false } = {}) {
    const e = this.shown(id);
    if (!e?.ok) return null;
    // still: one representative frame (the middle of the move), for reduced motion.
    const i = e.n <= 1 ? 0 : still ? Math.floor(e.n / 2) : Math.floor(Math.max(0, t) * LOOP_FPS) % e.n;
    return { img: e.sprite, sx: i * e.w, sy: 0, sw: e.w, sh: e.h, n: e.n, i };
  }

  // ------------------------------------------------------------------------------------------- preview on the shot
  /**
   * Hovering a light, look or stunt card previews it over the shot itself. The scratch copy (with the preset applied)
   * renders the frames once at the viewport's size, through the camera the user is looking through, then hands the
   * scratch stage back to the card queue; the overlay plays those frames. The user's stage is never changed, so
   * leaving the card restores the shot at once. { w, h }: the viewport's size in pixels.
   */
  async hoverStart(p, { w = 960, h = 540 } = {}) {
    const kind = liveKind(p);
    if (!kind || kind === "camera") return false;
    const hv = { id: p.id, kind, p, busy: true, ok: false, frames: [], total: kind === "action" ? HOVER_FRAMES : 1, w, h };
    this._hover = hv;
    try {
      const r = kind === "look" ? await this._prepare(null) : await this._prepare(p);
      if (this._hover !== hv) return false;
      this._borrowed = true;
      if (!r.ok) return false;
      hv.ok = true;
      hv.grade = kind === "look" || kind === "light" ? gradeOf(p, this.setups) : null;
      const S = this.scratch, live = this.stage;
      const last = S._lastFrame?.() ?? 96;
      const frames = kind === "action" ? sampleFrames(last, HOVER_FRAMES) : [Math.min(live.frame || 0, last)];
      // Look through the same camera the user is looking through (the shot camera, or Free view).
      const free = !!(live.freeView && live.viewCam && S.viewCam);
      const mode = ["clay", "color", "wire", "depth"].includes(live.view) ? live.view : "clay";
      for (const f of frames) {
        if (this._hover !== hv || this.stopped) return false;
        const c = this._newCanvas(w, h), ctx = c.getContext("2d");
        if (free) {
          S.freeView = true;
          S.viewCam.position.copy(live.viewCam.position); S.viewCam.quaternion.copy(live.viewCam.quaternion);
          S.viewCam.fov = live.viewCam.fov; S.viewCam.aspect = live.viewCam.aspect; S.viewCam.updateProjectionMatrix();
        }
        try {
          if (hv.grade) { try { ctx.filter = gradeFilter(hv.grade); } catch { /* */ } }
          this._renderInto(ctx, f, 0, 0, w, h, { mode, forCapture: !free });
          if (hv.grade) { try { ctx.filter = "none"; } catch { /* */ } gradeOverlay(ctx, hv.grade, w, h); }
        } finally { S.freeView = false; }
        hv.frames.push(c);
        if (hv.frames.length < frames.length) await idle();
      }
    } finally { hv.busy = false; }
    return this._hover === hv && hv.ok;
  }
  hoverEnd() { this._hover = null; }
  get hovering() { return this._hover?.ok ? this._hover : null; }

  /** Draw the hover preview at time t into ctx (w x h): a still, or the stunt playing (frames still arriving play too). */
  hoverFrame(ctx, t, w, h) {
    const hv = this.hovering;
    if (!hv?.frames.length) return false;
    const n = hv.frames.length;
    const i = hv.total > 1 ? Math.floor(Math.max(0, t) * HOVER_FPS) % hv.total : 0;
    ctx.drawImage(hv.frames[Math.min(i, n - 1)], 0, 0, w, h);
    return true;
  }

  pause() { this.paused++; }
  resume() { this.paused = Math.max(0, this.paused - 1); }
  dispose() {
    this.stopped = true;
    this.queue = [];
    try { this.scratch?.dispose?.(); } catch { /* */ }
    try { this.scratch?.renderer?.forceContextLoss?.(); } catch { /* */ }
    this.box?.remove();
    this.scratch = null; this.cache.clear(); this.latest.clear();
  }
}
