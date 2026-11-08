// Picking a shot puts Camera view on THAT shot's camera, every time (2026-11-02 blocker): the strip's clay thumbnails
// rendered other setups by flipping state.active_shot around stage.renderFrameTo, which restored the viewport while
// the flip was still in place. The shot camera stayed on the last thumbnail's setup (1P "Ezra alone"), so on
// "1G Mara close single" the view showed Ezra under Mara's label, and a click on the rider selected Ezra.
// A headless Stage (no WebGL): two riders 6 m apart, one single on each, and a click at the centre of Camera view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { ShotStrip } from "../../web/cut/strip.mjs";

const SRC = (p) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

const SHOTS = [
  { id: "sc_1__1D", name: "1D Profile two-shot", setup: "two_shot", camera_keys: [{ frame: 0, position: [0, 1.6, 12], target: [0, 1.4, 0], focal_mm: 35 }] },
  { id: "sc_1__1G", name: "1G Mara close single", setup: "single_b", camera_keys: [{ frame: 0, position: [3, 1.6, 4], target: [3, 1.4, 0], focal_mm: 50 }] },
  { id: "sc_1__1H", name: "1H Ezra close single", setup: "single_a", camera_keys: [{ frame: 0, position: [-3, 1.6, 4], target: [-3, 1.4, 0], focal_mm: 50 }] },
  { id: "sc_1__1P", name: "1P Ezra alone", setup: "single_a", camera_keys: [{ frame: 0, position: [-3.4, 2, 5], target: [-3, 1.4, 0], focal_mm: 40 }] },
];
const WHO = { sc_1__1G: "mara", sc_1__1H: "ezra", sc_1__1P: "ezra" };

globalThis.ImageData ||= class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };

function headless() {
  const st = Object.create(Stage.prototype);
  const renders = [];
  Object.assign(st, {
    state: { actors: [], shots: structuredClone(SHOTS), active_shot: "sc_1__1D", shot: { frames: 97, fps: 24 } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1280 / 692, 0.1, 200), viewCam: new THREE.PerspectiveCamera(50, 1280 / 692, 0.05, 600),
    freeView: false, free: null, onSelect() {}, onInteract() {}, onChange() {},
    // thumbnails render offscreen (web/stage/offscreen.mjs): a render target, a read-back, never setSize
    renderer: { getSize: (v) => v.set(864, 467), setSize() {}, getRenderTarget: () => null, setRenderTarget() {}, readRenderTargetPixels() {}, getContext: () => null }, canvas: {},
    _snap: { width: 1280, height: 692, getContext: () => ({ drawImage() {}, putImageData() {} }) },
  });
  // What each render looked through: the thumbnail's own setup for a capture, the active shot for the viewport.
  st._renderMode = function (mode, forCapture = false) {
    const cam = forCapture ? this.camera : this._viewportCamera();
    cam.updateMatrixWorld(true);
    renders.push({ forCapture, shot: this.state.active_shot, pos: cam.position.toArray().map((v) => +v.toFixed(2)) });
  };
  st.render = function () { this._renderMode(this.view); };
  st.renders = renders;
  st.scene.add(st.root);
  // Two riders (a 0.6 x 2.4 x 0.6 box each) 6 m apart: Ezra at x = -3, Mara at x = +3.
  for (const [id, x] of [["ezra", -3], ["mara", 3]]) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.4, 0.6), new THREE.MeshBasicMaterial()));
    g.position.set(x, 1.2, 0);
    st.root.add(g);
    st.actorMeshes.set(id, g);
  }
  st.root.updateMatrixWorld(true);
  st.setFrame(0);
  return st;
}

/** Who a click at the centre of the viewport selects (the stage's own pick: _viewportCamera + _pickActor). */
function clickCentre(st) {
  const ray = new THREE.Raycaster();
  const cam = st._viewportCamera();
  cam.updateMatrixWorld(true);
  ray.setFromCamera(new THREE.Vector2(0, 0), cam);
  return st._pickActor(ray);
}
const camAt = (st, id) => st.state.shots.find((s) => s.id === id).camera_keys[0].position;
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

/** The strip's own thumbnail pass (cut/strip.mjs _clay): a clay frame of every setup, the last one 1P. */
const thumbnails = (st) => { for (const s of SHOTS) ShotStrip.prototype._clay.call({ stage: st }, s.id, 0); };

test("renderFrameTo {shot}: the thumbnail sees its own setup; the viewport stays on the active shot", () => {
  const st = headless();
  st.setActiveShot("sc_1__1G");
  st.renders.length = 0;
  thumbnails(st);
  assert.equal(st.state.active_shot, "sc_1__1G", "the active shot is untouched");
  for (const s of SHOTS) {
    const cap = st.renders.find((r) => r.forCapture && r.shot === s.id);
    assert.ok(cap && near(cap.pos, camAt(st, s.id)), `the ${s.name} thumbnail rendered through its own camera`);
  }
  for (const r of st.renders.filter((x) => !x.forCapture)) {
    assert.equal(r.shot, "sc_1__1G", "every viewport render in between is on the active shot");
    assert.deepEqual(r.pos, camAt(st, "sc_1__1G"), "and through its camera");
  }
  assert.deepEqual(st.camera.position.toArray(), camAt(st, "sc_1__1G"), "the shot camera ends on 1G, not on 1P");
});

test("picking each shot in the strip: Camera view is that shot's camera and a click selects that shot's rider", () => {
  const st = headless();
  for (const id of ["sc_1__1G", "sc_1__1H", "sc_1__1G", "sc_1__1P", "sc_1__1G"]) {
    st.setActiveShot(id);
    thumbnails(st);   // the strip re-renders its thumbnails after every pick
    assert.deepEqual(st._viewportCamera().position.toArray(), camAt(st, id), `${id}: Camera view through its own camera`);
    assert.equal(clickCentre(st), WHO[id], `${id}: a click on the rider selects ${WHO[id]}`);
  }
});

test("an older caller that flips active_shot itself still can't leave Camera view on another setup", () => {
  const st = headless();
  st.setActiveShot("sc_1__1G");
  // The pre-fix pattern (and any add-on that copied it): flip, render, flip back.
  const prev = st.state.active_shot;
  st.state.active_shot = "sc_1__1P";
  try { st.renderFrameTo("clay", 0); } finally { st.state.active_shot = prev; }
  assert.deepEqual(st._viewportCamera().position.toArray(), camAt(st, "sc_1__1G"), "re-posed on the active shot before use");
  assert.equal(clickCentre(st), "mara", "a click in 1G selects Mara, not Ezra");
  st.state.active_shot = "sc_1__1P";
  st.state.active_shot = prev;
  st.render();
  assert.deepEqual(st.renders.at(-1).pos, camAt(st, "sc_1__1G"), "the next viewport render is through 1G");
});

test("an older caller's flip is redrawn on its own: the viewport shows the active shot right after the call", async () => {
  const st = headless();
  st.setActiveShot("sc_1__1G");
  st.renders.length = 0;
  const prev = st.state.active_shot;
  st.state.active_shot = "sc_1__1P";
  try { st.renderFrameTo("clay", 0); } finally { st.state.active_shot = prev; }
  await Promise.resolve();   // nothing else draws the viewport here; the stage does
  const last = st.renders.at(-1);
  assert.equal(last.forCapture, false);
  assert.deepEqual(last.pos, camAt(st, "sc_1__1G"), "the last frame on screen is 1G's camera, not 1P's");
});

test("Free view: the shot camera (its frustum) follows the pick; back in Camera view it is the picked shot", () => {
  const st = headless();
  st.setActiveShot("sc_1__1H");
  st.setFreeView(true);
  st.setActiveShot("sc_1__1G");
  thumbnails(st);
  st.render();
  assert.deepEqual(st.camera.position.toArray(), camAt(st, "sc_1__1G"), "the drawn shot camera is 1G's");
  st.setFreeView(false);
  assert.deepEqual(st._viewportCamera().position.toArray(), camAt(st, "sc_1__1G"));
  assert.equal(clickCentre(st), "mara");
});

test("a live preview camera (phone, preset hover) is never overridden by the sync", () => {
  const st = headless();
  st.setActiveShot("sc_1__1G");
  st.previewCamera({ position: [0, 5, 20], target: [0, 0, 0], focal_mm: 24 });
  st.render();
  assert.deepEqual(st.camera.position.toArray(), [0, 5, 20]);
  st.previewCamera(null);
  assert.deepEqual(st.camera.position.toArray(), camAt(st, "sc_1__1G"));
});

test("no caller flips state.active_shot around renderFrameTo any more (they pass {shot})", () => {
  for (const f of ["soundstage.js", "cut/strip.mjs"]) {
    const src = SRC(f);
    assert.ok(!/active_shot\s*=\s*[^=;]+;\s*\n?\s*try\s*\{\s*return\s+\w+\.renderFrameTo\(/.test(src), `${f} still flips active_shot around renderFrameTo`);
  }
  assert.match(SRC("cut/strip.mjs"), /renderFrameTo\("clay", frame, \{ shot: id \}\)/);
});
