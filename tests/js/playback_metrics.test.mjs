// The playback bench's math (tools/qa/playback_metrics.mjs) on synthetic screen timelines, and its cut generator
// (tools/qa/playback_fixture.mjs). No browser: these pin down what "dropped", "held", "A/V offset" and "hitch" mean.
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../../tools/qa/playback_metrics.mjs";
import { buildFixture } from "../../tools/qa/playback_fixture.mjs";

const FPS = 24, VS = 1000 / 60, FRAME = 1000 / FPS;

/** rAF ticks at 60 Hz over `frames` timeline frames; picture(tl, i) gives {key, src} drawn that tick (or null). */
function ticks(frames, picture, { t0 = 1000, au = false } = {}) {
  const out = [];
  for (let i = 0; ; i++) {
    const t = t0 + i * VS;
    const tl = Math.floor((t - t0) / FRAME + 1e-9);
    if (tl >= frames) break;
    const draw = picture(tl, i);
    // An audio clock in step with the timeline: the output plays context time (t - t0) / 1000 at performance time t.
    out.push({ t, tl, draw, au: au ? { ctx: (t - t0) / 1000, perf: t, t0: 0, from: 0, running: true } : null });
  }
  return out;
}

const ONE = [{ index: 0, recIn: 0, recOut: 48, in: 10, key: "A" }];

test("stats and holdLimit", () => {
  const s = M.stats(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(s.median, 50); assert.equal(s.p95, 95); assert.equal(s.max, 100); assert.equal(s.n, 100);
  assert.equal(M.stats([]).n, 0);
  assert.ok(Math.abs(M.holdLimit(24, 1000 / 60) - 58.333) < 0.01);   // 24p on 60 Hz: 2-3 vsyncs is normal, 4 is a hold
  assert.ok(Math.abs(M.holdLimit(24, 1000 / 120) - 45.833) < 0.01);
});

test("perfect 24p on a 60 Hz display drops nothing", () => {
  const seq = M.screenTimeline(ticks(48, (tl) => ({ key: "A", src: 10 + tl })), ONE);
  const d = M.countDrops(seq, ONE, { fps: FPS, vsync: VS, from: 1, to: 48 });
  assert.equal(d.lost, 0); assert.equal(d.heldExcess, 0); assert.equal(d.dropped, 0);
  assert.equal(d.checked, 47);
});

test("a skipped frame: lost, and its neighbour held over two slots, counted once", () => {
  const seq = M.screenTimeline(ticks(48, (tl) => ({ key: "A", src: 10 + (tl === 20 ? 21 : tl) })), ONE);
  const d = M.countDrops(seq, ONE, { fps: FPS, vsync: VS, from: 1, to: 48 });
  assert.deepEqual(d.lostFrames, [20]);
  assert.deepEqual(d.heldFrames, [21]);   // frame 21's picture went up a slot early and stayed for two (83 ms)
  assert.equal(d.dropped, 1);
});

test("a stall (one picture held over two more slots, then a jump) counts its two slots once", () => {
  const seq = M.screenTimeline(ticks(48, (tl) => ({ key: "A", src: 10 + (tl >= 20 && tl < 23 ? 20 : tl) })), ONE);
  const d = M.countDrops(seq, ONE, { fps: FPS, vsync: VS, from: 1, to: 48 });
  assert.deepEqual(d.lostFrames, [21, 22]);
  assert.deepEqual(d.heldFrames, [21, 22]);
  assert.equal(d.holds.length, 1); assert.ok(d.holds[0].ms > 100 && d.holds[0].ms < 150);
  assert.equal(d.dropped, 2);
});

test("a tick that draws nothing leaves the last picture up (and that can be a hold)", () => {
  const seq = M.screenTimeline(ticks(48, (tl) => (tl >= 30 && tl < 33 ? null : { key: "A", src: 10 + tl })), ONE);
  assert.equal(seq.find((s) => s.tl === 31).shown.src, 39);   // still frame 29's picture
  const d = M.countDrops(seq, ONE, { fps: FPS, vsync: VS, from: 1, to: 48 });
  assert.deepEqual(d.lostFrames, [30, 31, 32]); assert.equal(d.dropped, 3);
});

test("a clip that starts one frame late: a held first frame and a last frame never shown, counted once", () => {
  const seq = M.screenTimeline(ticks(48, (tl) => ({ key: "A", src: 10 + Math.max(0, tl - 1) })), ONE);
  const d = M.countDrops(seq, ONE, { fps: FPS, vsync: VS, from: 0, to: 48 });
  assert.deepEqual(d.lostFrames, [47]);
  assert.equal(d.heldExcess, 1);
  assert.equal(d.dropped, 1);
});

test("A/V offset: in step is within half a frame, two frames early reads about +83 ms", () => {
  const inStep = M.screenTimeline(ticks(96, (tl) => ({ key: "A", src: tl }), { au: true }), [{ index: 0, recIn: 0, recOut: 96, in: 0, key: "A" }]);
  // The picture is presented one vsync after its tick; an in-step picture sits within +-0.5 frame (+-21 ms) of the sound.
  const a = M.stats(M.avOffsets(inStep, [{ index: 0, recIn: 0, recOut: 96, in: 0, key: "A" }], { fps: FPS, presentMs: 0, settleMs: 0 }));
  assert.ok(Math.abs(a.median) <= FRAME / 2 + 1, `median ${a.median}`);
  assert.ok(a.max <= FRAME / 2 + 1 && a.min >= -FRAME / 2 - 1);
  const early = M.screenTimeline(ticks(96, (tl) => ({ key: "A", src: Math.min(95, tl + 2) }), { au: true }), [{ index: 0, recIn: 0, recOut: 96, in: 0, key: "A" }]);
  const b = M.stats(M.avOffsets(early, [{ index: 0, recIn: 0, recOut: 96, in: 0, key: "A" }], { fps: FPS, presentMs: 0, settleMs: 0 }));
  assert.ok(Math.abs(b.median - 2 * FRAME) < FRAME / 2 + 1, `median ${b.median}`);
  // No running audio clock: no offsets at all (the Cut then runs on the wall clock and nothing is heard).
  const noClock = inStep.map((s) => ({ ...s, au: s.au && { ...s.au, running: false } }));
  assert.equal(M.avOffsets(noClock, [{ index: 0, recIn: 0, recOut: 96, in: 0, key: "A" }], { fps: FPS }).length, 0);
});

test("cut hitch: the incoming clip three ticks late is a 50 ms hitch; never arriving is censored", () => {
  const rows = [{ index: 0, recIn: 0, recOut: 24, in: 0, key: "A" }, { index: 1, recIn: 24, recOut: 48, in: 0, key: "B" }];
  let firstB = null;
  const late = M.screenTimeline(ticks(48, (tl, i) => {
    if (tl < 24) return { key: "A", src: tl };
    firstB ??= i;
    return i - firstB < 3 ? null : { key: "B", src: tl - 24 };
  }), rows);
  const h = M.cutHitches(late, rows, { from: 1, to: 48 });
  assert.equal(h.length, 1); assert.equal(h[0].censored, false);
  assert.ok(Math.abs(h[0].hitchMs - 3 * VS) < 0.01, `hitch ${h[0].hitchMs}`);
  const never = M.screenTimeline(ticks(48, (tl) => (tl < 24 ? { key: "A", src: tl } : null)), rows);
  assert.equal(M.cutHitches(never, rows, { from: 1, to: 48 })[0].censored, true);
  // On time: the incoming frame up on the first tick of the clip.
  const onTime = M.screenTimeline(ticks(48, (tl) => (tl < 24 ? { key: "A", src: tl } : { key: "B", src: tl - 24 })), rows);
  assert.equal(M.cutHitches(onTime, rows, { from: 1, to: 48 })[0].hitchMs, 0);
  // The outgoing frame held two slots, then the clip moving but two frames late to its end: never in sync (censored),
  // yet its first picture came after ~83 ms, not after the whole clip.
  const lagging = M.screenTimeline(ticks(48, (tl) => (tl < 24 ? { key: "A", src: tl } : tl < 26 ? { key: "A", src: 23 } : { key: "B", src: tl - 26 })), rows);
  const g = M.cutHitches(lagging, rows, { from: 1, to: 48 })[0];
  assert.equal(g.censored, true); assert.equal(g.lagFrames, 2);
  assert.ok(Math.abs(g.firstPicMs - 2 * FRAME) <= VS, `first picture ${g.firstPicMs}`);
  assert.ok(g.hitchMs > 20 * FRAME);
});

test("a take cut against itself: a picture belongs to the row whose record position is nearest", () => {
  const rows = [{ index: 0, recIn: 0, recOut: 24, in: 50, key: "A" }, { index: 1, recIn: 24, recOut: 48, in: 40, key: "A" }];
  // Frame 70 is in both rows' source ranges (row 0: rec 20; row 1: rec 54); at tl 24 it is row 0's held tail.
  assert.deepEqual(M.rowOfShown(rows, { key: "A", src: 70 }, 24), { row: 0, rec: 20 });
  assert.deepEqual(M.rowOfShown(rows, { key: "A", src: 63 }, 47), { row: 1, rec: 47 });
  const seq = M.screenTimeline(ticks(48, (tl) => ({ key: "A", src: tl < 24 ? 50 + tl : 40 + (tl - 24) })), rows);
  assert.equal(M.countDrops(seq, rows, { fps: FPS, vsync: VS, from: 1, to: 48 }).dropped, 0);
});

test("seek and key reaction latencies use the time the tick ran", () => {
  const rows = [{ index: 0, recIn: 0, recOut: 100, in: 0, key: "A" }];
  const seq = M.screenTimeline([
    { t: 100, run: 100, tl: 10, draw: { key: "A", src: 10 } },
    { t: 116, run: 130, tl: 50, draw: { key: "A", src: 10 } },
    { t: 133, run: 150, tl: 50, draw: { key: "A", src: 50 } },
  ], rows);
  assert.deepEqual(M.seekLatencies(seq, rows, [{ t: 120, frame: 50 }]), [{ frame: 50, ms: 30 }]);
  assert.equal(M.reactionMs(seq, rows, 105, (rec) => rec > 10), 45);
});

test("the bench cut: 60 s on whole frames, 2-5 s events, takes reused, a jump cut and clay", () => {
  const media = [113, 113, 145, 145, 145, 113].map((frames, i) => ({ filename: `t${i}.mp4`, subfolder: "s", frames, rung: i === 5 ? "draft" : "final", width: 2624, height: 1408 }));
  const a = buildFixture(media, { seconds: 60, seed: 8, clay: 2 });
  const b = buildFixture(media, { seconds: 60, seed: 8, clay: 2 });
  assert.deepEqual(a, b);   // deterministic
  const { project, notes } = a;
  assert.equal(notes.totalFrames, 1440);
  assert.equal(project.cut.reduce((n, e) => n + e.out - e.in, 0), 1440);
  const shots = new Map(project.shots.map((s) => [s.id, s]));
  for (const [i, e] of project.cut.entries()) {
    const len = e.out - e.in;
    assert.ok(Number.isInteger(e.in) && Number.isInteger(e.out));
    assert.ok(e.in >= 0 && e.out <= shots.get(e.shot_id).frames, `event ${i} inside its take`);
    if (i < project.cut.length - 1) assert.ok(len >= 48 && len <= 120, `event ${i} is ${len} frames`);
  }
  assert.ok(notes.clayEvents >= 1);
  assert.ok(project.cut.some((e) => !Object.keys(shots.get(e.shot_id).renders).length));
  assert.ok(notes.jumpCut > 0);
  const uses = new Map();
  for (const e of project.cut) uses.set(e.shot_id, (uses.get(e.shot_id) || 0) + 1);
  assert.ok([...uses.entries()].filter(([id]) => id.startsWith("take")).every(([, n]) => n >= 2), "every take used twice or more");
  assert.match(project.shots[0].renders.final, /^\/api\/view\?filename=t0\.mp4&subfolder=s&type=output$/);
});
