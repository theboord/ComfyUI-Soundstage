// node --test tests/js/presets_live.test.mjs
// Milestone 17 polish: card previews rendered from the real stage (web/presets/livethumbs.mjs). A scratch copy of the
// scene gets each preset applied and renders clay frames (loops for camera moves and stunts, stills for lights and
// looks); the user's stage is never touched; previews are cached per scene; hover previews borrow the scratch copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadCatalog } from "../../web/presets/engine.mjs";
import { PresetRunner } from "../../web/presets/runner.mjs";
import { LiveThumbs, liveKind, isLoop, sampleFrames, sceneSig, gradeFilter, gradeOf, LOOP_FRAMES, LOOP_FPS, THUMB_W, THUMB_H } from "../../web/presets/livethumbs.mjs";

const clone = (o) => JSON.parse(JSON.stringify(o));
const SETUPS = JSON.parse(readFileSync(new URL("../../web/look/lighting_setups.json", import.meta.url), "utf8")).setups;
const K0 = { frame: 0, position: [0, 1.6, -6], target: [0, 1.2, 0], focal_mm: 35 };
const SCENE = {
  camera: { position: [0, 1.6, -6], target: [0, 1.2, 0], focal_mm: 35 },
  shot: { frames: 97, fps: 24 },
  lighting: { mode: "time", hour: 12, preset: "midday", lights: [] },
  environment: { set: "street_night", weather: "none" },
  actors: [
    { id: "cole", name: "Cole", kind: "man", position: [3, 0, 2], keys: [{ frame: 0, position: [3, 0, 2] }], rotation_deg: 90 },
    { id: "sports_car", name: "Sports car", kind: "sports_car", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 },
  ],
  shots: [{ id: "wide", name: "Wide", setup: "wide", camera_keys: [clone(K0)] }],
  active_shot: "wide",
};

/** A canvas 2D context that records what was drawn. */
function fakeCtx(log) {
  return {
    filter: "none", fillStyle: "", font: "", textBaseline: "",
    drawImage: (...a) => log.push(["drawImage", a.length, a[0]?.__name || "?"]),
    fillRect: () => {}, fillText: () => {}, measureText: (t) => ({ width: t.length * 6 }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
}
function fakeDoc() {
  const log = [];
  const mk = (tag) => {
    const el = { tag, style: {}, children: [], width: 0, height: 0, __name: tag,
      setAttribute() {}, append(...k) { this.children.push(...k); }, remove() { this.removed = true; },
      getContext: () => fakeCtx(log) };
    return el;
  };
  return { log, createElement: mk, body: mk("body") };
}

/** Enough of web/stage/stage.mjs for the runner and the renderer: mutates .state, counts renders. */
class FakeStage {
  constructor(scene = SCENE) {
    this.state = clone(scene); this.frame = 0; this.selected = null; this.view = "clay"; this.freeView = false;
    this.renders = []; this.loads = 0;
    this.onChange = () => { if (!this._muteRecord) this._record(); };
    this._hist = [JSON.stringify(this.state)]; this._redo = [];
    this.canvas = { width: 0, height: 0, __name: "stagecanvas" };
    this.renderer = { setSize: (w, h) => { this.canvas.width = w; this.canvas.height = h; } };
  }
  get fw() { return 960; } get fh() { return 512; }
  _record() { const s = JSON.stringify(this.state); this._redo = []; if (this._hist[this._hist.length - 1] !== s) this._hist.push(s); }
  undo() { if (this._hist.length < 2) return false; this._redo.push(this._hist.pop()); this.state = JSON.parse(this._hist[this._hist.length - 1]); return true; }
  redo() { return false; }
  toJSON() { return clone(this.state); }
  load(s) { this.state = clone(s); this.loads++; }
  setFrame(f) { this.frame = f; }
  setFrameSilent(f) { this.frame = f; }
  select(id) { this.selected = id; }
  _lastFrame() { return (this.state.shot?.frames || 97) - 1; }
  _renderMode(mode, forCapture) { this.renders.push({ mode, forCapture, frame: this.frame, keys: JSON.stringify(this.activeShot().camera_keys), light: this.state.lighting.preset, size: [this.canvas.width, this.canvas.height] }); }
  activeShot() { return this.state.shots.find((s) => s.id === this.state.active_shot) || this.state.shots[0]; }
  setCameraKeys(keys) { this.activeShot().camera_keys = clone(keys); this.onChange(); }
  setRig(type) { this.activeShot().rig = { type, amount: 1 }; this.onChange(); }
  setCameraFollow(id) { const sh = this.activeShot(); if (!id) delete sh.camera_follow; else sh.camera_follow = id; this.onChange(); }
  applyTimePreset(k) { this.state.lighting = { ...this.state.lighting, mode: "time", preset: k }; this.onChange(); }
  applyLightingSetup(s) { this.state.lighting.lights = s.lights.map((l, i) => ({ id: `l${i}`, type: l.type })); this.state.lighting.setup = s.id; this.onChange(); return s.lights.length; }
  setEnvironment(p) { Object.assign(this.state.environment, p); this.onChange(); }
  applyStunt(id, kind) { const a = this.state.actors.find((x) => x.id === id); a.stunt = kind; a.keys = [{ frame: 0, position: [0, 0, 0] }, { frame: 96, position: [0, 0, 12] }]; this.onChange(); return kind; }
}

async function setup(scene = SCENE) {
  const catalog = await loadCatalog();
  const user = new FakeStage(scene);
  const doc = fakeDoc();
  const scratches = [];
  const lt = new LiveThumbs({ stage: user, setups: SETUPS, doc, budgetMs: 1000,
    makeStage: () => { const s = new FakeStage(SCENE); scratches.push(s); return s; },
    makeRunner: (s) => new PresetRunner({ stage: s, host: { confirm: async () => false }, catalog, setups: SETUPS }) });
  return { catalog, user, lt, doc, scratches, get: (id) => catalog.byId.get(id) };
}
const drain = async (lt) => { lt.start(); for (let i = 0; i < 400 && (lt.queue.length || lt.running); i++) await new Promise((r) => setTimeout(r, 2)); };

test("liveKind: camera moves and stunts loop, lights and looks are stills, edit styles and recipes stay drawn", async () => {
  const cat = await loadCatalog();
  const kinds = {};
  for (const p of cat.presets) kinds[p.tab] = [...new Set([...(kinds[p.tab] || []), liveKind(p)])];
  assert.deepEqual(kinds.camera, ["camera"]);
  assert.deepEqual(kinds.light, ["light"]);
  assert.deepEqual(kinds.look, ["look"]);
  assert.deepEqual(kinds.action, ["action"]);
  assert.deepEqual(kinds.edit, [null]);
  assert.deepEqual(kinds.recipe, [null]);
  assert.equal(liveKind({ tab: "user", apply: { user_camera: { keys: [] } } }), "camera");
  assert.equal(liveKind({ tab: "user", apply: { user_light: {} } }), "light");
  assert.equal(liveKind({ tab: "user", apply: { user_look: {} } }), "look");
  assert.ok(isLoop("camera") && isLoop("action") && !isLoop("light") && !isLoop("look"));
});

test("sampleFrames spans the whole shot; sceneSig ignores the preset log but sees every edit", () => {
  assert.deepEqual(sampleFrames(96, 5), [0, 24, 48, 72, 96]);
  assert.equal(sampleFrames(96).length, LOOP_FRAMES);
  assert.deepEqual(sampleFrames(0), [0]);
  const a = sceneSig(SCENE);
  assert.equal(a, sceneSig({ ...clone(SCENE), preset_log: [{ id: "push_in" }] }));
  const moved = clone(SCENE); moved.actors[0].position[0] = 3.5;
  assert.notEqual(a, sceneSig(moved));
});

test("gradeFilter / gradeOf: a look's grade reads as a filter; a light card carries its own grade", async () => {
  assert.match(gradeFilter({ contrast: 0.5, saturation: -0.4, warmth: 0.3 }), /contrast\(1\.3\d*\).*saturate\(0\.6\d*\).*sepia/);
  assert.match(gradeFilter({ warmth: -0.5 }), /hue-rotate\(-1\d+deg\)/);
  const cat = await loadCatalog();
  const noir = cat.byId.get("noir_hard_key");
  assert.deepEqual(gradeOf(noir, SETUPS), Object.fromEntries(Object.entries(noir.apply.light.grade || {})));
  const look = cat.presets.find((p) => p.tab === "look");
  assert.deepEqual(gradeOf(look), look.apply.grade || {});
});

test("camera cards: a loop of the move's real keys on a scratch copy; the user's stage is never touched", async () => {
  const { lt, user, scratches, get } = await setup();
  const before = JSON.stringify(user.state), hist = user._hist.length;
  lt.sync();
  lt.want([get("push_in"), get("crane_up")]);
  await drain(lt);
  const e = lt.get("push_in");
  assert.ok(e?.ok, "push in rendered");
  assert.equal(e.n, LOOP_FRAMES);
  assert.equal(e.sprite.width, THUMB_W * LOOP_FRAMES);
  assert.equal(e.sprite.height, THUMB_H);
  const S = scratches[0];
  const renders = S.renders.filter((r) => r.forCapture && r.mode === "clay");
  assert.equal(renders.length, 2 * LOOP_FRAMES, "ten frames per move");
  assert.deepEqual(renders.slice(0, LOOP_FRAMES).map((r) => r.frame), sampleFrames(96));
  // The rendered camera keys are the move's (not the shot's own one key), and differ between moves.
  assert.notEqual(renders[0].keys, JSON.stringify([K0]));
  assert.notEqual(renders[0].keys, renders[LOOP_FRAMES].keys);
  // Never the user's stage: same state, same history, no renders.
  assert.equal(JSON.stringify(user.state), before);
  assert.equal(user._hist.length, hist);
  assert.equal(user.renders.length, 0);
  // frameAt walks the loop at LOOP_FPS.
  assert.equal(lt.frameAt("push_in", 0).i, 0);
  assert.equal(lt.frameAt("push_in", 3 / LOOP_FPS).i, 3);
  assert.equal(lt.frameAt("push_in", LOOP_FRAMES / LOOP_FPS).i, 0);
});

test("light cards are stills of the set relit; look cards grade one still of the stage", async () => {
  const { lt, get, scratches, catalog } = await setup();
  lt.sync();
  const look = catalog.presets.find((p) => p.tab === "look");
  lt.want([get("night_street"), look]);
  await drain(lt);
  assert.equal(lt.get("night_street").n, 1);
  assert.equal(lt.get(look.id).n, 1);
  const S = scratches[0];
  const night = S.renders.find((r) => r.light === "night");
  assert.ok(night, "the light card rendered with the night sky on the scratch copy");
  assert.equal(S.renders.length, 2, "one still for the light, one base still shared by every look");
});

test("cache: same scene = no new renders; a new scene renders again but keeps showing the old previews meanwhile", async () => {
  const { lt, user, get, scratches } = await setup();
  lt.sync(); lt.want([get("push_in")]); await drain(lt);
  const n0 = scratches[0].renders.length;
  assert.equal(lt.sync(), false);
  assert.equal(lt.want([get("push_in")]), 0, "cached for this scene");
  user.state.actors[0].position = [5, 0, 5];
  assert.equal(lt.sync(), true);
  assert.equal(lt.get("push_in"), null);
  assert.ok(lt.frameAt("push_in", 0), "the older preview stays on the card until the new one is ready");
  lt.want([get("push_in")]); await drain(lt);
  assert.ok(lt.get("push_in")?.ok);
  assert.ok(scratches[0].renders.length > n0);
  // Each preset starts from the user's scene: the scratch copy is reloaded from it, not stacked.
  assert.ok(scratches[0].loads >= 2);
});

test("a preset that can't apply here (a stunt with no car) keeps its drawn preview", async () => {
  const noCar = clone(SCENE); noCar.actors = noCar.actors.filter((a) => a.kind !== "sports_car");
  const { lt, get } = await setup(noCar);
  lt.sync(); lt.want([get("donut")]); await drain(lt);
  assert.equal(lt.get("donut").ok, false);
  assert.equal(lt.frameAt("donut", 0), null);
});

test("hover preview: lights and stunts render over the shot from the scratch copy; camera moves don't use it", async () => {
  const { lt, user, get, doc } = await setup();
  lt.sync();
  assert.equal(await lt.hoverStart(get("push_in")), false, "camera moves preview on the stage's own camera");
  const before = JSON.stringify(user.state);
  assert.equal(await lt.hoverStart(get("golden_hour"), { w: 1280, h: 680 }), true);
  assert.equal(lt.scratch.renders.at(-1).light, "magic_hour");
  assert.deepEqual(lt.scratch.renders.at(-1).size[0], 1280);
  assert.equal(lt.hovering.frames.length, 1, "a light is one still");
  const ctx = fakeCtx(doc.log);
  assert.equal(lt.hoverFrame(ctx, 0, 1280, 680), true);
  assert.equal(JSON.stringify(user.state), before, "the user's shot is unchanged while previewing");
  lt.hoverEnd();
  assert.equal(lt.hovering, null);
  // A stunt renders a short loop once, across the whole shot, then plays it.
  const n0 = lt.scratch.renders.length;
  assert.equal(await lt.hoverStart(get("donut"), { w: 640, h: 340 }), true);
  const hv = lt.hovering;
  assert.equal(hv.frames.length, hv.total);
  const frames = lt.scratch.renders.slice(n0).map((r) => r.frame);
  assert.equal(frames[0], 0); assert.equal(frames.at(-1), 96);
  assert.equal(hv.busy, false, "the scratch copy is free again for the cards");
  lt.hoverEnd();
  // Card rendering carries on after a hover, from the base scene again.
  lt.want([get("crane_up")]); await drain(lt);
  assert.ok(lt.get("crane_up").ok);
  assert.equal(JSON.stringify(user.state), before);
});

test("camera moves and lights reset the scratch copy by copying fields back; a stunt reloads it", async () => {
  const { lt, get, scratches } = await setup();
  lt.sync(); lt.want([get("push_in"), get("crane_up"), get("golden_hour"), get("orbit")]); await drain(lt);
  const S = scratches[0];
  assert.equal(S.loads, 1, "one load for the scene, then soft resets");
  assert.ok(lt.stats.soft >= 3);
  lt.want([get("donut"), get("pull_out")]); await drain(lt);
  assert.equal(S.loads, 2, "the stunt rewrote the car's keys: the next preset reloads the scene");
  assert.ok(lt.get("pull_out").ok);
});

test("frameAt still: one middle frame for reduced motion", async () => {
  const { lt, get } = await setup();
  lt.sync(); lt.want([get("push_in")]); await drain(lt);
  assert.equal(lt.frameAt("push_in", 0, { still: true }).i, Math.floor(LOOP_FRAMES / 2));
  assert.equal(lt.frameAt("push_in", 5, { still: true }).i, Math.floor(LOOP_FRAMES / 2));
});

test("dispose stops the queue and removes the hidden scratch canvas", async () => {
  const { lt, get } = await setup();
  lt.sync(); lt.want([get("push_in")]); await drain(lt);
  const box = lt.box;
  lt.want([get("crane_up"), get("orbit")]);
  lt.dispose();
  assert.equal(lt.queue.length, 0);
  assert.ok(box.removed);
  assert.equal(lt.frameAt("push_in", 0), null);
});

test("arrow keys inside the Presets window move between cards: the scene strip leaves a dialog's arrows alone", async () => {
  const { SceneStrip } = await import("../../web/script/scenestrip.mjs");
  let stepped = 0;
  const strip = { el: { hidden: false, isConnected: true, offsetParent: {} }, pick: { offsetParent: {} }, o: { getScript: () => ({ scenes: [{}, {}] }) }, step: () => stepped++ };
  const ev = (inDialog) => ({ key: "ArrowRight", target: { tagName: "BUTTON", closest: (sel) => (inDialog && /\[role=dialog\]/.test(sel) ? {} : null) },
    defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } });
  const inPresets = ev(true);
  SceneStrip.prototype._onKey.call(strip, inPresets);
  assert.equal(stepped, 0); assert.ok(!inPresets.stopped, "the key reaches the Presets window");
  SceneStrip.prototype._onKey.call(strip, ev(false));
  assert.equal(stepped, 1, "elsewhere → still steps scenes");
});

// ---- non-blocking previews: one step per slot inside the budget, halt() between steps, no constructor draw
test("previews work one step per slot: setup, the preset's apply and frames over budget each wait for the next slot", async () => {
  const { lt, get, scratches } = await setup();
  let slots = 0;
  lt.slot = () => { slots++; return new Promise((r) => setTimeout(r, 0)); };
  lt.budgetMs = 0; lt.frameMs = 1;   // any frame "fills" a slot: one frame per slot
  lt.sync(); lt.want([get("push_in")]); await drain(lt);
  assert.ok(lt.isCurrent("push_in"));
  assert.equal(scratches[0].renders.length, LOOP_FRAMES);
  // 1 start + scratch + scene load + the apply + (LOOP_FRAMES - 1) frame waits
  assert.ok(slots >= 3 + LOOP_FRAMES, `slots ${slots}`);
  assert.equal(THUMB_W * 9, THUMB_H * 16, "16:9 preview targets");
  assert.ok(THUMB_W < 240, "smaller render targets than the card canvas used to be");
});

test("several frames share a slot while they fit the budget", async () => {
  const { lt, get } = await setup();
  let slots = 0;
  lt.slot = () => { slots++; return new Promise((r) => setTimeout(r, 0)); };
  lt.budgetMs = 1e6;
  lt.sync(); lt.want([get("push_in")]); await drain(lt);
  assert.ok(lt.isCurrent("push_in"));
  assert.ok(slots <= 5, `all ten frames in one slot (${slots} slots)`);
});

test("halt() (the panel closing) stops a preset mid-render: nothing stored, queue empty, the loop ends", async () => {
  const { lt, get, scratches } = await setup();
  lt.budgetMs = 0; lt.frameMs = 1;
  let n = 0;
  lt.slot = () => { if (++n === 6) lt.halt(); return new Promise((r) => setTimeout(r, 0)); };
  lt.sync(); lt.want([get("push_in"), get("crane_up")]); await drain(lt);
  assert.equal(lt.queue.length, 0);
  assert.equal(lt.running, false);
  assert.equal(lt.isCurrent("push_in"), false);
  assert.ok(scratches[0].renders.length < LOOP_FRAMES);
  // Reopening queues it again and finishes.
  lt.slot = () => new Promise((r) => setTimeout(r, 0));
  lt.want([get("push_in")]); await drain(lt);
  assert.ok(lt.isCurrent("push_in"));
});

test("the scratch stage skips the Stage constructor's synchronous first draw; the user's stage keeps render()", async () => {
  class DrawStage extends FakeStage { constructor(s) { super(s); this.render(); } render() { DrawStage.draws++; } }
  DrawStage.draws = 0;
  const catalog = await loadCatalog();
  const user = new DrawStage(SCENE);
  assert.equal(DrawStage.draws, 1);
  const lt = new LiveThumbs({ stage: user, setups: SETUPS, doc: fakeDoc(), budgetMs: 1000,
    makeRunner: (s) => new PresetRunner({ stage: s, host: { confirm: async () => false }, catalog, setups: SETUPS }) });
  lt._ensureScratch();
  assert.equal(DrawStage.draws, 1, "no draw while constructing the scratch copy");
  user.render();
  assert.equal(DrawStage.draws, 2, "render() restored");
});

test("warm() pre-builds the scratch stage, loads the scene and is ready before any card is queued; each step waits for idle", async () => {
  const { lt, scratches } = await setup();
  let idles = 0;
  assert.equal(lt.ready, false);
  const ok = await lt.warm({ idle: async () => { idles++; } });
  assert.equal(scratches.length, 1);
  assert.equal(scratches[0].loads, 1);
  assert.ok(idles >= 3, `three idle steps (${idles})`);
  assert.equal(lt._compiledFor === lt.baseStr || !scratches[0].renderer.compileAsync, true);
  assert.equal(ok, lt.ready);
  assert.equal(scratches[0].renders.length, 0, "warming draws nothing");
});
