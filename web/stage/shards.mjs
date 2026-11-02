// Soundstage shard render geometry (Milestone 27): simulate the hulls, show the breakage.
//
// The solver moves each fracture cell as a clean convex hull (fast, stable contacts). What the clay and Color guides
// show, and so what LTX paints, is a detailed mesh made from that cell: its outer faces stay flat (the board's own
// surface), and its cut faces, where it broke, are torn up. Wood: cut faces across the grain end in splinter needles
// pulled out along the grain, cut faces along the grain are ridged like split timber, and every broken edge is ragged.
// Cardboard: torn edges zig-zag in the panel's plane and the cut face is fibrous. This is Houdini's proxy / render
// geometry split (RBD Material Fracture's "detail" output and its interior noise), done per piece, seeded.
// Pure function, no three.js: it returns plain arrays the stage turns into a BufferGeometry.

import { clipPoly } from "./fracture.mjs";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Stable value noise in [-1, 1] at a point (sin-hash lattice, trilinear). */
function vnoise(p, seed) {
  const h = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 13.37) * 43758.5453; return 2 * (s - Math.floor(s)) - 1; };
  const x0 = Math.floor(p[0]), y0 = Math.floor(p[1]), z0 = Math.floor(p[2]);
  const fx = p[0] - x0, fy = p[1] - y0, fz = p[2] - z0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let v = 0;
  for (const [dx, wx] of [[0, 1 - sx], [1, sx]]) for (const [dy, wy] of [[0, 1 - sy], [1, sy]]) for (const [dz, wz] of [[0, 1 - sz], [1, sz]]) {
    v += wx * wy * wz * h(x0 + dx, y0 + dy, z0 + dz);
  }
  return v;
}

/** Detail settings per material: edge subdivision (m), jag amplitude (m), splinters. */
export const SHARD_STYLE = Object.freeze({
  wood: Object.freeze({ seg: 0.02, jag: 0.022, ridge: 0.008, splinters: [4, 9], splinterLen: [0.05, 0.2], splinterW: [0.006, 0.014], board: 0.15, seam: 0.008 }),
  cardboard: Object.freeze({ seg: 0.014, jag: 0.009, ridge: 0.0015, splinters: [0, 0], splinterLen: [0, 0], splinterW: [0, 0] }),
});

/**
 * The render mesh of one fracture piece. piece: {v (vertices, prop frame), faces: [{idx, tag: "out" | "cut"}], off
 * (its centroid: the mesh is built relative to it), grain (unit), normal}; opts: {material, seed}.
 * Returns {positions: number[] (xyz), indices: number[], cut: number (cut faces), splinters: number}.
 */
export function shardGeometry(piece, opts = {}) {
  const st = SHARD_STYLE[opts.material] || SHARD_STYLE.wood;
  // A wide wood cell is drawn as the boards it is made of (seams every ~15 cm across the grain, 8 mm gaps): the
  // collision cell is one hull, the picture is a crate's planks.
  const B = piece.boards;
  if (st.board && B && B[4] - B[3] > 1.6 * st.board) {
    const dir = [B[0], B[1], B[2]], n = Math.max(2, Math.round((B[4] - B[3]) / st.board)), w = (B[4] - B[3]) / n;
    const o = piece.off || [0, 0, 0];
    let faces = piece.faces.map((f) => ({ pts: f.idx.map((i) => sub(piece.v[i], o)), tag: f.tag }));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const lo = B[3] + i * w + (i ? st.seam / 2 : 0), hi = B[3] + (i + 1) * w - (i < n - 1 ? st.seam / 2 : 0);
      let f = clipPoly(faces, dir, hi, "out");
      if (f) f = clipPoly(f, scl(dir, -1), -lo, "out");
      if (f) parts.push(polyPiece(f, piece));
    }
    if (parts.length > 1) {
      const out = { positions: [], indices: [], cut: 0, splinters: 0 };
      parts.forEach((pp, k) => {
        const g = shardGeometry({ ...pp, boards: null }, { ...opts, seed: (+opts.seed || 1) + 31 * k });
        const base = out.positions.length / 3;
        out.positions.push(...g.positions); out.indices.push(...g.indices.map((x) => x + base));
        out.cut += g.cut; out.splinters += g.splinters;
      });
      return out;
    }
  }
  return detailGeometry(piece, opts, st);
}

/** A clipped polyhedron ({pts, tag} faces, relative to the piece centre) as a piece: shared vertices, index loops. */
function polyPiece(faces, piece) {
  const v = [], idxOf = (p) => { for (let i = 0; i < v.length; i++) if (len(sub(v[i], p)) < 1e-7) return i; v.push(p); return v.length - 1; };
  const F = [];
  for (const f of faces) {
    const idx = [];
    for (const p of f.pts) { const i = idxOf(p); if (idx[idx.length - 1] !== i && idx[0] !== i) idx.push(i); }
    if (idx.length >= 3) F.push({ idx, tag: f.tag });
  }
  return { v, faces: F, off: [0, 0, 0], grain: piece.grain, normal: piece.normal };
}

function detailGeometry(piece, opts, st) {
  const seed = +opts.seed || 1, wood = st !== SHARD_STYLE.cardboard;
  const o = piece.off || [0, 0, 0], grain = piece.grain || [1, 0, 0];
  const V = piece.v.map((p) => sub(p, o));
  const faces = piece.faces.filter((f) => f.idx.length >= 3);
  const fN = faces.map((f) => {
    let n = [0, 0, 0];
    for (let i = 1; i + 1 < f.idx.length; i++) n = add(n, cross(sub(V[f.idx[i]], V[f.idx[0]]), sub(V[f.idx[i + 1]], V[f.idx[0]])));
    return norm(n);
  });
  // Which faces meet at each edge (for the ragged-edge direction).
  const edgeFaces = new Map();
  const ek = (a, b) => (a < b ? `${a}/${b}` : `${b}/${a}`);
  faces.forEach((f, fi) => f.idx.forEach((a, i) => { const b = f.idx[(i + 1) % f.idx.length], k = ek(a, b); if (!edgeFaces.has(k)) edgeFaces.set(k, []); edgeFaces.get(k).push(fi); }));
  const pos = V.map((p) => [...p]);
  const idx = [];
  const edgePts = new Map();   // edge key -> point indices along it (from the lower vertex index to the higher)
  // Displacement for a point on an edge: in the plane of an outer face, away from the cut (a torn, ragged outline).
  const jagAt = (p, k) => {
    const fs = edgeFaces.get(k) || [];
    const cut = fs.filter((fi) => faces[fi].tag === "cut"), out = fs.filter((fi) => faces[fi].tag !== "cut");
    if (!cut.length) return [0, 0, 0];
    let dir;
    if (out.length) { const nO = fN[out[0]], nC = fN[cut[0]]; dir = norm(sub(nC, scl(nO, dot(nC, nO)))); }
    else dir = norm(cut.reduce((s, fi) => add(s, fN[fi]), [0, 0, 0]));
    const f = wood ? 34 : 60, a = st.jag * (0.45 + 0.55 * vnoise(scl(p, f), seed)) * (wood ? 1 : 0.8 + 0.4 * Math.sin(p[0] * 220 + p[2] * 190 + seed));
    return scl(dir, a);
  };
  const edgeChain = (a, b) => {
    const k = ek(a, b), lo = Math.min(a, b), hi = Math.max(a, b);
    if (!edgePts.has(k)) {
      const fs = edgeFaces.get(k) || [], cutEdge = fs.some((fi) => faces[fi].tag === "cut");
      const L = len(sub(V[hi], V[lo])), n = cutEdge ? Math.max(1, Math.min(10, Math.ceil(L / st.seg))) : 1;
      const chain = [lo];
      for (let i = 1; i < n; i++) {
        const p = add(V[lo], scl(sub(V[hi], V[lo]), i / n));
        pos.push(add(p, jagAt(p, k)));
        chain.push(pos.length - 1);
      }
      chain.push(hi);
      edgePts.set(k, chain);
    }
    const c = edgePts.get(k);
    return a === lo ? c : [...c].reverse();
  };
  let cutFaces = 0, splinters = 0;
  faces.forEach((f, fi) => {
    const loop = [];
    f.idx.forEach((a, i) => { const b = f.idx[(i + 1) % f.idx.length], ch = edgeChain(a, b); loop.push(...ch.slice(0, -1)); });
    const n = fN[fi];
    if (f.tag !== "cut" && loop.length === f.idx.length) {   // a plain outer face: a fan
      for (let i = 1; i + 1 < loop.length; i++) idx.push(loop[0], loop[i], loop[i + 1]);
      return;
    }
    // A ring inside the outline and the centre: room for the cut face's relief.
    const c = scl(loop.reduce((s, i) => add(s, pos[i]), [0, 0, 0]), 1 / loop.length);
    const isCut = f.tag === "cut";
    if (isCut) cutFaces++;
    const across = Math.abs(dot(n, grain));   // 1: the face cuts across the grain (a snapped board end)
    const relief = (p) => {
      if (!isCut) return [0, 0, 0];
      // Split timber: ridges running along the grain; a snapped end: deep, irregular tearing.
      const g = grain, ridge = wood ? Math.sin(dot(p, cross(n, g)) * 260 + seed) * st.ridge * (1 - across) : 0;
      const tear = vnoise(scl(p, wood ? 45 : 70), seed + 7) * st.jag * (wood ? 0.5 + 1.2 * across : 0.5);
      return scl(n, ridge + tear);
    };
    const ring = loop.map((i) => { const p = add(c, scl(sub(pos[i], c), 0.55)); pos.push(add(p, relief(p))); return pos.length - 1; });
    pos.push(add(c, relief(c)));
    const ci = pos.length - 1;
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      idx.push(loop[i], loop[j], ring[j], loop[i], ring[j], ring[i], ci, ring[i], ring[j]);
    }
    // Splinters: needles pulled out of a wood face that broke across the grain, pointing along the grain.
    if (isCut && wood && across > 0.45) {
      const [n0, n1] = st.splinters, count = n0 + Math.floor(h01(seed, fi, 3) * (n1 - n0 + 1));
      const out = dot(n, grain) >= 0 ? grain : scl(grain, -1);
      const t1 = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), t2 = cross(n, t1);
      let rad = 0;
      for (const i of loop) rad = Math.max(rad, len(sub(pos[i], c)));
      for (let s = 0; s < count; s++) {
        const a = 6.283 * h01(seed, fi * 17 + s, 5), r = rad * 0.75 * Math.sqrt(h01(seed, fi * 17 + s, 6));
        const base = add(c, add(scl(t1, Math.cos(a) * r), scl(t2, Math.sin(a) * r)));
        const L = st.splinterLen[0] + (st.splinterLen[1] - st.splinterLen[0]) * h01(seed, fi * 17 + s, 7) ** 1.5;
        const W = st.splinterW[0] + (st.splinterW[1] - st.splinterW[0]) * h01(seed, fi * 17 + s, 8);
        // A thin three-sided needle, a little off the grain line.
        const tipDir = norm(add(out, scl(add(scl(t1, h01(seed, s, 9) - 0.5), scl(t2, h01(seed, s, 10) - 0.5)), 0.35)));
        const tip = add(base, scl(tipDir, L));
        const b0 = pos.length;
        for (let k = 0; k < 3; k++) {
          const ang = a + k * 2.094;
          pos.push(add(sub(base, scl(tipDir, 0.004)), add(scl(t1, Math.cos(ang) * W), scl(t2, Math.sin(ang) * W * 0.45))));
        }
        pos.push(tip);
        const T = b0 + 3;
        idx.push(b0, b0 + 1, T, b0 + 1, b0 + 2, T, b0 + 2, b0, T, b0 + 2, b0 + 1, b0);
        splinters++;
      }
    }
  });
  return { positions: pos.flat().map((v) => +v.toFixed(5)), indices: idx, cut: cutFaces, splinters };
}

function h01(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
