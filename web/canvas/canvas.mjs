// Soundstage Paint Studio: a small Photoshop for the first frame, inside the stage widget.
// Layers, paint, masks, marquee / lasso / magic (SAM 3.1) selections, Crop / Extend canvas, and Generative Fill
// (Fill, Remove, Replace with a reference, Extend) with variations, a before / after slider and history.
//
//   const panel = new CanvasPanel(container, { api, app, stage, onStatus, liftTo3D });
//   panel.load(node.properties.soundstage_canvas);   // names + transforms only; pixels live in input/soundstage/canvas/
//   panel.onChange = (json) => { node.properties.soundstage_canvas = json; };
//   panel.refreshStage();                             // after the stage / playhead changes
//
// Every model call goes through ComfyUI's queue with Soundstage's own nodes: Generative Fill is SoundstageFill
// (crop -> FLUX 3 Klein / Krea 2 / any edit model -> feathered, colour-matched stitch; soundstage/nodes_fill.py),
// magic select is core SAM 3.1 (SAM3_Detect with click points). No other custom node pack is needed.
// Icons not in web/ui/icons.mjs are Lucide paths (ISC, see vendor/LUCIDE_LICENSE.txt).
import { icon as uiIcon } from "../ui/icons.mjs";
import { findTouchupNodes, setTouchupEnabled, setTouchupStill } from "../touchup/touchup.mjs";

const EXTRA_ICONS = {
  brush: '<path d="m11 10 3 3"/><path d="M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z"/><path d="M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031"/>',
  eraser: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  "square-dashed": '<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/>',
  lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
  move: '<path d="M12 2v20"/><path d="m15 19-3 3-3-3"/><path d="m19 9 3 3-3 3"/><path d="M2 12h20"/><path d="m5 9-3 3 3 3"/><path d="m9 5 3-3 3 3"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  expand: '<path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/>',
  "paint-bucket": '<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>',
  "zoom-in": '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  "columns-2": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  pipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
  "eye-off": '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  "lock-open": '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  merge: '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  dices: '<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',
  "circle-plus": '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  "circle-minus": '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
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
  display:grid; grid-template-columns:46px minmax(0,1fr) 268px; grid-template-rows:auto auto minmax(0,1fr) auto auto;
  grid-template-areas:"head head head" "opts opts opts" "rail view side" "rail fill side" "rail film side"; gap:8px;
  color:var(--cv-text); font:12.5px/1.35 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; min-width:0; outline:none; }
.ss-cv * { box-sizing:border-box; }
.ss-cv-headbar { grid-area:head; display:flex; align-items:center; gap:10px; min-width:0; }
.ss-cv-title { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:700; letter-spacing:.01em; white-space:nowrap; }
.ss-cv-title .ss-icon { color:var(--cv-accent); }
.ss-cv-sub { color:var(--cv-muted); font-size:12px; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cv-opts { grid-area:opts; display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; background:var(--cv-card);
  border:1px solid var(--cv-line); border-radius:12px; padding:5px 10px; min-height:40px; }
.ss-cv-opts .ss-cv-toolname { font-weight:600; color:var(--cv-text); display:inline-flex; align-items:center; gap:6px; padding-right:4px;
  border-right:1px solid var(--cv-line); margin-right:2px; }
.ss-cv-opts label { display:inline-flex; align-items:center; gap:6px; color:var(--cv-muted); white-space:nowrap; }
.ss-cv-opts input[type=range] { width:84px; accent-color:var(--cv-accent); }
.ss-cv-opts output { min-width:28px; color:var(--cv-text); font-variant-numeric:tabular-nums; }
.ss-cv-opts .ss-cv-spacer { flex:1; }
.ss-cv-rail { grid-area:rail; display:flex; flex-direction:column; gap:3px; background:var(--cv-card); border:1px solid var(--cv-line); border-radius:12px; padding:4px; align-self:start; }
.ss-cv-rail .ss-cv-sep { height:1px; background:var(--cv-line); margin:3px 4px; }
.ss-cv-view { grid-area:view; position:relative; min-width:0; height:clamp(340px, 60vh, 900px); background:#120d16; border:1px solid var(--cv-line);
  border-radius:12px; overflow:hidden; touch-action:none; }
.ss-cv-view canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.ss-cv-hud { position:absolute; left:8px; top:8px; display:flex; gap:6px; pointer-events:none; flex-wrap:wrap; right:8px; }
.ss-cv-chip { background:rgba(33,25,39,.82); border:1px solid var(--cv-line); border-radius:999px; padding:3px 9px; color:var(--cv-muted); font-size:11px; white-space:nowrap; }
.ss-cv-chip.hot { color:var(--cv-ink); background:var(--cv-accent); border-color:var(--cv-accent); font-weight:600; }
.ss-cv-prog { position:absolute; left:0; right:0; bottom:0; height:28px; background:rgba(18,13,22,.9); display:none; align-items:center; gap:8px; padding:0 10px; font-size:11.5px; color:var(--cv-text); }
.ss-cv-prog[data-on=true] { display:flex; }
.ss-cv-prog i { flex:1; height:4px; border-radius:2px; background:var(--cv-line); position:relative; overflow:hidden; }
.ss-cv-prog i b { position:absolute; left:0; top:0; bottom:0; background:var(--cv-accent); width:0; transition:width .2s; }
.ss-cv-side { grid-area:side; display:flex; flex-direction:column; gap:8px; min-width:0; }
.ss-cv-card { background:var(--cv-card); border:1px solid var(--cv-line); border-radius:12px; padding:8px; display:flex; flex-direction:column; gap:6px; min-width:0; }
.ss-cv-head { display:flex; align-items:center; gap:6px; text-transform:uppercase; letter-spacing:.08em; font-size:11px; font-weight:600; color:var(--cv-muted); }
.ss-cv-head span { flex:1; }
.ss-cv-layers { display:flex; flex-direction:column; gap:3px; max-height:250px; overflow:auto; }
.ss-cv-layer { display:grid; grid-template-columns:24px 40px minmax(0,1fr) 24px; align-items:center; gap:6px; padding:3px 4px;
  border-radius:8px; border:1px solid transparent; cursor:pointer; }
.ss-cv-layer:hover { background:rgba(255,255,255,.04); }
.ss-cv-layer[aria-selected=true] { background:rgba(242,255,89,.08); border-color:rgba(242,255,89,.35); }
.ss-cv-layer canvas { width:40px; height:24px; border-radius:4px; background:repeating-conic-gradient(#3a3340 0 25%, #2a2330 0 50%) 0 0/8px 8px; }
.ss-cv-layer .ss-cv-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cv-layer .ss-cv-kind { color:var(--cv-faint); font-size:10.5px; }
.ss-cv-hist { display:flex; flex-direction:column; gap:1px; max-height:180px; overflow:auto; }
.ss-cv-hist button { text-align:left; background:transparent; border:0; color:var(--cv-muted); padding:3px 6px; border-radius:6px; font:inherit; cursor:pointer;
  display:flex; gap:6px; align-items:center; }
.ss-cv-hist button:hover { background:rgba(255,255,255,.05); color:var(--cv-text); }
.ss-cv-hist button[aria-current=true] { color:var(--cv-text); background:rgba(242,255,89,.1); }
.ss-cv-hist button.redo { opacity:.45; }
.ss-cv-snaps { display:flex; gap:6px; flex-wrap:wrap; }
.ss-cv-snaps button { padding:0; border:1px solid var(--cv-line); border-radius:6px; overflow:hidden; background:none; cursor:pointer; width:58px; }
.ss-cv-snaps img { width:100%; display:block; aspect-ratio:16/9; object-fit:cover; }
.ss-cv-snaps span { display:block; font-size:10px; color:var(--cv-muted); padding:1px 3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cv-row { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.ss-cv-row label { display:flex; align-items:center; gap:6px; color:var(--cv-muted); flex:1; }
.ss-cv-row input[type=range] { flex:1; accent-color:var(--cv-accent); min-width:60px; }
.ss-cv textarea, .ss-cv input[type=text], .ss-cv input[type=number], .ss-cv select { min-width:0; background:rgba(0,0,0,.22);
  color:var(--cv-text); border:1px solid var(--cv-line); border-radius:10px; padding:6px 9px; font:inherit; }
.ss-cv .ss-cv-note { color:var(--cv-faint); font-size:11px; }
.ss-cv .ss-cv-warn { color:#ff9a7a; font-size:11px; }
.ss-stage .ss-cv button.ss-cv-tool, .ss-cv button.ss-cv-tool { width:36px; height:36px; padding:0 !important; border-radius:9px !important;
  display:grid; place-items:center; background:transparent !important; border:1px solid transparent !important; color:var(--cv-muted) !important; position:relative; }
.ss-stage .ss-cv button.ss-cv-tool:hover, .ss-cv button.ss-cv-tool:hover { background:var(--cv-raised) !important; color:var(--cv-text) !important; }
.ss-stage .ss-cv button.ss-cv-tool[aria-pressed=true], .ss-cv button.ss-cv-tool[aria-pressed=true] {
  background:var(--cv-accent) !important; color:var(--cv-ink) !important; border-color:var(--cv-accent) !important; }
.ss-cv button.ss-cv-tool kbd { position:absolute; right:2px; bottom:1px; font:600 8.5px/1 "Soundstage Grotesk", system-ui, sans-serif; opacity:.55; }
.ss-stage .ss-cv button.ss-cv-ib, .ss-cv button.ss-cv-ib { width:26px; height:26px; padding:0 !important; border-radius:7px !important;
  display:grid; place-items:center; background:transparent !important; border:1px solid transparent !important; color:var(--cv-muted) !important; }
.ss-stage .ss-cv button.ss-cv-ib:hover, .ss-cv button.ss-cv-ib:hover { color:var(--cv-text) !important; background:var(--cv-raised) !important; }
.ss-cv button.ss-cv-btn { background:var(--cv-raised); color:var(--cv-text); border:1px solid var(--cv-line); border-radius:999px;
  padding:4px 10px; display:inline-flex; align-items:center; gap:5px; font:inherit; font-weight:500; cursor:pointer; white-space:nowrap; }
.ss-cv button.ss-cv-btn[aria-pressed=true] { background:var(--cv-accent) !important; color:var(--cv-ink) !important; border-color:var(--cv-accent) !important; }
.ss-cv button:disabled { opacity:.45; cursor:default; }
.ss-stage .ss-cv button.ss-cv-cta, .ss-cv button.ss-cv-cta { background:var(--cv-accent) !important; color:var(--cv-ink) !important; border:1px solid var(--cv-accent) !important;
  border-radius:999px !important; padding:8px 16px !important; font:inherit; font-weight:700 !important; text-transform:uppercase; letter-spacing:.05em;
  display:inline-flex; align-items:center; justify-content:center; gap:7px; cursor:pointer; white-space:nowrap; }
.ss-cv input[type=color] { width:30px; height:24px; padding:0; border:1px solid var(--cv-line); border-radius:6px; background:none; }
/* Generative Fill: the headline action, under the canvas. */
.ss-cv-fill { grid-area:fill; position:relative; display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:14px;
  background:linear-gradient(180deg, rgba(242,255,89,.09), rgba(242,255,89,.03)); border:1px solid rgba(242,255,89,.38);
  box-shadow:0 0 0 1px rgba(242,255,89,.06), 0 10px 30px rgba(0,0,0,.25); }
.ss-cv-fillhead { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.ss-cv-fillhead .lbl { display:inline-flex; align-items:center; gap:7px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; font-size:12px; color:var(--cv-accent); }
.ss-cv-fillhead .area { color:var(--cv-muted); font-size:12px; flex:1; min-width:160px; }
.ss-cv-fillhead select { max-width:240px; }
.ss-cv-seg { display:inline-flex; gap:2px; padding:2px; border-radius:999px; background:rgba(0,0,0,.25); border:1px solid var(--cv-line); }
.ss-stage .ss-cv .ss-cv-seg button, .ss-cv .ss-cv-seg button { border:0 !important; background:transparent !important; color:var(--cv-muted) !important;
  border-radius:999px !important; padding:3px 10px !important; font:inherit; cursor:pointer; }
.ss-stage .ss-cv .ss-cv-seg button[aria-pressed=true], .ss-cv .ss-cv-seg button[aria-pressed=true] { background:var(--cv-raised) !important; color:var(--cv-text) !important; }
.ss-cv-fillrow { display:flex; gap:8px; align-items:stretch; flex-wrap:wrap; }
.ss-stage .ss-cv .ss-cv-fillrow input.ss-cv-prompt, .ss-cv .ss-cv-fillrow input.ss-cv-prompt { flex:1 1 260px; min-width:200px; font-size:14px !important;
  padding:10px 14px !important; border-radius:12px !important; border:1px solid var(--cv-line2) !important; background:rgba(0,0,0,.3) !important; }
.ss-stage .ss-cv button.ss-cv-act, .ss-cv button.ss-cv-act { display:inline-flex; align-items:center; gap:7px; padding:8px 14px !important;
  border-radius:12px !important; font-weight:600 !important; background:var(--cv-raised) !important; border:1px solid var(--cv-line2) !important; color:var(--cv-text) !important; }
.ss-stage .ss-cv button.ss-cv-act.main, .ss-cv button.ss-cv-act.main { background:var(--cv-accent) !important; color:var(--cv-ink) !important;
  border-color:var(--cv-accent) !important; font-weight:700 !important; }
.ss-stage .ss-cv button.ss-cv-act.ready, .ss-cv button.ss-cv-act.ready { border-color:var(--cv-accent) !important; box-shadow:0 0 0 2px rgba(242,255,89,.35); }
.ss-cv-refs { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ss-cv-refs .ttl { color:var(--cv-muted); font-size:11.5px; }
.ss-stage .ss-cv .ss-cv-refs button.ref, .ss-cv .ss-cv-refs button.ref { width:40px; height:40px; padding:0 !important; border-radius:8px !important; overflow:hidden;
  border:2px solid transparent !important; background:rgba(0,0,0,.3) !important; position:relative; }
.ss-cv .ss-cv-refs button.ref img { width:100%; height:100%; object-fit:cover; display:block; }
.ss-stage .ss-cv .ss-cv-refs button.ref[aria-pressed=true], .ss-cv .ss-cv-refs button.ref[aria-pressed=true] { border-color:var(--cv-accent) !important; }
.ss-cv details.ss-cv-tune summary { cursor:pointer; color:var(--cv-muted); font-size:11.5px; list-style:none; }
.ss-cv details.ss-cv-tune[open] summary { color:var(--cv-text); }
.ss-cv .ss-cv-tunegrid { display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; }
.ss-cv .ss-cv-tunegrid label { display:flex; align-items:center; gap:6px; color:var(--cv-muted); }
.ss-cv .ss-cv-tunegrid input[type=number] { width:76px; }
/* Variations filmstrip */
.ss-cv-film { grid-area:film; display:flex; gap:10px; align-items:center; flex-wrap:wrap; background:var(--cv-card); border:1px solid var(--cv-line);
  border-radius:12px; padding:8px 10px; }
.ss-cv-film[hidden] { display:none !important; }
.ss-cv-strip { display:flex; gap:8px; overflow-x:auto; flex:1 1 300px; min-width:0; padding:2px; }
.ss-stage .ss-cv .ss-cv-strip button, .ss-cv .ss-cv-strip button { flex:0 0 auto; width:132px; padding:0 !important; border-radius:10px !important; overflow:hidden;
  border:2px solid transparent !important; background:#120d16 !important; position:relative; cursor:pointer; }
.ss-cv .ss-cv-strip button img { width:100%; aspect-ratio:16/9; object-fit:cover; display:block; }
.ss-cv .ss-cv-strip button span { position:absolute; left:5px; bottom:4px; font-size:10.5px; color:#fff; text-shadow:0 1px 2px #000; }
.ss-stage .ss-cv .ss-cv-strip button[aria-pressed=true], .ss-cv .ss-cv-strip button[aria-pressed=true] { border-color:var(--cv-accent) !important; }
.ss-cv .ss-cv-strip .wait { width:132px; aspect-ratio:16/9; border-radius:10px; flex:0 0 auto; display:grid; place-items:center; color:var(--cv-faint); font-size:11px;
  background:linear-gradient(90deg, rgba(255,255,255,.03), rgba(255,255,255,.09), rgba(255,255,255,.03)); background-size:200% 100%; animation:ss-cv-shim 1.4s linear infinite; }
@keyframes ss-cv-shim { from { background-position:200% 0; } to { background-position:-200% 0; } }
@media (prefers-reduced-motion: reduce) { .ss-cv .ss-cv-strip .wait { animation:none; } }
/* Narrow (the App side panel): everything stacks, the rail goes across the top. */
.ss-cv.ss-cv-narrow { grid-template-columns:minmax(0,1fr); grid-template-rows:none; grid-template-areas:"head" "opts" "rail" "view" "fill" "film" "side"; }
.ss-cv.ss-cv-narrow .ss-cv-rail { flex-direction:row; flex-wrap:wrap; }
.ss-cv.ss-cv-narrow .ss-cv-rail .ss-cv-sep { width:1px; height:auto; margin:4px 3px; }
.ss-cv.ss-cv-narrow .ss-cv-view { height:auto; aspect-ratio:16 / 10; max-height:70vh; }
.ss-cv.ss-cv-narrow .ss-cv-sub { display:none; }
`;

function injectCss() {
  const old = document.getElementById("soundstage-canvas-css");
  if (old?.dataset.v === "paint2") return;
  old?.remove();
  const s = document.createElement("style");
  s.id = "soundstage-canvas-css";
  s.dataset.v = "paint2";
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
const newCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
const cloneCanvas = (c) => { const n = newCanvas(c.width, c.height); n.getContext("2d").drawImage(c, 0, 0); return n; };
const toBlob = (c) => new Promise((res) => c.toBlob(res, "image/png"));
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = src; });
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

/** Grow (r > 0) or shrink (r < 0) an alpha canvas by |r| px, square kernel, separable sliding max/min. */
export function morphAlpha(alpha, w, h, r) {
  const n = Math.abs(r) | 0;
  if (!n) return alpha;
  const grow = r > 0;
  const pick = grow ? Math.max : Math.min;
  const tmp = new Uint8ClampedArray(alpha.length), out = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = alpha[row + x];
      for (let k = Math.max(0, x - n), e = Math.min(w - 1, x + n); k <= e; k++) v = pick(v, alpha[row + k]);
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - n), e = Math.min(h - 1, y + n); k <= e; k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/** The rect with `aspect` (w/h) that contains `pic` (extending, never cropping it) centred on it, then shrunk
 *  (keeping the aspect) to fit inside `lim`. All {x, y, w, h}. */
export function aspectRect(pic, aspect, lim) {
  let w = pic.w, h = pic.h;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  const s = Math.min(1, lim.w / w, lim.h / h);
  w = Math.round(w * s); h = Math.round(h * s);
  const cx = pic.x + pic.w / 2, cy = pic.y + pic.h / 2;
  const x = Math.round(clamp(cx - w / 2, lim.x, lim.x + lim.w - w)), y = Math.round(clamp(cy - h / 2, lim.y, lim.y + lim.h - h));
  return { x, y, w, h };
}

// Left tool rail: [id, icon, name, key, tip]
const TOOLS = [
  ["move", "move", "Move", "V", "Move (V): drag the active layer or the selected pixels; corners scale (Shift keeps the shape)"],
  ["marquee", "square-dashed", "Marquee", "M", "Marquee select (M): drag a rectangle. Shift adds, Alt subtracts"],
  ["lasso", "lasso", "Lasso", "L", "Lasso select (L): draw around an area. Shift adds, Alt subtracts"],
  ["magic", "wand-sparkles", "Magic select", "W", "Magic select (W): click an object and SAM 3.1 selects it. Shift-click or right-click excludes"],
  "|",
  ["mask", "highlighter", "Brush mask", "B", "Brush mask (B): paint the area Generative Fill should repaint"],
  ["eraser", "eraser", "Eraser", "E", "Eraser (E): erase the mask, or a layer's pixels (switch it in the top bar)"],
  ["paint", "brush", "Paint", "P", "Paint brush (P): paint colour on the active layer"],
  "|",
  ["crop", "crop", "Crop / Extend", "C", "Crop / Extend canvas (C): drag an edge past the picture to outpaint it, or pick 16:9, 2.39, 1.85, 9:16, 4:3"],
  "|",
  ["picker", "pipette", "Eyedropper", "I", "Eyedropper (I): pick a paint colour from the picture"],
  ["hand", "hand", "Hand", "H", "Hand (H, or hold Space / middle-drag): pan the view"],
  ["zoom", "zoom-in", "Zoom", "Z", "Zoom (Z): click to zoom in, Alt-click to zoom out. Scroll zooms anywhere; F fits"],
];
const KEYS = Object.fromEntries(TOOLS.filter((t) => t !== "|").map((t) => [t[3].toLowerCase(), t[0]]));
const BRUSH_TOOLS = ["mask", "eraser", "paint"];
const ASPECT_PRESETS = [["16:9", 16 / 9], ["2.39", 2.39], ["1.85", 1.85], ["9:16", 9 / 16], ["4:3", 4 / 3]];
const FILL_TUNE = { grow: 8, feather: 24, steps: 0, megapixels: 1.0, fit: true };
const useRefEarly = (f, mode) => mode === "fill" && f.refs?.size > 0;

const HISTORY_LIMIT = 40;
const HISTORY_BYTES = 360 * 1024 * 1024;
const MAX_DOC = 2048;   // longest side of the document; bigger frames are scaled to it

export class CanvasPanel {
  /**
   * @param {HTMLElement} container
   * @param {{api: object, app?: object, stage?: object, onStatus?: (t:string)=>void,
   *          liftTo3D?: (blob: Blob, kind: "card"|"splat"|"mesh", info: object)=>any, onLookStill?: (name:string)=>void,
   *          onUseFrame?: (info: {name: string, url: string, w: number, h: number})=>void}} opts
   */
  constructor(container, opts = {}) {
    injectCss();
    this.api = opts.api;
    this.app = opts.app || globalThis.app || null;
    this.stage = opts.stage || null;
    this.onStatus = opts.onStatus || (() => {});
    this.liftTo3D = opts.liftTo3D || null;
    this.onLookStill = opts.onLookStill || null;
    this.onUseFrame = opts.onUseFrame || null;
    this.onChange = null;
    this._setDims(this.stage?.fw || 960, this.stage?.fh || 512);
    this.rect = { x: 0, y: 0, w: this.W, h: this.H };   // the document frame: Crop / Extend moves its edges
    this.cropAspect = null;
    this.docId = uid();
    this.layers = [];                             // bottom -> top
    this.activeId = null;
    this.selection = null;                        // EW x EH alpha canvas, or null
    this.tool = "mask";
    this.brush = { size: 60, hardness: 0.7, opacity: 1, color: "#ffffff" };
    this.eraseTarget = "mask";
    this.selStep = 8;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.magic = { points: [], busy: false };
    this.fill = { prompt: "", model: "", count: 2, busy: false, refs: new Set(), results: [], pick: -1, compare: true, split: 0.5,
      tune: { ...FILL_TUNE }, lastMode: "fill", extraRefs: [] };
    this.models = [];
    this.undoStack = []; this.redoStack = []; this.snapshots = [];
    this.sam = { local: false, ckpt: null, reason: "Checking SAM 3.1…" };
    this._dirty = new Set();
    this._build(container);
    this._initLayers();
    this._probeEngines();
    this.fit();
  }

  _setDims(w, h, margin = null) {
    this.W = Math.round(w); this.H = Math.round(h);
    this.M = margin ?? Math.round(0.35 * Math.max(this.W, this.H));   // room around the frame for Extend / moved layers
    this.EW = this.W + 2 * this.M;
    this.EH = this.H + 2 * this.M;
  }

  // ======================================================================= public API
  toJSON() {
    return {
      version: 2, docId: this.docId, frame: { w: this.W, h: this.H, margin: this.M }, rect: { ...this.rect },
      active: this.activeId,
      layers: this.layers.map((l) => ({ id: l.id, name: l.name, kind: l.kind, visible: l.visible, opacity: l.opacity,
        locked: l.locked, file: l.file || null, rev: l.rev || 0, stageMode: l.stageMode || undefined })),
      fill: { prompt: this.fill.prompt, model: this.fill.model, count: this.fill.count, tune: { ...this.fill.tune } },
    };
  }

  async load(json) {
    let data = json;
    if (typeof json === "string") { try { data = JSON.parse(json); } catch { data = null; } }
    if (!data || !Array.isArray(data.layers)) { this.refreshStage(); return; }
    this.docId = data.docId || this.docId;
    const fr = data.frame;
    if (fr?.w && fr?.h) this._setDims(fr.w, fr.h, fr.margin ?? null);
    this.rect = data.rect ? { ...data.rect } : { x: 0, y: 0, w: this.W, h: this.H };
    if (data.fill) {
      Object.assign(this.fill, { prompt: data.fill.prompt || "", model: data.fill.model || this.fill.model, count: data.fill.count || 2 });
      Object.assign(this.fill.tune, data.fill.tune || {});
    }
    this._syncFillInputs();
    const layers = [];
    for (const m of data.layers) {
      const layer = this._makeLayer(m.kind, m.name, { id: m.id, visible: m.visible !== false, opacity: m.opacity ?? 1,
        locked: !!m.locked, stageMode: m.stageMode });
      layer.file = m.file || null; layer.rev = m.rev || 0;
      if (m.file && (m.kind === "paint" || m.kind === "gen" || m.kind === "mask")) {
        try {
          const img = await loadImg(this._viewURL(m.file, "input", m.rev));
          layer.canvas.getContext("2d").drawImage(img, 0, 0);
        } catch { this.onStatus(`Paint Studio: layer ${m.name} is missing on the server`); }
      }
      layers.push(layer);
    }
    this.layers = layers;
    if (!this.layers.some((l) => l.kind === "mask")) this.layers.push(this._makeLayer("mask", "Fill mask"));
    this.activeId = data.active && this.layers.some((l) => l.id === data.active) ? data.active : this.layers.find((l) => l.kind === "paint")?.id;
    this.undoStack = []; this.redoStack = [];
    await this._fillBackdrop();
    this.refreshStage();
    this._renderLayers();
    this._renderHistory();
    this.fit();
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
    } catch (e) { console.warn("[Soundstage paint] stage render", e); }
    this._renderLayers();
    this.render();
  }

  fit() {
    const r = this.viewEl.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) { this._needFit = true; return; }
    this._needFit = false;
    const b = this.rect;
    const s = Math.max(0.03, Math.min((r.width - 36) / b.w, (r.height - 36) / b.h));
    this.view = { s, tx: (r.width - b.w * s) / 2 - b.x * s, ty: (r.height - b.h * s) / 2 - b.y * s };
    this._userView = false;
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
    const mask = this._makeLayer("mask", "Fill mask");
    this.layers = [backdrop, stage, paint, mask];
    this.activeId = paint.id;
    this._fillBackdrop().then(() => this.render());
    this.refreshStage();
  }

  /** Resize the document to w x h (a bigger chosen frame): every layer is scaled with it, history restarts. */
  _resizeDoc(w, h) {
    const k = w / this.W, ky = h / this.H, oldW = this.W, oldH = this.H, oldM = this.M, oEW = this.EW, oEH = this.EH;
    this._setDims(w, h);
    const scale = (c) => {
      const n = newCanvas(this.EW, this.EH), x = n.getContext("2d");
      x.imageSmoothingQuality = "high";
      x.drawImage(c, 0, 0, oEW, oEH, this.M - oldM * k, this.M - oldM * k, oEW * k, oEH * k);
      return n;
    };
    for (const l of this.layers) { l.canvas = scale(l.canvas); l.thumbDirty = true; this._markDirty(l); }
    if (this.selection) this.selection = scale(this.selection);
    const r = this.rect;
    this.rect = r.x === 0 && r.y === 0 && r.w === oldW && r.h === oldH ? { x: 0, y: 0, w, h }
      : { x: Math.round(r.x * k), y: Math.round(r.y * ky), w: Math.round(r.w * k), h: Math.round(r.h * ky) };
    this.undoStack = []; this.redoStack = []; this.snapshots = [];
    this._clearResults();
    this._fillBackdrop().then(() => this.render());
    this.refreshStage();
    this.fit();
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
    } catch { this.onStatus("Paint Studio: could not load the backdrop plate"); }
    this._renderLayers();
  }

  get active() { return this.layers.find((l) => l.id === this.activeId) || null; }
  get maskLayer() { return this.layers.find((l) => l.kind === "mask" && l.visible) || this.layers.find((l) => l.kind === "mask"); }
  _rasterLayers() { return this.layers.filter((l) => l.kind !== "mask"); }

  // ======================================================================= history
  _structSnap() {
    return { list: this.layers.map((l) => ({ l, props: { name: l.name, visible: l.visible, opacity: l.opacity, locked: l.locked, canvas: l.canvas } })),
      activeId: this.activeId, selection: this.selection, rect: { ...this.rect } };
  }

  _restoreStruct(s) {
    this.layers = s.list.map(({ l, props }) => { Object.assign(l, props); l.thumbDirty = true; this._markDirty(l); return l; });
    this.activeId = s.activeId; this.selection = s.selection; this.rect = { ...s.rect };
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

  undo(quiet = false) {
    const e = this.undoStack.pop();
    if (!e) return;
    this._restoreStruct(e.before);
    for (const p of e.patches) { ctx2d(p.layer.canvas).putImageData(p.before, p.r.x, p.r.y); p.layer.thumbDirty = true; this._markDirty(p.layer); }
    this.redoStack.push(e);
    if (!quiet) { this.onStatus(`Undo: ${e.label}`); this._afterChange(); }
  }

  redo(quiet = false) {
    const e = this.redoStack.pop();
    if (!e) return;
    this._restoreStruct(e.after);
    for (const p of e.patches) { ctx2d(p.layer.canvas).putImageData(p.after, p.r.x, p.r.y); p.layer.thumbDirty = true; this._markDirty(p.layer); }
    this.undoStack.push(e);
    if (!quiet) { this.onStatus(`Redo: ${e.label}`); this._afterChange(); }
  }

  /** Jump to history state n (0 = the opening state, k = after the k-th step). */
  goToState(n) {
    while (this.undoStack.length > n && this.undoStack.length) this.undo(true);
    while (this.undoStack.length < n && this.redoStack.length) this.redo(true);
    this._afterChange();
  }

  _clampRect(r) {
    const x = clamp(Math.floor(r.x), 0, this.EW), y = clamp(Math.floor(r.y), 0, this.EH);
    return { x, y, w: clamp(Math.ceil(r.x + r.w), 0, this.EW) - x, h: clamp(Math.ceil(r.y + r.h), 0, this.EH) - y };
  }

  _afterChange() {
    this._ver = (this._ver || 0) + 1;
    this._renderLayers();
    this._renderOptions();
    this._renderHistory();
    this._renderFillState();
    this.render();
    this._scheduleSave();
  }

  /** A snapshot of every layer (Photoshop's History snapshots): restoring it is one undoable step. */
  takeSnapshot() {
    const n = this.snapshots.length + 1;
    const thumb = this.composite(this.rect, 160, Math.max(1, Math.round((160 * this.rect.h) / this.rect.w)), { background: "#120d16" }).toDataURL("image/jpeg", 0.7);
    this.snapshots.push({ name: `Snapshot ${n}`, thumb, rect: { ...this.rect },
      list: this.layers.map((l) => ({ l, props: { name: l.name, visible: l.visible, opacity: l.opacity, locked: l.locked, canvas: cloneCanvas(l.canvas) } })) });
    if (this.snapshots.length > 6) this.snapshots.shift();
    this._renderHistory();
    this.onStatus(`Snapshot ${n} saved: click it in History to come back to this state`);
  }

  restoreSnapshot(snap) {
    this._record(`Restore ${snap.name}`, () => {
      this.layers = snap.list.map(({ l, props }) => { Object.assign(l, props, { canvas: cloneCanvas(props.canvas) }); this._markDirty(l); return l; });
      this.rect = { ...snap.rect };
      if (!this.layers.some((l) => l.id === this.activeId)) this.activeId = this.layers.find((l) => l.kind === "paint")?.id || this.layers[0]?.id;
    });
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
      } catch (e) { this._dirty.add(id); this.onStatus(`Paint Studio save failed: ${e.message}`); }
    }
    this.onChange?.(this.toJSON());
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

  /** White-on-transparent of the fill area for a world rect: the selection if there is one, else the mask layer. */
  _areaCrop(rect, useSelection = true) {
    const out = newCanvas(rect.w, rect.h), c = out.getContext("2d");
    const src = useSelection && this.selection ? this.selection : this.maskLayer?.canvas;
    if (src) c.drawImage(src, rect.x + this.M, rect.y + this.M, rect.w, rect.h, 0, 0, rect.w, rect.h);
    c.globalCompositeOperation = "source-in"; c.fillStyle = "#fff"; c.fillRect(0, 0, rect.w, rect.h);
    return out;
  }

  // ======================================================================= UI
  _build(container) {
    this.root = el("div", { class: "ss-cv", tabindex: "0", "aria-label": "Paint Studio" });
    this.root.ssPaint = this;   // handle for scripts and tests
    container.appendChild(this.root);
    // Nothing in here reaches the 3D stage or ComfyUI's graph canvas behind it.
    for (const t of ["pointerdown", "pointermove", "pointerup", "keydown", "keyup", "wheel", "contextmenu", "dblclick"]) {
      this.root.addEventListener(t, (e) => e.stopPropagation());
    }
    this.useBtn = el("button", { class: "ss-cv-cta", type: "button", title: "Make this picture the shot's first frame: Motion animates it",
      onclick: () => this.useAsFirstFrame() }, icon("check", 15), el("span", {}, "Use as first frame"));
    const head = el("div", { class: "ss-cv-headbar" },
      el("div", { class: "ss-cv-title" }, icon("wand-sparkles", 18), "Paint Studio"),
      el("div", { class: "ss-cv-sub" }, "Select or mask an area, describe it, Generative Fill. Drag the canvas edge out (C) to extend the frame."),
      this.useBtn);
    this.optsEl = el("div", { class: "ss-cv-opts" });
    this.rail = el("div", { class: "ss-cv-rail", role: "toolbar", "aria-label": "Paint tools", "aria-orientation": "vertical" });
    this.toolBtns = {};
    for (const t of TOOLS) {
      if (t === "|") { this.rail.append(el("div", { class: "ss-cv-sep", "aria-hidden": "true" })); continue; }
      const [id, ic, name, key, tip] = t;
      const b = el("button", { class: "ss-cv-tool", type: "button", title: tip, "aria-label": `${name} (${key})`, "aria-pressed": "false",
        onclick: () => this.setTool(id) }, icon(ic, 18), el("kbd", {}, key));
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
    this.fillEl = el("div", { class: "ss-cv-fill", role: "group", "aria-label": "Generative Fill" });
    this.filmEl = el("div", { class: "ss-cv-film", hidden: "" });
    this.root.append(head, this.optsEl, this.rail, this.viewEl, this.fillEl, this.filmEl, this.side);
    this._buildFill();
    this._buildSide();
    this._bindView();
    this._ro = new ResizeObserver(() => {
      const narrow = this.root.clientWidth < 820;
      this.root.classList.toggle("ss-cv-narrow", narrow);
      const r = this.viewEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (r.width > 0 && (this.cv.width !== Math.round(r.width * dpr) || this.cv.height !== Math.round(r.height * dpr))) {
        this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
        if (this._needFit || !this._userView) this.fit(); else this.render();
      }
    });
    this._ro.observe(this.root);
    this.setTool("mask");
  }

  _buildFill() {
    const f = this.fill;
    this.areaNote = el("span", { class: "area" });
    this.modelSel = el("select", { "aria-label": "Fill model", title: "The image model that paints the fill",
      onchange: () => { f.model = this.modelSel.value; this._scheduleSave(); } });
    this.countSeg = el("span", { class: "ss-cv-seg", role: "group", "aria-label": "Variations" },
      ...[1, 2, 4].map((n) => el("button", { type: "button", "aria-pressed": String(n === f.count), title: `${n} variation${n > 1 ? "s" : ""} (one per seed)`,
        onclick: () => { f.count = n; for (const b of this.countSeg.children) b.setAttribute("aria-pressed", String(+b.textContent === n)); this._scheduleSave(); } }, String(n))));
    this.promptIn = el("input", { type: "text", class: "ss-cv-prompt", placeholder: "What to put there (a brass floor lamp) · what to remove (optional) · what lies beyond the frame",
      "aria-label": "Generative Fill prompt" });
    this.promptIn.addEventListener("input", () => { f.prompt = this.promptIn.value; this._scheduleSave(); });
    this.promptIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.generativeFill(this._hasHole() && !this._hasArea() ? "extend" : "fill"); } });
    this.fillBtn = el("button", { class: "ss-cv-act main", type: "button", title: "Repaint the selected / masked area with what you describe (Enter)",
      onclick: () => this.generativeFill("fill") }, icon("sparkles", 16), el("span", {}, "Generative Fill"));
    this.removeBtn = el("button", { class: "ss-cv-act", type: "button", title: "Erase what is in the selected / masked area: the background continues through it",
      onclick: () => this.generativeFill("remove") }, icon("eraser", 16), "Remove");
    this.extendBtn = el("button", { class: "ss-cv-act", type: "button", title: "Paint the empty canvas around the picture (drag the edges out with Crop / Extend, C)",
      onclick: () => this.generativeFill("extend") }, icon("expand", 16), "Extend");
    this.refsEl = el("div", { class: "ss-cv-refs" });
    const num = (key, label, min, max, step, tip) => {
      const i = el("input", { type: "number", min, max, step, value: f.tune[key], title: tip, "aria-label": label,
        onchange: () => { f.tune[key] = +i.value; this._scheduleSave(); } });
      this[`tune_${key}`] = i;
      return el("label", { title: tip }, label, i);
    };
    this.seedIn = el("input", { type: "number", min: 0, step: 1, placeholder: "random", "aria-label": "Seed", style: "width:110px",
      title: "Empty = a new random seed each time (variations add to it)" });
    const tune = el("details", { class: "ss-cv-tune" }, el("summary", {}, "Fine-tune: seam, grow, steps, seed"),
      el("div", { class: "ss-cv-tunegrid" },
        num("feather", "Seam feather px", 0, 128, 1, "How soft the edge between the fill and the picture is"),
        num("grow", "Grow mask px", 0, 96, 1, "Grow the area a little so outlines and halos are repainted too"),
        num("steps", "Steps", 0, 60, 1, "0 = the model's tuned default (Klein 16, Krea 8)"),
        num("megapixels", "Detail MP", 0.5, 2.5, 0.1, "Model resolution of the area: 1.0 ≈ 1024²; higher = more detail, slower"),
        el("label", {}, "Seed", this.seedIn)));
    this.fillWarn = el("div", { class: "ss-cv-warn" });
    this.fillEl.append(
      el("div", { class: "ss-cv-fillhead" },
        el("span", { class: "lbl" }, icon("sparkles", 15), "Generative Fill"), this.areaNote,
        el("label", { class: "ss-cv-note", style: "display:flex;gap:6px;align-items:center" }, "Variations", this.countSeg),
        this.modelSel),
      el("div", { class: "ss-cv-fillrow" }, this.promptIn, this.fillBtn, this.removeBtn, this.extendBtn),
      this.refsEl, tune, this.fillWarn);
    // Results filmstrip
    this.strip = el("div", { class: "ss-cv-strip", role: "listbox", "aria-label": "Fill variations" });
    this.compareBtn = el("button", { class: "ss-cv-btn", type: "button", "aria-pressed": "true", title: "Before / after slider on the canvas (drag the line)",
      onclick: () => { f.compare = !f.compare; this.compareBtn.setAttribute("aria-pressed", String(f.compare)); this.render(); } }, icon("columns-2", 13), "Before / after");
    this.applyBtn = el("button", { class: "ss-cv-cta", type: "button", title: "Keep this variation as a new layer", onclick: () => this.applyResult() },
      icon("check", 14), "Keep");
    this.filmEl.append(el("span", { class: "ss-cv-note", style: "width:100%" }, "Variations: click one to preview it on the canvas, Keep adds it as a layer."),
      this.strip, el("div", { class: "ss-cv-row" }, this.compareBtn,
        el("button", { class: "ss-cv-btn", type: "button", title: "Throw these variations away", onclick: () => { this._clearResults(); this.render(); } }, icon("x", 13), "Discard"),
        this.applyBtn));
    this._syncFillInputs();
  }

  _syncFillInputs() {
    if (!this.promptIn) return;
    this.promptIn.value = this.fill.prompt || "";
    for (const b of this.countSeg.children) b.setAttribute("aria-pressed", String(+b.textContent === this.fill.count));
    for (const k of Object.keys(FILL_TUNE)) if (this[`tune_${k}`]) this[`tune_${k}`].value = this.fill.tune[k];
    if (this.models.some((m) => m.key === this.fill.model)) this.modelSel.value = this.fill.model;
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
    const up = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: async () => {
      const f = up.files?.[0]; up.value = ""; if (f) await this.importImage(URL.createObjectURL(f), f.name.replace(/\.[^.]+$/, "")); } });
    const layerTools = el("div", { class: "ss-cv-row" },
      ib("plus", "New paint layer", () => this.addLayer()),
      ib("copy", "Duplicate layer", () => this.duplicateLayer()),
      ib("merge", "Merge down", () => this.mergeDown()),
      ib("chevron-up", "Move layer up", () => this.moveLayer(1)),
      ib("chevron-down", "Move layer down", () => this.moveLayer(-1)),
      ib("trash-2", "Delete layer", () => this.deleteLayer()),
      ib("upload", "Import an image as a layer", () => up.click()),
      ib("refresh", "Re-render the Stage layer at the playhead", () => this.refreshStage()), up);
    this.liftRow = el("div", { class: "ss-cv-row" }, el("span", { class: "ss-cv-note", style: "flex:1" }, "Lift to 3D"),
      el("button", { class: "ss-cv-btn", type: "button", title: "Flat cut-out card in the 3D stage", onclick: () => this.lift("card") }, icon("square", 13), "Card"),
      el("button", { class: "ss-cv-btn", type: "button", title: "Gaussian splat (TripoSplat)", onclick: () => this.lift("splat") }, icon("sparkles", 13), "Splat"),
      el("button", { class: "ss-cv-btn", type: "button", title: "Mesh (image to 3D)", onclick: () => this.lift("mesh") }, icon("box", 13), "Mesh"));
    this.liftRow.hidden = !this.liftTo3D;
    const layersCard = el("div", { class: "ss-cv-card" },
      el("div", { class: "ss-cv-head" }, icon("layers", 14), el("span", {}, "Layers")),
      this.layerList,
      el("div", { class: "ss-cv-row" }, el("label", {}, "Opacity", this.opacityIn)),
      layerTools, this.liftRow);
    // ---- History
    this.histList = el("div", { class: "ss-cv-hist", role: "list", "aria-label": "History" });
    this.snapList = el("div", { class: "ss-cv-snaps" });
    const histCard = el("div", { class: "ss-cv-card" },
      el("div", { class: "ss-cv-head" }, icon("history", 14), el("span", {}, "History"),
        ib("undo-2", "Undo (Ctrl/Cmd+Z)", () => this.undo()), ib("redo-2", "Redo (Shift+Ctrl/Cmd+Z)", () => this.redo()),
        ib("camera", "Snapshot: save this state to come back to", () => this.takeSnapshot())),
      this.histList, this.snapList);
    this.side.append(layersCard, histCard);
  }

  setTool(id) {
    if (!this.toolBtns[id]) return;
    this.tool = id;
    for (const [k, b] of Object.entries(this.toolBtns)) b.setAttribute("aria-pressed", String(k === id));
    this._cursor();
    this._renderOptions();
    this.render();
  }

  _cursor() {
    const id = this.tool;
    this.viewEl.style.cursor = this._spacePan || id === "hand" ? "grab" : id === "move" ? "move" : id === "zoom" ? "zoom-in"
      : BRUSH_TOOLS.includes(id) ? "none" : "crosshair";
  }

  _renderOptions() {
    const o = this.optsEl;
    o.replaceChildren();
    const t = TOOLS.find((x) => x !== "|" && x[0] === this.tool);
    o.append(el("span", { class: "ss-cv-toolname" }, icon(t[1], 15), t[2]));
    const range = (label, key, min, max, step, fmt = (v) => v, tip = "") => {
      const out = el("output", {}, String(fmt(this.brush[key])));
      const inp = el("input", { type: "range", min, max, step, value: this.brush[key], "aria-label": label, title: tip,
        oninput: () => { this.brush[key] = +inp.value; out.textContent = fmt(this.brush[key]); this.render(); } });
      return el("label", { title: tip }, label, inp, out);
    };
    const btn = (label, fn, ic, tip, pressed) => el("button", { class: "ss-cv-btn", type: "button", title: tip || label, onclick: fn,
      "aria-pressed": pressed === undefined ? undefined : String(pressed) }, ic ? icon(ic, 13) : null, label);
    const note = (text) => el("span", { class: "ss-cv-note" }, text);
    if (BRUSH_TOOLS.includes(this.tool)) {
      o.append(range("Size", "size", 1, 600, 1, (v) => v, "[ and ] change it"),
        range("Hardness", "hardness", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, "Low hardness = a feathered edge"),
        range("Opacity", "opacity", 0.05, 1, 0.05, (v) => `${Math.round(v * 100)}%`));
      if (this.tool === "paint") {
        const c = el("input", { type: "color", value: this.brush.color, "aria-label": "Brush colour", oninput: () => { this.brush.color = c.value; } });
        o.append(el("label", {}, "Colour", c));
      }
      if (this.tool === "eraser") {
        o.append(el("span", { class: "ss-cv-seg" },
          ...[["mask", "Mask"], ["layer", "Layer pixels"]].map(([k, l]) => el("button", { type: "button", "aria-pressed": String(this.eraseTarget === k),
            onclick: () => { this.eraseTarget = k; this._renderOptions(); } }, l))));
      }
      if (this.tool !== "paint") o.append(btn("Clear mask", () => this.clearMask(), "trash-2"));
    } else if (this.tool === "magic") {
      const nIn = this.magic.points.filter((p) => p.label).length, nOut = this.magic.points.filter((p) => !p.label).length;
      o.append(note(this.sam.local ? (this.magic.busy ? "Selecting…" : nIn + nOut ? `${nIn} in · ${nOut} out` : "Click an object; Shift-click to leave something out")
        : this.sam.reason || "SAM 3.1 not found"));
      if (this.magic.points.length) o.append(btn("Clear points", () => { this.magic.points = []; this._renderOptions(); this.render(); }, "x"));
    } else if (this.tool === "crop") {
      const r = this.rect;
      const ext = this._extension();
      o.append(el("span", { class: "ss-cv-seg", role: "group", "aria-label": "Aspect" },
        el("button", { type: "button", "aria-pressed": String(!this.cropAspect), title: "Free: drag any edge", onclick: () => { this.cropAspect = null; this._renderOptions(); } }, "Free"),
        ...ASPECT_PRESETS.map(([k, a]) => el("button", { type: "button", "aria-pressed": String(this.cropAspect === a), title: `Extend the frame to ${k}`,
          onclick: () => this.setAspect(a) }, k))),
        note(`${r.w}×${r.h} · ${(r.w / r.h).toFixed(2)}:1${ext ? ` · ${ext}` : ""}`),
        btn("Reset", () => this._record("Reset canvas", () => { this.rect = { x: 0, y: 0, w: this.W, h: this.H }; this.cropAspect = null; }), "rotate-ccw", "Back to the original frame"));
    } else if (this.tool === "picker") {
      o.append(note("Click to pick a paint colour"), el("span", { style: `width:22px;height:22px;border-radius:6px;background:${this.brush.color};border:1px solid rgba(255,255,255,.2)` }));
    } else if (this.tool === "move") {
      o.append(note(this.selection ? "Drag moves the selected pixels onto a new layer" : "Drag moves the active layer; corners scale"));
    } else if (this.tool === "zoom") {
      o.append(btn("Fit", () => this.fit(), "scan", "Fit (F)"), btn("100%", () => this._zoomAt(null, 1 / this.view.s), null, "Actual pixels"));
    } else if (this.tool === "marquee" || this.tool === "lasso") {
      o.append(note("Shift adds · Alt subtracts · Ctrl/Cmd+D deselects"));
    }
    if (this.selection) {
      const stepIn = el("input", { type: "number", min: 1, max: 200, value: this.selStep, style: "width:60px", "aria-label": "Grow / shrink by px",
        onchange: () => { this.selStep = clamp(+stepIn.value || 8, 1, 200); } });
      o.append(el("span", { class: "ss-cv-chip hot" }, "Selection"),
        btn("Grow", () => this.growSelection(this.selStep), "circle-plus", "Grow the selection"),
        btn("Shrink", () => this.growSelection(-this.selStep), "circle-minus", "Shrink the selection"), stepIn,
        btn("Feather", () => this.featherSelection(this.selStep), null, "Soften the selection edge"),
        btn("To mask", () => this.selectionToMask(), "highlighter", "Add the selection to the fill mask"),
        btn("To layer", () => this.selectionToLayer(false), "copy", "Copy the selected pixels to a new layer"),
        btn("Invert", () => this.invertSelection()),
        btn("Deselect", () => this.deselect(), "x", "Ctrl/Cmd+D"));
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
      const row = el("div", { class: "ss-cv-layer", role: "option", "aria-selected": String(l.id === this.activeId), onclick: () => { this.activeId = l.id; this._renderLayers(); this._renderOptions(); this.render(); } },
        eye, thumb, el("div", { style: "min-width:0" }, name, el("div", { class: "ss-cv-kind" }, { backdrop: "plate", stage: `stage · ${l.stageMode}`, paint: "paint", gen: "generated", mask: "fill mask" }[l.kind] || l.kind)), lock);
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

  _renderHistory() {
    if (!this.histList) return;
    const n = this.undoStack.length;
    const items = [el("button", { type: "button", "aria-current": String(n === 0), onclick: () => this.goToState(0) }, icon("image", 13), "Opened")];
    this.undoStack.forEach((e, i) => items.push(el("button", { type: "button", "aria-current": String(i === n - 1), onclick: () => this.goToState(i + 1) }, e.label)));
    [...this.redoStack].reverse().forEach((e, i) => items.push(el("button", { type: "button", class: "redo", onclick: () => this.goToState(n + i + 1) }, e.label)));
    this.histList.replaceChildren(...items);
    const cur = this.histList.querySelector('[aria-current="true"]');
    cur?.scrollIntoView?.({ block: "nearest" });
    this.snapList.replaceChildren(...this.snapshots.map((s) => el("button", { type: "button", title: `Restore ${s.name}`, onclick: () => this.restoreSnapshot(s) },
      el("img", { src: s.thumb, alt: "" }), el("span", {}, s.name))));
  }

  // ======================================================================= layer ops
  addLayer(kind = "paint", name = null, canvas = null) {
    const l = this._makeLayer(kind, name || `${kind === "gen" ? "Fill" : "Paint"} ${this.layers.filter((x) => x.kind === kind).length + 1}`);
    if (canvas) l.canvas = canvas;
    this._record("New layer", () => this._insertLayer(l));
    this._markDirty(l);
    return l;
  }

  _insertLayer(l) {
    const at = this.layers.findIndex((x) => x.id === this.activeId);
    const idx = at < 0 ? this.layers.length : Math.min(at + 1, this.layers.length);
    const firstMask = this.layers.findIndex((x) => x.kind === "mask");
    this.layers.splice(firstMask >= 0 && idx > firstMask ? firstMask : idx, 0, l);
    this.activeId = l.id;
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
    if (!m || !alphaBounds(m.canvas)) return;
    this._record("Clear mask", () => { m.canvas.getContext("2d").clearRect(0, 0, this.EW, this.EH); }, [[m, null]]);
  }

  /** Bring an image in as a layer, fitted to the frame. The shot's chosen frame (about the frame's shape) makes the
   *  document its exact size, so Paint Studio works at the frame's real resolution and the picture fills it. */
  async importImage(src, name = "Image", { asFrame = name === "Your chosen frame" } = {}) {
    try {
      const img = await loadImg(src);
      const close = Math.abs(img.width / img.height / (this.W / this.H) - 1) < 0.06;
      if (asFrame && close) {
        const s = Math.min(1, MAX_DOC / Math.max(img.width, img.height));
        const w = Math.round(img.width * s), h = Math.round(img.height * s);
        if (w !== this.W || h !== this.H) this._resizeDoc(w, h);
      }
      const c = newCanvas(this.EW, this.EH);
      const fill = asFrame && close;   // the frame fills the document; anything else is fitted inside it
      const s = fill ? 0 : Math.min(this.W / img.width, this.H / img.height);
      const w = fill ? this.W : img.width * s, h = fill ? this.H : img.height * s;
      const x = c.getContext("2d");
      x.imageSmoothingQuality = "high";
      x.drawImage(img, this.M + (this.W - w) / 2, this.M + (this.H - h) / 2, w, h);
      this.addLayer("paint", name, c);
      this.onStatus(`${name} is in Paint Studio (${this.W}×${this.H})`);
      this.fit();
    } catch { this.onStatus("Could not load that image"); }
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
    ctx.fillStyle = "#fff"; ctx.fillRect(this.rect.x + this.M, this.rect.y + this.M, this.rect.w, this.rect.h);
    if (this.selection) { ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(this.selection, 0, 0); }
    this._record("Invert selection", () => { this.selection = next; });
  }

  growSelection(px) {
    const sel = this.selection;
    const bb = sel && alphaBounds(sel);
    if (!bb) return;
    const pad = Math.max(0, px) + 2;
    const r = this._clampRect({ x: bb.x - pad, y: bb.y - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad });
    const id = ctx2d(sel).getImageData(r.x, r.y, r.w, r.h);
    const a = new Uint8ClampedArray(r.w * r.h);
    for (let i = 0; i < a.length; i++) a[i] = id.data[i * 4 + 3];
    const out = morphAlpha(a, r.w, r.h, px);
    for (let i = 0; i < out.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = out[i]; }
    const next = cloneCanvas(sel);
    ctx2d(next).putImageData(id, r.x, r.y);
    const empty = !alphaBounds(next);
    this._record(px > 0 ? `Grow selection ${px}px` : `Shrink selection ${-px}px`, () => { this.selection = empty ? null : next; });
  }

  featherSelection(px) {
    if (!this.selection) return;
    const next = this._newSel(), c = next.getContext("2d");
    c.filter = `blur(${Math.max(1, px / 2)}px)`;
    c.drawImage(this.selection, 0, 0);
    this._record(`Feather selection ${px}px`, () => { this.selection = next; });
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
      this.selection = null;
    }, [[m, null]]);
    this.onStatus("The selection is now part of the fill mask");
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
    if (!this.selection || !a || a.locked) { this.onStatus(a?.locked ? `${a.name} is locked: Remove (Generative Fill) erases it from the picture instead` : "Nothing selected"); return; }
    const next = cloneCanvas(a.canvas);
    const ctx = next.getContext("2d"); ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(this.selection, 0, 0);
    this._record("Erase selection", () => { a.canvas = next; });
    this._markDirty(a);
  }

  // ======================================================================= Crop / Extend
  _lim() { return { x: -this.M, y: -this.M, w: this.EW, h: this.EH }; }

  /** Extend the frame to an aspect around the picture (never cropping it when there is room). */
  setAspect(a) {
    this.cropAspect = a;
    const next = aspectRect({ x: 0, y: 0, w: this.W, h: this.H }, a, this._lim());
    this._record(`Canvas ${ASPECT_PRESETS.find((p) => p[1] === a)?.[0] || a.toFixed(2)}`, () => { this.rect = next; });
    this.fit();
    if (this._hasHole()) this.onStatus("The new canvas is empty: press Extend (under the canvas) to paint it");
  }

  _extension() {
    const r = this.rect, parts = [];
    if (r.x < 0) parts.push(`${-r.x} left`);
    if (r.x + r.w > this.W) parts.push(`${r.x + r.w - this.W} right`);
    if (r.y < 0) parts.push(`${-r.y} top`);
    if (r.y + r.h > this.H) parts.push(`${r.y + r.h - this.H} bottom`);
    return parts.length ? `extends ${parts.join(", ")} px` : "";
  }

  _cropHandle(sx, sy) {
    const r = this.rect;
    const [x0, y0] = this.w2s(r.x, r.y), [x1, y1] = this.w2s(r.x + r.w, r.y + r.h);
    const tol = 9;
    const nearX = (x) => Math.abs(sx - x) < tol, nearY = (y) => Math.abs(sy - y) < tol;
    const inY = sy > y0 - tol && sy < y1 + tol, inX = sx > x0 - tol && sx < x1 + tol;
    let h = "";
    if (nearY(y0) && inX) h += "n"; else if (nearY(y1) && inX) h += "s";
    if (nearX(x0) && inY) h += "w"; else if (nearX(x1) && inY) h += "e";
    if (h) return h;
    return sx > x0 && sx < x1 && sy > y0 && sy < y1 ? "move" : null;
  }

  _cropMove(d, wx, wy) {
    const b = d.rect, L = this._lim();
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    const dx = wx - d.x0, dy = wy - d.y0;
    if (d.h === "move") {
      const nx = clamp(b.x + dx, L.x, L.x + L.w - b.w), ny = clamp(b.y + dy, L.y, L.y + L.h - b.h);
      d.live = { x: Math.round(nx), y: Math.round(ny), w: b.w, h: b.h };
      return;
    }
    if (d.h.includes("w")) x0 = clamp(b.x + dx, L.x, x1 - 64);
    if (d.h.includes("e")) x1 = clamp(b.x + b.w + dx, x0 + 64, L.x + L.w);
    if (d.h.includes("n")) y0 = clamp(b.y + dy, L.y, y1 - 64);
    if (d.h.includes("s")) y1 = clamp(b.y + b.h + dy, y0 + 64, L.y + L.h);
    const a = this.cropAspect;
    if (a) {   // keep the preset shape: width leads on side / corner drags, height on top / bottom drags
      if (d.h === "n" || d.h === "s") { const w = (y1 - y0) * a, cx = (x0 + x1) / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
      else { const hh = (x1 - x0) / a; if (d.h.includes("n")) y0 = y1 - hh; else if (d.h.includes("s")) y1 = y0 + hh; else { const cy = (y0 + y1) / 2; y0 = cy - hh / 2; y1 = cy + hh / 2; } }
      if (x0 < L.x || x1 > L.x + L.w || y0 < L.y || y1 > L.y + L.h) return;   // would leave the canvas room
    }
    d.live = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
  }

  // ======================================================================= view + input
  w2s(x, y) { return [x * this.view.s + this.view.tx, y * this.view.s + this.view.ty]; }
  s2w(x, y) { return [(x - this.view.tx) / this.view.s, (y - this.view.ty) / this.view.s]; }
  _evScreen(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _evWorld(e) { const [sx, sy] = this._evScreen(e); return this.s2w(sx, sy); }

  _zoomAt(screen, k) {
    const r = this.cv.getBoundingClientRect();
    const [sx, sy] = screen || [r.width / 2, r.height / 2];
    const s = clamp(this.view.s * k, 0.03, 32);
    const [wx, wy] = this.s2w(sx, sy);
    this.view.s = s; this.view.tx = sx - wx * s; this.view.ty = sy - wy * s;
    this._userView = true;
    this.render();
  }

  _bindView() {
    const v = this.viewEl;
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.addEventListener("pointerdown", (e) => this._down(e));
    v.addEventListener("pointermove", (e) => this._move(e));
    v.addEventListener("pointerup", (e) => this._up(e));
    v.addEventListener("pointercancel", (e) => this._up(e));
    v.addEventListener("pointerleave", () => { this._hover = null; this._overView = false; this.render(); });
    v.addEventListener("pointerenter", () => { this._overView = true; });
    // ComfyUI's canvas eats wheel events over DOM widgets; route wheel-over-viewport here (capture phase).
    this._wheelRouter = (e) => {
      if (!this.viewEl.contains(e.target)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const sp = this._evScreen(e);
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) { this.view.tx -= e.deltaX || e.deltaY; this._userView = true; this.render(); return; }
      this._zoomAt(sp, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    window.addEventListener("wheel", this._wheelRouter, { capture: true, passive: false });
    const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    this._keyRouter = (e) => {
      if (!this.root.isConnected || this.root.closest("[hidden]")) return;
      if (!this.root.contains(document.activeElement) && !this._overView) return;
      if (typing(e.target)) return;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if (mod && k === "z") (e.shiftKey ? this.redo() : this.undo());
      else if (mod && k === "y") this.redo();
      else if (mod && k === "d") this.deselect();
      else if (mod && e.shiftKey && k === "i") this.invertSelection();
      else if (mod && k === "a") this._applySelection((c) => c.fillRect(this.rect.x + this.M, this.rect.y + this.M, this.rect.w, this.rect.h), "replace", "Select all");
      else if (mod && (k === "=" || k === "+")) this._zoomAt(null, 1.25);
      else if (mod && k === "-") this._zoomAt(null, 0.8);
      else if (mod && k === "0") this.fit();
      else if (mod) handled = false;
      else if (e.key === " ") { if (!this._spacePan) { this._spacePan = true; this._cursor(); } }
      else if (e.key === "Escape") {
        if (this.magic.points.length) { this.magic.points = []; this._renderOptions(); this.render(); }
        else if (this.fill.results.length && !this.fill.busy) { this._clearResults(); this.render(); }
        else this.deselect();
      }
      else if (e.key === "Delete" || e.key === "Backspace") this.deleteSelected();
      else if (e.key === "[") { this.brush.size = Math.max(1, Math.round(this.brush.size / 1.2)); this._renderOptions(); this.render(); }
      else if (e.key === "]") { this.brush.size = Math.min(600, Math.round(this.brush.size * 1.2)); this._renderOptions(); this.render(); }
      else if (k === "f") this.fit();
      else if (KEYS[k]) this.setTool(KEYS[k]);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    this._keyUpRouter = (e) => { if (e.key === " " && this._spacePan) { this._spacePan = false; this._cursor(); e.stopPropagation(); } };
    window.addEventListener("keydown", this._keyRouter, true);
    window.addEventListener("keyup", this._keyUpRouter, true);
  }

  _down(e) {
    this.root.focus({ preventScroll: true });
    const [wx, wy] = this._evWorld(e);
    const [sx, sy] = this._evScreen(e);
    const pan = e.button === 1 || this._spacePan || this.tool === "hand";
    try { this.viewEl.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
    if (pan) { this._drag = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty }; this.viewEl.style.cursor = "grabbing"; return; }
    // The before / after line is draggable whatever the tool.
    const pr = this._previewRect();
    if (pr && this.fill.compare) {
      const [lx] = this.w2s(pr.x + pr.w * this.fill.split, 0);
      if (Math.abs(sx - lx) < 10) { this._drag = { kind: "split" }; return; }
    }
    if (e.button === 2 && this.tool !== "magic") return;
    const mode = e.shiftKey ? "add" : e.altKey ? "sub" : "replace";
    switch (this.tool) {
      case "mask": case "eraser": case "paint": this._strokeStart(wx, wy, e); break;
      case "picker": this._pick(wx, wy); break;
      case "marquee": this._drag = { kind: "rect", x0: wx, y0: wy, x1: wx, y1: wy, mode }; break;
      case "lasso": this._drag = { kind: "lasso", pts: [[wx, wy]], mode }; break;
      case "magic": {
        if (!this.sam.local) { this.onStatus(this.sam.reason || "SAM 3.1 is not available on this ComfyUI"); break; }
        const label = e.button === 2 || e.shiftKey || e.altKey ? 0 : 1;
        this.magic.points.push({ x: wx, y: wy, label });
        this._renderOptions(); this.render();
        clearTimeout(this._magicT);
        this._magicT = setTimeout(() => this.runMagic(), 350);
        break;
      }
      case "crop": {
        const h = this._cropHandle(sx, sy);
        if (h) this._drag = { kind: "crop", h, x0: wx, y0: wy, rect: { ...this.rect }, live: null };
        break;
      }
      case "zoom": this._zoomAt([sx, sy], e.altKey ? 0.6 : 1.6); break;
      case "move": this._transformStart(wx, wy, e); break;
    }
  }

  _move(e) {
    const [wx, wy] = this._evWorld(e);
    this._hover = [wx, wy];
    const d = this._drag;
    if (!d) {
      if (BRUSH_TOOLS.includes(this.tool)) this.render();
      else if (this.tool === "crop") {
        const [sx, sy] = this._evScreen(e);
        const h = this._cropHandle(sx, sy);
        this.viewEl.style.cursor = !h ? "default" : h === "move" ? "move" : ({ n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" }[h]);
      }
      return;
    }
    if (d.kind === "pan") { this.view.tx = d.tx + e.clientX - d.sx; this.view.ty = d.ty + e.clientY - d.sy; this._userView = true; }
    else if (d.kind === "stroke") this._strokeTo(wx, wy);
    else if (d.kind === "rect") { d.x1 = wx; d.y1 = wy; }
    else if (d.kind === "lasso") { const l = d.pts[d.pts.length - 1]; if (Math.hypot(wx - l[0], wy - l[1]) * this.view.s > 3) d.pts.push([wx, wy]); }
    else if (d.kind === "crop") this._cropMove(d, wx, wy);
    else if (d.kind === "split") { const pr = this._previewRect(); if (pr) this.fill.split = clamp((wx - pr.x) / pr.w, 0, 1); }
    else if (d.kind === "transform") this._transformMove(wx, wy, e);
    this.render();
  }

  _up(e) {
    const d = this._drag;
    this._drag = null;
    try { this.viewEl.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if (d.kind === "pan") { this._cursor(); return; }
    if (d.kind === "stroke") this._strokeEnd();
    else if (d.kind === "rect") {
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w * this.view.s < 3 || h * this.view.s < 3) { if (d.mode === "replace") this.deselect(); }
      else this._applySelection((c) => c.fillRect(x + this.M, y + this.M, w, h), d.mode, "Marquee select");
    } else if (d.kind === "lasso") {
      if (d.pts.length > 2) this._applySelection((c) => { c.beginPath(); d.pts.forEach(([x, y], i) => (i ? c.lineTo(x + this.M, y + this.M) : c.moveTo(x + this.M, y + this.M))); c.closePath(); c.fill(); }, d.mode, "Lasso select");
    } else if (d.kind === "crop") {
      if (d.live && JSON.stringify(d.live) !== JSON.stringify(this.rect)) {
        this._record(d.h === "move" ? "Move canvas" : "Extend canvas", () => { this.rect = d.live; });
        if (this._hasHole()) this.onStatus("Empty canvas around the picture: press Extend to paint it");
      }
    } else if (d.kind === "transform") this._transformEnd(d);
    this.render();
  }

  // ---- brush
  _strokeTarget() {
    if (this.tool === "mask") return this.maskLayer;
    if (this.tool === "eraser") return this.eraseTarget === "mask" ? this.maskLayer : (this.active?.kind === "mask" ? null : this.active);
    return this.active?.kind === "mask" ? null : this.active;
  }

  _strokeStart(wx, wy) {
    let target = this._strokeTarget();
    if (!target && this.tool === "paint") { this.addLayer("paint"); target = this.active; }
    if (!target) { this.onStatus("Pick a layer first"); return; }
    if (target.locked) { this.onStatus(`${target.name} is locked: unlock it, or paint on a new layer`); return; }
    this._stroke = { target, canvas: newCanvas(this.EW, this.EH), last: null, bbox: null, erase: this.tool === "eraser" };
    if (target.kind === "mask" && !target.visible) target.visible = true;
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
    if (this.selection && s.target.kind !== "mask") { const c = s.canvas.getContext("2d"); c.globalCompositeOperation = "destination-in"; c.drawImage(this.selection, 0, 0); }
    const label = s.erase ? (s.target.kind === "mask" ? "Erase mask" : "Erase") : s.target.kind === "mask" ? "Mask stroke" : "Paint stroke";
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
    this.setTool("paint");
  }

  // ---- move / transform
  _boxHandle(wx, wy, b) {
    const tol = 10 / this.view.s;
    const corners = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
    for (const [k, [x, y]] of Object.entries(corners)) if (Math.abs(wx - x) < tol && Math.abs(wy - y) < tol) return k;
    if (wx > b.x && wx < b.x + b.w && wy > b.y && wy < b.y + b.h) return "move";
    return null;
  }

  _transformStart(wx, wy) {
    let a = this.active;
    if (!a || a.kind === "mask") { this.onStatus("Pick a layer to move"); return; }
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
    this._record("Move", () => { layer.canvas = next; });
    this._markDirty(layer);
  }

  // ======================================================================= render
  render() {
    if (this._raf) return;
    const run = () => { if (!this._raf) return; cancelAnimationFrame(this._raf); clearTimeout(this._rafTO); this._raf = null; this._draw(); };
    this._raf = requestAnimationFrame(run);
    this._rafTO = setTimeout(run, 150);   // rAF never fires in a hidden / background tab
  }

  _previewRect() {
    const r = this.fill.results[this.fill.pick];
    return r?.canvas ? r.rect : null;
  }

  _draw() {
    const c = this.cv, ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr * this.view.s, 0, 0, dpr * this.view.s, dpr * this.view.tx, dpr * this.view.ty);
    const s = this.view.s;
    const d = this._drag;
    const R = d?.kind === "crop" && d.live ? d.live : this.rect;
    ctx.fillStyle = "#1a1420"; ctx.fillRect(-this.M, -this.M, this.EW, this.EH);
    if (!this._checker) {
      const p = newCanvas(16, 16), pc = p.getContext("2d");
      pc.fillStyle = "#2b2431"; pc.fillRect(0, 0, 16, 16); pc.fillStyle = "#231d29"; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
      this._checker = ctx.createPattern(p, "repeat");
    }
    ctx.fillStyle = this._checker; ctx.fillRect(R.x, R.y, R.w, R.h);
    ctx.imageSmoothingEnabled = s < 2;
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
        if (this._stroke.erase) { ctx.save(); ctx.globalCompositeOperation = "destination-out"; ctx.drawImage(this._stroke.canvas, -this.M, -this.M); ctx.restore(); }
        else ctx.drawImage(this._stroke.canvas, -this.M, -this.M);
      }
    }
    ctx.globalAlpha = 1;
    // The previewed variation, with the before / after split.
    const pr = this._previewRect();
    if (pr) {
      const res = this.fill.results[this.fill.pick];
      ctx.save();
      if (this.fill.compare) { const sx = pr.x + pr.w * this.fill.split; ctx.beginPath(); ctx.rect(sx, pr.y, pr.x + pr.w - sx, pr.h); ctx.clip(); }
      ctx.drawImage(res.canvas, pr.x, pr.y, pr.w, pr.h);
      ctx.restore();
    }
    // Everything outside the document frame is dimmed.
    ctx.fillStyle = "rgba(10,7,13,.62)";
    ctx.beginPath(); ctx.rect(-this.M, -this.M, this.EW, this.EH); ctx.rect(R.x, R.y, R.w, R.h); ctx.fill("evenodd");
    // masks: red overlay
    for (const l of this.layers) {
      if (!l.visible || l.kind !== "mask") continue;
      ctx.globalAlpha = pr ? 0.18 : 0.45;
      ctx.drawImage(this._tinted(l.canvas, "#ff4d6d"), -this.M, -this.M);
      if (this._stroke?.target === l && !this._stroke.erase) ctx.drawImage(this._tinted(this._stroke.canvas, "#ff4d6d"), -this.M, -this.M);
    }
    ctx.globalAlpha = 1;
    // selection
    if (this.selection) {
      if (!pr) { ctx.globalAlpha = 0.2; ctx.drawImage(this._tinted(this.selection, "#f2ff59"), -this.M, -this.M); ctx.globalAlpha = 1; }
      if (this._selBoundsFor !== this.selection) { this._selBoundsFor = this.selection; this._selBounds = alphaBounds(this.selection); }
      const bb = this._selBounds;
      if (bb) {
        ctx.lineWidth = 1 / s;
        ctx.setLineDash([6 / s, 4 / s]); ctx.strokeStyle = "#000"; ctx.strokeRect(bb.x - this.M, bb.y - this.M, bb.w, bb.h);
        ctx.lineDashOffset = 5 / s; ctx.strokeStyle = "#f2ff59"; ctx.strokeRect(bb.x - this.M, bb.y - this.M, bb.w, bb.h);
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
    }
    // the original picture's edge (faint) and the document frame
    if (R.x !== 0 || R.y !== 0 || R.w !== this.W || R.h !== this.H) {
      ctx.setLineDash([4 / s, 4 / s]); ctx.lineWidth = 1 / s; ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.strokeRect(0, 0, this.W, this.H); ctx.setLineDash([]);
    }
    const cropping = this.tool === "crop";
    ctx.lineWidth = (cropping ? 2 : 1.5) / s; ctx.strokeStyle = cropping ? "#f2ff59" : "rgba(255,255,255,.6)"; ctx.strokeRect(R.x, R.y, R.w, R.h);
    if (cropping) {
      ctx.fillStyle = "#f2ff59";
      const hw = 14 / s, ht = 4 / s;
      const mx = R.x + R.w / 2, my = R.y + R.h / 2;
      for (const [x, y, w, h] of [[mx - hw / 2, R.y - ht / 2, hw, ht], [mx - hw / 2, R.y + R.h - ht / 2, hw, ht], [R.x - ht / 2, my - hw / 2, ht, hw], [R.x + R.w - ht / 2, my - hw / 2, ht, hw]]) ctx.fillRect(x, y, w, h);
      for (const [x, y] of [[R.x, R.y], [R.x + R.w, R.y], [R.x, R.y + R.h], [R.x + R.w, R.y + R.h]]) ctx.fillRect(x - 5 / s, y - 5 / s, 10 / s, 10 / s);
      // rule of thirds while dragging
      if (d?.kind === "crop") {
        ctx.strokeStyle = "rgba(255,255,255,.3)"; ctx.lineWidth = 1 / s; ctx.beginPath();
        for (const t of [1 / 3, 2 / 3]) { ctx.moveTo(R.x + R.w * t, R.y); ctx.lineTo(R.x + R.w * t, R.y + R.h); ctx.moveTo(R.x, R.y + R.h * t); ctx.lineTo(R.x + R.w, R.y + R.h * t); }
        ctx.stroke();
      }
    }
    // before / after line
    if (pr && this.fill.compare) {
      const sx = pr.x + pr.w * this.fill.split;
      ctx.strokeStyle = "#f2ff59"; ctx.lineWidth = 2 / s; ctx.beginPath(); ctx.moveTo(sx, pr.y); ctx.lineTo(sx, pr.y + pr.h); ctx.stroke();
      ctx.beginPath(); ctx.arc(sx, pr.y + pr.h / 2, 11 / s, 0, Math.PI * 2); ctx.fillStyle = "#f2ff59"; ctx.fill();
      ctx.fillStyle = "#211927"; ctx.font = `700 ${11 / s}px "Soundstage Grotesk", system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("⇆", sx, pr.y + pr.h / 2 + 0.5 / s);
      ctx.textBaseline = "top"; ctx.font = `600 ${11 / s}px "Soundstage Grotesk", system-ui, sans-serif`;
      const tag = (t, x, align) => { ctx.textAlign = align; const w = ctx.measureText(t).width + 12 / s; const bx = align === "right" ? x - w : x;
        ctx.fillStyle = "rgba(33,25,39,.85)"; ctx.fillRect(bx, pr.y + 8 / s, w, 18 / s); ctx.fillStyle = "#f0efed"; ctx.fillText(t, align === "right" ? x - 6 / s : x + 6 / s, pr.y + 11 / s); };
      tag("Before", sx - 8 / s, "right"); tag("After", sx + 8 / s, "left");
    }
    // in-progress shapes
    if (d?.kind === "rect") { ctx.setLineDash([5 / s, 4 / s]); ctx.lineWidth = 1.2 / s; ctx.strokeStyle = "#fff"; ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); ctx.setLineDash([]); }
    if (d?.kind === "lasso") { ctx.lineWidth = 1.2 / s; ctx.strokeStyle = "#fff"; ctx.beginPath(); d.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    if (d?.kind === "transform") { ctx.lineWidth = 1.2 / s; ctx.strokeStyle = "#f2ff59"; ctx.strokeRect(d.live.x, d.live.y, d.live.w, d.live.h); }
    for (const p of this.tool === "magic" && !pr ? this.magic.points : []) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 6 / s, 0, Math.PI * 2);
      ctx.fillStyle = p.label ? "#3ddc97" : "#ff4d6d"; ctx.fill(); ctx.lineWidth = 2 / s; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
    // brush cursor
    if (this._hover && BRUSH_TOOLS.includes(this.tool) && !this._spacePan) {
      const [hx, hy] = this._hover, r = this.brush.size / 2;
      ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.lineWidth = 2.5 / s; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.stroke();
      ctx.lineWidth = 1.2 / s; ctx.strokeStyle = this.tool === "mask" ? "#ff8aa0" : "#fff"; ctx.stroke();
      if (this.brush.hardness < 0.95) { ctx.setLineDash([3 / s, 3 / s]); ctx.beginPath(); ctx.arc(hx, hy, r * Math.max(0.05, this.brush.hardness), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    }
    const a = this.active;
    this.hud.replaceChildren(...[el("span", { class: "ss-cv-chip" }, `${Math.round(s * 100)}%`),
      el("span", { class: "ss-cv-chip" }, `${R.w}×${R.h}`), a ? el("span", { class: "ss-cv-chip" }, a.name) : null,
      pr ? el("span", { class: "ss-cv-chip hot" }, `Variation ${this.fill.pick + 1} of ${this.fill.results.length}: Keep it, or pick another`) : null].filter(Boolean));
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
    const info = async (node) => { try { const r = await this.api.fetchApi(`/object_info/${node}`); return r.ok ? (await r.json())[node] || null : null; } catch { return null; } };
    const [fillInfo, samInfo, ckInfo] = await Promise.all([info("SoundstageFill"), info("SAM3_Detect"), info("CheckpointLoaderSimple")]);
    const names = ckInfo?.input?.required?.ckpt_name?.[0] || [];
    const sam = (Array.isArray(names) ? names : []).find((n) => /sam3/i.test(n));
    this.sam = { local: !!samInfo && !!sam, ckpt: sam, reason: !samInfo ? "This ComfyUI has no SAM3_Detect node: magic select is off" : !sam ? "No SAM 3 checkpoint in models/checkpoints: magic select is off" : "" };
    const spec = fillInfo?.input?.required?.model;
    const opts = spec?.[1]?.options || [];
    this.models = opts.map((o) => {
      const nested = {};
      for (const sec of ["required", "optional"]) for (const [k, v] of Object.entries(o.inputs?.[sec] || {})) {
        const d = v?.[1]?.default ?? (Array.isArray(v?.[0]) ? v[0][0] : v?.[1]?.options?.[0]);
        if (d !== undefined) nested[`model.${k}`] = d;
      }
      return { key: o.key, label: o.key.replace(" · local", " (local)").replace(/ \[[^\]]*\]$/, ""), nested };
    });
    this.fillReady = !!fillInfo;
    const klein = this.models.find((m) => /^FLUX 3 Klein/.test(m.key));
    if (!this.models.some((m) => m.key === this.fill.model)) this.fill.model = (klein || this.models[0])?.key || "";
    this.modelSel.replaceChildren(...this.models.map((m) => el("option", { value: m.key }, m === klein ? `${m.label} · recommended` : m.label)));
    this.modelSel.value = this.fill.model;
    this.fillWarn.textContent = !fillInfo ? "Generative Fill needs the updated Soundstage nodes on this ComfyUI (restart it once)."
      : !this.models.length ? "No image edit model is installed (FLUX 3 Klein or Krea 2): Generative Fill is off." : "";
    this._renderOptions();
    this._renderRefs();
    this._renderFillState();
  }

  // ======================================================================= references (the ② Frame cast sheets)
  _castRefs() {
    const node = this.app?.graph?.getNodeById?.(9081);
    const refs = node?.properties?.ss_refs || {};
    let actors = [];
    try { actors = this.stage?.toJSON?.().actors || []; } catch { /* stage not ready */ }
    const label = (k) => k.startsWith("actor:") ? (actors.find((a) => `actor:${a.id}` === k)?.name || "Cast") : k === "location" ? "Location" : k === "style" ? "Style" : k;
    const out = Object.entries(refs).filter(([, f]) => f).map(([k, f]) => ({ key: k, file: f, label: label(k) }));
    return out.concat(this.fill.extraRefs);
  }

  _renderRefs() {
    const refs = this._castRefs();
    const f = this.fill;
    for (const k of [...f.refs]) if (!refs.some((r) => r.key === k)) f.refs.delete(k);
    const pick = el("input", { type: "file", accept: "image/*", hidden: "", onchange: async () => {
      const fl = pick.files?.[0]; pick.value = "";
      if (!fl) return;
      try {
        const name = await this._upload(fl, fl.name.replace(/[^\w.-]+/g, "_"), "soundstage_refs");
        const key = `extra:${name}`;
        f.extraRefs.push({ key, file: name, label: fl.name.replace(/\.[^.]+$/, "") });
        f.refs.add(key);
        this._renderRefs(); this._renderFillState();
      } catch (e) { this.onStatus(`Couldn't add that reference: ${e.message}`); }
    } });
    const tiles = refs.map((r) => el("button", { type: "button", class: "ref", "aria-pressed": String(f.refs.has(r.key)),
      title: `${r.label}: ${f.refs.has(r.key) ? "used" : "click to use"} as a reference (Generative Fill puts this subject in the area)`,
      onclick: () => { if (f.refs.has(r.key)) f.refs.delete(r.key); else f.refs.add(r.key); this._renderRefs(); this._renderFillState(); } },
      el("img", { src: this._viewURL(r.file, "input"), alt: r.label })));
    this.refsEl.replaceChildren(
      el("span", { class: "ttl" }, refs.length ? "Reference (put this subject in the area):" : "Reference: add a character sheet or photo to put that subject in the area"),
      ...tiles,
      el("button", { class: "ss-cv-ib", type: "button", title: "Add a reference image", "aria-label": "Add a reference image", onclick: () => pick.click() }, icon("plus", 15)),
      pick);
  }

  // ======================================================================= Generative Fill
  _hasArea() {
    const src = this.selection || this.maskLayer?.canvas;
    if (!src) return false;
    this._areaCache ||= {};
    if (this._areaCache.ver === this._ver && this._areaCache.src === src) return this._areaCache.v;
    const r = this.rect, iw = 128, ih = Math.max(8, Math.round((128 * r.h) / r.w));
    const t = newCanvas(iw, ih);
    t.getContext("2d").drawImage(src, r.x + this.M, r.y + this.M, r.w, r.h, 0, 0, iw, ih);
    const d = ctx2d(t).getImageData(0, 0, iw, ih).data;
    let v = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) { v = true; break; }
    this._areaCache = { ver: this._ver, src, v };
    return v;
  }

  /** True when the document frame has empty (transparent) canvas: what Extend paints. */
  _hasHole() {
    this._holeCache ||= {};
    if (this._holeCache.ver === this._ver) return this._holeCache.v;
    const r = this.rect, iw = 128, ih = Math.max(8, Math.round((128 * r.h) / r.w));
    const d = ctx2d(this.composite(r, iw, ih)).getImageData(0, 0, iw, ih).data;
    let holes = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] <= 8) holes++;
    const v = holes > iw * ih * 0.002;
    this._holeCache = { ver: this._ver, v };
    return v;
  }

  _renderFillState() {
    if (!this.fillBtn) return;
    const area = this._hasArea(), hole = this._hasHole(), busy = this.fill.busy, ok = this.fillReady && this.models.length;
    const refN = this.fill.refs.size;
    this.fillBtn.querySelector("span").textContent = busy ? "Painting…" : refN ? "Fill with reference" : "Generative Fill";
    this.fillBtn.disabled = busy || !ok;
    this.removeBtn.disabled = busy || !ok;
    this.extendBtn.disabled = busy || !ok;
    this.extendBtn.classList.toggle("ready", hole && !busy);
    this.areaNote.textContent = busy ? "Painting your variations…"
      : area ? `${this.selection ? "Selection" : "Mask"} ready: describe it and Fill, or Remove what is there.${hole ? " Empty canvas too: Extend paints it." : ""}`
      : hole ? "Empty canvas around the picture: Extend paints it (describe it, or leave the prompt empty)."
      : "Paint a mask (B), select (M, L) or click an object (W), then Fill or Remove. Drag the edge out (C) to Extend.";
  }

  /** Fill / Remove / Extend: upload the frame and the area, queue SoundstageFill once per variation, show them. */
  async generativeFill(mode = "fill") {
    const f = this.fill;
    if (f.busy) return;
    if (!this.fillReady || !this.models.length) { this.onStatus(this.fillWarn.textContent || "Generative Fill isn't available yet"); return; }
    const R = { ...this.rect };
    const comp = this.composite(R, R.w, R.h);
    // The area, white on black, in frame pixels.
    const area = this._areaCrop(R);
    const hasArea = this._hasArea();
    if (mode === "extend") {
      if (!this._hasHole()) {
        this.onStatus("Nothing to extend: drag the canvas edges out with Crop / Extend (C), or pick 2.39 / 16:9 / 9:16 in its top bar");
        this.setTool("crop");
        return;
      }
    } else if (!hasArea) {
      this.onStatus("Paint a mask (B), or select an area (M, L, or W to click an object), then Generative Fill");
      this.setTool("mask");
      return;
    }
    if (mode === "fill" && !f.refs.size && !f.prompt.trim()) { this.onStatus("Describe what to put there (or use Remove to clear it)"); this.promptIn.focus(); return; }
    const W = R.w, H = R.h;
    const maskC = newCanvas(W, H), mc = maskC.getContext("2d");
    mc.fillStyle = "#000"; mc.fillRect(0, 0, W, H);
    if (mode !== "extend" || hasArea) mc.drawImage(area, 0, 0);
    // Adding something (Fill / a reference): the model only paints inside the area, so a quick stroke would clip the
    // object (a car with no roof). Fill the stroke's whole box instead, wider and with headroom above: objects stand
    // on what you painted. Remove keeps the exact area.
    if ((mode === "fill" || useRefEarly(f, mode)) && f.tune.fit !== false) {
      const md = mc.getImageData(0, 0, W, H).data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (md[(y * W + x) * 4] > 127) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 >= 0) {
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1, size = Math.max(bw, bh);
        const gx = Math.round(Math.max(bw * 0.15, size * 0.08)), up = Math.round(Math.max(bh * 0.9, size * 0.35)), down = Math.round(bh * 0.15);
        const fx = Math.max(0, x0 - gx), fy = Math.max(0, y0 - up), fw = Math.min(W, x1 + gx) - fx, fh = Math.min(H, y1 + down) - fy;
        mc.fillStyle = "#fff";
        mc.beginPath(); mc.roundRect ? mc.roundRect(fx, fy, fw, fh, Math.min(fw, fh) * 0.12) : mc.rect(fx, fy, fw, fh); mc.fill();
      }
    }
    if (mode === "extend") {   // the transparent canvas is the hole; mark it white too
      const cd = ctx2d(comp).getImageData(0, 0, W, H), md = mc.getImageData(0, 0, W, H);
      for (let i = 0; i < cd.data.length; i += 4) if (cd.data[i + 3] <= 8) md.data[i] = md.data[i + 1] = md.data[i + 2] = 255;
      mc.putImageData(md, 0, 0);
    }
    const flat = newCanvas(W, H), fc = flat.getContext("2d");
    fc.fillStyle = "#7f7f7f"; fc.fillRect(0, 0, W, H); fc.drawImage(comp, 0, 0);
    const useRef = f.refs.size > 0 && mode === "fill";
    const nodeMode = useRef ? "replace" : mode;
    const refs = this._castRefs().filter((r) => f.refs.has(r.key));
    const model = this.models.find((m) => m.key === f.model) || this.models[0];
    const seed0 = this.seedIn.value !== "" ? Math.max(0, Math.floor(+this.seedIn.value)) : Math.floor(Math.random() * 2 ** 31);
    const n = f.count;
    f.busy = true; f.lastMode = nodeMode;
    this._clearResults();
    f.base = this.composite(R, 264, Math.max(1, Math.round((264 * R.h) / R.w)), { background: "#120d16" });
    f.results = Array.from({ length: n }, (_, i) => ({ seed: seed0 + i * 7919, rect: R, canvas: null, pending: true }));
    this._renderFilm();
    this._renderFillState();
    const verb = { fill: "Filling", remove: "Removing", extend: "Extending", replace: "Placing the reference" }[nodeMode];
    this._progress(true, 0.02, `${verb} · uploading…`);
    try {
      const tag = `${this.docId}_${uid()}`;
      const [imgName, maskName] = await Promise.all([this._upload(await toBlob(flat), `_fill_${tag}.png`, "soundstage/canvas/fill"),
        this._upload(await toBlob(maskC), `_fill_${tag}_mask.png`, "soundstage/canvas/fill")]);
      const t = f.tune;
      // Extend with no prompt: describe the place with the frame's own description (Frame step / Look tab).
      let promptText = f.prompt.trim();
      if (!promptText && mode === "extend") {
        const pipe = (this.app?.graph?._nodes || []).find((x) => x?.ssPipeline)?.ssPipeline;
        promptText = String(pipe?.ctx?.look?.state?.description || "").trim();
      }
      const pids = [];
      for (const r of f.results) {
        const fill = { image: ["1", 0], mask: ["3", 0], prompt: promptText, mode: nodeMode, negative: "",
          model: model.key, ...model.nested, seed: r.seed, lora: "None", lora_strength: 1.0, steps: Math.max(0, t.steps | 0), cfg: 0,
          ref_files: refs.map((x) => `${x.file} | ${x.label}`).join("\n"),
          grow: Math.max(0, t.grow | 0), feather: Math.max(0, t.feather | 0), context: 0.6, megapixels: clamp(+t.megapixels || 1, 0.25, 4),
          overlap: 48, denoise: 1.0, color_match: true };
        const prompt = {
          1: { class_type: "LoadImage", inputs: { image: imgName } },
          2: { class_type: "LoadImage", inputs: { image: maskName } },
          3: { class_type: "ImageToMask", inputs: { image: ["2", 0], channel: "red" } },
          4: { class_type: "SoundstageFill", inputs: fill },
          5: { class_type: "PreviewImage", inputs: { images: ["4", 1] } },
        };
        pids.push(await this._queue(prompt));
      }
      let done = 0;
      this._progress(true, 0.05, `${verb} · ${n} variation${n > 1 ? "s" : ""} queued…`);
      await Promise.all(pids.map(async (pid, i) => {
        const res = f.results[i];
        try {
          const img = await this._wait(pid, "5", `${verb} · variation ${i + 1}/${n}`);
          const c = newCanvas(R.w, R.h);
          c.getContext("2d").drawImage(img, 0, 0, R.w, R.h);
          Object.assign(res, { canvas: c, url: img.src, pending: false });
          if (f.pick < 0) { f.pick = i; f.split = 0.5; }
        } catch (e) { Object.assign(res, { pending: false, error: e.message }); }
        done++;
        this._progress(true, 0.1 + (0.9 * done) / n, `${verb} · ${done}/${n} ready`);
        this._renderFilm(); this.render();
      }));
      const good = f.results.filter((r) => r.canvas).length;
      if (!good) throw new Error(f.results.find((r) => r.error)?.error || "no result");
      this.onStatus(`${good} variation${good > 1 ? "s" : ""} ready: drag the before / after line, pick one, Keep it`);
      this._progress(true, 1, "Done: pick a variation and Keep it");
    } catch (e) {
      this.onStatus(`Generative Fill failed: ${e.message}`);
      this._progress(true, 1, `Failed: ${e.message}`);
      if (!f.results.some((r) => r.canvas)) this._clearResults();
    } finally {
      f.busy = false;
      this._renderFillState();
      this._renderFilm();
      setTimeout(() => { if (!f.busy) this._progress(false); }, 2500);
    }
  }

  _clearResults() {
    const f = this.fill;
    f.results = []; f.pick = -1;
    if (this.filmEl) this.filmEl.hidden = true;
  }

  _renderFilm() {
    const f = this.fill;
    this.filmEl.hidden = !f.results.length;
    this.strip.replaceChildren(...f.results.map((r, i) => {
      if (r.pending) return el("div", { class: "wait" }, `variation ${i + 1}…`);
      if (!r.canvas) return el("div", { class: "wait", title: r.error || "" }, "failed");
      const th = newCanvas(264, Math.max(1, Math.round((264 * r.rect.h) / r.rect.w)));
      if (f.base) th.getContext("2d").drawImage(f.base, 0, 0, th.width, th.height);   // the fill over the picture
      th.getContext("2d").drawImage(r.canvas, 0, 0, th.width, th.height);
      return el("button", { type: "button", role: "option", "aria-pressed": String(i === f.pick), title: `seed ${r.seed}`,
        onclick: () => { f.pick = i; this._renderFilm(); this.render(); }, ondblclick: () => { f.pick = i; this.applyResult(); } },
        el("img", { src: th.toDataURL("image/jpeg", 0.8), alt: `Variation ${i + 1}` }), el("span", {}, `${i + 1} · seed ${r.seed}`));
    }));
    this.applyBtn.disabled = !f.results[f.pick]?.canvas;
  }

  /** Keep the previewed variation: a new layer with only the generated pixels; the mask and selection are cleared. */
  applyResult() {
    const f = this.fill;
    const r = f.results[f.pick];
    if (!r?.canvas) return;
    const layerCanvas = newCanvas(this.EW, this.EH);
    layerCanvas.getContext("2d").drawImage(r.canvas, r.rect.x + this.M, r.rect.y + this.M);
    const word = { fill: "Fill", remove: "Remove", extend: "Extend", replace: "Reference" }[f.lastMode] || "Fill";
    const l = this._makeLayer("gen", `${word} · ${(f.lastMode === "remove" ? "" : f.prompt).slice(0, 22) || `seed ${r.seed}`}`);
    l.canvas = layerCanvas;
    const m = this.maskLayer;
    this._record(`Generative ${word}`, () => {
      this._insertLayer(l);
      if (m) m.canvas.getContext("2d").clearRect(0, 0, this.EW, this.EH);
      this.selection = null;
    }, m ? [[m, null]] : []);
    this._markDirty(l);
    this._clearResults();
    this.onStatus(`Kept as layer “${l.name}”. Use as first frame when the picture is right.`);
    this.render();
  }

  _progress(on, p = 0, text = "") {
    this.prog.dataset.on = String(on);
    this.prog.querySelector("span").textContent = text;
    this.prog.querySelector("b").style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
  }

  // ---- magic select
  async runMagic() {
    const pts = this.magic.points;
    if (!pts.length || this.magic.busy) { if (this.magic.busy) this._magicAgain = true; return; }
    if (!pts.some((p) => p.label)) return;
    // Segment the visible composite over the document frame.
    const rect = { ...this.rect };
    const img = this.composite(rect, rect.w, rect.h, { background: "#000" });
    const local = pts.map((p) => ({ x: Math.round(p.x - rect.x), y: Math.round(p.y - rect.y), label: p.label }))
      .filter((p) => p.x >= 0 && p.y >= 0 && p.x < rect.w && p.y < rect.h);
    if (!local.length) { this.onStatus("Click on the picture"); return; }
    this.magic.busy = true; this._renderOptions();
    this._progress(true, 0.2, "Magic select · SAM 3.1…");
    try {
      const maskImg = await this._samLocal(img, local);
      const sel = this._newSel();
      const tmp = newCanvas(rect.w, rect.h), tc = ctx2d(tmp);
      tc.drawImage(maskImg, 0, 0, rect.w, rect.h);
      const d = tc.getImageData(0, 0, rect.w, rect.h);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.max(d.data[i], d.data[i + 1], d.data[i + 2]);
        d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; d.data[i + 3] = v > 127 ? 255 : 0;
      }
      tc.putImageData(d, 0, 0);
      sel.getContext("2d").drawImage(tmp, rect.x + this.M, rect.y + this.M);
      if (!alphaBounds(sel)) throw new Error("SAM found nothing at those points");
      this._record("Magic select", () => { this.selection = sel; });
      this.onStatus("Selected. Describe a change and Fill, Remove it, or Shift-click to leave a part out");
      this._progress(true, 1, "Selection ready");
    } catch (e) {
      this.onStatus(`Magic select failed: ${e.message}`);
      this._progress(true, 1, `Failed: ${e.message}`);
    } finally {
      this.magic.busy = false; this._renderOptions();
      setTimeout(() => { if (!this.fill.busy && !this.magic.busy) this._progress(false); }, 1600);
      if (this._magicAgain) { this._magicAgain = false; this.runMagic(); }
    }
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
    return await this._wait(await this._queue(prompt), "5", "Magic select · SAM 3.1");
  }

  /** Queue an API-format graph at the front of ComfyUI's queue; returns the prompt id. Everything heavy goes
   *  through the queue, so it never shares the GPU with another running prompt. */
  async _queue(prompt) {
    const res = await this.api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, front: true, client_id: this.api.clientId }) });
    const q = await res.json();
    if (!res.ok || q.error) {
      const ne = Object.values(q.node_errors || {})[0];
      throw new Error(ne ? `${ne.class_type}: ${ne.errors?.[0]?.message || ""} ${ne.errors?.[0]?.details || ""}` : q.error?.message || `HTTP ${res.status}`);
    }
    return q.prompt_id;
  }

  /** Wait for a queued prompt and return the first image of node `outId` as an <img>. */
  async _wait(pid, outId, label) {
    const onProg = (e) => { const d = e.detail || {}; if (d.prompt_id === pid && d.max) this._progress(true, 0.1 + 0.85 * (d.value / d.max), `${label} · step ${d.value}/${d.max}`); };
    this.api.addEventListener?.("progress", onProg);
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 900000) {
        await new Promise((r) => setTimeout(r, 800));
        const h = await (await this.api.fetchApi(`/history/${pid}`)).json();
        const e = h[pid];
        if (!e) continue;
        if (e.status?.status_str === "error") {
          const msg = (e.status.messages || []).find((m) => m[0] === "execution_error")?.[1];
          throw new Error(msg ? `${msg.node_type}: ${msg.exception_message}`.slice(0, 240) : `${label} failed (see the ComfyUI console)`);
        }
        const out = e.outputs?.[outId]?.images?.[0];
        if (!out) { if (e.status?.completed === false) continue; throw new Error(`${label} returned no image`); }
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

  /** Save the document frame to input/soundstage/, make it the touched-up still and the shot's chosen first frame. */
  async useAsFirstFrame() {
    const f = this.fill;
    if (f.results[f.pick]?.canvas) this.applyResult();   // what you see on the canvas is what becomes the frame
    const rect = { ...this.rect };
    if (this._hasHole()) this.onStatus("Part of the canvas is still empty (black in the frame): Extend paints it");
    const c = this.composite(rect, rect.w, rect.h, { background: "#000" });
    this.useBtn.disabled = true;
    try {
      const url = c.toDataURL("image/png");
      const name = await this._upload(await toBlob(c), `look_still_${this.docId}_${hashBytes(url.slice(-4096) + url.length)}.png`, "soundstage");
      const nodes = this.app ? findTouchupNodes(this.app) : {};
      const wired = Boolean(nodes.still && nodes.toggle && setTouchupStill(this.app, name) && setTouchupEnabled(this.app, true));
      const info = { name, url: this._viewURL(name, "input", Date.now()), w: rect.w, h: rect.h };
      this.onLookStill?.(name);
      this.onUseFrame?.(info);
      const pipe = (this.app?.graph?._nodes || []).find((n) => n?.ssPipeline)?.ssPipeline;
      const sid = pipe?.useEditedFrame?.(info);
      this.onStatus(wired ? `This is now ${sid ? "the shot's" : "the"} first frame (${rect.w}×${rect.h}): Motion animates it.`
        : nodes.still && !nodes.still.widgets?.some((w) => w.name === "image")
          ? `Saved ${name} in input/, but this server hasn't loaded SoundstageCanvasImage (restart ComfyUI once).`
          : `Saved ${name} in input/. This workflow has no "Use touched-up still" step to wire it to (rebuild the App).`);
    } catch (e) { this.onStatus(`Could not save the frame: ${e.message}`); }
    finally { this.useBtn.disabled = false; }
  }

  /** Kept for callers of the old Canvas tab. */
  useAsLookStill() { return this.useAsFirstFrame(); }
}

export default CanvasPanel;
