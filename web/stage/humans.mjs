// Soundstage character figures: proportioned, faceless previz people with hair and wardrobe
// silhouettes and real colours, so the previz already reads like the final cast (and the look
// still, which starts from the Color pass, inherits wardrobe and skin colours).
import * as THREE from "../vendor/three.module.min.mjs";

export const APPEARANCE_OPTIONS = {
  build: ["slim", "average", "athletic", "heavy"],
  hair: ["short", "long", "bun", "ponytail", "curly", "bald", "cap", "hat"],
  top: ["tshirt", "shirt", "sweater", "hoodie", "jacket", "suit", "coat", "dress", "uniform", "tank"],
  bottom: ["jeans", "trousers", "shorts", "skirt"],
};

export const SKIN_TONES = ["#f1c7a8", "#e0ac86", "#c68a63", "#a7704b", "#7d5136", "#5a3a26"];

export const DEFAULT_APPEARANCE = {
  man: { build: "average", hair: "short", hair_color: "#2b211b", skin: "#c68a63", top: "jacket", top_color: "#3b342f",
    bottom: "jeans", bottom_color: "#2e3b55", shoes_color: "#1d1d1f" },
  woman: { build: "slim", hair: "long", hair_color: "#3a2a20", skin: "#e0ac86", top: "sweater", top_color: "#d9cbb8",
    bottom: "jeans", bottom_color: "#3a4d6e", shoes_color: "#e8e6e1" },
  child: { build: "slim", hair: "short", hair_color: "#5a3d26", skin: "#e0ac86", top: "tshirt", top_color: "#d9534f",
    bottom: "shorts", bottom_color: "#38536b", shoes_color: "#f2f2f2" },
};

/**
 * Build a figure. mesh(geom, color) returns a shadowed mesh with that colour.
 * Returns a Group (origin on the floor, facing +Z) with userData.limbs for the walk cycle.
 */
export function buildHuman(kind, heightM, appearance, mesh) {
  const ap = { ...(DEFAULT_APPEARANCE[kind] || DEFAULT_APPEARANCE.man), ...(appearance || {}) };
  const female = kind === "woman" || ap.gender === "female";
  const s = (heightM || (kind === "child" ? 1.2 : female ? 1.68 : 1.8)) / 1.8;
  const bw = { slim: 0.9, average: 1, athletic: 1.08, heavy: 1.28 }[ap.build] || 1;
  const g = new THREE.Group();
  g.userData.limbs = [];
  const add = (parent, geom, color, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const m = mesh(geom, color);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  };
  // Posable chain (Pose Studio style): waist -> spine/chest -> neck -> head; shoulders hang off the chest.
  // Each pivot keeps its absolute height in userData.absY so the parts below are written in figure space.
  const joints = (g.userData.joints = {});
  const pivot = (parent, id, absY, kind, side = 0) => {
    const j = new THREE.Group();
    j.position.y = absY - (parent.userData.absY || 0);
    j.userData = { absY, jkind: kind, side };
    parent.add(j);
    if (id) joints[id] = j;
    return j;
  };
  const inside = (grp) => (geom, color, x, y, z, sx, sy, sz) => add(grp, geom, color, x, y - grp.userData.absY, z, sx, sy, sz);
  g.userData.absY = 0;
  const upper = pivot(g, "spine", 0.96 * s, "trunk");
  const neckJ = pivot(upper, "neck", 1.48 * s, "trunk");
  const headJ = pivot(neckJ, "head", 1.585 * s, "trunk");
  const U = inside(upper), N = inside(neckJ), H = inside(headJ);
  const longSleeves = !["tshirt", "tank"].includes(ap.top);
  const topCol = ap.top_color, botCol = ap.bottom_color, skin = ap.skin;
  const legCol = ap.bottom === "shorts" || ap.bottom === "skirt" || ap.top === "dress" ? skin : botCol;

  // Torso: tapered from shoulders to waist (flattened front to back); hips below.
  const shoulderR = (female ? 0.17 : 0.2) * bw * s, waistR = (female ? 0.13 : 0.15) * bw * s;
  U(new THREE.CylinderGeometry(shoulderR, waistR, 0.52 * s, 20), topCol, 0, 1.24 * s, 0, 1, 1, 0.62);
  add(g, new THREE.SphereGeometry(waistR * 1.12, 18, 12), ap.top === "dress" ? topCol : botCol, 0, 0.96 * s, 0, female ? 1.15 : 1.02, 0.7, 0.75);
  if (female && ap.top !== "uniform") U(new THREE.SphereGeometry(0.06 * s * bw, 12, 10), topCol, 0, 1.33 * s, 0.07 * s, 1.9, 0.9, 0.9);
  // Long garments: coat hem, dress, skirt.
  if (ap.top === "coat") add(g, new THREE.CylinderGeometry(waistR * 1.05, waistR * 1.45, 0.42 * s, 20), topCol, 0, 0.86 * s, 0, 1, 1, 0.7);
  if (ap.top === "suit" || ap.top === "jacket") add(g, new THREE.CylinderGeometry(waistR * 1.02, waistR * 1.1, 0.12 * s, 20), topCol, 0, 0.93 * s, 0, 1, 1, 0.68);
  if (ap.top === "dress") add(g, new THREE.ConeGeometry(waistR * 2.1, 0.5 * s, 22, 1, true), topCol, 0, 0.72 * s, 0, 1, 1, 0.8);
  if (ap.bottom === "skirt" && ap.top !== "dress") add(g, new THREE.ConeGeometry(waistR * 1.9, 0.34 * s, 22, 1, true), botCol, 0, 0.8 * s, 0, 1, 1, 0.8);
  if (ap.top === "hoodie") U(new THREE.TorusGeometry(0.1 * s, 0.035 * s, 8, 16), topCol, 0, 1.5 * s, -0.04 * s, 1, 1, 0.8);

  // Neck and head (no face: previz stays anonymous).
  N(new THREE.CylinderGeometry(0.045 * s, 0.05 * s, 0.1 * s, 12), skin, 0, 1.53 * s, 0);
  const headY = 1.67 * s;
  H(new THREE.SphereGeometry(0.105 * s, 20, 16), skin, 0, headY, 0.005 * s, 0.9, 1.08, 1);
  // Directional cues, still anonymous (no eyes or mouth): nose, brow, chin and ears, so a head turn reads in
  // the clay and the video model can follow which way someone is looking.
  H(new THREE.ConeGeometry(0.018 * s, 0.045 * s, 10), skin, 0, headY - 0.012 * s, 0.103 * s).rotation.x = Math.PI / 2;
  H(new THREE.BoxGeometry(0.15 * s, 0.018 * s, 0.03 * s), skin, 0, headY + 0.032 * s, 0.085 * s);
  H(new THREE.SphereGeometry(0.05 * s, 14, 10), skin, 0, headY - 0.07 * s, 0.05 * s, 1.2, 0.8, 1);
  for (const ex of [-1, 1]) H(new THREE.SphereGeometry(0.024 * s, 10, 8), skin, ex * 0.095 * s, headY - 0.005 * s, -0.005 * s, 0.45, 1, 0.8);

  // Hair / headwear.
  const hc = ap.hair_color;
  const cap = (r, sy) => H(new THREE.SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hc, 0, headY + 0.01 * s, -0.005 * s, 0.95, sy, 1.02);
  switch (ap.hair) {
    case "bald":
      break;
    case "long":
      cap(0.112 * s, 1.05);
      H(new THREE.BoxGeometry(0.2 * s, 0.32 * s, 0.07 * s), hc, 0, headY - 0.13 * s, -0.07 * s);
      break;
    case "bun":
      cap(0.11 * s, 1);
      H(new THREE.SphereGeometry(0.05 * s, 12, 10), hc, 0, headY + 0.06 * s, -0.1 * s);
      break;
    case "ponytail":
      cap(0.11 * s, 1);
      H(new THREE.CapsuleGeometry(0.03 * s, 0.18 * s, 4, 8), hc, 0, headY - 0.08 * s, -0.12 * s);
      break;
    case "curly":
      H(new THREE.IcosahedronGeometry(0.13 * s, 1), hc, 0, headY + 0.03 * s, -0.01 * s, 1, 0.9, 1);
      break;
    case "cap":
      cap(0.112 * s, 0.9);
      H(new THREE.BoxGeometry(0.16 * s, 0.015 * s, 0.1 * s), topCol, 0, headY + 0.03 * s, 0.11 * s);
      break;
    case "hat":
      H(new THREE.CylinderGeometry(0.2 * s, 0.2 * s, 0.015 * s, 24), hc, 0, headY + 0.06 * s, 0);
      H(new THREE.CylinderGeometry(0.1 * s, 0.11 * s, 0.11 * s, 20), hc, 0, headY + 0.12 * s, 0);
      break;
    default: // short
      cap(0.11 * s, 0.95);
  }

  // Limbs: pivot groups at shoulders/hips, with elbow/knee pivots so the walk bends naturally.
  const limb = (x, y, phase, upperLen, lowerLen, r, upperCol, lowerCol, endCol, isLeg) => {
    const side = x < 0 ? -1 : 1;                 // the figure faces +Z, so +X is its LEFT
    const lr = side > 0 ? "l" : "r";
    const parent = isLeg ? g : upper;
    const root = pivot(parent, `${lr}_${isLeg ? "hip" : "shoulder"}`, y, isLeg ? "hip" : "shoulder", side);
    root.position.x = x;
    add(root, new THREE.CapsuleGeometry(r, upperLen, 4, 10), upperCol, 0, -upperLen / 2 - r * 0.5, 0);
    const joint = new THREE.Group();
    joint.position.y = -upperLen - r;
    joint.userData = { jkind: isLeg ? "knee" : "elbow", side };
    joints[`${lr}_${isLeg ? "knee" : "elbow"}`] = joint;
    root.add(joint);
    add(joint, new THREE.CapsuleGeometry(r * 0.85, lowerLen, 4, 10), lowerCol, 0, -lowerLen / 2 - r * 0.4, 0);
    if (isLeg) add(joint, new THREE.BoxGeometry(r * 2.1, r * 1.3, r * 3.6), endCol, 0, -lowerLen - r * 1.2, r * 0.9);
    else buildHand(joint, -lowerLen - r * 0.6, side, lr, endCol);
    g.userData.limbs.push({ pivot: root, phase, amp: isLeg ? 0.42 : 0.34, part: isLeg ? "hip" : "shoulder", side });
    g.userData.limbs.push({ pivot: joint, phase: phase + (isLeg ? Math.PI / 2 : 0), amp: isLeg ? 0.55 : 0.25,
      bend: isLeg ? 1 : -1, part: isLeg ? "knee" : "elbow", side });
  };
  // A hand: wrist pivot, palm, and five fingers of three segments (knuckle, middle, tip), palm facing the body.
  const buildHand = (forearm, y, side, lr, col) => {
    const k = s;
    const wrist = new THREE.Group();
    wrist.position.y = y;
    wrist.userData = { jkind: "wrist", side };
    joints[`${lr}_wrist`] = wrist;
    forearm.add(wrist);
    const palmL = 0.085 * k, palmW = 0.08 * k, palmT = 0.028 * k;
    add(wrist, new THREE.BoxGeometry(palmT, palmL, palmW), col, 0, -palmL / 2, 0);
    const fingers = [
      ["thumb", [0.034, 0.028, 0.024], 0.011, -0.018, 0.042, 0.45],
      ["index", [0.036, 0.024, 0.02], 0.0095, -palmL / k, 0.03, 0],
      ["middle", [0.04, 0.026, 0.021], 0.0098, -palmL / k, 0.01, 0],
      ["ring", [0.037, 0.024, 0.02], 0.0094, -palmL / k, -0.01, 0],
      ["pinky", [0.029, 0.019, 0.017], 0.0085, -palmL / k, -0.029, 0],
    ];
    for (const [name, lens, rad, fy, fz, splay] of fingers) {
      let parent = wrist, py = fy * k;
      lens.forEach((len, i) => {
        const j = new THREE.Group();
        j.position.set(name === "thumb" && i === 0 ? -side * 0.006 * k : 0, py, name === "thumb" && i === 0 ? fz * k : (i === 0 ? fz * k : 0));
        if (i === 0 && splay) j.rotation.x = -splay;
        j.userData = { jkind: "finger", side, finger: name, seg: i, rest: [i === 0 ? -splay : 0, 0, 0] };
        joints[`${lr}_${name}_${i + 1}`] = j;
        parent.add(j);
        add(j, new THREE.CapsuleGeometry(rad * k, len * k * 0.7, 3, 6), col, 0, -len * k / 2, 0);
        parent = j; py = -len * k;
      });
    }
  };
  const hipX = (female ? 0.085 : 0.095) * bw * s;
  for (const [i, side] of [-1, 1].entries()) {
    const ph = i ? Math.PI : 0;
    limb(side * hipX, 0.9 * s, ph, 0.38 * s, 0.38 * s, 0.065 * bw * s, legCol, legCol, ap.shoes_color, true);
    limb(side * (shoulderR + 0.03 * s), 1.47 * s, ph + Math.PI, 0.25 * s, 0.23 * s, 0.045 * bw * s,
      topCol, longSleeves ? topCol : skin, skin, false);
  }
  return g;
}

/**
 * Hold a pose instead of walking. "sit" (chair, bench, car seat), "ride" (horse, astride),
 * "cycle" (bicycle/motorcycle: hands forward on the bars), "stand".
 * Returns how far the figure's feet-origin sits below its seat, in metres at this scale.
 */
export function applyPose(g, pose, heightM = 1.8) {
  const s = heightM / 1.8;
  for (const l of g.userData.limbs || []) {
    l.pivot.rotation.set(0, 0, 0);
    if (pose === "sit") {
      if (l.part === "hip") l.pivot.rotation.x = -Math.PI / 2;
      if (l.part === "knee") l.pivot.rotation.x = Math.PI / 2;
      if (l.part === "shoulder") l.pivot.rotation.x = -0.35;
      if (l.part === "elbow") l.pivot.rotation.x = -0.9;
    } else if (pose === "ride") {
      if (l.part === "hip") { l.pivot.rotation.x = -1.1; l.pivot.rotation.z = l.side * 0.45; }
      if (l.part === "knee") l.pivot.rotation.x = 1.3;
      // Rein hands: upper arms near the body, forearms angled down to the withers. A forearm held level reads as
      // pointing, and LTX copies the clay rider's pose literally.
      if (l.part === "shoulder") { l.pivot.rotation.x = -0.25; l.pivot.rotation.z = -l.side * 0.08; }
      if (l.part === "elbow") l.pivot.rotation.x = -0.75;
    } else if (pose === "cycle") {
      if (l.part === "hip") l.pivot.rotation.x = -1.2;
      if (l.part === "knee") l.pivot.rotation.x = 1.5;
      if (l.part === "shoulder") l.pivot.rotation.x = -1.1;
      if (l.part === "elbow") l.pivot.rotation.x = -0.2;
    }
  }
  // Seated pelvis height above the feet origin when standing is ~0.92 m; the thigh/shin fold drops it.
  // The figure's pelvis sits ~0.95 m above its feet origin; seated, that's the drop to the seat.
  return pose === "stand" ? 0 : 0.95 * s;
}

/** Where a rider sits on each kind of mount (local to the mount: x, seat height, z) and how. */
export const MOUNTS = {
  horse: { pose: "ride", seat: [0, 1.56, -0.05], scaleWithHeight: true, refHeight: 1.6 },
  bicycle: { pose: "cycle", seat: [0, 1.0, -0.25] },
  motorcycle: { pose: "cycle", seat: [0, 0.86, -0.15] },
  car: { pose: "sit", seat: [-0.38, 0.5, 0.15] },
  truck: { pose: "sit", seat: [-0.5, 1.25, 2.3] },
  chair: { pose: "sit", seat: [0, 0.47, 0] },
  bench: { pose: "sit", seat: [0, 0.47, 0.05] },
  table: { pose: "sit", seat: [0, 0.77, 0] },
  rock: { pose: "sit", seat: [0, 0.6, 0] },
  cube: { pose: "sit", seat: [0, 1.0, 0], scaleWithHeight: true, refHeight: 1 },
};

// ------------------------------------------------------------------ Pose Studio
// A pose is { jointId: [a, b, c] } in degrees, in plain words per joint kind (see JOINT_AXES). It overrides the
// walk cycle / seat pose for the joints it names only, so a walking actor can still turn their head.
export const JOINT_AXES = {
  trunk: ["Bend forward", "Turn left", "Tilt left"],
  shoulder: ["Raise forward", "Raise out", "Twist"],
  elbow: ["Bend", "Twist", ""],
  wrist: ["Bend", "Side", "Twist"],
  hip: ["Lift forward", "Out", "Twist"],
  knee: ["Bend", "", ""],
  finger: ["Curl", "Spread", ""],
};
const RANGES = { trunk: [[-60, 90], [-80, 80], [-45, 45]], shoulder: [[-60, 180], [-30, 160], [-90, 90]], elbow: [[0, 150], [-90, 90]],
  wrist: [[-70, 70], [-30, 30], [-90, 90]], hip: [[-30, 120], [-20, 80], [-45, 45]], knee: [[0, 150]], finger: [[-10, 100], [-25, 25]] };

const FINGERS = ["thumb", "index", "middle", "ring", "pinky"];
/** Joint groups for the UI, Pose Studio style. */
export function jointGroups() {
  const side = (lr, name) => (lr === "l" ? `Left ${name}` : `Right ${name}`);
  const groups = [{ id: "head", label: "Head & spine", joints: [["head", "Head"], ["neck", "Neck"], ["spine", "Chest / spine"]] }];
  for (const lr of ["l", "r"]) {
    groups.push({ id: `${lr}_arm`, label: side(lr, "arm"), joints: [[`${lr}_shoulder`, "Shoulder"], [`${lr}_elbow`, "Elbow"], [`${lr}_wrist`, "Wrist"]] });
    groups.push({ id: `${lr}_hand`, label: side(lr, "hand"),
      joints: FINGERS.flatMap((f) => [1, 2, 3].map((i) => [`${lr}_${f}_${i}`, `${f[0].toUpperCase()}${f.slice(1)} ${["knuckle", "middle", "tip"][i - 1]}`])) });
  }
  for (const lr of ["l", "r"]) groups.push({ id: `${lr}_leg`, label: side(lr, "leg"), joints: [[`${lr}_hip`, "Hip"], [`${lr}_knee`, "Knee"]] });
  return groups;
}

export function jointKind(id) {
  if (["head", "neck", "spine"].includes(id)) return "trunk";
  return id.split("_").length === 3 ? "finger" : id.split("_")[1];
}
export const jointRange = (id, axis) => (RANGES[jointKind(id)] || [])[axis] || [-90, 90];

const D = Math.PI / 180;
/** Set the named joints of a figure from a pose (degrees, plain-word axes). */
export function applyJoints(g, pose) {
  const J = g?.userData?.joints;
  if (!J || !pose) return;
  for (const [id, v] of Object.entries(pose)) {
    const j = J[id];
    if (!j || !Array.isArray(v)) continue;
    const [a = 0, b = 0, c = 0] = v, sd = j.userData.side || 1;
    const r = j.rotation;
    r.order = "XYZ";
    switch (j.userData.jkind) {
      case "trunk": r.set(a * D, b * D, -c * D); break;
      case "shoulder": r.set(-a * D, sd * c * D, sd * b * D); break;
      case "elbow": r.set(-a * D, sd * b * D, 0); break;
      case "wrist": r.set(-a * D, sd * c * D, sd * b * D); break;
      case "hip": r.set(-a * D, sd * c * D, sd * b * D); break;
      case "knee": r.set(a * D, 0, 0); break;
      case "finger": {
        const rest = j.userData.rest || [0, 0, 0];
        const thumb = j.userData.finger === "thumb";
        // Curl folds toward the palm (the palm faces the body); the thumb folds across it.
        r.set(rest[0] - (thumb ? a * 0.6 : 0) * D - b * D, 0, -sd * (thumb ? a * 0.5 : a) * D);
        break;
      }
      default: break;
    }
  }
}

const fist = (lr, c = 85) => Object.fromEntries(FINGERS.flatMap((f) => [1, 2, 3].map((i) => [`${lr}_${f}_${i}`, [f === "thumb" ? 50 : c, 0]])));
const point = (lr) => ({ ...fist(lr), [`${lr}_index_1`]: [0, 0], [`${lr}_index_2`]: [0, 0], [`${lr}_index_3`]: [0, 0] });
const open = (lr) => Object.fromEntries(FINGERS.flatMap((f) => [1, 2, 3].map((i) => [`${lr}_${f}_${i}`, [0, f === "thumb" ? 0 : (FINGERS.indexOf(f) - 2) * -8]])));
/** The pose gallery. */
export const POSE_PRESETS = {
  "Relaxed": { l_shoulder: [0, 6, 0], r_shoulder: [0, 6, 0], l_elbow: [12, 0], r_elbow: [12, 0], ...fist("l", 25), ...fist("r", 25) },
  "Look left": { head: [0, 55, 0], neck: [0, 15, 0] },
  "Look right": { head: [0, -55, 0], neck: [0, -15, 0] },
  "Look back over shoulder": { head: [0, 75, 0], neck: [0, 25, 0], spine: [0, 30, 0] },
  "Look up": { head: [-35, 0, 0], neck: [-10, 0, 0] },
  "Point": { r_shoulder: [90, 10, 0], r_elbow: [5, 0], ...point("r"), head: [0, -10, 0] },
  "Wave": { r_shoulder: [20, 115, 0], r_elbow: [70, 0], r_wrist: [0, 0, 0], ...open("r") },
  "Hands up": { l_shoulder: [10, 165, 0], r_shoulder: [10, 165, 0], l_elbow: [15, 0], r_elbow: [15, 0], ...open("l"), ...open("r") },
  "Phone to ear": { r_shoulder: [35, 30, -40], r_elbow: [145, 0], r_wrist: [10, 0, 0], ...fist("r", 55), head: [0, 0, -8] },
  "Arms crossed": { l_shoulder: [35, 6, -80], r_shoulder: [38, 6, -80], l_elbow: [100, 0], r_elbow: [100, 0], ...fist("l", 40), ...fist("r", 40) },
  "Fists": { ...fist("l"), ...fist("r"), l_elbow: [35, 0], r_elbow: [35, 0] },
  "Thinking": { r_shoulder: [40, 0, -30], r_elbow: [150, 0], ...fist("r", 50), head: [8, 0, 10] },
  "Hold flashlight up": { r_shoulder: [80, 10, 0], r_elbow: [20, 0], ...fist("r", 80), head: [0, -5, 0] },
  "Lean in": { spine: [20, 0, 0], neck: [10, 0, 0] },
};

/** Mirror a pose left <-> right (turns and tilts flip sign). */
export function mirrorPose(pose) {
  const out = {};
  for (const [id, v] of Object.entries(pose || {})) {
    const k = jointKind(id);
    const m = id.startsWith("l_") ? `r_${id.slice(2)}` : id.startsWith("r_") ? `l_${id.slice(2)}` : id;
    out[m] = k === "trunk" ? [v[0], -(v[1] || 0), -(v[2] || 0)] : [...v];
  }
  return out;
}
