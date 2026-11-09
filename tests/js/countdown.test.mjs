// node --test tests/js/countdown.test.mjs
// The big render countdown band at the top of the App (web/ui/countdown.mjs): both clocks (elapsed and time left) for a
// known estimate / nothing to go on / past the usual time / the estimator's rough first guess, the queue line with the
// all-done time, the Done / Failed state and its one-shot hide, no interval at idle (it has no clock of its own), the
// per-viewer preference guard, and the wiring into the Activity pill (above the top bar, not over the stage).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { countdownModel, finishModel, afterLine, progressOf, jobPhrase, shortClock, normalizeCountdownPrefs, loadCountdownPrefs,
  saveCountdownPrefs, COUNTDOWN_KEY, createCountdown, HOLD_DONE_MS, COUNTDOWN_CSS } from "../../web/ui/countdown.mjs";
import { ActivityRegistry, EtaBook } from "../../web/ui/activity.mjs";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };
const clockAt = (t0 = 1_000_000) => { const c = { t: t0 }; c.now = () => c.t; return c; };
// est: null: these registry cases run on the per-kind EtaBook; the size-aware estimator has tests/js/estimator.test.mjs.
const registry = (eta, c) => new ActivityRegistry({ eta, est: null, now: c.now, clientId: "me" });

test("known ETA: both clocks, ELAPSED and TIME LEFT, with the job and shot as the title", () => {
  const eta = new EtaBook({ storage: memStore() });
  for (let i = 0; i < 4; i++) eta.record("draft@any", 180_000);
  const c = clockAt();
  const reg = registry(eta, c);
  reg.note("p", { name: "Draft · shot 3", kind: "draft" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  c.t += 19_000;
  const v = reg.view();
  const m = countdownModel(v.running[0], v.totals);
  assert.deepEqual([m.mode, m.elapsed, m.leftLabel, m.left, m.leftNote], ["eta", "00:19", "Time left", "02:41", "about"]);
  assert.equal(m.title, "Draft · shot 3");
  assert.equal(m.canStop, true);
  assert.deepEqual([m.pct, m.from], [11, "time"], "time-based when there is no node detail");
  const thin = countdownModel({ id: "x", name: "Final", elapsedMs: 10_000, etaAvgMs: 70_000, etaRuns: 1, remainingMs: 60_000 });
  assert.deepEqual([thin.left, thin.leftNote], ["01:00", "estimate from 1 run"]);
});

test("unknown: 'Learning how long this takes' in the time-left slot, the elapsed clock still counting", () => {
  const c = clockAt();
  const reg = registry(new EtaBook({ storage: memStore() }), c);
  reg.note("p", { name: "Recast · shot 2", kind: "other" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  c.t += 75_000;
  const m = countdownModel(reg.view().running[0], reg.view().totals);
  assert.deepEqual([m.mode, m.left, m.elapsed], ["learning", "Learning how long this takes", "01:15"]);
  assert.equal(m.indeterminate, true, "no made-up progress");
});

test("overdue: 'Longer than usual +mm:ss' when no estimate is left; 'longer than usual' noted beside a live estimate", () => {
  const eta = new EtaBook({ storage: memStore() });
  for (let i = 0; i < 3; i++) eta.record("final@any", 120_000);
  const c = clockAt();
  const reg = registry(eta, c);
  reg.note("p", { name: "Final · shot 1", kind: "final" });
  reg.onEvent("execution_start", { prompt_id: "p" });
  c.t += 130_500;
  const m = countdownModel(reg.view().running[0], reg.view().totals);
  assert.deepEqual([m.mode, m.leftLabel, m.left, m.leftNote, m.elapsed], ["overdue", "Longer than usual", "+00:10", "usually 02:00", "02:10"]);
  // The estimator still has an estimate past its prediction: the time left, and the lateness beside it.
  const late = countdownModel({ id: "y", name: "Draft", elapsedMs: 200_000, predMs: 170_000, remainingMs: 20_000, estPm: 4000, estSure: "about", estRuns: 5 });
  assert.equal(late.mode, "late");
  assert.equal(late.left, "00:20");
  assert.equal(late.leftNote, "about ±0:04 · longer than usual +00:30");
});

test("the estimator's words: a rough first guess with no runs here, a ± range from a couple of runs", () => {
  const g = countdownModel({ id: "a", name: "Draft · shot 3", elapsedMs: 40_000, predMs: 126_000, remainingMs: 86_000, estPm: 43_000, estSure: "rough", estRuns: 0 });
  assert.deepEqual([g.mode, g.left, g.leftNote], ["guess", "01:26", "rough first guess · ±0:43"]);
  const r = countdownModel({ id: "b", name: "Final", elapsedMs: 10_000, predMs: 300_000, remainingMs: 290_000, estPm: 70_000, estSure: "range", estRuns: 2 });
  assert.equal(r.leftNote, "±1:10 · from 2 runs");
});

test("queue line: 'N more after this · all done in about m:ss'; progress prefers ComfyUI's per-node progress", () => {
  assert.equal(afterLine({ queued: 0 }), null);
  assert.equal(afterLine({ queued: 1 }), "1 more after this");
  assert.equal(afterLine({ queued: 2, etaMs: 450_000 }), "2 more after this · all done in about 7:30");
  assert.equal(afterLine({ queued: 3, etaMs: 600_000, etaPartial: true }), "3 more after this · all done in at least 10:00");
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
    { id: "a", state: "done", big: "Done", line: "Done: Draft of shot 3 (2:41)", took: "2:41", reason: null });
  const f = finishModel({ id: "b", name: "Final · shot 1", state: "failed", endedAt: 1, elapsedMs: 5000, error: "Ran out of GPU memory." });
  assert.deepEqual([f.state, f.big, f.line, f.reason], ["failed", "Failed", "Failed: Final of shot 1 (0:05)", "Ran out of GPU memory."]);
  assert.equal(finishModel({ id: "c", name: "x", state: "cancelled", endedAt: 1 }).state, "stopped");
  assert.equal(finishModel({ id: "d", state: "running" }), null);
});

test("preference persistence guard: blocked or broken storage gives defaults and never throws; a choice round-trips", () => {
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  assert.deepEqual(loadCountdownPrefs(throwing), { size: "big", collapsed: false });
  assert.equal(saveCountdownPrefs({ size: "small" }, throwing), false, "a blocked save is quiet");
  const junk = memStore(); junk.setItem(COUNTDOWN_KEY, "{not json");
  assert.deepEqual(loadCountdownPrefs(junk), { size: "big", collapsed: false });
  assert.deepEqual(normalizeCountdownPrefs({ size: "huge", collapsed: "yes" }), { size: "big", collapsed: true });
  assert.deepEqual(loadCountdownPrefs(null), { size: "big", collapsed: false }, "no storage at all");
  const st = memStore();
  assert.equal(saveCountdownPrefs({ size: "small", collapsed: true }, st), true);
  assert.deepEqual(loadCountdownPrefs(st), { size: "small", collapsed: true });
});

test("the band is in the page flow (never over the stage) and shows in every App mode; phone width stacks it", () => {
  assert.doesNotMatch(COUNTDOWN_CSS, /\.ss-cd\s*\{[^}]*position:\s*(absolute|fixed)/, "the band never floats over the stage or the shot monitor");
  // The modes hide `.ss-stage.ss-<mode>mode > :not(...)` with (0,9,0) at most: the band's show rule must outrank them.
  const show = /(\.ss-stage > (?:\.ss-cd)+:not\(\[hidden\]\)) \{ display:flex !important; \}/.exec(COUNTDOWN_CSS);
  assert.ok(show, "a show rule that outranks the mode hiders");
  assert.ok((show[1].match(/\.ss-|\[hidden\]/g) || []).length >= 10);
  const app = readFileSync(fileURLToPath(new URL("../../web/soundstage.js", import.meta.url)), "utf8");
  const hiders = app.match(/\.ss-stage\.ss-\w+mode > (:not\([^)]*\))+/g) || [];
  assert.ok(hiders.length >= 5);
  for (const hdr of hiders) assert.ok((hdr.match(/\.ss-/g) || []).length < 10, `${hdr} would outrank the band`);
  assert.match(COUNTDOWN_CSS, /@media \(max-width: 600px\)[\s\S]*\.ss-cd-job \{ flex:1 0 100%; \}/);
});

// ---- Fake DOM for the band.
function fakeDocument() {
  const writes = { n: 0 };
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ""; this._text = ""; this._hidden = false; this.handlers = {}; this.parentNode = null;
      this.dataset = new Proxy({}, { set(o, k, v) { if (o[k] !== v) writes.n++; o[k] = v; return true; } });
      this.style = new Proxy({}, { set(o, k, v) { writes.n++; o[k] = v; return true; } }); }
    append(...c) { for (const x of c) { this.children.push(x); x.parentNode = this; } }
    insertBefore(x, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(x); else this.children.splice(i, 0, x); x.parentNode = this; }
    get firstChild() { return this.children[0] || null; }
    contains() { return false; }
    setAttribute(k, v) { writes.n++; this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.handlers[t] ||= []).push(f); }
    removeEventListener() {}
    fire(t, e = {}) { for (const f of this.handlers[t] || []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e }); }
    remove() {}
    get hidden() { return this._hidden; } set hidden(v) { writes.n++; this._hidden = !!v; }
    set textContent(v) { writes.n++; this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (c.hidden ? "" : c.textContent)).join("|"); }
    byClass(cls) { const out = []; const walk = (e) => { for (const c of e.children) { if (String(c.className).split(" ").includes(cls)) out.push(c); walk(c); } }; walk(this); return out; }
  }
  return { doc: { createElement: (t) => new El(t) }, El, writes };
}

function withDom(fn) {
  const { doc, El, writes } = fakeDocument();
  const had = globalThis.document;
  globalThis.document = doc;
  const si = globalThis.setInterval, live = new Set();
  globalThis.setInterval = () => { const id = si(() => {}, 1e9); live.add(id); return id; };
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

test("the band: both clocks while a job runs, Stop uses the stop path, Done for a few seconds then hides; Failed with the reason link; collapse to a pill", () => withDom(({ intervals }) => {
  const eta = new EtaBook({ storage: memStore() });
  for (let i = 0; i < 3; i++) eta.record("draft@any", 180_000);
  const c = clockAt();
  const reg = registry(eta, c);
  const t = timers();
  const stops = [], whys = [];
  const store = memStore();
  const cd = createCountdown({ storage: store, setT: t.setT, clearT: t.clearT, onStop: (r) => stops.push(r.id), onWhy: () => whys.push(1),
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
  assert.match(txt(), /Elapsed\|00:19/, "how long it has run");
  assert.match(txt(), /Time left\|02:41/, "how much longer");
  assert.match(txt(), /1 more after this · all done in about 5:41/);
  cd.el.byClass("ss-cd-stop")[0].fire("click");
  assert.deepEqual(stops, ["p"]);
  assert.match(txt(), /Stopping…/);
  // collapse to a pill (saved per viewer), and back
  cd.el.byClass("ss-cd-fold")[0].fire("click");
  assert.equal(cd.el.dataset.size, "pill");
  assert.match(cd.el.byClass("ss-cd-pill")[0].textContent, /Draft · shot 3 · 00:19 · 02:41 left/);
  assert.deepEqual(JSON.parse(store.getItem(COUNTDOWN_KEY)), { size: "big", collapsed: true });
  cd.el.byClass("ss-cd-pill")[0].fire("click");
  assert.equal(cd.el.dataset.size, "big");
  // finishes: the Done state, one one-shot hide timer, then hidden
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
  assert.equal(intervals.size, 0, "the band never starts an interval");
  cd.dispose();
}));

test("no interval when idle: the App's band (bigTimer) above the top bar, no clock and no writes at idle, the Activity's one clock while a job runs", async () => {
  const { doc, El, writes } = fakeDocument();
  doc.getElementById = () => null; doc.head = new El("head"); doc.hidden = false; doc.addEventListener = () => {}; doc.removeEventListener = () => {};
  const g = globalThis, had = g.document;
  g.document = doc;
  const si = g.setInterval, ci = g.clearInterval, live = new Map(); let id = 0;
  g.setInterval = (f, ms) => { live.set(++id, ms); return id; };
  g.clearInterval = (i) => live.delete(i);
  try {
    const { mountActivity } = await import("../../web/ui/activity.mjs");
    const api = { clientId: "me", addEventListener() {}, removeEventListener() {}, fetchApi: async () => ({ ok: false, status: 500, json: async () => ({}) }) };
    const app = new El("div"); const row = new El("div"); app.append(row);
    const win = { addEventListener() {}, removeEventListener() {}, document: doc, matchMedia: () => ({ matches: false }) };
    const pill = mountActivity({ api, row, win, bigTimer: true });
    try {
      assert.ok(pill.countdown, "the countdown band mounts");
      assert.equal(app.children.indexOf(pill.countdown.el), 0, "first in the App, just above the top bar");
      assert.equal(app.children[1], row);
      assert.equal(app.byClass("ss-jobtimer").length, 0, "no second, thin timer strip");
      assert.equal(live.size, 0, "no interval at idle");
      const w0 = writes.n;
      for (let i = 0; i < 5; i++) pill.draw();
      assert.equal(writes.n, w0, "idle draws write nothing (the band included)");
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

test("the App mounts the band at the top", () => {
  const src = readFileSync(fileURLToPath(new URL("../../web/soundstage.js", import.meta.url)), "utf8");
  assert.match(src, /mountActivity\(\{ api, row: tabs, before: guideBtn, theme: el, bigTimer: true \}\)/);
});
