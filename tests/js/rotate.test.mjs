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

// QA round 07: the bar showed nowhere in a close Camera view (a car filling the frame has box corners behind the
// camera, and any corner behind used to hide the bar), and could sit under the open Physics panel.
import { screenBox, avoidPanels } from "../../web/stage/rotate.mjs";

test("QA07: a close object with corners behind the camera still gets a box (and its bar)", () => {
  const cv = { w: 860, h: 460 };
  const corners = [
    { x: 150, y: 120, behind: false }, { x: 700, y: 140, behind: false }, { x: 160, y: 380, behind: false }, { x: 690, y: 390, behind: false },
    { x: 5000, y: -900, behind: true }, { x: -4000, y: 1200, behind: true }, { x: 30, y: 30, behind: true }, { x: 0, y: 0, behind: true },
  ];
  const b = screenBox(corners, cv);
  assert.ok(b, "box");
  assert.ok(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= cv.w && b.y1 <= cv.h, "clipped to the canvas");
  assert.equal(screenBox(corners.map((c) => ({ ...c, behind: true })), cv), null);   // all behind: no bar
  assert.equal(screenBox([{ x: -50, y: 10, behind: false }, { x: -10, y: 40, behind: false }], cv), null);   // off the left
  assert.deepEqual(screenBox([{ x: 10, y: 20, behind: false }, { x: 110, y: 90, behind: false }], cv), { x0: 10, y0: 20, x1: 110, y1: 90 });
});

test("QA07: the bar moves out from under the open Physics panel", () => {
  const cv = { w: 860, h: 460 }, bar = { w: 240, h: 32 };
  const phys = { x0: 570, y0: 0, x1: 860, y1: 460 };   // docked on the right, full height
  const p = avoidPanels({ left: 500, top: 100 }, bar, [phys], cv);
  assert.ok(p.left + bar.w <= phys.x0, "beside it, on the left");
  assert.equal(p.top, 100);
  assert.deepEqual(avoidPanels({ left: 100, top: 100 }, bar, [phys], cv), { left: 100, top: 100 });   // no overlap: unchanged
});

import { ringTakesPress } from "../../web/stage/rotate.mjs";
test("QA07: the hidden yaw ring never steals a tilt drag (Rotate mode / a gizmo handle under the cursor)", () => {
  assert.equal(ringTakesPress(true, null), true);
  assert.equal(ringTakesPress(false, null), false);   // Rotate mode hides the ring: the car's X/Z circle gets the press
  assert.equal(ringTakesPress(true, "X"), false);
});

test("QA07: an object that fills the view gets the bar at the top edge, not on the bottom row", () => {
  const bar = { w: 330, h: 32 };
  // The box runs off the top and the bottom (a car right in front of the lens): no room above or below.
  assert.equal(toolbarPos({ x0: 100, y0: 0, x1: 700, y1: 460 }, { w: 860, h: 460 }, bar).top, 8);
  // Room below still goes below.
  assert.equal(toolbarPos({ x0: 100, y0: 0, x1: 700, y1: 300 }, { w: 860, h: 460 }, bar).top, 328);
});
