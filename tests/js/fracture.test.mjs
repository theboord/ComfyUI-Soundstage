// Milestone 24: breakable, deformable props (web/stage/fracture.mjs + the glue / split / dent side of physics.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, qyaw } from "../../web/stage/physics.mjs";
import { BREAK_MATERIALS, MAX_PIECES, breakableOf, fracturePieces, jointStrengths, snapJoints, glueGroups, groupBox, dentFor,
  dentOffset, seedOf } from "../../web/stage/fracture.mjs";

const HALF = [0.4, 0.4, 0.4];
const crate = (id, pos, { mat = "wood", seed = seedOf(id), yaw = 0, breakable = true } = {}) => {
  const cfg = BREAK_MATERIALS[mat];
  return { id, shape: "box", half: HALF, center: [0, 0.4, 0], dynamic: true, mass: 25, bounce: 0.2, friction: 0.6, material: mat,
    poses: [{ pos, quat: qyaw(yaw) }],
    ...(breakable ? { breakable: { ...fracturePieces(HALF, { material: mat, seed }), strength: cfg.strength, burst: cfg.burst, seed }, dent: cfg.dent } : {}) };
};
const car = (F, from = -8, speed = 0.5, stopAt = Infinity) => {
  const poses = [];
  for (let f = 0; f < F; f++) poses.push({ pos: [0, 0, from + Math.min(f, stopAt) * speed], quat: [0, 0, 0, 1] });
  return { id: "car#body", shape: "box", half: [0.9, 0.35, 2.2], center: [0, 0.45, 0], dynamic: false, poses, material: "metal" };
};
const boxesOverlap = (A, B) => [0, 1, 2].every((k) => Math.abs(A.off[k] - B.off[k]) < A.half[k] + B.half[k] - 1e-9);

test("fracture: wood splits into planks, cardboard into panels and lid flaps; no parts overlap; all glued in one piece", () => {
  const w = fracturePieces(HALF, { material: "wood", seed: 5 }), c = fracturePieces(HALF, { material: "cardboard", seed: 5 });
  assert.ok(w.pieces.length >= 6 && w.pieces.length <= MAX_PIECES, `wood ${w.pieces.length}`);
  assert.ok(w.pieces.every((p) => p.kind === "plank" && Math.min(...p.half) <= BREAK_MATERIALS.wood.thick / 2 + 1e-9));
  assert.equal(c.pieces.length, 7);
  assert.equal(c.pieces.filter((p) => p.kind === "flap").length, 2);
  for (const fr of [w, c]) {
    for (let i = 0; i < fr.pieces.length; i++) for (let j = i + 1; j < fr.pieces.length; j++) assert.ok(!boxesOverlap(fr.pieces[i], fr.pieces[j]), `${i}/${j} overlap`);
    // Every part sits inside the prop's box, and the glue holds the whole prop together.
    for (const p of fr.pieces) for (let k = 0; k < 3; k++) assert.ok(Math.abs(p.off[k]) + p.half[k] <= HALF[k] + 1e-9);
    assert.equal(glueGroups(fr, fr.joints.map(() => true), fr.pieces.map((_, i) => i)).length, 1);
  }
});

test("fracture determinism: the same seed gives the same parts and the same bake; another seed, other planks", () => {
  assert.deepEqual(fracturePieces(HALF, { material: "wood", seed: 11 }), fracturePieces(HALF, { material: "wood", seed: 11 }));
  assert.notDeepEqual(fracturePieces(HALF, { material: "wood", seed: 11 }).pieces, fracturePieces(HALF, { material: "wood", seed: 12 }).pieces);
  const F = 60, specs = () => [car(F), crate("c0", [0, 0, 3]), crate("c1", [0.3, 0.8, 3.1], { yaw: 0.2 })];
  const a = simulate(specs(), F), b = simulate(specs(), F);
  assert.ok(Object.keys(a.fractures).length >= 1, "the car breaks a crate");
  assert.equal(JSON.stringify(a.fractures), JSON.stringify(b.fractures));
  assert.equal(JSON.stringify(a.tracks), JSON.stringify(b.tracks));
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
});

test("glue break threshold: a joint holds below its strength and snaps above it, and only near the hit", () => {
  const fr = fracturePieces(HALF, { material: "wood", seed: 3 }), S = BREAK_MATERIALS.wood.strength;
  const str = jointStrengths(fr, S, 3), all = fr.pieces.map((_, i) => i);
  assert.ok(str.every((s) => s >= S * 0.85 - 1e-9 && s <= S * 1.15 + 1e-9));
  const jt = fr.joints[0];
  const weak = fr.joints.map(() => true);
  assert.equal(snapJoints(fr, str, weak, all, jt.p, S * 0.84).length, 0, "84% of the glue strength holds everywhere");
  const hard = fr.joints.map(() => true);
  const snapped = snapJoints(fr, str, hard, all, jt.p, S * 1.2);
  assert.ok(snapped.includes(0), "the joint at the hit snaps");
  assert.ok(snapped.length < fr.joints.length, "joints far from the hit hold");
  // In the solver: a crate dropped from a low height stays whole; a car at 12 m/s breaks it.
  const low = simulate([crate("d", [0, 0.5, 0])], 48);
  assert.deepEqual(low.fractures, {});
  const F = 40, hit = simulate([car(F), crate("c", [0, 0, 3])], F);
  const f = hit.fractures.c;
  assert.ok(f, "the car breaks the crate");
  const brk = hit.events.find((e) => e.break && e.a === "c");
  assert.ok(brk && brk.speed > S, JSON.stringify(brk));
  assert.equal(brk.frame, f.frame);
});

test("debris inherits the parent's motion: pieces leave the car's hit moving the way the car drives", () => {
  const F = 48, r = simulate([car(F), crate("c", [0, 0, 3])], F);
  const fr = r.fractures.c;
  assert.ok(fr && fr.pieces.length >= 6);
  const vz = fr.pieces.map((p) => (p.track[fr.frame + 2].pos[2] - p.track[fr.frame].pos[2]) * 12);   // m/s over two frames
  assert.ok(vz.filter((v) => v > 4).length >= fr.pieces.length / 2, `vz ${vz.map((v) => v.toFixed(1))}`);
  // Before the break every piece rides with the crate (its centre at the crate's centre plus its own offset).
  const f0 = fr.frame - 2, crateAt = r.tracks.c[f0].pos;
  for (const p of fr.pieces) for (let k = 0; k < 3; k++) assert.ok(Math.abs(p.track[f0].pos[k] - (crateAt[k] + p.center[k])) < 0.02);
  // Nothing explodes: no piece faster than the car plus a burst.
  for (const p of fr.pieces) for (let f = 1; f < F; f++) {
    const a = p.track[f - 1].pos, b = p.track[f].pos;
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 24 < 25);
  }
});

test("cardboard dents instead of breaking on a drop, and the dent persists", () => {
  const F = 60, r = simulate([crate("box", [0, 1.5, 0], { mat: "cardboard" })], F);
  assert.deepEqual(r.fractures, {}, "a 1.5 m drop crushes a carton, it doesn't burst it");
  const dents = r.dents.box;
  assert.ok(dents?.length >= 1);
  const d = dents[0];
  assert.ok(d.n[1] > 0.9, "a landing pushes the underside up into the box");
  assert.ok(d.depth > 0.03 && d.depth <= 0.45 * 0.4 + 1e-9, `depth ${d.depth}`);
  const at = [d.p[0], d.p[1], d.p[2]];
  assert.deepEqual(dentOffset(dents, d.frame - 1, at), [0, 0, 0]);
  const now = dentOffset(dents, d.frame, at), later = dentOffset(dents, F - 1, at), muchLater = dentOffset(dents, 10000, at);
  assert.ok(now[1] > 0.02);
  assert.deepEqual(later, now); assert.deepEqual(muchLater, now);
  // The far side of the box doesn't move.
  assert.deepEqual(dentOffset(dents, F, [d.p[0], d.p[1] + 0.8, d.p[2]]), [0, 0, 0]);
  // Softer hits dent less; a soft one not at all; wood never dents.
  assert.equal(dentFor(BREAK_MATERIALS.cardboard, 2, HALF), null);
  assert.ok(dentFor(BREAK_MATERIALS.cardboard, 5, HALF).depth < dentFor(BREAK_MATERIALS.cardboard, 8, HALF).depth);
  assert.equal(dentFor(BREAK_MATERIALS.wood, 20, HALF), null);
});

test("breakableOf: crates break by default, the switch turns it off, other kinds opt in; only wood and cardboard", () => {
  assert.equal(breakableOf({ kind: "crate" }, "wood").pattern, "planks");
  assert.equal(breakableOf({ kind: "crate", physics: { material: "cardboard" } }, "cardboard").pattern, "panels");
  assert.equal(breakableOf({ kind: "crate", physics: { breakable: false } }, "wood"), null);
  assert.equal(breakableOf({ kind: "cube" }, "cardboard"), null);
  assert.equal(breakableOf({ kind: "cube", physics: { breakable: true } }, "cardboard").pattern, "panels");
  assert.equal(breakableOf({ kind: "crate" }, "metal"), null);
  assert.equal(breakableOf({ kind: "crate", physics: { strength: 2 } }, "wood").strength, BREAK_MATERIALS.wood.strength * 2);
});

test("groupBox: the box round a group of parts, and its volume", () => {
  const fr = fracturePieces(HALF, { material: "cardboard", seed: 1 });
  const all = groupBox(fr, fr.pieces.map((_, i) => i));
  for (let k = 0; k < 3; k++) { assert.ok(Math.abs(all.half[k] - HALF[k]) < 0.01); assert.ok(Math.abs(all.off[k]) < 0.01); }
  assert.ok(Math.abs(all.volume - fr.volume) < 1e-9);
});

// Load-aware (Milestone 27): this Mac is shared with other agents, Chrome and Avid; at a load of 30-250 a bake takes
// 3-15x its idle wall time, so the old "under 3 s" wall-clock check flaked. CPU time, compared with the same scene's
// rigid bake in the same process; the absolute limit only when the machine isn't overloaded.
test("bake time: the crate-crash pyramid (10 breakable crates, a car through them) costs at most 4x its rigid bake (< 3 s CPU idle)", async () => {
  const { cpus, loadavg } = await import("node:os");
  const F = 121, scene = (brk) => {
    const specs = [car(F, -24, 0.45)];
    let k = 0;
    for (const [y, xs] of [[0, [-1.2, -0.4, 0.4, 1.2]], [0.8, [-0.8, 0, 0.8]], [1.6, [-0.4, 0.4]], [2.4, [0]]]) {
      for (const x of xs) specs.push(crate(`crate_${k++}`, [x + 0.02 * k, y, 6], { yaw: 0.05 * k, breakable: brk }));
    }
    return specs;
  };
  const cpu = (brk) => { const c0 = process.cpuUsage(), r = simulate(scene(brk), F), c = process.cpuUsage(c0); return { ms: (c.user + c.system) / 1000, r }; };
  const rigid = cpu(false), r = cpu(true);
  assert.ok(Object.keys(r.r.fractures).length >= 3, `broke ${Object.keys(r.r.fractures).length}`);
  assert.ok(r.r.stats.pieces <= 90);
  assert.ok(r.ms < 4 * rigid.ms + 500, `breakable ${r.ms.toFixed(0)} ms vs rigid ${rigid.ms.toFixed(0)} ms CPU`);
  if (loadavg()[0] < 0.75 * cpus().length) assert.ok(r.ms < 3000, `bake ${r.ms.toFixed(0)} ms CPU`);
});
