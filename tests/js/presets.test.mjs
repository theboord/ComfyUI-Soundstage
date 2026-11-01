// node --test tests/js/presets.test.mjs
// Milestone 17, the Presets window: the catalog's schema, the keys / settings each preset writes, one undo step per
// apply (stage + look + cut), user presets save / load / export, GPU recipes that ask first, the Director's tool.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadCatalog, buildCatalog, validateCatalog, cameraKeys, lightingPlan, editStyleCut, crateStack, throwKeys, driveKeys,
  searchPresets, presetsInText, userPresetFrom, userCameraKeys, parseUserPresets, userPresetsFile, CAMERA_MOVES, TAB_IDS } from "../../web/presets/engine.mjs";
import { PresetRunner, RUNNERS, presetExecutor, installDirectorTool } from "../../web/presets/runner.mjs";
import { drawThumb, projector, camAt } from "../../web/presets/thumbs.mjs";
import { SHORTCUTS, allCombos } from "../../web/ui/shortcuts.mjs";

const clone = (o) => JSON.parse(JSON.stringify(o));
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const SETUPS = read("../../web/look/lighting_setups.json").setups;
const STYLES = read("../../web/look/style_presets.json");
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const K0 = { frame: 0, position: [0, 1.6, -6], target: [0, 1.2, 0], focal_mm: 35 };
const SCENE = {
  camera: { position: [0, 1.6, -6], target: [0, 1.2, 0], focal_mm: 35 },
  shot: { frames: 97, fps: 24 },
  lighting: { mode: "time", hour: 12, preset: "midday", lights: [] },
  environment: { set: "street_night", weather: "rain" },
  actors: [
    { id: "mara", name: "Mara", kind: "woman", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0, mount_id: "sports_car" },
    { id: "cole", name: "Deputy Cole", kind: "man", position: [3, 0, 2], keys: [{ frame: 0, position: [3, 0, 2] }], rotation_deg: 90 },
    { id: "sports_car", name: "Sports car", kind: "sports_car", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 },
    { id: "horse_1", name: "Horse", kind: "horse", position: [-4, 0, 3], keys: [{ frame: 0, position: [-4, 0, 3] }], rotation_deg: 0 },
  ],
  shots: [{ id: "wide", name: "Wide", setup: "wide", camera_keys: [clone(K0)] }, { id: "tracking", name: "Tracking", setup: "single", camera_keys: [{ ...clone(K0), position: [4, 1.5, -2] }] }],
  active_shot: "wide",
};

/** Just enough of web/stage/stage.mjs for the runner: the calls it makes, mutating .state, with the real history rules. */
class FakeStage {
  constructor(scene) {
    this.state = clone(scene); this.frame = 0; this.selected = null; this.calls = [];
    this.onChange = () => { if (!this._muteRecord) this._record(); };
    this._hist = [JSON.stringify(this.state)]; this._redo = [];
  }
  _record() { const s = JSON.stringify(this.state); this._redo = []; if (this._hist[this._hist.length - 1] !== s) this._hist.push(s); }
  undo() { if (this._hist.length < 2) return false; this._redo.push(this._hist.pop()); this.state = JSON.parse(this._hist[this._hist.length - 1]); return true; }
  redo() { if (!this._redo.length) return false; const s = this._redo.pop(); this._hist.push(s); this.state = JSON.parse(s); return true; }
  toJSON() { return clone(this.state); }
  load(s) { this.state = clone(s); }
  setFrame(f) { this.frame = f; }
  select(id) { this.selected = id; }
  _lastFrame() { return (this.state.shot?.frames || 97) - 1; }
  activeShot() { return this.state.shots.find((s) => s.id === this.state.active_shot) || this.state.shots[0]; }
  setActiveShot(id) { this.state.active_shot = id; this.onChange(); }
  setCameraKeys(keys) { this.activeShot().camera_keys = clone(keys); this.onChange(); }
  setRig(type) { this.activeShot().rig = { type, amount: 1 }; this.onChange(); }
  setCameraFollow(id, preset) {
    const sh = this.activeShot();
    if (!id) delete sh.camera_follow; else { sh.camera_follow = id; if (preset) sh.camera_keys = [{ frame: 0, position: [0, 1.22, 2.45], target: [0, 1.05, 0], focal_mm: 30 }]; }
    this.calls.push(["follow", id, preset]); this.onChange();
  }
  applyTimePreset(k) { this.state.lighting = { ...this.state.lighting, mode: "time", preset: k }; this.onChange(); }
  applyLightingSetup(s) { this.state.lighting.lights = s.lights.map((l, i) => ({ id: `l${i}`, type: l.type, from_setup: s.id })); this.state.lighting.setup = s.id; this.state.lighting.setup_prompt = s.prompt_words; this.onChange(); return s.lights.length; }
  setEnvironment(p) { Object.assign(this.state.environment, p); this.onChange(); }
  applyStunt(id, kind) { const a = this.state.actors.find((x) => x.id === id); if (kind === "none") { delete a.stunt; return "none"; } a.stunt = kind; a.keys = [{ frame: 0, position: a.position, heading_deg: 0 }, { frame: 96, position: [0, 0, 12], heading_deg: 180 }]; this.onChange(); return kind; }
  setPhysics(ids, patch) { for (const a of this.state.actors) if (ids.includes(a.id)) a.physics = { ...(a.physics || {}), ...patch }; this.onChange(); return ids.length; }
  simulatePhysics() { let n = 0; for (const a of this.state.actors) if (a.physics?.mode === "dynamic") { a.physics.baked = true; a.keys = [...a.keys, { frame: 40, position: [a.keys[0].position[0] + 1, 0, a.keys[0].position[2]] }]; n++; } this.onChange(); return { ok: true, message: `Simulated ${n} objects.` }; }
  mount(r, hId, pose, at, seat) { const a = this.state.actors.find((x) => x.id === r); a.mount_id = hId; if (at) a.mount_at = at; if (seat != null) a.seat = seat; this.onChange(); return true; }
  addShot(setup) { const id = `shot_${this.state.shots.length + 1}`; this.state.shots.push({ id, name: "Wide 2", setup, camera_keys: [clone(this.activeShot().camera_keys[0])] }); this.state.active_shot = id; this.onChange(); return "Wide 2"; }
}

function makeHost() {
  const look = { state: { style: null, grade: { warmth: 0, contrast: 0, saturation: 0, grain: 0, halation: 0, vignette: 0 } } };
  const cut = { saved: { cut: [{ shot_id: "wide", in: 0, out: 96 }, { shot_id: "tracking", in: 0, out: 72 }, { shot_id: "wide", in: 10, out: 90 }] } };
  const renders = [];
  return {
    renders, lookState: look, cutState: cut,
    look: { get: () => clone(look.state), set: (p) => Object.assign(look.state, clone(p)), load: (x) => { look.state = clone(x); },
      applyStyle: (id) => { const s = STYLES.find((x) => x.id === id); look.state = { ...look.state, style: id, grade: { ...look.state.grade, ...s.look.grade } }; },
      hasStyle: (id) => STYLES.some((x) => x.id === id) },
    cut: { load: () => clone(cut.saved), save: (v) => { cut.saved = clone(v); }, add: () => {}, panel: () => null },
    shotsInOrder: () => [{ id: "wide", name: "Wide" }, { id: "tracking", name: "Tracking" }],
    pipeline: { selectShot: (id) => renders.push(["select", id]), _render: async (step) => { renders.push(["render", step]); }, ltx: { setPreset: (q) => renders.push(["quality", q]) },
      go: (s) => renders.push(["go", s]), ripple: { setMode: (m) => renders.push(["ripple", m]) } },
    wholeFrame: (p) => renders.push(["whole", p]),
    importVideo: () => renders.push(["import"]),
  };
}

async function setup(scene = SCENE, hostPatch = {}) {
  const catalog = await loadCatalog();
  const stage = new FakeStage(scene);
  const host = { ...makeHost(), ...hostPatch };
  const runner = new PresetRunner({ stage, host, catalog, setups: SETUPS });
  return { stage, host, runner, catalog };
}

// ------------------------------------------------------------------------------------------------ schema

test("catalog: every tab, unique ids, valid apply blocks, the asked-for presets", async () => {
  const cat = await loadCatalog();
  assert.deepEqual(validateCatalog(cat), []);
  assert.deepEqual(cat.tabs.map((t) => t.id), TAB_IDS);
  const by = (tab) => cat.presets.filter((p) => p.tab === tab).map((p) => p.id);
  for (const id of ["push_in", "pull_out", "orbit", "crane_up", "crane_down", "dolly_zoom", "whip_pan", "handheld_follow", "drone_reveal", "tracking_side", "car_mount"]) assert.ok(by("camera").includes(id), id);
  for (const id of ["golden_hour", "blue_hour", "night_street", "noir_hard_key", "neon_night", "overcast", "candle_firelight", "studio_three_point"]) assert.ok(by("light").includes(id), id);
  for (const id of ["reverse_jturn", "donut", "handbrake_180", "crate_crash", "drop", "throw", "climb_mount"]) assert.ok(by("action").includes(id), id);
  for (const id of ["trailer_cut", "music_video", "dialogue_coverage", "social_vertical"]) assert.ok(by("edit").includes(id), id);
  for (const id of ["video_to_3d_reshoot", "ripple_wardrobe", "draft_all_shots", "hollywood_final"]) assert.ok(by("recipe").includes(id), id);
  assert.equal(by("look").length, STYLES.length, "every film style is a Looks card");
  // Light presets name real setups; the stage can apply every time preset.
  for (const p of cat.presets.filter((x) => x.tab === "light")) assert.ok(SETUPS.some((s) => s.id === p.apply.light.setup), p.id);
});

test("validateCatalog catches the mistakes", () => {
  const base = read("../../web/presets/presets.json");
  const bad = clone(base);
  bad.presets.push({ ...bad.presets[0] });                                  // duplicate id
  bad.presets.push({ id: "Bad Id", tab: "camera", label: "x", summary: "x", apply: { camera: { move: "zoom" } } });
  bad.presets.push({ id: "r", tab: "recipe", label: "r", summary: "r", apply: { recipe: ["render_final"] } });   // GPU without the flag
  const errs = validateCatalog(buildCatalog(bad, []));
  assert.ok(errs.some((e) => /duplicate/.test(e)));
  assert.ok(errs.some((e) => /bad id/.test(e)));
  assert.ok(errs.some((e) => /camera.move zoom/.test(e)));
  assert.ok(errs.some((e) => /gpu flag/.test(e)));
});

test("search and free text find presets", async () => {
  const cat = await loadCatalog();
  assert.equal(searchPresets(cat.presets, "crane")[0].id, "crane_up");
  assert.equal(searchPresets(cat.presets, "golden")[0].id, "golden_hour");
  assert.ok(searchPresets(cat.presets, "j-turn").some((p) => p.id === "reverse_jturn"));
  assert.deepEqual(presetsInText(cat.presets, "make it a crane up at golden hour").map((x) => x.id), ["crane_up", "golden_hour"]);
  assert.deepEqual(presetsInText(cat.presets, "film noir look with a dolly zoom").map((x) => x.id), ["film_noir", "dolly_zoom"]);
});

// ------------------------------------------------------------------------------------------------ camera keys

test("every camera move writes sensible keys", () => {
  for (const move of CAMERA_MOVES) assert.ok(cameraKeys(K0, { move }, 96), move);
  const push = cameraKeys(K0, { move: "push_in", amount: 0.4 }, 96).keys;
  assert.equal(push.length, 2); assert.equal(push[1].frame, 96);
  assert.ok(dist(push[1].position, K0.target) < dist(K0.position, K0.target) - 2);
  const pull = cameraKeys(K0, { move: "pull_out" }, 96).keys;
  assert.ok(dist(pull[1].position, K0.target) > dist(K0.position, K0.target) + 1);
  const orbit = cameraKeys(K0, { move: "orbit", degrees: 60 }, 96).keys;
  assert.equal(orbit.length, 5);
  for (const k of orbit) assert.ok(Math.abs(Math.hypot(k.position[0] - K0.target[0], k.position[2] - K0.target[2]) - 6) < 0.01, "same distance");
  const up = cameraKeys(K0, { move: "crane_up", metres: 2.5 }, 96).keys;
  assert.ok(Math.abs(up[1].position[1] - up[0].position[1] - 2.5) < 1e-6);
  const down = cameraKeys(K0, { move: "crane_down", metres: 2.5 }, 96).keys;
  assert.ok(down[0].position[1] > down[1].position[1]);
  const dz = cameraKeys(K0, { move: "dolly_zoom", amount: 0.5 }, 96).keys;
  const r0 = dz[0].focal_mm / dist(dz[0].position, K0.target), r1 = dz[1].focal_mm / dist(dz[1].position, K0.target);
  assert.ok(Math.abs(r0 - r1) / r0 < 0.03, "subject holds its size (focal / distance constant)");
  assert.ok(dz[1].focal_mm < dz[0].focal_mm, "the lens widens as the camera dollies in");
  const whip = cameraKeys(K0, { move: "whip_pan", degrees: 75 }, 96).keys;
  assert.ok(whip.every((k) => dist(k.position, K0.position) < 1e-6), "a pan never moves the camera");
  assert.ok(whip[3].frame - whip[1].frame <= 6, "the whip takes a quarter second");
  const tr = cameraKeys(K0, { move: "tracking_side", metres: 4 }, 96).keys;
  assert.ok(Math.abs(dist(tr[0].position, tr[1].position) - 4) < 1e-6);
  assert.equal(cameraKeys(K0, { move: "follow" }, 96).follow, "person");
  assert.equal(cameraKeys(K0, { move: "car_mount" }, 96).follow, "vehicle");
  assert.ok(cameraKeys(K0, { move: "drone_reveal", metres: 8 }, 96).keys[2].position[1] > 8);
});

test("lighting, physics and edit helpers", () => {
  const plan = lightingPlan({ time: "magic_hour", setup: "golden_backlit", words: "golden", grade: { warmth: 3, bogus: 1 } }, SETUPS);
  assert.equal(plan.time, "magic_hour"); assert.equal(plan.setup.id, "golden_backlit"); assert.deepEqual(plan.grade, { warmth: 1 });
  assert.equal(lightingPlan({ time: "keep", setup: "three_point", words: "x" }, SETUPS).time, null);
  const st = crateStack([0, 0, 10], 0, 6);
  assert.equal(st.length, 6); assert.deepEqual(st.map((p) => p[1]), [0, 0, 0, 0.8, 0.8, 1.6]);
  assert.deepEqual(driveKeys([0, 0, 0], 90, 10, 96)[1].position, [10, 0, 0]);
  const th = throwKeys([0, 1.3, 0], 0, 6);
  assert.ok(th[1].position[2] > 1 && th[1].position[1] > 1.3);
  const s = editStyleCut({ cut: [{ shot_id: "a", in: 0, out: 96 }, { shot_id: "b", in: 0, out: 20 }, { shot_id: "c", in: 0, out: 96 }] },
    { pacing_s: 1.25, transition: "dip_black", trans_frames: 8, every: 2, head: 12, tail: 24, loudness: "social", aspect: "source" }, { fps: 24, styleId: "trailer_cut" });
  assert.deepEqual(s.cut.map((e) => e.out - e.in), [30, 20, 30]);
  assert.deepEqual(s.cut.map((e) => e.trans?.type || null), ["dip_black", null, "dip_black"]);
  assert.equal(s.fade_out, 24); assert.equal(s.edit_style.id, "trailer_cut"); assert.equal(s.edit_style.loudness, "social");
  const v = editStyleCut(s, { pacing_s: 1.5, subtitles: true, aspect: "9:16", transition: null }, { fps: 24 });
  assert.ok(v.cut.every((e) => !e.trans)); assert.equal(v.burn_subtitles, true); assert.equal(v.edit_style.aspect, "9:16");
});

// ------------------------------------------------------------------------------------------------ the runner

test("a camera preset writes editable keys on the current shot, one undo step", async () => {
  const { stage, runner } = await setup();
  const h0 = stage._hist.length;
  const r = await runner.apply("crane_up");
  assert.equal(r.ok, true);
  assert.match(r.said, /Applied 'Crane up' to shot 1/);
  assert.equal(r.target, "shot 1");
  const sh = stage.activeShot();
  assert.equal(sh.camera_keys.length, 2); assert.equal(sh.rig.type, "jib");
  assert.ok(sh.camera_keys[1].position[1] > sh.camera_keys[0].position[1] + 2);
  assert.equal(stage._hist.length, h0 + 1, "one history step");
  assert.equal(stage.state.preset_log.at(-1).id, "crane_up");
  stage.undo();
  assert.deepEqual(stage.toJSON(), SCENE);
  stage.redo();
  assert.equal(stage.activeShot().camera_keys.length, 2);
});

test("shot 2: the toast names it; car mount rides the car; handheld follows a person", async () => {
  const { stage, runner } = await setup();
  stage.state.active_shot = "tracking";
  const r = await runner.apply("dolly_zoom");
  assert.match(r.said, /shot 2/);
  const r2 = await runner.apply("car_mount");
  assert.equal(r2.ok, true);
  assert.deepEqual(stage.calls.at(-1), ["follow", "sports_car", "windshield"]);
  const r3 = await runner.apply("handheld_follow");
  assert.equal(r3.ok, true);
  assert.equal(stage.activeShot().camera_follow, "cole", "the free person, not the one at the wheel");
  assert.equal(stage.activeShot().rig.type, "handheld");
  // A dolly move after the follow goes back to world space.
  await runner.apply("push_in");
  assert.equal(stage.activeShot().camera_follow, undefined);
});

test("a lighting preset: time, the lights, the words and the grade, undone together", async () => {
  const { stage, runner, host } = await setup();
  const look0 = host.look.get();
  const r = await runner.apply("golden_hour");
  assert.equal(r.ok, true);
  assert.equal(stage.state.lighting.preset, "magic_hour");
  assert.equal(stage.state.lighting.setup, "golden_backlit");
  assert.match(stage.state.lighting.setup_prompt, /golden hour/);
  assert.equal(host.look.get().grade.warmth, 0.35);
  assert.equal(stage.state.environment.weather, "rain", "keeps the weather");
  stage.undo();   // ⌘Z
  assert.deepEqual(stage.toJSON(), SCENE);
  assert.deepEqual(host.look.get(), look0, "the grade comes back with the stage");
  stage.redo();
  assert.equal(host.look.get().grade.warmth, 0.35, "redo puts the grade back");
});

test("imported footage: a light preset readies Whole frame (no GPU run)", async () => {
  const sc = clone(SCENE);
  sc.shots[0].source = { path: "clip.mov" };
  const { runner, host } = await setup(sc);
  const r = await runner.apply("noir_hard_key");
  assert.equal(r.ok, true);
  assert.match(host.renders.find((x) => x[0] === "whole")[1], /film noir/);
  assert.ok(!host.renders.some((x) => x[0] === "render"));
});

test("a look preset applies the film style; the toast's undo restores it", async () => {
  const { runner, host } = await setup();
  const r = await runner.apply("film_noir");
  assert.equal(r.ok, true);
  assert.equal(host.look.get().style, "film_noir");
  assert.equal(runner.undo(), "Film Noir");
  assert.equal(host.look.get().style, null);
});

test("action: stunts, crate crash, drop, throw, climb / mount", async () => {
  {
    const { stage, runner } = await setup();
    const r = await runner.apply("donut");
    assert.equal(r.ok, true); assert.equal(stage.state.actors.find((a) => a.id === "sports_car").stunt, "donut");
    assert.match(r.said, /sports car/);
  }
  {
    const { stage, runner } = await setup();
    const r = await runner.apply("crate_crash");
    assert.equal(r.ok, true);
    const crates = stage.state.actors.filter((a) => a.kind === "crate");
    assert.equal(crates.length, 6);
    assert.ok(crates.every((c) => c.physics.mode === "dynamic" && c.physics.baked));
    const car = stage.state.actors.find((a) => a.id === "sports_car");
    assert.ok(car.keys.at(-1).position[2] > 20, "drives straight through");
    const h = stage._hist.length;
    stage.undo();
    assert.equal(stage._hist.length, h - 1);
    assert.equal(stage.state.actors.filter((a) => a.kind === "crate").length, 0, "one undo takes the whole crash away");
  }
  {
    const { stage, runner } = await setup();
    stage.select("horse_1");
    const r = await runner.apply("drop");
    assert.equal(r.ok, true, r.said);
    const it = stage.state.actors.find((a) => a.kind === "crate");
    assert.ok(it, "a horse isn't dropped: a crate is");
    assert.equal(it.physics.mode, "dynamic");
  }
  {
    const { stage, runner } = await setup();
    const r = await runner.apply("throw");
    assert.equal(r.ok, true, r.said);
    const it = stage.state.actors.find((a) => a.kind === "crate");
    assert.equal(it.keys.length >= 3, true);
    assert.match(r.said, /Deputy Cole throws/);
  }
  {
    const { stage, runner } = await setup();
    const r = await runner.apply("climb_mount");
    assert.equal(r.ok, true, r.said);
    const cole = stage.state.actors.find((a) => a.id === "cole");
    assert.equal(cole.mount_id, "horse_1"); assert.equal(cole.mount_at, 24);
  }
  {
    const sc = clone(SCENE); sc.actors = sc.actors.filter((a) => a.kind !== "sports_car");
    const { stage, runner } = await setup(sc);
    const before = stage.toJSON();
    const r = await runner.apply("reverse_jturn");
    assert.equal(r.ok, false); assert.match(r.said, /needs a car/);
    assert.deepEqual(stage.toJSON(), before, "a failed preset leaves nothing behind");
    assert.equal(runner.canUndo, false);
  }
});

test("edit styles set the cut's pacing, transitions and render options; undo puts the cut back", async () => {
  const { stage, runner, host } = await setup();
  const cut0 = host.cut.load();
  const r = await runner.apply("trailer_cut");
  assert.equal(r.ok, true);
  const c = host.cut.load();
  assert.deepEqual(c.cut.map((e) => e.out - e.in), [30, 30, 30]);
  assert.equal(c.cut[0].trans.type, "dip_black");
  assert.equal(c.edit_style.id, "trailer_cut");
  assert.match(r.said, /transitions are saved/, "no Cut panel here: says when they show");
  stage.undo();
  assert.deepEqual(host.cut.load(), cut0);
  await runner.apply("social_vertical");
  assert.equal(host.cut.load().edit_style.aspect, "9:16");
  assert.equal(host.cut.load().burn_subtitles, true);
});

test("edit styles drive the Cut's own actions when the panel has them", async () => {
  const calls = [];
  const panel = { project: {}, setTransition() {}, assembleScene: () => calls.push("assemble"), snapCutsToBeats: (t) => calls.push(["beats", t]),
    subtitlesFromDialogue: () => calls.push("subs"), refresh() {}, loudTarget: null };
  const { runner, host } = await setup(SCENE, {});
  host.cut.panel = () => panel;
  await runner.apply("dialogue_coverage");
  assert.ok(calls.includes("assemble"));
  assert.equal(panel.loudTarget, "ebu");
  await runner.apply("music_video");
  assert.ok(calls.some((x) => x[0] === "beats"));
});

test("recipes: GPU steps ask first and never run on a no", async () => {
  const asked = [];
  const { runner, host } = await setup(SCENE, { confirm: async (m) => { asked.push(m); return false; } });
  const r = await runner.apply("draft_all_shots");
  assert.equal(r.ok, false); assert.equal(r.cancelled, true);
  assert.match(asked[0], /2 draft renders/);
  assert.ok(!host.renders.some((x) => x[0] === "render"));
  host.confirm = async () => true;
  const r2 = await runner.apply("draft_all_shots");
  assert.equal(r2.ok, true);
  assert.deepEqual(host.renders.filter((x) => x[0] === "render").map((x) => x[1]), [3, 3]);
  assert.deepEqual(host.renders.find((x) => x[0] === "quality"), ["quality", "Draft"]);
  const r3 = await runner.apply("hollywood_final", { confirmGpu: true });
  assert.equal(r3.ok, true);
  assert.deepEqual(host.renders.filter((x) => x[0] === "render").at(-1), ["render", 4]);
  assert.ok(host.renders.some((x) => x[1] === "Hollywood"));
  // No confirm hook at all = never queue.
  const { runner: r4, host: h4 } = await setup(SCENE, { confirm: undefined });
  delete r4.host.confirm;
  assert.equal((await r4.apply("hollywood_final")).ok, false);
  assert.ok(!h4.renders.some((x) => x[0] === "render"));
});

test("recipes without the GPU: ripple wardrobe, video → 3D → new angle", async () => {
  const { stage, runner, host } = await setup();
  const r = await runner.apply("ripple_wardrobe");
  assert.equal(r.ok, true);
  assert.deepEqual(host.renders.filter((x) => x[0] === "go" || x[0] === "ripple"), [["go", "motion"], ["ripple", "ripple"]]);
  assert.match(host.renders.find((x) => x[0] === "whole")[1], /new wardrobe/);
  const r2 = await runner.apply("video_to_3d_reshoot");
  assert.equal(r2.paused, true); assert.ok(host.renders.some((x) => x[0] === "import"));
  stage.state.reference = { source: { path: "clip.mp4" } };
  const n = stage.state.shots.length;
  const r3 = await runner.apply("video_to_3d_reshoot");
  assert.equal(r3.ok, true); assert.equal(stage.state.shots.length, n + 1);
  assert.equal(stage.activeShot().camera_keys.length, 5, "a 45° orbit");
  assert.equal(r3.undoable, true);
});

// ------------------------------------------------------------------------------------------------ user presets

test("user presets: save the camera, light and look; load them back; export / import JSON", async () => {
  const { stage, runner, host } = await setup();
  await runner.apply("orbit");
  const cam = userPresetFrom("camera", { scene: stage.toJSON(), look: host.look.get() }, "My orbit", 1000);
  const light = userPresetFrom("light", { scene: { ...stage.toJSON(), lighting: { preset: "night", lights: [{ id: "x" }] } } }, "Night", 1001);
  const look = userPresetFrom("look", { scene: stage.toJSON(), look: { ...host.look.get(), style: "neo_noir" } }, "Neo", 1002);
  const file = userPresetsFile([cam, light, look]);
  const back = parseUserPresets(JSON.stringify(file));
  assert.equal(back.length, 3);
  assert.deepEqual(back.map((p) => p.kind), ["camera", "light", "look"]);
  assert.deepEqual(parseUserPresets('{"presets":[{"id":"x y","tab":"user"},{"id":"ok_1","tab":"camera","kind":"camera","apply":{}}]}'), [], "bad entries dropped");
  assert.deepEqual(parseUserPresets("not json"), []);
  // The camera preset replays relative to another shot's first key.
  const k0 = { position: [10, 2, 10], target: [10, 1, 16], focal_mm: 50 };
  const ks = userCameraKeys(k0, cam.apply.user_camera);
  assert.equal(ks.length, 5);
  assert.deepEqual(ks[0].position, k0.position);
  runner.user = back;
  stage.state.active_shot = "tracking";
  const r = await runner.apply(cam.id);
  assert.equal(r.ok, true); assert.equal(stage.activeShot().camera_keys.length, 5); assert.equal(stage.activeShot().rig.type, "dolly");
  const r2 = await runner.apply(light.id);
  assert.equal(r2.ok, true); assert.equal(stage.state.lighting.preset, "night");
  const r3 = await runner.apply(look.id);
  assert.equal(r3.ok, true); assert.equal(host.look.get().style, "neo_noir");
  runner.undo();
  assert.notEqual(host.look.get().style, "neo_noir");
});

// ------------------------------------------------------------------------------------------------ the Director

test("the Director's preset tool runs through the panel's runner", async () => {
  const { stage, runner } = await setup();
  RUNNERS.set(stage, runner);
  const exec = {};
  assert.equal(installDirectorTool(exec), true);
  assert.equal(installDirectorTool(exec), false, "idempotent");
  assert.equal(exec.preset, presetExecutor);
  const director = { stage, host: { pipeline: { selectShot: (id) => stage.setActiveShot(id) } } };
  const r = await exec.preset.call(director, { preset: "crane_up", shot: "tracking" }, { gpu: false });
  assert.equal(r.ok, true);
  assert.equal(stage.state.active_shot, "tracking");
  assert.match(r.said, /shot 2/);
  const g = await exec.preset.call(director, { preset: "golden_hour" }, { gpu: false });
  assert.equal(g.ok, true); assert.equal(stage.state.lighting.preset, "magic_hour");
  // The Director only sends a GPU recipe once it has asked; the runner then doesn't ask again.
  const h = runner.host;
  const d = await exec.preset.call(director, { preset: "hollywood_final" }, { gpu: true });
  assert.equal(d.ok, true);
  assert.ok(h.renders.some((x) => x[0] === "render" && x[1] === 4));
  const none = await exec.preset.call({ stage: new FakeStage(SCENE), host: {} }, { preset: "crane_up" }, {});
  assert.equal(none.ok, false);
});

test("the real Director table takes the tool", async () => {
  const m = await import("../../web/agent/director.mjs");
  const had = !!m.EXEC.preset;
  installDirectorTool(m.EXEC);
  assert.equal(typeof m.EXEC.preset, "function");
  if (!had) delete m.EXEC.preset;
});

// ------------------------------------------------------------------------------------------------ previews, keys

test("thumbnails draw every preset without throwing (a recording 2D context)", async () => {
  const cat = await loadCatalog();
  let ops = 0;
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (k === "createLinearGradient" || k === "createRadialGradient") ? () => ({ addColorStop() {} }) : typeof k === "string" ? (() => { ops++; }) : undefined),
    set: (o, k, v) => { o[k] = v; return true; } });
  for (const p of cat.presets) for (const t of [0, 1.1, 2.7]) drawThumb(ctx, p, t, 300, 169, { palettes: [], setups: SETUPS });
  const u = userPresetFrom("camera", { scene: SCENE }, "x", 5);
  drawThumb(ctx, u, 1, 300, 169);
  assert.ok(ops > 1000);
  const P = projector({ position: [0, 1.6, -5], target: [0, 1.6, 0], focal_mm: 35 }, 300, 169);
  const left = P([1, 1.6, 0]), up = P([0, 2.6, 0]);
  assert.ok(left[0] < 150, "+X is on the camera's left (three.js, looking +Z)");
  assert.ok(up[1] < 84.5, "up is up");
  assert.deepEqual(camAt([{ frame: 0, position: [0, 0, 0], target: [0, 0, 1], focal_mm: 30 }, { frame: 10, position: [10, 0, 0], target: [0, 0, 1], focal_mm: 30 }], 5).position, [5, 0, 0]);
});

test("V is documented in the shortcut sheet and not taken by another key", () => {
  assert.ok(allCombos().includes("V"));
  assert.ok(SHORTCUTS[0].items.some((i) => i.keys[0] === "V" && /Presets/.test(i.what)));
  const taken = allCombos().filter((c) => c === "V");
  assert.equal(taken.length, 1);
});
