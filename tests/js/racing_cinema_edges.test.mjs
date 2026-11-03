// node --test tests/js/racing_cinema_edges.test.mjs
// Racing cinema, the edges (after tests/js/racing_cinema.test.mjs): every preset points at moves, views, rigs, stunts,
// light setups and Look vocabulary that exist; the Presets hover preview is the move that applying writes; the runner is
// deterministic; no car, several cars, a parked car and a camera straight overhead. The Python half (the same stage
// through the prompt compiler, catalog parity) is tests/test_racing_cinema_edges.py. Headless Stage (no WebGL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, CAR_SHOTS } from "../../web/stage/stage.mjs";
import { STUNTS } from "../../web/stage/stunts.mjs";
import { RIGS } from "../../web/stage/camrig.mjs";
import { loadCatalog, cameraKeys, carPathKeys, CAMERA_MOVES, CAR_PATH_MOVES, RIG_TYPES, STUNT_KINDS, GRADE_KEYS } from "../../web/presets/engine.mjs";
import { PresetRunner } from "../../web/presets/runner.mjs";
import { drawThumb } from "../../web/presets/thumbs.mjs";
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

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const STYLES = read("../../web/look/style_presets.json");
const SETUPS = read("../../web/look/lighting_setups.json").setups;
const RACING_CAMS = ["bumper_cam", "tyre_cam", "arm_car", "long_lens_pan"];
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const finite = (keys) => keys.every((k) => [...k.position, ...k.target, k.focal_mm].every(Number.isFinite));
const car = (id, x, z, name = id) => ({ id, name, kind: "sports_car", height_m: 1.2, keys: [{ frame: 0, position: [x, 0, z] }], position: [x, 0, z], rotation_deg: 0 });

function headless(actors, set = "plaza", cam = [8, 1.2, 0]) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames: 121, fps: 24 }, environment: { set, weather: "none" }, actors: structuredClone(actors),
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

test("every preset and Look style points at moves, views, rigs, stunts, setups and vocabulary that exist", async () => {
  const cat = await loadCatalog();
  const K0 = { frame: 0, position: [6, 1.6, 0], target: [0, 0.6, 0], focal_mm: 35 };
  const PATH = [{ frame: 0, position: [0, 0, -10] }, { frame: 96, position: [0, 0, 14] }];
  for (const p of cat.presets) {
    const a = p.apply || {};
    if (p.tab === "camera") {
      assert.ok(CAMERA_MOVES.includes(a.camera.move), p.id);
      if (a.rig) assert.ok(RIG_TYPES.includes(a.rig) && RIGS[a.rig], `${p.id}: rig ${a.rig} is a stage rig`);
      const plan = cameraKeys(K0, { ...a.camera, path: PATH }, 96);
      assert.ok(plan, `${p.id}: the move makes a plan`);
      if (a.camera.move === "car_mount") {
        assert.ok(CAR_SHOTS[a.camera.view], `${p.id}: view ${a.camera.view} is a stage car shot`);
        assert.equal(plan.carView, a.camera.view);
        assert.equal(a.follow, "vehicle", `${p.id} rides the car`);
      } else {
        assert.ok(plan.keys.length >= 2 || plan.follow, `${p.id}: keys`);
        assert.ok(plan.follow || finite(plan.keys), `${p.id}: finite keys`);
      }
    }
    if (p.tab === "light") assert.ok(SETUPS.some((s) => s.id === a.light.setup), `${p.id}: setup ${a.light.setup}`);
    if (p.tab === "action" && a.stunt) assert.ok(STUNT_KINDS.includes(a.stunt) && STUNTS[a.stunt], `${p.id}: stunt ${a.stunt}`);
    if (p.tab === "look") assert.ok(STYLES.some((s) => s.id === a.look), `${p.id}: style ${a.look}`);
  }
  for (const id of RACING_CAMS) assert.ok(cat.byId.get(id)?.tab === "camera", id);
  // Every style's look fields (and its starred suggestions) are vocabulary ids the Look panel can show.
  const lists = { camera_body: "camera_bodies", lens: "lenses", aperture: "apertures", film_stock: "film_stocks", palette: "palettes",
    genre: "genres", movement: "movements", era: "eras", technique: "techniques", mood: "moods", energy: "energies" };
  for (const s of STYLES) {
    for (const [field, list] of Object.entries(lists)) {
      const v = s.look?.[field];
      if (v) assert.ok(VOCAB[list].some((o) => o.id === v), `${s.id}: ${field} ${v}`);
    }
    if (s.look?.subgenre) {
      const g = VOCAB.genres.find((x) => x.id === s.look.genre);
      assert.ok(g?.subgenres?.some((x) => x.id === s.look.subgenre), `${s.id}: subgenre ${s.look.subgenre} under ${s.look.genre}`);
    }
    for (const [list, ids] of Object.entries(s.suggest || {})) {
      if (list === "focal_range_mm") continue;
      for (const v of ids) assert.ok(VOCAB[list]?.some((o) => o.id === v), `${s.id}: suggests ${list} ${v}`);
    }
    for (const k of Object.keys(s.look?.grade || {})) assert.ok(GRADE_KEYS.includes(k), `${s.id}: grade ${k}`);
  }
});

test("the Presets hover preview is exactly what applying writes, and applying twice changes nothing", async () => {
  const cat = await loadCatalog();
  for (const set of ["plaza", "street_night"]) {
    for (const id of CAR_PATH_MOVES.map((m) => cat.presets.find((p) => p.apply?.camera?.move === m).id)) {
      const st = headless([car("car", 1.6, -14, "Stunt car")], set);
      const runner = new PresetRunner({ stage: st, host: {}, catalog: cat });
      assert.equal((await runner.apply("reverse_jturn")).ok, true);
      const preview = runner.cameraPlan(cat.byId.get(id).apply.camera);   // what web/ui/presets.mjs draws on hover
      const r = await runner.apply(id);
      assert.equal(r.ok, true, r.said);
      const written = st.activeShot().camera_keys;
      assert.deepEqual(written, preview.keys, `${set} ${id}: hover == apply`);
      assert.match(r.said, new RegExp(`${Math.round(preview.metres)} m off its path, ${Math.round(preview.focal)} mm`), "the toast says the keys' distance and lens");
      for (const k of written) assert.equal(k.focal_mm, preview.focal);
      const again = await runner.apply(id);
      // The toast's "moved to the other side" is relative to where the camera was; the distance and lens are not.
      assert.equal(again.said.split(":")[0], r.said.split(":")[0], `${set} ${id}: same distance and lens`);
      assert.deepEqual(st.activeShot().camera_keys, written, `${set} ${id}: re-applying starts from its own first key and lands on the same keys`);
    }
  }
});

test("the runner is deterministic: the same steps on two fresh stages give the same shot, rig, car and toasts", async () => {
  const cat = await loadCatalog();
  const steps = ["reverse_jturn", "long_lens_pan", "arm_car", "tyre_cam", "bumper_cam", "long_lens_pan"];
  const run = async () => {
    const st = headless([car("car", 1.6, -14, "Stunt car")], "street_night");
    const runner = new PresetRunner({ stage: st, host: {}, catalog: cat });
    const said = [];
    const shots = [];
    for (const id of steps) {
      said.push((await runner.apply(id)).said);
      const s = structuredClone(st.activeShot());
      shots.push({ keys: s.camera_keys, rig: s.rig, follow: s.camera_follow ?? null });
    }
    const j = st.toJSON();
    return { said, shots, car: j.actors.find((a) => a.id === "car"), log: (j.preset_log || []).map(({ t, ...e }) => e) };
  };
  const a = await run(), b = await run();
  assert.deepEqual(a, b);
  // And each step did what it says: hard mounts ride the car, the pan is back in world space on a tripod.
  assert.deepEqual(a.shots.map((s) => s.follow), [null, null, null, "car", "car", null]);
  assert.equal(a.shots[1].rig.type, "tripod");
  assert.deepEqual(a.shots[5].keys, a.shots[1].keys, "the pan after riding the car is the pan from before (its base comes from the path)");
});

test("no car on stage: every racing camera preset refuses, says why, and leaves the camera alone", async () => {
  const cat = await loadCatalog();
  for (const id of RACING_CAMS) {
    const st = headless([]);
    const before = structuredClone(st.activeShot());
    const runner = new PresetRunner({ stage: st, host: {}, catalog: cat });
    const r = await runner.apply(id);
    assert.equal(r.ok, false, id);
    assert.match(r.said, /needs a car on set/, id);
    assert.deepEqual(st.activeShot().camera_keys, before.camera_keys, `${id}: keys untouched`);
    assert.equal(st.activeShot().camera_follow, before.camera_follow);
    assert.ok(!runner.cameraPlan(cat.byId.get(id).apply.camera)?.keys?.length, `${id}: no hover preview either`);
  }
  // A boat only: the car-path moves fall back to the boat (it is a vehicle with a path), never throw.
  const st = headless([{ id: "boat", name: "Boat", kind: "speedboat", keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 120, position: [0, 0, 30] }], position: [0, 0, 0] }]);
  const r = await new PresetRunner({ stage: st, host: {}, catalog: cat }).apply("arm_car");
  assert.equal(r.ok, true, r.said);
  assert.ok(finite(st.activeShot().camera_keys));
});

test("several cars, nothing selected: the racing camera presets frame the car doing the stunt, not the parked one", async () => {
  const cat = await loadCatalog();
  for (const id of RACING_CAMS) {
    const st = headless([car("parked", -4, 0, "Parked car"), car("hero", 1.6, -14, "Hero car")]);
    const runner = new PresetRunner({ stage: st, host: {}, catalog: cat });
    st.selected = "hero";
    assert.match((await runner.apply("reverse_jturn")).said, /hero car/);
    st.selected = null;   // the user clicks off the car, then picks a camera preset
    const r = await runner.apply(id);
    assert.equal(r.ok, true, r.said);
    assert.match(r.said, /hero car/, `${id}: ${r.said}`);
    const shot = st.activeShot();
    const hero = st.state.actors.find((a) => a.id === "hero");
    if (CAR_PATH_MOVES.includes(cat.byId.get(id).apply.camera.move)) {
      assert.ok(shot.camera_keys.every((k) => flat(k.target, st._actorPosAt(hero, k.frame)) < 0.05), `${id}: aimed at the hero car all through`);
    } else {
      assert.equal(shot.camera_follow, "hero", `${id} rides the hero car`);
    }
  }
  // With a car selected, that car wins (the parked one can still be framed on purpose).
  const st = headless([car("parked", -4, 0, "Parked car"), car("hero", 1.6, -14, "Hero car")]);
  const runner = new PresetRunner({ stage: st, host: {}, catalog: cat });
  st.selected = "hero";
  await runner.apply("reverse_jturn");
  st.selected = "parked";
  await runner.apply("tyre_cam");
  assert.equal(st.activeShot().camera_follow, "parked");
});

test("degenerate cameras and paths: no target, a parked car, a one-sample path, a camera straight overhead", () => {
  const spec = (move) => ({ move, metres: move === "arm_car" ? 5 : 32, focal_mm: move === "arm_car" ? 28 : 135 });
  for (const move of CAR_PATH_MOVES) {
    // No target: nothing to aim from, so no plan (the runner says "this shot has no camera to move yet").
    assert.equal(cameraKeys({ frame: 0, position: [8, 1.2, 0] }, { move }, 96), null);
    assert.equal(carPathKeys({ frame: 0, position: [8, 1.2, 0] }, spec(move), null, 96), null);
    const parked = [{ frame: 0, position: [2, 0, 3] }, { frame: 96, position: [2, 0, 3] }];
    const cases = {
      parked: [{ frame: 0, position: [8, 1.6, 3], target: [2, 0.6, 3], focal_mm: 35 }, parked],
      one_sample: [{ frame: 0, position: [8, 1.6, 3], target: [2, 0.6, 3], focal_mm: 35 }, [parked[0]]],
      overhead: [{ frame: 0, position: [2, 9, 3], target: [2, 0, 3], focal_mm: 24 }, parked],
      overhead_no_path: [{ frame: 0, position: [2, 9, 3], target: [2, 0.6, 3], focal_mm: 24 }, null],
      bad_samples: [{ frame: 0, position: [8, 1.6, 3], target: [2, 0.6, 3], focal_mm: 35 }, [{ frame: 0, position: [NaN, 0, 0] }, ...parked]],
    };
    for (const [name, [k0, path]] of Object.entries(cases)) {
      const plan = carPathKeys(k0, spec(move), path, 96);
      assert.ok(plan && plan.keys.length >= 2 && finite(plan.keys), `${move} ${name}`);
      assert.equal(plan.keys[plan.keys.length - 1].frame, 96);
      for (const k of plan.keys) {
        const off = flat(k.position, k.target);
        assert.ok(Math.abs(off - plan.metres) < 1e-3, `${move} ${name}: ${off.toFixed(3)} m off the car, wanted ${plan.metres}`);
      }
    }
  }
});

test("thumbnails: the four racing camera presets draw, every coordinate finite, frame after frame", async () => {
  const cat = await loadCatalog();
  const bad = [];
  const ctx = new Proxy({}, {
    get(o, k) {
      if (k in o) return o[k];
      if (k === "createLinearGradient" || k === "createRadialGradient") return () => ({ addColorStop() {} });
      if (k === "measureText") return () => ({ width: 10 });
      return (...args) => { for (const a of args) if (typeof a === "number" && !Number.isFinite(a)) bad.push(String(k)); };
    },
    set(o, k, v) { o[k] = v; return true; },
  });
  for (const id of RACING_CAMS) {
    for (const t of [0, 0.4, 1.3, 2.9, 7.5]) drawThumb(ctx, cat.byId.get(id), t, 168, 96, {});
    assert.deepEqual(bad, [], id);
  }
});
