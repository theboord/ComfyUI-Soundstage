// Video → 3D fail-safes (web/ui/v2sfix.mjs): ↻ Regenerate's lock flags and merge, Fix this object's request and swap,
// Remove / Undo, the source-frame click, and the wiring in the App and the try-it demo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCKS, lockFlags, newSeed, regenBody, mergeLocked, stagesLine, swapActor, removeActor, FixUndo, fixBody,
  nearestSample, coverToSource, fixesFor, fixPlan, activityName } from "../../web/ui/v2sfix.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const cur = {
  shots: [{ id: "shot_1", camera_keys: [{ frame: 0, position: [0, 1.6, -4] }, { frame: 50, position: [1, 1.6, -4] }] }],
  camera_keys: [{ frame: 0, position: [0, 1.6, -4] }],
  video2stage: { tag: "9f42fe9c48", xform: { A: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], b: [0, 1, 0] }, solve: { rms_px: 0.8 } },
  actors: [
    { id: "dancer", kind: "woman", mocap: { file: "a.json" }, height_m: 1.7, position: [0, 0, 2] },
    { id: "tree", kind: "tree", set_piece: true, position: [3, 0, 9], name: "Tree (moved by hand)" },
    { id: "v2s_backdrop", kind: "glb", set_xform: { scale: 2 } },
    { id: "bin", kind: "custom", position: [1, 0, 3] },
  ],
};
const fresh = {
  shots: [{ id: "shot_1", camera_keys: [{ frame: 0, position: [9, 9, 9] }] }],
  camera_keys: [{ frame: 0, position: [9, 9, 9] }],
  video2stage: { tag: "9f42fe9c48", xform: { A: [[2, 0, 0], [0, 2, 0], [0, 0, 2]], b: [0, 2, 0] } },
  actors: [
    { id: "dancer", kind: "woman", mocap: { file: "b.json" }, height_m: 1.69, position: [0, 0, 2.2] },
    { id: "tree", kind: "tree", set_piece: true, position: [3.3, 0, 8] },
    { id: "bench", kind: "custom", set_piece: true, position: [-2, 0, 6] },
    { id: "v2s_backdrop", kind: "glb", set_xform: { scale: 2.1 } },
    { id: "bin", kind: "custom", position: [1.2, 0, 3] },
  ],
};

test("lock flags: always the three, booleans; a new seed is never 0 nor the last", () => {
  assert.deepEqual(LOCKS.map((l) => l[0]), ["camera", "performer", "set"]);
  assert.deepEqual(lockFlags({ camera: 1, junk: true }), { camera: true, performer: false, set: false });
  assert.deepEqual(lockFlags(), { camera: false, performer: false, set: false });
  assert.equal(newSeed(1, () => 0.5), 1 + Math.floor(0.5 * 2_000_000_000));
  assert.equal(newSeed(1, () => 0), 2);                         // rand 0 -> 1, the last seed: the next one instead
  assert.ok(newSeed(0, () => 0) >= 1);
});

test("regenerate body: the chooser's options, the last run's tag, a new seed and the locks", () => {
  const b = regenBody({ video: "v5/clip.mp4", options: { samples: 16, quality: "fast" }, last: { tag: "9f42fe9c48", seed: 5 },
    lock: { camera: true }, seed: 77 });
  assert.deepEqual(b, { samples: 16, quality: "fast", video: "v5/clip.mp4", original: "", tag: "9f42fe9c48", seed: 77,
    lock: { camera: true, performer: false, set: false } });
  assert.ok(regenBody({ video: "c.mp4", last: { seed: 3 } }).seed !== 3);
});

test("regenerate merge: nothing locked = the new run, as it came", () => {
  assert.deepEqual(mergeLocked(cur, fresh, {}), fresh);
});

test("regenerate merge: a locked camera keeps your camera keys and the solve's transform", () => {
  const m = mergeLocked(cur, fresh, { camera: true });
  assert.deepEqual(m.shots[0].camera_keys, cur.shots[0].camera_keys);
  assert.deepEqual(m.camera_keys, cur.camera_keys);
  assert.deepEqual(m.video2stage.xform, cur.video2stage.xform);
  assert.equal(m.video2stage.tag, "9f42fe9c48");
  assert.equal(m.actors.find((a) => a.id === "tree").position[0], 3.3);   // the set was not locked: new
});

test("regenerate merge: a locked performer and set keep yours (edits included); the rest is new", () => {
  const m = mergeLocked(cur, fresh, { performer: true, set: true });
  const by = Object.fromEntries(m.actors.map((a) => [a.id, a]));
  assert.equal(by.dancer.mocap.file, "a.json");
  assert.equal(by.tree.name, "Tree (moved by hand)");
  assert.equal(by.v2s_backdrop.set_xform.scale, 2);
  assert.equal(by.bench, undefined);                                        // a new run's set piece goes with the set lock
  assert.equal(by.bin.position[0], 1.2);                                    // things that are neither: the new run's
  assert.equal(new Set(m.actors.map((a) => a.id)).size, m.actors.length);
  assert.deepEqual(m.shots[0].camera_keys, fresh.shots[0].camera_keys);    // camera not locked
  assert.equal(cur.actors[0].mocap.file, "a.json");                         // inputs untouched
});

test("stages line: what a regenerate kept and re-ran, in words", () => {
  assert.equal(stagesLine({ depth: "reused", camera: "reused", breakdown: "ran", mocap: "ran" }),
    "depth kept · camera solve kept · set read re-run · performer re-run");
});

test("fix: the request names the object, the click, the rebuild's tag and transform", () => {
  const b = fixBody({ video: "v5/clip.mp4", scene: cur, actor: cur.actors[1], pick: { sample: 4, point: { x: 0.25, y: 0.5 } }, seed: 3 });
  assert.equal(b.mode, "fix"); assert.equal(b.tag, "9f42fe9c48"); assert.equal(b.seed, 3); assert.equal(b.sample, 4);
  assert.deepEqual(b.point, { x: 0.25, y: 0.5 }); assert.equal(b.actor.id, "tree"); assert.equal(b.label, "Tree (moved by hand)");
  assert.deepEqual(b.xform, cur.video2stage.xform); assert.ok(b.ids.includes("bin"));
  const esc = fixBody({ video: "c.mp4", scene: cur, actor: cur.actors[3], pick: { sample: 2 } });
  assert.equal(esc.sample, 2); assert.equal(esc.point, undefined);          // Esc: the server seeds from the projection
  const add = fixBody({ video: "c.mp4", scene: cur, mode: "add", pick: { sample: 1, point: { x: 0.9, y: 0.8 } }, last: { tag: "aaaaaaaaaa" } });
  assert.equal(add.mode, "add"); assert.equal(add.actor, undefined); assert.equal(add.tag, "aaaaaaaaaa");
});

test("fix: the new version swaps in by id and Undo brings the old one back", () => {
  const undo = new FixUndo(2);
  const v2 = { ...cur.actors[1], kind: "glb", url: "/view?filename=t.glb", version: 2 };
  undo.push(cur, "Fixed Tree");
  const { scene, previous } = swapActor(cur, v2);
  assert.equal(previous.kind, "tree");
  assert.equal(scene.actors.find((a) => a.id === "tree").url, "/view?filename=t.glb");
  assert.equal(scene.actors.length, cur.actors.length);
  const added = swapActor(scene, { id: "red_bin", kind: "custom", set_piece: true });
  assert.equal(added.previous, null); assert.equal(added.scene.actors.length, cur.actors.length + 1);
  assert.equal(undo.peek().label, "Fixed Tree");
  assert.equal(undo.pop().scene.actors.find((a) => a.id === "tree").kind, "tree");
  assert.equal(undo.pop(), null);
  for (let i = 0; i < 5; i++) undo.push(cur, `x${i}`);
  assert.equal(undo.size, 2); assert.equal(undo.peek().label, "x4");      // capped
});

test("remove (not in the video): it goes, riders let go, Undo can put it back", () => {
  const s = { actors: [{ id: "car", kind: "car" }, { id: "driver", kind: "man", mount_id: "car" }] };
  const { scene, removed } = removeActor(s, "car");
  assert.equal(removed.id, "car"); assert.deepEqual(scene.actors, [{ id: "driver", kind: "man" }]);
  assert.equal(removeActor(s, "nope").removed, null);
  assert.equal(s.actors.length, 2);
});

test("which objects offer fixes: set pieces and things, never the performer or the set scan", () => {
  assert.deepEqual(fixesFor(cur.actors[1]), ["fix", "remove"]);
  assert.deepEqual(fixesFor(cur.actors[3]), ["fix", "remove"]);
  assert.deepEqual(fixesFor(cur.actors[0]), []);
  assert.deepEqual(fixesFor(cur.actors[2]), []);
  assert.deepEqual(fixesFor(null), []);
});

test("a click on the source: the nearest sample, and cover-fit pixels -> 0-1 of the picture", () => {
  const t = [0, 0.33, 0.66, 0.99];
  assert.equal(nearestSample(t, 0), 0); assert.equal(nearestSample(t, 9), 1); assert.equal(nearestSample(t, 100), 3);
  assert.deepEqual(coverToSource(640, 360, 1280, 720, 1280, 720), { x: 0.5, y: 0.5 });
  // a 16:9 picture in a square box: cover crops the sides
  const p = coverToSource(0, 500, 1000, 1000, 1600, 900);
  assert.ok(Math.abs(p.x - (1000 * 1600 / 900 - 1000) / 2 / (1000 * 1600 / 900)) < 1e-9 && p.y === 0.5);
});

test("job card plan and Activity names for the fix jobs", () => {
  assert.match(fixPlan("add")[1].label, /missed object/);
  assert.ok(fixPlan().find((s) => s.match.test("Tracking the object over the clip (SAM 3.1)")));
  assert.ok(fixPlan().find((s) => s.match.test("Rebuilding the object alone (Photo → 3D)")));
  assert.equal(activityName("fix", "object track", "Tree"), "Video → 3D · fix Tree: object track");
  assert.equal(activityName("regenerate", "shot breakdown"), "Video → 3D · regenerate: shot breakdown");
});

test("the App wires ↻ Regenerate, the fixes, Undo and the Activity names; the demo says it needs the full install", () => {
  const app = readFileSync(join(ROOT, "web", "soundstage.js"), "utf8");
  assert.match(app, /\/soundstage\/video2stage\/regenerate/);
  assert.match(app, /\/soundstage\/video2stage\/fix_object/);
  assert.match(app, /key: "regen", label: REGEN_LABEL/);
  assert.match(app, /onFix: \(id, pick\) => fixObject\(id, pick\), onRemove: \(id\) => removeInvented\(id\), onAdd: \(pick\) => addMissed\(pick\)/);
  assert.match(app, /mergeLocked\(before, scene, regen\.lock\)/);
  assert.match(app, /new CustomEvent\(JOB_EVENT/);
  const cmp = readFileSync(join(ROOT, "web", "ui", "v2scompare.mjs"), "utf8");
  for (const k of ["refit", "remove", "add-missed"]) assert.match(cmp, new RegExp(`"${k}"`));
  const demo = readFileSync(join(ROOT, "tools", "tryit", "shell", "scripts", "api.js"), "utf8");
  const i = demo.indexOf("(regenerate|fix_object)"), j = demo.indexOf("(video2stage|mocap)");
  assert.ok(i > 0 && i < j, "the specific note comes before the generic Video to 3D one");
});
