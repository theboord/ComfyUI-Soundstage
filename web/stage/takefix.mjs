// Take clean-up for Drive mode (drive.mjs): auto-correct a driven take so it is physically plausible, and fit it with the
// fewest keys that still play back within a small tolerance.
//
// Auto-correct (correctTrack) works on a recorded track (one sample per frame: {f, p: [x, y, z], yaw, roll?, pitch?,
// air?, climb?, mode?}) against the limits of the body that drove it (limitsFor: the live car's own tyre grip, top gear
// and body roll gradient from vehsim.mjs; a person's or a horse's top speed, acceleration and turn rate from drive.mjs's
// steps). In order:
//   dropped    a slow frame sampled the same state twice, then caught up with a double step: put back in between
//   teleports  a jump far past what the body could travel in a frame is taken out (the rest of the take moves with it)
//   pops       a sample that jumps out and straight back (a dropped frame, a hand-over glitch) is put back between its
//              neighbours; a hit, a stop or a launch is a change that stays, so it is kept as it was
//   speed      faster than the body's top speed: each step is shortened to it (the path keeps its shape)
//   yaw        turn-rate spikes past the body's limit are clamped (later headings follow), yaw pops are put back
//   body       a car's roll and pitch beyond what its tyres and springs can give are settled to that limit
//   ground     on foot (not jumping or climbing) the feet are on the ground: no floating, no sinking; a car's wheels too
// Jitter is left to the take's smoothing (drive.mjs pathKeys), which runs after this. A clean take (anything a live body
// can actually do) passes through unchanged.
//
// Key reduction (reduceKeys) replays the keys exactly as the stage does (uniform Catmull-Rom through the keys, the heading
// on its own track, roll and pitch linear) and keeps splitting the segment with the worst frame until every frame is
// within tolerance: 2 cm of position (scaled to the object's size), 1° of heading and roll; half a frame early or late
// along the path is allowed, as in the camera's own reducer (movefit/stabilize.mjs, which allows a third). Frames named in `keep` (a mount, a jump's
// take-off and landing, the start and end of a stop) are always keys.
import { SURFACES } from "./vehsim.mjs";

const G = 9.81;
const DEG = Math.PI / 180;
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const hyp = (x, z) => Math.hypot(x, z);

/**
 * The limits a recorded track is held to, from the live body that drove it (drive.mjs): {vmax (m/s), aMax (m/s²),
 * rMax (rad/s), alphaMax (rad/s²), rollMax, pitchMax (deg)}; null for a body that is not corrected (a flown prop).
 */
export function limitsFor(b, { personSpeed, horseSpeed } = {}) {
  if (!b) return null;
  const h = b.height || 1.7;
  if (b.kind === "car" && b.carp) {
    const c = b.carp, mu = (SURFACES[b.surface] || SURFACES.dry).mu;
    // The friction circle: the tyres give at most μ·m·g in all, so |a| ≤ μ·g (a little more with downforce from the
    // weight transfer); the yaw acceleration the axles can give about the centre of mass.
    return { vmax: c.gears[c.gears.length - 1] * 1.05, aMax: mu * G * 1.25, rMax: 3 * Math.PI,
      alphaMax: mu * G * Math.max(c.a, c.b) / (c.k * c.k) * 1.5, rollMax: c.roll.grad * mu * 1.4, pitchMax: c.pitch.grad * mu * 1.4, ground: true };
  }
  if (b.kind === "person") return { vmax: (personSpeed ? personSpeed(1, true, h) : 6.2) * 1.1, aMax: 11, rMax: 12 * 1.25, alphaMax: Infinity, ground: true };
  if (b.kind === "horse" || b.kind === "animal") {
    return { vmax: (horseSpeed ? horseSpeed(1, true, h) : 12.5) * (b.scaleSpeed || 1) * 1.1, aMax: 8, rMax: 1.7 * 1.25, alphaMax: Infinity, ground: true };
  }
  if (b.kind === "bike") return { vmax: (b.akind === "motorcycle" ? 38 : 10) * 1.1, aMax: 6.5, rMax: 3, alphaMax: Infinity, ground: true };
  if (b.kind === "boat") return { vmax: 30, aMax: 8, rMax: 2, alphaMax: Infinity, ground: false };
  return null;
}

/** Runs of samples that a body placed itself (on foot or driven), split where a frame is missing or the mode changes. */
function freeRuns(S) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < S.length; i++) {
    const free = (S[i].mode ?? "foot") === "foot";
    if (free && cur && S[i].f === S[i - 1].f + 1) cur.push(i);
    else { if (cur && cur.length) runs.push(cur); cur = free ? [i] : null; }
  }
  if (cur && cur.length) runs.push(cur);
  return runs;
}

/**
 * Auto-correct one recorded track against its body's limits. Returns {samples (new objects), fixes: {pops, teleports,
 * speed, yaw, body, ground}} (counts of samples changed). fps: the take's frame rate; ground(x, z, y): the floor there.
 */
export function correctTrack(samples, lim, { fps = 24, ground = null } = {}) {
  const S = samples.map((s) => ({ ...s, p: [...s.p] }));
  const fixes = { pops: 0, teleports: 0, speed: 0, yaw: 0, body: 0, ground: 0 };
  if (!lim || S.length < 3) return { samples: S, fixes };
  const dt = 1 / fps, aLim = lim.aMax * 1.5;
  for (const run of freeRuns(S)) {
    const P = run.map((i) => S[i].p);
    const n = P.length;
    if (n < 3) continue;
    // 1. Dropped frames: the take sampled the same body state twice (a slow frame) while it was moving, then caught up
    // with a double step. Each repeated sample is put back where it was between the frames either side of it.
    const step = (i) => hyp(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2]);
    const popped = new Set();
    for (let i = 2; i < n - 1; i++) {
      if (step(i) > 1e-6 || step(i - 1) < 0.02) continue;
      let j = i + 1;
      while (j < n && step(j) < 1e-6) j++;
      if (j >= n || j - i > 2 || step(j) < 0.02) continue;
      for (let k = i; k < j; k++) {
        const u = (k - (i - 1)) / (j - (i - 1));
        for (const c of [0, 2]) P[k][c] = P[i - 1][c] + (P[j][c] - P[i - 1][c]) * u;
        for (const ch of ["yaw", "roll", "pitch"]) {
          const a = S[run[i - 1]][ch], b = S[run[j]][ch];
          if (Number.isFinite(a) && Number.isFinite(b)) S[run[k]][ch] = a + (ch === "yaw" ? wrap(b - a) : b - a) * u;
        }
        popped.add(k);
      }
    }
    // 2. Teleports: one step far longer than the steps either side of it, and longer than the body could add in a frame.
    for (let i = 1; i < n; i++) {
      const d = step(i), before = i > 1 ? step(i - 1) : 0, after = i < n - 1 ? step(i + 1) : before;
      if (!(d > 0.25 && d > 1.5 * Math.max(before, after) + 0.15 + 2 * lim.aMax * dt * dt)) continue;
      // Carry on at the speed it had: the jump minus one frame of the last velocity comes off the rest of the run.
      const vx = i > 1 ? P[i - 1][0] - P[i - 2][0] : 0, vz = i > 1 ? P[i - 1][2] - P[i - 2][2] : 0;
      const ox = P[i][0] - P[i - 1][0] - vx, oz = P[i][2] - P[i - 1][2] - vz;
      for (let j = i; j < n; j++) { P[j][0] -= ox; P[j][2] -= oz; }
      fixes.teleports++;
    }
    // 3. Pops: out and straight back. The acceleration at i is large and the one next to it is large the other way.
    // (A hit, a stop or a launch is one large change that stays: it is not a pop, and it is kept.)
    const acc = (i) => [(P[i + 1][0] - 2 * P[i][0] + P[i - 1][0]) * fps * fps, (P[i + 1][2] - 2 * P[i][2] + P[i - 1][2]) * fps * fps];
    // The most extreme first: the spike itself bends harder than the frames either side of it (which only lean
    // toward it), so those are left alone once it is back.
    for (let pass = 0; pass < 4; pass++) {
      const cand = [];
      for (let i = 1; i < n - 1; i++) {
        const a = acc(i), am = hyp(...a);
        if (am <= aLim) continue;
        const nb = [i > 1 ? acc(i - 1) : null, i < n - 2 ? acc(i + 1) : null].filter(Boolean);
        if (nb.some((b) => hyp(...b) > aLim * 0.5 && a[0] * b[0] + a[1] * b[1] < 0)) cand.push([am, i]);
      }
      if (!cand.length) break;
      const done = new Set();
      for (const [, i] of cand.sort((p, q) => q[0] - p[0])) {
        if (done.has(i - 1) || done.has(i + 1)) continue;
        P[i][0] = (P[i - 1][0] + P[i + 1][0]) / 2; P[i][2] = (P[i - 1][2] + P[i + 1][2]) / 2;
        popped.add(i); done.add(i);
      }
    }
    fixes.pops += popped.size;
    // 4. Top speed: a step longer than vmax·dt is shortened; the rest of the run follows.
    const maxStep = lim.vmax * dt;
    for (let i = 1; i < n; i++) {
      const dx = P[i][0] - P[i - 1][0], dz = P[i][2] - P[i - 1][2], d = hyp(dx, dz);
      if (d <= maxStep * 1.0001) continue;
      const k = maxStep / d, ox = dx * (1 - k), oz = dz * (1 - k);
      for (let j = i; j < n; j++) { P[j][0] -= ox; P[j][2] -= oz; }
      fixes.speed++;
    }
    // 5. Heading: unwrap, put back yaw pops, clamp the turn rate (later headings keep their turns).
    const Y = run.map((i) => S[i].yaw);
    if (Y.every(Number.isFinite)) {
      for (let i = 1; i < n; i++) Y[i] = Y[i - 1] + wrap(Y[i] - Y[i - 1]);
      const y0 = fixes.yaw;
      const yLim = Math.min(lim.alphaMax * 1.5, 2 * lim.rMax * fps);
      for (let i = 1; i < n - 1; i++) {
        const a = (Y[i + 1] - 2 * Y[i] + Y[i - 1]) * fps * fps;
        if (Math.abs(a) <= yLim) continue;
        const nbs = [i > 1 ? (Y[i] - 2 * Y[i - 1] + Y[i - 2]) * fps * fps : 0, i < n - 2 ? (Y[i + 2] - 2 * Y[i + 1] + Y[i]) * fps * fps : 0];
        if (!nbs.some((b) => Math.abs(b) > yLim * 0.5 && b * a < 0)) continue;
        Y[i] = (Y[i - 1] + Y[i + 1]) / 2;
        if (!popped.has(i)) fixes.yaw++;
      }
      const rStep = lim.rMax * dt;
      for (let i = 1; i < n; i++) {
        const d = Y[i] - Y[i - 1];
        if (Math.abs(d) <= rStep * 1.0001) continue;
        const off = d - Math.sign(d) * rStep;
        for (let j = i; j < n; j++) Y[j] -= off;
        fixes.yaw++;
      }
      if (fixes.yaw > y0) run.forEach((i, k) => { S[i].yaw = Y[k]; });
    }
    // 6. A car's body: roll and pitch no further than the tyres and springs give.
    if (Number.isFinite(lim.rollMax)) for (const i of run) {
      const s = S[i];
      for (const [ch, m] of [["roll", lim.rollMax], ["pitch", lim.pitchMax]]) {
        if (Number.isFinite(s[ch]) && Math.abs(s[ch]) > m) { s[ch] = Math.sign(s[ch]) * m; fixes.body++; }
      }
    }
    // 7. On the ground: not jumping or climbing, the feet (or the wheels) stand on the floor.
    if (lim.ground) for (const i of run) {
      const s = S[i];
      if (s.air || s.climb) continue;
      const gy = ground ? ground(s.p[0], s.p[2], s.p[1]) : Math.max(0, s.p[1]);
      if (Number.isFinite(gy) && Math.abs(gy - s.p[1]) > 0.01) { s.p[1] = gy; fixes.ground++; }
    }
  }
  return { samples: S, fixes };
}

/** "Smoothed 3 spikes, removed 1 teleport, settled roll": the fixes in words (empty when nothing changed). */
export function fixWords(f) {
  const out = [];
  const n = (k, one, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  if (f.pops + f.yaw) out.push(`smoothed ${n(f.pops + f.yaw, "spike")}`);
  if (f.teleports) out.push(`removed ${n(f.teleports, "teleport")}`);
  if (f.speed) out.push(`held ${n(f.speed, "frame")} to top speed`);
  if (f.body) out.push("settled roll");
  if (f.ground) out.push(`planted ${n(f.ground, "frame")} on the ground`);
  return out;
}

export const sumFixes = (list) => list.reduce((s, f) => { for (const k of Object.keys(f)) s[k] = (s[k] || 0) + f[k]; return s; }, { pops: 0, teleports: 0, speed: 0, yaw: 0, body: 0, ground: 0 });

// ------------------------------------------------------------------ key reduction

/** The stage's playback (Stage._segment / _cr / _sample with extrapolate, as drive keys carry a heading). */
function segment(keys, f) {
  const n = keys.length - 1;
  if (!n || f <= keys[0].frame) return { i: 0, j: 0, u: 0 };
  if (f >= keys[n].frame) return { i: n, j: n, u: 0 };
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].frame < f) lo = m; else hi = m; }
  return { i: lo, j: lo + 1, u: (f - keys[lo].frame) / Math.max(1e-6, keys[lo + 1].frame - keys[lo].frame) };
}
const cr = (p0, p1, p2, p3, u) => {
  const u2 = u * u, u3 = u2 * u;
  return p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3));
};
export function playAt(keys, f, get) {
  const { i, j, u } = segment(keys, f);
  if (i === j) return get(keys[i]);
  const a = get(keys[i]), b = get(keys[j]);
  if (a.every((x, k) => Math.abs(x - b[k]) < 1e-4)) return [...a];
  const n = keys.length - 1;
  const P = (k) => k < 0 ? get(keys[0]).map((v, c) => 2 * v - get(keys[1])[c]) : k > n ? get(keys[n]).map((v, c) => 2 * v - get(keys[n - 1])[c]) : get(keys[k]);
  return cr(P(i - 1), P(i), P(j), P(j + 1), u);
}
const lin = (keys, f, get) => {
  const { i, j, u } = segment(keys, f);
  return i === j ? get(keys[i]) : get(keys[i]) + (get(keys[j]) - get(keys[i])) * u;
};

/**
 * The fewest keys (a subset of `dense`, one key per frame) that play back within tolerance. tol: {pos (m), ang (deg),
 * slip (share of a frame's travel allowed along the path)}; keep: frames that must stay keys. Returns the kept keys.
 */
export function reduceKeys(dense, { pos = 0.02, ang = 1, slip = 0.5, keep = new Set(), maxIter = 4000 } = {}) {
  const n = dense.length;
  if (n <= 2) return dense.slice();
  const getP = (k) => k.position, getH = (k) => [k.heading_deg ?? 0];
  const hasH = dense.some((k) => Number.isFinite(k.heading_deg));
  const scal = ["roll_deg", "pitch_deg"].filter((c) => dense.some((k) => Number.isFinite(k[c])));
  const smoke = dense.some((k) => k.fx);
  // A held stretch starts and ends on a key (the stage holds still between two equal keys).
  const same = (a, b) => a.position.every((v, i) => Math.abs(v - b.position[i]) < 1e-4);
  const must = new Set([0, n - 1]);
  for (let i = 1; i < n - 1; i++) {
    if (keep.has(dense[i].frame) || same(dense[i], dense[i - 1]) !== same(dense[i], dense[i + 1])) must.add(i);
  }
  const err = (ks, i) => {
    const k = dense[i], f = k.frame;
    const p = playAt(ks, f, getP), d = p.map((v, c) => v - k.position[c]);
    const prev = dense[Math.max(0, i - 1)].position, next = dense[Math.min(n - 1, i + 1)].position;
    const st = next.map((v, c) => (v - prev[c]) / 2), L = Math.hypot(...st);
    let e;
    if (L < 1e-6) e = Math.hypot(...d) / pos;
    else {
      const along = (d[0] * st[0] + d[1] * st[1] + d[2] * st[2]) / L;
      const across = Math.sqrt(Math.max(0, d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - along * along));
      e = Math.max(across / pos, Math.abs(along) / (pos + slip * L));
    }
    if (hasH) e = Math.max(e, Math.abs(playAt(ks, f, getH)[0] - (k.heading_deg ?? 0)) / ang);
    for (const c of scal) e = Math.max(e, Math.abs(lin(ks.filter((x) => Number.isFinite(x[c])), f, (x) => x[c]) - (k[c] ?? 0)) / ang);
    if (smoke) e = Math.max(e, Math.abs(lin(ks, f, (x) => x.fx?.tire_smoke || 0) - (k.fx?.tire_smoke || 0)) / 0.1);
    return e;
  };
  const idx = [...must].sort((a, b) => a - b);
  const keysOf = () => idx.map((i) => dense[i]);
  for (let it = 0; it < maxIter && idx.length < n; it++) {
    const ks = keysOf();
    let worst = 1, at = -1;
    for (let i = 0; i < n; i++) { const e = err(ks, i); if (e > worst) { worst = e; at = i; } }
    if (at < 0) break;
    let lo = 0;
    while (lo < idx.length && idx[lo] < at) lo++;
    if (idx[lo] === at) break;
    // Split the segment holding the worst frame in the middle (evenly spaced keys suit the stage's uniform
    // Catmull-Rom); a short segment takes the worst frame itself.
    const mid = Math.round((idx[lo - 1] + idx[lo]) / 2);
    idx.splice(lo, 0, idx[lo] - idx[lo - 1] >= 6 && mid !== idx[lo - 1] ? mid : at);
  }
  return keysOf();
}

/** Linear part keys [{frame, v, i}] reduced to the fewest within tol (Ramer-Douglas-Peucker over the frames). */
export function reduceLinear(keys, tol = 1) {
  if (keys.length <= 2) return keys.slice();
  const keepIdx = new Set([0, keys.length - 1]);
  const rdp = (a, b) => {
    let worst = tol, at = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (keys[i].frame - keys[a].frame) / Math.max(1e-6, keys[b].frame - keys[a].frame);
      const e = Math.abs(keys[a].v + (keys[b].v - keys[a].v) * u - keys[i].v);
      if (e > worst) { worst = e; at = i; }
    }
    if (at < 0) return;
    keepIdx.add(at); rdp(a, at); rdp(at, b);
  };
  rdp(0, keys.length - 1);
  return keys.filter((_, i) => keepIdx.has(i));
}
