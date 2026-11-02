import { test } from "node:test";
import assert from "node:assert/strict";
import { Pipeline, LOOK_START, DEPTH_LOCK, depthLockFor, depthModeOf, isKreaTurbo, frameLockFor, frameDenoiseFor } from "../../web/pipeline/pipeline.mjs";
import { depthTip } from "../../web/pipeline/framecheck.mjs";

// ④ Frame "Lock to the stage depth" (soundstage/look/frame_lock.py VERSION 3): a frame records the depth pass it was
// painted with, so picking it again (or animating it) reproduces exactly that frame.
test("a depth-locked frame comes back with its depth pass", () => {
  assert.equal(LOOK_START, 3);
  assert.equal(depthLockFor({ seed: 5, ls: LOOK_START, dlock: DEPTH_LOCK }), 0.5);
  assert.equal(depthLockFor({ seed: 5, ls: LOOK_START, dlock: 0 }), 0);
  assert.equal(depthLockFor({ seed: 5, ls: LOOK_START }), 0);
});

test("frames from before the depth lock, Paint Studio frames and no frame never get it", () => {
  assert.equal(depthLockFor({ seed: 559688375, ls: 2, lock: 0.9 }), 0);       // Nov 1 frame lock, no depth pass
  assert.equal(depthLockFor({ seed: 559688375, dlock: 0.5 }), 0);              // pre-lock frame
  assert.equal(depthLockFor({ edited: "touchup/x.png", seed: 3, ls: 3, dlock: 0.5 }), 0);
  assert.equal(depthLockFor(undefined), 0);
  // the Nov 1 lock itself is unchanged for them
  assert.equal(frameLockFor({ seed: 1, ls: 2 }), true);
  assert.equal(frameDenoiseFor({ seed: 1, ls: 2, lock: 0.9 }), 0.9);
  assert.equal(frameDenoiseFor({ seed: 1, ls: 3, lock: 0.85, dlock: 0.5 }), 0.85);
});

test("a pick says which lock painted it: Light on Klein, Strict on Krea 2 Turbo", () => {
  const klein = "FLUX 3 Klein · local [<$5M]", turbo = "Krea 2 Turbo · local [<$1M]";
  assert.equal(isKreaTurbo(turbo), true);
  assert.equal(isKreaTurbo(klein), false);
  assert.equal(depthModeOf({ seed: 1, ls: 3, dlock: 0.5, model: klein }), "light");
  assert.equal(depthModeOf({ seed: 1, ls: 3, dlock: 0.5, model: turbo }), "strict");
  assert.equal(depthModeOf({ seed: 1, ls: 3, dlock: 0, model: klein }), "off");
  assert.equal(depthModeOf({ seed: 1, ls: 2, dlock: 0.5, model: turbo }), "off");   // before the lock existed
  assert.equal(depthModeOf(undefined), "off");
});

test("a Klein frame off its marks without the lock suggests Strict; ghosts and locked frames get no tip", () => {
  const off = { verdict: "flag", actors: [{ status: "off" }], extra: [] };
  assert.match(depthTip(off, 0), /Lock to the stage depth.*Strict/);
  assert.match(depthTip({ verdict: "loose", actors: [{ status: "loose" }] }, 0), /Strict/);
  assert.equal(depthTip({ verdict: "flag", actors: [{ status: "on" }], extra: [{ kind: "car" }] }, 0), "");   // a ghost: re-roll only
  assert.equal(depthTip(off, 0.5), "");
  assert.equal(depthTip({ verdict: "ok" }, 0), "");
  assert.equal(depthTip(null, 0), "");
});

// A fake frame node (9081) with the widgets _syncDepthLock touches.
function fakePipeline(pickerModel, depthLock, mode) {
  const klein = "FLUX 3 Klein · local [<$5M]", turbo = "Krea 2 Turbo · local [<$1M]";
  const widgets = [{ name: "depth_lock", value: depthLock }, { name: "model", value: pickerModel, options: { values: [klein, turbo, "Z-Image Turbo · local"] } }];
  const btn = (k) => ({ dataset: { k }, disabled: false, setAttribute() {} });
  const p = Object.create(Pipeline.prototype);
  p.ctx = { app: { graph: { _nodes: [{ id: 9081, widgets, properties: {} }] } } };
  p.f = { model: { value: pickerModel }, depthSeg: { children: [btn("off"), btn("light"), btn("strict")] }, depthNote: {} };
  p._dmode = mode;
  return { p, widgets, klein, turbo };
}

test("switching from a locked Klein frame to another image model clears the lock on the frame node", () => {
  const { p, widgets, klein, turbo } = fakePipeline("FLUX 3 Klein · local [<$5M]", 0, "light");
  p._syncDepthLock();
  assert.equal(widgets[0].value, DEPTH_LOCK);
  assert.equal(p._depthLockNow(), DEPTH_LOCK);
  for (const other of [turbo, "Z-Image Turbo · local"]) {
    p.f.model.value = other;
    widgets[1].value = other;
    p._syncDepthLock();
    assert.equal(widgets[0].value, 0, other);            // Krea 2 Turbo picked directly must not paint Strict unasked
    assert.equal(p._depthLockNow(), 0, other);           // and its frames are not recorded as depth-locked
  }
  p.f.model.value = klein;
  p._syncDepthLock();
  assert.equal(widgets[0].value, DEPTH_LOCK);            // back on Klein, the chosen mode comes back
});
