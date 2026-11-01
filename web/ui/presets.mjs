// The Presets window (Milestone 17): one floating, searchable panel over the canvas with one-click camera moves,
// lighting, film looks, stunts and physics, edit styles and multi-step recipes, plus your own saved presets.
// Each card previews what it does, rendered from the current stage in clay (web/presets/livethumbs.mjs: a camera move
// or a stunt loops, a light or a look is a still; a drawn preview stands in until it's ready). Hovering a card
// previews it on the shot itself and leaving restores the shot; a click applies it to the current shot (or the
// selected object) as one undo step, with an "Applied to shot N · Undo" toast. Search covers every tab; the arrow
// keys move between cards and Enter applies one.
//
//   import { mountPresets } from "./ui/presets.mjs";
//   const p = mountPresets({ root: el, topBar: tabs, before: keysBtn, api, stage, host, isActive });
//   p.open("camera"); await p.apply("crane_up"); p.undo(); p.runner   // web/presets/runner.mjs
//
// Opened from the top bar or V. The Director gets a `preset` tool for every card (soundstage/presets_agent.py plans
// it; EXEC.preset below runs it here), so "make it a crane up at golden hour" works. User presets live in ComfyUI's
// user data (soundstage/presets.json), with this browser's storage as the fallback; Export / Import move them as JSON.
import { FONT, TOKENS as T, RADIUS } from "./theme.mjs";
import { icon } from "./icons.mjs";
import { withKeys } from "./shortcuts.mjs";
import { loadCatalog, searchPresets, userPresetFrom, parseUserPresets, userPresetsFile, cameraKeys } from "../presets/engine.mjs";
import { PresetRunner, RUNNERS, installDirectorTool } from "../presets/runner.mjs";
import { drawThumb } from "../presets/thumbs.mjs";
import { LiveThumbs, liveKind, THUMB_W, THUMB_H } from "../presets/livethumbs.mjs";

export const PRESETS_KEY = "V";
const USER_FILE = "soundstage/presets.json";
const LS_USER = "ss_user_presets";
const LS_TAB = "ss_presets_tab";
/** Tabs shown in this release (the others are built and tested, and switch on here). */
export const SHOWN_TABS = ["camera", "light", "look", "action", "edit", "recipe", "user"];

const CSS = `
.ss-pre { position:absolute; left:50%; top:58px; transform:translateX(-50%); width:min(860px, calc(100% - 32px));
  max-height:calc(100% - 132px); z-index:82; display:flex; flex-direction:column; background:${T.glassStrong}; color:${T.text};
  border:1px solid ${T.lineStrong}; border-radius:${RADIUS.lg}px; box-shadow:0 22px 60px rgba(0,0,0,.55); backdrop-filter:blur(14px);
  font:13px/1.4 ${FONT}; overflow:hidden; }
.ss-pre, .ss-pre * { box-sizing:border-box; }
.ss-pre[hidden] { display:none !important; }
.ss-pre-head { display:flex; align-items:center; gap:10px; padding:10px 12px 8px 14px; border-bottom:1px solid ${T.line}; flex:none; }
.ss-pre-head .t { display:inline-flex; align-items:center; gap:7px; font-weight:600; font-size:15px; white-space:nowrap; }
.ss-pre-head .t .ss-icon { color:${T.accent}; }
.ss-pre-q { flex:1 1 auto; min-width:120px; background:rgba(0,0,0,.25); color:${T.text}; border:1px solid ${T.line}; border-radius:999px;
  padding:6px 12px; font:inherit; }
.ss-pre-q:focus { outline:none; border-color:${T.accentLine}; }
.ss-pre-q::placeholder { color:${T.faint}; }
.ss-pre-to { font-size:12px; color:${T.muted}; white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
.ss-pre-to b { color:${T.text}; font-weight:600; }
.ss-pre .ib { width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; border-radius:8px; cursor:pointer;
  background:transparent; color:${T.muted}; border:1px solid transparent; flex:none; }
.ss-pre .ib:hover { background:rgba(255,255,255,.07); color:${T.text}; }
.ss-pre button:focus-visible, .ss-pre input:focus-visible { outline:2px solid ${T.accent}; outline-offset:2px; }
.ss-pre-tabs { display:flex; gap:2px; padding:8px 12px 0; flex:none; flex-wrap:wrap; }
.ss-pre-tabs button { display:inline-flex; align-items:center; gap:6px; background:transparent; color:${T.muted}; border:1px solid transparent;
  border-radius:999px; padding:5px 11px; font:500 12px/1.2 ${FONT}; cursor:pointer; }
.ss-pre-tabs button:hover { color:${T.text}; background:rgba(255,255,255,.05); }
.ss-pre-tabs button[aria-pressed=true] { background:${T.raised}; color:${T.text}; border-color:${T.line}; }
.ss-pre-tabs button .n { font-size:11px; color:${T.faint}; }
.ss-pre-sub { display:flex; gap:6px; padding:8px 14px 0; flex-wrap:wrap; flex:none; }
.ss-pre-sub[hidden] { display:none; }
.ss-pre-sub button { background:rgba(255,255,255,.05); color:${T.muted}; border:1px solid ${T.line}; border-radius:999px; padding:3px 10px;
  font:500 12px/1.3 ${FONT}; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
.ss-pre-sub button[aria-pressed=true] { color:${T.accentInk}; background:${T.accent}; border-color:${T.accent}; }
.ss-pre-sub button.act { color:${T.text}; }
.ss-pre-sub button.act:hover { border-color:${T.lineStrong}; background:rgba(255,255,255,.09); }
.ss-pre-sub .sp { flex:1 1 auto; }
.ss-pre-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; padding:10px 12px 12px; overflow:auto;
  min-height:0; flex:1 1 auto; scrollbar-width:thin; align-content:start; }
.ss-pre .ss-pre-card, .ss-stage .ss-pre button.ss-pre-card { position:relative; display:flex !important; flex-direction:column !important;
  align-items:stretch !important; justify-content:flex-start; gap:5px !important; padding:6px 6px 8px !important; border-radius:${RADIUS.md}px !important;
  cursor:pointer; background:${T.card} !important; border:1px solid ${T.line} !important; color:${T.text} !important; text-align:left;
  font:inherit; font-weight:400 !important; min-width:0; }
.ss-stage .ss-pre button.ss-pre-card:hover, .ss-stage .ss-pre button.ss-pre-card:focus-visible { background:${T.cardHover} !important; border-color:${T.accentLine} !important; }
.ss-stage .ss-pre button.ss-pre-card[data-applied=true] { border-color:${T.accent} !important; box-shadow:0 0 0 1px ${T.accent} inset; }
.ss-stage .ss-pre .ss-pre-tabs button, .ss-stage .ss-pre .ss-pre-sub button, .ss-stage .ss-pre .ib, .ss-stage .ss-toast button, .ss-stage .ss-pre-ask button {
  padding:4px 11px !important; }
.ss-stage .ss-pre .ib { padding:0 !important; width:28px; height:28px; justify-content:center; background:transparent !important; border-color:transparent !important; }
.ss-stage .ss-pre .ss-pre-tabs button:not([aria-pressed=true]) { background:transparent !important; border-color:transparent !important; color:${T.muted} !important; }
.ss-stage .ss-pre .ss-pre-sub button[aria-pressed=true] { background:${T.accent} !important; color:${T.accentInk} !important; border-color:${T.accent} !important; }
.ss-stage .ss-pre .ss-pre-card .del { padding:0 !important; width:22px; height:22px; justify-content:center; }
.ss-stage .ss-pre-ask button.go { background:${T.accent} !important; color:${T.accentInk} !important; border-color:${T.accent} !important; }
.ss-stage .ss-toast button.un { color:${T.accent} !important; border-color:${T.accentLine} !important; }
.ss-pre-card canvas { width:100%; aspect-ratio:16/9; border-radius:7px; display:block; background:#1a141f; }
.ss-pre-card .nm { font-size:13px; font-weight:600; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-pre-card .sm { font-size:11px; color:${T.muted}; line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:28px; }
.ss-pre-card .gpu { position:absolute; top:10px; right:10px; font-size:10px; font-weight:700; letter-spacing:.06em; padding:2px 6px; border-radius:6px;
  background:rgba(255,122,122,.18); color:${T.danger}; border:1px solid rgba(255,122,122,.4); }
.ss-pre-card .del { position:absolute; top:9px; right:9px; width:22px; height:22px; border-radius:6px; display:inline-flex; align-items:center;
  justify-content:center; background:rgba(0,0,0,.5); color:${T.muted}; border:none; cursor:pointer; opacity:0; }
.ss-pre-card:hover .del, .ss-pre-card .del:focus-visible { opacity:1; }
.ss-pre-empty { grid-column:1 / -1; padding:20px; text-align:center; color:${T.muted}; font-size:13px; }
.ss-pre-foot { flex:none; display:flex; gap:8px; align-items:center; padding:8px 14px; border-top:1px solid ${T.line}; font-size:12px; color:${T.muted}; min-height:36px; }
.ss-pre-foot .tx { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-pre-foot kbd { display:inline-flex; align-items:center; justify-content:center; min-width:18px; height:18px; padding:0 4px; border-radius:5px;
  background:rgba(255,255,255,.06); border:1px solid ${T.lineStrong}; border-bottom-width:2px; color:${T.text}; font:600 10px/1 ${FONT}; }
.ss-pre-ask { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(10,7,13,.6); z-index:2; padding:16px; }
.ss-pre-ask[hidden] { display:none; }
.ss-pre-ask > div { max-width:440px; background:${T.raised}; border:1px solid ${T.lineStrong}; border-radius:${RADIUS.lg}px; padding:16px; box-shadow:0 18px 50px rgba(0,0,0,.5); }
.ss-pre-ask p { margin:0 0 12px; font-size:13px; line-height:1.45; }
.ss-pre-ask .row { display:flex; gap:8px; justify-content:flex-end; }
.ss-pre-ask button, .ss-toast button { border-radius:999px; padding:5px 13px; border:1px solid ${T.lineStrong}; background:rgba(255,255,255,.06);
  color:${T.text}; cursor:pointer; font:500 12px/1.2 ${FONT}; }
.ss-pre-ask button.go { background:${T.accent}; color:${T.accentInk}; border-color:${T.accent}; font-weight:700; }
.ss-toast { position:absolute; left:50%; bottom:74px; transform:translateX(-50%); z-index:90; display:flex; align-items:center; gap:10px;
  max-width:min(620px, calc(100% - 32px)); padding:8px 8px 8px 14px; border-radius:999px; background:${T.glassStrong}; color:${T.text};
  border:1px solid ${T.lineStrong}; box-shadow:0 14px 40px rgba(0,0,0,.5); font:13px/1.3 ${FONT}; backdrop-filter:blur(12px); }
.ss-toast[hidden] { display:none !important; }
.ss-toast .ss-icon { color:${T.success}; }
.ss-toast[data-bad=true] .ss-icon { color:${T.danger}; }
.ss-toast .tx { min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-toast button.un { color:${T.accent}; border-color:${T.accentLine}; font-weight:600; }
.ss-toast .sep { color:${T.faint}; margin:0 -4px; }
.ss-toast .sep[hidden] { display:none; }
.ss-toast .tx b { font-weight:600; }
.ss-pre-card .tg { position:absolute; top:10px; left:10px; font-size:10px; font-weight:600; padding:1px 6px; border-radius:6px;
  background:rgba(0,0,0,.55); color:${T.text}; border:1px solid ${T.line}; pointer-events:none; }
.ss-pre-hov { position:absolute; pointer-events:none; z-index:2; border-radius:4px; display:block; }
.ss-pre-hov[hidden] { display:none !important; }
@media (prefers-reduced-motion: reduce) { .ss-pre-card canvas { animation:none; } }
`;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const stop = (e) => e.stopPropagation();
const isTyping = (t) => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable);

/** Should this keydown toggle the Presets window? V with no modifier, never while typing. */
export function isPresetsKey(e) {
  return !!e && (e.key === "v" || e.key === "V") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isTyping(e.target);
}

// ------------------------------------------------------------------------------------------------ user presets

export async function loadUserPresets(api) {
  try {
    // List the folder first: a GET for a file that isn't there yet (no presets saved) is a 404 in the console every time.
    if (api?.fetchApi) {
      const ls = await api.fetchApi("/userdata?dir=" + encodeURIComponent(USER_FILE.split("/")[0])).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (Array.isArray(ls) && !ls.some((f) => (typeof f === "string" ? f : f?.path) === USER_FILE.split("/").pop())) throw new Error("no user presets yet");
    }
    const r = await api?.getUserData?.(USER_FILE);
    if (r && r.status === 200) return parseUserPresets(await r.json());
  } catch { /* no user data API */ }
  try { return parseUserPresets(localStorage.getItem(LS_USER) || "[]"); } catch { return []; }
}

export async function saveUserPresets(api, list) {
  const file = userPresetsFile(list);
  try { localStorage.setItem(LS_USER, JSON.stringify(file)); } catch { /* storage blocked */ }
  try { await api?.storeUserData?.(USER_FILE, file, { overwrite: true, stringify: true, throwOnError: false }); return true; } catch { return false; }
}

// ------------------------------------------------------------------------------------------------ the panel

export function mountPresets({ root, topBar = null, before = null, api = null, stage, host = {}, isActive = () => true }) {
  if (!document.getElementById("ss-pre-css")) document.head.append(h("style", { id: "ss-pre-css" }, CSS));
  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  let catalog = { tabs: [], presets: [], byId: new Map() };
  let setups = [], palettes = [];
  let tab = (() => { try { const t = localStorage.getItem(LS_TAB); return SHOWN_TABS.includes(t) ? t : "camera"; } catch { return "camera"; } })();
  let group = null, query = "", hover = null, raf = 0, t0 = 0, lastDraw = 0;
  const cards = new Map();   // id -> {el, canvas}
  const say = (m) => { try { host.say?.(m); } catch { /* */ } };

  // ---- DOM
  const q = h("input", { type: "search", class: "ss-pre-q", placeholder: "Search presets: crane, golden hour, J-turn, trailer…", "aria-label": "Search presets" });
  const toLbl = h("span", { class: "ss-pre-to" });
  const closeB = h("button", { type: "button", class: "ib", title: "Close (Esc or V)", "aria-label": "Close the Presets window" }, icon("x", 16));
  const tabsEl = h("div", { class: "ss-pre-tabs", role: "tablist", "aria-label": "Preset kinds" });
  const sub = h("div", { class: "ss-pre-sub" });
  const grid = h("div", { class: "ss-pre-grid", role: "list" });
  const footTx = h("span", { class: "tx" });
  const foot = h("div", { class: "ss-pre-foot" }, footTx);
  const askTx = h("p");
  const askNo = h("button", { type: "button" }, "Cancel");
  const askGo = h("button", { type: "button", class: "go" }, "Queue it");
  const ask = h("div", { class: "ss-pre-ask", hidden: true }, h("div", { role: "alertdialog", "aria-label": "Confirm a GPU render" }, askTx, h("div", { class: "row" }, askNo, askGo)));
  const panel = h("section", { class: "ss-pre", hidden: true, role: "dialog", "aria-label": "Presets" },
    h("header", { class: "ss-pre-head" }, h("span", { class: "t" }, icon("shapes", 17), "Presets"), q, toLbl, closeB),
    tabsEl, sub, grid, foot, ask);
  for (const ev of ["pointerdown", "wheel", "keydown", "keyup", "contextmenu"]) panel.addEventListener(ev, stop, { passive: ev === "wheel" });
  const toastTx = h("span", { class: "tx" });
  const toastUndo = h("button", { type: "button", class: "un" }, "Undo");
  const toastSep = h("span", { class: "sep", "aria-hidden": "true" }, "·");
  const toastX = h("button", { type: "button", title: "Dismiss", "aria-label": "Dismiss" }, icon("x", 13));
  const toast = h("div", { class: "ss-toast", hidden: true, role: "status", "aria-live": "polite" }, icon("check", 15), toastTx, toastSep, toastUndo, toastX);
  toast.addEventListener("pointerdown", stop);
  root.append(panel, toast);

  const button = h("button", { type: "button", class: "ss-btn ss-presetsbtn", title: withKeys("Presets: one-click camera moves, light, looks, stunts, edit styles and recipes", [PRESETS_KEY]),
    "aria-label": "Open the Presets window", "aria-pressed": "false", "aria-haspopup": "dialog" }, icon("shapes", 15), h("span", { class: "lbl" }, " Presets"));
  button.dataset.ssIcon = "shapes";
  button.style.marginLeft = "6px";
  button.addEventListener("pointerdown", stop);
  button.addEventListener("click", () => toggle());
  if (topBar) { if (before && before.parentNode === topBar) topBar.insertBefore(button, before); else topBar.append(button); }

  // ---- the runner
  const confirmBox = (msg) => new Promise((resolve) => {
    if (panel.hidden) open();
    askTx.textContent = msg;
    ask.hidden = false;
    const done = (v) => { ask.hidden = true; askGo.onclick = askNo.onclick = null; resolve(v); };
    askGo.onclick = () => done(true);
    askNo.onclick = () => done(false);
    try { askGo.focus({ preventScroll: true }); } catch { /* */ }
  });
  const runner = new PresetRunner({ stage, host: { confirm: confirmBox, ...host }, catalog, setups });
  RUNNERS.set(stage, runner);

  const ready = (async () => {
    try {
      catalog = await loadCatalog();
      runner.catalog = catalog;
    } catch (e) { console.warn("[Soundstage] presets catalog", e); }
    try { setups = (await (await fetch(new URL("../look/lighting_setups.json", import.meta.url))).json()).setups || []; runner.setups = setups; } catch { /* */ }
    try { palettes = (await import("../look/vocab.mjs")).VOCAB.palettes || []; } catch { /* */ }
    runner.user = await loadUserPresets(api);
    registerDirectorTool();
    if (!panel.hidden) render();
    // Build the default tab's cards while the page is idle, so the first open only has to show them.
    else (typeof requestIdleCallback === "function" ? requestIdleCallback : (f) => setTimeout(f, 200))(() => { if (panel.hidden) { render(); built = `${tab}|`; } });
  })();

  // ---- render
  const listFor = () => {
    const all = [...catalog.presets, ...runner.user].filter((p) => SHOWN_TABS.includes(p.tab));
    if (query) return searchPresets(all, query);
    const list = all.filter((p) => p.tab === tab);
    return group ? list.filter((p) => (p.group || "") === group) : list;
  };

  let matches = new Map();   // tab -> how many cards match the search
  function renderTabs() {
    tabsEl.replaceChildren(...(catalog.tabs.length ? catalog.tabs : [{ id: "camera", label: "Camera moves", icon: "video" }]).filter((t) => SHOWN_TABS.includes(t.id)).map((t) => {
      const n = query ? (matches.get(t.id) || 0) : t.id === "user" ? runner.user.length : catalog.presets.filter((p) => p.tab === t.id).length;
      const b = h("button", { type: "button", role: "tab", "aria-pressed": String(!query && t.id === tab), "data-tab": t.id,
        onclick: () => { tab = t.id; group = null; query = ""; q.value = ""; try { localStorage.setItem(LS_TAB, tab); } catch { /* */ } render(); } },
        icon(t.icon || "shapes", 14), t.label, h("span", { class: "n" }, String(n)));
      return b;
    }));
  }

  function renderSub() {
    sub.replaceChildren();
    sub.hidden = true;
    if (query) return;
    if (tab === "look") {
      const groups = [...new Set(catalog.presets.filter((p) => p.tab === "look").map((p) => p.group || ""))].filter(Boolean);
      sub.append(...[null, ...groups].map((g) => h("button", { type: "button", "aria-pressed": String(group === g), onclick: () => { group = g; render(); } }, g || "All")));
      sub.hidden = false;
    } else if (tab === "user") {
      const save = (kind) => saveCurrent(kind);
      sub.append(h("span", { class: "tx", style: `color:${T.muted};font-size:12px;align-self:center` }, "Save current as:"),
        h("button", { type: "button", class: "act", title: "This shot's camera keys and rig, replayable on any shot", onclick: () => save("camera") }, icon("video", 13), "Camera"),
        h("button", { type: "button", class: "act", title: "The set's time of day, sun and every film light", onclick: () => save("light") }, icon("lightbulb", 13), "Light"),
        h("button", { type: "button", class: "act", title: "The Look: camera body, lens, stock, palette, grade", onclick: () => save("look") }, icon("palette", 13), "Look"),
        h("span", { class: "sp" }),
        h("button", { type: "button", class: "act", title: "Save your presets as a JSON file", onclick: () => exportUser() }, icon("download", 13), "Export"),
        h("button", { type: "button", class: "act", title: "Add presets from a JSON file", onclick: () => importUser() }, icon("upload", 13), "Import"));
      sub.hidden = false;
    }
  }

  function card(p) {
    const canvas = h("canvas", { width: "240", height: "135", "aria-hidden": "true" });
    const gpu = p.apply?.gpu ? h("span", { class: "gpu", title: "Asks before it renders on the GPU" }, "GPU") : null;
    const del = p.tab === "user" ? h("button", { type: "button", class: "del", title: `Delete ${p.label}`, "aria-label": `Delete ${p.label}`,
      onclick: (e) => { e.stopPropagation(); removeUser(p.id); } }, icon("trash-2", 12)) : null;
    const tg = query ? h("span", { class: "tg" }, tabLabel(p.tab)) : null;
    const el = h("button", { type: "button", class: "ss-pre-card", role: "listitem", "data-id": p.id, "data-tab": p.tab, title: p.summary || p.label },
      canvas, h("span", { class: "nm" }, p.label), h("span", { class: "sm" }, p.summary || (p.group ? p.group : "")), tg, gpu, del);
    el.addEventListener("click", () => apply(p.id));
    el.addEventListener("mouseenter", () => startHover(p));
    el.addEventListener("focus", () => startHover(p));
    el.addEventListener("mouseleave", () => endHover(p));
    el.addEventListener("blur", () => endHover(p));
    cards.set(p.id, { el, canvas, p });
    io?.observe(el);
    return el;
  }

  const tabLabel = (id) => (catalog.tabs.find((t) => t.id === id)?.label || id).replace(/ moves$/, "");
  let built = "";   // tab|query the hidden cards were built for (the first open reuses them)
  function render() {
    built = "";
    const list = listFor();
    matches = new Map();
    if (query) for (const p of list) matches.set(p.tab, (matches.get(p.tab) || 0) + 1);
    renderTabs();
    renderSub();
    io?.disconnect(); seen.clear(); cards.clear();
    grid.replaceChildren(...(list.length ? list.map(card) : [h("div", { class: "ss-pre-empty" },
      tab === "user" && !query ? "No presets of your own yet. Set up a camera, light or look you like, then Save current as Camera, Light or Look." : `Nothing matches “${query}”.`)]));
    syncTarget();
    footHint();
    drawAll(performance.now(), true);
    queueLive();
  }

  function syncTarget() {
    const info = runner.shotInfo();
    const sel = runner.selected();
    toLbl.replaceChildren("Applies to ", h("b", {}, `shot ${info.n}`), ` · ${info.name}`, sel ? ` · ${sel.name || sel.kind} selected` : "");
    const log = stage.state?.preset_log || [];
    for (const { el, p } of cards.values()) el.dataset.applied = String(log.some((x) => x.id === p.id && (x.tab !== "camera" || x.shot === info.id)));
  }

  function footHint(p = null) {
    if (p) { footTx.textContent = `${p.label}: ${p.summary || p.group || ""}`; return; }
    footTx.replaceChildren("Hover a card to preview it on the shot · ", h("kbd", {}, "←"), h("kbd", {}, "→"), " and ", h("kbd", {}, "↵"),
      " to pick · click applies, one undo step (", h("kbd", {}, "⌘Z"), " or the toast) · ", h("kbd", {}, PRESETS_KEY), " closes");
  }

  // ---- previews: every card loops; a hovered camera move also plays on the real shot
  // Visible cards only, a few per frame (round robin): a dozen loops cost about one card's drawing per frame.
  const seen = new Set();
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((es) => { for (const e of es) { const id = e.target.dataset.id; if (e.isIntersecting) seen.add(id); else seen.delete(id); } }, { root: grid })
    : null;
  let rr = 0;
  const PER_FRAME = 3;
  function drawOne(entry, t) {
    const c = entry.canvas.getContext("2d");
    if (!c) return;
    const fr = live?.frameAt(entry.p.id, t, { still: reduced() });
    if (fr) {
      if (entry.drawn === fr.i && entry.img === fr.img) return;   // same frame as last time: nothing to draw
      entry.drawn = fr.i; entry.img = fr.img;
      c.drawImage(fr.img, fr.sx, fr.sy, fr.sw, fr.sh, 0, 0, entry.canvas.width, entry.canvas.height);
      if (entry.el.dataset.live !== "true") entry.el.dataset.live = "true";
      return;
    }
    drawThumb(c, entry.p, t, entry.canvas.width, entry.canvas.height, { palettes, setups });
  }
  function drawAll(now, force = false) {
    const t = (now - t0) / 1000;
    const list = [...cards.values()];
    if (force) { for (const e of list) drawOne(e, t); return; }
    const vis = list.filter((e) => !io || seen.has(e.p.id));
    if (hover && cards.has(hover.id)) drawOne(cards.get(hover.id), t * 1.2);
    if (now - lastDraw < 33) return;
    lastDraw = now;
    for (let i = 0; i < Math.min(PER_FRAME, vis.length); i++) { const e = vis[(rr + i) % vis.length]; if (e.p.id !== hover?.id) drawOne(e, t); }
    rr = (rr + PER_FRAME) % Math.max(1, vis.length);
  }
  const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
  function loop(now) {
    if (panel.hidden) { raf = 0; return; }
    if (document.hidden) { raf = requestAnimationFrame(loop); return; }
    if (!reduced() || hover) drawAll(now);
    checkLiveScene(now);
    if (hover?.overlay) drawOverlay(now);
    if (hover?.cam && now - (hover.drawn || 0) > 48) {
      hover.drawn = now;
      const f = ((now - hover.t) / 1000 * 24) % (hover.last + 18);
      try { stage.previewCamera(hover.cam(Math.min(hover.last, f))); } catch { /* stage away */ }
    }
    raf = requestAnimationFrame(loop);
  }
  function startHover(p) {
    if (hover && hover.id !== p.id) endHover(hover);
    hover = { id: p.id, t: performance.now() };
    footHint(p);
    hoverOverlay(p);
    const isCam = p.apply?.camera && !["follow", "car_mount"].includes(p.apply.camera.move);
    if (isCam) {
      // The move's keys on this shot, sampled through the stage's own camera (rig shake, ride-alongs) without keeping them.
      const sh = runner.shotInfo().shot;
      const k0 = (sh.camera_keys || [])[0];
      const last = runner._last();
      const plan = k0 && cameraKeys(k0, p.apply.camera, last);
      if (plan?.keys?.length) {
        const live = stage.activeShot?.();
        hover.last = last;
        hover.cam = (f) => {
          if (!live) return null;
          const keep = live.camera_keys;
          live.camera_keys = plan.keys;
          try { return stage._cameraAt(f); } finally { live.camera_keys = keep; if (stage.state) stage.state.camera_keys = keep; }
        };
      }
    }
  }
  function endHover(p) {
    if (hover?.id !== p.id) return;
    if (hover.cam) try { stage.previewCamera(null); } catch { /* */ }
    endOverlay();
    hover = null;
    footHint();
  }

  // ---- live previews from the stage (web/presets/livethumbs.mjs): a scratch copy of the scene renders each card in
  // clay, visible cards first, a slice at a time after the panel has painted; cached per scene, so they come back at once.
  let live = null, liveSigAt = 0;
  function ensureLive() {
    if (live || typeof document === "undefined" || !stage?.constructor || typeof stage.toJSON !== "function" || !stage.renderer) return live;
    try {
      live = new LiveThumbs({ stage, setups, makeRunner: (s) => {
        const r = new PresetRunner({ stage: s, host: { confirm: async () => false }, catalog, setups });
        r.user = runner.user;
        return r;
      } });
      live.onReady = (id) => { const e = cards.get(id); if (e && !panel.hidden) drawOne(e, (performance.now() - t0) / 1000); };
    } catch (e) { console.warn("[Soundstage] preset previews off", e); live = null; }
    return live;
  }
  /** Queue this view's cards for live previews: the ones on screen first, then the rest of the list. */
  function queueLive() {
    if (panel.hidden || !ensureLive()) return;
    if (live.runner) { live.runner.catalog = catalog; live.runner.user = runner.user; live.runner.setups = setups; }
    live.setups = setups;
    const list = [...cards.values()].map((e) => e.p);
    const box = grid.getBoundingClientRect();
    const onScreen = (e) => { const r = e.el.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; };
    const vis = [...cards.values()].filter(onScreen).map((e) => e.p);
    // Deferred past this frame, so the window paints first (scene signatures cost a JSON pass).
    setTimeout(() => {
      if (panel.hidden || !live) return;
      live.sync(); liveSigAt = performance.now();
      live.want([...vis, ...list]);
      live.start();
    }, 0);
  }
  /** While open: a scene edited under the window (or an apply) re-renders the previews for the new scene. */
  function checkLiveScene(now) {
    if (!live || now - liveSigAt < 1500 || hover) return;
    liveSigAt = now;
    if (live.sync()) { for (const e of cards.values()) e.drawn = -1; queueLive(); }
  }

  // The hover preview on the shot for lights, looks and stunts: an overlay over the stage's canvas, drawn from the
  // scratch copy, so the real shot never changes and leaving the card restores it at once. Camera moves use the
  // stage's own previewCamera (above).
  const hov = h("canvas", { class: "ss-pre-hov", hidden: true, "aria-hidden": "true" });
  let hovTimer = 0, hovDrawn = 0;
  function placeOverlay() {
    const cv = stage.canvas;
    if (!cv?.parentElement) return false;
    if (hov.parentElement !== cv.parentElement || hov.previousSibling !== cv) cv.after(hov);
    const w = cv.clientWidth, hh = cv.clientHeight;
    if (!w || !hh) return false;
    Object.assign(hov.style, { left: cv.offsetLeft + "px", top: cv.offsetTop + "px", width: w + "px", height: hh + "px" });
    const pw = Math.min(1280, cv.width || w), ph = Math.round(pw * hh / w);
    if (hov.width !== pw || hov.height !== ph) { hov.width = pw; hov.height = ph; }
    return true;
  }
  function hoverOverlay(p) {
    clearTimeout(hovTimer);
    if (!liveKind(p) || liveKind(p) === "camera" || !ensureLive()) return;
    // A short wait, so sweeping the pointer across the grid doesn't rebuild the scratch scene for every card.
    hovTimer = setTimeout(async () => {
      if (hover?.id !== p.id) return;
      if (!placeOverlay()) return;
      live.sync();
      // Frames draw as they arrive (a stunt's first frame shows while the rest render).
      hover.overlay = true; hovDrawn = 0;
      const ok = await live.hoverStart(p, { w: hov.width, h: hov.height });
      if (!ok || hover?.id !== p.id || panel.hidden) { if (live.hovering?.id === p.id && hover?.id !== p.id) live.hoverEnd(); return; }
      drawOverlay(performance.now(), true);
    }, 140);
  }
  function drawOverlay(now, force = false) {
    const hv = live?.hovering;
    if (!hv?.frames?.length) return;
    // A still draws once; a stunt plays (~12 fps).
    if (!force && hovDrawn && (hv.total <= 1 && !hv.busy || now - hovDrawn < 80)) return;
    hovDrawn = now;
    const c = hov.getContext("2d");
    if (!c) return;
    try { live.hoverFrame(c, (now - hover.t) / 1000, hov.width, hov.height); } catch (e) { console.warn("[Soundstage] preset preview", e); endOverlay(); return; }
    hov.hidden = false;
    // Say what it is, so a preview is never mistaken for the shot.
    const label = `Preview · ${hv.p.label}`;
    c.font = `600 ${Math.max(12, Math.round(hov.width / 70))}px ${FONT}`;
    const tw = c.measureText(label).width, pad = 8, bh = Math.max(22, Math.round(hov.width / 48));
    c.fillStyle = "rgba(10,7,13,.72)"; c.fillRect(12, 12, tw + pad * 2, bh);
    c.fillStyle = "#fff"; c.textBaseline = "middle"; c.fillText(label, 12 + pad, 12 + bh / 2);
  }
  function endOverlay() {
    clearTimeout(hovTimer);
    hov.hidden = true;
    live?.hoverEnd();
  }

  // ---- apply, toast, undo
  let toastTimer = 0;
  function showToast(text, { undo = false, bad = false, label = null } = {}) {
    toastTx.replaceChildren(...(label ? [h("b", {}, label), " · "] : []), text);
    toastSep.hidden = !undo;
    toast.dataset.bad = String(bad);
    toast.querySelector(".ss-icon")?.replaceWith(icon(bad ? "info" : "check", 15));
    toastUndo.hidden = !undo;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, bad ? 7000 : 6500);
  }
  toastUndo.addEventListener("click", () => { const l = runner.undo(); if (l) { showToast(`Undone: '${l}'`); toastUndo.hidden = true; toastSep.hidden = true; afterChange(); } });
  toastX.addEventListener("click", () => { toast.hidden = true; });

  function afterChange() {
    try { host.onLoad?.(stage.toJSON()); } catch { /* */ }
    if (!panel.hidden) syncTarget();
  }

  async function apply(id, opts = {}) {
    await ready;
    if (hover) { try { stage.previewCamera(null); } catch { /* */ } endOverlay(); if (hover) hover.overlay = false; }
    const r = await runner.apply(id, opts);
    if (r.ok) {
      if (r.tab === "recipe") showToast(r.said, { undo: !!r.undoable });
      else showToast(`Applied to ${r.target}`, { undo: !!r.undoable, label: r.label });
      say(r.said);
    } else if (!r.cancelled) { showToast(r.said, { bad: true }); say(r.said); }
    afterChange();
    // Still hovering the card just applied: a camera move keeps previewing; a light or look would only show itself again.
    const q2 = runner.get(id);
    if (hover?.id === id && liveKind(q2) === "camera") { hover = null; startHover(q2); }
    return r;
  }

  // ---- user presets
  async function saveCurrent(kind) {
    let lk = null;
    try { lk = host.look?.get?.() || null; } catch { /* */ }
    const n = runner.user.filter((p) => p.kind === kind).length + 1;
    const info = runner.shotInfo();
    const label = kind === "camera" ? `My camera ${n} (${info.name})` : kind === "light" ? `My light ${n}` : `My look ${n}${lk?.style ? ` (${lk.style.replace(/_/g, " ")})` : ""}`;
    try {
      const p = userPresetFrom(kind, { scene: stage.toJSON(), look: lk }, label);
      runner.user = [...runner.user, p];
      await saveUserPresets(api, runner.user);
      showToast(`Saved '${p.label}' to your presets`);
      tab = "user"; render();
    } catch (e) { showToast(e.message || String(e), { bad: true }); }
  }
  async function removeUser(id) {
    const p = runner.user.find((x) => x.id === id);
    runner.user = runner.user.filter((x) => x.id !== id);
    await saveUserPresets(api, runner.user);
    render();
    if (p) showToast(`Deleted '${p.label}'`);
  }
  /** The user presets file as text (Export saves it; tests read it). */
  const exportText = () => JSON.stringify(userPresetsFile(runner.user), null, 2);
  function exportUser() {
    const blob = new Blob([exportText()], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "soundstage_presets.json" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function importText(text) {
    const got = parseUserPresets(text);
    const have = new Set(runner.user.map((p) => p.id));
    const add = got.filter((p) => !have.has(p.id));
    runner.user = [...runner.user, ...add];
    await saveUserPresets(api, runner.user);
    if (!panel.hidden) render();
    return add.length;
  }
  function importUser() {
    const inp = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    inp.addEventListener("change", async () => {
      const f = inp.files?.[0];
      inp.remove();
      if (!f) return;
      const n = await importText(await f.text());
      showToast(n ? `Imported ${n} preset${n === 1 ? "" : "s"}` : "No new presets in that file", { bad: !n });
    });
    document.body.append(inp);
    inp.click();
  }

  // ---- open / close / keys
  function open(which = null) {
    if (which) { tab = which; group = null; query = ""; q.value = ""; }
    panel.hidden = false;
    button.setAttribute("aria-pressed", "true");
    t0 = performance.now();
    if (built && built === `${tab}|${query}` && !group) { built = ""; syncTarget(); footHint(); queueLive(); }
    else render();
    if (!raf) raf = requestAnimationFrame(loop);
    try { q.focus({ preventScroll: true }); } catch { /* */ }
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    ask.hidden = true;
    button.setAttribute("aria-pressed", "false");
    if (hover?.cam) try { stage.previewCamera(null); } catch { /* */ }
    endOverlay();
    hover = null;
    if (live) live.queue = [];
    cancelAnimationFrame(raf); raf = 0;
  }
  function toggle(which = null) { if (panel.hidden) open(which); else close(); }
  closeB.addEventListener("click", close);
  q.addEventListener("input", () => { query = q.value.trim(); render(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = listFor()[0]; if (first) apply(first.id); }
    if (e.key === "Escape") { e.preventDefault(); if (q.value) { q.value = ""; query = ""; render(); } else close(); }
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target !== q) { e.preventDefault(); if (!ask.hidden) askNo.click(); else close(); }
  });
  // ⌘Z / ⇧⌘Z right after clicking a card: focus is on the card (or the toast), not the stage canvas, so the stage's own
  // key handler never sees it and ComfyUI would undo its graph instead. Route it to the stage history here.
  const undoKey = (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.key || "").toLowerCase() !== "z" || e.target === q) return;
    e.preventDefault(); e.stopPropagation();
    const ok = e.shiftKey ? stage.redo?.() : stage.undo?.();
    if (ok !== false) { toastUndo.hidden = true; toastSep.hidden = true; afterChange(); }
  };
  panel.addEventListener("keydown", undoKey);
  // Arrow keys move between cards (focusing one previews it, like hovering); Enter applies it. Down from the search
  // box goes to the first card, Up from the top row comes back to the search box.
  panel.addEventListener("keydown", (e) => {
    // Enter on a card applies it (handled here, so it is one apply whatever the browser does with a button's Enter).
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && ask.hidden) {
      const c = e.target.closest?.(".ss-pre-card");
      if (c && c === e.target && grid.contains(c)) { e.preventDefault(); apply(c.dataset.id); }
      return;
    }
    if (!/^Arrow(Up|Down|Left|Right)$/.test(e.key) && e.key !== "Home" && e.key !== "End") return;
    if (e.metaKey || e.ctrlKey || e.altKey || !ask.hidden) return;
    const els = [...grid.querySelectorAll(".ss-pre-card")];
    if (!els.length) return;
    const i = els.indexOf(e.target.closest?.(".ss-pre-card"));
    if (e.target === q) {
      if (e.key !== "ArrowDown") return;
      e.preventDefault(); focusCard(els[0]); return;
    }
    if (i < 0) return;
    const top0 = els[0].offsetTop;
    const cols = Math.max(1, els.findIndex((x) => x.offsetTop !== top0) === -1 ? els.length : els.findIndex((x) => x.offsetTop !== top0));
    let j = i;
    if (e.key === "ArrowRight") j = Math.min(els.length - 1, i + 1);
    else if (e.key === "ArrowLeft") j = Math.max(0, i - 1);
    else if (e.key === "ArrowDown") j = Math.min(els.length - 1, i + cols);
    else if (e.key === "ArrowUp") { if (i < cols) { e.preventDefault(); try { q.focus({ preventScroll: true }); } catch { /* */ } return; } j = i - cols; }
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = els.length - 1;
    e.preventDefault();
    if (j !== i) focusCard(els[j]);
  });
  function focusCard(el) {
    try { el.focus({ preventScroll: true }); } catch { /* */ }
    el.scrollIntoView?.({ block: "nearest" });
  }
  toast.addEventListener("keydown", undoKey);
  const onKey = (e) => {
    if (!root.isConnected || e.defaultPrevented) return;
    if (e.key === "Escape" && !panel.hidden && !panel.contains(e.target)) { close(); return; }
    if (!isPresetsKey(e) || root.dataset.tour || !root.getClientRects().length || !isActive()) return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  };
  window.addEventListener("keydown", onKey, true);

  // ---- the Director's `preset` tool (soundstage/presets_agent.py plans it; this runs it)
  async function registerDirectorTool() {
    try { installDirectorTool((await import("../agent/director.mjs"))?.EXEC); } catch { /* the Director (Milestone 15) isn't in this build */ }
  }
  runner.onApplied = (res) => { if (res?.source === "director") afterChange(); };

  return {
    el: panel, button, toast, runner, ready, get live() { return live; },
    open, close, toggle, apply, isOpen: () => !panel.hidden,
    undo: () => { const l = runner.undo(); afterChange(); return l; },
    redo: () => { const l = runner.redo(); afterChange(); return l; },
    saveCurrent, exportText, importText, removeUser,
    list: () => [...catalog.presets, ...runner.user].map((p) => ({ id: p.id, tab: p.tab, label: p.label, gpu: !!p.apply?.gpu })),
    destroy() { close(); window.removeEventListener("keydown", onKey, true); panel.remove(); toast.remove(); button.remove(); RUNNERS.delete(stage); },
  };
}
