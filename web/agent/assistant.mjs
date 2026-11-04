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
// Pure: no DOM. The chat UI is web/agent/ask.mjs + directorpanel.mjs; tests/js/assistant.test.mjs.
import { normalizeCharacter, hydrateScript, compactScript } from "../script/parse.mjs";
export { applyBreakdownFixes } from "../script/breakdown.mjs";

export const TOOL_NAMES = ["analyze_script", "check_cast", "check_props", "check_locations", "apply_fixes", "plan_stage", "show_me", "add_note"];

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

export const ASSISTANT_SYSTEM = `You are Ask, the assistant inside Soundstage, a film-making app in ComfyUI. Steps: ① Script (screenplay, scene breakdown: cast, props, set dressing, wardrobe, vehicles), ② Cast & Locations, ③ Set (a 3D stage), ④ Frame (paint stills), ⑤ Motion (video), ⑥ Review, ⑦ Deliver.
You talk with the user over several turns and do what they ask with these tools:
- analyze_script {scenes?}: summary, scene list, beats and issues of the screenplay
- check_cast {scenes?}: duplicate or near-duplicate characters (two names for one person, typos, age clashes)
- check_props {scenes?}: which breakdown props are really set dressing, wardrobe, vehicles, characters or not props at all
- check_locations {scenes?}: duplicate or overlapping locations
- plan_stage {command}: change the 3D set (weather, cars, people, camera, lights, renders): a short order like "make it rain"
- show_me {topic}: how to do something in the app, step by step
- add_note {scene?, text}: a note in the Director's Book
Fixes are never applied by you: the checks propose them and the user presses Apply.
Rules: call every tool the request needs (several is fine). Never say you checked or changed something unless you call its tool. If the request is unclear, ask one short question instead of guessing. If no tool can do it, say so and name the nearest thing you can do. "scenes" is a list of scene numbers.
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
  reset() { this.history = []; this.lastTools = []; this.lastWhy = ""; }
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

  /** The built-in router: the checks the words ask for, "the same for scene N", a question when unsure, else null. */
  builtIn(text) {
    const again = sameAgain(text);
    let tools = wantedTools(text);
    let scenes = null;
    if (!tools.length && again && this.lastTools.length) { tools = this.lastTools; scenes = again.scenes; }
    else { const m = [...String(text).matchAll(/\bscenes?\s+(\d+[a-z]?)/gi)].map((x) => x[1]); if (m.length) scenes = m; }
    if (tools.length) return { tools: tools.map((name) => ({ name, args: scenes ? { scenes } : {} })) };
    if (isVagueCheck(text)) return { clarify: true };
    return null;
  }

  async turn(text, { signal = null, useModel = true } = {}) {
    this.remember("user", text);
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
        const r = TOOL_NAMES.includes(t.name) ? this.run(t.name, t.args) : null;
        if (r) { out.results.push(r); ran.push(t.name); } else unknown.push(t.name);
      }
      if (ran.length) { this.lastTools = ran; }
      if (unknown.length) out.cant = `I can't do ${unknown.join(", ")} yet. The nearest I can do: analyse the script, check the cast, props or locations, change the set, or add a Book note.`;
      if (!plan.tools.length && !out.reply) out.reply = "I'm not sure what to do with that.";
    } else {
      const r = this.builtIn(text);
      if (r?.clarify) { out.question = CLARIFY.question; out.options = CLARIFY.options; this.remember("assistant", CLARIFY.question); return out; }
      if (!r) return null;   // nothing for the checks: the recipes / the Director's planner take it (ask.mjs)
      for (const t of r.tools) { const x = this.run(t.name, t.args); if (x) out.results.push(x); }
      this.lastTools = r.tools.map((t) => t.name);
    }
    this.remember("assistant", [out.reply, ...out.results.map((x) => x.said), out.plan ? `(planned on the set: ${out.plan})` : ""].filter(Boolean).join(" "));
    return out;
  }

  _prompt(text) {
    const h = this.history.slice(0, -1).slice(-8).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
    return `${h ? `Conversation so far:\n${h}\n\n` : ""}${this.host.where?.() ? `${this.host.where()}.\n` : ""}User: ${text}`;
  }
}
