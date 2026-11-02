// Soundstage fracture (Milestone 24): breakable, deformable props, the fix for "it still looks like a video game".
//
// A crate or a cardboard box is pre-split, deterministically from a seed, into the parts it is really made of: planks
// (wood) or panels and top flaps (cardboard). The parts are glued with breakable joints and act as one rigid body
// until a hit loads a joint past its glue strength. Then the parts that came loose become rigid bodies of their own
// that inherit the parent's velocity and spin (the parent-motion idea from the VFX research, item 9). Only joints near
// the hit take its full load (the load falls off with distance), so a crate breaks where it is struck and the rest can
// hold together as a smaller, open crate that can break again later. Cardboard below its break strength dents instead:
// a permanent inward push of the clay mesh on the struck side, scaled by the hit, so a crushed box stays crushed.
//
// Pure functions, no three.js, no randomness beyond the seed: the same scene always fractures the same way. The solver
// side (glue loads, splitting, debris velocities, dents) lives in physics.mjs simulate(); the stage bakes every piece
// into ordinary keys (stage.mjs simulatePhysics) and the clay guide shows the pieces and dents, so LTX follows them.

/**
 * Per material: how it comes apart and how strong the glue is.
 *  strength: velocity change (m/s, i.e. N·s of impulse per kg of the body) a hit has to force through a joint to snap
 *            it. A crate hit by a car at 12 m/s takes about 14; one dropped 1 m onto asphalt about 5.
 *  thick: m, board / panel thickness (also the collision thickness, so thin parts don't tunnel).
 *  burst: m/s per unit of excess load, how hard the loose parts spring away from the break.
 *  dent: cardboard caves in below its break strength: {min (load before any dent), k (m of dent per unit of load over
 *        min), max (deepest dent, as a fraction of the box's smallest half-size)}.
 */
export const BREAK_MATERIALS = Object.freeze({
  wood: Object.freeze({ pattern: "planks", strength: 5.5, thick: 0.045, burst: 0.35, dent: null }),
  cardboard: Object.freeze({ pattern: "panels", strength: 7, thick: 0.03, burst: 0.35,
    dent: Object.freeze({ min: 3, k: 0.03, max: 0.45 }) }),
});
/** Kinds that break by default (a.physics.breakable === false turns it off; true turns it on for other box props). */
export const BREAKABLE_KINDS = new Set(["crate", "box", "carton"]);
/** Most parts one prop splits into, and most loose bodies a whole bake may add (keeps the bake fast). */
export const MAX_PIECES = 8;
export const MAX_SCENE_PIECES = 64;
/** How far a hit's load reaches through the glue, as a fraction of the prop's size (load × e^(-distance / (k·size))). */
export const LOAD_REACH = 1.2;
/** Gap left between neighbouring parts (m), so they never start inside each other. */
const GAP = 0.004;

// ---------- seeded hash (same as impacts.mjs: sin-hash, stable across runs) ----------
export function hash01(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
/** A stable number from a string id. */
export function seedOf(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100003;
}

/**
 * Whether an object breaks, and how: the material settings ({material, pattern, strength, thick, burst, dent}) or null.
 * a: a scene actor; material: its physics material (impacts.materialOf). Wood and cardboard box props only.
 */
export function breakableOf(a, material) {
  const flag = a?.physics?.breakable;
  if (flag === false) return null;
  if (!(flag === true || BREAKABLE_KINDS.has(a?.kind))) return null;
  const cfg = BREAK_MATERIALS[material];
  if (!cfg) return null;
  const s = +a?.physics?.strength;   // optional per-object glue override (0.25..4 x the material's)
  return { material, ...cfg, strength: cfg.strength * (Number.isFinite(s) && s > 0 ? Math.max(0.25, Math.min(4, s)) : 1) };
}

/** Split a slab (centre `off`, half extents `half`) along axis `ax` into n parts with seeded, uneven widths. */
function slats(off, half, ax, n, seed, tag) {
  if (n <= 1) return [{ off: [...off], half: [...half], kind: tag }];
  const w = [];
  for (let i = 0; i < n; i++) w.push(0.8 + 0.4 * hash01(seed, i, ax));
  const sum = w.reduce((s, v) => s + v, 0), L = 2 * half[ax];
  const out = [];
  let lo = off[ax] - half[ax];
  for (let i = 0; i < n; i++) {
    const len = (w[i] / sum) * L, o = [...off], h = [...half];
    o[ax] = lo + len / 2; h[ax] = Math.max(0.005, len / 2 - GAP / 2);
    out.push({ off: o, half: h, kind: tag });
    lo += len;
  }
  return out;
}

/**
 * The parts of a box prop, in the body's own frame relative to its box centre.
 * half: the box half extents [hx, hy, hz]; opts: {material ("wood" | "cardboard"), seed, maxPieces}.
 * Returns {pieces: [{off, half, kind: "plank" | "panel" | "flap"}], joints: [{i, j, p}], size, volume}.
 * Wood: six boarded faces, 1-3 planks each (front/back full size, sides and lid inside them, so nothing overlaps).
 * Cardboard: bottom, four walls and a lid of two flaps.
 */
export function fracturePieces(half, opts = {}) {
  const [hx, hy, hz] = half.map((v) => Math.max(0.02, +v || 0.02));
  const cfg = BREAK_MATERIALS[opts.material] || BREAK_MATERIALS.wood, seed = +opts.seed || 1;
  const cap = opts.cap || MAX_PIECES;   // (Milestone 27's network lays out more boards: cap 16)
  const maxP = Math.max(1, Math.min(cap, opts.maxPieces || cap));
  const t = Math.min(cfg.thick, 0.45 * Math.min(hx, hy, hz) * 2);
  // Faces: [normal axis, sign, slab off, slab half, split axis]
  const faces = [
    [2, 1, [0, 0, hz - t / 2], [hx, hy, t / 2], 1], [2, -1, [0, 0, -(hz - t / 2)], [hx, hy, t / 2], 1],
    [0, 1, [hx - t / 2, 0, 0], [t / 2, hy, hz - t], 1], [0, -1, [-(hx - t / 2), 0, 0], [t / 2, hy, hz - t], 1],
    [1, 1, [0, hy - t / 2, 0], [hx - t, t / 2, hz - t], 0], [1, -1, [0, -(hy - t / 2), 0], [hx - t, t / 2, hz - t], 0],
  ];
  let pieces = [];
  if (cfg.pattern === "panels") {
    for (const [nAx, sg, off, h, ax] of faces) {
      const top = nAx === 1 && sg > 0;
      // The lid is two flaps meeting in the middle (split across the longer side); walls and the bottom are whole.
      const splitAx = top ? (hx >= hz ? 0 : 2) : ax;
      pieces.push(...slats(off, h, splitAx, top ? 2 : 1, seed + 17 * pieces.length, top ? "flap" : "panel"));
    }
  } else {
    // Planks per face: seeded 2-3 (the bottom 2), trimmed down to the cap from the faces with the most.
    const counts = faces.map((f, i) => (f[0] === 1 && f[1] < 0 ? 2 : 2 + Math.floor(hash01(seed, i, 9) * 2)));
    while (counts.reduce((s, v) => s + v, 0) > maxP) {
      let k = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[k]) k = i;
      if (counts[k] <= 1) break;
      counts[k]--;
    }
    faces.forEach(([, , off, h, ax], i) => pieces.push(...slats(off, h, ax, counts[i], seed + 31 * i, "plank")));
  }
  pieces = pieces.slice(0, maxP);
  // Joints: every pair of parts that touch (the gap between their boxes under ~1.5 cm), at the middle of the contact.
  const joints = [];
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    const A = pieces[i], B = pieces[j];
    let gap = -Infinity;
    const p = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const lo = Math.max(A.off[k] - A.half[k], B.off[k] - B.half[k]), hi = Math.min(A.off[k] + A.half[k], B.off[k] + B.half[k]);
      gap = Math.max(gap, lo - hi);
      p[k] = (lo + hi) / 2;
    }
    if (gap < 0.015) joints.push({ i, j, p });
  }
  const volume = pieces.reduce((s, q) => s + 8 * q.half[0] * q.half[1] * q.half[2], 0);
  return { pieces, joints, size: 2 * Math.max(hx, hy, hz), volume, thick: t };
}

/** Glue strength of each joint: the material's, varied ±15% by the seed (painted weak spots, so no two crates match). */
export function jointStrengths(frac, strength, seed = 1) {
  return frac.joints.map((_, k) => strength * (0.85 + 0.3 * hash01(seed, k, 3)));
}

/**
 * The load a hit puts on a joint: the hit's velocity change (m/s, impulse per kg) falling off with the joint's distance
 * from the hit point (both in the body's frame relative to its box centre).
 */
export function jointLoad(load, hit, p, size) {
  const d = Math.hypot(p[0] - hit[0], p[1] - hit[1], p[2] - hit[2]);
  return load * Math.exp(-d / (LOAD_REACH * Math.max(0.05, size)));
}

/**
 * Snap the joints a hit overloads. alive: array of booleans (changed in place); set: the parts of the body that was
 * hit (only joints inside it count). Returns the indices of the joints that snapped.
 */
export function snapJoints(frac, strengths, alive, set, hit, load) {
  const inSet = new Set(set), out = [];
  frac.joints.forEach((jt, k) => {
    if (!alive[k] || !inSet.has(jt.i) || !inSet.has(jt.j)) return;
    if (jointLoad(load, hit, jt.p, frac.size) > strengths[k]) { alive[k] = false; out.push(k); }
  });
  return out;
}

/** The groups of parts still glued together (connected through live joints), each sorted, largest first. */
export function glueGroups(frac, alive, set) {
  const parent = new Map(set.map((i) => [i, i]));
  const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
  frac.joints.forEach((jt, k) => {
    if (!alive[k] || !parent.has(jt.i) || !parent.has(jt.j)) return;
    const a = find(jt.i), b = find(jt.j);
    if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
  });
  const groups = new Map();
  for (const i of set) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b)).sort((a, b) => b.length - a.length || a[0] - b[0]);
}

/** The box around a group of parts (they are all axis-aligned in the body frame): {off, half, volume}. */
export function groupBox(frac, group) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (const i of group) {
    const q = frac.pieces[i];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q.off[k] - q.half[k]); hi[k] = Math.max(hi[k], q.off[k] + q.half[k]); }
    volume += 8 * q.half[0] * q.half[1] * q.half[2];
  }
  return { off: lo.map((v, k) => (v + hi[k]) / 2), half: lo.map((v, k) => (hi[k] - v) / 2), volume };
}

/**
 * A dent from one hit on a dentable (cardboard) body: {depth (m), radius (m)} or null when the hit is too soft.
 * load: the hit's velocity change (m/s); half: the body's half extents.
 */
export function dentFor(cfg, load, half) {
  const d = cfg?.dent;
  if (!d || !(load > d.min)) return null;
  const hmin = Math.min(...half), size = Math.max(...half);
  const depth = Math.min(d.max * hmin, d.k * (load - d.min));
  if (depth < 0.004) return null;
  return { depth: +depth.toFixed(4), radius: +Math.min(size * 1.1, 0.35 * size + depth * 2.2).toFixed(4) };
}

/**
 * How far a point of the prop's surface is pushed by its dents at a frame (object frame: relative to the object's
 * origin, the frame the bake stores dents in). dents: [{frame, p, n (inward unit), depth, radius}]. Returns [dx, dy, dz].
 * A smooth bowl ((1-x²)² falloff) with a seeded crumple ripple, so a dent reads as crushed card, not a soft pillow.
 */
export function dentOffset(dents, frame, v) {
  let dx = 0, dy = 0, dz = 0;
  for (const d of dents || []) {
    if (d.frame > frame) continue;
    const ex = v[0] - d.p[0], ey = v[1] - d.p[1], ez = v[2] - d.p[2];
    // Distance across the struck face (the push direction doesn't count), so a whole face region caves in together.
    const along = ex * d.n[0] + ey * d.n[1] + ez * d.n[2];
    const lx = ex - along * d.n[0], ly = ey - along * d.n[1], lz = ez - along * d.n[2];
    const x = Math.hypot(lx, ly, lz) / d.radius;
    // Only the struck side caves (points deeper in, like the far face, stay put; the side walls fold near the edge).
    const reach = 0.4 * d.radius;
    if (x >= 1 || along > reach || along < -0.5 * reach) continue;
    const ripple = 0.78 + 0.22 * Math.sin(v[0] * 23.1 + d.p[0] * 3) * Math.sin(v[1] * 19.7 + 1.3) * Math.sin(v[2] * 21.3 + d.p[2] * 5);
    const k = d.depth * (1 - x * x) * (1 - x * x) * ripple * (1 - Math.max(0, along) / reach);
    dx += d.n[0] * k; dy += d.n[1] * k; dz += d.n[2] * k;
  }
  return [dx, dy, dz];
}

// =====================================================================================================================
// Milestone 27: Voronoi fracture with a constraint network (the Houdini RBD Material Fracture + Constraint Network idea).
//
// Houdini's look comes from three things, all reproduced here (SideFX docs: RBD Material Fracture, Glue / Soft
// constraints, Bullet solver):
//   1. Pre-fracture by material. Wood is cut by Voronoi cells stretched along the grain (long splinters, not cubes);
//      cardboard keeps its panels and creases and tears into ragged pieces. Cells cluster where the hit lands (RBD
//      Material Fracture's "scatter around impact"): the network is built at the first real hit, around it.
//   2. A constraint network of glue between the pieces, each joint with its own strength: nails between boards, wood
//      fibre inside a board (stronger), creases between cardboard panels (they fold first), tears inside a panel. Glued
//      pieces ride as one rigid body (Bullet's compound clusters); a joint loaded past its strength breaks, and the
//      groups still glued become bodies of their own.
//   3. Soft constraints with plasticity: below its strength a fibre or crease joint yields: a board bends (a plastic
//      beam deflection around the hit) and a flap folds about its crease, permanently, and each hit leaves damage
//      that weakens the joint, so a second blow finishes what the first started (progressive cracking). A board bent
//      past its limit splinters.
// Pure functions, seeded, no three.js: the same scene always cracks the same way.

/** Per material: joint types of the network (multipliers of the material strength), how much they yield and bend. */
export const NETWORK = Object.freeze({
  wood: Object.freeze({
    aniso: 0.3,   // Voronoi metric along the grain (0.3: cells about 3x longer along the grain than across)
    cells: [1, 3],   // cells per board, far from / at the hit (the cap trims the far boards first)
    joints: Object.freeze({
      nail: { k: 1, yield: 1, bend: 0 },   // board to board: nails pop, they don't bend
      fiber: { k: 1.35, yield: 0.55, bend: 0.38 },   // inside a board: bends (past ~4 m/s) up to ~22 deg, then splinters
    }),
  }),
  cardboard: Object.freeze({
    aniso: 1,
    cells: [1, 2],
    joints: Object.freeze({
      crease: { k: 1.15, yield: 0.3, bend: 1.35 },   // panel to panel: folds ~75 deg before it tears
      tear: { k: 0.85, yield: 0.5, bend: 0.3 },   // inside a panel: buckles a little, then tears
    }),
  }),
});
/** The smallest hit (m/s of velocity change) that can bend or break any joint of a material's network (with the
 *  ±15% seeded spread): below it a prop needs no network yet. */
export function networkMinLoad(material, strength) {
  const net = NETWORK[material];
  if (!net) return Infinity;
  return 0.85 * strength * Math.min(...Object.values(net.joints).map((t) => t.k * Math.min(1, t.bend > 0 ? t.yield : 1)));
}
/** Most cells one prop's network may have (the stage's cap; the solver's scene budget is MAX_NETWORK_SCENE). */
export const MAX_NETWORK_CELLS = 14;
export const MAX_NETWORK_SCENE = 90;
/** Gap between neighbouring cells (m): cells shrink this much towards their centre so they never start inside each other. */
const CELL_GAP = 0.0015;

// ---------- convex polyhedra (Voronoi cells) ----------
/** A box as a polyhedron: faces [{pts, tag}] (outward counter-clockwise polygons). */
function boxPoly(off, half) {
  const c = (i, j, k) => [off[0] + i * half[0], off[1] + j * half[1], off[2] + k * half[2]];
  const F = [
    [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)], [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)],
    [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)], [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)],
    [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], [c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1)],
  ];
  return F.map((pts, i) => ({ pts, tag: `s${i}` }));
}
const v3 = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scl: (a, s) => [a[0] * s, a[1] * s, a[2] * s], dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] };
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const centroidOf = (pts) => v3.scl(pts.reduce((s, p) => v3.add(s, p), [0, 0, 0]), 1 / Math.max(1, pts.length));

/** Clip a convex polyhedron by the half-space n·x <= d; the new face (on the plane) gets `tag`. null when nothing is left. */
export function clipPoly(faces, n, d, tag, eps = 1e-9) {
  const out = [], cut = [];
  for (const f of faces) {
    const P = f.pts, res = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], da = v3.dot(n, a) - d, db = v3.dot(n, b) - d;
      if (da <= eps) res.push(a);
      if ((da < -eps && db > eps) || (da > eps && db < -eps)) {
        const t = da / (da - db), x = v3.add(a, v3.scl(v3.sub(b, a), t));
        res.push(x); cut.push(x);
      } else if (Math.abs(da) <= eps) cut.push(a);
    }
    if (res.length >= 3) out.push({ pts: res, tag: f.tag });
  }
  if (!out.length) return null;
  // The cap: the cut points ordered round their centre in the plane.
  const uniq = [];
  for (const p of cut) if (!uniq.some((q) => vlen(v3.sub(p, q)) < 1e-7)) uniq.push(p);
  if (uniq.length >= 3) {
    const c = centroidOf(uniq), ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = vnorm(v3.cross(n, ax)), e2 = v3.cross(n, e1);
    uniq.sort((p, q) => Math.atan2(v3.dot(v3.sub(p, c), e2), v3.dot(v3.sub(p, c), e1)) - Math.atan2(v3.dot(v3.sub(q, c), e2), v3.dot(v3.sub(q, c), e1)));
    // counter-clockwise seen from outside (along +n)
    const nn = v3.cross(v3.sub(uniq[1], uniq[0]), v3.sub(uniq[2], uniq[0]));
    if (v3.dot(nn, n) < 0) uniq.reverse();
    out.push({ pts: uniq, tag });
  }
  return out;
}

/**
 * Voronoi cells of seeds inside a box (off, half), under a metric that counts distance along axis `grain` `aniso`
 * times (aniso < 1: cells stretched along the grain). Returns cells [{seed, faces: [{pts, tag}]}]; a face tagged
 * `c<j>` is shared with cell j, `s<i>` is the box's own surface.
 */
export function voronoiCells(off, half, seeds, { grain = 0, aniso = 1 } = {}) {
  const S = [1, 1, 1]; S[grain] = aniso;
  const fwd = (p) => [p[0] * S[0], p[1] * S[1], p[2] * S[2]], back = (p) => [p[0] / S[0], p[1] / S[1], p[2] / S[2]];
  const sOff = fwd(off), sHalf = fwd(half), sp = seeds.map(fwd);
  const cells = [];
  sp.forEach((si, i) => {
    let faces = boxPoly(sOff, sHalf);
    // Nearest seeds first (their planes cut the most), all of them for correctness.
    const order = sp.map((_, j) => j).filter((j) => j !== i).sort((a, b) => vlen(v3.sub(sp[a], si)) - vlen(v3.sub(sp[b], si)));
    for (const j of order) {
      if (!faces) break;
      const sj = sp[j], n = vnorm(v3.sub(sj, si)), mid = v3.scl(v3.add(si, sj), 0.5);
      faces = clipPoly(faces, n, v3.dot(n, mid), `c${j}`);
    }
    if (faces) cells.push({ index: i, seed: seeds[i], faces: faces.map((f) => ({ pts: f.pts.map(back), tag: f.tag })) });
  });
  return cells;
}

/** The slabs a box prop is made of (boards / panels, in its frame relative to its box centre), as fracturePieces lays them out. */
function slabsOf(half, cfg, seed, maxSlabs) {
  return fracturePieces(half, { material: cfg === BREAK_MATERIALS.cardboard ? "cardboard" : "wood", seed, maxPieces: maxSlabs, cap: maxSlabs }).pieces;
}

/**
 * The constraint network of a breakable box prop (Milestone 27). half: box half extents; opts: {material, seed,
 * impact (the hit point in the prop's frame relative to its box centre, or null: cells spread evenly), maxPieces}.
 * Returns {pieces: [{off (centroid), half (half extents of its box round the centroid), kind, member, v (vertices),
 * faces: [{idx, tag ("out" | "cut")}], grain (unit), normal (its board's outward normal)}], joints: [{i, j, p, n,
 * type, area}], members: [{kind, off, half, grain, normal, axis, cells}], size, volume, thick, network: true}.
 * Every piece is a convex Voronoi cell of one board or panel; joints link cells that share a face (fibre / tear) and
 * cells of touching boards (nail / crease).
 */
export function fractureNetwork(half, opts = {}) {
  const material = opts.material === "cardboard" ? "cardboard" : "wood";
  const cfg = BREAK_MATERIALS[material], net = NETWORK[material], seed = +opts.seed || 1;
  const maxP = Math.max(1, Math.min(MAX_NETWORK_CELLS, opts.maxPieces || MAX_NETWORK_CELLS));
  // Wood: 1-3 boards a face, up to 11 (the render mesh adds the splinters); cardboard: its 7 panels and flaps.
  const slabs = slabsOf(half, cfg, seed, material === "wood" ? Math.min(11, maxP) : 8);
  const size = 2 * Math.max(...half);
  const hit = Array.isArray(opts.impact) ? opts.impact : null;
  // Cells per board: more near the hit (scatter around the impact), seeded; trimmed to the cap from the far boards.
  const dist = slabs.map((s) => (hit ? vlen(v3.sub(clampBox(hit, s.off, s.half), hit)) : 0));
  const want = slabs.map((s, i) => {
    const [lo, hi] = net.cells;
    if (!hit) return Math.min(hi, lo + Math.floor(hash01(seed, i, 41) * 2));
    const k = Math.exp(-dist[i] / (0.45 * size));
    return Math.max(lo, Math.min(hi, Math.round(lo + (hi - lo) * k + 0.35 * (hash01(seed, i, 43) - 0.5))));
  });
  const order = slabs.map((_, i) => i).sort((a, b) => dist[b] - dist[a] || b - a);
  for (let guard = 0; want.reduce((s, v) => s + v, 0) > maxP && guard < 64; guard++) {
    const i = order.find((k) => want[k] > 1);
    if (i == null) break;
    want[i]--;
  }
  const pieces = [], members = [], joints = [];
  slabs.forEach((s, si) => {
    const ax = longAxis(s.half), thinAx = thinAxis(s.half);
    const grain = [0, 0, 0]; grain[ax] = 1;
    const normal = [0, 0, 0]; normal[thinAx] = s.off[thinAx] >= 0 ? 1 : -1;
    const n = want[si];
    const seeds = [];
    for (let k = 0; k < n; k++) {
      const p = [...s.off];
      if (hit && dist[si] < 0.6 * size) {
        // Around the hit: the first seed at the hit (on this board), the others scattered along the grain from it.
        const c = clampBox(hit, s.off, s.half);
        for (let a = 0; a < 3; a++) p[a] = c[a];
        if (k > 0) p[ax] += (hash01(seed + si, k, 47) - 0.5) * 2 * s.half[ax] * (0.35 + 0.4 * k / n);
      } else p[ax] += ((k + 0.5) / n - 0.5) * 2 * s.half[ax] + (hash01(seed + si, k, 51) - 0.5) * s.half[ax] / n;
      // Across the board a little (so splits run along the grain, but not dead straight).
      const across = [0, 1, 2].find((a) => a !== ax && a !== thinAx);
      p[across] += (hash01(seed + si, k, 53) - 0.5) * 1.2 * s.half[across];
      for (let a = 0; a < 3; a++) p[a] = Math.max(s.off[a] - 0.98 * s.half[a], Math.min(s.off[a] + 0.98 * s.half[a], p[a]));
      // Never two seeds on the same spot.
      if (seeds.some((q) => vlen(v3.sub(q, p)) < 1e-4)) p[ax] += 0.05 * s.half[ax] * (k + 1);
      seeds.push(p);
    }
    const cells = n > 1 ? voronoiCells(s.off, s.half, seeds, { grain: ax, aniso: net.aniso }) : [{ index: 0, seed: s.off, faces: boxPoly(s.off, s.half) }];
    const mem = { kind: s.kind, off: s.off, half: s.half, grain, normal, axis: ax, cells: [] };
    const local = new Map();
    // Board seams for the render mesh: across the grain, in the board's plane, over the whole slab.
    const acrossAx = [0, 1, 2].find((a) => a !== ax && a !== thinAx);
    for (const cell of cells) {
      const pc = cellPiece(cell, s.kind, si, grain, normal);
      if (!pc) continue;
      if (material === "wood") {
        const dir = [0, 0, 0]; dir[acrossAx] = 1;
        pc.boards = [dir[0], dir[1], dir[2], s.off[acrossAx] - s.half[acrossAx] - pc.off[acrossAx], s.off[acrossAx] + s.half[acrossAx] - pc.off[acrossAx]];
      }
      local.set(cell.index, pieces.length);
      mem.cells.push(pieces.length);
      pieces.push(pc);
    }
    members.push(mem);
    // Joints inside the board: cells sharing a face.
    for (const cell of cells) for (const f of cell.faces) {
      const m = /^c(\d+)$/.exec(f.tag);
      if (!m) continue;
      const i = local.get(cell.index), j = local.get(+m[1]);
      if (i == null || j == null || j <= i) continue;
      const p = centroidOf(f.pts), nrm = polyNormal(f.pts);
      joints.push({ i, j, p, n: nrm, area: polyArea(f.pts), type: material === "wood" ? "fiber" : "tear" });
    }
  });
  // Joints between boards: where two boards touch, a few points along the contact, each tying the two cells there.
  for (let a = 0; a < slabs.length; a++) for (let b = a + 1; b < slabs.length; b++) {
    const A = slabs[a], B = slabs[b];
    let gap = -Infinity;
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.max(A.off[k] - A.half[k], B.off[k] - B.half[k]); hi[k] = Math.min(A.off[k] + A.half[k], B.off[k] + B.half[k]);
      gap = Math.max(gap, lo[k] - hi[k]);
    }
    if (gap >= 0.015) continue;
    const ext = [0, 1, 2].map((k) => Math.max(0, hi[k] - lo[k])), la = ext.indexOf(Math.max(...ext));
    const seen = new Set();
    for (const u of [1 / 6, 0.5, 5 / 6]) {
      const p = lo.map((v, k) => (v + hi[k]) / 2);
      p[la] = lo[la] + u * (hi[la] - lo[la]);
      const i = nearestCell(pieces, members[a].cells, p), j = nearestCell(pieces, members[b].cells, p);
      if (i == null || j == null) continue;
      const key = i < j ? `${i}/${j}` : `${j}/${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const axis = [0, 0, 0]; axis[la] = 1;
      joints.push({ i: Math.min(i, j), j: Math.max(i, j), p, n: [0, 0, 0], axis, area: ext[la] * cfg.thick / 3, type: material === "wood" ? "nail" : "crease" });
    }
  }
  const volume = pieces.reduce((s, q) => s + q.volume, 0);
  return { pieces, joints, members, size, volume, thick: Math.min(cfg.thick, 0.45 * Math.min(...half) * 2), network: true, material };
}

const longAxis = (h) => h.indexOf(Math.max(...h));
const thinAxis = (h) => h.indexOf(Math.min(...h));
const clampBox = (p, off, half) => p.map((v, k) => Math.max(off[k] - half[k], Math.min(off[k] + half[k], v)));
function polyNormal(P) {
  let n = [0, 0, 0];
  for (let i = 1; i + 1 < P.length; i++) n = v3.add(n, v3.cross(v3.sub(P[i], P[0]), v3.sub(P[i + 1], P[0])));
  return vnorm(n);
}
function polyArea(P) {
  let n = [0, 0, 0];
  for (let i = 1; i + 1 < P.length; i++) n = v3.add(n, v3.cross(v3.sub(P[i], P[0]), v3.sub(P[i + 1], P[0])));
  return vlen(n) / 2;
}

/** A Voronoi cell as a piece: unique vertices (shrunk by CELL_GAP towards its centre), faces as vertex index loops. */
function cellPiece(cell, kind, member, grain, normal) {
  const verts = [], idxOf = (p) => {
    for (let i = 0; i < verts.length; i++) if (vlen(v3.sub(verts[i], p)) < 1e-7) return i;
    verts.push(p); return verts.length - 1;
  };
  const faces = [];
  for (const f of cell.faces) {
    const idx = [];
    for (const p of f.pts) { const i = idxOf(p); if (idx[idx.length - 1] !== i && idx[0] !== i) idx.push(i); }
    if (idx.length >= 3) faces.push({ idx, tag: /^c/.test(f.tag) ? "cut" : "out" });
  }
  if (verts.length < 4 || faces.length < 4) return null;
  const c = centroidOf(verts);
  let r = 0;
  for (const p of verts) r = Math.max(r, vlen(v3.sub(p, c)));
  const k = r > 0 ? Math.max(0.5, 1 - CELL_GAP / r) : 1;
  const v = verts.map((p) => v3.add(c, v3.scl(v3.sub(p, c), k)));
  // Volume (divergence theorem over the faces, fan-triangulated round the centroid).
  let vol = 0;
  for (const f of faces) for (let i = 1; i + 1 < f.idx.length; i++) {
    const a = v3.sub(v[f.idx[0]], c), b = v3.sub(v[f.idx[i]], c), d = v3.sub(v[f.idx[i + 1]], c);
    vol += v3.dot(a, v3.cross(b, d)) / 6;
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of v) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  const off = c.map((x) => +x.toFixed(6));
  return { off, half: [0, 1, 2].map((a) => Math.max(hi[a] - off[a], off[a] - lo[a])), kind: faces.some((f) => f.tag === "cut") ? (kind === "plank" ? "splinter" : kind === "panel" ? "torn" : kind) : kind,
    member, v, faces, grain, normal, volume: Math.abs(vol) };
}

/** The cell of a board that holds point p (the one it is least outside of, by its centroid distance as a tie-break). */
function nearestCell(pieces, cells, p) {
  let best = null, bd = Infinity;
  for (const i of cells) {
    const q = pieces[i], d = [0, 1, 2].reduce((s, a) => s + Math.max(0, Math.abs(p[a] - q.off[a]) - q.half[a]) ** 2, 0) + 1e-6 * vlen(v3.sub(p, q.off));
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Per-joint glue settings of a network: [{str (strength, m/s of hit), yield (load where it starts to bend), bend (most
 * plastic bend, rad, 0 = rigid), type}], each strength varied ±15% by the seed. An M24-style piece list (no types) is
 * all rigid glue at the material strength.
 */
export function networkJoints(frac, strength, seed = 1) {
  const net = NETWORK[frac.material] || null;
  return frac.joints.map((jt, k) => {
    const t = net?.joints?.[jt.type] || { k: 1, yield: 1, bend: 0 };
    const s = strength * t.k * (0.85 + 0.3 * hash01(seed, k, 3));
    return { str: s, yield: s * t.yield, bend: t.bend, type: jt.type || "glue" };
  });
}

/** How a joint takes a hit: its load (as jointLoad), whether it snaps, yields (bends) or holds, and the damage it keeps. */
export function jointResponse(J, load) {
  if (load > J.str) return { snap: true, yield: 0, damage: 0 };
  if (J.bend > 0 && load > J.yield) return { snap: false, yield: (load - J.yield) / Math.max(1e-6, J.str - J.yield), damage: 0.25 * (load - J.yield) / J.str };
  // Below its yield a hard knock still leaves some damage (fatigue): the next hit needs less.
  const fat = load > 0.6 * J.str ? 0.15 * (load - 0.6 * J.str) / J.str : 0;
  return { snap: false, yield: 0, damage: fat };
}

/**
 * A board's plastic bend: where each of its cells goes when the board is bent by angle `theta` (rad) with the bend
 * peaking at `s0` (along the board's grain, from its centre). The board deflects inwards (against its outward normal)
 * on a parabola pinned at both ends; each cell moves to the curve and turns with its slope.
 * Returns [{i, o (new centroid), q (rotation, [x, y, z, w])}] for the board's cells.
 */
export function bendMember(frac, m, theta, s0 = 0, base = null) {
  const M = frac.members[m], L = M.half[M.axis], u = M.grain, n = M.normal;
  const s1 = Math.max(-0.8 * L, Math.min(0.8 * L, s0));
  // Peak deflection for a kink angle theta: the two arms' slopes add up to theta at the peak.
  const a = Math.tan(Math.min(1.2, theta)) * (L + s1) * (L - s1) / (2 * L);
  const prof = (s) => (s < s1 ? 1 - ((s1 - s) / (s1 + L)) ** 2 : 1 - ((s - s1) / (L - s1)) ** 2);
  const slope = (s) => (s < s1 ? 2 * (s1 - s) / (s1 + L) ** 2 : -2 * (s - s1) / (L - s1) ** 2);
  const axis = vnorm(v3.cross(n, u));
  return M.cells.map((i) => {
    const o0 = base?.[i]?.o0 || frac.pieces[i].off;
    const s = v3.dot(v3.sub(o0, M.off), u);
    const w = a * Math.max(0, prof(Math.max(-L, Math.min(L, s))));
    const ang = Math.atan(a * slope(Math.max(-L, Math.min(L, s))));
    const h = ang / 2;
    return { i, o: v3.sub(o0, v3.scl(n, w)), q: [axis[0] * Math.sin(h), axis[1] * Math.sin(h), axis[2] * Math.sin(h), Math.cos(h)] };
  });
}

/** An M24-style piece list ({pieces: [{off, half, kind}], joints: [{i, j, p}]}) as a network: box cells, rigid glue. */
export function asNetwork(frac) {
  if (!frac?.pieces?.length || frac.pieces[0].v) return frac;
  const pieces = frac.pieces.map((q, i) => {
    const v = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) v.push([q.off[0] + a * q.half[0], q.off[1] + b * q.half[1], q.off[2] + c * q.half[2]]);
    const ax = longAxis(q.half), grain = [0, 0, 0]; grain[ax] = 1;
    const th = thinAxis(q.half), normal = [0, 0, 0]; normal[th] = q.off[th] >= 0 ? 1 : -1;
    // faces of the 8 corners above (index = 4a' + 2b' + c', with a' = (a + 1) / 2)
    const faces = [[4, 6, 7, 5], [0, 1, 3, 2], [2, 3, 7, 6], [0, 4, 5, 1], [1, 5, 7, 3], [0, 2, 6, 4]].map((idx) => ({ idx, tag: "out" }));
    return { ...q, member: i, v, faces, grain, normal, volume: 8 * q.half[0] * q.half[1] * q.half[2] };
  });
  const members = pieces.map((q) => ({ kind: q.kind, off: q.off, half: q.half, grain: q.grain, normal: q.normal, axis: longAxis(q.half), cells: [pieces.indexOf(q)] }));
  return { ...frac, pieces, members, joints: frac.joints.map((j) => ({ ...j, type: "glue" })), network: true };
}
