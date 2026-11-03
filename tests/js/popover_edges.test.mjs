// The pop-over layer (web/ui/popover.mjs) at the edges popover.test.mjs does not walk: phone-sized windows (320 px),
// windows smaller than the margins, fractional and broken anchors, anchors scrolled out of the window, and whether a
// pop-over placed on a side of its anchor ever covers it (the "top" / "bottom" promise; "over" is the one side that may).
// The second half drives openPopover itself in a small fake DOM whose boxes follow the CSS width rules
// (used width = max(min-width, min(max-width, width))), so what the layer writes into style is what a browser would draw.
// RTL: the layer has no right-to-left mode (align "start" is always the anchor's left edge), so none is tested.
import test from "node:test";
import assert from "node:assert/strict";
import { placePopover, openPopover, closeAllPopovers, isPopoverOpen } from "../../web/ui/popover.mjs";

const finite = (p) => Object.entries(p).every(([k, v]) => k === "side" || k === "scrolls" || Number.isFinite(v));

/** The promises placePopover makes for one placement. */
function check(a, size, view, opts, p) {
  const m = opts.margin ?? 8, gap = opts.gap ?? 4;
  const why = JSON.stringify({ a, size, view, opts, p });
  assert.ok(finite(p), `finite: ${why}`);
  // fully on-screen, and off the margin whenever the window has room for that
  assert.ok(p.left >= 0 && p.top >= 0 && p.left + p.maxWidth <= view.width && p.top + p.maxHeight <= view.height, `on-screen: ${why}`);
  if (view.width >= 2 * m) assert.ok(p.left >= m && p.left + p.maxWidth <= view.width - m, `inside the side margins: ${why}`);
  if (view.height >= 2 * m) assert.ok(p.top >= m && p.top + p.maxHeight <= view.height - m, `inside the top/bottom margins: ${why}`);
  // never bigger than it is, and "scrolls" says exactly when it was cut down
  assert.ok(p.maxHeight <= size.height + 0.5 && p.maxWidth <= size.width + 0.5, `not stretched: ${why}`);
  // (maxHeight / maxWidth are whole pixels, floored: a 431.9 px menu given 431 px is within a pixel, either answer is fine: the flag is worked out before flooring)
  if (p.maxHeight < size.height - 1.5 || p.maxWidth < size.width - 1.5) assert.ok(p.scrolls, `cut down, so it scrolls: ${why}`);
  if (p.maxHeight >= size.height && p.maxWidth >= size.width) assert.ok(!p.scrolls, `whole, so it does not scroll: ${why}`);
  // beside the anchor: below it, or above it, with the gap (1 px for rounding to whole pixels)
  const bottom = a.bottom ?? a.top;
  if (p.side === "bottom" && bottom >= 0 && bottom <= view.height) assert.ok(p.top >= bottom + gap - 1, `below the anchor: ${why}`);
  if (p.side === "top" && a.top >= 0 && a.top <= view.height) assert.ok(p.top + p.maxHeight <= a.top - gap + 1, `above the anchor: ${why}`);
}

test("a phone window (320 x 568 and 568 x 320): every anchor along every edge and corner, every side and alignment", () => {
  const menus = [[220, 330], [300, 120], [180, 40], [400, 900], [320, 568], [1, 1]];
  for (const view of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 320, height: 240 }]) {
    const xs = [-500, -30, 0, 3, 8, 40, view.width / 2, view.width - 60, view.width - 8, view.width, view.width + 30];
    const ys = [-500, -24, 0, 4, 8, 50, view.height / 2, view.height - 40, view.height - 24, view.height - 8, view.height, view.height + 24];
    for (const x of xs) for (const y of ys) for (const [w, h] of menus) for (const side of ["bottom", "top"])
      for (const align of ["start", "end", "center"]) for (const gap of [0, 4, 6]) for (const margin of [8, 12]) {
        const a = { left: x, top: y, right: x + 44, bottom: y + 24 };
        const opts = { side, align, gap, margin };
        check(a, { width: w, height: h }, view, opts, placePopover(a, { width: w, height: h }, view, opts));
      }
  }
});

test("fractional anchors and sizes (zoomed pages, sub-pixel layouts) keep every promise", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20000; i++) {
    const view = { width: [320, 375, 414, 768, 1024][i % 5], height: [240, 568, 640, 812, 1080][(i * 7) % 5] };
    const x = rnd() * (view.width + 120) - 60, y = rnd() * (view.height + 120) - 60;
    const a = { left: x, top: y, right: x + rnd() * 300, bottom: y + rnd() * 50 };
    const size = { width: rnd() * 700, height: rnd() * 1300 };
    const opts = { side: rnd() < 0.5 ? "top" : "bottom", align: ["start", "end", "center"][i % 3], gap: [0, 4, 6][i % 3], margin: [8, 12][i % 2] };
    check(a, size, view, opts, placePopover(a, size, view, opts));
  }
});

test("when it fits on the side asked for, it goes there at its natural size; it only goes 'over' when neither side has room", () => {
  const view = { width: 320, height: 568 };
  const p = placePopover({ left: 10, top: 300, right: 60, bottom: 324 }, { width: 200, height: 200 }, view, { side: "top" });
  assert.deepEqual([p.side, p.maxHeight, p.top + p.maxHeight], ["top", 200, 296]);
  // 600 tall in a 568 window: neither side holds it, the roomier one scrolls, and it stays off the anchor
  const tall = placePopover({ left: 10, top: 100, right: 60, bottom: 124 }, { width: 200, height: 600 }, view);
  assert.equal(tall.side, "bottom");
  assert.equal(tall.top, 128);
  assert.equal(tall.maxHeight, 568 - 8 - 128);
  // a toolbar across the middle of a 320 x 240 landscape phone: under 120 px on both sides -> over the anchor, whole window
  const over = placePopover({ left: 0, top: 100, right: 320, bottom: 140 }, { width: 200, height: 400 }, { width: 320, height: 240 });
  assert.equal(over.side, "over");
  assert.equal(over.maxHeight, 240 - 16);
  assert.equal(over.top, 8);
  // a small menu that fits beside the anchor is never put over it, however short the window
  const small = placePopover({ left: 0, top: 100, right: 320, bottom: 140 }, { width: 200, height: 80 }, { width: 320, height: 240 });
  assert.notEqual(small.side, "over");
});

test("larger than the window both ways: the window minus its margins, at the margins, scrolling", () => {
  for (const view of [{ width: 320, height: 568 }, { width: 1024, height: 640 }]) {
    for (const a of [{ left: 0, top: 0 }, { left: view.width, top: view.height }, { left: view.width / 2, top: view.height / 2 }]) {
      const p = placePopover(a, { width: 5000, height: 5000 }, view);
      assert.equal(p.maxWidth, view.width - 16);
      assert.equal(p.left, 8);
      assert.ok(p.scrolls);
      assert.ok(p.top >= 8 && p.top + p.maxHeight <= view.height - 8);
    }
  }
});

test("a window smaller than its own margins: still inside the window, nothing negative or NaN", () => {
  for (const view of [{ width: 10, height: 10 }, { width: 0, height: 0 }, { width: -5, height: 3 }, { width: 16, height: 16 }]) {
    const p = placePopover({ left: 5, top: 5, right: 9, bottom: 9 }, { width: 100, height: 100 }, view);
    assert.ok(finite(p), JSON.stringify(p));
    assert.ok(p.maxWidth >= 0 && p.maxHeight >= 0 && p.left >= 0 && p.top >= 0);
    assert.ok(p.left + p.maxWidth <= Math.max(0, view.width) && p.top + p.maxHeight <= Math.max(0, view.height), JSON.stringify({ view, p }));
  }
});

test("broken numbers in the anchor or size do not leak NaN into the style", () => {
  const view = { width: 320, height: 568 };
  for (const a of [{ left: NaN, top: 10 }, { left: "12", top: undefined }, { left: Infinity, top: -Infinity, right: null, bottom: "x" }])
    for (const size of [{ width: NaN, height: 100 }, { width: 100, height: undefined }, { width: -50, height: -50 }]) {
      const p = placePopover(a, size, view);
      assert.ok(finite(p), JSON.stringify({ a, size, p }));
      assert.ok(p.left >= 0 && p.left + p.maxWidth <= 320 && p.top + p.maxHeight <= 568);
    }
});

test("an anchor scrolled out of the window (above, below, to either side) still gets a pop-over fully in it", () => {
  const view = { width: 375, height: 667 };
  for (const a of [{ left: 20, top: -400, right: 80, bottom: -376 }, { left: 20, top: 1400, right: 80, bottom: 1424 },
    { left: -900, top: 300, right: -860, bottom: 324 }, { left: 2000, top: 300, right: 2060, bottom: 324 }])
    for (const side of ["top", "bottom"]) {
      const p = placePopover(a, { width: 240, height: 300 }, view, { side });
      check(a, { width: 240, height: 300 }, view, { side }, p);
      assert.equal(p.maxHeight, 300, `${JSON.stringify(a)}: the whole window is free, so it is not cut down`);
    }
});

// ------------------------------------------------------------------------------------- openPopover in a fake DOM

const px = (v) => (v == null || v === "" || v === "none" ? null : parseFloat(v));

class FakeEl {
  constructor(doc, tag, natural = { width: 0, height: 0 }) {
    Object.assign(this, { ownerDocument: doc, tagName: tag.toUpperCase(), nodeType: 1, children: [], parentNode: null, hidden: false, dataset: {}, attrs: {} });
    this.natural = natural;      // the content's own size (no limits)
    this.cssMaxHeight = null;    // a max-height from the page's CSS (a design cap)
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    const cls = new Set();
    this.classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => (on ?? !cls.has(c) ? cls.add(c) : cls.delete(c), cls.has(c)), contains: (c) => cls.has(c), [Symbol.iterator]: () => cls[Symbol.iterator]() };
    this.className = "";
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get nextSibling() { const s = this.parentNode?.children; return s ? s[s.indexOf(this) + 1] || null : null; }
  append(...cs) { for (const c of cs) { c.remove?.(); c.parentNode = this; this.children.push(c); } }
  insertBefore(c, ref) { c.remove(); c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; i < 0 ? this.children.push(c) : this.children.splice(i, 0, c); }
  remove() { const p = this.parentNode; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; }
  getAttribute(k) { return k === "style" ? null : this.attrs[k] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { if (k === "style") this.style = { setProperty(a, b) { this[a] = b; }, getPropertyValue(a) { return this[a] ?? ""; } }; delete this.attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getClientRects() { return [1]; }
  closest() { return null; }
  // CSS: used width = max(min-width, min(max-width, width)); height likewise with max-height (inline, else the page's)
  get offsetWidth() { const w = px(this.style.width) ?? this.natural.width, mx = px(this.style.maxWidth) ?? Infinity, mn = px(this.style.minWidth) ?? 0; return Math.max(mn, Math.min(mx, w)); }
  get offsetHeight() { const mx = px(this.style.maxHeight) ?? this.cssMaxHeight ?? Infinity; return Math.min(mx, this.natural.height); }
  get clientHeight() { return this.offsetHeight; }
  get scrollHeight() { return this.natural.height; }
  getBoundingClientRect() { const l = px(this.style.left) ?? 0, t = px(this.style.top) ?? 0; return { left: l, top: t, right: l + this.offsetWidth, bottom: t + this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight }; }
}

function fakeWindow(width, height) {
  const doc = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
  const win = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (f) => setTimeout(f, 0),
    getComputedStyle: (el) => ({ length: 0, maxHeight: el.cssMaxHeight != null && !px(el.style.maxHeight) ? `${el.cssMaxHeight}px` : el.style.maxHeight || "none" }) };
  doc.defaultView = win;
  doc.documentElement = { clientWidth: width, clientHeight: height };
  doc.createElement = (tag) => new FakeEl(doc, tag);
  doc.head = new FakeEl(doc, "head"); doc.body = new FakeEl(doc, "body");
  doc.head.parentNode = doc; doc.body.parentNode = doc;
  return { doc, win };
}

function anchorAt(doc, rect) {
  const a = new FakeEl(doc, "button");
  doc.body.append(a);
  a.rect = rect;
  a.getBoundingClientRect = () => ({ ...a.rect, width: a.rect.right - a.rect.left, height: a.rect.bottom - a.rect.top });
  return a;
}

/** Where the pop-over is drawn, as a browser would size it from what the layer wrote. */
const drawn = (el) => el.getBoundingClientRect();
const onScreen = (r, w, h) => r.left >= 0 && r.top >= 0 && r.right <= w && r.bottom <= h;

test("openPopover with minWidth: an anchor wider than a 320 px phone does not push the pop-over off-screen", () => {
  // min-width beats max-width in CSS: the layer set min-width to the anchor's 400 px while placement gave max-width
  // 304 px, so the drop-down was drawn 400 px wide, 88 px past the right edge of the phone.
  const { doc } = fakeWindow(320, 568);
  for (const [anchorRect, minWidth] of [[{ left: -40, top: 60, right: 360, bottom: 100 }, true], [{ left: 10, top: 60, right: 90, bottom: 100 }, 500]]) {
    const a = anchorAt(doc, anchorRect);
    const el = new FakeEl(doc, "div", { width: 180, height: 200 });
    const h = openPopover(el, { anchor: a, minWidth, focus: false });
    const r = drawn(el);
    assert.ok(onScreen(r, 320, 568), `drawn at x ${r.left}..${r.right} in a 320 px window (minWidth ${minWidth})`);
    assert.ok(r.left >= 8 && r.right <= 312, "inside the margins");
    h.close();
  }
  closeAllPopovers();
});

test("openPopover with minWidth on a wide window still takes the anchor's width", () => {
  const { doc } = fakeWindow(1280, 800);
  const a = anchorAt(doc, { left: 100, top: 40, right: 500, bottom: 70 });
  const el = new FakeEl(doc, "div", { width: 180, height: 200 });
  const h = openPopover(el, { anchor: a, minWidth: true, focus: false });
  assert.equal(drawn(el).width, 400);
  assert.equal(drawn(el).left, 100);
  h.close();
});

test("openPopover with a width element wider than the window: clamped to the window, on-screen", () => {
  const { doc } = fakeWindow(320, 568);
  const bar = anchorAt(doc, { left: 0, top: 0, right: 900, bottom: 40 });
  const el = new FakeEl(doc, "div", { width: 200, height: 300 });
  const h = openPopover(el, { anchor: bar, width: bar, focus: false });
  const r = drawn(el);
  assert.ok(onScreen(r, 320, 568) && r.width === 304, JSON.stringify(r));
  h.close();
});

test("openPopover keeps the pop-over's own CSS max-height and marks it scrolling", () => {
  const { doc } = fakeWindow(320, 568);
  const a = anchorAt(doc, { left: 20, top: 40, right: 80, bottom: 64 });
  const el = new FakeEl(doc, "div", { width: 200, height: 900 });
  el.cssMaxHeight = 260;
  const h = openPopover(el, { anchor: a, focus: false });
  const r = drawn(el);
  assert.equal(r.height, 260, "the design cap holds even with room below");
  assert.equal(r.top, 68);
  assert.ok(el.classList.contains("ss-pop-scrolls"), "its content is taller: it scrolls inside");
  assert.equal(el.dataset.side, "bottom");
  h.close();
});

test("openPopover beside an anchor near the bottom-right corner of a phone: above it, on-screen, not over it", () => {
  const { doc } = fakeWindow(320, 568);
  const a = anchorAt(doc, { left: 280, top: 530, right: 312, bottom: 560 });
  const el = new FakeEl(doc, "div", { width: 220, height: 330 });
  const h = openPopover(el, { anchor: a, align: "end", focus: false });
  const r = drawn(el);
  assert.ok(onScreen(r, 320, 568), JSON.stringify(r));
  assert.equal(el.dataset.side, "top");
  assert.ok(r.bottom <= 530 - 4, "ends above the anchor");
  assert.equal(r.right, 312, "right-aligned to the anchor");
  h.close();
});

test("openPopover: an anchor that hides keeps the last place; one that was never visible closes it", () => {
  const { doc } = fakeWindow(1024, 640);
  const a = anchorAt(doc, { left: 100, top: 100, right: 160, bottom: 124 });
  const el = new FakeEl(doc, "div", { width: 200, height: 150 });
  const h = openPopover(el, { anchor: a, focus: false });
  const first = drawn(el);
  a.rect = { left: 0, top: 0, right: 0, bottom: 0 };          // re-rendered away (display:none)
  h.update();
  assert.deepEqual(drawn(el), first);
  assert.ok(isPopoverOpen(el));
  h.close();
  let why = null;
  const ghost = anchorAt(doc, { left: 0, top: 0, right: 0, bottom: 0 });
  const el2 = new FakeEl(doc, "div", { width: 200, height: 150 });
  openPopover(el2, { anchor: ghost, focus: false, onClose: (w) => { why = w; } });
  assert.equal(why, "anchor");
  assert.ok(!isPopoverOpen(el2));
});

test("openPopover: an anchor scrolled up out of the window keeps the pop-over in it", () => {
  const { doc } = fakeWindow(375, 667);
  const a = anchorAt(doc, { left: 40, top: 200, right: 120, bottom: 230 });
  const el = new FakeEl(doc, "div", { width: 240, height: 300 });
  const h = openPopover(el, { anchor: a, focus: false });
  a.rect = { left: 40, top: -900, right: 120, bottom: -870 };   // the page scrolled
  h.update();
  assert.ok(onScreen(drawn(el), 375, 667), JSON.stringify(drawn(el)));
  h.close();
});
