// node --test tests/js/syncreview.test.mjs
// ⑥ Review: the synced 4-up player (web/review/*) and the old Review slider's fixes (web/ladder/ladder.mjs).
//
// What made the old slider fail (reproduced on the local try-it build, served by Python's http.server):
//   1. The server ignores HTTP Range requests, so a <video>'s seekable range is [0, 0] and `currentTime = t` snaps back
//      to 0: the Draft layer sat on frame 0 while the stage layer moved (measured: setFrame(60) -> draft.currentTime 0).
//   2. Playing the timeline asked every video for a new seek on every frame; seeks piled up and the picture redrew
//      about 4 times a second, mixing moments. Videos were never played, only seeked.
// Both are covered below, plus the new player's clock, mapping, layout, keys and file loading.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mp4Info, snapFps } from "../../web/review/mp4info.mjs";
import { MasterClock, tileFrame, tileRate, masterLength, driftAction, frameTime, timeFrame, gridLayout, keyAction, dropSlots, frameLabel, SPEEDS }
  from "../../web/review/syncclock.mjs";
import { coversDuration, loadClip } from "../../web/review/media.mjs";
import { shotReviewSources } from "../../web/review/sources.mjs";
import { LadderViewer } from "../../web/ladder/ladder.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

// ---------------------------------------------------------------- a tiny MP4 header, built by hand
const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const u32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4)); return b; };
function mp4({ timescale = 24000, delta = 1000, frames = 121, w = 960, h = 526, handler = "vide", moovLast = false, audioFirst = false } = {}) {
  const tkhd = box("tkhd", Buffer.alloc(76), u32(w * 65536, h * 65536));
  const mdhd = box("mdhd", u32(0, 0, 0, timescale, frames * delta, 0));
  const hdlr = (hd) => box("hdlr", u32(0, 0), Buffer.from(hd, "latin1"), Buffer.alloc(12));
  const stts = box("stts", u32(0, 2, frames - 1, delta, 1, delta + 7));   // the last frame's delta differs, as in real files
  const trak = (hd) => box("trak", tkhd, box("mdia", mdhd, hdlr(hd), box("minf", box("stbl", stts))));
  const moov = box("moov", box("mvhd", Buffer.alloc(100)), ...(audioFirst ? [trak("soun")] : []), trak(handler));
  const ftyp = box("ftyp", "isom", u32(0x200), "isomiso2");
  const mdat = box("mdat", Buffer.alloc(64));
  const all = moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

test("mp4Info reads fps, frame count and size from the header (moov first or last, audio track skipped)", () => {
  assert.deepEqual(mp4Info(mp4()), { fps: 24, frames: 121, duration: 121000 / 24000, width: 960, height: 526 });
  assert.equal(mp4Info(mp4({ moovLast: true })).frames, 121, "a moov at the end of the file (not fast-start)");
  assert.equal(mp4Info(mp4({ audioFirst: true })).fps, 24, "the sound track is not the video");
  assert.ok(Math.abs(mp4Info(mp4({ timescale: 30000, delta: 1001, frames: 59 })).fps - 30000 / 1001) < 1e-9, "29.97 stays exact");
  assert.equal(mp4Info(mp4({ timescale: 12800, delta: 512 })).fps, 25);
  assert.equal(mp4Info(mp4({ handler: "soun" })), null, "no video track");
  assert.equal(mp4Info(new ArrayBuffer(4)), null);
  assert.equal(mp4Info(new TextEncoder().encode("not a video file at all, just text").buffer), null);
  assert.equal(snapFps(23.9761), 24000 / 1001);
  assert.equal(snapFps(0), 0);
});

test("mp4Info never reads past a truncated file", () => {
  const full = new Uint8Array(mp4());
  for (const cut of [20, 60, 120, full.length - 30]) assert.doesNotThrow(() => mp4Info(full.slice(0, cut).buffer), `cut at ${cut}`);
});

// ---------------------------------------------------------------- mapping
test("tiles map by frame number (default) or by time; a short file holds its last frame", () => {
  const draft25 = { masterFps: 24, fps: 25, frames: 121 };
  assert.deepEqual(tileFrame(52, draft25), { frame: 52, held: false }, "by frame: frame 52 is frame 52 whatever the rate");
  assert.deepEqual(tileFrame(48, { ...draft25, map: "time" }), { frame: 50, held: false }, "by time: 2 s in is frame 50 at 25 fps");
  assert.deepEqual(tileFrame(48, { masterFps: 24, fps: 30000 / 1001, frames: 200, map: "time" }), { frame: 59, held: false });
  assert.deepEqual(tileFrame(130, { masterFps: 24, fps: 24, frames: 97 }), { frame: 96, held: true }, "a 97-frame draft holds 96");
  assert.deepEqual(tileFrame(-3, draft25), { frame: 0, held: false });
  assert.equal(tileRate(1, 24, 25, "frame"), 25 / 24, "by frame, a 25 fps file plays at 25/24 so its frames keep pace");
  assert.equal(tileRate(0.5, 24, 25, "time"), 0.5);
  assert.equal(masterLength([{ fps: 24, frames: 121 }, { fps: 25, frames: 151 }, null], 24, "frame"), 151);
  assert.equal(masterLength([{ fps: 24, frames: 121 }, { fps: 30, frames: 151 }], 24, "time"), 121);
  assert.equal(frameTime(52, 24), 52.5 / 24, "seek to the middle of the frame");
  assert.equal(timeFrame(52 / 24, 24), 52, "a presented frame's start time is that frame");
  assert.equal(frameLabel(52, false), "f 52");
  assert.equal(frameLabel(96, true), "f 96 · held");
  assert.deepEqual(SPEEDS, [0.25, 0.5, 0.75, 1]);
});

test("drift: one frame of display latency is left alone, more is re-seeked", () => {
  assert.equal(driftAction(52, 52).seek, false);
  assert.equal(driftAction(51, 52).seek, false);
  assert.equal(driftAction(53, 52).seek, false);
  assert.equal(driftAction(50, 52).seek, true);
  assert.equal(driftAction(120, 0).seek, true, "a tile that missed the loop point");
  assert.equal(driftAction(50, 52).drift, -2);
});

// ---------------------------------------------------------------- the master clock
const fakeNow = () => { const c = { t: 0 }; c.now = () => c.t; return c; };

test("master clock: plays at fps x speed, loops between In and Out, holds for a buffering tile", () => {
  const c = fakeNow();
  const m = new MasterClock({ fps: 24, length: 121, now: c.now });
  m.play(0);
  c.t = 1000; assert.equal(m.tick().frame, 24);
  m.setSpeed(0.25);
  c.t = 2000; assert.equal(m.tick().frame, 30, "a quarter speed: 6 frames a second");
  m.setSpeed(1);
  m.hold(true); c.t = 5000; assert.equal(m.tick().frame, 30, "held: the clock waits");
  m.hold(false); c.t = 5500; assert.equal(m.tick().frame, 42);
  m.setRange(40, 50);
  c.t = 6000; const r = m.tick();
  assert.equal(r.wrapped, true); assert.ok(r.frame >= 40 && r.frame <= 50, `wrapped into the loop (${r.frame})`);
  m.loop = false; m.play(45); c.t += 1000;
  const e = m.tick(); assert.deepEqual([e.ended, e.frame, m.playing], [true, 50, false], "loop off: stops on Out");
  assert.equal(m.pause(), 50);
});

test("master clock: a file that loads late lengthens the loop (the first build looped on frame 0 forever)", () => {
  const c = fakeNow();
  const m = new MasterClock({ fps: 24, length: 1, now: c.now });
  m.setLength(121);
  assert.deepEqual([m.inF, m.outF, m.ranged], [0, 120, false]);
  m.setRange(10, 20); m.setLength(200);
  assert.deepEqual([m.inF, m.outF], [10, 20], "a range you set is kept");
  m.clearRange(); assert.deepEqual([m.inF, m.outF], [0, 199]);
  m.play(199); assert.equal(m.frame, 0, "Play at the end starts again from In");
});

// ---------------------------------------------------------------- layout, keys, drops
test("grid layout: 2x2 on a normal screen, four across when wide, one column on a tall phone, two across when the height is free", () => {
  assert.deepEqual(gridLayout(1400, 760, 4).cols + "x" + gridLayout(1400, 760, 4).rows, "2x2");
  assert.equal(gridLayout(2400, 360, 4).cols, 4);
  assert.equal(gridLayout(360, 1500, 4).cols, 1);
  const free = gridLayout(358, 0, 4);
  assert.deepEqual([free.cols, free.rows], [2, 2]);
  assert.ok(2 * free.tw + 6 <= 358, "never wider than the phone");
  const g = gridLayout(1000, 600, 4);
  assert.ok(g.cols * g.tw + (g.cols - 1) * 6 <= 1000 && g.rows * g.th + (g.rows - 1) * 6 <= 600, "fits the box");
});

test("keys: arrows step (Shift x10), Space plays, I / O / L / X loop, 1-3 views, Esc", () => {
  assert.deepEqual(keyAction({ key: "ArrowRight" }), { step: 1 });
  assert.deepEqual(keyAction({ key: "ArrowLeft", shiftKey: true }), { step: -10 });
  assert.deepEqual(keyAction({ key: " " }), { toggle: true });
  assert.deepEqual(keyAction({ key: "i" }), { mark: "in" });
  assert.deepEqual(keyAction({ key: "O" }), { mark: "out" });
  assert.deepEqual(keyAction({ key: "l" }), { loop: true });
  assert.deepEqual(keyAction({ key: "2" }), { mode: "wipe" });
  assert.deepEqual(keyAction({ key: "3" }), { mode: "onion" });
  assert.equal(keyAction({ key: "2", metaKey: true }), null);
  assert.deepEqual(keyAction({ key: "Escape" }), { escape: true });
  assert.equal(keyAction({ key: "q" }), null);
});

test("dropped files fill the tile dropped on, then the empty tiles, then the rest", () => {
  assert.deepEqual(dropSlots(1, 2, [true, true, true, true]), [2]);
  assert.deepEqual(dropSlots(2, null, [true, false, true, false]), [1, 3]);
  assert.deepEqual(dropSlots(4, null, [false, false, false, false]), [0, 1, 2, 3]);
  assert.deepEqual(dropSlots(4, 3, [true, true, false, true]), [3, 2, 0, 1]);
  assert.deepEqual(dropSlots(9, null, [false, false, false, false]).length, 4);
});

// ---------------------------------------------------------------- seekable loading (root cause 1)
const ranges = (...r) => ({ length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] });

test("a video from a server without Range support is not seekable, and is read into a blob: URL", async () => {
  assert.equal(coversDuration({ duration: 5.04, seekable: ranges([0, 0]) }), false, "the frozen-Draft case from the test build");
  assert.equal(coversDuration({ duration: 5.04, seekable: ranges([0, 5.04]) }), true);
  assert.equal(coversDuration({ duration: NaN, seekable: ranges() }), true, "metadata not loaded yet: no verdict");
  const body = mp4();
  let asked = null;
  const fetchImpl = async (u) => { asked = u; return new Response(body, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(body.byteLength) } }); };
  const c = await loadClip("/view?filename=draft_00038_.mp4", { fetchImpl });
  assert.equal(asked, "/view?filename=draft_00038_.mp4");
  assert.equal(c.blob, true);
  assert.match(c.src, /^blob:/);
  assert.equal(c.info.frames, 121);
  c.revoke();
  const big = await loadClip("/huge.mp4", { fetchImpl, maxBytes: 10 });
  assert.deepEqual([big.blob, big.src], [false, "/huge.mp4"], "too big for memory: streams from the URL");
  const bad = await loadClip("/gone.mp4", { fetchImpl: async () => new Response("", { status: 404 }) });
  assert.deepEqual([bad.blob, bad.src], [false, "/gone.mp4"], "a failed fetch leaves the URL for the <video> to report");
  const file = await loadClip(new Blob([body], { type: "video/mp4" }));
  assert.equal(file.info.fps, 24, "a dropped file is read the same way");
});

// ---------------------------------------------------------------- the old slider (root cause 2)
test("ladder: while a seek is decoding, a new frame waits and is applied when it lands (no pile-up)", () => {
  let sets = 0;
  const el = { readyState: 4, duration: 5.04, seeking: false, _t: 0,
    get currentTime() { return this._t; }, set currentTime(v) { sets++; this._t = v; this.seeking = true; } };
  const s = { kind: "video", el };
  const fake = { frame: 10, stage: { state: { shot: { fps: 24 } } }, sources: { 3: s }, _drawSoon() { this.drawn = (this.drawn || 0) + 1; } };
  LadderViewer.prototype.seek.call(fake);
  assert.equal(sets, 1);
  for (const f of [11, 12, 13, 14]) { fake.frame = f; LadderViewer.prototype.seek.call(fake); }
  assert.equal(sets, 1, "four more frames while decoding: still one seek in flight");
  assert.equal(s.pending, 14.5 / 24, "only the newest target is kept");
  el.seeking = false;
  LadderViewer.prototype._onSeeked.call(fake, s);
  assert.equal(sets, 2); assert.equal(el._t, 14.5 / 24); assert.equal(s.pending, null);
  el.seeking = false;
  LadderViewer.prototype._onSeeked.call(fake, s);
  assert.equal(fake.drawn, 1, "the picture is drawn once the newest frame has landed");
});

test("ladder: in Sync 4-up the canvas never re-renders the stage, and a jump from the App moves the paused player", () => {
  let sized = 0, sought = null;
  const fake = { mode: "sync", canvas: { isConnected: true, getClientRects: () => [{}] }, _size() { sized++; return [16, 9]; } };
  LadderViewer.prototype.draw.call(fake);
  assert.equal(sized, 0);
  const sync = { playing: false, clock: { frame: 3 }, seek(f) { sought = f; } };
  LadderViewer.prototype.setFrame.call({ mode: "sync", sync }, 40);
  assert.equal(sought, 40);
  sought = null; sync.playing = true;
  LadderViewer.prototype.setFrame.call({ mode: "sync", sync }, 41);
  assert.equal(sought, null, "while it plays, its own clock leads");
});

// ---------------------------------------------------------------- the shot's sources
test("this shot's sources: clay preview, the live colour stage, Draft, Final (with sound first)", () => {
  const calls = [];
  const snap = { width: 960, height: 512 };
  const stage = { state: { shot: { fps: 24, frames: 121 } }, fw: 960, fh: 512, renderFrameTo: (m, f) => { calls.push([m, f]); return snap; } };
  const spec = shotReviewSources({ previz: "/v/previz.mp4", draft: "/v/draft.mp4", final: "/v/final.mp4", final_sound: "/v/final_sound.mp4" }, stage);
  assert.equal(spec.fps, 24);
  assert.deepEqual(spec.slots.map((s) => s?.label), ["Clay", "Colour clay", "Draft", "Final"]);
  assert.equal(spec.slots[3].url, "/v/final_sound.mp4");
  let drawn = null;
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage: (src) => { drawn = src; } }) };
  spec.slots[1].live.draw(canvas, 500);
  assert.deepEqual(calls, [["color", 120]], "the colour stage, clamped to the shot");
  assert.deepEqual([canvas.width, canvas.height, drawn], [960, 512, snap]);
  const none = shotReviewSources({}, null);
  assert.deepEqual(none.slots, [null, null, null, null]);
});

// ---------------------------------------------------------------- nothing runs while paused
test("the player has no timers: animation frames and video-frame callbacks only while playing", () => {
  const src = read("web/review/syncreview.mjs");
  assert.doesNotMatch(src, /setInterval|setTimeout/, "no idle timers");
  assert.match(src, /requestVideoFrameCallback/);
  assert.match(src, /if \(!this\.clock\.playing\) return;/, "the tick stops itself when paused");
  assert.match(src, /cancelAnimationFrame\(this\._raf\)/);
  const clock = read("web/review/syncclock.mjs");
  assert.doesNotMatch(clock, /setInterval|setTimeout|requestAnimationFrame\(/);
});

test("the App wires the shot's takes into the Review view", () => {
  const app = read("web/soundstage.js");
  assert.match(app, /ladder\.reviewSources = \(\) => shotReviewSources\(rendersFor\(stage\.activeShot\(\)\.id\), stage\)/);
  const lad = read("web/ladder/ladder.mjs");
  assert.match(lad, /\["sync", "▦ Sync 4-up"/);
  assert.match(lad, /: "sync";/, "Sync 4-up is the default Review view");
});
