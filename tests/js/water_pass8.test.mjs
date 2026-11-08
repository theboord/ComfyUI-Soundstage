// Eighth water pass (Mike, 2026-11-08: "nothing actually has any buoyancy in it... depending on how heavy the object is
// or the person... we need to have swim control", and "when I placed a person in a water tank, they just went to the
// bottom and started walking"). Each test failed on b1f6d51 first. Invented test scenes only.
// node --test tests/js/water_pass8.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import { DriveMode } from "../../web/stage/drive.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };
globalThis.requestAnimationFrame ||= () => 0;
globalThis.cancelAnimationFrame ||= () => {};
globalThis.addEventListener ||= () => {};
globalThis.removeEventListener ||= () => {};

const LEVEL = 2.5;   // the Water tank's level (environments.mjs)
function tank(actors, { frames = 121, keepSet = false } = {}) {
  clearSetCache();
  const st = Object.create(Stage.prototype);
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set: "water_tank" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract(m) { st.said = m; }, onSelect() {}, _buildLights() {},
    canvas: { addEventListener() {}, removeEventListener() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });
  st.scene.add(st.root); st._buildSet(); if (!keepSet) st._setGroup = undefined; st.live = new LiveEdit(st, liveKinds()); st.setFrame(0);
  return st;
}
const man = (id, y = 0, extra = {}) => ({ id, name: id, kind: "man", height_m: 1.8, position: [extra.x ?? 0, y, extra.z ?? 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const prop = (id, kind, y = 0, extra = {}) => ({ id, name: id, kind, position: [extra.x ?? 0, y, extra.z ?? 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const keyed = (id, kind, keys, extra = {}) => ({ id, name: id, kind, height_m: kind === "man" ? 1.8 : undefined, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0, ...extra });
const wp = (o) => o.getWorldPosition(new THREE.Vector3());
const headY = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return wp(g.userData.joints.head).y; };
const lowest = (g) => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g).min.y; };

// ------------------------------------------------------------------ 1. Drive mode in the tank
// Before: the driven man stood at y 0 on the tank floor and walked there with his head 1 m under the 2.5 m surface
// (personStep stood him on _supportAt, the floor; DriveMode.pose returned before the swim ran), the swim flag stayed on
// while the walk cycle ran, and the kept take swam on playback: what you saw driving was not what you kept.
test("Drive mode in the tank: the driven person swims at the surface live, never walks on the floor, and the kept take swims the same", () => {
  const st = tank([man("m", 0, { x: -2, z: -3 })], { frames: 97 });
  st.drive = new DriveMode(st, liveKinds()); st.select = (id) => { st.selected = id; }; st.previewCamera = () => {};
  const g = st.actorMeshes.get("m");
  assert.ok(st.drive.start("m"));
  const inp = { move: [0, 1], mag: 1, sprint: 0 };
  let lowHead = Infinity, walked = 0, swam = 0;
  for (let i = 0; i < 150; i++) {
    st.drive._sim(inp, {}, 1 / 60);
    st.setFrame(st.frame);
    if (i < 10) continue;   // (the first steps: the live history fills)
    lowHead = Math.min(lowHead, headY(st, "m"));
    if (g.userData.gaitOn) walked++;
    if (g.userData.swimOn) swam++;
  }
  assert.equal(walked, 0, `no walk cycle in the water (${walked} steps walking)`);
  assert.equal(swam, 140, `swimming every step (${swam}/140)`);
  assert.ok(lowHead > LEVEL - 0.25, `the head at the water while driven (lowest ${lowHead.toFixed(2)})`);
  assert.ok(g.position.y > 0.6, `off the tank floor (root y ${g.position.y.toFixed(2)})`);
  const b = st.drive.ctl;
  assert.ok(b.speed <= 2.05, `a swimmer's pace, not a run along the bottom (${b.speed.toFixed(2)} m/s)`);
  // record, keep, play back: the same swim
  st.drive.record(); st.drive.rec.left = 0; st.drive._clock(0.01);
  for (let i = 0; i < 60 * 2; i++) { st.drive._sim({ move: [0, 1], mag: 0.5, sprint: 0 }, {}, 1 / 60); if (st.drive.rec?.phase === "rec") st.drive._recStep(); }
  st.drive.stopRec(); st.drive.keep(); st.drive.stop();
  for (let f = 0; f < 48; f++) {
    st.setFrame(f);
    const p = g.position;
    if (!st._inPool(p.x, p.z)) continue;
    assert.ok(g.userData.swimOn && !g.userData.gaitOn, `kept f${f}: swimming, not walking`);
    assert.ok(headY(st, "m") > LEVEL - 0.25, `kept f${f}: the head at the water (${headY(st, "m").toFixed(2)})`);
  }
});
