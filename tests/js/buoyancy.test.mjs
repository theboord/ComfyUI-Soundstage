// Buoyancy in the pool / tank sets (web/stage/buoyancy.mjs, the stage's _waterPhysics and _swimPlan, live.mjs, the
// bake): weight-based floating and sinking, per-frame determinism, the swim modes, and the paths that used to skip
// the water (Mike, 2026-11-07: "when I placed a person in a water tank, they just went to the bottom and started
// walking"). Invented test scenes only.
// node --test tests/js/buoyancy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as B from "../../web/stage/buoyancy.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };

const LEVEL = 2.5;   // the Water tank's level (environments.mjs)
function tank(actors, { frames = 121 } = {}) {
  clearSetCache();
  const st = Object.create(Stage.prototype);
  const changes = [];
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set: "water_tank" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange: (s) => changes.push(s), onInteract() {}, onSelect() {}, _buildLights() {} });
  st.scene.add(st.root); st._buildSet(); st._setGroup = undefined; st.live = new LiveEdit(st, liveKinds()); st.setFrame(0);
  st.changes = changes;
  return st;
}
const prop = (id, kind, y = 0, extra = {}) => ({ id, name: id, kind, position: [0, y, 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const man = (id, y = 0, extra = {}) => ({ id, name: id, kind: "man", height_m: 1.8, position: [0, y, 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const wp = (o) => o.getWorldPosition(new THREE.Vector3());
const headY = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return wp(g.userData.joints.head).y; };
const hipsY = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return wp(g.userData.joints.l_hip).y; };
const yAt = (st, id, f) => { st.setFrame(f); return st.actorMeshes.get(id).position.y; };

// ------------------------------------------------------------------ Mike's report, reproduced first
test("a person dragged live in the tank keeps swimming: no fall to the tank floor, no walk, the key keeps its height", () => {
  // Before: the live world (floor, no water) pulled him from treading (y 1.098) to 0 in ~15 frames and walked him there.
  const st = tank([man("m")]);
  const g = st.actorMeshes.get("m");
  const y0 = g.position.y;
  assert.ok(y0 > 0.8, `treading at the start (${y0})`);
  const ray = (x) => ({ ray: new THREE.Ray(new THREE.Vector3(x, 30, 0), new THREE.Vector3(0, -1, 0)) });
  assert.ok(st.live.begin("m", { clientX: 0, clientY: 0 }, ray(0)));
  let lo = Infinity;
  for (let i = 1; i <= 40; i++) {
    st.live.move({ clientX: i * 5, clientY: 0 }, ray(i * 0.05));
    st.live._tick(1 / 60);
    lo = Math.min(lo, g.position.y);
    assert.ok(g.userData.swimOn && !g.userData.gaitOn, `frame ${i}: swimming, not walking`);
  }
  assert.ok(lo > 0.8, `never dropped toward the floor (lowest ${lo.toFixed(3)})`);
  assert.ok(headY(st, "m") > LEVEL, "head above the water while dragged");
  st.live.end(); st.live.finish();
  const k = st.state.actors[0].keys[0].position;
  assert.equal(k[1], 0, "the key stays 'placed in the water' (0), never a tank-floor key");
  assert.ok(k[0] > 0.5, `moved along the drag (${k[0]})`);
});

test("a crate dragged and let go over the tank floats where it was let go (not on the tank floor); settle() leaves a drop alone", () => {
  const st = tank([prop("c", "crate", 0, { x: -3, z: -3 })]);
  const g = st.actorMeshes.get("c");
  const float0 = g.position.y;
  assert.ok(float0 > 1.5, `placed in the tank: floating (${float0})`);
  const ray = (x, z) => ({ ray: new THREE.Ray(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0)) });
  assert.ok(st.live.begin("c", { clientX: 0, clientY: 0 }, ray(-3, -3)));
  for (let i = 1; i <= 30; i++) { st.live.move({ clientX: i * 5, clientY: 0 }, ray(-3 + i * 0.05, -3)); st.live._tick(1 / 60); assert.ok(g.position.y > 1.5, `carried at the water (${g.position.y})`); }
  st.live.end();
  for (let i = 0; i < 60 && st.live.settling; i++) st.live._tick(1 / 60);
  st.live.finish();
  const k = st.state.actors[0].keys[0].position;
  assert.equal(k[1], 0, "placed in the water");
  assert.ok(Math.abs(st.actorMeshes.get("c").position.y - float0) < 0.05, "floating again at its waterline");
  // the gizmo's settle(): a crate keyed 4.5 m up over the tank is not dropped to the floor and re-keyed there
  const st2 = tank([prop("d", "crate", 4.5, { x: -4, z: -3, key_y: true })]);
  assert.equal(st2.live.settle("d"), false);
  assert.equal(st2.state.actors[0].keys[0].position[1], 4.5, "the drop height is kept");
});

test("the browser repro: a man (Tread water) and a woman (Can't swim) keyed 2 m over the Water tank never stand or walk on the floor", () => {
  // Before: both plunged to the tank floor (feet y 0.04 at f48), stood there upright in the tread pose from ~f36 to f76
  // and surfaced only around f84-92.
  const woman = (id, y, extra) => ({ ...man(id, y, extra), kind: "woman", height_m: 1.65 });
  const st = tank([man("m", 4.5, { x: -2, swim: "tread", key_y: true }), woman("w", 4.5, { x: 2, swim: "cant", key_y: true })], { frames: 145 });
  for (const id of ["m", "w"]) {
    const a = st.state.actors.find((x) => x.id === id), g = st.actorMeshes.get(id), plan = st._swimPlan(a, g);
    let lowest = Infinity, under = 0;
    for (let f = 0; f < 145; f++) {
      st.setFrame(f); g.updateMatrixWorld(true);
      const lo = new THREE.Box3().setFromObject(g).min.y;
      lowest = Math.min(lowest, lo);
      assert.ok(g.userData.swimOn && !g.userData.gaitOn, `${id} f${f}: swimming, not walking`);
      if (plan.mode[f] === "under") {
        under++;
        assert.ok(["fall", "kickup", "struggle", "limp"].includes(plan.main[f]), `${id} f${f}: under water in a swim pose (${plan.main[f]}), not standing`);
      }
    }
    assert.ok(under > 3, `${id} goes under (${under} frames)`);
    assert.ok(lowest > 0.3, `${id} stops well above the tank floor (lowest point ${lowest.toFixed(2)})`);
  }
  // the plunge depth scales with the drop
  const d1 = B.plungeTrack({ ky: LEVEL + 1, level: LEVEL, n: 96 }), d2 = B.plungeTrack({ ky: LEVEL + 2, level: LEVEL, n: 96 }), d5 = B.plungeTrack({ ky: LEVEL + 5, level: LEVEL, n: 96 });
  assert.ok(d1.depth < d2.depth && d2.depth <= d5.depth, `deeper from higher (${d1.depth.toFixed(2)}, ${d2.depth.toFixed(2)}, ${d5.depth.toFixed(2)})`);
  assert.ok(LEVEL - d5.depth >= 0.3 - 1e-9, "and never closer than 30 cm to the floor");
});

test("can't swim in a short shot: the struggle starts at water entry, so the struggle and the slow sink both fit in 6 s", () => {
  const woman = { ...man("w", 4.5, { swim: "cant", key_y: true }), kind: "woman", height_m: 1.65 };
  const st = tank([woman], { frames: 145 });
  const plan = st._swimPlan(st.state.actors[0], st.actorMeshes.get("w"));
  const firstStruggle = plan.main.indexOf("struggle"), lastStruggle = plan.main.lastIndexOf("struggle");
  assert.ok(firstStruggle > 0 && firstStruggle < 48, `flails from the plunge (f${firstStruggle})`);
  assert.ok(lastStruggle < 120, `stops struggling by 5 s (f${lastStruggle})`);
  st.setFrame(lastStruggle); const h0 = hipsY(st, "w");
  st.setFrame(144); const h1 = hipsY(st, "w");
  assert.ok(h0 - h1 > 0.2, `then sinks inside the shot (hips ${h0.toFixed(2)} -> ${h1.toFixed(2)})`);
  assert.ok(headY(st, "w") < LEVEL, "the head is under by the end");
});

// ------------------------------------------------------------------ the physics
test("weight decides: a rock sinks faster than a can't-swim person, who sinks slower; a soaking crate still floats; a ball floats higher than a crate", () => {
  const rock = B.bodyOf("rock", [0.5, 0.4, 0.5]), crate = B.bodyOf("crate", [0.8, 0.8, 0.8]), ball = B.bodyOf("sphere", [0.5, 0.5, 0.5]);
  assert.ok(B.terminalSpeed(rock) > 1.5, `rock terminal ${B.terminalSpeed(rock)} m/s`);
  const sink = B.sinkTrack({ y0: 2, floorHips: 0.9, fps: 24, n: 240 });
  const vp = -sink.v[96];
  assert.ok(vp >= 0.1 && vp <= 0.3, `limp person sinks at ${vp.toFixed(3)} m/s (research 0.1-0.3)`);
  assert.ok(B.terminalSpeed(rock) > 4 * vp);
  // the crate soaks (400 -> 950 kg/m3 over ~90 s) and rides lower, but never sinks
  assert.ok(B.densityAt(crate, 600) < 1000 && B.densityAt(crate, 60) > crate.rho);
  const n = 24 * 60, over = new Array(n).fill(true);
  const tc = B.floatTrack(crate, { level: LEVEL, fps: 24, keyY: new Array(n).fill(0), over });
  assert.ok(tc.y[n - 1] > LEVEL - crate.h && tc.y[n - 1] < tc.y[0], `still afloat after a minute, lower (${tc.y[0].toFixed(3)} -> ${tc.y[n - 1].toFixed(3)})`);
  assert.ok(B.floatFraction(ball) < B.floatFraction(crate) - 0.1, `ball ${B.floatFraction(ball).toFixed(2)} under vs crate ${B.floatFraction(crate).toFixed(2)}`);
  // and on the stage: placed in the tank, the ball's bottom is higher (relative to its height) than the crate's
  const st = tank([prop("c", "crate", 0, { x: -3 }), prop("b", "sphere", 0, { x: 3 }), prop("r", "rock", 2, { z: 3 })]);
  st.setFrame(48);
  const sub = (id) => { const b = new THREE.Box3().setFromObject(st.actorMeshes.get(id)); return (LEVEL - b.min.y) / (b.max.y - b.min.y); };
  assert.ok(sub("b") < sub("c"), `ball ${sub("b").toFixed(2)} of its height under, crate ${sub("c").toFixed(2)}`);
  assert.ok(new THREE.Box3().setFromObject(st.actorMeshes.get("r")).min.y < 0.05, "the rock is on the bottom by 2 s");
});

test("a float bobs under-damped to its real waterline after a drop; a rock keyed under the surface sinks from there (no snap)", () => {
  const crate = B.bodyOf("crate", [0.8, 0.8, 0.8]), n = 240;
  const tr = B.floatTrack(crate, { level: LEVEL, fps: 24, keyY: new Array(n).fill(4.5), over: new Array(n).fill(true) });
  assert.ok(tr.splash > 0, "it falls to the surface first");
  const eq = B.restBottom(crate, LEVEL, 0, tr.rho[n - 1]);   // (it has soaked a little in 10 s)
  const after = tr.y.slice(tr.splash);
  const lo = Math.min(...after);
  assert.ok(lo < eq - 0.3, "plunges under its waterline");
  let crossings = 0;
  for (let i = 1; i < after.length; i++) if ((after[i - 1] - eq) * (after[i] - eq) < 0) crossings++;
  assert.ok(crossings >= 3, `overshoots and comes back (${crossings} crossings): under-damped`);
  assert.ok(Math.abs(tr.y[n - 1] - eq) < 0.03, `settles at its waterline (${tr.y[n - 1].toFixed(3)} vs ${eq.toFixed(3)})`);
  const st = tank([prop("r", "rock", 2, { key_y: true })]);
  const ys = [0, 6, 12, 18].map((f) => yAt(st, "r", f));
  assert.ok(ys[0] > 1.8, `frame 0 where it was keyed (${ys[0]})`);
  assert.ok(ys[1] < ys[0] && ys[2] < ys[1] && ys[3] < ys[2], `and sinking from there: ${ys.map((y) => y.toFixed(2))}`);
  const st2 = tank([prop("c", "crate", 1, { key_y: true })]);
  const cy = [0, 12, 24].map((f) => yAt(st2, "c", f));
  assert.ok(cy[1] > cy[0] && cy[2] > cy[0], `a crate keyed under the surface rises (${cy.map((y) => y.toFixed(2))})`);
});

test("the mass / density override changes the outcome: a crate made heavy sinks, a rock made light floats", () => {
  const st = tank([prop("c", "crate", 0, { x: -3 }), prop("r", "rock", 0, { x: 3 })]);
  st.setFrame(60);
  const c0 = st.actorMeshes.get("c").position.y, r0 = st.actorMeshes.get("r").position.y;
  assert.ok(c0 > 1.5 && r0 < 0.1, `default: crate floats (${c0}), rock on the bottom (${r0})`);
  assert.equal(st.buoyancyInfo("c").floats, true);
  assert.equal(st.setDensity("c", "metal").ok, true);
  assert.equal(st.buoyancyInfo("c").floats, false);
  st.setDensity("r", 300);
  st.setFrame(10); st.setFrame(60);
  assert.ok(st.actorMeshes.get("c").position.y < 0.1, "steel-dense crate: on the bottom");
  assert.ok(st.actorMeshes.get("r").position.y > 1.5, "foam-light rock: floats");
  // the Physics panel's mass: 400 kg in a 0.8 m crate is 780 kg/m3, floats low; 900 kg sinks
  st.setDensity("c", "auto");
  st.setPhysics("c", { mass: 900 });
  assert.equal(st.buoyancyInfo("c").source, "mass");
  assert.equal(st.buoyancyInfo("c").floats, false);
  assert.equal(st.setDensity("c", "banana").ok, false, "junk refused");
});

test("every frame is a pure function of the keys and the frame: scrubbing in any order gives the same pose", () => {
  const st = tank([prop("c", "crate", 4.5, { x: -3, key_y: true }), prop("b", "sphere", 3, { x: 3, key_y: true }), prop("r", "rock", 4, { z: 3, key_y: true }),
    man("p", 4.5, { z: -3, swim: "cant" }), man("q", 0, { x: 4, z: -4, swim: "back" })]);
  const snap = () => st.state.actors.map((a) => { const g = st.actorMeshes.get(a.id); return [...g.position.toArray(), ...g.quaternion.toArray()]; });
  const order = [24, 0, 96, 24, 60, 119, 7, 24, 96, 60];
  const seen = new Map();
  for (const f of order) {
    st.setFrame(f);
    const s = snap();
    if (seen.has(f)) seen.get(f).forEach((v, i) => v.forEach((x, j) => assert.ok(Math.abs(x - s[i][j]) < 1e-9, `frame ${f} actor ${i} differs on a re-visit`)));
    else seen.set(f, s);
  }
  // the old Box3 drift: setting the same frame again and again never moves a person (or anything) further down
  st.setFrame(24); const a = snap();
  for (let i = 0; i < 5; i++) st.setFrame(24);
  assert.deepEqual(snap(), a);
});

// ------------------------------------------------------------------ the swim modes
test("tread water keeps the head above the surface; Float on back lies face up at the surface", () => {
  const st = tank([man("t", 0, { swim: "tread" }), man("b", 0, { x: 3, swim: "back" })]);
  for (const f of [0, 30, 60, 100]) {
    st.setFrame(f);
    assert.ok(headY(st, "t") > LEVEL + 0.03, `f${f}: treading head ${headY(st, "t").toFixed(3)}`);
    const bh = headY(st, "b"), hh = hipsY(st, "b");
    assert.ok(bh > LEVEL - 0.15 && hh < LEVEL && hh > LEVEL - 0.6, `f${f}: back float head ${bh.toFixed(2)}, hips ${hh.toFixed(2)}`);
  }
  const plan = st._swimPlan(st.state.actors[1], st.actorMeshes.get("b"));
  assert.equal(plan.main[60], "backfloat");
});

test("can't swim: struggles at the surface, then sinks slowly (0.1-0.3 m/s), limp, and settles on the bottom: never walks", () => {
  const st = tank([man("c", 0, { swim: "cant" })], { frames: 24 * 14 });
  const a = st.state.actors[0], g = st.actorMeshes.get("c");
  const plan = st._swimPlan(a, g);
  assert.equal(plan.main[12], "struggle");
  st.setFrame(12);
  assert.ok(headY(st, "c") > LEVEL - 0.1, "struggling with the head at the water");
  // the sink speed, from the hips over a second, mid-way down
  const ys = [];
  for (let f = 0; f < plan.n; f += 12) { st.setFrame(f); ys.push(hipsY(st, "c")); }
  let vmax = 0;   // while it sinks limp (not the struggle's bob, not the settle onto the bottom)
  for (let i = 1; i < ys.length; i++) if (plan.main[(i - 1) * 12] === "limp" && plan.main[i * 12] === "limp") vmax = Math.max(vmax, (ys[i - 1] - ys[i]) * 2);
  assert.ok(vmax >= 0.1 && vmax <= 0.35, `fastest sink ${vmax.toFixed(3)} m/s`);
  st.setFrame(plan.n - 1);
  assert.ok(hipsY(st, "c") < 0.5, `on the bottom at the end (hips ${hipsY(st, "c").toFixed(2)})`);
  assert.equal(plan.main[plan.n - 1], "limp_floor");
  for (let f = 0; f < plan.n; f += 6) { st.setFrame(f); assert.ok(g.userData.swimOn && !g.userData.gaitOn, `f${f}: no walking`); }
  // nothing goes through the tank floor while it sinks and settles (was: the legs 0.39 m under, lowered in the upright
  // limp pose; it showed in Depth and Pose too)
  let lowest = Infinity;
  for (let f = 0; f < plan.n; f += 2) { st.setFrame(f); g.updateMatrixWorld(true); lowest = Math.min(lowest, new THREE.Box3().setFromObject(g).min.y); }
  assert.ok(lowest > -0.01, `the clay's lowest point stays on the floor (${lowest.toFixed(3)})`);
  // Sink slowly (unconscious): no struggle at all
  const st2 = tank([man("u", 0, { swim: "sink" })]);
  const p2 = st2._swimPlan(st2.state.actors[0], st2.actorMeshes.get("u"));
  assert.ok(!p2.main.includes("struggle"));
  assert.equal(st2.setSwim("u", "can't swim").swim, "cant");
  assert.equal(st2.setSwim("u", "flying").ok, false);
});

test("a person keyed above the surface drops in, goes under and comes up swimming (was: clay through the floor to -10 m)", () => {
  const st = tank([man("d", 4.5)]);
  const ys = [0, 6, 12, 24, 48, 96, 119].map((f) => { st.setFrame(f); return hipsY(st, "d"); });
  assert.ok(ys[0] > 5, `starts up there (hips ${ys[0].toFixed(2)})`);
  assert.ok(ys.every((y) => y > -0.05), `never through the floor: ${ys.map((y) => y.toFixed(2))}`);
  assert.ok(Math.min(...ys) < LEVEL - 0.5, "goes under");
  st.setFrame(119);
  assert.ok(headY(st, "d") > LEVEL, "and comes up with the head out");
  const r = st.avatarStatus("d");
  assert.equal(r.installed, false, "(no lifelike files in the test: the clay is what renders)");
  assert.equal(st._swimPlan(st.state.actors[0], st.actorMeshes.get("d")) != null, true, "on a swim plan: the lifelike body falls back to clay ('swims')");
});

test("water they can stand in: a 1.8 m man set to Can't swim stands in the 1.2 m lake and the 1.5 m open water (was: drowned, body at -0.47)", () => {
  for (const set of ["lake", "open_water"]) {
    clearSetCache();
    const st = tank([man("c", 0, { swim: "cant" }), man("a", 0, { x: 3 })], { frames: 24 * 8 });
    st.state.environment = { set }; st._buildSet(); st.setFrame(0);
    const level = st.water.position.y;
    assert.ok(B.canStand(level, 1.8), `${set}: ${level} m is standing depth for 1.8 m`);
    for (let f = 0; f < 24 * 8; f += 8) {
      st.setFrame(f);
      for (const id of ["c", "a"]) {
        assert.ok(headY(st, id) > level + 0.05, `${set} f${f} ${id}: head out (${headY(st, id).toFixed(2)})`);
        assert.ok(hipsY(st, id) > 0.7, `${set} f${f} ${id}: standing on the bottom (hips ${hipsY(st, id).toFixed(2)})`);
      }
    }
  }
  // a 1.65 m woman can't stand in 1.5 m: Can't swim still struggles and sinks there
  assert.equal(B.canStand(1.5, 1.65), false);
  assert.equal(B.personTrack({ mode: "cant", keyY: new Array(48).fill(0), over: new Array(48).fill(true), level: 1.5, height: 1.65, hipY: 0.87 }).styles[12], "struggle");
});

test("an animal set to Can't swim paddles at the surface, then sinks slowly and lies on the bottom; Sink slowly sinks from the surface; no walk cycle under water", () => {
  // Before: on the tank floor from frame 0 (dog y -0.05 every frame), its walk cycle running along the bottom.
  const dog = (id, swim, x) => ({ id, name: id, kind: "dog", position: [x, 0, 0], keys: [{ frame: 0, position: [x, 0, 0] }, { frame: 287, position: [x + 3, 0, 0] }], rotation_deg: 0, swim });
  const N = 24 * 12, st = tank([dog("c", "cant", -3), dog("s", "sink", 3)], { frames: N });
  const ys = (id) => { const out = []; for (let f = 0; f < N; f++) out.push(yAt(st, id, f)); return out; };
  const yc = ys("c"), ysk = ys("s");
  assert.ok(yc[0] > 1.5 && ysk[0] > 1.5, `both start in the water at the surface (${yc[0].toFixed(2)}, ${ysk[0].toFixed(2)})`);
  assert.ok(yc[36] > 1.5, `can't swim: still at the surface paddling at 1.5 s (${yc[36].toFixed(2)})`);
  assert.ok(ysk[72] < ysk[0] - 0.3, `sink slowly: going down from the start (${ysk[0].toFixed(2)} -> ${ysk[72].toFixed(2)})`);
  let vmax = 0;
  for (let f = 12; f < N; f += 12) vmax = Math.max(vmax, (yc[f - 12] - yc[f]) * 2);
  assert.ok(vmax > 0.1 && vmax < 0.8, `sinks slowly (fastest ${vmax.toFixed(2)} m/s; a rock does ${B.terminalSpeed(B.bodyOf("rock", [0.5, 0.4, 0.5])).toFixed(1)})`);
  const g = st.actorMeshes.get("c"), legs = () => g.userData.limbs.map((l) => l.pivot.rotation.x);
  st.setFrame(12); const l12 = legs(); st.setFrame(18); const l18 = legs();
  assert.ok(l12.some((x, i) => Math.abs(x - l18[i]) > 0.2), "paddling hard during the struggle");
  st.setFrame(N - 12); const la = legs(), za = g.rotation.z; st.setFrame(N - 1); const lb = legs();
  assert.ok(g.position.y < 0.3 && Math.abs(za) > 1, `lying on its side on the bottom at the end (y ${g.position.y.toFixed(2)}, roll ${za.toFixed(2)})`);
  assert.ok(la.every((x, i) => Math.abs(x - lb[i]) < 0.02), "its legs are still: no walk cycle along the bottom though it is keyed moving");
  assert.equal(st.buoyancyInfo("c").floats, false, "the Physics info says it ends up sinking");
});

// ------------------------------------------------------------------ the other paths that skipped the water
test("Simulate & bake leaves things in the tank to the water; the Physics start height is a drop height, not a float in the air", () => {
  const st = tank([prop("c", "crate", 0, { x: -3, physics: { mode: "dynamic", lift: 4.5 } }), prop("b", "sphere", 0, { x: 3, physics: { mode: "dynamic", lift: 4.5 } })]);
  const y0 = yAt(st, "b", 0), y60 = yAt(st, "b", 60);
  assert.ok(y0 > LEVEL + 1.5, `the ball starts 4.5 m up, 2 m over the water (${y0})`);
  assert.ok(y60 < LEVEL + 0.1 && y60 > LEVEL - 0.5, `and is floating by 2.5 s (${y60}), not hanging in the air`);
  const r = st.simulatePhysics();
  assert.equal(r.inWater, 2, r.message);
  assert.ok(st.state.actors.every((a) => !a.physics.baked && !a.physics.fracture), "not baked, not broken on the tank floor");
  assert.ok(yAt(st, "c", 96) > 1.5, "the crate floats at the end");
});

test("Add object in the tank keeps new things inside its walls", () => {
  const st = tank([]);
  st.select = (id) => { st.selected = id; };   // (no gizmo in a headless stage)
  for (const k of ["man", "woman", "crate", "rock", "sphere", "rock", "sphere"]) st.addObject(k);
  for (const a of st.state.actors) assert.ok(st._inPool(a.position[0], a.position[2]), `${a.name} at ${a.position} is in the water`);
});

test("the person panel's Swim select drives stage.setSwim and shows the person's mode; the Physics info carries the density", async () => {
  const { swimControl } = await import("../../web/stage/people/peopleui.mjs");
  const calls = [];
  const mk = (label, opts, value, onPick) => ({ wrap: { title: "" }, sel: { value, opts, pick: onPick }, label });
  const st = { setSwim: (id, v) => calls.push([id, v]) };
  const c = swimControl(st, mk, B.SWIM_MODES);
  assert.deepEqual(Object.keys(c.swim.sel.opts), B.SWIM_MODES.map((m) => m[0]));
  assert.match(c.swim.wrap.title, /Can't swim/);
  c.swim.sel.pick("cant");
  assert.deepEqual(calls, [[null, "cant"]]);
  c.sync({ swim: "back" });
  assert.equal(c.swim.sel.value, "back");
  const s = tank([man("p", 0, { swim: "off" }), prop("c", "crate")]);
  s.select = (id) => { s.selected = id; };
  s.selected = "p";
  assert.equal(s.selectedInfo().swim, "cant", "the old swim off reads as Can't swim");
  const info = s.physicsInfo("c");
  assert.equal(info.buoyancy.floats, true);
  assert.equal(info.buoyancy.source, "kind");
  assert.ok(info.buoyancy.density > 300 && info.buoyancy.density < 500);
});
