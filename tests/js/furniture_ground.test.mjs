// A walk past furniture is a walk on the floor (agent test-scene report, 2026-11-08). A walk passing ~0.25 m from a
// chair hopped the woman ~1 m into the air for frames 16-44, in the stage passes themselves: the height table took the
// chair's bounding-box top (0.92 m, its back) as ground within 18 cm of the path. Furniture tops are ground only when
// the prop is climbable (crate, rock, block; or `climbable: true` on the prop), when it is no higher than a human step
// (STEP_UP, 0.3 m) over the footing, or when the person is keyed up onto it (a drag onto the table: an explicit climb).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import { Stage, STEP_UP } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";

function bareStage(actors) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 61, fps: 24 }, actors, shots: [{ id: "s" }], active_shot: "s" };
  st.actorMeshes = new Map();
  st.frame = 0;
  st.setFrame = () => A.avatarsAt(st);
  st.onChange = () => {}; st.toJSON = () => st.state;
  return st;
}
const clayOf = (st, a) => {
  const g = buildObject(a.kind, a.height_m, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })), a.appearance);
  g.position.set(...a.position);
  if (a.rotation_deg) g.rotation.y = THREE.MathUtils.degToRad(a.rotation_deg);
  g.userData.actorId = a.id;
  st.actorMeshes.set(a.id, g);
  g.updateMatrixWorld(true);
  return g;
};
/** A woman walking along x at z, 60 frames, and a prop at the origin. gap: from the path to the prop's box; or
 *  { centre: d }: from the path to the prop's position (as the report measured it). */
function scene(kind, gap = 0.25, extra = {}) {
  const prop = { id: "p1", kind, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], ...extra };
  const st0 = bareStage([prop]);
  const box = new THREE.Box3().setFromObject(clayOf(st0, prop));
  const z = typeof gap === "object" ? gap.centre : box.max.z + gap;
  const woman = { id: "w1", kind: "woman", height_m: 1.68, position: [-3, 0, z], keys: [{ frame: 0, position: [-3, 0, z] }, { frame: 60, position: [3, 0, z] }] };
  const st = bareStage([woman, prop]);
  clayOf(st, woman); clayOf(st, prop);
  st._setCollidersCached = () => [];
  return { st, woman, prop, box };
}
const heights = (st, a, fn = "_heightAt") => [...Array(61).keys()].map((f) => st[fn](a, f));
const maxOf = (v) => Math.max(...v);

test("repro: a walk 0.25 m past a chair stays on the floor (it hopped ~0.9 m for frames 16-44)", () => {
  const { st, woman, box } = scene("chair", { centre: 0.25 });
  assert.ok(woman.position[2] - box.max.z < 0.18, "the path passes within the old 18 cm margin of the chair's box");
  assert.ok(box.max.y > 0.85, `the chair's box top is its back: ${box.max.y}`);
  assert.equal(maxOf(heights(st, woman)), 0, "the height table");
  assert.ok(maxOf(heights(st, woman, "_walkHeightAt")) < 0.01, `the lifelike body height: ${maxOf(heights(st, woman, "_walkHeightAt"))}`);
  assert.equal(st._jumpsInShot(woman), false, "no hop in the shot");
  for (let f = 0; f <= 60; f++) assert.equal(st._airborneAt(woman, f), false, `f${f} on the ground`);
  // the same walk, turned chair (its box wider on the diagonal) and on the far side of it
  for (const [rot, c] of [[45, 0.25], [90, -0.25], [180, 0.3]]) {
    const r = scene("chair", { centre: c }, { rotation_deg: rot });
    assert.equal(maxOf(heights(r.st, r.woman)), 0, `chair turned ${rot}, path ${c} m from it`);
  }
});

test("furniture is not climbed by walking into it either: a chair, sofa, table or bed in the path (0.3 m and up) is not ground", () => {
  for (const kind of ["chair", "sofa", "armchair", "table", "dining_table", "desk", "bed", "kitchen_counter", "bench", "toilet", "tv"]) {
    const { st, woman } = scene(kind, -0.3);   // the path runs 0.3 m inside the box
    assert.ok(maxOf(heights(st, woman)) < 1e-9, `${kind}: ${maxOf(heights(st, woman))}`);
    assert.equal(st._jumpsInShot(woman), false, kind);
  }
});

test("a low prop within a human step is still stepped onto (a coffee table at 0.42 m is not; a rug is flat)", () => {
  assert.ok(STEP_UP >= 0.25 && STEP_UP <= 0.3, `STEP_UP ${STEP_UP}`);
  const { st, woman, prop } = scene("cube", -0.4, { climbable: false });
  const g = st.actorMeshes.get(prop.id);
  g.scale.setScalar(0.2); g.updateMatrixWorld(true);   // a 20 cm riser, flagged NOT climbable: a step is still a step
  st._obsCache = null;
  assert.ok(Math.abs(maxOf(heights(st, woman)) - 0.2) < 0.01, `steps up 20 cm: ${maxOf(heights(st, woman))}`);
  const ct = scene("coffee_table", -0.3);
  assert.ok(maxOf(heights(ct.st, ct.woman)) < 1e-9, "the coffee table (0.42 m) is walked past, not onto");
});

test("climbable props are still climbed: crates and rocks by default, any prop flagged climbable: true, never one flagged false", () => {
  for (const kind of ["crate", "rock", "cube"]) {
    const { st, woman, box } = scene(kind, -0.3);
    assert.ok(Math.abs(maxOf(heights(st, woman)) - box.max.y) < 1e-3, `${kind}: up on its top ${box.max.y}`);
    assert.equal(st._jumpsInShot(woman), true, kind);
  }
  const t = scene("table", -0.3, { climbable: true });
  assert.ok(Math.abs(maxOf(heights(t.st, t.woman)) - t.box.max.y) < 1e-3, "a table flagged climbable is hopped onto");
  const c = scene("crate", -0.3, { climbable: false });
  assert.ok(maxOf(heights(c.st, c.woman)) < 1e-9, "a crate flagged climbable: false is not");
});

test("the foot support (_supportAt) skips a furniture top over a step above the footing, but finds it once the person is up there", () => {
  const { st, box } = scene("table", 0);
  const top = box.max.y;
  assert.ok(st._supportAt(0, 0, 0) < 1e-9, `from the floor: ${st._supportAt(0, 0, 0)}`);
  assert.ok(Math.abs(st._supportAt(0, 0, top) - top) < 1e-3, "keyed up on the table (a drag onto it): stands on its top");
  const cr = scene("crate", 0);
  assert.ok(Math.abs(cr.st._supportAt(0, 0, 0.3) - cr.box.max.y) < 1e-3, "a crate is found from a hop's height, as before");
});

test("an explicit climb (keyed up onto the table, as a drag onto it does) still stands on the top", () => {
  const { st, woman, box } = scene("table", -0.5);
  const top = +box.max.y.toFixed(2);
  woman.keys = [{ frame: 0, position: [-3, 0, woman.position[2]] }, { frame: 24, position: [0, top, woman.position[2]] }, { frame: 60, position: [0, top, woman.position[2]] }];
  st._yCache = null;
  assert.ok(Math.abs(st._heightAt(woman, 40) - top) < 1e-3, `on the table: ${st._heightAt(woman, 40)}`);
  assert.ok(Math.abs(st._walkHeightAt(woman, 40) - top) < 0.02, `lifelike body on the table: ${st._walkHeightAt(woman, 40)}`);
});

test("put on furniture (a key inside its footprint, keyed at 0 as placeInFrame does): stands on it, steps down when walking off", () => {
  const { st, woman, box } = scene("table", { centre: 0 });
  woman.keys = [{ frame: 0, position: [0, 0, 0] }, { frame: 20, position: [0, 0, 0] }, { frame: 60, position: [3, 0, 0] }];
  st._yCache = null;
  assert.ok(Math.abs(st._heightAt(woman, 10) - box.max.y) < 1e-3, `on the table: ${st._heightAt(woman, 10)}`);
  assert.ok(st._heightAt(woman, 60) < 1e-9, "on the floor after walking off it");
  // the chair the report named: a walk whose keys never stand on it is not put on it
  const ch = scene("chair", { centre: 0.25 });
  assert.equal(ch.st._obstacles().length, 1);
  assert.equal(maxOf(heights(ch.st, ch.woman)), 0);
});

test("a car is an obstacle but not vaulted by a walk through it (unless flagged climbable)", () => {
  const { st, woman } = scene("car", { centre: 0 });
  assert.ok(st._obstacles().some((o) => o.id === "p1"));
  assert.equal(maxOf(heights(st, woman)), 0);
  const c = scene("car", { centre: 0 }, { climbable: true });
  assert.ok(maxOf(heights(c.st, c.woman)) > 1, "flagged climbable: over it");
});
