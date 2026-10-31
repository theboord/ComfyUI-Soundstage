// Set up a script scene on the stage: its set and weather, the time of day from the slugline, the scene's characters
// as named actors (looks from Cast & Locations where known) in simple blocking, and the vehicles / animals its heading
// calls for. Pure planning (no DOM, no three.js; tests/js/scenesetup.test.mjs); the host applies the plan.
//
//   const plan = planSceneSetup(scene, { actors, castItems, fresh, frame: { center: [x, z], cam: [x, z] } });
//   plan.label  -> "Set up scene 3 — EXT. PACIFIC BEACH — SUNSET (Mara)"
import { stageSetupForScene } from "./parse.mjs";
import { libraryObjects } from "./breakdown.mjs";
import { SEATS } from "../stage/library.mjs";

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

/**
 * What setting up this scene would do on a stage holding `actors`. fresh = the stage is a scene's untouched default
 * (its stand-in Man / Woman may go). castItems = Cast & Locations items (descriptions give looks).
 * Returns {label, names, env: {set, weather}, time_preset, people: [{name, kind, appearance, reuseId, mount?}],
 * objects: [kind], removeIds: [id], changes: n, hosts: [{kind, reuseId, moving}], vehicle: {kind, moving, host} | null}.
 * people[i].mount = {host: index into hosts, seat: SEATS index | null}: that person sits in / rides that host.
 */
export function planSceneSetup(sc, { actors = [], castItems = [], fresh = false, env = {}, lightingPreset = null } = {}) {
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
  const vehicle = vehicleOfScene(sc);
  const ride = vehicle ? { kind: null, riders: [] } : ridersOfScene(sc, names);
  const hosts = [];
  const free = (kind) => kept.filter((h) => h.kind === kind && !hosts.some((x) => x.reuseId === h.id)
    && !kept.some((r) => r.mount_id === h.id && !people.some((p) => p.reuseId === r.id)));
  if (vehicle) {
    const seats = seatAssignments(sc, names, vehicle.kind);
    const h = kept.find((a) => a.kind === vehicle.kind) || null;
    hosts.push({ kind: vehicle.kind, reuseId: h?.id || null, moving: vehicle.moving });
    for (const p of people) if (seats[p.name] != null) p.mount = { host: 0, seat: seats[p.name] };
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
  const objects = [...new Set((sc?.stage_hint?.objects || []).filter((k) => k && !kinds.has(k) && !hostKinds.has(k)))].slice(0, 4);
  const set = su.set || null, weather = su.weather || "none";
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
    hosts, vehicle: vehicle ? { ...vehicle, host: 0 } : null };
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
