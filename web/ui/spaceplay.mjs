// Space plays / stops the shot on ③ Set (tutorial test 2026-11-02: "Press Space to play" did nothing on the stage, and
// with Presets open Space re-clicked the focused card, stacking a second and a third Crate crash).
//
// isStagePlayKey(e, ctx) decides; the App (soundstage.js) clicks its Play button when it says yes.
//   ctx.view      the workspace view ("stage" only; the cut editor and the timeline have their own Space)
//   ctx.driving   Drive mode is on (Space is the handbrake / jump there)
//   ctx.painting  Paint Studio is open (Space pans there)
//   ctx.active    document.activeElement

/** Should this keydown play / stop the shot? Space, no modifiers, not while typing, not in Drive or Paint Studio. */
export function isStagePlayKey(e, { view = "stage", driving = false, painting = false, active = null } = {}) {
  if (!e || (e.key !== " " && e.code !== "Space") || e.repeat) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (view !== "stage" || driving || painting) return false;
  for (const t of [e.target, active]) {
    if (!t) continue;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable) return false;
    if (t.closest?.(".ss-strip")) return false;   // the shot strip / timeline has its own Space and ⌘Z
    // A focused button keeps Space for itself (keyboard users), except a Presets card: Space there used to re-apply it.
    if ((t.tagName === "BUTTON" || t.getAttribute?.("role") === "button") && !t.closest?.(".ss-pre-grid, .ss-pre-tabs")) return false;
  }
  return true;
}

/**
 * ⌘Z / ⇧⌘Z (Ctrl on a PC) on ③ Set when the focus is not on the stage canvas, which has its own (tutorial test
 * 2026-11-02: after V closed Presets the focus sat on the page and ⌘Z undid nothing; only the top-bar Undo worked).
 * Returns "undo", "redo" or null.
 */
export function stageUndoKey(e, { view = "stage", driving = false, painting = false, active = null } = {}) {
  if (!e || !(e.metaKey || e.ctrlKey) || e.altKey || (e.key || "").toLowerCase() !== "z") return null;
  if (view !== "stage" || driving || painting) return null;
  for (const t of [e.target, active]) {
    if (!t) continue;
    if (t.tagName === "CANVAS" || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable) return null;
    if (t.closest?.(".ss-strip")) return null;
  }
  return e.shiftKey ? "redo" : "undo";
}
