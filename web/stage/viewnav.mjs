// Finding your way back (view navigation): two buttons that are always on the stage viewport, and a chip when you're lost.
//
//   ⌂ Back to the set (.)  frames the whole set (its buildings, walls and everything on it) from a default three-quarter
//                          angle, flown over 0.4 s in the free view (the shot camera is never moved by it).
//   ↶ Last view (,)        steps back through the last 10 views that settled: a view is remembered once it has rested for
//                          half a second, and just before Drive, ● REC, Back to the set or a jump (F, an axis on the
//                          compass), so a drive or a fly-off can always be undone back to where you were.
//   Lost? Back to the set  a one-tap chip that shows while the camera is more than 3 set radii from the set's centre or
//                          inside a wall or a building.
//
// The pure parts (the set's bounds, the home view, "lost", the history) are exported for the tests.

import { setStyles, setProp } from "../ui/domwrite.mjs";   // polls write only what changed
const D = Math.PI / 180;
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);

/** The set's bounds from its boxes ({pos, half}) and the objects' positions: {center: [x, y, z], radius}. */
export function setBounds(boxes = [], points = []) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const add = (p) => p.forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  for (const b of boxes) { add(sub(b.pos, b.half)); add(b.pos.map((v, i) => v + b.half[i])); }
  for (const p of points) add(p);
  if (!Number.isFinite(lo[0])) return { center: [0, 1, 0], radius: 15 };
  lo[1] = Math.min(lo[1], 0);
  const center = lo.map((v, i) => (v + hi[i]) / 2);
  return { center, radius: Math.max(4, len(sub(hi, lo)) / 2) };
}

/** The home view of a set: from the front-right, 28° above the horizon, far enough to fit the whole set. */
export function homeView(bounds, { fovDeg = 50, aspect = 16 / 9, azDeg = 35, elDeg = 28 } = {}) {
  const v = fovDeg * D, h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  const dist = (bounds.radius * 1.05) / Math.sin(Math.min(v, h) / 2);
  const az = azDeg * D, el = elDeg * D;
  const t = [bounds.center[0], Math.max(0.5, Math.min(bounds.center[1], 2)), bounds.center[2]];
  const position = [t[0] + Math.sin(az) * Math.cos(el) * dist, t[1] + Math.sin(el) * dist, t[2] - Math.cos(az) * Math.cos(el) * dist];
  return { position: position.map((x) => +x.toFixed(3)), target: t.map((x) => +x.toFixed(3)) };
}

/** Is the camera lost? "far" beyond 3 set radii from the centre, "inside" a box of the set, else null. */
export function lostReason(pos, bounds, boxes = []) {
  if (len(sub(pos, bounds.center)) > 3 * bounds.radius) return "far";
  for (const b of boxes) if (pos.every((v, i) => Math.abs(v - b.pos[i]) < b.half[i] - 0.05)) return "inside";
  return null;
}

/** The last views that settled (most recent last), up to `max`; near-duplicates are not stored twice. */
export class ViewHistory {
  constructor(max = 10) { this.max = max; this.list = []; this._sig = null; this._since = 0; this._noted = null; }
  static same(a, b) { return !!a && !!b && a.free === b.free && (!a.free || (len(sub(a.position, b.position)) < 0.05 && len(sub(a.target, b.target)) < 0.05)); }
  /** Remember a view now (before a jump). */
  mark(view) {
    if (!view || ViewHistory.same(this.list[this.list.length - 1], view)) return;
    this.list.push(clone(view));
    if (this.list.length > this.max) this.list.shift();
  }
  /** Called on a timer: a view that has rested for `rest` ms is remembered once. */
  watch(view, now, rest = 500) {
    const sig = JSON.stringify(view);
    if (sig !== this._sig) { this._sig = sig; this._since = now; return; }
    if (now - this._since >= rest && this._noted !== sig) { this._noted = sig; this.mark(view); }
  }
  /** The view to go back to from `current` (taken off the list), or null. */
  back(current) {
    while (this.list.length && ViewHistory.same(this.list[this.list.length - 1], current)) this.list.pop();
    const v = this.list.pop() || null;
    if (v) this._noted = this._sig = JSON.stringify(v);   // arriving there is not a new settled view
    return v;
  }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const CSS = `.ss-viewnav{position:absolute;z-index:5;display:flex;gap:4px;pointer-events:auto}
.ss-viewnav button,.ss-lostchip{all:unset;cursor:pointer;font:600 11.5px/1 "Soundstage Grotesk",ui-sans-serif,system-ui,sans-serif;color:#f1ecf6;
  background:rgba(24,18,30,.72);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:6px 10px;white-space:nowrap}
.ss-viewnav button:hover,.ss-lostchip:hover{background:rgba(48,40,58,.9)}
.ss-viewnav button:disabled{opacity:.45;cursor:default}
.ss-viewnav button:focus-visible,.ss-lostchip:focus-visible{outline:2px solid #f2ff59}
.ss-lostchip[hidden]{display:none}
.ss-lostchip{position:absolute;z-index:6;left:50%;transform:translateX(-50%);background:#f2ff59;color:#1d1622;border-color:#f2ff59;padding:8px 14px}`;

/** Put the view controls on a Stage (stage.viewNav) and its viewport. Returns the controller. */
export function installViewNav(stage) {
  const hist = new ViewHistory(10);
  const view = () => {
    if (stage.drive?.on || stage._preview) return null;
    // Only the free view is read (never _activeOrbit in the shot view: that writes a camera key at the playhead, every poll).
    const o = stage.freeView ? (stage._peekOrbit?.() ?? stage._activeOrbit?.()) : null;
    return stage.freeView && o ? { free: true, position: [...o.position], target: [...o.target] } : { free: false };
  };
  const boxes = () => (stage._setCollidersCached?.() || []).filter((c) => c.half && c.pos);
  const bounds = () => {
    const pts = [];
    for (const g of stage.actorMeshes?.values() || []) if (g.visible) pts.push(g.position.toArray());
    return setBounds(boxes(), pts);
  };
  const nav = {
    history: hist,
    mark() { nav.mark0(); },
    mark0() { const v = view(); if (v) hist.mark(v); },
    /** ⌂ Back to the set: the whole set from the home angle, in the free view, flown over 0.4 s. */
    backToSet() {
      nav.mark0();
      const cam = stage._viewportCamera?.() || stage.camera;
      const home = homeView(bounds(), { fovDeg: cam?.fov || 50, aspect: cam?.aspect || 16 / 9 });
      if (!stage.freeView) stage.setFreeView(true);
      stage._flyTo(home.position, home.target, 400);
      stage.onInteract?.("Back to the set (.): the whole set from the front. ↶ Last view (,) steps back to where you were.");
      return home;
    },
    /** ↶ Last view: the view before this one. */
    lastView() {
      const v = hist.back(view());
      if (!v) { stage.onInteract?.("No earlier view to go back to yet."); return null; }
      if (!v.free) { stage.setFreeView(false); return v; }
      if (!stage.freeView) stage.setFreeView(true);
      stage._flyTo(v.position, v.target, 400);
      return v;
    },
    lost() {
      if (stage.drive?.on || !stage.freeView) return null;
      const o = stage._activeOrbit?.();
      return o ? lostReason(o.position, bounds(), boxes()) : null;
    },
  };
  stage.viewNav = nav;
  // Jumps remember where you were first.
  for (const m of ["frameSelected", "snapView"]) {
    const f = stage[m];
    if (typeof f === "function") stage[m] = function (...args) { nav.mark0(); return f.apply(this, args); };
  }
  // A double-click focus (navigation.mjs) is a jump too.
  if (typeof stage.nav?.focusAt === "function") {
    const f = stage.nav.focusAt;
    stage.nav.focusAt = (...args) => { nav.mark0(); return f.apply(stage.nav, args); };
  }
  if (typeof document === "undefined" || !stage.canvas) return nav;
  if (!document.getElementById("ss-viewnav-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-viewnav-css", textContent: CSS }));
  const host = stage.canvas.parentElement;
  const bar = Object.assign(document.createElement("div"), { className: "ss-viewnav" });
  const mk = (label, tip, fn) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title: tip });
    b.setAttribute("aria-label", tip);
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", fn);
    bar.append(b);
    return b;
  };
  mk("⌂ Back to the set", "Back to the set: frame the whole set from the front (.)", () => nav.backToSet());
  const backBtn = mk("↶ Last view", "Last view: step back through the views you were at (,)", () => nav.lastView());
  if (stage.nav?.openSettings) mk("Navigation…", "How the mouse, trackpad and keys move you round the set: style, damping, fly speed", () => stage.nav.openSettings());
  const chip = Object.assign(document.createElement("button"), { type: "button", className: "ss-lostchip", textContent: "Lost? Back to the set", title: "The camera is far from the set or inside it: frame the whole set (.)" });
  chip.hidden = true;
  chip.addEventListener("pointerdown", (e) => e.stopPropagation());
  chip.addEventListener("click", () => nav.backToSet());
  host?.append(bar, chip);
  const place = () => {
    const c = stage.canvas;
    // Under the view badge, at the viewport's top-left (the compass is top-right); out of Drive's way while it runs.
    // written only when they change (domwrite.mjs): this runs every 250 ms
    setStyles(bar, { left: `${c.offsetLeft + 8}px`, top: `${c.offsetTop + 32}px`, display: stage.drive?.on ? "none" : "flex" });
    setStyles(chip, { left: `${c.offsetLeft + c.offsetWidth / 2}px`, top: `${c.offsetTop + 64}px` });
  };
  stage.canvas.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || stage.drive?.on) return;
    // In the Blender style the numpad's "." frames the selection (navigation.mjs), so only the main "." goes home there.
    if (e.key === "." && !(e.code === "NumpadDecimal" && stage.nav?.settings?.style === "blender")) { e.preventDefault(); nav.backToSet(); }
    else if (e.key === ",") { e.preventDefault(); nav.lastView(); }
  });
  const id = setInterval(() => {
    if (!stage.canvas.isConnected && nav._started) { clearInterval(id); bar.remove(); chip.remove(); return; }
    nav._started = true;
    place();
    const v = view();
    if (v) hist.watch(v, performance.now());
    setProp(backBtn, "disabled", !hist.list.some((x) => !ViewHistory.same(x, v)));
    setProp(chip, "hidden", !nav.lost());
  }, 250);
  return nav;
}
