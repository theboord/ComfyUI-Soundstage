// node --test tests/js/avatars_m15.test.mjs
// Lifelike people, fixes from the M1 review (M1.5): hair / lash cards in every pass, the underwater Depth shader, the
// shader includes resolved, jumps, the physics lift, live tilts, faceless in the Pose pass, capture waits and retries,
// skins kept across rebuilds; and the Stage API for tools (duplicate, placeInFrame, setRig, openPhysicsPanel).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import * as O from "../../web/stage/people/onemotion.mjs";
import * as CUT from "../../web/stage/people/cutout.mjs";
import { DEPTH_SHADER, depthPassMaterial } from "../../web/stage/depthshader.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";

const RB = fileURLToPath(new URL("../../web/stage/people/rocketbox/", import.meta.url));
const installed = existsSync(`${RB}Female_Adult_01.fbx`) && existsSync(`${RB}anim/f_walk_neutral_01.max.fbx`);
const NOT_INSTALLED = !installed && "Rocketbox files not installed (web/stage/people/rocketbox/)";

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

/** A bare Stage (no renderer) with people; setFrame counts and runs the avatar hook like the real one. */
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
  g.userData.actorId = a.id;   // as stage._buildSet tags it
  st.actorMeshes.set(a.id, g);
  return g;
};

// ---------------------------------------------------------------- 1: hair / lash cards in the override passes
test("cards keep their cut-out: Depth, Clay and Wire override versions carry the card's map + alphaTest and skip the override", () => {
  const card = new THREE.MeshStandardMaterial({ name: "f_opacity", map: new THREE.Texture(), alphaTest: 0.5, side: THREE.DoubleSide });
  const depth = depthPassMaterial(1, 40);
  const d = CUT.passCutout(card, depth);
  assert.equal(d.allowOverride, false, "the renderer draws it instead of the override");
  assert.ok("CUTOUT" in d.defines);
  assert.equal(d.uniforms.uMap.value, card.map);
  assert.equal(d.uniforms.uAlphaTest.value, 0.5);
  assert.equal(d.uniforms.uNear, depth.uniforms.uNear, "same near / far uniforms as the pass");
  assert.equal(d.side, THREE.DoubleSide);
  assert.equal(CUT.passCutout(card, depth), d, "cached per card and pass");
  const clay = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 });
  const wire = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true });
  for (const [ov, what] of [[clay, "clay"], [wire, "wire"]]) {
    const m = CUT.passCutout(card, ov);
    assert.equal(m.allowOverride, false, what);
    assert.equal(m.map, card.map, what);
    assert.equal(m.alphaTest, 0.5, what);
    assert.equal(m.color.getHex(), ov.color.getHex(), `${what}: the pass's colour, not the hair's`);
    const sh = { fragmentShader: "a\n#include <map_fragment>\nb" };
    m.onBeforeCompile(sh);
    assert.ok(!sh.fragmentShader.includes("<map_fragment>") && /diffuseColor\.a \*= texture2D\( map, vMapUv \)\.a/.test(sh.fragmentShader), `${what}: only the map's alpha`);
  }
  assert.equal(CUT.passCutout(card, wire).wireframe, true);
  // the vendored renderer really honours allowOverride (WebGLRenderer renderObjects)
  const src = readFileSync(fileURLToPath(new URL("../../web/vendor/three.module.min.mjs", import.meta.url)), "utf8");
  assert.match(src, /!0===\w\.allowOverride&&null!==\w&&\(\w=\w\)/);
});

test("swapAvatarCutouts swaps only the card groups of shown people for the pass, and puts everything back", async () => {
  const a = person("p1");
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const skin = A.attachKit(st, a, g, stubKit());
  await null;
  assert.equal(skin.shown, true);
  const own = skin.mesh.material;
  const depth = depthPassMaterial(1, 40);
  const back = CUT.swapAvatarCutouts(st, depth);
  assert.equal(skin.mesh.material[0], own[0], "the body keeps taking the override");
  assert.ok(skin.mesh.material[1].allowOverride === false && skin.mesh.material[1].uniforms.uMap.value === own[1].map);
  back();
  assert.equal(skin.mesh.material, own);
  // a person not on show (the clay measure, _withClayShape): nothing swapped; Blocking look no longer hides anyone
  A.setShown(skin, false);
  CUT.swapAvatarCutouts(st, depth);
  assert.equal(skin.mesh.material, own);
  st.state.people_look = "blocking"; A.avatarsAt(st);
  assert.equal(skin.shown, true, "never clay");
});

test("ID pass: a card keeps its cut-out in the flat colour; a hidden (faceless) group stays hidden", () => {
  const card = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.5 });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const body = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const col = new THREE.Color(1, 0, 0);
  const [b, c, h] = CUT.idMaterial([body, card, hidden], col);
  assert.equal(b.map, null); assert.equal(b.alphaTest, 0); assert.equal(b.color.getHex(), 0xff0000);
  assert.equal(c.map, card.map); assert.equal(c.alphaTest, 0.5); assert.equal(c.color.getHex(), 0xff0000);
  assert.equal(h, hidden);
  assert.equal(CUT.idMaterial(body, col).map, null, "a single material: flat");
});

test("real Rocketbox: the card materials have a map + alphaTest, the woman's lashes are split off, and every pass keeps the cut-out", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  assert.equal(K.woman.report.lashTriangles, 208, "the woman's lashes");
  assert.equal(K.man.report.lashTriangles, 0, "the man's atlas is all hair");
  const ovs = [depthPassMaterial(1, 40), new THREE.MeshStandardMaterial({ color: 0x9a9a9a }), new THREE.MeshBasicMaterial({ wireframe: true })];
  for (const kind of ["man", "woman"]) {
    const kit = K[kind];
    const cards = kit.materials.filter(CUT.isCutout);
    assert.deepEqual(cards.map((m) => m.userData.role).sort(), kind === "woman" ? ["lashes", "opacity"] : ["opacity"]);
    for (const m of cards) assert.ok(m.map && m.alphaTest > 0, `${kind} ${m.name}`);
    const a = { ...person("p1"), kind };
    const st = bareStage([a]);
    const skin = A.attachKit(st, a, clayOf(st, a), kit);
    await null;
    assert.equal(skin.shown, true);
    for (const ov of ovs) {
      const back = CUT.swapAvatarCutouts(st, ov);
      const now = skin.mesh.material;
      kit.materials.forEach((m, i) => {
        if (!CUT.isCutout(m)) { assert.equal(now[i], m); return; }
        assert.equal(now[i].allowOverride, false);
        assert.equal(ov.isShaderMaterial ? now[i].uniforms.uMap.value : now[i].map, m.map, `${kind} ${m.name} under ${ov.type}`);
      });
      back();
    }
    const ids = CUT.idMaterial(skin.mesh.material, new THREE.Color(0, 1, 0));
    kit.materials.forEach((m, i) => assert.equal(!!ids[i].map, CUT.isCutout(m)));
    // faceless: the hair still a card, the lashes hidden in the ID pass too
    A.applyFace(skin, true);
    const idsF = CUT.idMaterial(skin.mesh.material, new THREE.Color(0, 1, 0));
    skin.mesh.material.forEach((m, i) => {
      if (m.userData.role === "lashes") assert.fail("lashes should be swapped out");
      if (m.name === "faceless_hidden") assert.equal(idsF[i].visible, false);
      if (m.userData.role === "opacity") assert.ok(idsF[i].map && idsF[i].alphaTest > 0, "hair kept, as a cut-out");
    });
  }
});

// ---------------------------------------------------------------- 2 + 11: the Depth shaders
/** A small GLSL preprocessor (#include via three's ShaderChunk, #ifdef / #ifndef / #if defined / #elif / #else /
 *  #endif, #define) so the Depth shader can be expanded as WebGLProgram would, without a GL context. */
function expand(src, defines) {
  const D = new Set(defines);
  const inc = (s) => s.replace(/^[ \t]*#include +<([\w]+)>/gm, (_, n) => {
    if (!(n in THREE.ShaderChunk)) throw new Error(`unresolved #include <${n}>`);
    return inc(THREE.ShaderChunk[n]);
  });
  const evalIf = (e) => {
    const js = e.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (D.has(n) ? "1" : "0")).replace(/defined\s+(\w+)/g, (_, n) => (D.has(n) ? "1" : "0"))
      .replace(/[A-Za-z_]\w*/g, "0");
    if (!/^[\d\s()|&!<>=+\-*/]*$/.test(js)) throw new Error(`can't evaluate #if ${e}`);
    return !!Function(`return (${js});`)();
  };
  const out = [], stack = [];
  for (const line of inc(src).split("\n")) {
    const t = line.trim(), on = stack.every((s) => s.on);
    let m;
    if ((m = /^#ifdef\s+(\w+)/.exec(t))) stack.push({ on: D.has(m[1]), done: D.has(m[1]) });
    else if ((m = /^#ifndef\s+(\w+)/.exec(t))) stack.push({ on: !D.has(m[1]), done: !D.has(m[1]) });
    else if ((m = /^#if\s+(.*)/.exec(t))) { const v = evalIf(m[1]); stack.push({ on: v, done: v }); }
    else if ((m = /^#elif\s+(.*)/.exec(t))) { const s = stack.at(-1); const v = !s.done && evalIf(m[1]); s.on = v; s.done ||= v; }
    else if (/^#else/.test(t)) { const s = stack.at(-1); s.on = !s.done; s.done = true; }
    else if (/^#endif/.test(t)) stack.pop();
    else if ((m = /^#define\s+(\w+)/.exec(t))) { if (on) D.add(m[1]); }
    else if (on) out.push(line);
  }
  assert.equal(stack.length, 0, "every #if closed");
  return out.join("\n");
}
const declared = (src, name) => new RegExp(`\\b(?:mat4|vec[234]|float|int|uniform\\s+\\w+|attribute\\s+\\w+|varying\\s+\\w+)\\s+${name}\\b`).test(src);

test("the Depth shader builds: every include resolves through three's ShaderChunk, skinned and not, cut-out and not", () => {
  // what WebGLProgram puts in front of a ShaderMaterial (the attributes and matrices it declares)
  const prefix = "uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; attribute vec3 position; attribute vec2 uv; attribute vec4 skinIndex; attribute vec4 skinWeight;";
  for (const defs of [[], ["USE_SKINNING"], ["CUTOUT"], ["USE_SKINNING", "CUTOUT"]]) {
    const v = prefix + "\n" + expand(DEPTH_SHADER.vertex, defs), f = expand(DEPTH_SHADER.fragment, defs);
    assert.ok(!/#include/.test(v + f), "no include left");
    assert.equal((v.match(/{/g) || []).length, (v.match(/}/g) || []).length, `balanced braces ${defs}`);
    assert.ok(declared(v, "transformed"), "begin_vertex declares transformed");
    assert.ok(v.indexOf("vec3 transformed") < v.indexOf("modelViewMatrix * vec4(transformed"), "declared before use");
    if (defs.includes("USE_SKINNING")) {
      for (const n of ["boneMatX", "boneMatY", "boneMatZ", "boneMatW"]) assert.ok(declared(v, n), `${n} declared`);
      assert.ok(declared(v, "bindMatrix") && declared(v, "bindMatrixInverse"), "skinning uniforms");
      assert.match(v, /getBoneMatrix/);
      assert.match(v, /transformed = \( bindMatrixInverse \* skinned \)\.xyz/, "the skinned position is what gets projected");
    } else assert.ok(!/boneMat/.test(v), "unskinned meshes compile without the bone code");
    if (defs.includes("CUTOUT")) {
      assert.ok(declared(f, "uMap") && declared(f, "uAlphaTest") && /discard/.test(f));
      assert.ok(declared(v, "vCutUv") && /vCutUv = uv/.test(v));
    } else assert.ok(!/discard|uMap/.test(f) && !/vCutUv/.test(v));
  }
});

test("the underwater set's own Depth material skins too (the stage's shader, near 1 m / far 22 m)", async () => {
  const { underwaterDepth } = await import("../../web/stage/sets/underwater.mjs");
  const m = underwaterDepth();
  assert.equal(m.vertexShader, DEPTH_SHADER.vertex);
  assert.equal(m.fragmentShader, DEPTH_SHADER.fragment);
  for (const chunk of ["#include <skinning_pars_vertex>", "#include <skinbase_vertex>", "#include <skinning_vertex>"]) assert.ok(m.vertexShader.includes(chunk));
  assert.equal(m.uniforms.uNear.value, 1.0);
  assert.equal(m.uniforms.uFar.value, 22);
  assert.equal(m.userData.depthPass, true, "cards under it get the cut-out version");
  const card = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaTest: 0.5 });
  assert.equal(CUT.passCutout(card, m).uniforms.uFar, m.uniforms.uFar);
  // and the set really puts it on for Depth
  const { buildUnderwater } = await import("../../web/stage/sets/underwater.mjs");
  const set = buildUnderwater();
  const stage = { scene: { overrideMaterial: null }, renderer: { domElement: { height: 512 } } };
  set.fx.pass("depth", { stage, cam: { position: { y: -2 }, fov: 40 } });
  assert.equal(stage.scene.overrideMaterial, m);
});

// ---------------------------------------------------------------- 3: jumps
test("a person who hops onto a crate or vaults stays lifelike: the rig owns the airborne frames (eased in and out inside them), the clip the ground", async () => {
  const walker = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([walker, crate]);
  const g = clayOf(st, walker);
  const cg = clayOf(st, crate); cg.updateMatrixWorld(true);
  assert.equal(st._jumpsInShot(walker), true, "walks over the crate: up and down in arcs");
  const air = [...Array(49).keys()].filter((f) => st._airborne(walker, f));
  assert.ok(air.length > 0 && air.length < 40 && !air.includes(0) && !air.includes(48), `airborne only for some frames: ${air}`);
  const skin = A.attachKit(st, walker, g, stubKit());
  await null;
  let sawRig = 0, sawClip = 0;
  for (let f = 0; f <= 48; f++) {
    st.frame = f; A.avatarsAt(st);
    const up = air.includes(f);
    assert.equal(skin.shown, true, `frame ${f}: lifelike, never clay`);
    assert.equal(skin.reason, null);
    // every airborne frame has some rig in it, eased in and out INSIDE the airborne frames (L1 round 2: the rig's own
    // pose jumps on its first frame, so the handover never blends toward it before it owns the frame); every ground
    // frame is the clip at full weight
    if (up) { sawRig++; assert.ok(skin.rigWeight > 0, `frame ${f}: rig weight ${skin.rigWeight}`); if (!air.includes(f - 1)) assert.ok(skin.rigWeight < 0.1, `frame ${f}: take-off, eased in`); assert.equal(skin.ownerReason, "is in the air (a jump or vault)"); }
    else { sawClip++; assert.equal(skin.rigWeight, 0, `frame ${f}: the clip on the ground`); }
  }
  assert.ok(sawRig && sawClip);
  // the ground frames either side of the crate are lifelike: before the take-off and after the landing
  assert.ok(!air.includes(Math.min(...air) - 1) && !air.includes(Math.max(...air) + 1));
  // without the crate: a plain walk shows the avatar on every frame
  st.state.actors = [walker]; st.actorMeshes.delete("c1");
  assert.equal(st._jumpsInShot(walker), false);
  for (const f of [0, 20, 24, 30, 48]) { st.frame = f; A.avatarsAt(st); assert.equal(skin.shown, true, `frame ${f} (reason ${skin.reason})`); }
  assert.equal(O.rigReasonAt(O.rigShotReason(walker, {}), { airborne: true }), "is in the air (a jump or vault)");
  assert.equal(O.rigReasonAt(O.rigShotReason(walker, { jumps: true }), {}), null, "no whole-shot jump rule any more");
});

test("raised floors: a 0.8 m crate on a 0.92 m station platform is climbed (the cut-off is measured from the local floor)", () => {
  const walker = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0.92, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([walker, crate]);
  st.setFx = { id: "platform", floorAt: () => 0.92 };
  const noSet = []; st._setCollidersCached = () => noSet;   // no set boxes of its own here
  clayOf(st, walker);
  const cg = clayOf(st, crate);
  const h0 = new THREE.Box3().setFromObject(cg).max.y;
  cg.scale.setScalar(0.8 / h0); cg.position.y = 0.92;   // a 0.8 m crate standing on the platform: top at 1.72 m
  cg.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(cg).max.y;
  assert.ok(Math.abs(top - 1.72) < 1e-6, `top ${top}`);
  const o = st._obstacles().find((x) => x.id === "c1");
  assert.ok(Math.abs(o.rise - 0.8) < 1e-6, `rise above the platform: ${o.rise}`);
  assert.ok(Math.abs(st._heightAt(walker, 24) - 1.72) < 1e-3, `stands on the crate top mid-way: ${st._heightAt(walker, 24)}`);
  assert.equal(st._jumpsInShot(walker), true, "hops up and down");
  assert.ok(st._supportShapes().some((sh) => sh.id === "c1"), "stood on (foot support)");
  assert.ok(Math.abs(st._supportAt(0, 0, 1.6) - 1.72) < 1e-3, "the foot ray finds the crate top (from the hop's height)");
  // the same crate 2 m tall above the platform is a wall: walked into, not climbed
  cg.scale.multiplyScalar(2 / 0.8); cg.updateMatrixWorld(true);
  assert.ok(st._obstacles().find((x) => x.id === "c1").rise > 1.75);
  assert.ok(Math.abs(st._heightAt(walker, 24) - 0.92) < 1e-3, "stays on the platform floor");
  assert.equal(st._jumpsInShot(walker), false);
  assert.ok(!st._supportShapes().some((sh) => sh.id === "c1"));
  // and on the plain stage floor the 0.8 m crate still is climbed
  cg.scale.multiplyScalar(0.8 / 2); cg.position.y = 0; st.setFx = null; walker.position[1] = 0; cg.updateMatrixWorld(true);
  assert.ok(Math.abs(st._heightAt(walker, 24) - 0.8) < 1e-3, `${st._heightAt(walker, 24)}`);
});

test("the height and jump tables follow the shot's fps and any obstacle move or edit (no hand-clearing of caches)", () => {
  const walker = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([walker, crate]);
  clayOf(st, walker);
  const cg = clayOf(st, crate); cg.updateMatrixWorld(true);
  const airCount = () => [...Array(49).keys()].filter((f) => st._airborneAt(walker, f)).length;
  const table = () => [...Array(49).keys()].map((f) => st._heightAt(walker, f));
  const at24 = airCount(), y24 = table();
  assert.ok(at24 > 0);
  // fps: gravity per frame changes, so the arcs do (60 fps: more frames in the air for the same metres per frame...)
  st.state.shot.fps = 60;
  const y60 = table();
  assert.notDeepEqual(y60, y24, "_heightAt sees the fps change");
  assert.notEqual(airCount(), at24, "the cheap _jumpsInShot / _airborneAt signature sees it too");
  st.state.shot.fps = 24;
  assert.deepEqual(table(), y24);
  assert.equal(airCount(), at24);
  // moving the crate's group (a console edit or a drag) out of the path: both tables see it, nothing cleared by hand
  cg.position.z = 5; cg.updateMatrixWorld(true);
  assert.equal(airCount(), 0, "the jump table sees the moved crate");
  assert.ok(table().every((y) => y === 0), "the height table sees it");
  cg.position.z = 0; cg.updateMatrixWorld(true);
  assert.equal(airCount(), at24);
  // editing the crate's keys (moved in the scene data) and rebuilding its group there
  crate.keys[0].position = [0, 0, 6]; crate.position = [0, 0, 6];
  st.actorMeshes.delete("c1"); clayOf(st, crate).updateMatrixWorld(true);
  assert.equal(airCount(), 0);
  // editing its size (a smaller crate is a lower hop)
  crate.keys[0].position = [0, 0, 0]; crate.position = [0, 0, 0];
  st.actorMeshes.delete("c1"); const c2 = clayOf(st, crate); c2.updateMatrixWorld(true);
  const full = Math.max(...table());
  c2.scale.setScalar(0.5); c2.updateMatrixWorld(true);
  assert.ok(Math.max(...table()) < full - 0.1, "a scaled crate gives a lower stand-on height");
});

// ---------------------------------------------------------------- 7: lift and live tilt
test("the physics lift moves the avatar with the clay; a live tilt shows the clay until it is saved", async () => {
  const a = person("p1", 1);
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const skin = A.attachKit(st, a, g, stubKit());
  await null;
  const footY = () => { g.updateMatrixWorld(true); return skin.holder.getWorldPosition(new THREE.Vector3()).y; };
  assert.ok(Math.abs(footY()) < 1e-6);
  a.physics = { mode: "static", lift: 0.5 };
  A.avatarsAt(st);
  assert.ok(Math.abs(footY() - 0.5) < 1e-6, `lifted with the clay: soles at ${footY().toFixed(3)} m`);
  g.position.y += 0.5;   // what stage.setFrame does to the clay (stage.mjs: g.position.y += a.physics.lift)
  A.avatarsAt(st);
  assert.ok(Math.abs(footY() - 0.5) < 1e-6, "the clay group's own lift doesn't add twice");
  a.physics.baked = true; g.position.y = 0;   // baked: no lift any more (its keys say where it is); baked = clay anyway
  assert.equal(A.physicsLift(a), 0);
  delete a.physics;
  A.avatarsAt(st);
  assert.equal(skin.shown, true);
  // a live knock-over (live.mjs puts the physics pose on the group and calls markLiveTilt): 30 degrees, not saved yet
  g.quaternion.setFromEuler(new THREE.Euler(0, 0, Math.PI / 6));
  assert.equal(A.markLiveTilt(st, g, g.quaternion), true);
  assert.equal(skin.shown, true, "never clay: the rig owns the tipped body");
  assert.equal(skin.ownerReason, "is tipped over");
  assert.equal(skin.rigWeight, 1, "at once (a live drag, not a recorded take)");
  g.quaternion.identity(); A.avatarsAt(st);   // the next setFrame stands the group up: still tipped (the flag)
  assert.equal(skin.ownerReason, "is tipped over");
  // the group's own rotation alone (gait lean, a heading) never counts
  g.userData.liveTipped = false;
  g.quaternion.setFromEuler(new THREE.Euler(0.3, 1.2, -0.38));
  A.avatarsAt(st);
  assert.equal(skin.shown, true);
  assert.equal(skin.rigWeight, 0);
  // physics stands it up again: the clip again at once
  A.markLiveTilt(st, g, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 6)));
  assert.equal(A.markLiveTilt(st, g, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.2, 0))), true);
  assert.equal(skin.shown, true);
});

// ---------------------------------------------------------------- 4: faceless in the Pose pass
test("Pose pass: a faceless person has no face landmarks, eyes or ears; the nose and neck stay (clay and lifelike)", async () => {
  const { personKeypoints, toPixels, stagePeople } = await import("../../web/stage/posepass.mjs");
  const a = person("p1", 0);
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  cam.position.set(0, 1.4, 5); cam.lookAt(0, 1.2, 0); cam.updateMatrixWorld(true);
  Object.assign(st, { camera: cam, _syncShotCamera: () => {} });
  const shown = stagePeople(st, 640, 360)[0];
  assert.equal(shown.face.length, 68);
  assert.ok(shown.body.every(Boolean));
  a.face = "faceless";
  const fl = stagePeople(st, 640, 360)[0];
  assert.equal(fl.face, null, "no face landmarks");
  assert.deepEqual([14, 15, 16, 17].map((i) => fl.body[i]), [null, null, null, null], "no eyes or ears");
  assert.ok(fl.body[0] && fl.body[1], "the head (nose) and neck stay");
  assert.ok(fl.body.slice(2, 14).every(Boolean), "the rest of the body is untouched");
  const kp = personKeypoints(g, cam.position); kp.faceless = true;
  assert.equal(toPixels(kp, cam, 640, 360).face, null);
});

test("real Rocketbox: the Pose pass of a faceless lifelike person drops the face too", { skip: NOT_INSTALLED }, async () => {
  const K = await realKits();
  const { personKeypoints, toPixels } = await import("../../web/stage/posepass.mjs");
  const a = person("p1", 0);
  const st = bareStage([a]);
  const skin = A.attachKit(st, a, clayOf(st, a), K.man);
  await null;
  assert.equal(skin.shown, true);
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
  cam.position.set(0, 1.4, 5); cam.lookAt(0, 1.2, 0); cam.updateMatrixWorld(true);
  const g = st.actorMeshes.get("p1");
  assert.equal(toPixels(personKeypoints(g, cam.position), cam, 640, 360).face.length, 68);
  a.face = "faceless"; A.avatarsAt(st);
  const px = toPixels(personKeypoints(g, cam.position), cam, 640, 360);
  assert.equal(px.face, null);
  assert.ok(px.body[0] && px.body[1] && !px.body[14] && !px.body[17]);
});

// ---------------------------------------------------------------- 8: capture waits, failures are retried
test("captures wait for loading bodies, with a clear message on a timeout; a failed load is tried again next build", async () => {
  let release;
  A.trackLoading(new Promise((r) => { release = r; }));
  const t = await A.avatarsReady(60);
  assert.equal(t.timedOut, true);
  assert.equal(t.pending, 1);
  assert.match(t.message, /still loading after 0 s: 1 person is drawn as the marked stand-in/);
  const waiting = A.avatarsReady(5000);
  release();
  const r = await waiting;
  assert.equal(r.ok, true);
  assert.equal(A.AVATAR_WAIT_MS >= 30000, true, "the default wait is long enough for a first download");
  // a load that fails is remembered only briefly: the builds of a quick run of edits share it (no re-request of the
  // four FBX files on every edit), and a build after the retry time loads again
  A.setKitRetryMs(40);
  const spec = { model: "No_Such_Avatar", clips: { idle: "x", walk: "y", run: "z" } };
  const p1 = A.loadKit(spec);
  await assert.rejects(p1);
  await null;
  assert.equal(A.loadKit(spec), p1, "within the retry time: the same failure, no new request");
  await new Promise((r) => setTimeout(r, 60));
  const p2 = A.loadKit(spec);
  assert.notEqual(p2, p1, "a new attempt after the retry time, not the cached failure");
  await assert.rejects(p2);
  A.setKitRetryMs(0);
  await new Promise((r) => setTimeout(r, 60));   // p2's 40 ms memory runs out
  const p3 = A.loadKit(spec);
  await assert.rejects(p3);
  await null;
  const p4 = A.loadKit(spec);
  assert.notEqual(p4, p3, "retry time 0: every build tries again");
  await assert.rejects(p4);
  A.setKitRetryMs(15000);
});

// ---------------------------------------------------------------- 9: skins kept across rebuilds, one re-pose
test("10 people x 5 rebuilds: one re-pose for the first attach, none extra per rebuild, the skins are kept", async () => {
  const people = Array.from({ length: 10 }, (_, i) => person(`p${i}`, i - 5));
  const st = bareStage(people);
  const kit = stubKit();
  const rebuild = () => { st.actorMeshes.clear(); for (const a of people) { const g = clayOf(st, a); A.upgradeHuman(st, a, g); } };
  rebuild();
  for (const a of people) A.attachKit(st, a, st.actorMeshes.get(a.id), kit);   // the kit resolves: everyone attaches at once
  await null;
  assert.equal(st.setFrames, 1, "ten people attaching cost one setFrame");
  const skins = people.map((a) => st.actorMeshes.get(a.id).userData.humanSkin);
  assert.ok(skins.every((s) => s.shown));
  const N = 5;
  for (let n = 0; n < N; n++) { rebuild(); st.setFrame(st.frame); }   // _buildSet, then its own setFrame
  await null;
  assert.equal(st.setFrames, 1 + N, `no extra setFrame per person per rebuild (got ${st.setFrames - 1 - N} extra)`);
  people.forEach((a, i) => {
    const s = st.actorMeshes.get(a.id).userData.humanSkin;
    assert.equal(s, skins[i], "the same skin (no new clone)");
    assert.equal(s.g, st.actorMeshes.get(a.id), "bound to the new clay group");
    assert.equal(s.shown, true);
    assert.equal(s.holder.parent, s.g);
  });
  // a rebuild with no setFrame after it still gets ONE re-pose
  rebuild();
  await null;
  assert.equal(st.setFrames, 2 + N);
  // a person whose avatar model changes gets a new skin (here: none in node, the kit loads in the browser)
  people[0].kind = "woman";
  rebuild();
  assert.equal(st.actorMeshes.get("p0").userData.humanSkin, undefined);
});

// ---------------------------------------------------------------- Stage API for tools
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

/** Key the shot camera of a Stage at (position -> target), 28 mm; returns the camera placeInFrame really uses. */
function shotCam(st, position, target, focal_mm = 28) {
  st._shotCameraAt = () => ({ position, target, focal_mm });
  return st._activeShotCamera();
}

test("stage.duplicate(id): a new id, the copy beside it with its keys, the selection untouched, one undo step", () => {
  const st = apiStage();
  st.state.actors.push({ id: "box1", kind: "crate", name: "Crate", height_m: 0.6, position: [1, 0, 2], keys: [{ frame: 0, position: [1, 0, 2] }, { frame: 24, position: [2, 0, 2] }] });
  st._buildSet();
  st.selected = "other";
  const id = st.duplicate("box1");
  const id2 = st.duplicate("box1");
  assert.ok(id && id2 && id !== id2 && id !== "box1", `${id} / ${id2}`);
  const c = st.state.actors.find((a) => a.id === id);
  assert.deepEqual(c.keys.map((k) => k.position), [[2, 0, 2], [3, 0, 2]], "offset 1 m along +X");
  assert.equal(c.name, "Crate copy");
  assert.equal(st.selected, "other", "no dependence on (or change of) the selection");
  assert.equal(st.changes, 2, "each is one recorded edit (undo)");
  c.keys[0].position[0] = 99;
  assert.equal(st.state.actors[0].keys[0].position[0], 1, "a deep copy");
  assert.equal(st.duplicate("nope"), null);
});

test("stage.placeInFrame: the ground point lands at left / center / right thirds or 0..1, at the distance asked, on the ground", () => {
  const st = apiStage();
  const cam = shotCam(st, [0, 1.6, 8], [0, 1, 0]);
  st.state.actors.push({ id: "p1", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0.4, 0] }], key_y: true });
  st._buildSet();
  const screen = (p) => { const v = new THREE.Vector3(...p).project(cam); return [(v.x + 1) / 2, (1 - v.y) / 2]; };
  const flat = (p) => Math.hypot(p[0] - cam.position.x, p[2] - cam.position.z);
  let r = st.placeInFrame("p1", { x: "left", distance_m: 5 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(screen(r.position)[0] - 1 / 3) < 2e-3, `left third: x ${screen(r.position)[0]}`);
  assert.ok(Math.abs(flat(r.position) - 5) < 2e-3, `5 m away: ${flat(r.position)}`);
  assert.equal(r.position[1], 0, "on the ground");
  assert.deepEqual(st.state.actors[0].keys[0].position, r.position);
  assert.equal(st.state.actors[0].key_y, undefined);
  r = st.placeInFrame("p1", { x: "right" });   // keeps its distance
  assert.ok(Math.abs(screen(r.position)[0] - 2 / 3) < 2e-3 && Math.abs(flat(r.position) - 5) < 2e-3);
  r = st.placeInFrame("p1", { x: 0.5, y: 0.8 });
  const s = screen(r.position);
  assert.ok(Math.abs(s[0] - 0.5) < 1e-3 && Math.abs(s[1] - 0.8) < 1e-3, `at (0.5, 0.8): ${s}`);
  r = st.placeInFrame("p1", { x: "center", distance_m: 12 });
  assert.ok(Math.abs(screen(r.position)[0] - 0.5) < 2e-3 && Math.abs(flat(r.position) - 12) < 2e-3);
  // a keyed (moving) actor gets a key at the playhead; the others stay
  st.state.actors.push({ id: "p2", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 48, position: [4, 0, 0] }] });
  st._buildSet();
  st.frame = 24;
  r = st.placeInFrame("p2", { x: "left", distance_m: 6 });
  const keys = st.state.actors[1].keys;
  assert.deepEqual(keys.map((k) => k.frame), [0, 24, 48]);
  assert.deepEqual(keys[1].position, r.position);
  assert.deepEqual(keys[0].position, [0, 0, 0]);
  // errors, never a throw
  assert.equal(st.placeInFrame("zz", { x: "left" }).ok, false);
  assert.match(st.placeInFrame("p1", { x: "up" }).error, /x must be/);
  assert.match(st.placeInFrame("p1", { x: 0.5, y: 0.05 }).error, /horizon/);
  assert.match(st.placeInFrame("p1", { x: 0.5, distance_m: -1 }).error, /distance_m/);
});

test("stage.setRig returns {ok, rig}, and {ok: false, error} for an unknown rig (no throw)", () => {
  const st = apiStage();
  st._rigCache = null;
  const r = st.setRig("handheld", 0.7);
  assert.equal(r.ok, true);
  assert.equal(r.rig.type, "handheld");
  assert.equal(r.rig.amount, 0.7);
  assert.deepEqual(st.setRig("teleporter", 1), { ok: false, error: "unknown rig 'teleporter'" });
  assert.equal(st.state.shots[0].rig.type, "handheld", "left as it was");
});

test("stage.openPhysicsPanel(id) selects the object and opens the panel", () => {
  const st = apiStage();
  st.state.actors.push({ id: "box1", kind: "crate", position: [0, 0, 0] });
  st._buildSet();
  assert.equal(st.openPhysicsPanel("box1").ok, false, "no panel handed over yet");
  let opened = 0;
  st.physicsPanel = { open() { opened++; }, show() {} };
  st.selectedInfo = () => ({ id: st.selected });
  assert.deepEqual(st.openPhysicsPanel("box1"), { ok: true, id: "box1" });
  assert.equal(st.selected, "box1");
  assert.equal(opened, 1);
  assert.equal(st.openPhysicsPanel("ghost").ok, false);
  assert.equal(st.openPhysicsPanel().ok, true, "no id: opens for whatever is selected");
});

test("the Face tooltip is recomputed from the stage each time (never a stale reason)", async () => {
  const { faceTip, FACE_TIP } = await import("../../web/stage/people/peopleui.mjs");
  // never "shown as clay" any more (L1): only a stand-in says why
  let st = { installed: false, shown: false, reason: null, faceless: false, shownAs: "standin", loading: true };
  const stage = { avatarStatus: () => st };
  assert.match(faceTip(stage, "p1"), /stand-in now: the lifelike body is still loading/);
  st = { installed: true, shown: true, reason: null, faceless: false, shownAs: "lifelike" };
  assert.equal(faceTip(stage, "p1"), FACE_TIP);
  st = { installed: false, shown: false, reason: null, shownAs: "standin" };
  assert.match(faceTip(stage, "p1"), /not installed/);
  assert.ok(!/clay/i.test(FACE_TIP));
  assert.match(FACE_TIP, /hair stays/);
});

test("faceless face mask: the face (eyes, brows, nose, mouth, chin) is 1; the hairline, scalp, ears and neck are 0", () => {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const L = V(3, 160, 3), R = V(-3, 160, 3);   // eye spacing 6
  const m = (x, y, z) => C.faceMaskAt(V(x, y, z), L, R);
  for (const [p, what] of [[[3, 160, 4], "an eye"], [[-3, 163, 4], "a brow"], [[0, 155, 6], "the nose"], [[0, 151, 5], "the mouth"], [[0, 147, 4], "the chin"], [[4, 154, 3], "a cheek"]])
    assert.ok(m(...p) > 0.99, `${what}: ${m(...p)}`);
  for (const [p, what] of [[[0, 168, 3], "the hairline"], [[0, 172, -3], "the scalp"], [[8, 158, -2], "an ear"], [[0, 141, -2], "the neck"], [[0, 160, -9], "the back of the head"]])
    assert.ok(m(...p) < 0.01, `${what}: ${m(...p)}`);
  assert.equal(C.faceMaskAt(V(0, 0, 0), L, L.clone()), 0, "no eye spacing: no mask");
});

// ================================================================ M1.5 review round 2
import { Stage as _Stage, DEFAULT_SCENE as _DEFAULT_SCENE, liveKinds as _liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit as _LiveEdit } from "../../web/stage/live.mjs";

/** A real Stage without a renderer (as tests/js/live.drag.test.mjs): real _buildSet, setFrame, gait and live edits. */
function headlessStage(actors, frames = 72) {
  const st = Object.create(_Stage.prototype);
  const changes = [];
  Object.assign(st, {
    state: { ..._DEFAULT_SCENE && structuredClone(_DEFAULT_SCENE), actors: structuredClone(actors), environment: { set: "studio" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onChange: (s) => changes.push(s), onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.state.shot = { ...(st.state.shot || {}), frames, fps: 24 };
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.live = new _LiveEdit(st, _liveKinds());
  st.setFrame(0);
  return { st, changes };
}
const tiltDeg = (q) => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, new THREE.Vector3(0, 1, 0).applyQuaternion(q).y)));

test("round 2, 1: a keyed walker's gait lean (run, start, stop, sharp turn) never swaps the lifelike body mid-shot", async () => {
  // start from rest, run 6 m in 20 frames (7.2 m/s), a hard 90 degree turn, slow down, stop and hold to the end
  const walker = { id: "w1", name: "w1", kind: "man", height_m: 1.8, rotation_deg: 0, position: [-6, 0, 0],
    keys: [{ frame: 0, position: [-6, 0, 0] }, { frame: 20, position: [0, 0, 0] }, { frame: 34, position: [0, 0, 3.5] }, { frame: 56, position: [0.3, 0, 5] }] };
  const { st } = headlessStage([walker]);
  const a = st.state.actors[0], g = st.actorMeshes.get("w1");
  const skin = A.attachKit(st, a, g, stubKit());
  assert.ok(skin, "attached");
  await null;
  let maxLean = 0;
  const shown = [];
  for (let f = 0; f <= st._lastFrame(); f++) {
    st.setFrame(f);
    maxLean = Math.max(maxLean, tiltDeg(st.actorMeshes.get("w1").quaternion));
    shown.push(skin.shown);
    if (!skin.shown) assert.fail(`frame ${f}: swapped to clay (${skin.reason})`);
  }
  assert.ok(maxLean > 5, `the gait really leaned the clay group (max ${maxLean.toFixed(1)} deg), so the test bites`);
  assert.equal(new Set(shown).size, 1, "one look for the whole shot");
  // the old geometric check would have flagged it
  assert.equal(A.tippedNow(g), false);
  assert.equal(A.tiltedOffUp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.11, 0, 0))), true, "a 6 deg lean IS off upright; the live flag, not the angle, decides");
});

test("round 2, 2: a live knock-over through live.mjs _tick hands the lifelike body to the rig (after setFrame posed it upright); the saved tilt keeps it", async () => {
  const { st, changes } = headlessStage([
    { id: "p1", name: "p1", kind: "man", height_m: 1.8, rotation_deg: 0, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] },
    { id: "c1", name: "c1", kind: "crate", height_m: 0.8, rotation_deg: 0, position: [3, 0, 0], keys: [{ frame: 0, position: [3, 0, 0] }] },
  ]);
  const a = st.state.actors[0], g = st.actorMeshes.get("p1");
  const skin = A.attachKit(st, a, g, stubKit());
  await null;
  st.setFrame(0);
  assert.equal(skin.shown, true);
  // The live world as live.mjs keeps it, with the person's body knocked 40 degrees over by physics.
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(40)));
  let pose = { pos: [0.2, 0.3, 0], quat: [q.x, q.y, q.z, q.w] };
  const L = st.live;
  L.world = { step() {}, getPose: (bid) => (bid === "p1#0" ? pose : { pos: [3, 0, 0], quat: [0, 0, 0, 1] }), dispose() {}, awakeCount: () => 0 };
  L.bodies = new Map([["p1", ["p1#0"]]]);
  L.meta = new Map([["p1", { pos: [0, 0, 0], quat: [0, 0, 0, 1], dynamic: true }]]);
  L.drag = null; L.tail = null;
  L._silentFrame();               // what a drag tick does first: setFrame poses the avatar on the upright group
  assert.equal(skin.shown, true, "upright at setFrame");
  L._tick(1 / 60);                // then the physics pose goes on the group
  assert.equal(skin.shown, true, "never clay while knocked over");
  assert.equal(skin.ownerReason, "is tipped over");
  L._silentFrame();               // the next tick's setFrame stands the group up again: still the rig (no flicker)
  assert.equal(skin.ownerReason, "is tipped over");
  // let go: _commit writes the tilt down (a stationary person keeps a.tilt) and the rig keeps it, now for the whole shot
  L._commit({ id: "c1", a: st.state.actors[1], moved: true, carried: [] });
  assert.equal(g.userData.liveTipped, false, "the live flag is dropped once written");
  assert.ok(Array.isArray(a.tilt), "tilt saved");
  assert.equal(skin.ownerReason, "was knocked over");
  assert.equal(skin.shown, true);
  assert.ok(changes.length >= 1);
  // stood up again (Reset rotation): lifelike again
  delete a.tilt;
  st.setFrame(0);
  assert.equal(skin.shown, true, `shown again (reason ${skin.reason})`);
  // a physics pose that is upright never flags the person
  pose = { pos: [0, 0, 0], quat: [0, Math.sin(0.6), 0, Math.cos(0.6)] };
  L._tick(1 / 60);
  assert.equal(skin.shown, true, "turned on the spot by physics: still lifelike");
});

test("round 2, 3: the dust matte keeps the card cut-out and hidden groups (secondary.mjs _renderDustMatte)", async () => {
  const a = person("p1");
  const st = bareStage([a]);
  const g = clayOf(st, a);
  const kit = stubKit();
  const skin = A.attachKit(st, a, g, kit);
  await null;
  A.avatarsAt(st);
  assert.equal(skin.shown, true);
  const mesh = []; skin.holder.traverse((o) => { if (o.isSkinnedMesh) mesh.push(o); });
  // faceless lashes: a hidden third group
  mesh[0].material = [...mesh[0].material, kit.faceless.hidden];
  const own = mesh[0].material;
  st.scene = new THREE.Scene(); st.scene.add(g);
  st.renderer = { render: () => {
    const m = mesh[0].material;
    seen = m;
  } };
  let seen = null;
  assert.equal(typeof st._renderDustMatte, "function", "the stage has the dust matte (secondary.mjs on Stage.prototype)");
  st._renderDustMatte(new THREE.PerspectiveCamera());
  assert.ok(Array.isArray(seen) && seen.length === 3, "still an array for the geometry groups");
  assert.equal(seen[0].color.getHex(), 0x000000, "body: the black hold-out");
  assert.equal(seen[1].map, own[1].map, "hair card: keeps its map (alpha)");
  assert.equal(seen[1].alphaTest, 0.5, "hair card: keeps its alphaTest");
  assert.equal(seen[1].color.getHex(), 0x000000, "hair card: black, not the hair colour");
  assert.equal(seen[2], kit.faceless.hidden, "faceless lashes stay hidden");
  assert.equal(seen[2].visible, false);
  assert.equal(mesh[0].material, own, "put back after the render");
  // the plain helper: one mesh material, card or not
  const black = new THREE.MeshBasicMaterial({ color: 0 });
  assert.equal(CUT.overrideMaterials(new THREE.MeshStandardMaterial(), black), black);
  assert.equal(CUT.overrideMaterials(own[1], black), CUT.passCutout(own[1], black), "cached per card and matte");
});

test("round 2, 4: placeInFrame refuses a distance a steep or top-down camera can't reach (no success at the range edge)", () => {
  const st = apiStage();
  shotCam(st, [0, 1.6, 0], [0, 0, -0.001]);   // straight down
  st.state.actors.push({ id: "p1", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st._buildSet();
  const before = structuredClone(st.state.actors[0]);
  const r = st.placeInFrame("p1", { x: "center", distance_m: 10 });
  assert.equal(r.ok, false, `refused: ${JSON.stringify(r)}`);
  assert.match(r.error, /farther than this camera can put it/);
  assert.deepEqual(st.state.actors[0], before, "nothing moved");
  assert.equal(st.changes, 0, "no undo step");
  // a reachable one still works on the same camera, at the distance asked
  const ok = st.placeInFrame("p1", { x: "center", distance_m: 2 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(Math.abs(Math.hypot(ok.position[0], ok.position[2]) - 2) < 2e-3, JSON.stringify(ok));
});

test("round 2, 6: _jumpsInShot per frame skips the JSON signature when nothing changed, and still sees a change", () => {
  const walker = { id: "p1", kind: "man", height_m: 1.8, position: [-3, 0, 0], keys: [{ frame: 0, position: [-3, 0, 0] }, { frame: 48, position: [3, 0, 0] }] };
  const crate = { id: "c1", kind: "crate", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = bareStage([walker, crate]);
  clayOf(st, walker); clayOf(st, crate).updateMatrixWorld(true);
  assert.equal(st._jumpsInShot(walker), true);
  const real = JSON.stringify;
  let calls = 0;
  JSON.stringify = (...x) => { calls++; return real(...x); };
  try {
    for (let i = 0; i < 100; i++) st._jumpsInShot(walker);
  } finally { JSON.stringify = real; }
  assert.equal(calls, 0, "no JSON.stringify on the per-frame path");
  // the crate moves out of the way (the obstacle list is rebuilt) and the path changes: both are seen
  walker.keys[1].position = [3, 0, 4]; walker.keys[0].position = [-3, 0, 4];
  assert.equal(st._jumpsInShot(walker), false, "a new path is seen (keys hash)");
  walker.keys[1].position = [3, 0, 0]; walker.keys[0].position = [-3, 0, 0];
  assert.equal(st._jumpsInShot(walker), true);
  st.state.actors = [walker]; st.actorMeshes.delete("c1"); st._obstacles();
  assert.equal(st._jumpsInShot(walker), false, "the crate gone is seen (obstacle list)");
});

test("round 2, 7: placeInFrame(id, null) uses the defaults; a non-object is an error (no throw); openPhysicsPanel records no undo step", () => {
  const st = apiStage();
  const cam = shotCam(st, [0, 1.6, 8], [0, 1, 0]);
  st.state.actors.push({ id: "p1", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st._buildSet();
  const r = st.placeInFrame("p1", null);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(Math.hypot(r.position[0], r.position[2] - 8) - 8) < 2e-3, "center, its present distance");
  assert.equal(st.placeInFrame("p1", "left").ok, false);
  const n = st.changes;
  st.physicsPanel = { open() {}, show() {} };
  st.selectedInfo = () => ({ id: st.selected });
  assert.equal(st.openPhysicsPanel("p1").ok, true);
  assert.equal(st.changes, n, "opening a panel is not a scene edit: no undo step");
});

// ---------------------------------------------------------------- round 3
/** stage.capture(mode) on a Stage with no GL: records what each render saw, returns the fake PNG. */
function captureStage(onRender) {
  const st = Object.create(Stage.prototype);
  Object.defineProperties(st, { fw: { value: 64 }, fh: { value: 36 } }); st.frame = 7;
  st.renderer = { getSize: (v) => v.set(64, 36), setSize() {} };
  st.canvas = {};
  st._renderMode = (mode, forCapture) => { if (forCapture) onRender(mode); };
  st.render = () => {};
  st.poses = 0;
  st.setFrame = () => { st.poses++; };
  st.notes = [];
  st.onInteract = (m) => st.notes.push(m);
  return st;
}
async function withOffscreen(fn) {
  const had = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class { getContext() { return { canvas: { convertToBlob: true }, drawImage() {} }; } convertToBlob() { return Promise.resolve("png"); } };
  try { return await fn(); } finally { if (had) globalThis.OffscreenCanvas = had; else delete globalThis.OffscreenCanvas; }
}

test("round 3, 4: a single still (stage.capture) waits for bodies still loading, re-poses them, and says so on a timeout", async () => {
  await withOffscreen(async () => {
    // a body that finishes loading 30 ms in: the still is taken after it went on, never of the clay
    let loaded = false;
    A.trackLoading(new Promise((r) => setTimeout(() => { loaded = true; r(); }, 30)));
    const seen = [];
    const st = captureStage((mode) => seen.push([mode, loaded]));
    const blob = await st.capture("color");
    assert.equal(blob, "png");
    assert.deepEqual(seen, [["color", true]], "rendered once, after the body loaded");
    assert.ok(st.poses >= 1, "the new bodies are posed before the render");
    assert.equal(st.lastCaptureNote, "");
    assert.deepEqual(st.notes, ["Waiting for 1 lifelike person to load before capturing (up to 60 s)..."], "it says it is waiting before the wait");
    // nothing loading: no wait, no extra pose
    const st2 = captureStage(() => {});
    await st2.capture("depth");
    assert.equal(st2.poses, 0);
    // still loading past stage.avatarWaitMs: the still goes ahead, with the message on the status line
    let release;
    A.trackLoading(new Promise((r) => { release = r; }));
    const st3 = captureStage(() => {});
    st3.avatarWaitMs = 20;
    await st3.capture("color");
    assert.match(st3.lastCaptureNote, /still loading after 0 s: 1 person is drawn as the marked stand-in/);
    assert.equal(st3.notes.length, 2);
    assert.match(st3.notes[0], /^Waiting for 1 lifelike person/);
    assert.equal(st3.notes[1], st3.lastCaptureNote);
    release();
    await A.avatarsReady(1000);
  });
});

test("round 3, 5: setRig never throws: non-object params and inherited names are errors and change nothing", () => {
  const st = apiStage();
  st._rigCache = null;
  assert.equal(st.setRig("tripod", 1).ok, true);
  const before = structuredClone(st.state.shots[0].rig);
  const n = st.changes;
  for (const bad of ["x", 3, true, ["arm", 5]]) {
    let r;
    assert.doesNotThrow(() => { r = st.setRig("jib", 1, bad); }, `params ${JSON.stringify(bad)}`);
    assert.equal(r.ok, false);
    assert.match(r.error, /params must be an object/);
  }
  for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.deepEqual(st.setRig(name, 1), { ok: false, error: `unknown rig '${name}'` });
  }
  assert.deepEqual(st.setRig(undefined, 1), { ok: false, error: "unknown rig 'undefined'" });
  assert.deepEqual(st.state.shots[0].rig, before, "the shot's rig is left as it was");
  assert.equal(st.changes, n, "no undo step from a refused call");
  // null / undefined params still mean "no options"
  assert.equal(st.setRig("jib", 1, null).ok, true);
  assert.equal(st.setRig("jib", 1, { arm: 6 }).rig.arm, 6);
});

test("round 3, 6: duplicate copies the BASE keys, so the copy moves like the original in every shot", () => {
  const st = apiStage();
  st.state.shots = [{ id: "A" }, { id: "B" }];
  st.state.active_shot = "B";
  st.state.actors.push({ id: "p1", kind: "man", name: "Ada", height_m: 1.7, position: [0, 0, 0],
    keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 48, position: [4, 0, 0] }],
    by_shot: { B: { keys: [{ frame: 0, position: [9, 0, 9] }, { frame: 10, position: [9, 0, 12] }] } } });
  st._buildSet();
  const id = st.duplicate("p1");
  const c = st.state.actors.find((x) => x.id === id);
  const off = 1.7 * 0.8;
  assert.deepEqual(c.keys.map((k) => k.frame), [0, 48], "the base keys' frames, not shot B's");
  assert.deepEqual(c.keys.map((k) => k.position.map((v) => +v.toFixed(6))), [[off, 0, 0], [4 + off, 0, 0]].map((p) => p.map((v) => +v.toFixed(6))));
  assert.deepEqual(c.position.map((v) => +v.toFixed(6)), [+off.toFixed(6), 0, 0]);
  assert.equal(c.by_shot, undefined);
  // in shot A (no blocking of its own) the copy walks the original's path, offset
  st.state.active_shot = "A";
  const orig = st._actorKeys(st.state.actors[0]), copy = st._actorKeys(c);
  orig.forEach((k, i) => { assert.equal(copy[i].frame, k.frame); assert.ok(Math.abs(copy[i].position[0] - k.position[0] - off) < 1e-9); });
  // the original's keys are untouched
  assert.deepEqual(st.state.actors[0].keys.map((k) => k.position), [[0, 0, 0], [4, 0, 0]]);
  assert.deepEqual(st.state.actors[0].by_shot.B.keys[0].position, [9, 0, 9]);
});

test("round 3, 7: placeInFrame uses the active shot's camera, not a live preview, and leaves the base position of per-shot blocking alone", () => {
  const st = apiStage();
  const shotC = { position: [0, 1.6, 8], target: [0, 1, 0], focal_mm: 28 };
  st._shotCameraAt = () => shotC;
  // the virtual-camera preview is on screen, looking somewhere else entirely, and this.camera shows it
  st._preview = { position: [20, 3, -20], target: [25, 0, -30], focal_mm: 50 };
  st.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 200);
  st.camera.position.set(20, 3, -20); st.camera.lookAt(25, 0, -30); st.camera.updateMatrixWorld(true);
  st._syncShotCamera = () => false;   // as the real one does while _preview is set
  st.state.actors.push({ id: "p1", kind: "man", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] });
  st._buildSet();
  const r = st.placeInFrame("p1", { x: "left", distance_m: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const cam = st._activeShotCamera();
  assert.deepEqual(cam.position.toArray(), shotC.position);
  const v = new THREE.Vector3(...r.position).project(cam);
  assert.ok(Math.abs((v.x + 1) / 2 - 1 / 3) < 2e-3, `left third of the SHOT camera: ${(v.x + 1) / 2}`);
  assert.ok(Math.abs(Math.hypot(r.position[0], r.position[2] - 8) - 5) < 2e-3, "5 m from the shot camera");
  // per-shot blocking: the by_shot key is edited, a.position (the base keys' mirror) and a.keys stay
  st.state.actors.push({ id: "p2", kind: "man", position: [1, 0, 1], keys: [{ frame: 0, position: [1, 0, 1] }, { frame: 48, position: [2, 0, 1] }],
    by_shot: { s: { keys: [{ frame: 0, position: [-1, 0, -1] }] } } });
  st._buildSet();
  const r2 = st.placeInFrame("p2", { x: "right", distance_m: 6 });
  assert.equal(r2.ok, true);
  const p2 = st.state.actors[1];
  assert.deepEqual(p2.by_shot.s.keys[0].position, r2.position, "the shot's own key moved");
  assert.deepEqual(p2.position, [1, 0, 1], "base position untouched");
  assert.deepEqual(p2.keys.map((k) => k.position), [[1, 0, 1], [2, 0, 1]], "base keys untouched");
});
