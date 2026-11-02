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
export function hingeFrame(yDir, bend, sign, fallbackZ, prevZ) {
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
    const out = { yaw, hip: midHip.clone().add(rt), feet: Math.min(k("l_ankle").y, k("r_ankle").y) + rt.y, q: {}, fingers: {},
      ankles: { l: k("l_ankle").clone().add(rt).toArray(), r: k("r_ankle").clone().add(rt).toArray() } };
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
  const leg = med(legLens) || 0.8, fps = data.fps || 24;
  // Foot contacts (mocap cleanup): which foot is planted on each frame, the ground line under them, and how high the
  // feet are off it (only a jump lifts the figure; drift in the monocular depth no longer floats it).
  const ankles = frames.map((f) => f.ankles);
  const contact = detectContacts(ankles, { fps, leg });
  const gl = groundLine(ankles, contact, { fps });
  frames.forEach((f, i) => { f.lift = Math.max(0, Math.min(f.ankles.l[1], f.ankles.r[1]) - gl[i]); });
  const plant = { l: contactWeights(contact.l), r: contactWeights(contact.r), anchor: { l: anchorFrames(contact.l), r: anchorFrames(contact.r) } };
  return { frames, fps, n: N, leg, stature: med(heads) + 0.1, ground, pitch, contact, plant };
}

// ------------------------------------------------------------------ foot contacts
const pctl = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))] ?? 0; };

/** Keep runs of true at least minLen long, and close gaps of false up to maxGap between two runs. */
export function cleanRuns(flags, minLen = 3, maxGap = 2) {
  const f = flags.map(Boolean), n = f.length;
  // close short gaps first (a heel jitter in the middle of a plant), then drop blips
  for (let i = 0; i < n;) {
    if (f[i]) { i++; continue; }
    let j = i; while (j < n && !f[j]) j++;
    if (i > 0 && j < n && j - i <= maxGap) for (let q = i; q < j; q++) f[q] = true;
    i = j;
  }
  for (let i = 0; i < n;) {
    if (!f[i]) { i++; continue; }
    let j = i; while (j < n && f[j]) j++;
    if (j - i < minLen) for (let q = i; q < j; q++) f[q] = false;
    i = j;
  }
  return f;
}

/**
 * Which foot is on the ground, frame by frame, as pro mocap cleanup finds it: the ankle is slow AND low (near the
 * local ground: a low percentile of the lower ankle over about a second, so slow drift in the capture's depth and a
 * whole-take height bias don't matter, while a jump's apex, slow but high, is not a contact). Hysteresis on both
 * thresholds, short blips dropped, short gaps closed. ankles: [{l:[x,y,z], r:[x,y,z]}] in metres, Y up.
 * Returns {l: bool[], r: bool[], ref: number[]} (ref = the local ground per frame).
 */
export function detectContacts(ankles, { fps = 24, leg = 0.85, height = 0.07, speed = 0.8, window = 1 } = {}) {
  const n = ankles.length, sc = Math.max(0.5, Math.min(1.5, leg / 0.85));
  const hIn = height * sc, hOut = hIn * 1.6, vIn = speed * sc, vOut = vIn * 1.5;
  const low = ankles.map((a) => Math.min(a.l[1], a.r[1]));
  const W = Math.max(4, Math.round(fps * window));
  const ref = low.map((_, i) => pctl(low.slice(Math.max(0, i - W), Math.min(n, i + W + 1)), 0.2));
  const out = { ref }, P = {}, vel = {};
  for (const lr of ["l", "r"]) {
    // light smoothing (the capture's joints shiver a little) before differentiating
    P[lr] = ankles.map((_, i) => {
      const v = [0, 0, 0]; let c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { const p = ankles[j][lr]; v[0] += p[0]; v[1] += p[1]; v[2] += p[2]; c++; }
      return v.map((x) => x / c);
    });
    vel[lr] = P[lr].map((_, i) => {
      const a = P[lr][Math.max(0, i - 1)], b = P[lr][Math.min(n - 1, i + 1)], dt = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) / fps || 1;
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt;
    });
  }
  // Single support (a kick, a lunge, a balance): one foot is well up and moving while the other stays below it, so
  // that lower one carries the weight even when the capture's depth lifts both. Both feet up together is a jump.
  const gapMin = 0.25 * sc, vSupport = 2.5 * sc;
  for (const lr of ["l", "r"]) {
    const o = lr === "l" ? "r" : "l";
    const f = new Array(n).fill(false);
    let on = false;
    for (let i = 0; i < n; i++) {
      const h = P[lr][i][1] - ref[i], v = vel[lr][i];
      const support = P[o][i][1] - P[lr][i][1] > gapMin && v < vSupport;
      on = support || (on ? h < hOut && v < vOut : h < hIn && v < vIn);
      f[i] = on;
    }
    out[lr] = cleanRuns(f, 3, 2);
  }
  return out;
}

/**
 * The ground line under the take: the planted ankles' height where a foot is down, carried straight across flights.
 * A take can't open or close on a flight longer than maxFlight seconds, so a longer stretch with no contact before the
 * first plant or after the last (a run-up whose depth the capture got wrong) follows the lower ankle instead: grounded,
 * just not pinned. Between two plants, however long, it is a flight (a flip) and keeps its arc.
 */
export function groundLine(ankles, contact, { fps = 24, maxFlight = 0.85 } = {}) {
  const n = ankles.length, g = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const hs = ["l", "r"].filter((lr) => contact[lr][i]).map((lr) => ankles[i][lr][1]);
    if (hs.length) g[i] = Math.min(...hs);
  }
  if (!g.some((v) => v != null)) return ankles.map((a) => Math.min(a.l[1], a.r[1]));
  const lowAt = (i) => Math.min(ankles[i].l[1], ankles[i].r[1]);
  const longGap = Math.round(maxFlight * fps);
  for (let i = 0; i < n;) {
    if (g[i] != null) { i++; continue; }
    let j = i; while (j < n && g[j] == null) j++;
    if ((i === 0 || j === n) && j - i > longGap) for (let q = i; q < j; q++) g[q] = lowAt(q);
    i = j;
  }
  const known = g.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  for (let i = 0; i < n; i++) {
    if (g[i] != null) continue;
    let a = -1, b = -1;
    for (const k of known) { if (k < i) a = k; else { b = k; break; } }
    g[i] = a < 0 ? g[b] : b < 0 ? g[a] : g[a] + (g[b] - g[a]) * (i - a) / (b - a);
  }
  // a little smoothing, so the line doesn't step when the planted foot changes
  return g.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { s += g[j]; c++; } return s / c; });
}

/**
 * 0..1 plant weight per frame: 1 inside a contact, easing to 0 over `ramp` frames at its ends (smooth transitions).
 * A contact running off either end of the take is planted right to that end.
 */
export function contactWeights(flags, ramp = 3) {
  const n = flags.length, w = new Array(n).fill(0);
  for (let i = 0; i < n;) {
    if (!flags[i]) { i++; continue; }
    let j = i; while (j < n && flags[j]) j++;
    const len = j - i, r = Math.max(1, Math.min(ramp, Math.floor(len / 2)));
    for (let q = i; q < j; q++) {
      const e = Math.min(i === 0 ? Infinity : q - i + 1, j === n ? Infinity : j - q) / r;   // 1/r at the ends, 1 from r frames in
      const t = Math.min(1, e);
      w[q] = t * t * (3 - 2 * t);
    }
    i = j;
  }
  return w;
}

/** For each frame inside a contact, the frame the foot is pinned to (the middle of that contact); -1 elsewhere. */
export function anchorFrames(flags) {
  const n = flags.length, a = new Array(n).fill(-1);
  for (let i = 0; i < n;) {
    if (!flags[i]) { i++; continue; }
    let j = i; while (j < n && flags[j]) j++;
    const m = (i + j - 1) >> 1;
    for (let q = i; q < j; q++) a[q] = m;
    i = j;
  }
  return a;
}

/**
 * The pelvis (root) height offset that puts the lowest planted sole on its support. feet: [{sole, support, w}] with
 * sole = the foot's lowest point now, support = the walkable surface under it, w = its plant weight (0..1).
 * lift = how high the take's feet are off the ground line (a jump). Off the ground the lowest foot sits `lift` over
 * its support; planted, the lowest planted foot touches; between, a blend. No foot ends up under its support.
 */
export function solvePelvis(feet, lift = 0, { guard = true } = {}) {
  const gaps = feet.map((f) => f.sole - f.support);
  const free = lift - Math.min(...gaps);
  const planted = feet.filter((f) => f.w > 1e-3);
  let dy = free;
  if (planted.length) {
    // The foot carrying the most weight decides (the lower one when both are fully down); one easing out of its
    // contact doesn't pull the hips with it.
    const W = Math.max(...planted.map((f) => f.w));
    const touch = -Math.min(...planted.filter((f) => f.w >= W - 1e-3).map((f) => f.sole - f.support));
    dy = W * touch + (1 - W) * free;
  }
  return guard ? Math.max(dy, -Math.min(...gaps)) : dy;
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
 * facing), plus optionally support(x, z) -> the walkable surface height there (the set's floors, tables, platforms) and
 * at(stageFrame) -> the base at another frame. heightM: the figure's height. Returns the travel applied.
 *
 * With mocap.stick (on unless false: "Stick feet to ground") the take is cleaned up the way pro mocap is: each foot's
 * contacts (found once in retarget) are planted on the support under that foot, laid flat on it, the pelvis height is
 * solved so the lowest planted sole touches it, and a two-bone leg IK pins a planted foot where it landed (no
 * sliding), easing in and out at the ends of each contact. Off: the take's own feet height over its lowest tenth, as before.
 */
export function apply(g, take, mocap, frame, base, heightM = 1.8, fps = 24) {
  const J = g?.userData?.joints;
  if (!J) return;
  const u = takeFrame(take, mocap, frame, fps);
  const st = place(g, take, mocap, u, base, heightM);
  if (mocap.stick === false || !take.plant) {
    // Feet: put the lowest sole on the ground, plus however high the performer's feet are off it (a jump).
    const f0 = take.frames[st.i0], f1 = take.frames[st.i1];
    const feetLift = Math.max(0, (f0.feet + (f1.feet - f0.feet) * st.t) - take.ground) * st.k;
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
    return st.travel;
  }
  const lerpA = (a) => a[st.i0] + (a[st.i1] - a[st.i0]) * st.t;
  const w = { l: lerpA(take.plant.l), r: lerpA(take.plant.r) };
  const lift = lerpA(take.frames.map((f) => f.lift)) * st.k;
  // First the hips at about the right height (so the IK below works from where they will be).
  for (const lr of ["l", "r"]) flattenFoot(g, lr, w[lr]);
  plantRoot(g, base, w, lift);
  resetFeet(g);
  // Leg IK: a planted foot goes back to where it stood at the middle of its contact.
  for (const lr of ["l", "r"]) {
    if (w[lr] < 1e-3) continue;
    const near = st.t < 0.5 ? st.i0 : st.i1;
    const a = take.plant.anchor[lr][near] >= 0 ? take.plant.anchor[lr][near] : take.plant.anchor[lr][near === st.i0 ? st.i1 : st.i0];
    if (a < 0) continue;
    const target = anchorPoint(g, take, mocap, a, u, frame, base, heightM, fps, lr);
    if (target) legIK(g, lr, target, w[lr]);
  }
  for (const lr of ["l", "r"]) flattenFoot(g, lr, w[lr]);
  // Pelvis: the lowest planted sole on the support under it (a jump keeps its height over the ground line).
  plantRoot(g, base, w, lift);
  return st.travel;
}

/** Joints, path and facing at take frame u (fractional); the root's height left at base.y. */
function place(g, take, mocap, u, base, heightM) {
  const J = g.userData.joints;
  resetFeet(g);
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
  g.updateMatrixWorld(true);
  return { i0, i1, t, k, travel };
}

// ------------------------------------------------------------------ feet on the ground
const _v = new THREE.Vector3();

/** The shoe of each leg (the box under the shin) and its 8 local corners. */
export function feetOf(g) {
  if (g.userData._feet) return g.userData._feet;
  const out = {};
  for (const lr of ["l", "r"]) {
    const knee = g.userData.joints?.[`${lr}_knee`];
    const shoe = knee?.children.find((c) => c.geometry?.type === "BoxGeometry");
    if (!shoe) continue;
    shoe.geometry.computeBoundingBox();
    const b = shoe.geometry.boundingBox, corners = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z));
    // The ankle: the top of the shoe on the shin's axis (knee space). The foot pivots there when it is laid flat.
    const rest = shoe.userData.restPos || (shoe.userData.restPos = shoe.position.clone());
    const ankle = new THREE.Vector3(rest.x, rest.y + b.max.y * shoe.scale.y, 0);
    out[lr] = { knee, shoe, corners, rest, ankle };
  }
  Object.defineProperty(g.userData, "_feet", { value: out, enumerable: false, configurable: true });
  return out;
}

/** A foot's sole (its lowest corner, world Y) and its centre (world). */
export function footState(g, lr) {
  const f = feetOf(g)[lr];
  if (!f) return null;
  f.shoe.updateWorldMatrix(true, false);
  let sole = Infinity;
  for (const c of f.corners) sole = Math.min(sole, _v.copy(c).applyMatrix4(f.shoe.matrixWorld).y);
  return { sole, center: f.shoe.getWorldPosition(new THREE.Vector3()), ankle: f.knee.localToWorld(f.ankle.clone()) };
}

/** Put the shoes back on the shins as built (no ankle angle). */
export function resetFeet(g) {
  for (const f of Object.values(feetOf(g))) { f.shoe.position.copy(f.rest); f.shoe.quaternion.identity(); }
}

/**
 * Lay a planted foot flat (the clay has no ankle joint: the shoe rides the shin, so a bent knee would tip the toe into
 * the floor and lift the heel). Turns the shoe about the ankle until its sole is level, keeping where the toe points;
 * w blends it in and out with the contact. At most 70 degrees.
 */
export function flattenFoot(g, lr, w = 1) {
  const f = feetOf(g)[lr];
  if (!f || w <= 0) return;
  f.knee.updateWorldMatrix(true, false);
  const qk = f.knee.getWorldQuaternion(new THREE.Quaternion());
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qk);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1).applyQuaternion(qk).setY(0);
  if (fwd.lengthSq() < 1e-8) return;
  const flat = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(fwd.x, fwd.z));
  // a scaled parent never rolls the foot: only rotation matters here
  let target = qk.clone().slerp(flat, w);
  const ang = qk.angleTo(target), MAX = 70 * Math.PI / 180;
  if (ang > MAX) target = qk.clone().rotateTowards(target, MAX);
  const local = qk.clone().invert().multiply(target);
  f.shoe.quaternion.copy(local);
  f.shoe.position.copy(f.rest).sub(f.ankle).applyQuaternion(local).add(f.ankle);
  f.shoe.updateWorldMatrix(false, false);
}

/**
 * Raise or lower the root so the lowest planted sole is on the support under it (see solvePelvis). A free foot whose
 * toe would then dip under the floor (toe-off, heel-strike: the clay has no ankle) is laid flat first; only if it is
 * still under do the hips come up.
 */
function plantRoot(g, base, w, lift) {
  const read = () => {
    g.updateMatrixWorld(true);
    const feet = [];
    for (const lr of ["l", "r"]) {
      const s = footState(g, lr);
      if (!s) continue;
      const sup = base.support ? base.support(s.center.x, s.center.z, base.y) : base.y;
      feet.push({ lr, sole: s.sole, support: Number.isFinite(sup) ? sup : base.y, w: w[lr] || 0 });
    }
    return feet;
  };
  let feet = read();
  if (!feet.length) return;
  g.position.y += solvePelvis(feet, lift, { guard: false });
  feet = read();
  let flattened = false;
  for (const f of feet) if (f.w < 0.999 && f.sole < f.support - 1e-3) { flattenFoot(g, f.lr, 1); flattened = true; }
  if (flattened) feet = read();
  g.position.y += Math.max(0, -Math.min(...feet.map((f) => f.sole - f.support)));
  g.updateMatrixWorld(true);
}

/**
 * Where a planted foot's ankle stood at the middle of its contact (take frame a), in world space: the figure posed
 * there, feet laid flat, pelvis solved (no IK). Cached per figure, so a contact costs one extra pose evaluation, not one per frame.
 */
function anchorPoint(g, take, mocap, a, u, frame, base, heightM, fps, lr) {
  // The base (the actor's keyed spot) at the stage frame the anchor plays on.
  const b = base.at && Math.abs(a - u) > 1e-6 ? base.at(frame + (a - u) * fps / (take.fps * (mocap.speed || 1))) : base;
  const key = [lr, a, b.x, b.y, b.z, b.yaw, heightM, mocap.travel !== false, mocap.world ? 1 : 0].map((v) => (typeof v === "number" ? v.toFixed(4) : v)).join("|");
  const cache = g.userData._anchors || Object.defineProperty(g.userData, "_anchors", { value: { take: null, m: new Map() }, enumerable: false, configurable: true })._anchors;
  if (cache.take !== take) { cache.take = take; cache.m.clear(); }
  if (cache.m.has(key)) return cache.m.get(key);
  // Save the pose, evaluate the anchor frame, read the foot, restore.
  const J = g.userData.joints, saved = {};
  for (const id of Object.keys(J)) saved[id] = J[id].quaternion.clone();
  const pos = g.position.clone(), rot = g.rotation.clone();
  const shoes = Object.values(feetOf(g)).map((f) => [f.shoe, f.shoe.position.clone(), f.shoe.quaternion.clone()]);
  place(g, take, mocap, a, b, heightM);
  for (const s of ["l", "r"]) flattenFoot(g, s, take.plant[s][a]);
  plantRoot(g, b, { l: take.plant.l[a], r: take.plant.r[a] }, take.frames[a].lift * ((heightM / 1.8) * (1.8 * 0.47) / Math.max(0.3, take.leg)));
  const p = footState(g, lr)?.ankle || null;
  for (const id of Object.keys(J)) J[id].quaternion.copy(saved[id]);
  for (const [sh, sp, sq] of shoes) { sh.position.copy(sp); sh.quaternion.copy(sq); }
  g.position.copy(pos); g.rotation.copy(rot);
  g.updateMatrixWorld(true);
  if (cache.m.size > 512) cache.m.clear();
  cache.m.set(key, p);
  return p;
}

/**
 * Two-bone leg IK: bend the knee so hip-to-ankle spans the distance to target, then swing the hip so the ankle lands
 * on it. Blended with weight w (0 = the take's own leg, 1 = fully pinned). The knee stays within 0..2.4 rad.
 */
export function legIK(g, lr, target, w = 1) {
  const J = g.userData.joints, hip = J[`${lr}_hip`], knee = J[`${lr}_knee`], foot = feetOf(g)[lr];
  if (!hip || !knee || !foot || w <= 0) return;
  g.updateMatrixWorld(true);
  const H = hip.getWorldPosition(new THREE.Vector3());
  const want = target.clone().sub(H);
  const d = want.length();
  if (d < 1e-4) return;
  // Lengths are in the figure's own scale (the group may be scaled): measure them in world space.
  const s = new THREE.Vector3(); g.getWorldScale(s);
  const thigh = knee.position.clone().multiply(s);            // hip -> knee, hip space (pre-rotation)
  const c = foot.ankle.clone().multiply(s);                   // knee -> ankle, knee space
  const spanAt = (th) => thigh.clone().add(c.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), th)).length();
  let lo = 0, hi = 2.4;
  let th;
  if (d >= spanAt(lo)) th = lo;
  else if (d <= spanAt(hi)) th = hi;
  else {
    for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (spanAt(m) > d) lo = m; else hi = m; }
    th = (lo + hi) / 2;
  }
  const q0Hip = hip.quaternion.clone(), q0Knee = knee.quaternion.clone();
  knee.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), th);
  hip.updateMatrixWorld(true);
  const cur = knee.localToWorld(foot.ankle.clone()).sub(H);
  if (cur.lengthSq() > 1e-10) {
    const swing = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want.clone().normalize());
    const hipW = hip.getWorldQuaternion(new THREE.Quaternion());
    const parentW = hip.parent.getWorldQuaternion(new THREE.Quaternion());
    hip.quaternion.copy(parentW.invert().multiply(swing.multiply(hipW)));
  }
  if (w < 1) {
    hip.quaternion.copy(q0Hip.slerp(hip.quaternion, w));
    knee.quaternion.copy(q0Knee.slerp(knee.quaternion, w));
  }
  g.updateMatrixWorld(true);
}
