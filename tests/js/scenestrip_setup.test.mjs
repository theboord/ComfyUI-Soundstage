// node --test tests/js/scenestrip_setup.test.mjs
// The scene strip's "Set up scene …" button: it lives on its own line under the shot tiles (it used to sit beside
// them, on top of 1M, 1N and 1P at 1600 px, so a click on a tile set the scene up and rewrote the stage), and it asks
// before it sets up a scene that already has actors. The pixel check at 1024 / 1280 / 1600 / 1920 is
// tools/qa/scenestrip_overlap.mjs (headless, the real App); this file pins the structure and the confirm flow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---- a small DOM: enough for SceneStrip (elements, classes, attributes, events, a few selectors)
class El {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.style = {};
    this.listeners = {}; this.hidden = false; this.parent = null; this._text = "";
    const self = this;
    this.classList = { contains: (c) => (self.attrs.class || "").split(/\s+/).includes(c) };
  }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class || ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  append(...k) { for (const c of k) { if (c && typeof c === "object") c.parent = this; this.children.push(c); } }
  after(...k) { this.parent?.append(...k); }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get textContent() { return this.children.map((c) => (typeof c === "object" ? c.textContent : String(c))).join("") + this._text; }
  get isConnected() { return true; }
  get offsetParent() { return this.hidden ? null : {}; }
  get offsetLeft() { return 0; } get offsetWidth() { return 0; }
  getContext() { return { drawImage() {} }; }
  click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {}, preventDefault() {} }); }
  all() { return this.children.filter((c) => typeof c === "object").flatMap((c) => [c, ...c.all()]); }
  querySelector(sel) { return this.all().find((e) => match(e, sel)) || null; }
  querySelectorAll(sel) { return this.all().filter((e) => match(e, sel)); }
}
function match(e, sel) {
  const m = /^(\w+)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="?([^"\]]*)"?)?\])?$/.exec(sel.trim());
  if (!m) return false;
  const [, tag, cls, attr, val] = m;
  if (tag && e.tagName !== tag.toUpperCase()) return false;
  if (cls && !e.classList.contains(cls)) return false;
  if (attr && (val == null ? e.attrs[attr] == null : e.attrs[attr] !== val)) return false;
  return true;
}
const doc = { head: new El("head"), getElementById: () => null, createElement: (t) => new El(t), createTextNode: (t) => { const n = new El("#text"); n._text = t; return n; } };
globalThis.document = doc;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = undefined;
const { SceneStrip } = await import("../../web/script/scenestrip.mjs");

const SCENES = [{ id: "sc_1", number: 1, heading: "EXT. DESERT OUTSIDE DRY CREEK - DUSK", characters: ["EZRA", "MARA"] }, { id: "sc_2", number: 2, heading: "INT. CAR - NIGHT" }];
const SHOTS = ["1A", "1B", "1K", "1L", "1M", "1N", "1P"].map((n) => ({ id: `sc_1__${n}`, name: `${n} shot`, scene_id: "sc_1", thumb: "x.png" }));

function make({ actors = 4, changes = 2, cur = "sc_1" } = {}) {
  const calls = { setup: 0, shot: [] };
  const o = {
    getScript: () => ({ scenes: SCENES }), current: () => o.cur, getShots: () => SHOTS, activeShot: () => "sc_1__1A",
    onScene: () => {}, onShot: (id) => calls.shot.push(id), shotStatus: () => null,
    setupInfo: () => ({ label: "Set up scene 1 — EXT. DESERT OUTSIDE DRY CREEK — DUSK (Ezra, Mara)", changes, canUndo: false, actors }),
    onSetup: () => { calls.setup++; }, onUndo: () => {}, cur,
  };
  const host = new El("div");
  const strip = new SceneStrip(host, o);
  strip._draw();
  return { strip, calls, o };
}
const setupBtn = (s) => s.act.querySelectorAll("button").find((b) => /^Set up scene/.test(b.textContent));

test("the setup button is on its own line: a child of the strip after the tiles, never inside the tile row", () => {
  const { strip } = make();
  assert.ok(setupBtn(strip), "the scene can be set up");
  assert.equal(strip.act.parent, strip.el);
  assert.ok(!strip.rail.all().includes(setupBtn(strip)), "not among the tiles");
  assert.equal(strip.el.dataset.act, "true", "the strip grows by one line while it has an action");
  const css = readFileSync(new URL("../../web/script/scenestrip.mjs", import.meta.url), "utf8");
  assert.match(css, /\.ss-scstrip \{ flex-wrap:wrap;/, "the strip wraps");
  assert.match(css, /\.ss-scstrip \.act \{ order:9; flex:1 0 100%;/, "the action line takes the full width under the tiles");
  assert.match(css, /\.ss-scstrip\.ss-scstrip\.ss-scstrip\.ss-scstrip\[data-act=true\] \{ height:auto !important; \}/,
    "the drop-down's fixed 64 px height gives way (beats .ss-stage.ss-cl .ss-scenepop > .ss-scstrip)");
  assert.doesNotMatch(css, /\.act \{ flex:0 0 auto; display:flex; flex-direction:column/, "the old side column is gone");
});

test("a scene that already has actors asks first; only 'Set up anyway' sets it up", () => {
  const { strip, calls } = make({ actors: 4 });
  setupBtn(strip).click(); strip._draw();
  assert.equal(calls.setup, 0, "one click no longer rewrites the stage");
  const ask = strip.act.querySelector("span.ask");
  assert.ok(ask && /already has 4 actors/.test(ask.textContent), ask?.textContent);
  assert.equal(strip.pick.dataset.setup, "false", "no 'can be set up' dot while asking");
  strip.act.querySelector('button[data-confirm="no"]').click(); strip._draw();
  assert.equal(calls.setup, 0, "Cancel sets nothing up");
  assert.ok(setupBtn(strip), "back to the button");
  setupBtn(strip).click(); strip._draw();
  strip.act.querySelector('button[data-confirm="yes"]').click();
  assert.equal(calls.setup, 1, "confirmed: set up once");
});

test("an empty stage sets up on the first click; the question goes away on another scene", () => {
  const a = make({ actors: 0 });
  setupBtn(a.strip).click();
  assert.equal(a.calls.setup, 1);
  const b = make({ actors: 2 });
  setupBtn(b.strip).click(); b.strip._draw();
  assert.ok(b.strip.act.querySelector("span.ask"));
  b.o.cur = "sc_2"; b.strip._draw();
  assert.equal(b.strip.act.querySelector("span.ask"), null, "a pending question doesn't follow you to another scene");
  assert.equal(b.calls.setup, 0);
});

test("a tile click picks the shot and never sets the scene up", () => {
  const { strip, calls } = make({ actors: 4 });
  const tiles = strip.rail.querySelectorAll("button.shot");
  assert.equal(tiles.length, SHOTS.length, strip.rail.all().map((e) => e.tagName + "." + e.className).join(" "));
  for (const t of tiles) t.click();
  assert.deepEqual(calls.shot, SHOTS.map((s) => s.id));
  assert.equal(calls.setup, 0);
});
