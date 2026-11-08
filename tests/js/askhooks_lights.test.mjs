// node --test tests/js/askhooks_lights.test.mjs
// "Lights down": stage.setExposure(stops) (a scene dimmer in stops, one undo step, refusals change nothing), the
// render-time scaling of every light and a plain-colour sky (put back after), the prompt phrase, and Ask's
// host.lights hook (web/hosthooks.mjs exposureHook).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, CAPTURE_EXPOSURE_MIN } from "../../web/stage/stage.mjs";
import { PipViewer } from "../../web/stage/camviz.mjs";
import { stageHook } from "../../web/hosthooks.mjs";
import { describeLighting } from "../../web/stage/lighting.mjs";
import { exposureHook } from "../../web/hosthooks.mjs";

function litStage() {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 9, fps: 24 }, actors: [], shots: [{ id: "s" }], active_shot: "s", lighting: { mode: "time", hour: 20 } };
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
