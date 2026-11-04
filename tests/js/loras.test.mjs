// node --test tests/js/loras.test.mjs
// A stack of LoRAs, any LoRA (QA 2026-11-04): each row of ④ Frame's "Style or character add-on" stack lists every LoRA in models/loras,
// the ones made for the frame model first ("Matches this model"), the rest under "Other LoRAs (may not work with this
// model)" with a warning, never a block. ⑤ Motion's Extra LoRA lists them all too, LTX ones first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loraFamily, frameModelFamily, stillLoraGroups, stillLoraWarning, ltxLoraGroups, ltxLoraWarning, normalizeStack, stackFromLegacy, LORA_MATCH_LABEL, LORA_OTHER_LABEL } from "../../web/pipeline/loras.mjs";
import { LtxStore, resolveSettings, adherenceKnobs } from "../../web/motion/ltxadvanced.mjs";
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

test("④ Frame: a stack of rows, groups per row for the frame model, refilled when the model or the lock changes, never blocked", () => {
  const src = web("pipeline/pipeline.mjs");
  assert.equal(LORA_MATCH_LABEL, "Matches this model");
  assert.equal(LORA_OTHER_LABEL, "Other LoRAs (may not work with this model)");
  assert.match(src, /f\.loras = createLoraStack\(\{ h, min: 0, max: 1\.5, fallback: 1, matchLabel: LORA_MATCH_LABEL, otherLabel: LORA_OTHER_LABEL,/);
  assert.match(src, /groups: \(cur\) => stillLoraGroups\(this\.w\(9081, "lora"\)\?\.options\?\.values \|\| \[\], this\._loraModel\(\), cur\)/);
  const apply = src.slice(src.indexOf("  _applyStillModel() {"), src.indexOf("  _loraModel() {"));
  assert.ok(apply.indexOf("this._syncDepthLock()") < apply.indexOf("this._fillLoras()"), "after the lock picks the model the frame node paints with");
  const fill = src.slice(src.indexOf("  _fillLoras() {"), src.indexOf("  _readLoras() {"));
  assert.match(fill, /f\.loras\.setDisabled\(!loraW \|\| !model,/, "disabled only without the slot, or on Krea 2 + depth (no LoRA in that graph)");
  assert.match(src, /_loraModel\(\) \{\n    if \(this\.f\?\.model\?\.value === STILL_KREA\) return null;\n    return this\.w\(9081, "model"\)\?\.value/);
  // saved on the frame node as JSON; the old single pair is cleared so nothing applies twice, and loads as a one-row stack
  assert.match(src, /this\.set\(9081, "loras", JSON\.stringify\(clean\)\);\n      this\.set\(9081, "lora", "None"\)/);
  assert.match(src, /return rows\.length \? rows : stackFromLegacy\(this\.w\(9081, "lora"\)\?\.value, this\.w\(9081, "lora_strength"\)\?\.value \?\? 1\);/);
});

test("the stack helpers: clean rows, the old single pick is one row, strengths clamp", () => {
  assert.deepEqual(normalizeStack([{ name: "a.safetensors", strength: 0.5 }, { name: "None" }, { name: "" }, { name: "b.safetensors" }, { name: "c.safetensors", strength: 99 }]),
    [{ name: "a.safetensors", strength: 0.5 }, { name: "b.safetensors", strength: 1 }, { name: "c.safetensors", strength: 4 }]);
  assert.deepEqual(normalizeStack({ name: "old.safetensors", strength: 0.6 }), [{ name: "old.safetensors", strength: 0.6 }]);
  assert.deepEqual(normalizeStack("x.safetensors"), [{ name: "x.safetensors", strength: 1 }]);
  assert.deepEqual(normalizeStack(null), []); assert.deepEqual(normalizeStack("None"), []);
  assert.deepEqual(stackFromLegacy("mara.safetensors", 0.7), [{ name: "mara.safetensors", strength: 0.7 }]);
  assert.deepEqual(stackFromLegacy("None", 1), []);
  assert.equal(normalizeStack(Array.from({ length: 20 }, (_, i) => ({ name: `l${i}.safetensors` }))).length, 8);
  assert.equal(ltxLoraWarning("ltx2.5/x-ltx.safetensors"), "");
  assert.match(ltxLoraWarning("dmd2_sdxl_4step_lora.safetensors"), /SDXL LoRA: it may not work with LTX video/);
  assert.match(ltxLoraWarning("mara_v3.safetensors"), /Not sure this LoRA was made for LTX video/);
});

test("⑤ Motion: every LoRA, LTX ones first; the shot's picks stay listed; no slot says so", () => {
  const g = ltxLoraGroups(POD);
  assert.deepEqual(g.match, ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"]);
  assert.equal(g.other.length, 8);
  assert.ok(ltxLoraGroups(POD, "old/gone_ltx.safetensors").match.includes("old/gone_ltx.safetensors"));
  assert.deepEqual(ltxLoraGroups([]), { match: [], other: [] });
  const src = web("motion/ltxadvanced.mjs");
  assert.match(src, /f\.loras = createLoraStack\(\{ h, min: -2, max: 2, fallback: 0\.8, matchLabel: "LTX LoRAs"/);
  assert.match(src, /this\.pipe\.w\(9101, "lora_name"\)/);
  assert.match(src, /This workflow has no LoRA slot: open Soundstage_App_Full/);
  assert.match(src, /onChange: \(rows\) => this\.patch\(\{ loras: rows\.length \? rows : null \}\)/, "a change reaches the shot's settings (→ Quality → node 9101)");
});

test("⑤ Motion: the stack is saved per shot in ss_ltx; an old single extra_lora loads as a one-row stack; the IC-LoRA stays separate", () => {
  const rows = [{ name: "ltx/a.safetensors", strength: 0.7 }, { name: "ltx/b.safetensors", strength: -0.5 }];
  const saves = [];
  const st = new LtxStore({}, (v) => saves.push(structuredClone(v)));
  st.patch("s1", { loras: rows });
  assert.deepEqual(st.saved("s1"), { preset: "Final", loras: rows }, "a LoRA never moves a shot off its preset");
  assert.deepEqual(new LtxStore(saves.at(-1)).settings("s1").loras, rows, "reloads from what was saved, in order");
  // an old save
  const old = new LtxStore({ a: { preset: "Draft", extra_lora: { name: "ltx/style.safetensors", strength: 0.6 } } });
  assert.deepEqual(old.settings("a").loras, [{ name: "ltx/style.safetensors", strength: 0.6 }]);
  assert.equal("extra_lora" in old.settings("a"), false);
  old.patch("a", { seed: 4 });   // the next save writes the migrated form
  assert.deepEqual(old.saved("a"), { preset: "Draft", seed: 4, loras: [{ name: "ltx/style.safetensors", strength: 0.6 }] });
  // it reaches the graph JSON, a preset click keeps the stack, emptying it removes the key
  const w = [];
  st.writeGraph((id, k, v) => w.push([id, k, v]), "s1");
  assert.deepEqual(JSON.parse(w.find(([id, k]) => id === 9096 && k === "advanced")[2]).loras, rows);
  st.setPreset("s1", "Draft");
  assert.deepEqual(st.saved("s1").loras, rows);
  st.patch("s1", { loras: null });
  assert.equal("loras" in st.saved("s1"), false);
  // the Layout IC-LoRA is Adherence's, not the stack's
  assert.equal(adherenceKnobs(resolveSettings({ loras: rows })).ic_lora, 1);
});

test("the full App wires the LoRA stack slot between the LTX model and both samplers", () => {
  const wf = JSON.parse(readFileSync(new URL("../../example_workflows/Soundstage_App_Full.json", import.meta.url), "utf8"));
  const n = wf.nodes.find((x) => x.id === 9101);
  assert.equal(n.type, "SoundstageLTXLoRA");
  const links = new Map(wf.links.map((l) => [l[0], l]));
  const from = (name) => wf.nodes.find((x) => x.id === links.get(n.inputs.find((i) => i.name === name).link)[1]);
  assert.equal(from("settings_json").type, "SoundstageQuality", "the shot's extra_lora comes in with the settings");
  assert.ok((n.outputs[0].links || []).length >= 2, "both stages use the LoRA'd model");
});
