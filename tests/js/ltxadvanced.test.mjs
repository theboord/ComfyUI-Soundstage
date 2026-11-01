// node --test tests/js/   (⑤ Motion: Draft · Final · Hollywood presets and the Advanced (LTX) settings, Milestone 18)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRESETS, PRESET_NAMES, DEFAULT_PRESET, resolveSettings, compactSettings, stageSizes, estimateSeconds, fmtTime, summary, LtxStore,
} from "../../web/motion/ltxadvanced.mjs";

const JSON_PRESETS = JSON.parse(readFileSync(new URL("../../web/motion/ltx_presets.json", import.meta.url), "utf8")).presets;

test("the JS presets are the JSON presets Python reads (one source of truth)", () => {
  assert.deepEqual(PRESETS, JSON_PRESETS);
  assert.deepEqual(PRESET_NAMES, Object.keys(JSON_PRESETS));
});

test("a shot without settings renders Final, not Draft", () => {
  assert.equal(DEFAULT_PRESET, "Final");
  assert.equal(resolveSettings(undefined).preset, "Final");
  assert.equal(resolveSettings({ preset: "bogus" }).preset, "Final");
  assert.equal(resolveSettings({ preset: "Hollywood" }).steps_1, PRESETS.Hollywood.steps_1);
});

test("overrides are clamped and only the differences are saved", () => {
  const s = resolveSettings({ preset: "Draft", resolution: 1e6, steps_1: 1, cfg: 0, crf: -3, codec: "gif", sampler: "nope", seed: 9 });
  assert.deepEqual([s.resolution, s.steps_1, s.cfg, s.crf, s.codec, s.sampler, s.seed], [2176, 4, 1, 0, "h264", "euler_ancestral", 9]);
  assert.deepEqual(compactSettings({ preset: "Final" }), { preset: "Final" });
  assert.deepEqual(compactSettings({ preset: "Final", steps_1: 14, crf: PRESETS.Final.crf }), { preset: "Final", steps_1: 14 });
  assert.deepEqual(compactSettings({ preset: "Hollywood", codec: "prores_hq", decode: PRESETS.Final.decode }).codec, "prores_hq");
});

test("stage sizes: today's 1984x1088 final from the 960x512 clay; one pass renders full size", () => {
  assert.deepEqual(stageSizes(960, 512, resolveSettings({ preset: "Final" })), { stage1: [992, 544], output: [1984, 1088] });
  const one = stageSizes(960, 512, resolveSettings({ preset: "Final", two_stage: false }));
  assert.deepEqual(one.stage1, one.output);
  const hw = stageSizes(960, 512, resolveSettings({ preset: "Hollywood" }));
  assert.ok(hw.output.every((v) => v % 32 === 0) && hw.output[1] >= 1088);
});

test("time estimates order the presets and read as minutes", () => {
  const t = PRESET_NAMES.map((q) => estimateSeconds(resolveSettings({ preset: q }), 960, 512, 121));
  assert.ok(t[0] < t[1] && t[1] < t[2], t.join(" "));
  assert.match(fmtTime(45), /s$/);
  assert.match(fmtTime(400), /min$/);
  assert.match(summary(resolveSettings({ preset: "Final" }), 960, 512, 121), /1984×1088, 12 \+ 6 steps, 121 frames at 24 fps, H\.264 CRF/);
  assert.match(summary(resolveSettings({ preset: "Final", temporal_x2: true }), 960, 512, 121), /241 frames at 48 fps/);
});

test("per-shot store: each shot keeps its own preset and overrides, saved on every change", () => {
  const saves = [];
  const st = new LtxStore({ sh1: { preset: "Draft" } }, (v) => saves.push(structuredClone(v)));
  assert.equal(st.settings("sh1").preset, "Draft");
  assert.equal(st.settings("sh2").preset, "Final");
  st.patch("sh2", { steps_1: 16, seed: 1234 });
  st.setPreset("sh1", "Hollywood");
  assert.deepEqual(st.byShot.sh2, { preset: "Final", steps_1: 16, seed: 1234 });
  assert.deepEqual(st.byShot.sh1, { preset: "Hollywood" });
  st.setPreset("sh2", "Draft");                       // a preset click resets overrides but keeps the take (seed)
  assert.deepEqual(st.byShot.sh2, { preset: "Draft", seed: 1234 });
  assert.equal(saves.length, 3);
  assert.deepEqual(saves.at(-1), { sh1: { preset: "Hollywood" }, sh2: { preset: "Draft", seed: 1234 } });
  // and it reloads from what was saved
  const again = new LtxStore(saves.at(-1));
  assert.equal(again.settings("sh2").seed, 1234);
});

test("graph wiring: the shot's settings go to the Quality node and both samplers", () => {
  const st = new LtxStore({ a: { preset: "Hollywood", sampler: "euler", cfg: 1.5, codec: "prores_hq" } });
  const w = [];
  const s = st.writeGraph((id, k, v) => w.push([id, k, v]), "a");
  assert.equal(s.preset, "Hollywood");
  assert.deepEqual(w.map(([id, k]) => `${id}.${k}`), ["9096.quality", "9096.advanced", "5516.sampler_name", "9034.sampler_name"]);
  assert.equal(w[0][2], "Hollywood");
  assert.deepEqual(JSON.parse(w[1][2]), { preset: "Hollywood", sampler: "euler", cfg: 1.5, codec: "prores_hq" });
  assert.equal(w[2][2], "euler");
});

test("the App workflow exposes the Hollywood preset and the new nodes", () => {
  const wf = JSON.parse(readFileSync(new URL("../../example_workflows/Soundstage_App_Full.json", import.meta.url), "utf8"));
  const q = wf.nodes.find((n) => n.type === "SoundstageQuality");
  assert.equal(q.id, 9096);
  assert.deepEqual(q.widgets_values.slice(1), ["Final", JSON.stringify({ preset: "Final" })]);
  assert.ok(wf.nodes.some((n) => n.id === 9101 && n.type === "SoundstageLTXLoRA"));
  assert.ok(wf.nodes.filter((n) => (n.title || "").startsWith("Rung 4")).every((n) => n.type === "SoundstageSaveVideo"));
});
