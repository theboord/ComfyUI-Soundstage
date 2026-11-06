// node --test tests/js/copilot.test.mjs
// ✦ Ask's co-pilot (web/agent/copilot.mjs, thingops.mjs; docs/assistant.md) on top of main's knowledge, playbook,
// recipes and character builder. A fake App (stage, Director, ② Cast panel, ⑤ Motion quality) and stubbed language
// models: strict schemas with one re-ask, the example questions turned into runnable plans, plan -> lock it in ->
// an observe-and-decide loop -> self-check -> one Undo, retries, Stop, MAX_STEPS, locations / props like characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScript } from "../../web/script/parse.mjs";
import { Copilot, validateCall, parseStep, route, planFor, COPILOT_SYSTEM, MAX_STEPS } from "../../web/agent/copilot.mjs";
import { troubleshoot } from "../../web/agent/knowledge.mjs";
import { gatherThing, profileThing } from "../../web/agent/thingops.mjs";

const SCRIPT = parseScript(readFileSync(new URL("./fixtures/script/copilot.fountain", import.meta.url), "utf8"), { format: "fountain", name: "copilot.fountain" });
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A fake App: what soundstage.js gives Ask, with a Director that snapshots for Undo and a CastPanel-like panel. */
function fakeApp({ quality = null, failPreset = null } = {}) {
  const st = { shots: [{ id: "s1", name: "Master", camera_keys: [{ focal_mm: 35 }] }, { id: "s2", name: "Two" }, { id: "s3", name: "Close" }],
    active_shot: "s1", actors: [{ id: "cole", name: "Cole", kind: "man" }, { id: "mara", name: "Mara", kind: "woman" }], preset_log: [], selected: null, shot: { frames: 97, fps: 24 } };
  const undo = [];
  const stage = { toJSON: () => clone(st), select: (id) => { st.selected = id; } };
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
  const items = {};
  const cards = [{ key: "character:cole", kind: "character", name: "Cole" }, { key: "character:mara", kind: "character", name: "Mara" },
    { key: "location:int_warehouse", kind: "location", name: "INT. WAREHOUSE" }, { key: "prop:flashlight", kind: "prop", name: "Flashlight" }];
  const generated = [];
  const panel = {
    items: () => cards.map((c) => ({ ...c, ...(items[c.key] || {}) })),
    cardSnapshot: (k) => (items[k] ? clone(items[k]) : null),
    setCard: (k, p) => { items[k] = { ...(items[k] || {}), ...p }; },
    restoreCard: (k, snap) => { if (snap) items[k] = clone(snap); else delete items[k]; },
    generateOne: async (k) => { generated.push(k); items[k] = { ...(items[k] || {}), url: `/ref/${k}.png` }; },
  };
  const q = { adherence: "Balanced", ic_lora: 0.92, follow_clay: 0.85, preset: "Final" };
  const qual = quality || { get: () => ({ ...q }), set: (p) => Object.assign(q, p) };
  const presets = () => ["squib_hit", "crate_crash", "impact_shake", "car_explosion", "building_blast", "sparks_shower", "reverse_jturn", "dialogue_coverage"]
    .map((id) => ({ id, control: id.replace(/_/g, " "), words: "", where: "Presets window → Action", help: "" }));
  const host = { script: () => SCRIPT, stage, director, cast: () => panel, quality: qual, presets };
  return { host, st, items, generated, q, undoDepth: () => undo.length };
}
/** A stubbed model: replies in order; records every prompt it saw. */
function stubLLM(replies) {
  const seen = [];
  const llm = async (system, prompt) => { seen.push({ system, prompt }); const r = replies.shift(); if (r instanceof Error) throw r; return typeof r === "string" ? r : JSON.stringify(r ?? { done: true, say: "Done." }); };
  return { llm, seen };
}
const go = async (cp, text, opts) => { const r = await cp.turn(text); assert.ok(r?.plan, `a plan for "${text}"`); assert.ok((await cp.turn("lock it in")).approved); return { r, x: await cp.execute(opts) }; };

test("tool calls are validated against their schemas; the persona is the filmmaker", () => {
  assert.deepEqual(validateCall({ name: "set_quality", args: { adherence: "exact", ic_lora: "1" } }).call.args, { adherence: "Exact", ic_lora: 1 });
  assert.match(validateCall({ name: "set_quality", args: { ic_lora: 9 } }).error, /0-1.2/);
  assert.match(validateCall({ name: "launch_rocket", args: {} }).error, /unknown tool/);
  assert.match(validateCall({ name: "update_location", args: { name: "Warehouse" } }).error, /description.*required/);
  assert.equal(parseStep("Sure! I'll do that.").ok, false);
  assert.equal(parseStep('{"plan": [{"name": "camera", "args": {"move": "push in"}}]}').step.plan[0].args.move, "push_in");
  for (const w of ["collaborative director", "ONE sharp creative question", "never claim an action", "Soundstage map"]) assert.ok(COPILOT_SYSTEM.includes(w), w);
});

test("the example questions become runnable plans (main's playbook and recipes -> steps); the rest stay with main's Ask", () => {
  const steps = (q) => planFor(q, SCRIPT).steps.map((s) => s.name);
  assert.deepEqual(steps("the claymation won't lock into the final render"), ["set_quality", "set_quality", "set_quality"]);
  assert.deepEqual(planFor("I want a gunshot wound on Cole in shot 3", SCRIPT).steps.map((s) => [s.name, Object.values(s.args)[0]]),
    [["select_shot", "3"], ["select_object", "COLE"], ["add_sfx_rig", "squib"]]);
  assert.deepEqual(steps("re-block this chase, add a crash, then cover it in three shots"), ["stage_order", "apply_preset", "apply_preset", "add_shot", "add_shot", "add_shot"]);
  assert.equal(route("how do I do a J-cut here", { script: SCRIPT }), null, "J/L cut: main's recipe click-steps (no split edit in the Cut)");
  assert.equal(route("build the burly man from the script", { script: SCRIPT }), null, "characters: main's builder");
  // "Do it for me" on main's troubleshoot card: the same steps
  const t = troubleshoot("the claymation won't lock into the final render");
  assert.equal(t.entries[0].id, "clay_not_followed");
  assert.deepEqual(planFor(t.symptom, SCRIPT).steps[0].args, { adherence: "Exact" });
});

test("the five questions with a stubbed model: the model picks the tool, the App's playbook supplies runnable steps", async () => {
  const { llm } = stubLLM([{ call: { name: "troubleshoot", args: { symptom: "the claymation won't lock into the final render" } } }]);
  const r = await new Copilot({ ...fakeApp().host, llm }).turn("the claymation won't lock into the final render");
  assert.equal(r.by, "built-in", "a known problem goes to the playbook first: the model can't invent a setting's value");
  assert.deepEqual(r.plan.steps[0].args, { adherence: "Exact" });
  const s2 = stubLLM([{ say: "A squib on Cole, sold by his reaction.", plan: [{ name: "select_shot", args: { shot: "3" } }, { name: "add_sfx_rig", args: { rig: "squib", on: "Cole" } }] }]);
  const r2 = await new Copilot({ ...fakeApp().host, llm: s2.llm }).turn("I want a gunshot wound on Cole in shot 3");
  assert.deepEqual(r2.plan.steps.map((s) => s.name), ["select_shot", "add_sfx_rig"]);
  const s3 = stubLLM([{ call: { name: "plan_recipe", args: { intent: "J-cut" } } }]);
  const r3 = await new Copilot({ ...fakeApp().host, llm: s3.llm }).turn("how do I do a J-cut here");
  assert.ok(!r3.plan && r3.clicks.length, "click-steps");
});

test("plan -> lock it in -> execute with progress -> self-check -> one Undo for the whole plan", async () => {
  const app = fakeApp(), cp = new Copilot(app.host);
  const seen = [];
  const { x } = await go(cp, "I want a gunshot wound on Cole in shot 3", { onStep: (s) => seen.push(s.call.name) });
  assert.deepEqual(seen, ["select_shot", "select_object", "add_sfx_rig"]);
  assert.equal(app.st.active_shot, "s3");
  assert.equal(app.st.selected, "cole");
  assert.ok(x.verified.some((v) => v.ok && /squib rig.*cue 1.2 s/.test(v.said)), JSON.stringify(x.verified));
  x.undo();
  assert.equal(app.st.active_shot, "s1");
  assert.equal(app.st.selected, null);
  assert.ok(!app.st.actors.some((a) => /squib/.test(a.kind)));
  assert.equal(app.undoDepth(), 0);
});

test("agent loop: a 3-step goal runs on observations (the model sees each result before the next call)", async () => {
  const app = fakeApp();
  const { llm, seen } = stubLLM([
    { say: "Tighter and on its marks.", plan: [{ name: "select_shot", args: { shot: "3" } }, { name: "camera", args: { lens_mm: 85 } }, { name: "set_quality", args: { adherence: "Exact" } }] },
    { call: { name: "select_shot", args: { shot: "3" } } },
    { call: { name: "camera", args: { lens_mm: 85 } } },
    { call: { name: "get_shot", args: {} } },
    { call: { name: "set_quality", args: { adherence: "Exact" } } },
    { done: true, say: "Shot 3 is on an 85 mm, Adherence Exact." },
  ]);
  const { x } = await go(new Copilot({ ...app.host, llm }), "make shot 3 feel tighter and stick to the clay");
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
  const { x } = await go(new Copilot({ ...app.host, llm }), "blow it up");
  assert.deepEqual(x.log.map((l) => [l.call.args.name, l.result.ok]), [["car_explosion", false], ["building_blast", true]]);
  assert.deepEqual(x.failed, [], "the retry fixed it");
  const { x: y } = await go(new Copilot(fakeApp({ failPreset: "crate_crash" }).host), "add a crash");
  assert.equal(y.log[0].result.ok, false);
  assert.match(y.said, /1 step failed: crate_crash failed: no car/);
  assert.equal(y.log.length, 2, "the rest of the plan still ran");
});

test("Stop mid-plan: no more steps; the partial plan can be undone", async () => {
  const app = fakeApp(), cp = new Copilot(app.host);
  const { x } = await go(cp, "re-block this chase, add a crash, then cover it in three shots", { onStep: ({ i }) => { if (i === 2) cp.stop(); } });
  assert.equal(x.stopped, true);
  assert.equal(x.log.length, 2);
  assert.match(x.said, /Stopped after 2 of 6/);
  x.undo();
  assert.equal(app.undoDepth(), 0, "rolled back");
});

test("self-check catches a setting that didn't stick", async () => {
  const sticky = { adherence: "Balanced" };
  const { x } = await go(new Copilot(fakeApp({ quality: { get: () => ({ ...sticky }), set: () => {} } }).host), "the claymation won't lock into the final render");
  assert.ok(x.verified.some((v) => !v.ok && /adherence reads Balanced, not Exact/.test(v.said)));
  assert.match(x.said, /Self-check found a problem/);
});

test("invalid tool JSON: one re-ask, then the built-in router", async () => {
  const { llm, seen } = stubLLM(["I think you should set adherence", '{"call": {"name": "set_quality", "args": {"adherence": "max"}}}']);
  const r = await new Copilot({ ...fakeApp().host, llm }).turn("I want a gunshot wound on Cole in shot 3");
  assert.equal(seen.length, 2, "asked once more, no more");
  assert.match(seen[1].prompt, /not valid: no JSON object/);
  assert.equal(r.by, "built-in");
  assert.match(r.why, /twice/);
  assert.equal(r.plan.steps[0].name, "select_shot");
  const ok = stubLLM(["oops", '{"say": "Exact adherence.", "plan": [{"name": "set_quality", "args": {"adherence": "Exact"}}]}']);
  const r2 = await new Copilot({ ...fakeApp().host, llm: ok.llm }).turn("fix it");
  assert.equal(r2.by, "model");
  assert.equal(r2.reasked, true);
});

test("never acts outside the approved plan; stops at MAX_STEPS", async () => {
  const replies = [{ plan: [{ name: "get_settings", args: {} }] }, { call: { name: "set_quality", args: { adherence: "Loose" } } }];
  for (let i = 0; i < 30; i++) replies.push({ call: { name: "get_settings", args: {} } });
  const app = fakeApp();
  const { x } = await go(new Copilot({ ...app.host, llm: stubLLM(replies).llm }), "look at the settings");
  assert.equal(app.q.adherence, "Balanced", "not in the plan: refused");
  assert.match(x.log[0].result.said, /isn't in the plan/);
  assert.equal(x.log.length, MAX_STEPS);
});

test("locations and props, like characters: gather (cited), profile, update, Undo; regenerate one card only after a yes", async () => {
  const g = gatherThing(SCRIPT, "the warehouse", "location");
  assert.equal(g.name, "WAREHOUSE");
  assert.ok(g.lines.some((l) => /tin roof/.test(l.text) && l.scene === "1"));
  const p = await profileThing(g);
  assert.match(p.description, /interior/);
  assert.match(p.description, /tin roof/);
  assert.ok(p.cites[0].startsWith("sc 1"));
  assert.equal(gatherThing(SCRIPT, "flashlight", "prop").scenes.length, 2);
  const app = fakeApp(), cp = new Copilot(app.host);
  cp.propose([{ name: "gather_location", args: { name: "warehouse" } }, { name: "profile_location", args: { name: "warehouse" } },
    { name: "update_location", args: { name: "warehouse", description: "$profile" } }], "Build the warehouse");
  await cp.turn("yes");
  const x = await cp.execute();
  assert.match(app.items["location:int_warehouse"].description, /tin roof/);
  assert.ok(x.verified.every((v) => v.ok));
  x.undo();
  assert.equal(app.items["location:int_warehouse"], undefined, "the card is back as it was");
  const r = await cp.run({ name: "regenerate_prop", args: { name: "flashlight" } });
  assert.ok(r.needsConfirm);
  assert.deepEqual(app.generated, []);
  await cp.run({ name: "regenerate_prop", args: { name: "flashlight" }, confirmed: true });
  assert.deepEqual(app.generated, ["prop:flashlight"]);
});

test("characters run through main's builder inside a plan: profile -> card -> Undo", async () => {
  const app = fakeApp(), cp = new Copilot(app.host);
  cp.propose([{ name: "profile_character", args: { name: "COLE" } }, { name: "update_character", args: { name: "COLE", description: "$profile" } }], "Build Cole");
  await cp.turn("lock it in");
  const x = await cp.execute();
  assert.match(app.items["character:cole"].description, /burly|shaved|40s/i);
  assert.ok(x.verified.every((v) => v.ok), JSON.stringify(x.verified));
  x.undo();
  assert.equal(app.items["character:cole"], undefined);
});
