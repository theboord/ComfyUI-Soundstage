// node --test tests/js/   (the Dailies bin's pure model: slate naming, takes, default coverage, layout; the DOM is checked in
// web/dailies/preview.html)
import test from "node:test";
import assert from "node:assert/strict";

import {
  setupLetter, setupLabel, clipName, longLabel, sceneShots, takesFor, heroTake, isVideoUrl, normKind, fmtDuration, setupKind,
  shotCharacter, dialogueBlocks, defaultCoverage, normCoverage, coverageFor, isOffscreen, toggleOffscreen, moveCoverageEnd, syncPoint,
  snap, SNAP, cellPos, columnsFor, CELL_W, CELL_H, GAP, arrangeByScript, arrangeBySetup, tidyGrid, fillPositions, binRows, sortRows,
  filterRows, compareLabels, setupColor, SETUP_COLORS,
} from "../../web/dailies/model.mjs";
import { DINER_SCENE, demoDailies } from "../../web/dailies/demo_dailies.mjs";
import { DEMO_SCRIPT } from "../../web/script/demo_script.mjs";

const SC12 = { id: "sc_12", number: "12", elements: [] };
const diner = structuredClone(DINER_SCENE);
const el = (i) => diner.elements[i];

// ---------------------------------------------------------------------------------------------- naming

test("setup letters skip I and O, then double", () => {
  assert.equal(setupLetter(0), "");
  assert.equal(setupLetter(1), "A");
  assert.equal(setupLetter(8), "H");
  assert.equal(setupLetter(9), "J");             // I skipped
  assert.equal(setupLetter(13), "N");
  assert.equal(setupLetter(14), "P");            // O skipped
  assert.equal(setupLetter(24), "Z");
  assert.equal(setupLetter(25), "AA");
  assert.equal(setupLetter(26), "BB");
  const all = Array.from({ length: 24 }, (_, i) => setupLetter(i + 1)).join("");
  assert.ok(!all.includes("I") && !all.includes("O"));
});

test("setup labels, clip names and long labels follow LA dailies naming", () => {
  assert.equal(setupLabel(SC12, 0), "12");
  assert.equal(setupLabel(SC12, 1), "12A");
  assert.equal(setupLabel(SC12, 2), "12B");
  assert.equal(setupLabel(SC12, 2, { slate: "12X" }), "12X");
  assert.equal(setupLabel({ number: "" }, 1), "?A");
  assert.equal(clipName(SC12, 2, 3), "12B-3");
  assert.equal(clipName(SC12, 0, 1), "12-1");
  assert.equal(clipName(SC12, 1, 0), "12A-1");
  assert.equal(longLabel(SC12, 2, { name: "OTS Alex" }, 3), "Sc 12B Tk 3 · OTS Alex");
  assert.equal(longLabel(SC12, 2, { name: "OTS Alex" }), "Sc 12B · OTS Alex");
});

test("sceneShots keeps the scene's shots in host order", () => {
  const shots = [{ id: "a", scene_id: "sc_1" }, { id: "b", scene_id: "sc_2" }, { id: "c", scene_id: "sc_1" }, { id: "d" }, null];
  assert.deepEqual(sceneShots({ id: "sc_1" }, shots).map((s) => s.id), ["a", "c"]);
  assert.deepEqual(sceneShots(null, shots), []);
});

// ---------------------------------------------------------------------------------------------- takes

test("takesFor reads the Soundstage render map (latest per kind) with candidates and the chosen frame", () => {
  const view = (f) => `/api/view?filename=${encodeURIComponent(f)}&subfolder=&type=output`;
  const renders = { previz: view("clay_001.webp"), look: view("look_003.png"), final_sound: view("final_001.mp4"), final: view("final_001.mp4"),
    draft: view("draft_001.mp4"),
    candidates: [{ url: view("look_003.png"), seed: 3 }, { url: view("look_002.png"), seed: 2 }, { url: view("look_001.png"), seed: 1 }],
    chosen: { url: view("look_002.png"), seed: 2 } };
  const takes = takesFor({ id: "s1" }, renders);
  assert.deepEqual(takes.map((t) => t.kind), ["previz", "look", "look", "look", "draft", "final"]);
  assert.deepEqual(takes.map((t) => t.n), [1, 2, 3, 4, 5, 6]);
  // Oldest candidate first; the latest look and the chosen frame are not doubled.
  assert.deepEqual(takes.filter((t) => t.kind === "look").map((t) => t.seed), [1, 2, 3]);
  assert.equal(takes.find((t) => t.circled).seed, 2);
  assert.equal(takes.filter((t) => t.circled).length, 1);
  const fin = takes.find((t) => t.kind === "final");
  assert.equal(fin.video, true);
  assert.equal(fin.sound, true);
  assert.equal(fin.thumb, view("look_002.png"));   // a video's thumb is the circled still
  assert.equal(takes[0].video, false);             // .webp clay strip is an image
  assert.equal(new Set(takes.map((t) => t.id)).size, takes.length);
});

test("takesFor accepts a take list, a {takes, circled} record, and the bin's circled id", () => {
  const list = [{ id: "b", kind: "final", url: "b.mp4", created: 2, seconds: 5 }, { id: "a", kind: "clay", url: "a.png", created: 1 }];
  const t = takesFor({}, list);
  assert.deepEqual(t.map((x) => [x.id, x.n, x.kind]), [["a", 1, "previz"], ["b", 2, "final"]]);
  assert.equal(t[1].thumb, "a.png");
  assert.equal(t[1].seconds, 5);
  assert.equal(takesFor({}, { takes: list, circled: "b" }).find((x) => x.circled).id, "b");
  assert.equal(takesFor({}, list, { circled: "a" }).find((x) => x.circled).id, "a");
  // A circled flag in the data wins over opts.circled; only one take stays circled.
  const two = [{ id: "x", url: "x.png", circled: true }, { id: "y", url: "y.png", circled: true }];
  assert.deepEqual(takesFor({}, two, { circled: "x" }).filter((x) => x.circled).map((x) => x.id), ["y"]);
  assert.deepEqual(takesFor({}, null), []);
  assert.deepEqual(takesFor({}, [{ kind: "look" }]), []);  // no url, no take
});

test("heroTake: circled, else the most finished latest", () => {
  const t = takesFor({}, [{ id: "1", kind: "previz", url: "1.mp4" }, { id: "2", kind: "look", url: "2.png" }, { id: "3", kind: "final", url: "3.mp4" },
    { id: "4", kind: "look", url: "4.png" }]);
  assert.equal(heroTake(t).id, "3");
  t[1].circled = true;
  assert.equal(heroTake(t).id, "2");
  assert.equal(heroTake([]), null);
});

test("small helpers: video urls, kinds, durations", () => {
  assert.ok(isVideoUrl("/view?filename=a%20b.mp4&type=output"));
  assert.ok(!isVideoUrl("/view?filename=a.png&type=output"));
  assert.ok(isVideoUrl("demo/x.webm"));
  assert.ok(!isVideoUrl(""));
  assert.equal(normKind("final_audio"), "final");
  assert.equal(normKind(1), "previz");
  assert.equal(normKind("candidate"), "look");
  assert.equal(fmtDuration(5.04), "0:05");
  assert.equal(fmtDuration(75), "1:15");
  assert.equal(fmtDuration(null), "");
});

// ---------------------------------------------------------------------------------------------- setups and coverage

test("setupKind reads the stage's setup keys and falls back to the name", () => {
  const k = (setup, name = "") => setupKind({ setup, name });
  assert.equal(k("master"), "master");
  assert.equal(k("wide"), "wide");
  assert.equal(k("two_shot"), "two");
  assert.equal(k("ots_a"), "ots");
  assert.equal(k("single_b"), "single");
  assert.equal(k("insert"), "insert");
  assert.equal(k("pov"), "pov");
  assert.equal(k("close"), "close");
  assert.equal(k("", "ECU · the key"), "close");
  assert.equal(k("", "Over-the-shoulder on Mara"), "ots");
  assert.equal(k("", "Insert · neon"), "insert");
  assert.equal(k("", "Something"), "other");
});

test("shotCharacter: explicit, by name, by A/B setup", () => {
  assert.equal(shotCharacter(diner, { character: "mara" }), "MARA");
  assert.equal(shotCharacter(diner, { name: "OTS · on Ezra", setup: "ots_a" }), "EZRA");   // the name wins over A/B
  assert.equal(shotCharacter(diner, { setup: "single_a" }), "EZRA");                       // first to speak
  assert.equal(shotCharacter(diner, { setup: "single_b" }), "MARA");
  assert.equal(shotCharacter(diner, { setup: "master", name: "Master" }), null);
  const cole = DEMO_SCRIPT.scenes.find((s) => s.id === "sc_2");
  assert.equal(shotCharacter(cole, { name: "Single Cole" }), "DEPUTY COLE");
});

test("dialogue blocks run from the cue through its parentheticals and dialogue", () => {
  const b = dialogueBlocks(diner, "EZRA");
  assert.deepEqual(b[0], [3, 4]);
  assert.deepEqual(b[1], [7, 9]);   // cue, (re: the car outside), line
  for (const [a, z] of b) { assert.equal(el(a).type, "character"); assert.equal(el(z).type, "dialogue"); }
});

test("masters, wides and two-shots cover the whole scene", () => {
  const n = diner.elements.length;
  for (const setup of ["master", "wide", "two_shot", "mystery"]) assert.deepEqual(defaultCoverage(diner, { setup, name: "x" }), { from: 0, to: n - 1, offscreen: [] });
  assert.equal(defaultCoverage({ elements: [] }, { setup: "master" }), null);
});

test("a single covers its character's speeches; the other character's lines between are off screen", () => {
  const cov = defaultCoverage(diner, { setup: "single", character: "MARA" });
  const mara = dialogueBlocks(diner, "MARA");
  assert.equal(cov.from, mara[0][0]);
  assert.equal(cov.to, mara[mara.length - 1][1]);
  for (const [a, z] of mara) for (let i = a; i <= z; i++) assert.ok(!isOffscreen(cov, i), `Mara's element ${i} is on camera`);
  for (const [a, z] of dialogueBlocks(diner, "EZRA")) {
    for (let i = a; i <= z; i++) if (i > cov.from && i < cov.to) assert.ok(isOffscreen(cov, i), `Ezra's element ${i} is off screen`);
  }
  // Action that mentions Mara stays on camera ("Mara stares at it.").
  const stares = diner.elements.findIndex((e) => /Mara stares/.test(e.text));
  assert.ok(stares > cov.from && !isOffscreen(cov, stares));
  // Close-ups behave the same; OTS and POV span the same lines with no squiggle.
  assert.deepEqual(defaultCoverage(diner, { setup: "close", character: "MARA" }), cov);
  const ots = defaultCoverage(diner, { setup: "ots_a", name: "OTS on Mara" });
  assert.deepEqual([ots.from, ots.to, ots.offscreen.length], [cov.from, cov.to, 0]);
});

test("a character with no lines falls back to action that mentions them, else the scene", () => {
  const sc1 = DEMO_SCRIPT.scenes.find((s) => s.id === "sc_2A");   // only Mara speaks
  const cov = defaultCoverage({ ...sc1, characters: ["MARA"] }, { setup: "single", subject: "Mara" });
  assert.ok(cov.from <= cov.to);
  const silent = { elements: [{ type: "action", text: "Rain." }, { type: "action", text: "The COOK scrapes the grill." }], characters: [] };
  assert.deepEqual(defaultCoverage(silent, { setup: "single", name: "Single cook" }), { from: 0, to: 1, offscreen: [] });
});

test("inserts cover the action line that mentions the subject, else nothing", () => {
  const keyLine = diner.elements.findIndex((e) => /second brass KEY/.test(e.text));
  assert.deepEqual(defaultCoverage(diner, { setup: "insert", name: "Insert · the key", subject: "key" }), { from: keyLine, to: keyLine, offscreen: [] });
  assert.deepEqual(defaultCoverage(diner, { setup: "insert", name: "Insert · neon sign" }), { from: 0, to: 0, offscreen: [] });
  assert.equal(defaultCoverage(diner, { setup: "insert", name: "Insert · the motorbike" }), null);
  assert.equal(defaultCoverage(diner, { setup: "insert", name: "Insert" }), null);
  // Plural / singular forms match ("keys").
  assert.equal(defaultCoverage(diner, { setup: "insert", subject: "keys formica" }).from, keyLine);
});

test("normCoverage clamps, orders and merges; coverageFor prefers the shot's own", () => {
  assert.deepEqual(normCoverage({ from: 9, to: -3, offscreen: [[5, 3], [4, 6], [40, 50]] }, 20), { from: 0, to: 9, offscreen: [[3, 6]] });
  assert.equal(normCoverage(null, 10), null);
  assert.equal(normCoverage({ from: 1, to: 2 }, 0), null);
  const own = { from: 2, to: 4, offscreen: [] };
  assert.deepEqual(coverageFor(diner, { setup: "master", coverage: own }), own);
  assert.deepEqual(coverageFor(diner, { setup: "master" }, own), own);
  assert.equal(coverageFor(diner, { setup: "master" }, null), null);        // host says: not lined
  assert.equal(coverageFor(diner, { setup: "master" }).from, 0);           // undefined = default
});

test("coverage edits: toggle off screen, move an end, sync point", () => {
  let c = { from: 2, to: 8, offscreen: [] };
  c = toggleOffscreen(c, 4);
  assert.deepEqual(c.offscreen, [[4, 4]]);
  c = toggleOffscreen(c, 5);
  assert.deepEqual(c.offscreen, [[4, 5]]);
  c = toggleOffscreen(c, 4);
  assert.deepEqual(c.offscreen, [[5, 5]]);
  assert.equal(toggleOffscreen(c, 20), c);                              // outside: unchanged
  assert.deepEqual(moveCoverageEnd(c, "to", 6, 30), { from: 2, to: 6, offscreen: [[5, 5]] });
  assert.deepEqual(moveCoverageEnd(c, "to", 4, 30).offscreen, []);       // squiggle clipped away
  assert.deepEqual(moveCoverageEnd(c, "from", 10, 30), { from: 8, to: 10, offscreen: [] });  // ends swap
  const sp = syncPoint(diner, { from: 0, to: 4, offscreen: [] }, 0, { seconds: 10 });
  assert.deepEqual(sp, { elementIndex: 0, fraction: 0, offset: 0 });
  const mid = syncPoint(diner, { from: 0, to: 4, offscreen: [] }, 3, { seconds: 10 });
  assert.ok(mid.fraction > 0.5 && mid.fraction < 1 && mid.offset > 5);
  assert.equal(syncPoint(diner, { from: 0, to: 4, offscreen: [] }, 2).offset, undefined);
});

// ---------------------------------------------------------------------------------------------- layout

test("snap grid and cells", () => {
  assert.equal(snap(17), 12);
  assert.equal(snap(19), 24);
  assert.equal(snap(-30), 0);
  assert.equal(snap(31, 10), 30);
  assert.equal(SNAP, 12);
  assert.deepEqual(cellPos(0, 0), { x: GAP, y: GAP });
  assert.deepEqual(cellPos(2, 1), { x: GAP + 2 * CELL_W, y: GAP + CELL_H });
  assert.equal(columnsFor(GAP + 4 * CELL_W), 4);
  assert.equal(columnsFor(2 * (GAP + 4 * CELL_W), 2), 4);
  assert.equal(columnsFor(10), 1);
});

const items = [
  { id: "ins", kind: "insert", coverage: { from: 12, to: 12, offscreen: [] } },
  { id: "m", kind: "master", coverage: { from: 0, to: 26, offscreen: [] } },
  { id: "sm", kind: "single", coverage: { from: 5, to: 23, offscreen: [] } },
  { id: "w", kind: "wide", coverage: { from: 0, to: 4, offscreen: [] } },
  { id: "neon", kind: "insert", coverage: null },
  { id: "two", kind: "two", coverage: { from: 0, to: 26, offscreen: [] } },
];

test("arrange in script order: by start, longer first, unlined last", () => {
  const pos = arrangeByScript(items, 3);
  const order = Object.entries(pos).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x).map(([id]) => id);
  assert.deepEqual(order, ["m", "two", "w", "sm", "ins", "neon"]);
  assert.deepEqual(pos.m, cellPos(0, 0));
  assert.deepEqual(pos.sm, cellPos(0, 1));
});

test("arrange by setup: one band per group, in group order", () => {
  const { positions, rows } = arrangeBySetup(items, 2);
  assert.deepEqual(rows.map((r) => r.key), ["master", "two", "single", "insert"]);
  assert.deepEqual(positions.m, cellPos(0, 0));
  assert.deepEqual(positions.w, cellPos(1, 0));
  assert.deepEqual(positions.two, cellPos(0, 1));
  assert.deepEqual(positions.sm, cellPos(0, 2));
  assert.deepEqual(positions.ins, cellPos(0, 3));
  assert.deepEqual(positions.neon, cellPos(1, 3));
});

test("tidy grid snaps to free cells without collisions and keeps reading order", () => {
  const pos = { a: { x: 30, y: 25 }, b: { x: 40, y: 30 }, c: { x: GAP + CELL_W * 2 + 20, y: GAP + 5 }, d: { x: 5000, y: 5 } };
  const out = tidyGrid(pos, ["a", "b", "c", "d", "e"], 3);
  const cells = Object.values(out).map((p) => `${p.x},${p.y}`);
  assert.equal(new Set(cells).size, 5, "no two cards share a cell");
  assert.deepEqual(out.a, cellPos(0, 0));
  assert.deepEqual(out.b, cellPos(1, 0));
  assert.deepEqual(out.c, cellPos(2, 0));
  for (const p of Object.values(out)) assert.ok(p.x <= GAP + 2 * CELL_W, "inside the column count");
});

test("fillPositions appends new setups below the lowest card", () => {
  const out = fillPositions({ a: cellPos(0, 0), b: cellPos(1, 1) }, ["a", "b", "c", "d"], 4);
  assert.deepEqual(out.a, cellPos(0, 0));
  assert.deepEqual(out.c, cellPos(0, 2));
  assert.deepEqual(out.d, cellPos(1, 2));
  assert.deepEqual(fillPositions({}, ["x"], 4).x, cellPos(0, 0));
});

// ---------------------------------------------------------------------------------------------- list view

test("bin rows, sorting and filtering", () => {
  const { script, shots, renders } = demoDailies({ thumbs: false });
  const sc = script.scenes.find((s) => s.id === "sc_4");
  // Without drawn thumbs the stills have no url: give them one so every take counts.
  const fix = (id) => renders[id].map((t) => ({ ...t, url: t.url || `${id}-${t.id}.png` }));
  const rows = binRows(sc, shots, (shot) => takesFor(shot, fix(shot.id)));
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.label), ["4", "4A", "4B"]);
  assert.equal(rows[9].label, "4J");   // no 4I
  assert.equal(rows[0].take_count, 5);
  assert.equal(rows[0].circled_n, 4);
  assert.ok(rows.every((r) => r.takes.filter((t) => t.circled).length <= 1));
  assert.deepEqual(sortRows(rows, "label", -1).slice(0, 2).map((r) => r.label), ["4K", "4J"]);
  assert.equal(sortRows(rows, "takes", -1)[0].take_count, 5);
  const byName = sortRows(rows, "name").map((r) => r.name);
  assert.deepEqual(byName, [...byName].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  assert.deepEqual(filterRows(rows, "insert").map((r) => r.label), ["4H", "4J"]);
  assert.ok(filterRows(rows, "circled").every((r) => r.circled));
  assert.deepEqual(filterRows(rows, "  "), rows);
});

test("label compare and colours", () => {
  assert.deepEqual(["12B", "12", "12AA", "12A", "9C"].sort(compareLabels), ["9C", "12", "12A", "12B", "12AA"]);
  assert.equal(setupColor(0), SETUP_COLORS[0]);
  assert.equal(setupColor(SETUP_COLORS.length), SETUP_COLORS[0]);
  assert.match(setupColor(5), /^#[0-9a-f]{6}$/);
});

test("the demo's dialogue scene is a proper two-hander", () => {
  const speakers = new Set(diner.elements.filter((e) => e.type === "character").map((e) => e.character));
  assert.deepEqual([...speakers].sort(), ["EZRA", "MARA"]);
  assert.ok(diner.elements.filter((e) => e.type === "dialogue").length >= 8);
  for (const e of diner.elements) if (e.type === "dialogue" || e.type === "parenthetical") assert.ok(e.character);
});
