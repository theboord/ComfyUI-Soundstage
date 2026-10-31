// The Pose pass: every clay person on the stage as an OpenPose / DWPose-style skeleton (18 body points, 21 points per
// hand, 68 face points), drawn on black from the shot camera, one tile per frame in a sprite sheet. ⑤ Motion's Pose
// follow feeds it to LTX through the union-control IC-LoRA (SoundstagePoseFollow), the way DWPose maps of real footage
// drive it. Keypoints come from the clay rig's joints (web/stage/humans.mjs), so mocap takes, posing in 3D, walk
// cycles and seated riders all show up. Pure drawing helpers are exported for tests (tests/js/posepass.test.mjs).
import * as THREE from "../vendor/three.module.min.mjs";

// OpenPose COCO-18: 0 nose, 1 neck, 2 R shoulder, 3 R elbow, 4 R wrist, 5 L shoulder, 6 L elbow, 7 L wrist, 8 R hip,
// 9 R knee, 10 R ankle, 11 L hip, 12 L knee, 13 L ankle, 14 R eye, 15 L eye, 16 R ear, 17 L ear.
export const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
export const COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
  [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255],
  [255, 0, 255], [255, 0, 170], [255, 0, 85]];
export const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];
const FINGERS = ["thumb", "index", "middle", "ring", "pinky"];
const TIP_LEN = { thumb: 0.024, index: 0.02, middle: 0.021, ring: 0.02, pinky: 0.017 };   // humans.mjs finger segment 3

/** 68 face landmarks (iBUG order) on the clay head, in metres for a 1.8 m figure, relative to the head centre; the
 *  figure faces +Z and its right side is -X. */
export const FACE_TEMPLATE = (() => {
  const rx = 0.0945, ry = 0.113, rz = 0.105;
  const surf = (x, y, bump = 0) => [x, y, Math.sqrt(Math.max(0.05, 1 - (x / rx) ** 2 - (y / ry) ** 2)) * rz * 0.97 + bump];
  const pts = [];
  for (let t = 0; t <= 16; t++) {                              // 0-16 jaw, right ear -> chin -> left ear
    const a = -Math.PI / 2 + (Math.PI * t) / 16;
    pts.push(surf(0.08 * Math.sin(a), 0.005 - 0.092 * Math.cos(a) ** 1.2));
  }
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) {    // 17-21 right brow, 22-26 left brow (outer -> inner / inner -> outer)
    const u = side < 0 ? i / 4 : 1 - i / 4;
    const x = side * (0.012 + 0.05 * (1 - u));
    pts.push(surf(x, 0.034 + 0.008 * Math.sin(Math.PI * (1 - u))));
  }
  for (let i = 0; i < 4; i++) pts.push(surf(0, 0.024 - i * 0.016, 0.004 + i * 0.006));   // 27-30 nose bridge
  for (let i = 0; i < 5; i++) pts.push(surf(-0.018 + i * 0.009, -0.036 + Math.abs(i - 2) * 0.003, 0.006));   // 31-35
  const eye = (cx) => {                                        // 36-41 right eye, 42-47 left eye: from the image-left
    const w = 0.012, h = 0.0045;                               // corner over the upper lid to the other corner, then the lower lid
    return [Math.PI, (2 * Math.PI) / 3, Math.PI / 3, 0, -Math.PI / 3, (-2 * Math.PI) / 3].map((a) => surf(cx + Math.cos(a) * w, 0.012 + Math.sin(a) * h));
  };
  pts.push(...eye(-0.035), ...eye(0.035));
  const lip = (n, w, h, cy) => {                               // outer 48-59, inner 60-67: right corner, upper lip, left, lower
    const o = [];
    for (let i = 0; i < n; i++) { const a = Math.PI - (2 * Math.PI * i) / n; o.push(surf(Math.cos(a) * w, cy + Math.sin(a) * h)); }
    return o;
  };
  pts.push(...lip(12, 0.025, 0.009, -0.058), ...lip(8, 0.017, 0.003, -0.058));
  return pts;
})();

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const world = (obj, local) => obj.localToWorld(local.clone());

/** One clay person's keypoints in world space: {body: [18 Vector3|null], hands: [right21, left21], face: [68]|null,
 *  facing: dot of the face direction with the direction to the camera}. g = the figure (userData.joints). */
export function personKeypoints(g, camPos) {
  const J = g.userData.joints || {};
  if (!J.l_shoulder || !J.r_shoulder || !J.head) return null;
  g.updateMatrixWorld(true);
  const s = (J.head.userData.absY || 1.585) / 1.585;           // figure scale (1 = 1.8 m)
  const P = (id, local = v3()) => (J[id] ? world(J[id], local) : null);
  const headC = v3(0, 0.085 * s, 0.005 * s);
  const head = (x, y, z) => P("head", v3(x * s, 0.085 * s + y * s, 0.005 * s + z * s));
  const body = new Array(18).fill(null);
  body[2] = P("r_shoulder"); body[5] = P("l_shoulder");
  body[1] = body[2].clone().add(body[5]).multiplyScalar(0.5);
  body[3] = P("r_elbow"); body[6] = P("l_elbow");
  body[4] = P("r_wrist"); body[7] = P("l_wrist");
  body[8] = P("r_hip"); body[11] = P("l_hip");
  body[9] = P("r_knee"); body[12] = P("l_knee");
  body[10] = P("r_knee", v3(0, -0.42 * s, 0)); body[13] = P("l_knee", v3(0, -0.42 * s, 0));
  body[0] = head(0, -0.012, 0.105);
  body[14] = head(-0.035, 0.012, 0.09); body[15] = head(0.035, 0.012, 0.09);
  body[16] = head(-0.093, 0.0, 0.0); body[17] = head(0.093, 0.0, 0.0);
  // Facing: the head's forward axis against the line to the camera (1 = straight at the lens, < 0 = back of the head).
  const hc = P("head", headC), fwd = P("head", headC.clone().add(v3(0, 0, 0.1))).sub(hc).normalize();
  const facing = camPos ? fwd.dot(camPos.clone().sub(hc).normalize()) : 1;
  const hand = (lr) => {
    if (!J[`${lr}_wrist`]) return null;
    const pts = [P(`${lr}_wrist`, v3(0, -0.01 * s, 0))];
    for (const f of FINGERS) {
      for (let i = 1; i <= 3; i++) pts.push(P(`${lr}_${f}_${i}`));
      pts.push(P(`${lr}_${f}_3`, v3(0, -TIP_LEN[f] * s, 0)));
    }
    return pts.every(Boolean) ? pts : null;
  };
  const face = FACE_TEMPLATE.map(([x, y, z]) => head(x, y, z));
  return { body, hands: [hand("r"), hand("l")], face, facing };
}

/** World points -> pixels in a W x H frame through camera `cam` (null when behind the camera or far off frame). */
export function project(p, cam, W, H) {
  if (!p) return null;
  const v = p.clone().project(cam);
  if (v.z > 1 || v.z < -1) return null;
  const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
  return x < -W || x > 2 * W || y < -H || y > 2 * H ? null : [x, y];
}

/**
 * Draw people (pixel keypoints {body: [18 [x,y]|null], hands: [21 [x,y]|null][], face: [68][]|null}) the way
 * controlnet_aux's DWPose draws: limbs as 60%-opaque ellipses in the OpenPose colours, joints as dots, hands as rainbow
 * bones with blue dots, the face as white dots, on black.
 */
export function drawOpenPose(ctx, people, W, H) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const k = Math.max(1, Math.min(W, H) / 512);
  const stick = 4 * k, dot = 4 * k;
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  for (const p of people) {
    const b = p.body || [];
    LIMBS.forEach(([i, j], n) => {
      const A = b[i], B = b[j];
      if (!A || !B) return;
      const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, len = Math.hypot(B[0] - A[0], B[1] - A[1]) / 2;
      ctx.beginPath();
      ctx.ellipse(mx, my, Math.max(len, 0.5), stick, Math.atan2(B[1] - A[1], B[0] - A[0]), 0, Math.PI * 2);
      ctx.fillStyle = rgb(COLORS[n], 0.6);
      ctx.fill();
    });
    b.forEach((pt, i) => {
      if (!pt) return;
      ctx.beginPath(); ctx.arc(pt[0], pt[1], dot, 0, Math.PI * 2); ctx.fillStyle = rgb(COLORS[i]); ctx.fill();
    });
    for (const hand of p.hands || []) {
      if (!hand) continue;
      ctx.lineWidth = 2 * k;
      HAND_EDGES.forEach(([i, j], n) => {
        const A = hand[i], B = hand[j];
        if (!A || !B) return;
        const c = hsvRgb(n / HAND_EDGES.length);
        ctx.strokeStyle = rgb(c);
        ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      });
      for (const pt of hand) if (pt) { ctx.beginPath(); ctx.arc(pt[0], pt[1], dot, 0, Math.PI * 2); ctx.fillStyle = "rgb(0,0,255)"; ctx.fill(); }
    }
    for (const pt of p.face || []) if (pt) { ctx.beginPath(); ctx.arc(pt[0], pt[1], 3 * k * 0.75, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); }
  }
}

export function hsvRgb(h) {
  const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f, t = f;
  const [r, g, b] = [[1, t, 0], [q, 1, 0], [0, 1, t], [0, q, 1], [t, 0, 1], [1, 0, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Keypoints in world space -> pixel people, hiding the face (and nose, eyes) when the head turns away from the camera. */
export function toPixels(kp, cam, W, H) {
  const pr = (p) => project(p, cam, W, H);
  const body = kp.body.map(pr);
  const away = kp.facing < -0.05;
  if (away) { body[0] = body[14] = body[15] = null; }
  if (!away && kp.facing < 0.35) {                               // profile: the far ear (and, nearly side-on, the far eye) drop out
    const rEar = kp.body[16], lEar = kp.body[17];
    const rightFar = rEar.distanceTo(cam.position) > lEar.distanceTo(cam.position);
    body[rightFar ? 16 : 17] = null;
    if (kp.facing < 0.15) body[rightFar ? 14 : 15] = null;
  }
  return { body, hands: kp.hands.map((h) => (h ? h.map(pr) : null)), face: kp.facing > 0.25 ? kp.face.map(pr) : null };
}

/** The people on the stage right now (clay humans with a rig), as pixel keypoints from the shot camera. */
export function stagePeople(stage, W, H) {
  const cam = stage.camera.clone();
  cam.aspect = stage.fw / stage.fh;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  const out = [];
  for (const [, g] of stage.actorMeshes || []) {
    if (!g?.visible || !g.userData?.joints?.l_shoulder) continue;
    const kp = personKeypoints(g, cam.position);
    if (kp) out.push(toPixels(kp, cam, W, H));
  }
  return out;
}

/** Tile size of the pose sheet: the shot's aspect, at most 832 px wide (the union-control guide is ~544 px tall). */
export function poseTile(fw, fh, maxW = 832) {
  const w = Math.min(fw, maxW);
  return [Math.round(w / 2) * 2, Math.round((w * fh) / fw / 2) * 2];
}

/** Render every frame of the active shot as a pose sprite sheet. Returns {blob, grid: {cols, rows, frames, tile}}. */
export async function capturePoseSheet(stage, { onProgress = null } = {}) {
  const frames = Math.max(1, stage.state.shot?.frames || 97);
  const [tw, th] = poseTile(stage.fw, stage.fh);
  const cols = Math.min(frames, Math.floor(16000 / tw));
  const rows = Math.ceil(frames / cols);
  const sheet = new OffscreenCanvas(cols * tw, rows * th);
  const ctx = sheet.getContext("2d");
  const tile = new OffscreenCanvas(tw, th), tc = tile.getContext("2d");
  const keep = stage.frame;
  let people = 0;
  try {
    for (let f = 0; f < frames; f++) {
      stage.setFrameSilent(f);
      const ps = stagePeople(stage, tw, th);
      people = Math.max(people, ps.length);
      drawOpenPose(tc, ps, tw, th);
      ctx.drawImage(tile, (f % cols) * tw, Math.floor(f / cols) * th);
      if (onProgress && f % 12 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
    }
  } finally { stage.setFrame(keep); }
  const blob = await sheet.convertToBlob({ type: "image/png" });
  return { blob, people, grid: { cols, rows, frames, tile: [tw, th] } };
}
