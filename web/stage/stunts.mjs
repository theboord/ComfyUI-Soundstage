// Movie car stunts (Milestone 13): keyed headings, weight transfer and tyre smoke for the stage's vehicles.
//
// A car normally faces the way it travels and turns at a real rate (Stage._headingAt). A stunt car can carry its own
// heading on its keys instead (`heading_deg`, unwrapped: 0 → 180 → 360 is a full spin), or drive in reverse
// (`drive: "reverse"` on the car or on a key): then the nose points where the stunt driver puts it, however fast
// that is, and the body reacts. Roll and pitch come from the car's acceleration in its own frame through a damped
// spring (the body lags, overshoots and settles on its springs) and the wheels stay planted. Tyre smoke pours off
// the wheels when a key asks for it (`fx: {tire_smoke: 0..1, wheels: "front" | "rear" | "all"}`) or when the tyres
// are sliding (slip) or spinning (hard launch). Everything is a pure function of the keys and the frame, so the clay
// previz, the guides and the video model all see the same stunt every time.
//
// Conventions (stage space): +Z forward at heading 0, heading = atan2(x, z) in degrees, the car's own +X is its left.
// roll_deg > 0 = the body leans onto its right-hand tyres (left side lifts); pitch_deg > 0 = nose up (rear squats).

import { springFollow } from "./camrig.mjs";
import { simulate, driverScript, metrics, carParams, SURFACES, DEFAULTS } from "./vehsim.mjs";

export { SURFACES, DEFAULTS };

export const STUNTS = {
  reverse_jturn: { label: "Reverse J-turn", hint: "Reverses fast, flicks the wheel, slides round 180° and drives off nose first" },
  donut: { label: "Donut", hint: "Drives in, turns in and floors it: the tail swings round in tyre smoke" },
  handbrake_180: { label: "Handbrake 180", hint: "Charges in, yanks the handbrake, slides round 180° and roars back the way it came" },
};

const D = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrapRad = (x) => Math.atan2(Math.sin(x), Math.cos(x));

/** Roll / pitch tuning (from the stunt plan): degrees per m/s² and the limits. */
export const BODY = { rollPerG: 0.6, rollMax: 7, pitchPerG: 0.35, pitchMax: 4, omega: 2 * Math.PI * 1.4, zeta: 0.35 };
/** Tyre smoke: auto triggers and the look of a puff. */
export const SMOKE = { slipDeg: 12, accel: 4, minSpeed: 1.5, rate: 2.4, lifeMin: 1.5, lifeMax: 2.5, size0: 0.8, size1: 3,
  rise: 0.4, drift: 0.3, color: 0xd8d8d8, opacity: 0.26 };

/** Does this key list steer its own heading? */
export const hasHeadingKeys = (keys) => Array.isArray(keys) && keys.some((k) => Number.isFinite(k?.heading_deg));

/** The heading closest to `prev` that points the same way as `deg` (keeps an edited key continuous with the last). */
export function unwrapDeg(prev, deg) {
  if (!Number.isFinite(prev)) return deg;
  return deg + 360 * Math.round((prev - deg) / 360);
}

/** Heading keys as sample keys [{frame, h: [deg]}], in frame order; values as stored (already unwrapped). */
export function headingTrack(keys) {
  return (keys || []).filter((k) => Number.isFinite(k?.heading_deg)).sort((a, b) => a.frame - b.frame)
    .map((k) => ({ frame: k.frame, h: [k.heading_deg] }));
}

/** A scalar channel on the keys (roll_deg, pitch_deg, fx.tire_smoke): linear between the keys that carry it. */
export function channelAt(keys, frame, get) {
  const ks = (keys || []).filter((k) => Number.isFinite(get(k))).sort((a, b) => a.frame - b.frame);
  if (!ks.length) return null;
  if (frame <= ks[0].frame) return get(ks[0]);
  for (let i = 1; i < ks.length; i++) {
    if (frame <= ks[i].frame) {
      const u = (frame - ks[i - 1].frame) / Math.max(1e-6, ks[i].frame - ks[i - 1].frame);
      return get(ks[i - 1]) + (get(ks[i]) - get(ks[i - 1])) * u;
    }
  }
  return get(ks[ks.length - 1]);
}

/** "reverse" / "forward" at a frame: the latest key with a `drive` at or before it, else the car's own. */
export function driveAt(a, keys, frame) {
  let d = a?.drive || "forward";
  for (const k of [...(keys || [])].sort((p, q) => p.frame - q.frame)) {
    if (k.frame > frame) break;
    if (k.drive) d = k.drive;
  }
  return d;
}

/** Is this a stunt car (heading keys, reverse driving or keyed smoke)? */
export function isStunt(a, keys) {
  return hasHeadingKeys(keys) || a?.drive === "reverse" || (keys || []).some((k) => k.drive === "reverse" || k.fx?.tire_smoke !== undefined);
}

/**
 * Body dynamics over a track. pos[f] = [x, y, z], yaw[f] = heading (radians) for every frame 0..last.
 * Returns per frame: speed (m/s), accel [forward, lateral-to-the-left] (m/s², car frame), slip (deg, against the
 * drive axis, so straight reversing is 0), yawRate (deg/s), roll and pitch (deg, after the spring) and smoke
 * {amount 0..1, wheels} from the automatic triggers. extra(f) adds keyed {roll, pitch} on top before the spring.
 */
export function vehicleDynamics(pos, yaw, fps = 24, extra = null) {
  const n = pos.length;
  const P = (f) => pos[Math.max(0, Math.min(n - 1, f))];
  const vel = [];
  for (let f = 0; f < n; f++) {
    const a = P(f - 1), b = P(f + 1), span = (Math.min(n - 1, f + 1) - Math.max(0, f - 1)) || 1;
    vel.push([(b[0] - a[0]) * fps / span, (b[2] - a[2]) * fps / span]);
  }
  const V = (f) => vel[Math.max(0, Math.min(n - 1, f))];
  const out = { speed: [], accel: [], slip: [], yawRate: [], roll: [], pitch: [], smoke: [] };
  const target = [];
  for (let f = 0; f < n; f++) {
    const v = vel[f], sp = Math.hypot(v[0], v[1]);
    const a0 = V(f - 1), a1 = V(f + 1), span = (Math.min(n - 1, f + 1) - Math.max(0, f - 1)) || 1;
    const ax = (a1[0] - a0[0]) * fps / span, az = (a1[1] - a0[1]) * fps / span;
    const y = yaw[f], fwd = [Math.sin(y), Math.cos(y)], left = [Math.cos(y), -Math.sin(y)];
    const aF = ax * fwd[0] + az * fwd[1], aL = ax * left[0] + az * left[1];
    let slip = 0;
    if (sp > 0.5) {
      const d = Math.abs(wrapRad(Math.atan2(v[0], v[1]) - y));
      slip = Math.min(d, Math.PI - d) / D;              // sliding against the drive axis, forward or in reverse
    }
    const yr = (wrapRad(yaw[Math.min(n - 1, f + 1)] - yaw[Math.max(0, f - 1)]) * fps / span) / D;
    const ex = extra ? extra(f) : null;
    target.push([clamp(BODY.rollPerG * aL, -BODY.rollMax, BODY.rollMax) + (ex?.roll || 0),
      clamp(BODY.pitchPerG * aF, -BODY.pitchMax, BODY.pitchMax) + (ex?.pitch || 0), 0]);
    out.speed.push(sp); out.accel.push([aF, aL]); out.slip.push(slip); out.yawRate.push(yr);
    // Automatic smoke: tyres sliding sideways at speed, or spinning / locking under hard acceleration.
    let amt = 0, wheels = "all";
    if (slip > SMOKE.slipDeg && sp > SMOKE.minSpeed) { amt = clamp((slip - SMOKE.slipDeg) / 30, 0, 1) * clamp(sp / 6, 0.3, 1); wheels = "all"; }
    const hard = Math.hypot(aF, aL);
    if (hard > SMOKE.accel) {
      const k = clamp((hard - SMOKE.accel) / 4, 0, 0.8);
      if (k > amt) { amt = k; wheels = aF > 0 && Math.abs(aF) >= Math.abs(aL) ? "rear" : "all"; }
    }
    out.smoke.push({ amount: amt, wheels });
  }
  const body = springFollow(target, fps, BODY.omega, BODY.zeta);
  for (let f = 0; f < n; f++) {
    out.roll.push(clamp(body[f][0], -BODY.rollMax - 4, BODY.rollMax + 4));
    out.pitch.push(clamp(body[f][1], -BODY.pitchMax - 3, BODY.pitchMax + 3));
  }
  return out;
}

/** Small deterministic hash → [0, 1). */
function hash(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Tyre-smoke particles at a frame: a pure function of the track. Each frame b <= F with smoke emits a few puffs per
 * active wheel at that wheel's ground point; a puff drifts with 30% of the car's speed, rises, grows from 0.8 m to 3 m
 * and fades out over 1.5-2.5 s. track: {pos[f], yaw[f], vel[f] ([vx, vz] m/s), smoke[f] ({amount, wheels})};
 * wheels: [{x, z, front}] in the car's own frame. Returns [{p: [x, y, z], size, alpha}] in stage space.
 */
export function smokeParticles(track, wheels, F, fps = 24, seed = 1) {
  const out = [];
  const maxAge = Math.ceil(SMOKE.lifeMax * fps);
  const n = track.pos.length;
  for (let b = Math.max(0, F - maxAge); b <= Math.min(F, n - 1); b++) {
    const s = track.smoke[b];
    if (!s || s.amount <= 0.01) continue;
    const y = track.yaw[b], c = Math.cos(y), si = Math.sin(y), p = track.pos[b], v = track.vel[b] || [0, 0];
    wheels.forEach((w, wi) => {
      if (s.wheels === "front" && !w.front) return;
      if (s.wheels === "rear" && w.front) return;
      const count = Math.floor(SMOKE.rate * s.amount + hash(seed, b, wi));   // stochastic rounding, seeded
      for (let i = 0; i < count; i++) {
        const r1 = hash(seed + i, b, wi + 10), r2 = hash(seed + i, b + 0.5, wi + 20), r3 = hash(seed + i, b + 0.25, wi + 30);
        const life = SMOKE.lifeMin + (SMOKE.lifeMax - SMOKE.lifeMin) * r1;
        const age = (F - b) / fps;
        if (age > life) continue;
        const u = age / life;
        // Wheel ground point at birth (car frame → stage), a little spread around the tyre.
        const lx = w.x + (r2 - 0.5) * 0.3, lz = w.z + (r3 - 0.5) * 0.5;
        const wx = p[0] + lx * c + lz * si, wz = p[2] - lx * si + lz * c;
        const spread = 0.25 + 1.1 * Math.sqrt(u);
        const ang = r1 * 6.2832 + r2 * 3.1;
        out.push({
          p: [wx + v[0] * SMOKE.drift * age * (1 - 0.35 * u) + Math.cos(ang) * spread,
            0.25 + SMOKE.rise * age + 0.35 * u,
            wz + v[1] * SMOKE.drift * age * (1 - 0.35 * u) + Math.sin(ang) * spread],
          size: SMOKE.size0 + (SMOKE.size1 - SMOKE.size0) * (1 - (1 - u) * (1 - u)),
          alpha: SMOKE.opacity * Math.min(1, s.amount * 1.3) * Math.min(1, u * 8) * Math.pow(1 - u, 1.4),
        });
      }
    });
  }
  return out;
}

// ---------- stunt presets: driven by a vehicle-dynamics simulation (vehsim.mjs) ----------
// A preset is a driver script (reverse at X km/h, lift, flick the wheel, catch it, select drive, throttle) run through
// a four-wheel car with Pacejka tyres, weight transfer and a sprung body. The path, heading, body roll / pitch and
// tyre slip come out of the simulation and are baked into keys; the smoke comes from the real slip.
/** Monotone cubic (Fritsch-Carlson) through (t[i], y[i]) at t: smooth, and never overshoots a key. */
export function monotone(ts, ys, t) {
  const n = ts.length;
  if (t <= ts[0]) return ys[0];
  if (t >= ts[n - 1]) return ys[n - 1];
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (ts[i + 1] - ts[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], r = a * a + b * b;
    if (r > 9) { const k = 3 / Math.sqrt(r); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  let i = 0;
  while (t > ts[i + 1]) i++;
  const h = ts[i + 1] - ts[i], u = (t - ts[i]) / h, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
}

/** The stunt's knobs, filled in: entry speed (km/h), surface (wet | dry), mass (kg), side (+1 left, −1 right). */
export function stuntParams(kind, p = {}) {
  const d = DEFAULTS[kind] || {};
  return { entry_kmh: clamp(+(p.entry_kmh ?? d.entry_kmh ?? 40), 5, 90), surface: SURFACES[p.surface] ? p.surface : d.surface || "wet",
    mass_kg: p.mass_kg ? clamp(+p.mass_kg, 600, 4000) : null, side: p.side === -1 ? -1 : 1, ...(Number.isFinite(p.flick_s) ? { flick_s: p.flick_s } : {}) };
}

/**
 * Run a stunt through the simulation: {run (per frame), metrics, params}. last = the shot's last frame; the flick
 * comes at about a fifth of the shot (never later than 1 s), so the drive-off fits in a shorter shot.
 */
export function stuntRun(kind, { last = 120, fps = 24, carKind = "sports_car", params = {} } = {}) {
  const P = stuntParams(kind, params);
  const flick = P.flick_s ?? clamp(0.2 * last / fps, 0.4, kind === "donut" ? 0.7 : 1.0);
  const script = driverScript(kind, { ...P, flick_s: flick });
  if (!script) return null;
  const car = carParams(carKind, P.mass_kg);
  const run = simulate(script, { car, surface: P.surface, frames: last + 1, fps, side: P.side });
  return { run, params: P, mass_kg: car.mass, metrics: metrics(run, { turn: kind === "donut" ? 720 : 180 }) };
}

/**
 * Keys for a stunt, placed where the car is: frame 0 at `start` [x, y, z], travelling along `dirDeg` (stage heading of
 * the way it goes). The simulation is baked into a key every 2 frames (path, heading, body roll / pitch, tyre smoke),
 * so the stage's spline plays the simulated motion back. Returns [{frame, position, heading_deg, roll_deg, pitch_deg,
 * fx: {tire_smoke, wheels?}}].
 */
export function stuntKeys(kind, { start = [0, 0, 0], dirDeg = 0, last = 120, fps = 24, carKind = "sports_car", params = {}, res = null } = {}) {
  if (!STUNTS[kind]) return null;
  res = res || stuntRun(kind, { last, fps, carKind, params });
  if (!res) return null;
  const th = dirDeg * D, c = Math.cos(th), s = Math.sin(th);
  const toStage = (lx, lz) => [+(start[0] + lx * c + lz * s).toFixed(3), start[1] || 0, +(start[2] - lx * s + lz * c).toFixed(3)];
  const frames = [];
  for (let f = 0; f < last; f += 2) frames.push(f);
  frames.push(last);
  return frames.map((f) => {
    const o = res.run[Math.min(f, res.run.length - 1)];
    return { frame: f, position: toStage(o.x, o.z), heading_deg: +(dirDeg + o.h).toFixed(2),
      roll_deg: +o.roll.toFixed(2), pitch_deg: +o.pitch.toFixed(2),
      fx: { tire_smoke: +o.smoke.amount.toFixed(2), ...(o.smoke.wheels ? { wheels: o.smoke.wheels } : {}) } };
  });
}
