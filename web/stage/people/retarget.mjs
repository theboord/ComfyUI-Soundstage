// One motion (Lifelike-only plan, L1 section 2): the visible Rocketbox body and the hidden clay logic rig always show
// the SAME pose, whichever of them the frame's motion source drives.
//   retargetFromRig  the clay rig is the source (a ride, a carry, a mocap take, a swim stroke, a jump's tuck, a knock-
//                    over, Pose keys, gaze): the visible Bip01 bones are posed from the clay joints.
//   solveRigFromBody the clip is the source (idle / walk / run on the gait phase, the feet grounded): the clay joints are
//                    turned to follow the visible bones, so Pose keypoints, held props, the gizmo and every reader of
//                    the logic rig agree with what the camera sees.
// Directions only, no axis conventions assumed for Rocketbox (the bones are aimed in world space, like avatars.mjs
// sitBody). The clay limbs hang along their joint's -Y at rest (humans.mjs buildHuman); trunk, hands and feet carry a
// fixed rest offset per kit (restOffsets), measured once on the idle's first frame, so the result is a pure function
// of the clay pose and the frame: no clock, no state carried from the last frame (the undo list puts the clay back
// before the stage poses it again).
import * as THREE from "../../vendor/three.module.min.mjs";

const DOWN = new THREE.Vector3(0, -1, 0);
/** Trunk and end bones: set to the clay joint's world rotation times the kit's rest offset. null = the clay group. */
export const ORIENT = [
  ["Bip01_Pelvis", null], ["Bip01_Spine", "spine"], ["Bip01_Neck", "neck"], ["Bip01_Head", "head"],
  ["Bip01_L_Hand", "l_wrist"], ["Bip01_R_Hand", "r_wrist"], ["Bip01_L_Foot", "l_knee"], ["Bip01_R_Foot", "r_knee"],
];
/** Limb bones: aimed so the child bone lies along the clay joint's -Y. [bone, child bone, clay joint]. */
export const AIM = [
  ["Bip01_L_Thigh", "Bip01_L_Calf", "l_hip"], ["Bip01_L_Calf", "Bip01_L_Foot", "l_knee"],
  ["Bip01_R_Thigh", "Bip01_R_Calf", "r_hip"], ["Bip01_R_Calf", "Bip01_R_Foot", "r_knee"],
  ["Bip01_L_UpperArm", "Bip01_L_Forearm", "l_shoulder"], ["Bip01_L_Forearm", "Bip01_L_Hand", "l_elbow"],
  ["Bip01_R_UpperArm", "Bip01_R_Forearm", "r_shoulder"], ["Bip01_R_Forearm", "Bip01_R_Hand", "r_elbow"],
];
// Rocketbox finger chains: thumb Finger0, index Finger1, middle 2, ring 3, pinky 4; segments N, N1, N2.
const FINGER = { thumb: 0, index: 1, middle: 2, ring: 3, pinky: 4 };
/** The visible bone a clay joint id stands for (the gizmo's dots, boneWorld), or null. */
export function boneFor(jointId) {
  const id = String(jointId || "");
  const fixed = { spine: "Bip01_Spine1", neck: "Bip01_Neck", head: "Bip01_Head" }[id];
  if (fixed) return fixed;
  const m = /^([lr])_(shoulder|elbow|wrist|hip|knee)$/.exec(id);
  if (m) return `Bip01_${m[1].toUpperCase()}_${{ shoulder: "UpperArm", elbow: "Forearm", wrist: "Hand", hip: "Thigh", knee: "Calf" }[m[2]]}`;
  const f = /^([lr])_(thumb|index|middle|ring|pinky)_([123])$/.exec(id);
  if (f) return `Bip01_${f[1].toUpperCase()}_Finger${FINGER[f[2]]}${f[3] === "1" ? "" : String(+f[3] - 1)}`;
  return null;
}
/** The clay joints a layer may name, and what each is in ORIENT / AIM (fingers are not layered). */
const LAYERABLE = new Set(["spine", "neck", "head", "l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist", "l_hip", "l_knee", "r_hip", "r_knee"]);
export const layerable = (id) => LAYERABLE.has(id);

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();

/** Set object o's world rotation to q (its parent's world matrix must be current). */
function setWorldQuat(o, q) {
  o.parent.updateWorldMatrix(true, false);
  o.parent.getWorldQuaternion(_qp);
  o.quaternion.copy(_qp.invert().multiply(q));
  o.updateWorldMatrix(false, true);
}
/** Turn bone b so its child c lies along world direction dir (minimal turn from where it points now). */
function aim(b, c, dir) {
  b.updateWorldMatrix(true, true);
  b.getWorldPosition(_a); c.getWorldPosition(_b);
  const cur = _b.sub(_a);
  if (cur.lengthSq() < 1e-12 || dir.lengthSq() < 1e-12) return;
  _q.setFromUnitVectors(cur.normalize(), _d.copy(dir).normalize());
  b.getWorldQuaternion(_q2);
  setWorldQuat(b, _q.multiply(_q2));
}
const jointQ = (g, id) => (id ? g.userData.joints[id] : g).getWorldQuaternion(new THREE.Quaternion());

/**
 * The kit's rest offsets: for each ORIENT bone, its rotation in the holder's frame on the idle clip's first frame
 * (the clay at rest is upright with every joint unturned, so clay-joint-world x offset = the bone's rest pose).
 * Measured once per kit on a skin (drive is the caller's: skin posed on idle frame 0 before this). Cached on the kit.
 */
export function restOffsets(skin) {
  if (skin.kit._rtOff) return skin.kit._rtOff;
  skin.holder.updateWorldMatrix(true, true);
  const hq = skin.holder.getWorldQuaternion(new THREE.Quaternion()).invert();
  const off = {};
  for (const [bn] of ORIENT) { const b = skin.bones[bn]; if (b) off[bn] = hq.clone().multiply(b.getWorldQuaternion(new THREE.Quaternion())); }
  skin.kit._rtOff = off;
  return off;
}

/** Can this skin be retargeted (all the trunk and limb bones are there)? */
export const canRetarget = (skin) => !!skin?.bones && ORIENT.every(([b]) => skin.bones[b]) && AIM.every(([b, c]) => skin.bones[b] && skin.bones[c]);

/**
 * Pose the visible body from the clay rig g (already posed for this frame): trunk / hands / feet from the clay joints'
 * world rotations, limbs aimed along the clay limbs, then the holder moved so the avatar's hip joints sit on the
 * clay's. only (optional Set of clay joint ids): a LAYER, just those joints (gaze: neck + head; a carrier's arms; the
 * joints a Pose key names), the holder not moved. The caller has posed the skin on its clip (avatars.drive) first and
 * placed the holder at the clay's heading and scale.
 */
export function retargetFromRig(skin, g, { only = null } = {}) {
  const J = g.userData.joints, B = skin.bones;
  if (!J || !canRetarget(skin)) return false;
  const off = skin.kit._rtOff;
  if (!off) return false;
  g.updateWorldMatrix(true, true);
  const want = (id) => !only || only.has(id);
  for (const [bn, jid] of ORIENT) {
    if (jid === null ? only : !want(jid)) continue;
    if (jid && !J[jid]) continue;
    setWorldQuat(B[bn], jointQ(g, jid).multiply(off[bn]));
  }
  for (const [bn, cn, jid] of AIM) {
    if (!want(jid) || !J[jid]) continue;
    aim(B[bn], B[cn], DOWN.clone().applyQuaternion(jointQ(g, jid)));
    // the end bone's own rotation follows its clay joint again (the aim above turned it with the limb)
    const end = ORIENT.find(([b, j]) => b === cn && J[j]);
    if (end && want(end[1])) setWorldQuat(B[cn], jointQ(g, end[1]).multiply(off[cn]));
  }
  if (!only) {
    // the hips onto the clay's hips (the holder carries the whole body)
    const avatarHip = B.Bip01_L_Thigh.getWorldPosition(new THREE.Vector3()).add(B.Bip01_R_Thigh.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    const clayHip = J.l_hip.getWorldPosition(new THREE.Vector3()).add(J.r_hip.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    const h = skin.holder, par = h.parent;
    const wp = h.getWorldPosition(new THREE.Vector3()).add(clayHip.sub(avatarHip));
    if (par) { par.updateWorldMatrix(true, false); h.position.copy(par.worldToLocal(wp)); } else h.position.copy(wp);
    h.updateWorldMatrix(false, true);
  }
  return true;
}

/**
 * The logic rig follows the visible body (the clip owns the frame): every clay trunk joint takes the bone's world
 * rotation less the rest offset, every clay limb joint is aimed along the visible limb. skip: clay joint ids left as the
 * stage posed them (a layer's source). undo: an array the original local rotations are pushed onto ([obj, "quaternion",
 * value]); undoRig puts them back before the stage poses the clay again, so nothing leaks into the next frame.
 */
export function solveRigFromBody(skin, g, { skip = null, undo = [] } = {}) {
  const J = g.userData.joints, B = skin.bones, off = skin.kit._rtOff;
  if (!J || !off || !canRetarget(skin)) return false;
  skin.holder.updateWorldMatrix(true, true);
  const save = (o) => undo.push([o, "quaternion", o.quaternion.clone()]);
  for (const [bn, jid] of ORIENT) {
    if (!jid || !J[jid] || skip?.has(jid) || /_knee$/.test(jid)) continue;   // (a knee is aimed below, the foot follows it)
    save(J[jid]);
    setWorldQuat(J[jid], B[bn].getWorldQuaternion(new THREE.Quaternion()).multiply(off[bn].clone().invert()));
  }
  // limbs top-down (shoulder before elbow, hip before knee): the clay joint's -Y along the bone toward its child
  for (const [bn, cn, jid] of AIM) {
    const j = J[jid];
    if (!j || skip?.has(jid)) continue;
    save(j);
    const dir = B[cn].getWorldPosition(new THREE.Vector3()).sub(B[bn].getWorldPosition(new THREE.Vector3()));
    j.updateWorldMatrix(true, false);
    const cur = DOWN.clone().applyQuaternion(j.getWorldQuaternion(_q2));
    if (dir.lengthSq() < 1e-12) continue;
    _q.setFromUnitVectors(cur.normalize(), dir.normalize());
    setWorldQuat(j, _q.multiply(j.getWorldQuaternion(_q2)));
    // a wrist after its elbow: back to the hand's rotation
    const w = jid.replace(/_elbow$/, "_wrist");
    if (w !== jid && J[w] && !skip?.has(w)) {
      const hb = B[`Bip01_${jid[0].toUpperCase()}_Hand`];
      setWorldQuat(J[w], hb.getWorldQuaternion(new THREE.Quaternion()).multiply(off[hb.name].clone().invert()));
    }
  }
  return true;
}

/** Put back everything an undo list holds (newest first) and empty it. */
export function undoRig(undo) {
  if (!undo?.length) return;
  for (let i = undo.length - 1; i >= 0; i--) {
    const [o, prop, v, wrote] = undo[i];
    if (wrote && !o[prop].equals(wrote)) continue;   // set again since (the stage placed it afresh): leave the new value
    o[prop].copy(v); o.updateMatrix?.();
  }
  undo.length = 0;
}

/** Snapshot / blend of the bones the two motion sources both write, plus the holder (for the 6-frame handover). */
export function snapshot(skin) {
  const out = { hp: skin.holder.position.clone(), hq: skin.holder.quaternion.clone(), b: [] };
  const names = new Set([...ORIENT.map(([b]) => b), ...AIM.map(([b]) => b)]);
  for (const n of names) if (skin.bones[n]) out.b.push([skin.bones[n], skin.bones[n].quaternion.clone()]);
  if (skin.bones.Bip01) out.root = skin.bones.Bip01.position.clone();
  return out;
}
/** Write lerp(from, to, w) into the skin (both snapshots of this frame). The holder's PLACE stays from's (the clip's):
 *  only the pose blends, and the rig's place is taken on the frames it owns at full weight. (The logic rig's own place
 *  can be wrong on the frames it doesn't own: on top of a crate between two hops the clay's gait stands it at y = 0,
 *  inside the crate; blending toward that sank the body 0.75 m.) */
export function blendInto(skin, from, to, w) {
  skin.holder.position.copy(from.hp);
  skin.holder.quaternion.slerpQuaternions(from.hq, to.hq, w);
  from.b.forEach(([bone, q], i) => bone.quaternion.slerpQuaternions(q, to.b[i][1], w));
  if (from.root && to.root) skin.bones.Bip01.position.lerpVectors(from.root, to.root, w);
  skin.holder.updateMatrixWorld(true);
}
