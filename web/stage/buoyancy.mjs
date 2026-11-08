// Soundstage buoyancy: weight-based floating and sinking in a pool, a tank or the sea (the stage's _waterPhysics and
// the swimmers' water track). Every object gets a density (kg/m3: the kind / material table below, overridden by the
// Physics panel's mass, or by the per-object "Floats / sinks" density) and a volume from its bounds. The net vertical
// force is (rho_water * V_submerged - m) g, with quadratic drag on the wetted part, added mass (the water it carries
// along) and a little wave-radiation damping at the surface, so a float settles at its real waterline with an
// under-damped bob and a heavy thing sinks at its terminal speed to the bottom.
//
// Determinism: a track is integrated once per actor per shot on fixed sub-steps from its keys (precomputed, cached on
// the keys by the stage like _floatsInShot), and every frame is a lookup: scrubbing to a frame gives the same pose
// whatever was shown before. Nothing reads the clock or Math.random; per-person variation is seeded from the id.
//
// Numbers (fresh water 1000, people 985 inhaled / 1040-1045 exhaled, wood 150-700 and waterlogged toward 1000-1200,
// rock 2650, steel 7850, limp body sinking 0.1-0.35 m/s, a car floating ~30-120 s then going down nose first) are from
// the research notes in docs/swim.md (Siri 1961, Brozek 1963, USDA Wood Handbook, Hoerner drag, Giesbrecht &
// McDonald 2010, Pia 1974). Film compression: waterlogging and car flooding run on tens of seconds, not hours or
// minutes, and a non-swimmer struggles for seconds rather than the 20-60 s of a real drowning, so a shot shows it.

export const RHO_WATER = 1000;
export const G = 9.81;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hash01 = (s, k = 0) => { const x = Math.sin((s + 1) * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

/** Submerged volume fraction of a shape whose bottom is s (0..1) of its height under water. */
export const SHAPES = {
  box: (s) => clamp(s, 0, 1),
  sphere: (s) => { s = clamp(s, 0, 1); return s * s * (3 - 2 * s); },
  // a log lying on its side (circular cross-section)
  log: (s) => { s = clamp(s, 0, 1); const th = 2 * Math.acos(1 - 2 * s); return (th - Math.sin(th)) / (2 * Math.PI); },
};

/**
 * Per kind: rho (kg/m3, the object as a whole: a crate is slats and air), fill (its solid volume over its bounding
 * box), shape (how the submerged volume grows with depth), cd (drag coefficient), ca (added-mass coefficient), zeta
 * (bob damping ratio at the surface), and for things that soak or flood, sat (the density it tends to) over tau s.
 * what: the words the Physics panel shows.
 */
export const KIND_BUOYANCY = {
  crate: { rho: 400, sat: 950, tau: 90, cd: 1.05, ca: 0.6, zeta: 0.15, what: "wooden crate (soaks slowly, still floats)" },
  box: { rho: 180, sat: 1150, tau: 20, cd: 1.05, ca: 0.6, zeta: 0.15, what: "cardboard box (soaks through and sinks)" },
  sphere: { rho: 110, fill: Math.PI / 6, shape: "sphere", cd: 0.47, ca: 0.5, zeta: 0.06, what: "inflated ball" },
  rock: { rho: 2650, fill: 0.55, cd: 0.8, ca: 0.5, zeta: 0.1, what: "rock (granite)" },
  cube: { rho: 2400, cd: 1.05, ca: 0.6, zeta: 0.1, what: "concrete block" },
  pyramid: { rho: 2400, fill: 1 / 3, cd: 0.8, ca: 0.5, zeta: 0.1, what: "concrete" },
  wall: { rho: 2400, cd: 1.1, ca: 0.6, zeta: 0.1, what: "concrete" },
  fire: { rho: 2400, fill: 0.4, cd: 1, ca: 0.5, zeta: 0.1, what: "stone fire pit" },
  flashlight: { rho: 1500, fill: 0.7, cd: 0.9, ca: 0.5, zeta: 0.1, what: "metal torch" },
  lamp: { rho: 3000, fill: 0.08, cd: 1, ca: 0.6, zeta: 0.1, what: "metal lamp post" },
  bicycle: { rho: 3000, fill: 0.04, cd: 1.1, ca: 0.6, zeta: 0.1, what: "steel bicycle" },
  motorcycle: { rho: 2600, fill: 0.18, cd: 1, ca: 0.6, zeta: 0.1, what: "motorcycle (metal)" },
  tv: { rho: 1600, fill: 0.8, cd: 1.05, ca: 0.6, zeta: 0.1, what: "television (glass, metal)" },
  cone: { rho: 1350, fill: 0.15, cd: 0.9, ca: 0.5, zeta: 0.1, what: "PVC traffic cone" },
  chair: { rho: 600, fill: 0.25, cd: 1.1, ca: 0.6, zeta: 0.18, what: "wooden chair" },
  stool: { rho: 600, fill: 0.25, cd: 1.1, ca: 0.6, zeta: 0.18, what: "wooden stool" },
  table: { rho: 650, fill: 0.25, cd: 1.15, ca: 0.6, zeta: 0.18, what: "wooden table" },
  coffee_table: { rho: 650, fill: 0.3, cd: 1.15, ca: 0.6, zeta: 0.18, what: "wooden table" },
  desk: { rho: 650, fill: 0.4, cd: 1.15, ca: 0.6, zeta: 0.18, what: "wooden desk" },
  bench: { rho: 650, fill: 0.3, cd: 1.15, ca: 0.6, zeta: 0.18, what: "wooden bench" },
  armchair: { rho: 300, sat: 1050, tau: 60, fill: 0.6, cd: 1.1, ca: 0.6, zeta: 0.2, what: "upholstered chair (soaks, then sinks)" },
  cylinder: { rho: 700, fill: Math.PI / 4, cd: 1, ca: 0.8, zeta: 0.15, what: "wooden log" },
  tree: { rho: 600, fill: 0.15, cd: 1.1, ca: 0.8, zeta: 0.2, what: "wood (a tree)" },
  bush: { rho: 450, fill: 0.2, cd: 1.2, ca: 0.6, zeta: 0.25, what: "brush" },
  houseplant: { rho: 1250, fill: 0.4, cd: 1, ca: 0.5, zeta: 0.1, what: "potted plant (soil)" },
  // people off a swim plan (video mocap): air in the lungs, the face just out
  man: { rho: 985, fill: 0.28, cd: 1, ca: 0.3, zeta: 0.3, what: "person (air in the lungs)" },
  woman: { rho: 985, fill: 0.28, cd: 1, ca: 0.3, zeta: 0.3, what: "person (air in the lungs)" },
  child: { rho: 985, fill: 0.28, cd: 1, ca: 0.3, zeta: 0.3, what: "person (air in the lungs)" },
  // animals paddle with their head up: their own buoyancy plus the paddling holds them ~70% under
  dog: { rho: 720, fill: 0.35, cd: 1, ca: 0.3, zeta: 0.3, what: "dog (paddling)" },
  cat: { rho: 720, fill: 0.35, cd: 1, ca: 0.3, zeta: 0.3, what: "cat (paddling)" },
  horse: { rho: 720, fill: 0.35, cd: 1, ca: 0.3, zeta: 0.3, what: "horse (swimming)" },
  bird: { rho: 300, fill: 0.3, cd: 1, ca: 0.3, zeta: 0.3, what: "water bird" },
};
export const DEFAULT_BUOYANCY = { rho: 700, fill: 1, shape: "box", cd: 1.05, ca: 0.6, zeta: 0.15, what: "wood (default)" };
/** Cars (sealed cabin air): float high at first, then flood (density toward sat over tau s) and go down nose first. */
export const CAR_BUOYANCY = { fill: 0.6, sat: 2400, tau: 40, cd: 1.1, ca: 0.6, zeta: 0.25, what: "car (floats, then floods)" };
export const CAR_KINDS = new Set(["car", "hatchback", "sports_car", "police_car", "truck", "suv", "van", "jeep", "bus", "taxi"]);
const CAR_MASS = { car: 1450, hatchback: 1200, sports_car: 1500, police_car: 1900, truck: 2700, suv: 2100, van: 2200, jeep: 1900, bus: 12000, taxi: 1500 };

/** Floats / sinks presets for the Physics panel (density kg/m3; "auto" = the kind's own). */
export const DENSITY_PRESETS = [
  ["auto", "Auto (by kind)", null],
  ["foam", "Floats high (foam, 100)", 100],
  ["wood", "Floats (wood, 500)", 500],
  ["low", "Floats low (900)", 900],
  ["neutral", "Neutral (1000)", 1000],
  ["slow", "Sinks slowly (1100)", 1100],
  ["stone", "Sinks (stone, 2600)", 2600],
  ["metal", "Sinks fast (steel, 7850)", 7850],
];

/** A density from a number, a numeric string or a preset name; null for "auto" / junk. */
export function densityValue(v) {
  if (v == null || v === "" || v === "auto") return null;
  const pre = DENSITY_PRESETS.find((p) => p[0] === v);
  if (pre) return pre[2];
  const n = +v;
  return Number.isFinite(n) && n > 0 ? clamp(n, 20, 20000) : null;
}

/**
 * The buoyant body of a prop / animal / vehicle: {rho (at entry), m, V, h, A (horizontal area for drag), shape, cd,
 * ca, zeta, sat, tau, source ("density" | "mass" | "kind"), what}. size = [w, h, d] (m, its local box). opts.density
 * (kg/m3, the per-object override) wins over opts.mass (kg, the Physics panel's mass), which wins over the kind table.
 */
export function bodyOf(kind, size, { density = null, mass = null, sinking = false } = {}) {
  const car = CAR_KINDS.has(kind);
  const spec = { ...DEFAULT_BUOYANCY, ...(car ? CAR_BUOYANCY : KIND_BUOYANCY[kind] || {}) };
  const [w, h, d] = size.map((x) => Math.max(0.02, +x || 0));
  const V = Math.max(1e-4, w * h * d * (spec.fill ?? 1));
  let rho = spec.rho ?? 700, source = "kind";
  if (car) rho = (CAR_MASS[kind] || 1500) / V;
  const ov = densityValue(density);
  if (ov != null) { rho = ov; source = "density"; }
  else if (Number.isFinite(+mass) && mass !== null && mass !== "" && +mass > 0) { rho = clamp(+mass / V, 20, 20000); source = "mass"; }
  if (sinking) { rho = Math.max(rho, 1045); source = "sinking"; }   // an animal set to Can't swim / Sink slowly
  const A = spec.shape === "sphere" ? Math.PI * (Math.min(w, d) / 2) ** 2 : w * d * Math.pow(spec.fill ?? 1, 2 / 3);
  // A density override or a mass override is the object as it is now: no soaking on top (unless it was set to soak)
  const soak = source === "kind" && spec.sat ? { sat: spec.sat, tau: spec.tau } : {};
  return { kind, rho, m: rho * V, V, h, A, shape: spec.shape || "box", cd: spec.cd, ca: spec.ca, zeta: spec.zeta, ...soak, source, what: spec.what, car };
}

/** Density after t s in the water (soaking / flooding: an exponential approach to sat). */
export function densityAt(body, t) {
  if (!body.sat || !(t > 0)) return body.rho;
  return body.sat - (body.sat - body.rho) * Math.exp(-t / body.tau);
}

/** Fraction of the height under water when floating at density rho (1 = it sinks). */
export function floatFraction(body, rho = body.rho) {
  const want = rho / RHO_WATER, f = SHAPES[body.shape] || SHAPES.box;
  if (want >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (f(mid) < want) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** Where its bottom rests when placed in the water: at its waterline if it floats, else on the floor. */
export function restBottom(body, level, floor = 0, rho = body.rho) {
  const s = floatFraction(body, rho);
  return s >= 1 ? floor : Math.max(floor, level - s * body.h);
}

/** Terminal sinking (+) or rising (-) speed fully submerged, m/s (quadratic drag): sqrt(2 |dRho| V g / (rho_w Cd A)). */
export function terminalSpeed(body, rho = body.rho) {
  const dr = rho - RHO_WATER;
  return Math.sign(dr) * Math.sqrt(2 * Math.abs(dr) * body.V * G / (RHO_WATER * body.cd * body.A));
}

/** One fixed sub-step of the vertical motion of a body with its bottom at y, speed v (up +), density rho. */
function step(body, st, rho, level, floor, dt) {
  const f = SHAPES[body.shape] || SHAPES.box;
  const s = clamp((level - st.y) / body.h, 0, 1), fr = f(s), Vs = body.V * fr;
  const m = rho * body.V, M = m + body.ca * RHO_WATER * Vs;
  let F = (RHO_WATER * Vs - m) * G - 0.5 * RHO_WATER * body.cd * body.A * fr * st.v * Math.abs(st.v);
  if (s > 0 && s < 1) {   // piercing the surface: the waves it makes take energy out (an under-damped bob)
    const e = 0.02, awp = body.V * (f(Math.min(1, s + e)) - f(Math.max(0, s - e))) / ((Math.min(1, s + e) - Math.max(0, s - e)) * body.h);
    F -= 2 * body.zeta * Math.sqrt(RHO_WATER * G * Math.max(1e-6, awp) * M) * st.v;
  }
  st.v += (F / M) * dt;
  st.y += st.v * dt;
  if (st.y < floor) { st.y = floor; if (st.v < 0) st.v = 0; }
  return s;
}

export const SUBSTEPS = 12;

/**
 * The whole-shot vertical track of a body's bottom. keyY[f]: its keyed bottom height (with the Physics start height);
 * over[f]: is it over the water at f. Out of the water it is on its keys. The first frame over the water it is let go:
 * keyed above the surface it drops in (with the keyed vertical speed, e.g. off a baked fall); keyed under it it starts
 * there and rises or sinks; keyed at the floor (0, the default placement) it is placed in the water: floating at its
 * waterline or on the bottom. Returns {y, v, s (fraction of its height under), rho, entry (frame or -1), splash (the
 * frame it hits the surface, or -1), speedIn (m/s down at the surface)}.
 */
export function floatTrack(body, { level, floor = 0, fps = 24, keyY, over }) {
  const n = keyY.length, dt = 1 / (fps * SUBSTEPS);
  const y = new Array(n), v = new Array(n), S = new Array(n), R = new Array(n);
  let free = false, entry = -1, splash = -1, speedIn = 0, tw = 0;
  const st = { y: 0, v: 0 };
  for (let f = 0; f < n; f++) {
    if (!over[f]) {
      free = false;
      st.y = keyY[f]; st.v = f > 0 ? (keyY[f] - keyY[f - 1]) * fps : 0;
      y[f] = st.y; v[f] = st.v; S[f] = 0; R[f] = body.rho;
      continue;
    }
    if (!free) {
      free = true; tw = 0;
      if (entry < 0) entry = f;
      const ky = keyY[f];
      if (ky <= floor + 0.02) { st.y = restBottom(body, level, floor); st.v = 0; }   // placed in the water
      else { st.y = ky; st.v = f > 0 ? (keyY[f] - keyY[f - 1]) * fps : 0; }   // let go: the keyed (or baked) speed
    } else {
      for (let k = 0; k < SUBSTEPS; k++) {
        const above = st.y > level;
        const s = step(body, st, densityAt(body, tw), level, floor, dt);
        if (s > 0) tw += dt;
        if (above && st.y <= level && splash < 0) { splash = f; speedIn = -st.v; }
      }
    }
    y[f] = st.y; v[f] = st.v; S[f] = clamp((level - st.y) / body.h, 0, 1); R[f] = densityAt(body, tw);
  }
  return { y, v, s: S, rho: R, entry, splash, speedIn };
}

// ------------------------------------------------------------------ people in the water
/** Swim control per person (the person panel's Swim, stage.setSwim): what they do in the water. */
export const SWIM_MODES = [
  ["auto", "Auto (swims as keyed)"], ["tread", "Tread water"], ["breaststroke", "Swim: breaststroke"], ["freestyle", "Swim: freestyle"],
  ["back", "Float on back"], ["dive", "Dive / scuba (neutral)"], ["flutter", "Underwater: flutter kick"], ["frog", "Underwater: frog kick"],
  ["cant", "Can't swim / not treading"], ["sink", "Sink slowly (unconscious)"],
];
const MODE_IDS = new Set(SWIM_MODES.map((m) => m[0]).concat(["hover", "stroke"]));
/** A person's swim mode from a.swim ("off", the old "doesn't swim", is Can't swim now: they don't float like a cork). */
export function swimMode(v) {
  if (v === "off") return "cant";
  return MODE_IDS.has(v) ? v : "auto";
}
/** The human body for the water: ~75 kg at 1.8 m, density 985 with air in the lungs, 1045 breathed out (Siri). */
export function personBody(height = 1.8, build = 1) {
  const k = height / 1.8, m = 75 * k * k * k * build;
  // limp and splayed, clothes on: Cd x A ~ 0.9 m2 (a 0.1-0.3 m/s sink); upright treading area 0.08 m2 at the waterline
  return { m, Vlung: m / 985, Vout: m / 1045, cdA: 0.9 * k * k, ca: 0.3 };
}
const PERSON_RHO = { inhaled: 985, exhaled: 1045 };

/**
 * A sinking person's hips height after the slip under: integrated from rest at y0 (hips), density easing from 985 to
 * 1045 over `exhale` s (the air goes), quadratic drag (limp, splayed), added mass, the floor at floorHips. Pure: same
 * numbers for the same arguments.
 */
export function sinkTrack({ y0, floorHips, fps = 24, n, height = 1.8, exhale = 2.5, rho0 = PERSON_RHO.inhaled }) {
  const B = personBody(height), dt = 1 / (fps * SUBSTEPS);
  const out = new Array(n), vel = new Array(n);
  let y = y0, v = 0, t = 0;
  for (let f = 0; f < n; f++) {
    out[f] = y; vel[f] = v;
    for (let k = 0; k < SUBSTEPS; k++) {
      const rho = rho0 + (PERSON_RHO.exhaled - rho0) * sstep(0, exhale, t);
      const V = B.m / rho, M = B.m + B.ca * B.m;
      const F = (RHO_WATER * V - B.m) * G - 0.5 * RHO_WATER * B.cdA * v * Math.abs(v);
      v += (F / M) * dt; y += v * dt; t += dt;
      if (y < floorHips) { y = floorHips; v = 0; }
    }
  }
  return { y: out, v: vel };
}

/**
 * A person's water track for the swim plan (swim.mjs planSwim's styles / hipsY / hipsW): per frame the pose style that
 * overrides the speed-based one (or null), the hips height it puts them at (world y) and how much of it (0..1), and the
 * swim mode ("surface" | "under" | null). In = {mode (swimMode), keyY[f] (keyed feet height), over[f], level, floor,
 * fps, height, hipY (hips over the feet standing), seed}. Each run of frames over the water starts fresh:
 *   keyed above the surface they drop in feet first (gravity, the surface's drag, a plunge) and come back up;
 *   keyed fully under it (not on the floor) a swimmer kicks up to the surface (~0.6 m/s);
 *   tread / auto / strokes: then as before, at the surface (the speed picks tread, breaststroke or freestyle);
 *   back: floating on the back, legs down ~35 degrees, a slow breathing heave;
 *   cant: the instinctive drowning response at the surface (upright, head back, mouth at the water, arms pressing
 *     down, no kick) for a seeded 2-3.5 s, then they slip under and sink slowly and limp (~0.2-0.3 m/s), and settle
 *     on the bottom (no walking); keyed under the surface they sink from there;
 *   sink: no struggle, limp from the surface down.
 * dive and the underwater strokes are not tracked here (the stage keeps them at their keyed depth).
 */
export function personTrack({ mode, keyY, over, level, floor = 0, fps = 24, height = 1.8, hipY = 0.95, seed = 1 }) {
  const n = keyY.length, k = height / 1.8;
  const styles = new Array(n).fill(null), hipsY = new Array(n).fill(null), hipsW = new Array(n).fill(0), modes = new Array(n).fill(null);
  const treadHips = level - 0.52 * k, struggleHips = level - 0.6 * k, backHips = level - 0.16 * k;
  const sinks = mode === "cant" || mode === "sink";
  const blend = Math.max(1, Math.round(0.8 * fps));
  let f = 0;
  while (f < n) {
    if (!over[f]) { f++; continue; }
    const f0 = f;
    while (f < n && over[f]) f++;
    const m = f - f0, ky = keyY[f0];
    // Before they are at the surface: pre[i] = feet height, preMode[i], for i < up.
    const pre = [], preMode = [], preStyle = [];
    let up = 0, under = false;
    if (ky > level + 0.05) {   // a drop: a person-sized body (985 kg/m3, feet first) through the surface
      const M = 75 * k * k * k;
      const body = { rho: 985, V: M / 985, m: M, h: height, A: 0.12 * k * k, shape: "box", cd: 0.9, ca: 0.3, zeta: 0.3 };
      const tr = floatTrack(body, { level, floor, fps, keyY: new Array(m).fill(ky), over: new Array(m).fill(true) });
      const eqHips = restBottom(body, level, floor) + hipY;
      let rising = false;
      up = m;
      for (let i = 0; i < m; i++) {
        if (tr.splash >= 0 && i > tr.splash && tr.v[i] > 0) rising = true;
        if ((rising && tr.y[i] + hipY >= eqHips - 0.25) || (tr.splash >= 0 && i - tr.splash > 2.5 * fps)) { up = i; break; }
        pre.push(tr.y[i]); preMode.push(tr.y[i] > level ? "surface" : "under"); preStyle.push(tr.y[i] > level ? "fall" : "tread");
      }
    } else if (ky > floor + 0.35 && ky + height < level && !sinks) {   // keyed under: kick up to the surface
      const target = treadHips - hipY, upN = Math.max(1, Math.round((target - ky) / 0.6 * fps));
      up = Math.min(m, upN);
      for (let i = 0; i < up; i++) { pre.push(ky + (target - ky) * sstep(0, 1, i / upN)); preMode.push("under"); preStyle.push("tread"); }
    } else if (sinks && ky > floor + 0.02 && ky + height < level) under = true;   // can't swim, keyed under: sinks from there
    for (let i = 0; i < Math.min(up, m); i++) {
      const fr = f0 + i;
      styles[fr] = mode === "back" && preMode[i] === "under" ? "tread" : preStyle[i];
      hipsY[fr] = pre[i] + hipY; hipsW[fr] = 1; modes[fr] = preMode[i];
    }
    const from = up > 0 ? pre[up - 1] + hipY : null;   // where the drop / rise left the hips
    if (!sinks) {
      for (let i = up; i < m; i++) {
        const fr = f0 + i, t = i / fps, e = from == null ? 1 : sstep(0, 1, (i - up) / blend);
        modes[fr] = "surface";
        if (mode === "back") {
          const yb = backHips + 0.012 * k * Math.sin(2 * Math.PI * 0.25 * t + seed);
          styles[fr] = e < 0.5 ? "tread" : "backfloat"; hipsY[fr] = from == null ? yb : from + (yb - from) * e; hipsW[fr] = 1;
        } else {
          styles[fr] = mode === "tread" || (from != null && e < 0.5) ? "tread" : null;
          if (from != null && e < 1) { hipsY[fr] = from; hipsW[fr] = 1 - e; }
        }
      }
      continue;
    }
    // Can't swim / Sink slowly: the struggle, the slip under, the slow sink and the limp settle on the bottom.
    const tStruggle = mode === "cant" && !under ? 2 + 1.5 * hash01(seed, 3) : 0;   // seconds (film-compressed; real: 20-60 s)
    const fs = up + Math.round(tStruggle * fps);
    const floorHips = floor + hipY * 0.92;   // feet down, knees soft
    const y0 = under ? ky + hipY : mode === "cant" ? struggleHips : from != null ? Math.min(from, level - 0.55 * k) : level - 0.55 * k;
    const sink = sinkTrack({ y0, floorHips, fps, n: Math.max(1, m - fs), height, exhale: mode === "cant" ? 2.5 : 3.5, rho0: mode === "cant" ? 985 : 1000 });
    let landed = -1;
    for (let i = up; i < m; i++) {
      const fr = f0 + i, t = (i - up) / fps;
      if (i < fs) {   // the struggle: the head bobs 3-10 cm at ~0.8 Hz with irregular dips under
        const bob = 0.05 * k * Math.sin(2 * Math.PI * 0.8 * t + seed) - 0.07 * k * Math.pow(Math.max(0, Math.sin(2 * Math.PI * 0.31 * t + seed * 1.7)), 4);
        const yIn = from != null && i - up < blend ? from + (struggleHips - from) * sstep(0, 1, (i - up) / blend) : struggleHips;
        styles[fr] = "struggle"; hipsY[fr] = yIn + bob; hipsW[fr] = 1; modes[fr] = "surface";
        continue;
      }
      const j = i - fs, y = sink.y[j];
      if (landed < 0 && y <= floorHips + 1e-6) landed = i;
      const lie = landed >= 0 ? sstep(0, 1.5 * fps, i - landed) : 0;   // settles over ~1.5 s, then lies on the bottom
      const slip = mode === "cant" && !under ? sstep(0, 2 * fps, j) : 1;   // the arms stop, the head goes under
      styles[fr] = lie > 0.5 ? "limp_floor" : slip < 0.5 ? "struggle" : "limp";
      hipsY[fr] = y + (floor + 0.14 * k - y) * lie; hipsW[fr] = 1;
      modes[fr] = y + 0.75 * k > level ? "surface" : "under";
    }
  }
  return { styles, hipsY, hipsW, modes };
}
