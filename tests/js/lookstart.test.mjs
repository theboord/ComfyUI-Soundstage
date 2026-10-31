import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOK_START, lookStartFor } from "../../web/pipeline/pipeline.mjs";

// Frame 1 reaches the image model with softened clay heads (soundstage/look/look_start.py). A frame picked before
// that existed must re-render from the plain colour pass, so its video starts from exactly the picked frame.
test("new frames and shots without a pick use the prepared start image", () => {
  assert.equal(lookStartFor(undefined), true);
  assert.equal(lookStartFor(null), true);
  assert.equal(lookStartFor({ seed: 5, model: "FLUX 3 Klein · local [<$5M]", ls: LOOK_START }), true);
});

test("a frame picked before the prepared start image reproduces from the plain colour pass", () => {
  assert.equal(lookStartFor({ seed: 559688375, model: "FLUX 3 Klein · local [<$5M]" }), false);
  assert.equal(lookStartFor({ seed: 1, ls: 0 }), false);
});

test("a painted frame or one without a seed never depends on the start image", () => {
  assert.equal(lookStartFor({ edited: { filename: "x.png" }, seed: 3 }), true);
  assert.equal(lookStartFor({ url: "/api/view?x" }), true);
});
