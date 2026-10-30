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
  line: "rgba(255,255,255,0.08)",
  lineStrong: "rgba(255,255,255,0.16)",
  text: "#f0efed",
  muted: "rgba(240,239,237,0.56)",
  faint: "rgba(240,239,237,0.36)",
  accent: "#f2ff59",
  accentInk: "#211927",
  danger: "#ff7a7a",
};

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
  font:13px/1.4 "Soundstage Grotesk", "PP Formula", ui-sans-serif, system-ui, sans-serif !important;
  letter-spacing:.005em;
}
.ss-stage *, .ss-stage button, .ss-stage input, .ss-stage select, .ss-stage textarea { font-family:inherit; }
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
.ss-stage.ss-full { border-radius:20px !important; box-shadow:0 30px 90px rgba(0,0,0,.6) !important; }
`;

export function applyTheme() {
  if (document.getElementById("soundstage-theme")) return;
  const s = document.createElement("style");
  s.id = "soundstage-theme";
  s.textContent = CSS;
  document.head.appendChild(s); // after the panels' own <style> tags, so it wins ties
}
