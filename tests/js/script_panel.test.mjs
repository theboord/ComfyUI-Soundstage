// node --test tests/js/   (the Script panel's pure helpers and the sample script; the DOM is checked in web/script/preview.html)
import test from "node:test";
import assert from "node:assert/strict";

import { DEMO_SCRIPT, demoScript } from "../../web/script/demo_script.mjs";
import { BREAKDOWN_CATEGORIES, filterScenes, looseShots, niceText, shotCounts, startPage, timeKind } from "../../web/script/panel.mjs";

const SETS = new Set(["plaza", "street_night", "interior", "studio", "forest", "desert", "beach", "water_tank", "open_water", "stadium", "empty"]);
const TYPES = new Set(["action", "character", "dialogue", "parenthetical", "transition", "shot", "note", "centered", "lyric"]);

test("sample script follows the Script model", () => {
  const s = DEMO_SCRIPT;
  assert.equal(s.version, 1);
  for (const k of ["title", "author", "format", "source_name"]) assert.equal(typeof s[k], "string");
  assert.ok(s.scenes.length >= 3 && s.scenes.length <= 4);
  const ids = new Set();
  s.scenes.forEach((sc, i) => {
    assert.equal(sc.index, i);
    assert.equal(sc.id, `sc_${sc.number}`);
    assert.ok(!ids.has(sc.id)); ids.add(sc.id);
    assert.match(sc.heading, /^(INT|EXT)\. /);
    assert.ok(["INT", "EXT", "INT/EXT", ""].includes(sc.int_ext));
    assert.ok(sc.eighths >= 1);
    for (const e of sc.elements) assert.ok(TYPES.has(e.type), e.type);
    for (const c of BREAKDOWN_CATEGORIES) assert.ok(Array.isArray(sc.breakdown[c.key]), c.key);
    assert.ok(SETS.has(sc.stage_hint.set));
    assert.ok(["day", "night", "dawn", "dusk", null].includes(sc.stage_hint.time_of_day));
    assert.ok(sc.outline.length <= 180);
    assert.equal(sc.notes, "");  // notes are the director's, never pre-filled
    for (const name of sc.characters) assert.ok(s.characters.find((c) => c.name === name)?.scenes.includes(sc.id));
  });
  const copy = demoScript();
  copy.scenes[0].notes = "x";
  assert.equal(DEMO_SCRIPT.scenes[0].notes, "");
});

test("shot counts per scene ignore untagged shots", () => {
  const m = shotCounts([{ id: 1, scene_id: "sc_1" }, { id: 2, scene_id: "sc_1" }, { id: 3 }, { id: 4, scene_id: "sc_2A" }]);
  assert.equal(m.get("sc_1"), 2);
  assert.equal(m.get("sc_2A"), 1);
  assert.equal(m.size, 2);
});

test("filter matches number, heading and characters", () => {
  const sc = DEMO_SCRIPT.scenes;
  assert.equal(filterScenes(sc, "").length, sc.length);
  assert.deepEqual(filterScenes(sc, "2a").map((x) => x.id), ["sc_2A"]);
  assert.deepEqual(filterScenes(sc, "deputy").map((x) => x.id), ["sc_2"]);
  assert.deepEqual(filterScenes(sc, "beach sunset").map((x) => x.id), ["sc_3"]);
  assert.equal(filterScenes(sc, "spaceship").length, 0);
});

test("labels: title case, time icons, start page", () => {
  assert.equal(niceText("DRY CREEK - MAIN STREET"), "Dry Creek – Main Street");
  assert.equal(niceText("DESERT OUTSIDE OF THE TOWN"), "Desert Outside of the Town");
  assert.equal(niceText("SPORTS CAR (MOVING)"), "Sports Car (Moving)");
  assert.equal(niceText("McKay's Bar"), "McKay's Bar");
  assert.equal(timeKind({ time: "NIGHT" }), "night");
  assert.equal(timeKind({ time: "SUNSET" }), "dusk");
  assert.equal(timeKind({ time: "CONTINUOUS", stage_hint: { time_of_day: "night" } }), "night");
  assert.equal(timeKind({ time: "MOMENTS LATER" }), "time");
  assert.equal(timeKind({ time: "" }), null);
  const s = DEMO_SCRIPT;
  assert.deepEqual(s.scenes.map((x) => startPage(s, x)), [1, 2, 2, 3]);
});

test("labels: hyphenated and O'-names capitalise every part", () => {
  assert.equal(niceText("BARTHOLOMEW-ALEXANDER"), "Bartholomew-Alexander");
  assert.equal(niceText("TRUCK-STOP"), "Truck-Stop");
  assert.equal(niceText("MRS. O'HARA"), "Mrs. O'Hara");
  assert.equal(niceText("SHERIFF'S OFFICE"), "Sheriff's Office");
});

test("loose shots: untagged, on a cut scene, or from another script", () => {
  const shots = [{ id: "a", scene_id: "sc_1" }, { id: "b" }, { id: "c", scene_id: "sc_9" }, { id: "d", scene_id: "sc_2A" }];
  assert.deepEqual(looseShots(DEMO_SCRIPT, shots).map((x) => x.id), ["b", "c"]);
  assert.deepEqual(looseShots(null, shots).map((x) => x.id), ["a", "b", "c", "d"]);
});
