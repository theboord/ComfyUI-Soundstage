// The ⑤ Motion quality reaches Ripple, one-click and take-check estimates. The Draft/Final buttons
// (pipeline.m.quality) were replaced by the LTX presets (pipeline.ltx); these readers kept reading the
// old field, which nothing writes any more, so a Draft shot rippled as Final and one-click always ran Draft.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPreset, finalRung } from "../../web/takecheck/model.mjs";

const pipe = (preset) => ({ m: {}, ltx: { settings: () => ({ preset }) } });

test("renderPreset reads the shot's LTX preset, not the retired m.quality", () => {
  assert.equal(renderPreset(pipe("Draft")), "Draft");
  assert.equal(renderPreset(pipe("Hollywood")), "Hollywood");
  assert.equal(renderPreset({ m: { quality: "Draft" } }), "Draft");     // an older pipeline still works
  assert.equal(renderPreset(null), "Final");
  assert.equal(finalRung(renderPreset(pipe("Hollywood"))), "final_hq");
  assert.equal(finalRung(renderPreset(pipe("Final"))), "final");
});

test("no reader is left on pipeline.m.quality", async () => {
  const fs = await import("node:fs");
  for (const f of ["web/oneclick/oneclick.mjs", "web/motion/ripple.mjs", "web/takecheck/takecheck.mjs"]) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    assert.ok(!/\bm\??\.quality\b/.test(src), `${f} still reads m.quality`);
  }
});
