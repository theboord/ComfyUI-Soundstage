// node --test tests/js/heldprop.test.mjs
// A small prop that lives in someone's hand (the brass key in Last Light on Route 9): actor.hold puts it at the
// wrist's grip point and turns it with the hand, actor.toss flies it ballistically to a mark and bounces it once,
// a hold with `ease` snatches it up from where it lay, and by_shot[shot] gives one setup its own timing (the shots of
// a scene share a timeline: the toss is at 0.3 s in 1D, the landing at 0.2 s in 1L, the snatch at 0.1 s in 1N).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject, LIBRARY } from "../../web/stage/library.mjs";

const mesh = (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color }));

function stage({ keyActor, active = "wide" }) {
  const st = Object.create(Stage.prototype);
  const ezra = { id: "ezra", kind: "man", height_m: 1.83, position: [-4.5, 0, 0], keys: [{ frame: 0, position: [-4.5, 0, 0] }] };
  const mara = { id: "mara", kind: "woman", height_m: 1.7, position: [4.5, 0, 0], keys: [{ frame: 0, position: [4.5, 0, 0] }] };
  st.state = { shot: { frames: 97, fps: 24 }, actors: [ezra, mara, keyActor], shots: [{ id: "wide" }, { id: "1L" }], active_shot: active };
  st.actorMeshes = new Map();
  for (const a of [ezra, mara]) {
    const g = buildObject(a.kind, a.height_m, mesh);
    g.position.set(...a.position);
    st.actorMeshes.set(a.id, g);
  }
  const kg = buildObject("key", null, mesh);
  st.actorMeshes.set(keyActor.id, kg);
  st.place = (f) => { const p = st._actorPosAt(keyActor, f); kg.position.set(...p); kg.rotation.set(0, 0, 0); st._heldPropsAt(f); return kg; };
  return st;
}
const DIRT = [0.3, 0, -0.15];

test("the key is a real ~6 cm object lying flat", () => {
  assert.ok(LIBRARY.key && LIBRARY.key.rig === "static");
  const g = buildObject("key", null, mesh);
  const s = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
  assert.ok(s.z > 0.05 && s.z < 0.08, `length ${s.z}`);
  assert.ok(s.y < 0.012, `flat (${s.y})`);
});

test("held: the key sits at the hand's grip point and moves with the hand", () => {
  const key = { id: "key", kind: "key", keys: [{ frame: 0, position: DIRT }], hold: [{ from: 0, to: 96, actor: "ezra", hand: "l" }] };
  const st = stage({ keyActor: key });
  const g = st.place(10);
  const grip = st._handGrip("ezra", "l").p;
  assert.ok(g.position.distanceTo(grip) < 1e-6);
  assert.ok(g.position.y > 0.6 && g.position.y < 1.4, `hand height ${g.position.y}`);
  assert.ok(g.position.distanceTo(new THREE.Vector3(-4.5, 0, 0)) < 1.2, "next to Ezra, not on the dirt mark");
  // the right hand is a different place: the hand matters
  key.hold[0].hand = "r";
  assert.ok(st.place(10).position.distanceTo(grip) > 0.1);
});

test("tossed: released from the hand, a ballistic arc (gravity), lands on the mark on time, one bounce, then still", () => {
  const key = { id: "key", kind: "key", keys: [{ frame: 0, position: DIRT }], hold: [{ from: 0, to: 7, actor: "ezra", hand: "l" }],
    toss: { from: 7, to: 34, land: DIRT, bounce: 6 } };
  const st = stage({ keyActor: key });
  const release = st.place(7).position.clone();
  const ys = [], xs = [];
  for (let f = 7; f <= 34; f++) { const p = st.place(f).position; ys.push(p.y); xs.push(p.x); }
  assert.ok(ys[0] - release.y < 1e-6 && Math.abs(xs[0] - release.x) < 1e-6, "leaves from the hand");
  const top = Math.max(...ys);
  assert.ok(top > release.y + 0.05, "it rises before it falls");
  assert.ok(Math.abs(ys.at(-1) - DIRT[1]) < 1e-6 && Math.abs(xs.at(-1) - DIRT[0]) < 1e-6, "lands on the mark at frame 34 (1.4 s)");
  // constant gravity: the second difference of height is -g/fps² every frame
  const d2 = ys.slice(2).map((y, i) => y - 2 * ys[i + 1] + ys[i]);
  for (const d of d2) assert.ok(Math.abs(d + 9.81 / 576) < 1e-6, `gravity ${d}`);
  // x moves at a constant rate (no drag on a 6 cm key over 9 m... near enough)
  const dx = xs.slice(1).map((x, i) => x - xs[i]);
  for (const d of dx) assert.ok(Math.abs(d - dx[0]) < 1e-9);
  assert.ok(st.place(37).position.y > 0.005, "bounces once");
  assert.ok(Math.abs(st.place(41).position.y) < 1e-9, "then lies still on the mark");
  assert.deepEqual(st.place(90).position.toArray().map((v) => +v.toFixed(6)), DIRT.map((v) => +v.toFixed(6)));
});

test("snatched: a hold with ease flies it from the dirt into the other rider's hand", () => {
  const key = { id: "key", kind: "key", keys: [{ frame: 0, position: DIRT }], hold: [{ from: 32, to: 96, actor: "mara", hand: "l", ease: 3 }] };
  const st = stage({ keyActor: key });
  assert.ok(st.place(31).position.distanceTo(new THREE.Vector3(...DIRT)) < 1e-9, "in the dirt before the snatch");
  const grip = () => st._handGrip("mara", "l").p;
  const mid = st.place(33).position.clone();
  assert.ok(mid.distanceTo(grip()) > 0.01 && mid.distanceTo(new THREE.Vector3(...DIRT)) > 0.01, "on its way up");
  assert.ok(st.place(35).position.distanceTo(grip()) < 1e-6, "in her hand");
});

test("by_shot: a setup keeps its own timing; the others use the prop's own plan and keys", () => {
  const key = { id: "key", kind: "key", keys: [{ frame: 0, position: DIRT }], hold: [{ from: 0, to: 96, actor: "ezra", hand: "l" }],
    by_shot: { "1L": { keys: [{ frame: 0, position: [1, 0, 1] }], hold: [{ from: 0, to: -12, actor: "ezra", hand: "l" }], toss: { from: -12, to: 8, land: [1, 0, 1], bounce: 6 } } } };
  const wide = stage({ keyActor: key, active: "wide" });
  assert.ok(wide.place(20).position.distanceTo(wide._handGrip("ezra", "l").p) < 1e-6, "in Ezra's hand in the wide");
  const ins = stage({ keyActor: key, active: "1L" });
  assert.ok(ins.place(0).position.y > 0.2, "mid-air at frame 0 of the insert");
  assert.ok(Math.abs(ins.place(8).position.y) < 1e-9 && Math.abs(ins.place(8).position.x - 1) < 1e-9, "lands at frame 8 on the insert's mark");
  assert.deepEqual(ins._actorKeys(key), key.by_shot["1L"].keys);
  assert.deepEqual(wide._actorKeys(key), key.keys);
});

test("a render that flipped active_shot leaves the set posed for the other setup: the viewport re-poses it", () => {
  const st = Object.create(Stage.prototype);
  st.state = { actors: [{ id: "key", by_shot: { "1L": {} } }], active_shot: "1K" };
  st._camShot = "1L";   // an older caller flipped to 1L around a render and put 1K back without a setFrame
  const calls = [];
  st.frame = 12; st.setFrameSilent = (f) => { calls.push(["pose", f]); st._camShot = st.state.active_shot; }; st._applyCamera = () => calls.push(["cam"]);
  assert.equal(st._syncShotCamera(), true);
  assert.deepEqual(calls, [["pose", 12]], "the whole set, not only the camera");
  assert.equal(st._syncShotCamera(), false, "once");
  st.state.actors = [{ id: "car" }]; st._camShot = "1L"; calls.length = 0;
  st._syncShotCamera();
  assert.deepEqual(calls, [["cam"]], "without shot blocking only the camera moves, as before");
});

test("a horse that gallops in one setup (by_shot) kicks up no dust in a setup where it stands", () => {
  const st = Object.create(Stage.prototype);
  const dun = { id: "dun", kind: "horse", keys: [{ frame: 0, position: [4.5, 0, 0] }], by_shot: { "1M": { keys: [{ frame: 0, position: [4.5, 0, 0] }, { frame: 40, position: [-1.3, 0, -1.5] }] } } };
  st.state = { shot: { frames: 97, fps: 24 }, actors: [dun], active_shot: "1D" };
  st._gaitCache = new WeakMap([[dun, { sig: "gallop", g: {}, plan: { strikes: [{ f: 3 }] } }]]);   // left by a 1M render
  assert.equal(st._gaitPlan(dun, {}, "horse"), null);
  assert.equal(st._gaitCache.has(dun), false, "the 1M gallop's strikes are gone");
});
