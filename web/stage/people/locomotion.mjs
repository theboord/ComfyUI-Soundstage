// Human locomotion (the "people walk like robots" fix, 2026-11-08): the pure rules that make a keyed person move like a
// person, not a cart on a rail. No three.js scene, no clock: every table is a function of the keys and the frame, so
// renders and any scrub order give the same frame.
//
//   timing   retimeTable: along the SAME path through the keys, a person starts from standing and speeds up over
//            about two steps (START_S), slows into a stop (STOP_S), slows a little on a tight curve, and the speed is
//            continuous through the middle keys (no step in speed at a key). Every key is still hit on its frame.
//   heading  smoothHeadings: the body turns a little before the path does (BODY_LEAD_S) and eases into and out of a
//            turn (no constant-rate spin that starts and stops dead).
//   gait     cadenceHz / naturalStride: walking cadence and stride BOTH grow with speed (1.6-2.0 steps a second over
//            1.0-1.8 m/s for a 1.8 m person; longer legs step slower); the clip's leg swing is scaled to that stride
//            (strideScale) instead of the clip being played faster.
//   body     bodyTable: the upper body leans into a speed-up, brakes and settles (a damped pitch) at a stop, banks a
//            little into a curve, and the head turns into a turn before the body (HEAD_LEAD_S).
//   person   personStyle: each person their own tempo (+-4 %), arm swing (+-12 %) and breathing rate (the idle's
//            own pace: avatarcore.idlePace).
//   idle     breathAt: a slow breath in the chest while standing (the clips' idle keeps its own weight shifts).
//
// Measured before (tests/js/locomotion.test.mjs, the audit in CHANGELOG 2026-11-08): a 0 -> 0.77 m/s start in one
// frame (9.8 m/s^2) and a stop from 0.87 m/s in one frame (10.9 m/s^2), the idle -> walk crossfade in 3 frames, a stride
// fixed at the clip's 1.2 m so the cadence ran 1.2 -> 2.9 steps a second from 0.7 to 1.7 m/s, the thigh and arm swing
// the same at every speed, four men walking side by side at exactly the same tempo and arm swing, the head never ahead
// of the body.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const smooth = (a, b, x) => sstep((x - a) / (b - a));
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));

/** Switches for A/B checks (all on): retime the path, ease the heading, scale the stride, the upper-body layer, the
 *  eased idle <-> walk crossfade. */
export const OPTS = { retime: true, heading: true, stride: false, layer: true, blend: false };

/** Person kinds the human locomotion applies to. */
export const HUMAN_KINDS = new Set(["man", "woman", "child"]);
/** Seconds to speed up from standing (about two steps) and to slow into a stop. */
export const TIMING = { start: 0.7, stop: 0.45, curve: 0.75 };
export const START_S = TIMING.start, STOP_S = TIMING.stop;
/** Seconds the body faces the path ahead of where it is, and the head ahead of the body. */
export const BODY_LEAD_S = 0.2;
export const HEAD_LEAD_S = 0.4;
/** The body's turn is eased over about this long either way (seconds, a Gaussian's sigma). */
export const TURN_EASE_S = 0.15;
export const HEADING = { lead: BODY_LEAD_S, ease: TURN_EASE_S };

// ------------------------------------------------------------------------------------------------ timing
/**
 * The retimed path (frame -> the original path's time): {f0, f1, tw} with tw[i] the original time for frame f0 + i.
 * keys: [{frame, position}] sorted by frame; at(t) the original path's position [x, y, z] at time t (frames).
 * A run is the keys between two stops (the first key, a hold of two keys at one spot, the last key). Within a run the
 * person speeds up from 0 over START_S, keeps a speed that follows the keys' own pace smoothly (continuous through the
 * middle keys), slows a little where the path curves tightly, and slows to 0 over STOP_S. Each key is reached on its
 * own frame (tw = the key's frame there), so blocking is unchanged; only how the person gets there is.
 * first / last: the shot's first and last frames. A run that starts on the shot's first frame is already walking when
 * the shot starts (no speed-up: they walk into the shot), and one that ends on its last frame walks on out of it; a
 * run from the shot's first frame to its last keeps the path's own timing (FLAW: its speed still steps at a middle
 * key; smoothing it there broke the foot planner on a U-turn keyed without a stop). Keys a frame or two apart (a
 * recorded Drive take or capture) are not retimed: null.
 */
export function retimeTable(keys, at, { fps = 24, sub = 8, first = -Infinity, last = Infinity } = {}) {
  const n = keys?.length || 0;
  if (n < 2) return null;
  const f0 = Math.floor(keys[0].frame), f1 = Math.ceil(keys[n - 1].frame);
  const tw = new Float64Array(f1 - f0 + 1);
  for (let i = 0; i < tw.length; i++) tw[i] = f0 + i;
  const moving = (k) => {
    const a = keys[k].position, b = keys[k + 1].position;
    return keys[k + 1].frame - keys[k].frame > 1e-6 && !a.every((x, c) => Math.abs(x - b[c]) < 1e-4);
  };
  // a recorded take (Drive, a capture: keys a frame or two apart) already moves like the person who played it
  const gaps = []; for (let i = 1; i < n; i++) gaps.push(keys[i].frame - keys[i - 1].frame);
  gaps.sort((x, y) => x - y);
  if (gaps[gaps.length >> 1] <= 2) return null;
  let k = 0;
  while (k < n - 1) {
    if (!moving(k)) { k++; continue; }
    let e = k;
    while (e + 1 < n - 1 && moving(e + 1)) e++;
    const starts = keys[k].frame > first, stops = keys[e + 1].frame < last;
    // walked through the whole shot (from its first frame to its last, no stop in it): the path's own timing
    if (starts || stops) retimeRun(keys, k, e + 1, at, tw, f0, fps, sub, starts, stops);
    k = e + 1;
  }
  return { f0, f1, tw };
}

/** The original time for frame f (fractional frames between table entries are linear; outside: unchanged). */
export function warpAt(tab, f) {
  if (!tab || !(f > tab.f0) || f >= tab.f1) return f;
  const x = f - tab.f0, i = Math.floor(x), u = x - i;
  return u < 1e-9 ? tab.tw[i] : tab.tw[i] + (tab.tw[i + 1] - tab.tw[i]) * u;
}

function retimeRun(keys, i0, i1, at, tw, f0, fps, sub, starts = true, stops = true) {
  const T0 = keys[i0].frame, T1 = keys[i1].frame, h = 1 / sub;
  const N = Math.max(2, Math.round((T1 - T0) * sub)), dt = (T1 - T0) / N;
  // the original path, densely: time, arc length, and where each key's frame falls
  const t = new Float64Array(N + 1), A = new Float64Array(N + 1), P = [];
  for (let j = 0; j <= N; j++) { t[j] = T0 + j * dt; P.push(at(t[j])); }
  for (let j = 1; j <= N; j++) A[j] = A[j - 1] + Math.hypot(P[j][0] - P[j - 1][0], P[j][2] - P[j - 1][2]);
  if (A[N] < 1e-4) return;
  const knot = []; for (let k = i0; k <= i1; k++) knot.push(Math.round((keys[k].frame - T0) / dt));
  const S = knot.length - 1;
  // curvature (1/m) along the path, smoothed over about 0.4 s: a tight curve is walked a little slower
  const yaw = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) { const a = P[Math.max(0, j - 1)], b = P[Math.min(N, j + 1)]; yaw[j] = Math.atan2(b[0] - a[0], b[2] - a[2]); }
  const kap = new Float64Array(N + 1);
  const win = Math.max(1, Math.round(0.2 * fps / dt));
  for (let j = 0; j <= N; j++) {
    const a = Math.max(0, j - win), b = Math.min(N, j + win), ds = A[b] - A[a];
    kap[j] = ds > 0.05 ? Math.abs(wrap(yaw[b] - yaw[a])) / ds : 0;
  }
  // radius under 2.5 m: slower, down to 75 % at a 0.6 m radius (people slow on a tight turn)
  const g = Array.from(kap, (c) => clamp(Math.sqrt(1 / Math.max(1e-6, c) / 2.5), TIMING.curve, 1));
  // the envelope: from standing over START_S, into the stop over STOP_S (shortened on a short run)
  const dur = (T1 - T0) / fps, sa = Math.min(TIMING.start, 0.4 * dur) * fps, sd = Math.min(TIMING.stop, 0.35 * dur) * fps;
  const env = Array.from(t, (x) => (starts ? sstep((x - T0) / sa) : 1) * (stops ? sstep((T1 - x) / sd) : 1));
  // the keys' own pace per segment, made continuous through the middle keys and then scaled per segment so each key
  // is reached on its frame (a few passes: the per-segment scales come out nearly equal on both sides of a key)
  const D = [], c = [];
  for (let s = 0; s < S; s++) { D.push(A[knot[s + 1]] - A[knot[s]]); c.push(D[s] / Math.max(1e-9, (knot[s + 1] - knot[s]) * dt)); }
  const kv = new Float64Array(S + 1);
  kv[0] = c[0]; kv[S] = c[S - 1];
  for (let s = 1; s < S; s++) kv[s] = 0.5 * (c[s - 1] + c[s]);
  const u = new Float64Array(N + 1), m = new Float64Array(S);
  const shape = () => {
    for (let s = 0; s < S; s++) {
      const a = knot[s], b = knot[s + 1];
      let area = 0;
      for (let j = a; j <= b; j++) {
        const x = b > a ? (j - a) / (b - a) : 0;
        u[j] = (kv[s] + (kv[s + 1] - kv[s]) * x) * env[j] * g[j];
        if (j > a) area += 0.5 * (u[j] + u[j - 1]) * dt;
      }
      m[s] = area > 1e-12 ? D[s] / area : 1;
    }
  };
  for (let it = 0; it < 40; it++) {
    shape();
    kv[0] *= m[0]; kv[S] *= m[S - 1];
    for (let s = 1; s < S; s++) kv[s] *= 0.5 * (m[s - 1] + m[s]);
  }
  shape();
  // the new arc length over time, exact at every key (per-segment trapezoid sums scaled by m)
  const Sn = new Float64Array(N + 1);
  for (let s = 0; s < S; s++) {
    const a = knot[s], b = knot[s + 1];
    Sn[a] = A[a];
    for (let j = a + 1; j <= b; j++) Sn[j] = Sn[j - 1] + 0.5 * (u[j] + u[j - 1]) * dt * m[s];
    Sn[b] = A[b];
  }
  // invert: for each frame, the original time at which the original path had walked that far
  let q = 0;
  for (let F = Math.ceil(T0); F <= Math.floor(T1); F++) {
    const x = (F - T0) / dt, j = Math.min(N - 1, Math.floor(x)), w = x - j;
    const s = Sn[j] + (Sn[Math.min(N, j + 1)] - Sn[j]) * w;
    while (q < N - 1 && A[q + 1] < s) q++;
    while (q > 0 && A[q] > s) q--;
    const span = A[q + 1] - A[q];
    tw[F - f0] = span > 1e-12 ? t[q] + clamp((s - A[q]) / span, 0, 1) * dt : t[q];
  }
  for (const k of [i0, i1]) { const F = keys[k].frame; if (Number.isInteger(F)) tw[F - f0] = F; }
  for (let k = i0 + 1; k < i1; k++) { const F = keys[k].frame; if (Number.isInteger(F)) tw[F - f0] = F; }
}

// ------------------------------------------------------------------------------------------------ heading
/**
 * Ease a person's heading table (radians per frame, already rate-limited): led by BODY_LEAD_S (the body faces where
 * the path goes a moment later) and smoothed with a Gaussian of TURN_EASE_S, on the unwrapped angle, so a turn starts
 * and ends gently. The first and last frames keep their own values (a key's Turn is where they stand).
 */
export function smoothHeadings(h, fps = 24, { lead = HEADING.lead, ease = HEADING.ease } = {}) {
  const n = h.length;
  if (n < 3) return h.slice();
  const un = new Float64Array(n);
  un[0] = h[0];
  for (let f = 1; f < n; f++) un[f] = un[f - 1] + wrap(h[f] - h[f - 1]);
  const L = Math.round(lead * fps), sig = ease * fps, R = Math.ceil(3 * sig);
  const led = Array.from({ length: n }, (_, f) => un[Math.min(n - 1, f + L)]);
  const out = new Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0, w = 0;
    for (let j = -R; j <= R; j++) { const x = led[clamp(f + j, 0, n - 1)], k = Math.exp(-0.5 * (j / sig) ** 2); s += k * x; w += k; }
    out[f] = wrap(s / w);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ gait
/** Walking cadence (steps a second) at speed v (m/s) for a person this tall: 1.6 at 1.0 m/s, 1.82 at 1.35, 2.0 at
 *  1.75 (1.8 m tall); longer legs step slower at the same speed (Froude scaling). */
export function cadenceHz(v, height = 1.8, kind = "walk") {
  const k = Math.sqrt(height / 1.8), u = Math.max(0, v) / k;
  const c = kind === "run" ? clamp(2.75 * Math.pow(Math.max(u, 1e-3) / 3.0, 0.3), 2.3, 3.4) : clamp(1.82 * Math.pow(Math.max(u, 1e-3) / 1.35, 0.4), 1.4, 2.15);
  return c / k;
}

/** The natural stride (m per gait loop = two steps) at speed v, walk and run blended by the clip weights w. */
export function naturalStride(v, w, height = 1.8, tempo = 1) {
  const ww = w.walk || 0, wr = w.run || 0, s = Math.max(v, 0.15);
  const sw = (2 * s) / (cadenceHz(s, height, "walk") * tempo), sr = (2 * s) / (cadenceHz(s, height, "run") * tempo);
  if (ww + wr < 1e-9) return sw;
  return (ww * sw + wr * sr) / (ww + wr);
}

/** The leg swing is scaled at most this much either way (the rest of the speed is cadence): a longer swing than this
 *  puts a planted foot out of the leg's reach (the pelvis drops for it) and the clip's foot roll stops matching. */
export const STRIDE_RANGE = [0.92, 1.1];

/** How far the mixed clip's leg swing is scaled so its stride is the natural one (1 when standing). */
export function strideScale(natural, clipStride, moveWeight) {
  const s = clamp(natural / Math.max(1e-6, clipStride), STRIDE_RANGE[0], STRIDE_RANGE[1]);
  return 1 + (s - 1) * sstep(moveWeight / 0.5);
}

// ------------------------------------------------------------------------------------------------ the person
/** A stable per-person number in [0, 1) for a named trait (FNV-1a). */
export function seedOf(id, trait = "") {
  let h = 2166136261;
  for (const ch of `${id ?? ""}|${trait}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

/** Each person's own way of moving: tempo (cadence factor), arm swing, breathing rate (Hz). (The idle's pace is
 *  avatarcore.idlePace, from the phase seed.) */
export function personStyle(id) {
  return {
    tempo: 0.96 + 0.08 * seedOf(id, "tempo"),
    arms: 0.88 + 0.24 * seedOf(id, "arms"),
    breathHz: 0.21 + 0.08 * seedOf(id, "breath"),
    breathPhase: seedOf(id, "breathPhase"),
  };
}

/** Arm swing grows with walking speed (about 0.7x at 0.6 m/s, 1x at 1.3, 1.2x at 1.8); the person's own factor on top. */
export const armScale = (v, own = 1) => own * clamp(0.5 + 0.38 * Math.max(0, v), 0.65, 1.25);

/** The breath (-1 .. 1) at frame f for a person's style. */
export const breathAt = (f, fps, st) => Math.sin(2 * Math.PI * (f / fps * st.breathHz + st.breathPhase));

/**
 * The upper body's per-frame motion over the shot from the gait's speed (m/s per frame) and the headings (radians):
 *   lean[f]   pitch (rad, + forward): a damped spring driven by the acceleration, so the body leans into a speed-up,
 *             leans back to brake, and rocks forward and settles once stopped;
 *   bank[f]   roll (rad, + toward the body's left): into a curve, by the centripetal pull (v x turn rate), sprung;
 *   look[f]   head yaw off the body (rad): toward the heading HEAD_LEAD_S ahead, at most 30 degrees.
 */
export function bodyTable(speed, headings, fps = 24) {
  const n = speed.length, lean = new Float64Array(n), bank = new Float64Array(n), look = new Float64Array(n);
  const acc = new Float64Array(n);
  for (let f = 0; f < n; f++) { const a = Math.max(0, f - 2), b = Math.min(n - 1, f + 2); acc[f] = b > a ? (speed[b] - speed[a]) * fps / (b - a) : 0; }
  const turn = new Float64Array(n);
  if (headings) for (let f = 0; f < n; f++) { const a = Math.max(0, f - 2), b = Math.min(n - 1, f + 2); turn[f] = b > a ? wrap(headings[b] - headings[a]) * fps / (b - a) : 0; }
  // second-order springs (deterministic, run over the whole shot): ~1.6 Hz, under-damped so a stop rocks once and settles
  const spring = (target, out, w0, zeta) => {
    let x = 0, vx = 0;
    const dt = 1 / fps, sub = 4, h = dt / sub;
    for (let f = 0; f < n; f++) {
      for (let s = 0; s < sub; s++) { const ax = w0 * w0 * (target[f] - x) - 2 * zeta * w0 * vx; vx += ax * h; x += vx * h; }
      out[f] = x;
    }
  };
  spring(Array.from(acc, (a) => clamp(0.03 * a, -0.06, 0.06)), lean, 2 * Math.PI * 1.6, 0.42);
  spring(Array.from(turn, (w, f) => clamp(0.6 * Math.atan(speed[f] * w / 9.81), -0.1, 0.1)), bank, 2 * Math.PI * 1.2, 0.7);
  if (headings) {
    const L = Math.round(HEAD_LEAD_S * fps), max = (30 * Math.PI) / 180;
    for (let f = 0; f < n; f++) look[f] = clamp(0.7 * wrap(headings[Math.min(n - 1, f + L)] - headings[f]), -max, max);
    // eased (a short moving average), so the head doesn't snap at a key
    const tmp = Float64Array.from(look);
    for (let f = 0; f < n; f++) { let s = 0, c = 0; for (let j = -3; j <= 3; j++) { const i = f + j; if (i >= 0 && i < n) { s += tmp[i]; c++; } } look[f] = s / c; }
  }
  return { lean, bank, look };
}

/** Speed bands are avatarcore's; this is the shared moving weight (walk + run) of clip weights. */
export const moveWeight = (w) => (w.walk || 0) + (w.run || 0);
export { smooth as _smooth };
