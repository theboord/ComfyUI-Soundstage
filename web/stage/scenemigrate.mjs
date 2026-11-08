// Lifelike-only L2 (research plan §1.2, §1.4, §1.6): the clay look is retired from the UI. Old saved scenes and old
// callers keep working through these small, pure maps (no THREE, no DOM, so tests run them headless).
//   migrateScene(scene): a loaded scene's retired fields read as today's. people_look: "blocking" was the scene-wide
//     Blocking (clay people) toggle; people are always lifelike now, so the field is dropped and the scene shows
//     lifelike. The hidden logic rig is untouched (it never depended on the flag).
//   viewMode(mode): the viewport view. The retired "clay" view (a saved canvas layer, a phone viewfinder, an old caller)
//     shows "color", with one console note per session. Capture passes do not come through here (renderFrameTo keeps
//     its pass names until the guide switch, L3).

/** Scene fields retired by Lifelike-only L2: name -> why (the alias contract table in docs/agent.md lists them). */
export const RETIRED_SCENE_FIELDS = { people_look: "the Blocking toggle is retired: people always show lifelike" };

/** Mutates and returns the scene: retired fields removed. Safe on any value (a non-object is returned as is). */
export function migrateScene(scene) {
  if (!scene || typeof scene !== "object") return scene;
  for (const k of Object.keys(RETIRED_SCENE_FIELDS)) if (k in scene) delete scene[k];
  return scene;
}

let warned = false;
/** The viewport view for a requested mode: "clay" (retired) -> "color"; everything else as asked. */
export function viewMode(mode) {
  if (mode !== "clay") return mode;   // clay-alias: the retired view name
  if (!warned) {
    warned = true;
    // clay-alias: a console note for developers (an old caller asked for the retired view)
    try { console.info('[Soundstage] view "clay" is retired: showing Color (Lifelike-only L2).'); } catch { /* no console */ }   // clay-alias
  }
  return "color";
}
