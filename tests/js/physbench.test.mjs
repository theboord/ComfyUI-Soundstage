// The bake against textbook answers (the physbench findings, tools/physbench): Coulomb friction that doesn't depend on
// mass, and a tall stack that stands still before anything touches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../../web/stage/physics.mjs";

const G = 9.81, FPS = 24;
const box = (id, size, pos, extra = {}) => ({ id, shape: "box", half: size.map((v) => v / 2), center: [0, 0, 0], dynamic: true,
  mass: 2, bounce: 0, friction: 0.6, poses: [{ pos, quat: [0, 0, 0, 1] }], ...extra });

function rampRun(mass) {
  const th = Math.PI / 6, mu = 0.5, q = [0, 0, Math.sin(-th / 2), Math.cos(-th / 2)];
  const n = [Math.sin(th), Math.cos(th), 0], d = [Math.cos(th), -Math.sin(th), 0], C = [0, 1.9, 0];
  const start = [0, 1, 2].map((i) => C[i] + 0.1 * n[i] - 2.6 * d[i] + 0.25 * n[i]);
  const specs = [
    { ...box("ramp", [7, 0.2, 2], C), dynamic: false, friction: mu, poses: [{ pos: C, quat: q }] },
    { ...box("slider", [0.5, 0.5, 0.5], start), mass, friction: mu, poses: [{ pos: start, quat: q }] },
  ];
  const F = 48, r = simulate(specs, F, { fps: FPS, events: false });
  const s = r.tracks.slider.map((p) => [0, 1, 2].reduce((acc, i) => acc + (p.pos[i] - start[i]) * d[i], 0));
  // least-squares a in s = a t^2 / 2 over the 2 s
  let num = 0, den = 0;
  s.forEach((v, f) => { const x = 0.5 * (f / FPS) ** 2; num += v * x; den += x * x; });
  return { a: num / den, expected: G * (Math.sin(th) - mu * Math.cos(th)) };
}

test("a box sliding down a 30 deg ramp (mu 0.5) accelerates at g(sin - mu cos), light or heavy", () => {
  for (const m of [2, 25]) {
    const { a, expected } = rampRun(m);
    assert.ok(Math.abs(a - expected) / expected < 0.05, `${m} kg: a ${a.toFixed(3)} vs ${expected.toFixed(3)} m/s^2`);
  }
});

test("a crate shoved across the floor stops in v^2 / (2 mu g), whatever it weighs", () => {
  for (const m of [2, 25]) {
    const v = 4, F = 48, keys = Array.from({ length: 3 }, (_, f) => ({ pos: [(f - 2) * v / FPS, 0.4, 0], quat: [0, 0, 0, 1] }));
    const specs = [box("c", [0.8, 0.8, 0.8], [0, 0.4, 0], { mass: m, friction: 0.6, poses: keys, release: 2 })];
    const r = simulate(specs, F, { fps: FPS, events: false });
    const mu = Math.sqrt(0.6 * 0.8);   // the crate on the stage floor (friction 0.8)
    const dist = r.tracks.c.at(-1).pos[0], expected = v * v / (2 * mu * G);
    assert.ok(Math.abs(dist - expected) / expected < 0.1, `${m} kg slid ${dist.toFixed(3)} m, expected ${expected.toFixed(3)} m`);
  }
});

test("a 20-carton tower left alone for 3 s doesn't bow or walk (under 2 cm anywhere)", () => {
  const specs = Array.from({ length: 20 }, (_, i) => box(`t${i}`, [0.5, 0.5, 0.5], [0, 0.25 + 0.5 * i, 0], { bounce: 0.2 }));
  const r = simulate(specs, 3 * FPS, { fps: FPS, events: false });
  const worst = Math.max(...specs.map((s) => Math.max(...r.tracks[s.id].map((p) => Math.hypot(p.pos[0] - s.poses[0].pos[0], p.pos[2] - s.poses[0].pos[2])))));
  assert.ok(worst < 0.02, `drifted ${(worst * 1000).toFixed(1)} mm`);
});

// ---- physbench round 2 ----
import { readFileSync } from "node:fs";
import { createXpbdWorld } from "../../web/stage/physics.mjs";

test("live world: a box on a 30 deg ramp (mu 0.5) accelerates at g(sin - mu cos), light or heavy (Coulomb friction)", () => {
  const th = Math.PI / 6, mu = 0.5, q = [0, 0, Math.sin(-th / 2), Math.cos(-th / 2)];
  const n = [Math.sin(th), Math.cos(th), 0], d = [Math.cos(th), -Math.sin(th), 0], C = [0, 1.9, 0];
  const expected = G * (Math.sin(th) - mu * Math.cos(th));
  for (const m of [2, 25]) {
    const w = createXpbdWorld();
    w.addBody({ shape: "box", half: [3.5, 0.1, 1], center: [0, 0, 0], type: "static", friction: mu, pos: C, quat: q });
    const start = [0, 1, 2].map((i) => C[i] + 0.1 * n[i] - 2.6 * d[i] + 0.25 * n[i]);
    const id = w.addBody({ shape: "box", half: [0.25, 0.25, 0.25], center: [0, 0, 0], type: "dynamic", mass: m, friction: mu, restitution: 0, pos: start, quat: q });
    let num = 0, den = 0;
    for (let f = 1; f <= 90; f++) {   // 1.5 s at 60 Hz (under the live speed cap)
      w.step(1 / 60);
      const p = w.getPose(id).pos, s = [0, 1, 2].reduce((acc, i) => acc + (p[i] - start[i]) * d[i], 0), x = 0.5 * (f / 60) ** 2;
      num += s * x; den += x * x;
    }
    const a = num / den;
    assert.ok(Math.abs(a - expected) / expected < 0.1, `${m} kg: a ${a.toFixed(3)} vs ${expected.toFixed(3)} m/s^2`);
  }
});

/** Deepest overlap of two oriented boxes over the 15 separating axes (0 when apart), as tools/physbench/analyze.py. */
function obbOverlap(ca, qa, ha, cb, qb, hb) {
  const R = (q) => { const [x, y, z, w] = q;
    return [[1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
      [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]]; };   // rows = the box's axes in world
  const A = R(qa), B = R(qb), dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2], t = [0, 1, 2].map((i) => cb[i] - ca[i]);
  const axes = [...A, ...B];
  for (const u of A) for (const v of B) { const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...c); if (l > 1e-6) axes.push(c.map((x) => x / l)); }
  let m = Infinity;
  for (const L of axes) {
    const o = [0, 1, 2].reduce((s, k) => s + ha[k] * Math.abs(dot(A[k], L)) + hb[k] * Math.abs(dot(B[k], L)), 0) - Math.abs(dot(t, L));
    if (o <= 0) return 0;
    m = Math.min(m, o);
  }
  return m;
}

test("a braking car through a crate pyramid: speculative contacts keep the overlap small (p95 under 3 mm, Bullet 1.7)", () => {
  const sc = JSON.parse(readFileSync(new URL("../../tools/physbench/scenes.json", import.meta.url), "utf8")).scenes.find((s) => s.name === "s3_pyramid");
  const F = sc.frames;
  const specs = sc.bodies.map((b) => ({ id: b.id, shape: "box", half: b.size.map((v) => v / 2), center: [0, 0, 0], dynamic: b.type === "dynamic",
    mass: b.mass, bounce: b.restitution, friction: b.friction, release: 0,
    poses: b.keys ? Array.from({ length: F }, (_, f) => ({ pos: b.keys[Math.min(f, b.keys.length - 1)], quat: b.quat })) : [{ pos: b.pos, quat: b.quat }] }));
  const r = simulate(specs, F, { fps: sc.fps || FPS, gravity: sc.gravity, events: false });
  const at = (b, f) => (r.tracks[b.id] ? r.tracks[b.id][f] : { pos: b.keys ? b.keys[Math.min(f, b.keys.length - 1)] : b.pos, quat: b.quat });
  const pen = [];
  for (let f = 0; f < F; f++) {
    let worst = 0;
    for (let i = 0; i < sc.bodies.length; i++) for (let j = i + 1; j < sc.bodies.length; j++) {
      const a = sc.bodies[i], b = sc.bodies[j], pa = at(a, f), pb = at(b, f);
      if (Math.hypot(...pa.pos.map((v, k) => v - pb.pos[k])) > Math.hypot(...a.size) / 2 + Math.hypot(...b.size) / 2) continue;
      worst = Math.max(worst, obbOverlap(pa.pos, pa.quat, a.size.map((v) => v / 2), pb.pos, pb.quat, b.size.map((v) => v / 2)));
    }
    pen.push(worst);
  }
  const p95 = [...pen].sort((x, y) => x - y)[Math.floor(0.95 * (F - 1))], max = Math.max(...pen);
  assert.ok(p95 < 0.003, `p95 overlap ${(p95 * 1000).toFixed(1)} mm`);
  assert.ok(max < 0.0075, `max overlap ${(max * 1000).toFixed(1)} mm (Bullet 7.2)`);
  const moved = sc.bodies.filter((b) => b.type === "dynamic" && Math.hypot(...r.tracks[b.id].at(-1).pos.map((v, k) => v - b.pos[k])) > 1).length;
  assert.equal(moved, 10, "every crate is thrown");
});
