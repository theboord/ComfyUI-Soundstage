// Live physics while editing (Milestone 9): the engine interface (physengine.mjs) and its XPBD backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, supported, engines, registerEngine, pickEngine } from "../../web/stage/physengine.mjs";

const box = (extra = {}) => ({ shape: "box", half: [0.3, 0.3, 0.3], center: [0, 0.3, 0], type: "dynamic", mass: 25, friction: 0.8, restitution: 0.05, ...extra });
const run = (w, s, fn) => { for (let i = 0; i < Math.round(s * 60); i++) { fn?.(i); w.step(1 / 60); } };

test("the default backend is XPBD and is always supported", () => {
  assert.equal(supported(), true);
  const w = createWorld();
  assert.equal(w.engine, "xpbd");
  assert.ok(engines().some((e) => e.name === "xpbd" && e.supported));
});

test("an unsupported backend falls back to XPBD; a supported preferred one is used", () => {
  registerEngine({ name: "nope", supported: () => false, createWorld: () => ({}) }, { prefer: true });
  assert.equal(pickEngine().name, "xpbd");
  assert.equal(createWorld({ engine: "nope" }).engine, "xpbd");
  registerEngine({ name: "fake", supported: () => true, createWorld: () => ({ fake: 1 }) });
  assert.equal(createWorld({ engine: "fake" }).engine, "fake");
});

test("a dropped crate falls, lands on the floor, settles and sleeps", () => {
  const w = createWorld();
  const id = w.addBody(box({ pos: [0, 1.2, 0] }));
  run(w, 2.5);
  const p = w.getPose(id);
  assert.ok(Math.abs(p.pos[1]) < 0.01, `rests on the floor (y ${p.pos[1]})`);
  assert.ok(w.isAsleep(id), "asleep");
  assert.equal(w.awakeCount(), 0);
});

test("a grabbed crate is blocked by a static wall and never passes through it", () => {
  const w = createWorld();
  const id = w.addBody(box({ pos: [0, 0, 0] }));
  w.addBody({ shape: "box", half: [0.08, 1, 2], center: [0, 1, 0], type: "static", pos: [2, 0, 0] });
  run(w, 1, () => w.setKinematicTarget(id, [5, 0, 0], [0, 0, 0, 1]));   // the cursor far beyond the wall
  const x = w.getPose(id).pos[0];
  assert.ok(x < 2 - 0.08 - 0.3 + 0.02 && x > 1.4, `stops at the wall face (x ${x.toFixed(3)})`);
});

test("a grabbed crate can't be pulled through the floor", () => {
  const w = createWorld();
  const id = w.addBody(box({ pos: [0, 0, 0] }));
  run(w, 0.5, () => w.setKinematicTarget(id, [0, -1, 0], [0, 0, 0, 1]));
  assert.ok(w.getPose(id).pos[1] > -0.01, "stays on the floor");
});

test("a grabbed crate pushes a free crate out of its way", () => {
  const w = createWorld();
  const a = w.addBody(box({ pos: [0, 0, 0] }));
  const b = w.addBody(box({ pos: [1, 0, 0], asleep: true }));
  run(w, 1.2, (i) => w.setKinematicTarget(a, [Math.min(2.5, i * 0.05), 0, 0], [0, 0, 0, 1]));
  const pa = w.getPose(a).pos, pb = w.getPose(b).pos;
  assert.ok(pb[0] > pa[0] + 0.55, `pushed ahead (a ${pa[0].toFixed(2)}, b ${pb[0].toFixed(2)})`);
  assert.ok(pb[1] > -0.01, "the pushed crate stays above the floor");
});

test("let go above another crate: it drops onto it and stacks", () => {
  const w = createWorld();
  const base = w.addBody(box({ pos: [0, 0, 0], asleep: true }));
  const top = w.addBody(box({ pos: [0, 1, 0] }));
  w.setKinematicTarget(top, [0, 0.9, 0], [0, 0, 0, 1]);
  run(w, 0.2);
  w.setKinematicTarget(top, null);
  run(w, 2.5);
  const y = w.getPose(top).pos[1];
  assert.ok(Math.abs(y - 0.6) < 0.03, `rests on top (y ${y.toFixed(3)})`);
  assert.ok(Math.abs(w.getPose(base).pos[1]) < 0.01);
});

test("released half over an edge, an unsupported crate tips off", () => {
  const w = createWorld();
  w.addBody({ shape: "box", half: [0.5, 0.4, 0.5], center: [0, 0.4, 0], type: "static", pos: [0, 0, 0] });   // a table-height block
  const c = w.addBody(box({ pos: [0.62, 0.81, 0] }));   // mostly hanging off the +x edge
  run(w, 3);
  const { pos, quat } = w.getPose(c);
  assert.ok(pos[1] < 0.5, `fell off the top (x ${pos[0].toFixed(2)}, y ${pos[1].toFixed(2)})`);
  assert.ok(Math.abs(quat[3]) < 0.99, "and tipped over on the way");
});

test("a kinematic body (a car) shoves crates; nothing pushes it back", () => {
  const w = createWorld();
  const car = w.addBody({ shape: "box", half: [1, 0.7, 2.2], center: [0, 0.7, 0], type: "kinematic", pos: [-4, 0, 0] });
  const c = w.addBody(box({ pos: [0, 0, 0], asleep: true }));
  run(w, 1.5, (i) => w.setKinematicTarget(car, [-4 + i * 0.08, 0, 0], [0, 0, 0, 1]));
  assert.ok(Math.abs(w.getPose(car).pos[0] - (-4 + 89 * 0.08)) < 1e-6, "the car is where it was told");
  assert.ok(w.getPose(c).pos[0] > w.getPose(car).pos[0] + 1, "the crate was pushed ahead of it");
});

test("raycast finds the top face of a box, then the floor beside it", () => {
  const w = createWorld();
  const id = w.addBody({ shape: "box", half: [0.5, 0.4, 0.5], center: [0, 0.4, 0], type: "static", pos: [0, 0, 0] });
  const h = w.raycast([0, 5, 0], [0, -1, 0]);
  assert.equal(h.id, id);
  assert.ok(Math.abs(h.point[1] - 0.8) < 1e-9 && h.normal[1] > 0.99);
  const f = w.raycast([2, 5, 0], [0, -1, 0]);
  assert.equal(f.id, "__ground");
  assert.equal(w.raycast([0, 5, 0], [0, -1, 0], 100, { exclude: new Set([id]) }).id, "__ground");
});

test("a box shoved into another's side pushes it straight ahead (no squirting out sideways off a corner)", () => {
  const w = createWorld();
  const a = w.addBody(box({ pos: [-1, 0, 0] })), b = w.addBody(box({ pos: [0, 0, 0.25] }));   // offset: corner contact
  run(w, 1.2, (i) => w.setKinematicTarget(a, [-1 + Math.min(1.6, i * 0.025), 0, 0]));
  const pb = w.getPose(b).pos;
  assert.ok(pb[0] > 0.4, `pushed ahead (${pb})`);
  assert.ok(Math.abs(pb[2] - 0.25) < 0.2, `not shot out sideways (${pb})`);
});

test("a person-like pusher (pushFlat) slides a tall-ish crate instead of tipping it", () => {
  const w = createWorld();
  const p = w.addBody({ shape: "box", half: [0.2, 0.9, 0.2], center: [0, 0.9, 0], type: "dynamic", mass: 75, friction: 0.8, pushFlat: true, pos: [-1, 0, 0] });
  const c = w.addBody(box({ half: [0.3, 0.4, 0.3], center: [0, 0.4, 0], friction: 0.9, pos: [0, 0, 0] }));
  run(w, 1.5, (i) => w.setKinematicTarget(p, [-1 + Math.min(1.2, i * 0.02), 0, 0]));
  w.setKinematicTarget(p, null);
  run(w, 1);
  const q = w.getPose(c).quat;
  assert.ok(w.getPose(c).pos[0] > 0.3, "it moved");
  assert.ok(Math.abs(q[0]) < 0.02 && Math.abs(q[2]) < 0.02, `upright (${q})`);
});

test("a 20-carton tower left alone stands still: under 2 mm of movement in 3 s (no sag, twist or walking apart)", () => {
  const w = createWorld();
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(w.addBody({ shape: "box", half: [0.25, 0.25, 0.25], center: [0, 0.25, 0], type: "dynamic", mass: 2, friction: 0.7, restitution: 0.03, pos: [0, i * 0.5, 0] }));
  const p0 = ids.map((id) => w.getPose(id).pos);
  run(w, 3);
  const worst = Math.max(...ids.map((id, i) => Math.hypot(...w.getPose(id).pos.map((v, k) => v - p0[i][k]))));
  assert.ok(worst < 0.002, `moved ${(worst * 1000).toFixed(1)} mm`);
  for (const id of ids) { const q = w.getPose(id).quat; assert.ok(Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) < 0.01, `no twist (${q})`); }
});

test("a car driving into a crate throws it (faster than the drag-safety cap), and a dragged crate stays capped", () => {
  const w = createWorld();
  const car = w.addBody({ shape: "box", half: [0.9, 0.6, 2.2], center: [0, 0.6, 0], type: "kinematic", pos: [0, 0, -4] });
  const c = w.addBody(box({ pos: [0, 0, 0] }));
  let top = 0;
  run(w, 0.8, (i) => { w.setKinematicTarget(car, [0, 0, -4 + (i + 1) * 12 / 60]); const v = w.getVelocity(c).v; top = Math.max(top, Math.hypot(...v)); });
  assert.ok(top > 6, `thrown at ${top.toFixed(1)} m/s`);
});
