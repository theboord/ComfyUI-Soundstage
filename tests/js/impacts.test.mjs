// Milestone 21: impact events from the bake, and the realism layers that key off them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../../web/stage/physics.mjs";
import { mergeEvents, eventsFromTracks, materialOf, strengthOf, impactParticles, impactFlash, impactShake, SHAKE_PRESETS } from "../../web/stage/impacts.mjs";
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

const still = (n = 72) => Array.from({ length: n }, () => ({ position: [0, 1.5, 8], target: [0, 1, 0], focal_mm: 35 }));
const off = (c, c0) => Math.hypot(c.target[0] - c0.target[0], c.target[1] - c0.target[1], c.target[2] - c0.target[2]) + Math.abs(c.roll || 0) * 8;

test("impact shake: nothing before the hit and its delay, a jolt after, decaying back to still; seeded and pure", () => {
  const P = still(), E = [ev({ frame: 24, t: 1, impulse: 300, speed: 10 })];
  const s = impactShake(P, E, { preset: "heavy" });
  const d = SHAKE_PRESETS.heavy.delay;
  for (let f = 0; f < 24 + d; f++) assert.equal(off(s[f], P[f]), 0, `frame ${f} moved`);
  const peak = Math.max(...s.slice(24 + d, 24 + d + 6).map((c, i) => off(c, P[24 + d + i])));
  assert.ok(peak > 0.01, `peak ${peak}`);
  assert.ok(off(s[70], P[70]) < peak * 0.05, "settled");
  assert.deepEqual(impactShake(P, E, { preset: "heavy" }), s);
  assert.notDeepEqual(impactShake(P, E, { preset: "heavy", seed: 9 }), s);
  // The angle stays small (no more than 2.5 degrees of aim), and the camera position barely moves.
  for (let f = 0; f < s.length; f++) {
    const ang = Math.atan2(Math.hypot(s[f].target[0], s[f].target[1] - 1), 8);
    assert.ok(ang < 2.6 * Math.PI / 180, `frame ${f}: ${ang}`);
    assert.ok(Math.abs(s[f].position[1] - 1.5) < 0.002);
  }
});

test("impact shake scales with the hit, falls off with distance, and a tripod feels less than handheld", () => {
  const P = still();
  const peak = (E, o = {}) => Math.max(...impactShake(P, E, { preset: "heavy", ...o }).map((c, f) => off(c, P[f])));
  const hit = (over) => [ev({ impulse: 300, speed: 10, ...over })];
  assert.ok(peak(hit({ impulse: 600 })) > peak(hit({ impulse: 100 })) * 1.5);
  assert.ok(peak(hit({ pos: [0, 0, 0] })) > peak(hit({ pos: [0, 0, -40] })) * 4, "far hits barely shake");
  assert.ok(peak(hit(), { rig: "tripod" }) < peak(hit(), { rig: "handheld" }) * 0.5);
  assert.ok(peak(hit(), { preset: "earthquake" }) > peak(hit(), { preset: "light" }));
  assert.equal(peak(hit(), { preset: "off" }), 0);
  assert.deepEqual(impactShake(P, [], { preset: "heavy" }), P);
});

test("impact sounds land on A2 at the hit's record frame, in every clip that shows it; re-running replaces them", async () => {
  const { impactClips, withImpactClips } = await import("../../web/cut/impactsfx.mjs");
  const TL = await import("../../web/cut/timeline.mjs");
  const project = TL.normalizeProject({ fps: 24, shots: [{ id: "wide", frames: 121 }, { id: "close", frames: 121 }],
    cut: [{ shot_id: "wide", in: 0, out: 60 }, { shot_id: "close", in: 50, out: 100 }], audio: [{ id: "m", track: 3, url: "x.wav", frames: 100 }] });
  const lib = { wood: [{ url: "w1.wav", seconds: 0.9 }, { url: "w2.wav", seconds: 0.9 }], metal: [{ url: "m1.wav", seconds: 1.6 }] };
  const cues = [{ frame: 55, material: "wood", gain_db: -3, variant: 1 }, { frame: 80, material: "metal", gain_db: 0, variant: 0 }, { frame: 110, material: "wood", gain_db: 0, variant: 0 }];
  const clips = impactClips(project, cues, lib, 24);
  // Frame 55 is in both clips (wide 0-60 at record 55; close 50-100 at record 60+5); 80 only in close; 110 in neither.
  assert.deepEqual(clips.map((c) => [c.start_frame, c.label, c.track]), [[55, "wood hit", 2], [65, "wood hit", 2], [90, "metal hit", 2]]);
  assert.equal(clips[0].url, "w2.wav");
  assert.equal(clips[0].gain_db, -3);
  assert.equal(clips[2].frames, Math.round(1.6 * 24));
  const once = withImpactClips(project, clips), twice = withImpactClips({ ...project, audio: once }, clips);
  assert.equal(twice.filter((a) => a.meta?.impact).length, 3);
  assert.ok(twice.some((a) => a.id === "m"), "other audio stays");
});

test("imperfection: seeded per id, within its spread, and a 20-carton tower with it still stands", async () => {
  const { jitterPhysics, jitterTilt } = await import("../../web/stage/impacts.mjs");
  const base = { mass: 2, friction: 0.7, bounce: 0.03 };
  assert.deepEqual(jitterPhysics(base, "c1"), jitterPhysics(base, "c1"));
  const all = Array.from({ length: 50 }, (_, i) => jitterPhysics(base, `c${i}`));
  assert.ok(new Set(Array.from({ length: 50 }, (_, i) => jitterPhysics({ ...base, mass: 25 }, `c${i}`).mass)).size > 40, "every crate a little different");
  for (const p of all) {
    assert.ok(p.mass >= 2 * 0.85 - 1e-9 && p.mass <= 2 * 1.15 + 1e-9);
    assert.ok(p.friction >= 0.7 * 0.88 - 1e-3 && p.friction <= 0.7 * 1.12 + 1e-3);
    assert.ok(p.bounce >= 0 && p.bounce <= 0.03 * 1.2 + 1e-3);
  }
  const q = jitterTilt("c1"), ang = 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI;
  assert.ok(ang > 0 && ang < 3.6, `tilt ${ang}`);
  // The 20-carton tower (CHANGELOG Milestone 9: the live world's guarantee), every carton jittered: still under 2 mm in 3 s.
  const { createWorld } = await import("../../web/stage/physengine.mjs");
  const w = createWorld();
  const ids = Array.from({ length: 20 }, (_, i) => { const j = jitterPhysics(base, `t${i}`);
    return w.addBody({ shape: "box", half: [0.25, 0.25, 0.25], center: [0, 0.25, 0], type: "dynamic", mass: j.mass, friction: j.friction, restitution: j.bounce, pos: [0, i * 0.5, 0] }); });
  const p0 = ids.map((id) => w.getPose(id).pos);
  for (let i = 0; i < 180; i++) w.step(1 / 60);
  const worst = Math.max(...ids.map((id, i) => Math.hypot(...w.getPose(id).pos.map((v, k) => v - p0[i][k]))));
  assert.ok(worst < 0.002, `moved ${(worst * 1000).toFixed(1)} mm`);
});

test("an imperfect crate pyramid: varied sizes, each crate on the tallest one under it, nobody overlapping; it stands", async () => {
  const { imperfectStack } = await import("../../web/stage/impacts.mjs");
  const { crateStack } = await import("../../web/presets/engine.mjs");
  const pts = crateStack([0, 0, 5], 0, 10);
  const st = imperfectStack(pts, 0.8, 7);
  assert.deepEqual(st, imperfectStack(pts, 0.8, 7));
  assert.notDeepEqual(st, imperfectStack(pts, 0.8, 8));
  assert.ok(new Set(st.map((c) => c.height_m)).size >= 8);
  for (const c of st) assert.ok(c.height_m >= 0.8 * 0.86 - 1e-9 && c.height_m <= 0.8 * 0.97 + 1e-9 && Math.abs(c.rotation_deg) <= 2.5);
  // Crates on the floor sit at y 0; upper ones exactly on the top of a lower crate.
  for (const c of st) if (c.position[1] > 0) assert.ok(st.some((d) => Math.abs(d.position[1] + d.height_m - c.position[1]) < 1e-3), "sits on a crate");
  // Simulate it: it stays a pile (the top crate may lean and settle a few cm; nothing slides off).
  const D = Math.PI / 180;
  const specs = st.map((c, i) => ({ id: `k${i}`, shape: "box", half: [c.height_m / 2, c.height_m / 2, c.height_m / 2], center: [0, c.height_m / 2, 0],
    dynamic: true, mass: 25, bounce: 0.2, friction: 0.6, poses: [{ pos: c.position, quat: [0, Math.sin(c.rotation_deg * D / 2), 0, Math.cos(c.rotation_deg * D / 2)] }] }));
  const r = simulate(specs, 72);
  const worst = Math.max(...specs.map((s) => Math.hypot(...r.tracks[s.id].at(-1).pos.map((v, k) => v - s.poses[0].pos[k]))));
  assert.ok(worst < 0.12, `moved ${(worst * 100).toFixed(1)} cm`);
  assert.ok(r.tracks.k9.at(-1).pos[1] > 2, "the top crate is still on top");
});
