// QA round 06 regressions.
//
// Ladder: switching scenes on ③ Set froze the page for 6-8 s. restoreLadder() and clearSource() each redraw the
// preview ladder, and every live layer (Wire / Clay / Color) is a full stage re-render at delivery size plus two
// renderer resizes, even while the ladder view is hidden. A hidden ladder now only marks itself stale; opening the
// view draws it (showView -> ladder.setFrame).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LadderViewer } from "../../web/ladder/ladder.mjs";

test("a hidden ladder does not re-render the stage", () => {
  let renders = 0;
  const fake = {
    canvas: { isConnected: true, getClientRects: () => [] },
    _size() { renders++; return [16, 9]; },
  };
  LadderViewer.prototype.draw.call(fake);
  assert.equal(renders, 0, "draw() on a hidden ladder must not size / render anything");
  assert.equal(fake.stale, true, "it remembers that it needs a draw when shown");
});

test("a shown ladder still draws", () => {
  let sized = 0;
  const fake = {
    canvas: { isConnected: true, getClientRects: () => [{ width: 10, height: 10 }], width: 16, height: 9 },
    ctx: { fillRect() {}, set fillStyle(v) {} },
    _size() { sized++; throw new Error("drawn"); },
  };
  assert.throws(() => LadderViewer.prototype.draw.call(fake), /drawn/);
  assert.equal(sized, 1);
});

// Shot rows: _drawShotRows() drew one row per step view (Frame, Motion, Review, Deliver) and rendered every shot's clay
// preview again for each row: a scene switch with 3 shots made 12 full stage renders. One render per shot now.
test("each shot's clay preview is rendered once per redraw, however many step rows show it", async () => {
  const el = (tag) => ({ tag, kids: [], style: {}, setAttribute() {}, addEventListener() {}, append(...k) { this.kids.push(...k); },
    replaceChildren(...k) { this.kids = k; }, getContext: () => ({ drawImage() {} }) });
  const had = globalThis.document;
  globalThis.document = { createElement: el, getElementById: () => null, head: { append() {} } };
  try {
    const { Pipeline } = await import("../../web/pipeline/pipeline.mjs");
    const rendered = [];
    const shots = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
    const fake = {
      shotRows: ["frame", "motion", "review", "deliver"].map((where) => ({ row: el("div"), where })),
      chosen: {}, candidates: {}, inflight: new Map(),
      shots: () => shots, _shotState: () => ["", ""], selectShot() {},
      ctx: { stage: { activeShot: () => shots[0] }, getRenders: () => ({}), renderPreviewFrame: (id) => { rendered.push(id); return el("canvas"); } },
    };
    Pipeline.prototype._drawShotRows.call(fake);
    assert.deepEqual(rendered, ["a", "b", "c"], "one clay render per shot");
    for (const { row } of fake.shotRows) assert.equal(row.kids.length, 1 + shots.length, "every row still shows every shot");
  } finally { globalThis.document = had; }
});
