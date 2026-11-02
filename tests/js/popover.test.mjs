// The pop-over layer's placement maths: every menu lands fully inside the window, flipping and scrolling as needed.
import test from "node:test";
import assert from "node:assert/strict";
import { placePopover } from "../../web/ui/popover.mjs";

const inside = (p, view, m = 8) => {
  assert.ok(p.left >= 0 && p.top >= 0, `left/top >= 0: ${JSON.stringify(p)}`);
  assert.ok(p.left + p.maxWidth <= view.width, `right edge in view: ${JSON.stringify(p)}`);
  assert.ok(p.top + p.maxHeight <= view.height, `bottom edge in view: ${JSON.stringify(p)}`);
  if (view.width > 2 * m + p.maxWidth) assert.ok(p.left >= m && p.left + p.maxWidth <= view.width - m);
};

test("opens below its anchor when it fits, aligned to the anchor's left", () => {
  const p = placePopover({ left: 100, top: 40, right: 180, bottom: 60 }, { width: 200, height: 150 }, { width: 1024, height: 640 });
  assert.equal(p.side, "bottom");
  assert.equal(p.left, 100);
  assert.equal(p.top, 64);
  assert.equal(p.maxHeight, 150);
  assert.equal(p.scrolls, false);
});

test("flips above when there is no room below (the Cut strip's + Shot at the bottom of the window)", () => {
  // the reported bug: 1600x1000, + Shot at y 682..706 inside a scrolling box; the menu is 260 tall
  const view = { width: 1600, height: 1000 };
  const p = placePopover({ left: 40, top: 900, right: 120, bottom: 924 }, { width: 220, height: 260 }, view);
  assert.equal(p.side, "top");
  assert.equal(p.top + p.maxHeight, 896);
  assert.equal(p.maxHeight, 260);
  inside(p, view);
});

test("prefers top when asked, and falls back to bottom when the top is short", () => {
  const view = { width: 1280, height: 800 };
  const up = placePopover({ left: 10, top: 500, right: 50, bottom: 520 }, { width: 100, height: 200 }, view, { side: "top" });
  assert.equal(up.side, "top");
  const down = placePopover({ left: 10, top: 60, right: 50, bottom: 80 }, { width: 100, height: 200 }, view, { side: "top" });
  assert.equal(down.side, "bottom");
  assert.equal(down.top, 84);
});

test("taller than either side: the roomier side, scrolling inside", () => {
  const view = { width: 1024, height: 640 };
  const p = placePopover({ left: 300, top: 400, right: 360, bottom: 420 }, { width: 240, height: 900 }, view);
  assert.equal(p.side, "top");
  assert.equal(p.scrolls, true);
  assert.equal(p.maxHeight, 400 - 4 - 8);
  inside(p, view);
});

test("taller than the window with a squeezed anchor: uses the whole window height", () => {
  const view = { width: 1024, height: 640 };
  // both sides under the 120 px minimum
  const p = placePopover({ left: 300, top: 100, right: 360, bottom: 560 }, { width: 240, height: 900 }, view);
  assert.equal(p.side, "over");
  assert.equal(p.maxHeight, 640 - 16);
  assert.equal(p.top, 8);
  assert.equal(p.scrolls, true);
  inside(p, view);
});

test("clamped to the right edge; align end and center", () => {
  const view = { width: 1024, height: 640 };
  const r = placePopover({ left: 980, top: 20, right: 1010, bottom: 40 }, { width: 310, height: 200 }, view);
  assert.equal(r.left, 1024 - 8 - 310);
  const e = placePopover({ left: 600, top: 20, right: 700, bottom: 40 }, { width: 310, height: 200 }, view, { align: "end" });
  assert.equal(e.left, 700 - 310);
  const c = placePopover({ left: 600, top: 20, right: 700, bottom: 40 }, { width: 300, height: 200 }, view, { align: "center" });
  assert.equal(c.left, 500);
  const l = placePopover({ left: -50, top: 20, right: 10, bottom: 40 }, { width: 300, height: 200 }, view);
  assert.equal(l.left, 8);
});

test("wider than the window: the window's width, scrolling", () => {
  const view = { width: 400, height: 640 };
  const p = placePopover({ left: 100, top: 20, right: 120, bottom: 40 }, { width: 620, height: 100 }, view);
  assert.equal(p.maxWidth, 384);
  assert.equal(p.left, 8);
  assert.equal(p.scrolls, true);
  inside(p, view);
});

test("a point anchor (a right-click) near the bottom-right corner", () => {
  const view = { width: 1280, height: 800 };
  const p = placePopover({ left: 1270, top: 790 }, { width: 220, height: 330 }, view);
  assert.equal(p.side, "top");
  assert.equal(p.left, 1280 - 8 - 220);
  assert.equal(p.top, 790 - 4 - 330);
  inside(p, view);
});

test("every anchor and size over a grid of windows stays inside", () => {
  for (const [vw, vh] of [[1024, 640], [1280, 800], [1600, 1000], [1920, 1080], [360, 300]]) {
    for (let ax = -40; ax <= vw + 40; ax += Math.round(vw / 7)) {
      for (let ay = -40; ay <= vh + 40; ay += Math.round(vh / 7)) {
        for (const [w, hh] of [[120, 60], [310, 420], [700, 1200], [2000, 50]]) {
          for (const side of ["bottom", "top"]) for (const align of ["start", "end", "center"]) {
            const p = placePopover({ left: ax, top: ay, right: ax + 60, bottom: ay + 24 }, { width: w, height: hh }, { width: vw, height: vh }, { side, align });
            inside(p, { width: vw, height: vh });
            assert.ok(p.maxHeight > 0 && p.maxWidth > 0);
            assert.equal(p.scrolls, p.maxHeight < hh || p.maxWidth < w);
          }
        }
      }
    }
  }
});
