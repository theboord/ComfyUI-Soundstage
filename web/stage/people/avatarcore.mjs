// Lifelike people (Milestone M1 of the people overhaul): the pure rules behind web/stage/people/avatars.mjs, kept free
// of loading and the DOM so node tests can check them (tests/js/avatars.test.mjs).
//
// What the Rocketbox files turned out to be (measured by parsing them with the vendored FBXLoader, 2026-11-07):
//   units   centimetres (Male_Adult_01 is 182 cm tall, the Bip01 root sits at 89.5 cm in the bind pose);
//   axes    FBXLoader already turns 3ds Max's Z-up into Y-up; the avatar faces +Z (the nose bone is ~14 cm in front
//           of the head bone) and its left (Bip01_L_*) is +X, the same as the clay figure (humans.mjs);
//   bones   "Bip01 ..." names come out of FBXLoader with spaces turned into underscores (Bip01_L_Thigh);
//   meshes  each Export/*.fbx holds ONE skinned mesh, "<id>_hipoly_81_bones_opacity" (no separate LOD meshes), with
//           three materials: <id>_body, <id>_head and <id>_opacity (lashes / brows, alpha in the PNG's alpha);
//   extras  each file carries an AmbientLight, removed on load;
//   clips   the *.max.fbx clips put ground travel on the ROOT bone "Bip01" (position Z grows over the loop: walk
//           121 cm / 1.2 s for the man, run 211 cm / 0.73 s); Bip01_Pelvis has no travel. They also animate helper
//           nodes the avatar doesn't have (MotionExtractionHelper, ExposeTransformHelper) or doesn't need
//           (Bip01_Footsteps), and repeat every bone's bind offset as a position track.
import * as THREE from "../../vendor/three.module.min.mjs";

/** Which Rocketbox avatar and clips each person kind gets. Children and everyone else stay clay for now. */
export const ROCKETBOX = {
  man: { model: "Male_Adult_01", clips: { idle: "m_idle_neutral_01", walk: "m_walk_neutral_01", run: "m_run_neutral_01" } },
  woman: { model: "Female_Adult_01", clips: { idle: "f_idle_neutral_01", walk: "f_walk_neutral_01", run: "f_run_neutral_01" } },
};
export const CLIP_KINDS = ["idle", "walk", "run"];
export const ROOT_BONE = "Bip01";

/** The avatar spec for an actor, or null (stays clay): men and women only, and not when they asked for the clay model. */
export function avatarSpecFor(a) {
  if (!a || a.simple_model) return null;
  if (a.kind === "woman" || (a.kind === "man" && a.appearance?.gender === "female")) return ROCKETBOX.woman;
  if (a.kind === "man") return ROCKETBOX.man;
  return null;
}

/** FBXLoader has no TGA reader in our vendored three (FBXLoader.mjs prints "TGA loader not found"): every *.tga the
 *  FBX asks for is loaded as the 1024 px PNG of the same base name from texDir instead. Other URLs pass through. */
export function tgaToPng(url, texDir) {
  const m = /([^/\\?#]+)\.tga(?:[?#].*)?$/i.exec(String(url || ""));
  return m ? `${texDir}${m[1]}.png` : url;
}

/**
 * Detail level of a Rocketbox mesh name. The naming rule (Rocketbox exports and its Unity import script):
 * "<id>_<level>poly_<n>_bones[_opacity]" with level hi < mid < low < ultralow. 0 = most detail; -1 = no level in the name.
 */
export function lodLevel(name) {
  const m = /(?:^|_)(ultralow|hi|mid|low)poly(?:_|$)/i.exec(String(name || ""));
  return m ? ["hi", "mid", "low", "ultralow"].indexOf(m[1].toLowerCase()) : -1;
}

/** Index of the mesh to show from [{name, vertices}]: the most detailed named level, else the most vertices. */
export function pickLod(meshes) {
  if (!meshes?.length) return -1;
  let best = 0;
  const rank = (m) => { const l = lodLevel(m.name); return l < 0 ? 99 : l; };
  meshes.forEach((m, i) => {
    const b = meshes[best];
    if (rank(m) < rank(b) || (rank(m) === rank(b) && (m.vertices || 0) > (b.vertices || 0))) best = i;
  });
  return best;
}

/** A clip's bone name in the avatar's naming: Bip02 -> Bip01 (Rocketbox's own import script renames these), spaces
 *  -> underscores (what FBXLoader does to the avatar's bones). */
export const remapBoneName = (n) => String(n).replace(/\s+/g, "_").replace(/^Bip0\d(?=_|$)/, "Bip01");

const HELPER = /Footsteps|Helper/i;

/**
 * Make a Rocketbox clip safe to play on an avatar holder that already travels along the actor's path:
 *  - keep rotations only, plus the root's position (bone lengths stay the avatar's own; no scale tracks);
 *  - drop helper nodes and anything the avatar doesn't have; rename Bip02 -> Bip01;
 *  - root motion: zero the root's X and Z (keep Y, the bob), so the body doesn't travel twice or snap at the loop.
 * Returns {clip, travel (root ground distance over one loop, clip units), dropped: [track names], missing: []}.
 */
export function prepareClip(clip, boneNames, { root = ROOT_BONE } = {}) {
  const bones = boneNames instanceof Set ? boneNames : new Set(boneNames);
  const tracks = [], dropped = [];
  let travel = 0;
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf(".");
    const node = remapBoneName(t.name.slice(0, dot)), prop = t.name.slice(dot + 1);
    if (HELPER.test(node) || !bones.has(node) || prop === "scale" || (prop === "position" && node !== root)) { dropped.push(t.name); continue; }
    const c = t.clone();
    c.name = `${node}.${prop}`;
    if (prop === "position") {
      const v = c.values, n = v.length / 3;
      travel = Math.hypot(v[3 * (n - 1)] - v[0], v[3 * (n - 1) + 2] - v[2]);
      for (let i = 0; i < n; i++) { v[3 * i] = 0; v[3 * i + 2] = 0; }
    }
    tracks.push(c);
  }
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  return { clip: out, travel, dropped, missing: bindReport(out, bones).missing };
}

/** Does every track of the clip find its bone? {bound: n, missing: [node names]}. */
export function bindReport(clip, boneNames) {
  const bones = boneNames instanceof Set ? boneNames : new Set(boneNames);
  const missing = new Set();
  let bound = 0;
  for (const t of clip.tracks) {
    const node = t.name.slice(0, t.name.lastIndexOf("."));
    if (bones.has(node)) bound++; else missing.add(node);
  }
  return { bound, missing: [...missing] };
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Speed bands (m/s) where one clip crossfades into the next. */
export const BANDS = { idleWalk: [0.15, 0.6], walkRun: [2.0, 2.6] };

/** Clip weights for a ground speed (m/s): idle when still, walk, run, crossfaded across BANDS; they sum to 1. */
export function clipWeights(speed) {
  const s = Math.max(0, speed || 0);
  const move = smooth(...BANDS.idleWalk, s), run = smooth(...BANDS.walkRun, s);
  return { idle: 1 - move, walk: move * (1 - run), run: move * run };
}

/** A small, stable per-actor offset in [0, 1) so two idle people don't breathe in step. */
export function phaseSeed(id) {
  let h = 2166136261;
  for (const ch of String(id || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

/**
 * Clip times (seconds) for this frame: idle runs on the clock of the shot (frame / fps), walk and run on the distance
 * travelled (one loop per `stride` metres), so feet don't skate whatever the speed. Pure: the same frame always gives
 * the same pose (renders are frame-exact). clips = {idle: {duration}, walk: {duration, stride}, run: {...}}.
 */
export function clipTimes({ frame, fps = 24, dist = 0, seed = 0 }, clips) {
  const out = {};
  for (const k of CLIP_KINDS) {
    const c = clips[k];
    if (!c) continue;
    const d = c.duration || 1;
    if (k === "idle") out[k] = (((frame / fps) + seed * d) % d + d) % d;
    else out[k] = ((((dist / Math.max(1e-6, c.stride)) + seed) % 1 + 1) % 1) * d;
  }
  return out;
}

/** Scale (avatar units -> metres) so the avatar's hip height matches the clay figure's: humans.mjs puts the hips at
 *  0.9 * s with s = height / 1.8, i.e. half the height. */
export const hipScale = (heightM, hipUnits) => (0.9 * (heightM / 1.8)) / Math.max(1e-6, hipUnits);

/** The clay figure's default height for a kind (humans.mjs buildHuman). */
export const clayHeight = (a) => a?.height_m || (a?.kind === "child" ? 1.2 : a?.kind === "woman" || a?.appearance?.gender === "female" ? 1.68 : 1.8);

/** A Rocketbox material's role by name: <id>_head, <id>_opacity (lashes and brows), else body. */
export function materialRole(name) {
  const n = String(name || "");
  if (/_head$/i.test(n)) return "head";
  if (/_opacity$/i.test(n)) return "opacity";
  return "body";
}

/** Face option: "keep" the material, "neutral" (plain mannequin skin, no face texture) or "hide" (lashes / brows). */
export function faceChoice(role, faceless) {
  if (!faceless) return "keep";
  return role === "head" ? "neutral" : role === "opacity" ? "hide" : "keep";
}

/** Materials meant to show a texture that have no colour map (names), so a silent texture failure gets caught. */
export function missingColorMaps(materials) {
  return (materials || []).filter((m) => m && m.visible !== false && !m.userData?.plain && !m.map).map((m) => m.name || "(unnamed)");
}

/**
 * Why this person shows as clay at this point instead of the avatar (null = the avatar shows). M1 plays the avatar's
 * own clips, so anything that poses the clay body in a way the clips can't follow keeps the clay for the whole shot
 * (never a pop mid-shot): riding or sitting, being carried, carrying or holding a prop, video mocap, Pose keys, gaze
 * keys, swimming, Drive mode. ctx = {blocking, holders: Set, carriers: Set, swims, gazeKeyed, driven}.
 */
export function clayReason(a, ctx = {}) {
  if (ctx.blocking) return "Blocking look is on";
  if (a.simple_model) return "set to the clay model";
  if (a.mount_id) return "rides or sits on something";
  if (a.carry_id) return "is carried";
  if (a.mocap) return "plays a video mocap take";
  if (a.pose_keys?.length) return "has Pose keys";
  if (ctx.gazeKeyed) return "has gaze keys";
  if (ctx.holders?.has(a.id)) return "holds a prop";
  if (ctx.carriers?.has(a.id)) return "carries something";
  if (ctx.swims) return "swims";
  if (ctx.driven) return "is driven live";
  return null;
}

/** Ids of people holding a prop in any shot, and of people carrying something (from the scene's actors). */
export function propUsers(actors) {
  const holders = new Set(), carriers = new Set();
  for (const o of actors || []) {
    const holds = [o.hold, ...Object.values(o.by_shot || {}).map((s) => s?.hold)].filter(Array.isArray).flat();
    for (const h of holds) if (h?.actor) holders.add(h.actor);
    if (o.carry_id) carriers.add(o.carry_id);
  }
  return { holders, carriers };
}
