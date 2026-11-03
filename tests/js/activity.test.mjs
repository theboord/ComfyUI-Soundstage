// node --test tests/js/activity.test.mjs
// The Activity pill and panel (web/ui/activity.mjs): the job model, the ETA book, the registry built from ComfyUI's
// websocket events plus the light queue summary, and the panel rendered from mock data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ActivityRegistry, EtaBook, etaKey, kindOf, plainError, pillText, renderPanel, cancelJob, dur } from "../../web/ui/activity.mjs";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };
const clockAt = (t0 = 1_000_000) => { const c = { t: t0 }; c.now = () => c.t; return c; };

test("kinds: plain names from the App's names and the server's labels", () => {
  assert.equal(kindOf("Final · Chase cam"), "final");
  assert.equal(kindOf("Hollywood render · shot 1G"), "hollywood");
  assert.equal(kindOf("Draft"), "draft");
  assert.equal(kindOf("Frame"), "frame");
  assert.equal(kindOf("Voice conversion · Jane"), "voice");
  assert.equal(kindOf("Video → 3D · tracking"), "video3d");
  assert.equal(kindOf("Model call"), "model");
  assert.equal(kindOf("SaveImage"), "other");
  assert.equal(etaKey("final", 1920, 1080), "final@fhd");
  assert.equal(etaKey("final", 3840, 2160), "final@uhd");
  assert.equal(etaKey("final"), "final@any");
});

test("ETA book: a rolling average per kind and resolution, kept in storage, with a kind-wide fallback", () => {
  const st = memStore();
  const b = new EtaBook({ storage: st });
  assert.equal(b.get("final@fhd"), null);
  b.record("final@fhd", 100_000);
  assert.equal(b.get("final@fhd"), 100_000);
  b.record("final@fhd", 200_000);
  assert.equal(b.get("final@fhd"), 130_000);           // 0.7 * 100 + 0.3 * 200
  assert.equal(b.get("final@hd"), 130_000);            // never measured at 720p: the kind's average
  const again = new EtaBook({ storage: st });          // a new page reads it back
  assert.equal(again.get("final@fhd"), 130_000);
  const broken = new EtaBook({ storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  broken.record("draft@hd", 5000);                      // blocked storage: this page only, no throw
  assert.equal(broken.get("draft@hd"), 5000);
});

test("registry from events: start, steps, result, success; the duration feeds the ETA book", () => {
  const c = clockAt();
  const eta = new EtaBook({ storage: memStore() });
  const r = new ActivityRegistry({ clientId: "me", eta, now: c.now });
  r.note("p1", { name: "Hollywood render · shot 1G", trigger: "Run", width: 1920, height: 1080 });
  r.onEvent("execution_start", { prompt_id: "p1" });
  c.t += 30_000;
  r.onEvent("progress", { prompt_id: "p1", value: 6, max: 24, node: "12" });
  let v = r.view();
  assert.equal(v.running.length, 1);
  assert.equal(v.running[0].name, "Hollywood render · shot 1G · step 6/24");
  assert.equal(v.running[0].elapsedMs, 30_000);
  assert.equal(v.running[0].remainingMs, 90_000);       // no history yet: the sampler's own rate
  assert.equal(v.running[0].pct, 25);
  assert.equal(v.running[0].own, true);
  r.onEvent("executed", { prompt_id: "p1", output: { videos: [{ filename: "ss_1G.mp4", subfolder: "soundstage", type: "output" }] } });
  c.t += 90_000;
  r.onEvent("execution_success", { prompt_id: "p1" });
  v = r.view();
  assert.equal(v.running.length, 0);
  assert.equal(v.finished[0].state, "done");
  assert.equal(v.finished[0].elapsedMs, 120_000);
  assert.equal(v.finished[0].outputs[0].filename, "ss_1G.mp4");
  assert.equal(eta.get("hollywood@fhd"), 120_000);
});

test("registry: errors in plain words, interrupts are Cancelled", () => {
  const r = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  r.onEvent("execution_start", { prompt_id: "a" });
  r.onEvent("execution_error", { prompt_id: "a", exception_message: "CUDA error: out of memory\nTraceback...", node_type: "KSampler" });
  r.onEvent("execution_start", { prompt_id: "b" });
  r.onEvent("execution_interrupted", { prompt_id: "b" });
  const v = r.view();
  const a = v.finished.find((x) => x.id === "a"), b = v.finished.find((x) => x.id === "b");
  assert.equal(a.state, "failed");
  assert.match(a.error, /Ran out of GPU memory/);
  assert.equal(b.state, "cancelled");
  assert.equal(plainError({ exception_message: "weird thing", node_type: "X" }), "Failed (in X): weird thing");
});

test("summary: every user's jobs in order, own vs read-only, estimated starts from measured history", () => {
  const c = clockAt();
  const eta = new EtaBook({ storage: memStore() });
  eta.record("final@any", 600_000);
  eta.record("draft@any", 120_000);
  const r = new ActivityRegistry({ clientId: "me", eta, now: c.now });
  r.applySummary({ running: 1, pending: 2, items: [
    { prompt_id: "r1", state: "running", position: 0, client_id: "other", label: "Final · Chase cam" },
    { prompt_id: "q1", state: "pending", position: 1, client_id: "me", label: "Draft · 1G" },
    { prompt_id: "q2", state: "pending", position: 2, client_id: "other", label: "Final · Wide" },
  ] });
  c.t += 60_000;
  const v = r.view();
  assert.equal(v.running[0].own, false);
  assert.equal(v.running[0].remainingMs, 540_000);
  assert.deepEqual(v.queued.map((q) => q.id), ["q1", "q2"]);
  assert.equal(v.queued[0].own, true);
  assert.equal(v.queued[0].startsInMs, 540_000);
  assert.equal(v.queued[1].startsInMs, 660_000);
  assert.deepEqual(v.totals, { running: 1, queued: 2, etaMs: 1_260_000, etaPartial: false });
  assert.equal(pillText(v.totals), "1 running · 2 queued · ~21 min");
  // the next summary no longer lists another user's finished job: it leaves the panel
  r.applySummary({ running: 1, pending: 1, items: [
    { prompt_id: "q1", state: "running", position: 0, client_id: "me", label: "Draft · 1G" },
    { prompt_id: "q2", state: "pending", position: 1, client_id: "other", label: "Final · Wide" },
  ] });
  const v2 = r.view();
  assert.deepEqual(v2.running.map((x) => x.id), ["q1"]);
  assert.ok(!r.jobs.has("r1"));
});

test("summary: a truncated list never prunes, and unknown ETAs say 'at least'", () => {
  const r = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  r.applySummary({ running: 1, pending: 5, items: [{ prompt_id: "x", state: "running", position: 0, client_id: "me", label: "Frame" }] });
  r.applySummary({ running: 1, pending: 5, items: [] });
  assert.ok(r.jobs.has("x"));
  const t = r.view().totals;
  assert.equal(t.queued, 5);
  assert.equal(t.etaPartial, true);
  assert.equal(pillText({ running: 0, queued: 0 }), "Idle");
  assert.equal(dur(59_000), "59 s");
  assert.equal(dur(3_600_000 + 5 * 60_000), "1 h 5 min");
});

test("a late summary never revives a finished job", () => {
  const r = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  r.onEvent("execution_start", { prompt_id: "z" });
  r.onEvent("execution_success", { prompt_id: "z" });
  r.applySummary({ running: 1, pending: 0, items: [{ prompt_id: "z", state: "running", position: 0, client_id: "me" }] });
  assert.equal(r.view().running.length, 0);
});

// ---- A small DOM, enough for the panel.
function fakeDocument() {
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.className = ""; this._text = ""; this.listeners = {}; }
    append(...c) { for (const x of c) this.children.push(x); }
    prepend(x) { this.children.unshift(x); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    click() { for (const f of this.listeners.click || []) f({ stopPropagation() {} }); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    get childNodes() { return this.children; }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
    byClass(cls) { return this.all((c) => c.className.split(" ").includes(cls)); }
  }
  return { createElement: (t) => new El(t) };
}

test("panel renders mock data: running with progress, queued with starts, finished with links and errors, Cancel only on own jobs", () => {
  globalThis.document = fakeDocument();
  try {
    const cancelled = [];
    const v = {
      totals: { running: 1, queued: 2, etaMs: 360_000, etaPartial: false },
      running: [{ id: "r", name: "Hollywood render · shot 1G · step 18/24", state: "running", own: true, pct: 75, elapsedMs: 95_000, remainingMs: 30_000, outputs: [], preview: "blob:x" }],
      queued: [
        { id: "q1", name: "Frame · shot 2A", state: "queued", own: true, position: 1, trigger: "Run", startsInMs: 30_000, startsPartial: false, outputs: [] },
        { id: "q2", name: "Final · Wide", state: "queued", own: false, position: 2, trigger: "", startsInMs: null, outputs: [] },
      ],
      finished: [
        { id: "d", name: "Draft · 1G", state: "done", own: true, elapsedMs: 120_000, endedAt: 2, outputs: [{ filename: "a.mp4", subfolder: "", type: "output" }] },
        { id: "f", name: "Voice conversion", state: "failed", own: true, elapsedMs: 4000, endedAt: 1, error: "Ran out of GPU memory.", outputs: [] },
      ],
    };
    const root = renderPanel(v, { onCancel: (row) => cancelled.push(row.id) });
    const text = root.textContent;
    assert.match(text, /Activity · 1 running · 2 queued · ~6 min/);
    assert.match(text, /Hollywood render · shot 1G · step 18\/24/);
    assert.match(text, /75% · 1:35 so far · about 30 s left/);
    assert.match(text, /#1 in line · from Run · starts in about 30 s/);
    assert.match(text, /#2 in line · start time not known yet/);
    assert.match(text, /another user/);
    assert.match(text, /Done · took 2 min/);
    assert.match(text, /Ran out of GPU memory/);
    const link = root.byClass("ss-act-link")[0];
    assert.equal(link.href, "/view?filename=a.mp4&subfolder=&type=output");
    assert.equal(root.byClass("ss-act-fill")[0].style.width, "75%");
    assert.equal(root.byClass("ss-act-thumb")[0].src, "blob:x");
    const btns = root.byClass("ss-act-cancel");
    assert.equal(btns.length, 2, "Cancel on the own running and own queued job only, never another user's");
    btns.forEach((b) => b.click());
    assert.deepEqual(cancelled, ["r", "q1"]);
  } finally { delete globalThis.document; }
});

test("cancel: own running -> /interrupt for that prompt, own queued -> /queue delete, never another user's", async () => {
  const calls = [];
  const api = { fetchApi: async (path, init) => { calls.push([path, JSON.parse(init.body)]); return { status: 200 }; } };
  assert.equal(await cancelJob(api, { id: "r", own: true, state: "running" }), true);
  assert.equal(await cancelJob(api, { id: "q", own: true, state: "queued" }), true);
  assert.equal(await cancelJob(api, { id: "o", own: false, state: "queued" }), false);
  assert.deepEqual(calls, [["/interrupt", { prompt_id: "r" }], ["/queue", { delete: ["q"] }]]);
});

test("the App: the pill sits in the top row outside the ⋯ fold order, and nobody polls the full queue", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  assert.match(src, /mountActivity\(\{ api, row: tabs, before: guideBtn/);
  const fold = src.match(/order: \(\) => \[\.\.\.\[([^\]]*)\]/)[1];
  assert.ok(!/actbtn/.test(fold), "the Activity pill never folds into ⋯");
  const mod = readFileSync(new URL("../../web/ui/activity.mjs", import.meta.url), "utf8");
  assert.ok(!/fetchApi\(["'`]\/(queue|history)["'`?]\s*\)/.test(mod), "no GET /queue or /history");
  assert.ok(!/innerHTML/.test(mod), "labels from other users never go through innerHTML");
});
