// The realism judge's chips and the one automatic re-roll offer (web/takecheck/model.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { realismChip, rerollOffer } from "../../web/takecheck/model.mjs";

const FAIL = { verdict: "fail", score: 2, model: "qwen3vl_8b_fp8_scaled.safetensors", frames_judged: 6,
  defects: [{ label: "rear lights incoherent, f30–110", frames: [30, 50, 110], examples: ["tail lights not a matched pair"] },
    { label: "exhaust / diffuser melted, f30–90", frames: [30, 90] }], minor: [{ label: "wheels or arches wrong (minor)" }] };

test("a failed take is a red AI-slop chip naming its worst defect, and jumps to its first frame", () => {
  const c = realismChip(FAIL);
  assert.equal(c.tone, "bad");
  assert.equal(c.text, "✗ AI slop: rear lights incoherent, f30–110");
  assert.equal(c.start, 30);
  assert.match(c.title, /score 2\/10 \(qwen3vl_8b_fp8_scaled\.safetensors, 6 frames\)/);
  assert.match(c.title, /✗ exhaust \/ diffuser melted, f30–90/);
  assert.match(c.title, /· wheels or arches wrong \(minor\)/);
});

test("pass, pending, unavailable and nothing", () => {
  assert.deepEqual([realismChip({ verdict: "pass", score: 9.5 }).tone, realismChip({ verdict: "pass", score: 9.5 }).text], ["ok", "✓ real 9.5/10"]);
  assert.equal(realismChip({ pending: true }).text, "Realism: judging…");
  const u = realismChip({ verdict: "unavailable", error: "no vision model" });
  assert.equal(u.tone, "info");   // never green when nothing was judged
  assert.equal(u.title, "no vision model");
  assert.equal(realismChip(null), null);
});

test("one automatic re-roll offer per shot, only for failed Hollywood takes", () => {
  const offered = new Set();
  const take = { hollywood: true, realism: FAIL };
  assert.equal(rerollOffer(take, "s1", offered), true);
  offered.add("s1");
  assert.equal(rerollOffer(take, "s1", offered), false);          // the re-roll failed too: no second offer
  assert.equal(rerollOffer(take, "s2", offered), true);
  assert.equal(rerollOffer({ hollywood: false, realism: FAIL }, "s3", offered), false);
  assert.equal(rerollOffer({ hollywood: true, realism: { verdict: "pass" } }, "s3", offered), false);
  assert.equal(rerollOffer({ hollywood: true, error: "x" }, "s3", offered), false);
});
