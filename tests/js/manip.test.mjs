// Direct manipulation math (Milestone 9): smoothing, axis lock, snapping, surface targets, heading/tilt, camera moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { damp, axisLock, snapGrid, edgeSnap, dragTarget, stepKind, yawTilt, qyaw, qmul, zoomAt, frameSphere, decay, liftBy, easeInOut }
  from "../../web/stage/manip.mjs";

const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test("damping never overshoots, never teleports, and is frame-rate independent", () => {
  let a = 0, b = 0;
  for (let i = 0; i < 4; i++) a = damp(a, 10, 30, 1 / 120);
  for (let i = 0; i < 2; i++) b = damp(b, 10, 30, 1 / 60);
  assert.ok(near(a, b, 1e-9), `${a} vs ${b}`);
  assert.ok(a > 0 && a < 10);
  const v = damp([0, 0, 0], [1, 2, 3], 30, 1 / 60);
  assert.ok(v.every((x, i) => x > 0 && x < [1, 2, 3][i]));
  assert.ok(near(damp(5, 9, 30, 10), 9, 1e-9), "a long frame lands on the target");
});

test("Shift locks the drag to the axis it has moved along most", () => {
  const r = axisLock([0, 0, 0], [2, 0, 0.5]);
  assert.equal(r.axis, "x");
  assert.deepEqual(r.pos, [2, 0, 0]);
  const z = axisLock([1, 0, 1], [1.2, 0.4, 4]);
  assert.equal(z.axis, "z");
  assert.deepEqual(z.pos, [1, 0.4, 4]);
  assert.deepEqual(axisLock([0, 0, 0], [0.1, 0, 5], "x").pos, [0.1, 0, 0], "a chosen lock stays");
});

test("grid snap rounds to the step", () => {
  assert.ok(near(snapGrid(1.234, 0.1), 1.2));
  assert.equal(snapGrid(1.234, 0), 1.234);
});

test("edge snap lines a crate up with its neighbour's edge, and only when close", () => {
  const other = { id: "b", min: [1, -0.4], max: [1.8, 0.4] };
  // Moving crate 0.8 wide, its right edge 0.05 short of b's left edge (abut), z almost aligned.
  const fp = { min: [0.15, -0.37], max: [0.95, 0.43] };
  const r = edgeSnap(fp, [other], 0.08);
  assert.ok(near(r.dx, 0.05, 1e-9), `dx ${r.dx}`);
  assert.ok(near(r.dz, -0.03, 1e-9), `dz ${r.dz}`);
  assert.equal(r.guides.length, 2);
  assert.ok(r.guides.some((g) => g.axis === "x" && near(g.at, 1)));
  assert.deepEqual(edgeSnap({ min: [0, 0], max: [0.8, 0.8] }, [other], 0.08), { dx: 0, dz: 0, guides: [] }, "too far: no snap");
  assert.equal(edgeSnap(fp, [{ id: "far", min: [40, 0], max: [41, 1] }]).guides.length, 0, "out of reach");
});

test("a drag stands on the surface under the cursor; a wall is not a surface", () => {
  const plane = (y) => [3, y, 4];
  const top = dragTarget({ point: [1, 0.75, 2], normal: [0, 1, 0], id: "table" }, [0.1, 0, -0.1], 0, plane);
  assert.deepEqual(top, { pos: [1.1, 0.75, 1.9], support: "table", surface: true });
  const floor = dragTarget({ point: [1, 0, 2], normal: [0, 1, 0], id: "__ground" }, [0, 0, 0], 0.75, plane);
  assert.equal(floor.support, null);
  assert.equal(floor.pos[1], 0);
  const wall = dragTarget({ point: [1, 1.2, 2], normal: [1, 0, 0], id: "wall" }, [0, 0, 0], 0.4, plane);
  assert.deepEqual(wall, { pos: [3, 0.4, 4], support: null, surface: false });
  const roof = dragTarget({ point: [1, 9, 2], normal: [0, 1, 0], id: "house" }, [0, 0, 0], 0, plane);
  assert.equal(roof.surface, false, "a rooftop is too high to set things on by dragging");
  assert.equal(dragTarget(null, [0, 0, 0], 0, () => null), null);
});

test("people walk, step, climb or are blocked by what's under their feet", () => {
  assert.equal(stepKind(0), "walk");
  assert.equal(stepKind(0.15), "step");
  assert.equal(stepKind(0.8), "climb");
  assert.equal(stepKind(2.4), "blocked");
});

test("an orientation splits into a whole-degree heading and the lean left over", () => {
  const up = yawTilt(qyaw(Math.PI / 4));
  assert.equal(up.yawDeg, 45);
  assert.equal(up.tilt, null);
  // Tipped 90° onto its side, then turned 30°.
  const side = [Math.sin(Math.PI / 4), 0, 0, Math.cos(Math.PI / 4)];
  const q = qmul(qyaw(30 * Math.PI / 180), side);
  const r = yawTilt(q);
  assert.equal(r.yawDeg, 30);
  assert.ok(r.tilt && Math.abs(r.tilt[0] - Math.sin(Math.PI / 4)) < 1e-4, JSON.stringify(r.tilt));
  const back = qmul(qyaw(r.yawDeg * Math.PI / 180), r.tilt);
  const dot = Math.abs(back.reduce((s, v, i) => s + v * q[i], 0));
  assert.ok(dot > 0.99999, "yaw * tilt rebuilds it");
  assert.equal(yawTilt(qyaw(Math.PI)).yawDeg, -180, "wraps into -180..179");
});

test("zoom toward the cursor keeps the view direction and the point under the cursor", () => {
  const pos = [0, 2, -10], tgt = [0, 1, 0], P = [3, 0, 5];
  const z = zoomAt(pos, tgt, P, 0.5);
  const d0 = tgt.map((v, i) => v - pos[i]), d1 = z.tgt.map((v, i) => v - z.pos[i]);
  const cross = [d0[1] * d1[2] - d0[2] * d1[1], d0[2] * d1[0] - d0[0] * d1[2], d0[0] * d1[1] - d0[1] * d1[0]];
  assert.ok(Math.hypot(...cross) < 1e-9, "same direction");
  // P, the old camera and the new camera are on one line (P stays under the cursor).
  const a = P.map((v, i) => pos[i] - v), b = P.map((v, i) => z.pos[i] - v);
  const c2 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  assert.ok(Math.hypot(...c2) < 1e-9);
  assert.ok(Math.hypot(...b) < Math.hypot(...a), "closer");
});

test("frame-selected fits the sphere from the same direction", () => {
  const f = frameSphere([0, 0, -10], [0, 0, 0], [5, 1, 5], 1, Math.PI / 4, 16 / 9);
  assert.deepEqual(f.tgt, [5, 1, 5]);
  const d = Math.hypot(...f.pos.map((v, i) => v - f.tgt[i]));
  assert.ok(near(d, 1.25 / Math.sin(Math.PI / 8), 1e-9), `distance ${d}`);
  assert.ok(near(f.pos[0], 5) && f.pos[2] < 5, "still looking along +z");
});

test("inertia decays to nothing; the lift stays in range; the ease ends where it should", () => {
  let v = [2, -1];
  for (let i = 0; i < 60; i++) v = decay(v, 1 / 60, 0.12);
  assert.ok(Math.hypot(...v) < 0.01);
  assert.ok(liftBy(0, -100) > 0, "wheel up raises");
  assert.equal(liftBy(0, 300), 0, "never below its support");
  assert.equal(liftBy(5.99, -1e4), 6);
  assert.equal(easeInOut(0), 0); assert.equal(easeInOut(1), 1);
});
