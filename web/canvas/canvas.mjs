// Soundstage Canvas tab: a layered 2D canvas over the current shot frame (paint, masks, selections, generation),
// built into the stage widget instead of a separate VNCCS UniCanvas node.
//
//   const panel = new CanvasPanel(container, { api, app, stage, onStatus, liftTo3D });
//   panel.load(node.properties.soundstage_canvas);   // names + transforms only; pixels live in input/soundstage/canvas/
//   panel.onChange = (json) => { node.properties.soundstage_canvas = json; };
//   panel.refreshStage();                             // after the stage / playhead changes
//
// Generation, inpaint and outpaint use VNCCS UniCanvas's server routes (vnccs-utils, MIT, (c) 2025 MiuProject):
// POST /vnccs/unicanvas/draw, GET /vnccs/unicanvas/progress/{id}, GET /vnccs/unicanvas/presets|assets. The request
// layout, the txt2img / inpaint / outpaint choice and the outpaint mask (transparent area + 32 px overlap) follow
// VNCCS's web/vnccs_unicanvas.js. Magic mask runs core SAM 3.1 (SAM3_Detect with click points) through the
// queue, or VNCCS's /vnccs/unicanvas/segment (transformers SAM2, downloads facebook/sam2.1-hiera-large on first use).
// Icons not in web/ui/icons.mjs are Lucide paths (ISC, see vendor/LUCIDE_LICENSE.txt).
import { icon as uiIcon } from "../ui/icons.mjs";
import { findTouchupNodes, setTouchupEnabled, setTouchupStill, lastRung2Image } from "../touchup/touchup.mjs";

const EXTRA_ICONS = {
  brush: '<path d="m11 10 3 3"/><path d="M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z"/><path d="M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031"/>',
  eraser: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  "square-dashed": '<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/>',
  lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
  move: '<path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/>',
  frame: '<line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  pipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
  "eye-off": '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  "lock-open": '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  merge: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  dices: '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',
};

function icon(name, size = 16) {
  if (!EXTRA_ICONS[name]) return uiIcon(name, size);
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const attrs = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "ss-icon" };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.innerHTML = EXTRA_ICONS[name];
  return s;
}

const CSS = `
.ss-cv { --cv-bg:var(--ss-bg,#211927); --cv-card:var(--ss-card,rgba(255,255,255,.04)); --cv-raised:var(--ss-raised,#2a2330);
  --cv-line:var(--ss-line,rgba(255,255,255,.08)); --cv-line2:var(--ss-line-strong,rgba(255,255,255,.16));
  --cv-text:var(--ss-text,#f0efed); --cv-muted:var(--ss-muted,rgba(240,239,237,.56)); --cv-faint:var(--ss-faint,rgba(240,239,237,.36));
  --cv-accent:var(--ss-accent,#f2ff59); --cv-ink:var(--ss-accent-ink,#211927);
  display:grid; grid-template-columns:44px minmax(0,1fr) 288px; grid-template-rows:auto minmax(0,1fr); gap:8px;
  color:var(--cv-text); font:12.5px/1.35 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; min-width:0; outline:none; }
.ss-cv * { box-sizing:border-box; }
.ss-cv-opts { grid-column:1 / -1; display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; background:var(--cv-card);
  border:1px solid var(--cv-line); border-radius:12px; padding:6px 10px; min-height:40px; }
.ss-cv-opts label { display:inline-flex; align-items:center; gap:6px; color:var(--cv-muted); white-space:nowrap; }
.ss-cv-opts input[type=range] { width:84px; accent-color:var(--cv-accent); }
.ss-cv-opts output { min-width:28px; color:var(--cv-text); font-variant-numeric:tabular-nums; }
.ss-cv-opts .ss-cv-spacer { flex:1; }
.ss-cv-rail { display:flex; flex-direction:column; gap:4px; background:var(--cv-card); border:1px solid var(--cv-line); border-radius:12px; padding:4px; align-self:start; }
.ss-cv-view { position:relative; min-width:0; height:clamp(320px, 62vh, 980px); background:#120d16; border:1px solid var(--cv-line);
  border-radius:12px; overflow:hidden; touch-action:none; }
.ss-cv-view canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.ss-cv-hud { position:absolute; left:8px; top:8px; display:flex; gap:6px; pointer-events:none; }
.ss-cv-chip { background:rgba(33,25,39,.78); border:1px solid var(--cv-line); border-radius:999px; padding:3px 9px; color:var(--cv-muted); font-size:11px; }
.ss-cv-prog { position:absolute; left:0; right:0; bottom:0; height:26px; background:rgba(18,13,22,.88); display:none; align-items:center; gap:8px; padding:0 10px; font-size:11px; color:var(--cv-muted); }
.ss-cv-prog[data-on=true] { display:flex; }
.ss-cv-prog i { flex:1; height:4px; border-radius:2px; background:var(--cv-line); position:relative; overflow:hidden; }
.ss-cv-prog i b { position:absolute; left:0; top:0; bottom:0; background:var(--cv-accent); width:0; transition:width .2s; }
.ss-cv-side { display:flex; flex-direction:column; gap:8px; min-width:0; }
.ss-cv-card { background:var(--cv-card); border:1px solid var(--cv-line); border-radius:12px; padding:8px; display:flex; flex-direction:column; gap:6px; min-width:0; }
.ss-cv-head { display:flex; align-items:center; gap:6px; text-transform:uppercase; letter-spacing:.08em; font-size:11px; font-weight:600; color:var(--cv-muted); }
.ss-cv-head span { flex:1; }
.ss-cv-layers { display:flex; flex-direction:column; gap:3px; max-height:260px; overflow:auto; }
.ss-cv-layer { display:grid; grid-template-columns:24px 40px minmax(0,1fr) 24px; align-items:center; gap:6px; padding:3px 4px;
  border-radius:8px; border:1px solid transparent; cursor:pointer; }
.ss-cv-layer:hover { background:rgba(255,255,255,.04); }
.ss-cv-layer[aria-selected=true] { background:rgba(242,255,89,.08); border-color:rgba(242,255,89,.35); }
.ss-cv-layer canvas { width:40px; height:24px; border-radius:4px; background:repeating-conic-gradient(#3a3340 0 25%, #2a2330 0 50%) 0 0/8px 8px; }
.ss-cv-layer .ss-cv-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cv-layer .ss-cv-kind { color:var(--cv-faint); font-size:10.5px; }
.ss-cv-row { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.ss-cv-row label { display:flex; align-items:center; gap:6px; color:var(--cv-muted); flex:1; }
.ss-cv-row input[type=range] { flex:1; accent-color:var(--cv-accent); min-width:60px; }
.ss-cv textarea, .ss-cv input[type=text], .ss-cv input[type=number], .ss-cv select { width:100%; min-width:0; background:rgba(0,0,0,.22);
  color:var(--cv-text); border:1px solid var(--cv-line); border-radius:10px; padding:6px 9px; font:inherit; }
.ss-cv textarea { resize:vertical; min-height:54px; }
.ss-cv .ss-cv-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.ss-cv .ss-cv-grid2 label { display:flex; flex-direction:column; gap:3px; color:var(--cv-faint); font-size:11px; }
.ss-cv .ss-cv-note { color:var(--cv-faint); font-size:11px; }
.ss-cv .ss-cv-warn { color:#ff9a7a; font-size:11px; }
.ss-stage .ss-cv button.ss-cv-tool, .ss-cv button.ss-cv-tool { width:34px; height:34px; padding:0 !important; border-radius:9px !important;
  display:grid; place-items:center; background:transparent !important; border:1px solid transparent !important; color:var(--cv-muted) !important; }
.ss-stage .ss-cv button.ss-cv-tool:hover, .ss-cv button.ss-cv-tool:hover { background:var(--cv-raised) !important; color:var(--cv-text) !important; }
.ss-stage .ss-cv button.ss-cv-tool[aria-pressed=true], .ss-cv button.ss-cv-tool[aria-pressed=true] {
  background:var(--cv-accent) !important; color:var(--cv-ink) !important; border-color:var(--cv-accent) !important; }
.ss-stage .ss-cv button.ss-cv-ib, .ss-cv button.ss-cv-ib { width:24px; height:24px; padding:0 !important; border-radius:6px !important;
  display:grid; place-items:center; background:transparent !important; border:1px solid transparent !important; color:var(--cv-muted) !important; }
.ss-stage .ss-cv button.ss-cv-ib:hover, .ss-cv button.ss-cv-ib:hover { color:var(--cv-text) !important; background:var(--cv-raised) !important; }
.ss-cv button.ss-cv-btn { background:var(--cv-raised); color:var(--cv-text); border:1px solid var(--cv-line); border-radius:999px;
  padding:4px 10px; display:inline-flex; align-items:center; gap:5px; font:inherit; font-weight:500; cursor:pointer; white-space:nowrap; }
.ss-cv button.ss-cv-btn:disabled { opacity:.45; cursor:default; }
.ss-cv button.ss-cv-cta { background:var(--cv-accent); color:var(--cv-ink); border:1px solid var(--cv-accent); border-radius:999px; padding:7px 12px;
  font:inherit; font-weight:700; text-transform:uppercase; letter-spacing:.05em; display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; }
.ss-cv button.ss-cv-cta:disabled { opacity:.45; cursor:default; }
.ss-cv input[type=color] { width:30px; height:24px; padding:0; border:1px solid var(--cv-line); border-radius:6px; background:none; }
/* Narrow (the App side panel): rail across the top, panels under the viewport. */
.ss-cv.ss-cv-narrow { grid-template-columns:minmax(0,1fr); }
.ss-cv.ss-cv-narrow .ss-cv-rail { flex-direction:row; flex-wrap:wrap; }
.ss-cv.ss-cv-narrow { grid-template-rows:none; }
.ss-cv.ss-cv-narrow .ss-cv-view { height:auto; aspect-ratio:4 / 3; max-height:70vh; align-self:start; }
.ss-cv.ss-cv-narrow .ss-cv-opts input[type=range] { width:64px; }
`;

function injectCss() {
  if (document.getElementById("soundstage-canvas-css")) return;
  const s = document.createElement("style");
  s.id = "soundstage-canvas-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
const cloneCanvas = (c) => { const n = newCanvas(c.width, c.height); n.getContext("2d").drawImage(c, 0, 0); return n; };
const toBlob = (c) => new Promise((res) => c.toBlob(res, "image/png"));
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = src; });
const snap = (v, g = 8) => Math.round(v / g) * g;
function hashBytes(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

/** Alpha bounding box of a canvas (pixels with alpha > 8), or null. */
function alphaBounds(c) {
  const { width: w, height: h } = c;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const TOOLS = [
  ["brush", "brush", "Brush (B)"], ["eraser", "eraser", "Eraser (E)"], ["mask", "highlighter", "Mask brush (M): paint where to inpaint"],
  ["magic", "wand-sparkles", "Magic mask (W): click an object, Shift/right-click to exclude, then Select"],
  ["rect", "square-dashed", "Rectangle select (R). Shift adds, Alt subtracts"], ["lasso", "lasso", "Lasso select (L). Shift adds, Alt subtracts"],
  ["transform", "move", "Transform (V): drag to move, corners to scale (Shift keeps aspect)"],
  ["genbox", "frame", "Generation box (G): drag the region to generate in"], ["pan", "hand", "Pan (H, or hold Space / middle-drag)"],
  ["picker", "pipette", "Eyedropper (I)"],
];
const KEYS = { b: "brush", e: "eraser", m: "mask", w: "magic", r: "rect", l: "lasso", v: "transform", g: "genbox", h: "pan", i: "picker" };

// Model choices that run on what the pod already has (no downloads). VNCCS presets are added when installed.
const LOCAL_MODELS = [
  { id: "z_image_local", label: "Z-Image Turbo · local", needs: { diffusion_models: "z_image_turbo_bf16.safetensors", text_encoders: "qwen_3_4b.safetensors", vae_models: "flux/ae.safetensors" },
    settings: { generation_mode: "z_image", model_loader: "diffusion_model", diffusion_model_name: "z_image_turbo_bf16.safetensors",
      clip_name: "qwen_3_4b.safetensors", vae_name: "flux/ae.safetensors", clip_type: "lumina2", sampler_name: "res_multistep",
      scheduler: "simple", steps: 8, cfg: 1, fun_controlnet_inpaint: false },
    queue: { unet: "z_image_turbo_bf16.safetensors", clip: "qwen_3_4b.safetensors", clipType: "lumina2", vae: "flux/ae.safetensors",
      shift: 3, sampler: "res_multistep", scheduler: "simple", steps: 8, cfg: 1, kind: "zimage" } },
  { id: "klein_local", label: "FLUX.2 Klein 9B · local (edit model)", needs: { diffusion_models: "flux-2-klein-9b.safetensors", text_encoders: "split_files/text_encoders/qwen_3_8b.safetensors", vae_models: "flux2-vae.safetensors" },
    settings: { generation_mode: "flux_klein", model_loader: "diffusion_model", diffusion_model_name: "flux-2-klein-9b.safetensors",
      clip_name: "split_files/text_encoders/qwen_3_8b.safetensors", vae_name: "flux2-vae.safetensors", clip_type: "flux2",
      sampler_name: "euler", scheduler: "simple", steps: 4, cfg: 1 },
    queue: { kind: "klein", unet: "flux-2-klein-9b.safetensors", clip: "split_files/text_encoders/qwen_3_8b.safetensors", clipType: "flux2",
      vae: "flux2-vae.safetensors", sampler: "euler", steps: 4, cfg: 1 } },
];

const HISTORY_LIMIT = 40;
const HISTORY_BYTES = 360 * 1024 * 1024;

export class CanvasPanel {
  /**
   * @param {HTMLElement} container
   * @param {{api: object, app?: object, stage?: object, onStatus?: (t:string)=>void,
   *          liftTo3D?: (blob: Blob, kind: "card"|"splat"|"mesh", info: object)=>any, onLookStill?: (name:string)=>void}} opts
   */
  constructor(container, opts = {}) {
    injectCss();
    this.api = opts.api;
    this.app = opts.app || globalThis.app || null;
    this.stage = opts.stage || null;
    this.onStatus = opts.onStatus || (() => {});
    this.liftTo3D = opts.liftTo3D || null;
    this.onLookStill = opts.onLookStill || null;
    // VNCCS's /draw samples outside ComfyUI's queue and crashed 0.43 when a prompt ran alongside it: opt-in only.
    this.allowVnccsDirect = opts.allowVnccsDirect === true;
    this.onChange = null;
    this.W = this.stage?.fw || 960;
    this.H = this.stage?.fh || 512;
    this.M = Math.round(this.W * 0.5);           // canvas room around the frame for outpainting / moved layers
    this.EW = this.W + 2 * this.M;
    this.EH = this.H + 2 * this.M;
    this.docId = uid();
    this.layers = [];                             // bottom -> top
    this.activeId = null;
    this.selection = null;                        // EW x EH alpha canvas, or null
    this.genBox = { x: 0, y: 0, w: this.W, h: this.H };
    this.tool = "brush";
    this.brush = { size: 40, hardness: 0.7, opacity: 1, color: "#ffffff" };
    this.view = { s: 1, tx: 0, ty: 0 };
    this.magic = { points: [], engine: "local", busy: false };
    this.gen = { positive: "", negative: "", model: "q:z_image_local", steps: 0, seed: 0, denoise: 0.65, busy: false };
    this.undoStack = []; this.redoStack = [];
    this.vnccs = { ok: false, reason: "Checking VNCCS UniCanvas…", presets: [], assets: null };
    this.sam = { local: false, ckpt: null };
    this._dirty = new Set();
    this._build(container);
    this._initLayers();
    this._probeEngines();
    this.fit();
  }

  // ======================================================================= public API
  toJSON() {
    return {
      version: 1, docId: this.docId, frame: { w: this.W, h: this.H, margin: this.M }, genBox: { ...this.genBox },
      active: this.activeId,
      layers: this.layers.map((l) => ({ id: l.id, name: l.name, kind: l.kind, visible: l.visible, opacity: l.opacity,
        locked: l.locked, file: l.file || null, rev: l.rev || 0, stageMode: l.stageMode || undefined })),
      gen: { positive: this.gen.positive, negative: this.gen.negative, model: this.gen.model, steps: this.gen.steps, seed: this.gen.seed,
        denoise: this.gen.denoise },
    };
  }

  async load(json) {
    let data = json;
    if (typeof json === "string") { try { data = JSON.parse(json); } catch { data = null; } }
    if (!data || !Array.isArray(data.layers)) { this.refreshStage(); return; }
    this.docId = data.docId || this.docId;
    if (data.genBox) this.genBox = { ...data.genBox };
    Object.assign(this.gen, data.gen || {});
    this._syncPromptInputs();
    const layers = [];
    for (const m of data.layers) {
      const layer = this._makeLayer(m.kind, m.name, { id: m.id, visible: m.visible !== false, opacity: m.opacity ?? 1,
        locked: !!m.locked, stageMode: m.stageMode });
      layer.file = m.file || null; layer.rev = m.rev || 0;
      if (m.file && (m.kind === "paint" || m.kind === "gen" || m.kind === "mask")) {
        try {
          const img = await loadImg(this._viewURL(m.file, "input", m.rev));
          layer.canvas.getContext("2d").drawImage(img, 0, 0);
        } catch { this.onStatus(`Canvas: layer ${m.name} is missing on the server`); }
      }
      layers.push(layer);
    }
    this.layers = layers;
    if (!this.layers.some((l) => l.kind === "mask")) this.layers.push(this._makeLayer("mask", "Inpaint mask"));
    this.activeId = data.active && this.layers.some((l) => l.id === data.active) ? data.active : this.layers.find((l) => l.kind === "paint")?.id;
    this.undoStack = []; this.redoStack = [];
    await this._fillBackdrop();
    this.refreshStage();
    this._renderLayers();
    this.render();
  }

  /** Re-render the Stage layer from the 3D stage at its playhead (call after stage edits). */
  refreshStage() {
    const layer = this.layers.find((l) => l.kind === "stage");
    if (!layer || !this.stage?.renderFrameTo) { this.render(); return; }
    try {
      const src = this.stage.renderFrameTo(layer.stageMode || "color", this.stage.frame || 0);
      const ctx = layer.canvas.getContext("2d");
      ctx.clearRect(0, 0, this.EW, this.EH);
      ctx.drawImage(src, this.M, this.M, this.W, this.H);
      layer.thumbDirty = true;
    } catch (e) { console.warn("[Soundstage canvas] stage render", e); }
    this._renderLayers();
    this.render();
  }

  fit() {
    const r = this.viewEl.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) { this._needFit = true; return; }
    this._needFit = false;
    const w = r.width, h = r.height;
    const s = Math.max(0.05, Math.min((w - 24) / this.W, (h - 24) / this.H));
    this.view = { s, tx: (w - this.W * s) / 2, ty: (h - this.H * s) / 2 };
    this.render();
  }

  dispose() {
    this._ro?.disconnect();
    window.removeEventListener("wheel", this._wheelRouter, { capture: true });
    window.removeEventListener("keydown", this._keyRouter, true);
    window.removeEventListener("keyup", this._keyUpRouter, true);
    clearTimeout(this._saveTimer);
    this.root.remove();
  }

  // ======================================================================= layers model
  _makeLayer(kind, name, extra = {}) {
    return { id: extra.id || uid(), name, kind, visible: extra.visible ?? true, opacity: extra.opacity ?? 1,
      locked: extra.locked ?? (kind === "stage" || kind === "backdrop"), canvas: newCanvas(this.EW, this.EH),
      stageMode: kind === "stage" ? (extra.stageMode || "color") : undefined, thumbDirty: true };
  }

  _initLayers() {
    const backdrop = this._makeLayer("backdrop", "Backdrop plate");
    const stage = this._makeLayer("stage", "Stage · shot frame");
    const paint = this._makeLayer("paint", "Paint");
    const mask = this._makeLayer("mask", "Inpaint mask");
    this.layers = [backdrop, stage, paint, mask];
    this.activeId = paint.id;
    this._fillBackdrop().then(() => this.render());
    this.refreshStage();
  }

  async _fillBackdrop() {
    const layer = this.layers.find((l) => l.kind === "backdrop");
    if (!layer) return;
    const bd = this.stage?.toJSON?.()?.backdrop;
    const url = typeof bd === "string" ? bd : bd?.url;
    layer.hasContent = false;
    if (!url) { this._renderLayers(); return; }
    try {
      const img = await loadImg(url);
      const ctx = layer.canvas.getContext("2d");
      ctx.clearRect(0, 0, this.EW, this.EH);
      const s = Math.max(this.W / img.width, this.H / img.height);   // cover the frame like a plate
      const w = img.width * s, h = img.height * s;
      ctx.drawImage(img, this.M + (this.W - w) / 2, this.M + (this.H - h) / 2, w, h);
      layer.hasContent = true; layer.thumbDirty = true;
    } catch { this.onStatus("Canvas: could not load the backdrop plate"); }
    this._renderLayers();
  }

  get active() { return this.layers.find((l) => l.id === this.activeId) || null; }
  get maskLayer() { return this.layers.find((l) => l.kind === "mask" && l.visible) || this.layers.find((l) => l.kind === "mask"); }
  _rasterLayers() { return this.layers.filter((l) => l.kind !== "mask"); }

  // ======================================================================= history
  _structSnap() {
    return { list: this.layers.map((l) => ({ l, props: { name: l.name, visible: l.visible, opacity: l.opacity, locked: l.locked, canvas: l.canvas } })),
      activeId: this.activeId, selection: this.selection, genBox: { ...this.genBox } };
  }

  _restoreStruct(s) {
    this.layers = s.list.map(({ l, props }) => { Object.assign(l, props); l.thumbDirty = true; this._markDirty(l); return l; });
    this.activeId = s.activeId; this.selection = s.selection; this.genBox = { ...s.genBox };
  }

  /** Record one undoable step. pixels: [[layer, rect(canvas px)]] patched in place; everything else via refs. */
  _record(label, mutate, pixels = []) {
    const before = this._structSnap();
    const patches = pixels.map(([layer, r]) => {
      const rr = r ? this._clampRect(r) : { x: 0, y: 0, w: this.EW, h: this.EH };
      return rr.w > 0 && rr.h > 0 ? { layer, r: rr, before: ctx2d(layer.canvas).getImageData(rr.x, rr.y, rr.w, rr.h) } : null;
    }).filter(Boolean);
    mutate();
    for (const p of patches) p.after = ctx2d(p.layer.canvas).getImageData(p.r.x, p.r.y, p.r.w, p.r.h);
    const after = this._structSnap();
    const bytes = patches.reduce((a, p) => a + p.before.data.length * 2, 0);
    this.undoStack.push({ label, before, after, patches, bytes });
    this.redoStack = [];
    let total = this.undoStack.reduce((a, e) => a + e.bytes, 0);
    while (this.undoStack.length > HISTORY_LIMIT || (total > HISTORY_BYTES && this.undoStack.length > 1)) total -= this.undoStack.shift().bytes;
    for (const p of patches) { p.layer.thumbDirty = true; this._markDirty(p.layer); }
    this._afterChange();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this._restoreStruct(e.before);
    for (const p of e.patches) { ctx2d(p.layer.canvas).putImageData(p.before, p.r.x, p.r.y); p.layer.thumbDirty = true; this._markDirty(p.layer); }
    this.redoStack.push(e);
    this.onStatus(`Undo: ${e.label}`);
    this._afterChange();
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this._restoreStruct(e.after);
    for (const p of e.patches) { ctx2d(p.layer.canvas).putImageData(p.after, p.r.x, p.r.y); p.layer.thumbDirty = true; this._markDirty(p.layer); }
    this.undoStack.push(e);
    this.onStatus(`Redo: ${e.label}`);
    this._afterChange();
  }

  _clampRect(r) {
    const x = clamp(Math.floor(r.x), 0, this.EW), y = clamp(Math.floor(r.y), 0, this.EH);
    return { x, y, w: clamp(Math.ceil(r.x + r.w), 0, this.EW) - x, h: clamp(Math.ceil(r.y + r.h), 0, this.EH) - y };
  }

  _afterChange() {
    this._ver = (this._ver || 0) + 1;
    this._renderGenMode();
    this._renderLayers();
    this._renderOptions();
    this.render();
    this._scheduleSave();
  }

  // ======================================================================= persistence (pixels on the pod)
  _markDirty(layer) { if (layer.kind === "paint" || layer.kind === "gen" || layer.kind === "mask") this._dirty.add(layer.id); }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 1500);
  }

  async _upload(blob, name, subfolder = "soundstage/canvas") {
    const fd = new FormData();
    fd.append("image", new File([blob], name, { type: "image/png" }));
    fd.append("subfolder", subfolder);
    fd.append("type", "input");
    fd.append("overwrite", "true");
    const res = await this.api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
    const d = await res.json();
    return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
  }

  async _save() {
    const ids = [...this._dirty];
    this._dirty.clear();
    for (const id of ids) {
      const layer = this.layers.find((l) => l.id === id);
      if (!layer) continue;
      try {
        const empty = !alphaBounds(layer.canvas);
        if (empty) { layer.file = null; continue; }
        layer.file = await this._upload(await toBlob(layer.canvas), `${this.docId}_${layer.id}.png`);
        layer.rev = (layer.rev || 0) + 1;
      } catch (e) { this._dirty.add(id); this.onStatus(`Canvas save failed: ${e.message}`); }
    }
    this.onChange?.(this.toJSON());
  }

  /** Plain fetch for long synchronous routes: ComfyUI's api.fetchApi aborts slow requests ("Fetch timeout"). */
  _longFetch(route, init) {
    return fetch(this.api.apiURL ? this.api.apiURL(route) : route, init);
  }

  _viewURL(path, type = "input", rev = 0) {
    const i = path.lastIndexOf("/");
    const q = new URLSearchParams({ filename: i < 0 ? path : path.slice(i + 1), subfolder: i < 0 ? "" : path.slice(0, i), type, r: String(rev) });
    return this.api.apiURL ? this.api.apiURL(`/view?${q}`) : `/view?${q}`;
  }

  // ======================================================================= composite
  /** Composite of visible raster layers for a world rect, scaled to (ow, oh). */
  composite(rect, ow = rect.w, oh = rect.h, { only = null, background = null } = {}) {
    const out = newCanvas(Math.round(ow), Math.round(oh));
    const ctx = out.getContext("2d");
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, out.width, out.height); }
    ctx.imageSmoothingQuality = "high";
    for (const l of only ? [only] : this._rasterLayers()) {
      if (!l.visible && !only) continue;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, rect.x + this.M, rect.y + this.M, rect.w, rect.h, 0, 0, out.width, out.height);
    }
    return out;
  }

  _maskCrop(rect, ow, oh) {
    const out = newCanvas(ow, oh);
    const m = this.maskLayer;
    if (m) out.getContext("2d").drawImage(m.canvas, rect.x + this.M, rect.y + this.M, rect.w, rect.h, 0, 0, ow, oh);
    return out;
  }

  // ======================================================================= UI
  _build(container) {
    this.root = el("div", { class: "ss-cv", tabindex: "0" });
    container.appendChild(this.root);
    this.optsEl = el("div", { class: "ss-cv-opts" });
    this.rail = el("div", { class: "ss-cv-rail", role: "toolbar", "aria-label": "Canvas tools" });
    this.toolBtns = {};
    for (const [id, ic, tip] of TOOLS) {
      const b = el("button", { class: "ss-cv-tool", type: "button", title: tip, "aria-label": tip, "aria-pressed": "false",
        onclick: () => this.setTool(id) }, icon(ic, 18));
      this.toolBtns[id] = b;
      this.rail.append(b);
    }
    this.viewEl = el("div", { class: "ss-cv-view" });
    this.cv = el("canvas");
    this.viewEl.append(this.cv);
    this.hud = el("div", { class: "ss-cv-hud" });
    this.prog = el("div", { class: "ss-cv-prog", role: "status" }, el("span", {}, ""), el("i", {}, el("b")));
    this.viewEl.append(this.hud, this.prog);
    this.side = el("div", { class: "ss-cv-side" });
    this.root.append(this.optsEl, this.rail, this.viewEl, this.side);
    this._buildSide();
    this._bindView();
    this._ro = new ResizeObserver(() => {
      const narrow = this.root.clientWidth < 680;
      this.root.classList.toggle("ss-cv-narrow", narrow);
      const r = this.viewEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (r.width > 0 && (this.cv.width !== Math.round(r.width * dpr) || this.cv.height !== Math.round(r.height * dpr))) {
        this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
        if (this._needFit || !this._userView) this.fit(); else this.render();
      }
    });
    this._ro.observe(this.root);
    this.setTool("brush");
  }

  _buildSide() {
    // ---- Layers
    this.layerList = el("div", { class: "ss-cv-layers", role: "listbox", "aria-label": "Layers" });
    const ib = (ic, tip, fn) => el("button", { class: "ss-cv-ib", type: "button", title: tip, "aria-label": tip, onclick: fn }, icon(ic, 15));
    this.opacityIn = el("input", { type: "range", min: 0, max: 1, step: 0.01, "aria-label": "Layer opacity" });
    this.opacityIn.addEventListener("input", () => { const l = this.active; if (l) { l.opacity = +this.opacityIn.value; this.render(); } });
    this.opacityIn.addEventListener("change", () => { const l = this.active; if (!l) return; const v = l.opacity; l.opacity = this._opacityStart ?? v;
      this._record("Opacity", () => { l.opacity = v; }); this._opacityStart = null; });
    this.opacityIn.addEventListener("pointerdown", () => { this._opacityStart = this.active?.opacity; });
    const layerTools = el("div", { class: "ss-cv-row" },
      ib("plus", "New paint layer", () => this.addLayer()),
      ib("copy", "Duplicate layer", () => this.duplicateLayer()),
      ib("merge", "Merge down", () => this.mergeDown()),
      ib("chevron-up", "Move layer up", () => this.moveLayer(1)),
      ib("chevron-down", "Move layer down", () => this.moveLayer(-1)),
      ib("trash-2", "Delete layer", () => this.deleteLayer()),
      ib("refresh", "Re-render the Stage layer at the playhead", () => this.refreshStage()),
    );
    this.liftRow = el("div", { class: "ss-cv-row" }, el("span", { class: "ss-cv-note", style: "flex:1" }, "Lift layer / selection to 3D"),
      el("button", { class: "ss-cv-btn", type: "button", title: "Flat cut-out card in the 3D stage", onclick: () => this.lift("card") }, icon("square", 13), "Card"),
      el("button", { class: "ss-cv-btn", type: "button", title: "Gaussian splat (TripoSplat)", onclick: () => this.lift("splat") }, icon("sparkles", 13), "Splat"),
      el("button", { class: "ss-cv-btn", type: "button", title: "Mesh (image to 3D)", onclick: () => this.lift("mesh") }, icon("box", 13), "Mesh"));
    this.liftRow.hidden = !this.liftTo3D;
    const layersCard = el("div", { class: "ss-cv-card" },
      el("div", { class: "ss-cv-head" }, icon("layers", 14), el("span", {}, "Layers")),
      this.layerList,
      el("div", { class: "ss-cv-row" }, el("label", {}, "Opacity", this.opacityIn)),
      layerTools, this.liftRow);

    // ---- Prompt / generate
    this.posIn = el("textarea", { rows: 3, placeholder: "What to paint in the generation box", "aria-label": "Positive prompt" });
    this.negIn = el("textarea", { rows: 2, placeholder: "Negative (optional)", "aria-label": "Negative prompt" });
    this.posIn.addEventListener("input", () => { this.gen.positive = this.posIn.value; this._scheduleSave(); });
    this.negIn.addEventListener("input", () => { this.gen.negative = this.negIn.value; this._scheduleSave(); });
    this.modelSel = el("select", { "aria-label": "Model preset", onchange: () => { this.gen.model = this.modelSel.value; this._fillModels(); this._scheduleSave(); } });
    this.stepsIn = el("input", { type: "number", min: 0, max: 80, step: 1, title: "0 = the model's default", "aria-label": "Steps",
      oninput: () => { this.gen.steps = +this.stepsIn.value || 0; } });
    this.seedIn = el("input", { type: "number", min: 0, step: 1, "aria-label": "Seed", oninput: () => { this.gen.seed = +this.seedIn.value || 0; } });
    this.denoiseIn = el("input", { type: "range", min: 0.05, max: 1, step: 0.05, "aria-label": "Denoise (img2img)",
      oninput: () => { this.gen.denoise = +this.denoiseIn.value; this.denoiseOut.textContent = this.gen.denoise.toFixed(2); } });
    this.denoiseOut = el("output");
    this.genBtn = el("button", { class: "ss-cv-cta", type: "button", onclick: () => this.generate() }, icon("sparkles", 15), el("span", {}, "Generate"));
    this.genNote = el("div", { class: "ss-cv-note" });
    this.genWarn = el("div", { class: "ss-cv-warn" });
    const promptCard = el("div", { class: "ss-cv-card" },
      el("div", { class: "ss-cv-head" }, icon("sparkles", 14), el("span", {}, "Generate")),
      this.posIn, this.negIn,
      el("div", { class: "ss-cv-grid2" },
        el("label", { style: "grid-column:1 / -1" }, "Model", this.modelSel),
        el("label", {}, "Steps (0 = default)", this.stepsIn),
        el("label", {}, el("span", { style: "display:flex;justify-content:space-between" }, "Seed",
          el("button", { class: "ss-cv-ib", type: "button", title: "Random seed", "aria-label": "Random seed",
            onclick: () => { this.gen.seed = Math.floor(Math.random() * 2 ** 31); this.seedIn.value = this.gen.seed; } }, icon("dices", 13))), this.seedIn)),
      el("div", { class: "ss-cv-row" }, el("label", {}, "Denoise", this.denoiseIn, this.denoiseOut)),
      this.genNote, this.genBtn, this.genWarn);

    // ---- Use as look still
    this.boxOnly = el("input", { type: "checkbox", "aria-label": "Only the generation box" });
    this.useBtn = el("button", { class: "ss-cv-cta", type: "button", onclick: () => this.useAsLookStill() }, icon("check", 15), el("span", {}, "Use as look still"));
    const r2 = el("button", { class: "ss-cv-btn", type: "button", title: "Bring the last rung-2 look still in as a layer to fix it",
      onclick: () => this.importRung2() }, icon("image", 13), "Import rung-2 still");
    const up = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: async () => {
      const f = up.files?.[0]; up.value = ""; if (f) await this.importImage(URL.createObjectURL(f), f.name.replace(/\.[^.]+$/, "")); } });
    const outCard = el("div", { class: "ss-cv-card" },
      el("div", { class: "ss-cv-head" }, icon("image", 14), el("span", {}, "Image")),
      el("div", { class: "ss-cv-row" }, r2, el("button", { class: "ss-cv-btn", type: "button", onclick: () => up.click() }, icon("upload", 13), "Import file…"), up),
      el("label", { class: "ss-cv-note", style: "display:flex;gap:6px;align-items:center" }, this.boxOnly, "Only inside the generation box"),
      this.useBtn);
    this.side.append(layersCard, promptCard, outCard);
    this._syncPromptInputs();
  }

  _syncPromptInputs() {
    if (!this.posIn) return;
    this.posIn.value = this.gen.positive || "";
    this.negIn.value = this.gen.negative || "";
    this.stepsIn.value = this.gen.steps || 0;
    this.seedIn.value = this.gen.seed || 0;
    this.denoiseIn.value = this.gen.denoise ?? 0.65;
    this.denoiseOut.textContent = (+this.denoiseIn.value).toFixed(2);
    if (this.modelSel.querySelector(`option[value="${this.gen.model}"]`)) this.modelSel.value = this.gen.model;
  }

  setTool(id) {
    this.tool = id;
    for (const [k, b] of Object.entries(this.toolBtns)) b.setAttribute("aria-pressed", String(k === id));
    this.viewEl.style.cursor = id === "pan" ? "grab" : id === "transform" ? "move" : "crosshair";
    this._renderOptions();
    this.render();
  }

  _renderOptions() {
    const o = this.optsEl;
    o.replaceChildren();
    const range = (label, key, min, max, step, fmt = (v) => v) => {
      const out = el("output", {}, String(fmt(this.brush[key])));
      const inp = el("input", { type: "range", min, max, step, value: this.brush[key], "aria-label": label,
        oninput: () => { this.brush[key] = +inp.value; out.textContent = fmt(this.brush[key]); this.render(); } });
      return el("label", {}, label, inp, out);
    };
    const btn = (label, fn, ic, tip) => el("button", { class: "ss-cv-btn", type: "button", title: tip || label, onclick: fn }, ic ? icon(ic, 13) : null, label);
    if (["brush", "eraser", "mask"].includes(this.tool)) {
      o.append(range("Size", "size", 1, 400, 1), range("Hardness", "hardness", 0, 1, 0.05, (v) => (+v).toFixed(2)),
        range("Opacity", "opacity", 0.05, 1, 0.05, (v) => (+v).toFixed(2)));
      if (this.tool === "brush") {
        const c = el("input", { type: "color", value: this.brush.color, "aria-label": "Brush colour", oninput: () => { this.brush.color = c.value; } });
        o.append(el("label", {}, "Colour", c));
      }
      if (this.tool === "mask") o.append(btn("Clear mask", () => this.clearMask(), "trash-2"));
    } else if (this.tool === "magic") {
      const engine = el("select", { "aria-label": "Magic mask engine", style: "width:auto", onchange: () => { this.magic.engine = engine.value; } },
        el("option", { value: "local", disabled: !this.sam.local }, "SAM 3.1 · local"),
        el("option", { value: "vnccs", disabled: !this.vnccs.ok }, "VNCCS SAM2 (downloads ~0.9 GB once)"));
      engine.value = this.magic.engine;
      o.append(el("span", { class: "ss-cv-note" }, `${this.magic.points.filter((p) => p.label).length} in · ${this.magic.points.filter((p) => !p.label).length} out`),
        engine,
        el("button", { class: "ss-cv-btn", type: "button", disabled: !this.magic.points.length || this.magic.busy, onclick: () => this.runMagic() },
          icon("wand-sparkles", 13), this.magic.busy ? "Selecting…" : "Select"),
        btn("Clear points", () => { this.magic.points = []; this._renderOptions(); this.render(); }));
      if (!this.sam.local && this.magic.engine === "local") o.append(el("span", { class: "ss-cv-warn" }, this.sam.reason || "SAM 3.1 not found"));
    } else if (this.tool === "genbox") {
      o.append(el("span", { class: "ss-cv-note" }, `Box ${Math.round(this.genBox.w)}×${Math.round(this.genBox.h)} at ${Math.round(this.genBox.x)},${Math.round(this.genBox.y)}`),
        btn("Frame", () => this._record("Box = frame", () => { this.genBox = { x: 0, y: 0, w: this.W, h: this.H }; })),
        btn("Selection", () => this.boxToSelection(), null, "Fit the box to the selection"));
    } else if (this.tool === "picker") {
      o.append(el("span", { class: "ss-cv-note" }, "Click to pick a colour"), el("span", { style: `width:22px;height:22px;border-radius:6px;background:${this.brush.color};border:1px solid rgba(255,255,255,.2)` }));
    } else if (this.tool === "transform") {
      o.append(el("span", { class: "ss-cv-note" }, this.selection ? "Drag moves the selected pixels onto a new layer" : "Drag moves the active layer; corners scale"));
    }
    if (this.selection) {
      o.append(el("span", { class: "ss-cv-chip" }, "Selection"),
        btn("To mask", () => this.selectionToMask(), "highlighter"),
        btn("Cut to layer", () => this.selectionToLayer(true), "scissors"),
        btn("Copy to layer", () => this.selectionToLayer(false), "copy"),
        btn("Erase", () => this.deleteSelected(), "eraser"),
        btn("Invert", () => this.invertSelection()),
        btn("Deselect", () => this.deselect(), "x"));
    }
    o.append(el("span", { class: "ss-cv-spacer" }),
      el("button", { class: "ss-cv-ib", type: "button", title: "Undo (Ctrl/Cmd+Z)", "aria-label": "Undo", disabled: !this.undoStack.length, onclick: () => this.undo() }, icon("undo-2", 15)),
      el("button", { class: "ss-cv-ib", type: "button", title: "Redo (Shift+Ctrl/Cmd+Z)", "aria-label": "Redo", disabled: !this.redoStack.length, onclick: () => this.redo() }, icon("redo-2", 15)),
      el("button", { class: "ss-cv-ib", type: "button", title: "Fit view (F)", "aria-label": "Fit view", onclick: () => this.fit() }, icon("scan", 15)));
  }

  _renderLayers() {
    const rows = [];
    for (const l of [...this.layers].reverse()) {
      if (l.kind === "backdrop" && !l.hasContent) continue;
      const thumb = el("canvas", { width: 80, height: 48 });
      const tc = thumb.getContext("2d");
      const th = Math.min(48, Math.round((80 * this.H) / this.W));
      tc.drawImage(l.canvas, this.M, this.M, this.W, this.H, 0, (48 - th) / 2, 80, th);
      if (l.kind === "mask") { tc.globalCompositeOperation = "source-in"; tc.fillStyle = "#ff4d6d"; tc.fillRect(0, 0, 80, 48); }
      const eye = el("button", { class: "ss-cv-ib", type: "button", title: l.visible ? "Hide" : "Show", "aria-label": `${l.visible ? "Hide" : "Show"} ${l.name}`,
        onclick: (e) => { e.stopPropagation(); this._record(l.visible ? "Hide layer" : "Show layer", () => { l.visible = !l.visible; }); } },
        icon(l.visible ? "eye" : "eye-off", 15));
      const name = el("div", { class: "ss-cv-name", title: "Double-click to rename" }, l.name);
      name.addEventListener("dblclick", (e) => { e.stopPropagation(); this.renameLayer(l); });
      const lock = el("button", { class: "ss-cv-ib", type: "button", title: l.locked ? "Unlock" : "Lock", "aria-label": `${l.locked ? "Unlock" : "Lock"} ${l.name}`,
        onclick: (e) => { e.stopPropagation(); this._record(l.locked ? "Unlock" : "Lock", () => { l.locked = !l.locked; }); } }, icon(l.locked ? "lock" : "lock-open", 14));
      const row = el("div", { class: "ss-cv-layer", role: "option", "aria-selected": String(l.id === this.activeId), onclick: () => { this.activeId = l.id; this._renderLayers(); this._renderOptions(); } },
        eye, thumb, el("div", { style: "min-width:0" }, name, el("div", { class: "ss-cv-kind" }, { backdrop: "plate", stage: `stage · ${l.stageMode}`, paint: "paint", gen: "generated", mask: "mask" }[l.kind] || l.kind)), lock);
      if (l.kind === "stage") {
        row.title = "Click the kind label to switch colour / clay";
        row.querySelector(".ss-cv-kind").addEventListener("click", (e) => { e.stopPropagation(); l.stageMode = l.stageMode === "color" ? "clay" : "color"; this.refreshStage(); });
      }
      rows.push(row);
    }
    this.layerList.replaceChildren(...rows);
    const a = this.active;
    this.opacityIn.value = a ? a.opacity : 1;
    this.opacityIn.disabled = !a;
  }

  // ======================================================================= layer ops
  addLayer(kind = "paint", name = null, canvas = null) {
    const l = this._makeLayer(kind, name || `${kind === "gen" ? "Generated" : "Paint"} ${this.layers.filter((x) => x.kind === kind).length + 1}`);
    if (canvas) l.canvas = canvas;
    this._record("New layer", () => {
      const at = this.layers.findIndex((x) => x.id === this.activeId);
      const idx = at < 0 ? this.layers.length : Math.min(at + 1, this.layers.length);
      const firstMask = this.layers.findIndex((x) => x.kind === "mask");
      this.layers.splice(firstMask >= 0 && idx > firstMask ? firstMask : idx, 0, l);
      this.activeId = l.id;
    });
    this._markDirty(l);
    return l;
  }

  duplicateLayer() {
    const a = this.active;
    if (!a || a.kind === "mask") return;
    const l = this._makeLayer(a.kind === "stage" || a.kind === "backdrop" ? "paint" : a.kind, `${a.name} copy`);
    l.canvas = cloneCanvas(a.canvas);
    l.opacity = a.opacity;
    this._record("Duplicate layer", () => { this.layers.splice(this.layers.indexOf(a) + 1, 0, l); this.activeId = l.id; });
    this._markDirty(l);
  }

  mergeDown() {
    const a = this.active;
    const i = this.layers.indexOf(a);
    const below = this.layers[i - 1];
    if (!a || !below || a.kind === "mask" || below.kind === "mask") return;
    const merged = cloneCanvas(below.canvas);
    const ctx = merged.getContext("2d");
    ctx.globalAlpha = a.opacity;
    ctx.drawImage(a.canvas, 0, 0);
    const kind = below.kind === "stage" || below.kind === "backdrop" ? "paint" : below.kind;
    const nl = this._makeLayer(kind, below.kind === kind ? below.name : `${below.name} + ${a.name}`);
    nl.canvas = merged; nl.opacity = below.opacity;
    this._record("Merge down", () => { this.layers.splice(i - 1, 2, nl); this.activeId = nl.id; });
    this._markDirty(nl);
  }

  moveLayer(dir) {
    const a = this.active;
    const i = this.layers.indexOf(a);
    const j = i + dir;
    if (!a || j < 0 || j >= this.layers.length) return;
    this._record("Reorder layers", () => { [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]]; });
  }

  deleteLayer() {
    const a = this.active;
    if (!a || (a.kind === "mask" && this.layers.filter((l) => l.kind === "mask").length === 1)) { this.onStatus("Keep one mask layer (clear it instead)"); return; }
    const i = this.layers.indexOf(a);
    this._record("Delete layer", () => {
      this.layers.splice(i, 1);
      this.activeId = (this.layers[i - 1] || this.layers[0])?.id;
    });
  }

  renameLayer(l) {
    const name = prompt("Layer name", l.name);
    if (name && name.trim() && name !== l.name) this._record("Rename layer", () => { l.name = name.trim(); });
  }

  clearMask() {
    const m = this.maskLayer;
    if (!m) return;
    this._record("Clear mask", () => { m.canvas.getContext("2d").clearRect(0, 0, this.EW, this.EH); }, [[m, null]]);
  }

  async importImage(src, name = "Image") {
    try {
      const img = await loadImg(src);
      const c = newCanvas(this.EW, this.EH);
      const s = Math.min(this.W / img.width, this.H / img.height);
      const w = img.width * s, h = img.height * s;
      c.getContext("2d").drawImage(img, this.M + (this.W - w) / 2, this.M + (this.H - h) / 2, w, h);
      this.addLayer("paint", name, c);
      this.onStatus(`Imported ${name}`);
    } catch { this.onStatus("Could not load that image"); }
  }

  async importRung2() {
    const img = this.app ? lastRung2Image(this.app) : null;
    if (!img) { this.onStatus("No rung-2 look still yet: run the ladder to rung 2 first"); return; }
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "temp" });
    await this.importImage(this.api.apiURL ? this.api.apiURL(`/view?${q}`) : `/view?${q}`, "Look still (rung 2)");
  }

  // ======================================================================= selection
  _newSel() { return newCanvas(this.EW, this.EH); }

  /** Combine a shape into the selection: mode replace | add | sub. draw(ctx) fills the shape in canvas px. */
  _applySelection(draw, mode, label) {
    const next = mode === "replace" || !this.selection ? this._newSel() : cloneCanvas(this.selection);
    const ctx = next.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
    draw(ctx);
    const empty = !alphaBounds(next);
    this._record(label, () => { this.selection = empty ? null : next; });
  }

  deselect() { if (this.selection) this._record("Deselect", () => { this.selection = null; }); }

  invertSelection() {
    const next = this._newSel();
    const ctx = next.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, this.EW, this.EH);
    if (this.selection) { ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(this.selection, 0, 0); }
    this._record("Invert selection", () => { this.selection = next; });
  }

  selectionToMask() {
    const m = this.maskLayer;
    if (!m || !this.selection) return;
    this._record("Selection to mask", () => {
      const ctx = m.canvas.getContext("2d");
      const tint = cloneCanvas(this.selection);
      const t = tint.getContext("2d"); t.globalCompositeOperation = "source-in"; t.fillStyle = "#fff"; t.fillRect(0, 0, this.EW, this.EH);
      ctx.drawImage(tint, 0, 0);
      m.visible = true;
    }, [[m, null]]);
    this.onStatus("Selection added to the inpaint mask");
  }

  /** Pixels of the active layer (or the composite) inside the selection -> a new layer. */
  selectionToLayer(cut) {
    if (!this.selection) return;
    const a = this.active;
    const src = a && a.kind !== "mask" ? a : null;
    const c = newCanvas(this.EW, this.EH);
    const ctx = c.getContext("2d");
    if (src) { ctx.globalAlpha = 1; ctx.drawImage(src.canvas, 0, 0); }
    else for (const l of this._rasterLayers()) if (l.visible) { ctx.globalAlpha = l.opacity; ctx.drawImage(l.canvas, 0, 0); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(this.selection, 0, 0);
    const l = this._makeLayer("paint", `${src ? src.name : "Composite"} (${cut ? "cut" : "copy"})`);
    l.canvas = c;
    const canCut = cut && src && !src.locked;
    const newSrc = canCut ? cloneCanvas(src.canvas) : null;
    if (newSrc) { const s = newSrc.getContext("2d"); s.globalCompositeOperation = "destination-out"; s.drawImage(this.selection, 0, 0); }
    this._record(cut ? "Cut to layer" : "Copy to layer", () => {
      if (newSrc) src.canvas = newSrc;
      const i = src ? this.layers.indexOf(src) + 1 : this.layers.findIndex((x) => x.kind === "mask");
      this.layers.splice(i < 0 ? this.layers.length : i, 0, l);
      this.activeId = l.id;
      this.selection = null;
    });
    if (newSrc) this._markDirty(src);
    this._markDirty(l);
    if (cut && src?.locked) this.onStatus(`${src.name} is locked, so the pixels were copied, not cut`);
  }

  deleteSelected() {
    const a = this.active;
    if (!this.selection || !a || a.locked) { this.onStatus(a?.locked ? `${a.name} is locked` : "Nothing selected"); return; }
    const next = cloneCanvas(a.canvas);
    const ctx = next.getContext("2d"); ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(this.selection, 0, 0);
    this._record("Erase selection", () => { a.canvas = next; });
    this._markDirty(a);
  }

  boxToSelection() {
    const b = this.selection && alphaBounds(this.selection);
    if (!b) { this.onStatus("No selection"); return; }
    this._record("Box = selection", () => { this.genBox = { x: snap(b.x - this.M), y: snap(b.y - this.M), w: Math.max(64, snap(b.w)), h: Math.max(64, snap(b.h)) }; });
  }

  // ======================================================================= view + input
  w2s(x, y) { return [x * this.view.s + this.view.tx, y * this.view.s + this.view.ty]; }
  s2w(x, y) { return [(x - this.view.tx) / this.view.s, (y - this.view.ty) / this.view.s]; }
  _evWorld(e) { const r = this.cv.getBoundingClientRect(); return this.s2w(e.clientX - r.left, e.clientY - r.top); }

  _bindView() {
    const v = this.viewEl;
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.addEventListener("pointerdown", (e) => this._down(e));
    v.addEventListener("pointermove", (e) => this._move(e));
    v.addEventListener("pointerup", (e) => this._up(e));
    v.addEventListener("pointercancel", (e) => this._up(e));
    v.addEventListener("pointerleave", () => { this._hover = null; this.render(); });
    // ComfyUI's canvas eats wheel events over DOM widgets; route wheel-over-canvas here (capture phase).
    this._wheelRouter = (e) => {
      if (!this.viewEl.contains(e.target)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const r = this.cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
        const s = clamp(this.view.s * k, 0.05, 32);
        const [wx, wy] = this.s2w(sx, sy);
        this.view.s = s; this.view.tx = sx - wx * s; this.view.ty = sy - wy * s;
      } else { this.view.tx -= e.deltaX || e.deltaY; }
      this._userView = true;
      this.render();
    };
    window.addEventListener("wheel", this._wheelRouter, { capture: true, passive: false });
    const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    this._keyRouter = (e) => {
      if (!this.root.contains(document.activeElement) && !this._overView) return;
      if (typing(e.target)) return;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if (mod && k === "z") (e.shiftKey ? this.redo() : this.undo());
      else if (mod && k === "y") this.redo();
      else if (mod && k === "d") this.deselect();
      else if (e.key === " ") { if (!this._spacePan) { this._spacePan = true; this.viewEl.style.cursor = "grab"; } }
      else if (e.key === "Escape") { if (this.magic.points.length && this.tool === "magic") { this.magic.points = []; this._renderOptions(); this.render(); } else this.deselect(); }
      else if (e.key === "Delete" || e.key === "Backspace") this.deleteSelected();
      else if (e.key === "[") { this.brush.size = Math.max(1, Math.round(this.brush.size / 1.2)); this._renderOptions(); this.render(); }
      else if (e.key === "]") { this.brush.size = Math.min(400, Math.round(this.brush.size * 1.2)); this._renderOptions(); this.render(); }
      else if (k === "f" && !mod) this.fit();
      else if (!mod && KEYS[k]) this.setTool(KEYS[k]);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    this._keyUpRouter = (e) => { if (e.key === " " && this._spacePan) { this._spacePan = false; this.setTool(this.tool); } };
    window.addEventListener("keydown", this._keyRouter, true);
    window.addEventListener("keyup", this._keyUpRouter, true);
    v.addEventListener("pointerenter", () => { this._overView = true; });
    v.addEventListener("pointerleave", () => { this._overView = false; });
  }

  _down(e) {
    this.root.focus({ preventScroll: true });
    const [wx, wy] = this._evWorld(e);
    const pan = e.button === 1 || this._spacePan || this.tool === "pan";
    this.viewEl.setPointerCapture(e.pointerId);
    if (pan) { this._drag = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty }; this.viewEl.style.cursor = "grabbing"; return; }
    if (e.button === 2 && this.tool !== "magic") return;
    const mode = e.shiftKey ? "add" : e.altKey ? "sub" : "replace";
    switch (this.tool) {
      case "brush": case "eraser": case "mask": this._strokeStart(wx, wy, e); break;
      case "picker": this._pick(wx, wy); break;
      case "rect": this._drag = { kind: "rect", x0: wx, y0: wy, x1: wx, y1: wy, mode }; break;
      case "lasso": this._drag = { kind: "lasso", pts: [[wx, wy]], mode }; break;
      case "magic": {
        const label = e.button === 2 || e.shiftKey || e.altKey ? 0 : 1;
        this.magic.points.push({ x: wx, y: wy, label });
        this._renderOptions(); this.render();
        break;
      }
      case "genbox": this._genboxStart(wx, wy); break;
      case "transform": this._transformStart(wx, wy, e); break;
    }
  }

  _move(e) {
    const [wx, wy] = this._evWorld(e);
    this._hover = [wx, wy];
    const d = this._drag;
    if (!d) { if (["brush", "eraser", "mask"].includes(this.tool)) this.render(); return; }
    if (d.kind === "pan") { this.view.tx = d.tx + e.clientX - d.sx; this.view.ty = d.ty + e.clientY - d.sy; this._userView = true; }
    else if (d.kind === "stroke") this._strokeTo(wx, wy);
    else if (d.kind === "rect") { d.x1 = wx; d.y1 = wy; }
    else if (d.kind === "lasso") { const l = d.pts[d.pts.length - 1]; if (Math.hypot(wx - l[0], wy - l[1]) * this.view.s > 3) d.pts.push([wx, wy]); }
    else if (d.kind === "genbox") this._genboxMove(wx, wy, e);
    else if (d.kind === "transform") this._transformMove(wx, wy, e);
    this.render();
  }

  _up(e) {
    const d = this._drag;
    this._drag = null;
    try { this.viewEl.releasePointerCapture(e.pointerId); } catch {}
    if (!d) return;
    if (d.kind === "pan") { this.setTool(this.tool); return; }
    if (d.kind === "stroke") this._strokeEnd();
    else if (d.kind === "rect") {
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w * this.view.s < 3 || h * this.view.s < 3) { if (d.mode === "replace") this.deselect(); }
      else this._applySelection((c) => c.fillRect(x + this.M, y + this.M, w, h), d.mode, "Rectangle select");
    } else if (d.kind === "lasso") {
      if (d.pts.length > 2) this._applySelection((c) => { c.beginPath(); d.pts.forEach(([x, y], i) => (i ? c.lineTo(x + this.M, y + this.M) : c.moveTo(x + this.M, y + this.M))); c.closePath(); c.fill(); }, d.mode, "Lasso select");
    } else if (d.kind === "genbox") this._genboxEnd(d);
    else if (d.kind === "transform") this._transformEnd(d);
    this.render();
  }

  // ---- brush
  _strokeStart(wx, wy) {
    const target = this.tool === "mask" ? this.maskLayer : this.active;
    if (!target) { this.onStatus("Pick a layer first"); return; }
    if (target.kind !== "mask" && this.tool === "mask") return;
    if (target.locked) { this.onStatus(`${target.name} is locked: unlock it or add a paint layer`); return; }
    this._stroke = { target, canvas: newCanvas(this.EW, this.EH), last: null, bbox: null, erase: this.tool === "eraser" };
    if (this.tool === "mask" && !target.visible) target.visible = true;
    this._drag = { kind: "stroke" };
    this._strokeTo(wx, wy);
  }

  _stamp(x, y) {
    const s = this._stroke;
    const ctx = s.canvas.getContext("2d");
    const r = this.brush.size / 2;
    const cx = x + this.M, cy = y + this.M;
    const color = s.target.kind === "mask" || s.erase ? "#ffffff" : this.brush.color;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const h = clamp(this.brush.hardness, 0, 0.999);
    g.addColorStop(0, color); g.addColorStop(h, color); g.addColorStop(1, color + "00");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    const b = { x: cx - r - 2, y: cy - r - 2, w: 2 * r + 4, h: 2 * r + 4 };
    if (!s.bbox) s.bbox = b;
    else { const x0 = Math.min(s.bbox.x, b.x), y0 = Math.min(s.bbox.y, b.y); s.bbox = { x: x0, y: y0, w: Math.max(s.bbox.x + s.bbox.w, b.x + b.w) - x0, h: Math.max(s.bbox.y + s.bbox.h, b.y + b.h) - y0 }; }
  }

  _strokeTo(wx, wy) {
    const s = this._stroke;
    if (!s) return;
    if (!s.last) { this._stamp(wx, wy); s.last = [wx, wy]; return; }
    const [lx, ly] = s.last;
    const dist = Math.hypot(wx - lx, wy - ly);
    const step = Math.max(0.5, this.brush.size * 0.12);
    if (dist < step) return;
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) this._stamp(lx + ((wx - lx) * i) / n, ly + ((wy - ly) * i) / n);
    s.last = [wx, wy];
  }

  _strokeEnd() {
    const s = this._stroke;
    this._stroke = null;
    if (!s?.bbox) return;
    if (this.selection) { const c = s.canvas.getContext("2d"); c.globalCompositeOperation = "destination-in"; c.drawImage(this.selection, 0, 0); }
    const label = s.erase ? "Erase" : s.target.kind === "mask" ? "Mask stroke" : "Brush stroke";
    this._record(label, () => {
      const ctx = s.target.canvas.getContext("2d");
      ctx.save();
      ctx.globalAlpha = this.brush.opacity;
      ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      ctx.drawImage(s.canvas, 0, 0);
      ctx.restore();
    }, [[s.target, s.bbox]]);
  }

  _pick(wx, wy) {
    const c = this.composite({ x: Math.floor(wx), y: Math.floor(wy), w: 1, h: 1 }, 1, 1);
    const [r, g, b, a] = ctx2d(c).getImageData(0, 0, 1, 1).data;
    if (!a) return;
    this.brush.color = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
    this.onStatus(`Picked ${this.brush.color}`);
    this.setTool("brush");
  }

  // ---- generation box
  _boxHandle(wx, wy, b) {
    const tol = 10 / this.view.s;
    const corners = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
    for (const [k, [x, y]] of Object.entries(corners)) if (Math.abs(wx - x) < tol && Math.abs(wy - y) < tol) return k;
    if (wx > b.x && wx < b.x + b.w && wy > b.y && wy < b.y + b.h) return "move";
    return null;
  }

  _genboxStart(wx, wy) {
    const h = this._boxHandle(wx, wy, this.genBox);
    this._drag = { kind: "genbox", h: h || "new", x0: wx, y0: wy, box: { ...this.genBox } };
  }

  _genboxMove(wx, wy) {
    const d = this._drag, b0 = d.box;
    let b;
    if (d.h === "new") b = { x: Math.min(d.x0, wx), y: Math.min(d.y0, wy), w: Math.abs(wx - d.x0), h: Math.abs(wy - d.y0) };
    else if (d.h === "move") b = { ...b0, x: b0.x + wx - d.x0, y: b0.y + wy - d.y0 };
    else {
      let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
      if (d.h.includes("w")) x0 = wx; if (d.h.includes("e")) x1 = wx; if (d.h.includes("n")) y0 = wy; if (d.h.includes("s")) y1 = wy;
      b = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    const lim = (v, lo, hi) => clamp(v, lo, hi);
    b.x = lim(snap(b.x), -this.M, this.W + this.M - 64); b.y = lim(snap(b.y), -this.M, this.H + this.M - 64);
    b.w = lim(Math.max(64, snap(b.w)), 64, this.W + this.M - b.x); b.h = lim(Math.max(64, snap(b.h)), 64, this.H + this.M - b.y);
    d.live = b;
  }

  _genboxEnd(d) {
    if (!d.live) return;
    this._record("Generation box", () => { this.genBox = d.live; });
  }

  // ---- transform
  _transformStart(wx, wy) {
    let a = this.active;
    if (!a || a.kind === "mask") { this.onStatus("Pick a layer to transform"); return; }
    if (this.selection) { this.selectionToLayer(!a.locked); a = this.active; }
    else if (a.locked) { this.onStatus(`${a.name} is locked: unlock it to move it`); return; }
    const bb = alphaBounds(a.canvas);
    if (!bb) return;
    const box = { x: bb.x - this.M, y: bb.y - this.M, w: bb.w, h: bb.h };
    const h = this._boxHandle(wx, wy, box) || "move";
    this._drag = { kind: "transform", layer: a, h, x0: wx, y0: wy, box, live: { ...box } };
  }

  _transformMove(wx, wy, e) {
    const d = this._drag, b = d.box;
    if (d.h === "move") { d.live = { ...b, x: b.x + wx - d.x0, y: b.y + wy - d.y0 }; return; }
    const ax = d.h.includes("w") ? b.x + b.w : b.x, ay = d.h.includes("n") ? b.y + b.h : b.y;   // the fixed corner
    let w = Math.abs(wx - ax), h = Math.abs(wy - ay);
    if (e.shiftKey) { const s = Math.max(w / b.w, h / b.h); w = b.w * s; h = b.h * s; }
    d.live = { x: wx < ax ? ax - w : ax, y: wy < ay ? ay - h : ay, w: Math.max(4, w), h: Math.max(4, h) };
  }

  _transformEnd(d) {
    const { layer, box, live } = d;
    if (Math.abs(live.x - box.x) < 0.5 && Math.abs(live.y - box.y) < 0.5 && Math.abs(live.w - box.w) < 0.5 && Math.abs(live.h - box.h) < 0.5) return;
    const next = newCanvas(this.EW, this.EH);
    const ctx = next.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(layer.canvas, box.x + this.M, box.y + this.M, box.w, box.h, live.x + this.M, live.y + this.M, live.w, live.h);
    this._record("Transform", () => { layer.canvas = next; });
    this._markDirty(layer);
  }

  // ======================================================================= render
  render() {
    if (this._raf) return;
    const run = () => { if (!this._raf) return; cancelAnimationFrame(this._raf); clearTimeout(this._rafTO); this._raf = null; this._draw(); };
    this._raf = requestAnimationFrame(run);
    this._rafTO = setTimeout(run, 150);   // rAF never fires in a hidden / background tab
  }

  _draw() {
    const c = this.cv, ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr * this.view.s, 0, 0, dpr * this.view.s, dpr * this.view.tx, dpr * this.view.ty);
    const s = this.view.s;
    // checkerboard over the canvas extent, darker outside the frame
    ctx.fillStyle = "#1a1420"; ctx.fillRect(-this.M, -this.M, this.EW, this.EH);
    if (!this._checker) {
      const p = newCanvas(16, 16), pc = p.getContext("2d");
      pc.fillStyle = "#2b2431"; pc.fillRect(0, 0, 16, 16); pc.fillStyle = "#231d29"; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
      this._checker = ctx.createPattern(p, "repeat");
    }
    ctx.fillStyle = this._checker; ctx.fillRect(0, 0, this.W, this.H);
    ctx.imageSmoothingEnabled = s < 2;
    const d = this._drag;
    for (const l of this.layers) {
      if (!l.visible || l.kind === "mask") continue;
      ctx.globalAlpha = l.opacity;
      if (d?.kind === "transform" && d.layer === l) {
        ctx.drawImage(l.canvas, d.box.x + this.M, d.box.y + this.M, d.box.w, d.box.h, d.live.x, d.live.y, d.live.w, d.live.h);
        continue;
      }
      ctx.drawImage(l.canvas, -this.M, -this.M);
      if (this._stroke && this._stroke.target === l) {
        ctx.globalAlpha = l.opacity * this.brush.opacity;
        if (this._stroke.erase) {
          // preview erase: draw the background colour where erasing
          ctx.save(); ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(this._stroke.canvas, -this.M, -this.M); ctx.restore();
        } else ctx.drawImage(this._stroke.canvas, -this.M, -this.M);
      }
    }
    ctx.globalAlpha = 1;
    // masks: red overlay
    for (const l of this.layers) {
      if (!l.visible || l.kind !== "mask") continue;
      ctx.globalAlpha = 0.45;
      ctx.drawImage(this._tinted(l.canvas, "#ff4d6d"), -this.M, -this.M);
      if (this._stroke?.target === l) ctx.drawImage(this._tinted(this._stroke.canvas, "#ff4d6d"), -this.M, -this.M);
    }
    ctx.globalAlpha = 1;
    // selection
    if (this.selection) {
      ctx.globalAlpha = 0.22; ctx.drawImage(this._tinted(this.selection, "#f2ff59"), -this.M, -this.M); ctx.globalAlpha = 1;
      if (this._selBoundsFor !== this.selection) { this._selBoundsFor = this.selection; this._selBounds = alphaBounds(this.selection); }
      const bb = this._selBounds;
      if (bb) { ctx.setLineDash([6 / s, 4 / s]); ctx.lineWidth = 1 / s; ctx.strokeStyle = "#f2ff59"; ctx.strokeRect(bb.x - this.M, bb.y - this.M, bb.w, bb.h); ctx.setLineDash([]); }
    }
    // frame outline
    ctx.lineWidth = 1.5 / s; ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.strokeRect(0, 0, this.W, this.H);
    // generation box
    const gb = d?.kind === "genbox" && d.live ? d.live : this.genBox;
    ctx.setLineDash([8 / s, 5 / s]); ctx.lineWidth = 2 / s; ctx.strokeStyle = "#f2ff59"; ctx.strokeRect(gb.x, gb.y, gb.w, gb.h); ctx.setLineDash([]);
    if (this.tool === "genbox") { ctx.fillStyle = "#f2ff59"; for (const [x, y] of [[gb.x, gb.y], [gb.x + gb.w, gb.y], [gb.x, gb.y + gb.h], [gb.x + gb.w, gb.y + gb.h]]) ctx.fillRect(x - 4 / s, y - 4 / s, 8 / s, 8 / s); }
    // in-progress shapes
    if (d?.kind === "rect") { ctx.setLineDash([5 / s, 4 / s]); ctx.lineWidth = 1.2 / s; ctx.strokeStyle = "#fff"; ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); ctx.setLineDash([]); }
    if (d?.kind === "lasso") { ctx.lineWidth = 1.2 / s; ctx.strokeStyle = "#fff"; ctx.beginPath(); d.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    if (d?.kind === "transform") { ctx.lineWidth = 1.2 / s; ctx.strokeStyle = "#f2ff59"; ctx.strokeRect(d.live.x, d.live.y, d.live.w, d.live.h); }
    // magic points
    for (const p of this.magic.points) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 6 / s, 0, Math.PI * 2);
      ctx.fillStyle = p.label ? "#3ddc97" : "#ff4d6d"; ctx.fill(); ctx.lineWidth = 2 / s; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    // brush cursor
    if (this._hover && ["brush", "eraser", "mask"].includes(this.tool)) {
      ctx.beginPath(); ctx.arc(this._hover[0], this._hover[1], this.brush.size / 2, 0, Math.PI * 2);
      ctx.lineWidth = 1 / s; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.stroke();
    }
    const a = this.active;
    this.hud.replaceChildren(el("span", { class: "ss-cv-chip" }, `${Math.round(s * 100)}%`),
      el("span", { class: "ss-cv-chip" }, `${this.W}×${this.H}`), a ? el("span", { class: "ss-cv-chip" }, a.name) : null);
  }

  /** Tint of an alpha canvas (masks red, selection yellow), cached per canvas until the next edit. */
  _tinted(src, color) {
    this._tints ||= new WeakMap();
    const hit = this._tints.get(src);
    if (hit && hit.ver === this._ver && hit.color === color && src !== this._stroke?.canvas) return hit.t;
    const t = newCanvas(src.width, src.height), c = t.getContext("2d");
    c.drawImage(src, 0, 0); c.globalCompositeOperation = "source-in"; c.fillStyle = color; c.fillRect(0, 0, t.width, t.height);
    this._tints.set(src, { ver: this._ver, color, t });
    return t;
  }

  // ======================================================================= engines
  async _probeEngines() {
    try {
      const [pr, as] = await Promise.all([this.api.fetchApi("/vnccs/unicanvas/presets"), this.api.fetchApi("/vnccs/unicanvas/assets")]);
      if (!pr.ok || !as.ok) throw new Error(`HTTP ${pr.status}`);
      const presets = await pr.json(), assets = await as.json();
      this.vnccs = { ok: true, reason: "", presets: presets.presets || [], assets };
    } catch {
      this.vnccs = { ok: false, reason: "VNCCS UniCanvas (vnccs-utils) is not installed on this ComfyUI: Generate is off. Install vnccs-utils and restart.", presets: [], assets: null };
    }
    try {
      const r = await this.api.fetchApi("/object_info/SAM3_Detect");
      const ok = r.ok && Object.keys(await r.json()).length > 0;
      const ck = await this.api.fetchApi("/object_info/CheckpointLoaderSimple");
      const names = ck.ok ? (await ck.json()).CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [] : [];
      const sam = (Array.isArray(names) ? names : []).find((n) => /sam3/i.test(n));
      this.sam = { local: ok && !!sam, ckpt: sam, reason: !ok ? "This ComfyUI has no SAM3_Detect node" : !sam ? "No SAM 3 checkpoint in models/checkpoints" : "" };
    } catch { this.sam = { local: false, reason: "Could not check for SAM 3" }; }
    try {
      const list = async (node, key) => { const r = await this.api.fetchApi(`/object_info/${node}`); const j = r.ok ? await r.json() : {};
        const v = j[node]?.input?.required?.[key]?.[0]; return Array.isArray(v) ? v : []; };
      this.loaders = { unet: await list("UNETLoader", "unet_name"), clip: await list("CLIPLoader", "clip_name"), vae: await list("VAELoader", "vae_name") };
    } catch { this.loaders = {}; }
    if (!this.sam.local && this.vnccs.ok) this.magic.engine = "vnccs";
    this._fillModels();
    this._renderOptions();
  }

  _models() {
    const out = [];
    const L = this.loaders || {};
    for (const m of LOCAL_MODELS) {
      if (!m.queue) continue;
      const ok = (L.unet || []).includes(m.queue.unet) && (L.clip || []).includes(m.queue.clip) && (L.vae || []).includes(m.queue.vae);
      if (ok) out.push({ id: `q:${m.id}`, label: `${m.label} · queued`, engine: "queue", spec: m.queue });
    }
    if (!this.allowVnccsDirect) return out;
    const a = this.vnccs.assets || {};
    const has = (kind, name) => (a[kind] || []).includes(name);
    for (const m of LOCAL_MODELS) if (this.vnccs.ok && Object.entries(m.needs).every(([k, n]) => has(k, n))) out.push({ id: m.id, label: `${m.label} · VNCCS direct`, engine: "vnccs", settings: m.settings });
    for (const p of this.vnccs.presets) {
      if ((p.assets || []).every((x) => x.installed)) out.push({ id: `vnccs:${p.id}`, label: `VNCCS · ${p.title || p.label} · direct`, engine: "vnccs", settings: { ...p.settings } });
    }
    return out;
  }

  _fillModels() {
    const models = this._models();
    this.modelSel.replaceChildren(...models.map((m) => el("option", { value: m.id }, m.label)));
    if (!models.some((m) => m.id === this.gen.model) && models[0]) this.gen.model = models[0].id;
    this.modelSel.value = this.gen.model;
    const off = !models.length;
    this.genBtn.disabled = off;
    const cur = models.find((m) => m.id === this.gen.model);
    this.genWarn.textContent = !models.length ? "No usable model: Z-Image Turbo (queued) or vnccs-utils is needed."
      : cur?.engine === "vnccs" ? "VNCCS direct runs outside ComfyUI's queue: it waits for an empty queue, but a prompt queued meanwhile can crash ComfyUI."
      : "";
    this._renderGenMode();
  }

  /** txt2img (empty box), img2img (full, no mask), inpaint (full + mask), outpaint (box partly empty). VNCCS's rule. */
  _genMode() {
    const b = this.genBox;
    const iw = 96, ih = Math.max(16, Math.round((96 * b.h) / b.w));
    const comp = this.composite(b, iw, ih);
    const d = ctx2d(comp).getImageData(0, 0, iw, ih).data;
    let filled = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) filled++;
    const total = iw * ih;
    if (filled === 0) return "txt2img";
    if (filled < total * 0.995) return "outpaint";
    const m = this._maskCrop(b, iw, ih);
    const md = ctx2d(m).getImageData(0, 0, iw, ih).data;
    for (let i = 3; i < md.length; i += 4) if (md[i] > 8) return "inpaint";
    return "img2img";
  }

  _renderGenMode() {
    if (!this.genNote) return;
    const mode = this._genMode();
    this._mode = mode;
    const text = { txt2img: "Box is empty → text to image", img2img: "Box is full, no mask → image to image (denoise)",
      inpaint: "Mask inside the box → inpaint", outpaint: "Box reaches past the picture → outpaint" }[mode];
    this.genNote.textContent = `${text} · ${Math.round(this.genBox.w)}×${Math.round(this.genBox.h)}`;
    this.genBtn.querySelector("span").textContent = `Generate · ${mode}`;
  }

  _inferenceSize() {
    const b = this.genBox, area = 1024 * 1024, ar = b.w / b.h;
    const w = Math.sqrt(area * ar), h = w / ar;
    return { width: Math.max(64, Math.round(w / 16) * 16), height: Math.max(64, Math.round(h / 16) * 16) };
  }

  /** Outpaint mask = user mask + every transparent pixel + a 32 px overlap into the picture (after VNCCS). */
  _outpaintMask(img, user) {
    const w = img.width, h = img.height;
    const out = cloneCanvas(user), oc = ctx2d(out);
    const md = oc.getImageData(0, 0, w, h), m = md.data;
    const a = ctx2d(img).getImageData(0, 0, w, h).data;
    const empty = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) empty[i] = a[i * 4 + 3] <= 8 ? 1 : 0;
    const on = (i) => { m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = m[i * 4 + 3] = 255; };
    const overlap = 32;
    for (let y = 0; y < h; y++) {
      let dl = Infinity; for (let x = 0; x < w; x++) { const i = y * w + x; if (empty[i]) { dl = 0; on(i); } else if (dl !== Infinity && ++dl <= overlap) on(i); }
      let dr = Infinity; for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (empty[i]) dr = 0; else if (dr !== Infinity && ++dr <= overlap) on(i); }
    }
    for (let x = 0; x < w; x++) {
      let dt = Infinity; for (let y = 0; y < h; y++) { const i = y * w + x; if (empty[i]) dt = 0; else if (dt !== Infinity && ++dt <= overlap) on(i); }
      let db = Infinity; for (let y = h - 1; y >= 0; y--) { const i = y * w + x; if (empty[i]) db = 0; else if (db !== Infinity && ++db <= overlap) on(i); }
    }
    oc.putImageData(md, 0, 0);
    return out;
  }

  async generate() {
    if (this.gen.busy) return;
    const model = this._models().find((m) => m.id === this.gen.model);
    if (!model) { this.onStatus("Pick a model"); return; }
    if (model.engine === "queue") return this._generateQueued(model);
    const qs = await (await this.api.fetchApi("/queue")).json().catch(() => null);
    if (qs && (qs.queue_running.length || qs.queue_pending.length)) {
      this.onStatus("ComfyUI's queue is busy. VNCCS direct can only run when it is empty (it shares the GPU outside the queue); use the queued model or wait.");
      return;
    }
    const mode = this._genMode();
    if (mode === "txt2img" && !this.gen.positive.trim()) { this.onStatus("Write a prompt for text to image"); this.posIn.focus(); return; }
    const box = { ...this.genBox };
    const inf = this._inferenceSize();
    const image = this.composite(box, inf.width, inf.height, mode === "img2img" ? { background: "#000" } : {});
    if (mode === "outpaint") {   // VNCCS forces opaque alpha on content before outpaint
      const ic = ctx2d(image), id = ic.getImageData(0, 0, image.width, image.height);
      for (let i = 3; i < id.data.length; i += 4) if (id.data[i] > 8) id.data[i] = 255;
      ic.putImageData(id, 0, 0);
    }
    const userMask = this._maskCrop(box, inf.width, inf.height);
    const mask = mode === "outpaint" ? this._outpaintMask(image, userMask) : userMask;
    const settings = { ...model.settings, positive: this.gen.positive, negative: this.gen.negative, seed: this.gen.seed | 0, batch_size: 1 };
    if (this.gen.steps > 0) settings.steps = this.gen.steps;
    if (mode === "img2img") settings.denoise = this.gen.denoise;
    const debugId = `ss-${Date.now()}-${uid()}`;
    this.gen.busy = true; this.genBtn.disabled = true;
    this._progress(true, 0.01, `Generating ${mode} ${inf.width}×${inf.height}…`);
    const poll = setInterval(async () => {
      try {
        const p = await (await this.api.fetchApi(`/vnccs/unicanvas/progress/${encodeURIComponent(debugId)}`)).json();
        if (p.stage !== "unknown") this._progress(true, p.progress || 0, `${p.message || p.stage}${p.steps ? ` · ${p.step}/${p.steps}` : ""}`);
      } catch {}
    }, 600);
    try {
      const res = await this._longFetch("/vnccs/unicanvas/draw", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debug_id: debugId, mode, image: image.toDataURL("image/png"), mask: mask.toDataURL("image/png"),
          source_empty: mode === "txt2img", bbox: { x: box.x, y: box.y, width: box.w, height: box.h }, inference_size: inf,
          output_size: { width: Math.round(box.w), height: Math.round(box.h) }, settings }) });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      const img = await loadImg(this._viewURL(`${data.image.subfolder ? data.image.subfolder + "/" : ""}${data.image.filename}`, data.image.type || "temp", Date.now()));
      const layerCanvas = newCanvas(this.EW, this.EH);
      const lc = layerCanvas.getContext("2d");
      const piece = newCanvas(Math.round(box.w), Math.round(box.h));
      const pc = piece.getContext("2d");
      pc.drawImage(img, 0, 0, piece.width, piece.height);
      if ((mode === "inpaint" || mode === "outpaint") && data.mask) {
        // paste through VNCCS's soft paste mask (luminance -> alpha)
        const mi = await loadImg(this._viewURL(`${data.mask.subfolder ? data.mask.subfolder + "/" : ""}${data.mask.filename}`, data.mask.type || "temp", Date.now()));
        const mc = newCanvas(piece.width, piece.height), mx = ctx2d(mc);
        mx.drawImage(mi, 0, 0, mc.width, mc.height);
        const md = mx.getImageData(0, 0, mc.width, mc.height);
        for (let i = 0; i < md.data.length; i += 4) { const v = md.data[i + 3] < 255 ? md.data[i + 3] : Math.max(md.data[i], md.data[i + 1], md.data[i + 2]); md.data[i] = md.data[i + 1] = md.data[i + 2] = 255; md.data[i + 3] = v; }
        mx.putImageData(md, 0, 0);
        pc.globalCompositeOperation = "destination-in"; pc.drawImage(mc, 0, 0);
      }
      lc.drawImage(piece, box.x + this.M, box.y + this.M);
      const l = this.addLayer("gen", `Gen · ${mode} · ${(this.gen.positive || "").slice(0, 24) || "untitled"}`, layerCanvas);
      if (mode === "inpaint") this.onStatus("Inpaint done: clear the mask before the next inpaint");
      else this.onStatus(`Generated (${data.generation_mode || model.label}) → layer “${l.name}”`);
      this._progress(true, 1, "Done");
    } catch (e) {
      this.onStatus(`Generate failed: ${e.message}`);
      this._progress(true, 1, `Failed: ${e.message}`);
    } finally {
      clearInterval(poll);
      this.gen.busy = false; this.genBtn.disabled = false;
      setTimeout(() => { if (!this.gen.busy) this._progress(false); }, 2500);
      this._renderGenMode();
    }
  }

  /** Generate through ComfyUI's queue with core nodes (Z-Image Turbo): txt2img, img2img, inpaint, outpaint. */
  async _generateQueued(model) {
    const mode = this._genMode();
    if (mode === "txt2img" && !this.gen.positive.trim()) { this.onStatus("Write a prompt for text to image"); this.posIn.focus(); return; }
    const box = { ...this.genBox };
    const inf = this._inferenceSize();
    const q = model.spec;
    this.gen.busy = true; this.genBtn.disabled = true;
    this._progress(true, 0.02, `Generating ${mode} ${inf.width}×${inf.height} (queued)…`);
    try {
      const image = this.composite(box, inf.width, inf.height);
      let mask = null;
      if (mode === "inpaint" || mode === "outpaint") {
        const user = this._maskCrop(box, inf.width, inf.height);
        mask = mode === "outpaint" ? this._outpaintMask(image, user) : user;
      }
      const P = {
        1: { class_type: "UNETLoader", inputs: { unet_name: q.unet, weight_dtype: "default" } },
        2: { class_type: "CLIPLoader", inputs: { clip_name: q.clip, type: q.clipType, device: "default" } },
        3: { class_type: "VAELoader", inputs: { vae_name: q.vae } },
        5: { class_type: "CLIPTextEncode", inputs: { text: this.gen.positive || "", clip: ["2", 0] } },
      };
      const steps = this.gen.steps > 0 ? this.gen.steps : q.steps;
      let srcLatent = null, maskRef = null;
      if (mode !== "txt2img") {
        // Opaque source for the encoder: transparent (outpaint) pixels become mid grey; the mask regenerates them.
        const src = newCanvas(inf.width, inf.height), sc = src.getContext("2d");
        sc.fillStyle = "#7f7f7f"; sc.fillRect(0, 0, src.width, src.height); sc.drawImage(image, 0, 0);
        P[8] = { class_type: "LoadImage", inputs: { image: await this._upload(await toBlob(src), `_gen_src_${this.docId}.png`) } };
        P[12] = { class_type: "VAEEncode", inputs: { pixels: ["8", 0], vae: ["3", 0] } };
        srcLatent = ["12", 0];
        if (mask) {
          const m = newCanvas(inf.width, inf.height), mc = m.getContext("2d");
          mc.fillStyle = "#000"; mc.fillRect(0, 0, m.width, m.height);
          const white = cloneCanvas(mask), wc = white.getContext("2d");
          wc.globalCompositeOperation = "source-in"; wc.fillStyle = "#fff"; wc.fillRect(0, 0, white.width, white.height);
          mc.drawImage(white, 0, 0);
          P[9] = { class_type: "LoadImage", inputs: { image: await this._upload(await toBlob(m), `_gen_mask_${this.docId}.png`) } };
          P[10] = { class_type: "ImageToMask", inputs: { image: ["9", 0], channel: "red" } };
          P[11] = { class_type: "GrowMask", inputs: { mask: ["10", 0], expand: 6, tapered_corners: true } };
          maskRef = ["11", 0];
        }
      }
      if (q.kind === "klein") {
        // FLUX.2 Klein (distilled, cfg 1): the box contents go in as a reference latent (edit model); a mask limits
        // the change to the masked area. No negative prompt (zeroed conditioning).
        P[6] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } };
        let pos = ["5", 0];
        if (srcLatent) { P[16] = { class_type: "ReferenceLatent", inputs: { conditioning: ["5", 0], latent: srcLatent } }; pos = ["16", 0]; }
        P[17] = { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: pos, negative: ["6", 0], cfg: q.cfg } };
        P[18] = { class_type: "RandomNoise", inputs: { noise_seed: this.gen.seed | 0 } };
        P[19] = { class_type: "KSamplerSelect", inputs: { sampler_name: q.sampler } };
        P[20] = { class_type: "Flux2Scheduler", inputs: { steps, width: inf.width, height: inf.height } };
        P[7] = maskRef ? { class_type: "SetLatentNoiseMask", inputs: { samples: srcLatent, mask: maskRef } }
          : { class_type: "EmptyFlux2LatentImage", inputs: { width: inf.width, height: inf.height, batch_size: 1 } };
        P[13] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["18", 0], guider: ["17", 0], sampler: ["19", 0], sigmas: ["20", 0], latent_image: ["7", 0] } };
      } else {
        P[4] = { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: q.shift } };
        P[6] = { class_type: "CLIPTextEncode", inputs: { text: this.gen.negative || "", clip: ["2", 0] } };
        let latent, denoise = 1;
        if (!srcLatent) { P[7] = { class_type: "EmptySD3LatentImage", inputs: { width: inf.width, height: inf.height, batch_size: 1 } }; latent = ["7", 0]; }
        else if (maskRef) { P[7] = { class_type: "SetLatentNoiseMask", inputs: { samples: srcLatent, mask: maskRef } }; latent = ["7", 0]; }
        else { latent = srcLatent; denoise = this.gen.denoise; }
        P[13] = { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: latent,
          seed: this.gen.seed | 0, steps, cfg: q.cfg, sampler_name: q.sampler, scheduler: q.scheduler, denoise } };
      }
      P[14] = { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["3", 0] } };
      P[15] = { class_type: "PreviewImage", inputs: { images: ["14", 0] } };
      const img = await this._runGraph(P, "15", `Generate · ${mode}`);
      const piece = newCanvas(Math.round(box.w), Math.round(box.h)), pc = piece.getContext("2d");
      pc.drawImage(img, 0, 0, piece.width, piece.height);
      if (mask) {   // paste through the mask, grown and feathered, so the seam blends
        const fm = newCanvas(piece.width, piece.height), fc = fm.getContext("2d");
        fc.filter = `blur(${Math.max(2, Math.round(piece.width / 160))}px)`;
        fc.drawImage(mask, 0, 0, piece.width, piece.height);
        fc.filter = "none"; fc.globalCompositeOperation = "source-in"; fc.fillStyle = "#fff"; fc.fillRect(0, 0, fm.width, fm.height);
        pc.globalCompositeOperation = "destination-in"; pc.drawImage(fm, 0, 0);
      }
      const layerCanvas = newCanvas(this.EW, this.EH);
      layerCanvas.getContext("2d").drawImage(piece, box.x + this.M, box.y + this.M);
      const l = this.addLayer("gen", `Gen · ${mode} · ${(this.gen.positive || "").slice(0, 24) || "untitled"}`, layerCanvas);
      this.onStatus(mode === "inpaint" ? `Inpaint done → “${l.name}”. Clear the mask before the next inpaint.` : `Generated → layer “${l.name}”`);
      this._progress(true, 1, "Done");
    } catch (e) {
      this.onStatus(`Generate failed: ${e.message}`);
      this._progress(true, 1, `Failed: ${e.message}`);
    } finally {
      this.gen.busy = false; this.genBtn.disabled = false;
      setTimeout(() => { if (!this.gen.busy) this._progress(false); }, 2500);
      this._renderGenMode();
    }
  }

  _progress(on, p = 0, text = "") {
    this.prog.dataset.on = String(on);
    this.prog.querySelector("span").textContent = text;
    this.prog.querySelector("b").style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
  }

  // ---- magic mask
  async runMagic() {
    const pts = this.magic.points;
    if (!pts.length || this.magic.busy) return;
    // Segment the visible composite over the area that has pixels (at least the frame).
    let rect = { x: 0, y: 0, w: this.W, h: this.H };
    const all = this.composite({ x: -this.M, y: -this.M, w: this.EW, h: this.EH });
    const bb = alphaBounds(all);
    if (bb) {
      const x0 = Math.min(0, bb.x - this.M), y0 = Math.min(0, bb.y - this.M);
      rect = { x: x0, y: y0, w: Math.max(this.W, bb.x - this.M + bb.w) - x0, h: Math.max(this.H, bb.y - this.M + bb.h) - y0 };
    }
    const img = this.composite(rect, rect.w, rect.h, { background: "#000" });
    const local = pts.map((p) => ({ x: Math.round(p.x - rect.x), y: Math.round(p.y - rect.y), label: p.label }))
      .filter((p) => p.x >= 0 && p.y >= 0 && p.x < rect.w && p.y < rect.h);
    if (!local.length) { this.onStatus("Click on the picture to place points"); return; }
    this.magic.busy = true; this._renderOptions();
    this._progress(true, 0.2, this.magic.engine === "local" ? "Magic mask · SAM 3.1 (queued)…" : "Magic mask · VNCCS SAM2…");
    try {
      const maskImg = this.magic.engine === "local" ? await this._samLocal(img, local) : await this._samVnccs(img, local);
      const sel = this._newSel();
      const sc = sel.getContext("2d");
      const tmp = newCanvas(rect.w, rect.h), tc = ctx2d(tmp);
      tc.drawImage(maskImg, 0, 0, rect.w, rect.h);
      const d = tc.getImageData(0, 0, rect.w, rect.h);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = maskImg._alphaMask ? d.data[i + 3] : Math.max(d.data[i], d.data[i + 1], d.data[i + 2]);
        d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; d.data[i + 3] = v > 127 ? 255 : 0;
      }
      tc.putImageData(d, 0, 0);
      sc.drawImage(tmp, rect.x + this.M, rect.y + this.M);
      const empty = !alphaBounds(sel);
      if (empty) throw new Error("SAM found nothing at those points");
      this._record("Magic mask", () => { this.selection = sel; });
      this.magic.points = [];
      this.onStatus("Magic mask ready: To mask / Cut to layer / Lift to 3D");
      this._progress(true, 1, "Selection ready");
    } catch (e) {
      this.onStatus(`Magic mask failed: ${e.message}`);
      this._progress(true, 1, `Failed: ${e.message}`);
    } finally {
      this.magic.busy = false; this._renderOptions();
      setTimeout(() => { if (!this.gen.busy) this._progress(false); }, 2000);
    }
  }

  async _samVnccs(img, points) {
    const res = await this._longFetch("/vnccs/unicanvas/segment", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sam2_large", image: img.toDataURL("image/png"), points }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const m = await loadImg(data.mask);
    m._alphaMask = true;
    return m;
  }

  /** Core SAM 3.1 (SAM3_Detect + click points) as a 5-node graph through the queue (front of the line). */
  async _samLocal(img, points) {
    const name = await this._upload(await toBlob(img), `_sam_${this.docId}.png`);
    const pos = points.filter((p) => p.label).map(({ x, y }) => ({ x, y }));
    const neg = points.filter((p) => !p.label).map(({ x, y }) => ({ x, y }));
    if (!pos.length) throw new Error("Add at least one include point");
    const det = { model: ["2", 0], image: ["1", 0], positive_coords: JSON.stringify(pos), threshold: 0.5, refine_iterations: 2, individual_masks: false };
    if (neg.length) det.negative_coords = JSON.stringify(neg);
    const prompt = {
      1: { class_type: "LoadImage", inputs: { image: name } },
      2: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: this.sam.ckpt } },
      3: { class_type: "SAM3_Detect", inputs: det },
      4: { class_type: "MaskToImage", inputs: { mask: ["3", 0] } },
      5: { class_type: "PreviewImage", inputs: { images: ["4", 0] } },
    };
    return await this._runGraph(prompt, "5", "Magic mask · SAM 3.1");
  }

  /**
   * Queue an API-format graph at the front of ComfyUI's queue and return the first image of node `outId`.
   * Everything heavy goes through the queue, so it never shares the GPU with another running prompt
   * (VNCCS's /draw runs outside the queue and crashed ComfyUI 0.43 when a prompt started alongside it).
   */
  async _runGraph(prompt, outId, label) {
    const res = await this.api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, front: true, client_id: this.api.clientId }) });
    const q = await res.json();
    if (!res.ok || q.error) {
      const ne = Object.values(q.node_errors || {})[0];
      throw new Error(ne ? `${ne.class_type}: ${ne.errors?.[0]?.message || ""} ${ne.errors?.[0]?.details || ""}` : q.error?.message || `HTTP ${res.status}`);
    }
    const onProg = (e) => { const d = e.detail || {}; if (d.prompt_id === q.prompt_id && d.max) this._progress(true, 0.1 + 0.85 * (d.value / d.max), `${label} · ${d.value}/${d.max}`); };
    this.api.addEventListener?.("progress", onProg);
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 900000) {
        await new Promise((r) => setTimeout(r, 800));
        const h = await (await this.api.fetchApi(`/history/${q.prompt_id}`)).json();
        const e = h[q.prompt_id];
        if (!e) {
          const qs = await (await this.api.fetchApi("/queue")).json().catch(() => null);
          const mine = qs?.queue_running?.some((r) => r[1] === q.prompt_id);
          if (!mine && !this.prog.textContent.includes("/")) this._progress(true, 0.05, `${label} · waiting for the job ahead…`);
          else if (mine && !this.prog.textContent.includes("/")) this._progress(true, 0.1, `${label} · loading…`);
          continue;
        }
        if (e.status?.status_str === "error") {
          const msg = (e.status.messages || []).find((m) => m[0] === "execution_error")?.[1];
          throw new Error(msg ? `${msg.node_type}: ${msg.exception_message}`.slice(0, 220) : `${label} failed (see the ComfyUI console)`);
        }
        const out = e.outputs?.[outId]?.images?.[0];
        if (!out) throw new Error(`${label} returned no image`);
        return await loadImg(this._viewURL(`${out.subfolder ? out.subfolder + "/" : ""}${out.filename}`, out.type || "temp", Date.now()));
      }
      throw new Error("timed out waiting for the queue");
    } finally { this.api.removeEventListener?.("progress", onProg); }
  }

  // ======================================================================= outputs
  /** PNG of the selection (over the visible composite) or of the active layer, trimmed to its pixels. */
  async _pieceBlob() {
    const c = newCanvas(this.EW, this.EH), ctx = c.getContext("2d");
    const a = this.active;
    if (this.selection) {
      for (const l of this._rasterLayers()) if (l.visible) { ctx.globalAlpha = l.opacity; ctx.drawImage(l.canvas, 0, 0); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(this.selection, 0, 0);
    } else if (a && a.kind !== "mask") ctx.drawImage(a.canvas, 0, 0);
    const b = alphaBounds(c);
    if (!b) return null;
    const out = newCanvas(b.w, b.h);
    out.getContext("2d").drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return { blob: await toBlob(out), rect: { x: b.x - this.M, y: b.y - this.M, w: b.w, h: b.h } };
  }

  async lift(kind) {
    if (!this.liftTo3D) return;
    const p = await this._pieceBlob();
    if (!p) { this.onStatus("Nothing to lift: select something or pick a layer with pixels"); return; }
    try {
      await this.liftTo3D(p.blob, kind, { rect: p.rect, frame: { w: this.W, h: this.H }, name: this.selection ? "Selection" : this.active?.name });
      this.onStatus(`Sent to 3D as ${kind}`);
    } catch (e) { this.onStatus(`Lift to 3D failed: ${e.message}`); }
  }

  /** Save the composite (frame, or only the generation box) to input/soundstage/ and make it the App's touched-up still. */
  async useAsLookStill() {
    const rect = this.boxOnly.checked ? { ...this.genBox } : { x: 0, y: 0, w: this.W, h: this.H };
    const c = this.composite(rect, Math.round(rect.w), Math.round(rect.h), { background: "#000" });
    this.useBtn.disabled = true;
    try {
      const url = c.toDataURL("image/png");
      const name = await this._upload(await toBlob(c), `look_still_${this.docId}_${hashBytes(url.slice(-4096) + url.length)}.png`, "soundstage");
      const nodes = this.app ? findTouchupNodes(this.app) : {};
      const wired = Boolean(nodes.still && nodes.toggle && setTouchupStill(this.app, name) && setTouchupEnabled(this.app, true));
      this.onLookStill?.(name);
      this.onStatus(wired ? `Look still set (${name}): rungs 3-4 now use it. Run the next rung.`
        : nodes.still && !nodes.still.widgets?.some((w) => w.name === "image")
          ? `Saved ${name} in input/, but this server hasn't loaded SoundstageCanvasImage (register nodes_canvas and restart).`
          : `Saved ${name} in input/. This workflow has no "Use touched-up still" step to wire it to (rebuild the App).`);
    } catch (e) { this.onStatus(`Could not save the look still: ${e.message}`); }
    finally { this.useBtn.disabled = false; }
  }
}

export default CanvasPanel;
