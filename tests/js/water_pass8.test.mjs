// Eighth water pass (Mike, 2026-11-08: "nothing actually has any buoyancy in it... depending on how heavy the object is
// or the person... we need to have swim control", and "when I placed a person in a water tank, they just went to the
// bottom and started walking"). Each test failed on b1f6d51 first. Invented test scenes only.
// node --test tests/js/water_pass8.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import { DriveMode } from "../../web/stage/drive.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };
globalThis.requestAnimationFrame ||= () => 0;
globalThis.cancelAnimationFrame ||= () => {};
globalThis.addEventListener ||= () => {};
globalThis.removeEventListener ||= () => {};
globalThis.ProgressEvent ??= class extends Event {};   // the rigged horse's model loads in the background

const LEVEL = 2.5;   // the Water tank's level (environments.mjs)
function tank(actors, { frames = 121, keepSet = false } = {}) {
  clearSetCache();
  const st = Object.create(Stage.prototype);
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set: "water_tank" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract(m) { st.said = m; }, onSelect() {}, _buildLights() {},
    canvas: { addEventListener() {}, removeEventListener() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });
  st.scene.add(st.root); st._buildSet(); if (!keepSet) st._setGroup = undefined; st.live = new LiveEdit(st, liveKinds()); st.setFrame(0);
  return st;
}
const man = (id, y = 0, extra = {}) => ({ id, name: id, kind: "man", height_m: 1.8, position: [extra.x ?? 0, y, extra.z ?? 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const prop = (id, kind, y = 0, extra = {}) => ({ id, name: id, kind, position: [extra.x ?? 0, y, extra.z ?? 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const keyed = (id, kind, keys, extra = {}) => ({ id, name: id, kind, height_m: kind === "man" ? 1.8 : undefined, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0, ...extra });
const wp = (o) => o.getWorldPosition(new THREE.Vector3());
const headY = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return wp(g.userData.joints.head).y; };
const lowest = (g) => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g).min.y; };

// ------------------------------------------------------------------ 1. Drive mode in the tank
// Before: the driven man stood at y 0 on the tank floor and walked there with his head 1 m under the 2.5 m surface
// (personStep stood him on _supportAt, the floor; DriveMode.pose returned before the swim ran), the swim flag stayed on
// while the walk cycle ran, and the kept take swam on playback: what you saw driving was not what you kept.
test("Drive mode in the tank: the driven person swims at the surface live, never walks on the floor, and the kept take swims the same", () => {
  const st = tank([man("m", 0, { x: -2, z: -3 })], { frames: 97 });
  st.drive = new DriveMode(st, liveKinds()); st.select = (id) => { st.selected = id; }; st.previewCamera = () => {};
  const g = st.actorMeshes.get("m");
  assert.ok(st.drive.start("m"));
  const inp = { move: [0, 1], mag: 1, sprint: 0 };
  let lowHead = Infinity, walked = 0, swam = 0;
  for (let i = 0; i < 150; i++) {
    st.drive._sim(inp, {}, 1 / 60);
    st.setFrame(st.frame);
    if (i < 10) continue;   // (the first steps: the live history fills)
    lowHead = Math.min(lowHead, headY(st, "m"));
    if (g.userData.gaitOn) walked++;
    if (g.userData.swimOn) swam++;
  }
  assert.equal(walked, 0, `no walk cycle in the water (${walked} steps walking)`);
  assert.equal(swam, 140, `swimming every step (${swam}/140)`);
  assert.ok(lowHead > LEVEL - 0.25, `the head at the water while driven (lowest ${lowHead.toFixed(2)})`);
  assert.ok(g.position.y > 0.6, `off the tank floor (root y ${g.position.y.toFixed(2)})`);
  const b = st.drive.ctl;
  assert.ok(b.speed <= 2.05, `a swimmer's pace, not a run along the bottom (${b.speed.toFixed(2)} m/s)`);
  // record, keep, play back: the same swim
  st.drive.record(); st.drive.rec.left = 0; st.drive._clock(0.01);
  for (let i = 0; i < 60 * 2; i++) { st.drive._sim({ move: [0, 1], mag: 0.5, sprint: 0 }, {}, 1 / 60); if (st.drive.rec?.phase === "rec") st.drive._recStep(); }
  st.drive.stopRec(); st.drive.keep(); st.drive.stop();
  for (let f = 0; f < 48; f++) {
    st.setFrame(f);
    const p = g.position;
    if (!st._inPool(p.x, p.z)) continue;
    assert.ok(g.userData.swimOn && !g.userData.gaitOn, `kept f${f}: swimming, not walking`);
    assert.ok(headY(st, "m") > LEVEL - 0.25, `kept f${f}: the head at the water (${headY(st, "m").toFixed(2)})`);
  }
});

// ------------------------------------------------------------------ 2. A mounted rider in the tank
// Before: a man on a bicycle in the tank pedalled along the tank floor with his head at 1.66 (the surface at 2.5), and a
// driver stayed in the seat of a flooded car all the way to the bottom (head 1.06): the swim and the water code both
// skipped anyone mounted. Now a rider whose seat goes under lets go and swims (his own Swim mode), from where he was;
// a rider held above the water (a swimming horse) stays on.
test("a rider whose mount goes under in the tank lets go and swims; a horse that swims keeps its rider", () => {
  const ride = (kind, keys, frames) => tank([keyed("h", kind, keys, { key_y: false }), { ...man("r", 0, { x: keys[0][1][0] }), mount_id: "h" }], { frames });
  {   // the bicycle, placed in the tank and ridden across it
    const st = ride("bicycle", [[0, [-4, 0, 0]], [96, [4, 0, 0]]], 97), g = st.actorMeshes.get("r");
    for (let f = 0; f <= 96; f += 4) {
      st.setFrame(f);
      assert.ok(g.userData.swimOn, `bike f${f}: the rider swims`);
      assert.ok(headY(st, "r") > LEVEL - 0.25, `bike f${f}: the rider's head at the water (${headY(st, "r").toFixed(2)})`);
    }
  }
  {   // a car floating, flooding and sinking where it was put: the driver lets go as the seat goes under, and kicks up
    const st = ride("car", [[0, [0, 0, 0]], [96, [0, 0, 0]]], 1441), g = st.actorMeshes.get("r");
    st.setFrame(0);
    assert.ok(!g.userData.swimOn, "f0: in the driver's seat while the car floats");
    let fe = -1;
    for (let f = 0; f <= 1440 && fe < 0; f++) { st.setFrame(f); if (g.userData.swimOn) fe = f; }
    assert.ok(fe > 0, `the driver lets go once the car is under (f${fe})`);
    let prev = null, maxStep = 0;
    for (let f = fe - 5; f <= fe + 90; f++) { st.setFrame(f); const p = g.position.clone(); if (prev) maxStep = Math.max(maxStep, p.distanceTo(prev)); prev = p; }
    assert.ok(maxStep < 0.12, `no pop from the seat into the swim (biggest step ${maxStep.toFixed(3)} m a frame around f${fe})`);
    st.setFrame(1440);
    assert.ok(g.userData.swimOn && headY(st, "r") > LEVEL - 0.25, `f1440: swimming at the surface (head ${headY(st, "r").toFixed(2)}), not sat in the sunk car`);
    // a pure function of the frame
    st.setFrame(900); const a = headY(st, "r"); st.setFrame(200); st.setFrame(900);
    assert.ok(Math.abs(headY(st, "r") - a) < 1e-9, "the same pose at f900 whatever was shown before");
  }
  {   // a horse swims and holds its rider out of the water: he stays on
    const st = ride("horse", [[0, [-4, 0, 0]], [96, [4, 0, 0]]], 97), g = st.actorMeshes.get("r");
    for (const f of [0, 48, 96]) { st.setFrame(f); assert.ok(!g.userData.swimOn && headY(st, "r") > LEVEL, `horse f${f}: still riding, head out`); }
  }
});

// ------------------------------------------------------------------ 3. A person's weight
// Before: a Can't-swim man with mass 1e-6 or 1e9 kg, or any density, sank at exactly the same rate (the person's water
// track never read the Physics panel). Mass (over the body's own volume) or density now sets how fast he goes down.
test("a person's mass or density changes how fast they sink: heavier sinks faster, lighter slower or not at all", () => {
  const run = (physics) => {
    const st = tank([{ ...man("x", 4.5, { key_y: true, swim: "cant" }), ...(physics ? { physics } : {}) }], { frames: 241 });
    const g = st.actorMeshes.get("x"), ys = [];
    for (let f = 0; f <= 240; f++) { st.setFrame(f); ys.push(g.position.y); }
    return ys;
  };
  const base = run(null), light = run({ mass: 1e-6 }), heavy = run({ mass: 1e9 }), stone = run({ density: 2600 }), floaty = run({ density: 900 });
  const landed = (ys) => ys.findIndex((y, f) => f > 30 && y < 0.15);
  assert.ok(landed(base) > 0, `the default man reaches the bottom in the shot (f${landed(base)})`);
  assert.ok(landed(heavy) > 0 && landed(heavy) < landed(base) - 12, `1e9 kg sinks faster (bottom at f${landed(heavy)} vs f${landed(base)})`);
  assert.ok(landed(stone) > 0 && landed(stone) < landed(base) - 12, `density 2600 sinks faster (bottom at f${landed(stone)} vs f${landed(base)})`);
  assert.equal(landed(light), -1, "1e-6 kg never sinks to the bottom");
  assert.ok(Math.min(...floaty.slice(150)) > 1.0, `density 900 floats (lowest root after f150 ${Math.min(...floaty.slice(150)).toFixed(2)})`);
  // a typical mass is the default; junk is ignored
  for (const physics of [{ mass: 75 }, { mass: 0 }, { mass: -50 }, { mass: "abc" }, { mass: Infinity }, { density: NaN }, { density: 0 }]) {
    const ys = run(physics);
    assert.ok(ys.every((y, f) => Math.abs(y - base[f]) < 0.02), `${JSON.stringify(physics)}: the default sink`);
  }
});

// ------------------------------------------------------------------ 4. A boat pinning a swimmer
// Before: a speedboat driven into the corner where a man treads water threw him 3.30 m in one frame (f143) and put his
// head through the 7.8 m inner wall (z 8.31); two boats closing in on him moved him 1.32 m from f0 to f1; a sunk car's
// driver snapped 1.64 m back into it. A swimmer the water moves never goes faster than a strong sprint, and stays inside.
test("a boat or a sinking car never throws a swimmer: bounded per frame, the whole body inside the tank walls", () => {
  const cases = {
    cornerPin: [keyed("s", "speedboat", [[0, [0, 0, 0]], [150, [4.6, 0, 4.6]], [240, [4.6, 0, 4.6]]], { rotation_deg: 45, key_y: false }), keyed("m", "man", [[0, [7.2, 0, 7.2]], [240, [7.2, 0, 7.2]]], { key_y: false })],
    twoBoats: [keyed("s", "speedboat", [[0, [-5, 0, 0]], [120, [-1.3, 0, 0]], [240, [-1.3, 0, 0]]], { key_y: false }), keyed("t", "speedboat", [[0, [5, 0, 0]], [120, [1.3, 0, 0]], [240, [1.3, 0, 0]]], { key_y: false }), keyed("m", "man", [[0, [0, 0, 0]], [240, [0, 0, 0]]], { key_y: false })],
    sunkCar: [keyed("s", "car", [[0, [0, 0, 0]], [96, [0, 0, 0]]], { key_y: false }), { ...man("m", 0), mount_id: "s" }],
  };
  for (const [name, acts] of Object.entries(cases)) {
    const N = name === "sunkCar" ? 721 : 241;
    const st = tank(acts, { frames: N, keepSet: true }), g = st.actorMeshes.get("m"), a = st.state.actors.find((x) => x.id === "m");
    let prev = null, maxStep = 0, at = -1, out = 0, path = 0, pat = -1, last = null;
    for (let f = 0; f < N; f++) {
      st.setFrame(f);
      if (!g.userData.swimOn) { prev = null; last = null; continue; }
      // the swim path (where the water moves him: the plan's own positions) and the posed hips
      const plan = st._swimCache.get(st._letGoAt(a)?.actor || a).plan, q = plan.pos[f];
      if (last) { const d = Math.hypot(q[0] - last[0], q[2] - last[2]); if (d > path) { path = d; pat = f; } }
      last = q;
      const p = wp(g.userData.joints.l_hip);
      if (prev) { const d = Math.hypot(p.x - prev.x, p.z - prev.z); if (d > maxStep) { maxStep = d; at = f; } }
      prev = p;
      g.updateMatrixWorld(true);
      const box = new THREE.Box3();
      g.traverse((o) => { if (o.isMesh && o.visible && !o.material?.transparent && !o.userData.avatar) box.expandByObject(o); });
      if (Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) > 7.8 + 0.02) out++;
    }
    assert.ok(path <= 2 / 24 + 1e-6, `${name}: the swim path never faster than 2 m/s (biggest step ${path.toFixed(3)} m at f${pat})`);
    assert.ok(maxStep < 0.25, `${name}: the hips never thrown (biggest step ${maxStep.toFixed(3)} m at f${at}; lying down at a wall moves them most)`);
    assert.equal(out, 0, `${name}: the body inside the walls (${out} frames through)`);
  }
});

// ------------------------------------------------------------------ 5. Sunk things on the tank floor
// Before: a flooded car went through the tank floor once it sank (lowest point -0.58 to -0.65 m, nose down 0.33 rad on
// the bottom), its driver's root at -0.43; a rock or a cube landing wobbled 4-5 cm through it.
test("a car that floods and sinks rests on the tank floor, not through it; nothing that sinks goes through the floor", () => {
  for (const [kind, y, frames, step] of [["car", 0, 2400, 6], ["car", 4, 2400, 6], ["rock", 4.5, 241, 1], ["cube", 4.5, 241, 1], ["tv", 3, 241, 1]]) {
    const st = tank([prop("x", kind, y, { key_y: true, x: 2 })], { frames }), g = st.actorMeshes.get("x");
    let lo = Infinity, at = -1;
    for (let f = 0; f < frames; f += step) { st.setFrame(f); const l = lowest(g); if (l < lo) { lo = l; at = f; } }
    assert.ok(lo > -0.01, `${kind} keyed at ${y}: never through the floor (lowest ${lo.toFixed(3)} at f${at})`);
    if (kind === "car") { st.setFrame(frames - 1); assert.ok(lowest(g) < 0.05 && Math.abs(g.rotation.x) < 0.05, `${kind}: resting level on the bottom (lowest ${lowest(g).toFixed(3)}, pitch ${g.rotation.x.toFixed(2)})`); }
  }
});
