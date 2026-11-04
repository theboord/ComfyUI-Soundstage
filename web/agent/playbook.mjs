// ✦ Ask's playbook (docs/assistant.md): troubleshoot(symptom) -> cause and fix, plan_recipe(intent) -> concrete steps.
// A step is either a tool call Ask can run ({tool, args}: web/agent/copilot.mjs TOOLS) or a click-step ({click}: where
// the control is, so the user does it). Pure data + a matcher: no model needed. The model may still pick the entry.

/** Symptom -> cause -> fix. Fix steps with a tool become a plan the user can approve; the rest are click-steps. */
export const TROUBLES = [
  { id: "clay_not_followed", title: "The final render doesn't follow the clay",
    match: /\b(clay|blocking|claymation|marks?|positions?)\b.*\b(won'?t|doesn'?t|not|isn'?t|never|drift\w*|ignor\w*|lock\w*|follow\w*)\b|\b(won'?t|doesn'?t|not)\b.*\b(lock|follow)\w*\b.*\b(clay|final|render)\b|\bdrift\w*\b.*\b(final|render)\b/i,
    cause: "⑤ Motion's Adherence is below Exact (a softer clay guide, a lighter Layout IC-LoRA), the shot renders with MiniMax H3 (follows clay loosely), or a strong first frame pulls the shot off its marks.",
    fixes: [
      { say: "Set Adherence to Exact (sharp clay guide, full Layout IC-LoRA, lighter frame reference)", tool: "set_quality", args: { adherence: "Exact" } },
      { say: "Layout IC-LoRA strength at 1.0", tool: "set_quality", args: { ic_lora: 1.0 } },
      { say: "Use the engine that follows the clay: ⑤ Motion › Engine › LTX-2.5 Layout-to-Render", click: "⑤ Motion › Engine" },
      { say: "Re-render a Draft first to check the blocking before the Final", tool: "set_quality", args: { preset: "Draft" } },
    ] },
  { id: "lookalikes", title: "Two characters look alike",
    match: /\b(look\w* (?:alike|the same|identical)|same face|lookalike|can'?t tell (?:them|who)|twins?)\b/i,
    cause: "Their ② Cast cards have thin or similar descriptions (or no reference picture), so ④ Frame paints a default face for both.",
    fixes: [
      { say: "Check the cast for duplicates first", tool: "check_cast", args: {} },
      { say: "Give each one a distinct description from the script (age, build, hair, wardrobe)", tool: "gather_character", args: { name: "$who" } },
      { say: "Regenerate only the card that's wrong (you confirm first)", click: "② Cast › the card › ✨ Regenerate" },
    ] },
  { id: "camera_clips", title: "The camera clips through the set",
    match: /\b(camera|lens|shot)\b.*\b(clip\w*|inside|through|in the wall|behind the wall)\b/i,
    cause: "The camera key sits inside a wall or prop, or a move (push in, crane, orbit) carries it through geometry.",
    fixes: [
      { say: "Reframe a little wider", tool: "stage_order", args: { command: "pull the camera back a little" } },
      { say: "Hold the camera still (no move) to find where it clips", tool: "camera", args: { move: "static" } },
      { say: "Drag the camera in ③ Set › Camera view and set a new key", click: "③ Set › Camera" },
    ] },
  { id: "slow_render", title: "Renders are slow or stuck in the queue",
    match: /\b(slow|queued|stuck|takes? (?:forever|ages)|waiting|hang\w*)\b.*\b(render|queue|draft|final|gpu)\b|\b(render|queue)\b.*\b(slow|stuck|queued)\b/i,
    cause: "Something else is on the ComfyUI queue, the quality is Final/Hollywood (many steps, 1080p+), or a model is loading for the first time.",
    fixes: [
      { say: "See every job, its node and time left: the Activity pill (top row)", click: "Top row › Activity" },
      { say: "Iterate on Draft (8 + 3 steps), go Final once the blocking is right", tool: "set_quality", args: { preset: "Draft" } },
      { say: "A first render after start-up loads the models: it's faster after that", click: "" },
    ] },
  { id: "lipsync", title: "Lip sync is off",
    match: /\b(lip ?sync|lips?|mouth)\b.*\b(off|wrong|late|early|out of sync|doesn'?t match|drift)\b|\bout of sync\b/i,
    cause: "The dialogue clip and the picture aren't aligned in the Cut, or the take was rendered without the line's audio (draft has no sound).",
    fixes: [
      { say: "Render Final + sound for the speaking shot (dialogue drives the mouth)", click: "⑤ Motion › Final + sound" },
      { say: "Slip the dialogue clip on A1 by a few frames in the Cut", click: "⑥ Review › Cut › the dialogue clip (drag)" },
      { say: "Judge the talking pass by eye", click: "⑥ Review › Passes › Talking" },
    ] },
  { id: "lora_no_effect", title: "A LoRA has no effect",
    match: /\blora\b.*\b(no effect|nothing|doesn'?t|not working|ignored|does nothing)\b/i,
    cause: "The LoRA is for another base model (④ Frame lists it under 'Other LoRAs (may not work with this model)'), or its strength is low.",
    fixes: [
      { say: "Pick a LoRA under 'Matches this model' (FLUX 3 Klein, or Krea 2 Turbo under the Strict depth lock)", click: "④ Frame › Style or character add-on" },
      { say: "Raise its strength and regenerate one frame", click: "④ Frame › add-on strength" },
    ] },
  { id: "ask_slow", title: "Ask is slow to answer the first time",
    match: /\b(ask|assistant|you|model)\b.*\b(slow|takes? (?:long|ages|forever)|first (?:time|answer|load))\b/i,
    cause: "The local model loads onto the GPU on its first answer (about 40 s cold); later answers take seconds. Behind a running render it waits for the queue, so Ask plans with Ollama or the rules instead.",
    fixes: [
      { say: "Pick the backend in ✦ Ask › ⚙ (Ollama answers while a render runs)", click: "✦ Ask › ⚙ › Backend" },
    ] },
  { id: "depth_ghosts", title: "Ghost objects in the frame (Strict depth lock)",
    match: /\b(ghost|phantom|extra object|something that isn'?t there)\b/i,
    cause: "Lock to the stage depth on Strict paints every depth edge, including hidden helpers.",
    fixes: [{ say: "Set Lock to the stage depth to Light or Off and repaint the frame", click: "④ Frame › Lock to the stage depth" }] },
  { id: "video_to_3d", title: "Video → 3D set doesn't match the clip",
    match: /\bvideo ?(?:→|->|to) ?(?:3d|stage)\b.*\b(wrong|match|off|bad)\b/i,
    cause: "Known limit (CHANGELOG, flaws first): the Video → 3D benchmark baseline is MATCH ~21/100; layouts are approximate.",
    fixes: [{ say: "Use ↻ Regenerate or Fix this object on the wrong piece, then adjust by hand", click: "③ Set › Video → Stage › Fix this object" }] },
];

/** Recipes: an intent -> concrete steps. tool steps run (after you approve the plan); click steps say where to go. */
export const RECIPES = [
  { id: "gunshot_wound", title: "A gunshot wound / bullet hit on a performer", match: /\b(gunshot|gun ?shot|bullet|shot (?:in|on) the|squib|blood ?pack|wound|gets shot)\b/i,
    why: "On set it's a squib: a small charge under the costume and a blood pack. Bullet hits walk up to the performer, then the body hit, and the actor sells it.",
    steps: [
      { say: "Go to the shot", tool: "select_shot", args: { shot: "$shot" } },
      { say: "Select the performer", tool: "select_object", args: { name: "$who" } },
      { say: "Rig the squib hit (bullet hits, then the body squib)", tool: "apply_preset", args: { name: "squib_hit" } },
      { say: "Cue time and blood pack size: the rig's card", click: "③ Set › the SFX rig's card › cue (s)" },
    ] },
  { id: "explosion", title: "An explosion", match: /\b(explo\w*|blow (?:it )?up|fireball|blast)\b/i,
    why: "A mortar under the car (or charges at a breakaway wall), a cue a beat after the shot settles, and the camera shake a beat after the hit.",
    steps: [
      { say: "Rig the car explosion", tool: "apply_preset", args: { name: "car_explosion" } },
      { say: "Camera jolts with the hit", tool: "apply_preset", args: { name: "impact_shake" } },
    ] },
  { id: "glass", title: "Breakaway glass", match: /\b(glass|window smash|through the window)\b/i, why: "Sugar glass on a cue: it shatters where it's hit.",
    steps: [{ say: "Add a breakaway glass rig", tool: "stage_order", args: { command: "add breakaway glass" } }, { say: "Set its cue", click: "③ Set › the SFX rig's card › cue (s)" }] },
  { id: "fire", title: "Fire", match: /\b(fire|flames?|burn\w*)\b/i, why: "A fire bar or flame rig; light it from the flames' side (warm, flickering).",
    steps: [{ say: "Add a fire rig", tool: "stage_order", args: { command: "add a fire" } }, { say: "Warm flicker light", click: "③ Set › Lighting" }] },
  { id: "sparks", title: "Sparks", match: /\bsparks?\b/i, why: "A gerb overhead pours sparks for three seconds.",
    steps: [{ say: "Rig the sparks shower", tool: "apply_preset", args: { name: "sparks_shower" } }] },
  { id: "car_crash", title: "A crash", match: /\b(crash\w*|ram\w*|smash\w* into|collid\w*)\b/i,
    why: "Crates in the car's path, physics baked to keys, then a camera shake a beat after the hit.",
    steps: [{ say: "Crate crash (stacks crates, drives through, bakes)", tool: "apply_preset", args: { name: "crate_crash" } },
      { say: "Camera jolt on the hit", tool: "apply_preset", args: { name: "impact_shake" } }] },
  { id: "car_stunt", title: "A car stunt (J-turn, donut, handbrake 180)", match: /\b(j-?turn|donut|handbrake|drift|stunt)\b/i,
    why: "A J-turn reads best from a low wide with the car crossing frame; the donut from above.",
    steps: [{ say: "The stunt on the car", tool: "set_stunt", args: { stunt: "$stunt" } }] },
  { id: "chase", title: "Re-block a chase", match: /\bchase\b/i, why: "A chase is geography: keep screen direction (left to right) and cut on movement.",
    steps: [{ say: "Re-block the chase on the set", tool: "stage_order", args: { command: "$text" } }] },
  { id: "coverage3", title: "Cover a moment in three shots", match: /\b(cover|coverage)\b.*\b(three|3)\b|\bthree shots?\b/i,
    why: "Wide (geography), medium (the action), close (the reaction): cut on action and keep the 180° line.",
    steps: [
      { say: "A wide master", tool: "add_shot", args: { setup: "wide" } },
      { say: "A medium on the action", tool: "add_shot", args: { setup: "medium" } },
      { say: "A close-up for the reaction", tool: "add_shot", args: { setup: "close" } },
    ] },
  { id: "shot_reverse", title: "Shot / reverse shot (dialogue coverage)", match: /\b(shot[- ]reverse|over the shoulder|ots|dialogue coverage)\b/i,
    why: "Two over-the-shoulders on the same side of the line, matching lenses (50-85 mm).",
    steps: [{ say: "Over-the-shoulder on A", tool: "add_shot", args: { setup: "over the shoulder" } }, { say: "Reverse on B", tool: "add_shot", args: { setup: "reverse over the shoulder" } },
      { say: "Assemble with the Dialogue coverage edit style", tool: "apply_preset", args: { name: "dialogue_coverage" } }] },
  { id: "j_cut", title: "A J-cut (the next shot's sound starts first)", match: /\bj[- ]?cut\b/i,
    why: "The audience hears the next scene before they see it: it pulls them forward. The Cut has no one-click split edit yet, so it's done by hand.",
    steps: [
      { click: "⑥ Review › Cut: find the edit between the two shots", say: "Open the Cut and find the edit" },
      { click: "Drag the next shot's dialogue/sound clip (A1/A2) left, under the end of the outgoing shot (6-24 frames)", say: "Slide the incoming audio earlier" },
      { click: "Leave the picture edit where it is; play across it", say: "Keep the picture cut, play it back" },
    ] },
  { id: "l_cut", title: "An L-cut (the sound carries over the next shot)", match: /\bl[- ]?cut\b/i,
    why: "The line carries over the reaction shot: the classic dialogue edit. Done by hand in the Cut.",
    steps: [
      { click: "⑥ Review › Cut: find the edit", say: "Open the Cut and find the edit" },
      { click: "Extend the outgoing shot's audio clip right, past the picture cut, onto the next shot", say: "Let the audio run on" },
    ] },
  { id: "dissolve", title: "A dissolve or fade", match: /\b(dissolve|fade|dip to (?:black|white)|wipe|transition)\b/i, why: "A dissolve says time passes; a dip to black ends a beat.",
    steps: [{ say: "Put the transition on the edit", tool: "add_transition", args: { edit: "$edit", type: "dissolve" } }] },
  { id: "assemble", title: "Assemble the scene", match: /\b(assemble|cut (?:it|the scene) together|rough cut|first cut)\b/i, why: "Each shot's best take in strip order.",
    steps: [{ say: "Cut the scene together", tool: "assemble_cut", args: {} }] },
  { id: "recast", title: "Recast / Real performance (swap in a filmed performance)", match: /\b(recast|real performance|my own performance|act it myself)\b/i,
    why: "Film yourself acting the line; Soundstage keeps the shot and converts the voice to the character's.",
    steps: [{ click: "⑤ Motion › Real performance: upload or record the take", say: "Record or upload the performance" }, { click: "② Cast › the character › Voice", say: "Pick the character's voice" }] },
  { id: "viewfinder", title: "Use your phone as the viewfinder", match: /\b(phone|viewfinder|virtual camera|vcam|handheld for real)\b/i,
    why: "Walk the set with your phone as the camera: real handheld feel.",
    steps: [{ click: "③ Set › Camera › Phone viewfinder: scan the QR code", say: "Pair the phone" }, { click: "Record the move, then keep the take", say: "Record the camera move" }] },
  { id: "record_yourself", title: "Record yourself (motion capture)", match: /\b(record (?:my ?self|me)|capture motion|mocap|motion capture|act it out)\b/i,
    why: "Your webcam drives a person on the set.", steps: [{ click: "③ Set › Capture motion: pick the person, then Record", say: "Capture motion" }] },
];

const fill = (args, vars) => Object.fromEntries(Object.entries(args || {}).map(([k, v]) => [k, typeof v === "string" && v.startsWith("$") ? vars[v.slice(1)] ?? null : v]));

/** troubleshoot(symptom) -> {tool, ok, entry, said, plan: [{tool,args,say}], clicks: [..]} */
export function troubleshoot(symptom, vars = {}) {
  const e = TROUBLES.find((t) => t.match.test(String(symptom || "")));
  if (!e) return { tool: "troubleshoot", ok: false, said: `I don't have a fix on file for "${symptom}". Tell me what you see (which step, what you expected), or search the docs.`, observe: "no playbook entry" };
  const plan = e.fixes.filter((f) => f.tool).map((f) => ({ tool: f.tool, args: fill(f.args, vars), say: f.say }));
  const clicks = e.fixes.filter((f) => !f.tool && f.click !== undefined).map((f) => (f.click ? `${f.say} (${f.click})` : f.say));
  return { tool: "troubleshoot", ok: true, entry: e.id, title: e.title, cause: e.cause, plan, clicks,
    said: `${e.title}. Likely cause: ${e.cause}`, observe: `${e.id}: ${e.cause} Fixes: ${e.fixes.map((f) => f.say).join("; ")}` };
}

/** plan_recipe(intent) -> the recipes the words ask for, clause by clause in the order said ("re-block the chase, add a
 * crash, then cover it in three shots" -> chase, crash, three-shot coverage). */
export function planRecipe(intent, vars = {}) {
  const t = String(intent || "");
  const clauses = t.split(/\s*(?:,|;|\.)\s*(?:and\s+)?(?:then\s+)?|\s+(?:and\s+)?then\s+/i).filter(Boolean);
  const found = [];
  for (const c of clauses.length ? clauses : [t]) {
    const r = RECIPES.find((x) => x.match.test(c) && !found.some((f) => f.r === x));
    if (r) found.push({ r, clause: c });
  }
  if (!found.length) return { tool: "plan_recipe", ok: false, said: `I don't have a recipe for "${intent}" yet.`, observe: "no recipe" };
  const plan = [], clicks = [];
  for (const { r, clause } of found) {
    const v = { text: clause, ...vars };
    for (const s of r.steps) (s.tool ? plan.push({ tool: s.tool, args: fill(s.args, v), say: s.say, recipe: r.id }) : clicks.push(`${s.say}: ${s.click}`));
  }
  const rs = found.map((x) => x.r);
  return { tool: "plan_recipe", ok: true, recipes: rs.map((r) => r.id), title: rs.map((r) => r.title).join(" + "), why: rs.map((r) => r.why).join(" "),
    plan, clicks, said: `${rs.map((r) => r.title).join(", then ")}. ${rs[0].why}`, observe: `recipes ${rs.map((r) => r.id).join(", ")}: ${plan.length} tool steps, ${clicks.length} click-steps` };
}
