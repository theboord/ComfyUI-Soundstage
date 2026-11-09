// Real walking mocap on the Rocketbox people (off by default: locomotion.OPTS.mocap). The Rocketbox walk is one
// 1.2 s stride, looped: every step identical, the hips with no sideways sway at all (its root's sideways track is flat),
// and played faster or slower for every speed (2.8 steps a second at 1.7 m/s). This module takes walking strides from
// motion capture (the 100STYLE dataset, BVH, CC BY 4.0: "The 100STYLE Dataset - Ian Mason") and puts them on the
// avatar's own Biped skeleton (Bip01), so the hips sway, the head sways and the arms swing as the performer's did, and
// a set of walks at several paces lets the cadence follow the speed from the data (gaitTable picks and blends them).
//
// NOTHING here downloads or ships motion data. tools/people/build_mocap_clips.mjs runs it offline on BVH files the
// user has on disk and writes the clips next to the Rocketbox kit (web/stage/people/rocketbox/mocap/, never committed);
// loadKit reads them only when locomotion.OPTS.mocap is on.
//
//   parseBVH      the BVH text -> joints (name, parent, offset, channels) and frames (numbers only; nothing runs)
//   bvhPose       world positions (metres) of every joint at a (fractional) frame
//   footStrikes   left and right foot strikes of a take (the foot low and still), and its strides
//   pickStrides   two straight walking strides in a row nearest a target speed, with the smallest loop seam
//   retarget      the BVH joints' directions onto the Bip01 bones (each bone turned so it points the way the
//                 performer's limb points, its twist from the knee / elbow hinge or the body's left), the hips' path
//                 scaled by leg length; returns a THREE.AnimationClip that loops (the seam spread over the loop)
//   attachPaces   adds built pace clips to a loaded kit (prepared like the Rocketbox clips; floors measured)
//   paceWeights   which pace clips play at a speed (the two nearest, blended), and the stride they make together
import * as THREE from "../../vendor/three.module.min.mjs";

/** The credit every use of 100STYLE-derived clips must carry (CC BY 4.0). */
export const CREDIT_100STYLE = "The 100STYLE Dataset - Ian Mason (CC BY 4.0)";

// ------------------------------------------------------------------------------------------------ BVH
/** Parse BVH text. Throws on anything that is not plain numbers where numbers belong. */
export function parseBVH(text) {
  const split = String(text).split(/\r?\nMOTION\s*\r?\n/);
  if (split.length !== 2) throw new Error("BVH: no MOTION section");
  const tok = split[0].split(/\s+/).filter(Boolean);
  const joints = [], stack = [];
  let i = 0, cur = null, chan = 0;
  while (i < tok.length) {
    const t = tok[i++];
    if (t === "ROOT" || t === "JOINT") { cur = { name: tok[i++], parent: stack.length ? stack[stack.length - 1] : -1, offset: [0, 0, 0], channels: [], c0: 0, end: null }; joints.push(cur); }
    else if (t === "End") { i++; cur = { endOf: joints.length - 1 }; }
    else if (t === "{") stack.push(cur && cur.endOf === undefined ? joints.length - 1 : -2);
    else if (t === "}") stack.pop();
    else if (t === "OFFSET") {
      const o = [Number(tok[i]), Number(tok[i + 1]), Number(tok[i + 2])]; i += 3;
      if (!o.every(Number.isFinite)) throw new Error("BVH: bad OFFSET");
      if (cur.endOf !== undefined) joints[cur.endOf].end = o; else cur.offset = o;
    } else if (t === "CHANNELS") {
      const n = Number(tok[i++]);
      if (!(n >= 0 && n <= 6)) throw new Error("BVH: bad CHANNELS");
      cur.channels = tok.slice(i, i + n); cur.c0 = chan; chan += n; i += n;
      if (!cur.channels.every((c) => /^[XYZ](position|rotation)$/.test(c))) throw new Error("BVH: unknown channel");
    }
  }
  if (joints.some((j) => j.parent === -2)) throw new Error("BVH: bad hierarchy");
  const lines = split[1].split(/\r?\n/);
  const nF = Number(/Frames:\s*(\d+)/.exec(lines[0])?.[1]), dt = Number(/Frame Time:\s*([\d.eE+-]+)/.exec(lines[1])?.[1]);
  if (!(nF > 0) || !(dt > 0)) throw new Error("BVH: bad frame header");
  const data = new Float64Array(nF * chan);
  for (let f = 0; f < nF; f++) {
    const row = (lines[2 + f] || "").trim().split(/\s+/);
    if (row.length !== chan) throw new Error(`BVH: frame ${f} has ${row.length} values, not ${chan}`);
    for (let k = 0; k < chan; k++) { const v = Number(row[k]); if (!Number.isFinite(v)) throw new Error("BVH: not a number"); data[f * chan + k] = v; }
  }
  return { joints, nF, dt, chan, data, index: Object.fromEntries(joints.map((j, k) => [j.name, k])) };
}

const AX = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
const _q = new THREE.Quaternion(), _tq = new THREE.Quaternion(), _s1 = new THREE.Vector3(1, 1, 1);
function jointLocal(b, j, f, p, q) {
  p.set(...j.offset); q.identity();
  const row = f * b.chan + j.c0;
  for (let k = 0; k < j.channels.length; k++) {
    const c = j.channels[k], v = b.data[row + k];
    if (c[1] === "p") p.setComponent("XYZ".indexOf(c[0]), v);
    else q.multiply(_tq.setFromAxisAngle(AX[c[0]], (v * Math.PI) / 180));
  }
}

/** World positions (metres, unit = metres per BVH unit) of every joint at fractional frame x; also each joint's world
 *  matrix (BVH units). out: {pos: {name: Vector3}, mat: Matrix4[]}. */
export function bvhPose(b, x, unit = 0.01) {
  const i = Math.max(0, Math.min(b.nF - 1, Math.floor(x))), i1 = Math.min(b.nF - 1, i + 1), u = Math.max(0, Math.min(1, x - i));
  const pos = {}, mat = [];
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  b.joints.forEach((j, k) => {
    jointLocal(b, j, i, pa, qa); jointLocal(b, j, i1, pb, qb);
    pa.lerp(pb, u); qa.slerp(qb, u);
    const m = new THREE.Matrix4().compose(pa, qa, _s1);
    if (j.parent >= 0) m.premultiply(mat[j.parent]);
    mat[k] = m;
    pos[j.name] = new THREE.Vector3().setFromMatrixPosition(m).multiplyScalar(unit);
  });
  return { pos, mat };
}

// ------------------------------------------------------------------------------------------------ strides
/** The 100STYLE joint names this module reads (its skeleton: Hips, Chest..Chest4, Neck, Head, the collars, arms, legs). */
export const SRC = {
  hips: "Hips", chest: ["Chest", "Chest2", "Chest3", "Chest4"], neck: "Neck", head: "Head",
  l: { hip: "LeftHip", knee: "LeftKnee", ankle: "LeftAnkle", toe: "LeftToe", collar: "LeftCollar", shoulder: "LeftShoulder", elbow: "LeftElbow", wrist: "LeftWrist" },
  r: { hip: "RightHip", knee: "RightKnee", ankle: "RightAnkle", toe: "RightToe", collar: "RightCollar", shoulder: "RightShoulder", elbow: "RightElbow", wrist: "RightWrist" },
};

/**
 * Foot strikes of a take, at `fps` (sampled from the BVH): a foot strikes on the first frame it is down (its ankle low
 * and slow, or its toe on the floor and slow) after being up. Returns {fps, n, hips: [Vector3], head, l: [frames],
 * r: [frames], down: {l, r} per-frame flags}.
 */
export function footStrikes(b, { fps = 30, unit = 0.01 } = {}) {
  const n = Math.floor(((b.nF - 1) * b.dt) * fps) + 1, P = [];
  for (let f = 0; f < n; f++) P.push(bvhPose(b, (f / fps) / b.dt, unit).pos);
  const W = (j) => P.map((p) => p[j]);
  const sp = (X, f) => X[Math.min(n - 1, f + 1)].distanceTo(X[Math.max(0, f - 1)]) * fps / 2;
  const toes = [...W(SRC.l.toe), ...W(SRC.r.toe)].map((p) => p.y);
  const floor = Math.min(...toes);
  const down = {}, strikes = {};
  for (const s of ["l", "r"]) {
    const A = W(SRC[s].ankle), T = W(SRC[s].toe);
    down[s] = A.map((p, f) => (p.y < floor + 0.13 && sp(A, f) < 0.45) || (T[f].y < floor + 0.04 && sp(T, f) < 0.45));
    strikes[s] = [];
    for (let f = 1; f < n; f++) if (down[s][f] && !down[s][f - 1] && (!strikes[s].length || f - strikes[s].at(-1) > 6)) strikes[s].push(f);
  }
  return { fps, n, P, floor, hips: W(SRC.hips), head: W(SRC.head), l: strikes.l, r: strikes.r, down };
}

const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
/**
 * Two walking strides in a row (left strike, right, left, right, left), each straight (the travel turns less than
 * `turn` degrees), with no frame where both feet are up (a walk, not a run) and the head not turned back over a
 * shoulder (more than 25 degrees off the hips: "Followed" checks behind now and then), nearest the target speed and
 * with the smallest pose difference between the first and the last frame (the loop's seam). null if none.
 * Returns {L0, R0, L1, R1, L2 (frames at fps), speed (m/s, the source performer), cadence (steps/s), turn (deg)}.
 */
export function pickStrides(st, target, { turn = 10 } = {}) {
  const { l, r, hips, head, down, fps } = st;
  const yaw = (a, c) => Math.atan2(hips[c].x - hips[a].x, hips[c].z - hips[a].z);
  const rightIn = (a, c) => r.find((x) => x > a && x < c);
  let best = null;
  for (let i = 0; i + 2 < l.length; i++) {
    const L0 = l[i], L1 = l[i + 1], L2 = l[i + 2];
    const R0 = rightIn(L0, L1), R1 = rightIn(L1, L2);
    if (R0 == null || R1 == null) continue;
    if ((L1 - L0) / fps > 1.6 || (L2 - L1) / fps > 1.6) continue;
    const t1 = Math.abs(wrap(yaw(L1, L2) - yaw(L0, L1))) * 57.3;
    const m0 = (L0 + L1) >> 1, m1 = (L1 + L2) >> 1;
    const t0 = Math.max(Math.abs(wrap(yaw(m0, L1) - yaw(L0, m0))), Math.abs(wrap(yaw(m1, L2) - yaw(L1, m1)))) * 57.3;
    if (t1 > turn || t0 > turn) continue;
    let flight = 0; for (let f = L0; f < L2; f++) if (!down.l[f] && !down.r[f]) flight++;
    if (flight > 1) continue;
    let look = 0;
    for (let f = L0; f <= L2; f++) {
      const H = st.P[f], hl = H[SRC.l.hip].clone().sub(H[SRC.r.hip]), hf = new THREE.Vector3(-hl.z, 0, hl.x);   // hips' forward (left x up)
      const n = H[SRC.head].clone().sub(H[SRC.neck]); n.y = 0;
      const sh = H[SRC.l.shoulder].clone().sub(H[SRC.r.shoulder]), sf = new THREE.Vector3(-sh.z, 0, sh.x);
      look = Math.max(look, Math.abs(wrap(Math.atan2(sf.x, sf.z) - Math.atan2(hf.x, hf.z))) * 57.3);
    }
    if (look > 25) continue;
    const dist = Math.hypot(hips[L2].x - hips[L0].x, hips[L2].z - hips[L0].z), T = (L2 - L0) / fps, speed = dist / T;
    // the seam: how far the legs' pose at the end is from the start (feet relative to the hips)
    const rel = (f, j) => st.P[f][j].clone().sub(hips[f]);
    let seam = 0; for (const j of [SRC.l.ankle, SRC.r.ankle, SRC.l.knee, SRC.r.knee, SRC.l.wrist, SRC.r.wrist]) seam += rel(L0, j).distanceTo(rel(L2, j));
    const score = Math.abs(speed - target) * 10 + seam * 5 + (t0 + t1) * 0.05;
    if (!best || score < best.score) best = { L0, R0, L1, R1, L2, speed, cadence: 4 / T, turn: t0 + t1, seam, look, score };
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ retarget
/** Bip01 bone -> [source joint the bone starts at, joint it points to, the hinge it twists by]. */
const MAP = [
  ["Bip01_Spine", "Chest", "Chest2", "hips"],
  ["Bip01_Spine1", "Chest2", "Chest4", "torso"],
  ["Bip01_Spine2", "Chest4", "Neck", "chest"],
  ["Bip01_Neck", "Neck", "Head", "chest"],
  ["Bip01_L_Clavicle", "LeftCollar", "LeftShoulder", "chest"],
  ["Bip01_R_Clavicle", "RightCollar", "RightShoulder", "chest"],
  ["Bip01_L_UpperArm", "LeftShoulder", "LeftElbow", "l_arm"],
  ["Bip01_L_Forearm", "LeftElbow", "LeftWrist", "l_arm"],
  ["Bip01_R_UpperArm", "RightShoulder", "RightElbow", "r_arm"],
  ["Bip01_R_Forearm", "RightElbow", "RightWrist", "r_arm"],
  ["Bip01_L_Thigh", "LeftHip", "LeftKnee", "l_leg"],
  ["Bip01_L_Calf", "LeftKnee", "LeftAnkle", "l_leg"],
  ["Bip01_L_Foot", "LeftAnkle", "LeftToe", "l_leg"],
  ["Bip01_R_Thigh", "RightHip", "RightKnee", "r_leg"],
  ["Bip01_R_Calf", "RightKnee", "RightAnkle", "r_leg"],
  ["Bip01_R_Foot", "RightAnkle", "RightToe", "r_leg"],
];
/** The Bip01 bone each mapped bone points to (its child along the limb). */
const TGT_CHILD = {
  Bip01_Spine: "Bip01_Spine1", Bip01_Spine1: "Bip01_Spine2", Bip01_Spine2: "Bip01_Neck", Bip01_Neck: "Bip01_Head",
  Bip01_L_Clavicle: "Bip01_L_UpperArm", Bip01_R_Clavicle: "Bip01_R_UpperArm", Bip01_L_UpperArm: "Bip01_L_Forearm", Bip01_L_Forearm: "Bip01_L_Hand",
  Bip01_R_UpperArm: "Bip01_R_Forearm", Bip01_R_Forearm: "Bip01_R_Hand", Bip01_L_Thigh: "Bip01_L_Calf", Bip01_L_Calf: "Bip01_L_Foot", Bip01_L_Foot: "Bip01_L_Toe0",
  Bip01_R_Thigh: "Bip01_R_Calf", Bip01_R_Calf: "Bip01_R_Foot", Bip01_R_Foot: "Bip01_R_Toe0",
};

/** Rotation taking the frame (p0, s0) onto (p1, s1): p exactly, s as near as it can (both orthogonalised to p). */
function alignFrames(p0, s0, p1, s1) {
  const basis = (p, s) => {
    const x = p.clone().normalize(), z = new THREE.Vector3().crossVectors(x, s).normalize(), y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const A = basis(p0, s0), B = basis(p1, s1);
  return new THREE.Quaternion().setFromRotationMatrix(B.multiply(A.transpose()));
}

/**
 * The twist reference of each hinge from a set of points (source or target, same names): the body's left across the
 * hips and across the shoulders, and for a leg or an arm the axis it bends about (thigh x calf, upper arm x forearm),
 * eased toward the body's left (legs) or (upper arm x the chest's forward) (arms) where the limb is nearly straight
 * and that axis means nothing. pts: {hipL, hipR, shL, shR, up, l_leg: [hip, knee, ankle], r_leg, l_arm: [sh, el, wr], r_arm}.
 */
function hinges(pts) {
  const hipLeft = pts.hipL.clone().sub(pts.hipR).normalize();
  const chestLeft = pts.shL.clone().sub(pts.shR).normalize();
  const fwd = new THREE.Vector3().crossVectors(chestLeft, pts.up).normalize();
  const limb = ([a, b, c], fallback) => {
    const u = b.clone().sub(a).normalize(), v = c.clone().sub(b).normalize();
    const ax = new THREE.Vector3().crossVectors(u, v), s = ax.length();
    const fb = fallback(u);
    if (ax.dot(fb) < 0) ax.negate();
    const w = Math.min(1, Math.max(0, (s - 0.1) / 0.25));   // bent more than ~6-20 degrees: the real hinge
    return ax.normalize().multiplyScalar(w).add(fb.multiplyScalar(1 - w)).normalize();
  };
  return {
    hips: hipLeft, chest: chestLeft, torso: hipLeft.clone().add(chestLeft).normalize(),
    l_leg: limb(pts.l_leg, () => hipLeft.clone()), r_leg: limb(pts.r_leg, () => hipLeft.clone()),
    l_arm: limb(pts.l_arm, (u) => new THREE.Vector3().crossVectors(u, fwd).normalize()), r_arm: limb(pts.r_arm, (u) => new THREE.Vector3().crossVectors(u, fwd).normalize()),
  };
}
const ptsOf = (P, L, up) => ({
  hipL: P(L.l.hip), hipR: P(L.r.hip), shL: P(L.l.sh), shR: P(L.r.sh), up,
  l_leg: [P(L.l.hip), P(L.l.knee), P(L.l.ankle)], r_leg: [P(L.r.hip), P(L.r.knee), P(L.r.ankle)],
  l_arm: [P(L.l.sh), P(L.l.el), P(L.l.wr)], r_arm: [P(L.r.sh), P(L.r.el), P(L.r.wr)],
});
const SRC_L = { l: { hip: "LeftHip", knee: "LeftKnee", ankle: "LeftAnkle", sh: "LeftShoulder", el: "LeftElbow", wr: "LeftWrist" }, r: { hip: "RightHip", knee: "RightKnee", ankle: "RightAnkle", sh: "RightShoulder", el: "RightElbow", wr: "RightWrist" } };
const TGT_L = { l: { hip: "Bip01_L_Thigh", knee: "Bip01_L_Calf", ankle: "Bip01_L_Foot", sh: "Bip01_L_UpperArm", el: "Bip01_L_Forearm", wr: "Bip01_L_Hand" }, r: { hip: "Bip01_R_Thigh", knee: "Bip01_R_Calf", ankle: "Bip01_R_Foot", sh: "Bip01_R_UpperArm", el: "Bip01_R_Forearm", wr: "Bip01_R_Hand" } };

/**
 * A retargeter from one BVH skeleton onto one avatar template's Bip01 skeleton (the template in its bind pose).
 * Returns pose(sourcePositions, {turn, origin}) -> {local: {bone: Quaternion}, root: Vector3 (Bip01's local position)}:
 * every mapped bone turned so it points the way the performer's segment points (its twist from the knee / elbow
 * hinge or the body's left), the bones the mocap does not drive at rest[bone] (else the bind), the root placed so
 * the hip centre is where the performer's is, scaled by leg length (k: avatar units per source metre). turn / origin:
 * the source's points are taken relative to origin, then turned (so a take's travel can be laid along the avatar's
 * forward, +Z). floor: the source's floor height (metres); the clip stands on y = 0.
 */
export function makeRetargeter(template, b, { unit = 0.01, rest = {}, floor = 0 } = {}) {
  template.updateMatrixWorld(true);
  const bones = {}, order = [];
  template.traverse((o) => { if (o.isBone) { bones[o.name] = o; order.push(o.name); } });
  const bindW = {}, bindP = {};
  for (const [n, o] of Object.entries(bones)) { bindW[n] = o.getWorldQuaternion(new THREE.Quaternion()); bindP[n] = o.getWorldPosition(new THREE.Vector3()); }
  const BP = (n) => bindP[n].clone();
  const tUp = BP("Bip01_Neck").sub(BP("Bip01_Pelvis")).normalize();
  const tH = hinges(ptsOf(BP, TGT_L, tUp));
  const legT = BP("Bip01_L_Thigh").distanceTo(BP("Bip01_L_Calf")) + BP("Bip01_L_Calf").distanceTo(BP("Bip01_L_Foot"));
  const off = (n) => new THREE.Vector3(...b.joints[b.index[n]].offset).length() * unit;
  const k = legT / (off("LeftKnee") + off("LeftAnkle"));
  const mapBy = Object.fromEntries(MAP.map((m) => [m[0], m]));
  const bindMid = BP("Bip01_L_Thigh").add(BP("Bip01_R_Thigh")).multiplyScalar(0.5), rootOff = BP("Bip01").sub(bindMid);
  const rootBindInv = bindW.Bip01.clone().invert();
  const rootParentW = bones.Bip01.parent.getWorldQuaternion(new THREE.Quaternion());
  const rootParentInv = bones.Bip01.parent.matrixWorld.clone().invert();
  const pose = (src, { turn = new THREE.Quaternion(), origin = new THREE.Vector3() } = {}) => {
    const P = (n) => src[n].clone().sub(origin).applyQuaternion(turn);
    const sUp = P("Neck").sub(P("Hips")).normalize();
    const sH = hinges(ptsOf(P, SRC_L, sUp));
    const world = {}, local = {};
    for (const n of order) {
      const o = bones[n], parent = o.parent?.isBone ? o.parent.name : null;
      const pw = parent ? world[parent] : rootParentW;
      let wq;
      if (n === "Bip01") wq = alignFrames(BP("Bip01_L_Thigh").sub(BP("Bip01_R_Thigh")), tUp, P("LeftHip").sub(P("RightHip")), sUp).multiply(bindW[n].clone());
      else if (mapBy[n]) { const [, a, c, h] = mapBy[n]; wq = alignFrames(BP(TGT_CHILD[n]).sub(BP(n)), tH[h], P(c).sub(P(a)), sH[h]).multiply(bindW[n].clone()); }
      else wq = pw.clone().multiply(rest[n] || o.quaternion);
      world[n] = wq;
      local[n] = pw.clone().invert().multiply(wq);
    }
    const mid = P("LeftHip").add(P("RightHip")).multiplyScalar(0.5).multiplyScalar(k);
    mid.y -= floor * k;
    const root = mid.add(rootOff.clone().applyQuaternion(world.Bip01.clone().multiply(rootBindInv))).applyMatrix4(rootParentInv);
    return { local, root };
  };
  return { pose, k, order, bones, mapped: new Set(["Bip01", ...MAP.map((m) => m[0])]) };
}

/**
 * Retarget two strides of a BVH take (pickStrides) onto the avatar template as a loop: left strike to left strike,
 * time-warped so each foot strike falls on a quarter of the loop (every pace's clip lines up, so blended walks stay in
 * step), 30 keys a second, the loop's seam spread over it (every rotation and the root's height end where they start).
 * Returns {clip (THREE.AnimationClip), travel (avatar units per loop), strides: 2, speedSrc, cadence, k}.
 */
export function retarget(template, b, pick, { fps = 30, rest = {}, unit = 0.01, name = "mocap_walk" } = {}) {
  const st = pick.st;
  const R = makeRetargeter(template, b, { unit, rest, floor: st.floor });
  const h0 = st.hips[pick.L0], h2 = st.hips[pick.L2];
  const turn = new THREE.Quaternion().setFromAxisAngle(AX.Y, -Math.atan2(h2.x - h0.x, h2.z - h0.z));
  const origin = new THREE.Vector3(h0.x, 0, h0.z);
  const knots = [pick.L0, pick.R0, pick.L1, pick.R1, pick.L2];
  const T = (pick.L2 - pick.L0) / st.fps, N = Math.max(8, Math.round(T * fps));
  const srcAt = (u) => { const x = Math.min(3.9999, Math.max(0, u * 4)), i = Math.floor(x); return knots[i] + (knots[i + 1] - knots[i]) * (x - i); };
  const Q = {}, pos = [];
  for (const n of R.order) Q[n] = [];
  for (let f = 0; f <= N; f++) {
    const { local, root } = R.pose(bvhPose(b, (srcAt(f / N) / st.fps) / b.dt, unit).pos, { turn, origin });
    for (const n of R.order) Q[n].push(local[n]);
    pos.push(root);
  }
  const times = Array.from({ length: N + 1 }, (_, f) => f / fps), out = [];
  for (const n of R.order) {
    if (!R.mapped.has(n) && !rest[n]) continue;
    const q = Q[n];
    for (let f = 1; f <= N; f++) if (q[f].dot(q[f - 1]) < 0) q[f].set(-q[f].x, -q[f].y, -q[f].z, -q[f].w);
    const fix = q[0].clone().multiply(q[N].clone().invert());
    if (fix.w < 0) fix.set(-fix.x, -fix.y, -fix.z, -fix.w);
    const id = new THREE.Quaternion(), vals = [];
    for (let f = 0; f <= N; f++) vals.push(...id.clone().slerp(fix, f / N).multiply(q[f]).normalize().toArray());
    out.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, vals));
  }
  const pv = []; pos.forEach((p, f) => pv.push(p.x, p.y - (pos[N].y - pos[0].y) * (f / N), p.z));
  out.push(new THREE.VectorKeyframeTrack("Bip01.position", times, pv));
  return { clip: new THREE.AnimationClip(name, N / fps, out), travel: Math.hypot(pos[N].x - pos[0].x, pos[N].z - pos[0].z), strides: 2, speedSrc: pick.speed, cadence: pick.cadence, k: R.k };
}

// ------------------------------------------------------------------------------------------------ in the App
/**
 * The pace clips' weights (summing to 1) at speed v (m/s) and the stride (m, one stride = two steps) they make
 * together. paces: [{key, speed (m/s at this avatar's size), stride (m)}] sorted by speed. Between two paces the
 * weights go linearly by speed (so the stride, and the cadence = v / stride, move smoothly between the two clips'
 * own); below the slowest or above the fastest the nearest plays alone (played slower or faster).
 */
export function paceWeights(v, paces) {
  const w = {};
  if (!paces?.length) return { w, stride: 0 };
  for (const p of paces) w[p.key] = 0;
  if (v <= paces[0].speed || paces.length === 1) { w[paces[0].key] = 1; return { w, stride: paces[0].stride }; }
  const last = paces[paces.length - 1];
  if (v >= last.speed) { w[last.key] = 1; return { w, stride: last.stride }; }
  let i = 0; while (i + 1 < paces.length && paces[i + 1].speed < v) i++;
  const a = paces[i], c = paces[i + 1], u = (v - a.speed) / (c.speed - a.speed);
  w[a.key] = 1 - u; w[c.key] = u;
  return { w, stride: a.stride * (1 - u) + c.stride * u };
}
