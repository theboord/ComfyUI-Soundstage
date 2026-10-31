// node --test tests/js/modelmatch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isModelFile, baseName, folderOf, modelTokens, precisionOf, familyKey, closestModel, shortModelName, describeSwap,
  planModelFixes, noticeLines, MODELS_DOC_URL,
} from "../../web/ui/modelmatch.mjs";
import { guardModels, loaderWidgets, fedByWire, allNodes } from "../../web/ui/modelguard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// What a pod with the int8-convrot LTX builds and the LoRA under ltx2.5/ lists (trimmed from /object_info).
const UNET = ["Krea-2-Turbo.safetensors", "flux3-image-klein-int8-convrot.safetensors",
  "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "wan2.2_animate_14B_bf16.safetensors"];
const CLIP = ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "gemma4_e2b_it_bf16.safetensors",
  "qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_8b_fp8_scaled.safetensors", "qwen3.5_4b_bf16.safetensors"];
const LORA = ["krea2/cn/depth-control-lora.safetensors", "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
  "ltx2.5/ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors", "ltxv/ltx2/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors"];
const VAE = ["ltx-2.5-audio-vae-bf16.safetensors", "ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-video-vae-conv-bf16.safetensors"];

test("file names: model extension, folder, words, precision", () => {
  assert.ok(isModelFile("a/b.safetensors") && isModelFile("x.gguf") && isModelFile("dw.torchscript.pt"));
  assert.ok(!isModelFile("FLUX 3 Klein (local, recommended)") && !isModelFile(3) && !isModelFile("default"));
  assert.equal(baseName("ltx2.5/x.safetensors"), "x.safetensors");
  assert.equal(folderOf("ltxv/ltx2/x.safetensors"), "ltxv/ltx2/");
  assert.equal(folderOf("x.safetensors"), "");
  assert.deepEqual(modelTokens("ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"),
    ["ltx", "2.5", "22b", "ic", "lora", "layout", "to", "render", "1.0"]);
  assert.deepEqual(precisionOf("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"), ["int8"]);
  assert.deepEqual(precisionOf("qwen3vl_4b_fp8_scaled.safetensors"), ["fp8"]);
});

test("the family ignores precision, packaging and separators", () => {
  assert.equal(familyKey("ltx-2.5-22b-distilled-transformer-bf16.safetensors"),
    familyKey("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"));
  assert.equal(familyKey("Krea-2-Turbo.safetensors"), familyKey("krea2_turbo_fp8_scaled.safetensors"));
  assert.equal(familyKey("minimax_h3_fl2va_bf16.safetensors"), familyKey("minimax_h3_fl2va_pruned_int8_convrot.safetensors"));
  // Different weights stay different.
  assert.notEqual(familyKey("ltx-2.5-video-vae-bf16.safetensors"), familyKey("ltx-2.5-video-vae-conv-bf16.safetensors"));
  assert.notEqual(familyKey("ltx-2.5-22b-distilled-transformer-bf16.safetensors"), familyKey("ltx-2.3-22b-distilled-transformer-bf16.safetensors"));
  assert.notEqual(familyKey("minimax_h3_fl2va_bf16.safetensors"), familyKey("minimax_h3_ref2va_bf16.safetensors"));
  assert.notEqual(familyKey("qwen3vl_4b_fp8_scaled.safetensors"), familyKey("qwen3vl_8b_fp8_scaled.safetensors"));
});

test("closest installed build: the Milestone 3 trio", () => {
  assert.equal(closestModel("ltx-2.5-22b-distilled-transformer-bf16.safetensors", UNET),
    "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors");
  assert.equal(closestModel("gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", CLIP),
    "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors");
  assert.equal(closestModel("ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", LORA),
    "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors");
  // ...and the reverse install (bf16 only) maps the int8 name back.
  assert.equal(closestModel("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", ["ltx-2.5-22b-distilled-transformer-bf16.safetensors"]),
    "ltx-2.5-22b-distilled-transformer-bf16.safetensors");
});

test("closest installed build: never another family, never another version", () => {
  assert.equal(closestModel("ltx-2.3-22b-dev.safetensors", UNET), null);
  assert.equal(closestModel("ltx-2.5-video-vae-fp32.safetensors", ["ltx-2.5-video-vae-conv-bf16.safetensors"]), null);
  assert.equal(closestModel("ltx-2.5-22b-ic-lora-layout-to-render-1.1.safetensors", LORA), null);
  assert.equal(closestModel("qwen3vl_4b_int8_convrot.safetensors", ["qwen3vl_8b_fp8_scaled.safetensors"]), null);
  assert.equal(closestModel("not-a-model", UNET), null);
  assert.equal(closestModel("x.safetensors", []), null);
});

test("closest installed build: same name in a folder beats a precision swap; nearest precision next", () => {
  const opts = ["sub/foo-bf16.safetensors", "foo-int8-convrot.safetensors"];
  assert.equal(closestModel("foo-bf16.safetensors", opts), "sub/foo-bf16.safetensors");
  // bf16 wanted: fp16 is nearer than fp8, fp8 nearer than int8.
  assert.equal(closestModel("m-bf16.safetensors", ["m-int8.safetensors", "m-fp8_scaled.safetensors", "m-fp16.safetensors"]), "m-fp16.safetensors");
  assert.equal(closestModel("m-bf16.safetensors", ["m-int8.safetensors", "m-fp8_scaled.safetensors"]), "m-fp8_scaled.safetensors");
  // Equally near (fp16 and fp32 around bf16? fp32 is rank 0, fp16 rank 2): the higher precision wins a tie.
  assert.equal(closestModel("m-bf16.safetensors", ["m-fp16.safetensors", "m-fp32.safetensors"]), "m-fp32.safetensors");
  // A shallower folder wins over a deeper one.
  assert.equal(closestModel("lora.safetensors", ["a/b/lora.safetensors", "a/lora.safetensors"]), "a/lora.safetensors");
  // Case does not matter.
  assert.equal(closestModel("krea2_turbo_fp8_scaled.safetensors", UNET), "Krea-2-Turbo.safetensors");
});

test("the notice says what it used and why", () => {
  assert.equal(shortModelName("ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"), "ltx-2.5-…int8-convrot");
  assert.equal(shortModelName("Krea-2-Turbo.safetensors"), "Krea-2-Turbo");
  assert.equal(describeSwap("ltx-2.5-22b-distilled-transformer-bf16.safetensors", "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"),
    "Using ltx-2.5-…int8-convrot (you don't have the bf16 file)");
  assert.equal(describeSwap("ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"),
    "Using ltx-2.5-…to-render-1.0 (found it in ltx2.5/)");
  assert.equal(describeSwap("Krea-2-Turbo.safetensors", "krea2_turbo_fp8_scaled.safetensors"),
    "Using krea2_turbo_fp8_scaled (you don't have Krea-2-Turbo.safetensors)");
  assert.match(MODELS_DOC_URL, /MODELS\.md$/);
});

test("plan: swaps, missing files, and widgets left alone", () => {
  const plan = planModelFixes([
    { id: 1, node: "UNETLoader · Load Models", widget: "unet_name", value: "ltx-2.5-22b-distilled-transformer-bf16.safetensors", options: UNET },
    { id: 2, node: "UNETLoader", widget: "unet_name", value: "Krea-2-Turbo.safetensors", options: UNET },              // fine
    { id: 3, node: "UNETLoader", widget: "unet_name", value: "ltx-2.3-22b-dev.safetensors", options: UNET },          // missing
    { id: 4, node: "Picker", widget: "model", value: "FLUX 3 Klein", options: ["FLUX 3 Klein"] },                     // not a file
    { id: 5, node: "X", widget: "ckpt", value: "a.safetensors", options: null },                                      // no list
    { id: 6, node: "X", widget: "mode", value: "w.pt", options: ["fast", "slow"] },                                   // not a loader
    { id: 7, node: "VAELoader", widget: "vae_name", value: "gone.safetensors", options: [] },                         // empty folder
  ]);
  assert.deepEqual(plan.swaps.map((s) => [s.id, s.to]), [[1, "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"]]);
  assert.deepEqual(plan.missing.map((m) => m.id), [3, 7]);
  const lines = noticeLines({ swaps: [...plan.swaps, ...plan.swaps], missing: [...plan.missing, plan.missing[0]] });
  assert.equal(lines.swaps.length, 1, "one line per distinct swap");
  assert.deepEqual(lines.missing, ["Missing ltx-2.3-22b-dev.safetensors (UNETLoader)", "Missing gone.safetensors (VAELoader)"]);
});

// A live-graph stand-in: the top graph, a "Load Models" subgraph whose loaders are wired to the subgraph's own
// input slots (origin -10, the promoted widgets), and a node whose model widget is fed by another node's output.
function fakeGraph() {
  const combo = (name, value, values) => ({ name, value, options: { values } });
  const sub = { name: "Load Models", links: new Map([[3, { origin_id: -10 }], [7, { origin_id: -10 }]]), _nodes: [] };
  sub._nodes.push(
    { type: "UNETLoader", graph: sub, inputs: [{ name: "unet_name", widget: { name: "unet_name" }, link: 3 }],
      widgets: [combo("unet_name", "ltx-2.5-22b-distilled-transformer-bf16.safetensors", UNET), combo("weight_dtype", "default", ["default"])] },
    { type: "LTXICLoRALoaderModelOnly", graph: sub, inputs: [{ name: "lora_name", widget: { name: "lora_name" }, link: 7 }],
      widgets: [combo("lora_name", "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", () => LORA)] },
    { type: "VAELoader", graph: sub, mode: 4, inputs: [], widgets: [combo("vae_name", "nope.safetensors", VAE)] },   // bypassed
  );
  const top = { links: { 50: { origin_id: 12 } }, subgraphs: new Map([["sg", sub]]), _nodes: [] };
  top._nodes.push(
    { type: "SoundstageStage", graph: top, inputs: [], widgets: [] },
    { type: "GemmaAPITextEncode", graph: top, inputs: [{ name: "ckpt_name", widget: { name: "ckpt_name" }, link: 50 }],
      widgets: [combo("ckpt_name", "ltx-2.3-22b-dev.safetensors", UNET)] },                                            // fed by a wire
    { type: "CLIPLoader", graph: top, inputs: [], widgets: [combo("clip_name", "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors", CLIP)] },
  );
  return { top, sub };
}

test("guard on a live graph: subgraph loaders fixed in place, wired and bypassed widgets left alone", () => {
  const { top, sub } = fakeGraph();
  assert.equal(allNodes(top).length, 6);
  assert.equal(fedByWire(top._nodes[1], top._nodes[1].widgets[0]), true);
  assert.equal(fedByWire(sub._nodes[0], sub._nodes[0].widgets[0]), false, "a subgraph-input slot is the subgraph's own widget");
  assert.equal(loaderWidgets(top).length, 3);
  const plan = guardModels(top);
  assert.equal(plan.missing.length, 0);
  assert.equal(sub._nodes[0].widgets[0].value, "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors");
  assert.equal(sub._nodes[1].widgets[0].value, "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors");
  assert.equal(top._nodes[2].widgets[0].value, "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors");
  assert.equal(top._nodes[1].widgets[0].value, "ltx-2.3-22b-dev.safetensors", "wired value untouched");
  assert.equal(sub._nodes[2].widgets[0].value, "nope.safetensors", "bypassed node untouched");
  assert.equal(guardModels(top).swaps.length, 0, "a second pass has nothing left to do");
});

// ---------------------------------------------------------------- shipped workflows vs MODELS.md
const documented = () => {
  const names = new Set();
  for (const f of ["MODELS.md", "docs/recast.md", "docs/TUTORIAL.md"]) {
    const txt = readFileSync(join(ROOT, f), "utf8");
    for (const m of txt.matchAll(/`([^`\s]+\.(?:safetensors|gguf|pt|pth))`/g)) names.add(m[1].replace(/^(loras|diffusion_models|text_encoders|vae|checkpoints)\//, ""));
  }
  return [...names];
};
const workflowModelNames = (wf) => {
  const out = [];
  const nodes = [...(wf.nodes || []), ...((wf.definitions?.subgraphs || []).flatMap((s) => s.nodes || []))];
  for (const n of nodes) {
    const wv = n.widgets_values;
    const vals = Array.isArray(wv) ? wv : wv && typeof wv === "object" ? Object.values(wv) : [];
    for (const v of vals) if (isModelFile(v)) out.push([n.id, n.type, v]);
    for (const m of n.properties?.models || []) out.push([n.id, n.type + " (download list)", m.name]);
  }
  return out;
};

test("shipped workflows spell every documented model the way MODELS.md does", () => {
  const docs = documented();
  const byFamily = new Map();
  for (const d of docs) { const k = familyKey(d); if (!byFamily.has(k)) byFamily.set(k, []); byFamily.get(k).push(d); }
  // Documented in a folder (`ltx2.5/…`): the bare name is the known-bad spelling.
  const inFolder = new Map(docs.filter((d) => folderOf(d)).map((d) => [baseName(d), d]));
  const bad = [];
  const dir = join(ROOT, "example_workflows");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const wf = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const [id, type, v] of workflowModelNames(wf)) {
      if (!folderOf(v) && inFolder.has(v)) { bad.push(`${f} #${id} ${type}: ${v} -> ${inFolder.get(v)}`); continue; }
      const fam = byFamily.get(familyKey(v));
      if (fam && !fam.includes(v) && !fam.some((d) => baseName(d) === baseName(v) && folderOf(d) === folderOf(v))) {
        // A documented "(or …)" alternative is fine; any other build of a documented model is not.
        bad.push(`${f} #${id} ${type}: ${v} (MODELS.md: ${fam.join(" / ")})`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
