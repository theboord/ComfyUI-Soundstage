// node --test tests/js/  —  QA round 05: the CUT editor fits the window (track squeeze + fold) and the wheel follows NLE rules.
import test from "node:test";
import assert from "node:assert/strict";
import { CutPanel } from "../../web/cut/cut.mjs";

const L = CutPanel.trackLayout;

test("tracks keep their natural height when there is room", () => {
  const l = L(Infinity, 4);
  assert.deepEqual([l.th, l.ah, l.ag, l.total], [60, 40, 4, 314]);
  assert.equal(L(400, 4).total, 314);
});

test("tracks squeeze to the budget, never below compact minimums", () => {
  for (const budget of [300, 260, 230, 218, 212]) {
    const l = L(budget, 4);
    assert.ok(l.total <= budget, `${budget}: total ${l.total}`);
    assert.ok(l.th >= 34 && l.ah >= 22, `${budget}: th ${l.th} ah ${l.ah}`);
    assert.equal(l.ay, l.sy + 14 + 5);
    assert.equal(l.total, l.ay + 4 * (l.ah + l.ag) + 6);
  }
  const tight = L(120, 4);   // can't fit: compact floor, the box scrolls
  assert.deepEqual([tight.th, tight.ah], [34, 22]);
});

test("folded audio lanes are thin and give V1 its height back", () => {
  const squeezed = L(218, 4), folded = L(218, 4, true);
  assert.equal(folded.ah, 12);
  assert.ok(folded.th > squeezed.th);
  assert.ok(folded.total <= 218);
});

function fakePanel({ overflow }) {
  const p = Object.create(CutPanel.prototype);
  p.calls = [];
  p._local = () => ({ x: 300 });
  p.zoom = (f, x) => p.calls.push(["zoom", f, x]);
  p._clampScroll = () => {};
  p.requestDraw = () => {};
  p.scrollX = 0;
  p._tlw = { scrollTop: 0, scrollHeight: overflow ? 400 : 200, clientHeight: 200 };
  return p;
}
const wheel = (o) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

test("wheel scrolls tracks when they overflow; Ctrl/⌘ or pinch zooms time", () => {
  const p = fakePanel({ overflow: true });
  p._onWheel(wheel({ deltaY: 120 }));
  assert.equal(p._tlw.scrollTop, 120);
  assert.equal(p.calls.length, 0, "plain wheel must not zoom");
  p._onWheel(wheel({ deltaY: -100, ctrlKey: true }));   // a trackpad pinch arrives as ctrl+wheel
  p._onWheel(wheel({ deltaY: 100, metaKey: true }));
  assert.equal(p.calls.length, 2);
  assert.ok(p.calls[0][1] > 1 && p.calls[1][1] < 1);
  p._onWheel(wheel({ deltaY: 50, shiftKey: true }));
  assert.equal(p.scrollX, 50);
});

test("wheel scrolls time when the tracks already fit", () => {
  const p = fakePanel({ overflow: false });
  p._onWheel(wheel({ deltaY: 80 }));
  assert.equal(p.scrollX, 80);
  assert.equal(p._tlw.scrollTop, 0);
  assert.equal(p.calls.length, 0);
});
