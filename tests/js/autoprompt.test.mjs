// ④ Frame's prompt source (web/pipeline/autoprompt.mjs): Auto / Compiled / Manual per shot, stored in the Look JSON.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FramePrompt, frameTarget, sourceOf, withEntry, noteText, PROMPT_SOURCES } from "../../web/pipeline/autoprompt.mjs";

// a tiny h(): enough DOM for the block (no browser)
const h = (tag, attrs = {}, ...kids) => {
  const el = { tag, children: [], dataset: {}, attrs: {}, value: "", hidden: false, disabled: false, textContent: "", on: attrs.on || {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) el.dataset[k.slice(5)] = v; else if (k !== "on") el.attrs[k] = v;
  for (const k of kids.flat()) if (k != null) el.children.push(k);
  return el;
};

function rig({ available = true, reply, target = "edit" } = {}) {
  const look = { state: { description: "", frame_prompts: {} }, changes: 0, toJSON() { return JSON.parse(JSON.stringify(this.state)); },
    onChange() { this.changes++; } };
  const calls = [];
  const fetchApi = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url.endsWith("/status")) return { json: async () => ({ available, backend: "ollama", model: "qwen3-vl:4b" }) };
    if (url.endsWith("/compile")) return { json: async () => ({ edit_prompt: "COMPILED EDIT", still_prompt: "COMPILED STILL" }) };
    return { json: async () => reply };
  };
  let sid = "s1";
  const fp = new FramePrompt({ h, fetchApi, look, shotId: () => sid, scene: () => ({ shot_id: sid }), frame: () => "data:image/jpeg;base64,AA",
    refFiles: () => "cast/maya.png | Maya", target: () => target, steps: () => 12 });
  return { fp, look, calls, setShot: (s) => { sid = s; } };
}

const AUTO = { source: "auto", prompt: "Turn image 1 … AUTO", target: "edit", sig: "abc", seen: "a room", changed: "dropped the walk", ms: 3200, model: "qwen3-vl:4b", notes: [] };

test("three sources, Klein reads the edit instruction, Krea / Strict the description", () => {
  assert.deepEqual(PROMPT_SOURCES.map((x) => x[0]), ["auto", "compiled", "manual"]);
  assert.equal(frameTarget("FLUX 3 Klein · local"), "edit");
  assert.equal(frameTarget("FLUX.2 Klein 9B · local"), "edit");
  assert.equal(frameTarget("FLUX 3 Klein · local", { strict: true }), "still");
  assert.equal(frameTarget("__krea_depth__", { krea: true }), "still");
});

test("Auto is the default only when a vision model is installed", () => {
  assert.equal(sourceOf({}, "s1", true), "auto");
  assert.equal(sourceOf({}, "s1", false), "compiled");
  assert.equal(sourceOf({ frame_prompts: { s1: { source: "auto" } } }, "s1", false), "compiled");
  assert.equal(sourceOf({ frame_prompts: { s1: { source: "manual", text: "x" } } }, "s1", true), "manual");
  assert.deepEqual(withEntry({ frame_prompts: { a: 1, b: 2 } }, "a", null), { b: 2 });
});

test("Generate on an Auto shot writes the prompt and stores it per shot with its signature", async () => {
  const { fp, look, calls } = rig({ reply: AUTO });
  await fp.refreshStatus();
  assert.equal(fp.source(), "auto");
  await fp.ensure();
  const req = calls.find((c) => c.url === "/soundstage/look/autoprompt").body;
  assert.equal(req.target, "edit");
  assert.equal(req.ref_files, "cast/maya.png | Maya");
  assert.ok(req.image.startsWith("data:image/jpeg"));
  assert.deepEqual(look.state.frame_prompts.s1, { source: "auto", text: AUTO.prompt, target: "edit", sig: "abc" });
  assert.equal(fp.box.value, AUTO.prompt);
  assert.match(fp.note.textContent, /I see: a room\. I changed: dropped the walk\./);
});

test("a failed Auto keeps source auto without text, so the compiled prompt goes", async () => {
  const { fp, look } = rig({ reply: { source: "compiled", prompt: "COMPILED EDIT", compiled: "COMPILED EDIT", notes: ["No local vision model: the compiled prompt is used."] } });
  await fp.refreshStatus();
  await fp.ensure();
  assert.deepEqual(look.state.frame_prompts.s1, { source: "auto" });
  assert.equal(fp.box.value, "COMPILED EDIT");
  assert.match(fp.note.textContent, /compiled prompt is used/);
});

test("typing makes it Manual and keeps the text untouched; Compiled clears it; other shots are separate", async () => {
  const { fp, look, setShot } = rig({ reply: AUTO });
  await fp.refreshStatus();
  fp.box.value = "my own prompt, exactly";
  fp._typed();
  assert.deepEqual(look.state.frame_prompts.s1, { source: "manual", text: "my own prompt, exactly", target: "edit" });
  assert.equal(fp.source(), "manual");
  setShot("s2");
  assert.equal(fp.source(), "auto");
  setShot("s1");
  fp.setSource("compiled");
  assert.deepEqual(look.state.frame_prompts.s1, { source: "compiled" });
});

test("without a vision model the Auto button is disabled and says why", async () => {
  const { fp } = rig({ available: false });
  await fp.refreshStatus();
  const auto = fp.seg.children.find((b) => b.dataset.k === "auto");
  assert.equal(auto.disabled, true);
  assert.match(auto.title, /local vision model/);
  assert.equal(fp.source(), "compiled");
});

test("noteText says the fallback reason", () => {
  assert.match(noteText({ source: "compiled", notes: ["The written prompt failed the checks: the compiled prompt is used."], problems: ["says two people"] }), /failed the checks.*says two people/);
  assert.match(noteText({ error: "boom" }), /failed \(boom\)/);
});

test("④ Frame wires the block in and writes the prompt before queueing", () => {
  const src = readFileSync(new URL("../../web/pipeline/pipeline.mjs", import.meta.url), "utf8");
  assert.match(src, /this\.fp = new FramePrompt\(/);
  assert.match(src, /await this\.fp\?\.ensure\(\);[\s\S]{0,80}for \(let i = 0; i < f\.count; i\+\+\)/);
  const look = readFileSync(new URL("../../web/look/look.mjs", import.meta.url), "utf8");
  assert.match(look, /frame_prompts: \{\},/);
  const app = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  assert.match(app, /frameScene: \(\) => \(\{ \.\.\.stage\.toJSON\(\), camera_track/);
});
