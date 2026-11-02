// World collisions on the real Stage (headless: its scene graph, keys, setFrame, bake and undo; no WebGL). A keyed police
// car through a parked car is a crash after Simulate & bake; the consequence check finds it before and nothing after;
// one Undo restores the scene; editing a key re-bakes by itself; scrubbing back shows exactly the same frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";

globalThis.window ||= {};
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("car model failed")) _warn(...a); };   // no model files headless: the built cars

function headless(actors, env = { set: "studio" }) {
  const st = Object.create(Stage.prototype);
  const changes = [];
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: env }, view: "clay", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onInteract() {}, onSelect() {}, onShots() {}, _buildLights() {}, _applySun() {},
  });
  // The real onChange: every change records an undo step, and pokes the world re-bake.
  st.onChange = (s) => { if (!st._muteRecord) { st._record(); st._worldPoke(); } changes.push(s); };
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.live = new LiveEdit(st, liveKinds());
  st.setFrame(0);
  st.resetHistory();
  return { st, changes };
}
const car = (id, name, kind, keys, extra = {}) => ({ id, name, kind, position: keys[0].position, keys, rotation_deg: 0, ...extra });
const chase = () => [
  car("police", "Police car", "police_car", [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, 20] }]),
  car("red", "Red car", "sports_car", [{ frame: 0, position: [0.3, 0, 0] }], { rotation_deg: 90 }),
];
const poseOf = (st) => [...st.actorMeshes.entries()].map(([id, g]) => [id, g.position.toArray().map((v) => +v.toFixed(6)), g.quaternion.toArray().map((v) => +v.toFixed(6))]);

test("stage: a police car keyed through a parked car is a crash after Simulate & bake; one Undo puts the scene back exactly", () => {
  const { st } = headless(chase());
  const before = JSON.stringify(st.state);
  const issues = st.consequenceCheck();
  assert.equal(issues.length, 1);
  assert.match(issues[0].text, /^The police car passes through the red car at \d\.\d s: crash them, or reroute\?$/);
  assert.deepEqual(issues[0].fixes.map((f) => f.label), ["Crash them", "Reroute"]);
  const r = st.simulatePhysics();
  assert.ok(r.ok, r.message);
  assert.ok(r.takeovers.police && r.takeovers.red, "both taken over");
  assert.match(r.message, /Police car: physics took over at f \d+ \(\d\.\d s\), hit the red car at \d+ km\/h/);
  const red = st.state.actors.find((a) => a.id === "red");
  assert.ok(red.physics.baked && red.physics.world && red.keys.length > 2, "the red car has the crash in its keys");
  assert.ok(red.physics.dents?.length && red.physics.dents[0].depth > 0.1, "and the crush, as a dent the clay shows");
  assert.equal(st.state.physics.takeovers.red.by, "police");
  assert.deepEqual(st.consequenceCheck(), [], "nothing passes through anything after the bake");
  assert.ok(st.undo());
  assert.equal(JSON.stringify(st.state), before, "one Undo: exactly the scene from before the bake");
});

test("stage: scrubbing back and forth over a baked crash shows exactly the same frames", () => {
  const { st } = headless(chase());
  const at0 = (st.setFrame(0), poseOf(st));
  st.simulatePhysics();
  st.setFrame(80); const p80 = poseOf(st);
  st.setFrame(12); const p12 = poseOf(st);
  st.setFrame(80); assert.deepEqual(poseOf(st), p80);
  st.setFrame(12); assert.deepEqual(poseOf(st), p12);
  // Frame 0 is the authored start (baked keys are stored to the millimetre and 1e-5 in rotation).
  st.setFrame(0);
  poseOf(st).forEach(([id, p, q], i) => { p.forEach((v, k) => assert.ok(Math.abs(v - at0[i][1][k]) < 1e-3, id)); q.forEach((v, k) => assert.ok(Math.abs(v - at0[i][2][k]) < 1e-4, id)); });
  assert.notDeepEqual(p80, p12);
});

test("stage: moving the parked car re-bakes by itself once the edit stops, and one Undo takes back the edit and the re-bake", async () => {
  const { st } = headless(chase());
  st.simulatePhysics();
  const hit0 = st.state.physics.takeovers.red.frame;
  const beforeEdit = JSON.stringify(st.state);
  const red = st.state.actors.find((a) => a.id === "red");
  // Drag it 6 m down the road (an edit on a baked object: it goes into the authored keys).
  red.keys = red.keys.map((k) => ({ ...k, position: [k.position[0], k.position[1], k.position[2] + 6] }));
  st.onChange(st.toJSON());
  assert.ok(st._rebake?.pending(), "a re-bake is waiting for the edits to stop");
  await new Promise((r) => setTimeout(r, 700));
  const hit1 = st.state.physics.takeovers.red.frame;
  assert.ok(hit1 > hit0 + 5, `the crash moved later: f${hit0} -> f${hit1}`);
  assert.equal(st.state.actors.find((a) => a.id === "red").physics.source.keys[0].position[2], 6, "the drag is in its authored keys");
  assert.ok(st.undo());
  assert.equal(JSON.stringify(st.state), beforeEdit, "one Undo: before the drag (and its re-bake)");
});

test("stage: Keep keyed lets the police car pass through, and the check reports it", () => {
  const { st } = headless(chase());
  st.simulatePhysics();
  st.setKeepKeyed("police", true);
  st.setKeepKeyed("red", true);
  assert.deepEqual(st.state.physics.takeovers || {}, {}, "nothing taken over");
  assert.equal(st.consequenceCheck().length, 1);
  st.setKeepKeyed("police", false);
  assert.ok(st.state.physics.takeovers?.police, "off again: the physics takes over at the hit");
});

test("stage: a loose crate stack nobody set up is knocked by a car that keeps its keys; a set street lamp is knocked down", () => {
  const crate = (id, x, y, z) => ({ id, name: id, kind: "crate", position: [x, 0, z], keys: [{ frame: 0, position: [x, y, z] }], height_m: 0.8, rotation_deg: 0, key_y: y > 0 });
  const { st } = headless([car("car", "Car", "car", [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, 20] }]),
    crate("c1", -0.45, 0, 4), crate("c2", 0.45, 0, 4), crate("c3", 0, 0.8, 4)]);
  const r = st.simulatePhysics();
  assert.ok(r.ok, r.message);
  assert.ok(r.takeovers.c1 || r.takeovers.c2, "the crates are knocked");
  assert.equal(r.takeovers.car, undefined, "a 1.5 t car keeps its keys through 25 kg crates");
  assert.ok(st.state.actors.filter((a) => a.physics?.baked).length >= 2);
  // The plaza's post (set dressing) is a street lamp: drive into it.
  const { st: s2 } = headless([car("car", "Car", "car", [{ frame: 0, position: [-8, 0, -18] }, { frame: 96, position: [-8, 0, 22] }])], { set: "plaza" });
  const posts = s2._setKnockables();
  assert.ok(posts.length >= 1, "the plaza has its lamp post");
  const r2 = s2.simulatePhysics();
  assert.ok(r2.ok && s2.state.physics.setTracks, r2.message);
  s2.setFrame(96);
  const m = posts[0].mesh, upY = new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion).y;
  assert.ok(upY < 0.6, `the lamp post is down (up ${upY.toFixed(2)})`);
  s2.setFrame(0);
  assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(m.quaternion).y > 0.999, "scrubbed back, it stands again");
});

test("Director: 'ram' plans the speed by momentum and the bake does the crash; 'check' reports what passes through, with fixes", async () => {
  const { Director } = await import("../../web/agent/director.mjs");
  globalThis.localStorage ||= { getItem: () => null, setItem() {} };
  const { st } = headless([
    car("police", "Police car", "police_car", [{ frame: 0, position: [0, 0, -30] }]),
    car("red", "Red car", "sports_car", [{ frame: 0, position: [0, 0, 0] }]),
    { id: "b1", name: "Box", kind: "crate", position: [0, 0, 9], keys: [{ frame: 0, position: [0, 0, 9] }], height_m: 0.8, rotation_deg: 0 },
  ]);
  st.load = function (scene) { this.state = structuredClone(scene); this._buildSet(); this._setGroup = undefined; };
  st.select = () => {};
  const d = new Director({ api: { fetchApi: async () => ({ ok: false }) }, stage: st, host: {} });
  const out = await d.apply({ command: "the police car rams the red car into the box", calls: [{ tool: "ram", plan: "", args:
    { target: "Police car", target_id: "police", victim: "Red car", victim_id: "red", into: "box", into_ids: ["b1"] } }] });
  assert.ok(out.ok, JSON.stringify(out.said));
  assert.match(out.said[0], /^The police car hits the red car at \d\.\d s doing \d+ km\/h; by momentum \(1900 kg into 1500 kg\) that shoves the red car about \d+ m towards the box\. Physics took over at f \d+/);
  assert.ok(st.state.physics.takeovers.red, "the physics took over the red car");
  const box = st.state.actors.find((a) => a.id === "b1").keys.at(-1).position;
  assert.ok(Math.hypot(box[0], box[2] - 9) > 0.5, `the red car reached the box and moved it (${box})`);
  // Keep both keyed: the check finds the police car passing through, and its fixes become the next-step chips.
  st.setKeepKeyed("police", true); st.setKeepKeyed("red", true);
  const chk = await d.apply({ command: "check", calls: [{ tool: "check", plan: "", args: {} }] });
  assert.match(chk.said[0], /The police car passes through the red car at \d\.\d s: crash them, or reroute\?/);
  assert.deepEqual(chk.next.slice(0, 2).map((x) => x.label), ["Crash them", "Reroute"]);
});

test("Director: the render's consequence check stops a pass-through, but not with Everything collides off or 'anyway'", async () => {
  const { Director, EXEC } = await import("../../web/agent/director.mjs");
  globalThis.localStorage ||= { getItem: () => null, setItem() {} };
  const run = async (setup, args) => {
    const { st } = headless(chase());
    setup(st);
    let rendered = 0;
    const d = new Director({ api: { fetchApi: async () => ({ ok: false }) }, stage: st, host: { pipeline: { _render: async () => { rendered++; } } } });
    const r = await EXEC.render.call(d, { kind: "draft", shots: ["s1"], ...args });
    return { r, rendered };
  };
  const keep = (st) => { st.setKeepKeyed("police", true); st.setKeepKeyed("red", true); };
  const held = await run(keep, {});
  assert.equal(held.r.why, "consequences");
  assert.match(held.r.said, /passes through the red car .*render the draft anyway/);
  assert.equal(held.rendered, 0);
  const anyway = await run(keep, { anyway: "yes" });
  assert.ok(anyway.r.ok && anyway.rendered === 1, JSON.stringify(anyway.r));
  const off = await run((st) => st.setWorldCollisions(false), {});
  assert.ok(off.r.ok && off.rendered === 1, JSON.stringify(off.r));
});

test("Director: 'ram' into a solid wall reports the hit (the wall never moves; the car is the one taken over)", async () => {
  const { Director } = await import("../../web/agent/director.mjs");
  globalThis.localStorage ||= { getItem: () => null, setItem() {} };
  const { st } = headless([car("police", "Police car", "police_car", [{ frame: 0, position: [0, 0, -30] }]),
    { id: "w1", name: "Wall", kind: "wall", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 }]);
  st.load = function (scene) { this.state = structuredClone(scene); this._buildSet(); this._setGroup = undefined; };
  st.select = () => {};
  const d = new Director({ api: { fetchApi: async () => ({ ok: false }) }, stage: st, host: {} });
  const out = await d.apply({ command: "the police car crashes into the wall", calls: [{ tool: "ram", plan: "", args:
    { target: "Police car", target_id: "police", victim: "Wall", victim_id: "w1" } }] });
  assert.equal(st.state.physics.takeovers.police.by, "w1");
  assert.match(out.said[0], /Physics took over at f \d+/);
  assert.doesNotMatch(out.said[0], /never touched/);
});

test("stage: switching Everything collides off puts the cars back on their keys; on again, the crash is back", () => {
  const { st } = headless(chase());
  st.simulatePhysics();
  const crashed = JSON.stringify(st.state.actors);
  st.setWorldCollisions(false);
  assert.ok(!st.state.actors.some((a) => a.physics?.baked), "no world bake left");
  assert.equal(st.state.actors.find((a) => a.id === "police").keys.length, 2, "the authored keys");
  st.setWorldCollisions(true);
  st.simulatePhysics();
  assert.equal(JSON.stringify(st.state.actors), crashed, "the same crash (deterministic)");
});
