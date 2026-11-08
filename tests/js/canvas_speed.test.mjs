// Canvas speed (Jon's measured report, 2026-11-08): idle GPU 22 % from 20 setInterval polls (the 1 s activity clock most
// of it), a second full Stage for the Presets live thumbnails (~2.7 s of time to interactive), Paint Studio reading
// pixels back while closed, synchronous shader compiles and a duplicate first render, duplicate JSON fetches, the
// shot-camera picture-in-picture doubling GPU time in Free view. Each test here fails on the commit before its fix.
// (Offscreen thumbnails and captures, the setSize part of the report: tests/js/offscreen_capture.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = (p) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

// ---------------------------------------------------------------- a tiny DOM (enough for the activity pill)
function fakeDom() {
  const writes = { n: 0 };
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ""; this._text = ""; this._hidden = false;
      this.parentNode = null; this._title = "";
      const w = writes;
      this.dataset = new Proxy({}, { set(o, k, v) { if (o[k] !== v) w.n++; o[k] = v; return true; } });
      this.style = new Proxy({}, { set(o, k, v) { w.n++; o[k] = v; return true; } });
    }
    append(...c) { for (const x of c) { this.children.push(x); x.parentNode = this; } }
    insertBefore(x) { this.append(x); }
    setAttribute(k, v) { writes.n++; this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener() {} removeEventListener() {} remove() {}
    get hidden() { return this._hidden; } set hidden(v) { writes.n++; this._hidden = !!v; }
    get title() { return this._title; } set title(v) { writes.n++; this._title = v; }
    set textContent(v) { writes.n++; this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  }
  const doc = { createElement: (t) => new El(t), getElementById: () => null, head: new El("head"), hidden: false, addEventListener() {}, removeEventListener() {} };
  return { doc, writes, El };
}

function withTimers(fn) {
  const live = new Map();
  let id = 0;
  const si = globalThis.setInterval, ci = globalThis.clearInterval;
  globalThis.setInterval = (f, ms) => { live.set(++id, { f, ms }); return id; };
  globalThis.clearInterval = (i) => { live.delete(i); };
  return Promise.resolve(fn(live)).finally(() => { globalThis.setInterval = si; globalThis.clearInterval = ci; });
}

test("the activity pill's 1 s clock is off at idle and ticks only while a job runs (or its panel is open); idle draws write nothing", async () => {
  const { doc, writes, El } = fakeDom();
  const g = globalThis, had = { document: g.document, window: g.window, localStorage: g.localStorage };
  g.document = doc;
  try {
    await withTimers(async (live) => {
      const { mountActivity } = await import("../../web/ui/activity.mjs");
      const listeners = new Map();
      const api = { clientId: "me", addEventListener: (t, f) => listeners.set(t, f), removeEventListener() {}, fetchApi: async () => ({ ok: false, json: async () => ({}) }) };
      const row = new El("div"); const host = new El("div"); host.append(row);
      const win = { addEventListener() {}, removeEventListener() {}, document: doc, matchMedia: () => ({ matches: false }) };
      const pill = mountActivity({ api, row, win });
      const clocks = () => [...live.values()].filter((t) => t.ms === 1000).length;
      assert.equal(clocks(), 0, "no 1 s clock at idle (it ran from mount, forever)");
      const w0 = writes.n;
      for (let i = 0; i < 5; i++) pill.draw();
      assert.equal(writes.n, w0, "an idle redraw writes no text, attribute or style");
      // a job starts: the clock runs; it ends: the clock stops
      pill.registry.onEvent("execution_start", { prompt_id: "p1" });
      pill.draw();
      assert.equal(clocks(), 1, "the clock ticks while a job runs");
      pill.draw();
      assert.equal(clocks(), 1, "one clock, not one per draw");
      pill.registry.onEvent("execution_success", { prompt_id: "p1" });
      pill.draw();
      assert.equal(clocks(), 0, "and stops when nothing runs");
      pill.dispose();
    });
  } finally { for (const [k, v] of Object.entries(had)) { if (v === undefined) delete g[k]; else g[k] = v; } }
});

test("Presets: no scratch Stage (a second WebGL context and its shader compile) before the Presets window opens", () => {
  const s = SRC("ui/presets.mjs");
  assert.ok(!/\.warm\(/.test(s), "ui/presets.mjs pre-warms the live thumbnails at load (a second Stage ~6 s after load)");
  // ensureLive() (which builds LiveThumbs, and through it the scratch Stage) is reached only from the open panel: its
  // card queue (queueLive returns at once while the panel is hidden) and a card hover. Never from a timer or idle callback.
  assert.match(s, /function queueLive\(\) \{\s*\n\s*if \(panel\.hidden \|\| !ensureLive\(\)\) return;/);
  assert.ok(!/(setTimeout|requestIdleCallback)\([^;]*ensureLive/.test(s), "ensureLive from a timer / idle callback");
});

test("Paint Studio closed: no stage render and no Fill-state pixel read-backs; opening it catches up", async () => {
  const { CanvasPanel } = await import("../../web/canvas/canvas.mjs");
  const seen = { renders: 0, area: 0, hole: 0 };
  const hidden = { closest: (sel) => (sel === "[hidden]" ? {} : null), isConnected: true };
  const shown = { closest: () => null, isConnected: true };
  const p = Object.create(CanvasPanel.prototype);
  Object.assign(p, {
    root: hidden, fillBtn: { querySelector: () => ({}) }, removeBtn: {}, extendBtn: { classList: { toggle() {} } }, areaNote: {},
    fill: { busy: false, refs: new Set() }, models: [], fillReady: false, layers: [{ kind: "stage", canvas: { getContext: () => ({ clearRect() {}, drawImage() {} }) } }],
    stage: { renderFrameTo: () => { seen.renders++; return {}; }, frame: 0 }, M: 0, W: 4, H: 4, EW: 4, EH: 4,
    _hasArea() { seen.area++; return false; }, _hasHole() { seen.hole++; return false; }, _renderLayers() {}, render() {},
  });
  p._renderFillState();
  p.refreshStage();
  assert.deepEqual(seen, { renders: 0, area: 0, hole: 0 }, "nothing rendered or read back while closed");
  p.root = shown;
  p.refreshStage();
  assert.deepEqual(seen, { renders: 1, area: 1, hole: 1 }, "opened: the stage layer and the Fill state are brought up to date once");
});

test("polls write style only when a value changed (setStyles / setProp), in the stage's 250-500 ms polls and the Stop poll", async () => {
  const { setStyles, setProp } = await import("../../web/ui/domwrite.mjs");
  let writes = 0;
  const style = new Proxy({}, { set(o, k, v) { writes++; o[k] = v; return true; } });
  const el = { style };
  assert.equal(setStyles(el, { left: "8px", display: "flex" }), 2);
  assert.equal(setStyles(el, { left: "8px", display: "flex" }), 0, "the same values again: no write");
  assert.equal(writes, 2);
  const b = { hidden: true };
  assert.equal(setProp(b, "hidden", true), false);
  assert.equal(setProp(b, "hidden", false), true);
  // the polls themselves
  const body = (src, from, len = 900) => { const i = src.indexOf(from); assert.ok(i >= 0, from); return src.slice(i, i + len); };
  const vn = body(SRC("stage/viewnav.mjs"), "const place = () => {", 1200);
  const nav = body(SRC("stage/navigation.mjs"), "function place() {", 1500);
  const dr = body(SRC("stage/drive.mjs"), "export function installDriveButton(stage) {", 1400);
  const pl = body(SRC("pipeline/pipeline.mjs"), "async _refreshStop() {", 600);
  for (const [n, s] of [["viewnav place", vn], ["navigation place", nav], ["drive button", dr], ["pipeline stop", pl]]) {
    assert.ok(!/Object\.assign\(\w+\.style/.test(s) && !/\.style\.\w+ = /.test(s), `${n} writes style every tick`);
    assert.match(s, /setStyles|setProp/, `${n} uses the write-on-change helpers`);
  }
});

test("Stage's first frame: renderer.compileAsync first, then ONE render for every render() asked meanwhile (the constructor drew three times, compiling synchronously)", async () => {
  const { Stage } = await import("../../web/stage/stage.mjs");
  const order = [];
  let finish;
  const st = Object.create(Stage.prototype);
  Object.assign(st, { _booting: true, view: "color", scene: {}, camera: {}, _viewportCamera: () => ({}),
    renderer: { compileAsync: () => { order.push("compile"); return new Promise((r) => { finish = r; }); } } });
  st._renderMode = (m) => order.push(`render:${m}`);
  st.render(); st.render();
  st._firstRender();
  st.render();
  assert.deepEqual(order, ["compile"], "nothing is drawn while the shaders compile");
  finish();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ["compile", "render:color"], "then one render");
  st.render();
  assert.equal(order.length, 3, "and renders go straight through afterwards");
  // without compileAsync (an old three / a fake renderer) it draws at once
  const st2 = Object.assign(Object.create(Stage.prototype), { _booting: true, view: "color", renderer: {} });
  let n = 0; st2._renderMode = () => n++;
  st2._firstRender();
  assert.equal(n, 1);
  // the constructor itself never calls render() directly; scratch stages can skip the first draw
  const src = SRC("stage/stage.mjs");
  const ctor = src.slice(src.indexOf("  constructor(container, onChange, opts = {}) {"), src.indexOf("  _firstRender() {"));
  assert.ok(!/\n    this\.render\(\);/.test(ctor), "a direct render() in the constructor");
  assert.match(ctor, /this\._firstRender\(\)/);
  for (const f of ["presets/livethumbs.mjs", "book/clay.mjs"]) assert.match(SRC(f), /firstRender: false/, `${f} scratch stage draws a first frame it never shows`);
});

test("static JSON is fetched once per page: lighting_setups.json (3 fetches per load) and style_presets.json (2) go through fetchJSON", async () => {
  const { fetchJSON, clearJSONCache, stats } = await import("../../web/look/jsoncache.mjs");
  clearJSONCache();
  const f0 = globalThis.fetch;
  let n = 0, fail = true;
  globalThis.fetch = async () => { n++; if (fail) { fail = false; return { ok: false, status: 503 }; } return { ok: true, json: async () => ({ setups: [{ id: "a" }] }) }; };
  try {
    await assert.rejects(fetchJSON("http://x/look/lighting_setups.json"), /503/);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => fetchJSON("http://x/look/lighting_setups.json")));
    assert.equal(n, 2, "a failure is retried once; then three callers share one request");
    a.setups.push({ id: "mine" });
    assert.deepEqual(b.setups, [{ id: "a" }], "each caller gets its own copy");
    assert.notEqual(b, c);
    assert.equal(stats.fetches, 2);
  } finally { globalThis.fetch = f0; clearJSONCache(); }
  for (const f of ["soundstage.js", "ui/presets.mjs", "oneclick/light.mjs", "look/look.mjs"]) {
    const s = SRC(f);
    assert.ok(!/fetch\(new URL\("[^"]*(lighting_setups|style_presets)\.json"/.test(s) && !/fetch\(url, \{ cache/.test(s), `${f} fetches the JSON itself`);
    assert.match(s, /fetchJSON\(/, `${f} uses fetchJSON`);
  }
});
