// Space plays the shot on ③ Set; Esc closes the Physics panel (tutorial test 2026-11-02).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isStagePlayKey } from "../../web/ui/spaceplay.mjs";
import { allCombos } from "../../web/ui/shortcuts.mjs";

const node = (tagName, { inPresets = false, inStrip = false, role = null, editable = false } = {}) => ({
  tagName, isContentEditable: editable, getAttribute: (k) => (k === "role" ? role : null),
  closest: (q) => ((inPresets && q.includes(".ss-pre-grid")) || (inStrip && q.includes(".ss-strip")) ? {} : null),
});
const space = (extra = {}) => ({ key: " ", code: "Space", target: node("CANVAS"), ...extra });

test("Space on the stage canvas or the page body plays", () => {
  assert.equal(isStagePlayKey(space()), true);
  assert.equal(isStagePlayKey(space({ target: node("BODY") }), { active: node("BODY") }), true);
});

test("Space with a Presets card focused plays instead of re-applying the card", () => {
  const card = node("BUTTON", { inPresets: true });
  assert.equal(isStagePlayKey(space({ target: card }), { active: card }), true);
});

test("Space keeps its own meaning while typing, on other buttons, in Drive, Paint Studio and the editor", () => {
  assert.equal(isStagePlayKey(space({ target: node("INPUT") })), false);
  assert.equal(isStagePlayKey(space({ target: node("TEXTAREA") })), false);
  assert.equal(isStagePlayKey(space({ target: node("DIV", { editable: true }) })), false);
  assert.equal(isStagePlayKey(space({ target: node("BUTTON") })), false);
  assert.equal(isStagePlayKey(space(), { driving: true }), false);
  assert.equal(isStagePlayKey(space(), { painting: true }), false);
  assert.equal(isStagePlayKey(space(), { view: "cut" }), false);
  assert.equal(isStagePlayKey(space({ shiftKey: true })), false);
  assert.equal(isStagePlayKey(space({ repeat: true })), false);
  assert.equal(isStagePlayKey({ key: "a", target: node("CANVAS") }), false);
});

test("the App wires Space to Play and Esc to the Physics panel, and the shortcut sheet lists it", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  assert.match(src, /isStagePlayKey\(e, \{ view: curView, driving: !!stage\.drive\?\.on/);
  assert.match(src, /window\.addEventListener\("keydown", onPlayKey, true\)/);
  assert.match(src, /window\.removeEventListener\("keydown", onPlayKey, true\)/);
  assert.ok(allCombos(true).includes("Space"));
});

import { stageUndoKey } from "../../web/ui/spaceplay.mjs";
test("⌘Z / ⇧⌘Z undo the stage when the focus is off the canvas, never while typing or on the canvas itself", () => {
  const z = (extra = {}) => ({ key: "z", metaKey: true, target: node("BODY"), ...extra });
  assert.equal(stageUndoKey(z()), "undo");
  assert.equal(stageUndoKey(z({ shiftKey: true, key: "Z" })), "redo");
  assert.equal(stageUndoKey(z({ metaKey: false, ctrlKey: true })), "undo");
  assert.equal(stageUndoKey(z({ target: node("CANVAS") })), null);          // the canvas has its own ⌘Z
  assert.equal(stageUndoKey(z({ target: node("INPUT") })), null);
  assert.equal(stageUndoKey(z({ target: node("DIV", { editable: true }) })), null);
  assert.equal(stageUndoKey(z(), { view: "cut" }), null);
  assert.equal(stageUndoKey(z(), { driving: true }), null);
  assert.equal(stageUndoKey({ key: "z", target: node("BODY") }), null);
  assert.equal(stageUndoKey(z({ target: node("DIV", { inStrip: true }) })), null);   // the shot strip has its own undo
  assert.equal(isStagePlayKey(space({ target: node("DIV", { inStrip: true }) })), false);
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  assert.match(src, /window\.addEventListener\("keydown", onUndoKey, true\)/);
});

test("Physics: the panel's Esc listener lives with the panel (open adds it, close removes it)", () => {
  const src = readFileSync(new URL("../../web/stage/physpanel.mjs", import.meta.url), "utf8");
  assert.match(src, /open\(\) \{[\s\S]*?addEventListener\("keydown", this\._escKey, true\)/);
  assert.match(src, /close\(\) \{[\s\S]*?removeEventListener\("keydown", this\._escKey, true\)/);
  assert.match(src, /_escKey = \(e\) => \{\s*if \(e\.key !== "Escape" \|\| this\.el\.hidden/);
  assert.match(src, /this\.stage\?\.drive\?\.on \|\| this\.stage\?\.poser\?\.active/);
});
