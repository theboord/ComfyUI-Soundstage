// Synced review: up to four videos of one shot playing together, frame-locked, under one transport.
//   Grid  (2x2, four across on a wide screen, one column on a tall phone)
//   Wipe  (any two tiles, one handle)
//   Onion (a render over the clay at an opacity, or a Difference blend that shows only what changed)
//
//   const r = new SyncReview(parent, { getSources, onFrame });
//   r.setSources({ fps, slots: [clay, colourClay, draft, final] })   // each { label, url } | { label, live } | null
//   r.refresh()            // re-read getSources() (the current shot's takes)
//   r.show() / r.hide()    // hide pauses; nothing runs while paused (no timers, no animation frames)
//
// Sync: one master clock (wall time x speed, web/review/syncclock.mjs) is the truth. Each video plays natively at
// its own rate; requestVideoFrameCallback reports the frame actually presented, and a tile more than one frame away
// from the master is re-seeked. Without requestVideoFrameCallback the check uses currentTime. Paused, every tile is
// seeked to the exact frame, and its label shows the frame the decoder presented, so "f 52" on all four is the proof.
import { SPEEDS, MasterClock, tileFrame, tileRate, masterLength, driftAction, frameTime, timeFrame, gridLayout, keyAction,
  frameLabel, dropSlots } from "./syncclock.mjs";
import { loadClip } from "./media.mjs";

export const SLOT_NAMES = ["Stage video", "Live stage", "Draft", "Final"];
const READY_TRIES = 30;   // stageReady() attempts per waiting colour-stage tile
const PREF_KEY = "ss_syncreview_v1";
const COOL_MS = 300;   // after a correcting seek, give the tile this long before judging it again

const CSS = `
.ssr{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;width:100%;height:100%;outline:none;
  color:#f0efed;font:12px/1.3 'Soundstage Grotesk',ui-sans-serif,system-ui,sans-serif;box-sizing:border-box}
.ssr *,.ssr *::before,.ssr *::after{box-sizing:border-box}
.ssr.ssr-full{position:fixed;inset:0;z-index:10050;background:#0d0b10;padding:10px max(16px,env(safe-area-inset-right,0px)) 10px max(16px,env(safe-area-inset-left,0px));height:100dvh;width:100vw}
.ssr-bar,.ssr-tp{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;flex:none;min-width:0}
.ssr .grp{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}
.ssr .lab{opacity:.7;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:10.5px}
.ssr button,.ssr select{font:inherit;font-size:12px;border-radius:999px;padding:3px 10px;cursor:pointer;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14);min-height:26px}
.ssr select{border-radius:8px;padding:2px 6px;max-width:132px}
.ssr button:disabled{opacity:.35;cursor:default}
.ssr button[aria-pressed=true]{background:rgba(242,255,89,.16);border-color:rgba(242,255,89,.6);color:#f6ffad;font-weight:600}
.ssr input[type=range]{accent-color:#f2ff59;min-width:0}
.ssr-view{position:relative;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;display:grid;justify-content:center;align-content:center;gap:6px;touch-action:none;user-select:none;-webkit-user-select:none}
/* (a drag across the wipe selected the tiles: Chrome tints a selected video blue, which read as a colour mismatch) */
.ssr-view[data-grow]{flex:none;overflow:visible}
.ssr-tile{position:relative;overflow:hidden;border-radius:6px;background:#000;min-width:0;min-height:0}
.ssr-tile > .m{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
.ssr-view[data-mode=wipe] .ssr-tile,.ssr-view[data-mode=onion] .ssr-tile{position:absolute;border-radius:0;background:transparent}
.ssr-view[data-mode=wipe] .ssr-tile > .m,.ssr-view[data-mode=onion] .ssr-tile > .m{object-fit:cover}
.ssr-view[data-mode=wipe] .ssr-tile[data-role=a],.ssr-view[data-mode=onion] .ssr-tile[data-role=a]{background:#000}
.ssr-tile[hidden]{display:none}
.ssr-tile .cap{position:absolute;left:6px;top:6px;display:flex;gap:6px;align-items:center;max-width:calc(100% - 12px);padding:3px 8px;border-radius:999px;
  background:rgba(0,0,0,.66);color:#fff;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;pointer-events:none;z-index:2}
.ssr-tile .cap .f{font:600 11px/1 ui-monospace,'SF Mono',Menlo,monospace;color:#f2ff59}
.ssr-tile .cap .f[data-off]{color:#ff8a8a}
.ssr-tile[data-role=b] .cap{left:auto;right:6px}
.ssr-tile .empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:12px;color:#8d8794;font-size:12px;border:1px dashed rgba(255,255,255,.14);border-radius:6px}
.ssr-tile[data-drop] .empty,.ssr-tile[data-drop]{box-shadow:inset 0 0 0 2px #f2ff59}
.ssr-handle{position:absolute;top:0;bottom:0;width:3px;margin-left:-1.5px;background:#f2ff59;z-index:3;pointer-events:none}
.ssr-handle::after{content:"";position:absolute;top:50%;left:50%;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:#f2ff59;
  box-shadow:0 1px 6px rgba(0,0,0,.5)}
.ssr-tp .scrub{flex:1 1 160px;min-width:100px}
.ssr-tp .ro{font:600 12px/1 ui-monospace,'SF Mono',Menlo,monospace;white-space:nowrap}
.ssr-tp .ro .io{color:#a9a3ad;font-weight:400}
.ssr-note{flex:none;color:#a9a3ad;font-size:11.5px;min-height:0}
.ssr-note:empty{display:none}
@media (max-width:600px){.ssr button,.ssr select{padding:3px 8px}.ssr .hide-sm{display:none}}
`;

function css() {
  if (typeof document === "undefined" || document.getElementById("ss-syncreview-css")) return;
  const st = document.createElement("style");
  st.id = "ss-syncreview-css";
  st.textContent = CSS;
  document.head.append(st);
}

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (k in e && typeof v !== "string") e[k] = v;
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
};

const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; } catch { return {}; } };

export class SyncReview {
  constructor(parent, { getSources = null, onFrame = null, now = () => performance.now() } = {}) {
    css();
    this.getSources = getSources;
    this.onFrame = onFrame;
    const p = loadPrefs();
    this.mode = ["grid", "wipe", "onion"].includes(p.mode) ? p.mode : "grid";
    this.map = p.map === "time" ? "time" : "frame";
    this.opacity = Number.isFinite(p.opacity) ? p.opacity : 0.5;
    this.diff = !!p.diff;
    this.split = 0.5;
    this.a = 0; this.b = 3;   // wipe / onion: clay vs final by default (the best render that exists, see _pickAB)
    this.masterFps = 24;
    this.clock = new MasterClock({ fps: 24, length: 1, now });
    this.clock.speed = SPEEDS.includes(p.speed) ? p.speed : 1;
    this.tiles = [0, 1, 2, 3].map((i) => ({ i, src: null, kind: null, el: null, fps: 24, frames: 0, ready: false, frame: -1, presented: null, drift: null }));
    this._raf = 0;
    this._gen = 0;

    this.el = h("div", { class: "ssr", tabindex: "0", "aria-label": "Synced review: clay, colour clay, Draft and Final together" });
    this.bar = h("div", { class: "ssr-bar" });
    this.view = h("div", { class: "ssr-view", "data-mode": this.mode });
    this.handle = h("div", { class: "ssr-handle", hidden: true });
    for (const t of this.tiles) {
      t.box = h("div", { class: "ssr-tile", "data-slot": String(t.i) });
      t.cap = h("div", { class: "cap" }, h("span", { class: "n" }, SLOT_NAMES[t.i]), h("span", { class: "f" }, ""));
      t.box.append(t.cap);
      this._empty(t);
      this.view.append(t.box);
    }
    this.view.append(this.handle);
    this.tp = h("div", { class: "ssr-tp" });
    this.note = h("div", { class: "ssr-note", role: "status" });
    this.fileIn = h("input", { type: "file", multiple: true, accept: "video/*,image/*", hidden: true,
      on: { change: () => { this.loadFiles([...this.fileIn.files]); this.fileIn.value = ""; } } });
    this.el.append(this.bar, this.view, this.tp, this.note, this.fileIn);
    parent.append(this.el);

    this._buildBar();
    this._buildTransport();
    this._wire();
    if (typeof ResizeObserver !== "undefined") { this._ro = new ResizeObserver(() => this.layout()); this._ro.observe(this.el); }
  }

  // ------------------------------------------------------------------ sources

  /** Re-read the current shot's takes from the host. */
  refresh() {
    if (!this.getSources) return;
    let spec = null;
    try { spec = this.getSources(); } catch { spec = null; }
    if (spec) this.setSources(spec);
  }

  /**
   * @param {{ fps?:number, slots:(null|{label?:string,url?:string,file?:Blob,live?:{fps,frames,width,height,draw(canvas,frame)},image?:boolean})[] }} spec
   */
  setSources(spec) {
    if (spec.fps > 0) this.masterFps = spec.fps;
    const slots = spec.slots || [];
    for (const t of this.tiles) this._setTile(t, slots[t.i] || null);
    this._retime();
    this._pickAB();
    this._buildBar();
    this.layout();
  }

  /** Drop or pick files: fill the slot dropped on, then the empty slots, then the rest. */
  loadFiles(files, onSlot = null) {
    const list = [...files].filter((f) => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|png|jpe?g|webp)$/i.test(f.name || ""));
    if (!list.length) { this._say("Drop video files (MP4, MOV, WebM) or stills."); return; }
    const order = dropSlots(list.length, onSlot, this.tiles.map((t) => !!t.src));
    order.forEach((slot, k) => {
      const f = list[k];
      this._setTile(this.tiles[slot], { label: String(f.name || `File ${k + 1}`).replace(/\.[^.]+$/, ""), file: f, image: /^image\//.test(f.type) });
    });
    this._retime();
    this._pickAB();
    this._buildBar();
    this.layout();
    this._say(`Loaded ${list.length} file${list.length > 1 ? "s" : ""}. "↺ This shot" puts the shot's own takes back.`);
  }

  _key(src) { return src ? (src.url || (src.file && `file:${src.file.name}:${src.file.size}:${src.file.lastModified}`) || (src.live && `live:${src.label}`) || (src.waitStage && "wait:stage") || "") : ""; }

  _setTile(t, src) {
    if (this._key(src) === this._key(t.src)) {
      if (src?.live) {   // the live stage tile stays; a new shot / length just redraws it
        t.src = src; t.fps = src.live.fps || this.masterFps; t.frames = src.live.frames || 1; t.frame = -1;
        if (src.live.width && src.live.height && (t.el.width !== src.live.width || t.el.height !== src.live.height)) { t.el.width = src.live.width; t.el.height = src.live.height; }
      } else if (src) t.src = src;
      return;
    }
    this._dispose(t);
    t.src = src;
    t.cap.firstChild.textContent = src?.label || SLOT_NAMES[t.i];
    if (!src) { this._empty(t); return; }
    if (src.waitStage) {   // the colour stage before the stage is up: drawn by stageReady(), not on the next frame change
      this._empty(t, "The colour stage draws here once the stage is ready.");
      t.waitStage = true;
      return;
    }
    const gen = ++this._gen;
    t.gen = gen;
    if (src.live) {
      const c = h("canvas", { class: "m" });
      c.width = src.live.width || 960; c.height = src.live.height || 540;
      t.el = c; t.kind = "live"; t.fps = src.live.fps || this.masterFps; t.frames = src.live.frames || 1; t.ready = true; t.frame = -1;
      t.box.replaceChildren(c, t.cap);
      return;
    }
    if (src.image) {
      const img = h("img", { class: "m", alt: src.label || "" });
      img.src = src.url || URL.createObjectURL(src.file);
      t.el = img; t.kind = "image"; t.fps = this.masterFps; t.frames = 1; t.ready = true; t.still = true;
      t.box.replaceChildren(img, t.cap);
      return;
    }
    t.kind = "video"; t.ready = false;
    t.box.replaceChildren(h("div", { class: "empty" }, `Loading ${src.label || SLOT_NAMES[t.i]}…`), t.cap);
    loadClip(src.file || src.url).then((clip) => {
      if (t.gen !== gen) { clip.revoke(); return; }
      t.revoke = clip.revoke;
      t.info = clip.info;
      const v = h("video", { class: "m", muted: true, playsInline: true, preload: "auto", disablePictureInPicture: true });
      v.muted = true;
      v.addEventListener("loadedmetadata", () => {
        if (t.gen !== gen) return;
        t.fps = clip.info?.fps || src.fps || this.masterFps;
        t.frames = clip.info?.frames || Math.max(1, Math.round(v.duration * t.fps));
        t.ready = true;
        this._retime();
        this.layout();
        this._seekTile(t, this._tileTarget(t).frame);
      });
      v.addEventListener("seeked", () => this._onSeeked(t));
      v.addEventListener("error", () => { if (t.gen === gen) { t.ready = false; t.box.replaceChildren(h("div", { class: "empty" }, `${src.label || "This file"} will not play in this browser.`), t.cap); } });
      v.src = clip.src;
      t.el = v;
      t.box.replaceChildren(v, t.cap);
    });
  }

  _empty(t, say = null) {
    const what = SLOT_NAMES[t.i];
    const hint = say || (t.i === 0 ? "No clay video yet: Run ③ Set (the stage preview)."
      : t.i === 1 ? "The colour stage draws here." : `No ${what} for this shot yet.`);
    t.kind = null; t.ready = false; t.el = null; t.frames = 0; t.frame = -1; t.presented = null; t.waitStage = false; t.liveFailed = false;
    t.box.replaceChildren(h("div", { class: "empty" }, `${hint} Or drop a file here.`), t.cap);
    t.cap.querySelector(".f").textContent = "";
  }

  _dispose(t) {
    if (t.kind === "video" && t.el) { try { t.el.pause(); t.el.removeAttribute("src"); t.el.load(); } catch { /* gone */ } }
    if (t.kind === "image" && t.el?.src?.startsWith("blob:")) { try { URL.revokeObjectURL(t.el.src); } catch { /* gone */ } }
    try { t.revoke?.(); } catch { /* gone */ }
    t.revoke = null; t.el = null; t.kind = null; t.ready = false; t.still = false; t.pending = null; t.presented = null; t.drift = null; t.gen = 0;
    t.waitStage = false; t.liveFailed = false; t.readyTries = 0;
  }

  destroy() { this.pause(); for (const t of this.tiles) this._dispose(t); this._ro?.disconnect(); this.el.remove(); }

  // ------------------------------------------------------------------ timing

  _live() { return this.tiles.filter((t) => t.ready && (t.kind === "video" || t.kind === "live")); }

  _retime() {
    const len = masterLength(this._live(), this.masterFps, this.map) || 1;
    this.clock.fps = this.masterFps;
    this.clock.setLength(len);
    if (this.scrub) { this.scrub.max = String(len - 1); }
    this._readout();
  }

  _tileTarget(t, master = this.clock.frame) {
    if (t.kind === "image") return { frame: 0, held: false };
    return tileFrame(master, { masterFps: this.masterFps, fps: t.fps, frames: t.frames, map: this.map });
  }

  /** Seek one tile to its frame. A seek already in flight just takes the new target when it lands (never a pile-up). */
  _seekTile(t, frame) {
    const v = t.el;
    if (t.kind !== "video" || !v || !(v.readyState >= 1)) return;
    const time = Math.min(frameTime(frame, t.fps), Math.max(0, v.duration - 0.25 / t.fps));
    if (v.seeking) { t.pending = time; return; }
    t.pending = null;
    if (Math.abs(v.currentTime - time) > 0.25 / t.fps) v.currentTime = time;
    else this._confirm(t);
  }

  _onSeeked(t) {
    const v = t.el;
    if (t.pending != null && v) { const p = t.pending; t.pending = null; v.currentTime = p; return; }
    this._confirm(t);
  }

  /** Paused: read the frame the decoder actually presented, once (one callback, not a loop). */
  _confirm(t) {
    const v = t.el;
    if (!v || this.clock.playing) return;
    t.presented = timeFrame(v.currentTime, t.fps);
    this._caption(t);
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback((_, meta) => { if (!this.clock.playing && t.el === v) { t.presented = timeFrame(meta.mediaTime, t.fps); this._caption(t); } });
    }
  }

  _caption(t) {
    const f = t.cap.querySelector(".f");
    if (!t.ready || t.liveFailed) { f.textContent = ""; return; }   // no frame number on a tile that drew nothing
    if (t.kind === "image") { f.textContent = "still"; return; }
    const want = this._tileTarget(t);
    const shown = t.kind === "video" && t.presented != null ? t.presented : want.frame;
    const txt = frameLabel(shown, want.held);
    if (f.textContent !== txt) f.textContent = txt;
    // Paused and the decoder shows a different frame than asked (a broken seek): say so in red.
    const off = !this.clock.playing && t.kind === "video" && t.presented != null && t.pending == null && !t.el?.seeking && t.presented !== want.frame;
    if (off) f.setAttribute("data-off", ""); else f.removeAttribute("data-off");
  }

  _drawLive(t, frame) {
    if (t.frame === frame) return;
    // Not drawn yet (the stage is not up, or busy): remember it, so stageReady() draws this frame, instead of the tile
    // staying black until the frame changes (C27: Review opened over the App's start screen).
    if (t.src.live.ready && !t.src.live.ready()) { t.liveFailed = true; return; }
    try { t.src.live.draw(t.el, frame); t.frame = frame; t.liveFailed = false; t.readyTries = 0; } catch { t.liveFailed = true; }
  }

  /** The host's stage has rendered (web/soundstage.js stage.onRendered): a colour-stage tile that is still waiting
   *  re-reads the sources or draws its frame now. A no-op otherwise, so it is cheap on every render. */
  stageReady() {
    const t = this.tiles[1];
    if (this._readying || !(t.waitStage || t.liveFailed) || this.el.hidden) return;
    // a stage that renders but still cannot draw the tile: give up after a few renders (a draw can itself render)
    if (!t.waitStage && (t.readyTries = (t.readyTries || 0) + 1) > READY_TRIES) return;
    this._readying = true;
    try {
      if (t.waitStage) { this.refresh(); if (!this.clock.playing) this._syncAll(); }
      else if (t.kind === "live") { this._drawLive(t, this._tileTarget(t).frame); this._caption(t); }
    } finally { this._readying = false; }
  }

  /** Go to a master frame (paused): every tile seeks there exactly. */
  seek(frame) {
    this.clock.seek(frame);
    if (this.clock.playing) { this.clock.play(this.clock.frame); for (const t of this._live()) if (t.kind === "video") this._seekTile(t, this._tileTarget(t).frame); }
    else this._syncAll();
    this._readout();
  }

  step(n) { if (this.clock.playing) this.pause(); this.seek(this.clock.frame + n); }

  _syncAll() {
    for (const t of this.tiles) {
      if (!t.ready) { this._caption(t); continue; }
      const { frame } = this._tileTarget(t);
      if (t.kind === "video") this._seekTile(t, frame);
      else if (t.kind === "live") this._drawLive(t, frame);
      this._caption(t);
    }
    try { this.onFrame?.(this.clock.frame); } catch { /* host */ }
  }

  get playing() { return this.clock.playing; }

  async play() {
    if (this.clock.playing || !this._live().length) return;
    this.clock.play(this.clock.frame);
    const f = this.clock.frame;
    const vids = this._live().filter((t) => t.kind === "video");
    for (const t of vids) {
      const { frame, held } = this._tileTarget(t, f);
      t.el.playbackRate = tileRate(this.clock.speed, this.masterFps, t.fps, this.map);
      t.pending = null;
      try { t.el.currentTime = frameTime(frame, t.fps); } catch { /* not ready */ }
      t.held = held;
    }
    this._playBtn();
    await Promise.all(vids.filter((t) => !t.held).map((t) => t.el.play().catch(() => {})));
    if (!this.clock.playing) return;   // paused while starting
    this.clock.play(f);                // start the clock when the pictures actually move
    for (const t of vids) this._watch(t);
    this._raf = requestAnimationFrame((now) => this._tick(now));
  }

  pause() {
    if (!this.clock.playing) { this._playBtn(); return; }
    cancelAnimationFrame(this._raf); this._raf = 0;
    this.clock.pause();
    for (const t of this.tiles) {
      if (t.kind === "video" && t.el) {
        try { t.el.pause(); } catch { /* gone */ }
        if (t.rvfc != null && t.el.cancelVideoFrameCallback) t.el.cancelVideoFrameCallback(t.rvfc);
        t.rvfc = null;
      }
    }
    this._syncAll();   // every tile onto the exact same frame
    this._readout();
    this._playBtn();
  }

  toggle() { if (this.clock.playing) this.pause(); else this.play(); }

  /** requestVideoFrameCallback while playing: the frame on screen, and how far it is from the master at that moment. */
  _watch(t) {
    const v = t.el;
    if (typeof v.requestVideoFrameCallback !== "function") return;
    const cb = (_, meta) => {
      if (!this.clock.playing || t.el !== v) { t.rvfc = null; return; }
      t.presented = timeFrame(meta.mediaTime, t.fps);
      const at = meta.expectedDisplayTime || meta.presentationTime;
      const m = Math.floor(this.clock._exact(at));
      const want = this._tileTarget(t, Math.min(m, this.clock.length - 1));
      t.drift = want.held ? null : driftAction(t.presented, want.frame);
      t.rvfc = v.requestVideoFrameCallback(cb);
    };
    t.rvfc = v.requestVideoFrameCallback(cb);
  }

  _tick(now) {
    if (!this.clock.playing) return;
    const vids = this._live().filter((t) => t.kind === "video");
    // A tile that ran out of data holds the clock, so the others wait for it instead of running ahead.
    // (A tile inside its own correction seek is not starving: holding the clock for it would push the others out.)
    const starving = vids.some((t) => !t.held && !t.el.paused && t.el.readyState < 3 && now >= (t.cool || 0));
    this.clock.hold(starving);
    const { frame, wrapped, ended } = this.clock.tick(now);
    for (const t of this._live()) {
      const want = this._tileTarget(t, frame);
      if (t.kind === "live") { this._drawLive(t, want.frame); this._caption(t); continue; }
      const v = t.el;
      if (want.held) {
        if (!t.held) { t.held = true; v.pause(); this._seekTile(t, want.frame); }
      } else if (t.held || wrapped) {
        t.held = false;
        v.currentTime = frameTime(want.frame, t.fps);
        t.cool = now + COOL_MS;
        if (v.paused) v.play().catch(() => {});
      } else if (now >= (t.cool || 0)) {
        // Prefer the presented-frame measurement; fall back to currentTime when the browser has no callback.
        const d = t.drift || driftAction(timeFrame(v.currentTime, t.fps), want.frame);
        if (d.seek) {
          v.currentTime = frameTime(want.frame + Math.round(0.1 * t.fps * v.playbackRate), t.fps);   // aim a little ahead: the seek takes ~100 ms
          t.cool = now + COOL_MS; t.drift = null; t.corrections = (t.corrections || 0) + 1;
        }
      }
      if (!t.el.requestVideoFrameCallback) t.presented = timeFrame(v.currentTime, t.fps);
      this._caption(t);
    }
    this._readout();
    try { this.onFrame?.(frame); } catch { /* host */ }
    if (ended) { this.pause(); return; }
    this._raf = requestAnimationFrame((n) => this._tick(n));
  }

  setSpeed(s) {
    this.clock.setSpeed(s);
    for (const t of this._live()) if (t.kind === "video") t.el.playbackRate = tileRate(s, this.masterFps, t.fps, this.map);
    this._save();
  }

  setMap(m) {
    this.map = m === "time" ? "time" : "frame";
    for (const t of this._live()) if (t.kind === "video") t.el.playbackRate = tileRate(this.clock.speed, this.masterFps, t.fps, this.map);
    this._retime();
    if (!this.clock.playing) this._syncAll();
    this._save();
  }

  // ------------------------------------------------------------------ view

  setMode(m) {
    this.mode = m;
    this.view.dataset.mode = m;
    this._save();
    this._buildBar();
    this.layout();
  }

  /** Wipe / onion default: clay under the best render that exists (Final, else Draft, else colour clay). */
  _pickAB() {
    const has = (i) => !!this.tiles[i].src;
    if (!has(this.a) || this.a === this.b) this.a = [0, 1, 2, 3].find(has) ?? 0;
    if (!has(this.b) || this.b === this.a) this.b = [3, 2, 1, 0].find((i) => has(i) && i !== this.a) ?? (this.a === 3 ? 2 : 3);
  }

  layout() {
    const W = this.view.clientWidth, Hh = this.view.clientHeight;
    if (!W) return;
    const overlay = this.mode !== "grid";
    const shown = overlay ? [this.a, this.b] : [0, 1, 2, 3];   // the grid keeps all four (an empty one says what goes there)
    const ref = this.tiles[overlay ? this.b : 3].el || this.tiles.find((t) => t.el)?.el;
    const aw = ref?.videoWidth || ref?.naturalWidth || ref?.width, ahh = ref?.videoHeight || ref?.naturalHeight || ref?.height;
    const aspect = aw && ahh ? aw / ahh : 16 / 9;
    // A phone-narrow view grows with its content (two across, sized by the width); otherwise fill the box.
    const grow = this.el.clientWidth < 600 && !this.el.classList.contains("ssr-full");
    if (grow) this.view.setAttribute("data-grow", ""); else this.view.removeAttribute("data-grow");
    if (!overlay) {
      const g = gridLayout(W, grow ? 0 : Hh, shown.length, aspect);
      this.view.style.gridTemplateColumns = `repeat(${g.cols}, ${g.tw}px)`;
      this.view.style.gridTemplateRows = `repeat(${g.rows}, ${g.th}px)`;
      this.view.style.height = grow ? `${g.rows * g.th + (g.rows - 1) * 6}px` : "";
      for (const t of this.tiles) {
        t.box.hidden = !shown.includes(t.i);
        t.box.removeAttribute("data-role");
        t.box.style.cssText = "";
        if (t.el) { t.el.style.opacity = ""; t.el.style.mixBlendMode = ""; t.el.style.clipPath = ""; }
      }
      this.handle.hidden = true;
      return;
    }
    const boxH = grow ? Math.round(W / aspect) : Hh;
    this.view.style.height = grow ? `${boxH}px` : "";
    this.view.style.gridTemplateColumns = ""; this.view.style.gridTemplateRows = "";
    const bw = Math.min(W, boxH * aspect), bh = bw / aspect, x = (W - bw) / 2, y = (boxH - bh) / 2;
    const rect = `left:${x}px;top:${y}px;width:${bw}px;height:${bh}px`;
    for (const t of this.tiles) {
      const role = t.i === this.a ? "a" : t.i === this.b ? "b" : null;
      t.box.hidden = !role;
      if (role) t.box.setAttribute("data-role", role); else t.box.removeAttribute("data-role");
      t.box.style.cssText = role ? rect : "";
      if (!t.el) continue;
      const m = t.el.style;
      m.opacity = ""; m.mixBlendMode = ""; m.clipPath = "";
      if (role === "b" && this.mode === "wipe") m.clipPath = `inset(0 0 0 ${(this.split * 100).toFixed(2)}%)`;
      if (role === "b" && this.mode === "onion") { if (this.diff) m.mixBlendMode = "difference"; else m.opacity = String(this.opacity); }
    }
    this._box = { x, y, w: bw, h: bh };
    this.handle.hidden = this.mode !== "wipe";
    this.handle.style.left = `${x + bw * this.split}px`;
    this.handle.style.top = `${y}px`; this.handle.style.bottom = "auto"; this.handle.style.height = `${bh}px`;
  }

  setFull(on) {
    this.el.classList.toggle("ssr-full", on);
    this.fullBtn?.setAttribute("aria-pressed", String(on));
    if (on) this.el.focus({ preventScroll: true });
    requestAnimationFrame(() => this.layout());
  }

  show() { this.el.hidden = false; this.layout(); if (!this.clock.playing) this._syncAll(); }
  hide() { this.pause(); this.el.hidden = true; if (this.el.classList.contains("ssr-full")) this.setFull(false); }

  // ------------------------------------------------------------------ controls

  _save() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ mode: this.mode, map: this.map, opacity: this.opacity, diff: this.diff, speed: this.clock.speed })); } catch { /* storage blocked */ }
  }

  _say(msg) { this.note.textContent = msg || ""; }

  _buildBar() {
    const chip = (label, on, title, click, extra = {}) => h("button", { type: "button", "aria-pressed": String(!!on), title, on: { click }, ...extra }, label);
    const modes = h("span", { class: "grp" }, h("span", { class: "lab" }, "View"),
      chip("Grid", this.mode === "grid", "All four, frame-locked (key 1)", () => this.setMode("grid")),
      chip("Wipe", this.mode === "wipe", "Two tiles split by a handle you drag (key 2)", () => this.setMode("wipe")),
      chip("Onion", this.mode === "onion", "The render over the clay at an opacity, or Difference (key 3)", () => this.setMode("onion")));
    const parts = [modes];
    if (this.mode !== "grid") {
      const pick = (lab, cur, set) => h("label", { class: "grp" }, h("span", { class: "lab" }, lab),
        h("select", { on: { change: (e) => { set(+e.target.value); this._pickAB(); this._buildBar(); this.layout(); this._syncAll(); } } },
          this.tiles.map((t) => h("option", { value: String(t.i), selected: t.i === cur, disabled: !t.src }, t.src?.label || SLOT_NAMES[t.i]))));
      parts.push(pick(this.mode === "wipe" ? "Left" : "Under", this.a, (i) => { if (i === this.b) this.b = this.a; this.a = i; }));
      parts.push(pick(this.mode === "wipe" ? "Right" : "Over", this.b, (i) => { if (i === this.a) this.a = this.b; this.b = i; }));
    }
    if (this.mode === "onion") {
      const op = h("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(this.opacity), disabled: this.diff, style: "width:110px",
        "aria-label": "Opacity of the top layer",
        on: { input: (e) => { this.opacity = +e.target.value; this.layout(); this._save(); } } });
      parts.push(h("span", { class: "grp" }, h("span", { class: "lab" }, "Opacity"), op,
        chip("Difference", this.diff, "Show only what differs: black where the render matches the clay", () => { this.diff = !this.diff; this._save(); this._buildBar(); this.layout(); })));
    }
    parts.push(h("span", { class: "grp" },
      chip("↺ This shot", false, "Load this shot's clay, colour clay, Draft and Final", () => { this.refresh(); this._say(""); }, { disabled: !this.getSources }),
      chip("Add files…", false, "Pick up to four video files (or drop them on the tiles)", () => this.fileIn.click()),
      this.fullBtn = chip("⤢ Full window", this.el.classList.contains("ssr-full"), "Fill the window (Esc to return)", () => this.setFull(!this.el.classList.contains("ssr-full")))));
    this.bar.replaceChildren(...parts);
  }

  _buildTransport() {
    const b = (label, title, click) => h("button", { type: "button", title, on: { click } }, label);
    this.playBtn = b("▶ Play", "Play / pause (Space)", () => this.toggle());
    this.scrub = h("input", { type: "range", class: "scrub", min: "0", max: "0", step: "1", value: "0", "aria-label": "Frame",
      on: { input: (e) => { if (this.clock.playing) this.pause(); this.seek(+e.target.value); } } });
    this.ro = h("span", { class: "ro" });
    this.loopBtn = h("button", { type: "button", "aria-pressed": String(this.clock.loop), title: "Loop between In and Out (L)",
      on: { click: () => { this.clock.loop = !this.clock.loop; this.loopBtn.setAttribute("aria-pressed", String(this.clock.loop)); } } }, "⟲ Loop");
    const speed = h("select", { "aria-label": "Speed", title: "Playback speed",
      on: { change: (e) => this.setSpeed(+e.target.value) } }, SPEEDS.map((s) => h("option", { value: String(s), selected: s === this.clock.speed }, `${s}×`)));
    const map = h("select", { "aria-label": "Line files up by", title: "By frame: frame N of every file together (renders of one shot). By time: the same second (files at different rates).",
      on: { change: (e) => this.setMap(e.target.value) } },
      h("option", { value: "frame", selected: this.map === "frame" }, "By frame"), h("option", { value: "time", selected: this.map === "time" }, "By time"));
    this.tp.append(
      h("span", { class: "grp" },
        b("⏮", "To In (Home)", () => this._go("in")),
        b("◀", "Back one frame (←, Shift+← ten)", () => this.step(-1)),
        this.playBtn,
        b("▶|", "Forward one frame (→, Shift+→ ten)", () => this.step(1)),
        b("⏭", "To Out (End)", () => this._go("out"))),
      this.scrub, this.ro,
      h("span", { class: "grp" },
        b("In", "Set In at this frame (I)", () => this._mark("in")),
        b("Out", "Set Out at this frame (O)", () => this._mark("out")),
        this.loopBtn,
        b("✕", "Clear In / Out (X)", () => { this.clock.clearRange(); this._readout(); })),
      h("span", { class: "grp" }, speed, map));
    this._readout();
  }

  _go(where) { this.pause(); this.seek(where === "in" ? this.clock.inF : this.clock.outF); }
  _mark(which) {
    const f = this.clock.frame;
    if (which === "in") this.clock.setRange(f, Math.max(f, this.clock.outF)); else this.clock.setRange(Math.min(f, this.clock.inF), f);
    this._readout();
  }

  _playBtn() { if (this.playBtn) this.playBtn.textContent = this.clock.playing ? "❚❚ Pause" : "▶ Play"; }

  _readout() {
    if (!this.ro) return;
    const c = this.clock, f = c.frame, last = c.length - 1;
    if (this.scrub && +this.scrub.value !== f) this.scrub.value = String(f);
    const secs = (f / this.masterFps).toFixed(2);
    const ranged = c.inF > 0 || c.outF < last;
    const txt = `f ${f} / ${last} · ${secs}s`;
    if (this._roTxt !== txt + ranged + c.inF + c.outF) {
      this._roTxt = txt + ranged + c.inF + c.outF;
      this.ro.replaceChildren(txt, ranged ? h("span", { class: "io" }, ` · in ${c.inF} out ${c.outF}`) : "");
    }
  }

  _wire() {
    this.el.addEventListener("keydown", (e) => {
      if (e.target.closest?.("input:not([type=range]), textarea, select, [contenteditable]")) return;
      const a = keyAction(e);
      if (!a) return;
      if (a.escape) { if (this.el.classList.contains("ssr-full")) { e.preventDefault(); e.stopPropagation(); this.setFull(false); } return; }
      e.preventDefault(); e.stopPropagation();
      if (a.step) this.step(a.step);
      else if (a.toggle) this.toggle();
      else if (a.go) this._go(a.go);
      else if (a.mark) this._mark(a.mark);
      else if (a.loop) this.loopBtn.click();
      else if (a.clearRange) { this.clock.clearRange(); this._readout(); }
      else if (a.mode) this.setMode(a.mode);
    });
    // The App listens for pointer events on its panel; keep ours to ourselves.
    this.el.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (!e.target.closest("select, input, button")) this.el.focus({ preventScroll: true }); });
    // Wipe: drag anywhere on the picture.
    let drag = false;
    const at = (e) => {
      const r = this.view.getBoundingClientRect(), b = this._box || { x: 0, w: r.width };
      this.split = Math.min(1, Math.max(0, (e.clientX - r.left - b.x) / Math.max(1, b.w)));
      this.layout();
    };
    this.view.addEventListener("pointerdown", (e) => {
      if (this.mode !== "wipe") return;
      drag = true; try { this.view.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      at(e);
    });
    this.view.addEventListener("pointermove", (e) => { if (drag) at(e); });
    const end = () => { drag = false; };
    this.view.addEventListener("pointerup", end);
    this.view.addEventListener("pointercancel", end);
    // Drop files on a tile (or anywhere on the view).
    const tileAt = (e) => { const el = e.target.closest?.(".ssr-tile"); return el ? +el.dataset.slot : null; };
    this.view.addEventListener("dragover", (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      const s = tileAt(e);
      for (const t of this.tiles) if (t.i === s) t.box.setAttribute("data-drop", ""); else t.box.removeAttribute("data-drop");
    });
    this.view.addEventListener("dragleave", (e) => { if (!this.view.contains(e.relatedTarget)) for (const t of this.tiles) t.box.removeAttribute("data-drop"); });
    this.view.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); e.stopPropagation();
      for (const t of this.tiles) t.box.removeAttribute("data-drop");
      this.pause();
      this.loadFiles(e.dataTransfer.files, tileAt(e));
    });
  }
}
