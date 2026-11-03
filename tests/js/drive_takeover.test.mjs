// Drive mode takes over from keys (web/stage/drive.mjs) and auto-corrects kept takes (web/stage/takefix.mjs).
// Mike's bug: a car keyed mid J-turn stayed stuck in its mid-turn pose when he drove it. Driving owns the object while it
// drives (its keys wait, untouched), it starts from the keyed pose settled upright and clear of what the pose overlapped,
// and leaving without a take plays the keys again. A kept take is cleaned (spikes, teleports, top speed, roll, ground)
// and fitted with the fewest keys; a clean take passes through unchanged.
// node --test tests/js/drive_takeover.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as D from "../../web/stage/drive.mjs";
import { correctTrack, limitsFor, reduceKeys, playAt } from "../../web/stage/takefix.mjs";
import { LiveCar, carParams } from "../../web/stage/vehsim.mjs";

globalThis.requestAnimationFrame ||= () => 0;
globalThis.cancelAnimationFrame ||= () => {};
globalThis.addEventListener ||= () => {};
globalThis.removeEventListener ||= () => {};

const DEG = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ± ${tol}`);

/** Linear key playback (position, heading_deg, roll_deg) for the stand-in stage. */
function keyed(keys, f, field) {
  const ks = keys.filter((k) => k[field] != null);
  if (!ks.length) return null;
  if (f <= ks[0].frame) return ks[0][field];
  for (let i = 1; i < ks.length; i++) if (f <= ks[i].frame) {
    const u = (f - ks[i - 1].frame) / (ks[i].frame - ks[i - 1].frame), a = ks[i - 1][field], b = ks[i][field];
    return Array.isArray(a) ? a.map((v, c) => v + (b[c] - v) * u) : a + (b - a) * u;
  }
  return ks[ks.length - 1][field];
}

/** A stage stand-in with what DriveMode uses: meshes with a sprung body pivot, keyed posing, set colliders. */
function fakeStage(actors, colliders = []) {
  const meshes = new Map();
  for (const a of actors) {
    const g = new THREE.Group();
    g.rotation.order = "YXZ";
    if (a.kind === "sports_car") {
      const body = new THREE.Group();
      body.userData.bodyPivot = true;
      g.add(body);
      g.userData.vehicleBody = body;
    }
    meshes.set(a.id, g);
  }
  const st = {
    state: { actors, shot: { frames: 97, fps: 24 }, environment: {} },
    actorMeshes: meshes, frame: 0, selected: null, canvas: { addEventListener() {}, removeEventListener() {}, focus() {} },
    select(id) { this.selected = id; }, previewCamera() {}, onInteract(m) { this.said = m; },
    _lastFrame: () => 96, _actorKeys: (a) => a.keys, _supportAt: () => 0, _setCollidersCached: () => colliders,
    _localBox: (g) => (meshes.get(actors[0].id) === g && actors[0].kind === "sports_car" ? { center: [0, 0.6, 0], half: [0.9, 0.6, 2.2] } : { center: [0, 0.9, 0], half: [0.25, 0.9, 0.2] }),
    _headingAt: (a, f) => (keyed(a.keys, f, "heading_deg") || 0) * DEG,
    onChange() {}, toJSON() { return {}; },
    setFrame(f) {
      this.frame = f;
      for (const a of actors) {
        const g = meshes.get(a.id);
        if (this.drive?.on && this.drive.pose(a, g)) continue;
        g.rotation.set(0, (keyed(a.keys, f, "heading_deg") || 0) * DEG, 0);
        g.position.set(...keyed(a.keys, f, "position"));
        g.userData.vehicleBody?.rotation.set(-(keyed(a.keys, f, "pitch_deg") || 0) * DEG, 0, (keyed(a.keys, f, "roll_deg") || 0) * DEG);
      }
    },
  };
  st.drive = new D.DriveMode(st, { PERSON_KINDS: new Set(["man", "woman", "child"]) });
  return st;
}

/** A J-turn baked into keys: reversing, then the nose swinging round with the body rolled over (as the stunt preset). */
const jturnKeys = () => Array.from({ length: 49 }, (_, i) => {
  const f = i * 2, t = Math.min(1, Math.max(0, (f - 20) / 30));
  return { frame: f, position: [0, 0, -f * 0.25], heading_deg: 180 * t, roll_deg: 7 * Math.sin(Math.PI * t), pitch_deg: -2 * Math.sin(Math.PI * t) };
});

test("takeover: a car keyed mid J-turn is driven from where the keys had it; its keys wait untouched and play again on leaving", () => {
  const car = { id: "car", kind: "sports_car", keys: jturnKeys() };
  const st = fakeStage([car]);
  st.setFrame(36);                                         // mid-stunt: nose half way round, body rolled over
  const g = st.actorMeshes.get("car"), body = g.userData.vehicleBody;
  const yaw0 = g.rotation.y, roll0 = body.rotation.z / DEG, at0 = g.position.clone();
  assert.ok(roll0 > 5, `keyed roll ${roll0}`);
  const keys0 = JSON.stringify(car.keys);
  assert.ok(st.drive.start("car"));
  assert.ok(st.drive.owns("car"), "drive owns the car");
  assert.match(st.said, /Took over from keys: Esc to leave/);
  assert.equal(st.drive.info().note, "Took over from keys: Esc to leave");
  near(st.drive.ctl.car.H, yaw0, 1e-9, "the yaw is kept");
  // The keys no longer pose it: another frame still shows the live car where it took over.
  st.setFrame(80);
  near(g.position.x, at0.x, 1e-6, "x held"); near(g.position.z, at0.z, 1e-6, "z held");
  near(g.rotation.y, yaw0, 1e-6, "heading held");
  assert.equal(g.rotation.x, 0, "upright: no keyed tilt");
  assert.equal(g.position.y, 0, "wheels on the ground");
  // The keyed roll eases out over about 0.3 s (no pop), then the car is level on its springs.
  st.drive._sim({ move: [0, 0], mag: 0 }, {}, 0.1); st.setFrame(80);
  const mid = body.rotation.z / DEG;
  assert.ok(mid > 0.2 && mid < roll0, `easing: ${mid} of ${roll0}`);
  for (let i = 0; i < 3; i++) st.drive._sim({ move: [0, 0], mag: 0 }, {}, 0.1);
  st.setFrame(80);
  near(body.rotation.z / DEG, 0, 0.05, "settled roll"); near(body.rotation.x / DEG, 0, 0.05, "settled pitch");
  // Drive it: W moves it off the keyed path.
  st.drive.down.add("KeyW");
  for (let i = 0; i < 120; i++) st.drive.step(1 / 60);
  assert.ok(Math.hypot(g.position.x - at0.x, g.position.z - at0.z) > 3, "it drives");
  assert.equal(JSON.stringify(car.keys), keys0, "the keys were never changed");
  // Leave without a take: the keys play again exactly as before.
  st.drive.stop();
  assert.equal(st.drive.owns("car"), false);
  assert.equal(JSON.stringify(car.keys), keys0);
  st.setFrame(36);
  near(g.position.z, at0.z, 1e-9, "keyed again"); near(body.rotation.z / DEG, roll0, 1e-9, "keyed roll again");
});

test("takeover: a keyed pose that overlaps a wall is pushed clear, so the car is not pinned there", () => {
  const car = { id: "car", kind: "sports_car", keys: [{ frame: 0, position: [0, 0, 0], heading_deg: 90 }] };
  // A wall whose face (x = 1.9) is 0.3 m inside the car's nose circle (centre 1.3 m ahead, radius 0.9).
  const wall = { id: "wall", pos: [2.4, 1.5, 0], half: [0.5, 1.5, 4], quat: [0, 0, 0, 1] };
  const st = fakeStage([car], [wall]);
  st.setFrame(0);
  st.drive.start("car");
  const c = st.drive.ctl.car;
  assert.ok(c.X < -0.2, `pushed clear of the wall: ${c.X}`);
  // Reverse away from it (the brake held at rest becomes reverse): it moves freely.
  st.drive.down.add("KeyS");
  for (let i = 0; i < 150; i++) st.drive.step(1 / 60);
  assert.ok(c.X < -2, `drove clear: ${c.X}`);
});

test("takeover: a person keyed mid-jump is stood up with feet planted; Pose Studio keys and mocap wait while driven", () => {
  const man = { id: "man", kind: "man", keys: [{ frame: 0, position: [0, 0.8, 0], heading_deg: 30 }], pose_keys: [{ frame: 0, joints: {} }] };
  const st = fakeStage([man]);
  st.setFrame(0);
  const g = st.actorMeshes.get("man");
  g.rotation.x = 0.4;                                      // keyed lean
  st.drive.start("man");
  const b = st.drive.ctl;
  assert.equal(b.y, 0, "feet on the ground"); assert.equal(b.air, false);
  near(b.yaw, 30 * DEG, 1e-9, "heading kept");
  assert.ok(st.drive.owns("man"), "Pose Studio keys and mocap are skipped for this person (stage.mjs asks owns())");
  assert.ok(b.settle && Math.abs(b.settle.tx - 0.4) < 1e-9, "the lean eases out");
  st.drive.stop();
  assert.equal(st.drive.owns("man"), false);
});

// ------------------------------------------------------------------ auto-correct

const carLim = limitsFor({ kind: "car", carp: carParams("sports_car", null, "stunt"), surface: "dry" });
const personLim = limitsFor({ kind: "person", height: 1.8 }, { personSpeed: D.personSpeed });

/** A take the live car really drove: reverse, flick, drive off (a hand-driven J-turn), sampled once per frame. */
function liveJturn() {
  const car = carParams("sports_car", null, "stunt"), c = new LiveCar({ car, surface: "dry", fps: 24, substeps: 50 });
  const st = { gear: "D", steer: 0 }, h = 1 / 72, out = [];
  const inp = (f) => (f < 80 ? { brake: 1 } : f < 100 ? { steer: 1 } : { throttle: 1 });
  for (let f = 0; f < 160; f++) {
    out.push({ f, p: [c.X, 0, c.Z], yaw: c.H, roll: c.roll, pitch: c.pitch, steer: c.ctl.steer });
    for (let k = 0; k < 3; k++) c.step(D.carControls({ throttle: 0, brake: 0, steer: 0, handbrake: 0, ...inp(f) }, c.forward, car, st, h), h);
  }
  return out;
}

test("auto-correct: a take the live car really drove (a J-turn by hand) passes through unchanged", () => {
  const raw = liveJturn();
  const { samples, fixes } = correctTrack(raw, carLim, { fps: 24 });
  assert.deepEqual(fixes, { pops: 0, teleports: 0, speed: 0, yaw: 0, body: 0, ground: 0 });
  assert.deepEqual(samples, raw);
  // And a person walking, jogging and turning as personStep moves them.
  const b = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, height: 1.8 }, walk = [];
  for (let f = 0; f < 120; f++) {
    walk.push({ f, p: [b.x, b.y, b.z], yaw: b.yaw, mode: "foot", air: b.air });
    for (let k = 0; k < 3; k++) D.personStep(b, { move: f < 60 ? [0, 1] : [1, 0.3], mag: 1, sprint: f > 30 ? 1 : 0 }, { camYaw: 0, ground: () => 0 }, 1 / 72);
  }
  const w = correctTrack(walk, personLim, { fps: 24, ground: () => 0 });
  assert.deepEqual(w.fixes, { pops: 0, teleports: 0, speed: 0, yaw: 0, body: 0, ground: 0 });
  assert.deepEqual(w.samples, walk);
});

test("auto-correct: a spike is put back, a teleport is removed, top speed, roll and the ground are held", () => {
  const raw = liveJturn();
  // A one-frame spike (out and straight back), as a glitch in the take.
  const spiked = raw.map((s) => ({ ...s, p: [...s.p] }));
  spiked[50].p[0] += 1.5;
  let r = correctTrack(spiked, carLim, { fps: 24 });
  assert.equal(r.fixes.pops, 1, "one spike");
  near(r.samples[50].p[0], raw[50].p[0], 0.02, "back on the path");
  // A teleport: the car jumps 6 m and drives on from there. Removed; the drive after it keeps its shape.
  const tele = raw.map((s, i) => ({ ...s, p: [s.p[0] + (i >= 120 ? 6 : 0), 0, s.p[2]] }));
  r = correctTrack(tele, carLim, { fps: 24 });
  assert.equal(r.fixes.teleports, 1);
  const step = (S, i) => Math.hypot(S[i].p[0] - S[i - 1].p[0], S[i].p[2] - S[i - 1].p[2]);
  assert.ok(step(r.samples, 120) < step(raw, 121) * 1.5 + 0.05, `no jump left: ${step(r.samples, 120)}`);
  near(step(r.samples, 140), step(raw, 140), 1e-9, "after it, the same drive");
  // Too fast for a person (15 m/s): held to their top speed. Floating 30 cm: planted. A car rolled 25°: settled.
  const run = Array.from({ length: 40 }, (_, f) => ({ f, p: [0, f > 20 ? 0.3 : 0, f * 15 / 24], yaw: 0, mode: "foot" }));
  r = correctTrack(run, personLim, { fps: 24, ground: () => 0 });
  assert.ok(r.fixes.speed > 30, `held to top speed: ${r.fixes.speed}`);
  const v = step(r.samples, 30) * 24;
  near(v, personLim.vmax, 0.01, "top speed");
  assert.equal(r.fixes.ground, 19);
  assert.ok(r.samples.every((s) => s.p[1] === 0), "feet on the ground");
  const rolled = raw.map((s, i) => ({ ...s, roll: i === 70 ? 25 : s.roll }));
  r = correctTrack(rolled, carLim, { fps: 24 });
  assert.equal(r.fixes.body, 1);
  near(r.samples[70].roll, carLim.rollMax, 1e-9, "roll held to what the tyres and springs give");
  assert.match(D.takeReport({ pops: 3, teleports: 0, speed: 0, yaw: 0, body: 1, ground: 0 }, { raw: 1440, keys: 38 }), /^Smoothed 3 spikes, settled roll · 1,440 keys → 38$/);
});

test("key fit: a minute of weaving at 43 km/h with a dead stop: far fewer keys, all playing back within 2 cm and 1°", () => {
  // A minute of driving: weaving at speed, a stop (held), and away again.
  const S = [];
  let x = 0, z = 0, yaw = 0;
  for (let f = 0; f < 1440; f++) {
    const v = f > 600 && f < 700 ? 0 : 12, r = 0.25 * Math.sin(f / 90);
    yaw += r / 24; x += Math.sin(yaw) * v / 24; z += Math.cos(yaw) * v / 24;
    S.push({ f, p: [x, 0, z], yaw });
  }
  const dense = D.pathKeys(S, { smoothing: "none", every: 1 });
  const keys = reduceKeys(dense, { pos: 0.02, ang: 1, keep: new Set([650]) });
  assert.ok(keys.length < 200 && keys.length < dense.length / 7, `${dense.length} keys -> ${keys.length}`);
  assert.ok(keys.some((k) => k.frame === 650), "a sharp event stays a key");
  let worst = 0;
  for (const k of dense) {
    const p = playAt(keys, k.frame, (q) => q.position), h = playAt(keys, k.frame, (q) => [q.heading_deg])[0];
    worst = Math.max(worst, Math.abs(h - k.heading_deg) / 1);
    // Across the path within 2 cm (half a frame early or late along it is allowed, as in the camera's fit).
    const i = dense.indexOf(k), a = dense[Math.max(0, i - 1)].position, b = dense[Math.min(dense.length - 1, i + 1)].position;
    const t = [b[0] - a[0], b[2] - a[2]], L = Math.hypot(...t) || 1, d = [p[0] - k.position[0], p[2] - k.position[2]];
    worst = Math.max(worst, Math.abs(d[0] * t[1] - d[1] * t[0]) / L / 0.02);
  }
  assert.ok(worst <= 1.0001, `within tolerance: ${worst}`);
});
