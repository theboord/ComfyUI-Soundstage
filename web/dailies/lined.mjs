// ScriptSync (lined script): the scene's page in screenplay format with a script supervisor's coverage lines beside it,
// like a lined script page or Avid ScriptSync. One vertical line per setup, in that setup's colour, with its thumbnail
// and slate ("12B") at the top: a straight stretch = on camera, a zig-zag = rolling but off screen. Click anywhere on
// a line (or a line of the script) and that setup's take loads in the player beside the page (syncplayer.mjs), cued
// to that moment; the setup's takes are listed under the player, click one to swap it. Edit lining: drag a line's ends
// to re-line it (snaps to whole script elements), click a stretch to flip it on / off camera, add a line for a setup
// (or drag a take onto the page), delete a wrong line, undo (⌘Z). Edits go to the host's setCoverage (saved with
// the workflow in the App).
//
//   import { LinedScript } from "./dailies/lined.mjs";
//   const lined = new LinedScript(el, { getScene, getShots, getRenders, getCoverage, setCoverage, onOpenTake });
//   lined.refresh();            // after the scene, shots, renders or coverage change
//   lined.select(shotId, { elementIndex, takeId })   // load a setup's take in the player (what a click does)
//   lined.setEdit(true) · lined.addLine(shotId, i) · lined.deleteLine(shotId) · lined.undo() · lined.sync (what is loaded)
//
// Host: getScene() -> Script scene ({id, number, heading, elements}); getShots() -> [{id, name, setup, scene_id, ...}]
// (this scene's shots are the ones with scene_id === scene.id, in setup order); getRenders(shotId, shot) -> anything
// takesFor accepts (model.mjs); getCoverage(shot) -> the shot's saved coverage, undefined for "use the default", null
// for "not lined"; setCoverage(shotId, {from, to, offscreen} | null) persists an edit; onOpenTake(shot, take,
// {elementIndex, fraction, offset?}) opens a take full size (the player's "Full size"; every click when player:false).
// Optional: getTakes(shot) overrides takesFor (the bin passes its circled state this way), getSeconds(shot, take) for
// takes without a length (the App's shot length), onSync({shot, take, at}) after the player loads, onStatus(msg),
// onHover(shotId|null), player (default true), hintKey (localStorage key of the one-time hint; null = never show).
import { coverageFor, setupLabel, sceneShots, takesFor, heroTake, setupColor, setupKind, SETUP_KIND_LABEL,
  isOffscreen, toggleOffscreen, moveCoverageEnd, syncPoint, fmtDuration, stackThumbs, LiningHistory } from "./model.mjs";
import { SyncPlayer } from "./syncplayer.mjs";

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
const COL_MAX = 64, COL_MIN = 22;
// Thumbnails at the top of every line (16:9 + the slate under it); they stack upward when lines are close together.
const TW = 54, TH = Math.round(TW * 9 / 16), TIER_H = TH + 19, TEXT_PAD = 58;
export const SCRIPTSYNC_HINT = "Click any line to jump to that moment in the take · each colored line is a camera setup · zig-zag = off camera";

const STYLE = `
.ss-lined { --lp-text:#f0efed; --lp-muted:rgba(240,239,237,.56); --lp-faint:rgba(240,239,237,.36); --lp-line:rgba(255,255,255,.08);
  --lp-line2:rgba(255,255,255,.16); --lp-accent:#f2ff59; --lp-paper:#fbf8f0; --lp-ink:#1f1c18;
  display:flex; flex-direction:row; gap:12px; min-width:0; min-height:0; flex:1 1 auto; color:var(--lp-text); font:13px/1.4 ${FONT}; }
.ss-lined .lp-main { display:flex; flex-direction:column; gap:10px; min-width:0; min-height:0; flex:1 1 auto; }
.ss-lined > .lp-side { flex:0 0 clamp(280px, 27%, 360px); }
/* Beside the player the page sets a size smaller, so the coverage lines keep their room. */
.ss-lined[data-player] .lp-page { font-size:12.5px; }
.ss-lined[data-player] .lp-pnum { font-size:12.5px; }
@media (max-width: 820px) { .ss-lined { flex-direction:column; } .ss-lined > .lp-side { flex:0 0 auto; max-height:46%; } }
.ss-lined .lp-banner { display:flex; align-items:center; gap:10px; padding:8px 10px 8px 12px; border-radius:10px; font-size:12.5px; line-height:1.35;
  background:rgba(242,255,89,.08); border:1px solid rgba(242,255,89,.3); color:var(--lp-text); }
.ss-lined .lp-banner .ic { flex:none; width:20px; height:20px; border-radius:50%; display:grid; place-items:center; background:var(--lp-accent); color:#17121b; font-weight:800; font-size:12px; }
.ss-lined .lp-banner .tx { flex:1; min-width:0; }
.ss-lined .lp-banner button { flex:none; cursor:pointer; font:inherit; font-size:12px; background:rgba(255,255,255,.06) !important; color:var(--lp-text) !important;
  border:1px solid var(--lp-line2) !important; border-radius:999px !important; padding:3px 11px !important; }
.ss-lined .lp-banner.edit { background:rgba(242,255,89,.05); }
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
.ss-lined .lp-el[data-cursor] { outline:2px solid var(--hlc); outline-offset:3px; background:var(--hlb2, var(--hlb)); box-shadow:-6px 0 0 var(--hlb2, var(--hlb)), 6px 0 0 var(--hlb2, var(--hlb)); }

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
.ss-lined .lp-gutter[data-sel]:not([data-hot]) g.ln:not([data-sel]) .ink, .ss-lined .lp-gutter[data-sel]:not([data-hot]) g.ln:not([data-sel]) .tick { opacity:.4; }
.ss-lined .lp-gutter g.ln[data-sel] .ink { stroke-width:4; filter:drop-shadow(0 0 2.5px var(--gc)); }
.ss-lined .lp-gutter .cn { stroke-width:1.4; stroke-dasharray:2 3; fill:none; opacity:.8; pointer-events:none; }
.ss-lined .lp-gutter .cue { pointer-events:none; }
.ss-lined .lp-gutter .cue .ring { fill:none; stroke-width:2; transform-box:fill-box; transform-origin:center; animation:lp-ring 1.1s ease-out 2; }
@keyframes lp-ring { 0% { transform:scale(.6); opacity:1; } 100% { transform:scale(2.6); opacity:0; } }
.ss-lined[data-edit] .lp-gutter g.ln .hdl { opacity:1; r:6.5; }
.ss-lined[data-edit] .lp-gutter g.ln { cursor:cell; }
.ss-lined[data-edit] .lp-page { box-shadow:0 0 0 2px rgba(242,255,89,.55), 0 18px 50px rgba(0,0,0,.45); }
.ss-lined[data-placing] .lp-text .lp-el { cursor:crosshair; }
.ss-lined[data-placing] .lp-text .lp-el:hover, .ss-lined .lp-text .lp-el[data-drop] { outline:2px dashed var(--lp-ink); outline-offset:3px; }
.ss-lined .lp-th[data-sel] .im { box-shadow:0 0 0 2.5px var(--c), 0 0 12px var(--c); }
.ss-lined .lp-th { position:absolute; display:flex; flex-direction:column; align-items:center; gap:2px; cursor:pointer; transition:opacity .12s; }
.ss-lined .lp-th .im { width:100%; flex:none; aspect-ratio:16/9; border-radius:3px; background:#2a2330 center/cover no-repeat;
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
      setCoverage: null, onOpenTake: noop, onStatus: noop, onHover: noop, onSync: null, getTakes: null, getSeconds: null,
      player: true, hintKey: "ss_scriptsync_hint", ...opts };
    // Without a host store, edits live on the shot object (shot.coverage), which the default getCoverage reads.
    if (!this.o.setCoverage) this.o.setCoverage = (id, cov) => { const sh = (this.o.getShots() || []).find((x) => x.id === id); if (sh) sh.coverage = cov; };
    injectCss();
    this.el = h("section", { class: "ss-lined", "aria-label": "ScriptSync (lined script)" });
    guard(this.el);
    this.el.addEventListener("keydown", (e) => this._elKey(e));
    // ⌘Z also when the focus fell back to the page (a button that just disabled itself), while ScriptSync is on screen.
    this._docKey = (e) => {
      if (!this.el.isConnected || !this.el.getClientRects().length || this.el.contains(e.target)) return;
      if (e.target !== document.body && e.target !== document.documentElement) return;
      this._elKey(e);
    };
    document.addEventListener("keydown", this._docKey, true);
    this.main = h("div", { class: "lp-main" });
    this.el.append(this.main);
    this.history = new LiningHistory();
    this._sel = null;          // {id, takeId, i}: the setup loaded in the player, its take and the cued script element
    this._edit = false;
    this._placing = null;      // shot id waiting for a click on the page (Add line)
    if (this.o.player) {
      this.el.setAttribute("data-player", "");
      this.player = new SyncPlayer(this.el, {
        onSeek: (i) => this._cue(i, { follow: true }),
        onPickTake: (t) => { if (this._sel) { this._sel.takeId = t.id; this._loadPlayer(); } },
        onFull: (c) => this.o.onOpenTake(c.st.shot, c.take, syncPoint(this.scene, c.st.cov, c.i, { ...c.take, seconds: c.seconds })),
        onEdit: (on) => this.setEdit(on),
        onAdd: () => this._startPlacing(),
        onDelete: () => this._sel && this.deleteLine(this._sel.id),
        onUndo: () => this.undo(),
      });
    }
    // The one-time hint, the first time ScriptSync opens in this browser.
    this._hint = false;
    if (this.o.hintKey) {
      try { if (!localStorage.getItem(this.o.hintKey)) { this._hint = true; localStorage.setItem(this.o.hintKey, "1"); } } catch { /* storage blocked */ }
    }
    container.append(this.el);
    this._hot = null;
    this._drag = null;
    this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this._layoutSoon()) : null;
    this.refresh();
  }

  destroy() { this._ro?.disconnect(); document.removeEventListener("keydown", this._docKey, true); this.pop?.remove(); this.player?.destroy(); this.el.remove(); }

  /** Re-read the scene, shots, takes and coverage and redraw. */
  refresh() {
    const scene = this.o.getScene();
    if (scene?.id !== this.scene?.id) { this.history.clear(); this._sel = null; this._placing = null; this._cursor = null; }
    this.scene = scene;
    this.setups = sceneShots(scene, this.o.getShots()).map((shot, idx) => {
      const takes = this.o.getTakes ? this.o.getTakes(shot) || [] : takesFor(shot, this.o.getRenders(shot.id, shot));
      return { shot, idx, label: setupLabel(scene, idx, shot), color: setupColor(idx), takes, hero: heroTake(takes),
        cov: coverageFor(scene, shot, this.o.getCoverage(shot)) };
    });
    if (this._sel && !this.setups.some((x) => x.shot.id === this._sel.id)) this._sel = null;
    this._render();
    if (this.player) {
      // Nothing loaded yet: cue the master (the first lined setup) at the top of its line, so the player is never blank.
      if (!this._sel) { const first = this.setups.find((x) => x.cov && x.hero); if (first) { this._sel = { id: first.shot.id, takeId: first.hero.id, i: first.cov.from }; this._cursor = first.cov.from; this._paintHot(); } }
      if (this._sel) this._loadPlayer({ quiet: true });
      this._syncLining();
      this.player.resume();
    }
  }

  /** What the player has loaded: {shotId, label, takeId, n, elementIndex, fraction, offset?} or null. */
  get sync() {
    const st = this._selSetup();
    if (!st || !this._sel) return null;
    const take = st.takes.find((t) => t.id === this._sel.takeId) || st.hero;
    if (!take) return { shotId: st.shot.id, label: st.label, takeId: null, n: null, elementIndex: this._sel.i };
    const at = this._at(st, take, this._sel.i);
    return { shotId: st.shot.id, label: st.label, takeId: take.id, n: take.n, ...at };
  }

  /** Load a setup's take in the player, cued to a script element (default: the top of its line). */
  select(shotId, { elementIndex = null, takeId = null } = {}) {
    const st = this.setups.find((x) => x.shot.id === shotId);
    if (!st) return false;
    const i = elementIndex ?? st.cov?.from ?? 0;
    this._open(st, i, takeId);
    return true;
  }

  setEdit(on) {
    this._edit = !!on;
    if (!this._edit) this._placing = null;
    this.el.toggleAttribute("data-edit", this._edit);
    this.el.toggleAttribute("data-placing", !!this._placing);
    this._render();
    this._syncLining();
    this.o.onStatus(this._edit ? "Edit lining: drag a line's ends, click a stretch to flip it on / off camera, Delete line, ⌘Z to undo." : "Lining saved.");
  }

  /** Line a setup from script element i (three elements, or as long as its old line was). */
  addLine(shotId, i) {
    const st = this.setups.find((x) => x.shot.id === shotId);
    const n = this.scene?.elements?.length || 0;
    if (!st || !n) return false;
    const from = Math.max(0, Math.min(n - 1, i));
    const len = st.cov ? st.cov.to - st.cov.from : 2;
    const cov = { from, to: Math.min(n - 1, from + len), offscreen: [] };
    this._placing = null;
    this.el.removeAttribute("data-placing");
    this._commit(st, cov);
    if (this.player) this._open(this.setups.find((x) => x.shot.id === shotId), from, this._sel?.id === shotId ? this._sel.takeId : null);
    this.o.onStatus(`${st.label} lined from script line ${from + 1}: drag its ends to where it plays.`);
    return true;
  }

  deleteLine(shotId) {
    const st = this.setups.find((x) => x.shot.id === shotId);
    if (!st?.cov) return false;
    this._commit(st, null, `${st.label}'s line is off the script. Undo (⌘Z) brings it back; + Add line draws it again.`);
    return true;
  }

  undo() {
    const u = this.history.undo();
    if (!u) { this.o.onStatus("Nothing to undo."); return false; }
    this.o.setCoverage(u.id, u.cov);
    const st = this.setups.find((x) => x.shot.id === u.id);
    this.o.onStatus(`Undone: ${st?.label || "the setup"} ${u.cov ? `covers script lines ${u.cov.from + 1}–${u.cov.to + 1} again` : "is not lined again"}.`);
    this.refresh();
    return true;
  }

  // ------------------------------------------------------------------ render

  _render() {
    const sc = this.scene;
    this._ro?.disconnect();
    this.pop?.remove();
    this.pop = null;
    if (!sc) { this.main.replaceChildren(h("div", { class: "lp-empty" }, "Pick a scene to see its lined script.")); this.text = null; return; }
    const els = sc.elements || [];

    // Legend: one chip per setup (click = load it in the player, hover = show its line).
    const legend = h("div", { class: "lp-legend", role: "list", "aria-label": "Setups on this page" }, h("span", { class: "lbl" }, "Setups"),
      ...this.setups.map((st) => {
        const chip = h("button", { type: "button", class: "lp-chip", role: "listitem", "data-id": st.shot.id, "data-unlined": String(!st.cov),
          "aria-pressed": String(this._sel?.id === st.shot.id), style: `--c:${st.color}`,
          title: st.cov ? `${st.label} · ${st.shot.name || ""}: load ${st.hero ? `take ${st.hero.n}` : "it"} in the player`
            : `${st.label} is not lined yet: click, then + Add line (or drag one of its takes onto the script)`,
          on: { click: () => this._chipClick(st), mouseenter: () => this._setHot(st.shot.id), mouseleave: () => this._setHot(null),
            focus: () => this._setHot(st.shot.id), blur: () => this._setHot(null) } },
          h("span", { class: "sw" }), h("b", {}, st.label), h("span", { class: "nm" }, st.shot.name || SETUP_KIND_LABEL[setupKind(st.shot)]));
        return chip;
      }));

    // The page.
    this.text = h("div", { class: "lp-text" },
      h("div", { class: "lp-head" }, h("span", { class: "num" }, sc.number || ""), h("span", {}, sc.heading || ""), h("span", { class: "num r" }, sc.number || "")),
      ...els.map((e, i) => h("div", { class: `lp-el ${e.type || "action"}`, "data-i": String(i) }, String(e.text ?? ""))));
    if (this._textPad) this.text.style.paddingTop = `${this._textPad}px`;
    this.gutter = h("div", { class: "lp-gutter" });
    this.svg = s("svg", { "aria-label": "Coverage lines", role: "group" });
    this.gutter.append(this.svg);
    this.page = h("div", { class: "lp-page" }, h("div", { class: "lp-revnote" }, "ScriptSync · lined script"), h("div", { class: "lp-pnum" }, `${sc.number || ""}.`),
      h("div", { class: "lp-cols" }, this.text, this.gutter));
    // The App theme forces its UI typeface on everything but `.ss-mono` elements: the page text keeps its Courier.
    for (const e of [this.page, ...this.page.querySelectorAll("*")]) if (!e.closest(".lp-gutter") && !e.classList.contains("lp-revnote")) e.classList.add("ss-mono");
    const keepTop = this.scroll ? [this.scroll.scrollLeft, this.scroll.scrollTop] : null;
    this.scroll = h("div", { class: "lp-scroll" }, this.page);
    const hint = h("div", { class: "lp-hint" },
      h("span", {}, "Click a line to play that take from there"),
      this.player ? h("span", {}, "✎ Edit lining (beside the player) to fix a line") : h("span", {}, "Drag a line's ends to re-line it"),
      h("span", {}, "Zig-zag = rolling, off screen"),
      this.moreHint = h("span", { class: "more", hidden: "" }));
    const kids = [];
    if (this._hint) {
      kids.push(h("div", { class: "lp-banner", role: "note" }, h("span", { class: "ic", "aria-hidden": "true" }, "i"), h("span", { class: "tx" }, SCRIPTSYNC_HINT),
        h("button", { type: "button", on: { click: () => { this._hint = false; this._render(); } } }, "Got it")));
    }
    if (this._edit) {
      kids.push(h("div", { class: "lp-banner edit", role: "status" }, h("span", { class: "ic", "aria-hidden": "true" }, "✎"),
        h("span", { class: "tx" }, this._placing ? `Click the script line where ${this._selSetup()?.label || "the setup"} starts (Esc cancels).`
          : "Editing the lining: drag a line's top or bottom dot · click a stretch to flip on / off camera · Delete removes the selected line · ⌘Z undoes"),
        h("button", { type: "button", on: { click: () => this.setEdit(false) } }, "Done")));
    }
    this.main.replaceChildren(...kids, legend, this.scroll, hint);
    if (keepTop) { this.scroll.scrollLeft = keepTop[0]; this.scroll.scrollTop = keepTop[1]; }
    this.legend = legend;
    this.text.addEventListener("click", (e) => this._textClick(e));
    this._dropTarget();
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
  _layout(again = true) {
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
    if (availNow() < TW + n * 30) this.page.setAttribute("data-tight", "");
    const avail = availNow();
    const colW = Math.max(COL_MIN, Math.min(COL_MAX, Math.floor((avail - TW) / Math.max(1, n))));
    // Room either side for the first and last thumbnails.
    this.padL = Math.max(6, Math.ceil(TW / 2 - colW / 2) + 2);
    const inner = 2 * this.padL + n * colW + 6;   // (+ room for the last thumbnail's circled-take badge)
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
    // Thumbnails stack upward where lines start close together: make room above the scene heading for them.
    const lined = this.setups.filter((st) => st.cov);
    this.tiers = new Map();
    const tiers = stackThumbs(lined.map((st) => ({ x: this._x(st.idx), y: this.spans[st.cov.from].top })), TW + 4, TIER_H);
    lined.forEach((st, k) => this.tiers.set(st.shot.id, tiers[k]));
    const pad = this._textPad || TEXT_PAD;
    const minTop = lined.length ? Math.min(...lined.map((st, k) => this.spans[st.cov.from].top - (tiers[k] + 1) * TIER_H)) : 100;
    const want = TEXT_PAD + Math.max(0, 10 - (minTop - (pad - TEXT_PAD)));
    if (again && want !== pad) {
      this._textPad = want === TEXT_PAD ? 0 : want;
      this.text.style.paddingTop = `${want}px`;
      this._layout(false);
      return;
    }
    this._draw();
  }

  _x(idx) { return this.padL + idx * this.colW + this.colW / 2; }

  _draw() {
    this.svg.replaceChildren();
    for (const t of this.gutter.querySelectorAll(".lp-th")) t.remove();
    const tw = TW;
    for (const st of this.setups) {
      if (!st.cov) continue;
      const x = this._x(st.idx);
      const c = st.cov;
      const y1 = this.spans[c.from].top + 1, y2 = this.boxes[c.to].bottom - 1;
      const g = s("g", { class: "ln", tabindex: "0", role: "button", "data-id": st.shot.id, style: `--gc:${st.color}`,
        "aria-label": `Setup ${st.label}, ${st.shot.name || ""}: script elements ${c.from + 1} to ${c.to + 1}` +
          `${c.offscreen.length ? ", partly off camera" : ""}. Enter loads the take in the player; Up and Down move the end, Shift with Up and Down moves the start.` });
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

      // Thumbnail + slate at the top of the line (stacked up a tier or more where lines start close together),
      // with a dotted lead down to the line's first tick.
      const tier = this.tiers?.get(st.shot.id) || 0;
      const thTop = y1 - (tier + 1) * TIER_H + 2;
      if (tier > 0) this.svg.insertBefore(s("path", { class: "cn", stroke: ink, d: `M${x} ${thTop + TIER_H - 3} L${x} ${y1 - 2}` }), this.svg.firstChild);
      const th = h("div", { class: "lp-th", "data-id": st.shot.id, title: `${st.label} · ${st.shot.name || ""}: load in the player`,
        style: `--c:${ink};left:${x - tw / 2}px;width:${tw}px;top:${thTop}px`,
        on: { click: () => this._open(st, st.cov.from), mouseenter: (e) => { this._setHot(st.shot.id); this._showPop(st, e.currentTarget); },
          mouseleave: () => { this._setHot(null); this._hidePop(); } } },
        h("div", { class: "im", style: st.hero?.thumb ? `background-image:url("${cssUrl(st.hero.thumb)}")` : "" }),
        h("b", {}, st.label),
        st.takes.some((t) => t.circled) ? h("span", { class: "circ", title: "Circled take" }, String(st.takes.find((t) => t.circled).n)) : null);
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

  _selSetup() { return this._sel ? this.setups.find((x) => x.shot.id === this._sel.id) || null : null; }

  _paintHot() {
    if (!this.text) return;
    const selId = this._sel?.id || null;
    const showId = this._hot || selId;
    const st = this.setups.find((x) => x.shot.id === showId);
    this.gutter.toggleAttribute("data-hot", !!this._hot && !!this.setups.find((x) => x.shot.id === this._hot));
    this.gutter.toggleAttribute("data-sel", !!selId);
    for (const g of this.svg.querySelectorAll("g.ln")) { g.toggleAttribute("data-hot", g.dataset.id === this._hot); g.toggleAttribute("data-sel", g.dataset.id === selId); }
    for (const t of this.gutter.querySelectorAll(".lp-th")) { t.toggleAttribute("data-hot", t.dataset.id === this._hot); t.toggleAttribute("data-sel", t.dataset.id === selId); }
    for (const c of this.legend?.querySelectorAll(".lp-chip") || []) { c.setAttribute("data-hot", String(c.dataset.id === this._hot)); c.setAttribute("aria-pressed", String(c.dataset.id === selId)); }
    const els = this.text.querySelectorAll(".lp-el");
    els.forEach((e, i) => {
      if (st?.cov && i >= st.cov.from && i <= st.cov.to) {
        e.setAttribute("data-hl", isOffscreen(st.cov, i) ? "off" : "on");
        e.style.setProperty("--hlb", hexA(st.color, isOffscreen(st.cov, i) ? 0.1 : 0.13));
        e.style.setProperty("--hlb2", hexA(st.color, 0.24));
        e.style.setProperty("--hlc", st.color);
      } else { e.removeAttribute("data-hl"); }
      // The cue outline belongs to the loaded setup: hovering another line shows that line's span without it.
      if (this._cursor == null || i !== this._cursor || !st || (this._hot && this._hot !== selId)) e.removeAttribute("data-cursor"); else e.setAttribute("data-cursor", "");
    });
    this._drawCue();
  }

  /** The cue on the loaded setup's line: a dot at the cued script element, with a ring that pulses when it moves. */
  _drawCue() {
    this.svg?.querySelector(".cue")?.remove();
    const st = this._selSetup();
    if (!st?.cov || this._sel.i == null || !this.boxes?.length) return;
    const i = Math.max(st.cov.from, Math.min(st.cov.to, this._sel.i));
    const x = this._x(st.idx);
    const b = this.boxes[i];
    const y = Math.min(b.bottom - 4, b.top + 9);
    const g = s("g", { class: "cue" });
    if (this._pulse) g.append(s("circle", { class: "ring", cx: x, cy: y, r: 7, stroke: st.color }));
    g.append(s("circle", { cx: x, cy: y, r: 6.5, fill: st.color, stroke: "#fbf8f0", "stroke-width": 2.5 }));
    g.append(s("path", { d: `M${x - 2} ${y - 3.2} L${x + 3} ${y} L${x - 2} ${y + 3.2} Z`, fill: "#fff" }));
    this.svg.append(g);
    this._pulse = false;
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

  _at(st, take, i) {
    // A still has no length of its own: time it like the setup's other takes (else the host's shot length).
    const secs = take?.seconds || this.o.getSeconds?.(st.shot, take) || st.takes.find((t) => t.seconds > 0)?.seconds || null;
    return syncPoint(this.scene, st.cov, i, take ? { ...take, seconds: secs } : null);
  }

  _open(st, i, takeId = null) {
    if (!this.player) {
      const take = st.hero;
      if (!take) { this.o.onStatus(`${st.label} has no takes yet.`); return; }
      this._cursor = i; this._sel = { id: st.shot.id, takeId: take.id, i }; this._paintHot();
      this.o.onOpenTake(st.shot, take, this._at(st, take, i));
      return;
    }
    const keep = this._sel?.id === st.shot.id ? this._sel.takeId : null;
    this._sel = { id: st.shot.id, takeId: takeId || keep || st.hero?.id || null, i };
    this._cursor = i;
    this._pulse = true;
    this._paintHot();
    this._loadPlayer();
    this._syncLining();
  }

  _loadPlayer({ quiet = false } = {}) {
    const st = this._selSetup();
    if (!st || !this.player) return;
    const take = st.takes.find((t) => t.id === this._sel.takeId) || st.hero || null;
    if (take) this._sel.takeId = take.id;
    const at = take ? this._at(st, take, this._sel.i) : null;
    const seconds = take ? take.seconds || this.o.getSeconds?.(st.shot, take) || st.takes.find((t) => t.seconds > 0)?.seconds || null : null;
    this.player.load({ st, take, takes: st.takes, scene: this.scene, at, seconds });
    if (quiet) return;
    if (take) {
      const when = at?.offset != null ? `${at.offset.toFixed(1)} s in` : `${Math.round((at?.fraction || 0) * 100)}% in`;
      this.o.onStatus(`${st.label}-${take.n} (${st.shot.name || ""}) cued to script line ${this._sel.i + 1}, ${when}.`);
      this.o.onSync?.({ shot: st.shot, take, at });
    } else this.o.onStatus(`${st.label} has no takes yet.`);
  }

  /** The player moved the cue (its take bar, the playing video). */
  _cue(i, { follow = false } = {}) {
    if (!this._sel || i == null) return;
    this._sel.i = i;
    this._cursor = i;
    this._paintHot();
    const el = follow && this.scroll ? this.text?.querySelector(`.lp-el[data-i="${i}"]`) : null;
    if (el) {
      // Keep the cued line in view inside the script panel (never scroll the page).
      const r = el.getBoundingClientRect(), box = this.scroll.getBoundingClientRect();
      if (r.top < box.top + 30 || r.bottom > box.bottom - 30) this.scroll.scrollTop += r.top - box.top - box.height / 3;
    }
  }

  _syncLining() {
    if (!this.player) return;
    const st = this._selSetup();
    this.player.setLining({ edit: this._edit, canUndo: this.history.size > 0, has: !!st, lined: !!st?.cov, placing: !!this._placing });
  }

  _startPlacing() {
    const st = this._selSetup();
    if (!st) return;
    if (!this._edit) { this._edit = true; this.el.setAttribute("data-edit", ""); }
    this._placing = st.shot.id;
    this.el.setAttribute("data-placing", "");
    this._render();
    this._syncLining();
    this.o.onStatus(`Click the script line where ${st.label} starts.`);
  }

  _chipClick(st) {
    if (st.cov) { this._open(st, st.cov.from); return; }
    // Not lined: load its takes, and in Edit lining start placing its line.
    if (this.player) {
      this._sel = { id: st.shot.id, takeId: st.hero?.id || null, i: 0 };
      this._cursor = null;
      this._loadPlayer({ quiet: true });
      this._paintHot();
      if (this._edit) this._startPlacing();
      else { this._syncLining(); this.o.onStatus(`${st.label} is not lined yet: + Add line, then click where it starts.`); }
      return;
    }
    this.addLine(st.shot.id, 0);
  }

  /** Click on the page text: place a line (Add line), else open the hot (or tightest) setup covering that element. */
  _textClick(e) {
    const el = e.target.closest?.(".lp-el");
    if (!el) return;
    const i = +el.dataset.i;
    if (this._placing) { this.addLine(this._placing, i); return; }
    const hot = this.setups.find((st) => st.shot.id === this._hot && st.cov && i >= st.cov.from && i <= st.cov.to);
    const hits = this.setups.filter((st) => st.cov && i >= st.cov.from && i <= st.cov.to && !isOffscreen(st.cov, i));
    // The loaded setup keeps playing if it covers this line; else the tightest coverage (a single over the master),
    // like ScriptSync's preferred take.
    const cur = this._selSetup();
    const pick = hot || (cur && hits.includes(cur) ? cur : null) || hits.sort((a, b) => (a.cov.to - a.cov.from) - (b.cov.to - b.cov.from))[0];
    if (!pick) return;
    this._open(pick, i);
  }

  /** Drag a take (from the player's take list) onto the page: line its setup from the line it lands on. */
  _dropTarget() {
    const t = this.text;
    let last = null;
    const clear = () => { last?.removeAttribute("data-drop"); last = null; };
    t.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("text/x-ss-take")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const el = e.target.closest?.(".lp-el");
      if (el !== last) { clear(); if (el) { el.setAttribute("data-drop", ""); last = el; } }
    });
    t.addEventListener("dragleave", (e) => { if (!t.contains(e.relatedTarget)) clear(); });
    t.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData("text/x-ss-take");
      const el = e.target.closest?.(".lp-el");
      clear();
      if (!raw || !el) return;
      e.preventDefault();
      let d = null;
      try { d = JSON.parse(raw); } catch { return; }
      if (this._sel?.id === d.shot) this._sel.takeId = d.take;
      this.addLine(d.shot, +el.dataset.i);
    });
  }

  _commit(st, cov, msg) {
    this.history.push(st.shot.id, st.cov);
    st.cov = cov;
    // The line you edit becomes the loaded one (so Delete line and the player follow it).
    if (this.player && this._sel?.id !== st.shot.id) {
      this._sel = { id: st.shot.id, takeId: st.hero?.id || null, i: cov ? cov.from : 0 };
      this._cursor = cov ? cov.from : null;
    } else if (this._sel && cov) this._sel.i = this._cursor = Math.max(cov.from, Math.min(cov.to, this._sel.i));
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
        this._commit(st, d.cov, `${st.label} now covers script lines ${d.cov.from + 1}–${d.cov.to + 1}.`);
        return;
      }
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) { this._draw(); return; }
      const i = this._elementAt(ev.clientY - gRect().top);
      if (ev.altKey || this._edit) {
        const k = Math.max(st.cov.from, Math.min(st.cov.to, i));
        const next = toggleOffscreen(st.cov, k);
        this._commit(st, next, `${st.label}: script line ${k + 1} marked ${isOffscreen(next, k) ? "off camera (zig-zag)" : "on camera"}.`);
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
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); this._open(st, st.cov.from); return; }
    if (this._edit && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); e.stopPropagation(); this.deleteLine(st.shot.id); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const end = e.shiftKey ? "from" : "to";
      const cur = st.cov[end] + (e.key === "ArrowUp" ? -1 : 1);
      if (cur < 0 || cur >= n) return;
      const next = moveCoverageEnd(st.cov, end, cur, n);
      this._commit(st, next, `${st.label} now covers script lines ${next.from + 1}–${next.to + 1}.`);
      this.svg.querySelector(`g.ln[data-id="${cssEsc(st.shot.id)}"]`)?.focus();
    }
  }

  /** Keys anywhere in ScriptSync: ⌘Z / Ctrl+Z undoes a lining edit (not the graph), Esc stops placing a line. */
  _elKey(e) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "z" || e.key === "Z") && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName || "")) {
      if (this.history.size) { e.preventDefault(); e.stopPropagation(); this.undo(); }
      return;
    }
    if (e.key === "Escape" && this._placing) { e.preventDefault(); e.stopPropagation(); this._placing = null; this.el.removeAttribute("data-placing"); this._render(); this._syncLining(); return; }
    if (e.target.closest?.("g.ln, .lp-chip")) e.stopPropagation();
  }
}

const cssEsc = (v) => (globalThis.CSS?.escape ? globalThis.CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));
const cssUrl = (u) => String(u).replace(/["\\\n]/g, (c) => (c === "\n" ? "" : `\\${c}`));
