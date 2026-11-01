// node --test tests/js/takecheck.test.mjs  (Milestone 16: takes that check themselves, trust signals)
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { takeChips, blockingChip, fileOfUrl, annotated, estimateLabel, estimateSeconds, finalRung, stepForFile, readiness,
  readinessChip, parseMp4Tags, readFileTags, recipeFromTags, recipeLine } from "../../web/takecheck/model.mjs";

test("take chips: clean, problems, errors", () => {
  const clean = takeChips({ chips: [{ tone: "ok", text: "✓ clean" }], checks: { black: true, freeze: true }, frames: 121, elapsed_s: 4.2 });
  assert.equal(clean.length, 1);
  assert.equal(clean[0].tone, "ok");
  assert.match(clean[0].title, /No problems found \(black, freeze\)\. 121 frames checked in 4\.2 s/);
  const bad = takeChips({ chips: [{ tone: "bad", text: "⚠ Sports car faces the wrong way", detail: "should show its tail lights", start: 0 },
    { tone: "warn", text: "⚠ freeze 2.1–2.6 s", start: 2.1 }] });
  assert.deepEqual(bad.map((c) => [c.tone, c.text, c.start]), [["bad", "⚠ Sports car faces the wrong way", 0], ["warn", "⚠ freeze 2.1–2.6 s", 2.1]]);
  assert.equal(bad[0].title, "Sports car faces the wrong way: should show its tail lights");
  assert.equal(takeChips(null)[0].text, "Checking…");
  assert.equal(takeChips({ error: "no such take" })[0].text, "Not checked");
});

test("blocking chip: a score with its breakdown; inconclusive is never a pass", () => {
  const full = blockingChip({ score: 0.874, basis: "actors and camera", camera: { conclusive: true, agree: 0.9, steps: 30 },
    actors: [{ name: "Rider", on_mark: 0.85, frames: 32, iou: 0.61, matched: true, drift_at: [3.2, 3.4] }] });
  assert.equal(full.text, "Follows blocking 87%");
  assert.equal(full.tone, "ok");
  assert.match(full.title, /Camera move: 90% of 30 steps/);
  assert.match(full.title, /Rider: on its mark 85% of 32 frames \(IoU 0\.61\); off its mark at 3\.2 s, 3\.4 s/);
  const none = blockingChip({ score: null, verdict: "inconclusive", basis: "nothing measurable", camera: { conclusive: false, why: "the camera rides inside a car" } });
  assert.equal(none.text, "Blocking: can't tell");
  assert.notEqual(none.tone, "ok");
  assert.match(none.title, /not a pass/);
  const cam = blockingChip({ score: 0.9, basis: "camera only (no actor measured yet)", needs_actors: true, camera: { conclusive: true, agree: 0.9, steps: 20 } });
  assert.equal(cam.text, "Follows blocking 90% (camera)");
  assert.equal(cam.tone, "info");                     // a camera-only score is never shown green
  assert.equal(cam.action, "measure");
  assert.equal(blockingChip({ score: 0.42, basis: "actors only", actors: [] }).tone, "bad");
});

test("file refs from /view URLs", () => {
  const f = fileOfUrl("/api/view?filename=final_00028_.mp4&subfolder=soundstage&type=output&t=123");
  assert.deepEqual(f, { filename: "final_00028_.mp4", subfolder: "soundstage", type: "output" });
  assert.equal(annotated(f), "soundstage/final_00028_.mp4 [output]");
  assert.equal(fileOfUrl("http://x/other"), null);
});

test("Run estimates: $0 and the measured time", () => {
  assert.equal(estimateLabel(95), "$0 · about 2 min on your GPU");
  assert.equal(estimateLabel(360), "$0 · about 6 min on your GPU");
  assert.equal(estimateLabel(22), "$0 · about 20 s on your GPU");
  assert.equal(estimateLabel(0), "");
  assert.equal(estimateSeconds(null, "draft", 121), 95);                 // the 48 GB card's measured defaults
  assert.equal(estimateSeconds(null, "final", 121), 360);
  assert.equal(estimateSeconds(null, "draft", 242), 190);                // scales with the shot's length
  const t = { draft: { seconds: 121, frames: 121, per_frame: 1.0 }, frame: { seconds: 12 } };
  assert.equal(estimateSeconds(t, "draft", 97), 97);
  assert.equal(estimateSeconds(t, "frame", 1, 4), 48);
  assert.equal(finalRung("Final HQ"), "final_hq");
  assert.equal(finalRung("Final"), "final");
});

test("readiness: server needs + the graph's loaders, per step", () => {
  assert.equal(stepForFile("ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"), "motion");
  assert.equal(stepForFile("flux3-image-klein-int8-convrot.safetensors"), "frame");
  assert.equal(stepForFile("sam3.1_multiplex_fp16.safetensors"), "deliver");
  const server = { motion: { status: "needs", needs: [{ what: "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", folder: "loras", required: true }] },
    deliver: { status: "partial", needs: [{ what: "sam3.1_multiplex_fp16.safetensors", folder: "checkpoints", required: false }] } };
  const r = readiness(server, [{ value: "flux2-vae.safetensors", node: "VAELoader" }], ["Krea2ControlApply"]);
  assert.equal(r.set.status, "ready");
  assert.equal(r.motion.status, "needs");
  assert.equal(r.frame.status, "needs");
  assert.deepEqual(r.frame.needs.map((n) => n.what), ["flux2-vae.safetensors", "node Krea2ControlApply"]);
  assert.equal(r.deliver.status, "partial");
  assert.deepEqual(readinessChip(r.set), { tone: "ok", text: "Ready", title: "Ready to run: every node and model file this step uses is installed." });
  const c = readinessChip(r.frame);
  assert.equal(c.text, "Needs 2");
  assert.match(c.title, /flux2-vae\.safetensors/);
  assert.match(c.title, /MODELS\.md/);
  assert.equal(readinessChip(r.deliver).text, "Ready*");
});

const FFMPEG = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("the recipe travels in the MP4: written by ffmpeg, read back by the App", { skip: !FFMPEG && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-tc-"));
  const out = join(dir, "take.mp4");
  const scene = { version: 2, camera: { position: [0, 1, -5], target: [0, 1, 0], focal_mm: 35 }, active_shot: "s1",
    shots: [{ id: "s1", name: "Chase cam" }], actors: [{ id: "car", kind: "sports_car" }] };
  const rec = { v: 1, app: "Soundstage", scene, rung: "final", shot: { id: "s1", name: "Chase cam" }, seeds: { video: 42 } };
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-metadata", `soundstage=${JSON.stringify(rec)}`, "-metadata", `prompt={"1":{"class_type":"KSampler","inputs":{}}}`,
    "-movflags", "use_metadata_tags+faststart", out]);
  const bytes = readFileSync(out);
  const tags = parseMp4Tags(bytes);
  assert.ok("soundstage" in tags && "prompt" in tags);
  const back = recipeFromTags(tags);
  assert.deepEqual(back.scene, scene);
  assert.equal(back.source, "soundstage tag");
  assert.equal(recipeLine(back), "Final · Chase cam · 1 on the stage · seed 42");
  // From a dropped File/Blob: only the moov box is read.
  const viaFile = await readFileTags(new Blob([bytes]));
  assert.equal(viaFile.soundstage, tags.soundstage);
  // moov at the end (no faststart) is found too.
  const late = join(dir, "late.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-metadata", `soundstage=${JSON.stringify(rec)}`, "-movflags", "use_metadata_tags", late]);
  assert.deepEqual(recipeFromTags(await readFileTags(new Blob([readFileSync(late)]))).seeds, { video: 42 });
});

test("older takes: the recipe is rebuilt from ComfyUI's prompt tag", () => {
  const prompt = {
    "9045": { class_type: "SoundstageStage", inputs: { stage: JSON.stringify({ scene: { camera: { position: [0, 1, 0], target: [0, 1, 1], focal_mm: 35 },
      active_shot: "chase", shots: [{ id: "chase", name: "Chase cam (police hood)" }], actors: [{}, {}] }, passes: { clay: "x [temp]" } }) } },
    "9059": { class_type: "SoundstageStep", inputs: { step: 3 } },
    "9091": { class_type: "SoundstageAudioDrivenShot", inputs: { seed: 7 } },
  };
  const rec = recipeFromTags({ prompt: JSON.stringify(prompt) });
  assert.equal(rec.source, "rebuilt from the prompt tag");
  assert.equal(rec.rung, "draft");
  assert.equal(recipeLine(rec), "Draft · Chase cam (police hood) · 2 on the stage · seed 7");
  assert.equal(recipeFromTags({ prompt: "{}" }), null);
  assert.equal(recipeFromTags({}), null);
});
