// node --test tests/js/racing_cinema.test.mjs
// Racing cinema (2026-11-02, Mike: "if that was a wet road and it looks like F1, Ford v Ferrari"): the look card, the
// four car camera presets (bumper cam, over the tyre, arm car, long-lens pan) and the J-turn using them. The arm car and
// the long-lens pan key off the car's whole path in world space, so they never spin with it the way a hard mount does;
// they stay clear of the set's buildings (street_night), keep the path inside the 40 m depth guide at any entry speed,
// and re-applying the J-turn re-aims them unless the camera was edited by hand. Headless Stage (no WebGL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { GLTFLoader } from "../../web/vendor/addons/GLTFLoader.mjs";
import { Stage, DEFAULT_SCENE, CAR_SHOTS } from "../../web/stage/stage.mjs";
import { loadCatalog, validateCatalog, cameraKeys, carPathKeys, presetsInText, CAMERA_MOVES, CAR_PATH_MOVES, PAN_DEPTH_M,
  segmentHitsBox } from "../../web/presets/engine.mjs";
import { PresetRunner } from "../../web/presets/runner.mjs";
import { VOCAB } from "../../web/look/vocab.mjs";

// The car GLBs load from disk (as in stunts.test.mjs), so the stage's own body and wheel rig are the shipping ones.
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

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const STYLES = read("../../web/look/style_presets.json");
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const K0 = { frame: 0, position: [6, 1.6, 0], target: [0, 0.6, 0], focal_mm: 35 };
const PATH = [{ frame: 0, position: [0, 0, -10] }, { frame: 96, position: [0, 0, 14] }];

test("the Racing Cinema look card and its vocabulary", async () => {
  const s = STYLES.find((x) => x.id === "racing_cinema");
  assert.ok(s, "style racing_cinema");
  assert.equal(s.label, "Racing Cinema");
  assert.ok(!/\s-\s|-/.test(s.label), "no hyphen: the browser and the Director make the same match word");
  assert.equal(s.focal_mm, undefined, "no focal_mm: it would key a zoom at the playhead on a shot that has keys");
  const ids = (list) => new Set(list.map((o) => o.id));
  assert.ok(ids(VOCAB.lenses).has(s.look.lens) && s.look.lens === "large_format_anamorphic");
  assert.ok(ids(VOCAB.film_stocks).has(s.look.film_stock));
  assert.ok(ids(VOCAB.palettes).has(s.look.palette));
  const sub = VOCAB.genres.find((g) => g.id === "action").subgenres.find((x) => x.id === s.look.subgenre);
  // Layers the compiler adds only when the shot has them (soundstage/look/compile.py _car_layers).
  assert.ok(sub && sub.car && sub.nocar && sub.pan && sub.surface, "action.motorsport, in layers");
  assert.deepEqual(Object.keys(sub.surface).sort(), ["dirt", "dry", "snow", "wet"]);
  assert.ok(sub.surface.wet.still.includes("spray and mist") && sub.surface.dry.still.includes("heat shimmer"));
  assert.ok(sub.car.still.includes("the wheels a motion-blurred disc") && sub.car.neg.includes("ghosted double image of the car"));
  assert.ok(!/\b(car|spray|tyres?)\b/i.test(sub.nocar.still + sub.nocar.motion), "the car-free words have no car in them");
  assert.ok(!/\b(night|noon|midday|dawn|sunrise|rain|drift\w*|cgi|vfx)\b/i.test(sub.still + sub.motion + sub.car.still + sub.car.motion
    + sub.surface.wet.still + sub.surface.wet.motion + sub.surface.dry.still + sub.surface.dry.motion));
  const words = (o) => `${o.still || ""} ${o.motion || ""}`;
  const said = [sub, sub.car, sub.nocar, ...Object.values(sub.surface), ...Object.values(sub.pan),
    VOCAB.lenses.find((o) => o.id === "large_format_anamorphic"), VOCAB.film_stocks.find((o) => o.id === s.look.film_stock)].map(words).join(" ");
  assert.ok(!/rooster|beading|show LUT|widescreen|expanded to cover/i.test(said), "no game, showroom or crew-jargon words in the prompts");
  const cat = await loadCatalog();
  assert.deepEqual(validateCatalog(cat), []);
  assert.equal(cat.byId.get("racing_cinema").tab, "look");
  assert.deepEqual(cat.byId.get("racing_cinema").words, ["racing cinema"]);
});

test("the four car camera presets: real lenses, heights and mounts", async () => {
  const cat = await loadCatalog();
  const cam = (id) => cat.byId.get(id)?.apply?.camera;
  assert.deepEqual(cam("bumper_cam"), { move: "car_mount", view: "bumper" });
  assert.deepEqual(cam("tyre_cam"), { move: "car_mount", view: "front_wheel" });
  assert.deepEqual(cam("arm_car"), { move: "arm_car", metres: 5, height: 0.8, focal_mm: 28 });
  assert.deepEqual(cam("long_lens_pan"), { move: "long_lens_pan", metres: 32, height: 1.2, focal_mm: 135 });
  assert.equal(cat.byId.get("long_lens_pan").apply.rig, "tripod");
  for (const m of CAR_PATH_MOVES) assert.ok(CAMERA_MOVES.includes(m), m);
  // The hard mounts: low and outside the body.
  assert.ok(CAR_SHOTS.bumper.position[1] < 0.5 && CAR_SHOTS.bumper.target[2] > CAR_SHOTS.bumper.position[2] && CAR_SHOTS.bumper.focal_mm === 18);
  assert.ok(CAR_SHOTS.front_wheel.position[1] < 0.95 && Math.abs(CAR_SHOTS.front_wheel.position[0]) > 0.9);
  assert.ok(CAR_SHOTS.front_wheel.target[2] < CAR_SHOTS.front_wheel.position[2], "looks back at the rear tyre");
  const said = "give the car a J-turn with a long-lens pan in the racing cinema look";
  assert.deepEqual(presetsInText(cat.presets, said).map((x) => x.id), ["reverse_jturn", "long_lens_pan", "racing_cinema"]);
  assert.deepEqual(presetsInText(cat.presets, "make it a crane up at golden hour").map((x) => x.id), ["crane_up", "golden_hour"]);
});

/** sports_car.glb at the stage's scale (library.mjs: 4.5 m long, steer_lock 18): its meshes in car space (+X left, +Z forward). */
async function carModel() {
  const buf = readFileSync(fileURLToPath(new URL("../../web/stage/models/sports_car.glb", import.meta.url)));
  const g = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej));
  const m = g.scene;
  m.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(m);
  const k = 4.5 / (bb.max.z - bb.min.z);
  const root = new THREE.Group();
  root.add(m);
  m.position.set(-(bb.min.x + bb.max.x) / 2 * k, -bb.min.y * k, -(bb.min.z + bb.max.z) / 2 * k);
  m.scale.setScalar(k);
  root.updateMatrixWorld(true);
  return root;
}

/** Nearest bodywork to p (car space), from 4000 evenly spread rays. */
function clearance(model, p) {
  const ray = new THREE.Raycaster(), P = new THREE.Vector3(...p), n = 4000;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5));
    ray.set(P, new THREE.Vector3(r * Math.cos(th), y, r * Math.sin(th)));
    const h = ray.intersectObject(model, true);
    if (h.length) min = Math.min(min, h[0].distance);
  }
  return min;
}

test("the hard mounts clear the bodywork and the steered front tyre (near plane 0.1 m)", async () => {
  const model = await carModel();
  const wheel = new THREE.Box3();
  model.traverse((o) => { if (/FrontLeftWheel/.test(o.name) && o.isMesh) wheel.union(new THREE.Box3().setFromObject(o)); });
  assert.ok(!wheel.isEmpty(), "the front-left wheel");
  const tyreTop = wheel.max.y;
  const p = CAR_SHOTS.front_wheel.position;
  assert.ok(clearance(model, p) > 0.15, `tyre mount ${clearance(model, p).toFixed(3)} m from the bodywork`);
  assert.ok(clearance(model, CAR_SHOTS.bumper.position) > 0.12, "bumper cam clear of the bumper");
  assert.ok(p[1] > tyreTop + 0.1, `above the tyre's top (${tyreTop.toFixed(2)} m): "just above the front wheel" is true`);
  // The tyre at full lock (18 degrees each way) sweeps about its centre: the lens stays out of it.
  const c = wheel.getCenter(new THREE.Vector3()), size = wheel.getSize(new THREE.Vector3());
  const r = size.y / 2, hw = size.x / 2;
  let near = Infinity;
  for (let s = -18; s <= 18; s += 3) {
    const a = s * Math.PI / 180;
    for (let t = 0; t < 360; t += 10) for (const w of [-hw, hw]) {
      const y = c.y + r * Math.sin(t * Math.PI / 180), zl = r * Math.cos(t * Math.PI / 180);
      const q = [c.x + w * Math.cos(a) + zl * Math.sin(a), y, c.z - w * Math.sin(a) + zl * Math.cos(a)];
      near = Math.min(near, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
  }
  assert.ok(near > 0.2, `steered tyre ${near.toFixed(3)} m from the lens`);
});

test("long-lens pan: one fixed base 32 m off the middle of the path, on the camera's side, panning with the car", () => {
  const plan = cameraKeys(K0, { move: "long_lens_pan", metres: 32, height: 1.2, focal_mm: 135, path: PATH }, 96);
  assert.ok(plan.keys.length >= 16);
  const base = plan.keys[0].position;
  for (const k of plan.keys) { assert.deepEqual(k.position, base); assert.equal(k.focal_mm, 135); }
  assert.equal(base[1], 1.2);
  assert.ok(Math.abs(flat(base, [0, 0, 2]) - 32) < 1e-6, "32 m from the middle of the path");
  assert.ok(base[0] > 0, "the side the shot's camera was already on");
  assert.equal(plan.shortened, false);
  const last = plan.keys[plan.keys.length - 1];
  assert.equal(last.frame, 96);
  assert.ok(Math.abs(last.target[2] - 14) < 1e-6 && Math.abs(plan.keys[0].target[2] + 10) < 1e-6, "aimed at the car, start to end");
  assert.ok(cameraKeys(K0, { move: "long_lens_pan" }, 96).keys.length);
  // A long path: the base pulls in until its far end is inside the depth guide, and the lens shortens to match.
  const long = cameraKeys(K0, { move: "long_lens_pan", metres: 32, focal_mm: 135, path: [{ frame: 0, position: [0, 0, -30] }, { frame: 96, position: [0, 0, 30] }] }, 96);
  assert.ok(long.shortened && long.why === "depth" && long.farthest <= PAN_DEPTH_M + 1e-6, `farthest ${long.farthest}`);
  assert.equal(long.focal, Math.round(135 * long.metres / 32));
});

test("car-path moves stay out of the set's boxes: flip to the clear side, or pull in", () => {
  // A wall 20 m off the path on the camera's side: the pan flips to the open side.
  const wall = { min: [18, 0, -40], max: [26, 12, 40] };
  const pan = carPathKeys(K0, { move: "long_lens_pan", metres: 32, focal_mm: 135, blockers: [wall] }, PATH, 96);
  assert.ok(pan.flipped && pan.keys[0].position[0] < 0 && !pan.shortened);
  // Walls both sides (a street): the arm car pulls in to the kerb side that has room.
  const street = [{ min: [6.5, 0, -40], max: [15.5, 12, 40] }, { min: [-15.5, 0, -40], max: [-6.5, 12, 40] }];
  const arm = carPathKeys(K0, { move: "arm_car", metres: 5, height: 0.8, blockers: street }, PATH.map((s) => ({ ...s, position: [2, 0, s.position[2]] })), 96);
  for (const k of arm.keys) for (const b of street) assert.ok(!segmentHitsBox(k.position, k.target, b) && Math.abs(k.position[0]) < 6, `key ${k.frame}`);
  assert.ok(arm.flipped || arm.shortened);
});

test("arm car: paces the car 5 m off its side, 0.8 m up, never spinning with it", () => {
  const spin = [{ frame: 0, position: [0, 0, -10] }, { frame: 40, position: [0, 0, 0] }, { frame: 60, position: [0.4, 0, 0.6] }, { frame: 96, position: [0, 0, -12] }];
  const plan = carPathKeys(K0, { move: "arm_car", metres: 5, height: 0.8, focal_mm: 28 }, spin, 96);
  const off0 = [plan.keys[0].position[0] - plan.keys[0].target[0], plan.keys[0].position[2] - plan.keys[0].target[2]];
  assert.ok(off0[0] > 4, "on the side the shot's camera was already on");
  for (const k of plan.keys) {
    const car = [k.target[0], 0, k.target[2]];
    assert.ok(Math.abs(flat(k.position, car) - 5) < 1e-3, `5 m off at ${k.frame}`);
    assert.ok(Math.abs(k.position[0] - car[0] - off0[0]) < 1e-3 && Math.abs(k.position[2] - car[2] - off0[1]) < 1e-3,
      "the same world offset all through the spin: it never swings round with the car");
    assert.equal(k.position[1], 0.8);
    assert.equal(k.focal_mm, 28);
  }
});

function headless(set = "studio", cam = [8, 1.2, 0], frames = 121) {
  const st = Object.create(Stage.prototype);
  const keys = [{ frame: 0, position: [1.6, 0, -14] }];
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, environment: { set, weather: "none" },
      actors: [{ id: "car", name: "Stunt car", kind: "sports_car", height_m: 1.2, keys, position: keys[0].position, rotation_deg: 0 }],
      shots: [{ id: "a", name: "Camera A", setup: "wide", camera_keys: [{ frame: 0, position: cam, target: [1.6, 0.7, -14], focal_mm: 85 }] }],
      active_shot: "a" },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st.setFrame(0);
  return st;
}

test("J-turn + long-lens pan on the real stage: the pan holds the car through the stunt, and re-aims when it changes", async () => {
  const st = headless();
  const catalog = await loadCatalog();
  const runner = new PresetRunner({ stage: st, host: {}, catalog });
  const car = () => st.state.actors.find((a) => a.id === "car");
  const jt = await runner.apply("reverse_jturn");
  assert.equal(jt.ok, true, jt.said);
  assert.equal(car().stunt_sim.surface, "wet", "the J-turn's Road defaults to Wet: spray, and a wet-down road in the words");
  const pan = await runner.apply("long_lens_pan");
  assert.equal(pan.ok, true, pan.said);
  const shot = st.activeShot();
  assert.equal(shot.rig?.type, "tripod");
  const last = st._lastFrame();
  const aimed = (keys) => keys.every((k) => flat(k.target, st._actorPosAt(car(), k.frame)) < 0.05);
  const farthest = () => Math.max(...st.activeShot().camera_keys.map((k) => flat(k.position, st._actorPosAt(car(), k.frame))));
  assert.ok(aimed(shot.camera_keys), "every key aims at the car where it is at that frame");
  assert.equal(new Set(shot.camera_keys.map((k) => k.position.join())).size, 1, "a locked-off base");
  assert.equal(shot.camera_keys[shot.camera_keys.length - 1].frame, last);
  assert.ok(farthest() > 30 && farthest() <= PAN_DEPTH_M + 0.05, `inside the 40 m depth guide (farthest ${farthest().toFixed(1)} m)`);
  // Change the stunt (faster entry): the path moves, and re-applying the J-turn re-aims the pan at the new one, pulled
  // in so the longer path still stays inside the depth guide.
  st.applyStunt("car", "reverse_jturn", { entry_kmh: 70 });
  assert.ok(!aimed(st.activeShot().camera_keys), "stale after the path changed");
  const again = await runner.apply("reverse_jturn");
  assert.match(again.said, /long-lens pan now follows the new path/);
  assert.ok(aimed(st.activeShot().camera_keys));
  // At 70 km/h the J-turn covers about 84 m of road: no locked-off base holds all of it inside 40 m. It pulls in (the
  // lens shortening with it) to the fewest keys past the guide, and says so (before: 9 of 21 keys past 40 m, 52.8 m).
  const past = () => st.activeShot().camera_keys.filter((k) => flat(k.position, st._actorPosAt(car(), k.frame)) > 40).length;
  assert.ok(past() <= 4 && farthest() < 46, `70 km/h: ${past()} keys past 40 m, farthest ${farthest().toFixed(1)} m`);
  assert.match(again.said, /pulled in from 32 m to \d+ m \(\d+ mm\)/);
  assert.match(again.said, /keys still put the car past the stage's 40 m depth guide/);
  // At 50 km/h the whole path fits: every key inside the guide.
  st.applyStunt("car", "reverse_jturn", { entry_kmh: 50 });
  const fifty = await runner.apply("reverse_jturn");
  assert.match(fifty.said, /long-lens pan now follows the new path/);
  assert.ok(farthest() <= PAN_DEPTH_M + 0.05, `50 km/h: farthest ${farthest().toFixed(1)} m`);
  // Edit the camera by hand: the next J-turn keeps it and says so.
  const edited = st.activeShot().camera_keys.map((k) => ({ ...k, position: [k.position[0] - 3, k.position[1], k.position[2]] }));
  st.setCameraKeys(edited);
  const kept = await runner.apply("reverse_jturn");
  assert.match(kept.said, /your edited camera was kept/);
  assert.deepEqual(st.activeShot().camera_keys.map((k) => k.position), edited.map((k) => k.position));
  // The tyre cam rides the car (a hard mount): the shot follows it with the front_wheel placement.
  const tyre = await runner.apply("tyre_cam");
  assert.equal(tyre.ok, true, tyre.said);
  assert.equal(st.activeShot().camera_follow, "car");
  assert.deepEqual(st.activeShot().camera_keys[0].position, CAR_SHOTS.front_wheel.position);
  // And back off the car to the arm car: world keys again, 5 m off the path.
  const arm = await runner.apply("arm_car");
  assert.equal(arm.ok, true, arm.said);
  assert.equal(st.activeShot().camera_follow, undefined);
  for (const k of st.activeShot().camera_keys) assert.ok(Math.abs(flat(k.position, st._actorPosAt(car(), k.frame)) - 5) < 0.05);
});

test("City street (street_night): the pan and the arm car never sit in or look through a facade, and say what they gave up", async () => {
  const catalog = await loadCatalog();
  for (const cam of [[5, 1.2, 40], [-4, 1.6, 0], [8, 1.2, 0]]) {
    for (const move of ["long_lens_pan", "arm_car"]) {
      const st = headless("street_night", cam);
      const runner = new PresetRunner({ stage: st, host: {}, catalog });
      assert.equal((await runner.apply("reverse_jturn")).ok, true);
      const r = await runner.apply(move);
      assert.equal(r.ok, true, r.said);
      st.root.updateMatrixWorld(true);
      const meshes = [];
      st._setGroup.traverse((o) => { if (o.isMesh && o.geometry?.type === "BoxGeometry") meshes.push(o); });
      assert.ok(meshes.length > 5, "the street's boxes");
      const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
      const ray = new THREE.Raycaster();
      const keys = st.activeShot().camera_keys;
      for (const k of keys) {
        const p = new THREE.Vector3(...k.position), t = new THREE.Vector3(...k.target);
        assert.ok(!boxes.some((b) => b.containsPoint(p)), `${move} from ${cam}: key ${k.frame} inside a facade`);
        const d = t.clone().sub(p), n = d.length();
        ray.set(p, d.normalize());
        ray.far = n - 1.5;
        assert.equal(ray.intersectObjects(meshes, false).length, 0, `${move} from ${cam}: key ${k.frame} looks through the set`);
      }
      if (move === "long_lens_pan") assert.match(r.said, /Note: .*(other side|pulled in|left room)/, r.said);
    }
  }
});
