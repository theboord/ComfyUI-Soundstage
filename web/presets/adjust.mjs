// Adjust a camera preset after it is applied (the Adjust panel, web/ui/camadjust.mjs). Pure: no DOM, no THREE.
//
// A camera preset writes ordinary camera keys, so everything on the stage still edits them (drag the keys and the path
// in the Top view, the gizmo, the timeline, the lens). Adjust is the shortcut: the preset's own numbers (height,
// distance, angle, speed, lens; for a car mount the mount, its side and its offsets) as a few sliders, and each change
// re-keys the move from the same starting camera, as one undo step, instead of rebuilding it by hand.
//
//   import { adjustControls, adjustedSpec, postAdjust } from "./adjust.mjs";
//   adjustControls("aerial_up")                      // -> [{key, label, min, max, step, unit, kind, def}]
//   const spec = adjustedSpec(preset.apply.camera, values);    // the move's own numbers
//   const keys = postAdjust(cameraKeys(k0, spec, last).keys, values, { k0, last });   // angle, height, speed, lens

import { moveId } from "./engine.mjs";

const r3 = (v) => Math.round(v * 1000) / 1000;
const D2R = Math.PI / 180;

// Controls shared by the world-space moves. kind "spec": a number of the move itself (engine.mjs cameraKeys); "post":
// applied to the keys afterwards (postAdjust); "mount": a car mount setting (stage.setCarMount).
const ANGLE = { key: "angle_deg", label: "Angle", min: -180, max: 180, step: 5, unit: "°", kind: "post", def: 0,
  hint: "Swing the whole move round the subject" };
const HEIGHT = { key: "height_m", label: "Height", min: -1.5, max: 4, step: 0.05, unit: "m", kind: "post", def: 0, rel: true,
  hint: "Raise or lower the camera (the aim stays on the subject)" };
const SPEED = { key: "speed", label: "Speed", min: 0.5, max: 2, step: 0.05, unit: "×", kind: "post", def: 1,
  hint: "Faster finishes early and holds; slower is still moving when the shot ends" };
const LENS = { key: "lens_mm", label: "Lens", min: 12, max: 200, step: 1, unit: "mm", kind: "post", def: null,
  hint: "The focal length at the start (a dolly zoom keeps its ratio)" };

const spec = (key, label, min, max, step, unit, hint) => ({ key, label, min, max, step, unit, kind: "spec", hint });

/** The Adjust controls for each camera move, in the order the panel shows them. */
export const ADJUST = {
  push_in: [spec("amount", "Distance", 0.1, 0.9, 0.05, "×", "How much of the way to the subject it travels"), HEIGHT, ANGLE, SPEED, LENS],
  pull_out: [spec("amount", "Distance", 0.2, 2, 0.05, "×", "How far it backs away, as a share of the distance to the subject"), HEIGHT, ANGLE, SPEED, LENS],
  orbit: [spec("degrees", "Arc", -180, 180, 5, "°", "How far round the subject (negative = the other way)"), HEIGHT, SPEED, LENS],
  crane_up: [spec("metres", "Height", 0.5, 8, 0.1, "m", "How far the arm rises"), ANGLE, SPEED, LENS],
  crane_down: [spec("metres", "Height", 0.5, 8, 0.1, "m", "How far above eye line it starts"), ANGLE, SPEED, LENS],
  dolly_zoom: [spec("amount", "Strength", 0.2, 0.8, 0.05, "×", "How far it dollies in while the lens widens"), ANGLE, SPEED],
  whip_pan: [spec("degrees", "Whip", 20, 180, 5, "°", "How far it whips"), HEIGHT, SPEED, LENS],
  follow: [spec("metres", "Distance", 1, 6, 0.1, "m", "How far behind the shoulder"), spec("height", "Height", 0.6, 3, 0.05, "m", "Lens height"), LENS],
  aerial_up: [spec("metres", "Height", 3, 40, 0.5, "m", "How high it rises"), ANGLE, SPEED, LENS],
  aerial_down: [spec("metres", "Height", 4, 60, 0.5, "m", "How far above the subject"), spec("degrees", "Turn", -180, 180, 5, "°", "How far it turns round the subject while it climbs"), SPEED, LENS],
  aerial_across: [spec("metres", "Height", 3, 60, 0.5, "m", "How high it flies"), spec("distance", "Run", 6, 80, 1, "m", "How far it flies across"), ANGLE, SPEED, LENS],
  aerial_orbit: [spec("metres", "Height", 3, 60, 0.5, "m", "How high above the subject"), spec("distance", "Distance", 4, 60, 0.5, "m", "How far out from the subject"),
    spec("degrees", "Arc", -360, 360, 5, "°", "How far round (negative = the other way)"), SPEED, LENS],
  aerial_follow: [spec("metres", "Height", 2, 40, 0.5, "m", "How high above"), spec("distance", "Behind", 0, 40, 0.5, "m", "How far behind"), LENS],
  tracking_side: [spec("metres", "Travel", -10, 10, 0.25, "m", "How far it tracks (negative = the other way)"), HEIGHT, ANGLE, SPEED, LENS],
  arm_car: [spec("metres", "Distance", 2, 15, 0.25, "m", "How far off the car's side"), spec("height", "Height", 0.2, 3, 0.05, "m", "Lens height"),
    spec("focal_mm", "Lens", 14, 85, 1, "mm", "Focal length")],
  long_lens_pan: [spec("metres", "Distance", 12, 38, 0.5, "m", "How far off the car's path"), spec("height", "Height", 0.3, 4, 0.05, "m", "Lens height"),
    spec("focal_mm", "Lens", 50, 300, 1, "mm", "Focal length at that distance")],
  car_mount: [
    { key: "view", label: "Mount", kind: "mount", type: "select", hint: "Where on (or in, or behind) the car the camera is rigged" },
    { key: "side", label: "Side", kind: "mount", type: "side", hint: "Flip a side mount to the other side of the car" },
    { key: "fwd_m", label: "Forward", min: -1.5, max: 1.5, step: 0.05, unit: "m", kind: "mount", def: 0, hint: "Slide it along the car" },
    { key: "up_m", label: "Up", min: -0.4, max: 1.5, step: 0.05, unit: "m", kind: "mount", def: 0, hint: "Raise or lower it" },
    { key: "out_m", label: "Out", min: -0.3, max: 1.5, step: 0.05, unit: "m", kind: "mount", def: 0, hint: "Further out from the car (toward its side)" },
    { key: "yaw_deg", label: "Turn", min: -90, max: 90, step: 1, unit: "°", kind: "mount", def: 0, hint: "Turn the lens left or right" },
    { key: "tilt_deg", label: "Tilt", min: -40, max: 40, step: 1, unit: "°", kind: "mount", def: 0, hint: "Tilt the lens up or down" },
    { key: "focal_mm", label: "Lens", min: 8, max: 85, step: 1, unit: "mm", kind: "mount", def: null, hint: "Focal length" },
  ],
};

/** The controls for a preset's move (its camera spec, or a move name), each with its starting value filled in. */
export function adjustControls(specOrMove, values = {}) {
  const sp = typeof specOrMove === "string" ? { move: specOrMove } : (specOrMove || {});
  const list = ADJUST[moveId(sp.move)] || [];
  return list.map((c) => {
    const d = c.kind === "spec" ? (sp[c.key] ?? DEFAULTS[moveId(sp.move)]?.[c.key] ?? c.min) : c.def;
    return { ...c, def: d, value: values[c.key] ?? d };
  });
}

/** What engine.mjs cameraKeys uses when a spec leaves a number out (kept in step with it). */
const DEFAULTS = {
  push_in: { amount: 0.4 }, pull_out: { amount: 0.6 }, orbit: { degrees: 60 }, crane_up: { metres: 2.5 }, crane_down: { metres: 2.5 },
  dolly_zoom: { amount: 0.5 }, whip_pan: { degrees: 75 }, follow: { metres: 2.4, height: 1.62 }, aerial_up: { metres: 8 },
  aerial_down: { metres: 12, degrees: 20 }, aerial_across: { metres: 10, distance: 16 }, aerial_orbit: { metres: 10, degrees: 90, distance: 10 },
  aerial_follow: { metres: 8, distance: 10 }, tracking_side: { metres: 4 }, arm_car: { metres: 5, height: 0.8, focal_mm: 28 },
  long_lens_pan: { metres: 32, height: 1.2, focal_mm: 135 },
};

const clampTo = (c, v) => (Number.isFinite(c.min) ? Math.max(c.min, Math.min(c.max, v)) : v);

/** The preset's camera spec with the panel's "spec" values in (clamped to each control's range). */
export function adjustedSpec(sp, values = {}) {
  const out = { ...(sp || {}) };
  for (const c of ADJUST[moveId(out.move)] || []) {
    if (c.kind !== "spec" || values[c.key] == null || !Number.isFinite(+values[c.key])) continue;
    out[c.key] = clampTo(c, +values[c.key]);
  }
  return out;
}

/** The car-mount options for stage.setCarMount from the panel's values (offset in the mount's frame: out, up, forward). */
export function mountOpts(values = {}) {
  const o = {};
  if (values.view) o.view = values.view;
  if (values.side != null) o.side = +values.side === -1 ? -1 : 1;
  const off = [+values.out_m || 0, +values.up_m || 0, +values.fwd_m || 0];
  o.offset = off;
  for (const k of ["yaw_deg", "tilt_deg"]) o[k] = +values[k] || 0;
  o.focal_mm = Number.isFinite(+values.focal_mm) && +values.focal_mm > 0 ? +values.focal_mm : null;
  return o;
}

/** The panel's values for a shot's car mount (stage shot.camera_mount), the inverse of mountOpts. */
export function mountValues(m = {}) {
  const off = Array.isArray(m.offset) ? m.offset : [0, 0, 0];
  return { view: m.view, side: m.side === -1 ? -1 : 1, out_m: off[0] || 0, up_m: off[1] || 0, fwd_m: off[2] || 0,
    yaw_deg: m.yaw_deg || 0, tilt_deg: m.tilt_deg || 0, focal_mm: m.focal_mm ?? null };
}

/** Linear sample of a key track at a frame (for cutting a slowed move at the shot's end). */
function keyAt(keys, f) {
  if (f <= keys[0].frame) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (f <= b.frame) {
      const u = (f - a.frame) / Math.max(1e-6, b.frame - a.frame), mix = (p, q) => p.map((v, j) => r3(v + (q[j] - v) * u));
      return { frame: f, position: mix(a.position, b.position), target: mix(a.target, b.target), focal_mm: r3(a.focal_mm + (b.focal_mm - a.focal_mm) * u) };
    }
  }
  return keys[keys.length - 1];
}

/**
 * The "post" values on a move's keys: angle_deg swings every key round the subject (the base camera's aim, k0.target)
 * about the vertical; height_m raises every camera position (the aim stays); speed retimes the keys about frame 0
 * (a faster move finishes early and holds; a slower one is cut at the last frame with a key where it has got to);
 * lens_mm sets the first key's focal length and scales the others by the same ratio (a dolly zoom keeps its zoom).
 * Ride-along keys (in a car's or a person's own space) take height, speed and lens but not angle.
 */
export function postAdjust(keys, values = {}, { k0 = null, last = 96, local = false } = {}) {
  if (!Array.isArray(keys) || !keys.length) return keys;
  let out = keys.map((k) => ({ ...k, position: [...k.position], target: [...k.target] }));
  const ang = +values.angle_deg || 0;
  if (ang && !local) {
    const c = k0?.target || out[0].target, a = ang * D2R, cs = Math.cos(a), sn = Math.sin(a);
    const turn = (p) => { const x = p[0] - c[0], z = p[2] - c[2]; return [r3(c[0] + x * cs - z * sn), p[1], r3(c[2] + x * sn + z * cs)]; };
    out = out.map((k) => ({ ...k, position: turn(k.position), target: turn(k.target) }));
  }
  const dh = +values.height_m || 0;
  if (dh) out = out.map((k) => ({ ...k, position: [k.position[0], r3(k.position[1] + dh), k.position[2]] }));
  const sp = Math.max(0.25, Math.min(4, +values.speed || 1));
  if (Math.abs(sp - 1) > 1e-6 && out.length > 1) {
    const L = Math.max(1, Math.round(last));
    const timed = out.map((k) => ({ ...k, frame: k.frame / sp }));
    const kept = timed.filter((k) => k.frame <= L + 1e-6);
    if (kept.length < timed.length) kept.push({ ...keyAt(timed, L), frame: L });
    // Whole frames, one key per frame (two keys rounding onto one frame: the later wins).
    const byFrame = new Map();
    for (const k of kept) byFrame.set(Math.round(k.frame), { ...k, frame: Math.round(k.frame) });
    out = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  }
  const mm = +values.lens_mm;
  if (Number.isFinite(mm) && mm > 0 && out[0].focal_mm > 0) {
    const k = mm / out[0].focal_mm;
    out = out.map((q) => ({ ...q, focal_mm: r3(Math.max(6, Math.min(800, q.focal_mm * k))) }));
  }
  return out;
}

/** A short line for the panel: what the values change, e.g. "Height 12 m · Speed 1.5×". */
export function adjustSummary(controls) {
  return controls.filter((c) => c.type == null && c.value != null && c.value !== c.def)
    .map((c) => `${c.label} ${Math.round(c.value * 100) / 100}${c.unit === "×" || c.unit === "°" ? c.unit : ` ${c.unit}`}`).join(" · ");
}
