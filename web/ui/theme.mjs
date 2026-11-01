// Soundstage theme: the look of Comfy's hub apps (Cinematic Studio, Reshoot, Openjutsu).
// Deep violet-black ground, faint glass cards with hairline borders, pill controls, one electric-yellow
// accent, small uppercase section labels and Lucide line icons. Comfy's apps use PP Formula, which is
// licensed; Space Grotesk (SIL OFL) is the closest open geometric grotesk. Loaded after every panel's
// own CSS, so it restyles the stage, Look, Advisor, Ladder and Cut panels in one place.

const FONT_URL = new URL("../vendor/fonts/", import.meta.url).href;

export const TOKENS = {
  bg: "#211927",
  card: "rgba(255,255,255,0.04)",
  cardHover: "rgba(255,255,255,0.07)",
  raised: "#2a2330",
  hover: "#342c3b",
  pressed: "#3d3445",
  selected: "rgba(255,255,255,0.15)",
  line: "rgba(255,255,255,0.08)",
  lineStrong: "rgba(255,255,255,0.16)",
  text: "#f0efed",
  // Milestone 14: secondary and hint text were 56 % and 36 % white (the hints failed WCAG at 3:1). Now 4.5:1 or better.
  muted: "rgba(240,239,237,0.68)",
  faint: "rgba(240,239,237,0.54)",
  accent: "#f2ff59",
  accentHover: "#f6ff8a",
  accentInk: "#211927",
  accentSoft: "rgba(242,255,89,0.10)",
  accentLine: "rgba(242,255,89,0.42)",
  glass: "rgba(26,20,31,0.86)",
  glassStrong: "rgba(26,20,31,0.94)",
  danger: "#ff7a7a",
  success: "#7ee2a8",
};

/** One type scale (px): caption · secondary · body and controls · section title · step title. Nothing smaller than xs. */
export const TYPE = { xs: 11, sm: 12, md: 13, lg: 15, xl: 18 };
/** One spacing scale (px), a 4-px grid. */
export const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24 };
/** Radii: chips · fields · cards and panels · overlays; buttons and segmented controls stay pills (the hub-app look). */
export const RADIUS = { sm: 6, md: 10, lg: 14, xl: 18, pill: 999 };

const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
/** An rgb triple for "#rrggbb" or "rgba(r,g,b,a)" laid over a solid background (bg, "#rrggbb"). */
export function flatten(c, bg = TOKENS.bg) {
  const h = hex(c);
  if (h) return h;
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) throw new Error(`not a colour: ${c}`);
  const [r, g, b, a = 1] = m[1].split(",").map(Number);
  const base = flatten(bg);
  return [r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)));
}
/** WCAG contrast ratio of a text colour on a background (both flattened onto `under`). */
export function contrast(fg, bg = TOKENS.bg, under = TOKENS.bg) {
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const B = flatten(bg, under), F = flatten(fg, `#${B.map((v) => v.toString(16).padStart(2, "0")).join("")}`);
  const [a, b] = [lum(F), lum(B)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** The one UI typeface (canvas text too): Space Grotesk, then the platform UI font while it loads. */
export const FONT = `"Soundstage Grotesk", "PP Formula", ui-sans-serif, system-ui, sans-serif`;
// Kept in their own face: timecodes (an NLE convention) and the screenplay page (Courier, like every script).
const OWN_FONT = ".ss-mono, .ss-cut-tc, .ss-cut-ro, .ss-strip-tc, .ss-strip-dur, .ss-pip-bar output, .ss-prev textarea, .ss-script .page, .ss-script .page *, .ss-wordmark";

const T = TOKENS;
const CSS = `
@font-face { font-family:"Soundstage Grotesk"; font-weight:400; font-display:swap; src:url(${FONT_URL}space-grotesk-400.woff2) format("woff2"); }
@font-face { font-family:"Soundstage Grotesk"; font-weight:500; font-display:swap; src:url(${FONT_URL}space-grotesk-500.woff2) format("woff2"); }
@font-face { font-family:"Soundstage Grotesk"; font-weight:600; font-display:swap; src:url(${FONT_URL}space-grotesk-600.woff2) format("woff2"); }
@font-face { font-family:"Soundstage Grotesk"; font-weight:700; font-display:swap; src:url(${FONT_URL}space-grotesk-700.woff2) format("woff2"); }

.ss-stage {
  --ss-bg:${T.bg}; --ss-card:${T.card}; --ss-raised:${T.raised}; --ss-line:${T.line}; --ss-line-strong:${T.lineStrong};
  --ss-text:${T.text}; --ss-muted:${T.muted}; --ss-faint:${T.faint}; --ss-accent:${T.accent}; --ss-accent-ink:${T.accentInk};
  background:var(--ss-bg) !important; color:var(--ss-text) !important; gap:10px !important; padding:12px !important;
  border-radius:16px !important; border:1px solid var(--ss-line);
  --ss-font:${FONT};
  font:13px/1.4 ${FONT} !important;
  letter-spacing:.005em;
}
/* One typeface everywhere in the App, whatever a panel's own CSS asks for (they were -apple-system, system-ui…). */
.ss-stage :not(:is(${OWN_FONT})) { font-family:var(--ss-font) !important; }
/* One type scale: 11 caption · 12 secondary · 13 body and controls · 15 section title · 18 step title. */
.ss-stage .ss-look, .ss-stage .ss-advisor { font-size:13px !important; line-height:1.4 !important; }
.ss-icon { flex:none; vertical-align:-3px; }

/* Rows read as glass cards, like Cinematic Studio's settings list. */
.ss-stage > .ss-bar, .ss-stage .ss-time, .ss-stage .ss-sel {
  background:var(--ss-card); border:1px solid var(--ss-line); border-radius:12px; padding:8px 10px;
}
.ss-stage .ss-bar label, .ss-stage .ss-time { color:var(--ss-muted); }
.ss-stage output { color:var(--ss-text) !important; }

/* Buttons: quiet pills; the accent is kept for the one main action in a group. */
.ss-stage button, .ss-stage .ss-btn, .ss-stage a.ss-btn {
  background:var(--ss-raised) !important; color:var(--ss-text) !important; border:1px solid var(--ss-line) !important;
  border-radius:999px !important; padding:5px 12px !important; display:inline-flex; align-items:center; gap:6px;
  font-weight:500 !important; text-decoration:none; transition:background .12s, border-color .12s;
}
.ss-stage button:hover:not(:disabled), .ss-stage .ss-btn:hover { background:#342c3b !important; border-color:var(--ss-line-strong) !important; }
.ss-stage button:disabled { opacity:.45; }
.ss-stage button:focus-visible, .ss-stage .ss-btn:focus-visible, .ss-stage input:focus-visible, .ss-stage select:focus-visible {
  outline:2px solid var(--ss-accent) !important; outline-offset:2px;
}
.ss-stage .ss-primary, .ss-stage button.ss-primary, .ss-stage .ss-cta {
  background:var(--ss-accent) !important; color:var(--ss-accent-ink) !important; border-color:var(--ss-accent) !important;
  text-transform:uppercase; letter-spacing:.05em; font-weight:700 !important;
}
.ss-stage .ss-primary:hover, .ss-stage .ss-cta:hover { background:#f6ff8a !important; }

/* Segmented controls (tabs, view modes, wipe/fade): one pill track, the active segment raised. */
.ss-stage .ss-tabs, .ss-stage .ss-views {
  background:var(--ss-card); border:1px solid var(--ss-line); border-radius:999px; padding:3px; gap:2px !important;
}
.ss-stage .ss-tabs button, .ss-stage .ss-views button {
  background:transparent !important; border:1px solid transparent !important; border-radius:999px !important;
  color:var(--ss-muted) !important; padding:5px 12px !important;
}
.ss-stage .ss-tabs button[aria-pressed=true], .ss-stage .ss-views button[aria-pressed=true] {
  background:var(--ss-raised) !important; color:var(--ss-text) !important; border-color:var(--ss-line) !important;
}
.ss-stage .ss-tabs { flex-wrap:wrap; }
.ss-stage .ss-tabs a.ss-btn { background:var(--ss-accent) !important; color:var(--ss-accent-ink) !important; border-color:var(--ss-accent) !important; font-weight:700 !important; }

.ss-stage .ss-brand { display:inline-flex; align-items:center; gap:7px; margin:0 auto 0 8px; font-weight:600; font-size:14px;
  color:var(--ss-text); letter-spacing:.01em; }
.ss-stage .ss-brand .ss-icon { color:var(--ss-accent); }
.ss-stage .ss-brand .ss-logo { display:inline-flex; line-height:0; }
.ss-stage .ss-brand .ss-wordmark { font-family:"Futura Condensed ExtraBold","Futura-CondensedExtraBold","Bebas Neue","Oswald","DIN Condensed","Avenir Next Condensed",Impact,sans-serif;
  font-weight:800; font-stretch:condensed; text-transform:uppercase; letter-spacing:.04em; font-size:17px; line-height:1; color:var(--ss-accent); }

/* Fields */
.ss-stage input[type=text], .ss-stage input[type=number], .ss-stage select, .ss-stage textarea {
  background:rgba(0,0,0,.22) !important; color:var(--ss-text) !important; border:1px solid var(--ss-line) !important;
  border-radius:10px !important; padding:6px 10px !important;
}
.ss-stage input::placeholder, .ss-stage textarea::placeholder { color:var(--ss-faint); }
.ss-stage input[type=range] { accent-color:var(--ss-accent) !important; }
.ss-stage input[type=color] { border:1px solid var(--ss-line); border-radius:8px; background:transparent; }

/* Text roles */
.ss-stage .ss-hint, .ss-stage .ss-small, .ss-stage .ss-cut-help { color:var(--ss-faint) !important; }
.ss-stage .ss-status { color:var(--ss-accent) !important; }
.ss-stage .ss-lightnote { color:var(--ss-muted) !important; font-style:normal; }
.ss-stage .ss-chip, .ss-stage .ss-cut-chip { background:rgba(255,255,255,.08) !important; color:var(--ss-text) !important; border-radius:6px !important; }
.ss-stage .ss-label, .ss-stage .ss-prevhead, .ss-stage .ss-adv-head {
  text-transform:uppercase; letter-spacing:.08em; font-size:11px; color:var(--ss-muted) !important; font-weight:600;
}
.ss-stage .ss-err, .ss-stage .ss-adv-warn { color:${T.danger} !important; }

/* The viewport and its overlays */
.ss-stage .ss-stageview canvas, .ss-stage .ss-ladder canvas { border-radius:12px; border:1px solid var(--ss-line); }
.ss-stage .ss-viewbadge { background:rgba(33,25,39,.72) !important; border:1px solid var(--ss-line); border-radius:999px !important;
  letter-spacing:.08em; padding:5px 10px !important; }
.ss-stage .ss-viewbadge[data-free=true] { background:var(--ss-accent) !important; color:var(--ss-accent-ink) !important; }
.ss-stage .ss-rungs span[data-ready=true] { color:var(--ss-accent) !important; }

/* Panels from the other modules sit on the same cards. */
.ss-stage .ss-look, .ss-stage .ss-advisor, .ss-stage .ss-cut { background:transparent !important; color:var(--ss-text) !important; }
.ss-stage .ss-look-row, .ss-stage .ss-adv-shot, .ss-stage .ss-adv-row, .ss-stage .ss-cut-bar, .ss-stage .ss-cut-insp, .ss-stage .ss-prev {
  background:var(--ss-card) !important; border:1px solid var(--ss-line) !important; border-radius:12px !important;
}
/* Tool buttons: the icon on top, a short label under it, a one-sentence tooltip (like Keynote's / Freeform's toolbar).
   Used by the Set step's tool dock and the selected person's actions. */
.ss-stage .ss-dock { display:flex; flex-wrap:wrap; gap:4px; align-items:stretch; padding:6px; background:var(--ss-card);
  border:1px solid var(--ss-line); border-radius:14px; }
.ss-stage .ss-dock[hidden] { display:none !important; }
.ss-stage button.ss-tool { flex:1 1 0; min-width:76px; max-width:136px; flex-direction:column !important; justify-content:flex-start;
  gap:5px !important; padding:8px 6px 7px !important; border-radius:10px !important; background:transparent !important;
  border:1px solid transparent !important; color:var(--ss-text) !important; font-size:12px !important; font-weight:500 !important;
  line-height:1.2 !important; text-align:center; white-space:normal; }
.ss-stage button.ss-tool .ss-icon { color:var(--ss-text); opacity:.92; }
.ss-stage button.ss-tool:hover:not(:disabled) { background:var(--ss-raised) !important; border-color:var(--ss-line) !important; }
.ss-stage button.ss-tool:hover .ss-icon, .ss-stage button.ss-tool[aria-pressed=true] .ss-icon { color:var(--ss-accent); opacity:1; }
.ss-stage button.ss-tool[aria-pressed=true] { background:var(--ss-raised) !important; border-color:var(--ss-line-strong) !important; }
.ss-stage button.ss-tool.ss-tool-ai .ss-icon { color:var(--ss-accent); }
.ss-stage .ss-dock .ss-dock-sep { width:1px; align-self:stretch; margin:6px 2px; background:var(--ss-line); }

/* The two scene-agent boxes and the Add box get room to show their example text. */
.ss-stage .ss-add input[type=text] { flex:1 1 220px; min-width:180px; max-width:440px; width:auto !important; }

/* Row heads: the same icon and name as the dock tool that leads here, so a row is easy to find again. */
.ss-stage .ss-rowhead { display:inline-flex; align-items:center; gap:6px; min-width:118px; color:var(--ss-muted);
  text-transform:uppercase; letter-spacing:.08em; font-size:11px !important; font-weight:600; white-space:nowrap; }
.ss-stage .ss-rowhead .ss-icon { color:var(--ss-text); opacity:.8; }

/* A tool brings you to its control and lights it up for a moment. */
@keyframes ss-spot { 0% { box-shadow:0 0 0 0 rgba(242,255,89,0); } 12%, 55% { box-shadow:0 0 0 3px rgba(242,255,89,.9); }
  100% { box-shadow:0 0 0 3px rgba(242,255,89,0); } }
.ss-stage .ss-spot { animation:ss-spot 2.2s ease-out 1; border-radius:12px; }
@media (prefers-reduced-motion: reduce) { .ss-stage .ss-spot { animation:none; outline:2px solid var(--ss-accent); } }

.ss-stage.ss-full { border-radius:20px !important; box-shadow:0 30px 90px rgba(0,0,0,.6) !important; }

/* ---- The one-screen workspace (Stage / Set step, Look, Ladder): like Blender, Maya or After Effects. Tool rail left,
   viewport centre (never pushed down), properties inspector right (scrolls on its own), timeline docked under the
   viewport, status line last. The page itself does not scroll. Narrow (the App's side panel): the parts stack. ---- */
.ss-stage.ss-ws-on { gap:8px !important; }
.ss-stage.ss-wsmode[data-ws=wide] { height:clamp(640px, calc(100vh - 96px), 1600px); overflow:hidden !important; }
.ss-stage.ss-full.ss-wsmode { height:auto !important; overflow:hidden !important; padding:10px !important; }
.ss-stage.ss-wsmode[data-ws=wide] > .ss-ws { flex:1 1 auto; min-height:0; }
.ss-stage.ss-wsmode[data-ws=wide] > :is(.ss-tabs, .ss-pipe, .ss-status) { flex:none; }
.ss-stage .ss-ws { display:flex; flex-direction:column; gap:8px; min-width:0; }
.ss-stage[data-ws=wide] .ss-ws { display:grid; grid-template-columns:auto minmax(0,1fr) var(--ss-insp-w,340px);
  grid-template-rows:minmax(0,1fr) auto; grid-template-areas:"rail center insp" "rail bottom insp"; }
.ss-ws > .ss-rail { grid-area:rail; min-height:0; overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; }
.ss-ws > .ss-center { grid-area:center; min-height:0; min-width:0; display:flex; flex-direction:column; gap:6px; }
.ss-stage[data-ws=wide] .ss-ws > .ss-center { overflow:auto; scrollbar-width:thin; }
.ss-ws > .ss-bottom { grid-area:bottom; min-width:0; display:flex; flex-direction:column; gap:4px; }
.ss-ws > .ss-insp { grid-area:insp; min-height:0; min-width:0; display:flex; flex-direction:column; gap:6px;
  background:var(--ss-card); border:1px solid var(--ss-line); border-radius:14px; padding:6px; }

/* Steps and tabs: one compact line each. */
.ss-stage.ss-wsmode[data-ws=wide] .ss-pipe { margin:0 !important; gap:4px; }
.ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button { flex-direction:row !important; align-items:center !important; gap:8px !important;
  padding:5px 12px !important; min-height:0; }
/* No overflow:hidden on the button: the name (.t) clips itself with an ellipsis, and the Ready dot sits on the pill's
   corner, where a clipped button cut it to a sliver that read as a stray backtick after each step name (QA round 05). */
.ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button { min-width:0 !important; white-space:nowrap; }
.ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button .t { font-size:13px; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button .n { flex:none; }
.ss-stage.ss-wsmode[data-ws=wide] .ss-pipe button .n { font-size:10px; }
.ss-stage.ss-wsmode[data-ws=wide] .ss-tabs { padding:2px; }
.ss-stage.ss-wsmode[data-ws=wide] .ss-tabs button { padding:4px 11px !important; }

/* Tool rail: the dock, stood up as a column of icon + label buttons. */
.ss-stage[data-ws=wide] .ss-rail .ss-dock { flex-direction:column; flex-wrap:nowrap; width:80px; box-sizing:border-box; padding:4px;
  gap:1px; min-height:100%; }
.ss-stage[data-ws=wide] .ss-rail button.ss-tool { flex:none; min-width:0; max-width:none; width:100%; padding:7px 2px 6px !important;
  font-size:10.5px !important; gap:4px !important; }
.ss-stage[data-ws=wide] .ss-rail .ss-dock-sep { width:auto; height:1px; margin:3px 10px; align-self:auto; flex:none; }

/* Viewport: slim header, then the picture fitted to the cell at the shot's aspect. */
.ss-stage .ss-vphead { display:flex; align-items:center; gap:8px; min-width:0; flex:none; }
.ss-stage .ss-vphead .ss-views { flex:none; }
.ss-stage .ss-vphead .ss-hint { flex:1 1 0; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px; }
.ss-stage .ss-vpcell { flex:1 1 auto; min-height:0; min-width:0; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.ss-stage[data-ws=narrow] .ss-vpcell { flex:none; display:block; }
.ss-stage .ss-vpcell > .ss-stageview { flex:none; max-width:100%; }

/* Timeline dock: transport always shown; tracks and the shot strip scroll inside their own band. */
.ss-stage .ss-bottom > .ss-time { padding:6px 10px; }
.ss-stage[data-ws=wide] .ss-bottomscroll { max-height:clamp(64px, 19vh, 240px); overflow-y:auto; overflow-x:hidden; scrollbar-width:thin;
  display:flex; flex-direction:column; gap:4px; }
.ss-stage .ss-bottomscroll .ss-tracks { margin-top:0 !important; }
.ss-stage .ss-bottomscroll .ss-cutbar { margin:0 !important; }

/* Narrow (the App's side panel): the parts stack; header and transport wrap; one button opens the full workspace. */
.ss-stage .ss-ws > .ss-wsopen { display:none !important; }
.ss-stage[data-ws=narrow]:not(.ss-full) .ss-ws > .ss-wsopen { display:inline-flex !important; justify-content:center; width:100%;
  background:var(--ss-accent) !important; color:var(--ss-accent-ink) !important; border-color:var(--ss-accent) !important; font-weight:700 !important; }
.ss-stage[data-ws=narrow] .ss-vphead, .ss-stage[data-ws=narrow] .ss-vphead .ss-views { flex-wrap:wrap; }
.ss-stage[data-ws=narrow] .ss-vphead .ss-hint { display:none; }
.ss-stage[data-ws=narrow] .ss-time, .ss-stage[data-ws=narrow] .ss-time .ss-views { flex-wrap:wrap; }

/* Inspector: section tabs, then one section at a time; long sections scroll here, not the page. */
.ss-stage .ss-insp-tabs { display:flex; gap:2px; padding:3px; background:rgba(0,0,0,.18); border-radius:12px; flex:none; }
.ss-stage .ss-insp-tabs button.ss-insp-tab { flex:1 1 0; min-width:0; flex-direction:column !important; justify-content:center; gap:3px !important;
  padding:6px 2px !important; border-radius:9px !important; background:transparent !important; border:1px solid transparent !important;
  color:var(--ss-muted) !important; font-size:11px !important; line-height:1.1 !important; }
.ss-stage .ss-insp-tabs button.ss-insp-tab[aria-pressed=true] { background:var(--ss-raised) !important; color:var(--ss-text) !important;
  border-color:var(--ss-line-strong) !important; }
.ss-stage .ss-insp-tabs button.ss-insp-tab[aria-pressed=true] .ss-icon { color:var(--ss-accent); }
.ss-stage .ss-insp-body { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; padding:1px; }
.ss-stage[data-ws=narrow] .ss-insp-body { max-height:70vh; }
.ss-stage .ss-pane { display:flex; flex-direction:column; gap:8px; }
.ss-stage .ss-insp :is(.ss-bar, .ss-sel) { background:var(--ss-card); border:1px solid var(--ss-line); border-radius:12px; padding:8px 10px;
  display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center; }
.ss-stage .ss-insp .ss-sel[hidden] { display:none !important; }
.ss-stage .ss-insp .ss-rowhead { flex:1 1 100%; min-width:0; }
/* Property rows, like Blender's: name on the left, the control filling the rest; a colour swatch sits beside its menu. */
.ss-stage .ss-insp :is(.ss-bar, .ss-sel) > label { flex:1 1 100%; min-width:0; display:grid; grid-template-columns:62px minmax(0,1fr) auto;
  align-items:center; gap:8px; white-space:normal; font-size:12px; }
.ss-stage .ss-insp :is(.ss-bar, .ss-sel) > label:has(+ label > input[type=color]) { flex-basis:calc(100% - 50px); }
.ss-stage .ss-insp :is(.ss-bar, .ss-sel) > label:has(+ label > input[type=color]) + label:has(> input[type=color]) { flex:0 0 40px; display:flex;
  font-size:0; gap:0; }
.ss-stage .ss-insp label > input[type=color] { width:36px !important; height:26px !important; }
.ss-stage .ss-insp label > input[type=range] { width:100% !important; min-width:0; }
.ss-stage .ss-insp label > select { width:100%; min-width:0; }
.ss-stage .ss-insp label > output { min-width:40px; text-align:right; }
.ss-stage .ss-insp .ss-add input[type=text] { flex:1 1 100% !important; max-width:none !important; min-width:0 !important; }
.ss-stage .ss-insp .ss-views { margin-left:0 !important; }
.ss-stage .ss-insp .ss-sel > .ss-chip { flex:1 1 100%; font-weight:600; padding:4px 10px; }
.ss-stage .ss-insp .ss-sundome { width:84px; height:84px; }
.ss-stage .ss-insp .ss-objhint { padding:2px 4px; }
`;

/**
 * Milestone 14, the pro layer: design tokens as CSS variables, one set of hover / focus / pressed states, and accent
 * restraint (the yellow marks the one main action of a step and where you are; a picked option is a neutral raised
 * segment). Its <style> is kept after every other Soundstage stylesheet (the panels add theirs as they open), so the
 * tokens win ties without raising specificity. Classic layout and the App's narrow panel get it too.
 */
const VARS = `--ss-fs-xs:${TYPE.xs}px; --ss-fs-sm:${TYPE.sm}px; --ss-fs-md:${TYPE.md}px; --ss-fs-lg:${TYPE.lg}px; --ss-fs-xl:${TYPE.xl}px;
  --ss-sp-1:${SPACE[1]}px; --ss-sp-2:${SPACE[2]}px; --ss-sp-3:${SPACE[3]}px; --ss-sp-4:${SPACE[4]}px; --ss-sp-5:${SPACE[5]}px;
  --ss-r-sm:${RADIUS.sm}px; --ss-r-md:${RADIUS.md}px; --ss-r-lg:${RADIUS.lg}px; --ss-r-xl:${RADIUS.xl}px;
  --ss-hover:${T.hover}; --ss-pressed:${T.pressed}; --ss-selected:${T.selected}; --ss-accent-soft:${T.accentSoft}; --ss-accent-line:${T.accentLine};
  --ss-muted:${T.muted}; --ss-faint:${T.faint}; --ss-danger:${T.danger}; --ss-success:${T.success};
  --ss-shadow-pop:0 18px 48px rgba(0,0,0,.5); --ss-shadow-panel:0 10px 30px rgba(0,0,0,.38);`;

export const PRO_CSS = `
.ss-stage, .ss-tour, .ss-keys { ${VARS} }
.ss-stage.ss-cl { --cv-glass:${T.glass}; --cv-glass-strong:${T.glassStrong}; --cv-edge:rgba(255,255,255,.10); }
.ss-stage * { scrollbar-color:rgba(255,255,255,.18) transparent; }

/* ---- Type: nothing under 11 px; one weight for labels (600), one for body (400/500). ---- */
.ss-stage .ss-pipe button .n, .ss-stage .ss-clfilm .ss-clgrp > .ss-cllab, .ss-stage .ss-shotrow .shot .st,
.ss-stage.ss-cl .ss-clfilm .cand .cap, .ss-stage.ss-cl .ss-clfilm .cand .pill, .ss-stage .ss-hudp .ss-sc-tile label,
.ss-stage .ss-hudp .ss-sc-acts button, .ss-stage.ss-cl[data-ws=wide] .ss-shotrow .shot .st { font-size:var(--ss-fs-xs) !important; }
.ss-stage[data-ws=wide] .ss-rail button.ss-tool { font-size:var(--ss-fs-xs) !important; line-height:1.15 !important; }
.ss-stage :is(.ss-label, .ss-rowhead, .ss-hudp-title, .ss-hudp-sec > summary, .ss-cllab, .ss-prevhead, .ss-adv-head) { letter-spacing:.07em !important; }
.ss-stage .ss-primary, .ss-stage button.ss-primary, .ss-stage .ss-cta { text-transform:none !important; letter-spacing:.005em !important; font-weight:600 !important; }
.ss-stage .ss-pipeview button.go, .ss-stage button.ss-vi-head { font-weight:600 !important; letter-spacing:.005em; }

/* ---- One set of states: hover, pressed, focus, disabled. ---- */
.ss-stage button, .ss-stage .ss-btn { transition:background-color .12s, border-color .12s, color .12s, box-shadow .12s, filter .12s; }
.ss-stage button:active:not(:disabled), .ss-stage .ss-btn:active { background:var(--ss-pressed) !important; }
.ss-stage :is(.ss-primary, .ss-cta, .ss-pipeview button.go, button.ss-vi-head):active:not(:disabled) { background:var(--ss-accent) !important; filter:brightness(.92); }
.ss-stage :is(.ss-primary, .ss-cta, .ss-pipeview button.go, button.ss-vi-head):hover:not(:disabled) { filter:brightness(1.06); }
.ss-stage :is(button, .ss-btn, a, summary, input, select, textarea, [tabindex]:not(canvas)):focus-visible {
  outline:2px solid var(--ss-accent) !important; outline-offset:2px !important; }
.ss-stage :is(input[type=text], input[type=number], select, textarea):focus { border-color:var(--ss-accent-line) !important; }
.ss-stage button:disabled, .ss-stage .ss-btn[aria-disabled=true] { opacity:.42 !important; cursor:default !important; filter:none !important; }
.ss-stage input[type=checkbox] { accent-color:var(--ss-accent); }

/* ---- Accent restraint: a picked option is a raised neutral segment, not a second yellow button. ---- */
.ss-stage :is(.ss-pipeview .seg, .ss-pipeview .ss-sc-sizes, .ss-cast .sizes, .ss-lcmp) button[aria-pressed=true]:not(:disabled) {
  background:var(--ss-selected) !important; color:var(--ss-text) !important; border-color:var(--ss-line-strong) !important; font-weight:600 !important;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06); }
.ss-stage :is(.ss-pipeview .seg, .ss-lcmp) button:not([aria-pressed=true]):hover:not(:disabled) { background:rgba(255,255,255,.07) !important; }
/* The step's way on ("Animate this frame →", "Review →") is a quiet outlined button: the step's own action is the yellow one. */
.ss-stage .ss-pipeview button.go.next { background:transparent !important; color:var(--ss-text) !important; border:1px solid var(--ss-line-strong) !important; }
.ss-stage .ss-pipeview button.go.next:hover:not(:disabled) { background:rgba(255,255,255,.06) !important; border-color:var(--ss-accent-line) !important; filter:none; }
.ss-stage .ss-pipeview button.go.next:active:not(:disabled) { background:var(--ss-pressed) !important; filter:none; }
/* Paint Studio, inside ④ Frame's panel: a strong secondary next to Generate frames. */
.ss-stage .ss-hudp button.go.ss-paint-open { background:var(--ss-raised) !important; color:var(--ss-text) !important; border:1px solid var(--ss-line-strong) !important; }
.ss-stage .ss-hudp button.go.ss-paint-open .ss-icon { color:var(--ss-accent); }
.ss-stage .ss-hudp button.go.ss-paint-open:hover:not(:disabled) { background:var(--ss-hover) !important; filter:none; }
/* ② Cast: "Generate all missing" is the step's yellow button; a card's own Generate is a neutral button with a yellow icon. */
.ss-stage .ss-cast .btn.primary { background:rgba(255,255,255,.06) !important; color:var(--ss-text) !important; border-color:var(--ss-line-strong) !important; font-weight:500 !important; }
.ss-stage .ss-cast .btn.primary .ss-icon { color:var(--ss-accent); }
.ss-stage .ss-cast .btn:hover:not(:disabled) { border-color:var(--ss-accent-line) !important; }
/* The scene badge in a scene switcher: accent text on a soft tint, not a yellow block. */
.ss-stage .ss-scsw .k:not(.all) { background:var(--ss-accent-soft) !important; color:var(--ss-accent) !important; box-shadow:inset 0 0 0 1px var(--ss-accent-line); }
/* The status line reads as status, not as a warning in yellow. */
.ss-stage > .ss-status, .ss-stage .ss-status { color:var(--ss-muted) !important; }
/* The small "drop a video" pill: glass with a hairline, the icon carries the accent. The big empty-stage one keeps its dash. */
.ss-stage button.ss-vi-cta:not([data-big=true]) { border:1px solid var(--cv-edge, var(--ss-line)) !important; color:var(--ss-text) !important;
  background:var(--cv-glass-strong, rgba(26,20,31,.94)) !important; font-weight:500 !important; }
.ss-stage button.ss-vi-cta:not([data-big=true]) .ss-icon { color:var(--ss-accent); }
.ss-stage button.ss-vi-cta:not([data-big=true]):hover:not(:disabled) { border-color:var(--ss-accent-line) !important; }

/* ---- Panels: aligned property rows, clear section heads, nothing cramped. ---- */
.ss-stage .ss-insp :is(.ss-bar, .ss-sel) > label { grid-template-columns:84px minmax(0,1fr) auto !important; color:var(--ss-muted); }
.ss-stage .ss-insp :is(.ss-bar, .ss-sel) > label > :is(select, input, output) { color:var(--ss-text); }
.ss-stage .ss-hudp-body > details:not(.ss-hudp-sec) { background:transparent !important; border:0 !important; border-top:1px solid var(--cv-edge) !important;
  border-radius:0 !important; padding:4px 0 0 !important; }
.ss-stage .ss-hudp-body > details:not(.ss-hudp-sec) > summary, .ss-stage .ss-more > summary { cursor:pointer; list-style:none; font-size:var(--ss-fs-xs) !important;
  font-weight:600 !important; letter-spacing:.07em; text-transform:uppercase; color:var(--ss-muted); padding:5px 2px; display:flex; align-items:center; gap:6px; }
.ss-stage :is(.ss-hudp-body > details, .ss-more) > summary::-webkit-details-marker { display:none; }
.ss-stage :is(.ss-hudp-sec, .ss-hudp-body > details, .ss-more) > summary::before { content:""; width:5px; height:5px; flex:none; margin:0 2px 0 1px;
  border:solid currentColor; border-width:0 1.5px 1.5px 0; transform:rotate(-45deg); transition:transform .12s; opacity:.8; }
.ss-stage :is(.ss-hudp-sec, .ss-hudp-body > details, .ss-more)[open] > summary::before { transform:rotate(45deg) translate(-1px,-1px); }
.ss-stage :is(.ss-hudp-sec, .ss-hudp-body > details, .ss-more) > summary:hover { color:var(--ss-text); }
.ss-stage .ss-hudp-body > details:not(.ss-hudp-sec)[open] { display:flex; flex-direction:column; gap:8px; padding-bottom:6px !important; }
.ss-stage .ss-hudp-head { min-height:34px; }
.ss-stage button.ss-hudp-tog { color:var(--ss-muted) !important; background:transparent !important; border-color:transparent !important; }
.ss-stage button.ss-hudp-tog:hover:not(:disabled) { color:var(--ss-text) !important; background:rgba(255,255,255,.08) !important; }
.ss-stage .ss-hudp { box-shadow:var(--ss-shadow-panel); }
.ss-stage .ss-hudp-sec { padding-top:6px; }
.ss-stage .ss-pipeview label.f { color:var(--ss-muted); }

/* ③ Set › a selected object: one compact tool row (Move · Rotate · Scale | Measure · Snap | Physics · Duplicate · Delete) as icon
   buttons with tooltips, like any 3D app's transform bar; the inspector no longer scrolls for it (QA round 02). */
.ss-stage .ss-insp .ss-sel { gap:6px 6px !important; }
.ss-stage .ss-insp .ss-sel > .ss-views { flex:none; margin:0 !important; }
.ss-stage .ss-insp .ss-sel > label { order:5; }
.ss-stage .ss-insp .ss-sel > .ss-views button, .ss-stage .ss-insp .ss-sel > button.ss-btn { font-size:0 !important; gap:0 !important; padding:6px 6px !important; }
.ss-stage .ss-insp .ss-sel > button.ss-btn { background:transparent !important; border-color:var(--ss-line) !important; }
.ss-stage .ss-insp .ss-sel > button.ss-btn:hover:not(:disabled) { background:rgba(255,255,255,.07) !important; border-color:var(--ss-line-strong) !important; }
.ss-stage .ss-insp .ss-sel > button.ss-btn:last-of-type:hover:not(:disabled) { color:var(--ss-danger) !important; }
.ss-stage .ss-insp .ss-sel > .ss-views button .ss-icon, .ss-stage .ss-insp .ss-sel > button.ss-btn .ss-icon { width:15px; height:15px; }

/* "More": the rarely used options of a panel, one click away. */
.ss-stage .ss-more { flex:1 1 100%; min-width:0; border-top:1px solid var(--ss-line); padding-top:4px; }
.ss-stage .ss-more > .ss-more-body { display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center; padding:6px 0 2px; }
.ss-stage .ss-insp .ss-more > .ss-more-body > label { flex:1 1 100%; min-width:0; display:grid; grid-template-columns:84px minmax(0,1fr); align-items:center; gap:8px;
  font-size:var(--ss-fs-sm); color:var(--ss-muted); }

/* ⑦ Deliver: each way out is its own card with room to breathe; one yellow button on the panel. */
.ss-stage.ss-cl .ss-hudp .ss-deliver-card { display:flex !important; flex-direction:column; gap:6px; padding:10px 0 12px !important; border-top:1px solid var(--cv-edge) !important; }
.ss-stage.ss-cl .ss-hudp .ss-deliver-card:first-child { border-top:0 !important; padding-top:2px !important; }
.ss-stage .ss-deliver-card > strong { display:flex; align-items:center; gap:8px; font-size:var(--ss-fs-md); font-weight:600; }
.ss-stage .ss-deliver-card > strong .ss-icon { color:var(--ss-muted); }
.ss-stage .ss-deliver-card > .lede { color:var(--ss-muted) !important; font-size:var(--ss-fs-sm) !important; line-height:1.45; margin:0; }
.ss-stage .ss-deliver-card .row { gap:6px !important; }
.ss-stage .ss-pipeview .ss-deliver-card button.go:not(.ss-main) { background:var(--ss-raised) !important; color:var(--ss-text) !important; border:1px solid var(--ss-line-strong) !important; }
.ss-stage .ss-pipeview .ss-deliver-card button.go:not(.ss-main):hover:not(:disabled) { background:var(--ss-hover) !important; filter:none; }
.ss-stage .ss-pipeview .ss-deliver-card button.go:not(.ss-main):active:not(:disabled) { background:var(--ss-pressed) !important; filter:none; }
.ss-stage .ss-pipeview .ss-deliver-card .ghost { padding:5px 12px !important; font-size:var(--ss-fs-sm) !important; }

/* The viewport header's long help line gave way to the "?" shortcut sheet (it was always cut off). */
.ss-stage.ss-cl[data-ws=wide] .ss-vphead > .ss-hint { display:none !important; }
.ss-stage .ss-keysbtn { flex:none; }
.ss-stage .ss-keysbtn kbd { font:600 11px/1 var(--ss-font); border:1px solid var(--ss-line-strong); border-bottom-width:2px; border-radius:5px; padding:2px 5px;
  color:var(--ss-muted); background:rgba(255,255,255,.04); }
`;

const OUR_STYLE = /^(soundstage|ss-)/;
/** Keep the pro layer the last Soundstage stylesheet: panels add theirs when they first open. */
function keepProLast() {
  const pro = document.getElementById("soundstage-pro");
  if (!pro) return;
  const ours = [...document.head.querySelectorAll("style[id]")].filter((x) => OUR_STYLE.test(x.id));
  if (ours[ours.length - 1] !== pro) document.head.appendChild(pro);
}

export function applyTheme() {
  if (document.getElementById("soundstage-theme")) return;
  const s = document.createElement("style");
  s.id = "soundstage-theme";
  s.textContent = CSS;
  document.head.appendChild(s); // after the panels' own <style> tags, so it wins ties
  const p = document.createElement("style");
  p.id = "soundstage-pro";
  p.textContent = PRO_CSS;
  document.head.appendChild(p);
  try { new MutationObserver(keepProLast).observe(document.head, { childList: true }); } catch { /* no observer: order as added */ }
  queueMicrotask?.(keepProLast);
}

/**
 * Bring a control into view and light it up for a moment (what a tool in the dock does), optionally focusing a field.
 * Scrolls only a real scroll container (the App panel, or the page when it scrolls): never an overflow:hidden parent,
 * which would shift ComfyUI's canvas under its DOM widgets.
 */
export function spotlight(target, focusEl = null, { scroll = true, instant = false } = {}) {
  if (!target) return;
  if (scroll) scrollToView(target, instant);
  target.classList.remove("ss-spot");
  void target.offsetWidth;   // restart the animation
  target.classList.add("ss-spot");
  clearTimeout(target._ssSpotT);
  target._ssSpotT = setTimeout(() => target.classList.remove("ss-spot"), 2300);
  if (focusEl) {
    const go = () => { try { focusEl.focus({ preventScroll: true }); } catch { /* detached */ } };
    if (instant) go(); else setTimeout(go, 280);
  }
}

function scrollToView(t, instant) {
  const behavior = instant ? "auto" : "smooth";
  const r = t.getBoundingClientRect();
  for (let p = t.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 4) {
      const pr = p.getBoundingClientRect();
      if (r.top < pr.top + 8 || r.bottom > pr.bottom - 8) p.scrollBy({ top: r.top - pr.top - Math.max(16, (pr.height - r.height) / 3), behavior });
      return;
    }
  }
  // No scrolling panel: the page itself, only when it really scrolls (ComfyUI's page never does).
  const root = document.scrollingElement;
  if (!root || getComputedStyle(document.body).overflowY === "hidden" || root.scrollHeight <= innerHeight + 4) return;
  if (r.top < 8 || r.bottom > innerHeight - 8) scrollBy({ top: r.top - Math.max(16, (innerHeight - r.height) / 3), behavior });
}
