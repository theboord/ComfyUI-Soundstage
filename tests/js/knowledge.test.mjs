// node --test tests/js/knowledge.test.mjs
// ✦ Ask's knowledge of Soundstage (web/agent/knowledge.mjs): the pack built from the repo (docs + every labelled
// control, preset, setting, shortcut and route), search_docs, the troubleshooting playbook, the creative recipes, the
// filmmaker persona, and the no-model fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "../../tools/build_knowledge.mjs";
import { searchDocs, troubleshoot, planRecipe, SOUNDSTAGE_MAP, PLAYBOOK, RECIPES } from "../../web/agent/knowledge.mjs";
import { Conversation, ASSISTANT_SYSTEM, TOOL_NAMES } from "../../web/agent/assistant.mjs";

test("the shipped knowledge pack is fresh (rebuilding it changes nothing)", async () => {
  const shipped = readFileSync(new URL("../../web/agent/knowledge_index.mjs", import.meta.url), "utf8");
  assert.ok(shipped === await build(), "stale: run node tools/build_knowledge.mjs");
});

test("search_docs finds the right section for sample questions", async () => {
  const cases = [
    ["claymation not locking into the final", /quality\.md|TUTORIAL\.md|Adherence|Motion/],
    ["how do I export an EDL for Premiere", /cut|EDL|source_fidelity|decisions/i],
    ["collect project zip", /project/i],
    ["phone viewfinder walk the room", /vcam|Virtual camera/i],
    ["how do squib rigs work", /sfx|Squib/i],
  ];
  for (const [q, want] of cases) {
    const r = await searchDocs(q);
    assert.ok(r.hits.some((h) => want.test(`${h.where} ${h.control}`)), `${q}: ${r.hits.map((h) => h.where).join(" | ")}`);
  }
});

test("search_docs finds controls that exist only in the code", async () => {
  for (const [q, where] of [["Stage-2 start", /Advanced \(LTX\)/], ["Stage guide blur", /Advanced \(LTX\)/], ["Breakable", /Physics/], ["Walk AR", /Virtual camera/]]) {
    const top = (await searchDocs(q)).hits[0];
    assert.equal(top.kind, "control", q);
    assert.match(top.where, where, q);
    assert.match(top.control, new RegExp(q.split(" ")[0]), q);
  }
  const keys = await searchDocs("undo shortcut");
  assert.ok(keys.hits.some((h) => h.kind === "key" && /Z/.test(h.shortcut)));
  const route = await searchDocs("video2stage regenerate route");
  assert.ok(route.hits.some((h) => h.kind === "route"));
});

test("troubleshoot: the clay-lock symptom gets Adherence Exact and the Layout IC-LoRA", () => {
  const r = troubleshoot("I'm having trouble getting the claymation to lock into the final render");
  assert.equal(r.entries[0].id, "clay_not_followed");
  const fix = r.entries[0].fix.join(" ");
  assert.match(fix, /Adherence → Exact/); assert.match(fix, /Layout IC-LoRA/); assert.match(fix, /Follow the clay/); assert.match(fix, /Coach/);
  assert.equal(troubleshoot("lip sync is off on the close-up").entries[0].id, "lipsync");
  assert.equal(troubleshoot("the camera clips through the wall").entries[0].id, "camera_clip");
});

test("the playbook and recipes name controls and presets that exist", async () => {
  const presets = JSON.parse(readFileSync(new URL("../../web/presets/presets.json", import.meta.url), "utf8")).presets.map((p) => p.id);
  for (const r of RECIPES) if (r.preset) assert.ok(presets.includes(r.preset), `${r.id}: preset ${r.preset}`);
  // Lifelike-only L2 renamed these UI labels; the playbook (web/agent/knowledge.mjs, the Ask lane) switches to the new
  // names in its own commit (the label table). Until then a playbook control under its old name must exist under the new.
  const RENAMED = { "Clay guide blur (px)": "Stage guide blur (px)", "Follow the clay": "Follow the blocking" };
  for (const p of PLAYBOOK) for (const c0 of p.controls || []) {
    const c = RENAMED[c0] || c0;
    assert.ok((await searchDocs(c)).hits.some((h) => h.kind !== "doc" && h.control.includes(c)), `${p.id}: ${c}`);
  }
});

test("plan_recipe: a gunshot wound is the squib rig, with Do it for me", () => {
  const r = planRecipe("gunshot wound");
  assert.equal(r.recipe, "squib"); assert.ok(r.automated);
  assert.match(r.steps.join(" "), /Squib hit/);
  assert.equal(r.actions[0].preset, "squib_hit");
  assert.equal(planRecipe("a J-turn in the car park").recipe, "jturn");
  assert.equal(planRecipe("dissolve between the scenes").automated, false, "click-steps only");
});

test("the persona and the map are in the system prompt, the map under its cap", () => {
  assert.match(ASSISTANT_SYSTEM, /collaborative director, DP and editor/);
  assert.match(ASSISTANT_SYSTEM, /ONE sharp creative question/);
  assert.match(ASSISTANT_SYSTEM, /honest about limits/);
  assert.ok(ASSISTANT_SYSTEM.includes(SOUNDSTAGE_MAP));
  assert.ok(SOUNDSTAGE_MAP.length / 4 < 1500, `map ~${Math.round(SOUNDSTAGE_MAP.length / 4)} tokens`);
  for (const t of ["search_docs", "troubleshoot", "plan_recipe"]) { assert.ok(TOOL_NAMES.includes(t)); assert.match(ASSISTANT_SYSTEM, new RegExp(`- ${t} `)); }
});

test("no model: the built-in fallback troubleshoots and plans; with the model, it answers from what was found", async () => {
  const c = new Conversation({});
  const t1 = await c.turn("I'm having trouble getting the claymation to lock into the final render", { question: false });
  assert.equal(t1.by, "built-in"); assert.equal(t1.results[0].tool, "troubleshoot");
  const t2 = await c.turn("I want a gunshot wound on the deputy");
  assert.equal(t2.results[0].tool, "plan_recipe");
  assert.equal(await c.turn("what's the weather like", { question: true }), null, "nothing matches: the recipes / docs fallback in ask.mjs");
  const calls = [];
  const m = new Conversation({ llm: async (sys, prompt) => { calls.push({ sys, prompt });
    return calls.length === 1 ? JSON.stringify({ reply: "Let me look.", tools: [{ name: "search_docs", args: { query: "Stage-2 start" } }, { name: "troubleshoot", args: { symptom: "clay not followed in the final" } }] })
      : "⑤ Motion → Adherence → Exact; Advanced (LTX) → Stage-2 start."; } });
  const t3 = await m.turn("the clay isn't followed, what's Stage-2 start?");
  assert.equal(t3.by, "model");
  assert.deepEqual(t3.results.map((r) => r.tool), ["search_docs", "troubleshoot"]);
  assert.match(calls[1].prompt, /Advanced \(LTX\) → Stage-2 start/, "the model answers from the retrieved chunks");
  assert.match(t3.reply, /Adherence → Exact/);
});
