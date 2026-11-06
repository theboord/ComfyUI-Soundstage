// ✦ Ask breaks a scene down the way a director prepares a book (Jon, 2026-11-06: "break down each scene in detail with
// character, prop, location, emotion and tone ... think like a seasoned filmmaker").
//
//   sceneFacts      deterministic: who is in the scene (speaking or only in the action), the props, the place and time.
//                   These come from the script, never from the model, so they can't be invented.
//   SCENE_SYSTEM    how the model reads the numbered scene: what each person wants and hides, the turn, the emotion from
//                   start to end, the tone, what the props mean, what the camera should serve.
//   parseSceneRead  the reading, checked: a citation the scene doesn't hold is dropped, a person who isn't in the scene is
//                   dropped, a prop whose words aren't in the scene is dropped.
// Without a model the card shows the facts and says the reading needs one. Pure: no DOM. tests/js/scenebook.test.mjs.
import { normalizeCharacter } from "../script/parse.mjs";
import { resolveCharacter } from "./charbuild.mjs";

const clip = (s, n = 400) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const uniq = (xs) => [...new Set(xs)];
const sceneNo = (sc) => String(sc.number || sc.index + 1);

/** How many scenes one Ask turn reads: a turn has a 90 s limit and a scene took the model about 30 s on a CPU. */
export const SCENES_PER_TURN = 2;

/** The scene with numbered lines, as the model reads it: "[3] JANE DOE: Coffee?". */
export function sceneLines(sc) {
  const lines = [];
  (sc.elements || []).forEach((e, i) => {
    const t = clip(e.text, 600);
    if (!t || e.type === "character") return;
    lines.push(`[${i + 1}] ${e.type === "dialogue" && e.character ? `${e.character}: ` : ""}${t}`);
  });
  return lines;
}

/** What the script itself says about a scene. -> {scene, heading, location, intExt, time, characters, props} */
export function sceneFacts(script, sc) {
  const text = (sc.elements || []).map((e) => String(e.text || "")).join("\n");
  const names = (script?.characters || []).map((c) => c.name);
  const present = names.filter((n) => (sc.characters || []).includes(n) || (sc.breakdown?.cast || []).map(normalizeCharacter).includes(n)
    || new RegExp(`(?<![A-Za-z])${esc(n)}(?![A-Za-z])`).test(text)
    || new RegExp(`(?<![A-Za-z])${esc(n.toLowerCase().replace(/(^|\s)\w/g, (c) => c.toUpperCase()))}(?![A-Za-z])`).test(text));
  // JANE and JANE DOE are one person in this list
  const people = uniq(present.map((n) => resolveCharacter(script, n)?.name || n));
  return { scene: sceneNo(sc), heading: sc.heading || "", location: sc.location || "", intExt: sc.int_ext || "", time: sc.time || "",
    characters: people, props: uniq((sc.breakdown?.props || []).map(String)) };
}

export const SCENE_SYSTEM = `You are a seasoned film director preparing your director's book for one scene. Read the numbered scene the way a director does, before any camera decision:
- What is this scene for? What would the film lose without it?
- What does each person want right now, what are they hiding, and how do they feel at the start and at the end?
- Where is the turn: the one moment the scene changes direction, or power moves from one person to another?
- What does the audience feel, and what do they know that a character doesn't?
- Which objects carry meaning, not just which objects are present? Who holds them, and when do they change hands?
- What does the place add: is it safe, trapped, public, exposed? What does the time of day do?
- What is the tone in a few exact words (not "dramatic")?
- What must the camera, the light and the cut serve? Give one concrete staging idea and say why.
Base everything on the scene. An interpretation is welcome, and it is your job, but it must rest on a line you cite by its number. Never invent events, backstory or dialogue; if the scene doesn't give something, leave it empty. Use only names and objects in the scene.
Reply with JSON only: {"purpose": {"text": "", "cites": [1]}, "turn": {"text": "", "cites": [1]}, "emotion": {"start": "", "end": "", "cites": [1]}, "tone": "", "characters": [{"name": "", "wants": "", "hides": "", "feels": "", "cites": [1]}], "props": [{"item": "", "means": "", "cites": [1]}], "place": {"text": "", "cites": [1]}, "staging": {"text": "", "why": ""}}`;

/** The model's reading, checked against the scene. -> reading, or null when nothing usable came back. */
export function parseSceneRead(raw, sc, facts) {
  const m = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const count = (sc.elements || []).length;
  const text = (sc.elements || []).map((e) => String(e.text || "")).join("\n").toLowerCase();
  const cites = (c) => uniq((Array.isArray(c) ? c : []).map((x) => parseInt(String(x).replace(/[^\d]/g, ""), 10)).filter((n) => n >= 1 && n <= count)).slice(0, 4);
  const said = (o) => { const t = clip(typeof o === "string" ? o : o?.text); return t ? { text: t, cites: cites(o?.cites) } : null; };
  const names = new Map(facts.characters.map((n) => [n, n]));
  const nameOf = (x) => {
    const n = normalizeCharacter(String(x || ""));
    return names.get(n) || facts.characters.find((c) => c.split(/\s+/).includes(n) || n.split(/\s+/).includes(c)) || null;
  };
  const characters = (Array.isArray(j.characters) ? j.characters : []).map((c) => ({ name: nameOf(c?.name), wants: clip(c?.wants, 240), hides: clip(c?.hides, 240), feels: clip(c?.feels, 240), cites: cites(c?.cites) }))
    .filter((c) => c.name && (c.wants || c.hides || c.feels));
  const props = (Array.isArray(j.props) ? j.props : []).map((p) => ({ item: clip(p?.item, 60), means: clip(p?.means, 240), cites: cites(p?.cites) }))
    .filter((p) => p.item && p.item.toLowerCase().split(/\s+/).some((w) => w.length >= 3 && text.includes(w)));
  const emotion = j.emotion && (j.emotion.start || j.emotion.end) ? { start: clip(j.emotion.start, 220), end: clip(j.emotion.end, 220), cites: cites(j.emotion.cites) } : null;
  const staging = j.staging && (j.staging.text || typeof j.staging === "string") ? { text: clip(j.staging.text ?? j.staging), why: clip(j.staging.why) } : null;
  const read = { purpose: said(j.purpose), turn: said(j.turn), emotion, tone: clip(j.tone, 100), characters, props, place: said(j.place), staging };
  return read.purpose || read.turn || read.emotion || read.tone || characters.length || props.length ? read : null;
}

/** "scene 3", "scenes 4-6", "scene 3 and 5", "every scene" -> {numbers} or {all: true}; null when no scene is named. */
export function scenesAsked(text) {
  const t = String(text || "");
  const r = t.match(/\bscenes?\s+(\d+)\s*(?:-|–|to|through)\s*(\d+)\b/i);
  if (r) { const out = []; for (let n = +r[1]; n <= +r[2] && out.length < 200; n++) out.push(String(n)); return { numbers: out }; }
  const list = [...t.matchAll(/\bscenes?\s+((?:\d+[a-z]?(?:\s*(?:,|and|&)\s*)?)+)/gi)].flatMap((m) => m[1].split(/\s*(?:,|and|&)\s*/)).map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (list.length) return { numbers: list };
  return /\b(?:every|each|all(?: the| of the)?|the whole|whole)\s+(?:script|scenes?|movie|film)\b|\bthe (?:script|screenplay|movie|film)\b|\bscene by scene\b/i.test(t) ? { all: true } : null;
}

const WORD = /\b(?:break\s*(?:it\s+)?down|breakdown|director'?s?\s+(?:book|notes?|read|breakdown)|prep|analy[sz]e|read)\b/i;
const FEEL = /\b(?:emotion|emotional|tone|mood|subtext|the turn|beats?)\b/i;
/** Does this ask for the director's reading of scenes? -> the scenes asked, or null. "break down the script" counts. */
export function breakdownAsked(text) {
  const t = String(text || "");
  const asked = scenesAsked(t);
  if (!asked) return null;
  if (WORD.test(t) && /\bscenes?\b|scene by scene/i.test(t)) return asked;
  if (FEEL.test(t) && /\bscenes?\b/i.test(t)) return asked;
  return /\bbreak\s*(?:it\s+)?down\b.*\b(?:script|screenplay|movie|film)\b.*\b(?:detail|director|emotion|tone)\b/i.test(t) ? asked : null;
}

/**
 * The tool: break the scenes down, up to SCENES_PER_TURN in a turn. llm: as Conversation host.llm, or null for facts only.
 * -> {tool, title, said, did, scenes: [{facts, read, why}], more: "the next order" | null, findings, fixes}
 */
export async function breakDownScenes(script, asked, { llm = null, signal = null } = {}) {
  const base = { tool: "break_down_scene", title: "Director's breakdown", findings: [], fixes: [], scenes: [], more: null };
  const all = script?.scenes || [];
  if (!all.length) return { ...base, said: "There's no script loaded yet: import one in ① Script, then ask again.", did: [] };
  const wanted = asked?.all ? all : all.filter((sc) => (asked?.numbers || []).includes(sceneNo(sc).toUpperCase()));
  if (!wanted.length) return { ...base, said: `There's no scene ${(asked?.numbers || []).join(", ")} in this script: it has ${all.length}.`, did: [] };
  const now = wanted.slice(0, SCENES_PER_TURN);
  const rest = wanted.slice(SCENES_PER_TURN);
  const scenes = [];
  for (const sc of now) {
    const facts = sceneFacts(script, sc);
    let read = null, why = llm ? "" : "no language model is loaded";
    if (llm) {
      try {
        const head = `Scene ${facts.scene}: ${facts.heading}\nPeople in the scene: ${facts.characters.join(", ") || "none named"}\n`;
        read = parseSceneRead(await llm(SCENE_SYSTEM, `${head}${sceneLines(sc).join("\n").slice(0, 3200)}`, { signal, numPredict: 800 }), sc, facts);
        if (!read) why = "the model's reading came back empty or unreadable";
      } catch (e) {
        if (e?.cancelled || signal?.aborted) throw e;
        why = e?.noModel ? String(e.message) : e?.timedOut ? "the language model didn't answer in time" : `the language model failed (${e?.message || e})`;
      }
    }
    scenes.push({ facts, read, why, id: sc.id });
  }
  const label = now.map((s) => sceneNo(s)).join(", ");
  if (rest.length) {
    const nums = rest.slice(0, SCENES_PER_TURN).map((s) => sceneNo(s));
    base.more = `break down scene${nums.length > 1 ? "s" : ""} ${nums.length > 1 && +nums.at(-1) - +nums[0] === nums.length - 1 ? `${nums[0]}-${nums.at(-1)}` : nums.join(", ")}`;
  }
  return { ...base, scenes, more: base.more,
    said: `Scene${now.length > 1 ? "s" : ""} ${label}${rest.length ? `, ${rest.length} more to go` : ""}.`,
    did: [`read scene${now.length > 1 ? "s" : ""} ${label} line by line`, scenes.some((s) => s.read) ? "the language model wrote the reading; citations checked against the scene" : "listed what the script itself says (the reading needs the language model)"],
    limits: rest.length ? `One turn reads ${SCENES_PER_TURN} scenes so it never runs past its time limit.` : "" };
}

/** A scene's breakdown as plain text, for the Director's Book. */
export function sceneNote(s) {
  const f = s.facts, r = s.read;
  const out = [`Location: ${f.location || f.heading}${f.time ? `, ${f.time.toLowerCase()}` : ""}`, `Characters: ${f.characters.join(", ") || "none named"}`];
  if (f.props.length) out.push(`Props: ${f.props.join(", ")}`);
  if (r?.purpose) out.push(`Why this scene: ${r.purpose.text}`);
  if (r?.emotion) out.push(`Emotion: ${r.emotion.start} → ${r.emotion.end}`);
  if (r?.tone) out.push(`Tone: ${r.tone}`);
  if (r?.turn) out.push(`The turn: ${r.turn.text}`);
  for (const c of r?.characters || []) out.push(`${c.name}: ${[c.wants && `wants ${c.wants}`, c.hides && `hides ${c.hides}`, c.feels && `feels ${c.feels}`].filter(Boolean).join("; ")}`);
  for (const p of r?.props || []) if (p.means) out.push(`${p.item}: ${p.means}`);
  if (r?.place) out.push(`The place: ${r.place.text}`);
  if (r?.staging) out.push(`Staging: ${r.staging.text}${r.staging.why ? ` (${r.staging.why})` : ""}`);
  return out.join("\n");
}
