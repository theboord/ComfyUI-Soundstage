// node --test tests/js/onevideo.test.mjs
// Cut → one video guard (web/onevideo.mjs): decided on the RAW cut, before flattening. All test data is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkOneVideo, localOneVideoSupport, oneVideoClips, findHook, gapFrames, leftOut, exactFps, maxGapFrames, longGaps, MAX_GAP_SECONDS } from "../../web/onevideo.mjs";

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
  // only a STRUCTURED {code: "gaps"} (or "gap") unlocks the gap path; plain text always refuses
  assert.equal(checkOneVideo(today, () => ({ ok: false, reasons: [{ code: "gap", count: 3, text: "gaps (3)" }] })).gapsOnly, true);
  const text = checkOneVideo(today, () => ({ ok: false, reasons: ["gaps (3)"] }));
  assert.equal(text.gapsOnly, false);
  assert.equal(text.message, "This cut has gaps (3); one-video export can't include it yet.");
  assert.equal(checkOneVideo(today, () => ({ ok: false })).message, "This cut has something it can't include; one-video export can't include it yet.");
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

test("gapFrames: out - in first; integer frames next; duration is SECONDS x exact fps, only with no in/out", () => {
  assert.equal(gapFrames({ in: 0, out: 36, duration: 1.5 }), 36);           // never duration-as-frames
  assert.equal(gapFrames({ in: 0, out: 36, duration: 1.5 }, { fps: 24 }), 36);
  assert.equal(gapFrames({ frames: 7, in: 0, out: 100 }), 100);
  assert.equal(gapFrames({ in: 10, out: 34 }), 24);
  assert.equal(gapFrames({ frames: 7 }), 7);
  assert.ok(Number.isNaN(gapFrames({ frames: 7.5 })));                        // not a frame count
  assert.ok(Number.isNaN(gapFrames({ out: 12 })));                            // in missing, no frames
  assert.ok(Number.isNaN(gapFrames({ duration: 2 })));                        // seconds, but no fps to read them at
  assert.equal(gapFrames({ duration: 2 }, { fps: 24 }), 48);
  assert.equal(gapFrames({ duration: 1.001 }, { fps: 23.976 }), 24);          // 24000/1001 exactly
  assert.equal(gapFrames({ duration: 10.01 }, { fps: 29.97 }), 300);
  assert.ok(Number.isNaN(gapFrames({ in: 0, duration: 2 }, { fps: 24 })));   // in present: duration not used
  assert.ok(Number.isNaN(gapFrames({ dur: 12 })));
  assert.ok(Number.isNaN(gapFrames({})));
  assert.deepEqual(exactFps(23.976), [24000, 1001]);
  assert.deepEqual(exactFps("30000/1001"), [30000, 1001]);
  assert.deepEqual(exactFps(25), [25, 1]);
  assert.equal(exactFps(0), null);
});

test("the App measures every gap itself: a hook that says ok for an unmeasurable gap is refused, nothing dropped", () => {
  const raw = { cut: [today.cut[0], { kind: "gap", dur: 12 }, today.cut[1]] };
  const okHook = () => ({ ok: true, reasons: [] });
  const r = checkOneVideo(raw, okHook, { fps: 24 });
  assert.equal(r.source, "cut");
  assert.equal(r.ok, false);
  assert.equal(r.gapsOnly, false);
  assert.equal(r.message, "This cut has 1 gap with no length it can read; one-video export can't include it yet.");
  // a gaps-only hook answer plus an unmeasurable gap: refused too
  const g = checkOneVideo({ cut: [today.cut[0], { kind: "gap", in: 0, out: 6 }, { kind: "gap", out: 9 }] },
    () => ({ ok: false, reasons: [{ code: "gaps", count: 2, text: "gaps (2)" }] }));
  assert.equal(g.gapsOnly, false);
  assert.match(g.message, /^This cut has gaps \(2\) and 1 gap with no length it can read; .* them yet\.$/);
  // oneVideoClips never drops it to make a shorter video
  assert.throws(() => oneVideoClips(raw, { fps: 24 }), /gap with no length it can read/);
  // a measurable gap the hook said ok to is joined at its length
  const fine = checkOneVideo({ cut: [today.cut[0], { kind: "gap", in: 0, out: 36, duration: 1.5 }] }, okHook, { fps: 24 });
  assert.equal(fine.message, "");
  assert.deepEqual(oneVideoClips({ cut: [{ kind: "gap", in: 0, out: 36, duration: 1.5 }] }, { fps: 24 }), [{ gap: true, frames: 36, in: 0, out: 36 }]);
});

test("a hook reason with another code (or plain text) refuses even when it mentions a gap", () => {
  for (const reasons of [["upper track gap overlaps"], [{ code: "upper_video", text: "upper track gap overlaps" }]]) {
    const r = checkOneVideo(today, () => ({ ok: false, reasons }));
    assert.equal(r.gapsOnly, false);
    assert.equal(r.message, "This cut has upper track gap overlaps; one-video export can't include it yet.");
  }
});

test("audio_detached: only a truthy value is detached (0, false, '' and null are not)", () => {
  for (const v of [0, false, "", null]) assert.equal(localOneVideoSupport({ cut: [{ shot_id: "s1", in: 0, out: 4, audio_detached: v }] }).ok, true);
  for (const v of [1, true, { offset: 2 }]) assert.equal(localOneVideoSupport({ cut: [{ shot_id: "s1", in: 0, out: 4, audio_detached: v }] }).reasons[0].code, "audio_detached");
});

test("leftOut names what the quick join never had", () => {
  assert.deepEqual(leftOut({ cut: [{ shot_id: "a", trans: { type: "dissolve", frames: 8 } }], titles: [{ text: "x" }], audio: [{ id: "m" }] }),
    ["1 transition", "titles", "the sound tracks"]);
});

test("soundstage.js checks the raw cut before flattening; cutEntries keeps its shot filter", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  const a = src.indexOf("async function flattenCut()");
  const body = src.slice(a, src.indexOf("api.fetchApi(\"/soundstage/cut/render_video\"", a));
  assert.ok(body.indexOf("oneVideoGuard(raw, fps)") > 0 && body.indexOf("oneVideoGuard(raw, fps)") < body.indexOf("oneVideoClips("));
  assert.match(body, /if \(support\.message\) \{[^}]*return; \}/);
  assert.match(src, /const cutEntries = \(\) => \(loadCut\(\)\.cut \|\| \[\]\)\.filter\(\(e\) => e && e\.shot_id\);/);
  assert.match(body, /catch \(err\) \{ cutOut\.textContent = err\.message; status\.textContent = err\.message; return; \}/);   // unmeasurable gap
});

test("Render missing shots runs the one-video guard on the raw cut before queueing any Final", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  const a = src.indexOf("async function renderMissing()");
  const body = src.slice(a, src.indexOf("app.queuePrompt(", a));
  const g = body.indexOf("oneVideoGuard(loadCut(), cutFps())");
  assert.ok(g > 0, "guard called");
  assert.match(body.slice(g), /^oneVideoGuard\(loadCut\(\), cutFps\(\)\);\n\s*if \(guard\.message\) \{ const m = `\$\{guard\.message\} Nothing was queued\.`; cutOut\.textContent = m; status\.textContent = m; return; \}/);
  assert.ok(g < body.indexOf("savedRenders()") && g < body.indexOf("flattenCut()"));
  assert.match(src, /const oneVideoGuard = \(raw, fps\) => checkOneVideo\(raw, findOneVideoHook\(CutModule, CutTimeline\), \{ fps \}\);/);
});

test("a gap longer than 10 minutes is refused, whatever the hook says (no disk-filling join)", () => {
  assert.equal(MAX_GAP_SECONDS, 600);
  assert.equal(maxGapFrames(24), 14400);
  assert.equal(maxGapFrames(23.976), 14385);                                  // floor(600 * 24000 / 1001)
  assert.equal(maxGapFrames(29.97), 17982);
  assert.equal(maxGapFrames(null), 14400);                                    // unusable rate: the server's 24
  const huge = { cut: [today.cut[0], { kind: "gap", in: 0, out: 1e12 }] };
  const r = checkOneVideo(huge, null, { fps: 24 });
  assert.equal(r.gapsOnly, false);
  assert.equal(r.message, "This cut has a gap longer than 10 minutes; one-video export can't include it yet.");
  const okHook = () => ({ ok: true, reasons: [] });
  assert.equal(checkOneVideo(huge, okHook, { fps: 24 }).message, r.message);
  const gapsHook = () => ({ ok: false, reasons: [{ code: "gaps", count: 1, text: "gaps (1)" }] });
  assert.equal(checkOneVideo(huge, gapsHook, { fps: 24 }).gapsOnly, false);
  assert.throws(() => oneVideoClips(huge, { fps: 24 }), /a gap longer than 10 minutes/);
  // seconds read at the rate: 601 s refused, exactly 10 minutes joined
  assert.equal(longGaps({ cut: [{ kind: "gap", duration: 601 }] }, { fps: 24 }), 1);
  const edge = { cut: [today.cut[0], { kind: "gap", in: 0, out: 14400 }] };
  assert.equal(checkOneVideo(edge, null, { fps: 24 }).gapsOnly, true);
  assert.equal(checkOneVideo({ cut: [today.cut[0], { kind: "gap", in: 0, out: 14401 }] }, null, { fps: 24 }).gapsOnly, false);
  // two long gaps plus a normal one
  const two = localOneVideoSupport({ cut: [{ kind: "gap", frames: 20000 }, { kind: "gap", frames: 1e9 }, { kind: "gap", frames: 6 }] }, { fps: 24 });
  assert.deepEqual(two.reasons.map((x) => x.text), ["gaps (1)", "2 gaps longer than 10 minutes"]);
});
