// node --test tests/js/floating.test.mjs
// Floating panels (web/ui/floating.mjs): drag clamps on screen, fold to a chip, remembered, reset; Drive mode folds and
// docks the panels clear of the HUD and puts them back; the pop-out's channel carries keys and Dock back.
import test from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; },
};

const { clampOffset, dockSlots, overlaps, Floater, enterDrive, resetPanelPositions, channelPair, serveMain, keyMessage, popOut } =
  await import("../../web/ui/floating.mjs");

const win = { innerWidth: 1280, innerHeight: 800, getComputedStyle: (el) => ({ position: el.pos, zIndex: "6" }) };

/** Just enough of an element: its App-given rect, the inline style and attributes; a chip is 140 x 28. */
function fakeEl(rect, pos = "absolute") {
  const props = new Map(), attrs = new Set();
  return {
    isConnected: true, dataset: {}, pos,
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) || "" },
    toggleAttribute: (n, on) => (on ? attrs.add(n) : attrs.delete(n)), hasAttribute: (n) => attrs.has(n),
    getClientRects: () => [1],
    getBoundingClientRect() {
      const [x, y] = (props.get("translate") || "0px 0px").split(" ").map(parseFloat);
      const chip = attrs.has("data-fl-chip"), w = chip ? 140 : rect.width, h = chip ? 28 : rect.height;
      const left = rect.left + x, top = rect.top + y;
      return { left, top, width: w, height: h, right: left + w, bottom: top + h };
    },
  };
}
const make = (key, rect, o = {}) => new Floater(fakeEl(rect, o.pos), { key, title: key, win, ...o });
const inView = (r, v = { left: 0, top: 0, width: 1280, height: 800 }) =>
  r.left >= v.left && r.top >= v.top && r.right <= v.left + v.width && r.bottom <= v.top + v.height;

test("clampOffset: a drag past the edge stops at the margin; a panel taller than the window keeps its header in view", () => {
  const view = { left: 0, top: 0, width: 1000, height: 600 };
  assert.deepEqual(clampOffset({ left: 100, top: 100, width: 300, height: 200 }, { x: 900, y: -500 }, view), { x: 592, y: -92 });
  assert.deepEqual(clampOffset({ left: 100, top: 100, width: 300, height: 900 }, { x: 0, y: 50 }, view), { x: 0, y: -92 });
  // unmoved and on screen: left exactly where the App put it (even closer than the margin)
  assert.deepEqual(clampOffset({ left: 2, top: 2, width: 300, height: 200 }, { x: 0, y: 0 }, view), { x: 0, y: 0 });
});

test("a dragged panel stays on screen, is remembered, and re-clamps when the window shrinks without losing its place", () => {
  mem.clear();
  const f = make("presets", { left: 400, top: 60, width: 500, height: 300 });
  f.refresh();
  f.moveBy(5000, 5000);
  const r = f.el.getBoundingClientRect();
  assert.ok(inView(r), JSON.stringify(r));
  assert.equal(r.right, 1280 - 8);
  assert.equal(r.bottom, 800 - 8);
  const saved = JSON.parse(mem.get("ss_fl_presets"));
  assert.deepEqual([saved.x, saved.y], [f.want.x, f.want.y]);
  // a new App session (same key): the same place
  const g = make("presets", { left: 400, top: 60, width: 500, height: 300 });
  g.refresh();
  assert.deepEqual(g.el.getBoundingClientRect(), r);
  // a smaller window: clamped into it; the wanted place is kept for when it grows back
  g.refresh({ left: 0, top: 0, width: 1000, height: 600 });
  assert.ok(inView(g.el.getBoundingClientRect(), { left: 0, top: 0, width: 1000, height: 600 }));
  assert.deepEqual(g.want, f.want);
});

test("fold to a chip and back, remembered; Reset puts every panel back unfolded", () => {
  mem.clear();
  const f = make("physics", { left: 900, top: 80, width: 320, height: 420 });
  f.refresh();
  f.setChip(true);
  assert.ok(f.el.hasAttribute("data-fl-chip"));
  assert.equal(f.el.getBoundingClientRect().height, 28);
  assert.equal(JSON.parse(mem.get("ss_fl_physics")).chip, true);
  f.setChip(false);
  assert.ok(!f.el.hasAttribute("data-fl-chip"));
  f.moveBy(-200, 40);
  f.setChip(true);
  resetPanelPositions();
  assert.equal(mem.get("ss_fl_physics"), undefined);
  assert.ok(!f.el.hasAttribute("data-fl-chip"));
  assert.equal(f.el.style.getPropertyValue("translate"), "");
  assert.deepEqual(f.el.getBoundingClientRect().left, 900);
});

test("the Classic layout (a panel in the page flow) never moves and gets no controls", () => {
  const f = make("classic", { left: 0, top: 0, width: 300, height: 300 }, { pos: "static" });
  f.want = { x: 50, y: 50 };
  f.refresh();
  assert.equal(f.live(), false);
  assert.equal(f.el.dataset.flLive, "false");
  assert.equal(f.el.style.getPropertyValue("translate"), "");
});

test("Drive mode folds the panels to chips clear of the HUD's name / REC / speed / take bars, and puts them back", () => {
  mem.clear();
  const view = { left: 0, top: 0, width: 1280, height: 800 };
  // the Drive HUD (ui/drivehud.mjs): name + Exit top left, REC top centre, speed bottom right, Keep / Discard / Again
  const hud = {
    exit: { left: 10, top: 10, right: 530, bottom: 44 },
    rec: { left: 480, top: 10, right: 800, bottom: 44 },
    speed: { left: 1100, top: 720, right: 1268, bottom: 790 },
    take: { left: 310, top: 670, right: 970, bottom: 800 },
  };
  const avoid = Object.values(hud);
  const left = make("cv_shot", { left: 8, top: 8, width: 320, height: 600 });                  // covers Exit
  const props = make("props", { left: 940, top: 8, width: 330, height: 760 });                 // covers REC's right
  const pre = make("presets", { left: 210, top: 58, width: 860, height: 520 });                // covers everything
  const keys = make("drive_keys", { left: 10, top: 740, width: 600, height: 50 }, { essential: true });
  const list = [left, props, pre, keys];
  for (const f of list) f.refresh(view);
  pre.moveBy(30, 20);
  const before = list.map((f) => f.el.getBoundingClientRect());
  const d = enterDrive(avoid, view, list);
  const chips = [left, props, pre];
  for (const f of chips) {
    const r = f.el.getBoundingClientRect();
    assert.ok(f.el.hasAttribute("data-fl-chip"), `${f.key} folded`);
    assert.ok(inView(r, view), `${f.key} in view ${JSON.stringify(r)}`);
    for (const [k, a] of Object.entries(hud)) assert.ok(!overlaps(r, a), `${f.key} clear of ${k}: ${JSON.stringify(r)}`);
  }
  for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++)
    assert.ok(!overlaps(chips[i].el.getBoundingClientRect(), chips[j].el.getBoundingClientRect()), "chips don't stack on each other");
  assert.ok(!keys.el.hasAttribute("data-fl-chip"), "the essential key hints stay open");
  // a window resize while driving keeps the dock
  pre.refresh(view);
  assert.ok(!overlaps(pre.el.getBoundingClientRect(), hud.exit));
  d.restore();
  assert.deepEqual(list.map((f) => f.el.getBoundingClientRect()), before);
  assert.ok(chips.every((f) => !f.el.hasAttribute("data-fl-chip")));
  assert.equal(JSON.parse(mem.get("ss_fl_presets")).chip, false, "the drive never saved its chips");
});

test("dockSlots: a full column moves to the next one on the left", () => {
  const sizes = Array.from({ length: 8 }, () => ({ width: 140, height: 100 }));
  const view = { left: 0, top: 0, width: 800, height: 400 };
  const s = dockSlots(sizes, view, []);
  assert.equal(s[0].left, 800 - 8 - 140);
  assert.ok(s.some((p) => p.left < 800 - 8 - 140), "a second column");
  for (const p of s) assert.ok(p.top + 100 <= 400 - 8 && p.left >= 8);
});

test("pop-out: a blocked pop-up says so and leaves the panel where it is", () => {
  const f = make("ask", { left: 900, top: 100, width: 380, height: 500 });
  const msgs = [];
  assert.equal(popOut(f, { win: { open: () => null }, say: (m) => msgs.push(m) }), null);
  assert.match(msgs[0], /Pop-up blocked/);
  assert.equal(f.out, undefined);
});

test("pop-out channel: keys from the second window reach the App (not while typing, not Esc); Dock back docks", async () => {
  const [mainEnd, popEnd] = channelPair();
  const got = [];
  class KE { constructor(type, init) { Object.assign(this, init, { type }); } }
  const body = { dispatchEvent: (e) => got.push(e) };
  const doc = { body, activeElement: body, defaultView: { KeyboardEvent: KE }, title: "" };
  let docked = 0;
  serveMain(mainEnd, { doc, onDock: () => docked++ });
  assert.equal(keyMessage({ key: "z", target: { tagName: "INPUT" } }), null);
  assert.equal(keyMessage({ key: "Escape", target: { tagName: "DIV" } }), null);
  popEnd.post(keyMessage({ key: "z", code: "KeyZ", metaKey: true, target: { tagName: "DIV" } }));
  popEnd.post({ t: "title", text: "Soundstage · Presets" });
  popEnd.post({ t: "dock" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "keydown");
  assert.equal(got[0].code, "KeyZ");
  assert.equal(got[0].metaKey, true);
  assert.equal(doc.title, "Soundstage · Presets");
  assert.equal(docked, 1);
});
