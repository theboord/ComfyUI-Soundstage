// One motion (Lifelike-only plan, L1 section 2): who drives a lifelike person's body at each frame. Pure rules, no
// three.js and no clock, so node tests check them and every frame is the same in any scrub order.
//   clip  the avatar's own idle / walk / run, on the shot clock and the planGait phase (avatarcore.clipTimes); the
//         clay logic rig is then solved from the visible body (retarget.solveRigFromBody).
//   rig   the clay rig's pose (a ride, a carry, a mocap take, a swim stroke, a jump, a fall, Drive): the visible body is
//         retargeted from it (retarget.retargetFromRig). The body never swaps to clay: it is the same lifelike body.
//   seat  seated on a chair / bench / sofa or the floor: the idle with the legs folded onto the seat (avatars.sitBody).
// The handover between clip and rig is an explicit per-frame weight (rigWeight), never a mixer fade: a 6-frame ease
// that ENDS on the change frame, so the incoming owner is at full weight there (a jump's first airborne frame is the
// rig's tuck, never the walk). At the shot's start there is no fade.

export const FADE_FRAMES = 6;

/**
 * Why the rig owns this person for the whole shot (null: it does not). Whole-shot facts only (the scene's data).
 * ctx: {sits, driven}.
 */
export function rigShotReason(a, ctx = {}) {
  if (a.mount_id && !ctx.sits) return "rides or sits on something";
  if (a.carry_id) return "is carried";
  if (a.mocap) return "plays a video mocap take";
  if (a.physics?.baked) return "is moved by physics";
  if (Array.isArray(a.tilt) && a.tilt.length === 4) return "was knocked over";
  if (ctx.driven) return "is driven live";
  return null;
}

/**
 * Why the rig owns this person at frame f (null: the clip, or the seat). frameCtx(f) -> {airborne, swims, floats}.
 * shot: rigShotReason's result for the shot.
 */
export function rigReasonAt(shot, fr) {
  if (shot) return shot;
  if (fr?.swims) return "swims";
  if (fr?.floats) return "floats in the water";
  if (fr?.airborne) return "is in the air (a jump or vault)";
  return null;
}

const smooth = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/**
 * The rig's weight at frame f (0 = the clip, 1 = the rig), from owner(i) -> boolean (the rig owns frame i) for the
 * frames f - FADE_FRAMES .. f + FADE_FRAMES (clamped). Pure: only those frames are read. The fade ends on the change
 * frame; a segment shorter than the fade keeps its own first frame at full weight and eases out over the rest.
 */
export function rigWeight(f, owner, last, fade = FADE_FRAMES) {
  const here = owner(f) ? 1 : 0;
  for (let k = 1; k <= fade && f + k <= last; k++) {
    const next = owner(f + k) ? 1 : 0;
    if (next === here) continue;
    // A short segment (a hop of 4 airborne frames): its own change frame stays at full weight, so the ease toward the
    // next change is squeezed into the frames after it (span), never begun before the segment did.
    let span = fade;
    for (let j = 1; j <= fade && f - j >= 0; j++) if ((owner(f - j) ? 1 : 0) !== here) { span = Math.min(fade, k + j - 2); break; }
    if (k > span) return here;
    return here + (next - here) * smooth((span - k + 1) / (span + 1));
  }
  return here;
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
