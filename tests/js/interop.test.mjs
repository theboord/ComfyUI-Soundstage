// Milestone 12: round-trip interop with Blender, Unreal, Maya and Nuke. Axis and unit conversion, camera maths,
// collision proxies, world import (units / up / floor / cameras / animation / merging) and the animated GLB export.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as U from "../../web/stage/interop/units.mjs";
import { worldColliders, planarBoxes, propBox, greedyRects, quatFromAxes } from "../../web/stage/interop/colliders.mjs";
import * as W from "../../web/stage/interop/importworld.mjs";
import * as X from "../../web/stage/interop/exportdcc.mjs";
import { createWorld } from "../../web/stage/physengine.mjs";

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const nearV = (a, b, eps = 1e-6, msg = "") => a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));

// GLTFExporter reads its Blobs back with FileReader, which node lacks.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((r) => { this.result = r; this.onloadend?.({ target: this }); this.onload?.({ target: this }); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((r) => { this.result = `data:${blob.type};base64,${Buffer.from(r).toString("base64")}`; this.onloadend?.({ target: this }); this.onload?.({ target: this }); }); }
};

// ---------------------------------------------------------------- axes and units

test("up axes: Z-up (Blender, Unreal FBX) stands up as Y-up, right-handed, no mirror", () => {
  nearV(U.toStage([0, 0, 1], { up: "z" }), [0, 1, 0], 1e-12, "z up");
  nearV(U.toStage([0, 1, 0], { up: "z" }), [0, 0, -1], 1e-12, "z-up +Y (Blender forward) -> stage -Z");
  nearV(U.toStage([1, 0, 0], { up: "z" }), [1, 0, 0], 1e-12, "x stays");
  nearV(U.toStage([0, -1, 0], { up: "-y" }), [0, 1, 0], 1e-12, "-y");
  nearV(U.toStage([1, 0, 0], { up: "x" }), [0, 1, 0], 1e-12, "x up");
  nearV(U.toStage([0, 0, -1], { up: "-z" }), [0, 1, 0], 1e-12, "-z up");
  // a rotation, never a reflection: det = +1 for every choice
  for (const up of ["y", "z", "-y", "-z", "x", "-x"]) {
    const ex = U.qrot(U.upAxisQuat(up), [1, 0, 0]), ey = U.qrot(U.upAxisQuat(up), [0, 1, 0]), ez = U.qrot(U.upAxisQuat(up), [0, 0, 1]);
    const det = ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) - ex[1] * (ey[0] * ez[2] - ey[2] * ez[0]) + ex[2] * (ey[0] * ez[1] - ey[1] * ez[0]);
    near(det, 1, 1e-9, `det ${up}`);
  }
});

test("units: centimetres scale 0.01, offset and scale compose like three's T*R*S", () => {
  nearV(U.toStage([100, 200, 300], { up: "z", scale: U.UNIT_TO_M.cm, offset: [1, 0, -1] }), [2, 3, -3], 1e-12);
  assert.equal(U.UNIT_TO_M.in, 0.0254);
  assert.equal(U.UNIT_TO_M.ft, 0.3048);
});

test("unit guesses: undeclared worlds read as m / cm / mm from their pieces; a cm world labelled m gets a fix", () => {
  assert.equal(U.guessUnits({ height: 3, span: 10, meshHeight: 1 }).units, "m");
  assert.equal(U.guessUnits({ height: 300, span: 1000, meshHeight: 120 }).units, "cm");
  assert.equal(U.guessUnits({ height: 3000, span: 10000, meshHeight: 900 }).units, "mm");
  const g = U.guessUnits({ declared: "m", height: 300, span: 1000, meshHeight: 120 });
  assert.equal(g.units, "m");
  near(g.suggest, 0.01, 1e-12, "suggest x0.01");
  assert.equal(U.guessUnits({ declared: "m", height: 30, span: 400, meshHeight: 3 }).suggest, null, "a real town is left alone");
  assert.equal(U.guessUnits({ declared: "cm", height: 300, span: 1000, meshHeight: 120 }).suggest, null);
});

test("up-axis vote: the biggest flat area is the floor; a closed room ties to +", () => {
  assert.equal(U.upFromNormals({ x: [10, 10], y: [30, 0], z: [12, 12] }).up, "y");
  assert.equal(U.upFromNormals({ x: [10, 10], y: [12, 12], z: [40, 40] }).up, "z");
  assert.equal(U.upFromNormals({ x: [1, 1], y: [0, 50], z: [1, 1] }).up, "-y");
  assert.ok(U.upFromNormals({ x: [10, 10], y: [12, 12], z: [40, 40] }).confident);
});

test("floor: the lowest level with real area, not a roof or a table top", () => {
  near(U.floorFromBins([[0, 80], [0.75, 2], [3, 100]]), 0);
  near(U.floorFromBins([[-0.1, 5], [0, 80], [3, 70]]), 0);
});

test("size readout and lengths", () => {
  assert.equal(U.sizeReadout([120, 15, 80]), "This world is 120 m × 80 m, 15 m tall");
  assert.equal(U.fmtLen(0.25), "25 cm");
  assert.equal(U.fmtLen(4200), "4.2 km");
});

// ---------------------------------------------------------------- cameras

test("lens <-> FOV: the 36 mm horizontal sensor, both ways, at any aspect", () => {
  for (const aspect of [1.85, 2.39, 16 / 9, 1]) for (const f of [18, 35, 50, 135]) {
    near(U.focalFromVfov(U.vfovFromFocal(f, aspect), aspect), f, 1e-9, `f ${f} @ ${aspect}`);
  }
  near(U.vfovFromFocal(36 / 2, 1), 90, 1e-9, "18 mm on a square 36 mm frame = 90 deg");
});

test("camera frames: ZXY angles rebuild the look-at rotation exactly (Nuke / Maya order)", () => {
  const track = [{ position: [-7, 1.7, -14], target: [0, 1.3, -4], focal_mm: 35 }, { position: [3, 5, 2], target: [-1, 0.2, 9], focal_mm: 50, roll_deg: 12 },
    { position: [0, 30, 0], target: [0.001, 0, 0], focal_mm: 24 }];
  const fr = U.cameraFrames(track, 1920, 1038, 1001);
  assert.deepEqual(fr.map((f) => f.frame), [1001, 1002, 1003]);
  for (const f of fr) {
    const R = U.rotZXY(...f.rotate_zxy_deg);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) near(R[r][c], f.cam_to_world[r][c], 1e-5, `R${r}${c}`);
    near(f.fx_px, (f.focal_mm * 1920) / 36, 1e-6);
    near(f.hfov_deg, (2 * Math.atan(18 / f.focal_mm) * 180) / Math.PI, 1e-5);
  }
  // looking down -Z with no roll: camera axes are the world axes
  const m = U.lookAt([0, 0, 0], [0, 0, -5]);
  nearV(m[0].slice(0, 3), [1, 0, 0]); nearV(m[1].slice(0, 3), [0, 1, 0]); nearV(m[2].slice(0, 3), [0, 0, 1]);
});

test("Euler unwrap keeps keys continuous across ±180", () => {
  assert.equal(U.unwrap(179, -179), 181);
  assert.equal(U.unwrap(-170, 175), -185);
  const fr = U.cameraFrames([0, 1, 2, 3].map((i) => ({ position: [0, 1, 0], target: [Math.sin(Math.PI - 0.05 + i * 0.05), 1, Math.cos(Math.PI - 0.05 + i * 0.05)], focal_mm: 35 })), 100, 50);
  for (let i = 1; i < fr.length; i++) assert.ok(Math.abs(fr[i].rotate_zxy_deg[1] - fr[i - 1].rotate_zxy_deg[1]) < 10, "no flip");
});

test(".chan: frame tx ty tz rx ry rz vfov, tab separated", () => {
  const fr = U.cameraFrames([{ position: [1, 2, 3], target: [1, 2, 0], focal_mm: 35 }], 1920, 1080, 1001);
  const cols = U.chanText(fr).trim().split("\t");
  assert.equal(cols.length, 8);
  assert.equal(cols[0], "1001");
  assert.equal(+cols[1], 1); assert.equal(+cols[3], 3);
  near(+cols[7], fr[0].vfov_deg, 1e-6);
});

test("a camera node's matrix becomes a key: position, target ahead, roll measured", () => {
  const cam = new THREE.PerspectiveCamera(40, 1.85);
  cam.position.set(2, 1.6, 8);
  cam.lookAt(2, 1.6, 0);
  cam.rotateZ(THREE.MathUtils.degToRad(10));
  cam.updateMatrixWorld(true);
  const k = U.keyFromMatrix(cam.matrixWorld.elements, 10);
  nearV(k.position, [2, 1.6, 8], 1e-9);
  nearV(k.target, [2, 1.6, -2], 1e-9);
  near(k.roll_deg, 10, 1e-6, "roll");
  // FBX cameras look down +X
  const o = new THREE.Object3D();
  o.updateMatrixWorld(true);
  nearV(U.keyFromMatrix(o.matrixWorld.elements, 1, { forwardX: true }).target, [1, 0, 0], 1e-12);
});

// ---------------------------------------------------------------- colliders

/** Triangles of an axis-aligned box (12 triangles, outward). */
function boxTris(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return Float32Array.from(g.attributes.position.array);
}
const cat = (...arrs) => { const out = new Float32Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
/** A 10 x 8 m room: floor slab, 3 m walls 0.2 thick, the front wall (z = +4) with a 1 m x 2.1 m door at x = 1.5. */
function room() {
  return [
    { name: "floor", tris: boxTris([-5, -0.1, -4], [5, 0, 4]) },
    { name: "back", tris: boxTris([-5, 0, -4], [5, 3, -3.8]) },
    { name: "left", tris: boxTris([-5, 0, -4], [-4.8, 3, 4]) },
    { name: "right", tris: boxTris([4.8, 0, -4], [5, 3, 4]) },
    { name: "front", tris: cat(boxTris([-5, 0, 3.8], [1, 3, 4]), boxTris([2, 0, 3.8], [5, 3, 4]), boxTris([1, 2.1, 3.8], [2, 3, 4])) },
    { name: "table", tris: cat(boxTris([1.2, 0.7, 0.55], [2.8, 0.75, 1.45]), boxTris([1.25, 0, 0.6], [1.31, 0.7, 0.66])) },
  ];
}
const inside = (b, p) => {
  const q = [b.quat[0], b.quat[1], b.quat[2], b.quat[3]];
  const inv = [-q[0], -q[1], -q[2], q[3]];
  const d = U.qrot(inv, [p[0] - b.pos[0], p[1] - b.pos[1], p[2] - b.pos[2]]);
  return d.every((v, i) => Math.abs(v) <= b.half[i] + 1e-6);
};

test("colliders: a room becomes slabs; the floor is the floor; the doorway stays open; the table is one box", () => {
  const { boxes, dropped } = worldColliders(room());
  assert.equal(dropped, 0);
  assert.ok(boxes.length >= 8 && boxes.length < 60, `${boxes.length} boxes`);
  const solid = (p) => boxes.some((b) => inside(b, p));
  assert.ok(solid([0, -0.05, 0]), "inside the floor slab");
  assert.ok(!solid([0, 0.05, 0]), "nothing just above the floor");
  assert.ok(!solid([0, 0.25, 0]), "no underside slab poking up through the floor");
  assert.ok(solid([0, 1.5, -3.9]), "back wall");
  assert.ok(solid([4.9, 1.5, 0]), "right wall");
  assert.ok(solid([0, 1, 3.9]), "front wall left of the door");
  assert.ok(!solid([1.5, 1, 3.9]), "the doorway is open");
  assert.ok(solid([1.5, 2.5, 3.9]), "the lintel over the door");
  assert.ok(solid([2, 0.72, 1]), "the table top");
  assert.ok(!solid([2, 0.9, 1]), "free air above the table");
  // the wall slabs are exactly as thick as the walls (both faces paired)
  const back = boxes.filter((b) => inside(b, [0, 1.5, -3.9]));
  assert.ok(back.some((b) => b.half.some((h) => Math.abs(2 * h - 0.2) < 1e-4)), "the back wall's box is the wall: 0.2 m thick");
  assert.ok(!solid([0, 1.5, -3.75]) && !solid([0, 1.5, 3.75]), "nothing in front of the walls");
});

test("colliders: physics stands a crate on the table and stops one at the wall", () => {
  const { boxes } = worldColliders(room());
  const w = createWorld({ floor: true, substeps: 8 });
  for (const b of boxes) w.addBody({ shape: "box", half: b.half, center: [0, 0, 0], type: "static", pos: b.pos, quat: b.quat });
  const a = w.addBody({ shape: "box", half: [0.2, 0.2, 0.2], center: [0, 0.2, 0], type: "dynamic", mass: 10, friction: 0.7, restitution: 0.05, pos: [2, 1.6, 1] });
  for (let i = 0; i < 180; i++) w.step(1 / 60);
  near(w.getPose(a).pos[1], 0.75, 0.03, "crate rests on the table top");
  const b = w.addBody({ shape: "box", half: [0.2, 0.2, 0.2], center: [0, 0.2, 0], type: "dynamic", mass: 10, friction: 0.5, restitution: 0.05, pos: [3, 0.01, -2] });
  w.setKinematicTarget(b, [4.79, 0.01, -2], [0, 0, 0, 1]);   // shove it into the right wall (inner face x = 4.8)
  for (let i = 0; i < 90; i++) w.step(1 / 60);
  w.setKinematicTarget(b, null);
  for (let i = 0; i < 90; i++) w.step(1 / 60);
  assert.ok(w.getPose(b).pos[0] <= 4.8 - 0.2 + 0.03, `stopped by the wall at x ${w.getPose(b).pos[0]}`);
});

test("colliders: a turned prop gets a turned box; greedy rectangles cover a grid exactly", () => {
  const g = new THREE.BoxGeometry(2, 1, 0.5).toNonIndexed();
  g.rotateY(THREE.MathUtils.degToRad(30));
  const b = propBox(Float32Array.from(g.attributes.position.array));
  nearV([...b.half].sort((p, q) => p - q), [0.25, 0.5, 1], 1e-3, "half extents");
  const yaw = 2 * Math.atan2(b.quat[1], b.quat[3]) * 180 / Math.PI;
  assert.ok([30, -150, 120, -60].some((a) => Math.abs(((yaw - a + 540) % 180) - 0) < 0.5 || Math.abs(((yaw - a + 540) % 180) - 180) < 0.5), `yaw ${yaw}`);
  const grid = Uint8Array.from([1, 1, 0, 1, 1, 0, 0, 0, 1]);
  const rects = greedyRects(grid, 3, 3);
  let cells = 0;
  for (const [i0, j0, i1, j1] of rects) cells += (i1 - i0 + 1) * (j1 - j0 + 1);
  assert.equal(cells, 5);
  assert.equal(rects.length, 2);
  const q = quatFromAxes([0, 0, -1], [0, 1, 0], [1, 0, 0]);
  nearV(U.qrot(q, [1, 0, 0]), [0, 0, -1], 1e-9, "x axis");
});

test("colliders: a column or a lamp post is one box; a wall with a door is not", () => {
  const g = new THREE.CylinderGeometry(0.3, 0.3, 4, 16).toNonIndexed();
  g.translate(2, 2, 3);
  const { boxes } = worldColliders([{ tris: Float32Array.from(g.attributes.position.array) }]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].kind, "solid");
  nearV(boxes[0].pos, [2, 2, 3], 1e-3);
  const front = room().find((m) => m.name === "front");
  assert.ok(worldColliders([front]).boxes.length > 1, "the doorway keeps it in slabs");
});

test("colliders: a terrain with no flat parts still gets ground columns; caps keep the biggest", () => {
  const tris = [];
  for (let i = -5; i < 5; i++) for (let k = -5; k < 5; k++) {
    const h = (x, z) => 0.3 * Math.sin(x * 0.9) + 0.25 * Math.cos(z * 1.3);
    const p = (x, z) => [x, h(x, z), z];
    tris.push(...p(i, k), ...p(i, k + 1), ...p(i + 1, k), ...p(i + 1, k), ...p(i, k + 1), ...p(i + 1, k + 1));
  }
  const boxes = planarBoxes(Float32Array.from(tris));
  assert.ok(boxes.some((b) => b.kind === "terrain"), "terrain columns");
  const capped = worldColliders([{ tris: Float32Array.from(tris) }, ...room()], { maxBoxes: 10 });
  assert.equal(capped.boxes.length, 10);
  assert.ok(capped.dropped > 0);
});

// ---------------------------------------------------------------- world import

const mat = (name, color) => new THREE.MeshStandardMaterial({ name, color });
/** A Blender-like test world built in three, in raw file units / axes: (scale, up) applied to its root. */
function syntheticWorld({ unit = 1, zUp = false } = {}) {
  const scene = new THREE.Group();
  const wallM = mat("wall", 0xcccccc), floorM = mat("floor", 0x886644), wood = mat("wood", 0x664422);
  const add = (geo, m, name, pos) => { const o = new THREE.Mesh(geo, m); o.name = name; o.position.set(...pos); scene.add(o); return o; };
  add(new THREE.BoxGeometry(10, 0.1, 8), floorM, "floor", [0, -0.05, 0]);
  add(new THREE.BoxGeometry(10, 3, 0.2), wallM, "wall_back", [0, 1.5, -3.9]);
  add(new THREE.BoxGeometry(0.2, 3, 8), wallM, "wall_left", [-4.9, 1.5, 0]);
  add(new THREE.BoxGeometry(0.2, 3, 8), wallM, "wall_right", [4.9, 1.5, 0]);
  add(new THREE.BoxGeometry(6, 3, 0.2), wallM, "wall_front_l", [-2, 1.5, 3.9]);
  add(new THREE.BoxGeometry(3, 3, 0.2), wallM, "wall_front_r", [3.5, 1.5, 3.9]);
  for (let i = 0; i < 40; i++) add(new THREE.BoxGeometry(0.3, 0.3, 0.3), wood, `book_${i}`, [-4 + (i % 10) * 0.3, 0.15, -3 + Math.floor(i / 10) * 0.3]);
  const crate = add(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat("crate", 0xaa8833), "crate", [-3, 0.3, -2]);
  const cam = new THREE.PerspectiveCamera(U.vfovFromFocal(35, 1.85), 1.85, 0.1, 100);
  cam.name = "ShotCam";
  cam.position.set(0, 1.6, 12);
  scene.add(cam);
  const clip = new THREE.AnimationClip("anim", 2, [
    new THREE.VectorKeyframeTrack("crate.position", [0, 2], [-3, 0.3, -2, -1, 0.3, -2]),
    new THREE.VectorKeyframeTrack("ShotCam.position", [0, 2], [0, 1.6, 12, 0, 1.6, 6]),
  ]);
  // Raw file: Z up (rotate +90 about X) and in file units.
  const root = new THREE.Group();
  root.add(scene);
  if (zUp) scene.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  scene.scale.setScalar(1 / unit);
  root.updateMatrixWorld(true);
  void crate;
  return { scene: root, animations: [clip], declared: { up: null, units: null } };
}

function fakeStage() {
  const s = { state: { shot: { fps: 24, frames: 97 }, actors: [] }, root: new THREE.Group(), frame: 0, fw: 1920, fh: 1038, ground: new THREE.Mesh(),
    _shots() { if (!this.state.shots) { this.state.shots = [{ id: "shot_1", name: "Master", camera_keys: [{ frame: 0, position: [0, 1.7, 5], target: [0, 1, 0], focal_mm: 35 }] }]; this.state.active_shot = "shot_1"; } return this.state.shots; },
    _buildSet() { this.root.clear(); this.worldMount.attach(); }, setFrame(f) { this.frame = f; this.worldMount.setTime(f / 24); }, onChange() {}, toJSON() { return this.state; } };
  s.worldMount = new W.WorldMount(s);
  return s;
}

test("world import: a Z-up centimetre world (Unreal / Maya style) comes in Y-up in metres with the floor on y = 0", () => {
  const raw = syntheticWorld({ unit: 0.01, zUp: true });
  const prep = W.prepareWorld(raw);
  const xf = W.resolveTransform(prep, { format: "obj" });
  assert.equal(xf.up, "z", xf.reasons.up);
  assert.equal(xf.units, "cm", xf.reasons.units);
  nearV(xf.size, [10, 3.1, 8], 1e-3, "size");
  near(xf.floor + xf.offset[1], 0, 1e-6, "floor on y = 0");
  assert.equal(W.resolveTransform(prep, { format: "obj", source: "unreal" }).units, "cm", "Unreal preset");
  assert.equal(W.resolveTransform(prep, { format: "obj", units: "m" }).factor, 1, "manual units win");
});

test("world import: static meshes merge by material into a few draw calls; animated ones stay separate", () => {
  const prep = W.prepareWorld(syntheticWorld());
  assert.equal(prep.stats.meshes, 47);
  assert.ok(prep.stats.draws <= 4, `draws ${prep.stats.draws}`);
  assert.equal(prep.stats.animated, 2);
  assert.ok(prep.scene.getObjectByName("crate")?.isMesh, "the animated crate keeps its own node");
  assert.equal(prep.stats.cameras, 1);
});

test("world import: the mount makes the Set, colliders, a shot from the file camera, and plays the animation", async () => {
  const raw = syntheticWorld();
  const s = fakeStage();
  s.state.world = { url: "mem://world.glb", name: "world", format: "glb" };
  // Skip the network: hand the mount a prepared world directly.
  s.worldMount._loading = null;
  const prep = W.prepareWorld(raw);
  prep.declared = { up: "y", units: "m" };
  s.worldMount.prep = null;
  const loadWorldFile = W.loadWorldFile;
  void loadWorldFile;
  // emulate _load's tail
  const m = s.worldMount;
  m.prep = prep; m.url = "mem://world.glb";
  m.group = new THREE.Group(); m.xform = new THREE.Group(); m.group.add(m.xform); m.xform.add(prep.scene);
  m.mixer = new THREE.AnimationMixer(prep.scene);
  m.actions = prep.animations.map((c) => { const a = m.mixer.clipAction(c); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play(); return a; });
  s.root.add(m.group);
  m._apply();
  m._importCameras(true);
  assert.equal(m.info.readout, "This world is 10 m × 8.0 m, 3.1 m tall");
  assert.ok(m.colliders().length > 10, `${m.colliders().length} colliders`);
  const shot = s.state.shots.find((x) => x.from_world);
  assert.ok(shot, "a shot from the file's camera");
  assert.equal(s.state.active_shot, shot.id);
  assert.equal(shot.camera_keys.length, 49, "keyed every frame over the 2 s clip");
  nearV(shot.camera_keys[0].position, [0, 1.6, 12], 1e-3);
  nearV(shot.camera_keys[48].position, [0, 1.6, 6], 1e-3);
  near(shot.camera_keys[0].focal_mm, 35, 0.01, "focal from the FOV");
  // animation on the timeline, scrubbing back and forth
  const crate = prep.scene.getObjectByName("crate");
  s.setFrame(48); near(crate.position.x, -1, 1e-6);
  s.setFrame(0); near(crate.position.x, -3, 1e-6);
  s.setFrame(60); near(crate.position.x, -1, 1e-6, "holds its last pose");
  // fix scale: everything follows, including the shot
  m.setWorld({ scale_mul: 2 });
  near(m.info.size[0], 20, 1e-3);
  nearV(s.state.shots.find((x) => x.from_world).camera_keys[0].position, [0, 3.2, 24], 1e-3, "camera keys follow the world");
});

test("FBX header: UpAxis / UnitScaleFactor / FilmWidth from ASCII and binary", () => {
  const ascii = `; FBX 7.4.0 project file\nGlobalSettings:  {\n Properties70:  {\n  P: "UpAxis", "int", "Integer", "",2\n  P: "UpAxisSign", "int", "Integer", "",1\n  P: "UnitScaleFactor", "double", "Number", "",1\n }\n}\n  P: "FilmWidth", "double", "Number", "",0.816\n  P: "FilmWidth", "double", "Number", "",1.4173228\n`;
  const a = W.fbxGlobalSettings(new TextEncoder().encode(ascii).buffer);
  assert.equal(a.up, "z"); assert.equal(a.unitScale, 1); near(a.filmWidthMm, 36, 1e-4);
  // binary: "Kaydara FBX Binary" header, then property records: S name, S type, S label, S flags, value
  const parts = [new TextEncoder().encode("Kaydara FBX Binary  \0\x1a\0"), new Uint8Array([0xe8, 0x1c, 0, 0])];
  const S = (str) => { const b = new TextEncoder().encode(str); const o = new Uint8Array(5 + b.length); o[0] = 0x53; new DataView(o.buffer).setUint32(1, b.length, true); o.set(b, 5); return o; };
  const I = (v) => { const o = new Uint8Array(5); o[0] = 0x49; new DataView(o.buffer).setInt32(1, v, true); return o; };
  const D = (v) => { const o = new Uint8Array(9); o[0] = 0x44; new DataView(o.buffer).setFloat64(1, v, true); return o; };
  parts.push(S("UpAxis"), S("int"), S("Integer"), S(""), I(1), S("UnitScaleFactor"), S("double"), S("Number"), S(""), D(100));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => { bytes.set(p, o); return o + p.length; }, 0);
  const b = W.fbxGlobalSettings(bytes.buffer);
  assert.equal(b.up, "y"); assert.equal(b.unitScale, 100);
});

test("FBX takes: one take per node, the one named after it", () => {
  const t = (n) => new THREE.VectorKeyframeTrack(`${n}.position`, [0, 1], [0, 0, 0, 1, 1, 1]);
  const clips = [new THREE.AnimationClip("crate|ShotCamAction", 1, [t("crate")]), new THREE.AnimationClip("ShotCam|ShotCamAction", 1, [t("ShotCam")]),
    new THREE.AnimationClip("crate|crateAction", 1, [t("crate")]), new THREE.AnimationClip("ShotCam|crateAction", 1, [t("ShotCam")])];
  assert.deepEqual(W.pickTakes(null, clips).map((c) => c.name).sort(), ["ShotCam|ShotCamAction", "crate|crateAction"]);
});

test("far LOD: vertex clustering keeps the shape and drops most triangles", () => {
  const g = new THREE.SphereGeometry(10, 128, 96);
  const s = W.clusterSimplify(g, 1.5);
  assert.ok(s.index.count / 3 < (g.index.count / 3) * 0.2, "fewer triangles");
  s.computeBoundingSphere();
  near(s.boundingSphere.radius, 10, 1.0, "same size");
});

// ---------------------------------------------------------------- export

test("animated GLB: tracks only for what moves, the camera keyed, its lens as KHR_animation_pointer, and it re-imports", async () => {
  const root = new THREE.Group();
  const still = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); still.name = "still"; root.add(still);
  const mover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); mover.name = "mover"; root.add(mover);
  const cam = new THREE.PerspectiveCamera(U.vfovFromFocal(35, 1.85), 1.85, 0.1, 100); cam.name = "shot_cam"; root.add(cam);
  const N = 25, focal = [];
  const tracks = X.sampleNodeTracks([still, mover, cam], N, (f) => {
    mover.position.set(f * 0.1, 0, 0);
    mover.rotation.y = f * 0.2;
    cam.position.set(0, 1.6, 10 - f * 0.2);
    focal[f] = 35 + f;
  });
  assert.ok(!tracks.has(still), "nothing for the still box");
  assert.ok(tracks.get(mover).pos && tracks.get(mover).quat && !tracks.get(mover).scale);
  const clip = X.clipFromTracks("shot", tracks, N, 24);
  near(clip.duration, 1, 1e-9);
  cam.position.set(0, 1.6, 10); mover.position.set(0, 0, 0); mover.rotation.y = 0;
  let glb = await new (await import("../../web/vendor/addons/GLTFExporter.mjs")).GLTFExporter().parseAsync(root, { binary: true, trs: true, animations: [clip] });
  glb = X.addFovAnimation(glb, "shot_cam", focal.map((f) => (U.vfovFromFocal(f, 1.85) * Math.PI) / 180));
  const { json } = X.readGLB(glb);
  assert.ok(json.extensionsUsed.includes("KHR_animation_pointer"));
  const ptr = json.animations[0].channels.find((c) => c.target.path === "pointer");
  assert.match(ptr.target.extensions.KHR_animation_pointer.pointer, /^\/cameras\/0\/perspective\/yfov$/);
  assert.ok(json.nodes.every((n) => !n.matrix), "TRS nodes (animated nodes may not carry a matrix)");
  // Back in through the world importer: the lens animation survives.
  globalThis.fetch = async () => new Response(glb);
  const raw = await W.loadWorldFile("mem://scene.glb", "glb");
  const c2 = raw.scene.getObjectByName("shot_cam");
  assert.ok(c2.userData.yfovTrack, "pointer track read");
  const keys = W.cameraKeys(c2, { frames: N, fps: 24, setTime: (() => { const mx = new THREE.AnimationMixer(raw.scene); raw.animations.forEach((c) => { const a = mx.clipAction(c); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play(); }); return (t) => mx.setTime(t); })(), root: raw.scene, stageAspect: 1.85 }).keys;
  near(keys[0].focal_mm, 35, 0.05, "lens at frame 0");
  near(keys[24].focal_mm, 59, 0.05, "lens at frame 24");
  nearV(keys[24].position, [0, 1.6, 5.2], 1e-3, "camera move");
});

test("GLB read / write round trip keeps chunks 4-byte aligned", () => {
  const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 3 }] };
  const out = X.writeGLB(json, new Uint8Array([1, 2, 3]));
  assert.equal(out.byteLength % 4, 0);
  const back = X.readGLB(out);
  assert.deepEqual(back.json, json);
  assert.deepEqual([...back.bin.slice(0, 3)], [1, 2, 3]);
});

test("OBJ: world-space vertices, normals, a material per colour, mirrored meshes keep their winding", () => {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ name: "red", color: 0xff0000 }));
  m.position.set(5, 1, 0); m.name = "pillar"; root.add(m);
  const mm = m.clone(); mm.scale.x = -1; mm.position.x = -5; mm.name = "mirror"; root.add(mm);
  const o = X.sceneOBJ(root, { name: "set" });
  assert.match(o.obj, /^o pillar$/m);
  assert.match(o.mtl, /newmtl red_0\nKd 1\.0000 0\.0000 0\.0000/);
  assert.equal(o.tris, 24);
  assert.deepEqual(o.bounds, { min: [-5.5, 0, -0.5], max: [5.5, 2, 0.5] });
  const v = o.obj.split("\n").filter((l) => l.startsWith("v ")).map((l) => l.split(" ").slice(1).map(Number));
  assert.ok(v.some((p) => p[0] === 5.5) && v.some((p) => p[0] === -5.5));
});

test("kit README names every app and is honest about what was tested where", () => {
  const r = X.kitReadme({ shot: "Master", fps: 24, frameStart: 1001, frameEnd: 1097, width: 1920, height: 1038, obj: "set_frame1001.obj" });
  for (const app of ["BLENDER", "UNREAL", "MAYA", "NUKE"]) assert.match(r, new RegExp(app));
  assert.match(r, /verified headless in Blender/);
  assert.match(r, /NOT tested in Unreal/);
  assert.match(r, /NOT tested in Maya/);
  assert.match(r, /NOT tested in Nuke/);
});

test("a Nuke / Maya .chan and a camera.json come back in as the same camera keys", () => {
  const track = [0, 1, 2, 3, 4].map((f) => ({ position: [f * 0.5, 1.7, 10 - f], target: [0, 1.2, 0], focal_mm: 35 + f * 5 }));
  const frames = U.cameraFrames(track, 960, 512, 1001);
  for (const text of [U.chanText(frames), JSON.stringify(U.cameraJSON(frames, { width: 960, height: 512, fps: 24, frameStart: 1001 }))]) {
    const { keys, first, roll } = U.keysFromCameraFile(text, { aspect: 960 / 512 });
    assert.equal(first, 1001);
    assert.equal(keys.length, 5);
    near(roll, 0, 1e-3);
    keys.forEach((k, i) => {
      assert.equal(k.frame, i);
      nearV(k.position, track[i].position, 1e-3, "position");
      near(k.focal_mm, track[i].focal_mm, 0.01, "lens (from the .chan vfov / the json focal)");
      const dir = k.target.map((v, j) => v - k.position[j]), want = track[i].target.map((v, j) => v - track[i].position[j]);
      const cos = (dir[0] * want[0] + dir[1] * want[1] + dir[2] * want[2]) / Math.hypot(...dir) / Math.hypot(...want);
      near(cos, 1, 1e-6, "same view direction");
    });
  }
  assert.throws(() => U.keysFromCameraFile("hello"), /no camera frames/);
});
