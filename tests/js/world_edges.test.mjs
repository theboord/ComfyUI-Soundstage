// World collisions, the edges: stacked impacts and chain reactions, many cars at once, people against cars, things
// placed inside each other, re-baking after edits, determinism, and degenerate input (no world, zero-length paths,
// one-frame shots). Pure solver tests on physics.mjs simulate() + world.mjs, then the headless Stage and the Director.
// Not covered here: what world.test.mjs and world_stage.test.mjs already check (one rear-end, the chase, the lamp,
// walls, the kerb trip, the planned ram, Keep keyed, one Undo).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { simulate, qrot } from "../../web/stage/physics.mjs";
import { worldSpecs, interpenetrations, consequences, planRam, rerouteKeys, takeoverWords, WORLD_KINDS } from "../../web/stage/world.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";

const FPS = 24, F = 97;
const CAR = { half: [0.9, 0.725, 2.25], center: [0, 0.725, 0] };
const PERSON = { half: [0.3, 0.9, 0.2], center: [0, 0.9, 0] };
const qy = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const line = (p0, v, { yaw = 0, n = F } = {}) => Array.from({ length: n }, (_, f) => ({ pos: [p0[0] + v[0] * f / FPS, 0, p0[2] + v[2] * f / FPS], quat: qy(yaw) }));
const parked = (p, yaw = 0) => line(p, [0, 0, 0], { yaw });
const car = (id, kind, poses, physics) => ({ id, kind, ...CAR, poses, physics });
const person = (id, kind, poses, physics) => ({ id, kind, ...PERSON, poses, physics });
const coast = { afterContact: "coast" };
const bake = (bodies) => { const specs = bodies.flatMap((b) => worldSpecs(b)); return { specs, r: simulate(specs, F, { fps: FPS }) }; };
/** Speed (m/s) of a track between frames f-1 and f+1, and along z. */
const speed = (tr, f) => Math.hypot(...tr[f + 1].pos.map((v, k) => v - tr[f - 1].pos[k])) * FPS / 2;
const vz = (tr, f) => (tr[f + 1].pos[2] - tr[f - 1].pos[2]) * FPS / 2;
const fastest = (tr, from = 1) => Math.max(...tr.slice(from).map((p, i) => Math.hypot(...p.pos.map((v, k) => v - tr[from + i - 1].pos[k])) * FPS));
const itemsOf = (specs, res) => specs.filter((s) => !s.wallOf).map((s) => ({ id: s.id, kind: s.kind, half: s.half, center: s.center, poses: res?.tracks[s.id] || s.poses }));
const finite = (tr) => tr.every((p) => [...p.pos, ...p.quat].every(Number.isFinite));

// ---------------------------------------------------------------- stacked impacts and chain reactions
test("chain reaction: a police car shunts a parked car into another; each is taken over by the one that hit it, in order, momentum carried", () => {
  const { specs, r } = bake([car("police", "police_car", line([0, 0, -20], [0, 0, 15]), coast), car("a", "car", parked([0, 0, 0]), coast), car("b", "car", parked([0, 0, 5.5]), coast)]);
  const t = r.takeovers;
  assert.equal(t.a.by, "police");
  assert.equal(t.b.by, "a", "the second car is hit by the first, not by the police car");
  assert.ok(t.b.frame > t.a.frame, `b after a: f${t.a.frame} then f${t.b.frame}`);
  // Along the road: 1900 kg x 15 m/s before; after both hits (coasting: 0.02 g) all of it is still there.
  const p0 = 1900 * 15, f = t.b.frame + 4;
  const p1 = 1900 * vz(r.tracks.police, f) + 1450 * vz(r.tracks.a, f) + 1450 * vz(r.tracks.b, f);
  assert.ok(Math.abs(p1 - p0) / p0 < 0.03, `momentum ${p0} -> ${p1.toFixed(0)}`);
  assert.ok(vz(r.tracks.b, f) > 3, `the far car is moving: ${vz(r.tracks.b, f).toFixed(2)} m/s`);
  assert.deepEqual(interpenetrations(itemsOf(specs, r), F, { tol: 0.05 }), []);
});

test("a queue of parked cars bumper to bumper is shunted like one with gaps (it used to be a wall: nothing in front ever moved)", () => {
  // A car shunted into a held (keyed, parked) car it already touches was stopped dead by it in the same substep, before
  // its hold was checked; with 2 cm or more between them it worked. Now the gap doesn't matter.
  const run = (gap) => {
    const { specs, r } = bake([car("c", "car", line([0, 0, -20], [0, 0, 15])), car("a", "car", parked([0, 0, 0])), car("b", "car", parked([0, 0, 4.5 + gap]))]);
    return { r, end: (id) => r.tracks[id].at(-1).pos[2], specs };
  };
  const ref = run(0.1);
  assert.ok(ref.r.takeovers.b && ref.end("b") - 4.6 > 1.5, "with a 10 cm gap the front car is shoved");
  for (const gap of [0, 0.005, -0.01]) {
    const q = run(gap);
    assert.equal(q.r.takeovers.b?.by, "a", `gap ${gap}: the front car is taken over by the one shunted into it`);
    assert.ok(q.end("b") - (4.5 + gap) > 1.5, `gap ${gap}: the front car moves ${(q.end("b") - 4.5 - gap).toFixed(2)} m`);
    assert.ok(q.end("a") > 1, `gap ${gap}: the middle car moves forward (${q.end("a").toFixed(2)} m), not stopped dead`);
    assert.ok(Math.abs(q.end("b") - ref.end("b")) < 1.5, `gap ${gap}: about where the 10 cm gap puts it (${q.end("b").toFixed(2)} vs ${ref.end("b").toFixed(2)})`);
  }
});

test("one parked car hit twice, from behind and then head-on: both hits are felt, the second car is taken over by it", () => {
  const { specs, r } = bake([car("l", "car", line([0, 0, -30], [0, 0, 15]), coast), car("p", "car", parked([0, 0, 0]), coast), car("r", "car", line([0, 0, 40], [0, 0, -12]), coast)]);
  const t = r.takeovers;
  assert.equal(t.p.by, "l");
  assert.equal(t.r.by, "p", "the oncoming car hits the shunted one");
  assert.ok(t.r.frame > t.p.frame + 5);
  const before2 = vz(r.tracks.p, t.r.frame - 2), after2 = vz(r.tracks.p, t.r.frame + 4);
  assert.ok(vz(r.tracks.p, t.p.frame + 4) > 3, "the first hit sends it forward");
  assert.ok(before2 - after2 > 3, `the second hit stops or reverses it: ${before2.toFixed(2)} -> ${after2.toFixed(2)} m/s`);
  for (const id of ["l", "p", "r"]) assert.ok(finite(r.tracks[id]) && fastest(r.tracks[id]) < 15.5, `${id}: no explosion (${fastest(r.tracks[id]).toFixed(1)} m/s)`);
  assert.deepEqual(interpenetrations(itemsOf(specs, r), F, { tol: 0.05 }), []);
});

// ---------------------------------------------------------------- people against cars
test("people: one person barely slows a car (it keeps its keys); two add up and the car is taken over at the second; three children don't", () => {
  const go = (...people) => bake([car("c", "car", line([0, 0, -20], [0, 0, 15]), coast), ...people]).r;
  const one = go(person("m1", "man", parked([0, 0, 0])));
  assert.ok(one.takeovers.m1 && !one.takeovers.c, "80 kg at 15 m/s: 0.78 m/s for the car, under the 1 m/s takeover");
  const two = go(person("m1", "man", parked([0, 0, 0])), person("m2", "man", parked([0, 0, 6])));
  assert.ok(two.takeovers.m1 && two.takeovers.m2, "both are knocked over");
  assert.equal(two.takeovers.c?.by, "m2", "the second person's hit tips the sum over 1 m/s");
  assert.ok(vz(two.tracks.c, two.takeovers.c.frame + 3) < 14.2, `and the car pays for both: ${vz(two.tracks.c, two.takeovers.c.frame + 3).toFixed(2)} m/s`);
  const kids = go(person("k1", "child", parked([0, 0, 0])), person("k2", "child", parked([0, 0, 4])), person("k3", "child", parked([0, 0, 8])));
  assert.equal(kids.takeovers.c, undefined, "3 x 30 kg: 0.9 m/s in all, the car keeps its keys");
  for (const k of ["k1", "k2", "k3"]) assert.ok(kids.takeovers[k], `${k} knocked`);
  for (const r of [one, two, kids]) for (const [id, tr] of Object.entries(r.tracks)) assert.ok(finite(tr) && fastest(tr) < 25, `${id}: ${fastest(tr).toFixed(1)} m/s`);
});

test("a person walking into a parked car's side is stopped by it, the car doesn't move, and neither passes through the other", () => {
  const { specs, r } = bake([car("p", "car", parked([0, 0, 0], Math.PI / 2)), person("m", "man", line([0, 0, -4], [0, 0, 1.4]))]);
  assert.ok(r.takeovers.m, "she is taken over at the car");
  assert.equal(r.takeovers.p, undefined, "a walking person doesn't shove a parked car (1.4 m/s x 80 / 1530 kg)");
  assert.ok(r.tracks.m.at(-1).pos[2] < -0.9, `stopped at the car's side (z ${r.tracks.m.at(-1).pos[2].toFixed(2)})`);
  assert.deepEqual(interpenetrations(itemsOf(specs, r), F, { tol: 0.05 }), []);
});

// ---------------------------------------------------------------- many cars at once
const crossing = () => {
  const out = [];
  for (let i = 0; i < 3; i++) out.push(car(`ns${i}`, "car", line([i * 3 - 3, 0, -25 - i * 4], [0, 0, 14])));
  for (let i = 0; i < 3; i++) out.push(car(`ew${i}`, "hatchback", line([-25 - i * 4, 0, i * 3 - 3], [14, 0, 0], { yaw: Math.PI / 2 })));
  return out;
};

test("six keyed cars crossing at once: every car is taken over, nothing explodes or sinks, nothing passes through anything", () => {
  const { specs, r } = bake(crossing());
  assert.equal(Object.keys(r.takeovers).length, 6, JSON.stringify(Object.keys(r.takeovers)));
  for (const [id, tr] of Object.entries(r.tracks)) {
    assert.ok(finite(tr), id);
    assert.ok(fastest(tr) < 14 * 1.25, `${id}: fastest ${fastest(tr).toFixed(1)} m/s (keys: 14)`);
    assert.ok(Math.min(...tr.map((p) => p.pos[1])) > -0.1, `${id} stays on the road`);
  }
  assert.deepEqual(interpenetrations(itemsOf(specs, r), F, { tol: 0.05 }), []);
});

test("determinism: a big mixed scene bakes bit-identical twice, from a copy of its specs, and simulate() leaves its input alone", () => {
  const bodies = [...crossing(), person("m", "man", line([6, 0, 1], [-1.5, 0, 0])), person("w", "woman", parked([0.5, 0, 8])),
    { id: "lamp", kind: "lamp", half: [0.2, 3, 0.2], center: [0, 3, 0], poses: parked([4, 0, 4]) },
    { id: "fence", kind: "wall", half: [2, 0.6, 0.1], center: [0, 0.6, 0], poses: parked([0, 0, 14]), physics: { material: "wood" } }];
  const specs = bodies.flatMap((b) => worldSpecs(b)), frozen = JSON.stringify(specs);
  const a = JSON.stringify(simulate(specs, F, { fps: FPS }));
  assert.equal(JSON.stringify(specs), frozen, "the specs are not mutated by a bake");
  assert.equal(JSON.stringify(simulate(JSON.parse(frozen), F, { fps: FPS })), a, "a copy bakes the same");
  assert.equal(JSON.stringify(simulate(specs, F, { fps: FPS })), a, "and again");
});

// ---------------------------------------------------------------- things placed inside each other (set dressing)
test("things that start inside each other stay put, and a hit doesn't turn the overlap into speed (cars used to fly back faster than they came)", () => {
  const wall = (z) => ({ id: "w", kind: "wall", half: [3, 1.5, 0.15], center: [0, 1.5, 0], poses: parked([0, 0, z]) });
  // Alone: a car parked 30 cm into a concrete wall and a man standing in a bumper don't move at all.
  const still = bake([car("a", "car", parked([0, 0, 0])), wall(2.1), car("b", "car", parked([5, 0, 0])), person("m", "man", parked([5, 0, 2.25]))]).r;
  assert.deepEqual(still.takeovers, {});
  for (const id of ["a", "b", "m"]) assert.ok(still.tracks[id].every((p) => Math.hypot(...p.pos.map((v, k) => v - still.tracks[id][0].pos[k])) < 1e-9), `${id} stays exactly where it was put`);
  // Hit from behind: the overlap is not a spring. Nothing leaves faster than the hit came in, the hitter isn't thrown
  // back, and the car against the wall doesn't go through it (against a wall it touches, the hitter bounces off).
  const cases = {
    "car in a wall": [wall(2.1)],
    "car in a parked car": [car("b", "car", parked([0, 0, 4.3]))],
    "man in a bumper": [person("m", "man", parked([0, 0, 2.25]))],
    "lamp in a bonnet": [{ id: "l", kind: "lamp", half: [0.2, 3, 0.2], center: [0, 3, 0], poses: parked([0, 0, 2.1]) }],
  };
  for (const v of [15, 25]) for (const [name, extra] of Object.entries(cases)) {
    const { r } = bake([car("c", "car", line([0, 0, -20], [0, 0, v])), car("a", "car", parked([0, 0, 0])), ...extra]);
    const hit = r.takeovers.a?.frame;
    assert.ok(hit != null, `${name} at ${v}: the hit happens`);
    for (const [id, tr] of Object.entries(r.tracks)) {
      assert.ok(finite(tr), `${name}: ${id}`);
      assert.ok(fastest(tr, hit + 1) < 1.2 * v, `${name} at ${v} m/s: ${id} reaches ${fastest(tr, hit + 1).toFixed(1)} m/s`);
    }
    const back = Math.min(...r.tracks.c.slice(hit + 1, -1).map((_, i) => vz(r.tracks.c, hit + 1 + i)));
    assert.ok(back > -4, `${name} at ${v} m/s: the hitter is thrown back at ${(-back).toFixed(1)} m/s`);
    if (name === "car in a wall") assert.ok(r.tracks.a.at(-1).pos[2] + 2.25 < 2.1 + 0.15 + 0.05, `${name} at ${v}: through a solid wall`);
    else assert.ok(Object.keys(r.takeovers).length === 3, `${name} at ${v}: what it overlapped is knocked too (${Object.keys(r.takeovers)})`);
  }
});

// ---------------------------------------------------------------- degenerate input
test("degenerate input: an empty world, a one-frame shot, a car keyed to stand still, unknown kinds", () => {
  const empty = simulate([], F, { fps: FPS });
  assert.deepEqual([empty.tracks, empty.takeovers, empty.events], [{}, {}, []]);
  assert.deepEqual(interpenetrations([], F), []);
  assert.deepEqual(consequences([], {}), []);
  assert.deepEqual(takeoverWords({}), []);
  assert.deepEqual(worldSpecs({ id: "x", kind: "spaceship", half: [1, 1, 1], center: [0, 1, 0], poses: parked([0, 0, 0]) }), []);
  assert.equal(WORLD_KINDS.spaceship, undefined);
  // One frame: everything where it was put.
  const one = simulate([car("c", "car", line([0, 0, -20], [0, 0, 15], { n: 1 })), car("p", "car", parked([0, 0, 0]))].flatMap((b) => worldSpecs(b)), 1, { fps: FPS });
  assert.equal(one.tracks.c.length, 1);
  assert.deepEqual(one.tracks.c[0].pos, [0, 0, -20]);
  // A car "keyed" with every key at one spot (a zero-length path) is a parked car: the same bake as one pose.
  const hit = (poses) => simulate([car("c", "car", line([0, 0, -20], [0, 0, 15])), car("p", "car", poses)].flatMap((b) => worldSpecs(b)), F, { fps: FPS });
  assert.equal(JSON.stringify(hit(parked([0, 0, 0]))), JSON.stringify(hit([{ pos: [0, 0, 0], quat: [0, 0, 0, 1] }])));
  // Nothing moving anywhere: nothing to report, nothing taken over.
  const idle = [car("a", "car", parked([0, 0, 0])), car("b", "car", parked([0, 0, 3]))];
  assert.deepEqual(interpenetrations(idle, F), [], "two parked cars overlapping are the set dresser's business");
  assert.deepEqual(simulate(idle.flatMap((b) => worldSpecs(b)), F, { fps: FPS }).takeovers, {});
});

test("planRam in a short shot keeps the hit inside the shot (a 12-frame shot planned the hit for frame 15)", () => {
  const rammer = { pos: [0, 0, -12], mass: 1900, half: CAR.half, heading: 0 }, victim = { pos: [0, 0, 0], mass: 1450, half: CAR.half, heading: 0 };
  for (const frames of [12, 20, 97]) {
    const p = planRam(rammer, victim, null, { frames, fps: FPS });
    assert.ok(p.hitFrame >= 1 && p.hitFrame <= frames - 1, `${frames} frames: hit at f${p.hitFrame}`);
    // On the keys (straight, constant speed) the rammer's nose meets the victim's tail at hitFrame.
    const at = (f) => p.keys[0].position[2] + (p.keys[1].position[2] - p.keys[0].position[2]) * f / (frames - 1);
    assert.ok(Math.abs(at(p.hitFrame) + CAR.half[2] - (victim.pos[2] - CAR.half[2])) < 0.05, `${frames} frames: contact at f${p.hitFrame}`);
  }
  assert.equal(planRam(rammer, victim, null, { frames: 97, fps: FPS }).hitFrame, 38, "the usual shot is unchanged");
  // Rammer, victim and target on one spot: still finite keys along the rammer's heading.
  const same = planRam({ ...rammer, pos: [0, 0, 0], heading: Math.PI / 2 }, victim, [0, 0, 0], { frames: 97, fps: FPS });
  assert.ok(same.keys.every((k) => k.position.every(Number.isFinite)) && Math.abs(same.dir[0] - 1) < 1e-9);
  // Rerouting a zero-length path stays finite and adds the swerve.
  const nk = rerouteKeys([{ frame: 0, position: [0, 0, 0] }, { frame: 96, position: [0, 0, 0] }], 48, [2, 0]);
  assert.deepEqual(nk.map((k) => k.frame), [0, 48, 96]);
  assert.deepEqual(nk[1].position, [2, 0, 0]);
});

test("the check's words: groups of things are plural English, and a takeover by a car's body or a wall's block names the car or the wall", () => {
  const who = { police: { name: "Police car", kind: "police_car", moving: true } };
  const ov = [];
  for (const [kind, n] of [["bus", 3], ["glass", 2], ["plane_seats", 4], ["crate", 2]]) for (let i = 0; i < n; i++) {
    who[`${kind}${i}`] = { name: kind, kind };
    ov.push({ a: "police", b: `${kind}${i}`, frame: 10 + i, depth: 0.3 });
  }
  const text = consequences(ov, who, { fps: FPS }).map((c) => c.text).join(" | ");
  for (const w of ["3 buses", "2 glasses", "4 plane seats", "2 crates"]) assert.match(text, new RegExp(`passes through ${w} at`), text);
  const words = takeoverWords({ red: { frame: 30, by: "police#body", speed: 10 }, fence: { frame: 31, by: "red", speed: 8, reason: "broke" }, w2: { frame: 32, by: "fence~b0.1", speed: 5 } },
    { red: { name: "Red car" }, police: { name: "Police car" }, fence: { name: "Fence" }, w2: { name: "Wall" } });
  assert.match(words[0], /^red car: physics took over at f 30 .* hit the police car at 36 km\/h$/);
  assert.match(words[2], /hit the fence at/);
});

// ---------------------------------------------------------------- the Stage: reversible and deterministic
globalThis.window ||= {};
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("car model failed")) _warn(...a); };   // no model files headless: the built cars

function headless(actors, env = { set: "studio" }) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: env }, view: "clay", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onInteract() {}, onSelect() {}, onShots() {}, _buildLights() {}, _applySun() {},
  });
  st.onChange = () => { if (!st._muteRecord) { st._record(); st._worldPoke(); } };
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.live = new LiveEdit(st, liveKinds());
  st.setFrame(0);
  st.resetHistory();
  st.load = function (scene) { this.state = structuredClone(scene); this._buildSet(); this._setGroup = undefined; };
  st.select = () => {};
  return st;
}
const scar = (id, name, kind, keys, extra = {}) => ({ id, name, kind, position: keys[0].position, keys, rotation_deg: 0, ...extra });
const chase = ({ redZ = 0, end = 20 } = {}) => [
  scar("police", "Police car", "police_car", [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, end] }]),
  scar("red", "Red car", "sports_car", [{ frame: 0, position: [0.3, 0, redZ] }], { rotation_deg: 90 }),
];
const baked = (st) => JSON.stringify({ keys: st.state.actors.map((a) => [a.id, a.keys, a.physics?.takeover || null, a.physics?.dents || null]), takeovers: st.state.physics?.takeovers || null });
const fresh = (actors) => { const st = headless(actors); assert.ok(st.simulatePhysics().ok); return baked(st); };

test("stage: re-baking after an edit gives exactly the fresh bake of the edited scene (move the parked car, move the end key, remove the car)", () => {
  // Move the parked car 6 m down the road (every key of a baked actor shifted: a drag).
  let st = headless(chase());
  st.simulatePhysics();
  const red = st.state.actors.find((a) => a.id === "red");
  red.keys = red.keys.map((k) => ({ ...k, position: [k.position[0], k.position[1], k.position[2] + 6] }));
  st.simulatePhysics();
  assert.equal(baked(st), fresh(chase({ redZ: 6 })), "moved parked car");
  // Move the police car's last key 10 m further (an edit on the baked car's keys goes into its authored keys).
  st = headless(chase());
  st.simulatePhysics();
  const pol = st.state.actors.find((a) => a.id === "police");
  pol.keys = [...pol.keys.filter((k) => k.frame !== 96), { frame: 96, position: [0, 0, 30] }];
  st.simulatePhysics();
  assert.deepEqual(st.state.actors.find((a) => a.id === "police").physics.source.keys, [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, 30] }]);
  assert.equal(baked(st), fresh(chase({ end: 30 })), "moved end key");
  // Remove the parked car: the police car is back on exactly its authored keys, nothing taken over.
  st = headless(chase());
  st.simulatePhysics();
  st.state.actors = st.state.actors.filter((a) => a.id !== "red");
  const r = st.simulatePhysics();
  assert.ok(r.ok, r.message);
  assert.deepEqual(st.state.actors[0].keys, chase()[0].keys);
  assert.ok(!st.state.actors[0].physics?.baked && !st.state.physics.takeovers, "nothing baked, no takeovers left");
});

test("stage: bake, re-bake, Clear and bake again, and Undo then Redo of an edit's re-bake all give the same frames", async () => {
  const st = headless(chase());
  st.simulatePhysics();
  const first = baked(st);
  st.simulatePhysics();
  assert.equal(baked(st), first, "re-baking an unchanged scene changes nothing");
  st.clearPhysics();
  st.simulatePhysics();
  assert.equal(baked(st), first, "Clear simulation then bake: the same crash");
  // An edit and its automatic re-bake, undone: the first bake exactly; the re-bake of the same edit again: the same.
  const red = st.state.actors.find((a) => a.id === "red");
  red.keys = red.keys.map((k) => ({ ...k, position: [k.position[0] + 0.8, k.position[1], k.position[2]] }));
  st.onChange(st.toJSON());
  await new Promise((r) => setTimeout(r, 700));
  const edited = baked(st);
  assert.notEqual(edited, first);
  assert.ok(st.undo());
  assert.equal(baked(st), first, "Undo: the bake from before the edit");
  const red2 = st.state.actors.find((a) => a.id === "red");
  red2.keys = red2.keys.map((k) => ({ ...k, position: [k.position[0] + 0.8, k.position[1], k.position[2]] }));
  st.simulatePhysics();
  assert.equal(baked(st), edited, "the same edit re-bakes to the same frames");
});

test("stage: six cars and a person at a crossing bake clean: all taken over, the check is clear after, and the same bake twice", () => {
  const cars = [];
  for (let i = 0; i < 3; i++) cars.push(scar(`ns${i}`, `North car ${i + 1}`, "car", [{ frame: 0, position: [i * 3 - 3, 0, -30 - i * 5] }, { frame: 96, position: [i * 3 - 3, 0, 30 - i * 5] }]));
  for (let i = 0; i < 3; i++) cars.push(scar(`ew${i}`, `East car ${i + 1}`, "hatchback", [{ frame: 0, position: [-30 - i * 5, 0, i * 3 - 3] }, { frame: 96, position: [30 - i * 5, 0, i * 3 - 3] }], { rotation_deg: 90 }));
  cars.push({ id: "mara", name: "Mara", kind: "woman", height_m: 1.68, rotation_deg: 0, position: [8, 0, 1], keys: [{ frame: 0, position: [8, 0, 1] }, { frame: 96, position: [-8, 0, 1] }] });
  const st = headless(cars);
  assert.ok(st.consequenceCheck().length >= 3, "before the bake they pass through each other");
  const r = st.simulatePhysics();
  assert.ok(r.ok, r.message);
  for (const a of st.state.actors) assert.ok(r.takeovers[a.id], `${a.id} taken over`);
  assert.deepEqual(st.consequenceCheck().map((i) => i.text), [], "after it nothing passes through anything");
  assert.equal(fresh(cars), baked(st), "deterministic");
});

test("stage: a parked car placed into another is shunted with it when hit; the hitter isn't thrown back; the check flags the overlap", () => {
  const st = headless([scar("police", "Police car", "police_car", [{ frame: 0, position: [0, 0, -20] }, { frame: 96, position: [0, 0, 20] }]),
    scar("red", "Red car", "car", [{ frame: 0, position: [0, 0, 0] }]), scar("blue", "Blue car", "car", [{ frame: 0, position: [0, 0, 4.4] }])]);
  const r = st.simulatePhysics();
  assert.ok(r.ok, r.message);
  assert.equal(r.takeovers.blue?.by, "red", "the car it was placed into goes with it");
  const fastestKey = (id) => { const k = st.state.actors.find((x) => x.id === id).keys; let m = 0; for (let i = 1; i < k.length; i++) m = Math.max(m, Math.hypot(...k[i].position.map((v, j) => v - k[i - 1].position[j])) / (k[i].frame - k[i - 1].frame) * FPS); return m; };
  for (const id of ["police", "red", "blue"]) assert.ok(fastestKey(id) < 13, `${id}: ${fastestKey(id).toFixed(1)} m/s (the police car keys 12.4)`);
  assert.match(st.consequenceCheck().map((i) => i.text).join(" "), /The red car passes through the blue car at 0\.0 s/, "the set dressing is still reported");
});

test("stage: a car into the plaza's facade says it hit the set wall, not 'set_0'", () => {
  const st = headless([scar("c", "Car", "car", [{ frame: 0, position: [-6, 0, -10] }, { frame: 96, position: [-6, 0, 30] }])], { set: "plaza" });
  const r = st.simulatePhysics();
  assert.ok(r.ok && r.takeovers.c, r.message);
  assert.match(r.message, /Car: physics took over at f \d+ \(\d\.\d s\), hit the set wall at \d+ km\/h/);
  assert.doesNotMatch(r.message, /set_\d/);
});

test("Director: 'ram' on a car the last bake already took over uses the planned keys (its old path used to be merged in and it missed)", async () => {
  const { Director } = await import("../../web/agent/director.mjs");
  const scene = () => [
    scar("police", "Police car", "police_car", [{ frame: 0, position: [-6, 0, -20] }, { frame: 40, position: [-6, 0, 0] }, { frame: 96, position: [-6, 0, 20] }]),
    scar("blue", "Blue car", "car", [{ frame: 0, position: [-6, 0, 8] }]),
    scar("red", "Red car", "sports_car", [{ frame: 0, position: [0, 0, 0] }]),
  ];
  const ram = async (st) => new Director({ api: { fetchApi: async () => ({ ok: false }) }, stage: st, host: {} }).apply({ command: "the police car rams the red car",
    calls: [{ tool: "ram", plan: "", args: { target: "Police car", target_id: "police", victim: "Red car", victim_id: "red" } }] });
  const st = headless(scene());
  assert.ok(st.simulatePhysics().takeovers.police, "the first bake takes the police car over (it hits the blue car)");
  const out = await ram(st);
  assert.ok(st.state.physics.takeovers.red, out.said[0]);
  assert.doesNotMatch(out.said[0], /never touched/);
  const pol = st.state.actors.find((a) => a.id === "police");
  assert.equal(pol.physics.source.keys.length, 2, `the ram's two keys, no stale key from the old path: ${JSON.stringify(pol.physics.source.keys)}`);
  const st2 = headless(scene());
  await ram(st2);
  assert.equal(baked(st), baked(st2), "the same as ramming in the unbaked scene");
});
