import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOK_START, DEPTH_LOCK, depthLockFor, frameLockFor, frameDenoiseFor } from "../../web/pipeline/pipeline.mjs";
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

test("a flagged Klein frame without the lock says what to try next", () => {
  const ghost = { verdict: "flag", extra: [{ kind: "car" }] };
  assert.match(depthTip(ghost, 0), /Lock to the stage depth.*empty/);
  assert.match(depthTip({ verdict: "loose", extra: [] }, 0), /hold every silhouette/);
  assert.equal(depthTip(ghost, 0.5), "");
  assert.equal(depthTip({ verdict: "ok" }, 0), "");
  assert.equal(depthTip(null, 0), "");
});
