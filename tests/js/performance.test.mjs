// node --test tests/js/performance.test.mjs   (Use a real performance: capture / render prompts, fit box, takes, Ripple hand-off)
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCaptureGraph, buildPerformancePrompt, boxOfPerson, makePerformanceTake, rippleHandOff, captureSummary, mouthPath,
  consentLine, QUALITIES, PRIVATE_INPUT,
} from "../../web/performance/performance.mjs";
import { rippleSources } from "../../web/motion/ripple.mjs";
import { takesFor } from "../../web/dailies/model.mjs";

test("capture graph: clip -> DWPose body + hands + face -> save with voice and consent", () => {
  const g = buildCaptureGraph({ source: "soundstage_private/performances/a.webm [input]", name: "Diner line!", performer: "Jane Doe", consent: true });
  assert.equal(g[1].class_type, "SoundstageClipLoad");
  assert.deepEqual([g[2].inputs.detect_body, g[2].inputs.detect_hand, g[2].inputs.detect_face], ["enable", "enable", "enable"]);
  assert.equal(g[3].class_type, "SoundstagePerformanceSave");
  assert.deepEqual(g[3].inputs.audio, ["1", 1]);
  assert.deepEqual(g[3].inputs.keypoints, ["2", 1]);
  assert.equal(g[3].inputs.name, "Diner_line_");
  assert.equal(g[3].inputs.consent, true);
  assert.ok(PRIVATE_INPUT.startsWith("soundstage_private/"));
});

test("capture refuses without consent, performer or clip", () => {
  assert.throws(() => buildCaptureGraph({ source: "a [input]", performer: "me", consent: false }), /consent/);
  assert.throws(() => buildCaptureGraph({ source: "a [input]", performer: " ", consent: true }), /performer/);
  assert.throws(() => buildCaptureGraph({ source: "", performer: "me", consent: true }), /clip/);
});

test("render prompt: asset, shot frame, quality, fit box, lip-sync mask", () => {
  const r = buildPerformancePrompt({ asset: "x/asset.json [output]", firstFrame: "f.png [input]", quality: "Hollywood", width: 1280, height: 704,
    seed: 9.7, targetBox: [0.1, 0.2, 0.30001, 0.9] });
  const i = r[1].inputs;
  assert.equal(r[1].class_type, "SoundstagePerformance");
  assert.equal(i.quality, "Hollywood");
  assert.equal(i.seed, 9);
  assert.equal(i.target_box, "[0.1,0.2,0.3,0.9]");
  assert.equal(i.audio_mask, 0.3);
  assert.equal(i.keep_voice, true);
  assert.deepEqual(r[2].inputs.video, ["1", 0]);
  assert.equal(buildPerformancePrompt({ asset: "a", firstFrame: "f", quality: "Ultra", width: 1, height: 1 })[1].inputs.quality, "Draft");
  assert.equal(buildPerformancePrompt({ asset: "a", firstFrame: "f", width: 1, height: 1 })[1].inputs.target_box, "");
  assert.throws(() => buildPerformancePrompt({ asset: "", firstFrame: "f", width: 1, height: 1 }), /capture/);
  assert.throws(() => buildPerformancePrompt({ asset: "a", firstFrame: "", width: 1, height: 1 }), /Frame/);
  assert.deepEqual(QUALITIES, ["Draft", "Final", "Hollywood"]);
});

test("character box from pose-pass pixels, clamped to the frame", () => {
  const person = { body: [[100, 50], null, [140, 300]], face: [[110, 40]], hands: [null, [[-20, 200]]] };
  assert.deepEqual(boxOfPerson(person, 400, 400), [0, 0.1, 0.35, 0.75]);
  assert.equal(boxOfPerson({ body: [null], face: null, hands: [] }, 10, 10), null);
});

test("a performance take lands in the Takes bin with the shot's other takes", () => {
  const take = makePerformanceTake({ file: { filename: "p.mp4" }, url: "/view?p", quality: "Final", name: "diner", now: 1000 });
  assert.equal(take.kind, "final");
  assert.equal(take.label, "Performance · diner");
  assert.ok(take.performance);
  const list = takesFor({ id: "s1" }, { chosen: { url: "/c.png", takes: [take] } });
  assert.ok(list.some((t) => t.id === take.id));
});

test("keep the real footage: the clip becomes the shot's imported Ripple source", () => {
  const c = rippleHandOff({ ripple: { strength: 1.5 } }, { ref: "soundstage_private/performances/a.webm [input]", url: "/v", name: "a" });
  assert.equal(c.ripple.strength, 1.5);
  const src = rippleSources({ renders: {}, chosen: c });
  assert.equal(src[0].key, "import");
  assert.equal(src[0].ref, "soundstage_private/performances/a.webm [input]");
});

test("summary, consent line and mouth curve", () => {
  const a = { seconds: 4.04, face_seen: 0.981, has_audio: true, onsets: [0.2, 0.6, 1.1], consent: { performer: "Jane Doe", date: "2026-11-01 12:00" } };
  assert.equal(captureSummary(a), "4.0 s · face read on 98% of frames · voice kept · 3 mouth openings");
  assert.equal(captureSummary({ ...a, has_audio: false }), "4.0 s · face read on 98% of frames · no sound in this clip");
  assert.equal(consentLine(a), "Performer: Jane Doe · consent 2026-11-01 12:00");
  assert.equal(consentLine({}), "No consent record");
  const d = mouthPath([0, 0.1, null, 0.2], 30, 10);
  assert.equal(d.split("M").length - 1, 2);          // a gap where the face wasn't read
  assert.equal(mouthPath([null, null]), "");
});
