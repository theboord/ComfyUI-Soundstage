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
  return {
    template: model, meshName: keep.name, materials, faceless: { neutral, hidden }, clips: prepared, hipUnits,
    report: { meshes: list.map((m) => m.name), kept: keep.name, lightsRemoved: lights.length, missingMaps: C.missingColorMaps(materials),
      unbound: Object.fromEntries(C.CLIP_KINDS.map((k) => [k, prepared[k]?.missing || null])), texErrors },
  };
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
  return { holder, model, mesh, mixer, actions, bones, kit, shown: false, clay: [], clayVis: [], faceless: false, reason: null };
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
 *  exactly the visibility it had, so nothing else that hides clay parts is overridden. */
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
  skin.shown = on;
}

/** Put the avatar on the stage: inside the clay group g (so it moves, hides and is removed with it), but posed in
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

/** Pose the avatar for this frame: weights by speed, times by frame and distance (avatarcore.clipTimes). */
export function drive(skin, { frame, fps, speed, dist, scale, seed }) {
  const w = C.clipWeights(speed);
  const meta = {};
  for (const k of C.CLIP_KINDS) {
    const c = skin.kit.clips[k];
    if (c) meta[k] = { duration: c.clip.duration, stride: (c.travel || 100) * scale };
  }
  const t = C.clipTimes({ frame, fps, dist, seed }, meta);
  for (const [k, act] of Object.entries(skin.actions)) {
    act.enabled = w[k] > 1e-4;
    act.setEffectiveWeight(w[k]);
    act.time = t[k] ?? 0;
  }
  skin.mixer.update(0);
  skin.weights = w;
}

/** stage._buildSet hook: give a person the lifelike body once its files load; clay stays on any failure. */
export function upgradeHuman(stage, a, g) {
  const spec = C.avatarSpecFor(a);
  if (!spec || !g?.userData?.joints) return;
  if (typeof window === "undefined" || typeof window.document?.createElement !== "function") return;   // node tests: clay only
  loadKit(spec).then((kit) => {
    if (stage.actorMeshes.get(a.id) !== g || g.userData.humanSkin) return;
    if (kit.report.missingMaps.length && !kit._mapWarned) {
      kit._mapWarned = true;
      console.warn("Soundstage: avatar materials without a colour map", kit.meshName, kit.report.missingMaps);
    }
    const skin = instantiate(kit, a);
    g.traverse((o) => { if (o.isMesh && !o.userData.avatar) skin.clay.push(o); });
    g.add(skin.holder);
    applyFace(skin, a.face === "faceless");
    g.userData.humanSkin = skin;
    stage.setFrame(stage.frame);
  }).catch((err) => {
    if (warned) return;
    warned = true;
    console.info("Soundstage: lifelike people not installed (web/stage/people/rocketbox), people stay clay:", err?.message || err);
  });
}

/** stage.setFrame hook (after gaze, before held props): show and pose every lifelike person, or keep the clay. */
export function avatarsAt(stage) {
  const actors = stage.state.actors || [];
  let users = null;
  const fps = stage.state.shot?.fps || 24, last = stage._lastFrame(), f = stage.frame;
  const blocking = stage.state.people_look === "blocking";
  for (const a of actors) {
    const g = stage.actorMeshes.get(a.id), skin = g?.userData.humanSkin;
    if (!skin) continue;
    users ||= C.propUsers(actors);
    if (skin.faceless !== (a.face === "faceless")) applyFace(skin, a.face === "faceless");
    const reason = C.clayReason(a, {
      blocking, holders: users.holders, carriers: users.carriers, gazeKeyed: gazeKeys(a).length > 0,
      swims: !!(stage.water || stage.setFx?.underwater) && !!stage._swimPlan?.(a, g), driven: !!stage.drive?.owns?.(a.id),
    });
    skin.reason = reason;
    setShown(skin, !reason);
    if (reason) continue;
    const p = stage._actorPosAt(a, f), y = stage._heightAt(a, f), yaw = stage._headingAt(a, f);
    // Speed over about half a second around this frame, so a start or stop at a key crossfades instead of snapping.
    const keys = stage._actorKeys(a);
    let speed = 0;
    if (keys.length > 1) {
      const f0 = Math.max(0, f - 6), f1 = Math.min(last, f + 6);
      const q0 = stage._actorPosAt(a, f0), q1 = stage._actorPosAt(a, f1);
      speed = f1 > f0 ? Math.hypot(q1[0] - q0[0], q1[2] - q0[2]) / ((f1 - f0) / fps) : 0;
    }
    const scale = C.hipScale(C.clayHeight(a), skin.kit.hipUnits) * (a.scale || 1);
    placeHolder(g, skin.holder, { x: p[0], y, z: p[2], yaw, scale });
    drive(skin, { frame: f, fps, speed, dist: g.userData.travel || 0, scale, seed: C.phaseSeed(a.id) });
  }
}
