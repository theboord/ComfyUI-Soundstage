// node --test tests/js/book.test.mjs
// The Director's Book (Milestone 23): the data model, the camera plan off the stage, the floor plan, notes and their
// placement in the book, the Director's context, the decisions it writes back, revisions, the print binder and Markdown.
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_SCRIPT } from "../../web/script/demo_script.mjs";
import { policeChase } from "../../web/tryit/scenes.mjs";
import * as M from "../../web/book/model.mjs";
import { floorPlanSVG, moveArrowSVG } from "../../web/book/floorplan.mjs";
import { printHTML } from "../../web/book/print.mjs";

const script = () => structuredClone(DEMO_SCRIPT);
const sc2 = (s) => s.scenes.find((x) => x.id === "sc_2");
const chase = () => { const j = policeChase(); for (const a of j.actors) { if (a.id === "getaway") Object.assign(a, { name: "Mara", kind: "woman" }); if (a.id === "cop") a.name = "Deputy Cole"; } return j; };

test("an empty book, normalised from anything", () => {
  const b = M.normalizeBook(null, script());
  assert.equal(b.title, "Last Light on Route 9");
  for (const k of ["rules", "style", "constraints", "notes", "revisions"]) assert.ok(Array.isArray(b[k]));
  assert.deepEqual(M.normalizeBook({ notes: "x", scenes: 3 }).notes, []);
});

test("shot numbers follow the scene: 2A, 2B; scene 2A's shots are 2A-A, 2A-B", () => {
  assert.equal(M.shotNumber("2", 0), "2A");
  assert.equal(M.shotNumber("12", 27), "12AB");
  assert.equal(M.shotNumber("2A", 1), "2A-B");
});

test("camera plan off the demo chase: lens, height, move and rig per shot", () => {
  const rows = M.cameraPlan(chase(), { sceneNumber: "2" });
  assert.deepEqual(rows.map((r) => r.no), ["2A", "2B", "2C"]);
  const crane = rows.find((r) => r.id === "crane");
  assert.equal(crane.lens, "28 mm");
  assert.match(crane.move, /push in|crane down/);
  assert.match(crane.height, /^6\.0 m \(high\)/);
  const trk = rows.find((r) => r.id === "tracking");
  assert.match(trk.rig, /vehicle mount/);
  assert.match(trk.move, /rides with the sports car/);
  assert.ok(rows.every((r) => r.status === "planned"));
});

test("moveOf names the classic moves", () => {
  const k = (p, t, f = 35, frame = 0) => ({ frame, position: p, target: t, focal_mm: f });
  assert.equal(M.moveOf([k([0, 1.6, -10], [0, 1.5, 0])]), "static");
  assert.match(M.moveOf([k([0, 1.6, -10], [0, 1.5, 0]), k([0, 1.6, -6], [0, 1.5, 4], 35, 96)]), /^push in 4\.0 m/);
  assert.match(M.moveOf([k([0, 1.6, -10], [0, 1.5, 0]), k([0, 1.6, -14], [0, 1.5, -4], 35, 96)]), /^pull out/);
  assert.match(M.moveOf([k([0, 1.6, -10], [0, 1.5, 0]), k([3, 1.6, -10], [3, 1.5, 0], 35, 96)]), /track (left|right) 3\.0 m/);
  assert.match(M.moveOf([k([0, 1.6, -10], [0, 1.5, 0]), k([0, 4, -10], [0, 1.5, 0], 35, 96)]), /crane up/);
  assert.match(M.moveOf([k([0, 1.6, -10], [0, 1.5, 0]), k([0, 1.6, -10], [0, 1.5, 0], 85, 96)]), /zoom in/);
});

test("dropped shots are struck, never deleted: a shot gone from the stage stays in the strip", () => {
  const b = M.emptyBook(script());
  const st = chase();
  M.rememberShots(b, "sc_2", M.cameraPlan(st, { sceneNumber: "2" }));
  M.toggleDropped(b, "sc_2", "chase");
  let rows = M.cameraPlan(st, { sceneNumber: "2", page: b.scenes.sc_2 });
  assert.equal(rows.find((r) => r.id === "chase").dropped, true);
  st.shots = st.shots.filter((x) => x.id !== "tracking");
  rows = M.cameraPlan(st, { sceneNumber: "2", page: b.scenes.sc_2 });
  const gone = rows.find((r) => r.id === "tracking");
  assert.ok(gone && gone.dropped && gone.gone, "the removed shot is still listed, struck");
  assert.equal(rows.length, 3);
});

test("the rules auto-fill a page from the script and the stage", () => {
  const s = script();
  const f = M.autoFill(s, sc2(s), chase());
  assert.match(f.times, /Exterior, Dry Creek - Main Street · Night/);
  assert.match(f.lighting, /Night \(heading\).*night.*practical 2100K/);
  assert.deepEqual(Object.keys(f.performance), ["DEPUTY COLE"]);
  assert.ok(f.sound.some((r) => /Siren/.test(r.hear)));
  const f1 = M.autoFill(s, s.scenes[0], null);
  assert.match(f1.continuity, /brass key \(also in sc 2A, 3\)/);
});

test("the director's words win: a draft never overwrites an edited field", () => {
  const s = script(), b = M.emptyBook(s);
  M.setField(b, "sc_1", "core", "She takes back what's hers.");
  const filled = M.mergeDraft(b, "sc_1", { core: "model core", subtext: "model subtext", performance: { MARA: "still" } });
  assert.deepEqual(filled, ["subtext", "performance"]);
  const pg = M.pageFor(b, s, s.scenes[0], null);
  assert.equal(pg.fields.core.value, "She takes back what's hers.");
  assert.equal(pg.fields.core.source, "director");
  assert.equal(pg.fields.subtext.source, "llm");
  assert.equal(pg.fields.performance.value.MARA, "still");
  assert.ok("EZRA" in pg.fields.performance.value, "every character keeps a row");
  assert.equal(pg.fields.synopsis.source, "rules");
});

test("pitfalls become positive prompt constraints (CFG 1 has no negative prompt)", () => {
  assert.deepEqual(M.positiveConstraints(["avoid melodrama", "no shaky handheld", "keep it quiet", "no hats"]),
    ["restrained, understated performance", "steady, locked-off camera", "keep it quiet"]);
  const s = script(), b = M.emptyBook(s);
  M.setField(b, "sc_3", "pitfalls", ["avoid melodrama", "nothing glossy"]);
  assert.deepEqual(b.scenes.sc_3.constraints, ["restrained, understated performance", "naturalistic, lived-in textures"]);
  const ctx = M.getBookContext(b, s, "sc_3");
  assert.deepEqual(ctx.prompt.constraints, ["restrained, understated performance", "naturalistic, lived-in textures"]);
  assert.ok(!/avoid|glossy/i.test(ctx.prompt.constraints.join(" ")));
});

test("notes: placed, moved by drag, recategorised, removed; character notes reach every scene of theirs", () => {
  const s = script(), b = M.emptyBook(s);
  const [a, c, u] = M.addPlacements(b, [
    { text: "sc2 — keep Mara's face in shadow", scope: "scene", scene_id: "sc_2", line: null, category: "lighting", confidence: 0.95, why: "the note names scene 2" },
    { text: "Mara never smiles until the surf", scope: "character", character: "MARA", category: "performance", confidence: 0.6 },
    { text: "fix the thing later", scope: "unsorted", category: "blocking", confidence: 0 },
  ]);
  assert.equal(M.unsortedNotes(b).length, 1);
  assert.deepEqual(M.notesForScene(b, s, "sc_3").map((n) => n.id), [c.id]);
  assert.ok(M.notesForScene(b, s, "sc_2").some((n) => n.id === a.id));
  M.moveNote(b, u.id, { scope: "scene", scene_id: "sc_1", line: 8 });
  assert.equal(M.notesOnLine(b, "sc_1", 8)[0].id, u.id);
  assert.equal(b.notes.find((n) => n.id === u.id).by, "director");
  M.moveNote(b, a.id, { category: "camera" });
  assert.equal(b.notes.find((n) => n.id === a.id).category, "camera");
  M.removeNote(b, c.id);
  assert.equal(M.notesForScene(b, s, "sc_3").length, 0);
});

test("shorthand splits into one note a line (bullets and numbering stripped)", () => {
  assert.deepEqual(M.splitShorthand("- sc2 shadow\n\n• chase: low\n3. Ezra never looks\n  "), ["sc2 shadow", "chase: low", "Ezra never looks"]);
});

test("getBookContext: spine, core, rules, scene notes and decisions, compact for a 4B model", () => {
  const s = script(), b = M.emptyBook(s);
  M.setBookField(b, "spine", "A woman takes back her father's car and learns to let it go.");
  M.setField(b, "sc_2", "core", "Escape, not victory.");
  M.addPlacements(b, [{ text: "no handheld anywhere", scope: "global", category: "camera", confidence: 0.6 },
    { text: "chase: low & fast, no music till the crash", scope: "scene", scene_id: "sc_2", line: 1, category: "camera", confidence: 0.85 }]);
  M.recordDecision(b, { command: "make it rain harder", calls: [{ tool: "weather" }], results: [{ ok: true }], sceneId: "sc_2" });
  const ctx = M.getBookContext(b, s, "sc_2");
  assert.match(ctx.text, /^Spine: A woman takes back/);
  assert.match(ctx.text, /This scene's core: Escape, not victory\./);
  assert.match(ctx.text, /Rule: no handheld anywhere/);
  assert.match(ctx.text, /Note \[camera\]: chase: low & fast/);
  assert.match(ctx.text, /Decided earlier: make it rain harder/);
  assert.ok(ctx.text.length <= 900);
  assert.equal(M.getBookContext(b, s, "sc_3").notes.length, 0);
});

test("recordDecision skips undo / play / renders and keeps the 40 newest", () => {
  const b = M.emptyBook(script());
  assert.equal(M.recordDecision(b, { command: "undo", calls: [{ tool: "undo" }] }), null);
  assert.equal(M.recordDecision(b, { command: "render shot 2", calls: [{ tool: "render" }], results: [{ ok: true }] }), null);
  assert.equal(M.recordDecision(b, { command: "50mm on shot 2", calls: [{ tool: "lens" }], results: [{ ok: true }], sceneId: "sc_1" }).category, "camera");
  for (let i = 0; i < 50; i++) M.recordDecision(b, { command: `move Mara ${i}`, calls: [{ tool: "move" }], results: [{ ok: true }] });
  assert.equal(b.notes.filter((n) => n.source === "chat").length, 40);
});

test("revisions: colours in industry order, with what changed", () => {
  const b = M.emptyBook(script());
  const r1 = M.addRevision(b);
  assert.equal(r1.colour, "White");
  M.setField(b, "sc_1", "core", "x");
  const r2 = M.addRevision(b, "After the table read");
  assert.equal(r2.colour, "Blue");
  assert.deepEqual(r2.changed, ["sc_1"]);
});

test("floor plan: actors, marks 1 → 2, dashed moves, cameras lettered A/B/C", () => {
  const st = chase(), rows = M.cameraPlan(st, { sceneNumber: "2" });
  const svg = floorPlanSVG(st, rows);
  assert.match(svg, /^<svg/);
  for (const L of ["A", "B", "C"]) assert.ok(svg.includes(`>${L}</text>`), `camera ${L}`);
  assert.ok(svg.includes("stroke-dasharray=\"6 4\""), "dashed move arrows");
  assert.ok(svg.includes(">1</text>") && svg.includes(">2</text>"), "start and end marks");
  assert.match(svg, /Mara \(Sports Car\)/);
  assert.match(svg, /Deputy Cole \(Police Car\)/);
  assert.ok(!/NaN|undefined/.test(svg));
  const p = floorPlanSVG(st, rows, { theme: "print" });
  assert.ok(p.includes("#ffffff"));
  assert.equal(moveArrowSVG("static"), "");
  assert.match(moveArrowSVG("push in 3.0 m"), /<line/);
});

test("print binder and Markdown: cover, contents, a sheet set per scene, sources credited", () => {
  const s = script(), b = M.emptyBook(s);
  M.setBookField(b, "spine", "Take it back, then let it go.");
  M.addPlacements(b, [{ text: "hawk cry over the key toss", scope: "scene", scene_id: "sc_1", line: 5, category: "sound", confidence: 0.85 }]);
  const st = chase();
  const pages = s.scenes.map((sc) => M.pageFor(b, s, sc, sc.id === "sc_2" ? st : null));
  const html = printHTML(b, s, pages, { plans: { sc_2: floorPlanSVG(st, pages[1].shots, { theme: "print" }) } });
  assert.match(html, /^<!doctype html>/);
  assert.equal((html.match(/<section class="sheet/g) || []).length, 2 + 3 * s.scenes.length + 1);
  assert.match(html, /Take it back, then let it go\./);
  assert.match(html, /hawk cry over the key toss/);
  assert.match(html, /Godfather Notebook/);
  const md = M.toMarkdown(b, s, pages);
  assert.match(md, /^# Last Light on Route 9/);
  assert.match(md, /\| 2A \| Wide crane \| 28 mm/);
  assert.match(md, /## About this book/);
  assert.ok(!/undefined|\[object/.test(md + html));
});
