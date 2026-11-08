// node --test tests/js/activity.test.mjs
// The Activity pill and panel (web/ui/activity.mjs): the job model, the ETA book, the registry built from ComfyUI's
// websocket events plus the light queue summary, the node -> stage names for the running job, and the panel rendered
// from mock data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ActivityRegistry, EtaBook, etaKey, kindOf, plainError, pillText, renderPanel, cancelJob, dur, stageOf, customTitle, graphOf,
  watchQueueing, syncOnce, historyOf } from "../../web/ui/activity.mjs";

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
  assert.equal(kindOf("Frame interpolation · RIFE"), "interp", "not a Frame");
  assert.equal(kindOf("Soundtrack mix"), "other", "not Video → 3D");
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
  assert.equal(v.running[0].name, "Hollywood render · shot 1G");
  assert.deepEqual([v.running[0].step, v.running[0].steps], [6, 24]);
  assert.equal(v.running[0].elapsedMs, 30_000);
  assert.equal(v.running[0].remainingMs, 90_000);       // no history yet: the sampler's own rate, a lower bound
  assert.equal(v.running[0].remainingAtLeast, true);
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
  return { createElement: (t) => new El(t), createTextNode: (t) => { const e = new El("#text"); e.textContent = t; return e; } };
}

test("panel renders mock data: running with progress, queued with starts, finished with links and errors, Cancel only on own jobs", () => {
  globalThis.document = fakeDocument();
  try {
    const cancelled = [];
    const v = {
      totals: { running: 1, queued: 2, etaMs: 360_000, etaPartial: false },
      running: [{ id: "r", name: "Hollywood render · shot 1G", step: 18, steps: 24, state: "running", own: true, pct: 75, elapsedMs: 95_000, remainingMs: 30_000, outputs: [], preview: "blob:x" }],
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
    assert.match(text, /Hollywood render · shot 1G/);
    assert.match(text, /step 18\/24/);
    assert.match(text, /75% · 1:35 so far · about 30 s left/);
    assert.match(text, /#1 in line · from Run · starts in about 30 s/);
    assert.match(text, /#2 in line · start time not known yet/);
    assert.match(text, /another session/);
    assert.match(text, /Done · took 2 min/);
    assert.match(text, /Ran out of GPU memory/);
    const link = root.byClass("ss-act-link")[0];
    assert.equal(link.href, "/view?filename=a.mp4&subfolder=&type=output");
    assert.equal(root.byClass("ss-act-fill")[0].style.width, "75%");
    assert.equal(root.byClass("ss-act-thumb")[0].src, "blob:x");
    const btns = root.byClass("ss-act-cancel");
    assert.equal(btns.length, 2, "Cancel on the own running and own queued job only, never another session's");
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

// ---- Node-level progress (Mike 2026-11-02: "oh, it's going through the KSampler now, or it's doing the depth map now").

// A two-stage LTX graph like the App's Final: loaders, Gemma, a depth pass, sampler, x2 latent upsampler, sampler, decode, save.
const LTX = {
  1: { class_type: "UNETLoader", inputs: { unet_name: "ltx-2.3-22b.safetensors" }, _meta: { title: "Load Diffusion Model" } },
  2: { class_type: "GemmaAPITextEncode", inputs: { text: "a car" }, _meta: { title: "GemmaAPITextEncode" } },
  3: { class_type: "DA3Inference", inputs: {}, _meta: { title: "DA3Inference" } },
  4: { class_type: "DWPreprocessor", inputs: {}, _meta: { title: "DWPreprocessor" } },
  12: { class_type: "KSampler", inputs: { steps: 12, model: ["1", 0] }, _meta: { title: "KSampler" } },
  13: { class_type: "LatentUpscaleModelLoader", inputs: { model_name: "ltx-2-spatial-upscaler-x2-1.0.safetensors" }, _meta: { title: "Load Latent Upscale Model" } },
  14: { class_type: "LTXVLatentUpsampler", inputs: { samples: ["12", 0], upscale_model: ["13", 0] }, _meta: { title: "LTXVLatentUpsampler" } },
  15: { class_type: "KSampler", inputs: { steps: 18, samples: ["14", 0] }, _meta: { title: "KSampler" } },
  16: { class_type: "VAEDecodeTiled", inputs: { samples: ["15", 0] }, _meta: { title: "VAE Decode (Tiled)" } },
  17: { class_type: "SaveVideo", inputs: {}, _meta: { title: "Save Video" } },
  18: { class_type: "SoundstageMysteryNode", inputs: {}, _meta: { title: "SoundstageMysteryNode" } },
};
const defaults = { UNETLoader: "Load Diffusion Model", VAEDecodeTiled: "VAE Decode (Tiled)", SaveVideo: "Save Video", LatentUpscaleModelLoader: "Load Latent Upscale Model" };

function ltxJob(c, { eta = new EtaBook({ storage: memStore() }) } = {}) {
  const r = new ActivityRegistry({ clientId: "me", eta, now: c.now, defaultTitle: (ct) => defaults[ct] || null });
  r.note("p", { name: "Final · shot 1G", trigger: "Run" });
  r.graph("p", LTX);
  r.onEvent("execution_start", { prompt_id: "p" });
  return r;
}

test("stage names: the mapping table for common Soundstage graph nodes, with the class_type as the fallback", () => {
  const n = (ct) => stageOf(ct).name;
  assert.equal(n("KSampler"), "Sampling");
  assert.equal(n("SamplerCustomAdvanced"), "Sampling");
  assert.equal(stageOf("KSampler").role, "sampler");
  assert.equal(n("LTXVLatentUpsampler"), "Upscaling");
  assert.equal(stageOf("LTXVLatentUpsampler").role, "upscale");
  assert.equal(n("DA3Inference"), "Depth map");
  assert.equal(n("DepthAnythingV2Preprocessor"), "Depth map");
  assert.equal(n("DWPreprocessor"), "Pose (DWPose)");
  assert.equal(n("VAEDecodeTiled"), "Decoding video (VAE)");
  assert.equal(n("VAEDecode"), "Decoding (VAE)");
  assert.equal(n("GemmaAPITextEncode"), "Encoding prompt (Gemma)");
  assert.equal(n("TextGenerateLTX2Prompt"), "Encoding prompt (Gemma)");
  assert.equal(n("CLIPTextEncode"), "Encoding prompt");
  assert.equal(n("UNETLoader"), "Loading model");
  assert.equal(n("CheckpointLoaderSimple"), "Loading model");
  assert.equal(n("SaveVideo"), "Saving MP4");
  assert.equal(n("SAM3Segment"), "Masking (SAM 3)");
  assert.equal(n("SoundstageStage"), "3D stage (stage passes)");
  assert.equal(n("SoundstageMysteryNode"), "SoundstageMysteryNode");
  // A title counts only when someone set it: not the class_type, not the node's default display name.
  assert.equal(customTitle("KSampler", "KSampler"), null);
  assert.equal(customTitle("VAE Decode (Tiled)", "VAEDecodeTiled", "VAE Decode (Tiled)"), null);
  assert.equal(customTitle("K Sampler", "KSampler"), null);
  assert.equal(customTitle("Hero pass sampler", "KSampler"), "Hero pass sampler");
  const g = graphOf(LTX, { defaultTitle: (ct) => defaults[ct] || null });
  assert.equal(g.total, 11);
  assert.equal(g.multi, true);
  assert.equal(g.nodes[14].factor, 2, "the x2 comes from the upscale model it loads");
  assert.equal(g.nodes[1].title, null);
  assert.equal(graphOf(null), null);
});

test("events -> stages: bare node ids from `executing`, stage numbers across a two-stage render, the title wins", () => {
  const c = clockAt();
  const r = ltxJob(c);
  const stage = () => r.view().running[0].detail.stage;
  // The ComfyUI frontend's `executing` detail is the node id itself (not an object): it belongs to the running prompt.
  r.onEvent("executing", "1"); assert.equal(stage(), "Loading model");
  c.t += 2000;
  r.onEvent("executing", "2"); assert.equal(stage(), "Encoding prompt (Gemma)");
  r.onEvent("executing", "3"); assert.equal(stage(), "Depth map");
  r.onEvent("executing", "4"); assert.equal(stage(), "Pose (DWPose)");
  r.onEvent("executing", "12"); assert.equal(stage(), "Sampling: stage 1");
  r.onEvent("executing", "13"); assert.equal(stage(), "Loading model");
  r.onEvent("executing", "14"); assert.equal(stage(), "Upscaling ×2: stage 2");
  r.onEvent("executing", "15"); assert.equal(stage(), "Sampling: stage 2");
  r.onEvent("executing", "16"); assert.equal(stage(), "Decoding video (VAE)");
  r.onEvent("executing", { prompt_id: "p", node: "17" }); assert.equal(stage(), "Saving MP4");   // the try-it demo's shape
  r.onEvent("executing", "18"); assert.equal(stage(), "SoundstageMysteryNode");
  const d = r.view().running[0].detail;
  assert.equal(d.done, 10);
  assert.equal(d.total, 11);
  assert.equal(d.nodes[0].ms, 2000, "each node's own time");
  assert.equal(d.nodes.find((l) => l.id === "12").raw, "KSampler #12");
  // A node somebody titled shows its title.
  const r2 = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  r2.graph("t", { 5: { class_type: "KSampler", inputs: {}, _meta: { title: "Hero pass" } } });
  r2.onEvent("execution_start", { prompt_id: "t" });
  r2.onEvent("executing", "5");
  assert.equal(r2.view().running[0].detail.stage, "Hero pass");
  // `executing` null ends the job.
  r.onEvent("executing", null);
  assert.equal(r.view().finished[0].state, "done");
  // A one-sampler graph never says "stage 1".
  const r3 = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  r3.graph("k", { 1: { class_type: "KSampler", inputs: {} }, 2: { class_type: "VAEDecode", inputs: {} } });
  r3.onEvent("execution_start", { prompt_id: "k" });
  r3.onEvent("executing", "1");
  assert.equal(r3.view().running[0].detail.stage, "Sampling");
});

test("sampler steps: 12 / 18 with an inner bar, the pill leads with the stage, the step rate is a lower bound", () => {
  const c = clockAt();
  const r = ltxJob(c);
  r.onEvent("executing", "12");
  c.t += 24_000;
  r.onEvent("progress", { prompt_id: "p", node: "12", value: 8, max: 12 });
  let run = r.view().running[0];
  assert.deepEqual([run.detail.step, run.detail.steps, run.detail.stepPct], [8, 12, 67]);
  assert.equal(run.remainingMs, 12_000);              // 3 s a step, 4 steps left in this sampler
  assert.equal(run.remainingAtLeast, true);
  assert.equal(pillText(r.view().totals, run), "Sampling: stage 1 · 8/12 · ≥12 s");
  // The second sampler: 18 steps, the inner bar starts again; progress_state (newer ComfyUI) moves it too.
  r.onEvent("executing", "14");
  r.onEvent("progress_state", { prompt_id: "p", nodes: { 14: { state: "finished", node_id: "14", value: 1, max: 1 }, 15: { state: "running", node_id: "15", value: 12, max: 18 } } });
  run = r.view().running[0];
  assert.equal(run.detail.stage, "Sampling: stage 2");
  assert.deepEqual([run.detail.step, run.detail.steps], [12, 18]);
  assert.equal(run.detail.nodes.find((l) => l.id === "14").state, "done");
  globalThis.document = fakeDocument();
  try {
    const root = renderPanel(r.view(), {});
    assert.match(root.textContent, /Sampling: stage 2step 12\/18/);
    assert.equal(root.byClass("ss-act-stepbar")[0].children[0].style.width, "67%");
    assert.match(root.textContent, /node \d+ of 11/);
    assert.match(root.textContent, /Details · \d+ of 11 nodes/);
  } finally { delete globalThis.document; }
  // With a measured average the time left is the average, and the bar is time.
  const eta = new EtaBook({ storage: memStore() });
  eta.record("final@any", 100_000);
  const c2 = clockAt();
  const r2 = ltxJob(c2, { eta });
  r2.onEvent("executing", "12");
  c2.t += 40_000;
  r2.onEvent("progress", { prompt_id: "p", node: "12", value: 2, max: 12 });
  run = r2.view().running[0];
  assert.deepEqual([run.remainingMs, run.remainingAtLeast, run.pct], [60_000, false, 40]);
  c2.t += 80_000;                                     // past its average: no made-up number
  run = r2.view().running[0];
  assert.equal(run.remainingAtLeast, true);
});

test("cached nodes: counted as skipped, folded into one Details line; the done count includes them", () => {
  const c = clockAt();
  const r = ltxJob(c);
  r.onEvent("execution_cached", { prompt_id: "p", nodes: ["1", "2", "3", "13"], timestamp: 1 });
  r.onEvent("executing", "4");
  const run = r.view().running[0];
  assert.equal(run.detail.cached, 4);
  assert.equal(run.detail.done, 4);
  assert.equal(run.detail.stage, "Pose (DWPose)");
  globalThis.document = fakeDocument();
  try {
    const root = renderPanel(r.view(), {});
    assert.match(root.textContent, /4 cached/);
    assert.match(root.textContent, /↺ 4 cached, skipped: Loading model, Encoding prompt \(Gemma\), Depth map/);
    assert.match(root.textContent, /▶ Pose \(DWPose\)/);
    // Node types (pro): raw class_type and id instead of the friendly names.
    const raw = renderPanel(r.view(), { raw: true });
    assert.match(raw.textContent, /skipped: UNETLoader #1, GemmaAPITextEncode #2/);
    assert.match(raw.textContent, /▶ DWPreprocessor #4/);
  } finally { delete globalThis.document; }
});

test("errors name the failing node and the message; interrupts show as cancelled at the node", () => {
  const c = clockAt();
  const r = ltxJob(c);
  r.onEvent("executing", "12");
  r.onEvent("progress", { prompt_id: "p", node: "12", value: 3, max: 12 });
  r.onEvent("execution_error", { prompt_id: "p", node_id: "12", node_type: "KSampler", exception_message: "Allocation on device 0 would exceed allowed memory. (out of memory)\nTraceback", exception_type: "torch.OutOfMemoryError", executed: ["1"] });
  const f = r.view().finished[0];
  assert.equal(f.state, "failed");
  assert.deepEqual([f.detail.errorNode.name, f.detail.errorNode.raw], ["Sampling: stage 1", "KSampler #12"]);
  assert.match(f.detail.errorMsg, /^Allocation on device 0/);
  assert.equal(f.detail.nodes.find((l) => l.id === "12").state, "error");
  globalThis.document = fakeDocument();
  try {
    const t = renderPanel(r.view(), {}).textContent;
    assert.match(t, /Failed at Sampling: stage 1 \(KSampler #12\)/);
    assert.match(t, /Ran out of GPU memory/);
    assert.match(t, /Allocation on device 0 would exceed/);
  } finally { delete globalThis.document; }
  const r2 = ltxJob(clockAt());
  r2.onEvent("executing", "16");
  r2.onEvent("execution_interrupted", { prompt_id: "p", node_id: "16", node_type: "VAEDecodeTiled", executed: [] });
  const x = r2.view().finished[0];
  assert.equal(x.state, "cancelled");
  globalThis.document = fakeDocument();
  try { assert.match(renderPanel(r2.view(), {}).textContent, /Cancelled at Decoding video \(VAE\)/); } finally { delete globalThis.document; }
});

test("another session's job: shown from the summary, labelled, with no node detail and no Cancel", () => {
  const r = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  r.applySummary({ running: 1, pending: 0, items: [{ prompt_id: "o", state: "running", position: 0, client_id: "them", label: "Final · Wide" }] });
  r.onEvent("progress", { prompt_id: "o", node: "3", value: 1, max: 4 });   // a broadcast event still adds no detail
  const run = r.view().running[0];
  assert.equal(run.own, false);
  assert.equal(run.detail, null);
  assert.match(pillText(r.view().totals, run), /^1 running( · |$)/, "no stage words for another session's job");
  globalThis.document = fakeDocument();
  try {
    const root = renderPanel(r.view(), { onCancel: () => {} });
    assert.match(root.textContent, /another session/);
    assert.match(root.textContent, /Node detail shows in the session that queued it/);
    assert.equal(root.byClass("ss-act-cancel").length, 0);
    assert.equal(root.byClass("ss-act-det").length, 0);
  } finally { delete globalThis.document; }
});

test("a job of ours that leaves the queue unseen: status (queue_remaining 0) or the summary, then its own /history/{id}", async () => {
  const c = clockAt();
  const r = ltxJob(c);
  // The ComfyUI frontend's status detail is {exec_info: {queue_remaining}} (PR #28 read .status.exec_info: never fired).
  r.onEvent("status", { exec_info: { queue_remaining: 0 } });
  assert.deepEqual([...r.lost], ["p"]);
  const entry = { prompt: [1, "p", LTX, {}, []], outputs: { 17: { images: [{ filename: "final_1G.mp4", subfolder: "soundstage", type: "output" }] } },
    status: { status_str: "error", completed: false, messages: [["execution_start", { prompt_id: "p", timestamp: 1000 }],
      ["execution_cached", { prompt_id: "p", nodes: ["1", "2"], timestamp: 1001 }],
      ["execution_error", { prompt_id: "p", node_id: "3", node_type: "DA3Inference", exception_message: "weights missing", timestamp: 61_000 }]] } };
  const calls = [];
  const api = { fetchApi: async (path) => { calls.push(path); return path.startsWith("/history/") ? { status: 200, json: async () => ({ p: entry }) } : { status: 200, json: async () => ({ running: 0, pending: 0, items: [] }) }; } };
  await syncOnce(api, r);
  const f = r.view().finished[0];
  assert.equal(f.state, "failed");
  assert.equal(f.detail.errorNode.name, "Depth map");
  assert.equal(f.detail.cached, 2);
  assert.equal(f.elapsedMs, 60_000, "the server's own clock");
  // A queued job of ours that someone took off the queue: no history, never started -> cancelled.
  const r2 = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }), now: c.now });
  r2.note("q", { name: "Draft · 2A" });
  r2.applySummary({ running: 0, pending: 1, items: [{ prompt_id: "q", state: "pending", position: 1, client_id: "me" }] });
  c.t += 5000;
  r2.applySummary({ running: 0, pending: 0, items: [] }, { askedAt: c.t });
  assert.deepEqual(r2.takeLost(), ["q"]);
  r2.applyHistory("q", await historyOf({ fetchApi: async () => ({ status: 200, json: async () => ({}) }) }, "q"));
  assert.equal(r2.view().finished[0].state, "cancelled");
  // ...but a job queued while that summary was in flight is not taken for one that left.
  r2.note("n", { name: "Frame" });
  r2.applySummary({ running: 0, pending: 0, items: [] }, { askedAt: c.t - 1 });
  assert.equal(r2.takeLost().length, 0);
});

test("queue time: node names come from the POST /prompt body this page sends; QA's blocked answer is ignored", async () => {
  const reg = new ActivityRegistry({ clientId: "me", eta: new EtaBook({ storage: memStore() }) });
  let answer = { prompt_id: "abc", number: 3 };
  const resp = () => { const r = { status: 200, json: async () => answer }; r.clone = () => ({ json: async () => answer }); return r; };
  const api = { fetchApi: async () => resp() };
  assert.equal(watchQueueing(api, reg), true);
  assert.equal(watchQueueing(api, reg), false, "installed once");
  await api.fetchApi("/prompt", { method: "POST", body: JSON.stringify({ client_id: "me", prompt: LTX }) });
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(reg.graphs.get("abc").total, 11);
  assert.equal(reg.jobs.get("abc").own, true);
  answer = { prompt_id: "blocked" };
  await api.fetchApi("/prompt", { method: "POST", body: JSON.stringify({ prompt: LTX }) });
  await new Promise((res) => setTimeout(res, 0));
  assert.ok(!reg.graphs.has("blocked"));
  // GETs pass straight through.
  await api.fetchApi("/soundstage/queue_summary");
  assert.equal(reg.graphs.size, 1);
});

test("the Activity reads only /soundstage/queue_summary and /history/{id}: never the full /queue or /history", async () => {
  const c = clockAt();
  const r = ltxJob(c);
  r.note("q2", { name: "Draft" });
  r.applySummary({ running: 1, pending: 1, items: [{ prompt_id: "p", state: "running", position: 0, client_id: "me" }, { prompt_id: "q2", state: "pending", position: 1, client_id: "me" }] });
  const calls = [];
  const api = { fetchApi: async (path, init = {}) => {
    calls.push(`${init.method || "GET"} ${path}`);
    if (path === "/queue" || path === "/history" || /^\/history\?/.test(path)) throw new Error(`full ${path} fetched`);
    if (path.startsWith("/soundstage/queue_summary")) return { status: 200, json: async () => ({ running: 0, pending: 0, items: [] }) };
    return { status: 200, json: async () => ({}) };
  } };
  c.t += 1000;
  await syncOnce(api, r);
  assert.deepEqual(calls, ["GET /soundstage/queue_summary?limit=200", "GET /history/p", "GET /history/q2"]);
  const mod = readFileSync(new URL("../../web/ui/activity.mjs", import.meta.url), "utf8");
  const gets = [...mod.matchAll(/fetchApi\(\s*[`'"]([^`'"]*)[`'"]/g)].map((m) => m[1]);
  assert.deepEqual(gets.sort(), ["/history/${encodeURIComponent(pid)}", "/interrupt", "/queue"]);
  assert.match(mod, /fetchApi\("\/queue", \{ method: "POST"[^\n]*delete:/, "/queue is only ever a POST delete (Cancel on a queued job of ours)");
});
