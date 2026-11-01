// Soundstage impacts (Milestone 21): what makes a physics shot read as filmed, not as a video game.
//
// The bake (physics.mjs simulate) logs every hit: {frame, t, pos, normal, impulse, speed, a, b, mat_a, mat_b}. Every
// realism layer keys off those hits, the way a VFX house drives secondary elements off the rigid-body solve:
//   - impactParticles(): dust puffs, debris chips and sparks in the clay guide (seeded; a pure function of the events
//     and the frame, so every capture of a frame is identical and LTX sees the dust it should paint);
//   - impactFlash(): a brief point-light flash on hard metal hits (interaction lighting);
//   - impactShake(): the shot camera jolts a few frames after a hit and settles (amplitude by impulse and distance);
//   - jitterPhysics() / imperfectStack(): seeded asymmetry so no two crates weigh, grip or bounce exactly alike.
// The prompt beats (soundstage/look/impacts.py) and the A2 impact sounds (soundstage/cut/impact_sfx.py) read the same
// events from the scene JSON (scene.physics.events).

/** Material of an object for its hits (sound, dust colour, prompt verbs). a.physics.material overrides the kind's. */
export const MATERIALS = ["wood", "cardboard", "metal", "stone", "glass", "plastic", "rubber", "flesh", "ground", "concrete"];
const KIND_MATERIAL = {
  crate: "wood", chair: "wood", table: "wood", bench: "wood", desk: "wood", coffee_table: "wood", dining_table: "wood",
  bookshelf: "wood", wardrobe: "wood", door: "wood", rock: "stone", wall: "concrete", cube: "cardboard", box: "cardboard",
  pyramid: "cardboard", cylinder: "metal", flashlight: "metal", fridge: "metal", car: "metal", truck: "metal",
  police_car: "metal", sports_car: "metal", hatchback: "metal", motorcycle: "metal", bicycle: "metal", train: "metal",
  tv: "glass", sphere: "rubber", cone: "plastic", houseplant: "plastic", man: "flesh", woman: "flesh", child: "flesh",
  dog: "flesh", horse: "flesh", cat: "flesh", armchair: "cardboard", sofa: "cardboard", stool: "wood",
};
export function materialOf(a) {
  const m = a?.physics?.material;
  if (MATERIALS.includes(m)) return m;
  return KIND_MATERIAL[a?.kind] || "wood";
}

// ---------- seeded hash ----------
function hash(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
/** A stable number from a string id (same id, same jitter, every bake). */
export function idSeed(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100003;
}

// ---------- events ----------
/** Approach speed (m/s) a contact needs to count as a hit; resting contact is ~0.02. */
export const MIN_IMPACT_SPEED = 0.9;
/** Most events kept per bake (the strongest; a pile-up makes hundreds of tiny ones). */
export const MAX_EVENTS = 48;

const r3 = (v) => +(+v).toFixed(3);
/**
 * Merge raw per-substep hits into events: per pair, hits within `gap` frames are one event (the strongest impulse,
 * the first frame). Keeps the MAX_EVENTS strongest, sorted by time. raw: [{frame, t, pos, normal, impulse, speed, a, b,
 * mat_a, mat_b}].
 */
export function mergeEvents(raw, { gap = 3, max = MAX_EVENTS } = {}) {
  const byPair = new Map();
  const sorted = [...raw].sort((p, q) => p.t - q.t);
  const out = [];
  for (const h of sorted) {
    const key = h.a < h.b ? `${h.a}|${h.b}` : `${h.b}|${h.a}`;
    const prev = byPair.get(key);
    if (prev && h.frame - prev.last <= gap) {
      prev.last = h.frame;
      if (h.impulse > prev.ev.impulse) Object.assign(prev.ev, { impulse: h.impulse, speed: h.speed, pos: h.pos, normal: h.normal });
      continue;
    }
    const ev = { ...h };
    out.push(ev);
    byPair.set(key, { ev, last: h.frame });
  }
  const keep = out.sort((p, q) => q.impulse - p.impulse).slice(0, max).sort((p, q) => p.t - q.t || p.impulse - q.impulse);
  return keep.map((e) => ({ frame: e.frame, t: +e.t.toFixed(3), pos: e.pos.map(r3), normal: e.normal.map(r3),
    impulse: +e.impulse.toFixed(1), speed: +e.speed.toFixed(2), a: e.a, b: e.b, mat_a: e.mat_a, mat_b: e.mat_b }));
}

/**
 * Events from baked tracks, for any backend (the AVBD live world, an imported bake): a sudden change of velocity
 * |dv| per frame on a dynamic body is a hit. tracks: {id: [{pos, quat}] per frame}; bodies: {id: {mass, material}}.
 * The other side of the hit isn't known here (b = "?"), so the floor is assumed when the body is near it.
 */
export function eventsFromTracks(tracks, bodies = {}, { fps = 24, minSpeed = MIN_IMPACT_SPEED } = {}) {
  const raw = [];
  for (const [id, tr] of Object.entries(tracks || {})) {
    const info = bodies[id] || {};
    const m = +info.mass || 20;
    for (let f = 2; f < tr.length; f++) {
      const v0 = tr[f - 1].pos.map((v, k) => (v - tr[f - 2].pos[k]) * fps), v1 = tr[f].pos.map((v, k) => (v - tr[f - 1].pos[k]) * fps);
      // Gravity alone changes vy by g/fps per frame; take it out.
      const dv = [v1[0] - v0[0], v1[1] - v0[1] + 9.81 / fps, v1[2] - v0[2]];
      const s = Math.hypot(...dv);
      if (s < minSpeed) continue;
      const nrm = dv.map((x) => x / s), low = tr[f].pos[1] < 0.6;
      raw.push({ frame: f, t: f / fps, pos: [...tr[f].pos], normal: nrm, impulse: m * s, speed: s, a: id, b: low ? "__ground" : "?",
        mat_a: info.material || "wood", mat_b: low ? "ground" : info.material || "wood" });
    }
  }
  return mergeEvents(raw);
}

/** 0..~2.5: how big a hit reads (a 25 kg crate dropped 1 m is about 1). */
export const strengthOf = (e) => Math.max(0.12, Math.min(2.5, Math.sqrt(Math.max(0, +e.impulse || 0) / 130)));

// ---------- dust, debris, sparks ----------
// Per material: dust colour + amount, debris colour + amount, sparks. Colours are linear-ish sRGB 0..1.
export const MAT_FX = {
  wood: { dust: [0.74, 0.64, 0.50], dustAmt: 0.8, chip: [0.55, 0.40, 0.25], chipAmt: 1.0, sparks: 0 },
  cardboard: { dust: [0.78, 0.69, 0.54], dustAmt: 1.0, chip: [0.62, 0.50, 0.34], chipAmt: 0.7, sparks: 0 },
  metal: { dust: [0.62, 0.62, 0.62], dustAmt: 0.35, chip: [0.35, 0.36, 0.38], chipAmt: 0.3, sparks: 1 },
  stone: { dust: [0.70, 0.68, 0.64], dustAmt: 1.1, chip: [0.45, 0.44, 0.42], chipAmt: 1.0, sparks: 0.3 },
  concrete: { dust: [0.72, 0.71, 0.68], dustAmt: 1.2, chip: [0.52, 0.52, 0.50], chipAmt: 0.8, sparks: 0.2 },
  glass: { dust: [0.85, 0.88, 0.90], dustAmt: 0.2, chip: [0.85, 0.92, 0.95], chipAmt: 1.6, sparks: 0 },
  plastic: { dust: [0.7, 0.7, 0.7], dustAmt: 0.2, chip: [0.6, 0.6, 0.6], chipAmt: 0.3, sparks: 0 },
  rubber: { dust: [0.6, 0.6, 0.6], dustAmt: 0.1, chip: [0.2, 0.2, 0.2], chipAmt: 0, sparks: 0 },
  flesh: { dust: [0.7, 0.66, 0.6], dustAmt: 0.3, chip: [0.4, 0.4, 0.4], chipAmt: 0, sparks: 0 },
  ground: { dust: [0.66, 0.62, 0.56], dustAmt: 0.9, chip: [0.4, 0.38, 0.35], chipAmt: 0.2, sparks: 0 },
};
const fxOf = (m) => MAT_FX[m] || MAT_FX.wood;
const HARD = new Set(["metal", "stone", "concrete", "ground", "glass"]);
/** Sparks (0..1) off a hit: metal striking something hard. A car into a wooden crate throws splinters, not sparks. */
const sparksOf = (ma, mb) => (HARD.has(ma) && HARD.has(mb) ? Math.max(fxOf(ma).sparks, fxOf(mb).sparks) : 0);
const DUST = { lifeMin: 1.4, lifeMax: 2.8, tau: 0.32, size0: 0.22, size1: 1.5, opacity: 0.6 };
const G = 9.81;

/** Unit vectors spanning the contact plane (perpendicular to n). */
function planeBasis(n) {
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const l = Math.hypot(...u) || 1; u = u.map((x) => x / l);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [u, v];
}

/**
 * The impact FX particles at frame F: a pure function of the events (same frame, same particles, at every capture).
 * opts: { fps, seed, dust = true, debris = true, sparks = true, max = 1500, end (last frame) }.
 * Returns [{p: [x, y, z], size (m), alpha, color: [r, g, b], kind: "dust" | "debris" | "spark"}].
 */
export function impactParticles(events, F, opts = {}) {
  const fps = opts.fps || 24, seed = opts.seed ?? 1, max = opts.max || 1500;
  const want = { dust: opts.dust !== false, debris: opts.debris !== false, spark: opts.sparks !== false };
  const out = [];
  const now = F / fps;
  (events || []).forEach((e, ei) => {
    const age = now - e.t;
    if (age < 0 || age > DUST.lifeMax + 6) return;
    const k = strengthOf(e), fa = fxOf(e.mat_a), fb = fxOf(e.mat_b);
    const n = Array.isArray(e.normal) && Math.hypot(...e.normal) > 0.1 ? e.normal : [0, 1, 0];
    // Dust billows off the side that sheds more of it; the colour is a mix weighted the same way.
    const wa = fa.dustAmt, wb = fb.dustAmt, ws = wa + wb || 1;
    const dustCol = fa.dust.map((c, i) => (c * wa + fb.dust[i] * wb) / ws);
    const dustAmt = Math.max(wa, wb);
    const [u, v] = planeBasis(n.map((x) => (n[1] < 0 ? -x : x)));
    const es = seed * 31 + ei * 7.31 + e.frame * 0.173;
    if (want.dust && age <= DUST.lifeMax) {
      const count = Math.min(40, Math.floor(7 * k * dustAmt + hash(es, 1)));
      for (let i = 0; i < count; i++) {
        const r1 = hash(es + i, 2), r2 = hash(es + i, 3), r3 = hash(es + i, 4);
        const life = DUST.lifeMin + (DUST.lifeMax - DUST.lifeMin) * r1;
        if (age > life) continue;
        const uu = age / life;
        const ang = r2 * 6.2832, v0 = (0.7 + 1.8 * r3) * Math.sqrt(k);
        const dist = v0 * DUST.tau * (1 - Math.exp(-age / DUST.tau));
        const dir = [u[0] * Math.cos(ang) + v[0] * Math.sin(ang), u[1] * Math.cos(ang) + v[1] * Math.sin(ang), u[2] * Math.cos(ang) + v[2] * Math.sin(ang)];
        out.push({ kind: "dust", color: dustCol,
          p: [e.pos[0] + dir[0] * dist, Math.max(0.05, e.pos[1] + dir[1] * dist + (0.12 + 0.3 * r1) * age + 0.15 * uu * k), e.pos[2] + dir[2] * dist],
          size: (DUST.size0 + (DUST.size1 - DUST.size0) * (1 - (1 - uu) * (1 - uu))) * (0.6 + 0.4 * k) * (0.7 + 0.6 * r2),
          alpha: DUST.opacity * Math.min(1, dustAmt) * Math.min(1, uu * 10) * Math.pow(1 - uu, 1.5) });
      }
    }
    const chipAmt = Math.max(fa.chipAmt, fb.chipAmt);
    if (want.debris && chipAmt > 0 && e.speed > 2) {
      const count = Math.min(24, Math.floor(6 * k * chipAmt + hash(es, 5)));
      const chipCol = fa.chipAmt >= fb.chipAmt ? fa.chip : fb.chip;
      for (let i = 0; i < count; i++) {
        const r1 = hash(es + i, 6), r2 = hash(es + i, 7), r3 = hash(es + i, 8);
        // Thrown out round the normal, mostly up and out.
        const ang = r1 * 6.2832, out_ = 0.5 + 0.8 * r2, sp = (1.4 + 2.6 * r3) * Math.sqrt(k);
        const d = [n[0] * 0.9 + (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * out_, Math.abs(n[1]) * 0.9 + 0.5 + (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * out_,
          n[2] * 0.9 + (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * out_];
        const dl = Math.hypot(...d) || 1;
        const vel = d.map((x) => (x / dl) * sp);
        // Ballistic until it lands, then it lies where it fell.
        const y0 = Math.max(0.03, e.pos[1]);
        const tLand = (vel[1] + Math.sqrt(vel[1] * vel[1] + 2 * G * y0)) / G;
        const ta = Math.min(age, tLand);
        const slide = age > tLand ? Math.min(0.25, (age - tLand) * 0.8) * 0.3 : 0;
        const p = [e.pos[0] + vel[0] * (ta + slide), Math.max(0.02, y0 + vel[1] * ta - 0.5 * G * ta * ta), e.pos[2] + vel[2] * (ta + slide)];
        out.push({ kind: "debris", color: chipCol.map((c) => c * (0.8 + 0.3 * r2)), p, size: (0.035 + 0.05 * r1) * (0.8 + 0.3 * k),
          alpha: Math.min(1, age * 30) * (age > 6 ? 0 : 1) });
      }
    }
    const sparks = sparksOf(e.mat_a, e.mat_b);
    if (want.spark && sparks > 0 && e.speed > 3 && age < 0.6) {
      const count = Math.min(30, Math.floor(16 * k * sparks + hash(es, 9)));
      for (let i = 0; i < count; i++) {
        const r1 = hash(es + i, 10), r2 = hash(es + i, 11), r3 = hash(es + i, 12);
        const life = 0.2 + 0.35 * r1;
        if (age > life) continue;
        const ang = r2 * 6.2832, sp = (4 + 6 * r3) * Math.sqrt(k);
        const d = [n[0] * 0.4 + u[0] * Math.cos(ang) + v[0] * Math.sin(ang), Math.abs(n[1]) * 0.4 + 0.35 + u[1] * Math.cos(ang) + v[1] * Math.sin(ang),
          n[2] * 0.4 + u[2] * Math.cos(ang) + v[2] * Math.sin(ang)];
        const dl = Math.hypot(...d) || 1;
        const p = [e.pos[0] + d[0] / dl * sp * age, Math.max(0.02, e.pos[1] + d[1] / dl * sp * age - 0.5 * G * age * age), e.pos[2] + d[2] / dl * sp * age];
        out.push({ kind: "spark", color: [1, 0.85 - 0.25 * (age / life), 0.55 - 0.4 * (age / life)], p, size: 0.035 + 0.025 * r1, alpha: 1 - age / life });
      }
    }
  });
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * The interaction-light flash at frame F: the strongest metal-on-hard hit's {pos, intensity} (0 = none). A
 * few frames, exponential falloff, scaled by the hit's strength.
 */
export function impactFlash(events, F, { fps = 24 } = {}) {
  let best = { pos: [0, 0, 0], intensity: 0 };
  for (const e of events || []) {
    const sp = sparksOf(e.mat_a, e.mat_b);
    if (sp < 0.5 || e.speed < 3) continue;
    const age = F / fps - e.t;
    if (age < 0 || age > 0.3) continue;
    const i = 6 * strengthOf(e) * sp * Math.exp(-age / 0.06);
    if (i > best.intensity) best = { pos: [...e.pos], intensity: i };
  }
  return best;
}

// ---------- camera shake on impact ----------
/** Presets: peak rotation per unit strength (degrees), jolt frequency (Hz), decay time constant (s), delay (frames). */
export const SHAKE_PRESETS = {
  off: { label: "Off", deg: 0 },
  light: { label: "Light", deg: 0.35, hz: 11, decay: 0.16, delay: 2 },
  heavy: { label: "Heavy", deg: 0.9, hz: 9, decay: 0.24, delay: 3 },
  earthquake: { label: "Earthquake", deg: 1.8, hz: 6, decay: 0.45, delay: 3 },
};
/** How much each camera support feels a hit: a tripod only gets a ground thump; handheld and car mounts get more. */
const RIG_SHAKE = { free: 1, tripod: 0.35, dolly: 0.55, chapman: 0.5, slider: 0.4, jib: 0.7, steadicam: 0.8, handheld: 1.3, drone: 0.6, vehicle: 1.4 };

/**
 * Add impact shake to a sampled camera path ([{position, target, roll?}] per frame). Each hit adds a jolt `delay`
 * frames late, at `hz`, decaying exponentially; mostly rotation (pitch, yaw, roll), a hair of translation. Amplitude
 * scales with the hit's strength over the square of its distance to the camera (falloff past ~6 m). Seeded and pure.
 * opts: { preset = "heavy", amount = 1, rig = "free", fps = 24, seed = 3 }.
 */
export function impactShake(path, events, opts = {}) {
  const P = SHAKE_PRESETS[opts.preset || "heavy"] || SHAKE_PRESETS.heavy;
  if (!P.deg || !events?.length || !path?.length) return path;
  const fps = opts.fps || 24, seed = opts.seed ?? 3, k = (opts.amount ?? 1) * (RIG_SHAKE[opts.rig] ?? 1);
  const D2R = Math.PI / 180, MAX = 2.5 * D2R * Math.max(1, opts.amount ?? 1);
  return path.map((c, f) => {
    let pitch = 0, yaw = 0, roll = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const age = (f - P.delay) / fps - e.t;
      if (age < 0 || age > P.decay * 7) continue;
      const d = Math.hypot(e.pos[0] - c.position[0], e.pos[1] - c.position[1], e.pos[2] - c.position[2]);
      const amp = P.deg * D2R * k * strengthOf(e) / (1 + (d / 6) ** 2);
      const env = Math.exp(-age / P.decay) * Math.min(1, age * fps / 1.5 + 0.35);
      const ph = hash(seed, i, e.frame) * 6.2832, w = 2 * Math.PI * P.hz * age;
      pitch += amp * env * Math.sin(w + ph);
      yaw += amp * env * 0.6 * Math.sin(w * 1.37 + ph * 1.7);
      roll += amp * env * 0.45 * Math.sin(w * 0.83 + ph * 2.3);
    }
    const cl = (x) => Math.max(-MAX, Math.min(MAX, x));
    pitch = cl(pitch); yaw = cl(yaw); roll = cl(roll);
    if (!pitch && !yaw && !roll) return c;
    const fwd = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    const dist = Math.hypot(...fwd) || 1;
    const fx = fwd[0] / dist, fz = fwd[2] / dist;
    let rx = fz, rz = -fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;   // sideways, flat (yaw)
    const t =[c.target[0] + (rx * yaw) * dist, c.target[1] + pitch * dist, c.target[2] + (rz * yaw) * dist];
    const pos = [c.position[0], c.position[1] + pitch * 0.02, c.position[2]];
    return { ...c, position: pos, target: t, roll: (c.roll || 0) + roll };
  });
}

// ---------- imperfection ----------
/**
 * Seeded variation of one body's physics (the same id always gets the same): mass ±15%, friction ±12%, bounce ±20%.
 * Returns a new {mass, friction, bounce}.
 */
export function jitterPhysics(p, id, amount = 1) {
  const s = idSeed(id), a = Math.max(0, Math.min(2, amount));
  const j = (i, spread) => 1 + (hash(s, i) * 2 - 1) * spread * a;
  return { ...p, mass: +(p.mass * j(1, 0.15)).toFixed(2), friction: +Math.max(0, Math.min(1.5, p.friction * j(2, 0.12))).toFixed(3),
    bounce: +Math.max(0, Math.min(1, p.bounce * j(3, 0.2))).toFixed(3) };
}

/** A small seeded start tilt for a dynamic body (radians about x and z, up to ~2.5°), as a quaternion [x, y, z, w]. */
export function jitterTilt(id, amount = 1) {
  const s = idSeed(id), D = (2.5 * Math.PI / 180) * Math.max(0, Math.min(2, amount));
  const ax = (hash(s, 4) * 2 - 1) * D, az = (hash(s, 5) * 2 - 1) * D;
  const qx = [Math.sin(ax / 2), 0, 0, Math.cos(ax / 2)], qz = [0, 0, Math.sin(az / 2), Math.cos(az / 2)];
  return [qx[3] * qz[0] + qx[0] * qz[3] + qx[1] * qz[2] - qx[2] * qz[1], qx[3] * qz[1] - qx[0] * qz[2] + qx[1] * qz[3] + qx[2] * qz[0],
    qx[3] * qz[2] + qx[0] * qz[1] - qx[1] * qz[0] + qx[2] * qz[3], qx[3] * qz[3] - qx[0] * qz[0] - qx[1] * qz[1] - qx[2] * qz[2]];
}

/**
 * Make a crate pyramid imperfect, at creation (so you see the stack you get): each crate a slightly different size
 * (0.88-1.0 of `size`), ±2 cm off its mark, turned ±4°; a crate sits on the tallest crate under it (so a few lean).
 * points: crateStack() positions (row by row, y = row * size). Returns [{position, height_m, rotation_deg}] (the
 * rotation is relative to the stack's heading).
 */
export function imperfectStack(points, size = 0.8, seed = 1) {
  const rows = new Map();
  points.forEach((p, i) => { const r = Math.round(p[1] / size); if (!rows.has(r)) rows.set(r, []); rows.get(r).push(i); });
  const out = points.map(() => null);
  const placed = [];
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    for (const i of rows.get(r)) {
      const p = points[i];
      const h = +(size * (0.88 + 0.12 * hash(seed, i, 1))).toFixed(3);
      const dx = (hash(seed, i, 2) * 2 - 1) * 0.02, dz = (hash(seed, i, 3) * 2 - 1) * 0.02;
      const x = p[0] + dx, z = p[2] + dz;
      let y = 0;
      if (r > 0) for (const q of placed) {
        if (q.row >= r) continue;
        if (Math.hypot(q.x - x, q.z - z) < size * 0.95) y = Math.max(y, q.y + q.h);
      }
      placed.push({ row: r, x, z, y, h });
      out[i] = { position: [r3(x), r3(y), r3(z)], height_m: h, rotation_deg: +((hash(seed, i, 4) * 2 - 1) * 4).toFixed(1) };
    }
  }
  return out;
}
