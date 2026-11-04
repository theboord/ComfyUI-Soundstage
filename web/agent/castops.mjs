// ✦ Ask's Cast tools (docs/assistant.md): gather everything the script says about a character, location or prop (with
// citations), profile it (the language model, or a deterministic read of the words), write the description to its ②
// Cast card, and regenerate ONE card's picture (only after a yes; never "generate all"). Pure: the Cast panel comes in
// as host.cast {items(), set(key, patch), generate(key) -> Promise}. Every change returns an undo().
import { nameWords } from "./assistant.mjs";

const STOPW = new Set(["THE", "A", "AN", "OUR", "THAT", "THIS", "GUY", "ONE"]);
const words = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 '-]/g, " ").split(/\s+/).filter((w) => w && !STOPW.has(w));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const scLabel = (sc) => `Sc ${sc.number || sc.index + 1}`;
const cite = (sc, kind, text, who = null) => ({ scene: sc.number || String(sc.index + 1), where: `${scLabel(sc)} (${sc.heading}) · ${kind}${who ? ` · ${who}` : ""}`, kind, text: String(text).slice(0, 300) });
const mentions = (text, name) => nameWords(name).some((w) => w.length >= 3 && new RegExp(`(?<![A-Za-z])${esc(w)}(?![A-Za-z])`, "i").test(text));

/**
 * Who "the tall stranger" / "reed" / "Dr Reed" is. -> {name, how, cite?} or {candidates: [...]} when unsure.
 * Order: a character's name (exact, part, one typo), then a description in the action ("REED (40s), a tall stranger").
 */
export function resolveCharacter(script, query) {
  const chars = (script?.characters || []).map((c) => c.name);
  const q = words(query);
  if (!q.length) return { candidates: chars };
  const qk = q.join(" ");
  const exact = chars.find((n) => nameWords(n).join(" ") === qk);
  if (exact) return { name: exact, how: "name" };
  const part = chars.filter((n) => q.some((w) => w.length >= 3 && nameWords(n).includes(w)));
  if (part.length === 1) return { name: part[0], how: "name" };
  // A description: the content words of the query in one action line, and the ALL-CAPS name nearest them.
  const desc = q.filter((w) => w.length >= 3);
  let best = null;
  for (const sc of script?.scenes || []) for (const e of sc.elements || []) {
    if (e.type !== "action" || !desc.length) continue;
    const t = String(e.text || "");
    const at = desc.map((w) => t.toUpperCase().search(new RegExp(`(?<![A-Z])${esc(w)}(?![A-Z])`)));
    if (at.some((x) => x < 0)) continue;
    const pos = Math.min(...at);
    for (const n of chars) {
      const m = t.search(new RegExp(`(?<![A-Za-z])${esc(n)}(?![A-Za-z])`));
      if (m < 0) continue;
      const d = Math.abs(m - pos);
      if (!best || d < best.d) best = { name: n, d, cite: cite(sc, "action", t) };
    }
  }
  if (best && best.d < 120) return { name: best.name, how: "description", cite: best.cite };
  return { candidates: part.length ? part : chars };
}

/** Everything the script says about one character: scenes, their lines, the action about them, what others say. */
export function gatherCharacter(script, query) {
  const r = resolveCharacter(script, query);
  if (!r.name) {
    return { tool: "gather_character", ok: false, need: "which", candidates: r.candidates,
      said: r.candidates?.length ? `I can't tell who "${query}" is. Is it ${r.candidates.slice(0, 5).join(", ")}?` : `There's no "${query}" in the script.`,
      observe: `unresolved: ${query}; candidates ${(r.candidates || []).join(", ") || "none"}` };
  }
  const name = r.name, scenes = [], dialogue = [], action = [], others = [];
  for (const sc of script.scenes || []) {
    let here = (sc.characters || []).includes(name);
    for (const e of sc.elements || []) {
      const t = String(e.text || "");
      if (e.type === "dialogue" && e.character === name) { dialogue.push(cite(sc, "dialogue", t)); here = true; }
      else if (e.type === "action" && mentions(t, name)) { action.push(cite(sc, "action", t)); here = true; }
      else if (e.type === "dialogue" && e.character && e.character !== name && mentions(t, name)) others.push(cite(sc, "said by", t, e.character));
    }
    if (here) scenes.push(`${scLabel(sc)}: ${sc.heading}`);
  }
  if (r.cite && !action.some((a) => a.text === r.cite.text)) action.unshift(r.cite);
  const said = `${name}${r.how === "description" ? ` (that's who "${query}" is: ${r.cite.where})` : ""}: ${scenes.length} scene${scenes.length === 1 ? "" : "s"}, ` +
    `${dialogue.length} line${dialogue.length === 1 ? "" : "s"}, ${action.length} action mention${action.length === 1 ? "" : "s"}, ${others.length} said by others.`;
  return { tool: "gather_character", ok: true, kind: "character", name, how: r.how, scenes, dialogue, action, others, said,
    did: [`read all ${(script.scenes || []).length} scenes for ${name}`],
    observe: `${said}\n${[...action, ...others].slice(0, 6).map((c) => `[${c.where}] ${c.text}`).join("\n")}` };
}

// Appearance words the deterministic profile keeps (the action's own adjectives, nothing invented).
const BUILD = /\b(burly|huge|big|giant|hulking|stocky|heavy[- ]?set|broad[- ]shouldered|muscular|wiry|slight|skinny|thin|lanky|tall|short|petite|frail|athletic|portly|gaunt)\b/gi;
const LOOKS = /\b(?:with|has|wearing|wears|in) ([^.;,]{3,80})/gi;
const FACE = /\b(scar[^,.;]*|beard[^,.;]*|stubble|shaved head|bald|grey[- ]haired|gray[- ]haired|red[- ]haired|blonde?|freckled|tattoo[^,.;]*|glasses|eye ?patch|limp)\b/gi;
const AGE = /\((?:early |mid-?|late )?\d{1,2}s?\)/i;

/** A deterministic profile from the gathered words: age, build, look, wardrobe, every bit cited. */
export function profileFallback(g) {
  if (!g?.ok) return null;
  const facts = [], used = [];
  const add = (x, c) => { const v = x.trim().replace(/\s+/g, " "); if (v && !facts.some((f) => f.toLowerCase() === v.toLowerCase())) { facts.push(v); if (!used.includes(c)) used.push(c); } };
  const own = g.action.filter((c) => mentions(c.text, g.name));
  for (const c of own) {
    const sentences = c.text.split(/(?<=[.!?])\s+/);
    const idx = sentences.findIndex((s) => mentions(s, g.name));
    const s = sentences.slice(Math.max(0, idx), idx + 2).join(" ");   // the sentence that names them and the next (He wears…)
    const age = s.match(AGE); if (age) add(age[0].replace(/[()]/g, ""), c);
    for (const m of s.matchAll(BUILD)) add(m[1].toLowerCase(), c);
    for (const m of s.matchAll(FACE)) add(m[1].toLowerCase(), c);
    for (const m of s.matchAll(LOOKS)) for (const bit of m[1].split(/\s+and\s+/)) {
      const b = bit.replace(/^(a|an|the) /i, "").trim();
      if (/\b(apron|coat|jacket|suit|dress|shirt|hat|boots|uniform|hood|glasses|scar|head|beard|hair|tattoo)\b/i.test(b) && !facts.some((f) => f.includes(b.toLowerCase()) || b.toLowerCase().includes(f))) add(b.toLowerCase(), c);
    }
  }
  for (const c of [...g.action, ...g.others]) for (const m of c.text.matchAll(BUILD)) add(m[1].toLowerCase(), c);
  const description = facts.join(", ");
  return { description, facts, cites: used.map((c) => c.where), by: "built-in" };
}

export const PROFILE_SYSTEM = "You are a casting director reading a screenplay. From the quoted lines only, write who this person is on screen. " +
  "Never invent what the lines don't support; leave a field empty instead. Reply with JSON only: {\"description\": \"one line for a reference picture: age, build, face, hair, wardrobe\", " +
  "\"facts\": [\"short facts\"], \"cites\": [\"the Sc N references you used\"], \"note\": \"one creative suggestion, or empty\"}";

/** profile_character: the model (if any), else the built-in read. -> tool result with .profile. */
export async function profileCharacter(g, { llm = null, signal = null } = {}) {
  if (!g?.ok) return { tool: "profile_character", ok: false, said: g?.said || "Gather the character first.", observe: "no gathered evidence" };
  let p = null, by = "built-in", why = "";
  if (llm) {
    const lines = [...g.action, ...g.dialogue.slice(0, 6), ...g.others].slice(0, 18).map((c) => `[${c.where}] ${c.text}`).join("\n");
    try {
      const raw = await llm(PROFILE_SYSTEM, `Character: ${g.name}\nLines:\n${lines}`, { signal });
      const j = JSON.parse(String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/)?.[0] || "null");
      if (j && typeof j.description === "string" && j.description.trim()) {
        p = { description: j.description.trim().slice(0, 400), facts: Array.isArray(j.facts) ? j.facts.map(String).slice(0, 12) : [],
          cites: Array.isArray(j.cites) ? j.cites.map(String).slice(0, 12) : [], note: String(j.note || "").slice(0, 300), by: "model" };
        by = "model";
      } else why = "the model's profile wasn't usable";
    } catch (e) { if (e?.cancelled || signal?.aborted) throw e; why = "the model didn't answer"; }
  }
  if (!p) p = profileFallback(g);
  const empty = !p.description;
  return { tool: "profile_character", ok: !empty, name: g.name, kind: g.kind || "character", profile: p, by,
    said: empty ? `The script says nothing about how ${g.name} looks: tell me and I'll write it on the card.` :
      `${g.name}: ${p.description}${why ? ` (${why}, so I read the lines myself)` : ""}.`,
    observe: empty ? "no appearance facts in the script" : `profile: ${p.description}; cites: ${p.cites.join("; ")}` };
}

/** The ② Cast card for a name: [{key, name, kind}] from host.cast.items(). */
export function findCard(cast, name, kind = null) {
  const items = (() => { try { return cast?.items?.() || []; } catch { return []; } })();
  const k = words(name).join(" ");
  const pool = items.filter((x) => !kind || x.kind === kind);
  return pool.find((x) => words(x.name).join(" ") === k) || pool.find((x) => words(x.name).some((w) => k.split(" ").includes(w) && w.length >= 3)) || null;
}

/** update_* : write a description (and keep the old one for Undo). */
export function updateCard(cast, { name, kind = "character", description }) {
  const card = findCard(cast, name, kind);
  if (!card) return { tool: `update_${kind}`, ok: false, said: `There's no ② Cast card for ${name}.`, observe: `no card: ${name}` };
  if (!cast.set) return { tool: `update_${kind}`, ok: false, said: "The Cast panel isn't open in this App.", observe: "no cast panel" };
  const before = card.description || "";
  const text = String(description || "").trim().slice(0, 600);
  cast.set(card.key, { description: text });
  return { tool: `update_${kind}`, ok: true, key: card.key, said: `Wrote ${card.name}'s description on the ② Cast card: "${text}".`,
    did: [`${card.name}'s card: description "${text}"`],
    observe: `${card.key}.description = "${text}" (was "${before}")`,
    undo: () => cast.set(card.key, { description: before }),
    check: () => { const now = findCard(cast, card.name, kind); return now?.description === text ? { ok: true, said: `${card.name}'s card reads back the new description.` } :
      { ok: false, said: `${card.name}'s card still shows "${now?.description || ""}".` }; } };
}

/** regenerate_* : ONE card's picture, only with confirmed: true (the user's yes). Undo keeps the old picture. */
export async function regenerateCard(cast, { name, kind = "character", confirmed = false }) {
  const tool = `regenerate_${kind}`;
  const card = findCard(cast, name, kind);
  if (!card) return { tool, ok: false, said: `There's no ② Cast card for ${name}.`, observe: `no card: ${name}` };
  if (!confirmed) return { tool, ok: false, needsConfirm: true, said: `Regenerate ${card.name}'s picture? It replaces the current one (one card, on the GPU). Say yes to go.`, observe: "waiting for the user's yes" };
  if (!cast.generate) return { tool, ok: false, said: "This App can't generate pictures here: use ✨ Generate on the card.", observe: "no generator" };
  const before = { ref: card.ref || null, url: card.url || null };
  await cast.generate(card.key);
  return { tool, ok: true, key: card.key, gpu: true, said: `Regenerating ${card.name}'s reference picture (only that card).`, did: [`queued ${card.name}'s picture`],
    observe: `${card.key}: picture regenerated`, undo: () => cast.set?.(card.key, before) };
}

/** gather for a location (a slugline) or a prop: the scenes, the action lines that mention it. */
export function gatherThing(script, query, kind) {
  const q = words(query).join(" ");
  const scenes = [], action = [];
  let name = null;
  for (const sc of script?.scenes || []) {
    const hit = kind === "location" ? words(sc.location).join(" ").includes(q) || q.includes(words(sc.location).join(" ")) :
      (sc.breakdown?.props || []).some((p) => words(p).join(" ") === q || words(p).includes(q));
    const lines = (sc.elements || []).filter((e) => e.type === "action" && new RegExp(`(?<![A-Za-z])${esc(query.replace(/^(the|a|an)\s+/i, ""))}`, "i").test(e.text || ""));
    if (!hit && !lines.length) continue;
    if (!name) name = kind === "location" ? sc.location : query.replace(/^(the|a|an)\s+/i, "");
    scenes.push(`${scLabel(sc)}: ${sc.heading}`);
    if (kind === "location") { const first = (sc.elements || []).find((e) => e.type === "action"); if (first) action.push(cite(sc, "action", first.text)); }
    for (const e of lines) if (!action.some((a) => a.text === e.text)) action.push(cite(sc, "action", e.text));
  }
  if (!name) return { tool: `gather_${kind}`, ok: false, said: `There's no ${kind} "${query}" in the script.`, observe: `unresolved ${kind}: ${query}` };
  const said = `${name}: ${scenes.length} scene${scenes.length === 1 ? "" : "s"}, ${action.length} line${action.length === 1 ? "" : "s"} about it.`;
  return { tool: `gather_${kind}`, ok: true, kind, name, scenes, dialogue: [], action, others: [], said, observe: `${said}\n${action.slice(0, 5).map((c) => `[${c.where}] ${c.text}`).join("\n")}` };
}
