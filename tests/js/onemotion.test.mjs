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

test("real Rocketbox: determinism: forward, reverse, shuffled scrubs and a fresh stage give identical frames (a jump, a baked tilt, Drive, a carry)", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const scene = () => [
    { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 40, position: [3, 0, 0] }] },
    { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] },
    { id: "p2", kind: "woman", height_m: 1.68, position: [0, 0, 3], keys: [{ frame: 0, position: [0, 0, 3] }], tilt: [0.3827, 0, 0, 0.9239] },
    { id: "p3", kind: "man", height_m: 1.8, position: [2, 0, 3], keys: [{ frame: 0, position: [2, 0, 3] }, { frame: 40, position: [4, 0, 5] }], face: "faceless" },
    { id: "box", kind: "crate", position: [2.4, 0, 3], keys: [{ frame: 0, position: [2.4, 0, 3] }], carry_id: "p3", carry_at: 10 },
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

/** Per-frame acceleration (second difference, m/frame^2) of the visible pelvis, hands, feet and head over frames, and of
 *  the logic rig's own hips (what the stage poses: a horse climb is fast by itself). */
function motion(st, ids, frames) {
  const rows = [];
  const g = st.actorMeshes.get(ids), skin = g.userData.humanSkin, B = skin.bones, J = g.userData.joints;
  for (const f of frames) {
    st.setFrame(f);
    rows.push({ f, own: skin.owner, w: skin.rigWeight, pel: W(B.Bip01_Pelvis), j: [W(B.Bip01_L_Hand), W(B.Bip01_R_Hand), W(B.Bip01_L_Foot), W(B.Bip01_R_Foot), W(B.Bip01_Head)], rig: W(J.l_hip).add(W(J.r_hip)).multiplyScalar(0.5) });
  }
  const acc = (a, b, c) => c.clone().sub(b).sub(b.clone().sub(a)).length();
  const out = [];
  for (let i = 1; i < rows.length - 1; i++) {
    const [a, b, c] = [rows[i - 1], rows[i], rows[i + 1]];
    out.push({ f: b.f, own: b.own, changes: a.own !== b.own || b.own !== c.own || Math.abs(c.w - a.w) > 1e-9, pel: acc(a.pel, b.pel, c.pel), joint: Math.max(...b.j.map((p, k) => acc(a.j[k], p, c.j[k]))), rig: acc(a.rig, b.rig, c.rig) });
  }
  return out;
}

test("real Rocketbox: no pop at any ownership change (a hop, a swim entry, a mount, a seat): the body's per-frame acceleration stays capped", { skip: NOT_INSTALLED }, async () => {
  // review round 2 (measured on 0ce517f, per-frame movement): crate hop hand 76.4 cm at f12; dock to water hand 96.7
  // at f13, pelvis 21.5 at f11; chair walk-up pelvis 54.4 at f20; horse mount_at pelvis 85.1 at f8. Capped here as an
  // acceleration (a pop is a jump in the per-frame movement; steady travel is not): pelvis 12 cm/frame^2, hands, feet
  // and head 30, or 1.25x what the logic rig's own hips do in the same frames where the stage itself moves that fast
  // (the horse climb: 24 cm/frame^2 at the leg-over).
  const K = await realKits();
  const D = 1.81;
  const cases = [
    ["a hop over a crate", [man("p", [-3, 0, 0], [3, 0, 0], 96), { id: "c1", kind: "crate", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 96, { set: "studio" }],
    ["walks into the tank and swims", [man("p", [-12, 0, 0], [0, 0, 0], 120)], 120, { set: "water_tank", keepSet: true }],
    ["off the dock into the lake", [man("p", [-6, D, -12], [-6, D, -4], 48, { key_y: true })], 96, { set: "lake", keepSet: true }],
    ["walks to a chair and sits (mount_at)", [man("p", [-3, 0, 0], [-0.6, 0, 0], 40, { mount_id: "ch", mount_at: 54 }), { id: "ch", kind: "chair", position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 70, { set: "studio" }],
    ["walks to a horse and gets on (mount_at)", [man("p", [-3, 0, 1], [-0.8, 0, 1], 30, { mount_id: "h", mount_at: 60 }), { id: "h", kind: "horse", height_m: 1.6, position: [0, 0, 0], keys: [kf(0, 0, 0, 0)] }], 80, { set: "studio" }],
  ];
  for (const [what, actors, frames, env] of cases) {
    const st = headless(actors, frames + 1, env); await withKit(st, K);
    const rows = motion(st, "p", [...Array(frames + 1).keys()]);
    let changes = 0;
    for (const r of rows) {
      if (!r.changes) continue;
      changes++;
      const pCap = Math.max(0.12, 1.25 * r.rig), jCap = Math.max(0.30, 1.25 * r.rig);
      assert.ok(r.pel <= pCap, `${what} f${r.f} (${r.own}): pelvis ${(r.pel * 100).toFixed(1)} cm/frame^2 (cap ${(pCap * 100).toFixed(1)})`);
      assert.ok(r.joint <= jCap, `${what} f${r.f} (${r.own}): a hand / foot / head ${(r.joint * 100).toFixed(1)} cm/frame^2 (cap ${(jCap * 100).toFixed(1)})`);
    }
    assert.ok(changes > 0, `${what}: the owner changes in the shot`);
  }
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
