// node --test tests/js/tryit_scriptload.test.mjs
// Load a script in the try-it demo (tools/tryit/shell/scriptload.mjs, demo.mjs, api.js): the bundled samples break down
// with the App's own importer (web/script/parse.mjs + breakdown.mjs; there is no server-side parser to port), the
// Final Draft and Fountain paths give the same breakdown for the same pages, every scene of a sample has a recorded
// example to replay, and that replay is labelled as an example, never as the visitor's own render.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseScript, stageSetupForScene } from "../../web/script/parse.mjs";
import { SAMPLES, EXAMPLES, NEAREST, STREET, STREET_CAR, pastedName, closestExample, scriptSig } from "../../tools/tryit/shell/scriptload.mjs";
import { REPLAYED, LIVE, provenanceNow, replayNotice, exampleNote, stopProvenance } from "../../tools/tryit/shell/provenance.mjs";

const TRYIT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "tryit");
const read = (...p) => readFileSync(join(TRYIT, ...p), "utf8");
const scenes = Object.fromEntries(readdirSync(join(TRYIT, "scenes")).filter((f) => f.endsWith(".json"))
  .map((f) => [f.replace(/\.json$/, ""), JSON.parse(read("scenes", f))]));
const sample = (id) => SAMPLES.find((s) => s.id === id);
const parsed = (id) => parseScript(read("shell", sample(id).file), { name: sample(id).name });

// Final Draft XML -> Fountain, paragraph by paragraph (a second import path for the same pages).
function fdxToFountain(xml) {
  const body = xml.slice(xml.indexOf("<Content>"), xml.indexOf("</Content>"));
  const out = [];
  for (const m of body.matchAll(/<Paragraph Type="([^"]+)"><Text>([\s\S]*?)<\/Text><\/Paragraph>/g)) {
    const [, type, text] = m;
    if (type === "Scene Heading" || type === "Action" || type === "Transition") out.push("", text);
    else if (type === "Character") out.push("", text);
    else out.push(text);   // Parenthetical, Dialogue: straight under the cue
  }
  return out.join("\n").trim() + "\n";
}
// What the demo shows of a script: the outline, who is in each scene, the breakdown and how the stage sets up.
const shape = (s) => s.scenes.map((sc) => ({ heading: sc.heading, int_ext: sc.int_ext, location: sc.location, time: sc.time,
  characters: sc.characters, breakdown: sc.breakdown, setup: stageSetupForScene(sc) }));

test("the samples: original short scripts in each format the App reads, shipped as web media types", () => {
  assert.deepEqual(SAMPLES.map((s) => s.format), ["Fountain", "Final Draft (.fdx)", "PDF"]);
  for (const s of SAMPLES) {
    assert.match(s.file, /^samples\/[a-z_]+\.(fountain\.txt|fdx\.txt|pdf)$/, s.file);
    assert.match(s.name, /\.(fountain|fdx|pdf)$/, `${s.id}: the File name picks the importer`);
    const bytes = readFileSync(join(TRYIT, "shell", s.file));
    assert.ok(bytes.length > 500 && bytes.length < 200_000, `${s.id}: ${bytes.length} bytes`);
    if (s.format === "PDF") assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    else assert.match(bytes.toString(), /original sample/i, `${s.id}: says it is an original sample`);
  }
});

test("Low Tide (Fountain) breaks down: four scenes, two speaking parts, the dog and the truck", () => {
  const s = parsed("low_tide");
  assert.equal(s.title, "Low Tide");
  assert.equal(s.format, "fountain");
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.scenes.map((x) => x.heading), ["EXT. BEACH - SUNSET", "INT. HARBOR DINER - NIGHT", "EXT. CLIFF ROAD - NIGHT", "INT. PICKUP TRUCK - CONTINUOUS"]);
  assert.deepEqual(s.characters.map((c) => c.name), ["JUNE", "CAL"]);
  assert.deepEqual(s.scenes[0].breakdown.animals, ["dog"]);
  assert.ok(s.scenes[2].breakdown.vehicles.some((v) => /truck/.test(v)), "scene 3 has the pickup");
  assert.deepEqual(s.scenes.map((x) => stageSetupForScene(x).set), ["beach", "interior", "street_night", "interior"]);
});

test("The Night Train (Final Draft) breaks down: three scenes, Odessa and Finn, the platform at dawn", () => {
  const s = parsed("night_train");
  assert.equal(s.title, "The Night Train");
  assert.equal(s.format, "fdx");
  assert.deepEqual(s.scenes.map((x) => x.heading), ["INT. TRAIN - PASSENGER CAR - NIGHT", "EXT. TRAIN STATION PLATFORM - DAWN", "EXT. PINE FOREST - NIGHT"]);
  assert.deepEqual(s.characters.map((c) => c.name), ["ODESSA", "FINN"]);
  assert.equal(stageSetupForScene(s.scenes[1]).time_preset, "dawn");
  assert.equal(stageSetupForScene(s.scenes[2]).set, "forest");
});

test("the same pages through the Final Draft and the Fountain importer give the same breakdown", () => {
  const fdx = parsed("night_train");
  const ftn = parseScript(fdxToFountain(read("shell", sample("night_train").file)), { name: "night_train.fountain" });
  assert.equal(ftn.format, "fountain");
  assert.deepEqual(shape(ftn), shape(fdx));
  assert.deepEqual(ftn.characters.map((c) => [c.name, c.scenes]), fdx.characters.map((c) => [c.name, c.scenes]));
});

test("pasted text goes down the right importer path", () => {
  assert.equal(pastedName(read("shell", sample("night_train").file)), "pasted.fdx");
  assert.equal(pastedName(read("shell", sample("low_tide").file)), "pasted.fountain");
  assert.equal(pastedName("INT. KITCHEN - NIGHT\n\nMAYA waits."), "pasted.fountain");
  assert.equal(pastedName(""), "pasted.fountain");
  assert.equal(pastedName(null), "pasted.fountain");
});

test("every recorded example the demo can borrow exists and has renders", () => {
  for (const ex of [...Object.values(EXAMPLES), ...Object.values(NEAREST), STREET, STREET_CAR]) {
    const r = scenes[ex.scene]?.props?.ss_renders?.[ex.shot];
    assert.ok(r && (r.look || r.draft), `${ex.scene}/${ex.shot} has a recorded look or draft`);
    assert.ok(ex.label.length > 4, `${ex.scene}: a label for the note`);
  }
});

test("the closest example follows the stage's set; the street picks the chase when there is a car", () => {
  const at = (set, kinds = []) => closestExample({ environment: { set }, actors: kinds.map((kind) => ({ kind })) });
  assert.equal(at("beach").scene, "romance");
  assert.equal(at("desert").scene, "western");
  assert.equal(at("forest").scene, "horror");
  assert.equal(at("burning_building").scene, "fire");
  assert.deepEqual([at("street_night", ["man", "sports_car"]).shot, at("street_night", ["man"]).shot], ["tracking", "crane"]);
  for (const set of ["interior", "train_station", "runway"]) assert.equal(at(set).exact, false, `${set}: no recorded set like it`);
  assert.equal(at("beach").exact, true);
  assert.equal(closestExample(null).scene, "chase", "no stage: the street default");
  assert.equal(at("somewhere_new", ["truck"]).shot, "tracking");
});

test("every scene of every text sample has an example to replay", () => {
  for (const id of ["low_tide", "night_train"]) {
    for (const sc of parsed(id).scenes) {
      const ex = closestExample({ environment: { set: stageSetupForScene(sc).set || "street_night" }, actors: [] });
      assert.ok(scenes[ex.scene]?.props?.ss_renders?.[ex.shot], `${id} ${sc.heading}: ${ex.scene}/${ex.shot}`);
    }
  }
});

test("scriptSig tells the visitor's script from the one a scene shipped with", () => {
  const dry = scenes.drycreek.props.ss_script;
  assert.equal(scriptSig(undefined), "");
  assert.equal(scriptSig({ script: { scenes: [] } }), "");
  assert.ok(scriptSig(dry));
  assert.equal(scriptSig(dry), scriptSig(structuredClone(dry)));
  assert.notEqual(scriptSig({ script: parsed("low_tide") }), scriptSig(dry));
});

test("a replayed example is Replayed and says it is not the visitor's shot, on every render step and above the frames", () => {
  const ex = closestExample({ environment: { set: "beach" } });
  const r = scenes.romance.props.ss_renders.silhouette;
  const scene = { renders: { sc_1__shot_1: r }, candidates: {}, examples: { sc_1__shot_1: ex } };
  for (const step of ["frame", "motion", "review", "deliver"]) {
    const p = provenanceNow({ step, shot: "sc_1__shot_1", scene });
    assert.equal(p.mode, REPLAYED, step);
    assert.match(p.note, /recorded example, not your shot/, step);
    assert.match(p.note, /Romance: beach at sunset/, step);
  }
  assert.equal(provenanceNow({ step: "set", shot: "sc_1__shot_1", scene }).mode, LIVE, "the stage itself is live");
  // Before Run there is no example yet: the step says the shot has nothing recorded.
  assert.equal(provenanceNow({ step: "frame", shot: "sc_2__shot_1", scene }).mode, LIVE);
  const n = replayNotice({ step: 2, edited: false, example: ex });
  assert.equal(n.mode, REPLAYED);
  assert.match(n.note, /^This plays a recorded example, not your shot/);
  assert.match(n.toast, /not your script's shot/);
  assert.equal(replayNotice({ step: 2, edited: false }), null, "an untouched demo scene still has no note");
  assert.match(exampleNote({ ...ex, exact: false, set: "train_station" }), /nearest recorded example \(nothing was rendered on a train station set\)/);
});

test("the shell wires it: the bar button, the first screen, the loader, the scene entry and the tour stop", () => {
  const html = read("shell", "index.html"), demo = read("shell", "demo.mjs"), tour = JSON.parse(read("shell", "tour.json"));
  for (const id of ["scriptBtn", "heroScript", "scriptDlg", "scriptSamples", "scriptPaste", "scriptPasteGo", "scriptFile"])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /\.pdf/, "the loader names PDF");
  assert.match(demo, /\["script", "Load a script/, "the scene picker lists the entry");
  assert.match(demo, /async loadscript\(\)/, "the tour action");
  assert.match(demo, /demo\.resolveShot = async/, "the example hook");
  assert.match(demo, /input\[type="file"\]/, "samples go through ① Script's own file input");
  const stop = tour.steps.find((s) => s.id === "script");
  assert.ok(stop && stop.scene === "script" && stop.do === "loadscript", "the tour stop");
  assert.equal(stopProvenance(stop).mode, LIVE, "loading and breaking down a script is live");
});

// ---------------------------------------------------------------- api.js: the scene agent's note, the example hook
const toasts = [];
globalThis.fetch = async () => new Response("missing", { status: 404 });
const { api, demo } = await import("../../tools/tryit/shell/scripts/api.js");
demo.toast = (m) => toasts.push(m);

test("api.js: Build this scene says where the scene agent runs and that the scene is already set up", async () => {
  const r = await api.fetchApi("/soundstage/agent/build", { method: "POST", body: JSON.stringify({ text: "x" }) });
  const j = await r.json();
  assert.equal(r.status, 503);
  assert.match(j.error, /^The scene agent .* is available in the full install/);
  assert.match(j.error, /already set it up from its heading, in your browser: open ③ Set\./);
  const other = await (await api.fetchApi("/soundstage/layerpack/x")).json();
  assert.match(other.error, /This demo replays renders made earlier\.$/, "the other notes keep their ending");
});

test("api.js: Run asks the shell for an example first, then replays it", async () => {
  const r = scenes.romance.props.ss_renders.silhouette;
  demo.scene = { renders: {}, candidates: {} };
  demo.getShot = () => "sc_1__shot_1";
  demo.getStep = () => 2;
  const asked = [];
  demo.resolveShot = async (shot) => { asked.push(shot); demo.scene.renders[shot] = structuredClone(r); };
  const out = [];
  const onExec = (e) => out.push(e.detail);
  api.addEventListener("executed", onExec);
  // Wait for the replay's own end (execution_success), not a fixed 900 ms: its rungs end ~730 ms after Run, so a
  // loaded machine that stalled the test process for ~200 ms failed it (intermittent, on main too). 10 s cap.
  const { prompt_id } = await api.queuePrompt();
  await new Promise((res) => {
    const cap = setTimeout(done, 10_000);
    function done() { clearTimeout(cap); api.removeEventListener("execution_success", onDone); res(); }
    function onDone(e) { if (e.detail?.prompt_id === prompt_id) done(); }
    api.addEventListener("execution_success", onDone);
  });
  api.removeEventListener("executed", onExec);
  assert.deepEqual(asked, ["sc_1__shot_1"]);
  const files = out.map((x) => x?.output?.images?.[0]?.filename);
  assert.ok(files.includes(r.look.filename || r.look), `the example's look replays (${files.join(", ")})`);
  demo.resolveShot = null;
});
