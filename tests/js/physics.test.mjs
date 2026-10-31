// Stage physics: the rigid-body solver (drops, stacks, a car through crates, throws) and the bake into keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, bakeTrack, samplePos, sampleQuat, physicsOf, checkTracks, qrot, qyaw, PHYSICS_DEFAULTS }
  from "../../web/stage/physics.mjs";

const F = 97;
const crate = (id, pos, extra = {}) => ({ id, shape: "box", half: [0.4, 0.4, 0.4], center: [0, 0.4, 0], dynamic: true, mass: 25,
  bounce: 0.2, friction: 0.6, poses: [{ pos, quat: extra.quat || [0, 0, 0, 1] }], ...extra });

// Deepest overlap between two oriented boxes (separating axis test), 0 when apart.
function overlap(a, b) {
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const t = b.c.map((v, i) => v - a.c[i]);
  const axes = [...a.ax, ...b.ax];
  for (const u of a.ax) for (const v of b.ax) { const c = cross(u, v), l = Math.hypot(...c); if (l > 1e-6) axes.push(c.map((x) => x / l)); }
  let min = Infinity;
  for (const L of axes) {
    const ra = a.h.reduce((s, h, i) => s + h * Math.abs(dot(a.ax[i], L)), 0), rb = b.h.reduce((s, h, i) => s + h * Math.abs(dot(b.ax[i], L)), 0);
    const o = ra + rb - Math.abs(dot(t, L));
    if (o <= 0) return 0;
    min = Math.min(min, o);
  }
  return min;
}
const obb = (spec, pose) => ({ c: pose.pos.map((v, i) => v + qrot(pose.quat, spec.center)[i]),
  ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => qrot(pose.quat, e)), h: spec.half });

test("a tilted box dropped from 2 m lands, rests flat on the floor and sleeps", () => {
  const specs = [crate("drop", [0, 2, 0], { quat: [0.2, 0.1, 0.15, 0.96].map((v, _, q) => v / Math.hypot(...q)) })];
  const r = simulate(specs, F);
  const qa = checkTracks(specs, r);
  assert.ok(qa.maxSink < 0.005, `sank ${qa.maxSink}`);
  assert.ok(qa.allSettled, "came to rest");
  assert.ok(r.settled.drop < 60, `settled at ${r.settled.drop}`);
  const end = r.tracks.drop.at(-1);
  // Resting on a face: its up axis is one of the box axes.
  const up = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => Math.abs(qrot(end.quat, e)[1]));
  assert.ok(Math.max(...up) > 0.999, `not flat: ${up}`);
  assert.ok(Math.abs(end.pos[1] + qrot(end.quat, [0, 0.4, 0])[1] - 0.4) < 0.01, "centre 0.4 m up");
});

test("a stack of three crates stays stacked", () => {
  const specs = [crate("c0", [0, 0, 0]), crate("c1", [0, 0.8, 0]), crate("c2", [0.05, 1.6, 0])];
  const r = simulate(specs, F);
  for (const s of specs) {
    const a = s.poses[0].pos, b = r.tracks[s.id].at(-1).pos;
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.02, `${s.id} drifted`);
  }
  assert.ok(checkTracks(specs, r).allSettled);
});

test("a car driven through a crate pile knocks it over without crates passing through each other", () => {
  const car = []; for (let f = 0; f < F; f++) car.push({ pos: [0, 0, -15 + f * 0.5], quat: [0, 0, 0, 1] });
  const specs = [];
  [[-1.25, -0.42, 0.42, 1.25], [-0.84, 0, 0.84], [-0.42, 0.42], [0]].forEach((row, lv) => row.forEach((x, i) =>
    specs.push(crate(`c${lv}${i}`, [x * 1.02, lv * 0.8, 5], { quat: qyaw(((lv + i) % 2 ? 3 : -3) * Math.PI / 180) }))));
  specs.push({ id: "car#body", shape: "box", half: [0.95, 0.29, 2.25], center: [0, 0.38, 0], dynamic: false, poses: car });
  specs.push({ id: "car#cabin", shape: "box", half: [0.86, 0.26, 1.12], center: [0, 0.94, -0.18], dynamic: false, poses: car });
  const r = simulate(specs, F);
  const dyn = specs.filter((s) => s.dynamic);
  // Knocked: every crate moved, most of them a long way.
  const moved = dyn.map((s) => Math.hypot(...r.tracks[s.id].at(-1).pos.map((v, i) => v - s.poses[0].pos[i])));
  assert.ok(moved.filter((m) => m > 1).length >= 7, `moved ${moved.map((m) => m.toFixed(2))}`);
  let worst = 0;
  for (let f = 5; f < F; f++) for (let i = 0; i < dyn.length; i++) for (let j = i + 1; j < dyn.length; j++)
    worst = Math.max(worst, overlap(obb(dyn[i], r.tracks[dyn[i].id][f]), obb(dyn[j], r.tracks[dyn[j].id][f])));
  assert.ok(worst < 0.05, `crates overlap ${worst.toFixed(3)} m`);
  const qa = checkTracks(specs, r);
  assert.ok(qa.maxSink < 0.02, `sank ${qa.maxSink}`);
  assert.ok(qa.maxSpeed < 30, `exploded at ${qa.maxSpeed} m/s`);   // the car does 12 m/s
});

test("a thrown ball keeps its throw, arcs down and bounces lower each time", () => {
  const spec = { id: "ball", shape: "sphere", radius: 0.15, center: [0, 0.15, 0], dynamic: true, mass: 1, bounce: 0.6, friction: 0,
    poses: [{ pos: [0, 1.5, 0], quat: [0, 0, 0, 1] }, { pos: [0, 1.5, 0.2], quat: [0, 0, 0, 1] }], release: 1 };
  const r = simulate([spec], F);
  const tr = r.tracks.ball;
  assert.ok(tr[13].pos[2] > 2, "carried on at the throw's 4.8 m/s");
  const ys = tr.map((p) => p.pos[1]);
  const peaks = [];
  for (let i = 1; i < ys.length - 1; i++) if (ys[i] > ys[i - 1] && ys[i] >= ys[i + 1] && ys[i] > 0.01) peaks.push(ys[i]);
  assert.ok(peaks.length >= 2, "bounced");
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i] < peaks[i - 1], `bounce ${i} higher than the last`);
  assert.ok(peaks[0] < 1.5 * 0.6, "loses energy at the first bounce");
});

test("the same scene always bakes the same keys", () => {
  const mk = () => [crate("a", [0, 1.2, 0], { quat: qyaw(0.4) }), crate("b", [0.5, 0, 0.1], { dynamic: false })];
  assert.deepEqual(simulate(mk(), 60).tracks, simulate(mk(), 60).tracks);
});

test("bakeTrack keeps a key per moving frame and only the ends of holds", () => {
  const still = { pos: [1, 0, 2], quat: [0, 0, 0, 1] };
  const track = [still, still, still, { pos: [1, 0.5, 2], quat: [0, 0.1, 0, 0.995] }, { pos: [1, 0.2, 2.5], quat: [0, 0.2, 0, 0.98] },
    { pos: [1, 0, 3], quat: [0, 0, 0, -1] }, { pos: [1, 0, 3], quat: [0, 0, 0, -1] }, { pos: [1, 0, 3], quat: [0, 0, 0, -1] }];
  const keys = bakeTrack(track);
  assert.deepEqual(keys.map((k) => k.frame), [0, 2, 3, 4, 5, 7]);
  assert.deepEqual(keys.at(-1).quat, [0, 0, 0, 1]);   // w kept positive
  for (const k of keys) assert.ok(Math.abs(Math.hypot(...k.quat) - 1) < 1e-4);
  // The stage plays them back: linear between keys, a hold stays put, rotation slerps.
  assert.deepEqual(samplePos(keys, 1), [1, 0, 2]);
  assert.deepEqual(samplePos(keys, 6), [1, 0, 3]);
  assert.ok(Math.abs(sampleQuat(keys, 3.5)[1] - 0.15) < 0.01);
  assert.equal(sampleQuat([{ frame: 0, position: [0, 0, 0] }], 3), null);   // keys without rotation: the stage's own heading
});

test("physicsOf fills defaults, per-kind masses and clamps", () => {
  assert.equal(physicsOf({ kind: "crate" }).mode, PHYSICS_DEFAULTS.mode);
  assert.equal(physicsOf({ kind: "crate" }).mass, 25);
  assert.equal(physicsOf({ kind: "chair" }).mass, 7);
  const p = physicsOf({ kind: "cube", physics: { mode: "dynamic", bounce: 3, friction: -1, lift: 2.5, mass: "40" } });
  assert.deepEqual(p, { mode: "dynamic", mass: 40, bounce: 1, friction: 0, lift: 2.5 });
  assert.equal(physicsOf({ physics: { mode: "wobbly" } }).mode, PHYSICS_DEFAULTS.mode);
});
