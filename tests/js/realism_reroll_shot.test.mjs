// The realism judge takes about a minute. judge() used to read the active shot only after it answered, and
// "Re-roll once" re-renders whatever shot is active: switch to shot B while shot A's Hollywood take is judged, and B
// got the new seed while A was never re-rolled (and the one-offer guard was spent on B). Source-level guard: there is
// no DOM harness for attachTakeChecks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/takecheck/takecheck.mjs", import.meta.url), "utf8");
const judge = src.slice(src.indexOf("async function judge("), src.indexOf("if (ladder && !ladder._ssTakeChecks)"));

test("the judge pins the shot before it waits and re-checks it before offering and before re-rolling", () => {
  const pin = judge.indexOf("const sk0 = shotKey();"), wait = judge.indexOf("/soundstage/takecheck/realism");
  assert.ok(pin > 0 && pin < wait, "the shot is read before the judge request");
  assert.match(judge, /auto && rung === 4 && shotKey\(\) === sk && rerollOffer\(/);
  assert.match(judge, /if \(pick === 0 && shotKey\(\) === sk\) reroll\(4/);
});
