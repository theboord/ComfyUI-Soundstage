// Drive mode (web/stage/drive.mjs, Milestone 29): input mapping and remapping, gait from the stick, the person / horse
// / car / prop steps, a J-turn driven by hand on the live car, throws, and takes -> keys (mount spans, layered takes).
// node --test tests/js/drive.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as D from "../../web/stage/drive.mjs";
import { LiveCar, simulate, carParams, CAR } from "../../web/stage/vehsim.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ± ${tol}`);
const pad = (axes = [0, 0, 0, 0], buttons = {}) => ({ axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: (buttons[i] || 0) > 0.5, value: buttons[i] || 0 })) });
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test("input: WASD and arrows move (diagonals normalised), the left stick wins when pushed further, dead zone rescaled", () => {
  let i = D.readInput({ down: new Set(["KeyW", "KeyD"]) });
  near(Math.hypot(...i.move), 1, 1e-9, "diagonal is unit length");
  assert.ok(i.move[0] > 0 && i.move[1] > 0, "W + D = forward right");
  i = D.readInput({ down: new Set(["ArrowLeft"]) });
  assert.deepEqual(i.move, [-1, 0]);
  assert.deepEqual(D.stick(0.1, 0.05), [0, 0], "inside the dead zone: nothing");
  near(Math.hypot(...D.stick(1, 0)), 1, 1e-9, "full deflection still reaches 1");
  near(D.stick(0.575, 0)[0], 0.5, 1e-9, "rescaled past the dead zone");
  i = D.readInput({ pad: pad([0, -1, 0.6, 0]) });   // stick up = forward (the Gamepad API's y points down)
  near(i.move[1], 1, 1e-9, "stick forward"); assert.ok(i.look[0] > 0.4, "right stick looks");
  i = D.readInput({ down: new Set(["KeyW"]), pad: pad([0.3, 0, 0, 0]) });
  assert.deepEqual(i.move, [0, 1], "the keys win over a half-pushed stick");
});

test("input: triggers are analog throttle / brake, buttons map to actions, edges fire once, bindings remap and persist", () => {
  let i = D.readInput({ pad: pad([0, 0, 0, 0], { 7: 0.4, 6: 0.9, 3: 1 }) });
  near(i.throttle, 0.4, 1e-9, "RT throttle"); near(i.brake, 0.9, 1e-9, "LT brake"); assert.equal(i.interact, 1, "Y interacts");
  const k = D.readInput({ down: new Set(["KeyS", "KeyE", "Space"]) });
  assert.equal(k.brake, 1); assert.equal(k.interact, 1); assert.equal(k.jump, 1); assert.equal(k.handbrake, 1);
  const p0 = D.readInput({}), p1 = D.readInput({ down: new Set(["KeyC"]) });
  assert.equal(D.pressed(p0, p1).pickup, true, "C pressed");
  assert.equal(D.pressed(p1, p1).pickup, false, "held is not pressed again");
  const store = memStore();
  let b = D.loadBindings(store);
  assert.deepEqual(b.keys.interact, ["KeyE"]);
  b = D.remap(b, "interact", { key: "KeyG", button: 1 }, store);
  assert.deepEqual(D.loadBindings(store).keys.interact, ["KeyG"], "remap persists");
  assert.deepEqual(D.loadBindings(store).pad.interact, [1]);
  assert.equal(D.readInput({ down: new Set(["KeyG"]), bindings: b }).interact, 1, "the new key works");
  assert.equal(D.readInput({ down: new Set(["KeyE"]), bindings: b }).interact, 0, "the old one doesn't");
  assert.deepEqual(D.resetBindings(store).keys.interact, ["KeyE"]);
  // Every action is documented with a label and has at least one way to trigger it.
  for (const a of D.ACTIONS) assert.ok(a.label && (a.keys.length || a.pad.length), a.id);
});

test("gait from the stick: half = walk, full = jog, + run = run; horses walk, trot, canter, gallop", () => {
  assert.equal(D.personSpeed(0.02), 0);
  assert.equal(D.gaitFor("person", D.personSpeed(0.5), 1.8), "walk");
  assert.equal(D.gaitFor("person", D.personSpeed(1), 1.8), "jog");
  assert.equal(D.gaitFor("person", D.personSpeed(1, true), 1.8), "run");
  assert.ok(D.personSpeed(0.3) < D.personSpeed(0.6) && D.personSpeed(0.6) < D.personSpeed(1), "more stick, faster");
  assert.ok(D.personSpeed(1, false, 1.2) < D.personSpeed(1, false, 1.8), "a child (shorter legs) is slower at full stick");
  assert.equal(D.gaitFor("horse", D.horseSpeed(0.3), 1.6), "walk");
  assert.equal(D.gaitFor("horse", D.horseSpeed(0.7), 1.6), "trot");
  assert.equal(D.gaitFor("horse", D.horseSpeed(1), 1.6), "canter");
  assert.equal(D.gaitFor("horse", D.horseSpeed(1, true), 1.6), "gallop");
});

test("people move relative to the camera, turn toward the stick, run up to speed, jump a ballistic arc and stop at walls", () => {
  // Camera looking along +x (yaw 90°): stick forward goes +x, stick right goes -z (the camera's right).
  const [fx, fz] = D.moveDir(0, 1, Math.PI / 2); near(fx, 1, 1e-9, "forward"); near(fz, 0, 1e-9, "forward");
  const [rx, rz] = D.moveDir(1, 0, Math.PI / 2); near(rx, 0, 1e-9, "right"); near(rz, 1, 1e-9, "right (screen right, looking along +x, is +z)");
  const b = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, height: 1.8 };
  const env = { camYaw: Math.PI / 2, ground: () => 0 };
  for (let i = 0; i < 120; i++) D.personStep(b, { move: [0, 1], mag: 1, sprint: 1 }, env, 1 / 60);
  near(b.yaw, Math.PI / 2, 0.02, "turned to face the way the stick points");
  assert.ok(b.speed > 5.5, `ran up to speed: ${b.speed}`);
  assert.ok(b.x > 4 && Math.abs(b.z) < 1, `went +x: ${b.x}, ${b.z}`);
  // Stop: let go and it comes to rest within half a second.
  for (let i = 0; i < 40; i++) D.personStep(b, { move: [0, 0], mag: 0 }, env, 1 / 60);
  assert.equal(b.speed, 0);
  // Jump: rises about JUMP_H and lands.
  let peak = 0;
  D.personStep(b, { move: [0, 0], mag: 0, jumpPressed: true }, env, 1 / 60);
  assert.ok(b.air);
  for (let i = 0; i < 90 && b.air; i++) { D.personStep(b, { move: [0, 0], mag: 0 }, env, 1 / 60); peak = Math.max(peak, b.y); }
  near(peak, D.JUMP_H, 0.05, "jump height"); assert.equal(b.y, 0); assert.equal(b.air, false);
  // A wall 3 m ahead (a box 2 m tall): they stop against it, never inside.
  const wall = [{ cx: b.x + 3.5, cz: 0, hx: 0.5, hz: 4, yaw: 0, bottom: 0, top: 2 }];
  const wenv = { ...env, collide: (x, z, feet, head, r) => D.collideCircle(x, z, r, wall, { feet, head }) };
  for (let i = 0; i < 180; i++) D.personStep(b, { move: [0, 1], mag: 1 }, wenv, 1 / 60);
  assert.ok(b.x <= wall[0].cx - 0.5 - 0.27, `held at the wall: ${b.x}`);
  // A low kerb (0.2 m) is stepped over, not a wall.
  assert.equal(D.collideCircle(0, 0, 0.3, [{ cx: 0, cz: 0, hx: 1, hz: 1, yaw: 0, bottom: 0, top: 0.2 }], { feet: 0, head: 1.8 }).hit, false);
});

test("climb: Space next to a crate (0.45–1.75 m) climbs up onto it", () => {
  const b = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, height: 1.8 };
  const env = { camYaw: 0, ground: () => 0, climb: () => ({ rise: 0.8, to: [0, 0.8, 0.75] }) };
  D.personStep(b, { move: [0, 0], mag: 0, jumpPressed: true }, env, 1 / 60);
  assert.ok(b.climb);
  for (let i = 0; i < 120 && b.climb; i++) D.personStep(b, { move: [0, 0], mag: 0 }, env, 1 / 60);
  assert.equal(b.climb, null); near(b.y, 0.8, 1e-9, "on top"); near(b.z, 0.75, 1e-9, "over the edge");
});

test("horses: forward picks the pace, the stick turns, a full gallop reaches gallop speed", () => {
  const h = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, height: 1.6 };
  for (let i = 0; i < 60 * 8; i++) D.horseStep(h, { move: [0, 1], sprint: 1 }, {}, 1 / 60);
  assert.equal(D.gaitFor("horse", h.speed, 1.6), "gallop");
  const y0 = h.yaw;
  for (let i = 0; i < 60; i++) D.horseStep(h, { move: [1, 1], sprint: 0 }, {}, 1 / 60);
  assert.ok(h.yaw < y0 - 0.4, "stick right turns right (heading down)");
  for (let i = 0; i < 60 * 6; i++) D.horseStep(h, { move: [0, -1] }, {}, 1 / 60);
  assert.ok(h.speed <= 0, "pulling back stops it (then backs up slowly)");
});

test("the live car is the same car as the stunt simulation (vehsim): same run with the same controls", () => {
  const coast = simulate({ start: { kmh: 50 }, steps: [] }, { car: CAR, surface: "wet", frames: 49 });
  const c = new LiveCar({ car: CAR, surface: "wet", speed: 50 / 3.6 });
  for (let f = 0; f < 48; f++) c.step({}, 1 / 24);
  assert.equal(c.Z, coast[48].z, "coasting: identical");
  const run = simulate({ start: { kmh: 50 }, steps: [{ at: 0, set: { throttle: 1, steer: 8 } }] }, { car: CAR, surface: "dry", frames: 73 });
  const l = new LiveCar({ car: CAR, surface: "dry", speed: 50 / 3.6 });
  for (let f = 0; f < 72; f++) l.step({ throttle: 1, steer: 8 }, 1 / 24);
  near(l.X, run[72].x, 0.02, "x"); near(l.Z, run[72].z, 0.02, "z"); near(l.H / Math.PI * 180, run[72].h, 0.05, "heading");
});

test("a J-turn driven by hand: back up to 40 km/h, flick the wheel, the nose comes round, drive off forward", () => {
  const car = carParams("sports_car", null, "stunt");
  const c = new LiveCar({ car, surface: "dry", fps: 24, substeps: 50 });
  const st = { gear: "D", steer: 0 };
  const dt = 1 / 60;
  const run = (secs, inp) => { for (let i = 0; i < secs * 60; i++) c.step(D.carControls({ throttle: 0, brake: 0, steer: 0, handbrake: 0, ...inp }, c.forward, car, st, dt), dt); };
  run(3.7, { brake: 1 });                     // the brake, held at a stop, becomes reverse (GTA style)
  assert.equal(st.gear, "R");
  assert.ok(c.forward < -10, `reversing at ${(c.forward * 3.6).toFixed(0)} km/h`);
  run(0.85, { steer: 1 });                    // full lock
  run(2.1, { throttle: 1 });                  // and away in first
  const turned = Math.abs(c.H) / Math.PI * 180;
  assert.ok(turned > 150 && turned < 200, `turned ${turned.toFixed(0)}°`);
  assert.equal(st.gear, "D");
  assert.ok(c.forward > 7, `driving off forward: ${c.forward}`);
  // Handbrake on at speed: the rears lock and the car slides (a drift by hand).
  const d = new LiveCar({ car, surface: "dry", speed: 15 });
  let beta = 0;
  for (let i = 0; i < 90; i++) { d.step({ throttle: 0.3, steer: 20, handbrake: i < 30 ? 1 : 0 }, dt); beta = Math.max(beta, Math.abs(d.beta)); }
  assert.ok(beta > 15, `slides: β ${beta.toFixed(0)}°`);
});

test("throws: launch along the aim with a lift, fly, bounce, slide and settle flat on a face", () => {
  const v = D.throwVelocity(0, 0.2, 9, [0, 1]);
  assert.ok(v[2] > 9 && v[1] > 3, `forward and up: ${v}`);
  const arc = D.throwArc([0, 1.2, 0], v);
  assert.ok(arc.length > 10 && arc[arc.length - 1][2] > 5, "the aim line reaches the landing");
  const p = { c: [0, 1.2, 0], v, q: [0, 0, 0, 1], w: [7, 1.5, 0], half: [0.3, 0.3, 0.3] };
  const env = { ground: () => 0 };
  let n = 0;
  while (!p.rest && n++ < 600) D.projectileStep(p, env, 1 / 60);
  assert.ok(p.rest, "comes to rest");
  near(p.c[1], 0.3, 1e-6, "sits on the floor on a face");
  assert.ok(p.c[2] > 5 && p.c[2] < 16, `landed downrange: ${p.c[2]}`);
  // A face is down: one of the box's own axes points straight up.
  const q0 = new THREE.Quaternion(...p.q);
  const vertical = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].some((e) => Math.abs(new THREE.Vector3(...e).applyQuaternion(q0).y) > 0.999);
  assert.ok(vertical, `flat: ${p.q}`);
  // Into a wall: it bounces back off it.
  const q = { c: [0, 1, 0], v: [0, 2, 10], q: [0, 0, 0, 1], w: [0, 0, 0], half: [0.25, 0.25, 0.25] };
  const wall = [{ cx: 0, cz: 3, hx: 3, hz: 0.2, yaw: 0, bottom: 0, top: 3 }];
  const wenv = { ground: () => 0, collide: (x2, z2, feet, head, r) => D.collideCircle(x2, z2, r, wall, { feet, head, step: 0 }) };
  for (let i = 0; i < 120; i++) D.projectileStep(q, wenv, 1 / 60);
  assert.ok(q.c[2] < 3 - 0.2, `bounced off the wall: ${q.c[2]}`);
});

// ------------------------------------------------------------------ takes -> keys

/** A stage stand-in with what applyTake uses. */
function fakeStage(actors) {
  return {
    state: { actors, shot: { frames: 97, fps: 24 } },
    actorMeshes: new Map(),
    _actorKeys: (a) => (a.keys ||= [{ frame: 0, position: [...a.position] }]),
    _headingAt: (a) => ((a.rotation_deg || 0) * Math.PI) / 180,
  };
}
const walkSamples = (f0, f1, { x0 = 0, z0 = 0, v = 1.4, yaw = 0, jitter = 0 } = {}) => {
  const out = [];
  for (let f = f0; f <= f1; f++) {
    const t = (f - f0) / 24;
    out.push({ f, p: [x0 + Math.sin(yaw) * v * t + (jitter ? Math.sin(f * 2.7) * jitter : 0), 0, z0 + Math.cos(yaw) * v * t], yaw, mode: "foot" });
  }
  return out;
};

test("take -> keys: a key every 2 frames with height and unwrapped heading; smoothing takes out the jitter, not the jumps", () => {
  const s = walkSamples(0, 48, { jitter: 0.03 });
  s[20].p[1] = 0.5;   // a jump's apex
  const raw = D.pathKeys(s, { smoothing: "none" }), sm = D.pathKeys(s, { smoothing: "smooth" });
  assert.equal(raw.length, 25);
  assert.deepEqual(raw.map((k) => k.frame).slice(0, 3), [0, 2, 4]);
  assert.equal(raw.find((k) => k.frame === 20).position[1], 0.5, "the jump stays");
  assert.equal(sm.find((k) => k.frame === 20).position[1], 0.5, "smoothing leaves the height alone");
  const wig = (ks) => ks.slice(2, -2).reduce((m, k) => Math.max(m, Math.abs(k.position[0])), 0);
  assert.ok(wig(sm) < wig(raw) / 2, `smoothed: ${wig(sm)} vs ${wig(raw)}`);
  // A spin past 180° unwraps (no flip back through the long way).
  const spin = Array.from({ length: 30 }, (_, i) => ({ f: i, p: [0, 0, 0], yaw: ((i * 15 + 180) % 360 - 180) * Math.PI / 180 }));
  const hk = D.pathKeys(spin, { smoothing: "none", every: 1 }).map((k) => k.heading_deg);
  for (let i = 1; i < hk.length; i++) near(hk[i] - hk[i - 1], 15, 0.01, `step ${i}`);
});

test("take -> keys: getting in and out of a car makes a mount span, the door keys, and the walk before and after", () => {
  const man = { id: "man", kind: "man", position: [0, 0, 0] }, car = { id: "car", kind: "sports_car", position: [3, 0, 0] };
  const st = fakeStage([man, car]);
  const hop = D.HOP_FRAMES;
  const samples = [
    ...walkSamples(0, 20),
    ...Array.from({ length: hop }, (_, i) => ({ f: 21 + i, p: [0, 0, 1.4], yaw: 0, mode: "hop", host: "car", seat: 0 })),
    ...Array.from({ length: 40 }, (_, i) => ({ f: 21 + hop + i, p: [0, 0, 1.4], yaw: 0, mode: "mounted", host: "car", seat: 0 })),
    ...Array.from({ length: 14 }, (_, i) => ({ f: 61 + hop + i, p: [5, 0, 10], yaw: 1, mode: "exit", host: "car", seat: 0 })),
    ...walkSamples(75 + hop, 96, { x0: 5, z0: 10, yaw: 1 }),
  ];
  const cs = Array.from({ length: 30 }, (_, i) => ({ f: 31 + i, p: [3, 0, i * 0.3], yaw: 0, roll: 1, pitch: -0.5, steer: 4 }));
  const take = { start: 0, fps: 24, tracks: { man: { type: "person", samples }, car: { type: "car", samples: cs, surface: "dry" } },
    events: D.doorKeys(21, 21 + hop).map((k) => ({ type: "part", id: "car", ch: "door_fl", v: k.v, frame: Math.max(0, k.f), prev: 0 })) };
  const sum = D.applyTake(st, take);
  assert.equal(sum.length, 2);
  assert.deepEqual(man.mount_spans, [{ host: "car", seat: 0, pose: null, from: 21 + hop, to: 61 + hop }]);
  assert.equal(man.mount_id, undefined, "the span, not a static mount");
  assert.ok(man.keys.some((k) => k.frame === 21 + hop), "a key where they sit down");
  const exitKey = man.keys.find((k) => k.frame === 61 + hop - 1);
  assert.deepEqual(exitKey.position, [5, 0, 10], "their keys wait at the exit spot before they get out");
  assert.ok(car.keys[0].frame === 0 && car.keys[1].frame === 31, "the car holds where it was until the take moved it");
  assert.equal(car.keys[1].roll_deg, 1); assert.equal(car.stunt_sim.driven, true);
  assert.deepEqual(car.parts.steer.map((k) => [k.frame, k.v]), [[31, 4], [60, 4]], "the wheel as turned (a held wheel keeps its two ends)");
  assert.ok(car.keys.length < 20, `a straight run at constant speed still keys every 2 frames, a hold doesn't: ${car.keys.length}`);
  const parked = D.pathKeys(Array.from({ length: 50 }, (_, i) => ({ f: i, p: [1, 0, 2], yaw: 0.5 })));
  assert.equal(parked.length, 2, "parked: the first and last key only");
  assert.deepEqual(car.parts.door_fl.map((k) => k.v), [0, 0, 65, 65, 0], "the door opens before they climb in and shuts after");
});

test("mount spans: a one-frame blip between two stretches on the same seat is one span; already seated = no climb-on", () => {
  const m = (f, mode, host = "car") => ({ f, p: [0, 0, 0], yaw: 0, mode, host });
  const sp = D.mountSpans([m(0, "foot"), m(1, "hop"), m(2, "mounted"), m(3, "hop"), m(4, "mounted"), m(5, "mounted"), m(6, "exit"), m(7, "foot")]);
  assert.deepEqual(sp.map((s) => [s.from, s.to]), [[2, 6]]);
  const seated = D.mountSpans([m(10, "mounted", "horse"), m(11, "mounted", "horse"), m(12, "foot")]);
  assert.equal(seated[0].noHop, true);
});

test("layered takes: a second take on another actor leaves the first; re-driving keeps the keys before it and joins seats", () => {
  const a = { id: "a", kind: "man", position: [0, 0, 0] }, b = { id: "b", kind: "horse", position: [5, 0, 0] };
  const st = fakeStage([a, b]);
  D.applyTake(st, { start: 0, tracks: { a: { type: "person", samples: walkSamples(0, 96) } }, events: [] });
  const aKeys = JSON.stringify(a.keys);
  D.applyTake(st, { start: 0, tracks: { b: { type: "path", samples: walkSamples(0, 96, { x0: 5, v: 8 }) } }, events: [{ type: "gaze", id: "a", frame: 30, target: "b" }] });
  assert.equal(JSON.stringify(a.keys), aKeys, "take A untouched by take B");
  assert.ok(b.keys.length > 40, "B has its own keys");
  assert.deepEqual(a.gaze, [{ frame: 30, target: "b" }], "events land on their own actor");
  // Re-record A from frame 48: its keys before 48 stay (with headings), the rest is the new take.
  D.applyTake(st, { start: 48, tracks: { a: { type: "person", samples: walkSamples(48, 96, { x0: 0, z0: 3, yaw: Math.PI / 2 }) } }, events: [] });
  assert.ok(a.keys.filter((k) => k.frame < 48).length === 24, "earlier keys kept");
  assert.ok(a.keys.every((k) => Number.isFinite(k.heading_deg)), "kept keys carry a heading, so the heading track is continuous");
  // In the saddle from an earlier take and still there when the next one starts: one span, not a second climb-on.
  const r = { id: "r", kind: "man", position: [0, 0, 0], mount_spans: [{ host: "b", seat: null, pose: null, from: 20, to: 1e9 }] };
  st.state.actors.push(r);
  D.applyTake(st, { start: 60, tracks: { r: { type: "person", samples: [...Array.from({ length: 10 }, (_, i) => ({ f: 60 + i, p: [0, 0, 0], yaw: 0, mode: "mounted", host: "b" })), ...Array.from({ length: 20 }, (_, i) => ({ f: 70 + i, p: [2, 0, 0], yaw: 0, mode: "foot" }))] } }, events: [] });
  assert.deepEqual(r.mount_spans.map((s) => [s.from, s.to]), [[20, 70]], "joined: on at 20, off at 70");
});

test("drive kinds: people, horses, cars, bikes, boats and props drive; buildings don't", () => {
  const K = { PERSON_KINDS: new Set(["man", "woman", "child"]) };
  assert.equal(D.driveKind({ kind: "woman" }, K), "person");
  assert.equal(D.driveKind({ kind: "horse" }, K), "horse");
  assert.equal(D.driveKind({ kind: "police_car" }, K), "car");
  assert.equal(D.driveKind({ kind: "motorcycle" }, K), "bike");
  assert.equal(D.driveKind({ kind: "boat" }, K), "boat");
  assert.equal(D.driveKind({ kind: "crate" }, K), "prop");
  assert.equal(D.driveKind({ kind: "building" }, K), null);
  assert.equal(D.driveKind(null, K), null);
});
