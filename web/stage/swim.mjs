// Swimming: the water counterpart of gait.mjs. Divers under water (flutter kick, frog kick, hover) and swimmers at the
// surface (freestyle, breaststroke, treading water), with the physics that sets how they move:
//
//  - Cadence from the speed. A fin kick works like a fish tail: the Strouhal number St = f A / v (f the kick rate, A the
//    fin tip's peak-to-peak sweep) sits near 0.6 for a finned diver, so a diver cruising at 0.4-0.6 m/s kicks at
//    0.5-1 Hz with the tips sweeping 0.35-0.6 m. Faster means bigger kicks before quicker ones (the cadence stays in
//    0.5-1 Hz). Freestyle: 30-55 arm cycles a minute with a six-beat kick; breaststroke: pull, kick, glide.
//  - Thrust against drag. Each style's thrust comes in pulses (two downbeats per flutter cycle, one frog kick, two
//    breaststroke pulses), drag is 1/2 rho Cd A v^2, and the effective mass includes the water carried along. A short
//    periodic simulation per style and speed gives the surge: the speed rises on each kick and decays through the
//    glide (tau = m / (k v), several seconds for a diver), and the body is moved along its path by that zero-mean
//    displacement, so the frog kick visibly lunges and coasts while the keyed path is still met on average.
//  - Trim and buoyancy. A diver lies level (head a touch up), pitched along the climb, banked into turns. Breathing
//    changes the lungs by ~2.5 L: an inhale lifts the diver a few centimetres and tips the chest up, a beat later (the
//    lag of a heavy body in water). Every 3-5 s (seeded per diver) the exhale leaves the regulator as a burst of bubbles.
//  - The body. Flutter: hip-driven kicks with the knee folding at the top of the upbeat and snapping straight through the
//    downbeat, feet pointed, a small counter-wave up the spine (the S-curve) and heave at twice the kick rate.
//    Freestyle: the body rolls about 37 degrees toward the pulling arm, a high-elbow catch, the arm recovering high and
//    wide, the head turning with the roll to breathe. Fins flex: the blade bends against its own velocity through the
//    water (the load ~ v^2) and snaps through at each stroke reversal.
//  - Gear (gear: "scuba" by default under water): tank, buoyancy jacket, weight belt, mask, long fins, and the
//    regulator's second stage IN the mouth (the mouthpiece between the teeth), its hose over the right shoulder to the
//    first stage on the tank valve. Secondary motion: fins bend, strap tails and long hair stream back and drift with
//    the current, the hose follows the head.
// Pure functions of the keys and the frame (as gait.mjs), so renders and scrubbing always give the same pose.
import * as THREE from "../vendor/three.module.min.mjs";
import { feetOf } from "./mocap.mjs";
import { currentAt, patchCaustics } from "./water.mjs";
import { softSprite } from "./sets/common.mjs";
import { seedNumber } from "./waves.mjs";

/** The soft round sprite foam and bubbles are drawn with. */
export const foamSprite = () => softSprite();

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);
const wrapPi = (x) => Math.atan2(Math.sin(x), Math.cos(x));
/** Seeded hash in [0, 1). */
export const hash01 = (a, b = 0, c = 0) => { const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return s - Math.floor(s); };
export const seedOf = (id) => [...String(id || "s")].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 100003, 7);

export const WATER = Object.freeze({ rho: 1025, g: 9.81, patm: 101325 });
export const STYLES = ["flutter", "frog", "hover", "freestyle", "breaststroke", "tread"];
/** Poses the water track sets per frame (buoyancy.mjs personTrack): never picked by speed. */
export const TRACK_STYLES = ["struggle", "limp", "limp_floor", "backfloat", "fall", "kickup", "wade"];
const UNDER = new Set(["flutter", "frog", "hover"]);
/** Strouhal number of a finned human kick (fish and dolphins cruise at 0.2-0.4; a diver's fins are less efficient). */
export const STROUHAL = 0.6;

/** Body constants at 1.8 m: mass (kg, a diver with ~25 kg of kit), added-mass share, axial drag area Cd*A (m^2). */
export const BODY = Object.freeze({ diver: { mass: 105, added: 0.15, cda: 0.14 }, swimmer: { mass: 75, added: 0.2, cda: 0.11 } });

/**
 * Which style a swimmer uses: `override` (the actor's `swim`: flutter | frog | freestyle | breaststroke | stroke |
 * tread) wins where it fits the place; otherwise under water a diver flutter-kicks (hovers when nearly still), and at the
 * surface a swimmer treads water when still, breaststrokes slowly and swims freestyle above ~0.75 m/s.
 * Returns {weights: {style: w}, main}.
 */
export function styleWeights(mode, v, override = null) {
  const w = {};
  if (mode === "under") {
    const move = sstep(0.07, 0.2, v);
    const style = override === "frog" ? "frog" : "flutter";
    w[style] = move; w.hover = 1 - move;
  } else {
    const move = sstep(0.07, 0.22, v);
    let fast = sstep(0.62, 0.88, v);
    if (override === "freestyle") fast = 1;
    if (override === "breaststroke") fast = 0;
    w.freestyle = move * fast; w.breaststroke = move * (1 - fast); w.tread = 1 - move;
  }
  for (const k of Object.keys(w)) if (w[k] < 1e-4) delete w[k];
  const main = Object.entries(w).sort((p, q) => q[1] - p[1])[0]?.[0] || (mode === "under" ? "hover" : "tread");
  return { weights: w, main };
}

/**
 * One style's cadence at speed v (m/s) for a person `height` tall: freq (full cycles per second: one kick of each leg,
 * or one arm cycle), tip (flutter: fin-tip peak-to-peak sweep, m), and the leg amplitudes the pose uses.
 */
export function swimGait(style, v, height = 1.8) {
  const k = height / 1.8, u = Math.max(0, v);
  if (style === "flutter") {
    let tip = clamp(0.32 + 0.22 * u, 0.32, 0.6) * k;
    let freq = STROUHAL * u / tip;
    if (freq < 0.5) { freq = 0.5; tip = Math.max(0.12 * k, STROUHAL * u / freq); }
    if (freq > 1.0) { freq = 1.0; tip = Math.min(0.78 * k, STROUHAL * u / freq); }
    return { style, freq, tip, hip: tip / (3.3 * k), knee: 0.1 + 0.4 * tip / k };
  }
  if (style === "hover") return { style, freq: 0.32, tip: 0.08 * k, hip: 0.03, knee: 0.12 };
  if (style === "frog") return { style, freq: clamp(0.22 + 0.42 * u, 0.28, 0.55), tip: 0.5 * k, hip: 0.45, knee: 1.25 };
  if (style === "freestyle") return { style, freq: clamp(0.36 + 0.3 * u, 0.5, 0.92), tip: 0.3 * k, hip: 0.16, knee: 0.35 };
  if (style === "breaststroke") return { style, freq: clamp(0.42 + 0.3 * u, 0.5, 0.95), tip: 0.4 * k, hip: 0.6, knee: 2.0 };
  if (style === "struggle") return { style, freq: 0.8, tip: 0.05 * k, hip: 0.1, knee: 0.3 };   // the arms' press, ~0.8 Hz
  if (style === "limp" || style === "limp_floor") return { style, freq: 0.15, tip: 0, hip: 0, knee: 0 };
  if (style === "backfloat") return { style, freq: 0.25, tip: 0.02 * k, hip: 0.05, knee: 0.1 };
  if (style === "fall") return { style, freq: 0.5, tip: 0, hip: 0, knee: 0 };
  if (style === "kickup") return { style, freq: 0.9, tip: 0.35 * k, hip: 0.4, knee: 1.2 };   // swimming up from a plunge
  if (style === "wade") return { style, freq: 0.2, tip: 0, hip: 0, knee: 0 };
  return { style: "tread", freq: 0.75, tip: 0.2 * k, hip: 0.25, knee: 1.4 };
}

/** Thrust share over a cycle (phase u in [0, 1)) and the drag-area multiplier at that moment, per style. */
function thrustShape(style, u) {
  const pulse = (a, b) => (u >= a && u < b ? Math.sin(Math.PI * (u - a) / (b - a)) ** 2 : 0);
  switch (style) {
    case "flutter": return { T: 0.25 + Math.abs(Math.sin(TAU * u)) ** 1.6, D: 1 };                       // a downbeat per leg
    case "frog": return { T: pulse(0.05, 0.3), D: u > 0.72 || u < 0.05 ? 1.6 : 1 };                         // kick, coast, recover
    case "freestyle": return { T: 0.35 + pulse(0.1, 0.55) + pulse(0.6, 1.05) + pulse(-0.4, 0.05), D: 1 };   // two pulls + kick
    // the leg recovery is the brake: heels drawn up into the flow (and the limbs swung forward against it)
    case "breaststroke": return { T: 0.75 * pulse(0.02, 0.3) + 1.3 * pulse(0.46, 0.6), D: u > 0.28 && u < 0.47 ? 5.5 : 1 };
    default: return { T: 0, D: 1 };
  }
}

const _surge = new Map();
/**
 * The speed and displacement through one cycle of a style at mean speed v: a periodic simulation of
 * m_eff dv/dt = T(u) - 1/2 rho CdA(u) v^2 with the thrust scaled so the cycle-mean speed is v.
 * Returns {disp: Float32Array(64) (m, zero mean, along the heading), vmin, vmax} (cached per style and 5 cm/s).
 */
export function surgeProfile(style, v, height = 1.8) {
  const vq = Math.round(Math.max(0, v) * 20) / 20;
  const key = `${style}|${vq}|${Math.round(height * 20)}`;
  if (_surge.has(key)) return _surge.get(key);
  const N = 64, out = { disp: new Float32Array(N), vmin: vq, vmax: vq };
  const g = swimGait(style, vq, height), k = height / 1.8;
  if (vq < 0.05 || style === "hover" || style === "tread") { _surge.set(key, out); return out; }
  const B = UNDER.has(style) ? BODY.diver : BODY.swimmer;
  const m = B.mass * k ** 3 * (1 + B.added), kd = 0.5 * WATER.rho * B.cda * k * k;
  const P = 1 / g.freq, steps = 256, dt = P / steps;
  let c = kd * vq * vq * 1.6, vs = null, xs = null;
  for (let it = 0; it < 6; it++) {
    let vel = vq, x = 0;
    vs = new Float32Array(steps); xs = new Float32Array(steps);
    for (let cyc = 0; cyc < 6; cyc++) {
      x = 0;
      for (let i = 0; i < steps; i++) {
        const sh = thrustShape(style, i / steps);
        vel += (c * sh.T - kd * sh.D * vel * Math.abs(vel)) / m * dt;
        x += vel * dt;
        if (cyc === 5) { vs[i] = vel; xs[i] = x; }
      }
    }
    const mean = x / P;
    c *= (vq / Math.max(1e-3, mean)) ** 2;      // thrust ~ v^2 at the drag balance
  }
  const mean = xs[steps - 1] / P;
  let avg = 0;
  const d = new Float32Array(steps);
  for (let i = 0; i < steps; i++) { d[i] = xs[i] - mean * (i + 1) * dt; avg += d[i]; }
  avg /= steps;
  for (let j = 0; j < N; j++) out.disp[j] = d[Math.floor(j / N * steps)] - avg;
  out.vmin = Math.min(...vs); out.vmax = Math.max(...vs);
  _surge.set(key, out);
  return out;
}
const sampleLoop = (arr, u) => { const n = arr.length, x = frac(u) * n, i = Math.floor(x), t = x - i; return lerp(arr[i % n], arr[(i + 1) % n], t); };

// ------------------------------------------------------------------ breathing, buoyancy, bubbles
/**
 * The breath at time t (s) for a seed: a 3-5 s cycle (seeded), inhale ~38 %, exhale ~60 %. lung 0..1 (full at the end
 * of the inhale); exhale: 0..1 through the exhale, or -1 while inhaling.
 */
export function breathAt(t, seed = 1) {
  seed = seedNumber(seed);
  const period = 3 + 2 * hash01(seed, 3.1), off = hash01(seed, 7.7) * period;
  const b = frac((t + off) / period), INH = 0.38, HOLD = 0.02;
  const lung = b < INH ? sstep(0, INH, b) : b < INH + HOLD ? 1 : 1 - sstep(INH + HOLD, 1, b);
  return { period, b, lung, exhale: b >= INH + HOLD ? (b - INH - HOLD) / (1 - INH - HOLD) : -1, start: t - (b - INH - HOLD) * period, index: Math.floor((t + off) / period) };
}

/**
 * Heave (m) and pitch (rad, + = chest up) from breathing: ~2.5 L of lung volume is ~25 N of lift on a diver, answered
 * by drag a beat later (a heavy body in water lags its lungs by about a quarter cycle).
 */
export function buoyancyAt(t, seed = 1, height = 1.8) {
  const lag = 0.9;
  const l0 = breathAt(t - lag, seed).lung, mean = 0.55;
  return { dy: 0.05 * (height / 1.8) * (l0 - mean), pitch: -0.035 * (l0 - mean) };
}

/** Rise speed (m/s) of an air bubble of equivalent diameter d (m) in sea water. */
export function bubbleRise(d) {
  if (d < 0.002) return 0.11 * d / 0.001;                     // small: nearly spherical, ~0.1-0.22 m/s
  if (d < 0.015) return 0.24;                                  // wobbling ellipsoids
  return 0.711 * Math.sqrt(WATER.g * d);                       // spherical caps (Davies & Taylor)
}
/** A bubble's diameter after rising from depth z0 to z (m below the surface): Boyle's law, d ~ P^(-1/3). */
export function bubbleGrow(d0, z0, z) {
  const P = (zz) => WATER.patm + WATER.rho * WATER.g * Math.max(0, zz);
  return d0 * Math.cbrt(P(z0) / P(z));
}

/**
 * Every exhaled bubble alive at time t for one diver: bursts at each exhale carrying the breath's 1-2 L (a gush of big
 * cap bubbles in the first moments, a fizz of smaller ones after), rising at their size's speed, growing as the pressure drops, wobbling, and
 * drifting with the current, gone at the surface. emitAt(te) -> [x, y, z] the regulator's exhaust then.
 * Returns {pos: number[] (x, y, z ...), size: number[] (m)}.
 */
export function exhaleBubbles(seed, t, emitAt, { surface = 10, perBreath = 64, maxAge = 40, current = null } = {}) {
  const pos = [], size = [];
  seed = seedNumber(seed);   // a string seed would concatenate ("3" + 13.1 * idx), a missing one put every bubble on one spot
  const br = breathAt(t, seed), P = br.period;
  for (let n = 0; n < Math.ceil(maxAge / P) + 1; n++) {
    const start = br.start - n * P;
    if (start > t) continue;
    const idx = br.index - n, dur = 0.6 * P;
    for (let i = 0; i < perBreath; i++) {
      const r1 = hash01(seed + idx * 13.1, i, 1), r2 = hash01(seed + idx * 13.1, i, 2), r3 = hash01(seed + idx * 13.1, i, 3);
      const te = start + dur * r1 * r1 * 0.9;                  // front-loaded: most of the breath goes out first
      if (te > t) continue;
      // a breath is ~1-2 L of gas: most of it leaves in the first gush as a column of big wobbling caps (3-6.5 cm),
      // with a fizz of millimetre bubbles shed around them and trailing after
      const big = r2 < 0.6 && r1 < 0.55;
      const d0 = big ? 0.03 + 0.035 * r3 : 0.0015 + 0.006 * r3;
      const p0 = emitAt(te);
      const z0 = surface - p0[1];
      const age = t - te;
      // rise with the growing bubble's speed (two-step integration is plenty: the speed changes slowly)
      let y = p0[1], d = d0;
      const steps = 3, h = age / steps;
      for (let s = 0; s < steps; s++) { d = bubbleGrow(d0, z0, surface - y); y += bubbleRise(d) * h; }
      if (y >= surface - 0.02 || age > maxAge) continue;
      const cu = current ? current(p0[0], y, p0[2], te + age) : [0, 0, 0];
      const wob = big ? 0.02 : 0.012, wf = big ? 2.2 : 5.5 + 3 * r2;
      const x = p0[0] + cu[0] * age + wob * Math.sin(wf * age * TAU + i) + (r2 - 0.5) * 0.06 * Math.min(1, age);
      const z = p0[2] + cu[2] * age + wob * Math.cos(wf * age * TAU * 0.9 + i * 1.3) + (r3 - 0.5) * 0.06 * Math.min(1, age);
      pos.push(x, y, z); size.push(bubbleGrow(d0, z0, surface - y));
    }
  }
  return { pos, size };
}

// ------------------------------------------------------------------ the plan
/**
 * Plan a swimmer's motion from their keyed path. pos[f] = [x, y, z] (the figure's origin, keyed), yaw[f]; mode[f]:
 * "under" | "surface" | null (not swimming that frame). Returns per frame the speed, style weights, the cycle phase
 * (integrated, so the cadence changes smoothly with speed), the surge offset along the heading, climb and turn rates.
 */
export function planSwim({ pos, yaw, mode, fps = 24, height = 1.8, style = null, seed = 1, gear = "scuba", styles = null, hipsY = null, hipsW = null }) {
  const n = pos.length, last = n - 1;
  const P = (f) => pos[clamp(f, 0, last)];
  const raw = [], vy = [];
  for (let f = 0; f < n; f++) {
    const a = P(f - 1), b = P(f + 1), d = f === 0 || f === last ? 1 : 2;
    raw.push(Math.hypot(b[0] - a[0], b[2] - a[2]) * fps / d);
    vy.push((b[1] - a[1]) * fps / d);
  }
  const smooth = (arr, r = 3) => arr.map((_, f) => { let s = 0, c = 0; for (let j = -r; j <= r; j++) if (f + j >= 0 && f + j < n) { s += arr[f + j]; c++; } return s / c; });
  const speed = smooth(raw), climbV = smooth(vy);
  const yawRate = yaw.map((_, f) => wrapPi(yaw[Math.min(last, f + 1)] - yaw[Math.max(0, f - 1)]) * fps / Math.max(1, Math.min(last, f + 1) - Math.max(0, f - 1)));
  const weights = [], freq = [], phase = [0], surge = [], main = [];
  // The water track's own poses (buoyancy.mjs: a drop, a struggle, a limp sink, a back float) override the speed's,
  // cross-faded over +-6 frames so a change of pose never pops. Plans without them are unchanged.
  const track = styles && styles.some(Boolean);
  const raw0 = [];
  for (let f = 0; f < n; f++) {
    const m = mode[f] || "under";
    const sw = styles?.[f] ? { weights: { [styles[f]]: 1 }, main: styles[f] } : styleWeights(m, speed[f], style === "stroke" ? "flutter" : style);
    raw0.push(sw);
  }
  for (let f = 0; f < n; f++) {
    let sw = raw0[f];
    if (track) {
      const acc = {};
      let c = 0;
      for (let j = -6; j <= 6; j++) {
        const q = raw0[clamp(f + j, 0, last)];
        for (const [k, w] of Object.entries(q.weights)) acc[k] = (acc[k] || 0) + w;
        c++;
      }
      for (const k of Object.keys(acc)) acc[k] /= c;
      sw = { weights: acc, main: Object.entries(acc).sort((p, q) => q[1] - p[1])[0][0] };
    }
    weights.push(sw.weights); main.push(sw.main);
    let fr = 0;
    for (const [k, w] of Object.entries(sw.weights)) fr += w * swimGait(k, speed[f], height).freq;
    freq.push(fr);
    if (f > 0) phase.push(phase[f - 1] + (freq[f - 1] + fr) / 2 / fps);
  }
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (const [k, w] of Object.entries(weights[f])) s += w * sampleLoop(surgeProfile(k, speed[f], height).disp, phase[f]);
    surge.push(s);
  }
  const out = { n, fps, height, seed, style, gear, pos, yaw, mode: mode.slice(), speed, climbV, yawRate, weights, main, freq, phase, surge };
  if (track) out.styles = styles.slice();
  if (hipsY && hipsW && hipsW.some((w) => w > 0)) { out.hipsY = hipsY.slice(); out.hipsW = hipsW.slice(); }
  return out;
}

/**
 * The pose at frame f as numbers (tests read it; applySwim puts it on the figure). Angles in radians on the clay
 * figure's joints: hip/knee/shoulder/elbow .x (flexion: hip and shoulder negative, knee positive, elbow negative), .z
 * (abduction: away from the body is -side), the shoe's extra pitch (+ = toes pointed), the fin blade's bend, the body's
 * pitch (pi/2 = lying level), roll about the long axis and heave, and the head / neck.
 */
export function poseAt(plan, f) {
  const fq = clamp(f, 0, plan.n - 1), f0 = Math.floor(fq), f1 = Math.min(plan.n - 1, f0 + 1), u = fq - f0;
  const fi = clamp(Math.round(f), 0, plan.n - 1), t = fq / plan.fps;
  const v = lerp(plan.speed[f0], plan.speed[f1], u), W = plan.weights[fi], ph = lerp(plan.phase[f0], plan.phase[f1], u), h = plan.height;
  const out = { legs: { l: { hip: [0, 0, 0], knee: 0, shoe: 0, bend: 0 }, r: { hip: [0, 0, 0], knee: 0, shoe: 0, bend: 0 } },
    arms: { l: { sh: [0, 0, 0], el: 0 }, r: { sh: [0, 0, 0], el: 0 } }, pitch: 0, roll: 0, heave: 0, spine: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0] };
  const acc = (dst, src, w) => {
    for (const lr of ["l", "r"]) {
      const a = dst.legs[lr], b = src.legs[lr];
      for (let i = 0; i < 3; i++) a.hip[i] += w * b.hip[i];
      a.knee += w * b.knee; a.shoe += w * b.shoe; a.bend += w * (b.bend || 0);
      const c = dst.arms[lr], d = src.arms[lr];
      for (let i = 0; i < 3; i++) c.sh[i] += w * d.sh[i];
      c.el += w * d.el;
    }
    for (const k of ["pitch", "roll", "heave"]) dst[k] += w * src[k];
    for (const k of ["spine", "neck", "head"]) for (let i = 0; i < 3; i++) dst[k][i] += w * src[k][i];
  };
  let wsum = 0;
  for (const [k, w] of Object.entries(W)) { acc(out, stylePose(k, ph, v, h, t, plan), w); wsum += w; }
  if (wsum > 0 && Math.abs(wsum - 1) > 1e-6) {
    const s = 1 / wsum;
    for (const lr of ["l", "r"]) { const a = out.legs[lr]; a.hip = a.hip.map((x) => x * s); a.knee *= s; a.shoe *= s; a.bend *= s; out.arms[lr].sh = out.arms[lr].sh.map((x) => x * s); out.arms[lr].el *= s; }
    for (const k of ["pitch", "roll", "heave"]) out[k] *= s;
    for (const k of ["spine", "neck", "head"]) out[k] = out[k].map((x) => x * s);
  }
  // Climb / dive: pitched along the vertical velocity. Turns: banked (a diver leans into a turn like a glider).
  const under = (plan.mode[fi] || "under") === "under";
  if (under && !plan.styles?.[fi]) {
    out.pitch -= clamp(Math.atan2(plan.climbV[fi], Math.max(0.25, v)), -0.6, 0.6);
    const by = buoyancyAt(t, plan.seed, h);
    out.pitch += by.pitch; out.heave += by.dy;
  }
  out.roll += clamp(Math.atan2(v * plan.yawRate[fi], WATER.g) * 2.2, -0.45, 0.45);
  return out;
}

/** One style's pose at cycle phase ph (cycles), speed v, time t. */
function stylePose(style, ph, v, h, t, plan) {
  const g = swimGait(style, v, h);
  const P = { legs: { l: { hip: [0, 0, 0], knee: 0, shoe: 0 }, r: { hip: [0, 0, 0], knee: 0, shoe: 0 } },
    arms: { l: { sh: [0, 0, 0], el: 0 }, r: { sh: [0, 0, 0], el: 0 } }, pitch: Math.PI / 2, roll: 0, heave: 0, spine: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0] };
  const side = { l: 1, r: -1 };
  if (UNDER.has(style)) {
    // Trim: level, head a touch up; arms folded under the chest (hands together), head up to look ahead and down.
    P.pitch = Math.PI / 2 - 0.1;
    const reach = plan?.style === "stroke";
    for (const lr of ["l", "r"]) {
      P.arms[lr].sh = reach ? [-2.85, 0, -side[lr] * 0.12] : [-0.62, 0, -side[lr] * 0.5];
      P.arms[lr].el = reach ? -0.12 : -2.1;
    }
    P.neck = [-0.42, 0, 0]; P.head = [-0.4, 0, 0];
  }
  if (style === "flutter" || style === "hover") {
    for (const lr of ["l", "r"]) {
      const q = TAU * (ph + (lr === "r" ? 0.5 : 0));
      // hip: the downbeat is flexion (toward the front = down); slight extension bias keeps the fins off the reef
      const hip = -g.hip * Math.sin(q) + 0.04;
      // the knee folds as the thigh starts down (top of the upbeat) and snaps straight through the downbeat
      const kb = Math.pow(0.5 + 0.5 * Math.cos(q + Math.PI / 2 - 0.35), 2);
      P.legs[lr].hip = [hip, 0, side[lr] * -0.03];
      P.legs[lr].knee = 0.1 + g.knee * kb;
      P.legs[lr].shoe = 0.95 + 0.12 * Math.sin(q + 0.6);
    }
    // the counter-wave up the body (S-curve) and heave at twice the kick rate
    P.spine = [0.03 * Math.sin(TAU * ph * 2 + 1.2), 0, 0];
    P.heave = 0.012 * (h / 1.8) * Math.sin(TAU * ph * 2 + 0.4) * clamp(g.tip / 0.4, 0.3, 1.6);
    P.pitch += 0.015 * Math.sin(TAU * ph * 2 + 2.0);
  } else if (style === "frog") {
    const u = frac(ph);
    // recovery (0.75 -> 1.05): knees drawn up, fins up, knees spread; power (0.05 -> 0.3): extend and sweep together
    const power = sstep(0.05, 0.3, u), rec = sstep(0.72, 1.0, u) + (u < 0.05 ? 1 : 0);
    const bent = u < 0.05 ? 1 : u < 0.3 ? 1 - power : rec;
    for (const lr of ["l", "r"]) {
      P.legs[lr].hip = [0.12 - 0.25 * bent, 0, -side[lr] * (0.08 + 0.4 * bent * (u < 0.3 ? 1 - power * 0.6 : 1))];
      P.legs[lr].knee = 0.4 + 1.2 * bent;
      P.legs[lr].shoe = 0.45 + 0.5 * (1 - bent) + 0.35 * Math.sin(Math.PI * power) * (u < 0.3 ? 1 : 0);
    }
    P.pitch = Math.PI / 2 - 0.06;
  } else if (style === "freestyle") {
    // Body roll toward the pulling arm, high-elbow catch, high wide recovery, six-beat kick, breathe to the right.
    const R = 0.62;
    P.pitch = Math.PI / 2 - 0.05;
    P.roll = -R * Math.sin(TAU * ph);
    for (const lr of ["l", "r"]) {
      const u = frac(ph + (lr === "r" ? 0.5 : 0));
      let sx, sz = 0, el;
      if (u < 0.6) {                                             // entry -> catch -> pull -> push under the body
        const k = Math.pow(sstep(0, 0.6, u), 1.15);
        sx = -Math.PI + Math.PI * k; el = -(0.15 + 1.45 * Math.pow(Math.sin(Math.PI * u / 0.6), 1.4));
        sz = side[lr] * 0.12 * Math.sin(Math.PI * u / 0.6);
      } else {                                                    // recovery: out at the hip, elbow high, forward
        const k = (u - 0.6) / 0.4;
        sx = Math.PI * k; el = -(0.25 + 1.5 * Math.sin(Math.PI * k));
        sz = -side[lr] * 1.15 * Math.sin(Math.PI * k);
      }
      P.arms[lr].sh = [sx, 0, sz]; P.arms[lr].el = el;
      const q = TAU * (3 * ph + (lr === "r" ? 0.5 : 0));        // six-beat kick: three per leg per arm cycle
      P.legs[lr].hip = [-0.16 * Math.sin(q) + 0.05, 0, 0];
      P.legs[lr].knee = 0.12 + 0.35 * Math.pow(0.5 + 0.5 * Math.cos(q + Math.PI / 2 - 0.35), 2);
      P.legs[lr].shoe = 0.9 + 0.1 * Math.sin(q + 0.6);
    }
    const breathe = Math.pow(Math.max(0, Math.sin(TAU * ph)), 2);   // right shoulder up: the mouth clears the water
    P.neck = [-0.12, -0.75 * breathe, 0]; P.head = [-0.08, -0.55 * breathe, 0];
    P.spine = [0, 0.06 * Math.sin(TAU * ph), 0.05 * Math.sin(TAU * ph)];
  } else if (style === "breaststroke") {
    const u = frac(ph);
    const pull = sstep(0.0, 0.28, u), insweep = sstep(0.22, 0.38, u), shoot = sstep(0.42, 0.6, u);
    for (const lr of ["l", "r"]) {
      // streamline -> out and down -> hands together under the chin -> shoot forward -> glide
      const out = Math.sin(Math.PI * clamp(u / 0.32, 0, 1));
      const sx = u < 0.42 ? lerp(-3.0, -1.55, pull) + 0.3 * insweep : lerp(-1.25, -3.0, shoot);
      P.arms[lr].sh = [sx, 0, -side[lr] * (0.75 * out * (1 - insweep * 0.8)) + side[lr] * 0.18 * insweep * (1 - shoot)];
      P.arms[lr].el = u < 0.42 ? -(0.1 + 1.0 * pull + 1.0 * insweep) : -(2.1 * (1 - shoot) + 0.08);
      // kick: heels drawn up (0.3-0.45), whip out and back together (0.45-0.62), glide straight
      const rec = sstep(0.28, 0.45, u) * (1 - sstep(0.45, 0.62, u)), whip = Math.sin(Math.PI * clamp((u - 0.45) / 0.17, 0, 1));
      P.legs[lr].hip = [-0.55 * rec, 0, -side[lr] * (0.15 * rec + 0.42 * whip)];
      P.legs[lr].knee = 0.06 + 1.95 * rec + 0.6 * whip * (1 - sstep(0.5, 0.62, u));
      P.legs[lr].shoe = 0.85 - 0.95 * rec;
    }
    const up = Math.sin(Math.PI * clamp((u - 0.08) / 0.34, 0, 1));   // head and shoulders rise to breathe on the pull
    P.pitch = Math.PI / 2 - 0.1 - 0.3 * up;
    P.neck = [-0.25 - 0.3 * up, 0, 0]; P.head = [-0.15 - 0.2 * up, 0, 0];
  } else if (style === "struggle") {
    // The instinctive drowning response (Pia 1974): upright, head tilted back, mouth at the water; the arms press down
    // at the sides like climbing a ladder, no kick, no wave for help, no headway.
    P.pitch = 0.06;
    for (const lr of ["l", "r"]) {
      const q = TAU * (ph + (lr === "r" ? 0.5 : 0));
      P.arms[lr].sh = [-0.35 - 0.45 * Math.sin(q), 0, -side[lr] * (1.25 + 0.3 * Math.sin(q))];
      P.arms[lr].el = -0.5 - 0.35 * Math.max(0, Math.sin(q));
      P.legs[lr].hip = [-0.22 + 0.06 * Math.sin(q + 1), 0, -side[lr] * 0.08];
      P.legs[lr].knee = 0.45 + 0.12 * Math.sin(q + 1);
      P.legs[lr].shoe = 0.4;
    }
    P.neck = [-0.35, 0, 0]; P.head = [-0.3, 0, 0];
  } else if (style === "limp") {
    // Gone under: limp and near vertical, the arms drifting up and out, knees soft, head bowed.
    P.pitch = 0.12;
    for (const lr of ["l", "r"]) {
      P.arms[lr].sh = [-0.9 + 0.05 * Math.sin(TAU * ph + (lr === "r" ? 1 : 0)), 0, -side[lr] * 0.55];
      P.arms[lr].el = -0.45;
      P.legs[lr].hip = [-0.3, 0, -side[lr] * 0.1];
      P.legs[lr].knee = 0.55;
      P.legs[lr].shoe = 0.5;
    }
    P.neck = [0.35, 0, 0]; P.head = [0.25, 0, 0];
  } else if (style === "limp_floor") {
    // On the bottom: settled on the back, arms out, knees soft (no walking under water).
    P.pitch = -1.45;
    for (const lr of ["l", "r"]) {
      P.arms[lr].sh = [-0.4, 0, -side[lr] * 0.9]; P.arms[lr].el = -0.6;
      P.legs[lr].hip = [-0.35, 0, -side[lr] * 0.12]; P.legs[lr].knee = 0.6; P.legs[lr].shoe = 0.4;
    }
    P.neck = [-0.1, 0, 0]; P.head = [0.1, 0, 0];
  } else if (style === "backfloat") {
    // Floating on the back: face up, the legs sinking ~35 degrees (the chest floats, the hips are heavier), arms out
    // sculling gently.
    P.pitch = -(Math.PI / 2 - 0.6);
    for (const lr of ["l", "r"]) {
      const sc = Math.sin(TAU * ph + (lr === "r" ? Math.PI : 0));
      P.arms[lr].sh = [-0.2, side[lr] * 0.15 * sc, -side[lr] * 1.3]; P.arms[lr].el = -0.2 - 0.1 * sc;
      P.legs[lr].hip = [0.05, 0, -side[lr] * 0.15]; P.legs[lr].knee = 0.15; P.legs[lr].shoe = 0.6;
    }
    P.neck = [-0.2, 0, 0]; P.head = [-0.35, 0, 0];
  } else if (style === "fall") {
    // Dropping in feet first: straight legs, toes pointed, arms up.
    P.pitch = 0;
    for (const lr of ["l", "r"]) {
      P.arms[lr].sh = [-2.6, 0, -side[lr] * 0.35]; P.arms[lr].el = -0.3;
      P.legs[lr].hip = [0, 0, -side[lr] * 0.03]; P.legs[lr].knee = 0.1; P.legs[lr].shoe = 0.9;
    }
  } else if (style === "kickup") {
    // Swimming straight up out of a plunge: near upright, head back to look at the light, both arms sweeping down from
    // overhead to the thighs (a vertical breaststroke pull) and a whip kick on the pull: a swim pose, never standing.
    const u = frac(ph), pull = sstep(0.05, 0.5, u), rec = sstep(0.6, 0.95, u);
    P.pitch = 0.18;
    for (const lr of ["l", "r"]) {
      const sx = -2.8 + 2.4 * pull - 2.4 * rec * pull;
      P.arms[lr].sh = [sx, 0, -side[lr] * (0.35 + 0.5 * Math.sin(Math.PI * pull))];
      P.arms[lr].el = -(0.2 + 0.9 * rec);
      const draw = sstep(0.6, 0.9, u) + (u < 0.1 ? 1 - sstep(0, 0.1, u) : 0), whip = Math.sin(Math.PI * clamp((u - 0.1) / 0.3, 0, 1));
      P.legs[lr].hip = [-0.35 * draw, 0, -side[lr] * (0.1 + 0.3 * whip)];
      P.legs[lr].knee = 0.1 + 1.3 * draw;
      P.legs[lr].shoe = 0.9 - 0.5 * draw;
    }
    P.neck = [-0.35, 0, 0]; P.head = [-0.3, 0, 0];
  } else if (style === "wade") {
    // Standing on the bottom in water they can stand in (after a drop into the shallows): upright, the arms out on
    // the water for balance, a slow sway.
    P.pitch = 0.02 * Math.sin(TAU * ph);
    for (const lr of ["l", "r"]) {
      P.arms[lr].sh = [-0.35, 0, -side[lr] * (0.55 + 0.05 * Math.sin(TAU * ph + (lr === "r" ? 1 : 0)))]; P.arms[lr].el = -0.35;
      P.legs[lr].hip = [-0.04, 0, -side[lr] * 0.05]; P.legs[lr].knee = 0.08; P.legs[lr].shoe = 0;
    }
  } else if (style === "tread") {
    // Upright, eggbeater legs (alternating circular kicks), hands sculling flat at the water.
    P.pitch = 0.2;
    for (const lr of ["l", "r"]) {
      const q = TAU * (ph + (lr === "r" ? 0.5 : 0));
      P.legs[lr].hip = [-0.95 + 0.12 * Math.cos(q), side[lr] * 0.25 * Math.sin(q), -side[lr] * (0.45 + 0.15 * Math.sin(q))];
      P.legs[lr].knee = 1.45 + 0.35 * Math.sin(q + 0.8);
      P.legs[lr].shoe = 0.3;
      const sc = Math.sin(TAU * ph * 1.0 + (lr === "r" ? Math.PI : 0));
      P.arms[lr].sh = [-0.55, side[lr] * 0.35 * sc, -side[lr] * 0.55];
      P.arms[lr].el = -0.55;
    }
    P.heave = 0.03 * (h / 1.8) * Math.sin(TAU * ph * 2);
    P.neck = [0.05, 0, 0];
  }
  return P;
}

// ------------------------------------------------------------------ on the figure
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _v = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

/**
 * The body transform at frame f: where the hips are (world) and the figure's orientation. ctx: {surface (water level
 * at the surface, or the reef's surface), mode, hipY (figure-space hip height, scaled)}.
 */
export function bodyAt(plan, f, pose, ctx) {
  const fq = clamp(f, 0, plan.n - 1), f0 = Math.floor(fq), f1 = Math.min(plan.n - 1, f0 + 1), u = fq - f0, fi = Math.round(fq);
  const p = [0, 1, 2].map((i) => lerp(plan.pos[f0][i], plan.pos[f1][i], u)), yaw = plan.yaw[f0] + wrapPi(plan.yaw[f1] - plan.yaw[f0]) * u;
  const mode = plan.mode[fi] || "under";
  const hipY = ctx.hipY;
  const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw).multiply(_qa.setFromAxisAngle(X, pose.pitch)).multiply(_qb.setFromAxisAngle(Y, pose.roll));
  const fwd = [Math.sin(yaw), Math.cos(yaw)];
  const s = lerp(plan.surge[f0], plan.surge[f1], u);
  let hips;
  if (mode === "surface") {
    const k = plan.height / 1.8;
    const tread = (plan.weights[fi].tread || 0);
    // level: the back just awash (hips ~12 cm under); treading: upright, the chin at the water
    const yLevel = ctx.surface - 0.12 * k, yTread = ctx.surface - 0.52 * k;
    hips = [p[0] + fwd[0] * s, lerp(yLevel, yTread, tread) + pose.heave, p[2] + fwd[1] * s];
  } else hips = [p[0] + fwd[0] * s, p[1] + hipY + pose.heave, p[2] + fwd[1] * s];
  // The water track (buoyancy.mjs): a drop in, a kick up, a struggle, a slow sink, a back float puts the hips there.
  if (plan.hipsW) {
    const w = lerp(plan.hipsW[f0], plan.hipsW[f1], u);
    if (w > 0) {
      const a = plan.hipsY[f0] ?? plan.hipsY[f1], b = plan.hipsY[f1] ?? a;
      if (a != null) hips[1] = lerp(hips[1], lerp(a, b, u), w);
    }
  }
  return { hips, q };
}

/** Put a swimmer's pose on the clay figure g at frame f. ctx: {surface, hipY?, current?, caustics?, kit?}. */
export function applySwim(g, plan, f, ctx = {}) {
  const J = g.userData.joints;
  if (!J) return null;
  const hipY = (J.l_hip?.position.y || 0.9 * plan.height) * (g.scale.y || 1);
  const fi = clamp(Math.round(f), 0, plan.n - 1);
  // Fin flex: the blade bends against its own velocity through the water (the load ~ v |v|), a beat late (its
  // inertia and the water it carries). Measured on the posed figure half a frame either side, along the blade normal.
  const kit = g.userData.swimKit, fins = kit?.visible ? kit.userData.fins || [] : [];
  const bends = {};
  if (fins.length && ctx.flex !== false) {
    const lag = 0.3, at = (q) => {
      putPose(g, plan, q, poseAt(plan, q), hipY, ctx);
      g.updateMatrixWorld(true);
      return fins.map(({ blade }) => ({ tip: new THREE.Vector3(0, 0, blade.userData.L).applyMatrix4(blade.matrixWorld),
        n: new THREE.Vector3(0, 1, 0).transformDirection(blade.matrixWorld) }));
    };
    const a = at(f - lag - 0.5), b = at(f - lag + 0.5);
    fins.forEach(({ lr }, i) => {
      const vel = b[i].tip.clone().sub(a[i].tip).multiplyScalar(plan.fps), vn = vel.dot(b[i].n);
      bends[lr] = clamp(-0.55 * vn * Math.abs(vn), -0.6, 0.6);   // ~25 degrees at 0.7 m/s of blade speed
    });
  }
  const pose = poseAt(plan, f);
  for (const lr of ["l", "r"]) pose.legs[lr].bend = bends[lr] || 0;
  const B = putPose(g, plan, f, pose, hipY, ctx);
  g.userData.gaitOn = false;
  g.userData.swimOn = true;
  g.userData.gaitCycle = plan.phase[fi] * TAU;
  if (ctx.kit !== false) updateKit(g, plan, fi, pose, ctx);
  floatHair(g, plan, fi, ctx);
  if (ctx.caustics) for (const m of g.userData._ssMats || collectMats(g)) patchCaustics(m);
  return { pose, body: B, style: plan.main[fi], speed: plan.speed[fi] };
}

/** The body transform and every joint of a pose on the figure (no kit, hair or hose). */
function putPose(g, plan, f, pose, hipY, ctx) {
  const J = g.userData.joints;
  const B = bodyAt(plan, f, pose, { ...ctx, hipY });
  g.quaternion.copy(B.q);
  _v.set(0, hipY, 0).applyQuaternion(B.q);
  g.position.set(B.hips[0] - _v.x, B.hips[1] - _v.y, B.hips[2] - _v.z);
  const set = (j, a) => { if (j) { j.rotation.order = "XYZ"; j.rotation.set(a[0], a[1], a[2]); } };
  for (const lr of ["l", "r"]) {
    const L = pose.legs[lr], A = pose.arms[lr];
    set(J[`${lr}_hip`], L.hip);
    set(J[`${lr}_knee`], [L.knee, 0, 0]);
    set(J[`${lr}_shoulder`], A.sh);
    set(J[`${lr}_elbow`], [A.el, 0, 0]);
    const ft = feetOf(g)[lr];
    if (ft) {   // the shoe turns about the ankle: toes pointed (a finned foot is a straight extension of the shin)
      _qa.setFromAxisAngle(X, L.shoe);
      ft.shoe.quaternion.copy(_qa);
      ft.shoe.position.copy(ft.rest).sub(ft.ankle).applyQuaternion(_qa).add(ft.ankle);
    }
  }
  set(J.spine, pose.spine); set(J.neck, pose.neck); set(J.head, pose.head);
  if (Number.isFinite(ctx.floor) && B.hips[1] - ctx.floor < plan.height) keepAboveFloor(g, ctx.floor);
  return B;
}

/** A pool's / tank's floor: lift the posed clay so its lowest point is on it, never through it (a body settling on the
 *  bottom, a plunge in a shallow pool). Measured on the clay's own meshes (never a lifelike body hidden inside it), from
 *  the pose just set: a pure function of the frame, so scrubbing gives the same lift. */
function keepAboveFloor(g, floor) {
  g.updateMatrixWorld(true);
  let lo = Infinity;
  g.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.avatar || o.userData.noCollide || o.material?.transparent || !o.geometry?.attributes?.position) return;
    const e = o.matrixWorld.elements, P = o.geometry.attributes.position;
    for (let i = 0; i < P.count; i++) { const y = e[1] * P.getX(i) + e[5] * P.getY(i) + e[9] * P.getZ(i) + e[13]; if (y < lo) lo = y; }
  });
  if (lo < floor + 0.005) { g.position.y += floor + 0.005 - lo; g.updateMatrixWorld(true); }
}
function collectMats(g) {
  const set = new Set();
  g.traverse((o) => { if (o.isMesh && o.material?.isMeshStandardMaterial) set.add(o.material); });
  Object.defineProperty(g.userData, "_ssMats", { value: [...set], enumerable: false, configurable: true });
  return g.userData._ssMats;
}

/** Undo a swimmer's pose and hide the kit (they climbed out, or the set changed). */
export function unswim(g) {
  if (!g?.userData?.swimOn) return;
  g.userData.swimOn = false;
  for (const ft of Object.values(feetOf(g))) { ft.shoe.position.copy(ft.rest); ft.shoe.quaternion.identity(); }
  if (g.userData.swimKit) g.userData.swimKit.visible = false;
  for (const m of g.userData._hair || []) m.rotation.set(0, 0, 0);
  const K = g.userData.swimKit?.userData;
  for (const p of K?.parts || []) p.visible = false;
}

// ------------------------------------------------------------------ hair
function floatHair(g, plan, fi, ctx) {
  if (!g.userData._hair) {
    const hair = [];
    g.traverse((o) => { if (o.isMesh && o.userData.part === "hair" && o.parent === g.userData.joints?.neck) hair.push(o); });
    Object.defineProperty(g.userData, "_hair", { value: hair, enumerable: false, configurable: true });
  }
  const t = fi / plan.fps, v = plan.speed[fi], under = (plan.mode[fi] || "under") === "under";
  for (const m of g.userData._hair) {
    // hanging hair is buoyant and streams back with the flow: lifted off the back, undulating, drifting with the current
    const lift = under ? 0.42 - 0.18 * sstep(0.2, 0.8, v) : 0.15;
    m.rotation.set(lift + 0.09 * Math.sin(TAU * 0.45 * t + 0.7) + 0.05 * Math.sin(TAU * 1.3 * t), 0, 0.07 * Math.sin(TAU * 0.31 * t + 1.9));
  }
}

// ------------------------------------------------------------------ the dive kit
const _mats = new Map();
const kitMat = (color, rough = 0.6, metal = 0) => {
  const key = `${color}|${rough}|${metal}`;
  if (!_mats.has(key)) _mats.set(key, patchCaustics(new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, metalness: metal })));
  return _mats.get(key);
};
const BUILD = { slim: 0.9, average: 1, athletic: 1.08, heavy: 1.28 };

/**
 * Build (once) the swimmer's gear on the figure. gear: "scuba" (tank, jacket, belt, mask, regulator in the mouth,
 * hose, fins), "freedive" (mask, snorkel, long fins: no bubbles, they hold their breath), "none".
 * Returns the kit group (hidden for "none").
 */
export function ensureKit(g, { gear = "scuba", height = 1.8, kind = "man", appearance = {} } = {}) {
  const J = g.userData.joints;
  if (!J) return null;
  const key = `${gear}|${height}|${kind}|${appearance.build || ""}|${appearance.fins_color || ""}`;
  if (g.userData.swimKit?.userData.key === key) { g.userData.swimKit.visible = gear !== "none"; return g.userData.swimKit; }
  if (g.userData.swimKit) { for (const p of g.userData.swimKit.userData.parts) p.parent?.remove(p); }
  const kit = new THREE.Group();
  kit.userData = { key, parts: [], gear };
  kit.visible = gear !== "none";
  g.userData.swimKit = kit;
  g.add(kit);
  if (gear === "none") return kit;
  const female = kind === "woman" || appearance.gender === "female";
  const s = height / 1.8, hk = kind === "child" ? 1.1 : 1, k = s * hk;
  const bw = BUILD[appearance.build] || (female ? 0.9 : 1);
  const shoulderR = (female ? 0.17 : 0.2) * bw * s, waistR = (female ? 0.13 : 0.15) * bw * s;
  const mesh = (geo, color, parent, x, y, z, opts = {}) => {
    const m = new THREE.Mesh(geo, kitMat(color, opts.rough ?? 0.6, opts.metal ?? 0));
    m.position.set(x, y, z);
    if (opts.rot) m.rotation.set(...opts.rot);
    if (opts.scale) m.scale.set(...opts.scale);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.part = opts.part || "dive_kit";
    parent.add(m); kit.userData.parts.push(m);
    return m;
  };
  const up = J.spine, upY = up.userData.absY, head = J.head, hY = head.userData.absY;
  const headY = (1.67 + 0.1134 * (1 - hk)) * s;
  const H = (x, y, z) => [x * k, headY - hY + y * k, z * k];        // head-space point written at 1.8 m around the head centre
  const BLACK = "#16171a";
  // mask: a low-volume frame over the eyes and nose, a tinted lens, the strap round the back of the head
  mesh(new THREE.BoxGeometry(0.15 * k, 0.062 * k, 0.04 * k), BLACK, head, ...H(0, 0.012, 0.104), { rough: 0.5, part: "mask" });
  mesh(new THREE.BoxGeometry(0.128 * k, 0.046 * k, 0.006 * k), "#7fa6b5", head, ...H(0, 0.014, 0.126), { rough: 0.08, metal: 0.2, part: "mask" });
  mesh(new THREE.CylinderGeometry(0.03 * k, 0.034 * k, 0.04 * k, 10), BLACK, head, ...H(0, -0.022, 0.104), { rot: [Math.PI / 2, 0, 0] });   // nose pocket
  mesh(new THREE.TorusGeometry(0.107 * k, 0.008 * k, 6, 28, Math.PI * 1.25), BLACK, head, ...H(0, 0.018, -0.004), { rot: [0, Math.PI / 2 + Math.PI * 0.375, Math.PI / 2] , scale: [1, 1, 1.05] });
  const fins = { scuba: 0.52, freedive: 0.78 }[gear] || 0.52;
  if (gear === "scuba") {
    // regulator second stage IN the mouth: the mouthpiece sits between the lips, the body just in front of the chin
    const regZ = 0.125;
    mesh(new THREE.BoxGeometry(0.036 * k, 0.016 * k, 0.04 * k), BLACK, head, ...H(0, -0.058, 0.098), { part: "regulator" });   // mouthpiece (in the mouth)
    mesh(new THREE.CylinderGeometry(0.034 * k, 0.034 * k, 0.038 * k, 16), "#222428", head, ...H(0, -0.06, regZ), { rot: [Math.PI / 2, 0, 0], part: "regulator" });
    mesh(new THREE.CylinderGeometry(0.02 * k, 0.02 * k, 0.008 * k, 12), "#5d6168", head, ...H(0, -0.06, regZ + 0.022), { rot: [Math.PI / 2, 0, 0], part: "regulator" });   // purge button
    mesh(new THREE.BoxGeometry(0.085 * k, 0.018 * k, 0.026 * k), "#222428", head, ...H(0, -0.088, regZ - 0.004), { part: "regulator" });   // the exhaust tee
    kit.userData.exhaust = new THREE.Vector3(...H(0, -0.096, regZ - 0.004));
    kit.userData.regPort = new THREE.Vector3(...H(-0.036, -0.06, regZ - 0.004));
    // tank (aluminium 80: 0.18 m across, 0.66 m long) with its valve and first stage at the nape
    const back = shoulderR * 0.62;
    const tz = -(back + 0.095 * s), ty = 1.2 * s - upY;
    mesh(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, 0.6 * s, 18), "#9aa1a8", up, 0, ty, tz, { rough: 0.35, metal: 0.55, part: "tank" });
    mesh(new THREE.SphereGeometry(0.09 * s, 18, 8, 0, TAU, 0, Math.PI / 2), "#9aa1a8", up, 0, ty + 0.3 * s, tz, { rough: 0.35, metal: 0.55, part: "tank" });
    mesh(new THREE.SphereGeometry(0.09 * s, 18, 8, 0, TAU, Math.PI / 2, Math.PI / 2), "#9aa1a8", up, 0, ty - 0.3 * s, tz, { rough: 0.35, metal: 0.55, part: "tank" });
    mesh(new THREE.CylinderGeometry(0.022 * s, 0.026 * s, 0.07 * s, 10), "#c9ccd0", up, 0, ty + 0.42 * s, tz, { metal: 0.8, rough: 0.3 });
    mesh(new THREE.BoxGeometry(0.075 * s, 0.05 * s, 0.05 * s), "#3a3d42", up, 0, ty + 0.46 * s, tz + 0.01 * s, { metal: 0.6, rough: 0.35 });
    kit.userData.firstStage = new THREE.Vector3(-0.035 * s, ty + 0.46 * s, tz + 0.01 * s);
    // buoyancy jacket over the torso (bladder at the back, shoulder straps, the cummerbund), weight belt
    mesh(new THREE.CylinderGeometry(shoulderR * 1.07, waistR * 1.12, 0.44 * s, 20), "#202226", up, 0, 1.24 * s - upY, 0, { scale: [1, 1, 0.7], rough: 0.8, part: "bcd" });
    mesh(new THREE.BoxGeometry(shoulderR * 1.7, 0.42 * s, 0.05 * s), "#202226", up, 0, 1.22 * s - upY, -back - 0.012 * s, { rough: 0.8, part: "bcd" });
    for (const sx of [-1, 1]) mesh(new THREE.BoxGeometry(0.05 * s, 0.03 * s, 0.24 * s), "#202226", up, sx * shoulderR * 0.55, 1.47 * s - upY, -0.01 * s, { rough: 0.8 });
    mesh(new THREE.CylinderGeometry(0.03 * s, 0.03 * s, 0.07 * s, 10), "#d8b51c", up, -shoulderR * 0.75, 1.22 * s - upY, shoulderR * 0.5, { rot: [0.3, 0, 0.2], part: "octopus" });   // octopus, clipped on the right chest
    mesh(new THREE.TorusGeometry(waistR * 1.18, 0.022 * s, 6, 24), "#3b3e44", g, 0, 0.95 * s, 0, { rot: [Math.PI / 2, 0, 0], scale: [1, 0.78, 1], part: "weight_belt" });
    mesh(new THREE.BoxGeometry(0.07 * s, 0.05 * s, 0.03 * s), "#b8bcc2", g, 0, 0.95 * s, waistR * 0.92, { metal: 0.7, rough: 0.3 });
    // the regulator hose (rebuilt each frame from the second stage, over the right shoulder, to the first stage)
    const hose = new THREE.Mesh(new THREE.BufferGeometry(), kitMat(BLACK, 0.7));
    hose.castShadow = true; hose.userData.part = "hose"; hose.frustumCulled = false;
    g.add(hose); kit.userData.parts.push(hose); kit.userData.hose = hose;
    // strap tails at the waist: they stream back and flutter in the flow
    kit.userData.straps = [-1, 1].map((sx) => {
      const geo = new THREE.PlaneGeometry(0.03 * s, 0.2 * s, 1, 6);
      geo.translate(0, -0.1 * s, 0);
      const m = new THREE.Mesh(geo, kitMat("#202226", 0.85));
      m.material.side = THREE.DoubleSide;
      m.position.set(sx * waistR * 1.05, 1.05 * s - upY, waistR * 0.3);
      m.userData.part = "strap"; m.userData.base = Float32Array.from(geo.attributes.position.array);
      up.add(m); kit.userData.parts.push(m);
      return m;
    });
  } else if (gear === "freedive") {
    mesh(new THREE.CylinderGeometry(0.011 * k, 0.011 * k, 0.32 * k, 8), "#1f6fb2", head, ...H(0.1, 0.12, 0.02), { rot: [0, 0, -0.12] });   // snorkel on the left
    mesh(new THREE.BoxGeometry(0.03 * k, 0.016 * k, 0.03 * k), BLACK, head, ...H(0.03, -0.058, 0.1));
  }
  // fins: a foot pocket over each shoe and a long flexible blade beyond the toe (rebuilt as it bends)
  kit.userData.fins = [];
  const F = feetOf(g);
  for (const lr of ["l", "r"]) {
    const f = F[lr];
    if (!f) continue;
    const b = f.shoe.geometry.boundingBox || (f.shoe.geometry.computeBoundingBox(), f.shoe.geometry.boundingBox);
    const w = (b.max.x - b.min.x), hh = (b.max.y - b.min.y), len = (b.max.z - b.min.z);
    mesh(new THREE.BoxGeometry(w * 1.25, hh * 1.25, len * 1.08), "#1b1c1f", f.shoe, 0, 0, 0.02 * s, { rough: 0.7, part: "fin" });
    const L = fins * s, Wd = 0.22 * s;
    const geo = new THREE.PlaneGeometry(Wd, L, 3, 10);
    geo.rotateX(-Math.PI / 2);                                  // in the sole plane, extending along +z from the toe
    geo.translate(0, 0, L / 2);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {                        // taper: narrow at the pocket, flared and squared at the tip
      const z = pa.getZ(i) / L;
      pa.setX(i, pa.getX(i) * (0.62 + 0.38 * Math.sqrt(z)));
    }
    const blade = new THREE.Mesh(geo, kitMat(appearance.fins_color || "#d6b21e", 0.55));
    blade.material.side = THREE.DoubleSide;
    blade.position.set(0, b.min.y + hh * 0.35, b.max.z - 0.01 * s);
    blade.castShadow = true; blade.userData.part = "fin"; blade.userData.base = Float32Array.from(pa.array); blade.userData.L = L;
    f.shoe.add(blade); kit.userData.parts.push(blade);
    kit.userData.fins.push({ lr, blade });
  }
  return kit;
}

const _w1 = new THREE.Vector3(), _w2 = new THREE.Vector3(), _w3 = new THREE.Vector3();
/** Per frame: bend the fin blades, flutter the strap tails, route the hose. */
export function updateKit(g, plan, fi, pose, ctx = {}) {
  const kit = g.userData.swimKit;
  if (!kit) return;
  kit.visible = kit.userData.gear !== "none";
  for (const p of kit.userData.parts) p.visible = kit.visible;
  if (!kit.visible) return;
  const t = fi / plan.fps;
  for (const { lr, blade } of kit.userData.fins || []) {
    // cantilever under a distributed load: the deflection grows ~ z^2; the bend angle is the tip's slope
    const pa = blade.geometry.attributes.position, base = blade.userData.base, L = blade.userData.L, bend = pose.legs[lr].bend;
    for (let i = 0; i < pa.count; i++) {
      const z = base[i * 3 + 2], u = z / L;
      const ang = bend * u * (2 - u) * 0.9;                     // slope along the blade
      const y = Math.tan(bend) * L * (u * u * (1 - u / 3)) * 0.75;
      pa.setXYZ(i, base[i * 3], base[i * 3 + 1] + y, z * Math.cos(ang * 0.5));
    }
    pa.needsUpdate = true;
    blade.geometry.computeVertexNormals();
  }
  // relative flow at the swimmer: current minus the body's own velocity (the straps trail into it)
  const cur = ctx.current ? ctx.current(g.position.x, g.position.y, g.position.z, t) : [0, 0, 0];
  const v = plan.speed[fi];
  for (const [i, m] of (kit.userData.straps || []).entries()) {
    const pa = m.geometry.attributes.position, base = m.userData.base;
    const amp = 0.012 + 0.03 * clamp(v / 0.8, 0, 1.2) + 0.02 * Math.hypot(cur[0], cur[2]) / 0.1;
    for (let j = 0; j < pa.count; j++) {
      const y = base[j * 3 + 1], u = clamp(-y / (0.2 * plan.height / 1.8), 0, 1);
      pa.setXYZ(j, base[j * 3], y, base[j * 3 + 2] + amp * u * u * Math.sin(TAU * (2.6 * t - 1.8 * u) + i * 2.1) * plan.height / 1.8 + 0.04 * u * u);
    }
    pa.needsUpdate = true;
    m.geometry.computeVertexNormals();
  }
  const hose = kit.userData.hose;
  if (hose && ctx.hose !== false) {
    const J = g.userData.joints;
    g.updateMatrixWorld(true);
    const a = J.head.localToWorld(_w1.copy(kit.userData.regPort));
    const d = J.spine.localToWorld(_w2.copy(kit.userData.firstStage));
    const sh = J.spine.localToWorld(_w3.set(-0.13 * plan.height / 1.8, (1.49 - 0.96) * plan.height / 1.8, 0.0));
    const loop = a.clone().lerp(sh, 0.45);
    // the loop between mouth and shoulder hangs a little toward the seabed and sways with the head
    const down = new THREE.Vector3(0, -1, 0).multiplyScalar(0.05 * plan.height / 1.8);
    loop.add(down).addScaledVector(new THREE.Vector3(cur[0], 0, cur[2]), 0.3);
    const pts = [a, loop, sh, sh.clone().lerp(d, 0.55).add(new THREE.Vector3(0, 0.03, 0)), d].map((p) => g.worldToLocal(p.clone()));
    const curve = new THREE.CatmullRomCurve3(pts);
    hose.geometry.dispose();
    hose.geometry = new THREE.TubeGeometry(curve, 18, 0.0095 * plan.height / 1.8, 6, false);
  }
}

/** World point of the regulator's exhaust (bubbles leave here), or null without scuba. */
export function exhaustWorld(g) {
  const kit = g?.userData?.swimKit;
  if (!kit?.visible || !kit.userData.exhaust) return null;
  g.updateMatrixWorld(true);
  return g.userData.joints.head.localToWorld(kit.userData.exhaust.clone());
}

/** World points of the fin tips (the stirred-sand emitters). */
export function finTipsWorld(g) {
  const kit = g?.userData?.swimKit, out = [];
  for (const { blade } of kit?.userData.fins || []) {
    blade.updateWorldMatrix(true, false);
    out.push(new THREE.Vector3(0, 0, blade.userData.L).applyMatrix4(blade.matrixWorld));
  }
  return out;
}

// ------------------------------------------------------------------ stirred sand and the surface wake
/**
 * Seabed sand stirred by fin wash. tips[f] = [[x, y, z], ...] the fin tips per frame; floorAt(x, z) the seabed.
 * A downbeat's jet reaches the bottom when the fins are within WASH_REACH (1.2 m) of it: strength ~ (1 - h/1.2)^2 x the tip speed.
 * Returns particle emitters for particles.mjs (preset "seabed_silt").
 */
/** How far down a fin's downstroke jet still lifts sand (m): a kick's wash is felt about a fin-and-leg length away. */
export const WASH_REACH = 1.2;
export function finWashEmitters(tips, floorAt, { fps = 24, seed = 1, id = "diver" } = {}) {
  const out = [];
  const sd = seedOf(id) * 0.37 + seedNumber(seed) * 11.3;
  for (let f = 1; f < tips.length; f += 2) {
    for (let i = 0; i < (tips[f] || []).length; i++) {
      const p = tips[f][i], q = tips[f - 1]?.[i];
      if (!p || !q) continue;
      const vx = (p[0] - q[0]) * fps, vy = (p[1] - q[1]) * fps, vz = (p[2] - q[2]) * fps;
      const gy = floorAt ? floorAt(p[0], p[2]) : 0, hgt = p[1] - gy;
      if (hgt > WASH_REACH || vy > -0.05) continue;              // only a downstroke close to the bottom
      const k = (1 - Math.max(0, hgt) / WASH_REACH) ** 2 * clamp(Math.hypot(vx, vy, vz) / 0.7, 0, 2.2);
      if (k < 0.03) continue;
      const n = Math.min(8, Math.floor(1 + 6 * k + hash01(sd, f, i)));
      out.push({ src: "finwash", t: f / fps, pos: [p[0], gy + 0.03, p[2]], vel: [vx * 0.25, 0.12, vz * 0.25], normal: [0, 1, 0], k,
        dust: n, debris: 0, sparks: 0, preset: "seabed_silt", debrisPreset: null, size: 0.6, spread: 0.12, kick: 0.25,
        seed: sd + f * 1.7 + i * 0.13, density: 0.45 * Math.min(1, k), color: null });
    }
  }
  return out;
}

/**
 * Foam on the surface around a surface swimmer at frame f: the bow wave at the head, the white water of the kick, the
 * splash at each hand entry, and the two arms of the Kelvin wake (19.47 degrees) spreading behind.
 * at(fq) -> {x, z, yaw, v} the swimmer at a fractional frame. Returns [{x, z, size, a}].
 */
export function wakeFoam(at, f, plan, { fps = 24, seed = 1, history = 2.5 } = {}) {
  seed = seedNumber(seed);
  const out = [], K = Math.tan(19.47 * Math.PI / 180);
  const now = at(f);
  if (!now) return out;
  for (let j = 0; j < 36; j++) {
    const age = (j / 36) * history, fq = f - age * fps;
    const s = at(fq);
    if (!s || s.v < 0.15) continue;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
    const spread = K * s.v * age, fade = Math.exp(-age / 1.1);
    // broken white water, not a dotted line: a few seeded clumps per wake arm per sample, scattered along and across it
    for (const side of [-1, 1]) for (let q = 0; q < 2; q++) {
      const r1 = hash01(seed + j * 7.1, side, q), r2 = hash01(seed + j * 3.7, side, q + 5);
      const along = (r1 - 0.5) * 0.25, across = (r2 - 0.5) * 0.18 * (1 + age);
      out.push({ x: s.x - fx * (0.2 + along) + rx * side * (0.25 + spread + across), z: s.z - fz * (0.2 + along) + rz * side * (0.25 + spread + across),
        size: 0.25 + 0.4 * age, a: 0.5 * fade * (0.5 + r1) });
    }
    // the kick's white water stays on the line behind the feet
    if (age < 1.2) out.push({ x: s.x - fx * 1.25 * plan.height / 1.8 + (hash01(seed, j) - 0.5) * 0.2, z: s.z - fz * 1.25 * plan.height / 1.8 + (hash01(seed, j, 2) - 0.5) * 0.2, size: 0.3 + 0.3 * age, a: 0.7 * Math.exp(-age / 0.5) });
  }
  // hand entries: a splash where each arm went in, for ~0.6 s after
  const fi = clamp(Math.round(f), 0, plan.n - 1);
  if ((plan.weights[fi].freestyle || 0) > 0.3) for (const lr of [0, 0.5]) {
    const u = frac(plan.phase[fi] + lr), since = u / Math.max(0.3, plan.freq[fi]);
    if (since < 0.6) {
      const fx = Math.sin(now.yaw), fz = Math.cos(now.yaw), rx = Math.cos(now.yaw) * (lr ? -1 : 1), rz = -Math.sin(now.yaw) * (lr ? -1 : 1);
      out.push({ x: now.x + fx * 0.75 * plan.height / 1.8 + rx * 0.2, z: now.z + fz * 0.75 * plan.height / 1.8 + rz * 0.2, size: 0.2 + 0.4 * since, a: 0.85 * (1 - since / 0.6) });
    }
  }
  return out;
}

/** The water velocity at a point on the reef (re-exported for the set and the stage). */
export const waterAt = (x, y, z, t, surface = 10) => currentAt(x, y, z, t, { surface });
