// The water surface: one deterministic wave field that the boats float on and the stage draws (clay, Color, depth).
//
// Open water is a sum of linear (Airy) wave trains sampled from a JONSWAP spectrum, spread about the wind direction
// with a cos^2s spreading function:
//   η(x, z, t) = Σ a_i cos(k_i (d_i · p) − ω_i t + φ_i),   ω_i² = g k_i (deep water).
// The amplitudes come from S(ω) and are scaled so that 4·sqrt(m0) = Hs, the significant wave height of the sea state
// (DNV-RP-C205 §3.5.5: JONSWAP with γ = 3.3; Pierson–Moskowitz is γ = 1). Directions and phases come from a seeded
// hash, so a frame is the same picture every render.
//
// Whitewater (the rapids set) is different: the river flows (a current vector), and over the rocks the flow throws
// up standing waves that stay put while the water runs through them (wavelength λ = 2π U²/g for a flow speed U, the
// standing-wave condition: the wave's phase speed equals the current), with short choppy waves on top.
//
// Pure functions, no three.js: heightAt / gradAt / velocityAt are what the boat sim samples, and the stage builds its
// displaced water mesh from heightAt too, so what a hull floats on is exactly what the camera sees.

export const G = 9.81;
export const RHO_SEA = 1025, RHO_FRESH = 1000;

/**
 * Sea states. hs: significant wave height (m), tp: peak period (s), spread: cos^2s exponent (bigger = long-crested
 * swell), wind (m/s, the wind that made it: also what the sails feel), current [along, across] m/s (rivers),
 * standing: whitewater standing waves, gamma: JONSWAP peak enhancement. Fetch-limited for the lake states.
 * Numbers: Beaufort 1–6 descriptions (WMO No. 306) and the JONSWAP fetch relations (Hasselmann 1973).
 */
export const SEA_STATES = {
  glassy: { label: "Glassy calm", hs: 0.015, tp: 0.9, spread: 4, wind: 0.8, gamma: 1 },
  calm_lake: { label: "Calm lake (light air)", hs: 0.05, tp: 1.4, spread: 3, wind: 2.5, gamma: 3.3 },
  breeze: { label: "Breezy chop", hs: 0.28, tp: 2.6, spread: 3, wind: 7, gamma: 3.3 },
  moderate: { label: "Moderate sea", hs: 1.1, tp: 5.5, spread: 4, wind: 11, gamma: 3.3 },
  swell: { label: "Long ocean swell", hs: 1.6, tp: 11, spread: 14, wind: 5, gamma: 3.3, chop: 0.18 },
  rough: { label: "Rough sea", hs: 2.8, tp: 7.5, spread: 4, wind: 17, gamma: 3.3 },
  whitewater: { label: "Whitewater rapids (class III)", hs: 0.12, tp: 1.1, spread: 2, wind: 2, gamma: 1, current: [3.2, 0], standing: 0.42 },
};

/** The sea state a set starts with (environment.sea_state overrides). */
export function seaStateFor(env = {}) {
  if (env.sea_state && SEA_STATES[env.sea_state]) return env.sea_state;
  return { lake: "calm_lake", open_water: "breeze", beach: "swell", water_tank: "glassy", river_rapids: "whitewater" }[env.set] || "calm_lake";
}

// The same sin-hash the stage uses everywhere: a seeded value in [0, 1).
function hash(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** JONSWAP spectral density S(ω) (unnormalised shape: the field scales it to Hs). */
export function jonswap(w, wp, gamma = 3.3) {
  if (w <= 0) return 0;
  const sig = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w - wp) ** 2) / (2 * sig * sig * wp * wp));
  return Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
}

/**
 * Build a wave field. spec: a SEA_STATES key or {hs, tp, spread, gamma, wind, current, standing}; opts: {wind_deg
 * (the way the waves travel, stage heading convention: 0 = +z), seed, n (wave trains), flow_deg (river)}.
 * Returns {hs, tp, comps: Float64Array [a, kx, kz, w, phase]*n, current [vx, vz], standing, wind, windDir}.
 */
export function makeField(spec = "calm_lake", opts = {}) {
  const S = typeof spec === "string" ? { ...(SEA_STATES[spec] || SEA_STATES.calm_lake), id: spec } : { ...spec };
  const n = opts.n ?? 28, seed = opts.seed ?? 1;
  const th0 = ((opts.wind_deg ?? 0) * Math.PI) / 180;
  const wp = (2 * Math.PI) / S.tp;
  // Frequencies from 0.7 ωp to 3.2 ωp (the energy-carrying band), log-spaced, each with its own direction.
  const w0 = 0.7 * wp, w1 = 3.2 * wp;
  const comps = new Float64Array(n * 5);
  let m0 = 0;
  const raw = [];
  for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n;
    const wa = w0 * Math.pow(w1 / w0, u0), wb = w0 * Math.pow(w1 / w0, u1);
    const w = wa + (wb - wa) * (0.3 + 0.4 * hash(seed, i, 1));
    const dw = wb - wa;
    const e = jonswap(w, wp, S.gamma ?? 3.3) * dw;
    m0 += e;
    // Direction: sample cos^2s(θ/2) by rejection-free inversion on a seeded uniform (narrow for swell).
    const s = S.spread ?? 3;
    const q = hash(seed, i, 2) * 2 - 1;
    const th = th0 + Math.sign(q) * Math.pow(Math.abs(q), 1 + s * 0.35) * (Math.PI / 2) * (s > 10 ? 0.35 : 0.9);
    raw.push({ w, e, th, ph: hash(seed, i, 3) * 2 * Math.PI });
  }
  const scale = m0 > 0 ? (S.hs / 4) ** 2 / m0 : 0;   // 4 sqrt(m0) = Hs
  raw.forEach((c, i) => {
    const a = Math.sqrt(2 * c.e * scale), k = (c.w * c.w) / G;
    comps.set([a, k * Math.sin(c.th), k * Math.cos(c.th), c.w, c.ph], i * 5);
  });
  // A swell can carry a little local wind chop on top (a second, short sea from the same seed).
  let chop = null;
  if (S.chop) chop = makeField({ hs: S.chop, tp: 2.2, spread: 3, gamma: 3.3, wind: S.wind }, { ...opts, n: 12, seed: seed + 17, wind_deg: (opts.wind_deg ?? 0) + 25 });
  const fl = ((opts.flow_deg ?? 0) * Math.PI) / 180;
  const cur = S.current || [0, 0];
  const current = [cur[0] * Math.sin(fl) + cur[1] * Math.cos(fl), cur[0] * Math.cos(fl) - cur[1] * Math.sin(fl)];
  // Whitewater: standing waves at the wavelength whose phase speed matches the current (λ = 2π U²/g).
  const U = Math.hypot(cur[0], cur[1]);
  const standing = S.standing ? { amp: S.standing, k: U > 0.3 ? G / (U * U) : 2, dir: [Math.sin(fl), Math.cos(fl)], seed } : null;
  return { id: S.id || "custom", label: S.label || "Custom sea", hs: S.hs, tp: S.tp, comps, n, chop, current, standing,
    wind: S.wind ?? 3, windDir: [Math.sin(th0), Math.cos(th0)], wind_deg: opts.wind_deg ?? 0 };
}

/** The field for a stage environment: {set, sea_state, wind_mps, wind_deg, flow_deg, seed}. */
export function fieldFor(env = {}) {
  const id = seaStateFor(env);
  const F = makeField(id, { wind_deg: env.wind_deg ?? (env.set === "river_rapids" ? 0 : 35), seed: env.sea_seed ?? 1, flow_deg: env.flow_deg ?? 0 });
  if (Number.isFinite(env.wind_mps)) F.wind = env.wind_mps;
  return F;
}

// Standing-wave pattern over a riverbed: crests across the flow, broken up by the rocks (a seeded cell pattern), so
// the waves sit in trains behind the boulders instead of as a perfect washboard.
function standingAt(S, x, z) {
  const s = x * S.dir[0] + z * S.dir[1], c = x * S.dir[1] - z * S.dir[0];
  const cell = Math.floor(s / 9) * 31 + Math.floor(c / 5);
  const m = 0.35 + 0.65 * Math.max(0, Math.sin(0.33 * s + 2 * hash(S.seed, cell)) * Math.cos(0.5 * c + hash(S.seed, cell, 2) * 3));
  return { m, s, c };
}

/** Surface height η (m, above the still level) at (x, z) and time t. */
export function heightAt(F, x, z, t) {
  if (!F) return 0;
  const C = F.comps, n = F.n;
  // Travelling waves ride the current: sample them in the water's own frame.
  const xs = x - F.current[0] * t, zs = z - F.current[1] * t;
  let h = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    if (C[o] < 1e-6) continue;
    h += C[o] * Math.cos(C[o + 1] * xs + C[o + 2] * zs - C[o + 3] * t + C[o + 4]);
  }
  if (F.chop) h += heightAt(F.chop, x, z, t);
  if (F.standing) {
    const S = F.standing, q = standingAt(S, x, z);
    // A standing wave pulses a little as the flow surges through it (0.4 Hz), but its crests stay where they are.
    h += S.amp * q.m * Math.cos(S.k * q.s) * (0.85 + 0.15 * Math.sin(2.5 * t + 0.7 * q.c));
  }
  return h;
}

/** Surface slope [∂η/∂x, ∂η/∂z] (central differences on heightAt, 5 cm apart). */
export function gradAt(F, x, z, t, h = 0.05) {
  return [(heightAt(F, x + h, z, t) - heightAt(F, x - h, z, t)) / (2 * h), (heightAt(F, x, z + h, t) - heightAt(F, x, z - h, t)) / (2 * h)];
}

/**
 * Water velocity at the surface [vx, vz] (m/s): the current plus the waves' orbital motion (linear theory: the
 * surface particle moves at a ω in the wave's direction, in phase with the crest).
 */
export function velocityAt(F, x, z, t) {
  if (!F) return [0, 0];
  const C = F.comps;
  const xs = x - F.current[0] * t, zs = z - F.current[1] * t;
  let vx = F.current[0], vz = F.current[1];
  for (let i = 0; i < F.n; i++) {
    const o = i * 5, a = C[o];
    if (a < 1e-6) continue;
    const k = Math.hypot(C[o + 1], C[o + 2]) || 1;
    const u = a * C[o + 3] * Math.cos(C[o + 1] * xs + C[o + 2] * zs - C[o + 3] * t + C[o + 4]);
    vx += (u * C[o + 1]) / k; vz += (u * C[o + 2]) / k;
  }
  return [vx, vz];
}

/** Crest steepness at a point (|∇η|): where it passes ~0.3 a wind wave breaks into a whitecap. */
export const steepness = (F, x, z, t) => Math.hypot(...gradAt(F, x, z, t, 0.08));

/** A short line for the panel and the prompt: "a calm lake, ripples 5 cm" / "a moderate sea, 1.1 m waves". */
export function seaWords(F) {
  if (!F) return "";
  if (F.standing) return "fast whitewater rapids, standing waves and foaming holes behind the rocks";
  const hs = F.hs;
  if (hs < 0.03) return "glassy calm water, a mirror surface";
  if (hs < 0.1) return "a calm lake, the surface barely rippled";
  if (hs < 0.5) return `a light chop, wavelets about ${Math.round(hs * 100)} cm high`;
  if (F.tp > 9) return `a long rolling ocean swell about ${hs.toFixed(1)} m high`;
  return `${hs < 2 ? "a moderate sea" : "a rough sea"} with ${hs.toFixed(1)} m waves and scattered whitecaps`;
}
