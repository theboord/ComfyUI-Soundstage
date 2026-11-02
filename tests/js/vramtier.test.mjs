// node --test tests/js/vramtier.test.mjs   (VRAM tiers: the App's switch, the setup check text, ⑤ Motion's summary)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TIERS, TIER_NAMES, TESTED, detect, normalize, tierLabel, capSettings, reportLines, shouldFree, installFreeAfterRender,
  vramSetting, remember,
} from "../../web/ui/vramtier.mjs";
import { resolveSettings, stageSizes, vramSummary } from "../../web/motion/ltxadvanced.mjs";

const JSON_TIERS = JSON.parse(readFileSync(new URL("../../web/ui/vram_tiers.json", import.meta.url), "utf8"));

test("the JS tier table is the JSON table Python reads (one source of truth)", () => {
  assert.deepEqual(TIERS, JSON_TIERS.tiers);
  assert.deepEqual(TESTED, JSON_TIERS.tested);
  assert.deepEqual([...TIER_NAMES].sort(), ["Auto", ...Object.keys(JSON_TIERS.tiers)].sort());   // numeric keys reorder in JS
});

test("Auto reads the card like the server does; labels say tested or untested", () => {
  assert.deepEqual([null, 8, 12, 16, 24, 48, 80].map(detect), ["12", "12", "12", "16", "24", "48", "48"]);
  assert.deepEqual(["16 GB", "24gb", "x", undefined, "48"].map(normalize), ["16", "24", "Auto", "Auto", "48"]);
  assert.equal(tierLabel("48"), "48 GB (tested)");
  assert.equal(tierLabel("16"), "16 GB (untested)");
});

test("⑤ Motion: Hollywood per tier, the same sizes the Python cap gives (tests/test_vram_tiers.py)", () => {
  const hw = resolveSettings({ preset: "Hollywood" });
  const out = (t) => stageSizes(1920, 1080, capSettings(hw, t).s);
  assert.equal(out("48").output[1], 1408);
  assert.ok(out("24").stage1[1] <= 544 && out("24").output[1] <= 1088);
  assert.ok(out("16").stage1[1] <= 352);
  const twelve = capSettings(hw, "12");
  assert.equal(twelve.s.two_stage, false);
  assert.ok(stageSizes(1920, 1080, twelve.s).output[1] <= 512);
  assert.match(twelve.note, /refine off/);
  assert.equal(capSettings(hw, "48").note, "");
  assert.equal(capSettings(resolveSettings({ preset: "Final" }), "24").note, "");   // Final already fits 24's cap
  const d = capSettings(resolveSettings({ preset: "Final" }), "16").s.decode;
  assert.ok(d.tile_size <= 256 && d.temporal_overlap < d.temporal_size);
});

test("the summary shows the capped size, the reason, and does not claim the 48 GB time for a smaller card", () => {
  const hw = resolveSettings({ preset: "Hollywood" });
  assert.match(vramSummary(hw, 1920, 1080, 121, 24, null), /2496×1408.*on this GPU\.$/);
  const s16 = vramSummary(hw, 1920, 1080, 121, 24, "16");
  assert.match(s16, /1216×704/);
  assert.match(s16, /on the 48 GB card \(slower on this one, not measured\)/);
  assert.match(s16, /untested/);
});

test("the setup check reads as plain lines with flags and the exact smaller files", () => {
  const rep = { setting: "Auto", tier: "16", tested: false, gpu: { name: "RTX 4070 Ti SUPER", total_gb: 16 },
    features: [{ feature: "MiniMax H3", words: "does not fit" }], launch_flags: ["--reserve-vram 0.4"],
    missing_smaller: [{ folder: "diffusion_models", file: "ltx-2.5-22b-distilled-transformer-w4a8_convrot.safetensors", gb: 12.5, repo: "Winnougan/x" }],
    free_between: true };
  const lines = reportLines(rep);
  assert.equal(lines[0], "RTX 4070 Ti SUPER: 16 GB. VRAM tier: Auto → 16 GB (untested).");
  assert.ok(lines.includes("MiniMax H3: does not fit"));
  assert.ok(lines.includes("Start ComfyUI with: --reserve-vram 0.4"));
  assert.ok(lines.some((l) => l.includes("not downloaded for you") && l.includes("diffusion_models/ltx-2.5-22b-distilled-transformer-w4a8_convrot.safetensors (12.5 GB)")));
  assert.match(reportLines({ ...rep, gpu: { total_gb: null }, warning: "No CUDA GPU" })[0], /^No CUDA GPU found/);
  assert.equal(shouldFree(rep), true);
  assert.equal(shouldFree({ free_between: false }), false);
  assert.equal(shouldFree(null), false);
});

test("models are unloaded after each finished prompt only when the tier says so", async () => {
  const calls = [], handlers = {};
  const api = { addEventListener: (ev, f) => { handlers[ev] = f; }, fetchApi: (url, o) => { calls.push([url, JSON.parse(o.body)]); return Promise.resolve({}); } };
  assert.equal(installFreeAfterRender(api), true);
  assert.equal(installFreeAfterRender(api), false);   // once
  remember({ tier: "48", free_between: false });
  handlers.execution_success();
  assert.equal(calls.length, 0);
  remember({ tier: "16", free_between: true });
  handlers.execution_success();
  assert.deepEqual(calls, [["/free", { unload_models: true, free_memory: true }]]);
  remember(null);
});

test("the ComfyUI setting offers every tier, defaults to Auto, and saves through the server", async () => {
  const posted = [];
  const api = { fetchApi: async (url, o) => {
    if (o?.method === "POST") posted.push(JSON.parse(o.body));
    return { ok: true, json: async () => ({ setting: "16", tier: "16", tested: false, gpu: { total_gb: 16 }, features: [], free_between: true }) };
  } };
  const s = vramSetting(api);
  assert.equal(s.type, "combo");
  assert.equal(s.defaultValue, "Auto");
  assert.deepEqual(s.options.map((o) => o.value), TIER_NAMES);
  await s.onChange("16", undefined);        // page load: no save
  assert.deepEqual(posted, []);
  await s.onChange("16", "Auto");           // the user picked it (no document here: no notice drawn)
  assert.deepEqual(posted, [{ tier: "16" }]);
  assert.equal(globalThis.__ssVram.tier, "16");
  remember(null);
});
