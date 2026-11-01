// Soundstage CUT tab: an editing timeline (V1 + audio tracks A1..An) that plays a live animatic of
// the coverage with temp sound, and exports to every NLE. Clips play their best rung: Final or Draft
// video, the Look still, or live clay from the stage (renderPreviewFrame) when nothing is rendered yet.
// Audio clips play through WebAudio, locked to the picture.
// Edit model: timeline.mjs. Writers: exporters.mjs. Contract and mounting: docs/cut.md.

import * as TL from "./timeline.mjs";
import * as FX from "./fx.mjs";
import { exportAll, fpsInfo, framesToTC, recordStart } from "./exporters.mjs";
import { icon } from "../ui/icons.mjs";
import { sourceLine } from "../ui/sourcespec.mjs";

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
const HEADER_W = 92; // track header column (V2, V1, A1 Dialogue M S ...)
const V2_Y = 26; // V2: title cards
const V2_H = 20;
const TRACK_Y = V2_Y + V2_H + 4; // V1
const TRACK_H = 60;
const SUB_Y = TRACK_Y + TRACK_H + 3; // subtitles lane
const SUB_H = 14;
const A_Y = SUB_Y + SUB_H + 5; // first audio track
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
.ss-cut-src{flex-basis:100%;color:#8fb8ad;font-size:11px;line-height:1.35}
.ss-cut-fx{display:inline-flex;gap:4px;align-items:center;background:#20252c;border:1px dashed #5a6370;border-radius:4px;padding:2px 7px;cursor:grab;user-select:none;touch-action:none;color:#e9edf2}
.ss-cut-fx:hover{border-color:#e39a40}
.ss-cut-bar select,.ss-cut-bar input[type=text],.ss-cut-bar input[type=number]{background:#0d1117;color:#e9edf2;border:1px solid #39404b;border-radius:4px;font:inherit;padding:2px 5px}
.ss-cut-bar input[type=text]{width:220px}
.ss-cut-bar input[type=number]{width:46px}
.ss-cut-lbl{color:#7d8794;font-size:11px;margin-right:2px}
.ss-cut-msg{color:#9fd3c7;font-size:11px}
.ss-cut-msg.err{color:#ff9a8a}
.ss-cut-msg a{color:#e39a40}
.ss-cut-chip em{font-style:normal;font-size:9px;letter-spacing:.04em;color:#0d1117;background:#7fd1c0;border-radius:3px;padding:0 3px}
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
const isOverlapType = (t) => t === "dissolve" || t === "wipe";

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

/**
 * Clip level on a GainNode for a clip starting `off` frames in, at context time `when`: gain, fades, volume keys and
 * the auto-duck (fx.mjs clipGainAt), as linear ramps between its breakpoints (keys are linear in dB, so long key
 * segments are sampled every 2 frames).
 */
function scheduleEnvelope(param, a, off, when, rate) {
  const len = a.out - a.in;
  const pts = FX.levelBreakpoints(a).filter((f) => f > off);
  const fine = [];
  let prev = off;
  for (const f of pts) {
    if (a.keys || a.duck) for (let g = prev + 2; g < f; g += 2) fine.push(g);
    fine.push(f);
    prev = f;
  }
  param.setValueAtTime(FX.clipGainAt(a, off), when);
  for (const f of fine) if (f <= len) param.linearRampToValueAtTime(FX.clipGainAt(a, Math.min(f, len - 1e-3)), when + (f - off) / rate);
}

/** The project fields the host should save (cut, sound, titles, subtitles, the tail fade). */
export function savedFields(p) {
  const out = { cut: p.cut, audio: p.audio, audio_tracks: p.audio_tracks };
  for (const k of ["titles", "subtitles", "fade_out", "burn_subtitles"]) out[k] = p[k] ?? null;
  return out;
}

export class CutPanel {
  /**
   * @param {HTMLElement} container
   * @param {{getProject?: () => object, renderPreviewFrame?: (shotId: string, frame: number) => CanvasImageSource,
   *          onChange?: (project: object) => void}} host
   */
  constructor(container, { getProject, renderPreviewFrame, onChange, onEditShot, getLining, generateAudio, uploadAudio, renderCut } = {}) {
    this._onEditShot = onEditShot || null;   // "edit original": jump to the step that made a clip, then back
    // Milestone 19 host hooks (all optional): the ScriptSync lining for "Assemble scene", in-place audio generation,
    // importing a sound file, and the server render (POST /soundstage/cut/render).
    this._getLining = getLining || null;
    this._generateAudio = generateAudio || null;
    this._uploadAudio = uploadAudio || null;
    this._renderCut = renderCut || ((body) => fetch("/soundstage/cut/render", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) }).then((r) => r.json()));
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
    this.tSel = null; // selected transition: edit index, or "tail"
    this.titleSel = null; // selected title id
    this.subSel = null; // selected subtitle id
    this.keysMode = false; // rubber bands: drag / add / ⌥-click delete level and opacity keys
    this.beats = []; // record frames of the music's beats (Beats button)
    this.loudTarget = "social";

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
      // Titles, subtitles and the tail fade: the host's when it has them, else the panel's own.
      ...Object.fromEntries(["titles", "subtitles", "fade_out", "burn_subtitles"].map((k) => [k, host[k] != null ? host[k] : this.project[k]])),
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
                   { audio: this._ripple(row.recOut, -row.len), ...this._rippleV2(row.recOut, -row.len) });
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
    this._commit(TL.extractRange(this.project, a, b), -1, { audio: this._ripple(b, -(b - a)), ...this._rippleV2(b, -(b - a)) });
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
    const grow = TL.totalFrames({ ...this.project, cut }) - this.total;
    this._commit(cut, at, { audio: this._ripple(f, grow), ...this._rippleV2(f, grow) });
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

  // ------------------------------------------------------------------ Milestone 19: transitions, keys, sound, titles
  // Every one of these is one undoable edit; the director (web/agent) calls them through CUT_ACTIONS / runCutAction.

  /** Status line under the timeline. */
  say(text, { error = false, html = null } = {}) {
    if (!this.msgEl) return;
    this.msgEl.className = "ss-cut-msg" + (error ? " err" : "");
    if (html) this.msgEl.replaceChildren(...html); else this.msgEl.textContent = text || "";
  }

  /**
   * Put a transition on edit `edit` (0 = the head: a fade up; cut.length = the tail: a fade out; else the cut
   * into clip `edit`). type: dissolve | dip_black | dip_white | wipe; frames default to the palette length.
   * Reports when the handles shorten it. Returns the span it got (or null).
   */
  setTransition(edit, type = "dissolve", frames = null) {
    const n = this.project.cut.length;
    if (!n || edit < 0 || edit > n) return null;
    const f = Math.max(1, Math.round(frames ?? FX.DEFAULT_TRANS_FRAMES[type] * (this.rate || 24) / 24));
    if (edit === n) {
      this._commit(this.project.cut, this.sel, { fade_out: { type: type === "dip_white" ? "dip_white" : "dip_black", frames: f } });
      this.tSel = "tail";
    } else {
      this._commit(TL.setTransition(this.project, edit, type, f), this.sel);
      this.tSel = edit;
    }
    const spans = FX.transSpans(this.project);
    const sp = edit === n ? spans.tail : spans[edit];
    const label = edit === 0 ? "Fade up" : edit === n ? "Fade out" : TL.TRANSITION_LABEL[type];
    if (!sp) {
      const h = FX.handlesAt(this.project, edit);
      this.say(`${label} can't go on this cut: no handles (${h.out} frames after the outgoing clip, ${h.in} before the incoming one). Trim the clips in a little, or use a dip.`, { error: true });
    } else if (sp.limited) this.say(`${label}: ${sp.frames} of ${sp.req} frames fit (the clips' handles${isOverlapType(type) ? "" : " / lengths"} limit it).`);
    else this.say(`${label}, ${sp.frames} frames${edit > 0 && edit < n ? `, ${sp.pre === sp.post ? "centred on the cut" : `${sp.pre} before / ${sp.post} after the cut`}` : ""}.`);
    this._inspect();
    return sp || null;
  }

  removeTransition(edit) {
    const n = this.project.cut.length;
    if (edit === "tail" || edit === n) this._commit(this.project.cut, this.sel, { fade_out: null });
    else this._commit(TL.setTransition(this.project, edit, null), this.sel);
    this.tSel = null;
    this._inspect();
  }

  /** Slip clip i by delta source frames (same length, same place, different frames). */
  slipClip(i, delta) {
    const cut = TL.slip(this.project, i, delta);
    if (JSON.stringify(cut) !== JSON.stringify(this.project.cut)) this._commit(cut, i);
  }

  /** Opacity keys of clip i: [[frame in the clip, 0..1], ...] (null clears). */
  setOpacityKeys(i, keys) {
    const cut = this.project.cut.map((e, k) => (k === i ? { ...e, opacity: keys } : e));
    if (!keys) delete cut[i].opacity;
    this._commit(cut, i);
  }

  /** Volume keys of an audio clip: [[frame in the clip, dB], ...] (null clears). */
  setVolumeKeys(id, keys) {
    this._commit(this.project.cut, this.sel, { audio: this.project.audio.map((a) => (a.id === String(id) ? { ...a, keys } : a)) });
  }

  /** Auto-duck the music under the dialogue (writes each music clip's duck keys). */
  autoDuck(opts = {}) {
    const audio = FX.autoDuck(this.project, opts);
    const n = audio.filter((a) => a.duck).length;
    this._commit(this.project.cut, this.sel, { audio });
    const regions = FX.dialogueRegions(this.project).length;
    this.say(n ? `Music ducked ${opts.depth_db ?? FX.DUCK_DEFAULTS.depth_db} dB under ${regions} dialogue line${regions === 1 ? "" : "s"} (${n} music clip${n === 1 ? "" : "s"}). Drag the keys to adjust.`
      : regions ? "No music clip overlaps the dialogue (music goes on A3)." : "No dialogue to duck under (dialogue goes on A1).", { error: !n });
    return n;
  }

  /** Beats of a music clip (default: the selected clip, else the first on a music track): {bpm, frames}. */
  async analyzeBeats(id = null) {
    const music = FX.tracksByRole(this.project, "music");
    const a = this.project.audio.find((x) => x.id === (id || this.aSel)) || this.project.audio.find((x) => music.includes(x.track) && x.out != null);
    if (!a) { this.say("Put a music clip on A3 first (Generate › Music, or Import).", { error: true }); return null; }
    const entry = this.abufs.get(this._audioUrl(a));
    if (!entry?.buffer) { this.say(`${a.label}: still loading; try again in a moment.`, { error: true }); return null; }
    const b = entry.buffer, ch0 = b.getChannelData(0), ch1 = b.numberOfChannels > 1 ? b.getChannelData(1) : ch0;
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    const r = FX.detectBeats(mono, b.sampleRate);
    this.beats = FX.beatFrames(a, r.beats, this.rate);
    this.say(r.bpm ? `${a.label}: ${r.bpm} BPM, ${this.beats.length} beats marked on the ruler. Trims snap to them; "Cuts → beat" rolls each cut onto the nearest one.`
      : `${a.label}: no steady beat found.`, { error: !r.bpm });
    this.requestDraw();
    return { bpm: r.bpm, frames: this.beats };
  }

  /** Roll every cut onto the nearest beat within tol frames. */
  snapCutsToBeats(tol = 6) {
    if (!this.beats.length) { this.say("Find the beats first (Beats).", { error: true }); return 0; }
    const { cut, moved } = FX.snapCutsToBeats(this.project, this.beats, { tol, roll: TL.roll });
    if (moved.length) this._commit(cut, this.sel);
    this.say(moved.length ? `${moved.length} cut${moved.length === 1 ? "" : "s"} rolled onto the beat.` : `No cut within ${tol} frames of a beat.`);
    return moved.length;
  }

  /** First cut from the ScriptSync lining: the wide for action, the speaker's single for lines; subtitles too. */
  assembleScene() {
    const lin = this._getLining?.();
    if (!lin?.scene?.elements?.length) { this.say("Assemble needs a script scene with lined coverage (① Script, then ScriptSync).", { error: true }); return null; }
    const byId = TL.shotMap(this.project);
    const shots = (lin.shots || []).filter((s) => byId.has(String(s.id)));
    const r = FX.assembleFromLining(lin.scene, shots, (id) => byId.get(String(id))?.frames || 0, { fps: this.rate || 24 });
    if (!r.cut.length) { this.say("Nothing in the lining to cut yet: line the setups in ScriptSync.", { error: true }); return null; }
    this._commit(r.cut, 0, { subtitles: r.cues });
    this.seek(0);
    this.say(`Assembled ${r.cut.length} clips from the lining (${new Set(r.cut.map((e) => e.shot_id)).size} setups), cut on line ends; ${r.cues.length} subtitle cues from the dialogue.`);
    return r;
  }

  /** Subtitles from the typed dialogue (dialogue clips' lines), replacing the current cues. */
  subtitlesFromDialogue() {
    const cues = FX.subtitlesFromDialogue(this.project);
    if (!cues.length) { this.say("No dialogue lines on the tracks yet (Generate › Dialogue, or Assemble scene).", { error: true }); return 0; }
    this._commit(this.project.cut, this.sel, { subtitles: cues });
    this.say(`${cues.length} subtitle cues from the dialogue lines.`);
    return cues.length;
  }

  setBurnSubtitles(on) { this._commit(this.project.cut, this.sel, { burn_subtitles: !!on }); }

  addTitle({ text = "TITLE", start_frame = null, frames = null, style = "card" } = {}) {
    const titles = [...(this.project.titles || []), { id: `t${Date.now().toString(36)}`, text, style,
      start_frame: start_frame ?? Math.floor(this.frame), frames: frames ?? Math.round(3 * this.rate) }];
    this._commit(this.project.cut, this.sel, { titles });
    this.titleSel = titles[titles.length - 1].id;
    this._inspect();
    return this.titleSel;
  }

  updateTitle(id, patch) {
    this._commit(this.project.cut, this.sel, { titles: (this.project.titles || []).map((t) => (t.id === id ? { ...t, ...patch, id } : t)) });
  }

  removeTitle(id) {
    this._commit(this.project.cut, this.sel, { titles: (this.project.titles || []).filter((t) => t.id !== id) });
    if (this.titleSel === id) this.titleSel = null;
    this._inspect();
  }

  /**
   * Generate a sound in place with the App's open-weights audio nodes and drop it at the playhead on its track
   * (SFX -> A2, music -> A3, dialogue -> A1). kind: sfx | music | dialogue; text: the prompt / brief / line.
   */
  async generateAudio({ kind = "sfx", text = "", seconds = null, character = "" } = {}) {
    if (!this._generateAudio) { this.say("Audio generation runs in the App (it needs ComfyUI).", { error: true }); return null; }
    if (!String(text).trim()) { this.say("Type what to generate first.", { error: true }); return null; }
    const at = Math.floor(this.frame);
    this.say(`Generating ${kind === "sfx" ? "the effect" : kind}: “${text}”… (queued on the GPU)`);
    try {
      const clip = await this._generateAudio({ kind, text, seconds: seconds || (kind === "music" ? 12 : kind === "dialogue" ? 0 : 2.5),
        start_frame: at, fps: this.project.fps, character });
      const id = this.addAudioClip({ ...clip, start_frame: at, track: TL.ROLE_TRACK[kind] || clip.track });
      this.say(`${clip.label || kind} landed on A${TL.ROLE_TRACK[kind] || clip.track} at ${framesToTC(recordStart(this.fi.base) + at, this.fi.base)}.`);
      return id;
    } catch (err) {
      this.say(`Couldn't generate: ${err.message || err}`, { error: true });
      return null;
    }
  }

  /** Import a sound file onto a track at the playhead (uploads it in the App; an object URL standalone). */
  async importAudio(file, track = null) {
    try {
      const url = this._uploadAudio ? await this._uploadAudio(file) : URL.createObjectURL(file);
      const kind = /music|score|cue|song/i.test(file.name) ? "music" : /amb|room|tone/i.test(file.name) ? "ambience" : /dx|line|dialog/i.test(file.name) ? "dialogue" : "sfx";
      const id = this.addAudioClip({ url, label: file.name.replace(/\.[^.]+$/, ""), track: track || TL.ROLE_TRACK[kind], start_frame: Math.floor(this.frame) });
      this.say(`Imported ${file.name} on A${track || TL.ROLE_TRACK[kind]}.`);
      return id;
    } catch (err) { this.say(`Couldn't import ${file.name}: ${err.message || err}`, { error: true }); return null; }
  }

  /** Integrated loudness of the whole mix as it plays here (BS.1770, offline render of the tracks): {lufs, peak_db}. */
  async measureLoudness() {
    const n = this.seqLen;
    if (!n || !this.project.audio.length) { this.say("No sound on the tracks to measure.", { error: true }); return null; }
    const sr = 48000, OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ac = new OAC(2, Math.ceil((n / this.rate) * sr), sr);
    for (const a of this.project.audio) {
      const e = this.abufs.get(this._audioUrl(a));
      if (!e?.buffer || a.out == null || !TL.audible(this.project, a.track)) continue;
      const src = ac.createBufferSource();
      src.buffer = e.buffer;
      const g = ac.createGain();
      const when = a.start_frame / this.rate;
      scheduleEnvelope(g.gain, a, 0, when, this.rate);
      src.connect(g).connect(ac.destination);
      src.start(when, a.in / this.rate, (a.out - a.in) / this.rate);
    }
    const buf = await ac.startRendering();
    const r = FX.loudness([buf.getChannelData(0), buf.getChannelData(1)], sr);
    const t = FX.LOUDNESS_TARGETS[this.loudTarget];
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-∞");
    this.say(`Mix: ${fmt(r.lufs)} LUFS integrated, peak ${fmt(r.peak_db)} dBFS (tracks only).` +
      (t ? ` The render takes it to ${t.lufs} LUFS (${FX.loudnessGain(r.lufs, t.lufs) >= 0 ? "+" : ""}${fmt(FX.loudnessGain(r.lufs, t.lufs))} dB), true peak ≤ ${t.true_peak} dBTP.` : ""));
    return r;
  }

  /** Render the cut to one file on the server: {format: mp4|prores, aspect: source|9:16}. */
  async render({ format = "mp4", aspect = "source" } = {}) {
    const body = { ...FX.renderRequest(this.project, { format, aspect, loudness: this.loudTarget, burn_subtitles: !!this.project.burn_subtitles }), name: this.project.name };
    this.say(`Rendering ${aspect === "9:16" ? "the 9:16 social cut" : format === "prores" ? "ProRes 422 HQ" : "MP4"}…`);
    try {
      const j = await this._renderCut(body);
      if (!j || j.error) throw new Error(j?.error || "no answer");
      const url = `/view?${new URLSearchParams({ filename: j.filename, subfolder: j.subfolder, type: j.type })}`;
      const link = Object.assign(document.createElement("a"), { href: j.url || url, target: "_blank", rel: "noopener", textContent: j.filename });
      const L = j.loudness || {};
      this.say("", { html: [link, document.createTextNode(` · ${j.width}×${j.height} · ${j.seconds}s` +
        (L.lufs != null ? ` · ${L.lufs.toFixed(1)} LUFS, true peak ${L.true_peak.toFixed(1)} dBTP` : "") +
        (j.missing?.length ? ` · ${j.missing.length} clip${j.missing.length === 1 ? "" : "s"} not rendered yet (slates)` : ""))] });
      this.lastRender = j;
      return j;
    } catch (err) {
      this.say(`Couldn't render: ${err.message || err}`, { error: true });
      return null;
    }
  }

  _snapshot() {
    const p = this.project;
    return { cut: p.cut, audio: p.audio, audio_tracks: p.audio_tracks, titles: p.titles, subtitles: p.subtitles, fade_out: p.fade_out,
             burn_subtitles: p.burn_subtitles };
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
    this.b.srt = btn2("SRT", "Subtitles as SubRip (.srt); the WebVTT comes with the Cut Export node", () => this._download(".srt"));

    // ---- Milestone 19: picture tools (transitions palette, keys, assemble, titles, subtitles)
    const bar3 = document.createElement("div");
    bar3.className = "ss-cut-bar";
    const lbl = (bar, t) => { const x = document.createElement("span"); x.className = "ss-cut-lbl"; x.textContent = t; bar.append(x); return x; };
    const btn3 = (bar, ...a) => { const b = btn(...a); bar.append(b); return b; };
    lbl(bar3, "Transitions");
    for (const [type, name, tip] of [["dissolve", "Dissolve", "Cross dissolve: drag onto a cut (uses the clips' handles)"],
      ["dip_black", "Dip black", "Dip to black: drag onto a cut, or onto the head / tail for a fade up / fade out"],
      ["dip_white", "Dip white", "Dip to white"], ["wipe", "Wipe", "Wipe left to right"]]) {
      const chip = document.createElement("span");
      chip.className = "ss-cut-fx";
      chip.textContent = name;
      chip.title = tip + ". Or click it: it goes on the cut nearest the playhead (T does a dissolve).";
      chip.addEventListener("pointerdown", (e) => this._fxDown(e, type));
      bar3.append(chip);
    }
    this.b.keys = btn3(bar3, "Keys", "Rubber bands: click a clip's level / opacity line to add a key, drag keys, ⌥-click deletes one (R)", () => { this.keysMode = !this.keysMode; this._updateButtons(); this.requestDraw(); }, true);
    const sep3 = () => { const x = document.createElement("span"); x.className = "ss-cut-sep"; bar3.append(x); };
    sep3();
    this.b.assemble = btn3(bar3, "Assemble scene", "A first cut from the ScriptSync lining: the wide for action, the speaker's single for lines, cut on line ends (plus subtitles)", () => this.assembleScene());
    this.b.title = btn3(bar3, "+ Title", "A title card on V2 at the playhead (edit its text, style and length in the inspector)", () => this.addTitle({ text: this.project.name || "TITLE" }));
    this.b.subs = btn3(bar3, "Subtitles", "Subtitles from the typed dialogue lines (no speech recognition)", () => this.subtitlesFromDialogue());
    this.b.burn = btn3(bar3, "Burn in", "Burn the subtitles into the rendered picture", () => this.setBurnSubtitles(!this.project.burn_subtitles), true);

    // ---- sound after generation
    const bar4 = document.createElement("div");
    bar4.className = "ss-cut-bar";
    lbl(bar4, "Sound");
    const kind = document.createElement("select");
    for (const [v, t] of [["sfx", "SFX → A2"], ["music", "Music → A3"], ["dialogue", "Dialogue → A1"]]) kind.append(new Option(t, v));
    const prompt = Object.assign(document.createElement("input"), { type: "text", placeholder: "glass shatters on a tile floor" });
    kind.addEventListener("change", () => { prompt.placeholder = { sfx: "glass shatters on a tile floor", music: "tense neo-noir pulse, low strings, 90 bpm", dialogue: "MARA: Then why bring this one?" }[kind.value]; });
    const secs = Object.assign(document.createElement("input"), { type: "number", min: 0.5, max: 30, step: 0.5, value: 2.5, title: "Seconds (dialogue: as long as the line)" });
    for (const x of [kind, prompt, secs]) { x.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") genBtn.click(); }); bar4.append(x); }
    const genBtn = btn3(bar4, "Generate", "Generate it with the App's open-weights audio nodes (LTX-2.5 audio for SFX and music, Chatterbox for lines) and drop it at the playhead", () => {
      let text = prompt.value.trim(), character = "";
      const m = kind.value === "dialogue" && /^([A-Z][A-Z .'-]{1,30}):\s*(.+)$/.exec(text);
      if (m) { character = m[1].trim(); text = m[2]; }
      this.generateAudio({ kind: kind.value, text, seconds: Number(secs.value) || null, character });
    });
    this.genUI = { kind, prompt, secs, btn: genBtn };
    const file = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*", hidden: true });
    file.addEventListener("change", () => { for (const f of file.files) this.importAudio(f); file.value = ""; });
    bar4.append(file);
    btn3(bar4, "Import…", "Import a sound file (music, effect, ambience) at the playhead", () => file.click());
    const sep4 = () => { const x = document.createElement("span"); x.className = "ss-cut-sep"; bar4.append(x); };
    sep4();
    btn3(bar4, "Auto-duck", "Dip the music (A3) 12 dB under every dialogue line (A1), with 6 frames attack, 12 release; the keys stay editable", () => this.autoDuck());
    btn3(bar4, "Beats", "Find the beat of the music clip (selected, else the first on A3) and mark it on the ruler; trims snap to it", () => this.analyzeBeats());
    btn3(bar4, "Cuts → beat", "Roll every cut onto the nearest beat (within 6 frames)", () => this.snapCutsToBeats());
    sep4();
    const loud = document.createElement("select");
    loud.title = "Loudness target for the render";
    for (const [k, v] of Object.entries(FX.LOUDNESS_TARGETS)) loud.append(new Option(v.label, k));
    loud.append(new Option("No loudness pass", ""));
    loud.value = this.loudTarget;
    loud.addEventListener("change", () => { this.loudTarget = loud.value || null; });
    bar4.append(loud);
    btn3(bar4, "Measure", "Measure the mix's integrated loudness (ITU BS.1770) here in the browser", () => this.measureLoudness());

    // ---- render
    const bar5 = document.createElement("div");
    bar5.className = "ss-cut-bar";
    lbl(bar5, "Render");
    btn3(bar5, "MP4", "Render the cut to one MP4 (H.264 + AAC) at the source size and rate: transitions, titles, the mix at the loudness target", () => this.render({ format: "mp4" }));
    btn3(bar5, "ProRes", "ProRes 422 HQ + 24-bit PCM (.mov) at the source spec", () => this.render({ format: "prores" }));
    btn3(bar5, "9:16 social", "A 1080×1920 vertical cut, centre-cropped, titles and subtitles re-laid for the phone", () => this.render({ format: "mp4", aspect: "9:16" }));
    this.msgEl = document.createElement("span");
    this.msgEl.className = "ss-cut-msg";
    bar5.append(this.msgEl);
    this._bars = [bar3, bar4, bar5];

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
    // a second inspector: the selected transition, title or subtitle
    this.insp2 = document.createElement("div");
    this.insp2.className = "ss-cut-insp";
    this.insp2.hidden = true;

    // bin
    this.bin = document.createElement("div");
    this.bin.className = "ss-cut-bin";
    const help = document.createElement("div");
    help.className = "ss-cut-help";
    help.textContent =
      "Space play · J K L shuttle · ←/→ frame · ↑/↓ edit · I/O mark · G clear · B split · ⌫ ripple delete · X extract · ⌘Z undo · " +
      "drag a clip to reorder · drag its edge to trim (⌥ = roll the edit) · click a shot to splice it in at the playhead, ⇧-click to overwrite · " +
      "audio: drag to slide (up/down changes track), edges trim, top corners fade, [ / ] gain, M/S in the header mute/solo · " +
      "S split · ⌘-drag a clip (or , and .) to slip · T dissolve at the nearest cut · drag a transition onto a cut · R keys (rubber bands)";

    root.append(vw, bar, bar2, ...this._bars, tlw, insp, this.insp2, this.bin, help);
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
      if (s.source) {
        // Imported footage (docs/source_fidelity.md): the exports point at the camera original.
        const tag = document.createElement("em");
        tag.textContent = "SRC";
        chip.append(tag);
        chip.title += `\n${sourceLine(s.source)}`;
      }
      chip.addEventListener("pointerdown", (e) => this._chipDown(e, s.id));
      this.bin.append(chip);
    }
    const srcShots = this.project.shots.filter((s) => s.source);
    if (srcShots.length) {
      const line = document.createElement("div");
      line.className = "ss-cut-src";
      const d = this.project.delivery;
      line.textContent = [...new Set(srcShots.map((s) => sourceLine(s.source)))].join("\n") + "\n" +
        (d ? `Exports deliver at the source spec: ${d.width}×${d.height} at ${d.fps} fps; imported shots link to the camera original with its own reel and timecode.`
           : "Exports keep the project's size; imported shots still link to the camera original.") +
        (srcShots.some((s) => s.source.proxy) ? " Working from a proxy; your export relinks to the camera original." : "");
      line.style.whiteSpace = "pre-line";
      this.bin.append(line);
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
    this.b.keys?.setAttribute("aria-pressed", String(this.keysMode));
    this.b.burn?.setAttribute("aria-pressed", String(!!this.project.burn_subtitles));
    if (this.b.srt) this.b.srt.disabled = !(this.project.subtitles || []).length;
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
  _commit(cut, sel = this.sel, extra = {}) {
    const { audio, audio_tracks } = extra;
    this.history.push(this._snapshot());
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.project = { ...this.project, cut, ...(audio ? { audio } : {}), ...(audio_tracks ? { audio_tracks } : {}) };
    for (const k of ["titles", "subtitles", "fade_out", "burn_subtitles"]) if (k in extra) this.project[k] = extra[k];
    this.project = TL.normalizeProject(this.project);
    this.sel = sel;
    this._afterEdit();
  }

  /** Audio after a picture ripple at record frame `at` by `delta` frames (unchanged with sync lock off). */
  _ripple(at, delta, audio = this.project.audio) {
    return this.syncLock && delta ? TL.rippleAudio(audio, at, delta) : audio;
  }

  /** Titles and subtitles after a picture ripple (sync lock), as _commit extras. */
  _rippleV2(at, delta) {
    if (!this.syncLock || !delta) return {};
    const out = {};
    if (this.project.titles) out.titles = TL.rippleItems(this.project.titles, at, delta);
    if (this.project.subtitles) out.subtitles = TL.rippleItems(this.project.subtitles, at, delta);
    return out;
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
    this._inspect2();
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

  /** The transition / title / subtitle inspector. */
  _inspect2() {
    const box = this.insp2;
    if (!box) return;
    const n = this.project.cut.length;
    const spans = FX.transSpans(this.project);
    const mk = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const num = (label, value, onChange, attrs = {}) => {
      const l = mk("label", { textContent: label });
      const inp = mk("input", { type: "number", value: String(value), ...attrs });
      inp.addEventListener("change", () => { const v = Number(inp.value); if (Number.isFinite(v)) onChange(v); });
      inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
      l.append(inp);
      return l;
    };
    const button = (text, fn) => { const b = mk("button", { type: "button", textContent: text }); b.style.cssText = "background:#262b33;color:#cfd5de;border:1px solid #39404b;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return b; };
    const sel = (opts, value, onChange) => { const x = mk("select"); for (const [v, t] of opts) x.append(new Option(t, v)); x.value = value; x.addEventListener("change", () => onChange(x.value)); x.style.cssText = "background:#0d1117;color:#e9edf2;border:1px solid #39404b;border-radius:3px;font:inherit"; return x; };
    const parts = [];
    if (this.tSel != null) {
      const tail = this.tSel === "tail";
      const sp = tail ? spans.tail : spans[this.tSel];
      const tr = tail ? this.project.fade_out : this.project.cut[this.tSel]?.trans;
      if (!tr) { this.tSel = null; } else {
        const edit = tail ? n : this.tSel;
        const types = edit === 0 || tail ? [["dip_black", "Fade black"], ["dip_white", "Fade white"]] : TL.TRANSITIONS.map((t) => [t, TL.TRANSITION_LABEL[t]]);
        parts.push(mk("b", { textContent: edit === 0 ? "Fade up" : tail ? "Fade out" : `Cut ${edit}` }),
          sel(types, tr.type, (v) => this.setTransition(edit, v, tr.frames)),
          num("frames", tr.frames, (v) => this.setTransition(edit, tr.type, v), { min: 1, step: 1 }),
          mk("span", { className: "ss-cut-ro", textContent: sp ? `${sp.frames}f in place · ${sp.pre} before / ${sp.post} after the cut${sp.limited ? " (handles limit it)" : ""}` : "no handles here" }),
          button("Remove", () => this.removeTransition(this.tSel)));
      }
    } else if (this.titleSel) {
      const t = (this.project.titles || []).find((x) => x.id === this.titleSel);
      if (!t) this.titleSel = null; else {
        const txt = mk("input", { value: t.text, className: "wide" });
        txt.addEventListener("change", () => this.updateTitle(t.id, { text: txt.value }));
        txt.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") txt.blur(); });
        parts.push(mk("b", { textContent: "V2 title" }), txt,
          sel([["card", "Card (on black)"], ["lower", "Lower third"], ["center", "Centre, over picture"]], t.style, (v) => this.updateTitle(t.id, { style: v })),
          num("frames", t.frames, (v) => this.updateTitle(t.id, { frames: v }), { min: 1 }),
          num("fade in", t.fade_in, (v) => this.updateTitle(t.id, { fade_in: v }), { min: 0 }),
          num("fade out", t.fade_out, (v) => this.updateTitle(t.id, { fade_out: v }), { min: 0 }),
          button("Remove", () => this.removeTitle(t.id)));
      }
    } else if (this.subSel) {
      const c = (this.project.subtitles || []).find((x) => x.id === this.subSel);
      if (!c) this.subSel = null; else {
        const txt = mk("input", { value: c.text, className: "wide" });
        txt.style.width = "320px";
        const setCue = (patch) => this._commit(this.project.cut, this.sel, { subtitles: this.project.subtitles.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) });
        txt.addEventListener("change", () => setCue({ text: txt.value }));
        txt.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") txt.blur(); });
        parts.push(mk("b", { textContent: `Subtitle${c.speaker ? " · " + c.speaker : ""}` }), txt,
          num("in", c.start_frame, (v) => setCue({ start_frame: v })), num("out", c.end_frame, (v) => setCue({ end_frame: v })),
          button("Remove", () => { this._commit(this.project.cut, this.sel, { subtitles: this.project.subtitles.filter((x) => x.id !== c.id) }); this.subSel = null; this._inspect(); }));
      }
    }
    box.hidden = !parts.length;
    box.replaceChildren(...parts);
  }

  // drag a transition from the palette onto a cut (or click it: the cut nearest the playhead)
  _fxDown(e, type) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const over = (ev) => { const r = this.tl.getBoundingClientRect(); return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 12 && ev.clientY <= r.bottom + 12; };
    const move = (ev) => {
      ev.stopPropagation();
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) moved = true;
      if (!moved) return;
      this._drag = { mode: "fx", type, target: over(ev) ? this._nearestEdit(this._local(ev).x) : null };
      this.requestDraw();
    };
    const up = (ev) => {
      ev.stopPropagation();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      const d = this._drag;
      this._drag = null;
      if (!moved) { this.setTransition(this._nearestEdit(this._x(Math.floor(this.frame))), type); return; }
      if (d && d.mode === "fx" && d.target != null) this.setTransition(d.target, type);
      this.requestDraw();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
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
    // Milestone 19: the picture after transitions (dissolve / wipe mix two clips, dips and fades go to a colour),
    // clip opacity (over black), then the V2 title and the subtitle, as the render will have them.
    const pic = FX.pictureAt(p, f);
    const other = pic && pic.b ? (pic.row.index === row.index ? pic.b : { row: pic.row, src: pic.src }) : null;
    const img = this._frameOf(row.shot, src, { realtime });
    const img2 = other ? this._frameOf(other.row.shot, TL.clamp(other.src, 0, other.row.shot.frames - 1)) : null;
    if (img || pic?.dip || other) {
      pc.fillStyle = "#000"; pc.fillRect(0, 0, W, H);
      if (other && pic) {
        const aImg = pic.row.index === row.index ? img : img2, bImg = pic.row.index === row.index ? img2 : img;
        if (aImg) drawContain(pc, aImg, 0, 0, W, H);
        if (bImg) {
          pc.save();
          if (pic.wipe) { pc.beginPath(); pc.rect(0, 0, W * pic.mix, H); pc.clip(); } else pc.globalAlpha = pic.mix;
          drawContain(pc, bImg, 0, 0, W, H);
          pc.restore();
        }
      } else if (img) drawContain(pc, img, 0, 0, W, H);
      if (pic && pic.alpha < 1) { pc.fillStyle = `rgba(0,0,0,${1 - pic.alpha})`; pc.fillRect(0, 0, W, H); }
      if (pic?.dip) { pc.fillStyle = pic.dip.color === "white" ? `rgba(255,255,255,${pic.dip.amount})` : `rgba(0,0,0,${pic.dip.amount})`; pc.fillRect(0, 0, W, H); }
    }
    ctx.drawImage(this.pic, 0, 0);
    this._drawOverlays(ctx, f, W, H);

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

  /** The V2 title and the subtitle at frame f, drawn over the viewer like the render draws them. */
  _drawOverlays(ctx, f, W, H) {
    const t = FX.titleAt(this.project, f);
    if (t) {
      ctx.save();
      ctx.globalAlpha = t.alpha;
      const st = t.title.style, size = st === "lower" ? Math.round(H / 16) : Math.round(H / 11);
      if (st === "card") { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
      ctx.font = `700 ${size}px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const y = st === "lower" ? H * 0.82 : H / 2;
      if (st === "lower") { ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, y - size, W, size * 2); }
      ctx.lineWidth = Math.max(2, size / 14); ctx.strokeStyle = "rgba(0,0,0,.85)";
      if (st !== "card") ctx.strokeText(t.title.text, W / 2, y, W * 0.9);
      ctx.fillStyle = "#fff"; ctx.fillText(t.title.text, W / 2, y, W * 0.9);
      ctx.restore();
    }
    const c = FX.cueAt(this.project, f);
    if (c) {
      ctx.save();
      const size = Math.round(H / 20);
      ctx.font = `600 ${size}px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const lines = FX.wrapCue(c.text);
      lines.forEach((ln, i) => {
        const y = H * 0.86 - (lines.length - 1 - i) * size * 1.25;
        ctx.lineWidth = Math.max(3, size / 8); ctx.strokeStyle = "rgba(0,0,0,.9)"; ctx.strokeText(ln, W / 2, y, W * 0.94);
        ctx.fillStyle = this.project.burn_subtitles ? "#fff" : "rgba(255,255,255,.85)"; ctx.fillText(ln, W / 2, y, W * 0.94);
      });
      ctx.restore();
    }
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

    // beats (from the music) on the ruler
    if (this.beats.length) {
      ctx.fillStyle = "rgba(127,209,192,.8)";
      for (const b of this.beats) { const x = this._x(b); if (x >= HEADER_W && x <= w) ctx.fillRect(Math.round(x), RULER_H - 6, 1, 6); }
    }

    // V2 (titles) and the subtitles lane
    ctx.fillStyle = "#1a1e24";
    ctx.fillRect(0, V2_Y, w, V2_H);
    ctx.fillRect(0, SUB_Y, w, SUB_H);
    ctx.font = "600 10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (const t of p.titles || []) {
      const x0 = this._x(t.start_frame), x1 = this._x(t.start_frame + t.frames);
      if (x1 < HEADER_W || x0 > w) continue;
      roundRect(ctx, x0 + 0.5, V2_Y + 2, Math.max(2, x1 - x0 - 1), V2_H - 4, 3);
      ctx.fillStyle = "#6b4fa0"; ctx.fill();
      ctx.lineWidth = t.id === this.titleSel ? 2 : 1; ctx.strokeStyle = t.id === this.titleSel ? ACCENT : "rgba(0,0,0,.5)"; ctx.stroke(); ctx.lineWidth = 1;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, V2_Y, x1 - x0, V2_H); ctx.clip();
      ctx.fillStyle = "#fff"; ctx.fillText((t.style === "card" ? "▣ " : t.style === "lower" ? "▁ " : "◇ ") + t.text, x0 + 5, V2_Y + V2_H / 2);
      ctx.restore();
    }
    for (const c of p.subtitles || []) {
      const x0 = this._x(c.start_frame), x1 = this._x(c.end_frame);
      if (x1 < HEADER_W || x0 > w) continue;
      ctx.fillStyle = c.id === this.subSel ? ACCENT : p.burn_subtitles ? "#8a8f5a" : "#4b525c";
      ctx.fillRect(x0 + 0.5, SUB_Y + 2, Math.max(2, x1 - x0 - 1), SUB_H - 4);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, SUB_Y, x1 - x0, SUB_H); ctx.clip();
      ctx.fillStyle = "#0d1117"; ctx.font = "9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(c.text, x0 + 3, SUB_Y + SUB_H / 2);
      ctx.restore();
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

    // transitions: a bar across the frames they cover, with a cross for an overlap (dissolve / wipe)
    const spans = FX.transSpans(p);
    const allSpans = spans.map((sp, k) => [sp, k]).filter(([sp]) => sp);
    if (spans.tail) allSpans.push([spans.tail, "tail"]);
    for (const [sp, k] of allSpans) {
      const x0 = this._x(sp.at - sp.pre), x1 = this._x(sp.at + sp.post);
      if (x1 < HEADER_W || x0 > w) continue;
      const y = TRACK_Y + 2, h = 16, ww = Math.max(6, x1 - x0);
      const selT = this.tSel === k;
      ctx.fillStyle = sp.limited ? "rgba(227,154,64,.85)" : sp.type === "dip_white" ? "rgba(235,235,235,.85)" : "rgba(20,22,26,.85)";
      roundRect(ctx, x0, y, ww, h, 3); ctx.fill();
      ctx.lineWidth = selT ? 2 : 1; ctx.strokeStyle = selT ? ACCENT : "rgba(255,255,255,.6)"; ctx.stroke(); ctx.lineWidth = 1;
      ctx.strokeStyle = sp.type === "dip_white" ? "#333" : "#e9edf2";
      ctx.beginPath();
      if (FX.isOverlap(sp.type)) { ctx.moveTo(x0, y + h); ctx.lineTo(x0 + ww, y); ctx.moveTo(x0, y); ctx.lineTo(x0 + ww, y + h); }
      else if (sp.head) { ctx.moveTo(x0, y + h); ctx.lineTo(x0 + ww, y); }
      else if (sp.tail) { ctx.moveTo(x0, y); ctx.lineTo(x0 + ww, y + h); }
      else { ctx.moveTo(x0, y); ctx.lineTo(this._x(sp.at), y + h); ctx.lineTo(x0 + ww, y); }
      ctx.stroke();
      if (ww > 40) {
        ctx.fillStyle = sp.type === "dip_white" ? "#111" : "#fff"; ctx.font = "700 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(`${{ dissolve: "DIS", dip_black: "DIP", dip_white: "DIP W", wipe: "WIPE" }[sp.type]} ${sp.frames}`, x0 + ww / 2, y + h / 2 + 0.5);
        ctx.textAlign = "left";
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
    if (d && d.target != null && (d.mode === "move" || d.mode === "bin" || d.mode === "fx")) {
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
    ctx.fillStyle = "#b9a6dc";
    ctx.fillText("V2  Titles", 8, V2_Y + V2_H / 2);
    ctx.fillStyle = "#8b94a1";
    ctx.font = "600 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(p.burn_subtitles ? "SUBS · burn" : "SUBS", 8, SUB_Y + SUB_H / 2);
    for (let t = 1; t <= nTracks; t++) {
      const y = this._trackTop(t), st = TL.trackState(p, t), heard = TL.audible(p, t);
      ctx.fillStyle = heard ? "#cfd5de" : "#6b737e";
      ctx.font = "600 11px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("A" + t, 8, y + A_H / 2 - 6);
      ctx.font = "10px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#8b94a1";
      ctx.fillText(TL.trackName(p, t).slice(0, 9), 8, y + A_H / 2 + 8);
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
        const v = Math.min(1, m * FX.clipGainAt(a, f0)) * amp;
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
    // level line (gain + keys + duck), the rubber band: -30..+6 dB over the clip's height
    if (a.keys || a.duck || this.keysMode) {
      const yOf = (db) => y + h - ((TL.clamp(db, -30, 6) + 30) / 36) * (h - 4) - 2;
      ctx.strokeStyle = a.duck ? "#ffd27a" : "#f2ff59";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const xa = Math.max(x0, HEADER_W), xb = Math.min(x0 + cw, this.tl.clientWidth);
      for (let x = xa; x <= xb; x += 2) {
        const db = a.gain_db + FX.keysDb(a, (x - x0) / this.ppf);
        x === xa ? ctx.moveTo(x, yOf(db)) : ctx.lineTo(x, yOf(db));
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = "#f2ff59";
      for (const [f] of a.keys || []) ctx.fillRect(x0 + f * this.ppf - 2.5, yOf(a.gain_db + FX.keysDb(a, f)) - 2.5, 5, 5);
      ctx.fillStyle = "#ffd27a";
      for (const [f] of a.duck || []) { ctx.beginPath(); ctx.arc(x0 + f * this.ppf, yOf(a.gain_db + FX.keysDb(a, f)), 2, 0, 7); ctx.fill(); }
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
    if (!ghost && (r.event.opacity || this.keysMode)) {
      const yOf = (v) => y + 4 + (1 - v) * (h - 8);
      ctx.strokeStyle = "#f2ff59"; ctx.lineWidth = 1.5; ctx.beginPath();
      for (let x = x0; x <= x0 + cw; x += 2) { const v = TL.keyAt(r.event.opacity, (x - x0) / this.ppf, 1); x === x0 ? ctx.moveTo(x, yOf(v)) : ctx.lineTo(x, yOf(v)); }
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = "#f2ff59";
      for (const [f, v] of r.event.opacity || []) ctx.fillRect(x0 + f * this.ppf - 2.5, yOf(v) - 2.5, 5, 5);
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
      ["canvas", "Touch up its frame in Paint Studio"], ["motion", "Re-render its motion (⑤ Motion)"], ["review", "Compare in ⑥ Review"]]) {
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
    if (y >= V2_Y && y < V2_Y + V2_H) {
      const f = this._frameAt(x);
      const t = [...(this.project.titles || [])].reverse().find((q) => f >= q.start_frame && f < q.start_frame + q.frames);
      return t ? { type: "title", title: t } : { type: "empty" };
    }
    if (y >= SUB_Y && y < SUB_Y + SUB_H) {
      const f = this._frameAt(x);
      const c = (this.project.subtitles || []).find((q) => f >= q.start_frame && f < q.end_frame);
      return c ? { type: "sub", cue: c } : { type: "empty" };
    }
    if (this.keysMode && y >= A_Y) {
      const t = this._trackAt(y), top = this._trackTop(t);
      const a = this.project.audio.find((q) => q.track === t && q.out != null && x >= this._x(q.start_frame) && x <= this._x(q.start_frame + TL.audioLen(q)));
      if (a) {
        const yy = top + 2, hh = A_H - 4;
        const yOf = (db) => yy + hh - ((TL.clamp(db, -30, 6) + 30) / 36) * (hh - 4) - 2;
        const ki = (a.keys || []).findIndex(([f]) => Math.abs(this._x(a.start_frame + f) - x) <= 5);
        return { type: "akey", audio: a, key: ki, yOf, top: yy, h: hh };
      }
    }
    if (this.keysMode && y >= TRACK_Y && y <= TRACK_Y + TRACK_H) {
      const f = this._frameAt(x);
      const row = TL.layout(this.project).find((r) => f >= r.recIn && f < r.recOut);
      if (row) {
        const ki = (row.event.opacity || []).findIndex(([kf]) => Math.abs(this._x(row.recIn + kf) - x) <= 5);
        return { type: "okey", row, key: ki };
      }
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
    if (y <= TRACK_Y + 19) {
      const spans = FX.transSpans(this.project);
      const list = spans.map((sp, k) => [sp, k]).filter(([sp]) => sp);
      if (spans.tail) list.push([spans.tail, "tail"]);
      for (const [sp, k] of list) {
        const x0 = this._x(sp.at - sp.pre), x1 = Math.max(x0 + 6, this._x(sp.at + sp.post));
        if (x >= x0 - 2 && x <= x1 + 2) return { type: "trans", edit: k };
      }
    }
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
    this.tSel = hit.type === "trans" ? hit.edit : null;
    if (hit.type !== "title") this.titleSel = null;
    if (hit.type !== "sub") this.subSel = null;
    if (hit.type === "trans") { this.stop(); this._inspect(); this.requestDraw(); return; }
    if (hit.type === "title" || hit.type === "sub") {
      this.stop();
      const it = hit.title || hit.cue;
      if (hit.title) this.titleSel = it.id; else this.subSel = it.id;
      this._drag = { mode: hit.title ? "tslide" : "sslide", id: it.id, startX: x, orig: { ...it }, moved: false };
      this._inspect(); this.requestDraw();
      return;
    }
    if (hit.type === "akey" || hit.type === "okey") {
      this.stop();
      const isA = hit.type === "akey";
      const base = isA ? hit.audio : hit.row.event;
      let keys = (isA ? base.keys : base.opacity) ? [...(isA ? base.keys : base.opacity).map((k) => [...k])] : [];
      const startF = isA ? hit.audio.start_frame : hit.row.recIn;
      const len = isA ? TL.audioLen(hit.audio) : hit.row.len;
      const valAt = (yy) => (isA ? TL.clamp(-30 + (1 - (yy - hit.top - 2) / (hit.h - 4)) * 36, -60, 24) - hit.audio.gain_db
        : TL.clamp(1 - (yy - (TRACK_Y + 7)) / (TRACK_H - 14), 0, 1));
      let ki = hit.key;
      if (ki >= 0 && e.altKey) keys.splice(ki, 1), ki = -1;
      else if (ki < 0) {
        const f = TL.clamp(Math.round(this._frameAt(x) - startF), 0, len);
        if (!keys.length) keys = isA ? [[0, 0], [len, 0]] : [[0, 1], [len, 1]];
        keys.push([f, isA ? FX.keysDb(hit.audio, f) - (hit.audio.duck ? TL.keyAt(hit.audio.duck, f, 0) : 0) : TL.keyAt(base.opacity, f, 1)]);
        keys.sort((p1, p2) => p1[0] - p2[0]);
        ki = keys.findIndex((k) => k[0] === f);
      }
      this._drag = { mode: "key", isA, id: isA ? hit.audio.id : hit.row.index, keys, ki, startF, len, valAt,
                     base: { cut: this.project.cut, audio: this.project.audio } };
      this._applyKeys(this._drag);
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
      if (e.metaKey || e.ctrlKey) this._drag = { mode: "slip", idx: hit.idx, startX: x, base: this.project.cut };
      else this._drag = { mode: "pending", idx: hit.idx, startX: x, x, grab: x - this._x(row.recIn) };
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
    if (d.mode === "key") {
      const k = d.keys[d.ki];
      if (k) {
        const first = d.ki === 0, last = d.ki === d.keys.length - 1;
        const lo = first ? 0 : d.keys[d.ki - 1][0] + 1, hi = last ? d.len : d.keys[d.ki + 1][0] - 1;
        k[0] = TL.clamp(Math.round(this._frameAt(x) - d.startF), lo, Math.max(lo, hi));
        k[1] = d.valAt(y);
      }
      this._applyKeys(d);
      return;
    }
    if (d.mode === "slip") {
      const base = { ...this.project, cut: d.base };
      this.project = { ...this.project, cut: TL.slip(base, d.idx, -Math.round((x - d.startX) / this.ppf)) };
      d.changed = true;
      this.requestDraw();
      return;
    }
    if (d.mode === "tslide" || d.mode === "sslide") {
      const df = Math.round((x - d.startX) / this.ppf);
      if (Math.abs(df) > 0) d.moved = true;
      let start = Math.max(0, d.orig.start_frame + df);
      const tol = SNAP_PX / this.ppf;
      for (const pnt of [...TL.editPoints(this.project), Math.floor(this.frame), ...this.beats]) if (Math.abs(pnt - start) <= tol) { start = pnt; break; }
      const key = d.mode === "tslide" ? "titles" : "subtitles";
      const shift = start - d.orig.start_frame;
      this.project = { ...this.project, [key]: (d.list ||= this.project[key]).map((q) => (q.id === d.id
        ? { ...q, start_frame: start, ...(q.end_frame != null ? { end_frame: d.orig.end_frame + shift } : {}) } : q)) };
      this.requestDraw();
      return;
    }
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
    if (d.mode === "key") {
      const after = { cut: this.project.cut, audio: this.project.audio };
      this.project = { ...this.project, ...d.base };
      this._commit(after.cut, this.sel, { audio: after.audio });
      return;
    }
    if (d.mode === "slip") {
      const cut = this.project.cut;
      this.project = { ...this.project, cut: d.base };
      if (d.changed && JSON.stringify(cut) !== JSON.stringify(d.base)) this._commit(cut, d.idx);
      this.requestDraw();
      return;
    }
    if (d.mode === "tslide" || d.mode === "sslide") {
      const key = d.mode === "tslide" ? "titles" : "subtitles";
      const now = this.project[key];
      if (d.list) {
        this.project = { ...this.project, [key]: d.list };
        if (d.moved) this._commit(this.project.cut, this.sel, { [key]: now });
      }
      this.requestDraw();
      return;
    }
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

  /** Live-apply a rubber-band drag (committed on release). */
  _applyKeys(d) {
    const keys = d.keys.length ? d.keys.map(([f, v]) => [f, Math.round(v * (d.isA ? 10 : 1000)) / (d.isA ? 10 : 1000)]) : null;
    if (d.isA) this.project = { ...this.project, audio: d.base.audio.map((a) => (a.id === d.id ? { ...a, keys } : a)) };
    else this.project = { ...this.project, cut: d.base.cut.map((e, k) => (k === d.id ? { ...e, opacity: keys } : e)) };
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
    if (d && d.mode === "key") this.project = { ...this.project, ...d.base };
    else if (d && (d.mode === "tslide" || d.mode === "sslide")) { if (d.list) this.project = { ...this.project, [d.mode === "tslide" ? "titles" : "subtitles"]: d.list }; }
    else if (d && d.mode && d.mode.startsWith("a")) this.project = { ...this.project, audio: d.base };
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
        for (const b of this.beats) if (Math.abs(delta - (b - r.recOut)) <= tol) return b - r.recOut;   // cut on the beat
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
        const grow = TL.totalFrames({ ...this.project, cut }) - this.total;
        this._commit(cut, d.target, { audio: this._ripple(at, grow), ...this._rippleV2(at, grow) });
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
        case "b": case "s": this.split(); break;
        case "t": this.setTransition(this._nearestEdit(this._x(Math.floor(this.frame))), "dissolve"); break;
        case "r": this.keysMode = !this.keysMode; this._updateButtons(); this.requestDraw(); break;
        case ",": case "<": if (this.sel >= 0) this.slipClip(this.sel, e.shiftKey ? -5 : -1); else handled = false; break;
        case ".": case ">": if (this.sel >= 0) this.slipClip(this.sel, e.shiftKey ? 5 : 1); else handled = false; break;
        case "x": this.extract(); break;
        case "m": this.matchSelected(); break;
        case "[": case "]":
          if (this.aSel) {
            const a = this.project.audio.find((x) => x.id === this.aSel);
            this.updateAudioClip(this.aSel, { gain_db: a.gain_db + (lower === "]" ? 1 : -1) });
          } else handled = false;
          break;
        case "Delete": case "Backspace":
          if (this.tSel != null) this.removeTransition(this.tSel);
          else if (this.titleSel) this.removeTitle(this.titleSel);
          else if (this.subSel) { this._commit(this.project.cut, this.sel, { subtitles: this.project.subtitles.filter((c) => c.id !== this.subSel) }); this.subSel = null; this._inspect(); }
          else this.rippleDelete();
          break;
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

// ------------------------------------------------------------------ edit actions for the director (Milestone 15 can call these)

/**
 * The Cut's edit actions as callable functions: name, what it does, its arguments. runCutAction(panel, name, args)
 * runs one; every action is one undoable edit on the panel (⌘Z undoes what the director did).
 */
export const CUT_ACTIONS = [
  { name: "cut.split", description: "Add an edit at the playhead (or at frame)", params: { frame: "record frame, optional" } },
  { name: "cut.ripple_delete", description: "Delete clip `index` and close the gap", params: { index: "clip index" } },
  { name: "cut.trim", description: "Ripple-trim a clip's head or tail", params: { index: "clip index", side: "in|out", frames: "delta" } },
  { name: "cut.roll", description: "Roll the edit into clip `edit` by frames", params: { edit: "edit index", frames: "delta" } },
  { name: "cut.slip", description: "Slip clip `index` by source frames", params: { index: "clip index", frames: "delta" } },
  { name: "cut.move", description: "Move clip `from` to before clip `to`", params: { from: "index", to: "index" } },
  { name: "cut.transition", description: "Transition on an edit (0 = fade up from black, n = fade out)", params: { edit: "edit index", type: "dissolve|dip_black|dip_white|wipe", frames: "length" } },
  { name: "cut.remove_transition", description: "Remove the transition on an edit", params: { edit: "edit index" } },
  { name: "cut.opacity_keys", description: "Clip opacity keyframes", params: { index: "clip index", keys: "[[frame, 0..1], ...]" } },
  { name: "cut.volume_keys", description: "Audio clip volume keyframes (dB)", params: { id: "audio clip id", keys: "[[frame, dB], ...]" } },
  { name: "cut.add_audio", description: "Put a sound file on a track", params: { url: "url", label: "name", track: "1 dialogue, 2 SFX, 3 music, 4 ambience", start_frame: "frame" } },
  { name: "cut.generate_audio", description: "Generate an SFX / music cue / dialogue line in place at the playhead", params: { kind: "sfx|music|dialogue", text: "prompt or line", seconds: "length", character: "speaker (dialogue)" } },
  { name: "cut.auto_duck", description: "Duck the music under the dialogue", params: { depth_db: "-12" } },
  { name: "cut.beats", description: "Find the music's beat", params: { id: "audio clip id, optional" } },
  { name: "cut.cuts_to_beat", description: "Roll every cut onto the nearest beat", params: { tol: "frames" } },
  { name: "cut.assemble", description: "First cut from the ScriptSync lining", params: {} },
  { name: "cut.subtitles", description: "Subtitles from the typed dialogue lines", params: {} },
  { name: "cut.burn_subtitles", description: "Burn the subtitles into the render", params: { on: "true|false" } },
  { name: "cut.title", description: "Title card on V2", params: { text: "text", start_frame: "frame", frames: "length", style: "card|lower|center" } },
  { name: "cut.loudness", description: "Loudness target for the render", params: { target: "social|ebu|atsc|none" } },
  { name: "cut.render", description: "Render the cut (MP4, ProRes, or a 9:16 social cut)", params: { format: "mp4|prores", aspect: "source|9:16" } },
  { name: "cut.undo", description: "Undo the last edit", params: {} },
];

export async function runCutAction(panel, name, a = {}) {
  const p = panel.project;
  switch (name) {
    case "cut.split": if (a.frame != null) panel.seek(a.frame); return panel.split();
    case "cut.ripple_delete": panel.sel = a.index; panel.aSel = null; return panel.rippleDelete();
    case "cut.trim": return panel._commit(a.side === "in" ? TL.trimIn(p, a.index, a.frames) : TL.trimOut(p, a.index, a.frames), a.index);
    case "cut.roll": return panel._commit(TL.roll(p, a.edit, a.frames), a.edit);
    case "cut.slip": return panel.slipClip(a.index, a.frames);
    case "cut.move": return panel._commit(TL.moveEvent(p, a.from, a.to, { action: panel.action }), a.to, { audio: panel._audioAfterMove(TL.moveEvent(p, a.from, a.to, { action: panel.action }), a.from, a.to) });
    case "cut.transition": return panel.setTransition(a.edit, a.type || "dissolve", a.frames ?? null);
    case "cut.remove_transition": return panel.removeTransition(a.edit);
    case "cut.opacity_keys": return panel.setOpacityKeys(a.index, a.keys || null);
    case "cut.volume_keys": return panel.setVolumeKeys(a.id, a.keys || null);
    case "cut.add_audio": return panel.addAudioClip(a);
    case "cut.generate_audio": return panel.generateAudio(a);
    case "cut.auto_duck": return panel.autoDuck(a);
    case "cut.beats": return panel.analyzeBeats(a.id || null);
    case "cut.cuts_to_beat": return panel.snapCutsToBeats(a.tol ?? 6);
    case "cut.assemble": return panel.assembleScene();
    case "cut.subtitles": return panel.subtitlesFromDialogue();
    case "cut.burn_subtitles": return panel.setBurnSubtitles(a.on !== false);
    case "cut.title": return panel.addTitle(a);
    case "cut.loudness": panel.loudTarget = a.target === "none" ? null : a.target || "social"; return panel.loudTarget;
    case "cut.render": return panel.render(a);
    case "cut.undo": return panel.undo();
    default: throw new Error(`unknown cut action ${name}`);
  }
}
