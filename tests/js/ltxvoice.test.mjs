import test from "node:test";
import assert from "node:assert/strict";
import { ltxSpokenLine, speakerFor } from "../../web/pipeline/pipeline.mjs";

test("the line goes into the LTX prompt as dialogue, before the closing layout lock", () => {
  const p = "Exterior medium shot in a park. Light rain. The layout, object placement, scale and camera motion match the reference exactly.";
  const out = ltxSpokenLine(p, "The woman", "“I'm not letting you go.”");
  assert.match(out, /The woman says: "I'm not letting you go\." Lips move with every word/);
  assert.ok(out.endsWith("match the reference exactly."));
  assert.ok(out.indexOf("says:") < out.indexOf("The layout, object placement"));
});

test("no line leaves the prompt alone; no prompt still carries the line", () => {
  assert.equal(ltxSpokenLine("A park.", "The man", "  "), "A park.");
  assert.equal(ltxSpokenLine("", "The man", "Hi there."), 'The man says: "Hi there." Lips move with every word, in sync with the voice.');
});

test("the speaker is the woman when there is one, else the first person", () => {
  assert.equal(speakerFor({ actors: [{ kind: "man" }, { kind: "woman" }] }), "The woman");
  assert.equal(speakerFor({ actors: [{ kind: "horse" }, { kind: "man" }] }), "The man");
  assert.equal(speakerFor({ actors: [] }), "The actor");
});
