// Soundstage CUT tab: an editing timeline (V1 + audio tracks A1..An) that plays a live animatic of
// the coverage with temp sound, and exports to every NLE. Clips play their best rung: Final or Draft
// video, the Look still, or live clay from the stage (renderPreviewFrame) when nothing is rendered yet.
// Audio clips play through WebAudio, locked to the picture.
// Edit model: timeline.mjs. Writers: exporters.mjs. Contract and mounting: docs/cut.md.

import * as TL from "./timeline.mjs";
import { exportAll, fpsInfo, framesToTC, recordStart } from "./exporters.mjs";
import { icon } from "../ui/icons.mjs";

/** A transport button's face: a Lucide icon (plus an optional speed like "2×"); the title names it for screen readers. */
const face = (b, name, extra = "") => {
  if (b.dataset.face === name + extra) return;
  b.dataset.face = name + extra;
  b.replaceChildren(icon(name, 14), ...(extra ? [extra] : []));
  b.setAttribute("aria-label", b.title || name);
};

export const RUNG_COLORS = { clay: "#5b6475", look: "#3d6ea8", draft: "#7652b3", final: "#3c9561" };
const ACCENT = "#e39a40";
const RULER_H = 22;
const HEADER_W = 58; // track header column (V1, A1 M S ...)
const TRACK_Y = 26; // V1
const TRACK_H = 60;
const A_Y = TRACK_Y + TRACK_H + 6; // first audio track
const A_H = 40;
const A_GAP = 4;
const AUDIO_COLOR = "#2c6a61";
const EDGE_PX = 6;
const SNAP_PX = 8;
const SHUTTLE = [1, 2, 4, 8];

const CSS = `
.ss-cut{display:flex;flex-direction:column;gap:6px;color:#cfd5de;font:12px/1.3 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif;outline:none;background:#16191e;padding:6px;border-radius:6px;box-sizing:border-box;min-width:0}
.ss-cut:focus-visible{box-shadow:0 0 0 1px #e39a4088}
.ss-cut-viewer{background:#0d1117;border-radius:4px;overflow:hidden;display:flex;justify-content:center}
.ss-cut-viewer canvas{display:block;width:100%;height:auto;max-height:52vh;object-fit:contain}
.ss-cut-bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.ss-cut-bar button{background:#262b33;color:#cfd5de;border:1px solid #39404b;border-radius:4px;padding:3px 8px;cursor:pointer;font:inherit;min-width:26px;line-height:16px}
.ss-cut-bar button:hover:not(:disabled){border-color:#5a6370;color:#fff}
.ss-cut-bar button[aria-pressed=true]{background:#e39a40;color:#16191e;border-color:#e39a40}
.ss-cut-bar button:disabled{opacity:.4;cursor:default}
.ss-cut-tc{font:600 15px/1 ui-monospace,Menlo,monospace;color:#fff;background:#0d1117;border:1px solid #39404b;border-radius:4px;padding:4px 8px;letter-spacing:.5px;font-variant-numeric:tabular-nums}
.ss-cut-ro{font:11px/1.2 ui-monospace,Menlo,monospace;color:#9aa3af;white-space:pre}
.ss-cut-ro b{color:#e9edf2;font-weight:600}
.ss-cut-sep{width:1px;height:18px;background:#39404b;margin:0 2px}
.ss-cut-grow{flex:1}
.ss-cut-tl canvas{display:block;width:100%;height:150px;border-radius:4px;background:#1b1f25;touch-action:none}
.ss-cut-insp{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#1d2127;border:1px solid #2e343d;border-radius:4px;padding:4px 8px}
.ss-cut-insp[hidden]{display:none}
.ss-cut-insp label{display:flex;gap:4px;align-items:center;color:#9aa3af}
.ss-cut-insp input{background:#0d1117;color:#e9edf2;border:1px solid #39404b;border-radius:3px;font:inherit;padding:2px 4px;width:58px}
.ss-cut-insp input.wide{width:180px}
.ss-cut-insp b{color:#7fd1c0;font-weight:600}
.ss-cut-bin{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.ss-cut-bin>span{color:#7d8794;margin-right:2px}
.ss-cut-chip{display:flex;gap:6px;align-items:center;background:#20252c;border:1px solid #39404b;border-radius:4px;padding:3px 8px;cursor:grab;user-select:none;touch-action:none}
.ss-cut-chip:hover{border-color:#5a6370}
.ss-cut-chip i{width:8px;height:8px;border-radius:2px;display:inline-block}
.ss-cut-chip small{color:#8b94a1}
.ss-cut-help{color:#6f7985;font-size:11px}
`;

function injectCSS() {
  if (document.getElementById("ss-cut-css")) return;
  const st = document.createElement("style");
  st.id = "ss-cut-css";
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ComfyUI's canvas listens for wheel on the window. Route wheel events over the timeline to the
// panel first (capture phase), the same trick as installWheelRouter() in stage.mjs.
let wheelRouterInstalled = false;
function installWheelRouter() {
  if (wheelRouterInstalled) return;
  wheelRouterInstalled = true;
  window.addEventListener(
    "wheel",
    (e) => {
      const panel = e.target?.__soundstageCut;
      if (!panel) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      panel._onWheel(e);
    },
    { capture: true, passive: false },
  );
}

const stop = (e) => e.stopPropagation();

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function sourceSize(src) {
  return [src.videoWidth || src.naturalWidth || src.width || 0, src.videoHeight || src.naturalHeight || src.height || 0];
}

/** Draw src into the rect (x, y, w, h), letterboxed. */
function drawContain(ctx, src, x, y, w, h) {
  const [sw, sh] = sourceSize(src);
  if (!sw || !sh) return false;
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return true;
}

const PEAK_BLOCK = 256;

/** Max |sample| per PEAK_BLOCK samples across channels: enough to draw a waveform at any zoom. */
function peaksOf(buffer) {
  const n = Math.ceil(buffer.length / PEAK_BLOCK);
  const peaks = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = peaks[i];
      const end = Math.min(d.length, (i + 1) * PEAK_BLOCK);
      for (let j = i * PEAK_BLOCK; j < end; j++) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; }
      peaks[i] = m;
    }
  }
  return peaks;
}

/** Clip gain and linear fades on a GainNode, for a clip starting `off` frames in, at context time `when`. */
function scheduleEnvelope(param, a, off, when, rate) {
  const g = Math.pow(10, a.gain_db / 20), len = a.out - a.in, fi = a.fade_in, fo = a.fade_out;
  const env = (f) => g * Math.max(0, Math.min(1, fi ? f / fi : 1, fo ? (len - f) / fo : 1));
  param.setValueAtTime(env(off), when);
  let t = off;
  if (fi && off < fi) { param.linearRampToValueAtTime(env(fi), when + (fi - off) / rate); t = fi; }
  if (fo) {
    const fs = len - fo;
    if (t < fs) param.setValueAtTime(env(fs), when + (fs - off) / rate);
    param.linearRampToValueAtTime(0, when + (len - off) / rate);
  }
}

export class CutPanel {
  /**
   * @param {HTMLElement} container
   * @param {{getProject?: () => object, renderPreviewFrame?: (shotId: string, frame: number) => CanvasImageSource,
   *          onChange?: (project: object) => void}} host
   */
  constructor(container, { getProject, renderPreviewFrame, onChange, onEditShot } = {}) {
    this._onEditShot = onEditShot || null;   // "edit original": jump to the step that made a clip, then back
    injectCSS();
    installWheelRouter();
    this._getProject = getProject || (() => ({}));
    this._renderPreviewFrame = renderPreviewFrame || null;
    this._onChange = onChange || (() => {});

    this.project = TL.normalizeProject({});
    this.frame = 0; // record position in frames from the head of the cut (fractional while playing)
    this.speed = 0; // J/K/L shuttle: 0 stopped, ±1/2/4/8
    this.sel = -1;
    this.marks = { in: null, out: null }; // out is exclusive
    this.action = true; // cut-on-action matching + snapping
    this.loop = false;
    this.audio = false;
    this.ppf = 4; // timeline pixels per frame
    this.scrollX = 0;
    this._fitPending = true;
    this.history = [];
    this.future = [];
    this.media = new Map(); // url -> {kind, el, ok}
    this.thumbs = new Map();
    this._drag = null;
    this._raf = 0;
    this._last = 0;
    this._activeVideo = null;
    this.aSel = null; // selected audio clip id
    this.syncLock = true; // picture ripple edits carry the audio after them along
    this.abufs = new Map(); // audio url -> {state, buffer, peaks, error}
    this._voices = []; // playing WebAudio sources
    this._aClock = null; // {t0, from} while audio drives the clock

    this._build(container);
    this._onSfx = (e) => {
      const d = e.detail;
      const clips = Array.isArray(d) ? d : d && Array.isArray(d.clips) ? d.clips : d ? [d] : [];
      clips.forEach((c) => this.addAudioClip(c));
    };
    window.addEventListener("soundstage.sfx", this._onSfx);
    this.refresh();
  }

  // ------------------------------------------------------------------ public API

  /** Re-read the host project (new shots, new renders). Keeps the panel's cut unless the host sends one. */
  refresh() {
    const host = this._getProject() || {};
    const hostHasCut = Array.isArray(host.cut);
    let p = TL.normalizeProject({
      ...host,
      cut: hostHasCut ? host.cut : this.project.cut,
      audio: Array.isArray(host.audio) ? host.audio : this.project.audio,
      audio_tracks: Array.isArray(host.audio_tracks) ? host.audio_tracks : this.project.audio_tracks,
    });
    let assembled = false;
    if (!hostHasCut && !this.project.cut.length && p.shots.length) {
      p = { ...p, cut: TL.stringOut(p) };
      assembled = true;
    }
    this.project = p;
    this.fi = fpsInfo(p.fps);
    this.rate = this.fi.num / this.fi.den;
    this.thumbs.clear();
    this._syncMedia();
    this._syncAudio();
    this._renderBin();
    this.sel = Math.min(this.sel, p.cut.length - 1);
    this.frame = Math.min(this.frame, Math.max(0, TL.totalFrames(p) - 1));
    if (this._fitPending && this.tl.clientWidth) this.fit();
    this._updateButtons();
    this.requestDraw();
    if (assembled) this._emit();
  }

  /** Replace the whole project (clears undo). */
  setProject(project) {
    this.project = TL.normalizeProject(project);
    this.history = [];
    this.future = [];
    this._fitPending = true;
    this.refresh();
  }

  /** A plain copy of the project in the contract shape (what onChange receives). */
  getProject() {
    return JSON.parse(JSON.stringify(this.project));
  }

  toJSON() {
    return this.getProject();
  }

  /** Every browser-side export as text, keyed by file name (see exporters.mjs exportAll). */
  exportFiles(opts = {}) {
    return exportAll(this.project, opts);
  }

  /** Picture length in frames. */
  get total() {
    return TL.totalFrames(this.project);
  }

  /** Sequence length: picture or audio, whichever is longer. */
  get seqLen() {
    return TL.sequenceFrames(this.project);
  }

  // ---- audio API (the SFX builder calls these, or dispatches a "soundstage.sfx" CustomEvent on window)

  /**
   * Add an audio clip: {url | path, label?, track?, start_frame?, in?, out?, frames?, gain_db?, fade_in?,
   * fade_out?, id?, meta?}. Defaults: start at the playhead, the first free track, the whole file (its
   * length is filled in once it decodes). Returns the clip id.
   */
  addAudioClip(clip) {
    if (!clip || !(clip.url || clip.path)) return null;
    const start = clip.start_frame != null ? clip.start_frame : Math.floor(this.frame);
    const len = clip.out != null ? clip.out - (clip.in || 0) : clip.frames || 48;
    const ids = new Set(this.project.audio.map((a) => a.id));
    let id = clip.id != null ? String(clip.id) : `sfx${this.project.audio.length + 1}`;
    while (ids.has(id)) id += "_";
    const track = clip.track != null ? clip.track : TL.freeTrack(this.project, start, len);
    const audio = TL.normalizeAudio([...this.project.audio, { ...clip, id, track, start_frame: start }], this.project.fps);
    this._commit(this.project.cut, this.sel, { audio });
    this._syncAudio();
    return id;
  }

  addAudioClips(clips) {
    return (clips || []).map((c) => this.addAudioClip(c));
  }

  updateAudioClip(id, patch) {
    this._commit(this.project.cut, this.sel, { audio: TL.setAudio(this.project, id, patch) });
    this._syncAudio();
  }

  removeAudioClip(id) {
    if (this.aSel === String(id)) this.aSel = null;
    this._commit(this.project.cut, this.sel, { audio: TL.removeAudio(this.project, id) });
  }

  getAudioClips() {
    return JSON.parse(JSON.stringify(this.project.audio));
  }

  /** Mute / solo / name a track: setTrack(2, {mute: true}). */
  setTrack(track, patch) {
    const list = this.project.audio_tracks.filter((t) => t.track !== track);
    const cur = TL.trackState(this.project, track);
    list.push({ ...cur, ...patch, track });
    list.sort((a, b) => a.track - b.track);
    this._commit(this.project.cut, this.sel, { audio_tracks: list });
    this._applyTrackGains();
  }

  play(speed = 1) {
    if (!this.seqLen) return;
    if (speed > 0 && Math.floor(this.frame) >= this._playEnd() - 1) this.frame = this._playStart();
    if (speed < 0 && this.frame <= 0) this.frame = this.seqLen;
    this.speed = speed;
    this._last = 0;
    if (speed === 1) this._audioStart(this.frame);
    else this._audioStop();
    this._updateButtons();
    this.requestDraw();
  }

  stop() {
    if (!this.speed) return;
    this.speed = 0;
    this.frame = Math.floor(this.frame);
    this._audioStop();
    this._activeVideo?.pause();
    this._updateButtons();
    this.requestDraw();
  }

  togglePlay() {
    this.speed ? this.stop() : this.play(1);
  }

  /** J (-1) / L (+1): press again to go faster, the other way to reverse. */
  shuttle(dir) {
    const cur = Math.abs(this.speed);
    const next = Math.sign(this.speed) === dir ? SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(cur) + 1)] : 1;
    this.play(dir * next);
  }

  seek(f) {
    const n = this.seqLen;
    this.frame = TL.clamp(Math.round(f), 0, Math.max(0, n - (n ? 1 : 0)));
    if (this.speed === 1) this._audioStart(this.frame);
    this._follow();
    this.requestDraw();
  }

  step(n) {
    this.stop();
    this.seek(Math.floor(this.frame) + n);
  }

  gotoEdit(dir) {
    this.stop();
    const f = Math.floor(this.frame);
    const pts = TL.editPoints(this.project);
    const t = dir > 0 ? pts.find((p) => p > f) : [...pts].reverse().find((p) => p < f);
    if (t != null) this.seek(Math.min(t, Math.max(0, this.seqLen - 1)));
  }

  markIn() {
    this.marks.in = Math.floor(this.frame);
    if (this.marks.out != null && this.marks.out <= this.marks.in) this.marks.out = null;
    this._updateButtons();
    this.requestDraw();
  }

  markOut() {
    this.marks.out = Math.floor(this.frame) + 1;
    if (this.marks.in != null && this.marks.in >= this.marks.out) this.marks.in = null;
    this._updateButtons();
    this.requestDraw();
  }

  clearMarks() {
    this.marks = { in: null, out: null };
    this._updateButtons();
    this.requestDraw();
  }

  /** Add an edit at the playhead. */
  split() {
    this.stop();
    const f = Math.floor(this.frame);
    if (this.aSel) {
      const audio = TL.splitAudio(this.project, this.aSel, f);
      if (audio.length !== this.project.audio.length) this._commit(this.project.cut, this.sel, { audio });
      return;
    }
    const row = TL.eventAt(this.project, f);
    if (!row || f === row.recIn) return;
    this._commit(TL.splitAt(this.project, f), row.index + 1);
  }

  /** Delete the selected clip and close the gap; with no selection, extract the I/O range. */
  rippleDelete() {
    this.stop();
    if (this.aSel) { this.removeAudioClip(this.aSel); return; }
    if (this.sel >= 0) {
      const row = TL.layout(this.project)[this.sel];
      this._commit(TL.rippleDelete(this.project, this.sel), Math.min(this.sel, this.project.cut.length - 2),
                   { audio: this._ripple(row.recOut, -row.len) });
      if (row && this.frame >= row.recOut) this.frame -= row.len;
      else if (row && this.frame > row.recIn) this.frame = row.recIn;
      this.seek(this.frame);
      return;
    }
    this.extract();
  }

  /** Remove the marked range and close the gap (Avid Extract). */
  extract() {
    const { in: a, out: b } = this.marks;
    if (a == null || b == null) return;
    this.stop();
    this._commit(TL.extractRange(this.project, a, b), -1, { audio: this._ripple(b, -(b - a)) });
    this.clearMarks();
    this.seek(a);
  }

  /** Splice a whole shot in at the playhead (splitting the clip under it), cut on action. */
  spliceIn(shotId) {
    this.stop();
    const f = Math.floor(this.frame);
    const tmp = { ...this.project, cut: TL.splitAt(this.project, f) };
    const at = TL.layout(tmp).filter((r) => r.recOut <= f).length;
    const cut = TL.insertShot(tmp, shotId, at, { action: this.action });
    this._commit(cut, at, { audio: this._ripple(f, TL.totalFrames({ ...this.project, cut }) - this.total) });
  }

  /** Overwrite the I/O range (or playhead to end of clip) with a shot, matched to the action it replaces. */
  overwriteShot(shotId) {
    this.stop();
    const shot = TL.shotMap(this.project).get(String(shotId));
    if (!shot) return;
    let a, b;
    if (this.marks.in != null && this.marks.out != null) [a, b] = [this.marks.in, this.marks.out];
    else {
      a = Math.floor(this.frame);
      const row = TL.eventAt(this.project, a);
      b = row ? row.recOut : a + shot.frames;
    }
    const srcIn = (this.action && TL.actionInAtRecord(this.project, a, shotId)) || 0;
    const cut = TL.overwrite(this.project, a, b, shotId, srcIn);
    const at = TL.layout({ ...this.project, cut }).findIndex((r) => r.recIn === a && r.event.shot_id === shot.id);
    this._commit(cut, at);
  }

  /** Slide the selected clip's in point to continue the action from the clip before it. */
  matchSelected() {
    if (this.sel <= 0) return;
    const cut = TL.matchAction(this.project, this.project.cut.map((e) => ({ ...e })), this.sel);
    this._commit(cut, this.sel);
  }

  _snapshot() {
    return { cut: this.project.cut, audio: this.project.audio, audio_tracks: this.project.audio_tracks };
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(this._snapshot());
    this.project = { ...this.project, ...this.history.pop() };
    this._afterEdit();
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(this._snapshot());
    this.project = { ...this.project, ...this.future.pop() };
    this._afterEdit();
  }

  zoom(factor, anchorX = (this.tl.clientWidth + HEADER_W) / 2) {
    const f = this._frameAt(anchorX);
    this.ppf = TL.clamp(this.ppf * factor, 0.02, 48);
    this.scrollX = f * this.ppf - (anchorX - HEADER_W);
    this._fitPending = false;
    this._clampScroll();
    this.requestDraw();
  }

  /** Fit the whole cut in the timeline. */
  fit() {
    const w = this.tl.clientWidth - HEADER_W;
    if (w <= 0) return;
    this.ppf = TL.clamp((w - 24) / Math.max(TL.sequenceFrames(this.project), 24), 0.02, 48);
    this.scrollX = 0;
    this._fitPending = false;
    this.requestDraw();
  }

  /** Call when the tab becomes visible (sizes are 0 while hidden). */
  resize() {
    if (this._fitPending) this.fit();
    this.requestDraw();
  }

  dispose() {
    this.stop();
    window.removeEventListener("soundstage.sfx", this._onSfx);
    this._audioStop();
    this._ac?.close?.();
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    for (const m of this.media.values()) this._release(m);
    this.media.clear();
    this.root.remove();
  }

  // ------------------------------------------------------------------ DOM

  _build(container) {
    const root = (this.root = document.createElement("div"));
    root.className = "ss-cut";
    root.tabIndex = 0;
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keyup", "keypress"]) {
      root.addEventListener(t, stop);
    }
    root.addEventListener("pointerdown", () => root.focus({ preventScroll: true }));
    root.addEventListener("keydown", (e) => this._onKey(e));

    // viewer
    const vw = document.createElement("div");
    vw.className = "ss-cut-viewer";
    this.viewer = document.createElement("canvas");
    this.viewer.width = 960;
    this.viewer.height = 540;
    this.vctx = this.viewer.getContext("2d");
    this.pic = document.createElement("canvas"); // last good picture, so a seeking video holds its frame
    this.pctx = this.pic.getContext("2d");
    vw.append(this.viewer);
    this.viewer.addEventListener("click", () => this.togglePlay());

    // transport + edit bar
    const bar = document.createElement("div");
    bar.className = "ss-cut-bar";
    const btn = (label, title, fn, toggle) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      if (toggle) b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(e); root.focus({ preventScroll: true }); });
      bar.append(b);
      return b;
    };
    const sep = () => { const s = document.createElement("span"); s.className = "ss-cut-sep"; bar.append(s); };
    this.tcEl = document.createElement("span");
    this.tcEl.className = "ss-cut-tc";
    this.tcEl.title = "Record timecode (24 fps non-drop, starts 01:00:00:00)";
    bar.append(this.tcEl);
    this.b = {};
    this.b.prev = btn("", "Previous edit (↑)", () => this.gotoEdit(-1));
    this.b.rev = btn("", "Shuttle reverse (J)", () => this.shuttle(-1));
    this.b.play = btn("", "Play / stop (Space)", () => this.togglePlay());
    this.b.fwd = btn("", "Shuttle forward (L)", () => this.shuttle(1));
    this.b.next = btn("", "Next edit (↓)", () => this.gotoEdit(1));
    face(this.b.prev, "skip-back"); face(this.b.rev, "rewind"); face(this.b.play, "play"); face(this.b.fwd, "fast-forward"); face(this.b.next, "skip-forward");
    this.b.loop = btn("Loop", "Loop playback (the I/O range when marked)", () => { this.loop = !this.loop; this._updateButtons(); }, true);
    this.b.audio = btn("Audio", "Play the audio of Draft/Final clips at 1x", () => { this.audio = !this.audio; this._updateButtons(); }, true);
    sep();
    this.markEl = document.createElement("span");
    this.markEl.className = "ss-cut-ro";
    bar.append(this.markEl);
    const grow = document.createElement("span");
    grow.className = "ss-cut-grow";
    bar.append(grow);
    this.b.zoomOut = btn("−", "Zoom out (-)", () => this.zoom(1 / 1.5));
    this.b.fit = btn("Fit", "Fit the cut to the timeline (\\)", () => this.fit());
    this.b.zoomIn = btn("+", "Zoom in (=)", () => this.zoom(1.5));

    const bar2 = document.createElement("div");
    bar2.className = "ss-cut-bar";
    const btn2 = (...a) => { const b = btn(...a); bar2.append(b); return b; };
    const sep2 = () => { const s = document.createElement("span"); s.className = "ss-cut-sep"; bar2.append(s); };
    this.b.split = btn2("Split", "Add edit at the playhead (B / ⌘B)", () => this.split());
    this.b.del = btn2("Ripple delete", "Delete the selected clip and close the gap; with no selection, extract the I/O range (⌫)", () => this.rippleDelete());
    this.b.extract = btn2("Extract I/O", "Remove the marked range and close the gap (X)", () => this.extract());
    this.b.match = btn2("Match action", "Slide the selected clip to continue the action of the clip before it (M)", () => this.matchSelected());
    this.b.action = btn2("Cut on action", "Match the scene frame when cutting between setups of one scene, and snap trims to it", () => { this.action = !this.action; this._updateButtons(); this.requestDraw(); }, true);
    this.b.sync = btn2("Sync lock", "Picture ripple edits (delete, extract, trims, splice, reorder) move the audio after them too", () => { this.syncLock = !this.syncLock; this._updateButtons(); }, true);
    sep2();
    this.b.undo = btn2("Undo", "Undo (⌘Z)", () => this.undo());
    this.b.redo = btn2("Redo", "Redo (⇧⌘Z)", () => this.redo());
    const grow2 = document.createElement("span");
    grow2.className = "ss-cut-grow";
    bar2.append(grow2);
    const exp = document.createElement("span");
    exp.className = "ss-cut-ro";
    exp.textContent = "Export";
    bar2.append(exp);
    btn2("Avid EDL", "CMX3600 EDL (picture + audio events) for Avid Media Composer. The AAF comes from the Cut Export node.", () => this._download(".edl"));
    btn2("Avid markers", "Avid locator .txt (Markers window > Import Markers): notes and relink flags on V1", () => this._download("_avid_locators.txt"));
    btn2("Premiere XML", "Final Cut Pro 7 XML (xmeml v5), which Premiere Pro imports natively, with the audio tracks", () => this._download("_premiere.xml"));
    btn2("FCPXML", "FCPXML 1.10 for DaVinci Resolve and Final Cut Pro, with the audio as connected clips", () => this._download(".fcpxml"));
    btn2("OTIO", "OpenTimelineIO for DaVinci Resolve and other OTIO tools", () => this._download(".otio"));

    // timeline
    const tlw = document.createElement("div");
    tlw.className = "ss-cut-tl";
    this.tl = document.createElement("canvas");
    this.tl.__soundstageCut = this;
    this.tctx = this.tl.getContext("2d");
    tlw.append(this.tl);
    this.tl.addEventListener("pointerdown", (e) => this._tlDown(e));
    this.tl.addEventListener("pointermove", (e) => this._tlMove(e));
    this.tl.addEventListener("pointerup", (e) => this._tlUp(e));
    this.tl.addEventListener("pointercancel", () => { this._cancelDrag(); });
    // Right-click a clip: edit its original (stage, frame, Canvas touch-up, motion), Dynamic Link style.
    // Every render is kept per shot, so the clip shows the new render as soon as it lands.
    this.tl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hit = this._hit(this._local(e).x, this._local(e).y);
      if (hit.type !== "clip" || !this._onEditShot) return;
      const row = TL.layout(this.project)[hit.idx];
      if (row?.shot?.id) this._clipMenu(row.shot.id, row.shot.name || row.shot.id, e);
    });
    this.tl.addEventListener("dblclick", (e) => {
      const hit = this._hit(this._local(e).x, this._local(e).y);
      if (hit.type === "clip") this.seek(TL.layout(this.project)[hit.idx].recIn);
      if (hit.audio) this.seek(hit.audio.start_frame);
    });

    // inspector for the selected audio clip
    const insp = (this.insp = document.createElement("div"));
    insp.className = "ss-cut-insp";
    insp.hidden = true;
    const title = document.createElement("b");
    insp.append(title);
    const fields = {};
    const field = (key, label, attrs = {}) => {
      const l = document.createElement("label");
      l.textContent = label;
      const inp = document.createElement("input");
      Object.assign(inp, attrs);
      inp.addEventListener("change", () => {
        if (!this.aSel) return;
        const v = attrs.type === "number" ? Number(inp.value) : inp.value;
        if (attrs.type === "number" && !Number.isFinite(v)) return;
        this.updateAudioClip(this.aSel, { [key]: v });
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") { inp.blur(); this.root.focus({ preventScroll: true }); } });
      l.append(inp);
      insp.append(l);
      fields[key] = inp;
    };
    field("label", "", { className: "wide", placeholder: "label" });
    field("gain_db", "gain dB", { type: "number", step: 0.5, min: -60, max: 24 });
    field("fade_in", "fade in", { type: "number", step: 1, min: 0 });
    field("fade_out", "fade out", { type: "number", step: 1, min: 0 });
    field("track", "track", { type: "number", step: 1, min: 1 });
    const info = document.createElement("span");
    info.className = "ss-cut-ro";
    insp.append(info);
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.style.cssText = "background:#262b33;color:#cfd5de;border:1px solid #39404b;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit";
    del.addEventListener("click", (e) => { e.stopPropagation(); if (this.aSel) this.removeAudioClip(this.aSel); });
    insp.append(del);
    this.ins = { title, fields, info };

    // bin
    this.bin = document.createElement("div");
    this.bin.className = "ss-cut-bin";
    const help = document.createElement("div");
    help.className = "ss-cut-help";
    help.textContent =
      "Space play · J K L shuttle · ←/→ frame · ↑/↓ edit · I/O mark · G clear · B split · ⌫ ripple delete · X extract · ⌘Z undo · " +
      "drag a clip to reorder · drag its edge to trim (⌥ = roll the edit) · click a shot to splice it in at the playhead, ⇧-click to overwrite · " +
      "audio: drag to slide (up/down changes track), edges trim, top corners fade, [ / ] gain, M/S in the header mute/solo";

    root.append(vw, bar, bar2, tlw, insp, this.bin, help);
    container.appendChild(root);

    this._ro = new ResizeObserver(() => { if (this._fitPending) this.fit(); this.requestDraw(); });
    this._ro.observe(root);
  }

  _renderBin() {
    this.bin.textContent = "";
    const label = document.createElement("span");
    label.textContent = this.project.shots.length ? "Shots" : "No shots yet: frame setups on the Stage tab.";
    this.bin.append(label);
    for (const s of this.project.shots) {
      const chip = document.createElement("div");
      chip.className = "ss-cut-chip";
      const rung = TL.bestRung(s);
      chip.title = `${s.name}${s.scene_name ? ` · ${s.scene_name}` : ""}${s.setup ? ` · ${s.setup}` : ""} · ${s.frames} f · ${rung}\n` +
        "Click: splice in at the playhead · ⇧-click: overwrite · drag onto the track: insert";
      const dot = document.createElement("i");
      dot.style.background = RUNG_COLORS[rung];
      const name = document.createElement("span");
      name.textContent = s.name;
      const meta = document.createElement("small");
      meta.textContent = [s.setup, this._dur(s.frames)].filter(Boolean).join(" · ");
      chip.append(dot, name, meta);
      chip.addEventListener("pointerdown", (e) => this._chipDown(e, s.id));
      this.bin.append(chip);
    }
  }

  _updateButtons() {
    if (!this.b) return;
    const n = this.project.cut.length;
    face(this.b.play, this.speed ? "pause" : "play");
    this.b.play.setAttribute("aria-pressed", String(this.speed === 1));
    this.b.rev.setAttribute("aria-pressed", String(this.speed < 0));
    this.b.fwd.setAttribute("aria-pressed", String(this.speed > 1));
    face(this.b.rev, "rewind", this.speed < -1 ? `${-this.speed}×` : "");
    face(this.b.fwd, "fast-forward", this.speed > 1 ? `${this.speed}×` : "");
    this.b.loop.setAttribute("aria-pressed", String(this.loop));
    this.b.audio.setAttribute("aria-pressed", String(this.audio));
    this.b.action.setAttribute("aria-pressed", String(this.action));
    this.b.sync.setAttribute("aria-pressed", String(this.syncLock));
    this.b.undo.disabled = !this.history.length;
    this.b.redo.disabled = !this.future.length;
    this.b.del.disabled = this.sel < 0 && !this.aSel && (this.marks.in == null || this.marks.out == null);
    this.b.extract.disabled = this.marks.in == null || this.marks.out == null;
    this.b.match.disabled = this.sel <= 0 || this.sel >= n;
    this.b.split.disabled = !n;
  }

  _download(suffix) {
    const files = this.exportFiles();
    const name = Object.keys(files).find((k) => k.endsWith(suffix));
    let body = files[name];
    if (suffix.endsWith("_avid_locators.txt")) body = Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff); // Latin-1
    const blob = new Blob([body], { type: suffix.endsWith(".otio") ? "application/json" : "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ edits

  /** One undoable edit: a new cut, plus audio / audio_tracks when they change. */
  _commit(cut, sel = this.sel, { audio, audio_tracks } = {}) {
    this.history.push(this._snapshot());
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.project = { ...this.project, cut, ...(audio ? { audio } : {}), ...(audio_tracks ? { audio_tracks } : {}) };
    this.sel = sel;
    this._afterEdit();
  }

  /** Audio after a picture ripple at record frame `at` by `delta` frames (unchanged with sync lock off). */
  _ripple(at, delta, audio = this.project.audio) {
    return this.syncLock && delta ? TL.rippleAudio(audio, at, delta) : audio;
  }

  _afterEdit() {
    this.sel = Math.min(this.sel, this.project.cut.length - 1);
    if (this.aSel && !this.project.audio.some((a) => a.id === this.aSel)) this.aSel = null;
    this.frame = Math.min(this.frame, Math.max(0, this.seqLen - 1));
    if (this.speed === 1) this._audioStart(this.frame);
    this._applyTrackGains();
    this._inspect();
    this._clampScroll();
    this._updateButtons();
    this.requestDraw();
    this._emit();
  }

  _emit() {
    try {
      this._onChange(this.getProject());
    } catch (err) {
      console.error("Soundstage Cut: onChange failed", err);
    }
  }

  // ------------------------------------------------------------------ media

  _syncMedia() {
    const want = new Set();
    for (const s of this.project.shots) {
      for (const rung of ["final", "draft", "look"]) {
        const url = s.renders[rung];
        if (!url) continue;
        want.add(url);
        if (this.media.has(url)) continue;
        if (rung === "look") {
          const img = new Image();
          const m = { kind: "image", el: img, ok: null };
          img.onload = () => { m.ok = true; this.thumbs.clear(); this.requestDraw(); };
          img.onerror = () => { m.ok = false; this.requestDraw(); };
          img.src = url;
          this.media.set(url, m);
        } else {
          const v = document.createElement("video");
          const m = { kind: "video", el: v, ok: null };
          v.muted = true;
          v.preload = "auto";
          v.playsInline = true;
          v.addEventListener("loadeddata", () => { m.ok = true; this.requestDraw(); });
          // Servers without HTTP Range support make the video unseekable: reload it from memory.
          v.addEventListener("loadedmetadata", () => {
            const sk = v.seekable;
            if (m.blob || (sk.length && sk.end(sk.length - 1) >= v.duration - 0.05)) return;
            m.blob = "pending";
            fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(r.status))).then((b) => {
              if (this.media.get(url) !== m) return;
              m.blob = URL.createObjectURL(b);
              v.src = m.blob;
            }).catch(() => {});
          });
          v.addEventListener("seeked", () => this.requestDraw());
          // A seek asked for before the data arrived can land on 0: look again once it has.
          v.addEventListener("canplaythrough", () => { if (!this.speed) this.requestDraw(); });
          v.addEventListener("error", () => { m.ok = false; this.requestDraw(); });
          v.src = url;
          this.media.set(url, m);
        }
      }
    }
    for (const [url, m] of this.media) {
      if (want.has(url)) continue;
      this._release(m);
      this.media.delete(url);
    }
  }

  _release(m) {
    if (m.kind !== "video") return;
    m.el.pause();
    m.el.removeAttribute("src");
    m.el.load();
    if (m.blob && m.blob !== "pending") URL.revokeObjectURL(m.blob);
  }

  /** What actually plays for a shot: best rung whose media loaded, falling back down the ladder. */
  _source(shot) {
    for (const rung of ["final", "draft", "look"]) {
      const url = shot.renders[rung];
      const m = url && this.media.get(url);
      if (m && m.ok !== false) return { rung, kind: m.kind, m };
    }
    return { rung: "clay", kind: "clay", m: null };
  }

  _clay(shot, f) {
    if (this._renderPreviewFrame) {
      try {
        const c = this._renderPreviewFrame(shot.id, f);
        if (c) return c;
      } catch (err) {
        if (!this._clayWarned) { this._clayWarned = true; console.warn("Soundstage Cut: renderPreviewFrame failed", err); }
      }
    }
    // No stage: a slate card.
    const c = (this._slate ||= document.createElement("canvas"));
    c.width = 480; c.height = 270;
    const g = c.getContext("2d");
    g.fillStyle = "#262b33"; g.fillRect(0, 0, 480, 270);
    g.fillStyle = "#cfd5de"; g.font = "600 28px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.textAlign = "center";
    g.fillText(shot.name, 240, 125);
    g.font = "16px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif"; g.fillStyle = "#8b94a1";
    g.fillText([shot.scene_name, shot.setup, `f ${f}`].filter(Boolean).join(" · "), 240, 155);
    return c;
  }

  /** Frame `f` of a shot as a drawable, driving its <video> for realtime play or a paused seek. */
  _frameOf(shot, f, { realtime = false } = {}) {
    const s = this._source(shot);
    if (s.kind === "image") return s.m.ok ? s.m.el : null;
    if (s.kind === "clay") return this._clay(shot, f);
    const v = s.m.el;
    const want = (f + 0.5) / this.rate;
    if (realtime) {
      if (this._activeVideo && this._activeVideo !== v) this._activeVideo.pause();
      this._activeVideo = v;
      v.playbackRate = this.speed;
      v.muted = !(this.audio && this.speed === 1);
      const drift = Math.abs(v.currentTime - want) * this.rate;
      if ((v.paused || drift > 3) && !v.seeking && drift > 0.5) v.currentTime = want;
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - want) * this.rate > 0.5) v.currentTime = want;
    }
    return v.readyState >= 2 ? v : null;
  }

  // ------------------------------------------------------------------ audio engine

  /** URL the browser can fetch for a clip: its url, else a relative path (absolute server paths can't play here). */
  _audioUrl(a) {
    if (a.url) return a.url;
    if (a.path && !a.path.startsWith("/")) return a.path;
    return "";
  }

  _ctx() {
    if (!this._ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this._ac = new AC({ sampleRate: 48000 });
    }
    return this._ac;
  }

  /** Fetch + decode every clip's audio once; fill in out/frames for clips whose length was unknown. */
  _syncAudio() {
    for (const a of this.project.audio) {
      const url = this._audioUrl(a);
      if (!url) continue;
      const have = this.abufs.get(url);
      if (have) {
        if (have.state === "ready" && (a.out == null || a.frames == null)) this._fillLengths(url, have.buffer.duration);
        continue;
      }
      const entry = { state: "loading", buffer: null, peaks: null, error: null };
      this.abufs.set(url, entry);
      const ac = this._ctx();
      if (!ac) { entry.state = "error"; entry.error = "no WebAudio"; continue; }
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((buf) => ac.decodeAudioData(buf))
        .then((buffer) => {
          entry.buffer = buffer;
          entry.state = "ready";
          entry.peaks = peaksOf(buffer);
          this._fillLengths(url, buffer.duration);
          if (this.speed === 1) this._audioStart(this.frame);
          this.requestDraw();
        })
        .catch((err) => { entry.state = "error"; entry.error = String(err.message || err); this.requestDraw(); });
    }
  }

  _fillLengths(url, seconds) {
    const frames = Math.max(1, Math.floor(seconds * this.rate));
    let changed = false;
    const audio = this.project.audio.map((a) => {
      if (this._audioUrl(a) !== url || (a.frames != null && a.out != null)) return a;
      changed = true;
      return { ...a, frames: a.frames ?? frames, out: a.out ?? frames };
    });
    if (!changed) return;
    this.project = { ...this.project, audio: TL.normalizeAudio(audio, this.project.fps) };
    this._inspect();
    this._emit();
  }

  _trackGain(t) {
    const ac = this._ac;
    this._tgains ||= new Map();
    if (!this._tgains.has(t)) {
      const g = ac.createGain();
      g.connect(this._master);
      this._tgains.set(t, g);
    }
    return this._tgains.get(t);
  }

  _applyTrackGains() {
    if (!this._tgains) return;
    for (const [t, g] of this._tgains) g.gain.value = TL.audible(this.project, t) ? 1 : 0;
  }

  /** (Re)start every audio clip from record frame `from`, scheduled sample-accurately on the WebAudio clock. */
  _audioStart(from) {
    this._audioStop();
    const ac = this._ctx();
    if (!ac || !this.project.audio.length) return;
    if (ac.state === "suspended") ac.resume().catch(() => {});
    if (!this._master) { this._master = ac.createGain(); this._master.connect(ac.destination); }
    const t0 = ac.currentTime + 0.05;
    this._aClock = { t0, from, wall0: performance.now() };
    for (const a of this.project.audio) {
      const entry = this.abufs.get(this._audioUrl(a));
      if (!entry || !entry.buffer || a.out == null) continue;
      const len = a.out - a.in;
      if (a.start_frame + len <= from) continue;
      const off = Math.max(0, from - a.start_frame);
      const when = t0 + Math.max(0, a.start_frame - from) / this.rate;
      const src = ac.createBufferSource();
      src.buffer = entry.buffer;
      const g = ac.createGain();
      scheduleEnvelope(g.gain, a, off, when, this.rate);
      src.connect(g).connect(this._trackGain(a.track));
      try { src.start(when, (a.in + off) / this.rate, (len - off) / this.rate); } catch { continue; }
      this._voices.push(src);
    }
    this._applyTrackGains();
  }

  _audioStop() {
    for (const v of this._voices) { try { v.stop(); v.disconnect(); } catch { /* already stopped */ } }
    this._voices = [];
    this._aClock = null;
  }

  // ------------------------------------------------------------------ inspector (selected audio clip)

  _inspect() {
    const box = this.insp;
    if (!box) return;
    const a = this.aSel && this.project.audio.find((x) => x.id === this.aSel);
    box.hidden = !a;
    if (!a) return;
    const entry = this.abufs.get(this._audioUrl(a));
    this.ins.title.textContent = `A${a.track}`;
    for (const [k, el] of Object.entries(this.ins.fields)) {
      if (document.activeElement === el) continue;
      const v = a[k];
      el.value = v == null ? "" : String(v);
    }
    const len = a.out == null ? "?" : this._dur(a.out - a.in);
    const st = !entry ? (this._audioUrl(a) ? "" : "  (server path: plays in the export, not here)") : entry.state === "error" ? `  (can't load: ${entry.error})` : entry.state === "loading" ? "  (loading)" : "";
    this.ins.info.textContent = `${len} at ${framesToTC(recordStart(this.fi.base) + a.start_frame, this.fi.base)}${st}`;
  }

  // ------------------------------------------------------------------ playback

  _playStart() {
    return this.marks.in != null && this.marks.out != null ? this.marks.in : 0;
  }

  _playEnd() {
    return this.marks.in != null && this.marks.out != null && this.loop ? this.marks.out : this.seqLen;
  }

  _advance(dt) {
    let f = this.frame + this.speed * this.rate * dt;
    // While WebAudio is playing, its clock is the master: the picture follows the sound.
    // (Unless that clock is stuck, e.g. no output device: then wall time drives as usual.)
    const ac = this._ac, ck = this._aClock;
    if (ck && this.speed === 1 && ac && ac.state === "running" && !ck.stuck) {
      const wall = (performance.now() - ck.wall0) / 1000 - 0.05;
      const audioT = ac.currentTime - ck.t0;
      if (wall > 0.3 && audioT < wall - 0.25) { ck.stuck = true; f = ck.from + wall * this.rate; }
      else f = ck.from + Math.max(0, audioT) * this.rate;
    }
    const end = this._playEnd(), start = this.loop ? this._playStart() : 0;
    if (f >= end) {
      if (this.loop) { f = start + ((f - start) % Math.max(1, end - start)); if (this.speed === 1) this._audioStart(f); }
      else { f = Math.max(0, this.seqLen - 1); this.stop(); }
    } else if (f < start) {
      if (this.loop) f = end - 1;
      else { f = 0; this.stop(); }
    }
    this.frame = f;
    this._follow();
    // Pre-roll: park the next clip's video on its in point just before the edit.
    if (this.speed > 0) {
      const row = TL.eventAt(this.project, Math.floor(f));
      const next = row && TL.layout(this.project)[row.index + 1];
      if (next && row.recOut - f < 12) {
        const s = this._source(next.shot);
        if (s.kind === "video" && s.m.el !== this._activeVideo) {
          const v = s.m.el, want = (next.in + 0.5) / this.rate;
          if (v.paused && !v.seeking && Math.abs(v.currentTime - want) * this.rate > 0.5) v.currentTime = want;
        }
      }
    }
  }

  _follow() {
    const w = this.tl.clientWidth - HEADER_W;
    if (w <= 0) return;
    const x = this.frame * this.ppf - this.scrollX;
    if (x > w - 24 || x < 0) {
      this.scrollX = this.frame * this.ppf - (this.speed ? 24 : w / 2);
      this._clampScroll();
    }
  }

  requestDraw() {
    if (!this._raf) this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  _tick(now) {
    this._raf = 0;
    if (this.speed) {
      const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 0;
      this._last = now;
      this._advance(dt);
    } else this._last = 0;
    this._drawViewer();
    this._drawTimeline();
    this._readouts();
    if (this.speed) this.requestDraw();
  }

  // ------------------------------------------------------------------ viewer

  _drawViewer() {
    const p = this.project;
    const W = 960, H = Math.round((960 * p.height) / p.width);
    for (const c of [this.viewer, this.pic]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = this.vctx, pc = this.pctx;
    const f = Math.floor(this.frame);
    const d = this._drag;

    // Trim / roll: two-up of the outgoing and incoming frames, like a trim monitor.
    if (d && (d.mode === "trimIn" || d.mode === "trimOut" || d.mode === "roll") && d.edit > 0 && d.edit < p.cut.length) {
      const rows = TL.layout(p);
      const a = rows[d.edit - 1], b = rows[d.edit];
      pc.fillStyle = "#0d1117"; pc.fillRect(0, 0, W, H);
      const ia = this._frameOf(a.shot, a.out - 1), ib = this._frameOf(b.shot, b.in);
      if (ia) drawContain(pc, ia, 0, 0, W / 2 - 2, H);
      if (ib) drawContain(pc, ib, W / 2 + 2, 0, W / 2 - 2, H);
      ctx.drawImage(this.pic, 0, 0);
      this._label(ctx, `${a.shot.name}  OUT ${framesToTC(a.out - 1, this.fi.base)}`, 10, 22, "left");
      this._label(ctx, `${b.shot.name}  IN ${framesToTC(b.in, this.fi.base)}`, W - 10, 22, "right");
      const matched = TL.actionMatchIn(a.shot, a.out, b.shot) === b.in;
      if (a.shot.scene_name && a.shot.scene_name === b.shot.scene_name && a.shot.id !== b.shot.id) {
        this._label(ctx, matched ? "ON ACTION" : "ACTION JUMP " + this._signed(b.in - (TL.actionMatchIn(a.shot, a.out, b.shot) ?? b.in)),
          W / 2, H - 14, "center", matched ? "#4fc27f" : ACCENT);
      }
      return;
    }

    const row = TL.eventAt(p, f);
    if (!row) {
      this._activeVideo?.pause();
      pc.fillStyle = "#0d1117"; pc.fillRect(0, 0, W, H);
      ctx.drawImage(this.pic, 0, 0);
      this._label(ctx, p.cut.length ? "End of sequence" : p.shots.length ? "Empty cut: click a shot below to add it" : "No shots yet", W / 2, H / 2, "center");
      return;
    }
    const src = row.in + (f - row.recIn);
    const realtime = this.speed > 0 && this.speed <= 4;
    const playing = this._source(row.shot);
    if (this._activeVideo && (!realtime || playing.kind !== "video")) { this._activeVideo.pause(); this._activeVideo = null; }
    const img = this._frameOf(row.shot, src, { realtime });
    if (img) {
      pc.fillStyle = "#0d1117"; pc.fillRect(0, 0, W, H);
      drawContain(pc, img, 0, 0, W, H);
    }
    ctx.drawImage(this.pic, 0, 0);

    // burn-in
    const s = row.shot;
    const rung = playing.rung;
    this._label(ctx, s.name + (s.setup ? `  ·  ${s.setup}` : ""), 10, 22, "left");
    if (s.scene_name) this._label(ctx, s.scene_name, 10, 44, "left", "#9aa3af");
    this._badge(ctx, rung.toUpperCase(), RUNG_COLORS[rung], W - 10, 10);
    this._label(ctx, framesToTC(recordStart(this.fi.base) + f, this.fi.base), 10, H - 12, "left");
    this._label(ctx, `src ${src}/${s.frames}`, W - 10, H - 12, "right", "#9aa3af");
    if (this.speed && this.speed !== 1) this._label(ctx, (this.speed > 0 ? "▶▶ " : "◀◀ ") + Math.abs(this.speed) + "×", W / 2, 22, "center", ACCENT);
  }

  _label(ctx, text, x, y, align, color = "#e9edf2") {
    ctx.font = "600 16px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,.65)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  _badge(ctx, text, color, right, top) {
    ctx.font = "700 12px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    const w = ctx.measureText(text).width + 14;
    roundRect(ctx, right - w, top, w, 20, 4);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, right - w / 2, top + 10.5);
  }

  _readouts() {
    const base = this.fi.base, start = recordStart(base);
    const f = Math.floor(this.frame);
    this.tcEl.textContent = framesToTC(start + f, base);
    const { in: a, out: b } = this.marks;
    const tc = (v) => (v == null ? "--:--:--:--" : framesToTC(start + v, base));
    const dur = a != null && b != null ? framesToTC(b - a, base) : "--:--:--:--";
    const text = `IN ${tc(a)}  OUT ${tc(b == null ? null : b - 1)}  DUR ${dur}  ·  SEQ ${framesToTC(this.total, base)}  ${this.project.cut.length} clips`;
    if (this.markEl.textContent !== text) this.markEl.textContent = text;
  }

  _dur(frames) {
    const b = this.fi?.base || 24;
    return `${Math.floor(frames / b)}:${String(frames % b).padStart(2, "0")}`;
  }

  _signed(n) {
    return (n > 0 ? "+" : "") + n + "f";
  }

  // ------------------------------------------------------------------ timeline drawing

  _x(f) {
    return HEADER_W + f * this.ppf - this.scrollX;
  }

  get _tlH() {
    return A_Y + TL.audioTrackCount(this.project) * (A_H + A_GAP) + 6;
  }

  _trackTop(t) {
    return A_Y + (t - 1) * (A_H + A_GAP);
  }

  _clampScroll() {
    const w = (this.tl.clientWidth || 1) - HEADER_W;
    this.scrollX = TL.clamp(this.scrollX, 0, Math.max(0, TL.sequenceFrames(this.project) * this.ppf - w + 40));
  }

  _thumb(shot, f) {
    const s = this._source(shot);
    if (s.kind === "image" && s.m.ok) return s.m.el;
    // A rendered shot (draft / final video) shows its chosen frame, so the timeline reads like an editor's filmstrip.
    const look = shot.renders?.look && this.media.get(shot.renders.look);
    if (look?.ok) return look.el;
    if (s.kind !== "clay" || !this._renderPreviewFrame) return null;
    const key = `${shot.id}:${f}`;
    if (this.thumbs.has(key)) return this.thumbs.get(key);
    if (this.speed || this._thumbBudget <= 0) return null;
    this._thumbBudget--;
    let c = null;
    try {
      const src = this._renderPreviewFrame(shot.id, f);
      if (src) {
        c = document.createElement("canvas");
        c.width = 112; c.height = 63;
        drawContain(c.getContext("2d"), src, 0, 0, 112, 63);
      }
    } catch { /* thumbnails are best effort */ }
    this.thumbs.set(key, c);
    return c;
  }

  _drawTimeline() {
    const c = this.tl, w = c.clientWidth;
    if (!w) return;
    const TL_H = this._tlH;
    if (c.style.height !== TL_H + "px") c.style.height = TL_H + "px";
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(TL_H * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(TL_H * dpr);
    }
    const ctx = this.tctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, TL_H);
    const p = this.project, base = this.fi.base, start = recordStart(base);
    const total = this.total;
    const rows = TL.layout(p);
    const d = this._drag;
    this._thumbBudget = 2;

    // ruler
    ctx.fillStyle = "#14171c";
    ctx.fillRect(0, 0, w, RULER_H);
    const steps = [1, 2, 4, 6, 12, 24, 48, 72, 120, 240, 480, 720, 1440, 2880, 7200, 14400, 43200];
    const major = steps.find((s) => s * this.ppf >= 84) || steps[steps.length - 1];
    const minor = [...steps].reverse().find((s) => s < major && major % s === 0 && s * this.ppf >= 7) || major;
    const f0 = Math.max(0, Math.floor(this.scrollX / this.ppf / minor) * minor);
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (let f = f0; this._x(f) < w; f += minor) {
      const x = Math.round(this._x(f)) + 0.5, isMajor = f % major === 0;
      ctx.strokeStyle = isMajor ? "#59616d" : "#363c45";
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 9 : 15);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = "#8b94a1";
        ctx.fillText(framesToTC(start + f, base), x + 3, 2);
      }
    }

    // track
    ctx.fillStyle = "#1f242b";
    ctx.fillRect(0, TRACK_Y, w, TRACK_H);
    if (total) {
      ctx.fillStyle = "#15181d";
      const xe = this._x(total);
      if (xe < w) ctx.fillRect(xe, TRACK_Y, w - xe, TRACK_H);
    }

    // audio tracks
    const nTracks = TL.audioTrackCount(p);
    for (let t = 1; t <= nTracks; t++) {
      const y = this._trackTop(t);
      ctx.fillStyle = d && d.mode === "aslide" && d.track === t ? "#232a30" : "#1c2025";
      ctx.fillRect(0, y, w, A_H);
    }
    for (const a of p.audio) {
      if (a.track > nTracks) continue;
      const x0 = this._x(a.start_frame), x1 = this._x(a.start_frame + Math.max(1, TL.audioLen(a) || 24));
      if (x1 < HEADER_W || x0 > w) continue;
      this._drawAudioClip(ctx, a, x0, x1, this._trackTop(a.track));
    }

    // marks
    const { in: mi, out: mo } = this.marks;
    if (mi != null || mo != null) {
      const xa = this._x(mi ?? 0), xb = this._x(mo ?? total);
      ctx.fillStyle = "rgba(227,154,64,.13)";
      ctx.fillRect(xa, 0, xb - xa, TL_H);
      ctx.fillStyle = ACCENT;
      if (mi != null) { ctx.fillRect(xa, 0, 2, RULER_H); ctx.fillText("I", xa + 4, 11); }
      if (mo != null) { ctx.fillRect(xb - 2, 0, 2, RULER_H); ctx.textAlign = "right"; ctx.fillText("O", xb - 4, 11); ctx.textAlign = "left"; }
    }

    // clips
    for (const r of rows) {
      const x0 = this._x(r.recIn), x1 = this._x(r.recOut);
      if (x1 < 0 || x0 > w) continue;
      this._drawClip(ctx, r, x0, x1, d && d.mode === "move" && d.idx === r.index ? 0.35 : 1);
    }

    // edit points: cut-on-action status between setups of one scene, through-edits
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k];
      const x = Math.round(this._x(b.recIn));
      if (x < -8 || x > w + 8) continue;
      if (a.shot.id === b.shot.id && a.out === b.in) {
        ctx.strokeStyle = "rgba(255,255,255,.45)";
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x + 0.5, TRACK_Y + 2); ctx.lineTo(x + 0.5, TRACK_Y + TRACK_H - 2); ctx.stroke();
        ctx.setLineDash([]);
      } else if (a.shot.scene_name && a.shot.scene_name === b.shot.scene_name && a.shot.id !== b.shot.id) {
        const on = TL.actionMatchIn(a.shot, a.out, b.shot) === b.in;
        ctx.fillStyle = on ? "#4fc27f" : ACCENT;
        ctx.beginPath();
        const y = TRACK_Y + TRACK_H - 1;
        ctx.moveTo(x, y - 9); ctx.lineTo(x + 5, y - 4); ctx.lineTo(x, y + 1); ctx.lineTo(x - 5, y - 4);
        ctx.closePath(); ctx.fill();
      }
    }

    // trim highlight
    if (d && (d.mode === "trimIn" || d.mode === "trimOut" || d.mode === "roll")) {
      const r = rows[d.mode === "trimOut" ? d.idx : d.idx];
      if (r) {
        const x = Math.round(this._x(d.mode === "trimOut" ? r.recOut : r.recIn));
        ctx.fillStyle = d.mode === "roll" ? "#ffd27a" : ACCENT;
        ctx.fillRect(x - (d.mode === "trimOut" ? 3 : d.mode === "roll" ? 1.5 : 0), TRACK_Y - 2, 3, TRACK_H + 4);
      }
    }

    // insertion indicator (dragging a clip or a shot from the bin)
    if (d && d.target != null && (d.mode === "move" || d.mode === "bin")) {
      const pts = TL.editPoints(p);
      const x = Math.round(this._x(pts[d.target]));
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 1, TRACK_Y - 4, 2, TRACK_H + 8);
      ctx.beginPath(); ctx.moveTo(x - 5, TRACK_Y - 4); ctx.lineTo(x + 5, TRACK_Y - 4); ctx.lineTo(x, TRACK_Y + 1); ctx.fill();
      if (d.mode === "move") {
        const r = rows[d.idx];
        const gw = Math.max(16, r.len * this.ppf);
        ctx.globalAlpha = 0.85;
        this._drawClip(ctx, r, d.x - d.grab, d.x - d.grab + gw, 1, true);
        ctx.globalAlpha = 1;
      }
    }

    // playhead
    if (this.seqLen) {
      const x = Math.round(this._x(Math.floor(this.frame))) + 0.5;
      if (x >= -6 && x <= w + 6) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, TL_H); ctx.stroke();
        ctx.fillStyle = ACCENT;
        ctx.beginPath(); ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x + 6, 6); ctx.lineTo(x, 12); ctx.lineTo(x - 6, 6); ctx.fill();
      }
    }

    // scroll indicator
    const vw = w - HEADER_W;
    const span = Math.max(1, this.seqLen * this.ppf);
    if (span > vw) {
      ctx.fillStyle = "#39404b";
      ctx.fillRect(HEADER_W + (this.scrollX / span) * vw, TL_H - 4, Math.max(20, (vw / span) * vw), 3);
    }

    // track headers (drawn last: they cover anything scrolled under them)
    ctx.fillStyle = "#181b20";
    ctx.fillRect(0, 0, HEADER_W, TL_H);
    ctx.fillStyle = "#2a3038";
    ctx.fillRect(HEADER_W - 1, 0, 1, TL_H);
    ctx.font = "600 11px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#cfd5de";
    ctx.fillText("V1", 8, TRACK_Y + TRACK_H / 2);
    for (let t = 1; t <= nTracks; t++) {
      const y = this._trackTop(t), st = TL.trackState(p, t), heard = TL.audible(p, t);
      ctx.fillStyle = heard ? "#cfd5de" : "#6b737e";
      ctx.font = "600 11px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("A" + t, 8, y + A_H / 2);
      for (const [label, on, x, col] of [["M", st.mute, HEADER_W - 36, "#d9534f"], ["S", st.solo, HEADER_W - 19, "#e6c34a"]]) {
        roundRect(ctx, x, y + (A_H - 14) / 2, 15, 14, 3);
        ctx.fillStyle = on ? col : "#262b33";
        ctx.fill();
        ctx.fillStyle = on ? "#16191e" : "#8b94a1";
        ctx.font = "700 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, x + 7.5, y + A_H / 2 + 0.5);
      }
    }
  }

  _drawAudioClip(ctx, a, x0, x1, top) {
    const heard = TL.audible(this.project, a.track);
    const sel = a.id === this.aSel;
    const y = top + 2, h = A_H - 4, cw = Math.max(2, x1 - x0 - 1);
    const len = TL.audioLen(a);
    const entry = this.abufs.get(this._audioUrl(a));
    ctx.save();
    ctx.globalAlpha = heard ? 1 : 0.45;
    roundRect(ctx, x0 + 0.5, y, cw, h, 3);
    ctx.fillStyle = AUDIO_COLOR;
    ctx.fill();
    ctx.clip();
    // waveform (gain and fades applied, so what you see is what you hear)
    if (entry && entry.peaks && len) {
      const g = Math.pow(10, a.gain_db / 20), mid = y + h / 2 + 4, amp = (h - 12) / 2;
      const spp = entry.buffer.sampleRate / this.rate; // samples per frame
      ctx.fillStyle = "rgba(205,240,228,.75)";
      const xa = Math.max(Math.floor(x0), HEADER_W), xb = Math.min(Math.ceil(x0 + cw), this.tl.clientWidth);
      for (let x = xa; x < xb; x++) {
        const f0 = (x - x0) / this.ppf, f1 = (x + 1 - x0) / this.ppf; // clip-local frames
        const b0 = Math.floor(((a.in + f0) * spp) / PEAK_BLOCK), b1 = Math.max(b0 + 1, Math.ceil(((a.in + f1) * spp) / PEAK_BLOCK));
        let m = 0;
        for (let b = b0; b < b1 && b < entry.peaks.length; b++) if (entry.peaks[b] > m) m = entry.peaks[b];
        const env = Math.min(1, a.fade_in ? f0 / a.fade_in : 1, a.fade_out ? (len - f0) / a.fade_out : 1);
        const v = Math.min(1, m * g * Math.max(0, env)) * amp;
        ctx.fillRect(x, mid - v, 1, Math.max(1, 2 * v));
      }
    } else if (entry && entry.state === "error") {
      ctx.fillStyle = "rgba(255,120,100,.8)";
      ctx.font = "10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("can't load", x0 + 6, y + h / 2 + 5);
    }
    // fades: shaded corners + handles
    ctx.fillStyle = "rgba(0,0,0,.35)";
    const fx = (f) => x0 + f * this.ppf;
    if (a.fade_in) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(fx(a.fade_in), y); ctx.lineTo(x0, y + h); ctx.fill(); }
    if (a.fade_out) { ctx.beginPath(); ctx.moveTo(fx(len), y); ctx.lineTo(fx(len - a.fade_out), y); ctx.lineTo(fx(len), y + h); ctx.fill(); }
    ctx.fillStyle = "#fff";
    ctx.font = "600 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    if (cw > 30) ctx.fillText(a.label, x0 + Math.max(6, a.fade_in * this.ppf + 2), y + 2);
    if (a.gain_db && cw > 90) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,.8)";
      ctx.fillText((a.gain_db > 0 ? "+" : "") + a.gain_db.toFixed(1) + " dB", x0 + cw - 6 - a.fade_out * this.ppf, y + 2);
    }
    ctx.restore();
    if (cw > 16) {
      ctx.fillStyle = "#e8f6f1";
      ctx.fillRect(fx(a.fade_in) - 3, y, 6, 5);
      ctx.fillRect(fx(len - a.fade_out) - 3, y, 6, 5);
    }
    roundRect(ctx, x0 + 0.5, y, cw, h, 3);
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = sel ? ACCENT : "rgba(0,0,0,.5)";
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  _drawClip(ctx, r, x0, x1, alpha, ghost = false) {
    const rung = TL.bestRung(r.shot);
    const y = TRACK_Y + 3, h = TRACK_H - 6;
    const cw = Math.max(2, x1 - x0 - 1);
    ctx.save();
    ctx.globalAlpha *= alpha;
    roundRect(ctx, x0 + 0.5, y, cw, h, 4);
    ctx.fillStyle = RUNG_COLORS[rung];
    ctx.fill();
    ctx.clip();
    // darker lower band for text legibility
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.fillRect(x0, y + h - 18, cw + 1, 18);
    let tx = x0 + 6;
    if (cw > 70) {
      const th = this._thumb(r.shot, r.in);
      if (th) {
        const tw = Math.min(h * 16 / 9, cw * 0.4);
        ctx.fillStyle = "#0d1117";
        ctx.fillRect(x0 + 1, y, tw, h);
        drawContain(ctx, th, x0 + 1, y, tw, h);
        tx = x0 + tw + 6;
      }
    }
    if (cw > 24) {
      ctx.fillStyle = "#fff";
      ctx.font = "600 11px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(r.shot.name, tx, y + 5);
      const nameW = ctx.measureText(r.shot.name).width;
      ctx.font = "10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.75)";
      if (r.shot.setup) ctx.fillText(r.shot.setup, tx, y + 19);
      ctx.fillText(`${this._dur(r.len)}  [${r.in}-${r.out - 1}]`, tx, y + h - 14);
      // rung badge
      ctx.font = "700 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      const label = rung.toUpperCase();
      const bw = ctx.measureText(label).width + 8;
      if (cw - (tx - x0) > nameW + bw + 14) {
        roundRect(ctx, x0 + cw - bw - 4, y + 4, bw, 13, 3);
        ctx.fillStyle = "rgba(0,0,0,.35)";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(label, x0 + cw - bw / 2 - 4, y + 6.5);
      }
      if (r.shot.notes || r.event.notes) {
        ctx.fillStyle = "#ffd27a";
        ctx.beginPath(); ctx.arc(x0 + cw - 8, y + h - 9, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    const selected = !ghost && r.index === this.sel;
    roundRect(ctx, x0 + 0.5, y, cw, h, 4);
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? ACCENT : "rgba(0,0,0,.45)";
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  // ------------------------------------------------------------------ timeline interaction

  _local(e) {
    const r = this.tl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _frameAt(x) {
    return (x - HEADER_W + this.scrollX) / this.ppf;
  }

  /** Audio track number under y (1..n), 0 if none; n+1 just below the last track. */
  _trackAt(y) {
    if (y < A_Y) return 0;
    return Math.min(TL.audioTrackCount(this.project) + 1, Math.floor((y - A_Y) / (A_H + A_GAP)) + 1);
  }

  /**
   * {type: "ruler"|"empty"|"clip"|"edge"|"header"|"audio", idx, mode, edit, audio, track}.
   * Audio modes: aslide (body), atrimIn / atrimOut (edges), afadeIn / afadeOut (the top-corner handles).
   */
  _clipMenu(shotId, name, e) {
    this._menu?.remove();
    const m = (this._menu = document.createElement("div"));
    m.className = "ss-cut-ctx";
    m.style.cssText = "position:fixed;z-index:10000;min-width:240px;padding:6px;border-radius:12px;background:#221b28;" +
      "border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:2px;font:13px/1.3 inherit";
    const head = document.createElement("div");
    head.textContent = `Edit original: ${name}`;
    head.style.cssText = "font-size:11px;color:#a9a3ad;padding:4px 8px;text-transform:uppercase;letter-spacing:.05em";
    m.append(head);
    for (const [where, label] of [["stage", "Edit the shot on the Stage (blocking, camera)"], ["frame", "Repaint its frame (④ Frame)"],
      ["canvas", "Touch up its frame in Canvas"], ["motion", "Re-render its motion (⑤ Motion)"], ["review", "Compare on the Ladder (⑥ Review)"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "text-align:left;background:transparent;border:0;color:#f0efed;padding:7px 8px;border-radius:8px;cursor:pointer;font:inherit";
      b.addEventListener("pointerenter", () => (b.style.background = "rgba(242,255,89,.1)"));
      b.addEventListener("pointerleave", () => (b.style.background = "transparent"));
      b.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      b.addEventListener("click", () => { m.remove(); this._onEditShot(shotId, where); });
      m.append(b);
    }
    document.body.append(m);
    m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 8) + "px";
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); removeEventListener("pointerdown", close, true); } };
    setTimeout(() => addEventListener("pointerdown", close, true), 0);
  }

  _hit(x, y) {
    if (y < RULER_H) return { type: "ruler" };
    if (x < HEADER_W) {
      const t = this._trackAt(y);
      if (t >= 1 && t <= TL.audioTrackCount(this.project)) {
        const top = this._trackTop(t);
        const inBtn = y >= top + (A_H - 14) / 2 - 2 && y <= top + (A_H + 14) / 2 + 2;
        if (inBtn && x >= HEADER_W - 37 && x < HEADER_W - 20) return { type: "header", track: t, button: "mute" };
        if (inBtn && x >= HEADER_W - 20) return { type: "header", track: t, button: "solo" };
      }
      return { type: "header" };
    }
    if (y >= A_Y) {
      const t = this._trackAt(y);
      if (t > TL.audioTrackCount(this.project)) return { type: "empty", track: t };
      const top = this._trackTop(t);
      const clips = this.project.audio.filter((a) => a.track === t);
      for (let i = clips.length - 1; i >= 0; i--) {
        const a = clips[i], len = Math.max(1, TL.audioLen(a) || 24);
        const x0 = this._x(a.start_frame), x1 = this._x(a.start_frame + len);
        if (x < x0 - EDGE_PX || x > x1 + EDGE_PX) continue;
        if (y <= top + 9) {
          if (Math.abs(x - this._x(a.start_frame + a.fade_in)) <= 5) return { type: "audio", audio: a, mode: "afadeIn", track: t };
          if (Math.abs(x - this._x(a.start_frame + len - a.fade_out)) <= 5) return { type: "audio", audio: a, mode: "afadeOut", track: t };
        }
        if (Math.abs(x - x0) <= EDGE_PX) return { type: "audio", audio: a, mode: "atrimIn", track: t };
        if (Math.abs(x - x1) <= EDGE_PX) return { type: "audio", audio: a, mode: "atrimOut", track: t };
        if (x >= x0 && x <= x1) return { type: "audio", audio: a, mode: "aslide", track: t };
      }
      return { type: "empty", track: t };
    }
    if (y < TRACK_Y || y > TRACK_Y + TRACK_H) return { type: "empty" };
    const rows = TL.layout(this.project);
    for (let k = 0; k <= rows.length; k++) {
      const pt = k < rows.length ? rows[k].recIn : rows[rows.length - 1]?.recOut;
      if (pt == null) break;
      const px = this._x(pt);
      if (Math.abs(x - px) <= EDGE_PX) {
        const left = rows[k - 1], right = rows[k];
        const useLeft = left && (x < px || !right);
        return { type: "edge", idx: useLeft ? k - 1 : k, mode: useLeft ? "trimOut" : "trimIn", edit: k };
      }
    }
    const f = this._frameAt(x);
    const row = rows.find((r) => f >= r.recIn && f < r.recOut);
    return row ? { type: "clip", idx: row.index } : { type: "empty" };
  }

  _tlDown(e) {
    e.stopPropagation();
    if (e.button !== 0) return;
    this.root.focus({ preventScroll: true });
    const { x, y } = this._local(e);
    const hit = this._hit(x, y);
    this.tl.setPointerCapture(e.pointerId);
    if (hit.type === "header") {
      if (hit.button) {
        const st = TL.trackState(this.project, hit.track);
        this.setTrack(hit.track, hit.button === "mute" ? { mute: !st.mute } : { solo: !st.solo });
      }
      return;
    }
    if (hit.type === "audio") {
      this.stop();
      this.sel = -1;
      this.aSel = hit.audio.id;
      this._inspect();
      this._drag = { mode: hit.mode === "aslide" ? "apending" : hit.mode, id: hit.audio.id, startX: x, startY: y,
                     base: this.project.audio, orig: { ...hit.audio }, track: hit.audio.track };
      this._updateButtons();
      this.requestDraw();
      return;
    }
    if (hit.type === "edge") {
      this.stop();
      const rows = TL.layout(this.project);
      const canRoll = hit.edit > 0 && hit.edit < rows.length;
      const mode = e.altKey && canRoll ? "roll" : hit.mode;
      this._drag = { mode, idx: mode === "roll" ? hit.edit : hit.idx, edit: hit.edit, startX: x, base: this.project.cut,
                     baseAudio: this.project.audio, delta: 0 };
      this.sel = -1;
      this.aSel = null;
    } else if (hit.type === "clip") {
      this.sel = hit.idx;
      this.aSel = null;
      const row = TL.layout(this.project)[hit.idx];
      this._drag = { mode: "pending", idx: hit.idx, startX: x, x, grab: x - this._x(row.recIn) };
    } else {
      this.stop();
      if (hit.type === "empty" && y >= TRACK_Y) { this.sel = -1; this.aSel = null; }
      this._drag = { mode: "scrub" };
      this.seek(this._frameAt(x));
    }
    this._inspect();
    this._updateButtons();
    this.requestDraw();
  }

  _tlMove(e) {
    e.stopPropagation();
    const { x, y } = this._local(e);
    const d = this._drag;
    if (!d) {
      const hit = this._hit(x, y);
      this.tl.style.cursor = hit.type === "edge" ? (e.altKey ? "col-resize" : "ew-resize") : hit.type === "clip" ? "grab"
        : hit.type === "audio" ? (hit.mode === "aslide" ? "grab" : "ew-resize") : hit.button ? "pointer" : "default";
      return;
    }
    if (d.mode === "apending" && Math.hypot(x - d.startX, y - d.startY) > 4) { d.mode = "aslide"; this.tl.style.cursor = "grabbing"; }
    if (d.mode.startsWith("a") && d.mode !== "apending") {
      const base = { ...this.project, audio: d.base };
      const df = Math.round((x - d.startX) / this.ppf);
      let audio;
      if (d.mode === "aslide") {
        d.track = Math.max(1, this._trackAt(y) || 1);
        audio = TL.moveAudio(base, d.id, this._snapAudio(d.orig, d.orig.start_frame + df), d.track);
      } else if (d.mode === "atrimIn" || d.mode === "atrimOut") {
        audio = TL.trimAudio(base, d.id, d.mode === "atrimIn" ? "in" : "out", df);
      } else {
        const len = TL.audioLen(d.orig);
        audio = TL.fadeAudio(base, d.id, d.mode === "afadeIn" ? "in" : "out", d.mode === "afadeIn" ? d.orig.fade_in + df : d.orig.fade_out - df);
        if (!len) audio = d.base;
      }
      this.project = { ...this.project, audio };
      this._inspect();
      this.requestDraw();
      return;
    }
    if (d.mode === "scrub") { this.seek(this._frameAt(x)); return; }
    if (d.mode === "pending" && Math.abs(x - d.startX) > 4) { d.mode = "move"; this.tl.style.cursor = "grabbing"; }
    if (d.mode === "move") {
      d.x = x;
      d.target = this._nearestEdit(x);
      if (d.target === d.idx || d.target === d.idx + 1) d.target = null;
      this.requestDraw();
      return;
    }
    if (d.mode === "trimIn" || d.mode === "trimOut" || d.mode === "roll") {
      const base = { ...this.project, cut: d.base };
      let delta = Math.round((x - d.startX) / this.ppf);
      delta = this._snapTrim(base, d, delta);
      d.delta = delta;
      const cut = d.mode === "roll" ? TL.roll(base, d.idx, delta) : d.mode === "trimIn" ? TL.trimIn(base, d.idx, delta) : TL.trimOut(base, d.idx, delta);
      // sync lock: whatever plays after the trimmed clip moves with its new end
      const oldRow = TL.layout(base)[d.mode === "roll" ? d.idx - 1 : d.idx];
      const change = TL.totalFrames({ ...base, cut }) - TL.totalFrames(base);
      const audio = d.mode === "roll" || !oldRow ? d.baseAudio : this._ripple(oldRow.recOut, change, d.baseAudio);
      this.project = { ...this.project, cut, audio };
      this.requestDraw();
    }
  }

  _tlUp(e) {
    e.stopPropagation();
    const d = this._drag;
    this._drag = null;
    this.tl.style.cursor = "default";
    if (!d) return;
    if (d.mode.startsWith("a")) {
      const audio = this.project.audio;
      this.project = { ...this.project, audio: d.base };
      if (d.mode !== "apending" && JSON.stringify(audio) !== JSON.stringify(d.base)) this._commit(this.project.cut, this.sel, { audio });
      this.requestDraw();
      return;
    }
    if (d.mode === "move" && d.target != null) {
      const cut = TL.moveEvent(this.project, d.idx, d.target, { action: this.action });
      const sel = d.target > d.idx ? d.target - 1 : d.target;
      this._commit(cut, sel, { audio: this._audioAfterMove(cut, d.idx, d.target) });
    } else if (d.mode === "trimIn" || d.mode === "trimOut" || d.mode === "roll") {
      const cut = this.project.cut, audio = this.project.audio;
      this.project = { ...this.project, cut: d.base, audio: d.baseAudio };
      if (JSON.stringify(cut) !== JSON.stringify(d.base)) {
        this._commit(cut, -1, { audio });
        // park the playhead on the edit so the result is easy to review
        const rows = TL.layout(this.project);
        const r = rows[d.mode === "trimOut" ? d.idx : d.idx];
        if (r) this.seek(d.mode === "trimOut" ? Math.max(r.recIn, r.recOut - 1) : r.recIn);
      }
    }
    this.requestDraw();
  }

  /** Sync lock for a reorder: audio rides with the clip it starts under. */
  _audioAfterMove(newCut, from, to) {
    return this.syncLock ? TL.audioAfterMove(this.project, newCut, from, to) : this.project.audio;
  }

  /** Snap an audio clip's start to edits, the playhead, marks and other clips' edges. */
  _snapAudio(a, start) {
    const tol = SNAP_PX / this.ppf, len = TL.audioLen(a);
    const pts = [...TL.editPoints(this.project), Math.floor(this.frame)];
    if (this.marks.in != null) pts.push(this.marks.in);
    for (const b of this.project.audio) if (b.id !== a.id) pts.push(b.start_frame, TL.audioEndFrame(b));
    let best = start, bd = tol + 1;
    for (const p of pts) {
      for (const cand of [p, p - len]) { const dd = Math.abs(cand - start); if (dd < bd && cand >= 0) { bd = dd; best = cand; } }
    }
    return Math.max(0, best);
  }

  _cancelDrag() {
    const d = this._drag;
    if (d && d.mode && d.mode.startsWith("a")) this.project = { ...this.project, audio: d.base };
    else if (d && d.base) this.project = { ...this.project, cut: d.base, ...(d.baseAudio ? { audio: d.baseAudio } : {}) };
    this._drag = null;
    this.requestDraw();
  }

  _nearestEdit(x) {
    const pts = TL.editPoints(this.project);
    let best = 0, bd = Infinity;
    pts.forEach((p, k) => { const dd = Math.abs(this._x(p) - x); if (dd < bd) { bd = dd; best = k; } });
    return best;
  }

  /** Snap a trim to the cut-on-action frame (same scene) or to the playhead. */
  _snapTrim(base, d, delta) {
    const rows = TL.layout(base);
    const tol = SNAP_PX / this.ppf;
    if (this.action && d.mode !== "roll" && d.edit > 0 && d.edit < rows.length) {
      const a = rows[d.edit - 1], b = rows[d.edit];
      if (a.shot.scene_name && a.shot.scene_name === b.shot.scene_name && a.shot.id !== b.shot.id) {
        const sa = TL.sceneFrame(a.shot, a.out), sb = TL.sceneFrame(b.shot, b.in);
        const target = d.mode === "trimOut" ? sb - sa : sa - sb;
        if (Math.abs(delta - target) <= tol) return target;
      }
    }
    if (d.mode === "trimOut" || d.mode === "roll") {
      const r = rows[d.mode === "roll" ? d.idx - 1 : d.idx];
      if (r) {
        const target = Math.floor(this.frame) - r.recOut;
        if (Math.abs(delta - target) <= tol) return target;
      }
    }
    return delta;
  }

  _onWheel(e) {
    const { x } = this._local(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scrollX += e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      this._clampScroll();
      this.requestDraw();
    } else {
      this.zoom(Math.exp(-e.deltaY * 0.0025), x);
    }
  }

  // drag a shot from the bin
  _chipDown(e, shotId) {
    e.stopPropagation();
    if (e.button !== 0) return;
    this.root.focus({ preventScroll: true });
    const sx = e.clientX, sy = e.clientY, shift = e.shiftKey;
    let moved = false;
    const over = (ev) => {
      const r = this.tl.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 12 && ev.clientY <= r.bottom + 12;
    };
    const move = (ev) => {
      ev.stopPropagation();
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) moved = true;
      if (!moved) return;
      this._drag = { mode: "bin", shotId, target: over(ev) ? this._nearestEdit(this._local(ev).x) : null };
      this.requestDraw();
    };
    const up = (ev) => {
      ev.stopPropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      const d = this._drag;
      this._drag = null;
      if (!moved) { shift ? this.overwriteShot(shotId) : this.spliceIn(shotId); return; }
      if (d && d.mode === "bin" && d.target != null) {
        const cut = TL.insertShot(this.project, shotId, d.target, { action: this.action });
        const at = TL.editPoints(this.project)[d.target];
        this._commit(cut, d.target, { audio: this._ripple(at, TL.totalFrames({ ...this.project, cut }) - this.total) });
        this.seek(TL.layout(this.project)[d.target].recIn);
      }
      this.requestDraw();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  // ------------------------------------------------------------------ keyboard

  _onKey(e) {
    e.stopPropagation();
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return; // typing in the inspector
    const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k;
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    if (mod) {
      if (lower === "z") e.shiftKey ? this.redo() : this.undo();
      else if (lower === "y") this.redo();
      else if (lower === "b") this.split();
      else handled = false;
    } else {
      switch (lower) {
        case " ": this.togglePlay(); break;
        case "j": this.shuttle(-1); break;
        case "k": this.stop(); break;
        case "l": this.shuttle(1); break;
        case "i": this.markIn(); break;
        case "o": this.markOut(); break;
        case "g": this.clearMarks(); break;
        case "b": this.split(); break;
        case "x": this.extract(); break;
        case "m": this.matchSelected(); break;
        case "[": case "]":
          if (this.aSel) {
            const a = this.project.audio.find((x) => x.id === this.aSel);
            this.updateAudioClip(this.aSel, { gain_db: a.gain_db + (lower === "]" ? 1 : -1) });
          } else handled = false;
          break;
        case "Delete": case "Backspace": this.rippleDelete(); break;
        case "ArrowLeft": this.step(e.shiftKey ? -this.fi.base : -1); break;
        case "ArrowRight": this.step(e.shiftKey ? this.fi.base : 1); break;
        case "ArrowUp": this.gotoEdit(-1); break;
        case "ArrowDown": this.gotoEdit(1); break;
        case "Home": this.stop(); this.seek(0); break;
        case "End": this.stop(); this.seek(this.total); break;
        case "=": case "+": this.zoom(1.5); break;
        case "-": case "_": this.zoom(1 / 1.5); break;
        case "\\": this.fit(); break;
        case "Escape": this._cancelDrag(); this.sel = -1; this.aSel = null; this._inspect(); this._updateButtons(); break;
        default: handled = false;
      }
    }
    if (handled) e.preventDefault();
  }
}
