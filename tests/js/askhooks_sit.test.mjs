// node --test tests/js/askhooks_sit.test.mjs
// stage.setPose(id, "sit" | "sit_floor" | "stand", {on?}): people sit on chairs / benches / sofas (the seat height from
// the prop) and on the floor, one undo step each, refusals change nothing; the clay folds down; the lifelike body
// follows (people/avatars.mjs sitBody: no clay fallback), checked on the real Rocketbox bodies when installed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { buildObject } from "../../web/stage/library.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";

function sitStage(actors) {
  const st = Object.create(Stage.prototype);
  st.state = { shot: { frames: 9, fps: 24 }, shots: [{ id: "s", camera_keys: [{ frame: 0, position: [0, 1.6, 6], target: [0, 1, 0], focal_mm: 35 }] }], active_shot: "s", actors };
  st.actorMeshes = new Map(); st.frame = 0; st.camera = new THREE.PerspectiveCamera();
  Object.defineProperty(st, "fw", { value: 1280 }); Object.defineProperty(st, "fh", { value: 720 });
  st.render = () => {}; st.undo = 0; st.onChange = () => { st.undo++; }; st.scene = new THREE.Scene();
  for (const a of actors) {
    const g = buildObject(a.kind, a.height_m, (geom, color) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color })), a.appearance);
    g.position.set(...a.position); g.rotation.y = THREE.MathUtils.degToRad(a.rotation_deg || 0); g.userData.actorId = a.id;
    st.scene.add(g); st.actorMeshes.set(a.id, g);
  }
  st.setFrame(0); st.setFrame(0);
  return st;
}
const man = (id, x, z = 0) => ({ id, name: "Jon Doe", kind: "man", height_m: 1.8, position: [x, 0, z], keys: [{ frame: 0, position: [x, 0, z] }] });
const prop = (id, kind, x, h, z = 0) => ({ id, name: kind, kind, height_m: h, position: [x, 0, z], keys: [{ frame: 0, position: [x, 0, z] }] });

test("setPose sit: the nearest chair within 1.5 m, the seat height from the prop; stand gets up; one undo step each", () => {
  const st = sitStage([man("p1", 0), prop("c1", "chair", 1.2, 0.9), prop("b1", "bench", 4, 0.85)]);
  let r = st.setPose("p1", "sit");
  assert.deepEqual(r, { ok: true, pose: "sit", on: "c1", changed: true });
  assert.equal(st.undo, 1);
  const spec = st._sitSpec(st.state.actors[0]);
  assert.equal(spec.pose, "sit"); assert.ok(Math.abs(spec.seat[1] - 0.47) < 1e-9, `chair seat ${spec.seat[1]}`);
  const g = st.actorMeshes.get("p1");
  assert.ok(Math.abs(g.position.y - (0.47 - 0.95)) < 1e-6, "the clay's feet origin hangs below the seat by its seated drop");
  assert.deepEqual(st.setPose("p1", "sit").changed, false, "already there: no undo step");
  assert.equal(st.undo, 1);
  // a taller chair has a higher seat; naming a far bench works
  st.state.actors[1].height_m = 1.08;
  assert.ok(Math.abs(st._sitSpec(st.state.actors[0]).seat[1] - 0.47 * 1.2) < 1e-9);
  assert.equal(st.setPose("p1", "sit", { on: "b1" }).on, "b1");
  assert.equal(st.state.actors[0].mount_id, "b1");
  assert.equal(st.setPose("p1", "stand").ok, true);
  assert.equal(st.state.actors[0].mount_id, undefined);
  assert.equal(st.undo, 3);
});

test("setPose sit_floor: down where they stand (from a seat too), the clay folds, stand clears it", () => {
  const st = sitStage([man("p1", 0), prop("s1", "sofa", 0, 0.85, 1.2)]);
  assert.deepEqual(st.setPose("p1", "sit_floor"), { ok: true, pose: "sit_floor", changed: true });
  const g = st.actorMeshes.get("p1");
  assert.ok(Math.abs(g.position.y - -0.85) < 1e-6, `feet origin 0.85 m below the floor (pelvis 0.10 m up): ${g.position.y}`);
  assert.deepEqual(st._sitSpec(st.state.actors[0]).seat, [0, 0, 0]);
  assert.equal(st.setPose("p1", "sit", { on: "s1" }).ok, true);
  assert.ok(Math.abs(st._sitSpec(st.state.actors[0]).seat[1] - 0.54) < 1e-9, "the sofa's cushion top");
  assert.equal(st.state.actors[0].pose, "sit");
  assert.equal(st.setPose("p1", "sit_floor").ok, true, "off the sofa onto the floor in front of it");
  assert.equal(st.state.actors[0].mount_id, undefined);
  assert.equal(st.state.actors[0].pose, "sit_floor");
  assert.equal(st.setPose("p1", "stand").changed, true);
  assert.equal(st.state.actors[0].pose, undefined);
  assert.equal(st.setPose("p1", "stand").changed, false);
});

test("setPose refusals change nothing", () => {
  const st = sitStage([man("p1", 0), prop("c1", "chair", 3, 0.9), prop("car", "car", 6, 1.5), prop("k", "crate", 0.5, 0.6)]);
  const before = JSON.stringify(st.state);
  for (const [args, re] of [
    [["nope", "sit"], /no object/], [["c1", "sit"], /not a person/], [["p1", "kneel"], /unknown pose/], [["p1", null], /unknown pose/],
    [["p1", "sit"], /nothing to sit on within 1\.5 m/], [["p1", "sit", { on: "car" }], /can't sit on/], [["p1", "sit", { on: "k" }], /can't sit on/],
    [["p1", "sit", { on: "zz" }], /no object 'zz'/], [["p1", "sit", "c1"], /opts must be an object/],
  ]) {
    const r = st.setPose(...args);
    assert.equal(r.ok, false, JSON.stringify(args)); assert.match(r.error, re);
  }
  assert.equal(JSON.stringify(st.state), before);
  assert.equal(st.undo, 0);
});

test("Ask's host.stage.setPose is the stage's", () => {
  const app = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  const a = app.indexOf("node.ssAsk = mountAsk(");
  assert.match(app.slice(a, app.indexOf("mountProjectBar(", a)), /setPose: \(id, pose, opts\) => stage\.setPose\(id, pose, opts\)/);
});

test("a person sitting on a chair or the floor is not sent back to the clay", () => {
  assert.equal(C.clayReason({ mount_id: "c1" }, { sits: true }), null);
  assert.match(C.clayReason({ mount_id: "h1" }, {}), /rides or sits/, "a horse / bike / car rider keeps the old rule");
  assert.equal(C.clayReason({ pose: "sit_floor" }, {}), null);
  const st = sitStage([man("p1", 0), prop("h", "horse", 2, 1.6)]);
  st.mount("p1", "h");
  assert.equal(st._sitSpec(st.state.actors[0]), null, "riding is not sitting");
});

// ---------------------------------------------------------------- the real lifelike bodies
const RB = fileURLToPath(new URL("../../web/stage/people/rocketbox/", import.meta.url));
const NOT_INSTALLED = !(existsSync(`${RB}Male_Adult_01.fbx`) && existsSync(`${RB}anim/m_idle_neutral_01.max.fbx`)) && "Rocketbox files not installed (web/stage/people/rocketbox/)";
async function manKit() {
  globalThis.document ||= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
  const { FBXLoader } = await import("../../web/vendor/addons/FBXLoader.mjs");
  const parse = (f, manager) => { const b = readFileSync(RB + f); return new FBXLoader(manager).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), RB); };
  const spec = C.ROCKETBOX.man, manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => C.tgaToPng(u, `${RB}tex/`));
  const clips = Object.fromEntries(C.CLIP_KINDS.map((k) => [k, parse(`anim/${spec.clips[k]}.max.fbx`).animations[0]]));
  const kit = A.buildKit(parse(`${spec.model}.fbx`, manager), clips);
  kit.spec = spec;
  return kit;
}
const W = (b) => b.getWorldPosition(new THREE.Vector3());

test("real Rocketbox: the lifelike man sits on the chair (hips on the seat, thighs level, shins down) and on the floor", { skip: NOT_INSTALLED }, async () => {
  const kit = await manKit();
  const st = sitStage([man("p1", 0), prop("c1", "chair", 1, 0.9, 0)]);
  st.setFrame = ((orig) => function (f) { orig.call(this, f); })(st.setFrame);
  const skin = A.attachKit(st, st.state.actors[0], st.actorMeshes.get("p1"), kit);
  await null;
  A.avatarsAt(st);
  assert.equal(skin.shown, true, "standing: lifelike");
  st.state.actors[1].rotation_deg = 90; st.actorMeshes.get("c1").rotation.y = Math.PI / 2;   // the chair faces +X
  assert.equal(st.setPose("p1", "sit").ok, true);
  A.avatarsAt(st);
  assert.equal(skin.shown, true, `seated: still lifelike (${skin.reason})`);
  const B = skin.bones, hipL = W(B.Bip01_L_Thigh), kneeL = W(B.Bip01_L_Calf), ankleL = W(B.Bip01_L_Foot);
  const hip = hipL.clone().add(W(B.Bip01_R_Thigh)).multiplyScalar(0.5);
  assert.ok(Math.abs(hip.y - (0.47 + 0.10)) < 0.01, `hips just above the 0.47 m seat: ${hip.y.toFixed(3)}`);
  assert.ok(Math.abs(hip.z - 0) < 0.05 && Math.abs(hip.x - (1 - 0.06)) < 0.05, `over the seat: ${hip.x.toFixed(2)}, ${hip.z.toFixed(2)}`);
  assert.ok(kneeL.x - hipL.x > 0.3 && Math.abs(kneeL.y - hipL.y) < 0.06, "thigh level, forward (the chair's way)");
  assert.ok(kneeL.y - ankleL.y > 0.3 && Math.abs(ankleL.x - kneeL.x) < 0.12, "shin down");
  assert.ok(ankleL.y > -0.02 && ankleL.y < 0.2, `feet near the floor: ${ankleL.y.toFixed(3)}`);
  const toe = B.Bip01_L_Toe0 && W(B.Bip01_L_Toe0);
  assert.ok(toe, "a toe bone"); assert.ok(toe.x - ankleL.x > 0.05 && Math.abs(toe.y - ankleL.y) < 0.15, `toes point forward, not twisted: ${toe.toArray().map((v) => v.toFixed(2))} from ${ankleL.toArray().map((v) => v.toFixed(2))}`);
  const handL = W(B.Bip01_L_Hand);
  assert.ok(handL.x > hip.x + 0.1 && handL.y < 0.85, `hands forward on the lap: ${handL.toArray().map((v) => v.toFixed(2))}`);
  // on the floor
  assert.equal(st.setPose("p1", "sit_floor").ok, true);
  A.avatarsAt(st);
  assert.equal(skin.shown, true, `on the floor: still lifelike (${skin.reason})`);
  const fh = W(B.Bip01_L_Thigh).add(W(B.Bip01_R_Thigh)).multiplyScalar(0.5), fk = W(B.Bip01_L_Calf), fa = W(B.Bip01_L_Foot);
  assert.ok(Math.abs(fh.y - 0.10) < 0.01, `hips 0.10 m above the floor: ${fh.y.toFixed(3)}`);
  assert.ok(fk.y > fh.y + 0.15, "knees up");
  assert.ok(fa.y > -0.03 && fa.y < 0.16, `feet on the floor: ${fa.y.toFixed(3)}`);
  // standing again: the plain idle, feet on the floor
  assert.equal(st.setPose("p1", "stand").ok, true);
  A.avatarsAt(st);
  assert.ok(W(B.Bip01_L_Thigh).y > 0.8, "standing hips back up");
});
