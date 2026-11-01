// Movie car stunts (Milestone 13): heading keys that bypass the turn-rate cap, reverse driving, body roll / pitch on
// springs, deterministic tyre smoke, and the Stunt presets (reverse J-turn, donut, handbrake 180). Headless Stage (no
// WebGL); the real car GLBs are read from disk so the body pivot and wheel rig are the shipping ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { describeLighting } from "../../web/stage/lighting.mjs";
import { STUNTS, BODY, unwrapDeg, headingTrack, vehicleDynamics, smokeParticles, stuntKeys, monotone } from "../../web/stage/stunts.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};

const DEG = 180 / Math.PI;
const wrap = (d) => ((d % 360) + 540) % 360 - 180;

function headless(actors, frames = 121) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set: "studio" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}

async function body(st, id) {
  for (let i = 0; i < 400; i++) {
    if (st.actorMeshes.get(id)?.userData.vehicleBody) return st.actorMeshes.get(id);
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`${id}: car body never loaded`);
}

const car = (keys, extra = {}) => ({ id: "car", name: "Stunt car", kind: "sports_car", height_m: 1.2, keys, position: keys[0].position, ...extra });

test("heading keys: sampled through the keys, exact at each key, values taken unwrapped (two spins = 720°)", () => {
  const st = headless([car([
    { frame: 0, position: [0, 0, 0], heading_deg: 180 }, { frame: 10, position: [0, 0, 5], heading_deg: 90 },
    { frame: 20, position: [0, 0, 10], heading_deg: 0 }, { frame: 40, position: [0, 0, 20], heading_deg: 720 }])]);
  const a = st.state.actors[0];
  assert.equal(Math.round(st._headingAt(a, 0) * DEG), 180);
  assert.equal(Math.round(st._headingAt(a, 10) * DEG), 90);
  assert.equal(Math.round(st._headingAt(a, 20) * DEG), 0);
  assert.equal(Math.round(st._headingAt(a, 40) * DEG), 720);
  const mid = st._headingAt(a, 30) * DEG;
  assert.ok(mid > 250 && mid < 470, `two spins between 20 and 40: ${mid}`);
  assert.deepEqual(headingTrack(a.keys).map((k) => k.h[0]), [180, 90, 0, 720]);
});

test("unwrap: an edited heading stays continuous with the one before it", () => {
  assert.equal(unwrapDeg(350, 10), 370);
  assert.equal(unwrapDeg(10, 350), -10);
  assert.equal(unwrapDeg(725, 0), 720);
  assert.equal(unwrapDeg(-170, 180), -180);
  assert.equal(unwrapDeg(NaN, 45), 45);
});

test("heading keys bypass the turn-rate cap; without them the cap holds exactly as before", () => {
  // 180° in 6 frames = 720°/s, far past the sports car's 110°/s cap.
  const keyed = headless([car([{ frame: 0, position: [0, 0, 0], heading_deg: 180 }, { frame: 6, position: [0, 0, 2], heading_deg: 0 },
    { frame: 30, position: [0, 0, 12], heading_deg: 0 }])], 31);
  const a = keyed.state.actors[0];
  assert.equal(Math.round(a && keyed._headingAt(a, 6) * DEG), 0);
  assert.ok(Math.abs(keyed._headingAt(a, 3) * DEG - 90) < 25);
  // The same path with no heading keys: a turn-rate-capped heading, never more than 110°/s.
  const plain = headless([car([{ frame: 0, position: [0, 0, 0] }, { frame: 15, position: [0, 0, 6] }, { frame: 30, position: [0, 0, 0] }])], 31);
  const b = plain.state.actors[0];
  for (let f = 1; f <= 30; f++) {
    const d = Math.abs(wrap((plain._headingAt(b, f) - plain._headingAt(b, f - 1)) * DEG));
    assert.ok(d <= 110 / 24 + 1e-6, `frame ${f}: turned ${d.toFixed(2)}°`);
  }
});

test("drive: reverse — the tail leads (on the car, or from a key on)", () => {
  const st = headless([car([{ frame: 0, position: [0, 0, 0] }, { frame: 30, position: [0, 0, 10] }], { drive: "reverse" })], 31);
  const a = st.state.actors[0];
  assert.equal(Math.round(Math.abs(wrap(st._headingAt(a, 15) * DEG))), 180, "driving +Z in reverse: the nose points -Z");
  a.drive = undefined;
  st._headCache = null;
  assert.equal(Math.round(st._headingAt(a, 15) * DEG), 0, "forward again without it");
});

test("body roll and pitch: lean out of a turn, squat on the launch, dive on the brakes, within limits", () => {
  const fps = 24, n = 97;
  // A left turn (heading increasing: toward stage +X from +Z) at 10 m/s on a 15 m circle.
  const pos = [], yaw = [];
  for (let f = 0; f < n; f++) { const t = f / fps, w = 10 / 15; pos.push([15 - 15 * Math.cos(w * t), 0, 15 * Math.sin(w * t)]); yaw.push(w * t); }
  const turn = vehicleDynamics(pos, yaw, fps);
  assert.ok(turn.accel[48][1] > 5, "centripetal acceleration points to the car's left (+X local)");
  assert.ok(turn.roll[48] > 3, `the body leans onto its outside (right) tyres: roll ${turn.roll[48]}`);
  assert.ok(Math.max(...turn.roll.map(Math.abs)) <= BODY.rollMax + 4.0001);
  // Straight launch, then hard braking.
  const p2 = [], y2 = new Array(n).fill(0);
  let z = 0, v = 0;
  for (let f = 0; f < n; f++) { v += (f < 48 ? 6 : -9) / fps; v = Math.max(0, v); z += v / fps; p2.push([0, 0, z]); }
  const st = vehicleDynamics(p2, y2, fps);
  assert.ok(st.pitch[40] > 1 && st.pitch[40] <= BODY.pitchMax + 3, `nose up / rear squats under acceleration: ${st.pitch[40]}`);
  assert.ok(st.pitch[60] < -1, `nose dives under braking: ${st.pitch[60]}`);
  assert.ok(Math.abs(st.roll[40]) < 0.2, "no roll going straight");
  // Keyed extras add on top (before the spring).
  const plus = vehicleDynamics(p2, y2, fps, () => ({ roll: 3, pitch: 0 }));
  assert.ok(Math.abs(plus.roll[40] - 3) < 0.3);
});

test("tyre smoke is a pure function of the track and the frame, from the chosen wheels only", () => {
  const n = 61, pos = [], yaw = [], vel = [], smoke = [];
  for (let f = 0; f < n; f++) { pos.push([0, 0, f * 0.3]); yaw.push(0); vel.push([0, 7.2]); smoke.push({ amount: f >= 10 && f < 40 ? 1 : 0, wheels: "rear" }); }
  const track = { pos, yaw, vel, smoke };
  const wheels = [{ x: 0.8, z: 1.3, front: true }, { x: -0.8, z: 1.3, front: true }, { x: 0.8, z: -1.3, front: false }, { x: -0.8, z: -1.3, front: false }];
  const a = smokeParticles(track, wheels, 30, 24, 7), b = smokeParticles(track, wheels, 30, 24, 7);
  assert.ok(a.length > 20);
  assert.deepEqual(a, b, "same frame, same puffs");
  assert.equal(smokeParticles(track, wheels, 5, 24, 7).length, 0, "nothing before the first key with smoke");
  for (const q of a) assert.ok(q.size >= 0.8 && q.size <= 3 && q.alpha >= 0 && q.alpha <= 1);
  // Born at the rear tyres (z = f*0.3 - 1.3): every puff starts behind the car's centre.
  const fresh = smokeParticles({ ...track, smoke: smoke.map((s, f) => ({ ...s, amount: f === 30 ? 1 : 0 })) }, wheels, 30, 24, 7);
  assert.ok(fresh.length && fresh.every((q) => q.p[2] < 9 - 0.3), "only the rear wheels smoke");
});

test("stunt presets: driven through the simulation and baked into a key every 2 frames", () => {
  assert.deepEqual(Object.keys(STUNTS), ["reverse_jturn", "donut", "handbrake_180"]);
  const k = stuntKeys("reverse_jturn", { start: [1.6, 0, -14], dirDeg: 0, last: 120 });
  assert.equal(k.length, 61);
  const at = (f) => k.find((x) => x.frame === f);
  assert.deepEqual(at(0).position, [1.6, 0, -14]);
  assert.equal(at(0).heading_deg, 180);
  // Reversing at 40 km/h (11.1 m/s): 0.46 m a frame along +Z, tail first, until the flick at 1 s.
  assert.ok(Math.abs(at(24).position[2] - (-14 + 24 * 11.11 / 24)) < 0.2 && at(24).heading_deg === 180);
  // The 180 takes well over a second (not the old 0.7 s), and the car is still sliding through it.
  assert.ok(at(48).heading_deg > 90 && at(48).heading_deg < 150, `f48: ${at(48).heading_deg}`);
  assert.ok(Math.abs(at(120).heading_deg) < 15, `nose first at the end: ${at(120).heading_deg}`);
  assert.ok(at(120).position[2] > 20, "drives off the way it was going");
  // Body roll / pitch and smoke are the simulation's, keyed on every key.
  assert.ok(k.every((x) => Number.isFinite(x.roll_deg) && Number.isFinite(x.pitch_deg) && Number.isFinite(x.fx.tire_smoke)));
  assert.ok(Math.max(...k.map((x) => Math.abs(x.roll_deg))) > 2.5);
  // A shorter shot runs the same physics for less time; another direction rotates it.
  const short = stuntKeys("reverse_jturn", { start: [0, 0, 0], dirDeg: 90, last: 96 });
  assert.equal(short[short.length - 1].frame, 96);
  assert.equal(short[0].heading_deg, 270);
  assert.ok(short[short.length - 1].position[0] > 15 && Math.abs(short[short.length - 1].position[2]) < 6, "travels +X");
  // Donut: the tail swings round more than once; handbrake 180: ends facing back the way it came.
  const d = stuntKeys("donut", { last: 120 }), h = stuntKeys("handbrake_180", { last: 120 });
  assert.ok(Math.abs(d[d.length - 1].heading_deg) > 250);
  assert.ok(Math.abs(Math.abs(h[h.length - 1].heading_deg) - 180) < 20);
  // The interpolation helper never overshoots a key (monotone).
  for (let t = 0; t <= 10; t += 0.5) assert.ok(monotone([0, 5, 10], [0, 10, 10], t) <= 10 + 1e-9);
});

test("Stage.applyStunt writes the keys from where the car is, plays them, and 'none' takes them off", async () => {
  const st = headless([car([{ frame: 0, position: [1.6, 0, -14] }, { frame: 120, position: [1.6, 0, 36] }])]);
  const g = await body(st, "car");
  assert.equal(st.applyStunt("car", "reverse_jturn"), "Reverse J-turn");
  const a = st.state.actors[0];
  assert.equal(a.stunt, "reverse_jturn");
  assert.equal(st.selectedInfo?.call({ ...st, selected: "car" }).stunt, "reverse_jturn");
  assert.equal(Math.round(st._headingAt(a, 0) * DEG), 180);
  assert.ok(Math.abs(st._headingAt(a, 120) * DEG) < 15);
  assert.equal(a.stunt_sim.surface, "wet");
  // The knobs re-run it from the same start: a dry road turns quicker and slides less.
  const wet = a.stunt_sim.metrics;
  st.applyStunt("car", "reverse_jturn", { surface: "dry" });
  assert.equal(a.stunt_sim.surface, "dry");
  assert.deepEqual(a.keys[0].position, [1.6, 0, -14]);
  assert.ok(a.stunt_sim.metrics.slide_m < wet.slide_m && a.stunt_sim.metrics.rotation_s < wet.rotation_s);
  st.applyStunt("car", "reverse_jturn", { surface: "wet" });
  // The wheels roll backwards while it reverses, the body (not the wheels) rolls through the spin, smoke shows.
  const dyn = st._vehicleDynamics(a);
  assert.ok(dyn.wheelDist[30] < -8, "reversing: the wheels turn backwards");
  assert.ok(dyn.wheelDist[120] > dyn.wheelDist[60], "then forwards");
  st.setFrame(48);
  const bodyPivot = g.userData.vehicleBody;
  assert.ok(bodyPivot.userData.bodyPivot && Math.abs(bodyPivot.rotation.z) > 2 / DEG, `rolled ${bodyPivot.rotation.z * DEG}°`);
  for (const w of g.userData.wheelRig) assert.equal(w.parent, g, "wheels stay on the car, out of the rolling body");
  const smoke = g.userData.tireSmoke;
  assert.ok(smoke?.object.visible && smoke.object.geometry.drawRange.count > 10);
  const snap = Array.from(smoke.object.geometry.attributes.position.array.slice(0, 30));
  st.setFrame(90); st.setFrame(48);
  assert.deepEqual(Array.from(smoke.object.geometry.attributes.position.array.slice(0, 30)), snap, "the same puffs at frame 48 every time");
  // Turn at a key edits that key's heading (kept continuous), not the car's rest Turn.
  st.selected = "car"; st.setFrame(48);
  st.rotateSelected(-170);
  assert.equal(a.keys.find((k) => k.frame === 48).heading_deg, 190, "-170° is 190° next to the 90° it had");
  assert.equal(a.rotation_deg || 0, 0);
  assert.equal(st.applyStunt("car", "none"), "none");
  assert.ok(!a.keys.some((k) => "heading_deg" in k || "fx" in k) && !a.stunt);
});

test("an ordinary car on the Car Chase keeps its heading and makes no smoke", async () => {
  const wf = JSON.parse(readFileSync(new URL("../../example_workflows/Soundstage_Car_Chase.json", import.meta.url), "utf8"));
  const scene = JSON.parse(wf.nodes.find((n) => n.type === "SoundstageStage").widgets_values[0]);
  const st = headless(scene.actors);
  const g = await body(st, "sports_car");
  const a = st.state.actors.find((x) => x.id === "sports_car");
  const dyn = st._vehicleDynamics(a);
  assert.ok(!dyn.stunt && dyn.smoke.every((s) => s.amount === 0));
  for (let f = 0; f <= 120; f += 10) { st.setFrame(f); assert.ok(!g.userData.tireSmoke?.object.visible); }
});

test("the driver rides the rolling body: seat and lean follow the cabin, no legs out under the floor", async () => {
  const st = headless([car([{ frame: 0, position: [1.6, 0, -14] }, { frame: 120, position: [1.6, 0, 36] }]),
    { id: "drv", name: "Driver", kind: "man", height_m: 1.8, mount_id: "car", keys: [{ frame: 0, position: [1.6, 0, -14] }], position: [1.6, 0, -14] }]);
  const g = await body(st, "car");
  st.applyStunt("car", "reverse_jturn");
  st.setFrame(45);
  const bodyG = g.userData.vehicleBody, d = st.actorMeshes.get("drv");
  assert.ok(Math.abs(bodyG.rotation.z) > 1.5 / DEG, `the body leans through the slide: ${bodyG.rotation.z * DEG}°`);
  assert.ok(Math.abs(d.rotation.z - bodyG.rotation.z) < 1e-9, "the driver leans with the cabin");
  // The seat is where the rolled body carries it (not where the unrolled car would have it).
  st.setFrame(0);
  const flat = d.position.clone();
  assert.ok(Math.abs(d.rotation.z) < 0.02 / DEG + Math.abs(bodyG.rotation.z) + 1e-9);
  st.setFrame(45);
  assert.ok(d.position.distanceTo(flat) > 1, "it moves with the car");
});

test("a night street's five lamps are one lighting phrase in the prompt, not five", () => {
  const lamp = { type: "practical", kelvin: 2700, softness: 0.5 };
  const t = describeLighting({ lights: [lamp, lamp, lamp, lamp, lamp, { ...lamp, kelvin: 7000 }] }, { elevation_deg: -20, azimuth_deg: 0 }, null);
  assert.equal((t.match(/warm tungsten practical/g) || []).length, 1, t);
  assert.match(t, /^night, cool moonlight, warm tungsten practical.*, cool practical/);
});
