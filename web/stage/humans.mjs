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
  const longSleeves = !["tshirt", "tank"].includes(ap.top);
  const topCol = ap.top_color, botCol = ap.bottom_color, skin = ap.skin;
  const legCol = ap.bottom === "shorts" || ap.bottom === "skirt" || ap.top === "dress" ? skin : botCol;

  // Torso: tapered from shoulders to waist (flattened front to back); hips below.
  const shoulderR = (female ? 0.17 : 0.2) * bw * s, waistR = (female ? 0.13 : 0.15) * bw * s;
  add(g, new THREE.CylinderGeometry(shoulderR, waistR, 0.52 * s, 20), topCol, 0, 1.24 * s, 0, 1, 1, 0.62);
  add(g, new THREE.SphereGeometry(waistR * 1.12, 18, 12), ap.top === "dress" ? topCol : botCol, 0, 0.96 * s, 0, female ? 1.15 : 1.02, 0.7, 0.75);
  if (female && ap.top !== "uniform") add(g, new THREE.SphereGeometry(0.06 * s * bw, 12, 10), topCol, 0, 1.33 * s, 0.07 * s, 1.9, 0.9, 0.9);
  // Long garments: coat hem, dress, skirt.
  if (ap.top === "coat") add(g, new THREE.CylinderGeometry(waistR * 1.05, waistR * 1.45, 0.42 * s, 20), topCol, 0, 0.86 * s, 0, 1, 1, 0.7);
  if (ap.top === "suit" || ap.top === "jacket") add(g, new THREE.CylinderGeometry(waistR * 1.02, waistR * 1.1, 0.12 * s, 20), topCol, 0, 0.93 * s, 0, 1, 1, 0.68);
  if (ap.top === "dress") add(g, new THREE.ConeGeometry(waistR * 2.1, 0.5 * s, 22, 1, true), topCol, 0, 0.72 * s, 0, 1, 1, 0.8);
  if (ap.bottom === "skirt" && ap.top !== "dress") add(g, new THREE.ConeGeometry(waistR * 1.9, 0.34 * s, 22, 1, true), botCol, 0, 0.8 * s, 0, 1, 1, 0.8);
  if (ap.top === "hoodie") add(g, new THREE.TorusGeometry(0.1 * s, 0.035 * s, 8, 16), topCol, 0, 1.5 * s, -0.04 * s, 1, 1, 0.8);

  // Neck and head (no face: previz stays anonymous).
  add(g, new THREE.CylinderGeometry(0.045 * s, 0.05 * s, 0.1 * s, 12), skin, 0, 1.53 * s, 0);
  const headY = 1.67 * s;
  add(g, new THREE.SphereGeometry(0.105 * s, 20, 16), skin, 0, headY, 0.005 * s, 0.9, 1.08, 1);

  // Hair / headwear.
  const hc = ap.hair_color;
  const cap = (r, sy) => add(g, new THREE.SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hc, 0, headY + 0.01 * s, -0.005 * s, 0.95, sy, 1.02);
  switch (ap.hair) {
    case "bald":
      break;
    case "long":
      cap(0.112 * s, 1.05);
      add(g, new THREE.BoxGeometry(0.2 * s, 0.32 * s, 0.07 * s), hc, 0, headY - 0.13 * s, -0.07 * s);
      break;
    case "bun":
      cap(0.11 * s, 1);
      add(g, new THREE.SphereGeometry(0.05 * s, 12, 10), hc, 0, headY + 0.06 * s, -0.1 * s);
      break;
    case "ponytail":
      cap(0.11 * s, 1);
      add(g, new THREE.CapsuleGeometry(0.03 * s, 0.18 * s, 4, 8), hc, 0, headY - 0.08 * s, -0.12 * s);
      break;
    case "curly":
      add(g, new THREE.IcosahedronGeometry(0.13 * s, 1), hc, 0, headY + 0.03 * s, -0.01 * s, 1, 0.9, 1);
      break;
    case "cap":
      cap(0.112 * s, 0.9);
      add(g, new THREE.BoxGeometry(0.16 * s, 0.015 * s, 0.1 * s), topCol, 0, headY + 0.03 * s, 0.11 * s);
      break;
    case "hat":
      add(g, new THREE.CylinderGeometry(0.2 * s, 0.2 * s, 0.015 * s, 24), hc, 0, headY + 0.06 * s, 0);
      add(g, new THREE.CylinderGeometry(0.1 * s, 0.11 * s, 0.11 * s, 20), hc, 0, headY + 0.12 * s, 0);
      break;
    default: // short
      cap(0.11 * s, 0.95);
  }

  // Limbs: pivot groups at shoulders/hips, with elbow/knee pivots so the walk bends naturally.
  const limb = (x, y, phase, upperLen, lowerLen, r, upperCol, lowerCol, endCol, isLeg) => {
    const root = new THREE.Group();
    root.position.set(x, y, 0);
    g.add(root);
    add(root, new THREE.CapsuleGeometry(r, upperLen, 4, 10), upperCol, 0, -upperLen / 2 - r * 0.5, 0);
    const joint = new THREE.Group();
    joint.position.y = -upperLen - r;
    root.add(joint);
    add(joint, new THREE.CapsuleGeometry(r * 0.85, lowerLen, 4, 10), lowerCol, 0, -lowerLen / 2 - r * 0.4, 0);
    if (isLeg) add(joint, new THREE.BoxGeometry(r * 2.1, r * 1.3, r * 3.6), endCol, 0, -lowerLen - r * 1.2, r * 0.9);
    else add(joint, new THREE.SphereGeometry(r * 1.05, 10, 8), endCol, 0, -lowerLen - r * 1.2, 0, 0.8, 1.1, 0.6);
    const side = x < 0 ? -1 : 1;
    g.userData.limbs.push({ pivot: root, phase, amp: isLeg ? 0.42 : 0.34, part: isLeg ? "hip" : "shoulder", side });
    g.userData.limbs.push({ pivot: joint, phase: phase + (isLeg ? Math.PI / 2 : 0), amp: isLeg ? 0.55 : 0.25,
      bend: isLeg ? 1 : -1, part: isLeg ? "knee" : "elbow", side });
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
