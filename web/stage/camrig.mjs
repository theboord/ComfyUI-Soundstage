// Camera rigs: the shot's keys say where the camera must be and when; the rig says how a real camera support gets
// there. Every rig lands on its marks: the camera passes each key at the key's frame, the way a dolly grip, a crane
// operator or an aerial pilot hits marks for a living. What the rig changes is everything in between:
//   - where the support can physically put the camera (a tripod's legs stay put, a slider is one straight rail, a jib
//     swings its arm round a post, so its moves arc),
//   - its mass: zero-phase springs (run forward, then backward) smooth the speed changes a heavy rig can't make
//     without the lag a one-way spring adds, and focal length rides the same spring so a dolly zoom keeps its subject,
//   - its life: rail rumble, a jib's sway after it stops, an operator's breathing and footsteps, an aerial gimbal's wind drift,
//     an FPV quad banking into its turns. That noise lives in its own arrays and is added after every derivative, so
//     an aerial camera's horizon only tilts when the flight path really turns.
// Keyed roll (a dutch) passes through every rig; a rig's own roll is added on top. Everything is deterministic per
// frame and per shot (rig.seed), so the clay previz, the first frame and the video model all see the same camera.

export const RIGS = {
  free: { label: "Free (keys as set)" },
  tripod: { label: "Tripod (pan / tilt)" },
  dolly: { label: "Dolly on track" },
  chapman: { label: "Chapman dolly (track + boom)" },
  slider: { label: "Slider" },
  jib: { label: "Jib / crane arm" },
  steadicam: { label: "Steadicam" },
  handheld: { label: "Handheld" },
  aerial: { label: "Aerial (gimbal)" },
  aerial_fpv: { label: "Aerial (FPV)" },
};

/** Old rig names still read from saved scenes (renamed to aerial on 2026-11-02): a shot on a "drone" plays as before. */
export const RIG_ALIASES = { drone: "aerial", drone_fpv: "aerial_fpv" };
/** A rig type as it is called now ("drone" -> "aerial"); anything else unchanged. */
export const rigType = (t) => RIG_ALIASES[t] || t;

/**
 * What each support can really do with the camera (metres, m/s, m/s²). The Coach (web/coach/rules.mjs rigLimits)
 * flags a move the rig can't make and offers one that can. travel = how far the camera may leave its first mark.
 */
export const RIG_LIMITS = {
  tripod: { travel: 0.05, why: "a tripod pans and tilts, but its legs stay where they are" },
  slider: { travel: 1.5, speed: 1.0, accel: 2.5, why: "a slider is a 0.6 to 1.5 m rail" },
  dolly: { speed: 2.5, accel: 2.0, why: "grips push a dolly at a brisk walk" },
  chapman: { speed: 2.0, accel: 1.5, why: "a Chapman with its boom weighs half a tonne" },
  jib: { speed: 4.0, accel: 3.0, why: "a counterweighted arm can only swing so fast" },
  steadicam: { speed: 6.0, accel: 3.5, why: "the operator is running with 30 kg on a vest" },
  handheld: { speed: 7.0, accel: 4.0, why: "the operator is sprinting with the camera" },
  aerial: { speed: 20, accel: 6, why: "a cinema aerial rig tops out near 20 m/s" },
  aerial_fpv: { speed: 40, accel: 15, why: "even a racing quad has limits" },
};

/** Arm length limits (m) of the jib: a short jib to a 50 ft telescopic crane. */
export const JIB_ARM = { min: 3, max: 15 };

const G = 9.81;
const D2R = Math.PI / 180;
const FPV_ROLL_RATE = 30 * D2R;   // rad/s: how fast an FPV pilot rolls into a bank
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Smooth value noise (deterministic): sum of a few sines with seeded phases, good enough for camera shake. -1..1.
function noise(seed, t) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < 3; o++) {
    const ph = Math.sin(seed * 12.9898 + o * 78.233) * 43758.5453;
    v += amp * Math.sin(t * f * 2 * Math.PI + (ph - Math.floor(ph)) * 6.283);
    norm += amp; amp *= 0.5; f *= 2.13;
  }
  return v / norm;
}

/**
 * Follow a keyed signal x[f] like a mass on a spring (one way, so it lags): it lags at the start (inertia), overshoots
 * slightly and settles at the stop. omega = stiffness (rad/s), zeta = damping (1 = no overshoot). The camera rigs use
 * zeroPhase() instead (no lag); stunts.mjs uses this for a car body on its springs.
 */
export function springFollow(xs, fps, omega, zeta) {
  const dt = 1 / fps, out = new Array(xs.length);
  let x = xs[0].slice(), v = [0, 0, 0];
  const sub_steps = 4, h = dt / sub_steps;
  for (let f = 0; f < xs.length; f++) {
    for (let s = 0; s < sub_steps; s++) {
      const a = sub(mul(sub(xs[f], x), omega * omega), mul(v, 2 * zeta * omega));
      v = add(v, mul(a, h));
      x = add(x, mul(v, h));
    }
    out[f] = x.slice();
  }
  return out;
}

// A spring with damping 1/sqrt(2) (a 2nd-order Butterworth low-pass), as a biquad from the bilinear transform: exact
// and stable at any stiffness, unlike stepping the spring in time.
function biquad(omega, fps) {
  const K = Math.tan(Math.PI * (omega / (2 * Math.PI)) / fps), n = 1 / (1 + Math.SQRT2 * K + K * K);
  const b0 = K * K * n;
  return { b0, b1: 2 * b0, b2: b0, a1: 2 * (K * K - 1) * n, a2: (1 - Math.SQRT2 * K + K * K) * n };
}

function runBiquad(x, c) {
  const y = new Float64Array(x.length);
  // Start in the steady state of the signal's opening slope (a ramp lags by the filter's delay at DC): no transient.
  const v = x.length > 1 ? x[1] - x[0] : 0, delay = 1 - (c.a1 + 2 * c.a2) / (1 + c.a1 + c.a2);
  let x1 = x[0] - v, x2 = x[0] - 2 * v, y1 = x1 - v * delay, y2 = x2 - v * delay;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * Zero-phase spring: the camera's mass smooths the move (no instant change of speed), run forward and then backward
 * over the shot so it never lags behind the keys. Maximally flat: a path that only eases and cruises passes through
 * almost untouched; what it removes is a sudden kick. xs: numbers or [x, y, z] per frame. omega (rad/s): stiffness;
 * Infinity (or close to the frame rate) = no smoothing. The ends are extended at their own speed, so a camera that is
 * already moving at frame 0 is not treated as starting from rest.
 */
export function zeroPhase(xs, fps, omega) {
  const n = xs.length, vec = Array.isArray(xs[0]);
  const out = xs.map((v) => (vec ? v.slice() : v));
  if (n < 3 || !(omega > 0) || omega / (2 * Math.PI) >= 0.45 * fps) return out;
  const c = biquad(omega, fps);
  const pad = Math.min(8 * fps, Math.max(16, Math.ceil((10 * fps) / omega)));
  const dims = vec ? xs[0].length : 1;
  const x = new Float64Array(n + 2 * pad);
  for (let d = 0; d < dims; d++) {
    const get = vec ? (i) => xs[i][d] : (i) => xs[i];
    const v0 = get(1) - get(0), v1 = get(n - 1) - get(n - 2);
    for (let i = 0; i < x.length; i++) {
      const j = i - pad;
      x[i] = j < 0 ? get(0) + v0 * j : j >= n ? get(n - 1) + v1 * (j - n + 1) : get(j);
    }
    const y = runBiquad(x, c).reverse();
    const z = runBiquad(y, c).reverse();
    for (let j = 0; j < n; j++) { if (vec) out[j][d] = z[j + pad]; else out[j] = z[j + pad]; }
  }
  return out;
}

/**
 * Hit the marks: take whatever the rig added (a spring's smoothing, a jib's sway, an aerial rig's drift) back out at every
 * mark frame, with a smooth bump that only reaches as far as the neighbouring marks (at most `maxW` frames). At a
 * mark the camera is exactly where `base` says, and it keeps the rig's own speed through it (the bump is flat there).
 * out, base: per-frame numbers or vectors (out is changed in place); base null = take the offset to zero.
 */
export function pinToMarks(out, base, pins, maxW = 12) {
  const n = out.length, vec = Array.isArray(out[0]);
  const res = pins.map((k) => (vec ? out[k].map((v, d) => v - (base ? base[k][d] : 0)) : out[k] - (base ? base[k] : 0)));
  pins.forEach((k, i) => {
    const W = Math.max(1, Math.min(maxW, i > 0 ? k - pins[i - 1] : Infinity, i < pins.length - 1 ? pins[i + 1] - k : Infinity));
    const r = res[i];
    for (let f = Math.max(0, Math.ceil(k - W)); f <= Math.min(n - 1, Math.floor(k + W)); f++) {
      const u = (f - k) / W;
      if (Math.abs(u) >= 1) continue;
      const w = (1 - u * u) ** 2;
      if (vec) for (let d = 0; d < r.length; d++) out[f][d] -= r[d] * w;
      else out[f] -= r * w;
    }
  });
  return out;
}

/** The frames the rig must hit: every key inside the shot, plus its first and last frame. */
function marksOf(keyFrames, n) {
  const s = new Set([0, n - 1]);
  for (const f of keyFrames || []) { const r = Math.round(f); if (Number.isFinite(r) && r > 0 && r < n - 1) s.add(r); }
  return [...s].sort((a, b) => a - b);
}

/**
 * How much of a rig's smoothing and drift each frame may take (0..1): keys more than a second apart leave the rig
 * free; keys a few frames apart (and the frames near them) are a move keyed precisely, followed as keyed. Smooth in
 * time, so the rig fades in and out of a precisely keyed passage.
 */
function keyedPrecisely(pins, n, W) {
  const raw = new Array(n).fill(1);
  for (let i = 0; i + 1 < pins.length; i++) {
    const a = pins[i], b = pins[i + 1], u = clamp((b - a - 2) / (2 * W - 2), 0, 1), v = u * u * (3 - 2 * u);
    for (let f = a; f <= b; f++) raw[f] = Math.min(raw[f], v);
  }
  // Reach a little past a precise passage (where a spring would start to anticipate it), then ease in and out.
  const near = raw.map((_, f) => { let m = 1; for (let g = Math.max(0, f - W); g <= Math.min(n - 1, f + W); g++) m = Math.min(m, raw[g]); return m; });
  return near.map((_, f) => { let s = 0, c = 0; for (let g = Math.max(0, f - W); g <= Math.min(n - 1, f + W); g++) { s += near[g]; c++; } return s / c; });
}

/** Speed per frame (m/s) of a path, central differences. */
function speeds(p, fps) {
  const n = p.length;
  return p.map((_, f) => (n < 2 ? 0 : len(sub(p[Math.min(n - 1, f + 1)], p[Math.max(0, f - 1)])) * fps / (Math.min(n - 1, f + 1) - Math.max(0, f - 1))));
}

/** Camera right / up vectors (for aim wander in the frame, not along world axes). */
function frameAxes(pos, tgt) {
  const f = sub(tgt, pos), fl = len(f) || 1, fw = mul(f, 1 / fl);
  let r = cross(fw, [0, 1, 0]);
  const rl = len(r);
  r = rl > 1e-6 ? mul(r, 1 / rl) : [1, 0, 0];
  return { right: r, up: cross(r, fw), dist: fl };
}

/** Rate-limit a signal (radians): a backward pass so it starts early, then a forward pass so it never jumps. */
function rateLimit(xs, step) {
  const n = xs.length, back = xs.slice(), out = xs.slice();
  const toward = (from, to) => from + clamp(to - from, -step, step);
  for (let f = n - 2; f >= 0; f--) back[f] = toward(back[f + 1], xs[f]);
  out[0] = back[0];
  for (let f = 1; f < n; f++) out[f] = toward(out[f - 1], back[f]);
  return out;
}

// Stiffness (rad/s) of each rig's springs at amount 1: the move, the aim (pan / tilt head) and, for the Chapman, the
// boom. Higher = stiffer. Heavier supports smooth more.
const SPRING = {
  tripod: { aim: 14 },
  dolly: { pos: 4.2, aim: 10 },
  chapman: { pos: 3.8, boom: 2.6, aim: 10 },
  slider: { pos: 7, aim: 12 },
  jib: { pos: 3.2, aim: 8 },
  steadicam: { pos: 3.0, aim: 7 },
  handheld: { pos: 5.5, aim: 9 },
  aerial: { pos: 2.4, aim: 6 },
  aerial_fpv: { pos: 3.6, aim: 9 },
};
const TYPE_SEED = { tripod: 1, dolly: 2, chapman: 3, slider: 4, jib: 5, steadicam: 6, handheld: 7, aerial: 8, aerial_fpv: 9 };   // the old drone seeds: a renamed shot shakes the same

/**
 * The jib: an arm of length L (3 to 15 m) turning on a pivot. The first mark sits exactly on the arm (pivot = mark -
 * L * direction, the post behind the camera, the pivot just above the low mark); when both ends of the move can sit
 * on one sphere round a sensible pivot, the arm is sized so they do and the move is a pure arc. Each mark is met with
 * the base where it started, or, for a mark the arm can't reach from there, with the base tracked across the floor as
 * little as possible (a jib on a dolly, a crane on a car). Between the marks the base and the arm's reach follow the
 * keyed move's progress and the arm points at the keyed position, so the camera rides the arm's sphere: rising moves
 * swing, sideways moves arc. Every mark is hit exactly.
 */
function jibArc(P, T, pins, rig) {
  const n = P.length, P0 = P[0], Pn = P[n - 1], dP = sub(Pn, P0);
  let f = sub(T[0], P0); f[1] = 0;
  const fl = Math.hypot(f[0], f[2]);
  f = fl > 1e-6 ? mul(f, 1 / fl) : [0, 0, 1];
  let L = null, C = null;
  const userArm = Number.isFinite(rig.arm) ? clamp(rig.arm, JIB_ARM.min, JIB_ARM.max) : null;
  if (Array.isArray(rig.pivot) && rig.pivot.length === 3 && rig.pivot.every(Number.isFinite)) {
    // A pivot from the user: the arm points from it to the first mark, at the arm's length.
    const d = sub(P0, rig.pivot), dl = len(d);
    const u = dl > 1e-6 ? mul(d, 1 / dl) : [f[0], 0, f[2]];
    L = userArm ?? clamp(dl, JIB_ARM.min, JIB_ARM.max);
    C = sub(P0, mul(u, L));
  } else {
    const H = clamp(Math.min(P0[1], Pn[1]) + 0.4, 1.0, 2.6);   // the pivot on its post, just above the low mark
    let a = P0[1] - H, D = null;
    if (userArm) L = userArm;
    else {
      // Both ends on the arm's sphere: |Pn - C| = |P0 - C| with C = P0 - D f - a y  =>  D = -(|dP|² + 2 a dPy) / (2 dP.f).
      const den = 2 * dot(dP, f);
      if (Math.abs(den) > 1e-3) {
        const Ds = -(dot(dP, dP) + 2 * a * dP[1]) / den, Ls = Math.hypot(Ds, a);
        if (Ds > 0.6) { L = clamp(Ls, JIB_ARM.min, JIB_ARM.max); if (L === Ls) D = Ds; }
      }
      if (L === null) L = clamp(Math.max(4, 1.2 * len(dP)), JIB_ARM.min, JIB_ARM.max);
    }
    if (D === null) { a = clamp(a, -0.94 * L, 0.94 * L); D = Math.sqrt(Math.max(0, L * L - a * a)); }
    C = [P0[0] - f[0] * D, P0[1] - a, P0[2] - f[2] * D];
  }
  const H = C[1];
  // The base (on the floor, at the pivot's height) and the arm's reach at each mark.
  const baseAt = new Map(), reachAt = new Map();
  for (const i of pins) {
    const p = P[i], dy = p[1] - H;
    const Li = Math.abs(dy) > 0.98 * L ? Math.abs(dy) / 0.98 : L;     // straight up out of reach: the arm telescopes
    const h = Math.sqrt(Math.max(0, Li * Li - dy * dy));
    const v = [p[0] - C[0], p[2] - C[2]], vl = Math.hypot(v[0], v[1]);
    const u = vl > 1e-6 ? [v[0] / vl, v[1] / vl] : [f[0], f[2]];
    baseAt.set(i, i === 0 && Li === L ? C.slice() : [p[0] - u[0] * h, H, p[2] - u[1] * h]);
    reachAt.set(i, Li);
  }
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + len(sub(P[i], P[i - 1])));
  const path = new Array(n), bases = new Array(n);
  let lastDir = null;
  for (let i = 0; i + 1 < pins.length; i++) {
    const a = pins[i], b = pins[i + 1], ds = s[b] - s[a];
    const Ba = baseAt.get(a), Bb = baseAt.get(b), La = reachAt.get(a), Lb = reachAt.get(b);
    for (let g = a; g <= b; g++) {
      const u = ds > 1e-9 ? (s[g] - s[a]) / ds : (g - a) / Math.max(1, b - a);
      const B = add(Ba, mul(sub(Bb, Ba), u)), Lr = La + (Lb - La) * u;
      const q = sub(P[g], B), ql = len(q);
      const dir = ql > 0.05 ? mul(q, 1 / ql) : (lastDir || [f[0], 0, f[2]]);
      lastDir = dir;
      path[g] = g === a || g === b ? P[g].slice() : add(B, mul(dir, Lr));
      bases[g] = B;
    }
  }
  const travel = Math.max(...bases.map((B) => Math.hypot(B[0] - C[0], B[2] - C[2])));
  return { path, info: { arm: +L.toFixed(3), pivot: C.map((v) => +v.toFixed(3)), travel: +travel.toFixed(3) } };
}

/** A slider is one straight rail: from the first mark to the farthest point of the move. */
function onRail(P) {
  const a = P[0];
  let b = a, far = 0;
  for (const p of P) { const d = len(sub(p, a)); if (d > far) { far = d; b = p; } }
  if (far < 1e-6) return { path: P.map((p) => p.slice()), run: 0 };
  const dir = mul(sub(b, a), 1 / far);
  return { path: P.map((p) => add(a, mul(dir, clamp(dot(sub(p, a), dir), 0, far)))), run: +far.toFixed(3) };
}

/** Signed sideways acceleration (m/s², + = turning left) of a path, per frame. */
function lateralAccel(p, fps) {
  const n = p.length, out = new Array(n).fill(0);
  for (let f = 0; f < n; f++) {
    const a0 = p[Math.max(0, f - 1)], a1 = p[f], a2 = p[Math.min(n - 1, f + 1)];
    if (f === 0 || f === n - 1) continue;
    const v = mul(sub(a2, a0), fps / 2), acc = mul(add(sub(a2, a1), sub(a0, a1)), fps * fps);
    const vh = Math.hypot(v[0], v[2]);
    if (vh < 1e-3) continue;
    out[f] = ((v[2] * acc[0] - v[0] * acc[2]) / vh) * clamp((vh - 0.3) / 1.2, 0, 1);   // hovering: no bank
  }
  out[0] = out[1] ?? 0;
  out[n - 1] = out[n - 2] ?? 0;
  return out;
}

/**
 * Apply a rig to a sampled camera path. path: [{position, target, focal_mm, roll?, ...}] for every frame of the shot
 * (the keys only, no rig), in the space the rig works in (a ride-along shot's host space). rig: {type, amount (0..2,
 * default 1; 0 = the keys exactly), seed?, arm?, pivot?}. opts: {keyFrames: frames of the camera keys (the marks),
 * toWorld(frame, point): host -> world for a ride-along (an FPV quad banks with its real flight), noise: false = the
 * rig's motion without its shake}. Returns the same shape with roll (radians) = keyed roll + the rig's own roll; the
 * array's `info` says what the rig did ({arm, pivot, travel} for a jib, {run} for a slider, ...).
 */
export function applyRig(path, rig, fps = 24, opts = {}) {
  const type = RIGS[rigType(rig?.type)] ? rigType(rig.type) : "free";
  const n = path.length;
  const k = clamp(Number.isFinite(rig?.amount) ? rig.amount : 1, 0, 2);
  if (type === "free" || !n || !(k > 0)) return path;
  const P = path.map((c) => [...c.position]), T = path.map((c) => [...c.target]);
  const F = path.map((c) => (Number.isFinite(c.focal_mm) ? c.focal_mm : 35));
  const pins = marksOf(opts.keyFrames, n);
  const seed = (Number.isFinite(rig.seed) ? rig.seed : 7) * 1.37 + TYPE_SEED[type] * 101;
  const noiseOn = opts.noise !== false;
  const sp = SPRING[type];
  const W = Math.max(2, Math.round(fps * 0.5));
  const t = (f) => f / fps;
  const info = { type };

  // 1. Where the support can put the camera.
  let base = P;
  if (type === "tripod") base = P.map(() => P[0].slice());
  else if (type === "slider") { const r = onRail(P); base = r.path; info.run = r.run; }
  else if (type === "jib") { const j = jibArc(P, T, pins, rig); base = j.path; Object.assign(info, j.info); }
  else if (type === "dolly") {
    // On a track laid through the marks; the camera height stays locked unless the keys ask for a height change.
    const ys = pins.map((f) => P[f][1]);
    if (Math.max(...ys) - Math.min(...ys) < 1e-3) base = P.map((p) => [p[0], ys[0], p[2]]);
  }

  // 2. Mass: zero-phase springs (no lag), pinned on the marks. Focal rides the move's spring (a dolly zoom holds).
  //    Keys a few frames apart are a move keyed precisely (a whip pan, a snap zoom): there the rig follows them as
  //    keyed instead of smoothing it and pulling it back at each key.
  const free = keyedPrecisely(pins, n, W);
  const settle = (raw, keyed) => raw.map((v, f) => (Array.isArray(v) ? v.map((x, d) => keyed[f][d] + (x - keyed[f][d]) * free[f]) : keyed[f] + (v - keyed[f]) * free[f]));
  let pos = sp.pos ? zeroPhase(base, fps, sp.pos / k) : base.map((p) => p.slice());
  if (type === "chapman") {
    const boom = zeroPhase(base.map((p) => p[1]), fps, sp.boom / k);
    for (let f = 0; f < n; f++) pos[f][1] = boom[f];
  }
  pos = pinToMarks(settle(pos, base), base, pins, W);
  const tgt = pinToMarks(settle(zeroPhase(T, fps, sp.aim / k), T), T, pins, W);
  const foc = pinToMarks(settle(zeroPhase(F, fps, (sp.pos || sp.aim) / k), F), F, pins, W);

  const v = speeds(pos, fps);
  const moving = v.map((x) => clamp(x / 1.2, 0, 1));
  // Footsteps: the cadence rises with speed (walk ~1.8 steps/s, run ~2.9).
  const stepPhase = [0];
  for (let f = 1; f < n; f++) stepPhase.push(stepPhase[f - 1] + (2 * Math.PI * (1.7 + 0.3 * Math.min(v[f], 4))) / fps);

  // 3. The rig's life, in separate arrays: low = slow drift / sway (taken out at the marks), high = shake (kept).
  const low = P.map(() => [0, 0, 0]), high = P.map(() => [0, 0, 0]);
  const aimLow = P.map(() => [0, 0, 0]), aimHigh = P.map(() => [0, 0, 0]);
  const rollLow = new Array(n).fill(0), rollHigh = new Array(n).fill(0);
  if (type === "dolly" || type === "chapman" || type === "slider") {
    // Rail rumble while moving; on a dolly track, a bump at each rail joint (every 1.2 m).
    const amp = { dolly: 0.0018, chapman: 0.0014, slider: 0.0006 }[type], jointAmp = { dolly: 0.004, chapman: 0.003, slider: 0 }[type];
    let travelled = 0;
    for (let f = 1; f < n; f++) {
      travelled += len(sub(pos[f], pos[f - 1]));
      const jd = (travelled % 1.2) - 0.6;
      const joint = Math.exp(-(jd * jd) / 0.004) * jointAmp * Math.min(1, v[f]);
      const j = noise(seed, t(f) * 9) * amp * Math.min(1, v[f] / 0.8) + joint;
      high[f][1] += j;
      aimHigh[f][1] += j * 1.6;
    }
  } else if (type === "jib") {
    // The arm flexes: the camera lags the arm's accelerations and sways after a stop (longer arm = slower sway). The
    // flex saturates at 12 cm: past that a real arm is being thrown about, which the Coach flags (rigLimits).
    const ws = 2 * Math.PI * clamp(4.5 / info.arm, 0.4, 1.6), zs = 0.12, sub_steps = 8, h = 1 / (fps * sub_steps);
    let x = [0, 0, 0], u = [0, 0, 0];
    for (let f = 1; f < n; f++) {
      const acc = f < n - 1 ? mul(add(sub(pos[f + 1], pos[f]), sub(pos[f - 1], pos[f])), fps * fps) : [0, 0, 0];
      for (let s = 0; s < sub_steps; s++) {
        const a = sub(mul(acc, -0.6), add(mul(x, ws * ws), mul(u, 2 * zs * ws)));
        u = add(u, mul(a, h));
        x = add(x, mul(u, h));
      }
      const sw = [x[0] * 0.6, x[1], x[2] * 0.6], m = len(sw);
      low[f] = m > 1e-9 ? mul(sw, (0.12 * Math.tanh(m / 0.12)) / m) : sw;
    }
  } else if (type === "steadicam") {
    for (let f = 0; f < n; f++) {
      low[f] = [noise(seed, t(f) * 0.3) * 0.016, noise(seed + 1, t(f) * 0.25) * 0.008, noise(seed + 2, t(f) * 0.3) * 0.016];
      high[f][1] = ((1 - Math.cos(stepPhase[f])) / 2) * 0.006 * moving[f];     // the arm soaks up most of each step
      const ax = frameAxes(pos[f], tgt[f]);
      aimLow[f] = add(mul(ax.right, noise(seed + 4, t(f) * 0.2) * 0.003 * ax.dist), mul(ax.up, noise(seed + 5, t(f) * 0.17) * 0.002 * ax.dist));
      rollHigh[f] = noise(seed + 3, t(f) * 0.2) * 0.012;
    }
  } else if (type === "handheld") {
    for (let f = 0; f < n; f++) {
      // Breathing and the body's sway (slow), shake (fast), a dip on every footstep while walking.
      low[f] = [noise(seed, t(f) * 0.22) * 0.01, Math.sin(t(f) * 2 * Math.PI * 0.25) * 0.008, noise(seed + 1, t(f) * 0.2) * 0.01];
      high[f] = [noise(seed + 2, t(f) * 6) * 0.0035, noise(seed + 3, t(f) * 7) * 0.0035 - Math.abs(Math.sin(stepPhase[f] / 2)) * 0.02 * moving[f],
        noise(seed + 4, t(f) * 5) * 0.003];
      // The aim wanders more than the body: small pan / tilt errors in the frame, at the target distance.
      const ax = frameAxes(pos[f], tgt[f]);
      aimLow[f] = add(mul(ax.right, noise(seed + 5, t(f) * 0.6) * 0.012 * ax.dist), mul(ax.up, noise(seed + 6, t(f) * 0.5) * 0.009 * ax.dist));
      aimHigh[f] = add(mul(ax.right, noise(seed + 7, t(f) * 8) * 0.0025 * ax.dist), mul(ax.up, noise(seed + 8, t(f) * 9) * 0.0025 * ax.dist));
      rollHigh[f] = noise(seed + 9, t(f) * 0.4) * 0.012 + noise(seed + 10, t(f) * 6) * 0.003;
    }
  } else if (type === "aerial") {
    // GPS hold and wind: a slow drift of a centimetre or so; the gimbal keeps the horizon level (a slow drift < 0.1°).
    for (let f = 0; f < n; f++) {
      low[f] = [noise(seed, t(f) * 0.5) * 0.012, noise(seed + 1, t(f) * 0.4) * 0.008, noise(seed + 2, t(f) * 0.45) * 0.012];
      rollLow[f] = noise(seed + 3, t(f) * 0.05) * 0.0016;
    }
  } else if (type === "aerial_fpv") {
    for (let f = 0; f < n; f++) {
      low[f] = [noise(seed, t(f) * 0.8) * 0.015, noise(seed + 1, t(f) * 0.7) * 0.012, noise(seed + 2, t(f) * 0.8) * 0.015];
      high[f] = [noise(seed + 4, t(f) * 11) * 0.0008, noise(seed + 5, t(f) * 13) * 0.0008, noise(seed + 6, t(f) * 12) * 0.0008];
    }
  }
  if (noiseOn) {
    for (let f = 0; f < n; f++) { low[f] = mul(low[f], free[f]); aimLow[f] = mul(aimLow[f], free[f]); rollLow[f] *= free[f]; }
    pinToMarks(low, null, pins, W); pinToMarks(aimLow, null, pins, W); pinToMarks(rollLow, null, pins, W);
  }

  // 4. An FPV quad banks into its turns: atan(v² k / g) along its flight path before any shake (in the world, for a
  //    quad chasing a car), low-passed like the spring, never rolling faster than 30°/s.
  let bank = null;
  if (type === "aerial_fpv") {
    const wp = opts.toWorld ? base.map((p, f) => opts.toWorld(f, p)) : base;
    const target = zeroPhase(lateralAccel(wp, fps).map((a) => clamp(Math.atan(a / G), -60 * D2R, 60 * D2R) * k), fps, 4);
    bank = rateLimit(target, FPV_ROLL_RATE / fps);
  }

  const out = path.map((c, f) => {
    const s = noiseOn ? k : 0;
    return {
      ...c,
      position: add(pos[f], mul(add(low[f], high[f]), s)),
      target: add(tgt[f], mul(add(aimLow[f], aimHigh[f]), s)),
      focal_mm: foc[f],
      roll: (Number.isFinite(c.roll) ? c.roll : 0) + (bank ? bank[f] : 0) + (rollLow[f] + rollHigh[f]) * s,
    };
  });
  out.info = info;
  return out;
}

/**
 * The most a camera track asks of its rig: peak speed (m/s) and acceleration (m/s²), smoothed over a quarter second
 * so shake doesn't count, and how far it travels from its first frame (m). track: [{position}] per frame.
 */
export function rigMotion(track, fps = 24) {
  const p = track.map((c) => c.position), n = p.length;
  if (n < 3) return { speed: 0, accel: 0, travel: 0, at: 0 };
  const w = Math.max(1, Math.round(fps / 8));
  const vel = p.map((_, f) => { const a = Math.max(0, f - w), b = Math.min(n - 1, f + w); return mul(sub(p[b], p[a]), fps / Math.max(1, b - a)); });
  let speed = 0, accel = 0, travel = 0, at = 0;
  for (let f = 0; f < n; f++) {
    const s = len(vel[f]);
    if (s > speed) { speed = s; at = f; }
    const a = Math.max(0, f - w), b = Math.min(n - 1, f + w);
    accel = Math.max(accel, len(sub(vel[b], vel[a])) * fps / Math.max(1, b - a));
    travel = Math.max(travel, len(sub(p[f], p[0])));
  }
  return { speed, accel, travel, at };
}
