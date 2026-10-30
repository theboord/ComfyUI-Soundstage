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

// ------------------------------------------------------------------ sculpted hair
// Hair is modelled as clay would be: a shell over the skull whose thickness carries the volume, a defined hairline,
// a parting and clumped locks (grooves), plus hanging curtains for long hair. Everything is written at 1.8 m around
// the head centre; x is the figure's left, y up, z the face.
const HEAD_R = [0.0945, 0.1134, 0.105];   // the head ellipsoid's semi-axes
const HIDE = -0.012;                       // shell thickness where there's no hair: tucked under the scalp
const DEG = Math.PI / 180;
const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const table = (tab, v) => {
  if (v <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (v <= tab[i][0]) {
    const [x0, y0] = tab[i - 1], [x1, y1] = tab[i];
    return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
  }
  return tab[tab.length - 1][1];
};
const azDeg = (x, z) => Math.abs(Math.atan2(x, z)) / DEG;   // 0 = the face, 180 = the back

/** Outward triangles (optional) and smooth normals across UV seams and poles. */
function finishGeo(geo, orient) {
  const p = geo.attributes.position, P = p.array, idx = geo.index.array;
  if (orient) {
    let vol = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
        + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    if (vol < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  geo.computeVertexNormals();
  const n = geo.attributes.normal, groups = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const i of ids) { x += n.getX(i); y += n.getY(i); z += n.getZ(i); }
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) continue;
    for (const i of ids) n.setXYZ(i, x / l, y / l, z / l);
  }
  return geo;
}

/** A shell over the head: thick(x, y, z) of a unit direction gives the hair thickness there (HIDE = no hair). */
function headShell(thick, ws = 64, hs = 48) {
  const geo = new THREE.SphereGeometry(1, ws, hs);
  const p = geo.attributes.position, tv = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = (tv[i] = thick(x, y, z));
    const r = 1 / Math.hypot(x / HEAD_R[0], y / HEAD_R[1], z / HEAD_R[2]) + t;
    p.setXYZ(i, x * r, y * r, z * r);
  }
  // Triangles wholly under the scalp are never seen: drop them (about half the sphere).
  const idx = geo.index.array, keep = [];
  for (let i = 0; i < idx.length; i += 3) {
    if (tv[idx[i]] > -0.002 || tv[idx[i + 1]] > -0.002 || tv[idx[i + 2]] > -0.002) keep.push(idx[i], idx[i + 1], idx[i + 2]);
  }
  geo.setIndex(keep);
  return finishGeo(geo, false);
}

/**
 * A hanging curtain of hair: a closed band (lens cross-section) wrapped round the vertical axis at azimuth az ± span
 * (0 = the face, 180 = the back), from yTop down by len(a), with grooved locks on the outside and pointed tips.
 * a runs -1..1 across, t 0..1 down; rx/rz(t) are the wrap radii, th(t) the half thickness, w(t) narrows the span.
 */
function hairDrape(o, ws = 40, hs = 26) {
  const geo = new THREE.SphereGeometry(1, ws, hs);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const phi = uv.getX(i) * Math.PI * 2, t = 1 - uv.getY(i);
    const a = Math.cos(phi), b = Math.sin(phi);
    const ridge = Math.abs(Math.cos((o.locks * Math.PI * (a + 1)) / 2)) ** 0.7;
    const end = Math.min(1, Math.sin(Math.PI * t) * 4);                  // close the top and bottom to a thin edge
    const y = o.yTop - t * (o.len(a) + o.tip * ridge ** 3);
    const th = o.th(t) * end * (b > 0 ? 1 - o.groove * (1 - ridge) : 1);
    const az = (o.az + a * o.span * (o.w ? o.w(t) : 1)) * DEG;
    const off = b * th;
    p.setXYZ(i, (o.rx(t) + off) * Math.sin(az), y, (o.rz(t) + off) * Math.cos(az));
  }
  return finishGeo(geo, true);
}

/** Locks radiating from a whorl / tie point: ridge 1 on a lock, 0 in the groove between two. */
function radial(cx, cy, cz, n) {
  const w = new THREE.Vector3(cx, cy, cz).normalize();
  const e1 = new THREE.Vector3(0, 0, 1).cross(w);
  if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0);
  e1.normalize();
  const e2 = new THREE.Vector3().crossVectors(w, e1);
  return (x, y, z) => {
    const phi = Math.atan2(x * e2.x + y * e2.y + z * e2.z, x * e1.x + y * e1.y + z * e1.z);
    return [Math.abs(Math.cos((n * phi) / 2)) ** 0.7, sstep(0.96, 0.7, x * w.x + y * w.y + z * w.z)];
  };
}

// Where a cap's crown ends (unit-sphere height by azimuth) and where a hat presses the hair flat.
const CAP_TAB = [[0, 0.36], [50, 0.32], [90, 0.22], [130, 0.08], [180, 0.02]];
const CAP_EDGE = (A) => table(CAP_TAB, A);
const HAT_EDGE = () => 0.45;
const pressed = (T, y, A, compress) => (compress ? Math.min(T, y > compress(A) - 0.1 ? 0.01 : 0.017) : T);

/** Short cut: volume on top, a lifted front, a side parting, tapered sides and nape; ears and sideburns show. */
function shortShell({ female = false, child = false, compress = null } = {}) {
  const crown = radial(0.12, 0.78, -0.62, child ? 11 : 13);
  const front = female ? 0.4 : child ? 0.38 : 0.5;
  const tab = female
    ? [[0, front], [22, front + 0.03], [40, front], [54, 0.3], [64, 0.18], [74, 0.0], [84, 0.12], [104, 0.18], [116, -0.1], [140, -0.5], [180, -0.7]]
    : [[0, front], [22, front + 0.02], [40, front - 0.02], [54, 0.34], [64, 0.12], [72, -0.1], [80, -0.08], [85, 0.25],
      [104, 0.26], [114, 0.02], [128, -0.3], [150, -0.5], [180, -0.56]];
  return (x, y, z) => {
    const A = azDeg(x, z);
    const [ridge, fade] = crown(x, y, z);
    const hl = table(tab, A) - (female || child ? 0.1 : 0.06) * ridge ** 3 * sstep(58, 20, A);   // fringe breaks into locks
    let T = 0.01 + 0.024 * sstep(0.05, 0.85, y) + 0.012 * sstep(0.25, 0.7, z) * sstep(0.35, 0.8, y);
    T -= 0.004 * sstep(-0.1, -0.5, y);
    T -= 0.01 * Math.exp(-(((x + 0.34) / 0.08) ** 2)) * sstep(-0.5, 0.1, z) * sstep(0.4, 0.62, y);   // parting
    T *= 1 - 0.38 * fade * (1 - ridge);
    T = pressed(T, y, A, compress);
    const m = sstep(hl - 0.035, hl + 0.035, y);
    return HIDE + (T - HIDE) * m;
  };
}

/** Long hair over the skull: crown volume, a parting, a side-swept fringe, fuller towards the bottom; ears covered. */
function longShell(compress) {
  return (x, y, z) => {
    const A = azDeg(x, z);
    let hl = table([[0, 0.56], [20, 0.6], [34, 0.5], [46, 0.25], [54, -1.5]], A);
    if (A < 46) hl = Math.max(0.33, hl - 0.24 * sstep(0.3, -0.3, x));                       // the fringe sweeps across
    let T = 0.02 + 0.014 * sstep(0.2, 0.9, y) + 0.012 * sstep(0.1, -0.7, z) * sstep(0.7, 0, y) + 0.012 * sstep(0.1, -0.8, y);
    T -= 0.012 * Math.exp(-(((x - 0.28) / 0.08) ** 2)) * sstep(-0.6, 0.2, z) * sstep(0.45, 0.7, y);   // parting
    T += 0.006 * sstep(0.3, -0.3, x) * sstep(40, 10, A) * sstep(0.75, 0.45, y);
    const strands = Math.abs(Math.cos(13 * Math.atan2(x, z))) ** 0.7;
    T *= 1 - 0.3 * sstep(0.92, 0.55, y) * (1 - strands);
    T = pressed(T, y, A, compress);
    const m = sstep(hl - 0.035, hl + 0.035, y);
    return HIDE + (T - HIDE) * m;
  };
}

/** Hair pulled back to a tie (ponytail, bun): close to the head, combed towards the tie. */
function slickShell(tieY) {
  const tie = radial(0, tieY, -1, 16);
  const tab = [[0, 0.55], [30, 0.5], [50, 0.38], [62, 0.2], [74, 0.0], [84, 0.2], [104, 0.22], [116, -0.1], [140, -0.5], [180, -0.62]];
  return (x, y, z) => {
    const A = azDeg(x, z);
    const [ridge, fade] = tie(x, y, z);
    const T = (0.011 + 0.01 * sstep(0.2, 0.9, y)) * (1 - 0.4 * fade * (1 - ridge));
    const m = sstep(table(tab, A) - 0.03, table(tab, A) + 0.03, y);
    return HIDE + (T - HIDE) * m;
  };
}

const CURLS = Array.from({ length: 110 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 110, r = Math.sqrt(1 - y * y), th = i * 2.399963;
  return [r * Math.cos(th), y, r * Math.sin(th)];
});
/** Curly: a full rounded mass of curls (bigger and down to the jaw for women). */
function curlyShell(female) {
  const c0 = Math.cos(0.24);
  const tab = female ? [[0, 0.48], [30, 0.45], [48, 0.2], [58, -0.5], [90, -0.6], [180, -0.85]]
    : [[0, 0.46], [35, 0.42], [55, 0.3], [70, 0.15], [85, 0.24], [105, 0.24], [125, -0.2], [180, -0.5]];
  return (x, y, z) => {
    const A = azDeg(x, z);
    let b = 0;
    for (const p of CURLS) {
      const c = x * p[0] + y * p[1] + z * p[2];
      if (c > c0) { const f = (c - c0) / (1 - c0); b = Math.max(b, f * f * (3 - 2 * f)); }
    }
    let T = (female ? 0.034 : 0.022) + (female ? 0.016 : 0.012) * sstep(0, 0.8, y) + 0.016 * b;
    if (female) T += 0.012 * sstep(0.2, -0.6, y);
    const hl = table(tab, A);
    return HIDE + (T - HIDE) * sstep(hl - 0.04, hl + 0.03, y);
  };
}

/** A baseball cap's crown: six panels, a crisp edge above the ears. */
function capShell(x, y, z) {
  const az = Math.atan2(x, z), e = CAP_EDGE(Math.abs(az) / DEG);
  let T = 0.026 + 0.006 * sstep(0.3, 0.9, y);
  T -= 0.004 * Math.exp(-((Math.sin(3 * az) / 0.1) ** 2)) * sstep(0.95, 0.7, y) * sstep(e + 0.02, e + 0.12, y);
  return HIDE + (T - HIDE) * sstep(e - 0.02, e + 0.02, y);
}

/** Long hair down the back, past the shoulder blades, standing off the chest so it never sinks into the back. */
function backFall(torsoBack) {
  const rzLow = Math.max(0.12, torsoBack + 0.032), rxLow = rzLow * 1.12;
  return { az: 180, span: 60, yTop: 0, len: (a) => 0.44 - 0.07 * a * a, locks: 7, groove: 0.4, tip: 0.04,
    rx: (t) => 0.082 + (rxLow - 0.082) * sstep(0.08, 0.42, t), rz: (t) => 0.098 + (rzLow - 0.098) * sstep(0.12, 0.42, t),
    th: (t) => 0.008 + 0.016 * Math.sin(Math.PI * t ** 0.8) };
}
/** Hair framing the face on one side (side = +1 the figure's left), down to the shoulders. */
function sideLock(side) {
  return { az: side * 84, span: 24, yTop: 0, len: (a) => 0.14 + 0.015 * a * side, locks: 3, groove: 0.35, tip: 0.025,
    rx: (t) => 0.098 + 0.012 * t, rz: (t) => 0.098 + 0.012 * t, th: (t) => 0.008 + 0.012 * Math.sin(Math.PI * t ** 0.7) };
}

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
  // Rounded shoulders: a low yoke over the flat top of the torso and deltoid caps, so the clay doesn't read as a can.
  U(new THREE.SphereGeometry(shoulderR, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2), topCol, 0, 1.496 * s, -0.01 * s, 1, 0.13, 0.62);
  for (const sx of [-1, 1]) U(new THREE.SphereGeometry(0.056 * bw * s, 14, 10), topCol, sx * (shoulderR + 0.014 * s), 1.468 * s, 0, 1, 0.95, 0.9);
  if (female && ap.top !== "uniform") {
    for (const sx of [-1, 1]) U(new THREE.SphereGeometry(0.05 * s * bw, 14, 10), topCol, sx * 0.036 * s * bw, 1.325 * s, 0.064 * s * bw, 1.05, 0.9, 0.72);
  }
  // Long garments: coat hem, dress, skirt.
  if (ap.top === "coat") add(g, new THREE.CylinderGeometry(waistR * 1.05, waistR * 1.45, 0.42 * s, 20), topCol, 0, 0.86 * s, 0, 1, 1, 0.7);
  if (ap.top === "suit" || ap.top === "jacket") add(g, new THREE.CylinderGeometry(waistR * 1.02, waistR * 1.1, 0.12 * s, 20), topCol, 0, 0.93 * s, 0, 1, 1, 0.68);
  if (ap.top === "dress") add(g, new THREE.ConeGeometry(waistR * 2.1, 0.5 * s, 22, 1, true), topCol, 0, 0.72 * s, 0, 1, 1, 0.8);
  if (ap.bottom === "skirt" && ap.top !== "dress") add(g, new THREE.ConeGeometry(waistR * 1.9, 0.34 * s, 22, 1, true), botCol, 0, 0.8 * s, 0, 1, 1, 0.8);
  if (ap.top === "hoodie") U(new THREE.TorusGeometry(0.1 * s, 0.035 * s, 8, 16), topCol, 0, 1.5 * s, -0.04 * s, 1, 1, 0.8);

  // Neck and head. No eyes or mouth (previz stays anonymous), but a brow, nose, jaw, chin and ears, so a head turn
  // reads in the clay and the video model can follow which way someone is looking.
  N(new THREE.CylinderGeometry(0.045 * s, 0.05 * s, 0.1 * s, 12), skin, 0, 1.53 * s, 0);
  const hk = kind === "child" ? 1.1 : 1;                  // children: a bigger head for their height, crown kept in place
  const k = s * hk;
  const headY = (1.67 + HEAD_R[1] * (1 - hk)) * s;
  // F: a head part written at 1.8 m around the head centre, scaled into place.
  const F = (geom, color, x, y, z, sx = 1, sy = 1, sz = 1) => H(geom, color, x * k, headY + y * k, z * k, sx * k, sy * k, sz * k);
  F(new THREE.SphereGeometry(0.105, 28, 20), skin, 0, 0, 0.005, 0.9, 1.08, 1);
  F(new THREE.SphereGeometry(0.06, 18, 8), skin, 0, 0.03, 0.086, 1.15, female ? 0.18 : 0.23, 0.34);                // brow ridge
  F(new THREE.SphereGeometry(0.016, 12, 10), skin, 0, -0.008, 0.1, 0.75, 1.65, 0.95).rotation.x = -0.32;        // nose bridge
  F(new THREE.SphereGeometry(0.013, 10, 8), skin, 0, -0.03, 0.106);                                             // nose tip
  F(new THREE.SphereGeometry(0.05, 16, 12), skin, 0, -0.066, 0.04, female ? 1.15 : 1.32, 0.78, 0.95);            // jaw
  F(new THREE.SphereGeometry(female ? 0.017 : 0.02, 12, 10), skin, 0, -0.084, 0.062, 1.3, 0.85, 0.85);           // chin
  for (const ex of [-1, 1]) F(new THREE.SphereGeometry(0.024, 10, 8), skin, ex * 0.095, -0.005, -0.005, 0.45, 1, 0.8);

  // Hair and headwear: sculpted shells over the skull (volume, a hairline, a parting, clumped locks) plus hanging
  // hair, so it reads as hair in the grey clay pass from any angle, not as a skull cap. Long hair below the head
  // hangs from the NECK, so it stays on the back when the head turns instead of swinging through the shoulders.
  const hc = ap.hair_color;
  const style = ap.hair;
  const torsoBack = (shoulderR / s) * 0.62;                 // the back of the chest, for hair falling down the back
  const shell = (fn, col = hc) => { const m = F(headShell(fn), col, 0, 0, 0.005); m.userData.part = "hair"; return m; };
  const hang = (o, col = hc, onNeck = true) => {
    const geo = hairDrape(o);
    const m = onNeck ? N(geo, col, 0, headY, 0.005 * k, k, k, k) : F(geo, col, 0, 0, 0.005);
    m.userData.part = "hair";
    return m;
  };
  const longHair = (col, compress) => {
    shell(longShell(compress), col);
    hang(backFall(torsoBack), col);
    for (const side of [-1, 1]) hang(sideLock(side), col, false);
  };
  // Under a hat the hair is pressed flat; for a hat the colour picker colours the hat, so the hair keeps the default.
  const underCol = (DEFAULT_APPEARANCE[kind] || DEFAULT_APPEARANCE.man).hair_color;
  switch (style) {
    case "bald":
      break;
    case "long":
      longHair(hc, 0);
      break;
    case "bun": {
      shell(slickShell(0.3));
      const bun = F(new THREE.TorusGeometry(0.03, 0.021, 10, 20), hc, 0, 0.075, -0.112, 1, 1, 0.9);
      bun.rotation.x = -0.5;
      F(new THREE.SphereGeometry(0.034, 14, 10), hc, 0, 0.078, -0.118, 1, 1, 0.9);
      break;
    }
    case "ponytail":
      shell(slickShell(-0.05));
      hang({ az: 180, span: 13, yTop: 0.03, len: () => 0.3, rx: (t) => 0.125 + 0.02 * Math.sin(Math.PI * t * 0.8), rz: (t) => 0.125 + 0.02 * Math.sin(Math.PI * t * 0.8),
        th: (t) => 0.024 * (1 - 0.55 * t), w: (t) => 1 - 0.45 * t * t, locks: 4, groove: 0.35, tip: 0.03 }, hc, false);
      break;
    case "curly":
      shell(curlyShell(female));
      break;
    case "cap": {
      if (female) longHair(hc, CAP_EDGE); else shell(shortShell({ female, child: kind === "child", compress: CAP_EDGE }));
      shell(capShell, topCol);
      const brim = F(new THREE.CylinderGeometry(0.11, 0.11, 0.011, 24, 1, false, -Math.PI / 2, Math.PI), topCol, 0, 0.04, 0.07, 1, 1, 1.15);
      brim.rotation.x = 0.14;
      F(new THREE.SphereGeometry(0.009, 8, 6), topCol, 0, 0.148, -0.01);                       // the button on top
      break;
    }
    case "hat":
      if (female) longHair(underCol, HAT_EDGE); else shell(shortShell({ female, child: kind === "child", compress: HAT_EDGE }), underCol);
      F(new THREE.CylinderGeometry(0.2, 0.2, 0.015, 32), hc, 0, 0.06, 0);
      F(new THREE.CylinderGeometry(0.098, 0.112, 0.11, 24), hc, 0, 0.12, 0);
      F(new THREE.CylinderGeometry(0.113, 0.113, 0.022, 24), hc, 0, 0.078, 0, 1, 1, 1);           // band
      break;
    default: // short
      shell(shortShell({ female, child: kind === "child" }));
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

/** The inverse of applyJoints for one joint: its current rotation as plain-word degrees [a, b, c] (posing in 3D). */
export function jointDegrees(j) {
  const R = 180 / Math.PI, sd = j.userData.side || 1;
  const e = new THREE.Euler().setFromQuaternion(j.quaternion, "XYZ");
  let x = e.x * R, y = e.y * R, z = e.z * R;
  // XYZ angles have a twin (x+180, 180-y, z+180) for the same rotation: keep the smaller one, so a pose dragged in 3D
  // reads like a slider pose (-13°, not -167° with a 180° flip) and blends cleanly between keys.
  const wrap = (v) => ((v + 540) % 360) - 180;
  const alt = [wrap(x + 180), wrap(180 - y), wrap(z + 180)];
  if (Math.abs(alt[0]) + Math.abs(alt[1]) + Math.abs(alt[2]) < Math.abs(x) + Math.abs(y) + Math.abs(z) - 1e-6) [x, y, z] = alt;
  switch (j.userData.jkind) {
    case "trunk": return [x, y, -z];
    case "shoulder": case "wrist": case "hip": return [-x, sd * z, sd * y];
    case "elbow": return [-x, sd * y, 0];
    case "knee": return [x, 0, 0];
    case "finger": {
      const rest = (j.userData.rest || [0, 0, 0])[0] * R, thumb = j.userData.finger === "thumb";
      const a = -z / sd / (thumb ? 0.5 : 1);
      return [a, rest - x - (thumb ? a * 0.6 : 0), 0];
    }
    default: return [0, 0, 0];
  }
}
