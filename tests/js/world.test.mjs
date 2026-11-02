// World collisions: everything collides in the bake by real masses, speeds and strengths (web/stage/world.mjs on
// physics.mjs simulate()). Cars crash into cars instead of passing through, poles snap, walls stop a car or let it
// through, cars trip on a kerb above the critical speed, people are knocked over, and the bake is deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, bakeTrack, qrot } from "../../web/stage/physics.mjs";
import { worldSpecs, vehicleMass, interpenetrations, consequences, planRam, rerouteKeys, clearOffset, mergeEdits, inputSig, rebaker,
  restingSpec, restingSupports, bakeActor, unbakeActor, sampleBaked, takeoverWords, WALL_BLOCK, G } from "../../web/stage/world.mjs";

const FPS = 24, F = 97;
const CAR = { half: [0.9, 0.725, 2.25], center: [0, 0.725, 0] };
const qy = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const line = (p0, v, { yaw = 0, n = F } = {}) => Array.from({ length: n }, (_, f) => ({ pos: [p0[0] + v[0] * f / FPS, 0, p0[2] + v[2] * f / FPS], quat: qy(yaw) }));
const car = (id, kind, poses, physics) => ({ id, kind, ...CAR, poses, physics });
const vz = (tr, f) => (tr[f].pos[2] - tr[f - 1].pos[2]) * FPS;
const up = (p) => qrot(p.quat, [0, 1, 0])[1];
/** Items for the consequence check from specs and a bake's tracks (keyed bodies: their poses). */
const itemsOf = (specs, res) => specs.filter((s) => !s.wallOf).map((s) => ({ id: s.id, kind: s.kind, half: s.half, center: s.center, poses: res?.tracks[s.id] || s.poses }));

test("a police car keyed through a parked car crashes into it: momentum is shared, nothing passes through", () => {
  // Coasting after the hit (no braking), so the momentum through the crash is all that's measured.
  const bodies = [car("police", "police_car", line([0, 0, -20], [0, 0, 15]), { afterContact: "coast" }), car("red", "car", line([0, 0, 0], [0, 0, 0]), { afterContact: "coast" })];
  const specs = bodies.flatMap((b) => worldSpecs(b));
  assert.ok(interpenetrations(itemsOf(specs), F).length === 1, "keyed, they pass through each other");
  const r = simulate(specs, F, { fps: FPS });
  const P = r.tracks.police, R = r.tracks.red, hit = r.takeovers.police.frame;
  assert.equal(r.takeovers.red.frame, hit, "both taken over at the hit");
  assert.equal(r.takeovers.police.by, "red");
  // Before the hit the police car is exactly on its keys.
  for (let f = 0; f < hit - 1; f++) assert.ok(Math.abs(P[f].pos[2] - (-20 + 15 * f / FPS)) < 1e-9, `f${f} on its keys`);
  // Just after: total momentum kept (within the braking of a frame or two), the red car leaves faster (e ~ 0.1).
  const f = hit + 2, p0 = 1900 * 15, p = 1900 * vz(P, f) + 1450 * vz(R, f);
  assert.ok(Math.abs(p - p0) / p0 < 0.08, `momentum ${p.toFixed(0)} vs ${p0}`);
  const e = (vz(R, f) - vz(P, f)) / 15;
  assert.ok(e > 0 && e < 0.3, `restitution ${e.toFixed(2)}`);
  assert.ok(Math.abs(vz(R, f) - p0 / 3350) < 1.5, `red car ${vz(R, f).toFixed(2)} m/s vs plastic ${(p0 / 3350).toFixed(2)}`);
  // Coasting, they roll on (rolling resistance 0.02 g); nothing overlaps at any frame.
  assert.ok(vz(R, 96) > 5 && vz(R, 96) < vz(R, f), "still rolling, slower");
  const braked = simulate([...worldSpecs(car("police", "police_car", line([0, 0, -20], [0, 0, 15]))), ...worldSpecs(car("red", "car", line([0, 0, 0], [0, 0, 0])))], F, { fps: FPS });
  assert.ok(Math.abs(vz(braked.tracks.red, 96)) < 0.05, "with the drivers braking (the default), both come to rest");
  assert.deepEqual(interpenetrations(itemsOf(specs, r), F), []);
  // Crush: the energy split by stiffness, sqrt(2E/k) (red: 1e6 N/m against the police car's 1.2e6).
  const mu = 1900 * 1450 / 3350, E = 0.5 * mu * 225, Ered = E * 1.2e6 / 2.2e6;
  assert.ok(Math.abs(r.crush.red[0].depth - Math.sqrt(2 * Ered / 1e6)) < 0.04, `red crush ${r.crush.red[0].depth}`);
});

test("a scripted chase: every car, person, lamp and crate collides; after the bake nothing interpenetrates", () => {
  const person = { id: "mara", kind: "woman", half: [0.3, 0.85, 0.2], center: [0, 0.85, 0], poses: [{ pos: [2.2, 0, 24], quat: [0, 0, 0, 1] }] };
  const lamp = { id: "lamp", kind: "lamp", half: [0.5, 2.1, 0.2], center: [0, 2.1, 0], poses: [{ pos: [0.8, 0, 10], quat: [0, 0, 0, 1] }] };
  const red = car("red", "sports_car", line([0, 0, -10], [0.18, 0, 10]));
  const police = car("police", "police_car", line([0, 0, -30], [0.2, 0, 16]));
  const crate = (id, x, y, z) => restingSpec({ id, shape: "box", half: [0.4, 0.4, 0.4], center: [0, 0.4, 0], dynamic: true, mass: 25, bounce: 0.2, friction: 0.6,
    poses: [{ pos: [x, y, z], quat: [0, 0, 0, 1] }] });
  const crates = [crate("c1", 1.5, 0, 30), crate("c2", 2.4, 0, 30), crate("c3", 1.95, 0.8, 30)];
  const sup = restingSupports(crates.map((c) => ({ id: c.id, box: { min: [c.poses[0].pos[0] - 0.4, c.poses[0].pos[1], c.poses[0].pos[2] - 0.4], max: [c.poses[0].pos[0] + 0.4, c.poses[0].pos[1] + 0.8, c.poses[0].pos[2] + 0.4] } })));
  assert.deepEqual(sup, { c1: ["c3"], c2: ["c3"] }, "the top crate stands on both");
  const specs = [...[police, red, person, lamp].flatMap((b) => worldSpecs(b)), ...crates.map((c) => ({ ...c, anchor: { ...c.anchor, supports: sup[c.id] || [] } }))];
  const before = interpenetrations(itemsOf(specs), F);
  assert.ok(before.length >= 3, `keyed, things pass through each other (${before.map((o) => o.a + "/" + o.b).join(", ")})`);
  const r = simulate(specs, F, { fps: FPS });
  assert.ok(r.takeovers.police && r.takeovers.red, "the physics took over both cars");
  assert.ok(r.takeovers.lamp, "the lamp was knocked loose");
  const after = interpenetrations(itemsOf(specs, r), F, { tol: 0.05 });
  assert.deepEqual(after, [], `after the bake: ${JSON.stringify(after)}`);
  assert.ok(r.events.length > 2, "the hits are logged (dust, shake, sound)");
});

test("a car knocks a street lamp down at speed (a breakaway base) and keeps most of its speed; a thrown crate doesn't", () => {
  const lamp = { id: "lamp", kind: "lamp", half: [0.6, 2.1, 0.2], center: [0.3, 2.1, 0], poses: [{ pos: [0, 0, 0], quat: [0, 0, 0, 1] }] };
  const specs = [...worldSpecs(car("car", "car", line([0.3, 0, -12], [0, 0, 12]))), ...worldSpecs(lamp)];
  const r = simulate(specs, F, { fps: FPS });
  const hit = r.takeovers.lamp.frame, C = r.tracks.car;
  assert.equal(r.takeovers.lamp.reason, "anchor");
  assert.ok(up(r.tracks.lamp.at(-1)) < 0.5, `the lamp is down (up ${up(r.tracks.lamp.at(-1)).toFixed(2)})`);
  // A breakaway support costs the car 1-3 m/s (AASHTO): the speed just after the hit, before the driver's braking adds up.
  const dv = 12 - vz(C, hit + 2);
  assert.ok(dv > 0.3 && dv < 3, `the car lost ${dv.toFixed(2)} m/s`);
  // A 25 kg crate thrown at the lamp at 5 m/s: the base holds.
  const throwPoses = Array.from({ length: 3 }, (_, f) => ({ pos: [0, 1, -2 + (f - 2) * 5 / FPS], quat: [0, 0, 0, 1] }));
  const r2 = simulate([...worldSpecs(lamp), { id: "crate", shape: "box", half: [0.3, 0.3, 0.3], center: [0, 0, 0], dynamic: true, mass: 25, bounce: 0.2, friction: 0.6, poses: throwPoses, release: 2 }], 48, { fps: FPS });
  assert.equal(r2.takeovers.lamp, undefined, "the lamp stands");
  assert.ok(up(r2.tracks.lamp.at(-1)) > 0.999);
});

test("a solid wall stops a car and it crumples by its crush stiffness; a weak wall stops it slow and lets it through fast", () => {
  const wall = (material) => ({ id: "wall", kind: "wall", half: [3, 1.2, 0.1], center: [0, 1.2, 0], poses: [{ pos: [0, 0, 0], quat: [0, 0, 0, 1] }], physics: { material } });
  const run = (material, v, z0) => {
    const specs = [...worldSpecs(car("car", "car", line([0.3, 0, z0], [0, 0, v]))), ...worldSpecs(wall(material))];
    return { specs, r: simulate(specs, F, { fps: FPS }) };
  };
  // Solid (concrete) at 12 m/s: the nose never gets past the wall's face, the car is stopped, crush ~ v sqrt(m / k).
  let { r } = run("concrete", 12, -12);
  const nose = Math.max(...r.tracks.car.map((p) => p.pos[2] + 2.25));
  assert.ok(nose < 0.05, `nose reached ${nose.toFixed(3)}`);
  assert.ok(Math.abs(vz(r.tracks.car, 96)) < 0.05, "stopped");
  const crush = r.crush.car[0].depth, expect = 12 * Math.sqrt(1450 / 1e6);
  assert.ok(Math.abs(crush - expect) / expect < 0.15, `crush ${crush} m vs ${expect.toFixed(3)} m`);
  // Weak (a timber wall in blocks) at 12 m/s: blocks come loose, the car goes through, slower than it came.
  ({ r } = run("wood", 12, -12));
  const loose = Object.keys(r.takeovers).filter((k) => k.startsWith("wall~")).length;
  assert.ok(loose >= 6, `${loose} blocks knocked out`);
  const C = r.tracks.car, thru = C.findIndex((p) => p.pos[2] - 2.25 > 0.2);
  assert.ok(thru > 0, "the car's tail clears the wall");
  const vOut = vz(C, thru);
  assert.ok(vOut > 3 && vOut < 11.5, `out at ${vOut.toFixed(2)} m/s`);
  // ... and at walking pace (1.2 m/s, under its ~1.7 m/s strength) the same wall holds and the car stops at it.
  ({ r } = run("wood", 1.2, -4));
  assert.equal(Object.keys(r.takeovers).filter((k) => k.startsWith("wall~")).length, 0, "no block moves");
  assert.ok(Math.max(...r.tracks.car.map((p) => p.pos[2] + 2.25)) < 0.05, "stopped at the wall");
  assert.ok(WALL_BLOCK.force / Math.sqrt((1 / (1 / 1e6 + 1 / 5e6)) * 1450) > 1.2, "the strength is above 1.2 m/s by design");
});

test("flip threshold: sliding sideways into a kerb, a car trips over above the critical sliding velocity and not below", () => {
  const hk = 0.15, mp = vehicleMass(CAR.half, CAR.center, 1450), h = mp.com[1] - hk, edge = CAR.half[0] - 0.02;
  // Angular momentum about the kerb edge is kept through the trip; it rolls over if that spin lifts the centre of mass
  // over the edge: v_c = sqrt(2 g (d - h) I_edge / (m h^2)).
  const d = Math.hypot(edge, h), I = mp.inertia[2][2] + d * d, vc = Math.sqrt(2 * G * (d - h) * I / (h * h));
  assert.ok(vc > 7 && vc < 12, `v_c ${vc.toFixed(2)} m/s`);
  const roll = (v) => {
    const poses = Array.from({ length: 72 }, (_, f) => ({ pos: [-0.5 + v * f / FPS, 0, 0], quat: [0, 0, 0, 1] }));
    const r = simulate([...worldSpecs(car("car", "car", poses)),
      { id: "kerb", shape: "box", half: [0.15, hk / 2, 5], center: [0, 0, 0], dynamic: false, friction: 0.9, poses: [{ pos: [1.65, hk / 2, 0], quat: [0, 0, 0, 1] }] }], 72, { fps: FPS });
    return { minUp: Math.min(...r.tracks.car.map(up)), endUp: up(r.tracks.car.at(-1)) };
  };
  const slow = roll(0.8 * vc), fast = roll(1.5 * vc);
  assert.ok(slow.minUp > 0.85 && slow.endUp > 0.99, `0.8 v_c: tips ${slow.minUp.toFixed(2)} and settles back on its wheels`);
  assert.ok(fast.minUp < 0, `1.5 v_c: rolls past its side (${fast.minUp.toFixed(2)})`);
  // On flat ground a hard T-bone shoves a car sideways but its tyres can't roll it (grip 0.85 g < its stability factor ~1.4).
  const r = simulate([...worldSpecs(car("police", "police_car", line([0, 0, -20], [0, 0, 25]))),
    ...worldSpecs(car("red", "car", line([0, 0, 0], [0, 0, 0], { yaw: Math.PI / 2 })))], F, { fps: FPS });
  assert.ok(Math.min(...r.tracks.red.map(up)) > 0.9, "no rollover on flat ground");
  assert.ok(r.tracks.red.at(-1).pos[2] > 3, "but it is shoved well clear");
});

test("a person in the way is knocked over; the car keeps its keys (a 65 kg person barely slows 1.5 t)", () => {
  const person = { id: "mara", kind: "woman", half: [0.3, 0.85, 0.2], center: [0, 0.85, 0], poses: [{ pos: [0, 0, 0], quat: [0, 0, 0, 1] }] };
  const specs = [...worldSpecs(car("car", "car", line([0, 0, -12], [0, 0, 9]))), ...worldSpecs(person)];
  const r = simulate(specs, F, { fps: FPS });
  assert.ok(r.takeovers.mara, "the physics took over the person");
  assert.equal(r.takeovers.car, undefined, "the car stays on its keys");
  assert.ok(Math.min(...r.tracks.mara.map(up)) < 0.5, "she falls");
  assert.deepEqual(interpenetrations(itemsOf(specs, r), F, { tol: 0.05 }), []);
});

test("the bake is deterministic, and scrubbing back and forth plays exactly the same frames", () => {
  const bodies = [car("police", "police_car", line([0, 0, -25], [0.1, 0, 18])), car("red", "car", line([0.4, 0, 0], [0, 0, 0], { yaw: 0.7 }))];
  const specs = bodies.flatMap((b) => worldSpecs(b));
  const a = simulate(specs, F, { fps: FPS }), b = simulate(specs, F, { fps: FPS });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "bit-identical bakes");
  const keys = bakeTrack(a.tracks.red);
  const fwd = Array.from({ length: F }, (_, f) => sampleBaked(keys, f));
  const back = Array.from({ length: F }, (_, i) => sampleBaked(keys, F - 1 - i)).reverse();
  assert.deepEqual(back, fwd, "scrub back = scrub forward");
  fwd.forEach((p, f) => assert.ok(Math.hypot(...p.pos.map((v, k) => v - a.tracks.red[f].pos[k])) < 2e-3, `f${f} plays the bake`));
  const again = sampleBaked(keys, 60), mid = sampleBaked(keys, 10);
  assert.deepEqual(sampleBaked(keys, 60), again);
  assert.notDeepEqual(mid, again);
});

test("keepKeyed keeps a car on its keys: it passes through, and the consequence check says so in plain words with fixes", () => {
  const bodies = [car("police", "police_car", line([0, 0, -20], [0, 0, 15]), { keepKeyed: true }), car("red", "car", line([0, 0, 0], [0, 0, 0]), { keepKeyed: true })];
  const specs = bodies.flatMap((b) => worldSpecs(b));
  const r = simulate(specs, F, { fps: FPS });
  assert.deepEqual(r.takeovers, {});
  const ov = interpenetrations(bodies, F);
  assert.equal(ov.length, 1);
  const who = { police: { name: "Police car", kind: "police_car", moving: true }, red: { name: "Red car", kind: "car" } };
  const [c] = consequences(ov, who, { fps: FPS });
  assert.match(c.text, /^The police car passes through the red car at \d\.\d s: crash them, or reroute\?$/);
  assert.deepEqual(c.fixes.map((x) => x.command), ["crash the police car into the red car", "reroute the police car around the red car"]);
  const pw = consequences([{ a: "mara", b: "police", frame: 30, depth: 0.5 }], { ...who, mara: { name: "Mara", kind: "woman" } }, { fps: FPS })[0];
  assert.equal(pw.text, "The police car drives through Mara at 1.3 s: knock Mara down, or reroute?");
});

test("reroute: the mover swerves clear of what it would pass through", () => {
  const keys = [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, 20] }];
  const off = clearOffset([0, 0, 0], [0, 0, 1], CAR.half, [0.3, 0, 0], CAR.half);
  const nk = rerouteKeys(keys, 48, off);
  const poses = Array.from({ length: F }, (_, f) => {
    const i = nk.findIndex((k) => k.frame >= f), k1 = nk[Math.max(1, i)], k0 = nk[Math.max(0, i - 1)], u = (f - k0.frame) / Math.max(1, k1.frame - k0.frame);
    return { pos: k0.position.map((v, j) => v + (k1.position[j] - v) * Math.max(0, Math.min(1, u))), quat: [0, 0, 0, 1] };
  });
  const ov = interpenetrations([{ id: "a", ...CAR, poses }, { id: "b", ...CAR, poses: [{ pos: [0.3, 0, 0], quat: [0, 0, 0, 1] }] }], F);
  assert.deepEqual(ov, [], "the swerve clears the parked car");
  assert.ok(Math.abs(off[0]) > 1.8, `swerves ${off[0].toFixed(2)} m`);
});

test("the Director's ram: speed planned by momentum shoves the red car into the crates, and the bake does it", () => {
  const plan = planRam({ pos: [0, 0, -25], mass: 1900, half: CAR.half, heading: 0 }, { pos: [0, 0, 0], mass: 1450, half: CAR.half, heading: 0 }, [0, 0, 9], { frames: F, fps: FPS });
  assert.ok(plan.speed >= 8 && plan.speed < 30, `${plan.speed} m/s`);
  assert.ok(plan.push > 6, `expected push ${plan.push} m`);
  const lerp = (f) => plan.keys[0].position.map((v, k) => v + (plan.keys[1].position[k] - v) * f / (F - 1));
  const rammer = car("police", "police_car", Array.from({ length: F }, (_, f) => ({ pos: lerp(f), quat: [0, 0, 0, 1] })));
  const crate = (id, x) => restingSpec({ id, shape: "box", half: [0.4, 0.4, 0.4], center: [0, 0.4, 0], dynamic: true, mass: 25, bounce: 0.2, friction: 0.6, poses: [{ pos: [x, 0, 9], quat: [0, 0, 0, 1] }] });
  const specs = [...worldSpecs(rammer), ...worldSpecs(car("red", "car", line([0, 0, 0], [0, 0, 0]))), crate("c1", -0.5), crate("c2", 0.5)];
  const r = simulate(specs, F, { fps: FPS });
  assert.ok(Math.abs(r.takeovers.red.frame - plan.hitFrame) <= 2, `hit at f${r.takeovers.red.frame}, planned f${plan.hitFrame}`);
  assert.ok(r.takeovers.c1 || r.takeovers.c2, "the red car reaches the crates");
  assert.match(plan.words, /hits at \d\.\d s doing \d+ km\/h; by momentum \(1900 kg into 1450 kg\) that shoves it about \d+ m/);
  assert.match(takeoverWords(r.takeovers, { police: { name: "Police car" }, red: { name: "Red car" } })[0], /physics took over at f \d+/);
});

test("fluid editing: an edit on a baked object goes into its authored keys; the re-bake is debounced; bake and unbake are exact", () => {
  // A crate (one authored key) dragged 1 m at frame 30 of its bake: its rest position moves 1 m.
  const baked = [{ frame: 0, position: [0, 0, 0] }, { frame: 30, position: [2, 0, 0] }, { frame: 96, position: [2, 0, 0] }];
  assert.deepEqual(mergeEdits([{ frame: 0, position: [0, 0, 0] }], baked, [baked[0], { frame: 30, position: [3, 0, 0.5] }, baked[2]]), [{ frame: 0, position: [1, 0, 0.5] }]);
  // A keyed car's key edited: upserted into its authored keys (the physics part of the bake is never kept as keys).
  const src = [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, 20] }];
  const bk = Array.from({ length: 97 }, (_, f) => ({ frame: f, position: [0, 0, -20 + 40 * f / 96], quat: [0, 0, 0, 1] }));
  const cur = bk.map((k) => (k.frame === 20 ? { ...k, position: [1.5, 0, k.position[2]] } : k));
  assert.deepEqual(mergeEdits(src, bk, cur).map((k) => k.frame), [0, 20, 96]);
  assert.equal(mergeEdits(src, bk, bk), null, "no edit, nothing merged");
  // The re-bake waits for the edits to stop.
  let runs = 0, now = 0;
  const timers = [];
  const rb = rebaker(() => runs++, { delay: 450, setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; }, clearTimer: (id) => { timers[id - 1].fn = null; } });
  const tick = (ms) => { now += ms; for (const t of timers) if (t.fn && t.at <= now) { const fn = t.fn; t.fn = null; fn(); } };
  rb.poke(); tick(200); rb.poke(); tick(200); rb.poke(); tick(300);
  assert.equal(runs, 0, "still editing");
  tick(200);
  assert.equal(runs, 1, "one re-bake after the edits stop");
  // bakeActor / unbakeActor round trip, and the bake's own results never change the input signature.
  const actors = [{ id: "red", kind: "car", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 90 }, { id: "lamp", kind: "lamp", position: [3, 0, 1] }];
  const orig = JSON.parse(JSON.stringify(actors)), sig0 = inputSig(actors);
  bakeActor(actors[0], bakeTrack(Array.from({ length: 5 }, (_, f) => ({ pos: [0, 0, f], quat: [0, 0, 0, 1] }))), { takeover: { frame: 2, by: "police" }, dents: [{ frame: 2, p: [0, 0, 1], n: [0, 0, -1], depth: 0.2, radius: 0.6, with: "x" }] });
  bakeActor(actors[1], bakeTrack([{ pos: [3, 0, 1], quat: [0, 0, 0, 1] }, { pos: [3, 0.5, 2], quat: [0.3, 0, 0, 0.95] }]), { takeover: { frame: 1, by: "red" } });
  const sig1 = inputSig(actors);
  assert.equal(inputSig(actors), sig1);
  assert.equal(actors[0].physics.takeover.frame, 2);
  assert.ok(unbakeActor(actors[0]) && unbakeActor(actors[1]));
  assert.deepEqual(actors, orig, "exactly the scene from before the bake");
  assert.equal(inputSig(actors), sig0);
  bakeActor(actors[0], bakeTrack(Array.from({ length: 5 }, (_, f) => ({ pos: [0, 0, f], quat: [0, 0, 0, 1] }))), {});
  const s2 = inputSig(actors);
  actors[0].keys[1] = { ...actors[0].keys[1], position: [5, 0, 1] };
  assert.notEqual(inputSig(actors), s2, "an edit on a baked object changes the signature (re-bake)");
});
