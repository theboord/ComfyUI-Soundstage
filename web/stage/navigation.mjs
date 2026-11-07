// Stage navigation: how you move around the 3D set with the mouse, a trackpad and the keyboard.
//
//   Drag on empty space      orbit about the point under the cursor (not a point you can't see)
//   Both buttons + drag      pan (also Shift+drag and the middle button)
//   Hold right + W A S D Q E fly (mouse-look while held; the wheel changes fly speed)
//   W A S D Q E              glide while held (no more key-repeat stutter)
//   Double-click             glide to what you clicked (Free view only: it never rewrites a shot)
//   Two-finger scroll        orbit on a trackpad (Shift pans, pinch zooms)
//   A style picker (Soundstage, Blender, Maya, Unreal) with damping, smoothness, invert Y, trackpad mode and fly speed,
//   kept per browser (localStorage, every access in try/catch).
//
// The top half is pure (no three.js, no DOM) so node tests cover it; installNavigation() wires it to a Stage.

const EPS = 1e-9;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };

// ---------------------------------------------------------------- settings
export const NAV_STYLES = ["soundstage", "blender", "maya", "unreal"];
export const STYLE_NAMES = { soundstage: "Soundstage", blender: "Blender", maya: "Maya", unreal: "Unreal" };
export const NAV_DEFAULTS = Object.freeze({ style: "soundstage", damping: true, smooth: 0.4, invertY: false, trackpad: "auto", flySpeed: 4, hintDismissed: false });
const LS_KEY = "ss_nav_v1";

/** Settings from storage (any failure gives the defaults). Reduced motion turns damping off. */
export function loadNavSettings(storage = globalThis.localStorage, reducedMotion = false) {
  let s = {};
  try { s = JSON.parse(storage?.getItem(LS_KEY) || "{}") || {}; } catch { s = {}; }
  const out = { ...NAV_DEFAULTS };
  if (NAV_STYLES.includes(s.style)) out.style = s.style;
  if (typeof s.damping === "boolean") out.damping = s.damping;
  if (Number.isFinite(s.smooth)) out.smooth = clamp(s.smooth, 0, 1);
  if (typeof s.invertY === "boolean") out.invertY = s.invertY;
  if (["auto", "mouse", "trackpad"].includes(s.trackpad)) out.trackpad = s.trackpad;
  if (Number.isFinite(s.flySpeed)) out.flySpeed = clamp(s.flySpeed, 0.25, 64);
  if (typeof s.hintDismissed === "boolean") out.hintDismissed = s.hintDismissed;
  if (reducedMotion) out.damping = false;
  return out;
}
export function saveNavSettings(s, storage = globalThis.localStorage) {
  try { storage?.setItem(LS_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- bindings per style
// What each style binds (the hint and the docs read this). Clicking selects, a drag on the selected object grabs it, the
// gizmo / ring / light handles, F, 0, "." and "," are the same in every style.
export const PRESETS = {
  soundstage: { orbit: "LMB drag on empty space", pan: "LMB+RMB drag, Shift+LMB, MMB", look: "Alt+LMB on empty space", dolly: "Wheel",
    zoom: "Wheel, pinch", fly: "Hold RMB + WASD/QE", focus: "Double-click", frame: "F", frameAll: ".", snap: "Compass", keys: [] },
  blender: { orbit: "MMB drag, LMB on empty space", pan: "Shift+MMB, LMB+RMB", look: "Alt+LMB on empty space", dolly: "Ctrl+MMB drag",
    zoom: "Wheel, pinch", fly: "Hold RMB + WASD/QE", focus: "Double-click", frame: "F, Numpad .", frameAll: "Home",
    snap: "Numpad 1 / 3 / 7 (Ctrl: opposite)", keys: ["NumpadDecimal", "Home", "Numpad1", "Numpad3", "Numpad7", "Ctrl+Numpad1", "Ctrl+Numpad3", "Ctrl+Numpad7"] },
  maya: { orbit: "Alt+LMB, LMB on empty space", pan: "Alt+MMB, LMB+RMB", look: "—", dolly: "Alt+RMB drag",
    zoom: "Wheel, pinch", fly: "Hold RMB + WASD/QE", focus: "Double-click", frame: "F", frameAll: "Shift+A", snap: "Compass", keys: ["Shift+A"] },
  unreal: { orbit: "Alt+LMB", pan: "MMB, LMB+RMB", look: "Hold RMB", dolly: "Alt+RMB drag",
    zoom: "Wheel, pinch", fly: "Hold RMB + WASD/QE (wheel = speed)", focus: "Double-click", frame: "F", frameAll: ".",
    snap: "Compass", walk: "LMB drag on empty space: forward and turn", keys: [] },
};
export const NAV_ACTIONS = ["orbit", "pan", "look", "dolly", "zoom", "fly", "focus", "frame", "frameAll", "snap"];
/** Keys the App already uses: no style may bind them. */
export const TAKEN_KEYS = ["G", "R", "T", "P", "K", "L", "I", "O", "V", "H", "Tab", "?", "Space", "0", ".", ",", "F", "W", "A", "S", "D", "Q", "E"];

/** A style's keys that collide with each other or with keys the App already uses. */
export function bindingConflicts(style, taken = TAKEN_KEYS) {
  const keys = PRESETS[style]?.keys || [];
  const out = [];
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) out.push(k);
    seen.add(k);
    if (taken.includes(k)) out.push(k);
  }
  return out;
}

/** Does Alt + drag on an object turn it in this style? (Maya and Unreal use Alt + LMB to orbit.) */
export const altTurns = (style) => style !== "maya" && style !== "unreal";

/**
 * A camera press -> what the drag does: {mode: "orbit" | "pan" | "dolly" | "walk", look, fly}.
 * ev = {button, shift, alt, ctrl}. Only called for presses that are the camera's (not a grab, the gizmo or a handle).
 */
export function resolveGesture(style, ev) {
  const { button = 0, shift = false, alt = false, ctrl = false } = ev || {};
  const g = (mode, look = false, fly = false) => ({ mode, look, fly });
  if (style === "maya") {
    if (alt) return button === 1 ? g("pan") : button === 2 ? g("dolly") : g("orbit");
    if (button === 2) return g("orbit", true, true);
    return button === 1 || shift ? g("pan") : g("orbit");
  }
  if (style === "unreal") {
    if (alt) return button === 2 ? g("dolly") : button === 1 ? g("pan") : g("orbit");
    if (button === 2) return g("orbit", true, true);
    if (button === 1 || shift) return g("pan");
    return g("walk");
  }
  if (style === "blender") {
    if (button === 1) return shift ? g("pan") : ctrl ? g("dolly") : g("orbit");
    if (button === 2) return g("orbit", true, true);
    return shift ? g("pan") : g("orbit", alt);
  }
  // soundstage
  if (button === 2) return g("orbit", true, true);
  if (button === 1 || shift) return g("pan");
  return g("orbit", alt);
}

/** Both buttons held (buttons & 3 === 3) turn an orbit / look / fly or a not-yet-started grab into a pan. */
export function chordUpgrade(mode, buttons, { gizmoDragging = false } = {}) {
  if (gizmoDragging || (buttons & 3) !== 3) return null;
  return ["orbit", "pan", "pending", "dolly", "walk"].includes(mode) ? "pan" : null;
}

// ---------------------------------------------------------------- camera math (arrays [x, y, z])
function rotY(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }
function rotAxis(v, k, a) {   // Rodrigues
  const c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}
/** Polar angle (from +Y) of the camera's back vector (target -> camera). */
const phiOf = (pos, tgt) => Math.acos(clamp(norm(sub(pos, tgt))[1], -1, 1));

/**
 * Turntable orbit of camera position + target about a pivot: dTheta turns about world Y, dPhi tilts about the camera's
 * horizontal right axis (+ = lower). The tilt is clamped so the view never flips over the pole. The pivot keeps its place
 * on screen (the camera frame turns rigidly with it).
 */
export function orbitAbout(pos, tgt, pivot, dTheta, dPhi, minPhi = 0.01) {
  const phi = phiOf(pos, tgt);
  dPhi = clamp(phi + dPhi, minPhi, Math.PI - minPhi) - phi;
  let p = rotY(sub(pos, pivot), dTheta), t = rotY(sub(tgt, pivot), dTheta);
  const fwd = sub(t, p);
  let right = cross(fwd, [0, 1, 0]);
  if (len(right) < EPS) right = [1, 0, 0];
  right = norm(right);
  p = rotAxis(p, right, dPhi);
  t = rotAxis(t, right, dPhi);
  return { pos: add(p, pivot), tgt: add(t, pivot) };
}

/** World units per screen pixel at a distance (so a pan moves the point under the cursor with the cursor). */
export const panRate = (dist, fovDeg, viewportPx) => (2 * Math.max(dist, 0.05) * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportPx);

/**
 * The pivot an orbit turns about: the object under the cursor, else the floor under it (within maxFloor m; the water
 * tank has no floor to stop on), else the target. A pivot much farther than the target (the horizon) is not used.
 * hits: {mesh: [x,y,z] | null, floor: [x,y,z] | null}; origin is the camera.
 */
export function pickPivot({ mesh = null, floor = null } = {}, target, origin, { waterTank = false, maxFloor = 400 } = {}) {
  const far = origin ? Math.max(50, 4 * len(sub(target, origin))) : Infinity;
  const ok = (p) => p && (!origin || len(sub(p, origin)) <= far);
  if (ok(mesh)) return mesh;
  if (!waterTank && floor && ok(floor) && (!origin || len(sub(floor, origin)) <= maxFloor)) return floor;
  return target;
}

/** Frame-rate independent easing: the share of what's left to take this frame (dt in s). Damping off takes it all. */
export const easeShare = (dt, tau, damping = true) => (!damping || tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau));
/** Take this frame's share of an accumulated delta {dx, dy}: returns [taken, left]. */
export function consume(acc, dt, tau, damping = true) {
  const k = easeShare(dt, tau, damping);
  const settle = Math.abs(acc.dx) < 0.05 && Math.abs(acc.dy) < 0.05;
  const take = settle ? { dx: acc.dx, dy: acc.dy } : { dx: acc.dx * k, dy: acc.dy * k };
  return [take, { ...acc, dx: acc.dx - take.dx, dy: acc.dy - take.dy }];
}
/** Smoothness 0..1 -> time constant (s) for drag damping. */
export const tauFromSmooth = (smooth) => 0.02 + clamp(smooth, 0, 1) * 0.1;

/**
 * Mouse wheel, trackpad scroll or pinch? mem = {kind, t} is the state of the current stream (sticky for 400 ms).
 * force = "mouse" | "trackpad" | "auto".
 */
export function classifyWheel(e, mem = {}, now = 0, force = "auto") {
  if (e.ctrlKey) return "pinch";
  if (force === "mouse" || force === "trackpad") return force;
  let kind = "mouse";
  if (e.deltaMode === 0) {
    const frac = e.deltaY !== Math.trunc(e.deltaY);
    const legacy = Number.isFinite(e.wheelDeltaY) && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 !== 0;
    if (e.deltaX !== 0 || (frac && !Number.isFinite(e.wheelDeltaY)) || legacy) kind = "trackpad";
  }
  if (kind === "mouse" && mem.kind === "trackpad" && now - (mem.t || 0) < 400) kind = "trackpad";
  mem.kind = kind; mem.t = now;
  return kind;
}

/** Fly: the direction from the held keys in camera space [right, up, forward]; opposite keys cancel. */
export function flyDir(held) {
  const h = (k) => (held.has(k) ? 1 : 0);
  return [h("d") - h("a"), h("e") - h("q"), h("w") - h("s")];
}
/** One fly step (camera space, metres) for dt seconds at speed m/s (Shift x4). */
export function flyStep(held, speed, dt, shift = false) {
  const d = flyDir(held), l = Math.hypot(...d);
  if (!l) return [0, 0, 0];
  const k = (speed * (shift ? 4 : 1) * dt) / l;
  return d.map((v) => v * k);
}
/** The wheel while flying: faster (wheel up) or slower, 0.25..64 m/s. */
export const flySpeedFromWheel = (speed, deltaY) => (deltaY ? clamp(speed * Math.pow(1.25, -Math.sign(deltaY)), 0.25, 64) : speed);
/** The held-keys speed without RMB: about what the old key-repeat steps covered (0.06 x distance, 0.1..1.5 m a step). */
export const walkSpeed = (dist, tight = false) => clamp(dist * 0.06, tight ? 0.03 : 0.1, 1.5) * 6;

/**
 * Double-click focus on a point (not an object): keep the view direction, move the target to the point, and keep the
 * camera 2..12 m from it.
 */
export function focusView(pos, tgt, point, { min = 2, max = 12 } = {}) {
  const back = norm(sub(pos, tgt));
  const d = clamp(len(sub(pos, point)), min, max);
  return { pos: add(point, mul(back, d)), tgt: [...point] };
}

/** The one-line hint for a style ("⌥" on a Mac). */
export function hintText(style, mac = false) {
  const alt = mac ? "⌥" : "Alt";
  switch (style) {
    case "blender": return `Middle-drag orbit · Shift+middle or both buttons pan · Ctrl+middle dolly · Hold right + WASD fly · Double-click focus · Numpad . frame`;
    case "maya": return `${alt}+drag orbit · ${alt}+middle pan · ${alt}+right dolly · Hold right + WASD fly · Double-click focus · F frame`;
    case "unreal": return `Drag move · ${alt}+drag orbit · Middle or both buttons pan · Hold right + WASD fly (wheel = speed) · Double-click focus · F frame`;
    default: return `Drag orbit · Both buttons or Shift pan · Scroll zoom · Hold right + WASD fly · Double-click focus · F frame`;
  }
}

// ---------------------------------------------------------------- the controller
const CSS = `.ss-navhint{position:absolute;z-index:5;transform:translateX(-50%);display:flex;align-items:center;gap:6px;max-width:92%;
  font:500 11px/1.2 "Soundstage Grotesk",ui-sans-serif,system-ui,sans-serif;color:#e9e3f0;background:rgba(20,16,26,.62);
  border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:4px 6px 4px 10px;pointer-events:auto;white-space:nowrap}
.ss-navhint[hidden],.ss-navpanel[hidden]{display:none}
.ss-navhint .t{overflow:hidden;text-overflow:ellipsis}
.ss-navhint button,.ss-navhint select{all:unset;cursor:pointer;padding:2px 6px;border-radius:999px;color:#f1ecf6}
.ss-navhint button:hover,.ss-navhint select:hover{background:rgba(255,255,255,.12)}
.ss-navhint button:focus-visible,.ss-navhint select:focus-visible,.ss-navpanel :focus-visible{outline:2px solid #f2ff59}
.ss-navpanel{position:absolute;z-index:7;transform:translateX(-50%);background:rgba(24,18,30,.95);color:#f1ecf6;border:1px solid rgba(255,255,255,.16);
  border-radius:10px;padding:10px 12px;font:500 12px/1.3 "Soundstage Grotesk",ui-sans-serif,system-ui,sans-serif;display:grid;
  grid-template-columns:auto auto;gap:6px 10px;align-items:center;min-width:240px}
.ss-navpanel h4{grid-column:1/-1;margin:0 0 2px;font-size:12px}
.ss-navpanel select,.ss-navpanel input{font:inherit}`;

/** Wire navigation onto a Stage: stage.nav. Hook lines in stage.mjs call begin / chord / drag / key / wheel. */
export function installNavigation(stage) {
  const store = (() => { try { return globalThis.localStorage; } catch { return null; } })();
  const reduced = (() => { try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch { return false; } })();
  const settings = loadNavSettings(store, reduced);
  const raf = globalThis.requestAnimationFrame?.bind(globalThis) || ((f) => setTimeout(() => f(globalThis.performance?.now?.() ?? Date.now()), 16));
  const caf = globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout;
  const now = () => globalThis.performance?.now?.() ?? Date.now();

  let acc = null;              // {mode, look, pivot, dx, dy} still to apply (drag smoothing)
  const held = new Set();      // fly keys held
  let vel = [0, 0, 0];         // fly velocity, camera space (m/s)
  let shift = false, tightKeys = false;
  let rafId = 0, last = 0, dirty = false;
  const rmb = { down: false, x0: 0, y0: 0, moved: false, keys: false, chord: false, menu: null, lastDragUp: 0 };
  const press = { moved: false, x0: 0, y0: 0, bad: 0 };
  const wheelMem = {};
  const listeners = [];
  const on = (el, t, f, o) => { if (!el?.addEventListener) return; el.addEventListener(t, f, o); listeners.push([el, t, f, o]); };

  const off = () => !!stage.drive?.on;
  const active = () => stage._activeOrbit?.();
  const flying = () => rmb.down;

  const nav = {
    settings,
    save() { saveNavSettings(settings, store); nav._render?.(); },
    set(k, v) { settings[k] = v; nav.save(); },
    altTurns: () => altTurns(settings.style),
    hint: () => hintText(settings.style, /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || "")),

    /** A camera press: what this drag does, and the pivot an orbit turns about. */
    begin(e) {
      const g = resolveGesture(settings.style, { button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
      acc = null;
      let pivot = null;
      if ((g.mode === "orbit" && !g.look) || g.mode === "pan") pivot = nav.pivotAt(e);   // pan: that point follows the cursor
      return { ...g, pivot };
    },
    /** The point under the cursor an orbit turns about (object, floor, else the target). */
    pivotAt(e) {
      const o = active();
      if (!o || !stage._pickRay) return null;
      try {
        const rc = stage._pickRay(e), r = rc.ray;
        const hit = rc.intersectObjects([...(stage.actorMeshes?.values() || [])].filter((g) => g.visible), true).find((h) => h.object?.visible !== false);
        const origin = [r.origin.x, r.origin.y, r.origin.z], dir = [r.direction.x, r.direction.y, r.direction.z];
        let floor = null;
        if (dir[1] < -1e-4) { const t = -origin[1] / dir[1]; if (t > 0) floor = add(origin, mul(dir, t)); }
        return pickPivot({ mesh: hit ? [hit.point.x, hit.point.y, hit.point.z] : null, floor }, o.target, o.position,
          { waterTank: stage.state?.environment?.set === "water_tank" });
      } catch { return null; }
    },
    /** pointermove with both buttons: the drag becomes a pan (a not-yet-started grab is dropped, nothing moves). */
    chord(drag, e) {
      if (!drag || off()) return drag;
      const m = chordUpgrade(drag.mode, e.buttons, { gizmoDragging: !!(stage.tc?.dragging || stage._gizmoDragging) });
      if (!m || (drag.mode === "pan" && drag.chorded)) return drag;
      rmb.chord = true;
      nav.flush();
      return { mode: "pan", look: false, x: e.clientX, y: e.clientY, x0: drag.x0 ?? e.clientX, y0: drag.y0 ?? e.clientY, chorded: true, pivot: drag.pivot || nav.pivotAt(e) };
    },
    /** Was this camera press not a click? (a chord, or fly keys used while right was held) */
    notClick(drag) { return !!drag?.chorded || rmb.keys; },

    /** A drag delta (px): smoothed through the frame loop when damping is on. */
    drag(drag, dx, dy) {
      if (settings.invertY && (drag.mode === "orbit")) dy = -dy;
      if (!settings.damping) { nav.apply(drag.mode, drag.look, dx, dy, drag.pivot); return; }
      if (acc && (acc.mode !== drag.mode || acc.look !== drag.look || acc.pivot !== drag.pivot)) nav.flush();
      if (!acc) acc = { mode: drag.mode, look: drag.look, pivot: drag.pivot || null, dx: 0, dy: 0 };
      acc.dx += dx; acc.dy += dy;
      loop();
    },
    flush() { if (acc) { const a = acc; acc = null; nav.apply(a.mode, a.look, a.dx, a.dy, a.pivot); } },
    halt() { acc = null; vel = [0, 0, 0]; },
    apply(mode, look, dx, dy, pivot) {
      if (!dx && !dy) return;
      if (mode === "dolly") return nav.dolly(dy);
      if (mode === "walk") return nav.walk(dx, dy);
      stage._navDrag(mode, look, dx, dy, pivot || null);
    },
    dolly(dy) {
      const o = active(); if (!o) return;
      const off3 = sub(o.position, o.target), d = len(off3);
      const nd = clamp(d * Math.exp(dy * 0.005), 0.1, 2000);
      o.position = add(o.target, mul(norm(off3), nd)).map((v) => +v.toFixed(3));
      stage._applyActive();
    },
    walk(dx, dy) {   // Unreal's LMB: turn with dx, move along the ground with dy
      stage._navDrag("orbit", true, dx, 0, null);
      const o = active(); if (!o) return;
      const f = sub(o.target, o.position); f[1] = 0;
      if (len(f) < EPS) return;
      const step = mul(norm(f), -dy * walkSpeed(len(sub(o.target, o.position))) * 0.02);
      o.position = add(o.position, step).map((v) => +v.toFixed(3));
      o.target = add(o.target, step).map((v) => +v.toFixed(3));
      stage._applyActive();
    },
    /** The wheel's zoom easing share for this frame (dt in s): ~40% at 60 fps, the same speed at any frame rate. */
    zoomK: (dt) => easeShare(dt, 0.033, settings.damping),

    /** Wheel: fly speed while flying, trackpad orbit / pan; false = the stage zooms as before. */
    wheel(e) {
      if (off() || e.__gesture) return false;
      if (flying()) {
        settings.flySpeed = flySpeedFromWheel(settings.flySpeed, e.deltaY);
        nav.save();
        stage.onInteract?.(`Fly speed ${settings.flySpeed.toFixed(2)} m/s`);
        return true;
      }
      const kind = classifyWheel(e, wheelMem, now(), settings.trackpad);
      if (kind !== "trackpad" || e.altKey) return false;
      const k = e.deltaMode === 1 ? 16 : 1;
      const pan = e.shiftKey;
      if (!wheelMem.pivot || now() - (wheelMem.pt || 0) > 400) wheelMem.pivot = pan ? null : nav.pivotAt(e);
      wheelMem.pt = now();
      // Fingers move the set like a drag would (macOS "natural" scrolling: deltas run opposite to the fingers).
      nav.drag({ mode: pan ? "pan" : "orbit", look: false, pivot: pan ? null : wheelMem.pivot }, -e.deltaX * k * 0.8, -e.deltaY * k * 0.8);
      dirty = true;
      return true;
    },

    /** keydown: continuous WASD/QE (all styles) and the style's own keys. true = handled. */
    key(e) {
      if (off() || e.metaKey || e.ctrlKey && !(settings.style === "blender" && /^Numpad[137]$/.test(e.code))) return false;
      const k = (e.key || "").toLowerCase();
      if (settings.style === "maya" && e.shiftKey && k === "a") { e.preventDefault(); e.stopPropagation(); stage.viewNav?.backToSet(); return true; }
      if (settings.style === "blender") {
        const snap = { Numpad1: ["+z", "-z"], Numpad3: ["+x", "-x"], Numpad7: ["+y", "-y"] }[e.code];
        if (snap) { e.preventDefault(); e.stopPropagation(); stage.snapView?.(snap[e.ctrlKey ? 1 : 0]); return true; }
        if (e.code === "NumpadDecimal") { e.preventDefault(); e.stopPropagation(); stage.frameSelected?.(); return true; }
        if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); stage.viewNav?.backToSet(); return true; }
      }
      if (e.altKey || !"wasdqe".includes(k) || k.length !== 1) return false;
      // D with something drivable selected is Drive, unless right is held (then it is fly right).
      if (k === "d" && !flying() && !e.shiftKey && stage.selected && stage.drive?.canDrive?.(stage.selected)) return false;
      e.preventDefault(); e.stopPropagation();
      if (rmb.down) rmb.keys = true;
      shift = e.shiftKey;
      if (!held.size && !e.repeat) tightKeys = !!stage._tightNow?.();   // inside a car / close in: small steps (once per press, not per frame)
      held.add(k);
      loop();
      return true;
    },
    keyup(e) {
      const k = (e.key || "").toLowerCase();
      shift = e.shiftKey;
      if (held.delete(k) || k === "shift") loop();
    },
    clearKeys() { held.clear(); },

    /** Double-click: glide to the object or point under the cursor (Free view only). */
    focusAt(e) {
      const o = active(); if (!o || !stage._pickRay) return false;
      if (!stage.freeView) { stage.onInteract?.("Double-click focuses in the Free view (press 0): it never moves the shot camera."); return false; }
      const rc = stage._pickRay(e);
      const hit = rc.intersectObjects([...(stage.actorMeshes?.values() || [])].filter((g) => g.visible), true)[0];
      const id = hit?.object?.userData?.actorId || hit?.object?.parent?.userData?.actorId || null;
      const ms = reduced ? 0 : 450;
      if (id && stage._frameActor?.(id, ms)) return true;
      const p = nav.pivotAt(e);
      if (!p) return false;
      const f = focusView(o.position, o.target, p);
      stage._flyTo(f.pos, f.tgt, ms || 1);
      return true;
    },

    /** Drag on the compass: orbit about the target. */
    compassDrag(dx, dy) { if (!off()) stage._navDrag("orbit", false, dx, dy, null); },
    dispose() {
      caf(rafId); rafId = 0;
      for (const [el, t, f, o] of listeners) el.removeEventListener(t, f, o);
      listeners.length = 0;
      nav._ui?.remove();
    },
  };

  function loop() { if (!rafId) { last = now(); rafId = raf(tick); } }
  function tick() {
    rafId = 0;
    const t = now(), dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
    last = t;
    if (off()) { acc = null; held.clear(); vel = [0, 0, 0]; return; }
    let busy = false;
    if (acc) {
      const [take, left] = consume(acc, dt, tauFromSmooth(settings.smooth), settings.damping);
      const a = acc;
      acc = Math.abs(left.dx) > 0 || Math.abs(left.dy) > 0 ? left : null;
      nav.apply(a.mode, a.look, take.dx, take.dy, a.pivot);
      if (!stage._dragging) dirty = true;
      busy = busy || !!acc;
    }
    const o = active();
    if (o) {
      const speed = flying() ? settings.flySpeed : walkSpeed(len(sub(o.position, o.target)), tightKeys);
      const want = flyStep(held, speed, 1, shift);
      const k = easeShare(dt, 0.15, settings.damping);
      vel = vel.map((v, i) => v + (want[i] - v) * k);
      if (Math.hypot(...vel) > 1e-3) {
        moveCam(o, vel.map((v) => v * dt));
        dirty = true;
        busy = true;
      } else vel = [0, 0, 0];
      if (held.size) busy = true;
    }
    if (busy) { rafId = raf(tick); return; }
    if (dirty && !stage._dragging) {
      dirty = false;
      if (!stage.freeView) stage.onChange?.(stage.toJSON?.());   // one shot-key write when the motion settles
    }
  }
  function moveCam(o, local) {
    const fwd = norm(sub(o.target, o.position));
    let right = cross(fwd, [0, 1, 0]);
    right = len(right) < EPS ? [1, 0, 0] : norm(right);
    const m = add(add(mul(right, local[0]), [0, local[1], 0]), mul(fwd, local[2]));
    o.position = add(o.position, m).map((v) => +v.toFixed(3));
    o.target = add(o.target, m).map((v) => +v.toFixed(3));
    if (stage.state?.environment?.set !== "water_tank" && o.position[1] < 0.15) {
      const lift = 0.15 - o.position[1];
      o.position[1] += lift; o.target[1] += lift;
    }
    stage._applyActive();
  }
  nav._tick = tick;
  nav._held = held;
  nav._rmb = rmb;
  stage.nav = nav;

  const cv = stage.canvas;
  if (!cv?.addEventListener) return nav;

  // Right button: track the press (fly / click), and hold back the context menu until we know it was a click.
  on(cv, "pointerdown", (e) => {
    press.x0 = e.clientX; press.y0 = e.clientY; press.moved = false;
    if (e.button === 2) Object.assign(rmb, { down: true, x0: e.clientX, y0: e.clientY, moved: false, keys: false, chord: false, menu: null });
    else { rmb.chord = false; rmb.keys = false; }
  }, { capture: true });
  on(cv, "pointermove", (e) => {
    if (e.buttons && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) >= 5) press.moved = true;
    if (rmb.down && Math.hypot(e.clientX - rmb.x0, e.clientY - rmb.y0) >= 5) rmb.moved = true;
  }, { capture: true });
  const up = (e) => {
    if (press.moved) press.bad = now();
    if (!rmb.down || (e.buttons & 2)) return;
    rmb.down = false;
    const click = !rmb.moved && !rmb.keys && !rmb.chord;
    if (!click) rmb.lastDragUp = now();
    held.clear();
    const m = rmb.menu; rmb.menu = null;
    if (click && m && e.type === "pointerup") {
      // A right click (not a drag): give the 3D view's own right-click menu the event it would have had.
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: m.clientX, clientY: m.clientY, button: 2 });
      ev.__ssReplay = true;
      cv.dispatchEvent(ev);
    }
  };
  on(cv, "pointerup", up);
  on(cv, "pointercancel", up);
  on(cv, "contextmenu", (e) => {
    if (e.__ssReplay) return;
    if (rmb.down) { e.preventDefault(); e.stopImmediatePropagation(); rmb.menu = { clientX: e.clientX, clientY: e.clientY }; return; }   // macOS: fires on press
    // Both buttons during a drag (macOS fires the menu on the second press), or just after a right-drag (Windows: on release).
    if ((stage._dragging && ((e.buttons & 3) === 3 || press.moved)) || now() - rmb.lastDragUp < 400) { e.preventDefault(); e.stopImmediatePropagation(); }   // Windows: after a right-drag
  }, { capture: true });
  on(cv, "keyup", (e) => nav.keyup(e));
  on(cv, "blur", () => { held.clear(); rmb.down = false; });
  on(cv, "dblclick", (e) => {
    if (off() || stage.poser?.active || stage.tc?.dragging || stage.live?.drag) return;
    if (press.moved || now() - press.bad < 600) return;     // a drag then a click is not a double-click
    if (stage.camViz?._keyCamAt?.(e)) return;               // a key camera keeps its click
    e.preventDefault();
    stage.nav.focusAt(e);                                    // via stage.nav: viewnav wraps it to remember the view
  });
  // Safari's pinch.
  let gs = 1;
  on(cv, "gesturestart", (e) => { e.preventDefault?.(); gs = 1; });
  on(cv, "gesturechange", (e) => {
    e.preventDefault?.();
    if (off() || !e.scale) return;
    const r = e.scale / gs; gs = e.scale;
    stage._onWheel?.({ deltaY: -Math.log(r) / 0.0018, deltaMode: 0, deltaX: 0, clientX: e.clientX, clientY: e.clientY, ctrlKey: false, __gesture: true });
  });
  buildUi();
  return nav;

  function buildUi() {
    if (typeof document === "undefined") return;
    if (!document.getElementById("ss-navhint-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-navhint-css", textContent: CSS }));
    const host = cv.parentElement;
    if (!host) return;
    const el = (tag, props = {}, kids = []) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
    const stop = (n) => { for (const t of ["pointerdown", "wheel", "contextmenu", "dblclick", "keydown"]) n.addEventListener(t, (e) => e.stopPropagation()); };
    const text = el("span", { className: "t" });
    const pick = el("select", { title: "Navigation style: the mouse buttons you're used to" }, NAV_STYLES.map((s) => el("option", { value: s, textContent: `${STYLE_NAMES[s]} ▾` })));
    pick.setAttribute("aria-label", "Navigation style");
    pick.addEventListener("change", () => nav.set("style", pick.value));
    const gear = el("button", { type: "button", textContent: "⚙", title: "Navigation settings" });
    gear.setAttribute("aria-label", "Navigation settings");
    const close = el("button", { type: "button", textContent: "✕", title: "Hide this hint (Navigation… on the viewport brings it back)" });
    close.setAttribute("aria-label", "Hide the navigation hint");
    const bar = el("div", { className: "ss-navhint" }, [text, pick, gear, close]);
    stop(bar);
    // Settings panel.
    const row = (label, input) => [el("label", { textContent: label }), input];
    const damp = el("input", { type: "checkbox", title: "Ease drags, scrolls and flying in and out" });
    const smooth = el("input", { type: "range", min: "0", max: "1", step: "0.05" });
    const inv = el("input", { type: "checkbox" });
    const tp = el("select", {}, [["auto", "Auto-detect"], ["mouse", "Mouse wheel (scroll zooms)"], ["trackpad", "Trackpad (scroll orbits)"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    const fs = el("input", { type: "number", min: "0.25", max: "64", step: "0.25" });
    fs.style.width = "5em";
    const showHint = el("input", { type: "checkbox" });
    const panel = el("div", { className: "ss-navpanel", hidden: true }, [el("h4", { textContent: "Navigation" }),
      ...row("Damping", damp), ...row("Smoothness", smooth), ...row("Invert up / down", inv), ...row("Scrolling", tp),
      ...row("Fly speed (m/s)", fs), ...row("Show the hint", showHint)]);
    stop(panel);
    damp.addEventListener("change", () => nav.set("damping", damp.checked));
    smooth.addEventListener("input", () => nav.set("smooth", +smooth.value));
    inv.addEventListener("change", () => nav.set("invertY", inv.checked));
    tp.addEventListener("change", () => nav.set("trackpad", tp.value));
    fs.addEventListener("change", () => nav.set("flySpeed", clamp(+fs.value || 4, 0.25, 64)));
    showHint.addEventListener("change", () => nav.set("hintDismissed", !showHint.checked));
    gear.addEventListener("click", () => { panel.hidden = !panel.hidden; place(); });
    close.addEventListener("click", () => { nav.set("hintDismissed", true); panel.hidden = true; });
    host.append(bar, panel);
    nav.openSettings = () => { panel.hidden = false; place(); };
    nav._render = () => {
      text.textContent = nav.hint();
      pick.value = settings.style;
      damp.checked = settings.damping; smooth.value = String(settings.smooth); inv.checked = settings.invertY;
      tp.value = settings.trackpad; fs.value = String(+settings.flySpeed.toFixed(2)); showHint.checked = !settings.hintDismissed;
      place();
    };
    function place() {
      const narrow = cv.offsetWidth < 560;
      const x = cv.offsetLeft + cv.offsetWidth / 2, bottom = cv.offsetTop + cv.offsetHeight;
      bar.hidden = settings.hintDismissed || off() || narrow || !cv.offsetHeight;
      Object.assign(bar.style, { left: `${x}px`, top: `${bottom - 34}px` });
      Object.assign(panel.style, { left: `${x}px`, top: `${Math.max(cv.offsetTop + 8, bottom - 44 - (panel.offsetHeight || 190))}px` });
      if (off()) panel.hidden = true;
    }
    nav._ui = { remove() { bar.remove(); panel.remove(); clearInterval(tid); } };
    const tid = setInterval(() => { if (!cv.isConnected && nav._seen) { nav.dispose(); return; } nav._seen = true; place(); }, 500);
    nav._render();
  }
}
