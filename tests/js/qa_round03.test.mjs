// QA round 03 regressions.
//
// Bug 1: after climb onto a crate -> Cmd+Z -> Shift+Cmd+Z -> undo, dragging the person onto a horse slid them ~1 m and
// never mounted. Undo left the person selected, so the move arrows showed at their feet; from a raised view the arrow
// pointing away from the camera is drawn up across their body, and the gizmo took the press (a one-axis slide)
// instead of the live grab. A press on a selected person's body is now the body's (stage._gizmoTakesPress).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { TransformControls } from "../../web/vendor/addons/TransformControls.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";

const at = (id, kind, x, z, extra = {}) => ({ id, name: id, kind, position: [x, 0, z], keys: [{ frame: 0, position: [x, 0, z] }], rotation_deg: 0, ...extra });

/** A Stage without a renderer (as in live.drag.test.mjs), plus the real move gizmo, seen from the QA probe's raised view. */
function headless(actors) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: { set: "studio" } }, view: "clay", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onChange() {}, onInteract: (m) => { st.lastMsg = m; }, onSelect() {}, onShots() {}, _buildLights() {}, _applySun() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.live = new LiveEdit(st, liveKinds());
  st.setFrame(0);
  const cam = new THREE.PerspectiveCamera(50, 1.87, 0.05, 600);
  cam.position.set(0, 6.5, 7.5); cam.lookAt(0, 0.6, 0); cam.updateMatrixWorld(true);
  st._viewportCamera = () => cam;
  st.tc = new TransformControls(cam);
  st.tc.setSpace("world"); st.tc.setSize(1.15);
  st.tcHelper = st.tc.getHelper();
  new THREE.Scene().add(st.tcHelper);
  st.setGizmoMode("translate");
  return { st, cam };
}

/** The cursor over world point p: ndc and a raycaster aimed there. */
function aim(cam, p) {
  const v = new THREE.Vector3(...p).project(cam);
  const ndc = new THREE.Vector2(v.x, v.y);
  const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, cam);
  return { ndc, ray };
}
/** Screen point of one of the gizmo's arrowheads (axis "X" | "Z", sign +1 | -1). */
function arrowhead(st, cam, axis, sign) {
  st.tcHelper.updateMatrixWorld(true);
  for (const h of st.tc._gizmo.gizmo.translate.children) {
    if (h.name !== axis || !h.isMesh || h.geometry.parameters?.radiusTop !== 0) continue;
    h.geometry.computeBoundingBox();
    const c = h.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(h.matrixWorld);
    if (Math.sign(axis === "X" ? c.x : c.z) === sign) return c.toArray();
  }
  return null;
}

test("bug 1: a press on a selected person's chest, where the far move arrow is drawn, grabs the person (not the arrow)", () => {
  const { st, cam } = headless([at("man", "man", 0, 0, { height_m: 1.8 })]);
  st.select("man");
  assert.ok(st.tcHelper.visible !== undefined && st.tc.object === st.actorMeshes.get("man"), "the gizmo is on the person");
  st.tcHelper.visible = true;
  const { ndc, ray } = aim(cam, [0, 0.81, 0]);
  st.tcHelper.updateMatrixWorld(true);
  st.tc.pointerHover({ x: ndc.x, y: ndc.y, button: 0 });
  assert.equal(st.tc.axis, "Z", "the bug's precondition: the -Z arrow is under the cursor on the person's chest");
  assert.equal(st._gizmoTakesPress(ndc, ray), false, "the person's body takes the press (a live drag)");
  // The same press is the body's even right on the far arrowhead drawn over the person.
  const tip = arrowhead(st, cam, "Z", -1);
  const t = aim(cam, tip);
  assert.equal(st._gizmoTakesPress(t.ndc, t.ray), false);
});

test("bug 1: the arrows still work where they stick out past the person", () => {
  const { st, cam } = headless([at("man", "man", 0, 0, { height_m: 1.8 })]);
  st.select("man"); st.tcHelper.visible = true;
  const t = aim(cam, arrowhead(st, cam, "X", 1));
  assert.equal(st._gizmoTakesPress(t.ndc, t.ray), true, "the +X arrowhead, off to the side, is the gizmo's");
  assert.equal(st.tc.axis, "X");
});

test("bug 1: on anything else an arrowhead keeps the press, a shaft over its body gives way", () => {
  const { st, cam } = headless([at("crate", "crate", 0, 0, { height_m: 0.8, scale: 3 })]);
  st.select("crate"); st.tcHelper.visible = true;
  const head = aim(cam, arrowhead(st, cam, "Z", -1));
  const onBody = head.ray.intersectObject(st.actorMeshes.get("crate"), true).length > 0;
  assert.ok(onBody, "a big crate: the far arrowhead is drawn over it");
  assert.equal(st._gizmoTakesPress(head.ndc, head.ray), true, "an arrowhead over the crate is still the arrow's");
  // Halfway along the same shaft (over the crate's top): the crate's.
  st.tcHelper.updateMatrixWorld(true);
  const tipW = arrowhead(st, cam, "Z", -1);
  const mid = aim(cam, [0, tipW[1] / 2, tipW[2] / 2]);
  st.tc.pointerHover({ x: mid.ndc.x, y: mid.ndc.y, button: 0 });
  if (st.tc.axis === "Z") assert.equal(st._gizmoTakesPress(mid.ndc, mid.ray), false, "a shaft over the crate's body gives way");
});

test("bug 1: rotate and scale gizmos, and a gizmo on someone else, are untouched", () => {
  const { st, cam } = headless([at("man", "man", 0, 0, { height_m: 1.8 })]);
  st.select("man"); st.tcHelper.visible = true;
  st.setGizmoMode("rotate");
  // Press on the rotate ring where it crosses the person: the ring keeps it.
  st.tcHelper.updateMatrixWorld(true);
  let hitRing = null;
  for (let y = -0.6; y <= 0.6 && !hitRing; y += 0.01) for (let x = -0.6; x <= 0.6 && !hitRing; x += 0.01) {
    st.tc.pointerHover({ x, y, button: 0 });
    if (st.tc.axis) hitRing = { x, y };
  }
  assert.ok(hitRing, "found the rotate ring");
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(hitRing.x, hitRing.y), cam);
  assert.equal(st._gizmoTakesPress(new THREE.Vector2(hitRing.x, hitRing.y), ray), true);
  st.tc.enabled = false;
  assert.equal(st._gizmoTakesPress(new THREE.Vector2(hitRing.x, hitRing.y), ray), false, "a paused gizmo takes nothing");
});

test("bug 1: the stage hands the press over before the gizmo sees it, and turns the gizmo back on at pointerup", () => {
  const src = readFileSync(new URL("../../web/stage/stage.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(this\._gizmoTakesPress\(ndc, ray\)\) return;\s+this\.tc\.axis = null;\s+this\.tc\.enabled = false;/);
  assert.match(src, /\}, \{ capture: true \}\);/);
  assert.match(src, /const end = \(e\) => \{\s+this\._dragging = false;\s+if \(this\._tcPaused\) \{ this\.tc\.enabled = true; this\._tcPaused = false; \}/);
  assert.match(src, /if \(!this\._tcPaused && this\.tcHelper\.visible && \(this\.tc\.axis \|\| this\.tc\.dragging\)\) return;/);
});

test("bug 1: after climb, undo, redo, undo, the person still mounts a horse (no stale live state)", () => {
  const { st } = headless([at("p", "man", -3, 0, { height_m: 1.8 }), at("c", "crate", 0, 0, { height_m: 0.8 }),
    at("h", "horse", 0, 3, { height_m: 1.6, simple_model: true })]);
  st.resetHistory();
  const hadWindow = "window" in globalThis;
  if (!hadWindow) globalThis.window = {};   // _record reads window.__ssSliding
  const rayAt = (x, z) => ({ ray: new THREE.Ray(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0)) });
  let n = 0;
  const ev = () => ({ clientX: ++n * 5, clientY: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false });
  const drag = (id, to) => {
    const g = st.actorMeshes.get(id);
    assert.ok(st.live.begin(id, ev(), rayAt(g.position.x, g.position.z)), "drag began");
    const [x, z] = [g.position.x, g.position.z];
    for (let i = 1; i <= 40; i++) { st.live.move(ev(), rayAt(x + (to[0] - x) * i / 40, z + (to[1] - z) * i / 40)); st.live._tick(1 / 60); }
    for (let i = 0; i < 10; i++) st.live._tick(1 / 60);
    st.live.end();
    for (let i = 0; i < 240 && st.live.settling; i++) { st.live._tick(1 / 60); if ((st.live.world?.awakeCount() ?? 0) === 0) break; }
    st.live.finish();
  };
  st.onChange = () => { if (!st._muteRecord) st._record(); };
  drag("p", [0, 0]);
  assert.ok(st.state.actors.find((x) => x.id === "p").keys[0].position[1] > 0.5, "climbed");
  assert.equal(st._hist.length, 2, "the climb is one undo step");
  assert.ok(st.undo() && st.redo() && st.undo(), "undo, redo, undo");
  assert.ok(Math.abs(st._actorPosAt(st.state.actors.find((x) => x.id === "p"), 0)[1]) < 0.01, "back on the floor");
  drag("p", [0, 3]);
  assert.equal(st.state.actors.find((x) => x.id === "p").mount_id, "h", "mounted the horse");
  if (!hadWindow) delete globalThis.window;
});
