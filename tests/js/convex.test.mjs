// Milestone 27: real collision shapes (web/stage/convex.mjs) and hull bodies in the XPBD bake (physics.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { quickhull, makeHull, boxHull, massProps, decompose, gjk, epa, hullContacts, hullsSeparate, vehicleBodyPoints,
  spreadPoints, MAX_HULL_VERTS } from "../../web/stage/convex.mjs";
import { simulate, createXpbdWorld } from "../../web/stage/physics.mjs";

const boxPts = (h, o = [0, 0, 0]) => {
  const v = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) v.push([o[0] + i * h[0], o[1] + j * h[1], o[2] + k * h[2]]);
  return v;
};
const fib = (n, r = 1) => Array.from({ length: n }, (_, i) => { const z = 1 - 2 * (i + 0.5) / n, s = Math.sqrt(1 - z * z), t = i * 2.39996; return [r * s * Math.cos(t), r * z, r * s * Math.sin(t)]; });
// A seeded generator for test points (no Math.random: the tests are deterministic too).
const rng = (seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test("quickhull: a cube with points inside is its 8 corners; a sphere's hull is a closed, outward triangle mesh", () => {
  const r = rng(7), pts = [...boxPts([0.5, 0.3, 0.2])];
  for (let i = 0; i < 200; i++) pts.push([(r() - 0.5) * 0.9, (r() - 0.5) * 0.5, (r() - 0.5) * 0.3]);
  const q = quickhull(pts);
  assert.equal(q.verts.length, 8);
  assert.equal(q.tris.length, 12);
  const s = quickhull(fib(400));
  assert.equal(s.verts.length, 400);
  assert.equal(s.tris.length, 2 * 400 - 4, "Euler: a closed triangulated sphere has 2V - 4 faces");
  // Every input point is inside (or on) every face.
  const h = makeHull(fib(400), { maxVerts: 400 });
  for (const p of fib(400)) for (const P of h.planes) assert.ok(P[0] * p[0] + P[1] * p[1] + P[2] * p[2] - P[3] < 1e-9);
  assert.equal(quickhull([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0]]), null, "flat points have no hull");
});

test("makeHull: capped vertex count, merged face planes, exact box mass properties", () => {
  const b = boxHull([0.4, 0.25, 0.1]);
  assert.equal(b.v.length, 8); assert.equal(b.planes.length, 6);
  const m = 2 * 0.8 * 0.5 * 0.2;
  assert.ok(Math.abs(b.volume - 0.08) < 1e-9);
  const I = b.inertia;   // unit density: m/12 (b² + c²)
  assert.ok(Math.abs(I[0][0] - (0.08 / 12) * (0.5 ** 2 + 0.2 ** 2)) < 1e-9);
  assert.ok(Math.abs(I[1][1] - (0.08 / 12) * (0.8 ** 2 + 0.2 ** 2)) < 1e-9);
  assert.ok(Math.abs(I[0][1]) < 1e-12);
  void m;
  const s = makeHull(fib(500));
  assert.ok(s.v.length <= MAX_HULL_VERTS);
  assert.ok(s.volume > 0.7 * (4 / 3) * Math.PI && s.volume < (4 / 3) * Math.PI);
  assert.equal(spreadPoints(fib(50), 10).length, 10);
  // massProps of an offset box: the centre of mass is the box centre
  const o = makeHull(boxPts([0.1, 0.2, 0.3], [1, 2, 3]));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(o.com[k] - [1, 2, 3][k]) < 1e-9);
  assert.equal(massProps(o.v, o.tris).volume.toFixed(6), (0.2 * 0.4 * 0.6).toFixed(6));
});

test("decompose: a chair and a table become a few hulls with far less empty volume than one hull; a box stays one", () => {
  const chair = [boxPts([0.225, 0.025, 0.225], [0, 0.46, 0]), boxPts([0.225, 0.225, 0.025], [0, 0.7, -0.2])];
  for (const x of [-0.2, 0.2]) for (const z of [-0.2, 0.2]) chair.push(boxPts([0.02, 0.23, 0.02], [x, 0.23, z]));
  const hc = decompose(chair, { maxHulls: 4 });
  const one = makeHull(chair.flat());
  assert.ok(hc.length >= 2 && hc.length <= 4, `${hc.length} hulls`);
  const vol = hc.reduce((s, h) => s + h.volume, 0);
  assert.ok(vol < 0.5 * one.volume, `decomposed ${vol.toFixed(4)} vs one hull ${one.volume.toFixed(4)}`);
  const table = [boxPts([0.7, 0.03, 0.4], [0, 0.75, 0])];
  for (const x of [-0.62, 0.62]) for (const z of [-0.33, 0.33]) table.push(boxPts([0.03, 0.375, 0.03], [x, 0.375, z]));
  const ht = decompose(table, { maxHulls: 4 });
  assert.ok(ht.reduce((s, h) => s + h.volume, 0) < 0.25 * makeHull(table.flat()).volume);
  assert.equal(decompose([boxPts([0.4, 0.4, 0.4])]).length, 1);
  // A single mesh (a table modelled as one piece) is cut by planes: its top comes off its legs.
  const pts = [], tris = [];
  for (const p of table) { const q = quickhull(p); const o = pts.length; pts.push(...q.verts); tris.push(...q.tris.map((t) => t.map((i) => i + o))); }
  const hm = decompose([{ points: pts, tris }], { maxHulls: 4 });
  assert.ok(hm.length >= 2, `${hm.length}`);
  assert.ok(hm.reduce((s, h) => s + h.volume, 0) < 0.5 * makeHull(pts).volume);
});

test("GJK / EPA: overlap, separation, penetration depth and normal, and the edge-on-edge case", () => {
  const A = boxPts([0.5, 0.5, 0.5]), B = boxPts([0.5, 0.5, 0.5], [0.8, 0.1, 0]);
  const g = gjk(A, B);
  assert.ok(g.hit);
  const e = epa(A, B, g.simplex);
  assert.ok(Math.abs(e.depth - 0.2) < 1e-6 && Math.abs(e.n[0] - 1) < 1e-6, JSON.stringify(e));
  assert.equal(gjk(A, boxPts([0.5, 0.5, 0.5], [1.01, 0, 0])).hit, false);
  // B turned 45 deg about z, its edge pushed into A's face: depth = 0.5 + 0.5·√2 - 1.15.
  const c = Math.SQRT1_2, C = boxPts([0.5, 0.5, 0.5]).map((p) => [p[0] * c - p[1] * c + 1.15, p[0] * c + p[1] * c, p[2]]);
  const g2 = gjk(A, C), e2 = epa(A, C, g2.simplex);
  assert.ok(g2.hit && Math.abs(e2.depth - (0.5 + 0.5 * Math.SQRT2 - 1.15)) < 1e-6);
});

const body = (hulls, x, q = [0, 0, 0, 1]) => ({ x, q, hulls: hulls.map((pts) => { const h = makeHull(pts); h.p = h.v; return h; }) });

test("hull contacts: a board resting on a box gets a 4-point manifold; separated hulls give none", () => {
  const top = body([boxPts([0.4, 0.02, 0.1])], [0, 0.519, 0]), base = body([boxPts([0.5, 0.5, 0.5])], [0, 0, 0]);
  const out = [];
  hullContacts(top, base, out, 0.01);
  assert.equal(out.length, 4);
  for (const c of out) {
    c.fn(c);
    // pushes the board up (or, the same contact the other way round, the base down)
    assert.ok(Math.abs(c.d - 0.001) < 1e-9 && (c.a === top ? c.n[1] > 0.999 : c.n[1] < -0.999), `${c.d} ${c.n}`);
  }
  const far = [];
  hullContacts(body([boxPts([0.4, 0.02, 0.1])], [0, 0.6, 0]), base, far, 0.01);
  assert.equal(far.length, 0);
  assert.ok(hullsSeparate(body([boxPts([0.1, 0.1, 0.1])], [0, 1, 0]), base));
  assert.ok(!hullsSeparate(body([boxPts([0.1, 0.1, 0.1])], [0, 0.55, 0]), base));
});

test("hull bodies in the bake: a hull box acts like a box; a chair lands on its legs; a raked car body lifts a crate", () => {
  const F = 60, mk = (shape) => ({ id: "c", shape, half: [0.3, 0.3, 0.3], center: [0, 0.3, 0], hulls: [boxPts([0.3, 0.3, 0.3], [0, 0.3, 0])],
    dynamic: true, mass: 10, bounce: 0.2, friction: 0.6, poses: [{ pos: [0, 1, 0], quat: [0, 0, 0, 1] }] });
  const rb = simulate([mk("box")], F), rh = simulate([mk("hull")], F);
  assert.ok(Math.abs(rb.tracks.c.at(-1).pos[1] - rh.tracks.c.at(-1).pos[1]) < 0.005, `${rb.tracks.c.at(-1).pos[1]} vs ${rh.tracks.c.at(-1).pos[1]}`);
  assert.ok(Math.abs(rh.tracks.c.at(-1).pos[1]) < 0.01, "rests on the floor");
  assert.ok(rh.settled.c != null);
  // A chair (seat, back, 4 legs) dropped from 0.5 m: it comes to rest upright on its legs, the seat 0.46 m up.
  const chair = [boxPts([0.225, 0.025, 0.225], [0, 0.46, 0]), boxPts([0.225, 0.225, 0.025], [0, 0.7, -0.2])];
  for (const x of [-0.2, 0.2]) for (const z of [-0.2, 0.2]) chair.push(boxPts([0.02, 0.23, 0.02], [x, 0.23, z]));
  const hulls = decompose(chair, { maxHulls: 4 }).map((h) => h.v);
  const rc = simulate([{ id: "chair", shape: "hull", hulls, dynamic: true, mass: 7, bounce: 0.1, friction: 0.6, poses: [{ pos: [0, 0.5, 0], quat: [0, 0, 0, 1] }] }], 72);
  const end = rc.tracks.chair.at(-1);
  assert.ok(Math.abs(end.pos[1]) < 0.01, `chair origin at ${end.pos[1].toFixed(3)} m`);
  assert.ok(Math.abs(end.quat[3]) > 0.999, "upright");
  // A box at bonnet height (on a pedestal the car drives through): the raked fascia throws it up and over, where a
  // flat-fronted box would bat it straight ahead.
  const poses = Array.from({ length: 30 }, (_, f) => ({ pos: [0, 0, -6 + 0.5 * f], quat: [0, 0, 0, 1] }));
  const run = (shape) => simulate([{ id: "crate", shape: "box", half: [0.15, 0.15, 0.15], center: [0, 0.15, 0], dynamic: true, mass: 4, bounce: 0.2, friction: 0.6,
    poses: [{ pos: [0, 0.42, 0], quat: [0, 0, 0, 1] }] },
  { id: "pedestal", shape: "box", half: [0.2, 0.21, 0.2], center: [0, 0.21, 0], dynamic: false, poses: [{ pos: [0, 0, 0], quat: [0, 0, 0, 1] }] },
  { id: "car", shape, half: [0.95, 0.34, 2.2], center: [0, 0.45, 0], hulls: [vehicleBodyPoints([0.95, 0.34, 2.2], [0, 0.45, 0])], dynamic: false, poses }], 30);
  const peak = (r) => Math.max(...r.tracks.crate.map((p) => p.pos[1]));
  assert.ok(peak(run("hull")) > peak(run("box")) + 0.1, `raked ${peak(run("hull")).toFixed(2)} vs flat ${peak(run("box")).toFixed(2)}`);
});

test("live world: hull bodies collide and a ray hits a hull", () => {
  const w = createXpbdWorld();
  w.addBody({ id: "h", shape: "hull", hulls: [boxPts([0.3, 0.3, 0.3])], pos: [0, 1, 0], mass: 5 });
  for (let i = 0; i < 90; i++) w.step(1 / 30);
  assert.ok(Math.abs(w.getPose("h").pos[1] - 0.3) < 0.01, `${w.getPose("h").pos[1]}`);
  const hit = w.raycast([0, 5, 0], [0, -1, 0]);
  assert.equal(hit.id, "h");
  assert.ok(Math.abs(hit.point[1] - 0.6) < 0.01);
});

test("speed: hull contacts cost a few times a box's (benchmark printed; loose bound)", () => {
  const box = (shape, i) => ({ id: `b${i}`, shape, half: [0.25, 0.25, 0.25], center: [0, 0, 0], hulls: [boxPts([0.25, 0.25, 0.25])], dynamic: true, mass: 2,
    bounce: 0.1, friction: 0.6, poses: [{ pos: [(i % 3) * 0.6, 0.26 + Math.floor(i / 3) * 0.51, 0], quat: [0, Math.sin(0.02 * i), 0, Math.cos(0.02 * i)] }] });
  const cpu = (shape) => {
    const c0 = process.cpuUsage();
    const r = simulate(Array.from({ length: 12 }, (_, i) => box(shape, i)), 48, { events: false });
    const c = process.cpuUsage(c0);
    return { ms: (c.user + c.system) / 1000, r };
  };
  cpu("box"); cpu("hull");   // warm up
  const b = cpu("box"), h = cpu("hull");
  console.log(`# 12-box stack, 2 s: box ${b.ms.toFixed(0)} ms (${b.r.stats.contacts} contacts), hull ${h.ms.toFixed(0)} ms (${h.r.stats.contacts} contacts), x${(h.ms / b.ms).toFixed(2)}`);
  assert.ok(h.ms < 6 * b.ms + 50, `hull ${h.ms} ms vs box ${b.ms} ms`);
  // and the stack stands either way
  for (const r of [b.r, h.r]) for (let i = 0; i < 12; i++) assert.ok(Math.abs(r.tracks[`b${i}`].at(-1).pos[0] - (i % 3) * 0.6) < 0.02);
});
