import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOK_START, DEPTH_LOCK, depthLockFor, depthModeOf, isKreaTurbo, frameLockFor, frameDenoiseFor } from "../../web/pipeline/pipeline.mjs";
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
