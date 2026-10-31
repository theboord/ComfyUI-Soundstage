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

export const STUNTS = {
  reverse_jturn: { label: "Reverse J-turn", hint: "Races backwards, flicks the wheel, whips round 180° and drives off nose first" },
  donut: { label: "Donut", hint: "Drives in, spins two tight donuts in a cloud of tyre smoke, drives out" },
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

// ---------- stunt presets: keyed paths, in the stunt's own frame ----------
// Rows: [frame, lateral x (m, + = stage +X when it travels +Z), along z (m, + = the way it travels), heading (deg
// relative to that way; 180 = reversing), smoke amount, smoke wheels, (roll, pitch)]. The body's springs make the
// roll and pitch from the motion; the optional last two columns are a movie-stunt exaggeration on top (written as
// roll_deg / pitch_deg keys), so the lean still reads after the video model softens it.
const TABLES = {
  // A movie reverse J-turn (121 frames at 24 fps): ~13 m/s backwards, the flick, 180° in ~0.7 s (167° → 12° in 14
  // frames) with the body hard over (~10° roll), the nose dips as it scrubs off speed, then the rear squats on the launch.
  reverse_jturn: [
    [0, 0, 0, 180, 0, "", 0, 0], [30, -0.1, 13, 180, 0, "", 0, 0], [34, -0.2, 15.2, 176, 0.3, "front", 0, 0],
    [38, -0.6, 17.3, 152, 0.8, "front", 2, 0], [42, -1.1, 19.1, 104, 1.0, "front", 3, 0], [46, -1.5, 20.5, 48, 1.0, "all", 3, 0],
    [50, -1.7, 21.5, 10, 0.9, "all", 2, 0], [54, -1.8, 22.2, -2, 0.7, "all", 0, 0], [60, -1.8, 23, 0, 0.8, "rear", 0, 0],
    [66, -1.7, 24.4, 0, 0.9, "rear", 0, 1], [78, -1.5, 28.4, 2, 0.5, "rear", 0, 1], [96, -1.3, 36, 0, 0.2, "rear", 0, 0],
    [120, -1.2, 50, 0, 0, "", 0, 0],
  ],
  // Bootlegger: 12 m/s forward, the handbrake swings the tail out, it slides round 180° to a stop and launches back.
  handbrake_180: [
    [0, 0, 0, 0, 0, ""], [24, 0, 11, 0, 0, ""], [40, 0, 19, 0, 0, ""], [46, 0.2, 22.5, 15, 0.6, "rear"], [52, 0.7, 25.6, 70, 1.0, "all"],
    [58, 1.2, 27.8, 125, 1.0, "all"], [64, 1.5, 29.0, 168, 0.8, "all"], [70, 1.6, 29.3, 180, 0.6, "rear"], [76, 1.6, 28.9, 180, 0.9, "rear"],
    [88, 1.6, 25.5, 181, 0.6, "rear"], [100, 1.5, 19, 180, 0.3, "rear"], [120, 1.4, 5, 180, 0, ""],
  ],
};

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

const ss = (x) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };

/** The donut, analytically: in at 7.85 m/s, two turns round a 2 m circle (1.6 s each, nose 70° inside), out. */
function donutAt(f) {
  const v = 7.85, r = 2.0, T = 1.6 * 24, start = 20, end = Math.round(start + 2 * T), C = [r, (v * start) / 24];
  const inward = f < end ? 70 * ss((f - 14) / 14) : 70 * (1 - ss((f - end) / 12));
  let x, z, tangent;
  if (f <= start) { x = 0; z = (v * f) / 24; tangent = 0; }
  else if (f <= end) {
    const phi = Math.PI - (2 * Math.PI * (f - start)) / T;
    x = C[0] + r * Math.cos(phi); z = C[1] + r * Math.sin(phi); tangent = (360 * (f - start)) / T;
  } else { const t = (f - end) / 24; x = 0; z = C[1] + v * t + 2 * t * t; tangent = 720; }
  const smoke = f < end ? ss((f - 14) / 8) : 0.85 * (1 - ss((f - end) / 18));
  return [x, z, tangent + inward, smoke, smoke > 0 ? "rear" : ""];
}

/** One stunt at a stunt-time frame (0..120): [x, z, heading, smoke, wheels, roll, pitch] (roll / pitch: the keyed
 *  exaggeration, linear between rows like the stage plays it; null when the stunt keys none). */
function stuntAt(kind, f) {
  if (kind === "donut") return donutAt(f);
  const T = TABLES[kind], ts = T.map((r) => r[0]);
  const col = (c) => monotone(ts, T.map((r) => r[c]), f);
  let wheels = "";
  for (const r of T) if (r[0] <= f + 1e-6) wheels = r[5] || wheels; else break;
  // Smoke between keys is linear (puffs build and die off; a cubic would bulge past the key values).
  let smoke = T[T.length - 1][4];
  for (let i = 0; i < T.length - 1; i++) if (f <= T[i + 1][0]) { const u = (f - T[i][0]) / (T[i + 1][0] - T[i][0]); smoke = T[i][4] + (T[i + 1][4] - T[i][4]) * u; break; }
  const lin = (c) => {
    if (T[0].length <= c) return null;
    for (let i = 0; i < T.length - 1; i++) if (f <= T[i + 1][0]) return T[i][c] + (T[i + 1][c] - T[i][c]) * (f - T[i][0]) / (T[i + 1][0] - T[i][0]);
    return T[T.length - 1][c];
  };
  return [col(1), col(2), col(3), smoke, smoke > 0 ? wheels || "all" : "", lin(6), lin(7)];
}

/**
 * Keys for a stunt, placed where the car is: frame 0 at `start` [x, y, z], travelling along `dirDeg` (stage heading of
 * the way it goes). A key every 6 frames (even spacing keeps the stage's spline smooth and the speeds real), squeezed
 * to fit a shorter shot; on a longer shot the drive-off carries on to the end.
 * Returns [{frame, position, heading_deg, fx: {tire_smoke, wheels?}}].
 */
export function stuntKeys(kind, { start = [0, 0, 0], dirDeg = 0, last = 120, fps = 24 } = {}) {
  if (kind !== "donut" && !TABLES[kind]) return null;
  const th = dirDeg * D, c = Math.cos(th), s = Math.sin(th);
  const k = last < 120 ? last / 120 : 1;
  const toStage = (lx, lz) => [+(start[0] + lx * c + lz * s).toFixed(2), start[1] || 0, +(start[2] - lx * s + lz * c).toFixed(2)];
  const frames = [];
  for (let f = 0; f < last; f += 6) frames.push(f);
  frames.push(last);
  const keys = frames.map((f) => {
    const tf = Math.min(120, f / k);
    let [lx, lz, h, smoke, wheels, roll, pitch] = stuntAt(kind, tf);
    if (f / k > 120) {   // carry on at the drive-off speed past the stunt's own end
      const [ax, az] = stuntAt(kind, 114), [bx, bz] = stuntAt(kind, 120), per = (f / k - 120) / 6;
      lx = bx + (bx - ax) * per; lz = bz + (bz - az) * per; smoke = 0;
    }
    return { frame: f, position: toStage(lx, lz), heading_deg: +(dirDeg + h).toFixed(1),
      ...(roll != null ? { roll_deg: +roll.toFixed(1), pitch_deg: +pitch.toFixed(1) } : {}),
      fx: { tire_smoke: +smoke.toFixed(2), ...(wheels ? { wheels } : {}) } };
  });
  // Keep the roll / pitch exaggeration only where it acts (and the zero keys either side, so it ramps in and out).
  for (const ch of ["roll_deg", "pitch_deg"]) {
    const live = keys.map((x, i) => [i - 1, i, i + 1].some((j) => keys[j]?.[ch]));
    keys.forEach((x, i) => { if (!live[i]) delete x[ch]; });
  }
  return keys;
}
