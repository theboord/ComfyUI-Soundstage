// node --test tests/js/askhooks_lights.test.mjs
// "Lights down": stage.setExposure(stops) (a scene dimmer in stops, one undo step, refusals change nothing), the
// render-time scaling of every light and a plain-colour sky (put back after), the prompt phrase, and Ask's
// host.lights hook (web/hosthooks.mjs exposureHook).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, CAPTURE_EXPOSURE_MIN, EXPOSURE_MIN, exposureStopsOf } from "../../web/stage/stage.mjs";
import { applyOpsToScene } from "../../web/agent/agent.mjs";
import { PipViewer } from "../../web/stage/camviz.mjs";
import { stageHook } from "../../web/hosthooks.mjs";
import { describeLighting } from "../../web/stage/lighting.mjs";
import { exposureHook } from "../../web/hosthooks.mjs";

function litStage() {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 9, fps: 24 }, actors: [], shots: [{ id: "s" }], active_shot: "s", lighting: { mode: "time", hour: 20 },
    camera: { position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 } };
  st.frame = 0; st.setFrame = () => {};
  st.undo = []; st.onChange = (j) => st.undo.push(j);
  st.scene = new THREE.Scene();
  st.sun = new THREE.DirectionalLight(0xffffff, 2); st.lamp = new THREE.PointLight(0xffaa66, 8);
  st.scene.add(st.sun, st.lamp);
  st.scene.background = new THREE.Color(0.4, 0.6, 0.8);
  return st;
}

test("setExposure: stored in lighting.exposure_stops, one undo step per change, 0 clears it", () => {
  const st = litStage();
  assert.equal(st.exposure(), 0);
  assert.deepEqual(st.setExposure(-2), { ok: true, stops: -2, changed: true });
  assert.equal(st.state.lighting.exposure_stops, -2);
  assert.equal(st.undo.length, 1);
  assert.deepEqual(st.setExposure("-2"), { ok: true, stops: -2, changed: false }, "same value: no undo step");
  assert.equal(st.undo.length, 1);
  assert.equal(st.setExposure(0).ok, true);
  assert.equal("exposure_stops" in st.state.lighting, false);
  assert.equal(st.undo.length, 2);
});

test("setExposure refuses non-numbers and out-of-range values and changes nothing", () => {
  const st = litStage();
  for (const bad of [null, undefined, "", "dim", true, [1], {}, NaN, Infinity, -7, 3]) {
    const r = st.setExposure(bad);
    assert.equal(r.ok, false, String(bad)); assert.ok(r.error);
  }
  assert.equal(st.undo.length, 0);
  assert.equal(st.exposure(), 0);
});

test("the dimmer scales every light and a colour sky during the render only, then puts them back", () => {
  const st = litStage();
  st.setExposure(-1);
  let seen;
  st._withExposure(() => { seen = [st.sun.intensity, st.lamp.intensity, st.scene.background.r]; });
  assert.deepEqual(seen.map((v) => +v.toFixed(4)), [1, 4, 0.2], "half the light at -1 stop");
  assert.deepEqual([st.sun.intensity, st.lamp.intensity, +st.scene.background.r.toFixed(4)], [2, 8, 0.4], "put back after");
  st.setExposure(0);
  st._withExposure(() => { seen = st.lamp.intensity; });
  assert.equal(seen, 8);
});

test("the prompt says the lights are down; the render path uses the dimmer", () => {
  const sun = { azimuth_deg: 200, elevation_deg: 30 };
  assert.doesNotMatch(describeLighting({}, sun), /lights/);
  assert.match(describeLighting({ exposure_stops: -1.5 }, sun), /lights dimmed down/);
  assert.match(describeLighting({ exposure_stops: -4 }, sun), /lights down very low/);
  const src = readFileSync(new URL("../../web/stage/stage.mjs", import.meta.url), "utf8");
  assert.match(src, /this\._withExposure\(\(\) => this\.renderer\.render\(this\.scene, cam\), \{ mode, forCapture \}\)/);
});

test("host.lights: get / set / down / reset through the stage, refusals passed back", () => {
  const st = litStage(), L = exposureHook(st);
  assert.equal(L.get(), 0);
  assert.equal(L.down().stops, -1);
  assert.equal(L.down(1.5).stops, -2.5);
  assert.equal(L.get(), -2.5);
  assert.equal(L.down(-1).ok, false, "down takes a positive number of stops");
  assert.equal(L.set(-9).ok, false);
  assert.equal(L.reset().stops, 0);
  assert.equal(st.undo.length, 3);
  assert.equal(exposureHook(() => null).set(-1).ok, false, "no stage");
  const app = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  const a = app.indexOf("node.ssAsk = mountAsk(");
  assert.match(app.slice(a, app.indexOf("mountProjectBar(", a)), /lights: exposureHook\(stage\)/);
});

test("captures are never dimmed to near-black: guide passes not at all, Color at most CAPTURE_EXPOSURE_MIN stops", () => {
  const st = litStage();
  st.view = "clay";
  st.setExposure(-6);
  assert.equal(CAPTURE_EXPOSURE_MIN, -2);
  assert.equal(st._exposureFactor(), 1 / 64, "the viewport (here in clay view) shows the full -6 stops");
  assert.equal(st._exposureFactor({ mode: "color" }), 1 / 64);
  for (const mode of ["clay", "depth", "wire", "id", "dust"]) assert.equal(st._exposureFactor({ mode, forCapture: true }), 1, `${mode} capture`);
  assert.equal(st._exposureFactor({ mode: "color", forCapture: true }), 1 / 4, "a Color capture: a quarter of the light, not 1/64");
  let seen;
  st._withExposure(() => { seen = st.lamp.intensity; }, { mode: "clay", forCapture: true });
  assert.equal(seen, 8, "the clay guide for Frame / Motion is lit as set");
  st._withExposure(() => { seen = st.lamp.intensity; }, { mode: "color", forCapture: true });
  assert.equal(seen, 2);
  st.setExposure(-1);
  assert.equal(st._exposureFactor({ mode: "color", forCapture: true }), 1 / 2, "above the floor: the capture matches the viewport");
});

test("the shot-camera picture-in-picture (PipViewer) is dimmed like the main view", () => {
  const st = litStage();
  st.view = "color"; st.freeView = true;
  Object.defineProperty(st, "fw", { value: 1280 }); Object.defineProperty(st, "fh", { value: 720 });
  st.camera = new THREE.PerspectiveCamera();
  const seen = [];
  st.renderer = { autoClear: true, setScissorTest() {}, setScissor() {}, setViewport() {},
    render: (scene) => { seen.push([st.lamp.intensity, +scene.background.r.toFixed(4)]); } };
  const pip = Object.create(PipViewer.prototype);
  Object.assign(pip, { stage: st, enabled: true, widthFrac: 0.3, el: { style: {}, hidden: true }, container: null,
    _layout: () => ({ bw: 1280, bh: 720, s: 1, left: 0, top: 0 }) });
  try { pip._draw(); } catch { /* DOM chrome after the render; the render is what is checked */ }
  st.setExposure(-2);
  try { pip._draw(); } catch { /* as above */ }
  assert.deepEqual(seen, [[8, 0.4], [2, 0.1]], "full light at 0, a quarter at -2 stops");
  assert.equal(st.lamp.intensity, 8, "put back after");
});

test("Ask can take back a lights change: host.stage.snapshot() / restore(snap)", () => {
  const st = litStage();
  st.actorMeshes = new Map(); st._buildSet = () => {}; st._applySun = () => {}; st.onSelect = null;
  const host = stageHook(st), L = exposureHook(st);
  const snap = host.snapshot();
  assert.equal(L.down(3).stops, -3);
  assert.deepEqual(host.restore(snap), { ok: true, changed: true });
  assert.equal(st.exposure(), 0);
  assert.equal(st.undo.length, 2, "the change and the restore: two undo steps");
});

test("the dimmer is clamped to EXPOSURE_MIN..EXPOSURE_MAX on load, in exposure() and the render factor; non-numbers dropped", () => {
  const st = litStage();
  // a saved value out of range / not a number (an old file, a hand edit, an agent set_lighting op that loads through load())
  for (const [saved, want] of [[-1e9, -6], [1e308, 2], [-6.5, -6], [true, 0], ["1e3", 0], ["-2", 0], [NaN, 0], [null, 0], [-1.234, -1.23]]) {
    st.state.lighting = { mode: "time", hour: 20, exposure_stops: saved };
    assert.equal(st.exposure(), want, `exposure() of ${String(saved)}`);
    assert.ok(Math.abs(st._exposureFactor() - Math.pow(2, want)) < 1e-12, `factor of ${String(saved)}`);
  }
  assert.equal(exposureStopsOf(true), null); assert.equal(exposureStopsOf("1e3"), null); assert.equal(exposureStopsOf(-1e9), EXPOSURE_MIN);
  // load() cleans the stored field (the stage reads only what it can use)
  const ld = Object.create(Stage.prototype);
  Object.assign(ld, { camera: new THREE.PerspectiveCamera(), _buildSet() {}, _applySun() {}, setKey() {} });
  Object.defineProperty(ld, "fw", { value: 16 }); Object.defineProperty(ld, "fh", { value: 9 });
  const scene = (v) => ({ camera: { position: [0, 1, 5], target: [0, 1, 0], focal_mm: 35 }, actors: [], lighting: { mode: "time", hour: 20, exposure_stops: v } });
  ld.load(scene(-40)); assert.equal(ld.state.lighting.exposure_stops, -6);
  ld.load(scene(9)); assert.equal(ld.state.lighting.exposure_stops, 2);
  for (const bad of [true, "1e3", "-2", NaN, {}, 0]) { ld.load(scene(bad)); assert.equal("exposure_stops" in ld.state.lighting, false, String(bad)); }
  // the agent's set_lighting op lands in the stage through load() (agent.mjs loadScene), so it is clamped the same way
  ld.load(applyOpsToScene(scene(undefined), [{ op: "set_lighting", set: { exposure_stops: -1e12 } }]));
  assert.equal(ld.state.lighting.exposure_stops, -6);
  ld.load(applyOpsToScene(scene(undefined), [{ op: "set_lighting", set: { exposure_stops: "1e3" } }]));
  assert.equal("exposure_stops" in ld.state.lighting, false);
  // setExposure: exponent strings and booleans refused
  for (const bad of ["1e3", "-1e0", true, false, "0x1", " "]) assert.equal(st.setExposure(bad).ok, false, String(bad));
  assert.deepEqual(st.setExposure(" -1.5 ").stops, -1.5);
});

test("host.lights.down stops at the bound; down('') / down(null) / down(true) / down('1e3') refuse and change nothing", () => {
  const st = litStage(), L = exposureHook(st);
  assert.equal(L.set(-5.5).stops, -5.5);
  assert.deepEqual(L.down(1), { ok: true, stops: -6, changed: true }, "-5.5 then down(1) gives -6");
  assert.deepEqual(L.down(3), { ok: true, stops: -6, changed: false }, "at the bound: no step");
  assert.deepEqual(L.down(Number.MAX_VALUE), { ok: true, stops: -6, changed: false });
  const n = st.undo.length;
  for (const bad of ["", null, true, "1e3", NaN, Infinity, -1, "x", {}, []]) {
    const r = L.down(bad);
    assert.equal(r.ok, false, `down(${JSON.stringify(bad)})`); assert.match(r.error, /stops must be a number/);
  }
  assert.equal(st.undo.length, n); assert.equal(st.exposure(), -6);
  L.reset();
  assert.equal(L.down().stops, -1, "down() is one stop");
  assert.equal(L.down(undefined).stops, -2);
  assert.equal(L.down("0.5").stops, -2.5);
  assert.equal(exposureHook(null).down(1).ok, false, "no stage");
});
