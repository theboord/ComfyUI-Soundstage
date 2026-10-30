// node --test tests/js/strip.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { appendSetups, presetCamera, readSaved, syncCut } from "../../web/cut/strip.mjs";

const S = (id, seconds = null) => ({ id, name: id, setup: "single", seconds });

test("readSaved accepts the old cut-only array and the full object", () => {
  assert.deepEqual(readSaved([{ shot_id: "a", in: 0, out: 5 }]), { cut: [{ shot_id: "a", in: 0, out: 5 }] });
  assert.deepEqual(readSaved({ cut: [], audio: [1] }), { cut: [], audio: [1] });
  assert.deepEqual(readSaved(undefined), {});
});

test("appendSetups continues the scene clock and pulls back when the take would run out", () => {
  const cut = appendSetups([], ["a", "b", "c"], [S("a"), S("b", 1), S("c", 2)], { fps: 24, frames: 97 });
  assert.deepEqual(cut, [
    { shot_id: "a", in: 0, out: 72 },   // 3 s default
    { shot_id: "b", in: 72, out: 96 },  // continues the action, 1 s
    { shot_id: "c", in: 49, out: 97 },  // 2 s would overrun 97: pulled back
  ]);
  assert.deepEqual(appendSetups([], ["x"], [S("x", 10)], { fps: 24, frames: 50 })[0], { shot_id: "x", in: 0, out: 50 });
});

test("syncCut: deleted setups leave, new ones append in stage order, removed-on-purpose stay out", () => {
  const setups = [S("a"), S("b"), S("c"), S("d", 1)];
  const saved = { cut: [{ shot_id: "a", in: 0, out: 24 }, { shot_id: "gone", in: 0, out: 24 }, { shot_id: "b", in: 24, out: 48 }] };
  const res = syncCut(saved, setups, { fps: 24, frames: 97, lastIds: new Set(["a", "gone", "b"]) });
  assert.deepEqual(res.removed, ["gone"]);
  assert.deepEqual(res.added, ["c", "d"]);
  assert.deepEqual(res.cut.map((e) => e.shot_id), ["a", "b", "c", "d"]);
  assert.deepEqual(res.cut[2], { shot_id: "c", in: 25, out: 97 }); // 3 s from scene frame 48 would overrun: pulled back
  assert.equal(res.changed, true);
  // "b" was in the cut and the Cut editor took it out: remembered, not added back
  const res2 = syncCut({ cut: [{ shot_id: "a", in: 0, out: 24 }] }, [S("a"), S("b")], { lastIds: new Set(["a", "b"]) });
  assert.deepEqual(res2.excluded_shots, ["b"]);
  assert.deepEqual(res2.added, []);
  // already excluded + nothing new: no change
  const res3 = syncCut({ cut: [{ shot_id: "a", in: 0, out: 24 }], excluded_shots: ["b"] }, [S("a"), S("b")], { lastIds: new Set(["a"]) });
  assert.equal(res3.changed, false);
  // an excluded setup that comes back into the cut (e.g. via the editor) is no longer excluded
  const res4 = syncCut({ cut: [{ shot_id: "b", in: 0, out: 24 }], excluded_shots: ["b"] }, [S("b")], {});
  assert.deepEqual(res4.excluded_shots, []);
});

test("presetCamera frames the two subjects and keeps the camera's side of the line", () => {
  const actors = [{ id: "A", position: [-1, 0, 0], height_m: 1.8 }, { id: "B", position: [1, 0, 0], height_m: 1.7 }];
  const front = { position: [0, 1.6, 5], target: [0, 1.2, 0] };
  const back = { position: [0, 1.6, -5], target: [0, 1.2, 0] };
  for (const setup of ["master", "wide", "two_shot", "ots_a", "ots_b", "single_a", "single_b", "insert", "pov"]) {
    const c = presetCamera(setup, actors, front);
    assert.equal(c.position.length, 3);
    assert.ok(c.focal_mm >= 18 && c.focal_mm <= 100, setup);
    if (setup !== "pov") assert.ok(c.position[2] > 0, `${setup} stays on the front side`);
    const b = presetCamera(setup, actors, back);
    if (setup !== "pov") assert.ok(b.position[2] < 0, `${setup} stays on the back side`);
  }
  const ots = presetCamera("ots_a", actors, front);
  assert.ok(ots.position[0] < -1, "OTS A sits behind A");
  assert.deepEqual(ots.target, [1, +(0.92 * 1.7 - 0.05).toFixed(3), 0], "and looks at B's eyes");
  assert.ok(presetCamera("wide", actors, front).position[2] > presetCamera("master", actors, front).position[2], "wide is further back");
  assert.equal(presetCamera("master", [], front), null);
  assert.ok(presetCamera("single_a", [actors[0]], front), "one subject works too");
});
