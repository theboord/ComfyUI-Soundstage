// One motion (Lifelike-only plan, L1 section 2): who drives a lifelike person's body at each frame. Pure rules, no
// three.js and no clock, so node tests check them and every frame is the same in any scrub order.
//   clip  the avatar's own idle / walk / run, on the shot clock and the planGait phase (avatarcore.clipTimes); the
//         clay logic rig is then solved from the visible body (retarget.solveRigFromBody).
//   rig   the clay rig's pose (a ride, a carry, a mocap take, a swim stroke, a jump, a fall, Drive): the visible body is
//         retargeted from it (retarget.retargetFromRig). The body never swaps to clay: it is the same lifelike body.
//   seat  seated on a chair / bench / sofa or the floor: the idle with the legs folded onto the seat (avatars.sitBody).
// The handover between clip / seat and rig is an explicit per-frame weight (ownerMix), never a mixer fade: a 6-frame
// ease INSIDE the rig's frames at each end, so neither owner's pose jumps into the body. At the shot's start no fade.

export const FADE_FRAMES = 6;

/** A tilt (a.tilt, a quaternion on top of the heading) this far off upright knocks a person over (degrees): the rig
 *  owns the body. Under it (a stray gizmo nudge, a lean) the clip keeps the body, tilted with the rig. */
export const KNOCK_DEG = 30;
/** How far a.tilt turns the body's up axis off vertical (degrees; 0 without a tilt). */
export function tiltDeg(a) {
  const t = a?.tilt;
  if (!Array.isArray(t) || t.length !== 4) return 0;
  const [x, y, z, w] = t.map(Number), n = Math.hypot(x, y, z, w) || 1;
  const upY = 1 - 2 * ((x / n) ** 2 + (z / n) ** 2);
  return (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI;
}
/** Knocked over: tilted KNOCK_DEG or more (not just any saved tilt). */
export const knockedOver = (a) => tiltDeg(a) >= KNOCK_DEG;

/** The frame physics takes a baked person over from (a.physics.takeover.frame: the authored keys play before it, the
 *  physics after), 0 for a person physics moves all shot, Infinity for one not baked. */
export function physicsFrom(a) {
  if (!a?.physics?.baked) return Infinity;
  const t = Number(a.physics.takeover?.frame);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * Why the rig owns this person for the WHOLE shot (null: it does not). Whole-shot facts only (the scene's data and the
 * live Drive state at this moment, never a memo of earlier frames). ctx: {driven}. A mount is per frame (ownerAt): the
 * walk up to a chair or a horse is the clip's.
 */
export function rigShotReason(a, ctx = {}) {
  if (a.carry_id) return "is carried";
  if (a.mocap) return "plays a video mocap take";
  if (physicsFrom(a) === 0) return "is moved by physics";   // (a takeover part-way: per frame, ownerAt fr.physics)
  if (knockedOver(a)) return "was knocked over";
  if (ctx.driven) return "is driven live";
  return null;
}

/**
 * Who owns frame f and why: {own: "clip" | "rig" | "seat", reason}. shot: rigShotReason's result; fr: the frame's
 * facts {mount: "walk" | "hop" | "on" | "off" | null (stage._mountPhaseAt; "off": a recorded span's getting out), physics (past a baked takeover's frame, physicsFrom), sits, swims, exits (in the stage's climb out of
 * the water, stage._swimExits), floats, airborne}.
 */
export function ownerAt(shot, fr = {}) {
  if (shot) return { own: "rig", reason: shot };
  if (fr.physics) return { own: "rig", reason: "is moved by physics" };
  if (fr.sits) return { own: "seat", reason: "sits" };
  if (fr.mount === "hop") return { own: "rig", reason: "gets on a mount" };
  if (fr.mount === "on") return { own: "rig", reason: "rides or sits on something" };
  if (fr.mount === "off") return { own: "rig", reason: "gets off a mount" };
  if (fr.swims) return { own: "rig", reason: "swims" };
  // the stage's own climb out over the tank's wall (stage._swimExits) runs on after the swim plan ends: the rig keeps the
  // body until it finishes (was: the clip took it at the walk's keys, 2.8 m ahead of the climbing rig)
  if (fr.exits) return { own: "rig", reason: "climbs out of the water" };
  if (fr.floats) return { own: "rig", reason: "floats in the water" };
  if (fr.airborne) return { own: "rig", reason: "is in the air (a jump or vault)" };
  return { own: "clip", reason: null };
}

/** (old name) Why the rig owns frame f, or null. */
export function rigReasonAt(shot, fr) {
  const o = ownerAt(shot, fr);
  return o.own === "rig" ? o.reason : null;
}

const smooth = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
const ramp = (d, fade) => (d >= fade ? 1 : smooth((d + 1) / (fade + 1)));

/**
 * The per-frame mix of motion sources at frame f: {own, w: {clip, rig, seat}, prev, next, prevAt, nextAt}, from
 * kind(i) -> "clip" | "rig" | "seat" for the frames f - fade .. f + fade (clamped to 0 .. last). Pure: only those frames
 * are read, so any scrub order gives the same mix.
 * The handover happens INSIDE the rig's frames: the rig's own pose is continuous within its frames but jumps where
 * the stage changes how it poses the logic rig (a jump's tuck on its first airborne frame, a hop onto a chair, a swim's
 * first stroke), so blending toward the rig before it owns the frame copied that jump into the body (a hand 76 cm in one
 * frame at a crate hop). The clip and the seat can be posed on any frame, so the rig's segment eases in from its
 * neighbour over its first `fade` frames and out to the next over its last (both ends of a short segment at once, the
 * weights a smooth function of the distance to each end: no step, whatever the segment's length). Clip and seat
 * segments never fade (a clip-to-seat change with no rig between is not made by the stage).
 */
export function ownerMix(f, kind, last, fade = FADE_FRAMES) {
  const own = kind(f);
  const w = { clip: 0, rig: 0, seat: 0 };
  if (own !== "rig" || !(fade > 0)) { w[own] = 1; return { own, w, prev: null, next: null, prevAt: -1, nextAt: -1 }; }
  let prev = null, next = null, prevAt = -1, nextAt = -1, d0 = fade, d1 = fade;
  for (let j = 1; j <= fade && f - j >= 0; j++) { const k = kind(f - j); if (k !== "rig") { prev = k; prevAt = f - j; d0 = j - 1; break; } }
  for (let j = 1; j <= fade && f + j <= last; j++) { const k = kind(f + j); if (k !== "rig") { next = k; nextAt = f + j; d1 = j - 1; break; } }
  // the rig's weight: the product of the two ends' eases; the rest to the neighbours in proportion to their own
  const ea = prev ? ramp(d0, fade) : 1, eb = next ? ramp(d1, fade) : 1, r = ea * eb, sum = (1 - ea) + (1 - eb);
  const wp = sum > 0 ? ((1 - ea) / sum) * (1 - r) : 0, wn = sum > 0 ? (1 - r) - wp : 0;
  w.rig = r;
  if (prev) w[prev] += wp;
  if (next) w[next] += wn;
  return { own, w, prev, next, prevAt, nextAt };
}

/** (old API, kept for callers) The rig's weight at frame f from owner(i) -> boolean (the rig owns frame i). */
export function rigWeight(f, owner, last, fade = FADE_FRAMES) {
  return ownerMix(f, (i) => (owner(i) ? "rig" : "clip"), last, fade).w.rig;
}

/**
 * The joints of the clay rig a CLIP-owned body takes from the rig as a layer (Set of clay joint ids, may be empty):
 * gaze keys turn the neck and head, Pose keys the joints they name (fingers excepted), a carrier's arms hold the load
 * (stage.setFrame poses them round it). A holder's prop hand follows the clip (stage._handGrip reads the visible hand). poseJoints: the joint ids the person's Pose keys name.
 */
export function layerJoints({ gazeKeyed = false, poseJoints = null, carries = false } = {}, layerable = () => true) {
  const s = new Set();
  if (gazeKeyed) { s.add("neck"); s.add("head"); }
  if (carries) for (const lr of ["l", "r"]) for (const j of ["shoulder", "elbow", "wrist"]) s.add(`${lr}_${j}`);
  for (const id of poseJoints || []) if (layerable(id)) s.add(id);
  return s;
}

/** The joint ids every Pose key of a person names (whole shot). */
export function poseKeyJoints(a) {
  const s = new Set();
  for (const k of a?.pose_keys || []) for (const id of Object.keys(k?.joints || {})) s.add(id);
  return s;
}

/** The per-actor shown state for the capture sheet (plan 1.3 B5): lifelike | faceless | standin. */
export function shownState({ skin = null, faceless = false } = {}) {
  if (!skin) return "standin";
  return faceless ? "faceless" : "lifelike";
}
