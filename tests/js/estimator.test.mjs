// node --test tests/js/estimator.test.mjs
// The render-time estimator (web/ui/estimator.mjs): the job's shape from its queued graph, a prediction from this
// machine's history (steps x ms/step per stage, scaled by size, frames and batch; load; decode; overhead), cold vs warm
// model loads, live refinement from ComfyUI's progress, the seed's rough first guess, batch / queue totals through the
// Activity registry, and the per-machine book in storage (try/catch).
import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { jobShape, liveIds, unitsOf, Estimator, sureText, SEEDS, EST_KEY } from "../../web/ui/estimator.mjs";
import { ActivityRegistry, EtaBook } from "../../web/ui/activity.mjs";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };

// The App's two-stage LTX Draft at 1280x704, 121 frames: 8 steps, x2 upsample, 3 refine steps, tiled decode.
const draft = ({ w = 1280, h = 704, frames = 121, batch = 1, steps1 = 8, steps2 = 3 } = {}) => ({
  1: { class_type: "UNETLoader", inputs: { unet_name: "ltx-2.5-22b-distilled-int8.safetensors" } },
  2: { class_type: "CLIPTextEncode", inputs: { text: "a car" } },
  3: { class_type: "EmptyLTXVLatentVideo", inputs: { width: w, height: h, length: frames, batch_size: batch } },
  9: { class_type: "PrimitiveInt", inputs: { value: steps2 } },
  4: { class_type: "KSampler", inputs: { steps: steps1, model: ["1", 0], latent_image: ["3", 0] } },
  5: { class_type: "LTXVLatentUpsampler", inputs: { samples: ["4", 0] } },
  6: { class_type: "SamplerCustomAdvanced", inputs: { sigmas: ["8", 0], latent_image: ["5", 0] } },
  8: { class_type: "BasicScheduler", inputs: { steps: ["9", 0], model: ["1", 0] } },
  7: { class_type: "VAEDecodeTiled", inputs: { samples: ["6", 0] } },
  10: { class_type: "SaveVideo", inputs: { video: ["7", 0] } },
});

test("job shape: model, size, frames, batch and each stage's steps in run order (linked schedulers and primitives too)", () => {
  const s = jobShape(draft());
  assert.equal(s.model, "ltx-2.5-22b-distilled-int8");
  assert.deepEqual([s.width, s.height, s.frames, s.batch], [1280, 704, 121, 1]);
  assert.deepEqual(s.stages, [{ id: "4", steps: 8 }, { id: "6", steps: 3 }], "stage 1 before stage 2 (6 depends on 4)");
  assert.deepEqual(s.decodeIds, ["7"]);
  assert.deepEqual(s.loaderIds, ["1"]);
  assert.ok(Math.abs(unitsOf(s) - 1.28 * 0.704 * 121) < 1e-9);
  assert.equal(unitsOf(jobShape(draft({ batch: 4 }))), unitsOf(s) * 4, "four generations are four times the work");
  const manual = jobShape({ 1: { class_type: "SamplerCustom", inputs: { sigmas: ["2", 0] } }, 2: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.9, 0.7, 0.4, 0.0" } } });
  assert.deepEqual(manual.stages, [{ id: "1", steps: 4 }]);
  const adv = jobShape({ 1: { class_type: "KSamplerAdvanced", inputs: { steps: 20, start_at_step: 12, end_at_step: 20 } } });
  assert.equal(adv.stages[0].steps, 8, "KSamplerAdvanced runs end - start steps");
  assert.equal(jobShape(null), null);
});

// One measured Draft: 30 s cold load, 12 s a step in stage 1, 10 s a step in stage 2, 22 s decode, 15 s overhead.
const run = (cold = true) => ({ totalMs: (cold ? 30_000 : 2_000) + 96_000 + 30_000 + 22_000 + 15_000, loadMs: cold ? 30_000 : 2_000, cold,
  stages: [{ steps: 8, ms: 96_000 }, { steps: 3, ms: 30_000 }], decodeMs: 22_000 });

test("prediction from history: load + steps x ms/step per stage + decode + overhead, scaled by the job's size and steps", () => {
  const est = new Estimator({ storage: memStore(), machine: "RTX 5090" });
  const s = jobShape(draft());
  est.learn(s, "draft", run(true));
  est.learn(s, "draft", run(true));
  est.learn(s, "draft", run(true));
  est.lastModel = null;   // a fresh server: nothing loaded
  const p = est.predict(s, "draft");
  assert.equal(p.sure, "about");
  assert.equal(p.runs, 3);
  assert.equal(Math.round(p.ms), 30_000 + 96_000 + 30_000 + 22_000 + 15_000);
  assert.deepEqual(p.phases.stages.map((x) => [x.steps, Math.round(x.msPerStep)]), [[8, 12_000], [3, 10_000]]);
  // Twice the steps in stage 1: +8 x 12 s.
  const more = est.predict(jobShape(draft({ steps1: 16 })), "draft", { warm: false });
  assert.equal(Math.round(more.ms - p.ms), 96_000);
  // Twice the frames: sampling and decode double, load and overhead don't.
  const longer = est.predict(jobShape(draft({ frames: 242 })), "draft", { warm: false });
  assert.equal(Math.round(longer.ms - p.ms), 96_000 + 30_000 + 22_000);
  assert.match(sureText(p), /^about ±\d:\d\d$/);
  // The book is per machine: another GPU has no history (its seed instead).
  assert.equal(new Estimator({ storage: est.storage, machine: "RTX 4080" }).predict(s, "draft").sure, "rough");
});

test("cold vs warm: the first run loads the model, the next one (same model, still loaded) doesn't", () => {
  const est = new Estimator({ storage: memStore(), machine: "m" });
  const s = jobShape(draft());
  est.learn(s, "draft", run(true));     // cold: the loaders ran (30 s)
  est.learn(s, "draft", run(false));    // warm: ComfyUI had them cached (2 s)
  const warm = est.predict(s, "draft");           // lastModel is this model now: warm
  assert.equal(warm.warm, true);
  const cold = est.predict(s, "draft", { warm: false });
  assert.equal(cold.warm, false);
  assert.equal(Math.round(cold.phases.load), 30_000);
  assert.equal(Math.round(warm.phases.load), 2_000);
  assert.equal(Math.round(cold.ms - warm.ms), 28_000);
  // A different model since: cold again.
  est.lastModel = "flux-3-klein";
  assert.equal(est.predict(s, "draft").warm, false);
});

test("no history: a rough first guess from the docs' numbers, scaled to the job's size; ±50 %", () => {
  const est = new Estimator({ storage: memStore(), machine: "m" });
  const s = jobShape(draft({ w: 1984, h: 1088 }));   // the docs' Draft: 1984x1088, 121 frames
  const p = est.predict(s, "draft");
  assert.equal(p.sure, "rough");
  assert.equal(Math.round(p.ms / 1000), Math.round(SEEDS.draft.ms * (unitsOf(s) / SEEDS.draft.u) / 1000));
  assert.equal(Math.round(p.pm), Math.round(p.ms / 2));
  assert.match(sureText(p), /^rough first guess · ±\d:\d\d$/);
  assert.equal(est.predict(s, "other"), null, "no seed for an unknown kind: nothing made up");
});

test("live refinement: this run's measured ms per step replaces the book's, and the estimate converges to zero", () => {
  const est = new Estimator({ storage: memStore(), machine: "m" });
  const s = jobShape(draft());
  for (let i = 0; i < 3; i++) est.learn(s, "draft", run(false));
  const p = est.predict(s, "draft");
  // Stage 1, step 2 of 8, this run doing 24 s a step (twice as slow as the book): the rest of stage 1 at 24 s, and the
  // later stages scaled by the same speed.
  const slow = est.live(p, { elapsedMs: 50_000, phase: "sample", stage: 0, step: 2, steps: 8, liveStepMs: 24_000, phaseElapsedMs: 48_000, stagesDone: 0 });
  assert.equal(slow.ms, Math.round(6 * 24_000 + 30_000 * 2 + 22_000 * 2 + 15_000 * 0.4));
  const fast = est.live(p, { elapsedMs: 30_000, phase: "sample", stage: 0, step: 2, steps: 8, liveStepMs: 6_000, phaseElapsedMs: 24_000, stagesDone: 0 });
  assert.ok(fast.ms < slow.ms / 2, "a faster run says so");
  // Further on, less is left; the ± shrinks with it.
  const s2 = est.live(p, { elapsedMs: 130_000, phase: "sample", stage: 1, step: 1, steps: 3, liveStepMs: 10_000, phaseElapsedMs: 10_000, stagesDone: 1 });
  const dec = est.live(p, { elapsedMs: 160_000, phase: "decode", stage: null, phaseElapsedMs: 20_000, stagesDone: 2 });
  const tail = est.live(p, { elapsedMs: 180_000, phase: "other", stage: null, phaseElapsedMs: 30_000, stagesDone: 2 });
  assert.ok(s2.ms > dec.ms && dec.ms >= tail.ms, `${s2.ms} > ${dec.ms} >= ${tail.ms}`);
  assert.equal(tail.ms, 1000, "never below a second while it still runs");
  assert.ok(slow.pm > s2.pm && s2.pm > dec.pm);
  // Loading: the book's load still to come, then everything after it.
  const loading = est.live(p, { elapsedMs: 1000, phase: "load", stage: null, phaseElapsedMs: 1000, stagesDone: 0 });
  assert.ok(loading.ms < p.ms && loading.ms > p.ms * 0.9, `${loading.ms} vs ${p.ms}`);
});

test("batch and queue through the registry: time until THIS job is done and until ALL queued jobs are done", () => {
  const c = { t: 1_000_000 }; const now = () => c.t;
  const est = new Estimator({ storage: memStore(), machine: "m" });
  const reg = new ActivityRegistry({ eta: new EtaBook({ storage: memStore() }), est, now, clientId: "me" });
  const G = draft();
  // Teach it through real events: a finished Draft whose nodes took the measured times.
  reg.note("a", { name: "Draft · shot 1", kind: "draft" });
  reg.graph("a", G);
  reg.onEvent("execution_start", { prompt_id: "a" });
  const step = (node, ms) => { reg.onEvent("executing", { prompt_id: "a", node }); c.t += ms; };
  step("1", 30_000); step("2", 5_000); step("3", 0); step("4", 96_000); step("5", 5_000); step("6", 30_000); step("7", 22_000); step("10", 5_000);
  reg.onEvent("execution_success", { prompt_id: "a" });
  const book = Object.values(est.book).find((e) => e.step);
  assert.ok(book, "learned from the run's node timings");
  assert.equal(Math.round(book.loadCold), 30_000, "the loader ran: a cold load");
  assert.deepEqual(book.steps, [8, 3]);
  // Now three queued: this one running, a 4-variation batch after it, then one more.
  reg.note("b", { name: "Draft · shot 2", kind: "draft" }); reg.graph("b", G);
  reg.note("q", { name: "Draft · shot 3 · 4 takes", kind: "draft" }); reg.graph("q", draft({ batch: 4 }));
  reg.note("r", { name: "Draft · shot 4", kind: "draft" }); reg.graph("r", G);
  reg.onEvent("execution_start", { prompt_id: "b" });
  reg.applySummary({ running: 1, pending: 2, items: [{ prompt_id: "b", state: "running", position: 0, client_id: "me" },
    { prompt_id: "q", state: "pending", position: 1, client_id: "me" }, { prompt_id: "r", state: "pending", position: 2, client_id: "me" }] });
  const v = reg.view();
  const [b] = v.running, [q, r] = v.queued;
  assert.equal(b.estSure, "range");
  assert.ok(Math.abs(b.predMs - (2_000 + 96_000 + 30_000 + 22_000 + 15_000)) < 30_000, "warm now: the model is loaded");
  assert.ok(q.remainingMs > 3 * r.remainingMs, "the 4-take batch is about four times the sampling and decode");
  assert.equal(v.totals.etaMs, b.remainingMs + q.remainingMs + r.remainingMs, "all done = this + everything queued");
  assert.equal(r.startsInMs, b.remainingMs + q.remainingMs);
});

test("the book in storage: per machine, survives a reload, quiet when storage is blocked or broken", () => {
  const st = memStore();
  const a = new Estimator({ storage: st, machine: "RTX 5090" });
  a.learn(jobShape(draft()), "draft", run(true));
  assert.match(Object.keys(JSON.parse(st.getItem(EST_KEY))).join(), /RTX 5090\|ltx-2\.5-22b-distilled-int8\|draft\|hd/);
  const b = new Estimator({ storage: st, machine: "RTX 5090" });
  assert.equal(b.predict(jobShape(draft()), "draft").sure, "range", "one run remembered after a reload");
  const throwing = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  const c = new Estimator({ storage: throwing });
  assert.doesNotThrow(() => c.learn(jobShape(draft()), "draft", run(true)));
  const junk = memStore(); junk.setItem(EST_KEY, "{oops");
  assert.deepEqual(new Estimator({ storage: junk }).book, {});
});

// ---- 2026-11-10: the band said "TIME LEFT 33:06" for Finals that took 8-12 min on an L40. The App queues ONE graph for
// every rung (Look still, Draft, Final, Layers): the Krea still's KSampler (switched off: the frame is Klein's) and the
// SoundstageGenerateVideo (switched off) were counted as stages of the Final, with the last stage's rate and 12 + 8
// steps, and the frame count (linked to the 3D Stage) was unknown, so the job looked 120x smaller than it is.
const APP_FINAL = JSON.parse(readFileSync(new URL("./fixtures/app_final_graph.json", import.meta.url), "utf8"));

test("the App's Final: only what runs counts (gates below their rung, switched-off branches, a disabled When are out)", () => {
  const s = jobShape(APP_FINAL);
  assert.deepEqual(s.stages.map((x) => x.id), ["5516:4829", "9034:9033"], "the two LTX stages; not the Krea still nor the switched-off video node");
  assert.equal(s.model, "ltx-2.5-22b-distilled-transformer-bf16", "named by the model that runs, not the first loader in the file");
  assert.deepEqual([s.width, s.height, s.frames], [1920, 1088, 121], "size and the stage's own 121 frames");
  assert.ok(!s.loaderIds.includes("9047"), "the Krea loaders don't run in a Klein Final");
  const live = liveIds(APP_FINAL);
  assert.ok(!live.has("9091"), "the audio-driven shot behind a disabled When never runs");
  assert.ok(!live.has("9081"), "the Final animates the picked frame (switch 9086), so no new Klein frame is painted");
  // The same graph at the Look-still rung: nothing past the frame.
  const still = JSON.parse(JSON.stringify(APP_FINAL));
  still["9059"].inputs.step = 2;
  assert.deepEqual(jobShape(still).stages, [], "rung 2: no video sampler runs");
});

test("gates, switches and When: each skips only its untaken input", () => {
  const g = {
    1: { class_type: "KSampler", inputs: { steps: 4 } }, 2: { class_type: "KSampler", inputs: { steps: 6 } },
    3: { class_type: "ComfySwitchNode", inputs: { switch: false, on_true: ["1", 0], on_false: ["2", 0] } },
    4: { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    5: { class_type: "SoundstageStep", inputs: { step: 3 } },
    6: { class_type: "KSampler", inputs: { steps: 9 } },
    7: { class_type: "SoundstageGate", inputs: { rung: 4, step: ["5", 0], value: ["6", 0] } },
    8: { class_type: "SaveImage", inputs: { images: ["7", 0] } },
    9: { class_type: "KSampler", inputs: { steps: 5 } },
    10: { class_type: "SoundstageGate", inputs: { rung: 3, step: ["5", 0], value: ["9", 0] } },
    11: { class_type: "SaveImage", inputs: { images: ["10", 0] } },
    12: { class_type: "KSampler", inputs: { steps: 7 } },
    13: { class_type: "SoundstageWhen", inputs: { enabled: false, value: ["12", 0] } },
    14: { class_type: "SaveImage", inputs: { images: ["13", 0] } },
    15: { class_type: "KSampler", inputs: { steps: 2 } }, 16: { class_type: "KSampler", inputs: { steps: 3 } },
    17: { class_type: "ComfySwitchNode", inputs: { switch: ["5", 0], on_true: ["15", 0], on_false: ["16", 0] } },
    18: { class_type: "SaveImage", inputs: { images: ["17", 0] } },
  };
  assert.deepEqual(jobShape(g).stages.map((x) => x.id).sort(), ["15", "16", "2", "9"],
    "switch false -> on_false; gate at rung 4 above step 3 is off, rung 3 on; When off; a linked switch keeps both");
});

test("learning from real runs: a stage that never runs costs nothing, and the estimate stays near the measured totals", () => {
  const est = new Estimator({ storage: memStore(), machine: "NVIDIA L40" });
  // A shape with a stage that never runs (a switch the graph can't resolve): 12 steps of nothing.
  const s = { model: "ltx", width: 1920, height: 1088, frames: 121, batch: 1,
    stages: [{ id: "a", steps: 12 }, { id: "b", steps: 8 }, { id: "c", steps: 3 }], decodeIds: [], loaderIds: [] };
  const tenMin = { totalMs: 600_000, loadMs: 60_000, cold: true, decodeMs: 60_000,
    stages: [{ id: "a", steps: 12, ms: 0 }, { id: "b", steps: 8, ms: 240_000 }, { id: "c", steps: 3, ms: 180_000 }] };
  for (let i = 0; i < 3; i++) est.learn(s, "final", tenMin, est.predict(s, "final", { warm: false })?.ms);
  const p = est.predict(s, "final", { warm: false });
  assert.ok(Math.abs(p.ms - 600_000) < 60_000, `about 10 min, not 30 (got ${Math.round(p.ms / 1000)} s)`);
  assert.equal(p.phases.stages[0].ms, 0, "the stage that never ran");
  // A book polluted before this fix (rates three times too high) is held to what the runs really took.
  const key = Object.keys(est.book).find((k) => !k.includes("|*|"));
  est.book[key].byId.b.rate *= 3; est.book[key].byId.c.rate *= 3;
  const q = est.predict(s, "final", { warm: false });
  assert.ok(q.ms <= 1.6 * 600_000 + 1, `held within 1.6x of the measured 10 min (got ${Math.round(q.ms / 1000)} s)`);
  // ...but twice the steps is allowed to take about twice as long.
  const s2 = { ...s, stages: [{ id: "a", steps: 12 }, { id: "b", steps: 16 }, { id: "c", steps: 6 }] };
  est.book[key].byId.b.rate /= 3; est.book[key].byId.c.rate /= 3;
  assert.ok(est.predict(s2, "final", { warm: false }).ms > 900_000, "16 + 6 steps instead of 8 + 3: well over 15 min");
});

test("the L40 case end to end: three ~10 min Finals of the App's graph teach a 10 min estimate", () => {
  const c = { t: 1_000_000 }; const now = () => c.t;
  const reg = new ActivityRegistry({ clientId: "me", now, eta: new EtaBook({ storage: memStore() }),
    est: new Estimator({ storage: memStore(), machine: "NVIDIA L40" }) });
  for (const [i, took] of [[1, 540_000], [2, 660_000], [3, 600_000]]) {
    const id = `f${i}`;
    reg.note(id, { name: "Final · shot 1", kind: "final" }); reg.graph(id, APP_FINAL);
    reg.onEvent("execution_start", { prompt_id: id });
    const at = (node, ms) => { reg.onEvent("executing", { prompt_id: id, node }); c.t += ms; };
    // the two LTX stages report their steps; the rest is model loads, the decode and saving
    at("5004:5602", 0.1 * took);
    reg.onEvent("executing", { prompt_id: id, node: "5516:4829" });
    for (let k = 1; k <= 8; k++) { c.t += 0.04 * took; reg.onEvent("progress", { prompt_id: id, node: "5516:4829", value: k, max: 8 }); }
    reg.onEvent("executing", { prompt_id: id, node: "9034:9033" });
    for (let k = 1; k <= 3; k++) { c.t += 0.1 * took; reg.onEvent("progress", { prompt_id: id, node: "9034:9033", value: k, max: 3 }); }
    at("9062:5538", 0.25 * took);
    reg.onEvent("execution_success", { prompt_id: id });
  }
  reg.note("f4", { name: "Final · shot 1", kind: "final" }); reg.graph("f4", APP_FINAL);
  reg.applySummary({ running: 0, pending: 1, items: [{ prompt_id: "f4", state: "pending", position: 0, client_id: "me" }] });
  const [q] = reg.view().queued;
  assert.notEqual(q.estSure, "rough", "from the three runs, not the docs' first guess");
  assert.ok(q.remainingMs > 8 * 60_000 && q.remainingMs < 12.5 * 60_000, `about 10 min (got ${(q.remainingMs / 60_000).toFixed(1)} min)`);
});
