import test from "node:test";
import assert from "node:assert/strict";
import { castPool, defaultShotCast, shotSelection, pickRefs, refLines, refLabel, isWardrobe, matchesActor, refViewParams, REF_LIMIT }
  from "../../web/cast/shotcast.mjs";
import { castList, refPrompt } from "../../web/cast/cast.mjs";

const items = [
  { key: "character:mara", kind: "character", name: "Mara", ref: "soundstage_refs/mara.png", scenes: ["Sc 1"] },
  { key: "character:joe", kind: "character", name: "Joe", ref: "soundstage/cast/joe.png [output]", scenes: ["Sc 2"] },
  { key: "character:ana", kind: "character", name: "Ana", ref: "soundstage_refs/ana.png", scenes: ["Sc 1"] },
  { key: "location:diner", kind: "location", name: "INT. Diner", ref: "soundstage_refs/diner.png", scenes: ["Sc 1"] },
  { key: "location:road", kind: "location", name: "EXT. Road", ref: "soundstage_refs/road.png", scenes: ["Sc 2"] },
  { key: "prop:police_car", kind: "prop", name: "Police Car", ref: "soundstage_refs/car.png", scenes: ["Sc 2"] },
  { key: "prop:red_coat", kind: "prop", name: "Red Coat", ref: "soundstage_refs/coat.png", scenes: ["Sc 1"] },
  { key: "wardrobe:hat", kind: "wardrobe", name: "Stetson", scenes: ["Sc 1"] },
];
const actors = [{ id: "a1", kind: "woman", name: "Mara" }, { id: "a2", kind: "police_car", name: "Cruiser" }];

test("garments read as wardrobe", () => {
  assert.equal(isWardrobe(items[6]), true);
  assert.equal(isWardrobe(items[5]), false);
  assert.equal(isWardrobe(items[7]), true);
});

test("actors match cast items by name, vehicles by kind", () => {
  assert.equal(matchesActor(items[0], actors[0]), true);
  assert.equal(matchesActor(items[1], actors[0]), false);
  assert.equal(matchesActor(items[5], actors[1]), true);
  assert.equal(matchesActor(items[0], actors[1]), false);
});

test("pool adds stage-only references and the style ref, not duplicates", () => {
  const refs = { "actor:a1": "soundstage_refs/mara.png", "actor:a9": "x.png", "actor:a2": "soundstage_refs/cruiser.png", style: "soundstage_refs/look.png" };
  const pool = castPool(items, [...actors, { id: "a9", kind: "man", name: "Extra" }], refs, (f) => `/view/${f}`);
  assert.equal(pool.filter((x) => x.ref === "soundstage_refs/mara.png").length, 1);
  assert.ok(pool.find((x) => x.key === "actor:a9" && x.kind === "character" && x.url === "/view/x.png"));
  assert.ok(!pool.find((x) => x.key === "actor:a2"), "police car already has a cast picture");
  assert.ok(pool.find((x) => x.key === "ref:style" && x.kind === "style"));
});

test("defaults: actors on stage + the scene's characters and location", () => {
  const keys = defaultShotCast(items, { actors, sceneLabel: "Sc 1" });
  assert.deepEqual(keys.sort(), ["character:ana", "character:mara", "location:diner", "prop:police_car"].sort());
  const noScript = defaultShotCast([items[0], items[3]], { actors, sceneLabel: null });
  assert.deepEqual(noScript, ["character:mara", "location:diner"], "the only location is in by default");
});

test("a saved selection wins, unknown keys dropped", () => {
  assert.deepEqual(shotSelection(items, ["prop:red_coat", "gone:x"], { actors }), ["prop:red_coat"]);
  assert.deepEqual(shotSelection(items, [], { actors }), []);
});

test("priority: characters > location > wardrobe > props, max 4, missing pictures reported", () => {
  const keys = ["prop:police_car", "prop:red_coat", "location:diner", "character:joe", "wardrobe:hat", "character:mara", "character:ana"];
  const { use, dropped, missing } = pickRefs(items, keys);
  assert.equal(REF_LIMIT, 4);
  assert.deepEqual(use.map((x) => x.key), ["character:joe", "character:mara", "character:ana", "location:diner"]);
  assert.deepEqual(dropped.map((x) => x.key), ["prop:red_coat", "prop:police_car"]);
  assert.deepEqual(missing.map((x) => x.key), ["wardrobe:hat"]);
});

test("ref_files lines carry clear labels", () => {
  const { use } = pickRefs(items, ["location:diner", "character:mara", "prop:red_coat"]);
  assert.equal(refLines(use), "soundstage_refs/mara.png | Mara — character sheet\nsoundstage_refs/diner.png | INT. Diner — location\nsoundstage_refs/coat.png | Red Coat — wardrobe");
  assert.equal(refLabel({ name: "A|B", kind: "prop" }), "A B — prop");
});

test("annotated refs become /view params", () => {
  assert.deepEqual(refViewParams("soundstage/cast/joe.png [output]"), { filename: "joe.png", subfolder: "soundstage/cast", type: "output" });
  assert.deepEqual(refViewParams("mara.png"), { filename: "mara.png", subfolder: "", type: "input" });
});

test("castList files wardrobe as its own kind", () => {
  const script = { scenes: [{ index: 0, number: 1, characters: ["MARA"], location: "DINER", int_ext: "INT",
    breakdown: { wardrobe: ["leather jacket"], props: ["cowboy hat", "shotgun"] } }] };
  const list = castList(script, null);
  assert.ok(list.find((x) => x.key === "wardrobe:leather_jacket" && x.kind === "wardrobe"));
  assert.ok(list.find((x) => x.key === "wardrobe:cowboy_hat"));
  assert.ok(list.find((x) => x.key === "prop:shotgun" && x.kind === "prop"));
  assert.match(refPrompt({ kind: "wardrobe", name: "Leather Jacket" }, "brown"), /Wardrobe reference photo of Leather Jacket, brown/);
  // A vehicle (stage kind or the breakdown's "vehicle") gets a turnaround: front, rear, profile and three-quarter.
  const car = refPrompt({ kind: "prop", name: "Sports Car", hint: "sports_car" }, "a modern red coupé");
  assert.match(car, /^Vehicle reference sheet of Sports Car, a modern red coupé: .*front view, rear view, side profile and front three-quarter view/);
  assert.match(refPrompt({ kind: "prop", name: "Van", hint: "vehicle" }), /^Vehicle reference sheet of Van:/);
  assert.match(refPrompt({ kind: "prop", name: "Lamp", hint: "lamp" }), /^Product reference photo of Lamp/);
});
