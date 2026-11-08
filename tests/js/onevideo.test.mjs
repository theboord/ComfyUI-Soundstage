// node --test tests/js/onevideo.test.mjs
// Cut → one video guard (web/onevideo.mjs): decided on the RAW cut, before flattening. All test data is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkOneVideo, localOneVideoSupport, oneVideoClips, findHook, gapFrames, leftOut } from "../../web/onevideo.mjs";

const today = { cut: [{ shot_id: "s1", in: 0, out: 48 }, { shot_id: "s2", in: 12, out: 36, take: { url: "/view?filename=t.mp4&type=output", rung: "final" } }] };

test("today's cut (shots, a pinned take) is fine with the local rules", () => {
  const r = checkOneVideo(today);
  assert.equal(r.ok, true);
  assert.equal(r.message, "");
  assert.equal(r.source, "local");
});

test("gaps only: not refused, flagged gapsOnly", () => {
  const raw = { cut: [today.cut[0], { kind: "gap", in: 48, out: 60 }, today.cut[1], { kind: "gap", in: 0, out: 5 }] };
  const r = checkOneVideo(raw);
  assert.equal(r.ok, false);
  assert.equal(r.gapsOnly, true);
  assert.equal(r.message, "");
  assert.deepEqual(r.reasons.map((x) => x.code), ["gaps"]);
});

test("gaps + an upper picture track: refused with the plain message", () => {
  const raw = { cut: [today.cut[0], { kind: "gap", in: 0, out: 12 }, { kind: "gap", frames: 6 }, today.cut[1]],
    video_tracks: [{ clips: [{ shot_id: "s3", in: 0, out: 10, start: 20 }] }, { clips: [] }] };
  const r = checkOneVideo(raw);
  assert.equal(r.gapsOnly, false);
  assert.equal(r.message, "This cut has gaps (2) and an upper picture track; one-video export can't include them yet.");
});

test("detached audio, unknown kinds, clips with no shot, gaps with no length are each named", () => {
  const raw = { cut: [{ shot_id: "s1", in: 0, out: 10, audio_detached: true }, { shot_id: "s2", in: 0, out: 10, audio_detached: { offset: 3 } },
    { kind: "title", text: "THE END" }, { in: 0, out: 3 }, { kind: "gap" }, null], video: [{ shot_id: "s9" }] };
  const r = localOneVideoSupport(raw);
  assert.deepEqual(r.reasons.map((x) => x.code).sort(), ["audio_detached", "bad_gap", "no_shot", "unknown_kind", "upper_video"]);
  const m = checkOneVideo(raw).message;
  assert.match(m, /detached audio on 2 clips/);
  assert.match(m, /"title"/);
  assert.match(m, /an upper picture track/);
  assert.match(m, /can't include them yet\.$/);
});

test("audio_detached: false and a zero-length gap are not reasons", () => {
  const r = localOneVideoSupport({ cut: [{ shot_id: "s1", in: 0, out: 4, audio_detached: false }, { kind: "gap", in: 5, out: 5 }] });
  assert.equal(r.ok, true);
});

test("the Cut's hook wins; a throwing or malformed hook falls back to the local rules", () => {
  const hook = () => ({ ok: false, reasons: [{ code: "speed", count: 1, text: "a speed change" }] });
  const r = checkOneVideo(today, hook);
  assert.equal(r.source, "cut");
  assert.equal(r.message, "This cut has a speed change; one-video export can't include it yet.");
  assert.equal(checkOneVideo(today, () => { throw new Error("x"); }).source, "local");
  assert.equal(checkOneVideo(today, () => "yes").source, "local");
  const gapsByHook = checkOneVideo(today, () => ({ ok: false, reasons: ["gaps (3)"] }));
  assert.equal(gapsByHook.gapsOnly, true);
  assert.equal(checkOneVideo(today, () => ({ ok: false })).message, "This cut has something it can't include; one-video export can't include them yet.");
});

test("findHook picks the first module that exports oneVideoSupport", () => {
  const f = () => ({ ok: true, reasons: [] });
  assert.equal(findHook({}, { oneVideoSupport: f }), f);
  assert.equal(findHook({ oneVideoSupport: 3 }, null), null);
});

test("oneVideoClips keeps cut order, turns gaps into {gap, frames}", () => {
  const raw = { cut: [today.cut[0], { kind: "gap", in: 100, out: 112 }, today.cut[1], { kind: "gap", in: 0, out: 0 }] };
  const clips = oneVideoClips(raw, { shotName: (id) => id.toUpperCase(), shotFile: (e) => ({ file: e.take ? { filename: "t.mp4" } : null, kind: e.take ? "final" : null }) });
  assert.deepEqual(clips.map((c) => (c.gap ? `gap${c.frames}` : c.name)), ["S1", "gap12", "S2"]);
  assert.deepEqual(clips[1], { gap: true, frames: 12, in: 0, out: 12 });
  assert.equal(clips[2].kind, "final");
});

test("gapFrames: frames/length/duration first, else out - in", () => {
  assert.equal(gapFrames({ frames: 7, in: 0, out: 100 }), 7);
  assert.equal(gapFrames({ in: 10, out: 34 }), 24);
  assert.ok(Number.isNaN(gapFrames({})));
});

test("leftOut names what the quick join never had", () => {
  assert.deepEqual(leftOut({ cut: [{ shot_id: "a", trans: { type: "dissolve", frames: 8 } }], titles: [{ text: "x" }], audio: [{ id: "m" }] }),
    ["1 transition", "titles", "the sound tracks"]);
});

test("soundstage.js checks the raw cut before flattening; cutEntries keeps its shot filter", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  const a = src.indexOf("async function flattenCut()");
  const body = src.slice(a, src.indexOf("api.fetchApi(\"/soundstage/cut/render_video\"", a));
  assert.ok(body.indexOf("checkOneVideo(raw") > 0 && body.indexOf("checkOneVideo(raw") < body.indexOf("oneVideoClips("));
  assert.match(body, /if \(support\.message\) \{[^}]*return; \}/);
  assert.match(src, /const cutEntries = \(\) => \(loadCut\(\)\.cut \|\| \[\]\)\.filter\(\(e\) => e && e\.shot_id\);/);
});
