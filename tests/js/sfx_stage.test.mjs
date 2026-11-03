// Practical effects on the real Stage (headless: scene graph, keys, setFrame, bake and undo; no WebGL). An explosion
// beside a parked car, a crate and a man: the bake throws the crate, rocks or rolls the car and knocks the man down; a
// reset puts every object back byte for byte; a tweak re-bakes from the untouched scene; scrubbing back is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import * as X from "../../web/stage/sfx.mjs";

globalThis.window ||= {};
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0]).includes("car model failed")) _warn(...a); };

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
  return st;
}
const at = (id, name, kind, pos, extra = {}) => ({ id, name, kind, position: pos, keys: [{ frame: 0, position: pos }], rotation_deg: 0, ...extra });
export const yard = () => [
  at("car", "Red car", "sports_car", [-2.4, 0, 0], { rotation_deg: 0 }),
  at("crate", "Crate", "crate", [2.2, 0, 0]),
  at("man", "Man", "man", [0, 0, 4]),
];
const nonRig = (st) => JSON.stringify(st.state.actors.filter((a) => !X.isSfxRig(a)));
const physNoSfx = (st) => { const { sfx, ...p } = st.state.physics || {}; return JSON.stringify(p); };

test("stage sfx: a car explosion throws the crate, moves the car and knocks the man down; the record names it", () => {
  const st = headless(yard());
  const rig = st.addSfxRig("explosion", { position: [0, 0, 0], sfx: { trigger: { type: "time", at: 1 }, power: 1.5 } });
  assert.ok(rig && st.state.physics.sfx, "added and recorded");
  const car = st.state.actors.find((a) => a.id === "car"), crate = st.state.actors.find((a) => a.id === "crate"), man = st.state.actors.find((a) => a.id === "man");
  assert.ok(car.physics?.baked && crate.physics?.baked && man.physics?.baked, "all three baked by the blast");
  const rec = st.state.physics.sfx;
  assert.equal(rec.fires.length, 1);
  assert.equal(rec.fires[0].frame, 24);
  const how = Object.fromEntries(rec.affected.map((x) => [x.id, x.how]));
  assert.equal(how.man, "knocked down");
  assert.ok(["breaks", "thrown"].includes(how.crate), how.crate);
  assert.ok(["rocks", "rocks up", "rolls", "rolls over", "flips"].includes(how.car), how.car);
  // Before the cue, every object is exactly where it was authored.
  for (const a of [car, crate, man]) {
    st.setFrame(10);
    const g = st.actorMeshes.get(a.id);
    assert.deepEqual(g.position.toArray().map((v) => +v.toFixed(4)), a.keys[0].position.map((v) => +(+v).toFixed(4)), `${a.id} untouched before the blast`);
  }
});

test("stage sfx: Reset to before puts every touched object back byte for byte, in one Undo step", () => {
  const st = headless(yard());
  const before = nonRig(st), physBefore = physNoSfx(st);
  const rig = st.addSfxRig("explosion", { position: [0, 0, 0], sfx: { power: 1.5 } });
  assert.notEqual(nonRig(st), before, "the blast changed the scene");
  const nHist = st._hist.length;
  const r = st.sfxReset([rig.id]);
  assert.ok(r.ok, r.message);
  assert.equal(nonRig(st), before, "every object exactly as before the first SFX bake");
  assert.equal(physNoSfx(st), physBefore === "{}" ? "{}" : physBefore);
  assert.equal(st._hist.length, nHist + 1, "one Undo step");
  assert.equal(X.sfxOf(st.state.actors.find((a) => a.id === rig.id)).armed, false, "the rig is kept, disarmed");
  assert.equal(st.state.physics.sfx.fires.length, 0, "no fires left");
  st.setFrame(60);
  assert.ok(!st._sfxFx || st._sfxFx.scorch.size === 0 || [...st._sfxFx.scorch.values()].every((d) => !d.visible), "no scorch left");
  assert.ok(st.undo());
  assert.equal(st.state.physics.sfx.fires.length, 1, "Undo brings the blast back");
});

test("stage sfx: a tweak re-bakes from the untouched scene, never on top of the damaged result", () => {
  const st = headless(yard());
  const rig = st.addSfxRig("explosion", { id: "boom", position: [0, 0, 0], sfx: { power: 1.5 } });
  st.setSfx(rig.id, { power: 0.9 });
  st.simulatePhysics();   // (the stage does this by itself after the edit; here without waiting for the debounce)
  const tweaked = nonRig(st);
  // The same final settings baked once on a fresh scene give exactly the same result.
  const fresh = headless(yard());
  const r2 = fresh.addSfxRig("explosion", { id: "boom", position: [0, 0, 0], sfx: { power: 0.9 } });
  assert.ok(r2);
  assert.equal(tweaked, nonRig(fresh), "tweak-and-rerun = a clean bake of the new settings");
  // And a later cue (2.5 s): before it, every object stands exactly where it was authored.
  st.setSfx(rig.id, { trigger: { type: "time", at: 2.5 }, power: 1.5 });
  st.simulatePhysics();
  assert.ok(st.state.actors.find((a) => a.id === "crate").physics?.baked, "the later blast still throws the crate");
  for (const f of [0, 30, 59]) {
    st.setFrame(f);
    for (const a of yard()) assert.deepEqual(st.actorMeshes.get(a.id).position.toArray().map((v) => +v.toFixed(4)), a.position.map((v) => +v.toFixed(4)), `${a.id} at f ${f}`);
  }
});

test("stage sfx: scrubbing back and forth over a blast shows exactly the same frames", () => {
  const st = headless(yard());
  st.addSfxRig("explosion", { position: [0, 0, 0], sfx: { power: 1.2 } });
  const shot = (f) => { st.setFrame(f); return JSON.stringify([...st.actorMeshes.entries()].map(([id, g]) => [id, g.position.toArray().map((v) => +v.toFixed(6)), g.quaternion.toArray().map((v) => +v.toFixed(6))]))
    + JSON.stringify(st.secondaryFrame) + st._sfxFx.lights.map((l) => l.intensity.toFixed(4)).join(); };
  const a = [5, 30, 60].map(shot), b = [60, 5, 30].map(shot);
  assert.deepEqual([a[0], a[1], a[2]], [b[1], b[2], b[0]]);
  assert.equal(st._sfxFx.lights[0].intensity > 0, true, "the fireball lights the set at frame 30");
  st.setFrame(5);
  assert.equal(st._sfxFx.lights[0].intensity, 0, "no light before the cue");
});

test("stage sfx: K at the playhead records a manual cue as a key (one Undo step)", () => {
  const st = headless(yard());
  const rig = st.addSfxRig("squib", { position: [3, 1.2, -2], sfx: { surface: "wall", trigger: { type: "manual" } } });
  st.setFrame(31);
  const n = st._hist.length;
  const r = st.sfxFire();
  assert.equal(r.id, rig.id);
  const a = st.state.actors.find((x) => x.id === rig.id);
  assert.deepEqual(a.sfx.keys, [31]);
  assert.equal(a.sfx.trigger.type, "manual");
  assert.equal(st._hist.length, n + 1);
  assert.deepEqual(st.state.physics.sfx.fires.map((f) => [f.id, f.frame, f.by]), [[rig.id, 31, "manual"]]);
  st.setFrame(40); st.sfxFire();
  assert.deepEqual(st.state.actors.find((x) => x.id === rig.id).sfx.keys, [31, 40], "a squib can fire again");
  assert.ok(st.undo());
  assert.deepEqual(st.state.actors.find((x) => x.id === rig.id).sfx.keys, [31]);
});

test("stage sfx: A/B swaps the previous run and the new one", () => {
  const st = headless(yard());
  const rig = st.addSfxRig("explosion", { position: [0, 0, 0], sfx: { power: 1.5 } });
  const runB0 = nonRig(st);
  st.setSfx(rig.id, { power: 0.5 });
  st.simulatePhysics();
  const runB = nonRig(st);
  assert.notEqual(runB, runB0);
  assert.equal(st.sfxCompare(), "a");
  assert.equal(st.state.actors.find((a) => a.id === rig.id).sfx.power, 1.5, "A: the previous run");
  assert.equal(st.sfxCompare(), "b");
  assert.equal(nonRig(st), runB, "B: the new run, exactly");
});

test("stage sfx: a body squib on the chest jolts the man back, a hand goes to it, he falls, and the stain stays", () => {
  const st = headless([at("man", "Man", "man", [0, 0, 0])]);
  const rig = st.addSfxRig("body_squib", { target: "man", point: "chest", sfx: { trigger: { type: "time", at: 1 } } });
  assert.equal(rig.sfx.target, "man");
  const g = st.actorMeshes.get("man");
  st.setFrame(20);
  const stand = [g.position.toArray(), g.quaternion.toArray()].flat().map((v) => +v.toFixed(6)).join();
  st.setFrame(30);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(g.quaternion);
  assert.ok(up.z < -0.05, `leans back away from the hit (${up.z.toFixed(2)})`);
  st.setFrame(80);
  const up2 = new THREE.Vector3(0, 1, 0).applyQuaternion(g.quaternion);
  assert.ok(up2.y < 0.3, "on the ground by 3.3 s");
  const w = [...st._sfxFx.wounds.values()].filter((d) => d.visible);
  assert.equal(w.length, 1, "one wound on the shirt");
  assert.ok(w[0].parent === g);
  st.setFrame(20);
  assert.equal([g.position.toArray(), g.quaternion.toArray()].flat().map((v) => +v.toFixed(6)).join(), stand, "scrub back: standing exactly as before");
  assert.ok([...st._sfxFx.wounds.values()].every((d) => !d.visible), "and no wound before the hit");
  const rec = st.state.physics.sfx;
  assert.deepEqual(rec.wounds.map((x) => [x.target, x.point, x.kind]), [["man", "chest", "squib"]]);
});

test("stage sfx: markers are hidden in captures; a breakaway pane is a real prop until it shatters", () => {
  const st = headless(yard());
  const pane = st.addSfxRig("breakaway_glass", { position: [0, 0, 2], sfx: { trigger: { type: "time", at: 1.5 } } });
  const boom = st.addSfxRig("smoke_bomb", { position: [1, 0, 1] });
  st.setFrame(10);
  const pm = st.actorMeshes.get(pane.id).userData.sfxMarker, bm = st.actorMeshes.get(boom.id).userData.sfxMarker;
  let paneMesh = null; pm.traverse((o) => { if (o.userData.sfxPane) paneMesh = o; });
  assert.ok(paneMesh.visible);
  st.setFrame(40);
  assert.equal(paneMesh.visible, false, "shattered at 1.5 s");
  st.setFrame(10);
  assert.ok(paneMesh.visible, "scrub back: whole again");
  // During a capture render the markers are off, the pane stays (in Clay / Color).
  let seen = null;
  const probe = () => { const m = []; bm.traverse((o) => { if (o.isMesh) m.push(o.visible); }); return { marker: m.some(Boolean), pane: paneMesh.visible }; };
  // Stand in for the real render: record what is visible when it runs.
  st._syncShotCamera = () => {}; st._applySplatVisibility = () => {};
  st._renderId = () => { seen = { id: probe() }; };
  st._renderMode("id", true);
  assert.deepEqual(seen.id, { marker: false, pane: false });
  assert.ok(probe().marker, "markers back after the capture");
});


test("stage sfx: K during a Drive-mode take records the cue; keeping the take writes it as the rig's key", async () => {
  const { applyTake, DriveMode } = await import("../../web/stage/drive.mjs");
  const st = headless(yard());
  const rig = st.addSfxRig("explosion", { id: "boom", position: [0, 0, 0], sfx: { trigger: { type: "manual" }, power: 1 } });
  // The live part: DriveMode's K handler pushes an sfx event into the take while recording.
  const dm = Object.create(DriveMode.prototype);
  const said = [];
  Object.assign(dm, { s: st, rec: { phase: "rec", f: 40.6, take: { events: [] } }, say: (m) => said.push(m) });
  dm._sfxFire();
  assert.deepEqual(dm.rec.take.events, [{ type: "sfx", id: "boom", frame: 40 }]);
  assert.match(said[0], /fired at 1\.67 s \(recorded/);
  applyTake(st, { start: 0, fps: 24, tracks: {}, events: dm.rec.take.events });
  assert.deepEqual(st.state.actors.find((a) => a.id === rig.id).sfx.keys, [40]);
  st.simulatePhysics();
  assert.deepEqual(st.state.physics.sfx.fires.map((f) => [f.id, f.frame, f.by]), [["boom", 40, "manual"]]);
});

test("presets: Car explosion, Building blast, Sparks shower and Squib hit rig the set and bake; one Undo takes each back", async () => {
  const { PresetRunner } = await import("../../web/presets/runner.mjs");
  const { loadCatalog } = await import("../../web/presets/engine.mjs");
  const catalog = await loadCatalog();
  const cases = {
    car_explosion: (st) => {
      const how = Object.fromEntries((st.state.physics.sfx.affected || []).map((x) => [x.id, x.how]));
      assert.ok(["rolls", "flips", "rolls over"].includes(how.car), `the car is thrown over (${JSON.stringify(how)})`);
      assert.ok(st.state.physics.sfx.fires.some((f) => f.kind === "fire" && f.by.startsWith("chain:")), "then it burns (a chained fire)");
    },
    building_blast: (st) => {
      const wall = st.state.actors.find((a) => a.kind === "wall");
      assert.ok(wall.physics?.baked, "the breakaway wall's blocks are blown out");
      assert.ok(st.state.actors.filter((a) => a.kind === "crate").every((a) => a.physics?.baked), "the crates are thrown");
    },
    sparks_shower: (st) => { st.setFrame(40); assert.ok(st.secondaryFrame.sparks > 20, "sparks falling at 1.7 s"); },
    squib_hit: (st) => {
      const F = st.state.physics.sfx.fires;
      assert.deepEqual(F.map((f) => f.kind), ["squib", "squib", "squib", "body_squib"]);
      assert.deepEqual(F.slice(1).map((f) => f.by.slice(0, 6)), ["chain:", "chain:", "chain:"]);
      assert.equal(st.state.physics.sfx.wounds[0].point, "chest");
    },
  };
  for (const [id, check] of Object.entries(cases)) {
    const st = headless(id === "car_explosion" ? [at("car", "Red car", "sports_car", [0, 0, 0])] : []);
    const runner = new PresetRunner({ stage: st, host: {}, catalog, setups: [] });
    const before = JSON.stringify(st.state.actors);
    const r = await runner.apply(id);
    assert.ok(r.ok, `${id}: ${r.said}`);
    check(st);
    runner.undo?.();
    if (runner.undo) assert.equal(JSON.stringify(st.state.actors), before, `${id}: one Undo puts the scene back`);
  }
});
