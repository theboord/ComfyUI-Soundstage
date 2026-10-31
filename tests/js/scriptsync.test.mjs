// node --test tests/js/   ScriptSync (the lined script's player and lining tools): the pure half in dailies/model.mjs.
// The DOM (web/dailies/lined.mjs + syncplayer.mjs) is checked in web/dailies/preview.html?real=1 and in the App.
import test from "node:test";
import assert from "node:assert/strict";

import { syncPoint, syncSegments, elementAtFraction, stackThumbs, LiningHistory, coverageFor, toggleOffscreen } from "../../web/dailies/model.mjs";
import { DINER_SCENE, demoDailies } from "../../web/dailies/demo_dailies.mjs";

const diner = structuredClone(DINER_SCENE);

test("sync segments cover the take end to end, one per covered script line", () => {
  const cov = { from: 5, to: 12, offscreen: [[7, 8]] };
  const segs = syncSegments(diner, cov);
  assert.equal(segs.length, 8);
  assert.equal(segs[0].i, 5);
  assert.equal(segs[0].a, 0);
  assert.equal(segs.at(-1).b, 1);
  for (let k = 1; k < segs.length; k++) assert.equal(segs[k].a, segs[k - 1].b);   // no gaps, no overlaps
  assert.deepEqual(segs.filter((s) => s.off).map((s) => s.i), [7, 8]);
  assert.deepEqual(syncSegments(diner, null), []);
});

test("a segment starts where syncPoint cues the same line", () => {
  const cov = { from: 3, to: 20, offscreen: [] };
  for (const i of [3, 4, 9, 15, 20]) {
    const seg = syncSegments(diner, cov).find((s) => s.i === i);
    assert.ok(Math.abs(seg.a - syncPoint(diner, cov, i).fraction) < 1e-12, `line ${i}`);
  }
});

test("elementAtFraction is the inverse of syncPoint (the playing take moves the script cursor)", () => {
  const cov = { from: 3, to: 20, offscreen: [] };
  for (let i = cov.from; i <= cov.to; i++) {
    const f = syncPoint(diner, cov, i).fraction;
    assert.equal(elementAtFraction(diner, cov, f + 1e-9), i, `line ${i}`);
  }
  assert.equal(elementAtFraction(diner, cov, 0), 3);
  assert.equal(elementAtFraction(diner, cov, 1), 20);
  assert.equal(elementAtFraction(diner, cov, 7), 20);      // clamped
  assert.equal(elementAtFraction(diner, cov, -1), 3);
  assert.equal(elementAtFraction(diner, null, 0.5), null);
});

test("thumbnails stack up a tier only where they would collide", () => {
  // Three lines starting on the same script line, 26 px apart, 54 px wide thumbs: three tiers.
  assert.deepEqual(stackThumbs([{ x: 40, y: 100 }, { x: 66, y: 100 }, { x: 92, y: 100 }], 54, 50), [0, 1, 2]);
  // Far enough apart: all on their own lines.
  assert.deepEqual(stackThumbs([{ x: 40, y: 100 }, { x: 100, y: 100 }, { x: 160, y: 100 }], 54, 50), [0, 0, 0]);
  // Starting far lower: no collision with the ones above.
  assert.deepEqual(stackThumbs([{ x: 40, y: 100 }, { x: 66, y: 400 }], 54, 50), [0, 0]);
  // A thumb drops back to tier 0 once the one beside it is far enough away.
  assert.deepEqual(stackThumbs([{ x: 40, y: 100 }, { x: 66, y: 100 }, { x: 130, y: 100 }], 54, 50), [0, 1, 0]);
  assert.deepEqual(stackThumbs([], 54, 50), []);
});

test("lining history: undo gives back each edit in reverse, a deleted line comes back", () => {
  const hist = new LiningHistory(3);
  const a = { from: 0, to: 4, offscreen: [] };
  hist.push("s1", a);
  hist.push("s1", toggleOffscreen(a, 2));
  hist.push("s2", null);                                    // s2 was not lined before its edit
  assert.equal(hist.size, 3);
  assert.deepEqual(hist.undo(), { id: "s2", cov: null });
  assert.deepEqual(hist.undo(), { id: "s1", cov: { from: 0, to: 4, offscreen: [[2, 2]] } });
  a.to = 9;                                                 // the stored state is a copy
  assert.deepEqual(hist.undo(), { id: "s1", cov: { from: 0, to: 4, offscreen: [] } });
  assert.equal(hist.undo(), null);
  for (let k = 0; k < 5; k++) hist.push("s", { from: k, to: k, offscreen: [] });
  assert.equal(hist.size, 3);                               // capped
  assert.equal(hist.undo().cov.from, 4);
  hist.clear();
  assert.equal(hist.size, 0);
});

test("a deleted line stays deleted (null), unlike 'use the default' (undefined)", () => {
  const shot = { setup: "master" };
  assert.equal(coverageFor(diner, shot, null), null);
  assert.ok(coverageFor(diner, shot, undefined));
});

test("real-frame demo takes stay apart (one rendered frame per setup, no stand-in videos)", () => {
  const real = { sc_4: Array.from({ length: 11 }, (_, i) => `/api/view?filename=diner_${i}.png&type=output`) };
  const { renders, shots } = demoDailies({ thumbs: false, real });
  const master = shots.find((s) => s.scene_id === "sc_4");
  const takes = renders[master.id];
  assert.ok(takes.length > 1);
  assert.equal(new Set(takes.map((t) => t.url)).size, takes.length);
  assert.ok(takes.every((t) => !t.video && t.thumb === real.sc_4[0]));
});
