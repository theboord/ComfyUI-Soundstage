// Foot grounding for lifelike people (web/stage/people/footplant.mjs, called by people/avatars.mjs avatarsAt):
// stance detection, planted feet that don't slide, two-bone leg IK on the avatar's own skeleton, slopes, the pelvis
// coming down, turn steps, blends with no pop, determinism, and the modes that skip grounding.
// node --test tests/js/footplant.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import * as F from "../../web/stage/people/footplant.mjs";
import * as K from "./footkit.mjs";

const { NOT_INSTALLED } = K;

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

// ---------------------------------------------------------------- the real avatars on a bare stage (tests/js/footkit.mjs)
const { realKits, bareStage, clayOf, setup, walker } = K;
const run = (st, a, opts) => K.measure(st, a, opts);

/**
 * Per foot over the frames the plan plants it: the lowest shoe vertex's distance from the ground (worstH), and
 * PHYSICALLY over the whole shot (footkit physical): the most a shoe vertex touching the ground moves from where it
 * touched down while it keeps touching (worstSlide; a planted foot rolls heel to toe over its contact, so following
 * one vertex of a mid-stance pose over the whole stance no longer measures sliding).
 */
function stanceStats(st, out, lr) {
  let worstH = 0, frames = 0;
  for (const r of out.rows) if (r[lr].state === 1) { frames++; worstH = Math.max(worstH, Math.abs(r[lr].h)); }
  const p = K.physical(out);
  return { worstH, worstSlide: p.drift, frames, p };
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
      // (a touching vertex followed over the whole shot: up to 1.1 cm on the 6.8 degree ramp, measured 2026-11-07)
      assert.ok(s.worstSlide <= (c.name === "ramp" ? 0.015 : 0.01), `${kind} ${c.name} ${lr}: slid ${(100 * s.worstSlide).toFixed(2)} cm`);
    }
    if (c.name === "ramp") {
      // heel and toe both on the ramp: the planted foot is pitched up the slope, on top of the clip's own roll (a
      // planted foot rolls with the clip, heel strike to toe off; the clip's feet are posed for level ground)
      const f = out.skin.feet.plan.segs.l.find((sg) => sg.anchor > 40 && out.rows[sg.anchor].l.state === 1).anchor;
      const side = st.actorMeshes.get(a.id).userData.humanSkin.kit.feet.l;
      const pitchOf = (m) => { const up = side.up.clone().transformDirection(m); return Math.atan2(-up.x, up.y); };   // walking +X up the slope: the sole's normal leans back toward -X
      st.footGrounding = false;
      const clip = run(st, a, { ground: c.ground });
      st.footGrounding = true;
      const pitch = pitchOf(out.rows[f].l.m) - pitchOf(clip.rows[f].l.m);
      assert.ok(Math.abs(pitch - Math.atan(slope)) < 0.03, `${kind}: the sole is pitched ${(pitch * 57.3).toFixed(1)} deg (over the clip's own) on a ${(Math.atan(slope) * 57.3).toFixed(1)} deg ramp`);
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
      // (1.13 cm on frame 1: the walker turns from facing +Z to +X on the spot at 540 deg/s before setting off)
      assert.ok(s.frames > 25 && s.worstH < 0.01 && s.worstSlide <= 0.015, `${kind} dock ${lr}: ${s.frames} planted, ${(100 * s.worstH).toFixed(2)} cm off, slid ${(100 * s.worstSlide).toFixed(2)} cm`);
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
      // turning on the ball the forefoot's edge sweeps a little (1.06 cm over a stance, measured); per frame under 1 cm
      assert.ok(s.worstH < 0.01 && s.worstSlide <= 0.015 && s.p.slide <= 0.01, `${kind} ${lr}: planted ${(100 * s.worstH).toFixed(2)} cm off, slid ${(100 * s.worstSlide).toFixed(2)} cm, ${(100 * s.p.slide).toFixed(2)} cm in a frame`);
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
