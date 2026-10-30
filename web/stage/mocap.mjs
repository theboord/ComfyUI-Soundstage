// Mocap to Stage: a performance captured from video (SAM 3D Body in ComfyUI -> Soundstage · Mocap to Stage) drives a
// clay actor. The take holds 18 OpenPose body points and 21 points per hand per frame (Y-up metres, the person facing
// +Z when they face the camera) plus the root path. retarget() turns every frame into joint rotations for the clay rig
// once; apply() plays it at a stage frame: facing, chest, head, arms, wrists, fingers, legs, the path through the shot,
// and the hips' height, so a crouch keeps the feet planted and a jump leaves the ground.
import * as THREE from "../vendor/three.module.min.mjs";
import { applyJoints } from "./humans.mjs";

const B = { nose: 0, neck: 1, r_shoulder: 2, r_elbow: 3, r_wrist: 4, l_shoulder: 5, l_elbow: 6, l_wrist: 7,
  r_hip: 8, r_knee: 9, r_ankle: 10, l_hip: 11, l_knee: 12, l_ankle: 13, r_eye: 14, l_eye: 15, r_ear: 16, l_ear: 17 };
const FINGERS = [["thumb", [1, 2, 3, 4]], ["index", [5, 6, 7, 8]], ["middle", [9, 10, 11, 12]], ["ring", [13, 14, 15, 16]], ["pinky", [17, 18, 19, 20]]];
const BODY_JOINTS = ["spine", "neck", "head", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee"];

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const UP = new THREE.Vector3(0, 1, 0);
const D = 180 / Math.PI;

// Loaded takes, by file (the scene JSON keeps only the file name; the data is fetched once and retargeted once).
const cache = new Map();

/** The take for a file, or undefined while it loads (call load() first). Inline data (the App demo) works too. */
export function takeFor(mocap) {
  if (!mocap) return undefined;
  if (mocap.data) {
    if (!mocap._take) Object.defineProperty(mocap, "_take", { value: retarget(mocap.data), enumerable: false });
    return mocap._take;
  }
  const c = cache.get(mocap.file);
  return c && !(c instanceof Promise) ? c : undefined;
}

/** Fetch and retarget a take from ComfyUI's output folder (soundstage/mocap/<name>.json). */
export function load(file, { fetchApi = (p) => fetch(p) } = {}) {
  const have = cache.get(file);
  if (have) return have instanceof Promise ? have : Promise.resolve(have);
  const i = file.lastIndexOf("/");
  const p = fetchApi(`/view?filename=${encodeURIComponent(file.slice(i + 1))}&subfolder=${encodeURIComponent(file.slice(0, i))}&type=output`)
    .then((r) => { if (!r.ok) throw new Error(`mocap take not found: ${file}`); return r.json(); })
    .then((d) => { const t = retarget(d); cache.set(file, t); return t; })
    .catch((e) => { cache.delete(file); throw e; });
  cache.set(file, p);
  return p;
}

/** Register already-fetched take data under its file name (after a capture finishes). */
export function remember(file, data) {
  const t = retarget(data);
  cache.set(file, t);
  return t;
}

// ------------------------------------------------------------------ retarget
function basis(x, y, z) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Orthonormal frame from an approximate X (left) and Y (up). */
function frameXY(xRaw, yRaw) {
  const x = xRaw.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, yRaw).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return basis(x, y, z);
}

/** Orthonormal frame from an approximate X (left) and Z (forward). */
function frameXZ(xRaw, zRaw) {
  const x = xRaw.clone().normalize();
  const y = new THREE.Vector3().crossVectors(zRaw, x).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return basis(x, y, z);
}

/**
 * A bone that hangs along its local -Y in the rest pose, with a hinge (elbow / knee) about its local X.
 * yDir points from the far joint back to the near one; bend is the next bone's direction. sign = +1 when the hinge
 * folds the next bone toward local +Z (elbow: forearm forward), -1 toward -Z (knee: shin back). fallbackZ keeps a
 * straight limb from spinning (the parent's forward).
 */
function hingeFrame(yDir, bend, sign, fallbackZ, prevZ) {
  const y = yDir.clone().normalize();
  const perp = bend.clone().addScaledVector(y, -bend.dot(y));
  const len = bend.length() || 1;
  let z;
  const w = Math.min(1, Math.max(0, (perp.length() / len - 0.06) / 0.2));   // how bent: 0 straight .. 1 clearly bent
  const fb = (prevZ || fallbackZ).clone().addScaledVector(y, -(prevZ || fallbackZ).dot(y));
  if (fb.lengthSq() < 1e-8) fb.set(0, 0, 1).addScaledVector(y, -y.z);
  fb.normalize();
  if (w > 0) {
    z = perp.normalize().multiplyScalar(sign);
    z.multiplyScalar(w).addScaledVector(fb, 1 - w).normalize();
  } else z = fb;
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z = new THREE.Vector3().crossVectors(x, y).normalize();
  return { q: basis(x, y, z), z };
}

const angle = (a, b) => (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10 ? 0 : a.angleTo(b));

/** Fit the ground under the feet: camera pitch (a camera tilted down makes the floor climb with distance). */
function groundPitch(feet) {
  // feet: [[z, y], ...] lowest ankle per frame (camera space). Needs depth travel to see a slope.
  if (feet.length < 8) return 0;
  const zs = feet.map((f) => f[0]);
  if (Math.max(...zs) - Math.min(...zs) < 1.0) return 0;
  const n = feet.length, mz = zs.reduce((s, v) => s + v, 0) / n, my = feet.reduce((s, f) => s + f[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [z, y] of feet) { sxy += (z - mz) * (y - my); sxx += (z - mz) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  return Math.max(-0.35, Math.min(0.35, Math.atan(slope)));
}

/**
 * Turn take data into per-frame joint rotations. Rig conventions (humans.mjs): every bone hangs along -Y, the figure
 * faces +Z with +X its left, elbows fold the forearm forward (-X rotation), knees fold the shin back (+X rotation).
 */
export function retarget(data) {
  const N = data.frames | 0;
  if (!N || !data.body?.length) throw new Error("mocap take has no frames");
  const body = data.body, hands = data.hands || [], root = data.root || [];
  // World points (body points + the camera-space root), then level the camera.
  const worldPts = (i) => body[i].map((p) => [p[0] + (root[i]?.[0] || 0), p[1] + (root[i]?.[1] || 0), p[2] + (root[i]?.[2] || 0)]);
  const feet = [];
  for (let i = 0; i < N; i++) {
    const w = worldPts(i), l = w[B.l_ankle], r = w[B.r_ankle];
    feet.push(l[1] < r[1] ? [l[2], l[1]] : [r[2], r[1]]);
  }
  const pitch = groundPitch(feet);
  const level = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
  const P = (a) => V(a).applyQuaternion(level);

  const frames = [];
  let prev = {};
  const legLens = [], heads = [];
  for (let i = 0; i < N; i++) {
    const kp = body[i].map(P), rt = P(root[i] || [0, 0, 0]);
    const k = (n) => kp[B[n]];
    const midHip = k("l_hip").clone().add(k("r_hip")).multiplyScalar(0.5);
    const midSh = k("l_shoulder").clone().add(k("r_shoulder")).multiplyScalar(0.5);
    legLens.push(k("l_hip").distanceTo(k("l_knee")) + k("l_knee").distanceTo(k("l_ankle")),
      k("r_hip").distanceTo(k("r_knee")) + k("r_knee").distanceTo(k("r_ankle")));
    // Root: facing from the hips (their left-to-right line, flattened), the chest's own facing breaks ties.
    const hipX = k("l_hip").clone().sub(k("r_hip"));
    const shX = k("l_shoulder").clone().sub(k("r_shoulder"));
    const flat = hipX.clone().multiplyScalar(2).add(shX); flat.y = 0;
    const fwd = new THREE.Vector3().crossVectors(flat, UP).normalize();
    const yaw = Math.atan2(fwd.x, fwd.z);
    const qRoot = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const qRootInv = qRoot.clone().invert();
    // Chest: shoulders give left, hips-to-neck gives up.
    const qChest = frameXY(shX, k("neck").clone().sub(midHip));
    const qChestInv = qChest.clone().invert();
    // Head: ears give left (eyes when an ear is hidden), nose gives forward.
    const earX = k("l_ear").clone().sub(k("r_ear"));
    const eyeX = k("l_eye").clone().sub(k("r_eye"));
    const hx = earX.length() > 0.05 ? earX : eyeX;
    const earMid = k("l_ear").clone().add(k("r_ear")).multiplyScalar(0.5);
    const qHead = frameXZ(hx, k("nose").clone().sub(earMid));
    const rel = qChestInv.clone().multiply(qHead);
    const qNeck = new THREE.Quaternion().slerp(rel, 0.35);
    const qHeadL = qNeck.clone().invert().multiply(rel);
    const out = { yaw, hip: midHip.clone().add(rt), feet: Math.min(k("l_ankle").y, k("r_ankle").y) + rt.y, q: {}, fingers: {} };
    out.q.spine = qRootInv.clone().multiply(qChest);
    out.q.neck = qNeck;
    out.q.head = qHeadL;
    heads.push(k("nose").y - Math.min(k("l_ankle").y, k("r_ankle").y));
    const chestZ = new THREE.Vector3(0, 0, 1).applyQuaternion(qChest);
    const rootZ = new THREE.Vector3(0, 0, 1).applyQuaternion(qRoot);
    for (const lr of ["l", "r"]) {
      // Arm: upper arm frame from the shoulder-elbow line and the forearm (elbow hinge folds it forward).
      const sh = k(`${lr}_shoulder`), el = k(`${lr}_elbow`), wr = k(`${lr}_wrist`);
      const fore = wr.clone().sub(el);
      const ua = hingeFrame(sh.clone().sub(el), fore, 1, chestZ, prev[`${lr}_uaZ`]);
      out[`${lr}_uaZ`] = ua.z;
      out.q[`${lr}_shoulder`] = qChestInv.clone().multiply(ua.q);
      const bendA = angle(el.clone().sub(sh), fore);
      out.q[`${lr}_elbow`] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -bendA);
      const qFore = ua.q.clone().multiply(out.q[`${lr}_elbow`]);
      // Hand: wrist-to-middle-knuckle is the hand's -Y, pinky-to-index knuckles its +Z (palms face the body).
      const h = hands[i];
      const off = lr === "r" ? 0 : 21;
      const hp = h && h.length >= 42 ? h.slice(off, off + 21).map(P) : null;
      const handOk = hp && hp[0].distanceTo(hp[9]) > 0.02 && hp[0].distanceTo(wr) < 0.15;
      if (handOk) {
        const yH = hp[0].clone().sub(hp[9]);
        const zRaw = hp[5].clone().sub(hp[17]);
        const xH = new THREE.Vector3().crossVectors(yH, zRaw);
        const qHand = frameXY(xH, yH);
        out.q[`${lr}_wrist`] = qFore.clone().invert().multiply(qHand);
        // Fingers: the bend at each knuckle, from consecutive bone directions.
        for (const [name, idx] of FINGERS) {
          const pts = [hp[0], ...idx.map((j) => hp[j])];
          for (let s = 1; s <= 3; s++) {
            const a = pts[s].clone().sub(pts[s - 1]), b = pts[s + 1].clone().sub(pts[s]);
            let c = angle(a, b) * D;
            // A relaxed open hand already fans out from the wrist (the knuckle bones are not in line with the palm),
            // so subtract that rest angle at the first joint.
            if (name === "thumb") c = s === 1 ? Math.max(0, c - 25) * 0.5 : c * 0.8;
            else if (s === 1) c = Math.max(0, c - 10);
            out.fingers[`${lr}_${name}_${s}`] = [Math.max(0, Math.min(100, c)), 0];
          }
        }
      } else {
        out.q[`${lr}_wrist`] = new THREE.Quaternion();
      }
      // Leg: thigh frame from the hip-knee line and the shin (the knee folds the shin back).
      const hi = k(`${lr}_hip`), kn = k(`${lr}_knee`), an = k(`${lr}_ankle`);
      const shin = an.clone().sub(kn);
      const th = hingeFrame(hi.clone().sub(kn), shin, -1, rootZ, prev[`${lr}_thZ`]);
      out[`${lr}_thZ`] = th.z;
      out.q[`${lr}_hip`] = qRootInv.clone().multiply(th.q);
      const bendL = angle(kn.clone().sub(hi), shin);
      out.q[`${lr}_knee`] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), bendL);
    }
    frames.push(out);
    prev = out;
  }
  // Unwrap the facing so a full turn plays as a turn, not a snap back.
  for (let i = 1; i < N; i++) {
    let d = frames[i].yaw - frames[i - 1].yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    frames[i].yaw = frames[i - 1].yaw + d;
  }
  // Smooth the path a little (monocular depth jitters); the joints come pre-smoothed from SAM 3D Body.
  const W = 2;
  const hipS = frames.map((_, i) => {
    const v = new THREE.Vector3(); let n = 0;
    for (let j = Math.max(0, i - W); j <= Math.min(N - 1, i + W); j++) { v.add(frames[j].hip); n++; }
    return v.multiplyScalar(1 / n);
  });
  frames.forEach((f, i) => { f.hip = hipS[i]; });
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };
  const feetSorted = frames.map((f) => f.feet).sort((a, b) => a - b);
  const ground = feetSorted[Math.floor(feetSorted.length * 0.1)] ?? 0;
  return { frames, fps: data.fps || 24, n: N, leg: med(legLens) || 0.8, stature: med(heads) + 0.1, ground, pitch };
}

// ------------------------------------------------------------------ playback
const slerpQ = (a, b, t) => a.clone().slerp(b, t);

/** The take's frame (fractional) for a stage frame. */
export function takeFrame(take, mocap, frame, fps = 24) {
  const u = (frame - (mocap.start || 0)) * (take.fps / fps) * (mocap.speed || 1);
  return mocap.loop ? ((u % take.n) + take.n) % take.n : Math.max(0, Math.min(take.n - 1, u));
}

/** Is the take playing (between its first and last frame) at this stage frame? */
export function playing(take, mocap, frame, fps = 24) {
  const u = (frame - (mocap.start || 0)) * (take.fps / fps) * (mocap.speed || 1);
  return mocap.loop || (u >= 0 && u <= take.n - 1);
}

/**
 * Pose figure g from the take at a stage frame. base: {x, y, z, yaw} where the take starts (the actor's spot and
 * facing). heightM: the figure's height. Returns the travel applied (for the selection ring etc.).
 */
export function apply(g, take, mocap, frame, base, heightM = 1.8, fps = 24) {
  const J = g?.userData?.joints;
  if (!J) return;
  const u = takeFrame(take, mocap, frame, fps);
  const i0 = Math.floor(u), i1 = Math.min(take.n - 1, i0 + 1), t = u - i0;
  const f0 = take.frames[i0], f1 = take.frames[i1];
  for (const id of BODY_JOINTS) {
    const j = J[id];
    if (!j) continue;
    j.quaternion.copy(slerpQ(f0.q[id], f1.q[id], t));
  }
  const fingers = {};
  for (const [id, v] of Object.entries(f0.fingers)) {
    const w = f1.fingers[id] || v;
    fingers[id] = [v[0] + (w[0] - v[0]) * t, 0];
  }
  applyJoints(g, fingers);
  // Path and facing, relative to the take's first frame, turned to the actor's own facing.
  const first = take.frames[0];
  const k = (heightM / 1.8) * (1.8 * 0.47) / Math.max(0.3, take.leg);      // the figure's legs over the performer's
  const yaw = f0.yaw + (f1.yaw - f0.yaw) * t;
  const turn = (base.yaw || 0) - first.yaw;
  const hip = f0.hip.clone().lerp(f1.hip, t);
  let travel = mocap.travel === false ? new THREE.Vector3() : hip.sub(first.hip).setY(0).multiplyScalar(k).applyAxisAngle(UP, turn);
  g.rotation.order = "YXZ";
  g.rotation.x = 0;
  g.rotation.z = 0;
  g.rotation.y = turn + yaw;
  g.position.set(base.x + travel.x, base.y, base.z + travel.z);
  // A take placed by Video -> Stage: where the performer stood in the rebuilt set, frame by frame (feet on its floor,
  // facing through the tracked camera), so the clay lines up with the source shot.
  const W = mocap.world;
  if (W?.path?.length === take.n && W.yaw?.length === take.n) {
    const p0 = W.path[i0], p1 = W.path[i1];
    g.position.set(p0[0] + (p1[0] - p0[0]) * t, base.y, p0[1] + (p1[1] - p0[1]) * t);
    g.rotation.y = (W.yaw[i0] + (W.yaw[i1] - W.yaw[i0]) * t) * Math.PI / 180;
    travel = new THREE.Vector3(g.position.x - base.x, 0, g.position.z - base.z);
  }
  // Feet: put the lowest sole on the ground, plus however high the performer's feet are off it (a jump).
  const feetLift = Math.max(0, (f0.feet + (f1.feet - f0.feet) * t) - take.ground) * k;
  g.updateMatrixWorld(true);
  let low = Infinity;
  for (const lr of ["l", "r"]) {
    const hip = J[`${lr}_hip`], knee = J[`${lr}_knee`];
    if (!hip || !knee) continue;
    const sole = new THREE.Vector3(0, -hip.position.y - knee.position.y, 0);
    low = Math.min(low, knee.localToWorld(sole).y);
  }
  if (Number.isFinite(low)) g.position.y += base.y + feetLift - low;
  g.updateMatrixWorld(true);
  return travel;
}
