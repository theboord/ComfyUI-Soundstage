// Camera rigs that hit their marks (web/stage/camrig.mjs and the Stage's rig cache): a level gimbal drone and a banking
// FPV quad, a jib whose first mark sits on its arm, rigs that pass every key on time, dutch angles that survive the
// rig, a cache that follows lens keys and the ride-along host, and rigs on a moving car that stay on their mount.
// Pure maths on synthetic paths, then a headless Stage (no WebGL) on the demo scenes and the shipped camera presets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { RIGS, RIG_LIMITS, JIB_ARM, applyRig, zeroPhase, pinToMarks, rigMotion } from "../../web/stage/camrig.mjs";
import { policeChase } from "../../web/tryit/scenes.mjs";
import { cameraKeys } from "../../web/presets/engine.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};

function headless(scene) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: structuredClone(scene),
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.state.environment = { ...(st.state.environment || {}), set: "studio" };
  st.changes = 0;
  st.onChange = () => { st.changes++; };
  st.scene.add(st.root);
  try { st._buildSet(); } catch { /* the set is not what these tests look at */ }
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a, b) => Math.hypot(...sub(a, b));
const deg = (r) => (r * 180) / Math.PI;
const yawOf = (c) => Math.atan2(c.target[0] - c.position[0], c.target[2] - c.position[2]);
const unwrap = (a) => { const o = [a[0]]; for (let i = 1; i < a.length; i++) { let d = a[i] - a[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; o.push(o[i - 1] + d); } return o; };
const peakRate = (ys) => Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i]) * 24));
const LAST = 120;

/** The demo crane shot ("Wide crane": 44 m down the street on three keys), on a fresh headless stage. */
function crane() {
  const st = headless(policeChase());
  st.state.active_shot = "crane";
  return st;
}
/** Key a move on the stage, then put it on a rig: {K keyed per frame, R shot camera per frame, keys}. */
function onRig(st, keys, rig, amount = 1) {
  st.setRig("free");
  st.setCameraKeys(keys);
  const K = [], R = [];
  for (let f = 0; f <= LAST; f++) K.push(st._cameraAt(f));
  st.setRig(rig, amount);
  for (let f = 0; f <= LAST; f++) R.push(st._shotCameraAt(f));
  return { K, R, keys: st._camKeys() };
}
const K0 = () => structuredClone(policeChase().shots[0].camera_keys[0]);
const preset = (move, spec, k0 = K0()) => cameraKeys(k0, { move, ...spec }, LAST).keys;
const worstKeyMiss = (keys, R) => Math.max(...keys.filter((k) => k.frame <= LAST).map((k) => dist(R[k.frame].position, k.position)));

// ------------------------------------------------------------------ pure maths

test("zero-phase spring: a cruise and an eased stop pass through on time; a kick is smoothed", () => {
  const ramp = Array.from({ length: 121 }, (_, f) => [f * 0.1, 0, 0]);
  const r = zeroPhase(ramp, 24, 3);
  assert.ok(Math.max(...r.map((p, f) => Math.abs(p[0] - ramp[f][0]))) < 1e-6, "a constant speed never lags");
  const ease = Array.from({ length: 121 }, (_, f) => { const u = f / 120; return 5 * u * u * (3 - 2 * u); });
  const e = zeroPhase(ease, 24, 3);
  assert.ok(Math.abs(e[60] - ease[60]) < 1e-3, "mid-move: on time");
  const kick = Array.from({ length: 121 }, (_, f) => (f >= 60 ? 1 : 0));
  const k = zeroPhase(kick, 24, 3);
  assert.ok(k[59] > 0.05 && k[61] < 0.95, "a step becomes a move");
  assert.equal(zeroPhase([1, 2, 3], 24, Infinity).join(), "1,2,3", "infinitely stiff = untouched");
});

test("pinToMarks: exactly on the base at every mark, untouched far from the marks", () => {
  const base = Array.from({ length: 121 }, () => 0);
  const out = Array.from({ length: 121 }, (_, f) => Math.sin(f / 9));
  const before = out.slice();
  pinToMarks(out, base, [0, 60, 120], 12);
  for (const f of [0, 60, 120]) assert.ok(Math.abs(out[f]) < 1e-12, `frame ${f}`);
  assert.equal(out[30], before[30], "far from a mark nothing moves");
  // Marks 3 frames apart: each bump stays inside its neighbours, so all three still land.
  const o2 = Array.from({ length: 121 }, () => 1);
  pinToMarks(o2, null, [0, 57, 60, 63, 120], 12);
  for (const f of [0, 57, 60, 63, 120]) assert.ok(Math.abs(o2[f]) < 1e-12, `close marks: frame ${f}`);
});

test("Drone (gimbal): the horizon stays level on straight flights along ±X, ±Z and a diagonal, at 1 and 3 m/s", () => {
  for (const dir of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [Math.SQRT1_2, 0, Math.SQRT1_2]]) {
    for (const v of [1, 3]) {
      const path = Array.from({ length: 121 }, (_, f) => {
        const s = (v * f) / 24;
        return { position: [dir[0] * s, 10, dir[2] * s], target: [dir[0] * (s + 20), 0, dir[2] * (s + 20)], focal_mm: 28 };
      });
      for (const seed of [1, 7, 4242]) {
        const out = applyRig(path, { type: "drone", amount: 1, seed }, 24, { keyFrames: [0, 120] });
        const worst = Math.max(...out.map((c) => Math.abs(deg(c.roll))));
        assert.ok(worst < 0.2, `${dir} at ${v} m/s (seed ${seed}): |roll| ${worst.toFixed(3)}°`);
      }
    }
  }
});

test("Drone (FPV): banks atan(v²/(R g)) = 7.3° into a 20 m turn at 5 m/s, rolling no faster than 30°/s", () => {
  const R = 20, v = 5, want = deg(Math.atan((v * v) / (R * 9.81)));
  for (const lookAhead of [false, true]) {
    const path = Array.from({ length: 121 }, (_, f) => {
      const th = (v * f) / 24 / R, th2 = th + 0.3;
      return { position: [R * Math.sin(th), 10, R * Math.cos(th)], target: lookAhead ? [R * Math.sin(th2), 9, R * Math.cos(th2)] : [0, 0, 0], focal_mm: 28 };
    });
    const roll = applyRig(path, { type: "drone_fpv", amount: 1, seed: 3 }, 24, { keyFrames: [0, 120] }).map((c) => deg(c.roll));
    for (let f = 24; f <= 120; f++) assert.ok(Math.abs(roll[f] - want) <= 1.5, `frame ${f}: bank ${roll[f].toFixed(2)}° (want ${want.toFixed(2)}°)`);
    assert.ok(peakRate(roll) <= 30 + 1e-9, `roll rate ${peakRate(roll).toFixed(1)}°/s`);
    // Turning toward +X from +Z is a left turn: the quad rolls left (positive roll = camera's right side up).
    assert.ok(roll[60] > 0);
  }
  // Straight and level flight: no bank.
  const straight = Array.from({ length: 121 }, (_, f) => ({ position: [0, 10, f * 0.3], target: [0, 8, f * 0.3 + 20], focal_mm: 24 }));
  assert.ok(Math.max(...applyRig(straight, { type: "drone_fpv", seed: 2 }, 24).map((c) => Math.abs(deg(c.roll)))) < 1e-6);
  // A snap into a hard turn still rolls at 30°/s at most.
  const snap = Array.from({ length: 121 }, (_, f) => {
    const s = f < 60 ? 0 : (f - 60) / 24, th = (12 * s) / 8;
    return { position: f < 60 ? [0, 10, -12 * (60 - f) / 24] : [8 - 8 * Math.cos(th), 10, 8 * Math.sin(th)], target: [0, 0, 30], focal_mm: 24 };
  });
  const sr = applyRig(snap, { type: "drone_fpv", seed: 5 }, 24).map((c) => deg(c.roll));
  assert.ok(peakRate(sr) <= 30 + 1e-9 && Math.max(...sr) > 20, `a 12 m/s turn on 8 m banks hard but smoothly (${Math.max(...sr).toFixed(1)}°)`);
});

test("rig list: gimbal and FPV drones are both offered, each rig with physical limits", () => {
  assert.equal(RIGS.drone.label, "Drone (gimbal)");
  assert.equal(RIGS.drone_fpv.label, "Drone (FPV)");
  for (const id of Object.keys(RIGS)) if (id !== "free") assert.ok(RIG_LIMITS[id]?.why, id);
  const st = crane();
  assert.ok(st.rigInfo().options.some((o) => o.id === "drone_fpv"));
});

// ------------------------------------------------------------------ the jib

test("jib: Crane up, Crane down, the demo crane and a static shot start and end on their keys, arm 3 to 15 m", () => {
  const eye = { position: [0, 1.6, -5], target: [0, 1.4, 0], focal_mm: 35 };
  const cases = [["crane up", preset("crane_up", { metres: 2.5 })], ["crane down", preset("crane_down", { metres: 2.5 })],
    ["crane up at eye height", preset("crane_up", { metres: 2.5 }, eye)], ["crane down to eye height", preset("crane_down", { metres: 2.5 }, eye)],
    ["the demo crane", policeChase().shots[0].camera_keys], ["a static shot", [K0()]]];
  for (const [name, keys] of cases) {
    const st = crane();
    const { K, R } = onRig(st, keys, "jib");
    assert.ok(dist(R[0].position, K[0].position) <= 0.01, `${name}: frame 0 off by ${dist(R[0].position, K[0].position).toFixed(4)} m`);
    assert.ok(dist(R[LAST].position, K[LAST].position) <= 0.01, `${name}: last frame off by ${dist(R[LAST].position, K[LAST].position).toFixed(4)} m`);
    const info = st.rigInfo();
    assert.ok(info.arm >= JIB_ARM.min && info.arm <= JIB_ARM.max, `${name}: arm ${info.arm}`);
    assert.ok(Math.abs(dist(info.pivot, K[0].position) - info.arm) < 0.01, `${name}: the first mark sits on the arm`);
  }
  // From eye height a crane-up is a pure arc on a short arm with the base staying put: it rises and swings.
  const st = crane();
  const { K, R } = onRig(st, preset("crane_up", { metres: 2.5 }, eye), "jib");
  const info = st.rigInfo();
  assert.ok(info.arm < 5 && info.base_travel < 0.01, JSON.stringify(info));
  for (let f = 0; f <= LAST; f += 10) assert.ok(Math.abs(dist(R[f].position, info.pivot) - info.arm) < 0.03, `frame ${f} on the arm's sphere`);
  assert.ok(Math.max(...R.map((c, f) => dist(c.position, K[f].position))) > 0.1, "the arc leaves the straight keyed line");
});

test("jib: arm and pivot are rig params, kept by the shot and reported by rigInfo", () => {
  const st = crane();
  st.setCameraKeys(preset("crane_up", { metres: 2.5 }));
  st.setRig("jib", 1, { arm: 40 });
  assert.equal(st.activeShot().rig.arm, 15, "the arm is clamped to 15 m");
  assert.equal(st.rigInfo().arm, 15);
  st.setRig("jib", 1, { arm: 6, pivot: [-8, 2, -45] });
  const info = st.rigInfo();
  assert.equal(info.arm, 6);
  assert.ok(info.arm_set && info.pivot_set);
  const R0 = st._shotCameraAt(0), k = st._camKeys()[0];
  assert.ok(dist(R0.position, k.position) < 0.01, "a user pivot still starts on the first key");
  assert.ok(Math.abs(dist(info.pivot, k.position) - 6) < 1e-3);
  st.setRig("jib", 0.5);
  assert.equal(st.activeShot().rig.arm, 6, "changing the amount keeps the arm");
  st.setRig("jib", 1, { arm: null, pivot: null });
  assert.ok(!("arm" in st.activeShot().rig) && !st.rigInfo().arm_set, "null = automatic again");
});

// ------------------------------------------------------------------ hitting the marks

test("rigs hit their marks: Push in on a dolly, Drone reveal on the drone, Steadicam on the demo crane, within 2 cm", () => {
  for (const [name, keys, rig, tol] of [["push in", preset("push_in", { amount: 0.4 }), "dolly"], ["drone reveal", preset("drone_reveal", { metres: 8 }), "drone"],
    ["demo crane", policeChase().shots[0].camera_keys, "steadicam"], ["tracking side", preset("tracking_side", { metres: 4 }), "dolly"],
    ["demo crane", policeChase().shots[0].camera_keys, "drone_fpv"], ["demo crane", policeChase().shots[0].camera_keys, "jib"],
    ["demo crane", policeChase().shots[0].camera_keys, "chapman"], ["demo crane", policeChase().shots[0].camera_keys, "handheld", 0.03]]) {
    const { R, keys: ks } = onRig(crane(), keys, rig);
    const miss = worstKeyMiss(ks, R);
    // Handheld passes its keys on time too, give or take a footstep and the shake (they are its look).
    assert.ok(miss <= (tol ?? 0.02), `${name} on ${rig}: misses a key by ${miss.toFixed(4)} m`);
  }
});

test("the Drone reveal preset stays level (|roll| < 0.2°)", () => {
  const { R } = onRig(crane(), preset("drone_reveal", { metres: 8 }), "drone");
  assert.ok(Math.max(...R.map((c) => Math.abs(deg(c.roll || 0)))) < 0.2);
});

test("Orbit on a dolly: the track is laid through the keys, so the radius stays within 3% on every frame", () => {
  const keys = preset("orbit", { degrees: 60 });
  const T = keys[0].target;
  const { K, R } = onRig(crane(), keys, "dolly");
  const rad = (c) => Math.hypot(c.position[0] - T[0], c.position[2] - T[2]);
  for (let f = 0; f <= LAST; f++) assert.ok(Math.abs(rad(R[f]) / rad(K[f]) - 1) <= 0.03, `frame ${f}: ${rad(R[f]).toFixed(2)} vs ${rad(K[f]).toFixed(2)} m`);
});

test("Push in on a dolly whose keys change height: the height follows the keys (the lock is off)", () => {
  const keys = preset("push_in", { amount: 0.4 });
  assert.ok(Math.abs(keys[0].position[1] - keys[1].position[1]) > 1, "the preset descends toward its subject");
  const { K, R } = onRig(crane(), keys, "dolly");
  assert.ok(Math.abs(R[LAST].position[1] - K[LAST].position[1]) < 0.01);
  // Level keys: the height is locked (only rail rumble of a few mm).
  const level = [{ frame: 0, position: [0, 1.5, -6], target: [0, 1.4, 0], focal_mm: 35 }, { frame: 120, position: [3, 1.5, -3], target: [0, 1.4, 0], focal_mm: 35 }];
  const { R: R2 } = onRig(crane(), level, "dolly");
  assert.ok(Math.max(...R2.map((c) => Math.abs(c.position[1] - 1.5))) < 0.01);
});

test("Whip pan on a tripod keeps its speed: peak yaw rate within 10% of the keys'", () => {
  const keys = preset("whip_pan", { degrees: 75 });
  const { K, R } = onRig(crane(), keys, "tripod");
  const pk = peakRate(unwrap(K.map(yawOf))), pr = peakRate(unwrap(R.map(yawOf)));
  assert.ok(Math.abs(pr / pk - 1) <= 0.1, `keyed ${deg(pk).toFixed(1)}°/s, tripod ${deg(pr).toFixed(1)}°/s`);
  assert.ok(R.every((c) => dist(c.position, R[0].position) < 1e-9), "a tripod's legs stay put");
});

test("Dolly zoom on a dolly: focal rides the same spring, so the subject keeps the size the keys give it", () => {
  const keys = preset("dolly_zoom", { amount: 0.5 });
  const T = keys[0].target;
  const { K, R } = onRig(crane(), keys, "dolly");
  const size = (c) => c.focal_mm / dist(c.position, T);
  for (let f = 0; f <= LAST; f++) assert.ok(Math.abs(size(R[f]) / size(K[f]) - 1) < 0.005, `frame ${f}`);
  assert.ok(Math.abs(size(R[LAST]) / size(K[0]) - 1) < 0.005, "ends at its starting size");
});

test("amount 0 is exactly the keys (identical to Free); the amount scales the shake", () => {
  const keys = policeChase().shots[0].camera_keys;
  for (const rig of Object.keys(RIGS)) {
    if (rig === "free") continue;
    const st = crane();
    const { K, R } = onRig(st, keys, rig, 0);
    for (let f = 0; f <= LAST; f++) assert.deepEqual(R[f], K[f], `${rig} frame ${f}`);
  }
  const shake = (amount) => { const { K, R } = onRig(crane(), [K0()], "handheld", amount); return Math.max(...R.map((c, f) => dist(c.position, K[f].position))); };
  assert.ok(shake(0.5) < shake(1) && shake(1) < shake(2));
});

test("a keyed 12° dutch survives every rig: exact on the supports, ±1° handheld / Steadicam, ±0.2° gimbal drone", () => {
  const tol = { tripod: 1e-9, dolly: 1e-9, chapman: 1e-9, slider: 1e-9, jib: 1e-9, handheld: 1, steadicam: 1, drone: 0.2, free: 1e-9 };
  const st = crane();
  st.setPart("__camera__", "roll_deg", 12);
  for (const [rig, t] of Object.entries(tol)) {
    st.setRig(rig);
    for (let f = 0; f <= LAST; f++) {
      const r = deg(st._shotCameraAt(f).roll || 0);
      assert.ok(Math.abs(r - 12) <= t, `${rig} frame ${f}: ${r.toFixed(3)}°`);
    }
  }
});

// ------------------------------------------------------------------ the cache

test("rig cache: lens keys reach the rig camera; moving the followed car's keys moves the shot camera at once", () => {
  const st = crane();
  st.setRig("dolly");
  st._shotCameraAt(60);   // build the cache
  st.setLensKeys([{ frame: 0, focus_m: 4 }, { frame: 120, focus_m: 12 }]);
  assert.ok(Math.abs(st._shotCameraAt(60).focus_m - st._cameraAt(60).focus_m) < 1e-9 && st._cameraAt(60).focus_m > 4);
  st.setActiveShot("tracking");
  for (const rig of ["handheld", "tripod", "jib"]) {
    st.setRig(rig);
    const before = st._shotCameraAt(60).position;
    const car = st.state.actors.find((a) => a.id === "sports_car");
    for (const k of car.keys) k.position = [k.position[0] + 5, k.position[1], k.position[2]];
    const after = st._shotCameraAt(60).position;
    assert.ok(Math.abs(dist(before, after) - 5) < 1e-6, `${rig}: moved ${dist(before, after).toFixed(4)} m`);
  }
});

test("rig cache: a fractional frame blends the frames either side", () => {
  const st = crane();
  st.setRig("steadicam");
  const a = st._shotCameraAt(30).position, b = st._shotCameraAt(31).position, m = st._shotCameraAt(30.5).position;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(m[i] - (a[i] + b[i]) / 2) < 1e-9);
});

// ------------------------------------------------------------------ ride-along

test("ride-along: every rig on a car at 15 m/s stays on its car-local mark (within 5 cm, shake included)", () => {
  const sc = policeChase();
  const car = sc.actors.find((a) => a.id === "sports_car");
  car.keys = [{ frame: 0, position: [0, 0, -30] }, { frame: 120, position: [0, 0, 45] }];
  for (const sceneVariant of ["straight", "demo"]) {
    const st = headless(sceneVariant === "straight" ? sc : policeChase());
    st.setActiveShot("tracking");
    const host = st.state.actors.find((a) => a.id === "sports_car");
    const mark = st.activeShot().camera_keys[0].position;
    for (const rig of Object.keys(RIGS)) {
      st.setRig(rig);
      let worst = 0;
      for (let f = 0; f <= LAST; f++) worst = Math.max(worst, dist(st._actorFrameInverse(host, f)(st._shotCameraAt(f).position), mark));
      assert.ok(worst <= 0.05, `${sceneVariant} ${rig}: ${worst.toFixed(4)} m off its mount`);
    }
  }
});

test("ride-along: an FPV quad chasing a car banks with the car's real turns", () => {
  const sc = policeChase();
  const car = sc.actors.find((a) => a.id === "sports_car");
  // A 25 m radius bend at ~10 m/s: the chase quad holds its spot by the car and leans into the bend.
  car.keys = Array.from({ length: 7 }, (_, i) => { const th = (i / 6) * 2; return { frame: i * 20, position: [25 - 25 * Math.cos(th), 0, 25 * Math.sin(th)] }; });
  const st = headless(sc);
  st.setActiveShot("tracking");
  st.setRig("drone_fpv");
  const rolls = [];
  for (let f = 0; f <= LAST; f++) rolls.push(deg(st._shotCameraAt(f).roll || 0));
  assert.ok(Math.abs(rolls[60]) > 10, `banks ${rolls[60].toFixed(1)}°`);
  assert.ok(peakRate(rolls) <= 30 + 1e-6);
});

// ------------------------------------------------------------------ seeds, slider, motion

test("setRig keeps a per-shot seed: two handheld shots shake differently, the same shot the same every time", () => {
  const st = headless(policeChase());
  st.setActiveShot("crane");
  st.setRig("handheld");
  const s1 = st.activeShot().rig.seed;
  assert.ok(Number.isFinite(s1));
  st.setRig("steadicam");
  assert.equal(st.activeShot().rig.seed, s1, "changing the rig keeps the seed");
  const a = st._shotCameraAt(40).position;
  st._rigCache = null;
  assert.deepEqual(st._shotCameraAt(40).position, a, "deterministic");
  st.addShot("single");
  st.setCameraKeys(structuredClone(policeChase().shots[0].camera_keys));
  st.setRig("steadicam");
  assert.notEqual(st.activeShot().rig.seed, s1);
  assert.notDeepEqual(st._shotCameraAt(40).position, a, "another shot, another operator");
  st.setRig("steadicam", 1, { seed: s1 });
  assert.deepEqual(st._shotCameraAt(40).position, a, "the same seed on the same keys = the same move");
});

test("slider: one straight rail from the first mark; tripod: never moves; rigMotion reads speed and travel", () => {
  const keys = [{ frame: 0, position: [0, 1.2, 0], target: [0, 1, 5], focal_mm: 35 }, { frame: 60, position: [0.5, 1.5, 0.2], target: [0, 1, 5], focal_mm: 35 },
    { frame: 120, position: [1, 1.2, 0], target: [0, 1, 5], focal_mm: 35 }];
  const st = crane();
  const { R } = onRig(st, keys, "slider");
  for (const c of R) assert.ok(Math.abs(c.position[1] - 1.2) < 0.003 && Math.abs(c.position[2]) < 0.003, "on the rail");
  assert.ok(Math.abs(st.rigInfo().run - 1) < 1e-6);
  const m = rigMotion(Array.from({ length: 121 }, (_, f) => ({ position: [f * 0.1, 0, 0] })), 24);
  assert.ok(Math.abs(m.speed - 2.4) < 1e-6 && Math.abs(m.travel - 12) < 1e-6 && m.accel < 1e-6);
});
