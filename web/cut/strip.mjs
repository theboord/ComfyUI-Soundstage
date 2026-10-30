// Soundstage shot strip: the cut, always docked under the stage. One clip per camera setup, with its
// thumbnail (best render, else live clay). Click a clip and that setup becomes the stage's active shot,
// so you edit it right there. Drag to reorder, drag edges to trim, + Shot to add coverage, right-click for
// more. Space / J K L play the cut on the stage itself. The full Cut editor (audio, NLE export, detailed
// trims) opens from here and edits the same saved cut (node.properties.ss_cut).

import * as TL from "./timeline.mjs";
import { framesToTC, fpsInfo, recordStart } from "./exporters.mjs";
import { icon } from "../ui/icons.mjs";

export const SETUP_PRESETS = [
  ["master", "Master"], ["wide", "Wide"], ["two_shot", "Two-shot"], ["ots_a", "Over-the-shoulder A"],
  ["ots_b", "Over-the-shoulder B"], ["single_a", "Single A"], ["single_b", "Single B"], ["insert", "Insert"], ["pov", "POV"],
];
const RUNG_DOT = { clay: "rgba(240,239,237,.45)", look: "#7aa7ff", draft: "#b48cff", final: "#6be3a4" };
const DEFAULT_SECONDS = 3;
const EDGE = 7;
const SHUTTLE = [1, 2, 4, 8];

// ---------------------------------------------------------------- pure helpers (tests/js/strip.test.mjs)

/** node.properties.ss_cut -> {cut, audio?, audio_tracks?, excluded_shots?} (an array is the old cut-only form). */
export function readSaved(v) {
  if (Array.isArray(v)) return { cut: v };
  return v && typeof v === "object" ? { ...v } : {};
}

/**
 * Append setups to the end of a cut. Every setup shares the scene clock, so each new clip continues
 * the action where the previous one ends (pulled back if the take would run out). Length: the
 * Advisor's seconds when the setup has them, else 3 s.
 */
export function appendSetups(cut, ids, setups, { fps = 24, frames = 97 } = {}) {
  const out = (cut || []).map((e) => ({ ...e }));
  for (const id of ids) {
    const s = setups.find((x) => x.id === id);
    const len = TL.clamp(Math.round((s?.seconds || DEFAULT_SECONDS) * fps), Math.min(6, frames), frames);
    const prev = out[out.length - 1];
    const inF = prev ? Math.max(0, Math.min(prev.out, frames - len)) : 0;
    out.push({ shot_id: id, in: inF, out: Math.min(frames, inF + len) });
  }
  return out;
}

/**
 * Reconcile a saved cut with the stage's setups, both ways:
 * - clips of deleted setups leave the cut;
 * - a setup that was in the cut (lastIds) and is now out of it was removed on purpose: remember it in
 *   excluded_shots, so it is not added back;
 * - every other setup that is not in the cut yet is appended, in stage order.
 * Returns {cut, excluded_shots, added, removed, changed}.
 */
export function syncCut(saved, setups, { fps = 24, frames = 97, lastIds = null } = {}) {
  const ids = new Set(setups.map((s) => s.id));
  const before = saved.cut || [];
  let cut = before.filter((e) => ids.has(String(e.shot_id))).map((e) => ({ ...e, shot_id: String(e.shot_id) }));
  const removed = [...new Set(before.filter((e) => !ids.has(String(e.shot_id))).map((e) => String(e.shot_id)))];
  const inCut = new Set(cut.map((e) => e.shot_id));
  const excluded = new Set((saved.excluded_shots || []).map(String).filter((id) => ids.has(id) && !inCut.has(id)));
  if (lastIds) for (const id of lastIds) if (ids.has(id) && !inCut.has(id)) excluded.add(id);
  const added = setups.map((s) => s.id).filter((id) => !inCut.has(id) && !excluded.has(id));
  cut = appendSetups(cut, added, setups, { fps, frames });
  const excludedList = [...excluded];
  const changed = removed.length > 0 || added.length > 0 ||
    JSON.stringify(excludedList.sort()) !== JSON.stringify([...(saved.excluded_shots || [])].map(String).sort());
  return { cut, excluded_shots: excludedList, added, removed, changed };
}

const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
};
const r3 = (a) => a.map((x) => +x.toFixed(3));

/**
 * A camera for a coverage preset, framed on the first two actors at their positions now
 * ({id, position:[x,y,z], height_m} each) and kept on the same side of the line as the current camera
 * (180-degree rule). Returns {position, target, focal_mm}, or null when there is nobody to frame.
 */
export function presetCamera(setup, actors, currentCam) {
  if (!actors.length) return null;
  const eye = (a) => 0.92 * (a.height_m || 1.75);
  const A = actors[0];
  let B = actors[1];
  const pa = [A.position[0], 0, A.position[2]];
  if (!B) { // one subject: the "other side" is where the camera looks from
    const look = v3.norm([currentCam.position[0] - pa[0], 0, currentCam.position[2] - pa[2]]);
    B = { position: v3.add(pa, v3.mul(look, 2)), height_m: A.height_m || 1.75 };
  }
  const pb = [B.position[0], 0, B.position[2]];
  const mid = v3.mul(v3.add(pa, pb), 0.5);
  const d = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]) || 1;
  const u = v3.norm(v3.sub(pb, pa));
  let n = [-u[2], 0, u[0]];
  if (v3.dot(v3.sub([currentCam.position[0], 0, currentCam.position[2]], mid), n) < 0) n = v3.mul(n, -1);
  const distFor = (width, focal) => width / 2 / (18 / focal); // 36 mm wide sensor
  const at = (p, y) => [p[0], y, p[2]];
  const ea = eye(A), eb = eye(B);
  const S = {
    master: () => ({ position: at(v3.add(mid, v3.mul(n, distFor(d + 2.2, 32))), 1.6), target: at(mid, 1.3), focal_mm: 32 }),
    wide: () => ({ position: at(v3.add(mid, v3.mul(n, distFor(d + 5, 24))), 1.7), target: at(mid, 1.2), focal_mm: 24 }),
    two_shot: () => ({ position: at(v3.add(mid, v3.mul(n, distFor(d + 1.2, 40))), (ea + eb) / 2 - 0.05),
                       target: at(mid, (ea + eb) / 2 - 0.15), focal_mm: 40 }),
    ots_a: () => ({ position: at(v3.add(v3.add(pa, v3.mul(u, -1.2)), v3.mul(n, 0.65)), ea + 0.12), target: at(pb, eb - 0.05), focal_mm: 45 }),
    ots_b: () => ({ position: at(v3.add(v3.add(pb, v3.mul(u, 1.2)), v3.mul(n, 0.65)), eb + 0.12), target: at(pa, ea - 0.05), focal_mm: 45 }),
    single_a: () => ({ position: at(v3.add(pa, v3.mul(v3.norm(v3.add(u, v3.mul(n, 0.9))), 2.0)), ea), target: at(pa, ea), focal_mm: 65 }),
    single_b: () => ({ position: at(v3.add(pb, v3.mul(v3.norm(v3.add(v3.mul(u, -1), v3.mul(n, 0.9))), 2.0)), eb), target: at(pb, eb), focal_mm: 65 }),
    insert: () => ({ position: at(v3.add(mid, v3.mul(n, 0.8)), 1.3), target: at(mid, 0.85), focal_mm: 85 }),
    pov: () => ({ position: at(v3.add(pa, v3.mul(u, 0.12)), ea), target: at(pb, eb), focal_mm: 28 }),
  };
  const cam = (S[setup] || S.master)();
  return { position: r3(cam.position), target: r3(cam.target), focal_mm: cam.focal_mm };
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- styles

const CSS = `
.ss-strip{--a:var(--ss-accent,#f2ff59);--ln:var(--ss-line,rgba(255,255,255,.08));--card:var(--ss-card,rgba(255,255,255,.04));
  --raised:var(--ss-raised,#2a2330);--tx:var(--ss-text,#f0efed);--mut:var(--ss-muted,rgba(240,239,237,.56));
  display:flex;flex-direction:column;gap:3px;background:var(--card);border:1px solid var(--ln);border-radius:12px;padding:4px 8px;
  color:var(--tx);font-size:12px;outline:none;user-select:none;min-width:0;position:relative;box-sizing:border-box}
.ss-strip:focus-visible{border-color:var(--a)}
.ss-strip-bar{display:flex;align-items:center;gap:6px;min-width:0;height:24px}
.ss-strip .ss-strip-bar button{padding:2px 10px !important;height:22px;font-size:12px !important}
.ss-strip .ss-strip-bar button.ss-strip-icon{padding:3px 7px !important}
.ss-strip-tc{font:500 12px/1 ui-monospace,Menlo,monospace;color:var(--tx);font-variant-numeric:tabular-nums;white-space:nowrap}
.ss-strip-tc small{color:var(--mut);font-size:11px}
.ss-strip-grow{flex:1;min-width:4px}
.ss-strip-info{color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ss-strip.ss-narrow .ss-strip-lbl,.ss-strip.ss-narrow .ss-strip-info{display:none}
.ss-strip.ss-tiny .ss-strip-tc small,.ss-strip.ss-tiny .ss-strip-undo{display:none}
.ss-strip-bar{overflow:hidden}
.ss-strip-scroll{overflow-x:auto;overflow-y:hidden;scrollbar-width:none;position:relative}
.ss-strip-scroll::-webkit-scrollbar{display:none}
.ss-strip-inner{position:relative;height:55px;min-width:100%}
.ss-strip-ruler{position:absolute;left:0;right:0;top:0;height:11px;cursor:ew-resize}
.ss-strip-ruler canvas{display:block;height:11px}
.ss-strip-track{position:absolute;left:0;right:0;top:12px;height:43px}
.ss-strip-clip{position:absolute;top:0;height:43px;border-radius:8px;overflow:hidden;background:#17121b;border:1px solid var(--ln);
  box-sizing:border-box;cursor:grab;transition:left .18s cubic-bezier(.2,.8,.2,1),width .18s cubic-bezier(.2,.8,.2,1),border-color .12s,box-shadow .12s}
.ss-strip-clip.ss-nolerp{transition:border-color .12s,box-shadow .12s}
.ss-strip-clip:hover{border-color:rgba(255,255,255,.22)}
.ss-strip-clip.ss-active{border:2px solid var(--a);box-shadow:0 0 0 3px rgba(242,255,89,.14)}
.ss-strip-clip.ss-drag{z-index:5;cursor:grabbing;box-shadow:0 10px 26px rgba(0,0,0,.55);opacity:.92}
.ss-strip-clip .ss-strip-film{position:absolute;inset:0;background-repeat:repeat-x;background-size:auto 100%;background-position:left center;opacity:.92}
.ss-strip-clip .ss-strip-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,.72))}
.ss-strip-clip .ss-strip-name{position:absolute;left:7px;right:7px;bottom:15px;font-weight:600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000}
.ss-strip-clip .ss-strip-dur{position:absolute;left:7px;bottom:3px;font:500 10px/12px ui-monospace,Menlo,monospace;color:rgba(255,255,255,.78)}
.ss-strip-clip .ss-strip-dot{position:absolute;right:6px;bottom:5px;width:7px;height:7px;border-radius:50%}
.ss-strip-clip .ss-strip-more{position:absolute;right:3px;top:3px;width:20px;height:18px;border-radius:6px;display:none;align-items:center;justify-content:center;
  background:rgba(33,25,39,.78);color:var(--tx);cursor:pointer}
.ss-strip-clip:hover .ss-strip-more,.ss-strip-clip.ss-active .ss-strip-more{display:flex}
.ss-strip-clip .ss-strip-h{position:absolute;top:0;bottom:0;width:${EDGE}px;cursor:ew-resize}
.ss-strip-clip .ss-strip-h.l{left:0}.ss-strip-clip .ss-strip-h.r{right:0}
.ss-strip-clip:hover .ss-strip-h::after{content:"";position:absolute;top:10px;bottom:10px;left:2px;width:3px;border-radius:2px;background:var(--a)}
.ss-strip-clip.ss-narrowclip .ss-strip-name,.ss-strip-clip.ss-narrowclip .ss-strip-dur{display:none}
.ss-strip-play{position:absolute;top:0;width:2px;height:55px;margin-left:-1px;background:var(--a);pointer-events:none;z-index:6}
.ss-strip-play::before{content:"";position:absolute;top:0;left:-4px;border:5px solid transparent;border-top:6px solid var(--a)}
.ss-strip-ins{position:absolute;top:10px;width:3px;height:50px;margin-left:-1.5px;background:var(--a);border-radius:2px;z-index:7;pointer-events:none}
.ss-strip-empty{position:absolute;inset:12px 0 0 0;display:flex;align-items:center;justify-content:center;color:var(--mut);border:1px dashed var(--ln);border-radius:8px}
.ss-strip-menu{position:absolute;z-index:20;min-width:190px;max-height:260px;overflow:auto;background:rgba(33,25,39,.97);border:1px solid rgba(255,255,255,.16);
  border-radius:12px;padding:5px;box-shadow:0 16px 40px rgba(0,0,0,.6);backdrop-filter:blur(8px)}
.ss-strip .ss-strip-menu button{display:flex !important;width:100%;justify-content:flex-start;background:transparent !important;border:1px solid transparent !important;
  border-radius:8px !important;padding:5px 9px !important;gap:8px;color:var(--tx) !important;font-size:12px !important}
.ss-strip .ss-strip-menu button:hover:not(:disabled){background:rgba(255,255,255,.07) !important}
.ss-strip .ss-strip-menu button.ss-danger{color:var(--ss-danger,#ff7a7a) !important}
.ss-strip-menu hr{border:0;border-top:1px solid var(--ln);margin:4px 2px}
.ss-strip-menu .ss-strip-mh{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:4px 9px 2px}
`;

function injectCSS() {
  if (document.getElementById("ss-strip-css")) return;
  const s = document.createElement("style");
  s.id = "ss-strip-css";
  s.textContent = CSS;
  // before the theme sheet (if it's there), so theme rules on buttons win ties like everywhere else
  const theme = document.getElementById("soundstage-theme");
  if (theme) theme.before(s); else document.head.appendChild(s);
}

// Wheel over the strip scrolls / zooms the strip instead of the ComfyUI canvas.
let wheelRouter = false;
function installWheelRouter() {
  if (wheelRouter) return;
  wheelRouter = true;
  window.addEventListener("wheel", (e) => {
    const root = e.target?.closest?.(".ss-strip");
    if (!root || !root.__strip) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    root.__strip._onWheel(e);
  }, { capture: true, passive: false });
}

const h = (tag, cls, attrs = {}) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v; else if (k === "title") el.title = v; else el.setAttribute(k, v);
  }
  return el;
};

// ---------------------------------------------------------------- the strip

export class ShotStrip {
  /**
   * @param {HTMLElement} container
   * @param {{stage: object, api?: object, getRenders?: () => Record<string, {look?, draft?, final?}>,
   *   onSelect?: (setupId: string, clip: object) => void, onStatus?: (msg: string) => void,
   *   load?: () => any, save?: (saved: object) => void, onOpenEditor?: () => void,
   *   renderPreviewFrame?: (setupId: string, frame: number) => CanvasImageSource}} opts
   * load/save: the shared saved cut ({cut, audio, audio_tracks, excluded_shots}, node.properties.ss_cut).
   */
  constructor(container, { stage, api = null, getRenders = null, onSelect = null, onStatus = null, load = null, save = null,
                           onOpenEditor = null, renderPreviewFrame = null, onEditShot = null } = {}) {
    injectCSS();
    installWheelRouter();
    this.stage = stage;
    this.api = api;
    this._getRenders = getRenders || (() => ({}));
    this._onSelect = onSelect || (() => {});
    this._status = onStatus || (() => {});
    this._load = load;
    this._save = save;
    this._onOpenEditor = onOpenEditor;
    this._onEditShot = onEditShot;   // "edit original" (Dynamic Link style): jump to the step that made this clip
    this._renderPreview = renderPreviewFrame || ((id, f) => this._clay(id, f));
    this._mem = {}; // saved cut when no load/save is given
    this.saved = readSaved(load ? load() : this._mem);
    this.frame = 0;
    this.speed = 0;
    this.fit = true;
    this.ppf = 2;
    this.undoStack = [];
    this.redoStack = [];
    this._eids = [];
    this._nextEid = 1;
    this._els = new Map(); // eid -> clip element
    this._thumbs = new Map(); // key -> canvas
    this._thumbQueue = [];
    this._drag = null;
    this._lastIds = null;
    this._sig = "";
    this._autoAdded = new Map(); // setup id -> JSON of the clip sync generated (re-timed while untouched)
    this._build(container);
    // Chain the stage's shots callback for instant sync; a light poll covers anything else.
    const prev = stage.onShots;
    stage.onShots = (...a) => { prev?.(...a); if (!this._suspend) this.sync(); };
    this._poll = setInterval(() => this._tickPoll(), 400);
    this.sync({ initial: true });
    this.render();
  }

  // ------------------------------------------------------------------ public

  /** Re-read the saved cut (after the full Cut editor changed it) and redraw. */
  refresh() {
    if (this._load) this.saved = readSaved(this._load());
    this._reconcileEids();
    this.sync();
    this.render();
  }

  /**
   * Append setups to the cut in this order (the Advisor's "Add as setups" hook), timed by the Advisor's
   * seconds. Setups the strip already auto-appended and nobody touched since are re-timed and re-ordered.
   */
  appendShots(ids, { seconds = null } = {}) {
    ids = ids.map(String);
    const cut0 = this.saved.cut || [];
    const untouched = (id) => {
      const g = this._autoAdded.get(id), evs = cut0.filter((e) => String(e.shot_id) === id);
      return g && evs.length === 1 && JSON.stringify(evs[0]) === g;
    };
    const redo = new Set(ids.filter(untouched));
    const keep = cut0.map((e, i) => [e, this._eids[i]]).filter(([e]) => !redo.has(String(e.shot_id)));
    const inCut = new Set(keep.map(([e]) => String(e.shot_id)));
    const todo = ids.filter((id) => !inCut.has(id));
    if (!todo.length) return;
    const setups = this._setups().map((s) => (seconds && seconds[s.id] ? { ...s, seconds: seconds[s.id] } : s));
    const { fps, frames } = this._clock();
    const cut = appendSetups(keep.map(([e]) => e), todo, setups, { fps, frames });
    this._eids = [...keep.map(([, k]) => k), ...todo.map(() => this._nextEid++)];
    for (const id of todo) this._autoAdded.delete(id);
    const excluded = (this.saved.excluded_shots || []).filter((id) => !todo.includes(String(id)));
    this._set({ cut, excluded_shots: excluded });
    this._status(`Added ${todo.length} shot${todo.length === 1 ? "" : "s"} to the cut.`);
  }

  /** The saved cut ({cut, audio, audio_tracks, excluded_shots}). */
  getSaved() {
    return JSON.parse(JSON.stringify(this.saved));
  }

  play(speed = 1) {
    const total = this._total();
    if (!total) return;
    if (speed > 0 && this.frame >= total - 1) this.frame = 0;
    if (speed < 0 && this.frame <= 0) this.frame = total - 1;
    this.speed = speed;
    this._last = 0;
    this._updatePlayBtn();
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  stop() {
    if (!this.speed) return;
    this.speed = 0;
    this.frame = Math.floor(this.frame);
    cancelAnimationFrame(this._raf);
    this._updatePlayBtn();
  }

  togglePlay() { this.speed ? this.stop() : this.play(1); }

  shuttle(dir) {
    const cur = Math.abs(this.speed);
    this.play(dir * (Math.sign(this.speed) === dir ? SHUTTLE[Math.min(SHUTTLE.length - 1, SHUTTLE.indexOf(cur) + 1)] : 1));
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
  }

  dispose() {
    this.stop();
    clearInterval(this._poll);
    this._ro?.disconnect();
    this.root.remove();
  }

  // ------------------------------------------------------------------ model

  _clock() {
    const sh = this.stage.state?.shot || {};
    return { fps: sh.fps || 24, frames: Math.max(2, sh.frames || 97) };
  }

  /** Stage setups: [{id, name, setup, seconds}]. */
  _setups() {
    const shots = this.stage.state?.shots?.length ? this.stage.state.shots : [this.stage.activeShot()];
    return shots.map((s) => ({ id: String(s.id), name: s.name || s.id, setup: s.setup || "", seconds: s.advisor?.seconds || null }));
  }

  _activeId() {
    return String(this.stage.state?.active_shot || this.stage.activeShot?.()?.id || "");
  }

  /** The cut as a full project (timeline.mjs shape), shots built from the stage setups. */
  _project() {
    const { fps, frames } = this._clock();
    const renders = this._getRenders() || {};
    return TL.normalizeProject({
      fps, cut: this.saved.cut || [], audio: this.saved.audio || [], audio_tracks: this.saved.audio_tracks || [],
      shots: this._setups().map((s) => ({ id: s.id, name: s.name, frames, scene_name: "SC1", setup: s.setup, renders: renders[s.id] || {} })),
    });
  }

  _total() { return TL.totalFrames(this._project()); }

  _snapshot() { return JSON.parse(JSON.stringify({ saved: this.saved, eids: this._eids })); }

  _restore(snap) {
    this.saved = snap.saved;
    this._eids = snap.eids;
    this._persist();
    this.render();
  }

  /** One edit: patch the saved cut, persist, redraw. eids: the event ids after the edit, when known. */
  _set(patch, { undo = true, eids = null } = {}) {
    if (undo) {
      this.undoStack.push(this._snapshot());
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
    this.saved = { ...this.saved, ...patch };
    if (eids) this._eids = eids;
    this._reconcileEids();
    this._lastIds = new Set((this.saved.cut || []).map((e) => String(e.shot_id)));
    this._persist();
    this.render();
  }

  _persist() {
    if (this._save) this._save(this.getSaved());
    else this._mem = this.getSaved();
  }

  /** Keep one stable id per cut event, so clips animate instead of being rebuilt. */
  _reconcileEids() {
    const cut = this.saved.cut || [];
    if (this._eids.length === cut.length) return;
    const old = this._eidMeta || [];
    const used = new Set();
    this._eids = cut.map((e) => {
      const hit = old.find((o) => !used.has(o.eid) && o.shot_id === String(e.shot_id) && o.in === e.in && o.out === e.out)
        || old.find((o) => !used.has(o.eid) && o.shot_id === String(e.shot_id));
      const eid = hit ? hit.eid : this._nextEid++;
      used.add(eid);
      return eid;
    });
  }

  /** Reconcile with the stage (new setups append, deleted ones leave). */
  sync({ initial = false } = {}) {
    const setups = this._setups();
    const { fps, frames } = this._clock();
    if (initial) this._lastIds = new Set((this.saved.cut || []).map((e) => String(e.shot_id)));
    const res = syncCut(this.saved, setups, { fps, frames, lastIds: this._lastIds });
    this._sig = this._setupSig();
    if (res.changed) {
      this._set({ cut: res.cut, excluded_shots: res.excluded_shots }, { undo: !initial });
      for (const id of res.added) {
        const ev = res.cut.filter((e) => e.shot_id === id);
        if (ev.length === 1) this._autoAdded.set(id, JSON.stringify(ev[0]));
      }
      if (res.added.length && !initial) this._status(`${res.added.length === 1 ? "New setup" : `${res.added.length} new setups`} added to the cut.`);
    } else {
      this._lastIds = new Set(res.cut.map((e) => e.shot_id));
    }
  }

  _setupSig() {
    return this._setups().map((s) => `${s.id}:${s.name}:${s.setup}`).join("|");
  }

  // ------------------------------------------------------------------ DOM

  _build(container) {
    const root = (this.root = h("div", "ss-strip", { tabindex: "0" }));
    root.__strip = this;
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keyup", "keypress", "contextmenu"]) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    root.addEventListener("pointerdown", (e) => { if (!e.target.closest(".ss-strip-menu")) this._closeMenu(); root.focus({ preventScroll: true }); });
    root.addEventListener("keydown", (e) => this._onKey(e));

    const bar = h("div", "ss-strip-bar");
    const btn = (iconName, label, title, fn, cls = "") => {
      const b = h("button", cls, { type: "button", title });
      b.append(icon(iconName, 14));
      if (label) b.append(h("span", "ss-strip-lbl", { text: label }));
      if (!label) b.classList.add("ss-strip-icon");
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(e, b); });
      bar.append(b);
      return b;
    };
    this.addBtn = btn("plus", "Shot", "Add a camera setup to the stage and the cut", (e, b) => this._addMenu(b), "ss-primary");
    this.playBtn = btn("play", "", "Play the cut on the stage (Space · J K L)", () => this.togglePlay());
    this.tcEl = h("span", "ss-strip-tc");
    bar.append(this.tcEl);
    this.infoEl = h("span", "ss-strip-info");
    bar.append(h("span", "ss-strip-grow"), this.infoEl);
    btn("undo-2", "", "Undo (⌘Z)", () => this.undo(), "ss-strip-undo");
    btn("maximize-2", "Editor", "Open the full Cut editor: audio tracks, NLE export, detailed trims",
      () => this._onOpenEditor ? this._onOpenEditor() : this._status("The full editor is the Cut tab."));

    const scroll = (this.scroll = h("div", "ss-strip-scroll"));
    const inner = (this.inner = h("div", "ss-strip-inner"));
    const ruler = (this.ruler = h("div", "ss-strip-ruler"));
    this.rulerCanvas = h("canvas");
    ruler.append(this.rulerCanvas);
    this.track = h("div", "ss-strip-track");
    this.playEl = h("div", "ss-strip-play");
    this.insEl = h("div", "ss-strip-ins");
    this.insEl.hidden = true;
    this.emptyEl = h("div", "ss-strip-empty", { text: "No shots in the cut yet: + Shot, or add the Advisor's shots" });
    inner.append(ruler, this.track, this.playEl, this.insEl, this.emptyEl);
    scroll.append(inner);
    root.append(bar, scroll);
    container.appendChild(root);

    ruler.addEventListener("pointerdown", (e) => this._scrubStart(e));
    this.track.addEventListener("pointerdown", (e) => { if (e.target === this.track) this._scrubStart(e); });
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(root);
  }

  _x(f) { return f * this.ppf; }

  render() {
    if (!this.root) return;
    const rw = this.root.clientWidth;
    if (rw) {
      this.root.classList.toggle("ss-narrow", rw < 460);
      this.root.classList.toggle("ss-tiny", rw < 320);
    }
    this._reconcileEids();
    const p = this._project();
    const rows = TL.layout(p);
    const total = TL.totalFrames(p);
    const vw = this.scroll.clientWidth || 300;
    if (this.fit || !total) this.ppf = Math.max(0.05, (vw - 2) / Math.max(total, 24));
    const width = Math.max(vw, Math.ceil(total * this.ppf) + 2);
    this.inner.style.width = width + "px";
    this.emptyEl.hidden = rows.length > 0;
    const active = this._activeId();
    const d = this._drag;

    // preview order while dragging a clip
    let order = rows.map((r) => r.index);
    if (d && d.mode === "move" && d.target != null) {
      order = order.filter((i) => i !== d.idx);
      order.splice(d.target > d.idx ? d.target - 1 : d.target, 0, d.idx);
    }
    let x = 0;
    const pos = new Map();
    for (const i of order) { pos.set(i, x); x += rows[i].len * this.ppf; }

    const live = new Set();
    rows.forEach((r) => {
      const eid = this._eids[r.index];
      live.add(eid);
      let el = this._els.get(eid);
      if (!el) { el = this._makeClip(eid); this.track.append(el); this._els.set(eid, el); }
      const w = Math.max(3, r.len * this.ppf - 2);
      const dragging = d && d.mode === "move" && d.idx === r.index;
      el.classList.toggle("ss-drag", !!dragging);
      el.classList.toggle("ss-nolerp", !!dragging || !!(d && d.mode === "trim"));
      el.style.left = (dragging ? d.x - d.grab : pos.get(r.index) + 1) + "px";
      el.style.width = w + "px";
      el.dataset.index = String(r.index);
      el.classList.toggle("ss-active", r.shot.id === active);
      el.classList.toggle("ss-narrowclip", w < 46);
      el._name.textContent = r.shot.name;
      el._dur.textContent = this._dur(r.len);
      el.title = `${r.shot.name}${r.shot.setup ? ` · ${r.shot.setup}` : ""}\n${this._dur(r.len)}  (frames ${r.in}-${r.out - 1})\n` +
        "Click: edit this setup on the stage · drag: reorder · edges: trim · right-click: more";
      const rung = TL.bestRung(r.shot);
      el._dot.style.background = RUNG_DOT[rung];
      el._dot.title = rung;
      this._paintThumb(el, r);
    });
    for (const [eid, el] of this._els) if (!live.has(eid)) { el.remove(); this._els.delete(eid); }

    this._eidMeta = rows.map((r) => ({ eid: this._eids[r.index], shot_id: r.shot.id, in: r.in, out: r.out }));
    this._drawRuler(width, total);
    this._placePlayhead();
    const n = rows.length, setups = this._setups().length;
    this.infoEl.textContent = `${n} clip${n === 1 ? "" : "s"} · ${setups} setup${setups === 1 ? "" : "s"}`;
  }

  _makeClip(eid) {
    const el = h("div", "ss-strip-clip");
    el.dataset.eid = String(eid);
    const c = h("span", "ss-strip-film");
    el._film = c;
    el._name = h("span", "ss-strip-name");
    el._dur = h("span", "ss-strip-dur");
    el._dot = h("span", "ss-strip-dot");
    const more = h("span", "ss-strip-more", { title: "More" });
    more.append(icon("sliders-horizontal", 12));
    more.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
    more.addEventListener("click", (e) => { e.stopPropagation(); this._clipMenu(Number(el.dataset.index), e); });
    const hl = h("span", "ss-strip-h l"), hr = h("span", "ss-strip-h r");
    el.append(c, h("span", "ss-strip-shade"), el._name, el._dur, el._dot, more, hl, hr);
    el.addEventListener("pointerdown", (e) => this._clipDown(e, el));
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this._clipMenu(Number(el.dataset.index), e); });
    el.addEventListener("dblclick", (e) => { e.stopPropagation(); const r = TL.layout(this._project())[Number(el.dataset.index)]; if (r) this._seek(r.recIn); });
    return el;
  }

  _drawRuler(width, total) {
    const c = this.rulerCanvas, dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(width * dpr)) { c.width = Math.round(width * dpr); c.height = Math.round(11 * dpr); c.style.width = width + "px"; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, 11);
    const { fps } = this._clock();
    const steps = [1, 2, 6, 12, 24, 48, 120, 240, 480, 1440];
    const major = steps.find((s) => s * this.ppf >= 60) || 1440;
    g.fillStyle = "rgba(240,239,237,.28)";
    g.font = "9px ui-monospace, Menlo, monospace";
    g.textBaseline = "top";
    for (let f = 0; f <= total; f += major / (major >= 24 ? 4 : 2)) {
      const x = Math.round(this._x(f)) + 0.5;
      const isMajor = f % major === 0;
      g.fillRect(x, isMajor ? 3 : 7, 1, isMajor ? 8 : 4);
      if (isMajor && f) g.fillText(f % fps === 0 ? `${f / fps}s` : `${f}f`, x + 3, 0);
    }
  }

  _placePlayhead() {
    const total = this._total();
    this.playEl.hidden = !total;
    this.playEl.style.left = this._x(Math.min(this.frame, Math.max(0, total))) + "px";
    const { fps } = this._clock();
    const base = fpsInfo(fps).base;
    this.tcEl.innerHTML = "";
    this.tcEl.append(framesToTC(recordStart(base) + Math.floor(this.frame), base).slice(3),
      h("small", "", { text: ` / ${this._dur(total)}` }));
  }

  _updatePlayBtn() {
    this.playBtn.replaceChildren(icon(this.speed ? "pause" : "play", 14));
    this.playBtn.setAttribute("aria-pressed", String(!!this.speed));
  }

  _dur(frames) {
    const { fps } = this._clock();
    const b = fpsInfo(fps).base;
    return `${Math.floor(frames / b)}:${String(frames % b).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------------ thumbnails

  _camHash(id) {
    const s = (this.stage.state?.shots || []).find((x) => String(x.id) === id);
    return fnv(JSON.stringify(s?.camera_keys || "") + this._sceneHash);
  }

  _paintThumb(el, r) {
    const url = r.shot.renders.final || r.shot.renders.draft || r.shot.renders.look || "";
    const f = Math.min(r.shot.frames - 1, r.in + Math.floor(r.len / 3));
    const key = `${r.shot.id}|${url ? url : f}|${url ? "" : this._camHash(r.shot.id)}`;
    if (el._thumbKey === key) return;
    const cached = this._thumbs.get(key);
    if (cached) {
      el._film.style.backgroundImage = `url(${cached})`;
      el._thumbKey = key;
      return;
    }
    if (!this._thumbQueue.some((q) => q.key === key)) this._thumbQueue.push({ key, id: r.shot.id, frame: f, url, renders: r.shot.renders });
    this._pumpThumbs();
  }

  _pumpThumbs() {
    if (this._pumping || this.speed || !this._thumbQueue.length) return;
    this._pumping = true;
    const job = this._thumbQueue.shift();
    const done = (src) => {
      if (src) {
        const c = document.createElement("canvas");
        c.width = 160; c.height = 90;
        const g = c.getContext("2d");
        const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
        if (sw && sh) {
          const s = Math.max(160 / sw, 90 / sh);
          g.drawImage(src, (160 - sw * s) / 2, (90 - sh * s) / 2, sw * s, sh * s);
        }
        this._thumbs.set(job.key, c.toDataURL("image/jpeg", 0.8));
        if (this._thumbs.size > 120) this._thumbs.delete(this._thumbs.keys().next().value);
        for (const el of this._els.values()) {
          const r = TL.layout(this._project())[Number(el.dataset.index)];
          if (r && r.shot.id === job.id) { el._thumbKey = null; this._paintThumb(el, r); }
        }
      }
      this._pumping = false;
      setTimeout(() => this._pumpThumbs(), 40);
    };
    const { fps } = this._clock();
    if (!job.url) {
      let src = null;
      try { src = this._renderPreview(job.id, job.frame); } catch { src = null; }
      done(src);
    } else if (job.url === job.renders.look && !job.renders.draft && !job.renders.final) {
      const img = new Image();
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = job.url;
    } else {
      const v = document.createElement("video");
      v.muted = true; v.preload = "auto"; v.playsInline = true;
      const fail = setTimeout(() => done(null), 6000);
      v.addEventListener("loadeddata", () => { v.currentTime = (job.frame + 0.5) / fps; }, { once: true });
      v.addEventListener("seeked", () => { clearTimeout(fail); done(v); v.removeAttribute("src"); v.load(); }, { once: true });
      v.addEventListener("error", () => { clearTimeout(fail); done(null); }, { once: true });
      v.src = job.url;
    }
  }

  /** Clay frame of any setup, without switching the stage UI to it. */
  _clay(id, frame) {
    const st = this.stage;
    if (!st.renderFrameTo) return null;
    const prev = st.state.active_shot;
    st.state.active_shot = id;
    try { return st.renderFrameTo("clay", frame); } finally { st.state.active_shot = prev; }
  }

  // ------------------------------------------------------------------ polling (stage -> strip)

  _tickPoll() {
    if (!this.root.isConnected) return;
    if (this._setupSig() !== this._sig && !this._suspend) this.sync();
    // stage edits re-render thumbnails (camera keys per setup + the set itself)
    const st = this.stage.state || {};
    const sceneHash = fnv(JSON.stringify([st.actors, st.environment, st.lights, st.time_of_day]));
    const active = this._activeId();
    const followed = this._followStage();
    if (sceneHash !== this._sceneHash || active !== this._lastActive || followed) {
      this._sceneHash = sceneHash;
      this._lastActive = active;
      this.render();
    }
    // Advisor shots: the seconds tag lands just after the setup is made; re-time the clips sync appended
    const { fps } = this._clock();
    const retime = (this.saved.cut || []).map((e) => String(e.shot_id)).filter((id) => {
      const g = this._autoAdded.get(id);
      const s = this._setups().find((x) => x.id === id);
      if (!g || !s?.seconds) return false;
      const ev = JSON.parse(g);
      return ev.out - ev.in !== Math.round(s.seconds * fps);
    });
    if (retime.length) this.appendShots(retime);
    // renders arriving
    const rs = fnv(JSON.stringify(this._getRenders() || {}));
    if (rs !== this._rendersHash) { this._rendersHash = rs; this.render(); }
  }

  /** When the user scrubs the stage on a setup that is in the cut, keep the playhead on it. */
  _followStage() {
    if (this.speed || this._drag || this._driving) return false;
    const id = this._activeId(), f = this.stage.frame || 0;
    if (id === this._fId && f === this._fF) return false;
    this._fId = id; this._fF = f;
    const rows = TL.layout(this._project());
    const cur = TL.eventAt(this._project(), Math.floor(this.frame));
    const row = (cur && cur.shot.id === id && f >= cur.in && f < cur.out) ? cur
      : rows.find((r) => r.shot.id === id && f >= r.in && f < r.out);
    if (!row) return false;
    this.frame = row.recIn + (f - row.in);
    this._placePlayhead();
    return false;
  }

  // ------------------------------------------------------------------ playback (drives the stage)

  _tick(now) {
    if (!this.speed) return;
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 0;
    this._last = now;
    const { fps } = this._clock();
    const total = this._total();
    let f = this.frame + this.speed * fps * dt;
    if (f >= total) { f = total - 1; this.frame = f; this._showOnStage(); this.stop(); this._placePlayhead(); return; }
    if (f < 0) { f = 0; this.frame = 0; this._showOnStage(); this.stop(); this._placePlayhead(); return; }
    this.frame = f;
    this._showOnStage();
    this._placePlayhead();
    this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  /** Put the stage on the clip under the playhead, at its source frame. */
  _showOnStage() {
    const p = this._project();
    const row = TL.eventAt(p, Math.floor(this.frame)) || TL.layout(p).at(-1);
    if (!row) return;
    this._driving = true;
    try {
      if (row.shot.id !== this._activeId()) { this._suspend = true; this.stage.setActiveShot(row.shot.id); this._suspend = false; this.render(); }
      const src = Math.min(row.out - 1, row.in + Math.floor(this.frame) - row.recIn);
      this.stage.setFrame(src);
      this._fId = row.shot.id; this._fF = this.stage.frame;
    } finally { this._driving = false; this._suspend = false; }
  }

  _seek(f) {
    const total = this._total();
    this.frame = TL.clamp(Math.round(f), 0, Math.max(0, total - 1));
    this._showOnStage();
    this._placePlayhead();
  }

  _scrubStart(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.stop();
    const move = (ev) => {
      const r = this.inner.getBoundingClientRect();
      this._seek((ev.clientX - r.left) / this.ppf);
    };
    move(e);
    const up = () => { window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  // ------------------------------------------------------------------ clip interaction

  _select(index) {
    const p = this._project();
    const row = TL.layout(p)[index];
    if (!row) return;
    this._suspend = true;
    try { if (row.shot.id !== this._activeId()) this.stage.setActiveShot(row.shot.id); } finally { this._suspend = false; }
    const inside = this.frame >= row.recIn && this.frame < row.recOut;
    if (!inside) this.frame = row.recIn;
    this._showOnStage();
    this.render();
    this._onSelect(row.shot.id, { index, in: row.in, out: row.out, recIn: row.recIn, recOut: row.recOut });
  }

  _clipDown(e, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this._closeMenu();
    this.stop();
    const index = Number(el.dataset.index);
    const p = this._project();
    const row = TL.layout(p)[index];
    const ir = this.inner.getBoundingClientRect();
    const x = e.clientX - ir.left;
    const edge = e.target.classList.contains("ss-strip-h") ? (e.target.classList.contains("l") ? "in" : "out") : null;
    const d = { idx: index, startX: x, x, grab: x - this._x(row.recIn), mode: edge ? "trim" : "pending", side: edge,
                base: this.saved.cut, baseAudio: this.saved.audio || [], moved: false };
    this._drag = d;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const nx = ev.clientX - ir.left;
      if (d.mode === "pending" && Math.abs(nx - d.startX) > 4) d.mode = "move";
      d.x = nx;
      if (d.mode === "move") {
        d.moved = true;
        d.target = this._slotAt(nx, d.idx);
        this.render();
      } else if (d.mode === "trim") {
        d.moved = true;
        const proj = { ...this._project(), cut: d.base, audio: d.baseAudio };
        const delta = Math.round((nx - d.startX) / this.ppf);
        const cut = d.side === "in" ? TL.trimIn(proj, d.idx, delta) : TL.trimOut(proj, d.idx, delta);
        const len = cut[d.idx].out - cut[d.idx].in;
        if (len < 2) return;
        const oldRow = TL.layout(proj)[d.idx];
        const change = TL.totalFrames({ ...proj, cut }) - TL.totalFrames(proj);
        this.saved = { ...this.saved, cut, audio: TL.rippleAudio(d.baseAudio, oldRow.recOut, change) };
        this.render();
        // show the frame being trimmed on the stage
        const nr = TL.layout({ ...proj, cut })[d.idx];
        this.frame = d.side === "in" ? nr.recIn : nr.recOut - 1;
        this._showOnStage();
        this._placePlayhead();
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      this._drag = null;
      if (d.mode === "move" && d.target != null && d.target !== d.idx && d.target !== d.idx + 1) {
        const proj = { ...this._project(), cut: d.base };
        const cut = TL.moveEvent(proj, d.idx, d.target, { action: false });
        const audio = TL.audioAfterMove({ ...proj, audio: d.baseAudio }, cut, d.idx, d.target);
        const eids = [...this._eids];
        const [m] = eids.splice(d.idx, 1);
        eids.splice(d.target > d.idx ? d.target - 1 : d.target, 0, m);
        this._set({ cut, audio }, { eids });
        this._status("Clip moved.");
      } else if (d.mode === "trim" && d.moved) {
        const after = { cut: this.saved.cut, audio: this.saved.audio };
        this.saved = { ...this.saved, cut: d.base, audio: d.baseAudio };
        this._set(after);
      } else if (!d.moved) {
        this._select(index);
        return;
      }
      this.render();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  /** Insertion slot (0..n) for a dragged clip at x, over the other clips' midpoints. */
  _slotAt(x, idx) {
    const rows = TL.layout(this._project());
    let slot = 0;
    for (const r of rows) {
      if (r.index === idx) continue;
      if (x > this._x(r.recIn + r.len / 2)) slot = r.index + 1;
    }
    return slot;
  }

  // ------------------------------------------------------------------ menus

  _closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  _openMenu(items, anchor) {
    this._closeMenu();
    const m = (this.menu = h("div", "ss-strip-menu"));
    for (const it of items) {
      if (it === "-") { m.append(h("hr")); continue; }
      if (it.header) { m.append(h("div", "ss-strip-mh", { text: it.header })); continue; }
      const b = h("button", it.danger ? "ss-danger" : "", { type: "button", title: it.title || "" });
      if (it.icon) b.append(icon(it.icon, 14));
      b.append(document.createTextNode(it.label));
      b.disabled = !!it.disabled;
      b.addEventListener("click", (e) => { e.stopPropagation(); this._closeMenu(); it.run(); this.root.focus({ preventScroll: true }); });
      m.append(b);
    }
    this.root.append(m);
    const rr = this.root.getBoundingClientRect();
    const ax = (anchor.clientX ?? anchor.getBoundingClientRect().left) - rr.left;
    const left = Math.max(4, Math.min(rr.width - m.offsetWidth - 4, ax));
    m.style.left = left + "px";
    // open upward (the strip sits at the bottom of the node)
    m.style.bottom = (rr.height - 4) + "px";
    if (rr.top - m.offsetHeight < 0) { m.style.bottom = ""; m.style.top = "30px"; }
  }

  _addMenu(anchorBtn) {
    const items = [
      { icon: "copy", label: "Copy of the current camera", run: () => this.addShot(null) },
      "-", { header: "New angle" },
      ...SETUP_PRESETS.map(([k, label]) => ({ icon: "camera", label, run: () => this.addShot(k) })),
    ];
    this._openMenu(items, anchorBtn);
  }

  _clipMenu(index, ev) {
    const p = this._project();
    const row = TL.layout(p)[index];
    if (!row) return;
    const inside = this.frame > row.recIn && this.frame < row.recOut;
    const setups = this._setups().length;
    this._openMenu([
      { icon: "camera", label: "Edit this setup on the stage", run: () => this._select(index) },
      ...(this._onEditShot ? [
        { icon: "image", label: "Repaint its frame (② Frame)", title: "New stills for this shot; the clip updates when you re-render", run: () => this._onEditShot(row.shot.id, "frame") },
        { icon: "wand-sparkles", label: "Touch up its frame in Canvas", title: "Paint, mask or regenerate this shot's frame, then re-render", run: () => this._onEditShot(row.shot.id, "canvas") },
        { icon: "film", label: "Re-render its motion (③ Motion)", title: "Draft or final for this shot; the cut picks up the new render", run: () => this._onEditShot(row.shot.id, "motion") },
        { icon: "eye", label: "Compare on the Ladder (④ Review)", run: () => this._onEditShot(row.shot.id, "review") },
      ] : []),
      { icon: "copy", label: "Duplicate setup", title: "A new camera setup with this one's moves, right after it", run: () => this.duplicateSetup(index) },
      { icon: "layers", label: "Duplicate clip", title: "The same setup again, right after it", run: () => this.duplicateClip(index) },
      { icon: "scissors", label: "Split at playhead", disabled: !inside, run: () => this.splitAt(this.frame) },
      "-",
      { icon: "x", label: "Remove from cut", title: "Keeps the setup on the stage", run: () => this.removeClip(index) },
      { icon: "trash-2", label: "Delete setup", danger: true, disabled: setups < 2, title: "Removes the camera setup from the stage and every clip of it",
        run: () => this.deleteSetup(row.shot.id) },
    ], ev);
  }

  // ------------------------------------------------------------------ edits

  /** + Shot: a new setup (a copy of the current camera, or a preset angle) appended to the cut. */
  addShot(preset) {
    const st = this.stage;
    const src = st.activeShot();
    const keys = JSON.parse(JSON.stringify(src.camera_keys || []));
    let camKeys = null;
    if (preset) {
      // Frame the people where the new clip will actually be (it continues the action at the end of the
      // cut); if they move during it, key both ends so the camera follows.
      const { fps, frames } = this._clock();
      const plan = appendSetups(this.saved.cut, ["_new"], [{ id: "_new" }], { fps, frames }).at(-1);
      const actorsAt = (f) => (st.state.actors || []).filter((a) => !a.mount_id).map((a) => ({
        id: a.id, height_m: a.height_m, position: st._actorPosAt ? st._actorPosAt(a, f) : a.position,
      }));
      const curCam = st._cameraAt ? st._cameraAt(st.frame || 0) : (keys[0] || { position: [0, 1.6, 6] });
      const a0 = actorsAt(plan.in), a1 = actorsAt(plan.out - 1);
      const c0 = presetCamera(preset, a0, curCam), c1 = presetCamera(preset, a1, curCam);
      const moved = a0.some((a, i) => Math.hypot(a.position[0] - a1[i].position[0], a.position[2] - a1[i].position[2]) > 0.5);
      if (c0) camKeys = moved && c1 ? [{ frame: plan.in, ...c0 }, { frame: plan.out - 1, ...c1 }] : [{ frame: 0, ...c0 }];
    }
    st.addShot(preset || src.setup || "single"); // syncs: appended to the cut
    const made = st.activeShot();
    const cam = camKeys;
    if (camKeys) st.setCameraKeys(camKeys);
    else if (keys.length) { st.setCameraKeys(keys); if (!preset) made.name = `${src.name} copy`; }
    this.sync();
    const p = this._project();
    const idx = TL.layout(p).findIndex((r) => r.shot.id === String(made.id));
    if (idx >= 0) this.frame = TL.layout(p)[idx].recIn;
    this._showOnStage();
    this.render();
    this._status(`Added "${made.name}"${cam ? "" : " (camera copied)"} — edit it on the stage.`);
    return made.id;
  }

  /** New setup with this clip's camera moves, placed right after it with the same in/out. */
  duplicateSetup(index) {
    const st = this.stage;
    const row = TL.layout(this._project())[index];
    if (!row) return;
    const srcShot = (st.state.shots || []).find((s) => String(s.id) === row.shot.id);
    const keys = JSON.parse(JSON.stringify(srcShot?.camera_keys || []));
    this._suspend = true;
    let made;
    try {
      st.setActiveShot(row.shot.id);
      st.addShot(srcShot?.setup || "single");
      made = st.activeShot();
      made.name = `${row.shot.name} copy`;
      if (keys.length) st.setCameraKeys(keys);
    } finally { this._suspend = false; }
    const cut = (this.saved.cut || []).map((e) => ({ ...e }));
    cut.splice(index + 1, 0, { shot_id: String(made.id), in: row.in, out: row.out });
    const eids = [...this._eids];
    eids.splice(index + 1, 0, this._nextEid++);
    this._set({ cut, audio: TL.rippleAudio(this.saved.audio || [], row.recOut, row.len) }, { eids });
    this._sig = this._setupSig();
    this._select(index + 1);
    this._status(`Duplicated "${row.shot.name}" as a new setup.`);
  }

  duplicateClip(index) {
    const row = TL.layout(this._project())[index];
    if (!row) return;
    const cut = (this.saved.cut || []).map((e) => ({ ...e }));
    cut.splice(index + 1, 0, { shot_id: row.shot.id, in: row.in, out: row.out });
    const eids = [...this._eids];
    eids.splice(index + 1, 0, this._nextEid++);
    this._set({ cut, audio: TL.rippleAudio(this.saved.audio || [], row.recOut, row.len) }, { eids });
  }

  splitAt(f) {
    const p = this._project();
    const row = TL.eventAt(p, Math.floor(f));
    if (!row || Math.floor(f) === row.recIn) return;
    const eids = [...this._eids];
    eids.splice(row.index + 1, 0, this._nextEid++);
    this._set({ cut: TL.splitAt(p, Math.floor(f)) }, { eids });
  }

  /** Take a clip out of the cut (the setup stays on the stage, and is not added back). */
  removeClip(index) {
    const p = this._project();
    const row = TL.layout(p)[index];
    if (!row) return;
    const cut = TL.rippleDelete(p, index);
    const eids = [...this._eids];
    eids.splice(index, 1);
    const excluded = new Set((this.saved.excluded_shots || []).map(String));
    if (!cut.some((e) => e.shot_id === row.shot.id)) excluded.add(row.shot.id);
    this._set({ cut, excluded_shots: [...excluded], audio: TL.rippleAudio(this.saved.audio || [], row.recOut, -row.len) }, { eids });
    this.frame = Math.min(this.frame, Math.max(0, this._total() - 1));
    this._placePlayhead();
    this._status(`Removed "${row.shot.name}" from the cut (the setup is still on the stage).`);
  }

  /** Delete a camera setup from the stage, and every clip of it from the cut. */
  deleteSetup(id) {
    const st = this.stage;
    if ((st.state.shots || []).length < 2) { this._status("The stage needs at least one setup."); return; }
    const name = this._setups().find((s) => s.id === id)?.name || id;
    let p = this._project();
    let audio = this.saved.audio || [];
    // ripple the audio for each clip, from the last one back
    for (const r of TL.layout(p).filter((r) => r.shot.id === id).reverse()) audio = TL.rippleAudio(audio, r.recOut, -r.len);
    const keep = (this.saved.cut || []).map((e, i) => [e, this._eids[i]]).filter(([e]) => String(e.shot_id) !== id);
    this._suspend = true;
    try { st.setActiveShot(id); st.removeShot(); } finally { this._suspend = false; }
    this._set({ cut: keep.map(([e]) => e), audio, excluded_shots: (this.saved.excluded_shots || []).filter((x) => String(x) !== id) },
      { eids: keep.map(([, k]) => k) });
    this._sig = this._setupSig();
    this._status(`Deleted setup "${name}".`);
  }

  // ------------------------------------------------------------------ keys and wheel

  _onKey(e) {
    e.stopPropagation();
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.metaKey || e.ctrlKey;
    const p = this._project();
    const cur = TL.eventAt(p, Math.floor(this.frame));
    let handled = true;
    if (mod && k === "z") e.shiftKey ? this.redo() : this.undo();
    else if (mod && k === "d" && cur) this.duplicateSetup(cur.index);
    else if (mod && k === "b") this.splitAt(this.frame);
    else if (mod) handled = false;
    else switch (k) {
      case " ": this.togglePlay(); break;
      case "j": this.shuttle(-1); break;
      case "k": this.stop(); break;
      case "l": this.shuttle(1); break;
      case "ArrowLeft": this.stop(); this._seek(this.frame - (e.shiftKey ? 24 : 1)); break;
      case "ArrowRight": this.stop(); this._seek(this.frame + (e.shiftKey ? 24 : 1)); break;
      case "ArrowUp": if (cur && cur.index > 0) this._select(cur.index - 1); break;
      case "ArrowDown": if (cur && cur.index < p.cut.length - 1) this._select(cur.index + 1); break;
      case "Delete": case "Backspace": if (cur) this.removeClip(cur.index); break;
      case "b": this.splitAt(this.frame); break;
      case "Escape": this._closeMenu(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  _onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      const r = this.inner.getBoundingClientRect();
      const fAt = (e.clientX - r.left) / this.ppf;
      const vw = this.scroll.clientWidth || 300;
      const fitPpf = (vw - 2) / Math.max(this._total(), 24);
      this.ppf = Math.max(fitPpf, Math.min(40, this.ppf * Math.exp(-e.deltaY * 0.004)));
      this.fit = this.ppf <= fitPpf * 1.001;
      this.render();
      this.scroll.scrollLeft = fAt * this.ppf - (e.clientX - this.scroll.getBoundingClientRect().left);
    } else {
      this.scroll.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    }
  }
}
