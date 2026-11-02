import { test } from "node:test";
import assert from "node:assert/strict";
import { progressAt, stepIndex, v2sPlan, capturePlan, fmtSecs, isVideoFile, estimateSecs, flawsFromNotes, sortFlaws, QUALITY, V2S_LABEL, V2S_TIP } from "../../web/ui/videoimport.mjs";

test("Video → Stage steps map from the server's step names", () => {
  const p = v2sPlan(192);
  assert.equal(p[stepIndex(p, "Sampling frames")].key, "frames");
  assert.equal(p[stepIndex(p, "Measuring depth (Depth Anything 3)")].key, "depth");
  assert.equal(p[stepIndex(p, "Reading the shot (vision model)")].key, "vlm");
  assert.equal(p[stepIndex(p, "Capturing the performance (SAM 3D Body)")].key, "mocap");
  assert.equal(p[stepIndex(p, "Tracking the camera")].key, "track");
  assert.equal(p[stepIndex(p, "Fusing the set scan")].key, "backdrop");
  assert.equal(stepIndex(p, "something new"), -1);
});

test("the fallback plan is honest: a 5 s clip is many minutes, not 2-3", () => {
  const total = v2sPlan(120, 16).reduce((a, s) => a + s.secs, 0);
  assert.ok(total > 8 * 60, `${total} s`);
  assert.ok(v2sPlan(120, 64).reduce((a, s) => a + s.secs, 0) > total);
});

test("time estimates: server history wins, the measured baseline otherwise", () => {
  const e = estimateSecs(5, 16);
  assert.equal(e.from, "estimate");
  assert.ok(e.secs >= 10 * 60 && e.secs <= 26 * 60, `${e.secs}`);   // the 2026-11-02 baseline: 11-26 min for 5 s clips
  assert.ok(estimateSecs(5, 64).secs > e.secs && estimateSecs(10, 16).secs > e.secs);
  const h = [{ secs: 5, samples: 16, total_s: 330 }, { secs: 5, samples: 16, total_s: 330 }];
  const fromH = estimateSecs(5, 16, h);
  assert.equal(fromH.from, "history");
  assert.ok(Math.abs(fromH.secs - 330) < 1);
  assert.deepEqual(QUALITY.map((q) => q.samples), [16, 32, 64]);
});

test("flaws lead the result card: red first, fix actions wired, plain notes read for failures", () => {
  const lock = () => "locked";
  const f = flawsFromNotes([
    "depth: straightened on the floor (power 0.80-0.95)",
    { text: "Camera solve confidence 31 %: the move may be wrong", level: "red", fix: { action: "lock_camera", label: "Lock to frame 0" } },
    { text: "3 objects partly seen", level: "amber" },
    "performer: motion capture failed (CUDA out of memory)",
    { text: "fine", level: "info" },
  ], { lock_camera: lock });
  assert.equal(f.length, 3);
  const s = sortFlaws(f);
  assert.deepEqual(s.map((x) => x.level), ["red", "red", "amber"]);
  const cam = s.find((x) => x.fix);
  assert.equal(cam.fix.label, "Lock to frame 0");
  assert.equal(cam.fix.run(), "locked");
  assert.ok(!s.some((x) => /locked off/i.test(x.text)));
});

test("one wording for every entry point, with the real limits", () => {
  assert.equal(V2S_LABEL, "Video → 3D set");
  assert.match(V2S_TIP, /min/);
  assert.doesNotMatch(V2S_TIP, /2[–-]3 min/);
});

test("progress keeps moving inside a long step but never finishes it early", () => {
  const p = v2sPlan(192), i = p.findIndex((s) => s.key === "mocap");
  const a = progressAt(p, i, 0), b = progressAt(p, i, 40), c = progressAt(p, i, 10000);
  assert.ok(a.frac < b.frac && b.frac < c.frac);
  assert.ok(c.frac < 1);
  assert.ok(a.left > b.left && c.left > 0);
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

test("Frame prompt for a clip rebuilt with Video → Stage", async () => {
  const { suggestFromVideo } = await import("../../web/pipeline/pipeline.mjs");
  const scene = { video2stage: {}, actors: [
    { name: "Performer", kind: "woman", mocap: { file: "x" }, source: { label: "person in yellow plaid shirt" } },
    { name: "Sidewalk (left)", set_piece: true }, { name: "Sidewalk (right)", set_piece: true }, { name: "Tree", set_piece: true }] };
  const p = suggestFromVideo(scene);
  assert.match(p, /^A person in yellow plaid shirt, full body, on location: sidewalk, tree\./);
  assert.equal(suggestFromVideo({ actors: [{ kind: "man" }] }), "");   // not from a clip: leave the prompt alone
});
