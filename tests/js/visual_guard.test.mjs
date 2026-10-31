// The visual regression guard's layout rules (tools/qa/visual_baseline.mjs): only NEW problems are flagged.
import test from "node:test";
import assert from "node:assert/strict";

import { layoutRegressions, SCREENS } from "../../tools/qa/visual_baseline.mjs";

const clean = { pageScroll: false, pageOverflowX: false, clipped: [], overlaps: [], offscreen: [] };

test("visual guard: a clean screen against a clean baseline has nothing to report", () => {
  assert.deepEqual(layoutRegressions(clean, clean), []);
  assert.deepEqual(layoutRegressions(null, clean), []);
});

test("visual guard: the page starting to scroll is flagged, an old scroll is not", () => {
  assert.equal(layoutRegressions({ ...clean, pageScroll: true, pageScrollH: 1400 }, clean).length, 1);
  assert.deepEqual(layoutRegressions({ ...clean, pageScroll: true }, { ...clean, pageScroll: true }), []);
});

test("visual guard: newly hard-clipped text is flagged; ellipsis and known cuts are not", () => {
  const now = { ...clean, clipped: [{ text: "Render final", ellipsis: false }, { text: "Long scene name…", ellipsis: true }, { text: "Old", ellipsis: false }] };
  const base = { ...clean, clipped: [{ text: "Old", ellipsis: false }] };
  const r = layoutRegressions(now, base);
  assert.equal(r.length, 1);
  assert.match(r[0], /Render final/);
  assert.doesNotMatch(r[0], /Long scene name|Old/);
});

test("visual guard: a new overlap between floating panels and a button cut by the edge are flagged", () => {
  const now = { ...clean, overlaps: [{ a: "ss-phys", b: "ss-hudp Settings", px: "40x80" }], offscreen: ["Next"] };
  const r = layoutRegressions(now, clean);
  assert.equal(r.length, 2);
  assert.deepEqual(layoutRegressions(now, now), []);
});

test("visual guard: the fixed screen list covers the seven steps and the key panels", () => {
  const names = SCREENS.map((s) => s.name);
  for (const n of ["firstrun_card", "canvas_hidden", "scriptsync", "import_video_chooser", "motion_follow_ripple", "physics_panel", "deliver_dcc_kit"]) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => /^step_\d_/.test(n)).length, 7);
  assert.equal(new Set(names).size, names.length);
});
