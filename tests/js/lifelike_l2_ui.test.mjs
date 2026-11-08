// node --test tests/js/lifelike_l2_ui.test.mjs
// Lifelike-only L2 (UI and words): the Blocking toggle and the Clay view are gone from the UI; an old saved scene
// with people_look: "blocking" loads and shows lifelike; old view / layer / rung names keep working as aliases
// (research plan §1.2, §1.4, §1.6). The grep test over the words is tests/test_clay_words.py.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migrateScene, viewMode, RETIRED_SCENE_FIELDS } from "../../web/stage/scenemigrate.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import * as PUI from "../../web/stage/people/peopleui.mjs";
import { RUNG_NAMES } from "../../web/ladder/ladder.mjs";

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("migrateScene drops the retired people_look field and keeps everything else", () => {
  const old = { camera: { focal_mm: 35 }, actors: [{ id: "a", kind: "man" }], people_look: "blocking", shot: { frames: 49, fps: 24 } };
  const out = migrateScene(structuredClone(old));
  assert.equal("people_look" in out, false);
  assert.deepEqual(out.actors, old.actors);
  assert.deepEqual(out.camera, old.camera);
  assert.ok(RETIRED_SCENE_FIELDS.people_look);
  assert.equal(migrateScene(null), null);
  assert.equal(migrateScene("x"), "x");
});

test("an old scene saved with people_look: 'blocking' loads through Stage.load and shows lifelike (no flag left)", () => {
  // A headless stand-in for the parts of the Stage load() touches (no WebGL in node).
  const calls = [];
  const fake = {
    fw: 960, fh: 544, camera: { aspect: 1 }, viewCam: null, _rebake: null,
    _buildSet() { calls.push("set"); }, _applySun() { calls.push("sun"); }, setKey(k) { calls.push(`key:${k}`); }, render() {},
  };
  const scene = { camera: { position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 }, actors: [{ id: "a", kind: "woman", keys: [{ frame: 0, position: [0, 0, 0] }] }],
    people_look: "blocking" };
  Stage.prototype.load.call(fake, scene);
  assert.equal(fake.state.people_look, undefined, "the retired flag is gone after load");
  assert.equal(scene.people_look, "blocking", "the caller's object is not mutated (load clones first)");
  assert.equal(fake.state.actors[0].kind, "woman");
  assert.ok(calls.includes("set") && calls.includes("key:start"));
});

test("the retired Clay view: viewMode maps it to Color; the Stage opens on Color and setView('clay') shows Color", () => {
  assert.equal(viewMode("clay"), "color");
  for (const m of ["wire", "color", "depth", "id"]) assert.equal(viewMode(m), m);
  const fake = { _hasSplats: () => false, render() {} };
  Stage.prototype.setView.call(fake, "clay");
  assert.equal(fake.view, "color");
  assert.match(src("web/stage/stage.mjs"), /this\.view = "color";/, "the constructor default view is Color");
  assert.doesNotMatch(src("web/stage/stage.mjs"), /setBlockingLook/, "setBlockingLook is removed");
});

test("the App: no Blocking button, no Clay view button, no Clay icon", () => {
  const app = src("web/soundstage.js");
  assert.doesNotMatch(app, /\["clay", "Clay"/, "no Clay entry in the view modes");
  assert.doesNotMatch(app, /"Clay": "box"/, "no Clay icon");
  assert.doesNotMatch(app, /blockingToggle|setBlockingLook|people_look/);
  assert.equal(typeof PUI.sceneViewControls, "function");
  assert.equal(PUI.blockingToggle, undefined);
  assert.equal(PUI.BLOCKING_TIP, undefined);
  assert.doesNotMatch(src("web/stage/people/peopleui.mjs"), /textContent: "Blocking"/);
  // the phone viewfinder and the try-it demo lose their Clay buttons too
  assert.doesNotMatch(src("web/vcam/viewfinder.html"), /id="vClay"|>CLAY</);
  assert.doesNotMatch(src("web/vcam/viewfinder.mjs"), /\$\("vClay"\)/);
  assert.match(src("web/vcam/vfcore.mjs"), /view = "color" \} = \{\}\)/, "the viewfinder protocol default view is Color");
  assert.doesNotMatch(src("web/tryit/tryit.mjs"), /\["clay", "Clay"\]/);
});

test("the Ladder's stage layer is 'Stage' (Color); the old 'clay' layer id still reads as it", () => {
  assert.deepEqual(RUNG_NAMES, ["Wire", "Stage", "Look", "Draft", "Final"]);
  const L = src("web/ladder/ladder.mjs");
  assert.match(L, /\["color", "Stage"\]/);
  assert.doesNotMatch(L, /\["clay", "Clay"\]/);
  assert.match(L, /const rungId = \(id\) => \(id === "clay" \? "color" : id\)/);
});

test("Paint Studio: a saved stage layer with stageMode 'clay' shows Color; the colour / clay switch is gone", () => {
  const C = src("web/canvas/canvas.mjs");
  assert.match(C, /extra\.stageMode && extra\.stageMode !== "clay" \? extra\.stageMode : "color"/);
  assert.doesNotMatch(C, /switch colour \/ clay/);
  assert.doesNotMatch(C, /\? "clay" : "color"/);
});
