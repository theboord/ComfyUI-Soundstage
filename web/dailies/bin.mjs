// Dailies bin: one scene's setups and takes, laid out like an Avid bin. Three views on a segmented control:
//   Frame   a free-form thumbnail board (Avid's Frame view): drag cards anywhere, Arrange by script order / by setup /
//           tidy grid, thumbnail size, double-click opens the circled (else most finished) take, hover or Space shows
//           the takes (Tk 1..n, each openable and circle-able).
//   List    a sortable table (Setup, Name, Type, Takes, Circled, Kind, Duration, Coverage).
//   Script  the lined script (lined.mjs): the scene page with one coverage line per setup.
//
//   import { DailiesBin } from "./dailies/bin.mjs";
//   const bin = new DailiesBin(el, { getScene, getShots, getRenders, getLayout, setLayout, onOpenTake, onCircle, onStatus });
//   bin.refresh();   // after renders land, shots change or the scene switches
//
// Host:
//   getScene() -> the Script scene to show ({id, number, heading, elements, characters}); null = empty state.
//   getShots() -> all shots [{id, name, setup, scene_id, character?, subject?, slate?, coverage?}]; the bin shows the
//                 ones with scene_id === scene.id, in the order given (= setup letters 12, 12A, 12B...).
//   getRenders(shotId, shot) -> anything model.takesFor accepts (the Soundstage render map, or a take list).
//   getLayout() / setLayout(layout): the bin's own state, a plain JSON object the host stores per scene (or globally,
//                 keyed inside by shot id): {view, size, sort:{key,dir}, positions:{shotId:{x,y}}, circled:{shotId:takeId},
//                 coverage:{shotId:{from,to,offscreen}|null}}.
//   onOpenTake(shot, take, at?)  open a take in the viewer; `at` = {elementIndex, fraction, offset?} from the Script view.
//   onCircle(shot, take|null)    the circled take changed (null = uncircled); the bin also keeps it in layout.circled.
//   onStatus(msg)                one-line feedback.
// Optional: getCoverage(shot) / setCoverage(shotId, cov) to keep coverage outside the layout (default: layout.coverage,
// then shot.coverage, then the model's default).
// Optional scene bins (the Avid project window): getScenes() -> every script scene in order, getAllShots() -> every
// shot of every scene, onPickScene(sceneId) -> open that scene's bin. Each bin is named "SC 03 – what the scene is
// about" (model.sceneBinName; the description is written from the breakdown and editable inline) with its approval
// progress. Every take carries a review status (approval.mjs): badges on cards, takes and list rows, a status filter.
import { takesFor, heroTake, setupLabel, sceneShots, setupKind, SETUP_KIND_LABEL, KIND_LABEL, fmtDuration, coverageFor,
  binRows, sortRows, filterRows, arrangeByScript, arrangeBySetup, tidyGrid, fillPositions, columnsFor, snap, SNAP, CARD_W, CARD_H,
  CELL_W, CELL_H, GAP, setupColor, clipName, isOffscreen, STATUS_META, STATUS_FILTERS, statusCounts, progressLabel, filterByStatus,
  normStatus, sceneBinName, autoSceneDescription, padSceneNumber, sceneNumberWidth } from "./model.mjs";
import { approvalBadge, statusOf, onApprovalsChange, sceneDescription, setSceneDescription } from "./approval.mjs";
import { LinedScript } from "./lined.mjs";
import { icon as lucide } from "../ui/icons.mjs";

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
function guard(el) {
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  // The stage listens for arrows, Delete and Space globally: keys handled in the bin stay in the bin.
  el.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
}

const PATHS = {
  frame: '<rect x="3" y="4" width="7.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="7.5" height="6.5" rx="1.2"/><rect x="3" y="13.5" width="7.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="7.5" height="6.5" rx="1.2"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  lined: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 12h5"/><path d="M8.5 16h4"/><path d="M16.5 10.5v8"/>',
  arrange: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17.5h7"/><path d="m18 14.5 3 3-3 3"/>',
  star: '<path d="M12 2.8 14.8 8.6l6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  sortup: '<path d="m7 14 5-5 5 5"/>',
  sortdown: '<path d="m7 10 5 5 5-5"/>',
  small: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  bin: '<path d="M3 7.5h18"/><path d="M5 7.5v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-11"/><path d="M8.5 3.5h7l1.5 4h-10z"/><path d="M9.5 12h5"/>',
  folder: '<path d="M3 6.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};
function svg(name, size = 16, fill = false) {
  if (!PATHS[name]) return lucide(name, size);
  const e = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const attrs = { width: size, height: size, viewBox: "0 0 24 24", fill: fill ? "currentColor" : "none", stroke: "currentColor",
    "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "ss-icon" };
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = PATHS[name];
  return e;
}

const FONT = `"Soundstage Grotesk", "PP Formula", ui-sans-serif, system-ui, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

const STYLE = `
.ss-dailies { --dl-text:var(--ss-text, #f0efed); --dl-muted:var(--ss-muted, rgba(240,239,237,.56)); --dl-faint:var(--ss-faint, rgba(240,239,237,.36));
  --dl-line:var(--ss-line, rgba(255,255,255,.08)); --dl-line2:var(--ss-line-strong, rgba(255,255,255,.16)); --dl-card:var(--ss-card, rgba(255,255,255,.04));
  --dl-raised:var(--ss-raised, #2a2330); --dl-accent:var(--ss-accent, #f2ff59); --dl-ink:var(--ss-accent-ink, #211927);
  display:flex; flex-direction:column; gap:12px; min-width:0; min-height:0; color:var(--dl-text); font:13px/1.4 ${FONT}; letter-spacing:.005em; }
.ss-dailies *, .ss-dailies *::before, .ss-dailies *::after { box-sizing:border-box; }
.ss-dailies .ss-icon { flex:none; }
.ss-dailies button { font:inherit; cursor:pointer; }
.ss-dailies button:focus-visible, .ss-dailies input:focus-visible, .ss-dailies [tabindex]:focus-visible { outline:2px solid var(--dl-accent) !important; outline-offset:2px; }

/* Header */
.ss-dailies .dl-head { display:flex; align-items:center; gap:12px 16px; flex-wrap:wrap; }
.ss-dailies .dl-ttl { display:flex; align-items:center; gap:12px; min-width:0; flex:1 1 320px; }
.ss-dailies .dl-badge { flex:none; min-width:44px; height:40px; padding:0 9px; border-radius:11px; display:grid; place-items:center;
  background:var(--dl-accent); color:var(--dl-ink); font:700 17px/1 ${MONO}; letter-spacing:-.01em; }
.ss-dailies .dl-tx { min-width:0; display:flex; flex-direction:column; gap:2px; }
.ss-dailies .dl-tx .k { text-transform:uppercase; letter-spacing:.08em; font-size:10.5px; font-weight:600; color:var(--dl-muted); }
.ss-dailies .dl-tx h2 { margin:0; font-size:16px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dailies .dl-stats { display:flex; gap:6px; flex-wrap:wrap; }
.ss-dailies .dl-stat { display:inline-flex; align-items:baseline; gap:5px; padding:4px 10px; border-radius:999px; background:var(--dl-card);
  border:1px solid var(--dl-line); color:var(--dl-muted); font-size:12px; white-space:nowrap; }
.ss-dailies .dl-stat b { color:var(--dl-text); font-weight:600; font-size:13px; }
.ss-dailies .dl-stat.c b { color:var(--dl-accent); }

/* Segmented control */
.ss-dailies .dl-seg { display:inline-flex; gap:2px; padding:3px; border-radius:999px; background:var(--dl-card); border:1px solid var(--dl-line); }
.ss-dailies .dl-seg button { display:inline-flex; align-items:center; gap:6px; background:transparent !important; color:var(--dl-muted) !important;
  border:1px solid transparent !important; border-radius:999px !important; padding:5px 13px !important; font-weight:500 !important; }
.ss-dailies .dl-seg button:hover { color:var(--dl-text) !important; }
.ss-dailies .dl-seg button[aria-pressed=true] { background:var(--dl-raised) !important; color:var(--dl-text) !important; border-color:var(--dl-line2) !important; }
.ss-dailies .dl-seg button[aria-pressed=true] .ss-icon { color:var(--dl-accent); }

/* Toolbar */
.ss-dailies .dl-bar { display:flex; align-items:center; gap:8px 10px; flex-wrap:wrap; padding:7px 8px; border-radius:12px; background:var(--dl-card);
  border:1px solid var(--dl-line); }
.ss-dailies button.dl-btn { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; background:var(--dl-raised) !important;
  color:var(--dl-text) !important; border:1px solid var(--dl-line) !important; border-radius:999px !important; padding:5px 12px !important;
  font-weight:500 !important; transition:background .12s, border-color .12s; }
.ss-dailies button.dl-btn:hover { background:#342c3b !important; border-color:var(--dl-line2) !important; }
.ss-dailies .dl-find { display:flex; align-items:center; gap:7px; padding:0 10px; border-radius:999px; color:var(--dl-faint);
  background:rgba(0,0,0,.22); border:1px solid var(--dl-line); min-width:180px; flex:0 1 240px; }
.ss-dailies .dl-find:focus-within { border-color:var(--dl-accent); }
.ss-dailies .dl-find input { flex:1; min-width:0; background:transparent !important; border:0 !important; outline:none !important; color:var(--dl-text) !important;
  font:inherit; padding:6px 0 !important; box-shadow:none !important; }
.ss-dailies .dl-find input::placeholder { color:var(--dl-faint); }
.ss-dailies .dl-size { display:inline-flex; align-items:center; gap:7px; color:var(--dl-faint); }
.ss-dailies .dl-size input { width:110px; accent-color:var(--dl-accent); }
.ss-dailies .dl-grow { flex:1; }
.ss-dailies .dl-tip { color:var(--dl-faint); font-size:12px; }
.ss-dailies .dl-menuwrap { position:relative; }
.ss-dailies .dl-menu { position:absolute; z-index:40; top:calc(100% + 6px); left:0; min-width:230px; padding:5px; border-radius:12px;
  background:#2a2330; border:1px solid var(--dl-line2); box-shadow:0 18px 48px rgba(0,0,0,.55); display:flex; flex-direction:column; }
.ss-dailies .dl-menu[hidden] { display:none; }
.ss-dailies .dl-menu button { display:flex; flex-direction:column; align-items:flex-start; gap:1px; text-align:left; width:100%;
  background:transparent !important; border:0 !important; border-radius:8px !important; padding:7px 10px !important; color:var(--dl-text) !important; }
.ss-dailies .dl-menu button:hover, .ss-dailies .dl-menu button:focus-visible { background:rgba(242,255,89,.12) !important; outline:none !important; }
.ss-dailies .dl-menu button small { color:var(--dl-faint); font-size:11.5px; }

/* Frame view */
.ss-dailies .dl-body { position:relative; min-height:0; flex:1 1 auto; display:flex; flex-direction:column; }
.ss-dailies .dl-board { position:relative; overflow:auto; min-height:360px; flex:1 1 auto; border-radius:14px; border:1px solid var(--dl-line);
  background-color:#1a141e; background-image:radial-gradient(rgba(255,255,255,.055) 1px, transparent 1.2px);
  background-size:calc(var(--sz) * ${SNAP * 2}px) calc(var(--sz) * ${SNAP * 2}px); }
.ss-dailies .dl-plane { position:relative; }
.ss-dailies .dl-card { position:absolute; width:calc(var(--sz) * ${CARD_W}px); user-select:none; touch-action:none; border-radius:11px;
  background:#251e2a; border:1px solid var(--dl-line); box-shadow:0 2px 8px rgba(0,0,0,.25); transition:box-shadow .15s, border-color .15s; outline:none; }
.ss-dailies .dl-card:hover { border-color:var(--dl-line2); z-index:5; }
.ss-dailies .dl-card:focus-visible { outline:none !important; border-color:var(--dl-accent); box-shadow:0 0 0 2px var(--dl-accent); z-index:6; }
.ss-dailies .dl-card[data-sel=true] { border-color:rgba(242,255,89,.7); }
.ss-dailies .dl-card[data-drag] { z-index:20; box-shadow:0 22px 44px rgba(0,0,0,.55); cursor:grabbing; transition:none; }
.ss-dailies .dl-card[data-open] { z-index:21; }
.ss-dailies .dl-card[data-hot] { border-color:var(--c); box-shadow:0 0 0 2px var(--c); }
.ss-dailies .dl-th { position:relative; aspect-ratio:16/9; border-radius:10px 10px 0 0; overflow:hidden; background:#120e15; cursor:grab; }
.ss-dailies .dl-th img, .ss-dailies .dl-th video { width:100%; height:100%; object-fit:cover; display:block; pointer-events:none; }
.ss-dailies .dl-th .none { position:absolute; inset:0; display:grid; place-items:center; color:var(--dl-faint); font-size:12px; }
.ss-dailies .dl-slate { position:absolute; left:6px; top:6px; padding:2px 6px 2px 5px; border-radius:6px; display:inline-flex; align-items:center; gap:5px;
  background:rgba(18,14,21,.82); color:#fff; font:700 calc(var(--sz) * 12.5px)/1.15 ${MONO}; letter-spacing:.01em; backdrop-filter:blur(4px); }
.ss-dailies .dl-slate i { width:8px; height:8px; border-radius:2px; background:var(--c); }
.ss-dailies .dl-kind { position:absolute; right:6px; top:6px; padding:2px 6px; border-radius:5px; font:700 9.5px/1.3 ${FONT}; letter-spacing:.08em;
  text-transform:uppercase; background:rgba(18,14,21,.78); color:var(--dl-muted); }
.ss-dailies .dl-kind[data-k=final] { background:var(--dl-accent); color:var(--dl-ink); }
.ss-dailies .dl-kind[data-k=draft] { background:#cdb4ff; color:#211927; }
.ss-dailies .dl-kind[data-k=look] { background:rgba(128,188,255,.92); color:#10213a; }
.ss-dailies .dl-tk { position:absolute; left:6px; bottom:6px; display:inline-flex; align-items:center; gap:5px; padding:2px 7px 2px 3px; border-radius:999px;
  background:rgba(18,14,21,.8); color:#fff; font:600 11px/1.2 ${FONT}; }
.ss-dailies .dl-tk .ring { width:18px; height:18px; border-radius:50%; display:grid; place-items:center; font:700 10px/1 ${MONO}; }
.ss-dailies .dl-tk .ring[data-c=true] { border:1.6px solid var(--dl-accent); color:var(--dl-accent); }
.ss-dailies .dl-dur { position:absolute; right:6px; bottom:6px; padding:1px 6px; border-radius:5px; background:rgba(18,14,21,.8); color:#fff;
  font:600 11px/1.3 ${MONO}; }
.ss-dailies .dl-cap { padding:7px 9px 8px; display:flex; flex-direction:column; gap:3px; }
.ss-dailies .dl-cap .nm { font-weight:600; font-size:calc(var(--sz) * 12.5px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dailies .dl-cap .mt { display:flex; align-items:center; gap:6px; color:var(--dl-faint); font-size:11.5px; min-width:0; }
.ss-dailies .dl-cap .mt .ty { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dailies .dl-cap button.tk { margin-left:auto; display:inline-flex; align-items:center; gap:3px; background:transparent !important; border:0 !important;
  color:var(--dl-muted) !important; padding:1px 4px !important; border-radius:6px !important; font-size:11.5px; white-space:nowrap; }
.ss-dailies .dl-cap button.tk:hover { color:var(--dl-text) !important; background:rgba(255,255,255,.07) !important; }
.ss-dailies .dl-cap button.st { display:inline-grid; place-items:center; background:transparent !important; border:0 !important; padding:2px !important;
  color:var(--dl-faint) !important; border-radius:6px !important; }
.ss-dailies .dl-cap button.st[aria-pressed=true] { color:var(--dl-accent) !important; }
.ss-dailies .dl-cap button.st:hover { color:var(--dl-text) !important; }

/* Takes pop-over under a card */
.ss-dailies .dl-takes { position:absolute; left:-1px; right:-1px; top:calc(100% - 4px); padding:6px; border-radius:0 0 11px 11px; background:#2a2330;
  border:1px solid var(--dl-line2); border-top:0; box-shadow:0 18px 40px rgba(0,0,0,.5); display:flex; flex-direction:column; gap:2px;
  visibility:hidden; opacity:0; transform:translateY(-4px); transition:opacity .12s, transform .12s, visibility 0s linear .12s; }
.ss-dailies .dl-card:hover .dl-takes { transition-delay:.35s, .35s, .35s; }
.ss-dailies .dl-card:hover .dl-takes, .ss-dailies .dl-card[data-open] .dl-takes { visibility:visible; opacity:1; transform:none; }
.ss-dailies .dl-card[data-drag] .dl-takes { visibility:hidden; opacity:0; }
.ss-dailies .dl-card[data-open] .dl-takes { transition-delay:0s; }
.ss-dailies .dl-takes .row { display:grid; grid-template-columns:44px minmax(0, 1fr) auto; align-items:center; gap:8px; padding:3px; border-radius:7px; }
.ss-dailies .dl-takes .row:hover, .ss-dailies .dl-takes .row:focus-within { background:rgba(255,255,255,.06); }
.ss-dailies .dl-takes button.op { display:contents; background:none !important; border:0 !important; color:inherit !important; }
.ss-dailies .dl-takes .mini { width:44px; aspect-ratio:16/9; border-radius:4px; background:#120e15 center/cover no-repeat; }
.ss-dailies .dl-takes .lb { display:flex; flex-direction:column; min-width:0; text-align:left; }
.ss-dailies .dl-takes .lb b { font:700 11.5px/1.2 ${MONO}; }
.ss-dailies .dl-takes .lb span { color:var(--dl-faint); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dailies .dl-takes button.cir { width:24px; height:24px; display:grid; place-items:center; border-radius:50% !important; background:transparent !important;
  border:1.5px solid var(--dl-line2) !important; color:var(--dl-faint) !important; padding:0 !important; font:700 10px/1 ${MONO}; }
.ss-dailies .dl-takes button.cir:hover { border-color:var(--dl-accent) !important; color:var(--dl-text) !important; }
.ss-dailies .dl-takes button.cir[aria-pressed=true] { border-color:var(--dl-accent) !important; background:var(--dl-accent) !important; color:var(--dl-ink) !important; }
.ss-dailies .dl-takes .none { color:var(--dl-faint); font-size:12px; padding:6px; }

/* List view */
.ss-dailies .dl-listwrap { overflow:auto; min-height:300px; flex:1 1 auto; border-radius:14px; border:1px solid var(--dl-line); background:#1a141e; }
.ss-dailies table.dl-list { width:100%; border-collapse:separate; border-spacing:0; font-size:13px; }
.ss-dailies .dl-list th { position:sticky; top:0; z-index:1; background:#231c28; text-align:left; font-weight:600; padding:0; border-bottom:1px solid var(--dl-line2); }
.ss-dailies .dl-list th button { display:flex; align-items:center; gap:4px; width:100%; background:transparent !important; border:0 !important;
  color:var(--dl-muted) !important; padding:9px 10px !important; border-radius:0 !important; text-transform:uppercase; letter-spacing:.07em; font-size:10.5px; font-weight:600; }
.ss-dailies .dl-list th button:hover { color:var(--dl-text) !important; }
.ss-dailies .dl-list th[aria-sort=ascending] button, .ss-dailies .dl-list th[aria-sort=descending] button { color:var(--dl-accent) !important; }
.ss-dailies .dl-list th.nosort { padding:9px 10px; color:var(--dl-muted); text-transform:uppercase; letter-spacing:.07em; font-size:10.5px; }
.ss-dailies .dl-list td { padding:6px 10px; border-bottom:1px solid var(--dl-line); vertical-align:middle; white-space:nowrap; }
.ss-dailies .dl-list tbody tr { cursor:default; outline:none; }
.ss-dailies .dl-list tbody tr:hover td { background:rgba(255,255,255,.035); }
.ss-dailies .dl-list tbody tr:focus-visible td { background:rgba(242,255,89,.08); }
.ss-dailies .dl-list tbody tr:focus-visible td:first-child { box-shadow:inset 3px 0 0 var(--dl-accent); }
.ss-dailies .dl-list .th { width:72px; aspect-ratio:16/9; border-radius:5px; background:#120e15 center/cover no-repeat; box-shadow:0 0 0 1px var(--dl-line); }
.ss-dailies .dl-list .sl { display:inline-flex; align-items:center; gap:7px; font:700 13px/1 ${MONO}; }
.ss-dailies .dl-list .sl i { width:9px; height:9px; border-radius:2px; background:var(--c); }
.ss-dailies .dl-list .nm { max-width:280px; overflow:hidden; text-overflow:ellipsis; font-weight:500; }
.ss-dailies .dl-list .mut { color:var(--dl-muted); }
.ss-dailies .dl-list .num { font-variant-numeric:tabular-nums; }
.ss-dailies .dl-list .kd { display:inline-block; padding:1px 6px; border-radius:5px; font:700 9.5px/1.4 ${FONT}; letter-spacing:.08em; text-transform:uppercase;
  background:rgba(255,255,255,.08); color:var(--dl-muted); }
.ss-dailies .dl-list .kd[data-k=final] { background:var(--dl-accent); color:var(--dl-ink); }
.ss-dailies .dl-list .kd[data-k=draft] { background:#cdb4ff; color:#211927; }
.ss-dailies .dl-list .kd[data-k=look] { background:rgba(128,188,255,.92); color:#10213a; }
.ss-dailies .dl-list button.cr { display:inline-flex; align-items:center; gap:5px; background:transparent !important; border:0 !important; padding:2px 4px !important;
  color:var(--dl-faint) !important; border-radius:6px !important; font:600 12px/1 ${MONO}; }
.ss-dailies .dl-list button.cr[data-c=true] { color:var(--dl-accent) !important; }
.ss-dailies .dl-list button.cr:hover { background:rgba(255,255,255,.07) !important; }
.ss-dailies .dl-cov { position:relative; width:150px; height:10px; border-radius:3px; background:rgba(255,255,255,.06); overflow:hidden; }
.ss-dailies .dl-cov span { position:absolute; top:2px; bottom:2px; border-radius:2px; background:var(--c); }
.ss-dailies .dl-cov span.off { background:repeating-linear-gradient(135deg, var(--c) 0 2px, transparent 2px 4px); opacity:.85; }
.ss-dailies .dl-list .nocov { color:var(--dl-faint); font-size:12px; }

/* Script view / empty */
.ss-dailies .dl-scriptwrap { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
.ss-dailies .dl-empty { display:grid; place-items:center; min-height:300px; border:1.5px dashed var(--dl-line2); border-radius:16px; color:var(--dl-muted);
  text-align:center; padding:30px; }
.ss-dailies .dl-empty h3 { margin:0 0 4px; color:var(--dl-text); font-size:17px; font-weight:600; }

/* Scene bins (the project window) + approvals */
.ss-dailies.dl-hasrail { display:grid; grid-template-columns:minmax(220px, 280px) minmax(0, 1fr); align-items:stretch; gap:14px; }
.ss-dailies .dl-main { display:flex; flex-direction:column; gap:12px; min-width:0; min-height:0; }
.ss-dailies .dl-rail { display:flex; flex-direction:column; min-height:0; border-radius:14px; border:1px solid var(--dl-line); background:#1d1722; overflow:hidden; }
.ss-dailies .dl-rail .rh { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--dl-line); font:700 11.5px/1.2 ${MONO};
  letter-spacing:.06em; color:var(--dl-muted); }
.ss-dailies .dl-rail .rh small { margin-left:auto; font:500 11px/1 ${FONT}; letter-spacing:0; color:var(--dl-faint); }
.ss-dailies .dl-rail ol { list-style:none; margin:0; padding:6px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.ss-dailies .dl-rail li { position:relative; }
.ss-dailies .dl-rail button.bn { width:100%; display:grid; grid-template-columns:18px minmax(0, 1fr); gap:3px 9px; align-items:start; text-align:left;
  background:transparent !important; border:1px solid transparent !important; border-radius:10px !important; padding:7px 8px !important; color:var(--dl-text) !important; }
.ss-dailies .dl-rail button.bn:hover { background:rgba(255,255,255,.04) !important; }
.ss-dailies .dl-rail button.bn[aria-current=true] { background:var(--dl-raised) !important; border-color:var(--dl-line2) !important; }
.ss-dailies .dl-rail button.bn[aria-current=true] .ic { color:var(--dl-accent); }
.ss-dailies .dl-rail .ic { color:var(--dl-faint); margin-top:1px; }
.ss-dailies .dl-rail .nm { font:600 12.5px/1.3 ${FONT}; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.ss-dailies .dl-rail .nm b { font:700 12px/1.3 ${MONO}; margin-right:2px; }
.ss-dailies .dl-rail .pg { grid-column:2; display:flex; align-items:center; gap:7px; color:var(--dl-faint); font-size:11.5px; white-space:nowrap; }
.ss-dailies .dl-rail .pg .fx { color:#fcd34d; }
.ss-dailies .dl-prog { position:relative; flex:0 0 54px; height:5px; border-radius:3px; background:rgba(255,255,255,.08); overflow:hidden; display:flex; }
.ss-dailies .dl-prog i { display:block; height:100%; }
.ss-dailies .dl-prog i.a { background:#2fbf71; } .ss-dailies .dl-prog i.c { background:#f59e0b; } .ss-dailies .dl-prog i.r { background:#e5534b; }
.ss-dailies .dl-rail input.ren { grid-column:2; width:100%; font:600 12.5px/1.3 ${FONT}; color:var(--dl-text); background:rgba(0,0,0,.3); border:1px solid var(--dl-accent);
  border-radius:6px; padding:3px 6px; outline:none; }
.ss-dailies .dl-ttl .dl-tx { flex:1 1 auto; }
.ss-dailies .dl-desc { margin:0; width:auto; max-width:100%; min-width:0; font:600 16px/1.3 ${FONT}; color:var(--dl-text); background:transparent; border:1px solid transparent;
  border-radius:7px; padding:1px 5px; margin-left:-6px; text-overflow:ellipsis; }
.ss-dailies .dl-desc:hover { border-color:var(--dl-line2); }
.ss-dailies .dl-desc:focus { outline:none; border-color:var(--dl-accent); background:rgba(0,0,0,.25); }
.ss-dailies .dl-stat.ap b { color:#57d68d; }
.ss-dailies .dl-stat.fx b { color:#fcd34d; }
.ss-dailies .dl-sseg { display:inline-flex; gap:2px; padding:2px; border-radius:999px; background:rgba(0,0,0,.22); border:1px solid var(--dl-line); }
.ss-dailies .dl-sseg button { display:inline-flex; align-items:center; gap:5px; background:transparent !important; color:var(--dl-muted) !important; border:0 !important;
  border-radius:999px !important; padding:4px 10px !important; font-size:12px; font-weight:500 !important; white-space:nowrap; }
.ss-dailies .dl-sseg button small { color:var(--dl-faint); font-size:11px; }
.ss-dailies .dl-sseg button[aria-pressed=true] { background:var(--dl-raised) !important; color:var(--dl-text) !important; }
.ss-dailies .dl-sseg button[aria-pressed=true] small { color:var(--dl-accent); }
.ss-dailies .dl-card .dl-kind { right:34px; }
.ss-dailies .dl-card[data-status=approved] { border-color:rgba(87,214,141,.55); }
.ss-dailies .dl-card[data-status=changes] { border-color:rgba(252,211,77,.6); }
.ss-dailies .dl-card[data-status=rejected] .dl-th > img, .ss-dailies .dl-card[data-status=rejected] .dl-th > video { opacity:.45; filter:grayscale(.6); }
.ss-dailies .dl-cap .nt { color:#fcd34d; font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dailies .dl-takes .row { grid-template-columns:44px minmax(0, 1fr) auto auto; }
.ss-dailies .dl-takes .row .ss-appr { --ab:22px; }
.ss-dailies .dl-list .stc { display:inline-flex; align-items:center; gap:7px; max-width:240px; }
.ss-dailies .dl-list .stc span { overflow:hidden; text-overflow:ellipsis; }
.ss-dailies .dl-list .stc .nt { color:#fcd34d; font-size:12px; }
@media (max-width: 820px) { .ss-dailies.dl-hasrail { grid-template-columns:minmax(0, 1fr); } .ss-dailies .dl-rail ol { max-height:200px; } }
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("ss-dailies-css")) return;
  document.head.append(h("style", { id: "ss-dailies-css" }, STYLE));
}

const VIEWS = [["frame", "Frame", "frame"], ["list", "List", "list"], ["script", "ScriptSync", "lined"]];
const VIEW_TIPS = { frame: "Frame view: the setups as thumbnails you can arrange", list: "List view: one row per setup, sortable",
  script: "ScriptSync (lined script): the scene's pages with a coverage line per setup. Click a line and that take plays from that moment; Edit lining fixes the lines." };
const cssEsc = (v) => (globalThis.CSS?.escape ? globalThis.CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));
const cssUrl = (u) => String(u).replace(/["\\\n]/g, (c) => (c === "\n" ? "" : `\\${c}`));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export class DailiesBin {
  constructor(container, opts = {}) {
    const noop = () => {};
    this.o = { getScene: () => null, getShots: () => [], getRenders: () => null, getLayout: () => ({}), setLayout: noop,
      onOpenTake: noop, onCircle: noop, onStatus: noop, getCoverage: null, setCoverage: null, ...opts };
    injectCss();
    this.query = "";
    this.sel = null;
    this.el = h("section", { class: "ss-dailies", "aria-label": "Dailies bin" });
    guard(this.el);
    container.append(this.el);
    this._onDocDown = (e) => { if (this.menu && !this.menu.hidden && !e.target.closest?.(".dl-menuwrap")) this._closeMenu(); };
    document.addEventListener("pointerdown", this._onDocDown, true);
    this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this._sizePlane()) : null;
    // A status changed anywhere (here, ④ Frame, ⑤ Motion): redraw, keeping the scroll and the focus.
    this._offAppr = onApprovalsChange(() => { if (this.el.isConnected) { clearTimeout(this._ar); this._ar = setTimeout(() => this.softRefresh(), 30); } });
    this.refresh();
  }

  destroy() {
    document.removeEventListener("pointerdown", this._onDocDown, true);
    this._ro?.disconnect();
    this._offAppr?.();
    this.lined?.destroy();
    this.el.remove();
  }

  // ---------------------------------------------------------------- state

  get layout() {
    const l = this.o.getLayout() || {};
    return { view: "frame", size: 1, sort: { key: "label", dir: 1 }, positions: {}, circled: {}, coverage: {}, ...l };
  }

  _save(patch) {
    const next = { ...this.layout, ...patch };
    this.o.setLayout(next);
    return next;
  }

  _takes(shot) {
    return takesFor(shot, this.o.getRenders(shot.id, shot), { circled: this.layout.circled?.[shot.id] });
  }

  _coverage(shot) {
    const own = this.o.getCoverage ? this.o.getCoverage(shot) : (shot.id in (this.layout.coverage || {}) ? this.layout.coverage[shot.id] : undefined);
    return coverageFor(this.scene, shot, own);
  }

  /** Switch view: 'frame' | 'list' | 'script'. */
  setView(v) {
    if (!VIEWS.some(([k]) => k === v)) return;
    this._save({ view: v });
    this.refresh();
  }

  /** Re-read everything from the host and redraw. */
  refresh() {
    this.scene = this.o.getScene();
    const sc = this.scene;
    const shots = sceneShots(sc, this.o.getShots());
    const L = this.layout;
    this.rows = binRows(sc, this.o.getShots(), (shot) => this._takes(shot)).map((r) => {
      const st = statusOf(r.id, r.takes);
      return { ...r, coverage: this._coverage(r.shot), color: setupColor(r.idx), status: st.status, note: st.note, judged: st.take };
    });
    // ScriptSync keeps its player, selection and undo across refreshes (an edit saves the layout, which refreshes).
    if (L.view !== "script" || !sc) { this.lined?.destroy(); this.lined = null; this._linedWrap = null; }
    this._ro?.disconnect();
    // ScriptSync needs the width for the page and its player: the bins rail folds away (the scene picker stays).
    const rail = L.view === "script" ? null : this._rail();
    this.el.classList.toggle("dl-hasrail", !!rail);
    const put = (...kids) => this.el.replaceChildren(...(rail ? [rail, h("div", { class: "dl-main" }, ...kids)] : kids));
    if (!sc) {
      put(h("div", { class: "dl-empty" }, h("div", {}, h("h3", {}, "No scene picked"), "Pick a scene to see its dailies.")));
      return;
    }
    const nTakes = this.rows.reduce((a, r) => a + r.take_count, 0), nCirc = this.rows.filter((r) => r.circled).length;
    const seg = h("div", { class: "dl-seg", role: "group", "aria-label": "Bin view" },
      ...VIEWS.map(([k, label, ic]) => h("button", { type: "button", "aria-pressed": String(L.view === k), title: VIEW_TIPS[k], "data-view": k,
        on: { click: () => this.setView(k) } }, svg(ic, 15), label)));
    const counts = statusCounts(this.rows);
    const width = sceneNumberWidth(this.o.getScenes?.() || [sc]);
    const head = h("div", { class: "dl-head" },
      h("div", { class: "dl-ttl" }, h("div", { class: "dl-badge", title: `Scene ${sc.number}` }, padSceneNumber(sc.number || "?", width)),
        h("div", { class: "dl-tx" }, h("span", { class: "k", title: sc.heading || "" }, `SC ${padSceneNumber(sc.number || "?", width)} · ${sc.heading || "Untitled scene"}`),
          this._descInput(sc))),
      h("div", { class: "dl-stats" },
        h("span", { class: "dl-stat" }, h("b", {}, String(shots.length)), shots.length === 1 ? "setup" : "setups"),
        h("span", { class: "dl-stat" }, h("b", {}, String(nTakes)), nTakes === 1 ? "take" : "takes"),
        h("span", { class: "dl-stat c" }, h("b", {}, String(nCirc)), "circled"),
        h("span", { class: "dl-stat ap", title: progressLabel(sc, counts) }, h("b", {}, `${counts.approved}/${counts.total}`), "approved"),
        counts.changes ? h("span", { class: "dl-stat fx", title: "Takes that need changes" }, h("b", {}, String(counts.changes)), "to fix") : null),
      seg);
    let body;
    if (!shots.length) {
      body = h("div", { class: "dl-empty" }, h("div", {}, h("h3", {}, "No setups in this scene yet"),
        "Add camera setups for this scene; every render becomes a take here."));
      put(head, body);
      return;
    }
    if (L.view === "list") body = this._listView();
    else if (L.view === "script") body = this._scriptView();
    else body = this._frameView();
    put(head, ...body);
  }

  /** Refresh keeping the board / list / rail scroll and the focused card or row. */
  softRefresh() {
    const sc = (sel) => { const e = this.el.querySelector(sel); return e ? [e.scrollLeft, e.scrollTop] : null; };
    const keep = { board: sc(".dl-board"), list: sc(".dl-listwrap"), rail: sc(".dl-rail ol") };
    const focusId = document.activeElement?.closest?.(".dl-card, tr[data-id]")?.dataset?.id;
    const openId = this.el.querySelector(".dl-card[data-open]")?.dataset?.id;
    if (this.el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    this.refresh();
    for (const [k, s] of [["board", ".dl-board"], ["list", ".dl-listwrap"], ["rail", ".dl-rail ol"]]) {
      const e = this.el.querySelector(s);
      if (e && keep[k]) { e.scrollLeft = keep[k][0]; e.scrollTop = keep[k][1]; }
    }
    if (openId && this.cards?.get(openId)) this._toggleTakes(this.cards.get(openId), true);
    if (focusId) (this.cards?.get(focusId) || this.tbody?.querySelector(`tr[data-id="${cssEsc(focusId)}"]`))?.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- scene bins

  _descOf(scene) { return sceneDescription(scene.id) ?? autoSceneDescription(scene); }

  _saveDesc(scene, text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    setSceneDescription(scene.id, t && t !== autoSceneDescription(scene) ? t : "");
    this.o.onStatus(t ? `Scene ${scene.number}: “${t}”.` : `Scene ${scene.number}: back to the description from the script.`);
  }

  /** The scene description as an inline-editable title ("" puts the automatic one back). */
  _descInput(sc) {
    const inp = h("input", { class: "dl-desc", type: "text", value: this._descOf(sc), maxlength: "120", size: String(Math.max(16, this._descOf(sc).length + 2)), "aria-label": `What scene ${sc.number} is about (bin name)`,
      title: "What this scene is about: click to edit. Clear it to use the line from the script.", placeholder: autoSceneDescription(sc) || "What happens in this scene" });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); inp.value = this._descOf(sc); inp.blur(); }
    });
    inp.addEventListener("change", () => this._saveDesc(sc, inp.value));
    return inp;
  }

  /** The project window: one bin per scene, in script order, with its approval progress. null without scenes. */
  _rail() {
    const scenes = this.o.getScenes?.() || [];
    if (!scenes.length) return null;
    const all = this.o.getAllShots?.() || this.o.getShots() || [];
    const width = sceneNumberWidth(scenes);
    const cur = this.scene?.id;
    const ol = h("ol", { role: "list" });
    for (const sc of scenes) {
      const rows = sceneShots(sc, all).map((shot) => ({ status: statusOf(shot.id, this._takes(shot)).status }));
      const c = statusCounts(rows);
      const pct = (n) => (c.total ? (n / c.total) * 100 : 0);
      const name = sceneBinName(sc, this._descOf(sc), width);
      const num = `SC ${padSceneNumber(sc.number ?? sc.index + 1, width)}`;
      const btn = h("button", { type: "button", class: "bn", "aria-current": String(sc.id === cur), "data-scene": sc.id,
        title: `${name}\n${progressLabel(sc, c)}${c.rejected ? ` · ${c.rejected} rejected` : ""}\nDouble-click to rename`,
        on: { click: () => { if (sc.id !== this.scene?.id) { this.o.onPickScene?.(sc.id); this.refresh(); this.el.querySelector(`.dl-rail button[data-scene="${cssEsc(sc.id)}"]`)?.focus(); } } } },
        h("span", { class: "ic" }, svg("bin", 16)),
        h("span", { class: "nm" }, h("b", {}, num), name.slice(num.length)),
        h("span", { class: "pg" }, h("span", { class: "dl-prog", "aria-hidden": "true" },
          h("i", { class: "a", style: `width:${pct(c.approved)}%` }), h("i", { class: "c", style: `width:${pct(c.changes)}%` }), h("i", { class: "r", style: `width:${pct(c.rejected)}%` })),
          c.total ? `${c.approved}/${c.total} approved` : "no setups", c.changes ? h("span", { class: "fx" }, `· ${c.changes} to fix`) : null));
      btn.addEventListener("dblclick", (e) => { e.preventDefault(); this._renameBin(btn, sc); });
      btn.addEventListener("keydown", (e) => {
        if (e.key === "F2") { e.preventDefault(); this._renameBin(btn, sc); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); (e.key === "ArrowDown" ? btn.parentElement.nextElementSibling : btn.parentElement.previousElementSibling)?.querySelector("button")?.focus(); }
      });
      ol.append(h("li", {}, btn));
    }
    return h("nav", { class: "dl-rail", "aria-label": "Scene bins" },
      h("div", { class: "rh" }, svg("folder", 15), "01_SCENES", h("small", {}, plural(scenes.length, "bin"))), ol);
  }

  _renameBin(btn, sc) {
    const nm = btn.querySelector(".nm");
    if (!nm) return;
    const inp = h("input", { class: "ren", type: "text", value: this._descOf(sc), maxlength: "120", "aria-label": `Rename scene ${sc.number}'s bin` });
    let done = false;
    const finish = (save) => { if (done) return; done = true; if (save) this._saveDesc(sc, inp.value); this.refresh(); this.el.querySelector(`.dl-rail button[data-scene="${cssEsc(sc.id)}"]`)?.focus(); };
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
    inp.addEventListener("blur", () => finish(true));
    for (const ev of ["click", "dblclick", "pointerdown"]) inp.addEventListener(ev, (e) => e.stopPropagation());
    nm.replaceWith(inp);
    inp.focus(); inp.select();
  }

  // ---------------------------------------------------------------- status filter

  _statusSeg() {
    const cur = this.layout.status ?? "all";
    const counts = statusCounts(this.rows);
    const n = { all: counts.total, approved: counts.approved, changes: counts.changes, "": counts.unreviewed };
    const seg = h("div", { class: "dl-sseg", role: "group", "aria-label": "Show setups by review status" },
      ...STATUS_FILTERS.map(([k, label]) => h("button", { type: "button", "aria-pressed": String(cur === k), "data-f": k,
        title: k === "all" ? "Every setup" : `Setups whose current take is ${STATUS_META[k].word}`,
        on: { click: () => { this._save({ status: k }); for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.f === k)); this._applyFilter(); } } },
        label, h("small", {}, String(n[k] ?? 0)))));
    return seg;
  }

  // ---------------------------------------------------------------- toolbar bits

  _find() {
    const inp = h("input", { type: "search", placeholder: "Find setups…", "aria-label": "Filter setups", value: this.query });
    inp.addEventListener("input", () => { this.query = inp.value; this._applyFilter(); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Escape" && inp.value) { e.stopPropagation(); inp.value = ""; this.query = ""; this._applyFilter(); } });
    return h("label", { class: "dl-find" }, svg("search", 14), inp);
  }

  _arrangeMenu() {
    const item = (k, label, sub) => h("button", { type: "button", role: "menuitem", on: { click: () => { this._closeMenu(); this.arrange(k); } } },
      h("span", {}, label), h("small", {}, sub));
    this.menu = h("div", { class: "dl-menu", role: "menu", hidden: "" },
      item("script", "Script order", "Where each setup starts in the scene"),
      item("setup", "By setup type", "Masters, two-shots, OTS, singles, close-ups, inserts"),
      item("tidy", "Tidy grid", "Snap every card to the nearest free cell"));
    this.menu.addEventListener("keydown", (e) => {
      const items = [...this.menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this._closeMenu(); this.menuBtn.focus(); }
    });
    this.menuBtn = h("button", { type: "button", class: "dl-btn", "aria-haspopup": "menu", "aria-expanded": "false",
      on: { click: () => (this.menu.hidden ? this._openMenu() : this._closeMenu()) } }, svg("arrange", 15), "Arrange", svg("chevron", 14));
    return h("div", { class: "dl-menuwrap" }, this.menuBtn, this.menu);
  }

  _openMenu() { this.menu.hidden = false; this.menuBtn.setAttribute("aria-expanded", "true"); this.menu.querySelector("button")?.focus(); }
  _closeMenu() { if (!this.menu) return; this.menu.hidden = true; this.menuBtn?.setAttribute("aria-expanded", "false"); }

  // ---------------------------------------------------------------- frame view

  _cols() {
    const w = this.board?.clientWidth || this.el.clientWidth || 1000;
    return columnsFor(w - 4, this.layout.size || 1);
  }

  /** Auto-arrange the frame view: 'script' | 'setup' | 'tidy'. */
  arrange(how) {
    const cols = this._cols();
    const items = this.rows.map((r) => ({ id: r.id, kind: r.kind, coverage: r.coverage }));
    let positions;
    if (how === "setup") positions = arrangeBySetup(items, cols).positions;
    else if (how === "tidy") positions = tidyGrid(this.layout.positions || {}, this.rows.map((r) => r.id), cols);
    else positions = arrangeByScript(items, cols);
    this._save({ positions: { ...(this.layout.positions || {}), ...positions } });
    this.o.onStatus(how === "setup" ? "Arranged by setup type." : how === "tidy" ? "Snapped to the grid." : "Arranged in script order.");
    this.refresh();
  }

  _frameView() {
    const L = this.layout;
    const size = L.size || 1;
    const sizeIn = h("input", { type: "range", min: "0.7", max: "1.5", step: "0.05", value: String(size), "aria-label": "Thumbnail size" });
    sizeIn.addEventListener("input", () => { this.board.style.setProperty("--sz", sizeIn.value); this._placeAll(+sizeIn.value); });
    sizeIn.addEventListener("change", () => this._save({ size: +sizeIn.value }));
    const bar = h("div", { class: "dl-bar" }, this._arrangeMenu(), this._find(), this._statusSeg(),
      h("label", { class: "dl-size", title: "Thumbnail size" }, svg("small", 12), sizeIn, svg("small", 17)),
      h("span", { class: "dl-grow" }),
      h("span", { class: "dl-tip" }, "Drag to arrange · double-click opens · Space shows takes · click a badge to review"));
    this.board = h("div", { class: "dl-board", role: "listbox", "aria-label": "Setups (frame view)", style: `--sz:${size}` });
    this.plane = h("div", { class: "dl-plane" });
    this.board.append(this.plane);
    // First visit: script order. Afterwards new setups append below.
    let positions = L.positions || {};
    const ids = this.rows.map((r) => r.id);
    // The board's width: the bin minus the scene-bin rail beside it.
    const railW = !this.el.classList.contains("dl-hasrail") || (this.el.clientWidth || 1200) <= 820 ? 0
      : this.el.querySelector(".dl-rail")?.offsetWidth || 280;
    const cols = columnsFor((this.el.clientWidth || 1200) - (railW ? railW + 14 : 0) - 4, size);
    if (!ids.some((id) => positions[id])) {
      positions = arrangeByScript(this.rows.map((r) => ({ id: r.id, kind: r.kind, coverage: r.coverage })), cols);
      this._save({ positions });
    } else if (ids.some((id) => !positions[id])) {
      positions = fillPositions(positions, ids, cols);
      this._save({ positions });
    }
    this.positions = { ...positions };
    this.cards = new Map();
    for (const r of this.rows) {
      const card = this._card(r);
      this.cards.set(r.id, card);
      this.plane.append(card);
    }
    this._placeAll(size);
    this._applyFilter();
    this.board.addEventListener("pointerdown", (e) => { if (e.target === this.board || e.target === this.plane) this._select(null); });
    this._ro?.observe(this.board);
    return [bar, h("div", { class: "dl-body" }, this.board)];
  }

  _placeAll(size = this.layout.size || 1) {
    this._size = size;
    for (const [id, card] of this.cards || []) {
      const p = this.positions[id] || { x: GAP, y: GAP };
      card.style.left = `${p.x * size}px`;
      card.style.top = `${p.y * size}px`;
    }
    this._sizePlane();
  }

  _sizePlane() {
    if (!this.plane) return;
    const size = this._size || 1;
    let w = 0, hh = 0;
    for (const p of Object.values(this.positions || {})) { w = Math.max(w, p.x + CARD_W + GAP); hh = Math.max(hh, p.y + CARD_H + GAP); }
    // Room below the last row for its takes pop-over.
    this.plane.style.width = `${w * size}px`;
    this.plane.style.height = `${hh * size + 150}px`;
  }

  _card(r) {
    const hero = r.hero;
    const thumb = hero?.thumb;
    const media = thumb ? h("img", { src: thumb, alt: "", draggable: "false", loading: "lazy" })
      : hero?.video ? h("video", { src: hero.url, muted: true, preload: "metadata", playsinline: true })
        : h("div", { class: "none" }, "No takes yet");
    const circ = r.circled;
    const star = h("button", { type: "button", class: "st", "aria-pressed": String(!!circ), title: circ ? `Take ${circ.n} is circled: click to uncircle`
      : hero ? `Circle take ${hero.n}` : "No take to circle", "aria-label": circ ? `Uncircle take ${circ.n}` : "Circle the shown take",
      disabled: hero ? null : "", on: { click: (e) => { e.stopPropagation(); this.circle(r.shot, circ ? null : hero); } } }, svg("star", 15, !!circ));
    const tkBtn = h("button", { type: "button", class: "tk", "aria-expanded": "false", title: "Show the takes",
      on: { click: (e) => { e.stopPropagation(); this._toggleTakes(card); } } }, plural(r.take_count, "take"), svg("chevron", 12));
    const card = h("div", { class: "dl-card", tabindex: "0", role: "option", "aria-selected": "false", "data-id": r.id, "data-sel": "false",
      style: `--c:${r.color}`, "data-status": r.status || "none",
      "aria-label": `${r.label}, ${r.name}. ${SETUP_KIND_LABEL[r.kind]}. ${plural(r.take_count, "take")}${circ ? `, take ${circ.n} circled` : ""}${r.judged ? `, ${STATUS_META[r.status].word}` : ""}. Enter opens, Space shows takes, arrows move.` },
      h("div", { class: "dl-th" }, media,
        h("span", { class: "dl-slate" }, h("i"), r.label),
        hero ? h("span", { class: "dl-kind", "data-k": hero.kind }, KIND_LABEL[hero.kind]) : null,
        hero ? h("span", { class: "dl-tk", title: hero.circled ? "Circled take" : "Shown take" },
          h("span", { class: "ring", "data-c": String(!!hero.circled) }, String(hero.n)), `Tk ${hero.n}`) : null,
        hero?.seconds ? h("span", { class: "dl-dur ss-mono" }, fmtDuration(hero.seconds)) : null),
      h("div", { class: "dl-cap" },
        h("div", { class: "nm", title: r.name }, r.name),
        r.status === "changes" && r.note ? h("div", { class: "nt", title: r.note }, `↺ ${r.note}`) : null,
        h("div", { class: "mt" }, h("span", { class: "ty" }, SETUP_KIND_LABEL[r.kind]), tkBtn, star)),
      this._takesPop(r));
    // The review badge judges the shot's current take (latest final, else draft, else the circled frame).
    if (r.judged) approvalBadge(card.querySelector(".dl-th"), r.judged, { shotId: r.id, place: true,
      label: `${clipName(this.scene, r.idx, r.judged.n, r.shot)} · ${KIND_LABEL[r.judged.kind]}` });
    if (hero) this.o.decorateTake?.(card.querySelector(".dl-th"), hero, r.shot, "card");   // take checks (Milestone 16)
    this._wireCard(card, r);
    return card;
  }

  _takesPop(r) {
    const pop = h("div", { class: "dl-takes", role: "group", "aria-label": `Takes of ${r.label}` });
    if (!r.takes.length) { pop.append(h("div", { class: "none" }, "No takes yet: render this setup.")); return pop; }
    // Newest first, like a bin sorted by take.
    for (const t of [...r.takes].reverse()) {
      const name = clipName(this.scene, r.idx, t.n, r.shot);
      const row = pop.appendChild(h("div", { class: "row" },
        h("button", { type: "button", class: "op", title: `Open ${name}`, "aria-label": `Open take ${t.n}, ${KIND_LABEL[t.kind]}`,
          on: { click: (e) => { e.stopPropagation(); this.o.onOpenTake(r.shot, t); } } },
          h("span", { class: "mini", style: t.thumb ? `background-image:url("${cssUrl(t.thumb)}")` : "" }),
          h("span", { class: "lb" }, h("b", {}, name), h("span", {}, [KIND_LABEL[t.kind], fmtDuration(t.seconds), t.sound ? "sound" : ""].filter(Boolean).join(" · ")))),
        t.kind === "previz" ? h("span") : approvalBadge(null, t, { shotId: r.id, label: `${name} · ${KIND_LABEL[t.kind]}` }),
        h("button", { type: "button", class: "cir", "aria-pressed": String(t.circled), title: t.circled ? "Uncircle" : `Circle take ${t.n}`,
          "aria-label": t.circled ? `Uncircle take ${t.n}` : `Circle take ${t.n}`,
          on: { click: (e) => { e.stopPropagation(); this.circle(r.shot, t.circled ? null : t); } } }, String(t.n))));
      this.o.decorateTake?.(row.querySelector(".lb"), t, r.shot, "row");
    }
    return pop;
  }

  _toggleTakes(card, on = !card.hasAttribute("data-open")) {
    for (const c of this.cards?.values() || []) if (c !== card) { c.removeAttribute("data-open"); c.querySelector("button.tk")?.setAttribute("aria-expanded", "false"); }
    card.toggleAttribute("data-open", on);
    card.querySelector("button.tk")?.setAttribute("aria-expanded", String(on));
    return on;
  }

  _select(id) {
    this.sel = id;
    for (const [cid, c] of this.cards || []) {
      c.dataset.sel = String(cid === id);
      c.setAttribute("aria-selected", String(cid === id));
      if (cid !== id) c.removeAttribute("data-open");
    }
  }

  _wireCard(card, r) {
    let st = null;
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      this._select(r.id);
      const size = this._size || 1;
      const p = this.positions[r.id] || { x: GAP, y: GAP };
      st = { x: e.clientX, y: e.clientY, px: p.x, py: p.y, moved: false, size };
      card.setPointerCapture?.(e.pointerId);
    });
    card.addEventListener("pointermove", (e) => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.moved && Math.hypot(dx, dy) < 4) return;
      if (!st.moved) { st.moved = true; card.setAttribute("data-drag", ""); card.removeAttribute("data-open"); }
      // Alt = no snapping.
      const raw = { x: Math.max(0, st.px + dx / st.size), y: Math.max(0, st.py + dy / st.size) };
      const p = e.altKey ? raw : { x: snap(raw.x), y: snap(raw.y) };
      this.positions[r.id] = p;
      card.style.left = `${p.x * st.size}px`;
      card.style.top = `${p.y * st.size}px`;
      this._sizePlane();
      this._autoscroll(e);
    });
    const end = () => {
      if (!st) return;
      const moved = st.moved;
      st = null;
      card.removeAttribute("data-drag");
      if (moved) this._save({ positions: { ...this.positions } });
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
    card.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) this.open(r); });
    card.addEventListener("focus", () => this._select(r.id));
    card.addEventListener("keydown", (e) => {
      if (e.target !== card) return;
      const step = (e.shiftKey ? CELL_W / 2 : SNAP);
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -(e.shiftKey ? CELL_H / 2 : SNAP)], ArrowDown: [0, e.shiftKey ? CELL_H / 2 : SNAP] }[e.key];
      if (mv) {
        e.preventDefault();
        const p = this.positions[r.id] || { x: GAP, y: GAP };
        this.positions[r.id] = { x: snap(p.x + mv[0]), y: snap(p.y + mv[1]) };
        this._placeAll(this._size);
        clearTimeout(this._kt); this._kt = setTimeout(() => this._save({ positions: { ...this.positions } }), 250);
        card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      } else if (e.key === "Enter") { e.preventDefault(); this.open(r); }
      else if (e.key === " ") {
        e.preventDefault();
        if (this._toggleTakes(card)) card.querySelector(".dl-takes button.op")?.focus();
      } else if (e.key === "Escape" && card.hasAttribute("data-open")) { e.preventDefault(); this._toggleTakes(card, false); }
      else if (e.key === "*" || e.key === "c") { e.preventDefault(); this.circle(r.shot, r.circled ? null : r.hero); }
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && e.target !== card && card.hasAttribute("data-open")) { e.preventDefault(); this._toggleTakes(card, false); card.focus(); }
    });
  }

  _autoscroll(e) {
    const b = this.board.getBoundingClientRect(), m = 30;
    if (e.clientY > b.bottom - m) this.board.scrollTop += 12; else if (e.clientY < b.top + m) this.board.scrollTop -= 12;
    if (e.clientX > b.right - m) this.board.scrollLeft += 12; else if (e.clientX < b.left + m) this.board.scrollLeft -= 12;
  }

  _applyFilter() {
    const keep = new Set(filterByStatus(filterRows(this.rows, this.query), this.layout.status ?? "all").map((r) => r.id));
    for (const [id, c] of this.cards || []) c.hidden = !keep.has(id);
    for (const tr of this.tbody?.querySelectorAll("tr") || []) tr.hidden = !keep.has(tr.dataset.id);
  }

  // ---------------------------------------------------------------- actions

  /** Open a setup's circled take, else its most finished one. */
  open(rowOrShot, at) {
    const r = rowOrShot.shot ? rowOrShot : this.rows.find((x) => x.id === rowOrShot.id);
    if (!r?.hero) { this.o.onStatus(`${r?.label || "This setup"} has no takes yet.`); return; }
    this.o.onOpenTake(r.shot, r.hero, at);
  }

  /** Circle a take (null uncircles). One circled take per setup. */
  circle(shot, take) {
    const circled = { ...(this.layout.circled || {}) };
    if (take) circled[shot.id] = take.id; else delete circled[shot.id];
    this._save({ circled });
    this.o.onCircle(shot, take || null);
    const r = this.rows.find((x) => x.id === shot.id);
    this.o.onStatus(take ? `Circled ${clipName(this.scene, r?.idx ?? 0, take.n, shot)}.` : `${r?.label || "Setup"}: no circled take.`);
    const focusId = shot.id, wasOpen = this.cards?.get(focusId)?.hasAttribute("data-open");
    const scroll = this.board ? [this.board.scrollLeft, this.board.scrollTop] : null;
    this.refresh();
    if (this.board && scroll) { this.board.scrollLeft = scroll[0]; this.board.scrollTop = scroll[1]; }
    const card = this.cards?.get(focusId);
    if (card) { this._select(focusId); if (wasOpen) this._toggleTakes(card, true); card.focus({ preventScroll: true }); }
    else this.tbody?.querySelector(`tr[data-id="${cssEsc(focusId)}"]`)?.focus();
  }

  // ---------------------------------------------------------------- list view

  _listView() {
    const L = this.layout;
    const sort = L.sort || { key: "label", dir: 1 };
    const cols = [["", null], ["Setup", "label"], ["Name", "name"], ["Type", "kind"], ["Takes", "takes"], ["Circled", "circled"],
      ["Status", null], ["Kind", "take_kind"], ["Duration", "seconds"], ["Coverage", null]];
    const thead = h("thead", {}, h("tr", {}, ...cols.map(([label, key]) => {
      if (!key) return h("th", { class: "nosort", scope: "col" }, label);
      const on = sort.key === key;
      return h("th", { scope: "col", "aria-sort": on ? (sort.dir > 0 ? "ascending" : "descending") : "none" },
        h("button", { type: "button", title: `Sort by ${label.toLowerCase()}`,
          on: { click: () => { this._save({ sort: { key, dir: on ? -sort.dir : 1 } }); this.refresh(); this.el.querySelector(`th[aria-sort]:not([aria-sort=none]) button`)?.focus(); } } },
          label, on ? svg(sort.dir > 0 ? "sortup" : "sortdown", 13) : null));
    })));
    const n = this.scene.elements?.length || 1;
    this.tbody = h("tbody");
    for (const r of sortRows(this.rows, sort.key, sort.dir)) {
      const hero = r.hero, circ = r.circled;
      const cov = r.coverage;
      const bar = cov ? h("div", { class: "dl-cov", style: `--c:${r.color}`, title: `Elements ${cov.from + 1}–${cov.to + 1} of ${n}${cov.offscreen.length ? " (zig-zag: off camera)" : ""}` },
        ...segments(cov).map(([a, b, off]) => h("span", { class: off ? "off" : "", style: `left:${(a / n) * 100}%;width:${((b - a + 1) / n) * 100}%` })))
        : h("span", { class: "nocov" }, "not lined");
      const tr = h("tr", { tabindex: "0", "data-id": r.id, "aria-label": `${r.label}, ${r.name}` },
        h("td", {}, h("div", { class: "th", style: hero?.thumb ? `background-image:url("${cssUrl(hero.thumb)}")` : "" })),
        h("td", {}, h("span", { class: "sl", style: `--c:${r.color}` }, h("i"), r.label)),
        h("td", {}, h("div", { class: "nm", title: r.name }, r.name)),
        h("td", { class: "mut" }, SETUP_KIND_LABEL[r.kind]),
        h("td", { class: "num" }, String(r.take_count)),
        h("td", {}, h("button", { type: "button", class: "cr", "data-c": String(!!circ), title: circ ? `Take ${circ.n} circled: click to uncircle` : hero ? `Circle take ${hero.n}` : "",
          disabled: hero ? null : "", on: { click: (e) => { e.stopPropagation(); this.circle(r.shot, circ ? null : hero); } } },
          svg("star", 13, !!circ), circ ? `Tk ${circ.n}` : "—")),
        h("td", {}, r.judged ? h("span", { class: "stc" }, approvalBadge(null, r.judged, { shotId: r.id, size: 20,
          label: `${clipName(this.scene, r.idx, r.judged.n, r.shot)} · ${KIND_LABEL[r.judged.kind]}` }),
          h("span", {}, STATUS_META[r.status].label), r.note ? h("span", { class: "nt", title: r.note }, r.note) : null) : h("span", { class: "mut" }, "—")),
        h("td", {}, hero ? h("span", { class: "kd", "data-k": hero.kind }, KIND_LABEL[hero.kind]) : h("span", { class: "mut" }, "—")),
        h("td", { class: "num mut ss-mono" }, fmtDuration(r.seconds) || "—"),
        h("td", {}, bar));
      tr.addEventListener("dblclick", () => this.open(r));
      tr.addEventListener("keydown", (e) => {
        if (e.target !== tr) return;
        if (e.key === "Enter") { e.preventDefault(); this.open(r); }
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          let x = e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
          while (x && x.hidden) x = e.key === "ArrowDown" ? x.nextElementSibling : x.previousElementSibling;
          x?.focus();
        } else if (e.key === "*" || e.key === "c") { e.preventDefault(); this.circle(r.shot, circ ? null : hero); }
      });
      this.tbody.append(tr);
    }
    const table = h("table", { class: "dl-list" }, thead, this.tbody);
    const bar = h("div", { class: "dl-bar" }, this._find(), this._statusSeg(), h("span", { class: "dl-grow" }),
      h("span", { class: "dl-tip" }, "Click a column to sort · double-click or Enter opens · C circles"));
    this._applyFilter();
    return [bar, h("div", { class: "dl-listwrap" }, table)];
  }

  // ---------------------------------------------------------------- script view

  _scriptView() {
    if (this.lined && this._linedWrap) { this.lined.refresh(); return [this._linedWrap]; }
    const wrap = this._linedWrap = h("div", { class: "dl-scriptwrap" });
    this.lined = new LinedScript(wrap, {
      getSeconds: this.o.getSeconds || null,
      onSync: this.o.onSync || null,
      getScene: () => this.scene,
      getShots: () => this.o.getShots(),
      getRenders: (id, shot) => this.o.getRenders(id, shot),
      getTakes: (shot) => this._takes(shot),
      getCoverage: (shot) => (this.o.getCoverage ? this.o.getCoverage(shot) : (shot.id in (this.layout.coverage || {}) ? this.layout.coverage[shot.id] : shot.coverage)),
      setCoverage: (id, cov) => {
        if (this.o.setCoverage) this.o.setCoverage(id, cov);
        else this._save({ coverage: { ...(this.layout.coverage || {}), [id]: cov } });
        this.rows = this.rows.map((r) => (r.id === id ? { ...r, coverage: cov } : r));
      },
      onOpenTake: (shot, take, at) => this.o.onOpenTake(shot, take, at),
      onStatus: (m) => this.o.onStatus(m),
    });
    return [wrap];
  }
}

/** Coverage -> [[a, b, offscreen]] runs, for the list view's mini bar. */
function segments(cov) {
  const out = [];
  let i = cov.from;
  while (i <= cov.to) {
    const off = isOffscreen(cov, i);
    let j = i;
    while (j + 1 <= cov.to && isOffscreen(cov, j + 1) === off) j++;
    out.push([i, j, off]);
    i = j + 1;
  }
  return out;
}
