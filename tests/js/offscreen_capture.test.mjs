// Offscreen captures and colour thumbnails (Jon's canvas-speed report 2026-11-08; Lifelike-only plan §1.2a, rows F1-F6,
// F10-F11). Thumbnails, captures and capture sequences render into one reused WebGLRenderTarget instead of resizing
// the visible canvas; every UI thumbnail shows the Color render, while the Stage node's passes stay as they are (L3).
// The real-WebGL pixel parity is tests/js/shaders_browser.test.mjs (tests/browser/offscreen.html).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { flipOpaque, scalePointSizes } from "../../web/stage/offscreen.mjs";

const SRC = (p) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

globalThis.ImageData ||= class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };

/** A Stage without WebGL: a renderer that counts setSize / render targets / reads. */
function fakeStage() {
  const st = Object.create(Stage.prototype);
  const log = { setSize: 0, targets: [], reads: 0, modes: [], drawn: 0, put: 0 };
  let rt = null;
  const renderer = {
    getSize: (v) => v.set(864, 467), setSize() { log.setSize++; }, render() {},
    getRenderTarget: () => rt, setRenderTarget(t) { rt = t; log.targets.push(t ? `${t.width}x${t.height}` : null); },
    readRenderTargetPixels(t, x, y, w, h, buf) { log.reads++; buf.fill(7); },
    getContext: () => ({ getContextAttributes: () => ({ antialias: true }), getParameter: (p) => (p === "SAMPLES" ? 4 : 8), SAMPLES: "SAMPLES", MAX_SAMPLES: "MAX" }),
  };
  Object.assign(st, {
    state: { actors: [], shots: [], shot: { frames: 3, fps: 24 } }, view: "color", frame: 0, scene: new THREE.Scene(),
    renderer, canvas: { width: 864, height: 467, getContext: () => ({ drawImage() { log.drawn++; } }) },
    _snap: { width: 960, height: 512, getContext: () => ({ putImageData() { log.put++; }, drawImage() { log.drawn++; } }) },
    setFrame() {}, _syncShotCamera: () => false, _shots: () => [], render() { log.modes.push("viewport"); },
  });
  st._renderMode = (mode, forCapture) => { log.modes.push(`${mode}${forCapture ? ":capture" : ""}`); };
  return { st, log };
}

test("renderFrameTo renders offscreen: no setSize on the visible canvas, no viewport re-render, one reused target", async () => {
  const { st, log } = fakeStage();
  for (let i = 0; i < 5; i++) st.renderFrameTo("color", i);
  await null;
  assert.equal(log.setSize, 0, "the visible canvas is never resized for a thumbnail (it was 2 per call)");
  assert.deepEqual(log.modes, Array(5).fill("color:capture"), "only the thumbnail renders; the viewport keeps its picture");
  assert.equal(log.reads, 5);
  assert.equal(st.stats.captureTargets, 1, "one target for every thumbnail");
  assert.ok(log.targets.every((t) => t === null || t === "960x512"), "drawn at the delivery size");
  assert.equal(log.targets.at(-1), null, "the screen is the render target again afterwards");
});

test("renderFrameTo('clay') (an older caller such as cut/strip.mjs) draws the Color look; captureSequence keeps its pass names (L3 switches the guide)", async () => {
  const { st, log } = fakeStage();
  st.renderFrameTo("clay", 0);
  assert.deepEqual(log.modes, ["color:capture"]);
  log.modes.length = 0;
  st._awaitAvatars = async () => ({});
  globalThis.OffscreenCanvas ||= class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { putImageData() {} }; } convertToBlob() { return Promise.resolve("blob"); } };
  const seq = await st.captureSequence("clay");
  assert.equal(seq.frames, 3);
  assert.deepEqual(log.modes.filter((m) => m.endsWith(":capture")), ["clay:capture", "clay:capture", "clay:capture"], "the Stage node's clay pass is unchanged");
  assert.equal(log.setSize, 0, "a capture sequence never resizes the visible canvas");
});

test("capture renders offscreen and leaves the viewport alone", async () => {
  const { st, log } = fakeStage();
  st._awaitAvatars = async () => ({});
  globalThis.OffscreenCanvas ||= class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { putImageData() {} }; } convertToBlob() { return Promise.resolve("blob"); } };
  await st.capture("color");
  assert.equal(log.setSize, 0);
  assert.deepEqual(log.modes, ["color:capture"]);
});

test("flipOpaque turns readPixels' bottom-up rows top-down and makes them opaque (the canvas has no alpha)", () => {
  const src = new Uint8Array([1, 1, 1, 0, 2, 2, 2, 9]);   // 1 x 2: bottom row first
  const dst = new Uint8ClampedArray(8);
  flipOpaque(src, dst, 1, 2);
  assert.deepEqual([...dst], [2, 2, 2, 255, 1, 1, 1, 255]);
});

test("scalePointSizes: attenuated points drawn at the target's height (three sizes them by the canvas height), each material once, put back", () => {
  const root = new THREE.Group();
  const m = new THREE.PointsMaterial({ size: 2 }), fixed = new THREE.PointsMaterial({ size: 3, sizeAttenuation: false });
  root.add(new THREE.Points(new THREE.BufferGeometry(), m), new THREE.Points(new THREE.BufferGeometry(), m), new THREE.Points(new THREE.BufferGeometry(), fixed));
  const put = scalePointSizes(root, 1.5);
  assert.equal(m.size, 3, "scaled once though two Points share it");
  assert.equal(fixed.size, 3, "screen-size points are not attenuated: unchanged");
  put();
  assert.equal(m.size, 2);
});

test("every UI thumbnail in these lanes asks for Color, never clay (Lifelike-only colour thumbnails)", () => {
  for (const f of ["soundstage.js", "pipeline/pipeline.mjs", "advisor/advisor.mjs", "presets/livethumbs.mjs", "book/clay.mjs", "canvas/canvas.mjs"]) {
    const s = SRC(f);
    assert.ok(!/renderFrameTo\(\s*["']clay["']/.test(s), `${f}: renderFrameTo("clay")`);
    assert.ok(!/_renderMode\(\s*["']clay["']/.test(s), `${f}: _renderMode("clay")`);
    assert.ok(!/\.view\s*=\s*["']clay["']/.test(s), `${f}: view = "clay"`);
  }
});

test("the stage never resizes the visible canvas for a capture any more (only resize() and setAspect size it)", () => {
  const s = SRC("stage/stage.mjs");
  const body = (name) => { const i = s.indexOf(`\n  ${name}(`); const j = s.indexOf("\n  }\n", i); return s.slice(i, j); };
  for (const f of ["renderFrameTo", "async capture", "async captureSequence", "async _settleSplats"]) assert.ok(!/setSize\(/.test(body(f)), `${f} calls renderer.setSize`);
});
