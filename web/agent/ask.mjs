// Ask: the one assistant, always one click away. A ✦ Ask button pinned in the top row beside Guide and Expand (never
// folded into "⋯"), Cmd/Ctrl+K or "/" anywhere in the App, and a small floating ✦ when the top row is out of sight
// (the App's side panel scrolled, the row folded away). It opens the Director chat (web/agent/directorpanel.mjs):
// there is no second assistant. Ask adds three things to it:
//   1. it knows where you are: the step, the selected object, the shot and the open panel (askContext);
//   2. a question ("how do I make the car crash into the boxes?") gets a step-by-step answer from the recipes below,
//      each step with a "Show me" that lights up the real control (the Guide's spotlight, web/ui/firstrun.mjs Tour),
//      and "Do it for me", which hands a command to the Director: plan, one-click Apply, Undo this;
//   3. it teaches: every answer ends with what to do next from where you are.
// Voice: hold the Ask button (or ` anywhere, as before) and talk; the Director's mic path (browser speech or Whisper on
// the server, both offline-capable) hears it.
// A question no recipe covers goes to the Director's local model (Qwen3.5 4B / Ollama) for a short answer, offline;
// with no model (or the GPU busy) the nearest recipes are offered instead.
//
//   import { mountAsk } from "./agent/ask.mjs";
//   const ask = mountAsk({ root: el, dir: node.ssDirector, host: { context, goStep }, isActive });
//   ask.open(); ask.ask("how do I add rain?"); ask.showMe(recipe, 0); ask.button; ask.fab
import { icon } from "../ui/icons.mjs";
import { Tour } from "../ui/firstrun.mjs";

/** The steps, in order (the step bar's ① to ⑦). */
export const ASK_STEPS = [
  { k: "script", n: "①", label: "Script" }, { k: "cast", n: "②", label: "Cast & Locations" }, { k: "set", n: "③", label: "Set" },
  { k: "frame", n: "④", label: "Frame" }, { k: "motion", n: "⑤", label: "Motion" }, { k: "review", n: "⑥", label: "Review" },
  { k: "deliver", n: "⑦", label: "Deliver" },
];
const STEP_OF = Object.fromEntries(ASK_STEPS.map((s) => [s.k, s]));
const stepName = (k) => (STEP_OF[k] ? `${STEP_OF[k].n} ${STEP_OF[k].label}` : "");

/** Is this a question (or a "teach me"), not an order? Orders go straight to the Director's planner. */
export function isQuestion(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return /^(how|what|where|why|which|when|who|can i|could i|is there|are there|do i|does|should i|explain|teach|help|show me|tell me|walk me|i don'?t (?:know|get|understand)|i'?m (?:lost|stuck|new)|where do i|what'?s next|what now|next step)\b/.test(t);
}

// ---------------------------------------------------------------- the recipes
// Each: id, words (regexes that pick it, the first are the strongest), title, steps [{text, show?}], doIt (a Director
// command, or a function of (text, ctx) -> command; null when it needs your eye), next (recipe ids to teach next).
// show: {step: the step it lives on, sel: a CSS selector of the real control, text: its words, as a fallback}.
// tests/js/ask.test.mjs checks every sel and text against the App's source, so a renamed control fails a test.
const shotN = (ctx) => ctx?.shot?.n || 1;
export const HOWTO = [
  { id: "crash", words: [/\bcrash|smash|plough|plow|ram\b|drive (?:in)?to|through (?:the )?(?:boxes|crates)/, /\b(?:boxes|crates?|crate stack)\b/],
    title: "Make a car crash into a stack of boxes",
    steps: [
      { text: "Go to ③ Set, where the 3D stage is.", show: { step: "set", sel: "[data-step=set]" } },
      { text: "Add the boxes: Add object, type \"crate stack\", press Enter.", show: { step: "set", sel: ".ss-tool[data-tool=add]" } },
      { text: "Select the crates and press Physics in their card; set them to Dynamic so they can fly.", show: { step: "set", sel: ".ss-insp", text: "Physics" } },
      { text: "Select the car and give it a path through the crates: drag it to the start, ◆ Key, move the playhead, drag it past the crates, ◆ Key.", show: { step: "set", sel: ".ss-tltog" } },
      { text: "Press Simulate & bake in the Physics panel: the hit becomes ordinary keys.", show: { step: "set", text: "Simulate & bake" } },
      { text: "Press Play to watch it.", show: { step: "set", text: "^Play$" } },
    ],
    doIt: "Drop a crate stack by the wall and have the car crash through it", next: ["frame", "stunt"] },
  { id: "add", words: [/\b(?:add|put|place|bring in|get) (?!.*\b(?:rain|snow|fog|mist|dust|storm|light|lights|lighting|camera|shot|look|style)\b)(?:a|an|some|the|another)?\s*\w+/, /\bnew (?:object|prop|person|car|actor)\b/],
    title: "Put something on the set",
    steps: [
      { text: "Go to ③ Set.", show: { step: "set", sel: "[data-step=set]" } },
      { text: "Press Add object in the tool rail, type what you want (\"dog\", \"food truck\", \"man on a horse\") and press Enter. Things the library doesn't have are designed by AI.", show: { step: "set", sel: ".ss-tool[data-tool=add]" } },
      { text: "Drag it in the view to place it; its bar has Move, Rotate and Scale.", show: { step: "set", sel: ".ss-stageview" } },
    ],
    doIt: (text) => { const m = /\b(?:add|put|place|bring in|get)\s+((?:a|an|some|the|another)\s+)?(.+?)(?:\s+(?:on|in|to|into) (?:the )?(?:set|stage|scene))?\s*\??$/i.exec(text || ""); return m && m[2] && !/^(it|that|this|something|things?|stuff|objects?)$/i.test(m[2]) ? `add ${m[1] || "a "}${m[2]}` : null; },
    next: ["camera", "light"] },
  { id: "camera", words: [/\b(?:push[- ]?in|pull[- ]?out|dolly|crane|orbit|pan|tilt|tracking|zoom|handheld|camera move|move the camera)\b/, /\bcamera\b|\blens\b|\bangle\b/],
    title: "Move the camera",
    steps: [
      { text: "Pick the shot in the strip (or the scene menu at the top).", show: { step: "set", sel: ".ss-topscene" } },
      { text: "Press Presets (or V) and open Camera moves: hover a card to preview it, click to apply. Every apply is one undo step.", show: { step: "set", sel: ".ss-presetsbtn" } },
      { text: "For a lens or a setup of your own, the Camera tool has the lens cards and + setups.", show: { step: "set", sel: ".ss-tool[data-tool=camera]" } },
    ],
    doIt: (_t, ctx) => `Make shot ${shotN(ctx)} a slow push-in at 50 mm`, next: ["frame", "shot"] },
  { id: "light", words: [/\b(?:light|lighting|lit|night|day ?time|golden hour|sunset|sunrise|dusk|dawn|blue hour|dark|brighter|time of day|sun)\b/],
    title: "Change the light or the time of day",
    steps: [
      { text: "Go to ③ Set.", show: { step: "set", sel: "[data-step=set]" } },
      { text: "Press Lighting in the tool rail: a time of day with a real sun, film lights and classic setups like Rembrandt.", show: { step: "set", sel: ".ss-tool[data-tool=light]" } },
      { text: "Or press Presets (V) → Lighting for one-click looks: golden hour, night street, neon, noir.", show: { step: "set", sel: ".ss-presetsbtn" } },
    ],
    doIt: (text) => (/night|dark/i.test(text || "") ? "make it night" : /golden|sunset|dusk/i.test(text || "") ? "make it golden hour" : null), next: ["weather", "frame"] },
  { id: "weather", words: [/\b(?:rain|raining|snow|fog|foggy|mist|dust|storm|weather|wet)\b/, /\b(?:location|desert|street|interior|water tank|set)\b/],
    title: "Add rain, snow or fog, or change the location",
    steps: [
      { text: "Go to ③ Set.", show: { step: "set", sel: "[data-step=set]" } },
      { text: "Press Set & weather in the tool rail: pick where it happens, then the Elements (rain, snow, fog, dust) and the Amount.", show: { step: "set", sel: ".ss-tool[data-tool=set]" } },
    ],
    doIt: (text) => { const w = /\b(rain|snow|fog|dust)\b/i.exec(text || ""); return w ? `make it ${w[1].toLowerCase() === "rain" ? "rain" : w[1].toLowerCase()}` : null; }, next: ["light", "frame"] },
  { id: "stunt", words: [/\b(?:stunt|j-?turn|donut|drift|handbrake|180|spin out|burnout)\b/],
    title: "Do a car stunt (J-turn, donut, handbrake 180)",
    steps: [
      { text: "Go to ③ Set and click the car to select it.", show: { step: "set", sel: ".ss-stageview" } },
      { text: "Press Presets (V) and open Action: J-turn, donut, handbrake 180. Click one; it writes the car's keys.", show: { step: "set", sel: ".ss-presetsbtn" } },
      { text: "Press Play to watch it, then a racing camera from Camera moves.", show: { step: "set", text: "^Play$" } },
    ],
    doIt: "Use the J-turn stunt", next: ["camera", "frame"] },
  { id: "physics", words: [/\b(?:physics|fall|drop|tumble|knock (?:it |them )?over|topple|bounce|simulate|bake)\b/],
    title: "Make things fall, tumble or get knocked over",
    steps: [
      { text: "Go to ③ Set and click the prop to select it.", show: { step: "set", sel: ".ss-stageview" } },
      { text: "Press Physics in its card and choose Dynamic (Static props stay put but get hit).", show: { step: "set", sel: ".ss-insp", text: "Physics" } },
      { text: "Press Simulate & bake: the whole shot runs once and the motion becomes ordinary keys.", show: { step: "set", text: "Simulate & bake" } },
    ],
    doIt: null, next: ["crash", "frame"] },
  { id: "person", words: [/\b(?:pose|posing|person|people|actor|actress|character|walk|run|wave|sit|arm|hand)\b/, /\b(?:mocap|motion capture|webcam|act it out)\b/],
    title: "Pose a person or give them a performance",
    steps: [
      { text: "Go to ③ Set and click the person.", show: { step: "set", sel: ".ss-stageview" } },
      { text: "Press Person in the tool rail for the pose gallery and every joint, keyed on the timeline.", show: { step: "set", sel: ".ss-tool[data-tool=person]" } },
      { text: "Press Interact to make them look at, talk to, hug or point at someone.", show: { step: "set", sel: ".ss-tool[data-tool=interact]" } },
      { text: "Press Capture motion to copy a real performance from a clip or your webcam.", show: { step: "set", sel: ".ss-tool[data-tool=capture]" } },
    ],
    doIt: null, next: ["camera", "frame"] },
  { id: "build", words: [/\b(?:build|block|describe|make) (?:a |the |me a )?(?:scene|set|stage)\b/, /\bfrom (?:words|text|a description)\b/],
    title: "Build a whole scene from a description",
    steps: [
      { text: "Go to ③ Set.", show: { step: "set", sel: "[data-step=set]" } },
      { text: "Press Build with AI, describe the scene in plain words and press Build scene: cast, set, light and camera are blocked for you.", show: { step: "set", sel: ".ss-tool[data-tool=ai]" } },
      { text: "Or just tell me here, e.g. \"put Mara in the sports car at night, rain, camera on the hood\".", show: null },
    ],
    doIt: null, next: ["camera", "frame"] },
  { id: "frame", words: [/\b(?:first frame|frames?|paint|picture|image|photo ?real|look real|realistic|still)\b/],
    title: "Paint a real-looking first frame from your 3D clay",
    steps: [
      { text: "Go to ④ Frame.", show: { step: "frame", sel: "[data-step=frame]" } },
      { text: "Press Generate frames: the image model paints candidates from your clay.", show: { step: "frame", text: "^Generate frames$" } },
      { text: "Click the candidate you like: it becomes the shot's first frame.", show: null },
    ],
    doIt: (_t, ctx) => `paint frames for shot ${shotN(ctx)}`, next: ["motion"] },
  { id: "motion", words: [/\b(?:animate|motion|video|move(?:ment)?|draft|render|final|ltx|sound)\b/],
    title: "Turn the frame into video",
    steps: [
      { text: "Go to ⑤ Motion.", show: { step: "motion", sel: "[data-step=motion]" } },
      { text: "Make a quick draft first to check the movement.", show: { step: "motion", text: "^Preview motion \\(draft\\)$" } },
      { text: "Happy with it? Render the final with sound.", show: { step: "motion", text: "^Render final \\+ sound$" } },
    ],
    doIt: (_t, ctx) => `render a draft of shot ${shotN(ctx)}`, next: ["review", "deliver"] },
  { id: "shot", words: [/\b(?:new shot|another shot|add a shot|coverage|setup|close-?up|wide shot|over the shoulder|two-?shot|insert|pov)\b/],
    title: "Add another shot (camera setup)",
    steps: [
      { text: "Go to ③ Set and open the timeline's Tracks: the shot strip is under it.", show: { step: "set", sel: ".ss-tltog" } },
      { text: "Press + Shot: a copy of the current camera, or a new angle (Wide, Over-the-shoulder, Close-up, Insert, POV).", show: { step: "set", text: "^\\+ Shot" } },
    ],
    doIt: null, next: ["camera", "frame"] },
  { id: "script", words: [/\b(?:script|screenplay|scenes?|story|fdx|fountain|import (?:a |my )?script)\b/],
    title: "Bring in a script",
    steps: [
      { text: "Go to ① Script: paste or import your screenplay; it splits into scenes with a breakdown.", show: { step: "script", sel: "[data-step=script]" } },
      { text: "Pick a scene in the scene menu at the top on ③ to ⑤ and the stage builds itself.", show: { step: "set", sel: ".ss-topscene" } },
    ],
    doIt: null, next: ["cast", "camera"] },
  { id: "cast", words: [/\b(?:cast|reference|look the same|consistent|character pictures?|location pictures?|wardrobe)\b/],
    title: "Keep characters and places looking the same",
    steps: [
      { text: "Go to ② Cast & Locations: give each character, prop and location a reference picture.", show: { step: "cast", sel: "[data-step=cast]" } },
      { text: "Every frame painted after that uses them.", show: null },
    ],
    doIt: null, next: ["frame"] },
  { id: "review", words: [/\b(?:review|compare|approve|ladder|takes?|dailies)\b/],
    title: "Compare and approve takes",
    steps: [
      { text: "Go to ⑥ Review: clay, frame, draft and final side by side.", show: { step: "review", sel: "[data-step=review]" } },
      { text: "Approve the take you want; the cut uses approved takes first.", show: null },
    ],
    doIt: (_t, ctx) => `approve shot ${shotN(ctx)}`, next: ["deliver"] },
  { id: "deliver", words: [/\b(?:export|deliver|cut|edit|assemble|timeline|nle|premiere|resolve|final video|download)\b/],
    title: "Cut it together and export",
    steps: [
      { text: "Go to ⑦ Deliver: the cut as one video, layers for VFX and an NLE export.", show: { step: "deliver", sel: "[data-step=deliver]" } },
    ],
    doIt: "cut it together with the best takes", next: [] },
  { id: "video", words: [/\b(?:video to (?:3d|stage)|from a (?:video|clip)|import (?:a )?video|my footage|real footage)\b/],
    title: "Turn a video clip into a 3D stage",
    steps: [
      { text: "Go to ③ Set and press Video → Stage in the tool rail (or drop a clip on the stage): the location, the performer and the camera move come back in about a minute.", show: { step: "set", sel: ".ss-tool[data-tool=video]" } },
    ],
    doIt: null, next: ["camera", "frame"] },
  { id: "look", words: [/\b(?:look|style|film stock|grade|colou?r|warmer|cooler|kodak|anamorphic|genre|mood)\b/],
    title: "Give it a film look",
    steps: [
      { text: "On ③ Set, press Look over the view: one click sets the film stock, lens, palette and grade.", show: { step: "set", sel: ".ss-cl-lookbtn" } },
      { text: "Or ask me: \"make the first frame warmer\".", show: null },
    ],
    doIt: "Make the first frame warmer", next: ["frame"] },
  { id: "undo", words: [/\b(?:undo|take (?:it|that) back|go back|revert|mistake|oops)\b/],
    title: "Undo a change",
    steps: [
      { text: "Press Undo in the top row (Cmd/Ctrl+Z). A change I made has its own Undo this under it here.", show: { sel: ".ss-tabs > button[title^=Undo]" } },
    ],
    doIt: null, next: [] },
  { id: "tour", words: [/\b(?:tour|guide|basics|get started|start|beginner|new here|how does (?:this|it) work|overview|lost)\b/],
    title: "The one-minute tour",
    steps: [
      { text: "Press Guide in the top row for a one-minute tour of how a shot gets made: script → set → frame → motion → deliver.", show: { sel: ".ss-guidebtn" } },
      { text: "Or keep asking me, one thing at a time.", show: null },
    ],
    doIt: null, next: ["build", "add"] },
];
const BY_ID = Object.fromEntries(HOWTO.map((r) => [r.id, r]));

/**
 * The recipe a question asks for: {recipe, score} or null. Strong words (the first regex) count 3, the rest 1; a tie
 * goes to the recipe of the step you are on.
 */
export function matchHowto(text, ctx = null) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;
  let best = null;
  for (const r of HOWTO) {
    let score = 0;
    r.words.forEach((re, i) => { if (re.test(t)) score += i === 0 ? 3 : 1; });
    if (!score) continue;
    if (ctx?.step && r.steps.some((s) => s.show?.step === ctx.step)) score += 0.5;
    if (!best || score > best.score) best = { recipe: r, score };
  }
  return best && best.score >= 1 ? best : null;
}

/** The command "Do it for me" hands the Director, or null. */
export function doItCommand(recipe, text, ctx) {
  if (!recipe?.doIt) return null;
  try { return typeof recipe.doIt === "function" ? recipe.doIt(text, ctx) || null : recipe.doIt; } catch { return null; }
}

// ---------------------------------------------------------------- where you are
/**
 * The App state the assistant reads before every answer (and the Director's planner gets as ctx.ui):
 * {step, view, selected: {id, name, kind}|null, shot: {id, name, n}|null, panel: name|null, layout}.
 * host.context() supplies it; anything missing is null.
 */
export function askContext(host) {
  let c = {};
  try { c = host?.context?.() || {}; } catch { c = {}; }
  return { step: c.step || null, view: c.view || null, selected: c.selected || null, shot: c.shot || null,
    panel: c.panel || null, layout: c.layout || null };
}

/** One line for the top of the chat: "You're on ③ Set · shot 2 (Tracking) · Car selected · Physics open". */
export function contextLine(ctx) {
  if (!ctx) return "";
  const parts = [];
  if (ctx.step) parts.push(`You're on ${stepName(ctx.step)}`);
  else if (ctx.view) parts.push(`You're in ${ctx.view[0].toUpperCase()}${ctx.view.slice(1)}`);
  if (ctx.shot) parts.push(`shot ${ctx.shot.n || "?"}${ctx.shot.name && ctx.shot.name !== String(ctx.shot.n) ? ` (${ctx.shot.name})` : ""}`);
  if (ctx.selected) parts.push(`${ctx.selected.name || ctx.selected.kind || "an object"} selected`);
  if (ctx.panel) parts.push(`${ctx.panel} open`);
  return parts.join(" · ");
}

/** The ui part of the Director's ctx (soundstage/agent/director.py context_text reads it). */
export function uiForPlanner(ctx) {
  if (!ctx) return null;
  return { step: ctx.step, selected: ctx.selected ? { id: ctx.selected.id, name: ctx.selected.name, kind: ctx.selected.kind } : null,
    shot: ctx.shot ? { id: ctx.shot.id, n: ctx.shot.n } : null, panel: ctx.panel };
}

/** Teach: up to three next things from where you are, as chips {label, ask} (a question) or {label, command}. */
export function teachNext(ctx, recipe = null) {
  const out = [];
  for (const id of recipe?.next || []) if (BY_ID[id]) out.push({ label: BY_ID[id].title, ask: `how do I ${BY_ID[id].title.toLowerCase()}?` });
  const step = ctx?.step;
  const after = { script: "cast", cast: "set", set: "frame", frame: "motion", motion: "review", review: "deliver" }[step];
  if (!recipe) {
    if (step === "set" && ctx?.selected) out.push({ label: `What can I do with ${ctx.selected.name || "this"}?`, ask: `what can I do with the selected ${ctx.selected.kind || "object"}?` });
    if (step === "set") out.push({ label: "Add something", ask: "how do I add something?" }, { label: "Move the camera", ask: "how do I move the camera?" });
    if (after) out.push({ label: `Next: ${stepName(after)}`, ask: `how do I use ${STEP_OF[after].label}?` });
    if (!step) out.push({ label: "Take the tour", ask: "how does this work?" });
  } else if (after && !out.some((x) => x.label.includes(STEP_OF[after].label))) out.push({ label: `Then: ${stepName(after)}`, ask: `how do I use ${STEP_OF[after].label}?` });
  const seen = new Set();
  return out.filter((x) => !seen.has(x.label) && seen.add(x.label)).slice(0, 3);
}

/** "what can I do with the selected car?" or "how do I use Frame?": a recipe for the selection or the step. */
export function contextRecipe(text, ctx) {
  const t = String(text || "").toLowerCase();
  const stepWord = ASK_STEPS.find((s) => new RegExp(`\\b(?:use|in|on|do on)\\s+(?:the\\s+)?(?:${s.label.toLowerCase().split(" ")[0]})\\b`).test(t));
  if (stepWord) {
    const k = stepWord.k;
    const r = { script: "script", cast: "cast", set: "build", frame: "frame", motion: "motion", review: "review", deliver: "deliver" }[k];
    return BY_ID[r] || null;
  }
  if (/\b(?:selected|this|it)\b/.test(t) && /\bwhat can i do\b/.test(t) && ctx?.selected) {
    const k = ctx.selected.kind || "";
    if (/car|truck|vehicle|bike|boat/.test(k)) return BY_ID.stunt;
    if (/person|man|woman|child|actor/.test(k)) return BY_ID.person;
    return BY_ID.physics;
  }
  if (/\b(?:what(?:'s| is)? next|what now|next step|where do i start|what should i do)\b/.test(t)) {
    const after = { script: "cast", cast: "build", set: "frame", frame: "motion", motion: "review", review: "deliver", deliver: "deliver" }[ctx?.step] || "tour";
    return BY_ID[after] || BY_ID.tour;
  }
  return null;
}

// ---------------------------------------------------------------- Show me: find the real control
const visible = (e) => !!e && e.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
const words = (e) => `${e.textContent || ""} ${e.getAttribute?.("aria-label") || ""}`.replace(/\s+/g, " ").trim();
/**
 * The element a Show me step points at, inside root: by selector (the first visible match; with show.text, the first
 * button inside it whose words match), else the first visible button whose words match show.text. A button folded
 * into the top row's "⋯" points at "⋯" instead (folded: true). -> {el, folded} or null.
 */
export function findControl(root, show) {
  if (!root || !show) return null;
  const re = show.text ? new RegExp(show.text, "i") : null;
  const scope = show.sel ? [...root.querySelectorAll(show.sel)] : [root];
  for (const s of scope) {
    let el = s;
    if (re && show.sel) {
      const inner = [...s.querySelectorAll("button, [role=button], summary")].find((b) => visible(b) && re.test(words(b).trim()));
      el = inner || (visible(s) ? s : null);
    } else if (re) {
      el = [...s.querySelectorAll("button, [role=button], summary")].find((b) => visible(b) && re.test(words(b).trim())) || null;
    }
    if (!el) continue;
    if (el.classList?.contains("ss-ovf")) {
      const more = root.querySelector(".ss-morebtn");
      if (more && visible(more)) return { el: more, folded: true };
    }
    if (visible(el)) return { el, folded: false };
  }
  return null;
}

// ---------------------------------------------------------------- floating fallback geometry (pure)
export const FAB = 40, FAB_GAP = 14;
/**
 * Does the floating ✦ show? When the pinned Ask button cannot be seen: not laid out, folded, or outside the window
 * (the App's side panel scrolled past the top row), while some of the App is on screen and no tour is up.
 */
export function needsFab({ btn, root, vw, vh, folded = false, tour = false }) {
  if (tour || !root || root.width < 2 || root.height < 2) return false;
  const rootOn = root.bottom > 0 && root.top < vh && root.right > 0 && root.left < vw;
  if (!rootOn) return false;
  if (folded || !btn || btn.width < 2 || btn.height < 2) return true;
  return btn.bottom <= 0 || btn.top >= vh || btn.right <= 0 || btn.left >= vw;
}
/** Where it sits (fixed, window px): the bottom-right corner of the part of the App on screen. */
export function fabPos(root, vw, vh) {
  const right = Math.min(root.right, vw), bottom = Math.min(root.bottom, vh);
  const left = Math.max(root.left, 0), top = Math.max(root.top, 0);
  return { left: Math.round(Math.max(left + 4, right - FAB - FAB_GAP)), top: Math.round(Math.max(top + 4, bottom - FAB - FAB_GAP - 40)) };
}

// ---------------------------------------------------------------- the free-form answer (the local model)
export const ASK_SYSTEM = "You are the help assistant inside Soundstage, a film-making app in ComfyUI. Steps: ① Script, ② Cast & Locations, ③ Set (3D stage: tool rail with Build with AI, Add object, Person, Interact, Capture motion, Video → Stage, Photo → 3D, Camera, Set & weather, Lighting; Presets window on V with camera moves, lighting, looks, Action stunts; Physics in an object's card), ④ Frame (Generate frames), ⑤ Motion (draft, then final + sound), ⑥ Review, ⑦ Deliver. Answer the user's question about using the app in 1 to 4 short numbered steps naming the real buttons. If you are unsure, say which step to open. Reply as JSON: {\"answer\": \"one sentence\", \"steps\": [\"...\"], \"command\": \"a short order the app's Director could run, or empty\"}.";

/** Parse the model's reply (JSON, or plain lines). -> {answer, steps, command} or null. */
export function parseAnswer(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const steps = (Array.isArray(j.steps) ? j.steps : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6);
      const answer = String(j.answer || "").trim();
      if (answer || steps.length) return { answer, steps, command: String(j.command || "").trim().slice(0, 200) };
    } catch { /* plain text below */ }
  }
  const lines = s.replace(/<\/?think>/g, "").split(/\n+/).map((x) => x.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean);
  return lines.length ? { answer: lines[0], steps: lines.slice(1, 6), command: "" } : null;
}

// ---------------------------------------------------------------- mount
const CSS = `
.ss-askbtn { gap:5px; }
.ss-askbtn .ss-icon, .ss-askfab .ss-icon { color:var(--ss-accent, #f2ff59); }
.ss-askbtn[aria-pressed=true] .ss-icon { color:inherit; }
.ss-askbtn[data-talk=true], .ss-askfab[data-talk=true] { background:#ff453a !important; color:#fff !important; }
.ss-askfab { position:fixed; z-index:9990; width:${FAB}px; height:${FAB}px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  background:var(--ss-glass-strong, rgba(26,20,31,.94)); color:var(--ss-text, #f0efed); border:1px solid var(--ss-accent-line, rgba(242,255,89,.6));
  box-shadow:0 8px 24px rgba(0,0,0,.45); cursor:pointer; padding:0; }
.ss-askfab[hidden] { display:none !important; }
.ss-askfab:hover { background:var(--ss-raised, #2a2230); }
.ss-dir .ctx { padding:5px 12px; font-size:11.5px; color:var(--ss-muted, #bbb); border-bottom:1px solid var(--ss-line, rgba(255,255,255,.08)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dir .ctx:empty { display:none; }
.ss-dir .msg.how ol { margin:6px 0 4px; padding-left:18px; display:flex; flex-direction:column; gap:5px; }
.ss-dir .msg.how li { line-height:1.35; }
.ss-dir .msg.how li .show { margin-left:6px; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--ss-accent-line, rgba(242,255,89,.5));
  background:transparent; color:var(--ss-accent, #f2ff59); cursor:pointer; vertical-align:baseline; }
.ss-dir .msg.how li .show:hover { background:rgba(242,255,89,.12); }
.ss-dir .msg.how .ttl { font-weight:700; }
`;
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k === "class") e.className = v;
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};

/** Is this keydown the Ask shortcut (Cmd+K on a Mac, Ctrl+K elsewhere)? */
export const isAskKey = (e) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K" || e.code === "KeyK");
const HOLD_MS = 350;

export function mountAsk({ root, dir, host = {}, isActive = () => true }) {
  if (!document.getElementById("ss-ask-css")) document.head.append(h("style", { id: "ss-ask-css" }, CSS));
  const button = dir.button;   // the Director's own top-row button is the Ask button: one assistant, one button
  const fab = h("button", { type: "button", class: "ss-askfab", hidden: true, title: "Ask (Cmd/Ctrl+K): how to do anything, or have it done. Hold to talk.",
    "aria-label": "Ask the assistant" }, icon("sparkles", 18));
  document.body.append(fab);
  const ctxRow = h("div", { class: "ctx", "aria-live": "polite" });
  dir.panel.querySelector("header")?.after(ctxRow);
  let lastCtx = askContext(host);
  const refreshCtx = () => { lastCtx = askContext(host); ctxRow.textContent = contextLine(lastCtx); return lastCtx; };

  // ---- Show me: the Guide's spotlight on the real control, opening its step first.
  let tour = null;
  function showMe(recipe, i = 0) {
    const steps = recipe.steps.filter((s) => s.show);
    if (!steps.length) return false;
    const at = Math.max(0, steps.indexOf(recipe.steps[i]));
    tour?.close(false);
    const ts = steps.map((s, k) => ({
      id: `${recipe.id}_${k}`, title: recipe.title, text: s.text,
      before: async () => { if (s.show.step && lastCtx.step !== s.show.step) { try { await host.goStep?.(s.show.step); } catch { /* step gone */ } refreshCtx(); } },
      target: () => {
        const f = findControl(root, s.show);
        if (f?.folded) tour.text.textContent = `${s.text} (It's in the ⋯ menu: the window is narrow.)`;
        return f?.el || null;
      },
    }));
    tour = new Tour(ts, { root: document.body, font: getComputedStyle(root).fontFamily,
      onEnd: () => { delete root.dataset.tour; tour = null; dir.open(); } });
    root.dataset.tour = "ask";
    tour.start(at);
    return true;
  }

  // ---- the answer card
  function answerCard(recipe, text, ctx) {
    const cmd = doItCommand(recipe, text, ctx);
    const items = recipe.steps.map((s, i) => h("li", {}, s.text, s.show ? h("button", { type: "button", class: "show", title: "Light up this control on the screen",
      on: { click: () => showMe(recipe, i) } }, "Show me") : null));
    const row = h("div", { class: "row" },
      recipe.steps.some((s) => s.show) ? h("button", { type: "button", on: { click: () => showMe(recipe, 0) } }, icon("eye", 13), "Show me, step by step") : null,
      cmd ? h("button", { type: "button", class: "go", title: `I'll plan "${cmd}": you see the plan first, then Apply (one Undo puts it back)`,
        on: { click: () => dir.send(cmd) } }, icon("wand-sparkles", 13), "Do it for me") : null);
    return [h("div", { class: "ttl" }, recipe.title), h("ol", {}, ...items), row];
  }
  function chipsFor(ctx, recipe) {
    return teachNext(ctx, recipe).map((c) => ({ label: c.label, command: c.ask || c.command }));
  }

  // ---- the Director's question hook: questions get an answer; orders go on to the planner.
  async function answer(text) {
    if (!isQuestion(text)) return null;
    const ctx = refreshCtx();
    const m = contextRecipe(text, ctx) ? { recipe: contextRecipe(text, ctx) } : matchHowto(text, ctx);
    if (m) return { cls: "how", nodes: answerCard(m.recipe, text, ctx), chips: chipsFor(ctx, m.recipe) };
    // No recipe: the local model, offline, if one is there and the GPU is free.
    const free = await freeAnswer(text, ctx);
    if (free) {
      const nodes = [h("div", {}, free.answer || "Here's how:"), free.steps.length ? h("ol", {}, ...free.steps.map((s) => h("li", {}, s))) : null];
      if (free.command) nodes.push(h("div", { class: "row" }, h("button", { type: "button", class: "go", on: { click: () => dir.send(free.command) } }, icon("wand-sparkles", 13), "Do it for me")));
      nodes.push(h("div", { class: "meta" }, `answered by ${free.by}`));
      return { cls: "how", nodes, chips: chipsFor(ctx, null) };
    }
    return { cls: "how", nodes: [h("div", {}, "I don't have a recipe for that one yet. Try one of these, or tell me what you want on the set and I'll plan it.")],
      chips: [...teachNext(ctx, null).map((c) => ({ label: c.label, command: c.ask })), { label: "Take the tour", command: "how does this work?" }].slice(0, 4) };
  }
  async function freeAnswer(text, ctx) {
    const d = dir.director;
    try {
      const be = await d.resolvedBackend();
      if (be !== "qwen" && be !== "ollama") return null;
      if (be === "qwen" && await d._gpuBusy()) return null;   // never wait behind a render for a help answer
      const info = await d.info();
      const raw = await d._llm(be, { system: ASK_SYSTEM, prompt: `${contextLine(ctx) || "You're in the App"}.\nQuestion: ${text}`, max_length: 320, model: info.model });
      const p = parseAnswer(raw);
      return p ? { ...p, by: be === "qwen" ? "Qwen3.5 4B (local)" : `Ollama ${d.ollama.model || ""}` } : null;
    } catch { return null; }
  }
  dir.setAnswer(answer);
  dir.setContext(() => uiForPlanner(refreshCtx()));

  // ---- open, the shortcut, hold to talk
  function open() { refreshCtx(); dir.open(); dir.input?.focus(); }
  function ask(text) { open(); return dir.send(text); }
  const wireHold = (b) => {
    let t = 0, held = false;
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      held = false;
      clearTimeout(t);
      t = setTimeout(() => { held = true; b.dataset.talk = "true"; refreshCtx(); dir.startTalk("ask"); }, HOLD_MS);
    });
    const up = () => { clearTimeout(t); if (held) { b.dataset.talk = "false"; dir.stopTalk(); } };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointerleave", up);
    b.addEventListener("pointercancel", up);
    // a hold talks; it is not also a click (that would close the chat it just opened)
    b.addEventListener("click", (e) => { if (held) { e.stopImmediatePropagation(); e.preventDefault(); held = false; } }, true);
  };
  wireHold(button);
  wireHold(fab);
  fab.addEventListener("click", () => { if (dir.isOpen()) dir.close(); else open(); });
  for (const t of ["pointerdown", "wheel"]) fab.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  const onKey = (e) => {
    if (!isAskKey(e) || !root.isConnected || !isActive()) return;
    e.preventDefault(); e.stopPropagation();
    if (dir.isOpen() && dir.panel.contains(document.activeElement)) dir.close(); else open();
  };
  window.addEventListener("keydown", onKey, true);

  // ---- the floating fallback: shown whenever the pinned button can't be seen
  const syncFab = () => {
    if (!root.isConnected) { fab.hidden = true; return; }
    const vw = window.innerWidth, vh = window.innerHeight;
    const rr = root.getBoundingClientRect();
    const br = button.isConnected && button.getClientRects().length ? button.getBoundingClientRect() : null;
    const show = needsFab({ btn: br, root: rr, vw, vh, folded: button.classList.contains("ss-ovf"), tour: !!root.dataset.tour || !!document.querySelector(".ss-tour") });
    fab.hidden = !show;
    if (show) { const p = fabPos(rr, vw, vh); fab.style.left = `${p.left}px`; fab.style.top = `${p.top}px`; }
    fab.setAttribute("aria-pressed", String(dir.isOpen()));
  };
  const timer = setInterval(() => { syncFab(); if (dir.isOpen()) refreshCtx(); }, 400);
  window.addEventListener("scroll", syncFab, true);
  window.addEventListener("resize", syncFab);
  syncFab();

  const destroy = () => {
    clearInterval(timer);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", syncFab, true);
    window.removeEventListener("resize", syncFab);
    tour?.close(false);
    fab.remove(); ctxRow.remove();
  };
  return { button, fab, open, ask, answer, showMe, context: () => refreshCtx(), syncFab, destroy };
}
