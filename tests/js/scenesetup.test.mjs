import test from "node:test";
import assert from "node:assert/strict";
import { planSceneSetup, sceneCast, timePresetFor, guessPersonKind, appearanceFromText, blockingSpots, setupLabel, sceneChip, stepScene,
  vehicleOfScene, ridersOfScene, seatAssignments } from "../../web/script/scenesetup.mjs";
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

test("INT. SPORTS CAR (MOVING): Mara sits at the wheel of a moving sports car, not beside it", () => {
  assert.deepEqual(vehicleOfScene(sc2a), { kind: "sports_car", moving: true });
  const p = planSceneSetup(sc2a, { actors: DEFAULTS, fresh: true, env: { set: "street_night" } });
  assert.deepEqual(p.hosts, [{ kind: "sports_car", reuseId: null, moving: true }]);
  assert.deepEqual(p.people.map((x) => [x.name, x.mount]), [["Mara", { host: 0, seat: 0 }]]);
  assert.deepEqual(p.vehicle, { kind: "sports_car", moving: true, host: 0 });
  assert.ok(!p.objects.includes("sports_car"), "the car she sits in is the host, not a parked extra");
  assert.ok(p.objects.includes("police_car"));
  // A stage that already has the car and Mara in its driver's seat needs no seating change.
  const done = planSceneSetup(sc2a, { actors: [{ id: "m", kind: "woman", name: "Mara", mount_id: "c", seat: 0 },
    { id: "c", kind: "sports_car", name: "Sports car" }, { id: "p", kind: "police_car" }], env: { set: "street_night", weather: "rain" } });
  assert.equal(done.hosts[0].reuseId, "c");
  assert.equal(done.changes, 0);
});

test("seats: the one at the wheel drives, then the front passenger seat, then the back", () => {
  const sc = { int_ext: "INT", location: "TAXI", heading: "INT. TAXI - NIGHT",
    elements: [{ type: "action", text: "JO sits in the back. VANCE drives, eyes on the mirror. ADA rides shotgun." }] };
  assert.deepEqual(vehicleOfScene(sc), { kind: "car", moving: true });
  assert.deepEqual(seatAssignments(sc, ["Jo", "Vance", "Ada"], "car"), { Vance: 0, Jo: 1, Ada: 3 });
  assert.equal(vehicleOfScene({ int_ext: "INT", location: "DINER" }), null);
  assert.equal(vehicleOfScene({ int_ext: "EXT", location: "MAIN STREET" }), null);
  assert.deepEqual(vehicleOfScene({ int_ext: "EXT", location: "HIGHWAY - MARA'S CAR (MOVING)", heading: "EXT. HIGHWAY - MARA'S CAR (MOVING) - DAY" }),
    { kind: "car", moving: true });
});

test("riders: each gets a horse of their own and is up on it", () => {
  assert.deepEqual(ridersOfScene(sc1), { kind: "horse", riders: ["Ezra", "Mara"] });
  const p = planSceneSetup(sc1, { actors: DEFAULTS, fresh: true, env: { set: "plaza" } });
  assert.deepEqual(p.hosts.map((h) => h.kind), ["horse", "horse"]);
  assert.deepEqual(p.people.map((x) => x.mount), [{ host: 0, seat: null }, { host: 1, seat: null }]);
  assert.ok(!p.objects.includes("horse"), "no riderless horse parked behind them");
  assert.equal(p.vehicle, null);
  // A horse already on the stage is used before a new one is added; one already ridden by someone else is not.
  const q = planSceneSetup(sc1, { actors: [{ id: "h1", kind: "horse" }, { id: "h2", kind: "horse" }, { id: "x", kind: "man", name: "Stunt", mount_id: "h2" }] });
  assert.deepEqual(q.hosts.map((h) => h.reuseId), ["h1", null]);
  // Nobody rides in the beach scene or the street chase.
  assert.deepEqual(ridersOfScene(sc3).riders, []);
  assert.ok(planSceneSetup(sc2, { actors: DEFAULTS, fresh: true }).people.every((x) => !x.mount));
});
