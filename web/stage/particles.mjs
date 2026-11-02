// Soundstage secondary simulations (Milestone 28): one POP / Pyro-lite particle system for every bit of dust, debris,
// spray and smoke on the set, the way a VFX house drives secondaries off the rigid-body solve.
//
// Every emitter on the shot feeds the same solver:
//   - the baked hits (impacts.mjs events, Milestone 21) and breaks (Milestone 24, and Milestone 27's fracture events
//     when they land: any event with `break: true`, or scene.physics.breaks [{frame | t, pos, vel?, material, pieces?}]);
//   - foot and hoof strikes (gait.mjs strikeEvents);
//   - tyre smoke and wet-road spray (stunts / vehsim slip, per wheel, per frame).
// The solver steps the whole shot from frame 0 at a fixed step (2 per frame), so frame F is always the same picture
// whatever order the frames are asked for in (the guide, the previz, a re-capture): seeded, deterministic, cached.
//
//   dust:   a billboard puff with density. Starts with the emitter's velocity plus a burst, is slowed by air drag
//           towards the wind, advected by a divergence-free curl-noise field (turbulence), rises on buoyancy
//           (negative for wet spray, which falls), hugs and spreads along the ground, grows and thins as it fades.
//   debris: small chunks (instanced boxes: grains, chunks, splinters, droplets) under gravity and quadratic drag, with
//           spin, restitution and friction on the ground and on the set's boxes; they settle and go to sleep.
//   sparks: hot streaks that fall, bounce once and die.
// Pure functions, no three.js. The stage draws the result (secondary.mjs) in Clay and Color only: never in Depth or
// the ID matte; an optional dust matte pass ("dust") renders the dust density alone for the Layer Pack.

export const G = 9.81;

/**
 * Ground-type presets: what a hit on that ground throws up. dust: colour, density (opacity scale), buoyancy (m/s² up,
 * negative falls), drag (1/s towards the wind), turbulence (m/s of curl noise), life [min, max] (s), size [birth,
 * full] (m). debris: colour, size [min, max] (m), shape ("grain" | "chunk" | "splinter" | "drop"), bounce, friction,
 * amount (count scale). The four public ones are the panel's choices; tyre_smoke is the internal one for tyre smoke.
 */
export const GROUND_PRESETS = Object.freeze({
  desert_sand: { label: "Desert sand", dust: { color: [0.76, 0.62, 0.45], density: 0.95, buoy: 0.1, drag: 2.0, turb: 0.5, life: [2.2, 4.0], size: [0.28, 2.2] },
    debris: { color: [0.66, 0.53, 0.38], size: [0.012, 0.028], shape: "grain", bounce: 0.08, friction: 0.9, amount: 0.9 } },
  concrete_dust: { label: "Concrete dust", dust: { color: [0.73, 0.72, 0.69], density: 0.8, buoy: 0.12, drag: 1.8, turb: 0.45, life: [1.6, 3.2], size: [0.2, 1.5] },
    debris: { color: [0.52, 0.52, 0.5], size: [0.02, 0.07], shape: "chunk", bounce: 0.28, friction: 0.65, amount: 1.0 } },
  wet_spray: { label: "Wet spray", dust: { color: [0.9, 0.95, 1.0], density: 0.55, buoy: -1.4, drag: 2.8, turb: 0.25, life: [0.5, 1.2], size: [0.15, 1.1] },
    debris: { color: [0.82, 0.88, 0.94], size: [0.008, 0.018], shape: "drop", bounce: 0.0, friction: 1.0, amount: 0.5 } },
  wood_splinters: { label: "Wood splinters", dust: { color: [0.74, 0.64, 0.5], density: 0.6, buoy: 0.12, drag: 1.8, turb: 0.45, life: [1.4, 2.8], size: [0.2, 1.4] },
    debris: { color: [0.56, 0.41, 0.26], size: [0.02, 0.05], shape: "splinter", bounce: 0.22, friction: 0.7, amount: 1.4 } },
  tyre_smoke: { label: "Tyre smoke", internal: true, dust: { color: [0.86, 0.86, 0.86], density: 0.34, buoy: 0.5, drag: 1.1, turb: 0.8, life: [1.6, 2.8], size: [0.7, 3.2] },
    debris: null },
});
export const GROUND_TYPES = Object.keys(GROUND_PRESETS).filter((k) => !GROUND_PRESETS[k].internal);

/** The ground preset a set implies (scene.physics.ground overrides; "auto" = this). Wet weather turns it to spray. */
export function groundPresetFor(set, weather, override = "auto") {
  if (override && override !== "auto" && GROUND_PRESETS[override] && !GROUND_PRESETS[override].internal) return override;
  if (weather === "rain" || set === "beach" && weather === "storm") return "wet_spray";
  if (["desert", "beach", "stadium", "forest"].includes(set)) return "desert_sand";
  return "concrete_dust";
}

/** Material of the struck thing → which debris it sheds (the dust still comes from the ground preset when it hits the ground). */
const MAT_DEBRIS = { wood: "wood_splinters", cardboard: "wood_splinters", stone: "concrete_dust", concrete: "concrete_dust", ground: null,
  glass: "glass", metal: "metal", plastic: null, rubber: null, flesh: null };
const SPECIAL_DEBRIS = {
  glass: { color: [0.85, 0.92, 0.95], size: [0.01, 0.035], shape: "chunk", bounce: 0.3, friction: 0.5, amount: 1.4 },
  metal: { color: [0.36, 0.37, 0.39], size: [0.01, 0.03], shape: "chunk", bounce: 0.35, friction: 0.5, amount: 0.3 },
};
const MAT_DUST = { wood: 0.8, cardboard: 1.0, metal: 0.35, stone: 1.1, concrete: 1.2, glass: 0.2, plastic: 0.2, rubber: 0.1, flesh: 0.3, ground: 0.9 };
const HARD = new Set(["metal", "stone", "concrete", "ground", "glass"]);
const SPARK = { metal: 1, stone: 0.3, concrete: 0.2 };

// ---------- seeded hash (the sin-hash used across the stage) ----------
export function hash(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const strengthOf = (e) => Math.max(0.12, Math.min(2.5, Math.sqrt(Math.max(0, +e.impulse || 0) / 130)));
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// ---------- curl noise: a divergence-free velocity field (turbulence that swirls, never piles up or empties) ----------
/** curl(A) of a seeded vector potential A made of sine waves (2 octaves), drifting in time. Pure: f(x, y, z, t, seed). */
export function makeCurl(seed = 1) {
  const W = [];
  for (let c = 0; c < 3; c++) for (let j = 0; j < 3; j++) {
    const fq = [0.55, 1.3, 2.7][j], a = [1, 0.45, 0.2][j];
    const d = norm([hash(seed, c, j) * 2 - 1, hash(seed, c + 3, j) * 2 - 1, hash(seed, c + 6, j) * 2 - 1]);
    W.push({ c, k: d.map((x) => x * fq), a: a / fq, ph: hash(seed, c + 9, j) * 6.2832, w: 0.4 + 0.9 * hash(seed, c + 12, j) });
  }
  return (x, y, z, t) => {
    // dA[c][m] = ∂A_c/∂x_m
    const dA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const q of W) {
      const cs = q.a * Math.cos(q.k[0] * x + q.k[1] * y + q.k[2] * z + q.ph + q.w * t);
      dA[q.c][0] += cs * q.k[0]; dA[q.c][1] += cs * q.k[1]; dA[q.c][2] += cs * q.k[2];
    }
    return [dA[2][1] - dA[1][2], dA[0][2] - dA[2][0], dA[1][0] - dA[0][1]];
  };
}

// ---------- emitters ----------
// An emitter: {t (s), pos, vel (inherited, m/s), normal, dust (count), debris (count), sparks (count), k (strength),
// preset (ground preset id: the dust), debrisPreset (id or a debris spec), size (dust size scale), spread (m), seed,
// kick (m/s burst), src}. Counts are already seeded-rounded.

/**
 * Emitters from the baked hits. events: impacts.mjs events; opts: {ground (preset id), dust, debris, sparks (each on
 * unless false), seed, velOf(id, frame) → [vx, vy, vz] (the struck body's velocity, inherited by what it throws)}.
 */
export function emittersFromImpacts(events, opts = {}) {
  const out = [], ground = opts.ground || "concrete_dust", seed = opts.seed ?? 1;
  (events || []).forEach((e, ei) => {
    const k = strengthOf(e), es = seed * 31 + ei * 7.31 + (e.frame || 0) * 0.173;
    const ma = e.mat_a || "wood", mb = e.mat_b || "ground";
    const brk = !!e.break;
    const dustAmt = Math.max(MAT_DUST[ma] ?? 0.8, MAT_DUST[mb] ?? 0.8);
    const groundHit = mb === "ground" || ma === "ground" || e.b === "__ground";
    const dustPreset = groundHit ? ground : (MAT_DEBRIS[ma] === "wood_splinters" ? "wood_splinters" : ground);
    const debMat = MAT_DEBRIS[ma] !== undefined && ma !== "ground" ? ma : mb;
    const debrisPreset = MAT_DEBRIS[debMat] === "glass" || MAT_DEBRIS[debMat] === "metal" ? SPECIAL_DEBRIS[MAT_DEBRIS[debMat]]
      : MAT_DEBRIS[debMat] || (groundHit ? ground : null);
    const dP = GROUND_PRESETS[dustPreset].dust;
    const dCount = opts.dust === false ? 0 : Math.min(brk ? 60 : 40, Math.floor(7 * k * dustAmt * (brk ? 1.4 : 1) + hash(es, 1)));
    const db = typeof debrisPreset === "string" ? GROUND_PRESETS[debrisPreset]?.debris : debrisPreset;
    const bCount = opts.debris === false || !db || (e.speed || 0) <= 2 ? 0
      : Math.min(brk ? 80 : 40, Math.floor(9 * k * (db.amount || 1) * (brk ? 2 : 1) + hash(es, 5)));
    const sp = HARD.has(ma) && HARD.has(mb) ? Math.max(SPARK[ma] || 0, SPARK[mb] || 0) : 0;
    const sCount = opts.sparks === false || !sp || (e.speed || 0) <= 3 ? 0 : Math.min(30, Math.floor(16 * k * sp + hash(es, 9)));
    if (!dCount && !bCount && !sCount) return;
    const vel = opts.velOf?.(e.a, e.frame) || [0, 0, 0];
    out.push({ src: brk ? "break" : "impact", t: +e.t || 0, pos: [...e.pos], vel, normal: Array.isArray(e.normal) ? [...e.normal] : [0, 1, 0],
      k, dust: dCount, debris: bCount, sparks: sCount, preset: dustPreset, debrisPreset, size: Math.min(1.1, 0.6 + 0.25 * k), spread: 0.1 + 0.15 * k,
      kick: (0.8 + 1.6 * Math.sqrt(k)) * (brk ? 1.25 : 1), seed: es, density: Math.min(1, dustAmt) * dP.density });
  });
  return out;
}

/**
 * Emitters from M27-style break records (scene.physics.breaks): [{frame | t, pos, vel?, material, pieces?}] at fps.
 * Each break throws a burst of splinters / chunks and dust from its raw edges, inheriting the body's velocity.
 */
export function emittersFromBreaks(breaks, { fps = 24, ground = "concrete_dust", seed = 1 } = {}) {
  return (breaks || []).filter((b) => Array.isArray(b?.pos)).map((b, i) => {
    const mat = b.material || "wood", pieces = Math.max(1, +b.pieces || 4), k = clamp(0.6 + pieces / 8, 0.6, 2.2);
    const dp = MAT_DEBRIS[mat] === "wood_splinters" ? "wood_splinters" : MAT_DEBRIS[mat] === "concrete_dust" ? "concrete_dust" : ground;
    const es = seed * 53 + i * 3.7;
    return { src: "break", t: Number.isFinite(+b.t) ? +b.t : (+b.frame || 0) / fps, pos: [...b.pos], vel: Array.isArray(b.vel) ? [...b.vel] : [0, 0, 0],
      normal: [0, 1, 0], k, dust: Math.floor(30 * k + hash(es, 1)), debris: Math.floor(26 * k + hash(es, 2)), sparks: 0, preset: dp,
      debrisPreset: MAT_DEBRIS[mat] === "glass" ? SPECIAL_DEBRIS.glass : dp, size: 0.8 + 0.3 * k, spread: 0.25, kick: 1.6 * Math.sqrt(k), seed: es,
      density: GROUND_PRESETS[dp].dust.density };
  });
}

/**
 * Emitters from foot and hoof strikes (gait.mjs strikeEvents: {t, pos, v, dir [x, z], mass, id}). amount: how dusty
 * the ground is (gait.groundDust), 0 = none. A horse at a gallop throws a cloud; a stroll barely marks the ground.
 */
export function emittersFromStrikes(strikes, { amount = 1, ground = "concrete_dust", seed = 1, color = null } = {}) {
  if (amount <= 0) return [];
  const out = [];
  for (const e of strikes || []) {
    const k = amount * e.mass * clamp((e.v - 0.8) / 5, 0, 2.2);
    if (k <= 0.01) continue;
    const big = e.mass > 0.5, es = seed * 17.3 + idNum(e.id) * 0.731;
    const n = Math.min(big ? 24 : 9, Math.floor((big ? 11 : 7) * k + hash(es, 1)));
    if (!n) continue;
    const back = -Math.min(e.v, 14) * 0.3;
    out.push({ src: "strike", t: e.t, pos: [e.pos[0], (e.pos[1] || 0) + 0.04, e.pos[2]], vel: [e.dir[0] * back, big ? 1.7 : 1.1, e.dir[1] * back],
      normal: [0, 1, 0], k, dust: n, debris: big && k > 0.6 ? Math.floor(4 * k + hash(es, 2)) : 0, sparks: 0, preset: ground,
      debrisPreset: ground, size: big ? 0.8 : 0.45, spread: big ? 0.18 : 0.08, kick: big ? 1.3 : 0.6, seed: es,
      density: (big ? 0.5 : 0.6) * Math.min(1, k) * (GROUND_PRESETS[ground].dust.density), color });
  }
  return out;
}
const idNum = (s) => [...String(s)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 100003, 7);

/**
 * Emitters for one car's tyre smoke or wet spray: per frame b with smoke, per active wheel, at the tyre's ground
 * point. track: {pos[f], yaw[f], vel[f] ([vx, vz]), smoke[f] {amount, wheels}}; wheels: [{x, z, front}] in the car's
 * frame; surface "wet" sprays instead.
 */
export function emittersFromSmoke(track, wheels, { fps = 24, seed = 1, surface = "dry", id = "car" } = {}) {
  const out = [], wet = surface === "wet", n = track?.pos?.length || 0;
  const rate = wet ? 4.5 : 3.2;
  for (let b = 0; b < n; b++) {
    const s = track.smoke?.[b];
    if (!s || s.amount <= 0.01) continue;
    const y = track.yaw[b], c = Math.cos(y), si = Math.sin(y), p = track.pos[b], v = track.vel[b] || [0, 0];
    const spd = Math.hypot(v[0], v[1]) || 1;
    wheels.forEach((w, wi) => {
      if (s.wheels === "front" && !w.front) return;
      if (s.wheels === "rear" && w.front) return;
      const count = Math.floor(rate * s.amount + hash(seed, b, wi));
      if (!count) return;
      const wx = p[0] + w.x * c + w.z * si, wz = p[2] - w.x * si + w.z * c;
      // Spray is thrown back off the tread against the travel; smoke rolls off with a share of the car's speed.
      const vel = wet ? [v[0] * 0.25 - (v[0] / spd) * 3.2, 1.6, v[1] * 0.25 - (v[1] / spd) * 3.2] : [v[0] * 0.3, 0.35, v[1] * 0.3];
      out.push({ src: "smoke", t: b / fps, pos: [wx, wet ? 0.1 : 0.22, wz], vel, normal: [0, 1, 0], k: s.amount, dust: count, debris: wet ? Math.floor(count * 0.8) : 0,
        sparks: 0, preset: wet ? "wet_spray" : "tyre_smoke", debrisPreset: wet ? "wet_spray" : null, size: 1, spread: wet ? 0.15 : 0.25, kick: wet ? 0.8 : 0.35,
        seed: seed * 101 + b * 0.37 + wi * 13.1 + idNum(id) * 0.01, density: Math.min(1, s.amount * 1.3) * (wet ? 0.6 : 1) });
    });
  }
  return out;
}

/** A stable signature for a list of emitters + options (the cache key: re-simulate only when something changed). */
export function emitterSig(emitters, opts = {}) {
  let h = 2166136261;
  const mix = (x) => { h ^= Math.round(x * 1000) | 0; h = Math.imul(h, 16777619); };
  const str = (t) => { for (const ch of String(t)) mix(ch.charCodeAt(0) / 1000); };
  for (const e of emitters) {
    mix(e.t); mix(e.pos[0]); mix(e.pos[1]); mix(e.pos[2]); mix(e.dust); mix(e.debris); mix(e.sparks); mix(e.vel[0]); mix(e.vel[2]); mix(e.seed);
    str(e.preset); str(typeof e.debrisPreset === "string" ? e.debrisPreset : e.debrisPreset ? e.debrisPreset.shape : "-"); mix(e.density || 0);
  }
  mix(opts.frames || 0); mix(opts.fps || 24); mix(opts.seed ?? 1); mix(opts.wind?.[0] || 0); mix(opts.wind?.[1] || 0); mix((opts.boxes || []).length);
  return `${emitters.length}:${(h >>> 0).toString(36)}`;
}

// ---------- the solver ----------
const KIND = { dust: 0, debris: 1, spark: 2 };
export const LIMITS = { dust: 2600, debris: 900, sparks: 300 };
/** Floats per particle in a frame's packed arrays. */
export const STRIDE = { dust: 10, debris: 13, sparks: 8 };

function basis(n) {
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm([n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]]);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [u, v];
}

/** Rotate v by unit quaternion q ([x, y, z, w]). */
function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Spawn the particles of one emitter (seeded) into the live lists. */
function spawn(e, P, opts) {
  const n = e.normal && Math.hypot(...e.normal) > 0.1 ? norm(e.normal[1] < 0 ? e.normal.map((x) => -x) : e.normal) : [0, 1, 0];
  const [u, v] = basis(n);
  const preset = GROUND_PRESETS[e.preset] || GROUND_PRESETS.concrete_dust, D = preset.dust;
  const col = e.color || D.color;
  for (let i = 0; i < e.dust && P.dust.length < LIMITS.dust; i++) {
    const r1 = hash(e.seed + i, 2), r2 = hash(e.seed + i, 3), r3 = hash(e.seed + i, 4), r4 = hash(e.seed + i, 13);
    const ang = r2 * 6.2832, kick = e.kick * (0.5 + r3), up = 0.25 + 0.9 * r4;
    const dir = [u[0] * Math.cos(ang) + v[0] * Math.sin(ang), u[1] * Math.cos(ang) + v[1] * Math.sin(ang), u[2] * Math.cos(ang) + v[2] * Math.sin(ang)];
    const off = e.spread * Math.sqrt(r1);
    P.dust.push({ x: e.pos[0] + dir[0] * off, y: Math.max(0.04, e.pos[1] + dir[1] * off), z: e.pos[2] + dir[2] * off,
      vx: e.vel[0] * (0.35 + 0.3 * r1) + dir[0] * kick + n[0] * up * e.kick * 0.4, vy: e.vel[1] * 0.3 + Math.abs(dir[1]) * kick * 0.2 + up * e.kick * 0.22,
      vz: e.vel[2] * (0.35 + 0.3 * r1) + dir[2] * kick + n[2] * up * e.kick * 0.4,
      age: 0, life: D.life[0] + (D.life[1] - D.life[0]) * r1, s0: D.size[0] * e.size * (0.7 + 0.6 * r2), s1: D.size[1] * e.size * (0.75 + 0.5 * r3),
      a0: e.density * (0.75 + 0.25 * r4), r: clamp(col[0] * (0.93 + 0.1 * r3), 0, 1), g: clamp(col[1] * (0.93 + 0.1 * r3), 0, 1), b: clamp(col[2] * (0.93 + 0.1 * r3) + 0.01, 0, 1),
      drag: D.drag * (0.8 + 0.4 * r2), buoy: D.buoy * (0.7 + 0.6 * r4), turb: D.turb, rot: r1 * 6.2832, spin: (r2 - 0.5) * 0.8, tex: Math.floor(r4 * 4) });
  }
  const db = typeof e.debrisPreset === "string" ? GROUND_PRESETS[e.debrisPreset]?.debris : e.debrisPreset;
  if (db) for (let i = 0; i < e.debris && P.debris.length < LIMITS.debris; i++) {
    const r1 = hash(e.seed + i, 6), r2 = hash(e.seed + i, 7), r3 = hash(e.seed + i, 8), r4 = hash(e.seed + i, 14), r5 = hash(e.seed + i, 15);
    const ang = r1 * 6.2832, out_ = 0.5 + 0.8 * r2, sp = (1.2 + 2.6 * r3) * Math.sqrt(e.k) * (e.src === "smoke" ? 0.5 : 1);
    const d = norm([n[0] * 0.9 + (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * out_, Math.abs(n[1]) * 0.9 + 0.5 + (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * out_,
      n[2] * 0.9 + (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * out_]);
    const sz = db.size[0] + (db.size[1] - db.size[0]) * r4;
    const sc = db.shape === "splinter" ? [sz * 0.35, sz * 0.3, sz * (3 + 3 * r5)] : db.shape === "chunk" ? [sz * (0.7 + 0.6 * r5), sz * (0.5 + 0.5 * r2), sz]
      : db.shape === "drop" ? [sz, sz, sz] : [sz, sz * 0.8, sz * (0.8 + 0.4 * r5)];
    const inh = e.src === "smoke" ? 1 : 0.55 + 0.4 * r5;
    const q = norm4([r1 - 0.5, r2 - 0.5, r3 - 0.5, r4 + 0.2]);
    P.debris.push({ x: e.pos[0], y: Math.max(sc[1] * 0.5, e.pos[1]), z: e.pos[2], vx: d[0] * sp + e.vel[0] * inh, vy: d[1] * sp + Math.max(0, e.vel[1]) * inh, vz: d[2] * sp + e.vel[2] * inh,
      q, wx: (r2 - 0.5) * 30, wy: (r3 - 0.5) * 30, wz: (r5 - 0.5) * 30, sx: sc[0], sy: sc[1], sz: sc[2],
      r: clamp(db.color[0] * (0.8 + 0.35 * r2), 0, 1), g: clamp(db.color[1] * (0.8 + 0.35 * r2), 0, 1), b: clamp(db.color[2] * (0.8 + 0.35 * r2), 0, 1),
      bounce: db.bounce, fric: db.friction, sleep: false, still: 0, drop: db.shape === "drop", age: 0, life: db.shape === "drop" ? 0.9 + 0.6 * r3 : Infinity });
  }
  for (let i = 0; i < e.sparks && P.sparks.length < LIMITS.sparks; i++) {
    const r1 = hash(e.seed + i, 10), r2 = hash(e.seed + i, 11), r3 = hash(e.seed + i, 12);
    const ang = r2 * 6.2832, sp = (4 + 6 * r3) * Math.sqrt(e.k);
    const d = norm([n[0] * 0.4 + u[0] * Math.cos(ang) + v[0] * Math.sin(ang), Math.abs(n[1]) * 0.4 + 0.35 + u[1] * Math.cos(ang) + v[1] * Math.sin(ang),
      n[2] * 0.4 + u[2] * Math.cos(ang) + v[2] * Math.sin(ang)]);
    P.sparks.push({ x: e.pos[0], y: Math.max(0.03, e.pos[1]), z: e.pos[2], vx: d[0] * sp + e.vel[0] * 0.5, vy: d[1] * sp, vz: d[2] * sp + e.vel[2] * 0.5,
      age: 0, life: 0.2 + 0.4 * r1, size: 0.03 + 0.025 * r1, bounced: false });
  }
}
const norm4 = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };

/** Push a debris chunk out of the set's boxes ({pos, quat, half}); returns the contact normal (world) or null. */
function boxContact(p, r, b) {
  const qi = [-b.quat[0], -b.quat[1], -b.quat[2], b.quat[3]];
  const l = qrot(qi, [p.x - b.pos[0], p.y - b.pos[1], p.z - b.pos[2]]);
  const pen = [b.half[0] + r - Math.abs(l[0]), b.half[1] + r - Math.abs(l[1]), b.half[2] + r - Math.abs(l[2])];
  if (pen[0] <= 0 || pen[1] <= 0 || pen[2] <= 0) return null;
  const ax = pen[0] < pen[1] ? (pen[0] < pen[2] ? 0 : 2) : (pen[1] < pen[2] ? 1 : 2);
  const nl = [0, 0, 0]; nl[ax] = Math.sign(l[ax]) || 1;
  l[ax] += nl[ax] * pen[ax];
  const w = qrot(b.quat, l);
  p.x = w[0] + b.pos[0]; p.y = w[1] + b.pos[1]; p.z = w[2] + b.pos[2];
  return qrot(b.quat, nl);
}

/**
 * Simulate every emitter over the shot. emitters: from the emittersFrom*() helpers; opts: {frames, fps = 24, seed = 1,
 * wind [x, z] (m/s), boxes ([{pos, quat, half}] static set boxes debris lands on), substeps = 2}.
 * Returns {frames: [{dust: Float32Array, debris: Float32Array, sparks: Float32Array, n: {dust, debris, sparks}}], stats}.
 * dust stride 10: x y z size alpha r g b rot tex; debris 13: x y z qx qy qz qw sx sy sz r g b; sparks 8: x y z vx vy vz size alpha.
 */
export function simulateParticles(emitters, opts = {}) {
  const frames = Math.max(1, opts.frames || 97), fps = opts.fps || 24, sub = Math.max(1, opts.substeps || 2), dt = 1 / (fps * sub);
  const wind = opts.wind || [0.35, 0.12], curl = makeCurl((opts.seed ?? 1) * 7 + 3), boxes = opts.boxes || [];
  const queue = [...(emitters || [])].sort((a, b) => a.t - b.t || a.seed - b.seed);
  const P = { dust: [], debris: [], sparks: [] };
  const out = [];
  let qi = 0, spawned = { dust: 0, debris: 0, sparks: 0 }, maxLive = 0;
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < sub; s++) {
      const t = (f + s / sub) / fps;
      while (qi < queue.length && queue[qi].t <= t + 1e-9) {
        const e = queue[qi++], before = [P.dust.length, P.debris.length, P.sparks.length];
        spawn(e, P, opts);
        spawned.dust += P.dust.length - before[0]; spawned.debris += P.debris.length - before[1]; spawned.sparks += P.sparks.length - before[2];
      }
      // Dust: drag towards the wind + curl turbulence, buoyancy, ground hugging.
      for (const p of P.dust) {
        p.age += dt;
        const u = Math.min(1, p.age / p.life);
        const c = curl(p.x * 0.6, p.y * 0.6, p.z * 0.6, t);
        // Turbulence grows as the puff slows and spreads (fresh dust is driven by its burst).
        const tb = p.turb * (0.35 + 0.65 * u);
        const tx = wind[0] + c[0] * tb, ty = c[1] * tb * 0.6, tz = wind[1] + c[2] * tb;
        const k = Math.min(1, p.drag * dt);
        p.vx += (tx - p.vx) * k; p.vz += (tz - p.vz) * k;
        p.vy += (ty - p.vy) * k + p.buoy * (1 - u) * dt - (p.buoy < 0 ? 0 : 0);
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const size = p.s0 + (p.s1 - p.s0) * (1 - (1 - u) * (1 - u));
        const floor = size * 0.2;
        if (p.y < floor) {   // hug the ground and spread along it
          p.y = floor;
          if (p.vy < 0) { const sp = -p.vy * 0.5; p.vy = 0; const l = Math.hypot(p.vx, p.vz) || 1; p.vx += (p.vx / l) * sp; p.vz += (p.vz / l) * sp; }
        }
        p.rot += p.spin * dt;
      }
      // Debris: gravity, quadratic drag, ground + set boxes with restitution and friction; sleep when still.
      for (const p of P.debris) {
        if (p.sleep) continue;
        p.age += dt;
        const v = Math.hypot(p.vx, p.vy, p.vz), cd = 0.25 / Math.max(0.01, Math.cbrt(p.sx * p.sy * p.sz) * 40);
        const dk = Math.max(0, 1 - cd * v * dt);
        p.vx *= dk; p.vy = p.vy * dk - G * dt; p.vz *= dk;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const r = Math.min(p.sx, p.sy, p.sz) * 0.5;
        let nrm = null;
        if (p.y < r) { p.y = r; nrm = [0, 1, 0]; }
        for (const b of boxes) { const n2 = boxContact(p, r, b); if (n2) nrm = n2; }
        if (nrm) {
          const vn = p.vx * nrm[0] + p.vy * nrm[1] + p.vz * nrm[2];
          if (vn < 0) {
            const e = Math.abs(vn) > 0.6 ? p.bounce : 0;
            p.vx -= (1 + e) * vn * nrm[0]; p.vy -= (1 + e) * vn * nrm[1]; p.vz -= (1 + e) * vn * nrm[2];
            // Coulomb-ish friction on the tangential speed, by the normal impulse.
            const tvx = p.vx - (p.vx * nrm[0] + p.vy * nrm[1] + p.vz * nrm[2]) * nrm[0], tvz = p.vz - (p.vx * nrm[0] + p.vy * nrm[1] + p.vz * nrm[2]) * nrm[2];
            const tv = Math.hypot(tvx, tvz), cut = tv > 1e-6 ? Math.min(1, (p.fric * Math.abs(vn) * (1 + e) + p.fric * G * dt * 2) / tv) : 1;
            p.vx -= tvx * cut; p.vz -= tvz * cut;
            p.wx *= 0.6; p.wy *= 0.8; p.wz *= 0.6;
            if (p.drop) p.life = Math.min(p.life, p.age + 0.15);   // a drop splashes and is gone
          }
          if (nrm[1] > 0.7 && Math.hypot(p.vx, p.vy, p.vz) < 0.12) {
            if (++p.still > 3) { p.sleep = true; p.vx = p.vy = p.vz = 0; p.wx = p.wy = p.wz = 0; }
          } else p.still = 0;
        }
        // Spin.
        const w = Math.hypot(p.wx, p.wy, p.wz);
        if (w > 1e-4) {
          const h = w * dt * 0.5, sn = Math.sin(h) / w;
          const dq = [p.wx * sn, p.wy * sn, p.wz * sn, Math.cos(h)], q = p.q;
          p.q = norm4([dq[3] * q[0] + dq[0] * q[3] + dq[1] * q[2] - dq[2] * q[1], dq[3] * q[1] - dq[0] * q[2] + dq[1] * q[3] + dq[2] * q[0],
            dq[3] * q[2] + dq[0] * q[1] - dq[1] * q[0] + dq[2] * q[3], dq[3] * q[3] - dq[0] * q[0] - dq[1] * q[1] - dq[2] * q[2]]);
        }
      }
      for (const p of P.sparks) {
        p.age += dt;
        p.vy -= G * dt; p.vx *= 0.995; p.vz *= 0.995;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.01) { p.y = 0.01; if (!p.bounced) { p.vy = -p.vy * 0.35; p.bounced = true; } else p.vy = 0; p.vx *= 0.6; p.vz *= 0.6; }
      }
      P.dust = P.dust.filter((p) => p.age < p.life);
      P.debris = P.debris.filter((p) => p.age < p.life);
      P.sparks = P.sparks.filter((p) => p.age < p.life);
    }
    maxLive = Math.max(maxLive, P.dust.length + P.debris.length + P.sparks.length);
    // Pack the frame.
    const dust = new Float32Array(P.dust.length * STRIDE.dust);
    P.dust.forEach((p, i) => {
      const u = Math.min(1, p.age / p.life), size = p.s0 + (p.s1 - p.s0) * (1 - (1 - u) * (1 - u));
      // Density thins as the puff spreads (the same dust over a bigger sprite), fades in fast and out slowly.
      const a = p.a0 * Math.min(1, u * 10) * Math.pow(1 - u, 1.6) * Math.sqrt(p.s0 / Math.max(p.s0, size));
      dust.set([p.x, p.y, p.z, size, Math.min(1, a), p.r, p.g, p.b, p.rot, p.tex], i * STRIDE.dust);
    });
    const debris = new Float32Array(P.debris.length * STRIDE.debris);
    P.debris.forEach((p, i) => debris.set([p.x, p.y, p.z, p.q[0], p.q[1], p.q[2], p.q[3], p.sx, p.sy, p.sz, p.r, p.g, p.b], i * STRIDE.debris));
    const sparks = new Float32Array(P.sparks.length * STRIDE.sparks);
    P.sparks.forEach((p, i) => sparks.set([p.x, p.y, p.z, p.vx, p.vy, p.vz, p.size, 1 - p.age / p.life], i * STRIDE.sparks));
    out.push({ dust, debris, sparks, n: { dust: P.dust.length, debris: P.debris.length, sparks: P.sparks.length } });
  }
  const asleep = P.debris.filter((p) => p.sleep).length;
  return { frames: out, stats: { emitters: queue.length, spawned, maxLive, debrisAlive: P.debris.length, debrisAsleep: asleep } };
}

/** A frame of a simulation as plain particles (the legacy {p, size, alpha, color, kind} list, plus debris q / scale). */
export function particlesAt(sim, F) {
  const fr = sim?.frames?.[Math.max(0, Math.min((sim?.frames?.length || 1) - 1, F | 0))];
  if (!fr) return [];
  const out = [];
  for (let i = 0; i < fr.n.dust; i++) {
    const o = i * STRIDE.dust, d = fr.dust;
    out.push({ kind: "dust", p: [d[o], d[o + 1], d[o + 2]], size: d[o + 3], alpha: d[o + 4], color: [d[o + 5], d[o + 6], d[o + 7]] });
  }
  for (let i = 0; i < fr.n.debris; i++) {
    const o = i * STRIDE.debris, d = fr.debris;
    out.push({ kind: "debris", p: [d[o], d[o + 1], d[o + 2]], q: [d[o + 3], d[o + 4], d[o + 5], d[o + 6]], scale: [d[o + 7], d[o + 8], d[o + 9]],
      size: Math.max(d[o + 7], d[o + 8], d[o + 9]), alpha: 1, color: [d[o + 10], d[o + 11], d[o + 12]] });
  }
  for (let i = 0; i < fr.n.sparks; i++) {
    const o = i * STRIDE.sparks, d = fr.sparks;
    out.push({ kind: "spark", p: [d[o], d[o + 1], d[o + 2]], size: d[o + 6], alpha: d[o + 7], color: [1, 0.85 - 0.25 * (1 - d[o + 7]), 0.55 - 0.4 * (1 - d[o + 7])] });
  }
  return out;
}

/** The impact-flash light at frame F (a hard metal hit): {pos, intensity}; same rule as impacts.impactFlash. */
export function flashAt(events, F, { fps = 24 } = {}) {
  let best = { pos: [0, 0, 0], intensity: 0 };
  for (const e of events || []) {
    const ma = e.mat_a, mb = e.mat_b, sp = HARD.has(ma) && HARD.has(mb) ? Math.max(SPARK[ma] || 0, SPARK[mb] || 0) : 0;
    if (sp < 0.5 || e.speed < 3) continue;
    const age = F / fps - e.t;
    if (age < 0 || age > 0.3) continue;
    const i = 6 * strengthOf(e) * sp * Math.exp(-age / 0.06);
    if (i > best.intensity) best = { pos: [...e.pos], intensity: i };
  }
  return best;
}
