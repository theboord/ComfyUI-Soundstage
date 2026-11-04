// node --test tests/js/loras.test.mjs
// One LoRA at a time, any LoRA (QA 2026-11-04): ④ Frame's "Style or character add-on" lists every LoRA in models/loras,
// the ones made for the frame model first ("Matches this model"), the rest under "Other LoRAs (may not work with this
// model)" with a warning, never a block. ⑤ Motion's Extra LoRA lists them all too, LTX ones first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loraFamily, frameModelFamily, stillLoraGroups, stillLoraWarning, ltxLoraGroups, LORA_MATCH_LABEL, LORA_OTHER_LABEL } from "../../web/pipeline/loras.mjs";
import { stillLoras } from "../../web/pipeline/pipeline.mjs";

const POD = ["None", "Garage Force Lora_v1.safetensors", "VNCCS_PoseStudioKlein9b.safetensors", "dmd2_sdxl_4step_lora.safetensors",
  "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", "styles/flux2_noir.safetensors", "krea2/krea_film_look.safetensors",
  "Flux3-film-grain.safetensors", "private/klein_mike.safetensors", "mara_v3.safetensors", "wan2.2_motion.safetensors"];
const KLEIN = "FLUX 3 Klein · local [<$5M]", TURBO = "Krea 2 Turbo · local";
const web = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), "utf8");

test("families from the name or folder", () => {
  assert.equal(loraFamily("VNCCS_PoseStudioKlein9b.safetensors"), "klein");
  assert.equal(loraFamily("styles/flux2_noir.safetensors"), "klein");
  assert.equal(loraFamily("krea2/krea_film_look.safetensors"), "krea");
  assert.equal(loraFamily("dmd2_sdxl_4step_lora.safetensors"), "sdxl");
  assert.equal(loraFamily("ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"), "ltx");
  assert.equal(loraFamily("wan2.2_motion.safetensors"), "wan");
  assert.equal(loraFamily("mara_v3.safetensors"), null);
  assert.equal(frameModelFamily(KLEIN), "klein");
  assert.equal(frameModelFamily(TURBO), "krea");
  assert.equal(frameModelFamily("__krea_depth__"), null);
});

test("FLUX 3 Klein: Klein LoRAs first, every other LoRA after, private folders hidden unless chosen", () => {
  const g = stillLoraGroups(POD, KLEIN);
  assert.deepEqual(g.match, ["VNCCS_PoseStudioKlein9b.safetensors", "styles/flux2_noir.safetensors", "Flux3-film-grain.safetensors"]);
  assert.deepEqual(g.other, ["Garage Force Lora_v1.safetensors", "dmd2_sdxl_4step_lora.safetensors", "ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
    "krea2/krea_film_look.safetensors", "mara_v3.safetensors", "wan2.2_motion.safetensors"]);
  assert.ok(!g.match.concat(g.other).includes("None"));
  assert.ok(stillLoraGroups(POD, KLEIN, "private/klein_mike.safetensors").match.includes("private/klein_mike.safetensors"));
  assert.deepEqual(stillLoras(POD).slice(0, 4), ["None", ...g.match]);
});

test("Krea 2 Turbo (the Strict depth lock, or picked): Krea LoRAs match, Klein ones move to Other", () => {
  const g = stillLoraGroups(POD, TURBO);
  assert.deepEqual(g.match, ["krea2/krea_film_look.safetensors"]);
  assert.ok(g.other.includes("styles/flux2_noir.safetensors"));
});

test("a LoRA from Other gets a short warning, a matching one none", () => {
  assert.equal(stillLoraWarning("None", KLEIN), "");
  assert.equal(stillLoraWarning("styles/flux2_noir.safetensors", KLEIN), "");
  assert.match(stillLoraWarning("dmd2_sdxl_4step_lora.safetensors", KLEIN), /SDXL LoRA: it may not work with FLUX 3 Klein/);
  assert.match(stillLoraWarning("mara_v3.safetensors", KLEIN), /Not sure this LoRA was made for FLUX 3 Klein/);
  assert.match(stillLoraWarning("styles/flux2_noir.safetensors", TURBO), /FLUX 3 Klein LoRA: it may not work with Krea 2/);
});

test("④ Frame builds the two groups, refills them when the model or the lock changes, and never blocks a pick", () => {
  const src = web("pipeline/pipeline.mjs");
  assert.equal(LORA_MATCH_LABEL, "Matches this model");
  assert.equal(LORA_OTHER_LABEL, "Other LoRAs (may not work with this model)");
  assert.match(src, /h\("optgroup", \{ label: LORA_MATCH_LABEL \}/);
  assert.match(src, /h\("optgroup", \{ label: LORA_OTHER_LABEL \}/);
  const apply = src.slice(src.indexOf("  _applyStillModel() {"), src.indexOf("  _loraModel() {"));
  assert.ok(apply.indexOf("this._syncDepthLock()") < apply.indexOf("this._fillLoras()"), "after the lock picks the model the frame node paints with");
  assert.match(src, /f\.lora = h\("select", \{ on: \{ change: \(\) => \{ this\.set\(9081, "lora", f\.lora\.value\); this\._loraNote\(\); \} \} \}\)/);
  const fill = src.slice(src.indexOf("  _fillLoras() {"), src.indexOf("  _loraNote() {"));
  assert.match(fill, /f\.lora\.disabled = !loraW \|\| !model;/, "disabled only without the slot, or on Krea 2 + depth (no LoRA in that graph)");
  assert.match(src, /_loraModel\(\) \{\n    if \(this\.f\?\.model\?\.value === STILL_KREA\) return null;\n    return this\.w\(9081, "model"\)\?\.value/);
});

test("⑤ Motion's Extra LoRA: every LoRA, LTX ones first; the shot's pick stays listed; no slot says so", () => {
  const g = ltxLoraGroups(POD);
  assert.deepEqual(g.match, ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"]);
  assert.equal(g.other.length, 8);
  assert.ok(ltxLoraGroups(POD, "old/gone_ltx.safetensors").match.includes("old/gone_ltx.safetensors"));
  assert.deepEqual(ltxLoraGroups([]), { match: [], other: [] });
  const src = web("motion/ltxadvanced.mjs");
  const fn = src.slice(src.indexOf("  _loraOptions(current = null) {"), src.indexOf("  refresh() {"));
  assert.match(fn, /this\.pipe\.w\(9101, "lora_name"\)/);
  assert.doesNotMatch(fn, /options\.length > 1\) return/, "refilled when the list or the pick changes, not only once");
  assert.match(fn, /f\.lora\.disabled = !w;/);
  assert.match(fn, /no Extra LoRA slot: open Soundstage_App_Full/);
  assert.match(src, /this\._loraOptions\(s\.extra_lora\?\.name \|\| null\);/);
  assert.match(src, /extra_lora: f\.lora\.value === "None" \? null : \{ name: f\.lora\.value, strength:/, "a pick reaches the shot's settings (→ Quality → node 9101)");
});

test("the full App wires the Extra LoRA slot between the LTX model and both samplers", () => {
  const wf = JSON.parse(readFileSync(new URL("../../example_workflows/Soundstage_App_Full.json", import.meta.url), "utf8"));
  const n = wf.nodes.find((x) => x.id === 9101);
  assert.equal(n.type, "SoundstageLTXLoRA");
  const links = new Map(wf.links.map((l) => [l[0], l]));
  const from = (name) => wf.nodes.find((x) => x.id === links.get(n.inputs.find((i) => i.name === name).link)[1]);
  assert.equal(from("settings_json").type, "SoundstageQuality", "the shot's extra_lora comes in with the settings");
  assert.ok((n.outputs[0].links || []).length >= 2, "both stages use the LoRA'd model");
});
