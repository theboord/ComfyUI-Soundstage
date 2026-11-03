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
