// node --test tests/js/advisor.test.mjs
// addShotsToStage() against a stand-in with the same shot API as web/stage/stage.mjs, plus the live route on
// :8189 (skipped when the tunnel is down or the route is not deployed). SOUNDSTAGE_URL overrides the base.
import test from "node:test";
import assert from "node:assert/strict";

import { addShotsToStage, ADVISOR_TAG } from "../../web/advisor/advisor.mjs";

const BASE = process.env.SOUNDSTAGE_URL || "http://127.0.0.1:8189";
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Same semantics as Stage: addShot activates the new setup, setCameraKeys writes the ACTIVE setup. */
class FakeStage {
  constructor() {
    this.state = { shot: { frames: 97, fps: 24 }, actors: [], active_shot: "shot_1",
      shots: [{ id: "shot_1", name: "Master", setup: "master", camera_keys: [{ frame: 0, position: [0, 1.6, -8], target: [0, 1.4, 0], focal_mm: 35 }] }] };
    this.n = 0;
    this.changes = 0;
  }
  toJSON() { return clone(this.state); }
  activeShot() { return this.state.shots.find((s) => s.id === this.state.active_shot) || this.state.shots[0]; }
  setActiveShot(id) { if (this.state.shots.some((s) => s.id === id)) { this.state.active_shot = id; this.changes++; } }
  addShot(setup = "single") {
    const shot = { id: `shot_x${++this.n}`, name: setup, setup, camera_keys: clone(this.activeShot().camera_keys) };
    this.state.shots.push(shot);
    this.state.active_shot = shot.id;
    this.changes++;
    return shot.name;
  }
  removeShot() {
    if (this.state.shots.length < 2) return;
    this.state.shots = this.state.shots.filter((s) => s.id !== this.state.active_shot);
    this.state.active_shot = this.state.shots[0].id;
  }
  setCameraKeys(keys) {
    this.activeShot().camera_keys = keys.map((k) => ({ frame: k.frame, position: [...k.position], target: [...k.target], focal_mm: k.focal_mm }));
    this.changes++;
  }
}

const SHOTS = [
  { id: "1", name: "1 · Extreme wide set", setup: "master", size: "EWS", why: "geography", kb_refs: ["technique.spaghetti_standoff"],
    camera_keys: [{ frame: 0, position: [-20, 9, -17], target: [0, 1, 0], focal_mm: 24 }] },
  { id: "2", name: "2 · Extreme close-up A", setup: "single_a", size: "ECU", why: "intent", kb_refs: ["emotion.tension"],
    camera_keys: [{ frame: 0, position: [-3.6, 1.67, -0.7], target: [-4, 1.66, 0], focal_mm: 100 },
      { frame: 96, position: [-3.65, 1.67, -0.6], target: [-4, 1.66, 0], focal_mm: 100 }] },
];

test("addShotsToStage writes one setup per shot with its keys, name and why", () => {
  const st = new FakeStage();
  const ids = addShotsToStage(st, SHOTS, { request: { scene: "duel" } });
  const shots = st.toJSON().shots;
  assert.equal(shots.length, 3);
  assert.deepEqual(ids, ["shot_x1", "shot_x2"]);
  assert.equal(shots[1].name, "1 · Extreme wide set");
  assert.equal(shots[2].camera_keys.length, 2);
  assert.equal(shots[2].camera_keys[1].frame, 96);
  assert.equal(shots[2][ADVISOR_TAG].why, "intent");
  assert.equal(shots[2][ADVISOR_TAG].scene, "duel");
  assert.equal(st.state.active_shot, "shot_x1", "first new setup becomes active");
  assert.deepEqual(shots[0].camera_keys[0].position, [0, 1.6, -8], "the existing Master is untouched");
});

test("replace removes only earlier advisor setups", () => {
  const st = new FakeStage();
  addShotsToStage(st, SHOTS);
  addShotsToStage(st, SHOTS.slice(0, 1), { replace: true });
  const shots = st.toJSON().shots;
  assert.deepEqual(shots.map((s) => s.name), ["Master", "1 · Extreme wide set"]);
});

async function live(path, init) {
  try {
    const r = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(8000) });
    return r;
  } catch {
    return null;
  }
}

test("live :8189 /soundstage/advisor returns stage-ready shots", async (t) => {
  const probe = await live("/soundstage/advisor/vocab");
  if (!probe || probe.status === 404) { t.skip(`advisor route not reachable at ${BASE}`); return; }
  assert.equal(probe.status, 200);
  const vocab = await probe.json();
  assert.ok(vocab.technique.some((o) => o.id === "technique.spaghetti_standoff"));
  const stage_scene = { version: 2, shot: { frames: 97, fps: 24, aspect: "1.85" },
    actors: [{ id: "a", kind: "man", position: [-4, 0, 0], height_m: 1.8 }, { id: "b", kind: "man", position: [4, 0, 0], height_m: 1.78 }] };
  const r = await live("/soundstage/advisor", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene: "Two gunfighters face off in a dusty street at noon.", stage_scene }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.recipe.from, "technique.spaghetti_standoff");
  assert.ok(d.shots.length >= 5);
  for (const s of d.shots) {
    assert.ok(s.why.length > 40 && s.summary && s.kb_refs.length);
    for (const k of s.camera_keys) assert.ok(k.position.length === 3 && k.target.length === 3 && k.focal_mm >= 8);
  }
  // the keys go straight into the stage API
  const st = new FakeStage();
  addShotsToStage(st, d.shots);
  assert.equal(st.toJSON().shots.length, d.shots.length + 1);
  const bad = await live("/soundstage/advisor", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 400);
});
