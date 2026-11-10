// node --test tests/js/livepreview.test.mjs
// Live sampling previews (web/pipeline/livepreview.mjs): the websocket's binary preview frames as ComfyUI 0.44 sends
// them (event 1 bare, event 4 with {node_id, prompt_id, display_node_id…}), routed to the right job's tile with its step
// count, other prompts ignored, ④ always previewed, ⑤ only with the switch on ("none" when off), the switch per viewer,
// and the wiring (soundstage.js queue wrapper, Pipeline tiles, centre view, Motion strip).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parsePreviewFrame, previewFromEvent, previewMethodFor, withPreviewOption, stepLabel, LivePreviews, attachLivePreviews,
  loadVideoPreview, saveVideoPreview, VIDEO_PREVIEW_KEY, VIDEO_PREVIEW_TIP, VIDEO_PREVIEW_LABEL } from "../../web/pipeline/livepreview.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const FIX = here("../livepreview_fixtures/");
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

/** Build a frame exactly as server.py send_image_with_metadata does. */
function metaFrame(meta, img = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)) {
  const json = new TextEncoder().encode(JSON.stringify({ ...meta, image_type: "image/jpeg" }));
  const b = new Uint8Array(8 + json.length + img.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 4); dv.setUint32(4, json.length);
  b.set(json, 8); b.set(img, 8 + json.length);
  return b;
}

function fakeURLs() {
  let n = 0; const live = new Set();
  return { createURL: () => { const u = `blob:${++n}`; live.add(u); return u; }, revokeURL: (u) => live.delete(u), live };
}

test("a recorded ComfyUI 0.44.2 preview frame (event 4) parses: metadata, prompt id, a real JPEG", () => {
  const files = existsSync(FIX) ? readdirSync(FIX).filter((f) => f.endsWith(".bin")) : [];
  assert.ok(files.length >= 1, "tests/livepreview_fixtures/*.bin recorded from the pod");
  for (const f of files) {
    const p = parsePreviewFrame(readFileSync(FIX + f));
    assert.ok(p, f);
    assert.equal(p.event, 4);
    assert.match(p.meta.prompt_id, /^[0-9a-f-]{36}$/);
    assert.ok(p.meta.node_id && p.meta.display_node_id, "node ids");
    assert.equal(p.mime, "image/jpeg");
    assert.deepEqual([...p.image.subarray(0, 2)], [0xff, 0xd8], "JPEG SOI");
    assert.deepEqual([...p.image.subarray(-2)], [0xff, 0xd9], "JPEG EOI");
  }
});

test("event 1 (no metadata) and junk", () => {
  const b = new Uint8Array(12); const dv = new DataView(b.buffer); dv.setUint32(0, 1); dv.setUint32(4, 2);
  const p = parsePreviewFrame(b.buffer);
  assert.deepEqual([p.event, p.mime, p.meta, p.image.length], [1, "image/png", null, 4]);
  assert.equal(parsePreviewFrame(new Uint8Array(3)), null);
  const t = new Uint8Array(12); new DataView(t.buffer).setUint32(0, 3); // TEXT
  assert.equal(parsePreviewFrame(t), null);
  const bad = metaFrame({ prompt_id: "x" }); new DataView(bad.buffer).setUint32(4, 9999);
  assert.equal(parsePreviewFrame(bad), null, "a length past the end");
});

test("the frontend's events: jobId (1.57) or promptId (older), display node", () => {
  const blob = { size: 4 };
  assert.deepEqual(previewFromEvent("b_preview_with_metadata", { blob, nodeId: "9081.0.0.12", displayNodeId: "9081", jobId: "p1" }),
    { pid: "p1", node: "9081.0.0.12", display: "9081", blob });
  assert.equal(previewFromEvent("b_preview_with_metadata", { blob, nodeId: 3, promptId: "p2" }).pid, "p2");
  assert.deepEqual(previewFromEvent("b_preview", blob), { pid: null, node: null, display: null, blob });
  assert.equal(previewFromEvent("b_preview_with_metadata", { nodeId: 1 }), null);
});

test("routing: a recorded frame lands on its own job's tile with the step; other prompts are ignored", () => {
  const u = fakeURLs();
  const lp = new LivePreviews({ ...u, now: () => 5 });
  lp.track("mine", { sid: "s1", rung: 2 });
  lp.track("also-mine", { sid: "s1", rung: 2 });
  const seen = [];
  lp.onChange((pid, st) => seen.push([pid, st?.url ?? null]));
  const raw = parsePreviewFrame(metaFrame({ node_id: "9081.0.0.12", prompt_id: "mine", display_node_id: "9081" }));
  const ev = { blob: new Blob([raw.image], { type: raw.mime }), nodeId: raw.meta.node_id, displayNodeId: raw.meta.display_node_id, jobId: raw.meta.prompt_id };
  lp.onPreview(previewFromEvent("b_preview_with_metadata", ev));
  lp.onProgress({ value: 6, max: 12, prompt_id: "mine", node: "9081.0.0.12" });
  assert.equal(stepLabel(lp.get("mine")), "step 6/12");
  assert.equal(lp.get("mine").url, "blob:1");
  assert.equal(lp.get("also-mine").url, null, "the other tile is untouched");
  // another tab's / another panel's prompt
  assert.equal(lp.onPreview({ pid: "someone-else", node: "3", blob: {} }), null);
  assert.equal(lp.onProgress({ value: 1, max: 4, prompt_id: "someone-else", node: "3" }), null);
  assert.equal(u.live.size, 1);
  // next step: the old URL is revoked
  lp.onPreview({ pid: "mine", node: "9081.0.0.12", blob: {} });
  assert.deepEqual([...u.live], ["blob:2"]);
  // finished: the real image replaces it (the tile goes, its URL is revoked)
  lp.untrack("mine");
  assert.equal(lp.get("mine"), null);
  assert.equal(u.live.size, 0);
  assert.deepEqual(seen.at(-1), ["mine", null]);
});

test("a second sampler in the same frame job is pass 2; a VAE decode's progress is not a step", () => {
  const lp = new LivePreviews(fakeURLs());
  lp.track("p", { sid: "s" });
  assert.equal(stepLabel(lp.get("p")), "waiting for the GPU…");
  lp.onProgress({ value: 3, max: 9, prompt_id: "p", node: "9001" }); // a stage pass before any preview
  assert.equal(lp.get("p").steps, 0);
  lp.onPreview({ pid: "p", node: "k1", blob: {} });
  lp.onProgress({ value: 1, max: 8, prompt_id: "p", node: "k1" });
  assert.equal(stepLabel(lp.get("p")), "step 1/8");
  lp.onProgress({ value: 2, max: 9, prompt_id: "p", node: "vae" });
  assert.equal(stepLabel(lp.get("p")), "step 1/8", "the decode's bar didn't move the step");
  lp.onProgress({ value: 1, max: 4, prompt_id: "p", node: "cast" });
  lp.onPreview({ pid: "p", node: "cast", blob: {} });
  assert.equal(stepLabel(lp.get("p")), "pass 2 · step 1/4", "the step count seen just before the pass's first preview");
});

test("b_preview (no prompt id) goes to the running job; with metadata seen, the bare duplicate is dropped", () => {
  const listeners = {};
  const api = { addEventListener: (t, f) => ((listeners[t] ||= []).push(f)), removeEventListener: (t, f) => { listeners[t] = listeners[t].filter((x) => x !== f); } };
  const fire = (t, detail) => (listeners[t] || []).forEach((f) => f({ detail }));
  const u = fakeURLs();
  const lp = new LivePreviews(u);
  const off = attachLivePreviews(api, lp);
  lp.track("p", {});
  fire("execution_start", { prompt_id: "p" });
  fire("b_preview", {});                      // an older server: event 1
  assert.equal(lp.get("p").url, "blob:1");
  fire("b_preview_with_metadata", { blob: {}, nodeId: "5", jobId: "p" });
  fire("b_preview", {});                      // the same frame again, as the frontend dispatches it
  assert.equal(lp.get("p").url, "blob:2");
  fire("progress", { value: 2, max: 8, prompt_id: "p", node: "5" });
  assert.equal(stepLabel(lp.get("p")), "step 2/8");
  off();
  assert.ok(Object.values(listeners).every((a) => a.length === 0));
});

test("video jobs keep a strip of the last frames; the rest are revoked", () => {
  const u = fakeURLs();
  const lp = new LivePreviews({ ...u, keep: 3 });
  lp.track("v", { video: true });
  for (let i = 0; i < 5; i++) lp.onPreview({ pid: "v", node: "s", blob: {} });
  assert.deepEqual(lp.get("v").frames, ["blob:3", "blob:4", "blob:5"]);
  assert.equal(u.live.size, 3);
  lp.untrack("v");
  assert.equal(u.live.size, 0);
});

test("preview method: ④ always, ⑤ only with the switch on ('none' when off), taesd only where the tiny decoder is installed", () => {
  const pod = ["taeh3.safetensors"];   // the L40 pod's models/vae_approx, 2026-11-09
  assert.equal(previewMethodFor({ kind: "image", approx: pod }), "latent2rgb");
  assert.equal(previewMethodFor({ kind: "image", approx: ["taef2_decoder.safetensors"] }), "taesd");
  assert.equal(previewMethodFor({ kind: "ltx", approx: pod, videoOn: false }), "none");
  assert.equal(previewMethodFor({ kind: "ltx", approx: pod, videoOn: true }), "latent2rgb");
  assert.equal(previewMethodFor({ kind: "h3", approx: pod, videoOn: true }), "taesd");
  assert.equal(previewMethodFor({ kind: "h3", approx: pod, videoOn: false }), "none");
  assert.equal(previewMethodFor({ kind: "layers", approx: pod, videoOn: true }), null);
  assert.equal(previewMethodFor({ kind: "image" }), "latent2rgb", "vae_approx not known yet");
});

test("queuePrompt's options get previewMethod; nothing asked, nothing changed", () => {
  const args = [0, { output: {} }, { partialExecutionTargets: ["9"], previewMethod: "default" }];
  assert.deepEqual(withPreviewOption(args, "latent2rgb")[2], { partialExecutionTargets: ["9"], previewMethod: "latent2rgb" });
  assert.deepEqual(withPreviewOption([0, { output: {} }], "none")[2], { previewMethod: "none" });
  assert.equal(withPreviewOption(args, null), args);
});

test("the Motion switch is remembered per viewer; blocked storage is off, never a throw", () => {
  const s = memStore();
  assert.equal(loadVideoPreview(s), false, "off by default");
  saveVideoPreview(true, s);
  assert.equal(s.getItem(VIDEO_PREVIEW_KEY), "1");
  assert.equal(loadVideoPreview(s), true);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(loadVideoPreview(broken), false);
  assert.equal(saveVideoPreview(true, broken), false);
  assert.equal(VIDEO_PREVIEW_LABEL, "Live preview while rendering (slower)");
  assert.match(VIDEO_PREVIEW_TIP, /measured/i, "the tooltip carries the measured cost");
});

test("wiring: the queue wrapper passes the asked method; ④ tiles, the centre view and ⑤'s switch exist", () => {
  const ss = readFileSync(here("../../web/soundstage.js"), "utf8");
  assert.match(ss, /args = withPreviewOption\(args, api\.__ssNextPreview\)/);
  assert.match(ss, /api\.__ssNextPreview = null/);
  const pl = readFileSync(here("../../web/pipeline/pipeline.mjs"), "utf8");
  assert.match(pl, /api\.__ssNextPreview = method/);
  assert.match(pl, /this\.lp\.track\(pid,/);
  assert.match(pl, /class: "cand ss-live"/);
  assert.match(pl, /f\.liveHero = h\(/);
  assert.match(pl, /VIDEO_PREVIEW_LABEL\)/);
  assert.match(pl, /this\.lp\?\.untrack\(pid\)/, "a finished job's preview goes");
});
