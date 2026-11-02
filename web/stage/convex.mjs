// Soundstage convex shapes (Milestone 27): real collision shapes for props, computed from the prop's own mesh.
//
// What Houdini's RBD Bullet solver does with "Convex Hull" / "Convex Decomposition" geometry representations, in pure
// JS for the XPBD bake (physics.mjs):
//   quickhull(points)          the convex hull of a point set (Barber, Dobkin & Huhdanpaa 1996, "The Quickhull
//                              algorithm for convex hulls"), as outward triangles;
//   makeHull(points, opts)     a collision hull: at most maxVerts vertices (farthest-point sampling, like Bullet's
//                              btShapeHull), its face planes (coplanar triangles merged), extents and mass properties;
//   decompose(parts, opts)     a few hulls for a concave prop (a chair, a table, an open crate): one hull per mesh part,
//                              merged greedily while the merge adds little empty volume, then split VHACD-style
//                              (Mamou 2016) by the plane that removes the most empty hull volume (one level of
//                              lookahead, so a table top comes off before its legs are separated);
//   gjk / epa                  Gilbert-Johnson-Keerthi overlap test and the Expanding Polytope Algorithm (van den
//                              Bergen 2001) for the penetration normal, depth and witness points;
//   hullContacts(A, B, out)    XPBD contacts between two bodies made of hulls: a separating-axis test over both
//                              hulls' face planes, then every vertex of one inside the other becomes a point contact
//                              pushed out through the least-overlap face (the same scheme as the box probes in
//                              physics.mjs, so stacks behave the same), and GJK/EPA catches the edge-on-edge case the
//                              vertices miss.
// Pure functions, no three.js, no randomness: the same mesh always gives the same hulls.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Most vertices a collision hull keeps (a fracture cell has 8-20; a GLB prop's hull is sampled down to this). */
export const MAX_HULL_VERTS = 24;
/** Most hulls one prop is decomposed into (each hull pair is a contact test every substep). */
export const MAX_HULLS = 4;

// ---------- quickhull ----------
/**
 * Convex hull of points [[x, y, z]]: {verts: [[x, y, z]], tris: [[a, b, c]]} with outward counter-clockwise triangles,
 * or null when the points span no volume (fewer than 4, or flat).
 */
export function quickhull(points) {
  const pts = dedupe(points);
  if (pts.length < 4) return null;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(scale > 1e-9)) return null;
  const tol = 1e-7 * scale + 1e-12;
  // Initial tetrahedron: the farthest pair of the 6 axis extremes, the point farthest from that line, then from that plane.
  const ext = [];
  for (let k = 0; k < 3; k++) {
    let a = 0, b = 0;
    pts.forEach((p, i) => { if (p[k] < pts[a][k]) a = i; if (p[k] > pts[b][k]) b = i; });
    ext.push(a, b);
  }
  let i0 = ext[0], i1 = ext[1], best = -1;
  for (const a of ext) for (const b of ext) { const d = len(sub(pts[a], pts[b])); if (d > best) { best = d; i0 = a; i1 = b; } }
  if (best <= tol) return null;
  const dir = norm(sub(pts[i1], pts[i0]));
  let i2 = -1; best = tol;
  pts.forEach((p, i) => { const v = sub(p, pts[i0]); const d = len(sub(v, scl(dir, dot(v, dir)))); if (d > best) { best = d; i2 = i; } });
  if (i2 < 0) return null;
  const n0 = norm(cross(sub(pts[i1], pts[i0]), sub(pts[i2], pts[i0])));
  let i3 = -1; best = tol;
  pts.forEach((p, i) => { const d = Math.abs(dot(sub(p, pts[i0]), n0)); if (d > best) { best = d; i3 = i; } });
  if (i3 < 0) return null;
  const faces = [];
  const mk = (a, b, c) => {
    const n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a])), l = len(n);
    const nn = l > 0 ? scl(n, 1 / l) : [0, 0, 0];
    const f = { a, b, c, n: nn, d: dot(nn, pts[a]), out: [], alive: true };
    faces.push(f);
    return f;
  };
  const cen = scl(add(add(pts[i0], pts[i1]), add(pts[i2], pts[i3])), 0.25);
  for (const [a, b, c] of [[i0, i1, i2], [i0, i3, i1], [i1, i3, i2], [i2, i3, i0]]) {
    const f = mk(a, b, c);
    if (dot(f.n, cen) - f.d > 0) { faces.pop(); mk(a, c, b); }
  }
  const used = new Set([i0, i1, i2, i3]);
  pts.forEach((p, i) => {
    if (used.has(i)) return;
    for (const f of faces) if (dot(f.n, p) - f.d > tol) { f.out.push(i); return; }
  });
  for (let guard = 0; guard < 4 * pts.length + 16; guard++) {
    const f = faces.find((x) => x.alive && x.out.length);
    if (!f) break;
    let eye = f.out[0], far = -Infinity;
    for (const i of f.out) { const d = dot(f.n, pts[i]) - f.d; if (d > far) { far = d; eye = i; } }
    const E = pts[eye];
    const vis = faces.filter((x) => x.alive && dot(x.n, E) - x.d > tol);
    const edges = new Set();
    for (const v of vis) for (const [p, q] of [[v.a, v.b], [v.b, v.c], [v.c, v.a]]) edges.add(p * 1e6 + q);
    const orphans = [];
    for (const v of vis) { v.alive = false; for (const i of v.out) if (i !== eye) orphans.push(i); v.out = []; }
    const fresh = [];
    for (const v of vis) for (const [p, q] of [[v.a, v.b], [v.b, v.c], [v.c, v.a]]) {
      if (!edges.has(q * 1e6 + p)) fresh.push(mk(p, q, eye));
    }
    for (const i of orphans) {
      for (const nf of fresh) if (dot(nf.n, pts[i]) - nf.d > tol) { nf.out.push(i); break; }
    }
  }
  const live = faces.filter((f) => f.alive && len(f.n) > 0);
  const map = new Map(), verts = [];
  const id = (i) => { if (!map.has(i)) { map.set(i, verts.length); verts.push(pts[i]); } return map.get(i); };
  const tris = live.map((f) => [id(f.a), id(f.b), id(f.c)]);
  return { verts, tris };
}

/** Points with near-duplicates removed (1e-7 of the extent), in a stable order. */
function dedupe(points) {
  let s = 0;
  for (const p of points) s = Math.max(s, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const q = Math.max(1e-9, s * 1e-7), seen = new Set(), out = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p[0] + p[1] + p[2])) continue;
    const k = `${Math.round(p[0] / q)},${Math.round(p[1] / q)},${Math.round(p[2] / q)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push([+p[0], +p[1], +p[2]]);
  }
  return out;
}

/** Farthest-point sampling: `count` of the points, spread out, starting from the one farthest from their centroid. */
export function spreadPoints(points, count) {
  if (points.length <= count) return points.slice();
  const c = scl(points.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / points.length);
  let first = 0, far = -1;
  points.forEach((p, i) => { const d = len(sub(p, c)); if (d > far) { far = d; first = i; } });
  const dist = points.map((p) => len(sub(p, points[first])));
  const pick = [first];
  while (pick.length < count) {
    let k = -1, bd = -1;
    dist.forEach((d, i) => { if (d > bd) { bd = d; k = i; } });
    if (bd <= 0) break;
    pick.push(k);
    points.forEach((p, i) => { dist[i] = Math.min(dist[i], len(sub(p, points[k]))); });
  }
  return pick.sort((a, b) => a - b).map((i) => points[i]);
}

// ---------- collision hulls ----------
/**
 * A collision hull from points (any frame): {v (vertices), tris, planes [[nx, ny, nz, d]] (n·x <= d inside, unique),
 * w (extent of the hull along each plane normal), c (vertex centroid), r (radius about c), lo, hi (box), volume, com,
 * inertia (3x3, unit density, about com)}, or null when the points are flat. opts: {maxVerts}.
 */
export function makeHull(points, opts = {}) {
  const maxV = Math.max(4, opts.maxVerts || MAX_HULL_VERTS);
  let qh = quickhull(points);
  if (!qh) return null;
  if (qh.verts.length > maxV) qh = quickhull(spreadPoints(qh.verts, maxV)) || qh;
  return hullFromTris(qh.verts, qh.tris);
}

function hullFromTris(v, tris) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of v) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const planes = [];
  for (const [a, b, c] of tris) {
    const n = norm(cross(sub(v[b], v[a]), sub(v[c], v[a]))), d = dot(n, v[a]);
    if (!planes.some((P) => P[0] * n[0] + P[1] * n[1] + P[2] * n[2] > 1 - 1e-6 && Math.abs(P[3] - d) < 1e-6 * scale + 1e-9)) planes.push([n[0], n[1], n[2], d]);
  }
  const w = planes.map((P) => P[3] - Math.min(...v.map((p) => P[0] * p[0] + P[1] * p[1] + P[2] * p[2])));
  // Each plane's face polygon (vertex indices, counter-clockwise seen from outside): the contact clipping uses them.
  const ptol = 1e-6 * scale + 1e-9;
  const fp = planes.map((P) => {
    const idx = [];
    v.forEach((p, i) => { if (Math.abs(P[0] * p[0] + P[1] * p[1] + P[2] * p[2] - P[3]) <= ptol * 10) idx.push(i); });
    const c = scl(idx.reduce((s, i) => add(s, v[i]), [0, 0, 0]), 1 / Math.max(1, idx.length));
    const n = [P[0], P[1], P[2]], e1 = norm(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), e2 = cross(n, e1);
    return idx.sort((a, b) => Math.atan2(dot(sub(v[a], c), e2), dot(sub(v[a], c), e1)) - Math.atan2(dot(sub(v[b], c), e2), dot(sub(v[b], c), e1)));
  });
  const c = scl(v.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / v.length);
  const r = Math.max(...v.map((p) => len(sub(p, c))));
  const mp = massProps(v, tris);
  return { v, tris, planes, w, fp, c, r, lo, hi, ...mp };
}

/** The hull of a box (half extents, centre `off`): 8 corners, 6 planes. */
export function boxHull(half, off = [0, 0, 0]) {
  const v = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) v.push([off[0] + i * half[0], off[1] + j * half[1], off[2] + k * half[2]]);
  return makeHull(v);
}

/**
 * Volume, centre of mass and inertia tensor (unit density, about the centre of mass) of a closed outward triangle mesh:
 * signed tetrahedra from a reference point, with the covariance form of the second moments (Blow & Binstock 2004).
 */
export function massProps(v, tris) {
  const ref = scl(v.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / Math.max(1, v.length));
  let V = 0, cm = [0, 0, 0];
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const [ia, ib, ic] of tris) {
    const a = sub(v[ia], ref), b = sub(v[ib], ref), c = sub(v[ic], ref);
    const det = dot(a, cross(b, c));
    V += det / 6;
    cm = add(cm, scl(add(add(a, b), c), det / 24));
    // Covariance of the tetrahedron (0, a, b, c): det/120 * (sum_i x_i x_iᵀ + (sum x)(sum x)ᵀ)
    const s = add(add(a, b), c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += (det / 120) * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + s[i] * s[j]);
  }
  if (!(V > 1e-15)) return { volume: 0, com: ref, inertia: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] };
  const com = scl(cm, 1 / V);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] -= V * com[i] * com[j];   // about the centre of mass
  const tr = C[0][0] + C[1][1] + C[2][2];
  const I = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? tr : 0) - C[i][j]));
  return { volume: V, com: add(com, ref), inertia: I };
}

/** A hull moved by `off` and (optionally) rotated by unit quaternion q about `pivot`: a new hull. */
export function transformHull(h, { q = null, pivot = [0, 0, 0], off = [0, 0, 0] } = {}) {
  const v = h.v.map((p) => add(q ? add(qrot(q, sub(p, pivot)), pivot) : p, off));
  return hullFromTris(v, h.tris);
}

export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Volume and inertia of several hulls together (unit density): {volume, com, inertia}. */
export function compoundMass(hulls) {
  let V = 0, cm = [0, 0, 0];
  for (const h of hulls) { V += h.volume; cm = add(cm, scl(h.com, h.volume)); }
  const com = V > 0 ? scl(cm, 1 / V) : [0, 0, 0];
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const h of hulls) {
    const d = sub(h.com, com), dd = dot(d, d);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[i][j] += h.inertia[i][j] + h.volume * ((i === j ? dd : 0) - d[i] * d[j]);
  }
  return { volume: V, com, inertia: I };
}

// ---------- convex decomposition ----------
/**
 * A few convex hulls for a (possibly concave) prop. parts: one entry per mesh part, each a point list [[x, y, z]] or
 * {points, tris} (a triangle mesh: needed to cut a lone mesh, so each side's hull reaches the cut). opts: {maxHulls
 * (MAX_HULLS), maxVerts, merge (0.12: merge two hulls while the merged hull adds under this share of empty volume),
 * split (0.2: cut a hull while the best cut, with one level of lookahead, removes more than this share of its volume)}.
 * Returns hulls (makeHull output).
 * Like V-HACD's goal (few hulls, little empty volume), without voxels: a built prop's part list is already its own
 * convex pieces (a chair's seat, back and legs), so it starts from those and merges; a lone mesh is cut by planes.
 */
export function decompose(parts, opts = {}) {
  const maxH = Math.max(1, opts.maxHulls || MAX_HULLS), maxV = opts.maxVerts || MAX_HULL_VERTS;
  const mergeTol = opts.merge ?? 0.12, splitTol = opts.split ?? 0.2;
  let items = parts.map((p) => meshItem(p, maxV)).filter(Boolean);
  if (!items.length) return [];
  if (items.length === 1 && maxH > 1) {
    for (let guard = 0; guard < maxH - 1; guard++) {
      let bestI = -1, bestCut = null;
      items.forEach((it, i) => {
        const cut = bestSplit(it, maxV, 1);
        if (cut && cut.score > splitTol && (!bestCut || cut.score > bestCut.score)) { bestCut = cut; bestI = i; }
      });
      if (bestI < 0) break;
      items.splice(bestI, 1, ...bestCut.sides);
    }
    return items.map((x) => x.h);
  }
  // Parts: merge the pair whose merged hull adds the least empty volume, while that is small or there are too many.
  for (let guard = 0; guard < 64 && items.length > 1; guard++) {
    let best = null;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (items.length <= maxH && len(sub(A.h.c, B.h.c)) - A.h.r - B.h.r > 0.02) continue;   // far apart: never cheap
      const pts = A.pts.concat(B.pts), h = makeHull(pts, { maxVerts: maxV });
      if (!h) continue;
      // Pick by the empty volume added (absolute: two thin legs before a leg and the top), stop by its share.
      const empty = h.volume - A.h.volume - B.h.volume, waste = empty / Math.max(1e-12, h.volume);
      if (!best || empty < best.empty) best = { i, j, m: { pts, edges: [], h }, waste, empty };
    }
    if (!best || (items.length <= maxH && best.waste > mergeTol)) break;
    items.splice(best.j, 1); items.splice(best.i, 1, best.m);
  }
  return items.map((x) => x.h);
}

/** Just the volume of a point set's hull (the lookahead's cheap score), as {volume}. */
function hullVolume(pts) {
  const q = quickhull(pts);
  if (!q) return null;
  const ref = q.verts[0];
  let V = 0;
  for (const [a, b, c] of q.tris) V += dot(sub(q.verts[a], ref), cross(sub(q.verts[b], ref), sub(q.verts[c], ref))) / 6;
  return { volume: V };
}

function meshItem(p, maxV) {
  const pts = Array.isArray(p) ? p : p?.points;
  if (!pts || pts.length < 4) return null;
  const edges = [];
  if (!Array.isArray(p) && p.tris) {
    const seen = new Set();
    for (const t of p.tris) for (const [i, j] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const k = i < j ? i * 1e7 + j : j * 1e7 + i;
      if (!seen.has(k)) { seen.add(k); edges.push([Math.min(i, j), Math.max(i, j)]); }
    }
  }
  const h = makeHull(pts, { maxVerts: maxV });
  return h && h.volume > 0 ? { pts, edges, h } : null;
}

/** The axis-aligned cut (3 axes x 7 positions) that removes the most hull volume, scored with one level of lookahead
 *  (a cut that removes little now can be the one that lets the next cut work: a table top off its legs). */
function bestSplit(it, maxV, depth) {
  const h = it.h;
  let best = null;
  for (let k = 0; k < 3; k++) {
    const L = h.hi[k] - h.lo[k];
    if (L < 1e-6) continue;
    for (const u of depth > 0 ? [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875] : [0.2, 0.5, 0.8]) {
      const sides = cutItem(it, k, h.lo[k] + u * L, maxV, depth === 0);
      if (!sides) continue;
      const g0 = (h.volume - sides[0].h.volume - sides[1].h.volume) / h.volume;
      let score = g0;
      if (depth > 0) {
        let la = 0;
        for (const sd of sides) { const nx = bestSplit(sd, maxV, depth - 1); if (nx) la = Math.max(la, nx.score * sd.h.volume / h.volume); }
        score = g0 + 0.5 * la;
      }
      if (!best || score > best.score + 1e-9) best = { score, gain: g0, sides, k };
    }
  }
  return best;
}

/** Cut a mesh item by the plane x_k = at: each side keeps its points, and every mesh edge crossing the plane adds its
 *  crossing point to both (the cut face, so a box cut in half gives two half boxes). null when a side is flat. */
function cutItem(it, k, at, maxV, quick = false) {
  const side = it.pts.map((p) => (p[k] < at ? -1 : 1));
  const A = [], B = [], ia = new Map(), ib = new Map();
  it.pts.forEach((p, i) => { if (side[i] < 0) { ia.set(i, A.length); A.push(p); } else { ib.set(i, B.length); B.push(p); } });
  const eA = [], eB = [];
  for (const [i, j] of it.edges) {
    if (side[i] === side[j]) { if (side[i] < 0) eA.push([ia.get(i), ia.get(j)]); else eB.push([ib.get(i), ib.get(j)]); continue; }
    const p = it.pts[i], q = it.pts[j], u = (at - p[k]) / (q[k] - p[k]);
    const x = [0, 1, 2].map((m) => p[m] + (q[m] - p[m]) * u);
    const [lo, hi] = side[i] < 0 ? [i, j] : [j, i];
    eA.push([ia.get(lo), A.length]); A.push(x);
    eB.push([ib.get(hi), B.length]); B.push(x);
  }
  const hA = quick ? hullVolume(A) : makeHull(A, { maxVerts: maxV }), hB = quick ? hullVolume(B) : makeHull(B, { maxVerts: maxV });
  if (!hA || !hB || !(hA.volume > 0) || !(hB.volume > 0)) return null;
  return [{ pts: A, edges: eA, h: hA }, { pts: B, edges: eB, h: hB }];
}

// ---------- GJK / EPA ----------
/** Support point of a vertex list along d. */
export function support(v, d) {
  let best = v[0], bd = -Infinity;
  for (const p of v) { const s = p[0] * d[0] + p[1] * d[1] + p[2] * d[2]; if (s > bd) { bd = s; best = p; } }
  return best;
}

/**
 * GJK: do two convex vertex sets (same frame) overlap? Returns {hit, simplex} where simplex holds the support points
 * [{p (A - B), a, b}] (a tetrahedron containing the origin when hit), for EPA.
 */
export function gjk(vA, vB, maxIter = 48) {
  const sup = (d) => { const a = support(vA, d), b = support(vB, scl(d, -1)); return { p: sub(a, b), a, b }; };
  let d = sub(vA[0], vB[0]);
  if (len(d) < 1e-12) d = [1, 0, 0];
  let S = [sup(d)];
  d = scl(S[0].p, -1);
  for (let it = 0; it < maxIter; it++) {
    if (len(d) < 1e-14) return { hit: true, simplex: fillSimplex(S, sup) };
    const P = sup(d);
    if (dot(P.p, d) < 0) return { hit: false, simplex: S };
    S = [P, ...S];
    const r = nearest(S);
    S = r.S; d = r.d;
    if (r.contains) return { hit: true, simplex: fillSimplex(S, sup) };
  }
  return { hit: false, simplex: S };
}

/** The sub-simplex nearest the origin and the next search direction (towards the origin). S[0] is the newest point. */
function nearest(S) {
  const A = S[0].p, AO = scl(A, -1);
  if (S.length === 2) {
    const AB = sub(S[1].p, A);
    if (dot(AB, AO) > 0) return { S, d: cross(cross(AB, AO), AB) };
    return { S: [S[0]], d: AO };
  }
  if (S.length === 3) {
    const B = S[1].p, C = S[2].p, AB = sub(B, A), AC = sub(C, A), ABC = cross(AB, AC);
    if (dot(cross(ABC, AC), AO) > 0) {
      if (dot(AC, AO) > 0) return { S: [S[0], S[2]], d: cross(cross(AC, AO), AC) };
      return nearest([S[0], S[1]]);
    }
    if (dot(cross(AB, ABC), AO) > 0) return nearest([S[0], S[1]]);
    if (dot(ABC, AO) > 0) return { S, d: ABC };
    return { S: [S[0], S[2], S[1]], d: scl(ABC, -1) };
  }
  // tetrahedron
  const B = S[1].p, C = S[2].p, D = S[3].p;
  const AB = sub(B, A), AC = sub(C, A), AD = sub(D, A);
  const ABC = cross(AB, AC), ACD = cross(AC, AD), ADB = cross(AD, AB);
  if (dot(ABC, AO) > 0) return nearest([S[0], S[1], S[2]]);
  if (dot(ACD, AO) > 0) return nearest([S[0], S[2], S[3]]);
  if (dot(ADB, AO) > 0) return nearest([S[0], S[3], S[1]]);
  return { S, d: [0, 0, 0], contains: true };
}

/** A degenerate simplex (the origin on a face or edge) grown to a tetrahedron for EPA. */
function fillSimplex(S, sup) {
  const out = S.slice();
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const d of dirs) {
    if (out.length >= 4) break;
    const P = sup(d);
    if (out.every((q) => len(sub(q.p, P.p)) > 1e-9)) {
      if (out.length === 3) {
        const n = cross(sub(out[1].p, out[0].p), sub(out[2].p, out[0].p));
        if (Math.abs(dot(n, sub(P.p, out[0].p))) < 1e-12) continue;
      }
      out.push(P);
    }
  }
  return out;
}

/**
 * EPA: penetration of two overlapping convex vertex sets from GJK's simplex. Returns {n (unit, the direction to move
 * B to separate it from A... i.e. A - B's closest face normal), depth, pA, pB (witness points on A and B, pA - pB =
 * depth · n)} or null. Moving A by -n·depth (or B by +n·depth) separates them.
 */
export function epa(vA, vB, simplex, maxIter = 48) {
  if (!simplex || simplex.length < 4) return null;
  const sup = (d) => { const a = support(vA, d), b = support(vB, scl(d, -1)); return { p: sub(a, b), a, b }; };
  const P = simplex.slice(0, 4);
  let F = [];
  const face = (i, j, k) => {
    let n = cross(sub(P[j].p, P[i].p), sub(P[k].p, P[i].p));
    const l = len(n);
    if (l < 1e-14) return null;
    n = scl(n, 1 / l);
    let d = dot(n, P[i].p);
    if (d < 0) { n = scl(n, -1); d = -d; return { i, j: k, k: j, n, d }; }
    return { i, j, k, n, d };
  };
  for (const [i, j, k] of [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]) { const f = face(i, j, k); if (f) F.push(f); }
  if (!F.length) return null;
  let bestF = null;
  for (let it = 0; it < maxIter; it++) {
    bestF = F.reduce((m, f) => (f.d < m.d ? f : m), F[0]);
    const S = sup(bestF.n), sd = dot(S.p, bestF.n);
    if (sd - bestF.d < 1e-6 * Math.max(1, bestF.d) + 1e-9) break;
    const idx = P.length; P.push(S);
    const vis = F.filter((f) => dot(f.n, sub(S.p, P[f.i].p)) > 1e-12);
    const edges = new Map();
    for (const f of vis) for (const [a, b] of [[f.i, f.j], [f.j, f.k], [f.k, f.i]]) {
      const rk = `${b},${a}`;
      if (edges.has(rk)) edges.delete(rk); else edges.set(`${a},${b}`, [a, b]);
    }
    F = F.filter((f) => !vis.includes(f));
    for (const [a, b] of edges.values()) { const f = face(a, b, idx); if (f) F.push(f); }
    if (!F.length) return null;
  }
  const f = bestF;
  // Barycentric coordinates of the origin's projection on the face, for the witness points.
  const pr = scl(f.n, f.d), A = P[f.i], B = P[f.j], C = P[f.k];
  const v0 = sub(B.p, A.p), v1 = sub(C.p, A.p), v2 = sub(pr, A.p);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01 || 1e-30;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
  const pA = add(add(scl(A.a, u), scl(B.a, v)), scl(C.a, w)), pB = add(add(scl(A.b, u), scl(B.b, v)), scl(C.b, w));
  return { n: f.n, depth: f.d, pA, pB };
}

// ---------- contacts for the XPBD solver ----------
// Bodies (physics.mjs makeBody): {x, q, hulls: [{v, p (probe points), planes, w, c, r}] in the body frame (relative to
// its centre of mass)}. A contact pushes body a along +n and body b along -n, like every other contact type there.

/** A body's rotation matrix (rows), cached against its quaternion array (the same cache physics.mjs rotOf() fills). */
function rotB(b) {
  if (b._rq === b.q) return b._R;
  b._R = rotMat(b.q); b._rq = b.q;
  return b._R;
}
function rotMat(q) {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const mtv = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];

/** Most a hull contact pushes per solver pass (m): a deep overlap (a fast splinter half through a board) comes out over a
 *  few substeps instead of in one, which would fling it (PhysX's max depenetration velocity, in position form). */
export const MAX_PUSH = 0.012;

/** "ph": a vertex (lp, body frame) of a inside hull hb of b, pushed out through plane k of hb. */
export function measurePH(c) {
  const A = c.a, B = c.b, RA = rotB(A), RB = rotB(B), lp = c.lp, P = c.hb.planes[c.k];
  const px = A.x[0] + RA[0] * lp[0] + RA[1] * lp[1] + RA[2] * lp[2], py = A.x[1] + RA[3] * lp[0] + RA[4] * lp[1] + RA[5] * lp[2],
    pz = A.x[2] + RA[6] * lp[0] + RA[7] * lp[1] + RA[8] * lp[2];
  // the plane's normal in the world, and the point's height over it
  const nx = RB[0] * P[0] + RB[1] * P[1] + RB[2] * P[2], ny = RB[3] * P[0] + RB[4] * P[1] + RB[5] * P[2], nz = RB[6] * P[0] + RB[7] * P[1] + RB[8] * P[2];
  const d = Math.min(MAX_PUSH, P[3] - (nx * (px - B.x[0]) + ny * (py - B.x[1]) + nz * (pz - B.x[2])));
  c.d = d; c.n = [nx, ny, nz]; c.pA = [px, py, pz]; c.pB = [px + nx * d, py + ny * d, pz + nz * d];
  return c;
}
/** "hx": GJK/EPA witness points (lA on a, lB on b, body frames) along normal nB (b's frame). */
export function measureHX(c) {
  const A = c.a, B = c.b, RA = rotB(A), RB = rotB(B);
  c.pA = add(A.x, mv(RA, c.lA)); c.pB = add(B.x, mv(RB, c.lB)); c.n = mv(RB, c.nB);
  c.d = Math.min(MAX_PUSH, dot(sub(c.pB, c.pA), c.n));
  return c;
}

/** The hulls of a body: its own (a hull body) or its box as a hull (box probes: the 3x3x3 surface lattice). */
export function hullsOf(b) {
  if (b.hulls) return b.hulls;
  const h = boxHull(b.half);
  h.p = b.probes?.length ? b.probes : h.v;
  b.hulls = [h];
  return b.hulls;
}

/**
 * Contacts between two hull (or box-as-hull) bodies, every sub-hull pair whose spheres touch: A's vertices in B's
 * hulls and B's in A's ("ph"), and one GJK/EPA contact ("hx") for a pair that overlaps with no vertex inside (two
 * edges crossing). spec: speculative margin (m), as for the box probes.
 */
export function hullContacts(A, B, out, spec = 0.01, SPEC0 = 0.01) {
  const HA = hullsOf(A), HB = hullsOf(B);
  const RA = rotB(A), RB = rotB(B);
  for (const ha of HA) {
    const ca = add(A.x, mv(RA, ha.c));
    for (const hb of HB) {
      const cb = add(B.x, mv(RB, hb.c)), dc = sub(ca, cb);
      const R = ha.r + hb.r + spec;
      if (dot(dc, dc) > R * R) continue;
      const n0 = out.length;
      // Separating-axis test over both hulls' face planes first: a gap on any face axis means no contact. The
      // shallower side picks which hull's vertices probe the other (a car's corner inside a thin board must not push
      // the board out along its length); if that side finds no vertex inside, the other side tries.
      const fa = satFaces(A, ha, RA, B, hb, RB, spec), fb = fa && satFaces(B, hb, RB, A, ha, RA, spec);
      if (!fa || !fb) continue;
      // The face with the least overlap is the reference face; the other hull's most anti-parallel face is clipped to
      // it (Sutherland-Hodgman, as Bullet's polyhedral contact clipping does): a manifold of up to a polygon's corners,
      // so a board lying across a car's bonnet rests on its edges, not on one point.
      const first = fa.o <= fb.o ? 0 : 1;
      if (first === 0) clipContacts(A, ha, RA, B, hb, RB, fa.k, out, spec, fa.o);
      else clipContacts(B, hb, RB, A, ha, RA, fb.k, out, spec, fb.o);
      if (out.length === n0) for (const side of first ? [1, 0] : [0, 1]) {
        if (side === 0) probeHull(A, ha, RA, B, hb, RB, out, spec, SPEC0, fa);
        else probeHull(B, hb, RB, A, ha, RA, out, spec, SPEC0, fb);
        if (out.length > n0) break;
      }
      if (out.length > n0) continue;
      // Overlapping on every face axis but no vertex inside: edges crossing. GJK says whether they really touch.
      const vA = ha.v.map((p) => add(A.x, mv(RA, p))), vB = hb.v.map((p) => add(B.x, mv(RB, p)));
      const g = gjk(vA, vB);
      if (!g.hit) continue;
      const e = epa(vA, vB, g.simplex);
      if (!e || !(e.depth > 0)) continue;
      // Move A by -n to separate: the contact pushes A along +n, so its n is -e.n (in B's frame for re-measuring).
      const nW = scl(e.n, -1);
      const c = { type: "hx", a: A, b: B, lA: mtv(RA, sub(e.pA, A.x)), lB: mtv(RB, sub(e.pB, B.x)), nB: mtv(RB, nW), fn: measureHX };
      measureHX(c);
      if (c.d > 0) out.push(c);
    }
  }
}

/**
 * A's hull ha against B's hull hb: returns true when one of hb's face planes separates them (no contact at all);
 * otherwise pushes a "ph" contact for each probe point of ha inside hb, through hb's face that separates them the least
 * (a probe deeper than half the hull uses its own nearest face, as the box probes do).
 */
/**
 * How far A's hull ha reaches past each of hb's face planes (inwards): {k (the least), o (that overlap), toB (A's frame
 * to B's)}, or null when a plane separates them (beyond the margin).
 */
function satFaces(A, ha, RA, B, hb, RB, spec) {
  // Each of B's planes into A's frame once (n_A = Rᵀ n, offset by A's centre), then plain dot products over A's
  // vertices: no per-vertex transforms (Milestone 27 speed-up).
  const t = mtv(RB, sub(A.x, B.x)), R = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(RB[i] * RA[j] + RB[3 + i] * RA[3 + j] + RB[6 + i] * RA[6 + j]);
  const P = hb.planes, V = ha.v, nv = V.length;
  let k = -1, oMin = Infinity;
  for (let i = 0; i < P.length; i++) {
    const pl = P[i];
    const m0 = R[0] * pl[0] + R[3] * pl[1] + R[6] * pl[2], m1 = R[1] * pl[0] + R[4] * pl[1] + R[7] * pl[2], m2 = R[2] * pl[0] + R[5] * pl[1] + R[8] * pl[2];
    let mn = Infinity;
    for (let j = 0; j < nv; j++) { const p = V[j], s = m0 * p[0] + m1 * p[1] + m2 * p[2]; if (s < mn) mn = s; }
    const o = pl[3] - (mn + pl[0] * t[0] + pl[1] * t[1] + pl[2] * t[2]);
    if (o < -spec) return null;
    if (o < oMin) { oMin = o; k = i; }
  }
  const toB = (p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0], R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1], R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2]];
  return { k, o: oMin, toB };
}

/**
 * A "ph" contact for each probe point of A's hull ha inside B's hull hb, pushed out through hb's face that separates
 * them the least (a probe deeper than half the hull uses its own nearest face, as the box probes do). Returns true
 * when one of hb's face planes separates them.
 */
function probeHull(A, ha, RA, B, hb, RB, out, spec, SPEC0, sat = null) {
  sat ||= satFaces(A, ha, RA, B, hb, RB, spec);
  if (!sat) return true;
  const P = hb.planes, nP = P.length, toB = sat.toB, kMin = sat.k;
  const probes = ha.p || ha.v;
  for (const lp of probes) {
    const l = toB(lp);
    let worst = -Infinity, kW = 0;
    for (let k = 0; k < nP; k++) { const s = P[k][0] * l[0] + P[k][1] * l[1] + P[k][2] * l[2] - P[k][3]; if (s > worst) { worst = s; kW = k; } }
    if (worst >= spec) continue;   // outside (beyond the speculative margin)
    let k = kMin;
    const sK = P[k][0] * l[0] + P[k][1] * l[1] + P[k][2] * l[2] - P[k][3];
    if (-sK > 0.5 * hb.w[k]) k = kW;   // deeper than half the hull through that face: its own nearest face
    // Wide speculative margin (a fast keyed mover): a probe outside a face other than the one it would be pushed
    // through is beside the hull, not about to hit it.
    if (spec > SPEC0 && P.some((pl, i) => i !== k && pl[0] * l[0] + pl[1] * l[1] + pl[2] * l[2] - pl[3] > 0)) continue;
    out.push({ type: "ph", a: A, b: B, lp, k, hb, fn: measurePH });
  }
  return false;
}

/**
 * Clip incident hull I's face most opposed to reference plane k of hull H (body Rb) against that face's side planes;
 * every clipped point under the plane (within the margin) becomes a "ph" contact: a point of I (in its frame)
 * pushed out through plane k.
 */
function clipContacts(I, hi, RI, Rb, hr, RR, k, out, spec, oMax = Infinity) {
  const P = hr.planes[k], nW = mv(RR, P), poly = hr.fp?.[k];
  if (!poly || poly.length < 3) return;
  // incident face: the most anti-parallel of I's planes
  let best = -1, bd = Infinity;
  hi.planes.forEach((Q, i) => { const d = dot(mv(RI, Q), nW); if (d < bd) { bd = d; best = i; } });
  const ip = hi.fp?.[best];
  if (!ip || ip.length < 3) return;
  let pts = ip.map((i) => add(I.x, mv(RI, hi.v[i])));
  const ref = poly.map((i) => add(Rb.x, mv(RR, hr.v[i])));
  for (let e = 0; e < ref.length && pts.length; e++) {
    const a = ref[e], b = ref[(e + 1) % ref.length], sn = cross(sub(b, a), nW);   // outward side normal
    const nxt = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length], dp = dot(sn, sub(p, a)), dq = dot(sn, sub(q, a));
      if (dp <= 0) nxt.push(p);
      if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) nxt.push(add(p, scl(sub(q, p), dp / (dp - dq))));
    }
    pts = nxt;
  }
  const dRef = dot(nW, ref[0]);
  // Not past the overlap the separating-axis test measured (a long face clipped to a thin board's face would otherwise
  // reach points far behind the board, outside it).
  let keep = pts.filter((p) => { const depth = dRef - dot(nW, p); return depth >= -spec && depth <= oMax + 1e-6; });
  if (keep.length > 4) keep = reduceManifold(keep, nW, dRef);
  for (const p of keep) out.push({ type: "ph", a: I, b: Rb, lp: mtv(RI, sub(p, I.x)), k, hb: hr, fn: measurePH });
}

/** Four points of a contact polygon, as Bullet keeps them: the deepest, the one farthest from it, then the two that span
 *  the most area on either side of that line. */
function reduceManifold(pts, n, dRef) {
  let a = 0;
  pts.forEach((p, i) => { if (dRef - dot(n, p) > dRef - dot(n, pts[a])) a = i; });
  let b = -1, bd = -1;
  pts.forEach((p, i) => { const d = len(sub(p, pts[a])); if (i !== a && d > bd) { bd = d; b = i; } });
  const ab = sub(pts[b], pts[a]);
  let c = -1, d = -1, cMax = 0, dMin = 0;
  pts.forEach((p, i) => {
    if (i === a || i === b) return;
    const s = dot(cross(ab, sub(p, pts[a])), n);
    if (s > cMax) { cMax = s; c = i; }
    if (s < dMin) { dMin = s; d = i; }
  });
  return [a, b, c, d].filter((i) => i >= 0).map((i) => pts[i]);
}

/** True when no sub-hull of A overlaps any of B's (a face plane of one separates them): pieces of one prop that have come apart. */
export function hullsSeparate(A, B, margin = 0) {
  const HA = hullsOf(A), HB = hullsOf(B), RA = rotB(A), RB = rotB(B);
  for (const ha of HA) for (const hb of HB) {
    const ca = add(A.x, mv(RA, ha.c)), cb = add(B.x, mv(RB, hb.c)), dc = sub(ca, cb), R = ha.r + hb.r + margin;
    if (dot(dc, dc) > R * R) continue;
    if (!satFaces(A, ha, RA, B, hb, RB, -margin) || !satFaces(B, hb, RB, A, ha, RA, -margin)) continue;
    return false;
  }
  return true;
}

/** Sphere (centre x, radius r) against a body's hulls: a contact through the face it is least inside / nearest, or none. */
export function sphereHullContacts(S, B, out) {
  const RB = rotB(B), l = mtv(RB, sub(S.x, B.x));
  for (const hb of hullsOf(B)) {
    let worst = -Infinity, k = 0;
    hb.planes.forEach((P, i) => { const s = P[0] * l[0] + P[1] * l[1] + P[2] * l[2] - P[3]; if (s > worst) { worst = s; k = i; } });
    if (worst >= S.r) continue;
    const c = { type: "sh", a: S, b: B, k, hb, fn: measureSH };
    measureSH(c);
    if (c.d > 0) out.push(c);
  }
}
export function measureSH(c) {
  const S = c.a, B = c.b, RB = rotB(B), l = mtv(RB, sub(S.x, B.x)), P = c.hb.planes[c.k];
  const s = P[0] * l[0] + P[1] * l[1] + P[2] * l[2] - P[3];
  c.n = mv(RB, P); c.d = S.r - s; c.pA = sub(S.x, scl(c.n, S.r)); c.pB = sub(S.x, scl(c.n, s));
  return c;
}

/** Ray against a hull body (each hull's planes, slab-style): {point, normal, distance} or null. */
export function rayHulls(b, o, d) {
  const RB = rotB(b), lo = mtv(RB, sub(o, b.x)), ld = mtv(RB, d);
  let best = null;
  for (const h of hullsOf(b)) {
    let t0 = -Infinity, t1 = Infinity, nk = -1;
    for (let k = 0; k < h.planes.length; k++) {
      const P = h.planes[k], dn = P[0] * ld[0] + P[1] * ld[1] + P[2] * ld[2], s = P[3] - (P[0] * lo[0] + P[1] * lo[1] + P[2] * lo[2]);
      if (Math.abs(dn) < 1e-12) { if (s < 0) { t0 = Infinity; break; } continue; }
      const t = s / dn;
      if (dn < 0) { if (t > t0) { t0 = t; nk = k; } } else t1 = Math.min(t1, t);
      if (t0 > t1) break;
    }
    if (t0 > t1 || t0 < 0 || nk < 0 || !Number.isFinite(t0)) continue;
    if (!best || t0 < best.distance) best = { point: add(o, scl(d, t0)), normal: mv(RB, h.planes[nk]), distance: t0 };
  }
  return best;
}

/**
 * A car body's collision hull (Milestone 27): its box with a raked nose and tail (the bumper's top, then the bonnet
 * sloping up) and corners rounded off in plan, so a crate or a board it drives into rides up over the bonnet or slides
 * off the side, as on a real car, instead of being bulldozed ahead of a flat wall. half / center: the body box (object
 * frame). Point list (makeHull it, or pass it as a hull spec).
 */
export function vehicleBodyPoints(half, center = [0, 0, 0]) {
  const [hx, hy, hz] = half, [cx, cy, cz] = center, out = [];
  const y0 = cy - hy, y1 = cy + hy, H = y1 - y0;
  for (const s of [1, -1]) {   // nose (+z) and tail (-z)
    const zEnd = cz + s * hz, zIn = cz + s * (hz - Math.min(0.3, 0.14 * hz)), zTop = cz + s * (hz - Math.min(0.8, 0.36 * hz));
    for (const x of [-1, 1]) {
      out.push([cx + x * hx * 0.84, y0 + 0.1 * H, zEnd]);   // under the bumper, rounded in plan
      out.push([cx + x * hx * 0.84, y0 + 0.4 * H, zEnd]);   // the bumper's top
      out.push([cx + x * hx, y0 + 0.75 * H, zIn]);   // the raked fascia up to the bonnet's edge
      out.push([cx + x * hx, y1, zTop]);   // the bonnet
      out.push([cx + x * hx, y0, zIn]);
    }
  }
  return out;
}
