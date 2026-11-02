// Camera edit (2026-11-02): presets apply as editable rigs with an Adjust panel, car mounts on any car that ride its
// motion, roll and suspension, and "drone" renamed to "aerial" everywhere with aliases for saved scenes.
// web/stage/carmounts.mjs, web/stage/stage.mjs (_camHostFrame, setCarMount), web/presets/adjust.mjs, runner.mjs adjust,
// web/presets/engine.mjs (the aerial moves), web/stage/camrig.mjs (the aerial rigs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { GLTFLoader } from "../../web/vendor/addons/GLTFLoader.mjs";
import { Stage, DEFAULT_SCENE, CAR_SHOTS } from "../../web/stage/stage.mjs";
import { CAR_MOUNTS, MOUNT_GROUPS, mountKey, carDims, onSprungBody, offSprungBody, mountRoll, laggedHeading } from "../../web/stage/carmounts.mjs";
import { RIGS, RIG_LIMITS, applyRig, rigType } from "../../web/stage/camrig.mjs";
import { loadCatalog, validateCatalog, cameraKeys, presetsInText, CAMERA_MOVES, RIG_TYPES, presetId } from "../../web/presets/engine.mjs";
import { ADJUST, adjustControls, adjustedSpec, postAdjust, mountOpts, mountValues } from "../../web/presets/adjust.mjs";
import { PresetRunner } from "../../web/presets/runner.mjs";
import { VOCAB } from "../../web/look/vocab.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};
globalThis.self ??= globalThis;

const near = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < tol);
const K0 = { frame: 0, position: [6, 1.6, -6], target: [0, 1.2, 0], focal_mm: 35 };
// A car that drives up the Z axis and turns hard left: the body rolls on its springs through the turn.
const TURN = [{ frame: 0, position: [0, 0, -16] }, { frame: 40, position: [0, 0, -2] }, { frame: 70, position: [7, 0, 4] }, { frame: 96, position: [16, 0, 5] }];

function headless(kind = "sports_car", keys = TURN) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames: 97, fps: 24 }, environment: { set: "studio", weather: "none" },
      actors: [{ id: "car", name: "Hero car", kind, keys: structuredClone(keys), position: keys[0].position, rotation_deg: 0 },
        { id: "p", name: "Woman", kind: "woman", keys: [{ frame: 0, position: [3, 0, 3] }], position: [3, 0, 3] }],
      shots: [{ id: "a", name: "Camera A", setup: "wide", camera_keys: [{ ...structuredClone(K0) }] }], active_shot: "a" },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st.setFrame(0);
  st._applySun = () => {}; st.setKey = () => {};   // no sun or key view headless: load() (Undo, a saved scene) runs the rest
  return st;
}

/** sports_car.glb at the stage's scale (4.5 m bumper to bumper), in car space. */
async function carModel(file = "sports_car", L = 4.5) {
  const buf = readFileSync(fileURLToPath(new URL(`../../web/stage/models/${file}.glb`, import.meta.url)));
  const g = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej));
  const m = g.scene;
  m.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(m);
  const k = L / (bb.max.z - bb.min.z);
  const root = new THREE.Group();
  root.add(m);
  m.position.set(-(bb.min.x + bb.max.x) / 2 * k, -bb.min.y * k, -(bb.min.z + bb.max.z) / 2 * k);
  m.scale.setScalar(k);
  root.updateMatrixWorld(true);
  return root;
}
function clearance(model, p) {
  const ray = new THREE.Raycaster(), P = new THREE.Vector3(...p), n = 2000;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5));
    ray.set(P, new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th)));
    const h = ray.intersectObject(model, true);
    if (h.length) min = Math.min(min, h[0].distance);
  }
  return min;
}
const inside = (model, p) => {   // a point inside a closed body hits its back faces in every direction
  const ray = new THREE.Raycaster();
  let hits = 0;
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) { ray.set(new THREE.Vector3(...p), new THREE.Vector3(...d)); if (ray.intersectObject(model, true).length) hits++; }
  return hits === 5;
};

// ------------------------------------------------------------------------------------------------ car mounts

test("every mount Mike listed is in the picker, grouped, and each has a placement", () => {
  for (const id of ["hood_forward", "windshield", "bumper", "rear_bumper", "trunk", "roof", "side_door", "side_front_wheel", "side_rear_wheel",
    "front_wheel", "tyre_close", "dash_two_shot", "back_seat", "chase"]) {
    assert.ok(CAR_MOUNTS[id], id);
    assert.ok(CAR_SHOTS[id]?.position, `${id} is a CAR_SHOTS placement (the In-car menu, setCameraFollow)`);
    assert.ok(MOUNT_GROUPS.includes(CAR_MOUNTS[id].group), id);
  }
  const st = headless();
  const opts = st.carMountOptions();
  assert.deepEqual(opts.map((o) => o.id), Object.keys(CAR_MOUNTS), "the picker keeps carmounts.mjs order");
  assert.ok(opts.filter((o) => o.sided).length >= 5, "side mounts flip");
  assert.ok(!opts.some((o) => /drone/i.test(o.label)) && CAR_SHOTS.top_down.label === "Aerial down (overhead)");
});

test("the new outside mounts clear sports_car.glb's bodywork on both sides and sit outside it", async () => {
  const model = await carModel();
  for (const [id, m] of Object.entries(CAR_MOUNTS)) {
    if (!m.at || m.group === "Inside") continue;
    for (const side of m.sided ? [1, -1] : [1]) {
      const k = mountKey(id, { kind: "sports_car" }, { side });
      const c = clearance(model, k.position);
      assert.ok(c > 0.12, `${id} side ${side}: ${c.toFixed(3)} m from the bodywork`);
      assert.ok(!inside(model, k.position), `${id} side ${side} is outside the car`);
    }
  }
});

test("mounts are placed from each car's size: a roof cam clears a police car's light bar and a hatchback's low roof", () => {
  for (const kind of ["sports_car", "police_car", "hatchback", "car"]) {
    const d = carDims({ kind });
    assert.ok(mountKey("roof", { kind }).position[1] > d.H + 0.15, kind);
    assert.ok(mountKey("rear_bumper", { kind }).position[2] < -d.L / 2, `${kind}: behind the rear bumper`);
    assert.ok(Math.abs(mountKey("side_door", { kind }).position[0]) > d.W + 0.2, `${kind}: outside the door`);
  }
  // A taller car moves the mounts with it.
  assert.ok(mountKey("roof", { kind: "car", height_m: 1.9 }).position[1] > mountKey("roof", { kind: "car" }).position[1] + 0.3);
  // Mirroring: the side mount on the right is the left one with x flipped.
  const L = mountKey("side_rear_wheel", { kind: "sports_car" }), R = mountKey("side_rear_wheel", { kind: "sports_car" }, { side: -1 });
  assert.ok(near(R.position, [-L.position[0], L.position[1], L.position[2]]) && near(R.target, [-L.target[0], L.target[1], L.target[2]]));
  // Offsets: out (toward the mount's side), up, forward; turn and tilt round the lens; the lens.
  const o = mountKey("side_door", { kind: "sports_car" }, { side: -1, offset: [0.3, 0.2, -0.5], yaw_deg: 10, tilt_deg: -5, focal_mm: 21 });
  const b = mountKey("side_door", { kind: "sports_car" }, { side: -1 });
  assert.ok(Math.abs(o.position[0] - (b.position[0] - 0.3)) < 1e-6, "out = further from the car on the right too");
  assert.ok(Math.abs(o.position[1] - b.position[1] - 0.2) < 1e-6 && Math.abs(o.position[2] - b.position[2] + 0.5) < 1e-6);
  assert.equal(o.focal_mm, 21);
  assert.ok(o.target[1] < b.target[1], "tilted down");
});

test("the sprung body: points roll and pitch about the pivot and come back exactly; the horizon tilts with the roll", () => {
  const v = [1.2, 0.9, 1.4];
  const w = onSprungBody(v, 0.36, 4, -2);
  assert.ok(!near(w, v, 1e-3));
  assert.ok(near(offSprungBody(w, 0.36, 4, -2), v, 1e-9));
  // A camera looking forward (+Z) on a body rolled +4° about +Z: its up axis leans, and so does the horizon.
  const up = onSprungBody([0, 1.36, 0], 0.36, 4, 0).map((x, i) => x - [0, 0.36, 0][i]);
  const roll = mountRoll([0, 1, 0], [0, 1, 10], up);
  assert.ok(Math.abs(Math.abs(roll) - 4 * Math.PI / 180) < 1e-6, `${roll}`);
  // Looking backward the same body roll turns the horizon the other way.
  assert.ok(Math.abs(mountRoll([0, 1, 0], [0, 1, -10], up) + roll) < 1e-9);
  // Straight down: no roll.
  assert.equal(mountRoll([0, 10, 0], [0, 0, 0], up), 0);
  // A chase car's heading lags the car's.
  const h = (f) => (f < 10 ? 0 : 1);
  assert.ok(laggedHeading(h, 12, 10) > 0 && laggedHeading(h, 12, 10) < 1 && laggedHeading(h, 12, 0) === 1);
});

test("on the stage: a hard mount rides the car's motion, roll and suspension; its keys stay editable in car space", () => {
  const st = headless();
  st.setCameraFollow("car", "side_rear_wheel", { side: -1 });
  const sh = st.activeShot();
  assert.deepEqual(sh.camera_mount, { view: "side_rear_wheel", sprung: true, side: -1 });
  assert.ok(sh.camera_keys[0].position[0] < -0.9, "mounted on the right");
  const car = st.state.actors[0];
  const dyn = st._vehicleDynamics(car);
  const f = dyn.roll.reduce((bi, r, i) => (Math.abs(r) > Math.abs(dyn.roll[bi]) ? i : bi), 0);
  assert.ok(Math.abs(dyn.roll[f]) > 1, `the body rolls in the turn (${dyn.roll[f].toFixed(2)}°)`);
  // World camera = the car's frame of the key on the rolled body.
  const cam = st._cameraAt(f);
  const level = st._actorFrame(car, f)(sh.camera_keys[0].position);
  assert.ok(!near(cam.position, level, 0.005), "the camera moves with the body, not just the car's heading");
  const back = st._camHostFrameInverse(car, f)(cam.position);
  assert.ok(near(back, sh.camera_keys[0].position, 1e-6), "the edit inverse brings it back to the key");
  assert.ok(Math.abs(cam.roll) > 0.005, `the horizon tilts with the body (${cam.roll})`);
  // A shot riding along without a mount (older scenes, "Ride along") is unchanged: heading only, no roll.
  st.setCameraFollow(null);
  st.setCameraFollow("car");
  assert.equal(st.activeShot().camera_mount, undefined);
  const plain = st._cameraAt(f);
  assert.ok(!plain.roll, "no body roll on a plain ride-along");
});

test("on the stage: the chase camera swings round behind a beat late; setCarMount moves, flips and re-lenses the mount", () => {
  const st = headless();
  st.setCameraFollow("car", "chase");
  assert.equal(st.activeShot().camera_mount.sprung, false);
  assert.ok(st.activeShot().camera_mount.lag_s > 0);
  const car = st.state.actors[0];
  // In the turn the chase camera is not straight behind the car: it is still on the old line.
  const f = 62, cam = st._cameraAt(f), p = st._actorPosAt(car, f), yaw = st._headingAt(car, f);
  const behind = [p[0] - Math.sin(yaw), 0, p[2] - Math.cos(yaw)];
  const dirCam = Math.atan2(p[0] - cam.position[0], p[2] - cam.position[2]);
  assert.ok(Math.abs(dirCam - yaw) > 0.05, `lags the turn (${(dirCam - yaw).toFixed(3)} rad)`);
  assert.ok(behind);
  // Adjust it in place: another mount, the other side, an offset and a lens.
  const m = st.setCarMount({ view: "side_door", side: -1, offset: [0.2, 0.1, 0], focal_mm: 18 });
  assert.deepEqual(m, { view: "side_door", sprung: true, side: -1, offset: [0.2, 0.1, 0], focal_mm: 18 });
  const k = st.activeShot().camera_keys[0];
  assert.deepEqual(k, st.carMountKey(car, "side_door", { side: -1, offset: [0.2, 0.1, 0], focal_mm: 18 }));
  assert.ok(k.position[0] < 0 && k.focal_mm === 18);
  // Leaving out a setting keeps it.
  st.setCarMount({ tilt_deg: -8 });
  assert.equal(st.activeShot().camera_mount.side, -1);
  assert.equal(st.activeShot().camera_mount.tilt_deg, -8);
});

// ------------------------------------------------------------------------------------------------ aerial

test("aerial, never drone: the five aerial presets, the rigs, the Look's camera body and every visible word", async () => {
  const cat = await loadCatalog();
  assert.deepEqual(validateCatalog(cat), []);
  for (const [id, label] of [["aerial_down", "Aerial down"], ["aerial_up", "Aerial up"], ["aerial_across", "Aerial across"],
    ["aerial_orbit", "Aerial orbit"], ["aerial_follow", "Aerial follow"]]) {
    assert.equal(cat.byId.get(id)?.label, label);
    assert.equal(cat.byId.get(id).apply.rig, "aerial");
    assert.ok(CAMERA_MOVES.includes(cat.byId.get(id).apply.camera.move));
  }
  for (const p of cat.presets.filter((x) => x.tab === "camera")) {
    assert.ok(!/drone/i.test(`${p.label} ${p.summary}`), `${p.id}: ${p.label}`);
    assert.ok(!/drone/i.test(String(p.apply.rig || "")), p.id);
  }
  assert.ok(!Object.values(RIGS).some((r) => /drone/i.test(r.label)));
  assert.equal(RIGS.aerial.label, "Aerial (gimbal)");
  assert.equal(RIGS.aerial_fpv.label, "Aerial (FPV)");
  assert.ok(RIG_TYPES.includes("aerial") && !RIG_TYPES.includes("drone"));
  const body = VOCAB.camera_bodies.find((o) => o.id === "aerial");
  assert.ok(body && body.label === "Aerial camera" && /aerial shot/.test(body.still) && !/drone/i.test(body.still + body.motion));
  assert.deepEqual(body.old_ids, ["drone"]);
  // The Director's words: "aerial up" finds it, and so does the old "drone reveal".
  assert.deepEqual(presetsInText(cat.presets, "an aerial up over the set").map((x) => x.id), ["aerial_up"]);
  assert.deepEqual(presetsInText(cat.presets, "give me a drone reveal").map((x) => x.id), ["aerial_up"]);
});

test("old saved scenes keep working: drone_reveal, the drone rigs and their shake", async () => {
  const cat = await loadCatalog();
  assert.equal(presetId("drone_reveal"), "aerial_up");
  assert.equal(cat.byId.get("drone_reveal")?.id, "aerial_up", "the catalog answers the old id");
  assert.deepEqual(cameraKeys(K0, { move: "drone_reveal", metres: 8 }, 96), cameraKeys(K0, { move: "aerial_up", metres: 8 }, 96));
  assert.equal(rigType("drone"), "aerial");
  assert.equal(rigType("drone_fpv"), "aerial_fpv");
  assert.equal(RIG_LIMITS.aerial.speed, 20);
  // The same shake as before the rename (same seed per type).
  const path = Array.from({ length: 49 }, (_, f) => ({ position: [f * 0.1, 3, 0], target: [f * 0.1 + 5, 0, 0], focal_mm: 24 }));
  assert.deepEqual(applyRig(path, { type: "drone", seed: 4 }, 24), applyRig(path, { type: "aerial", seed: 4 }, 24));
  // Loading a scene saved with a drone rig and a Drone reveal in its log.
  const st = headless();
  const old = st.toJSON();
  old.shots[0].rig = { type: "drone_fpv", amount: 1, seed: 3 };
  old.preset_log = [{ id: "drone_reveal", tab: "camera", shot: "a" }];
  st.load(old);
  assert.equal(st.activeShot().rig.type, "aerial_fpv");
  assert.equal(st.state.preset_log[0].id, "aerial_up");
  st.setRig("drone");
  assert.equal(st.activeShot().rig.type, "aerial");
});

test("the aerial moves: down looks straight down, across flies over the subject, orbit circles high, follow rides behind", () => {
  const down = cameraKeys(K0, { move: "aerial_down", metres: 12, degrees: 20 }, 96).keys;
  for (const k of down) {
    const flat = Math.hypot(k.target[0] - k.position[0], k.target[2] - k.position[2]);
    assert.ok(Math.atan2(k.position[1] - k.target[1], flat) * 180 / Math.PI > 85, "top-down");
  }
  assert.ok(down[1].position[1] > down[0].position[1], "climbs");
  const across = cameraKeys(K0, { move: "aerial_across", metres: 10 }, 96).keys;
  assert.equal(across.length, 3);
  assert.ok(Math.hypot(across[1].position[0] - K0.target[0], across[1].position[2] - K0.target[2]) < 1e-3, "over the subject at mid-shot");
  const dir = (k) => [k.position[0] - K0.target[0], k.position[2] - K0.target[2]];
  const a0 = dir(across[0]), a2 = dir(across[2]);
  assert.ok(a0[0] * a2[0] + a0[1] * a2[1] < 0, "comes in from one side, goes out the other");
  assert.ok(across.every((k) => k.position[1] === 10));
  const orbit = cameraKeys(K0, { move: "aerial_orbit", metres: 10, degrees: 90 }, 96).keys;
  const rr = orbit.map((k) => Math.hypot(k.position[0] - K0.target[0], k.position[2] - K0.target[2]));
  assert.ok(Math.max(...rr) - Math.min(...rr) < 1e-2 && orbit.every((k) => k.position[1] > 10));
  const follow = cameraKeys(K0, { move: "aerial_follow", metres: 8, distance: 10 }, 96);
  assert.equal(follow.follow, "any");
  assert.deepEqual(follow.keys[0].position, [0, 8, -10]);
});

// ------------------------------------------------------------------------------------------------ Adjust

test("Adjust: every camera preset has controls, and each control's range holds its preset's own number", async () => {
  const cat = await loadCatalog();
  for (const p of cat.presets.filter((x) => x.tab === "camera")) {
    const cs = adjustControls(p.apply.camera);
    assert.ok(cs.length >= 1, `${p.id} has Adjust controls`);
    for (const c of cs) if (c.kind === "spec") assert.ok(c.def >= c.min && c.def <= c.max, `${p.id}.${c.key} = ${c.def} in ${c.min}..${c.max}`);
  }
  for (const [m, list] of Object.entries(ADJUST)) assert.ok(CAMERA_MOVES.includes(m), m);
  assert.deepEqual(adjustedSpec({ move: "aerial_up", metres: 8 }, { metres: 99 }), { move: "aerial_up", metres: 40 }, "clamped");
  assert.deepEqual(mountValues({ view: "roof", offset: [0.1, 0.2, 0.3], side: -1 }), { view: "roof", side: -1, out_m: 0.1, up_m: 0.2, fwd_m: 0.3, yaw_deg: 0, tilt_deg: 0, focal_mm: null });
  assert.deepEqual(mountOpts({ view: "roof", out_m: 0.1, up_m: 0.2, fwd_m: 0.3 }).offset, [0.1, 0.2, 0.3]);
});

test("Adjust post values: angle swings round the subject, height lifts, speed retimes (cut at the end), lens scales", () => {
  const keys = cameraKeys(K0, { move: "push_in", amount: 0.5 }, 96).keys;
  const turned = postAdjust(keys, { angle_deg: 90 }, { k0: K0, last: 96 });
  const d0 = Math.hypot(keys[0].position[0] - K0.target[0], keys[0].position[2] - K0.target[2]);
  assert.ok(Math.abs(Math.hypot(turned[0].position[0] - K0.target[0], turned[0].position[2] - K0.target[2]) - d0) < 1e-3);
  assert.ok(!near(turned[0].position, keys[0].position, 0.5));
  assert.equal(postAdjust(keys, { height_m: 1 }, { last: 96 })[1].position[1], keys[1].position[1] + 1);
  const fast = postAdjust(keys, { speed: 2 }, { last: 96 });
  assert.deepEqual(fast.map((k) => k.frame), [0, 48]);
  const slow = postAdjust(keys, { speed: 0.5 }, { last: 96 });
  assert.deepEqual(slow.map((k) => k.frame), [0, 96]);
  assert.ok(near(slow[1].position, keys[0].position.map((v, i) => v + (keys[1].position[i] - v) * 0.5), 1e-3), "half way when the shot ends");
  const dz = cameraKeys(K0, { move: "dolly_zoom" }, 96).keys;
  const lensed = postAdjust(dz, { lens_mm: 70 }, { last: 96 });
  assert.equal(lensed[0].focal_mm, 70);
  assert.ok(Math.abs(lensed[1].focal_mm / lensed[0].focal_mm - dz[1].focal_mm / dz[0].focal_mm) < 1e-3, "the zoom ratio stays");
  assert.deepEqual(postAdjust(keys, { angle_deg: 90 }, { local: true }), keys, "ride-along keys don't swing");
});

test("Adjust on the stage: re-keys from the same start in one undo step, keeps the rig, and says when keys were hand-edited", async () => {
  const st = headless();
  const catalog = await loadCatalog();
  const runner = new PresetRunner({ stage: st, host: {}, catalog });
  const r = await runner.apply("aerial_up");
  assert.equal(r.ok, true, r.said);
  assert.equal(st.activeShot().rig.type, "aerial");
  const first = structuredClone(st.activeShot().camera_keys);
  let s = runner.adjustState();
  assert.equal(s.id, "aerial_up");
  assert.equal(s.controls.find((c) => c.key === "metres").value, 8);
  assert.equal(s.edited, false);
  st.setRig("jib");   // a rig picked by hand stays through Adjust
  const a = await runner.adjust({ metres: 20 });
  assert.equal(a.ok, true, a.said);
  const keys = st.activeShot().camera_keys;
  assert.ok(near(keys[0].position, first[0].position), "the same starting camera");
  assert.ok(keys[2].position[1] > first[2].position[1] + 10, "higher");
  assert.equal(st.activeShot().rig.type, "jib");
  assert.equal(runner.adjustState().controls.find((c) => c.key === "metres").value, 20);
  // Again from the same start (not from the raised keys), with speed and angle.
  await runner.adjust({ speed: 2, angle_deg: 45 });
  assert.equal(st.activeShot().camera_keys.at(-1).frame, 48);
  assert.equal(runner.adjustState().values.metres, 20, "earlier values stay");
  // One undo step per adjust (the toast's Undo / ⌘Z).
  runner.undo();
  assert.ok(near(st.activeShot().camera_keys[2].position, keys[2].position, 1e-6));
  // A hand edit is noticed.
  st.setCameraKeys(st.activeShot().camera_keys.map((k) => ({ ...k, position: [k.position[0] + 1, k.position[1], k.position[2]] })));
  assert.equal(runner.adjustState().edited, true);
});

test("Adjust a car mount: Car mount, then pick the rear wheel on the right, slide it forward and change the lens", async () => {
  const st = headless();
  const catalog = await loadCatalog();
  const runner = new PresetRunner({ stage: st, host: {}, catalog });
  assert.equal((await runner.apply("car_mount")).ok, true);
  let s = runner.adjustState();
  assert.equal(s.move, "car_mount");
  assert.equal(s.values.view, "windshield");
  assert.ok(s.mounts.length >= 15);
  const r = await runner.adjust({ view: "side_rear_wheel", side: -1, fwd_m: 0.3, focal_mm: 18 });
  assert.equal(r.ok, true, r.said);
  const m = st.activeShot().camera_mount;
  assert.deepEqual(m, { view: "side_rear_wheel", sprung: true, side: -1, offset: [0, 0, 0.3], focal_mm: 18 });
  assert.equal(st.activeShot().camera_follow, "car");
  assert.equal(st.activeShot().camera_keys[0].focal_mm, 18);
  // Undo goes back to the hood mount.
  runner.undo();
  assert.equal(st.activeShot().camera_mount.view, "windshield");
  // A mount picked from the car's own menu (no preset) is adjustable too.
  const st2 = headless();
  const run2 = new PresetRunner({ stage: st2, host: {}, catalog });
  st2.setCameraFollow("car", "roof");
  s = run2.adjustState();
  assert.equal(s?.values.view, "roof");
  assert.equal((await run2.adjust({ up_m: 0.2 })).ok, true);
  assert.ok(Math.abs(st2.activeShot().camera_keys[0].position[1] - mountKey("roof", { kind: "sports_car" }).position[1] - 0.2) < 1e-6);
});

test("the new car presets and aerial follow apply to a car on set", async () => {
  const catalog = await loadCatalog();
  for (const [id, view] of [["rear_bumper_cam", "rear_bumper"], ["side_wheel_cam", "side_front_wheel"], ["roof_cam", "roof"], ["chase_cam", "chase"]]) {
    const st = headless();
    const runner = new PresetRunner({ stage: st, host: {}, catalog });
    const r = await runner.apply(id);
    assert.equal(r.ok, true, r.said);
    assert.equal(st.activeShot().camera_mount.view, view, id);
  }
  const st = headless();
  const runner = new PresetRunner({ stage: st, host: {}, catalog });
  const r = await runner.apply("aerial_follow");
  assert.equal(r.ok, true, r.said);
  assert.equal(st.activeShot().camera_follow, "car");
  assert.equal(st.activeShot().camera_mount.lag_s, 0.6);
  assert.ok(st._cameraAt(60).position[1] > 7);
  // An aerial move off a car mount flies in the world, not with the car.
  await runner.apply("roof_cam");
  const up = await runner.apply("aerial_up");
  assert.equal(up.ok, true);
  assert.equal(st.activeShot().camera_follow, undefined);
});
