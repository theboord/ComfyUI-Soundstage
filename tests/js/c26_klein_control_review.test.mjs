// node --test tests/js/c26_klein_control_review.test.mjs
// C26 small UI items:
//   1. ④ Frame says in plain words that FLUX Klein takes no depth or pose control (soundstage/router/adapters.py
//      flux3_klein never feeds control_image into Klein's conditioning; no Klein control model exists).
//   2. ⑥ Review's Sync 4-up: a "Live stage" tile (was "Colour clay") opened before the stage was ready drew nothing until the frame
//      changed (C27, seen once on Jon's machine). It now waits for the stage and draws when the stage first renders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { KLEIN_CONTROL_NOTE, isKleinModel } from "../../web/pipeline/pipeline.mjs";
import { shotReviewSources, stageReady } from "../../web/review/sources.mjs";
import { SyncReview } from "../../web/review/syncreview.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

test("Klein's control rows say what Klein really does", () => {
  assert.ok(isKleinModel("FLUX 3 Klein · local [<$5M]") && isKleinModel("FLUX.2 Klein 9B · local [NC]"));
  assert.ok(!isKleinModel("Krea 2 Turbo · local [<$1M]") && !isKleinModel("__krea_depth__") && !isKleinModel(null));
  assert.match(KLEIN_CONTROL_NOTE, /no depth or pose control/);
  assert.match(KLEIN_CONTROL_NOTE, /aligned reference/);
  assert.match(KLEIN_CONTROL_NOTE, /Krea 2 only/);
  const src = read("web/pipeline/pipeline.mjs");
  assert.match(src, /f\.kleinNote = h\("small", \{ class: "status ss-klein-ctl", hidden: "" \}, KLEIN_CONTROL_NOTE\)/);
  assert.match(src, /f\.kleinNote\.hidden = !isKleinModel\(f\.model\.value\)/, "shown only while a Klein paints the frame");
});

// ---------------------------------------------------------------- Review: the colour stage before the stage is up
const snap = { width: 960, height: 512 };
const readyStage = () => ({ state: { shot: { fps: 24, frames: 121 } }, fw: 960, fh: 512, renderFrameTo: () => snap });

test("before the stage has a shot length, the colour tile waits for it instead of vanishing", () => {
  const early = { state: { shot: { fps: 24, frames: 0 } }, fw: 0, fh: 0, renderFrameTo: () => snap };
  assert.ok(!stageReady(early));
  assert.deepEqual(shotReviewSources({}, early).slots[1], { label: "Live stage", waitStage: true });
  const s = readyStage();
  assert.ok(stageReady(s));
  const live = shotReviewSources({}, s).slots[1].live;
  assert.equal(live.ready(), true);
  s.fw = 0;
  assert.equal(live.ready(), false, "a 0 x 0 stage cannot draw yet");
  assert.deepEqual(shotReviewSources({}, null).slots, [null, null, null, null], "no stage: nothing to wait for");
});

test("a 0 x 0 snapshot is a failed draw, not a black frame", () => {
  const s = readyStage();
  s.renderFrameTo = () => ({ width: 0, height: 0 });
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage() { throw new Error("never"); } }) };
  assert.throws(() => shotReviewSources({}, s).slots[1].live.draw(canvas, 0), /not ready/);
});

function fakeTile(live) {
  const f = { textContent: "x", setAttribute() {}, removeAttribute() {} };
  return { i: 1, kind: "live", ready: true, frame: -1, src: { live }, el: {}, fps: 24, frames: 121, cap: { querySelector: () => f }, f };
}
function fakePlayer(tile) {
  return Object.assign(Object.create(SyncReview.prototype), {
    tiles: [{}, tile, {}, {}], el: { hidden: false }, clock: { playing: false, frame: 7 }, masterFps: 24, map: "frame",
    _tileTarget: () => ({ frame: 7, held: false }),
  });
}

test("a live draw that fails is not latched: the stage's first render draws that frame", () => {
  let up = false, drawn = [];
  const live = { ready: () => up, draw: (_, f) => { drawn.push(f); } };
  const t = fakeTile(live), r = fakePlayer(t);
  r._drawLive(t, 7);
  assert.equal(t.frame, -1, "not drawn: the same frame must draw again");
  assert.equal(t.liveFailed, true);
  r._caption(t);
  assert.equal(t.f.textContent, "", "no frame number on a tile that drew nothing");
  r.stageReady();                      // a render while still not ready: nothing
  assert.deepEqual(drawn, []);
  up = true;
  r.stageReady();                      // the stage is up: frame 7 draws now, not on the next frame change
  assert.deepEqual(drawn, [7]);
  assert.equal(t.frame, 7);
  assert.equal(t.liveFailed, false);
  r.stageReady();
  assert.deepEqual(drawn, [7], "a no-op once drawn (it runs on every stage render)");
});

test("a draw that throws is retried on the next stage render, a few times at most", () => {
  let tries = 0;
  const t = fakeTile({ draw: () => { tries++; throw new Error("busy"); } }), r = fakePlayer(t);
  r._drawLive(t, 7);
  assert.equal(t.frame, -1);
  for (let i = 0; i < 100; i++) r.stageReady();
  assert.ok(tries > 1 && tries <= 31, `bounded retries (${tries})`);
});

test("a waiting colour tile re-reads the sources once the stage renders", () => {
  const t = { i: 1, waitStage: true };
  const r = fakePlayer(t);
  let refreshed = 0, synced = 0;
  r.refresh = () => { refreshed++; t.waitStage = false; };
  r._syncAll = () => { synced++; };
  r.stageReady();
  assert.deepEqual([refreshed, synced], [1, 1]);
  r.stageReady();
  assert.deepEqual([refreshed, synced], [1, 1]);
  r.el.hidden = true; t.waitStage = true;
  r.stageReady();
  assert.equal(refreshed, 1, "hidden: the next show() refreshes anyway");
});

test("the App tells the player each time the stage renders; still no idle timers", () => {
  assert.match(read("web/soundstage.js"), /stage\.onRendered = \(cam\) => \{\n\s+ladder\.sync\?\.stageReady\?\.\(\);/);
  assert.doesNotMatch(read("web/review/syncreview.mjs"), /setInterval|setTimeout/);
  assert.match(read("web/review/syncreview.mjs"), /\(src\.waitStage && "wait:stage"\)/, "a waiting tile has its own key");
});
