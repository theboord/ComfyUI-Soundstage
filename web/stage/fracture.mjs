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
  const maxP = Math.max(1, Math.min(MAX_PIECES, opts.maxPieces || MAX_PIECES));
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
