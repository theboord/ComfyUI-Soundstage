// node --test tests/js/charbuild.test.mjs
// ✦ Ask builds a character from the script (web/agent/charbuild.mjs + the Conversation in assistant.mjs): gather,
// profile (model or the deterministic draft), write the ② Cast card (one Undo), regenerate ONE card after a yes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScript } from "../../web/script/parse.mjs";
import { gatherCharacter, resolveCharacter, draftProfile, parseProfile, gatherText, castHost, crossCheck } from "../../web/agent/charbuild.mjs";
import { Conversation, ASSISTANT_SYSTEM, TOOL_NAMES, buildTarget } from "../../web/agent/assistant.mjs";
import { CastPanel } from "../../web/cast/cast.mjs";

const SRC = readFileSync(new URL("./fixtures/script/stranger.fountain", import.meta.url), "utf8");
const script = () => parseScript(SRC, { format: "fountain", name: "stranger.fountain" });

/** The real CastPanel's methods on a panel with no DOM (load / save in memory, a counting generate). */
function fakePanel(s, saved = {}) {
  const p = Object.create(CastPanel.prototype);
  let store = { items: saved };
  p.gens = []; p.allCalls = 0;
  p.o = { getScript: () => s, getStage: () => null, load: () => JSON.parse(JSON.stringify(store)), save: (d) => { store = JSON.parse(JSON.stringify(d)); },
    generate: async (prompt, name) => { p.gens.push({ prompt, name }); return { ref: `cast/${name}.png`, url: `/view/${name}.png` }; } };
  p.busy = new Set(); p.el = { querySelectorAll: () => [], isConnected: false }; p.render = () => {};
  const all = p.generateAll; p.generateAll = function (...a) { p.allCalls++; return all.apply(this, a); };
  p.store = () => store;
  return p;
}

test("gather_character: fuzzy names, citations by scene and line, aliases, the cap", () => {
  const s = script();
  for (const q of ["the tall stranger", "TALL STRANGER", "TALL stranger", "tall stranger's"]) assert.equal(resolveCharacter(s, q)?.name, "TALL STRANGER", q);
  const jim = resolveCharacter(s, "Ned");
  assert.equal(jim.name, "NED");
  assert.equal(resolveCharacter(s, "the paint-stained one")?.name, "TALL STRANGER", "a description where the script introduces him");
  const g = gatherCharacter(s, "the tall stranger");
  assert.equal(g.name, "TALL STRANGER");
  assert.deepEqual(g.scenes.map((x) => x.scene), ["1", "2", "3"]);
  assert.equal(g.counts.dialogue, 5);
  assert.ok(g.dialogue.some((d) => d.text === "Tell my sister the ladder is back." && d.scene === "3"));
  const intro = g.intro;
  assert.equal(intro.scene, "1");
  assert.equal(s.scenes[0].elements[intro.line - 1].text.includes("TALL STRANGER (50s)"), true, "the line number points at the element");
  assert.ok(g.action.some((a) => /Patient and quiet/.test(a.text)), "the sentence after a mention, same paragraph");
  assert.ok(g.described.some((d) => d.by === "MARA" && d.scene === "1"), "what others say about him");
  assert.ok(g.wardrobe.some((w) => w.items.includes("denim jacket")));
  assert.ok(g.props.length === 0 || g.props.every((p) => p.items.length));
  assert.match(gatherText(g), /\[1:\d+\] A TALL STRANGER \(50s\)/);
  const capped = gatherCharacter(s, "tall stranger", { cap: 2 });
  assert.equal(capped.dialogue.length, 2); assert.equal(capped.counts.dialogue, 5); assert.equal(capped.more.dialogue, 3);
  assert.match(capped.limits, /3 more dialogue/);
  assert.ok(gatherText(gatherCharacter(s, "tall stranger"), 300).length <= 300);
  assert.match(gatherCharacter(s, "the vicar").said, /couldn't find "the vicar".*TALL STRANGER/);
});

test("profile fallback: a cited draft from the script's own words", () => {
  const s = script();
  const p = draftProfile(gatherCharacter(s, "tall stranger"), s);
  assert.equal(p.sourceLabel, "draft from script cues");
  const f = p.fields;
  assert.equal(f.age.value, "50s"); assert.deepEqual(f.age.cites[0], { scene: "1", line: f.age.cites[0].line });
  assert.match(f.build.value, /lanky/); assert.match(f.hair.value, /close-cropped/); assert.match(f.wardrobe.value, /denim jacket/);
  assert.match(f.personality.value, /patient/); assert.match(f.arc.value, /scene 1.*scene 3/);
  assert.match(f.visual.value, /50s.*lanky.*close-cropped.*denim jacket/);
  for (const k of ["age", "build", "hair", "wardrobe"]) assert.ok(f[k].cites.length, `${k} is cited`);
});

test("the model's profile: invented citations are dropped", () => {
  const g = gatherCharacter(script(), "tall stranger");
  const real = `${g.intro.scene}:${g.intro.line}`;
  const p = parseProfile(JSON.stringify({ age: { value: "early 50s", cites: [real, "9:99"] }, personality: { value: "a grieving father", cites: ["3:0", "7:1"] } }), g);
  assert.deepEqual(p.fields.age.cites.map((c) => `${c.scene}:${c.line}`), [real]);
  assert.deepEqual(p.fields.personality.cites.map((c) => `${c.scene}:${c.line}`), ["3:0"], "a scene it is in is a fair citation");
  assert.equal(parseProfile("no json", g), null);
});

test("update_character writes the ② Cast card and Undo puts it back", async () => {
  const s = script();
  const panel = fakePanel(s, { "character:tall_stranger": { description: "a man", voice: "Gravel" } });
  const c = new Conversation({ script: () => s, cast: () => castHost(panel) });
  await c.turn("build the tall stranger", { useModel: false });
  const r = (await c.turn("yes", { useModel: false })).results[0];
  assert.equal(r.tool, "update_character");
  assert.equal(r.before.description, "a man");
  assert.match(r.after.description, /lanky/);
  const card = panel.store().items["character:tall_stranger"];
  assert.match(card.description, /close-cropped/); assert.equal(card.look.age, "50s"); assert.equal(card.voice, "Gravel", "other fields kept");
  assert.equal(card.profile_source, "draft from script cues");
  c.undo(r.undo);
  assert.deepEqual(panel.store().items["character:tall_stranger"], { description: "a man", voice: "Gravel" }, "one Undo: the card as it was");
});

test("regenerate_character asks first and touches one card only", async () => {
  const s = script();
  const panel = fakePanel(s);
  const c = new Conversation({ script: () => s, cast: () => castHost(panel),
    llm: async () => JSON.stringify({ reply: "On it.", tools: [{ name: "regenerate_character", args: { name: "tall stranger" } }] }) });
  const t1 = await c.turn("regenerate the tall stranger's sheet");
  assert.equal(t1.results.length, 0, "no GPU work without a yes");
  assert.match(t1.confirm.question, /uses the GPU/);
  assert.equal(panel.gens.length, 0);
  const t2 = await c.turn("yes");
  assert.equal(t2.results[0].tool, "regenerate_character");
  await t2.results[0].queued;
  assert.equal(panel.gens.length, 1); assert.equal(panel.gens[0].name, "Tall Stranger");
  assert.equal(panel.allCalls, 0, "never the generate-all path");
  assert.equal(panel.store().items["character:tall_stranger"].url, "/view/Tall Stranger.png");
  assert.ok(!panel.store().items["character:mara"], "Mara's card untouched");
  const t3 = await c.turn("regenerate him again");
  assert.ok(!t3.results.length && t3.confirm, "asks again every time");
  assert.equal(panel.gens.length, 1);
});

test("a scripted conversation: build, profile with the model, apply, regenerate, lookalike flagged", async () => {
  const s = script();
  const panel = fakePanel(s, { "character:ned": { description: "in their 50s, lanky, close-cropped hair, paint-stained hands, wearing denim jacket" } });
  const calls = [];
  const replies = [
    JSON.stringify({ age: { value: "50s", cites: ["1:2"] }, build: { value: "lanky", cites: ["1:2"] }, hair: { value: "close-cropped", cites: ["1:2"] },
      wardrobe: { value: "denim jacket", cites: ["1:2"] }, personality: { value: "patient, quiet", cites: ["3:7"] }, role: { value: "the stranger with a secret", cites: [] },
      arc: { value: "a quiet former gardener who came back", cites: ["3:7"] }, visual: { value: "tall stranger in his 50s, close-cropped hair, paint-stained hands, denim jacket", cites: ["1:2"] } }),
  ];
  const c = new Conversation({ script: () => s, cast: () => castHost(panel), llm: async (sys, prompt) => { calls.push({ sys, prompt }); return replies.shift(); } });
  const t1 = await c.turn("Build the tall stranger");
  assert.equal(t1.by, "model");
  const prof = t1.results[0];
  assert.equal(prof.tool, "profile_character"); assert.equal(prof.profile.source, "model");
  assert.match(calls[0].prompt, /\[1:2\] A TALL STRANGER \(50s\)/, "the model read the gathered, cited evidence");
  assert.match(prof.profile.fields.arc.value, /former gardener/);
  assert.ok(prof.crosscheck.some((x) => x.kind === "lookalike" && /^ned$/i.test(x.with)), "NED's card looks the same");
  assert.match(t1.confirm.question, /Apply this to TALL STRANGER's ② Cast card\?/);
  const t2 = await c.turn("yes please");
  assert.equal(calls.length, 1, "build goes straight to the profile; a yes to its own question needs no model round trip");
  assert.match(panel.store().items["character:tall_stranger"].description, /paint-stained hands/);
  assert.match(t2.confirm.question, /Regenerate .* uses the GPU/);
  const t3 = await c.turn("yes");
  await t3.results[0].queued;
  assert.equal(panel.gens.length, 1);
  assert.match(panel.gens[0].prompt, /Character reference sheet of Tall Stranger, tall stranger in his 50s/);
  assert.ok(c.history.some((m) => /Wrote TALL STRANGER's ② Cast card/.test(m.text)));
});

test("routing and the system prompt", () => {
  const s = script();
  assert.equal(buildTarget("Build the tall stranger", s), "the tall stranger");
  assert.equal(buildTarget("who is Mara?", s), "Mara");
  assert.equal(buildTarget("build the set", s), null);
  assert.equal(buildTarget("make it rain", s), null);
  for (const t of ["gather_character", "profile_character", "update_character", "regenerate_character"]) { assert.ok(TOOL_NAMES.includes(t)); assert.match(ASSISTANT_SYSTEM, new RegExp(`- ${t} `)); }
  assert.match(ASSISTANT_SYSTEM, /You ARE the Soundstage assistant/);
  assert.match(ASSISTANT_SYSTEM, /Never say you checked or changed something unless you call its tool in this turn \(writing a card and generating a picture included\)/);
  assert.equal(crossCheck(s, "TALL STRANGER", "x", []).length, 0);
});
