// Milestone 19: the editing timeline's transitions, keys, ducking, loudness, beats, assembly, subtitles, and the
// exporters carrying them. node --test tests/js/cut_m19.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as TL from "../../web/cut/timeline.mjs";
import * as FX from "../../web/cut/fx.mjs";
import { exportAll, toEDL, toFCPXML, toOTIO, toXMEML } from "../../web/cut/exporters.mjs";
import { DINER_SCENE } from "../../web/dailies/demo_dailies.mjs";

const DEMO = JSON.parse(readFileSync(new URL("../../web/cut/demo_project.json", import.meta.url), "utf8"));
const demo = (patch = (p) => p) => TL.normalizeProject(patch(structuredClone(DEMO)));
const withFx = () => demo((p) => {
  p.cut[0].trans = { type: "dip_black", frames: 24 };
  p.cut[1].trans = { type: "dissolve", frames: 12 };
  p.cut[2].trans = { type: "dip_white", frames: 9 };
  p.cut[3].trans = { type: "wipe", frames: 40 };
  p.fade_out = { type: "dip_black", frames: 20 };
  return p;
});

test("normalize: transitions, keys, titles, subtitles are optional and clamped", () => {
  const p = demo((x) => {
    x.cut[0].trans = { type: "nope", frames: 7.6 };
    x.cut[1].trans = { type: "wipe", frames: 0 };
    x.cut[1].opacity = [[60, 2], [-5, 0.25], [3, "x"]];
    x.audio[0].keys = [[0, -100], [10, 3]];
    x.titles = [{ text: "" }, { text: "A", frames: 10, fade_in: 8, fade_out: 8, style: "weird" }];
    x.subtitles = [{ text: "b   c", start_frame: 50 }, { text: "a", start_frame: 5, end_frame: 2 }];
    x.fade_out = { type: "dissolve", frames: 12 };
    return x;
  });
  assert.deepEqual(p.cut[0].trans, { type: "dissolve", frames: 8 });
  assert.equal(p.cut[1].trans, undefined);
  assert.deepEqual(p.cut[1].opacity, [[0, 0.25], [50, 1]]);
  assert.deepEqual(p.audio[0].keys, [[0, -60], [10, 3]]);
  assert.deepEqual(p.titles, [{ id: "t1", text: "A", start_frame: 0, frames: 10, style: "card", fade_in: 8, fade_out: 2 }]);
  assert.deepEqual(p.subtitles.map((c) => [c.start_frame, c.end_frame, c.text]), [[5, 6, "a"], [50, 98, "b c"]]);
  assert.deepEqual(p.fade_out, { type: "dip_black", frames: 12 });
  // an old project normalises exactly as before
  assert.equal(JSON.stringify(demo()).includes("trans"), false);
});

test("edit ops: slip, split keeps the transition on the head, setTransition, rippleItems", () => {
  const p = withFx();
  const s = TL.slip(p, 1, 5);
  assert.deepEqual([s[1].in, s[1].out], [65, 115]);
  assert.deepEqual([TL.slip(p, 1, -1000)[1].in, TL.slip(p, 1, 1000)[1].out], [0, 192]);
  const sp = TL.splitAt(p, 80);
  assert.deepEqual(sp[1].trans, { type: "dissolve", frames: 12 });
  assert.equal(sp[2].trans, undefined);
  assert.equal(TL.setTransition(p, 1, null)[1].trans, undefined);
  assert.deepEqual(TL.rippleItems([{ start_frame: 100, end_frame: 120 }, { start_frame: 10 }], 50, -20),
    [{ start_frame: 80, end_frame: 100 }, { start_frame: 10 }]);
  assert.deepEqual(TL.splitKeys([[0, 1], [10, 0]], 5, 10), [[[0, 1], [5, 0.5]], [[0, 0.5], [5, 0]]]);
});

test("transSpans: centred on the cut, handle-limited, dips need no handles, head and tail", () => {
  const sp = FX.transSpans(withFx());
  assert.deepEqual([sp[0].type, sp[0].pre, sp[0].post, sp[0].head], ["dip_black", 0, 24, true]);
  assert.deepEqual([sp[1].pre, sp[1].post, sp[1].at, sp[1].limited], [6, 6, 60, false]);
  assert.deepEqual([sp[2].pre, sp[2].post], [4, 5]);
  // the insert starts at frame 10 (10 frames of head handle) and is 30 long (15 max after the cut)
  assert.deepEqual([sp[3].pre, sp[3].post, sp[3].frames, sp[3].limited], [10, 15, 25, true]);
  assert.deepEqual([sp.tail.pre, sp.tail.at], [20, 288]);
  // no handles at all (clip runs to the end of its shot, the next starts at 0): no dissolve
  const none = FX.transSpans(demo((p) => { p.cut[5].trans = { type: "dissolve", frames: 12 }; return p; }));
  assert.equal(none[5], null);
  assert.deepEqual(FX.handlesAt(demo(), 5), { out: 0, in: 0 });
});

test("pictureAt: dissolve mixes into the handles, dips go to the colour, opacity keys", () => {
  const p = withFx();
  const sp = FX.transSpans(p);
  const a = FX.pictureAt(p, 54, sp);
  assert.equal(a.row.shot.id, "sc1_master"); assert.equal(a.b.row.shot.id, "sc1_ots_a"); assert.equal(a.b.src, 54);
  assert.ok(a.mix > 0 && a.mix < 0.1);
  const b = FX.pictureAt(p, 65, sp);
  assert.equal(b.src, 65); assert.ok(b.mix > 0.9);   // outgoing master runs 5 frames into its handle
  assert.ok(FX.pictureAt(p, 0, sp).dip.amount > 0.95);
  assert.equal(FX.pictureAt(p, 109, sp).dip.color, "white");
  assert.ok(FX.pictureAt(p, 287, sp).dip.amount > 0.95);
  const q = TL.normalizeProject({ ...p, cut: p.cut.map((e, k) => (k === 4 ? { ...e, opacity: [[0, 1], [6, 0]] } : e)) });
  assert.equal(FX.pictureAt(q, layoutRec(q, 4) + 3, FX.transSpans(q)).alpha, 0.5);
});
const layoutRec = (p, i) => TL.layout(p)[i].recIn;

test("audio level: gain, fades, keys and duck; merged keys are exact", () => {
  const a = TL.normalizeAudio([{ id: "m", out: 100, gain_db: -6, fade_in: 10, keys: [[0, 0], [50, -6]], duck: [[20, 0], [30, -12]] }])[0];
  assert.ok(Math.abs(FX.clipGainAt(a, 5) - Math.pow(10, -6.6 / 20) * 0.5) < 1e-9);
  assert.ok(Math.abs(FX.clipGainAt(a, 50) - Math.pow(10, (-6 - 6 - 12) / 20)) < 1e-9);
  assert.deepEqual(FX.mergedLevelKeys(a), [[0, 0], [20, -2.4], [30, -15.6], [50, -18]]);
  assert.deepEqual(FX.levelBreakpoints(a), [0, 10, 20, 30, 50, 100]);
});

test("auto-duck: music dips under each dialogue line with attack and release; re-duck replaces", () => {
  const p = TL.normalizeProject({ ...demo(), audio: [
    { id: "dx", track: 1, url: "a.wav", start_frame: 100, out: 48, meta: { kind: "dialogue", line: "Hello there." } },
    { id: "mx", track: 3, url: "m.wav", start_frame: 0, out: 300, keys: [[0, -3]] },
    { id: "fx", track: 2, url: "f.wav", start_frame: 0, out: 300 },
  ] });
  const out = FX.autoDuck(p);
  const mx = out.find((a) => a.id === "mx");
  assert.deepEqual(mx.duck, [[91, 0], [97, -12], [151, -12], [163, 0]]);
  assert.deepEqual(mx.keys, [[0, -3]]);
  assert.equal(out.find((a) => a.id === "fx").duck, undefined);
  assert.deepEqual(FX.dialogueRegions(p), [[97, 151]]);
  // two lines close together stay ducked between
  const p2 = TL.normalizeProject({ ...p, audio: [...p.audio, { id: "dx2", track: 1, url: "b.wav", start_frame: 160, out: 24 }] });
  assert.deepEqual(FX.autoDuck(p2).find((a) => a.id === "mx").duck, [[91, 0], [97, -12], [187, -12], [199, 0]]);
  assert.deepEqual(FX.autoDuck(p, { depth_db: 0 }).find((a) => a.id === "mx").duck, undefined);
});

const sine = (sr, sec, db, hz = 997) => { const a = 10 ** (db / 20), x = new Float32Array(sr * sec); for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * hz * i) / sr); return x; };

test("loudness: BS.1770 integrated LUFS of reference tones, gating, and the gain to a target", () => {
  const sr = 48000;
  const s = sine(sr, 3, -20);
  assert.ok(Math.abs(FX.loudness([s, s], sr).lufs - -20) < 0.1, String(FX.loudness([s, s], sr).lufs));
  assert.ok(Math.abs(FX.loudness([s], sr).lufs - -23.01) < 0.1);   // one channel: 3 dB less
  // silence after the tone is gated out (only the blocks that straddle its end count a little)
  const pad = new Float32Array(sr * 6); pad.set(s);
  assert.ok(Math.abs(FX.loudness([pad, pad], sr).lufs - -20) < 0.3);
  assert.equal(FX.loudness([new Float32Array(sr)], sr).lufs, -Infinity);
  const s44 = sine(44100, 3, -20);
  assert.ok(Math.abs(FX.loudness([s44, s44], 44100).lufs - -20) < 0.1);
  assert.equal(FX.loudnessGain(-20, -14), 6);
  assert.equal(FX.loudnessGain(-20, -14, -3, -1), 2);   // held back by the peak
  assert.equal(FX.loudnessGain(-30, -23, -10, -1), 7);
  assert.deepEqual(Object.keys(FX.LOUDNESS_TARGETS), ["social", "ebu", "atsc"]);
});

test("beats: a 120 BPM click track; cuts roll onto the nearest beat", () => {
  const sr = 22050, x = new Float32Array(sr * 8);
  for (let b = 0.25; b < 8; b += 0.5) for (let i = 0; i < 400; i++) x[Math.round(b * sr) + i] = Math.exp(-i / 60) * (i % 2 ? 1 : -1);
  const r = FX.detectBeats(x, sr);
  assert.ok(Math.abs(r.bpm - 120) < 2, String(r.bpm));
  assert.ok(r.beats.some((t) => Math.abs(t - 2.25) < 0.03), JSON.stringify(r.beats.slice(0, 6)));
  const a = { start_frame: 10, in: 0, out: 192 };
  assert.deepEqual(FX.beatFrames(a, [0.25, 0.75, 9], 24).slice(0, 2), [16, 28]);
  const p = demo();
  const { cut, moved } = FX.snapCutsToBeats(p, [63, 112], { tol: 4, roll: TL.roll });
  assert.deepEqual(moved.map((m) => [m.edit, m.from, m.to]), [[1, 60, 63], [2, 110, 112]]);
  assert.equal(TL.totalFrames({ ...p, cut }), TL.totalFrames(p));
});

test("assemble from the lining: wide for action, the speaker's single for lines, cuts on line ends, subtitles", () => {
  const shots = [["m", "Master", "master"], ["sa", "Single · Mara", "single_a"], ["sb", "Single · Ezra", "single_b"],
    ["k", "Insert · the key", "insert", { subject: "key formica" }]].map(([id, name, setup, x]) => ({ id, name, setup, ...(x || {}) }));
  const r = FX.assembleFromLining(DINER_SCENE, shots, () => 240);
  assert.equal(r.cut[0].shot_id, "m");                       // the opening action on the master
  const byEl = new Map(r.plan.map((p) => [p.i, p.shot_id]));
  assert.equal(byEl.get(4), "sb");                           // EZRA's first line on his single
  assert.equal(byEl.get(6), "sa");                           // MARA's reply on hers
  assert.equal(byEl.get(12), "k");                           // "sets a second brass KEY on the formica" on the insert
  for (let k = 1; k < r.cut.length; k++) assert.notEqual(r.cut[k].shot_id === r.cut[k - 1].shot_id && r.cut[k].in === r.cut[k - 1].out, true);
  assert.ok(r.cues.length >= 8);
  assert.equal(r.cues[0].speaker, "EZRA");
  assert.match(r.cues[0].text, /^Drove all night/);
  const total = r.cut.reduce((n, e) => n + e.out - e.in, 0);
  assert.ok(r.cues.every((c) => c.end_frame <= total && c.start_frame < c.end_frame));
  assert.deepEqual(FX.assembleFromLining({ elements: [] }, shots, () => 240).cut, []);
});

test("subtitles: from dialogue clips; SRT / VTT; balanced wrap", () => {
  const p = TL.normalizeProject({ ...demo(), audio: [{ id: "dx", track: 1, url: "a.wav", start_frame: 24, out: 36, meta: { kind: "dialogue", line: "I'm not eating it.", character: "MARA" } }] });
  const cues = FX.subtitlesFromDialogue(p);
  assert.deepEqual(cues, [{ id: "s1", start_frame: 24, end_frame: 60, text: "I'm not eating it.", speaker: "MARA" }]);
  const q = { ...p, subtitles: cues };
  assert.equal(FX.toSRT(q), "1\n00:00:01,000 --> 00:00:02,500\nI'm not eating it.\n");
  assert.equal(FX.toVTT(q), "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v MARA>I'm not eating it.\n");
  assert.equal(FX.toSRT({ ...q, fps: 23.976 }).split("\n")[1], "00:00:01,001 --> 00:00:02,503");
  const w = FX.wrapCue("Drove all night to find you, and you're eating pie. And it is a very long line indeed to wrap");
  assert.equal(w.length, 2);
  assert.ok(Math.abs(w[0].length - w[1].length) < 8);
  assert.deepEqual(FX.wrapCue("short"), ["short"]);
});

test("exports carry transitions, fades, keys, titles and subtitles", () => {
  const p = withFx();
  p.cut[4].opacity = [[0, 1], [6, 0.35]];
  p.audio[0].duck = [[10, 0], [16, -12]];
  p.titles = TL.normalizeTitles([{ text: "DINER NIGHT", start_frame: 0, frames: 48 }]);
  p.subtitles = TL.normalizeSubtitles([{ start_frame: 30, end_frame: 70, text: "Hi." }]);
  const edl = toEDL(p);
  assert.match(edl, /^001  BL       V     C        00:00:00:00 00:00:00:00 01:00:00:00 01:00:00:00$/m);
  assert.match(edl, /^001  SC1_MAST V     D    024 00:00:00:00 00:00:02:06 01:00:00:00 01:00:02:06$/m);
  assert.match(edl, /^002  SC1_OTS_ V     D    012 00:00:02:06 /m);       // dissolve: incoming from 6 frames before its in
  assert.match(edl, /^\d{3}  SC1_INS_ V     W001 025 00:00:00:00 /m);   // wipe, handle-limited
  assert.match(edl, /WIPE 40 FRAMES SHORTENED TO 25/);
  assert.match(edl, /DIP TO WHITE/);
  assert.match(edl, /\* SOUNDSTAGE LEVEL: 10 0\.0, 16 -12\.0/);
  assert.match(edl, /\* SOUNDSTAGE TITLE: 01:00:00:00 01:00:02:00 CARD DINER NIGHT/);
  // V record times stay contiguous: every event's record in is the previous record out
  const v = edl.split("\n").filter((l) => /^\d{3}  \S+ +V /.test(l)).map((l) => l.trim().split(/\s+/).slice(-2));
  for (let k = 1; k < v.length; k++) assert.equal(v[k][0], v[k - 1][1], `event ${k}`);
  assert.equal(v[v.length - 1][1], "01:00:12:00");
  const xm = toXMEML(p);
  assert.match(xm, /<alignment>start-black<\/alignment>/);
  assert.match(xm, /<alignment>end-black<\/alignment>/);
  assert.match(xm, /<name>Cross Dissolve<\/name>[\s\S]*<name>Dip to Color Dissolve<\/name>[\s\S]*<name>Edge Wipe<\/name>/);
  assert.match(xm, /<generatoritem id="title-1">/);
  assert.match(xm, /<parameterid>opacity<\/parameterid>/);
  const fc = toFCPXML(p);
  assert.equal((fc.match(/<transition /g) || []).length, 5);
  assert.match(fc, /<effect id="r\d+" name="Cross Dissolve" uid="FxPlug:4731E73A/);
  assert.match(fc, /<title ref="r\d+" lane="1"/);
  assert.match(fc, /<adjust-blend amount="1">/);
  const ot = toOTIO(p);
  const v1 = ot.tracks.children[0].children;
  assert.equal(v1.filter((c) => c.OTIO_SCHEMA === "Transition.1").length, 5);
  assert.equal(v1[0].OTIO_SCHEMA, "Transition.1");
  assert.equal(v1[2].OTIO_SCHEMA, "Transition.1");
  assert.deepEqual([v1[2].in_offset.value, v1[2].out_offset.value], [6, 6]);
  assert.equal(ot.tracks.children[1].name, "V2");
  const files = exportAll(p);
  assert.ok(files["Diner_Night_v1.srt"].startsWith("1\n00:00:01,250"));
  assert.ok(files["Diner_Night_v1.vtt"].startsWith("WEBVTT"));
  assert.equal(Object.keys(exportAll(demo())).some((k) => k.endsWith(".srt")), false);
});

test("render request and track roles", () => {
  const r = FX.renderRequest(withFx(), { aspect: "9:16", loudness: "atsc", burn_subtitles: 1, reframe_x: 5 });
  assert.deepEqual(r.spec, { format: "mp4", aspect: "9:16", loudness: "atsc", burn_subtitles: true, reframe_x: 1, frames: 288, picture_frames: 288, finish: "off", motion_blur: false });
  assert.equal(FX.renderRequest(withFx(), { finish: "35mm" }).spec.finish, "35mm");
  assert.equal(FX.renderRequest(withFx(), { finish: "vhs" }).spec.finish, "off");
  assert.equal(FX.renderRequest(demo(), { loudness: "nope", format: "prores" }).spec.loudness, null);
  const p = demo();
  assert.deepEqual([1, 2, 3, 4].map((t) => TL.trackName(p, t)), ["Dialogue", "SFX", "Music", "Ambience"]);
  assert.equal(TL.audioTrackCount(p), 4);
  assert.deepEqual(FX.tracksByRole(p, "music"), [3]);
  assert.deepEqual(FX.tracksByRole(TL.normalizeProject({ ...p, audio_tracks: [{ track: 5, name: "MX1" }] }), "music"), [3, 5]);
});

test("in-place generation: node inputs from object_info defaults, the clip back as a /view URL", async () => {
  const { defaultInputs, generationInputs, clipFromNode } = await import("../../web/cut/gen.mjs");
  const info = { input: { required: {
    prompt: ["STRING", { default: "" }], duration_s: ["FLOAT", { default: 2, min: 0.2 }], track: [["DX1", "FX1", "MX1"], { default: "FX1" }],
    engine: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "LTX-2.5 audio · local [open · <$10M]", inputs: { required: { steps: ["INT", { default: 8 }] } } }] }],
    seed: ["INT", { default: 0, min: 0 }], shot_id: ["STRING", { default: "shot1" }], start_frame: ["INT", { default: 0 }], fps: ["FLOAT", { default: 24 }] } } };
  const d = defaultInputs(info);
  assert.equal(d.engine, "LTX-2.5 audio · local [open · <$10M]");
  assert.equal(d["engine.steps"], 8);
  const inp = generationInputs("sfx", d, { text: "glass shatters", seconds: 99, start_frame: 120.4, fps: 24, seed: 7 });
  assert.deepEqual([inp.prompt, inp.duration_s, inp.track, inp.start_frame, inp.seed], ["glass shatters", 30, "FX1", 120, 7]);
  assert.equal(generationInputs("music", d, { text: "neo-noir", seconds: 12 }).length_s, 12);
  assert.equal(generationInputs("dialogue", d, { text: "Hi.", character: "MARA" }).track, "DX1");
  const c = clipFromNode({ path: "soundstage_audio/cut/glass_001.wav", track: 3, label: "glass" }, (f) => `/view?${new URLSearchParams(f)}`);
  assert.equal(c.url, "/view?filename=glass_001.wav&subfolder=soundstage_audio%2Fcut&type=output");
  assert.equal(c.track, undefined);
});
