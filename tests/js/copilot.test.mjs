// node --test tests/js/copilot.test.mjs
// ✦ Ask as a co-pilot (web/agent/copilot.mjs, knowledge.mjs, castops.mjs, playbook.mjs; docs/assistant.md). A fake App
// (stage, Director, ② Cast, ⑤ Motion quality) and stubbed language models: the knowledge pack is fresh and finds
// code-only controls, Mike's five example questions route, the cast tools gather / profile / update / undo, regenerate
// asks first and touches one card, a plan runs as an observe-and-decide loop with one Undo, Stop, self-check, re-ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScript } from "../../web/script/parse.mjs";
import { Copilot, validateCall, parseStep, route, COPILOT_SYSTEM, TOOLS, MAX_STEPS } from "../../web/agent/copilot.mjs";
import { loadKnowledge, SOUNDSTAGE_MAP } from "../../web/agent/knowledge.mjs";
import { gatherCharacter, profileCharacter } from "../../web/agent/castops.mjs";
import { build, OUT } from "../../tools/build_knowledge.mjs";

const SCRIPT = parseScript(readFileSync(new URL("./fixtures/script/copilot.fountain", import.meta.url), "utf8"), { format: "fountain", name: "copilot.fountain" });
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A fake App: what the co-pilot's host gets from soundstage.js, with a Director that snapshots for Undo. */
function fakeApp({ quality = null, failPreset = null } = {}) {
  const st = { shots: [{ id: "s1", name: "Master", camera_keys: [{ focal_mm: 35 }] }, { id: "s2", name: "Two" }, { id: "s3", name: "Close" }],
    active_shot: "s1", actors: [{ id: "reed", name: "Reed", kind: "man" }, { id: "mara", name: "Mara", kind: "woman" }], preset_log: [], selected: null, shot: { frames: 97, fps: 24 } };
  const undo = [];
  const stage = { state: st, toJSON: () => clone(st), select: (id) => { st.selected = id; } };
  const director = {
    calls: async (calls) => {
      undo.push(clone(st));
      for (const c of calls) {
        if (c.tool === "select_shot") st.active_shot = c.args.shot;
        if (c.tool === "preset") {
          if (c.args.preset === failPreset) { undo.pop(); return { ok: false, said: `${c.args.preset} failed: no car on the set.` }; }
          st.preset_log.push({ id: c.args.preset, shot: st.active_shot });
          if (c.args.preset === "squib_hit") st.actors.push({ id: "sq", name: "Squib", kind: "sfx_body_squib", sfx: { trigger: { type: "time", at: 1.2 } } });
        }
        if (c.tool === "lens") st.shots.find((s) => s.id === st.active_shot).camera_keys = [{ focal_mm: c.args.mm }];
      }
      return { ok: true, said: calls.map((c) => c.plan).join(" ") };
    },
    order: async (text) => { undo.push(clone(st)); st.actors.push({ id: `o${undo.length}`, name: text, kind: "prop" }); return { ok: true, said: `Planned and applied: ${text}.` }; },
    undo: () => { const s = undo.pop(); if (s) Object.assign(st, s); },
  };
  const cards = [{ key: "character:reed", kind: "character", name: "Reed", description: "" }, { key: "character:mara", kind: "character", name: "Mara", description: "" },
    { key: "location:warehouse", kind: "location", name: "INT. WAREHOUSE", description: "" }];
  const generated = [];
  const cast = { items: () => clone(cards), set: (key, patch) => Object.assign(cards.find((c) => c.key === key), patch), generate: async (key) => { generated.push(key); cards.find((c) => c.key === key).url = `/ref/${key}.png`; } };
  const q = { adherence: "Balanced", ic_lora: 0.92, follow_clay: 0.85, preset: "Final" };
  const qual = quality || { get: () => ({ ...q }), set: (p) => Object.assign(q, p) };
  const host = { script: () => SCRIPT, stage, director, cast, quality: qual, knowledge: loadKnowledge };
  return { host, st, cards, generated, q, undoDepth: () => undo.length };
}
/** A stubbed model: replies in order; records every prompt it saw. */
function stubLLM(replies) {
  const seen = [];
  const llm = async (system, prompt) => { seen.push({ system, prompt }); const r = replies.shift(); if (r instanceof Error) throw r; return typeof r === "string" ? r : JSON.stringify(r ?? { done: true, say: "Done." }); };
  return { llm, seen };
}

test("the knowledge pack is fresh: tools/build_knowledge.mjs output equals the committed files", () => {
  for (const [name, text] of Object.entries(build())) assert.ok(readFileSync(new URL(`file://${OUT}/${name}`), "utf8") === text, `web/agent/knowledge/${name} is stale: run node tools/build_knowledge.mjs`);
});

test("search_docs finds code-only controls and says where they live", async () => {
  const k = await loadKnowledge();
  for (const [q, where] of [["Stage-2 start", /⑤ Motion › Advanced \(LTX\)/], ["Clay guide blur", /⑤ Motion › Advanced \(LTX\)/], ["Breakable", /Physics/]]) {
    const top = k.search(q, 3)[0];
    assert.match(top.title, new RegExp(q, "i"), q);
    assert.match(top.where, where, q);
  }
  assert.ok(k.search("squib gunshot wound", 5).some((h) => h.kind === "preset" && /squib/i.test(h.title)), "the Squib hit preset");
  assert.ok(SOUNDSTAGE_MAP.length / 4 < 1500, "the map stays under ~1,500 tokens");
  for (const w of ["collaborative director", "ONE sharp creative question", "never claim an action"]) assert.ok(COPILOT_SYSTEM.includes(w), w);
});

test("tool calls are validated against their schemas", () => {
  assert.deepEqual(validateCall({ name: "set_quality", args: { adherence: "exact", ic_lora: "1" } }).call.args, { adherence: "Exact", ic_lora: 1 });
  assert.match(validateCall({ name: "set_quality", args: { ic_lora: 9 } }).error, /0-1.2/);
  assert.match(validateCall({ name: "launch_rocket", args: {} }).error, /unknown tool/);
  assert.match(validateCall({ name: "update_character", args: { name: "Reed" } }).error, /description.*required/);
  assert.equal(parseStep("Sure! I'll do that.").ok, false);
  assert.equal(parseStep('{"plan": [{"name": "camera", "args": {"move": "push in"}}]}').step.plan[0].args.move, "push_in");
});

// Mike's five questions: the stubbed model picks the tool, the App's tools do the work.
const FIVE = [
  ["the claymation won't lock into the final render", [{ call: { name: "troubleshoot", args: { symptom: "the claymation won't lock into the final render" } } }],
    (r) => { assert.equal(r.results[0].entry, "clay_not_followed"); assert.deepEqual(r.plan.steps[0], { name: "set_quality", args: { adherence: "Exact" }, say: r.plan.steps[0].say }); }],
  ["build the tall stranger from the script", [{ call: { name: "gather_character", args: { name: "the tall stranger" } } },
    { say: "That's Reed.", plan: [{ name: "profile_character", args: { name: "REED" } }, { name: "update_character", args: { name: "REED", description: "$profile" } }] }],
    (r) => { assert.equal(r.results[0].name, "REED"); assert.deepEqual(r.plan.steps.map((s) => s.name), ["profile_character", "update_character"]); }],
  ["I want a gunshot wound on Reed in shot 3", [{ call: { name: "plan_recipe", args: { intent: "I want a gunshot wound on Reed in shot 3" } } }],
    (r) => assert.deepEqual(r.plan.steps.map((s) => [s.name, Object.values(s.args)[0]]), [["select_shot", "3"], ["select_object", "REED"], ["apply_preset", "squib_hit"]])],
  ["how do I do a J-cut here", [{ call: { name: "plan_recipe", args: { intent: "J-cut" } } }],
    (r) => { assert.equal(r.results[0].recipes[0], "j_cut"); assert.ok(!r.plan); assert.ok(r.clicks.length >= 2, "click-steps: the Cut has no one-click split edit"); }],
  ["re-block this chase, add a crash, then cover it in three shots", [{ call: { name: "plan_recipe", args: { intent: "re-block this chase, add a crash, then cover it in three shots" } } }],
    (r) => assert.deepEqual(r.plan.steps.map((s) => s.name), ["stage_order", "apply_preset", "apply_preset", "add_shot", "add_shot", "add_shot"])],
];
test("the five example questions route correctly with a stubbed model", async () => {
  for (const [q, replies, check] of FIVE) {
    const app = fakeApp();
    const { llm } = stubLLM(replies);
    const cp = new Copilot({ ...app.host, llm });
    const r = await cp.turn(q);
    assert.equal(r.by, "model", q);
    check(r);
  }
});

test("the deterministic router takes the same five with no model", async () => {
  const want = { 0: "troubleshoot", 1: "build_character", 2: "plan_recipe", 3: "plan_recipe", 4: "plan_recipe" };
  for (const [i, [q]] of FIVE.entries()) {
    assert.equal(route(q, { script: SCRIPT }).via, want[i], q);
    const cp = new Copilot(fakeApp().host);
    const r = await cp.turn(q);
    assert.equal(r.by, "built-in", q);
    assert.ok(r.say, q);
  }
  const r = await new Copilot(fakeApp().host).turn("I want a gunshot wound on Reed in shot 3");
  assert.deepEqual(r.plan.steps.map((s) => s.name), ["select_shot", "select_object", "apply_preset"]);
});

test("characters: gather (fuzzy, cited), profile (built-in), update, Undo", async () => {
  const g = gatherCharacter(SCRIPT, "the tall stranger");
  assert.equal(g.name, "REED");
  assert.ok(g.action[0].where.startsWith("Sc 1"), "cited");
  assert.ok(g.others.some((c) => /huge/.test(c.text) && /MARA/.test(c.where)), "what others say");
  const p = await profileCharacter(g);
  assert.equal(p.by, "built-in");
  for (const w of ["40s", "burly", "shaved head", "scar", "leather apron"]) assert.ok(p.profile.description.includes(w), w);
  const app = fakeApp(), cp = new Copilot(app.host);
  const r = await cp.turn("build the tall stranger from the script");
  assert.ok((await cp.turn("lock it in")).approved);
  const x = await cp.execute();
  assert.match(app.cards[0].description, /burly/);
  assert.ok(x.verified.every((v) => v.ok), "the card reads back");
  assert.ok(r.say.includes("REED"));
  x.undo();
  assert.equal(app.cards[0].description, "", "one Undo puts the card back");
});

test("regenerate asks first and touches one card only", async () => {
  const app = fakeApp(), cp = new Copilot(app.host);
  const r = await cp.turn("regenerate Reed's picture");
  assert.match(r.question, /Regenerate Reed/);
  assert.deepEqual(app.generated, [], "nothing before the yes");
  await cp.turn("yes");
  assert.deepEqual(app.generated, ["character:reed"]);
  const all = await cp.turn("regenerate them all");
  assert.match(all.say, /one card at a time/);
  assert.deepEqual(app.generated, ["character:reed"]);
});

test("plan -> approve -> execute: progress per step, one Undo for the whole plan", async () => {
  const app = fakeApp(), cp = new Copilot(app.host);
  await cp.turn("I want a gunshot wound on Reed in shot 3");
  assert.equal(app.st.active_shot, "s1", "nothing changes before the yes");
  assert.ok((await cp.turn("lock it in")).approved);
  const steps = [];
  const x = await cp.execute({ onStep: (s) => steps.push(s.call.name) });
  assert.deepEqual(steps, ["select_shot", "select_object", "apply_preset"]);
  assert.equal(app.st.active_shot, "s3");
  assert.equal(app.st.selected, "reed");
  assert.ok(app.st.actors.some((a) => /squib/.test(a.kind)));
  assert.ok(x.verified.length >= 2 && x.verified.every((v) => v.ok), JSON.stringify(x.verified));
  x.undo();
  assert.equal(app.st.active_shot, "s1");
  assert.equal(app.st.selected, null);
  assert.ok(!app.st.actors.some((a) => /squib/.test(a.kind)));
  assert.equal(app.undoDepth(), 0);
});

test("agent loop: a 3-step goal runs on observations (the model sees each result before the next call)", async () => {
  const app = fakeApp();
  const { llm, seen } = stubLLM([
    { say: "Tighter and a slow push.", plan: [{ name: "select_shot", args: { shot: "3" } }, { name: "camera", args: { lens_mm: 85 } }, { name: "set_quality", args: { adherence: "Exact" } }] },
    { call: { name: "select_shot", args: { shot: "3" } } },
    { call: { name: "camera", args: { lens_mm: 85 } } },
    { call: { name: "get_shot", args: {} } },
    { call: { name: "set_quality", args: { adherence: "Exact" } } },
    { done: true, say: "Shot 3 is on an 85 mm, Adherence Exact." },
  ]);
  const cp = new Copilot({ ...app.host, llm });
  const r = await cp.turn("make shot 3 feel tighter and stick to the clay");
  assert.equal(r.plan.steps.length, 3);
  await cp.turn("go");
  const x = await cp.execute();
  assert.deepEqual(x.log.map((l) => l.call.name), ["select_shot", "camera", "get_shot", "set_quality"]);
  assert.match(seen[3].prompt, /OBSERVATIONS so far:\n1\. select_shot .*OK.*\n2\. camera .*OK/, "the model saw both results");
  assert.match(seen[4].prompt, /"lens_mm":85/, "and the get_shot read-back");
  assert.equal(app.q.adherence, "Exact");
  assert.equal(x.said, "Shot 3 is on an 85 mm, Adherence Exact.");
});

test("a failed tool: the model retries once differently; without a model it's reported honestly", async () => {
  const app = fakeApp({ failPreset: "car_explosion" });
  const { llm } = stubLLM([
    { plan: [{ name: "apply_preset", args: { name: "car_explosion" } }] },
    { call: { name: "apply_preset", args: { name: "car_explosion" } } },
    { call: { name: "apply_preset", args: { name: "building_blast" } } },
    { done: true, say: "No car on the set, so I blew the wall instead." },
  ]);
  const cp = new Copilot({ ...app.host, llm });
  await cp.turn("blow it up"); await cp.turn("yes");
  const x = await cp.execute();
  assert.deepEqual(x.log.map((l) => [l.call.args.name, l.result.ok]), [["car_explosion", false], ["building_blast", true]]);
  assert.deepEqual(x.failed, [], "the retry fixed it");
  const plain = new Copilot(fakeApp({ failPreset: "crate_crash" }).host);
  await plain.turn("add a crash"); await plain.turn("yes");
  const y = await plain.execute();
  assert.equal(y.log[0].result.ok, false);
  assert.match(y.said, /1 step failed: crate_crash failed: no car/);
  assert.ok(y.log.length === 2, "the rest of the plan still ran");
});

test("Stop mid-plan: no more steps; keep what's done or Undo it", async () => {
  const app = fakeApp(), cp = new Copilot(app.host);
  await cp.turn("re-block this chase, add a crash, then cover it in three shots");
  await cp.turn("lock it in");
  const x = await cp.execute({ onStep: ({ i }) => { if (i === 2) cp.stop(); } });
  assert.equal(x.stopped, true);
  assert.equal(x.log.length, 2);
  assert.match(x.said, /Stopped after 2 of 6/);
  assert.ok(x.canUndo());
  x.undo();
  assert.equal(app.undoDepth(), 0, "the partial plan rolled back");
});

test("self-check catches a setting that didn't stick", async () => {
  const sticky = { adherence: "Balanced" };
  const app = fakeApp({ quality: { get: () => ({ ...sticky }), set: () => {} } });   // ⑤ Motion ignores the change
  const cp = new Copilot(app.host);
  await cp.turn("the claymation won't lock into the final render");
  await cp.turn("lock it in");
  const x = await cp.execute();
  assert.ok(x.verified.some((v) => !v.ok && /adherence reads Balanced, not Exact/.test(v.said)));
  assert.match(x.said, /Self-check found a problem/);
});

test("invalid tool JSON: one re-ask, then the built-in router", async () => {
  const { llm, seen } = stubLLM(["I think you should set adherence", '{"call": {"name": "set_quality", "args": {"adherence": "max"}}}']);
  const cp = new Copilot({ ...fakeApp().host, llm });
  const r = await cp.turn("the claymation won't lock into the final render");
  assert.equal(seen.length, 2, "asked once more, no more");
  assert.match(seen[1].prompt, /not valid: no JSON object/);
  assert.equal(r.by, "built-in");
  assert.match(r.why, /twice/);
  assert.equal(r.results[0].entry, "clay_not_followed");
  const ok = stubLLM(["oops", '{"say": "Exact adherence.", "plan": [{"name": "set_quality", "args": {"adherence": "Exact"}}]}']);
  const r2 = await new Copilot({ ...fakeApp().host, llm: ok.llm }).turn("fix it");
  assert.equal(r2.by, "model");
  assert.equal(r2.reasked, true);
});

test("the agent never acts outside the approved plan, and stops at MAX_STEPS", async () => {
  const replies = [{ plan: [{ name: "get_settings", args: {} }] }, { call: { name: "set_quality", args: { adherence: "Loose" } } }];
  for (let i = 0; i < 30; i++) replies.push({ call: { name: "get_settings", args: {} } });
  const app = fakeApp();
  const cp = new Copilot({ ...app.host, llm: stubLLM(replies).llm });
  await cp.turn("look at the settings"); await cp.turn("yes");
  const x = await cp.execute();
  assert.equal(app.q.adherence, "Balanced", "not in the plan: refused");
  assert.match(x.log[0].result.said, /isn't in the plan/);
  assert.equal(x.log.length, MAX_STEPS);
  assert.ok(Object.values(TOOLS).every((t) => ["read", "act", "plan"].includes(t.kind)));
});
