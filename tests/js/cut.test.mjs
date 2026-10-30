// node --test tests/js/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as TL from "../../web/cut/timeline.mjs";
import { exportAll, fcpTime, fpsInfo, framesToTC, locatorEntries, mediaFor, reelNames, tcToFrames, toAvidLocators, toEDL, toFCPXML, toOTIO, toXMEML } from "../../web/cut/exporters.mjs";

const DEMO = JSON.parse(readFileSync(new URL("../../web/cut/demo_project.json", import.meta.url), "utf8"));
const demo = () => TL.normalizeProject(structuredClone(DEMO));

// ---------------------------------------------------------------- timecode

test("24 fps non-drop timecode math", () => {
  assert.equal(framesToTC(0), "00:00:00:00");
  assert.equal(framesToTC(23), "00:00:00:23");
  assert.equal(framesToTC(24), "00:00:01:00");
  assert.equal(framesToTC(86400), "01:00:00:00");
  assert.equal(framesToTC(86400 + 24 * 61 + 5), "01:01:01:05");
  for (const n of [0, 1, 23, 24, 1439, 1440, 86399, 86400, 123456]) assert.equal(tcToFrames(framesToTC(n)), n);
});

test("fps info and FCPXML rational time", () => {
  assert.deepEqual(fpsInfo(24), { base: 24, num: 24, den: 1 });
  assert.deepEqual(fpsInfo(23.976), { base: 24, num: 24000, den: 1001 });
  assert.equal(fcpTime(0, fpsInfo(24)), "0s");
  assert.equal(fcpTime(1, fpsInfo(24)), "1/24s");
  assert.equal(fcpTime(48, fpsInfo(24)), "2s");
  assert.equal(fcpTime(36, fpsInfo(24)), "3/2s");
  assert.equal(fcpTime(86400, fpsInfo(24)), "3600s");
  assert.equal(fcpTime(1, fpsInfo(23.976)), "1001/24000s");
});

// ---------------------------------------------------------------- EDL

const EVENT_RE = /^(\d{3})  (\S+) +V {5}C {8}(\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d) (\d\d:\d\d:\d\d:\d\d)$/;

test("CMX3600: header, fixed columns, contiguous record TC from 01:00:00:00", () => {
  const p = demo();
  const edl = toEDL(p);
  const lines = edl.split("\n");
  assert.equal(lines[0], "TITLE: Diner Night v1");
  assert.equal(lines[1], "FCM: NON-DROP FRAME");
  const events = lines.filter((l) => /^\d{3} .{9} V /.test(l));
  assert.equal(events.length, p.cut.length);
  let rec = tcToFrames("01:00:00:00");
  events.forEach((line, i) => {
    const m = line.match(EVENT_RE);
    assert.ok(m, `bad event line: ${JSON.stringify(line)}`);
    assert.equal(Number(m[1]), i + 1);
    // CMX column positions: reel at 5, channel at 14, transition at 20, source in at 29
    assert.equal(line[13], " ");
    assert.equal(line.slice(14, 15), "V");
    assert.equal(line.slice(20, 21), "C");
    assert.equal(line.indexOf(m[3]), 29);
    assert.ok(m[2].length <= 8);
    const [si, so, ri, ro] = m.slice(3).map((t) => tcToFrames(t));
    assert.equal(ri, rec, `event ${i + 1} record in`);
    assert.equal(so - si, ro - ri, `event ${i + 1} source/record durations`);
    assert.equal(si, p.cut[i].in);
    assert.equal(so, p.cut[i].out);
    rec = ro;
  });
  assert.equal(rec - tcToFrames("01:00:00:00"), TL.totalFrames(p));
});

test("CMX3600: clip names, source files, LOC notes", () => {
  const edl = toEDL(demo());
  assert.match(edl, /^\* FROM CLIP NAME: SC1_OTS_A$/m);
  assert.match(edl, /^\* SOURCE FILE: demo_media\/draft_sc2_master\.mp4$/m);
  // shot note on event 2 at its record in (01:00:02:12), cut note on event 5
  assert.match(edl, /^\* LOC: 01:00:02:12 RED {5}Look approved - push in slower$/m);
  assert.match(edl, /^\* LOC: 01:00:07:12 RED {5}Hold for the door chime \(ADR\)$/m);
  assert.ok(!/\* SOURCE FILE: SC1_MASTER/.test(edl), "clay-only shots carry no SOURCE FILE");
});

test("reel names are sanitised, cut to width and unique", () => {
  const p = TL.normalizeProject({ shots: [{ id: "a", name: "Scene 1 master" }, { id: "b", name: "Scene 1 master B" }, { id: "c", name: "scène-1/ots" }] });
  const r = reelNames(p, 8);
  assert.equal(r.get("a"), "SCENE_1_");
  assert.equal(r.get("b"), "SCENE_11");
  assert.equal(new Set(r.values()).size, 3);
  for (const v of r.values()) assert.match(v, /^[A-Z0-9_]{1,8}$/);
  assert.equal(reelNames(p, 32).get("b"), "SCENE_1_MASTER_B");
});

test("media paths from ComfyUI /view URLs", () => {
  const shot = { name: "SH010", renders: { draft: "/view?filename=SH010_draft_00001.mp4&subfolder=soundstage%2Fdrafts&type=output" } };
  assert.equal(mediaFor(shot).path, "soundstage/drafts/SH010_draft_00001.mp4");
  const abs = mediaFor(shot, "/workspace/ComfyUI/output");
  assert.equal(abs.path, "/workspace/ComfyUI/output/soundstage/drafts/SH010_draft_00001.mp4");
  assert.equal(abs.url, "file:///workspace/ComfyUI/output/soundstage/drafts/SH010_draft_00001.mp4");
  const off = mediaFor({ name: "SH020 clay", renders: {} }, "/out");
  assert.equal(off.offline, true);
  assert.equal(off.url, "file:///out/SH020%20clay.mov");
});

// ---------------------------------------------------------------- OTIO

test("OTIO: timeline / stack / one video track, source ranges and markers", () => {
  const p = demo();
  const t = toOTIO(p);
  assert.equal(t.OTIO_SCHEMA, "Timeline.1");
  assert.deepEqual(t.global_start_time, { OTIO_SCHEMA: "RationalTime.1", rate: 24, value: 86400 });
  assert.equal(t.tracks.OTIO_SCHEMA, "Stack.1");
  assert.equal(t.tracks.children.length, 1 + 2, "V1 + A1 + A2");
  const track = t.tracks.children[0];
  assert.equal(track.OTIO_SCHEMA, "Track.1");
  assert.equal(track.kind, "Video");
  assert.equal(track.children.length, p.cut.length);
  track.children.forEach((c, i) => {
    assert.equal(c.OTIO_SCHEMA, "Clip.2");
    assert.equal(c.source_range.start_time.value, p.cut[i].in);
    assert.equal(c.source_range.duration.value, p.cut[i].out - p.cut[i].in);
    const ref = c.media_references[c.active_media_reference_key];
    assert.ok(["ExternalReference.1", "MissingReference.1"].includes(ref.OTIO_SCHEMA));
  });
  assert.equal(track.children[1].markers[0].comment, "Look approved - push in slower");
  assert.equal(track.children[1].markers[1].comment, "Advisor: eyeline drifts left of lens");
  assert.equal(track.children[1].markers[1].color, "YELLOW");
  assert.equal(track.children[1].metadata.soundstage.relink, "LOOK stand-in: relink to the Final render");
  assert.equal(track.children[1].markers[0].marked_range.start_time.value, 60);
  assert.equal(track.children[0].media_references.DEFAULT_MEDIA.OTIO_SCHEMA, "MissingReference.1");
  assert.equal(track.children[6].media_references.DEFAULT_MEDIA.target_url, "demo_media/final_sc2_single_b.mp4");
  assert.equal(JSON.parse(JSON.stringify(t)).name, "Diner Night v1");
});

// ---------------------------------------------------------------- FCPXML

test("FCPXML 1.10: resources, spine offsets from 01:00:00:00, stills as <clip><video>", () => {
  const p = demo();
  const x = toFCPXML(p);
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">'));
  assert.match(x, /<sequence format="r1" duration="12s" tcStart="3600s" tcFormat="NDF"/);
  const clips = [...x.matchAll(/<(asset-clip|clip)(?: ref="(r\d+)")? offset="([^"]+)" name="([^"]+)" start="([^"]+)" duration="([^"]+)"/g)];
  // audio: connected clips on lanes -1 / -2, anchored inside the picture clip they start under
  assert.match(x, /<asset-clip ref="r\d+" lane="-1" offset="0s" name="Rain on glass" start="0s" duration="4s" audioRole="effects">/);
  assert.match(x, /<adjust-volume amount="-6.0dB">\n\s+<param name="amount">\n\s+<fadeIn type="easeIn" duration="1\/2s"\/>/);
  assert.match(x, /<asset-clip ref="r\d+" lane="-2" offset="15\/2s" name="Door chime" start="0s" duration="3\/2s" audioRole="effects"\/>/);
  assert.equal(clips.length, p.cut.length);
  const secs = (s) => { const [n, d = "1"] = s.replace(/s$/, "").split("/"); return Number(n) / Number(d); };
  let off = 3600;
  clips.forEach((m, i) => {
    assert.equal(secs(m[3]), off, `clip ${i + 1} offset`);
    assert.equal(secs(m[5]), p.cut[i].in / 24);
    off += secs(m[6]);
  });
  assert.equal(clips[1][1], "clip", "Look still is a <clip> holding a <video>");
  assert.match(x, /<clip offset="[^"]+" name="SC1_OTS_A"[^>]*>\n {14}<note>[^<]+<\/note>\n {14}<video ref="r\d+" offset="5\/2s" duration="25\/12s"\/>/);
  assert.equal(clips[6][1], "asset-clip");
  // balanced tags (a cheap well-formedness check; tests/test_cut.py parses it properly)
  for (const tag of ["fcpxml", "resources", "library", "event", "project", "sequence", "spine", "asset"]) {
    assert.equal((x.match(new RegExp(`<${tag}[ >]`, "g")) || []).length, (x.match(new RegExp(`</${tag}>`, "g")) || []).length, tag);
  }
  const esc = toFCPXML({ name: `A & B <"x">`, shots: [{ id: "s", name: "it's", frames: 2 }], cut: [{ shot_id: "s", in: 0, out: 2 }] });
  assert.ok(esc.includes('<project name="A &amp; B &lt;&quot;x&quot;&gt;">'));
  assert.ok(esc.includes('name="it&apos;s"'));
});

test("exportAll: one file per NLE format, named after the project", () => {
  assert.deepEqual(Object.keys(exportAll(demo())), ["Diner_Night_v1.edl", "Diner_Night_v1_avid_locators.txt", "Diner_Night_v1_premiere.xml",
                                                    "Diner_Night_v1.fcpxml", "Diner_Night_v1.otio", "RELINK.txt"]);
  const relink = exportAll(demo())["RELINK.txt"];
  assert.match(relink, /^SC2_MASTER\tdraft\tdemo_media\/draft_sc2_master\.mp4\tDRAFT stand-in: relink to the Final render$/m);
  assert.ok(!relink.includes("SC2_SINGLE_B"), "finals need no relink");
});

test("EDL audio events: A / A2 channels, record TC where the clip sits, gain and fades noted", () => {
  const edl = toEDL(demo());
  assert.match(edl, /^008  RAIN_ON_ A {5}C {8}00:00:00:00 00:00:04:00 01:00:00:00 01:00:04:00$/m);
  assert.match(edl, /^\* SOUNDSTAGE AUDIO: GAIN -6.0 DB, FADE IN 12, FADE OUT 24$/m);
  assert.match(edl, /^009  DOOR_CHI A2 {4}C {8}00:00:00:00 00:00:01:12 01:00:07:12 01:00:09:00$/m);
});

test("Avid locators: Notes2Markers layout, one locator per frame, relink flags", () => {
  const txt = toAvidLocators(demo());
  const rows = txt.trim().split("\n").map((l) => l.split("\t"));
  for (const r of rows) {
    assert.equal(r.length, 8);
    assert.match(r[1], /^\d\d:\d\d:\d\d:\d\d$/);
    assert.equal(r[2], "V1");
    assert.equal(r[3], r[7]);
    assert.equal(r[6], "");
  }
  const frames = locatorEntries(demo()).map((e) => e.frame);
  assert.equal(new Set(frames).size, frames.length, "never two locators on one frame");
  assert.ok(rows.some((r) => r[0] === "ADVISOR" && r[1] === "01:00:03:08" && r[3] === "Yellow"));
  // note + relink on the same first frame are merged
  assert.ok(rows.some((r) => r[1] === "01:00:02:12" && r[4].includes("Look approved") && r[4].includes("LOOK stand-in")));
  assert.ok(!/[^\x00-\xff]/.test(toAvidLocators({ shots: [{ id: "a", name: "Scène — 1", frames: 4, notes: "“quote”" }], cut: [{ shot_id: "a" }] })));
});

test("Premiere XML (xmeml v5): V1 clipitems, audio tracks, file reuse, levels and fades", () => {
  const x = toXMEML(demo());
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">'));
  assert.equal((x.match(/<clipitem /g) || []).length, 7 + 2);
  assert.equal((x.match(/<track>/g) || []).length, 1 + 2);
  assert.match(x, /<string>01:00:00:00<\/string>/);
  assert.equal((x.match(/<file id="file-1">/g) || []).length, 1, "SC1_MASTER's file is written once");
  assert.equal((x.match(/<file id="file-1"\/>/g) || []).length, 1, "and referenced the second time");
  assert.match(x, /<value>0\.501187<\/value>/); // -6 dB
  assert.equal((x.match(/<transitionitem>/g) || []).length, 2);
  for (const tag of ["xmeml", "sequence", "media", "video", "audio", "track", "clipitem", "file", "rate"]) {
    assert.equal((x.match(new RegExp(`<${tag}(>| [^>]*[^/]>)`, "g")) || []).length, (x.match(new RegExp(`</${tag}>`, "g")) || []).length, tag);
  }
});

test("audio model: lanes, mute/solo, ripple with sync lock, trims, fades, split", () => {
  const p = TL.normalizeProject({ shots: [{ id: "s", frames: 100 }], cut: [{ shot_id: "s" }],
    audio: [{ id: "a", track: 1, url: "a.wav", start_frame: 0, out: 50 }, { id: "b", track: 1, url: "b.wav", start_frame: 20, out: 10 },
            { id: "c", track: 2, url: "c.wav", start_frame: 60, out: 10, fade_in: 99 }, { id: "d", track: 3, url: "d.wav" }],
    audio_tracks: [{ track: 2, mute: true }] });
  assert.deepEqual(TL.audioLanes(p).map((l) => [l.name, l.clips.map((a) => a.id)]), [["A1", ["a"]], ["A1b", ["b"]], ["A2", ["c"]]]);
  assert.equal(p.audio[2].fade_in, 10, "fades are clamped to the clip");
  assert.equal(p.audio[3].out, null, "length unknown until decoded; left out of exports");
  assert.equal(TL.audible(p, 2), false);
  assert.equal(TL.audible({ ...p, audio_tracks: [{ track: 2, mute: true }, { track: 1, solo: true }] }, 1), true);
  assert.equal(TL.audible({ ...p, audio_tracks: [{ track: 1, solo: true }] }, 2), false);
  assert.deepEqual(TL.rippleAudio(p.audio, 30, -15).map((a) => a.start_frame), [0, 15, 45, 0]);
  assert.deepEqual(TL.rippleAudio(p.audio, 10, 5).map((a) => a.start_frame), [0, 25, 65, 0]);
  const t = TL.trimAudio(p, "b", "in", 4).find((a) => a.id === "b");
  assert.deepEqual([t.in, t.start_frame, t.out], [4, 24, 10], "head trim keeps sync");
  assert.equal(TL.fadeAudio(p, "a", "out", 80).find((a) => a.id === "a").fade_out, 50);
  const sp = TL.splitAudio(p, "a", 20);
  assert.deepEqual(sp.filter((a) => a.url === "a.wav").map((a) => [a.start_frame, a.in, a.out]), [[0, 0, 20], [20, 20, 50]]);
  assert.equal(TL.sequenceFrames({ ...p, audio: [{ ...p.audio[0], start_frame: 90 }] }), 140);
  assert.equal(TL.freeTrack(p, 5, 10), 2);
  assert.equal(TL.freeTrack(p, 62, 4), 1);
  assert.equal(TL.freeTrack({ ...p, audio: [...p.audio, { id: "e", track: 2, start_frame: 0, out: 30, in: 0 }] }, 25, 4), 3);
});

// ---------------------------------------------------------------- edit model

test("normalize drops unknown shots and clamps in/out", () => {
  const p = TL.normalizeProject({ shots: [{ id: "a", frames: 10 }], cut: [{ shot_id: "a", in: -5, out: 99 }, { shot_id: "zz", in: 0, out: 4 }, { shot_id: "a", in: 9, out: 3 }] });
  assert.deepEqual(p.cut, [{ shot_id: "a", in: 0, out: 10 }, { shot_id: "a", in: 9, out: 10 }]);
});

test("cut on action: setups of one scene continue the scene clock", () => {
  const p = demo();
  const sh = TL.shotMap(p);
  assert.equal(TL.actionMatchIn(sh.get("sc1_master"), 60, sh.get("sc1_ots_a")), 60);
  assert.equal(TL.actionMatchIn(sh.get("sc1_ots_b"), 150, sh.get("sc1_insert")), 10); // insert starts at scene 140
  assert.equal(TL.actionMatchIn(sh.get("sc1_master"), 60, sh.get("sc2_master")), null); // different scene
  assert.equal(TL.actionMatchIn(sh.get("sc1_master"), 60, sh.get("sc1_master")), null); // same setup
  // inserting OTS B after event 0 matches its in point to the master's out
  const cut = TL.insertShot(p, "sc1_ots_b", 1);
  assert.deepEqual(cut[1], { shot_id: "sc1_ots_b", in: 60, out: 192 });
  // explicit in/out wins
  assert.deepEqual(TL.insertShot(p, "sc1_ots_b", 1, { in: 5, out: 9 })[1], { shot_id: "sc1_ots_b", in: 5, out: 9 });
  assert.equal(TL.actionInAtRecord(p, 30, "sc1_ots_b"), 30);
});

test("move, ripple trims, roll, split, ripple delete, extract, overwrite", () => {
  const p = demo();
  const total = TL.totalFrames(p);
  // move last event to the front
  const moved = TL.moveEvent(p, 6, 0, { action: false });
  assert.equal(moved[0].shot_id, "sc2_single_b");
  assert.equal(moved.length, p.cut.length);
  // ripple trims clamp to the media
  assert.deepEqual(TL.trimOut(p, 0, 1000)[0], { shot_id: "sc1_master", in: 0, out: 192 });
  assert.deepEqual(TL.trimIn(p, 0, 1000)[0], { shot_id: "sc1_master", in: 59, out: 60 });
  assert.equal(TL.totalFrames({ ...p, cut: TL.trimOut(p, 0, 12) }), total + 12);
  // roll keeps the total and moves both sides
  const rolled = TL.roll(p, 1, 10);
  assert.equal(TL.totalFrames({ ...p, cut: rolled }), total);
  assert.equal(rolled[0].out, 70);
  assert.equal(rolled[1].in, 70);
  assert.equal(TL.roll(p, 1, -1000)[1].in, 1, "roll clamps to keep one frame");
  // split
  const split = TL.splitAt(p, 30);
  assert.deepEqual(split.slice(0, 2), [{ shot_id: "sc1_master", in: 0, out: 30 }, { shot_id: "sc1_master", in: 30, out: 60 }]);
  assert.deepEqual(TL.splitAt(p, 60), p.cut, "split on an edit point is a no-op");
  // ripple delete
  assert.equal(TL.totalFrames({ ...p, cut: TL.rippleDelete(p, 0) }), total - 60);
  // extract across an edit
  const ex = TL.extractRange(p, 50, 70);
  assert.equal(TL.totalFrames({ ...p, cut: ex }), total - 20);
  assert.deepEqual(ex.slice(0, 2), [{ shot_id: "sc1_master", in: 0, out: 50 }, { shot_id: "sc1_ots_a", in: 70, out: 110 }]);
  // overwrite keeps the total and drops the shot in at the marked range
  const ow = TL.overwrite(p, 20, 40, "sc1_ots_b", 20);
  assert.equal(TL.totalFrames({ ...p, cut: ow }), total);
  assert.deepEqual(ow.slice(0, 3), [{ shot_id: "sc1_master", in: 0, out: 20 }, { shot_id: "sc1_ots_b", in: 20, out: 40 }, { shot_id: "sc1_master", in: 40, out: 60 }]);
});

test("string-out assembles every shot once", () => {
  const p = demo();
  const cut = TL.stringOut({ ...p, cut: [] });
  assert.equal(cut.length, p.shots.length);
  assert.deepEqual(cut.map((e) => e.shot_id), p.shots.map((s) => s.id));
});
