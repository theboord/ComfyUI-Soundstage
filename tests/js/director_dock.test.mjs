// node --test tests/js/director_dock.test.mjs
// The Director chat docks like the Presets window: it never covers a floating panel or the playback row (Play, Fit,
// Hide top view). It sits at the right of the free band between the side panels, above the bars under it, and takes
// the Properties slot when no band is wide enough. Rects are the ones measured in the App (③ Set, demo scene).
import test from "node:test";
import assert from "node:assert/strict";
import { dockSlot, DIR_W, DIR_MIN, DIR_TOP } from "../../web/agent/directorpanel.mjs";

const R = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const ob = (name, r) => ({ el: { name, matches: (s) => s === ".ss-insp" && name === "props" }, r });
const over = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;

function layout(w, h, { look = true, props = true } = {}) {
  const rail = ob("rail", R(28, 120, 102, 808)), bottom = ob("bottom", R(117, h - 95, w - 379, h - 48));
  const list = [rail, bottom];
  if (props) list.push(ob("props", R(w - 367, 119, w - 27, h - 48)));
  if (look) list.push(ob("look", R(410 + (w - 1440) / 2, 119, 1030 + (w - 1440) / 2, h - 245)));
  return { rr: R(0, 0, w, h), list };
}

for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]]) {
  for (const look of [true, false]) {
    test(`${w}x${h}${look ? " with the Look pop-over" : ""}: the chat covers nothing and stays in the canvas`, () => {
      const { rr, list } = layout(w, h, { look });
      const s = dockSlot(rr, list);
      assert.ok(s, "found a slot");
      const box = R(s.left, s.top, s.right, s.bottom);
      assert.ok(box.left >= 0 && box.right <= w && box.top >= DIR_TOP && box.bottom <= h, "inside the canvas");
      assert.ok(box.width >= DIR_MIN && box.width <= DIR_W);
      for (const o of list) if (!s.take.includes(o.el)) assert.ok(!over(box, o.r), `clear of ${o.el.name}`);
      for (const el of s.take) assert.equal(el.name, "props", "only Properties ever gives up its slot");
    });
  }
}

test("Properties keeps its slot while the band beside it is wide enough", () => {
  const { rr, list } = layout(1440, 900, { look: false });
  const s = dockSlot(rr, list);
  assert.deepEqual(s.take, []);
  assert.ok(s.right <= 1440 - 367, "between the rail and Properties");
});

test("a band too narrow for the chat: it takes the Properties slot", () => {
  const { rr, list } = layout(1440, 900, { look: true });
  const s = dockSlot(rr, list);
  assert.equal(s.take.length, 1);
  assert.ok(s.left >= 1030, "right of the Look pop-over");
});

test("no room anywhere (narrow side panel): null, the CSS default", () => {
  assert.equal(dockSlot(R(0, 0, 380, 700), [ob("rail", R(0, 60, 120, 700))]), null);
});
