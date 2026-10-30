import test from "node:test";
import assert from "node:assert/strict";
import { planSceneSetup, sceneCast, timePresetFor, guessPersonKind, appearanceFromText, blockingSpots, setupLabel, sceneChip, stepScene }
  from "../../web/script/scenesetup.mjs";
import { DEMO_SCRIPT } from "../../web/script/demo_script.mjs";

const [sc1, sc2, sc2a, sc3] = DEMO_SCRIPT.scenes;
const DEFAULTS = [{ id: "actor_a", kind: "man", name: "Man" }, { id: "actor_b", kind: "woman", name: "Woman" }];

test("the scene's characters, title case, no duplicates or extensions", () => {
  assert.deepEqual(sceneCast(sc1), ["Ezra", "Mara"]);
  assert.deepEqual(sceneCast({ characters: ["JAKE (V.O.)", "JAKE", "MARA (CONT'D)"] }), ["Jake", "Mara"]);
});

test("time of day from the slugline; CONTINUOUS keeps the light", () => {
  assert.equal(timePresetFor(sc1), "magic_hour");
  assert.equal(timePresetFor(sc2), "night");
  assert.equal(timePresetFor(sc2a), null);
  assert.equal(timePresetFor({ time: "DAY" }), "midday");
  assert.equal(timePresetFor({ time: "MAGIC HOUR" }), "magic_hour");
  assert.equal(timePresetFor({ time: "DAWN" }), "dawn");
});

test("man / woman / child from the cast description and the action", () => {
  assert.equal(guessPersonKind("Mara", { sc: sc1 }), "woman");
  assert.equal(guessPersonKind("Ezra", { sc: sc1 }), "man");
  assert.equal(guessPersonKind("Sam", { description: "a boy of 9" }), "child");
  assert.equal(guessPersonKind("Jo", { description: "she runs the diner" }), "woman");
});

test("looks only from what the text says", () => {
  assert.deepEqual(appearanceFromText("60s, grey hair, red wool coat over a white shirt, jeans, stetson"),
    { top: "coat", top_color: "#a3262a", bottom: "jeans", hair: "hat", hair_color: "#9a9a9a" });
  assert.deepEqual(appearanceFromText(""), {});
});

test("a fresh stage: stand-ins go, the cast comes on, set + light + vehicles from the heading", () => {
  const p = planSceneSetup(sc2, { actors: DEFAULTS, fresh: true, env: { set: "plaza" } });
  assert.equal(p.label, "Set up scene 2 — EXT. DRY CREEK - MAIN STREET — NIGHT (Deputy Cole)");
  assert.deepEqual(p.removeIds, ["actor_a", "actor_b"]);
  assert.deepEqual(p.people.map((x) => [x.name, x.kind, x.appearance.top]), [["Deputy Cole", "man", "uniform"]]);
  assert.deepEqual(p.objects, ["sports_car", "police_car"]);
  assert.deepEqual(p.env, { set: "street_night", weather: "rain" });
  assert.equal(p.time_preset, "night");
  assert.ok(p.changes > 0);
});

test("a worked stage: same-named actors are reused, nothing is removed, a set-up stage needs nothing", () => {
  const actors = [{ id: "m1", kind: "woman", name: "Mara" }, { id: "x", kind: "man", name: "Stunt double" }, { id: "car", kind: "sports_car", name: "Sports car" }];
  const p = planSceneSetup(sc3, { actors, env: { set: "beach", weather: "none" }, lightingPreset: "magic_hour" });
  assert.deepEqual(p.removeIds, []);
  assert.equal(p.people[0].reuseId, "m1");
  assert.deepEqual(p.objects, ["bird"]);
  const done = planSceneSetup(sc3, { actors: [...actors, { id: "b", kind: "bird", name: "Bird" }], env: { set: "beach", weather: "none" }, lightingPreset: "magic_hour" });
  assert.equal(done.changes, 0);
});

test("blocking: two face each other (opened to the lens), clear of what is there", () => {
  const two = blockingSpots(2, { center: [0, -4], cam: [0, -11.5] });
  assert.equal(two.length, 2);
  assert.ok(two[0].position[0] > 0 && two[1].position[0] < 0);
  assert.ok(two[0].rotation_deg < -90 && two[1].rotation_deg > 90, "each turned toward the other and the camera");
  const one = blockingSpots(1, { center: [0, -4], cam: [0, -11.5], avoid: [[0, 0, -4]] });
  assert.ok(Math.hypot(one[0].position[0], one[0].position[2] + 4) > 0.9);
});

test("chips, labels and stepping", () => {
  const c = sceneChip(sc1);
  assert.deepEqual([c.number, c.where, c.time, c.initials.join("")], ["1", "EXT. Desert Outside Dry Creek", "dusk", "EM"]);
  assert.equal(sceneChip(sc2).initials[0], "C");
  assert.equal(setupLabel({ number: 3, int_ext: "INT", location: "DINER", time: "NIGHT" }, ["Mara", "Jake"]), "Set up scene 3 — INT. DINER — NIGHT (Mara, Jake)");
  const ids = DEMO_SCRIPT.scenes;
  assert.equal(stepScene(ids, "sc_1", 1), "sc_2");
  assert.equal(stepScene(ids, "sc_1", -1), null);
  assert.equal(stepScene(ids, null, 1), "sc_1");
});
