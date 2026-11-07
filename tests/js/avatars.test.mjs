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

test("root motion: only the loop's steady travel comes out; the sway within the stride and the bob stay; the loop closes", () => {
  const { names } = synthSkeleton();
  const src = synthWalk();
  const { clip, travel, dropped, missing } = C.prepareClip(src, names);
  assert.ok(Math.abs(travel - Math.hypot(2 * Math.sin(4), 120)) < 1e-4, `travel ${travel}`);
  const root = clip.tracks.find((t) => t.name === "Bip01.position"), o = src.tracks[0];
  const n = root.values.length / 3, X = (v, i) => v[3 * i], Z = (v, i) => v[3 * i + 2];
  // residual = original minus the straight line first -> last key, minus a constant
  const res = (v, i) => [X(v, i) - (X(o.values, n - 1) - X(o.values, 0)) * (o.times[i] / 1.2), Z(v, i) - (Z(o.values, n - 1) - Z(o.values, 0)) * (o.times[i] / 1.2)];
  const off = [X(root.values, 0) - res(o.values, 0)[0], Z(root.values, 0) - res(o.values, 0)[1]];
  for (let i = 0; i < n; i++) {
    const r = res(o.values, i);
    assert.ok(Math.abs(X(root.values, i) - r[0] - off[0]) < 1e-5 && Math.abs(Z(root.values, i) - r[1] - off[1]) < 1e-5, `key ${i}: the variation within the stride is kept`);
    assert.ok(Math.abs(root.values[3 * i + 1] - (90 + Math.sin(i * 2))) < 1e-5, "the bob stays");
  }
  assert.ok(Math.abs(X(root.values, 0) - X(root.values, n - 1)) < 1e-5 && Math.abs(Z(root.values, 0) - Z(root.values, n - 1)) < 1e-5, "the loop closes");
  let mx = 0, mz = 0; for (let i = 0; i < n; i++) { mx += X(root.values, i); mz += Z(root.values, i); }
  assert.ok(Math.abs(mx / n) < 1e-5 && Math.abs(mz / n) < 1e-5, "centred under the holder");
  assert.ok(Math.max(...Array.from({ length: n }, (_, i) => Math.abs(X(root.values, i)))) > 0.5, "the sideways sway is not zeroed");
  assert.deepEqual(clip.tracks.map((t) => t.name).sort(), ["Bip01.position", "Bip01.quaternion", "Bip01_L_Thigh.quaternion"]);
  assert.ok(dropped.includes("Bip01_Pelvis.position") && dropped.includes("Bip01_L_Thigh.scale") && dropped.includes("MotionExtractionHelper.position") && dropped.includes("Bip01_Footsteps.position"));
  assert.deepEqual(missing, []);
  assert.equal(synthWalk().tracks[0].values[2], 0, "the original clip is left alone");
});

test("planted foot: a point the clip holds still on the floor stays still under a holder moving at the loop's average speed", () => {
  // A clip whose root surges (uneven speed within the stride) while a foot stays planted at world z = 40: the foot's
  // world position = root + (40 - root_original), held by the leg. Zeroing the root slid it; the residual must not.
  const times = [], pos = [];
  for (let i = 0; i <= 24; i++) { const t = (i / 24) * 1.2; times.push(t); pos.push(1.5 * Math.sin(2 * Math.PI * t / 1.2), 90, 100 * t + 6 * Math.sin(2 * Math.PI * t / 1.2)); }
  const src = new THREE.AnimationClip("w", 1.2, [new THREE.VectorKeyframeTrack("Bip01.position", times, pos)]);
  const { clip, travel } = C.prepareClip(src, new Set(["Bip01"]));
  const v = clip.tracks[0].values, slides = [];
  let prev = null;
  for (let i = 0; i <= 12; i++) {   // the first half of the loop, the foot planted
    const holderZ = travel * (times[i] / 1.2);          // the holder moves at constant speed with the distance
    const rootZ = holderZ + v[3 * i + 2];
    const footZ = rootZ + (40 - pos[3 * i + 2]);        // the leg keeps the clip's root-to-foot offset
    if (prev != null) slides.push(Math.abs(footZ - prev));
    prev = footZ;
  }
  assert.ok(Math.max(...slides) < 1e-4, `planted foot slid ${Math.max(...slides)} units a frame`);
  // the old rule (root X/Z zeroed) slid the same foot by centimetres
  let old = 0, p0 = null;
  for (let i = 0; i <= 12; i++) { const f = travel * (times[i] / 1.2) + (40 - pos[3 * i + 2]); if (p0 != null) old = Math.max(old, Math.abs(f - p0)); p0 = f; }
  assert.ok(old > 0.5);
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

test("clip time: idle by frame, walk and run on ONE shared gait phase; the same frame is always the same pose", () => {
  const clips = { idle: { duration: 10 }, walk: { duration: 1.2 }, run: { duration: 0.73 } };
  const a = C.clipTimes({ frame: 30, fps: 24, phase: 0.5 }, clips);
  assert.ok(Math.abs(a.idle - 1.25) < 1e-9);
  assert.ok(Math.abs(a.walk - 0.6) < 1e-9 && Math.abs(a.run - 0.365) < 1e-9, "half the phase = half of each loop");
  assert.ok(Math.abs(a.walk / 1.2 - a.run / 0.73) < 1e-12, "walk and run at the same point of the stride");
  const b = C.clipTimes({ frame: 30, fps: 24, phase: 3.5 }, clips);
  assert.ok(Math.abs(b.walk - a.walk) < 1e-9, "whole strides later the legs are in the same place");
  assert.deepEqual(C.clipTimes({ frame: 30, fps: 24, phase: 0.5 }, clips), a, "deterministic");
  const s = C.clipTimes({ frame: 30, fps: 24, phase: 0.5, seed: 0.25 }, clips);
  assert.ok(s.idle !== a.idle && s.idle >= 0 && s.idle < 10);
  for (const x of Object.values(C.clipTimes({ frame: 9999, fps: 24, phase: 987.65, seed: 0.9 }, clips))) assert.ok(x >= 0);
  assert.equal(C.phaseSeed("actor_a"), C.phaseSeed("actor_a"));
  assert.notEqual(C.phaseSeed("actor_a"), C.phaseSeed("actor_b"));
});

test("gait table: speed by frame, one phase that advances by distance over the blended stride (walk-run band in step)", () => {
  const strides = { walk: 1.2, run: 2.1 };
  assert.equal(C.blendStride({ walk: 1, run: 0 }, strides), 1.2);
  assert.equal(C.blendStride({ walk: 0, run: 1 }, strides), 2.1);
  assert.equal(C.blendStride({ walk: 0, run: 0, idle: 1 }, strides), 1.2);
  const mid = C.blendStride(C.clipWeights(2.3), strides);
  assert.ok(mid > 1.2 && mid < 2.1);
  // constant 1.3 m/s walk: a stride of distance = one whole phase
  const walk = Array.from({ length: 49 }, (_, f) => [0, (1.3 * f) / 24]);
  const tw = C.gaitTable(walk, 24, strides);
  assert.ok(Math.abs(tw.speed[24] - 1.3) < 1e-9);
  assert.ok(Math.abs(tw.phase[48] - (1.3 * 2) / 1.2) < 1e-9);
  // constant 2.3 m/s (inside the walk-run band): the phase rate is distance / blended stride, and walk and run times
  // come from that one phase, so the two mixed poses are the same point of the stride
  const band = Array.from({ length: 49 }, (_, f) => [0, (2.3 * f) / 24]);
  const tb = C.gaitTable(band, 24, strides);
  assert.ok(Math.abs((tb.phase[30] - tb.phase[29]) - (2.3 / 24) / mid) < 1e-9);
  const t = C.clipTimes({ frame: 30, fps: 24, phase: tb.phase[30] }, { walk: { duration: 1.2 }, run: { duration: 0.73 } });
  assert.ok(Math.abs(t.walk / 1.2 - t.run / 0.73) < 1e-12);
  // speeding up never makes the phase jump back or leap: it is continuous and grows with distance
  const accel = Array.from({ length: 97 }, (_, f) => [0, 0.5 * 0.08 * f * f / 24]);
  const ta = C.gaitTable(accel, 24, strides);
  for (let f = 1; f < 97; f++) assert.ok(ta.phase[f] >= ta.phase[f - 1] && ta.phase[f] - ta.phase[f - 1] < 0.2);
  // standing still: speed 0, phase still
  const still = C.gaitTable(Array.from({ length: 10 }, () => [1, 2]), 24, strides);
  assert.ok(still.speed.every((x) => x === 0) && still.phase.every((x) => x === 0));
  assert.deepEqual([...C.gaitTable(band, 24, strides).phase], [...tb.phase], "deterministic");
});

test("height: the avatar is scaled by its measured standing height, not by its hips", () => {
  assert.ok(Math.abs(C.statureScale(1.8, 181.9) * 181.9 - 1.8) < 1e-9);
  assert.ok(Math.abs(C.statureScale(1.68, 174.2) * 174.2 - 1.68) < 1e-9);
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

test("knocked over or moved by physics: the person stays clay for the whole shot (the clips stand upright)", () => {
  const a = { id: "p1", kind: "man" };
  assert.match(C.clayReason({ ...a, physics: { mode: "dynamic", baked: true } }, {}), /physics/);
  assert.match(C.clayReason({ ...a, tilt: [0.7071, 0, 0, 0.7071] }, {}), /knocked over/);
  assert.equal(C.clayReason({ ...a, physics: { mode: "dynamic" } }, {}), null, "set up for physics but not baked: still standing");
  assert.equal(C.clayReason({ ...a, tilt: [0, 0] }, {}), null);
});

test("swimming: the same gate as the stage's own (swim off, carried) and over the whole shot", () => {
  let called = 0;
  const plan = (mode) => () => { called++; return mode ? { n: mode.length, mode } : null; };
  assert.equal(C.swimsInShot({ id: "a", swim: "off" }, plan([0, 1, 1])), false, "swimming off: stays lifelike");
  assert.equal(called, 0, "the plan isn't even built");
  assert.equal(C.swimsInShot({ id: "a", carry_id: "b" }, plan([1])), false);
  assert.equal(C.swimsInShot({ id: "a" }, plan(null)), false);
  assert.equal(C.swimsInShot({ id: "a" }, plan([0, 0, 0])), false);
  assert.equal(C.swimsInShot({ id: "a" }, plan(new Uint8Array([0, 0, 1]))), true, "swims later in the shot: clay from frame 0");
});

test("Drive: decided for the whole shot, never flipping while a take is driven, recorded and reviewed", () => {
  const memo = {};
  const drive = { on: false, pending: null, live: new Map(), involved: new Set(), owns(id) { return this.on && !this.pending && this.live.has(id); } };
  assert.equal(C.drivenInShot(memo, "s1", "p1", drive), false);
  drive.on = true; drive.live.set("p1", {});
  assert.equal(C.drivenInShot(memo, "s1", "p1", drive), true);
  drive.pending = { take: {} };   // reviewing the recorded take: owns() is false now, the body must not flip back
  assert.equal(drive.owns("p1"), false);
  assert.equal(C.drivenInShot(memo, "s1", "p1", drive), true);
  drive.live.clear();
  assert.equal(C.drivenInShot(memo, "s1", "p1", drive), true, "still the same shot");
  assert.equal(C.drivenInShot(memo, "s1", "p2", drive), false, "someone Drive never had");
  assert.equal(C.drivenInShot(memo, "s2", "p1", drive), false, "a new shot decides again");
  drive.on = false;
  assert.equal(C.drivenInShot(memo, "s2", "p1", drive), false);
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

test("real Rocketbox avatar on a clay figure: faces +Z, stands at its set height, feet on the floor, deterministic", { skip: !installed && "Rocketbox files not installed" }, async () => {
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
  const scale = C.statureScale(1.8, kit.stature);
  const pose = (frame, phase, speed, yaw = 0) => {
    A.placeHolder(g, skin.holder, { x: 1, y: -kit.floor * scale, z: 2, yaw, scale });
    A.drive(skin, { frame, fps: 24, speed, phase, seed: 0 });
    g.updateMatrixWorld(true);
    const P = (n) => skin.bones[n].getWorldPosition(new THREE.Vector3());
    return { root: P("Bip01"), nose: P("Bip01_MNose"), head: P("Bip01_Head"), lt: P("Bip01_L_Thigh"), rt: P("Bip01_R_Thigh"), lToe: P("Bip01_L_Toe0"), rToe: P("Bip01_R_Toe0") };
  };
  const p = pose(10, 0, 0);
  assert.ok(p.nose.z - p.head.z > 0.08, "facing +Z (nose in front of the head)");
  assert.ok(p.lt.x > p.rt.x, "left thigh on +X, like the clay");
  assert.ok(Math.abs(p.root.y - 0.89) < 0.03, `hips at ${p.root.y.toFixed(3)} m`);
  assert.ok(Math.abs(p.root.x - 1) < 0.02 && Math.abs(p.root.z - 2) < 0.02, "the avatar stands where the actor is, whatever the clay group's own transform");
  assert.ok(Math.min(p.lToe.y, p.rToe.y) > -0.03 && Math.min(p.lToe.y, p.rToe.y) < 0.05, "a foot on the floor");
  const r = pose(10, 0, 0, Math.PI / 2);
  assert.ok(r.nose.x - r.head.x > 0.08, "turned to heading +90° it faces +X");
  // walking: the root stays near the holder (only the sway within a stride is left)
  for (let i = 0; i <= 24; i++) {
    const w = pose(i, i / 24, 1.3);
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

/** Both real kits, parsed once. */
let _kits = null;
async function realKits() {
  if (_kits) return _kits;
  const { parse } = await parseReal();
  const A = await import("../../web/stage/people/avatars.mjs");
  _kits = { A };
  for (const [kind, spec] of Object.entries(C.ROCKETBOX)) {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => C.tgaToPng(u, `${RB}tex/`));
    const raw = Object.fromEntries(C.CLIP_KINDS.map((k) => [k, parse(`anim/${spec.clips[k]}.max.fbx`).animations[0]]));
    _kits[kind] = { kit: A.buildKit(parse(`${spec.model}.fbx`, manager), raw), raw };
  }
  return _kits;
}
/** Walk an avatar along +Z at a steady speed; per frame: whole-body height, toe positions. */
function walkAlong(A, kit, { height, speed, frames = 96 }) {
  const scale = C.statureScale(height, kit.stature), strides = A.kitStrides(kit, scale);
  const g = new THREE.Group(), skin = A.instantiate(kit, { id: "x" });
  g.add(skin.holder);
  const path = Array.from({ length: frames }, (_, f) => [0, (speed * f) / 24]);
  const tab = C.gaitTable(path, 24, strides);
  const box = new THREE.Box3(), out = [];
  for (let f = 12; f < frames - 12; f++) {
    A.placeHolder(g, skin.holder, { x: 0, y: -kit.floor * scale, z: path[f][1], yaw: 0, scale });
    A.drive(skin, { frame: f, fps: 24, speed: tab.speed[f], phase: tab.phase[f], seed: 0 });
    g.updateMatrixWorld(true);
    box.makeEmpty(); box.expandByObject(skin.mesh, true);
    const P = (n) => skin.bones[n].getWorldPosition(new THREE.Vector3());
    out.push({ f, h: box.max.y - box.min.y, low: box.min.y, L: P("Bip01_L_Toe0"), R: P("Bip01_R_Toe0") });
  }
  return { out, scale, strides, skin, g, tab };
}
/** Planted-toe slide: the most a toe moves over the ground while it stays down (within 1.5 cm of its lowest). */
function plantedDrift(out) {
  let worst = 0;
  for (const s of ["L", "R"]) {
    const lo = Math.min(...out.map((o) => o[s].y));
    let start = null;
    for (const o of out) {
      if (o[s].y < lo + 0.015) { start ||= o[s]; worst = Math.max(worst, Math.hypot(o[s].x - start.x, o[s].z - start.z)); } else start = null;
    }
  }
  return worst;
}

test("real Rocketbox: standing height within 1 cm of the set height for the man and the woman, feet on the floor", { skip: !installed && "Rocketbox files not installed" }, async () => {
  const K = await realKits();
  for (const [kind, height] of [["man", 1.8], ["woman", 1.68], ["man", 1.92], ["woman", 1.55]]) {
    const { out } = walkAlong(K.A, K[kind].kit, { height, speed: 0, frames: 48 });
    for (const o of out) {
      assert.ok(Math.abs(o.h - height) < 0.01, `${kind} set to ${height} m stands ${o.h.toFixed(3)} m at frame ${o.f}`);
      assert.ok(Math.abs(o.low) < 0.012, `${kind} soles at ${o.low.toFixed(3)} m`);
    }
  }
});

test("real Rocketbox: planted feet barely slide at walk and run (the old zeroed root slid them 3-8 cm a stride)", { skip: !installed && "Rocketbox files not installed" }, async () => {
  const K = await realKits();
  // limits measured 2026-11-07 (cm): man walk 1.1 / run 1.5, woman walk 3.1 / run 3.6, versus 5.2 / 5.0 / 2.9 / 6.1 with
  // the zeroed root. The woman's walk sits at the clip's own level (its toe rolls within the contact).
  const limit = { man: { walk: 0.02, run: 0.025 }, woman: { walk: 0.04, run: 0.045 } };
  for (const kind of ["man", "woman"]) {
    const { kit } = K[kind];
    const height = kind === "man" ? 1.8 : 1.68, scale = C.statureScale(height, kit.stature), st = K.A.kitStrides(kit, scale);
    for (const gait of ["walk", "run"]) {
      const speed = st[gait] / kit.clips[gait].clip.duration;   // the clip's own pace, pure walk or pure run
      const d = plantedDrift(walkAlong(K.A, kit, { height, speed }).out);
      assert.ok(d < limit[kind][gait], `${kind} ${gait} at ${speed.toFixed(2)} m/s: a planted toe slid ${(100 * d).toFixed(1)} cm`);
    }
    // idle: the weight shift stays in the hips, the feet stay put
    assert.ok(plantedDrift(walkAlong(K.A, kit, { height, speed: 0 }).out) < 0.01, `${kind} idle feet slide`);
  }
});

test("real Rocketbox: in the walk-run band the legs blend in step (feet apart mid-stride, not together)", { skip: !installed && "Rocketbox files not installed" }, async () => {
  const K = await realKits();
  const w = C.clipWeights(2.3);
  assert.ok(w.walk > 0.2 && w.run > 0.2, "2.3 m/s really is a blend");
  for (const kind of ["man", "woman"]) {
    const { kit } = K[kind];
    const scale = C.statureScale(kind === "man" ? 1.8 : 1.68, kit.stature), st = K.A.kitStrides(kit, scale);
    const g = new THREE.Group(), skin = K.A.instantiate(kit, { id: "x" });
    g.add(skin.holder);
    K.A.placeHolder(g, skin.holder, { x: 0, y: 0, z: 0, yaw: 0, scale });
    const apart = () => { g.updateMatrixWorld(true); return Math.abs(skin.bones.Bip01_L_Toe0.getWorldPosition(new THREE.Vector3()).z - skin.bones.Bip01_R_Toe0.getWorldPosition(new THREE.Vector3()).z); };
    // the shared phase at a quarter and three quarters of the stride: one foot forward, one back, in BOTH clips
    for (const phase of [0.25, 0.75]) {
      K.A.drive(skin, { frame: 0, fps: 24, speed: 2.3, phase, seed: 0 });
      assert.ok(apart() > 0.5, `${kind} phase ${phase}: feet ${(100 * apart()).toFixed(1)} cm apart`);
    }
    // what the old rule did (each clip on distance / its own stride): somewhere the mixed legs close together
    let worst = 9;
    for (let d = 0; d < 6; d += 0.05) {
      for (const [k, act] of Object.entries(skin.actions)) { act.enabled = w[k] > 1e-4; act.setEffectiveWeight(w[k]); act.time = k === "idle" ? 0 : ((d / st[k]) % 1) * kit.clips[k].clip.duration; }
      skin.mixer.update(0);
      worst = Math.min(worst, apart());
    }
    assert.ok(worst < 0.1, "the out-of-phase blend this replaces really did close the legs");
  }
});

test("drop-onto picking: a ray still hits a lifelike person's hidden clay (three's raycast ignores visibility); no load in flight, no wait", async () => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
  m.visible = false;   // the clay under a lifelike body
  m.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(ray.intersectObjects([m], false).length > 0, true);
  const A = await import("../../web/stage/people/avatars.mjs");
  const t0 = Date.now();
  await A.avatarsReady(5000);
  assert.ok(Date.now() - t0 < 100, "captureSequence doesn't wait when nothing is loading");
});

// ---------------------------------------------------------------- bounds through attach and avatarsAt (review defects 1, 2)
/** A stub kit in centimetres like Rocketbox: a skinned bind-pose body 135 x 182 x 34 (arms out), idle box 50 x 180 x 30. */
function stubKit() {
  const geo = new THREE.BoxGeometry(135, 182, 34); geo.translate(0, 91, 0);
  const n = geo.attributes.position.count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(4 * n).fill(0), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(4 * n).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
  const mat = new THREE.MeshStandardMaterial({ name: "x_body", map: new THREE.Texture() }); mat.userData.role = "body";
  const mesh = new THREE.SkinnedMesh(geo, [mat]); mesh.name = "x_hipoly_81_bones";
  const bone = new THREE.Bone(); bone.name = "Bip01";
  const template = new THREE.Group(); template.add(mesh); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  return {
    template, meshName: mesh.name, materials: [mat], clips: {}, stature: 180, floor: 0,
    idleBox: new THREE.Box3(new THREE.Vector3(-25, 0, -15), new THREE.Vector3(25, 180, 15)),
    faceless: { neutral: new THREE.MeshStandardMaterial(), hidden: new THREE.MeshBasicMaterial({ visible: false }) },
    report: { missingMaps: [] },
  };
}

async function clayStage() {
  const A = await import("../../web/stage/people/avatars.mjs");
  const { Stage } = await import("../../web/stage/stage.mjs");
  const { buildObject } = await import("../../web/stage/library.mjs");
  const st = Object.create(Stage.prototype);
  const a = { id: "p1", kind: "man", height_m: 1.8, position: [2, 0, -1], keys: [{ frame: 0, position: [2, 0, -1] }] };
  st.state = { shot: { frames: 49, fps: 24 }, actors: [a], shots: [{ id: "s" }], active_shot: "s", people_look: "blocking" };
  st.actorMeshes = new Map();
  st.frame = 0;
  const g = buildObject("man", 1.8, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })));
  g.position.set(2, 0, -1);
  st.actorMeshes.set(a.id, g);
  st.setFrame = () => A.avatarsAt(st);
  return { A, st, a, g };
}
const sizeOf = (o) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
const near = (v, [x, y, z], tol, what) => assert.ok(Math.abs(v.x - x) < tol && Math.abs(v.y - y) < tol && Math.abs(v.z - z) < tol, `${what}: ${v.x.toFixed(2)} x ${v.y.toFixed(2)} x ${v.z.toFixed(2)}`);

test("a person who stays clay keeps clay-sized bounds after the avatar is attached (no 135 x 182 x 34 m box)", async () => {
  const { A, st, a, g } = await clayStage();
  const clay = sizeOf(g);
  near(clay, [0.5, 1.8, 0.3], 0.25, "clay alone");
  const skin = A.attachKit(st, a, g, stubKit());
  assert.ok(skin, "attached");
  assert.equal(skin.reason, "Blocking look is on");
  assert.equal(skin.shown, false);
  assert.equal(skin.holder.parent, null, "the hidden holder is not inside the clay group");
  near(sizeOf(g), [clay.x, clay.y, clay.z], 1e-6, "clay person after attach");
  // other clay reasons from the first frame too: a Pose key
  st.state.people_look = undefined; a.pose_keys = [{ frame: 0 }];
  A.avatarsAt(st);
  assert.equal(skin.shown, false);
  near(sizeOf(g), [clay.x, clay.y, clay.z], 1e-6, "clay person with Pose keys");
});

test("shown avatar: bounds stay person-sized (standing box), and switching back to clay takes the holder out again", async () => {
  const { A, st, a, g } = await clayStage();
  st.state.people_look = undefined;
  const skin = A.attachKit(st, a, g, stubKit());
  assert.equal(skin.shown, true, `shown (reason ${skin.reason})`);
  assert.equal(skin.holder.parent, g);
  const s = sizeOf(g);
  assert.ok(s.x < 0.8 && s.y < 2.0 && s.y > 1.6 && s.z < 0.6, `shown box ${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(2)}`);
  st.state.people_look = "blocking";
  A.avatarsAt(st);
  assert.equal(skin.shown, false);
  assert.equal(skin.holder.parent, null);
});

test("_localBox and _localHulls measure the clay even while the avatar shows (a bake doesn't depend on the install)", async () => {
  const { A, st, a } = await clayStage();
  // A two-part clay stand-in (torso + legs) keeps the hull build quick; the full clay figure takes ~1 min to decompose.
  const g = new THREE.Group(); g.userData.joints = {}; g.position.set(2, 0, -1);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.3), new THREE.MeshBasicMaterial()); torso.position.y = 1.3;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.9, 0.2), new THREE.MeshBasicMaterial()); legs.position.y = 0.45;
  g.add(torso, legs);
  st.actorMeshes.set(a.id, g);
  const before = st._localBox(g), hullsBefore = st._localHulls(g, before);
  assert.ok(before && hullsBefore?.length, "the stand-in has a box and hulls");
  near(new THREE.Vector3(...before.half).multiplyScalar(2), [0.5, 1.7, 0.3], 1e-6, "clay local box");
  st.state.people_look = undefined;
  const skin = A.attachKit(st, a, g, stubKit());
  assert.equal(skin.shown, true);
  g.userData.hullKey = undefined;   // force a fresh hull build
  const after = st._localBox(g), hullsAfter = st._localHulls(g, after);
  assert.deepEqual(after, before);
  assert.deepEqual(hullsAfter, hullsBefore);
  assert.equal(skin.shown, true, "shown state comes back");
  assert.equal(skin.holder.parent, g);
  assert.ok(skin.clay.every((m) => !m.visible), "clay hidden again");
});

test("real Rocketbox files: a shown avatar's bounds are a standing person (not the wide bind pose)", { skip: !installed && "Rocketbox files not installed (web/stage/people/rocketbox/)" }, async () => {
  const k = await realKits();
  for (const kind of Object.keys(C.ROCKETBOX)) {
    const { kit } = k[kind];
    assert.ok(kit.idleBox, `${kind}: idle box measured`);
    const { st, a, g } = await clayStage();
    a.kind = kind; st.state.people_look = undefined;
    const skin = k.A.attachKit(st, a, g, kit);
    assert.equal(skin.shown, true, `${kind} shown (reason ${skin.reason})`);
    const s = sizeOf(skin.holder);
    assert.ok(s.x < 0.9 && s.z < 0.9 && s.y > 1.5 && s.y < 2.0, `${kind} avatar box ${s.x.toFixed(2)} x ${s.y.toFixed(2)} x ${s.z.toFixed(2)}`);
  }
});
