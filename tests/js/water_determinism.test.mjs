// Water determinism (web/stage/waves.mjs, boatsim.mjs, watercraft.mjs, swim.mjs, particles.mjs, the stage's boat pass):
// a seeded run is a pure function of its inputs. The same seed gives bit-identical paths, strokes, spray, bubbles and
// swim poses on every run and in a fresh module instance; different seeds really differ; nothing reads Math.random or
// the clock; baking boat B before boat A (or with no B at all) gives A the same result; odd seeds (0, negative, huge,
// fractional, strings, NaN) give finite, non-degenerate water; and the sims that say they are frame-rate independent are.
// node --test tests/js/water_determinism.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as W from "../../web/stage/waves.mjs";
import * as BS from "../../web/stage/boatsim.mjs";
import * as WC from "../../web/stage/watercraft.mjs";
import * as Swim from "../../web/stage/swim.mjs";
import * as PT from "../../web/stage/particles.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";

const STAGE = new URL("../../web/stage/", import.meta.url);
/** A second, independent instance of a module (its own caches and module state): ESM caches by URL. */
const fresh = (name, tag) => import(new URL(`${name}?fresh=${tag}`, STAGE).href);

/** Plain numbers out of anything (typed arrays included), for deepEqual: bit-identical, not "close". */
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)));

/** Run fn with Math.random, Date.now and performance.now throwing: the seeded path must not touch any of them. */
function noChance(fn) {
  const saved = [Math.random, Date.now, performance.now];
  const boom = (what) => () => { throw new Error(`${what} called on a seeded path`); };
  Math.random = boom("Math.random"); Date.now = boom("Date.now"); performance.now = boom("performance.now");
  try { return fn(); } finally { [Math.random, Date.now, performance.now] = saved; }
}

/** A straight swim along +z at v m/s for `secs` seconds at fps (time-based, so different fps are the same swim). */
function swimPath(v, fps, secs = 4, { y = 1.2, mode = "under", turn = 0 } = {}) {
  const pos = [], yaw = [], modes = [];
  const n = Math.round(secs * fps) + 1;
  for (let f = 0; f < n; f++) {
    const t = f / fps, h = turn * t;
    pos.push(turn ? [v * (1 - Math.cos(h)) / turn, y, v * Math.sin(h) / turn] : [0, y, v * t]); yaw.push(h); modes.push(mode);
  }
  return { pos, yaw, mode: modes };
}

/** Everything seeded the water does, as plain data, from one set of modules. */
function waterRun(M, { seaSeed = 3, swimSeed = 5, physicsSeed = 1, id = "raft_1" } = {}) {
  const { W: w, BS: bs, WC: wc, Swim: sw, PT: pt } = M;
  const F = w.makeField("moderate", { wind_deg: 30, seed: seaSeed });
  const run = bs.simulateBoat(bs.boatScript("whitewater_raft", {}), { frames: 72, fps: 24, waves: F, level: 1.4 });
  const spans = bs.strokeSpans(run);
  const tr = { x: run.frames.map((s) => s.x), z: run.frames.map((s) => s.z), h: run.frames.map((s) => s.h), fps: 24 };
  const fl = bs.floatTrack("raft", tr, { waves: F, level: 1.4 });
  fl.forEach((s, f) => { s.strokes = bs.hullOf("raft").paddlers.map((p, seat) => ({ seat, ...(bs.strokeAt(spans, seat, f, 0.45) || { u: 0.75, side: p.side, wet: false }) })); });
  const em = wc.boatEmitters(fl, bs.hullOf("raft"), { fps: 24, level: 1.4, id });
  const wake = wc.wakeRibbons(fl, 60, { fps: 24, L: 4.3, B: 2, level: 1.4, F, t: 2.5 });
  const spray = pt.simulateParticles(em, { frames: 72, fps: 24, seed: physicsSeed });
  const plan = sw.planSwim({ ...swimPath(0.6, 24), fps: 24, seed: swimSeed });
  const poses = [0, 17.5, 40, 96].map((f) => sw.poseAt(plan, f));
  const bubbles = sw.exhaleBubbles(swimSeed, 3.3, (te) => [0, 2, te * 0.6], { surface: 10 });
  const tips = plan.pos.map((p, f) => [[p[0] - 0.15, 0.45 - 0.2 * Math.sin(plan.phase[f] * 2 * Math.PI), p[2] - 1], [p[0] + 0.15, 0.45 + 0.2 * Math.sin(plan.phase[f] * 2 * Math.PI), p[2] - 1]]);
  const wash = sw.finWashEmitters(tips, () => 0, { fps: 24, seed: physicsSeed, id: "diver" });
  const at = (fq) => (fq < 0 ? null : { x: 0, z: 0.9 * fq / 24, yaw: 0, v: 0.9 });
  const foam = sw.wakeFoam(at, 80, sw.planSwim({ ...swimPath(0.9, 24, 4, { mode: "surface" }), fps: 24, seed: swimSeed }), { seed: swimSeed });
  const live = new bs.LiveBoat("canoe", { waves: F, level: 1.4 });
  for (let f = 0; f < 120; f++) live.step({ throttle: 1, steer: f > 60 ? 0.4 : 0 }, 1 / 24, f);
  return plain({ heights: [0, 1.5, 3].map((t) => w.heightAt(F, 2, -1, t)), run: run.frames.map((s) => [s.x, s.z, s.h, s.y, s.pitch, s.roll, s.u]), spans,
    float: fl.map((s) => [s.y, s.pitch, s.roll, s.bowSpray]), em, wake: wake.pos, spray: spray.frames.filter((_, f) => f % 12 === 0), poses, bubbles, wash, foam,
    live: [live.X, live.Z, live.Hd, live.speed, live.strokes] });
}
const MODS = { W, BS, WC, Swim, PT };

// ------------------------------------------------------------------ same seed, same water

test("the seeded water never reads Math.random or the clock: sea, boat run, strokes, spray, wake, swim, bubbles, fin wash", () => {
  const a = noChance(() => waterRun(MODS));
  assert.ok(a.em.length > 20 && a.spans.length > 10 && a.bubbles.pos.length > 30 && a.wash.length > 0 && a.foam.length > 50, "the run exercises every emitter");
  assert.ok(a.spray.some((fr) => fr.n.dust + fr.n.debris > 0), "and the spray spawns particles");
});

test("the same seed gives bit-identical water on a rerun and in a fresh module instance (its own caches)", async () => {
  const a = waterRun(MODS), b = waterRun(MODS);
  assert.deepEqual(b, a, "rerun");
  const tag = `m${process.pid}`;
  const M2 = { W: await fresh("waves.mjs", tag), BS: await fresh("boatsim.mjs", tag), WC: await fresh("watercraft.mjs", tag), Swim: await fresh("swim.mjs", tag), PT: await fresh("particles.mjs", tag) };
  assert.notEqual(M2.Swim.surgeProfile, Swim.surgeProfile, "really a second instance");
  assert.deepEqual(waterRun(M2), a, "fresh module state");
});

test("the swim surge cache does not depend on which swimmer was planned first", async () => {
  // surgeProfile memoises per style and 5 cm/s: plan a fast then a slow swimmer in one fresh instance, the other way in another.
  const S1 = await fresh("swim.mjs", "order1"), S2 = await fresh("swim.mjs", "order2");
  const slow = { ...swimPath(0.35, 24), fps: 24, seed: 2 }, fast = { ...swimPath(0.95, 24, 4, { turn: 0.2 }), fps: 24, seed: 9, style: "frog" };
  const a1 = S1.planSwim(fast), b1 = S1.planSwim(slow);
  const b2 = S2.planSwim(slow), a2 = S2.planSwim(fast);
  assert.deepEqual(plain(a2), plain(a1)); assert.deepEqual(plain(b2), plain(b1));
  for (const f of [10, 50.5, 90]) { assert.deepEqual(plain(S2.poseAt(a2, f)), plain(S1.poseAt(a1, f))); assert.deepEqual(plain(S2.poseAt(b2, f)), plain(S1.poseAt(b1, f))); }
  // and a pose is a pure function of (plan, f): asking frames out of order changes nothing
  const order = [90, 3, 47, 3, 90].map((f) => plain(S1.poseAt(b1, f)));
  assert.deepEqual(order[1], order[3]); assert.deepEqual(order[0], order[4]);
});

// ------------------------------------------------------------------ different seeds, different water

test("different seeds really differ: the sea, the spray, the breathing and the bubbles", () => {
  const base = waterRun(MODS);
  const sea = waterRun(MODS, { seaSeed: 4 });
  assert.notDeepEqual(sea.heights, base.heights, "another sea");
  assert.notDeepEqual(sea.float.map((s) => s[0]), base.float.map((s) => s[0]), "the hull heaves on it differently");
  const other = waterRun(MODS, { id: "raft_2" });
  assert.deepEqual(other.float, base.float, "the boat's id does not move the hull");
  assert.notDeepEqual(other.em.map((e) => e.seed), base.em.map((e) => e.seed), "but it seeds its own spray");
  assert.notDeepEqual(other.spray, base.spray);
  const diver = waterRun(MODS, { swimSeed: 6 });
  assert.notDeepEqual(diver.bubbles, base.bubbles, "another diver's breath");
  assert.notDeepEqual(diver.foam, base.foam);
  assert.notEqual(Swim.breathAt(0, Swim.seedOf("diver_a")).period, Swim.breathAt(0, Swim.seedOf("diver_b")).period, "two divers breathe on their own cycles");
  const phys = waterRun(MODS, { physicsSeed: 2 });
  assert.notDeepEqual(phys.wash.map((e) => e.seed), base.wash.map((e) => e.seed), "the scene's physics seed reseeds the fin wash");
});

// ------------------------------------------------------------------ odd seeds

const ODD = [0, -3, 2.5, 7, 1e20, 1e300, -1e18, 2 ** 53, "abc", "storm"];

test("odd sea seeds give finite, non-degenerate seas; numeric strings are the number's sea; junk is the default sea", () => {
  // BUG (fixed): makeField chopped a swell with `seed + 17`, so sea_seed "7" seeded its chop "717" (another sea than
  // 7); "abc" or NaN made every wave height NaN; and past ~1e17 every train got the same phase and direction.
  const sig = new Map();
  for (const s of ODD) {
    const F = W.makeField("swell", { seed: s, wind_deg: 20 });
    const hs = [];
    for (let x = -20; x <= 20; x += 5) for (const t of [0, 2.2, 7.1]) hs.push(W.heightAt(F, x, x * 0.3, t));
    assert.ok(hs.every(Number.isFinite), `seed ${String(s)}: finite heights`);
    for (const G of [F, F.chop]) {
      const ph = new Set(), dir = new Set();
      for (let i = 0; i < G.n; i++) { ph.add(G.comps[i * 5 + 4].toFixed(6)); dir.add(Math.atan2(G.comps[i * 5 + 1], G.comps[i * 5 + 2]).toFixed(6)); }
      assert.equal(ph.size, G.n, `seed ${String(s)}: every train its own phase (${ph.size}/${G.n})`);
      assert.ok(dir.size > G.n * 0.8, `seed ${String(s)}: and its own direction`);
    }
    // the swell's height is the sea state's whatever the seed (4 sqrt(m0) = Hs)
    let m0 = 0;
    for (let i = 0; i < F.n; i++) m0 += F.comps[i * 5] ** 2 / 2;
    assert.ok(Math.abs(4 * Math.sqrt(m0) - F.hs) < 1e-9, `seed ${String(s)}: Hs`);
    sig.set(String(s), plain([F.comps, F.chop.comps]));
  }
  const keys = [...sig.keys()];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) assert.notDeepEqual(sig.get(keys[i]), sig.get(keys[j]), `seeds ${keys[i]} and ${keys[j]} differ`);
  const same = (a, b) => assert.deepEqual(plain(W.makeField("swell", { seed: a })), plain(W.makeField("swell", { seed: b })), `${String(a)} = ${String(b)}`);
  same("7", 7); same(" 2.5 ", 2.5); same(NaN, 1); same(null, 1); same(undefined, 1); same(Infinity, 1);
  // the stage path: environment.sea_seed as a string is the same sea as the number
  assert.deepEqual(plain(W.fieldFor({ set: "beach", sea_seed: "7" })), plain(W.fieldFor({ set: "beach", sea_seed: 7 })));
});

test("odd seeds for breath, bubbles, fin wash, wake foam and the particle solver: finite, spread out, numeric strings = numbers", () => {
  // BUG (fixed): exhaleBubbles(undefined) put every bubble on one spot (seed + idx is NaN), exhaleBubbles("3") built
  // its hashes from the string "3131..." (another diver than 3), and a scene physics seed of "abc" turned every particle
  // of the shot NaN (simulateParticles' curl field) and NaN-seeded the fin wash.
  const tips = [];
  for (let f = 0; f < 60; f++) tips.push([[0, 0.3 - 0.12 * Math.sin(f * 0.8), f * 0.02], [0.3, 0.3 - 0.12 * Math.cos(f * 0.8), f * 0.02]]);
  const emit = (te) => [0.2 * Math.sin(te), 2, te * 0.5];
  for (const s of [...ODD, undefined, null, NaN]) {
    const br = Swim.breathAt(10, s);
    assert.ok(br.period >= 3 && br.period <= 5 && Number.isFinite(br.lung), `breath seed ${String(s)}`);
    const b = Swim.exhaleBubbles(s, 12, emit, { surface: 10 });
    assert.ok(b.pos.length > 60 && b.pos.every(Number.isFinite) && b.size.every(Number.isFinite), `bubbles seed ${String(s)}`);
    assert.ok(new Set(b.pos.filter((_, i) => i % 3 === 0).map((x) => x.toFixed(4))).size > b.size.length * 0.8, `bubbles seed ${String(s)} spread out`);
    const wash = Swim.finWashEmitters(tips, () => 0, { seed: s, id: "d" });
    assert.ok(wash.length > 5 && wash.every((e) => Number.isFinite(e.seed) && Number.isFinite(e.dust)), `fin wash seed ${String(s)}`);
    const sim = PT.simulateParticles(wash, { frames: 40, seed: s });
    const fr = sim.frames[39];
    assert.ok(fr.n.dust > 10, `silt seed ${String(s)}`);
    const xs = new Set();
    for (let i = 0; i < fr.n.dust * PT.STRIDE.dust; i++) assert.ok(Number.isFinite(fr.dust[i]), `silt seed ${String(s)}: finite`);
    for (let i = 0; i < fr.n.dust; i++) xs.add([0, 1, 2].map((k) => fr.dust[i * PT.STRIDE.dust + k].toFixed(5)).join());
    assert.equal(xs.size, fr.n.dust, `silt seed ${String(s)}: no two grains in one place`);
    const at = (fq) => (fq < 0 ? null : { x: 0, z: fq / 24, yaw: 0, v: 1 });
    const plan = Swim.planSwim({ ...swimPath(1, 24, 4, { mode: "surface" }), fps: 24, seed: s });
    const foam = Swim.wakeFoam(at, 80, plan, { seed: s });
    assert.ok(foam.length > 50 && foam.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)), `foam seed ${String(s)}`);
  }
  assert.deepEqual(plain(Swim.exhaleBubbles("3", 12, emit)), plain(Swim.exhaleBubbles(3, 12, emit)), "bubbles: \"3\" = 3");
  assert.deepEqual(plain(Swim.breathAt(7.5, "3")), plain(Swim.breathAt(7.5, 3)));
  assert.deepEqual(plain(Swim.exhaleBubbles(undefined, 12, emit)), plain(Swim.exhaleBubbles(1, 12, emit)), "a missing seed is the default diver");
  assert.deepEqual(plain(Swim.finWashEmitters(tips, () => 0, { seed: "5", id: "d" })), plain(Swim.finWashEmitters(tips, () => 0, { seed: 5, id: "d" })));
});

// ------------------------------------------------------------------ boats don't share state

/** Every debris piece's offset from its emitter after one frame, for an emitter fired alone at t = 0. */
function debrisOffsets(e) {
  const sim = PT.simulateParticles([{ ...e, t: 0 }], { frames: 1, fps: 24, seed: 1 });
  const fr = sim.frames[0], out = [];
  for (let i = 0; i < fr.n.debris; i++) { const o = i * PT.STRIDE.debris; out.push([fr.debris[o] - e.pos[0], fr.debris[o + 1] - e.pos[1], fr.debris[o + 2] - e.pos[2]]); }
  return out;
}

test("no two spray emitters of a boat draw the same random stream (a raft crew catching together drips their own drops)", () => {
  // BUG (fixed): boatEmitters seeded each paddle drip `... + st.seat` and each bow sheet `... + sd` (±1). Particles draw
  // hash(seed + i), so seat k's drop i + 1 was seat k + 1's drop i (and the port sheet's particle i + 2 the starboard
  // sheet's i): the five raft paddlers, who catch on the same frame, threw the same splash pattern five times.
  const run = BS.simulateBoat(BS.boatScript("whitewater_raft", {}), { frames: 97, fps: 24 });
  const tr = run.frames.map((s) => ({ ...s, speed: s.u }));
  const em = WC.boatEmitters(tr, BS.hullOf("raft"), { fps: 24, id: "raft_1" });
  const byT = new Map();
  for (const e of em) (byT.get(e.t) || byT.set(e.t, []).get(e.t)).push(e);
  let pairs = 0, shared = 0;
  for (const group of byT.values()) {
    if (group.length < 2) continue;
    const offs = group.map(debrisOffsets);
    for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) {
      pairs++;
      for (const p of offs[a]) if (offs[b].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4)) shared++;
    }
  }
  assert.ok(pairs > 20, `${pairs} pairs of drips fired on the same frame`);
  assert.equal(shared, 0, `${shared} drops shared between emitters`);
  // the speedboat's two bow sheets too
  const sp = BS.simulateBoat(BS.boatScript("speedboat_run", {}), { frames: 120, fps: 24 });
  const sem = WC.boatEmitters(sp.frames.map((s) => ({ ...s, speed: s.u, bowSpray: 0.6, propWash: 0.8 })), BS.hullOf("speedboat"), { fps: 24, id: "sb" });
  const bow = sem.filter((e) => e.t === 2 && e.preset === "wet_spray");
  assert.equal(bow.length, 2);
  const seedsUsed = (e) => new Set([...Array(Math.max(e.dust, e.debris))].map((_, i) => (e.seed + i).toFixed(9)));
  const s0 = seedsUsed(bow[0]);
  assert.ok(![...seedsUsed(bow[1])].some((x) => s0.has(x)), "port and starboard sheets draw different hashes");
});

/** A headless stage (as tests/js/swim.test.mjs). */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };
function headless(scene) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), ...structuredClone(scene) }, view: "clay", key: "start", frame: 0, actorMeshes: new Map(),
    root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {} });
  st.scene.add(st.root); st._buildSet(); st._setGroup = undefined; st._buildActors?.(); st.setFrame(0);
  return st;
}
const CANOE = { id: "canoe_a", name: "Canoe", kind: "canoe", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 48, position: [0.5, 0, 4.5] }] };
const SPEED = { id: "speed_b", name: "Speedboat", kind: "speedboat", position: [8, 0, -5], keys: [{ frame: 0, position: [8, 0, -5] }, { frame: 48, position: [8, 0, 22] }] };
const lake = (actors) => ({ shot: { frames: 49, fps: 24 }, environment: { set: "lake", sea_state: "breeze", sea_seed: 4 }, actors });

test("two boats on one stage: baking B before A, or no B at all, gives A the same float and spray; scrubbing order doesn't matter", () => {
  clearSetCache();
  const ab = headless(lake([CANOE, SPEED]));
  clearSetCache();
  const ba = headless(lake([SPEED, CANOE]));
  clearSetCache();
  const alone = headless(lake([CANOE]));
  const trackOf = (st, id, f) => { st.setFrame(f); return st._boatTracks.get(id).track; };
  // bake in opposite orders: AB asks frame 40 then 5, BA the other way round, alone only once
  const tAB = plain(trackOf(ab, "canoe_a", 40)), tBA = plain(trackOf(ba, "canoe_a", 5)), tA = plain(trackOf(alone, "canoe_a", 22));
  assert.ok(tA.length === 49 && tA.some((s) => Math.abs(s.pitch) > 1e-4), "a real floated track");
  assert.deepEqual(tAB, tA, "A beside B = A alone");
  assert.deepEqual(tBA, tA, "B baked first = A first");
  assert.deepEqual(plain(trackOf(ab, "speed_b", 5)), plain(trackOf(ba, "speed_b", 40)), "and B is B either way");
  // the spray: each boat's emitters are its own, whatever the actor order
  const emOf = (st, id) => { const g = st.actorMeshes.get(id), a = st.state.actors.find((x) => x.id === id);
    return plain(WC.boatEmitters(st._boatTracks.get(id).track, BS.hullFor(a.kind, st._boatScale(a, g)), { fps: 24, level: st.water.position.y, id })); };
  assert.deepEqual(emOf(ab, "canoe_a"), emOf(alone, "canoe_a"));
  assert.deepEqual(emOf(ba, "speed_b"), emOf(ab, "speed_b"));
  const bySeed = (list) => plain(list).sort((p, q) => p.seed - q.seed);
  assert.deepEqual(bySeed(ab._boatEmitters()), bySeed(ba._boatEmitters()), "the stage's spray list is the same set");
  // the pose at a frame is the same however the playhead got there
  const poseAt = (st, path) => { for (const f of path) st.setFrame(f); const g = st.actorMeshes.get("canoe_a"); return [...g.position.toArray(), ...g.quaternion.toArray()]; };
  const p1 = poseAt(ab, [30]), p2 = poseAt(ab, [48, 0, 12, 30]), p3 = poseAt(ba, [7, 30]);
  p2.forEach((x, i) => assert.ok(Math.abs(x - p1[i]) < 1e-12, "scrubbed")); p3.forEach((x, i) => assert.ok(Math.abs(x - p1[i]) < 1e-12, "other stage"));
});

test("the particle solver's result does not depend on the order the emitters come in", () => {
  const sp = BS.simulateBoat(BS.boatScript("speedboat_run", {}), { frames: 72, fps: 24 });
  const tr = BS.floatTrack("speedboat", { x: sp.frames.map((s) => s.x), z: sp.frames.map((s) => s.z), h: sp.frames.map((s) => s.h), fps: 24 }, {});
  const rf = BS.simulateBoat(BS.boatScript("whitewater_raft", {}), { frames: 72, fps: 24 }).frames.map((s) => ({ ...s, speed: s.u, x: s.x + 10 }));
  const em = [...WC.boatEmitters(tr, BS.hullOf("speedboat"), { id: "sb" }), ...WC.boatEmitters(rf, BS.hullOf("raft"), { id: "raft" })];
  assert.ok(em.length > 30);
  const a = plain(PT.simulateParticles(em, { frames: 72, seed: 2 }).frames);
  const rev = plain(PT.simulateParticles([...em].reverse(), { frames: 72, seed: 2 }).frames);
  const shuffled = em.map((e, i) => [((i * 7919) % 101) / 101, e]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const sh = plain(PT.simulateParticles(shuffled, { frames: 72, seed: 2 }).frames);
  assert.deepEqual(rev, a); assert.deepEqual(sh, a);
});

// ------------------------------------------------------------------ frame-rate independence

test("a boat preset run keeps the shot's clock at any frame rate: 25 and 50 fps are the same voyage as 24", () => {
  // BUG (fixed): simulateBoat stepped Math.round(240 / fps) x 1/240 s per frame. At 25 fps that is 10 steps = 1/24 s, so
  // the boat ran 4 % ahead of the frames: a 4 s canoe shot covered 5.0 m instead of 4.76 m, and the script's beats
  // (the turn, the ferry, the tack) fired early. Each substep is now 1 / (fps * substeps).
  const ref = {};
  for (const fps of [24, 25, 30, 50, 60]) {
    for (const id of ["canoe_lake", "speedboat_run"]) {
      const frames = Math.round(fps * 7) + 1;
      const run = BS.simulateBoat(BS.boatScript(id, {}), { frames, fps });
      run.frames.forEach((s, f) => { if (f % fps === 0) assert.ok(Math.abs(s.t - f / fps) < 1e-9, `${id} @ ${fps} fps: frame ${f} is t = ${f / fps} s (sim says ${s.t})`); });
      const last = run.frames[frames - 1];
      ref[id] ||= last;
      const R = ref[id], tol = id === "canoe_lake" ? 0.03 : 0.25;
      assert.ok(Math.hypot(last.x - R.x, last.z - R.z) < tol, `${id} @ ${fps} fps ends where 24 fps does (${last.z.toFixed(3)} vs ${R.z.toFixed(3)} m)`);
      assert.ok(Math.abs(last.u - R.u) < tol * 0.5, `${id} @ ${fps} fps same speed`);
    }
  }
});

test("a live boat (Drive mode) runs the same at any call rate: 24, 30, 60 or 144 Hz", () => {
  for (const kind of ["kayak", "canoe", "speedboat", "dinghy"]) {
    const res = [24, 30, 60, 144].map((hz) => {
      const b = new BS.LiveBoat(kind, { wind: [0, -6], heading: kind === "dinghy" ? BS.headingForTwa([0, -6], 70) : 0 });
      let s;
      for (let i = 0; i < hz * 6; i++) s = b.step({ throttle: 1, sprint: true, steer: i >= hz * 3 ? 0.4 : 0 }, 1 / hz, (i * 24) / hz);
      return { x: b.X, z: b.Z, h: b.Hd, u: s.u, n: b.strokes.length };
    });
    for (const r of res.slice(1)) {
      assert.ok(Math.hypot(r.x - res[0].x, r.z - res[0].z) < 0.1, `${kind}: same place (${r.x.toFixed(2)}, ${r.z.toFixed(2)})`);
      assert.ok(Math.abs(r.u - res[0].u) < 0.02 && Math.abs(r.h - res[0].h) < 0.01, `${kind}: same speed and heading`);
      assert.ok(Math.abs(r.n - res[0].n) <= 1, `${kind}: the same strokes recorded (${r.n} vs ${res[0].n})`);
    }
  }
});

test("a swim plan is the same swim at 24, 30, 48 or 60 fps: phase, breath and pose at the same moment", () => {
  const at = {};
  for (const fps of [24, 30, 48, 60]) {
    const plan = Swim.planSwim({ ...swimPath(0.6, fps, 5, { turn: 0.15 }), fps, seed: 5 });
    for (const t of [1.5, 3, 4.5]) {
      const f = t * fps, p = Swim.poseAt(plan, f);
      const row = [plan.phase[Math.round(f)], p.pitch, p.roll, p.heave, p.legs.l.hip[0], p.legs.r.knee, p.arms.l.sh[0]];
      at[t] ||= row;
      row.forEach((x, i) => assert.ok(Math.abs(x - at[t][i]) < 0.01, `t ${t} s @ ${fps} fps: [${i}] ${x.toFixed(4)} vs ${at[t][i].toFixed(4)}`));
    }
  }
});
