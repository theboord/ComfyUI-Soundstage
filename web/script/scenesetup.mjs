// Set up a script scene on the stage: its set and weather, the time of day from the slugline, the scene's characters
// as named actors (looks from Cast & Locations where known) in simple blocking, and the vehicles / animals its heading
// calls for. Pure planning (no DOM, no three.js; tests/js/scenesetup.test.mjs); the host applies the plan.
//
//   const plan = planSceneSetup(scene, { actors, castItems, fresh, frame: { center: [x, z], cam: [x, z] } });
//   plan.label  -> "Set up scene 3 — EXT. PACIFIC BEACH — SUNSET (Mara)"
import { stageSetupForScene } from "./parse.mjs";
import { libraryObjects } from "./breakdown.mjs";
import { SEATS } from "../stage/library.mjs";
import { CABIN, PLANE_ROW } from "../stage/sets/airplane.mjs";
import { CAR } from "../stage/sets/train.mjs";

const PEOPLE = new Set(["man", "woman", "child"]);
export const castSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The scene's characters (speaking cast first), Title Case, at most `max`. */
export function sceneCast(sc, max = 6) {
  const out = [];
  for (const n of [...(sc?.breakdown?.cast || []), ...(sc?.characters || [])]) {
    const t = titleCase(String(n).replace(/\s*\((V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D)\)\s*/gi, " ").trim());
    if (t && !out.some((x) => castSlug(x) === castSlug(t))) out.push(t);
  }
  return out.slice(0, max);
}

/** Time of day from the slugline: a lighting preset id, or null to keep the current light (CONTINUOUS, LATER…). */
export function timePresetFor(sc) {
  const t = String(sc?.time || "").toUpperCase();
  if (/MAGIC\s*HOUR|GOLDEN\s*HOUR/.test(t)) return "magic_hour";
  if (/CONTINUOUS|LATER|SAME|MOMENTS?/.test(t) && !/NIGHT|DAY|DAWN|DUSK|SUNSET|SUNRISE|MORNING|EVENING/.test(t)) return null;
  if (/NIGHT|MIDNIGHT/.test(t)) return "night";
  if (/DAWN|SUNRISE|DAYBREAK/.test(t)) return "dawn";
  if (/MORNING/.test(t)) return "golden_am";
  if (/DUSK|SUNSET|EVENING|TWILIGHT/.test(t)) return "magic_hour";
  if (/DAY|NOON|AFTERNOON/.test(t)) return "midday";
  return stageSetupForScene(sc).time_preset || null;
}

const FEMALE_NAMES = new Set(("mara ana anna maria mary jane sarah sara emma olivia ava mia sophia sophie isabella grace lily rose " +
  "kate katie claire clara alice ella ellie lucy amy laura julia nina lena eva eve zoe chloe hannah leah rachel rebecca ruth " +
  "helen ellen diane diana linda susan karen nancy betty margaret maggie jess jessica jen jennifer lisa michelle nora iris " +
  "ruby violet hazel maya mae ada ida vera tess tessa dolores carmen rosa lucia elena sofia valentina camila mrs ms miss").split(" "));
const SHE = /\b(she|her|hers|herself|woman|girl|lady|mother|mom|wife|sister|daughter|aunt|queen|actress|waitress|madam)\b/gi;
const HE = /\b(he|him|his|himself|man|guy|boy|father|dad|husband|brother|son|uncle|king|sheriff|mister|mr)\b/gi;

/** Sentences of the scene's action that mention a name, plus the one after each (pronouns follow the name). */
function mentions(sc, name, { next = true } = {}) {
  const text = (sc?.elements || []).filter((e) => e.type === "action").map((e) => e.text).join(" ");
  const sents = text.split(/(?<=[.!?])\s+/);
  const first = castSlug(name).split(" ")[0];
  const out = [];
  sents.forEach((s, i) => { if (first && castSlug(s).split(" ").includes(first)) out.push(s, next ? sents[i + 1] || "" : ""); });
  return out.join(" ");
}

/** man / woman / child for a character, from its Cast description, the scene's action, then the name. */
export function guessPersonKind(name, { description = "", sc = null } = {}) {
  const text = `${description} ${sc ? mentions(sc, name) : ""}`;
  const age = /\((\d{1,2})s?\b/.exec(text);
  if (/\b(child|kid|boy|girl|toddler|baby)\b/i.test(description) || (age && +age[1] < 13)) return "child";
  const she = (text.match(SHE) || []).length, he = (text.match(HE) || []).length;
  if (she > he) return "woman";
  if (he > she) return "man";
  return FEMALE_NAMES.has(castSlug(name).split(" ").filter((w) => !/^(dr|mr|mrs|ms|miss|deputy|officer|detective|sheriff|captain|agent)$/.test(w))[0]) ? "woman" : "man";
}

const COLORS = { red: "#a3262a", crimson: "#8e1c24", maroon: "#5c1a1f", blue: "#2e4a7a", navy: "#1f2c4a", black: "#1b1b1d",
  white: "#e8e6e1", cream: "#e6dcc4", grey: "#7a7a7a", gray: "#7a7a7a", silver: "#a8a8a8", brown: "#6b4a2f", tan: "#b59a6a",
  khaki: "#a99b6e", beige: "#cbb894", green: "#3d5a3a", olive: "#5a5a32", yellow: "#d9b43a", orange: "#c8692a", pink: "#d48a9a",
  purple: "#5d3f74", denim: "#3a4d6e", leather: "#4a3022", dusty: "#a08a64", "dust-caked": "#a08a64", dusty_brown: "#a08a64" };
const TOPS = [[/\b(duster|trench|overcoat|coat|parka|poncho|cloak)\b/, "coat"], [/\b(jacket|leather|bomber|blazer)\b/, "jacket"],
  [/\b(suit|tux|tuxedo)\b/, "suit"], [/\b(dress|gown|sundress)\b/, "dress"],
  [/\b(uniform|deputy|officer|cop|police|soldier|nurse|guard|ranger|trooper)\b/, "uniform"], [/\b(hoodie|hooded)\b/, "hoodie"],
  [/\b(sweater|jumper|cardigan)\b/, "sweater"], [/\b(t-shirt|tee|tshirt)\b/, "tshirt"], [/\b(tank top|vest top)\b/, "tank"], [/\bshirt\b/, "shirt"]];
const BOTTOMS = [[/\b(skirt)\b/, "skirt"], [/\b(shorts)\b/, "shorts"], [/\b(jeans|denim)\b/, "jeans"], [/\b(trousers|slacks|pants|chinos)\b/, "trousers"]];

/** A previz look (humans.mjs appearance) from free text: "60s, grey hair, red wool coat, jeans". Only what the text says. */
export function appearanceFromText(text) {
  const t = String(text || "").toLowerCase();
  const ap = {};
  const garment = (list) => { for (const [re, v] of list) { const m = re.exec(t); if (m) return { v, at: m.index, len: m[0].length }; } return null; };
  const colorNear = (g) => {
    if (!g) return null;
    let before = t.slice(Math.max(0, g.at - 24), g.at);
    before = before.split(/[,;.()]| over | and | with /).pop();   // only the words that go with this garment
    let best = null;
    for (const [w, c] of Object.entries(COLORS)) { const i = before.lastIndexOf(w); if (i >= 0 && (!best || i > best.i)) best = { i, c }; }
    if (!best && /leather/.test(t.slice(g.at, g.at + g.len))) return COLORS.leather;
    return best?.c || null;
  };
  const top = garment(TOPS), bottom = garment(BOTTOMS);
  if (top) { ap.top = top.v; const c = colorNear(top); if (c) ap.top_color = c; if (top.v === "dress" && !bottom) ap.bottom = "skirt"; }
  if (bottom) { ap.bottom = bottom.v; const c = colorNear(bottom); if (c) ap.bottom_color = c; }
  if (/\bbald\b/.test(t)) ap.hair = "bald";
  else if (/\b(stetson|cowboy hat|fedora|hat)\b/.test(t)) ap.hair = "hat";
  else if (/\b(cap|beanie)\b/.test(t)) ap.hair = "cap";
  else if (/\bponytail\b/.test(t)) ap.hair = "ponytail";
  else if (/\bbun\b/.test(t)) ap.hair = "bun";
  else if (/\b(curly|curls|afro)\b/.test(t)) ap.hair = "curly";
  else if (/\blong (dark |black |blonde |red |grey |gray |brown )?hair\b/.test(t)) ap.hair = "long";
  else if (/\b(short|cropped|buzz) ?(cut|hair)\b/.test(t)) ap.hair = "short";
  const hc = /\b(blonde?|red|ginger|auburn|grey|gray|silver|white|black|dark|brown)[- ](haired|hair)\b/.exec(t);
  const age = /\b([5-9]0)s\b/.exec(t);
  if (hc) ap.hair_color = { blond: "#d8b46a", blonde: "#d8b46a", red: "#8a3b1e", ginger: "#8a3b1e", auburn: "#6e2f1c", grey: "#9a9a9a",
    gray: "#9a9a9a", silver: "#b8b8b8", white: "#dcdcdc", black: "#141414", dark: "#1e1712", brown: "#4a3222" }[hc[1]];
  else if (age && +age[1] >= 60) ap.hair_color = "#a3a3a3";
  if (/\b(heavy|stocky|burly|big|large|portly)\b/.test(t)) ap.build = "heavy";
  else if (/\b(athletic|muscular|fit|strong|broad)\b/.test(t)) ap.build = "athletic";
  else if (/\b(slim|thin|wiry|lanky|slight|skinny)\b/.test(t)) ap.build = "slim";
  return ap;
}

/** The character's introduction in the action ("MARA VOSS (30s, dust-caked duster)"): the parenthetical, if any. */
export function introOf(sc, name) {
  const text = (sc?.elements || []).filter((e) => e.type === "action").map((e) => e.text).join(" ");
  const first = String(name || "").split(/\s+/)[0];
  if (!first) return "";
  const re = new RegExp(`\\b${first.replace(/[^A-Za-z0-9]/g, "")}\\b[^()]{0,30}\\(([^)]{2,120})\\)`, "i");
  return re.exec(text)?.[1] || "";
}

// ---------------------------------------------------------------- Seated and mounted cast
// INT. SPORTS CAR (MOVING): the cast sits in the car's seats. "Two RIDERS walk their horses in": each rider is up on a
// horse. The host applies these with the stage's own mount mechanics (stage.mount, as the Interact tool does), so the
// compiler, the clay and the passes all see people where they sit, never standing beside the car or the horse.
const RIDE_RE = /\b(rides?|riding|rode|riders?|on horseback|horseback|mounted|in the saddle|saddled|spurs?|gallops?|galloping|canters?|cantering|trots?|trotting|reins|walks? (?:her|his|their) (?:horses?|mounts?))\b/i;
const ALL_RIDE_RE = /\b(riders|they ride|both ride|ride side by side|ride in together|horsemen)\b/i;
const DRIVE_RE = /\b(drives?|driving|drove|at the wheel|behind the wheel|grips the wheel|the wheel|steers?|steering|shifts gear|floors it|brakes?)\b/i;
const MOVING_RE = /\b(MOVING|DRIVING|TRAVELL?ING|IN TRANSIT)\b/i;
const MOUNT_KINDS = ["horse", "bicycle", "motorcycle"];
const actionOf = (sc) => (sc?.elements || []).filter((e) => e.type === "action").map((e) => e.text).join(" ");

/** The vehicle a scene plays inside (INT. SPORTS CAR (MOVING), EXT. HIGHWAY - MARA'S CAR (MOVING)) as a library kind
 *  with seats, and whether it is moving; null for a scene that isn't in a vehicle. */
export function vehicleOfScene(sc) {
  const ie = String(sc?.int_ext || "").toUpperCase();
  const heading = String(sc?.heading || "");
  const loc = String(sc?.location || (ie ? "" : heading)).toLowerCase();
  if (!loc || !(ie.includes("INT") || MOVING_RE.test(heading) || MOVING_RE.test(loc))) return null;
  const kind = libraryObjects(loc).find((k) => SEATS[k]) || null;
  return kind ? { kind, moving: MOVING_RE.test(heading) || MOVING_RE.test(loc) || /\b(drives?|driving|speeds?|races?|swerves?|cuts hard)\b/i.test(actionOf(sc)) } : null;
}

/** Who rides what: "Two RIDERS walk their horses in" = everyone in the scene; else the characters whose action rides.
 *  Returns {kind: "horse" | "bicycle" | "motorcycle" | null, riders: [names]}. */
export function ridersOfScene(sc, names = sceneCast(sc)) {
  const objs = sc?.stage_hint?.objects || [];
  const animals = [...(sc?.breakdown?.animals || []), ...(sc?.breakdown?.vehicles || [])].join(" ");
  const text = actionOf(sc);
  const kind = MOUNT_KINDS.find((k) => objs.includes(k) || new RegExp(`\\b${k}s?\\b`, "i").test(animals)) || null;
  if (!kind || !RIDE_RE.test(text)) return { kind: null, riders: [] };
  const all = ALL_RIDE_RE.test(text);
  const riders = names.filter((n) => all || RIDE_RE.test(mentions(sc, n)));
  return { kind: riders.length ? kind : null, riders };
}

/** Seats for the people in a vehicle: the one at the wheel drives, the rest fill the front passenger seat, then the back. */
export function seatAssignments(sc, names, kind) {
  const seats = SEATS[kind] || [];
  if (!seats.length) return {};
  const driver = names.find((n) => DRIVE_RE.test(mentions(sc, n, { next: false })))
    || names.find((n) => DRIVE_RE.test(mentions(sc, n))) || names[0];
  const order = [driver, ...names.filter((n) => n !== driver)];
  const free = [0, 1, 3, 2, ...seats.map((_, i) => i).slice(4)].filter((i) => i < seats.length);
  const out = {};
  order.forEach((n, i) => { if (i < free.length) out[n] = free[i]; });
  return out;
}

/**
 * Simple blocking for n people around `center` [x, z] seen from `cam` [x, z]: one in the middle; two face each other
 * across the line of action; three or more in a shallow arc facing the group's middle. `avoid` = positions to keep
 * 0.9 m away from (actors already on the stage). Returns [{position: [x, 0, z], rotation_deg}].
 */
export function blockingSpots(n, { center = [0, -4], cam = [0, -11.5], avoid = [] } = {}) {
  let dx = center[0] - cam[0], dz = center[1] - cam[1];
  const L = Math.hypot(dx, dz) || 1;
  dx /= L; dz /= L;
  const sx = -dz, sz = dx;   // to the camera's right
  const spots = [];
  const gap = n === 2 ? 1.0 : 1.3;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * gap * (n === 2 ? 1.6 : 1);
    const depth = n >= 3 ? Math.abs(i - (n - 1) / 2) * -0.45 : 0;   // the ends come a little toward the camera
    spots.push([center[0] + sx * off + dx * depth, center[1] + sz * off + dz * depth]);
  }
  // Keep clear of what is already there: step back from the camera until free.
  const free = (p, others) => others.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.9);
  const placed = [];
  for (const p of spots) {
    let q = p;
    for (let k = 0; k < 12 && !free(q, [...avoid.map((a) => [a[0], a[2] ?? a[1]]), ...placed]); k++) q = [q[0] + dx * 1.2, q[1] + dz * 1.2];
    placed.push(q);
  }
  const mid = placed.reduce((a, p) => [a[0] + p[0] / placed.length, a[1] + p[1] / placed.length], [0, 0]);
  const face = (p, t) => Math.round(Math.atan2(t[0] - p[0], t[1] - p[1]) * 180 / Math.PI);
  return placed.map((p, i) => {
    let target;
    if (n === 1) target = [cam[0], cam[1]];
    else if (n === 2) target = [placed[1 - i][0] - dx * 1.2, placed[1 - i][1] - dz * 1.2];   // each other, opened a little to the lens
    else target = [mid[0] - dx * 2.5, mid[1] - dz * 2.5];   // the group's middle, a little toward the camera
    return { position: [+p[0].toFixed(2), 0, +p[1].toFixed(2)], rotation_deg: face(p, target) };
  });
}

/** "Set up scene 3 — EXT. PACIFIC BEACH — SUNSET (Mara)". */
export function setupLabel(sc, names = sceneCast(sc)) {
  const where = [sc?.int_ext ? `${sc.int_ext}.` : "", sc?.location || ""].join(" ").trim() || sc?.heading || "";
  return `Set up scene ${sc?.number ?? ""} — ${where}${sc?.time ? ` — ${sc.time}` : ""}${names.length ? ` (${names.join(", ")})` : ""}`;
}

// ---------------------------------------------------------------- Milestone 11 sets
// Locations the general set words can't place (they say "water tank" for UNDERWATER, "interior" for INT. TRAIN):
// matched on the location first. Each comes with where the cast goes, the camera for a fresh stage and the vehicle
// the set plays with (the train on its track, the airliner on the runway).
const M11_SETS = [
  ["underwater", (l) => /\b(underwater|under ?water|under the (sea|surface|waves|ocean)|beneath the (surface|waves|sea)|ocean floor|sea ?floor|sea ?bed|coral reef|reef|scuba|dive site|shipwreck)\b/.test(l) && !/\b(tank|pool|bathtub|aquarium)\b/.test(l)],
  ["burning_building", (l) => /\b(burning|on fire|ablaze|in flames|inferno|blaze|blazing|house fire|building fire|fire scene)\b/.test(l)],
  ["train_station", (l) => /\b(train station|railway station|railroad station|rail station|station platform|train platform|railway platform|platform \d+|depot|subway station|metro station)\b/.test(l)
    || (/\bplatform\b/.test(l) && /\b(train|rail|railway|station)\b/.test(l))],
  ["runway", (l) => /\b(runway|tarmac|airfield|airstrip|airport)\b/.test(l)],
  ["airplane_cabin", (l, ie) => /\b(airplane|aeroplane|plane|airliner|jetliner|jet|aircraft|flight|cabin of (a|the) (plane|jet))\b/.test(l) && (ie.includes("INT") || /\bcabin\b/.test(l))],
  ["above_clouds", (l) => /\b(airplane|aeroplane|plane|airliner|jetliner|jet|aircraft)\b/.test(l) || /\b(above the clouds|in the sky|sky|in flight|airborne)\b/.test(l)],
  ["train_car", (l, ie) => /\b(train|railcar|rail car|railway carriage|carriage|compartment|dining car|sleeper car|subway car|passenger car|metro|subway)\b/.test(l) && ie.includes("INT")],
  ["train_station", (l) => /\b(train|railway|railroad|tracks)\b/.test(l)],
];

/** The Milestone 11 set a scene's location calls for ("INT. AIRPLANE CABIN" -> airplane_cabin), or null. */
export function newSetForScene(sc) {
  const ie = String(sc?.int_ext || "").toUpperCase();
  const l = String(sc?.location || (ie ? "" : sc?.heading) || "").toLowerCase();
  if (!l) return null;
  for (const [id, test] of M11_SETS) if (test(l, ie)) return id;
  return null;
}

/**
 * The hero seat rows the cast sits in on the cabin / carriage sets: [{kind, position, rotation_deg, seats: [index order]}]
 * (same slots as the set's seat bank, so the dressing row there is swapped for the seat-row object). People fill the
 * window seats first: a passenger at the window.
 */
export function seatRowsForSet(set, n) {
  if (set === "airplane_cabin") {
    const rows = [];
    for (let i = 0; i * 3 < Math.max(1, n); i++) {
      const z = +(CABIN.firstRow + (12 - i) * PLANE_ROW.pitch).toFixed(3);
      rows.push({ kind: "plane_seats", position: [CABIN.bank, 0, z], rotation_deg: 0, seats: [0, 1, 2] });
    }
    return rows;
  }
  if (set === "train_car") {
    const zb = CAR.firstBay + 4 * CAR.bay;
    const fwd = { kind: "train_seats", position: [CAR.bank, 0, +(zb - 0.66).toFixed(3)], rotation_deg: 0, seats: [0, 1] };
    const back = { kind: "train_seats", position: [CAR.bank, 0, +(zb + 0.66).toFixed(3)], rotation_deg: 180, seats: [1, 0] };
    return n > 1 ? [fwd, back] : [fwd];
  }
  return [];
}

/** Where things go on a Milestone 11 set: a fresh stage's camera, the blocking centre, people's height (swimming), and
 *  the set's vehicle on its mark ({kind: {position, rotation_deg, keys?}}). */
export function stageHintsForSet(set, { last = 96 } = {}) {
  switch (set) {
    case "underwater": return { center: [0, 0], camera: { position: [0, 2.0, -8.5], target: [0, 2.3, 0], focal_mm: 24 }, lift: 2.4 };
    case "burning_building": return { center: [0, 3], camera: { position: [0, 1.6, -6], target: [0, 2.4, 6], focal_mm: 28 } };
    case "airplane_cabin": {
      const z = CABIN.firstRow + 12 * PLANE_ROW.pitch;
      return { camera: { position: [-0.15, 1.22, +(z + 0.32).toFixed(2)], target: [1.55, 1.08, +(z - 0.12).toFixed(2)], focal_mm: 28 } };
    }
    case "train_car": {
      const zb = CAR.firstBay + 4 * CAR.bay;
      return { camera: { position: [0.05, 1.32, +(zb + 0.25).toFixed(2)], target: [1.25, 1.12, +(zb - 0.75).toFixed(2)], focal_mm: 28 } };
    }
    case "train_station": return { center: [5, 6], camera: { position: [6.5, 2.5, -12], target: [3, 1.9, 8], focal_mm: 28 },
      place: { train: { position: [0, 0, -95], rotation_deg: 0, keys: [{ frame: 0, position: [0, 0, -95] }, { frame: last, position: [0, 0, 14] }] } } };
    case "runway": return { center: [26, -6], camera: { position: [40, 3, -45], target: [0, 4, 8], focal_mm: 28 },
      place: { airliner: { position: [0, 0, -30], rotation_deg: 0, keys: [{ frame: 0, position: [0, 0, -30] }, { frame: last, position: [0, 0, 30] }] } } };
    case "above_clouds": return { camera: { position: [30, 4, -40], target: [0, 2, 4], focal_mm: 32 },
      place: { airliner: { position: [0, 0, 0], rotation_deg: 0, keys: [{ frame: 0, position: [0, 0, -12] }, { frame: last, position: [0, 0, 28] }] } } };
    default: return null;
  }
}
const SET_VEHICLE = { train_station: "train", runway: "airliner", above_clouds: "airliner" };
const NOT_IN = { airplane_cabin: ["airliner", "plane_seats"], train_car: ["train", "train_seats"], underwater: ["boat", "sailboat", "jetski"] };

/**
 * What setting up this scene would do on a stage holding `actors`. fresh = the stage is a scene's untouched default
 * (its stand-in Man / Woman may go). castItems = Cast & Locations items (descriptions give looks).
 * Returns {label, names, env: {set, weather}, time_preset, people: [{name, kind, appearance, reuseId, mount?}],
 * objects: [kind], removeIds: [id], changes: n, hosts: [{kind, reuseId, moving}], vehicle: {kind, moving, host} | null}.
 * people[i].mount = {host: index into hosts, seat: SEATS index | null}: that person sits in / rides that host.
 */
export function planSceneSetup(sc, { actors = [], castItems = [], fresh = false, env = {}, lightingPreset = null, last = 96 } = {}) {
  const names = sceneCast(sc);
  const su = stageSetupForScene(sc);
  const time_preset = timePresetFor(sc);
  const people = [];
  const used = new Set();
  const humans = actors.filter((a) => PEOPLE.has(a.kind));
  for (const name of names) {
    const item = castItems.find((x) => x.kind === "character" && castSlug(x.name) === castSlug(name));
    const description = [item?.description || "", introOf(sc, name)].filter(Boolean).join(", ");
    const kind = guessPersonKind(name, { description, sc });
    const appearance = appearanceFromText(description);
    if (!appearance.top && /\b(deputy|officer|cop|trooper|sergeant|captain|agent|nurse|soldier|private)\b/i.test(name)) appearance.top = "uniform";
    const hit = humans.find((a) => !used.has(a.id) && castSlug(a.name) === castSlug(name))
      || humans.find((a) => !used.has(a.id) && castSlug(a.name).split(" ")[0] === castSlug(name).split(" ")[0] && castSlug(name).split(" ")[0].length > 2);
    if (hit) used.add(hit.id);
    people.push({ name, kind, appearance, reuseId: hit?.id || null });
  }
  // A fresh stage's stand-ins (the default Man and Woman) leave; nothing the user placed is ever removed.
  const removeIds = fresh ? actors.filter((a) => !used.has(a.id) && PEOPLE.has(a.kind)).map((a) => a.id) : [];
  const kept = actors.filter((a) => !removeIds.includes(a.id));
  // Who sits in the car / rides a horse, and which host each one gets (a stage object to reuse, else a new one).
  // A cabin / carriage set seats the cast in its own rows instead.
  const m11 = newSetForScene(sc);
  const rows = seatRowsForSet(m11, people.length);
  const vehicle = rows.length ? null : vehicleOfScene(sc);
  const ride = vehicle || rows.length ? { kind: null, riders: [] } : ridersOfScene(sc, names);
  const hosts = [];
  const free = (kind) => kept.filter((h) => h.kind === kind && !hosts.some((x) => x.reuseId === h.id)
    && !kept.some((r) => r.mount_id === h.id && !people.some((p) => p.reuseId === r.id)));
  if (vehicle) {
    const seats = seatAssignments(sc, names, vehicle.kind);
    const h = kept.find((a) => a.kind === vehicle.kind) || null;
    hosts.push({ kind: vehicle.kind, reuseId: h?.id || null, moving: vehicle.moving });
    for (const p of people) if (seats[p.name] != null) p.mount = { host: 0, seat: seats[p.name] };
  } else if (rows.length) {
    let k = 0;
    rows.forEach((r, i) => {
      const h = kept.find((a) => a.kind === r.kind && Math.hypot((a.keys?.[0]?.position || a.position || [0, 0, 0])[0] - r.position[0],
        (a.keys?.[0]?.position || a.position || [0, 0, 0])[2] - r.position[2]) < 0.35) || null;
      hosts.push({ kind: r.kind, reuseId: h?.id || null, moving: false, at: { position: r.position, rotation_deg: r.rotation_deg } });
      for (const seat of r.seats) if (k < people.length) people[k++].mount = { host: i, seat };
    });
    // two facing train seats: the window seats first, then the aisle ones (person 1 and 2 face each other)
    if (m11 === "train_car" && rows.length === 2) {
      const order = [[0, 0], [1, 1], [0, 1], [1, 0]];
      people.forEach((p, j) => { if (j < 4) p.mount = { host: order[j][0], seat: order[j][1] }; else delete p.mount; });
    }
  } else if (ride.kind) {
    for (const p of people) {
      if (!ride.riders.includes(p.name)) continue;
      const mine = kept.find((a) => a.id === p.reuseId);
      const already = mine?.mount_id && kept.find((h) => h.id === mine.mount_id && h.kind === ride.kind);
      const h = already || free(ride.kind)[0] || null;
      hosts.push({ kind: ride.kind, reuseId: h?.id || null, moving: false });
      p.mount = { host: hosts.length - 1, seat: null };
    }
  }
  const hostKinds = new Set(hosts.map((h) => h.kind));
  const kinds = new Set(kept.map((a) => a.kind));
  const banned = new Set(NOT_IN[m11] || []);
  let objects = [...new Set((sc?.stage_hint?.objects || []).filter((k) => k && !kinds.has(k) && !hostKinds.has(k) && !banned.has(k)))].slice(0, 4);
  if (SET_VEHICLE[m11] && !kinds.has(SET_VEHICLE[m11]) && !objects.includes(SET_VEHICLE[m11])) objects = [SET_VEHICLE[m11], ...objects].slice(0, 4);
  const set = m11 || su.set || null, weather = su.weather || "none";
  let changes = people.filter((p) => !p.reuseId).length + objects.length + removeIds.length + hosts.filter((h) => !h.reuseId).length;
  for (const p of people) {
    if (!p.mount) continue;
    const a = kept.find((x) => x.id === p.reuseId), h = hosts[p.mount.host];
    if (!a || !h.reuseId || a.mount_id !== h.reuseId || (p.mount.seat != null && (a.seat ?? 0) !== p.mount.seat)) changes++;
  }
  if (set && env.set !== set) changes++;
  if (set && (env.weather || "none") !== weather) changes++;
  if (time_preset && lightingPreset !== time_preset) changes++;
  return { label: setupLabel(sc, names), names, env: { set, weather }, time_preset, people, objects, removeIds, changes,
    hosts, vehicle: vehicle ? { ...vehicle, host: 0 } : null, stage: stageHintsForSet(m11, { last }) };
}

/** One chip of the scene strip: number, "EXT. Beach", time kind, the characters' initials. */
export function sceneChip(sc) {
  const t = String(sc?.time || "").toUpperCase();
  const time = /NIGHT/.test(t) ? "night" : /DAWN|SUNRISE|MORNING/.test(t) ? "dawn" : /DUSK|SUNSET|EVENING|MAGIC|TWILIGHT/.test(t) ? "dusk"
    : /DAY|NOON|AFTERNOON/.test(t) ? "day" : sc?.stage_hint?.time_of_day || (t ? "cont" : null);
  const names = sceneCast(sc);
  const initials = names.map((n) => n.split(/\s+/).filter((w) => !/^(dr|mr|mrs|ms|deputy|officer|detective|sheriff)$/i.test(w))
    .map((w) => w[0]).join("").slice(0, 2).toUpperCase() || n[0]);
  const loc = titleCase(sc?.location || sc?.heading || "");
  return { id: sc?.id, number: String(sc?.number ?? ""), where: `${sc?.int_ext ? `${sc.int_ext}. ` : ""}${loc}`.trim(), time, timeText: sc?.time || "",
    initials, names };
}

/** The scene before / after `cur` in script order (dir -1 / +1), or null at the ends. */
export function stepScene(scenes, cur, dir) {
  const list = scenes || [];
  if (!list.length) return null;
  const i = list.findIndex((x) => x.id === cur);
  if (i < 0) return list[dir > 0 ? 0 : list.length - 1].id;
  const j = i + dir;
  return j >= 0 && j < list.length ? list[j].id : null;
}
