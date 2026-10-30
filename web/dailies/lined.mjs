// Lined script: the scene's page in screenplay format with a script supervisor's coverage lines beside it, like a
// lined script page or Avid ScriptSync. One vertical line per setup, in that setup's colour, with its thumbnail and
// slate ("12B") at the top: a straight stretch = on camera, a zig-zag = rolling but off screen. Hover a line to see its
// text, drag its ends to re-line it (snaps to whole script elements), Alt-click to flip a stretch on/off camera, and
// click anywhere on a line to open that setup's take at that line (ScriptSync-style jump).
//
//   import { LinedScript } from "./dailies/lined.mjs";
//   const lined = new LinedScript(el, { getScene, getShots, getRenders, getCoverage, setCoverage, onOpenTake });
//   lined.refresh();            // after the scene, shots, renders or coverage change
//
// Host: getScene() -> Script scene ({id, number, heading, elements}); getShots() -> [{id, name, setup, scene_id, ...}]
// (this scene's shots are the ones with scene_id === scene.id, in setup order); getRenders(shotId, shot) -> anything
// takesFor accepts (model.mjs); getCoverage(shot) -> the shot's saved coverage, undefined for "use the default", null
// for "not lined"; setCoverage(shotId, {from, to, offscreen}) persists an edit; onOpenTake(shot, take, {elementIndex,
// fraction, offset?}). Optional: getTakes(shot) overrides takesFor (the bin passes its circled state this way),
// onStatus(msg), onHover(shotId|null).
import { coverageFor, defaultCoverage, setupLabel, sceneShots, takesFor, heroTake, setupColor, setupKind, SETUP_KIND_LABEL,
  isOffscreen, toggleOffscreen, moveCoverageEnd, syncPoint, fmtDuration } from "./model.mjs";

const SVGNS = "http://www.w3.org/2000/svg";
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
const s = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  return e;
};
function guard(el) {
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
}

const MONO = `"Courier Prime", "Courier Final Draft", "Courier New", Courier, monospace`;
const FONT = `"Soundstage Grotesk", "PP Formula", ui-sans-serif, system-ui, sans-serif`;
const COL_MAX = 64, COL_MIN = 22, THUMB_MIN_COL = 44;

const STYLE = `
.ss-lined { --lp-text:#f0efed; --lp-muted:rgba(240,239,237,.56); --lp-faint:rgba(240,239,237,.36); --lp-line:rgba(255,255,255,.08);
  --lp-line2:rgba(255,255,255,.16); --lp-accent:#f2ff59; --lp-paper:#fbf8f0; --lp-ink:#1f1c18;
  display:flex; flex-direction:column; gap:10px; min-width:0; min-height:0; flex:1 1 auto; color:var(--lp-text); font:13px/1.4 ${FONT}; }
.ss-lined *, .ss-lined *::before, .ss-lined *::after { box-sizing:border-box; }
.ss-lined .lp-legend { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.ss-lined .lp-legend .lbl { text-transform:uppercase; letter-spacing:.08em; font-size:11px; font-weight:600; color:var(--lp-muted); margin-right:4px; }
.ss-lined button.lp-chip { display:inline-flex; align-items:center; gap:7px; cursor:pointer; font:inherit; font-size:12px;
  background:rgba(255,255,255,.04) !important; color:var(--lp-text) !important; border:1px solid var(--lp-line) !important;
  border-radius:999px !important; padding:3px 10px 3px 6px !important; transition:background .12s, border-color .12s; }
.ss-lined button.lp-chip:hover, .ss-lined button.lp-chip[data-hot=true] { background:rgba(255,255,255,.09) !important; border-color:var(--lp-line2) !important; }
.ss-lined button.lp-chip .sw { width:10px; height:10px; border-radius:3px; background:var(--c); flex:none; }
.ss-lined button.lp-chip b { font:700 11.5px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing:.02em; }
.ss-lined button.lp-chip .nm { color:var(--lp-muted); max-width:16ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-lined button.lp-chip[data-unlined=true] { border-style:dashed !important; }
.ss-lined button.lp-chip[data-unlined=true] .sw { background:transparent; border:1.5px dashed var(--c); }
.ss-lined button:focus-visible, .ss-lined [tabindex]:focus-visible { outline:2px solid var(--lp-accent) !important; outline-offset:2px; }

.ss-lined .lp-scroll { overflow:auto; min-height:0; flex:1 1 auto; border-radius:12px; background:#17121b; border:1px solid var(--lp-line);
  padding:22px 18px 28px; }
.ss-lined .lp-page { position:relative; margin:0 auto; width:fit-content; min-width:min(100%, 820px); background:var(--lp-paper); color:var(--lp-ink); border-radius:3px;
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset, 0 18px 50px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3);
  padding:34px 22px 56px 0; font:14px/1.3 ${MONO}; }
.ss-lined .lp-page::before { content:""; position:absolute; left:20px; top:0; bottom:0; width:16px;
  background:radial-gradient(circle at 8px 50%, #2a2330 0 4.5px, rgba(0,0,0,.1) 5.5px, transparent 6.5px) 0 0 / 16px 33.3% repeat-y;
  background-position:0 16.6%; opacity:.7; pointer-events:none; }
.ss-lined .lp-pnum { position:absolute; top:16px; right:26px; font:14px ${MONO}; color:#3b362f; }
.ss-lined .lp-revnote { position:absolute; top:16px; left:64px; font:600 10px/1 ${FONT}; letter-spacing:.12em; text-transform:uppercase; color:#a39b8c; }
.ss-lined .lp-cols { position:relative; display:flex; align-items:flex-start; }
.ss-lined .lp-text { position:relative; flex:none; width:61ch; margin-left:9ch; padding-top:58px; }
.ss-lined .lp-head { display:flex; justify-content:space-between; font-weight:700; margin:0 0 1.3em; position:relative; }
.ss-lined .lp-head .num { position:absolute; left:-6ch; }
.ss-lined .lp-head .num.r { left:auto; right:-4ch; }
.ss-lined .lp-el { position:relative; white-space:pre-wrap; margin:0 0 1.3em; border-radius:2px; transition:background .1s; }
.ss-lined .lp-el.character { margin:0 0 0 22ch; width:fit-content; max-width:36ch; text-transform:uppercase; }
.ss-lined .lp-el.parenthetical { margin:0 0 0 16ch; width:25ch; }
.ss-lined .lp-el.dialogue { margin:0 0 1.3em 10ch; width:36ch; }
.ss-lined .lp-el.character + .lp-el.dialogue, .ss-lined .lp-el.parenthetical + .lp-el.dialogue { margin-top:0; }
.ss-lined .lp-el.dialogue:has(+ .lp-el.parenthetical) { margin-bottom:0; }
.ss-lined .lp-el.transition { text-align:right; text-transform:uppercase; }
.ss-lined .lp-el.centered { text-align:center; }
.ss-lined .lp-el.shot { text-transform:uppercase; font-weight:700; }
.ss-lined .lp-el.note { color:#7b7366; font-style:italic; }
.ss-lined .lp-el[data-hl] { background:var(--hlb); box-shadow:-6px 0 0 var(--hlb), 6px 0 0 var(--hlb); }
.ss-lined .lp-el[data-hl=off] { background:repeating-linear-gradient(135deg, var(--hlb) 0 5px, transparent 5px 9px);
  box-shadow:none; color:#7c766c; }
.ss-lined .lp-el[data-cursor] { outline:1.5px solid var(--hlc); outline-offset:3px; }

.ss-lined .lp-gutter { position:relative; flex:none; margin-left:6ch; overflow-x:auto; overflow-y:hidden; align-self:stretch;
  scrollbar-width:thin; }
.ss-lined .lp-page[data-tight] .lp-text { margin-left:5ch; }
.ss-lined .lp-page[data-tight] .lp-gutter { margin-left:3ch; }
.ss-lined .lp-page[data-tight] .lp-head .num { left:-4ch; }
.ss-lined .lp-page[data-tight] .lp-head .num.r { left:auto; right:-2.6ch; }
.ss-lined .lp-page[data-tight]::before { left:8px; }
.ss-lined .lp-gutter::before { content:""; position:absolute; left:0; top:44px; bottom:0; border-left:1px dashed rgba(60,50,40,.18); }
.ss-lined .lp-gutter svg { position:absolute; left:0; top:0; overflow:visible; }
.ss-lined .lp-gutter g.ln { cursor:pointer; outline:none; }
.ss-lined .lp-gutter g.ln .hit { stroke:transparent; stroke-width:16; fill:none; pointer-events:stroke; }
.ss-lined .lp-gutter g.ln .ink { fill:none; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; transition:opacity .12s, stroke-width .12s; }
.ss-lined .lp-gutter g.ln .tick { stroke-width:2.4; stroke-linecap:round; }
.ss-lined .lp-gutter g.ln .hdl { fill:var(--lp-paper); stroke-width:2; opacity:0; cursor:ns-resize; transition:opacity .12s; pointer-events:all; }
.ss-lined .lp-gutter g.ln:hover .hdl, .ss-lined .lp-gutter g.ln:focus-visible .hdl, .ss-lined .lp-gutter g.ln[data-drag] .hdl { opacity:1; }
.ss-lined .lp-gutter g.ln:hover .ink, .ss-lined .lp-gutter g.ln[data-hot] .ink, .ss-lined .lp-gutter g.ln:focus-visible .ink { stroke-width:3.4; }
.ss-lined .lp-gutter g.ln:focus-visible .hit { stroke:rgba(242,255,89,.0); }
.ss-lined .lp-gutter[data-hot] g.ln:not([data-hot]) .ink, .ss-lined .lp-gutter[data-hot] g.ln:not([data-hot]) .tick { opacity:.22; }
.ss-lined .lp-gutter[data-hot] .lp-th:not([data-hot]) { opacity:.35; }
.ss-lined .lp-th { position:absolute; display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer; transition:opacity .12s; }
.ss-lined .lp-th .im { width:100%; aspect-ratio:16/9; border-radius:3px; background:#2a2330 center/cover no-repeat;
  box-shadow:0 0 0 1.5px var(--c), 0 2px 5px rgba(0,0,0,.25); }
.ss-lined .lp-th b { font:700 11px/1.1 ui-monospace, "SF Mono", Menlo, monospace; color:var(--c); letter-spacing:.01em; white-space:nowrap;
  background:var(--lp-paper); padding:0 2px; border-radius:2px; }
.ss-lined .lp-th .circ { position:absolute; top:-6px; right:-6px; width:15px; height:15px; border-radius:50%; background:var(--c);
  color:#fff; font:700 9px/15px ${FONT}; text-align:center; box-shadow:0 0 0 1.5px var(--lp-paper); }

.ss-lined .lp-pop { position:fixed; z-index:50; width:260px; pointer-events:none; background:#2a2330; border:1px solid var(--lp-line2);
  border-radius:12px; padding:8px; box-shadow:0 18px 50px rgba(0,0,0,.55); color:var(--lp-text); }
.ss-lined .lp-pop .im { width:100%; aspect-ratio:16/9; border-radius:8px; background:#18131c center/cover no-repeat; }
.ss-lined .lp-pop .t { display:flex; align-items:center; gap:8px; margin-top:7px; }
.ss-lined .lp-pop .t b { font:700 12px/1 ui-monospace, "SF Mono", Menlo, monospace; color:var(--c); }
.ss-lined .lp-pop .t span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-lined .lp-pop .m { color:var(--lp-muted); font-size:12px; margin-top:3px; }
.ss-lined .lp-hint { color:var(--lp-faint); font-size:12px; display:flex; flex-wrap:wrap; gap:4px 16px; }
.ss-lined .lp-hint .more { color:var(--lp-accent); }
.ss-lined .lp-gutter[data-tight] .lp-th b { font-size:9.5px; letter-spacing:-.02em; padding:0 1px; }
.ss-lined .lp-hint kbd { font:600 10.5px/1 ui-monospace, Menlo, monospace; padding:2px 5px; border-radius:4px; border:1px solid var(--lp-line2); color:var(--lp-muted); }
.ss-lined .lp-empty { padding:40px; text-align:center; color:var(--lp-muted); }
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("ss-lined-css")) return;
  document.head.append(h("style", { id: "ss-lined-css" }, STYLE));
}

const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

/** SVG path for a zig-zag down a column from y1 to y2 (the off-screen squiggle). */
export function zigzag(x, y1, y2, amp = 4, step = 7) {
  const len = Math.max(0, y2 - y1);
  const n = Math.max(2, Math.round(len / step));
  const dy = len / n;
  let d = `M${x} ${y1}`;
  for (let k = 1; k <= n; k++) d += ` L${(k === n ? x : x + (k % 2 ? amp : -amp)).toFixed(1)} ${(y1 + k * dy).toFixed(1)}`;
  return d;
}

export class LinedScript {
  constructor(container, opts = {}) {
    const noop = () => {};
    this.o = { getScene: () => null, getShots: () => [], getRenders: () => null, getCoverage: (shot) => shot?.coverage,
      setCoverage: null, onOpenTake: noop, onStatus: noop, onHover: noop, getTakes: null, ...opts };
    // Without a host store, edits live on the shot object (shot.coverage), which the default getCoverage reads.
    if (!this.o.setCoverage) this.o.setCoverage = (id, cov) => { const sh = (this.o.getShots() || []).find((x) => x.id === id); if (sh) sh.coverage = cov; };
    injectCss();
    this.el = h("section", { class: "ss-lined", "aria-label": "Lined script" });
    guard(this.el);
    this.el.addEventListener("keydown", (e) => { if (e.target.closest?.("g.ln, .lp-chip")) e.stopPropagation(); });
    container.append(this.el);
    this._hot = null;
    this._drag = null;
    this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this._layoutSoon()) : null;
    this.refresh();
  }

  destroy() { this._ro?.disconnect(); this.pop?.remove(); this.el.remove(); }

  /** Re-read the scene, shots, takes and coverage and redraw. */
  refresh() {
    const scene = this.o.getScene();
    this.scene = scene;
    this.setups = sceneShots(scene, this.o.getShots()).map((shot, idx) => {
      const takes = this.o.getTakes ? this.o.getTakes(shot) || [] : takesFor(shot, this.o.getRenders(shot.id, shot));
      return { shot, idx, label: setupLabel(scene, idx, shot), color: setupColor(idx), takes, hero: heroTake(takes),
        cov: coverageFor(scene, shot, this.o.getCoverage(shot)) };
    });
    this._render();
  }

  // ------------------------------------------------------------------ render

  _render() {
    const sc = this.scene;
    this._ro?.disconnect();
    this.pop?.remove();
    this.pop = null;
    if (!sc) { this.el.replaceChildren(h("div", { class: "lp-empty" }, "Pick a scene to see its lined script.")); return; }
    const els = sc.elements || [];

    // Legend: one chip per setup (click = open the take, hover = show its line).
    const legend = h("div", { class: "lp-legend", role: "list", "aria-label": "Setups on this page" }, h("span", { class: "lbl" }, "Setups"),
      ...this.setups.map((st) => {
        const chip = h("button", { type: "button", class: "lp-chip", role: "listitem", "data-id": st.shot.id, "data-unlined": String(!st.cov),
          style: `--c:${st.color}`, title: st.cov ? `${st.label} · ${st.shot.name || ""}: open the ${st.hero ? `take ${st.hero.n}` : "setup"}`
            : `${st.label} is not lined yet: click to line it at the top of the scene, then drag its ends`,
          on: { click: () => this._chipClick(st), mouseenter: () => this._setHot(st.shot.id), mouseleave: () => this._setHot(null),
            focus: () => this._setHot(st.shot.id), blur: () => this._setHot(null) } },
          h("span", { class: "sw" }), h("b", {}, st.label), h("span", { class: "nm" }, st.shot.name || SETUP_KIND_LABEL[setupKind(st.shot)]));
        return chip;
      }));

    // The page.
    this.text = h("div", { class: "lp-text" },
      h("div", { class: "lp-head" }, h("span", { class: "num" }, sc.number || ""), h("span", {}, sc.heading || ""), h("span", { class: "num r" }, sc.number || "")),
      ...els.map((e, i) => h("div", { class: `lp-el ${e.type || "action"}`, "data-i": String(i) }, String(e.text ?? ""))));
    this.gutter = h("div", { class: "lp-gutter" });
    this.svg = s("svg", { "aria-label": "Coverage lines", role: "group" });
    this.gutter.append(this.svg);
    this.page = h("div", { class: "lp-page" }, h("div", { class: "lp-revnote" }, "Lined script"), h("div", { class: "lp-pnum" }, `${sc.number || ""}.`),
      h("div", { class: "lp-cols" }, this.text, this.gutter));
    // The App theme forces its UI typeface on everything but `.ss-mono` elements: the page text keeps its Courier.
    for (const e of [this.page, ...this.page.querySelectorAll("*")]) if (!e.closest(".lp-gutter") && !e.classList.contains("lp-revnote")) e.classList.add("ss-mono");
    this.scroll = h("div", { class: "lp-scroll" }, this.page);
    const hint = h("div", { class: "lp-hint" },
      h("span", {}, "Click a line to open that take at that point in the scene"),
      h("span", {}, "Drag a line's ends to re-line it"),
      h("span", {}, h("kbd", {}, "Alt"), " + click marks a line on / off camera"),
      h("span", {}, "Zig-zag = rolling, off screen"),
      this.moreHint = h("span", { class: "more", hidden: "" }));
    this.el.replaceChildren(legend, this.scroll, hint);
    this.legend = legend;
    this.text.addEventListener("click", (e) => this._textClick(e));
    this._ro?.observe(this.scroll);
    this._layout();
    // Fonts arriving change line heights.
    document.fonts?.ready?.then(() => this._layoutSoon());
  }

  _layoutSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._layout(); });
  }

  /** Measure the element boxes and draw the gutter. */
  _layout() {
    if (!this.text?.isConnected) return;
    const els = [...this.text.querySelectorAll(".lp-el")];
    const base = this.text.offsetTop;
    this.boxes = els.map((e) => ({ top: base + e.offsetTop, bottom: base + e.offsetTop + e.offsetHeight }));
    // Run a line through the gap below an element down to the next one, so a run of elements reads as one stroke.
    this.spans = this.boxes.map((b, i) => ({ top: b.top, bottom: i + 1 < this.boxes.length ? Math.max(b.bottom, this.boxes[i + 1].top - 4) : b.bottom }));
    const n = this.setups.length;
    // Gutter width: what's left of the scroll area after the text, within [n x COL_MIN, n x COL_MAX].
    // (scroll padding 36, page right padding 22: the gutter starts at its offsetLeft inside the page's columns)
    const availNow = () => Math.max(120, this.scroll.clientWidth - 36 - this.gutter.offsetLeft - 22 - 6);
    // Many setups on a narrow panel: give the lines the page's wide left margin before resorting to scrolling.
    this.page.removeAttribute("data-tight");
    if (availNow() < 12 + n * 30) this.page.setAttribute("data-tight", "");
    const avail = availNow();
    const colW = Math.max(COL_MIN, Math.min(COL_MAX, Math.floor((avail - 12) / Math.max(1, n))));
    const inner = 12 + n * colW;
    const gw = Math.min(inner, Math.max(avail, COL_MIN * 4));
    this.colW = colW;
    this.gutter.style.width = `${gw}px`;
    const height = (this.boxes.length ? this.boxes[this.boxes.length - 1].bottom : 200) + 30;
    this.gutter.style.height = `${height}px`;
    this.svg.setAttribute("width", inner);
    this.svg.setAttribute("height", height);
    this.svg.style.width = `${inner}px`;
    const hidden = inner > gw ? Math.ceil((inner - gw) / colW) : 0;
    this.gutter.toggleAttribute("data-tight", colW < 30);
    if (this.moreHint) {
      this.moreHint.hidden = !hidden;
      this.moreHint.textContent = hidden ? `Scroll the lines sideways: ${hidden} more setup${hidden > 1 ? "s" : ""} to the right` : "";
    }
    this._draw();
  }

  _x(idx) { return 6 + idx * this.colW + this.colW / 2; }

  _draw() {
    this.svg.replaceChildren();
    for (const t of this.gutter.querySelectorAll(".lp-th")) t.remove();
    const showThumb = this.colW >= THUMB_MIN_COL;
    const tw = Math.min(this.colW - 8, 58);
    for (const st of this.setups) {
      if (!st.cov) continue;
      const x = this._x(st.idx);
      const c = st.cov;
      const y1 = this.spans[c.from].top + 1, y2 = this.boxes[c.to].bottom - 1;
      const g = s("g", { class: "ln", tabindex: "0", role: "button", "data-id": st.shot.id,
        "aria-label": `Setup ${st.label}, ${st.shot.name || ""}: script elements ${c.from + 1} to ${c.to + 1}` +
          `${c.offscreen.length ? ", partly off camera" : ""}. Enter opens the take; Up and Down move the end, Shift with Up and Down moves the start.` });
      const ink = st.color;
      // Runs of on / off camera.
      const hitD = `M${x} ${y1} L${x} ${y2}`;
      g.append(s("path", { class: "hit", d: hitD }));
      let i = c.from;
      while (i <= c.to) {
        const off = isOffscreen(c, i);
        let j = i;
        while (j + 1 <= c.to && isOffscreen(c, j + 1) === off) j++;
        const a = i === c.from ? y1 : this.spans[i].top - 2;
        const b = j === c.to ? y2 : this.spans[j].bottom + 2;
        g.append(s("path", { class: "ink", stroke: ink, d: off ? zigzag(x, a, b, Math.min(4.5, this.colW / 7)) : `M${x} ${a} L${x} ${b}` }));
        i = j + 1;
      }
      // Ticks at both ends (the supervisor's bar), handles for dragging.
      const tk = Math.min(9, this.colW / 2 - 4);
      g.append(s("path", { class: "tick", stroke: ink, d: `M${x - tk} ${y1} L${x + tk} ${y1}` }));
      g.append(s("path", { class: "tick", stroke: ink, d: `M${x - tk} ${y2} L${x + tk} ${y2} M${x - 4} ${y2 - 5} L${x} ${y2} L${x + 4} ${y2 - 5}` }));
      const top = s("circle", { class: "hdl", cx: x, cy: y1, r: 5.5, stroke: ink, "data-end": "from" });
      const bot = s("circle", { class: "hdl", cx: x, cy: y2, r: 5.5, stroke: ink, "data-end": "to" });
      g.append(top, bot);
      if (this._hot === st.shot.id) g.setAttribute("data-hot", "");
      g.addEventListener("pointerenter", () => this._setHot(st.shot.id));
      g.addEventListener("pointerleave", () => { if (!this._drag) this._setHot(null); });
      g.addEventListener("focus", () => this._setHot(st.shot.id));
      g.addEventListener("blur", () => this._setHot(null));
      g.addEventListener("pointerdown", (e) => this._down(e, st));
      g.addEventListener("keydown", (e) => this._key(e, st));
      this.svg.append(g);

      // Thumbnail + slate above the line.
      const thH = showThumb ? Math.round(tw * 9 / 16) : 0;
      const th = h("div", { class: "lp-th", "data-id": st.shot.id, title: `${st.label} · ${st.shot.name || ""}`,
        style: `--c:${ink};left:${x - (showThumb ? tw : 30) / 2}px;width:${showThumb ? tw : 30}px;top:${y1 - thH - 19}px`,
        on: { click: () => this._open(st, st.cov.from), mouseenter: (e) => { this._setHot(st.shot.id); this._showPop(st, e.currentTarget); },
          mouseleave: () => { this._setHot(null); this._hidePop(); } } },
        showThumb ? h("div", { class: "im", style: st.hero?.thumb ? `background-image:url("${cssUrl(st.hero.thumb)}")` : "" }) : null,
        h("b", {}, st.label),
        showThumb && st.takes.some((t) => t.circled) ? h("span", { class: "circ", title: "Circled take" }, String(st.takes.find((t) => t.circled).n)) : null);
      this.gutter.append(th);
    }
    this._paintHot();
  }

  // ------------------------------------------------------------------ hover / highlight

  _setHot(id) {
    if (this._hot === id) return;
    this._hot = id;
    this.o.onHover?.(id);
    this._paintHot();
  }

  _paintHot() {
    if (!this.text) return;
    const st = this.setups.find((x) => x.shot.id === this._hot);
    if (st) this.gutter.setAttribute("data-hot", ""); else this.gutter.removeAttribute("data-hot");
    for (const g of this.svg.querySelectorAll("g.ln")) g.toggleAttribute("data-hot", g.dataset.id === this._hot);
    for (const t of this.gutter.querySelectorAll(".lp-th")) t.toggleAttribute("data-hot", t.dataset.id === this._hot);
    for (const c of this.legend?.querySelectorAll(".lp-chip") || []) c.setAttribute("data-hot", String(c.dataset.id === this._hot));
    const els = this.text.querySelectorAll(".lp-el");
    els.forEach((e, i) => {
      if (st?.cov && i >= st.cov.from && i <= st.cov.to) {
        e.setAttribute("data-hl", isOffscreen(st.cov, i) ? "off" : "on");
        e.style.setProperty("--hlb", hexA(st.color, isOffscreen(st.cov, i) ? 0.1 : 0.13));
        e.style.setProperty("--hlc", st.color);
      } else { e.removeAttribute("data-hl"); }
      if (this._cursor == null || i !== this._cursor) e.removeAttribute("data-cursor"); else e.setAttribute("data-cursor", "");
    });
  }

  _showPop(st, anchor) {
    this._hidePop();
    const r = anchor.getBoundingClientRect();
    const t = st.hero;
    const pop = h("div", { class: "lp-pop", style: `--c:${st.color}` },
      h("div", { class: "im", style: t?.thumb ? `background-image:url("${cssUrl(t.thumb)}")` : "" }),
      h("div", { class: "t" }, h("b", {}, t ? `${st.label}-${t.n}` : st.label), h("span", {}, st.shot.name || "")),
      h("div", { class: "m" }, st.takes.length ? `${st.takes.length} take${st.takes.length > 1 ? "s" : ""}${t?.circled ? ` · Tk ${t.n} circled` : ""}${t?.seconds ? ` · ${fmtDuration(t.seconds)}` : ""}` : "No takes yet"));
    this.el.append(pop);
    const left = Math.min(innerWidth - 270, Math.max(8, r.left + r.width / 2 - 130));
    const top = r.top > 240 ? r.top - pop.offsetHeight - 8 : r.bottom + 8;
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
    this.pop = pop;
  }

  _hidePop() { this.pop?.remove(); this.pop = null; }

  // ------------------------------------------------------------------ actions

  _elementAt(y) {
    const sp = this.spans || [];
    for (let i = 0; i < sp.length; i++) if (y < sp[i].bottom + 2) return i;
    return sp.length - 1;
  }

  _open(st, i) {
    const take = st.hero;
    if (!take) { this.o.onStatus(`${st.label} has no takes yet.`); return; }
    const at = syncPoint(this.scene, st.cov, i, take);
    this._cursor = i; this._paintHot();
    this.o.onOpenTake(st.shot, take, at);
  }

  _chipClick(st) {
    if (st.cov) { this._open(st, st.cov.from); return; }
    const cov = defaultCoverage(this.scene, { ...st.shot, setup: "master" });
    const first = cov ? { from: 0, to: Math.min(2, (this.scene.elements?.length || 1) - 1), offscreen: [] } : null;
    if (!first) return;
    this._commit(st, first, `${st.label} lined at the top of the scene: drag its ends to where it plays.`);
  }

  /** Click on the page text: open the hot (or only) setup covering that element. */
  _textClick(e) {
    const el = e.target.closest?.(".lp-el");
    if (!el) return;
    const i = +el.dataset.i;
    const hits = this.setups.filter((st) => st.cov && i >= st.cov.from && i <= st.cov.to && !isOffscreen(st.cov, i));
    if (!hits.length) return;
    // Prefer the tightest coverage (a single over the master), like ScriptSync's preferred take.
    hits.sort((a, b) => (a.cov.to - a.cov.from) - (b.cov.to - b.cov.from));
    this._open(hits[0], i);
  }

  _commit(st, cov, msg) {
    st.cov = cov;
    this.o.setCoverage(st.shot.id, cov);
    if (msg) this.o.onStatus(msg);
    this.refresh();
  }

  _down(e, st) {
    if (e.button !== 0) return;
    e.preventDefault();
    const end = e.target?.dataset?.end || null;
    const gRect = () => this.svg.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const n = this.scene.elements.length;
    const d = { st, end, moved: false, cov: st.cov };
    this._drag = d;
    const g = e.currentTarget;
    g.setAttribute("data-drag", "");
    const move = (ev) => {
      if (!d.end) return;
      if (Math.abs(ev.clientY - start.y) > 3) d.moved = true;
      if (!d.moved) return;
      const y = ev.clientY - gRect().top;
      // Snap to the nearest element boundary: tops for the start, bottoms for the end.
      let best = 0, bd = Infinity;
      this.boxes.forEach((b, i) => { const dd = Math.abs((d.end === "from" ? b.top : b.bottom) - y); if (dd < bd) { bd = dd; best = i; } });
      const next = moveCoverageEnd(st.cov, d.end, best, n);
      if (next.from !== d.cov.from || next.to !== d.cov.to) {
        // Keep dragging the same physical handle if the ends crossed.
        d.cov = next;
        const was = st.cov;
        st.cov = next;
        this._draw();
        st.cov = was;
        this.svg.querySelector(`g.ln[data-id="${cssEsc(st.shot.id)}"]`)?.setAttribute("data-drag", "");
      }
    };
    const up = (ev) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      this._drag = null;
      if (d.end && d.moved) {
        this._commit(st, d.cov, `${st.label} now covers elements ${d.cov.from + 1}–${d.cov.to + 1}.`);
        return;
      }
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) { this._draw(); return; }
      const i = this._elementAt(ev.clientY - gRect().top);
      if (ev.altKey) {
        const next = toggleOffscreen(st.cov, i);
        this._commit(st, next, `${st.label}: element ${i + 1} marked ${isOffscreen(next, i) ? "off camera" : "on camera"}.`);
        return;
      }
      this._open(st, Math.max(st.cov.from, Math.min(st.cov.to, i)));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  _key(e, st) {
    const n = this.scene.elements.length;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._open(st, st.cov.from); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const end = e.shiftKey ? "from" : "to";
      const cur = st.cov[end] + (e.key === "ArrowUp" ? -1 : 1);
      if (cur < 0 || cur >= n) return;
      const next = moveCoverageEnd(st.cov, end, cur, n);
      this._commit(st, next, `${st.label} now covers elements ${next.from + 1}–${next.to + 1}.`);
      this.svg.querySelector(`g.ln[data-id="${cssEsc(st.shot.id)}"]`)?.focus();
    }
  }
}

const cssEsc = (v) => (globalThis.CSS?.escape ? globalThis.CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));
const cssUrl = (u) => String(u).replace(/["\\\n]/g, (c) => (c === "\n" ? "" : `\\${c}`));
