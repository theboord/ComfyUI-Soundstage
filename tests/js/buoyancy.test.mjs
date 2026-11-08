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
function tank(actors, { frames = 121, set = "water_tank", keepSet = false, env = {} } = {}) {
  clearSetCache();
  const st = Object.create(Stage.prototype);
  const changes = [];
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set, ...env } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange: (s) => changes.push(s), onInteract() {}, onSelect() {}, _buildLights() {} });
  st.scene.add(st.root); st._buildSet(); if (!keepSet) st._setGroup = undefined; st.live = new LiveEdit(st, liveKinds()); st.setFrame(0);
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

// Third pass (2026-11-07): "when I placed a person in a water tank, they just went to the bottom and started walking".
// Reproduced on main: a man keyed 4.5 m over the tank with a hold then a step walked on the tank floor (hips 0.81, the
// walk cycle), and on this branch a man on the lake's dock fell in at f0 and waded on the bottom (hips 0.96).
const keyed = (id, kind, keys, extra = {}) => ({ id, name: id, kind, height_m: kind === "man" ? 1.8 : undefined, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0, key_y: true, ...extra });
const feetY = (st, id, f) => { st.setFrame(f); return lowest(st.actorMeshes.get(id)); };
const lowest = (g) => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g).min.y; };

test("a person on the lake's dock stands on the dock (was: fell in at f0 and waded on the bottom); one on a speedboat's deck in the tank stays on the deck", () => {
  const DOCK = 1.81;   // the deck of the dock (environments.mjs lake: level 1.2 + 0.55, 12 cm thick)
  const st = tank([keyed("s", "man", [[0, [-6, DOCK, -16]]]), keyed("w", "man", [[0, [-6.5, DOCK, -21]], [120, [-5.5, DOCK, -10]]])], { set: "lake", keepSet: true });
  assert.ok(st._overWater(-6, -16), "the dock is over the lake's water");
  for (const id of ["s", "w"]) for (let f = 0; f < 121; f += 6) {
    st.setFrame(f);
    const g = st.actorMeshes.get(id), y = lowest(g);
    assert.ok(!g.userData.swimOn, `${id} f${f}: not in the water`);
    assert.ok(Math.abs(y - DOCK) < 0.08, `${id} f${f}: the feet on the dock (lowest point ${y.toFixed(2)})`);
    assert.ok(hipsY(st, id) > DOCK + 0.7, `${id} f${f}: standing up on it (hips ${hipsY(st, id).toFixed(2)})`);
  }
  st.setFrame(60);
  assert.ok(st.actorMeshes.get("w").userData.gaitOn, "the one keyed along the dock walks it");
  // the speedboat floating in the tank: keyed at its deck (cockpit sole), with and without a walk along it
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const probe = tank([boat]);
  const deck = probe._deckAt(0, -1, 6, 0);
  assert.ok(deck > LEVEL && deck < LEVEL + 0.6, `a deck just above the water (${deck})`);
  const st2 = tank([boat, keyed("d", "man", [[0, [0, deck, -1]]]), keyed("e", "man", [[0, [-0.45, deck, -0.8]], [120, [0.45, deck, -0.8]]])]);
  for (const id of ["d", "e"]) for (let f = 0; f < 121; f += 6) {
    const y = feetY(st2, id, f), g = st2.actorMeshes.get(id), d = st2._deckAt(g.position.x, g.position.z, 6, f);
    assert.ok(!g.userData.swimOn, `${id} f${f}: not in the water`);
    assert.ok(Math.abs(y - deck) < 0.08 && Math.abs(d - deck) < 0.06, `${id} f${f}: the feet on the deck (lowest point ${y.toFixed(2)}, deck ${d?.toFixed(2)})`);
  }
  // off the end of the dock: they step off and drop in (there the dock is no longer under them)
  const st3 = tank([keyed("o", "man", [[0, [-6, DOCK, -11]], [24, [-6, DOCK, -7]]])], { set: "lake", keepSet: true, frames: 72 });
  assert.ok(Math.abs(feetY(st3, "o", 0) - DOCK) < 0.08, "on the dock at the start");
  st3.setFrame(60);
  assert.ok(st3.actorMeshes.get("o").userData.swimOn, "in the water after walking off its end");
});

test("a timed jump: keys held 4.5 m up until f48, then a step off: the fall starts at f48, not f0, the same in any order", () => {
  const keys = [[0, [-5, 4.5, 0]], [48, [-5, 4.5, 0]], [60, [-4, 2.6, 0]]];
  const st = tank([keyed("j", "man", keys)], { frames: 145 });
  const a = st.state.actors[0], g = st.actorMeshes.get("j");
  const h = [];
  for (let f = 0; f < 145; f++) { st.setFrame(f); h.push(hipsY(st, "j")); }
  for (let f = 0; f < 48; f++) {
    assert.ok(h[f] > 4.5 + 0.7, `f${f}: held up there on the keys (hips ${h[f].toFixed(2)}), not on the tank floor`);
  }
  const plan = st._swimPlan(a, g), fall = plan.mode.findIndex(Boolean);
  assert.ok(fall >= 48 && plan.main[fall] === "fall", `the fall begins at or after f48 (f${fall}, ${plan.main[fall]})`);
  assert.ok(h[fall + 12] < h[47] - 0.5, `and they are falling half a second later (hips ${h[47].toFixed(2)} -> ${h[fall + 12].toFixed(2)})`);
  assert.ok(Math.min(...h.slice(48)) < LEVEL, "and they go in");
  st.setFrame(144);
  assert.ok(g.userData.swimOn && headY(st, "j") > LEVEL, "and come up swimming");
  for (const f of [100, 20, 70, 50, 0]) { st.setFrame(f); assert.ok(Math.abs(hipsY(st, "j") - h[f]) < 1e-6, `f${f}: the same pose scrubbed back`); }
  // personTrack itself: held until the keys go down, then the drop from there
  const n = 96, ky = Array.from({ length: n }, (_, f) => (f <= 48 ? 4.5 : Math.max(2.6, 4.5 - (f - 48) * 0.16)));
  const tr = B.personTrack({ mode: "auto", keyY: ky, over: new Array(n).fill(true), level: LEVEL, hipY: 0.95 });
  assert.ok(tr.held.slice(0, 48).every(Boolean) && !tr.held[48], "held to f47, falling from f48");
  assert.equal(tr.styles[48], "fall");
  // keys that never go down still drop at once (nothing holds them up there)
  const still = B.personTrack({ mode: "auto", keyY: new Array(n).fill(4.5), over: new Array(n).fill(true), level: LEVEL, hipY: 0.95 });
  assert.ok(!still.held.some(Boolean) && still.styles[0] === "fall");
});

test("flutter, frog and dive keyed above the surface drop in too (was: treading / hovering in the water from f0)", () => {
  for (const swim of ["flutter", "frog", "dive"]) {
    const st = tank([keyed("u", "man", [[0, [0, 4.5, 0]]], { swim })], { frames: 145 });
    const plan = st._swimPlan(st.state.actors[0], st.actorMeshes.get("u"));
    st.setFrame(0);
    assert.ok(hipsY(st, "u") > 5, `${swim}: starts up there (hips ${hipsY(st, "u").toFixed(2)})`);
    assert.equal(plan.main[0], "fall", `${swim}: in the fall pose`);
    let lo = Infinity;
    for (let f = 0; f < 145; f += 3) { st.setFrame(f); lo = Math.min(lo, hipsY(st, "u")); }
    assert.ok(lo < LEVEL - 0.5, `${swim}: goes under (${lo.toFixed(2)})`);
    st.setFrame(144);
    if (swim === "dive") assert.equal(plan.mode[144], "under", "the diver stays under, at the depth the stage holds them");
    else assert.ok(headY(st, "u") > LEVEL, `${swim}: back up with the head out`);
  }
  // keyed in the water they keep their keyed depth as before
  const st = tank([man("k", 0.5, { swim: "flutter", key_y: true })]);
  const plan = st._swimPlan(st.state.actors[0], st.actorMeshes.get("k"));
  assert.ok(plan.mode.every((m) => m === "under"), "flutter keyed 0.5 m up swims under water all shot");
});

test("objects partly over the tank edge stay inside the wall: a car keyed at x 7.5 side-on, and one dragged there", () => {
  const car = (id, x, extra = {}) => ({ id, name: id, kind: "car", position: [x, 0, 0], keys: [{ frame: 0, position: [x, 0, 0] }], rotation_deg: 90, ...extra });
  const X = (15.6) / 2;   // the tank's inner wall
  const extent = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g); };
  const st = tank([car("c", 7.5), prop("r", "rock", 0, { x: -7.6, z: 7.6 })]);
  for (const f of [0, 30, 120]) {
    st.setFrame(f);
    const b = extent(st, "c");
    assert.ok(b.max.x <= X + 0.02, `f${f}: the car's side (${b.max.x.toFixed(2)}) inside the wall at ${X}`);
    assert.ok(st.actorMeshes.get("c").userData.inWater, "and floating");
    const r = extent(st, "r");
    assert.ok(r.min.x >= -X - 0.05 && r.max.z <= X + 0.05, `f${f}: the rock (its settling sway tips it a little) in the corner inside both walls (${r.min.x.toFixed(2)}, ${r.max.z.toFixed(2)})`);
  }
  assert.equal(st.state.actors[0].keys[0].position[0], 7.5, "the key is left as keyed");
  // dragged: the live world shows it where the water will float it
  const st2 = tank([car("d", 0)]);
  const ray = (x) => ({ ray: new THREE.Ray(new THREE.Vector3(x, 30, 0), new THREE.Vector3(0, -1, 0)) });
  assert.ok(st2.live.begin("d", { clientX: 0, clientY: 0 }, ray(0)));
  for (let i = 1; i <= 40; i++) { st2.live.move({ clientX: i * 5, clientY: 0 }, ray(i * 0.19)); st2.live._tick(1 / 60); }
  const live = extent(st2, "d");
  assert.ok(live.max.x <= X + 0.02, `while dragged (${live.max.x.toFixed(2)})`);
  st2.live.end(); st2.live.finish();
  st2.setFrame(0);
  assert.ok(extent(st2, "d").max.x <= X + 0.02, `after the drag (${extent(st2, "d").max.x.toFixed(2)}, key x ${st2.state.actors[0].keys[0].position[0]})`);
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
  // at their real waterlines (the old fixed-fraction float had the crate 0.58 under; its weight puts it at 0.40)
  for (const [id, body] of [["b", ball], ["c", crate]]) assert.ok(Math.abs(sub(id) - B.floatFraction(body)) < 0.06, `${id}: ${sub(id).toFixed(2)} under vs ${B.floatFraction(body).toFixed(2)} from its weight`);
  assert.ok(new THREE.Box3().setFromObject(st.actorMeshes.get("r")).min.y < 0.05, "the rock is on the bottom by 2 s");
  st.setFrame(24);   // ... and already by 1 s: it sinks at its terminal speed (the old drop was still 1.06 m up)
  assert.ok(new THREE.Box3().setFromObject(st.actorMeshes.get("r")).min.y < 0.1, "the rock is on the bottom by 1 s");
});

test("a float bobs under-damped to its real waterline after a drop; a rock keyed under the surface sinks from there (no snap)", () => {
  const crate = B.bodyOf("crate", [0.8, 0.8, 0.8]), n = 240;
  const tr = B.floatTrack(crate, { level: LEVEL, fps: 24, keyY: new Array(n).fill(4.5), over: new Array(n).fill(true) });
  assert.ok(tr.splash > 0, "it falls to the surface first");
  const eq = B.restBottom(crate, LEVEL, 0, tr.rho[n - 1]);   // (it has soaked a little in 10 s)
  const after = tr.y.slice(tr.splash);
  const lo = Math.min(...after);
  assert.ok(lo < eq - 0.15, "plunges under its waterline");
  assert.ok(lo + crate.h > LEVEL, `but its top stays out: the water it sets moving stops it (bottom ${(LEVEL - lo).toFixed(2)} m under; was 1.43, fully under)`);
  // a light ball dropped from 2 m barely goes under (was: completely under at f24, its bottom ~1.1 m down)
  const ball = B.bodyOf("sphere", [0.5, 0.5, 0.5]);
  const tb = B.floatTrack(ball, { level: LEVEL, fps: 24, keyY: new Array(n).fill(4.5), over: new Array(n).fill(true) });
  const blo = Math.min(...tb.y.slice(tb.splash));
  assert.ok(LEVEL - blo < 0.35 && blo + ball.h > LEVEL + 0.1, `the ball's bottom only ${(LEVEL - blo).toFixed(2)} m under at the deepest`);
  let crossings = 0;
  for (let i = 1; i < after.length; i++) if ((after[i - 1] - eq) * (after[i] - eq) < 0) crossings++;
  assert.ok(crossings >= 3, `overshoots and comes back (${crossings} crossings): under-damped`);
  assert.ok(Math.abs(tr.y[n - 1] - eq) < 0.03, `settles at its waterline (${tr.y[n - 1].toFixed(3)} vs ${eq.toFixed(3)})`);
  const st = tank([prop("r", "rock", 2, { key_y: true })]);
  const ys = [0, 6, 12, 18].map((f) => yAt(st, "r", f));
  assert.ok(Math.abs(ys[0] - 2) < 0.03, `frame 0 where it was keyed (${ys[0].toFixed(3)}; the old drop started at 2.07)`);
  assert.ok(ys[1] < ys[0] && ys[2] < ys[1] && ys[3] < ys[2], `and sinking from there: ${ys.map((y) => y.toFixed(2))}`);
  assert.ok(yAt(st, "r", 24) < 0.15, `on the bottom by 1 s (${yAt(st, "r", 24).toFixed(2)})`);
  const st2 = tank([prop("c", "crate", 1, { key_y: true })]);
  const cy = [0, 12, 24].map((f) => yAt(st2, "c", f));
  assert.ok(Math.abs(cy[0] - 1) < 0.03, `a crate keyed 1 m up, under the surface, starts there (${cy[0].toFixed(3)}; was snapped to 2.03)`);
  assert.ok(cy[1] > cy[0] + 0.2 && cy[2] > cy[1], `and rises (${cy.map((y) => y.toFixed(2))})`);
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
  // walking through it (was on 86ef579: on a swim plan, breaststroking at the surface): swimming off, the walk on
  const st = tank([man("m", 0, { x: -3, z: 5 }), man("n", 0, { x: 3, z: 5, swim: "cant" })], { set: "lake", frames: 121 });
  for (const a of st.state.actors) a.keys = [{ frame: 0, position: [a.keys[0].position[0], 0, 5] }, { frame: 120, position: [a.keys[0].position[0] + 4, 0, 5] }];
  st.setFrame(0);
  for (let f = 6; f < 121; f += 12) {
    st.setFrame(f);
    for (const id of ["m", "n"]) {
      const g = st.actorMeshes.get(id);
      assert.ok(!g.userData.swimOn && g.userData.gaitOn, `lake f${f} ${id}: walking (wading), not swimming`);
      assert.ok(headY(st, id) > st.water.position.y + 0.05, `lake f${f} ${id}: head out`);
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

test("the Floats / sinks info matches what a person does: no density for a person on a swim plan, their Swim mode in words", () => {
  // Before: buoyancyInfo said 'floats, 99% under' for a Can't-swim person who sinks; setDensity(person, 'metal') said ok,
  // 'sinks 13 m/s', and did nothing (they kept struggling at the surface).
  const st = tank([man("c", 0, { swim: "cant" }), man("t", 0, { x: 3, swim: "tread" }), prop("k", "crate", 0, { x: -3 })]);
  assert.equal(st.buoyancyInfo("c"), null);
  const r = st.setDensity("c", "metal");
  assert.equal(r.ok, false); assert.match(r.error, /Swim/);
  assert.equal(st.state.actors[0].physics?.density, undefined, "nothing stored");
  const pc = st.physicsInfo("c"), pt = st.physicsInfo("t");
  assert.equal(pc.buoyancy, null);
  assert.equal(pc.swim.floats, false); assert.match(pc.swim.what, /sinks slowly/);
  assert.equal(pt.swim.floats, true); assert.match(pt.swim.what, /treads water/);
  assert.equal(st.physicsInfo("k").swim, null, "a prop keeps its density info");
  assert.equal(st.physicsInfo("k").buoyancy.floats, true);
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
  // big things: the whole footprint inside the inner wall, not just the centre (was: a car to z -9.33, a speedboat to
  // -8.29, against the wall at +-7.8)
  const big = ["car", "speedboat", "truck", "bus", "car", "speedboat"];
  for (const k of big) st.addObject(k);
  const gp = st.water.geometry.parameters, X = gp.width / 2, Z = gp.height / 2;
  st.setFrame(0);
  for (const a of st.state.actors.slice(-big.length)) {
    const g = st.actorMeshes.get(a.id), b = st._localBox(g), yaw = g.rotation.y;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const lx = b.center[0] + sx * b.half[0], lz = b.center[2] + sz * b.half[2];
      const wx = a.position[0] + Math.cos(yaw) * lx + Math.sin(yaw) * lz, wz = a.position[2] - Math.sin(yaw) * lx + Math.cos(yaw) * lz;
      assert.ok(Math.abs(wx - st.water.position.x) <= X + 1e-6 && Math.abs(wz - st.water.position.z) <= Z + 1e-6, `${a.name}: corner (${wx.toFixed(2)}, ${wz.toFixed(2)}) inside +-${X.toFixed(2)} x +-${Z.toFixed(2)}`);
    }
  }
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

// ------------------------------------------------------------------ fourth pass (2026-11-07, the verifier's list)
// A dive in that is keyed on down under the surface: keys [0: 4.5 m], [24: 0.6 m], [144: 0.6 m].
const diveIn = (swim) => keyed("u", "man", [[0, [0, 4.5, 0]], [24, [0, 0.6, 0]], [144, [0, 0.6, 0]]], { swim });

test("an underwater stroke dropped in and keyed on under holds its keyed depth (was: kicked up and swam at the surface from f48)", () => {
  // b5d87d0 swam under at hips ~1.5 from f24; 8fc04ef plunged, kicked up and was at the surface (hips ~2.0) from f48.
  for (const swim of ["flutter", "frog", "stroke"]) {
    const st = tank([diveIn(swim)], { frames: 145 });
    const plan = st._swimPlan(st.state.actors[0], st.actorMeshes.get("u"));
    st.setFrame(0);
    assert.ok(hipsY(st, "u") > 5 && plan.main[0] === "fall", `${swim}: starts in the fall from 4.5 m`);
    for (let f = 36; f < 145; f += 4) {
      st.setFrame(f);
      const h = hipsY(st, "u");
      assert.equal(plan.mode[f], "under", `${swim} f${f}: under water`);
      assert.ok(Math.abs(h - (0.6 + 0.9)) < 0.15, `${swim} f${f}: at the keyed depth (hips ${h.toFixed(2)}, keyed 1.5)`);
      assert.ok(headY(st, "u") < LEVEL - 0.1, `${swim} f${f}: the head under`);
    }
  }
  // keyed under only at the end: the drop, the kick up, the surface, then the keyed depth from there
  const st = tank([keyed("l", "man", [[0, [0, 4.5, 0]], [120, [0, 0.6, 0]]], { swim: "flutter" })], { frames: 145 });
  const plan = st._swimPlan(st.state.actors[0], st.actorMeshes.get("l"));
  assert.equal(plan.mode[90], "surface", "at the surface before the keys go under");
  st.setFrame(140);
  assert.equal(plan.mode[140], "under");
  assert.ok(Math.abs(hipsY(st, "l") - 1.5) < 0.15, `then at the keyed depth (${hipsY(st, "l").toFixed(2)})`);
});

test("scrubbing out of order gives the same pose: a dive in (flutter, frog, stroke, dive) and a can't-swim settle (was: f29 hips 1.5523 vs 1.5589; 5 cm on the bottom)", () => {
  for (const swim of ["flutter", "frog", "stroke", "dive"]) {
    const st = tank([diveIn(swim)], { frames: 145 });
    const g = st.actorMeshes.get("u");
    const snap = () => { g.updateMatrixWorld(true); return [...g.position.toArray(), ...g.quaternion.toArray(), hipsY(st, "u")]; };
    const ref = [];
    for (let f = 0; f < 145; f++) { st.setFrame(f); ref.push(snap()); }
    let bad = 0, first = "";
    for (const [mul, off] of [[37, 0], [97, 11], [61, 5]]) for (let i = 0; i < 145; i++) {
      const f = (i * mul + off) % 145;
      st.setFrame(f);
      const s = snap();
      if (s.some((x, j) => Math.abs(x - ref[f][j]) > 1e-9)) { bad++; first ||= `f${f}: hips ${ref[f][7].toFixed(4)} vs ${s[7].toFixed(4)}`; }
    }
    assert.equal(bad, 0, `${swim}: ${bad} of 435 out-of-order frames differ (${first})`);
  }
  // the floor lift was measured on the fins / hair of the frame shown before: a can't-swim woman settled on the bottom
  // jumped up to 5 cm when scrubbed back (8fc04ef: 181 of 900 frames differ); Sink slowly the same
  for (const swim of ["cant", "sink"]) {
    const st = tank([{ ...keyed("w", "woman", [[0, [0, 4.5, 0]]], { swim }), height_m: 1.65 }], { frames: 300 });
    const g = st.actorMeshes.get("w"), ref = [];
    for (let f = 0; f < 300; f++) { st.setFrame(f); ref.push(g.position.y); }
    let worst = 0, at = -1;
    for (const [mul, off] of [[37, 0], [97, 11]]) for (let i = 0; i < 300; i++) {
      const f = (i * mul + off) % 300;
      st.setFrame(f);
      const d = Math.abs(g.position.y - ref[f]);
      if (d > worst) { worst = d; at = f; }
    }
    assert.ok(worst < 1e-9, `${swim}: f${at} is ${worst.toFixed(4)} m off when scrubbed to out of order`);
  }
});

test("a car driven into the tank moves continuously through the wall (was: jumped 2.7 m at f22, then stalled at x -5.39 for f22-f28)", () => {
  const car = { id: "c", name: "c", kind: "car", position: [-14, 0, 0], keys: [{ frame: 0, position: [-14, 0, 0] }, { frame: 48, position: [0, 0, 0] }], rotation_deg: 90 };
  const st = tank([car], { frames: 121 });
  const g = st.actorMeshes.get("c"), xs = [], ys = [];
  for (let f = 0; f < 121; f++) { st.setFrame(f); xs.push(g.position.x); ys.push(g.position.y); }
  for (let f = 1; f <= 48; f++) {
    const dx = xs[f] - xs[f - 1];
    assert.ok(dx > 0.1 && dx < 0.45, `f${f}: drives on (dx ${dx.toFixed(2)}, x ${xs[f].toFixed(2)})`);
  }
  for (let f = 1; f < 121; f++) assert.ok(Math.abs(ys[f] - ys[f - 1]) < 0.2, `f${f}: no jump in height (${ys[f - 1].toFixed(2)} -> ${ys[f].toFixed(2)})`);
  st.setFrame(100);
  assert.ok(g.userData.inWater && g.position.y > 1.5, `then floats in the tank (${g.position.y.toFixed(2)})`);
  for (const f of [25, 90, 3, 60, 30]) { st.setFrame(f); assert.ok(Math.abs(g.position.x - xs[f]) < 1e-9 && Math.abs(g.position.y - ys[f]) < 1e-9, `f${f}: the same scrubbed back`); }
});

test("a person placed or dragged onto the dock or a boat the way the app does it is on it (was: on the lake bed, head through the dock; swimming in the hull)", () => {
  const DOCK = 1.81, ray = (x, z) => ({ ray: new THREE.Ray(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0)) });
  const at0 = (id, keys) => ({ id, name: id, kind: "man", height_m: 1.8, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0 });
  const onDock = (st, id, what) => {
    for (const f of [0, 30, 90]) {
      st.setFrame(f);
      const g = st.actorMeshes.get(id);
      assert.ok(!g.userData.swimOn, `${what} f${f}: not in the water`);
      assert.ok(Math.abs(lowest(g) - DOCK) < 0.08, `${what} f${f}: the feet on the dock (lowest point ${lowest(g).toFixed(2)})`);
      assert.ok(hipsY(st, id) > DOCK + 0.7, `${what} f${f}: standing up on it (hips ${hipsY(st, id).toFixed(2)})`);
    }
  };
  // placeInFrame: the shot camera looks down at the dock; the person is keyed at the dock's top (the ray meets it)
  const st = tank([at0("p", [[0, [0, 0, -30]]])], { set: "lake", keepSet: true });
  st._shotCameraAt = () => ({ position: [-6, 14, -18], target: [-6, 0, -16], focal_mm: 28 });
  const r = st.placeInFrame("p", { x: "center", y: 0.5 });
  assert.ok(r.ok && Math.abs(r.position[1] - DOCK) < 0.01 && Math.abs(r.position[0] + 6) < 0.3 && Math.abs(r.position[2] + 16) < 0.5, `placed on the dock, keyed at its top (${r.position})`);
  onDock(st, "p", "placed");
  // a live drag along the dock: keyed at the dock's top, and they stay up on it while dragged and after
  const st2 = tank([at0("d", [[0, [-6, DOCK, -20]]])], { set: "lake", keepSet: true });
  const g2 = st2.actorMeshes.get("d");
  assert.ok(st2.live.begin("d", { clientX: 0, clientY: 0 }, ray(-6, -20)));
  for (let i = 1; i <= 40; i++) {
    st2.live.move({ clientX: 0, clientY: i * 5 }, ray(-6, -20 + i * 0.15)); st2.live._tick(1 / 60);
    assert.ok(Math.abs(lowest(g2) - DOCK) < 0.08, `dragged ${i}: on the dock (lowest ${lowest(g2).toFixed(2)})`);
  }
  st2.live.end(); for (let i = 0; i < 60 && st2.live.settling; i++) st2.live._tick(1 / 60); st2.live.finish();
  const k = st2.state.actors[0].keys[0].position;
  assert.ok(Math.abs(k[1] - DOCK) < 0.01 && k[2] > -18, `keyed along the dock at its top (${k})`);
  onDock(st2, "d", "dragged");
  // the speedboat in the tank: keyed at 0 on its deck (as placeInFrame keys a person) stands on the deck
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const st3 = tank([boat, at0("e", [[0, [-0.45, 0, -0.8]], [120, [0.45, 0, -0.8]]])]);
  for (let f = 0; f < 121; f += 12) {
    st3.setFrame(f);
    const g = st3.actorMeshes.get("e"), d = st3._deckAt(g.position.x, g.position.z, 6, f);
    assert.ok(!g.userData.swimOn, `deck f${f}: not in the water`);
    assert.ok(Math.abs(lowest(g) - d) < 0.08, `deck f${f}: the feet on the deck (lowest ${lowest(g).toFixed(2)}, deck ${d.toFixed(2)})`);
  }
  // dragged out of the water onto the speedboat: seated aboard (the drag mounts them), never left in the swim pose
  const st4 = tank([boat, at0("s", [[0, [4, 0, -1]]])]);
  const g4 = st4.actorMeshes.get("s");
  st4.setFrame(0);
  assert.ok(g4.userData.swimOn, "swimming beside the boat before the drag");
  assert.ok(st4.live.begin("s", { clientX: 0, clientY: 0 }, ray(4, -1)));
  for (let i = 1; i <= 40; i++) { st4.live.move({ clientX: i * 5, clientY: 0 }, ray(4 - i * 0.1, -1)); st4.live._tick(1 / 60); }
  st4.live.end(); for (let i = 0; i < 60 && st4.live.settling; i++) st4.live._tick(1 / 60); st4.live.finish();
  assert.equal(st4.state.actors[1].mount_id, "b", "aboard the boat");
  const pts = (s, g) => { s.setFrame(30); g.updateMatrixWorld(true); const o = []; g.traverse((n) => { if (n.isMesh && n.visible) o.push(n.getWorldPosition(new THREE.Vector3()).toArray()); }); return o; };
  const after = pts(st4, g4), fresh = tank(structuredClone(st4.state.actors)), again = pts(fresh, fresh.actorMeshes.get("s"));
  assert.ok(!g4.userData.swimOn, "not in the swim pose after the drag");
  assert.equal(after.length, again.length);
  after.forEach((p, i) => assert.ok(p.every((v, j) => Math.abs(v - again[i][j]) < 1e-6), "posed exactly as the saved scene shows them (seated)"));
});

test("a hop on the dock, a key a little high, and a speedboat deck on a swell keep the person aboard (was: through the dock, to the lake floor, into the sea)", () => {
  const DOCK = 1.81;
  // a 0.5 m hop on the dock (8fc04ef: dropped to 0.78 m under the dock top), and a man keyed 0.2 m over it (fell to
  // the lake floor)
  const st = tank([keyed("h", "man", [[0, [-6, DOCK, -16]], [12, [-6, DOCK + 0.5, -16]], [24, [-6, DOCK, -16]]]), keyed("a", "man", [[0, [-6.5, DOCK + 0.2, -14]]])], { set: "lake", keepSet: true, frames: 73 });
  const hop = [];
  for (let f = 0; f < 73; f++) {
    st.setFrame(f);
    for (const id of ["h", "a"]) assert.ok(!st.actorMeshes.get(id).userData.swimOn, `${id} f${f}: not in the water`);
    hop.push(lowest(st.actorMeshes.get("h")));
    assert.ok(Math.abs(lowest(st.actorMeshes.get("a")) - DOCK) < 0.08, `keyed 0.2 m high f${f}: stands on the dock (${lowest(st.actorMeshes.get("a")).toFixed(2)})`);
  }
  assert.ok(Math.min(...hop) > DOCK - 0.08, `the hop never goes through the dock (lowest ${Math.min(...hop).toFixed(2)})`);
  assert.ok(hop[12] > DOCK + 0.35, `it goes up (${hop[12].toFixed(2)} at the top)`);
  assert.ok(Math.abs(hop[40] - DOCK) < 0.08, `and lands back on it (${hop[40].toFixed(2)})`);
  for (let f = 1; f < 73; f++) assert.ok(Math.abs(hop[f] - hop[f - 1]) < 0.12, `f${f}: a smooth arc (${hop[f - 1].toFixed(2)} -> ${hop[f].toFixed(2)})`);
  // the speedboat on a long ocean swell (the deck heaves ~1 m): keyed at the deck at f0, or at the deck at mid-shot
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const sea = { set: "open_water", keepSet: true, frames: 241, env: { sea_state: "swell" } };
  const probe = tank([boat], sea);
  const decks = Array.from({ length: 241 }, (_, f) => probe._deckAt(0, -1, 8, f));
  assert.ok(Math.max(...decks) - Math.min(...decks) > 0.5, `the deck really heaves (${Math.min(...decks).toFixed(2)}..${Math.max(...decks).toFixed(2)})`);
  for (const k of [decks[0], decks[120]]) {
    const st2 = tank([boat, keyed("d", "man", [[0, [0, k, -1]]])], sea);
    const g = st2.actorMeshes.get("d");
    let wet = 0, worst = 0;
    for (let f = 0; f < 241; f++) {
      st2.setFrame(f);
      if (g.userData.swimOn) wet++;
      worst = Math.max(worst, Math.abs(lowest(g) - st2._deckAt(g.position.x, g.position.z, 8, f)));
    }
    assert.equal(wet, 0, `keyed at ${k.toFixed(2)}: never in the sea (${wet} of 241 frames)`);
    assert.ok(worst < 0.1, `keyed at ${k.toFixed(2)}: the feet ride the deck (worst ${worst.toFixed(2)} m off it)`);
  }
});

// Fifth pass (2026-11-07): the App could not put a person on the dock. placeInFrame and a live drag met the screen ray
// with flat ground at y 0 (and a drag refused the 1.81 m dock top as too high to climb), so a person aimed at the deck
// with the camera looking along the dock landed ~3 m past its end in 1.2 m of water; from overhead ~2.5 m off.
test("placeInFrame and a live drag hit the dock's top: a person aimed at the deck lands where aimed, on it (was: ~3 m past its end, in the water)", () => {
  const DOCK = 1.81, at0 = (id, keys) => ({ id, name: id, kind: "man", height_m: 1.8, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0 });
  for (const cam of [{ position: [-6, 3.2, -26], target: [-6, 1.8, -16], focal_mm: 35 }, { position: [-6, 14, -18], target: [-6, 0, -16], focal_mm: 28 }, { position: [-3, 9, -12], target: [-6, 1.8, -17], focal_mm: 30 }]) {
    const st = tank([at0("p", [[0, [0, 0, -30]]])], { set: "lake", keepSet: true });
    st._shotCameraAt = () => cam;
    const r = st.placeInFrame("p", { x: "center", y: 0.5 });
    // where the centre ray meets the dock's top (y 1.81)
    const c = new THREE.Vector3(...cam.position), d = new THREE.Vector3(...cam.target).sub(c).normalize(), aim = c.clone().addScaledVector(d, (DOCK - c.y) / d.y);
    assert.ok(r.ok && Math.hypot(r.position[0] - aim.x, r.position[2] - aim.z) < 0.05, `${cam.position}: lands where aimed (${r.position} vs ${aim.toArray().map((v) => v.toFixed(2))})`);
    assert.ok(Math.abs(r.position[1] - DOCK) < 0.01, `${cam.position}: keyed at the dock's top (${r.position[1]})`);
    for (const f of [0, 60]) {
      st.setFrame(f);
      const g = st.actorMeshes.get("p");
      assert.ok(!g.userData.swimOn && Math.abs(lowest(g) - DOCK) < 0.08, `${cam.position} f${f}: standing on the dock (lowest ${lowest(g).toFixed(2)})`);
    }
  }
  // aimed past the dock's end: in the water there, as before
  const st0 = tank([at0("q", [[0, [0, 0, -30]]])], { set: "lake", keepSet: true });
  st0._shotCameraAt = () => ({ position: [-6, 3.2, -8], target: [-6, 0, -2], focal_mm: 35 });
  const r0 = st0.placeInFrame("q", { x: "center", y: 0.5 });
  assert.ok(r0.ok && r0.position[1] === 0 && r0.position[2] > -9, `past the dock: keyed at 0 in the water (${r0.position})`);
  // a real drag from the water beside the dock onto it: they climb up onto it and are keyed at its top
  const ray = (x, z) => ({ ray: new THREE.Ray(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0)) });
  const st = tank([at0("d", [[0, [-9, 0, -16]]])], { set: "lake", keepSet: true });
  const g = st.actorMeshes.get("d");
  assert.ok(st.live.begin("d", { clientX: 0, clientY: 0 }, ray(-9, -16)));
  for (let i = 1; i <= 70; i++) { st.live.move({ clientX: i, clientY: 0 }, ray(-9 + Math.min(i, 40) * 0.1, -16)); st.live._tick(1 / 60); }
  assert.ok(Math.abs(lowest(g) - DOCK) < 0.08, `up on the dock at the end of the drag (lowest ${lowest(g).toFixed(2)})`);
  st.live.end(); for (let i = 0; i < 60 && st.live.settling; i++) st.live._tick(1 / 60); st.live.finish();
  const k = st.state.actors[0].keys[0].position;
  assert.ok(Math.abs(k[1] - DOCK) < 0.01 && Math.abs(k[0] + 5) < 0.2, `keyed on the dock at its top (${k})`);
  st.setFrame(30);
  assert.ok(!g.userData.swimOn && Math.abs(lowest(g) - DOCK) < 0.08, `stands on it after (lowest ${lowest(g).toFixed(2)})`);
  // and dragged back off it into the water: placed in the water (0), not keyed at the dock's height to drop from
  st.setFrame(0);
  assert.ok(st.live.begin("d", { clientX: 0, clientY: 0 }, ray(-5, -16)));
  for (let i = 1; i <= 70; i++) { st.live.move({ clientX: i, clientY: 0 }, ray(-5 + Math.min(i, 40) * 0.1, -16)); st.live._tick(1 / 60); }
  st.live.end(); for (let i = 0; i < 60 && st.live.settling; i++) st.live._tick(1 / 60); st.live.finish();
  const k2 = st.state.actors[0].keys[0].position;
  assert.ok(k2[1] === 0 && k2[0] > -2, `off the dock: keyed at 0 in the water (${k2})`);
});

// Fifth pass: 2895a92 read a person keyed at 0 over the water as standing on whatever was above them (from 3 m over
// the surface). Walking at 0 along the lake's dock and off its end, the feet went 1.81, 1.81, 0 on f58-60 (8fc04ef: worst
// step 0.16 m); someone placed under the dock at 0, wading, was put on top of it. Keyed at 0 where they can stand is
// the lake bed (placeInFrame and a drag key the dock's own height when they put someone on it).
const stepsOf = (st, id, n) => { const lo = []; for (let f = 0; f < n; f++) { st.setFrame(f); lo.push(lowest(st.actorMeshes.get(id))); } let w = 0, at = 0; for (let f = 1; f < n; f++) { const d = Math.abs(lo[f] - lo[f - 1]); if (d > w) { w = d; at = f; } } return { lo, worst: w, at }; };
test("walking on and off the lake's dock: keyed at 0 they wade under it, keyed on it they step off and drop in, no 1.8 m jump (was: feet 1.81 -> 0 in one frame)", () => {
  const DOCK = 1.81, at0 = (id, keys) => ({ id, name: id, kind: "man", height_m: 1.8, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0 });
  const lake = { set: "lake", keepSet: true };
  for (const [what, keys] of [["along the dock and off its end", [[0, [-6, 0, -20]], [96, [-6, 0, -3]]]], ["sideways across it", [[0, [-10, 0, -16]], [96, [-2, 0, -16]]]]]) {
    const st = tank([at0("p", keys)], lake), s = stepsOf(st, "p", 121);
    assert.ok(s.worst < 0.25, `${what} at 0: no jump (worst feet step ${s.worst.toFixed(2)} m at f${s.at})`);
    assert.ok(Math.max(...s.lo) < 0.5, `${what} at 0: wading on the lake bed, never lifted onto the dock (highest ${Math.max(...s.lo).toFixed(2)})`);
    for (const f of [0, 60, 120]) { st.setFrame(f); assert.ok(st.actorMeshes.get("p").userData.gaitOn, `${what} f${f}: walking (wading)`); }
    const ref = s.lo.slice(), back = stepsOf(st, "p", 121).lo;
    for (const f of [90, 3, 58, 60, 59, 17]) { st.setFrame(f); assert.ok(Math.abs(lowest(st.actorMeshes.get("p")) - ref[f]) < 1e-9, `${what} f${f}: the same scrubbed`); }
    assert.deepEqual(back, ref);
  }
  // placed under the dock at 0 (wading): stays in the water under it
  const st = tank([at0("u", [[0, [-6, 0, -14]]])], lake);
  for (const f of [0, 60]) { st.setFrame(f); const y = lowest(st.actorMeshes.get("u")); assert.ok(y < 0.3, `under the dock f${f}: on the lake bed (lowest ${y.toFixed(2)}), not moved on top of it`); }
  // keyed on the dock (as placeInFrame now keys it) walking off the end: feet first off the end, a continuous drop
  const st2 = tank([keyed("o", "man", [[0, [-6, DOCK, -12]], [48, [-6, DOCK, -4]]])], lake), s2 = stepsOf(st2, "o", 121);
  assert.ok(Math.abs(s2.lo[0] - DOCK) < 0.08, "on the dock at the start");
  assert.ok(s2.worst < 0.3, `walked off the end: no pop (worst feet step ${s2.worst.toFixed(2)} at f${s2.at})`);
  assert.ok(Math.min(...s2.lo.slice(60)) < 0.4, "and ends in the water");
  // keyed at 0 on the speedboat's deck in the deep tank, walking off its side: they drop from the deck, never from 0
  // (straight to treading at the surface)
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const st3 = tank([boat, at0("d", [[0, [-0.45, 0, -0.8]], [48, [4, 0, -0.8]]])]), s3 = stepsOf(st3, "d", 121);
  for (let f = 21; f < 121; f++) assert.ok(Math.abs(s3.lo[f] - s3.lo[f - 1]) < 0.3, `off the deck f${f}: falls, no pop (${s3.lo[f - 1].toFixed(2)} -> ${s3.lo[f].toFixed(2)})`);
});

// Fifth pass: after 28ad716 an underwater stroke dropped in and keyed under handed back to its keys and then popped at
// the hips: keys at 0.6 m moving sideways (the curve between the 4.5 m and 0.6 m keys sags under the 0.35 m "on the
// floor" mark) surfaced at f50 (hips 1.25 -> 2.36) and went back under at f84 (2.41 -> 1.26); keys at 0.3 m were picked
// up mid-fall and dropped (1.22 -> 2.15 at f50); keys rising to the surface 1.58 -> 2.15 at f102; under, surface and
// under again 0.64 m at f111. The parent's worst was 0.26 m (the plunge itself).
test("an underwater stroke dropped in: moving sideways under, rising to the surface, going back under, keys near the floor: the hips, the tilt, the head and the feet never pop", () => {
  const cases = {
    "under, moving sideways x -3 -> 5 at 0.6 m": [[0, [-5, 4.5, 0]], [24, [-3, 0.6, 0]], [144, [5, 0.6, 0]]],
    "under, then the keys rise to the surface": [[0, [0, 4.5, 0]], [24, [0, 0.6, 0]], [96, [0, 0.6, 0]], [144, [0, 2.4, 0]]],
    "keys at 0.3 m (at the floor: swims at the surface)": [[0, [0, 4.5, 0]], [24, [0, 0.3, 0]], [144, [0, 0.3, 0]]],
    "under, surface, under again": [[0, [0, 4.5, 0]], [24, [0, 0.6, 0]], [60, [0, 0.6, 0]], [72, [0, 1.5, 0]], [100, [0, 1.5, 0]], [112, [0, 0.6, 0]]],
    "under, moving sideways and diagonally": [[0, [-5, 4.5, -2]], [24, [-3, 0.7, -1]], [90, [2, 0.5, 2]], [144, [5, 0.8, 0]]],
    "at the surface, then the keys dive under": [[0, [0, 4.5, 0]], [24, [0, 2.4, 0]], [72, [0, 2.4, 0]], [120, [0, 0.6, 0]], [144, [0, 0.6, 0]]],
  };
  // Sixth pass: part 2 eased only the hips. At the handoffs the body still turned in one frame (under, surface, under
  // again: 0.715 rad at f111, the head down 0.44 m, the lowest point up 0.65 m; under then rise and surface then dive
  // under 0.66-0.67 rad): the tilt, the head and the lowest point are measured too
  const worstOf = (arr, from, d = (p, q) => Math.abs(p - q)) => { let w = 0, at = 0; for (let f = Math.max(1, from); f < arr.length; f++) { const x = d(arr[f], arr[f - 1]); if (x > w) { w = x; at = f; } } return { w, at }; };
  for (const swim of ["flutter", "frog", "stroke"]) for (const [what, keys] of Object.entries(cases)) {
    const st = tank([keyed("u", "man", keys, { swim })], { frames: 145 });
    const g = st.actorMeshes.get("u"), h = [], hd = [], lo = [], q = [];
    for (let f = 0; f < 145; f++) { st.setFrame(f); h.push(hipsY(st, "u")); hd.push(headY(st, "u")); lo.push(lowest(g)); q.push(g.quaternion.clone()); }
    const all = worstOf(h, 1);
    assert.ok(all.w < 0.3, `${swim}, ${what}: worst hip step ${all.w.toFixed(2)} m at f${all.at}`);
    const late = worstOf(h, 37);
    assert.ok(late.w < 0.12, `${swim}, ${what}: after the plunge the hips move smoothly (worst ${late.w.toFixed(3)} m a frame at f${late.at})`);
    const tilt = worstOf(q, 37, (p, r) => p.angleTo(r)), head = worstOf(hd, 37), low = worstOf(lo, 37);
    assert.ok(tilt.w < 0.2, `${swim}, ${what}: the body turns smoothly (worst ${tilt.w.toFixed(3)} rad a frame at f${tilt.at})`);
    assert.ok(head.w < 0.15, `${swim}, ${what}: the head moves smoothly (worst ${head.w.toFixed(3)} m a frame at f${head.at})`);
    assert.ok(low.w < 0.25, `${swim}, ${what}: the lowest point moves smoothly (worst ${low.w.toFixed(3)} m a frame at f${low.at})`);
    for (const f of [83, 50, 102, 111, 116, 9, 140]) {
      st.setFrame(f);
      assert.ok(Math.abs(hipsY(st, "u") - h[f]) < 1e-9 && Math.abs(headY(st, "u") - hd[f]) < 1e-9 && g.quaternion.angleTo(q[f]) < 1e-6, `${swim}, ${what} f${f}: the same scrubbed out of order`);
    }
  }
  // the sideways swim really is under the whole way, not at the surface for f50-82
  const st = tank([keyed("u", "man", cases["under, moving sideways x -3 -> 5 at 0.6 m"], { swim: "flutter" })], { frames: 145 });
  const plan = st._swimPlan(st.state.actors[0], st.actorMeshes.get("u"));
  for (let f = 40; f < 145; f++) assert.equal(plan.mode[f], "under", `f${f}: under at the keyed depth`);
  for (const f of [60, 100, 140]) { st.setFrame(f); assert.ok(headY(st, "u") < LEVEL, `f${f}: the head under the surface`); }
});

// Fifth pass: a timed mount onto the speedboat (a swimmer keyed at 0, swimming x 4 -> 1, mount_at 60): 2895a92's keyed-
// at-0 support put them on the deck the frame the path reached its footprint (feet 2.33 -> 3.16 at f53, seven frames
// before the mount) and the hop then ran from up there, 0.3-0.5 m over the deck until f58.
test("a timed mount onto the speedboat from the water: swims until the hop, then climbs out from the water (was: popped onto the deck at f53)", () => {
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const sw = { id: "s", name: "s", kind: "man", height_m: 1.8, position: [4, 0, -1], keys: [{ frame: 0, position: [4, 0, -1] }, { frame: 60, position: [1, 0, -1] }], rotation_deg: 0, mount_id: "b", mount_at: 60 };
  const st = tank([boat, sw]), g = st.actorMeshes.get("s"), hop0 = 60 - 10;
  const low = [], hip = [];
  for (let f = 0; f < 90; f++) { st.setFrame(f); low.push(lowest(g)); hip.push(hipsY(st, "s")); if (f < hop0) assert.ok(g.userData.swimOn, `f${f}: still swimming before the hop`); }
  // (the feet go up and down 0.3 m with the kick; the hips stay at the surface)
  for (let f = 1; f < hop0; f++) assert.ok(Math.abs(hip[f] - hip[f - 1]) < 0.1, `f${f}: no pop before the hop (hips ${hip[f - 1].toFixed(2)} -> ${hip[f].toFixed(2)})`);
  assert.ok(Math.max(...low.slice(0, hop0)) < LEVEL, `in the water until the hop (highest feet ${Math.max(...low.slice(0, hop0)).toFixed(2)})`);
  for (let f = hop0; f <= 60; f++) assert.ok(Math.abs(hip[f] - hip[f - 1]) < 0.2, `f${f}: the hips climb out smoothly (${hip[f - 1].toFixed(2)} -> ${hip[f].toFixed(2)})`);
  const deck = st._deckAt(1, -1, 6, 70);
  st.setFrame(70);
  assert.ok(!g.userData.swimOn && lowest(g) < deck + 0.1, `aboard after the mount, not hovering over the deck (feet ${lowest(g).toFixed(2)}, deck ${deck?.toFixed(2)})`);
  for (const f of [55, 52, 30, 58]) { st.setFrame(f); assert.ok(Math.abs(lowest(g) - low[f]) < 1e-9, `f${f}: the same scrubbed`); }
});

// Fifth pass: on the dock or a deck the lifelike body stood its skeleton at the keys' own height (avatars.mjs used
// _heightAt): keyed at 0 on the speedboat's deck its feet were at 0.00 with the clay on the 2.6 m deck; keyed 0.2 m over
// the dock it stood 0.2 m in the air. It now gets the same support lift as the clay (stage._standOnKeys).
import * as Avatars from "../../web/stage/people/avatars.mjs";
function stubKit() {
  const geo = new THREE.BoxGeometry(50, 180, 30); geo.translate(0, 90, 0);
  const n = geo.attributes.position.count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(4 * n).fill(0), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(4 * n).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
  geo.clearGroups(); geo.addGroup(0, 24, 0); geo.addGroup(24, 12, 1);
  const body = new THREE.MeshStandardMaterial({ name: "x_body", map: new THREE.Texture() }); body.userData.role = "body";
  const hair = new THREE.MeshStandardMaterial({ name: "x_opacity", map: new THREE.Texture(), alphaTest: 0.5, side: THREE.DoubleSide }); hair.userData.role = "opacity";
  const mesh = new THREE.SkinnedMesh(geo, [body, hair]); mesh.name = "x_hipoly_81_bones";
  const bone = new THREE.Bone(); bone.name = "Bip01";
  const template = new THREE.Group(); template.add(mesh); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  return { template, meshName: mesh.name, materials: [body, hair], clips: {}, stature: 180, floor: 0, spec: { model: "Male_Adult_01" },
    idleBox: new THREE.Box3(new THREE.Vector3(-25, 0, -15), new THREE.Vector3(25, 180, 15)),
    faceless: { neutral: new THREE.MeshStandardMaterial(), hidden: new THREE.MeshBasicMaterial({ visible: false }) }, report: { missingMaps: [] } };
}
test("the lifelike body on the dock or a deck stands where the clay stands (was: its skeleton at the keys' height, under the deck)", async () => {
  const DOCK = 1.81;
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const at0 = (id, keys) => ({ id, name: id, kind: "man", height_m: 1.8, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0 });
  for (const [what, actors, opts, id, top] of [
    ["keyed 0.2 m over the dock", [keyed("a", "man", [[0, [-6.5, DOCK + 0.2, -14]]])], { set: "lake", keepSet: true }, "a", DOCK],
    ["keyed on the dock, walking along it", [keyed("w", "man", [[0, [-6, DOCK, -20]], [96, [-6, DOCK, -12]]])], { set: "lake", keepSet: true }, "w", DOCK],
    ["keyed at 0 on the speedboat's deck", [boat, at0("e", [[0, [-0.45, 0, -0.8]]])], {}, "e", null],
  ]) {
    const st = tank(actors, opts);
    const a = st.state.actors.find((x) => x.id === id), g = st.actorMeshes.get(id);
    const skin = Avatars.attachKit(st, a, g, stubKit());
    await null;
    for (const f of [0, 30, 60]) {
      st.setFrame(f);
      assert.ok(skin.shown, `${what} f${f}: the lifelike body shows (${skin.reason})`);
      skin.holder.updateMatrixWorld(true);
      const feet = skin.holder.getWorldPosition(new THREE.Vector3()).y, want = top ?? st._deckAt(g.position.x, g.position.z, 6, f);
      assert.ok(Math.abs(feet - want) < 0.06, `${what} f${f}: the lifelike feet on it (${feet.toFixed(2)}, surface ${want.toFixed(2)})`);
      assert.ok(Math.abs(feet - g.position.y) < 0.06, `${what} f${f}: where the clay stands (${feet.toFixed(2)} vs ${g.position.y.toFixed(2)})`);
    }
  }
});

// Sixth pass (2026-11-07): part 4's placeInFrame keyed a person at the top of ANY parked prop under 1.75 m it met (a car
// 1.561 m, a table 0.78 m, a crate 0.8 m) on dry land, and the key stayed up there when the prop was moved: standing in
// mid-air. A crate floating in the lake was a "top" too: keyed at 1.737 m, then they fell off it into the water. Only a
// dock or a boat's deck over the water keys the top now; on dry land they are keyed at 0 and _heightAt stands them on it.
test("placed on a parked car, table or crate on dry land: keyed at 0, standing on it, and on the ground once it is moved (was: keyed at its top, left in mid-air)", () => {
  const at0 = (id, keys) => ({ id, name: id, kind: "man", height_m: 1.8, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0 });
  const park = (id, kind) => ({ id, name: id, kind, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 });
  for (const kind of ["car", "table", "crate"]) {
    const st = tank([park("t", kind), at0("p", [[0, [5, 0, 5]]])], { set: "plaza", keepSet: true });
    st._shotCameraAt = () => ({ position: [0, 12, -2], target: [0, 0, 0], focal_mm: 35 });
    const top = st._obstacles().find((o) => o.id === "t").top;
    const r = st.placeInFrame("p", { x: "center", y: 0.5 });
    assert.ok(r.ok && r.position[1] === 0, `${kind}: keyed at 0, not at its top ${top.toFixed(2)} (${r.position})`);
    st.setFrame(10);
    const g = st.actorMeshes.get("p");
    assert.ok(Math.abs(lowest(g) - top) < 0.08, `${kind}: standing on it (lowest ${lowest(g).toFixed(2)}, top ${top.toFixed(2)})`);
    const t = st.state.actors[0]; t.keys[0].position = [10, 0, 10]; t.position = [10, 0, 10];
    st.setFrame(11); st.setFrame(10);
    assert.ok(Math.abs(lowest(g)) < 0.08, `${kind} moved away: on the ground, not in mid-air (lowest ${lowest(g).toFixed(2)})`);
  }
  // a crate floating in the lake is not a place to stand: never keyed at its top to fall off it
  const st = tank([{ id: "c", name: "c", kind: "crate", position: [-12, 0, -5], keys: [{ frame: 0, position: [-12, 0, -5] }], rotation_deg: 0 }, at0("p", [[0, [0, 0, 0]]])], { set: "lake", keepSet: true });
  st._shotCameraAt = () => ({ position: [-12, 8, -10], target: [-12, 1.74, -5], focal_mm: 35 });
  const r = st.placeInFrame("p", { x: "center", y: 0.5 });
  assert.ok(r.ok && r.position[1] === 0, `the floating crate: keyed at 0 (${r.position})`);
  const lo = [];
  for (let f = 0; f < 61; f++) { st.setFrame(f); lo.push(lowest(st.actorMeshes.get("p"))); }
  for (let f = 1; f < 61; f++) assert.ok(Math.abs(lo[f] - lo[f - 1]) < 0.12, `f${f}: no fall off the crate (${lo[f - 1].toFixed(2)} -> ${lo[f].toFixed(2)})`);
  // the dock over the water still keys its top (tested above); the speedboat's deck in the tank too
  const boat = { id: "b", name: "b", kind: "speedboat", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 };
  const st2 = tank([boat, at0("q", [[0, [4, 0, 4]]])], { keepSet: true });
  st2._shotCameraAt = () => ({ position: [0, 14, -3], target: [0, 0, -0.8], focal_mm: 35 });
  const r2 = st2.placeInFrame("q", { x: "center", y: 0.5 });
  assert.ok(r2.ok && r2.position[1] > 2, `on the speedboat's deck in the tank: keyed at the deck (${r2.position})`);
});
