// Soundstage virtual-camera stabilizer (pure JS, no DOM, no three.js).
//
// A gimbal / warp-stabilizer for hand-held camera takes: it keeps what the operator
// meant (path, timing, speed changes, deliberate drifts and reframes) and removes only
// shake (tremor, sensor jitter, footstep bob, start/stop overshoot bumps).
//
// How: every output frame is a Gaussian-weighted LOCAL-QUADRATIC fit (Savitzky-Golay style) of
// the raw samples around that instant: zero phase = no lag, and unbiased for constant
// acceleration, so eases, speed-ups and stops keep their shape and timing. The
// kernel width adapts to how fast the camera is moving: slow / holding -> wide kernel
// (silky), fast -> narrow kernel (the move keeps its energy). Rotation is fitted the
// same way on sign-aligned quaternions and renormalised.
//
// Conventions: metres, Y up, camera looks down its local -Z (WebXR / three.js).
// samples: [{t (seconds), position:[x,y,z], quaternion:[x,y,z,w], focal_mm?}] at any rate.

const DEFAULTS = {
  strength: 0.6,       // 0 = raw, 1 = silky Steadicam
  horizonLock: false,  // zero roll
  keepHandheld: 0,     // 0..1, re-add this much of the original low-frequency sway
  fps: 24,
  focusDistance: 5,    // metres from camera to the look-at target
  focal_mm: 35,        // used when samples carry no focal_mm
  scale: 1,            // 1 m of hand movement = `scale` m on set
  anchor: null,        // {position:[x,y,z], yaw?:deg} -> first sample lands here, heading rotated by yaw
  startFrame: 0,
  keyTolerance: 0.015, // metres; the stage's playback of the keys stays within this of the frames (see reduceKeys)
  maxKeys: 96,
};

// Speeds at which the filter is fully "fast" (lightest smoothing).
const V_REF = 0.6;    // m/s, hand-space
const W_REF = 45;     // deg/s
// Cut-off frequencies (Hz) at strength 0 and 1, for slow and fast motion. Interpolated geometrically.
const FC_SLOW = [10, 0.22];
const FC_FAST = [14, 0.7];
const SIGMA_SLOPE = 0.1;
const SWAY_FC = 2.5;  // "handheld" band ends here: footstep sway in, tremor (6-12 Hz) out

// ---------------------------------------------------------------- small vector / quat helpers
const lerp = (a, b, u) => a + (b - a) * u;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];

export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qrotate(q, v) {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [p[0], p[1], p[2]];
}

export function qslerp(a, b, u) {
  let d = qdot(a, b);
  if (d < 0) { b = b.map((x) => -x); d = -d; }
  if (d > 0.9995) return qnorm(a.map((x, i) => lerp(x, b[i], u)));
  const th = Math.acos(clamp(d, -1, 1)), s = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / s, wb = Math.sin(u * th) / s;
  return a.map((x, i) => x * wa + b[i] * wb);
}

const qangle = (a, b) => 2 * Math.acos(clamp(Math.abs(qdot(a, b)), 0, 1));
export const forwardOf = (q) => qrotate(q, [0, 0, -1]);

function qaxis(axis, deg) {
  const h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** Quaternion from an orthonormal basis (columns x, y, z). */
function qfromBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  return qnorm(q);
}

/** Camera orientation looking along `fwd` with zero roll (Y up). Returns null when looking straight up/down. */
export function qlookZeroRoll(fwd) {
  const z = norm3(scl(fwd, -1));
  const xr = cross([0, 1, 0], z);
  if (len3(xr) < 1e-4) return null;
  const x = norm3(xr), y = cross(z, x);
  return qfromBasis(x, y, z);
}

/** Yaw/pitch/roll (degrees) of a camera quaternion: yaw about +Y (0 = looking -Z), pitch up +, roll CCW +. */
export function eulerOf(q) {
  const f = forwardOf(q);
  const yaw = (Math.atan2(-f[0], -f[2]) * 180) / Math.PI;
  const pitch = (Math.asin(clamp(f[1], -1, 1)) * 180) / Math.PI;
  const level = qlookZeroRoll(f);
  let roll = 0;
  if (level) {
    const up = qrotate(q, [0, 1, 0]), lup = qrotate(level, [0, 1, 0]);
    roll = (Math.atan2(dot3(cross(lup, up), f), dot3(lup, up)) * 180) / Math.PI * -1;
  }
  return { yaw, pitch, roll };
}

// ---------------------------------------------------------------- filtering core
function prepare(samples) {
  const s = samples
    .filter((x) => x && Number.isFinite(x.t) && x.position && x.quaternion)
    .map((x) => ({ t: +x.t, p: x.position.map(Number), q: qnorm(x.quaternion.map(Number)), f: x.focal_mm }))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const x of s) if (!out.length || x.t > out[out.length - 1].t + 1e-6) out.push(x);
  // Hemisphere-align quaternions so neighbours are on the same side (q and -q are the same rotation).
  for (let i = 1; i < out.length; i++) if (qdot(out[i].q, out[i - 1].q) < 0) out[i].q = out[i].q.map((v) => -v);
  return out;
}

function lowerBound(ts, t) {
  let lo = 0, hi = ts.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

/** Linear interpolation of channel `get` at time t (used for raw / tiny kernels). */
function interp(ts, vals, t) {
  const n = ts.length;
  if (t <= ts[0]) return vals[0].slice();
  if (t >= ts[n - 1]) return vals[n - 1].slice();
  const j = lowerBound(ts, t), i = j - 1, u = (t - ts[i]) / (ts[j] - ts[i]);
  return vals[i].map((v, k) => lerp(v, vals[j][k], u));
}

/**
 * Gaussian-weighted local-linear fit of vector channel `vals` at time t0, std `sigma` seconds.
 * Returns {value, slope}. Zero-phase, and exact for straight-line motion at any sigma
 * (so constant-speed moves keep their speed and timing exactly).
 */
function localLinear(ts, vals, t0, sigma, dtMed) {
  const dim = vals[0].length;
  if (!(sigma > 0.6 * dtMed)) return { value: interp(ts, vals, t0), slope: null };
  const r = 3 * sigma, i0 = lowerBound(ts, t0 - r), i1 = lowerBound(ts, t0 + r);
  let S0 = 0, S1 = 0, S2 = 0;
  const Sy = new Array(dim).fill(0), Sty = new Array(dim).fill(0);
  const inv = 1 / (2 * sigma * sigma);
  for (let i = i0; i < i1; i++) {
    const d = ts[i] - t0, w = Math.exp(-d * d * inv);
    S0 += w; S1 += w * d; S2 += w * d * d;
    const v = vals[i];
    for (let k = 0; k < dim; k++) { Sy[k] += w * v[k]; Sty[k] += w * d * v[k]; }
  }
  const det = S0 * S2 - S1 * S1;
  if (S0 <= 0 || Math.abs(det) < 1e-12 * Math.max(1, S0 * S2)) return { value: interp(ts, vals, t0), slope: null };
  const value = Sy.map((sy, k) => (S2 * sy - S1 * Sty[k]) / det);
  const slope = Sy.map((sy, k) => (S0 * Sty[k] - S1 * sy) / det);
  return { value, slope };
}

/**
 * Gaussian-weighted local-QUADRATIC fit (Savitzky-Golay with a Gaussian window): unbiased for
 * constant acceleration, so eases, speed-ups and stops keep their shape. Returns the value at t0.
 */
function localQuadratic(ts, vals, t0, sigma, dtMed) {
  const dim = vals[0].length;
  if (!(sigma > 1.2 * dtMed)) return localLinear(ts, vals, t0, sigma, dtMed).value;
  const r = 3 * sigma, i0 = lowerBound(ts, t0 - r), i1 = lowerBound(ts, t0 + r);
  if (i1 - i0 < 5) return localLinear(ts, vals, t0, sigma, dtMed).value;
  const m = [0, 0, 0, 0, 0], Y = Array.from({ length: 3 }, () => new Array(dim).fill(0));
  const inv = 1 / (2 * sigma * sigma);
  for (let i = i0; i < i1; i++) {
    const d = ts[i] - t0, w = Math.exp(-d * d * inv), v = vals[i];
    let p = w;
    for (let k = 0; k < 5; k++) { m[k] += p; p *= d; }
    for (let k = 0; k < dim; k++) { Y[0][k] += w * v[k]; Y[1][k] += w * d * v[k]; Y[2][k] += w * d * d * v[k]; }
  }
  // Row 0 of the inverse of [[m0 m1 m2][m1 m2 m3][m2 m3 m4]] (cofactors / det).
  const c00 = m[2] * m[4] - m[3] * m[3], c01 = -(m[1] * m[4] - m[3] * m[2]), c02 = m[1] * m[3] - m[2] * m[2];
  const det = m[0] * c00 + m[1] * c01 + m[2] * c02;
  if (!(Math.abs(det) > 1e-14 * Math.max(1e-30, m[0] * m[2] * m[4]))) return localLinear(ts, vals, t0, sigma, dtMed).value;
  return Y[0].map((_, k) => (c00 * Y[0][k] + c01 * Y[1][k] + c02 * Y[2][k]) / det);
}

const sigmaForFc = (fc) => 0.1325 / fc; // Gaussian -3 dB point
const QUAD = 1.7; // a local-quadratic kernel this much wider has about the same noise cut-off as local-linear
const geo = (pair, s) => Math.exp(lerp(Math.log(pair[0]), Math.log(pair[1]), s));

/** Smooth a per-frame scalar array with a fixed Gaussian (frames), mirror-padded. */
function smoothArray(a, sigmaFrames) {
  if (sigmaFrames <= 0.3) return a.slice();
  const r = Math.ceil(3 * sigmaFrames), n = a.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let k = -r; k <= r; k++) {
      const j = clamp(i + k, 0, n - 1), g = Math.exp(-(k * k) / (2 * sigmaFrames * sigmaFrames));
      s += g * a[j]; w += g;
    }
    out[i] = s / w;
  }
  return out;
}

/**
 * Stabilize a raw take.
 * @returns {{frames: Array<{frame, position, target, focal_mm, quaternion}>, keys: Array<{frame, position, target, focal_mm}>, info: object}}
 */
export function stabilize(samples, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const S = prepare(samples || []);
  if (S.length === 0) return { frames: [], keys: [], info: { duration: 0, fps: o.fps, error: "no samples" } };
  const strength = clamp(+o.strength || 0, 0, 1);
  const keep = clamp(+o.keepHandheld || 0, 0, 1);
  const ts = S.map((x) => x.t), P = S.map((x) => x.p), Q = S.map((x) => x.q);
  const F = S.map((x) => [Number.isFinite(x.f) ? x.f : o.focal_mm]);
  const t0 = ts[0], duration = ts[ts.length - 1] - t0;
  const dts = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  const dtMed = dts.length ? dts[dts.length >> 1] : 1 / 60;
  const nFrames = Math.max(1, Math.floor(duration * o.fps + 1e-6) + 1);
  const T = Array.from({ length: nFrames }, (_, f) => t0 + f / o.fps);

  // 1. How fast is the operator moving? (a firm fixed-width fit so tremor doesn't read as speed)
  const sigSpeed = 0.18;
  const vLin = [], vAng = [];
  for (const t of T) {
    const lp = localLinear(ts, P, t, sigSpeed, dtMed), lq = localLinear(ts, Q, t, sigSpeed, dtMed);
    vLin.push(lp.slope ? len3(lp.slope) : 0);
    // |dq/dt| of a unit quaternion = half the angular speed.
    vAng.push(lq.slope ? (2 * Math.hypot(...lq.slope) * 180) / Math.PI : 0);
  }
  const aLin = smoothArray(vLin, 0.2 * o.fps).map((v) => clamp(v / V_REF, 0, 1));
  const aAng = smoothArray(vAng, 0.2 * o.fps).map((v) => clamp(v / W_REF, 0, 1));
  const sigmaOf = (a) => (strength <= 0 ? 0 : sigmaForFc(lerp(geo(FC_SLOW, strength), geo(FC_FAST, strength), Math.sqrt(a))));
  // The kernel may only widen gradually after fast motion (SIGMA_SLOPE s per s), so a wide "slow"
  // kernel at a stop can't reach back into the move and smear the landing.
  const limit = (sig) => {
    const dt = 1 / o.fps;
    for (let i = 1; i < sig.length; i++) sig[i] = Math.min(sig[i], sig[i - 1] + SIGMA_SLOPE * dt);
    for (let i = sig.length - 2; i >= 0; i--) sig[i] = Math.min(sig[i], sig[i + 1] + SIGMA_SLOPE * dt);
    return sig;
  };
  const sigP = limit(aLin.map(sigmaOf)), sigQ = limit(aAng.map(sigmaOf));
  const swaySigma = sigmaForFc(SWAY_FC);

  // 2. Fit every frame.
  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const t = T[f];
    const sp = sigP[f], sq = sigQ[f];
    let pos = localQuadratic(ts, P, t, sp * QUAD, dtMed);
    let q = qnorm(localQuadratic(ts, Q, t, sq * QUAD, dtMed));
    if (keep > 0 && strength > 0) {
      const swayP = localQuadratic(ts, P, t, Math.min(swaySigma, sp) * QUAD, dtMed);
      const swayQ = qnorm(localQuadratic(ts, Q, t, Math.min(swaySigma, sq) * QUAD, dtMed));
      pos = add(pos, scl(sub(swayP, pos), keep));
      q = qslerp(q, swayQ, keep);
    }
    if (o.horizonLock) q = qlookZeroRoll(forwardOf(q)) || q;
    const focal = localLinear(ts, F, t, Math.max(sp, 0.15), dtMed).value[0];
    frames.push({ frame: f + o.startFrame, t: t - t0, position: pos, quaternion: q, focal_mm: focal });
  }

  // 3. Hand space -> set space (scale about the first frame, then anchor + heading).
  const origin = frames[0].position.slice();
  let yawQ = [0, 0, 0, 1];
  let place = origin;
  if (o.anchor) {
    if (Number.isFinite(o.anchor.yaw)) {
      const e = eulerOf(frames[0].quaternion);
      yawQ = qaxis([0, 1, 0], o.anchor.yaw - e.yaw);
    }
    if (o.anchor.position) place = o.anchor.position;
  }
  for (const fr of frames) {
    fr.position = add(place, qrotate(yawQ, scl(sub(fr.position, origin), o.scale)));
    fr.quaternion = qnorm(qmul(yawQ, fr.quaternion));
    fr.target = add(fr.position, scl(forwardOf(fr.quaternion), o.focusDistance));
    fr.focal_mm = Math.round(fr.focal_mm * 100) / 100;
  }

  const { keys, maxError } = reduceKeys(frames, { tolerance: o.keyTolerance, maxKeys: o.maxKeys, focusDistance: o.focusDistance });
  return {
    frames,
    keys,
    info: { duration, fps: o.fps, frames: frames.length, keys: keys.length, maxKeyError: maxError, samples: S.length, strength, horizonLock: !!o.horizonLock, keepHandheld: keep },
  };
}

// ---------------------------------------------------------------- stage interpolation (mirror of web/stage/stage.mjs)
// Keep in sync with Stage._segment / _cr / _sample / _cameraAt. tests/js/stabilize.test.mjs checks parity when it can load stage.mjs.
function segment(keys, frame) {
  if (keys.length === 1 || frame <= keys[0].frame) return { i: 0, j: 0, u: 0 };
  const n = keys.length - 1;
  if (frame >= keys[n].frame) return { i: n, j: n, u: 0 };
  let i = 0;
  while (keys[i + 1].frame < frame) i++;
  return { i, j: i + 1, u: (frame - keys[i].frame) / Math.max(1e-6, keys[i + 1].frame - keys[i].frame) };
}

function cr(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return p1.map((_, k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u +
    (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3));
}

function sampleField(keys, frame, field, ease = true) {
  const { i, j, u } = segment(keys, frame);
  if (i === j) return [...keys[i][field]];
  const n = keys.length - 1;
  let w = u;
  if (ease && n === 1) w = u * u * (3 - 2 * u);
  else if (ease && i === 0) w = (u * u * (3 - 2 * u) + u) / 2;
  else if (ease && j === n) w = (u * u * (3 - 2 * u) + u) / 2;
  const Pk = (k) => keys[Math.max(0, Math.min(n, k))][field];
  return cr(Pk(i - 1), Pk(i), Pk(j), Pk(j + 1), w);
}

/** The stage's camera at `frame` given camera keys (same maths as Stage._cameraAt). */
export function stageCameraAt(keys, frame) {
  const { i, j, u } = segment(keys, frame);
  const fa = keys[i].focal_mm, fb = keys[j].focal_mm;
  return {
    position: sampleField(keys, frame, "position"),
    target: sampleField(keys, frame, "target"),
    focal_mm: fa + (fb - fa) * (i === j ? 0 : u * u * (3 - 2 * u)),
  };
}

const toKey = (fr) => ({
  frame: fr.frame,
  position: fr.position.map((v) => Math.round(v * 1e4) / 1e4),
  target: fr.target.map((v) => Math.round(v * 1e4) / 1e4),
  focal_mm: fr.focal_mm,
});

/** Sparse weights of each key in Stage._sample(keys, frame, field) (it is linear in the key values). */
function stageWeights(keyFrames, frame) {
  const keys = keyFrames.map((f) => ({ frame: f }));
  const { i, j, u } = segment(keys, frame);
  if (i === j) return [[i, 1]];
  const n = keys.length - 1;
  let w = u;
  if (n === 1) w = u * u * (3 - 2 * u);
  else if (i === 0 || j === n) w = (u * u * (3 - 2 * u) + u) / 2;
  const w2 = w * w, w3 = w2 * w, c = (k) => Math.max(0, Math.min(n, k));
  return [[c(i - 1), 0.5 * (-w + 2 * w2 - w3)], [i, 0.5 * (2 - 5 * w2 + 3 * w3)], [j, 0.5 * (w + 4 * w2 - 3 * w3)], [c(j + 1), 0.5 * (-w2 + w3)]];
}

/** Solve the small dense system M X = B (Gauss-Jordan, partial pivoting). */
function solveDense(M, B) {
  const K = M.length, D = B[0].length, A = M.map((r, i) => [...r, ...B[i]]);
  for (let c = 0; c < K; c++) {
    let p = c;
    for (let r = c + 1; r < K; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < K; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f) for (let j = c; j < K + D; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((r, i) => r.slice(K).map((v) => v / r[i]));
}

/**
 * Error-bounded key reduction for the stage timeline.
 *
 * The stage plays keys back with uniform Catmull-Rom per segment (plus easing on the first and
 * last segment). For a chosen set of key frames that playback is linear in the key values, so the
 * key positions/targets are solved by least squares to make the stage's playback hug the
 * stabilized path (keys may sit a few mm off the raw path; a light ridge keeps them near it).
 * Keys start every ~`startSpacing` frames and one is added inside the segment holding the worst
 * frame until every frame is within tolerance:
 *   - across the path: `tolerance` metres (target: scaled by focus distance, i.e. an angle),
 *   - along the path: `tolerance` + `slip` of that frame's travel (a third of a frame early/late
 *     is invisible, while 1 cm is less than a frame of travel in a fast move).
 */
export function reduceKeys(frames, { tolerance = 0.015, maxKeys = 96, focusDistance = 5, minSpacing = 3, slip = 0.35 } = {}) {
  const n = frames.length;
  if (n <= 2) return { keys: frames.map(toKey), maxError: 0 };
  const tTol = Math.max(1, focusDistance) * tolerance * 1.5;
  const fTol = 0.5; // mm
  const fr = frames.map((f) => f.frame);
  const stepOf = (f, field) => {
    const i = Math.max(0, f - 1), j = Math.min(n - 1, f + 1);
    return scl(sub(frames[j][field], frames[i][field]), 1 / Math.max(1, fr[j] - fr[i]));
  };
  const steps = frames.map((_, f) => [stepOf(f, "position"), stepOf(f, "target")]);
  const split = (err, step, tol) => {
    const L = len3(step);
    if (L < 1e-9) return len3(err) / tol;
    const d = scl(step, 1 / L), along = dot3(err, d);
    return Math.max(len3(sub(err, scl(d, along))) / tol, Math.abs(along) / (tol + slip * L));
  };
  let keys, errs, worst;
  const fit = (idx) => {
    const K = idx.length, kf = idx.map((i) => fr[i]);
    const M = Array.from({ length: K }, () => new Array(K).fill(0)), B = Array.from({ length: K }, () => new Array(6).fill(0));
    for (let r = 0; r < n; r++) {
      const W = stageWeights(kf, fr[r]), y = [...frames[r].position, ...frames[r].target];
      for (const [a, wa] of W) {
        for (const [b, wb] of W) M[a][b] += wa * wb;
        for (let d = 0; d < 6; d++) B[a][d] += wa * y[d];
      }
    }
    for (let a = 0; a < K; a++) {
      const lam = a === 0 || a === K - 1 ? 1e4 : 0.02; // first/last key sit exactly on the take
      M[a][a] += lam;
      const y = [...frames[idx[a]].position, ...frames[idx[a]].target];
      for (let d = 0; d < 6; d++) B[a][d] += lam * y[d];
    }
    const X = solveDense(M, B);
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const ks = idx.map((i, a) => ({ frame: fr[i], position: X[a].slice(0, 3).map(r4), target: X[a].slice(3).map(r4), focal_mm: frames[i].focal_mm }));
    const es = frames.map((f, r) => {
      const c = stageCameraAt(ks, f.frame);
      return Math.max(split(sub(c.position, f.position), steps[r][0], tolerance), split(sub(c.target, f.target), steps[r][1], tTol), Math.abs(c.focal_mm - f.focal_mm) / fTol);
    });
    return { idx, keys: ks, errs: es, worst: Math.max(...es) };
  };
  const uniform = (k) => [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1))))];
  // Smallest evenly spaced key set that fits (even spacing suits uniform Catmull-Rom best) ...
  let best = null;
  for (let k = 2; k <= Math.min(maxKeys, Math.ceil((n - 1) / minSpacing) + 1); k++) {
    const r = fit(uniform(k));
    if (!best || r.worst < best.worst) best = r;
    if (r.worst <= 1) break;
  }
  // ... and if a local event (a stop, a whip) still sticks out, split just that segment.
  let cur = best;
  for (let guard = 0; cur.worst > 1 && cur.idx.length < maxKeys && guard < maxKeys; guard++) {
    let bf = -1, top = 1, s = 0;
    for (let f = 0; f < n; f++) {
      while (s < cur.idx.length - 2 && cur.idx[s + 1] < f) s++;
      if (cur.idx[s + 1] - cur.idx[s] >= 2 * minSpacing && cur.errs[f] > top) { top = cur.errs[f]; bf = f; }
    }
    if (bf < 0) break;
    s = 0;
    while (s < cur.idx.length - 2 && cur.idx[s + 1] < bf) s++;
    const idx = [...cur.idx];
    idx.splice(s + 1, 0, Math.round((idx[s] + idx[s + 1]) / 2));
    const r = fit(idx);
    if (r.worst >= cur.worst) break;
    cur = r;
  }
  ({ keys, errs, worst } = cur);
  return { keys, maxError: worst * tolerance };
}

// ---------------------------------------------------------------- optional rig suggestion (never applied automatically)

function fitLine(pts) {
  const n = pts.length, c = scl(pts.reduce(add, [0, 0, 0]), 1 / n);
  const d = norm3(sub(pts[n - 1], pts[0]));
  const proj = pts.map((p) => dot3(sub(p, c), d));
  const res = Math.max(...pts.map((p, i) => len3(sub(sub(p, c), scl(d, proj[i])))));
  return { c, d, proj, res };
}

/** Least-squares circle in the XZ plane (Kasa fit). */
function fitCircleXZ(pts) {
  let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sxr = 0, szr = 0, sr = 0;
  const n = pts.length;
  for (const p of pts) {
    const x = p[0], z = p[2], r = x * x + z * z;
    sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z; sxr += x * r; szr += z * r; sr += r;
  }
  // Solve [sxx sxz sx; sxz szz sz; sx sz n] [A B C] = [sxr szr sr], circle x²+z² = A x + B z + C
  const M = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]], b = [sxr, szr, sr];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M);
  if (Math.abs(D) < 1e-12) return null;
  const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  const A = det3(col(0)) / D, B = det3(col(1)) / D, C = det3(col(2)) / D;
  const cx = A / 2, cz = B / 2, r = Math.sqrt(Math.max(0, C + cx * cx + cz * cz));
  const res = Math.max(...pts.map((p) => Math.abs(Math.hypot(p[0] - cx, p[2] - cz) - r)));
  return { cx, cz, r, res };
}

/** Monotonic 0..1 progress that follows the operator's own timing (cumulative motion, normalised). */
function progressOf(values, metric) {
  const acc = [0];
  for (let i = 1; i < values.length; i++) acc.push(acc[i - 1] + metric(values[i - 1], values[i]));
  const tot = acc[acc.length - 1] || 1;
  return acc.map((a) => a / tot);
}

/**
 * Look at a take and SUGGEST a classic rig move it resembles ("dolly-in", "pan", "crane up", "arc"...).
 * Returns null if it reads as free handheld. The snapped alternative keeps the operator's timing
 * (progress along the move follows their real speed) and only straightens the geometry.
 * Accepts raw samples or the `frames` of a stabilize() result. Nothing is ever applied automatically.
 */
export function suggestRig(samplesOrFrames, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const frames = samplesOrFrames?.[0]?.target ? samplesOrFrames : stabilize(samplesOrFrames, { ...o, strength: Math.max(0.8, o.strength ?? 0) }).frames;
  if (!frames || frames.length < 6) return null;
  const pts = frames.map((f) => f.position), qs = frames.map((f) => f.quaternion || qlookZeroRoll(norm3(sub(f.target, f.position))) || [0, 0, 0, 1]);
  const first = pts[0], last = pts[pts.length - 1], disp = sub(last, first), travel = len3(disp);
  const pathLen = pts.slice(1).reduce((s, p, i) => s + len3(sub(p, pts[i])), 0);
  const e0 = eulerOf(qs[0]), e1 = eulerOf(qs[qs.length - 1]);
  const dyaw = ((e1.yaw - e0.yaw + 540) % 360) - 180, dpitch = e1.pitch - e0.pitch;
  const turn = (qangle(qs[0], qs[qs.length - 1]) * 180) / Math.PI;
  const fwd0 = forwardOf(qs[0]);
  const mk = (type, label, confidence, build) => {
    const snapped = frames.map((fr, i) => build(fr, i));
    for (const s of snapped) { s.target = add(s.position, scl(forwardOf(s.quaternion), o.focusDistance)); s.focal_mm = frames[0].focal_mm; }
    const { keys } = reduceKeys(snapped, { tolerance: o.keyTolerance, maxKeys: o.maxKeys, focusDistance: o.focusDistance });
    return { type, label, confidence: Math.round(confidence * 100) / 100, question: `This looks like a ${label}. Snap it?`, snapped: { frames: snapped, keys } };
  };
  const slerpBy = (prog) => (i) => qslerp(qs[0], qs[qs.length - 1], prog[i]);

  // Lock-off / pan / tilt: the camera barely travels (or drifts a little while turning a lot).
  if (pathLen < 0.3 || (pathLen < 0.6 && turn > 25 && travel < 0.5)) {
    const c = scl(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
    if (turn < 3) return mk("lockoff", "locked-off shot", 0.9, (fr) => ({ frame: fr.frame, position: c, quaternion: qs[0] }));
    const prog = progressOf(qs, qangle), rot = slerpBy(prog);
    const level = (q) => qlookZeroRoll(forwardOf(q)) || q;
    const isPan = Math.abs(dyaw) >= Math.abs(dpitch);
    const label = isPan ? `pan ${dyaw > 0 ? "left" : "right"}` : `tilt ${dpitch > 0 ? "up" : "down"}`;
    return mk(isPan ? "pan" : "tilt", label, clamp(1 - pathLen / 0.6, 0.4, 0.95), (fr, i) => ({ frame: fr.frame, position: c, quaternion: level(rot(i)) }));
  }
  // Crane / jib: mostly vertical travel.
  if (Math.abs(disp[1]) > 0.7 * travel && travel > 0.3) {
    const prog = progressOf(pts, (a, b) => Math.abs(b[1] - a[1])), rot = slerpBy(prog);
    return mk("crane", `crane ${disp[1] > 0 ? "up" : "down"}`, clamp(Math.abs(disp[1]) / pathLen, 0.4, 0.95),
      (fr, i) => ({ frame: fr.frame, position: [first[0], first[1] + disp[1] * prog[i], first[2]], quaternion: rot(i) }));
  }
  // Straight dolly / track.
  const line = fitLine(pts);
  if (travel > 0.3 && line.res < 0.08 * travel + 0.03) {
    const along = dot3(norm3(disp), norm3([fwd0[0], 0, fwd0[2]]));
    const label = along > 0.7 ? "dolly-in" : along < -0.7 ? "dolly-out" : "tracking move";
    const prog = progressOf(pts, (a, b) => Math.max(0, dot3(sub(b, a), line.d)));
    const rot = turn < 4 ? () => qs[0] : slerpBy(prog);
    return mk("dolly", label, clamp(1 - line.res / (0.08 * travel + 0.03), 0.4, 0.95),
      (fr, i) => ({ frame: fr.frame, position: add(first, scl(disp, prog[i])), quaternion: rot(i) }));
  }
  // Arc / orbit around a subject.
  const circ = fitCircleXZ(pts);
  if (circ && circ.r > 0.5 && circ.r < 30 && circ.res < 0.1 * circ.r + 0.03) {
    const ang = pts.map((p) => Math.atan2(p[2] - circ.cz, p[0] - circ.cx));
    for (let i = 1; i < ang.length; i++) { while (ang[i] - ang[i - 1] > Math.PI) ang[i] -= 2 * Math.PI; while (ang[i] - ang[i - 1] < -Math.PI) ang[i] += 2 * Math.PI; }
    const sweep = ((ang[ang.length - 1] - ang[0]) * 180) / Math.PI;
    if (Math.abs(sweep) > 15) {
      const h = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const prog = progressOf(ang.map((a) => [a]), (a, b) => Math.abs(b[0] - a[0]));
      const a0 = ang[0], a1 = ang[ang.length - 1];
      // Keep the operator's framing relative to the centre: the starting offset of the look direction.
      const look0 = norm3(sub([circ.cx, h, circ.cz], first));
      const offset = qmul(qconj(qlookZeroRoll(look0) || [0, 0, 0, 1]), qs[0]); // camera-local framing offset
      return mk("arc", `arc ${sweep > 0 ? "left" : "right"} (${Math.round(Math.abs(sweep))}°)`, clamp(1 - circ.res / (0.1 * circ.r + 0.03), 0.4, 0.95), (fr, i) => {
        const a = lerp(a0, a1, prog[i]);
        const p = [circ.cx + circ.r * Math.cos(a), h, circ.cz + circ.r * Math.sin(a)];
        const look = qlookZeroRoll(norm3(sub([circ.cx, h, circ.cz], p))) || qs[0];
        return { frame: fr.frame, position: p, quaternion: qnorm(qmul(look, offset)) };
      });
    }
  }
  return null;
}

export { DEFAULTS as STABILIZE_DEFAULTS };
