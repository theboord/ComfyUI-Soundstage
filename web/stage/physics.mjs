// Soundstage physics: a small rigid-body solver for props and set dressing, baked into ordinary keyframes.
//
// The method is substepped XPBD for rigid bodies (Müller et al. 2020, "Detailed Rigid Body Simulation with Extended
// Position Based Dynamics"), the position-based sibling of the augmented vertex block descent in three-avbd: contacts
// are solved as position constraints many times a frame, then velocities are derived from the positions, so stacks
// stay put and a fast car can't tunnel through a crate. Contacts come from probe points (corners, edge midpoints and
// face centres of each box) tested against the floor and against every other body's box.
//
// Pure functions, no three.js and no randomness: the same scene always bakes the same keys. The stage feeds it
// poses (from its keyed motion) and writes the result back as keys, so the clay render, the previz video and the LTX
// layout guide never run a simulation themselves.

/** What a new object starts with. mode: "dynamic" (falls, tumbles, gets knocked), "static" (collides on its keyed
 *  motion: set dressing, and people and vehicles pushing props; the default), "off" (ignored). mass kg; bounce 0..1 (restitution); friction 0..1.5; lift m (drop height at the start). */
export const PHYSICS_DEFAULTS = Object.freeze({ mode: "static", mass: 20, bounce: 0.2, friction: 0.6, lift: 0 });
export const PHYSICS_MODES = ["dynamic", "static", "off"];
export const GRAVITY = 9.81;

/** Default mass by kind (kg), so a dropped chair and a dropped crate don't feel the same. */
const KIND_MASS = { crate: 25, cube: 30, box: 25, sphere: 6, rock: 60, chair: 7, stool: 5, table: 25, bench: 35, cone: 3,
  cylinder: 20, pyramid: 15, flashlight: 0.4, tv: 18, houseplant: 8, coffee_table: 15, armchair: 30, desk: 40 };

/** An object's physics settings with defaults filled in (mode "static" when it has none). */
export function physicsOf(a) {
  const p = a?.physics || {};
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.max(lo, Math.min(hi, +v)) : d);
  return {
    mode: PHYSICS_MODES.includes(p.mode) ? p.mode : PHYSICS_DEFAULTS.mode,
    mass: num(p.mass, KIND_MASS[a?.kind] ?? PHYSICS_DEFAULTS.mass, 0.1, 50000),
    bounce: num(p.bounce, PHYSICS_DEFAULTS.bounce, 0, 1),
    friction: num(p.friction, PHYSICS_DEFAULTS.friction, 0, 1.5),
    lift: num(p.lift, PHYSICS_DEFAULTS.lift, 0, 50),
  };
}

// ---------- small vector / quaternion kit (arrays; quaternions are [x, y, z, w]) ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qnorm = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
/** Rotate v by unit quaternion q. */
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
/** Spherical interpolation, shortest way round. */
export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? (d = -d, b.map((x) => -x)) : b;
  if (d > 0.9995) return qnorm(a.map((x, i) => x + (bb[i] - x) * t));
  const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => x * wa + bb[i] * wb);
}
/** Quaternion for a turn about +Y (the stage's heading). */
export const qyaw = (rad) => [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];

// ---------- bodies ----------
/**
 * Make a simulation body.
 * spec: { id, shape: "box" | "sphere", half: [hx, hy, hz] (box half extents in the object's own, scaled frame),
 *   center: [cx, cy, cz] (box centre relative to the object's origin, same frame), radius (sphere),
 *   dynamic: bool, mass, bounce, friction,
 *   poses: [{ pos, quat }] per frame (origin pose) — the keyed motion; a dynamic body follows it until `release`,
 *   release: frame it is let go (dynamic only) }
 */
function makeBody(spec, index) {
  const shape = spec.shape === "sphere" ? "sphere" : "box";
  const half = (spec.half || [0.5, 0.5, 0.5]).map((v) => Math.max(0.01, +v || 0.01));
  const r = shape === "sphere" ? Math.max(0.01, spec.radius || Math.min(...half)) : 0;
  const m = Math.max(0.05, +spec.mass || 1);
  const ex = half.map((h) => 2 * h);
  const Ilocal = shape === "sphere" ? [0.4 * m * r * r, 0.4 * m * r * r, 0.4 * m * r * r]
    : [m / 12 * (ex[1] ** 2 + ex[2] ** 2), m / 12 * (ex[0] ** 2 + ex[2] ** 2), m / 12 * (ex[0] ** 2 + ex[1] ** 2)];
  const probes = [];
  if (shape === "box") {
    // A 3x3x3 lattice on the box surface (8 corners, 12 edge midpoints, 6 face centres): enough that an edge
    // landing across another box's edge is still caught.
    for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) for (const k of [-1, 0, 1]) {
      if (!i && !j && !k) continue;
      probes.push([i * half[0], j * half[1], k * half[2]]);
    }
  }
  const b = {
    id: spec.id, index, shape, half, r, center: spec.center || [0, 0, 0], dynamic: !!spec.dynamic,
    m, invM: 1 / m, invI: Ilocal.map((v) => 1 / v), bounce: +spec.bounce || 0, friction: spec.friction ?? 0.6,
    poses: spec.poses || [], release: Math.max(0, Math.round(spec.release || 0)), probes,
    bound: shape === "sphere" ? r : len(half),
    x: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], xp: [0, 0, 0], qp: [0, 0, 0, 1], vp: [0, 0, 0], wp: [0, 0, 0],
    free: false, asleep: false, still: 0,
  };
  return b;
}

/** Origin pose of a keyed body at a fractional frame (lerp / slerp between its per-frame poses). */
function poseAt(b, t) {
  const P = b.poses;
  if (!P.length) return { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  const n = P.length - 1;
  if (t <= 0) return P[0];
  if (t >= n) return P[n];
  const i = Math.floor(t), u = t - i;
  if (u < 1e-9) return P[i];
  const a = P[i], c = P[i + 1];
  return { pos: a.pos.map((v, k) => v + (c.pos[k] - v) * u), quat: qslerp(a.quat, c.quat, u) };
}
const comOf = (b, pose) => add(pose.pos, qrot(pose.quat, b.center));
const originOf = (b) => sub(b.x, qrot(b.q, b.center));

/** World inverse inertia times a vector. */
function invIw(b, v) {
  const l = qrot(qconj(b.q), v);
  return qrot(b.q, [l[0] * b.invI[0], l[1] * b.invI[1], l[2] * b.invI[2]]);
}
const movable = (b) => b.free && !b.asleep;
/** Generalised inverse mass of a body at arm r along direction n. */
function wOf(b, r, n) {
  if (!movable(b)) return 0;
  const rn = cross(r, n);
  return b.invM + dot(rn, invIw(b, rn));
}
function applyPos(b, p, r) {
  if (!movable(b)) return;
  b.x = add(b.x, scl(p, b.invM));
  const d = invIw(b, cross(r, p));
  const dq = qmul([d[0], d[1], d[2], 0], b.q);
  b.q = qnorm([b.q[0] + 0.5 * dq[0], b.q[1] + 0.5 * dq[1], b.q[2] + 0.5 * dq[2], b.q[3] + 0.5 * dq[3]]);
}
function applyVel(b, p, r) {
  if (!movable(b)) return;
  b.v = add(b.v, scl(p, b.invM));
  b.w = add(b.w, invIw(b, cross(r, p)));
}
const toLocal = (b, p) => qrot(qconj(b.q), sub(p, b.x));

// ---------- contacts ----------
// Every contact pushes body A along +n and body B along -n. Types: "pg" A's probe vs the floor; "pb" A's probe vs
// B's box face (axis k, side s); "sg" sphere A vs floor; "sb" sphere A vs box B; "ss" sphere vs sphere.
function measure(c) {
  const A = c.a, B = c.b;
  switch (c.type) {
    case "pg": {
      const p = add(A.x, qrot(A.q, c.lp));
      c.d = -p[1]; c.n = [0, 1, 0]; c.pA = p; c.pB = [p[0], 0, p[2]];
      break;
    }
    case "pb": {
      const p = add(A.x, qrot(A.q, c.lp));
      const l = toLocal(B, p);
      c.d = B.half[c.k] - c.s * l[c.k];
      const nl = [0, 0, 0]; nl[c.k] = c.s;
      c.n = qrot(B.q, nl); c.pA = p; c.pB = add(p, scl(c.n, c.d));
      break;
    }
    case "sg": {
      c.d = A.r - A.x[1]; c.n = [0, 1, 0]; c.pA = [A.x[0], A.x[1] - A.r, A.x[2]]; c.pB = [A.x[0], 0, A.x[2]];
      break;
    }
    case "sb": {
      const l = toLocal(B, A.x);
      const cl = l.map((v, i) => Math.max(-B.half[i], Math.min(B.half[i], v)));
      const diff = sub(l, cl), dist = len(diff);
      let nl, d;
      if (dist > 1e-9) { nl = scl(diff, 1 / dist); d = A.r - dist; }
      else {   // centre inside the box: out through the nearest face
        let k = 0, best = Infinity;
        for (let i = 0; i < 3; i++) { const g = B.half[i] - Math.abs(l[i]); if (g < best) { best = g; k = i; } }
        nl = [0, 0, 0]; nl[k] = l[k] >= 0 ? 1 : -1; d = A.r + best;
      }
      c.n = qrot(B.q, nl); c.d = d; c.pA = sub(A.x, scl(c.n, A.r)); c.pB = add(B.x, qrot(B.q, cl));
      break;
    }
    case "ee": {   // an edge of A crossing an edge of B (the case corner probes miss)
      const dA = qrot(A.q, E[c.ia]), dB = qrot(B.q, E[c.ib]);
      const cA = add(A.x, qrot(A.q, c.loA)), cB = add(B.x, qrot(B.q, c.loB));
      let n = cross(dA, dB);
      const nl = len(n);
      if (nl < 1e-6) { c.d = -1; break; }
      n = scl(n, 1 / nl);
      if (dot(n, sub(A.x, B.x)) < 0) n = scl(n, -1);
      const [pA, pB] = segClosest(cA, dA, A.half[c.ia], cB, dB, B.half[c.ib]);
      c.n = n; c.pA = pA; c.pB = pB; c.d = dot(sub(pB, pA), n);
      break;
    }
    case "ss": {
      const diff = sub(A.x, B.x), dist = len(diff) || 1e-9;
      c.n = dist > 1e-9 ? scl(diff, 1 / dist) : [0, 1, 0]; c.d = A.r + B.r - dist;
      c.pA = sub(A.x, scl(c.n, A.r)); c.pB = add(B.x, scl(c.n, B.r));
      break;
    }
    default: c.d = -1;
  }
  return c;
}

/** Probes of A inside B's box → "pb" contacts (the shallowest face is the way out). */
function probeContacts(A, B, out) {
  for (const lp of A.probes) {
    const p = add(A.x, qrot(A.q, lp));
    const l = toLocal(B, p);
    if (Math.abs(l[0]) >= B.half[0] || Math.abs(l[1]) >= B.half[1] || Math.abs(l[2]) >= B.half[2]) continue;
    let k = 0, best = Infinity;
    for (let i = 0; i < 3; i++) { const g = B.half[i] - Math.abs(l[i]); if (g < best) { best = g; k = i; } }
    out.push({ type: "pb", a: A, b: B, lp, k, s: l[k] >= 0 ? 1 : -1 });
  }
}

const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Closest points between two segments given by centre, unit direction and half length. */
function segClosest(c1, d1, h1, c2, d2, h2) {
  const r = sub(c1, c2), b = dot(d1, d2), cc = dot(d1, r), f = dot(d2, r), den = 1 - b * b;
  let s = den > 1e-9 ? (b * f - cc) / den : 0;
  s = Math.max(-h1, Math.min(h1, s));
  let t = Math.max(-h2, Math.min(h2, b * s + f));
  s = Math.max(-h1, Math.min(h1, b * t - cc));
  return [add(c1, scl(d1, s)), add(c2, scl(d2, t))];
}

/**
 * Separating-axis test for two boxes. When they overlap least along an edge-edge axis (two edges crossing, which the
 * probe points can't see), add an "ee" contact between those two edges.
 */
function edgeContact(A, B, out) {
  const aX = E.map((e) => qrot(A.q, e)), bX = E.map((e) => qrot(B.q, e));
  const T = sub(B.x, A.x);
  const over = (L) => {
    const ra = A.half[0] * Math.abs(dot(aX[0], L)) + A.half[1] * Math.abs(dot(aX[1], L)) + A.half[2] * Math.abs(dot(aX[2], L));
    const rb = B.half[0] * Math.abs(dot(bX[0], L)) + B.half[1] * Math.abs(dot(bX[1], L)) + B.half[2] * Math.abs(dot(bX[2], L));
    return ra + rb - Math.abs(dot(T, L));
  };
  let faceMin = Infinity;
  for (const L of [...aX, ...bX]) { const o = over(L); if (o <= 0) return; faceMin = Math.min(faceMin, o); }
  let best = null;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let L = cross(aX[i], bX[j]);
    const l = len(L);
    if (l < 1e-3) continue;
    L = scl(L, 1 / l);
    const o = over(L);
    if (o <= 0) return;
    if (!best || o < best.o) best = { o, i, j, L };
  }
  if (!best || best.o > faceMin * 0.95) return;   // a face is the shallower way out: the probes have it
  const n = dot(best.L, sub(A.x, B.x)) < 0 ? scl(best.L, -1) : best.L;   // from B towards A
  const loA = [0, 0, 0], loB = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (k !== best.i) loA[k] = (dot(aX[k], n) > 0 ? -1 : 1) * A.half[k];   // A's edge nearest B
    if (k !== best.j) loB[k] = (dot(bX[k], n) > 0 ? 1 : -1) * B.half[k];   // B's edge nearest A
  }
  const c = measure({ type: "ee", a: A, b: B, ia: best.i, ib: best.j, loA, loB });
  if (c.d > 0) out.push(c);
}

function pairContacts(A, B, out) {
  if (A.shape === "box" && B.shape === "box") { probeContacts(A, B, out); probeContacts(B, A, out); edgeContact(A, B, out); return; }
  if (A.shape === "sphere" && B.shape === "sphere") { const c = measure({ type: "ss", a: A, b: B }); if (c.d > 0) out.push(c); return; }
  const [S, X] = A.shape === "sphere" ? [A, B] : [B, A];
  const c = measure({ type: "sb", a: S, b: X });
  if (c.d > 0) out.push(c);
}

/** Relative velocity of A's contact point against B's along n (+ = separating). */
function relVel(c, useSaved) {
  const A = c.a, B = c.b;
  const rA = c.rA || sub(c.pA, A.x), rB = c.rB || sub(c.pB, B.x);
  const vA = useSaved ? add(A.vp, cross(A.wp, rA)) : add(A.v, cross(A.w, rA));
  const vB = useSaved ? add(B.vp, cross(B.wp, rB)) : add(B.v, cross(B.w, rB));
  return sub(vA, vB);
}

// ---------- the simulation ----------
/**
 * Run the simulation over frames 0..frames-1 and return { tracks: {id: [{pos, quat}] per frame}, settled: {id: frame
 * or null}, stats }. bodies: specs (see makeBody); all poses arrays must have `frames` entries.
 * opts: { fps = 24, substeps = 20, gravity = 9.81, floor = true }
 */
export function simulate(specs, frames, opts = {}) {
  const fps = opts.fps || 24, nSub = Math.max(4, Math.min(64, opts.substeps || 20));
  const h = 1 / (fps * nSub), g = opts.gravity ?? GRAVITY, floor = opts.floor !== false, iters = Math.max(1, Math.min(8, opts.iterations || 2));
  const bodies = specs.map((s, i) => makeBody(s, i));
  const dyn = bodies.filter((b) => b.dynamic);
  const tracks = {}, settled = {};
  let contactsSolved = 0;
  // Frame 0: every body where its keys put it.
  for (const b of bodies) {
    const p = poseAt(b, 0);
    b.x = comOf(b, p); b.q = [...p.quat]; b.xp = [...b.x]; b.qp = [...b.q];
  }
  for (const b of dyn) { tracks[b.id] = [{ pos: originOf(b), quat: [...b.q] }]; settled[b.id] = null; }
  const LIN_SLEEP = 0.06, ANG_SLEEP = 0.12, SLEEP_FRAMES = 8, WAKE_SPEED = 0.25;

  for (let f = 0; f < frames - 1; f++) {
    // A dynamic body is let go at its release frame, with the speed its last keys gave it.
    for (const b of dyn) {
      if (b.free || f < b.release) continue;
      b.free = true;
      const p0 = poseAt(b, Math.max(0, f - 1)), p1 = poseAt(b, f);
      b.x = comOf(b, p1); b.q = [...p1.quat];
      b.v = f > 0 ? scl(sub(comOf(b, p1), comOf(b, p0)), fps) : [0, 0, 0];
      b.w = [0, 0, 0];
    }
    for (let s = 0; s < nSub; s++) {
      const t0 = f + s / nSub, t1 = f + (s + 1) / nSub;
      // Predict.
      for (const b of bodies) {
        b.vp = [...b.v]; b.wp = [...b.w];
        if (!b.free) {   // keyed: where its keys put it now (cars, people, set pieces, a prop before it is let go)
          const a = poseAt(b, t0), c = poseAt(b, t1);
          b.xp = comOf(b, a); b.qp = [...a.quat]; b.x = comOf(b, c); b.q = [...c.quat];
          b.v = scl(sub(b.x, b.xp), 1 / h);
          const dq = qmul(b.q, qconj(b.qp));
          b.w = scl([dq[0], dq[1], dq[2]], (dq[3] >= 0 ? 2 : -2) / h);
          b.vp = [...b.v]; b.wp = [...b.w];
          continue;
        }
        b.xp = [...b.x]; b.qp = [...b.q];
        if (b.asleep) { b.v = [0, 0, 0]; b.w = [0, 0, 0]; continue; }
        b.v[1] -= g * h;
        b.x = add(b.x, scl(b.v, h));
        const dq = qmul([b.w[0], b.w[1], b.w[2], 0], b.q);
        b.q = qnorm([b.q[0] + 0.5 * h * dq[0], b.q[1] + 0.5 * h * dq[1], b.q[2] + 0.5 * h * dq[2], b.q[3] + 0.5 * h * dq[3]]);
      }
      // Contacts.
      const C = [];
      if (floor) for (const b of dyn) {
        if (!b.free || b.asleep) continue;
        if (b.x[1] - b.bound > 0) continue;
        if (b.shape === "sphere") { const c = measure({ type: "sg", a: b, b: GROUND }); if (c.d > 0) C.push(c); continue; }
        for (const lp of b.probes) {
          const y = b.x[1] + qrot(b.q, lp)[1];
          if (y < 0) C.push({ type: "pg", a: b, b: GROUND, lp });
        }
      }
      for (let i = 0; i < bodies.length; i++) {
        const A = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const B = bodies[j];
          if (!A.free && !B.free) continue;   // two keyed things never push each other
          const dx = A.x[0] - B.x[0], dy = A.x[1] - B.x[1], dz = A.x[2] - B.x[2], R = A.bound + B.bound + 0.05;
          if (dx * dx + dy * dy + dz * dz > R * R) continue;
          // Anything moving near a sleeper wakes it (a car arriving, the crate under it knocked away).
          for (const [S, O] of [[A, B], [B, A]]) {
            if (S.asleep && !O.asleep && len(O.v) > WAKE_SPEED) { S.asleep = false; S.still = 0; }
          }
          if ((!A.free || A.asleep) && (!B.free || B.asleep)) continue;   // nothing here moves under physics
          pairContacts(A, B, C);
        }
      }
      // Restitution needs the approach speed from before this substep.
      for (const c of C) { measure(c); c.vnPrev = dot(c.n, relVel(c, true)); c.lam = 0; }
      // Position solve: a couple of passes per substep, so a car shoving one crate into the next can't squeeze them
      // through each other (the substeps do the rest of the converging).
      for (let it = 0; it < iters; it++) for (const c of C) {
        measure(c);
        if (c.d <= 0) continue;
        const A = c.a, B = c.b;
        let rA = sub(c.pA, A.x), rB = sub(c.pB, B.x);
        const wA = wOf(A, rA, c.n), wB = wOf(B, rB, c.n);
        if (wA + wB <= 0) continue;
        const dl = c.d / (wA + wB);
        c.lam += dl;
        if (it > 0) { applyPos(A, scl(c.n, dl), rA); applyPos(B, scl(c.n, -dl), rB); continue; }   // friction once
        applyPos(A, scl(c.n, dl), rA);
        applyPos(B, scl(c.n, -dl), rB);
        contactsSolved++;
        // Static friction: undo the sliding of the touching points this substep while the normal force allows.
        const mu = Math.sqrt(Math.max(0, A.friction) * Math.max(0, B.friction));
        if (mu <= 0) continue;
        const lA = qrot(qconj(A.q), sub(c.pA, A.x)), lB = qrot(qconj(B.q), sub(c.pB, B.x));
        const pAn = add(A.x, qrot(A.q, lA)), pAp = add(A.xp, qrot(A.qp, lA));
        const pBn = add(B.x, qrot(B.q, lB)), pBp = add(B.xp, qrot(B.qp, lB));
        const dp = sub(sub(pAn, pAp), sub(pBn, pBp));
        const dpt = sub(dp, scl(c.n, dot(dp, c.n))), m = len(dpt);
        if (m < 1e-9) continue;
        const t = scl(dpt, 1 / m);
        rA = sub(pAn, A.x); rB = sub(pBn, B.x);
        const wtA = wOf(A, rA, t), wtB = wOf(B, rB, t);
        if (wtA + wtB <= 0) continue;
        const lt = m / (wtA + wtB);
        if (lt < mu * c.lam) { applyPos(A, scl(t, -lt), rA); applyPos(B, scl(t, lt), rB); }
      }
      // Velocities from positions.
      for (const b of dyn) {
        if (!b.free) continue;
        if (b.asleep) { b.v = [0, 0, 0]; b.w = [0, 0, 0]; continue; }
        b.v = scl(sub(b.x, b.xp), 1 / h);
        const dq = qmul(b.q, qconj(b.qp));
        b.w = scl([dq[0], dq[1], dq[2]], (dq[3] >= 0 ? 2 : -2) / h);
      }
      // Velocity solve: sliding friction once, then the bounce iterated so a box landing flat on four corners comes
      // off evenly (one Gauss-Seidel pass over several contacts spins it up and adds energy).
      const act = C.filter((c) => c.lam > 0);
      for (const c of act) {
        const A = c.a, B = c.b;
        c.rA = sub(c.pA, A.x); c.rB = sub(c.pB, B.x);
        const mu = 0.85 * Math.sqrt(Math.max(0, A.friction) * Math.max(0, B.friction));
        const vr = relVel(c, false), vn = dot(c.n, vr), vt = sub(vr, scl(c.n, vn)), vtl = len(vt);
        if (vtl > 1e-6 && mu > 0) {
          const t = scl(vt, 1 / vtl);
          const wtA = wOf(A, c.rA, t), wtB = wOf(B, c.rB, t);
          if (wtA + wtB > 0) {
            const P = scl(t, -Math.min(h * mu * (c.lam / (h * h)), vtl) / (wtA + wtB));
            applyVel(A, P, c.rA); applyVel(B, scl(P, -1), c.rB);
          }
        }
        const e = Math.abs(c.vnPrev) > 2 * g * h * 4 ? Math.max(A.bounce, B.bounce) : 0;
        c.target = Math.max(-e * c.vnPrev, 0);
        c.wn = wOf(A, c.rA, c.n) + wOf(B, c.rB, c.n);
      }
      for (let it = 0; it < (act.length > 1 ? 6 : 1); it++) {
        for (const c of act) {
          if (!(c.wn > 0)) continue;
          const vn = dot(c.n, relVel(c, false));
          const dvn = c.target - vn;
          if (Math.abs(dvn) < 1e-7) continue;
          const P = scl(c.n, dvn / c.wn);
          applyVel(c.a, P, c.rA); applyVel(c.b, scl(P, -1), c.rB);
        }
      }
      // A touch of air and rolling drag, so a ball doesn't roll for ever.
      for (const b of dyn) if (movable(b)) { b.v = scl(b.v, 1 - 0.02 * h); b.w = scl(b.w, 1 - 0.6 * h); }
    }
    // Sleep: a body that has barely moved for a few frames stops (and stays exactly still in the keys).
    for (const b of dyn) {
      if (b.free && !b.asleep) {
        if (len(b.v) < LIN_SLEEP && len(b.w) < ANG_SLEEP && b.x[1] < 200) b.still++; else b.still = 0;
        if (b.still >= SLEEP_FRAMES) { b.asleep = true; b.v = [0, 0, 0]; b.w = [0, 0, 0]; if (settled[b.id] == null) settled[b.id] = f + 1; }
        else if (b.still === 0) settled[b.id] = null;
      }
      const pose = b.free ? { pos: originOf(b), quat: [...b.q] } : poseAt(b, f + 1);
      tracks[b.id].push({ pos: [...pose.pos], quat: [...pose.quat] });
    }
  }
  for (const b of dyn) if (b.asleep && settled[b.id] == null) settled[b.id] = frames - 1;
  return { tracks, settled, stats: { bodies: bodies.length, dynamic: dyn.length, substeps: nSub, contacts: contactsSolved } };
}

const GROUND = { id: "__ground", shape: "plane", half: [1e6, 0, 1e6], x: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0],
  vp: [0, 0, 0], wp: [0, 0, 0], xp: [0, 0, 0], qp: [0, 0, 0, 1], free: false, asleep: false, dynamic: false, friction: 0.8, bounce: 0,
  invM: 0, invI: [0, 0, 0] };

/**
 * Turn a simulated track into stage keys: one key per frame while it moves, the ends of every hold only (two equal
 * keys hold still on the stage), positions to the millimetre. Returns [{frame, position, quat}].
 */
export function bakeTrack(track, { posDigits = 3, quatDigits = 5 } = {}) {
  const r = (v, d) => +v.toFixed(d);
  const keys = track.map((p, frame) => ({ frame, position: p.pos.map((v) => r(v, posDigits)),
    quat: (() => { const q = qnorm(p.quat); const s = q[3] < 0 ? -1 : 1; return q.map((v) => r(v * s, quatDigits)); })() }));
  const same = (a, b) => a && b && a.position.every((v, i) => v === b.position[i]) && a.quat.every((v, i) => v === b.quat[i]);
  return keys.filter((k, i) => i === 0 || i === keys.length - 1 || !same(keys[i - 1], k) || !same(k, keys[i + 1]));
}

/** Stage-side quaternion of a baked object at a frame: slerp between the keys around it that carry one. */
export function sampleQuat(keys, frame) {
  const q = keys.filter((k) => Array.isArray(k.quat));
  if (!q.length) return null;
  if (frame <= q[0].frame) return q[0].quat;
  const n = q.length - 1;
  if (frame >= q[n].frame) return q[n].quat;
  let i = 0;
  while (q[i + 1].frame < frame) i++;
  const u = (frame - q[i].frame) / Math.max(1e-6, q[i + 1].frame - q[i].frame);
  return qslerp(q[i].quat, q[i + 1].quat, u);
}

/** Linear position between the keys around a frame (baked keys are dense; a spline would overshoot a bounce). */
export function samplePos(keys, frame) {
  if (!keys.length) return [0, 0, 0];
  if (frame <= keys[0].frame) return [...keys[0].position];
  const n = keys.length - 1;
  if (frame >= keys[n].frame) return [...keys[n].position];
  let i = 0;
  while (keys[i + 1].frame < frame) i++;
  const u = (frame - keys[i].frame) / Math.max(1e-6, keys[i + 1].frame - keys[i].frame);
  return keys[i].position.map((v, k) => v + (keys[i + 1].position[k] - v) * u);
}

/**
 * Quality checks on a result (used by the tests and the stage's status line): the deepest any probe sinks into the
 * floor, the fastest any body moves (explosions), and whether everything came to rest.
 */
export function checkTracks(specs, result, fps = 24) {
  let maxSink = 0, maxSpeed = 0;
  for (const s of specs) {
    if (!s.dynamic) continue;
    const tr = result.tracks[s.id];
    const b = makeBody(s, 0);
    for (let f = 0; f < tr.length; f++) {
      const p = tr[f];
      const com = add(p.pos, qrot(p.quat, b.center));
      if (b.shape === "sphere") maxSink = Math.max(maxSink, b.r - com[1]);
      else for (const lp of b.probes) maxSink = Math.max(maxSink, -(com[1] + qrot(p.quat, lp)[1]));
      if (f > 0) { const q = tr[f - 1]; maxSpeed = Math.max(maxSpeed, len(sub(p.pos, q.pos)) * fps); }
    }
  }
  return { maxSink, maxSpeed, allSettled: specs.filter((s) => s.dynamic).every((s) => result.settled[s.id] != null) };
}

// ---------- the live world (editing) ----------
/**
 * A stepping world for live interaction while editing (Milestone 9): the same XPBD contacts as simulate(), advanced in
 * real time. Bodies are dynamic (fall, tumble, get pushed), static (never move) or kinematic (follow a target pose and
 * push dynamic bodies, nothing pushes them back). setKinematicTarget() on a DYNAMIC body is a grab: it chases the
 * target with gravity off and its spin locked, static bodies and the floor still block it, and it shoves dynamic
 * bodies out of the way; null lets go. Poses are origin poses {pos, quat}; a box's `center` is relative to the origin.
 * This is an editing aid only: shots are still made by simulate() + bakeTrack() (deterministic keys).
 */
export function createXpbdWorld(opts = {}) {
  const g = opts.gravity ?? GRAVITY, floor = opts.floor !== false;
  const baseSub = Math.max(2, Math.min(32, opts.substeps || 8));
  const iters = Math.max(1, Math.min(8, opts.iterations || 2));
  const MAX_STEP = opts.maxStep || 0.03;   // m a grabbed body may move per substep (no tunnelling through a thin wall)
  const LIN_SLEEP = 0.06, ANG_SLEEP = 0.15, SLEEP_TIME = 0.35, WAKE_SPEED = 0.2, MAX_SPEED = opts.maxSpeed || 8;
  const bodies = new Map();
  let seq = 0;

  const setPose = (b, pos, quat) => {
    b.q = qnorm(quat || [0, 0, 0, 1]); b.x = add(pos || [0, 0, 0], qrot(b.q, b.center)); b.xp = [...b.x]; b.qp = [...b.q];
  };
  function applyType(b, type) {
    b.type = ["dynamic", "static", "kinematic"].includes(type) ? type : "dynamic";
    b.dynamic = b.type === "dynamic";
    b.free = b.dynamic;
    if (!b.dynamic) { b.v = [0, 0, 0]; b.w = [0, 0, 0]; }
  }
  function grabMass(b, on) {
    if (on && !b.grabbed) { b.grabbed = { invM: b.invM, invI: b.invI }; b.invM = 1 / Math.max(2000, b.m * 40); b.invI = [0, 0, 0]; }
    if (!on && b.grabbed) { b.invM = b.grabbed.invM; b.invI = b.grabbed.invI; b.grabbed = null; }
  }

  const api = {
    engine: "xpbd",
    /** desc: {id?, shape: "box"|"sphere", half, center, radius, type: "dynamic"|"static"|"kinematic", mass, friction,
     *  restitution (or bounce), pos, quat, asleep}. Returns the id. */
    addBody(desc = {}) {
      const id = desc.id ?? `b${++seq}`;
      const b = makeBody({ id, shape: desc.shape, half: desc.half, center: desc.center, radius: desc.radius, dynamic: true,
        mass: desc.mass ?? 20, bounce: desc.restitution ?? desc.bounce ?? 0.05, friction: desc.friction ?? 0.8 }, bodies.size);
      setPose(b, desc.pos, desc.quat);
      applyType(b, desc.type);
      b.target = null; b.still = 0; b.asleep = !!desc.asleep && b.dynamic;
      b.lin = desc.linearDamping ?? 0.05; b.ang = desc.angularDamping ?? 1.2;
      bodies.set(id, b);
      return id;
    },
    removeBody(id) { bodies.delete(id); },
    has(id) { return bodies.has(id); },
    /** Kinematic: move there over the next step. Dynamic: grab (chase it, blocked by static things); null = let go. */
    setKinematicTarget(id, pos, quat = null) {
      const b = bodies.get(id);
      if (!b) return;
      if (pos == null) {
        if (b.dynamic && b.target) { grabMass(b, false); b.v = scl(b.v, 0.25); b.w = [0, 0, 0]; b.still = 0; b.asleep = false; }
        b.target = null;
        return;
      }
      b.target = { pos: [...pos], quat: qnorm(quat || b.target?.quat || b.q) };
      if (b.dynamic) { grabMass(b, true); b.asleep = false; b.still = 0; }
    },
    setBodyProps(id, p = {}) {
      const b = bodies.get(id);
      if (!b) return;
      if (p.mass != null) { const m = Math.max(0.05, +p.mass); const k = m / b.m; b.m = m; b.invM = 1 / m; b.invI = b.invI.map((v) => v / k); }
      if (p.friction != null) b.friction = +p.friction;
      if (p.restitution != null || p.bounce != null) b.bounce = +(p.restitution ?? p.bounce);
      if (p.type) applyType(b, p.type);
      if (p.pos) { setPose(b, p.pos, p.quat || b.q); b.asleep = false; b.still = 0; }
    },
    getPose(id) {
      const b = bodies.get(id);
      return b ? { pos: originOf(b), quat: [...b.q] } : null;
    },
    getVelocity(id) { const b = bodies.get(id); return b ? { v: [...b.v], w: [...b.w] } : null; },
    isAsleep(id) { const b = bodies.get(id); return !b || !b.dynamic || b.asleep; },
    /** Dynamic bodies still moving (a grabbed body counts while it is held). */
    awakeCount() { let n = 0; for (const b of bodies.values()) if (b.dynamic && (!b.asleep || b.target)) n++; return n; },
    ids() { return [...bodies.keys()]; },
    /** Nearest hit of a ray on a body or the floor: {id ("__ground" for the floor), point, normal, distance} or null. */
    raycast(origin, dir, maxDist = 1e4, { exclude = null } = {}) {
      const d = scl(dir, 1 / (len(dir) || 1));
      let best = null;
      if (floor && d[1] < -1e-6) {
        const t = -origin[1] / d[1];
        if (t > 0 && t < maxDist) best = { id: "__ground", point: add(origin, scl(d, t)), normal: [0, 1, 0], distance: t };
      }
      for (const b of bodies.values()) {
        if (exclude && (exclude === b.id || exclude.has?.(b.id) || (Array.isArray(exclude) && exclude.includes(b.id)))) continue;
        const hit = rayBody(b, origin, d);
        if (hit && hit.distance < maxDist && (!best || hit.distance < best.distance)) best = { id: b.id, ...hit };
      }
      return best;
    },
    step(dt) {
      dt = Math.max(0, Math.min(1 / 20, +dt || 0));
      if (dt <= 0) return;
      const list = [...bodies.values()];
      // Enough substeps that a grabbed or kinematic body never moves more than MAX_STEP per substep.
      let need = baseSub;
      for (const b of list) if (b.target) need = Math.max(need, Math.ceil(len(sub(add(b.target.pos, qrot(b.target.quat, b.center)), b.x)) / MAX_STEP));
      const nSub = Math.min(64, need), h = dt / nSub;
      const kinStart = new Map();
      for (const b of list) if (b.type === "kinematic" && b.target) kinStart.set(b, { x: [...b.x], q: [...b.q] });
      for (let s = 0; s < nSub; s++) substep(list, h, s, nSub, kinStart);
      for (const b of list) {
        if (b.type === "kinematic" && b.target) { b.target = null; b.v = [0, 0, 0]; b.w = [0, 0, 0]; }
        if (!b.dynamic || b.asleep || b.target) continue;
        if (len(b.v) < LIN_SLEEP && len(b.w) < ANG_SLEEP) b.still += dt; else b.still = 0;
        if (b.still >= SLEEP_TIME) { b.asleep = true; b.v = [0, 0, 0]; b.w = [0, 0, 0]; }
      }
    },
    dispose() { bodies.clear(); },
  };

  function substep(list, h, s, nSub, kinStart) {
    // Predict.
    for (const b of list) {
      b.vp = [...b.v]; b.wp = [...b.w];
      if (b.type === "static") continue;
      b.xp = [...b.x]; b.qp = [...b.q];
      if (b.type === "kinematic") {
        if (!b.target) { b.v = [0, 0, 0]; b.w = [0, 0, 0]; continue; }
        const st = kinStart.get(b), u = (s + 1) / nSub, tx = add(b.target.pos, qrot(b.target.quat, b.center));
        b.x = st.x.map((v, k) => v + (tx[k] - v) * u); b.q = qslerp(st.q, b.target.quat, u);
        b.v = scl(sub(b.x, b.xp), 1 / h);
        const dq = qmul(b.q, qconj(b.qp));
        b.w = scl([dq[0], dq[1], dq[2]], (dq[3] >= 0 ? 2 : -2) / h);
        b.vp = [...b.v]; b.wp = [...b.w];
        continue;
      }
      if (b.asleep) { b.v = [0, 0, 0]; b.w = [0, 0, 0]; continue; }
      if (b.target) {   // grabbed: chase the target, spread over the substeps left
        const tx = add(b.target.pos, qrot(b.target.quat, b.center));
        let dx = scl(sub(tx, b.x), 1 / (nSub - s));
        const m = len(dx);
        if (m > MAX_STEP) dx = scl(dx, MAX_STEP / m);
        b.x = add(b.x, dx);
        b.q = qslerp(b.q, b.target.quat, 1 / (nSub - s));
        continue;
      }
      b.v[1] -= g * h;
      b.x = add(b.x, scl(b.v, h));
      const dq = qmul([b.w[0], b.w[1], b.w[2], 0], b.q);
      b.q = qnorm([b.q[0] + 0.5 * h * dq[0], b.q[1] + 0.5 * h * dq[1], b.q[2] + 0.5 * h * dq[2], b.q[3] + 0.5 * h * dq[3]]);
    }
    // Contacts: every awake dynamic (and every moving kinematic) body against everything near it.
    const C = [];
    const active = list.filter((b) => (b.dynamic && !b.asleep) || (b.type === "kinematic" && len(b.v) > 1e-6));
    const seen = new Set();
    for (const A of active) {
      if (floor && A.dynamic && A.x[1] - A.bound <= 0) {
        if (A.shape === "sphere") { const c = measure({ type: "sg", a: A, b: GROUND }); if (c.d > 0) C.push(c); }
        else for (const lp of A.probes) if (A.x[1] + qrot(A.q, lp)[1] < 0) C.push({ type: "pg", a: A, b: GROUND, lp });
      }
      for (const B of list) {
        if (B === A) continue;
        const key = A.index < B.index ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
        if (seen.has(key)) continue;
        if (!A.dynamic && !B.dynamic) continue;   // kinematic vs static/kinematic: nothing to solve
        const dx = A.x[0] - B.x[0], dy = A.x[1] - B.x[1], dz = A.x[2] - B.x[2], R = A.bound + B.bound + 0.05;
        if (dx * dx + dy * dy + dz * dz > R * R) continue;
        seen.add(key);
        for (const [S, O] of [[A, B], [B, A]]) {
          if (S.dynamic && S.asleep && (O.target || len(O.v) > WAKE_SPEED)) { S.asleep = false; S.still = 0; }
        }
        if ((!A.free || A.asleep) && (!B.free || B.asleep)) continue;
        pairContacts(A, B, C);
      }
    }
    for (const c of C) { measure(c); c.vnPrev = dot(c.n, relVel(c, true)); c.lam = 0; }
    for (let it = 0; it < iters; it++) for (const c of C) {
      measure(c);
      if (c.d <= 0) continue;
      const A = c.a, B = c.b;
      let rA = sub(c.pA, A.x), rB = sub(c.pB, B.x);
      const wA = wOf(A, rA, c.n), wB = wOf(B, rB, c.n);
      if (wA + wB <= 0) continue;
      const dl = c.d / (wA + wB);
      c.lam += dl;
      applyPos(A, scl(c.n, dl), rA);
      applyPos(B, scl(c.n, -dl), rB);
      if (it > 0) continue;
      const mu = Math.sqrt(Math.max(0, A.friction) * Math.max(0, B.friction));
      if (mu <= 0) continue;
      const lA = qrot(qconj(A.q), sub(c.pA, A.x)), lB = qrot(qconj(B.q), sub(c.pB, B.x));
      const pAn = add(A.x, qrot(A.q, lA)), pAp = add(A.xp, qrot(A.qp, lA));
      const pBn = add(B.x, qrot(B.q, lB)), pBp = add(B.xp, qrot(B.qp, lB));
      const dp = sub(sub(pAn, pAp), sub(pBn, pBp));
      const dpt = sub(dp, scl(c.n, dot(dp, c.n))), m = len(dpt);
      if (m < 1e-9) continue;
      const t = scl(dpt, 1 / m);
      rA = sub(pAn, A.x); rB = sub(pBn, B.x);
      const wtA = wOf(A, rA, t), wtB = wOf(B, rB, t);
      if (wtA + wtB <= 0) continue;
      const lt = m / (wtA + wtB);
      if (lt < mu * c.lam) { applyPos(A, scl(t, -lt), rA); applyPos(B, scl(t, lt), rB); }
    }
    for (const b of list) {
      if (!b.dynamic || b.asleep) continue;
      b.v = scl(sub(b.x, b.xp), 1 / h);
      const dq = qmul(b.q, qconj(b.qp));
      b.w = scl([dq[0], dq[1], dq[2]], (dq[3] >= 0 ? 2 : -2) / h);
      // Two props placed overlapping spring apart at a walk, not like an explosion.
      if (!b.target) { const sp = len(b.v); if (sp > MAX_SPEED) b.v = scl(b.v, MAX_SPEED / sp); const ws = len(b.w); if (ws > 12) b.w = scl(b.w, 12 / ws); }
    }
    const act = C.filter((c) => c.lam > 0);
    for (const c of act) {
      const A = c.a, B = c.b;
      c.rA = sub(c.pA, A.x); c.rB = sub(c.pB, B.x);
      const mu = 0.85 * Math.sqrt(Math.max(0, A.friction) * Math.max(0, B.friction));
      const vr = relVel(c, false), vn = dot(c.n, vr), vt = sub(vr, scl(c.n, vn)), vtl = len(vt);
      if (vtl > 1e-6 && mu > 0) {
        const t = scl(vt, 1 / vtl);
        const wtA = wOf(A, c.rA, t), wtB = wOf(B, c.rB, t);
        if (wtA + wtB > 0) {
          const P = scl(t, -Math.min(h * mu * (c.lam / (h * h)), vtl) / (wtA + wtB));
          applyVel(A, P, c.rA); applyVel(B, scl(P, -1), c.rB);
        }
      }
      const e = Math.abs(c.vnPrev) > 2 * g * h * 4 ? Math.max(A.bounce, B.bounce) : 0;
      c.target = Math.max(-e * c.vnPrev, 0);
      c.wn = wOf(A, c.rA, c.n) + wOf(B, c.rB, c.n);
    }
    for (let it = 0; it < (act.length > 1 ? 6 : 1); it++) for (const c of act) {
      if (!(c.wn > 0)) continue;
      const dvn = c.target - dot(c.n, relVel(c, false));
      if (Math.abs(dvn) < 1e-7) continue;
      const P = scl(c.n, dvn / c.wn);
      applyVel(c.a, P, c.rA); applyVel(c.b, scl(P, -1), c.rB);
    }
    for (const b of list) if (b.dynamic && movable(b) && !b.target) { b.v = scl(b.v, 1 - b.lin * h); b.w = scl(b.w, 1 - b.ang * h); }
  }
  return api;
}

/** Ray against one body (slab test on the oriented box, or the sphere): {point, normal, distance} or null. */
function rayBody(b, o, d) {
  if (b.shape === "sphere") {
    const oc = sub(o, b.x), bb = dot(oc, d), c = dot(oc, oc) - b.r * b.r, disc = bb * bb - c;
    if (disc < 0) return null;
    const t = -bb - Math.sqrt(disc);
    if (t < 0) return null;
    const p = add(o, scl(d, t));
    return { point: p, normal: scl(sub(p, b.x), 1 / b.r), distance: t };
  }
  const lo = qrot(qconj(b.q), sub(o, b.x)), ld = qrot(qconj(b.q), d);
  let t0 = -Infinity, t1 = Infinity, axis = -1, sign = 1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-12) { if (Math.abs(lo[k]) > b.half[k]) return null; continue; }
    let a = (-b.half[k] - lo[k]) / ld[k], c = (b.half[k] - lo[k]) / ld[k], s = -1;
    if (a > c) { [a, c] = [c, a]; s = 1; }
    if (a > t0) { t0 = a; axis = k; sign = s; }
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  if (t0 < 0 || axis < 0) return null;   // starts inside: not a surface to land on
  const nl = [0, 0, 0]; nl[axis] = sign;
  return { point: add(o, scl(d, t0)), normal: qrot(b.q, nl), distance: t0 };
}
