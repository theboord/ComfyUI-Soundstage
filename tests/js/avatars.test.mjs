// node --test tests/js/avatars.test.mjs
// Lifelike people (people overhaul M1, web/stage/people/): the pure rules (texture names, root motion, clip choice
// and timing, detail level, bone binding, face option, when the clay stays), the skinning Depth shader, and, when the
// Rocketbox files are installed locally (they are not in the repo), the real FBX files parsed in node.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";

// ---------------------------------------------------------------- textures
test("every .tga the FBX asks for loads as the PNG of the same base name in tex/", () => {
  const dir = "http://h/extensions/x/stage/people/rocketbox/tex/";
  assert.equal(C.tgaToPng("http://h/extensions/x/stage/people/rocketbox/m002_body_color.tga", dir), `${dir}m002_body_color.png`);
  assert.equal(C.tgaToPng("people/rocketbox/F001_Head_Normal.TGA", dir), `${dir}F001_Head_Normal.png`);
  assert.equal(C.tgaToPng("C:\\max\\maps\\f001_opacity_color.tga", dir), `${dir}f001_opacity_color.png`);
  assert.equal(C.tgaToPng("a/b/c.tga?v=2", dir), `${dir}c.png`);
  assert.equal(C.tgaToPng("a/b/c.png", dir), "a/b/c.png");
  assert.equal(C.tgaToPng("a/b/tga.jpg", dir), "a/b/tga.jpg");
});

test("a material that should show a texture but has no colour map is reported", () => {
  const ok = new THREE.MeshStandardMaterial({ name: "x_body", map: new THREE.Texture() });
  const bad = new THREE.MeshStandardMaterial({ name: "x_head" });
  const plain = new THREE.MeshStandardMaterial({ name: "faceless_head" }); plain.userData.plain = true;
  const hidden = new THREE.MeshBasicMaterial({ name: "gone", visible: false });
  assert.deepEqual(C.missingColorMaps([ok, bad, plain, hidden]), ["x_head"]);
});

// ---------------------------------------------------------------- detail levels
test("detail level: hipoly beats midpoly, lowpoly and ultralowpoly; unnamed meshes go by vertex count", () => {
  assert.equal(C.lodLevel("m002_hipoly_81_bones_opacity"), 0);
  assert.equal(C.lodLevel("m002_midpoly_49_bones"), 1);
  assert.equal(C.lodLevel("m002_lowpoly_33_bones"), 2);
  assert.equal(C.lodLevel("m002_ultralowpoly_23_bones"), 3);
  assert.equal(C.lodLevel("Body"), -1);
  const lods = [{ name: "a_lowpoly_33_bones", vertices: 3000 }, { name: "a_hipoly_81_bones", vertices: 22000 }, { name: "a_ultralowpoly_23_bones", vertices: 900 }, { name: "a_midpoly_49_bones", vertices: 9000 }];
  assert.equal(C.pickLod(lods), 1);
  assert.equal(C.pickLod([{ name: "A", vertices: 10 }, { name: "B", vertices: 500 }]), 1);
  assert.equal(C.pickLod([]), -1);
});

// ---------------------------------------------------------------- clips
/** A synthetic Rocketbox-like walk: the root travels 120 units along +Z over 1.2 s and bobs, plus noise tracks. */
function synthWalk() {
  const times = [0, 0.3, 0.6, 0.9, 1.2];
  const pos = []; times.forEach((t, i) => pos.push(2 * Math.sin(i), 90 + Math.sin(i * 2), 100 * t));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, 0)).toArray();
  return new THREE.AnimationClip("Take 001", 1.2, [
    new THREE.VectorKeyframeTrack("Bip01.position", times, pos),
    new THREE.QuaternionKeyframeTrack("Bip01.quaternion", [0, 1.2], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.VectorKeyframeTrack("Bip01_Pelvis.position", [0, 1.2], [0, 0, 0, 0, 0, 0]),
    new THREE.QuaternionKeyframeTrack("Bip02_L_Thigh.quaternion", [0, 1.2], [...q, ...q]),
    new THREE.VectorKeyframeTrack("Bip01_L_Thigh.scale", [0, 1.2], [1, 1, 1, 1, 1, 1]),
    new THREE.VectorKeyframeTrack("Bip01_Footsteps.position", [0, 1.2], [0, 0, 0, 0, 0, 120]),
    new THREE.VectorKeyframeTrack("MotionExtractionHelper.position", [0, 1.2], [0, 0, 0, 0, 0, 120]),
  ]);
}
/** A synthetic Bip01 skeleton (root -> pelvis -> thigh) as the avatar would have it. */
function synthSkeleton() {
  const model = new THREE.Group();
  const root = new THREE.Bone(); root.name = "Bip01"; root.position.set(0, 90, 0);
  const pelvis = new THREE.Bone(); pelvis.name = "Bip01_Pelvis";
  const thigh = new THREE.Bone(); thigh.name = "Bip01_L_Thigh"; thigh.position.set(9, 0, 0);
  const steps = new THREE.Bone(); steps.name = "Bip01_Footsteps";
  model.add(root); root.add(pelvis); pelvis.add(thigh); root.add(steps);
  const names = new Set(); model.traverse((o) => o.name && names.add(o.name));
  return { model, root, pelvis, thigh, names };
}

test("root motion: the root's X/Z are zeroed (Y bob kept), the loop's travel is measured, only rotations + root play", () => {
  const { names } = synthSkeleton();
  const { clip, travel, dropped, missing } = C.prepareClip(synthWalk(), names);
  assert.ok(Math.abs(travel - Math.hypot(2 * Math.sin(4) - 0, 120)) < 1e-4, `travel ${travel}`);
  const root = clip.tracks.find((t) => t.name === "Bip01.position");
  for (let i = 0; i < root.values.length / 3; i++) {
    assert.equal(root.values[3 * i], 0); assert.equal(root.values[3 * i + 2], 0);
    assert.ok(Math.abs(root.values[3 * i + 1] - (90 + Math.sin(i * 2))) < 1e-5, "the bob stays");
  }
  assert.deepEqual(clip.tracks.map((t) => t.name).sort(), ["Bip01.position", "Bip01.quaternion", "Bip01_L_Thigh.quaternion"]);
  assert.ok(dropped.includes("Bip01_Pelvis.position") && dropped.includes("Bip01_L_Thigh.scale") && dropped.includes("MotionExtractionHelper.position") && dropped.includes("Bip01_Footsteps.position"));
  assert.deepEqual(missing, []);
  // the original clip is left alone
  assert.equal(synthWalk().tracks[0].values[2], 0);
});

test("over a whole loop the pelvis keeps its X/Z under the holder (no double travel, no snap at the loop)", () => {
  const sk = synthSkeleton();
  const { clip } = C.prepareClip(synthWalk(), sk.names);
  const mixer = new THREE.AnimationMixer(sk.model);
  mixer.clipAction(clip).play();
  const v = new THREE.Vector3();
  for (let t = 0; t <= 1.2001; t += 0.05) {
    mixer.setTime(t);
    sk.model.updateMatrixWorld(true);
    sk.pelvis.getWorldPosition(v);
    assert.ok(Math.abs(v.x) < 1e-6 && Math.abs(v.z) < 1e-6, `t=${t.toFixed(2)} pelvis ${v.x}, ${v.z}`);
    assert.ok(v.y > 88 && v.y < 92);
  }
});

test("every track binds to a bone; Bip02 tracks are renamed to Bip01, an unknown bone is reported", () => {
  const sk = synthSkeleton();
  const { clip } = C.prepareClip(synthWalk(), sk.names);
  assert.deepEqual(C.bindReport(clip, sk.names), { bound: 3, missing: [] });
  // three binds them for real: the thigh turns
  const mixer = new THREE.AnimationMixer(sk.model);
  mixer.clipAction(clip).play();
  mixer.setTime(0.5);
  assert.ok(Math.abs(sk.thigh.rotation.x - 0.3) < 1e-4);
  const odd = new THREE.AnimationClip("x", 1, [new THREE.QuaternionKeyframeTrack("Bip01_Tail.quaternion", [0], [0, 0, 0, 1])]);
  assert.deepEqual(C.bindReport(odd, sk.names).missing, ["Bip01_Tail"]);
  assert.equal(C.remapBoneName("Bip02 L Thigh"), "Bip01_L_Thigh");
  assert.equal(C.remapBoneName("Bip01"), "Bip01");
});

test("clip choice by speed: idle when still, walk, run, crossfaded, weights sum to 1", () => {
  const w0 = C.clipWeights(0), w1 = C.clipWeights(1.3), w3 = C.clipWeights(3.4), wb = C.clipWeights(0.35), wr = C.clipWeights(2.3);
  assert.deepEqual([w0.idle, w0.walk, w0.run], [1, 0, 0]);
  assert.ok(w1.walk > 0.999 && w3.run > 0.999);
  assert.ok(wb.idle > 0 && wb.walk > 0, "starting off blends idle into walk");
  assert.ok(wr.walk > 0 && wr.run > 0, "speeding up blends walk into run");
  for (let s = 0; s <= 5; s += 0.05) {
    const w = C.clipWeights(s);
    assert.ok(Math.abs(w.idle + w.walk + w.run - 1) < 1e-9);
  }
});

test("clip time: idle by frame, walk/run by distance (one stride = one loop); the same frame is always the same pose", () => {
  const clips = { idle: { duration: 10 }, walk: { duration: 1.2, stride: 1.2 }, run: { duration: 0.73, stride: 2.1 } };
  const a = C.clipTimes({ frame: 30, fps: 24, dist: 0.6 }, clips);
  assert.ok(Math.abs(a.idle - 1.25) < 1e-9);
  assert.ok(Math.abs(a.walk - 0.6) < 1e-9, "half a stride = half the loop");
  const b = C.clipTimes({ frame: 30, fps: 24, dist: 0.6 + 1.2 * 3 }, clips);
  assert.ok(Math.abs(b.walk - a.walk) < 1e-9, "whole strides later the legs are in the same place");
  assert.deepEqual(C.clipTimes({ frame: 30, fps: 24, dist: 0.6 }, clips), a, "deterministic");
  const s = C.clipTimes({ frame: 30, fps: 24, dist: 0.6, seed: 0.25 }, clips);
  assert.ok(s.idle !== a.idle && s.idle >= 0 && s.idle < 10);
  for (const x of Object.values(C.clipTimes({ frame: 9999, fps: 24, dist: 987.65, seed: 0.9 }, clips))) assert.ok(x >= 0);
  assert.equal(C.phaseSeed("actor_a"), C.phaseSeed("actor_a"));
  assert.notEqual(C.phaseSeed("actor_a"), C.phaseSeed("actor_b"));
});

test("hip height: the avatar is scaled so its hips sit where the clay's do (half the height)", () => {
  assert.ok(Math.abs(C.hipScale(1.8, 90) * 90 - 0.9) < 1e-9);
  assert.ok(Math.abs(C.hipScale(1.68, 92.3) * 92.3 - 0.84) < 1e-9);
  assert.equal(C.clayHeight({ kind: "woman" }), 1.68);
  assert.equal(C.clayHeight({ kind: "man", height_m: 1.9 }), 1.9);
});

// ---------------------------------------------------------------- who gets an avatar, face option
test("men and women get an avatar; children, animals and the clay-model flag stay clay", () => {
  assert.equal(C.avatarSpecFor({ kind: "man" }).model, "Male_Adult_01");
  assert.equal(C.avatarSpecFor({ kind: "woman" }).model, "Female_Adult_01");
  assert.equal(C.avatarSpecFor({ kind: "man", appearance: { gender: "female" } }).model, "Female_Adult_01");
  assert.equal(C.avatarSpecFor({ kind: "child" }), null);
  assert.equal(C.avatarSpecFor({ kind: "horse" }), null);
  assert.equal(C.avatarSpecFor({ kind: "man", simple_model: true }), null);
});

test("face option: faceless swaps the head for a plain material and hides lashes and brows; the body is kept", () => {
  assert.equal(C.materialRole("m002_head"), "head");
  assert.equal(C.materialRole("f001_opacity"), "opacity");
  assert.equal(C.materialRole("m002_body"), "body");
  for (const r of ["head", "opacity", "body"]) assert.equal(C.faceChoice(r, false), "keep");
  assert.equal(C.faceChoice("head", true), "neutral");
  assert.equal(C.faceChoice("opacity", true), "hide");
  assert.equal(C.faceChoice("body", true), "keep");
});

test("the clay stays (for the whole shot) where the clips can't follow yet; Blocking look keeps everyone clay", () => {
  const a = { id: "p1", kind: "man" };
  assert.equal(C.clayReason(a, {}), null);
  assert.match(C.clayReason(a, { blocking: true }), /Blocking/);
  assert.ok(C.clayReason({ ...a, mount_id: "h" }, {}));
  assert.ok(C.clayReason({ ...a, mocap: { take: "t" } }, {}));
  assert.ok(C.clayReason({ ...a, pose_keys: [{ frame: 0 }] }, {}));
  assert.ok(C.clayReason(a, { gazeKeyed: true }));
  assert.ok(C.clayReason(a, { swims: true }));
  const users = C.propUsers([{ id: "key", hold: [{ actor: "p1", from: 0, to: 9 }] }, { id: "box", carry_id: "p2" },
    { id: "cup", by_shot: { s2: { hold: [{ actor: "p3" }] } } }]);
  assert.deepEqual([...users.holders].sort(), ["p1", "p3"]);
  assert.deepEqual([...users.carriers], ["p2"]);
  assert.match(C.clayReason(a, users), /holds a prop/);
  assert.match(C.clayReason({ id: "p2", kind: "woman" }, users), /carries/);
});

// ---------------------------------------------------------------- render passes
test("the Depth pass shader skins (a posed body draws posed, not in its bind pose)", async () => {
  const { DEPTH_SHADER } = await import("../../web/stage/stage.mjs");
  for (const chunk of ["#include <skinning_pars_vertex>", "#include <skinbase_vertex>", "#include <begin_vertex>", "#include <skinning_vertex>"])
    assert.ok(DEPTH_SHADER.vertex.includes(chunk), chunk);
  assert.match(DEPTH_SHADER.vertex, /modelViewMatrix \* vec4\(transformed/);
  assert.match(DEPTH_SHADER.fragment, /1\.0 - d/);
});

// ---------------------------------------------------------------- the real files (local install only)
const RB = fileURLToPath(new URL("../../web/stage/people/rocketbox/", import.meta.url));
const installed = existsSync(`${RB}Male_Adult_01.fbx`) && existsSync(`${RB}anim/m_walk_neutral_01.max.fbx`);

async function parseReal() {
  globalThis.document ||= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
  const { FBXLoader } = await import("../../web/vendor/addons/FBXLoader.mjs");
  const parse = (f, manager) => { const b = readFileSync(RB + f); return new FBXLoader(manager).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), RB); };
  return { parse };
}

test("real Rocketbox files: one detailed mesh, no stray light, every texture found as a PNG, every clip track bound", { skip: !installed && "Rocketbox files not installed (web/stage/people/rocketbox/)" }, async () => {
  const { parse } = await parseReal();
  const A = await import("../../web/stage/people/avatars.mjs");
  for (const spec of Object.values(C.ROCKETBOX)) {
    const urls = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => { const v = C.tgaToPng(u, `${RB}tex/`); urls.push(v); return v; });
    const model = parse(`${spec.model}.fbx`, manager);
    const clips = Object.fromEntries(C.CLIP_KINDS.map((k) => [k, parse(`anim/${spec.clips[k]}.max.fbx`).animations[0]]));
    const kit = A.buildKit(model, clips);
    assert.equal(kit.report.lightsRemoved, 1, "the FBX's AmbientLight is taken out");
    let lights = 0; kit.template.traverse((o) => { if (o.isLight) lights++; });
    assert.equal(lights, 0);
    assert.equal(kit.report.meshes.length, 1);
    assert.match(kit.report.kept, /_hipoly_/);
    assert.deepEqual(kit.report.missingMaps, [], "every material has its colour map");
    assert.deepEqual(kit.materials.map((m) => m.userData.role).sort(), ["body", "head", "opacity"]);
    assert.ok(urls.length >= 6 && urls.every((u) => u.endsWith(".png") && existsSync(u)), `textures: ${urls.join(", ")}`);
    for (const k of C.CLIP_KINDS) {
      assert.deepEqual(kit.report.unbound[k], [], `${spec.model} ${k}: every track finds its bone`);
      assert.ok(kit.clips[k].clip.tracks.length > 70);
    }
    // units: centimetres, hips ~90 cm; walk and run travel a real stride per loop
    assert.ok(kit.hipUnits > 80 && kit.hipUnits < 100, `hips ${kit.hipUnits}`);
    assert.ok(kit.clips.walk.travel > 100 && kit.clips.walk.travel < 170, `walk ${kit.clips.walk.travel}`);
    assert.ok(kit.clips.run.travel > 180 && kit.clips.run.travel < 260, `run ${kit.clips.run.travel}`);
  }
});

test("real Rocketbox avatar on a clay figure: faces +Z, hips at clay height, feet on the floor, root X/Z pinned, deterministic", { skip: !installed && "Rocketbox files not installed" }, async () => {
  const { parse } = await parseReal();
  const A = await import("../../web/stage/people/avatars.mjs");
  const { personKeypoints } = await import("../../web/stage/posepass.mjs");
  const spec = C.ROCKETBOX.man;
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => C.tgaToPng(u, `${RB}tex/`));
  const kit = A.buildKit(parse(`${spec.model}.fbx`, manager), Object.fromEntries(C.CLIP_KINDS.map((k) => [k, parse(`anim/${spec.clips[k]}.max.fbx`).animations[0]])));
  const a = { id: "p1", kind: "man", height_m: 1.8 };
  const g = new THREE.Group(); g.position.set(3, 0, -2); g.rotation.y = 0.4; g.scale.setScalar(1);   // the clay group, anywhere
  const skin = A.instantiate(kit, a);
  g.add(skin.holder);
  const scale = C.hipScale(1.8, kit.hipUnits);
  const pose = (frame, dist, speed, yaw = 0) => {
    A.placeHolder(g, skin.holder, { x: 1, y: 0, z: 2, yaw, scale });
    A.drive(skin, { frame, fps: 24, speed, dist, scale, seed: 0 });
    g.updateMatrixWorld(true);
    const P = (n) => skin.bones[n].getWorldPosition(new THREE.Vector3());
    return { root: P("Bip01"), nose: P("Bip01_MNose"), head: P("Bip01_Head"), lt: P("Bip01_L_Thigh"), rt: P("Bip01_R_Thigh"), lToe: P("Bip01_L_Toe0"), rToe: P("Bip01_R_Toe0") };
  };
  const p = pose(10, 0, 0);
  assert.ok(p.nose.z - p.head.z > 0.08, "facing +Z (nose in front of the head)");
  assert.ok(p.lt.x > p.rt.x, "left thigh on +X, like the clay");
  assert.ok(Math.abs(p.root.y - 0.9) < 0.03, `hips at ${p.root.y.toFixed(3)} m`);
  assert.ok(Math.abs(p.root.x - 1) < 0.02 && Math.abs(p.root.z - 2) < 0.02, "the avatar stands where the actor is, whatever the clay group's own transform");
  assert.ok(Math.min(p.lToe.y, p.rToe.y) > -0.03 && Math.min(p.lToe.y, p.rToe.y) < 0.05, "a foot on the floor");
  const r = pose(10, 0, 0, Math.PI / 2);
  assert.ok(r.nose.x - r.head.x > 0.08, "turned to heading +90° it faces +X");
  // walking: the root never leaves the holder's X/Z over a whole loop of distance
  const stride = kit.clips.walk.travel * scale;
  for (let i = 0; i <= 24; i++) {
    const w = pose(i, (stride * i) / 24, 1.3);
    assert.ok(Math.hypot(w.root.x - 1, w.root.z - 2) < 0.06, `root drifted ${Math.hypot(w.root.x - 1, w.root.z - 2).toFixed(3)} m at ${i}/24`);
  }
  const s1 = pose(17, 1.234, 1.3), s2 = pose(40, 2.0, 2.9), s3 = pose(17, 1.234, 1.3);
  assert.ok(s1.lToe.distanceTo(s3.lToe) < 1e-6 && s1.nose.distanceTo(s3.nose) < 1e-6, "same frame, same pose");
  assert.ok(s1.lToe.distanceTo(s2.lToe) > 1e-3);
  // the Pose pass reads the avatar's bones while it shows
  pose(17, 1.234, 1.3);
  g.userData.humanSkin = skin; skin.shown = true;
  const kp = personKeypoints(g, new THREE.Vector3(1, 1.6, 8));
  assert.ok(kp && kp.body.every(Boolean) && kp.hands.every(Boolean) && kp.face.length === 68);
  assert.ok(kp.body[13].distanceTo(skin.bones.Bip01_L_Foot.getWorldPosition(new THREE.Vector3())) < 1e-6, "ankle = the avatar's foot bone");
  assert.ok(kp.facing > 0.5, "looking toward a camera in front");
  assert.ok(kp.body[0].y > 1.55 && kp.body[0].y < 1.8, `nose at ${kp.body[0].y}`);
  // faceless: plain head, lashes hidden, body untouched; back again
  A.applyFace(skin, true);
  const roles = skin.mesh.material.map((m) => m.name);
  assert.deepEqual(roles, kit.materials.map((m) => ({ head: "faceless_head", opacity: "faceless_hidden", body: m.name }[m.userData.role])));
  assert.equal(skin.mesh.material.find((m) => m.name === "faceless_head").map, null);
  A.applyFace(skin, false);
  assert.deepEqual(skin.mesh.material, kit.materials);
});

test("showing the avatar hides only the clay meshes (joints stay) and gives them back exactly as they were", async () => {
  const A = await import("../../web/stage/people/avatars.mjs");
  const g = new THREE.Group();
  const joint = new THREE.Group(); g.add(joint);
  const m1 = new THREE.Mesh(new THREE.BoxGeometry()), m2 = new THREE.Mesh(new THREE.BoxGeometry());
  m2.visible = false;   // e.g. hair under a hat: hidden by someone else
  joint.add(m1, m2);
  const holder = new THREE.Group(); const av = new THREE.Mesh(new THREE.BoxGeometry()); av.visible = false; holder.add(av);
  const skin = { holder, clay: [m1, m2], clayVis: [], shown: false };
  A.setShown(skin, true);
  assert.equal(m1.visible, false); assert.equal(m2.visible, false); assert.equal(av.visible, true); assert.equal(joint.visible, true);
  A.setShown(skin, false);
  assert.equal(m1.visible, true); assert.equal(m2.visible, false); assert.equal(av.visible, false);
});
