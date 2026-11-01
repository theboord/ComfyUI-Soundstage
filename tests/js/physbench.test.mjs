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
