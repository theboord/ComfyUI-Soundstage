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

/** The one UI typeface (canvas text too): Space Grotesk, then the platform UI font while it loads. */
export const FONT = `"Soundstage Grotesk", "PP Formula", ui-sans-serif, system-ui, sans-serif`;
// Kept in their own face: timecodes (an NLE convention) and the screenplay page (Courier, like every script).
const OWN_FONT = ".ss-mono, .ss-cut-tc, .ss-cut-ro, .ss-strip-tc, .ss-strip-dur, .ss-pip-bar output, .ss-prev textarea, .ss-script .page, .ss-script .page *";

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
`;

export function applyTheme() {
  if (document.getElementById("soundstage-theme")) return;
  const s = document.createElement("style");
  s.id = "soundstage-theme";
  s.textContent = CSS;
  document.head.appendChild(s); // after the panels' own <style> tags, so it wins ties
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
