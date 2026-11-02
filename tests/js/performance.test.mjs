// node --test tests/js/performance.test.mjs   (Use a real performance: capture / render prompts, fit box, takes, Ripple hand-off)
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCaptureGraph, buildPerformancePrompt, boxOfPerson, makePerformanceTake, rippleHandOff, captureSummary, mouthPath,
  consentLine, QUALITIES, PRIVATE_INPUT, fitTarget, faceBoxOfFrames, faceBoxOfPerson,
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
  assert.equal(c.value, "MARA_VOSS", "a cast voice the server doesn't have is replaced by the one that matches");
  c = voiceChoices({ who: "Pip Lark", castVoice: "PIP_V2", saved: [{ name: "EZRA_HALE", character: "Ezra Hale" }] });
  assert.match(c.options[1].label, /not saved yet/, "no match to fall back on: the cast voice stays, flagged");
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

test("chest-up take on a rider: fitted face to face, not stretched hat to stirrup", () => {
  // a phone take: a hand above the head to the belt (runs out of the frame), face 0.45-0.55 x 0.2-0.4
  const actorBox = [0.3, 0.05, 0.7, 1.0], actorFace = [0.45, 0.2, 0.55, 0.4];
  // the rider in a close single: face 0.48-0.52 x 0.3-0.38, the whole rider clamped hat to frame bottom
  const charBox = [0.35, 0.25, 0.75, 1.0], charFace = [0.48, 0.3, 0.52, 0.38];
  const t = fitTarget({ actorBox, actorFace, charBox, charFace, seated: true });
  assert.equal(t.fit, "face");
  // the server fits actorBox onto t.box (same height, centre x, top): the actor's face must land on the rider's face
  const s = (t.box[3] - t.box[1]) / (actorBox[3] - actorBox[1]);
  const dx = (t.box[0] + t.box[2]) / 2 - (actorBox[0] + actorBox[2]) / 2 * s, dy = t.box[1] - actorBox[1] * s;
  const f = [actorFace[0] * s + dx, actorFace[1] * s + dy, actorFace[2] * s + dx, actorFace[3] * s + dy];
  f.forEach((v, i) => assert.ok(Math.abs(v - charFace[i]) < 2e-3, `face ${i}: ${v} vs ${charFace[i]}`));
  assert.ok(Math.abs(s - 0.4) < 1e-3);
  // the old whole-box fit scaled this take by 0.79: the actor's face would be ~2x the rider's
  assert.ok((charBox[3] - charBox[1]) / (actorBox[3] - actorBox[1]) / s > 1.9);
  // head to toe, standing: whole body to whole body, as before
  assert.deepEqual(fitTarget({ actorBox: [0.4, 0.05, 0.6, 0.9], actorFace, charBox: [0.1, 0.2, 0.2, 0.9], charFace, seated: false }),
    { box: [0.1, 0.2, 0.2, 0.9], fit: "body" });
  // no face on the character (turned away): whole box
  assert.equal(fitTarget({ actorBox, actorFace, charBox, charFace: null, seated: true }).fit, "body");
  assert.deepEqual(fitTarget({}), { box: null, fit: "" });
});

test("face boxes: median over the capture, unclamped from the stage", () => {
  const face = (x0, y0) => Array.from({ length: 70 }, (_, i) => [x0 + (i % 10) * 0.01, y0 + Math.floor(i / 10) * 0.02, i < 68 ? 0.9 : 0.1]);
  const frames = [{ face: face(0.4, 0.2) }, { face: null }, { face: face(0.42, 0.22) }, { face: face(0.44, 0.24) }];
  assert.deepEqual(faceBoxOfFrames(frames), [0.42, 0.22, 0.51, 0.34]);
  assert.equal(faceBoxOfFrames([{ face: null }]), null);
  const px = { face: Array.from({ length: 68 }, (_, i) => [600 + (i % 10) * 10, 300 + Math.floor(i / 10) * 10]) };
  assert.deepEqual(faceBoxOfPerson(px, 640, 400), [0.9375, 0.75, 1.0781, 0.9]);   // past the right edge: kept
  assert.equal(faceBoxOfPerson({ face: null }, 640, 400), null);
});

// ------------------------------------------------------------------ 2026-11-02: the cast's voices, queue state, pinned shot, tail

import { matchVoice, fullNamesIn, voiceCandidates, followPrompt, tailNote, ltxFrames } from "../../web/performance/performance.mjs";

const SAVED = [{ name: "EZRA_HALE", character: "EZRA HALE" }, { name: "MARA_VOSS", character: "MARA VOSS" }, { name: "PIP", character: "PIP" }];
const SCRIPT = { scenes: [{ elements: [
  { type: "action", text: "EZRA HALE (60s, sheriff's star long since pawned) rests a hand near his holster. Across from him, MARA VOSS (30s) does not blink." },
  { type: "character", text: "EZRA" }, { type: "dialogue", text: "You rode a long way to stand in the dirt." }] }] };

test("the script's cue names (Ezra, Mara) match the voices saved under the full names (EZRA_HALE, MARA_VOSS)", () => {
  assert.equal(matchVoice("Ezra", SAVED), "EZRA_HALE", "first name -> the one voice that starts with it");
  assert.equal(matchVoice("Mara", SAVED), "MARA_VOSS");
  assert.equal(matchVoice("Mara Voss", SAVED), "MARA_VOSS");
  assert.equal(matchVoice("Ezra", [...SAVED, { name: "EZRA_YOUNG", character: "EZRA YOUNG" }]), "", "ambiguous first name: no guess");
  assert.equal(matchVoice("Ezra", [...SAVED, { name: "EZRA_YOUNG" }], ["EZRA HALE"]), "EZRA_HALE", "an alias settles it");
  assert.equal(matchVoice("Nobody", SAVED), "");
  assert.deepEqual(fullNamesIn(SCRIPT, "Ezra"), ["EZRA HALE"]);
  assert.deepEqual(fullNamesIn(SCRIPT, "Mara"), ["MARA VOSS"]);
  assert.deepEqual(voiceCandidates("Ezra", ["EZRA HALE"]), ["EZRA_HALE", "EZRA"]);
});

test("before the server can list voices (404), the dialog offers the full name from the script, never the bare cue name", () => {
  let c = voiceChoices({ who: "Ezra", saved: null, aliases: fullNamesIn(SCRIPT, "Ezra") });
  assert.deepEqual(c.options.map((o) => o.value), ["", "EZRA_HALE"]);
  assert.equal(c.options[1].label, "Convert to Ezra (EZRA_HALE)");
  c = voiceChoices({ who: "Mara", castVoice: "MARA_VOSS", saved: null });
  assert.equal(c.value, "MARA_VOSS", "the project's cast voice is the default, list or no list");
  c = voiceChoices({ who: "Ezra", saved: SAVED });
  assert.equal(c.options[1].value, "EZRA_HALE", "with the list: matched by name");
  assert.equal(voiceChoices({ who: "Ezra", castVoice: "EZRA", saved: SAVED }).value, "EZRA_HALE", "a stale EZRA cast voice heals");
});

function fakeApi() {
  const ls = {};
  return { addEventListener: (t, f) => (ls[t] ||= []).push(f), removeEventListener: (t, f) => { ls[t] = (ls[t] || []).filter((x) => x !== f); },
    emit: (t, detail) => (ls[t] || []).forEach((f) => f({ detail })), count: () => Object.values(ls).flat().length };
}

test("queue state: 'Waiting in the queue' until the websocket says our prompt started, with jobs ahead when the server can say", async () => {
  const api = fakeApi();
  let answer = null;
  const f = followPrompt(api, { summary: async () => answer, every: 1e6 });
  api.emit("execution_start", { prompt_id: "other" });
  f.track("mine");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.state(), "queued");
  assert.match(f.text("Reading…", 12), /^Waiting in the queue: the GPU is shared.* 12 s$/);
  answer = { running: 1, pending: 3, items: [{ prompt_id: "mine", state: "pending", position: 3 }] };
  f.track("mine");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(f.text("Reading…", 40), /^Waiting in the queue \(3 jobs ahead\)/);
  api.emit("executing", { node: "2", prompt_id: "mine" });
  assert.equal(f.state(), "running");
  assert.equal(f.text("Reading…", 41), "Reading… 0 s", "the clock restarts when the job starts");
  assert.equal(f.text("Reading…", 53), "Reading… 12 s");
  f.stop();
  assert.equal(api.count(), 0, "listeners removed");
  const g = followPrompt(api, { summary: async () => null, every: 1e6 });
  api.emit("execution_start", { prompt_id: "early" });   // started before POST /prompt returned
  g.track("early");
  assert.equal(g.state(), "running");
  g.stop();
});

test("the clip's tail: LTX frame counts, and the dialog says what was dropped or held", () => {
  assert.equal(ltxFrames(97), 97); assert.equal(ltxFrames(96), 89); assert.equal(ltxFrames(96, "hold"), 97); assert.equal(ltxFrames(90, "hold"), 97);
  let t = tailNote(4.04, { seconds: 3.708 });
  assert.ok(Math.abs(t.dropped_s - 0.33) < 0.011);
  assert.match(t.text, /last 0\.3\d s are dropped/);
  t = tailNote(3.75, { seconds: 4.042, tail_held_s: 0.29 });
  assert.equal(t.dropped_s, 0); assert.match(t.text, /held 0\.29 s.*no word is lost/);
  assert.equal(tailNote(4.04, { seconds: 4.042 }).text, "");
  assert.equal(tailNote(0, { seconds: 3 }).text, "");
  assert.equal(buildCaptureGraph({ source: "a.mp4 [input]", performer: "M", consent: true, tail: "hold" })[1].inputs.tail, "hold");
  assert.equal(buildCaptureGraph({ source: "a.mp4 [input]", performer: "M", consent: true })[1].inputs.tail, undefined, "an older server never sees the new input");
});
