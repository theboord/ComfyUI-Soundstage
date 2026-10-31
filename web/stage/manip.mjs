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
 * Where a dragged object should stand, from what the cursor ray hit. hit = {point, normal, id} from the world raycast
 * (or null); grab = the horizontal offset from the grabbed point to the object's origin; base = the support height
 * it stood on last frame; planeHit(y) = the cursor ray meeting the horizontal plane at height y ([x, y, z] or null).
 * Up-facing surfaces (a table top, a crate, the floor) are stood on, up to `maxClimb` m above the floor; a wall or a
 * car's side is not a surface: the object stays at its height and the physics stops it there.
 * Returns {pos: origin [x, y, z], support: id | null, surface: bool} or null (nothing under the cursor).
 */
export function dragTarget(hit, grab, base, planeHit, maxClimb = 3) {
  if (hit && hit.normal[1] > 0.7 && hit.point[1] <= maxClimb) {
    return { pos: [hit.point[0] + grab[0], hit.point[1], hit.point[2] + grab[2]], support: hit.id === "__ground" ? null : hit.id, surface: true };
  }
  const p = planeHit(base);
  if (!p) return null;
  return { pos: [p[0] + grab[0], base, p[2] + grab[2]], support: null, surface: false };
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
