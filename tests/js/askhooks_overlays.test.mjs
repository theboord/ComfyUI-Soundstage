// node --test tests/js/askhooks_overlays.test.mjs
// Play is read-only for camera keys in the App too, not just headless: the viewport overlays that run on every render
// (shotPathSig, the CameraViz path rebuild, the TopView key read, the Tracks rows, the Parts key frames) read the keys
// without storing one. A keyless shot stays keyless and a keyed shot's keys, and the whole live scene, stay
// byte-identical (no flat camera_keys mirror written either). Invented scenes only.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";

// No DOM in node: key-number labels draw onto a canvas that does nothing.
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => new Proxy({}, { get: (o, k) => (k === "measureText" ? (t) => ({ width: String(t).length * 18 }) : k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } }) }) };

const { Stage } = await import("../../web/stage/stage.mjs");
const { shotPathSig, CameraViz, TopView } = await import("../../web/stage/camviz.mjs");
const { TrackSheet } = await import("../../web/stage/tracks.mjs");

function stageWith(shots, active) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 49, fps: 24 }, actors: [], shots, active_shot: active,
    camera: { position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 } };
  st.actorMeshes = new Map(); st.frame = 0; st.camera = new THREE.PerspectiveCamera();
  Object.defineProperty(st, "fw", { value: 1280 }); Object.defineProperty(st, "fh", { value: 720 });
  st.render = () => {}; st.onChange = () => {};
  return st;
}
const keyedA = () => ({ id: "a", camera_keys: [{ frame: 0, position: [0, 1.6, 5], target: [0, 1, 0], focal_mm: 35 },
  { frame: 48, position: [2, 1.6, 5], target: [0, 1, 0], focal_mm: 50 }] });
const keyedB = () => ({ id: "b", rig: { type: "handheld", amount: 1 },
  camera_keys: [{ frame: 0, position: [-1, 1.2, 4], target: [0, 1, 0], focal_mm: 28 }] });

/** Every read-only overlay path, as the App runs them on a render. */
function runOverlays(st) {
  const sig = shotPathSig(st);
  const viz = Object.create(CameraViz.prototype);
  Object.assign(viz, { stage: st, pathGroup: new THREE.Group() });
  viz._rebuildPath();
  const top = Object.create(TopView.prototype);
  top.stage = st;
  const topKeys = top._keys();
  const rows = Object.create(TrackSheet.prototype);
  rows.stage = st;
  const camRow = rows._rows()[0];
  const focal = st._camKeyFrames ? st._camKeyFrames("focal_mm") : null;
  return { sig, viz, topKeys, camRow, focal };
}

for (const [label, shots, active] of [
  ["a keyless shot", () => [{ id: "k" }, keyedA()], "k"],
  ["a keyed shot", () => [keyedA(), keyedB()], "a"],
  ["a keyed handheld shot", () => [keyedA(), keyedB()], "b"],
]) {
  test(`the viewport overlays leave ${label}'s camera keys and the live scene byte-identical`, async () => {
    await import("../../web/stage/objparts.mjs").catch(() => {});   // the Parts mixin (focal_mm key frames), if present
    const st = stageWith(shots(), active);
    const before = JSON.stringify(st.state);
    const keysBefore = st.state.shots.map((s) => JSON.stringify(s.camera_keys));
    const { sig, viz, topKeys, camRow } = runOverlays(st);
    assert.ok(sig.length > 0);
    assert.ok(viz.keyMarks.length >= 1, "the path still draws a diamond per key");
    assert.equal(camRow.kind, "camera");
    assert.ok(topKeys.length >= 1 && camRow.keys.length >= 1, "the fallback key is shown, just not stored");
    for (let f = 0; f < 49; f += 6) { st.setFrame(f); runOverlays(st); }
    assert.deepEqual(st.state.shots.map((s) => JSON.stringify(s.camera_keys)), keysBefore);
    assert.equal(st.state.camera_keys, undefined, "the flat mirror is not written on the live state");
    assert.equal(JSON.stringify(st.state), before);
  });
}

test("a keyless shot: the overlays store no key, but an edit (TopView insert) still does", () => {
  const st = stageWith([{ id: "k" }], "k");
  runOverlays(st);
  assert.equal(st.state.shots[0].camera_keys, undefined);
  const top = Object.create(TopView.prototype);
  Object.assign(top, { stage: st, onFrame: null, onKeysChanged: null });
  top._insertKey(24);
  assert.equal(st.state.shots[0].camera_keys.length, 2, "the fallback key and the new one are stored by the edit");
});

test("the saved scene (toJSON) still carries the flat camera_keys mirror of the active shot, for older readers", () => {
  const st = stageWith([keyedA(), keyedB()], "b");
  const out = st.toJSON();
  assert.deepEqual(out.camera_keys, keyedB().camera_keys);
  assert.notEqual(out.camera_keys, out.shots[1].camera_keys, "a copy in the saved scene, not the live array");
  assert.equal(st.state.camera_keys, undefined, "toJSON writes nothing on the live state");
  st.state.shots[1].camera_keys = [{ frame: 0, position: [5, 1.6, 5], target: [0, 1, 0], focal_mm: 85 }];   // a preset swaps the array
  assert.equal(st.toJSON().camera_keys[0].focal_mm, 85);
  assert.equal(stageWith([{ id: "k" }], "k").toJSON().camera_keys, undefined, "a keyless shot gets no mirror");
});
