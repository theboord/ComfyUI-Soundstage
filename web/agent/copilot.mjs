// ✦ Ask as a co-pilot (docs/assistant.md): "vibe-code the film". A filmmaker persona with a map of the App, strict
// JSON tool calls checked against schemas, a numbered plan you approve ("lock it in"), then an agent loop that runs it:
// think → call a tool → OBSERVE what changed → decide the next step, until done or MAX_STEPS; then a self-check with
// read tools, "What I did", and ONE Undo for the whole plan. Stop works between steps (keep what's done, or undo it).
// Without a language model the same tools run from a deterministic router and plan order.
//
//   const cp = new Copilot(host);                 // host: see HOST below; all optional
//   const r = await cp.turn("build the tall stranger from the script");   // {say, plan?, results, question?, by}
//   const x = await cp.execute({ onStep });       // runs the pending plan -> {log, verified, stopped, undo()}
//   x.undo();                                     // the whole plan back, newest step first
//
// HOST: llm(system, prompt, {signal}) -> text (the Director's backend, whatever it is) · script() · cast {items(),
// set(key, patch), generate(key)} · director {calls(calls, label) -> {ok, said}, order(text) -> {ok, said}, undo()} ·
// stage {toJSON(), select(id)} · quality {get(), set(patch)} · cut {setTransition(edit, type), undo()} ·
// shotLength(seconds) -> previous seconds · knowledge() -> Promise<KnowledgeIndex> · check(name, args) (assistant.mjs).
import { SOUNDSTAGE_MAP, searchDocsResult } from "./knowledge.mjs";
import { gatherCharacter, gatherThing, profileCharacter, updateCard, regenerateCard, findCard, resolveCharacter } from "./castops.mjs";
import { troubleshoot, planRecipe, TROUBLES, RECIPES } from "./playbook.mjs";
import { projectSummary } from "./assistant.mjs";

export const MAX_STEPS = 12;
export const READ_TURNS = 4;    // read tools the model may call before it answers or proposes a plan
export const YES = /^\s*(?:(?:yes|yeah|yep|ok(?:ay)?|sure|great|perfect)[\s,!.]*)?(?:yes|yeah|yep|yup|apply|go|go ahead|do it|run it|confirm|ok(?:ay)?|sure|make it so|lock it(?: in)?|lock in|ship it|looks good|sounds good|that'?s (?:it|good|right)|perfect|please do|yes please)(?:\s+please)?\b[\s.!]*$/i;
export const NO = /^\s*(no|nope|cancel|never ?mind|stop|scrap that|discard|forget it)\b[\s.!]*$/i;

// ---------------------------------------------------------------- the tools and their schemas
const S = (type, extra = {}) => ({ type, ...extra });
const NAME = S("string", { required: true });
/** kind: read (runs at once, no approval) · act (only inside an approved plan) · plan (proposes steps). */
export const TOOLS = {
  search_docs: { kind: "read", doc: "Find a control, preset, setting or how-to in the App and its docs (cites where)", args: { query: NAME } },
  get_project_state: { kind: "read", doc: "The script, cast, shots, the active shot and the quality settings", args: {} },
  get_shot: { kind: "read", doc: "One shot: camera, lens, length, objects, SFX rigs and their cues", args: { shot: S("string") } },
  list_cast: { kind: "read", doc: "The ② Cast cards (characters, props, wardrobe, locations) and which have a description/picture", args: { kind: S("enum", { enum: ["character", "prop", "wardrobe", "location"] }) } },
  list_presets: { kind: "read", doc: "Presets by tab: camera, light, look, action, edit, recipe", args: { tab: S("string") } },
  get_settings: { kind: "read", doc: "⑤ Motion quality: Adherence, Layout IC-LoRA strength, Follow the clay, Draft/Final", args: {} },
  analyze_script: { kind: "read", doc: "Summary, scenes, beats and issues of the screenplay", args: { scenes: S("array") } },
  check_cast: { kind: "read", doc: "Duplicate / near-duplicate characters", args: { scenes: S("array") } },
  check_props: { kind: "read", doc: "Breakdown props that are really set dressing, wardrobe, vehicles", args: { scenes: S("array") } },
  check_locations: { kind: "read", doc: "Duplicate or overlapping locations", args: { scenes: S("array") } },
  gather_character: { kind: "read", doc: "Everything the script says about a character (fuzzy: 'the tall stranger'), with citations", args: { name: NAME } },
  gather_location: { kind: "read", doc: "Everything the script says about a location", args: { name: NAME } },
  gather_prop: { kind: "read", doc: "Everything the script says about a prop", args: { name: NAME } },
  troubleshoot: { kind: "plan", doc: "Symptom -> cause -> fix (fixes become plan steps)", args: { symptom: NAME } },
  plan_recipe: { kind: "plan", doc: "Concrete steps for a stunt, practical effect, coverage pattern, edit technique, Recast, phone viewfinder, record yourself", args: { intent: NAME } },
  profile_character: { kind: "act", doc: "Write who the character is on screen from the gathered lines", args: { name: NAME } },
  profile_location: { kind: "act", doc: "Write the location's look from the script", args: { name: NAME } },
  profile_prop: { kind: "act", doc: "Write the prop's look from the script", args: { name: NAME } },
  update_character: { kind: "act", doc: "Set a character's ② Cast description ('$profile' = the last profile)", args: { name: NAME, description: NAME } },
  update_location: { kind: "act", doc: "Set a location's ② Cast description", args: { name: NAME, description: NAME } },
  update_prop: { kind: "act", doc: "Set a prop's ② Cast description", args: { name: NAME, description: NAME } },
  regenerate_character: { kind: "act", confirm: true, gpu: true, doc: "Regenerate ONE character card's picture (asks first; never all)", args: { name: NAME } },
  regenerate_location: { kind: "act", confirm: true, gpu: true, doc: "Regenerate ONE location card's picture", args: { name: NAME } },
  regenerate_prop: { kind: "act", confirm: true, gpu: true, doc: "Regenerate ONE prop card's picture", args: { name: NAME } },
  stage_order: { kind: "act", doc: "Any set change in words, through the Director's planner (add/move objects, block action, weather, lights, ram, drive)", args: { command: NAME } },
  select_shot: { kind: "act", doc: "Work on a shot (1 = first in the strip, or its name)", args: { shot: S("string", { required: true }) } },
  select_object: { kind: "act", doc: "Select a person or object on the set by name", args: { name: NAME } },
  add_shot: { kind: "act", doc: "A new camera setup: wide, medium, close, over the shoulder, POV, high/low angle…", args: { setup: NAME } },
  apply_preset: { kind: "act", doc: "A preset by name or id (camera move, light, look, action stunt/SFX, edit style)", args: { name: NAME } },
  set_stunt: { kind: "act", doc: "A car stunt: reverse_jturn, donut, handbrake_180", args: { stunt: S("enum", { required: true, enum: ["reverse_jturn", "donut", "handbrake_180", "none"] }) } },
  add_sfx_rig: { kind: "act", doc: "A practical effect: squib / gunshot wound, explosion, glass, fire, sparks, smoke (on someone, at a time in s)", args: { rig: NAME, on: S("string"), at: S("number", { min: 0, max: 60 }) } },
  camera: { kind: "act", doc: "The active shot's camera: lens_mm, move (push_in, pull_out, truck_left, truck_right, crane_up, crane_down, orbit_left, orbit_right, static), speed, rig", args: {
    lens_mm: S("number", { min: 8, max: 400 }), move: S("enum", { enum: ["push_in", "pull_out", "truck_left", "truck_right", "crane_up", "crane_down", "orbit_left", "orbit_right", "static"] }),
    speed: S("enum", { enum: ["slow", "medium", "fast"] }), rig: S("enum", { enum: ["tripod", "dolly", "steadicam", "handheld", "drone", "crane"] }) } },
  shot_length: { kind: "act", doc: "The active shot's length in seconds (2-10)", args: { seconds: S("number", { required: true, min: 2, max: 10 }) } },
  set_quality: { kind: "act", doc: "⑤ Motion: adherence Loose/Balanced/Exact, ic_lora 0-1.2, follow_clay 0.55-1, preset Draft/Final/Hollywood", args: {
    adherence: S("enum", { enum: ["Loose", "Balanced", "Exact"] }), ic_lora: S("number", { min: 0, max: 1.2 }), follow_clay: S("number", { min: 0.55, max: 1 }),
    preset: S("enum", { enum: ["Draft", "Final", "Hollywood"] }) } },
  assemble_cut: { kind: "act", doc: "Cut the scene together: each shot's best take, strip order", args: {} },
  add_transition: { kind: "act", doc: "A transition on an edit (1 = between shots 1 and 2): dissolve, dip_black, dip_white, wipe", args: {
    edit: S("number", { required: true, min: 0, max: 400 }), type: S("enum", { enum: ["dissolve", "dip_black", "dip_white", "wipe"] }) } },
};
export const TOOL_LIST = Object.keys(TOOLS);

/** Check one call against its schema; coerce "3" -> 3, "exact" -> "Exact". -> {ok, call, error} */
export function validateCall(c) {
  if (!c || typeof c !== "object") return { ok: false, error: "a call must be an object {name, args}" };
  const name = String(c.name || c.tool || "");
  const t = TOOLS[name];
  if (!t) return { ok: false, error: `unknown tool "${name}" (tools: ${TOOL_LIST.join(", ")})` };
  const args = c.args && typeof c.args === "object" && !Array.isArray(c.args) ? { ...c.args } : {};
  for (const k of Object.keys(args)) if (!t.args[k]) delete args[k];
  for (const [k, s] of Object.entries(t.args)) {
    let v = args[k];
    if (v === undefined || v === null || v === "") { if (s.required) return { ok: false, error: `${name}: "${k}" is required` }; delete args[k]; continue; }
    if (s.type === "number") { v = Number(v); if (!Number.isFinite(v)) return { ok: false, error: `${name}: "${k}" must be a number` }; if ((s.min != null && v < s.min) || (s.max != null && v > s.max)) return { ok: false, error: `${name}: "${k}" must be ${s.min}-${s.max}` }; }
    else if (s.type === "enum") { const m = s.enum.find((e) => e.toLowerCase() === String(v).toLowerCase().replace(/[\s-]+/g, "_") || e.toLowerCase() === String(v).toLowerCase()); if (!m) return { ok: false, error: `${name}: "${k}" must be one of ${s.enum.join(", ")}` }; v = m; }
    else if (s.type === "array") { v = Array.isArray(v) ? v.map(String) : [String(v)]; }
    else v = String(v).slice(0, 400);
    args[k] = v;
  }
  return { ok: true, call: { name, args, ...(c.say || c.why ? { say: String(c.say || c.why).slice(0, 200) } : {}) } };
}

/** The model's JSON turn: {say?, question?, options?, call?, plan?: [calls], done?}. -> {ok, step, error} */
export function parseStep(raw) {
  const s = String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "no JSON object in the reply" };
  let j;
  try { j = JSON.parse(m[0]); } catch (e) { return { ok: false, error: `invalid JSON (${e.message})` }; }
  const step = { say: String(j.say || j.reply || "").slice(0, 900), question: String(j.question || "").slice(0, 300), done: !!j.done };
  if (Array.isArray(j.options)) step.options = j.options.map(String).slice(0, 4);
  if (j.call) { const v = validateCall(j.call); if (!v.ok) return { ok: false, error: v.error }; step.call = v.call; }
  if (Array.isArray(j.plan) && j.plan.length) {
    step.plan = [];
    for (const c of j.plan.slice(0, MAX_STEPS)) { const v = validateCall(c); if (!v.ok) return { ok: false, error: `plan step ${step.plan.length + 1}: ${v.error}` }; step.plan.push(v.call); }
  }
  if (!step.say && !step.question && !step.call && !step.plan && !step.done) return { ok: false, error: "empty turn: give say, question, call or plan" };
  return { ok: true, step };
}

// ---------------------------------------------------------------- the persona
export const COPILOT_SYSTEM = `You are ✦ Ask, the co-pilot inside Soundstage: a collaborative director, DP and editor. You know every part of the App (map below; search_docs finds the rest and says where it is).
How you work:
- Think like a filmmaker. When a request is vague about intent ("make it better", "a scary shot"), ask ONE sharp creative question, with 2-4 options.
- Offer film-grammar options with a short why (a low wide for power, a J-cut to pull us forward, a squib + the actor's reaction sells a hit).
- Stay grounded in what Soundstage can do; when something can only be clicked, give the click-steps and say where.
- Be honest: never claim an action you didn't take. A change only happens through a tool call in an approved plan.
- To change anything, propose a numbered plan of tool calls ("plan"); the user approves it, then you run it step by step, seeing each result. Read tools (search_docs, get_*, list_*, gather_*) you may call at once with "call".
- Regenerating a picture uses the GPU: one card only, and only in a plan the user approved. Never generate everything.
Reply with ONE JSON object only, no prose around it:
{"say": "to the user", "question": "", "options": [], "call": {"name": "...", "args": {}}, "plan": [{"name": "...", "args": {}, "say": "why this step"}], "done": false}
Use only the fields you need.

${SOUNDSTAGE_MAP}

TOOLS (name {args}: what):
${Object.entries(TOOLS).map(([n, t]) => `${n} {${Object.entries(t.args).map(([k, s]) => `${k}${s.required ? "" : "?"}${s.enum ? `: ${s.enum.join("|")}` : ""}`).join(", ")}} [${t.kind}]: ${t.doc}`).join("\n")}`;

export const EXEC_SYSTEM = `You are running a plan the user approved, one tool call per reply. After each call you see what it did (OBSERVATION). Decide the next call from what you observed: fix a failed step once with different arguments, or skip it and say so. Use read tools (get_shot, get_settings, list_cast…) to check your work. Only the approved plan's tools may change anything.
Reply with JSON only: {"call": {"name": "...", "args": {}}} for the next step, or {"done": true, "say": "what you did, honestly"} when the goal is met.`;

// ---------------------------------------------------------------- the deterministic router (no model)
const BUILD_CHAR = /^\s*(?:please\s+|can you\s+|could you\s+|let'?s\s+)?(build|make|create|design|cast|profile|describe|flesh out|write up)\s+(?:me\s+|up\s+)?(.{2,40}?)\s*(\bfrom the (?:script|screenplay)\b|\bcharacter\b)?\s*[.!?]?\s*$/i;
const HOWTO = /^\s*(how (?:do|can|would|should) i|how to|what'?s the best way to|teach me|show me how)\b/i;
const WHERE_IS = /^\s*(where(?:'s| is| are| do i find)|what (?:does|is) (?:the )?)\s*(.+?)\??$/i;
/** shot 3, Reed -> the variables recipes take. */
export function slots(text, script = null) {
  const t = String(text || "");
  const shot = t.match(/\bshot\s+(\d+|[a-z]\b)/i)?.[1] || null;
  const chars = (script?.characters || []).map((c) => c.name);
  const who = chars.find((n) => new RegExp(`(?<![A-Za-z])${n.split(/\s+/)[0]}(?![A-Za-z])`, "i").test(t)) || t.match(/\bon\s+([A-Z][a-z]+)\b/)?.[1] || null;
  const stunt = /j-?turn/i.test(t) ? "reverse_jturn" : /donut/i.test(t) ? "donut" : /handbrake|180/i.test(t) ? "handbrake_180" : null;
  const edit = Number(t.match(/\b(?:edit|cut|between shots?)\s+(\d+)/i)?.[1] || 1);
  return { shot, who, stunt, edit };
}

/** -> {kind: "plan"|"answer"|"read", ...} or null (not the co-pilot's: Ask's other paths take it). */
export function route(text, { script = null } = {}) {
  const t = String(text || "").trim();
  if (!t) return null;
  const v = slots(t, script);
  const sym = TROUBLES.find((x) => x.match.test(t));
  if (sym && !HOWTO.test(t)) return { kind: "plan", via: "troubleshoot", args: { symptom: t }, vars: v };
  const b = t.match(BUILD_CHAR);
  if (b && script?.scenes?.length && !/\b(shot|set|stage|scene \d|it|sure)\b/i.test(b[2]) && (b[3] || /^(build|profile|describe|flesh out|cast)$/i.test(b[1])) &&
      (b[3] || resolveCharacter(script, b[2]).name)) {
    const name = b[2].replace(/^(the|a|an)\s+/i, "the ").trim();
    const kind = /\b(location|place|set)\b/i.test(t) ? "location" : /\bprop\b/i.test(t) ? "prop" : "character";
    if (kind === "character") return { kind: "plan", via: "build_character", name, vars: v };
  }
  if (RECIPES.some((r) => r.match.test(t)) && (HOWTO.test(t) || /\b(i want|add|give|put|make|re-?block|cover|do|rig|stage|cut|let'?s)\b/i.test(t))) return { kind: "plan", via: "plan_recipe", args: { intent: t }, vars: v };
  const w = t.match(WHERE_IS);
  if (w || /\b(search|find|where)\b.*\b(control|setting|slider|button|docs?)\b/i.test(t)) return { kind: "read", call: { name: "search_docs", args: { query: (w?.[2] || t).replace(/\b(control|setting|slider|button)\b/gi, "").trim() } } };
  return null;
}

/** Recipes Ask's step-by-step how-tos (web/agent/ask.mjs HOWTO, with Show me) don't cover, or cover wrongly. */
export const BEYOND_HOWTO = new Set(["j_cut", "l_cut", "dissolve", "assemble", "coverage3", "shot_reverse", "recast", "viewfinder", "record_yourself", "gunshot_wound", "chase"]);
/** Should a how-to question that also matches an Ask how-to recipe go to the co-pilot? */
export function beatsHowto(text, script = null) {
  const r = route(text, { script });
  if (!r) return false;
  if (r.via !== "plan_recipe") return true;
  const p = planRecipe(text);
  return p.ok && (p.recipes.length > 1 || BEYOND_HOWTO.has(p.recipes[0]));
}

/** Turn the router's choice into tool results + a proposed plan. */
async function routed(cp, r) {
  if (r.kind === "read") { const x = await cp.run(r.call); return { say: x.said, results: [x], by: "built-in" }; }
  if (r.via === "troubleshoot" || r.via === "plan_recipe") {
    const x = r.via === "troubleshoot" ? troubleshoot(r.args.symptom, r.vars) : planRecipe(r.args.intent, r.vars);
    const out = { say: x.said + (x.why && r.via === "troubleshoot" ? ` ${x.why}` : ""), results: [x], by: "built-in" };
    if (x.clicks?.length) out.clicks = x.clicks;
    const steps = (x.plan || []).map((s) => validateCall({ name: s.tool, args: s.args, say: s.say })).filter((v) => v.ok).map((v) => v.call);
    if (steps.length) out.plan = cp.propose(steps, x.title || r.args.symptom || r.args.intent);
    return out;
  }
  if (r.via === "build_character") {
    const g = await cp.run({ name: "gather_character", args: { name: r.name } });
    if (!g.ok) return { say: g.said, question: g.need ? g.said : "", options: g.candidates?.slice(0, 4), results: [g], by: "built-in" };
    const steps = [
      { name: "profile_character", args: { name: g.name }, say: "Write who they are on screen from those lines" },
      { name: "update_character", args: { name: g.name, description: "$profile" }, say: `Put it on ${g.name}'s ② Cast card` },
    ];
    return { say: `${g.said} Here's the plan: profile ${g.name} from those lines, then write it on the card. After that I can regenerate just ${g.name}'s picture (I'll ask first).`,
      results: [g], plan: cp.propose(steps, `Build ${g.name} from the script`), by: "built-in" };
  }
  return null;
}

// ---------------------------------------------------------------- the co-pilot
let planSeq = 0;
export class Copilot {
  constructor(host = {}) { this.host = host; this.reset(); }
  reset() { this.history = []; this.pending = null; this.lastProfile = null; this.confirmRegen = null; this.lastRun = null; this._stop = false; }
  remember(role, text) { if (text) { this.history.push({ role, text: String(text).slice(0, 600) }); if (this.history.length > 20) this.history.splice(0, this.history.length - 20); } }

  /** A plan waiting for approval. */
  propose(steps, title) { this.pending = { id: `plan_${++planSeq}`, title: String(title || "Plan").slice(0, 120), steps }; return this.pending; }
  stop() { this._stop = true; }

  _shots() { try { const st = this.host.stage?.toJSON?.(); return (this.host.shots?.() || st?.shots || []).map((s) => ({ id: s.id, name: s.name || s.id })); } catch { return []; } }
  _shotId(x) {
    const shots = this._shots(), s = String(x ?? "").trim();
    if (/^\d+$/.test(s)) return shots[+s - 1]?.id || null;
    return shots.find((h) => h.id === s || String(h.name).toLowerCase() === s.toLowerCase())?.id || null;
  }
  _catalog() { return this.host.catalog?.() || this._kidx?.catalog || null; }
  _presetId(name) {
    const ps = this._catalog()?.presets || [];
    const n = String(name || "").toLowerCase().replace(/[\s-]+/g, "_");
    const hit = ps.find((p) => p.id === n) || ps.find((p) => p.label.toLowerCase() === String(name).toLowerCase()) ||
      ps.find((p) => p.words.some((w) => w.toLowerCase() === String(name).toLowerCase())) || ps.find((p) => p.label.toLowerCase().includes(String(name).toLowerCase()));
    return hit?.id || (ps.length ? null : n);   // no catalog loaded (tests): pass the id through
  }
  async _director(calls, label) {
    const d = this.host.director;
    if (!d?.calls) return { ok: false, said: "The set isn't loaded here.", observe: "no director" };
    const r = await d.calls(calls, label);
    return { ok: r.ok !== false, said: r.said || label, observe: r.said || label, undo: r.ok !== false ? () => d.undo?.() : null };
  }

  /** Run ONE validated call. -> {tool, ok, said, observe, undo?, check?} */
  async run(call, { signal = null } = {}) {
    const { name } = call, a = { ...call.args };
    const H = this.host, script = H.script?.() || null;
    try {
      switch (name) {
        case "search_docs": { this._kidx = this._kidx || (await H.knowledge?.()); return searchDocsResult(this._kidx, a.query); }
        case "get_project_state": {
          const st = H.stage?.toJSON?.() || {}, q = H.quality?.get?.() || null;
          const obs = `${projectSummary(script, { shots: this._shots(), max: 900 })}\nActive shot: ${st.active_shot || "none"}\nQuality: ${q ? JSON.stringify(q) : "unknown"}`;
          return { tool: name, ok: true, said: "Read the project.", observe: obs };
        }
        case "get_shot": {
          const st = H.stage?.toJSON?.();
          if (!st) return { tool: name, ok: false, said: "The set isn't loaded.", observe: "no stage" };
          const id = a.shot ? this._shotId(a.shot) : st.active_shot;
          const sh = (st.shots || []).find((s) => s.id === id) || null;
          const rigs = (st.actors || []).filter((x) => x.sfx).map((x) => ({ name: x.name, kind: String(x.kind).replace(/^sfx_?/, ""), at: x.sfx?.trigger?.at ?? null }));
          const facts = { shot: id, name: sh?.name || id, lens_mm: sh?.camera_keys?.[0]?.focal_mm ?? null, seconds: st.shot ? +((st.shot.frames || 97) / (st.shot.fps || 24)).toFixed(1) : null,
            objects: (st.actors || []).filter((x) => !x.sfx).map((x) => x.name), rigs, presets: (st.preset_log || []).filter((e) => e.shot === id).map((e) => e.id), selected: st.selected || null };
          return { tool: name, ok: !!sh || !!id, said: `Read ${facts.name}.`, observe: JSON.stringify(facts), facts };
        }
        case "list_cast": {
          const items = (H.cast?.items?.() || []).filter((x) => !a.kind || x.kind === a.kind);
          return { tool: name, ok: true, said: `${items.length} cards.`, observe: items.map((x) => `${x.kind}: ${x.name}${x.description ? ` "${x.description.slice(0, 60)}"` : " (no description)"}${x.url ? " [picture]" : ""}`).join("\n") || "no cards" };
        }
        case "list_presets": {
          this._kidx = this._kidx || (await H.knowledge?.().catch(() => null));
          const ps = (this._catalog()?.presets || []).filter((p) => !a.tab || p.tab === a.tab || p.kind.toLowerCase().includes(String(a.tab).toLowerCase()));
          return { tool: name, ok: true, said: `${ps.length} presets.`, observe: ps.map((p) => `${p.id} (${p.label}): ${p.summary.slice(0, 70)}`).join("\n") };
        }
        case "get_settings": { const q = H.quality?.get?.(); return q ? { tool: name, ok: true, said: "Read ⑤ Motion's settings.", observe: JSON.stringify(q), facts: q } : { tool: name, ok: false, said: "⑤ Motion isn't loaded.", observe: "no settings" }; }
        case "analyze_script": case "check_cast": case "check_props": case "check_locations": {
          const r = H.check?.(name, a);
          return r ? { ...r, ok: true, observe: `${r.said} ${(r.findings || []).map((f) => f.why).slice(0, 6).join("; ")}` } : { tool: name, ok: false, said: "No script is loaded.", observe: "no script" };
        }
        case "gather_character": { const g = gatherCharacter(script, a.name); if (g.ok) this.lastGather = g; return g; }
        case "gather_location": case "gather_prop": { const g = gatherThing(script, a.name, name.slice(7)); if (g.ok) this.lastGather = g; return g; }
        case "profile_character": case "profile_location": case "profile_prop": {
          const kind = name.slice(8);
          const g = this.lastGather?.kind === kind && this.lastGather.name.toLowerCase() === String(a.name).toLowerCase() ? this.lastGather :
            kind === "character" ? gatherCharacter(script, a.name) : gatherThing(script, a.name, kind);
          const p = await profileCharacter(g, { llm: H.llm || null, signal });
          if (p.ok) this.lastProfile = p.profile.description;
          return { ...p, tool: name };
        }
        case "update_character": case "update_location": case "update_prop": {
          const d = /^\$profile$/i.test(a.description) ? this.lastProfile : a.description;
          if (!d) return { tool: name, ok: false, said: "There's no profile to write yet.", observe: "no profile" };
          return updateCard(H.cast, { name: a.name, kind: name.slice(7), description: d });
        }
        case "regenerate_character": case "regenerate_location": case "regenerate_prop":
          return regenerateCard(H.cast, { name: a.name, kind: name.slice(11), confirmed: !!call.confirmed });
        case "stage_order": {
          const d = H.director;
          if (!d?.order) return { tool: name, ok: false, said: "The set isn't loaded here.", observe: "no director" };
          const r = await d.order(a.command, { signal });
          return { tool: name, ok: r.ok !== false, said: r.said || a.command, observe: r.said || a.command, undo: r.ok !== false && r.undoable !== false ? () => d.undo?.() : null };
        }
        case "select_shot": {
          const id = this._shotId(a.shot);
          if (!id) return { tool: name, ok: false, said: `There's no shot ${a.shot} (${this._shots().length} shots).`, observe: `no shot ${a.shot}; shots: ${this._shots().map((s, i) => `${i + 1}=${s.name}`).join(", ")}` };
          const r = await this._director([{ tool: "select_shot", args: { shot: id }, plan: `I'll work on shot ${a.shot}.` }], `select shot ${a.shot}`);
          return { ...r, tool: name, check: () => (H.stage?.toJSON?.()?.active_shot === id ? { ok: true, said: `Shot ${a.shot} is active.` } : { ok: false, said: `Shot ${a.shot} isn't the active shot.` }) };
        }
        case "select_object": {
          const st = H.stage?.toJSON?.();
          const words = String(a.name).toLowerCase().split(/\s+/);
          const hit = (st?.actors || []).find((x) => String(x.name).toLowerCase() === String(a.name).toLowerCase()) || (st?.actors || []).find((x) => words.some((w) => w.length > 2 && String(x.name).toLowerCase().includes(w)));
          if (!hit || !H.stage?.select) return { tool: name, ok: false, said: `${a.name} isn't on the set.`, observe: `not on set: ${a.name}; on set: ${(st?.actors || []).map((x) => x.name).join(", ")}` };
          const prev = st.selected ?? null;
          H.stage.select(hit.id);
          return { tool: name, ok: true, said: `Selected ${hit.name}.`, observe: `selected ${hit.id} (${hit.name})`, undo: () => H.stage.select(prev) };
        }
        case "add_shot": return { ...(await this.run({ name: "stage_order", args: { command: `add a ${a.setup} shot` } }, { signal })), tool: name };
        case "apply_preset": {
          if (!this._catalog()) this._kidx = this._kidx || (await H.knowledge?.().catch(() => null));
          const id = this._presetId(a.name);
          if (!id) return { tool: name, ok: false, said: `There's no preset called "${a.name}".`, observe: `no preset "${a.name}" (list_presets shows them)` };
          const r = await this._director([{ tool: "preset", args: { preset: id }, plan: `I'll apply ${id}.` }], `preset ${id}`);
          const sid = H.stage?.toJSON?.()?.active_shot;
          return { ...r, tool: name, preset: id, check: () => ((H.stage?.toJSON?.()?.preset_log || []).some((e) => e.id === id && (!sid || e.shot === sid)) ? { ok: true, said: `${id} is on the shot.` } : { ok: false, said: `${id} isn't in the shot's preset log.` }) };
        }
        case "set_stunt": return { ...(await this.run({ name: "apply_preset", args: { name: a.stunt } }, { signal })), tool: name };
        case "add_sfx_rig": {
          const k = String(a.rig).toLowerCase();
          const preset = /squib|gun|bullet|wound|blood|shot/.test(k) ? "squib_hit" : /car|explo|mortar|fireball/.test(k) ? "car_explosion" : /build|wall|blast/.test(k) ? "building_blast" : /spark/.test(k) ? "sparks_shower" : null;
          if (a.on) { const s = await this.run({ name: "select_object", args: { name: a.on } }); if (!s.ok) return { ...s, tool: name }; }
          const r = preset ? await this.run({ name: "apply_preset", args: { name: preset } }, { signal }) : await this.run({ name: "stage_order", args: { command: `add a ${a.rig}${a.on ? ` on ${a.on}` : ""}${a.at != null ? ` at ${a.at} s` : ""}` } }, { signal });
          const want = preset === "squib_hit" ? /squib/ : new RegExp(k.split(/\s+/)[0]);
          return { ...r, tool: name, check: () => {
            const rigs = (H.stage?.toJSON?.()?.actors || []).filter((x) => x.sfx && want.test(String(x.kind)));
            return rigs.length ? { ok: true, said: `${rigs.length} ${a.rig} rig${rigs.length === 1 ? "" : "s"} on the set (cue ${rigs.map((x) => x.sfx?.trigger?.at).join(", ")} s).` } : { ok: false, said: `No ${a.rig} rig on the set after the step.` };
          } };
        }
        case "camera": {
          const calls = [];
          if (a.lens_mm) calls.push({ tool: "lens", args: { mm: a.lens_mm }, plan: `I'll put on a ${a.lens_mm} mm lens.` });
          if (a.rig) calls.push({ tool: "rig", args: { type: a.rig }, plan: `I'll rig the camera on a ${a.rig}.` });
          if (a.move) calls.push({ tool: "camera_move", args: { move: a.move, speed: a.speed || "medium" }, plan: `I'll ${a.move.replace("_", " ")}.` });
          if (!calls.length) return { tool: name, ok: false, said: "Say a lens, a move or a rig.", observe: "nothing to change" };
          return { ...(await this._director(calls, "camera")), tool: name };
        }
        case "shot_length": {
          if (!H.shotLength) return { tool: name, ok: false, said: "Set it on ③ Set's Length slider.", observe: "no shot-length hook" };
          const before = H.shotLength(a.seconds);
          return { tool: name, ok: true, said: `The shot is ${a.seconds} s long now.`, observe: `length ${a.seconds} s (was ${before})`, undo: () => H.shotLength(before) };
        }
        case "set_quality": {
          const q = H.quality;
          if (!q?.set) return { tool: name, ok: false, said: "⑤ Motion isn't loaded: set it there (Adherence, Draft/Final).", observe: "no quality hook" };
          const before = q.get?.() || {};
          const patch = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
          q.set(patch);
          const words = Object.entries(patch).map(([k, v]) => `${{ adherence: "Adherence", ic_lora: "Layout IC-LoRA strength", follow_clay: "Follow the clay", preset: "Quality" }[k]} ${v}`).join(", ");
          return { tool: name, ok: true, said: `⑤ Motion: ${words}.`, observe: `set ${JSON.stringify(patch)} (was ${JSON.stringify(Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])))})`,
            undo: () => q.set(Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]]))),
            check: () => { const now = q.get?.() || {}; const bad = Object.entries(patch).filter(([k, v]) => now[k] !== v); return bad.length ? { ok: false, said: `${bad.map(([k, v]) => `${k} reads ${now[k]}, not ${v}`).join("; ")}.` } : { ok: true, said: `Read back: ${words}.` }; } };
        }
        case "assemble_cut": return { ...(await this._director([{ tool: "cut", args: {}, plan: "I'll cut the scene together." }], "assemble the cut")), tool: name };
        case "add_transition": {
          if (!H.cut?.setTransition) return { tool: name, ok: false, said: "Open ⑥ Review › Cut: the Transitions palette, then click the edit.", observe: "no cut hook" };
          H.cut.setTransition(a.edit, a.type || "dissolve");
          return { tool: name, ok: true, said: `${(a.type || "dissolve").replace("_", " ")} on edit ${a.edit}.`, observe: `transition ${a.type || "dissolve"} @ edit ${a.edit}`, undo: () => H.cut.undo?.() };
        }
        case "troubleshoot": return troubleshoot(a.symptom, slots(a.symptom, script));
        case "plan_recipe": return planRecipe(a.intent, slots(a.intent, script));
        default: return { tool: name, ok: false, said: `I can't do ${name} yet.`, observe: `unknown tool ${name}` };
      }
    } catch (e) {
      if (e?.cancelled || signal?.aborted) throw e;
      return { tool: name, ok: false, said: `${name} didn't work: ${e?.message || e}`, observe: `error: ${e?.message || e}` };
    }
  }

  _ctx(text) {
    const h = this.history.slice(-10).map((m) => `${m.role === "user" ? "User" : "Ask"}: ${m.text}`).join("\n");
    const script = this.host.script?.();
    return `${h ? `Conversation so far:\n${h}\n\n` : ""}The project now:\n${projectSummary(script, { shots: this._shots(), max: 1400 })}\n${this.host.where?.() ? `${this.host.where()}\n` : ""}\nUser: ${text}`;
  }

  /** Ask the model; on invalid JSON re-ask ONCE with the error, then give up (null: the caller falls back). */
  async _ask(system, prompt, { signal = null } = {}) {
    let raw = await this.host.llm(system, prompt, { signal });
    let p = parseStep(raw);
    if (p.ok) return { step: p.step, reasked: false };
    raw = await this.host.llm(system, `${prompt}\n\nYour last reply was not valid: ${p.error}. Reply again with ONE JSON object that follows the format.`, { signal });
    p = parseStep(raw);
    return p.ok ? { step: p.step, reasked: true } : { step: null, error: p.error, reasked: true };
  }

  /**
   * One user turn. -> {say, question?, options?, results, plan?, clicks?, approved?, by, why?} or null (not ours).
   * approved: the user said yes to the pending plan: call execute() next.
   */
  async turn(text, { signal = null } = {}) {
    text = String(text || "").trim();
    if (this.confirmRegen && YES.test(text)) {
      const c = this.confirmRegen; this.confirmRegen = null;
      const r = await this.run({ ...c, confirmed: true }, { signal });
      this.remember("user", text); this.remember("assistant", r.said);
      return { say: r.said, results: [r], by: "built-in", undo: r.undo || null };
    }
    if (this.pending && YES.test(text)) { this.remember("user", text); return { approved: true, plan: this.pending, say: `Running "${this.pending.title}".`, results: [], by: "built-in" }; }
    if (this.pending && NO.test(text)) { this.pending = null; this.remember("user", text); return { say: "Dropped that plan. Nothing changed.", results: [], by: "built-in" }; }
    const script = this.host.script?.() || null;
    // A direct "regenerate X's picture": one card, and only after a yes.
    const rg = text.match(/\b(?:re-?generate|re-?do|re-?make)\b\s+(?:the\s+)?(?:picture|image|ref(?:erence)?|card)?\s*(?:of|for)?\s*([A-Za-z][\w' ]{1,40}?)(?:'s)?\s*(?:picture|image|card|ref(?:erence)?)?\s*$/i);
    if (rg && !/\b(all|every|everyone|everything)\b/i.test(text) && findCard(this.host.cast, rg[1])) {
      const card = findCard(this.host.cast, rg[1]);
      const call = { name: `regenerate_${["location", "prop"].includes(card.kind) ? card.kind : "character"}`, args: { name: card.name } };
      const r = await this.run(call, { signal });
      if (r.needsConfirm) this.confirmRegen = call;
      this.remember("user", text); this.remember("assistant", r.said);
      return { say: r.said, results: [], by: "built-in", question: r.needsConfirm ? r.said : "" };
    }
    if (/\b(?:re-?)?generate (?:them )?all\b|\bgenerate every(?:one|thing)?\b/i.test(text)) {
      return { say: "I regenerate one card at a time, after you OK it (each one is a GPU job). Which card first? Or use ② Cast's own Generate all missing button.", results: [], by: "built-in" };
    }
    this.pending = null;
    this.remember("user", text);
    let why = "";
    if (this.host.llm) {
      try {
        const results = [];
        let prompt = this._ctx(text);
        for (let i = 0; i <= READ_TURNS; i++) {
          if (signal?.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
          const a = await this._ask(COPILOT_SYSTEM, prompt, { signal });
          if (!a.step) { why = `the model's answer wasn't valid JSON for the tools twice (${a.error})`; break; }
          const s = a.step;
          if (s.call && TOOLS[s.call.name].kind !== "act" && i < READ_TURNS) {
            const r = await this.run(s.call, { signal });
            results.push(r);
            prompt += `\n\nYou called ${s.call.name} ${JSON.stringify(s.call.args)}.\nOBSERVATION: ${String(r.observe || r.said).slice(0, 1500)}`;
            if (TOOLS[s.call.name].kind === "plan" && r.ok && !s.plan) {   // a troubleshoot / recipe result: its fixes are the plan
              const steps = r.plan.map((x) => validateCall({ name: x.tool, args: x.args, say: x.say })).filter((v) => v.ok).map((v) => v.call);
              const out = { say: s.say || r.said, results, by: "model", plan: steps.length ? this.propose(steps, r.title) : null, clicks: r.clicks };
              this.remember("assistant", out.say);
              return out;
            }
            continue;
          }
          const plan = s.plan || (s.call ? [s.call] : null);   // an act call outside a plan becomes a one-step plan you approve
          const out = { say: s.say, question: s.question, options: s.options, results, by: "model", reasked: a.reasked };
          if (plan?.length) out.plan = this.propose(plan, s.say || text);
          this.remember("assistant", [s.say, s.question].filter(Boolean).join(" "));
          return out;
        }
        if (!why) why = "the model kept reading without answering";
      } catch (e) {
        if (e?.cancelled || signal?.aborted) throw e;
        why = e?.noModel ? String(e.message) : e?.timedOut ? "the language model didn't answer in time" : `the language model failed (${e?.message || e})`;
      }
    }
    const r = route(text, { script });
    if (!r) { this.history.pop(); return why ? { fallback: true, why } : null; }
    const out = await routed(this, r);
    if (!out) return null;
    if (why) out.why = why;
    this.remember("assistant", out.say);
    return out;
  }

  /**
   * Run the approved plan as an agent loop. With a model: each step it sees the plan and every OBSERVATION and picks the
   * next call (a read to check, a retry with other args once, or done). Without: the plan in order. Then the checks.
   * onStep({i, call, result, log}) after every step. -> {log, verified, failed, stopped, undo(), said}
   */
  async execute({ signal = null, onStep = null } = {}) {
    const plan = this.pending;
    if (!plan) return { log: [], verified: [], failed: [], stopped: false, undo: () => [], said: "There's no plan waiting." };
    this.pending = null;
    this._stop = false;
    const allowed = new Set(plan.steps.map((s) => s.name));
    const log = [], undos = [], checks = [];
    const retried = new Set();
    let next = 0, steps = 0, stopped = false, modelOff = !this.host.llm, verifyRound = false, finalSay = "";
    const stopNow = () => this._stop || signal?.aborted;
    const runOne = async (call) => {
      if (TOOLS[call.name].kind === "act" && !allowed.has(call.name)) return { tool: call.name, ok: false, said: `${call.name} isn't in the plan you approved.`, observe: `refused: ${call.name} is not in the approved plan` };
      return this.run({ ...call, confirmed: !!TOOLS[call.name].confirm }, { signal });   // the plan's approval is the yes
    };
    let verified = [];
    for (let pass = 0; pass < 2; pass++) {
      verifyRound = pass === 1;
      while (steps < MAX_STEPS) {
        if (stopNow()) { stopped = true; break; }
        let call = null, done = false;
        if (!modelOff) {
          try {
            const obs = log.map((l, i) => `${i + 1}. ${l.call.name} ${JSON.stringify(l.call.args)} -> ${l.result.ok ? "OK" : "FAILED"}: ${String(l.result.observe || l.result.said).slice(0, 500)}`).join("\n");
            const prompt = `Goal: ${plan.title}\nApproved plan:\n${plan.steps.map((s, i) => `${i + 1}. ${s.name} ${JSON.stringify(s.args)}${s.say ? ` (${s.say})` : ""}`).join("\n")}\n\n` +
              `OBSERVATIONS so far:\n${obs || "none yet"}${verifyRound ? `\n\nSELF-CHECK FAILED: ${verified.filter((c) => !c.ok).map((c) => c.said).join("; ")}. Fix it, or finish and say so honestly.` : ""}\n\nNext step?`;
            const a = await this._ask(`${EXEC_SYSTEM}\n\nTOOLS:\n${TOOL_LIST.join(", ")}`, prompt, { signal });
            if (!a.step) modelOff = true;
            else if (a.step.done) { done = true; finalSay = a.step.say || finalSay; }
            else if (a.step.call) call = a.step.call;
            else modelOff = true;
          } catch (e) { if (e?.cancelled || signal?.aborted) { stopped = true; break; } modelOff = true; }
        }
        if (done) break;
        if (modelOff) { if (verifyRound || next >= plan.steps.length) break; call = plan.steps[next]; }
        if (stopNow()) { stopped = true; break; }
        const result = await runOne(call);
        const lastFail = log.length && !log[log.length - 1].result.ok && retried.has(next) ? log.length - 1 : null;
        if (lastFail != null) result.retryOf = lastFail;
        steps++;
        log.push({ call, result });
        if (result.undo) undos.push(result.undo);
        if (result.ok && result.check) checks.push({ call, check: result.check });
        const idx = plan.steps.findIndex((s, i) => i >= next && s.name === call.name);
        if (result.ok && idx >= 0) next = idx + 1;
        else if (!result.ok && (modelOff || retried.has(next))) { if (idx >= 0) next = idx + 1; }   // honest: recorded as failed, move on
        else if (!result.ok) retried.add(next);                                                   // the model gets one retry
        onStep?.({ i: steps, call, result, log });
        if (modelOff && next >= plan.steps.length) break;
      }
      // Self-check: every act that can read itself back (the newest check per tool and args wins).
      verified = [];
      if (stopped) break;
      const latest = new Map();
      for (const c of checks) latest.set(`${c.call.name}${JSON.stringify(c.call.args)}`, c);
      for (const c of latest.values()) { try { verified.push({ call: c.call, ...c.check() }); } catch (e) { verified.push({ call: c.call, ok: false, said: `couldn't check ${c.call.name}: ${e.message}` }); } }
      if (!verified.some((v) => !v.ok) || modelOff || steps >= MAX_STEPS) break;
    }
    const failed = log.filter((l, i) => !l.result.ok && !log.slice(i + 1).some((m) => m.result.ok && m.result.retryOf === i)).map((l) => l.result.said);
    const groupUndo = () => { const done = []; for (const u of [...undos].reverse()) { try { u(); done.push(true); } catch { done.push(false); } } undos.length = 0; return done; };
    const did = log.filter((l) => l.result.ok && TOOLS[l.call.name].kind === "act").map((l) => l.result.said);
    const bad = verified.filter((v) => !v.ok);
    const said = stopped ? `Stopped after ${log.length} of ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}. Keep what's done, or Undo it.` :
      `${finalSay || (did.length ? `Done: ${did.length} change${did.length === 1 ? "" : "s"}.` : "Nothing changed.")}${failed.length ? ` ${failed.length} step${failed.length === 1 ? "" : "s"} failed: ${failed.join(" ")}` : ""}${bad.length ? ` Self-check found a problem: ${bad.map((b) => b.said).join(" ")}` : ""}`;
    const out = { plan, log, did, verified, failed, stopped, undo: groupUndo, canUndo: () => undos.length > 0, said };
    this.lastRun = out;
    this.remember("assistant", `(ran "${plan.title}") ${said}`);
    return out;
  }
}
