// Soundstage direct manipulation math (Milestone 9): the pure, testable parts of dragging, snapping and camera moves.
// No three.js: plain arrays ([x, y, z], quaternions [x, y, z, w]) so the tests run in node.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Frame-rate independent exponential smoothing toward a target (lambda = 1 / time constant, per second). */
export function damp(cur, target, lambda, dt) {
  const k = 1 - Math.exp(-lambda * Math.max(0, dt));
  return Array.isArray(cur) ? cur.map((v, i) => v + (target[i] - v) * k) : cur + (target - cur) * k;
}

/**
 * Shift-drag: keep only the world axis (x or z) the drag has moved along most since it started. `axis` = a lock
 * already chosen ("x" | "z"), or null to choose now. Returns {pos, axis}.
 */
export function axisLock(start, target, axis = null) {
  const dx = target[0] - start[0], dz = target[2] - start[2];
  const ax = axis || (Math.abs(dx) >= Math.abs(dz) ? "x" : "z");
  return { axis: ax, pos: ax === "x" ? [target[0], target[1], start[2]] : [start[0], target[1], target[2]] };
}

export const snapGrid = (v, step) => (step > 0 ? Math.round(v / step) * step : v);

/**
 * Snap a moving footprint to nearby objects' edges (and centres). fp = {min: [x, z], max: [x, z]} of the moving object
 * where the cursor would put it; others = [{id, min: [x, z], max: [x, z]}]. Only objects within `reach` metres
 * count. Returns {dx, dz, guides: [{axis: "x"|"z", at, span: [a, b], id}]} — the nudge to apply and the lines to draw
 * (a guide on axis "x" is the line x = at, running from span[0] to span[1] along z).
 */
export function edgeSnap(fp, others, tol = 0.08, reach = 3) {
  const out = { dx: 0, dz: 0, guides: [] };
  for (const [k, name] of [[0, "x"], [1, "z"]]) {
    const o = 1 - k;   // the other axis
    let best = null;
    const mine = [fp.min[k], fp.max[k], (fp.min[k] + fp.max[k]) / 2];
    for (const b of others) {
      // Near enough: within reach on the other axis (gap between footprints) and along this one.
      const gapO = Math.max(b.min[o] - fp.max[o], fp.min[o] - b.max[o], 0);
      const gapK = Math.max(b.min[k] - fp.max[k], fp.min[k] - b.max[k], 0);
      if (gapO > reach || gapK > reach) continue;
      const theirs = [b.min[k], b.max[k], (b.min[k] + b.max[k]) / 2];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        if ((i === 2) !== (j === 2)) continue;   // centre to centre, edge to edge
        const d = theirs[j] - mine[i];
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d) - 1e-9)) best = { d, at: theirs[j], b };
      }
    }
    if (!best) continue;
    if (k === 0) out.dx = best.d; else out.dz = best.d;
    const lo = Math.min(fp.min[o], best.b.min[o]), hi = Math.max(fp.max[o], best.b.max[o]);
    out.guides.push({ axis: name, at: best.at, span: [lo - 0.15, hi + 0.15], id: best.b.id });
  }
  return out;
}

/**
 * Where a dragged object should stand. grab = the pressed point relative to the object's origin [gx, gy, gz] (world
 * axes), so that point stays exactly under the cursor. hit = what the cursor ray meets besides the dragged object
 * ({point, normal, id}, "__ground" = the floor) or null; planeHit(y) = the cursor ray meeting the plane at height y
 * ([x, y, z] or null); support(x, z) = the height of a fixed surface under that spot (a table top, a ledge) or 0, or
 * {y, id} to name it (then returned as the support).
 * An up-facing top of something under the cursor (a crate, a table, up to `maxClimb` m) is stood on; anywhere else it
 * slides on the floor (or on the fixed surface it is over), and walls and cars are left to the physics to stop it.
 * Returns {pos: origin [x, y, z], support: id | null, surface: bool} or null (the cursor is above the horizon).
 */
export function dragTarget(hit, grab, planeHit, maxClimb = 1.8, support = () => 0) {
  const [gx, gy, gz] = grab;
  if (hit && hit.id !== "__ground" && hit.normal[1] > 0.7 && hit.point[1] <= maxClimb) {
    return { pos: [hit.point[0] - gx, hit.point[1], hit.point[2] - gz], support: hit.id, surface: true };
  }
  let base = 0;
  let p = planeHit(base + gy);
  if (!p) return null;
  const s0 = support(p[0] - gx, p[2] - gz);
  const s = typeof s0 === "number" ? { y: s0, id: null } : s0 || { y: 0, id: null };
  if (s.y > 0.01) { base = s.y; p = planeHit(base + gy) || p; }
  return { pos: [p[0] - gx, base, p[2] - gz], support: base > 0 ? s.id ?? null : null, surface: base > 0 };
}

/**
 * A step up onto (or down off) something, as an eased arc from p0 to p1 at progress u (0..1): going up it rises first
 * and then moves across (a climb, a box set up onto a table: no sliding up the edge); going down it moves across first
 * and then drops, gathering speed like a hop down. Returns [x, y, z]; u = 1 is exactly p1.
 */
export function stepArc(p0, p1, u) {
  u = clamp(u, 0, 1);
  const s = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const up = p1[1] >= p0[1];
  const fy = up ? s(u / 0.55) : clamp((u - 0.3) / 0.7, 0, 1) ** 2;
  const fh = up ? s((u - 0.4) / 0.6) : s(u / 0.6);
  return [p0[0] + (p1[0] - p0[0]) * fh, p0[1] + (p1[1] - p0[1]) * fy, p0[2] + (p1[2] - p0[2]) * fh];
}

/** How long a step / climb takes (s) for a height change dh (m): a person climbs a crate in ~0.7 s; a prop is quicker. */
export const stepDuration = (dh, person = false) => (person ? clamp(0.3 + 0.5 * Math.abs(dh), 0.3, 1.0) : clamp(0.16 + 0.3 * Math.abs(dh), 0.16, 0.5));

/** Mass of a prop scaled with its size: `mass` is for the library size; a half-size crate weighs an eighth. */
export const massForSize = (mass, k) => clamp(mass * Math.pow(clamp(k, 0.05, 20), 3), 0.3, 50000);

/**
 * Two-bone leg IK in the leg's own plane: the foot target relative to the hip (dy up, dz forward, metres) and the thigh
 * and shin lengths. Returns {hip, knee} in radians: hip = forward flexion of the thigh from hanging straight down,
 * knee = flexion (the shin folds back). Out of reach, the leg points straight at the target.
 */
export function legIK(dy, dz, L1, L2) {
  const d = clamp(Math.hypot(dy, dz), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-4);
  const knee = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  const phi = Math.atan2(dz, -dy);
  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  return { hip: phi + alpha, knee };
}

/** A person meeting something under their feet: walk on (a kerb, a step), climb (a crate, a table), or not at all. */
export function stepKind(rise, { step = 0.45, climb = 1.7 } = {}) {
  if (rise <= 0.02) return "walk";
  if (rise <= step) return "step";
  if (rise <= climb) return "climb";
  return "blocked";
}

/** Quaternion helpers. */
export const qyaw = (rad) => [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
export function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export const qnorm = (q) => { const n = Math.hypot(...q) || 1; return q.map((v) => v / n); };

/**
 * Split an orientation into its heading (yaw about +Y, whole degrees, for the Turn slider) and the tilt left over
 * (a tipped-over chair), so that q = yaw(deg) * tilt. Upright objects get tilt = null.
 */
export function yawTilt(q) {
  q = qnorm(q);
  const deg = Math.round((2 * Math.atan2(q[1], q[3])) * 180 / Math.PI);
  const yawDeg = ((deg + 540) % 360) - 180;
  const r = yawDeg * Math.PI / 180;
  let tilt = qnorm(qmul([0, -Math.sin(r / 2), 0, Math.cos(r / 2)], q));
  if (tilt[3] < 0) tilt = tilt.map((v) => -v);
  const upright = Math.abs(tilt[0]) < 0.004 && Math.abs(tilt[2]) < 0.004;   // under ~0.5° of lean
  return { yawDeg, tilt: upright ? null : tilt.map((v) => +v.toFixed(5)) };
}

/**
 * Zoom toward the cursor: scale the camera's position and target about the point under the cursor P by s (< 1 = in).
 * The view direction is kept and P stays under the cursor.
 */
export function zoomAt(pos, tgt, P, s) {
  return { pos: pos.map((v, i) => P[i] + (v - P[i]) * s), tgt: tgt.map((v, i) => P[i] + (v - P[i]) * s) };
}

/**
 * Frame a bounding sphere (centre c, radius r) from the current view direction: returns the camera position and
 * target that fit it with a little margin. vfov in radians; aspect = width / height.
 */
export function frameSphere(pos, tgt, c, r, vfov, aspect, margin = 1.25) {
  const dir = tgt.map((v, i) => v - pos[i]);
  const L = Math.hypot(...dir) || 1;
  const d = dir.map((v) => v / L);
  const half = Math.min(vfov / 2, Math.atan(Math.tan(vfov / 2) * aspect));
  const dist = Math.max(0.6, (Math.max(0.15, r) * margin) / Math.sin(half));
  return { pos: c.map((v, i) => v - d[i] * dist), tgt: [...c] };
}

/** Ease for camera fly-tos (cubic in-out). */
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Inertia: a velocity that decays with time constant tau (s); returns the new velocity after dt. */
export function decay(vel, dt, tau = 0.12) {
  const k = Math.exp(-Math.max(0, dt) / tau);
  return Array.isArray(vel) ? vel.map((v) => v * k) : vel * k;
}

/** Keep a height in range while raising / lowering a held object with the wheel. */
export const liftBy = (lift, deltaY, perNotch = 0.05) => clamp(lift - Math.sign(deltaY) * Math.min(4, Math.abs(deltaY) / 100) * perNotch, 0, 6);
