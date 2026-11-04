// ✦ Ask's knowledge of Soundstage (Mike, 2026-11-04: "the AI has to know every single thing about Soundstage… a little
// bit of creativity and a filmmaker's thought"). Offline, no new models:
//   search_docs(query)    BM25 over web/agent/knowledge_index.mjs: the docs, every labelled control, preset, setting,
//                         shortcut and server route (built from the repo by tools/build_knowledge.mjs; a test keeps it fresh)
//   troubleshoot(symptom) a symptom -> cause -> fix playbook, each fix naming the panel and control
//   plan_recipe(intent)   a creative intent (a stunt, a squib, a camera move, an edit) -> Soundstage steps, with the preset
//                         the Director can apply ("Do it for me": the planner's plan, Apply, Undo this)
// SOUNDSTAGE_MAP is the compact map that goes in the system prompt; everything else is retrieved on demand.
// Pure: no DOM. tests/js/knowledge.test.mjs.

export const SOUNDSTAGE_MAP_STEPS = [
  { step: "① Script", for: "Import or write the screenplay (Fountain, FDX, PDF, text); the breakdown lists cast, props, wardrobe, vehicles per scene.", in: "a script file or the sample", out: "scenes, characters, breakdown", next: "② Cast & Locations" },
  { step: "② Cast & Locations", for: "A card per character, prop, wardrobe piece and location: a description and a reference picture (upload, or ✨ Generate with FLUX 3 Klein), used by ④ Frame for consistency.", in: "the script's breakdown", out: "reference pictures", next: "③ Set" },
  { step: "③ Set", for: "Block the scene on a 3D stage: actors (clay figures), cars, props, lights, cameras, physics, stunts, SFX rigs, presets; record camera moves with the phone viewfinder.", in: "a scene", out: "the clay blocking, cameras, shots", next: "④ Frame" },
  { step: "④ Frame", for: "Paint each shot's first frame from the clay with the cast references (FLUX 3 Klein, or Krea 2 under the strict depth lock); Follow the clay sets how closely.", in: "a shot's clay render + references", out: "the shot's frame", next: "⑤ Motion" },
  { step: "⑤ Motion", for: "Render video with LTX-2.5 Layout-to-Render following the clay: a quality preset (Draft…Final), Adherence (Loose · Balanced · Exact), Advanced (LTX) for raw values; Ripple edit and Recast change a real clip.", in: "the frame + the clay animation", out: "takes (draft, final)", next: "⑥ Review" },
  { step: "⑥ Review", for: "Compare takes, approve, re-shoot; Dailies and the Coach flag problems.", in: "takes", out: "approved takes", next: "the Cut, ⑦ Deliver" },
  { step: "⑦ Deliver", for: "The Cut (timeline: trims, transitions, sound), passes (mattes, depth), exports (EDL, XML, FCPXML, OTIO), Collect project.", in: "approved takes", out: "the film and its files", next: "done" },
];

export const SOUNDSTAGE_MAP = `Soundstage map (7 steps, left to right in the App's top row):
${SOUNDSTAGE_MAP_STEPS.map((s) => `${s.step}: ${s.for}`).join("\n")}
Also: the Cut (timeline; right-click a clip → Edit in… to go back to the step that made it), the Director's Book (notes per scene), Presets window (camera moves, lighting, looks, action/stunts/SFX, edit styles, recipes; one click, one Undo), the Coach (advice cards with a one-click fix), "?" (every shortcut).
What you can do yourself: the checks and character tools, plan_stage (set changes and presets: shown as a plan, the user presses Apply, Undo this), add_note. Renders (④ ⑤ ✨ Generate) use the GPU: offer them, the user starts them. Anything else: give the exact clicks (step → panel → control).`;

// ---------------------------------------------------------------- search (BM25)
const STOP = new Set("a an the and or of to in on at for with by from is are be it this that how do i my me can you what why when where which not no into it's its as so if then up out get".split(" "));
const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, "").replace(/(.)\1$/, "$1");
export const tokens = (s) => (String(s || "").toLowerCase().replace(/claymation/g, "clay").match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && w.length > 1).map(stem);

let INDEX = null;
/** Build a BM25 index over chunks [{kind, where, control?, help?, text?}]. */
export function makeIndex(chunks) {
  const docs = chunks.map((c) => {
    const body = [c.control, c.control, c.where, c.help, c.words, c.shortcut, c.text].filter(Boolean).join(" ");
    const tf = new Map();
    for (const t of tokens(body)) tf.set(t, (tf.get(t) || 0) + 1);
    return { c, tf, len: [...tf.values()].reduce((a, b) => a + b, 0) || 1 };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  return { docs, df, avg: docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1) };
}
/** Top k chunks for a query. kinds: limit to these kinds. -> [{...chunk, score}] */
export function search(index, query, { k = 5, kinds = null, minCover = 0 } = {}) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const N = index.docs.length, K1 = 1.2, B = 0.75;
  const scored = [];
  for (const d of index.docs) {
    if (kinds && !kinds.includes(d.c.kind)) continue;
    let s = 0, hit = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      hit++;
      const idf = Math.log(1 + (N - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / index.avg));
    }
    if (s && hit / q.length >= minCover) scored.push({ ...d.c, cover: hit / q.length, score: s * (0.5 + hit / q.length) * (d.c.kind === "doc" ? 1 : 1.15) });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [], seen = new Set();
  for (const x of scored) { const key = `${x.where}|${x.control || x.text?.slice(0, 40)}`; if (!seen.has(key)) { seen.add(key); out.push(x); } if (out.length >= k) break; }
  return out;
}
/** The shipped pack (loaded once, on the first question that needs it). */
export async function knowledge() {
  if (!INDEX) INDEX = makeIndex((await import("./knowledge_index.mjs")).default);
  return INDEX;
}
const chunkLine = (x) => `${x.where}${x.control && x.kind !== "doc" ? ` → ${x.control}` : ""}${x.shortcut ? ` (${x.shortcut})` : ""}: ${x.help || x.text || ""}`.slice(0, 600);

/** search_docs: -> a tool result {tool, title, said, did, hits: [{where, control, text}], findings, fixes} */
export async function searchDocs(query, { k = 5, minCover = 0 } = {}) {
  const hits = search(await knowledge(), query, { k, minCover });
  return { tool: "search_docs", title: "From the Soundstage docs", query, hits: hits.map((x) => ({ kind: x.kind, where: x.where, control: x.control || "", shortcut: x.shortcut || "", text: x.help || x.text || "" })),
    said: hits.length ? `${hits.length} matching section${hits.length === 1 ? "" : "s"} for "${query}".` : `Nothing in the docs or the App's controls matches "${query}".`,
    did: [`searched the docs, every labelled control, preset, setting, shortcut and server route for "${query}"`], findings: [], fixes: [],
    context: hits.map(chunkLine).join("\n") };
}

// ---------------------------------------------------------------- troubleshoot
/**
 * Symptom -> cause -> fix. fix steps name the step and control; do: a command for "Do it for me" (the Director's
 * planner: a plan, Apply, Undo this), only where an App action exists.
 */
export const PLAYBOOK = [
  { id: "clay_not_followed", symptom: "the final render doesn't follow the clay blocking: claymation not locking in, actors drift off their marks, framing changes", words: "clay lock follow final render blocking drift marks positions adherence ignore",
    cause: "⑤ Motion is set to invent (Adherence Loose or Balanced, a softened clay guide or a lighter Layout IC-LoRA), or the ④ frame pulls the shot away from the clay.",
    fix: ["⑤ Motion → Adherence → Exact (a sharp clay guide, the full Layout IC-LoRA, the frame as a lighter look reference).",
      "⑤ Motion → Advanced (LTX): leave Layout IC-LoRA strength and Clay guide blur (px) empty (they follow Adherence) or set IC-LoRA 1.0 and blur 0.",
      "④ Frame → Follow the clay: raise it, so the frame itself matches the clay's poses and framing.",
      "If one moment still drifts: ③ Set, re-key the blocking there (a clearer pose or a slower move), then re-render.",
      "The Coach card on the stage flags shots whose render left the clay; its fix button applies the setting."],
    controls: ["Exact", "Clay guide blur (px)", "Follow the clay"] },
  { id: "cast_drift", symptom: "characters drift or look alike between shots: the face or costume changes, two characters look the same", words: "character face drift consistent costume lookalike same look different shots identity",
    cause: "The shot has no reference picture for that character, or two cards have near-identical descriptions.",
    fix: ["② Cast & Locations: give every character a reference picture (✨ Generate or upload), with a distinct description.",
      "Ask: \"build <name>\" profiles them from the script and flags lookalikes; apply it, then regenerate that card.",
      "④ Frame: check the shot's references row lists the right characters (up to 4 references)."] },
  { id: "camera_clip", symptom: "the camera clips through the set or a wall, the view is cut off or inside geometry", words: "camera clip clipping wall inside through set geometry near cut off",
    cause: "The camera (or its move) passes through set geometry.",
    fix: ["③ Set: select the camera and pull it back out of the geometry, or shorten the move.", "Use a wider lens instead of moving the camera closer.", "Check the move from start to end with the playhead before rendering."],
    do: "move the camera back a little" },
  { id: "render_slow", symptom: "a render is queued, stuck or slow, nothing happens after Render", words: "render queued slow stuck waiting queue nothing happens gpu busy long",
    cause: "The GPU is working through earlier jobs (renders, ✨ Generate, the local model) in ComfyUI's queue; a Final preset takes much longer than a Draft.",
    fix: ["Look at the queue badge in the App's top row: earlier jobs run first.", "⑤ Motion → Quality preset → Draft to look at motion quickly; render Final only for approved shots.", "Ask's local model waits behind renders too: ask when the GPU is idle, or pick an Ollama / API model in ⚙."] },
  { id: "lipsync", symptom: "lip sync is off: mouths don't match the dialogue, audio out of sync", words: "lip sync mouth dialogue audio voice sync talking off",
    cause: "The shot has no voice line attached, the audio is offset in the Cut, or the motion render ignored the audio.",
    fix: ["Performance: attach the line (record or import) to the shot before ⑤ Motion, so LTX renders to it.", "In the Cut, check the clip's audio isn't slipped against its picture.", "Re-render the shot in ⑤ Motion after attaching the voice."] },
  { id: "ask_slow", symptom: "Ask (the assistant) is slow or says the language model is unavailable on the first question", words: "ask assistant slow first load model unavailable cold qwen answer late",
    cause: "The local Qwen loads onto the GPU on the first question (a cold load, up to ~75 s), or waits behind a render.",
    fix: ["Wait for the first answer: later ones are quick while the model stays loaded.", "Pick an Ollama or API model in the Director's ⚙ for instant answers.", "Without a model Ask still runs its built-in checks and how-tos."] },
  { id: "lora_no_effect", symptom: "a LoRA has no effect, the style or character add-on is ignored", words: "lora no effect ignored style add-on character not working",
    cause: "The LoRA was made for another model family (ComfyUI then skips its keys), or its strength is low.",
    fix: ["④ Frame → Style or character add-on: ＋ Add LoRA rows, applied in order; pick under Matches this model, the Other LoRAs list may not work with this model; raise a row's strength.", "⑤ Motion → Advanced (LTX) → LoRAs: ＋ Add LoRA rows, LTX LoRAs only.", "Check ComfyUI's log for \"lora key not loaded\"."], controls: ["Style or character add-on"] },
  { id: "physics", symptom: "physics looks wrong: things float, explode, fall through the floor or the stunt car flips", words: "physics float fall through floor explode jitter crash car flips bake simulate",
    cause: "An unbaked or stale simulation, or a prop without collision.",
    fix: ["③ Set → Physics: bake again after moving things.", "Use a preset from the Presets window → Action (it sets the physics for you).", "Breakable makes crates and boxes come apart; turn it off if props shatter unexpectedly."], controls: ["Breakable"] },
  { id: "frame_off", symptom: "the painted frame doesn't look like the scene, wrong location or style in ④ Frame", words: "frame painted wrong look location style still image doesn't match",
    cause: "No location reference, or Follow the clay is low so the model invents.",
    fix: ["② Cast & Locations: give the location a reference picture.", "④ Frame → Follow the clay: raise it.", "Pick a look in the Presets window → Looks."], controls: ["Follow the clay"] },
];

const pscore = (idx, q) => search(idx, q, { k: 1 })[0]?.score || 0;
/** troubleshoot: the best playbook entries for a symptom. -> tool result */
export function troubleshoot(symptom) {
  const idx = makeIndex(PLAYBOOK.map((p) => ({ kind: "fix", where: p.id, control: p.symptom, help: `${p.words} ${p.cause}` })));
  const top = search(idx, symptom, { k: 2 }).filter((x, i, a) => i === 0 || x.score > a[0].score * 0.8).map((x) => PLAYBOOK.find((p) => p.id === x.where));
  return { tool: "troubleshoot", title: "Troubleshooting", symptom, entries: top,
    said: top.length ? `Most likely: ${top[0].cause}` : `I don't have a fix on file for "${symptom}": I'll look in the docs.`,
    did: [`matched "${symptom}" against ${PLAYBOOK.length} known problems`], findings: [], fixes: [],
    actions: top.filter((p) => p.do).map((p) => ({ label: "Do it for me", command: p.do })) };
}

// ---------------------------------------------------------------- creative recipes
/**
 * Intent -> steps. preset: a Presets-window id the Director can apply (auto: "Do it for me"); without one the steps are
 * clicks. kind tells the persona what film grammar it is.
 */
export const RECIPES = [
  { id: "squib", words: "gunshot wound bullet hit squib shot blood impact shooting", preset: "squib_hit", title: "Gunshot / bullet hits (squib)",
    steps: ["③ Set: select the actor who is hit.", "Presets window → Action → Squib hit: ground squibs walk in to them, then the body squib on the chest (0.12 s apart).", "Move the rigs in ③ Set → SFX if the hits should land elsewhere; play to check the timing.", "④ Frame / ⑤ Motion as usual; the hit is in the clay, the render follows it (Adherence Exact)."],
    craft: "Sell it with the reaction: a cut to a wider shot on the hit, or hold on the face a beat after." },
  { id: "explosion", words: "explosion explode blast car bomb fireball", preset: "car_explosion", title: "Explosion", steps: ["③ Set: select the car (or the building for Building blast).", "Presets window → Action → Car explosion (or Building blast).", "Play to see the blast and the debris; re-bake physics if you move it."], craft: "Cover it from two angles and cut on the flash; keep the actors' reaction for the next shot." },
  { id: "sparks", words: "sparks shower welding electrical", preset: "sparks_shower", title: "Sparks", steps: ["Presets window → Action → Sparks shower.", "Place the rig in ③ Set → SFX."], craft: "Sparks read best against a dark background, backlit." },
  { id: "jturn", words: "j-turn j turn reverse 180 spin car stunt", preset: "reverse_jturn", title: "J-turn", steps: ["③ Set: select the car.", "Presets window → Action → J-turn.", "Play; add a camera from the Presets window → Camera moves."], craft: "A low, wide angle shows the whole turn; a tracking shot sells the speed." },
  { id: "donut", words: "donut doughnut burnout spin car stunt", preset: "donut", title: "Donut", steps: ["③ Set: select the car.", "Presets window → Action → Donut."], craft: "Orbit the camera the other way for more energy." },
  { id: "handbrake", words: "handbrake 180 slide drift car stunt", preset: "handbrake_180", title: "Handbrake 180", steps: ["③ Set: select the car.", "Presets window → Action → Handbrake 180."], craft: "Cut in on the hand on the brake for the beat before." },
  { id: "crash", words: "car crash collision smash crate crash hit", preset: "crate_crash", title: "Crash", steps: ["③ Set: select the car.", "Presets window → Action → Crate crash (a car through crates), or drive it yourself (D) into the object.", "Breakable (③ Set → Physics) makes crates come apart."], craft: "Shoot the impact from a static camera; add Impact shake for the hit." },
  { id: "fall", words: "fall drop falling stunt off ledge", preset: "drop", title: "Fall / drop", steps: ["③ Set: select the actor or object.", "Presets window → Action → Drop."], craft: "Cut on the moment of falling; the landing in a second shot." },
  { id: "fire", words: "fire flames burning", title: "Fire", steps: ["③ Set: the fire set (environment) or a fire SFX rig in ③ Set → SFX.", "④ Frame: describe the fire in the shot so the frame paints it."], craft: "Fire lights the faces: add a warm practical light near it." },
  { id: "glass", words: "breakaway glass window smash shatter bottle", title: "Breakaway glass", steps: ["③ Set → Physics → Breakable for props that shatter.", "Describe the glass in ④ Frame; LTX animates the shatter from the clay hit."], craft: "Glass reads on a backlit, slow-motion insert." },
  { id: "camera", words: "camera move dolly push in pull out orbit crane track handheld", title: "Camera move", steps: ["③ Set: select the shot's camera.", "Presets window → Camera moves (Push in, orbit, crane…), one click per shot.", "Or record it with the phone viewfinder (③ Set → Virtual camera)."], craft: "A push-in lands a thought; a pull-out isolates; handheld for chaos.", auto: "camera" },
  { id: "coverage", words: "coverage shot reverse over the shoulder dialogue two shot", preset: "dialogue_coverage", title: "Dialogue coverage", steps: ["Presets window → Edit styles → Dialogue coverage (a master, singles and overs).", "Render each shot; cut them in the Cut."], craft: "Hold the master for geography, go to singles as the scene gets intimate." },
  { id: "look", words: "look grade color style film noir mood", title: "A look", steps: ["Presets window → Looks: one click sets the colour, light and lens for the shot.", "④ Frame repaints with it."], craft: "Pick the look from the story's tone first, then the light." },
  { id: "match_cut", words: "match cut matching shapes transition", title: "Match cut", steps: ["Frame the two shots so a shape or movement lines up (③ Set: same camera height and lens).", "In the Cut, put them next to each other with a straight cut on the matching moment."], craft: "Match the motion direction, not just the shape." },
  { id: "dissolve", words: "dissolve crossfade fade transition time passing", title: "Dissolve", steps: ["In the Cut, select the cut point between two clips and choose Cross dissolve."], craft: "A dissolve says time passed; keep it to one or two per scene." },
  { id: "jl_cut", words: "j cut l cut audio leads lags split edit", title: "J / L cut", steps: ["In the Cut, trim the audio of a clip past its picture (L) or before it (J)."], craft: "Hear the next scene before you see it (J) to pull the audience forward." },
  { id: "montage", words: "montage music video trailer sequence fast cut", preset: "music_video", title: "Montage", steps: ["Presets window → Edit styles → Music video (or Trailer cut).", "Draft all the shots, then cut to the music in the Cut."], craft: "Cut on the beat, vary the shot sizes." },
  { id: "ripple", words: "ripple edit change wardrobe real clip footage", preset: "ripple_wardrobe", title: "Ripple edit", steps: ["⑤ Motion → Ripple edit: change one thing in a real clip (wardrobe, an object) and the change ripples through the frames.", "Presets window → Recipes → Ripple edit wardrobe walks it through."], craft: "" },
  { id: "reshoot", words: "reshoot re-shoot from the timeline replace in cut edit in", title: "Reshoot from the timeline", steps: ["In the Cut, right-click the clip → Edit in… → Frame / Motion / Set.", "Re-generate, then Replace in cut (one Undo); Back to the cut returns to the clip."], craft: "" },
  { id: "recast", words: "recast swap character replace actor subject", title: "Recast (swap the character)", steps: ["⑤ Motion → Recast on a real clip: pick the character and the engine (LTX-2.5 union control by default).", "The background stays the real footage; only the subject is replaced."], craft: "" },
  { id: "viewfinder", words: "phone viewfinder virtual camera handheld walk ar record camera", title: "Phone viewfinder", steps: ["③ Set → Virtual camera: scan the QR code with your phone.", "Walk AR: walk the room to move the camera; record the move onto the shot."], craft: "Real handheld wobble sells a documentary feel." },
  { id: "record_yourself", words: "record yourself performance act mocap webcam capture me", title: "Record yourself", steps: ["Performance: record yourself with the webcam (or import a clip); the pose drives the clay actor.", "Real performance converts your voice to the character's voice (② Cast → Character Voice)."], craft: "" },
];

/** plan_recipe: the best recipe for an intent. -> tool result with steps and, when a preset does it, a "Do it for me". */
export function planRecipe(intent) {
  const idx = makeIndex(RECIPES.map((r) => ({ kind: "recipe", where: r.id, control: r.title, help: r.words })));
  const best = search(idx, intent, { k: 1 }).map((x) => RECIPES.find((r) => r.id === x.where))[0] || null;
  if (!best) return { tool: "plan_recipe", title: "Plan", intent, said: `I don't have a recipe for "${intent}" yet: I'll look in the docs.`, did: [`matched "${intent}" against ${RECIPES.length} recipes`], findings: [], fixes: [], steps: [] };
  return { tool: "plan_recipe", title: best.title, intent, recipe: best.id, steps: best.steps, craft: best.craft,
    automated: !!best.preset, said: best.preset ? `${best.title}: a preset does the heavy lifting; the steps are below.` : `${best.title}: the steps (clicks: no one-click preset for this yet).`,
    did: [`matched "${intent}" to the ${best.title} recipe`], findings: [], fixes: [],
    actions: best.preset ? [{ label: "Do it for me", command: `apply the ${best.title.split(/[(/]/)[0].trim().toLowerCase()} preset`, preset: best.preset }] : [] };
}
