// Fixes from testing interop with real, freely licensed scenes (docs/INTEROP_TESTED.md): Blender's FBX camera curves,
// DCC timelines that start at frame 1 or 1001, USD / Alembic picked as a world, untranslated glTF materials, skinned
// meshes' bounds, and the DCC kit's GLB that Blender 4.3 couldn't import when the shot had dust.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { resampleCurves } from "../../web/vendor/addons/FBXLoader.mjs";
import * as W from "../../web/stage/interop/importworld.mjs";
import * as X from "../../web/stage/interop/exportdcc.mjs";

const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

test("FBX curves: axes with different key times are resampled at the union, linearly (Blender simplifies each axis)", () => {
  // x keyed at 0 and 2 s only (a straight line Blender simplified), y at every second, z held.
  const curves = { x: { times: [0, 2], values: [80, 90] }, y: { times: [0, 1, 2], values: [0, 10, 0] }, z: { times: [0, 2], values: [5, 5] } };
  const r = resampleCurves(curves);
  for (const a of ["x", "y", "z"]) assert.deepEqual(Array.from(r[a].times), [0, 1, 2], a);
  assert.deepEqual(r.x.values, [80, 85, 90], "x is interpolated at 1 s, not taken from y's index");
  assert.deepEqual(r.y.values, [0, 10, 0]);
  assert.deepEqual(r.z.values, [5, 5, 5]);
  // Same times on every axis: untouched (the same object back).
  const same = { x: { times: [0, 1], values: [1, 2] }, y: { times: [0, 1], values: [3, 4] }, z: { times: [0, 1], values: [5, 6] } };
  assert.equal(resampleCurves(same), same);
  // Outside an axis's keys its value is held.
  const held = resampleCurves({ x: { times: [1], values: [7] }, y: { times: [0, 2], values: [0, 2] } });
  assert.deepEqual(held.x.values, [7, 7, 7]);
  assert.deepEqual(held.y.values, [0, 1, 2]);
});

test("a DCC timeline that starts at frame 1 or 1001 plays from shot frame 0, and shared times arrays move once", () => {
  const fps = 24, t0 = 1001 / fps;
  const times = new Float32Array([t0, t0 + 1, t0 + 2]);   // glTF: translation and rotation share one sampler input
  const pos = new THREE.VectorKeyframeTrack("cam.position", times, [0, 0, 0, 1, 0, 0, 2, 0, 0]);
  const rot = new THREE.QuaternionKeyframeTrack("cam.quaternion", times, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const clip = new THREE.AnimationClip("take", -1, [pos, rot]);
  const cam = new THREE.PerspectiveCamera();
  cam.userData.yfovTrack = { times: [t0, t0 + 2], values: [0.5, 0.4] };
  const root = new THREE.Group(); root.add(cam);
  const off = W.startAtFirstKey([clip], root);
  near(off, t0, 1e-5, "offset");
  near(pos.times[0], 0, 1e-5, "position starts at 0"); near(rot.times[0], 0, 1e-5, "rotation moved once, not twice");
  near(clip.duration, 2, 1e-5, "duration is the clip's own length");
  near(cam.userData.yfovTrack.times[0], 0, 1e-5, "lens track moved too"); near(W.fovAt(cam, 2.001), 0.4 * 180 / Math.PI, 1e-9);
  // A file that starts at 0 (Soundstage's own GLB) is left alone, and so is one with no animation.
  const z = new THREE.AnimationClip("z", -1, [new THREE.VectorKeyframeTrack("a.position", [0, 1], [0, 0, 0, 1, 1, 1])]);
  assert.equal(W.startAtFirstKey([z]), 0);
  assert.equal(z.tracks[0].times[0], 0);
  assert.equal(W.startAtFirstKey([]), 0);
  // One offset for all clips: a crate keyed from frame 1 and a camera from frame 10 keep their 9 frames apart.
  const a = new THREE.AnimationClip("a", -1, [new THREE.VectorKeyframeTrack("crate.position", [1 / fps, 2], [0, 0, 0, 1, 0, 0])]);
  const b = new THREE.AnimationClip("b", -1, [new THREE.VectorKeyframeTrack("cam.position", [10 / fps, 2], [0, 0, 0, 1, 0, 0])]);
  W.startAtFirstKey([a, b]);
  near(a.tracks[0].times[0], 0, 1e-6); near(b.tracks[0].times[0], 9 / fps, 1e-6);
});

test("USD and Alembic picked as a world are refused with what to export instead (they used to load as an empty 0 mm world)", async () => {
  const url = "data:application/octet-stream;base64," + Buffer.from("PXR-USDC\0\0\0\0junk").toString("base64");
  for (const f of ["usd", "usda", "usdc", "usdz"]) await assert.rejects(W.loadWorldFile(url, f), /USD \(\.usd[acz]?\) isn't read here.*GLB.*FBX/);
  await assert.rejects(W.loadWorldFile(url, "abc"), /Alembic \(\.abc\) isn't read here.*GLB.*FBX/);
  await assert.rejects(W.loadWorldFile(url, "blend"), /\.blend isn't a world format/);
  // STL still loads.
  const stl = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
  const raw = await W.loadWorldFile("data:model/stl;base64," + Buffer.from(stl).toString("base64"), "stl");
  assert.equal(raw.scene.children.length, 1);
});

test("glTF materials an exporter couldn't translate (no pbrMetallicRoughness) come in matte, not black metal", () => {
  const a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 }), c = new THREE.MeshStandardMaterial();
  [a, b, c].forEach((m) => { m.metalness = 1; m.roughness = 1; });   // what the glTF defaults give a bare material
  b.roughness = 0.2;
  const g = { parser: { json: { materials: [{ name: "zapBook_color", doubleSided: true }, { name: "chrome", pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0.2 } },
    { name: "cloth", extensions: { KHR_materials_sheen: {} } }] }, associations: new Map([[a, { materials: 0 }], [b, { materials: 1 }], [c, { materials: 2 }]]) } };
  assert.equal(W.matteUntranslated(g), 1);
  assert.equal(a.metalness, 0); assert.equal(a.roughness, 0.8); assert.ok(a.userData.untranslated);
  assert.equal(b.metalness, 1, "a real metal stays metal"); assert.equal(b.roughness, 0.2);
  assert.equal(c.metalness, 1, "a material described by an extension is left alone");
});

test("a skinned mesh's world size comes from its bones, not its bind-space geometry", () => {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const n = geo.attributes.position.count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(n).fill([1, 0, 0, 0]).flat(), 4));
  const bone = new THREE.Bone();
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  const scene = new THREE.Group();
  scene.add(bone, mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([bone]));
  bone.position.set(0, 5, 0);   // posed 5 m up from where it was bound (an FBX rig's bind space)
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 4), new THREE.MeshStandardMaterial());
  floor.position.y = 4.45;
  scene.add(floor);
  const prep = W.prepareWorld({ scene, animations: [] }, { merge: false });
  near(prep.bounds.min.y, 4.4, 1e-6, "lowest point: the floor"); near(prep.bounds.max.y, 5.5, 1e-6, "highest: the posed box, not the bind pose at 0.5");
});

test("the DCC kit leaves sprite particles with shader-only attributes out of scene.glb", () => {
  const dust = new THREE.BufferGeometry();
  dust.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  dust.setAttribute("pSize", new THREE.BufferAttribute(new Float32Array(1), 1));
  assert.ok(X.hasShaderOnlyAttributes(dust));
  const mesh = new THREE.BoxGeometry(1, 1, 1);
  mesh.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.attributes.position.count * 3), 3));
  assert.ok(!X.hasShaderOnlyAttributes(mesh));
  assert.ok(!X.hasShaderOnlyAttributes(null));
});

test("an orthographic camera in the file isn't made into a shot with a guessed lens (Khronos Cameras sample)", () => {
  const scene = new THREE.Group();
  const persp = new THREE.PerspectiveCamera(40, 1.5, 0.1, 100), ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  ortho.name = "Ortho"; persp.name = "Persp";
  scene.add(ortho, persp, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  const prep = W.prepareWorld({ scene, animations: [] }, { merge: false });
  assert.deepEqual(prep.cameras.map((c) => c.name), ["Persp"]);
  assert.equal(prep.stats.orthoCameras, 1);
  assert.equal(prep.stats.cameras, 1);
});
