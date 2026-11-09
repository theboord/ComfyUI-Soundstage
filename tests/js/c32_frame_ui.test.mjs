import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pipeline, KLEIN9B_NO_LOCK } from "../../web/pipeline/pipeline.mjs";

// C32 (1): a router error on a ④ Frame run said nothing in the App: the status stayed on "Rendering 1 frame…" (once
// for 15 min) while ComfyUI showed only its generic "Still model (any) failed" card. The router's own sentence goes on
// ④ Frame's status line, one line, and the ticker stops.
const ROUTER = "Lock to the stage depth needs Krea 2 Turbo, qwen_image_vae, krea2/cn/depth-control-lora.safetensors and " +
  "the comfyui-krea2-controlnet nodes. Turn the lock off or install them.";

function errPipe() {
  const p = Object.create(Pipeline.prototype);
  const status = { textContent: "Rendering 1 frame on the GPU · 42 s", _ssTick: setInterval(() => {}, 100000) };
  p.f = { status };
  p.pending = new Map([["pid-frame", { seed: 1, model: "FLUX.2 Klein 9B · local" }]]);
  p.inflight = new Map();
  p._drawShotRows = () => {};
  return { p, status };
}

test("a ④ Frame run that errors shows the router's sentence on the status line and stops the ticker", () => {
  const { p, status } = errPipe();
  p._onFrameError({ detail: { prompt_id: "pid-frame", node_type: "SoundstageEditImage",
    exception_message: `${ROUTER}\n\nTraceback (most recent call last):\n  File "x.py", line 1` } });
  assert.equal(status.textContent, `Frame failed: ${ROUTER}`);
  assert.equal(p.pending.has("pid-frame"), false);
  // the ticker is stopped: a later tick would overwrite the message
  assert.equal(status._ssTick == null || status._ssTick._destroyed === true || status._ssStopped === true, true);
});

test("an error from another prompt (not a ④ Frame run) leaves the status alone", () => {
  const { p, status } = errPipe();
  p._onFrameError({ detail: { prompt_id: "someone-else", exception_message: ROUTER } });
  assert.match(status.textContent, /^Rendering 1 frame/);
  assert.equal(p.pending.has("pid-frame"), true);
  clearInterval(status._ssTick);
});

test("a very long or empty message is still one readable line", () => {
  const { p, status } = errPipe();
  p._onFrameError({ detail: { prompt_id: "pid-frame", exception_message: `   ${"x".repeat(600)}\nmore` } });
  assert.ok(status.textContent.length <= 320 && !status.textContent.includes("\n"));
  const e = errPipe();
  e.p._onFrameError({ detail: { prompt_id: "pid-frame", exception_message: "" , node_type: "SoundstageEditImage" } });
  assert.equal(e.status.textContent, "Frame failed: SoundstageEditImage error (see the ComfyUI log)");
});

test("the App listens for execution_error on its own runs", () => {
  const src = readFileSync(new URL("../../web/pipeline/pipeline.mjs", import.meta.url), "utf8");
  assert.match(src, /addEventListener\?\.\("execution_error", \(ev\) => this\._onFrameError\(ev\)\)/);
});

// C32 (2), ported to private/lifelike: FLUX.2 Klein 9B has no Krea 2 depth pass, so Light and Strict are greyed out with the reason; Off stays.
const K3 = "FLUX 3 Klein · local [<$5M]", K9 = "FLUX.2 Klein 9B · local [non-commercial]", TURBO = "Krea 2 Turbo · local [<$1M]";
function lockPipe(model, mode) {
  const btn = (k) => ({ dataset: { k }, disabled: false, title: "", attrs: {}, setAttribute(n, v) { this.attrs[n] = v; } });
  const k = { id: 9081, inputs: [], properties: {}, widgets: [{ name: "model", value: model, options: { values: [K3, K9, TURBO] } }, { name: "depth_lock", value: 0.5 }] };
  const p = Object.create(Pipeline.prototype);
  p.ctx = { app: { graph: { links: {}, _nodes: [k], getNodeById: (id) => (id === 9081 ? k : null) } } };
  p.f = { model: { value: model }, depthSeg: { children: [btn("off"), btn("light"), btn("strict")] }, depthNote: {} };
  p._dmode = mode;
  return { p, k, seg: p.f.depthSeg.children };
}

test("on FLUX.2 Klein 9B, Light and Strict are disabled with the reason; Off stays selectable and is the lock", () => {
  for (const mode of ["light", "strict", "off", null]) {
    const { p, k, seg } = lockPipe(K9, mode);
    p._syncDepthLock();
    const [off, light, strict] = seg;
    assert.equal(off.disabled, false, String(mode));
    assert.equal(light.disabled, true, String(mode));
    assert.equal(strict.disabled, true, String(mode));
    assert.equal(light.title, KLEIN9B_NO_LOCK);
    assert.equal(strict.title, KLEIN9B_NO_LOCK);
    assert.equal(off.attrs["aria-pressed"], "true", String(mode));
    assert.equal(k.widgets.find((w) => w.name === "depth_lock").value, 0, String(mode));
    assert.equal(k.widgets.find((w) => w.name === "model").value, K9, String(mode));
    assert.match(p.f.depthNote.textContent, /Klein 9B has no Krea 2 depth pass/, String(mode));
  }
});

test("FLUX 3 Klein keeps Light and Strict, without the 9B title", () => {
  const { p, seg } = lockPipe(K3, "light");
  p._syncDepthLock();
  assert.equal(seg[1].disabled, false);
  assert.equal(seg[2].disabled, false);
  assert.notEqual(seg[1].title, KLEIN9B_NO_LOCK);
});
