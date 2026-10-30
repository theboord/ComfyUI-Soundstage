import { test } from "node:test";
import assert from "node:assert/strict";
import { progressAt, stepIndex, v2sPlan, capturePlan, fmtSecs, isVideoFile } from "../../web/ui/videoimport.mjs";

test("Video → Stage steps map from the server's step names", () => {
  const p = v2sPlan(192);
  assert.equal(p[stepIndex(p, "Sampling frames")].key, "frames");
  assert.equal(p[stepIndex(p, "Measuring depth (Depth Anything 3)")].key, "depth");
  assert.equal(p[stepIndex(p, "Reading the shot (vision model)")].key, "vlm");
  assert.equal(p[stepIndex(p, "Capturing the performance (SAM 3D Body)")].key, "mocap");
  assert.equal(stepIndex(p, "something new"), -1);
});

test("progress keeps moving inside a long step but never finishes it early", () => {
  const p = v2sPlan(192), i = p.findIndex((s) => s.key === "mocap");
  const a = progressAt(p, i, 0), b = progressAt(p, i, 40), c = progressAt(p, i, 10000);
  assert.ok(a.frac < b.frac && b.frac < c.frac);
  assert.ok(c.frac < 1);
  assert.ok(a.left > b.left && c.left > 0);
  // the SAM 3D step dominates a dance clip, as measured (~77 s of ~150 s)
  assert.ok(p[i].secs > 60);
  assert.ok(progressAt(p, 0, 0).frac === 0);
});

test("capture plan scales with the clip", () => {
  assert.ok(capturePlan(400)[1].secs > capturePlan(100)[1].secs);
});

test("helpers", () => {
  assert.equal(fmtSecs(45), "45 s");
  assert.equal(fmtSecs(80), "1 min 20 s");
  assert.equal(fmtSecs(120), "2 min");
  assert.ok(isVideoFile({ name: "a.MOV", type: "" }));
  assert.ok(isVideoFile({ name: "x", type: "video/webm" }));
  assert.ok(!isVideoFile({ name: "a.png", type: "image/png" }));
});
