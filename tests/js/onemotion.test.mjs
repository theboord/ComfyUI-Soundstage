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
import { personKeypoints } from "../../web/stage/posepass.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
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
function headless(actors, frames = 49) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: { set: "studio" } },
    view: "color", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.state.shot = { ...(st.state.shot || {}), frames, fps: 24 };
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
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
test("ownership: a jump's take-off frame is the rig at full weight, the walk at full weight where the 6-frame ease has not begun", () => {
  const air = new Set([20, 21, 22, 23, 24]);
  const w = (f) => O.rigWeight(f, (i) => air.has(i), 48);
  assert.equal(w(20), 1);
  assert.equal(w(13), 0);
  assert.ok(w(19) > 0.9);
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

test("real Rocketbox: silhouette: the Pose keypoints lie inside the visible body (>= 0.95), walking, riding, jumping and seated", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const N = 160;
  const inside = (skin, g) => {
    cam.updateMatrixWorld(true);
    const mask = new Uint8Array(N * N), v = new THREE.Vector3();
    skin.holder.updateMatrixWorld(true);
    const m = skin.mesh, n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld).project(cam);
      const x = Math.round((v.x * 0.5 + 0.5) * (N - 1)), y = Math.round((0.5 - v.y * 0.5) * (N - 1));
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < N && Y < N) mask[Y * N + X] = 1; }
    }
    const kp = personKeypoints(g, cam.position);
    let all = 0, hit = 0;
    for (const p of kp.body) {
      if (!p) continue;
      const q = p.clone().project(cam), x = Math.round((q.x * 0.5 + 0.5) * (N - 1)), y = Math.round((0.5 - q.y * 0.5) * (N - 1));
      all++; if (x >= 0 && y >= 0 && x < N && y < N && mask[y * N + x]) hit++;
    }
    return hit / all;
  };
  const look = (p) => { cam.position.set(p.x + 3.5, p.y + 1.2, p.z + 3.5); cam.lookAt(p.x, p.y + 0.9, p.z); };
  // walking (the clip)
  {
    const a = walker("woman");
    const st = bareStage([a]); const g = clayOf(st, a);
    const skin = A.attachKit(st, a, g, K.woman); await null;
    for (const f of [10, 50, 90]) { st.frame = f; A.avatarsAt(st); look(W(skin.holder)); const r = inside(skin, g); assert.ok(r >= 0.95, `walk f${f}: ${r.toFixed(2)}`); }
  }
  // riding (the rig) and seated (the seat)
  for (const [pose, extra] of [["ride", { mount_id: "h" }], ["cycle", { mount_id: "h" }]]) {
    const a = { id: "p", kind: "man", height_m: 1.8, position: [0, 0.6, 0], keys: [{ frame: 0, position: [0, 0.6, 0] }], ...extra };
    const st = bareStage([a], { frames: 25 }); const g = clayOf(st, a);
    const skin = A.attachKit(st, a, g, K.man); await null;
    applyPose(g, pose, 1.8); st.frame = 4; A.avatarsAt(st);
    look(W(skin.holder)); const r = inside(skin, g); assert.ok(r >= 0.95, `${pose}: ${r.toFixed(2)}`);
  }
  // a jump over a crate (the rig, then the handover back to the clip)
  {
    const a = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
    const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
    const st = headless([a, crate]); await withKit(st, K);
    const skin = st.actorMeshes.get("p1").userData.humanSkin, g = st.actorMeshes.get("p1");
    const air = [...Array(49).keys()].filter((f) => st._walkAirborneAt ? st._walkAirborneAt(a, f) : st._airborneAt(a, f));
    assert.ok(air.length, "the walk hops the crate");
    for (const f of [air[0] - 3, air[0], air[Math.floor(air.length / 2)], air.at(-1) + 1]) {
      st.setFrame(f); look(W(skin.holder)); const r = inside(skin, g);
      assert.equal(skin.shown, true);
      assert.ok(r >= 0.95, `jump f${f} (rig ${skin.rigWeight.toFixed(2)}): ${r.toFixed(2)}`);
    }
  }
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
  for (const f of [5, 20, 35]) {
    st.setFrame(f);
    const hand = W(skin.bones.Bip01_R_Hand), cup = W(st.actorMeshes.get("cup"));
    assert.ok(hand.distanceTo(cup) < 0.15, `f${f}: the cup ${(hand.distanceTo(cup) * 100).toFixed(1)} cm from the visible hand`);
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
