// Lifelike people on the stage: the Microsoft Rocketbox avatars (MIT) over the hidden logic rig (the old clay figure,
// now never drawn: Lifelike-only plan, L1).
//   - The rig stays in the scene as hidden logic (role:'logic'): gait, gaze, mounts, mocap, Drive, colliders and the ID
//     matte's picking read its joints.
//   - One motion (onemotion.mjs, retarget.mjs): each frame ONE source drives the visible body (the clip, the rig, or
//     the seat), and the rig is posed from the same motion, so Pose keypoints, held props, the gizmo and the feet agree.
//   - The avatar's clips: idle / walk / run, crossfaded by ground speed, walk and run locked to the distance travelled.
//   - Pure frame -> pose: given the stage frame the pose is always the same (no wall clock), as renders need.
//   - The asset files are NOT in the repo (web/stage/people/rocketbox/, see web/stage/people/README.md). Without
//     them every person shows as the marked stand-in (standin.mjs), never clay.
// Pure rules live in avatarcore.mjs (tested in node); this file loads, clones and drives.
import * as THREE from "../../vendor/three.module.min.mjs";
import { FBXLoader } from "../../vendor/addons/FBXLoader.mjs";
import * as SkeletonUtils from "../../vendor/addons/SkeletonUtils.mjs";
import { gazeKeys } from "../gaze.mjs";
import * as C from "./avatarcore.mjs";
import * as F from "./footplant.mjs";
import * as R from "./retarget.mjs";
import * as O from "./onemotion.mjs";
import { setStandIn } from "./standin.mjs";
import { lifelikeSet } from "../tier.mjs";

F.setCloner((o) => SkeletonUtils.clone(o));

export const ROCKETBOX_DIR = new URL("./rocketbox/", import.meta.url).href;
const TEX_DIR = `${ROCKETBOX_DIR}tex/`;
const kits = new Map();   // model name -> Promise<kit>; a failed load is dropped, so the next build tries again
const inflight = new Set();   // per-person upgrades still loading (captureSequence waits for them: no pop mid-capture)
let warned = false;
let kitRetryMs = 15000;   // a failed avatar load is shared by the builds of the next 15 s, then tried again
/** How long a failed avatar load is remembered before the next build tries again (ms; 0 = try again every build). */
export function setKitRetryMs(ms) { kitRetryMs = Math.max(0, Number(ms) || 0); }

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
  // Never cache a failure for long (a dropped connection, a half-copied install): a build KIT_RETRY_MS after a failure
  // loads again, but the builds of a quick run of edits share the failure instead of re-requesting the four FBX files
  // on every edit.
  p.catch(() => {
    if (kits.get(spec.model) !== p) return;
    if (!(kitRetryMs > 0)) { kits.delete(spec.model); return; }
    setTimeout(() => { if (kits.get(spec.model) === p) kits.delete(spec.model); }, kitRetryMs);
  });
  return p;
}

/**
 * Turn a parsed avatar FBX and its clips into a reusable kit (also used by the node fixture test):
 * the lights in the file removed, only the most detailed mesh kept, Phong turned into the Standard material the rest
 * of the set uses (same response to the sun; the specular maps are not used yet), lashes cut out by the PNG's alpha,
 * the clips prepared (rotations + root bob only), and checks recorded (kit.report). The lash / brow cards are split off
 * the hair's opacity material into their own "<id>_opacity_lashes" material (avatarcore.isFaceDetail), so Faceless can
 * hide them and keep the hair.
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
  const lashes = splitLashes(model, keep, materials);
  keep.material = Array.isArray(keep.material) ? materials : materials[0];
  const plain = new THREE.MeshStandardMaterial({ name: "faceless_head", color: 0xcfc6ba, roughness: 0.85, metalness: 0 });
  plain.userData.plain = true;
  const neutral = facelessHead(model, keep, materials) || plain;   // the face masked to skin, the painted hair kept
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
  // Foot grounding (footplant.mjs): the leg bones and sole vertices, found once in the bind pose, and each clip's own
  // standing sole height (the body offset follows the clip that plays, not only the idle's first frame).
  const feet = F.footRig(model, keep);
  const floors = F.clipFloors(model, prepared, feet);
  return {
    template: model, meshName: keep.name, materials, faceless: { neutral, hidden }, clips: prepared, hipUnits, stature, floor, idleBox, feet, floors,
    report: { meshes: list.map((m) => m.name), kept: keep.name, lightsRemoved: lights.length, missingMaps: C.missingColorMaps(materials), lashTriangles: lashes,
      unbound: Object.fromEntries(C.CLIP_KINDS.map((k) => [k, prepared[k]?.missing || null])), texErrors },
  };
}

/** Move the lash / brow triangles of the opacity (card) material into a material of their own, a copy of the card
 *  material named "<card>_lashes" (role "lashes"), appended to materials. Done in the bind pose on the template, so
 *  every clone shares the split geometry. Returns the number of triangles moved (0: no copy is added). */
function splitLashes(model, mesh, materials) {
  const card = materials.findIndex((m) => m.userData.role === "opacity");
  const L = model.getObjectByName("Bip01_LEye"), R = model.getObjectByName("Bip01_REye");
  if (card < 0 || !L || !R || !Array.isArray(mesh.material) || !mesh.geometry.groups.length) return 0;
  model.updateMatrixWorld(true);
  const lE = L.getWorldPosition(new THREE.Vector3()), rE = R.getWorldPosition(new THREE.Vector3());
  const idx = mesh.geometry.index, v = new THREE.Vector3(), c = new THREE.Vector3();
  const vertex = (i) => (idx ? idx.getX(i) : i);
  const lashIndex = materials.length;
  const moved = C.splitGroups(mesh.geometry, (mi) => mi === card, lashIndex, (i) => {
    c.set(0, 0, 0);
    for (let j = 0; j < 3; j++) { mesh.getVertexPosition(vertex(i + j), v); c.add(v.applyMatrix4(mesh.matrixWorld)); }
    return C.isFaceDetail(c.divideScalar(3), lE, rE);
  });
  if (moved) {
    const lash = materials[card].clone();
    lash.name = `${materials[card].name}_lashes`;
    lash.userData = { role: "lashes" };
    materials.push(lash);
  }
  return moved;
}

/**
 * The Faceless head material: the head's own texture (so the hair Rocketbox paints on the scalp stays), with the face
 * region (avatarcore.faceMaskAt, a per-vertex "faceMask" attribute computed once in the bind pose) painted one flat
 * skin colour, sampled (blurred) from the avatar's own cheek. No brows, eyes, lips or eyeball detail; the head keeps
 * its shape and the skin tone matches the neck and forehead. null when the eyes or the head map are missing (the
 * plain mannequin material is used then).
 */
function facelessHead(model, mesh, materials) {
  const hi = materials.findIndex((m) => m.userData.role === "head");
  const L = model.getObjectByName("Bip01_LEye"), R = model.getObjectByName("Bip01_REye");
  const head = materials[hi];
  if (hi < 0 || !head?.map || !L || !R || !Array.isArray(mesh.material)) return null;
  model.updateMatrixWorld(true);
  const lE = L.getWorldPosition(new THREE.Vector3()), rE = R.getWorldPosition(new THREE.Vector3()), sp = lE.distanceTo(rE);
  const geo = mesh.geometry, n = geo.attributes.position.count, uv = geo.attributes.uv, idx = geo.index;
  if (!uv) return null;
  const mask = new Float32Array(n), v = new THREE.Vector3();
  // the cheek the skin colour is sampled from: under the left eye, a little out and forward
  const cheek = lE.clone().add(new THREE.Vector3(0.15 * sp, -0.9 * sp, 0.1 * sp));
  let best = Infinity, skinUv = null;
  for (const g of geo.groups) {
    if (g.materialIndex !== hi) continue;
    for (let i = g.start; i < g.start + g.count; i++) {
      const k = idx ? idx.getX(i) : i;
      mesh.getVertexPosition(k, v).applyMatrix4(mesh.matrixWorld);
      mask[k] = C.faceMaskAt(v, lE, rE);
      const d = mask[k] > 0.99 ? v.distanceTo(cheek) : Infinity;
      if (d < best) { best = d; skinUv = [uv.getX(k), uv.getY(k)]; }
    }
  }
  if (!skinUv) return null;
  geo.setAttribute("faceMask", new THREE.BufferAttribute(mask, 1));
  const m = head.clone();
  m.name = "faceless_head";
  m.userData = { role: "head", faceless: true, skinUv };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSkinUv = { value: new THREE.Vector2(...skinUv) };
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float faceMask;\nvarying float vFaceMask;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFaceMask = faceMask;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vFaceMask;\nuniform vec2 uSkinUv;")
      .replace("#include <map_fragment>", "#include <map_fragment>\n#ifdef USE_MAP\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, texture2D( map, uSkinUv, 3.0 ).rgb, vFaceMask );\n#endif");
  };
  m.customProgramCacheKey = () => "ss-faceless-head";
  return m;
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
  return { holder, model, mesh, mixer, actions, bones, legs: F.legBones(bones, kit.feet), kit, g: null, shown: false, clay: [], clayVis: [], faceless: false, reason: null };
}

/** Face shown or faceless (head keeps its shape, plain neutral material, no lashes or brows; the hair stays). */
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
const _qt = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _w = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0);
export function placeHolder(g, holder, { x, y, z, yaw, scale, tilt = null }) {
  g.updateMatrixWorld(true);
  _q.setFromAxisAngle(_y, yaw);
  if (tilt) _q.multiply(_qt.set(tilt[0], tilt[1], tilt[2], tilt[3]).normalize());   // a small saved tilt (not knocked over): the body leans with the rig
  _w.compose(_p.set(x, y, z), _q, _s.setScalar(scale));
  if (g.parent) _w.premultiply(g.parent.matrixWorld);
  _m.copy(g.matrixWorld).invert().multiply(_w);
  _m.decompose(holder.position, holder.quaternion, holder.scale);
}

/** Pose the avatar for this frame: weights by speed, walk and run on one shared gait phase (avatarcore.gaitTable). */
export function drive(skin, { frame, fps, speed, phase, seed }) {
  // the clip's own values back before the mixer writes (three's PropertyMixer skips a value equal to the one it wrote
  // last): the feet's IK (ikSaved) and everything one motion writes over the clip (rtSaved: retarget, sitBody, blend)
  F.restoreClipPose(skin.ikSaved);
  F.restoreClipPose(skin.rtSaved);
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
  // what the mixer just wrote, for the next drive (see above)
  // (every bone: a handover blends them all, avatarsAt blendCaptures)
  const saved = (skin.rtSaved ||= []);
  for (const b of Object.values(skin.bones)) saved.push([b, "quaternion", b.quaternion.clone()]);
  if (skin.bones?.Bip01) saved.push([skin.bones.Bip01, "position", skin.bones.Bip01.position.clone()]);
}

// ---------------------------------------------------------------- sitting (stage.setPose "sit" / "sit_floor")
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const SIT_BONES = ["Bip01_L_Thigh", "Bip01_L_Calf", "Bip01_L_Foot", "Bip01_R_Thigh", "Bip01_R_Calf", "Bip01_R_Foot"];
/** Turn bone b (in world space, axis-free) so its child c lies along world direction dir. */
function aimBone(b, c, dir) {
  b.updateWorldMatrix(true, true);
  b.getWorldPosition(_a); c.getWorldPosition(_b);
  const cur = _b.sub(_a).normalize();
  if (cur.lengthSq() < 1e-8) return;
  _qa.setFromUnitVectors(cur, _d.copy(dir).normalize());
  b.getWorldQuaternion(_qb);
  b.parent.getWorldQuaternion(_qc);
  b.quaternion.copy(_qc.invert().multiply(_qa.multiply(_qb)));
  b.updateWorldMatrix(false, true);
}
const boneLen = (b, c) => { b.updateWorldMatrix(true, true); return b.getWorldPosition(_a).distanceTo(c.getWorldPosition(_b)); };

/**
 * Fold a lifelike body (already placed and posed in its idle) into a seated pose, then move it so the hips land on
 * the seat: sit = stage._sitSpec(a) {pose: "sit" | "sit_floor", seat: [x, y, z] (the seat top or the floor), yaw};
 * heightM = the person's height. Bones are aimed in world space (no assumption about Rocketbox's local axes): "sit"
 * thighs level forward, shins straight down, hands on the thighs; "sit_floor" knees up, feet flat on the floor, hands
 * on the knees. The hip joints end ~0.10 m (at 1.8 m) above the seat. Returns the hips' world position, or null when
 * the body lacks the leg bones (then it is left in its idle).
 */
export function sitBody(skin, sit, heightM = 1.8) {
  const B = skin.bones || {};
  if (SIT_BONES.some((n) => !B[n])) return null;
  const s = heightM / 1.8, fwd = new THREE.Vector3(Math.sin(sit.yaw), 0, Math.cos(sit.yaw)), up = new THREE.Vector3(0, 1, 0);
  const floor = sit.pose === "sit_floor";
  for (const lr of ["L", "R"]) {
    const th = B[`Bip01_${lr}_Thigh`], ca = B[`Bip01_${lr}_Calf`], fo = B[`Bip01_${lr}_Foot`];
    if (!floor) {
      aimBone(th, ca, fwd.clone().addScaledVector(up, -0.05));
      aimBone(ca, fo, up.clone().negate().addScaledVector(fwd, 0.12));
    } else {
      const lt = boneLen(th, ca), lc = boneLen(ca, fo), ang = 0.62;   // thighs ~35 deg up from the floor
      aimBone(th, ca, fwd.clone().multiplyScalar(Math.cos(ang)).addScaledVector(up, Math.sin(ang)));
      const drop = Math.min(lc * 0.999, 0.10 * s + lt * Math.sin(ang) - 0.08 * s);   // knee down to the ankle near the floor
      aimBone(ca, fo, fwd.clone().multiplyScalar(Math.sqrt(Math.max(0, lc * lc - drop * drop))).addScaledVector(up, -drop));
    }
    const ua = B[`Bip01_${lr}_UpperArm`], fa = B[`Bip01_${lr}_Forearm`], ha = B[`Bip01_${lr}_Hand`];
    if (ua && fa && ha) {
      aimBone(ua, fa, floor ? fwd.clone().multiplyScalar(0.75).addScaledVector(up, -0.66) : fwd.clone().multiplyScalar(0.3).addScaledVector(up, -0.95));
      aimBone(fa, ha, floor ? fwd.clone().addScaledVector(up, 0.25) : fwd.clone().addScaledVector(up, -0.35));
    }
  }
  // Hips onto the seat: the midpoint of the two thigh roots to (seat, +0.10 m), a little back from the seat's centre
  // on a chair (people sit back, knees over the front edge).
  const hip = B.Bip01_L_Thigh.getWorldPosition(new THREE.Vector3()).add(B.Bip01_R_Thigh.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  const target = new THREE.Vector3(sit.seat[0], sit.seat[1] + 0.10 * s, sit.seat[2]).addScaledVector(fwd, floor ? 0 : -0.06 * s);
  const h = skin.holder, par = h.parent;
  if (par) {
    par.updateWorldMatrix(true, false);
    const wp = h.getWorldPosition(new THREE.Vector3()).add(target.clone().sub(hip));
    h.position.copy(par.worldToLocal(wp));
  } else h.position.add(target.clone().sub(hip));
  h.updateWorldMatrix(false, true);
  return target;
}

/** The strides (m per loop) of a kit's walk and run at this scale. */
export const kitStrides = (kit, scale) => ({ walk: (kit.clips.walk?.travel || 120) * scale, run: (kit.clips.run?.travel || 210) * scale });

/** How long a capture waits for lifelike bodies still loading (ms). A first load over a slow link can take a while
 *  (two ~10 MB FBX files and their textures). Per stage: stage.avatarWaitMs. */
export const AVATAR_WAIT_MS = 60000;

/** Resolves when every lifelike body that started loading has been put on (or given up): {ok, timedOut, pending,
 *  waitedMs, waited (something was loading), message}. captureSequence awaits it so a capture never starts clay and turns lifelike partway. ms caps
 *  the wait; on a timeout the message says so (the people still loading are the marked stand-in in this capture). */
export async function avatarsReady(ms = AVATAR_WAIT_MS) {
  const t0 = Date.now();
  if (!inflight.size) return { ok: true, timedOut: false, pending: 0, waitedMs: 0, waited: false, message: "" };
  let timer = null;
  const done = await Promise.race([
    Promise.allSettled([...inflight]).then(() => true),
    new Promise((r) => { timer = setTimeout(() => r(false), ms); }),
  ]);
  clearTimeout(timer);
  const pending = inflight.size, waitedMs = Date.now() - t0;
  if (done) return { ok: true, timedOut: false, pending: 0, waitedMs, waited: true, message: "" };
  const message = `People or models still loading after ${Math.round(ms / 1000)} s: ${pending} ${pending === 1 ? "is" : "are"} drawn as the marked stand-in in this capture. Press Run again once they show.`;
  console.warn("Soundstage:", message);
  return { ok: false, timedOut: true, pending, waitedMs, waited: true, message };
}

/** Pose everyone once, soon (one microtask later), unless a setFrame runs first: many people attaching in one go (a
 *  scene of ten loading together) cost one setFrame, not ten. */
export function requestFrame(stage) {
  if (stage._avatarFramePending) return;
  stage._avatarFramePending = true;
  queueMicrotask(() => {
    if (!stage._avatarFramePending) return;   // a setFrame already posed them (avatarsAt clears the flag)
    stage._avatarFramePending = false;
    stage.setFrame(stage.frame);
  });
}

/** Give the clay figure g of actor a its lifelike body from a loaded kit (exported for the node test). The holder is
 *  not added to g here: setShown adds it when the person can show it (avatarsAt, run by setFrame). */
export function attachKit(stage, a, g, kit) {
  if (stage.actorMeshes.get(a.id) !== g || g.userData.humanSkin) return null;
  // Still the same person wanting this model (no project load, no man-to-woman change while it loaded)?
  const cur = (stage.state?.actors || []).find((x) => x.id === a.id);
  if (!cur || (kit.spec?.model && C.avatarSpecFor(cur)?.model !== kit.spec.model)) return null;
  if (kit.report?.missingMaps?.length && !kit._mapWarned) {
    kit._mapWarned = true;
    console.warn("Soundstage: avatar materials without a colour map", kit.meshName, kit.report.missingMaps);
  }
  const skin = instantiate(kit, a);
  bindSkin(stage, skin, a, g);
  requestFrame(stage);
  return skin;
}

/** Put a skin (new or kept from the last build) on the clay group g: its clay meshes, its face, the stage's list. */
function bindSkin(stage, skin, a, g) {
  if (skin.shown) setShown(skin, false);
  skin.holder.removeFromParent();
  setStandIn(g, false);
  skin.clay = []; skin.clayVis = [];
  g.traverse((o) => { if (o.isMesh && !o.userData.avatar) { o.userData.role = "logic"; skin.clay.push(o); } });
  skin.holder.traverse((o) => { if (o.isMesh) o.userData.role = "look"; });
  skin.g = g;
  skin.reason = null;
  if (skin.faceless !== (a.face === "faceless") || !skin._faced) { applyFace(skin, a.face === "faceless"); skin._faced = true; }
  g.userData.humanSkin = skin;
  (stage._avatarSkins ||= new Map()).set(a.id, skin);
}

/** Every _buildSet makes new clay groups. A person whose avatar model is unchanged keeps the skin it had (the clone,
 *  its mixer, its gait table): no new clone, no extra setFrame (the build's own setFrame poses it). Returns the skin
 *  or null (a new one has to be made). */
export function reuseSkin(stage, a, g, spec) {
  const skin = stage._avatarSkins?.get(a.id);
  if (!skin || skin.kit?.spec?.model !== spec.model || stage.actorMeshes.get(a.id) !== g || g.userData.humanSkin) return null;
  bindSkin(stage, skin, a, g);
  requestFrame(stage);   // in case no setFrame follows this build (it normally does, and this then costs nothing)
  return skin;
}

/** stage._buildSet hook: give a person the lifelike body once its files load; the marked stand-in on any failure. */
export function upgradeHuman(stage, a, g) {
  const spec = C.avatarSpecFor(a);
  if (!spec || !g?.userData?.joints) return;
  if (reuseSkin(stage, a, g, spec)) return;
  const load = stage._loadKit || loadKit;   // stage._loadKit: a test's stand-in loader
  if (load === loadKit && (typeof window === "undefined" || typeof window.document?.createElement !== "function")) return;   // node tests: the stand-in
  // One wanted attach per person: a rebuild (or a model change) while the kit loads replaces the ticket, so only the
  // latest build's group gets a clone (N rebuilds during a first load: still one clone per person, never N).
  const ticket = { g, model: spec.model };
  (stage._avatarWant ||= new Map()).set(a.id, ticket);
  const attach = (kit) => {
    if (stage._avatarWant?.get(a.id) !== ticket) return null;   // a later build asked again: this one is stale
    stage._avatarWant.delete(a.id);
    return attachKit(stage, a, g, kit);
  };
  const job = Promise.resolve(load(spec)).then((kit) => {
    // Mid-capture (a frame-exact sprite sheet is being drawn): never swap the body under it. Put it on afterwards.
    if (stage._capturing) (stage._afterCapture ||= []).push(() => attach(kit));
    else attach(kit);
  }).catch((err) => {
    if (stage._avatarWant?.get(a.id) === ticket) { stage._avatarWant.delete(a.id); requestFrame(stage); }
    if (warned) return;   // a missing install is said once; the next build still tries again (loadKit caches no failure)
    warned = true;
    console.info("Soundstage: lifelike people not installed (web/stage/people/rocketbox), people show as marked stand-ins:", err?.message || err);
  });
  trackLoading(job);
}

/** How many lifelike bodies are still loading (a capture says it is waiting for them before it waits). */
export const loadingCount = () => inflight.size;

/** Count a body (or a horse / vehicle model, stage._upgradeHorse / _upgradeVehicle) still loading until it settles:
 *  avatarsReady waits for it. Returns the promise. */
export function trackLoading(job) {
  inflight.add(job);
  const done = () => inflight.delete(job);
  job.then(done, done);
  return job;
}

/** The ground positions [x, z] of an actor for every frame 0..last (for the gait table). */
function groundPath(stage, a, last) {
  const out = new Array(last + 1);
  for (let f = 0; f <= last; f++) { const p = stage._actorPosAt(a, f); out[f] = [p[0], p[2]]; }
  return out;
}

/** stage.setFrame hook (after gaze, before held props): pose every lifelike person from this frame's ONE motion
 *  source (onemotion.mjs), and the clay logic rig with it. The body never swaps to clay (Lifelike-only plan, L1). */
export function avatarsAt(stage) {
  stage._avatarFramePending = false;   // posed now: a requested frame (requestFrame) isn't needed any more
  // a second run in the same frame (markLiveTilt) starts from the stage's own clay pose, not from this hook's writes
  undoAvatarWrites(stage);
  const undo = (stage._rigUndo ||= []);
  const actors = stage.state.actors || [];
  const skins = stage._avatarSkins;
  // Drop skins no person uses any more: deleted (even with one added in the same build), turned into a non-person,
  // or left on an old clay group (a rebuild that gave this person a different model). Clones share the kit's
  // geometry and textures, so dropping one frees its clone, mixer and gait table.
  if (skins?.size) for (const [id, skin] of skins) {
    if (stage.actorMeshes.get(id)?.userData?.humanSkin === skin) continue;
    if (skin.shown) setShown(skin, false);
    skin.holder?.removeFromParent();
    skin.mixer?.stopAllAction?.();
    skins.delete(id);
  }
  let users = null;
  const fps = stage.state.shot?.fps || 24, last = stage._lastFrame(), f = stage.frame;
  // the tier's cap on lifelike people per shot (tier.mjs, plan 4.5): the first N in the scene's order, the rest the
  // marked stand-in (the same set on every frame)
  const capped = lifelikeSet(actors.filter((x) => stage.actorMeshes.get(x.id)?.userData.humanSkin).map((x) => x.id), stage.tier || "T1");
  for (const a of actors) {
    const g = stage.actorMeshes.get(a.id), skin = g?.userData.humanSkin;
    if (!skin) { if (g && C.PERSON_KINDS.has(a.kind)) markStandIn(stage, a, g); continue; }
    if (!capped.has(a.id)) { if (skin.shown) setShown(skin, false); skin.reason = "over the tier's lifelike cap"; skin.owner = "standin"; setStandIn(g, true); continue; }
    setStandIn(g, false);
    users ||= C.propUsers(actors);
    if (skin.faceless !== (a.face === "faceless")) applyFace(skin, a.face === "faceless");
    const wet = !!(stage.water || stage.setFx?.underwater);
    const floats = !!stage._floatsInShot?.(a);   // a video mocap take in water too deep to stand in (stage._waterPhysics)
    const tipped = tippedNow(g);
    // whole-shot facts (the scene and the live Drive state now, no memo), then each frame's own
    const shot = O.rigShotReason(a, { driven: C.drivenNow(stage.drive, a.id) });
    const physFrom = O.physicsFrom(a);
    const factsAt = (i) => ({ physics: i >= physFrom, mount: stage._mountPhaseAt?.(a, i) ?? null, sits: !!stage._sitSpec?.(a, i), swims: wet && swimsNow(stage, a, g, i), exits: wet && exitsNow(stage, a, g, i), floats, airborne: airAt(stage, a, i) });
    const kind = (i) => O.ownerAt(shot, factsAt(i)).own;
    const fr = factsAt(f);
    // a live knock-over (the physics drag): the rig at once (not a recorded take, so no ease)
    const here = tipped ? { own: "rig", reason: "is tipped over" } : O.ownerAt(shot, fr);
    const mix = tipped ? { own: "rig", w: { clip: 0, rig: 1, seat: 0 }, prevAt: -1, nextAt: -1 } : O.ownerMix(f, kind, last);
    skin.reason = null;   // never clay: the body below is always the lifelike one
    setShown(skin, true);
    // The grounding gate is the feet, not the look (C.feetUpReason), per frame.
    skin.feetUp = C.feetUpReason(a, { physics: fr.physics, tipped, floats, sits: fr.sits, swims: fr.swims, airborne: fr.airborne, mounted: !!fr.mount && fr.mount !== "walk" });
    const { scale } = ensureGait(stage, a, skin, { last, fps, f });
    skin.owner = mix.own; skin.ownerReason = here.reason; skin.rigWeight = mix.w.rig; skin.mix = { ...mix.w };
    const ctx = { fps, scale, last, f };
    // the rig's frames on the feet (Drive, a mocap take, a hop, getting on): the visible soles grounded too (groundRig)
    const groundsRig = !tipped && GROUNDED_RIG.has(here.reason);
    // (a horse climb: its foot leaves the ground for the stirrup within two frames, and the match to the clay's shoe,
    // faded out over 5-25 cm of the shoe's height, put a 24 cm/frame^2 jolt into the pelvis; there the body is only
    // lifted out of the ground, which goes to nothing as the sole rises)
    // (into a vehicle seat: the stage swings the clay's shins forward onto the cabin floor over the hop, its shoes up
    // 36 cm in a few frames, and the match faded out with them: the visible pelvis 12.5 cm/frame^2; lifted out only)
    const liftOnly = groundsRig && here.reason === "gets on a mount" && (climbsHorse(stage, a) || stage._cabinFloorY?.(a, f) != null);
    // off the feet (knocked over, physics, tipped live): the whole body kept out of the ground (groundBody)
    const liesRig = tipped || LYING_RIG.has(here.reason);
    // (a hop's frames ease into the seat of the first seated frame after them, or out of the last one before)
    const seatSpec = () => stage._sitSpec?.(a, mix.own === "seat" ? f : mix.prev === "seat" ? mix.prevAt : mix.nextAt) || null;
    const srcs = ["rig", "seat", "clip"].filter((k) => mix.w[k] > 1e-9);
    if (srcs.length === 1) {   // one owner at full weight: posed straight in place
      evalSource(srcs[0], stage, a, g, skin, ctx, undo, { groundsRig, liftOnly, liesRig, seatSpec });
    } else {
      // a handover frame: each source posed on its own (its moves of the logic rig undone), then blended
      const caps = [];
      for (const k of srcs) {
        const local = [];
        const off = evalSource(k, stage, a, g, skin, ctx, local, { groundsRig, liftOnly, liesRig, seatSpec });
        caps.push({ w: mix.w[k], cap: capture(skin, off) });
        R.undoRig(local);
        g.updateMatrixWorld(true);
      }
      blendCaptures(skin, g, caps, undo);
      // (a fall's first frames: the walking clip blended into the tipping rig went 2.6 cm into the floor) lifted out
      if (liesRig) groundBody(stage, a, g, skin, f, undo, true);
    }
    // the rig is the source: the body follows it; only the rig's joints are put on the body's (its proportions)
    if (mix.w.rig >= 1) { fitRig(g, skin, undo); continue; }
    if (mix.own === "seat" && mix.w.seat >= 1) { solveRig(stage, skin, g, null, undo); continue; }
    // layers over the clip: gaze turns the head, Pose keys the joints they name, a carrier's arms hold the load
    const layer = O.layerJoints({ gazeKeyed: gazeKeys(a).length > 0, poseJoints: O.poseKeyJoints(a), carries: users.carriers.has(a.id) }, R.layerable);
    // the rig follows the body first (its layered joints left as the stage posed them), then the layered bones follow
    // those joints, which now hang off the solved parents (a Pose key is a turn relative to its parent)
    solveRig(stage, skin, g, layer, undo);
    if (layer.size) { R.retargetFromRig(skin, g, { only: layer }); fitRig(g, skin, undo); }   // (the layered bones moved: the rig's joints back on them)
  }
}

/** Does this person climb onto a horse they ride (a timed mount_at: Gait.mountMotion)? A whole-shot fact. */
function climbsHorse(stage, a) {
  if (!(a.mount_at > 0) || !a.mount_id) return false;
  const host = stage.state?.actors?.find((x) => x.id === a.mount_id);
  return host?.kind === "horse" && (a.pose || "ride") === "ride";
}

/** The rig's reasons with the body off its feet on the ground (lying, tipped, tumbling): kept out of it (groundBody). */
const LYING_RIG = new Set(["was knocked over", "is moved by physics", "is tipped over"]);

/** The rig's reasons with the feet on the ground (or about to be): its visible soles are grounded (groundRig). */
const GROUNDED_RIG = new Set(["is driven live", "plays a video mocap take", "is in the air (a jump or vault)", "gets on a mount", "gets off a mount", "climbs out of the water"]);

/**
 * Pose the body from one motion source at this frame. Returns the logic rig's offset this source moved it by (world
 * x / y / z: the clip's sideways shift, the rig's grounding lift), already applied (and on undo).
 */
function evalSource(k, stage, a, g, skin, { fps, scale, last, f }, undo, { groundsRig, liftOnly = false, liesRig, seatSpec }) {
  if (k === "rig") {
    poseFromRig(stage, a, g, skin, f, { fps, scale });
    const dy = groundsRig ? groundRig(stage, a, g, skin, f, undo, liftOnly) : liesRig ? groundBody(stage, a, g, skin, f, undo) : 0;
    cabinFeet(stage, a, g, skin, f, undo);
    return new THREE.Vector3(0, dy, 0);
  }
  if (k === "seat") {
    const sit = seatSpec();
    skin.footOut = null;
    if (!sit) { poseRaw(stage, a, g, skin, f, { fps, scale, last }); return new THREE.Vector3(); }
    placeHolder(g, skin.holder, { x: sit.seat[0], y: sit.seat[1] - F.floorFor(skin.kit, C.clipWeights(0)) * scale, z: sit.seat[2], yaw: sit.yaw, scale });
    drive(skin, { frame: f, fps, speed: 0, phase: 0, seed: C.phaseSeed(a.id) });
    sitBody(skin, sit, C.clayHeight(a) * (a.scale || 1));
    if (sit.pose === "sit") seatedFeetDown(stage, a, g, skin, f, sit);
    return new THREE.Vector3();
  }
  poseFromClip(stage, a, g, skin, f, { fps, scale, last, undo });
  // a lean the clip keeps (under onemotion.KNOCK_DEG) tips the planted sole off the ground the foot plan put it on (a
  // 29-degree walker's lowest sole up to 15 cm up): the body and the rig moved down (or up) onto it
  const dy = O.tiltDeg(a) > 3 && !O.knockedOver(a) ? soleOnGround(stage, a, g, skin, f, undo) : 0;
  return new THREE.Vector3(skin.shift?.[0] || 0, dy, skin.shift?.[1] || 0);
}

const _cq = new THREE.Quaternion(), _cv = new THREE.Vector3();
/** The body's pose right now, for a blend: the holder in world space, every bone's local turn, the root bone's place,
 *  and the logic rig offset (off) the source applied. */
function capture(skin, off) {
  skin.holder.updateWorldMatrix(true, false);
  return {
    hp: skin.holder.getWorldPosition(new THREE.Vector3()), hq: skin.holder.getWorldQuaternion(new THREE.Quaternion()),
    b: Object.values(skin.bones).map((x) => x.quaternion.clone()), root: skin.bones.Bip01?.position.clone() || null, off,
  };
}

/** Write the weighted blend of captures (each {w, cap}) into the body: the logic rig moved by the blended offset, the
 *  holder's world place and turn, every bone, the root bone. Weights sum to 1. */
function blendCaptures(skin, g, caps, undo) {
  const off = new THREE.Vector3();
  for (const { w, cap } of caps) off.addScaledVector(cap.off, w);
  if (off.lengthSq() > 1e-14) moveBody(g, skin.holder, off.x, off.y, off.z, undo);
  const hp = caps[0].cap.hp.clone(), hq = caps[0].cap.hq.clone(), root = caps[0].cap.root?.clone() || null;
  const bq = caps[0].cap.b.map((q) => q.clone());
  let tot = caps[0].w;
  for (let i = 1; i < caps.length; i++) {
    const { w, cap } = caps[i], t = w / (tot + w);
    hp.lerp(cap.hp, t); hq.slerp(cap.hq, t);
    if (root && cap.root) root.lerp(cap.root, t);
    for (let k = 0; k < bq.length; k++) bq[k].slerp(cap.b[k], t);
    tot += w;
  }
  const bones = Object.values(skin.bones);
  bones.forEach((b, k) => b.quaternion.copy(bq[k]));
  if (root) skin.bones.Bip01.position.copy(root);
  const h = skin.holder, par = h.parent;
  if (par) {
    par.updateWorldMatrix(true, false);
    h.position.copy(par.worldToLocal(hp));
    h.quaternion.copy(par.getWorldQuaternion(_cq).invert().multiply(hq));
  } else { h.position.copy(hp); h.quaternion.copy(hq); }
  h.updateMatrixWorld(true);
}

/** The clay figure's foot boxes (the shoe the hidden logic rig stands on), cached on the group. */
function clayFeet(g) {
  if (g.userData._clayFeet !== undefined) return g.userData._clayFeet;
  const J = g.userData.joints || {}, out = [];
  for (const lr of ["l", "r"]) for (const c of J[`${lr}_knee`]?.children || []) if (c.isMesh && c.geometry?.type === "BoxGeometry") out.push(c);
  return (g.userData._clayFeet = out.length === 2 ? out : null);
}

/** The walkable ground under (x, z) at frame f for this person (the set's support shapes or the set floor, and a dock
 *  or deck's height table), the surface footPlanFor plants on. */
function groundFn(stage, a, g, f) {
  const shapes = stage.root ? stage._supportShapes?.() : null;
  const by = bodyY(stage, a, g, f), ok = stage._standOnKeys?.(a, g, f) ?? -Infinity, floorAt = stage.setFx?.floorAt;
  return (x, z) => Math.max(shapes ? stage._supportAt(x, z, by, 0.6, shapes) : Math.max(0, floorAt?.(x, z) || 0), ok);
}

const _gb = new THREE.Box3(), _gc = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
const smooth01 = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
/**
 * The rig owns a frame on the feet (Drive, a mocap take, a hop, getting on): the visible body was retargeted from the
 * logic rig, but its legs are not the clay's length and its shoes not the clay's boxes, so its soles can hover or sink
 * (a Drive walker's lowest shoe -6 to +13 cm, a 1-degree-tilt walker -6 to +12). Here the body AND the logic rig move
 * up or down together so the visible lowest sole is as high over the ground as the clay's lowest shoe (never under the
 * ground), fully while the clay's shoe is within 5 cm of the ground and not at all above 25 cm (a jump's apex, a
 * saddle: the rig's own height), smoothly between; a foot still under the ground is lifted out of it (two-bone IK).
 * Returns the vertical move (m).
 */
function groundRig(stage, a, g, skin, f, undo, liftOnly = false) {
  const rig = skin.kit.feet, boxes = clayFeet(g);
  if (!rig || !skin.legs || !boxes) return 0;
  const ground = groundFn(stage, a, g, f);
  g.updateMatrixWorld(true);
  let clayLow = Infinity;
  for (const m of boxes) { _gb.setFromObject(m, true); _gb.getCenter(_gc); clayLow = Math.min(clayLow, _gb.min.y - ground(_gc.x, _gc.z)); }
  skin.holder.updateMatrixWorld(true);
  const low = {};
  let visLow = Infinity;
  for (const lr of ["l", "r"]) {
    const p = F.solePoints(skin.mesh, rig[lr]);
    let m = Infinity;
    for (let i = 0; i < p.length; i += 3) m = Math.min(m, p[i + 1] - ground(p[i], p[i + 2]));
    low[lr] = m; visLow = Math.min(visLow, m);
  }
  const k = C.clayHeight(a) * (a.scale || 1) / 1.8;
  const c = 1 - smooth01((clayLow - 0.05 * k) / (0.20 * k));
  if (!(c > 0) || !Number.isFinite(visLow) || !Number.isFinite(clayLow)) return 0;
  const dy = liftOnly ? Math.max(0, -visLow) : (Math.max(0, clayLow) - visLow) * c;
  if (Math.abs(dy) > 1e-7) moveBody(g, skin.holder, 0, dy, 0, undo);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(skin.holder.getWorldQuaternion(new THREE.Quaternion()));
  for (const lr of ["l", "r"]) {
    const under = -(low[lr] + dy) * c;
    if (!(under > 1e-4)) continue;
    const B = skin.legs[lr];
    B.foot.updateWorldMatrix(true, false);
    F.twoBoneIK(B.thigh, B.calf, B.foot, B.foot.getWorldPosition(new THREE.Vector3()).addScaledVector(UPV, under), B.foot.getWorldQuaternion(new THREE.Quaternion()), fwd);
  }
  skin.holder.updateMatrixWorld(true);
  return dy;
}

/** Seated on a chair: sitBody hangs the shins straight down from level thighs, so on a seat lower than the shins the
 *  soles hovered 4-5 cm. Each thigh is tipped down just enough for its sole to reach the ground under it (its knee as
 *  much lower as the sole was up, at most 8 cm; sitBody's own 5% droop folded in), the shin straight down again: the
 *  hips stay on the seat. Never lifted (on the ground already), and a high seat's feet (over 8 cm up) are left hanging
 *  lower by those 8 cm. */
function seatedFeetDown(stage, a, g, skin, f, sit) {
  const rig = skin.kit.feet, B = skin.bones || {};
  if (!rig || !skin.mesh) return;
  const ground = groundFn(stage, a, g, f), fwd = new THREE.Vector3(Math.sin(sit.yaw), 0, Math.cos(sit.yaw)), up = new THREE.Vector3(0, 1, 0);
  for (const lr of ["L", "R"]) {
    const th = B[`Bip01_${lr}_Thigh`], ca = B[`Bip01_${lr}_Calf`], fo = B[`Bip01_${lr}_Foot`];
    if (!th || !ca || !fo) continue;
    skin.holder.updateMatrixWorld(true);
    const p = F.solePoints(skin.mesh, rig[lr === "L" ? "l" : "r"]);
    let lo = Infinity;
    for (let i = 0; i < p.length; i += 3) lo = Math.min(lo, p[i + 1] - ground(p[i], p[i + 2]));
    if (!(lo > 1e-3) || !Number.isFinite(lo)) continue;
    const lt = boneLen(th, ca);
    th.updateWorldMatrix(true, true); ca.updateWorldMatrix(true, true);
    const kneeDrop = th.getWorldPosition(_a).y - ca.getWorldPosition(_b).y;   // (the droop sitBody gave it)
    const want = Math.min(lt * 0.99, kneeDrop + Math.min(0.08, lo));
    aimBone(th, ca, fwd.clone().multiplyScalar(Math.sqrt(Math.max(0, lt * lt - want * want))).addScaledVector(up, -want));
    aimBone(ca, fo, up.clone().negate().addScaledVector(fwd, 0.12));
  }
  skin.holder.updateMatrixWorld(true);
}

/**
 * Seated in a vehicle (stage._cabinFloorY: its cabin floor under the seat): the stage rests the clay's shoes on that
 * floor (feetOnFloor), but the visible legs are longer than the clay's, so retargeted they went 8 cm through it (and,
 * before the stage's own fix, 2-3 cm under the street). Each visible foot still under the floor is lifted onto it
 * (two-bone IK), at full weight while the clay's shoe is within 2 cm of the floor and not at all 12 cm away (getting
 * in or out: the shoe moves to the street and back smoothly); then the logic rig's hips and knees are solved from the
 * visible legs, so the Pose / Depth legs are the visible ones. On the undo list.
 */
function cabinFeet(stage, a, g, skin, f, undo) {
  const floor = stage._cabinFloorY?.(a, f);
  const rig = skin.kit.feet, boxes = clayFeet(g);
  if (floor == null || !rig || !skin.legs || !boxes || !skin.mesh) return;
  g.updateMatrixWorld(true);
  let clay = Infinity;
  for (const m of boxes) { _gb.setFromObject(m, true); clay = Math.min(clay, _gb.min.y); }
  const w = 1 - smooth01((Math.abs(clay - floor) - 0.02) / 0.10);
  if (!(w > 0)) return;
  skin.holder.updateMatrixWorld(true);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(skin.holder.getWorldQuaternion(new THREE.Quaternion()));
  let moved = false;
  for (const lr of ["l", "r"]) {
    const p = F.solePoints(skin.mesh, rig[lr]);
    let lo = Infinity;
    for (let i = 1; i < p.length; i += 3) lo = Math.min(lo, p[i]);
    const under = (floor - lo) * w;
    if (!(under > 1e-4) || !Number.isFinite(under)) continue;
    const B = skin.legs[lr];
    B.foot.updateWorldMatrix(true, false);
    F.twoBoneIK(B.thigh, B.calf, B.foot, B.foot.getWorldPosition(new THREE.Vector3()).addScaledVector(UPV, under), B.foot.getWorldQuaternion(new THREE.Quaternion()), fwd);
    skin.holder.updateMatrixWorld(true);
    moved = true;
  }
  if (!moved || !skin.kit._rtOff) return;
  const legs = new Set(["l_hip", "r_hip", "l_knee", "r_knee"]);
  R.solveRigFromBody(skin, g, { skip: new Set(Object.keys(g.userData.joints || {}).filter((j) => !legs.has(j))), undo });
  g.updateMatrixWorld(true);
}

/** The body and the logic rig moved up or down so the lowest visible sole is on the ground. Returns the move (m). */
function soleOnGround(stage, a, g, skin, f, undo) {
  const rig = skin.kit.feet;
  if (!rig || !skin.mesh) return 0;
  const ground = groundFn(stage, a, g, f);
  skin.holder.updateMatrixWorld(true);
  let lo = Infinity;
  for (const lr of ["l", "r"]) { const p = F.solePoints(skin.mesh, rig[lr]); for (let i = 0; i < p.length; i += 3) lo = Math.min(lo, p[i + 1] - ground(p[i], p[i + 2])); }
  if (!Number.isFinite(lo) || Math.abs(lo) < 1e-7) return 0;
  moveBody(g, skin.holder, 0, -lo, 0, undo);
  return -lo;
}

const _gv = new THREE.Vector3();
/**
 * The rig owns a body off its feet (knocked over, moved by physics, tipped live): the retargeted body's own shape (its
 * shoulders, hips and head are not the clay's boxes) lay 19-26 cm into the floor knocked over and 33 cm at a 45-degree
 * walking tilt. Here the body and the logic rig move up or down together so the body's lowest skinned point is as high
 * over the ground as the clay's lowest mesh: matched both ways while the clay touches the ground (within 5 cm), only
 * lifted out when the clay is off it (a tumble in the air is the rig's own height). Every 2nd vertex is read (a fixed
 * sample: the same on any frame order). Returns the vertical move (m).
 */
function groundBody(stage, a, g, skin, f, undo, liftOnly = false) {
  const ground = groundFn(stage, a, g, f);
  g.updateMatrixWorld(true);
  let clayLow = Infinity;
  const walk = (o) => {
    if (o.userData?.avatar) return;
    if (o.isMesh && o.geometry?.attributes?.position) { _gb.setFromObject(o, true); _gb.getCenter(_gc); clayLow = Math.min(clayLow, _gb.min.y - ground(_gc.x, _gc.z)); }
    for (const c of o.children) walk(c);
  };
  walk(g);
  const m = skin.mesh;
  if (!m?.isSkinnedMesh || !Number.isFinite(clayLow)) return 0;
  skin.holder.updateMatrixWorld(true);
  const n = m.geometry.attributes.position.count;
  let visLow = Infinity;
  for (let i = 0; i < n; i += 2) { m.getVertexPosition(i, _gv).applyMatrix4(m.matrixWorld); visLow = Math.min(visLow, _gv.y - ground(_gv.x, _gv.z)); }
  if (!Number.isFinite(visLow)) return 0;
  const want = Math.max(0, clayLow);
  const dy = clayLow < 0.05 && !liftOnly ? want - visLow : Math.max(0, -visLow);
  if (Math.abs(dy) > 1e-7) moveBody(g, skin.holder, 0, dy, 0, undo);
  return dy;
}

/** A person with no lifelike body (not installed, failed, still loading, or a kind with no avatar yet: children)
 *  shows as the marked stand-in (standin.mjs), never as clay. */
function markStandIn(stage, a, g) {
  setStandIn(g, true, { loading: !!stage._avatarWant?.has(a.id) });
}

/**
 * Where a clay joint id's VISIBLE bone is (world space, into out): the lifelike body's Bip01 bone (retarget.boneFor)
 * when the person has one on show, else the logic rig's own joint. The Pose gizmo puts its dots and IK handles here.
 */
export function boneWorld(stage, actorId, jointId, out = new THREE.Vector3()) {
  const g = stage.actorMeshes?.get(actorId), skin = g?.userData.humanSkin;
  const bn = skin?.shown ? R.boneFor(jointId) : null;
  const b = bn && skin.bones?.[bn];
  if (b) { b.updateWorldMatrix(true, false); return b.getWorldPosition(out); }
  const j = g?.userData.joints?.[jointId];
  if (!j) return null;
  j.updateWorldMatrix(true, false);
  return j.getWorldPosition(out);
}

/** Undo what avatarsAt wrote over the stage's pose last time (the clay joints the body solve turned, the clay group's
 *  sideways foot shift): stage.setFrame calls it before posing anything, avatarsAt at its start. */
export function undoAvatarWrites(stage) {
  R.undoRig(stage._rigUndo);
}

/** The logic rig follows the visible body (retarget.solveRigFromBody), joints in skip left as the stage posed them,
 *  and the whole rig moved so its hips are on the body's (alignRig). */
function solveRig(stage, skin, g, skip, undo) {
  if (!skin.kit._rtOff) ensureOffsets(skin);
  R.solveRigFromBody(skin, g, { skip, undo });
  alignRig(g, skin, undo);
  fitRig(g, skin, undo);
}

/** Clay joints set onto the visible bones (top-down, so a parent is placed before its child): the two bodies differ
 *  in proportions (shoulders 7-12 cm apart, the limbs a few cm), and the rig's turns alone left its elbows, wrists and
 *  knees up to ~11 cm off the body. Positions only (the turns are solveRigFromBody's); on the undo list. */
const FIT = [["l_hip", "Bip01_L_Thigh"], ["r_hip", "Bip01_R_Thigh"], ["neck", "Bip01_Neck"], ["l_shoulder", "Bip01_L_UpperArm"], ["r_shoulder", "Bip01_R_UpperArm"],
  ["head", "Bip01_Head"], ["l_knee", "Bip01_L_Calf"], ["r_knee", "Bip01_R_Calf"], ["l_elbow", "Bip01_L_Forearm"], ["r_elbow", "Bip01_R_Forearm"], ["l_wrist", "Bip01_L_Hand"], ["r_wrist", "Bip01_R_Hand"]];
function fitRig(g, skin, undo) {
  const J = g.userData.joints, B = skin.bones, w = new THREE.Vector3();
  if (!J) return;
  skin.holder.updateMatrixWorld(true);
  for (const [jid, bn] of FIT) {
    const j = J[jid], b = B?.[bn];
    if (!j?.parent || !b) continue;
    b.getWorldPosition(w);
    j.parent.updateWorldMatrix(true, false);
    const local = j.parent.worldToLocal(w.clone());
    if (local.distanceToSquared(j.position) < 1e-12) continue;
    undo.push([j, "position", j.position.clone()]);
    j.position.copy(local);
    j.updateMatrixWorld(true);
  }
}

/**
 * Move the logic rig (the clay group g) so its hip joints' midpoint is on the visible body's (the two thigh bones'),
 * the body itself left where it is. The stage's own gait puts the clay's hips up to ~24 cm from the clip's (its planted
 * feet lead or trail the keys; the clip stands on them), so the turns alone left every Pose keypoint, the gizmo's IK
 * and the colliders that far off the body the camera sees (L1 review round 2: 33% of the logic rig's keypoints inside
 * the walking body's silhouette at f6). On the undo list like every other write over the stage's pose.
 */
function alignRig(g, skin, undo) {
  const J = g.userData.joints, B = skin.bones;
  if (!J?.l_hip || !J?.r_hip || !B?.Bip01_L_Thigh || !B?.Bip01_R_Thigh) return;
  g.updateMatrixWorld(true);
  const clay = J.l_hip.getWorldPosition(new THREE.Vector3()).add(J.r_hip.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  const body = B.Bip01_L_Thigh.getWorldPosition(new THREE.Vector3()).add(B.Bip01_R_Thigh.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  const d = body.sub(clay);
  if (d.lengthSq() < 1e-12) return;
  const h = skin.holder, hp = h.getWorldPosition(new THREE.Vector3());
  moveBody(g, h, d.x, d.y, d.z, undo);
  // the body stays: the holder back to its world place inside the moved group
  if (h.parent) { h.parent.updateWorldMatrix(true, false); h.position.copy(h.parent.worldToLocal(hp)); } else h.position.copy(hp);
  h.updateMatrixWorld(true);
}

/** The kit's rest offsets (retarget.restOffsets), measured on the idle's first frame. Leaves the skin on that pose. */
function ensureOffsets(skin) {
  if (skin.kit._rtOff) return skin.kit._rtOff;
  drive(skin, { frame: 0, fps: 24, speed: 0, phase: 0, seed: 0 });
  return R.restOffsets(skin);
}

/** The rig owns the frame: the clip's idle at this frame (fingers, clavicles, breathing), then every trunk and limb
 *  bone from the clay joints, the hips on the clay's hips. No foot plan (the rig's own pose decides the feet). */
function poseFromRig(stage, a, g, skin, f, { fps, scale }) {
  ensureOffsets(skin);
  g.updateWorldMatrix(true, false);
  const p = g.getWorldPosition(new THREE.Vector3());
  const yaw = new THREE.Euler().setFromQuaternion(g.getWorldQuaternion(new THREE.Quaternion()), "YXZ").y;
  placeHolder(g, skin.holder, { x: p.x, y: p.y, z: p.z, yaw, scale });
  drive(skin, { frame: f, fps, speed: 0, phase: 0, seed: C.phaseSeed(a.id) });
  R.retargetFromRig(skin, g);
  skin.footOut = null;
}

/** The clip owns the frame: the gait's clip, the body's sideways shift (plan.shift) on the clay group AND the body
 *  together (the logic rig, shadow and bounds move with it), then the feet grounded. */
function poseFromClip(stage, a, g, skin, f, { fps, scale, last, undo }) {
  const plan = footPlanFor(stage, a, g, skin, { last, fps, scale });
  poseRaw(stage, a, g, skin, f, { fps, scale, last });
  const i = Math.max(0, Math.min((plan?.n || 1) - 1, Math.round(f)));
  const sx = plan?.shift?.[2 * i] || 0, sz = plan?.shift?.[2 * i + 1] || 0;
  if (sx || sz) moveBody(g, skin.holder, sx, 0, sz, undo);
  skin.shift = [sx, sz];
  skin.footOut = plan ? F.groundFeet({ plan, rig: skin.kit.feet, mesh: skin.mesh, bones: skin.legs, holder: skin.holder, frame: f, saved: (skin.ikSaved ||= []), shifted: true }) : null;
}

/** Move the clay group g and the avatar holder (inside g) by a world x / y / z offset; g's old place goes on the undo
 *  list. */
function moveBody(g, holder, sx, sy, sz, undo) {
  const entry = [g, "position", g.position.clone(), null];
  undo.push(entry);
  const par = g.parent;
  if (par) {
    par.updateWorldMatrix(true, false);
    const w = g.getWorldPosition(new THREE.Vector3());
    w.x += sx; w.y += sy; w.z += sz;
    g.position.copy(par.worldToLocal(w));
  } else { g.position.x += sx; g.position.y += sy; g.position.z += sz; }
  entry[3] = g.position.clone();   // undone only while it is still where this put it
  g.updateMatrixWorld(true);   // (the holder is in g: it moves with it)
  holder.updateMatrixWorld(true);
}

/**
 * The person's speed and shared gait phase for the whole shot (skin.gait), cached until the path, the length or the
 * size changes. Returns {scale} (the avatar's stature scale).
 */
function ensureGait(stage, a, skin, { last, fps, f }) {
  const p = stage._actorPosAt(a, f);
  const scale = C.statureScale(C.clayHeight(a) * (a.scale || 1), skin.kit.stature);
  const keys = stage._actorKeys(a);
  const sig = `${last}|${fps}|${scale}|${C.keysHash(keys)}|${a.rotation_deg || 0}`;
  if (skin.gait?.sig !== sig) {
    const path = keys.length > 1 ? groundPath(stage, a, last) : new Array(last + 1).fill([p[0], p[2]]);
    // the headings too: walking backwards (heading keys facing away from the travel) plays the walk backwards
    const headings = keys.length > 1 ? Array.from({ length: last + 1 }, (_, i) => stage._headingAt(a, i)) : null;
    skin.gait = { sig, ...C.gaitTable(path, fps, kitStrides(skin.kit, scale), { headings }) };
  }
  return { scale };
}

/** The swim plan of a person in the water (stage._swimPlan), or null on dry land. */
const swimPlanOf = (stage, a, g) => ((stage.water || stage.setFx?.underwater) ? stage._swimPlan?.(a, g) || null : null);
/** Does this person swim at frame f (C.swimsAt on the swim plan)? */
const swimsNow = (stage, a, g, f) => C.swimsAt(a, f, () => swimPlanOf(stage, a, g));
/** Is frame f inside the stage's climb out of the water (stage._swimExits: from the swim's last frame over the tank's
 *  wall to the walk, e.f .. e.f + N - 1)? A pure function of the keys (the exits are cached on the swim plan). */
export const exitsNow = (stage, a, g, f) => {
  if (!stage._swimExits || !swimPlanOf(stage, a, g)) return false;
  const ex = stage._swimExits(a, g);
  if (!ex) return false;
  for (const e of ex) if (f >= e.f && f < e.f + (e.N ?? e.n)) return true;
  return false;
};

/**
 * The foot plan of a person with a lifelike body for this shot, built whether or not the body shows right now (the
 * same plan avatarsAt grounds the feet with; tests and the one-motion work read it). null without a body or a rig.
 */
export function footPlan(stage, a) {
  const g = stage.actorMeshes.get(a.id), skin = g?.userData.humanSkin;
  if (!skin) return null;
  const fps = stage.state.shot?.fps || 24, last = stage._lastFrame();
  const { scale } = ensureGait(stage, a, skin, { last, fps, f: stage.frame });
  return footPlanFor(stage, a, g, skin, { last, fps, scale });
}

/** The lifelike body's height at frame f. Over the water on a dock or a deck (or held before a timed jump): the height
 *  the clay stands at there (stage._standOnKeys, the same support lift the clay's gait gets), not the keys' own height
 *  under it. Elsewhere walked steps, not the clay's hops (stage._walkHeightAt), else the clay's. */
const bodyY = (stage, a, g, f) => stage._standOnKeys?.(a, g, f) ?? (stage._walkHeightAt ? stage._walkHeightAt(a, f) : stage._heightAt(a, f));
/** A saved tilt that leans the person without knocking them over (onemotion.KNOCK_DEG): the clip's body leans with it
 *  (the logic rig is tilted the same by stage.setFrame); null for none, or a knock-over (the rig owns that). */
const smallTilt = (a) => (O.tiltDeg(a) > 1e-3 && !O.knockedOver(a) ? a.tilt : null);
/** Is the lifelike body in the air at frame f (a jump or a vault; a walked step up is not)? */
const airAt = (stage, a, f) => !!(stage._walkAirborneAt ? stage._walkAirborneAt(a, f) : stage._airborneAt?.(a, f));

/** Place and pose the avatar on its clip alone at frame f (no grounding): the actor's ground position and heading,
 *  lowered by the playing clips' own floor (footplant.floorFor), on the shared gait phase. */
function poseRaw(stage, a, g, skin, f, { fps, scale, last }) {
  const i = Math.max(0, Math.min(last, f));
  const p = stage._actorPosAt(a, f), y = bodyY(stage, a, g, f) + physicsLift(a), yaw = stage._headingAt(a, f);
  const speed = skin.gait.speed[i] || 0;
  placeHolder(g, skin.holder, { x: p[0], y: y - F.floorFor(skin.kit, C.clipWeights(speed)) * scale, z: p[2], yaw, scale, tilt: smallTilt(a) });
  drive(skin, { frame: f, fps, speed, phase: skin.gait.phase[i] || 0, seed: C.phaseSeed(a.id) });
  skin.holder.updateMatrixWorld(true);   // the bones' world matrices for this pose (the foot plan reads them)
}

const _ids = new WeakMap();
let _nextId = 1;
/** A small stable id per object (for cache signatures); 0 for none. */
const idOf = (o) => { if (!o || typeof o !== "object") return 0; let v = _ids.get(o); if (!v) { v = _nextId++; _ids.set(o, v); } return v; };

/**
 * The person's foot plan for this shot (footplant.planFeet), built once from every frame and cached on the skin until
 * the gait (keys, length, fps, size), what they stand on (the set, the parked props, a dock or deck's height table),
 * their jumps or the physics lift change. null when the avatar has no foot rig. Building it poses the clip at every
 * frame; avatarsAt poses the frame shown afterwards.
 */
function footPlanFor(stage, a, g, skin, { last, fps, scale }) {
  const rig = skin.kit.feet;
  if (!rig || !skin.legs || stage.footGrounding === false) return null;   // footGrounding false: the clips alone (A/B checks)
  // off their feet all shot (riding, seated, carried, knocked over, floating): no plan. Swimming and the air are per
  // frame (the plan skips those frames), so a person who walks and then swims is grounded on the walk.
  // (a recorded take's mount spans: Drive.pre() wrote this frame's mount into a.mount_id; whole-shot facts never read it)
  const aw = a.mount_spans?.length && stage._mountAt ? { ...a, mount_id: undefined, mount_at: undefined } : a;
  if (C.feetUpReason(aw, { tipped: tippedNow(g), floats: !!stage._floatsInShot?.(a) }) || O.rigShotReason(a, { driven: C.drivenNow(stage.drive, a.id) })) return null;
  const shapes = stage.root ? stage._supportShapes?.() : null;
  const swim = swimPlanOf(stage, a, g);
  const sig = `${skin.gait.sig}|${stage.setFx?.id || ""}|${idOf(shapes)}|${idOf(stage._yCache?.get(a))}|${idOf(stage._swimCache?.get(a)?.stand)}|${idOf(swim)}|${physicsLift(a)}|${skin.kit.floors ? 1 : 0}|${stage._mountSig ? stage._mountSig(a) : `${a.pose || ""}|${a.mount_id || ""}|${a.mount_at ?? ""}`}|${smallTilt(a)?.join(",") || ""}`;
  if (skin.feet?.sig === sig) return skin.feet.plan;
  // A live drag (a key, the gizmo, a person dragged) changes the plan on every pointer move. A 5 s shot rebuilds in
  // ~20 ms, a 30 s one in ~115 ms: past LIVE_PLAN_FRAMES the feet keep the clip's own pose while the drag lasts and
  // the plan is rebuilt on the first frame after it (same result as any other rebuild: the plan is a pure function
  // of the keys).
  const dragging = () => !!(stage._dragging || stage._gizmoDragging || stage.live?.drag);
  if (last + 1 > LIVE_PLAN_FRAMES && dragging()) {
    if (!stage._footAfterDrag && typeof setTimeout === "function") {
      // (unref where there is one, Node: a drag a test leaves on must not keep the process alive; in a browser the
      // timer is a number and this is a no-op)
      const later = () => { const t = setTimeout(poll, 120); t?.unref?.(); return t; };
      const poll = () => { if (dragging()) { stage._footAfterDrag = later(); return; } stage._footAfterDrag = 0; stage.setFrame(stage.frame); };
      stage._footAfterDrag = later();
    }
    return null;
  }
  // per frame once (the plan asks for the ground under every sole point of every frame: a height-table lookup with its
  // signature each time made a 5 s plan cost ~100 ms)
  const n = last + 1, BY = new Float64Array(n), OK = new Float64Array(n);
  const AIR = new Uint8Array(n);
  for (let f = 0; f < n; f++) { BY[f] = bodyY(stage, a, g, f); OK[f] = stage._standOnKeys?.(a, g, f) ?? -Infinity; AIR[f] = airAt(stage, a, f) ? 1 : 0; }
  const fi = (f) => Math.max(0, Math.min(n - 1, Math.round(f)));
  const baseY = (f) => BY[fi(f)];
  const floorAt = stage.setFx?.floorAt;
  const ground = (x, z, f) => {
    const i = fi(f);
    const s = shapes ? stage._supportAt(x, z, BY[i], 0.6, shapes) : Math.max(0, floorAt?.(x, z) || 0);
    return Math.max(s, OK[i]);
  };
  const lifted = physicsLift(a) > 0, physFrom = O.physicsFrom(a);
  // a wall or anything too tall to step onto, at foot height (the shift's re-check, footplant planFeet)
  const tall = 0.6 * C.clayHeight(a) * (a.scale || 1) / 1.8;
  const blocked = shapes ? (x, z, f) => {
    const by = BY[fi(f)];
    for (const sh of shapes) if (x >= sh.min[0] && x <= sh.max[0] && z >= sh.min[2] && z <= sh.max[2] && sh.min[1] < by + 0.3 && sh.max[1] > by + tall) return true;
    return false;
  } : null;
  // per frame: the same gate (lifted by physics, in the air) marks the frames not grounded
  const plan = F.planFeet({
    n: last + 1, fps, heightM: C.clayHeight(a) * (a.scale || 1), rig, mesh: skin.mesh, bones: skin.legs, holder: skin.holder, ground, baseY, blocked,
    // (seated frames too: a person who walks to a chair and sits, stage._sitSpec per frame; the body shift fades out
    // before them, footplant planFeet)
    poseRaw: (f) => { poseRaw(stage, a, g, skin, f, { fps, scale, last }); return !C.feetUpReason(aw, { physics: fi(f) >= physFrom, lifted, airborne: !!AIR[fi(f)], swims: C.swimsAt(a, f, () => swim), sits: !!stage._sitSpec?.(a, fi(f)), mounted: mountedAt(stage, a, fi(f)) }); },
  });
  skin.feet = { sig, plan };
  return plan;
}

/** Off the feet for a mount at frame f (hopping on, seated, riding, getting off), from stage._mountPhaseAt (a recorded
 *  span read for that frame, never this frame's a.mount_id). */
const mountedAt = (stage, a, f) => { const ph = stage._mountPhaseAt ? stage._mountPhaseAt(a, f) : a.mount_id ? "on" : null; return ph != null && ph !== "walk"; };

/** footPlanFor: longer shots than this (frames) don't rebuild their foot plan during a live drag. */
const LIVE_PLAN_FRAMES = 240;

/** The lift stage.setFrame gives an unbaked dynamic / static object (stage.mjs: g.position.y += a.physics.lift). */
export const physicsLift = (a) => (!a.physics?.baked && a.physics?.lift > 0 && (a.physics.mode === "dynamic" || a.physics.mode === "static") ? a.physics.lift : 0);

const _up = new THREE.Vector3();
/** Is quaternion q tilted off upright by more than ~3 degrees? */
export const tiltedOffUp = (q) => _up.set(0, 1, 0).applyQuaternion(q).y < 0.9986;

/**
 * Is the clay group tipped over live right now (a knock-over in the live physics drag, not saved as a.tilt yet)?
 * Read from the flag web/stage/live.mjs sets from the PHYSICS pose (markLiveTilt), never from the group's own
 * rotation: Gait.applyHuman leans every keyed walker (up to 0.11 rad running, 0.14 on speed changes, 0.38 into turns)
 * and that ordinary lean must not swap the body. A gizmo tilt is written to a.tilt as it is dragged (rotate.mjs
 * gizmoTurnToActor), so the rig's "was knocked over" (onemotion.rigShotReason) covers that one.
 */
export const tippedNow = (g) => !!g?.userData?.liveTipped;

/**
 * live.mjs: the physics pose q was just put on person group g. Flag it tipped (or not) and, when that changes,
 * re-run the avatar check at once (avatarsAt already ran in the frame's setFrame, before this pose was applied).
 * Returns true when the flag changed.
 */
export function markLiveTilt(stage, g, q) {
  if (!g?.userData?.humanSkin) return false;
  const t = tiltedOffUp(q);
  if (!!g.userData.liveTipped === t) return false;
  g.userData.liveTipped = t;
  const skin = g.userData.humanSkin;
  // never clay: tipped, the rig owns the body (avatarsAt poses it from the knocked-over rig); upright again, the clip
  avatarsAt(stage);
  if (!t) {
    // avatarsAt stands the body at the KEY position; the live physics has the clay group somewhere else right now
    // (the drag in progress), so for this tick the body stands where the clay is (the next setFrame agrees again).
    const a = (stage.state?.actors || []).find((x) => x.id === g.userData.actorId);
    if (a && skin.shown) {
      const scale = C.statureScale(C.clayHeight(a) * (a.scale || 1), skin.kit.stature);
      const w = g.getWorldPosition(new THREE.Vector3());
      placeHolder(g, skin.holder, { x: w.x, y: w.y - F.floorFor(skin.kit, skin.weights) * scale, z: w.z, yaw: new THREE.Euler().setFromQuaternion(q, "YXZ").y, scale });
    }
  }
  return true;
}

/** live.mjs: the drag is over and its poses are written down (a.tilt or upright): drop every live tilt flag. */
export function clearLiveTilts(stage) {
  for (const g of stage.actorMeshes?.values() || []) if (g?.userData?.liveTipped) g.userData.liveTipped = false;
}
