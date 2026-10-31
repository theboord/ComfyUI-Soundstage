// Canvas layout ("everything in the canvas"): the big 3D / preview canvas is the whole workspace and every step's
// settings float on top of it as compact, translucent, collapsible panels, like an animation or VFX app. Nothing
// scrolls the page; a panel scrolls inside itself only when it has to. Tab or H hides every panel to see the canvas.
//
// It never rebuilds a control: the same elements move into the panels (a placeholder remembers where each came from),
// so every listener keeps working and "Classic layout" puts every element back exactly where it was.

const LS_LAYOUT = "ss_layout";

/** "canvas" (default) or "classic", remembered per browser. */
export function layoutPref(storage = globalThis.localStorage) {
  try { return storage?.getItem(LS_LAYOUT) === "classic" ? "classic" : "canvas"; } catch { return "canvas"; }
}

export function setLayoutPref(v, storage = globalThis.localStorage) {
  try { storage?.setItem(LS_LAYOUT, v === "classic" ? "classic" : "canvas"); } catch { /* storage blocked */ }
}

/** A remembered on/off flag (a panel's collapsed state, an open section). */
export function rememberFlag(key, dflt, storage = globalThis.localStorage) {
  return {
    get() { try { const v = storage?.getItem(key); return v == null ? dflt : v === "1"; } catch { return dflt; } },
    set(on) { try { storage?.setItem(key, on ? "1" : "0"); } catch { /* storage blocked */ } },
  };
}

/** Moves elements into the canvas panels and back. Each moved element leaves a comment where it was. */
export class Mover {
  constructor() { this.list = []; this.cls = []; }
  /** Add a class until restore() (only if the element did not have it already). */
  addClass(node, c) {
    if (!node || node.classList.contains(c)) return;
    node.classList.add(c);
    this.cls.push([node, c]);
  }
  move(node, parent, before = null) {
    if (!node || !parent || node === parent) return node;
    if (node.parentNode) {
      const ph = document.createComment("ss-cl");
      node.parentNode.insertBefore(ph, node);
      this.list.push([node, ph]);
    }
    parent.insertBefore(node, before);
    return node;
  }
  restore() {
    for (const [node, ph] of this.list.reverse()) {
      if (ph.parentNode) { ph.parentNode.insertBefore(node, ph); ph.remove(); }
    }
    this.list = [];
    for (const [node, c] of this.cls) node.classList.remove(c);
    this.cls = [];
  }
}

const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

/**
 * A floating panel: a header (title, collapse chevron) and a body of sections. Each section is a <details> whose open
 * state is remembered. `onToggle(collapsed)` lets the canvas re-fit its picture.
 * sections: [{ title, nodes: [Element], open = true, key }]
 */
export function hudPanel({ key, title, tip = "", side = "left", collapsed = false, onToggle = null, icon = null }) {
  const flag = rememberFlag(`ss_cv_${key}`, collapsed);
  const root = el("section", `ss-hudp ss-hudp-${side}`);
  root.dataset.key = key;
  const head = el("header", "ss-hudp-head");
  const ttl = el("span", "ss-hudp-title", icon ? icon : null, el("span", "", title));
  if (tip) ttl.title = tip;
  const btn = el("button", "ss-hudp-tog");
  btn.type = "button";
  head.append(ttl, btn);
  const body = el("div", "ss-hudp-body");
  root.append(head, body);
  for (const t of ["pointerdown", "wheel"]) root.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  const set = (c, user = false) => {
    root.dataset.collapsed = String(c);
    btn.textContent = c ? "+" : "–";
    btn.title = c ? `Show ${title}` : `Collapse ${title} (Tab or H hides every panel)`;
    btn.setAttribute("aria-expanded", String(!c));
    if (user) flag.set(c);
    onToggle?.(c);
  };
  btn.addEventListener("click", () => set(root.dataset.collapsed !== "true", true));
  ttl.addEventListener("click", () => { if (root.dataset.collapsed === "true") set(false, true); });
  set(flag.get());
  const api = {
    el: root, body, head,
    collapsed: () => root.dataset.collapsed === "true",
    setCollapsed: (c) => set(c, true),
    section(stitle, nodes, { open = true, skey = null } = {}) {
      const d = el("details", "ss-hudp-sec");
      const sf = rememberFlag(`ss_cv_${key}_${skey || stitle}`, open);
      d.open = sf.get();
      d.addEventListener("toggle", () => sf.set(d.open));
      d.append(el("summary", "", stitle));
      const box = el("div", "ss-hudp-secbody");
      d.append(box);
      body.append(d);
      return { el: d, box, nodes };
    },
  };
  return api;
}

const CSS = `
/* ===== Canvas layout (.ss-cl): the canvas is the workspace; settings float over it. ===== */
.ss-stage.ss-cl { --cv-glass: rgba(26,20,31,.80); --cv-glass-strong: rgba(26,20,31,.92); --cv-edge: rgba(255,255,255,.10); }
.ss-stage.ss-cl[data-ws=wide] { height:clamp(560px, calc(100vh - 96px), 1600px); overflow:hidden !important; gap:6px !important; padding:8px !important; }
.ss-stage.ss-cl.ss-full { height:auto !important; padding:8px !important; }
.ss-stage.ss-cl[data-ws=wide] > * { flex:none; }
.ss-stage.ss-cl[data-ws=wide] > :is(.ss-ws, .ss-pipeview, .ss-scriptview, .ss-castview, .ss-dailiesview, .ss-cutview, .ss-advisorview, .ss-canvasview):not([hidden]) {
  flex:1 1 auto; min-height:0; min-width:0; overflow:auto; scrollbar-width:thin; }
.ss-stage.ss-cl[data-ws=wide] > :is(.ss-ws, .ss-pipeview) { overflow:hidden !important; }

/* Slim top: the step bar, the scene strip and the tab bar are one short line each. */
.ss-stage.ss-cl[data-ws=wide] .ss-pipe { margin:0 !important; gap:4px; flex-wrap:nowrap; }
.ss-stage.ss-cl[data-ws=wide] .ss-pipe button { flex-direction:row !important; align-items:center !important; gap:8px !important;
  padding:4px 12px !important; min-height:0; min-width:0 !important; white-space:nowrap; overflow:hidden; }
.ss-stage.ss-cl[data-ws=wide] .ss-pipe button .t { font-size:13px; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ss-stage.ss-cl[data-ws=wide] .ss-pipe button .n { flex:none; font-size:10px; }
.ss-stage.ss-cl[data-ws=wide] .ss-tabs { padding:2px; flex-wrap:nowrap; overflow:hidden; }
.ss-stage.ss-cl[data-ws=wide] .ss-tabs button { padding:4px 10px !important; white-space:nowrap; }
.ss-stage.ss-cl[data-ws=wide] .ss-scstrip { height:44px; margin:0 !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-scstrip .chip { height:40px !important; padding:2px 10px 2px 8px !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-scstrip .chip .num, .ss-stage.ss-cl[data-ws=wide] .ss-scstrip .chip b { font-size:16px; }
@media (max-width: 1360px) { .ss-stage.ss-cl[data-ws=wide] .ss-tabs .ss-brand .ss-wordmark { display:none; } }
.ss-stage .ss-layoutbtn { font-size:12px !important; padding:4px 10px !important; }

/* Panels: frosted glass over the canvas, a header that collapses them to a pill. */
.ss-stage .ss-hudp { display:flex; flex-direction:column; min-height:0; min-width:0; background:var(--cv-glass); border:1px solid var(--cv-edge);
  border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.35); backdrop-filter:blur(12px) saturate(1.2); -webkit-backdrop-filter:blur(12px) saturate(1.2); }
.ss-stage .ss-hudp-head { display:flex; align-items:center; gap:6px; padding:6px 6px 6px 12px; flex:none; min-width:0; }
.ss-stage .ss-hudp-title { flex:1 1 auto; min-width:0; display:inline-flex; gap:6px; align-items:center; font-size:11px; font-weight:700;
  letter-spacing:.08em; text-transform:uppercase; color:var(--ss-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:default; }
.ss-stage .ss-hudp-title > span { overflow:hidden; text-overflow:ellipsis; }
.ss-stage .ss-hudp[data-collapsed=true] .ss-hudp-title { cursor:pointer; color:var(--ss-text); }
.ss-stage button.ss-hudp-tog { flex:none; width:24px; height:24px; padding:0 !important; justify-content:center; font-size:15px !important; line-height:1 !important; }
.ss-stage .ss-hudp-body { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; padding:0 8px 8px; display:flex; flex-direction:column; gap:6px; }
.ss-stage .ss-hudp[data-collapsed=true] { height:auto !important; bottom:auto !important; }
.ss-stage .ss-hudp[data-collapsed=true] .ss-hudp-body { display:none; }
.ss-stage .ss-hudp-sec { border-top:1px solid var(--cv-edge); padding-top:4px; }
.ss-stage .ss-hudp-sec:first-child { border-top:0; padding-top:0; }
.ss-stage .ss-hudp-sec > summary { cursor:pointer; list-style:none; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase;
  color:var(--ss-muted); padding:5px 2px; display:flex; align-items:center; gap:6px; }
.ss-stage .ss-hudp-sec > summary::-webkit-details-marker { display:none; }
.ss-stage .ss-hudp-sec > summary::before { content:"▸"; font-size:10px; transition:transform .12s; }
.ss-stage .ss-hudp-sec[open] > summary::before { transform:rotate(90deg); }
.ss-stage .ss-hudp-secbody { display:flex; flex-direction:column; gap:8px; padding:2px 2px 6px; min-width:0; }
.ss-stage .ss-hudp .card { background:transparent !important; border:0 !important; padding:0 !important; }
.ss-stage .ss-hudp textarea { min-height:56px; }
.ss-stage .ss-hudp select { max-width:100%; min-width:0; }
.ss-stage .ss-hudp label.f { width:100%; }
.ss-stage .ss-hudp label.row { flex-wrap:nowrap !important; align-items:flex-start !important; }
.ss-stage .ss-hudp label.row > input[type=checkbox] { flex:none; margin-top:2px; }
/* One-click idea chips (music, lines), small. */
.ss-stage .ss-hudp .ss-hudp-secbody > .row > button.ghost { font-size:11px !important; padding:2px 8px !important; }
.ss-stage .ss-hudp .ss-hudp-secbody > .row { gap:4px !important; }
/* Cast in this shot, compact: small square tiles, four or five to a row; S/M/L sizes are for the classic layout. */
.ss-stage .ss-hudp .ss-sc-grid { grid-template-columns:repeat(auto-fill, minmax(76px, 1fr)) !important; gap:6px !important; }
.ss-stage .ss-hudp .ss-sc-sizes { display:none !important; }
.ss-stage .ss-hudp .ss-sc-tile { padding:3px !important; gap:3px !important; }
.ss-stage .ss-hudp .ss-sc-nm { font-size:11px !important; }
.ss-stage .ss-hudp .ss-sc-tile label { font-size:10px !important; }
.ss-stage .ss-hudp .ss-sc-acts button { font-size:10px !important; padding:1px 6px !important; }
.ss-stage .ss-hudp .ss-sc-head strong { font-size:13px !important; }
.ss-stage .ss-hudp .ss-sc-note { font-size:11px !important; }
/* Paint Studio card, compact: one button, the switch; the feature list lives in the button's tooltip. */
.ss-stage .ss-hudp .ss-paintcard { gap:8px !important; }
.ss-stage .ss-hudp :is(.ss-paint-badge, .ss-paint-feats, .ss-paint-txt) { display:none !important; }
.ss-stage .ss-hudp .ss-paint-head { gap:8px; }
.ss-stage .ss-hudp button.ss-paint-open { width:100%; justify-content:center; }
.ss-stage .ss-hudp .ss-clpip > .status { font-size:11px; }

.ss-stage .ss-clgone { display:none !important; }
.ss-stage .ss-clmedia > img:not([hidden]) ~ .ss-clclay { display:none !important; }
.ss-stage .ss-clmedia > .ss-clclay { opacity:.9; }
.ss-stage .ss-clwrap[data-lopen=true] { --cv-l:calc(var(--cv-lw,320px) + 10px); }
.ss-stage .ss-clwrap[data-ropen=true] { --cv-r:calc(var(--cv-rw,250px) + 10px); }
.ss-stage.ss-cl-hide .ss-clwrap { --cv-l:0px; --cv-r:0px; }
.ss-stage .ss-clarea[data-l=full] { --cv-l:90px; }
.ss-stage .ss-clarea[data-l=mini] { --cv-l:60px; }
.ss-stage .ss-clarea[data-l=two] { --cv-l:100px; }
.ss-stage .ss-clarea[data-r=open] { --cv-r:calc(var(--ss-insp-w,320px) + 12px); }
.ss-stage .ss-clarea[data-r=closed] { --cv-r:64px; }
.ss-stage.ss-cl-hide .ss-clarea { --cv-l:0px; --cv-r:0px; }

/* Look palette: pops over the canvas from the viewport toolbar. */
.ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-clpop { position:absolute; top:6px; left:50%; transform:translateX(-50%); width:min(620px, calc(100% - 24px));
  max-height:min(72%, 540px); z-index:30; background:var(--cv-glass-strong); }
.ss-stage .ss-clpop[hidden] { display:none !important; }
.ss-stage .ss-clpop .ss-styles { max-height:none; }
.ss-stage .ss-clpop .ss-hudp-head > button:not(.ss-hudp-tog) { font-size:12px !important; padding:3px 10px !important; flex:none; }
.ss-stage.ss-cl .ss-vphead .ss-cl-lookbtn[aria-pressed=true] { border-color:var(--ss-accent) !important; color:var(--ss-accent) !important; }

/* Tab / H: every panel hides; the canvas is all there is. */
.ss-stage.ss-cl.ss-cl-hide :is(.ss-hudp, .ss-clbottom, .ss-cl-railbox) { display:none !important; }
.ss-stage.ss-cl.ss-cl-hide:not(.ss-full) { position:relative; }
.ss-stage.ss-cl.ss-cl-hide::after { content:"Panels hidden · Tab or H brings them back"; position:absolute; right:18px; bottom:16px; z-index:40; pointer-events:none;
  font-size:11px; color:var(--ss-muted); background:var(--cv-glass-strong); border:1px solid var(--cv-edge); border-radius:999px; padding:4px 10px; }

/* ----- ③ Set / Look / Ladder: the workspace, with the rail and the inspector over the canvas ----- */
.ss-stage .ss-clarea { display:contents; }
.ss-stage.ss-cl[data-ws=wide] .ss-ws { position:relative; grid-template-columns:minmax(0,1fr) !important; grid-template-areas:"center" "bottom" !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-ws > .ss-center { overflow:hidden !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clarea { display:flex; flex-direction:column; position:relative; flex:1 1 auto; min-height:0; min-width:0; }
.ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-vpcell { padding:0 var(--cv-r,0px) 0 var(--cv-l,0px); }
.ss-stage.ss-cl[data-ws=wide] .ss-clarea > :is(.ss-ladder, .ss-lookview):not([hidden]) { flex:1 1 auto; min-height:0; box-sizing:border-box;
  padding:0 var(--cv-r,0px) 0 var(--cv-l,0px); }
.ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-lookview:not([hidden]) { overflow:auto; scrollbar-width:thin; }
.ss-stage.ss-cl[data-ws=wide] .ss-cl-railbox { position:absolute; left:6px; top:6px; bottom:6px; z-index:20; display:flex; flex-direction:column; min-height:0; pointer-events:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-cl-railbox > .ss-rail { pointer-events:auto; max-height:100%; overflow-y:auto; overflow-x:hidden; scrollbar-width:none; border-radius:14px; }
.ss-stage.ss-cl[data-ws=wide] .ss-cl-railbox .ss-dock { background:var(--cv-glass) !important; backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  border-color:var(--cv-edge) !important; min-height:0 !important; width:76px !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-cl-railbox button.ss-tool { padding:6px 2px 5px !important; }
.ss-stage.ss-cl[data-ws=wide][data-railmini=true] .ss-cl-railbox .ss-dock { width:46px !important; }
.ss-stage.ss-cl[data-ws=wide]:is([data-railmini=true], [data-railmini=two]) .ss-cl-railbox button.ss-tool { font-size:0 !important; gap:0 !important; padding:7px 2px !important; }
.ss-stage.ss-cl[data-ws=wide][data-railmini=two] .ss-cl-railbox .ss-dock { display:grid !important; grid-template-columns:repeat(2, 38px); width:auto !important; gap:2px; }
.ss-stage.ss-cl[data-ws=wide][data-railmini=two] .ss-cl-railbox .ss-dock-sep { grid-column:1 / -1; height:1px; width:auto; margin:3px 6px; }
.ss-stage.ss-cl[data-ws=wide] .ss-cl-railbox .ss-cl-railtog { pointer-events:auto; align-self:flex-start; margin-top:4px; flex:none; font-size:11px !important;
  padding:3px 9px !important; background:var(--cv-glass) !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-insp.ss-hudp { position:absolute; right:6px; top:6px; bottom:6px; z-index:20; width:var(--ss-insp-w,320px);
  padding:0 !important; background:var(--cv-glass) !important; border-color:var(--cv-edge) !important; gap:4px; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp > .ss-insp-tabs { margin:0 6px; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp > .ss-insp-body { padding:0 6px 6px; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp[data-collapsed=true] { width:auto; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp[data-collapsed=true] > :is(.ss-insp-body) { display:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp[data-collapsed=true] > .ss-insp-tabs { flex-direction:column; margin:0 4px 4px; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp[data-collapsed=true] > .ss-insp-tabs button.ss-insp-tab { padding:6px 4px !important; font-size:0 !important; gap:0 !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp.ss-hudp[data-collapsed=true] .ss-hudp-title > span { display:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-insp .ss-hudp-head { padding:4px 4px 2px 10px; }
/* The viewport header and the timeline read as HUD bars on the same glass. */
.ss-stage.ss-cl[data-ws=wide] .ss-vphead { padding:0 2px; }
.ss-stage.ss-cl[data-ws=wide] .ss-ws > .ss-bottom > .ss-time, .ss-stage.ss-cl[data-ws=wide] .ss-bottomscroll { background:var(--cv-glass); }
.ss-stage.ss-cl[data-ws=wide] .ss-bottomscroll { max-height:clamp(60px, 16vh, 200px); }
/* ⑥ Review: the compare bar is a floating bar on top of the ladder, the shots a filmstrip. */
.ss-stage.ss-cl[data-ws=wide] .ss-ladder > .ss-lcmp { align-self:center; margin:0 0 6px !important; padding:4px 8px; border-radius:999px; background:var(--cv-glass);
  border:1px solid var(--cv-edge); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); flex-wrap:nowrap; max-width:100%; overflow-x:auto; scrollbar-width:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-ladder > .ss-shotrow { margin:0 0 6px !important; }

/* Shot rows and candidates as one-line filmstrips. */
.ss-stage.ss-cl[data-ws=wide] .ss-shotrow { flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; padding:2px; gap:6px; scrollbar-width:thin; align-items:stretch; }
.ss-stage.ss-cl[data-ws=wide] .ss-shotrow > .lbl { font-size:11px; writing-mode:horizontal-tb; }
.ss-stage.ss-cl[data-ws=wide] .ss-shotrow button.shot { flex:0 0 112px !important; padding:3px !important; gap:1px !important; border-width:2px !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-shotrow .shot :is(img, canvas) { height:46px; aspect-ratio:auto; }
.ss-stage.ss-cl[data-ws=wide] .ss-shotrow .shot .nm { font-size:11px; }
.ss-stage.ss-cl[data-ws=wide] .ss-shotrow .shot .st { font-size:10px; }

/* ----- ④ Frame, ⑤ Motion, ⑦ Deliver: the result fills the canvas; the settings dock on its edges ----- */
.ss-stage .ss-clwrap { display:contents; }
.ss-stage .ss-dcanvas { display:none; }
.ss-stage.ss-cl .ss-dcanvas { display:block; }
.ss-stage.ss-cl[data-ws=wide] .ss-pipeview:not([hidden]) { display:flex; flex-direction:column; gap:6px; padding:0 !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-pipeview > :is(h3, .lede) { display:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap { display:block; position:relative; flex:1 1 auto; min-height:0; min-width:0; border-radius:14px; overflow:hidden;
  background:radial-gradient(120% 90% at 50% 40%, #241c2b 0%, #120e16 100%); border:1px solid var(--ss-line); }
.ss-stage.ss-cl[data-ws=wide] .ss-clmedia { position:absolute; top:8px; bottom:8px; left:calc(8px + var(--cv-l,0px)); right:calc(8px + var(--cv-r,0px));
  display:flex; align-items:center; justify-content:center; min-width:0; min-height:0; }
.ss-stage.ss-cl .ss-clmedia > :is(img, video, canvas) { max-width:100%; max-height:100%; width:auto !important; height:auto; object-fit:contain; border-radius:10px !important;
  border:1px solid var(--cv-edge) !important; background:#000; display:block; aspect-ratio:auto !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clmedia > :is(img, canvas) { width:100% !important; height:100% !important; background:transparent; border:0 !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clmedia > video { width:100% !important; height:100% !important; background:transparent; border:0 !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clmedia > .card { display:contents; }
.ss-stage.ss-cl[data-ws=wide] .ss-clmedia > .card > :not(video) { display:none !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clmedia > .card > .ss-appr-row:not([hidden]) { display:flex !important; position:absolute; left:50%; bottom:6px; transform:translateX(-50%);
  background:var(--cv-glass-strong); border-radius:999px; padding:4px 10px; z-index:3; }
.ss-stage.ss-cl .ss-clempty { color:var(--ss-faint); font-size:13px; text-align:center; max-width:360px; }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-hudp { position:absolute; z-index:5; top:8px; max-height:calc(100% - 16px); }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-hudp-left { left:8px; bottom:8px; width:var(--cv-lw,320px); }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-hudp-right { right:8px; width:var(--cv-rw,250px); }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-hudp-right.ss-tall { bottom:8px; }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-hudp[data-collapsed=true] { width:auto; max-width:240px; }
.ss-stage.ss-cl[data-ws=wide] .ss-clpill { position:absolute; z-index:4; top:10px; left:50%; transform:translateX(-50%); max-width:min(640px, 56%);
  background:var(--cv-glass-strong); border:1px solid var(--cv-edge); border-radius:999px; padding:5px 14px !important; font-size:12px !important;
  color:var(--ss-text) !important; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-clpill:empty { display:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-clpip { position:relative; }
.ss-stage.ss-cl .ss-clpip :is(img, canvas) { width:100% !important; border-radius:8px; display:block; }

/* Bottom dock: the filmstrips (shots, frame candidates), then the HUD bar with the main actions. */
.ss-stage .ss-clbottom { display:flex; flex-direction:column; gap:6px; min-width:0; flex:none; }
.ss-stage .ss-clfilm { display:flex; gap:10px; min-width:0; align-items:stretch; }
.ss-stage .ss-clfilm > * { min-width:0; }
.ss-stage .ss-clfilm .ss-clgrp { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1 1 0; }
.ss-stage .ss-clfilm .ss-clgrp.ss-clshots { flex:0 1 auto; max-width:55%; }
.ss-stage .ss-clfilm .ss-clgrp > .ss-cllab { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ss-faint); font-weight:700;
  display:flex; align-items:center; gap:8px; min-width:0; white-space:nowrap; }
.ss-stage .ss-clfilm .ss-scenehead:not([hidden]) { flex:none; }
.ss-stage .ss-clfilm .ss-scenehead { font-size:11px; }
.ss-stage.ss-cl .ss-clfilm .grid { display:flex !important; gap:6px; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; padding:2px; min-height:0; }
.ss-stage.ss-cl .ss-clfilm .grid:empty::before { content:"Generated frames land here: pick one with a click."; color:var(--ss-faint); font-size:12px; align-self:center; padding:0 6px; }
.ss-stage.ss-cl .ss-clfilm .cand { flex:0 0 auto; width:116px; border-width:2px; border-radius:10px; }
.ss-stage.ss-cl .ss-clfilm .cand img { height:58px; aspect-ratio:auto; }
.ss-stage.ss-cl .ss-clfilm .cand .cap { left:3px; right:3px; bottom:3px; font-size:10px; }
.ss-stage.ss-cl .ss-clfilm .cand .cap > span:first-child { display:none; }
.ss-stage.ss-cl .ss-clfilm .cand .pill { padding:1px 6px; font-size:10px; }
.ss-stage .ss-clbar { display:flex; align-items:center; gap:8px 10px; flex-wrap:wrap; min-width:0; padding:6px 8px; border-radius:14px;
  background:var(--cv-glass); border:1px solid var(--cv-edge); }
.ss-stage .ss-clbar > * { flex:none; }
.ss-stage .ss-clbar .ss-clsp { flex:1 1 0; min-width:0; }
.ss-stage .ss-clbar .row { gap:6px !important; flex-wrap:nowrap !important; }
.ss-stage .ss-clbar label.f { flex-direction:row !important; align-items:center; gap:6px !important; }
.ss-stage .ss-clbar select { max-width:230px; padding:5px 8px !important; }
.ss-stage .ss-clbar .seg button { padding:4px 10px !important; }
.ss-stage .ss-clbar .status { font-size:11px; color:var(--ss-muted); }
.ss-stage .ss-clbar button.go { padding:7px 14px !important; }
.ss-stage .ss-clbar .ss-cldiv { width:1px; align-self:stretch; background:var(--cv-edge); margin:2px 2px; }

/* A narrower window: the bar drops the words its controls don't need ("Image model", "Quality"); tooltips keep them. */
.ss-stage .ss-clbottom { container-type:inline-size; }
@container (max-width: 1420px) {
  .ss-stage .ss-clbar > label.f.ss-cltight { font-size:0 !important; gap:0 !important; }
  .ss-stage .ss-clbar > label.f.ss-cltight > select { font-size:13px; max-width:200px; }
  .ss-stage .ss-clbar > .row.ss-cltight > .status { display:none; }
}
/* Narrow (the App's side panel): everything stacks under the canvas, nothing floats. */
.ss-stage.ss-cl[data-ws=narrow] .ss-clwrap { display:flex; flex-direction:column; gap:8px; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clmedia { display:flex; justify-content:center; min-height:120px; }
.ss-stage.ss-cl[data-ws=narrow] .ss-pipeview > :is(h3) { font-size:15px; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clpill:empty { display:none; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clfilm { flex-direction:column; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clfilm .ss-clgrp.ss-clshots { max-width:none; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clfilm .grid { display:flex !important; overflow-x:auto; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clfilm .cand { flex:0 0 auto; width:120px; }
.ss-stage.ss-cl[data-ws=narrow] .ss-clfilm .cand img { height:62px; }
.ss-stage.ss-cl[data-ws=narrow] .ss-cl-railbox { display:contents; }
.ss-stage.ss-cl[data-ws=narrow] .ss-cl-railtog, .ss-stage.ss-cl[data-ws=narrow] .ss-insp .ss-hudp-head { display:none; }
.ss-stage.ss-cl[data-ws=narrow] .ss-insp.ss-hudp[data-collapsed=true] .ss-insp-body { display:block; }
/* Paint Studio takes the whole canvas while it is open. */
.ss-stage.ss-cl[data-ws=wide] .ss-frameview.ss-painting .ss-clwrap > :is(.ss-hudp) { display:none !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-frameview.ss-painting .ss-clfilm .ss-clcands { display:none; }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-edithost:not(:empty) { position:absolute; inset:0; z-index:7; overflow:hidden; background:var(--ss-bg);
  display:flex; flex-direction:column; padding:6px; }
/* Paint Studio (the Canvas tab, and inside ④ Frame) fills the height it is given instead of a fixed 60vh view. */
.ss-stage.ss-cl[data-ws=wide] > .ss-canvasview:not([hidden]), .ss-stage.ss-cl[data-ws=wide] .ss-edithost > .ss-canvasview:not([hidden]) {
  display:flex; flex-direction:column; min-height:0; overflow:hidden !important; flex:1 1 auto; }
.ss-stage.ss-cl[data-ws=wide] .ss-canvasview > .ss-cv:not(.ss-cv-narrow) { flex:1 1 auto; min-height:0; }
.ss-stage.ss-cl[data-ws=wide] .ss-canvasview > .ss-cv:not(.ss-cv-narrow) .ss-cv-view { height:auto; min-height:200px; }
.ss-stage.ss-cl[data-ws=wide] .ss-canvasview > .ss-cv:not(.ss-cv-narrow) .ss-cv-side { min-height:0; overflow-y:auto; scrollbar-width:thin; }
.ss-stage.ss-cl[data-ws=wide] .ss-clwrap > .ss-clclose { position:absolute; z-index:8; top:8px; right:8px; }
`;

export function applyCanvasCss() {
  if (document.getElementById("soundstage-canvasui")) return;
  const s = document.createElement("style");
  s.id = "soundstage-canvasui";
  s.textContent = CSS;
  document.head.appendChild(s);   // after the theme, so it wins ties
}

export const cvEl = el;
