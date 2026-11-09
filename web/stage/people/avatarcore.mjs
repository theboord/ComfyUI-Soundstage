// Lifelike people (Milestone M1 of the people overhaul): the pure rules behind web/stage/people/avatars.mjs, kept free
// of loading and the DOM so node tests can check them (tests/js/avatars.test.mjs).
//
// What the Rocketbox files turned out to be (measured by parsing them with the vendored FBXLoader, 2026-11-07):
//   units   centimetres (Male_Adult_01 is 182 cm tall, the Bip01 root sits at 89.5 cm in the bind pose);
//   axes    FBXLoader already turns 3ds Max's Z-up into Y-up; the avatar faces +Z (the nose bone is ~14 cm in front
//           of the head bone) and its left (Bip01_L_*) is +X, the same as the clay figure (humans.mjs);
//   bones   "Bip01 ..." names come out of FBXLoader with spaces turned into underscores (Bip01_L_Thigh);
//   meshes  each Export/*.fbx holds ONE skinned mesh, "<id>_hipoly_81_bones_opacity" (no separate LOD meshes), with
//           three materials: <id>_body, <id>_head and <id>_opacity (hair cards, and the woman's lashes; alpha in the
//           PNG's alpha; buildKit splits the lashes off: isFaceDetail);
//   extras  each file carries an AmbientLight, removed on load;
//   clips   the *.max.fbx clips put ground travel on the ROOT bone "Bip01" (position Z grows over the loop: walk
//           121 cm / 1.2 s for the man, run 211 cm / 0.73 s); Bip01_Pelvis has no travel. They also animate helper
//           nodes the avatar doesn't have (MotionExtractionHelper, ExposeTransformHelper) or doesn't need
//           (Bip01_Footsteps), and repeat every bone's bind offset as a position track.
import * as THREE from "../../vendor/three.module.min.mjs";
import { LIBRARY } from "../library.mjs";
import { knockedOver, physicsFrom } from "./onemotion.mjs";
import { naturalStride, strideScale, OPTS as LOCO } from "./locomotion.mjs";

/** The person kinds (stage.mjs PERSON_KINDS): every one is lifelike or a marked stand-in, never clay. */
export const PERSON_KINDS = new Set(["man", "woman", "child"]);

/** Which Rocketbox avatar and clips each person kind gets. Children get the marked stand-in until a licence-clean
 *  child avatar exists (Mike, 2026-11-07). */
export const ROCKETBOX = {
  man: { model: "Male_Adult_01", clips: { idle: "m_idle_neutral_01", walk: "m_walk_neutral_01", run: "m_run_neutral_01" }, seated: "m_sit_chair_idle_neutral_01" },
  woman: { model: "Female_Adult_01", clips: { idle: "f_idle_neutral_01", walk: "f_walk_neutral_01", run: "f_run_neutral_01" }, seated: "f_sit_chair_idle_neutral_01" },
};
/** The seated idle (spec.seated) is optional: a kit installed before it was added has none, and a timed sit then
 *  folds the standing idle onto the seat (sitBody) instead of playing the real seated clip. */
export const CLIP_KINDS = ["idle", "walk", "run"];
export const ROOT_BONE = "Bip01";

/** The avatar spec for an actor, or null (the marked stand-in): men and women. The old "simple model" (clay) choice is
 *  ignored: the clay look is retired (Lifelike-only plan), so a saved simple_model person is lifelike too. */
export function avatarSpecFor(a) {
  if (!a) return null;
  if (a.kind === "woman" || (a.kind === "man" && a.appearance?.gender === "female")) return ROCKETBOX.woman;
  if (a.kind === "man") return ROCKETBOX.man;
  return null;
}

/** A 1 x 1 PNG, served from memory for the textures the avatar never uses (no request goes out). */
export const UNUSED_TEXTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** FBXLoader has no TGA reader in our vendored three (FBXLoader.mjs prints "TGA loader not found"): every *.tga the
 *  FBX asks for is loaded as the 1024 px PNG of the same base name from texDir instead. The specular maps are not used
 *  (buildKit makes Standard materials without them), so they are never downloaded: UNUSED_TEXTURE instead. Other URLs
 *  pass through. */
export function tgaToPng(url, texDir) {
  const m = /([^/\\?#]+)\.tga(?:[?#].*)?$/i.exec(String(url || ""));
  if (m && /_specular$/i.test(m[1])) return UNUSED_TEXTURE;
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
 *  - root motion: take out only the steady travel of the loop (the straight line from the first key to the last,
 *    spread evenly over time) and centre what is left. The sway and surge WITHIN a stride stay, so a foot the clip
 *    plants stays planted while the holder moves at the loop's average speed, the loop closes (no snap), the body
 *    doesn't travel twice, and an idle keeps its weight shift. Y (the bob) is untouched.
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
    if (prop === "position") travel = stripSteadyTravel(c.times, c.values);
    tracks.push(c);
  }
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  return { clip: out, travel, dropped, missing: bindReport(out, bones).missing };
}

/** In place on a position track (times, xyz values): subtract the loop's linear X/Z travel and the mean of the rest.
 *  Returns the ground travel over the loop. */
export function stripSteadyTravel(times, v) {
  const n = v.length / 3;
  if (n < 1) return 0;
  const t0 = times[0], span = Math.max(1e-9, times[n - 1] - t0);
  const dx = v[3 * (n - 1)] - v[0], dz = v[3 * (n - 1) + 2] - v[2];
  let mx = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    const u = (times[i] - t0) / span;
    v[3 * i] -= dx * u; v[3 * i + 2] -= dz * u;
    mx += v[3 * i]; mz += v[3 * i + 2];
  }
  mx /= n; mz /= n;
  for (let i = 0; i < n; i++) { v[3 * i] -= mx; v[3 * i + 2] -= mz; }
  return Math.hypot(dx, dz);
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

/** The human idle <-> walk crossfade's ease (frames, a Gaussian's sigma; gaitTable). */
export const BLEND_SIGMA = 2.5;

/** Clip weights with the move weight (walk + run) given, the walk / run split by speed (gaitTable's human crossfade). */
export function moveWeights(speed, move) {
  const run = smooth(...BANDS.walkRun, Math.max(0, speed || 0)), m = Math.max(0, Math.min(1, move));
  return { idle: 1 - m, walk: m * (1 - run), run: m * run };
}

/** A small, stable per-actor offset in [0, 1) so two idle people don't breathe in step. */
export function phaseSeed(id) {
  let h = 2166136261;
  for (const ch of String(id || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

/** The stride (m per loop) of the moving clips at these weights: walk and run blended as they are mixed. */
export function blendStride(w, strides) {
  const ww = w.walk || 0, wr = w.run || 0;
  if (ww + wr < 1e-9) return strides.walk || strides.run || 1;
  return (ww * (strides.walk || strides.run) + wr * (strides.run || strides.walk)) / (ww + wr);
}

/**
 * Speed and gait phase for every frame of the shot from the actor's ground positions (positions[f] = [x, z], f = 0..
 * last). speed[f] (m/s) is taken over about half a second around f, so a start or stop at a key crossfades. phase[f]
 * is ONE normalised gait phase shared by walk and run (the Rocketbox walk and run are phase-aligned: left foot back
 * at 0.25 in both): it advances by the distance of each frame divided by the stride of the clips as they are mixed
 * at that moment, so blended legs stay together in step and the feet don't skate at any speed.
 * strides = {walk, run} in metres. Pure: the same positions always give the same table.
 * In the idle <-> walk band the stride is also divided by the walk + run weight (at least 0.2): blended with the idle,
 * the walk's foot travels only that share of its stride under the body, and played at the plain rate its stance foot
 * crept forward (5 cm/s at 0.5 m/s), so a planted foot fell out of the leg's reach and the hips dipped 7-12 cm.
 * headings[f] (radians, optional): where the body faces; a frame moving against it (backwards, more than ~107
 * degrees off) runs the phase backwards, so the clip walks backwards and the feet plant instead of skating.
 */
export function gaitTable(positions, fps, strides, { window = 6, headings = null, human = null } = {}) {
  const n = positions.length, speed = new Float64Array(n), phase = new Float64Array(n), scale = new Float64Array(n).fill(1);
  for (let f = 0; f < n; f++) {
    const f0 = Math.max(0, f - window), f1 = Math.min(n - 1, f + window);
    const a = positions[f0], b = positions[f1];
    speed[f] = f1 > f0 ? Math.hypot(b[0] - a[0], b[1] - a[1]) / ((f1 - f0) / fps) : 0;
  }
  // human: the idle <-> walk crossfade is eased over about half a second (the move weight smoothed, sigma 4 frames):
  // a person now speeds up from standing over ~0.7 s, and by speed alone the 0.15-0.6 m/s band went by in 4 frames
  let move = null;
  if (human && human.blend !== false) {
    const raw = Array.from(speed, (v) => 1 - clipWeights(v).idle), sig = BLEND_SIGMA, R = Math.ceil(3 * BLEND_SIGMA);
    move = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0, w = 0;
      for (let j = -R; j <= R; j++) { const k = Math.exp(-0.5 * (j / sig) ** 2); s += k * raw[Math.max(0, Math.min(n - 1, f + j))]; w += k; }
      move[f] = s / w < 1e-4 ? 0 : s / w > 1 - 1e-4 ? 1 : s / w;
    }
  }
  const wAt = (f, v) => (move ? moveWeights(v, move[f]) : clipWeights(v));
  for (let f = 1; f < n; f++) {
    const a = positions[f - 1], b = positions[f];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const w = wAt(f, 0.5 * (speed[f - 1] + speed[f]));
    let dir = 1;
    if (headings && d > 1e-9) {
      const h = headings[f];
      if (Number.isFinite(h) && ((b[0] - a[0]) * Math.sin(h) + (b[1] - a[1]) * Math.cos(h)) / d < -0.3) dir = -1;
    }
    // human (locomotion.mjs): the stride follows the speed (cadence AND stride grow with it), and the clip's leg swing
    // is scaled to it (scale[f], drive's strideScale), instead of the clip's own 1.2 m stride played faster or slower
    // (that made 2.9 steps a second at 1.7 m/s and 1.2 at 0.7 m/s)
    const clip = blendStride(w, strides), mw = (w.walk || 0) + (w.run || 0);
    const s = human && human.stride !== false ? strideScale(naturalStride(0.5 * (speed[f - 1] + speed[f]), w, human.height, human.tempo), clip, mw) : 1;
    scale[f] = s;
    phase[f] = phase[f - 1] + dir * d / Math.max(1e-6, clip * s * Math.max(0.2, mw));
  }
  if (n > 1) scale[0] = scale[1];
  return move ? { speed, phase, scale, move } : { speed, phase, scale };
}

/** The idle's playback rate for a person's seed (1 at seed 0). */
export const idlePace = (seed) => 1 + 0.1 * Math.sin(2 * Math.PI * 3.7 * (seed || 0));

/**
 * Clip times (seconds) for this frame: idle runs on the clock of the shot (frame / fps); walk and run share one gait
 * phase (gaitTable) so they blend in step. Pure: the same frame always gives the same pose (renders are frame-exact).
 * clips = {idle: {duration}, walk: {duration}, run: {duration}}.
 */
export function clipTimes({ frame, fps = 24, phase = 0, seed = 0 }, clips) {
  const out = {};
  const frac = (((phase + seed) % 1) + 1) % 1;
  for (const k of CLIP_KINDS) {
    const c = clips[k];
    if (!c) continue;
    const d = c.duration || 1;
    // (the idle at each person's own pace, 0.9-1.1x from the seed: two people standing side by side don't shift their
    // weight in step; seed 0 plays the clip at its own rate)
    out[k] = k === "idle" ? (((frame / fps) * (LOCO.idlePace ? idlePace(seed) : 1) + seed * d) % d + d) % d : frac * d;
  }
  return out;
}

/** Scale (avatar units -> metres) so the avatar stands as tall as the person is set to: heightM over the avatar's
 *  measured standing height (top of the head in its idle pose, avatar units). Hip height is NOT used: the Rocketbox
 *  woman's hips sit at 55 % of her height, not the clay's 50 %, which made her ~10 cm short. */
export const statureScale = (heightM, statureUnits) => heightM / Math.max(1e-6, statureUnits);

/** The height the clay figure is built at: exactly what stage._buildSet asks buildObject for (a.height_m, else the
 *  kind's LIBRARY height; library.mjs buildObject: `height || spec?.height || 1`). It goes by the KIND only: a man set
 *  to gender female is still built at the man's 1.80 m (he gets the woman's avatar, at the clay's height). */
export const clayHeight = (a) => a?.height_m || LIBRARY[a?.kind]?.height || 1;

/** A Rocketbox material's role by name: <id>_head, <id>_opacity (the hair cards), <id>_opacity_lashes (the lash and
 *  brow cards buildKit splits off the opacity material: splitFaceDetail), else body. */
export function materialRole(name) {
  const n = String(name || "");
  if (/_head$/i.test(n)) return "head";
  if (/_opacity_lashes$/i.test(n)) return "lashes";
  if (/_opacity$/i.test(n)) return "opacity";
  return "body";
}

/** Face option: "keep" the material, "neutral" (plain mannequin skin: no painted brows, eyes or lips) or "hide" (the
 *  lash / brow cards). Faceless keeps the hair (the opacity cards) and the body. */
export function faceChoice(role, faceless) {
  if (!faceless) return "keep";
  return role === "head" ? "neutral" : role === "lashes" ? "hide" : "keep";
}

/**
 * Is a card triangle of the opacity material a lash or brow (face detail) rather than hair? Rocketbox keeps hair and
 * lashes in ONE material and texture (f001: the lashes are a corner of the hair atlas; m002's atlas is all hair), and
 * skinning doesn't tell them apart either (the woman's lower lashes ride Bip01_Head like her hair). Position does, in
 * the bind pose: a lash or brow lies within 0.6 eye spacings of an eye bone and in front of the eyes. Measured on the
 * real files (2026-11-07): the woman's 208 lash triangles are all within 0.37 spacings and the nearest hair is 3.3
 * spacings away; the man's nearest hair is 0.83 spacings away (behind the eyes), so he has no lash cards to hide.
 * centroid, lEye, rEye: world points (bind pose); forward: the face's forward axis (unit, +Z for Rocketbox).
 */
export function isFaceDetail(centroid, lEye, rEye, forward = new THREE.Vector3(0, 0, 1), { radius = 0.6 } = {}) {
  const sp = lEye.distanceTo(rEye);
  if (!(sp > 1e-6)) return false;
  const near = Math.min(centroid.distanceTo(lEye), centroid.distanceTo(rEye)) / sp;
  if (near >= radius) return false;
  const mid = lEye.clone().add(rEye).multiplyScalar(0.5);
  return centroid.clone().sub(mid).dot(forward) > 0;
}

/**
 * How much of the face (0..1) a head vertex is, in the bind pose: a soft box in the face's own frame, in eye spacings
 * (sp) from the point between the eyes: from under the chin (-2.3 sp) up to just above the brows (0.6 -> 0.95 sp, so
 * the hairline and the painted hair above it stay), across to the outer cheeks (0.85 -> 1.15 sp, before the ears and
 * temples), and only in front of the ears (deeper than -0.9 sp behind the eyes is not face). Faceless paints this
 * region one flat skin colour (the brows, eyes, lips and the eyeballs go; the shape stays) and leaves the rest of the
 * head texture, which is where Rocketbox paints most of the hair (the woman's scalp and ponytail roots are texture,
 * not cards).
 */
export function faceMaskAt(p, lEye, rEye, forward = new THREE.Vector3(0, 0, 1)) {
  const sp = lEye.distanceTo(rEye);
  if (!(sp > 1e-6)) return 0;
  const mid = lEye.clone().add(rEye).multiplyScalar(0.5);
  const X = lEye.clone().sub(rEye).normalize(), Z = forward.clone().sub(X.clone().multiplyScalar(forward.dot(X))).normalize();
  const Y = Z.clone().cross(X);
  const d = p.clone().sub(mid);
  const x = Math.abs(d.dot(X)) / sp, y = d.dot(Y) / sp, z = d.dot(Z) / sp;
  const up = 1 - smooth(0.6, 0.95, y), down = smooth(-2.6, -2.3, y), side = 1 - smooth(0.85, 1.15, x), front = smooth(-1.1, -0.7, z);
  return Math.max(0, Math.min(1, up * down * side * front));
}

/**
 * Split a card material's groups so its face-detail triangles (isDetail(first vertex index of the triangle)) draw with
 * material index lashIndex instead; the hair keeps its index. Rewrites geometry.groups in place (shared by every clone
 * of the avatar). isCard(materialIndex) picks the groups to split. Returns the number of triangles moved.
 */
export function splitGroups(geometry, isCard, lashIndex, isDetail) {
  const out = [];
  let moved = 0;
  for (const g of geometry.groups) {
    if (!isCard(g.materialIndex)) { out.push({ ...g }); continue; }
    let run = null;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const detail = isDetail(i);
      const mi = detail ? lashIndex : g.materialIndex;
      if (detail) moved++;
      if (run && run.materialIndex === mi && run.start + run.count === i) run.count += 3;
      else out.push((run = { start: i, count: 3, materialIndex: mi }));
    }
  }
  geometry.clearGroups();
  for (const g of out) geometry.addGroup(g.start, g.count, g.materialIndex);
  return moved;
}

/** A cheap, allocation-free signature of a key list (every own field: numbers, strings, number arrays, nested
 *  objects one level), so the per-frame gait cache check doesn't JSON.stringify every person's keys every frame. */
export function keysHash(keys) {
  let h = 2166136261 ^ (keys?.length || 0);
  const f64 = keysHash._f || (keysHash._f = new Float64Array(1)), u32 = keysHash._u || (keysHash._u = new Uint32Array(f64.buffer));
  const num = (x) => { f64[0] = x; h = Math.imul(h ^ u32[0], 16777619); h = Math.imul(h ^ u32[1], 16777619); };
  const str = (t) => { for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); h = Math.imul(h ^ 31, 16777619); };
  const val = (v, deep) => {
    if (typeof v === "number") num(v);
    else if (typeof v === "string") str(v);
    else if (typeof v === "boolean") num(v ? 1 : 2);
    else if (v == null) num(-7.25);
    else if (Array.isArray(v)) { num(v.length); for (const x of v) val(x, deep); }
    else if (typeof v === "object" && deep) for (const k in v) { str(k); val(v[k], false); }
  };
  for (const k of keys || []) for (const name in k) { str(name); val(k[name], true); }
  return h >>> 0;
}

/** Materials meant to show a texture that have no colour map (names), so a silent texture failure gets caught. */
export function missingColorMaps(materials) {
  return (materials || []).filter((m) => m && m.visible !== false && !m.userData?.plain && !m.map).map((m) => m.name || "(unnamed)");
}

/**
 * Why this person's feet are NOT on the ground (null: they are, and footplant grounds them), whatever the body looks
 * like. This is the grounding gate. Since the clay look is retired (one motion drives the visible body and the logic rig,
 * onemotion.mjs), people holding or carrying props, with gaze or Pose keys, on a mocap take or driven live are lifelike
 * AND standing, so they are grounded. Only a body that is really off its feet is not: riding or seated
 * (mount_id), carried, moved or lifted by physics, knocked over / tipped / lying, swimming or floating, in the air.
 * ctx: {swims, floats, tipped, lifted, airborne, sits, mounted} (all but tipped per frame). A timed mount (mount_at)
 * walks up on its feet: only its hop and seat frames are off them (ctx.mounted, from stage._mountPhaseAt). A tilt
 * counts only when it knocks the person over (onemotion.knockedOver: a stray 1-degree gizmo nudge does not).
 */
export function feetUpReason(a, ctx = {}) {
  if (a.mount_id && !(a.mount_at > 0)) return "rides or sits on something";
  if (ctx.mounted) return "rides or sits on something";
  if (a.carry_id) return "is carried";
  if (physicsFrom(a) === 0 || ctx.physics) return "is moved by physics";   // (a takeover part-way: the frames after it, ctx.physics)
  if (ctx.lifted) return "is lifted by physics";
  if (knockedOver(a)) return "was knocked over";
  if (ctx.tipped) return "is tipped over";
  if (ctx.swims) return "swims";
  if (ctx.floats) return "floats in the water";
  if (ctx.airborne) return "is in the air (a jump or vault)";
  if (ctx.sits) return "sits on a seat or the floor";
  return null;
}

/** Does this person swim anywhere in the shot? The same gate as stage._swimAt (swimming off, carried) over the
 *  whole-shot swim plan; plan is called only when the gate allows it. */
export function swimsInShot(a, plan) {
  if (!a || a.carry_id) return false;   // swimming "off" is Can't swim now (buoyancy.mjs swimMode): still on a swim plan
  const p = plan();
  if (!p?.mode) return !!p;
  for (let i = 0; i < p.mode.length; i++) if (p.mode[i]) return true;
  return false;
}

/** Does this person swim at frame f? swimsInShot's gate, on the swim plan's per-frame mode (a plan without one: the
 *  whole shot). The grounding gate reads this, so the walk before a swim is grounded. */
export function swimsAt(a, f, plan) {
  if (!a || a.carry_id) return false;
  const p = plan();
  if (!p?.mode) return !!p;
  return !!p.mode[Math.max(0, Math.min(p.mode.length - 1, Math.round(f)))];
}

/**
 * Driven live right now: Drive is on and has this person (driving, or a mount / carry it is setting live). Read from
 * the live Drive state only, never a memo of earlier frames or shots, so the same frame gives the same owner whatever
 * was shown before and on a fresh stage (a memo kept a person rig-owned after Drive let go). drive = stage.drive.
 */
export function drivenNow(drive, id) {
  return !!(drive?.on && (drive.live?.has?.(id) || drive.involved?.has?.(id) || drive.owns?.(id)));
}

/** Ids of people holding a prop in any shot, and of people carrying something (from the scene's actors). */
export function propUsers(actors) {
  const holders = new Set(), carriers = new Set();
  for (const o of actors || []) {
    const holds = [o.hold, ...Object.values(o.by_shot || {}).map((s) => s?.hold)].filter(Array.isArray).flat();
    for (const h of holds) if (h?.actor) holders.add(h.actor);
    if (o.carry_id) carriers.add(o.carry_id);
    // a recorded Drive carry (drive.applyTake: the load's baked keys, who held it when): Drive.post() poses the
    // carrier's arms round it, so they are a layer over the clip like a live carrier's (was: the clip's swing kept)
    for (const s of o.carry_spans || []) if (s?.by) carriers.add(s.by);
  }
  return { holders, carriers };
}
