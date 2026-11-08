// node --test tests/js/onemotion.test.mjs
// Lifelike-only plan, L1: one motion drives the visible body and the hidden logic rig; people are never clay.
// Real-kit tests are SKIPPED (never passed) without web/stage/people/rocketbox/.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import * as R from "../../web/stage/people/retarget.mjs";
import * as O from "../../web/stage/people/onemotion.mjs";
import { standInMaterial } from "../../web/stage/people/standin.mjs";
import { applyPose } from "../../web/stage/humans.mjs";
import { personKeypoints, toPixels } from "../../web/stage/posepass.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";
import * as F from "../../web/stage/people/footplant.mjs";
import { realKits, bareStage, clayOf, walker, NOT_INSTALLED } from "./footkit.mjs";

const W = (o) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new THREE.Vector3()); };
const DOWN = new THREE.Vector3(0, -1, 0);
/** The worst angle (degrees) between a clay limb and its visible bone. */
function limbAngle(skin, g) {
  let m = 0;
  for (const [bn, cn, jid] of R.AIM) {
    const d = W(skin.bones[cn]).sub(W(skin.bones[bn])).normalize();
    const c = DOWN.clone().applyQuaternion(g.userData.joints[jid].getWorldQuaternion(new THREE.Quaternion()));
    m = Math.max(m, THREE.MathUtils.radToDeg(d.angleTo(c)));
  }
  return m;
}
/** A full Stage without a renderer: the real setFrame (gait, mounts, gaze, avatarsAt, held props). */
function headless(actors, frames = 49, env = { set: "studio" }) {
  clearSetCache();
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: { set: env.set } },
    view: "color", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.state.shot = { ...(st.state.shot || {}), frames, fps: 24 };
  st.scene.add(st.root);
  st._buildSet();
  if (!env.keepSet) st._setGroup = undefined;
  return st;
}
async function withKit(st, K) {
  for (const a of st.state.actors) {
    if (!C.avatarSpecFor(a)) continue;
    const kind = C.avatarSpecFor(a).model === "Male_Adult_01" ? "man" : "woman";
    A.attachKit(st, a, st.actorMeshes.get(a.id), K[kind]);
  }
  await null;
}
/** Everything a frame shows of a person: the holder, every bone, every clay joint (rounded). */
function frameHash(st) {
  const parts = [];
  const r = (x) => Math.round(x * 1e5);
  for (const a of st.state.actors) {
    const g = st.actorMeshes.get(a.id), skin = g?.userData.humanSkin;
    if (!skin) continue;
    g.updateMatrixWorld(true);
    for (const e of skin.holder.matrixWorld.elements) parts.push(r(e));
    for (const b of Object.values(skin.bones)) for (const e of b.matrixWorld.elements) parts.push(r(e));
    for (const j of Object.values(g.userData.joints)) { const q = j.getWorldQuaternion(new THREE.Quaternion()); parts.push(r(q.x), r(q.y), r(q.z), r(q.w)); }
  }
  let h = 2166136261;
  for (const p of parts) h = Math.imul(h ^ p, 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- the pure rules
test("ownership: the clip on every ground frame, the rig eased in and out inside the airborne frames", () => {
  const air = new Set([20, 21, 22, 23, 24]);
  const w = (f) => O.rigWeight(f, (i) => air.has(i), 48);
  assert.equal(w(19), 0, "the clip up to the take-off");
  assert.ok(w(20) > 0 && w(22) > w(20) && w(24) < w(22));
  assert.equal(w(25), 0, "the clip on the landing frame");
  assert.equal(O.shownState({ skin: null }), "standin");
  assert.equal(O.shownState({ skin: {}, faceless: true }), "faceless");
  assert.equal(O.shownState({ skin: {} }), "lifelike");
});

test("boneFor maps every clay joint the gizmo shows to a Rocketbox bone", () => {
  assert.equal(R.boneFor("l_wrist"), "Bip01_L_Hand");
  assert.equal(R.boneFor("r_knee"), "Bip01_R_Calf");
  assert.equal(R.boneFor("head"), "Bip01_Head");
  assert.equal(R.boneFor("l_thumb_1"), "Bip01_L_Finger0");
  assert.equal(R.boneFor("r_index_3"), "Bip01_R_Finger12");
  assert.equal(R.boneFor("nope"), null);
});

// ---------------------------------------------------------------- no clay for people (static guard)
test("no-clay guard: the people code has no clay fallback left (no clayReason, no 'stays clay', no simple_model = clay)", () => {
  const dir = fileURLToPath(new URL("../../web/stage/people/", import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const src = readFileSync(dir + f, "utf8");
    assert.ok(!/clayReason/.test(src), `${f}: clayReason`);
    assert.ok(!/stay(s)? clay|drawn as the clay|shows? (as )?(the )?clay|back to (the )?clay/i.test(src), `${f}: a clay fallback in the words`);
    assert.ok(!/simple_model\)\s*return null/.test(src), `${f}: simple_model returns no avatar`);
  }
  const av = readFileSync(dir + "avatars.mjs", "utf8");
  assert.ok(!/setShown\(skin, !reason\)/.test(av), "avatarsAt never hides the body for a reason");
  assert.match(av, /setShown\(skin, true\)/);
});

// ---------------------------------------------------------------- stand-in
test("no kit (node, a child, a failed load): the marked stand-in, never the clay's own materials", () => {
  const kid = { id: "k1", kind: "child", height_m: 1.2, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const man = { id: "m1", kind: "man", height_m: 1.8, position: [2, 0, 0], keys: [{ frame: 0, position: [2, 0, 0] }] };
  const st = headless([kid, man], 25);
  st.setFrame(3);
  for (const id of ["k1", "m1"]) {
    const g = st.actorMeshes.get(id);
    assert.equal(g.userData.standIn, true, `${id}: stand-in`);
    assert.equal(st.avatarStatus(id).shownAs, "standin");
    g.traverse((o) => { if (o.isMesh && o.visible) { assert.equal(o.material, standInMaterial(), `${id}: ${o.name || "mesh"} drawn in its clay colour`); assert.equal(o.userData.role, "standin"); } });
  }
});

// ---------------------------------------------------------------- real kit
test("real Rocketbox: retarget: on the rig's frames (ride, cycle, sit, kayak, a tilt) the visible limbs lie along the rig's, the hips on the rig's", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  for (const kind of ["man", "woman"]) for (const pose of ["ride", "cycle", "sit", "kayak", "stand"]) {
    const a = { id: "p", kind, height_m: kind === "man" ? 1.8 : 1.68, position: [1, 0, 2], keys: [{ frame: 0, position: [1, 0, 2] }], mount_id: "h" };
    const st = bareStage([a], { frames: 25 });
    const g = clayOf(st, a); g.rotation.set(0.25, 0.7, -0.1);
    const skin = A.attachKit(st, a, g, K[kind]); await null;
    applyPose(g, pose, a.height_m);
    st.frame = 5; A.avatarsAt(st);
    assert.equal(skin.shown, true); assert.equal(skin.owner, "rig");
    assert.ok(limbAngle(skin, g) < 1, `${kind} ${pose}: limbs ${limbAngle(skin, g).toFixed(2)} deg off the rig`);
    const J = g.userData.joints, B = skin.bones;
    const hip = W(J.l_hip).add(W(J.r_hip)).multiplyScalar(0.5), bh = W(B.Bip01_L_Thigh).add(W(B.Bip01_R_Thigh)).multiplyScalar(0.5);
    assert.ok(hip.distanceTo(bh) < 0.005, `${kind} ${pose}: hips ${(hip.distanceTo(bh) * 100).toFixed(1)} cm apart`);
    assert.ok(skin.clay.every((m) => !m.visible), "the rig hidden");
  }
});

test("real Rocketbox: body solve: on the clip's frames the logic rig follows the visible body (limbs within 1 degree), and puts the clay back for the next frame", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const a = walker("man");
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const skin = A.attachKit(st, a, g, K.man); await null;
  A.undoAvatarWrites(st);   // (attach posed a frame already)
  const rest = Object.fromEntries(Object.entries(g.userData.joints).map(([k, j]) => [k, j.quaternion.clone()]));
  for (const f of [0, 17, 40, 77, 110]) {
    st.frame = f; A.avatarsAt(st);
    assert.equal(skin.owner, "clip");
    assert.ok(limbAngle(skin, g) < 1, `f${f}: ${limbAngle(skin, g).toFixed(2)} deg`);
  }
  A.undoAvatarWrites(st);
  for (const [k, j] of Object.entries(g.userData.joints)) assert.ok(j.quaternion.angleTo(rest[k]) < 1e-9, `${k} put back`);
});

test("real Rocketbox: determinism: forward, reverse, shuffled scrubs and a fresh stage give identical frames (a jump, a baked tilt, Drive, a carry, a carried person)", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const scene = () => [
    { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 40, position: [3, 0, 0] }] },
    { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] },
    { id: "p2", kind: "woman", height_m: 1.68, position: [0, 0, 3], keys: [{ frame: 0, position: [0, 0, 3] }], tilt: [0.3827, 0, 0, 0.9239] },
    { id: "p3", kind: "man", height_m: 1.8, position: [2, 0, 3], keys: [{ frame: 0, position: [2, 0, 3] }, { frame: 40, position: [4, 0, 5] }], face: "faceless" },
    { id: "box", kind: "crate", position: [2.4, 0, 3], keys: [{ frame: 0, position: [2.4, 0, 3] }], carry_id: "p3", carry_at: 10 },
    // review round 3: a carried PERSON (the carry pass sized the hold from a box that took in the lifelike holder where
    // the frame shown before left it: 0.2-3.5 mm with the scrub order, 146 mismatched hashes over 72 frames)
    { id: "q", kind: "man", height_m: 1.8, position: [-2, 0, -4], keys: [{ frame: 0, position: [-2, 0, -4] }, { frame: 40, position: [2, 0, -4] }] },
    { id: "pc", kind: "woman", height_m: 1.68, position: [-1.6, 0, -4], keys: [{ frame: 0, position: [-1.6, 0, -4] }], carry_id: "q", carry_at: 8 },
  ];
  const frames = [...Array(41).keys()];
  const run = async (order, drive = false) => {
    const st = headless(scene(), 41); await withKit(st, K);
    if (drive) st.drive = { on: true, live: new Set(["p3"]), involved: new Set(), owns: (id) => id === "p3", pose: () => false, pre() {}, post() {} };
    const out = {};
    for (const f of order) { st.setFrame(f); out[f] = frameHash(st); }
    return out;
  };
  const fwd = await run(frames);
  const rev = await run([...frames].reverse());
  const shuf = await run([...frames].sort((x, y) => ((x * 7919) % 41) - ((y * 7919) % 41)));
  for (const f of frames) { assert.equal(rev[f], fwd[f], `reverse f${f}`); assert.equal(shuf[f], fwd[f], `shuffled f${f}`); }
  const again = await run(frames);
  for (const f of frames) assert.equal(again[f], fwd[f], `fresh stage f${f}`);
  // Drive on (a recorded take under review): the rig owns p3, still the same in any order
  const d1 = await run(frames, true), d2 = await run([...frames].reverse(), true);
  for (const f of frames) assert.equal(d2[f], d1[f], `drive f${f}`);
});

test("real Rocketbox: never clay on any frame: ride (a horse), a carried person, a tilt, a jump, the floor; every logic mesh hidden", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const st = headless([
    { id: "h", kind: "horse", height_m: 1.6, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 40, position: [6, 0, 0] }] },
    { id: "r", kind: "man", height_m: 1.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], mount_id: "h" },
    { id: "w", kind: "woman", height_m: 1.68, position: [-3, 0, 2], keys: [{ frame: 0, position: [-3, 0, 2] }, { frame: 40, position: [3, 0, 2] }] },
    { id: "c1", kind: "crate", position: [0, 0, 2], keys: [{ frame: 0, position: [0, 0, 2] }] },
    { id: "t", kind: "man", height_m: 1.8, position: [0, 0, -3], keys: [{ frame: 0, position: [0, 0, -3] }], tilt: [0, 0, 0.7071, 0.7071] },
  ], 41);
  await withKit(st, K);
  for (let f = 0; f <= 40; f++) {
    st.setFrame(f);
    for (const id of ["r", "w", "t"]) {
      const g = st.actorMeshes.get(id), skin = g.userData.humanSkin;
      assert.equal(skin.shown, true, `${id} f${f}`);
      g.traverse((o) => { if (o.isMesh && !o.userData.avatar && o.visible && o.userData.role === "logic") assert.fail(`${id} f${f}: a logic mesh drawn (${o.name})`); });
    }
  }
  assert.equal(st.actorMeshes.get("r").userData.humanSkin.owner, "rig");
  assert.equal(st.actorMeshes.get("t").userData.humanSkin.owner, "rig");
});

test("real Rocketbox: a held prop follows the VISIBLE hand; the gizmo's dots sit on the visible bones (within 2 cm)", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const st = headless([
    { id: "p1", kind: "woman", height_m: 1.68, position: [-2, 0, 0], keys: [{ frame: 0, position: [-2, 0, 0] }, { frame: 40, position: [2, 0, 0] }] },
    { id: "cup", kind: "crate", height_m: 0.1, scale: 0.15, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], hold: [{ actor: "p1", hand: "r", from: 0, to: 40 }] },
  ], 41);
  await withKit(st, K);
  const g = st.actorMeshes.get("p1"), skin = g.userData.humanSkin;
  for (let f = 0; f <= 40; f++) {
    st.setFrame(f);
    const hand = W(skin.bones.Bip01_R_Hand), cup = W(st.actorMeshes.get("cup"));
    // review round 2: was within 15 cm of the hand bone on 3 frames; now every frame, in the grip (between the visible
    // thumb and index knuckles, measured 2.0 cm at most) and within 10 cm of the hand bone (8.3 measured)
    const grip = W(skin.bones.Bip01_R_Finger1).add(W(skin.bones.Bip01_R_Finger0)).multiplyScalar(0.5);
    assert.ok(hand.distanceTo(cup) < 0.10, `f${f}: the cup ${(hand.distanceTo(cup) * 100).toFixed(1)} cm from the visible hand`);
    assert.ok(grip.distanceTo(cup) < 0.03, `f${f}: the cup ${(grip.distanceTo(cup) * 100).toFixed(1)} cm from the visible grip`);
    if (f % 15 !== 5) continue;
    for (const id of ["l_wrist", "r_elbow", "head", "l_knee", "r_index_1"]) {
      const p = A.boneWorld(st, "p1", id), b = W(skin.bones[R.boneFor(id)]);
      assert.ok(p.distanceTo(b) < 0.02, `${id}`);
    }
  }
});

test("real Rocketbox: the Pose gizmo: dots, IK handles and the rotate ring on the visible bones; a ring turn is written to the logic joint and the body follows", { skip: NOT_INSTALLED }, async () => {
  const { PoseGizmo } = await import("../../web/stage/posegizmo.mjs");
  const K = await realKits();
  const st = headless([{ id: "p1", kind: "man", height_m: 1.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] }], 25);
  st.gizmoScene = new THREE.Scene();
  st._attachGizmo = () => {}; st.tc = { dragging: false };
  await withKit(st, K);
  st.selected = "p1";
  st.setFrame(4);
  const pg = new PoseGizmo(st);
  assert.equal(pg.setActive(true), true);
  const g = st.actorMeshes.get("p1"), skin = g.userData.humanSkin;
  for (const [id, dot] of pg.dots) {
    const bn = R.boneFor(id) || { l_hand: "Bip01_L_Hand", r_hand: "Bip01_R_Hand", l_foot: "Bip01_L_Foot", r_foot: "Bip01_R_Foot" }[id];
    if (!bn || !skin.bones[bn]) continue;
    assert.ok(dot.position.distanceTo(W(skin.bones[bn])) < 0.02, `${id}: ${(dot.position.distanceTo(W(skin.bones[bn])) * 100).toFixed(1)} cm off its bone`);
  }
  pg.pickJoint("l_elbow");
  const t = pg.target();
  assert.equal(t, pg.proxy, "the ring holds the handle on the visible elbow");
  assert.ok(t.position.distanceTo(W(skin.bones.Bip01_L_Forearm)) < 0.02);
  const before = W(skin.bones.Bip01_L_Hand);
  t.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.8));
  pg.fromGizmo();
  const a = st.state.actors[0];
  assert.ok(a.pose_keys?.[0]?.joints?.l_elbow, "written as a Pose key on the logic joint");
  st.setFrame(4);
  assert.ok(W(skin.bones.Bip01_L_Hand).distanceTo(before) > 0.05, "the visible forearm follows the edit");
  assert.ok(limbAngle(skin, g) < 1, "logic rig and body agree after the edit");
});

test("clock ban: the one-motion rules read no clock and no randomness (retarget, onemotion, avatarcore, tier, standin)", () => {
  for (const f of ["people/retarget.mjs", "people/onemotion.mjs", "people/avatarcore.mjs", "tier.mjs", "people/standin.mjs"]) {
    const src = readFileSync(fileURLToPath(new URL(`../../web/stage/${f}`, import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/Date\.now|performance\.now|Math\.random|setTimeout|setInterval|requestAnimationFrame/.test(src), `${f} reads a clock`);
  }
});

// ---------------------------------------------------------------- L1 review round 2
const kf = (frame, x, y, z) => ({ frame, position: [x, y, z] });
const man = (id, from, to, frames, extra = {}) => ({ id, name: id, kind: "man", height_m: 1.8, position: from, keys: [{ frame: 0, position: from }, { frame: frames, position: to }], rotation_deg: 0, ...extra });
const testDrive = (ids) => ({ on: true, pending: null, live: new Map(ids.map((i) => [i, {}])), involved: new Set(), owns(id) { return this.on && !this.pending && this.live.has(id); }, pose: () => false, pre() {}, post() {} });
/** A synthetic video-mocap take (the footcontact fixture's shape): standing, a step with the left foot at 20-31, a 0.3 m
 *  jump at 50-61. */
function mocapData(N = 72) {
  const P = (x, y, z) => [x, y, z], body = [], root = [];
  for (let i = 0; i < N; i++) {
    const step = i >= 20 && i <= 31 ? Math.sin(Math.PI * (i - 20) / 11) : 0;
    body.push([P(0, 1.65, 0.1), P(0, 1.45, 0), P(-0.18, 1.42, 0), P(-0.22, 1.15, 0), P(-0.22, 0.9, 0.02), P(0.18, 1.42, 0), P(0.22, 1.15, 0),
      P(0.22, 0.9, 0.02), P(-0.1, 0.9, 0), P(-0.1, 0.5, 0.01), P(-0.1, 0.08, 0), P(0.1, 0.9, 0), P(0.1, 0.5 + 0.2 * step, 0.3 * step), P(0.1, 0.08 + 0.4 * step, -0.05 * step),
      P(-0.03, 1.68, 0.09), P(0.03, 1.68, 0.09), P(-0.08, 1.66, 0), P(0.08, 1.66, 0)]);
    let y = 0;
    if (i >= 50 && i <= 61) { const t = (i - 50) / 11; y += 4 * 0.3 * t * (1 - t); }
    root.push([0, y, 0]);
  }
  return { fps: 24, frames: N, body, root, hands: [] };
}
/** The lowest visible sole point over the ground under it (m), and the clay's lowest shoe box over it. */
function soles(st, a, g, skin) {
  // (the surface under each point near its own height: a chair's seat beside the feet is not the floor)
  const shapes = st._supportShapes(), ground = (x, z, y) => st._supportAt(x, z, Math.max(0, y - 0.3), 0.6, shapes);
  skin.holder.updateMatrixWorld(true);
  let vis = Infinity, clay = Infinity;
  for (const lr of ["l", "r"]) { const p = F.solePoints(skin.mesh, skin.kit.feet[lr]); for (let i = 0; i < p.length; i += 3) vis = Math.min(vis, p[i + 1] - ground(p[i], p[i + 2], p[i + 1])); }
  const box = new THREE.Box3(), c = new THREE.Vector3();
  for (const lr of ["l", "r"]) for (const m of g.userData.joints[`${lr}_knee`].children) if (m.isMesh && m.geometry?.type === "BoxGeometry") { box.setFromObject(m, true); box.getCenter(c); clay = Math.min(clay, box.min.y - ground(c.x, c.z, box.min.y)); }
  return { vis, clay };
}

test("real Rocketbox: the visible feet are grounded on the rig's frames too (Drive, a mocap take, a hop onto a chair); a 1-degree tilt and the walk up to a timed mount stay on the clip", { skip: NOT_INSTALLED }, async () => {
  // review round 2 (measured on 0ce517f): lowest shoe of a Drive walker -6.0 .. +13.1 cm, a 1-degree-tilt walker
  // -6.0 .. +12.4, a chair with mount_at -24.8 .. +92.5 (the walk up rig-owned)
  const K = await realKits();
  const deg1 = [Math.sin(Math.PI / 360), 0, 0, Math.cos(Math.PI / 360)];
  const cases = [
    ["Drive walker", [man("p", [-3, 0, 0], [3, 0, 0], 96)], 96, (st) => { st.drive = testDrive(["p"]); }, "rig"],
    ["1-degree tilt walker", [man("p", [-3, 0, 0], [3, 0, 0], 96, { tilt: deg1 })], 96, null, "clip"],
    ["walks to a chair (mount_at)", [man("p", [-3, 0, 0], [-0.6, 0, 0], 40, { mount_id: "ch", mount_at: 54 }), { id: "ch", kind: "chair", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 70, null, null],
    ["a video mocap take (a step, a jump)", [man("p", [0, 0, 0], [0, 0, 0], 0, { keys: [kf(0, 0, 0, 0)], mocap: { data: mocapData(), start: 0, travel: false } })], 71, null, "rig"],
  ];
  for (const [what, actors, frames, prep, owner] of cases) {
    const st = headless(actors, frames + 1); await withKit(st, K);
    prep?.(st);
    const a = st.state.actors[0], g = st.actorMeshes.get("p"), skin = g.userData.humanSkin;
    let lo = Infinity, hi = -Infinity, at = -1, owners = new Set();
    for (let f = 0; f <= frames; f++) {
      st.setFrame(f);
      owners.add(skin.owner);
      if (owner) assert.equal(skin.owner, owner, `${what} f${f}: owned by the ${owner} (${skin.ownerReason})`);
      if (what.startsWith("walks") && f < 44) assert.equal(skin.owner, "clip", `${what} f${f}: the walk up is the clip's (was the rig's from frame 0)`);
      const s = soles(st, a, g, skin);
      // seated or getting on (the chair under the feet is no floor to stand on), or the clay's feet up (a jump)
      if (st._mountPhaseAt(a, f) === "hop" || skin.owner === "seat") continue;
      if (s.clay > 0.05) { assert.ok(s.vis > -0.01, `${what} f${f}: a shoe ${(s.vis * 100).toFixed(1)} cm under`); continue; }
      if (s.vis < lo) { lo = s.vis; at = f; }
      hi = Math.max(hi, s.vis);
    }
    assert.ok(lo > -0.01 && hi < 0.035, `${what}: the lowest shoe ${(lo * 100).toFixed(1)} .. ${(hi * 100).toFixed(1)} cm over the ground (f${at})`);
    if (what.startsWith("walks")) assert.deepEqual([...owners].sort(), ["clip", "rig", "seat"]);
  }
});

/** The clay's shoe boxes (what its feet are), world centres. */
const clayShoes = (g) => ["l", "r"].map((lr) => { const m = g.userData.joints[`${lr}_knee`].children.find((c) => c.isMesh && c.geometry?.type === "BoxGeometry"); return m ? W(m) : W(g.userData.joints[`${lr}_knee`]); });
/**
 * Per-frame acceleration (second difference, m/frame^2) of the visible pelvis, hands, feet and head over frames, and
 * the same of the STAGE'S OWN pose (the logic rig as setFrame posed it, before the avatar wrote over it: undoAvatarWrites):
 * hips, wrists, shoes and head. Review round 3: the old baseline read the logic rig after setFrame, but fitRig puts its
 * hips and wrists on the visible bones, so the cap grew with the very pop it was meant to catch. A change frame: the
 * owner, its weight or its reason changes (a hop turning into riding is one, though both are the rig's).
 */
function motion(st, id, frames) {
  const rows = [];
  const g = st.actorMeshes.get(id), skin = g.userData.humanSkin, B = skin.bones, J = g.userData.joints;
  for (const f of frames) {
    st.setFrame(f);
    const r = { f, own: skin.owner, why: skin.ownerReason, w: skin.rigWeight, pel: W(B.Bip01_Pelvis), j: [W(B.Bip01_L_Hand), W(B.Bip01_R_Hand), W(B.Bip01_L_Foot), W(B.Bip01_R_Foot), W(B.Bip01_Head)] };
    A.undoAvatarWrites(st);   // (the next setFrame starts with the same undo: nothing else changes)
    g.updateMatrixWorld(true);
    r.rig = W(J.l_hip).add(W(J.r_hip)).multiplyScalar(0.5);
    r.rj = [W(J.l_wrist), W(J.r_wrist), ...clayShoes(g), W(J.head)];
    rows.push(r);
  }
  const acc = (a, b, c) => c.clone().sub(b).sub(b.clone().sub(a)).length();
  const out = [];
  for (let i = 1; i < rows.length - 1; i++) {
    const [a, b, c] = [rows[i - 1], rows[i], rows[i + 1]];
    const changes = a.own !== b.own || b.own !== c.own || a.why !== b.why || b.why !== c.why || Math.abs(c.w - a.w) > 1e-9;
    out.push({ f: b.f, own: b.own, why: b.why, changes, pel: acc(a.pel, b.pel, c.pel), joint: Math.max(...b.j.map((p, k) => acc(a.j[k], p, c.j[k]))),
      rig: acc(a.rig, b.rig, c.rig), rigj: Math.max(...b.rj.map((p, k) => acc(a.rj[k], p, c.rj[k]))), pelP: b.pel, rigP: b.rig });
  }
  return out;
}
/** The caps at a change frame: pelvis 12 cm/frame^2, hands / feet / head 30, or 1.25x what the stage's own pose does
 *  there (its hips for the pelvis, its wrists / shoes / head for the joints). */
function checkPops(what, rows) {
  let changes = 0;
  for (const r of rows) {
    if (!r.changes) continue;
    changes++;
    const pCap = Math.max(0.12, 1.25 * r.rig), jCap = Math.max(0.30, 1.25 * r.rigj);
    assert.ok(r.pel <= pCap, `${what} f${r.f} (${r.own}, ${r.why}): pelvis ${(r.pel * 100).toFixed(1)} cm/frame^2 (cap ${(pCap * 100).toFixed(1)})`);
    assert.ok(r.joint <= jCap, `${what} f${r.f} (${r.own}, ${r.why}): a hand / foot / head ${(r.joint * 100).toFixed(1)} cm/frame^2 (cap ${(jCap * 100).toFixed(1)})`);
  }
  assert.ok(changes > 0, `${what}: the owner changes in the shot`);
}

test("real Rocketbox: no pop at any ownership change (a hop, a swim entry, a mount, a seat, a bike and a car hop): the body's per-frame acceleration stays capped against the stage's own pose", { skip: NOT_INSTALLED }, async () => {
  // review round 2 (measured on 0ce517f, per-frame movement): crate hop hand 76.4 cm at f12; dock to water hand 96.7
  // at f13, pelvis 21.5 at f11; chair walk-up pelvis 54.4 at f20; horse mount_at pelvis 85.1 at f8. Review round 3:
  // the baseline is the stage's own pose (see motion), and the hop turning into riding is a change frame: the bike and
  // the car's landing in the seat was 21.9 / 17.3 cm/frame^2 (the hop's arc came down into the seat at full speed).
  const K = await realKits();
  const D = 1.81;
  const cases = [
    ["a hop over a crate", [man("p", [-3, 0, 0], [3, 0, 0], 96), { id: "c1", kind: "crate", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 96, { set: "studio" }],
    ["walks into the tank and swims", [man("p", [-12, 0, 0], [0, 0, 0], 120)], 120, { set: "water_tank", keepSet: true }],
    ["off the dock into the lake", [man("p", [-6, D, -12], [-6, D, -4], 48, { key_y: true })], 96, { set: "lake", keepSet: true }],
    ["walks to a chair and sits (mount_at)", [man("p", [-3, 0, 0], [-0.6, 0, 0], 40, { mount_id: "ch", mount_at: 54 }), { id: "ch", kind: "chair", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 70, { set: "studio" }],
    ["walks to a horse and gets on (mount_at)", [man("p", [-3, 0, 1], [-0.8, 0, 1], 30, { mount_id: "h", mount_at: 60 }), { id: "h", kind: "horse", height_m: 1.6, position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 80, { set: "studio" }],
    ["walks to a bike and gets on (mount_at)", [man("p", [3, 0, 0], [1.2, 0, 0], 30, { mount_id: "v", mount_at: 50 }), { id: "v", kind: "bike", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 70, { set: "studio" }],
    ["walks to a car and gets in (mount_at)", [man("p", [3, 0, 0], [1.2, 0, 0], 30, { mount_id: "v", mount_at: 50 }), { id: "v", kind: "sports_car", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 70, { set: "studio" }],
  ];
  for (const [what, actors, frames, env] of cases) {
    const st = headless(actors, frames + 1, env); await withKit(st, K);
    checkPops(what, motion(st, "p", [...Array(frames + 1).keys()]));
  }
});

test("real Rocketbox: out of the tank over its wall: the rig keeps the body through the stage's climb out, then an eased handover; no pop, no slide through the wall", { skip: NOT_INSTALLED }, async () => {
  // review round 3 (measured on b4f20c4): the swim plan ended at f101 and the clip took the body at the walk's keys
  // while the stage's own climb out (_swimExits) still ran: over f94-101 the body slid 2.8 m forward and dropped 1.3 m
  // through the 4 m wall at x 7.8-8.2 (0.56 m in one frame), the pelvis 18.6 cm/frame^2. The corrected pop test fails
  // there on b4f20c4 (pelvis 19.4 cm/frame^2 at f95 against a 12 cm cap).
  const K = await realKits();
  const N = 181;
  const st = headless([man("p", [-12, 0, 0], [12, 0, 0], 120)], N, { set: "water_tank", keepSet: true }); await withKit(st, K);
  const a = st.state.actors[0], g = st.actorMeshes.get("p");
  const ex = st._swimExits(a, g);
  assert.ok(ex?.length, "the keys walk out over the wall (the stage eases them out)");
  const e = ex[0], end = e.f + (e.N ?? e.n);
  const rows = motion(st, "p", [...Array(N).keys()]);
  checkPops("across the tank", rows);
  for (const r of rows) {
    if (r.f >= e.f && r.f < end) {
      assert.equal(r.own, "rig", `f${r.f}: the rig keeps the body through the climb out (${r.why})`);
      // the body is where the stage's climbing rig is, not ahead at the walk's keys
      assert.ok(Math.hypot(r.pelP.x - r.rigP.x, r.pelP.z - r.rigP.z) < 0.15, `f${r.f}: the pelvis ${(Math.hypot(r.pelP.x - r.rigP.x, r.pelP.z - r.rigP.z) * 100).toFixed(1)} cm off the climbing rig`);
    }
  }
  // through the wall (x 7.8-8.2): never more than 0.25 m a frame across, never down more than 0.25 m a frame (the
  // stage's own step down starts at the water's edge, inside the wall: the keys walk through a 4 m wall, a known limit)
  for (let i = 1; i < rows.length; i++) {
    const p0 = rows[i - 1].pelP, p1 = rows[i].pelP;
    if (Math.max(p0.x, p1.x) < 7.6 || Math.min(p0.x, p1.x) > 8.4) continue;
    assert.ok(Math.abs(p1.x - p0.x) < 0.25, `f${rows[i].f}: the pelvis ${(Math.abs(p1.x - p0.x) * 100).toFixed(0)} cm across the wall in one frame`);
    assert.ok(p0.y - p1.y < 0.25, `f${rows[i].f}: the pelvis down ${((p0.y - p1.y) * 100).toFixed(0)} cm in one frame at the wall`);
  }
  // the handover after the climb out: eased (some frame with a rig weight strictly between 0 and 1), then the clip
  st.setFrame(end - 3); const w = g.userData.humanSkin.rigWeight;
  assert.ok(w > 0 && w < 1, `the handover eased (rig weight ${w} at f${end - 3})`);
  st.setFrame(end + 2); assert.equal(g.userData.humanSkin.owner, "clip");
});

test("real Rocketbox: a recorded Drive take with mount spans (into a sports car at 31, out at 60, an exit walk): the mount phase read from the spans for any frame, eased ownership, capped acceleration, identical in any scrub order and on a fresh stage", { skip: NOT_INSTALLED }, async () => {
  // review round 3 (measured on b4f20c4): DriveMode.pre() writes this frame's mount into a.mount_id / mount_at, so the
  // handover read the wrong mount for the neighbouring frames: full rig on f73, full clip on f74 (feet 74-86 cm/frame^2,
  // a hand 61-70); the foot plan's key changed each frame; and a person's walk bank (rotation.z, set only on frames it
  // walks) was kept from the frame shown before over a vault (frames 4-15 differed with the scrub order).
  const { DriveMode } = await import("../../web/stage/drive.mjs");
  const K = await realKits();
  const N = 111, frames = [...Array(N).keys()];
  const scene = () => [
    { ...man("p", [4, 0, 0], [1.3, 0, 0], 21), keys: [kf(0, 4, 0, 0), kf(21, 1.3, 0, 0), kf(59, 1.4, 0, 0.4), kf(74, 1.4, 0, 0.4), kf(80, 1.55, 0, 0.4), kf(86, 1.9, 0, 0.4), kf(110, 3.8, 0, 0.4)],
      mount_spans: [{ host: "car", seat: 0, pose: null, from: 31, to: 60 }] },
    { id: "car", kind: "sports_car", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] },
  ];
  const make = async () => { const st = headless(scene(), N); st.drive = new DriveMode(st); await withKit(st, K); return st; };
  const st = await make();
  const a = st.state.actors[0];
  assert.deepEqual([10, 25, 40, 65, 80].map((f) => st._mountPhaseAt(a, f)), [null, "hop", "on", "off", null], "the phase from the spans, whatever frame is shown");
  st.setFrame(40);
  assert.deepEqual([25, 65, 80].map((f) => st._mountPhaseAt(a, f)), ["hop", "off", null], "... also while Drive.pre() has this frame's mount in a.mount_id");
  const rows = motion(st, "p", frames);
  checkPops("the recorded car take", rows);
  const eased = rows.filter((r) => r.f >= 60 && r.f < 80 && r.changes && r.own === "rig");
  assert.ok(eased.length >= 4, `the way out eased over several frames (${eased.map((r) => r.f)})`);
  const hashes = async (order) => { const s = await make(); const out = {}; for (const f of order) { s.setFrame(f); out[f] = frameHash(s); } return out; };
  const fw = await hashes(frames), rv = await hashes([...frames].reverse()), sh = await hashes([...frames].sort((x, y) => ((x * 7919) % N) - ((y * 7919) % N)));
  for (const f of frames) { assert.equal(rv[f], fw[f], `reverse f${f}`); assert.equal(sh[f], fw[f], `shuffled f${f}`); }
  for (const f of [8, 25, 45, 66, 73, 74, 90]) assert.equal((await hashes([f]))[f], fw[f], `fresh stage f${f}`);
});

test("real Rocketbox: off the feet on the rig's frames the body stays out of the ground (lying, knocked over walking, physics after its takeover); before the takeover the clip walks grounded; a lean the clip keeps and a chair keep the soles down", { skip: NOT_INSTALLED }, async () => {
  // review round 3 (measured on b4f20c4): knocked over the body lay 19-26 cm into the floor, a 45-degree walking tilt
  // 33 cm; physics.baked made the whole shot the rig's (the walk before the hit hovered 1-14 cm); a 29-degree tilt on the
  // clip hovered up to 10.9 cm; seated on a chair the soles hovered 4-5 cm
  const K = await realKits();
  const low = (skin) => { const m = skin.mesh, v = new THREE.Vector3(); skin.holder.updateMatrixWorld(true); let lo = Infinity; for (let i = 0; i < m.geometry.attributes.position.count; i += 3) { m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld); lo = Math.min(lo, v.y); } return lo; };
  const sole = (skin) => { let lo = Infinity; for (const lr of ["l", "r"]) { const p = F.solePoints(skin.mesh, skin.kit.feet[lr]); for (let i = 1; i < p.length; i += 3) lo = Math.min(lo, p[i]); } return lo; };
  const q = (ax, deg) => { const h = (deg * Math.PI) / 360; return [ax[0] * Math.sin(h), ax[1] * Math.sin(h), ax[2] * Math.sin(h), Math.cos(h)]; };
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const physKeys = Array.from({ length: 48 }, (_, f) => {
    const t = Math.min(1, Math.max(0, (f - 30) / 10)), qq = yaw.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -t * Math.PI / 2));
    return { frame: f, position: [-3 + Math.min(f, 30) * 0.06 + Math.max(0, f - 30) * 0.02, 0, 0], quat: qq.toArray().map((v) => +v.toFixed(5)) };
  });
  const cases = [
    ["lying (a 90-degree tilt)", man("p", [0, 0, 0], [0, 0, 0], 0, { keys: [kf(0, 0, 0, 0)], tilt: q([0, 0, 1], 90) }), () => "rig", "body"],
    ["knocked over 45 degrees, walking", man("p", [-3, 0, 0], [3, 0, 0], 47, { tilt: q([1, 0, 0], 45) }), () => "rig", "body"],
    ["physics takes over at f30", man("p", [-3, 0, 0], [3, 0, 0], 47, { keys: physKeys, physics: { baked: true, mode: "dynamic", takeover: { frame: 30 } } }), (f) => (f < 30 ? "clip" : "rig"), "takeover"],
    ["a 29-degree lean on the clip, walking", man("p", [-3, 0, 0], [3, 0, 0], 47, { tilt: q([1, 0, 0], 29) }), () => "clip", "sole"],
  ];
  for (const [what, actor, owner, kind] of cases) {
    const st = headless([actor], 48); await withKit(st, K);
    const skin = st.actorMeshes.get("p").userData.humanSkin;
    for (let f = 0; f <= 47; f++) {
      st.setFrame(f);
      assert.equal(skin.owner, owner(f), `${what} f${f}: owned by the ${owner(f)} (${skin.ownerReason})`);
      const lo = low(skin), so = sole(skin);
      assert.ok(lo > -0.02, `${what} f${f}: the body ${(lo * 100).toFixed(1)} cm into the floor`);
      if (kind === "body") assert.ok(lo < 0.03, `${what} f${f}: lying ${(lo * 100).toFixed(1)} cm over the floor`);
      if (kind === "sole" || (kind === "takeover" && f < 30)) assert.ok(so > -0.01 && so < 0.035, `${what} f${f}: the lowest sole ${(so * 100).toFixed(1)} cm`);
    }
  }
  // seated on a chair: the soles on the floor
  const st = headless([man("p", [-0.5, 0, 0], [-0.5, 0, 0], 0, { keys: [kf(0, -0.5, 0, 0)], mount_id: "ch" }), { id: "ch", kind: "chair", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 25); await withKit(st, K);
  const skin = st.actorMeshes.get("p").userData.humanSkin;
  for (const f of [3, 12, 20]) {
    st.setFrame(f);
    assert.equal(skin.owner, "seat");
    for (const lr of ["l", "r"]) { const p = F.solePoints(skin.mesh, skin.kit.feet[lr]); let lo = Infinity; for (let i = 1; i < p.length; i += 3) lo = Math.min(lo, p[i]); assert.ok(lo > -0.01 && lo < 0.01, `seated f${f} ${lr}: the sole ${(lo * 100).toFixed(1)} cm over the floor`); }
  }
});

test("a horse's and a car's model load are waited for by a capture (avatarsReady), like a lifelike body: no delivered frame shows them half-loaded", async () => {
  // review round 3: clip (c) showed the horse untextured on frames 0-1; the wait covered people only
  const hadWin = "window" in globalThis, win = globalThis.window;
  globalThis.window = { document: { createElement: () => ({}) } };   // (counted in a browser only: modelLoad)
  let st;
  try { st = headless([{ id: "h", kind: "horse", height_m: 1.6, position: [0, 0, 4], keys: [kf(0, 0, 0, 4)] }, { id: "pc", kind: "police_car", position: [0, 0, -5], keys: [kf(0, 0, 0, -5)] }], 25); }
  finally { if (hadWin) globalThis.window = win; else delete globalThis.window; }
  assert.ok(A.loadingCount() >= 2, `the horse and the car counted as loading (${A.loadingCount()})`);
  const r = await A.avatarsReady(20000);
  assert.equal(r.ok, true); assert.equal(r.waited, true);
  assert.equal(A.loadingCount(), 0);
  for (const id of ["h", "pc"]) assert.equal(st.actorMeshes.get(id).userData.standIn, true, `${id}: the marked stand-in once the load failed (node), never its built look`);
});

test("real Rocketbox: determinism without history: Drive let go mid-shot, a swim, timed mounts, a shot change and a live tilt give the fresh stage's frames", { skip: NOT_INSTALLED }, async () => {
  // review round 2: drivenInShot kept a person rig-owned after Drive let go, so the same frame differed with history
  const K = await realKits();
  const N = 61, frames = [...Array(N).keys()];
  const dry = () => [
    man("p1", [-3, 0, 0], [3, 0, 0], 60),
    man("p2", [-3, 0, 2], [-0.6, 0, 2], 30, { mount_id: "ch", mount_at: 44 }), { id: "ch", kind: "chair", position: [0, 0, 2], keys: [kf(0, 0, 0, 2)] },
    man("p3", [-3, 0, -2], [-0.8, 0, -2], 24, { mount_id: "h", mount_at: 50 }), { id: "h", kind: "horse", height_m: 1.6, position: [0, 0, -3], keys: [kf(0, 0, 0, -3)] },
  ];
  const fresh = async (actors, env, f) => { const st = headless(actors, N, env); await withKit(st, K); st.setFrame(f); return frameHash(st); };
  const ref = {};
  for (const f of frames) ref[f] = await fresh(dry(), undefined, f);
  // forward / reverse / shuffled on one stage
  for (const order of [frames, [...frames].reverse(), [...frames].sort((x, y) => ((x * 7919) % N) - ((y * 7919) % N))]) {
    const st = headless(dry(), N); await withKit(st, K);
    for (const f of order) { st.setFrame(f); assert.equal(frameHash(st), ref[f], `mounts f${f}`); }
  }
  // Drive on for p1 over frames 0-30, then let go: every later frame is the fresh stage's
  {
    const st = headless(dry(), N); await withKit(st, K);
    st.drive = testDrive(["p1"]);
    for (let f = 0; f <= 30; f++) st.setFrame(f);
    assert.equal(st.actorMeshes.get("p1").userData.humanSkin.owner, "rig", "driven: the rig");
    st.drive.live.clear();
    for (const f of [...frames].reverse()) { st.setFrame(f); assert.equal(frameHash(st), ref[f], `Drive let go f${f}`); }
  }
  // a live tilt (the physics drag) on and off again, then a shot change and back
  {
    const st = headless(dry(), N); await withKit(st, K);
    st.setFrame(20);
    const g = st.actorMeshes.get("p1");
    A.markLiveTilt(st, g, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.2));
    assert.equal(g.userData.humanSkin.owner, "rig");
    A.clearLiveTilts(st);
    st.state.shots.push({ id: "s2", name: "two" });
    const was = st.state.active_shot;
    st.state.active_shot = "s2"; st.setFrame(10);
    st.state.active_shot = was;
    for (const f of [5, 20, 47, 59]) { st.setFrame(f); assert.equal(frameHash(st), ref[f], `after a live tilt and a shot change f${f}`); }
  }
  // a swim (walking into the tank): forward, reverse and a fresh stage
  {
    const wet = () => [man("s", [-12, 0, 0], [0, 0, 0], 60)];
    const env = { set: "water_tank", keepSet: true };
    const st = headless(wet(), N, env); await withKit(st, K);
    const fw = {};
    for (const f of frames) { st.setFrame(f); fw[f] = frameHash(st); }
    for (const f of [...frames].reverse()) { st.setFrame(f); assert.equal(frameHash(st), fw[f], `swim reverse f${f}`); }
    for (const f of [0, 25, 40, 60]) assert.equal(await fresh(wet(), env, f), fw[f], `swim fresh f${f}`);
  }
});

test("no clay through the Pose view: renderFrameTo('pose') draws the posepass skeleton, _renderMode('pose') throws; the clay wording is gone from the mocap recorder and the stage's face / video-cut notes", () => {
  const st = headless([{ id: "m1", kind: "man", height_m: 1.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] }], 25);
  assert.throws(() => st._renderMode("pose", true), /Pose pass/, "never the clay override material");
  const calls = [], ops = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === "canvas" ? null : typeof k === "string" && /^(fillStyle|globalAlpha|strokeStyle|lineWidth)$/.test(k) ? undefined : (...a) => ops.push(k)), set: () => true });
  st._snap = { width: st.fw, height: st.fh, getContext: () => ctx };
  st.renderer = { getSize: (v) => v.set(st.fw, st.fh), setSize() {} };
  const real = st._renderMode;
  st._renderMode = (m, ...r) => { calls.push(m); if (m === "pose") return real.call(st, m, ...r); };
  st._syncShotCamera = () => false;
  st.renderFrameTo("pose", 3);
  assert.ok(!calls.includes("pose"), "no scene render for the Pose pass");
  assert.ok(ops.includes("fillRect") && ops.includes("ellipse"), "the OpenPose skeleton drawn (black, then the limbs)");
  // the words (review round 2: mocapcapture.mjs 'The clay actor copies it.', stage.mjs 'the clay figure is faceless')
  const src = (f) => readFileSync(fileURLToPath(new URL(`../../web/stage/${f}`, import.meta.url)), "utf8");
  assert.ok(!/clay/i.test(src("mocapcapture.mjs")), "mocapcapture.mjs says clay");
  const stage = src("stage.mjs");
  for (const re of [/clay (actor|figure) (copies|replaces|plays|is faceless)/i, /shows? as the clay/i, /The clay actor/]) assert.ok(!re.test(stage), `stage.mjs: ${re}`);
});

test("vehicles: the 'car' sedan (no model) is the marked stand-in on every frame; a horse or a modelled car is the stand-in while its model loads, never the built look", () => {
  // review round 2: the car kind rendered as the broken built sedan on every frame; the horse showed its built look on
  // frames 0-1 while the model loaded
  const st = headless([
    { id: "c", kind: "car", position: [0, 0, 0], keys: [kf(0, 0, 0, 0), kf(24, 6, 0, 0)] },
    { id: "h", kind: "horse", height_m: 1.6, position: [0, 0, 4], keys: [kf(0, 0, 0, 4)] },
    { id: "pc", kind: "police_car", position: [0, 0, -5], keys: [kf(0, 0, 0, -5)] },
  ], 25);
  for (const f of [0, 1, 12, 24]) {
    st.setFrame(f);
    for (const id of ["c", "h", "pc"]) {
      const g = st.actorMeshes.get(id);
      assert.equal(g.userData.standIn, true, `${id} f${f}: the marked stand-in`);
      g.traverse((o) => {
        if (!o.isMesh || !o.visible || o.userData.partProxy || o.parent?.userData?.partProxy || o.userData.glass) return;
        let proxy = false; for (let p = o; p; p = p.parent) if (p.userData?.partProxy) proxy = true;
        if (proxy) return;
        assert.equal(o.material, standInMaterial(), `${id} f${f}: ${o.name || "a mesh"} drawn in its built look`);
      });
    }
  }
  assert.equal(st.actorMeshes.get("h").userData.peopleLoading, true, "the horse: marked as loading (its GLB load is still pending here)");
});

/** The Color silhouette of a person (every visible mesh of the group, its skinned triangles filled, no dilation) and
 *  the share of keypoints (pixels) inside it. */
function silhouette(g, cam, N) {
  const mask = new Uint8Array(N * N), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  g.updateMatrixWorld(true);
  const px = (v) => { v.project(cam); return [(v.x * 0.5 + 0.5) * N, (0.5 - v.y * 0.5) * N]; };
  g.traverse((m) => {
    if (!m.isMesh || !m.visible) return;
    for (let p = m; p; p = p.parent) if (!p.visible) return;
    const pos = m.geometry.attributes.position, idx = m.geometry.index, n = idx ? idx.count : pos.count;
    const at = (i, v) => { const k = idx ? idx.getX(i) : i; return m.isSkinnedMesh ? m.getVertexPosition(k, v).applyMatrix4(m.matrixWorld) : v.fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld); };
    for (let i = 0; i + 2 < n; i += 3) {
      const A = px(at(i, a)), B = px(at(i + 1, b)), Cc = px(at(i + 2, c));
      const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], Cc[0]))), x1 = Math.min(N - 1, Math.ceil(Math.max(A[0], B[0], Cc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], Cc[1]))), y1 = Math.min(N - 1, Math.ceil(Math.max(A[1], B[1], Cc[1])));
      const d = (B[1] - Cc[1]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[1] - Cc[1]);
      if (Math.abs(d) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const X = x + 0.5, Y = y + 0.5;
        const l1 = ((B[1] - Cc[1]) * (X - Cc[0]) + (Cc[0] - B[0]) * (Y - Cc[1])) / d, l2 = ((Cc[1] - A[1]) * (X - Cc[0]) + (A[0] - Cc[0]) * (Y - Cc[1])) / d;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) mask[y * N + x] = 1;
      }
    }
  });
  const fn = (pts) => {
    let all = 0, hit = 0;
    fn.missed = [];
    pts.forEach((p, i) => { if (!p) return; all++; const x = Math.floor(p[0]), y = Math.floor(p[1]); if (x >= 0 && y >= 0 && x < N && y < N && mask[y * N + x]) hit++; else fn.missed.push(i); });
    return all ? hit / all : 1;
  };
  return fn;
}

test("real Rocketbox: silhouette against an independent source: the Pose pass AND the logic rig's own keypoints inside the Color silhouette (filled triangles, no dilation), walking, hopping, seated, riding, swimming, mocap, Drive, carried and carrying, and the stand-in", { skip: NOT_INSTALLED }, async () => {
  // review round 2: the old check read keypoints off the visible bones against their own skin, 5x5 px dilated on a
  // 160 px grid, and skipped swim, mocap, Drive, carry and stand-in frames
  const K = await realKits();
  const N = 256, cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const look = (p) => { cam.position.set(p.x + 3.2, p.y + 0.3, p.z + 3.2); cam.lookAt(p.x, p.y, p.z); cam.updateMatrixWorld(true); };   // (the pelvis in the middle: head to feet in frame)
  const pixels = (kp) => (kp ? toPixels(kp, cam, N, N).body : []);
  const cases = [
    ["walking", [man("p", [-3, 0, 0], [3, 0, 0], 48)], 48, undefined, null, [6, 24, 40]],
    ["a hop over a crate", [man("p", [-3, 0, 0], [3, 0, 0], 48), { id: "c1", kind: "crate", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 48, undefined, null, null],
    ["seated on a chair", [man("p", [-0.5, 0, 0], [-0.5, 0, 0], 0, { keys: [kf(0, -0.5, 0, 0)], mount_id: "ch" }), { id: "ch", kind: "chair", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 24, undefined, null, [4, 20]],
    ["riding a horse", [man("p", [0, 0, 0], [0, 0, 0], 0, { keys: [kf(0, 0, 0, 0)], mount_id: "h" }), { id: "h", kind: "horse", height_m: 1.6, position: [0, 0, 0], keys: [kf(0, 0, 0, 0), kf(24, 4, 0, 0)] }], 24, undefined, null, [4, 20]],
    ["swimming in the tank", [man("p", [-3, 0, 0], [1, 0, 0], 48)], 48, { set: "water_tank", keepSet: true }, null, [10, 30, 46]],
    ["a video mocap take", [man("p", [0, 0, 0], [0, 0, 0], 0, { keys: [kf(0, 0, 0, 0)], mocap: { data: mocapData(), start: 0, travel: false } })], 71, undefined, null, [10, 25, 55]],
    ["driven live", [man("p", [-3, 0, 0], [3, 0, 0], 48)], 48, undefined, (st) => { st.drive = testDrive(["p"]); }, [8, 30]],
    ["carrying a crate", [man("p", [-2, 0, 0], [2, 0, 0], 48), { id: "box", kind: "crate", scale: 0.4, position: [-1.6, 0, 0], keys: [kf(0, -1.6, 0, 0)], carry_id: "p", carry_at: 8 }], 48, undefined, null, [20, 40]],
    ["carried by another", [man("q", [-2, 0, 0], [2, 0, 0], 48), { ...man("p", [-1.6, 0, 0], [-1.6, 0, 0], 0, { keys: [kf(0, -1.6, 0, 0)] }), kind: "woman", height_m: 1.68, carry_id: "q", carry_at: 8 }], 48, undefined, null, [20, 40]],
  ];
  for (const [what, actors, frames, env, prep, at] of cases) {
    const st = headless(actors, frames + 1, env); await withKit(st, K);
    prep?.(st);
    const g = st.actorMeshes.get("p"), skin = g.userData.humanSkin, a = st.state.actors.find((x) => x.id === "p");
    let list = at;
    if (!list) { const air = [...Array(frames + 1).keys()].filter((f) => st._walkAirborneAt(a, f)); assert.ok(air.length, `${what}: in the air`); list = [air[0] - 2, air[0], air[Math.floor(air.length / 2)], air.at(-1), air.at(-1) + 2]; }
    for (const f of list) {
      st.setFrame(f);
      assert.equal(skin.shown, true, `${what} f${f}: lifelike`);
      look(W(skin.bones.Bip01_Pelvis));
      const inside = silhouette(g, cam, N);
      const pose = inside(pixels(personKeypoints(g, cam.position))), poseMissed = inside.missed;
      g.userData.humanSkin = null;   // the logic rig's own joints (what held props, colliders and the gizmo's IK read)
      const rig = inside(pixels(personKeypoints(g, cam.position)));
      g.userData.humanSkin = skin;
      if (process.env.SIL_DEBUG) console.log(what, f, skin.owner, pose.toFixed(2), JSON.stringify(poseMissed), rig.toFixed(2), JSON.stringify(inside.missed));
      else {
        assert.ok(pose >= 0.95, `${what} f${f} (${skin.owner}): the Pose pass ${pose.toFixed(2)} inside (missed keypoints ${poseMissed})`);
        assert.ok(rig >= 0.95, `${what} f${f} (${skin.owner}): the logic rig ${rig.toFixed(2)} inside (missed keypoints ${inside.missed})`);
      }
    }
  }
  // the stand-in (no kit: a child): the Pose pass from the logic rig inside the stand-in's own silhouette
  const st = headless([{ id: "k", kind: "child", height_m: 1.2, position: [-2, 0, 0], keys: [kf(0, -2, 0, 0), kf(24, 2, 0, 0)] }], 25);
  for (const f of [3, 12, 21]) {
    st.setFrame(f);
    const g = st.actorMeshes.get("k");
    assert.equal(g.userData.standIn, true);
    look(W(g)); const r = silhouette(g, cam, N)(pixels(personKeypoints(g, cam.position)));
    assert.ok(r >= 0.95, `stand-in f${f}: ${r.toFixed(2)} inside`);
  }
});
