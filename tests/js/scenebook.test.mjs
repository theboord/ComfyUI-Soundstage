// ✦ Ask's director's breakdown (web/agent/scenebook.mjs): facts from the script, a reading the scene has to back up.
import test from "node:test";
import assert from "node:assert/strict";
import { parseScript } from "../../web/script/parse.mjs";
import { sceneFacts, sceneLines, parseSceneRead, scenesAsked, breakdownAsked, breakDownScenes, sceneNote, SCENE_SYSTEM, SCENES_PER_TURN } from "../../web/agent/scenebook.mjs";
import { Conversation } from "../../web/agent/assistant.mjs";

const TEXT = `INT. DINER - NIGHT

JANE DOE (30s) wipes the counter. JOHN DOE (40s) turns a brass key in his fingers.

JANE DOE
You've been here an hour.

JOHN DOE
Hold on to this.

He slides the brass key across the table.

EXT. PARKING LOT - NIGHT

The tall stranger climbs out of a sedan. Everyone calls him PAT.

INT. BUS STATION - DAY

Jane tries the key in a locker.

INT. MOTEL - DAY

John sits on the bed.
`;
const script = () => parseScript(TEXT);

test("the facts come from the script: a person only in the action counts, the model isn't asked", () => {
  const s = script();
  const f = sceneFacts(s, s.scenes[0]);
  assert.deepEqual([...f.characters].sort(), ["JANE DOE", "JOHN DOE"]);
  assert.equal(f.location, "DINER");
  const frank = sceneFacts({ ...s, characters: [...s.characters, { name: "PAT", lines: 0 }] }, s.scenes[1]);
  assert.ok(frank.characters.includes("PAT"), "Pat never speaks here but he is in the scene");
  assert.ok(sceneLines(s.scenes[0]).some((l) => /^\[\d+\] JANE DOE: You've been here/.test(l)));
});

test("the reading is checked: bad citations, people and props that aren't in the scene are dropped", () => {
  const s = script(), sc = s.scenes[0], facts = sceneFacts(s, sc);
  const r = parseSceneRead(JSON.stringify({
    purpose: { text: "John hands the danger to Jane.", cites: [1, 999] },
    turn: { text: "The key crosses the table.", cites: ["[5]"] },
    emotion: { start: "guarded", end: "afraid", cites: [2] },
    tone: "quiet dread",
    characters: [{ name: "Jane Doe", wants: "to close up", hides: "", feels: "tired", cites: [1] }, { name: "NAPOLEON", wants: "Russia", cites: [1] }],
    props: [{ item: "brass key", means: "the debt changing hands", cites: [1] }, { item: "sniper rifle", means: "invented", cites: [1] }],
    staging: { text: "Hold the two-shot until the key moves.", why: "the slide is the turn" },
  }), sc, facts);
  assert.deepEqual(r.purpose.cites, [1], "a line the scene doesn't have is not a citation");
  assert.deepEqual(r.characters.map((c) => c.name), ["JANE DOE"]);
  assert.deepEqual(r.props.map((p) => p.item), ["brass key"]);
  assert.equal(r.tone, "quiet dread");
  assert.equal(parseSceneRead("{broken", sc, facts), null);
  assert.equal(parseSceneRead("{}", sc, facts), null);
});

test("which scenes: one, a range, a list, or all of them; and what counts as asking", () => {
  assert.deepEqual(scenesAsked("break down scene 3"), { numbers: ["3"] });
  assert.deepEqual(scenesAsked("scenes 4-6"), { numbers: ["4", "5", "6"] });
  assert.deepEqual(scenesAsked("scene 3 and 5"), { numbers: ["3", "5"] });
  assert.deepEqual(scenesAsked("each scene"), { all: true });
  assert.ok(breakdownAsked("break down each scene"));
  assert.ok(breakdownAsked("what's the tone of scene 2"));
  assert.ok(breakdownAsked("give me your director's notes on scene 2"));
  assert.equal(breakdownAsked("what happens in scene 6"), null, "a plain story question is answered, not broken down");
  assert.equal(breakdownAsked("make scene 2 rain"), null);
});

test("a turn reads a few scenes and offers the next; without a model it says what is missing, and invents nothing", async () => {
  const s = script();
  const seen = [];
  const llm = async (sys, prompt) => { seen.push({ sys, prompt }); return JSON.stringify({ tone: "tight", emotion: { start: "calm", end: "uneasy", cites: [1] } }); };
  const r = await breakDownScenes(s, { all: true }, { llm });
  assert.equal(r.scenes.length, SCENES_PER_TURN);
  assert.equal(r.more, "break down scenes 3-4");
  assert.equal(seen[0].sys, SCENE_SYSTEM);
  assert.match(seen[0].prompt, /\[\d+\] JOHN DOE: Hold on to this\./, "the model reads the scene's own numbered lines");
  const none = await breakDownScenes(s, { numbers: ["2"] });
  assert.equal(none.scenes[0].read, null);
  assert.match(none.scenes[0].why, /no language model/);
  assert.match(sceneNote(none.scenes[0]), /Location: PARKING LOT/);
  assert.doesNotMatch(sceneNote(none.scenes[0]), /Tone:/);
  const missing = await breakDownScenes(s, { numbers: ["99"] });
  assert.match(missing.said, /no scene 99/);
});

test("the conversation goes straight to the breakdown, with or without a model", async () => {
  const calls = [];
  const c = new Conversation({ script, llm: async (sys) => { calls.push(sys); return JSON.stringify({ tone: "tight" }); } });
  const r = await c.turn("break down scene 1 in detail");
  assert.equal(r.results[0].tool, "break_down_scene");
  assert.equal(calls.length, 1, "no router round trip");
  assert.equal(r.by, "model");
  const off = await new Conversation({ script }).turn("break down scene 1", { useModel: false });
  assert.equal(off.results[0].tool, "break_down_scene");
  assert.equal(off.results[0].scenes[0].read, null);
});
