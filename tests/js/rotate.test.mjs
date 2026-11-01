// The rotate tools (web/stage/rotate.mjs): the floating bar's placement, the yaw ring's maths, Shift snapping, and the
// 3-axis gizmo turn written back as heading + tilt. Plus the "?" sheet and the Guide mention them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { snapDeg, wrapDeg, angleAt, ringRadius, onRing, ringYaw, altYaw, toolbarPos, TOOLS, gizmoTurnToActor } from "../../web/stage/rotate.mjs";
import { SHORTCUTS } from "../../web/ui/shortcuts.mjs";
import { TOUR_STEPS } from "../../web/ui/firstrun.mjs";

test("snap to 15° and wrap", () => {
  assert.equal(snapDeg(37), 30); assert.equal(snapDeg(38), 45); assert.equal(snapDeg(-7), 0);
  assert.equal(wrapDeg(190), -170); assert.equal(wrapDeg(-180), 180); assert.equal(wrapDeg(540), 180); assert.equal(wrapDeg(45), 45);
});

test("ring angle follows three.js yaw (+Z = 0°, +X = 90°)", () => {
  assert.equal(angleAt(0, 1, 0, 0), 0);
  assert.equal(Math.round(angleAt(1, 0, 0, 0)), 90);
  assert.equal(Math.round(angleAt(3, 2, 2, 2)), 90);
  // and matches how a mesh turned by that yaw points its +Z
  const v = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(70));
  assert.equal(Math.round(angleAt(v.x, v.z, 0, 0)), 70);
});

test("ring sits outside the footprint and hit-tests the band", () => {
  const R = ringRadius(2.2, 0.9);   // a car
  assert.ok(R > Math.hypot(2.2, 0.9));
  assert.ok(ringRadius(0.2, 0.2) >= 0.4);   // a small crate still gets a grabbable ring
  assert.ok(onRing(R, 0, 0, 0, R, 0.05));
  assert.ok(!onRing(0.5, 0, 0, 0, R, 0.05));
});

test("ring and Alt drags: unwrap across ±180°, Shift snaps", () => {
  assert.equal(ringYaw(170, 170, -170), 190);
  assert.equal(ringYaw(0, 10, 47, true), 30);
  assert.equal(altYaw(10, 100), 60);
  assert.equal(altYaw(0, 52, true), 30);
});

test("tool bar: above the object, clamped inside the canvas, below when there's no room", () => {
  const bar = { w: 240, h: 32 };
  assert.deepEqual(toolbarPos({ x0: 400, y0: 300, x1: 600, y1: 500 }, { w: 1000, h: 700 }, bar), { left: 380, top: 240 });
  assert.equal(toolbarPos({ x0: -50, y0: 300, x1: 20, y1: 500 }, { w: 1000, h: 700 }, bar).left, 8);
  assert.equal(toolbarPos({ x0: 900, y0: 300, x1: 1100, y1: 500 }, { w: 1000, h: 700 }, bar).left, 1000 - 240 - 8);
  assert.equal(toolbarPos({ x0: 400, y0: 10, x1: 600, y1: 200 }, { w: 1000, h: 700 }, bar).top, 228);
});

test("tool bar buttons carry their keys", () => {
  assert.deepEqual(TOOLS.map((t) => `${t.label}:${t.key}`), ["Move:G", "Rotate:R", "Scale:T"]);
});

test("3-axis gizmo turn → heading + tilt, and back to the same orientation", () => {
  const stage = { _turnHeadingKey: () => false };
  const g = new THREE.Object3D();
  g.quaternion.setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(20), THREE.MathUtils.degToRad(60), THREE.MathUtils.degToRad(-10), "YXZ"));
  const a = {};
  gizmoTurnToActor(stage, a, g);
  assert.ok(Math.abs(a.rotation_deg - 60) <= 5);   // the twist about +Y (swing-twist), not the Euler Y
  assert.ok(Array.isArray(a.tilt) && a.tilt.length === 4);
  const back = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(a.rotation_deg)).multiply(new THREE.Quaternion(...a.tilt));
  assert.ok(back.angleTo(g.quaternion) < THREE.MathUtils.degToRad(0.6));
  // A pure turn leaves no tilt.
  g.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-135));
  a.tilt = [0.1, 0, 0, 0.99];
  gizmoTurnToActor(stage, a, g);
  assert.equal(a.rotation_deg, -135); assert.equal(a.tilt, undefined);
  // A stunt car keyed by heading: the turn goes to its heading key.
  let keyed = null;
  gizmoTurnToActor({ _turnHeadingKey: (_a, d) => { keyed = d; return true; } }, a, g);
  assert.equal(keyed, -135);
});

test("the ? sheet and the Guide tell you how to rotate", () => {
  const all = SHORTCUTS.flatMap((g) => g.items.map((i) => i.what)).join("\n");
  assert.match(all, /ring/i); assert.match(all, /tilt and roll/i); assert.match(all, /15°/); assert.match(all, /Alt|turn it/i);
  assert.ok(TOUR_STEPS.some((s) => /Rotate/.test(s.text) && /ring/.test(s.text)));
});
