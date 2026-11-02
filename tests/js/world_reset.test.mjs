// Reset to before (world collisions): every crash or break is instantly reversible. Reset puts the crashed objects back
// byte for byte as one Undo step, a whole crash or one object; a re-bake always starts from the pristine scene, never
// on top of the damage; scrubbing before the impact shows the originals exactly; A/B shows the previous run; and no
// pieces, dents or knocked lamp posts are left behind.
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


/** Two crashes far apart: the police car into the red car, and a hatchback into a crate stack (crates break). */
const twoCrashes = () => [...chase(),
  car("hatch", "Hatchback", "hatchback", [{ frame: 0, position: [30, 0, -20] }, { frame: 96, position: [30, 0, 30] }]),
  ...[[-0.45, 0], [0.45, 0], [0, 0.8]].map(([x, y], i) => ({ id: `cr${i}`, name: `Crate ${i + 1}`, kind: "crate", position: [30 + x, y, 4],
    keys: [{ frame: 0, position: [30 + x, y, 4] }], key_y: y > 0, height_m: 0.8, rotation_deg: 0, physics: { mode: "dynamic" } }))];
const actorsJSON = (st) => JSON.stringify(st.state.actors);
const shardsIn = (st) => { let n = 0; st.root.traverse((o) => { if (o.userData?.shards) n++; }); return n; };

test("reset: the whole scene back to before byte for byte, as one Undo step; no pieces, dents or hits left", () => {
  const { st } = headless(twoCrashes());
  const before = actorsJSON(st);
  st.simulatePhysics();
  st.setFrame(90);
  assert.ok(st.state.actors.some((a) => a.physics?.fracture), "a crate broke");
  assert.ok(shardsIn(st) > 0, "its pieces are in the scene");
  const baked = JSON.stringify(st.state), n0 = st._hist.length;
  const r = st.resetToBefore();
  assert.ok(r.ids.includes("red") && r.ids.includes("cr0"), r.message);
  assert.equal(actorsJSON(st), before, "every object exactly as before the crash");
  assert.equal(st._hist.length, n0 + 1, "one Undo step");
  for (const k of ["events", "takeovers", "pristine", "setTracks", "baked"]) assert.equal(st.state.physics?.[k], undefined, `no ${k} left`);
  st.setFrame(90);
  assert.equal(shardsIn(st), 0, "no leftover fragments in the scene graph");
  assert.equal(st._shards?.size ?? 0, 0);
  for (const a of st.state.actors) assert.ok(st.actorMeshes.get(a.id).visible, `${a.id} whole and visible`);
  // A reset is not an edit: nothing re-bakes the crash back by itself.
  assert.ok(!st._rebake?.pending());
  assert.ok(st.undo());
  assert.equal(JSON.stringify(st.state), baked, "Undo brings the crash back exactly");
});

test("reset one crash: the police car and the red car go back, the other crash stays baked", () => {
  const { st } = headless(twoCrashes());
  const before = JSON.parse(actorsJSON(st));
  st.simulatePhysics();
  assert.deepEqual(st.crashOf("red").sort(), ["police", "red"]);
  const r = st.resetToBefore("red");
  assert.deepEqual(r.ids.sort(), ["police", "red"]);
  for (const id of ["police", "red"]) assert.equal(JSON.stringify(st.state.actors.find((a) => a.id === id)), JSON.stringify(before.find((a) => a.id === id)), id);
  assert.ok(st.state.actors.some((a) => a.physics?.fracture), "the hatchback's broken crate is still there");
  assert.ok(st.state.physics.pristine.cr0, "and can still be reset");
  assert.ok(!st.state.physics.takeovers?.red && !st.state.physics.takeovers?.police);
  assert.ok(!(st.state.physics.events || []).some((e) => ["red", "police"].includes(e.a) || ["red", "police"].includes(e.b)), "their hits are gone");
  // Just the one object, not its crash:
  const { st: s2 } = headless(chase());
  s2.simulatePhysics();
  assert.deepEqual(s2.resetToBefore("red", { event: false }).ids, ["red"]);
  assert.ok(s2.state.actors.find((a) => a.id === "police").physics?.baked);
});

test("a changed key or setting re-bakes from the pristine scene, never on top of the damaged result", () => {
  // Bake, then change the red car's mass and the police car's start key on the baked scene, re-bake ...
  const { st } = headless(chase());
  st.simulatePhysics();
  st.setPhysics("red", { mass: 900 });
  const pol = st.state.actors.find((a) => a.id === "police");
  pol.keys = pol.keys.map((k) => (k.frame === 0 ? { ...k, position: [0.6, 0, -20] } : k));
  st.simulatePhysics();
  st.simulatePhysics();   // and again: a bake of a bake is the same bake
  // ... and it is exactly the bake of a fresh scene authored that way.
  const fresh = chase();
  fresh[0].keys[0].position = [0.6, 0, -20]; fresh[0].position = [0.6, 0, -20];
  fresh[1].physics = { mass: 900, mode: "static" };   // setPhysics writes the mode it shows
  const { st: s2 } = headless(fresh);
  s2.simulatePhysics();
  const A = JSON.parse(actorsJSON(st)), B = JSON.parse(actorsJSON(s2));
  const diff = (x, y, path = "") => { if (JSON.stringify(x) === JSON.stringify(y)) return null; if (typeof x !== "object" || !x || !y) return `${path}: ${JSON.stringify(x)?.slice(0, 80)} vs ${JSON.stringify(y)?.slice(0, 80)}`;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const d = diff(x[k], y[k], `${path}.${k}`); if (d) return d; } return path; };
  assert.equal(diff(A, B), null);
  assert.equal(JSON.stringify(st.state.physics.pristine), JSON.stringify(s2.state.physics.pristine));
  assert.equal(st.state.actors.find((a) => a.id === "red").physics.source.physics.mass, 900, "the mass change is in its authored settings");
});

test("scrubbing before the impact always shows the originals, exactly", () => {
  const { st: plain } = headless(chase());
  const { st } = headless(chase());
  st.simulatePhysics();
  const hit = Math.min(st.state.physics.takeovers.red.frame, st.state.physics.takeovers.police.frame);
  assert.ok(hit > 20);
  const full = (s) => { const out = []; for (const [id, g] of s.actorMeshes) g.traverse((o) => out.push([id, o.position.toArray(), o.quaternion.toArray(), o.visible])); return JSON.stringify(out); };
  for (const f of [0, 5, hit - 10, hit - 1, 3, 0]) {
    st.setFrame(f); plain.setFrame(f);
    assert.equal(full(st), full(plain), `frame ${f}: every part of every object (wheels, body roll) as authored`);
  }
  st.setFrame(hit + 10); plain.setFrame(hit + 10);
  assert.notEqual(full(st), full(plain), "after the impact, the crash");
});

test("A/B: the previous run against this one, both exactly", () => {
  const { st } = headless(chase());
  assert.equal(st.abInfo().available, false);
  st.simulatePhysics();
  const runA0 = JSON.stringify(st.state);
  const red = st.state.actors.find((a) => a.id === "red");
  red.keys = red.keys.map((k) => ({ ...k, position: [k.position[0], 0, 5] }));
  st.simulatePhysics();
  const runB = JSON.stringify(st.state);
  assert.deepEqual(st.abInfo(), { available: true, side: "A" });
  assert.equal(st.toggleAB().side, "B");
  assert.equal(JSON.stringify(st.state), runA0, "B is the previous run, exactly");
  assert.equal(st.toggleAB().side, "A");
  assert.equal(JSON.stringify(st.state), runB, "A is this run, exactly");
  assert.ok(st.state.physics.takeovers.red.frame > JSON.parse(runA0).physics.takeovers.red.frame, "and they differ: the red car is further down the road");
});

test("Director: 'reset_crash' and 'ab' run through the App", async () => {
  const { Director } = await import("../../web/agent/director.mjs");
  globalThis.localStorage ||= { getItem: () => null, setItem() {} };
  const { st } = headless(chase());
  const before = actorsJSON(st);
  st.simulatePhysics();
  const d = new Director({ api: { fetchApi: async () => ({ ok: false }) }, stage: st, host: {} });
  const out = await d.apply({ command: "reset the red car", calls: [{ tool: "reset_crash", plan: "", args: { target: "Red car", target_id: "red" } }] });
  assert.ok(out.ok, out.said[0]);
  assert.match(out.said[0], /^Reset to before: Red car, Police car exactly as they were before the crash/);
  assert.equal(actorsJSON(st), before);
  const ab = await d.apply({ command: "a/b", calls: [{ tool: "ab", plan: "", args: {} }] });
  assert.equal(ab.ok, false, "a reset leaves nothing to compare");
});
