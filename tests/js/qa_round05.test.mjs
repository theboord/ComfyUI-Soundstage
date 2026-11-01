// QA round 05 regressions.
//
// Ready dot: in the full workspace the step pills had overflow:hidden with a 999px radius, and the Milestone 16 Ready dot
// sits on the pill's top-right corner (top/right -2px), so only a sliver of it showed: a stray backtick after every step
// name ("Cast`", "Set`"). The step name (.t) clips itself with an ellipsis, so the pill itself must not clip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const theme = readFileSync(new URL("../../web/ui/theme.mjs", import.meta.url), "utf8");
const canvasui = readFileSync(new URL("../../web/ui/canvasui.mjs", import.meta.url), "utf8");
const tc = readFileSync(new URL("../../web/takecheck/takecheck.mjs", import.meta.url), "utf8");
const rules = (css, sel) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].trim().split(/\s*,\s*/).some((s) => s.replace(/\s+/g, " ").trim() === sel)).map((m) => m[2]);

test("full-workspace step pills don't clip the Ready dot on their corner", () => {
  const pill = rules(theme, ".ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button");
  assert.ok(pill.length >= 1, "the wide step-pill rules are still there");
  for (const body of pill) assert.doesNotMatch(body, /overflow\s*:\s*hidden/, "a clipping pill cuts the corner dot to a sliver");
  for (const body of rules(canvasui, ".ss-stage.ss-cl[data-ws=wide] .ss-pipe button")) assert.doesNotMatch(body, /overflow\s*:\s*hidden/, "the wide canvas layout's pills must not clip it");
  assert.ok(rules(canvasui, ".ss-stage.ss-cl[data-ws=wide] .ss-pipe button").length >= 1);
  const top = rules(canvasui, ".ss-stage.ss-cl .ss-tabs.ss-toprow .ss-pipe button");
  assert.ok(top.length >= 1, "the canvas-layout top-row step rules are still there");
  for (const body of top) assert.doesNotMatch(body, /overflow\s*:\s*hidden/, "the top-row pill must not clip the corner dot either");
  assert.match(rules(canvasui, ".ss-stage.ss-cl .ss-tabs.ss-toprow .ss-pipe button .t").join(";"), /text-overflow\s*:\s*ellipsis/);
  const name = rules(theme, ".ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button .t").join(";");
  assert.match(name, /overflow\s*:\s*hidden/); assert.match(name, /text-overflow\s*:\s*ellipsis/); assert.match(name, /min-width\s*:\s*0/);
  const dot = rules(tc, ".ss-tc-ready").join(";");
  assert.match(dot, /top\s*:\s*-\d+px/, "the dot still sits on the corner (outside the pill's box), so the pill must not clip it");
});
