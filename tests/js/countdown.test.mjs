// node --test tests/js/countdown.test.mjs
// The big render countdown (web/ui/countdown.mjs): the words for a known ETA / no measured run yet / past the average,
// the queue line, the Done / Failed card and its one-shot hide, no interval at idle (it has no clock of its own), the
// per-viewer preference guard, placement that never covers the centre, and the wiring into the Activity pill.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { countdownModel, finishModel, afterLine, progressOf, jobPhrase, shortClock, normalizeCountdownPrefs, loadCountdownPrefs,
  saveCountdownPrefs, COUNTDOWN_KEY, nearestCorner, boxAt, clearOfCenter, fitSize, SIZES, createCountdown, HOLD_DONE_MS } from "../../web/ui/countdown.mjs";
import { ActivityRegistry, EtaBook } from "../../web/ui/activity.mjs";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };
const clockAt = (t0 = 1_000_000) => { const c = { t: t0 }; c.now = () => c.t; return c; };

test("known ETA: big mm:ss time left, elapsed underneath, the job and shot as the title", () => {
  const eta = new EtaBook({ storage: memStore() });
  for (let i = 0; i < 4; i++) eta.record("draft@any", 180_000);
  const c = clockAt();
  const reg = new ActivityRegistry({ eta, now: c.now, clientId: "me" });
  reg.note("p", { name: "Draft · shot 3", kind: "draft" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  c.t += 19_000;
  const v = reg.view();
  const m = countdownModel(v.running[0], v.totals);
  assert.equal(m.mode, "eta");
  assert.equal(m.big, "02:41");
  assert.equal(m.label, "Time left");
  assert.equal(m.title, "Draft · shot 3");
  assert.match(m.sub, /00:19 so far/);
  assert.equal(m.canStop, true);
  assert.equal(m.pct, 11, "time-based when there is no node detail");
  assert.equal(m.from, "time");
  // A thin book says so.
  const m1 = countdownModel({ id: "x", name: "Final", elapsedMs: 10_000, etaAvgMs: 70_000, etaRuns: 1, remainingMs: 60_000 });
  assert.equal(m1.big, "01:00");
  assert.match(m1.sub, /estimate from 1 run$/);
});

test("unknown: 'Learning how long this takes' with the elapsed time until the EtaBook has a run of this kind", () => {
  const c = clockAt();
  const reg = new ActivityRegistry({ eta: new EtaBook({ storage: memStore() }), now: c.now });
  reg.note("p", { name: "Recast · shot 2", kind: "other" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  c.t += 75_000;
  const m = countdownModel(reg.view().running[0], reg.view().totals);
  assert.equal(m.mode, "learning");
  assert.equal(m.label, "Learning how long this takes");
  assert.equal(m.big, "01:15", "elapsed, counting up");
  assert.equal(m.indeterminate, true, "no made-up progress");
  // a sampler's step rate gives a lower bound, said as one
  const s = countdownModel({ id: "y", name: "Frame", elapsedMs: 20_000, etaRuns: 0, etaAvgMs: null, remainingMs: 40_000, remainingAtLeast: true, step: 4, steps: 12 });
  assert.equal(s.mode, "learning");
  assert.match(s.sub, /at least 00:40 left/);
  assert.equal(s.pct, 33);
});

test("overdue: 'Longer than usual' and +mm:ss past the average", () => {
  const eta = new EtaBook({ storage: memStore() });
  for (let i = 0; i < 3; i++) eta.record("final@any", 120_000);
  const c = clockAt();
  const reg = new ActivityRegistry({ eta, now: c.now, clientId: "me" });
  reg.note("p", { name: "Final · shot 1", kind: "final" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  c.t += 130_500;
  const m = countdownModel(reg.view().running[0], reg.view().totals);
  assert.equal(m.mode, "overdue");
  assert.equal(m.label, "Longer than usual");
  assert.equal(m.big, "+00:10");
  assert.match(m.sub, /02:10 so far · usually 02:00/);
});

test("queue line: 'N more after this'; progress prefers ComfyUI's per-node progress", () => {
  assert.equal(afterLine({ queued: 0 }), null);
  assert.equal(afterLine({ queued: 1 }), "1 more after this");
  assert.equal(afterLine({ queued: 2 }), "2 more after this");
  assert.equal(countdownModel({ id: "a", name: "x", elapsedMs: 1 }, { queued: 2 }).after, "2 more after this");
  assert.deepEqual(progressOf({ pct: 80, detail: { total: 10, done: 4, step: 5, steps: 10 } }), { pct: 45, from: "nodes" });
  assert.deepEqual(progressOf({ pct: 80 }), { pct: 80, from: "time" });
  assert.deepEqual(progressOf({ step: 3, steps: 6 }), { pct: 50, from: "steps" });
  assert.deepEqual(progressOf({}), { pct: null, from: null });
});

test("finish and failure states: 'Done: Draft of shot 3 (2:41)', 'Failed' with the reason", () => {
  assert.equal(jobPhrase("Draft · shot 3"), "Draft of shot 3");
  assert.equal(shortClock(161_000), "2:41");
  assert.equal(shortClock(3_725_000), "1:02:05");
  assert.deepEqual(finishModel({ id: "a", name: "Draft · shot 3", state: "done", endedAt: 1, elapsedMs: 161_000 }),
    { id: "a", state: "done", big: "Done", line: "Done: Draft of shot 3 (2:41)", reason: null });
  const f = finishModel({ id: "b", name: "Final · shot 1", state: "failed", endedAt: 1, elapsedMs: 5000, error: "Ran out of GPU memory." });
  assert.deepEqual([f.state, f.big, f.line, f.reason], ["failed", "Failed", "Failed: Final of shot 1 (0:05)", "Ran out of GPU memory."]);
  assert.equal(finishModel({ id: "c", name: "x", state: "cancelled", endedAt: 1 }).state, "stopped");
  assert.equal(finishModel({ id: "d", state: "running" }), null);
});

test("preference persistence guard: blocked or broken storage gives defaults and never throws; a choice round-trips", () => {
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  assert.deepEqual(loadCountdownPrefs(throwing), { size: "big", collapsed: false, corner: "bl" });
  assert.equal(saveCountdownPrefs({ size: "small" }, throwing), false, "a blocked save is quiet");
  const junk = memStore(); junk.setItem(COUNTDOWN_KEY, "{not json");
  assert.deepEqual(loadCountdownPrefs(junk), { size: "big", collapsed: false, corner: "bl" });
  assert.deepEqual(normalizeCountdownPrefs({ size: "huge", corner: "middle", collapsed: "yes" }), { size: "big", collapsed: true, corner: "bl" });
  assert.deepEqual(loadCountdownPrefs(null), { size: "big", collapsed: false, corner: "bl" }, "no storage at all");
  const st = memStore();
  assert.equal(saveCountdownPrefs({ size: "small", collapsed: true, corner: "tr" }, st), true);
  assert.deepEqual(loadCountdownPrefs(st), { size: "small", collapsed: true, corner: "tr" });
});

test("placement: snaps to the nearest corner, and never covers the centre (big -> small -> pill at phone width)", () => {
  assert.equal(nearestCorner(10, 10, 800, 450), "tl");
  assert.equal(nearestCorner(790, 440, 800, 450), "br");
  assert.equal(nearestCorner(100, 400, 800, 450), "bl");
  assert.equal(fitSize("big", 1200, 675), "big");
  for (const [w, h] of [[1200, 675], [800, 450], [600, 340], [375, 420], [320, 180], [360, 640]]) {
    for (const corner of ["bl", "br", "tl", "tr"]) {
      const s = fitSize("big", w, h, corner);
      const z = SIZES[s];
      assert.ok(clearOfCenter(boxAt(corner, z.w, z.h, w, h), w, h), `${s} at ${corner} covers the centre of ${w}x${h}`);
    }
  }
  assert.equal(fitSize("big", 375, 420), "small", "phone portrait: the small card fits under the middle");
  assert.equal(fitSize("big", 320, 180), "pill");
  assert.equal(fitSize("small", 1200, 675), "small", "the viewer's smaller choice is kept");
  assert.equal(fitSize("big", 0, 0), "big", "unknown host size keeps the choice");
});

// ---- Fake DOM for the card.
function fakeDocument() {
  const writes = { n: 0 };
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ""; this._text = ""; this._hidden = false; this.handlers = {};
      this.dataset = new Proxy({}, { set(o, k, v) { if (o[k] !== v) writes.n++; o[k] = v; return true; } });
      this.style = new Proxy({}, { set(o, k, v) { writes.n++; o[k] = v; return true; } }); }
    append(...c) { for (const x of c) { this.children.push(x); x.parentNode = this; } }
    insertBefore(x) { this.append(x); }
    contains() { return false; }
    setAttribute(k, v) { writes.n++; this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }
    removeEventListener() {}
    fire(t, e = {}) { for (const f of this.handlers[t] || []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
    remove() {}
    get hidden() { return this._hidden; } set hidden(v) { writes.n++; this._hidden = !!v; }
    set textContent(v) { writes.n++; this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (c.hidden ? "" : c.textContent)).join(""); }
    byClass(cls) { const out = []; const walk = (e) => { for (const c of e.children) { if (String(c.className).split(" ").includes(cls)) out.push(c); walk(c); } }; walk(this); return out; }
  }
  return { doc: { createElement: (t) => new El(t) }, El, writes };
}

function withDom(fn) {
  const { doc, El, writes } = fakeDocument();
  const had = globalThis.document;
  globalThis.document = doc;
  const si = globalThis.setInterval, live = new Set();
  globalThis.setInterval = (f, ms) => { const id = si(() => {}, 1e9); live.add(id); return id; };
  try { return fn({ El, writes, intervals: live }); } finally {
    for (const id of live) clearInterval(id);
    globalThis.setInterval = si;
    if (had === undefined) delete globalThis.document; else globalThis.document = had;
  }
}

function timers() {
  const q = new Map(); let id = 0;
  return { setT: (f, ms) => { q.set(++id, { f, ms }); return id; }, clearT: (i) => q.delete(i), q,
    run() { for (const [i, t] of [...q]) { q.delete(i); t.f(); } } };
}

test("the card: shows while a job runs, Stop calls the stop path, Done for a few seconds then hides; Failed with the reason link", () => withDom(({ El, intervals }) => {
  const eta = new EtaBook({ storage: memStore() });
  for (let i = 0; i < 3; i++) eta.record("draft@any", 180_000);
  const c = clockAt();
  const reg = new ActivityRegistry({ eta, now: c.now, clientId: "me" });
  const host = new El("div");
  const t = timers();
  const stops = [], whys = [];
  const cd = createCountdown({ host, storage: memStore(), setT: t.setT, clearT: t.clearT, onStop: (r) => stops.push(r.id), onWhy: () => whys.push(1),
    sound: { on: () => true, toggle() {} } });
  assert.equal(cd.el.hidden, true);
  cd.update(reg.view());
  assert.equal(cd.el.hidden, true, "nothing runs: hidden");
  reg.note("p", { name: "Draft · shot 3", kind: "draft" });
  reg.note("q", { name: "Draft · shot 4", kind: "draft" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  reg.applySummary({ running: 1, pending: 1, items: [{ prompt_id: "p", state: "running", position: 0 }, { prompt_id: "q", state: "queued", position: 1 }] });
  c.t += 19_000;
  cd.update(reg.view());
  const txt = () => cd.el.textContent;
  assert.equal(cd.el.hidden, false);
  assert.match(txt(), /Draft · shot 3/);
  assert.match(txt(), /02:41/);
  assert.match(txt(), /Time left/);
  assert.match(txt(), /1 more after this/);
  cd.el.byClass("ss-cd-stop")[0].fire("click");
  assert.deepEqual(stops, ["p"]);
  assert.match(txt(), /Stopping…/);
  // finishes: the Done card, one one-shot hide timer, then hidden
  c.t += 142_000;
  reg.onEvent("execution_success", { prompt_id: "p" });
  reg.applySummary({ running: 0, pending: 0, items: [] });
  reg.jobs.delete("q");
  cd.update(reg.view());
  assert.match(txt(), /Done: Draft of shot 3 \(2:41\)/);
  assert.equal(cd.el.dataset.state, "done");
  assert.equal(t.q.size, 1);
  assert.equal([...t.q.values()][0].ms, HOLD_DONE_MS);
  t.run();
  assert.equal(cd.el.hidden, true, "hides after a few seconds");
  // a failure: Failed, the plain reason, and the link that opens the Activity panel
  reg.note("f", { name: "Final · shot 1", kind: "final" });
  reg.onEvent("execution_start", { prompt_id: "f" });
  cd.update(reg.view());
  c.t += 5000;
  reg.onEvent("execution_error", { prompt_id: "f", node_id: "7", node_type: "KSampler", exception_message: "CUDA error: out of memory" });
  cd.update(reg.view());
  assert.equal(cd.el.dataset.state, "failed");
  assert.match(txt(), /Failed: Final of shot 1/);
  assert.match(txt(), /Ran out of GPU memory/);
  const why = cd.el.byClass("ss-cd-why")[0];
  assert.equal(why.hidden, false);
  why.fire("click");
  assert.equal(whys.length, 1);
  assert.equal(intervals.size, 0, "the card never starts an interval");
  cd.dispose();
}));

test("no interval when idle: mounted on the pill with an overlay, idle draws start no clock and write nothing", async () => {
  const { doc, El, writes } = fakeDocument();
  doc.getElementById = () => null; doc.head = new El("head"); doc.hidden = false; doc.addEventListener = () => {}; doc.removeEventListener = () => {};
  const g = globalThis, had = g.document;
  g.document = doc;
  const si = g.setInterval, ci = g.clearInterval, live = new Map(); let id = 0;
  g.setInterval = (f, ms) => { live.set(++id, ms); return id; };
  g.clearInterval = (i) => live.delete(i);
  try {
    const { mountActivity } = await import("../../web/ui/activity.mjs");
    const api = { clientId: "me", addEventListener() {}, removeEventListener() {}, fetchApi: async () => ({ ok: false, json: async () => ({}) }) };
    const row = new El("div"); const top = new El("div"); top.append(row);
    const overlay = new El("div");
    const win = { addEventListener() {}, removeEventListener() {}, document: doc, matchMedia: () => ({ matches: false }) };
    const pill = mountActivity({ api, row, win, overlay });
    try {
      assert.ok(pill.countdown, "the countdown mounts on the overlay");
      assert.ok(overlay.children.includes(pill.countdown.el));
      assert.equal(live.size, 0, "no interval at idle");
      const w0 = writes.n;
      for (let i = 0; i < 5; i++) pill.draw();
      assert.equal(writes.n, w0, "idle draws write nothing (countdown included)");
      assert.equal(pill.countdown.el.hidden, true);
      pill.registry.note("p1", { name: "Draft · shot 3" });
      pill.registry.onEvent("execution_start", { prompt_id: "p1" });
      assert.equal(pill.countdown.el.hidden, false, "shows when a job starts");
      assert.deepEqual([...live.values()], [1000], "the Activity's one clock, not a second one");
      pill.registry.onEvent("execution_success", { prompt_id: "p1" });
      assert.equal(live.size, 0, "clock off once nothing runs");
      assert.match(pill.countdown.el.textContent, /Done: Draft of shot 3/);
    } finally { pill.dispose(); }
  } finally {
    g.setInterval = si; g.clearInterval = ci;
    if (had === undefined) delete g.document; else g.document = had;
  }
});

test("the App mounts the countdown over the stage view", () => {
  const src = readFileSync(fileURLToPath(new URL("../../web/soundstage.js", import.meta.url)), "utf8");
  assert.match(src, /mountActivity\(\{ api, row: tabs, before: guideBtn, theme: el, overlay: view \}\)/);
});
