// node --test tests/js/assistant.test.mjs
// ✦ Ask as a conversation (web/agent/assistant.mjs). Mike (QA 2026-11-04) asked it to "double-check the characters to
// make sure they don't match (no duplicates), check the props are actually props, read the script and analyse it",
// and it planned a shot instead. The checks run on a fixture with planted problems; a scripted conversation drives the
// model path with canned model replies; the no-model path runs the same checks from the words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseScript, hydrateScript, compactScript } from "../../web/script/parse.mjs";
import { checkCast, checkProps, checkLocations, analyzeScript, applyFixes, classifyProp, editDistance, nameWords, wantedTools, isVagueCheck,
  sameAgain, parseTurn, projectSummary, Conversation, ASSISTANT_SYSTEM, TOOL_NAMES } from "../../web/agent/assistant.mjs";

const PLANTED = readFileSync(new URL("./fixtures/script/planted.fountain", import.meta.url), "utf8");
const script = () => parseScript(PLANTED, { format: "fountain", name: "planted.fountain" });
const MIKE = "double-check the characters to make sure they don't match (no duplicates), check the props are actually props, read the script and analyse it";

test("helpers: edit distance, the words of a name", () => {
  assert.equal(editDistance("MARA", "MARRA"), 1);
  assert.equal(editDistance("MARA", "COLE", 2), 3, "capped");
  assert.deepEqual(nameWords("DR. ADA COLE (V.O.)"), ["ADA", "COLE"]);
  assert.deepEqual(nameWords("SHERIFF COLE"), ["COLE"]);
});

test("check_cast finds the planted duplicates, and leaves numbered extras alone", () => {
  const r = checkCast(script());
  const kinds = Object.fromEntries(r.findings.map((f) => [f.kind, f]));
  assert.deepEqual(kinds.same.names.slice().sort(), ["ADA COLE", "DR. ADA COLE"], "a title doesn't make a new person");
  assert.deepEqual(kinds.typo.names.slice().sort(), ["MARA", "MARRA"]);
  assert.match(kinds.age.why, /BEN is introduced as 30s in scene 2 and 60s in scene 3/);
  assert.ok(!r.findings.some((f) => f.names.some((n) => /^COP/.test(n))), "COP #1 and COP #2 are two people");
  const typo = r.fixes.find((f) => f.from === "MARRA");
  assert.equal(typo.into, "MARA", "the spelling used in more scenes wins");
  assert.ok(r.did.length >= 2 && /compared 7 character names/.test(r.did[0]), "says what it actually looked at");
  assert.match(r.limits, /Appearance clashes .* need the language model/, "and what it didn't");
  assert.equal(checkCast(parseScript("INT. ROOM - DAY\n\nANNA\nHi.\n\nBORIS\nHello.\n", { format: "fountain" })).findings.length, 0);
  assert.equal(checkCast({ characters: [{ name: "MARA", lines: 2, scenes: ["sc_1"] }, { name: "MARA KANE", lines: 1, scenes: ["sc_2"] }], scenes: [] }).findings[0].kind, "part");
});

test("check_props: planted non-props are named and moved; real props pass", () => {
  const s = { characters: [{ name: "MARA", lines: 1, scenes: ["sc_1"] }], scenes: [{ id: "sc_1", number: "1", index: 0, heading: "INT. DINER - NIGHT", location: "DINER",
    breakdown: { props: ["revolver", "fedora", "beat", "pickup truck", "stray dog", "jukebox", "MARA", "silence", "flashlight", "suitcase"] } }] };
  const r = checkProps(s);
  const got = Object.fromEntries(r.findings.map((f) => [f.item, f.kind]));
  assert.deepEqual(got, { fedora: "wardrobe", beat: "not_a_prop", "pickup truck": "vehicles", "stray dog": "animals", jukebox: "set_dressing", MARA: "cast", silence: "not_a_prop" });
  for (const p of ["revolver", "flashlight", "suitcase"]) assert.equal(classifyProp(p), "prop", p);
  assert.equal(r.fixes.find((f) => f.item === "beat").to, null, "a filler word is dropped");
  assert.equal(r.fixes.find((f) => f.item === "fedora").to, "wardrobe");
  assert.match(r.did[0], /read 10 prop entries in 1 scene/);
  // on the parsed fixture: the importer filed the FEDORA as a prop
  assert.ok(checkProps(script()).findings.some((f) => f.item === "fedora" && f.kind === "wardrobe"));
});

test("check_locations: two spellings, a typo, and parts of one set", () => {
  const r = checkLocations(script());
  const by = (k) => r.findings.filter((f) => f.kind === k).map((f) => f.names.slice().sort().join(" / "));
  assert.deepEqual(by("same"), ["JOE'S DINER / JOES DINER"]);
  assert.deepEqual(by("typo"), ["MOTEL / MOTELL"]);
  assert.deepEqual(by("overlap"), ["JOE'S DINER / JOE'S DINER - KITCHEN"]);
  assert.deepEqual(r.fixes.map((f) => [f.from, f.into]), [["JOES DINER", "JOE'S DINER"], ["MOTELL", "MOTEL"]]);
});

test("analyze_script: summary, scene list, beats and issues, honest about how the beats were picked", () => {
  const r = analyzeScript(script());
  assert.match(r.summary, /"Planted Problems": 5 scenes/);
  assert.equal(r.scenes.length, 5);
  assert.match(r.scenes[0], /^1\. INT\. JOE'S DINER - NIGHT \(/);
  assert.ok(r.beats.length >= 3 && /^scene 1: /.test(r.beats[0]));
  assert.ok(r.issues.some((x) => /^cast: 3 possible duplicates/.test(x)));
  assert.ok(r.issues.some((x) => /^locations:/.test(x)));
  assert.match(r.limits, /not a story reading/);
  assert.equal(analyzeScript(script(), { scenes: ["3"] }).scenes.length, 1, "scoped to a scene");
});

test("apply_fixes: merges, renames and reclassifies; the result survives a re-read of the breakdown", () => {
  const s0 = script();
  const fixes = [...checkCast(s0).fixes, ...checkLocations(s0).fixes, ...checkProps(s0).fixes];
  const { script: s1, did, skipped } = applyFixes(s0, fixes);
  assert.deepEqual(skipped, []);
  assert.ok(did.some((x) => /^merged MARRA into MARA/.test(x)));
  const names = s1.characters.map((c) => c.name);
  assert.ok(!names.includes("MARRA") && names.includes("MARA"));
  assert.equal(new Set(s1.scenes.map((x) => x.location)).has("JOES DINER"), false);
  assert.ok(s1.scenes[0].breakdown.wardrobe.includes("fedora") && !s1.scenes[0].breakdown.props.includes("fedora"));
  const again = hydrateScript(compactScript(s1));   // what a reload does
  assert.ok(again.scenes[0].breakdown.wardrobe.includes("fedora") && !again.scenes[0].breakdown.props.includes("fedora"), "kept on the scene");
  assert.equal(s0.characters.some((c) => c.name === "MARRA"), true, "the original is untouched (it's the Undo)");
  assert.deepEqual(applyFixes(s1, [{ type: "merge_cast", from: "MARRA", into: "MARA" }]).skipped, ["MARRA: not found any more"]);
});

test("the built-in router: Mike's request asks for the cast, props and script checks; stage orders don't", () => {
  assert.deepEqual(wantedTools(MIKE).sort(), ["analyze_script", "check_cast", "check_props"]);
  assert.deepEqual(wantedTools("put Mara in the car"), []);
  assert.deepEqual(wantedTools("make it rain"), []);
  assert.deepEqual(wantedTools("any duplicate characters?"), ["check_cast"]);
  assert.ok(isVagueCheck("check it"));
  assert.ok(!isVagueCheck("check the camera on shot 2"));
  assert.deepEqual(sameAgain("now do the same for scene 3"), { scenes: ["3"] });
  assert.deepEqual(sameAgain("again for scenes 2 and 4"), { scenes: ["2", "4"] });
  assert.equal(sameAgain("make it rain"), null);
});

test("no model: Mike's request runs the checks and says the model isn't there", async () => {
  const s = script();
  const c = new Conversation({ script: () => s, llm: async () => { throw Object.assign(new Error("the language model isn't loaded"), { noModel: true }); } });
  const r = await c.turn(MIKE);
  assert.equal(r.by, "built-in");
  assert.match(r.why, /isn't loaded/);
  assert.deepEqual(r.results.map((x) => x.tool).sort(), ["analyze_script", "check_cast", "check_props"]);
  assert.ok(!r.plan, "no shot or beat");
  // the conversation carries: "the same for scene 3" re-runs the last checks on scene 3 only
  const r2 = await c.turn("now do the same for scene 3");
  assert.deepEqual(r2.results.map((x) => x.tool).sort(), ["analyze_script", "check_cast", "check_props"]);
  assert.equal(r2.results.find((x) => x.tool === "analyze_script").scenes.length, 1);
  // a vague request gets a question with choices, not a guess
  const r3 = await c.turn("check it");
  assert.equal(r3.question, "What should I check?");
  assert.equal(r3.options.length, 4);
  // no script: says so, claims nothing
  const empty = await new Conversation({ script: () => null }).turn("check the cast for duplicates");
  assert.match(empty.results[0].said, /no script loaded yet/);
  assert.deepEqual(empty.results[0].did, []);
  // nothing for the checks: null (the recipes / the Director's planner take it)
  assert.equal(await new Conversation({ script: () => s }).turn("make it rain"), null);
});

test("a scripted conversation with the model: tools run, history carries, unknown tools are said, nothing applied unasked", async () => {
  const s = script();
  const replies = [
    '{"reply":"I checked the cast and the props.","tools":[{"name":"check_cast","args":{}},{"name":"check_props","args":{}}]}',
    '<think>scene 3 again</think>{"reply":"Same checks, scene 3.","tools":[{"name":"check_cast","args":{"scenes":[3]}}]}',
    '{"reply":"","question":"Which scene do you mean: the diner or the motel?","tools":[]}',
    '{"reply":"Making it rain.","tools":[{"name":"plan_stage","args":{"command":"make it rain"}}]}',
    '{"reply":"Done.","tools":[{"name":"render_oscar_speech","args":{}},{"name":"apply_fixes","args":{}}]}',
    '{"reply":"Noted.","tools":[{"name":"add_note","args":{"scene":2,"text":"Ben looks older here: check the casting."}}]}',
  ];
  const seen = [];
  const c = new Conversation({ script: () => s, shots: () => [{ id: "s1", name: "Diner wide" }], where: () => "You're on ① Script",
    llm: async (system, prompt) => { seen.push({ system, prompt }); return replies[seen.length - 1]; } });
  const r1 = await c.turn("check the characters and the props");
  assert.equal(r1.by, "model");
  assert.deepEqual(r1.results.map((x) => x.tool), ["check_cast", "check_props"]);
  assert.match(seen[0].system, /Characters \(lines\): BEN \(2\)/, "the model sees what the project holds");
  assert.match(seen[0].system, /Shots: Diner wide/);
  assert.match(seen[0].prompt, /You're on ① Script\.\nUser: check the characters and the props$/);
  const r2 = await c.turn("now the same for scene 3");
  assert.match(seen[1].prompt, /Conversation so far:\nUser: check the characters and the props\nAssistant: I checked the cast and the props\. 3 possible duplicates/);
  assert.equal(r2.results[0].tool, "check_cast");
  const r3 = await c.turn("fix the location");
  assert.match(r3.question, /Which scene/);
  assert.equal(r3.results.length, 0);
  const r4 = await c.turn("make it rain");
  assert.equal(r4.plan, "make it rain");
  const r5 = await c.turn("render an oscar speech and fix everything");
  assert.match(r5.cant, /^I can't do render_oscar_speech yet\. The nearest I can do:/);
  assert.equal(r5.applyAsked, true, "apply_fixes from the model is never run: the user's button applies");
  const r6 = await c.turn("note that Ben looks older in scene 2");
  assert.deepEqual(r6.note, { text: "Ben looks older here: check the casting.", scene: 2 });
  c.reset();
  assert.deepEqual(c.history, [], "New chat");
});

test("the model's turn is parsed from JSON or plain text; the system prompt lists every tool and the honesty rules", () => {
  assert.deepEqual(parseTurn('{"reply":"Hi","tools":["check_cast"]}'), { reply: "Hi", question: "", tools: [{ name: "check_cast", args: {} }] });
  assert.equal(parseTurn("Just text.").reply, "Just text.");
  assert.equal(parseTurn(""), null);
  for (const t of TOOL_NAMES.filter((x) => x !== "apply_fixes")) assert.match(ASSISTANT_SYSTEM, new RegExp(`- ${t} `), t);
  assert.match(ASSISTANT_SYSTEM, /Never say you checked or changed something unless you call its tool/);
  assert.match(ASSISTANT_SYSTEM, /ask one short question instead of guessing/);
  assert.match(projectSummary(null), /No script is loaded/);
  assert.ok(projectSummary(script()).length <= 2400);
});
