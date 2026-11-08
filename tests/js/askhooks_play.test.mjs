// node --test tests/js/askhooks_play.test.mjs
// Play is read-only for camera keys: running the real stage.setFrame over every frame of a shot (what the App's Play
// button does each tick) leaves shot.camera_keys, and the whole scene, byte-identical. A shot with no keys yet still
// plays (from the legacy camera) without a key being created, and the flat state.camera_keys field is never written
// by Play (the saved scene from toJSON() carries the active shot's keys there for older readers).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";

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

test("saved scene: after setActiveShot('b') and a play, the flat camera_keys is shot b's (the shot on screen), never shot A's", () => {
  // Shot A keyed; shot b has no keys yet; the live flat field still holds A's keys (an older save / the legacy mirror).
  const A = [{ frame: 0, position: [9, 2, 9], target: [0, 1, 0], focal_mm: 24 }, { frame: 48, position: [-9, 2, 9], target: [0, 1, 0], focal_mm: 24 }];
  const st = playStage([{ id: "a", camera_keys: JSON.parse(JSON.stringify(A)) }, { id: "b" }], "a");
  st.state.camera_keys = JSON.parse(JSON.stringify(A));
  st.setActiveShot("b");
  play(st);
  const saved = st.toJSON();
  assert.notDeepEqual(saved.camera_keys, A, "shot A's keys are not saved as the flat field while b is on screen");
  assert.deepEqual(saved.camera_keys, [{ frame: 0, position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 }], "b films from the scene camera");
  assert.deepEqual(saved.camera_keys, st._camKeysView(), "the flat field is exactly what the stage plays for the shot on screen");
  assert.ok(Math.abs(st.camera.position.x - 0) < 1e-6 && Math.abs(st.camera.position.z - 6) < 1e-6, "on screen: b's camera");
  assert.deepEqual(st.state.camera_keys, A, "the live state is still not written (Play read-only)");
  // b gets keys: the saved flat field follows them; back to A: A's
  st.state.shots[1].camera_keys = [{ frame: 0, position: [3, 1.6, 4], target: [0, 1, 0], focal_mm: 50 }];
  assert.equal(st.toJSON().camera_keys[0].focal_mm, 50);
  st.setActiveShot("a"); play(st);
  assert.deepEqual(st.toJSON().camera_keys, A);
});

test("the look compiler's reader (the Look panel gets stage.toJSON()) sees the shot on screen, not a stale flat field", () => {
  const A = [{ frame: 0, position: [9, 2, 9], target: [0, 1, 0], focal_mm: 24 }];
  const st = playStage([{ id: "a", camera_keys: A }, { id: "b", camera_keys: [{ frame: 0, position: [1, 1.5, 3], target: [0, 1, 0], focal_mm: 85 }] }], "b");
  st.state.camera_keys = A;
  play(st);
  // soundstage/look/scene.py camera_keys(scene) reads scene["camera_keys"] first: the saved copy must be shot b's
  const j = st.toJSON();
  assert.equal(j.camera_keys[0].focal_mm, 85);
  assert.equal(j.camera_keys.length, 1);
});

// ---- through load(), as the App opens a scene (Director loadScene -> stage.load), with someone sitting ----
function loadedStage(scene) {
  const st = Object.create(Stage.prototype);
  st.actorMeshes = new Map(); st.frame = 0; st.camera = new THREE.PerspectiveCamera();
  Object.defineProperty(st, "fw", { value: 1280 }); Object.defineProperty(st, "fh", { value: 720 });
  st.render = () => {}; st.writes = 0; st.onChange = () => { st.writes++; }; st.scene = new THREE.Scene(); st.root = new THREE.Group();
  st._buildSet = () => {   // headless: the objects only, as the App's _buildSet places them
    st.actorMeshes = new Map();
    for (const a of st.state.actors || []) {
      const g = buildObject(a.kind, a.height_m, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })), a.appearance);
      g.position.set(...a.position); g.userData.actorId = a.id; st.scene.add(g); st.actorMeshes.set(a.id, g);
    }
  };
  st._applySun = () => {};
  st.load(scene);
  return st;
}
const cam = { position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 };
const sitters = () => [
  { id: "p", name: "Jon Doe", kind: "man", height_m: 1.8, position: [1, 0, 0], keys: [{ frame: 0, position: [1, 0, 0] }], mount_id: "c", pose: "sit" },
  { id: "c", name: "chair", kind: "chair", height_m: 0.9, position: [1, 0, 0], keys: [{ frame: 0, position: [1, 0, 0] }] },
  { id: "q", name: "Jane Doe", kind: "woman", height_m: 1.7, position: [-1, 0, 0], keys: [{ frame: 0, position: [-1, 0, 0] }], pose: "sit_floor" }];
// Watch the live flat field: any assignment to state.camera_keys counts, even of the same array.
function watchFlat(st) {
  const box = { v: st.state.camera_keys, has: Object.prototype.hasOwnProperty.call(st.state, "camera_keys"), sets: 0 };
  Object.defineProperty(st.state, "camera_keys", { get: () => box.v, set: (x) => { box.sets++; box.v = x; }, enumerable: box.has, configurable: true });
  return box;
}
const scrub = (st) => { for (const f of [30, 3, 48, 0, 17, 47, 1]) st.setFrame(f); };
const firstLast = (st) => { st.setKey("end"); st.setKey("start"); };

test("opened through load() with a sitter: play, scrub and First/Last leave the flat and per-shot camera_keys byte-identical", () => {
  const flat = [{ frame: 0, position: [7, 2, 7], target: [0, 1, 0], focal_mm: 24 }];   // a stale flat field (older save)
  const scene = { shot: { frames: 49, fps: 24 }, camera: cam, actors: sitters(), camera_keys: flat, active_shot: "a",
    shots: [keyed(), { id: "a", camera_keys: [{ frame: 0, position: [1, 1.5, 4], target: [0, 1, 0], focal_mm: 50 }, { frame: 48, position: [3, 1.5, 4], target: [0, 1, 0], focal_mm: 50 }] }, { id: "k" }] };
  for (const active of ["a", "b", "k"]) {   // a keyed shot, another keyed shot, a keyless shot
    const st = loadedStage({ ...JSON.parse(JSON.stringify(scene)), active_shot: active });
    assert.ok(st._sitSpec(st.state.actors[0]), "Jon Doe is seated on the chair");
    const box = watchFlat(st);
    const flatJ = JSON.stringify(st.state.camera_keys), shotsJ = JSON.stringify(st.state.shots.map((x) => x.camera_keys ?? null));
    const all = JSON.stringify(st.state);
    play(st); scrub(st); firstLast(st); play(st);
    assert.equal(box.sets, 0, `shot ${active}: nothing assigned the live flat camera_keys`);
    assert.equal(JSON.stringify(st.state.camera_keys), flatJ, `shot ${active}: flat camera_keys byte-identical`);
    assert.equal(JSON.stringify(st.state.shots.map((x) => x.camera_keys ?? null)), shotsJ, `shot ${active}: every shot's keys byte-identical`);
    assert.equal(JSON.stringify(st.state), all, `shot ${active}: the whole live scene byte-identical`);
    assert.equal(st.writes, 0, "no change was reported (no autosave / undo step)");
  }
});

test("opening a scene writes no keys: load() on a keyless active shot stores no key and creates no flat camera_keys", () => {
  const scene = { shot: { frames: 49, fps: 24 }, camera: cam, actors: sitters(), shots: [{ id: "k" }, keyed()], active_shot: "k" };
  const st = loadedStage(JSON.parse(JSON.stringify(scene)));
  assert.equal(st.state.shots[0].camera_keys, undefined, "the keyless shot got no key from being opened");
  assert.equal(Object.prototype.hasOwnProperty.call(st.state, "camera_keys"), false, "no flat camera_keys field was created");
  assert.deepEqual(st.state.shots, scene.shots, "every shot as it was opened");
  assert.ok(Math.abs(st.camera.position.z - 6) < 1e-6, "it films from the scene camera");
  // viewing another shot and back writes none either
  st.setActiveShot("b"); st.setActiveShot("k"); play(st);
  assert.equal(st.state.shots[0].camera_keys, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(st.state, "camera_keys"), false);
  // an explicit key edit stores the first key (and the flat mirror, for older readers)
  st.setFrame(0); st.setKeyHere();
  assert.equal(st.state.shots[0].camera_keys.length, 1);
  assert.equal(st.state.camera_keys, st.state.shots[0].camera_keys);
});

test("an older scene with no shots: opening it makes one Master shot but writes no keys for a still camera", () => {
  const st = loadedStage({ shot: { frames: 49, fps: 24 }, camera: cam, actors: sitters() });
  assert.equal(st.activeShot().id, "shot_1");
  assert.equal(st.activeShot().camera_keys, undefined, "a still camera: no key stored");
  assert.equal(Object.prototype.hasOwnProperty.call(st.state, "camera_keys"), false, "no flat field created");
  // its start / end move is kept as the Master's keys (the move itself), the flat field still not created
  const mv = loadedStage({ shot: { frames: 49, fps: 24 }, camera: cam, camera_end: { ...cam, position: [4, 1.6, 6] }, actors: [] });
  assert.equal(mv.activeShot().camera_keys.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(mv.state, "camera_keys"), false);
  // a flat-keys scene: the Master shares that array, nothing rewritten
  const fl = [{ frame: 0, ...cam }, { frame: 48, ...cam, focal_mm: 85 }];
  const fk = loadedStage({ shot: { frames: 49, fps: 24 }, camera: cam, camera_keys: fl, actors: [] });
  assert.equal(fk.activeShot().camera_keys, fk.state.camera_keys);
  assert.deepEqual(fk.state.camera_keys, fl);
});
