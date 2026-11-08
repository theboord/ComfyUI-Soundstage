// node --test tests/js/people_m16.test.mjs
// Lifelike people, the findings left open after M1.5 round 3: placeInFrame under steep / top-down cameras and its
// input checks, a coarse obstacle signature (no per-frame rebuilds for bobbing or settling props), stale kit attaches
// cancelled (one clone per person), swimming-off people floating in a pool stay clay, openPhysicsPanel with nothing
// selected, stale skins dropped, outlines that follow card cut-outs, the live-untip offset and the capture notes.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";
import { Highlighter, outlineMaterials } from "../../web/stage/outline.mjs";

/** A stub kit in centimetres like Rocketbox, with a body group and a card group (alpha-tested, mapped). */
function stubKit(model = "Male_Adult_01") {
  const geo = new THREE.BoxGeometry(50, 180, 30); geo.translate(0, 90, 0);
  const n = geo.attributes.position.count;
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(4 * n).fill(0), 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Array(4 * n).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
  geo.clearGroups(); geo.addGroup(0, 24, 0); geo.addGroup(24, 12, 1);
  const body = new THREE.MeshStandardMaterial({ name: "x_body", map: new THREE.Texture() }); body.userData.role = "body";
  const hair = new THREE.MeshStandardMaterial({ name: "x_opacity", map: new THREE.Texture(), alphaTest: 0.5, side: THREE.DoubleSide }); hair.userData.role = "opacity";
  const mesh = new THREE.SkinnedMesh(geo, [body, hair]); mesh.name = "x_hipoly_81_bones";
  const bone = new THREE.Bone(); bone.name = "Bip01";
  const template = new THREE.Group(); template.add(mesh); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  return {
    template, meshName: mesh.name, materials: [body, hair], clips: {}, stature: 180, floor: 0, spec: { model },
    idleBox: new THREE.Box3(new THREE.Vector3(-25, 0, -15), new THREE.Vector3(25, 180, 15)),
    faceless: { neutral: new THREE.MeshStandardMaterial(), hidden: new THREE.MeshBasicMaterial({ visible: false }) },
    report: { missingMaps: [] },
  };
}

function bareStage(actors) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 49, fps: 24 }, actors, shots: [{ id: "s" }], active_shot: "s" };
  st.actorMeshes = new Map();
  st.frame = 0;
  st.setFrames = 0;
  st.setFrame = () => { st.setFrames++; A.avatarsAt(st); };
  st.onChange = () => {}; st.toJSON = () => st.state;
  return st;
}
const person = (id, x = 0, extra = {}) => ({ id, kind: "man", height_m: 1.8, position: [x, 0, 0], keys: [{ frame: 0, position: [x, 0, 0] }], ...extra });
const clayOf = (st, a) => {
  const g = buildObject(a.kind, a.height_m, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })), a.appearance);
  g.position.set(...a.position);
  g.userData.actorId = a.id;
  st.actorMeshes.set(a.id, g);
  return g;
};
function apiStage() {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 49, fps: 24 }, actors: [], shots: [{ id: "s", rig: null }], active_shot: "s" };
  st.actorMeshes = new Map();
  st.frame = 0;
  st.changes = 0;
  st.onChange = () => { st.changes++; };
  st.toJSON = () => st.state;
  st.setFrame = () => {};
  st._buildSet = () => { st.actorMeshes.clear(); for (const a of st.state.actors) st.actorMeshes.set(a.id, new THREE.Group()); };
  st.selected = null;
  st.select = (id) => { st.selected = id; };
  st.activeShot = () => st.state.shots[0];
  return st;
}
const shotCam = (st, position, target, focal_mm = 28) => { st._shotCameraAt = () => ({ position, target, focal_mm }); return st._activeShotCamera(); };

// ---------------------------------------------------------------- 1, 9: placeInFrame
test("placeInFrame: a top-down or steep camera places near distances (ground distance isn't monotonic up the column)", () => {
  const st = apiStage();
  st.state.actors.push({ id: "c", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st._buildSet();
  const cam = shotCam(st, [0, 5, 0], [0, 0, 0.0001]);   // 5 m up, straight down
  for (const d of [0.5, 1, 2]) {
    const r = st.placeInFrame("c", { x: "center", distance_m: d });
    assert.equal(r.ok, true, `${d} m: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(Math.hypot(r.position[0], r.position[2]) - d) < 0.01, `${d} m from the camera along the ground`);
    const v = new THREE.Vector3(...r.position).project(cam);
    assert.ok(Math.abs(v.x) < 1e-3, "on the centre line");
    if (d <= 1) assert.ok(Math.abs(v.y) <= 1, "on screen (2 m is just past the frame edge of a 28 mm lens 5 m up: off screen is allowed)");
  }
  assert.equal(st.placeInFrame("c", { x: "center", y: 0.5 }).ok, true);
  // steep (60 degrees down): near and mid distances both work, too far is still refused with the reach
  shotCam(st, [0, 6, 0], [0, 0, -3.46]);
  assert.equal(st.placeInFrame("c", { x: "center", distance_m: 1.5 }).ok, true);
  assert.equal(st.placeInFrame("c", { x: "center", distance_m: 4 }).ok, true);
  shotCam(st, [0, 5, 0], [0, 0, 0.0001]);   // top-down again: past its column's reach is refused, with the reach
  assert.match(st.placeInFrame("c", { x: "center", distance_m: 500 }).error, /farther than this camera can put it at that x \(at most \d/);
  // a level camera: a point nearer than the bottom of the frame's ground is refused as nearer
  shotCam(st, [0, 1.6, -5], [0, 1.6, 0], 35);
  assert.match(st.placeInFrame("c", { x: "center", distance_m: 0.5 }).error, /nearer than any ground/);
});

test("placeInFrame input checks: numeric strings ok, booleans / arrays refused, mounted or carried refused", () => {
  const st = apiStage();
  st.state.actors.push({ id: "c", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st.state.actors.push({ id: "r", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], mount_id: "h" });
  st.state.actors.push({ id: "k", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], carry_id: "p" });
  st._buildSet();
  const cam = shotCam(st, [0, 1.6, -5], [0, 1.6, 0], 35);
  const r = st.placeInFrame("c", { x: "0.3", distance_m: "4" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs((new THREE.Vector3(...r.position).project(cam).x + 1) / 2 - 0.3) < 2e-3);
  assert.equal(st.placeInFrame("c", { x: " right ", distance_m: 4 }).ok, true);
  for (const x of [true, false, [0.5], "", "far"]) assert.match(st.placeInFrame("c", { x, distance_m: 4 }).error || "", /x must be/, `x ${JSON.stringify(x)}`);
  assert.match(st.placeInFrame("c", { x: 0.5, y: true }).error || "", /y must be/);
  assert.match(st.placeInFrame("r", { x: "left" }).error, /riding 'h'/);
  assert.match(st.placeInFrame("k", { x: "left" }).error, /carried by 'p'/);
});

test("placeInFrame on a raised floor: the ray meets the platform, a prop is keyed at its height; key_y kept for other shots", () => {
  const st = apiStage();
  st.setFx = { id: "platform", floorAt: (x, z) => (z > 0 ? 0.92 : 0) };
  st.state.actors.push({ id: "c", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st.state.actors.push({ id: "p", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st._buildSet();
  const cam = shotCam(st, [0, 1.6, -6], [0, 0.9, 4], 35);
  const r = st.placeInFrame("c", { x: "left", distance_m: 8 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.position[1], 0.92, "on the platform, not buried in it");
  assert.equal(st.state.actors[0].key_y, true);
  const v = new THREE.Vector3(...r.position).project(cam);
  assert.ok(Math.abs((v.x + 1) / 2 - 1 / 3) < 2e-3, `on the third exactly at the platform height: ${(v.x + 1) / 2}`);
  const rp = st.placeInFrame("p", { x: "right", distance_m: 8 });
  assert.equal(rp.position[1], 0, "a person's feet follow the floor themselves (_heightAt)");
  assert.ok(Math.abs((new THREE.Vector3(rp.position[0], 0.92, rp.position[2]).project(cam).x + 1) / 2 - 2 / 3) < 2e-3);
  // back on the stage floor: no raised key left anywhere, so key_y goes
  const r2 = st.placeInFrame("c", { x: "center", distance_m: 3 });
  assert.equal(r2.position[1], 0);
  assert.equal(st.state.actors[0].key_y, undefined);
  // per-shot blocking only: another shot's raised base key keeps key_y
  const t = { id: "t", kind: "crate", key_y: true, position: [0, 0.8, 9], keys: [{ frame: 0, position: [0, 0.8, 9] }, { frame: 48, position: [1, 0.8, 9] }],
    by_shot: { s: { keys: [{ frame: 0, position: [0, 0, -2] }, { frame: 48, position: [1, 0, -2] }] } } };
  st.state.actors.push(t); st._buildSet();
  st.setFx = null;
  assert.equal(st.placeInFrame("t", { x: "center", distance_m: 3 }).ok, true);
  assert.equal(t.key_y, true, "the base keys still stand on the table");
  assert.deepEqual(t.keys.map((k) => k.position[1]), [0.8, 0.8]);
});

test("openPhysicsPanel() with nothing selected is an error and opens nothing", () => {
  const st = apiStage();
  let opened = 0;
  st.physicsPanel = { open() { opened++; }, show() {} };
  assert.deepEqual(st.openPhysicsPanel(), { ok: false, error: "select something" });
  assert.deepEqual(st.openPhysicsPanel(null), { ok: false, error: "select something" });
  assert.equal(opened, 0);
  st.state.actors.push({ id: "b", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st._buildSet();
  st.selected = "b";
  assert.deepEqual(st.openPhysicsPanel(), { ok: true, id: "b" });
  assert.equal(opened, 1);
});

// ---------------------------------------------------------------- 2: the obstacle signature
test("obstacles: jitter sitting on a 5 cm / 1 % boundary doesn't rebuild either (hysteresis, not rounding); a slow creep past 5 cm does, once", () => {
  const walker = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([walker, crate]);
  clayOf(st, walker);
  const cg = clayOf(st, crate);
  let boxes = 0;
  const orig = THREE.Box3.prototype.setFromObject;
  THREE.Box3.prototype.setFromObject = function (...x) { boxes++; return orig.apply(this, x); };
  try {
    // the reviewer's probe: x = 0.025 m (a rounding step boundary at 5 cm), +/- 1 mm every frame
    cg.position.set(0.025, 0, 0); cg.updateMatrixWorld(true);
    st._heightAt(walker, 0); st._obstacles();
    boxes = 0;
    let rebuilt = 0, last = st._obstacles();
    for (let f = 0; f < 48; f++) {
      cg.position.x = 0.025 + (f % 2 ? 0.001 : -0.001);
      cg.position.y = 0.025 + (f % 2 ? -0.001 : 0.001);
      cg.scale.setScalar(1.005 + (f % 2 ? 0.0002 : -0.0002));                 // 1 % step boundary at 1.005
      cg.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2 * Math.asin(0.005) + (f % 2 ? 1e-4 : -1e-4));   // q.y on 0.005
      cg.updateMatrixWorld(true);
      st.frame = f; st._heightAt(walker, f);
      const l = st._obstacles(); if (l !== last) rebuilt++; last = l;
    }
    assert.equal(rebuilt, 0, `rebuilds for boundary jitter: ${rebuilt} of 48`);
    assert.equal(boxes, 0);
    // a slow creep (1 mm a frame): one rebuild once it is past 5 cm from where the tables were built, not 48
    rebuilt = 0;
    for (let f = 0; f < 80; f++) {
      cg.position.x = 0.025 + 0.001 * f; cg.updateMatrixWorld(true);
      const l = st._obstacles(); if (l !== last) rebuilt++; last = l;
    }
    assert.equal(rebuilt, 1, `rebuilds over an 8 cm creep: ${rebuilt}`);
    // q and -q are the same rotation: flipping the sign is not a move
    const q = cg.quaternion.clone(); cg.quaternion.set(-q.x, -q.y, -q.z, -q.w); cg.updateMatrixWorld(true);
    assert.equal(st._obstacles(), last, "a sign-flipped quaternion is the same transform");
  } finally { THREE.Box3.prototype.setFromObject = orig; }
});

test("obstacles: a bobbing pool prop, a settling or jittering prop don't rebuild the height tables every frame; a real move does", () => {
  const walker = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([walker, crate]);
  clayOf(st, walker);
  const cg = clayOf(st, crate); cg.updateMatrixWorld(true);
  let boxes = 0;
  const orig = THREE.Box3.prototype.setFromObject;
  THREE.Box3.prototype.setFromObject = function (...x) { boxes++; return orig.apply(this, x); };
  try {
    st._heightAt(walker, 0);
    const list0 = st._obstacles(), table0 = st._yCache.get(walker);
    boxes = 0;
    // jitter under 2 cm and a sub-degree wobble, frame after frame
    for (let f = 0; f < 48; f++) {
      cg.position.x = 0.004 * Math.sin(f); cg.position.y = 0.003 * Math.cos(f); cg.rotation.y = 0.002 * Math.sin(f);
      cg.updateMatrixWorld(true);
      st.frame = f; st._heightAt(walker, f); st._jumpsInShot(walker);
    }
    assert.equal(boxes, 0, "no rebuild for jitter");
    assert.equal(st._obstacles(), list0);
    assert.equal(st._yCache.get(walker), table0, "the same height table");
    // floating in the pool: bobbing 6 cm and rocking every frame (_waterPhysics marks it inWater)
    cg.userData.inWater = true;
    st._obstacles(); boxes = 0;
    const list1 = st._obstacles();
    for (let f = 0; f < 48; f++) {
      cg.position.y = 0.06 * Math.sin(f / 3); cg.rotation.x = 0.035 * Math.sin(f / 2.7); cg.updateMatrixWorld(true);
      st.frame = f; st._heightAt(walker, f); st._jumpsInShot(walker);
    }
    assert.equal(boxes, 0, "no rebuild per bob");
    assert.equal(st._obstacles(), list1);
    // out of the water and moved by 30 cm (a drag): refreshed
    cg.userData.inWater = false; st._obstacles();
    cg.position.set(0, 0, 0.3); cg.rotation.set(0, 0, 0); cg.updateMatrixWorld(true);
    const before = st._obstacles();
    cg.position.z = 2; cg.updateMatrixWorld(true);
    assert.notEqual(st._obstacles(), before, "a real move refreshes the list");
    // a baked fall settling: a handful of rebuilds over the fall, not one per frame
    let n = 0, last = st._obstacles();
    for (let f = 0; f < 48; f++) {
      cg.position.y = Math.max(0, 1 - 0.5 * 9.8 * (f / 24) ** 2); cg.updateMatrixWorld(true);
      const l = st._obstacles(); if (l !== last) n++; last = l;
    }
    assert.ok(n > 0 && n <= 21, `rebuilds over a 1 m fall: ${n}`);
  } finally { THREE.Box3.prototype.setFromObject = orig; }
});

// ---------------------------------------------------------------- 3: stale attaches
test("upgradeHuman: rebuilds and a model change while the kit loads give one clone per person, on the latest group", async () => {
  const people = Array.from({ length: 4 }, (_, i) => person(`p${i}`, i));
  const st = bareStage(people);
  const pending = new Map();
  const loads = [];
  st._loadKit = (spec) => {
    loads.push(spec.model);
    if (!pending.has(spec.model)) { let res; const p = new Promise((r) => { res = r; }); p.res = res; pending.set(spec.model, p); }
    return pending.get(spec.model);
  };
  const rebuild = () => { st.actorMeshes.clear(); for (const a of people) A.upgradeHuman(st, a, clayOf(st, a)); };
  rebuild();
  for (let n = 0; n < 5; n++) rebuild();   // five rebuilds while the first load is still on its way
  people[1].kind = "woman"; rebuild();     // and a man-to-woman change mid-load
  let clones = 0;
  const kitM = stubKit("Male_Adult_01"), kitW = stubKit("Female_Adult_01");
  // count clones by watching _avatarSkins writes (bindSkin sets one per attached skin)
  const seen = [];
  const skinsSet = Map.prototype.set;
  st._avatarSkins = new Map();
  st._avatarSkins.set = function (k, v) { clones++; seen.push(k); return skinsSet.call(this, k, v); };
  pending.get("Male_Adult_01").res(Object.assign(kitM, { spec: C.ROCKETBOX.man }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(clones, 3, `one clone for each man, not one per rebuild: ${seen}`);
  for (const a of people.filter((x) => x.kind === "man")) {
    const g = st.actorMeshes.get(a.id);
    assert.equal(g.userData.humanSkin?.g, g, `${a.id}: bound to the latest clay group`);
  }
  assert.equal(st.actorMeshes.get("p1").userData.humanSkin, undefined, "the stale man's kit never lands on the woman");
  pending.get("Female_Adult_01")?.res(Object.assign(kitW, { spec: C.ROCKETBOX.woman }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(clones, 4);
  assert.equal(st.actorMeshes.get("p1").userData.humanSkin.kit, kitW);
  assert.equal(st._avatarSkins.get("p1").kit, kitW, "the stage's list holds the current skin");
});

test("attachKit refuses a kit whose model the person no longer wants, or a person no longer in the scene", () => {
  const a = person("p1");
  const st = bareStage([a]);
  const g = clayOf(st, a);
  a.kind = "woman";
  assert.equal(A.attachKit(st, a, g, stubKit("Male_Adult_01")), null);
  st.state.actors = [];
  a.kind = "man";
  assert.equal(A.attachKit(st, a, g, stubKit("Male_Adult_01")), null);
  st.state.actors = [a];
  assert.ok(A.attachKit(st, a, g, stubKit("Male_Adult_01")));
});

// ---------------------------------------------------------------- 6: stale skins
test("a person deleted and another added in one build: the old skin is dropped (no leak); a kind change too", async () => {
  const a = person("p1"), b = person("p2", 1);
  const st = bareStage([a, b]);
  A.attachKit(st, a, clayOf(st, a), stubKit());
  const sb = A.attachKit(st, b, clayOf(st, b), stubKit());
  await null;
  assert.equal(st._avatarSkins.size, 2);
  // delete p1, add p3 (same count), one build
  const c = person("p3", 2);
  st.state.actors = [b, c];
  st.actorMeshes.clear();
  for (const x of st.state.actors) { const g = clayOf(st, x); A.reuseSkin(st, x, g, C.avatarSpecFor(x)); }
  A.avatarsAt(st);
  assert.deepEqual([...st._avatarSkins.keys()], ["p2"], "p1's skin dropped although the count is the same");
  assert.equal(st._avatarSkins.get("p2"), sb, "p2 kept its skin");
  // p2 becomes a crate: its skin goes too
  b.kind = "crate";
  st.actorMeshes.clear(); for (const x of st.state.actors) clayOf(st, x);
  A.avatarsAt(st);
  assert.equal(st._avatarSkins.size, 0);
  assert.equal(sb.holder.parent, null);
});

// ---------------------------------------------------------------- 4: floating in a pool with swimming off
test("swimming off in a pool: the clay floats at the waterline, so the person stays clay for the shot ('floats in the water')", async () => {
  const a = person("p1", 0, { swim: "off", keys: [{ frame: 0, position: [-6, 0, 0] }, { frame: 48, position: [0, 0, 0] }] });
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const skin = A.attachKit(st, a, g, stubKit());
  await null;
  st.water = { position: new THREE.Vector3(0, 1.2, 0), geometry: { parameters: { width: 4, height: 4 } } };
  st.frame = 0; A.avatarsAt(st);   // still on dry ground at frame 0, but the shot ends in the pool
  assert.equal(skin.shown, false);
  assert.equal(skin.reason, "floats in the water");
  st.water.position.y = 0.1;   // the beach's sea surface: no floating
  A.avatarsAt(st);
  assert.equal(skin.shown, true);
  st.water.position.y = 1.2;
  a.keys = [{ frame: 0, position: [-6, 0, 0] }, { frame: 48, position: [-4, 0, 0] }];   // never reaches the pool
  A.avatarsAt(st);
  assert.equal(skin.shown, true);
  assert.equal(C.clayReason(a, { floats: true }), "floats in the water");
  assert.equal(C.clayReason(a, { swims: true, floats: true }), "swims");
});

// ---------------------------------------------------------------- 8: outlines follow the cards
test("selection outline proxies of a lifelike person keep the card cut-out per geometry group and hide hidden groups", async () => {
  const a = person("p1");
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const kit = stubKit();
  const skin = A.attachKit(st, a, g, kit);
  await null;
  A.avatarsAt(st);
  assert.equal(skin.shown, true);
  const base = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(1, 1, 0) }, uOpacity: { value: 1 }, uPx: { value: 2 }, uRes: { value: new THREE.Vector2(1, 1) } } });
  const ms = outlineMaterials(skin.mesh, base);
  assert.equal(ms.length, 2);
  assert.equal(ms[0], base, "body group: solid");
  assert.equal(ms[1].defines.CUT, "", "hair card group: the cut-out variant");
  assert.equal(ms[1].uniforms.uMap.value, kit.materials[1].map);
  assert.equal(ms[1].uniforms.uAlphaTest.value, 0.5);
  assert.equal(ms[1].uniforms.uRes, base.uniforms.uRes, "shares the resolution uniform (updated per render)");
  assert.equal(outlineMaterials(skin.mesh, base)[1], ms[1], "cached");
  A.applyFace(skin, true);
  skin.mesh.material = [kit.materials[0], kit.faceless.hidden];
  assert.equal(outlineMaterials(skin.mesh, base)[1].visible, false, "a hidden group stays hidden");
  // the Highlighter builds its proxies with these and rebuilds when Faceless swaps the materials
  st.actorMeshes.set("p1", g);
  const h = new Highlighter(st);
  const s1 = h._sync("sel", "p1", "sel");
  const prox = s1.mask.pairs.find(([o]) => o === skin.mesh)[1];
  assert.ok(Array.isArray(prox.material) && prox.material[1].visible === false);
  skin.mesh.material = kit.materials.slice();
  const s2 = h._sync("sel", "p1", "sel");
  assert.notEqual(s2, s1, "rebuilt after the material change");
  const prox2 = s2.hull.pairs.find(([o]) => o === skin.mesh)[1];
  assert.equal(prox2.material[1].defines.CUT, "");
  // clay meshes (not avatars) still draw solid with one material
  const clay = s2.mask.pairs.find(([o]) => !o.userData.avatar);
  if (clay) assert.ok(!Array.isArray(clay[1].material));
});

// ---------------------------------------------------------------- 11: live untip offset, capture note
test("live untip: the body stands where the live clay group is for that tick, not at the key", async () => {
  const a = person("p1", 0);
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const skin = A.attachKit(st, a, g, stubKit());
  await null;
  A.avatarsAt(st);
  A.markLiveTilt(st, g, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 4)));
  g.position.set(2, 0, 1.5);   // the physics drag has it here right now; its key is still at the origin
  g.quaternion.identity();
  assert.equal(A.markLiveTilt(st, g, g.quaternion), true);
  assert.equal(skin.shown, true);
  g.updateMatrixWorld(true);
  const w = skin.holder.getWorldPosition(new THREE.Vector3());
  assert.ok(w.distanceTo(new THREE.Vector3(2, 0, 1.5)) < 1e-6, `body at the live clay: ${w.toArray()}`);
});
