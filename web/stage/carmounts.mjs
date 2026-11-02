// Car camera mounts: where a camera can be rigged on (or in, or behind) a car, for any car on set. Pure: no THREE, no
// DOM, so the stage, the Presets runner, the Adjust panel and node tests share the same numbers.
//
//   import { CAR_MOUNTS, MOUNT_GROUPS, mountKey, onSprungBody, mountRoll } from "./carmounts.mjs";
//   mountKey("side_rear_wheel", { kind: "sports_car" }, { side: -1, offset: [0, 0.1, 0.3] })
//     -> { frame: 0, position, target, focal_mm }   (car space: +Z forward, +X = the car's left, the driver's side)
//
// A mount is one camera key in the car's own space, so it rides the car's motion; a hard mount or an interior camera
// is also bolted to the sprung body (sprung: true), so it leans and dips with the body's roll and pitch on its
// springs (stage.mjs _vehicleDynamics) and its horizon tilts with the car. A chase camera is another car following:
// it is not bolted on, and it swings round behind the car a beat late (lag_s) instead of snapping with every turn.
//
// Each mount is placed from the car's size (CAR_DIMS: bumper to bumper, roof, half-width, axles), so a roof cam clears
// a police car's light bar and a side mount clears a sedan's flank. The numbers were measured on the stage's models:
// sports_car.glb (4.5 m, roof 1.38 m, body 0.93 m from the centre line, axles at about +/-1.44 m), police_car.glb (4.8 m,
// 1.59 m with the bar), car.glb (the hatchback, 4.2 m, 1.17 m) and the built sedan (library.mjs: 4.6 m, 1.43 m, 0.91 m).

const r3 = (v) => Math.round(v * 1000) / 1000;
const DEG = Math.PI / 180;

/** Car sizes at their library height (L bumper to bumper, H roof, W half-width of the body, wf / wr axle z). */
export const CAR_DIMS = {
  car: { ref: 1.45, L: 4.6, H: 1.43, W: 0.91, wf: 1.4, wr: -1.35 },
  sports_car: { ref: 1.2, L: 4.5, H: 1.38, W: 0.93, wf: 1.44, wr: -1.44 },
  police_car: { ref: 1.6, L: 4.8, H: 1.59, W: 0.98, wf: 1.5, wr: -1.5 },
  hatchback: { ref: 1.5, L: 4.2, H: 1.17, W: 0.9, wf: 1.3, wr: -1.3 },
};

/** The car's size as it stands on set (height_m scales it like the stage does), with a guess for any other vehicle. */
export function carDims(host = {}) {
  const d = CAR_DIMS[host.kind];
  if (d) {
    const s = (+host.height_m || d.ref) / d.ref;
    return { L: d.L * s, H: d.H * s, W: d.W * s, wf: d.wf * s, wr: d.wr * s, s, known: true };
  }
  // A truck, a van or anything else with wheels: the sedan's proportions at its height (a guess; see the PR's flaws).
  const H = +host.height_m || +host.ref || 1.45, s = H / 1.43;
  return { L: 4.6 * s, H, W: 0.91 * s, wf: 1.4 * s, wr: -1.35 * s, s, known: false };
}

/**
 * The mounts, in the order the picker shows them. at(d, side) gives {position, target} in car space for car size d
 * (side = 1 for the car's left, the driver's side; -1 mirrors it to the right). sprung: bolted to the body.
 * Where an older mount already existed (CAR_SHOTS in stage.mjs), its id is kept so saved scenes keep working.
 */
export const CAR_MOUNTS = {
  // ---- front
  hood_forward: { group: "Front", label: "Hood, looking ahead (over the bonnet)", sprung: true, focal_mm: 24,
    at: (d) => ({ position: [0, 0.65 * d.H + 0.18, 0.62 * d.L / 2], target: [0, 0.6 * d.H, d.L / 2 + 10] }) },
  windshield: { group: "Front", label: "Hood, looking back through the windshield (two-shot)", sprung: true, focal_mm: 30, fixed: true },
  bumper: { group: "Front", label: "Front bumper (low, road ahead)", sprung: true, focal_mm: 18, fixed: true },
  // ---- back
  rear_bumper: { group: "Back", label: "Rear bumper, looking back (at whoever is chasing)", sprung: true, focal_mm: 18,
    at: (d) => ({ position: [0, 0.4 * d.s, -(d.L / 2 + 0.25 * d.s)], target: [0, 0.4 * d.s, -(d.L / 2 + 12)] }) },
  trunk: { group: "Back", label: "On the trunk, looking ahead over the roof", sprung: true, focal_mm: 20,
    at: (d) => ({ position: [0, 0.8 * d.H + 0.2 * d.s, -0.9 * d.L / 2], target: [0, 0.75 * d.H, d.L / 2 + 12] }) },
  // ---- top
  roof: { group: "Top", label: "Roof, looking ahead", sprung: true, focal_mm: 20,
    at: (d) => ({ position: [0, d.H + 0.25 * d.s, -0.05 * d.L / 2], target: [0, 0.85 * d.H, d.L / 2 + 12] }) },
  // ---- side (mirror with side = -1)
  side_door: { group: "Side", label: "Side door, looking ahead along the car", sprung: true, focal_mm: 16, sided: true,
    at: (d, k) => ({ position: [k * (d.W + 0.28 * d.s), 0.68 * d.H, -0.05 * d.L / 2], target: [k * (d.W + 0.1 * d.s), 0.55 * d.H, d.L / 2 + 8] }) },
  side_front_wheel: { group: "Side", label: "Side, low at the front wheel", sprung: true, focal_mm: 14, sided: true,
    at: (d, k) => ({ position: [k * (d.W + 0.35 * d.s), 0.3 * d.s, d.wf - 0.85 * d.s], target: [k * (d.W - 0.05 * d.s), 0.28 * d.s, d.L / 2 + 6] }) },
  side_rear_wheel: { group: "Side", label: "Side, low at the rear wheel, looking ahead along the car", sprung: true, focal_mm: 14, sided: true,
    at: (d, k) => ({ position: [k * (d.W + 0.35 * d.s), 0.3 * d.s, d.wr - 0.75 * d.s], target: [k * (d.W - 0.1 * d.s), 0.4 * d.s, d.L / 2] }) },
  front_wheel: { group: "Side", label: "Over the front tyre, looking back", sprung: true, focal_mm: 14, sided: true, fixed: true },
  tyre_close: { group: "Side", label: "Tyre close-up (front wheel, low)", sprung: true, focal_mm: 28, sided: true,
    at: (d, k) => ({ position: [k * (d.W + 0.6 * d.s), 0.32 * d.s, d.wf + 0.9 * d.s], target: [k * (d.W - 0.1 * d.s), 0.3 * d.s, d.wf] }) },
  // ---- inside (the built sedan's seats: stage.mjs CAR_SHOTS)
  dash_two_shot: { group: "Inside", label: "Dashboard, looking back at both front seats", sprung: true, focal_mm: 20, fixed: true },
  driver_pov: { group: "Inside", label: "Driver's POV (road ahead)", sprung: true, focal_mm: 24, fixed: true },
  passenger_on_driver: { group: "Inside", label: "From the passenger seat, on the driver", sprung: true, focal_mm: 32, fixed: true },
  back_seat: { group: "Inside", label: "From the back seat (both front seats + road)", sprung: true, focal_mm: 22, fixed: true },
  back_seat_single: { group: "Inside", label: "Between the front seats, back at the back seat", sprung: true, focal_mm: 24, fixed: true },
  // ---- following (not bolted on)
  chase: { group: "Following", label: "Chase, trailing behind", sprung: false, lag_s: 0.4, focal_mm: 35,
    at: (d) => ({ position: [0, 0.6 * d.H + 0.6 * d.s, -(d.L / 2 + 6 * d.s)], target: [0, 0.5 * d.H, 0] }) },
  side_tracking: { group: "Following", label: "Tracking alongside (outside)", sprung: false, focal_mm: 35, sided: true, fixed: true },
  top_down: { group: "Following", label: "Aerial down (overhead)", sprung: false, focal_mm: 24, fixed: true },
};

export const MOUNT_GROUPS = ["Front", "Back", "Top", "Side", "Inside", "Following"];

/** What the mount's mirrored-to-the-other-side key is called, for the Adjust panel ("left" = the driver's side). */
export const SIDES = { 1: "left (driver's side)", "-1": "right (passenger side)" };

/**
 * The mount's camera key in car space. fixedShots: the stage's CAR_SHOTS (static positions measured on the sports car,
 * scaled with the car's height). opts: side (1 | -1, for the side mounts), offset [x (toward the mount's side), y up,
 * z forward] in metres, yaw_deg (turn the view left / right round the lens), focal_mm (the lens; null = the mount's).
 */
export function mountKey(view, host = {}, opts = {}, fixedShots = null) {
  const m = CAR_MOUNTS[view];
  const d = carDims(host);
  const side = m?.sided && +opts.side === -1 ? -1 : 1;
  let pt;
  if (m?.at) pt = m.at(d, 1);
  else {
    const q = fixedShots?.[view];
    if (!q) return null;
    const ref = +host.ref || CAR_DIMS[host.kind]?.ref || 1.45, s = (+host.height_m || ref) / ref;
    pt = { position: q.position.map((v) => v * s), target: q.target.map((v) => v * s) };
  }
  const off = Array.isArray(opts.offset) ? opts.offset.map((v) => +v || 0) : [0, 0, 0];
  // The offset is in the mount's own frame: x toward its side (out from the car on a side mount), y up, z forward.
  let pos = [pt.position[0] + off[0], pt.position[1] + off[1], pt.position[2] + off[2]];
  let tgt = [pt.target[0] + off[0], pt.target[1] + off[1], pt.target[2] + off[2]];
  const yaw = (+opts.yaw_deg || 0) * DEG;
  if (yaw) {   // turn the aim round the lens (positive = to the car's left)
    const dx = tgt[0] - pos[0], dz = tgt[2] - pos[2];
    tgt = [pos[0] + dx * Math.cos(yaw) + dz * Math.sin(yaw), tgt[1], pos[2] - dx * Math.sin(yaw) + dz * Math.cos(yaw)];
  }
  const pitch = (+opts.tilt_deg || 0) * DEG;
  if (pitch) {   // tilt the aim up (positive) or down round the lens
    const dx = tgt[0] - pos[0], dy = tgt[1] - pos[1], dz = tgt[2] - pos[2], flat = Math.hypot(dx, dz) || 1e-6;
    const a = Math.atan2(dy, flat) + pitch, n = Math.hypot(flat, dy);
    tgt = [pos[0] + dx / flat * Math.cos(a) * n, pos[1] + Math.sin(a) * n, pos[2] + dz / flat * Math.cos(a) * n];
  }
  if (side === -1) { pos = [-pos[0], pos[1], pos[2]]; tgt = [-tgt[0], tgt[1], tgt[2]]; }
  const focal = Number.isFinite(+opts.focal_mm) && +opts.focal_mm > 0 ? +opts.focal_mm : (m?.focal_mm || fixedShots?.[view]?.focal_mm || 24);
  return { frame: 0, position: pos.map(r3), target: tgt.map(r3), focal_mm: r3(focal) };
}

/**
 * A point in the car's own space as it sits on the sprung body: rolled and pitched about the body's pivot (at
 * pivotY, about axle height), the same Euler order the stage turns the body with (x = -pitch, then z = roll).
 */
export function onSprungBody(v, pivotY, rollDeg = 0, pitchDeg = 0) {
  if (!rollDeg && !pitchDeg) return v;
  const r = rollDeg * DEG, p = -pitchDeg * DEG;
  let x = v[0], y = v[1] - pivotY, z = v[2];
  // Rz(roll) first, then Rx(-pitch): matrix Rx * Rz on the vector (THREE's "XYZ" with y = 0).
  const x1 = x * Math.cos(r) - y * Math.sin(r), y1 = x * Math.sin(r) + y * Math.cos(r);
  x = x1; y = y1;
  const y2 = y * Math.cos(p) - z * Math.sin(p), z2 = y * Math.sin(p) + z * Math.cos(p);
  return [x, y2 + pivotY, z2];
}

/** The inverse of onSprungBody: a point on the rolled / pitched body back in the car's level space. */
export function offSprungBody(v, pivotY, rollDeg = 0, pitchDeg = 0) {
  if (!rollDeg && !pitchDeg) return v;
  const r = -rollDeg * DEG, p = pitchDeg * DEG;
  let x = v[0], y = v[1] - pivotY, z = v[2];
  const y1 = y * Math.cos(p) - z * Math.sin(p), z1 = y * Math.sin(p) + z * Math.cos(p);
  y = y1; z = z1;
  const x2 = x * Math.cos(r) - y * Math.sin(r), y2 = x * Math.sin(r) + y * Math.cos(r);
  return [x2, y2 + pivotY, z];
}

/**
 * How far a camera bolted to the body rolls its horizon (radians, the stage camera's roll: + = counter-clockwise on
 * screen): the body's up axis (bodyUp, world) seen round the camera's view from position to target.
 */
export function mountRoll(position, target, bodyUp) {
  let d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const n = Math.hypot(...d) || 1;
  d = d.map((v) => v / n);
  // right = d x Y, up = right x d (the camera's level horizon)
  let rt = [-d[2], 0, d[0]];
  const rn = Math.hypot(rt[0], rt[2]);
  if (rn < 1e-6) return 0;   // looking straight down: roll is a yaw, the keys own it
  rt = rt.map((v) => v / rn);
  const up = [rt[1] * d[2] - rt[2] * d[1], rt[2] * d[0] - rt[0] * d[2], rt[0] * d[1] - rt[1] * d[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.atan2(-dot(bodyUp, rt), dot(bodyUp, up));
}

/** The circular mean of the last `n` headings (radians) up to frame f: a chase car swinging round late. */
export function laggedHeading(headingAt, f, n) {
  if (!(n > 0)) return headingAt(f);
  let sx = 0, sy = 0, w = 0;
  for (let i = 0; i <= n; i++) {
    const h = headingAt(Math.max(0, f - i)), k = n + 1 - i;   // nearer frames weigh more
    sx += Math.sin(h) * k; sy += Math.cos(h) * k; w += k;
  }
  return Math.atan2(sx / w, sy / w);
}
