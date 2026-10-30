// "Cast in this shot": which Cast & Locations references a shot uses. Pure logic (testable, no DOM): the pool of
// pictures (② Cast & Locations items plus stage actors that only have a ④ Frame reference), each shot's default
// selection (who is on its stage, its scene's location and characters), and the priority order that picks the few
// references the image model can take (characters > location > wardrobe > props > style).
//
// Items: {key, kind: 'character'|'location'|'wardrobe'|'prop'|'style', name, ref?, url?, scenes?, hint?, src?}

export const REF_LIMIT = 4;            // FLUX 3 Klein's reference slots (backend _parse_ref_files(limit=4))
export const KIND_ORDER = ["character", "location", "wardrobe", "prop", "style"];
const KIND_LABEL = { character: "character sheet", location: "location", wardrobe: "wardrobe", prop: "prop", style: "style / look" };
const PEOPLE = new Set(["man", "woman", "child"]);
export const CLOTHES = /\b(wardrobe|costume|outfit|uniform|dress|gown|suit|tux(edo)?|jacket|coat|trench|blazer|vest|shirt|t-shirt|blouse|sweater|hoodie|jeans|trousers|pants|skirt|shorts|hat|cap|helmet|bonnet|beanie|stetson|boots?|shoes?|sneakers|heels|gloves?|scarf|tie|bowtie|glasses|sunglasses|goggles|mask|cape|cloak|robe|apron|belt|bandana|poncho|overalls|jersey|armou?r|holster|necklace|earrings?|bracelet|ring|watch|wig)\b/i;

/** Lower-case words only: "Mara's Car" and "mara s car" compare equal. */
export const castSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Does a cast item read as clothing (explicit wardrobe kind, or a prop whose name / hint is a garment)? */
export function isWardrobe(it) {
  if (!it) return false;
  if (it.kind === "wardrobe") return true;
  return it.kind === "prop" && (CLOTHES.test(it.name || "") || /wardrobe|costume/i.test(it.hint || ""));
}

/** The kind used for grouping and priority: props that are garments count as wardrobe. */
export const shotKind = (it) => (isWardrobe(it) ? "wardrobe" : it?.kind || "prop");

/** Does this cast item name an actor on the stage ("Mara" ↔ actor "Mara", "Police car" ↔ kind police_car)? */
export function matchesActor(it, actor) {
  const k = shotKind(it);
  if (!actor || (k !== "character" && k !== "prop")) return false;
  const n = castSlug(actor.name || actor.kind), x = castSlug(it.name);
  if (!n || !x) return false;
  const person = PEOPLE.has(actor.kind);
  if (person !== (k === "character")) return false;
  if (x === n || n.startsWith(x + " ") || x.startsWith(n + " ")) return true;
  return !person && x.includes(String(actor.kind || "").replace(/_/g, " "));
}

/**
 * Everything a shot can use: the cast items, plus stage actors that have a ④ Frame reference (ss_refs actor:<id>)
 * but no cast item, plus the Style reference. `refs` = ss_refs {key: file}; `urlOf(file)` -> a /view URL.
 */
export function castPool(items, actors = [], refs = {}, urlOf = () => "") {
  const pool = (items || []).map((it) => ({ ...it }));
  for (const a of actors || []) {
    const file = refs?.[`actor:${a.id}`];
    if (!file) continue;
    if (pool.some((it) => it.ref === file || matchesActor(it, a) && it.ref)) continue;
    pool.push({ key: `actor:${a.id}`, kind: PEOPLE.has(a.kind) ? "character" : "prop", name: a.name || a.kind, ref: file, url: urlOf(file), src: "stage" });
  }
  if (refs?.location && !pool.some((it) => it.ref === refs.location))
    pool.push({ key: "ref:location", kind: "location", name: "Location reference", ref: refs.location, url: urlOf(refs.location), src: "stage" });
  if (refs?.style) pool.push({ key: "ref:style", kind: "style", name: "Style / look", ref: refs.style, url: urlOf(refs.style), src: "stage" });
  return pool;
}

/**
 * The default selection for a shot: everyone / everything on its stage, its scene's characters and location
 * (`sceneLabel` like "Sc 3", when a script scene is active), the only location when there is just one, and stage refs.
 */
export function defaultShotCast(pool, { actors = [], sceneLabel = null } = {}) {
  const keys = [];
  const add = (k) => { if (!keys.includes(k)) keys.push(k); };
  const locs = pool.filter((it) => it.kind === "location" && it.src !== "stage");
  for (const it of pool) {
    const k = shotKind(it);
    if (it.src === "stage") { add(it.key); continue; }
    if ((actors || []).some((a) => matchesActor(it, a))) { add(it.key); continue; }
    if (sceneLabel && it.scenes?.includes(sceneLabel) && (k === "character" || k === "location")) { add(it.key); continue; }
    if (k === "location" && !sceneLabel && locs.length === 1) add(it.key);
  }
  if (sceneLabel && !keys.some((k) => pool.find((it) => it.key === k)?.kind === "location") && locs.length === 1) add(locs[0].key);
  return keys;
}

/** The shot's selection: its saved keys (when it has any), else the defaults. Unknown keys are dropped. */
export function shotSelection(pool, saved, ctx) {
  if (Array.isArray(saved)) return saved.filter((k) => pool.some((it) => it.key === k));
  return defaultShotCast(pool, ctx);
}

/**
 * The references to send: selected items that have a picture, in priority order (characters > location > wardrobe >
 * props > style), at most `limit`. Returns {use, dropped, missing} (missing = selected without a picture).
 */
export function pickRefs(pool, keys, limit = REF_LIMIT) {
  const sel = (keys || []).map((k) => pool.find((it) => it.key === k)).filter(Boolean);
  const missing = sel.filter((it) => !it.ref);
  const has = sel.filter((it) => it.ref);
  const seen = new Set();
  const ranked = has.map((it, i) => ({ it, i })).sort((a, b) =>
    KIND_ORDER.indexOf(shotKind(a.it)) - KIND_ORDER.indexOf(shotKind(b.it)) || a.i - b.i).map((x) => x.it)
    .filter((it) => (seen.has(it.ref) ? false : (seen.add(it.ref), true)));
  return { use: ranked.slice(0, limit), dropped: ranked.slice(limit), missing };
}

/** "Mara — character sheet", "Diner — location". */
export const refLabel = (it) => `${String(it.name || "").replace(/[|\n]/g, " ").trim()} — ${KIND_LABEL[shotKind(it)] || "reference"}`;

/** ref_files lines for the image picker (9081): "file | label". */
export const refLines = (use) => use.map((it) => `${it.ref} | ${refLabel(it)}`).join("\n");

/** Turn an annotated ref ("dir/x.png [output]" or "dir/x.png") into /view params. */
export function refViewParams(ref) {
  const m = /^(.*?)\s*\[(input|output|temp)\]\s*$/.exec(String(ref || ""));
  const path = m ? m[1] : String(ref || "");
  const i = path.lastIndexOf("/");
  return { filename: path.slice(i + 1), subfolder: i > 0 ? path.slice(0, i) : "", type: m ? m[2] : "input" };
}
