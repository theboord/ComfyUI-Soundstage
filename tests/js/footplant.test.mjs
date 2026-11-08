// Foot grounding for lifelike people (web/stage/people/footplant.mjs, called by people/avatars.mjs avatarsAt):
// stance detection, planted feet that don't slide, two-bone leg IK on the avatar's own skeleton, slopes, the pelvis
// coming down, turn steps, blends with no pop, determinism, and the modes that skip grounding.
// node --test tests/js/footplant.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import * as F from "../../web/stage/people/footplant.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";

const RB = fileURLToPath(new URL("../../web/stage/people/rocketbox/", import.meta.url));
const installed = existsSync(`${RB}Male_Adult_01.fbx`) && existsSync(`${RB}Female_Adult_01.fbx`) && existsSync(`${RB}anim/f_walk_neutral_01.max.fbx`);
const NOT_INSTALLED = !installed && "Rocketbox files not installed (web/stage/people/rocketbox/)";

// ---------------------------------------------------------------- pure parts (no assets)
test("cleanRuns / runsOf / detectStance: hysteresis, blips dropped, short lifts closed, skipped frames never planted", () => {
  assert.deepEqual(F.cleanRuns([1, 1, 1, 0, 1, 1, 0, 0, 1, 0], 3, 1).map(Number), [1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(F.runsOf([0, 1, 1, 0, 1]), [[1, 3], [4, 5]]);
  // in at 2.5 cm / 0.3 m/s, kept up to 4 cm / 0.45 m/s
  const h = [0.1, 0.02, 0.03, 0.035, 0.03, 0.05, 0.05, 0.02, 0.02, 0.02];
  const v = [1, 0.1, 0.4, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  assert.deepEqual(F.detectStance(h, v, null).map(Number), [0, 1, 1, 1, 1, 0, 0, 1, 1, 1]);
  const skip = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0];
  assert.deepEqual(F.detectStance(h, v, skip).map(Number), [0, 1, 1, 1, 1, 0, 0, 0, 0, 0], "a stance never runs across a jump");
  assert.equal(F.rampWeight(0, 3), 1); assert.equal(F.rampWeight(4, 3), 0);
  assert.ok(F.rampWeight(1, 3) > F.rampWeight(2, 3) && F.rampWeight(2, 3) > F.rampWeight(3, 3) && F.rampWeight(3, 3) > 0);
});

test("scheduleSteps: walk stances stay one segment; a turn on the spot steps one foot at a time, the other planted", () => {
  const n = 120, all = new Array(n).fill(true);
  // walking: short stances, little drift -> one segment per stance, anchored mid-stance, no steps
  const walk = { l: all.map((_, f) => f % 24 < 12), r: all.map((_, f) => f % 24 >= 12) };
  const flat = { l: new Float64Array(n).map((_, f) => f * 0.02), r: new Float64Array(n).map((_, f) => f * 0.02) };
  const w = F.scheduleSteps(walk, flat, 7);
  assert.equal(w.steps.l.length + w.steps.r.length, 0);
  assert.deepEqual(w.segs.l[0], { from: 0, to: 12, anchor: 5 });
  // turning in place: both feet down all shot, drifting 0.06 units a frame
  const turn = { l: all, r: all }, d = { l: new Float64Array(n).map((_, f) => 0.06 * f), r: new Float64Array(n).map((_, f) => 0.06 * f) };
  const t = F.scheduleSteps(turn, d, 7);
  assert.ok(t.steps.l.length >= 2 && t.steps.r.length >= 2, `steps l ${t.steps.l.length} r ${t.steps.r.length}`);
  const busy = new Array(n).fill(0);
  for (const lr of ["l", "r"]) for (const s of t.steps[lr]) for (let f = s.from; f < s.to; f++) busy[f]++;
  assert.ok(busy.every((b) => b <= 1), "never both feet in the air");
  // every planted segment drifts at most about half a unit either side of its anchor
  for (const lr of ["l", "r"]) for (const s of t.segs[lr]) {
    for (let f = s.from; f < s.to; f++) assert.ok(Math.abs(d[lr][f] - d[lr][s.anchor]) <= 0.56 + 0.06 * 8, `${lr} f${f} drift ${(d[lr][f] - d[lr][s.anchor]).toFixed(2)}`);
  }
});

test("twoBoneIK puts the foot on the target, keeps the bone lengths and bends the knee toward the pole", () => {
  const root = new THREE.Group(), thigh = new THREE.Bone(), calf = new THREE.Bone(), foot = new THREE.Bone();
  root.add(thigh); thigh.add(calf); calf.add(foot);
  thigh.position.set(0, 0.9, 0); calf.position.set(0, -0.45, 0.01); foot.position.set(0, -0.42, -0.01);
  root.updateMatrixWorld(true);
  const target = new THREE.Vector3(0.05, 0.12, 0.2), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);
  assert.ok(F.twoBoneIK(thigh, calf, foot, target, q, new THREE.Vector3(0, 0, 1)));
  root.updateMatrixWorld(true);
  const P = (b) => b.getWorldPosition(new THREE.Vector3());
  assert.ok(P(foot).distanceTo(target) < 1e-4, `foot at ${P(foot).toArray()}`);
  assert.ok(Math.abs(P(thigh).distanceTo(P(calf)) - calf.position.length()) < 1e-6 && Math.abs(P(calf).distanceTo(P(foot)) - foot.position.length()) < 1e-6);
  const lineZ = (y) => target.z * (0.9 - y) / (0.9 - target.y);
  assert.ok(P(calf).z > lineZ(P(calf).y) + 0.02, "the knee bends forward of the hip-foot line");
  assert.ok(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(q) < 1e-5, "the foot takes the asked rotation");
  // out of reach: straight leg toward it, no NaN
  F.twoBoneIK(thigh, calf, foot, new THREE.Vector3(0, -2, 0), null, new THREE.Vector3(0, 0, 1));
  root.updateMatrixWorld(true);
  assert.ok(Number.isFinite(P(foot).y) && P(foot).y < 0.9 - 0.86);
});

test("floorFor blends the clips' own floors by weight; footRig is null for a skeleton without Biped legs", () => {
  const kit = { floor: 0.2, floors: { idle: 0.2, walk: -0.4, run: 1.0 } };
  assert.equal(F.floorFor(kit, { idle: 1, walk: 0, run: 0 }), 0.2);
  assert.ok(Math.abs(F.floorFor(kit, { idle: 0.5, walk: 0.5, run: 0 }) - -0.1) < 1e-12);
  assert.equal(F.floorFor({ floor: 0.3 }, { idle: 1 }), 0.3, "no clip floors: the idle's");
  const geo = new THREE.BoxGeometry(); const n = geo.attributes.position.count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(4 * n).fill(0), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(4 * n).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
  const mesh = new THREE.SkinnedMesh(geo), bone = new THREE.Bone(); bone.name = "Bip01"; mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  const g = new THREE.Group(); g.add(mesh);
  assert.equal(F.footRig(g, mesh), null);
});

// ---------------------------------------------------------------- the real avatars on a bare stage
let _kits = null;
async function realKits() {
  if (_kits) return _kits;
  globalThis.document ||= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
  const { FBXLoader } = await import("../../web/vendor/addons/FBXLoader.mjs");
  const parse = (f, manager) => { const b = readFileSync(RB + f); return new FBXLoader(manager).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), RB); };
  _kits = {};
  for (const [kind, spec] of Object.entries(C.ROCKETBOX)) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => C.tgaToPng(u, `${RB}tex/`));
    const clips = Object.fromEntries(C.CLIP_KINDS.map((k) => [k, parse(`anim/${spec.clips[k]}.max.fbx`).animations[0]]));
    _kits[kind] = A.buildKit(parse(`${spec.model}.fbx`, manager), clips);
    _kits[kind].spec = spec;
  }
  return _kits;
}

/** A bare Stage (no renderer) with one person; options: setFx (floorAt), set boxes (colliders), frames. */
function bareStage(actors, { frames = 121, setFx = null, boxes = null } = {}) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames, fps: 24 }, actors, shots: [{ id: "s" }], active_shot: "s" };
  st.actorMeshes = new Map();
  st.frame = 0;
  st.setFrame = () => A.avatarsAt(st);
  st.onChange = () => {}; st.toJSON = () => st.state;
  if (setFx) st.setFx = setFx;
  st.root = new THREE.Group();
  const cols = boxes || [];
  st._setCollidersCached = () => cols;   // stable, like the real cache
  return st;
}
const clayOf = (st, a) => {
  const g = buildObject(a.kind, a.height_m, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })), a.appearance);
  g.position.set(...(a.keys?.[0]?.position || [0, 0, 0]));
  g.userData.actorId = a.id;
  st.actorMeshes.set(a.id, g);
  st.root.add(g);
  return g;
};

/** Every vertex the foot or the toe carries (any weight), per side, for measuring like the before-fix probe did. */
function shoeVerts(kit, mesh) {
  const bones = mesh.skeleton.bones.map((b) => b.name), si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  const out = { l: [], r: [] };
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    let best = -1, bw = 0;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
    const n = bones[best] || "";
    if (/_L_(Foot|Toe0)$/.test(n)) out.l.push(i); else if (/_R_(Foot|Toe0)$/.test(n)) out.r.push(i);
  }
  return out;
}

/** Run a shot (frames in `order`) and record, per frame and foot: the lowest shoe vertex over the ground under it, its
 *  index and position, the plan state, the foot bone's world matrix. */
function run(st, a, { order = null, ground = (x, z) => 0 } = {}) {
  const g = st.actorMeshes.get(a.id), skin = g.userData.humanSkin;
  const verts = shoeVerts(skin.kit, skin.mesh), v = new THREE.Vector3();
  const n = st._lastFrame() + 1, rows = new Array(n);
  for (const f of order || [...Array(n).keys()]) {
    st.frame = f; A.avatarsAt(st);
    skin.holder.updateMatrixWorld(true);
    const row = { shown: skin.shown, f };
    for (const lr of ["l", "r"]) {
      let lo = Infinity, li = -1, lp = null;
      for (const i of verts[lr]) {
        skin.mesh.getVertexPosition(i, v).applyMatrix4(skin.mesh.matrixWorld);
        const h = v.y - ground(v.x, v.z);
        if (h < lo) { lo = h; li = i; lp = v.clone(); }
      }
      row[lr] = { h: lo, i: li, p: lp, state: skin.feet?.plan?.state[lr][f] ?? -1, m: skin.bones[lr === "l" ? "Bip01_L_Foot" : "Bip01_R_Foot"].matrixWorld.clone() };
    }
    rows[f] = row;
  }
  return { rows, skin, verts, g };
}
/** The world position of vertex i at frame f (re-posed). */
const vertexAt = (st, skin, i, f) => { st.frame = f; A.avatarsAt(st); skin.holder.updateMatrixWorld(true); return skin.mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(skin.mesh.matrixWorld); };

/** Per foot, every run of planted frames (state 1): [from, to). */
const plantedRuns = (rows, lr) => F.runsOf(rows.map((r) => r[lr].state === 1));

function stanceStats(st, out, lr) {
  const { rows, skin } = out;
  let worstH = 0, worstSlide = 0, frames = 0;
  for (const [i, j] of plantedRuns(rows, lr)) {
    // the vertex lowest at mid-stance, followed over the whole stance
    const m = (i + j - 1) >> 1, vi = rows[m][lr].i;
    const p0 = vertexAt(st, skin, vi, i);
    for (let f = i; f < j; f++) {
      frames++;
      worstH = Math.max(worstH, Math.abs(rows[f][lr].h));
      const p = vertexAt(st, skin, vi, f);
      worstSlide = Math.max(worstSlide, Math.hypot(p.x - p0.x, p.z - p0.z));
    }
  }
  return { worstH, worstSlide, frames };
}

const walker = (kind, extra = {}, from = [-3, 0, 0], to = [3, 0, 0], frames = 120) => ({ id: `p_${kind}`, kind, height_m: kind === "man" ? 1.8 : 1.68,
  position: from, keys: [{ frame: 0, position: from }, { frame: frames, position: to }], ...extra });

async function setup(kind, actor, opts) {
  const K = await realKits();
  const st = bareStage([actor], opts);
  const g = clayOf(st, actor);
  st._loadKit = () => K[kind];
  A.attachKit(st, actor, g, K[kind]);
  await null;
  return st;
}

test("real Rocketbox: walking on flat ground, planted soles within 1 cm of the floor and sliding at most 1 cm per stance", { skip: NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    const a = walker(kind);   // 6 m in 5 s: 1.2 m/s
    const st = await setup(kind, a);
    const out = run(st, a);
    assert.ok(out.rows.every((r) => r.shown), "lifelike every frame");
    for (const lr of ["l", "r"]) {
      const s = stanceStats(st, out, lr);
      assert.ok(s.frames > 30, `${kind} ${lr}: ${s.frames} planted frames`);
      assert.ok(s.worstH < 0.01, `${kind} ${lr}: a planted sole ${(100 * s.worstH).toFixed(2)} cm off the floor`);
      assert.ok(s.worstSlide <= 0.01, `${kind} ${lr}: a planted sole slid ${(100 * s.worstSlide).toFixed(2)} cm`);
    }
    // nothing goes into the floor on any frame (a swinging foot, a blend)
    const deepest = Math.min(...out.rows.flatMap((r) => [r.l.h, r.r.h]));
    assert.ok(deepest > -0.01, `${kind}: a sole ${(100 * deepest).toFixed(2)} cm into the floor`);
  }
});

test("real Rocketbox: walk then stop, and a run: no sink at the idle <-> walk crossfade, the run's soles on the floor", { skip: NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    const stop = { id: "w2", kind, height_m: kind === "man" ? 1.8 : 1.68, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 60, position: [0, 0, 0] }, { frame: 120, position: [0, 0, 0] }] };
    const run1 = walker(kind, { id: "r2" }, [-6, 0, 0], [6, 0, 0]);   // 12 m in 5 s: 2.4 m/s, the walk-run blend and the run
    for (const a of [stop, run1]) {
      const st = await setup(kind, a);
      const out = run(st, a);
      for (const lr of ["l", "r"]) {
        const s = stanceStats(st, out, lr);
        assert.ok(s.frames > 10 && s.worstH < 0.01 && s.worstSlide <= 0.01, `${kind} ${a.id} ${lr}: ${s.frames} planted, ${(100 * s.worstH).toFixed(2)} cm off, slid ${(100 * s.worstSlide).toFixed(2)} cm`);
      }
      const deepest = Math.min(...out.rows.flatMap((r) => [r.l.h, r.r.h]));
      assert.ok(deepest > -0.01, `${kind} ${a.id}: a sole ${(100 * deepest).toFixed(2)} cm into the floor (was -2.6 cm at the crossfade)`);
    }
  }
});

test("real Rocketbox: standing still, both soles on the floor (the idle's hovering foot comes down)", { skip: NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    const a = { id: "s1", kind, height_m: kind === "man" ? 1.8 : 1.68, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
    const st = await setup(kind, a, { frames: 73 });
    const out = run(st, a);
    for (const lr of ["l", "r"]) {
      const s = stanceStats(st, out, lr);
      assert.ok(s.frames >= 60, `${kind} ${lr}: planted ${s.frames} of 73 frames`);
      assert.ok(s.worstH < 0.01 && s.worstSlide <= 0.01, `${kind} ${lr}: ${(100 * s.worstH).toFixed(2)} cm off, slid ${(100 * s.worstSlide).toFixed(2)} cm`);
    }
  }
});

test("real Rocketbox: a platform, a ramp and a deck: soles on the surface under them, the foot pitched to the slope", { skip: NOT_INSTALLED }, async () => {
  const slope = 0.12;   // ~6.8 degrees, a station ramp
  const cases = [
    { name: "platform", floorAt: () => 0.92, ground: () => 0.92 },
    { name: "ramp", floorAt: (x) => Math.max(0, slope * (x + 3)), ground: (x) => Math.max(0, slope * (x + 3)) },
  ];
  for (const kind of ["man", "woman"]) for (const c of cases) {
    const a = walker(kind, {}, [-2.5, 0, 0], [2.5, 0, 0]);
    const st = await setup(kind, a, { setFx: { id: c.name, floorAt: c.floorAt } });
    const out = run(st, a, { ground: c.ground });
    for (const lr of ["l", "r"]) {
      const s = stanceStats(st, out, lr);
      assert.ok(s.frames > 25, `${kind} ${c.name} ${lr}: ${s.frames} planted frames`);
      assert.ok(s.worstH < 0.01, `${kind} ${c.name} ${lr}: a planted sole ${(100 * s.worstH).toFixed(2)} cm off the surface`);
      assert.ok(s.worstSlide <= 0.01, `${kind} ${c.name} ${lr}: slid ${(100 * s.worstSlide).toFixed(2)} cm`);
    }
    if (c.name === "ramp") {
      // heel and toe both on the ramp: the planted foot's sole is pitched up the slope
      const f = out.rows.findIndex((r, i) => i > 40 && r.l.state === 1);
      const side = st.actorMeshes.get(a.id).userData.humanSkin.kit.feet.l;
      const up = side.up.clone().transformDirection(out.rows[f].l.m);
      const pitch = Math.atan2(-up.x, up.y);   // walking +X up the slope: the sole's normal leans back toward -X
      assert.ok(Math.abs(pitch - Math.atan(slope)) < 0.03, `${kind}: the sole is pitched ${(pitch * 57.3).toFixed(1)} deg on a ${(Math.atan(slope) * 57.3).toFixed(1)} deg ramp`);
    }
  }
  // a dock / deck: a set box 1.0 m high, the person keyed on its top (as placeInFrame keys someone on the lake dock)
  for (const kind of ["man", "woman"]) {
    const a = walker(kind, {}, [-2, 1.0, 0], [2, 1.0, 0]);
    const deck = { id: "dock", half: [4, 0.1, 1.5], pos: [0, 0.9, 0], quat: [0, 0, 0, 1] };
    const st = await setup(kind, a, { boxes: [deck] });
    const out = run(st, a, { ground: () => 1.0 });
    for (const lr of ["l", "r"]) {
      const s = stanceStats(st, out, lr);
      assert.ok(s.frames > 25 && s.worstH < 0.01 && s.worstSlide <= 0.01, `${kind} dock ${lr}: ${s.frames} planted, ${(100 * s.worstH).toFixed(2)} cm off, slid ${(100 * s.worstSlide).toFixed(2)} cm`);
    }
  }
});

test("real Rocketbox: no pop: through heel strike and toe off the sole moves no faster than the clip's own swing", { skip: NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    const a = walker(kind);
    const st = await setup(kind, a);
    const out = run(st, a);
    const plan = out.skin.feet.plan;
    st.footGrounding = false;   // the clip alone, for comparison
    const raw = run(st, a);
    assert.equal(out.skin.feet.plan, plan);
    let worst = 0, worstRaw = 0, at = "";
    for (const lr of ["l", "r"]) {
      for (let f = 1; f < out.rows.length; f++) worstRaw = Math.max(worstRaw, Math.abs(raw.rows[f][lr].h - raw.rows[f - 1][lr].h));
      for (let f = 2; f < out.rows.length - 1; f++) {
        if (plan.state[lr][f] === plan.state[lr][f - 1]) continue;
        for (let q = f - 1; q <= f + 1; q++) {
          const d = Math.abs(out.rows[q][lr].h - out.rows[q - 1][lr].h);
          if (d > worst) { worst = d; at = `${lr} f${q}`; }
        }
      }
    }
    assert.ok(worst < 0.04, `${kind}: the sole moves ${(100 * worst).toFixed(2)} cm in one frame at a contact change (${at})`);
    // measured 2026-11-07: man 2.9 vs the clip's 2.75 cm, woman under the clip's own
    assert.ok(worst <= worstRaw + 0.005, `${kind}: at a contact change about as fast as the clip's own foot anywhere (${(100 * worst).toFixed(2)} vs ${(100 * worstRaw).toFixed(2)} cm)`);
  }
});

test("real Rocketbox: deterministic: the same frame gives the same feet in any scrub order", { skip: NOT_INSTALLED }, async () => {
  const a = walker("woman");
  const st = await setup("woman", a);
  const fwd = run(st, a);
  const order = [...Array(121).keys()].map((i) => (i * 47) % 121);   // a scrambled order
  const scr = run(st, a, { order });
  const back = run(st, a, { order: [...Array(121).keys()].reverse() });
  for (let f = 0; f <= 120; f++) for (const lr of ["l", "r"]) {
    const e1 = fwd.rows[f][lr].m.elements, e2 = scr.rows[f][lr].m.elements, e3 = back.rows[f][lr].m.elements;
    for (let k = 0; k < 16; k++) assert.ok(Math.abs(e1[k] - e2[k]) < 1e-9 && Math.abs(e1[k] - e3[k]) < 1e-9, `frame ${f} ${lr}`);
  }
  // the plan rebuilt from scratch at any frame (an edit, a new set) gives the same feet as the cached one
  const skin = st.actorMeshes.get(a.id).userData.humanSkin;
  for (const f of [77, 3, 120, 40, 41, 0]) {
    skin.feet = null;
    st.frame = f; A.avatarsAt(st);
    const e = skin.bones.Bip01_L_Foot.matrixWorld.elements, e0 = fwd.rows[f].l.m.elements;
    for (let k = 0; k < 16; k++) assert.ok(Math.abs(e[k] - e0[k]) < 1e-9, `rebuilt plan, frame ${f}`);
  }
  // cheap: one plan per person per shot, then a frame costs the IK only
  const t0 = performance.now(); skin.feet = null; st.frame = 60; A.avatarsAt(st); const build = performance.now() - t0;
  const t1 = performance.now(); for (let f = 0; f <= 120; f++) { st.frame = f; A.avatarsAt(st); } const per = (performance.now() - t1) / 121;
  console.log(`foot plan: ${build.toFixed(1)} ms to build for 121 frames, ${per.toFixed(2)} ms a frame after`);
  assert.ok(build < 1500 && per < 15, `build ${build.toFixed(0)} ms, ${per.toFixed(1)} ms a frame`);
});

test("real Rocketbox: turning on the spot takes steps (one foot at a time) instead of swivelling over sliding feet", { skip: NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    // 360 degrees in 5 s, standing at the origin (heading keys, as a stunt / turn key writes them)
    const keys = [{ frame: 0, position: [0, 0, 0], heading_deg: 0 }, { frame: 120, position: [0, 0, 0], heading_deg: 360 }];
    const a = { id: "t1", kind, height_m: kind === "man" ? 1.8 : 1.68, position: [0, 0, 0], keys };
    const st = await setup(kind, a);
    const out = run(st, a);
    const plan = out.skin.feet.plan;
    assert.ok(plan.steps.l.length >= 2 && plan.steps.r.length >= 2, `${kind}: steps l ${plan.steps.l.length} r ${plan.steps.r.length}`);
    for (let f = 0; f <= 120; f++) assert.ok(!(plan.state.l[f] === 2 && plan.state.r[f] === 2), `${kind} f${f}: both feet off the ground`);
    for (const lr of ["l", "r"]) {
      const s = stanceStats(st, out, lr);
      assert.ok(s.worstH < 0.01 && s.worstSlide <= 0.01, `${kind} ${lr}: planted ${(100 * s.worstH).toFixed(2)} cm off, slid ${(100 * s.worstSlide).toFixed(2)} cm`);
    }
  }
});

test("real Rocketbox: skipped modes are untouched: in the air (a hop) and lifted by physics keep the clip's own legs", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  // a hop over a crate: the frames in the air show the clay; the plan marks them skipped and plants nothing across them
  const a = walker("man", {}, [-3, 0, 0], [3, 0, 0], 48);
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([a, crate], { frames: 49 });
  const g = clayOf(st, a); clayOf(st, crate).updateMatrixWorld(true);
  A.attachKit(st, a, g, K.man); await null;
  const air = [...Array(49).keys()].filter((f) => st._airborneAt(a, f));
  assert.ok(air.length > 0);
  st.frame = 0; A.avatarsAt(st);
  const plan = g.userData.humanSkin.feet.plan;
  for (const f of air) for (const lr of ["l", "r"]) { assert.equal(plan.skip[f], true); assert.equal(plan.w[lr][f], 0, `f${f} ${lr}`); }
  // physics lift: every frame skipped, the legs exactly the clip's
  const b = { id: "p2", kind: "man", height_m: 1.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], physics: { mode: "dynamic", lift: 0.5 } };
  const st2 = bareStage([b], { frames: 25 });
  const g2 = clayOf(st2, b);
  const skin = A.attachKit(st2, b, g2, K.man); await null;
  st2.frame = 10; A.avatarsAt(st2);
  assert.ok(skin.feet.plan.skip.every(Boolean));
  const q = skin.bones.Bip01_L_Calf.quaternion.clone();
  A.drive(skin, { frame: 10, fps: 24, speed: 0, phase: skin.gait.phase[10], seed: C.phaseSeed(b.id) });
  assert.ok(skin.bones.Bip01_L_Calf.quaternion.angleTo(q) < 1e-6, "the clip's own knee");
  // clay reasons (swim, ride, sit, tipped / lying) never reach the grounding: the body isn't posed at all
  const c = { id: "p3", kind: "man", height_m: 1.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], mount_id: "horse1" };
  const st3 = bareStage([c], { frames: 25 });
  const g3 = clayOf(st3, c);
  const s3 = A.attachKit(st3, c, g3, K.man); await null;
  st3.frame = 5; A.avatarsAt(st3);
  assert.equal(s3.shown, false); assert.equal(s3.feet, undefined, "no plan for a rider");
});

test("real Rocketbox: the clips' own floors are measured; the run no longer stands 2 cm into the floor", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  for (const kind of ["man", "woman"]) {
    const kit = K[kind];
    assert.ok(kit.feet?.l?.sole.length >= 10 && kit.feet.r.sole.length >= 10, `${kind}: sole points ${kit.feet?.l?.sole.length}`);
    for (const k of C.CLIP_KINDS) assert.ok(Number.isFinite(kit.floors[k]) && Math.abs(kit.floors[k]) < 4, `${kind} ${k} floor ${kit.floors[k]} cm`);
    assert.ok(Math.abs(kit.floors.idle - kit.floor) < 1, `${kind}: idle floor ${kit.floors.idle} vs frame 0 ${kit.floor}`);
  }
});
