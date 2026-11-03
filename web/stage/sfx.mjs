// Soundstage practical effects (SFX rigs): the special-effects department's placeable props, the way a film set does
// them. A rig is an actor of kind `sfx_<kind>` with `a.sfx` settings; it is never in the render itself (the marker is
// hidden in every capture), only what it does is: the fireball, the smoke, the sparks, what the blast throws, the stage
// blood, the hit reaction.
//
//   explosion        a pyro mortar: fireball, shockwave, debris, then a smoke column. The bake gives every body near it a
//                    radial impulse with falloff (crates fly, a car rocks or flips by its mass, a lamp post falls, a
//                    person is knocked down, a breakable prop fractures) and it ignites what burns near it.
//   fire             a fire bar / burning object: flames and smoke; spreads along flammable props (wood, cardboard).
//   sparks           a spark gag (gerb / grinder shower): a fall of hot sparks.
//   squib            a bullet-hit squib on a surface: wall (dust and chips), ground (a dirt kick), glass (shards),
//                    car (sparks), water (a spout of spray).
//   smoke_bomb       a coloured or grey smoke pot.
//   breakaway_glass  a candy-glass pane that shatters on its cue (or when something goes through it).
//   flare            a road flare: red light, sparks and a smoke trail.
//   body_squib       a body squib and blood pack on a person's wardrobe (chest, shoulder, back, arm, leg): a puff of
//                    fabric and a burst of stage blood, the hit reaction, and the stain that stays.
//   stab             a stunt-knife gag: a retractable prop knife with a blood tube, a slash line on the wardrobe and a
//                    reaction.
//
// Triggers (a.sfx.trigger.type): "time" (at a keyed second), "contact" (the first baked hit on the watched object, or
// the first thing that comes within reach of the rig), "chain" (a set delay after another rig fires) and "manual" (a
// Fire button / K during playback or Drive mode REC writes the moment as a key, a.sfx.keys = [frame]).
//
// Everything here is a pure function of the scene (no three.js, no clock, no Math.random): the stage bakes from the
// authored keys every time, so changing one setting re-bakes from the pristine scene, scrubbing before a cue shows the
// untouched originals, and the same scene always gives the same frames.
//
// Fiction only: these are descriptions of what the audience sees on screen, with no recipes, charges or real devices.

export const SFX_KINDS = Object.freeze({
  explosion: { label: "Explosion (fireball)", icon: "💥", power: 1, radius: 9, physical: true, repeat: false, height: 0.5 },
  fire: { label: "Fire / flames", icon: "🔥", power: 1, radius: 0.6, repeat: false, height: 0.4, duration: Infinity },
  sparks: { label: "Sparks shower", icon: "✨", power: 1, radius: 1, repeat: true, height: 2.4, duration: 1.6 },
  squib: { label: "Bullet-hit squib", icon: "•", power: 1, radius: 0.2, repeat: true, height: 0.15 },
  smoke_bomb: { label: "Smoke bomb", icon: "☁", power: 1, radius: 1.5, repeat: false, height: 0.25, duration: 7 },
  breakaway_glass: { label: "Breakaway glass", icon: "▦", power: 1, radius: 0.8, repeat: false, height: 1.6 },
  flare: { label: "Road flare", icon: "🧨", power: 1, radius: 0.3, repeat: false, height: 0.2, duration: 12 },
  body_squib: { label: "Body squib / blood pack", icon: "🩸", power: 1, radius: 0.1, repeat: true, height: 0.1, onActor: true },
  stab: { label: "Stunt-knife stab gag", icon: "🗡", power: 1, radius: 0.1, repeat: false, height: 0.1, onActor: true },
});
export const SFX_PREFIX = "sfx_";
export const TRIGGERS = ["time", "contact", "chain", "manual"];
export const SQUIB_SURFACES = ["auto", "wall", "ground", "glass", "car", "water"];
/** Where a body squib or blood pack can be rigged on the wardrobe: height (share of the person's height), front (+1) or back (-1), side. */
export const BODY_POINTS = Object.freeze({
  chest: { h: 0.72, f: 1, s: 0, label: "chest" },
  belly: { h: 0.6, f: 1, s: 0, label: "stomach" },
  shoulder_l: { h: 0.81, f: 0.6, s: 1, label: "left shoulder" },
  shoulder_r: { h: 0.81, f: 0.6, s: -1, label: "right shoulder" },
  back: { h: 0.7, f: -1, s: 0, label: "back" },
  arm_l: { h: 0.62, f: 0.2, s: 1.4, label: "left arm" },
  arm_r: { h: 0.62, f: 0.2, s: -1.4, label: "right arm" },
  leg_l: { h: 0.32, f: 0.8, s: 0.5, label: "left thigh" },
  leg_r: { h: 0.32, f: 0.8, s: -0.5, label: "right thigh" },
});
export const SMOKE_COLORS = Object.freeze({ grey: [0.62, 0.62, 0.63], white: [0.9, 0.9, 0.9], black: [0.16, 0.16, 0.17], red: [0.78, 0.2, 0.18],
  orange: [0.9, 0.5, 0.16], yellow: [0.88, 0.8, 0.25], green: [0.25, 0.62, 0.3], blue: [0.25, 0.4, 0.78], purple: [0.5, 0.3, 0.68] });
/** Materials that catch: how fast flame runs along them (m/s) and how long until they catch once something burns next to them (s). */
export const FLAMMABLE = Object.freeze({ cardboard: { spread: 0.55, catch: 0.6 }, wood: { spread: 0.22, catch: 1.4 }, fabric: { spread: 0.6, catch: 0.5 },
  plastic: { spread: 0.12, catch: 2.5 } });
/** Most fires in a scene (each one is an emitter stream). */
export const MAX_BURNING = 24;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);
const norm3 = (v) => { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
function hash(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
/** A stable number from a string id. */
export function sfxSeed(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100003;
}

// ---------- rigs ----------
export const isSfxKind = (k) => typeof k === "string" && k.startsWith(SFX_PREFIX) && k.slice(SFX_PREFIX.length) in SFX_KINDS;
export const sfxKindOf = (a) => (isSfxKind(a?.kind) ? a.kind.slice(SFX_PREFIX.length) : null);
export const isSfxRig = (a) => !!sfxKindOf(a);

/** A rig's settings with every default filled in (never mutates a). */
export function sfxOf(a) {
  const kind = sfxKindOf(a);
  if (!kind) return null;
  const K = SFX_KINDS[kind], s = a.sfx || {}, t = s.trigger || {};
  const type = TRIGGERS.includes(t.type) ? t.type : "time";
  return {
    kind, armed: s.armed !== false,
    trigger: { type, at: Number.isFinite(+t.at) ? Math.max(0, +t.at) : 1, watch: t.watch || null, after: t.after || null,
      delay: Number.isFinite(+t.delay) ? Math.max(0, +t.delay) : 0.3, min_speed: Number.isFinite(+t.min_speed) ? Math.max(0, +t.min_speed) : 1.5 },
    keys: Array.isArray(s.keys) ? s.keys.filter((f) => Number.isFinite(+f)).map((f) => Math.max(0, Math.round(+f))).sort((p, q) => p - q) : [],
    power: clamp(Number.isFinite(+s.power) ? +s.power : K.power, 0.1, 4),
    radius: clamp(Number.isFinite(+s.radius) ? +s.radius : K.radius, 0.05, 40),
    duration: Number.isFinite(+s.duration) && +s.duration > 0 ? +s.duration : K.duration ?? 0,
    color: SMOKE_COLORS[s.color] ? s.color : kind === "smoke_bomb" ? "grey" : "black",
    surface: SQUIB_SURFACES.includes(s.surface) ? s.surface : "auto",
    dir: Array.isArray(s.dir) && len3(s.dir) > 1e-6 ? norm3(s.dir) : null,
    target: s.target || null, point: BODY_POINTS[s.point] ? s.point : kind === "stab" ? "belly" : "chest",
    blood: s.blood !== false, react: s.react !== false, fall: s.fall ?? null,
    repeat: s.repeat ?? K.repeat,
  };
}

/** A new rig actor (kind, id, position; settings patch). */
export function makeRig(kind, { id, name, position = [0, 0, 0], sfx = {} } = {}) {
  if (!SFX_KINDS[kind]) throw new Error(`unknown SFX kind ${kind}`);
  const p = position.map((v) => +(+v).toFixed(3));
  return { id: id || `sfx_${kind}_${sfxSeed(JSON.stringify([kind, p])).toString(36)}`, name: name || SFX_KINDS[kind].label, kind: SFX_PREFIX + kind,
    position: p, keys: [{ frame: 0, position: [...p] }], rotation_deg: 0, physics: { mode: "off" }, sfx: { trigger: { type: "time", at: 1 }, ...sfx } };
}

/**
 * Manual fire: the moment the Fire button was pressed (playback or Drive-mode REC) written as a key. A one-shot rig
 * (an explosion) keeps only the newest press; a repeating one (squibs, sparks) adds it. Returns the new sfx settings
 * (pure: a.sfx is not changed).
 */
export function recordManualFire(a, frame) {
  const s = sfxOf(a);
  if (!s) return null;
  const f = Math.max(0, Math.round(+frame || 0));
  const keys = s.repeat ? [...new Set([...s.keys, f])].sort((p, q) => p - q) : [f];
  return { ...(a.sfx || {}), trigger: { ...((a.sfx || {}).trigger || {}), type: "manual" }, keys };
}

// ---------- when each rig fires ----------
/**
 * Every fire of every armed rig: [{id, kind, frame, t, by}] sorted by frame. opts: {fps, frames, events (the bake's hits:
 * contact triggers), posOf(rig) (where the rig is: its frame-0 position by default), proximity(rig) → frame | null
 * (the first frame something solid is within the rig's reach: breakaway glass that a body goes through)}.
 * Chains resolve in order (a chain on a rig that never fires never fires; a loop of chains fires each rig once).
 */
export function resolveFires(rigs, opts = {}) {
  const fps = opts.fps || 24, frames = Math.max(1, opts.frames || 97), events = opts.events || [];
  const posOf = opts.posOf || ((a) => a.position || [0, 0, 0]);
  const S = new Map(), out = [];
  for (const a of rigs || []) { const s = sfxOf(a); if (s?.armed) S.set(a.id, { a, s }); }
  const firstOf = new Map();
  const add = (id, frame, by) => {
    if (!(frame >= 0 && frame < frames)) return false;
    const { s } = S.get(id);
    if (!s.repeat && firstOf.has(id)) return false;
    if (out.some((x) => x.id === id && x.frame === frame)) return false;
    out.push({ id, kind: s.kind, frame, t: +(frame / fps).toFixed(3), by });
    if (!firstOf.has(id) || frame < firstOf.get(id)) firstOf.set(id, frame);
    return true;
  };
  for (const [id, { a, s }] of S) {
    const T = s.trigger;
    if (T.type === "time") add(id, Math.round(T.at * fps), "time");
    else if (T.type === "manual") for (const f of s.repeat ? s.keys : s.keys.slice(-1)) add(id, f, "manual");
    else if (T.type === "contact") {
      const p = posOf(a), reach = Math.max(0.6, s.radius);
      let best = null;
      for (const e of events) {
        if ((+e.speed || 0) < T.min_speed || e.a === id || e.b === id) continue;
        const hit = T.watch ? e.a === T.watch || e.b === T.watch : Array.isArray(e.pos) && Math.hypot(e.pos[0] - p[0], e.pos[1] - p[1], e.pos[2] - p[2]) <= reach;
        if (hit && (best == null || e.frame < best.frame)) best = e;
      }
      const near = opts.proximity ? opts.proximity(a, s) : null;
      if (best && (near == null || best.frame <= near)) add(id, best.frame, `contact:${T.watch || best.a}`);
      else if (near != null) add(id, near, "contact");
    }
  }
  // Chains: in order of the rig they follow, until nothing new fires (a cycle can't fire twice: one-shots fire once).
  for (let pass = 0; pass <= S.size; pass++) {
    let any = false;
    for (const [id, { s }] of S) {
      if (s.trigger.type !== "chain" || firstOf.has(id) || !s.trigger.after || !firstOf.has(s.trigger.after)) continue;
      any = add(id, firstOf.get(s.trigger.after) + Math.round(s.trigger.delay * fps), `chain:${s.trigger.after}`) || any;
    }
    if (!any) break;
  }
  return out.sort((p, q) => p.frame - q.frame || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

// ---------- the blast ----------
/** Blast strength: the impulse per square metre of exposed area inside the core of a power-1 charge (N s / m²), a film-scale
 * gag: power 1 beside a car rocks it hard, power 2.5 under it rolls it; a crate 2 m away is thrown ~4 m/s. */
export const BLAST_K = 800;
/** Core radius (m): inside it the blast is at full strength. */
export const BLAST_CORE = 2.0;
/** The most speed a blast gives anything (m/s). */
export const BLAST_MAX_DV = 22;
/** Upward share of a blast's push near the ground (the reflection off the ground lifts things). */
export const BLAST_LIFT = 0.55;

/** How much of the blast reaches distance d (m), 1 inside the core, inverse-square beyond, tapering to 0 at radius. */
export function blastFalloff(d, radius, core = BLAST_CORE) {
  if (!(d < radius)) return 0;
  const inv = 1 / (1 + Math.pow(Math.max(0, d) / core, 2));
  const u = clamp(d / radius, 0, 1), taper = 1 - u * u * (3 - 2 * u);
  return inv * taper;
}

/** The blast records the bake applies: [{id, frame, pos, power, radius, lift}] for the explosion fires. */
export function blastsFrom(rigs, fires, { posOf = (a) => a.position || [0, 0, 0] } = {}) {
  const by = new Map((rigs || []).map((a) => [a.id, a]));
  const out = [];
  for (const f of fires || []) {
    if (f.kind !== "explosion") continue;
    const a = by.get(f.id), s = sfxOf(a);
    if (!s) continue;
    const p = posOf(a);
    out.push({ id: f.id, frame: f.frame, pos: [p[0], Math.max(0.1, (p[1] || 0) + 0.3), p[2]], power: s.power, radius: s.radius * Math.cbrt(s.power), lift: BLAST_LIFT });
  }
  return out;
}

/**
 * The blast's push on one body. body: {pos (centre of mass), mass (kg), half (m, box half extents)}. Returns null outside
 * the radius, else {J (N s, world), dv (m/s), r (where it acts, from the centre: the near side, so the near side lifts
 * and a car rolls away from it), dist, exposure}. Heavier bodies move less; a bigger face catches more.
 */
export function blastImpulse(blast, body) {
  const c = body.pos, d0 = [c[0] - blast.pos[0], c[1] - blast.pos[1], c[2] - blast.pos[2]];
  const h = body.half || [0.3, 0.3, 0.3];
  // Distance to the body's nearest point, not its centre (a 4.5 m car beside a charge is hit at its door, a lamp post at its foot).
  const near = [0, 1, 2].map((k) => blast.pos[k] - clamp(blast.pos[k], c[k] - h[k], c[k] + h[k]));
  const dist = len3(near);
  const fall = blastFalloff(dist, blast.radius);
  if (fall <= 0) return null;
  const horiz = Math.hypot(d0[0], d0[2]);
  const nh = horiz > 1e-6 ? [d0[0] / horiz, 0, d0[2] / horiz] : [1, 0, 0];
  // Up and out: mostly out far away, more up close to the ground near the charge.
  const lift = (blast.lift ?? BLAST_LIFT) * (0.6 + 0.4 * fall);
  const n = norm3([nh[0] * (1 - lift * 0.5), Math.max(0, d0[1] / (len3(d0) || 1)) + lift, nh[2] * (1 - lift * 0.5)]);
  // The face it shows the charge (its projected side), plus the underside the lift catches.
  const exposure = 4 * h[1] * (h[0] * Math.abs(nh[2]) + h[2] * Math.abs(nh[0])) * 0.8 + 4 * h[0] * h[2] * 0.2 * lift;
  let jm = BLAST_K * blast.power * exposure * fall;
  const m = Math.max(0.5, +body.mass || 20);
  if (jm / m > BLAST_MAX_DV) jm = BLAST_MAX_DV * m;
  return { J: [n[0] * jm, n[1] * jm, n[2] * jm], dv: jm / m, impulse: jm, r: [-nh[0] * (h[0] * Math.abs(nh[0]) + h[2] * Math.abs(nh[2])) * 0.7, 0, -nh[2] * (h[0] * Math.abs(nh[0]) + h[2] * Math.abs(nh[2])) * 0.7], dist, exposure, fall };
}

// ---------- fire spread ----------
/**
 * When each flammable thing catches: {id: {frame, by}}. flammables: [{id, pos, half, material}] (frame-0 placement),
 * sources: the fire and explosion fires (a fire rig burns from its fire; an explosion ignites what is inside half its
 * radius). Fire spreads to a flammable within reach of something burning after its catch time plus the gap over the
 * material's spread speed. Deterministic (a Dijkstra on catch times), at most MAX_BURNING.
 */
export function burnSchedule(rigs, fires, flammables, { fps = 24, frames = 97, posOf = (a) => a.position || [0, 0, 0] } = {}) {
  const by = new Map((rigs || []).map((a) => [a.id, a]));
  const items = (flammables || []).filter((f) => FLAMMABLE[f.material]);
  const best = new Map();   // id -> {time (s), by}
  const burning = [];       // [{pos, half, t, id, fire}]
  for (const f of fires || []) {
    if (f.kind !== "fire" && f.kind !== "explosion" && f.kind !== "flare") continue;
    const a = by.get(f.id), s = sfxOf(a);
    if (!s) continue;
    const p = posOf(a), r = f.kind === "explosion" ? 0.5 * s.radius * Math.cbrt(s.power) : f.kind === "flare" ? 0.35 : s.radius * Math.sqrt(s.power);
    for (const it of items) {
      const gap = gapBetween(p, [r, r, r], it.pos, it.half);
      if (gap > 0) continue;
      const t = f.t + (f.kind === "explosion" ? 0.05 + 0.02 * len3([it.pos[0] - p[0], 0, it.pos[2] - p[2]]) : FLAMMABLE[it.material].catch);
      const cur = best.get(it.id);
      if (!cur || t < cur.time) best.set(it.id, { time: t, by: f.id });
    }
  }
  const done = new Set();
  for (let guard = 0; guard < items.length && done.size < MAX_BURNING; guard++) {
    let pick = null;
    for (const it of items) { const b = best.get(it.id); if (b && !done.has(it.id) && (!pick || b.time < best.get(pick.id).time || (b.time === best.get(pick.id).time && it.id < pick.id))) pick = it; }
    if (!pick) break;
    done.add(pick.id);
    const tb = best.get(pick.id).time;
    burning.push({ ...pick, t: tb });
    for (const it of items) {
      if (done.has(it.id)) continue;
      const gap = gapBetween(pick.pos, pick.half, it.pos, it.half);
      if (gap > 1.2) continue;
      const F = FLAMMABLE[it.material], t = tb + F.catch + Math.max(0, gap) / F.spread + 0.5 * Math.max(...pick.half) / FLAMMABLE[pick.material].spread;
      const cur = best.get(it.id);
      if (!cur || t < cur.time) best.set(it.id, { time: t, by: pick.id });
    }
  }
  const out = {};
  for (const b of burning) {
    const frame = Math.round(b.t * fps);
    if (frame < frames) out[b.id] = { frame, by: best.get(b.id).by };
  }
  return out;
}
/** The gap between two boxes (axis-aligned, by their half extents): <= 0 when they touch. */
function gapBetween(p, hp, q, hq) {
  const g = [0, 1, 2].map((k) => Math.abs(p[k] - q[k]) - hp[k] - hq[k]);
  return Math.max(g[0], g[1], g[2]);
}

// ---------- what each fire throws (particle emitters for particles.mjs) ----------
/**
 * Particle emitters for every fire and burn (particles.mjs simulateParticles). opts: {fps, frames, posOf(rig),
 * pointOf(rig, frame) → {pos, normal} (a body squib / stab: the wardrobe point on the person), burning: burnSchedule(),
 * flammables (to know a burning object's size), ground (the ground dust preset)}.
 */
export function sfxEmitters(rigs, fires, opts = {}) {
  const fps = opts.fps || 24, frames = opts.frames || 97, ground = opts.ground || "concrete_dust";
  const posOf = opts.posOf || ((a) => a.position || [0, 0, 0]);
  const by = new Map((rigs || []).map((a) => [a.id, a]));
  const out = [];
  const em = (o) => out.push({ vel: [0, 0, 0], normal: [0, 1, 0], k: 1, dust: 0, debris: 0, sparks: 0, size: 1, spread: 0.1, kick: 1, density: 1, ...o, src: "sfx" });
  const stream = (t0, t1, every, make) => { for (let f = Math.max(0, Math.round(t0 * fps)), i = 0; f < Math.min(frames, Math.round(t1 * fps)); f += every, i++) make(f / fps, i); };
  for (const F of fires || []) {
    const a = by.get(F.id), s = sfxOf(a);
    if (!s) continue;
    const p = posOf(a), P = s.power, seed = sfxSeed(F.id) + F.frame * 0.37, cr = Math.cbrt(P);
    if (s.kind === "explosion") {
      const c = [p[0], Math.max(0.2, (p[1] || 0) + 0.4), p[2]];
      // The fireball: a hot core that rolls up and out, then cools to smoke.
      em({ t: F.t, pos: c, dust: Math.round(70 * cr), preset: "fireball", size: 1.3 * cr, spread: 0.6 * cr, kick: 6.5 * cr, seed, density: 1 });
      em({ t: F.t + 0.06, pos: [c[0], c[1] + 0.8 * cr, c[2]], dust: Math.round(40 * cr), preset: "fireball", size: 1.7 * cr, spread: 0.9 * cr, kick: 4 * cr, seed: seed + 1 });
      // The shockwave: a ring of ground dust thrown flat and fast.
      em({ t: F.t + 0.02, pos: [p[0], 0.08, p[2]], dust: Math.round(50 * cr), preset: ground, size: 1.1 * cr, spread: 0.4, kick: 9 * cr, seed: seed + 2, density: 0.8 });
      // Debris and embers.
      em({ t: F.t, pos: c, debris: Math.round(60 * cr), debrisPreset: "char", sparks: Math.round(40 * cr), k: 2.2 * P, seed: seed + 3 });
      // Then the smoke column, for four seconds.
      stream(F.t + 0.25, F.t + 4.5, 3, (t, i) => em({ t, pos: [c[0], c[1] + 0.6 * cr, c[2]], dust: 6, preset: "smoke_column", color: SMOKE_COLORS.black, size: (1.2 + 0.02 * i) * cr, spread: 0.6 * cr, kick: 0.8, seed: seed + 10 + i, density: Math.max(0.35, 0.9 - 0.01 * i) }));
    } else if (s.kind === "fire" || s.kind === "flare") {
      const flare = s.kind === "flare", end = Number.isFinite(s.duration) ? F.t + s.duration : frames / fps;
      stream(F.t, end, 2, (t, i) => em({ t, pos: [p[0], (p[1] || 0) + (flare ? 0.12 : 0.15), p[2]], dust: flare ? 1 : Math.max(1, Math.round(3 * Math.sqrt(P))), preset: flare ? "flare_glow" : "flame",
        size: flare ? 0.4 : 0.9 * Math.sqrt(P) * Math.max(0.5, s.radius), spread: flare ? 0.03 : 0.3 * s.radius, kick: 0.3, sparks: i % (flare ? 2 : 5) === 0 ? 1 : 0, k: 0.3, seed: seed + i }));
      stream(F.t + 0.3, end, flare ? 6 : 4, (t, i) => em({ t, pos: [p[0], (p[1] || 0) + (flare ? 0.2 : 0.9 * Math.sqrt(P)), p[2]], dust: flare ? 1 : 2, preset: "smoke_column",
        color: flare ? SMOKE_COLORS.red.map((x) => 0.5 + 0.5 * x) : SMOKE_COLORS.black, size: flare ? 0.5 : Math.sqrt(P), spread: 0.2, kick: 0.3, seed: seed + 500 + i, density: flare ? 0.35 : 0.55 }));
    } else if (s.kind === "sparks") {
      const dur = s.duration || 1.6, n = s.dir || [0, -1, 0];
      stream(F.t, F.t + dur, 2, (t, i) => em({ t, pos: [p[0], (p[1] || 0) + s.radius * 0.1, p[2]], normal: n, sparks: Math.round(12 * P), k: 0.4 * P, seed: seed + i }));
    } else if (s.kind === "smoke_bomb") {
      const col = SMOKE_COLORS[s.color] || SMOKE_COLORS.grey, dur = s.duration || 7;
      stream(F.t, F.t + dur, 3, (t, i) => em({ t, pos: [p[0], (p[1] || 0) + 0.15, p[2]], dust: Math.round(4 * P), preset: "smoke_bomb", color: col, size: 1.0 * Math.sqrt(P), spread: 0.15, kick: 1.4, seed: seed + i, density: 0.8 }));
    } else if (s.kind === "breakaway_glass") {
      em({ t: F.t, pos: [p[0], (p[1] || 0) + 0.9, p[2]], normal: s.dir || [0, 0, 1], debris: Math.round(90 * Math.sqrt(P)), debrisPreset: "glass", dust: 6, preset: ground, k: 1.4 * P, size: 0.5, spread: 0.5, kick: 1, seed, density: 0.3 });
    } else if (s.kind === "squib") {
      const surf = squibSurface(s, p);
      const n = s.dir || (surf === "wall" || surf === "glass" || surf === "car" ? [0, 0, 1] : [0, 1, 0]);
      const at = [p[0], Math.max(0.03, p[1] || 0), p[2]];
      if (surf === "water") em({ t: F.t, pos: [at[0], Math.max(0.02, at[1]), at[2]], normal: [0, 1, 0], dust: 10, preset: "wet_spray", debris: 26, debrisPreset: "wet_spray", k: 1.6 * P, size: 0.5, spread: 0.05, kick: 3.5, seed, density: 0.7 });
      else if (surf === "ground") em({ t: F.t, pos: at, normal: [0, 1, 0], dust: 14, preset: ground, debris: 16, debrisPreset: ground, k: 1.4 * P, size: 0.45, spread: 0.04, kick: 2.6, seed, density: 0.9 });
      else if (surf === "glass") em({ t: F.t, pos: at, normal: n, debris: 22, debrisPreset: "glass", dust: 2, preset: ground, k: P, size: 0.3, spread: 0.03, kick: 1.5, seed, density: 0.2 });
      else if (surf === "car") em({ t: F.t, pos: at, normal: n, sparks: Math.round(14 * P), dust: 3, preset: "concrete_dust", debris: 4, debrisPreset: "metal", k: P, size: 0.3, spread: 0.02, kick: 1.2, seed, density: 0.4 });
      else em({ t: F.t, pos: at, normal: n, dust: 12, preset: "concrete_dust", debris: 14, debrisPreset: "concrete_dust", sparks: 2, k: 1.2 * P, size: 0.4, spread: 0.03, kick: 2.2, seed, density: 0.9 });
    } else if (s.kind === "body_squib" || s.kind === "stab") {
      const pt = opts.pointOf?.(a, F.frame);
      if (!pt) continue;
      const stab = s.kind === "stab";
      if (!stab) em({ t: F.t, pos: pt.pos, normal: pt.normal, dust: 6, preset: "fabric_puff", size: 0.35, spread: 0.02, kick: 1.6, seed, density: 0.7 });
      if (s.blood) em({ t: F.t + (stab ? 0.08 : 0), pos: pt.pos, normal: pt.normal, vel: pt.vel || [0, 0, 0], debris: stab ? 10 : Math.round(22 * P), debrisPreset: "blood", k: stab ? 0.25 : 0.7 * P, size: 0.2, spread: 0.02, kick: 0.6, seed: seed + 1 });
    }
  }
  // What caught fire: flames and smoke off each burning object, sized by it.
  const fl = new Map((opts.flammables || []).map((f) => [f.id, f]));
  for (const [id, b] of Object.entries(opts.burning || {})) {
    const it = fl.get(id);
    if (!it) continue;
    const sz = Math.max(it.half[0], it.half[2]);
    const at = (t) => (it.at ? it.at(Math.round(t * fps)) : it.pos);   // a burning crate the blast threw burns where it landed
    stream(b.frame / fps, frames / fps, 2, (t, i) => {
      const grow = Math.min(1, (t - b.frame / fps) / 2.5);   // it takes a couple of seconds to take hold
      const q = at(t), top = q[1] + it.half[1];
      em({ t, pos: [q[0], top * (0.4 + 0.6 * grow), q[2]], dust: Math.max(1, Math.round((1 + 3 * grow) * Math.sqrt(sz / 0.3))), preset: "flame", size: (0.5 + 0.7 * grow) * Math.max(0.6, sz * 2),
        spread: sz * 0.8, kick: 0.25, sparks: i % 6 === 0 ? 1 : 0, k: 0.3, seed: sfxSeed(id) + i });
    });
    stream(b.frame / fps + 0.6, frames / fps, 5, (t, i) => em({ t, pos: [at(t)[0], at(t)[1] + it.half[1] + 0.3, at(t)[2]], dust: 2, preset: "smoke_column", color: SMOKE_COLORS.black, size: Math.max(0.8, sz * 2.4), spread: sz * 0.5, kick: 0.3, seed: sfxSeed(id) + 900 + i, density: 0.5 }));
  }
  return out;
}

/** The surface a squib is on: its setting, or (auto) the ground when it sits low, a wall otherwise. */
export function squibSurface(s, p) {
  if (s.surface && s.surface !== "auto") return s.surface;
  return (p?.[1] || 0) < 0.25 ? "ground" : "wall";
}

// ---------- light and camera ----------
/**
 * The practical light at frame F: [{pos, intensity, color}] (strongest first, at most 2): the fireball's flash, the
 * flicker of fires, a flare's red glow, a squib's pop.
 */
export function sfxLightsAt(rigs, fires, F, { fps = 24, posOf = (a) => a.position || [0, 0, 0], burning = {}, flammables = [] } = {}) {
  const by = new Map((rigs || []).map((a) => [a.id, a])), L = [];
  const t = F / fps;
  for (const f of fires || []) {
    const a = by.get(f.id), s = sfxOf(a), age = t - f.t;
    if (!s || age < 0) continue;
    const p = posOf(a), seed = sfxSeed(f.id);
    if (s.kind === "explosion" && age < 4) L.push({ pos: [p[0], (p[1] || 0) + 1.5 * Math.cbrt(s.power), p[2]], intensity: 80 * s.power * Math.exp(-age / 0.28) + 6 * s.power * Math.exp(-age / 1.5), color: [1, 0.62, 0.3] });
    else if (s.kind === "fire" && (!Number.isFinite(s.duration) || age < s.duration)) L.push({ pos: [p[0], (p[1] || 0) + 0.8, p[2]], intensity: Math.min(1, age / 0.6) * 9 * s.power * (0.8 + 0.2 * Math.sin(F * 1.7 + seed) * Math.sin(F * 0.73 + seed)), color: [1, 0.6, 0.28] });
    else if (s.kind === "flare" && age < (s.duration || 12)) L.push({ pos: [p[0], (p[1] || 0) + 0.3, p[2]], intensity: 5 * (0.85 + 0.15 * Math.sin(F * 2.3 + seed)), color: [1, 0.15, 0.1] });
    else if (s.kind === "sparks" && age < (s.duration || 1.6)) L.push({ pos: [...p], intensity: 3 * s.power, color: [1, 0.8, 0.5] });
    else if (s.kind === "squib" && age < 0.08) L.push({ pos: [...p], intensity: 2.5 * s.power, color: [1, 0.85, 0.6] });
  }
  const fl = new Map(flammables.map((x) => [x.id, x]));
  for (const [id, b] of Object.entries(burning || {})) {
    const it = fl.get(id), age = t - b.frame / fps;
    if (!it || age < 0) continue;
    const q = it.at ? it.at(F) : it.pos;
    L.push({ pos: [q[0], q[1] + it.half[1] + 0.4, q[2]], intensity: Math.min(1, age / 2.5) * 7 * (0.8 + 0.2 * Math.sin(F * 1.9 + sfxSeed(id))), color: [1, 0.58, 0.26] });
  }
  return L.sort((p, q) => q.intensity - p.intensity).slice(0, 2);
}

/**
 * Camera shake from the explosions at frame F: {pos: [dx, dy, dz] (m), aim: [dx, dy, dz] (m, added to the target)}.
 * Amplitude by power and distance to the camera; it hits a few frames after the flash (the shockwave travels) and settles.
 */
export function sfxShakeAt(rigs, fires, F, camPos, { fps = 24, posOf = (a) => a.position || [0, 0, 0], scale = 1 } = {}) {
  const by = new Map((rigs || []).map((a) => [a.id, a]));
  const out = { pos: [0, 0, 0], aim: [0, 0, 0] };
  for (const f of fires || []) {
    if (f.kind !== "explosion") continue;
    const a = by.get(f.id), s = sfxOf(a);
    if (!s) continue;
    const p = posOf(a), d = Math.hypot(camPos[0] - p[0], camPos[1] - (p[1] || 0), camPos[2] - p[2]);
    const age = F / fps - f.t - d / 340;   // the shockwave arrives at the speed of sound
    if (age < 0 || age > 2) continue;
    const A = scale * 0.16 * s.power / (1 + d / 7) * Math.exp(-age / 0.35) * Math.min(1, age / 0.03);
    const ph = sfxSeed(f.id);
    for (let k = 0; k < 3; k++) {
      out.pos[k] += A * Math.sin(age * (31 + 7 * k) + ph + k * 2.1) * (k === 1 ? 0.6 : 1);
      out.aim[k] += A * 1.6 * Math.sin(age * (23 + 5 * k) + ph * 0.7 + k);
    }
  }
  return out;
}

/** Scorch marks the fires leave on the ground (persist from their frame): [{id, pos, radius, frame}]. */
export function scorchMarks(rigs, fires, { posOf = (a) => a.position || [0, 0, 0], burning = {}, flammables = [] } = {}) {
  const by = new Map((rigs || []).map((a) => [a.id, a])), out = [];
  for (const f of fires || []) {
    const a = by.get(f.id), s = sfxOf(a);
    if (!s) continue;
    const p = posOf(a);
    if ((p[1] || 0) > 0.6) continue;   // up off the ground: no mark on it
    const r = s.kind === "explosion" ? 1.6 * Math.cbrt(s.power) : s.kind === "fire" ? 0.8 * s.radius * Math.sqrt(s.power) : s.kind === "flare" ? 0.18 : s.kind === "squib" && squibSurface(s, p) === "ground" ? 0.12 : 0;
    if (r > 0 && !out.some((m) => m.id === f.id)) out.push({ id: f.id, pos: [p[0], 0.004, p[2]], radius: +r.toFixed(3), frame: f.frame });
  }
  const fl = new Map(flammables.map((x) => [x.id, x]));
  for (const [id, b] of Object.entries(burning || {})) {
    const it = fl.get(id);
    if (it && it.pos[1] - it.half[1] < 0.3) out.push({ id: `${id}#burn`, pos: [it.pos[0], 0.004, it.pos[2]], radius: +(Math.max(it.half[0], it.half[2]) * 1.5).toFixed(3), frame: b.frame });
  }
  return out;
}

// ---------- on the actor: wounds and hit reactions ----------
/**
 * A body hit's reaction by where it lands (stunt-performer style, scaled by the gag's power): {jolt (m, the snap away from
 * the hit), lean (rad, + = away from the hit), twist (rad, about the spine, + = the hit side goes back), drop (m, knees
 * buckling), clutch (which hand goes to it: "l" | "r" | "both" | null), fall ("back" | "forward" | "side" | "knee" |
 * null), stagger (m of steps away), dur (s until the fall starts or the reaction settles)}.
 */
export function hitReaction(point, power = 1, { kind = "body_squib", fall = null } = {}) {
  const P = clamp(power, 0.1, 4), bp = BODY_POINTS[point] || BODY_POINTS.chest;
  const side = bp.s > 0 ? "l" : bp.s < 0 ? "r" : null;
  if (kind === "stab") return { jolt: 0.04, lean: -0.5, twist: 0.1 * Math.sign(bp.s || 1), drop: 0.12, clutch: "both", fall: fall === true ? "knee" : fall === false ? null : P >= 1.5 ? "knee" : null, stagger: 0.2, dur: 0.9 };
  const base = {
    chest: { jolt: 0.1, lean: 0.32, twist: 0, drop: 0.06, clutch: "both", fall: "back", stagger: 0.6, dur: 0.75 },
    belly: { jolt: 0.07, lean: -0.38, twist: 0, drop: 0.12, clutch: "both", fall: "forward", stagger: 0.3, dur: 0.85 },
    back: { jolt: 0.1, lean: 0.28, twist: 0, drop: 0.05, clutch: null, fall: "forward", stagger: 0.5, dur: 0.6 },
    shoulder: { jolt: 0.08, lean: 0.16, twist: 0.55, drop: 0.03, clutch: side === "l" ? "r" : "l", fall: "side", stagger: 0.4, dur: 0.7 },
    arm: { jolt: 0.04, lean: 0.05, twist: 0.3, drop: 0.02, clutch: side === "l" ? "r" : "l", fall: null, stagger: 0.15, dur: 0.5 },
    leg: { jolt: 0.03, lean: -0.12, twist: 0.1, drop: 0.22, clutch: side, fall: "knee", stagger: 0.1, dur: 0.45 },
  }[point.split("_")[0]] || null;
  const r = { ...(base || { jolt: 0.1, lean: 0.32, twist: 0, drop: 0.06, clutch: "both", fall: "back", stagger: 0.6, dur: 0.75 }) };
  r.jolt *= Math.sqrt(P); r.lean *= Math.min(1.6, Math.sqrt(P)); r.twist *= Math.min(1.6, Math.sqrt(P)) * Math.sign(bp.s || 1); r.stagger *= Math.sqrt(P);
  // A light gag (power < 0.7) staggers but stays up unless the fall is asked for; a hard one goes down.
  if (fall === false) r.fall = null;
  else if (fall === true) r.fall ||= "knee";
  else if (!r.fall || P < 0.7 || ((r.fall === "back" || r.fall === "forward") && P < 0.9)) r.fall = null;
  return r;
}

/**
 * The reaction at `age` s after the hit: {lean, twist, drop, back (m, the jolt and stagger, + = away from the hit),
 * clutch (0..1, the hand going to the wound), down (0..1: the fall: 1 = on the ground), fall}. 0 before the hit. The
 * snap is fast (a squib reads in 2-3 frames), the stagger slower, then the fall.
 */
export function reactionAt(R, age) {
  const z = { lean: 0, twist: 0, drop: 0, back: 0, clutch: 0, down: 0, fall: R?.fall || null };
  if (!R || !(age >= 0)) return z;
  const snap = 1 - Math.exp(-age / 0.045), ease = (u) => u * u * (3 - 2 * clamp(u, 0, 1));
  const settle = R.fall ? 1 : 0.35 + 0.65 * Math.exp(-Math.max(0, age - R.dur) / 0.9);
  z.lean = R.lean * snap * settle;
  z.twist = R.twist * snap * settle;
  z.back = R.jolt * snap + R.stagger * ease(clamp(age / Math.max(0.2, R.dur), 0, 1));
  z.drop = R.drop * ease(clamp(age / 0.35, 0, 1));
  z.clutch = R.clutch ? ease(clamp((age - 0.1) / 0.35, 0, 1)) : 0;
  if (R.fall) z.down = ease(clamp((age - R.dur) / (R.fall === "knee" ? 0.4 : 0.7), 0, 1));
  return z;
}

/** The wardrobe point in the person's own frame (x left, y up, z forward): [x, y, z] and the outward normal. */
export function bodyPointLocal(point, height = 1.8) {
  const bp = BODY_POINTS[point] || BODY_POINTS.chest, h = height;
  const half = 0.17 * h / 1.8, depth = 0.12 * h / 1.8;
  const x = bp.s * half * 0.8, z = bp.f * depth;
  const n = norm3([bp.s * 0.8, 0.05, bp.f]);
  return { pos: [x, bp.h * h, z], normal: n };
}

/**
 * The wounds on screen at frame F (persist from the hit to the end): [{id, target, point, kind: "squib" | "slash",
 * age (s), stain (0..1, the stain spreading through the fabric), trickle (m, the blood running down)}].
 */
export function woundsAt(rigs, fires, F, { fps = 24 } = {}) {
  const by = new Map((rigs || []).map((a) => [a.id, a])), out = [];
  for (const f of fires || []) {
    if (f.kind !== "body_squib" && f.kind !== "stab") continue;
    const a = by.get(f.id), s = sfxOf(a), age = F / fps - f.t;
    if (!s || !s.target || age < 0) continue;
    const stain = s.blood ? 1 - Math.exp(-age / 0.9) : 0.15;
    out.push({ id: `${f.id}@${f.frame}`, rig: f.id, target: s.target, point: s.point, kind: f.kind === "stab" ? "slash" : "squib", age: +age.toFixed(3),
      stain: +stain.toFixed(4), trickle: s.blood ? +Math.min(0.22, 0.05 * Math.max(0, age - 0.3)).toFixed(4) : 0, power: s.power });
  }
  return out;
}

/** The hits on each person, earliest first: {targetId: [{rig, frame, point, kind, power, R (hitReaction)}]}. */
export function bodyHits(rigs, fires) {
  const by = new Map((rigs || []).map((a) => [a.id, a])), out = {};
  for (const f of fires || []) {
    if (f.kind !== "body_squib" && f.kind !== "stab") continue;
    const s = sfxOf(by.get(f.id));
    if (!s?.target || !s.react) continue;
    (out[s.target] ||= []).push({ rig: f.id, frame: f.frame, point: s.point, kind: f.kind, power: s.power, R: hitReaction(s.point, s.power, { kind: f.kind, fall: s.fall }) });
  }
  for (const k of Object.keys(out)) out[k].sort((p, q) => p.frame - q.frame);
  return out;
}

/** The person's combined reaction at frame F (several hits add; the first fall wins). */
export function personReactionAt(hits, F, { fps = 24 } = {}) {
  const z = { lean: 0, twist: 0, drop: 0, back: 0, clutch: 0, clutchHand: null, down: 0, fall: null, frame: null };
  for (const h of hits || []) {
    const r = reactionAt(h.R, F / fps - h.frame / fps);
    if (F < h.frame) continue;
    z.lean += r.lean; z.twist += r.twist; z.drop = Math.max(z.drop, r.drop); z.back += r.back;
    if (r.clutch > z.clutch) { z.clutch = r.clutch; z.clutchHand = h.R.clutch; }
    if (r.fall && !z.fall) { z.fall = r.fall; z.down = r.down; z.frame = h.frame; } else if (r.fall === z.fall) z.down = Math.max(z.down, r.down);
  }
  z.lean = clamp(z.lean, -0.9, 0.9); z.twist = clamp(z.twist, -1, 1); z.back = Math.min(z.back, 1.6);
  return z;
}

// ---------- the record the bake keeps ----------
/** The bake's SFX record for scene.physics.sfx (what the prompt compiler and the A2 sounds read). */
export function sfxRecord(fires, { burning = {}, affected = [], scorch = [], wounds = [] } = {}) {
  return { fires: fires.map((f) => ({ ...f })), burning: { ...burning }, affected: affected.map((x) => ({ ...x })), scorch: scorch.map((x) => ({ ...x })),
    wounds: wounds.map((w) => ({ rig: w.rig, target: w.target, point: w.point, kind: w.kind })) };
}

/**
 * What the blast did to one baked body, in words the prompt can use: "flips" (on its roof), "rolls" (onto its side),
 * "rolls over" (all the way, back on its wheels), "rocks up" (two wheels), "rocks", "thrown", "knocked down", "falls",
 * "breaks". keys: its baked keys ({quat} per key); the most it tipped over the bake counts, not only how it ended.
 */
export function blastOutcome({ role, keys, broke, dv }) {
  if (broke) return "breaks";
  const k = keys || [];
  const upY = (q) => 1 - 2 * ((q?.[0] || 0) ** 2 + (q?.[2] || 0) ** 2);   // the body's up axis, its world y
  const last = upY(k[k.length - 1]?.quat || [0, 0, 0, 1]);
  let tip = 0;
  for (const x of k) tip = Math.max(tip, Math.acos(clamp(upY(x.quat || [0, 0, 0, 1]), -1, 1)));
  if (role === "person") return "knocked down";
  if (role === "anchored") return "falls";
  if (role === "vehicle") return last < -0.3 ? "flips" : last < 0.5 ? "rolls" : tip > 1.75 ? "rolls over" : tip > 0.35 ? "rocks up" : "rocks";
  return (dv || 0) > 4 || last < 0.5 ? "thrown" : "rocks";
}
