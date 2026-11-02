// node --test tests/js/secondary.test.mjs
// Milestone 28: secondary simulations (particles.mjs: POP / Pyro-lite dust, debris, spray, smoke) and Vellum-style soft
// bodies (softbody.mjs: cloth, rope, cardboard, grains). Determinism, constraint stability, particle settle, plasticity.
import test from "node:test";
import assert from "node:assert/strict";
import * as PT from "../../web/stage/particles.mjs";
import * as SB from "../../web/stage/softbody.mjs";

const HITS = [
  { frame: 30, t: 1.25, pos: [0, 0.4, 5], normal: [0, 0, -1], impulse: 900, speed: 11, a: "crate", b: "car", mat_a: "wood", mat_b: "metal" },
  { frame: 40, t: 1.667, pos: [0.5, 0, 6], normal: [0, 1, 0], impulse: 300, speed: 4, a: "crate", b: "__ground", mat_a: "wood", mat_b: "ground", break: true },
  { frame: 50, t: 2.083, pos: [-1, 0.1, 4], normal: [0, 1, 0], impulse: 2000, speed: 6, a: "car", b: "__ground", mat_a: "metal", mat_b: "concrete" },
];
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test("particles: the same emitters give the same frames, in any order they are asked for", () => {
  const em = PT.emittersFromImpacts(HITS, { ground: "concrete_dust", velOf: () => [0, 0, 8] });
  const a = PT.simulateParticles(em, { frames: 96 }), b = PT.simulateParticles([...em].reverse(), { frames: 96 });
  for (const f of [0, 31, 45, 60, 95]) {
    assert.ok(sameArr(a.frames[f].dust, b.frames[f].dust), `dust f${f}`);
    assert.ok(sameArr(a.frames[f].debris, b.frames[f].debris), `debris f${f}`);
  }
  const p1 = PT.particlesAt(a, 60), p2 = PT.particlesAt(a, 60);
  assert.deepEqual(p1, p2);
  assert.equal(PT.emitterSig(em, { frames: 96 }), PT.emitterSig(PT.emittersFromImpacts(HITS, { ground: "concrete_dust", velOf: () => [0, 0, 8] }), { frames: 96 }));
  assert.ok(a.stats.spawned.dust > 20 && a.stats.spawned.debris > 20 && a.stats.spawned.sparks > 0, JSON.stringify(a.stats));
});

test("particles: debris lands, settles and sleeps on the ground; dust stays above it and fades out", () => {
  const em = PT.emittersFromImpacts(HITS, { ground: "concrete_dust", velOf: () => [0, 0, 8] });
  const sim = PT.simulateParticles(em, { frames: 24 * 10 });
  assert.equal(sim.stats.debrisAsleep, sim.stats.debrisAlive, "every chunk at rest by the end");
  const last = PT.particlesAt(sim, 24 * 10 - 1);
  for (const p of last.filter((q) => q.kind === "debris")) assert.ok(p.p[1] >= 0 && p.p[1] < 0.06, `chunk height ${p.p[1]}`);
  assert.equal(last.filter((q) => q.kind === "dust").length, 0, "the dust has faded after 10 s");
  for (let f = 0; f < 24 * 6; f += 6) for (const p of PT.particlesAt(sim, f)) {
    assert.ok(Number.isFinite(p.p[0] + p.p[1] + p.p[2]));
    if (p.kind === "dust") assert.ok(p.p[1] > 0 && p.alpha >= 0 && p.alpha <= 1);
  }
  // Debris inherits the struck body's velocity: thrown downrange (+z, the car's travel) on average.
  const mid = PT.particlesAt(sim, 70).filter((q) => q.kind === "debris");
  assert.ok(mid.reduce((s, q) => s + q.p[2], 0) / mid.length > 5.5, "chips carried forward");
});

test("particles: ground presets differ (sand drifts low and long, spray falls, splinters are long)", () => {
  const ev = [{ frame: 0, t: 0, pos: [0, 0, 0], normal: [0, 1, 0], impulse: 600, speed: 5, a: "x", b: "__ground", mat_a: "stone", mat_b: "ground" }];
  const run = (ground) => PT.simulateParticles(PT.emittersFromImpacts(ev, { ground }), { frames: 60 });
  const nDust = (sim, f) => PT.particlesAt(sim, f).filter((q) => q.kind === "dust").length;
  const spray = run("wet_spray"), sand = run("desert_sand");
  assert.ok(nDust(spray, 3) > 0 && nDust(spray, 36) === 0 && nDust(sand, 36) > 0, "wet spray is a brief mist; sand dust hangs");
  for (const k of PT.GROUND_TYPES) assert.ok(PT.GROUND_PRESETS[k].dust && PT.GROUND_PRESETS[k].label);
  const wood = PT.simulateParticles(PT.emittersFromImpacts([{ ...ev[0], mat_a: "wood" }], { ground: "concrete_dust" }), { frames: 30 });
  const sp = PT.particlesAt(wood, 29).filter((q) => q.kind === "debris");
  assert.ok(sp.length && sp.every((q) => Math.max(...q.scale) / Math.min(...q.scale) > 2.5), "wood throws splinters");
  assert.equal(PT.groundPresetFor("desert", "none"), "desert_sand");
  assert.equal(PT.groundPresetFor("street_night", "rain"), "wet_spray");
  assert.equal(PT.groundPresetFor("desert", "none", "wood_splinters"), "wood_splinters");
});

test("particles: hoof strikes, tyre smoke and breaks all feed the one system", () => {
  const strikes = Array.from({ length: 12 }, (_, i) => ({ t: i * 0.2, pos: [i * 0.8, 0, 0], v: 8, dir: [1, 0], mass: 1, id: `h:${i}` }));
  const track = { pos: [], yaw: [], vel: [], smoke: [] };
  for (let f = 0; f < 48; f++) { track.pos.push([f * 0.3, 0, 0]); track.yaw.push(0); track.vel.push([7.2, 0]); track.smoke.push({ amount: f > 10 && f < 30 ? 0.8 : 0, wheels: "rear" }); }
  const wheels = [{ x: 0.8, z: 1.3, front: true }, { x: -0.8, z: 1.3, front: true }, { x: 0.8, z: -1.3, front: false }, { x: -0.8, z: -1.3, front: false }];
  const em = [...PT.emittersFromStrikes(strikes, { amount: 1, ground: "desert_sand" }), ...PT.emittersFromSmoke(track, wheels, { fps: 24 }),
    ...PT.emittersFromBreaks([{ frame: 20, pos: [2, 0.4, 1], vel: [3, 0, 0], material: "wood", pieces: 6 }])];
  const srcs = new Set(em.map((e) => e.src));
  for (const s of ["strike", "smoke", "break"]) assert.ok(srcs.has(s), s);
  assert.ok(em.filter((e) => e.src === "smoke").every((e) => e.pos[2] < 0), "smoke off the rear wheels only");
  const sim = PT.simulateParticles(em, { frames: 48 });
  assert.ok(sim.frames[30].n.dust > 30);
  assert.equal(PT.emittersFromStrikes(strikes, { amount: 0 }).length, 0, "no dust on a clean floor");
});

// ---------- soft bodies ----------
const box = (id, pos, half, frames, move = null) => ({ id, half, center: [0, 0, 0], poses: Array.from({ length: frames }, (_, f) => ({ pos: move ? move(f) : pos, quat: [0, 0, 0, 1] })) });

test("soft bodies: every kind bakes deterministically and stays finite", () => {
  for (const kind of Object.keys(SB.SOFT_KINDS)) {
    const spec = SB.softSpecOf({ id: kind, kind });
    const opts = { frames: 30, preroll: 4 };
    const a = SB.simulateSoft(spec, opts), b = SB.simulateSoft(spec, opts);
    assert.ok(a.stats.finite, kind);
    assert.ok(sameArr(a.frames[29], b.frames[29]), `${kind} deterministic`);
    assert.ok(a.stats.minY >= 0, `${kind} above the ground`);
  }
});

test("soft bodies: cloth and rope constraints hold (stretch stays small, pins stay put, wind moves it)", () => {
  const tarp = SB.softSpecOf({ id: "t", kind: "tarp" });
  const r = SB.simulateSoft(tarp, { frames: 72 });
  assert.ok(r.stats.maxStretch < 0.1, `tarp stretch ${r.stats.maxStretch}`);
  for (const i of r.sys.pins) for (const f of [0, 40, 71]) assert.ok(Math.abs(r.frames[f][3 * i + 1] - tarp.h) < 1e-6, "pinned corner");
  // The wind blows it: the free hem moves between frames.
  const hem = r.sys.n - 1;
  assert.ok(Math.abs(r.frames[60][3 * hem + 2] - r.frames[30][3 * hem + 2]) + Math.abs(r.frames[60][3 * hem] - r.frames[30][3 * hem]) > 0.02, "flapping");
  const calm = SB.simulateSoft({ ...tarp, wind: 0 }, { frames: 48 });
  assert.ok(calm.stats.maxSpeed < 3, `hangs still without wind (${calm.stats.maxSpeed})`);
  const rope = SB.simulateSoft(SB.softSpecOf({ id: "r", kind: "rope" }), { frames: 48 });
  assert.ok(rope.stats.maxStretch < 0.05, `rope stretch ${rope.stats.maxStretch}`);
  const mid = rope.frames[47][3 * Math.floor(rope.sys.n / 2) + 1];
  assert.ok(mid < 2.0 - 0.15, "the rope sags between its ends");
  const bridge = SB.simulateSoft(SB.softSpecOf({ id: "b", kind: "rope_bridge" }), { frames: 48 });
  assert.ok(bridge.stats.finite && bridge.stats.maxStretch < 0.08, `bridge stretch ${bridge.stats.maxStretch}`);
});

test("soft bodies: cloth follows an attached actor (a cape on a rider)", () => {
  const spec = SB.softSpecOf({ id: "c", kind: "cape" });
  const rider = { poses: Array.from({ length: 48 }, (_, f) => ({ pos: [f * 0.1, 0, 0], quat: [0, 0, 0, 1] })) };
  const r = SB.simulateSoft(spec, { frames: 48, attach: rider });
  const pin = r.sys.pins[0];
  assert.ok(Math.abs(r.frames[47][3 * pin] - (r.frames[0][3 * pin] + 4.7)) < 1e-4, "the pin rides the rider");
});

test("soft bodies: cardboard yields and stays crushed (plasticity), and collides with a moving box", () => {
  const spec = SB.softSpecOf({ id: "cb", kind: "cardboard" });
  const F = 72;
  // A press comes down onto the box to 0.15 m, then lifts away again.
  const press = box("press", null, [0.5, 0.2, 0.5], F, (f) => [0, f < 12 ? 1.2 : f < 30 ? 1.2 - (f - 12) / 18 * 0.85 : f < 44 ? 0.35 : 0.35 + (f - 44) * 0.08, 0]);
  const r = SB.simulateSoft(spec, { frames: F, colliders: [press] });
  const top = (fr) => { let t = 0; for (let i = 0; i < fr.length / 3; i++) t = Math.max(t, fr[3 * i + 1]); return t; };
  assert.ok(r.stats.finite);
  assert.ok(top(r.frames[0]) > 0.43, "starts full height");
  assert.ok(top(r.frames[40]) < 0.2, `crushed under the press (${top(r.frames[40])})`);
  assert.ok(top(r.frames[F - 1]) < 0.32, `stays crushed after it lifts (${top(r.frames[F - 1])})`);
  const free = SB.simulateSoft(spec, { frames: F });
  assert.ok(top(free.frames[F - 1]) > 0.43, "an untouched box keeps its shape");
});

test("soft bodies: a sand pile slumps and settles; gravel stands steeper; grains never sink", () => {
  const sand = SB.simulateSoft(SB.softSpecOf({ id: "s", kind: "sand_pile" }), { frames: 96 });
  const s0 = SB.pileShape(sand.frames[0]), s1 = SB.pileShape(sand.frames[95]);
  assert.ok(s1.slope < s0.slope - 15, `slumps (${s0.slope.toFixed(0)}° → ${s1.slope.toFixed(0)}°)`);
  assert.ok(s1.slope > 12 && s1.height > 0.15, `still a pile (${s1.slope.toFixed(0)}°, ${s1.height.toFixed(2)} m)`);
  assert.ok(sand.stats.minY >= sand.sys.radius - 1e-6);
  // The last half second barely moves (settled).
  const a = sand.frames[83], b = sand.frames[95], mv = [];
  for (let i = 0; i < a.length / 3; i++) mv.push(Math.hypot(a[3 * i] - b[3 * i], a[3 * i + 1] - b[3 * i + 1], a[3 * i + 2] - b[3 * i + 2]));
  mv.sort((x, y) => x - y);
  assert.ok(mv[Math.floor(mv.length * 0.9)] < 0.03, `settling (90% of grains move < ${mv[Math.floor(mv.length * 0.9)].toFixed(3)} m in the last half second)`);
  const gravel = SB.simulateSoft(SB.softSpecOf({ id: "g", kind: "gravel_pile" }), { frames: 96 });
  assert.ok(SB.pileShape(gravel.frames[95]).slope > s1.slope, "gravel stands steeper than sand");
  // A box driven through the pile spills it along its path.
  const car = box("car", null, [0.9, 0.35, 2.2], 72, (f) => [0, 0.45, -6 + f * 0.25]);
  const hit = SB.simulateSoft(SB.softSpecOf({ id: "s", kind: "sand_pile", physics: { soft: { preroll: 30 } } }), { frames: 72, colliders: [car] });
  let far = 0; const L = hit.frames[71]; for (let i = 0; i < L.length / 3; i++) far = Math.max(far, L[3 * i + 2]);
  assert.ok(far > 1.5, `spilled downrange (${far.toFixed(2)} m)`);
});
