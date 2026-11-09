// "Identical?": the source clip against its 3D rebuild, in the big canvas. Mounted by rebuildFromVideo
// (web/soundstage.js) on a Video → 3D scene. It shows:
//   - the source <video>, locked to the stage frame (time = trim start + frame / 24), over the Camera view, as
//     Overlay (opacity), Wipe (draggable split) or Onion (difference), or Off;
//   - the Solve chip (reprojection error, confidence, lens, roll) and a per-frame solve-error sparkline you can click;
//   - per-object match chips: each rebuilt object's silhouette (the stage's own ID pass, renderFrameTo('id')) against
//     its mask from the clip (scene.video2stage.masks, COCO RLE), green >= 0.7, amber, red < 0.4, and a headline
//     Match score with the bench formula (tools/v2s_bench/metrics.py: 100 x (0.5 mIoU + 0.3 explained + 0.2 colour));
//   - one-click fixes with stage undo: Fit to plate, Swap, Nudge, Re-key mover, Lock camera;
//   - the server fixes (web/ui/v2sfix.mjs): Fix this object (SAM 3.1 re-tracks it, rebuilt alone), Remove (not in the
//     video), and "+ Missed object" (click it on the source frame). A click on the source picks the seed point.
// Keys (1-4: modes) only act while the bar has focus; it never touches the keyrouter or the global shortcuts.
import { icon } from "./icons.mjs";
import { coverToSource, nearestSample } from "./v2sfix.mjs";

export const FPS = 24;
const GREEN = 0.7, RED = 0.4;

// ---------------------------------------------------------------------------------------------------- masks (RLE)
function cocoCounts(s) {
  const out = [];
  let p = 0;
  while (p < s.length) {
    let x = 0, k = 0, more = true;
    while (more) {
      const c = s.charCodeAt(p) - 48;
      x |= (c & 0x1f) << (5 * k);
      more = !!(c & 0x20);
      p++; k++;
      if (!more && (c & 0x10)) x |= -1 << (5 * k);
    }
    if (out.length > 2) x += out[out.length - 2];
    out.push(x);
  }
  return out;
}

/** COCO RLE ({size:[h,w], counts:[...] | compressed string}) -> {w, h, data: Uint8Array row-major 0/1}. */
export function rleDecode(rle) {
  if (!rle || !rle.size) return null;
  const [h, w] = rle.size;
  const counts = typeof rle.counts === "string" ? cocoCounts(rle.counts) : (rle.counts || []);
  const data = new Uint8Array(w * h);
  let pos = 0, val = 0;
  for (const c of counts) {
    if (val) for (let i = pos; i < pos + c && i < w * h; i++) { const col = Math.floor(i / h), row = i - col * h; data[row * w + col] = 1; }
    pos += c; val ^= 1;
  }
  return { w, h, data };
}

/** Nearest-neighbour resample of a {w,h,data} mask to W x H. */
export function resampleMask(m, W, H) {
  if (!m) return null;
  if (m.w === W && m.h === H) return m;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(m.h - 1, Math.floor(((y + 0.5) * m.h) / H));
    for (let x = 0; x < W; x++) out[y * W + x] = m.data[sy * m.w + Math.min(m.w - 1, Math.floor(((x + 0.5) * m.w) / W))];
  }
  return { w: W, h: H, data: out };
}

/** Intersection, union and IoU of two equal-size 0/1 arrays. */
export function iouOf(a, b) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { const x = a[k], y = b[k]; if (x && y) i++; if (x || y) u++; }
  return { inter: i, union: u, iou: u ? i / u : 0 };
}

/** Which clip mask belongs to an actor: actor.source.mask_ref ("objects/<id>" | "people/<id>"), else its id. */
export function maskRefOf(actor, masks) {
  const ref = actor?.source?.mask_ref || actor?.mask_ref;
  if (ref) return String(ref);
  for (const g of ["people", "objects"]) if (masks?.[g]?.[actor?.id]) return `${g}/${actor.id}`;
  return null;
}

/** The decoded mask for ref on clip frame f (int or string keys), or null. */
export function maskAt(masks, ref, f) {
  if (!masks || !ref) return null;
  const [g, ...rest] = ref.split("/");
  const tr = masks[g]?.[rest.join("/")];
  const r = tr?.[f] ?? tr?.[String(f)];
  return r ? rleDecode(r) : null;
}

/** Frames a mask track covers, sorted. */
export function maskFrames(masks, ref) {
  if (!masks || !ref) return [];
  const [g, ...rest] = ref.split("/");
  return Object.keys(masks[g]?.[rest.join("/")] || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------- scores
/** The bench's MATCH for one frame: 100 x (0.5 mIoU + 0.3 explained + 0.2 colour). */
export function matchFormula(miou, explained, colour) {
  return 100 * (0.5 * (miou || 0) + 0.3 * (explained || 0) + 0.2 * (colour || 0));
}

export const chipLevel = (iou) => (iou == null ? "none" : iou >= GREEN ? "green" : iou < RED ? "red" : "amber");

/** Up to n frames spread over [0, last], ends included. */
export function sampleFrames(last, n = 24) {
  if (last <= 0) return [0];
  const k = Math.min(n, last + 1);
  const out = new Set();
  for (let i = 0; i < k; i++) out.add(Math.round((i * last) / Math.max(1, k - 1)));
  return [...out].sort((a, b) => a - b);
}

/** "Solve 0.6 px · 92 % · 35→42 mm · roll ±5°" from scene.video2stage.solve (null when there is no solve). */
export function solveChipText(s) {
  if (!s) return null;
  const out = [Number.isFinite(s.rms_px) ? `Solve ${s.rms_px.toFixed(1)} px` : "Solve"];
  if (Number.isFinite(s.confidence)) out.push(`${Math.round(s.confidence * 100)} %`);
  const f = (s.focal_mm || []).filter(Number.isFinite);
  if (f.length) {
    const a = Math.round(f[0]), b = Math.round(f[f.length - 1]);
    out.push(s.zoom || a !== b ? `${a}→${b} mm` : `${a} mm`);
  }
  const r = (s.roll_deg || []).filter(Number.isFinite);
  if (r.length) {
    const m = Math.max(...r.map(Math.abs));
    out.push(`roll ±${m >= 1 ? Math.round(m) : m.toFixed(1)}°`);
  }
  if (s.mode && s.mode !== "free") out.push(s.mode);
  return out.join(" · ");
}

/** SVG path for a per-frame error sparkline in a w x h box (y up = worse), plus red frames above `bad` px. */
export function sparkPath(values, w, h, bad = 1.5) {
  const v = (values || []).map((x) => (Number.isFinite(x) ? x : 0));
  if (!v.length) return { d: "", red: [], max: 0 };
  const max = Math.max(bad * 1.5, ...v);
  const X = (i) => (v.length === 1 ? w / 2 : (i * w) / (v.length - 1));
  const Y = (x) => h - (x / max) * (h - 1);
  const d = v.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(x).toFixed(1)}`).join("");
  return { d, red: v.map((x, i) => (x > bad ? i : -1)).filter((i) => i >= 0), max };
}

// ---------------------------------------------------------------------------------------------------- ID pass
/** The sRGB-encoded twin of a palette (74 -> 147). The stage draws ID colours exactly since 2026-11-08; ID passes saved
 *  before that are encoded, so pickPalette still tries both. */
export function srgbEncode(cols) {
  const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return cols.map((c) => c.map((x) => Math.round(255 * enc(x / 255))));
}

/** Half the smallest distance between two palette colours, clamped to 6-40 (the bench's palette_tolerance). */
export function paletteTolerance(cols) {
  let d = Infinity;
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) d = Math.min(d, Math.hypot(cols[i][0] - cols[j][0], cols[i][1] - cols[j][1], cols[i][2] - cols[j][2]));
  return cols.length < 2 ? 40 : Math.max(6, Math.min(40, 0.45 * d));
}

/** RGBA pixels -> label (palette index or -1) per pixel; near-black and in-between blends stay -1. */
export function labelIds(px, n, cols, tol = paletteTolerance(cols)) {
  const lab = new Int16Array(n).fill(-1);
  const t2 = tol * tol;
  for (let i = 0; i < n; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (r + g + b <= 30) continue;
    let best = -1, bd = t2;
    for (let k = 0; k < cols.length; k++) {
      const d = (cols[k][0] - r) ** 2 + (cols[k][1] - g) ** 2 + (cols[k][2] - b) ** 2;
      if (d <= bd) { bd = d; best = k; }
    }
    lab[i] = best;
  }
  return lab;
}

/** Whichever of the raw palette and its sRGB twin labels more pixels (renderers differ in output encoding). */
export function pickPalette(px, n, raw) {
  const enc = srgbEncode(raw);
  const count = (cols) => { const l = labelIds(px, n, cols); let c = 0; for (const v of l) if (v >= 0) c++; return c; };
  return count(enc) >= count(raw) ? enc : raw;
}

// ---------------------------------------------------------------------------------------------------- geometry
/** 4x4 column-major (three.js .elements) product a*b. */
export function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/** World point -> pixel (W x H) through a view-projection matrix; null behind the camera. */
export function projectPt(vp, p, W, H) {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 1e-6) return null;
  return [((x / w + 1) / 2) * W, ((1 - y / w) / 2) * H];
}

export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** Fill a convex polygon into a W x H 0/1 mask (scanline). */
export function rasterPoly(poly, W, H) {
  const out = new Uint8Array(W * H);
  if (!poly || poly.length < 3) return out;
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5;
    let x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        const x = a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      }
    }
    if (x1 < x0) continue;
    for (let x = Math.max(0, Math.ceil(x0 - 0.5)); x <= Math.min(W - 1, Math.floor(x1 - 0.5)); x++) out[y * W + x] = 1;
  }
  return out;
}

/** The 8 world corners of a local box {min,max} placed at (x, y, z), turned yaw (radians, about +Y), scaled s. */
export function boxCorners(box, { x, y, z, yaw, s }) {
  const c = Math.cos(yaw), sn = Math.sin(yaw), out = [];
  for (let i = 0; i < 8; i++) {
    const px = (i & 1 ? box.max[0] : box.min[0]) * s, py = (i & 2 ? box.max[1] : box.min[1]) * s, pz = (i & 4 ? box.max[2] : box.min[2]) * s;
    out.push([x + c * px + sn * pz, y + py, z - sn * px + c * pz]);
  }
  return out;
}

/** Silhouette (0/1, W x H) of a placed box seen through view-projection vp. */
export function boxSilhouette(box, place, vp, W, H) {
  const pts = boxCorners(box, place).map((p) => projectPt(vp, p, W, H)).filter(Boolean);
  return pts.length >= 3 ? rasterPoly(convexHull(pts), W, H) : new Uint8Array(W * H);
}

/**
 * Local search (coordinate descent with step halving) that MAXIMISES score(params). start: {k: value};
 * steps: {k: initial step}. Stops at maxEvals or when every step is below its floor (steps[k] / 32).
 */
export function fitSearch(score, start, steps, { maxEvals = 160, deadline = Infinity, now = () => Date.now() } = {}) {
  let best = { ...start }, bestS = score(best), evals = 1;
  const st = { ...steps };
  const floor = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v / 32]));
  while (evals < maxEvals && now() < deadline && Object.keys(st).some((k) => st[k] > floor[k])) {
    let moved = false;
    for (const k of Object.keys(st)) {
      if (st[k] <= floor[k]) continue;
      for (const dir of [1, -1]) {
        const cand = { ...best, [k]: best[k] + dir * st[k] };
        const s = score(cand);
        evals++;
        if (s > bestS + 1e-6) { best = cand; bestS = s; moved = true; break; }
        if (evals >= maxEvals) break;
      }
      if (!moved) st[k] /= 2;
    }
  }
  return { params: best, score: bestS, evals };
}

/** Where a pixel's ray (camera inverse view-projection ivp, at W x H) meets the ground y = 0; null above the horizon. */
export function groundUnder(ivp, u, v, W, H) {
  const nx = (u / W) * 2 - 1, ny = 1 - (v / H) * 2;
  const un = (z) => {
    const x = ivp[0] * nx + ivp[4] * ny + ivp[8] * z + ivp[12];
    const y = ivp[1] * nx + ivp[5] * ny + ivp[9] * z + ivp[13];
    const zz = ivp[2] * nx + ivp[6] * ny + ivp[10] * z + ivp[14];
    const w = ivp[3] * nx + ivp[7] * ny + ivp[11] * z + ivp[15];
    return [x / w, y / w, zz / w];
  };
  const a = un(-1), b = un(1);
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 1e-9) return null;
  const t = -a[1] / dy;
  if (t < 0) return null;
  return [a[0] + t * (b[0] - a[0]), 0, a[2] + t * (b[2] - a[2])];
}

/** Bottom-centre (feet / wheels) and centroid of a 0/1 mask, or null when empty. */
export function maskAnchor(m) {
  let n = 0, sx = 0, sy = 0, maxY = -1;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x]) { n++; sx += x; sy += y; if (y > maxY) maxY = y; }
  if (!n) return null;
  let bx = 0, bn = 0;
  for (let x = 0; x < m.w; x++) if (m.data[maxY * m.w + x]) { bx += x; bn++; }
  return { cx: sx / n + 0.5, cy: sy / n + 0.5, bx: bx / bn + 0.5, by: maxY + 1, area: n / (m.w * m.h) };
}

/** Thin a list of {frame, position} keys: keep a key only where the straight line from the last kept key misses it by > tol m. */
export function simplifyKeys(keys, tol = 0.05) {
  if (keys.length <= 2) return keys.slice();
  const keep = [0];
  const dist = (p, a, b) => {
    const ab = [b[0] - a[0], b[2] - a[2]], ap = [p[0] - a[0], p[2] - a[2]];
    const L = ab[0] ** 2 + ab[1] ** 2;
    const t = L ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / L)) : 0;
    return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1]);
  };
  const rec = (i, j) => {
    let worst = -1, wi = -1;
    for (let k = i + 1; k < j; k++) {
      const a = keys[i].position, b = keys[j].position;
      const f = (keys[k].frame - keys[i].frame) / Math.max(1, keys[j].frame - keys[i].frame);
      const lerp = [a[0] + f * (b[0] - a[0]), 0, a[2] + f * (b[2] - a[2])];
      const d = Math.max(dist(keys[k].position, a, b), Math.hypot(keys[k].position[0] - lerp[0], keys[k].position[2] - lerp[2]));
      if (d > worst) { worst = d; wi = k; }
    }
    if (worst > tol) { rec(i, wi); keep.push(wi); rec(wi, j); }
  };
  rec(0, keys.length - 1);
  keep.push(keys.length - 1);
  return [...new Set(keep)].sort((a, b) => a - b).map((i) => keys[i]);
}

/** Library kinds a rebuilt object may be swapped for (same family as the bench's GROUP). */
export const SWAP_FAMILIES = {
  seating: ["sofa", "armchair", "chair", "bench"],
  table: ["table", "dining_table", "coffee_table", "desk", "kitchen_counter"],
  storage: ["bookshelf", "wardrobe", "fridge", "tv"],
  bed: ["bed", "single_bed"],
  vehicle: ["car", "hatchback", "sports_car", "police_car", "truck", "motorcycle", "bicycle"],
  flora: ["tree", "bush", "houseplant"],
  structure: ["wall", "flat", "door", "house"],
  prop: ["crate", "rock", "lamp", "cube", "cylinder", "sphere", "cone"],
};
export function swapChoices(kind) {
  const fam = Object.values(SWAP_FAMILIES).find((f) => f.includes(kind));
  return fam ? fam.filter((k) => k !== kind) : [];
}

// ---------------------------------------------------------------------------------------------------- the bar
const CSS = `
.ss-v2c { position:absolute; left:50%; top:8px; transform:translateX(-50%); z-index:19; max-width:calc(100% - 16px);
  display:flex; flex-direction:column; gap:3px; padding:6px 8px 5px; border-radius:12px; background:rgba(20,14,26,.88);
  border:1px solid rgba(242,255,89,.35); color:#f0efed; font:12px/1.2 "Soundstage Grotesk", system-ui, sans-serif;
  box-shadow:0 8px 28px rgba(0,0,0,.4); user-select:none; }
/* the Coach pill shares the top edge: step it below the bar so the bar's close button stays reachable */
:has(> .ss-v2c) > .ss-coach { top:58px; }
.ss-v2c .row { display:flex; align-items:center; gap:6px; flex-wrap:nowrap; min-width:0; }
.ss-v2c b.t { color:#F2FF59; white-space:nowrap; }
.ss-v2c .seg { display:flex; border:1px solid rgba(255,255,255,.18); border-radius:999px; overflow:hidden; flex:0 0 auto; }
.ss-v2c .seg button, .ss-v2c button.b { font:600 11px/1 "Soundstage Grotesk", system-ui, sans-serif; color:#f0efed; background:transparent;
  border:0; padding:5px 8px; cursor:pointer; white-space:nowrap; }
.ss-v2c .seg button[aria-pressed=true] { background:#F2FF59; color:#1a1420; }
.ss-v2c button.b { border:1px solid rgba(255,255,255,.18); border-radius:999px; display:inline-flex; gap:4px; align-items:center; }
.ss-v2c button.b:hover, .ss-v2c .seg button:hover:not([aria-pressed=true]) { background:rgba(242,255,89,.14); }
.ss-v2c input[type=range] { width:72px; accent-color:#F2FF59; flex:0 0 auto; }
.ss-v2c .chip { white-space:nowrap; color:#d8d4dc; font-variant-numeric:tabular-nums; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ss-v2c .chip.red { color:#ff8a7e; } .ss-v2c .chip.amber { color:#ffcf6b; } .ss-v2c .chip.green { color:#9be59b; }
.ss-v2c svg.spark { width:100%; height:14px; display:block; cursor:pointer; }
.ss-v2c .x { margin-left:auto; color:#a9a3ad; }
.ss-v2c .list { display:flex; flex-direction:column; gap:2px; overflow:hidden; }
.ss-v2c .obj { display:flex; align-items:center; gap:6px; padding:2px 4px; border-radius:6px; cursor:pointer; white-space:nowrap; }
.ss-v2c .obj:hover { background:rgba(255,255,255,.07); }
.ss-v2c .dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; background:#777; }
.ss-v2c .dot.green { background:#5fd35f; } .ss-v2c .dot.amber { background:#ffbf3f; } .ss-v2c .dot.red { background:#ff5e52; }
.ss-v2c .obj .n { overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1; }
.ss-v2c .obj .v { color:#a9a3ad; font-variant-numeric:tabular-nums; }
.ss-v2c .fix { display:flex; gap:4px; flex-wrap:wrap; padding:2px 0 2px 15px; }
.ss-v2c .msg { color:#a9a3ad; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-v2c-src { position:absolute; z-index:5; pointer-events:none; object-fit:cover; }
.ss-v2c-wipe { position:absolute; z-index:6; width:14px; margin-left:-7px; cursor:ew-resize; display:none; }
.ss-v2c-wipe::after { content:""; position:absolute; left:6px; top:0; bottom:0; width:2px; background:#F2FF59; box-shadow:0 0 6px rgba(0,0,0,.6); }
.ss-v2c-nudge { position:absolute; z-index:7; cursor:move; display:none; }
.ss-v2c-pick { position:absolute; z-index:8; cursor:crosshair; display:none; outline:2px dashed #F2FF59; outline-offset:-2px; }
`;

export function ensureCss() {
  if (typeof document === "undefined" || document.getElementById("ss-v2c-css")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "ss-v2c-css", textContent: CSS }));
}

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

/**
 * Mount the compare bar. opts: {stage, host (the 3D view, position:relative), videoUrl, masks?, onFrame(f)?,
 * onStatus(text)?, lockCamera()?}. Returns the controller {el, setMode, scoreAll, fit, destroy, ...}.
 */
export function mountCompare(opts) {
  ensureCss();
  return new CompareBar(opts);
}

export class CompareBar {
  constructor({ stage, host, videoUrl, masks = null, onFrame = null, onStatus = null, lockCamera = null, maxRows = 6,
    onFix = null, onRemove = null, onAdd = null }) {
    this.stage = stage; this.host = host; this.onFrame = onFrame; this.say = onStatus || (() => {});
    this.lockCamera = lockCamera; this.maxRows = maxRows;
    this.onFix = onFix; this.onRemove = onRemove; this.onAdd = onAdd;
    const v2s = stage.state?.video2stage || {};
    this.masks = masks || v2s.masks || null;
    this.start = Number((v2s.trim || [])[0]) || Number(stage.state?.reference?.start) || 0;
    this.mode = "off"; this.opacity = 0.5; this.wipe = 0.5; this.scores = null; this.open = false; this.busy = false;
    this.video = el("video", { className: "ss-v2c-src", muted: true, playsInline: true, preload: "auto", crossOrigin: "anonymous" });
    if (videoUrl) this.video.src = videoUrl;
    this.wipeEl = el("div", { className: "ss-v2c-wipe", title: "Drag: source on the left, the rebuild on the right" });
    this.nudgeEl = el("div", { className: "ss-v2c-nudge", title: "Drag on the ground to move the object; release to keep it" });
    this.pickEl = el("div", { className: "ss-v2c-pick", title: "Click the object on the source frame (Esc: cancel)" });
    this.el = el("div", { className: "ss-v2c", tabIndex: -1 });
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Identical? Compare the source clip with the 3D rebuild");
    for (const ev of ["pointerdown", "wheel", "dblclick"]) this.el.addEventListener(ev, (e) => e.stopPropagation());
    this.el.addEventListener("keydown", (e) => {
      const m = { 1: "overlay", 2: "wipe", 3: "onion", 4: "off" }[e.key];
      if (m) { this.setMode(m); e.preventDefault(); }
      if (e.key === "Escape") this.setMode("off");
      e.stopPropagation();
    });
    this._build(v2s.solve);
    host.append(this.video, this.wipeEl, this.nudgeEl, this.pickEl, this.el);
    this._wireWipe();
    this._wireNudge();
    this._wirePick();
    this._last = -1;
    const tick = () => { if (this.dead) return; this._sync(); this._raf = requestAnimationFrame(tick); };
    this._raf = requestAnimationFrame(tick);
  }

  _build(solve) {
    const seg = el("div", { className: "seg" });
    this.modeBtns = {};
    for (const [k, label, tip] of [["overlay", "Overlay", "The source over the rebuild (1)"], ["wipe", "Wipe", "Drag a split line (2)"],
      ["onion", "Onion", "Difference: what lines up goes dark (3)"], ["off", "Off", "Hide the source (4)"]]) {
      const b = el("button", { type: "button", textContent: label, title: tip });
      b.dataset.mode = k;
      b.addEventListener("click", () => this.setMode(k));
      seg.append(b);
      this.modeBtns[k] = b;
    }
    this.slider = el("input", { type: "range", min: 0, max: 100, value: 50, title: "Source opacity" });
    this.slider.setAttribute("aria-label", "Source opacity");
    this.slider.addEventListener("input", () => { this.opacity = this.slider.value / 100; if (this.mode === "off") this.setMode("overlay"); this._style(); });
    const st = solveChipText(solve);
    this.solveChip = el("span", { className: "chip", textContent: st || "Solve: no report", title: "Camera solve: reprojection error at 1024 wide, confidence, lens, roll" });
    if (solve && Number.isFinite(solve.rms_px)) this.solveChip.classList.add(solve.rms_px <= 1 ? "green" : solve.rms_px <= 3 ? "amber" : "red");
    this.matchBtn = el("button", { type: "button", className: "b", title: "Score every object against the clip (its own ID pass vs the clip's masks)" },
      icon("scan-eye", 12), el("span", { textContent: "Match" }));
    this.matchBtn.dataset.act = "match";
    this.matchBtn.addEventListener("click", () => (this.scores ? this.toggleList() : this.scoreAll()));
    const x = el("button", { type: "button", className: "b x", textContent: "×", title: "Close the compare bar" });
    x.addEventListener("click", () => this.destroy());
    this.addBtn = el("button", { type: "button", className: "b", title: "Something in the clip the rebuild missed: click it on the source frame and it is tracked and rebuilt alone" },
      icon("plus", 12), el("span", { textContent: "Missed object" }));
    this.addBtn.dataset.act = "add-missed";
    this.addBtn.hidden = !this.onAdd;
    this.addBtn.addEventListener("click", () => this.addMissed());
    this.row = el("div", { className: "row" }, el("b", { className: "t", textContent: "Identical?" }), seg, this.slider, this.solveChip, this.matchBtn, this.addBtn, x);
    this.spark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.spark.setAttribute("class", "spark");
    this.spark.setAttribute("preserveAspectRatio", "none");
    this.spark.addEventListener("click", (e) => this._sparkClick(e));
    this._drawSpark(solve);
    this.msg = el("div", { className: "msg" });
    this.list = el("div", { className: "list", hidden: true });
    this.el.append(this.row, this.spark, this.msg, this.list);
    this._style();
  }

  _drawSpark(solve) {
    const vals = solve?.per_frame_px || [];
    this.spark.replaceChildren();
    this.spark.style.display = vals.length ? "" : "none";
    if (!vals.length) return;
    const W = 400, H = 14, { d, red } = sparkPath(vals, W, H);
    this.spark.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const ns = "http://www.w3.org/2000/svg";
    for (const i of red) {
      const r = document.createElementNS(ns, "rect");
      const x = vals.length === 1 ? 0 : (i * W) / (vals.length - 1);
      r.setAttribute("x", String(x - 1)); r.setAttribute("y", "0"); r.setAttribute("width", "2"); r.setAttribute("height", String(H));
      r.setAttribute("fill", "rgba(255,94,82,.55)");
      this.spark.append(r);
    }
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "#F2FF59"); p.setAttribute("stroke-width", "1.2");
    p.setAttribute("vector-effect", "non-scaling-stroke");
    this.spark.append(p);
    this.spark.setAttribute("aria-label", `Solve error per frame; ${red.length} frame(s) over 1.5 px. Click to jump.`);
    this._sparkN = vals.length;
  }

  _sparkClick(e) {
    const r = this.spark.getBoundingClientRect();
    const n = this._sparkN || 1;
    const f = Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * (n - 1));
    this.goto(f);
  }

  goto(f) {
    const last = (this.stage.state?.shot?.frames || 1) - 1;
    f = Math.max(0, Math.min(last, f));
    this.stage.setFrame(f);
    this.onFrame?.(f);
  }

  setMode(m) {
    this.mode = m;
    for (const [k, b] of Object.entries(this.modeBtns)) b.setAttribute("aria-pressed", String(k === m));
    this._style();
    this._last = -1;
  }

  _style() {
    const v = this.video;
    const on = this.mode !== "off" && !this.stage.freeView;
    v.style.display = on ? "" : "none";
    v.style.opacity = this.mode === "onion" || this.mode === "wipe" ? "1" : String(this.opacity);
    v.style.mixBlendMode = this.mode === "onion" ? "difference" : "normal";
    v.style.clipPath = this.mode === "wipe" ? `inset(0 ${(100 - this.wipe * 100).toFixed(2)}% 0 0)` : "none";
    this.wipeEl.style.display = on && this.mode === "wipe" ? "block" : "none";
  }

  /** Keep the video over the canvas and on the stage's frame. */
  _sync() {
    const c = this.stage.canvas;
    if (!c) return;
    const hr = this.host.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const box = { left: `${cr.left - hr.left}px`, top: `${cr.top - hr.top}px`, width: `${cr.width}px`, height: `${cr.height}px` };
    Object.assign(this.video.style, box);
    Object.assign(this.nudgeEl.style, box);
    Object.assign(this.wipeEl.style, { left: `${cr.left - hr.left + cr.width * this.wipe}px`, top: box.top, height: box.height });
    const freeNow = !!this.stage.freeView;
    if (freeNow !== this._free) { this._free = freeNow; this._style(); }
    const f = this.stage.frame || 0;
    if (f !== this._last && this.mode !== "off" && this.video.readyState >= 1) {
      this._last = f;
      const t = this.start + f / FPS;
      if (Math.abs(this.video.currentTime - t) > 0.5 / FPS) this.video.currentTime = Math.min(t, Math.max(0, (this.video.duration || t) - 0.001));
    }
  }

  _wireWipe() {
    let drag = false;
    this.wipeEl.addEventListener("pointerdown", (e) => { drag = true; this.wipeEl.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
    this.wipeEl.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const cr = this.stage.canvas.getBoundingClientRect();
      this.wipe = Math.max(0, Math.min(1, (e.clientX - cr.left) / Math.max(1, cr.width)));
      this._style();
    });
    this.wipeEl.addEventListener("pointerup", () => { drag = false; });
  }

  // ------------------------------------------------------------------------------------------------ scoring
  _ids() { return this.stage.idColors?.() || {}; }

  /** The actor list with a clip mask, the scan pieces (no masks) left out. */
  scored() {
    return (this.stage.state?.actors || []).filter((a) => !a.scan && maskRefOf(a, this.masks));
  }

  /** Label map (actor index or -1) of the stage's ID pass at frame f, W wide. */
  _idLabels(f, W, H, actors) {
    const src = this.stage.renderFrameTo("id", f);
    const cv = this._cv || (this._cv = document.createElement("canvas"));
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    const pal = this._ids();
    // every actor's colour takes part (so a neighbour's pixels are never claimed by the nearest scored actor)
    const all = this.stage.state.actors.map((a) => pal[a.id] || [0, 0, 0]);
    if (!this._pal || this._pal.n !== all.length) this._pal = { n: all.length, cols: pickPalette(px, W * H, all) };
    const full = labelIds(px, W * H, this._pal.cols);
    const index = new Map(actors.map((a, k) => [this.stage.state.actors.findIndex((x) => x.id === a.id), k]));
    const lab = new Int16Array(W * H).fill(-1);
    for (let i = 0; i < full.length; i++) if (full[i] >= 0 && index.has(full[i])) lab[i] = index.get(full[i]);
    return lab;
  }

  /** Mean colour similarity (bench: 1 - deltaE/50, clipped) of the Color pass vs the source frame f, or null. */
  async _colourAt(f, W, H) {
    const v = this.video;
    if (!v.src || v.readyState < 1) return null;
    const t = this.start + f / FPS;
    await new Promise((ok) => { const done = () => { v.removeEventListener("seeked", done); ok(); }; v.addEventListener("seeked", done); v.currentTime = t; setTimeout(done, 1500); });
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    try { g.drawImage(v, 0, 0, W, H); } catch { return null; }
    let a;
    try { a = g.getImageData(0, 0, W, H).data; } catch { return null; }   // a cross-origin clip can't be read back
    g.drawImage(this.stage.renderFrameTo("color", f), 0, 0, W, H);
    const b = g.getImageData(0, 0, W, H).data;
    let s = 0, n = 0;
    for (let i = 0; i < W * H; i += 3) {
      const d = deltaE(a, b, i * 4);
      s += Math.max(0, Math.min(1, 1 - d / 50)); n++;
    }
    return n ? s / n : null;
  }

  /** Score every masked object on up to 24 frames. Fills this.scores {objects: [{id, name, iou, worst, level}], match}. */
  async scoreAll({ frames: nF = 24, W = 256 } = {}) {
    if (this.busy) return this.scores;
    const actors = this.scored();
    if (!actors.length) {
      this.msg.textContent = "No clip masks on this rebuild: per-object match needs the masks from the Video → 3D run.";
      return null;
    }
    this.busy = true;
    this._pal = null;
    this.matchBtn.disabled = true;
    const keepFrame = this.stage.frame;
    const H = Math.max(1, Math.round((W * (this.stage.fh || 9)) / (this.stage.fw || 16)));
    const last = (this.stage.state?.shot?.frames || 1) - 1;
    const refs = actors.map((a) => maskRefOf(a, this.masks));
    const all = new Set();
    refs.forEach((r) => maskFrames(this.masks, r).forEach((f) => { if (f <= last) all.add(f); }));
    const pool = [...all].sort((a, b) => a - b);
    const frames = pool.length ? sampleFrames(pool.length - 1, nF).map((i) => pool[i]) : sampleFrames(last, nF);
    const per = actors.map(() => ({ sum: 0, n: 0, worst: 1, worstF: 0 }));
    const rows = [];
    try {
      for (const f of frames) {
        this.msg.textContent = `Scoring frame ${f}…`;
        await new Promise((r) => setTimeout(r, 0));
        const lab = this._idLabels(f, W, H, actors);
        let inter = 0, ious = [];
        const anyMask = new Uint8Array(W * H);
        for (let k = 0; k < actors.length; k++) {
          const m = resampleMask(maskAt(this.masks, refs[k], f), W, H);
          if (!m) continue;
          let area = 0;
          for (let i = 0; i < m.data.length; i++) if (m.data[i]) { area++; anyMask[i] = 1; }
          if (area < 0.00005 * W * H) continue;
          const mine = new Uint8Array(W * H);
          for (let i = 0; i < lab.length; i++) if (lab[i] === k) mine[i] = 1;
          const r = iouOf(m.data, mine);
          inter += r.inter;
          ious.push(r.iou);
          const p = per[k];
          p.sum += r.iou; p.n++;
          if (r.iou < p.worst) { p.worst = r.iou; p.worstF = f; }
        }
        let any = 0;
        for (let i = 0; i < anyMask.length; i++) any += anyMask[i];
        if (ious.length) rows.push({ f, miou: ious.reduce((a, b) => a + b, 0) / ious.length, explained: inter / Math.max(1, any) });
      }
      const cf = sampleFrames(Math.max(0, frames.length - 1), 6).map((i) => frames[i]);
      const cs = [];
      for (const f of cf) { const c = await this._colourAt(f, 160, Math.max(1, Math.round((160 * H) / W))); if (c != null) cs.push(c); }
      const colour = cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null;
      const match = rows.length ? rows.reduce((a, r) => a + matchFormula(r.miou, r.explained, colour ?? 0), 0) / rows.length : null;
      const objects = actors.map((a, k) => {
        const p = per[k], iou = p.n ? p.sum / p.n : null;
        return { id: a.id, name: a.name || a.id, kind: a.kind, iou, level: chipLevel(iou), worst: p.worstF, moving: (a.keys || []).length > 1 };
      }).sort((a, b) => (a.iou ?? 2) - (b.iou ?? 2));
      this.scores = { objects, match, colour, frames: frames.length, miou: rows.length ? rows.reduce((a, r) => a + r.miou, 0) / rows.length : null,
        explained: rows.length ? rows.reduce((a, r) => a + r.explained, 0) / rows.length : null };
      const reds = objects.filter((o) => o.level === "red").length;
      this.matchBtn.querySelector("span").textContent = match == null ? "Match –" : `Match ${Math.round(match)}/100`;
      this.matchBtn.title = `Bench formula, ${frames.length} frames: mIoU ${(this.scores.miou ?? 0).toFixed(2)}, explained ${(this.scores.explained ?? 0).toFixed(2)}` +
        `, colour ${colour == null ? "n/a (clip not readable)" : colour.toFixed(2)}. Click for the objects.`;
      const ambers = objects.filter((o) => o.level === "amber").length;
      this.msg.textContent = reds ? `${reds} object${reds > 1 ? "s" : ""} red (off the plate): click one for one-click fixes.`
        : ambers ? `No red; ${ambers} amber (close, not exact): click one to fit it.` : "Every scored object lines up with the clip.";
      this._renderList();
      this.open = true; this.list.hidden = false;
    } finally {
      this.stage.setFrame(keepFrame);
      this.busy = false;
      this.matchBtn.disabled = false;
    }
    return this.scores;
  }

  toggleList() { this.open = !this.open; this.list.hidden = !this.open; }

  /** Rows that fit without scrolling: worst first, the rest summarised. */
  _renderList() {
    const o = this.scores?.objects || [];
    const room = this._rowsThatFit();
    const show = o.slice(0, room);
    this.list.replaceChildren(...show.map((x) => this._objRow(x)));
    if (o.length > show.length) {
      const rest = o.slice(show.length);
      const lv = rest.reduce((m, r) => ({ ...m, [r.level]: (m[r.level] || 0) + 1 }), {});
      this.list.append(el("div", { className: "msg", textContent: `+${rest.length} more (${Object.entries(lv).map(([k, v]) => `${v} ${k}`).join(", ")})` }));
    }
  }

  _rowsThatFit() {
    const avail = (this.host.clientHeight || 600) - (this.el.offsetTop || 8) - 90;
    return Math.max(1, Math.min(this.maxRows, Math.floor(avail / 22)));
  }

  _objRow(x) {
    const row = el("div", { className: "obj", title: `${x.name}: IoU ${x.iou == null ? "n/a" : x.iou.toFixed(2)} (worst at frame ${x.worst}). Click to select and see fixes.` },
      el("span", { className: `dot ${x.level}` }), el("span", { className: "n", textContent: x.name }),
      el("span", { className: "v", textContent: x.iou == null ? "–" : x.iou.toFixed(2) }));
    row.dataset.id = x.id;
    const wrap = el("div", {}, row);
    row.addEventListener("click", () => {
      this.stage.select?.(x.id);
      this.goto(x.worst);
      const open = wrap.querySelector(".fix");
      for (const f of this.list.querySelectorAll(".fix")) f.remove();
      if (!open) wrap.append(this._fixRow(x));
    });
    return wrap;
  }

  _fixRow(x) {
    const fix = el("div", { className: "fix" });
    const b = (k, label, ic, run, tip) => {
      const btn = el("button", { type: "button", className: "b", title: tip }, icon(ic, 11), label);
      btn.dataset.fix = k;
      btn.addEventListener("click", async (e) => { e.stopPropagation(); btn.disabled = true; try { await run(); } finally { btn.disabled = false; } });
      fix.append(btn);
    };
    if (!x.moving) b("fit", "Fit to plate", "maximize-2", () => this.fit(x.id), "Search position on the ground, turn and size for the best overlap with the clip");
    const sw = swapChoices(x.kind);
    if (sw.length) b("swap", "Swap", "shapes", () => this.swap(x.id), `Try ${sw.length} other ${sw.length > 1 ? "kinds" : "kind"} from the library, fitted`);
    if (!x.moving) b("nudge", "Nudge", "move-3d", () => this.nudge(x.id), "Drag it along the ground in the view");
    if (x.moving) b("rekey", "Re-key", "step-forward", () => this.rekey(x.id), "Re-fit its path to where the clip shows it, frame by frame");
    if (this.lockCamera) b("lock", "Lock camera", "camera", () => this.lockCamera(), "Hold the camera on frame 0 (when the solve is unreliable)");
    if (this.onFix && !x.moving) b("refit", "Fix this object", "sparkles", () => this.fixObject(x.id),
      "Re-analyse only this object in the clip (SAM 3.1) and rebuild it alone; it keeps its place. Undo puts the old one back");
    if (this.onRemove) b("remove", "Remove (not in the video)", "trash-2", () => this.onRemove(x.id), "The rebuild invented it: take it out (Undo puts it back)");
    return fix;
  }

  // ------------------------------------------------------------------------------------------------ fixes
  /** Cameras (view-projection, inverse) for frames, read from the stage without changing what it shows. */
  _cams(frames) {
    const keep = this.stage.frame, out = {};
    try {
      for (const f of frames) {
        this.stage.setFrameSilent(f);
        const c = this.stage.camera;
        c.updateMatrixWorld(true);
        c.updateProjectionMatrix?.();
        out[f] = { vp: mul4(c.projectionMatrix.elements, c.matrixWorldInverse.elements),
          ivp: mul4(c.matrixWorld.elements, c.projectionMatrixInverse.elements) };
      }
    } finally { this.stage.setFrameSilent(keep); }
    return out;
  }

  /** The actor's local box (unscaled, unturned) and its current placement. */
  async _localBox(id) {
    const g = this.stage.actorMeshes?.get(id);
    if (!g) return null;
    const THREE = await import("../vendor/three.module.min.mjs");
    const pos = g.position.clone(), rot = g.rotation.y, sc = g.scale.x;
    g.position.set(0, 0, 0); g.rotation.y = 0; g.scale.setScalar(1); g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g);
    g.position.copy(pos); g.rotation.y = rot; g.scale.setScalar(sc); g.updateMatrixWorld(true);
    if (!Number.isFinite(b.min.x)) return null;
    return { box: { min: b.min.toArray(), max: b.max.toArray() }, place: { x: pos.x, y: pos.y, z: pos.z, yaw: rot, s: sc } };
  }

  /** Patch one actor through the scene (stage undo records it). */
  _patch(id, fn) {
    const s = this.stage.toJSON();
    const a = (s.actors || []).find((x) => x.id === id);
    if (!a) return false;
    fn(a);
    const frame = this.stage.frame;
    this.stage.load(s);
    this.stage.setFrame(frame);
    this.stage.select?.(id);
    this.stage.onChange?.(this.stage.toJSON());
    return true;
  }

  /** Fit to plate: x, z on the ground, yaw and size maximising the silhouette overlap on up to 6 masked frames. */
  async fit(id, { W = 128, budgetMs = 2500 } = {}) {
    const a = (this.stage.state?.actors || []).find((x) => x.id === id);
    const ref = maskRefOf(a, this.masks);
    const lb = await this._localBox(id);
    if (!a || !ref || !lb) { this.say("Fit to plate needs the object's clip mask."); return null; }
    const pool = maskFrames(this.masks, ref);
    const frames = sampleFrames(Math.max(0, pool.length - 1), 6).map((i) => pool[i]).filter((f) => f != null);
    const H = Math.max(1, Math.round((W * (this.stage.fh || 9)) / (this.stage.fw || 16)));
    const cams = this._cams(frames);
    const masks = frames.map((f) => resampleMask(maskAt(this.masks, ref, f), W, H)).filter(Boolean);
    const score = (p) => {
      let s = 0;
      frames.forEach((f, i) => { if (masks[i]) s += iouOf(masks[i].data, boxSilhouette(lb.box, { ...p, y: lb.place.y }, cams[f].vp, W, H)).iou; });
      return s / Math.max(1, masks.length);
    };
    const t0 = Date.now();
    const size = Math.max(0.3, ...lb.box.max.map((v, i) => (v - lb.box.min[i]) * lb.place.s));
    const before = score(lb.place);
    const r = fitSearch(score, { x: lb.place.x, z: lb.place.z, yaw: lb.place.yaw, s: lb.place.s },
      { x: size * 0.5, z: size * 0.5, yaw: 0.35, s: lb.place.s * 0.15 }, { maxEvals: 220, deadline: t0 + budgetMs });
    const p = r.params;
    p.s = Math.max(lb.place.s * 0.5, Math.min(lb.place.s * 2, p.s));
    if (r.score <= before + 0.005) { this.say(`Fit to plate: ${a.name} already sits at its best overlap (${before.toFixed(2)}).`); return { before, after: before, ms: Date.now() - t0 }; }
    this._patch(id, (x) => {
      const dx = p.x - lb.place.x, dz = p.z - lb.place.z;
      x.position = [+(x.position?.[0] + dx).toFixed(3), x.position?.[1] || 0, +(x.position?.[2] + dz).toFixed(3)];
      x.keys = (x.keys || [{ frame: 0, position: x.position }]).map((k) => ({ ...k, position: [+(k.position[0] + dx).toFixed(3), k.position[1], +(k.position[2] + dz).toFixed(3)] }));
      x.rotation_deg = +(((x.rotation_deg || 0) + ((p.yaw - lb.place.yaw) * 180) / Math.PI)).toFixed(1);
      x.scale = +((x.scale || 1) * (p.s / lb.place.s)).toFixed(3);
    });
    const ms = Date.now() - t0;
    this.say(`Fit to plate: ${a.name} overlap ${before.toFixed(2)} → ${r.score.toFixed(2)} (${r.evals} tries, ${(ms / 1000).toFixed(1)} s). Undo puts it back.`);
    return { before, after: r.score, ms };
  }

  /** Swap: try each library kind of the same family, keep the best fitted one. */
  async swap(id) {
    const a = (this.stage.state?.actors || []).find((x) => x.id === id);
    if (!a) return null;
    const kinds = swapChoices(a.kind);
    const start = this.stage.toJSON();
    let best = null;
    for (const k of [a.kind, ...kinds]) {
      this._patch(id, (x) => { x.kind = k; });
      const r = await this.fit(id, { budgetMs: 900 });
      const sc = r ? r.after : 0;
      if (!best || sc > best.sc) best = { k, sc, scene: this.stage.toJSON() };
    }
    if (best) {
      this.stage.load(best.scene); this.stage.setFrame(this.stage.frame); this.stage.onChange?.(this.stage.toJSON());
      this.say(best.k === a.kind ? `Swap: ${a.name} fits best as it is.` : `Swap: ${a.name} is now a ${best.k.replace(/_/g, " ")} (overlap ${best.sc.toFixed(2)}).`);
    } else { this.stage.load(start); }
    return best;
  }

  /** Nudge: drag in the view moves the object along the ground under the cursor (until release). */
  nudge(id) {
    this._nudgeId = id;
    this.nudgeEl.style.display = "block";
    this.say("Nudge: drag in the view to slide it along the ground. Release to keep it (Undo puts it back).");
  }

  _wireNudge() {
    let down = false;
    const at = (e) => {
      const r = this.stage.canvas.getBoundingClientRect();
      const cam = this._cams([this.stage.frame])[this.stage.frame];
      return groundUnder(cam.ivp, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    };
    this.nudgeEl.addEventListener("pointerdown", (e) => { down = true; this.nudgeEl.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
    this.nudgeEl.addEventListener("pointermove", (e) => {
      if (!down || !this._nudgeId) return;
      const p = at(e);
      const g = this.stage.actorMeshes?.get(this._nudgeId);
      if (p && g) { g.position.x = p[0]; g.position.z = p[2]; this.stage.render?.(); }
    });
    this.nudgeEl.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      const p = at(e), id = this._nudgeId;
      this.nudgeEl.style.display = "none";
      this._nudgeId = null;
      if (p && id) this._patch(id, (x) => { x.position = [+p[0].toFixed(3), x.position?.[1] || 0, +p[2].toFixed(3)]; x.keys = [{ frame: 0, position: [...x.position] }]; });
    });
  }

  /** Re-key a mover: its mask's ground contact on every masked frame -> keys, simplified at 5 cm. */
  async rekey(id) {
    const a = (this.stage.state?.actors || []).find((x) => x.id === id);
    const ref = maskRefOf(a, this.masks);
    if (!a || !ref) { this.say("Re-key needs the object's clip mask."); return null; }
    const last = (this.stage.state?.shot?.frames || 1) - 1;
    const frames = maskFrames(this.masks, ref).filter((f) => f <= last);
    const cams = this._cams(frames);
    const keys = [];
    for (const f of frames) {
      const m = maskAt(this.masks, ref, f);
      const an = m && maskAnchor(m);
      if (!an || an.area < 0.0001) continue;
      const p = groundUnder(cams[f].ivp, an.bx, an.by, m.w, m.h);
      if (p) keys.push({ frame: f, position: [+p[0].toFixed(3), 0, +p[2].toFixed(3)] });
    }
    if (keys.length < 2) { this.say(`Re-key: ${a.name} is not seen on enough frames to re-fit its path.`); return null; }
    const kept = simplifyKeys(keys, 0.05);
    this._patch(id, (x) => { x.keys = kept; x.position = [...kept[0].position]; });
    this.say(`Re-key: ${a.name} now follows the clip on ${keys.length} frames (${kept.length} keys). Undo puts the old path back.`);
    return kept;
  }

  // ------------------------------------------------------------------------------------------------ source picks
  /** The source sample nearest the frame on show; the stage goes to it so you click the frame SAM will see. */
  _toSample() {
    const ref = this.stage.state?.reference || {};
    const times = ref.sample_times || [];
    if (!times.length) return null;
    const i = nearestSample(times, this.stage.frame || 0, FPS);
    this.goto(Math.round(times[i] * FPS));
    return i;
  }

  /** Wait for one click on the source frame: resolves {sample, point:{x, y} 0-1} or null (Esc / cancelled). */
  pickOnSource(message) {
    const sample = this._toSample();
    if (sample == null) { this.say("This rebuild has no source samples to click on."); return Promise.resolve(null); }
    if (this.mode === "off" || this.mode === "onion") this.setMode("overlay");
    this._pickPrev = this.opacity;
    this.opacity = Math.max(this.opacity, 0.85);
    this._style();
    Object.assign(this.pickEl.style, { left: this.video.style.left, top: this.video.style.top, width: this.video.style.width,
      height: this.video.style.height, display: "block" });
    this.say(message || "Click the object on the source frame (Esc to cancel).");
    return new Promise((resolve) => { this._pickDone = (v) => { this._endPick(); resolve(v ? { sample, point: v } : null); }; });
  }

  _endPick() {
    this.pickEl.style.display = "none";
    if (this._pickPrev != null) { this.opacity = this._pickPrev; this._pickPrev = null; this._style(); }
    this._pickDone = null;
  }

  _wirePick() {
    this.pickEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      const r = this.pickEl.getBoundingClientRect();
      const p = coverToSource(e.clientX - r.left, e.clientY - r.top, r.width, r.height, this.video.videoWidth || r.width, this.video.videoHeight || r.height);
      this._pickDone?.(p);
    });
    this._pickKey = (e) => { if (e.key === "Escape" && this._pickDone) { e.stopPropagation(); this._pickDone(null); } };
    document.addEventListener("keydown", this._pickKey, true);
  }

  /** Fix this object: a click on the source seeds the track (Esc: seed it from where the rebuild has the object). */
  async fixObject(id) {
    const a = (this.stage.state?.actors || []).find((x) => x.id === id);
    if (!a || !this.onFix) return null;
    this.stage.select?.(id);
    const pick = await this.pickOnSource(`Fix ${a.name || id}: click it on the source frame (Esc: use where the rebuild has it).`);
    return this.onFix(id, pick || { sample: nearestSample(this.stage.state?.reference?.sample_times || [], this.stage.frame || 0, FPS) });
  }

  /** + Missed object: click it on the source frame. */
  async addMissed() {
    if (!this.onAdd) return null;
    const pick = await this.pickOnSource("Click the missed object on the source frame (Esc to cancel).");
    if (!pick) { this.say("Nothing added."); return null; }
    return this.onAdd(pick);
  }

  destroy() {
    this.dead = true;
    this._pickDone?.(null);
    try { document.removeEventListener("keydown", this._pickKey, true); } catch { /* no document */ }
    this.pickEl?.remove();
    cancelAnimationFrame(this._raf);
    try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch { /* already gone */ }
    this.video.remove(); this.wipeEl.remove(); this.nudgeEl.remove(); this.el.remove();
    this.onDestroy?.();
  }
}

// sRGB -> Lab deltaE (CIE76) of the pixel at byte offset o in two RGBA buffers.
function lab(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = f(r), G = f(g), B = f(b);
  let x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = h(x); y = h(y); z = h(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function deltaE(a, b, o) {
  const p = lab(a[o], a[o + 1], a[o + 2]), q = lab(b[o], b[o + 1], b[o + 2]);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
