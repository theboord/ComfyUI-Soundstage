// node --test tests/js/camkey_reads.test.mjs
// Reading the shot camera never keys it. Found in the browser check of the smooth camera curve: View nav's 250 ms poll
// (web/stage/viewnav.mjs) read the view through stage._activeOrbit(), which in the shot-camera view auto-keys the shot at
// the playhead (_editCamera). So an old saved shot got a new camera key wherever the playhead rested, and was moved onto
// camera curve version 2 within a quarter of a second of being opened. Reads now go through stage._peekOrbit().
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { installViewNav } from "../../web/stage/viewnav.mjs";
import { installNavigation } from "../../web/stage/navigation.mjs";

function headless(scene) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: structuredClone(scene),
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.state.environment = { ...(st.state.environment || {}), set: "studio" };
  st.onChange = () => {};
  st.scene.add(st.root);
  try { st._buildSet(); } catch { /* not what these tests look at */ }
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}

// An "old" shot: saved before curve version 2 (no cam_curve), four uneven camera keys.
const oldScene = () => ({ shot: { frames: 121, fps: 24 }, actors: [], camera: { position: [0, 1.6, -8], target: [0, 1.2, 0], focal_mm: 35 },
  shots: [{ id: "old", name: "Old", setup: "single", camera_keys: [0, 48, 96, 120].map((frame, i) => ({ frame, position: [3 * i, 1.6, -8 + i], target: [3 * i, 1.2, 0], focal_mm: 35 + 5 * i })) }],
  active_shot: "old" });

test("View nav reading the view in the shot camera adds no key and keeps an old shot on its old curve", () => {
  const st = headless(oldScene());
  st.freeView = false;
  const nav = installViewNav(st);
  const shot = st.activeShot();
  const before = JSON.stringify(shot);
  const cam52 = st._cameraAt(52);
  for (const f of [10, 30, 52, 70, 100]) { st.frame = f; nav.mark0(); }
  assert.equal(JSON.stringify(shot), before, "no camera key, no cam_curve");
  assert.equal(st.cameraCurve(), "legacy");
  assert.deepEqual(st._cameraAt(52), cam52, "same camera at frame 52");
});

test("_peekOrbit: the shot camera at the playhead (a copy) or the free view; never writes a key", () => {
  const st = headless(oldScene());
  st.freeView = false; st.frame = 52;
  const p = st._peekOrbit();
  assert.deepEqual(p.position, st._cameraAt(52).position);
  p.position[0] = 999;
  assert.notEqual(st._cameraAt(52).position[0], 999, "a copy");
  assert.equal(st.activeShot().camera_keys.length, 4);
  assert.equal(st.activeShot().cam_curve, undefined);
  st.freeView = true; st.free = { position: [1, 2, 3], target: [0, 0, 0] };
  assert.equal(st._peekOrbit(), st.free);
  // the held-key speed check reads, too
  st.freeView = false; st.frame = 70;
  try { st._tightNow(); } catch { /* set colliders may be missing headless; what counts is no key */ }
  assert.equal(st.activeShot().camera_keys.length, 4, "_tightNow adds no key");
});

test("navigation: a hit test (pivotAt) and a refused double-click focus in the shot camera don't key the shot", () => {
  let keyed = 0;
  const st = {
    freeView: false, free: { position: [9, 3, 9], target: [0, 1, 0] }, actorMeshes: new Map(), camera: { fov: 50, aspect: 1.6 }, state: { environment: {} },
    _setCollidersCached: () => [], _viewportCamera() { return this.camera; },
    _activeOrbit() { if (!this.freeView) keyed++; return this.freeView ? this.free : { position: [0, 2, 10], target: [0, 1, 0] }; },
    _peekOrbit() { return this.freeView ? this.free : { position: [0, 2, 10], target: [0, 1, 0] }; },
    setFreeView(on) { this.freeView = on; }, _applyActive() {}, _flyTo() {}, onInteract() {},
    _pickRay: () => ({ ray: { origin: { x: 2, y: 5, z: 2 }, direction: { x: 0, y: -1, z: 0 } }, intersectObjects: () => [] }),
  };
  installNavigation(st);
  st.nav.pivotAt({ clientX: 0, clientY: 0 });
  assert.equal(st.nav.focusAt({ clientX: 0, clientY: 0 }), false, "focus is Free view only");
  assert.equal(keyed, 0);
  st.nav.dispose();
});
