// Static collision proxies for an imported world (Milestone 12). The physics engines (physengine.mjs) collide boxes
// and spheres, so a world's meshes become boxes:
//   * a prop-sized mesh (a table, a crate, a car) -> one box, turned to the mesh's own heading;
//   * a big mesh (a room shell, a floor, a terrain, a building) -> its flat parts become thin slabs: triangles are
//     grouped by plane, each plane is rasterised onto a grid and covered with rectangles, so a wall with a door in it
//     becomes boxes around the doorway and people still walk through;
//   * what is left (curved or broken-up surfaces) -> height columns on a coarse grid (terrain) or voxel boxes.
// Pure JS on plain arrays, so it runs in node tests. Boxes: {half: [hx, hy, hz], pos: [x, y, z], quat: [x, y, z, w]}.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Quaternion [x, y, z, w] of the rotation whose columns are the axes ax, ay, az (orthonormal, right-handed). */
export function quatFromAxes(ax, ay, az) {
  const m00 = ax[0], m10 = ax[1], m20 = ax[2], m01 = ay[0], m11 = ay[1], m21 = ay[2], m02 = az[0], m12 = az[1], m22 = az[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

/** Bounding box of a flat [x0, y0, z0, x1, ...] array. */
export function bounds(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = pos[i + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  return { min, max };
}

/** One box around a prop, turned to its principal heading (yaw from the XZ spread of its points). */
export function propBox(pos) {
  const n = pos.length / 3;
  if (!n) return null;
  let mx = 0, mz = 0;
  for (let i = 0; i < pos.length; i += 3) { mx += pos[i]; mz += pos[i + 2]; }
  mx /= n; mz /= n;
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < pos.length; i += 3) { const dx = pos[i] - mx, dz = pos[i + 2] - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  // Pick the better of the PCA heading and plain axis alignment (PCA wanders on near-square footprints).
  const candidates = [0, 0.5 * Math.atan2(2 * sxz, sxx - szz)];
  let best = null;
  for (const yaw of candidates) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], z = pos[i + 2], u = x * c + z * s, v = -x * s + z * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      const y = pos[i + 1]; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area * 0.97) best = { area, yaw, u0, u1, v0, v1, y0, y1 };
  }
  const { yaw, u0, u1, v0, v1, y0, y1 } = best;
  const c = Math.cos(yaw), s = Math.sin(yaw), uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  // The box's local +X is (c, 0, s) in the world: a rotation of -yaw about +Y.
  return { half: [Math.max(0.01, (u1 - u0) / 2), Math.max(0.01, (y1 - y0) / 2), Math.max(0.01, (v1 - v0) / 2)],
    pos: [uc * c - vc * s, (y0 + y1) / 2, uc * s + vc * c], quat: [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)] };
}

/** Cover the occupied cells of a W x H grid (row-major Uint8Array) with rectangles [i0, j0, i1, j1] (inclusive). */
export function greedyRects(grid, W, H) {
  const used = new Uint8Array(W * H), out = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!grid[k] || used[k]) continue;
    let i1 = i;
    while (i1 + 1 < W && grid[j * W + i1 + 1] && !used[j * W + i1 + 1]) i1++;
    let j1 = j;
    for (;;) {
      if (j1 + 1 >= H) break;
      let ok = true;
      for (let x = i; x <= i1; x++) { const q = (j1 + 1) * W + x; if (!grid[q] || used[q]) { ok = false; break; } }
      if (!ok) break;
      j1++;
    }
    for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) used[y * W + x] = 1;
    out.push([i, j, i1, j1]);
  }
  return out;
}

// Snap a normal onto the world axes when it is within ~6 degrees of one, else to a coarse direction grid.
function planeNormal(n) {
  for (let k = 0; k < 3; k++) if (Math.abs(n[k]) > 0.9945) { const a = [0, 0, 0]; a[k] = Math.sign(n[k]); return a; }
  return norm(n.map((v) => Math.round(v * 24) / 24));
}

/**
 * Boxes for one big mesh's world-space triangles (flat [ax, ay, az, bx, ...], 9 floats a triangle).
 * opts: {cell (grid size, m), thickness (floor slab, m), wall (wall slab, m), minArea (m²)}.
 */
export function planarBoxes(tris, { cell = 0.25, thickness = 0.3, wall = 0.15, minArea = 0.25, maxCells = 160000, pairMax = 0.8 } = {}) {
  const groups = new Map();
  const leftovers = [];
  const nTri = tris.length / 9;
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const a = [tris[o], tris[o + 1], tris[o + 2]], b = [tris[o + 3], tris[o + 4], tris[o + 5]], c = [tris[o + 6], tris[o + 7], tris[o + 8]];
    const cr = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const area2 = Math.hypot(...cr);
    if (area2 < 1e-10) continue;
    const n = planeNormal([cr[0] / area2, cr[1] / area2, cr[2] / area2]);
    const d = (dot(n, a) + dot(n, b) + dot(n, c)) / 3;
    // Flat enough to belong to this plane? (curved surfaces leave their triangles to the fallback)
    const dev = Math.max(Math.abs(dot(n, a) - d), Math.abs(dot(n, b) - d), Math.abs(dot(n, c) - d));
    if (dev > 0.05) { leftovers.push(o); continue; }
    const key = `${n[0]},${n[1]},${n[2]}|${Math.round(d / 0.04)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { n, d: 0, area: 0, tris: [] }));
    g.area += area2 / 2;
    g.d += d * area2 / 2;
    g.tris.push(o);
  }
  // Merge neighbouring offset bins of the same normal (a plane straddling a bin edge).
  const byNormal = new Map();
  for (const g of groups.values()) {
    g.d /= g.area || 1;
    const k = g.n.join(",");
    if (!byNormal.has(k)) byNormal.set(k, []);
    byNormal.get(k).push(g);
  }
  const planes = [];
  for (const list of byNormal.values()) {
    list.sort((p, q) => p.d - q.d);
    let cur = null;
    for (const g of list) {
      if (cur && g.d - cur.d < 0.06) { cur.d = (cur.d * cur.area + g.d * g.area) / (cur.area + g.area); cur.area += g.area; cur.tris.push(...g.tris); }
      else { cur = { ...g, tris: [...g.tris] }; planes.push(cur); }
    }
  }
  // Terrain and other curved surfaces split into many little "planes": hand their up-facing bits to the height
  // columns below instead of making a slab per triangle.
  const bits = planes.filter((p) => p.n[1] > 0.5 && p.area < 4);
  if (bits.length > 40) for (const P of bits) { leftovers.push(...P.tris); P.done = true; }
  // A solid's two faces (a wall's sides, a floor's top and bottom): one slab exactly as thick as the solid, made once.
  // Without this a thin floor's underside grows its slab up through the floor.
  planes.sort((a, b) => b.n[1] - a.n[1]);   // up-facing surfaces claim the pair, so a floor reads as a floor
  for (const P of planes) {
    P.bb = bounds(Float32Array.from(P.tris.flatMap((o) => Array.from(tris.subarray(o, o + 9)))));
  }
  const overlap = (a, b, n) => [0, 1, 2].every((k) => Math.abs(n[k]) > 0.9 || (a.min[k] < b.max[k] - 0.02 && b.min[k] < a.max[k] - 0.02));
  for (const P of planes) {
    if (P.area < minArea || P.consumed || P.done) continue;
    let best = null;
    for (const Q of byNormal.get(P.n.map((v) => (v === 0 ? 0 : -v)).join(",")) ? planes : []) {
      if (Q === P || Q.consumed || Q.area < minArea || Math.abs(dot(Q.n, P.n) + 1) > 1e-6) continue;
      const gap = P.d + Q.d;   // Q's surface sits `gap` behind P's
      if (gap > 0.01 && gap <= pairMax && overlap(P.bb, Q.bb, P.n) && (!best || gap < best.gap)) best = { Q, gap };
    }
    if (best) { P.th = best.gap; best.Q.consumed = true; }
  }
  const boxes = [];
  for (const P of planes) {
    if (P.done || P.consumed) continue;
    if (P.area < minArea) { leftovers.push(...P.tris); continue; }
    const n = P.n;
    // An unpaired underside at or below the floor (the bottom of a floor slab, a wall's foot) only gets in the way.
    if (!P.th && n[1] < -0.7 && P.d > -0.05) continue;
    // In-plane axes: floors use world X; walls a horizontal axis, so their rectangles line up with doors and floors.
    let u;
    if (Math.abs(n[1]) > 0.7) { u = norm([1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]]); if (Math.abs(n[0]) > 0.99) u = norm(cross([0, 0, 1], n)); }
    else u = norm(cross([0, 1, 0], n));
    const w = cross(u, n);
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const o of P.tris) for (let k = 0; k < 3; k++) {
      const p = [tris[o + 3 * k], tris[o + 3 * k + 1], tris[o + 3 * k + 2]], s = dot(p, u), t = dot(p, w);
      if (s < s0) s0 = s; if (s > s1) s1 = s; if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    let c = cell;
    while (((s1 - s0) / c + 1) * ((t1 - t0) / c + 1) > maxCells) c *= 1.5;
    const W = Math.max(1, Math.ceil((s1 - s0) / c - 1e-9)), H = Math.max(1, Math.ceil((t1 - t0) / c - 1e-9));
    const grid = new Uint8Array(W * H);
    const mark = (s, t) => {
      const i = Math.min(W - 1, Math.max(0, Math.floor((s - s0) / c))), j = Math.min(H - 1, Math.max(0, Math.floor((t - t0) / c)));
      grid[j * W + i] = 1;
    };
    for (const o of P.tris) {
      const q = [0, 1, 2].map((k) => { const p = [tris[o + 3 * k], tris[o + 3 * k + 1], tris[o + 3 * k + 2]]; return [dot(p, u), dot(p, w)]; });
      // Cells whose centre is inside the triangle, plus the corners and edge points of slivers.
      const [A, B, C] = q;
      const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      const i0 = Math.max(0, Math.floor((Math.min(A[0], B[0], C[0]) - s0) / c)), i1 = Math.min(W - 1, Math.floor((Math.max(A[0], B[0], C[0]) - s0) / c));
      const j0 = Math.max(0, Math.floor((Math.min(A[1], B[1], C[1]) - t0) / c)), j1 = Math.min(H - 1, Math.floor((Math.max(A[1], B[1], C[1]) - t0) / c));
      if (Math.abs(den) > 1e-12) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = s0 + (i + 0.5) * c, py = t0 + (j + 0.5) * c;
        const l1 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
        const l2 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
        if (l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6) grid[j * W + i] = 1;
      }
      for (const [X, Y] of [[A, B], [B, C], [C, A]]) {
        const steps = Math.max(1, Math.ceil(Math.hypot(Y[0] - X[0], Y[1] - X[1]) / c));
        for (let k = 0; k < steps; k++) { const f = (k + 0.5) / steps; mark(X[0] + (Y[0] - X[0]) * f, X[1] + (Y[1] - X[1]) * f); }
      }
    }
    const floorLike = Math.abs(n[1]) > 0.7;
    const th = P.th || (floorLike ? thickness : wall);
    const q = quatFromAxes(u, n, w);
    for (const [i0, j0, i1, j1] of greedyRects(grid, W, H)) {
      const sa = s0 + i0 * c, sb = Math.min(s1, s0 + (i1 + 1) * c), ta = t0 + j0 * c, tb = Math.min(t1, t0 + (j1 + 1) * c);
      if ((sb - sa) * (tb - ta) < Math.max(0.02, 2 * c * c)) continue;   // slivers from the raster's staircase edges
      const sc = (sa + sb) / 2, tc = (ta + tb) / 2, dc = P.d - th / 2;   // the slab sits behind the surface
      boxes.push({ half: [(sb - sa) / 2, th / 2, (tb - ta) / 2],
        pos: [u[0] * sc + n[0] * dc + w[0] * tc, u[1] * sc + n[1] * dc + w[1] * tc, u[2] * sc + n[2] * dc + w[2] * tc], quat: q,
        area: (sb - sa) * (tb - ta), kind: floorLike ? (n[1] > 0 ? "floor" : "ceiling") : "wall" });
    }
  }
  // Leftovers that sit against a slab already made (bevels, trims, window frames) add nothing.
  const covered = (p) => boxes.some((b) => {
    const q = [-b.quat[0], -b.quat[1], -b.quat[2], b.quat[3]];
    const d = qrotC(q, [p[0] - b.pos[0], p[1] - b.pos[1], p[2] - b.pos[2]]);
    return Math.abs(d[0]) <= b.half[0] + 0.35 && Math.abs(d[1]) <= b.half[1] + 0.35 && Math.abs(d[2]) <= b.half[2] + 0.35;
  });
  boxes.push(...leftoverBoxes(tris, leftovers).filter((b) => b.kind === "terrain" || !covered(b.pos)));
  return boxes;
}

function qrotC(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** Curved or broken-up leftovers: height columns where they face up (terrain, mounds), voxel boxes elsewhere. */
function leftoverBoxes(tris, offsets, { cell = null, target = 400 } = {}) {
  if (!offsets.length) return [];
  if (!cell) {   // about `target` columns over the leftovers' footprint, never finer than 1 m
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const o of offsets) for (let k = 0; k < 9; k += 3) {
      const x = tris[o + k], z = tris[o + k + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    cell = Math.max(1, Math.sqrt(((x1 - x0) * (z1 - z0)) / target));
  }
  const cols = new Map(), vox = new Map();
  for (const o of offsets) {
    const a = [tris[o], tris[o + 1], tris[o + 2]], b = [tris[o + 3], tris[o + 4], tris[o + 5]], c = [tris[o + 6], tris[o + 7], tris[o + 8]];
    const cr = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const l = Math.hypot(...cr) || 1;
    const upish = cr[1] / l > 0.5;
    const pts = [a, b, c, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]];
    for (const p of pts) {
      const i = Math.floor(p[0] / cell), k = Math.floor(p[2] / cell);
      if (upish) {
        const key = `${i},${k}`;
        const e = cols.get(key) || { i, k, top: -Infinity, bot: Infinity };
        e.top = Math.max(e.top, p[1]); e.bot = Math.min(e.bot, p[1]);
        cols.set(key, e);
      } else {
        const j = Math.floor(p[1] / cell), key = `${i},${j},${k}`;
        const e = vox.get(key) || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (let q = 0; q < 3; q++) { e.min[q] = Math.min(e.min[q], p[q]); e.max[q] = Math.max(e.max[q], p[q]); }
        vox.set(key, e);
      }
    }
  }
  const out = [];
  // Columns: the top is the highest surface point in the cell; merge runs along X with a similar top.
  const rows = new Map();
  for (const e of cols.values()) { if (!rows.has(e.k)) rows.set(e.k, []); rows.get(e.k).push(e); }
  for (const [k, list] of rows) {
    list.sort((p, q) => p.i - q.i);
    let run = null;
    const flush = () => {
      if (!run) return;
      const top = run.top, bot = Math.min(run.bot, top) - 0.3;
      out.push({ half: [((run.i1 - run.i0 + 1) * cell) / 2, (top - bot) / 2, cell / 2], pos: [((run.i0 + run.i1 + 1) * cell) / 2, (top + bot) / 2, (k + 0.5) * cell],
        quat: [0, 0, 0, 1], area: (run.i1 - run.i0 + 1) * cell * cell, kind: "terrain" });
      run = null;
    };
    for (const e of list) {
      if (run && e.i === run.i1 + 1 && Math.abs(e.top - run.top) < 0.12) { run.i1 = e.i; run.top = Math.max(run.top, e.top); run.bot = Math.min(run.bot, e.bot); }
      else { flush(); run = { i0: e.i, i1: e.i, top: e.top, bot: e.bot }; }
    }
    flush();
  }
  for (const e of vox.values()) {
    const half = [0, 1, 2].map((q) => Math.max(0.05, (e.max[q] - e.min[q]) / 2));
    out.push({ half, pos: [0, 1, 2].map((q) => (e.min[q] + e.max[q]) / 2), quat: [0, 0, 0, 1], area: 4 * half[0] * half[2], kind: "voxel" });
  }
  return out;
}

/** Share of a mesh's area facing its six most common directions: ~1 for boxy things, low for round ones. */
export function planarShare(t) {
  const bins = new Map();
  let total = 0;
  for (let o = 0; o + 8 < t.length; o += 9) {
    const cr = cross([t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]], [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]]);
    const a = Math.hypot(...cr);
    if (!(a > 0)) continue;
    const key = cr.map((v) => Math.round((v / a) * 8)).join();
    bins.set(key, (bins.get(key) || 0) + a);
    total += a;
  }
  return total ? [...bins.values()].sort((x, y) => y - x).slice(0, 6).reduce((x, y) => x + y, 0) / total : 1;
}

/** Volume enclosed by a triangle soup (positive when closed with outward faces). */
export function signedVolume(t) {
  let v = 0;
  for (let o = 0; o + 8 < t.length; o += 9) {
    v += t[o] * (t[o + 4] * t[o + 8] - t[o + 5] * t[o + 7]) - t[o + 1] * (t[o + 3] * t[o + 8] - t[o + 5] * t[o + 6]) + t[o + 2] * (t[o + 3] * t[o + 7] - t[o + 4] * t[o + 6]);
  }
  return v / 6;
}

/**
 * Collision boxes for a world: meshes = [{tris: Float32Array (world space, 9 floats a triangle), name?, solid?}].
 * Props (largest side <= propMax) and box-like solids get one box each; big meshes get slabs. Keeps the `maxBoxes`
 * biggest.
 * Returns {boxes, dropped}.
 */
export function worldColliders(meshes, { propMax = 2.6, maxBoxes = 1500, perMesh = 400, ...opts } = {}) {
  let boxes = [];
  for (const m of meshes) {
    if (!m.tris?.length) continue;
    const { min, max } = bounds(m.tris);
    const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    if (ext <= propMax) {
      const b = propBox(m.tris);
      if (b) boxes.push({ ...b, area: 4 * b.half[0] * b.half[2], kind: "prop", name: m.name });
      continue;
    }
    // A closed, outward, box-like solid (a building block, a wall without openings) is one box; a room shell
    // (faces inward), an open floor or anything with doors and notches gets slabs.
    // A closed, outward, round solid (a column, a lamp post, a boulder) is one box too.
    const b = propBox(m.tris);
    const obbVol = 8 * b.half[0] * b.half[1] * b.half[2];
    const fill = obbVol > 0 ? signedVolume(m.tris) / obbVol : 0;
    if (fill > 0.97 || (fill > 0.6 && planarShare(m.tris) < 0.6)) {
      boxes.push({ ...b, area: 4 * b.half[0] * b.half[2] + 4 * b.half[1] * Math.max(b.half[0], b.half[2]), kind: "solid", name: m.name });
      continue;
    }
    let mine = planarBoxes(m.tris, opts);
    if (mine.length > perMesh) mine = mine.sort((x, y) => y.area - x.area).slice(0, perMesh);   // one mesh can't take every slot
    boxes.push(...mine.map((x) => ({ ...x, name: m.name })));
  }
  let dropped = 0;
  if (boxes.length > maxBoxes) {
    boxes.sort((a, b) => b.area - a.area);
    dropped = boxes.length - maxBoxes;
    boxes = boxes.slice(0, maxBoxes);
  }
  return { boxes, dropped };
}
