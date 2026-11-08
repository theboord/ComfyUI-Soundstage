// Stage navigation: how you move around the 3D set with the mouse, a trackpad and the keyboard.
//
//   Drag on empty space      orbit about the point under the cursor (not a point you can't see)
//   Both buttons + drag      pan (also Shift+drag and the middle button)
//   Hold right + W A S D Q E fly (mouse-look while held; the wheel changes fly speed)
//   W A S D Q E              glide while held (no more key-repeat stutter)
//   Double-click             glide to what you clicked (Free view only: it never rewrites a shot); a set piece or the
//                            floor moves the target there, keeping the view direction; never through a wall
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
    snap: "Numpad 1 / 3 / 7 (Ctrl: opposite)", keys: ["NumpadDecimal", "Home", "Numpad1", "Numpad3", "Numpad7", "Ctrl+Numpad1", "Ctrl+Numpad3", "Ctrl+Numpad7"],
    // Numpad "." types "." (Back to the set): in this style only the numpad's one frames the selection instead (viewnav.mjs).
    overrides: ["."] },
  maya: { orbit: "Alt+LMB, LMB on empty space", pan: "Alt+MMB, LMB+RMB", look: "—", dolly: "Alt+RMB drag",
    zoom: "Wheel, pinch", fly: "Hold RMB + WASD/QE", focus: "Double-click", frame: "F", frameAll: "Shift+A", snap: "Compass", keys: ["Shift+A"] },
  unreal: { orbit: "Alt+LMB", pan: "MMB, LMB+RMB", look: "Hold RMB", dolly: "Alt+RMB drag",
    zoom: "Wheel, pinch", fly: "Hold RMB + WASD/QE (wheel = speed)", focus: "Double-click", frame: "F", frameAll: ".",
    snap: "Compass", walk: "LMB drag on empty space: forward and turn", keys: [] },
};
export const NAV_ACTIONS = ["orbit", "pan", "look", "dolly", "zoom", "fly", "focus", "frame", "frameAll", "snap"];
/** Keys the App already uses: no style may bind them. */
/** The modifier keys whose press or release lets go of the held fly keys (not Shift: that is the 4x speed). */
const MOD_KEYS = ["Meta", "Alt", "AltGraph", "Control", "OS"];
export const TAKEN_KEYS = ["G", "R", "T", "P", "K", "L", "I", "O", "V", "H", "Tab", "?", "Space", "0", ".", ",", "F", "W", "A", "S", "D", "Q", "E"];

/**
 * The combo a style key types, written the way the shortcuts list writes it (comboText, PC labels): the numpad's digits
 * and "." type the same e.key as the main row, so "Numpad1" is "1", "Ctrl+NumpadDecimal" is "Ctrl+.".
 */
export const keyCombo = (k) => String(k).replace(/Numpad(\d)$/, "$1").replace(/NumpadDecimal$/, ".");
/**
 * A style's keys that collide with each other or with keys the App already uses. taken = combos as the shortcuts list
 * writes them (allCombos() in web/ui/shortcuts.mjs, plus TAKEN_KEYS). A style's `overrides` are collisions it means.
 * style = a style name or a preset object.
 */
export function bindingConflicts(style, taken = TAKEN_KEYS) {
  const p = typeof style === "string" ? PRESETS[style] : style;
  const out = [];
  const seen = new Set();
  for (const k of p?.keys || []) {
    const c = keyCombo(k);
    if (seen.has(c) || (taken.includes(c) && !(p.overrides || []).includes(c))) out.push(k);
    seen.add(c);
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
 * How far in front of the camera a point is, along the view direction (not the straight-line distance): the depth a pan
 * rate needs. A point off to the side of the frame is nearer in depth than in distance, so panning by its distance ran
 * ~10% ahead of the cursor near the frame edge. fwd = the camera's unit view direction.
 */
export const viewDepth = (pos, fwd, point) => Math.max(0.05, dot(sub(point, pos), fwd));

/**
 * The pivot an orbit turns about: the object under the cursor, else the floor under it (within maxFloor m; the water
 * tank has no floor to stop on), else the target. A pivot much farther than the target (the horizon) is not used.
 * hits: {mesh: [x,y,z] | null, floor: [x,y,z] | null}; origin is the camera.
 */
export function pickPivot({ mesh = null, floor = null } = {}, target, origin, { waterTank = false, maxFloor = 400, fallback = true } = {}) {
  const far = origin ? Math.max(50, 4 * len(sub(target, origin))) : Infinity;
  const ok = (p) => p && (!origin || len(sub(p, origin)) <= far);
  if (ok(mesh)) return mesh;
  if (!waterTank && floor && ok(floor) && (!origin || len(sub(floor, origin)) <= maxFloor)) return floor;
  return fallback ? target : null;   // fallback false: nothing under the cursor (the sky) is no point at all
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

/** Wheel events of one kind in a row before the kind changes (a known mouse never turns trackpad on one event). */
export const WHEEL_SURE = 3;
/** A pause (ms) between wheel events that starts a new gesture: the evidence so far decays to neutral. */
export const WHEEL_IDLE = 600;
/** A clear mouse notch: a legacy wheelDelta of a whole 120-step (Chrome / Safari / Edge give one for every notch). */
const notch = (e) => {
  const dx = e.deltaX || 0, dy = e.deltaY || 0;
  const legacy = Math.abs(dx) > Math.abs(dy) ? e.wheelDeltaX : e.wheelDeltaY;
  return Number.isFinite(legacy) && legacy !== 0 && legacy % 120 === 0;
};
/**
 * One wheel event's evidence: +1 looks like a trackpad, -1 like a mouse wheel, 0 says nothing. Line / page mode is only
 * ever a wheel (-WHEEL_SURE: sure at once). The legacy wheelDelta of the main axis decides when there is one (a notch is a
 * multiple of 120); else fractional pixel deltas look like a trackpad. deltaX alone says nothing: Shift+wheel and tilt
 * wheels scroll sideways too.
 */
export function wheelEvidence(e) {
  if (e.deltaMode) return -WHEEL_SURE;
  const dx = e.deltaX || 0, dy = e.deltaY || 0;
  const legacy = Math.abs(dx) > Math.abs(dy) ? e.wheelDeltaX : e.wheelDeltaY;
  if (Number.isFinite(legacy) && legacy !== 0) return legacy % 120 === 0 ? -1 : 1;
  return dx !== Math.trunc(dx) || dy !== Math.trunc(dy) ? 1 : 0;
}
const fracDelta = (e) => { const dx = e.deltaX || 0, dy = e.deltaY || 0; return dx !== Math.trunc(dx) || dy !== Math.trunc(dy); };

/**
 * Mouse wheel, trackpad scroll or pinch? mem = {kind, score, t} is the device seen so far: the evidence adds up
 * (-WHEEL_SURE..WHEEL_SURE) and the kind changes only once it is sure, so one odd trackpad-like event never flips a mouse.
 * A pause of WHEEL_IDLE ms starts a new gesture with the evidence back at neutral (the kind is kept). Back to the mouse
 * after a trackpad is quick: a clear notch (a 120-step legacy delta, or line mode) that starts a gesture switches at once,
 * and two in a row switch mid-stream (one, a fast trackpad flick that reads as a notch, doesn't).
 * Ctrl + wheel is a pinch only from a trackpad (or with fractional deltas that aren't a notch); a mouse's Ctrl + wheel is
 * the wheel, at browser zoom or display scaling too (fractional deltas, wheelDelta still a 120-step).
 * force = "mouse" | "trackpad" | "auto" (the ⚙ Scrolling setting).
 */
export function classifyWheel(e, mem = {}, now = 0, force = "auto") {
  const ev = wheelEvidence(e);
  const fresh = !Number.isFinite(mem.t) || now - mem.t > WHEEL_IDLE;
  if (fresh) mem.score = 0;   // a new gesture: what the last one looked like is not evidence about this one
  if (ev <= -WHEEL_SURE) mem.score = -WHEEL_SURE;
  else if (notch(e)) mem.score = fresh ? -WHEEL_SURE : Math.min(0, mem.score || 0) - (WHEEL_SURE - 1);
  else mem.score = clamp((mem.score || 0) + ev, -WHEEL_SURE, WHEEL_SURE);
  mem.score = clamp(mem.score, -WHEEL_SURE, WHEEL_SURE);
  if (!mem.kind) mem.kind = "mouse";
  if (mem.score >= WHEEL_SURE) mem.kind = "trackpad";
  else if (mem.score <= -WHEEL_SURE) mem.kind = "mouse";
  mem.t = now;
  const kind = force === "mouse" || force === "trackpad" ? force : mem.kind;
  // A notch is a mouse's even with fractional deltas (browser zoom or display scaling divides them; wheelDelta stays 120).
  if (e.ctrlKey) return kind === "trackpad" || (fracDelta(e) && !notch(e)) ? "pinch" : "mouse";
  return kind;
}

/**
 * Where a ray enters an oriented box (a set collider {half, pos, quat}), as the distance along the unit dir; null for a
 * miss or when the origin is inside the box (a camera in a building proxy is not stopped by its own walls).
 */
export function rayBoxT(origin, dir, half, pos, quat = [0, 0, 0, 1]) {
  const inv = [-quat[0], -quat[1], -quat[2], quat[3]];
  const rot = (v, q) => {   // v + 2w(q x v) + 2 q x (q x v)
    const u = [q[0], q[1], q[2]], c1 = cross(u, v), c2 = cross(u, c1);
    return add(add(v, mul(c1, 2 * q[3])), mul(c2, 2));
  };
  const o = rot(sub(origin, pos), inv), d = rot(dir, inv);
  let t0 = -Infinity, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (Math.abs(o[i]) > half[i]) return null; continue; }
    let a = (-half[i] - o[i]) / d[i], b = (half[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0 >= 0 ? t0 : null;
}

/**
 * The view a double-click on a point gives when focusView's path is blocked (a wall behind you, or between): along the
 * click ray toward the point, never past it, at most 12 m short of it (where you are when you are already within 12 m). The
 * clicked point is the nearest surface on that ray, so this path never crosses one.
 */
export function focusAlongRay(pos, point, { min = 2, max = 12 } = {}) {
  const v = sub(point, pos), d = len(v);
  if (d < EPS) return { pos: [...pos], tgt: [...point] };
  const keep = clamp(d, Math.min(min, d), max);
  return { pos: add(point, mul(v, -keep / d)), tgt: [...point] };
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

/**
 * Where the hint bar goes: along the viewport's bottom, between whatever already sits there (the shot-camera picture at
 * the bottom left, the Top view inset at the bottom right), else lifted above them. Rects {left, top, width, height}
 * are in the host's coordinates. Returns {right, top, maxWidth}: the bar is right-aligned at `right`.
 */
export function hintPlacement(view, obstacles = [], { h = 26, gap = 8, min = 240, inset = 34 } = {}) {
  const cx = view.left + view.width / 2;
  const obs = obstacles.filter((o) => o && o.width > 0 && o.height > 0 && o.left < view.left + view.width && o.left + o.width > view.left);
  let top = view.top + view.height - inset;
  let place = null;
  for (let i = 0; i < 4; i++) {
    let left = view.left + gap, right = view.left + view.width - gap;
    const band = obs.filter((o) => o.top < top + h && o.top + o.height > top);
    for (const o of band) {
      if (o.left + o.width / 2 >= cx) right = Math.min(right, o.left - gap);
      else left = Math.max(left, o.left + o.width + gap);
    }
    place = { right, top, maxWidth: Math.max(0, right - left) };
    if (!band.length || right - left >= min) return place;
    top = Math.min(...band.map((o) => o.top)) - h - gap;   // no room between them: sit just above the taller one
    if (top < view.top) break;
  }
  return { right: view.left + view.width - gap, top: Math.max(view.top + gap, top), maxWidth: Math.max(min, view.width - 2 * gap) };
}

// ---------------------------------------------------------------- the controller
const CSS = `.ss-navhint{position:absolute;z-index:5;transform:translateX(-100%);display:flex;align-items:center;gap:6px;max-width:92%;
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
  const held = new Set();      // fly keys held (letters, for flyDir)
  const heldCodes = new Map(); // the physical key (e.code) -> its letter: a keyup finds it even when Option changed e.key
  let vel = [0, 0, 0];         // fly velocity, camera space (m/s)
  let shift = false, tightKeys = false;
  let rafId = 0, last = 0, dirty = false;
  const rmb = { down: false, noFly: false, x0: 0, y0: 0, moved: false, keys: false, chord: false, menu: null, lastDragUp: 0 };
  const press = { moved: false, x0: 0, y0: 0, bad: 0 };
  const wheelMem = {};
  const listeners = [];
  const on = (el, t, f, o) => { if (!el?.addEventListener) return; el.addEventListener(t, f, o); listeners.push([el, t, f, o]); };

  const off = () => !!stage.drive?.on;
  const active = () => stage._activeOrbit?.();
  // An Alt + right press is a dolly (Maya, Unreal) or a look, never fly mode: the wheel zooms and WASD walks as usual.
  const flying = () => rmb.down && !rmb.noFly && !off();
  /** Right is no longer held (Drive swallowed its release, or it came up off the canvas): fly mode ends. */
  const rmbGone = () => { if (!rmb.down) return; rmb.down = false; rmb.menu = null; rmb.lastDragUp = now(); clearHeld(); };
  function clearHeld() { held.clear(); heldCodes.clear(); }
  const codeOf = (e, k) => e.code || `key:${k}`;
  /** Is this node and every parent shown? (three.js raycasts hidden objects too) */
  const shown = (o) => { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; };
  const actorIdOf = (o) => { for (let n = o; n; n = n.parent) if (n.userData?.actorId) return n.userData.actorId; return null; };
  /**
   * The nearest surface on the pick ray: an object (unless actors: false), the set's boxes (set colliders: buildings,
   * kerbs, set pieces, an imported world's proxies) and the interior's walls and floors (the ones the dollhouse
   * cutaway or the ceiling hide from this view don't count). pre = the stage's own actor raycast for this press (reused,
   * not cast again). Returns {dist, point, id} or null.
   */
  function surfaceHit(rc, { actors = true, pre = null, hidden = null } = {}) {
    const r = rc.ray;
    const origin = [r.origin.x, r.origin.y, r.origin.z], dir = [r.direction.x, r.direction.y, r.direction.z];
    let best = null;
    const take = (d, point, id = null) => { if (d > 1e-4 && (!best || d < best.dist)) best = { dist: d, point, id }; };
    if (actors) {
      const hits = pre || rc.intersectObjects([...(stage.actorMeshes?.values() || [])].filter((g) => g.visible !== false), true);
      const h = hits.find((x) => shown(x.object));
      if (h) take(h.distance ?? len(sub([h.point.x, h.point.y, h.point.z], origin)), [h.point.x, h.point.y, h.point.z], actorIdOf(h.object));
    }
    for (const c of stage._setCollidersCached?.() || []) {
      if (c.interior) continue;   // the interior's own meshes are cast below (the cutaway can hide them)
      if (c.src && !shown(c.src)) continue;   // a hidden set piece (or a hidden part of one) catches nothing
      const t = rayBoxT(origin, dir, c.half, c.pos, c.quat);
      if (t != null) take(t, add(origin, mul(dir, t)));
    }
    const ig = stage.interiorGroup;
    if (ig?.children?.length) {
      const hide = hidden || stage._cutawayHidden?.(r.origin) || new Set();
      const h = rc.intersectObjects(ig.children.filter((m) => shown(m) && !hide.has(m)), false)[0];
      if (h) take(h.distance, [h.point.x, h.point.y, h.point.z]);
    }
    return best;
  }
  /**
   * Does the straight path a -> b cross a wall or a set box? (objects don't count: you glide past people) It casts its own
   * raycaster: the stage's shared pick ray (rc) is never changed.
   */
  let sightRc = null;
  function blocked(rc, a, b, hidden) {
    const v = sub(b, a), L = len(v);
    if (L < 0.05) return false;
    const d = mul(v, 1 / L);
    if (!sightRc) {
      // A three.js Raycaster of its own; anything else (a test's stand-in) gets a copy with a ray of its own.
      sightRc = rc.ray?.origin?.isVector3 ? new rc.constructor()
        : Object.assign(Object.create(Object.getPrototypeOf(rc)), rc, { ray: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } } });
    }
    if (sightRc !== rc && sightRc.layers && rc.layers) sightRc.layers.mask = rc.layers.mask;
    if (rc.camera) sightRc.camera = rc.camera;
    if (rc.params) sightRc.params = rc.params;
    Object.assign(sightRc.ray.origin, { x: a[0], y: a[1], z: a[2] }); Object.assign(sightRc.ray.direction, { x: d[0], y: d[1], z: d[2] });
    const h = surfaceHit(sightRc, { actors: false, hidden });
    return !!h && h.dist < L - 0.1;
  }
  /** The floor (y = 0) under the pick ray, or null. */
  function floorHit(r) {
    const origin = [r.origin.x, r.origin.y, r.origin.z], dir = [r.direction.x, r.direction.y, r.direction.z];
    if (dir[1] >= -1e-4) return null;
    const t = -origin[1] / dir[1];
    return t > 0 ? { dist: t, point: add(origin, mul(dir, t)) } : null;
  }
  /** Fly speed: inside a car or room (or close in) right-held flying uses the small tight step, not the set's m/s. */
  const flySpeedNow = (o) => (rmb.tight ? Math.min(settings.flySpeed, walkSpeed(len(sub(o.position, o.target)), true)) : settings.flySpeed);
  /** The shot camera moved while a press / drag held its write back: write it now (Camera view). */
  const settle = () => { if (!dirty) return; dirty = false; if (!stage.freeView) stage.onChange?.(stage.toJSON?.()); };

  const nav = {
    settings,
    save() { saveNavSettings(settings, store); nav._render?.(); },
    set(k, v) { settings[k] = v; nav.save(); },
    altTurns: () => altTurns(settings.style),
    hint: () => hintText(settings.style, /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || "")),

    /** A camera press: what this drag does, and the pivot an orbit turns about. */
    begin(e, actorHits = null) {
      const g = resolveGesture(settings.style, { button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
      acc = null;
      let pivot = null;
      // pan: that point follows the cursor. actorHits = the stage's raycast for this press (not cast a second time).
      if ((g.mode === "orbit" && !g.look) || g.mode === "pan") pivot = nav.pivotAt(e, true, actorHits);
      return { ...g, pivot };
    },
    /** The point under the cursor an orbit turns about (the nearest object / set box / wall, the floor, else the target). */
    pivotAt(e, fallback = true, actorHits = null) {
      const o = active();
      if (!o || !stage._pickRay) return null;
      try { return pivotFrom(stage._pickRay(e), o, fallback, actorHits)?.point || null; } catch { return null; }
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
    /** Motion still being eased in after a release (the stage leaves the shot-key write to the frame loop then). */
    pending: () => !!acc || held.size > 0 || Math.hypot(...vel) > 1e-3,
    /** Hand the drag's not-yet-applied delta to a flick's glide (so the two don't both move the camera): {dx, dy}. */
    takeLeft() { const a = acc; acc = null; return a ? { dx: a.dx, dy: a.dy } : { dx: 0, dy: 0 }; },
    flush() { if (acc) { const a = acc; acc = null; nav.apply(a.mode, a.look, a.dx, a.dy, a.pivot); } },
    halt() { acc = null; vel = [0, 0, 0]; settle(); },
    /** A camera drag ended: report a shot-camera move the frame loop held back while the button was down. */
    end() { if (!acc && !held.size && Math.hypot(...vel) <= 1e-3) settle(); },
    /** The stage just wrote the shot key itself: nothing held back is left to write. */
    wrote() { if (!acc && !held.size && Math.hypot(...vel) <= 1e-3) dirty = false; },
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

    /** The last wheel event's kind ("mouse" | "trackpad" | "pinch"; null when the wheel was not classified). */
    lastWheel: null,
    /** Is this Ctrl + wheel a pinch (zoomed up 5x)? Only from a trackpad or with fractional deltas: a mouse's is the wheel. */
    isPinch: (e) => !!e.ctrlKey && (nav.lastWheel ? nav.lastWheel === "pinch" : fracDelta(e)),
    /** Wheel: fly speed while flying, trackpad orbit / pan; false = the stage zooms as before. */
    wheel(e) {
      nav.lastWheel = null;
      if (off() || e.__gesture) return false;
      if (flying()) {
        settings.flySpeed = flySpeedFromWheel(settings.flySpeed, e.deltaY);
        nav.save();
        stage.onInteract?.(`Fly speed ${settings.flySpeed.toFixed(2)} m/s`);
        return true;
      }
      const kind = nav.lastWheel = classifyWheel(e, wheelMem, now(), settings.trackpad);
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
      if (e.metaKey || e.altKey || e.ctrlKey) nav.dropKeys();   // macOS sends no keyup for a key let go while ⌘ is down; ⌥ changes e.key
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
      heldCodes.set(codeOf(e, k), k);   // by the physical key: its keyup is matched by e.code, whatever e.key says then
      held.add(k);
      loop();
      return true;
    },
    keyup(e) {
      if (e.metaKey || MOD_KEYS.includes(e.key)) { nav.dropKeys(); return; }
      const k = (e.key || "").toLowerCase();
      shift = e.shiftKey;
      const code = codeOf(e, k);
      if (heldCodes.has(code)) {
        heldCodes.delete(code);
        held.clear();
        for (const v of heldCodes.values()) held.add(v);
        loop();
      } else if (k === "shift") loop();
    },
    clearKeys() { clearHeld(); },
    /** Let go of every held fly key (the motion eases out, and the shot key is written once it stops). */
    dropKeys() { if (!held.size && !heldCodes.size) return; clearHeld(); loop(); },

    /** Double-click: glide to the object or point under the cursor (Free view only). */
    focusAt(e) {
      const o = active(); if (!o || !stage._pickRay) return false;
      if (!stage.freeView) { stage.onInteract?.("Double-click focuses in the Free view (press 0): it never moves the shot camera."); return false; }
      const rc = stage._pickRay(e);
      const ms = reduced ? 0 : 450;
      const hidden = stage._cutawayHidden?.({ x: o.position[0], y: o.position[1], z: o.position[2] });
      // Any real surface, however far (the orbit pivot's distance cap is for orbiting, not for this); the sky / empty
      // space is no point, so nothing moves (it pulled a far camera to 12 m).
      const hit = pivotFrom(rc, o, false, null, hidden, { cap: false });
      if (!hit) return false;
      const p = hit.point;
      // An object is framed whole; a set piece (a building, a wall, the location) is a place: the target moves to the
      // clicked point and the view keeps its direction, like a click on the floor.
      if (hit.id && !stage._isSetPiece?.(hit.id)) {
        const fv = stage._frameView?.(hit.id);
        if (!fv || (!blocked(rc, o.position, fv.pos, hidden) && !blocked(rc, fv.pos, fv.tgt, hidden))) {
          if (stage._frameActor?.(hit.id, ms)) return true;
        }
      }
      let f = focusView(o.position, o.target, p);
      // Never through a wall: when the glide (or the new view of the point) crosses one, go along the click ray instead.
      if (blocked(rc, o.position, f.pos, hidden) || blocked(rc, f.pos, p, hidden)) f = focusAlongRay(o.position, p);
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

  /**
   * The pivot hit {point, id}: the nearest surface, or the floor when that is nearer; null = nothing (fallback false).
   * cap false (double-click): a surface counts at any distance, the floor within 400 m; the orbit pivot (cap true) drops
   * what is far beyond the target (pickPivot).
   */
  function pivotFrom(rc, o, fallback, actorHits = null, hidden = null, { cap = true } = {}) {
    const s = surfaceHit(rc, { pre: actorHits, hidden }), fl = floorHit(rc.ray);
    const useMesh = s && (!fl || s.dist <= fl.dist);
    if (!cap) {
      if (useMesh) return { point: s.point, id: s.id };
      const water = stage.state?.environment?.set === "water_tank";
      return fl && !water && fl.dist <= 400 ? { point: fl.point, id: null } : null;
    }
    const p = pickPivot({ mesh: useMesh ? s.point : null, floor: fl && !useMesh ? fl.point : null }, o.target, o.position,
      { waterTank: stage.state?.environment?.set === "water_tank", fallback });
    if (!p) return null;
    return { point: p, id: useMesh && p === s.point ? s.id : null };
  }
  function loop() { if (!rafId) { last = now(); rafId = raf(tick); } }
  function tick() {
    rafId = 0;
    // Up to 0.25 s a frame: a heavy set at 4-15 fps still flies at the set speed (0.05 s capped it to a crawl there);
    // a long stall after a hidden tab can't jump far, since loop() restarts the clock.
    const t = now(), dt = Math.min(0.25, Math.max(0.001, (t - last) / 1000));
    last = t;
    if (off()) { acc = null; clearHeld(); vel = [0, 0, 0]; rmb.down = false; return; }
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
      const speed = flying() ? flySpeedNow(o) : walkSpeed(len(sub(o.position, o.target)), tightKeys);
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
    if (!stage._dragging) settle();   // one shot-key write when the motion settles
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
    if (off()) { rmb.down = false; clearHeld(); return; }   // Drive owns the pointer (and swallows the release)
    press.x0 = e.clientX; press.y0 = e.clientY; press.moved = false;
    if (e.button === 2) Object.assign(rmb, { down: true, noFly: !!e.altKey, x0: e.clientX, y0: e.clientY, moved: false, keys: false, chord: false, menu: null, tight: !!stage._tightNow?.() });
    else { if (!((e.buttons ?? 0) & 2)) rmbGone(); rmb.chord = false; rmb.keys = false; }
  }, { capture: true });
  on(cv, "pointermove", (e) => {
    if (rmb.down && e.buttons != null && !(e.buttons & 2)) rmbGone();   // right came up where we never saw it
    if (e.buttons && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) >= 5) press.moved = true;
    if (rmb.down && Math.hypot(e.clientX - rmb.x0, e.clientY - rmb.y0) >= 5) rmb.moved = true;
  }, { capture: true });
  const up = (e) => {
    if (press.moved) press.bad = now();
    // A both-buttons pan that began with left: right's release never set rmb.down, but Windows still fires the menu after it.
    if (rmb.chord && !((e.buttons ?? 0) & 3)) rmb.lastDragUp = now();
    if (!rmb.down || (e.buttons & 2)) return;
    rmb.down = false;
    const click = !rmb.moved && !rmb.keys && !rmb.chord;
    if (!click) rmb.lastDragUp = now();
    clearHeld();
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
  // Fallback: right released off the canvas without pointer capture (the gizmo's early return), or while Drive's window
  // capture listener swallows it. Registered before Drive's (at install), so it still sees the event first.
  const winUp = (e) => {
    if (!rmb.down || ((e.buttons ?? 0) & 2)) return;
    if (e.target === cv && !off()) return;   // the canvas listener has it
    rmbGone();
  };
  on(globalThis, "pointerup", winUp, { capture: true });
  on(globalThis, "pointercancel", winUp, { capture: true });
  on(cv, "contextmenu", (e) => {
    if (e.__ssReplay) return;
    if (rmb.down) { e.preventDefault(); e.stopImmediatePropagation(); rmb.menu = { clientX: e.clientX, clientY: e.clientY }; return; }   // macOS: fires on press
    // Both buttons during a drag (macOS fires the menu on the second press), or just after a right-drag (Windows: on release).
    if ((stage._dragging && ((e.buttons & 3) === 3 || press.moved)) || now() - rmb.lastDragUp < 400) { e.preventDefault(); e.stopImmediatePropagation(); }   // Windows: after a right-drag
  }, { capture: true });
  on(cv, "keyup", (e) => nav.keyup(e));
  // A modifier pressed (⌘, ⌥, Ctrl): the stage's own keydown returns early for ⌘Z / ⌘D, so this runs first (capture) and
  // lets go of the held keys. macOS sends no keyup for a key let go while ⌘ is down, and ⌥ changes the e.key a keyup
  // carries (W -> ∑), so a held W could stick. Shift is left out on purpose: it is the 4x speed while flying.
  on(cv, "keydown", (e) => { if (e.metaKey || e.altKey || e.ctrlKey || MOD_KEYS.includes(e.key)) nav.dropKeys(); }, { capture: true });
  on(globalThis.document, "visibilitychange", () => nav.dropKeys());
  on(globalThis, "blur", () => nav.dropKeys());
  // The pointer left the window (the page's root, or a pointerout to nowhere): keyups can go to another app from here.
  on(globalThis.document?.documentElement, "pointerleave", () => nav.dropKeys());
  on(globalThis, "pointerout", (e) => { if (!e.relatedTarget) nav.dropKeys(); });
  on(cv, "blur", () => { clearHeld(); rmb.down = false; });
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
    // The style is in the panel too, so it can be changed with the hint hidden.
    const style2 = el("select", { title: "The mouse buttons you're used to" }, NAV_STYLES.map((s) => el("option", { value: s, textContent: STYLE_NAMES[s] })));
    style2.addEventListener("change", () => nav.set("style", style2.value));
    const panel = el("div", { className: "ss-navpanel", hidden: true }, [el("h4", { textContent: "Navigation" }),
      ...row("Style", style2), ...row("Damping", damp), ...row("Smoothness", smooth), ...row("Invert up / down", inv), ...row("Scrolling", tp),
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
      text.textContent = text.title = nav.hint();   // the title shows the whole line when it is cut short
      pick.value = settings.style; style2.value = settings.style;
      damp.checked = settings.damping; smooth.value = String(settings.smooth); inv.checked = settings.invertY;
      tp.value = settings.trackpad; fs.value = String(+settings.flySpeed.toFixed(2)); showHint.checked = !settings.hintDismissed;
      place();
    };
    function place() {
      const narrow = cv.offsetWidth < 560;
      const x = cv.offsetLeft + cv.offsetWidth / 2, bottom = cv.offsetTop + cv.offsetHeight;
      bar.hidden = settings.hintDismissed || off() || narrow || !cv.offsetHeight;
      // Clear of what sits on the viewport's bottom edge: the shot-camera picture (bottom left) and the Top view inset
      // (bottom right) are measured each time, since either can be shown, hidden or resized.
      const hr = host.getBoundingClientRect?.() || { left: 0, top: 0 };
      const rel = (n) => { if (!n || n.hidden || !n.offsetWidth) return null; const r = n.getBoundingClientRect(); return { left: r.left - hr.left, top: r.top - hr.top, width: r.width, height: r.height }; };
      const obstacles = [...host.querySelectorAll?.(".ss-pip, .ss-top") || []].map(rel);
      const at = hintPlacement({ left: cv.offsetLeft, top: cv.offsetTop, width: cv.offsetWidth, height: cv.offsetHeight }, obstacles);
      Object.assign(bar.style, { left: `${at.right}px`, top: `${at.top}px`, maxWidth: `${at.maxWidth}px` });
      Object.assign(panel.style, { left: `${x}px`, top: `${Math.max(cv.offsetTop + 8, bottom - 44 - (panel.offsetHeight || 190))}px` });
      if (off()) panel.hidden = true;
    }
    nav._ui = { remove() { bar.remove(); panel.remove(); clearInterval(tid); } };
    const tid = setInterval(() => { if (!cv.isConnected && nav._seen) { nav.dispose(); return; } nav._seen = true; place(); }, 500);
    nav._render();
  }
}
