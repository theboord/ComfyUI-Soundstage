// Head and gaze blocking for stage people: where each person looks, key by key, so the clay guide carries the head
// turns and the video makes exactly those (and no others).
//
// actor.gaze = [{ frame, target }], sorted by frame. A key holds from its frame until the next one; the head turns
// toward the new target with an eased move that starts AT the key's frame (a turn blocked at 2 s starts at 2 s).
//   target: "ahead"     hold the head steady, facing the way the body (and its travel) faces    [the default]
//           "camera"    look into the shot camera
//           "left" | "right" | "up" | "down"   a fixed look off to that side (60° / 25°)
//           <actor id>  look at that person (their eyes), animal, vehicle or prop (its middle)
// No keys: the head holds steady facing the travel direction; the idle and walk-cycle head sway is cancelled so the
// clay never shows a turn nobody blocked (the old "look around a little" idle read as random turns in the renders).
// The older single look (look_at / look_at_frame / look_until, the Interact menu's "Look at") still plays: it is
// read as keys.
//
// Natural limits (degrees from the chest): the eyes take the first EYES_ONLY of a look without the head moving;
// beyond that the head and neck share the turn (70 / 30), up to HEAD_NECK_MAX; past that the chest turns too, up to
// SPINE_MAX; a target further behind than that is looked at as far as the body allows. Pitch: head 35°, neck 15°.
// Turns take 0.25-0.8 s depending on how far the head goes (a 90° turn ~0.6 s), smoothstep in and out.
//
// Pure maths here (tested in tests/js/gaze.test.mjs); applyGaze() is the stage hook, called once per frame after
// pose keys and motion capture (web/stage/stage.mjs setFrame).
import * as THREE from "../vendor/three.module.min.mjs";
import { applyJoints } from "./humans.mjs";

export const EYES_ONLY = 8;
export const HEAD_NECK_MAX = 80;
export const SPINE_MAX = 40;
export const PITCH = { head: 35, neck: 15 };
export const DIRS = { left: [60, 0], right: [-60, 0], up: [0, 25], down: [0, -25], ahead: [0, 0] };
export const TARGET_WORDS = ["ahead", "camera", "left", "right", "up", "down"];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const ease = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** The keys that drive an actor's head: actor.gaze, else the legacy look_at fields, else [] (hold steady). */
export function gazeKeys(a) {
  if (Array.isArray(a?.gaze) && a.gaze.length) {
    return a.gaze.filter((k) => k && Number.isFinite(+k.frame) && k.target).map((k) => ({ frame: Math.max(0, Math.round(+k.frame)), target: String(k.target) }))
      .sort((x, y) => x.frame - y.frame);
  }
  if (a?.look_at) {
    const out = [{ frame: Math.max(0, a.look_at_frame || 0), target: String(a.look_at) }];
    if (a.look_until != null) out.push({ frame: a.look_until, target: "ahead" });
    return out;
  }
  return [];
}

/** Add (or replace) the key at `frame`; the legacy look fields become keys first so nothing is lost. */
export function setGazeKey(a, frame, target) {
  const keys = gazeKeys(a).filter((k) => k.frame !== Math.round(frame));
  keys.push({ frame: Math.max(0, Math.round(frame)), target: String(target) });
  keys.sort((x, y) => x.frame - y.frame);
  // A first key after frame 0 starts from "ahead": say so, so the file reads the same as the clay.
  a.gaze = keys;
  delete a.look_at; delete a.look_at_frame; delete a.look_until;
  return a.gaze;
}

/** Remove the key at `frame` (all keys when frame is null). */
export function clearGaze(a, frame = null) {
  const keys = gazeKeys(a).filter((k) => frame != null && k.frame !== Math.round(frame));
  if (keys.length) a.gaze = keys; else delete a.gaze;
  delete a.look_at; delete a.look_at_frame; delete a.look_until;
  return keys;
}

/** How long a head turn takes, in frames, for a change of `deg` (0.25 s for a glance, ~0.6 s for 90°, 0.8 s max). */
export function turnFrames(deg, fps = 24) {
  return Math.max(2, Math.round(fps * clamp(0.25 + Math.abs(deg) / 250, 0.25, 0.8)));
}

/**
 * Split a look (yaw, pitch in degrees, relative to the chest; + yaw = the figure's left, + pitch = up) into joint
 * angles within natural limits, in humans.mjs trunk-joint terms: { head: [bend forward, turn left], neck: [...],
 * spine: turn left, eyes: the part of the yaw left to the eyes }. Looking up = a negative bend.
 */
export function splitLook(yaw, pitch = 0) {
  const s = Math.sign(yaw) || 1, ay = Math.abs(yaw);
  const turn = Math.max(0, ay - EYES_ONLY);                     // the eyes take the first few degrees
  const hn = Math.min(turn, HEAD_NECK_MAX);
  const spine = Math.min(SPINE_MAX, Math.max(0, turn - HEAD_NECK_MAX));
  const p = clamp(pitch, -(PITCH.head + PITCH.neck), PITCH.head + PITCH.neck);
  return { head: [clamp(-p * 0.7, -PITCH.head, PITCH.head), s * hn * 0.7], neck: [clamp(-p * 0.3, -PITCH.neck, PITCH.neck), s * hn * 0.3],
    spine: s * spine, eyes: s * Math.min(ay, EYES_ONLY) };
}

/**
 * The look at `frame`: { yaw, pitch, turning } relative to the chest. angleOf(target, frame) -> {yaw, pitch} for a
 * key's target at that frame (moving targets are followed). Between keys the look eases from the previous target to
 * the new one, starting at the key's frame.
 */
export function lookAt(keys, frame, angleOf, fps = 24) {
  const all = [{ frame: -1e9, target: "ahead" }, ...keys];
  let i = all.length - 1;
  while (i > 0 && all[i].frame > frame) i--;
  const cur = angleOf(all[i].target, frame) || { yaw: 0, pitch: 0 };
  if (i === 0) return { ...cur, turning: false };
  const prev = angleOf(all[i - 1].target, all[i].frame) || { yaw: 0, pitch: 0 };
  const dur = turnFrames(Math.hypot(cur.yaw - prev.yaw, cur.pitch - prev.pitch), fps);
  const t = (frame - all[i].frame) / dur;
  if (t >= 1) return { ...cur, turning: false };
  const w = ease(t);
  return { yaw: prev.yaw + (cur.yaw - prev.yaw) * w, pitch: prev.pitch + (cur.pitch - prev.pitch) * w, turning: true };
}

/** A fixed direction word -> {yaw, pitch}, or null for a target that has to be found on the stage. */
export function directionOf(target) {
  const d = DIRS[target];
  return d ? { yaw: d[0], pitch: d[1] } : null;
}

const DEG = 180 / Math.PI;

/** {yaw, pitch} of a world point seen from the figure's head, in the body root's frame (deg; + yaw = its left).
 * The root, not the chest: the walk cycle's chest twist is taken back out in the neck (applyGaze). */
function anglesTo(g, world) {
  const head = g.userData.joints.head.getWorldPosition(new THREE.Vector3());
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
  const rh = head.applyMatrix4(inv), rt = world.clone().applyMatrix4(inv);
  const dx = rt.x - rh.x, dy = rt.y - rh.y, dz = rt.z - rh.z;
  return { yaw: Math.atan2(dx, dz) * DEG, pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG };
}

/** Where a target is in the world at the current frame (the head of a person, the middle of anything else). */
function targetPoint(stage, id) {
  if (id === "camera") {
    const c = stage._cameraAt?.(stage.frame);
    return c ? new THREE.Vector3(...c.position) : null;
  }
  const t = stage.actorMeshes?.get(id);
  if (!t) return null;
  const J = t.userData?.joints;
  if (J?.head) return J.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.03, 0));
  const box = new THREE.Box3().setFromObject(t);
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

/**
 * The stage hook: turn every person's head for the current frame. People with mocap are skipped (the take drives the
 * head), as are people whose Pose Studio keys name the head or neck and who have no gaze keys (a posed head is a
 * choice). Everyone else either follows their gaze keys or holds the head steady facing their travel.
 */
export function applyGaze(stage, skip = new Set()) {
  const fps = stage.state?.shot?.fps || 24, f = stage.frame;
  for (const a of stage.state?.actors || []) {
    if (skip.has(a.id)) continue;
    const g = stage.actorMeshes?.get(a.id), J = g?.userData?.joints;
    if (!J?.head || !J?.neck) continue;
    const keys = gazeKeys(a);
    if (!keys.length && (a.pose_keys || []).some((k) => k?.joints && (k.joints.head || k.joints.neck))) continue;
    g.updateMatrixWorld(true);
    const spineYaw = J.spine ? J.spine.rotation.y * DEG : 0;
    // Everything the walk / gait turns below the neck (waist sway, chest counter-twist), relative to the body root.
    const below = (() => {
      const par = J.neck.parent;
      if (!par) return spineYaw;
      const q = g.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(par.getWorldQuaternion(new THREE.Quaternion()));
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      return Math.atan2(f.x, f.z) * DEG;
    })();
    // The gait swings the whole figure a few degrees about its travel line; the head stays on the line.
    let sway = 0;
    if (!a.mount_id && stage._headingAt) {
      const f0 = new THREE.Vector3(0, 0, 1).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion()));
      const d = ((Math.atan2(f0.x, f0.z) * DEG - stage._headingAt(a, f) * DEG) % 360 + 540) % 360 - 180;
      if (Math.abs(d) <= 15) sway = d;
    }
    // Moving targets are followed: every target is measured where it is at this frame.
    const angleOf = (target) => {
      const d = directionOf(target);
      if (d) return d;
      const p = targetPoint(stage, target);
      if (!p) return { yaw: 0, pitch: 0 };
      const v = anglesTo(g, p), lim = HEAD_NECK_MAX + SPINE_MAX + EYES_ONLY;
      return { yaw: clamp(v.yaw + sway, -lim, lim), pitch: v.pitch };
    };
    const look = lookAt(keys, f, angleOf, fps);
    const sp = splitLook(look.yaw, look.pitch);
    // Head yaw is held relative to the body root: the walk cycle's chest twist (spine yaw) is taken back out in the
    // neck, so a walking head points where it should instead of swinging with the shoulders. Pitch: a keyed look
    // sets it; holding steady keeps the walk's own nod.
    const keep = (j) => [j.rotation.x * DEG, -j.rotation.z * DEG];
    const [nx, nz] = keep(J.neck), [hx, hz] = keep(J.head);
    const posed = {
      neck: [keys.length ? sp.neck[0] : nx, sp.neck[1] - below - sway, nz],
      head: [keys.length ? sp.head[0] : hx, sp.head[1], hz],
    };
    if (sp.spine && J.spine) posed.spine = [J.spine.rotation.x * DEG, spineYaw + sp.spine, -J.spine.rotation.z * DEG];
    applyJoints(g, posed);
    g.userData.gaze = { yaw: look.yaw, pitch: look.pitch, turning: look.turning };
  }
}

/** Gaze keys in words for the panel: "0.0 s ahead · 2.0 s → Ellie". */
export function gazeSummary(a, nameOf = (id) => id, fps = 24) {
  return gazeKeys(a).map((k) => `${(k.frame / fps).toFixed(1)} s ${TARGET_WORDS.includes(k.target) ? k.target : `→ ${nameOf(k.target)}`}`).join(" · ");
}
