// node --test tests/js/doctor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { doctorView, openDoctor, DOCTOR_ROUTE } from "../../web/ui/doctor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The shape soundstage/doctor.py build_report() returns (trimmed).
const REPORT = {
  mode: "inside ComfyUI", comfyui_version: "0.43.0", tested_comfyui: "0.43.0", python: "/venv/bin/python",
  gpu: { name: "cuda:0 NVIDIA RTX 6000 Ada", vram_gb: 47.5, source: "ComfyUI" },
  steps: [
    { required: true, text: "Download ltx-2.5-audio-vae-bf16.safetensors into models/vae/ (LTX-2.5 audio VAE) for ⑤ Motion.", url: "https://huggingface.co/Lightricks/LTX-2.5" },
    { required: false, text: "Install ComfyUI-VideoHelperSuite: Manager › Install Custom Nodes.", url: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite" },
  ],
  features: [
    { id: "set", name: "Set, Look, Cut and exports", default: true, status: "ready", vram: "fits", vram_words: "no GPU needed", files: [] },
    { id: "motion", name: "⑤ Motion", default: true, status: "not ready", vram: "fits", vram_words: "fits (tested on a 48 GB card)",
      files: [
        { folder: "vae", want: "ltx-2.5-audio-vae-bf16.safetensors", status: "missing", url: "https://huggingface.co/Lightricks/LTX-2.5", size: null },
        { folder: "text_encoders", want: "gemma4-…-int8-convrot.safetensors", status: "other_build", found: "gemma4-…-bf16.safetensors" },
        { folder: "vae", want: "ltx-2.5-video-vae-bf16.safetensors", status: "ok" },
      ] },
    { id: "voice", name: "Director voice, offline", default: false, status: "not ready", vram: "fits", vram_words: "no GPU needed",
      files: [{ folder: "whisper/whisper-base", want: "whisper-base", is_dir: true, source: "openai/whisper-base", status: "missing", size: "about 290 MB" }] },
  ],
  packs: [
    { id: "ltxvideo", name: "ComfyUI-LTXVideo", required: true, status: "ok", missing: [], url: "https://github.com/Lightricks/ComfyUI-LTXVideo" },
    { id: "core", name: "ComfyUI core nodes", required: true, status: "partial", missing: ["SAM3_Detect"], url: "https://github.com/comfyanonymous/ComfyUI" },
  ],
  deps: [{ module: "soundfile", pip: "soundfile", required: true, why: "audio", status: "ok" },
    { module: "aaf2", pip: "pyaaf2", required: false, why: "AAF", status: "missing" }],
  models_doc: "https://github.com/theboord/ComfyUI-Soundstage/blob/main/MODELS.md",
  text: "Soundstage doctor\n…",
};

test("doctorView: required steps first, files that need work, plain words", () => {
  const v = doctorView(REPORT);
  assert.equal(v.ready, false);
  assert.match(v.headline, /^Not ready yet: 1 thing to do/);
  assert.equal(v.steps.length, 1);
  assert.equal(v.optional.length, 1);
  assert.match(v.where, /ComfyUI 0\.43\.0 .* RTX 6000 Ada, 47\.5 GB/);
  const motion = v.features.find((f) => f.name.startsWith("⑤"));
  assert.equal(motion.mark, "✗");
  assert.deepEqual(motion.files.map((f) => f.tone), ["bad", "ok"]);   // the ok file is not listed
  assert.match(motion.files[1].text, /another build .*; fine/);
  const voice = v.features.find((f) => f.name.includes("voice"));
  assert.match(voice.name, /\(optional\)$/);
  assert.match(voice.files[0].text, /^openai\/whisper-base → models\/whisper\/whisper-base\/ · about 290 MB/);
  assert.match(v.packs[1].text, /partial \(missing SAM3_Detect\)/);
  assert.equal(v.deps.length, 2);
});

test("doctorView: ready, and packages not checked from outside ComfyUI", () => {
  const v = doctorView({ ...REPORT, steps: [], deps: [{ module: "soundfile", pip: "soundfile", required: true, why: "", status: "unknown" }] });
  assert.equal(v.ready, true);
  assert.match(v.headline, /^Ready/);
  assert.equal(v.deps.length, 0);
  assert.match(v.depsNote, /not checked/);
});

// A small stand-in for the DOM: enough for openDoctor().
function fakeDoc() {
  const byId = new Map();
  const mk = (tag) => {
    const e = { tag, children: [], attrs: {}, style: {}, listeners: {}, _text: "", parent: null,
      set id(v) { this._id = v; byId.set(v, this); }, get id() { return this._id; },
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); },
      append(...cs) { for (const c of cs) { if (c && typeof c === "object") c.parent = this; this.children.push(c); } },
      replaceChildren(...cs) { this.children = []; this._text = ""; this.append(...cs); },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); if (this._id) byId.delete(this._id); },
      click() { for (const f of this.listeners.click || []) f({ target: this }); },
      find(pred) { for (const c of this.children) { if (typeof c !== "object") continue; if (pred(c)) return c; const r = c.find(pred); if (r) return r; } return null; },
    };
    return e;
  };
  const doc = { createElement: mk, getElementById: (id) => byId.get(id) || null, head: mk("head"), body: mk("body"),
    addEventListener() {}, removeEventListener() {} };
  return doc;
}

test("openDoctor: asks the route once and draws the report", async () => {
  const doc = fakeDoc();
  const asked = [];
  const rep = await openDoctor({ doc, fetchApi: async (p) => { asked.push(p); return { ok: true, status: 200, json: async () => REPORT }; } });
  assert.deepEqual(asked, [DOCTOR_ROUTE]);
  assert.equal(rep, REPORT);
  const dlg = doc.getElementById("ss-doctor");
  assert.ok(dlg);
  const text = dlg.textContent;
  assert.match(text, /Check my setup/);
  assert.match(text, /Not ready yet/);
  assert.match(text, /ltx-2\.5-audio-vae-bf16/);
  assert.match(text, /Optional extras/);
  // Close removes it.
  dlg.find((c) => c.className === "x").click();
  assert.equal(doc.getElementById("ss-doctor"), null);
});

test("openDoctor: an older server without the route says to restart", async () => {
  const doc = fakeDoc();
  const rep = await openDoctor({ doc, fetchApi: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(rep, null);
  assert.match(doc.getElementById("ss-doctor").textContent, /restart ComfyUI/);
});

test("the App puts Check my setup in the Tools menu", () => {
  const src = readFileSync(join(ROOT, "web", "soundstage.js"), "utf8");
  assert.match(src, /import \{ openDoctor \} from "\.\/ui\/doctor\.mjs"/);
  assert.match(src, /toolsMenu\.append\(doctorBtn\)/);
  assert.match(src, /built\.push\([^)]*doctorBtn/);
});
