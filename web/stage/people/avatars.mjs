// Lifelike people on the stage (people overhaul, milestone M1): the Microsoft Rocketbox avatars (MIT) over the clay
// figure, the way the rigged horse rides over the built one (stage.mjs _upgradeHorse).
//   - The clay figure stays in the scene as the logic rig: gait, gaze, mounts, mocap, Drive, the ID matte's picking
//     all keep reading its joints. Only its meshes are hidden while the avatar shows.
//   - The avatar plays its own Rocketbox idle / walk / run clips, picked and crossfaded by the actor's ground speed,
//     with walk and run locked to the distance travelled (no skating) and root motion stripped (avatarcore.mjs).
//   - Pure frame -> pose: given the stage frame the pose is always the same (no wall clock), as renders need.
//   - The asset files are NOT in the repo (web/stage/people/rocketbox/, see web/stage/people/README.md). Without
//     them every person silently stays clay.
// Pure rules live in avatarcore.mjs (tested in node); this file loads, clones and drives.
import * as THREE from "../../vendor/three.module.min.mjs";
import { FBXLoader } from "../../vendor/addons/FBXLoader.mjs";
import * as SkeletonUtils from "../../vendor/addons/SkeletonUtils.mjs";
import { gazeKeys } from "../gaze.mjs";
import * as C from "./avatarcore.mjs";

export const ROCKETBOX_DIR = new URL("./rocketbox/", import.meta.url).href;
const TEX_DIR = `${ROCKETBOX_DIR}tex/`;
const kits = new Map();   // model name -> Promise<kit>; a failure is kept too, so a missing install isn't re-fetched
const inflight = new Set();   // per-person upgrades still loading (captureSequence waits for them: no pop mid-capture)
let warned = false;

function fbx(url, manager) {
  return new FBXLoader(manager).loadAsync(url);
}

/** Load one avatar and its three clips once (cached per model). Resolves the kit; rejects when the files are missing. */
export function loadKit(spec) {
  if (kits.has(spec.model)) return kits.get(spec.model);
  const p = (async () => {
    const texErrors = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => C.tgaToPng(u, TEX_DIR));
    manager.onError = (u) => { if (/\.fbx$/i.test(u)) return; texErrors.push(u); console.warn("Soundstage: avatar texture failed to load", u); };   // a missing FBX rejects loadKit instead
    const [model, ...anims] = await Promise.all([
      fbx(`${ROCKETBOX_DIR}${spec.model}.fbx`, manager),
      ...C.CLIP_KINDS.map((k) => fbx(`${ROCKETBOX_DIR}anim/${spec.clips[k]}.max.fbx`, new THREE.LoadingManager())),
    ]);
    const clips = {};
    C.CLIP_KINDS.forEach((k, i) => { clips[k] = anims[i].animations?.[0] || null; });
    const kit = buildKit(model, clips, { texErrors });
    kit.spec = spec;
    return kit;
  })();
  kits.set(spec.model, p);
  return p;
}

/**
 * Turn a parsed avatar FBX and its clips into a reusable kit (also used by the node fixture test):
 * the lights in the file removed, only the most detailed mesh kept, Phong turned into the Standard material the rest
 * of the set uses (same response to the sun; the specular maps are not used yet), lashes cut out by the PNG's alpha,
 * the clips prepared (rotations + root bob only), and checks recorded (kit.report).
 */
export function buildKit(model, clips, { texErrors = [] } = {}) {
  const lights = [];
  model.traverse((o) => { if (o.isLight) lights.push(o); });
  for (const l of lights) l.removeFromParent();
  const meshes = [];
  model.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  const list = meshes.map((m) => ({ name: m.name, vertices: m.geometry.attributes.position.count }));
  const keep = meshes[C.pickLod(list)];
  for (const m of meshes) if (m !== keep) m.removeFromParent();
  if (!keep) throw new Error("no skinned mesh in the avatar file");
  const src = [].concat(keep.material);
  const materials = src.map((m) => {
    const role = C.materialRole(m.name);
    const s = new THREE.MeshStandardMaterial({ name: m.name, map: m.map || null, normalMap: m.normalMap || null, roughness: role === "head" ? 0.6 : 0.78, metalness: 0 });
    if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
    if (role === "opacity") { s.alphaTest = 0.5; s.side = THREE.DoubleSide; }   // the alpha lives in the colour PNG
    s.userData.role = role;
    m.specularMap?.dispose?.();
    return s;
  });
  keep.material = Array.isArray(keep.material) ? materials : materials[0];
  const neutral = new THREE.MeshStandardMaterial({ name: "faceless_head", color: 0xcfc6ba, roughness: 0.85, metalness: 0 });
  neutral.userData.plain = true;
  const hidden = new THREE.MeshBasicMaterial({ name: "faceless_hidden", visible: false });
  hidden.userData.plain = true;
  const boneNames = new Set();
  model.traverse((o) => { if (o.name) boneNames.add(o.name); });
  const root = model.getObjectByName(C.ROOT_BONE);
  model.updateMatrixWorld(true);
  const hipUnits = root ? root.getWorldPosition(new THREE.Vector3()).y : 90;
  const prepared = {};
  for (const k of C.CLIP_KINDS) if (clips[k]) prepared[k] = C.prepareClip(clips[k], boneNames);
  const { stature, floor, idleBox } = measureStanding(model, prepared.idle?.clip);
  return {
    template: model, meshName: keep.name, materials, faceless: { neutral, hidden }, clips: prepared, hipUnits, stature, floor, idleBox,
    report: { meshes: list.map((m) => m.name), kept: keep.name, lightsRemoved: lights.length, missingMaps: C.missingColorMaps(materials),
      unbound: Object.fromEntries(C.CLIP_KINDS.map((k) => [k, prepared[k]?.missing || null])), texErrors },
  };
}

/** The avatar's standing height and the height of its soles (avatar units), measured on a throwaway clone posed at the
 *  start of its idle clip (the pose it is seen in when still), over every skinned vertex. idleBox = the skinned mesh's
 *  own box in that pose (mesh space): every clone keeps it as its fixed bounds, so Box3.setFromObject on a person
 *  (picking, drop targets, framing, measure) sees a standing body (arms down), not the wide bind pose or a mid-stride
 *  pose cached on first use. */
function measureStanding(template, idle) {
  const m = SkeletonUtils.clone(template);
  if (idle) {
    const mixer = new THREE.AnimationMixer(m);
    mixer.clipAction(idle).play();
    mixer.setTime(0);
  }
  m.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let idleBox = null;
  m.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    box.expandByObject(o, true);
    if (!idleBox) { o.computeBoundingBox(); idleBox = o.boundingBox?.isEmpty() ? null : o.boundingBox.clone(); }
  });
  if (box.isEmpty()) return { stature: 180, floor: 0, idleBox: null };
  return { stature: box.max.y - box.min.y, floor: box.min.y, idleBox };
}

/** One actor's avatar: a clone of the kit (shared geometry and textures), its mixer and its named bones. */
export function instantiate(kit, a) {
  const model = SkeletonUtils.clone(kit.template);
  const holder = new THREE.Group();
  holder.name = "avatar";
  holder.add(model);
  let mesh = null;
  const bones = {};
  holder.traverse((o) => {
    o.userData.actorId = a.id;
    o.userData.avatar = true;
    if (o.isBone) bones[o.name] = o;
    if (!o.isMesh) return;
    mesh ||= o;
    o.castShadow = true; o.receiveShadow = true;
    o.frustumCulled = false;      // skinned bounds don't follow the walk
    if (o.isSkinnedMesh && kit.idleBox) {   // fixed standing bounds (measureStanding), never recomputed from a pose
      o.boundingBox = kit.idleBox.clone();
      o.boundingSphere = kit.idleBox.getBoundingSphere(new THREE.Sphere());
    }
    o.raycast = () => {};         // picking hits the (hidden) clay, which is cheap and keeps every pick rule
    o.visible = false;            // shown by setShown once the actor is known to be eligible
  });
  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const k of C.CLIP_KINDS) {
    const c = kit.clips[k];
    if (!c) continue;
    const act = mixer.clipAction(c.clip);
    act.play();
    act.setEffectiveWeight(0);
    actions[k] = act;
  }
  return { holder, model, mesh, mixer, actions, bones, kit, g: null, shown: false, clay: [], clayVis: [], faceless: false, reason: null };
}

/** Face shown or faceless (head keeps its shape, plain neutral material, no lashes or brows). */
export function applyFace(skin, faceless) {
  const k = skin.kit;
  const mats = k.materials.map((m) => {
    const c = C.faceChoice(m.userData.role, faceless);
    return c === "neutral" ? k.faceless.neutral : c === "hide" ? k.faceless.hidden : m;
  });
  skin.mesh.material = Array.isArray(skin.mesh.material) ? mats : mats[0];
  skin.faceless = !!faceless;
}

/** Show the avatar (clay meshes hidden) or the clay (avatar hidden). Only on a change, and the clay comes back with
 *  exactly the visibility it had, so nothing else that hides clay parts is overridden.
 *  The holder is IN the clay group g only while it shows. While the person is clay it is taken out, because
 *  Box3.setFromObject ignores visibility: a hidden, never-placed holder (centimetres at 1 unit = 1 m) inside g made a
 *  clay person's bounds about 135 x 182 x 34 m and broke picking, drop targets, framing, measure and dragging. */
export function setShown(skin, on) {
  on = !!on;
  if (on === skin.shown) return;
  if (on) {
    skin.clayVis = skin.clay.map((m) => m.visible);
    for (const m of skin.clay) m.visible = false;
  } else {
    skin.clay.forEach((m, i) => { m.visible = skin.clayVis[i] ?? true; });
  }
  skin.holder.traverse((o) => { if (o.isMesh) o.visible = on; });
  if (on) { if (skin.g && skin.holder.parent !== skin.g) skin.g.add(skin.holder); }
  else skin.holder.removeFromParent();
  skin.shown = on;
}

/** Put the avatar on the stage: inside the clay group g while shown (so it moves, hides and is removed with it), but posed in
 *  world space at the actor's ground position and heading only; the clay's walk lean, bank and bob are not copied
 *  (the clip has its own). */
const _m = new THREE.Matrix4(), _w = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);
export function placeHolder(g, holder, { x, y, z, yaw, scale }) {
  g.updateMatrixWorld(true);
  _w.compose(_p.set(x, y, z), _q.setFromAxisAngle(_y, yaw), _s.setScalar(scale));
  if (g.parent) _w.premultiply(g.parent.matrixWorld);
  _m.copy(g.matrixWorld).invert().multiply(_w);
  _m.decompose(holder.position, holder.quaternion, holder.scale);
}

/** Pose the avatar for this frame: weights by speed, walk and run on one shared gait phase (avatarcore.gaitTable). */
export function drive(skin, { frame, fps, speed, phase, seed }) {
  const w = C.clipWeights(speed);
  const meta = {};
  for (const k of C.CLIP_KINDS) if (skin.kit.clips[k]) meta[k] = { duration: skin.kit.clips[k].clip.duration };
  const t = C.clipTimes({ frame, fps, phase, seed }, meta);
  for (const [k, act] of Object.entries(skin.actions)) {
    act.enabled = w[k] > 1e-4;
    act.setEffectiveWeight(w[k]);
    act.time = t[k] ?? 0;
  }
  skin.mixer.update(0);
  skin.weights = w;
}

/** The strides (m per loop) of a kit's walk and run at this scale. */
export const kitStrides = (kit, scale) => ({ walk: (kit.clips.walk?.travel || 120) * scale, run: (kit.clips.run?.travel || 210) * scale });

/** Resolves when every lifelike body that started loading has been put on (or given up). captureSequence awaits it
 *  so a capture never starts clay and turns lifelike partway. ms caps the wait (a stalled download keeps clay). */
export function avatarsReady(ms = 8000) {
  if (!inflight.size) return Promise.resolve();
  return Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, ms))]);
}

/** Give the clay figure g of actor a its lifelike body from a loaded kit (exported for the node test). The holder is
 *  not added to g here: setShown adds it when the person can show it (avatarsAt, run by setFrame). */
export function attachKit(stage, a, g, kit) {
  if (stage.actorMeshes.get(a.id) !== g || g.userData.humanSkin) return null;
  if (kit.report?.missingMaps?.length && !kit._mapWarned) {
    kit._mapWarned = true;
    console.warn("Soundstage: avatar materials without a colour map", kit.meshName, kit.report.missingMaps);
  }
  const skin = instantiate(kit, a);
  g.traverse((o) => { if (o.isMesh && !o.userData.avatar) skin.clay.push(o); });
  skin.g = g;
  applyFace(skin, a.face === "faceless");
  g.userData.humanSkin = skin;
  stage.setFrame(stage.frame);
  return skin;
}

/** stage._buildSet hook: give a person the lifelike body once its files load; clay stays on any failure. */
export function upgradeHuman(stage, a, g) {
  const spec = C.avatarSpecFor(a);
  if (!spec || !g?.userData?.joints) return;
  if (typeof window === "undefined" || typeof window.document?.createElement !== "function") return;   // node tests: clay only
  const attach = (kit) => attachKit(stage, a, g, kit);
  const job = loadKit(spec).then((kit) => {
    // Mid-capture (a frame-exact sprite sheet is being drawn): never swap the body under it. Put it on afterwards.
    if (stage._capturing) (stage._afterCapture ||= []).push(() => attach(kit));
    else attach(kit);
  }).catch((err) => {
    if (warned) return;
    warned = true;
    console.info("Soundstage: lifelike people not installed (web/stage/people/rocketbox), people stay clay:", err?.message || err);
  }).finally(() => inflight.delete(job));
  inflight.add(job);
}

/** The ground positions [x, z] of an actor for every frame 0..last (for the gait table). */
function groundPath(stage, a, last) {
  const out = new Array(last + 1);
  for (let f = 0; f <= last; f++) { const p = stage._actorPosAt(a, f); out[f] = [p[0], p[2]]; }
  return out;
}

/** stage.setFrame hook (after gaze, before held props): show and pose every lifelike person, or keep the clay. */
export function avatarsAt(stage) {
  const actors = stage.state.actors || [];
  let users = null;
  const fps = stage.state.shot?.fps || 24, last = stage._lastFrame(), f = stage.frame;
  const blocking = stage.state.people_look === "blocking";
  const memo = (stage._avatarDriven ||= { shot: undefined, ids: new Set() });
  for (const a of actors) {
    const g = stage.actorMeshes.get(a.id), skin = g?.userData.humanSkin;
    if (!skin) continue;
    users ||= C.propUsers(actors);
    if (skin.faceless !== (a.face === "faceless")) applyFace(skin, a.face === "faceless");
    const wet = !!(stage.water || stage.setFx?.underwater);
    const reason = C.clayReason(a, {
      blocking, holders: users.holders, carriers: users.carriers, gazeKeyed: gazeKeys(a).length > 0,
      swims: wet && C.swimsInShot(a, () => stage._swimPlan?.(a, g)),
      driven: C.drivenInShot(memo, stage.state.active_shot, a.id, stage.drive),
    });
    skin.reason = reason;
    setShown(skin, !reason);
    if (reason) continue;
    const p = stage._actorPosAt(a, f), y = stage._heightAt(a, f), yaw = stage._headingAt(a, f);
    const scale = C.statureScale(C.clayHeight(a) * (a.scale || 1), skin.kit.stature);
    // Speed and the shared gait phase for the whole shot, cached until the path, the length or the size changes.
    const keys = stage._actorKeys(a);
    const sig = `${last}|${fps}|${scale}|${JSON.stringify(keys)}`;
    if (skin.gait?.sig !== sig) {
      const path = keys.length > 1 ? groundPath(stage, a, last) : new Array(last + 1).fill([p[0], p[2]]);
      skin.gait = { sig, ...C.gaitTable(path, fps, kitStrides(skin.kit, scale)) };
    }
    const i = Math.max(0, Math.min(last, f));
    placeHolder(g, skin.holder, { x: p[0], y: y - (skin.kit.floor || 0) * scale, z: p[2], yaw, scale });
    drive(skin, { frame: f, fps, speed: skin.gait.speed[i] || 0, phase: skin.gait.phase[i] || 0, seed: C.phaseSeed(a.id) });
  }
}
