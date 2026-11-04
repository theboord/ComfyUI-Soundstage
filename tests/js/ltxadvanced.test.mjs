// node --test tests/js/   (⑤ Motion: Draft · Final · Advanced presets and the Advanced (LTX) settings, Milestone 18)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRESETS, PRESET_NAMES, LEGACY_PRESETS, HERO, QUALITY_KEYS, SCHEDULERS, MIN_STEPS_1, DEFAULT_PRESET, resolveSettings, compactSettings, stageSizes,
  estimateSeconds, fmtTime, summary, LtxStore,
} from "../../web/motion/ltxadvanced.mjs";

const JSON_ALL = JSON.parse(readFileSync(new URL("../../web/motion/ltx_presets.json", import.meta.url), "utf8"));
const JSON_PRESETS = JSON_ALL.presets;
const web = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), "utf8");

test("the JS presets are the JSON presets Python reads (one source of truth): Draft · Final · Advanced", () => {
  assert.deepEqual(PRESETS, JSON_PRESETS);
  assert.deepEqual(PRESET_NAMES, Object.keys(JSON_PRESETS));
  assert.deepEqual(PRESET_NAMES, ["Draft", "Final", "Advanced"]);
  const { about, ...legacy } = JSON_ALL.legacy;
  assert.deepEqual(LEGACY_PRESETS, legacy);
  assert.ok(!("Hollywood" in PRESETS));
  // Advanced starts from Final's numbers
  const { label, tip, ...adv } = PRESETS.Advanced, { label: l2, tip: t2, ...fin } = PRESETS.Final;
  assert.deepEqual(adv, fin);
});

test("the quality segment is exactly three buttons: Draft · Final · Advanced, and Advanced opens the settings", () => {
  const src = web("motion/ltxadvanced.mjs");
  assert.match(src, /this\.seg = h\("span", \{ class: "seg row" \}, \.\.\.PRESET_NAMES\.map\(\(q\) => h\("button"/);
  assert.doesNotMatch(src, /Hollywood" \? "Hollywood"/);
  assert.match(src, /if \(q === "Advanced"\) this\.toggle\(true\);/);
  assert.match(src, /f\.sched = sel\(SCHEDULERS/);
  assert.match(src, /f\.shift = n\(0\.1, 10, 0\.05/);
  assert.match(src, /f\.s1 = n\(MIN_STEPS_1, 60, 1/);
  assert.match(src, /Reset to \$\{s\.from\}/);
  assert.doesNotMatch(web("pipeline/pipeline.mjs"), /Draft · Final · Hollywood/);
});

test("a shot without settings renders Final, not Draft", () => {
  assert.equal(DEFAULT_PRESET, "Final");
  assert.equal(resolveSettings(undefined).preset, "Final");
  assert.equal(resolveSettings({ preset: "bogus" }).preset, "Final");
  assert.equal(resolveSettings({ preset: "Advanced" }).steps_1, PRESETS.Final.steps_1);
});

test("a shot saved on the retired Hollywood preset loads as Advanced with its old numbers (1408p, 12 + 6, CRF 12)", () => {
  const h = resolveSettings({ preset: "Hollywood" });
  assert.equal(h.preset, "Advanced");
  assert.deepEqual([h.resolution, h.steps_1, h.steps_2, h.crf, h.from, h.label], [1408, 12, 6, 12, "Final", "Advanced"]);
  assert.equal(resolveSettings({ preset: "Hollywood", codec: "prores_hq", steps_1: 14 }).steps_1, 14);
  assert.deepEqual(compactSettings({ preset: "Hollywood" }), { preset: "Advanced", resolution: 1408, crf: 12 });
  assert.deepEqual(compactSettings({ preset: "Hollywood", codec: "prores_hq", decode: PRESETS.Final.decode }).codec, "prores_hq");
  const st = new LtxStore({ old: { preset: "Hollywood", seed: 3 } });
  assert.equal(st.settings("old").resolution, 1408);
  const w = [];
  const s = st.writeGraph((id, k, v) => w.push([id, k, v]), "old");
  assert.equal(s.preset, "Advanced");
  assert.equal(w[0][2], "Advanced", "the Quality combo never sees Hollywood again");
  assert.deepEqual(JSON.parse(w[1][2]), { preset: "Advanced", resolution: 1408, seed: 3, crf: 12 });
  assert.match(summary(h, 960, 512, 121), /^Advanced: 2624×1408, 12 \+ 6 steps/);
});

test("shift and scheduler: new keys, clamped, saved only when changed, and in the graph JSON", () => {
  const s = resolveSettings({ preset: "Advanced" });
  assert.equal(s.scheduler, "distilled"); assert.equal(s.shift, 1);
  assert.deepEqual(SCHEDULERS.map(([k]) => k), ["distilled", "linear", "linear_quadratic"]);
  assert.equal(resolveSettings({ scheduler: "bogus", shift: 0 }).scheduler, "distilled");
  assert.equal(resolveSettings({ shift: 0 }).shift, 1);
  assert.equal(resolveSettings({ shift: 99 }).shift, 10);
  assert.deepEqual(compactSettings({ preset: "Advanced", shift: 1, scheduler: "distilled" }), { preset: "Advanced" });
  const st = new LtxStore({ a: { preset: "Advanced", shift: 2, scheduler: "linear_quadratic", steps_1: 6 } });
  const w = [];
  st.writeGraph((id, k, v) => w.push([id, k, v]), "a");
  assert.deepEqual(JSON.parse(w[1][2]), { preset: "Advanced", steps_1: 6, scheduler: "linear_quadratic", shift: 2 });
  assert.equal(MIN_STEPS_1, 1);
  assert.equal(resolveSettings({ steps_1: 0 }).steps_1, 1);
  assert.ok(estimateSeconds(resolveSettings({ preset: "Advanced", steps_1: 4, steps_2: 1 }), 960, 512, 121) < estimateSeconds(resolveSettings({ preset: "Draft" }), 960, 512, 121));
});

test("editing a quality knob on Draft / Final makes the shot Advanced with its values carried over; Reset goes back", () => {
  const st = new LtxStore({ a: { preset: "Draft" } });
  st.patch("a", { steps_1: 6 });
  assert.deepEqual(st.saved("a"), { preset: "Advanced", steps_1: 6, steps_2: 3, crf: 18, from: "Draft" });   // only steps_1 changed from Draft
  assert.equal(st.settings("a").resolution, PRESETS.Draft.resolution);
  st.reset("a");
  assert.deepEqual(st.saved("a"), { preset: "Draft" });
  // the seed, Adherence and its knobs, and the LoRA are not quality: they never move a shot off its preset
  st.patch("a", { seed: 5 }); st.patch("a", { adherence: "Loose", reference: 0.8 });
  assert.equal(st.saved("a").preset, "Draft");
  assert.ok(!QUALITY_KEYS.includes("seed") && !QUALITY_KEYS.includes("adherence") && QUALITY_KEYS.includes("shift") && QUALITY_KEYS.includes("scheduler"));
  // patching a knob to the value it already has changes nothing
  st.patch("a", { steps_1: PRESETS.Draft.steps_1 });
  assert.equal(st.saved("a").preset, "Draft");
  // the Advanced button from Final: Final's numbers, remembers where it came from
  st.setPreset("a", "Final"); st.setPreset("a", "Advanced");
  assert.deepEqual(st.saved("a"), { preset: "Advanced", seed: 5, adherence: "Loose" });   // from Final = the default, not saved; a preset click drops the raw knobs
  assert.equal(st.settings("a").steps_1, PRESETS.Final.steps_1);
  st.patch("a", { shift: 1.5 }); st.reset("a");
  assert.equal(st.saved("a").preset, "Final");
  // the hero recipe (the old Hollywood numbers) is Advanced too
  st.setHero("a");
  assert.equal(st.saved("a").preset, "Advanced");
  assert.deepEqual([st.settings("a").resolution, st.settings("a").crf], [HERO.resolution, HERO.crf]);
});

test("overrides are clamped and only the differences are saved", () => {
  const s = resolveSettings({ preset: "Draft", resolution: 1e6, steps_1: 0, cfg: 0, crf: -3, codec: "gif", sampler: "nope", seed: 9 });
  assert.deepEqual([s.resolution, s.steps_1, s.cfg, s.crf, s.codec, s.sampler, s.seed], [2176, 1, 1, 0, "h264", "euler_ancestral", 9]);
  assert.deepEqual(compactSettings({ preset: "Final" }), { preset: "Final" });
  assert.deepEqual(compactSettings({ preset: "Final", steps_1: 14, crf: PRESETS.Final.crf }), { preset: "Final", steps_1: 14 });
  assert.deepEqual(compactSettings({ preset: "Advanced", codec: "prores_hq", decode: PRESETS.Final.decode }), { preset: "Advanced", codec: "prores_hq" });
});

test("stage sizes: today's 1984x1088 final from the 960x512 clay; one pass renders full size", () => {
  assert.deepEqual(stageSizes(960, 512, resolveSettings({ preset: "Final" })), { stage1: [992, 544], output: [1984, 1088] });
  const one = stageSizes(960, 512, resolveSettings({ preset: "Final", two_stage: false }));
  assert.deepEqual(one.stage1, one.output);
  const hw = stageSizes(960, 512, resolveSettings({ preset: "Advanced", resolution: 1408 }));
  assert.ok(hw.output.every((v) => v % 32 === 0) && hw.output[1] >= 1088);
});

test("time estimates order the presets and read as minutes", () => {
  const t = [{ preset: "Draft" }, { preset: "Final" }, { preset: "Advanced", resolution: 1408 }].map((q) => estimateSeconds(resolveSettings(q), 960, 512, 121));
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
  st.setPreset("sh1", "Advanced");
  assert.deepEqual(st.byShot.sh2, { preset: "Advanced", steps_1: 16, seed: 1234 });   // a changed knob = Advanced (from Final, the default, not saved)
  assert.deepEqual(st.byShot.sh1, { preset: "Advanced", from: "Draft" });
  st.setPreset("sh2", "Draft");                       // a preset click resets overrides but keeps the take (seed)
  assert.deepEqual(st.byShot.sh2, { preset: "Draft", seed: 1234 });
  assert.equal(saves.length, 3);
  assert.deepEqual(saves.at(-1), { sh1: { preset: "Advanced", from: "Draft" }, sh2: { preset: "Draft", seed: 1234 } });
  // and it reloads from what was saved
  const again = new LtxStore(saves.at(-1));
  assert.equal(again.settings("sh2").seed, 1234);
});

test("graph wiring: the shot's settings go to the Quality node and both samplers", () => {
  const st = new LtxStore({ a: { preset: "Advanced", sampler: "euler", cfg: 1.5, codec: "prores_hq" } });
  const w = [];
  const s = st.writeGraph((id, k, v) => w.push([id, k, v]), "a");
  assert.equal(s.preset, "Advanced");
  assert.deepEqual(w.map(([id, k]) => `${id}.${k}`), ["9096.quality", "9096.advanced", "5516.sampler_name", "9034.sampler_name"]);
  assert.equal(w[0][2], "Advanced");
  assert.deepEqual(JSON.parse(w[1][2]), { preset: "Advanced", sampler: "euler", cfg: 1.5, codec: "prores_hq" });
  assert.equal(w[2][2], "euler");
});

test("the App workflow starts on Final and has the LTX LoRA and Save Final nodes", () => {
  const wf = JSON.parse(readFileSync(new URL("../../example_workflows/Soundstage_App_Full.json", import.meta.url), "utf8"));
  const q = wf.nodes.find((n) => n.type === "SoundstageQuality");
  assert.equal(q.id, 9096);
  assert.deepEqual(q.widgets_values.slice(1), ["Final", JSON.stringify({ preset: "Final" })]);
  assert.ok(wf.nodes.some((n) => n.id === 9101 && n.type === "SoundstageLTXLoRA"));
  assert.ok(wf.nodes.filter((n) => (n.title || "").startsWith("Rung 4")).every((n) => n.type === "SoundstageSaveVideo"));
});

// ---------------------------------------------------------------- Adherence (share/Blocking_Adherence/REPORT.txt)
import { ADHERENCE, ADHERENCE_NAMES, adherenceKnobs } from "../../web/motion/ltxadvanced.mjs";

test("Adherence levels are the JSON ones Python reads, default Exact", () => {
  const J = JSON.parse(readFileSync(new URL("../../web/motion/ltx_presets.json", import.meta.url), "utf8")).adherence;
  assert.deepEqual(ADHERENCE.levels, J.levels);
  assert.equal(ADHERENCE.default, J.default);
  assert.equal(ADHERENCE.default, "Exact");
  assert.deepEqual(ADHERENCE_NAMES, Object.keys(J.levels));
  for (const p of PRESET_NAMES) assert.equal(resolveSettings({ preset: p }).adherence, "Exact");
  assert.equal(resolveSettings({ adherence: "Whatever" }).adherence, "Exact");
});

test("Adherence maps to the tested raw knobs; explicit values win and are clamped", () => {
  assert.deepEqual(adherenceKnobs(resolveSettings({})), { adherence: "Exact", motion_freedom: 0, ic_lora: 1, guide_blur: 0, reference: 0.5 });
  const loose = adherenceKnobs(resolveSettings({ adherence: "Loose" }));
  assert.deepEqual([loose.guide_blur, loose.ic_lora, loose.reference], [10, 0.825, 1]);
  const o = adherenceKnobs(resolveSettings({ adherence: "Balanced", ic_lora: 5, guide_blur: -2, reference: 0.7 }));
  assert.deepEqual([o.adherence, o.ic_lora, o.guide_blur, o.reference], ["Balanced", 2, 0, 0.7]);
  assert.equal(adherenceKnobs(resolveSettings({ adherence: "Exact", reference: "" })).reference, 0.5);   // empty field = auto
});

test("Adherence is saved per shot (only when not the default) and survives a preset click", () => {
  assert.deepEqual(compactSettings({ preset: "Final", adherence: "Exact" }), { preset: "Final" });
  assert.deepEqual(compactSettings({ preset: "Final", adherence: "Loose", reference: 0.8 }), { preset: "Final", adherence: "Loose", reference: 0.8 });
  const st = new LtxStore();
  st.patch("a", { adherence: "Balanced", seed: 7 });
  st.setPreset("a", "Draft");
  assert.deepEqual(st.saved("a"), { preset: "Draft", seed: 7, adherence: "Balanced" });
  const calls = [];
  st.writeGraph((id, k, v) => calls.push([id, k, v]), "a");
  assert.deepEqual(JSON.parse(calls.find(([id, k]) => id === 9096 && k === "advanced")[2]).adherence, "Balanced");
});
