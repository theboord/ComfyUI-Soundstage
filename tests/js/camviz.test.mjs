// Key cameras in the 3D stage: which key is "hot", how big they get, and the frustum's aspect.
import test from "node:test";
import assert from "node:assert/strict";
import { nearestKey, keyCamBase, keyCamFrustum, topViewHint } from "../../web/stage/camviz.mjs";

test("nearestKey: the key at the playhead, else the nearest in time (earlier on a tie)", () => {
  const keys = [{ frame: 0 }, { frame: 24 }, { frame: 48 }];
  assert.equal(nearestKey(keys, 24), 1);
  assert.equal(nearestKey(keys, 30), 1);
  assert.equal(nearestKey(keys, 36), 1);
  assert.equal(nearestKey(keys, 47), 2);
  assert.equal(nearestKey([], 5), -1);
});

test("keyCamBase grows with the move's size but stays between 0.25 and 1.5 m", () => {
  assert.equal(keyCamBase(0), 0.25);
  assert.ok(keyCamBase(20) > keyCamBase(5));
  assert.equal(keyCamBase(1000), 1.5);
  assert.equal(keyCamBase(NaN), 0.25);
});

test("keyCamFrustum: wider lens = wider frame, in the shot's aspect", () => {
  const w = keyCamFrustum(18, 16 / 9), t = keyCamFrustum(85, 16 / 9);
  assert.ok(w.x > t.x);
  assert.ok(Math.abs(w.x / w.y - 16 / 9) < 1e-9);
  assert.ok(Math.abs(keyCamFrustum(35, 2.39).x / keyCamFrustum(35, 2.39).y - 2.39) < 1e-9);
});

// ------------------------------------------------------------------ the path is the camera the shot films

// No DOM in node: key-number labels draw onto a canvas that does nothing.
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: (o, k) => (k === "measureText" ? (t) => ({ width: String(t).length * 18 }) : k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } }) }) };

async function headlessStage() {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const THREE = await import("../../web/vendor/three.module.min.mjs");
  const { Stage } = await import("../../web/stage/stage.mjs");
  const { policeChase } = await import("../../web/tryit/scenes.mjs");
  globalThis.ProgressEvent ??= class ProgressEvent extends Event {
    constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
    return realFetch(input, init);
  };
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...policeChase(), environment: { set: "studio" } }, view: "clay", key: "start", frame: 0, actorMeshes: new Map(),
    root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.onChange = () => {};
  st.scene.add(st.root);
  try { st._buildSet(); } catch { /* not needed here */ }
  st._setGroup = undefined;
  st.state.active_shot = "crane";
  st.setFrame(0);
  return st;
}

test("CameraViz draws the camera the shot films (_shotCameraAt), and rebuilds when the rig or the ride-along host changes", async () => {
  const { CameraViz, shotPathSig } = await import("../../web/stage/camviz.mjs");
  const st = await headlessStage();
  const viz = new CameraViz(st, { showInShot: true });
  const same = () => viz._frames.every((f, i) => viz._pts[i].toArray().every((v, j) => Math.abs(v - st._shotCameraAt(f).position[j]) < 1e-6));
  for (const rig of ["free", "jib", "tripod", "handheld", "drone_fpv"]) {
    st.setRig(rig);
    viz._sync();
    assert.ok(same(), `${rig}: path = shot camera`);
  }
  assert.ok(viz.keyedLine === null || viz.keyedLine, "keyed ghost is optional");
  st.setRig("tripod");
  viz._sync();
  assert.ok(viz.keyedLine, "a tripod that stays put shows the keyed move it can't make as a ghost");
  st.setRig("free");
  viz._sync();
  assert.equal(viz.keyedLine, null, "no ghost when the camera follows the keys");
  // Ride-along: the path moves with its car.
  st.setActiveShot("tracking");
  st.setRig("handheld");
  viz._sync();
  const sig = shotPathSig(st), before = viz._pts[30].clone();
  const car = st.state.actors.find((a) => a.id === "sports_car");
  for (const k of car.keys) k.position = [k.position[0] + 5, k.position[1], k.position[2]];
  assert.notEqual(shotPathSig(st), sig);
  viz._sync();
  assert.ok(Math.abs(viz._pts[30].distanceTo(before) - 5) < 1e-6 && same());
  viz.dispose();
});

// ------------------------------------------------------------------ Top view hover hint (2026-11-01)

test("topViewHint: hovering the camera path, a key, its aim or the playhead never looks up cast keys (no 'reading keys' throw)", () => {
  let calls = 0;
  const keysOf = (a) => { calls++; return a.keys; };   // like stage._actorKeys: throws on undefined
  assert.equal(topViewHint(null, keysOf), null);
  assert.match(topViewHint({ kind: "key", i: 0 }, keysOf), /^Key 1 · drag to move/);
  assert.match(topViewHint({ kind: "target", i: 2 }, keysOf), /^Aim of key 3/);
  assert.match(topViewHint({ kind: "path", frame: 12 }, keysOf), /^Frame 12 · click = new key/);
  assert.match(topViewHint({ kind: "playhead" }, keysOf), /^Playhead/);
  assert.equal(calls, 0);
  const car = { id: "sports_car_1", name: "Sports car 1", kind: "sports_car", keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 48, position: [0, 0, 9] }] };
  assert.equal(topViewHint({ kind: "akey", a: car, j: 1 }, keysOf), "Sports car 1 · key 2 (frame 48) · drag to move · right-click = delete");
  assert.equal(topViewHint({ kind: "actor", a: car }, keysOf), "Sports car 1 · drag to move (keys it at the playhead)");
  assert.equal(calls, 1);
});
