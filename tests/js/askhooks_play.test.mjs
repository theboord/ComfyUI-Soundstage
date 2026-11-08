// node --test tests/js/askhooks_play.test.mjs
// Play is read-only for camera keys: running the real stage.setFrame over every frame of a shot (what the App's Play
// button does each tick) leaves shot.camera_keys, and the whole scene, byte-identical. A shot with no keys yet still
// plays (from the legacy camera) without a key being created, and the flat state.camera_keys field is never written
// by Play (the saved scene from toJSON() carries the active shot's keys there for older readers).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";

function playStage(shots, active) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 49, fps: 24 }, actors: [], shots, active_shot: active,
    camera: { position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 } };
  st.actorMeshes = new Map(); st.frame = 0; st.camera = new THREE.PerspectiveCamera();
  Object.defineProperty(st, "fw", { value: 1280 }); Object.defineProperty(st, "fh", { value: 720 });
  st.render = () => {}; st.onChange = () => {};
  return st;
}
const play = (st) => { for (let f = 0; f < st.state.shot.frames; f++) st.setFrame(f); };
const keyed = () => ({ id: "b", camera_keys: [{ frame: 0, position: [0, 1.6, 5], target: [0, 1, 0], focal_mm: 35 },
  { frame: 48, position: [2, 1.6, 5], target: [0, 1, 0], focal_mm: 50 }] });

test("playing a keyed shot leaves camera_keys, the flat field and the whole live scene byte-identical", () => {
  // No flat camera_keys field preset: before the read-only Play, the first played frame wrote state.camera_keys.
  const st = playStage([{ id: "a", camera_keys: [{ frame: 0, position: [1, 2, 3], target: [0, 0, 0], focal_mm: 28 }] }, keyed()], "b");
  const keys = JSON.stringify(st.state.shots[1].camera_keys);
  const all = JSON.stringify(st.state);
  play(st);
  assert.equal(JSON.stringify(st.state.shots[1].camera_keys), keys);
  assert.equal(st.state.camera_keys, undefined, "Play wrote no flat camera_keys field");
  assert.equal(JSON.stringify(st.state), all, "nothing else in the scene is written either");
  assert.ok(Math.abs(st.camera.position.x - 2) < 1e-6, "the camera did move along the keys");
});

test("playing a shot with no camera keys (on a handheld rig) creates none", () => {
  const st = playStage([{ id: "a", rig: { type: "handheld", amount: 1 } }, keyed()], "a");
  const all = JSON.stringify(st.state);
  play(st);
  assert.equal(st.state.shots[0].camera_keys, undefined, "no key was stored on the shot");
  assert.equal(JSON.stringify(st.state), all);
});

test("a preset that swaps a shot's keys array: Play still writes nothing live, the saved scene's flat field follows", () => {
  const st = playStage([keyed()], "b");
  st.state.camera_keys = keyed().camera_keys;   // a stale flat field from an older save
  const fresh = [{ frame: 0, position: [5, 1.6, 5], target: [0, 1, 0], focal_mm: 85 }];
  st.state.shots[0].camera_keys = fresh;   // a preset hands the shot a new array
  const stale = st.state.camera_keys, all = JSON.stringify(st.state);
  play(st);
  assert.equal(st.state.camera_keys, stale, "Play did not re-point the live flat field");
  assert.equal(JSON.stringify(st.state), all);
  assert.ok(Math.abs(st.camera.position.x - 5) < 1e-6, "Play filmed the shot's own (new) keys");
  assert.equal(st.toJSON().camera_keys[0].focal_mm, 85, "older readers of the saved scene see the active shot's keys");
});

test("keyInfo (the key strip drawn while scrubbing) is read-only too; editing still stores the first key", () => {
  const st = playStage([{ id: "a" }], "a");
  assert.deepEqual(st.keyInfo().camera, [0]);
  assert.equal(st.state.shots[0].camera_keys, undefined);
  st._camKeys();   // the edit path
  assert.equal(st.state.shots[0].camera_keys.length, 1);
});
