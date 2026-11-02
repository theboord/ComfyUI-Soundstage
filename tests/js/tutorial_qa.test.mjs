// Tutorial QA fixes (2026-11-02): the first-run tour lets the demo click through, Esc closes the Book wherever focus is,
// ④ Frame lists only Klein LoRAs (no private folders), and Crate crash never makes a second "Crate 1".
import test from "node:test";
import assert from "node:assert/strict";
import { TOUR_STEPS, holeClipPath, inRect } from "../../web/ui/firstrun.mjs";
import { bookEscCloses } from "../../web/book/view.mjs";
import { stillLoras, FRAME_DESC_PLACEHOLDER } from "../../web/pipeline/pipeline.mjs";
import { uniqueNames } from "../../web/presets/engine.mjs";

test("the tour's first step is interactive, the rest stay modal", () => {
  assert.equal(TOUR_STEPS[0].id, "start");
  assert.equal(TOUR_STEPS[0].interactive, true);
  assert.ok(TOUR_STEPS.slice(1).every((s) => !s.interactive), "Generate frames etc. must not click through (GPU)");
});

test("holeClipPath cuts the spotlight out of the dim layer", () => {
  const r = { left: 100, top: 50, right: 300, bottom: 250, width: 200, height: 200 };
  const c = holeClipPath(r, 1440, 900);
  assert.match(c, /^polygon\(evenodd, 0px 0px, 1440px 0px, 1440px 900px, 0px 900px, 0px 0px, /);
  assert.match(c, /103px 53px, 297px 53px, 297px 247px, 103px 247px, 103px 53px\)$/);
  assert.equal(holeClipPath(null, 1440, 900), "");
  assert.equal(holeClipPath({ left: 0, top: 0, right: 4, bottom: 4, width: 4, height: 4 }, 100, 100), "");
  assert.ok(inRect(r, 200, 100));
  assert.ok(!inRect(r, 20, 100));
  assert.ok(!inRect(null, 1, 1));
});

test("Esc closes the open Book even when focus is outside it", () => {
  const inside = new Set();
  const book = { hidden: false, contains: (t) => inside.has(t) };
  const topBarBtn = { tagName: "BUTTON" };
  assert.equal(bookEscCloses({ key: "Escape", target: topBarBtn }, book), true);
  const field = { tagName: "TEXTAREA" };
  inside.add(field);
  assert.equal(bookEscCloses({ key: "Escape", target: field }, book), false, "typing in a Book field keeps Esc");
  assert.equal(bookEscCloses({ key: "Escape", target: { tagName: "INPUT" } }, book), true, "an input outside the Book does not block it");
  assert.equal(bookEscCloses({ key: "Enter", target: topBarBtn }, book), false);
  assert.equal(bookEscCloses({ key: "Escape", target: topBarBtn }, { ...book, hidden: true }), false);
});

test("④ Frame's add-on list keeps Klein LoRAs and hides the rest", () => {
  const pod = ["None", "Garage Force Lora_v1.safetensors", "Garage Force Lora_v1_000007500.safetensors", "Downloads/klein_style.safetensors",
    "VNCCS_PoseStudioKlein9b.safetensors", "dmd2_sdxl_4step_lora.safetensors", "ltx-2.5-spatial-upscaler.safetensors",
    "styles/flux2_noir.safetensors", "private/klein_mike.safetensors", "Flux3-film-grain.safetensors"];
  assert.deepEqual(stillLoras(pod), ["None", "VNCCS_PoseStudioKlein9b.safetensors", "styles/flux2_noir.safetensors", "Flux3-film-grain.safetensors"]);
  assert.ok(stillLoras(pod, "dmd2_sdxl_4step_lora.safetensors").includes("dmd2_sdxl_4step_lora.safetensors"), "the chosen one stays");
  assert.deepEqual(stillLoras([]), ["None"]);
});

test("Crate crash names skip the crates already on set", () => {
  assert.deepEqual(uniqueNames("Crate", 3, ["Crate 1", "crate 3", "Mara"]), ["Crate 2", "Crate 4", "Crate 5"]);
  assert.deepEqual(uniqueNames("Crate", 2), ["Crate 1", "Crate 2"]);
});

test("④'s look box placeholder is optional and scene-neutral", () => {
  assert.match(FRAME_DESC_PLACEHOLDER, /^Optional/);
  assert.doesNotMatch(FRAME_DESC_PLACEHOLDER, /saddle|golden hour/i);
});
