// Script panel: bring a screenplay in (Fountain, Final Draft .fdx, PDF or plain text) and browse it scene by scene:
// the outline, a colour-coded breakdown, the scene's pages in screenplay format, the director's own notes and the
// shots made for that scene so far, plus one button that builds the scene on the 3D stage.
// Import only: the script text is read-only here (no writing tools); the notes field is the director's.
//
//   import { ScriptPanel, SceneSwitcher } from "./script/panel.mjs";
//   const panel = new ScriptPanel(el, { getScript, setScript, getShots, onBuildScene, onNewShot, onSelectScene, onStatus });
//   Optional: onOpenScriptSync(scene) + hasTakes(scene) add "Open ScriptSync for this scene" to a scene that has takes.
//   const sw = new SceneSwitcher(stepHeader, { getScript, getShots, onSelect: (id) => panel.selectScene(id), current: null });
//
// The host owns the data: getScript() / setScript(script, {reason}) persist the Script, getShots() lists [{id, name,
// scene_id?, thumb?}]. A shot belongs to a scene through scene_id. setScript's reason is 'notes' (an autosave),
// 'revise' (a revised draft: mergeNotes kept the ids), 'replace' (a different script: its sc_1 is not the old sc_1, so
// drop or remap scene_id links and any per-scene stage state) or 'sample'. thumb is an image URL (preferred: the
// chosen frame or look render), a canvas, or a function returning either, called once per tile only when the tile is
// drawn (use that for a live stage render: stage.renderFrameTo() hands back one shared canvas, so it must be drawn at
// once). Canvases are drawn down to tile size. Optional: onOpenShot(shot) makes shot thumbnails clickable, sample
// (a Script) adds "Try the sample script" to the empty state. No alert/confirm: everything is inline + onStatus.
// Mount points must allow shrinking (min-width:0 on a flex/grid item) so long headings ellipsize instead of widening.
import { importScriptFile, sceneSummaryLine, formatEighths, buildPromptForScene } from "./parse.mjs";
import * as parse from "./parse.mjs";
import { TOKENS as T } from "../ui/theme.mjs";
import { icon as lucide } from "../ui/icons.mjs";

const ACCEPT = ".fountain,.spmd,.fdx,.pdf,.txt,.text,.md";

// Line icons in the Lucide style of ui/icons.mjs (24-unit grid, 1.75 stroke) for what that set does not have.
const PATHS = {
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.3a5 5 0 0 1 3 4.7v1"/>',
  car: '<path d="M5 17H3.5a1 1 0 0 1-1-1v-3.3a2 2 0 0 1 .4-1.2L5.6 8a2 2 0 0 1 1.6-.8h9.6a2 2 0 0 1 1.6.8l2.7 3.5a2 2 0 0 1 .4 1.2V16a1 1 0 0 1-1 1H19"/><path d="M9 17h6"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M4 12h16"/>',
  paw: '<circle cx="5.5" cy="10.5" r="2"/><circle cx="9.5" cy="5.5" r="2"/><circle cx="14.5" cy="5.5" r="2"/><circle cx="18.5" cy="10.5" r="2"/><path d="M8 17.5c0-2.6 1.8-5 4-5s4 2.4 4 5a2.5 2.5 0 0 1-2.5 2.5c-.6 0-1-.3-1.5-.3s-.9.3-1.5.3A2.5 2.5 0 0 1 8 17.5z"/>',
  shirt: '<path d="M8.5 3 3 6l2 5 2.5-1.2V21h9V9.8L19 11l2-5-5.5-3a3.5 3.5 0 0 1-7 0z"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4.2-3.3-6.6-4.2-10.2C13.4 7 12.6 8 11 8.6 11.3 6.6 10.8 4.5 9.6 2.8 7 5.9 5 9.8 5 15a7 7 0 0 0 7 7z"/><path d="M12 22a3 3 0 0 1-3-3c0-1.8 1.4-3 3-5 1.6 2 3 3.2 3 5a3 3 0 0 1-3 3z"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  lamp: '<path d="M8 3h8l3 8H5z"/><path d="M12 11v8"/><path d="M8 21h8"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a6.8 6.8 0 0 0 10.7 10.7z"/>',
  sunset: '<path d="M12 2v6"/><path d="m9 5 3 3 3-3"/><path d="m4.9 10.9 1.4 1.4"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m17.7 12.3 1.4-1.4"/><path d="M22 22H2"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"/>',
  tree: '<path d="M12 22v-5"/><path d="M12 2 6 10h3l-4 7h14l-4-7h3z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  updown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
  page: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/><path d="M9 9h1"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  stage: '<path d="M3 8 12 3l9 5-9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
};

function svg(name, size = 16) {
  if (!PATHS[name]) return lucide(name, size);
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const attrs = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.75,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "ss-icon" };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.innerHTML = PATHS[name];
  return s;
}

// The big drop-zone art: a screenplay page, three-hole punched with brass brads, slug line in the accent.
const PAGE_ART = `<svg viewBox="0 0 64 64" width="76" height="76" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 5h23l11 11v41a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>
  <path d="M39 5v11h11"/><g fill="currentColor" stroke="none"><circle cx="20" cy="15" r="1.7"/><circle cx="20" cy="32" r="1.7"/>
  <circle cx="20" cy="49" r="1.7"/></g><path d="M26 19h12" stroke="${T.accent}" stroke-width="2.6"/><path d="M26 25h18"/>
  <path d="M33 31h6"/><path d="M29 35.5h13"/><path d="M29 40h9"/><path d="M26 46h18"/><path d="M26 50.5h11"/></svg>`;

// Industry breakdown-sheet colour coding (cast red, stunts orange, extras green, SFX blue, props violet,
// vehicles/animals pink, sound brown), softened for the dark UI.
export const BREAKDOWN_CATEGORIES = [
  { key: "cast", label: "Cast", icon: "user", color: "#ff8f8f" },
  { key: "extras", label: "Extras", icon: "users", color: "#7ee2a8" },
  { key: "stunts", label: "Stunts", icon: "zap", color: "#ffb56e" },
  { key: "sfx", label: "Effects", icon: "flame", color: "#80bcff" },
  { key: "props", label: "Props", icon: "box", color: "#c8a0ff" },
  { key: "vehicles", label: "Vehicles", icon: "car", color: "#ff92d2" },
  { key: "animals", label: "Animals", icon: "paw", color: "#ffa6c6" },
  { key: "wardrobe", label: "Wardrobe", icon: "shirt", color: "#e9c78f" },
  { key: "set_dressing", label: "Set dressing", icon: "lamp", color: "#bccb8c" },
  { key: "sound", label: "Sound", icon: "speaker", color: "#d8ae84" },
  { key: "music", label: "Music", icon: "music", color: "#d8ae84" },
];

// Stage set labels, mirrored from soundstage/agent/catalog.py SETS (labels only).
const SET_LABELS = { plaza: "Plaza", street_night: "City street", interior: "Interior room", studio: "Studio cyc",
  forest: "Forest", desert: "Desert", beach: "Beach & ocean", water_tank: "Water tank", open_water: "Open water",
  stadium: "Stadium", empty: "Empty stage" };
const TIME_ICON = { day: "sun", night: "moon", dawn: "sunrise", dusk: "sunset", time: "clock" };
const IE_LABEL = { INT: "Interior", EXT: "Exterior", "INT/EXT": "Int / Ext" };

// ------------------------------------------------------------------ pure helpers (exported for tests)

/** Shots per scene id (shots without a scene_id only count toward the total). */
export function shotCounts(shots) {
  const m = new Map();
  for (const s of shots || []) if (s?.scene_id) m.set(s.scene_id, (m.get(s.scene_id) || 0) + 1);
  return m;
}

/** Scenes whose number, heading or speaking characters contain every word of the query. */
export function filterScenes(scenes, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return scenes || [];
  return (scenes || []).filter((sc) => {
    const hay = [sc.number, sc.heading, sc.location, ...(sc.characters || []), sc.synopsis].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 'day' | 'night' | 'dawn' | 'dusk' | 'time' (some other time, e.g. CONTINUOUS) | null, for the icon. */
export function timeKind(sc) {
  const hint = sc?.stage_hint?.time_of_day;
  if (hint && TIME_ICON[hint]) return hint;
  const t = String(sc?.time || "").toUpperCase();
  if (/NIGHT/.test(t)) return "night";
  if (/DAWN|SUNRISE|MORNING|DAYBREAK/.test(t)) return "dawn";
  if (/DUSK|SUNSET|EVENING|MAGIC|TWILIGHT/.test(t)) return "dusk";
  if (/DAY|NOON|AFTERNOON/.test(t)) return "day";
  return t ? "time" : null;
}

const SMALL = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
/** Screenplay ALL CAPS to Title Case for labels ("DRY CREEK - MAIN STREET" → "Dry Creek – Main Street"). The
 *  writer's own mixed case is kept. */
export function niceText(s) {
  s = String(s ?? "").trim();
  if (!s || /[a-z]/.test(s)) return s;
  let first = true;
  return s.toLowerCase().replace(/\s+-\s+/g, " – ").split(/(\s+)/).map((w) => {
    if (/^\s+$/.test(w)) return w;
    if (w === "–") { first = true; return w; }
    // Every part of a hyphenated or O'-name: "Bartholomew-Alexander", "Truck-Stop", "O'Hara" (not "Sheriff'S").
    const out = !first && SMALL.has(w) ? w
      : w.replace(/(?<=^['’]*|[-("“]|(?<!\p{L})\p{L}['’])\p{L}/gu, (c) => c.toUpperCase());
    first = false;
    return out;
  }).join("");
}

/** Breakdown item for a chip: "SIREN WAILING" / "siren wailing" → "Siren wailing" (quotes kept). */
const chipText = (s) => { s = String(s || "").trim(); if (!/[a-z]/.test(s)) s = s.toLowerCase(); return s.replace(/\p{L}/u, (c) => c.toUpperCase()); };
const sentence = (s) => { s = String(s || "").trim().toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : ""; };
const itemText = (x) => (typeof x === "string" ? x : x?.name || x?.text || String(x ?? ""));
const kindLabel = (k) => String(k).replace(/_/g, " ");
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

/** Page a scene starts on (from the eighths before it), 1-based. */
export function startPage(script, sc) {
  let e = 0;
  for (const x of script?.scenes || []) { if (x === sc || x.id === sc?.id) break; e += x.eighths || 0; }
  return Math.floor(e / 8) + 1;
}

/** Shots that are in no scene of this script: no scene_id, or one this draft does not have (a cut scene, an old script). */
export function looseShots(script, shots) {
  const ids = new Set((script?.scenes || []).map((x) => x.id));
  return (shots || []).filter((x) => x && (!x.scene_id || !ids.has(x.scene_id)));
}

/** Carry notes from an older draft when parse.mjs has no mergeNotes: match by scene number, then exact heading. */
function carryNotes(oldS, newS) {
  const byNum = new Map(), byHead = new Map();
  for (const s of oldS?.scenes || []) { if (s.notes) { byNum.set(String(s.number), s.notes); byHead.set(s.heading, s.notes); } }
  return { ...newS, scenes: newS.scenes.map((s) => ({ ...s, notes: s.notes || byNum.get(String(s.number)) || byHead.get(s.heading) || "" })) };
}

// ------------------------------------------------------------------ DOM

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
};

// Inputs and the textarea keep their keys (the stage and ComfyUI listen for Delete, arrows, space…); Escape still
// bubbles so the expanded view can close.
function guard(el) {
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  el.addEventListener("keydown", (e) => { if (e.key !== "Escape" && e.target.matches?.("input, textarea")) e.stopPropagation(); });
}

const FONT = `"Soundstage Grotesk", "PP Formula", ui-sans-serif, system-ui, sans-serif`;
// Buttons restate background/border/radius/padding with !important because ui/theme.mjs styles every
// `.ss-stage button` with !important; the selectors here are one step more specific than the theme's.
const STYLE = `
.ss-script, .ss-scsw {
  --sx-text:var(--ss-text, ${T.text}); --sx-muted:var(--ss-muted, ${T.muted}); --sx-faint:var(--ss-faint, ${T.faint});
  --sx-line:var(--ss-line, ${T.line}); --sx-line2:var(--ss-line-strong, ${T.lineStrong}); --sx-card:var(--ss-card, ${T.card});
  --sx-raised:var(--ss-raised, ${T.raised}); --sx-accent:var(--ss-accent, ${T.accent}); --sx-ink:var(--ss-accent-ink, ${T.accentInk});
  --sx-paper:#1a1420; color:var(--sx-text); font:13px/1.45 ${FONT}; letter-spacing:.005em;
}
.ss-script *, .ss-script *::before, .ss-script *::after, .ss-scsw * { box-sizing:border-box; }
.ss-script { position:relative; display:flex; flex-direction:column; gap:14px; min-width:0; container:ss-script / inline-size; }
.ss-script h2, .ss-script h3, .ss-script h4, .ss-script p { margin:0; }
.ss-script .ss-icon { flex:none; }
.ss-script .lbl { text-transform:uppercase; letter-spacing:.08em; font-size:11px; font-weight:600; color:var(--sx-muted); }
.ss-script .card { background:var(--sx-card); border:1px solid var(--sx-line); border-radius:14px; padding:12px 14px; display:flex;
  flex-direction:column; gap:10px; min-width:0; }
.ss-script .card > header { display:flex; align-items:center; gap:8px; min-height:20px; }
.ss-script .card > header .lbl { display:inline-flex; align-items:center; gap:6px; }
.ss-script .card > header .aside { margin-left:auto; color:var(--sx-faint); font-size:12px; }
.ss-script .muted { color:var(--sx-muted); }
.ss-script .faint { color:var(--sx-faint); font-size:12px; }

.ss-script button.btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; font:inherit; white-space:nowrap;
  background:var(--sx-raised) !important; color:var(--sx-text) !important; border:1px solid var(--sx-line) !important;
  border-radius:999px !important; padding:6px 12px !important; font-weight:500 !important; transition:background .12s, border-color .12s; }
.ss-script button.btn:hover:not(:disabled) { background:#342c3b !important; border-color:var(--sx-line2) !important; }
.ss-script button.btn.primary { background:var(--sx-accent) !important; color:var(--sx-ink) !important; border-color:var(--sx-accent) !important;
  font-weight:700 !important; text-transform:uppercase; letter-spacing:.05em; padding:8px 16px !important; }
.ss-script button.btn.primary:hover:not(:disabled) { background:#f6ff8a !important; border-color:#f6ff8a !important; }
.ss-script button.btn.round { padding:6px !important; width:30px; height:30px; }
.ss-script button.btn:disabled { opacity:.45; cursor:default; }
.ss-script button:focus-visible, .ss-script input:focus-visible, .ss-script textarea:focus-visible, .ss-scsw button:focus-visible {
  outline:2px solid var(--sx-accent) !important; outline-offset:2px; }

/* Empty state */
.ss-script-empty { display:grid; place-items:center; padding:24px 0; min-height:380px; }
.ss-script-empty .drop { width:min(560px, 100%); border:1.5px dashed var(--sx-line2); border-radius:22px; padding:40px 28px 32px;
  display:flex; flex-direction:column; align-items:center; text-align:center; gap:8px; background:var(--sx-card); }
.ss-script-empty .art { color:var(--sx-text); margin-bottom:8px; opacity:.92; }
.ss-script-empty h3 { font-size:22px; font-weight:600; letter-spacing:0; }
.ss-script-empty .fmts { color:var(--sx-muted); font-size:14px; }
.ss-script-empty .acts { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin-top:14px; }
.ss-script-empty .fine { color:var(--sx-faint); font-size:12px; margin-top:10px; max-width:42ch; }

/* Header */
.ss-script-head { display:flex; align-items:center; gap:12px 16px; flex-wrap:wrap; }
.ss-script-head .ttl { display:flex; align-items:center; gap:12px; min-width:0; flex:1 1 280px; }
.ss-script-head .badge { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none;
  background:rgba(242,255,89,.10); color:var(--sx-accent); border:1px solid rgba(242,255,89,.22); }
.ss-script-head .tx { min-width:0; display:flex; flex-direction:column; gap:1px; }
.ss-script-head h2 { font-size:17px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-script-head .by { color:var(--sx-muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-script-head .acts { display:flex; gap:8px; flex-wrap:wrap; }
.ss-script .banner { display:flex; align-items:center; gap:10px 12px; flex-wrap:wrap; padding:10px 12px; border-radius:12px;
  border:1px solid var(--sx-line2); background:var(--sx-raised); }
.ss-script .banner.err { border-color:rgba(255,122,122,.55); }
.ss-script .banner .msg { flex:1 1 260px; }

/* Two columns: scene list | scene */
.ss-script-body { display:grid; grid-template-columns:minmax(240px, 300px) minmax(0, 1fr); gap:14px; align-items:start; }
.ss-script-list { display:flex; flex-direction:column; gap:8px; min-width:0; }
.ss-script .find { display:flex; align-items:center; gap:8px; padding:0 10px; border-radius:10px; color:var(--sx-faint);
  background:rgba(0,0,0,.22); border:1px solid var(--sx-line); }
.ss-script .find:focus-within { border-color:var(--sx-accent); color:var(--sx-muted); }
.ss-script .find input:focus-visible { outline:none !important; }
.ss-script .find input { flex:1; min-width:0; background:transparent !important; border:0 !important; outline:none !important;
  color:var(--sx-text) !important; font:inherit; padding:8px 0 !important; box-shadow:none !important; }
.ss-script .find input::placeholder { color:var(--sx-faint); }
.ss-script .find input::-webkit-search-cancel-button { filter:invert(1) opacity(.5); }
.ss-script .rows { display:flex; flex-direction:column; gap:2px; padding:4px; max-height:min(72vh, 680px); overflow:auto;
  background:var(--sx-card); border:1px solid var(--sx-line); border-radius:14px; }
.ss-script .rows .none { padding:14px 10px; color:var(--sx-faint); font-size:12px; }
.ss-script .rows .sep { height:1px; background:var(--sx-line); margin:3px 8px; flex:none; }
.ss-script .rows button.scn { display:grid; grid-template-columns:auto minmax(0, 1fr) auto; align-items:center; gap:10px; width:100%;
  text-align:left; cursor:pointer; font:inherit; flex:none; background:transparent !important; border:1px solid transparent !important;
  border-radius:10px !important; padding:7px 8px !important; color:var(--sx-text) !important; font-weight:400 !important; }
.ss-script .rows button.scn:hover:not(:disabled) { background:rgba(255,255,255,.05) !important; border-color:transparent !important; }
.ss-script .rows button.scn[aria-selected=true]:not(:disabled) { background:rgba(242,255,89,.08) !important; border-color:rgba(242,255,89,.32) !important; }
.ss-script .scn .num { min-width:34px; height:26px; padding:0 6px; border-radius:8px; display:grid; place-items:center;
  background:rgba(255,255,255,.07); font-weight:600; font-size:12px; font-variant-numeric:tabular-nums; color:var(--sx-text); }
.ss-script .scn[aria-selected=true] .num { background:var(--sx-accent); color:var(--sx-ink); }
.ss-script .scn .tx { min-width:0; display:flex; flex-direction:column; gap:1px; }
.ss-script .scn .hd { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-script .scn .sub { color:var(--sx-muted); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-script .scn .end { display:flex; align-items:center; gap:6px; }
.ss-script .pill { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:1px 7px; font-size:11px; line-height:16px;
  background:rgba(255,255,255,.07); color:var(--sx-muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ss-script .dot { width:7px; height:7px; border-radius:50%; background:var(--sx-accent); flex:none; }

/* Scene detail */
.ss-script-detail { display:flex; flex-direction:column; gap:14px; min-width:0; }
.ss-script-detail .top { display:flex; flex-direction:column; gap:8px; }
.ss-script-detail .kick { display:flex; align-items:center; gap:8px; }
.ss-script-detail .kick .nav { margin-left:auto; display:flex; gap:6px; }
.ss-script-detail h2.slug { font-size:24px; font-weight:600; line-height:1.18; letter-spacing:.005em; overflow-wrap:anywhere; }
.ss-script-detail h2.slug.title { text-transform:none; }
.ss-script .meta { display:flex; flex-wrap:wrap; gap:6px; }
.ss-script .tag { display:inline-flex; align-items:center; gap:6px; padding:3px 10px 3px 8px; border-radius:999px; font-size:12px;
  background:var(--sx-card); border:1px solid var(--sx-line); color:var(--sx-text); white-space:nowrap; max-width:100%; min-width:0; }
.ss-script .tag > .t { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ss-script .tag .ss-icon { color:var(--sx-muted); }
.ss-script .go { display:flex; gap:10px 12px; flex-wrap:wrap; align-items:center; margin-top:4px; }
.ss-script .go .hint { color:var(--sx-faint); font-size:12px; display:inline-flex; align-items:center; gap:6px; }
.ss-script .cols { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); gap:14px; align-items:start; }
.ss-script .stack { display:flex; flex-direction:column; gap:14px; min-width:0; }
.ss-script .story p + p { margin-top:6px; }
.ss-script .story .syn { font-size:14px; }
.ss-script .story .out { color:var(--sx-muted); }

.ss-script .bd { display:flex; flex-direction:column; gap:8px; }
.ss-script .bd-row { display:grid; grid-template-columns:112px minmax(0, 1fr); gap:10px; align-items:start; }
.ss-script .bd-row .k { display:flex; align-items:center; gap:7px; color:var(--sx-muted); font-size:12px; padding-top:3px; }
.ss-script .bd-row .k .ss-icon { color:var(--c); }
.ss-script .bd-row .v { display:flex; flex-wrap:wrap; gap:6px; min-width:0; }
.ss-script .chip { display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border-radius:999px; font-size:12px; line-height:18px;
  background:var(--cb); border:1px solid var(--cl); color:var(--sx-text); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-script .chip small { color:var(--sx-muted); font-size:11px; }

.ss-script textarea.notes { width:100%; min-height:110px; resize:vertical; font:inherit; line-height:1.5;
  background:rgba(0,0,0,.22) !important; color:var(--sx-text) !important; border:1px solid var(--sx-line) !important;
  border-radius:10px !important; padding:9px 11px !important; }
.ss-script textarea.notes:focus { border-color:var(--sx-line2) !important; }
.ss-script textarea.notes::placeholder { color:var(--sx-faint); }
.ss-script .booknotes { display:flex; flex-direction:column; gap:5px; margin-top:10px; }
.ss-script .booknotes .bn { border-left:3px solid var(--c); padding:3px 8px; background:rgba(255,255,255,.03); border-radius:0 6px 6px 0; font-size:12px; line-height:1.4; }
.ss-script .booknotes .bn b { display:block; font-size:11px; font-weight:600; color:var(--c); }
.ss-script .page .el.booked { box-shadow:-1.2ch 0 0 -0.95ch var(--c); position:relative; background:linear-gradient(90deg, rgba(242,255,89,0), rgba(242,255,89,.06)); }
.ss-script .page .el.booked::after { content:attr(data-notes); position:absolute; right:-2.6ch; top:0; font:600 10px/16px var(--ss-font, sans-serif); min-width:16px; height:16px; border-radius:8px; text-align:center; background:var(--c); color:#211927; }
.ss-script .saved { display:inline-flex; align-items:center; gap:4px; transition:opacity .3s; }
.ss-script .saved[data-on=false] { opacity:0; }

.ss-script .shots { display:flex; gap:10px; overflow-x:auto; padding:2px 2px 4px; }
.ss-script .shot { flex:0 0 168px; display:flex; flex-direction:column; gap:5px; min-width:0; text-align:left; font:inherit; color:var(--sx-text); }
.ss-script button.shot { cursor:pointer; background:transparent !important; border:0 !important; padding:0 !important; border-radius:10px !important;
  color:var(--sx-text) !important; font-weight:400 !important; display:flex !important; align-items:stretch !important; }
.ss-script button.shot:hover:not(:disabled) { background:transparent !important; border-color:transparent !important; }
.ss-script button.shot:hover:not(:disabled) .th { border-color:var(--sx-line2); }
.ss-script .shot .th { aspect-ratio:1.85; border-radius:9px; overflow:hidden; display:grid; place-items:center; color:var(--sx-faint);
  background:var(--sx-paper); border:1px solid var(--sx-line); }
.ss-script .shot .th img, .ss-script .shot .th canvas { width:100%; height:100%; object-fit:cover; display:block; }
.ss-script .shot .nm { font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:0 2px; }
.ss-script .shots button.newshot { flex:0 0 168px; aspect-ratio:1.85; display:flex !important; flex-direction:column; align-items:center;
  justify-content:center; gap:4px; cursor:pointer; font:inherit; font-size:12px; text-align:center; background:transparent !important;
  border:1.5px dashed var(--sx-line2) !important; border-radius:9px !important; color:var(--sx-muted) !important; padding:8px !important; font-weight:500 !important; }
.ss-script .shots button.newshot:hover:not(:disabled) { border-color:var(--sx-accent) !important; color:var(--sx-text) !important; background:rgba(242,255,89,.05) !important; }
.ss-script .shots button.newshot.wide { flex:1 1 auto; aspect-ratio:auto; min-height:72px; flex-direction:row; gap:8px; }

/* The scene's pages, in screenplay format (read-only). */
.ss-script .page { background:var(--sx-paper); border:1px solid var(--sx-line); border-radius:12px; padding:22px 24px 26px;
  max-height:720px; overflow:auto; font:12.5px/1.5 "Courier Prime", "Courier New", Courier, monospace; color:#ece8e1; letter-spacing:0; }
.ss-script .page:focus-visible { outline:2px solid var(--sx-accent); outline-offset:2px; }
.ss-script .page .in { max-width:61ch; margin:0 auto; }
.ss-script .page .el { white-space:pre-wrap; overflow-wrap:break-word; }
.ss-script .page .slug { display:flex; gap:2ch; font-weight:700; text-transform:uppercase; }
.ss-script .page .slug .n { flex:none; font-weight:400; color:var(--sx-muted); }
.ss-script .page .slug .t { flex:1; min-width:0; }
.ss-script .page .action, .ss-script .page .character, .ss-script .page .transition, .ss-script .page .shot-el,
.ss-script .page .centered, .ss-script .page .note, .ss-script .page .lyric-start { margin-top:1.5em; }
.ss-script .page .character { margin-left:min(22ch, 36%); text-transform:uppercase; }
.ss-script .page .parenthetical { margin-left:min(16ch, 26%); max-width:min(26ch, 60%); }
.ss-script .page .dialogue, .ss-script .page .lyric { margin-left:min(10ch, 16%); max-width:min(35ch, 80%); }
.ss-script .page .lyric { font-style:italic; }
.ss-script .page .transition { text-align:right; text-transform:uppercase; }
.ss-script .page .shot-el { text-transform:uppercase; }
.ss-script .page .centered { text-align:center; }
.ss-script .page .note { color:var(--sx-muted); font-style:italic; border-left:2px solid var(--sx-line2); padding-left:1ch; }

/* Whole-script overview */
.ss-script .cast { display:flex; flex-wrap:wrap; gap:6px; }
.ss-script .outline { display:flex; flex-direction:column; gap:6px; }
.ss-script .outline button.oi { display:grid !important; grid-template-columns:auto minmax(0, 1fr) auto; gap:4px 12px; align-items:start; width:100%;
  text-align:left; cursor:pointer; font:inherit; background:rgba(255,255,255,.025) !important; border:1px solid var(--sx-line) !important;
  border-radius:12px !important; padding:10px 12px !important; color:var(--sx-text) !important; font-weight:400 !important; }
.ss-script .outline button.oi:hover:not(:disabled) { background:rgba(255,255,255,.055) !important; border-color:var(--sx-line2) !important; }
.ss-script .oi .num { min-width:34px; height:26px; padding:0 6px; border-radius:8px; display:grid; place-items:center;
  background:rgba(255,255,255,.07); font-weight:600; font-size:12px; font-variant-numeric:tabular-nums; }
.ss-script .oi .tx { min-width:0; display:flex; flex-direction:column; gap:3px; }
.ss-script .oi .hd { font-weight:600; font-size:12.5px; letter-spacing:.01em; }
.ss-script .oi .ln { color:var(--sx-muted); }
.ss-script .oi .end { display:flex; flex-direction:column; align-items:flex-end; gap:4px; color:var(--sx-faint); font-size:12px; white-space:nowrap; }

/* Drag-and-drop and busy overlays */
.ss-script .ov { position:absolute; inset:0; z-index:5; display:none; gap:12px; padding:12px; border-radius:16px;
  background:rgba(33,25,39,.88); backdrop-filter:blur(6px); }
.ss-script.dragging .ov.drag, .ss-script.busy .ov.wait { display:flex; }
.ss-script .ov .zone { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; text-align:center;
  padding:16px; border:2px dashed var(--sx-line2); border-radius:16px; color:var(--sx-muted); transition:border-color .1s, background .1s; }
.ss-script .ov .zone * { pointer-events:none; }
.ss-script .ov .zone b { font-size:17px; color:var(--sx-text); font-weight:600; }
.ss-script .ov .zone.hot { border-color:var(--sx-accent); background:rgba(242,255,89,.06); color:var(--sx-text); }
.ss-script .ov .zone .ss-icon { color:var(--sx-accent); }
.ss-script .ov.wait { align-items:center; justify-content:center; flex-direction:column; color:var(--sx-muted); }
.ss-script .spin { width:28px; height:28px; border-radius:50%; border:2.5px solid var(--sx-line2); border-top-color:var(--sx-accent);
  animation:ss-script-spin .8s linear infinite; }
@keyframes ss-script-spin { to { transform:rotate(360deg); } }

/* Narrow: the panel (not the window) decides, since the App can be docked small. */
@container ss-script (max-width: 1080px) { .ss-script .cols { grid-template-columns:minmax(0, 1fr); } }
@container ss-script (max-width: 720px) {
  .ss-script-body { grid-template-columns:minmax(0, 1fr); }
  .ss-script .rows { max-height:236px; }
  .ss-script-detail h2.slug { font-size:20px; }
  .ss-script .ov.drag { flex-direction:column; }
}
@container ss-script (max-width: 480px) {
  .ss-script .bd-row { grid-template-columns:minmax(0, 1fr); gap:4px; }
  .ss-script .bd-row .k { padding-top:0; }
  .ss-script .page { padding:16px 14px 20px; font-size:12px; }
  .ss-script .shot, .ss-script .shots button.newshot { flex-basis:140px; }
  .ss-script-head .acts { width:100%; }
  .ss-script-head .acts .btn { flex:1 1 0; }
}

/* Scene switcher: a macOS-style pop-up button for every step header. */
/* A nowrap heading makes the shrink-to-fit wrapper (and any flex item holding it) as wide as the whole heading, and a %
   cap resolves against that same width. So the heading itself carries an absolute cap (max-width also caps its
   intrinsic size) and the wrapper a viewport one; the menu is absolute inside, so no overflow:hidden here. */
.ss-scsw { position:relative; display:inline-flex; min-width:0; max-width:min(460px, 100%, calc(100vw - 32px)); vertical-align:middle; }
.ss-scsw[hidden] { display:none !important; }
.ss-scsw button.ss-scsw-btn { display:inline-flex; align-items:center; gap:8px; min-width:0; max-width:100%; cursor:pointer;
  font:inherit; background:var(--sx-raised) !important; color:var(--sx-text) !important; border:1px solid var(--sx-line) !important;
  border-radius:999px !important; padding:4px 10px 4px 5px !important; font-weight:500 !important; }
.ss-scsw button.ss-scsw-btn:hover:not(:disabled), .ss-scsw button.ss-scsw-btn[aria-expanded=true]:not(:disabled) {
  background:#342c3b !important; border-color:var(--sx-line2) !important; }
.ss-scsw .k { flex:none; display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:2px 9px; font-size:11.5px; font-weight:700;
  background:var(--sx-accent); color:var(--sx-ink); letter-spacing:.02em; }
.ss-scsw .k.all { background:rgba(255,255,255,.09); color:var(--sx-text); font-weight:600; }
.ss-scsw .hd { min-width:0; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-scsw button.ss-scsw-btn > .hd { max-width:min(320px, calc(100vw - 180px)); }
.ss-scsw .chev { color:var(--sx-muted); margin-left:2px; }
.ss-scsw .muted { color:var(--sx-muted); font-weight:400; }
.ss-scsw-menu { position:absolute; top:calc(100% + 6px); left:0; z-index:60; min-width:300px; width:max-content; max-width:min(460px, 92vw);
  max-height:min(60vh, 440px); overflow:auto; padding:5px; border-radius:12px; background:rgba(42,35,48,.97); backdrop-filter:blur(14px);
  border:1px solid var(--sx-line2); box-shadow:0 18px 44px rgba(0,0,0,.5); }
.ss-scsw-menu[hidden] { display:none; }
.ss-scsw-menu.right { left:auto; right:0; }
.ss-scsw-menu .cap { padding:6px 10px 4px; }
.ss-scsw-menu .sep { height:1px; background:var(--sx-line); margin:4px 6px; }
.ss-scsw-menu button.opt { display:grid; grid-template-columns:16px auto minmax(0, 1fr) auto; gap:9px; align-items:center; width:100%;
  text-align:left; cursor:pointer; font:inherit; background:transparent !important; border:0 !important; border-radius:8px !important;
  padding:6px 9px 6px 7px !important; color:var(--sx-text) !important; font-weight:400 !important; }
.ss-scsw-menu button.opt:hover:not(:disabled), .ss-scsw-menu button.opt:focus-visible:not(:disabled) { background:rgba(242,255,89,.13) !important; outline:none !important; }
.ss-scsw-menu .opt .ck { color:var(--sx-accent); visibility:hidden; }
.ss-scsw-menu .opt[aria-selected=true] .ck { visibility:visible; }
.ss-scsw-menu .opt .n { min-width:32px; text-align:center; font-weight:600; font-size:11.5px; border-radius:6px; padding:1px 5px;
  background:rgba(255,255,255,.08); font-variant-numeric:tabular-nums; display:inline-flex; justify-content:center; }
.ss-scsw-menu .opt .hd { font-size:12.5px; }
.ss-scsw-menu .opt .c { color:var(--sx-muted); font-size:11.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.ss-scsw-menu .lbl { text-transform:uppercase; letter-spacing:.08em; font-size:10.5px; font-weight:600; color:var(--sx-faint); }
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("ss-script-css")) return;
  document.head.append(h("style", { id: "ss-script-css" }, STYLE));
}

// The Director's Book note colours (web/book/model.mjs CATEGORIES), for notes shown here.
const BOOK_CAT = { subtext: "#c9a2ff", performance: "#ff9db0", blocking: "#7ec8ff", camera: "#f2ff59", lighting: "#ffc46b", sound: "#7ee2a8", continuity: "#b9b4ad" };

// ------------------------------------------------------------------ ScriptPanel

export class ScriptPanel {
  constructor(container, opts = {}) {
    const noop = () => {};
    this.o = { getScript: () => null, setScript: noop, getShots: () => [], onBuildScene: noop, onNewShot: noop, onSelectScene: noop,
      onStatus: noop, onOpenShot: null, onOpenScriptSync: null, hasTakes: null, sample: null, ...opts };
    this.current = null;      // scene id; null = the whole-script overview
    this.query = "";
    this._pending = null;     // notes waiting for the debounce: {id, value}
    this._banner = null;      // {kind: 'err'|'ask', text, yes?, yesLabel?}
    this._depth = 0;
    injectCss();
    this.el = h("section", { class: "ss-script", "aria-label": "Script" });
    guard(this.el);
    this.file = h("input", { type: "file", accept: ACCEPT, hidden: true, tabindex: "-1", "aria-hidden": "true" });
    this.file.addEventListener("change", () => { const f = this.file.files?.[0]; if (f) this._import(f, this._mode || "replace"); });
    this.main = h("div", { style: "display:contents" });
    this.drag = h("div", { class: "ov drag", "aria-hidden": "true" });
    this.wait = h("div", { class: "ov wait", role: "status", "aria-live": "polite" }, h("div", { class: "spin" }), h("span", {}, "Reading your script…"));
    this.el.append(this.file, this.main, this.drag, this.wait);
    this._dnd();
    container.append(this.el);
    this.render();
  }

  // ---------------------------------------------------------------- public

  /** Rebuild from getScript() / getShots(). Call after the host changes either. */
  render() {
    if (this._writing) return;   // the host re-rendering from inside our own setScript (notes autosave) would steal focus
    const s = this._script();
    this.el.classList.toggle("is-empty", !s);
    if (!s) { this.main.replaceChildren(this._empty()); this.listEl = this.detailEl = null; return; }
    if (this.current && !s.scenes.some((x) => x.id === this.current)) this.current = null;
    this.listEl = h("div", { class: "rows", role: "listbox", "aria-label": "Scenes" });
    this.listEl.addEventListener("keydown", (e) => this._listKeys(e));
    this.detailEl = h("article", { class: "ss-script-detail" });
    const find = h("label", { class: "find" }, svg("search", 15),
      this.findInput = h("input", { type: "search", placeholder: "Find a scene or character", "aria-label": "Filter scenes by heading or character",
        value: this.query, on: { input: (e) => { this.query = e.target.value; this._renderList(); },
          keydown: (e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); this.listEl.querySelector("button.scn")?.focus(); }
            if (e.key === "Escape" && this.query) { e.stopPropagation(); this.query = e.target.value = ""; this._renderList(); }
          } } }));
    this.main.replaceChildren(this._header(s), ...(this._banner ? [this._bannerEl()] : []),
      h("div", { class: "ss-script-body" }, h("aside", { class: "ss-script-list", "aria-label": "Scene list" }, find, this.listEl), this.detailEl));
    this._renderList();
    this._renderDetail();
  }

  /** Show a scene (null = whole script). Tells the host through onSelectScene when it changes. */
  selectScene(id, { focus = false } = {}) {
    id = id || null;
    const s = this._script();
    if (id && !s?.scenes.some((x) => x.id === id)) id = null;
    const changed = id !== this.current;
    this._flushNotes();
    this.current = id;
    if (this.listEl) {
      for (const b of this.listEl.querySelectorAll("button.scn")) {
        const on = (b.dataset.id || null) === id;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus({ preventScroll: true });
        // Selected from anywhere (switcher, host, ?scene=): bring the row into the list's view, scrolling only the list.
        if (on) scrollRowIntoList(this.listEl, b);
      }
      if (changed) this._renderDetail();
    }
    if (changed) this.o.onSelectScene(id);
  }

  dispose() {
    this._flushNotes();
    clearTimeout(this._savedT);
    this.el.remove();
  }

  // ---------------------------------------------------------------- data

  _script() {
    const s = this.o.getScript();
    return s && Array.isArray(s.scenes) ? s : null;
  }

  _shots() {
    try { return this.o.getShots() || []; } catch { return []; }
  }

  /** reason: 'notes' | 'revise' | 'replace' | 'sample', so the host knows whether scene ids still mean the same scenes. */
  _write(script, reason) {
    this._writing = true;
    try { this.o.setScript(script, { reason }); } finally { this._writing = false; }
  }

  _pick(mode) {
    this._flushNotes();
    this._mode = mode;
    this.file.value = "";
    this.file.click();
  }

  async _import(file, mode) {
    this._banner = null;
    this.el.classList.add("busy");
    this.wait.lastChild.textContent = `Reading ${file.name}…`;
    this.o.onStatus(`Reading ${file.name}…`);
    // A note still waiting on its debounce (a drop does not blur the textarea) goes into the script before the old draft
    // is read, or the merge below would be built from a script without it.
    this._flushNotes();
    try {
      const next = await importScriptFile(file);
      if (!next?.scenes?.length) throw new Error("no scene headings found. Scenes start with INT. or EXT.");
      this._flushNotes();  // typed while the file was being read
      const old = this._script();
      let out = next;
      if (mode === "revise" && old) out = (typeof parse.mergeNotes === "function" ? parse.mergeNotes(old, next) : carryNotes(old, next)) || next;
      this._write(out, mode === "revise" && old ? "revise" : "replace");
      if (mode !== "revise" || !out.scenes.some((x) => x.id === this.current)) this.selectScene(null);
      this.query = "";
      const n = out.scenes.length, kept = out.scenes.filter((x) => x.notes?.trim()).length;
      this.o.onStatus(mode === "revise"
        ? `Revised draft in: ${plural(n, "scene")}${kept ? `, notes kept on ${plural(kept, "scene")}` : ""}.`
        : `“${out.title || file.name}” is in: ${plural(n, "scene")}, about ${plural(Math.max(1, Math.round(out.page_count_est || 1)), "page")}.`);
    } catch (e) {
      const msg = `Couldn't read ${file.name}: ${e?.message || e}`;
      this._banner = { kind: "err", text: msg };
      this.o.onStatus(msg);
    } finally {
      this.el.classList.remove("busy");
      this.render();
    }
  }

  // A host callback failed: say so inline and through onStatus, never as an unhandled rejection.
  _fail(what, e) {
    const text = `${what}: ${e?.message || e || "unknown error"}`;
    this._banner = { kind: "err", text };
    this.o.onStatus(text);
    this.render();
  }

  _notesCount(s = this._script()) {
    return (s?.scenes || []).filter((x) => x.notes?.trim()).length;
  }

  // Replacing the script drops the notes, so ask inline first (no confirm(): it does not work in the App demo).
  _replace() {
    const n = this._notesCount();
    if (!n) return this._pick("replace");
    this._banner = { kind: "ask", text: `A new script starts fresh: your notes on ${plural(n, "scene")} won't come along. To keep them, re-import it as a revised draft.`,
      yes: () => this._pick("replace"), yesLabel: "Choose new script…", alt: () => this._pick("revise"), altLabel: "Re-import as revised draft…" };
    this.render();
  }

  _flushNotes() {
    clearTimeout(this._noteT);
    const p = this._pending;
    if (!p) return;
    this._pending = null;
    const s = this._script();
    const sc = s?.scenes.find((x) => x.id === p.id);
    if (!sc || (sc.notes || "") === p.value) return;
    this._write({ ...s, scenes: s.scenes.map((x) => (x.id === p.id ? { ...x, notes: p.value } : x)) }, "notes");
    const row = this.listEl?.querySelector(`button.scn[data-id="${cssEsc(p.id)}"]`);
    if (row) this._rowEnd(row, { ...sc, notes: p.value });
    if (this._savedEl?.isConnected) {
      this._savedEl.dataset.on = "true";
      clearTimeout(this._savedT);
      this._savedT = setTimeout(() => { if (this._savedEl) this._savedEl.dataset.on = "false"; }, 1600);
    }
  }

  // ---------------------------------------------------------------- drag and drop

  _dnd() {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    const zone = (mode, ic, title, sub) => h("div", { class: "zone", "data-mode": mode }, svg(ic, 26), h("b", {}, title), h("span", {}, sub));
    const hot = (e) => e.target.closest?.(".zone");
    this.el.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (this._depth++ === 0) {
        const s = this._script(), n = this._notesCount(s);
        this.drag.replaceChildren(...(s
          ? [zone("revise", "refresh", "Revised draft", n ? `Keeps your notes on ${plural(n, "scene")}` : "Matches scenes by number and keeps your notes"),
            zone("replace", "upload", "New script", n ? `Starts fresh: notes on ${plural(n, "scene")} are left behind` : "Replaces the current script")]
          : [zone("replace", "upload", "Drop to bring in your script", "Fountain, Final Draft (.fdx), PDF or plain text")]));
        this.el.classList.add("dragging");
      }
    });
    this.el.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const z = hot(e);
      for (const x of this.drag.children) x.classList.toggle("hot", x === z || this.drag.children.length === 1);
    });
    this.el.addEventListener("dragleave", () => { if (--this._depth <= 0) this._endDrag(); });
    this.el.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this._flushNotes();
      const z = hot(e), f = e.dataTransfer.files?.[0];
      this._endDrag();
      if (f) this._import(f, z?.dataset.mode || (this._script() ? "revise" : "replace"));
    });
  }

  _endDrag() {
    this._depth = 0;
    this.el.classList.remove("dragging");
  }

  // ---------------------------------------------------------------- views

  _empty() {
    const art = h("div", { class: "art" });
    art.innerHTML = PAGE_ART;
    const kids = [art, h("h3", {}, "Bring in your script"), h("p", { class: "fmts" }, "Fountain, Final Draft (.fdx), PDF or plain text"),
      h("div", { class: "acts" },
        h("button", { type: "button", class: "btn primary", "aria-label": "Choose a script file", on: { click: () => this._pick("replace") } }, svg("upload", 15), "Choose file…"),
        this.o.sample ? h("button", { type: "button", class: "btn", title: "Load a short sample screenplay to look around",
          on: { click: () => { this._write(structuredClone(this.o.sample), "sample"); this.render(); this.o.onStatus("Sample script loaded."); } } }, svg("page", 15), "Try the sample script") : null),
      h("p", { class: "fine" }, "Or drop the file anywhere here. Soundstage reads your pages scene by scene; it never changes them.")];
    if (this._banner) kids.push(this._bannerEl());
    return h("div", { class: "ss-script-empty" }, h("div", { class: "drop" }, ...kids));
  }

  _header(s) {
    const pages = Math.max(1, Math.round(s.page_count_est || 0) || Math.ceil(s.scenes.reduce((a, x) => a + (x.eighths || 0), 0) / 8));
    const by = [s.author ? `by ${s.author}` : "", plural(s.scenes.length, "scene"), `about ${plural(pages, "page")}`, s.source_name || ""].filter(Boolean).join(" · ");
    return h("header", { class: "ss-script-head" },
      h("div", { class: "ttl" }, h("div", { class: "badge" }, svg("page", 20)),
        h("div", { class: "tx" }, h("h2", { title: s.title || "" }, s.title || s.source_name || "Untitled script"), h("span", { class: "by", title: by }, by))),
      h("div", { class: "acts" },
        this.o.onOpenBook ? h("button", { type: "button", class: "btn", "data-act": "book", title: "The Director's Book: a page per scene (intent, lighting, camera plan, floor plan, storyboard, your notes), as a PDF binder",
          on: { click: () => this.o.onOpenBook(this.current ? s.scenes.find((x) => x.id === this.current) || null : null) } }, svg("page", 15), "Director's Book") : null,
        h("button", { type: "button", class: "btn", title: "Bring in a new version of this script: scenes are matched by number, your notes and shot links carry over",
          on: { click: () => this._pick("revise") } }, svg("refresh", 15), "Re-import revised draft…"),
        h("button", { type: "button", class: "btn", title: "Bring in a different script", on: { click: () => this._replace() } }, svg("upload", 15), "Replace script…")));
  }

  _bannerEl() {
    const b = this._banner;
    const close = () => { this._banner = null; this.render(); };
    return h("div", { class: `banner ${b.kind === "err" ? "err" : ""}`, role: b.kind === "err" ? "alert" : "status" },
      h("span", { class: "msg" }, b.text),
      b.alt ? h("button", { type: "button", class: "btn", on: { click: () => { this._banner = null; b.alt(); this.render(); } } }, b.altLabel) : null,
      b.yes ? h("button", { type: "button", class: "btn", on: { click: () => { this._banner = null; b.yes(); this.render(); } } }, b.yesLabel) : null,
      h("button", { type: "button", class: "btn", on: { click: close } }, b.yes ? "Cancel" : "OK"));
  }

  _renderList() {
    const s = this._script();
    if (!s || !this.listEl) return;
    const counts = shotCounts(this._shots());
    const scenes = filterScenes(s.scenes, this.query);
    const kids = [];
    if (!this.query) {
      const total = this._shots().length;
      kids.push(this._row({ id: null }, {
        num: svg("list", 15), hd: "Whole script", sub: `Outline · ${plural(s.scenes.length, "scene")}`, count: total,
        label: `Whole script outline, ${plural(s.scenes.length, "scene")}${total ? `, ${plural(total, "shot")}` : ""}` }));
      kids.push(h("div", { class: "sep", role: "presentation" }));
    }
    for (const sc of scenes) {
      const n = counts.get(sc.id) || 0;
      kids.push(this._row(sc, {
        num: sc.number, hd: niceText(sc.location) || niceText(sc.heading),
        sub: [sc.int_ext, sentence(sc.time), `${formatEighths(sc.eighths || 1)} pg`].filter(Boolean).join(" · "), count: n,
        label: `${sceneSummaryLine(sc)}${n ? `, ${plural(n, "shot")}` : ""}${sc.notes?.trim() ? ", has notes" : ""}` }));
    }
    if (!scenes.length) kids.push(h("div", { class: "none" }, `No scenes match “${this.query}”.`));
    this.listEl.replaceChildren(...kids);
    // Keep one row tabbable even when the selected scene is filtered out.
    const rows = [...this.listEl.querySelectorAll("button.scn")];
    if (rows.length && !rows.some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0;
  }

  _row(sc, { num, hd, sub, count, label }) {
    const on = (sc.id || null) === this.current;
    const b = h("button", { type: "button", class: "scn", role: "option", "aria-selected": String(on), tabindex: on ? "0" : "-1",
      "data-id": sc.id || "", "aria-label": label, title: sc.heading || "" ,
      on: { click: () => this.selectScene(sc.id || null) } },
      h("span", { class: "num" }, num), h("span", { class: "tx" }, h("span", { class: "hd" }, hd), h("span", { class: "sub" }, sub)),
      h("span", { class: "end" }));
    b.dataset.count = String(count || 0);
    this._rowEnd(b, sc);
    return b;
  }

  _rowEnd(b, sc) {
    const n = +b.dataset.count || 0;
    b.querySelector(".end").replaceChildren(
      ...(n ? [h("span", { class: "pill", title: plural(n, "shot") }, svg("clapperboard", 11), String(n))] : []),
      ...(sc.notes?.trim() ? [h("span", { class: "dot", title: "Has your notes" })] : []));
  }

  _listKeys(e) {
    const rows = [...this.listEl.querySelectorAll("button.scn")];
    if (!rows.length) return;
    let i = rows.indexOf(document.activeElement);
    if (i < 0) i = rows.findIndex((r) => r.getAttribute("aria-selected") === "true");
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1, PageDown: i + 8, PageUp: i - 8 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
    this.selectScene(r.dataset.id || null, { focus: true });
  }

  // Previous/Next keep focus on the nav button (so Enter steps again), or the other one at the first/last scene.
  _step(id, which) {
    this.selectScene(id);
    const nav = this.detailEl?.querySelector(".nav");
    const btn = nav?.querySelector(`[data-nav="${which}"]:not(:disabled)`) || nav?.querySelector("button:not(:disabled)");
    btn?.focus({ preventScroll: true });
  }

  _renderDetail() {
    const s = this._script();
    if (!s || !this.detailEl) return;
    this._flushNotes();
    const sc = this.current ? s.scenes.find((x) => x.id === this.current) : null;
    this.detailEl.replaceChildren(...(sc ? this._scene(s, sc) : this._overview(s)));
    this.detailEl.scrollTop = 0;
  }

  // The whole script: cast and a scene-by-scene outline (each one opens its scene).
  _overview(s) {
    const counts = shotCounts(this._shots());
    const shots = this._shots();
    const looseList = looseShots(s, shots);
    const loose = looseList.length;
    const orphanHead = new Map((s.orphans || []).map((o) => [o.id, o]));
    const chars = (s.characters || []).slice().sort((a, b) => (b.scenes?.length || 0) - (a.scenes?.length || 0) || (b.lines || 0) - (a.lines || 0));
    const cast = BREAKDOWN_CATEGORIES[0];
    const totalE = s.scenes.reduce((a, x) => a + (x.eighths || 0), 0);
    return [
      h("div", { class: "top" },
        h("div", { class: "kick" }, h("span", { class: "lbl" }, "Whole script")),
        h("h2", { class: "slug title" }, s.title || "Untitled script"),
        h("div", { class: "meta" },
          h("span", { class: "tag" }, svg("list", 14), plural(s.scenes.length, "scene")),
          h("span", { class: "tag", title: `${totalE} eighths` }, svg("page", 14), `${formatEighths(Math.max(1, totalE))} pages`),
          chars.length ? h("span", { class: "tag" }, svg("user", 14), plural(chars.length, "speaking part")) : null,
          h("span", { class: "tag" }, svg("clapperboard", 14), plural(shots.length, "shot"), loose ? h("span", { class: "muted" }, ` · ${loose} not in a scene`) : null))),
      chars.length ? h("section", { class: "card" }, h("header", {}, h("h4", { class: "lbl" }, svg("user", 13), "Cast")),
        h("div", { class: "cast" }, ...chars.map((c) => h("span", { class: "chip", style: chipStyle(cast.color),
          title: `${c.name}: ${plural(c.scenes?.length || 0, "scene")}, ${plural(c.lines || 0, "line")}` },
          niceText(c.name), h("small", {}, plural(c.scenes?.length || 0, "scene")))))) : null,
      // Shots in no scene of this draft: untagged, on a scene a revised draft cut (named from script.orphans), or left
      // from another script. They stay visible here instead of vanishing.
      loose ? h("section", { class: "card", "aria-label": "Shots not in a scene" },
        h("header", {}, h("h4", { class: "lbl" }, svg("clapperboard", 13), "Shots not in a scene"), h("span", { class: "aside" }, plural(loose, "shot"))),
        h("div", { class: "shots" }, ...looseList.map((x) => {
          const o = x.scene_id ? orphanHead.get(x.scene_id) : null;
          return this._shotTile(x, o ? `Cut: Sc ${o.number} ${o.heading}` : x.scene_id ? "Scene not in this script" : "No scene");
        }))) : null,
      h("section", { class: "card" }, h("header", {}, h("h4", { class: "lbl" }, svg("list", 13), "Outline"),
        h("span", { class: "aside" }, "Open a scene for its breakdown, pages and shots")),
        h("div", { class: "outline" }, ...s.scenes.map((sc) => {
          const n = counts.get(sc.id) || 0;
          return h("button", { type: "button", class: "oi", "aria-label": `Open ${sceneSummaryLine(sc)}`, on: { click: () => this.selectScene(sc.id, { focus: true }) } },
            h("span", { class: "num" }, sc.number),
            h("span", { class: "tx" }, h("span", { class: "hd" }, sc.heading), h("span", { class: "ln" }, sc.synopsis || sc.outline || "")),
            h("span", { class: "end" }, `${formatEighths(sc.eighths || 1)} pg`,
              n ? h("span", { class: "pill" }, svg("clapperboard", 11), String(n)) : null, sc.notes?.trim() ? h("span", { class: "dot", title: "Has your notes" }) : null));
        }))),
    ].filter(Boolean);
  }

  _scene(s, sc) {
    const i = s.scenes.indexOf(sc);
    const prev = s.scenes[i - 1], next = s.scenes[i + 1];
    const tk = timeKind(sc);
    const hint = sc.stage_hint || {};
    const stageBits = [SET_LABELS[hint.set] || "", hint.time_of_day || "", hint.weather || "",
      ...(hint.objects || []).slice(0, 4).map(kindLabel)].filter(Boolean);
    const build = h("button", { type: "button", class: "btn primary", title: "Ask the scene agent to block this scene on the 3D stage: set, time of day, cast and vehicles",
      on: { click: () => {
        let r;
        try { r = this.o.onBuildScene(sc, buildPromptForScene(sc)); } catch (e) { return this._fail(`Couldn't build scene ${sc.number}`, e); }
        if (r && typeof r.then === "function") {
          build.disabled = true;
          Promise.resolve(r).catch((e) => this._fail(`Couldn't build scene ${sc.number}`, e)).finally(() => { build.disabled = false; });
        }
      } } }, svg("sparkles", 15), "Build this scene on the stage");
    const shots = this._shots().filter((x) => x.scene_id === sc.id);
    return [
      h("div", { class: "top" },
        h("div", { class: "kick" }, h("span", { class: "lbl" }, `Scene ${sc.number} · ${i + 1} of ${s.scenes.length}`),
          h("span", { class: "nav" },
            h("button", { type: "button", class: "btn round", "data-nav": "prev", title: prev ? `Previous: ${sceneSummaryLine(prev)}` : "First scene", "aria-label": "Previous scene",
              disabled: !prev, on: { click: () => prev && this._step(prev.id, "prev") } }, svg("chevron-up", 15)),
            h("button", { type: "button", class: "btn round", "data-nav": "next", title: next ? `Next: ${sceneSummaryLine(next)}` : "Last scene", "aria-label": "Next scene",
              disabled: !next, on: { click: () => next && this._step(next.id, "next") } }, svg("chevron-down", 15)))),
        h("h2", { class: "slug" }, sc.heading),
        h("div", { class: "meta" },
          sc.int_ext ? h("span", { class: "tag" }, svg(sc.int_ext === "EXT" ? "tree" : "home", 14), IE_LABEL[sc.int_ext] || sc.int_ext) : null,
          sc.time || tk ? h("span", { class: "tag", title: sc.time || hint.time_of_day || "" }, svg(TIME_ICON[tk] || "clock", 14),
            h("span", { class: "t" }, sentence(sc.time) || sentence(hint.time_of_day))) : null,
          h("span", { class: "tag", title: `${sc.eighths || 1} eighths of a page` }, svg("page", 14), `${formatEighths(sc.eighths || 1)} pg`),
          h("span", { class: "tag", title: `Starts around page ${startPage(s, sc)} of ${Math.max(1, Math.round(s.page_count_est || 1))}` },
            svg("hash", 14), `p. ${startPage(s, sc)}`),
          (sc.characters || []).length ? h("span", { class: "tag", title: sc.characters.map(niceText).join(", ") }, svg("user", 14),
            h("span", { class: "t" }, sc.characters.slice(0, 4).map(niceText).join(", ") + (sc.characters.length > 4 ? ` +${sc.characters.length - 4}` : ""))) : null),
        h("div", { class: "go" }, build,
          this.o.onOpenBook ? h("button", { type: "button", class: "btn", "data-act": "book", title: "This scene's page in the Director's Book",
            on: { click: () => this.o.onOpenBook(sc) } }, svg("page", 15), "Book page") : null,
          this.o.onOpenScriptSync && this.o.hasTakes?.(sc) ? h("button", { type: "button", class: "btn", "data-act": "scriptsync",
            title: "ScriptSync (lined script): this scene's pages with a coverage line per setup. Click a line and that take plays from that moment",
            on: { click: () => this.o.onOpenScriptSync(sc) } }, svg("file-video-camera", 15), "Open ScriptSync for this scene") : null,
          stageBits.length ? h("span", { class: "hint", title: "What the scene agent will start from" }, svg("stage", 14), `Starts from: ${stageBits.join(" · ")}`) : null)),
      this._shotsCard(sc, shots),
      h("div", { class: "cols" },
        h("div", { class: "stack" }, this._storyCard(sc), this._notesCard(sc), this._breakdownCard(sc)),
        this._pageCard(sc)),
    ];
  }

  _shotsCard(sc, shots) {
    const add = (wide) => h("button", { type: "button", class: `newshot${wide ? " wide" : ""}`, "aria-label": `New shot in scene ${sc.number}`,
      on: { click: () => {
        let r;
        try { r = this.o.onNewShot(sc); } catch (e) { return this._fail(`Couldn't add a shot to scene ${sc.number}`, e); }
        Promise.resolve(r).then(() => { this._renderList(); this._renderDetail(); }, (e) => this._fail(`Couldn't add a shot to scene ${sc.number}`, e));
      } } },
      svg("plus", 16), wide ? "No shots yet. New shot in this scene" : "New shot in this scene");
    const tiles = shots.map((x) => this._shotTile(x));
    return h("section", { class: "card", "aria-label": `Shots in scene ${sc.number}` },
      h("header", {}, h("h4", { class: "lbl" }, svg("clapperboard", 13), "Shots in this scene"), h("span", { class: "aside" }, shots.length ? plural(shots.length, "shot") : "")),
      h("div", { class: "shots" }, ...tiles, add(!shots.length)));
  }

  _shotTile(x, caption = "") {
    const th = h("span", { class: "th" });
    let t = x.thumb;
    if (typeof t === "function") { try { t = t(x); } catch { t = null; } }  // the host's lazy render, once per tile
    if (typeof t === "string" && t) th.append(h("img", { src: t, alt: "", loading: "lazy", decoding: "async" }));
    else if (t && typeof t === "object" && "width" in t && typeof t.getContext === "function") th.append(thumbCanvas(t));
    else th.append(svg("clapperboard", 22));
    const kids = [th, h("span", { class: "nm", title: caption ? `${x.name || x.id} · ${caption}` : x.name || x.id }, x.name || x.id),
      caption ? h("span", { class: "nm faint" }, caption) : null];
    return this.o.onOpenShot
      ? h("button", { type: "button", class: "shot", title: `Open ${x.name || x.id}`, on: { click: () => this.o.onOpenShot(x) } }, ...kids)
      : h("figure", { class: "shot", style: "margin:0" }, ...kids);
  }

  _storyCard(sc) {
    const kids = [];
    if (sc.synopsis) kids.push(h("p", { class: "syn" }, sc.synopsis));
    if (sc.outline) kids.push(h("p", { class: sc.synopsis ? "out" : "syn" }, sc.outline));
    if (!kids.length) kids.push(h("p", { class: "faint" }, "No action lines in this scene."));
    return h("section", { class: "card story" }, h("header", {}, h("h4", { class: "lbl" }, svg("page", 13), sc.synopsis ? "Synopsis" : "Outline")), ...kids);
  }

  _breakdownCard(sc) {
    const bd = sc.breakdown || {};
    const rows = BREAKDOWN_CATEGORIES.map((c) => {
      const items = [...new Set((bd[c.key] || []).map(itemText).filter(Boolean))];
      if (!items.length) return null;
      return h("div", { class: "bd-row", style: `--c:${c.color}` },
        h("span", { class: "k" }, svg(c.icon, 14), c.label),
        h("span", { class: "v" }, ...items.map((t) => h("span", { class: "chip", style: chipStyle(c.color), title: `${c.label}: ${t}` }, c.key === "cast" ? niceText(t) : chipText(t)))));
    }).filter(Boolean);
    return h("section", { class: "card", "aria-label": "Breakdown" },
      h("header", {}, h("h4", { class: "lbl" }, svg("layers", 13), "Breakdown"), h("span", { class: "aside" }, "Picked out of the action lines")),
      rows.length ? h("div", { class: "bd" }, ...rows) : h("p", { class: "faint" }, "Nothing flagged in this scene's action lines."));
  }

  _notesCard(sc) {
    this._savedEl = h("span", { class: "saved aside", "data-on": "false", "aria-live": "polite" }, svg("check", 13), "Saved");
    const ta = h("textarea", { class: "notes", rows: "5", placeholder: "Your notes for this scene: tone, coverage, references…",
      "aria-label": `Director's notes for scene ${sc.number}`, spellcheck: "true" });
    ta.value = sc.notes || "";
    ta.addEventListener("input", () => {
      this._pending = { id: sc.id, value: ta.value };
      clearTimeout(this._noteT);
      this._noteT = setTimeout(() => this._flushNotes(), 600);
    });
    ta.addEventListener("blur", () => this._flushNotes());
    const filed = this._bookNotes(sc);
    return h("section", { class: "card" }, h("header", {}, h("h4", { class: "lbl" }, svg("pencil", 13), "Director's notes"), this._savedEl), ta,
      filed.length ? h("div", { class: "booknotes", "aria-label": "Notes filed from your Director's Book" },
        h("div", { class: "aside" }, `From your Director's Book (${filed.length})`),
        ...filed.map((n) => h("div", { class: "bn", style: `--c:${BOOK_CAT[n.category] || "#999"}`, title: n.why ? `Why here: ${n.why}` : "" },
          h("b", {}, `${n.category[0].toUpperCase()}${n.category.slice(1)}${n.character ? ` · ${niceText(n.character)}` : ""}${Number.isInteger(n.line) ? " · on a line" : ""}`), n.text))) : null);
  }

  /** Notes the Director's Book filed on this scene (Milestone 23; the host's bookNotes, else none). */
  _bookNotes(sc) {
    try { return (this.o.bookNotes?.(sc) || []).filter((n) => n && n.text); } catch { return []; }
  }

  _pageCard(sc) {
    const inner = h("div", { class: "in" },
      h("div", { class: "el slug" }, h("span", { class: "n" }, sc.number), h("span", { class: "t" }, sc.heading), h("span", { class: "n" }, sc.number)));
    let prev = null;
    const booked = this._bookNotes(sc).filter((n) => Number.isInteger(n.line));
    (sc.elements || []).forEach((e, i) => {
      const type = e.type === "shot" ? "shot-el" : e.type;
      const lyricStart = e.type === "lyric" && prev !== "lyric";
      const on = booked.filter((n) => n.line === i);
      const el = h("div", { class: `el ${type}${lyricStart ? " lyric-start" : ""}${on.length ? " booked" : ""}` }, e.text || "");
      if (on.length) {
        el.title = on.map((n) => `${n.category}: ${n.text}`).join("\n");
        el.style.setProperty("--c", BOOK_CAT[on[0].category] || "#f2ff59");
        el.dataset.notes = String(on.length);
      }
      inner.append(el);
      prev = e.type;
    });
    return h("section", { class: "card", "aria-label": `Scene ${sc.number} pages` },
      h("header", {}, h("h4", { class: "lbl" }, svg("page", 13), "The scene"), h("span", { class: "aside" }, "As written · read-only")),
      h("div", { class: "page", tabindex: "0", "aria-label": `Scene ${sc.number} text in screenplay format` }, inner));
  }
}

// A copy of the host's canvas at tile size (cover crop): the host may reuse its canvas for the next shot, and a full
// stage-resolution copy per tile is wasted memory.
function thumbCanvas(src) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const c = document.createElement("canvas");
  c.width = Math.round(185 * dpr); c.height = Math.round(100 * dpr);
  const sw = src.width || 1, sh = src.height || 1, k = Math.max(c.width / sw, c.height / sh);
  const w = c.width / k, hh = c.height / k;
  try { c.getContext("2d")?.drawImage(src, (sw - w) / 2, (sh - hh) / 2, w, hh, 0, 0, c.width, c.height); } catch { /* tainted or detached */ }
  return c;
}

function scrollRowIntoList(list, row) {
  if (!list || !row || list.scrollHeight <= list.clientHeight) return;
  const lr = list.getBoundingClientRect(), rr = row.getBoundingClientRect();
  if (rr.top < lr.top + 4) list.scrollTop -= lr.top + 4 - rr.top;
  else if (rr.bottom > lr.bottom - 4) list.scrollTop += rr.bottom - (lr.bottom - 4);
}

const cssEsc = (s) => (globalThis.CSS?.escape ? globalThis.CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
const chipStyle = (hex) => `--cb:${hexA(hex, 0.13)};--cl:${hexA(hex, 0.34)};--c:${hex}`;

// ------------------------------------------------------------------ SceneSwitcher

export class SceneSwitcher {
  constructor(container, { getScript = () => null, getShots = () => [], onSelect = () => {}, current = null } = {}) {
    injectCss();
    this.o = { getScript, getShots, onSelect };
    this.current = current || null;
    this.el = h("div", { class: "ss-scsw" });
    guard(this.el);
    this.btn = h("button", { type: "button", class: "ss-scsw-btn", "aria-haspopup": "listbox", "aria-expanded": "false" });
    this.menu = h("div", { class: "ss-scsw-menu", role: "listbox", "aria-label": "Scenes", hidden: true });
    this.btn.addEventListener("click", () => (this.menu.hidden ? this.open() : this.close()));
    this.btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); this.open(); } });
    this.menu.addEventListener("keydown", (e) => this._keys(e));
    this._outside = (e) => { if (!this.el.contains(e.target)) this.close(); };
    this.el.append(this.btn, this.menu);
    container.append(this.el);
    this.refresh();
  }

  setCurrent(id) {
    this.current = id || null;
    this.refresh();
  }

  /** Re-read the script and shots (call after either changes). Hidden while there is no script. */
  refresh() {
    const s = this.o.getScript();
    const scenes = s?.scenes || [];
    this.el.hidden = !scenes.length;
    const sc = scenes.find((x) => x.id === this.current) || null;
    if (!sc) this.current = null;
    this.btn.replaceChildren(
      sc ? h("span", { class: "k" }, `Scene ${sc.number}`) : h("span", { class: "k all" }, svg("list", 13), "All scenes"),
      sc ? h("span", { class: "hd" }, sc.heading) : h("span", { class: "hd muted" }, plural(scenes.length, "scene")),
      svg("updown", 14));
    this.btn.lastChild.classList.add("chev");
    this.btn.title = sc ? `${sceneSummaryLine(sc)}. Switch scene` : "Showing every scene's shots. Switch scene";
    this.btn.setAttribute("aria-label", sc ? `Scene ${sc.number}, ${sc.heading}. Switch scene` : "All scenes. Switch scene");
    if (!this.menu.hidden) this._fill();
  }

  open() {
    if (this.el.hidden) return;
    this._fill();
    this.menu.hidden = false;
    this.btn.setAttribute("aria-expanded", "true");
    // Open toward the room there is: right-align when the menu would run off the window.
    const r = this.btn.getBoundingClientRect();
    this.menu.classList.toggle("right", r.left + Math.max(300, this.menu.offsetWidth) > (window.innerWidth || 1e9) - 8);
    // Still past an edge on a narrow window: give up width, not visibility.
    this.menu.style.maxWidth = "";
    const m = this.menu.getBoundingClientRect(), vw = window.innerWidth || 1e9;
    const over = Math.max(0, 8 - m.left) + Math.max(0, m.right - (vw - 8));
    if (over > 0) this.menu.style.maxWidth = `${Math.max(200, Math.floor(m.width - over))}px`;
    document.addEventListener("pointerdown", this._outside, true);
    (this.menu.querySelector('[aria-selected="true"]') || this.menu.querySelector("button.opt"))?.focus();
  }

  close({ focus = false } = {}) {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this._outside, true);
    if (focus) this.btn.focus();
  }

  dispose() {
    this.close();
    this.el.remove();
  }

  _fill() {
    const s = this.o.getScript();
    let shots = [];
    try { shots = this.o.getShots() || []; } catch { /* host not ready */ }
    const counts = shotCounts(shots);
    const opt = (id, n, hd, c, label) => h("button", { type: "button", class: "opt", role: "option", "aria-selected": String((id || null) === this.current),
      "data-id": id || "", "aria-label": label, title: label, on: { click: () => this._pick(id || null) } },
      ck(), n, h("span", { class: "hd" }, hd), h("span", { class: "c" }, c));
    const ck = () => { const i = svg("check", 14); i.classList.add("ck"); return i; };
    const scenes = s?.scenes || [];
    this.menu.replaceChildren(
      opt(null, h("span", { class: "n" }, svg("list", 13)), "All scenes", shots.length ? plural(shots.length, "shot") : "",
        `All scenes${shots.length ? `, ${plural(shots.length, "shot")}` : ""}`),
      h("div", { class: "sep", role: "presentation" }),
      ...scenes.map((sc) => {
        const n = counts.get(sc.id) || 0;
        return opt(sc.id, h("span", { class: "n" }, sc.number), sc.heading, n ? plural(n, "shot") : "–",
          `${sceneSummaryLine(sc)}${n ? `, ${plural(n, "shot")}` : ", no shots yet"}`);
      }));
  }

  _pick(id) {
    const changed = id !== this.current;
    this.current = id;
    this.close({ focus: true });
    this.refresh();
    if (changed) this.o.onSelect(id);
  }

  _keys(e) {
    const opts = [...this.menu.querySelectorAll("button.opt")];
    const i = opts.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: opts.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      opts[(to + opts.length) % opts.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close({ focus: true });
    } else if (e.key === "Tab") {
      this.close();
    }
  }
}
