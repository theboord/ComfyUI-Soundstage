// Review blockers on the practical effects (PR #26), each one checked on the real Stage. Practical effects on the real Stage (headless: scene graph, keys, setFrame, bake and undo; no WebGL). An explosion
// beside a parked car, a crate and a man: the bake throws the crate, rocks or rolls the car and knocks the man down; a
// reset puts every object back byte for byte; a tweak re-bakes from the untouched scene; scrubbing back is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import * as X from "../../web/stage/sfx.mjs";

globalThis.window ||= {};
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("car model failed")) _warn(...a); };

function headless(actors, env = { set: "studio" }) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: env }, view: "clay", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onInteract() {}, onSelect() {}, onShots() {}, _buildLights() {}, _applySun() {},
  });
  st.onChange = () => { if (!st._muteRecord) { st._record(); st._worldPoke(); } };
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.live = new LiveEdit(st, liveKinds());
  st.setFrame(0);
  st.resetHistory();
  return st;
}
const at = (id, name, kind, pos, extra = {}) => ({ id, name, kind, position: pos, keys: [{ frame: 0, position: pos }], rotation_deg: 0, ...extra });
const yard = () => [
  at("car", "Red car", "sports_car", [-2.4, 0, 0], { rotation_deg: 0 }),
  at("crate", "Crate", "crate", [2.2, 0, 0]),
  at("man", "Man", "man", [0, 0, 4]),
];
const nonRig = (st) => JSON.stringify(st.state.actors.filter((a) => !X.isSfxRig(a)));
const physNoSfx = (st) => { const { sfx, ...p } = st.state.physics || {}; return JSON.stringify(p); };
const pose = (g) => [g.position.toArray(), g.quaternion.toArray()].flat().map((v) => +v.toFixed(5)).join();

test("blocker 1: a hit reaction is a function of the time since the hit (playing frame by frame = jumping there)", () => {
  const st = headless([at("man", "Man", "man", [0, 0, 0])]);
  st.addSfxRig("body_squib", { target: "man", point: "shoulder_l", sfx: { trigger: { type: "time", at: 0.5 } } });
  const g = st.actorMeshes.get("man");
  for (let f = 0; f <= 60; f++) st.setFrame(f);
  const played = pose(g);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(g.quaternion);
  st.setFrame(0); st.setFrame(60);
  assert.equal(played, pose(g), "frame 60 played through equals frame 60 jumped to");
  const st2 = headless([at("man", "Man", "man", [0, 0, 0])]);
  st2.addSfxRig("body_squib", { target: "man", point: "shoulder_l", sfx: { trigger: { type: "time", at: 0.5 } } });
  st2.setFrame(60);
  assert.equal(pose(st2.actorMeshes.get("man")), played, "and a fresh stage jumping straight there");
  assert.ok(Math.acos(Math.min(1, up.y)) * 180 / Math.PI < 100, `a shoulder hit drops him, never past lying down (${(Math.acos(Math.min(1, up.y)) * 180 / Math.PI).toFixed(0)} deg)`);
});

test("blocker 2a: Reset to before keeps a crash baked before the explosion was added", () => {
  const st = headless([at("car", "Red car", "sports_car", [0, 0, -15], { keys: [{ frame: 0, position: [0, 0, -15] }, { frame: 48, position: [0, 0, 10] }] }), at("crate", "Crate", "crate", [0, 0, 0]), at("man", "Man", "man", [6, 0, 6])]);
  st.simulatePhysics();
  assert.ok(st.state.actors.find((a) => a.id === "crate").physics?.baked, "the car knocks the crate loose");
  const before = nonRig(st), physBefore = physNoSfx(st);
  const rig = st.addSfxRig("explosion", { position: [6, 0, 8], sfx: { power: 1.2 } });
  assert.ok(st.state.actors.find((a) => a.id === "man").physics?.baked, "the blast knocks the man down");
  st.sfxReset([rig.id]);
  assert.equal(nonRig(st), before, "the crash bake is back exactly, the man unbaked");
  assert.equal(physNoSfx(st), physBefore, "and its hits");
});

test("blocker 2b: Reset to before keeps edits made after the blast (name, colour, ground)", () => {
  const st = headless(yard());
  const rig = st.addSfxRig("explosion", { position: [0, 0, 0], sfx: { power: 1.5 } });
  const crate = () => st.state.actors.find((a) => a.id === "crate"), car = () => st.state.actors.find((a) => a.id === "car");
  const keys0 = JSON.stringify(yard().find((a) => a.id === "crate").keys);
  crate().name = "Apple crate"; car().color = "#2244ff"; st.state.physics.ground = "sand";
  st.onChange(st.toJSON());
  st.sfxReset([rig.id]);
  assert.equal(crate().name, "Apple crate", "the rename is kept");
  assert.equal(car().color, "#2244ff", "the colour is kept");
  assert.equal(st.state.physics.ground, "sand", "the ground type is kept");
  assert.ok(!crate().physics?.baked && !car().physics?.baked, "nothing is left baked");
  assert.equal(JSON.stringify(crate().keys), keys0, "the crate is back on its authored keys");
  assert.ok(!st.state.physics.events?.length, "no blast hits left");
});

for (const how of ["disarm", "delete"]) {
  test(`blocker 3: ${how === "disarm" ? "disarming" : "deleting"} an explosion puts the set back as it was before the blast`, () => {
    const st = headless(yard());
    const before = nonRig(st);
    const rig = st.addSfxRig("explosion", { position: [0, 0, 0], sfx: { power: 1.5 } });
    assert.notEqual(nonRig(st), before, "the blast changed the set");
    const n = st._hist.length;
    if (how === "disarm") st.setSfx(rig.id, { armed: false });
    else { st.selected = rig.id; st.removeSelected(); }
    assert.equal(nonRig(st), before, "every object back on its authored keys");
    assert.ok(!st.state.physics.events?.length, "no blast hits left");
    assert.equal(st._hist.length, n + 1, "one Undo step");
    if (how === "delete") assert.ok(!st.state.actors.some((a) => a.id === rig.id), "the rig is gone");
    assert.ok(st.undo());
    assert.ok(st.state.actors.find((a) => a.id === "crate").physics?.baked, "Undo brings the blast back");
  });
}

test("blocker 4: with two explosions, each thing is credited to the blast that threw it (and timed by it)", () => {
  const st = headless([...yard(), at("box", "Box", "crate", [-14, 0, -10]), at("ball", "Ball", "crate", [3, 0, 2], { physics: { mode: "dynamic" } })]);
  const far = st.addSfxRig("explosion", { position: [-14, 0, -12], name: "Far blast", sfx: { trigger: { type: "time", at: 0.5 }, power: 1 } });
  const near = st.addSfxRig("explosion", { position: [3.2, 0, 0], name: "Near blast", sfx: { trigger: { type: "time", at: 2 }, power: 1 } });
  const by = Object.fromEntries(st.state.physics.sfx.affected.map((x) => [x.id, x.by]));
  assert.equal(by.box, far.id, "the box beside the far blast");
  assert.equal(by.crate, near.id, "the crate beside the near blast");
  assert.equal(by.ball, near.id, "a loose (dynamic) prop beside the near blast, not the first one to go off");
});
