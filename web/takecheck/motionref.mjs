// The motion gate's reference: every clay person's skeleton on every frame of the active shot, through the shot
// camera. Same keypoints as the Pose pass (web/stage/posepass.mjs: OpenPose 18 body points, 21 per hand, from the
// rig's joints), so mocap takes, posing in 3D and walk cycles are all in it. The pure packing is model.mjs
// packReference (tested); this file only walks the stage.
import { personKeypoints, toPixels } from "../stage/posepass.mjs";
import { packReference } from "./model.mjs";

/** People on the stage who can be judged (clay humans with a rig), by actor id. */
export function riggedActors(stage) {
  const out = [];
  for (const [id, g] of stage?.actorMeshes || []) if (g?.userData?.joints?.l_shoulder) out.push(id);
  return out;
}

/** -> the payload for POST /soundstage/takecheck/motionref, or null when the shot has no clay people. */
export async function captureMotionReference(stage, { onProgress = null } = {}) {
  if (!stage || !riggedActors(stage).length) return null;
  const frames = Math.max(1, stage.state?.shot?.frames || 97);
  const W = stage.fw, H = stage.fh;
  const names = new Map((stage.toJSON?.().actors || []).map((a) => [a.id, a.name || a.kind || a.id]));
  const people = new Map();
  const keep = stage.frame;
  try {
    for (let f = 0; f < frames; f++) {
      stage.setFrameSilent(f);
      stage._syncShotCamera?.();
      const cam = stage.camera.clone();
      cam.aspect = W / H;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      for (const [id, g] of stage.actorMeshes || []) {
        if (!g?.userData?.joints?.l_shoulder) continue;
        if (!people.has(id)) people.set(id, { id, name: names.get(id) || id, body: new Array(frames).fill(null), hands: new Array(frames).fill(null) });
        if (!g.visible) continue;
        const kp = personKeypoints(g, cam.position);
        if (!kp) continue;
        const px = toPixels(kp, cam, W, H);
        people.get(id).body[f] = px.body;
        people.get(id).hands[f] = px.hands;
      }
      if (onProgress && f % 16 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
  } finally { stage.setFrame(keep); }
  return packReference([...people.values()], { W, H, frames, fps: stage.state?.shot?.fps || 24, shot: stage.activeShot?.()?.id ?? null });
}
