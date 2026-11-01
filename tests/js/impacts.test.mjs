// Milestone 21: impact events from the bake, and the realism layers that key off them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../../web/stage/physics.mjs";
import { mergeEvents, eventsFromTracks, materialOf, strengthOf, impactParticles, impactFlash } from "../../web/stage/impacts.mjs";
import { impactEvents } from "../../web/stage/physengine.mjs";

const crate = (id, pos, extra = {}) => ({ id, shape: "box", half: [0.4, 0.4, 0.4], center: [0, 0.4, 0], dynamic: true, mass: 25,
  bounce: 0.2, friction: 0.6, material: "wood", poses: [{ pos, quat: [0, 0, 0, 1] }], ...extra });

test("two drops from different heights: one landing event each, the higher one hits harder and later", () => {
  const low = simulate([crate("c", [0, 0.6, 0])], 72).events, high = simulate([crate("c", [0, 2.4, 0])], 72).events;
  assert.ok(low.length >= 1 && high.length >= 1);
  const [a, b] = [low[0], high[0]];
  assert.equal(a.b, "__ground"); assert.equal(a.mat_a, "wood"); assert.equal(a.mat_b, "ground");
  assert.ok(b.impulse > a.impulse * 1.5, `impulse ${a.impulse} -> ${b.impulse}`);
  assert.ok(b.speed > a.speed && b.frame > a.frame);
  // Landing speed matches free fall: v = sqrt(2 g h) from the crate's underside drop height.
  assert.ok(Math.abs(b.speed - Math.sqrt(2 * 9.81 * 2.4)) < 0.5, `speed ${b.speed}`);
  assert.ok(Math.abs(a.pos[1]) < 0.03 && a.normal[1] > 0.99);
  assert.ok(Math.abs(b.t * 24 - b.frame) <= 0.5);
});

test("a resting stack logs no hits; a crate set down gently logs none either", () => {
  const r = simulate([crate("c0", [0, 0, 0]), crate("c1", [0, 0.8, 0])], 72);
  assert.equal(r.events.length, 0);
  assert.equal(r.stats.impacts, 0);
});

test("a keyed car through a crate: the car hit is logged against the car with its material and the crate's", () => {
  const F = 72, poses = [];
  for (let f = 0; f < F; f++) poses.push({ pos: [0, 0, -6 + f * 0.5], quat: [0, 0, 0, 1] });
  const car = { id: "car#body", shape: "box", half: [0.9, 0.5, 2.2], center: [0, 0.5, 0], dynamic: false, poses, material: "metal" };
  const r = simulate([car, crate("c", [0, 0, 3])], F);
  const hit = r.events.find((e) => [e.a, e.b].includes("car#body"));
  assert.ok(hit, JSON.stringify(r.events));
  assert.ok(hit.speed > 9 && hit.speed < 15, `speed ${hit.speed}`);
  assert.ok([hit.mat_a, hit.mat_b].includes("metal") && [hit.mat_a, hit.mat_b].includes("wood"));
  // Reduced mass against an unmovable car is the crate's mass: J = m v (1 + e).
  assert.ok(hit.impulse > 25 * hit.speed * 0.9 && hit.impulse < 25 * hit.speed * 1.3, `J ${hit.impulse}`);
});

test("the same scene logs the same events (deterministic), and events can be switched off", () => {
  const s = () => [crate("a", [0, 1.5, 0]), crate("b", [0.3, 3.2, 0.1])];
  assert.deepEqual(simulate(s(), 80).events, simulate(s(), 80).events);
  assert.deepEqual(simulate(s(), 80, { events: false }).events, []);
});

test("mergeEvents folds a hit's probes and substeps into one event per pair and keeps the strongest", () => {
  const h = (frame, impulse, a = "x", b = "__ground") => ({ frame, t: frame / 24, pos: [0, 0, 0], normal: [0, 1, 0], impulse, speed: impulse / 25, a, b, mat_a: "wood", mat_b: "ground" });
  const m = mergeEvents([h(10, 50), h(10, 80), h(11, 60), h(30, 20), h(10, 40, "y")]);
  assert.equal(m.length, 3);
  assert.equal(m.find((e) => e.a === "x" && e.frame === 10).impulse, 80);
  const many = mergeEvents(Array.from({ length: 200 }, (_, i) => h(i * 5, i + 1, `b${i}`)), { max: 10 });
  assert.equal(many.length, 10);
  assert.ok(many.every((e) => e.impulse > 190));
  assert.ok(many.every((e, i) => !i || e.t >= many[i - 1].t), "sorted by time");
});

test("eventsFromTracks finds the same landing from the baked track alone (any backend)", () => {
  const r = simulate([crate("c", [0, 2.4, 0])], 72);
  const ev = eventsFromTracks(r.tracks, { c: { mass: 25, material: "wood" } });
  assert.ok(ev.length >= 1);
  assert.ok(Math.abs(ev[0].frame - r.events[0].frame) <= 1, `${ev[0].frame} vs ${r.events[0].frame}`);
  assert.equal(ev[0].b, "__ground");
  assert.deepEqual(impactEvents(r.tracks, { c: { mass: 25, material: "wood" } }), ev);
});

test("materials come from the kind, an override wins, and strength grows with impulse", () => {
  assert.equal(materialOf({ kind: "crate" }), "wood");
  assert.equal(materialOf({ kind: "sports_car" }), "metal");
  assert.equal(materialOf({ kind: "crate", physics: { material: "cardboard" } }), "cardboard");
  assert.equal(materialOf({ kind: "crate", physics: { material: "nonsense" } }), "wood");
  assert.ok(strengthOf({ impulse: 400 }) > strengthOf({ impulse: 100 }));
  assert.ok(Math.abs(strengthOf({ impulse: 130 }) - 1) < 1e-9);
});

const ev = (over = {}) => ({ frame: 24, t: 1, pos: [0, 0, 0], normal: [0, 1, 0], impulse: 130, speed: 4.4, a: "c", b: "__ground", mat_a: "wood", mat_b: "ground", ...over });

test("impact particles are a pure function of the events and the frame (deterministic, seeded)", () => {
  const E = [ev(), ev({ frame: 40, t: 40 / 24, pos: [2, 0.4, 1], normal: [1, 0, 0], impulse: 300, speed: 9, b: "car", mat_b: "metal" })];
  for (const F of [24, 26, 30, 41, 60]) assert.deepEqual(impactParticles(E, F), impactParticles(E, F));
  assert.notDeepEqual(impactParticles(E, 30, { seed: 1 }), impactParticles(E, 30, { seed: 2 }));
  assert.equal(impactParticles(E, 23).length, 0, "nothing before the first hit");
  assert.ok(impactParticles(E, 30).some((q) => q.kind === "dust"));
  assert.ok(impactParticles(E, 300).length < impactParticles(E, 30).length, "dust fades away");
});

test("bigger hits throw more dust and debris; sparks only off metal; switches turn layers off", () => {
  const soft = impactParticles([ev({ impulse: 60, speed: 2.5 })], 30), hard = impactParticles([ev({ impulse: 500, speed: 9 })], 30);
  const n = (L, k) => L.filter((q) => q.kind === k).length;
  assert.ok(n(hard, "dust") > n(soft, "dust"), `${n(soft, "dust")} -> ${n(hard, "dust")}`);
  assert.ok(n(hard, "debris") > n(soft, "debris"));
  assert.equal(n(hard, "spark"), 0, "wood on the ground: no sparks");
  const metal = impactParticles([ev({ impulse: 400, speed: 10, mat_a: "metal", mat_b: "concrete" })], 26);
  assert.ok(n(metal, "spark") > 5);
  assert.equal(n(impactParticles([ev({ impulse: 400, speed: 10, mat_b: "metal" })], 26), "spark"), 0, "a car into a wooden crate: splinters, no sparks");
  const off = impactParticles([ev({ impulse: 400, speed: 10, mat_b: "metal" })], 26, { dust: false, debris: false, sparks: false });
  assert.equal(off.length, 0);
  // Every particle is above the floor, with a sane size and opacity.
  for (const q of [...hard, ...metal]) {
    assert.ok(q.p[1] >= 0.01 && q.size > 0 && q.size < 5 && q.alpha >= 0 && q.alpha <= 1, JSON.stringify(q));
  }
  // Cardboard dust is tan, concrete grey.
  const tan = impactParticles([ev({ mat_a: "cardboard", mat_b: "cardboard" })], 30).find((q) => q.kind === "dust").color;
  assert.ok(tan[0] > tan[2] + 0.15, `tan ${tan}`);
});

test("the light flash is brief, only on hard metal hits, and scales with the hit", () => {
  const m = ev({ impulse: 400, speed: 10, mat_a: "metal", mat_b: "metal" });
  const at = (F, e = m) => impactFlash([e], F).intensity;
  assert.equal(at(23), 0);
  assert.ok(at(24) > 1);
  assert.ok(at(26) < at(24) * 0.5, "falls off in a couple of frames");
  assert.equal(at(40), 0);
  assert.equal(impactFlash([ev()], 24).intensity, 0, "wood on the ground: no flash");
  assert.equal(impactFlash([ev({ impulse: 400, speed: 10, mat_b: "metal" })], 24).intensity, 0, "wood into a car: no flash");
  assert.ok(at(24, { ...m, impulse: 100 }) < at(24));
});
