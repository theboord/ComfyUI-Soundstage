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

// ------------------------------------------------------------------ Voice: keep mine / convert to the character

import { VOICE_NODE, voiceChoices, voiceNameFor, castEntryFor } from "../../web/performance/performance.mjs";

test("capture graph with a voice: clip sound -> Chatterbox VC -> Save; node ids 1-3 and the clip's audio link unchanged", () => {
  const base = { source: "p/a.mov [input]", performer: "Mike Boord", consent: true };
  const keep = buildCaptureGraph(base);
  assert.equal(keep[VOICE_NODE], undefined, "keep my voice: no conversion node");
  assert.deepEqual(keep[3].inputs.audio, ["1", 1]);
  const g = buildCaptureGraph({ ...base, voice: " MARA_VOSS ", voiceSeed: 3.9 });
  assert.deepEqual(Object.keys(g).sort(), ["1", "10", "2", "3"]);
  assert.equal(g[VOICE_NODE].class_type, "SoundstageChatterboxVC");
  assert.deepEqual(g[VOICE_NODE].inputs, { audio: ["1", 1], voice_name: "MARA_VOSS", seed: 3 });
  assert.deepEqual(g[3].inputs.audio, [VOICE_NODE, 0]);
  assert.deepEqual(g[3].inputs.frames, ["1", 0], "the picture never goes through the voice step");
  assert.ok(JSON.stringify(g).length < 2000, "a small prompt: no stage JSON, no audio inline");
});

test("voice choices: keep mine first; the cast entry's voice is the default; a saved voice named after the character is offered", () => {
  const saved = [{ name: "EZRA_HALE", character: "Ezra Hale" }, { name: "MARA_VOSS", character: "Mara Voss" }, { name: "PIP", character: "PIP" }];
  let c = voiceChoices({ who: "Mara Voss", castVoice: "", saved });
  assert.equal(c.value, "", "no voice on the cast entry yet: keep mine");
  assert.deepEqual(c.options.map((o) => o.value), ["", "MARA_VOSS", "EZRA_HALE", "PIP"]);
  assert.match(c.options[1].label, /^Convert to Mara Voss \(MARA_VOSS\)$/);
  c = voiceChoices({ who: "Mara Voss", castVoice: "MARA_VOSS", saved });
  assert.equal(c.value, "MARA_VOSS");
  c = voiceChoices({ who: "Mara Voss", castVoice: "MARA_V2", saved });
  assert.match(c.options[1].label, /not saved yet/);
  c = voiceChoices({ who: "Ezra Hale", saved: null });
  assert.deepEqual(c.options.map((o) => o.value), ["", "EZRA_HALE"], "no voice list from the server: the character's own name");
  assert.deepEqual(voiceChoices({ who: "Nobody", saved: [] }).options.map((o) => o.value), [""]);
  assert.equal(voiceNameFor("Mara  Voss!"), "MARA_VOSS");
});

test("the cast entry for a stage actor carries the voice", () => {
  const items = [{ key: "character:ezra hale", kind: "character", name: "Ezra Hale", voice: "EZRA_HALE" },
    { key: "character:mara voss", kind: "character", name: "Mara Voss" }, { key: "prop:key", kind: "prop", name: "Key" }];
  assert.equal(castEntryFor(items, { name: "Ezra Hale", kind: "man" })?.voice, "EZRA_HALE");
  assert.equal(castEntryFor(items, { name: "Mara Voss", kind: "woman" })?.key, "character:mara voss");
  assert.equal(castEntryFor(items, { name: "Key", kind: "box" }), null);
});

test("capture summary says when the voice was converted", () => {
  assert.match(captureSummary({ seconds: 4, face_seen: 0.95, has_audio: true, onsets: [1, 2], voice: "MARA_VOSS" }), /voice converted to MARA_VOSS · 2 mouth openings/);
  assert.match(captureSummary({ seconds: 4, face_seen: 0.95, has_audio: true, onsets: [] }), /voice kept/);
});
