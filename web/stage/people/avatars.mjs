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
import * as F from "./footplant.mjs";

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
  F.restoreClipPose(skin.ikSaved);   // the clip's own legs back before the mixer writes (it skips unchanged values)
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

/** How long a capture waits for lifelike bodies still loading (ms). A first load over a slow link can take a while
 *  (two ~10 MB FBX files and their textures). Per stage: stage.avatarWaitMs. */
export const AVATAR_WAIT_MS = 60000;

/** Resolves when every lifelike body that started loading has been put on (or given up): {ok, timedOut, pending,
 *  waitedMs, waited (something was loading), message}. captureSequence awaits it so a capture never starts clay and turns lifelike partway. ms caps
 *  the wait; on a timeout the message says so (the people still loading stay clay for this capture, then change). */
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
  const message = `Lifelike people still loading after ${Math.round(ms / 1000)} s: ${pending} ${pending === 1 ? "person is" : "people are"} drawn as the clay figure in this capture. Capture again once they show.`;
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
  skin.clay = []; skin.clayVis = [];
  g.traverse((o) => { if (o.isMesh && !o.userData.avatar) skin.clay.push(o); });
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

/** stage._buildSet hook: give a person the lifelike body once its files load; clay stays on any failure. */
export function upgradeHuman(stage, a, g) {
  const spec = C.avatarSpecFor(a);
  if (!spec || !g?.userData?.joints) return;
  if (reuseSkin(stage, a, g, spec)) return;
  const load = stage._loadKit || loadKit;   // stage._loadKit: a test's stand-in loader
  if (load === loadKit && (typeof window === "undefined" || typeof window.document?.createElement !== "function")) return;   // node tests: clay only
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
    if (warned) return;   // a missing install is said once; the next build still tries again (loadKit caches no failure)
    warned = true;
    console.info("Soundstage: lifelike people not installed (web/stage/people/rocketbox), people stay clay:", err?.message || err);
  });
  trackLoading(job);
}

/** How many lifelike bodies are still loading (a capture says it is waiting for them before it waits). */
export const loadingCount = () => inflight.size;

/** Count a body still loading (avatarsReady waits for it) until it settles. Returns the promise. */
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

/** stage.setFrame hook (after gaze, before held props): show and pose every lifelike person, or keep the clay. */
export function avatarsAt(stage) {
  stage._avatarFramePending = false;   // posed now: a requested frame (requestFrame) isn't needed any more
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
  const blocking = stage.state.people_look === "blocking";
  const memo = (stage._avatarDriven ||= { shot: undefined, ids: new Set() });
  for (const a of actors) {
    const g = stage.actorMeshes.get(a.id), skin = g?.userData.humanSkin;
    if (!skin) continue;
    users ||= C.propUsers(actors);
    if (skin.faceless !== (a.face === "faceless")) applyFace(skin, a.face === "faceless");
    const wet = !!(stage.water || stage.setFx?.underwater);
    const body = {
      swims: wet && C.swimsInShot(a, () => stage._swimPlan?.(a, g)),
      floats: !!stage._floatsInShot?.(a),   // a video mocap take in water too deep to stand in: the clay floats (stage._waterPhysics)
      tipped: tippedNow(g),
    };
    const reason = C.clayReason(a, {
      blocking, holders: users.holders, carriers: users.carriers, gazeKeyed: gazeKeys(a).length > 0, ...body,
      driven: C.drivenInShot(memo, stage.state.active_shot, a.id, stage.drive),
      airborne: airAt(stage, a, f),   // this frame only: clay in the air, lifelike on the ground
    });
    skin.reason = reason;
    setShown(skin, !reason);
    // The grounding gate is the feet, not the clay (C.feetUpReason): today a hidden body isn't posed at all, and once
    // the clay is retired a person holding a prop, with gaze or Pose keys, on a mocap take ... is lifelike and stands.
    skin.feetUp = C.feetUpReason(a, body);
    if (reason) continue;
    // The physics lift (stage.setFrame raises an unbaked dynamic / static object by a.physics.lift) is followed too.
    const p = stage._actorPosAt(a, f), y = bodyY(stage, a, f) + physicsLift(a), yaw = stage._headingAt(a, f);
    const scale = C.statureScale(C.clayHeight(a) * (a.scale || 1), skin.kit.stature);
    // Speed and the shared gait phase for the whole shot, cached until the path, the length or the size changes.
    const keys = stage._actorKeys(a);
    const sig = `${last}|${fps}|${scale}|${C.keysHash(keys)}|${a.rotation_deg || 0}`;
    if (skin.gait?.sig !== sig) {
      const path = keys.length > 1 ? groundPath(stage, a, last) : new Array(last + 1).fill([p[0], p[2]]);
      // the headings too: walking backwards (heading keys facing away from the travel) plays the walk backwards
      const headings = keys.length > 1 ? Array.from({ length: last + 1 }, (_, i) => stage._headingAt(a, i)) : null;
      skin.gait = { sig, ...C.gaitTable(path, fps, kitStrides(skin.kit, scale), { headings }) };
    }
    const plan = footPlanFor(stage, a, g, skin, { last, fps, scale });
    poseRaw(stage, a, g, skin, f, { fps, scale, last });
    skin.footOut = plan ? F.groundFeet({ plan, rig: skin.kit.feet, mesh: skin.mesh, bones: skin.legs, holder: skin.holder, frame: f, saved: (skin.ikSaved ||= []) }) : null;
  }
}

/** The lifelike body's height at frame f: walked steps, not the clay's hops (stage._walkHeightAt), else the clay's. */
const bodyY = (stage, a, f) => (stage._walkHeightAt ? stage._walkHeightAt(a, f) : stage._heightAt(a, f));
/** Is the lifelike body in the air at frame f (a jump or a vault; a walked step up is not)? */
const airAt = (stage, a, f) => !!(stage._walkAirborneAt ? stage._walkAirborneAt(a, f) : stage._airborneAt?.(a, f));

/** Place and pose the avatar on its clip alone at frame f (no grounding): the actor's ground position and heading,
 *  lowered by the playing clips' own floor (footplant.floorFor), on the shared gait phase. */
function poseRaw(stage, a, g, skin, f, { fps, scale, last }) {
  const i = Math.max(0, Math.min(last, f));
  const p = stage._actorPosAt(a, f), y = bodyY(stage, a, f) + physicsLift(a), yaw = stage._headingAt(a, f);
  const speed = skin.gait.speed[i] || 0;
  placeHolder(g, skin.holder, { x: p[0], y: y - F.floorFor(skin.kit, C.clipWeights(speed)) * scale, z: p[2], yaw, scale });
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
  if (skin.feetUp) return null;   // off their feet all shot (riding, seated, carried, swimming, knocked over): no plan
  const shapes = stage.root ? stage._supportShapes?.() : null;
  const sig = `${skin.gait.sig}|${stage.setFx?.id || ""}|${idOf(shapes)}|${idOf(stage._yCache?.get(a))}|${idOf(stage._swimCache?.get(a)?.stand)}|${physicsLift(a)}|${skin.kit.floors ? 1 : 0}`;
  if (skin.feet?.sig === sig) return skin.feet.plan;
  const baseY = (f) => bodyY(stage, a, f);
  const ground = (x, z, f) => {
    const by = baseY(f);
    const onKeys = stage._standOnKeys?.(a, g, f);
    const s = shapes ? stage._supportAt(x, z, by) : Math.max(0, stage.setFx?.floorAt?.(x, z) || 0);
    return Math.max(s, onKeys ?? -Infinity);
  };
  const lifted = physicsLift(a) > 0;
  // per frame: the same gate (lifted by physics, in the air) marks the frames not grounded
  const plan = F.planFeet({
    n: last + 1, fps, heightM: C.clayHeight(a) * (a.scale || 1), rig, mesh: skin.mesh, bones: skin.legs, holder: skin.holder, ground, baseY,
    poseRaw: (f) => { poseRaw(stage, a, g, skin, f, { fps, scale, last }); return !C.feetUpReason(a, { lifted, airborne: airAt(stage, a, f) }); },
  });
  skin.feet = { sig, plan };
  return plan;
}

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
 * gizmoTurnToActor), so clayReason's "was knocked over" covers that one.
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
  if (t) { skin.reason = "is tipped over"; setShown(skin, false); }
  else {
    avatarsAt(stage);
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
