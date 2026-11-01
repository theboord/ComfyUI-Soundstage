// Presets (Milestone 17): the looping card previews. Each is a tiny clay set drawn on a 2D canvas through the preset's
// own numbers: a camera card flies the real keys cameraKeys() writes, a stunt card drives the real stuntKeys(), a
// grade card shows the grade, an edit card the clip pacing. Cheap enough to loop a dozen at once; no WebGL.
//
//   drawThumb(ctx, preset, t, w, h, extra)   t = seconds since the panel opened; extra = { palettes, setups }
import { cameraKeys, userCameraKeys, yaw } from "./engine.mjs";
import { stuntKeys } from "../stage/stunts.mjs";

const D2R = Math.PI / 180;
const LOOP = 3.2;                       // seconds per loop
const K0 = { position: [0, 1.6, -5.2], target: [0, 1.15, 0], focal_mm: 32 };
const CLAY = [186, 178, 168];

const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const rgb = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [120, 120, 120]; };
const mixc = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
/** A deterministic wobble (handheld, flicker): sum of sines. */
const wob = (t, s = 1) => Math.sin(t * 7.1 * s) * 0.5 + Math.sin(t * 13.7 * s + 1.3) * 0.3 + Math.sin(t * 3.3 * s + 2.1) * 0.2;

/** The camera at frame f of keys (smoothstep between keys, like the stage). */
export function camAt(keys, f) {
  if (!keys.length) return K0;
  if (f <= keys[0].frame) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (f <= b.frame) {
      const u = smooth((f - a.frame) / Math.max(1e-6, b.frame - a.frame));
      return { position: lerp3(a.position, b.position, u), target: lerp3(a.target, b.target, u), focal_mm: lerp(a.focal_mm || 32, b.focal_mm || 32, u) };
    }
  }
  return keys[keys.length - 1];
}

/** A pinhole projector for a 2D canvas: world point -> [x, y, depth] (null behind the camera). */
export function projector(cam, w, h) {
  const p = cam.position, t = cam.target;
  let f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
  const fl = Math.hypot(...f) || 1; f = f.map((v) => v / fl);
  let r = [f[2], 0, -f[0]]; const rl = Math.hypot(...r) || 1; r = r.map((v) => v / rl);
  if (Math.abs(f[1]) > 0.999) r = [1, 0, 0];
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];   // up = forward x right
  const vfov = 2 * Math.atan(12 / (cam.focal_mm || 32));
  const s = (h / 2) / Math.tan(vfov / 2);
  return (q) => {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
    if (z < 0.05) return null;
    // Right-handed with +X to the camera's left in stage space, so screen x is flipped.
    return [w / 2 - (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z * s, h / 2 - (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z * s, z, s / z];
  };
}

// --------------------------------------------------------------------------------------------- the clay set

function box(c, P, ctr, size, col, light) {
  const [cx, cy, cz] = ctr, [sx, sy, sz] = size.map((v) => v / 2);
  const V = [];
  for (const x of [-sx, sx]) for (const y of [0, sy * 2]) for (const z of [-sz, sz]) V.push([cx + x, cy + y, cz + z]);
  const faces = [[0, 1, 3, 2, -1, 0, 0], [4, 5, 7, 6, 1, 0, 0], [0, 1, 5, 4, 0, 0, -1], [2, 3, 7, 6, 0, 0, 1], [1, 3, 7, 5, 0, 1, 0]];
  const out = [];
  for (const [a, b, d, e, nx, ny, nz] of faces) {
    const q = [a, b, d, e].map((i) => P(V[i]));
    if (q.some((x) => !x)) continue;
    const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
    const depth = q.reduce((s, x) => s + x[2], 0) / 4;
    const lit = Math.max(0.35, 0.55 + 0.45 * (nx * light[0] + ny * light[1] + nz * light[2]));
    out.push({ depth, area, draw: () => { c.fillStyle = rgb(col, lit); c.beginPath(); q.forEach((x, i) => (i ? c.lineTo(x[0], x[1]) : c.moveTo(x[0], x[1]))); c.closePath(); c.fill(); } });
  }
  return out;
}

function figure(c, P, pos, col, light, rim = null, heading = 0) {
  const parts = [];
  const spheres = [[0, 0.25, 0.17], [0, 0.6, 0.2], [0, 0.95, 0.22], [0, 1.25, 0.24], [0, 1.62, 0.15]];
  for (const [dx, y, rad] of spheres) {
    const q = P([pos[0] + dx, pos[1] + y, pos[2]]);
    if (!q) continue;
    const R = rad * q[3];
    parts.push({ depth: q[2] - 0.01, draw: () => {
      const g = c.createRadialGradient(q[0] + light[0] * R * 0.5, q[1] - R * 0.4, R * 0.1, q[0], q[1], R);
      g.addColorStop(0, rgb(col, 1.08)); g.addColorStop(1, rgb(col, 0.55));
      c.fillStyle = g; c.beginPath(); c.arc(q[0], q[1], R, 0, Math.PI * 2); c.fill();
      if (rim) { c.strokeStyle = rim; c.lineWidth = Math.max(1, R * 0.18); c.beginPath(); c.arc(q[0], q[1], R * 0.92, -Math.PI * 0.9, -Math.PI * 0.1); c.stroke(); }
    } });
  }
  // A nose so the turn reads.
  const n = P([pos[0] + Math.sin(heading) * 0.16, pos[1] + 1.62, pos[2] + Math.cos(heading) * 0.16]);
  if (n) parts.push({ depth: n[2] - 0.02, draw: () => { c.fillStyle = rgb(col, 0.7); c.beginPath(); c.arc(n[0], n[1], Math.max(1, 0.05 * n[3]), 0, 7); c.fill(); } });
  return parts;
}

function drawSet(c, cam, w, h, o = {}) {
  const P = projector(cam, w, h);
  const sky = o.sky || ["#3a3346", "#211927"];
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  // The floor: a far quad, then grid lines.
  const far = 60, fz = o.scroll || 0;
  const floor = [[-far, 0, -far], [far, 0, -far], [far, 0, far], [-far, 0, far]].map(P);
  c.fillStyle = o.floor || "#2c2533";
  if (floor.every(Boolean)) { c.beginPath(); floor.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.fill(); }
  else { const hz = P([cam.position[0], 0, cam.position[2] + 1000]); c.fillRect(0, hz ? hz[1] : h / 2, w, h); }
  c.strokeStyle = o.grid || "rgba(255,255,255,0.09)"; c.lineWidth = 1;
  const seg = (a, b) => {
    // Clip to in front of the camera by sampling (enough for a thumbnail).
    let prev = null;
    c.beginPath();
    for (let i = 0; i <= 16; i++) {
      const q = P(lerp3(a, b, i / 16));
      if (q && prev) c.lineTo(q[0], q[1]); else if (q) c.moveTo(q[0], q[1]);
      prev = q;
    }
    c.stroke();
  };
  for (let x = -12; x <= 12; x += 2) seg([x, 0, -14], [x, 0, 22]);
  for (let z = -14; z <= 22; z += 2) { const zz = z - (fz % 2); seg([-12, 0, zz], [12, 0, zz]); }
  const light = o.light || [0.5, 0.7, -0.4];
  const items = [];
  const sc = o.scroll || 0;
  items.push(...box(c, P, [-3.2, 0, 6 - sc], [1.6, 3.2, 1.6], o.blockCol || [120, 112, 128], light));
  items.push(...box(c, P, [3, 0, 9 - sc], [2.2, 2.2, 2.2], o.blockCol || [120, 112, 128], light));
  items.push(...box(c, P, [-0.6, 0, 14 - sc], [3, 5, 1.2], o.blockCol || [104, 98, 112], light));
  for (const it of o.extra || []) items.push(...(it.kind === "box" ? box(c, P, it.at, it.size, it.col || CLAY, light) : figure(c, P, it.at, it.col || CLAY, light, it.rim, it.heading || 0)));
  if (o.car) items.push(...box(c, P, [o.car[0], 0.25, o.car[2]], [1.8, 1.0, 4.2], [168, 64, 58], light), ...box(c, P, [o.car[0], 1.25, o.car[2] - 0.3], [1.6, 0.55, 2.0], [140, 52, 48], light));
  if (!o.noFigure) items.push(...figure(c, P, o.figure || [0, 0, 0], o.clay || CLAY, light, o.rim || null, o.heading || 0));
  items.sort((a, b) => b.depth - a.depth).forEach((x) => x.draw());
  return P;
}

// --------------------------------------------------------------------------------------------- per tab

function camThumb(c, p, t, w, h) {
  const spec = p.apply?.camera || {};
  const u = (t % LOOP) / LOOP, f = Math.min(1, u / 0.85) * 48;
  if (p.apply?.user_camera) { const keys = userCameraKeys(K0, p.apply.user_camera); const last = keys[keys.length - 1]?.frame || 48; drawSet(c, camAt(keys, Math.min(1, u / 0.85) * last), w, h); return; }
  if (spec.move === "follow") {
    const z = -1 + f * 0.08, local = [-0.45, 1.62, -2.4];
    const cam = { position: [local[0] + wob(t) * 0.04, local[1] + wob(t, 1.7) * 0.04, z + local[2]], target: [wob(t, 0.6) * 0.1, 1.4, z + 3], focal_mm: 30 };
    drawSet(c, cam, w, h, { figure: [0, 0, z + Math.abs(Math.sin(t * 9)) * 0.0] });
    return;
  }
  if (spec.move === "car_mount") {
    // On the hood, looking back through the windscreen at both front seats; the street runs away behind the car.
    c.fillStyle = "#2a2433"; c.fillRect(0, 0, w, h);
    const hz = h * 0.42;
    c.fillStyle = "#3a3346"; c.fillRect(0, 0, w, hz);
    c.strokeStyle = "rgba(255,255,255,.12)"; c.lineWidth = 1;
    for (let i = 0; i < 9; i++) { const z = ((i + t * 2.5) % 9) / 9; const y = hz + (1 - z) * (h * 0.2); c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    // The cabin: a windscreen frame, two clay people in their seats.
    c.fillStyle = "rgba(20,16,24,.92)";
    c.beginPath(); c.moveTo(w * 0.08, h * 0.95); c.lineTo(w * 0.2, h * 0.18); c.lineTo(w * 0.8, h * 0.18); c.lineTo(w * 0.92, h * 0.95); c.lineTo(w, h * 0.95); c.lineTo(w, 0); c.lineTo(0, 0); c.lineTo(0, h * 0.95); c.fill();
    const bob = wob(t, 2) * h * 0.006;
    for (const [x, s] of [[0.36, 1], [0.64, 0.95]]) {
      c.fillStyle = "rgb(186,178,168)";
      c.beginPath(); c.arc(w * x, h * 0.42 + bob, h * 0.09 * s, 0, 7); c.fill();
      c.beginPath(); c.ellipse(w * x, h * 0.78 + bob, h * 0.17 * s, h * 0.24 * s, 0, 0, 7); c.fill();
    }
    c.fillStyle = "rgb(120,44,40)"; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.9); c.quadraticCurveTo(w / 2, h * 0.84, w, h * 0.9); c.lineTo(w, h); c.fill();
    return;
  }
  const plan = cameraKeys(K0, spec, 48);
  let cam = camAt(plan?.keys || [], f);
  if (p.apply?.rig === "drone") cam = { ...cam, position: [cam.position[0] + wob(t, 0.5) * 0.05, cam.position[1], cam.position[2]] };
  drawSet(c, cam, w, h);
}

const SKY = {
  golden_hour: ["#f3a35d", "#5a3a52"], blue_hour: ["#2b4f8f", "#121a33"], night_street: ["#141a2c", "#0b0c14"],
  noir_hard_key: ["#202020", "#080808"], neon_night: ["#2a1340", "#0c0a1a"], overcast: ["#a9adb3", "#6c7077"],
  candle_firelight: ["#1a100a", "#070403"], studio_three_point: ["#3d3a40", "#1f1c22"],
};
const KEYC = {
  golden_hour: [255, 196, 140], blue_hour: [150, 180, 235], night_street: [255, 178, 96], noir_hard_key: [230, 230, 230],
  neon_night: [240, 90, 200], overcast: [205, 208, 212], candle_firelight: [255, 150, 70], studio_three_point: [240, 236, 228],
};

function lightThumb(c, p, t, w, h) {
  const id = p.id;
  const ang = Math.sin((t / LOOP) * Math.PI * 2) * 12;
  const cam = { position: yaw(K0.position, K0.target, ang), target: K0.target, focal_mm: 34 };
  let key = KEYC[id] || [220, 210, 200], rim = null;
  if (id === "candle_firelight") key = mixc([255, 120, 50], [255, 180, 90], 0.5 + 0.5 * wob(t * 2));
  if (id === "neon_night") { const s = 0.5 + 0.5 * Math.sin(t * 2.4); key = mixc([240, 80, 200], [80, 220, 255], s); rim = `rgba(${s > 0.5 ? "240,80,200" : "80,220,255"},.9)`; }
  if (id === "golden_hour") rim = "rgba(255,210,140,.95)";
  if (id === "night_street" || id === "noir_hard_key") rim = "rgba(190,210,255,.8)";
  if (id === "studio_three_point") rim = "rgba(255,255,255,.8)";
  const user = p.apply?.user_light?.lighting;
  const sky = user ? (SKY[user.preset] || SKY.studio_three_point) : (SKY[id] || SKY.studio_three_point);
  drawSet(c, cam, w, h, { sky, floor: id === "overcast" ? "#5d6067" : "#1e1922", clay: key.map((v, i) => v * 0.55 + CLAY[i] * 0.25), rim,
    light: id === "noir_hard_key" ? [0.9, 0.3, 0.2] : [0.5, 0.7, -0.4], blockCol: id === "overcast" ? [140, 140, 146] : [70, 64, 78] });
  if (id === "noir_hard_key") {   // venetian blinds
    c.fillStyle = "rgba(0,0,0,.42)";
    for (let y = 0; y < h; y += 7) c.fillRect(0, y + ((t * 4) % 7), w, 3);
  }
  if (id === "golden_hour") { const g = c.createRadialGradient(w * 0.82, h * 0.32, 1, w * 0.82, h * 0.32, w * 0.5); g.addColorStop(0, "rgba(255,220,150,.55)"); g.addColorStop(1, "rgba(255,220,150,0)"); c.fillStyle = g; c.fillRect(0, 0, w, h); }
}

function lookThumb(c, p, t, w, h, extra) {
  const lk = p.apply?.user_look || {};
  const pal = (extra?.palettes || []).find((x) => x.id === (p.apply?.palette || lk.palette?.preset));
  const sw = (pal?.swatches?.length ? pal.swatches : lk.palette?.swatches?.length ? lk.palette.swatches : ["#6b5f73", "#3a3346", "#c9b8a6"]).map(hex);
  const g = p.apply?.grade || lk.grade || {};
  const cam = { position: yaw(K0.position, K0.target, 8 * Math.sin(t * 0.8)), target: K0.target, focal_mm: p.apply?.focal_mm || 35 };
  drawSet(c, cam, w, h, { sky: [rgb(sw[0]), rgb(sw[1] || sw[0], 0.5)], clay: mixc(CLAY, sw[2] || sw[0], 0.35), blockCol: mixc([100, 96, 108], sw[1] || sw[0], 0.4) });
  // The grade as cheap overlays (a canvas filter is slow on software GL): warmth tint, colour drained, contrast.
  const warm = g.warmth || 0, sat = g.saturation || 0, con = g.contrast || 0;
  if (warm) { c.fillStyle = warm > 0 ? `rgba(255,150,60,${Math.min(0.3, warm * 0.3)})` : `rgba(60,120,255,${Math.min(0.3, -warm * 0.3)})`; c.fillRect(0, 0, w, h); }
  if (sat < 0) { c.globalCompositeOperation = "saturation"; c.fillStyle = `rgba(128,128,128,${Math.min(1, -sat)})`; c.fillRect(0, 0, w, h); c.globalCompositeOperation = "source-over"; }
  if (con > 0) { c.fillStyle = `rgba(0,0,0,${Math.min(0.25, con * 0.25)})`; c.fillRect(0, h * 0.55, w, h * 0.45); }
  if ((g.vignette || 0) > 0) { const v = c.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.62); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(0,0,0,${Math.min(0.75, g.vignette)})`); c.fillStyle = v; c.fillRect(0, 0, w, h); }
  const grain = Math.max(0.04, g.grain || 0);
  let seed = Math.floor(t * 24) * 9301;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  c.fillStyle = `rgba(255,255,255,${0.05 + grain * 0.12})`;
  for (let i = 0; i < 90 * grain + 20; i++) c.fillRect(rnd() * w, rnd() * h, 1, 1);
  // The palette strip.
  const bw = w / sw.length;
  sw.forEach((s, i) => { c.fillStyle = rgb(s); c.fillRect(i * bw, h - 6, bw + 1, 6); });
}

/** Top-down: a car driving its stunt keys (or the crate crash), with its trail. */
function actionThumb(c, p, t, w, h) {
  c.fillStyle = "#1f1924"; c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(255,255,255,.06)";
  for (let x = 0; x < w; x += 10) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 10) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const u = (t % (LOOP * 1.25)) / (LOOP * 1.25);
  const a = p.apply || {};
  if (a.stunt) {
    const keys = stuntKeys(a.stunt, { start: [0, 0, -9], dirDeg: 0, last: 96, fps: 24 }) || [];
    const xs = keys.map((k) => k.position[0]), zs = keys.map((k) => k.position[2]);
    const minx = Math.min(...xs), maxx = Math.max(...xs), minz = Math.min(...zs), maxz = Math.max(...zs);
    const sc = Math.min((w - 20) / Math.max(4, maxx - minx), (h - 16) / Math.max(4, maxz - minz));
    const toS = (x, z) => [w / 2 + (x - (minx + maxx) / 2) * sc, h / 2 - (z - (minz + maxz) / 2) * sc];
    const f = u * 96;
    c.strokeStyle = "rgba(242,255,89,.35)"; c.lineWidth = 1.5; c.beginPath();
    keys.forEach((k, i) => { const q = toS(k.position[0], k.position[2]); if (k.frame <= f) (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); });
    c.stroke();
    let i = keys.findIndex((k) => k.frame >= f); if (i < 1) i = 1;
    const k0 = keys[i - 1], k1 = keys[i] || k0, v = Math.max(0, Math.min(1, (f - k0.frame) / Math.max(1, k1.frame - k0.frame)));
    const x = lerp(k0.position[0], k1.position[0], v), z = lerp(k0.position[2], k1.position[2], v), hd = lerp(k0.heading_deg || 0, k1.heading_deg || 0, v);
    const smoke = lerp(k0.fx?.tire_smoke || 0, k1.fx?.tire_smoke || 0, v);
    const q = toS(x, z);
    if (smoke > 0.05) { c.fillStyle = `rgba(220,220,220,${0.25 * smoke})`; c.beginPath(); c.arc(q[0], q[1], 9 + 5 * smoke, 0, 7); c.fill(); }
    c.save(); c.translate(q[0], q[1]); c.rotate(hd * D2R);
    c.fillStyle = "#c4473f"; c.fillRect(-4, -8, 8, 16); c.fillStyle = "#f2ff59"; c.fillRect(-3, -9, 6, 2);
    c.restore();
    return;
  }
  // Side views for physics and mounting.
  c.fillStyle = "#2c2533"; c.fillRect(0, h * 0.78, w, h * 0.22);
  const gy = h * 0.78, S = h / 5;
  const crate = (x, y, s = S * 0.8, rot = 0) => { c.save(); c.translate(x, y - s / 2); c.rotate(rot); c.fillStyle = "#a7814f"; c.fillRect(-s / 2, -s / 2, s, s); c.strokeStyle = "rgba(0,0,0,.35)"; c.strokeRect(-s / 2, -s / 2, s, s); c.restore(); };
  const person = (x, y, s = S) => { c.fillStyle = "rgb(186,178,168)"; c.beginPath(); c.arc(x, y - s * 1.65, s * 0.17, 0, 7); c.fill(); c.fillRect(x - s * 0.16, y - s * 1.45, s * 0.32, s * 0.85); c.fillRect(x - s * 0.13, y - s * 0.62, s * 0.1, s * 0.62); c.fillRect(x + s * 0.03, y - s * 0.62, s * 0.1, s * 0.62); };
  if (a.physics === "drop") {
    const tt = u * 1.6, g = 9.8 * S;
    let y = gy - 2.5 * S + 0.5 * g * tt * tt * 0.25, vy = 0;
    if (y > gy) { const t0 = Math.sqrt((2.5 * S) / (0.5 * g * 0.25)); const dt = tt - t0; const v0 = g * 0.5 * t0 * 0.35; y = gy - Math.max(0, v0 * dt - 0.5 * g * 0.25 * dt * dt); vy = 1; }
    crate(w / 2, Math.min(gy, y), S * 0.8, vy ? 0.1 : 0);
  } else if (a.physics === "throw") {
    person(w * 0.25, gy);
    const tt = u * 1.4;
    const x = w * 0.3 + tt * w * 0.45, y = gy - S * 1.3 - (2.2 * tt - 4.9 * tt * tt * 0.6) * S;
    crate(Math.min(w * 0.85, x), Math.min(gy, y), S * 0.45, tt * 4);
  } else if (a.physics === "crate_crash") {
    const carX = -w * 0.2 + u * w * 1.3;
    const hit = w * 0.55;
    for (let i = 0; i < 6; i++) {
      const row = i < 3 ? 0 : i < 5 ? 1 : 2, col = i < 3 ? i - 1 : i < 5 ? i - 3.5 : 0;
      let x = hit + col * S * 0.85, y = gy - row * S * 0.82, r = 0;
      if (carX + S * 1.4 > hit) { const dt = (carX + S * 1.4 - hit) / w * 2.2; x += dt * w * (0.4 + i * 0.07); y -= (dt * 2.5 - dt * dt * 3.2) * S * (1 + row); y = Math.min(gy, y); r = dt * (3 + i); }
      crate(x, y, S * 0.8, r);
    }
    c.fillStyle = "#c4473f"; c.fillRect(carX - S * 1.4, gy - S * 0.9, S * 2.8, S * 0.6); c.fillRect(carX - S * 0.7, gy - S * 1.35, S * 1.3, S * 0.5);
    c.fillStyle = "#111"; c.beginPath(); c.arc(carX - S * 0.8, gy - S * 0.25, S * 0.25, 0, 7); c.arc(carX + S * 0.8, gy - S * 0.25, S * 0.25, 0, 7); c.fill();
  } else if (a.shake) {
    // A crate lands; the frame (a camera's view) jolts after it and settles.
    const tt = u * 2.2, land = 0.55, age = tt - land - 0.1;
    const jolt = age > 0 ? Math.exp(-age / 0.22) * Math.sin(age * 2 * Math.PI * 9) * S * 0.18 : 0;
    c.save(); c.translate(jolt * 0.6, jolt);
    const y = tt < land ? gy - 2.2 * S * (1 - (tt / land) ** 2) : gy;
    crate(w / 2, y, S * 0.9);
    if (age > 0 && age < 1.2) { c.fillStyle = `rgba(200,190,170,${0.35 * (1 - age / 1.2)})`; c.beginPath(); c.ellipse(w / 2, gy - S * 0.15, S * (0.8 + age * 1.6), S * (0.25 + age * 0.4), 0, 0, 7); c.fill(); }
    c.restore();
    c.strokeStyle = "rgba(242,255,89,.55)"; c.lineWidth = 1.5; c.strokeRect(6 + jolt * 0.6, 6 + jolt, w - 12, h - 12);
  } else if (a.mount) {
    const hx = w * 0.62;
    c.fillStyle = "#8a6a4e"; c.fillRect(hx - S * 1.1, gy - S * 1.45, S * 2.2, S * 0.75);   // a horse body
    c.fillRect(hx + S * 0.9, gy - S * 2.05, S * 0.35, S * 0.8); c.fillRect(hx - S, gy - S * 0.7, S * 0.18, S * 0.7); c.fillRect(hx + S * 0.8, gy - S * 0.7, S * 0.18, S * 0.7);
    const v = smooth(Math.min(1, u * 1.4));
    const px = lerp(w * 0.2, hx, Math.min(1, v * 1.3)), py = gy - (v > 0.7 ? smooth((v - 0.7) / 0.3) * S * 1.2 : 0);
    person(px, py, S * 0.95);
  }
}

function editThumb(c, p, t, w, h) {
  c.fillStyle = "#1c1620"; c.fillRect(0, 0, w, h);
  const e = p.apply?.edit || {};
  const vertical = e.aspect === "9:16";
  // The picture on top, the timeline under it.
  const ph = h * 0.56, pw = vertical ? ph * 9 / 16 : ph * 16 / 9;
  const px = (w - pw) / 2;
  const clips = [];
  const pace = e.pacing_s || 2.4;
  for (let x = 0, i = 0; x < 12; i++) { const d = e.assemble ? [3, 1.6, 2.2, 1.2, 2.8][i % 5] : pace * (0.85 + ((i * 37) % 7) / 20); clips.push([x, d]); x += d; }
  const T = 8, tt = (t % T) / T * 8;
  const cur = clips.findIndex(([x, d]) => tt >= x && tt < x + d);
  const hue = (i) => [[96, 120, 168], [168, 104, 96], [104, 150, 112], [150, 130, 90], [128, 100, 160]][i % 5];
  c.fillStyle = rgb(hue(Math.max(0, cur)), 0.85); c.fillRect(px, 4, pw, ph);
  // A transition flash at the cut.
  const [cx0, cd] = clips[Math.max(0, cur)] || [0, 1];
  const into = tt - cx0, k = Math.max(0, cur);
  if (e.transition && k % (e.every || 1) === 0 && into < 0.25) {
    c.fillStyle = e.transition === "dip_white" ? `rgba(255,255,255,${1 - into / 0.25})` : `rgba(0,0,0,${1 - into / 0.25})`; c.fillRect(px, 4, pw, ph);
  }
  if (e.subtitles) { c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(px + 2, 4 + ph - 9, pw - 4, 6); c.fillStyle = "#fff"; c.fillRect(px + pw * 0.2, 4 + ph - 7, pw * 0.6, 2); }
  void cd;
  const ty = ph + 10, th = h - ty - 4, sc = w / 12;
  clips.forEach(([x, d], i) => {
    c.fillStyle = rgb(hue(i), i === cur ? 1 : 0.7); c.fillRect(x * sc + 1, ty, d * sc - 2, th);
    if (e.transition && i && i % (e.every || 1) === 0) { c.fillStyle = e.transition === "dip_white" ? "#fff" : "#000"; c.fillRect(x * sc - 2, ty, 4, th); }
  });
  c.fillStyle = "#f2ff59"; c.fillRect(tt * sc, ty - 3, 1.5, th + 6);
}

function recipeThumb(c, p, t, w, h) {
  c.fillStyle = "#1c1620"; c.fillRect(0, 0, w, h);
  const steps = p.apply?.recipe || [];
  const n = steps.length, bw = (w - 16 - (n - 1) * 10) / n, y = h / 2 - 14;
  const on = Math.floor((t % (LOOP * 1.5)) / (LOOP * 1.5) * (n + 1));
  steps.forEach((s, i) => {
    const x = 8 + i * (bw + 10);
    c.fillStyle = i < on ? "rgba(242,255,89,.9)" : "rgba(255,255,255,.08)";
    c.strokeStyle = "rgba(255,255,255,.2)";
    c.beginPath(); if (c.roundRect) c.roundRect(x, y, bw, 28, 6); else c.rect(x, y, bw, 28); c.fill(); c.stroke();
    c.fillStyle = i < on ? "#211927" : "rgba(240,239,237,.8)";
    c.font = "600 9px sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
    const lbl = { video_to_3d: "Video→3D", new_angle: "New angle", ripple_mode: "Ripple", whole_frame: "Whole frame", quality_draft: "Draft", quality_hollywood: "Hollywood", render_all_draft: "Queue all", render_final: "Queue final" }[s] || s;
    c.fillText(lbl, x + bw / 2, y + 14);
    if (i < n - 1) { c.fillStyle = "rgba(240,239,237,.5)"; c.fillText("›", x + bw + 5, y + 14); }
  });
  if (p.apply?.gpu) { c.fillStyle = "rgba(255,122,122,.85)"; c.font = "600 9px sans-serif"; c.textAlign = "left"; c.fillText("asks before GPU", 8, h - 8); }
}

/** Draw one card's preview at time t (seconds). */
export function drawThumb(c, p, t, w, h, extra = {}) {
  c.save();
  try {
    const tab = p.tab === "user" ? ({ camera: "camera", light: "light", look: "look" }[p.kind] || "look") : p.tab;
    if (tab === "camera") camThumb(c, p, t, w, h);
    else if (tab === "light") lightThumb(c, p, t, w, h);
    else if (tab === "look") lookThumb(c, p, t, w, h, extra);
    else if (tab === "action") actionThumb(c, p, t, w, h);
    else if (tab === "edit") editThumb(c, p, t, w, h);
    else if (tab === "recipe") recipeThumb(c, p, t, w, h);
  } finally { c.restore(); }
}
