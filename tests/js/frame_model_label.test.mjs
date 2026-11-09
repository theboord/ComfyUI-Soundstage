// ④ Frame names the frame node's model without "+ Identity Edit" (only Paint Studio loads that LoRA), and says plainly
// that Krea 2 + depth (the App's own KSampler 9056) gets no cast pictures and no cast pass (Maya, 2026-11-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frameModelLabel, samplingNote, KREA_DEPTH_CAST_NOTE } from "../../web/pipeline/pipeline.mjs";

const TURBO_EDIT = "Krea 2 Turbo + Identity Edit · local [<$1M]";

test("the frame model's name drops the Identity Edit LoRA ④ Frame never loads", () => {
  assert.equal(frameModelLabel(TURBO_EDIT), "Krea 2 Turbo");
  assert.equal(frameModelLabel("Krea 2 Turbo · local [<$1M]"), "Krea 2 Turbo");
  assert.equal(frameModelLabel("FLUX 3 Klein · local [<$5M]"), "FLUX 3 Klein");
  assert.equal(frameModelLabel(""), "");
  assert.ok(!samplingNote(TURBO_EDIT, 12, 1).includes("Identity Edit"), samplingNote(TURBO_EDIT, 12, 1));
});

test("④ Frame's candidate caption and sampling label go through frameModelLabel", () => {
  const src = readFileSync(new URL("../../web/pipeline/pipeline.mjs", import.meta.url), "utf8");
  assert.ok(src.includes(`"Krea 2" : frameModelLabel(c.model)`), "candidate caption");
  assert.ok(!/String\(c\.model\)\.split\(" ·"\)\[0\]/.test(src), "no raw dropdown label on a candidate");
  assert.ok(src.includes("KREA_DEPTH_CAST_NOTE) : null"), "the cast card on Krea 2 + depth");
});

test("Krea 2 + depth says it gets no cast pictures and no cast pass", () => {
  assert.match(KREA_DEPTH_CAST_NOTE, /doesn't take the cast pictures/);
  assert.match(KREA_DEPTH_CAST_NOTE, /cast pass .* runs only after the frame node's models/);
});

test("the cast pass is wired only on the frame node (the router's edit stage), never after the KSampler path", () => {
  const router = readFileSync(new URL("../../soundstage/nodes_router.py", import.meta.url), "utf8");
  assert.ok(router.includes('if cls.STAGE == "edit_image" and p.get("cast_pass")'), "edit stage only");
});
