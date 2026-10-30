// Synthetic hand-held camera takes for the stabilizer tests (intended move + shake).
import { forwardOf, eulerOf, qlookZeroRoll, qmul } from "../../web/movefit/stabilize.mjs";

// ---------------------------------------------------------------- synthetic takes
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
export const deg = Math.PI / 180;
const qAxis = (ax, a) => [ax[0] * Math.sin(a / 2), ax[1] * Math.sin(a / 2), ax[2] * Math.sin(a / 2), Math.cos(a / 2)];
const lookQ = (from, to) => qlookZeroRoll([to[0] - from[0], to[1] - from[1], to[2] - from[2]]);
export const yawPitchQ = (yaw, pitch) => qmul(qAxis([0, 1, 0], yaw * deg), qAxis([1, 0, 0], pitch * deg));

export const MOVES = {
  // Walk an arc around a subject while pushing in, with a speed-up in the middle.
  walkAndPush: { dur: 8, f(t) {
    const u = smooth(t / 8) * 0.7 + (t / 8) * 0.3;
    const a = -60 * deg + u * 100 * deg, r = 5 - 2 * u;
    const p = [r * Math.sin(a), 1.6, r * Math.cos(a)];
    return { p, q: lookQ(p, [0, 1.4, 0]) };
  } },
  // Pan 70 degrees left with a deliberate slow drift of the position and a small tilt.
  panWithDrift: { dur: 6, f(t) {
    const u = smooth((t - 0.5) / 5);
    return { p: [0.3 * (t / 6), 1.5, -0.1 * (t / 6)], q: yawPitchQ(70 * u, -3 + 4 * (t / 6)) };
  } },
  // Crane up, hold for two seconds, crane up again, tilting down as it rises.
  craneWithPause: { dur: 8, f(t) {
    const y = t < 3 ? 1 + smooth(t / 3) : t < 5 ? 2 : 2 + 0.8 * smooth((t - 5) / 2);
    return { p: [0, y, 3], q: yawPitchQ(0, -8 * (y - 1)) };
  } },
  // Straight dolly-in for the rig suggestion.
  dollyIn: { dur: 5, f(t) {
    return { p: [0, 1.6, 6 - 3 * smooth(t / 5)], q: yawPitchQ(0, 0) };
  } },
};

/** Intended move + hand shake: tremor, sensor noise, footstep bob, and overshoot bumps when a move stops. */
export function take(move, { seed = 1, rate = 60, shake = 1, stops = [] } = {}) {
  const r = rng(seed), out = [];
  const tremor = [[7.1, r()], [9.4, r()], [11.3, r()]];
  for (let t = 0; t <= move.dur + 1e-9; t += 1 / rate) {
    const ts = Math.max(0, t + (r() - 0.5) * 0.004);
    const { p, q } = move.f(Math.min(ts, move.dur));
    const n = [0, 0, 0], a = [0, 0, 0];
    for (const [hz, ph] of tremor) for (let k = 0; k < 3; k++) {
      n[k] += 0.0025 * Math.sin(2 * Math.PI * (hz * ts + ph + k * 0.3));
      a[k] += 0.25 * deg * Math.sin(2 * Math.PI * (hz * 1.07 * ts + ph + k * 0.5));
    }
    for (let k = 0; k < 3; k++) { n[k] += 0.0015 * gauss(r); a[k] += 0.15 * deg * gauss(r); }
    n[1] += 0.01 * Math.sin(2 * Math.PI * 1.8 * ts);          // footstep bob
    a[2] += 0.4 * deg * Math.sin(2 * Math.PI * 0.9 * ts);     // footstep roll sway
    for (const s of stops) if (ts > s.t) {                    // overshoot + settle at the stop
      const d = ts - s.t, e = s.amp * Math.exp(-d / 0.18) * Math.sin(2 * Math.PI * 2.5 * d);
      for (let k = 0; k < 3; k++) n[k] += e * s.dir[k];
    }
    const jitterQ = qmul(qmul(qAxis([1, 0, 0], a[0] * shake), qAxis([0, 1, 0], a[1] * shake)), qAxis([0, 0, 1], a[2] * shake));
    out.push({ t: ts, position: p.map((v, k) => v + n[k] * shake), quaternion: qmul(q, jitterQ) });
  }
  return out;
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const angDeg = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))) / deg;
export const rms = (xs) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);

/** High-frequency energy of the error: RMS of the 2nd difference of (output - intended) at 24 fps. */
export function jitter(frames, move) {
  const e = frames.map((f) => { const p = move.f(f.t).p; return f.position.map((v, k) => v - p[k]); });
  const d2 = [];
  for (let i = 1; i < e.length - 1; i++) d2.push(Math.hypot(...e[i].map((v, k) => e[i + 1][k] - 2 * v + e[i - 1][k])));
  return rms(d2);
}
export function angJitter(frames, move) {
  const e = frames.map((f) => angDeg(f.quaternion, move.f(f.t).q));
  const d = []; for (let i = 1; i < e.length; i++) d.push(e[i] - e[i - 1]);
  return rms(d);
}
export const posErr = (frames, move) => frames.map((f) => dist(f.position, move.f(f.t).p));
export const angErr = (frames, move) => frames.map((f) => angDeg(f.quaternion, move.f(f.t).q));

