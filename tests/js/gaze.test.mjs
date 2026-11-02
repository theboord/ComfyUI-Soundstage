// Head and gaze blocking (web/stage/gaze.mjs): keys, limits, eased turns that start at the key, and the headless
// stage: a blocked turn happens at its frame and points at the target; an unblocked head never turns.
// node --test tests/js/gaze.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { gazeKeys, setGazeKey, clearGaze, splitLook, lookAt, turnFrames, EYES_ONLY, HEAD_NECK_MAX, SPINE_MAX } from "../../web/stage/gaze.mjs";

globalThis.ProgressEvent ??= class extends Event {};

function headless(actors, frames = 97) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set: "studio" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}
const person = (id, kind, x, z, extra = {}) => ({ id, name: id, kind, position: [x, 0, z], keys: [{ frame: 0, position: [x, 0, z] }],
  height_m: 1.75, rotation_deg: 0, ...extra });

const DEG = 180 / Math.PI;
/** World yaw of a figure's head (deg, 0 = +Z, + toward +X) and of its body root. */
function yaws(st, id) {
  const g = st.actorMeshes.get(id);
  g.updateMatrixWorld(true);
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(g.userData.joints.head.getWorldQuaternion(new THREE.Quaternion()));
  const b = new THREE.Vector3(0, 0, 1).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion()));
  return { head: Math.atan2(f.x, f.z) * DEG, body: Math.atan2(b.x, b.z) * DEG };
}
const wrap = (d) => ((d % 360) + 540) % 360 - 180;

test("keys: set, replace, clear; the legacy look_at fields read as keys", () => {
  const a = { look_at: "b", look_at_frame: 10, look_until: 40 };
  assert.deepEqual(gazeKeys(a), [{ frame: 10, target: "b" }, { frame: 40, target: "ahead" }]);
  setGazeKey(a, 60, "camera");
  assert.equal(a.look_at, undefined);
  assert.deepEqual(a.gaze.map((k) => k.frame), [10, 40, 60]);
  setGazeKey(a, 40, "left");
  assert.deepEqual(a.gaze.map((k) => k.target), ["b", "left", "camera"]);
  clearGaze(a, 10);
  assert.equal(a.gaze.length, 2);
  clearGaze(a);
  assert.equal(a.gaze, undefined);
  assert.deepEqual(gazeKeys({}), []);
});

test("natural limits: eyes first, head + neck to 80°, the chest beyond, nothing past 128°", () => {
  let s = splitLook(5, 0);
  assert.equal(s.head[1], 0);                       // a 5° look is the eyes alone
  s = splitLook(60, 0);
  assert.ok(Math.abs(s.head[1] + s.neck[1] - (60 - EYES_ONLY)) < 1e-9);
  assert.ok(s.head[1] > s.neck[1]);                 // the head turns more than the neck
  s = splitLook(-170, 0);
  assert.ok(Math.abs(s.head[1] + s.neck[1]) <= HEAD_NECK_MAX + 1e-9);
  assert.equal(s.spine, -SPINE_MAX);
  s = splitLook(0, 80);                             // looking up: a backward bend, capped
  assert.ok(s.head[0] < 0 && s.head[0] >= -35 && s.neck[0] >= -15);
});

test("eased turns start at the key, take longer the further they go, and land on the target", () => {
  assert.ok(turnFrames(90) > turnFrames(20));
  assert.ok(turnFrames(180) <= Math.round(24 * 0.8));
  const keys = [{ frame: 48, target: "left" }];
  const ang = (t) => ({ left: { yaw: 60, pitch: 0 }, ahead: { yaw: 0, pitch: 0 } })[t];
  assert.equal(lookAt(keys, 47, ang).yaw, 0);
  assert.equal(lookAt(keys, 48, ang).yaw, 0);       // the turn STARTS at 2 s
  const mid = lookAt(keys, 48 + turnFrames(60) / 2, ang);
  assert.ok(mid.turning && mid.yaw > 20 && mid.yaw < 40);
  assert.equal(lookAt(keys, 48 + turnFrames(60), ang).yaw, 60);
  assert.equal(lookAt([], 30, ang).yaw, 0);
});

test("stage: a turn blocked at 2 s happens then and points at the target; an unblocked head never turns", () => {
  const st = headless([person("ben", "man", 0, 0), person("ellie", "woman", 3, 3)]);
  st.setGaze("ben", 48, "ellie");
  const want = Math.atan2(3, 3) * DEG;                           // ellie from ben: 45° toward +X
  const before = [0, 20, 40, 47].map((f) => { st.setFrame(f); return yaws(st, "ben"); });
  for (const y of before) assert.ok(Math.abs(wrap(y.head - y.body)) < 1.5, `head held before the key (${y.head.toFixed(1)}°)`);
  st.setFrame(48 + turnFrames(want));
  const after = yaws(st, "ben");
  assert.ok(Math.abs(wrap(after.head - want)) <= EYES_ONLY + 2, `head toward Ellie (${after.head.toFixed(1)}° vs ${want.toFixed(1)}°)`);
  // the unblocked one: idle sway cancelled, the head stays square to the body all shot
  let worst = 0;
  for (let f = 0; f < 97; f += 4) { st.setFrame(f); const y = yaws(st, "ellie"); worst = Math.max(worst, Math.abs(wrap(y.head - y.body))); }
  assert.ok(worst < 1, `unblocked head moved ${worst.toFixed(2)}°`);
});

test("stage: a walker's head faces the travel direction through the walk cycle", () => {
  const w = person("walker", "man", 0, 0, { keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 96, position: [0, 0, 12] }], position_end: [0, 0, 12] });
  const st = headless([w]);
  let worst = 0;
  for (let f = 10; f < 90; f += 3) { st.setFrame(f); worst = Math.max(worst, Math.abs(wrap(yaws(st, "walker").head))); }
  assert.ok(worst < 1.5, `walking head swung ${worst.toFixed(2)}° off the travel direction`);
});

test("stage: the Interact menu's Look at and Talk write gaze keys", () => {
  const st = headless([person("a", "man", 0, 0), person("b", "woman", 2, 0)]);
  st.frame = 24;
  st.interact("a", "b", "look_at");
  assert.deepEqual(st.state.actors[0].gaze, [{ frame: 24, target: "b" }]);
  st.frame = 60;
  st.interact("a", "b", "stop_look");
  assert.deepEqual(st.state.actors[0].gaze.map((k) => k.target), ["b", "ahead"]);
});
