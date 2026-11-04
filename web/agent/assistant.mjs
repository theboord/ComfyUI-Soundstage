// ✦ Ask as a conversation (QA 2026-11-04, Mike: "double-check the characters to make sure they don't match, check the
// props are actually props, read the script and analyse it" was read as a shot / beat order). Ask keeps a chat history,
// sends free-form requests to the Director's language model (the local Qwen3.5 4B, or the Ollama / API model picked in
// ⚙) with what the project holds and a list of tools, runs the tools it asks for, and says what it did. Without a model
// (the try-it demo, no GPU, the GPU busy) it says so and runs the same checks itself: they are deterministic, the model
// only decides which to run and words the answer.
//
// Tools (each returns {tool, title, said, did: [what was actually looked at], findings: [...], fixes: [...]}):
//   analyze_script   summary, scene list, story beats (from the outline lines), issues
//   check_cast       duplicate / near-duplicate characters (two spellings, first name vs full name, typos, age clash)
//   check_props      the breakdown's props: real props vs set dressing, wardrobe, vehicles, animals, cast, not-a-prop words
//   check_locations  duplicate or overlapping sets
//   apply_fixes      merge / rename / reclassify, only with the user's OK (the card's button), one Undo
//   plan_stage       an order for the 3D set: handed to the Director's planner (plan, Apply, Undo this)
//   show_me          a how-to recipe's steps with Show me (web/agent/ask.mjs HOWTO)
//   add_note         a note in the Director's Book
//   gather_character / profile_character / update_character / regenerate_character: build a character from the
//                    script into its ② Cast card (web/agent/charbuild.mjs); writing asks first, regenerating always asks
// Pure: no DOM. The chat UI is web/agent/ask.mjs + directorpanel.mjs; tests/js/assistant.test.mjs.
import { normalizeCharacter, hydrateScript, compactScript } from "../script/parse.mjs";
export { applyBreakdownFixes } from "../script/breakdown.mjs";
import { searchDocs, troubleshoot, planRecipe, SOUNDSTAGE_MAP } from "./knowledge.mjs";
import { gatherCharacter, gatherText, draftProfile, parseProfile, PROFILE_SYSTEM, cardFields, crossCheck, resolveCharacter } from "./charbuild.mjs";

export const CHAR_TOOLS = ["gather_character", "profile_character", "update_character", "regenerate_character"];
export const KNOW_TOOLS = ["search_docs", "troubleshoot", "plan_recipe"];
export const TOOL_NAMES = [...KNOW_TOOLS, "analyze_script", "check_cast", "check_props", "check_locations", "apply_fixes", "plan_stage", "show_me", "add_note", ...CHAR_TOOLS];

// ---------------------------------------------------------------- small helpers
const uniq = (xs) => [...new Set(xs)];
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const sceneLabel = (sc) => `scene ${sc.number || sc.index + 1}`;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Levenshtein distance, capped (returns cap + 1 once it's over). */
export function editDistance(a, b, cap = 3) {
  a = String(a); b = String(b);
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Which scenes a tool looks at: all, or the ones named ("scene 3", ids, numbers). */
export function pickScenes(script, which = null) {
  const all = script?.scenes || [];
  if (!which || (Array.isArray(which) && !which.length)) return all;
  const want = (Array.isArray(which) ? which : [which]).map((x) => String(x).replace(/^scene\s*/i, "").trim().toUpperCase());
  const got = all.filter((sc) => want.includes(String(sc.id).toUpperCase()) || want.includes(String(sc.number).toUpperCase()));
  return got.length ? got : all;
}

// ---------------------------------------------------------------- check_cast
const TITLES = new Set(["DR", "DOC", "MR", "MRS", "MS", "MISS", "SIR", "LADY", "LORD", "SHERIFF", "DEPUTY", "OFFICER", "DETECTIVE", "DET",
  "AGENT", "CAPTAIN", "CAPT", "SGT", "SERGEANT", "LT", "LIEUTENANT", "COLONEL", "GENERAL", "PROFESSOR", "PROF", "FATHER", "SISTER",
  "BROTHER", "UNCLE", "AUNT", "AUNTIE", "GRANDMA", "GRANDPA", "YOUNG", "OLD", "LITTLE", "BIG", "OLDER", "YOUNGER"]);
/** "DR. ADA REED (V.O.)" -> ["ADA", "REED"]: the words that name the person. */
export function nameWords(name) {
  return normalizeCharacter(name).replace(/[^A-Z0-9 #'-]/g, " ").split(/\s+/).filter(Boolean).filter((w) => !TITLES.has(w.replace(/['.]/g, "")));
}
const numbered = (name) => /(?:#\s*\d+|\b\d+)$/.test(String(name).trim());   // COP #1, GUARD 2: different people by design

/** The ages a script gives each character where it introduces them: NAME (30s) / (early 20s) / (45). */
function introAges(script) {
  const out = new Map();
  const RE = /(?<![A-Za-z])([A-Z][A-Z'’.\-]*[A-Z.](?:\s+[A-Z][A-Z'’.\-]*[A-Z.]){0,3})\s*\(((?:early |mid-?|late )?\d{1,2}s?)\)/g;
  for (const sc of script?.scenes || []) for (const e of sc.elements || []) {
    if (e.type !== "action") continue;
    for (const m of String(e.text || "").matchAll(RE)) {
      const key = nameWords(m[1]).join(" ");
      if (!key) continue;
      const list = out.get(key) || [];
      list.push({ age: m[2], scene: sc });
      out.set(key, list);
    }
  }
  return out;
}

/**
 * Duplicate or near-duplicate characters. -> {findings: [{kind, names, why, into}], fixes: [{type: "merge_cast", from, into}]}
 * kind: "same" (two spellings of one name), "part" (a first or last name and the full name), "typo" (one or two letters
 * apart), "age" (one person introduced at two ages). Numbered extras (COP #1, COP #2) are never merged.
 */
export function checkCast(script, { scenes = null } = {}) {
  const inScenes = new Set(pickScenes(script, scenes).map((s) => s.id));
  const chars = (script?.characters || []).filter((c) => !scenes || (c.scenes || []).some((id) => inScenes.has(id)));
  const findings = [], fixes = [];
  // Keep the one the script uses most (scenes, then lines); on a tie the shorter spelling (a typo usually adds a letter).
  const weight = (n) => { const c = chars.find((x) => x.name === n); return (c?.scenes?.length || 0) * 1000 + (c?.lines || 0); };
  const keep = (a, b) => (weight(a) !== weight(b) ? (weight(a) > weight(b) ? a : b) : (a.length <= b.length ? a : b));
  const seen = new Set();
  for (let i = 0; i < chars.length; i++) for (let j = i + 1; j < chars.length; j++) {
    const a = chars[i].name, b = chars[j].name;
    if (numbered(a) || numbered(b)) continue;
    const wa = nameWords(a), wb = nameWords(b);
    if (!wa.length || !wb.length) continue;
    const ka = wa.join(" "), kb = wb.join(" ");
    let kind = null, why = "";
    if (ka === kb) { kind = "same"; why = `${a} and ${b} are the same name written two ways`; }
    else if ((wa.length === 1 && wb.includes(wa[0]) && wa[0].length >= 3) || (wb.length === 1 && wa.includes(wb[0]) && wb[0].length >= 3)) {
      kind = "part"; why = `${wa.length === 1 ? a : b} looks like the short form of ${wa.length === 1 ? b : a}`;
    } else {
      const d = editDistance(ka, kb, 2), n = Math.min(ka.length, kb.length);
      if ((d === 1 && n >= 4) || (d === 2 && n >= 7)) { kind = "typo"; why = `${a} and ${b} are ${plural(d, "letter")} apart: a typo?`; }
    }
    if (!kind) continue;
    const into = kind === "part" ? (wa.length >= wb.length ? a : b) : kind === "same" && weight(a) === weight(b) ? (a.length >= b.length ? a : b) : keep(a, b);
    const from = into === a ? b : a;
    findings.push({ kind, names: [a, b], why, into });
    if (!seen.has(from)) { seen.add(from); fixes.push({ type: "merge_cast", from, into, why }); }
  }
  for (const [key, list] of introAges(script)) {
    const ages = uniq(list.map((x) => x.age.toLowerCase()));
    if (ages.length < 2) continue;
    findings.push({ kind: "age", names: [key], why: `${key} is introduced as ${list.map((x) => `${x.age} in ${sceneLabel(x.scene)}`).join(" and ")}: one person, or two?` });
  }
  const did = [`compared ${plural(chars.length, "character name")} pair by pair (spelling, first vs full name, typos)`,
    "read the ages where characters are introduced"];
  const said = findings.length ? `${plural(findings.length, "possible duplicate")} in the cast.` : `No duplicates among ${plural(chars.length, "character")}.`;
  return { tool: "check_cast", title: "Cast check", said, did, findings, fixes,
    limits: "Appearance clashes (hair, clothes) need the language model; the built-in check reads names and ages only." };
}

// ---------------------------------------------------------------- check_props
// Word lists for the built-in check (lower case, matched on the last word of the item and on the whole item).
const KINDS = {
  set_dressing: ["table", "tables", "chair", "chairs", "booth", "booths", "couch", "sofa", "bed", "lamp", "lamps", "curtain", "curtains", "rug",
    "carpet", "painting", "poster", "posters", "shelf", "shelves", "bookshelf", "counter", "bar", "stool", "stools", "desk", "cabinet",
    "fridge", "refrigerator", "stove", "sink", "jukebox", "mirror", "window", "windows", "door", "doors", "wall", "walls", "sign", "neon sign",
    "fireplace", "piano", "plant", "plants", "bench", "fence", "statue", "clock", "wallpaper", "blinds", "television", "tv", "dresser",
    "wardrobe cabinet", "bathtub", "toilet", "pillow", "pillows", "blanket", "candles", "chandelier", "billboard", "dumpster", "streetlight"],
  wardrobe: ["hat", "fedora", "cap", "beanie", "helmet", "coat", "jacket", "overcoat", "trench coat", "blazer", "suit", "tie", "dress", "gown",
    "skirt", "shirt", "t-shirt", "blouse", "sweater", "hoodie", "jeans", "pants", "trousers", "shorts", "shoes", "boots", "heels", "sneakers",
    "gloves", "scarf", "uniform", "costume", "apron", "veil", "mask", "sunglasses", "belt", "socks", "vest", "robe", "pajamas", "bandana"],
  vehicles: ["car", "cars", "truck", "pickup", "pickup truck", "van", "bus", "taxi", "cab", "motorcycle", "motorbike", "bike", "bicycle",
    "scooter", "boat", "ship", "yacht", "jet ski", "helicopter", "plane", "airplane", "jet", "train", "tractor", "ambulance", "police car",
    "cruiser", "sedan", "suv", "limo", "limousine", "convertible", "jeep", "wagon", "horse cart"],
  animals: ["dog", "dogs", "cat", "cats", "horse", "horses", "bird", "birds", "crow", "crows", "cow", "cows", "chicken", "chickens", "rat",
    "rats", "snake", "fish", "pigeon", "pigeons", "goat", "sheep", "mule", "puppy", "kitten"],
  not_a_prop: ["beat", "pause", "silence", "later", "continuous", "moments later", "cut", "cut to", "fade", "fade in", "fade out", "pov", "angle",
    "close", "close on", "insert", "wide", "smash", "boom", "bang", "crash", "thud", "whoosh", "click", "slam", "screech", "the", "a", "an",
    "he", "she", "it", "we", "they", "then", "suddenly", "okay", "ok", "yes", "no", "end", "title", "super", "text", "sfx", "vfx", "music",
    "montage", "flashback", "intercut", "o.s.", "v.o.", "cont'd", "sound", "noise", "silhouette", "darkness", "light", "sunlight", "moonlight"],
};
const KIND_LABEL = { prop: "a prop", set_dressing: "set dressing", wardrobe: "wardrobe", vehicles: "a vehicle", animals: "an animal",
  cast: "a character", not_a_prop: "not a prop (a direction, a sound or a filler word)" };
const KIND_CAT = { set_dressing: "set_dressing", wardrobe: "wardrobe", vehicles: "vehicles", animals: "animals", cast: "cast", not_a_prop: null };

/** What a breakdown "prop" really is: prop | set_dressing | wardrobe | vehicles | animals | cast | not_a_prop. */
export function classifyProp(item, castNames = []) {
  const s = String(item || "").trim().toLowerCase().replace(/^["'“”]+|["'“”.,!:;]+$/g, "");
  if (!s) return "not_a_prop";
  if (/^\d+$/.test(s) || s.split(/\s+/).length > 5) return "not_a_prop";
  const up = s.toUpperCase();
  if (castNames.some((n) => normalizeCharacter(n) === up || nameWords(n).join(" ") === up)) return "cast";
  const last = s.split(/\s+/).pop();
  for (const k of ["not_a_prop", "vehicles", "animals", "wardrobe", "set_dressing"]) {
    if (KINDS[k].includes(s)) return k;
  }
  for (const k of ["vehicles", "animals", "wardrobe", "set_dressing"]) if (KINDS[k].includes(last)) return k;
  return "prop";
}

/** The breakdown's props, scene by scene, each classified; a fix moves (or drops) what isn't a prop. */
export function checkProps(script, { scenes = null } = {}) {
  const list = pickScenes(script, scenes);
  const cast = (script?.characters || []).map((c) => c.name);
  const findings = [], fixes = [];
  let n = 0;
  const byItem = new Map();
  for (const sc of list) for (const p of sc.breakdown?.props || []) {
    n++;
    const kind = classifyProp(p, cast);
    if (kind === "prop") continue;
    const k = `${p}|${kind}`;
    const f = byItem.get(k) || { item: p, kind, scenes: [] };
    f.scenes.push(sc.id);
    byItem.set(k, f);
  }
  for (const f of byItem.values()) {
    const where = f.scenes.map((id) => sceneLabel(list.find((s) => s.id === id))).join(", ");
    findings.push({ kind: f.kind, item: f.item, scenes: f.scenes, why: `"${f.item}" (${where}) looks like ${KIND_LABEL[f.kind]}` });
    fixes.push({ type: "reclassify_prop", item: f.item, to: KIND_CAT[f.kind], scenes: f.scenes,
      why: KIND_CAT[f.kind] ? `move "${f.item}" to ${KIND_LABEL[f.kind]}` : `drop "${f.item}" from props` });
  }
  const did = [`read ${plural(n, "prop entry", "prop entries")} in ${plural(list.length, "scene")} of the breakdown`,
    "sorted each against the built-in word lists (set dressing, wardrobe, vehicles, animals, cast names, filler words)"];
  const said = findings.length ? `${plural(findings.length, "prop")} that probably aren't props.` : `All ${plural(n, "prop")} look like real props.`;
  return { tool: "check_props", title: "Props check", said, did, findings, fixes,
    limits: "The built-in check knows common words only: an unusual set piece can still pass as a prop." };
}

// ---------------------------------------------------------------- check_locations
const locKey = (l) => String(l || "").toUpperCase().replace(/^THE\s+/, "").replace(/['’]S\b/g, "S").replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Duplicate (two spellings, typos) or overlapping (DINER and DINER - KITCHEN) locations. */
export function checkLocations(script, { scenes = null } = {}) {
  const list = pickScenes(script, scenes);
  const locs = new Map();
  for (const sc of list) {
    const l = String(sc.location || "").trim();
    if (!l) continue;
    const e = locs.get(l) || { name: l, scenes: [] };
    e.scenes.push(sc.id);
    locs.set(l, e);
  }
  const all = [...locs.values()];
  const findings = [], fixes = [], overlapSeen = new Set();
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j], ka = locKey(a.name), kb = locKey(b.name);
    const into = a.scenes.length !== b.scenes.length ? (a.scenes.length > b.scenes.length ? a.name : b.name) : (a.name.length <= b.name.length ? a.name : b.name);
    const from = into === a.name ? b.name : a.name;
    if (ka === kb) {
      // the same words: keep the fuller spelling (JOE'S over JOES) unless one is used more
      const [i2, f2] = a.scenes.length === b.scenes.length ? (a.name.length >= b.name.length ? [a.name, b.name] : [b.name, a.name]) : [into, from];
      findings.push({ kind: "same", names: [a.name, b.name], why: `"${a.name}" and "${b.name}" are one place written two ways` });
      fixes.push({ type: "rename_location", from: f2, into: i2, why: `call "${f2}" "${i2}"` });
    } else if (editDistance(ka, kb, 2) <= (Math.min(ka.length, kb.length) >= 7 ? 2 : 1) && Math.min(ka.length, kb.length) >= 4) {
      findings.push({ kind: "typo", names: [a.name, b.name], why: `"${a.name}" and "${b.name}" differ by a letter or two: a typo?` });
      fixes.push({ type: "rename_location", from, into, why: `call "${from}" "${into}"` });
    } else {
      if (ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `)) {   // DINER and DINER - KITCHEN (the dash is gone in the key)
        const k = [ka, kb].sort().join("|");
        if (!overlapSeen.has(k)) { overlapSeen.add(k); findings.push({ kind: "overlap", names: [a.name, b.name], why: `"${a.name}" and "${b.name}" look like parts of one set: build them on one stage?` }); }
      }
    }
  }
  const did = [`compared ${plural(all.length, "location")} from ${plural(list.length, "scene heading")}`];
  const said = findings.length ? `${plural(findings.length, "location")} to look at.` : `No duplicate locations among ${plural(all.length, "location")}.`;
  return { tool: "check_locations", title: "Locations check", said, did, findings, fixes };
}

// ---------------------------------------------------------------- analyze_script
/** Summary, scene list, story beats (the outline's first line per scene, in quarters) and issues. */
export function analyzeScript(script, { scenes = null } = {}) {
  const list = pickScenes(script, scenes);
  const chars = script?.characters || [];
  const issues = [];
  for (const sc of list) {
    if (!(sc.characters || []).length && !(sc.breakdown?.cast || []).length) issues.push(`${sceneLabel(sc)} (${sc.heading}) has no characters`);
    if (!sc.time || /^(CONTINUOUS|LATER|SAME|MOMENTS LATER)$/i.test(sc.time)) { /* fine: carries the time */ }
    else if (!sc.stage_hint?.time_of_day) issues.push(`${sceneLabel(sc)}: "${sc.time}" isn't a time of day the stage knows`);
    if (!sc.location) issues.push(`${sceneLabel(sc)} (${sc.heading}) has no location in its heading`);
  }
  for (const w of script?.warnings || []) issues.push(`import: ${w}`);
  const cast = checkCast(script, { scenes }), locs = checkLocations(script, { scenes }), props = checkProps(script, { scenes });
  if (cast.findings.length) issues.push(`cast: ${cast.said}`);
  if (locs.findings.some((f) => f.kind !== "overlap")) issues.push(`locations: ${locs.said}`);
  if (props.findings.length) issues.push(`props: ${props.said}`);
  const beatLine = (sc) => {
    const a = (sc.elements || []).find((e) => e.type === "action" && String(e.text || "").trim());
    const t = String(sc.outline || sc.synopsis || a?.text || sc.heading).split(/(?<=[.!?])\s/)[0];
    return `${sceneLabel(sc)}: ${t.length > 140 ? `${t.slice(0, 137)}…` : t}`;
  };
  const q = (k) => list[Math.min(list.length - 1, Math.floor((list.length - 1) * k))];
  const beats = list.length ? uniq([q(0), q(0.25), q(0.5), q(0.75), q(1)].filter(Boolean)).map((sc) => beatLine(sc)) : [];
  const top = chars.slice(0, 5).map((c) => `${c.name} (${plural(c.lines, "line")})`);
  const summary = list.length
    ? `"${script.title || "Untitled"}": ${plural(list.length, "scene")}${script.page_count_est ? `, about ${plural(script.page_count_est, "page")}` : ""}. ` +
      `${chars.length ? `Main cast: ${top.join(", ")}.` : "No speaking cast."} ${plural(uniq(list.map((s) => s.location).filter(Boolean)).length, "location")}.`
    : "The script has no scenes.";
  const sceneList = list.map((sc) => `${sc.number || sc.index + 1}. ${sc.heading}${(sc.characters || []).length ? ` (${sc.characters.join(", ")})` : ""}`);
  return { tool: "analyze_script", title: "Script analysis", said: summary, summary, scenes: sceneList, beats, issues,
    did: [`read ${plural(list.length, "scene")} and their breakdowns`, "ran the cast, props and locations checks for the issues list"],
    findings: issues.map((why) => ({ kind: "issue", why })), fixes: [...cast.fixes, ...locs.fixes, ...props.fixes],
    limits: "The beats are each quarter's opening action line, not a story reading: ask with the language model on for that." };
}

// ---------------------------------------------------------------- apply_fixes
/**
 * The fixes, applied to a copy of the script (re-derived: cast list, breakdown). -> {script, did: [...], skipped: [...]}.
 * merge_cast renames every cue and dialogue line and the ALL-CAPS name in action; rename_location rewrites the headings;
 * reclassify_prop is kept on the scene (breakdown_fix) so it survives a re-read of the breakdown.
 */
export function applyFixes(script, fixes) {
  const s = JSON.parse(JSON.stringify(script));
  const did = [], skipped = [];
  for (const f of fixes || []) {
    if (f.type === "merge_cast" && f.from && f.into && f.from !== f.into) {
      let n = 0;
      const re = new RegExp(`(?<![A-Za-z])${esc(f.from)}(?![A-Za-z])`, "g");
      for (const sc of s.scenes) for (const e of sc.elements || []) {
        if (e.character === f.from) { e.character = f.into; n++; }
        if (e.type === "character" && typeof e.text === "string") e.text = e.text.replace(re, f.into);
        if (e.type === "action" && typeof e.text === "string" && re.test(e.text)) { e.text = e.text.replace(re, f.into); n++; }
        re.lastIndex = 0;
      }
      (n ? did : skipped).push(n ? `merged ${f.from} into ${f.into} (${plural(n, "line")})` : `${f.from}: not found any more`);
    } else if (f.type === "rename_location" && f.from && f.into) {
      let n = 0;
      for (const sc of s.scenes) if (sc.location === f.from) {
        sc.location = f.into;
        sc.heading = String(sc.heading || "").replace(f.from, f.into);
        n++;
      }
      (n ? did : skipped).push(n ? `renamed "${f.from}" to "${f.into}" in ${plural(n, "scene")}` : `"${f.from}": not found any more`);
    } else if (f.type === "reclassify_prop" && f.item) {
      let n = 0;
      for (const sc of s.scenes) if (!f.scenes || f.scenes.includes(sc.id)) {
        if (!(sc.breakdown?.props || []).some((x) => String(x).toLowerCase() === String(f.item).toLowerCase())) continue;
        sc.breakdown_fix = [...(sc.breakdown_fix || []).filter((x) => x.item !== f.item), { cat: "props", item: f.item, to: f.to || null }];
        n++;
      }
      (n ? did : skipped).push(n ? `${f.to ? `moved "${f.item}" to ${f.to.replace("_", " ")}` : `dropped "${f.item}" from props`} (${plural(n, "scene")})` : `"${f.item}": not in props any more`);
    } else skipped.push(`couldn't apply ${f.type || "that"}`);
  }
  return { script: hydrateScript(compactScript(s)), did, skipped };
}

// ---------------------------------------------------------------- the conversation
/** What the project holds, for the model's system prompt (kept short for a 4B model). */
export function projectSummary(script, { shots = [], max = 2400 } = {}) {
  if (!script?.scenes?.length) return "No script is loaded yet (① Script: import one, or load a sample).";
  const chars = (script.characters || []).map((c) => `${c.name} (${c.lines})`).join(", ");
  const locs = uniq(script.scenes.map((s) => s.location).filter(Boolean)).join(", ");
  const props = uniq(script.scenes.flatMap((s) => s.breakdown?.props || [])).slice(0, 40).join(", ");
  const scenes = script.scenes.slice(0, 40).map((s) => `${s.number || s.index + 1}. ${s.heading} [${(s.characters || []).join(", ")}]`).join("\n");
  const out = `Script "${script.title || "Untitled"}", ${script.scenes.length} scenes.\nCharacters (lines): ${chars || "none"}\nLocations: ${locs || "none"}\n` +
    `Props in the breakdown: ${props || "none"}\nShots: ${shots.length ? shots.map((s) => s.name || s.id).slice(0, 20).join(", ") : "none"}\nScenes:\n${scenes}`;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export const ASSISTANT_SYSTEM = `You ARE the Soundstage assistant (✦ Ask), built into Soundstage, a film-making app in ComfyUI: you act on the user's project with the tools below, you are not a chatbot giving general advice. Steps: ① Script (screenplay, scene breakdown: cast, props, set dressing, wardrobe, vehicles), ② Cast & Locations (a card per character / location: description and a reference picture made by ✨ Generate), ③ Set (a 3D stage), ④ Frame (paint stills), ⑤ Motion (video), ⑥ Review, ⑦ Deliver.
You are a collaborative director, DP and editor: when an intent is vague (tone, coverage, pacing) ask ONE sharp creative question; suggest film-grammar options with a short why; always ground suggestions in what Soundstage can actually do (the tools, presets and panels), name the exact step, panel and button, and be honest about limits.
${SOUNDSTAGE_MAP}
You talk with the user over several turns and do what they ask with these tools:
- search_docs {query}: the Soundstage docs and every control, preset, setting, shortcut and server route; use it for any how / where / what-is question
- troubleshoot {symptom}: known problems (clay not followed in the final, characters drift, camera clips the set, slow render, lip sync, LoRA ignored, physics) with the fix
- plan_recipe {intent}: a creative intent (a stunt, a gunshot wound / squib, an explosion, a camera move, coverage, a look, an edit: match cut, dissolve, J/L cut, montage, Ripple edit, reshoot, Recast, phone viewfinder, record yourself) -> the Soundstage steps and the preset that does it
- analyze_script {scenes?}: summary, scene list, beats and issues of the screenplay
- check_cast {scenes?}: duplicate or near-duplicate characters (two names for one person, typos, age clashes)
- check_props {scenes?}: which breakdown props are really set dressing, wardrobe, vehicles, characters or not props at all
- check_locations {scenes?}: duplicate or overlapping locations
- gather_character {name}: everything the script says about one character (scenes, lines, action, what others say, wardrobe, props), cited by scene and line. name can be loose: "the tall stranger", "Mara"
- profile_character {name}: build that character: gathers, then a profile (age, build, look, hair, wardrobe, personality, role, arc, visual notes) with citations, and a lookalike / duplicate check against the cast. Use it for "build / profile / who is / what kind of character is X"
- update_character {name, fields?}: write the profile into X's ② Cast card (one Undo). Only after the user said yes to "Apply to the cast card?"
- regenerate_character {name}: queue ✨ Generate for X's card only (uses the GPU). Only after the user said yes; never for everyone
- plan_stage {command}: change the 3D set (weather, cars, people, camera, lights, renders): a short order like "make it rain"
- show_me {topic}: how to do something in the app, step by step
- add_note {scene?, text}: a note in the Director's Book
Fixes are never applied by you: the checks propose them and the user presses Apply. After a profile, ask "Apply to the cast card?"; after applying, offer "Regenerate the sheet? (uses the GPU)".
Rules: call every tool the request needs (several is fine). Never say you checked or changed something unless you call its tool in this turn (writing a card and generating a picture included). If the request is unclear, ask one short question instead of guessing. If no tool can do it, say so and name the nearest thing you can do. "scenes" is a list of scene numbers.
Reply with JSON only: {"reply": "one or two sentences to the user", "question": "a clarifying question, or empty", "tools": [{"name": "check_cast", "args": {}}]}`;

/** Parse the model's JSON turn. -> {reply, question, tools: [{name, args}]} or null. */
export function parseTurn(raw) {
  const s = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return s ? { reply: s.slice(0, 400), question: "", tools: [] } : null;
  try {
    const j = JSON.parse(m[0]);
    const tools = (Array.isArray(j.tools) ? j.tools : []).map((t) => (typeof t === "string" ? { name: t, args: {} } : { name: String(t?.name || ""), args: t?.args && typeof t.args === "object" ? t.args : {} }))
      .filter((t) => t.name).slice(0, 6);
    return { reply: String(j.reply || j.answer || "").trim().slice(0, 600), question: String(j.question || "").trim().slice(0, 300), tools };
  } catch { return s ? { reply: s.slice(0, 400), question: "", tools: [] } : null; }
}

// The built-in router, for when no language model answers: which checks a request asks for.
const WANTS = [
  ["check_cast", /\b(characters?|cast|duplicat\w*|dupes?|same person|names?)\b/i],
  ["check_props", /\bprops?\b/i],
  ["check_locations", /\b(locations?|places|duplicate sets?|the sets)\b/i],
  ["analyze_script", /\b(analy[sz]\w*|summar\w*|beats?|story|read (?:the|my|this) (?:script|screenplay)|script notes|issues in the script|review the script|break ?down the script|coverage)\b/i],
];
const CHECKY = /\b(check|double[- ]?check|verify|make sure|look (?:at|over|through)|go (?:over|through)|review|audit|fix|clean up|find|analy[sz]e|read)\b/i;
const SCRIPTY = /\b(script|screenplay|cast|characters?|props?|locations?|breakdown)\b/i;

/** -> the tool names a request asks for, from its words (no model). */
export function wantedTools(text) {
  const t = String(text || "");
  const hits = WANTS.filter(([, rx]) => rx.test(t)).map(([n]) => n);
  if (!hits.length) return [];
  // "names" or "characters" alone in a stage order ("put Mara in the car") isn't a cast check: it needs a check word
  // or a script word with it.
  if (!CHECKY.test(t) && !(/\b(duplicat\w*|dupes?|same person)\b/i.test(t))) return hits.filter((n) => n === "analyze_script" && /analy|summar|beats|coverage/i.test(t));
  return hits;
}
/** A check-like request the router can't place ("check it", "make sure it's right"): ask, don't guess. */
export const isVagueCheck = (text) => CHECKY.test(text) && !wantedTools(text).length && !/\b(set|stage|camera|shot|frame|render|light)\b/i.test(text) &&
  (SCRIPTY.test(text) || String(text).trim().split(/\s+/).length <= 6);
/** "now do the same for scene 3" / "again for scene 2 and 4" -> {scenes: ["3"]} or null. */
export function sameAgain(text) {
  const t = String(text || "");
  if (!/\b(same|again|too|also|as well|that)\b/i.test(t)) return null;
  const nums = [...t.matchAll(/\bscenes?\s+((?:\d+[a-z]?(?:\s*(?:,|and|&)\s*)?)+)/gi)].flatMap((m) => m[1].split(/\s*(?:,|and|&)\s*/)).map((x) => x.trim()).filter(Boolean);
  return nums.length ? { scenes: nums } : (/\b(same|again)\b/i.test(t) ? { scenes: null } : null);
}

export const ANSWER_SYSTEM = `You are the Soundstage assistant, a collaborative director, DP and editor. Answer the user from what was found in Soundstage below: name the exact step, panel and control, in order, briefly; add one film-craft tip if it helps. If what was found doesn't answer it, say so. Never claim you did something: you are only explaining. Plain text, at most 6 short lines.`;
/** A problem report ("having trouble", "doesn't", "won't", "is off") and a creative intent ("I want a gunshot wound"). */
export const SYMPTOM = /\b(trouble|problem|issue|not working|doesn'?t|does not|won'?t|isn'?t|can'?t get|cannot get|fails?|broken|wrong|stuck|slow|off\b|drift\w*|ignor\w+|clips?|clipping|out of sync|no effect)/i;
export const INTENT = /\b(i want|i'd like|i would like|let'?s (?:do|add|have|make|shoot)|how (?:do|can|would) (?:i|we) (?:do|add|make|shoot|stage|film|get)|(?:add|do|stage|shoot|make|plan|need) (?:a|an|some|the)\b|give me a)/i;

export const YES = /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please(?: do)?|do it|go ahead|go for it|apply(?: it)?|lock it in|sounds good|perfect|looks good|regenerate(?: it)?|y)\b/i;
export const NO = /^\s*(?:no|nope|not now|skip|cancel|later|don'?t|leave it|nah)\b/i;

/**
 * "build the tall stranger", "profile Mara", "who is the tall stranger?", "what kind of character is Ben" -> the name asked for,
 * only when it is someone in the script (so "build the set" stays a set order). -> string or null
 */
export function buildTarget(text, script) {
  const t = String(text || "").trim().replace(/[.!?]+$/, "");
  const m = t.match(/^(?:(?:can you|could you|please|let's|lets)\s+)*(?:build|profile|flesh out|develop|work out|figure out|create|make|cast)\s+(?:(?:a|the)\s+character\s+(?:of|for)\s+)?(.+?)(?:\s+(?:as a character|character|for me|from the script))?$/i)
    || t.match(/^(?:who(?:'s| is)|what (?:kind|type|sort) of (?:character|person|guy|man|woman) is)\s+(.+?)$/i)
    || t.match(/^(?:tell me about|describe)\s+(.+?)(?:'s character)?$/i);
  if (!m || !script?.scenes?.length) return null;
  const who = resolveCharacter(script, m[1]);
  return who ? m[1].trim() : null;
}

export const CLARIFY = { question: "What should I check?", options: [
  { label: "The cast (duplicate names)", command: "check the cast for duplicates" },
  { label: "The props", command: "check the props are real props" },
  { label: "The locations", command: "check the locations for duplicates" },
  { label: "Analyse the whole script", command: "analyse the script" }] };

/**
 * One conversation: history, the last tools (for "the same for scene 3"), and a turn that asks the model (if any) or
 * the built-in router which tools to run. host: {script(), shots(), llm: async (system, prompt, {signal}) -> raw text
 * or throws, llmName()}. -> {reply, question?, options?, results: [tool results], plan?: command, recipe?: topic, note?,
 * by: "model" | "built-in", why?}
 */
export class Conversation {
  constructor(host = {}) { this.host = host; this.reset(); }
  reset() { this.history = []; this.lastTools = []; this.lastWhy = ""; this.pending = null; this.undos = []; this.profiles = {}; }
  /** Text the conversation itself answers, before recipes or the set planner: a yes / no to its own question, "build X". */
  claims(text) {
    if (this.pending && (YES.test(text) || NO.test(text))) return true;
    if (this.undos.length && /^\s*undo(?: that| it)?\s*$/i.test(text)) return true;
    return !!buildTarget(text, this.host.script?.());
  }
  remember(role, text) { if (text) { this.history.push({ role, text: String(text).slice(0, 500) }); if (this.history.length > 16) this.history.splice(0, this.history.length - 16); } }

  run(name, args = {}) {
    const script = this.host.script?.();
    const scopes = { scenes: args.scenes || null };
    if (["analyze_script", "check_cast", "check_props", "check_locations"].includes(name) && !script?.scenes?.length) {
      return { tool: name, title: name.replace("_", " "), said: "There's no script loaded yet: import one in ① Script (or load the sample), then ask again.", did: [], findings: [], fixes: [], none: true };
    }
    if (name === "analyze_script") return analyzeScript(script, scopes);
    if (name === "check_cast") return checkCast(script, scopes);
    if (name === "check_props") return checkProps(script, scopes);
    if (name === "check_locations") return checkLocations(script, scopes);
    return null;
  }

  // ---- building a character (web/agent/charbuild.mjs)
  _castNames() { try { return (this.host.cast?.()?.items() || []).filter((x) => x.kind === "character").map((x) => x.name); } catch { return []; } }

  async profile(name, { signal = null, useModel = true } = {}) {
    const script = this.host.script?.();
    const g = gatherCharacter(script, name, { extra: this._castNames() });
    if (g.none) return { ...g, tool: "profile_character" };
    let profile = null, why = "";
    if (useModel && this.host.llm) {
      try { profile = parseProfile(await this.host.llm(PROFILE_SYSTEM, gatherText(g), { signal }), g); if (!profile) why = "the model's profile didn't parse"; }
      catch (e) { if (e?.cancelled || signal?.aborted) throw e; why = e?.noModel ? String(e.message) : e?.timedOut ? "the language model didn't answer in time" : `the language model failed (${e?.message || e})`; }
    } else why = useModel ? this.host.noModelWhy?.() || "no language model is loaded" : "";
    if (!profile) profile = draftProfile(g, script);
    const card = cardFields(profile);
    const cross = crossCheck(script, g.name, card.description, this.host.cast?.()?.items() || []);
    this.profiles[g.name] = { profile, card };
    const hasCard = !!this.host.cast?.()?.find(g.name);
    this.pending = hasCard ? { type: "update", name: g.name } : null;
    return { tool: "profile_character", title: `Character: ${g.name}`, said: `${g.said} Profile: ${profile.sourceLabel}.`, name: g.name, gather: g, profile, card,
      crosscheck: cross, findings: cross.map((c) => ({ kind: c.kind, why: c.why })), fixes: [],
      did: [...g.did, profile.source === "model" ? "the language model read that and wrote the profile (citations checked against the script)" : `wrote a draft from the script's own words${why ? ` (${why})` : ""}`,
        "compared the result with the cast (duplicate names, lookalike descriptions)"],
      limits: g.limits, confirm: hasCard ? { kind: "update", name: g.name, question: `Apply this to ${g.name}'s ② Cast card?` } : null,
      noCard: hasCard ? "" : `${g.name} has no ② Cast card in this App, so there is nothing to write it into yet.` };
  }

  /** Write the last profile (or fields) into the card. One Undo. -> result */
  update(name, fields = null) {
    const cast = this.host.cast?.();
    const who = this.profiles[name] ? name : resolveCharacter(this.host.script?.(), name, { extra: this._castNames() })?.name || name;
    const f = { ...(this.profiles[who]?.card || {}), ...(fields && typeof fields === "object" ? fields : {}) };
    const base = { tool: "update_character", title: `② Cast: ${who}`, findings: [], fixes: [] };
    if (!cast) return { ...base, said: "② Cast isn't open in this App, so I couldn't write the card.", did: [] };
    if (!f.description && !f.look) return { ...base, said: `I have no profile for ${who} yet: ask me to build them first.`, did: [] };
    const res = cast.write(who, f);
    if (!res) return { ...base, said: `${who} has no ② Cast card, so nothing was written.`, did: [`looked for ${who}'s card in ② Cast`] };
    const entry = { key: res.key, before: res.before, name: who };
    this.undos.push(entry);
    this.pending = { type: "regen", name: who };
    return { ...base, said: `Wrote ${who}'s ② Cast card.`, name: who, before: res.before, after: res.after, undo: entry,
      did: [`wrote the description${f.look ? " and the look (" + Object.keys(f.look).join(", ") + ")" : ""} into ${who}'s ② Cast card`],
      confirm: { kind: "regen", name: who, question: `Regenerate ${who}'s character sheet? It uses the GPU (one card only).` } };
  }

  /** Put a card back (the last update, or the one given). */
  undo(entry = null) {
    const e = entry || this.undos.at(-1);
    if (!e) return "Nothing to undo.";
    this.host.cast?.()?.restore(e.key, e.before);
    this.undos = this.undos.filter((x) => x !== e);
    if (this.pending?.name === e.name) this.pending = null;
    return `Put ${e.name}'s ② Cast card back as it was.`;
  }

  /** That one card's ✨ Generate. Only called after a yes. -> result with queued: Promise */
  regenerate(name) {
    const cast = this.host.cast?.();
    this.pending = null;
    const base = { tool: "regenerate_character", title: `✨ Generate: ${name}`, findings: [], fixes: [] };
    if (!cast) return { ...base, said: "② Cast isn't open in this App, so nothing was generated.", did: [] };
    if (cast.busy?.()) return { ...base, said: "② Cast is already generating every missing card: wait for it, then ask again.", did: [] };
    const queued = cast.regenerate(name);
    return { ...base, said: `Queued ✨ Generate for ${name}'s card only (FLUX 3 Klein on the GPU; a few minutes).`, name, queued,
      did: [`queued ✨ Generate on ${name}'s ② Cast card (that card only)`] };
  }

  /** A yes / no / undo for the conversation's own question, without the model. -> turn output or null */
  _answerPending(text) {
    const out = { reply: "", results: [], by: "built-in", why: "" };
    if (this.undos.length && /^\s*undo(?: that| it)?\s*$/i.test(text)) { out.reply = this.undo(); return out; }
    const p = this.pending;
    if (!p) return null;
    if (NO.test(text)) { this.pending = null; out.reply = p.type === "update" ? `OK, ${p.name}'s card stays as it is.` : "OK, no regenerate."; return out; }
    if (!YES.test(text)) return null;
    const r = p.type === "update" ? this.update(p.name) : this.regenerate(p.name);
    out.results.push(r);
    return out;
  }

  /** Without the model: a problem -> troubleshoot, a creative intent -> plan_recipe (only when one matches), else null. */
  builtInKnow(text) {
    if (SYMPTOM.test(text) && troubleshoot(text).entries.length) return { tools: [{ name: "troubleshoot", args: { symptom: text } }] };
    if (INTENT.test(text) && !this.host.hasRecipe?.(text) && planRecipe(text).steps.length) return { tools: [{ name: "plan_recipe", args: { intent: text } }] };
    return null;
  }

  /** The built-in router: the checks the words ask for, "the same for scene N", a question when unsure, else null. */
  builtIn(text) {
    const who = buildTarget(text, this.host.script?.());
    if (who) return { tools: [{ name: "profile_character", args: { name: who } }] };
    const again = sameAgain(text);
    let tools = wantedTools(text);
    let scenes = null;
    if (!tools.length && again && this.lastTools.length) { tools = this.lastTools; scenes = again.scenes; }
    else { const m = [...String(text).matchAll(/\bscenes?\s+(\d+[a-z]?)/gi)].map((x) => x[1]); if (m.length) scenes = m; }
    if (tools.length) return { tools: tools.map((name) => ({ name, args: scenes ? { scenes } : {} })) };
    if (isVagueCheck(text)) return { clarify: true };
    return null;
  }

  /** The model words the answer from what the knowledge tools found (a second, short round trip). */
  async _answerFrom(text, results, signal) {
    const ctx = results.map((r) => r.tool === "search_docs" ? r.context : r.tool === "troubleshoot" ? r.entries.map((e) => `Problem: ${e.symptom}\nCause: ${e.cause}\nFix: ${e.fix.join(" ")}`).join("\n")
      : r.steps?.length ? `${r.title}: ${r.steps.join(" ")} ${r.craft || ""}` : "").filter(Boolean).join("\n\n").slice(0, 3600);
    if (!ctx) return "";
    try {
      const raw = await this.host.llm(ANSWER_SYSTEM, `Found in Soundstage:\n${ctx}\n\nUser: ${text}`, { signal });
      return String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 900);
    } catch (e) { if (e?.cancelled || signal?.aborted) throw e; return ""; }
  }

  async _know(name, args, text) {
    if (name === "search_docs") return searchDocs(String(args.query || text));
    if (name === "troubleshoot") return troubleshoot(String(args.symptom || text));
    return planRecipe(String(args.intent || text));
  }

  async turn(text, { signal = null, useModel = true, question = false } = {}) {
    this.remember("user", text);
    // writing a card may be asked for outright ("apply it to his card"); regenerating (the GPU) always asks first
    const yes = YES.test(text) || /\b(apply|update|write)\b/i.test(text);
    const quick = this._answerPending(text);
    if (quick) { this._after(quick); return quick; }
    this.pending = null;
    let plan = null, by = "built-in", why = "";
    if (useModel && this.host.llm) {
      try {
        const raw = await this.host.llm(`${ASSISTANT_SYSTEM}\n\nThe project now:\n${projectSummary(this.host.script?.(), { shots: this.host.shots?.() || [] })}`,
          this._prompt(text), { signal });
        plan = parseTurn(raw);
        if (plan) by = "model";
        else why = "the model's answer was empty";
      } catch (e) {
        if (e?.cancelled || signal?.aborted) throw e;
        why = e?.noModel ? String(e.message) : e?.timedOut ? "the language model didn't answer in time" : `the language model failed (${e?.message || e})`;
      }
    } else if (useModel) why = this.host.noModelWhy?.() || "no language model is loaded";
    this.lastWhy = why;
    const out = { reply: "", results: [], by, why };
    if (plan) {
      out.reply = plan.reply;
      if (plan.question && !plan.tools.length) { out.question = plan.question; this.remember("assistant", plan.question); return out; }
      const unknown = [];
      const ran = [];
      for (const t of plan.tools) {
        if (t.name === "plan_stage") { out.plan = String(t.args.command || text).slice(0, 200); continue; }
        if (t.name === "show_me") { out.recipe = String(t.args.topic || text); continue; }
        if (t.name === "add_note") { out.note = { text: String(t.args.text || "").slice(0, 600), scene: t.args.scene ?? null }; continue; }
        if (t.name === "apply_fixes") { out.applyAsked = true; continue; }   // only the user's button applies
        if (KNOW_TOOLS.includes(t.name)) { out.results.push(await this._know(t.name, t.args, text)); ran.push(t.name); continue; }
        const nm = String(t.args.name || t.args.character || "");
        if (t.name === "gather_character" || t.name === "profile_character") {
          const r = t.name === "profile_character" ? await this.profile(nm, { signal, useModel }) : { ...gatherCharacter(this.host.script?.(), nm, { extra: this._castNames() }) };
          out.results.push(r); ran.push(t.name); continue;
        }
        if (t.name === "update_character" || t.name === "regenerate_character") {
          // the user's own yes is required; without it the tool becomes the question
          const who = resolveCharacter(this.host.script?.(), nm, { extra: this._castNames() })?.name || normalizeCharacter(nm);
          if (!yes || t.name === "regenerate_character") { this.pending = { type: t.name === "update_character" ? "update" : "regen", name: who }; out.confirmOnly = { kind: this.pending.type, name: who, question: t.name === "update_character" ? `Apply this to ${who}'s ② Cast card?` : `Regenerate ${who}'s character sheet? It uses the GPU (one card only).` }; continue; }
          out.results.push(t.name === "update_character" ? this.update(who, t.args.fields) : this.regenerate(who)); ran.push(t.name); continue;
        }
        const r = TOOL_NAMES.includes(t.name) ? this.run(t.name, t.args) : null;
        if (r) { out.results.push(r); ran.push(t.name); } else unknown.push(t.name);
      }
      if (ran.some((n) => KNOW_TOOLS.includes(n))) {
        const said = await this._answerFrom(text, out.results.filter((r) => KNOW_TOOLS.includes(r.tool)), signal);
        if (said) out.reply = said;
      }
      if (ran.length) { this.lastTools = ran.filter((n) => !KNOW_TOOLS.includes(n) && !CHAR_TOOLS.includes(n)); }
      if (unknown.length) out.cant = `I can't do ${unknown.join(", ")} yet. The nearest I can do: analyse the script, check the cast, props or locations, build a character into ② Cast, change the set, or add a Book note.`;
      if (!plan.tools.length && !out.reply) out.reply = "I'm not sure what to do with that.";
    } else {
      const r = this.builtIn(text) || (question || SYMPTOM.test(text) || INTENT.test(text) ? this.builtInKnow(text) : null);
      if (r?.clarify) { out.question = CLARIFY.question; out.options = CLARIFY.options; this.remember("assistant", CLARIFY.question); return out; }
      if (!r) return null;   // nothing for the checks: the recipes / the Director's planner take it (ask.mjs)
      for (const t of r.tools) {
        if (KNOW_TOOLS.includes(t.name)) { out.results.push(await this._know(t.name, t.args, text)); continue; }
        const x = t.name === "profile_character" ? await this.profile(t.args.name, { signal, useModel: false }) : this.run(t.name, t.args);
        if (x) out.results.push(x);
      }
      this.lastTools = r.tools.map((t) => t.name).filter((n) => !CHAR_TOOLS.includes(n) && !KNOW_TOOLS.includes(n));
    }
    this._after(out);
    return out;
  }

  /** The question a turn ends on (the last result's confirm) and the history line. */
  _after(out) {
    const c = out.confirmOnly || [...out.results].reverse().find((x) => x.confirm)?.confirm || null;
    if (c) { out.confirm = c; this.pending = { type: c.kind, name: c.name }; }
    this.remember("assistant", [out.reply, ...out.results.map((x) => x.said), out.plan ? `(planned on the set: ${out.plan})` : "", c?.question || ""].filter(Boolean).join(" "));
  }

  _prompt(text) {
    const h = this.history.slice(0, -1).slice(-8).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
    return `${h ? `Conversation so far:\n${h}\n\n` : ""}${this.host.where?.() ? `${this.host.where()}.\n` : ""}User: ${text}`;
  }
}
