// ✦ Ask builds a character from the script (Mike, 2026-11-04: "pick the person, like the tall stranger, read the text about
// him and all the script and all the scenes he's in, and figure out what type of character he is… crucial step").
//
//   gather_character   deterministic: every scene, line, action mention, what others say, wardrobe and prop cues,
//                      each with its scene number and line (the element's place in the scene, 1-based), capped
//   profile_character  the language model reads that and returns a profile, each field with its citations; without
//                      the model, a deterministic "draft from script cues"
//   update_character   writes the profile into the ② Cast card (description + look), one Undo
//   regenerate_character  that ONE card's ✨ Generate (the per-card path), only after a yes ("uses the GPU")
// Pure: no DOM. The Conversation (web/agent/assistant.mjs) runs them; ask.mjs draws the cards; the ② Cast adapter is
// castHost() below. Tests: tests/js/charbuild.test.mjs.
import { normalizeCharacter } from "../script/parse.mjs";
import { CLOTHES } from "../cast/shotcast.mjs";
import { nameWords, editDistance, checkCast } from "./assistant.mjs";

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const uniq = (xs) => [...new Set(xs)];
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const clip = (s, n = 200) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const sentences = (t) => String(t || "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const sceneNo = (sc) => String(sc.number || sc.index + 1);
export const cite = (x) => `sc ${x.scene} · l ${x.line}`;
const FILLER = new Set(["THE", "A", "AN", "THAT", "THIS", "GUY", "PERSON", "CHARACTER", "ONE", "HIS", "HER", "CARD", "SHEET"]);

/** The words of a request's name: "the tall stranger" -> ["BURLY", "MAN"]. */
const queryWords = (q) => normalizeCharacter(q).replace(/['’]S\b/g, "").replace(/[^A-Z0-9 #'-]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w));

/**
 * Who a request means: "the tall stranger", "TALL STRANGER", "Mara", "marra" (a typo), or a description the script gives where
 * it introduces them ("the tattooed one" -> whoever the action calls tattooed). extra: more names (the ② Cast cards).
 * -> {name, aliases: [other spellings of the same person, from check_cast], how, others: [close names]} or null.
 */
export function resolveCharacter(script, query, { extra = [] } = {}) {
  const names = uniq([...(script?.characters || []).map((c) => c.name), ...extra.map((n) => normalizeCharacter(n))]).filter(Boolean);
  const qw = queryWords(query), qk = qw.join(" ");
  if (!qk || !names.length) return null;
  const scored = names.map((n) => {
    const nw = nameWords(n), nk = nw.join(" ");
    let s = 0, how = "";
    if (nk === qk || normalizeCharacter(n) === qk) { s = 100; how = "name"; }
    else if (qw.every((w) => nw.includes(w)) || (nw.length && nw.every((w) => qw.includes(w)))) { s = 80; how = "part of the name"; }
    else if (editDistance(nk, qk, 2) <= (Math.min(nk.length, qk.length) >= 7 ? 2 : 1) && Math.min(nk.length, qk.length) >= 4) { s = 60; how = "spelling"; }
    else {
      // a description: the request's words in an action sentence that names them in caps
      const re = new RegExp(`(?<![A-Za-z])${esc(n)}(?![A-Za-z])`);
      for (const sc of script?.scenes || []) for (const e of sc.elements || []) {
        if (e.type !== "action" || !re.test(e.text || "")) continue;
        for (const se of sentences(e.text)) if (re.test(se) && qw.every((w) => new RegExp(`\\b${esc(w)}\\b`, "i").test(se))) { s = 50; how = "description"; }
      }
    }
    return { n, s, how };
  }).filter((x) => x.s).sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  const best = scored[0];
  const aliases = uniq(checkCast(script || {}).findings.filter((f) => f.kind !== "age" && f.names.includes(best.n)).flatMap((f) => f.names).filter((x) => x !== best.n));
  return { name: best.n, aliases, how: best.how, others: scored.slice(1, 4).filter((x) => x.s === best.s).map((x) => x.n) };
}

/**
 * Everything the script says about one character. -> {tool, title, said, did, name, aliases, scenes, dialogue, action,
 * described, wardrobe, props, intro, counts, more, findings, fixes}. Each item: {scene, line, text} (+ by for described).
 * cap: items kept per list (the counts say how many there were).
 */
export function gatherCharacter(script, query, { cap = 10, extra = [] } = {}) {
  const base = { tool: "gather_character", title: "What the script says", findings: [], fixes: [] };
  if (!script?.scenes?.length) return { ...base, none: true, said: "There's no script loaded yet: import one in ① Script, then ask again.", did: [] };
  const who = resolveCharacter(script, query, { extra });
  if (!who) {
    const all = (script.characters || []).slice(0, 8).map((c) => c.name);
    return { ...base, none: true, said: `I couldn't find "${query}" in the script.${all.length ? ` The characters are: ${all.join(", ")}.` : ""}`, did: [`looked for "${query}" among ${plural((script.characters || []).length, "character")} and in the action lines`] };
  }
  const names = [who.name, ...who.aliases];
  const caps = new RegExp(`(?<![A-Za-z])(?:${names.map(esc).join("|")})(?![A-Za-z])`);
  const prose = new RegExp(`(?<![A-Za-z])(?:${names.map((n) => esc(titleCase(n))).join("|")})(?![A-Za-z])`);
  const mentions = (t) => caps.test(t) || prose.test(t);
  const lists = { scenes: [], dialogue: [], action: [], described: [], wardrobe: [], props: [] };
  let intro = null;
  for (const sc of script.scenes) {
    const n = sceneNo(sc);
    const inScene = (sc.characters || []).some((c) => names.includes(c)) || (sc.breakdown?.cast || []).some((c) => names.includes(normalizeCharacter(c)));
    let seen = inScene;
    const props = (sc.breakdown?.props || []).map(String);
    (sc.elements || []).forEach((e, i) => {
      const line = i + 1, text = String(e.text || "");
      if (e.type === "dialogue" && names.includes(e.character)) { lists.dialogue.push({ scene: n, line, text: clip(text) }); seen = true; return; }
      if (e.type === "dialogue" && e.character && mentions(text)) { lists.described.push({ scene: n, line, by: e.character, text: clip(text) }); return; }
      if (e.type !== "action") return;
      let follow = false;   // the sentence after a mention, in the same paragraph, while it names nobody else
      for (const se of sentences(text)) {
        const named = caps.test(se) || prose.test(se);
        if (!named && !(follow && !/(?<![A-Za-z])[A-Z]{3,}(?:\s+[A-Z]{2,})*(?![A-Za-z])/.test(se))) { follow = false; continue; }
        follow = named || follow;
        seen = true;
        lists.action.push({ scene: n, line, text: clip(se) });
        if (!intro && /\(\s*(?:early |mid-?|late )?\d{1,2}s?\s*\)/.test(se)) intro = { scene: n, line, text: clip(se) };
        const garments = [...se.matchAll(new RegExp(`(?:\\b[a-z-]+ )?${CLOTHES.source}`, "gi"))].map((m) => m[0].toLowerCase().replace(/^(?:a|an|the|his|her|their|and|in|with) /, ""));
        if (garments.length) lists.wardrobe.push({ scene: n, line, text: clip(se), items: uniq(garments) });
        const held = props.filter((p) => new RegExp(`\\b${esc(p)}\\b`, "i").test(se));
        if (held.length) lists.props.push({ scene: n, line, text: clip(se), items: held });
      }
    });
    if (seen) lists.scenes.push({ scene: n, line: 0, text: clip(sc.heading, 90), id: sc.id });
  }
  const counts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
  const more = {};
  for (const k of Object.keys(lists)) if (lists[k].length > cap) { more[k] = lists[k].length - cap; lists[k] = k === "dialogue" ? [...lists[k].slice(0, cap - 2), ...lists[k].slice(-2)] : lists[k].slice(0, cap); }
  const said = `${who.name}${who.aliases.length ? ` (also written ${who.aliases.join(", ")})` : ""}: ${plural(counts.scenes, "scene")}, ${plural(counts.dialogue, "line")} of dialogue, ` +
    `${plural(counts.action, "action mention")}, ${plural(counts.described, "line")} where others talk about them.`;
  return { ...base, said, name: who.name, aliases: who.aliases, how: who.how, others: who.others, ...lists, intro, counts, more,
    did: [`found "${query}" as ${who.name} (by ${who.how})`, `read ${plural(script.scenes.length, "scene")}: dialogue, action lines, what others say, wardrobe and prop cues`],
    limits: `Kept ${cap} of each kind${Object.keys(more).length ? ` (${Object.entries(more).map(([k, v]) => `${v} more ${k}`).join(", ")})` : ""}. Pronouns ("he", "she") aren't followed.` };
}

/** The gathered evidence as text for the model, cited, cut at max characters. */
export function gatherText(g, max = 3200) {
  if (!g || g.none) return "";
  const sec = (label, xs, f = (x) => x.text) => (xs?.length ? `${label}:\n${xs.map((x) => `[${x.scene}:${x.line}] ${x.by ? `${x.by}: ` : ""}${f(x)}`).join("\n")}\n` : "");
  const out = `Character: ${g.name}${g.aliases.length ? ` (also ${g.aliases.join(", ")})` : ""}\nScenes: ${g.scenes.map((s) => `${s.scene} ${s.text}`).join("; ")}\n` +
    sec("Introduced", g.intro ? [g.intro] : []) + sec("Action", g.action) + sec("Dialogue", g.dialogue) + sec("Others about them", g.described) +
    sec("Wardrobe cues", g.wardrobe, (x) => x.items.join(", ")) + sec("Props", g.props, (x) => x.items.join(", "));
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// ---------------------------------------------------------------- the profile
export const PROFILE_FIELDS = ["age", "build", "look", "hair", "wardrobe", "personality", "role", "arc", "visual"];
export const FIELD_LABEL = { age: "Age range", build: "Build", look: "Look / face", hair: "Hair", wardrobe: "Wardrobe", personality: "Personality",
  role: "Role in the story", arc: "Arc", visual: "Visual notes (for the picture)" };

const BUILD = /\b(burly|stocky|heavy-?set|thickset|muscular|brawny|hulking|beefy|portly|plump|fat|overweight|big|huge|large|giant|towering|tall|lanky|gangly|thin|skinny|wiry|lean|slim|slender|slight|petite|small|tiny|short|athletic|broad(?:-shouldered)?|frail|gaunt|pot-?bellied)\b/gi;
const AGE_WORD = /\b(teen(?:age|ager)?|young|youthful|middle-aged|old|older|elderly|aging|ageing|grey-haired|gray-haired|kid|boy|girl|child|baby|in (?:his|her|their) (?:early |mid-?|late )?\d0s)\b/gi;
const HAIR = /\b(?:[a-z-]+ ){0,2}(?:hair|shaved head|bald head|beard|bald|balding|ponytail|mo?ustache|braids?|dreadlocks|dreads|buzz ?cut|crew ?cut|mohawk|stubble|goatee|sideburns|curls|bun|mullet)\b/gi;
const FACE = /\b(?:[a-z-]+ ){0,2}(?:scar(?:red)?|tattoo(?:s|ed)?|eyes|face|glasses|freckles|wrinkle[sd]?|weathered|pale|tanned|sunburned|bruised|piercings?|nose|jaw|teeth|smile|grin|eyepatch|makeup|lipstick)\b/gi;
const TRAITS = /\b(nervous|anxious|calm|gruff|kind|gentle|quiet|silent|shy|loud|angry|furious|cold|warm|cheerful|grim|stern|sullen|sly|smug|cocky|confident|weary|tired|haunted|brooding|friendly|menacing|threatening|charming|awkward|curious|suspicious|wary|jittery|fierce|tender|stoic|sarcastic|dry|playful|desperate|determined|patient|impatient|sad|grieving|scared|frightened|brave|proud|bitter|hostile|polite|tough|hard|soft-spoken|watchful|distracted|drunk|sober)\b/gi;

const hitsIn = (items, rx) => {
  const out = [];
  for (const x of items) for (const m of String(x.text).matchAll(rx)) out.push({ v: m[0].trim().toLowerCase(), c: { scene: x.scene, line: x.line } });
  return out;
};
const field = (hits, max = 4) => {
  const v = uniq(hits.map((h) => h.v)).slice(0, max);
  return v.length ? { value: v.join(", "), cites: uniq(hits.filter((h) => v.includes(h.v)).map((h) => `${h.c.scene}:${h.c.line}`)).slice(0, 4).map((k) => { const [scene, line] = k.split(":"); return { scene, line: +line }; }) } : { value: "", cites: [] };
};

/** The deterministic draft: what the script's own words say, field by field, cited. -> profile (source: "draft"). */
export function draftProfile(g, script = null) {
  const text = [...(g.intro ? [g.intro] : []), ...g.action];
  const all = [...text, ...g.described];
  const ageM = g.intro?.text.match(/\(\s*((?:early |mid-?|late )?\d{1,2}s?)\s*\)/);
  const age = ageM ? { value: ageM[1], cites: [{ scene: g.intro.scene, line: g.intro.line }] } : field(hitsIn(all, AGE_WORD), 2);
  const garments = g.wardrobe.flatMap((x) => x.items.map((v) => ({ v, c: { scene: x.scene, line: x.line } })));
  const chars = script?.characters || [];
  const me = chars.find((c) => c.name === g.name);
  const rank = me ? chars.slice().sort((a, b) => (b.lines || 0) - (a.lines || 0)).findIndex((c) => c.name === g.name) : -1;
  const nSc = g.counts.scenes, nLn = g.counts.dialogue;
  const role = { value: rank === 0 && nLn ? "lead (the most dialogue)" : nSc >= 3 || nLn >= 8 ? "supporting" : nLn ? "minor speaking part" : "non-speaking / featured extra",
    cites: g.scenes.slice(0, 3).map((s) => ({ scene: s.scene, line: 0 })) };
  const voice = g.dialogue.length ? `${nLn > 12 ? "talks a lot" : nLn > 3 ? "speaks now and then" : "few words"}${g.dialogue.filter((d) => d.text.includes("?")).length > nLn / 3 ? ", asks questions" : ""}${g.dialogue.filter((d) => d.text.includes("!")).length > nLn / 3 ? ", emphatic" : ""}` : "";
  const traits = field(hitsIn(all, TRAITS));
  const personality = { value: [traits.value, voice].filter(Boolean).join("; "), cites: [...traits.cites, ...g.dialogue.slice(0, 2).map((d) => ({ scene: d.scene, line: d.line }))].slice(0, 4) };
  const first = [...g.action, ...g.dialogue].sort((a, b) => +a.scene - +b.scene || a.line - b.line);
  const arc = first.length > 1 && first[0].scene !== first.at(-1).scene
    ? { value: `first seen in scene ${first[0].scene} ("${clip(first[0].text, 60)}"), last in scene ${first.at(-1).scene} ("${clip(first.at(-1).text, 60)}")`, cites: [first[0], first.at(-1)].map((x) => ({ scene: x.scene, line: x.line })) }
    : { value: "", cites: [] };
  const p = { age, build: field(hitsIn(all, BUILD), 3), look: field(hitsIn(text, FACE)), hair: field(hitsIn(text, HAIR), 3), wardrobe: field(garments, 5), personality, role, arc };
  p.visual = { value: visualFrom(p), cites: uniq([...p.age.cites, ...p.build.cites, ...p.hair.cites, ...p.look.cites, ...p.wardrobe.cites].map((c) => `${c.scene}:${c.line}`)).slice(0, 5).map((k) => { const [scene, line] = k.split(":"); return { scene, line: +line }; }) };
  return { name: g.name, source: "draft", sourceLabel: "draft from script cues", fields: p };
}

/** A description for the reference picture from the look fields (refPrompt puts the name in front). */
export function visualFrom(p) {
  const v = (k) => p[k]?.value || "";
  return [v("age") && (/\d/.test(v("age")) ? `in their ${v("age")}` : v("age")), v("build") && `${v("build")} build`, v("hair"), v("look"), v("wardrobe") && `wearing ${v("wardrobe")}`]
    .filter(Boolean).join(", ");
}

export const PROFILE_SYSTEM = `You are the Soundstage assistant building a character for a film from its screenplay. Read the evidence (each line starts [scene:line]) and describe the character.
Use only what the evidence says or clearly implies; leave a field empty ("") if the script gives nothing. Every field cites the [scene:line] it comes from.
Reply with JSON only: {"age": {"value": "", "cites": ["3:12"]}, "build": {...}, "look": {...}, "hair": {...}, "wardrobe": {...}, "personality": {...}, "role": {...}, "arc": {...}, "visual": {"value": "one sentence for an image model: age, build, face, hair, clothes", "cites": [...]}}`;

/**
 * The model's profile JSON, checked against the evidence: a citation the evidence doesn't hold is dropped (so the model
 * can't invent a source). -> profile (source: "model") or null.
 */
export function parseProfile(raw, g) {
  const s = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const have = new Set([...(g.intro ? [g.intro] : []), ...g.action, ...g.dialogue, ...g.described, ...g.wardrobe, ...g.props].map((x) => `${x.scene}:${x.line}`));
  const haveScene = new Set(g.scenes.map((x) => String(x.scene)));
  const fields = {};
  let any = false;
  for (const k of PROFILE_FIELDS) {
    const f = j[k] ?? j.fields?.[k];
    const value = clip(typeof f === "string" ? f : f?.value || "", 300);
    const cites = (Array.isArray(f?.cites) ? f.cites : []).map((c) => String(c).replace(/^\[|\]$/g, "").trim()).map((c) => { const [scene, line] = c.split(":"); return { scene: String(scene || "").replace(/^sc(?:ene)?\s*/i, ""), line: +line || 0 }; })
      .filter((c) => have.has(`${c.scene}:${c.line}`) || (c.line === 0 && haveScene.has(c.scene))).slice(0, 5);
    fields[k] = { value, cites };
    if (value) any = true;
  }
  if (!any) return null;
  if (!fields.visual.value) fields.visual.value = visualFrom(fields);
  return { name: g.name, source: "model", sourceLabel: "the language model's reading of the script", fields };
}

/** The ② Cast card fields a profile writes: the description (what ✨ Generate paints from) and the look. */
export function cardFields(profile) {
  const f = profile.fields;
  const look = Object.fromEntries(["age", "build", "look", "hair", "wardrobe"].map((k) => [k, f[k]?.value || ""]).filter(([, v]) => v));
  return { description: f.visual?.value || visualFrom(f), look, profile: Object.fromEntries(PROFILE_FIELDS.map((k) => [k, f[k]?.value || ""])), profile_source: profile.sourceLabel };
}

/**
 * After building one: does the new look clash with someone else's card (a lookalike), or is the name a duplicate
 * (check_cast)? -> [{kind: "duplicate" | "lookalike", with, why}]
 */
export function crossCheck(script, name, description, castItems = []) {
  const out = [];
  for (const f of checkCast(script || {}).findings) if (f.kind !== "age" && f.names.includes(name)) out.push({ kind: "duplicate", with: f.names.find((n) => n !== name), why: f.why });
  const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z]{4,}/g) || []);
  const mine = words(description);
  if (mine.size >= 3) for (const it of castItems) {
    if (it.kind !== "character" || normalizeCharacter(it.name) === name || !it.description) continue;
    const theirs = words(it.description);
    const both = [...mine].filter((w) => theirs.has(w));
    const j = both.length / (mine.size + theirs.size - both.length);
    if (j >= 0.4) out.push({ kind: "lookalike", with: it.name, why: `${titleCase(name)} and ${it.name} would look alike (${both.slice(0, 5).join(", ")}): change one so ④ Frame can tell them apart` });
  }
  return out;
}

/**
 * The ② Cast panel (web/cast/cast.mjs CastPanel) as the Conversation's cast host: find a character's card, write its
 * fields (one Undo: the card as it was), and queue that ONE card's ✨ Generate. Nothing here can reach generateAll.
 */
export function castHost(panel) {
  if (!panel) return null;
  const items = () => { try { return panel.items(); } catch { return []; } };
  const find = (name) => {
    const n = normalizeCharacter(name);
    return items().find((it) => it.kind === "character" && normalizeCharacter(it.name) === n) || null;
  };
  return {
    items,
    find,
    write(name, fields) {
      const it = find(name);
      if (!it) return null;
      const before = panel.cardSnapshot(it.key);
      panel.setCard(it.key, fields);
      return { key: it.key, before, after: panel.cardSnapshot(it.key) };
    },
    restore(key, before) { panel.restoreCard(key, before); },
    regenerate(name) {
      const it = find(name);
      if (!it) return Promise.reject(new Error(`no ② Cast card for ${name}`));
      return panel.generateOne(it.key);
    },
    busy: () => !!panel._genAll,
  };
}
