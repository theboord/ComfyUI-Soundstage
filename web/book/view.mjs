// The Director's Book view (Milestone 23): the book open over the App, one page per scene. A rail on the left (the
// film's front matter, your shorthand notes with the Unsorted tray, every scene, About); the page on the right.
// Every field is editable in place and says where its words came from (yours / AI draft / from the stage). Notes drag
// from the tray onto a scene in the rail or onto a line of the script page; each shows its confidence and why.
// The controller (book.mjs mountBook) owns the data; this file only draws and reports edits.
import { FIELDS, CATEGORIES, CAT, SOURCES, niceName, notesForScene, unsortedNotes, globalNotes, linedStrip, REV_COLOURS } from "./model.mjs";
import { moveArrowSVG } from "./floorplan.mjs";
import { TOKENS as T, TYPE, RADIUS, FONT } from "../ui/theme.mjs";

const BOOK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';
const ICON = {
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  sparkles: '<path d="M9.94 14.06 4 20"/><path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
};
const svgI = (name, size = 15) => { const s = document.createElement("span"); s.className = "ic"; s.innerHTML = name === "book" ? BOOK_ICON : `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ""}</svg>`; return s; };

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (v === true) e.setAttribute(k, "");
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};

const CSS = `
.ss-bk { position:fixed; inset:0; z-index:10040; display:grid; grid-template-rows:auto 1fr; background:${T.bg}; color:${T.text};
  font:${TYPE.md}px/1.45 ${FONT}; letter-spacing:.005em; }
.ss-bk[hidden] { display:none; }
.ss-bk * { box-sizing:border-box; }
.ss-bk .ic { display:inline-flex; line-height:0; }
.ss-bk button { font:inherit; color:inherit; }
.ss-bk .top { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid ${T.line}; background:${T.glassStrong}; }
.ss-bk .top .brand { display:flex; align-items:center; gap:8px; font-weight:600; font-size:${TYPE.lg}px; }
.ss-bk .top .brand .ic { color:${T.accent}; }
.ss-bk .top .ttl { color:${T.muted}; font-size:${TYPE.md}px; margin-left:2px; max-width:32ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-bk .top .sp { flex:1; }
.ss-bk .top .st { color:${T.muted}; font-size:${TYPE.sm}px; max-width:44ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-bk .btn { display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 12px; border-radius:${RADIUS.pill}px; border:1px solid ${T.lineStrong};
  background:${T.card}; cursor:pointer; font-size:${TYPE.sm}px; white-space:nowrap; }
.ss-bk .btn:hover { background:${T.cardHover}; }
.ss-bk .btn:disabled { opacity:.5; cursor:default; }
.ss-bk .btn.pri { background:${T.accent}; color:${T.accentInk}; border-color:${T.accent}; font-weight:600; }
.ss-bk .btn.pri:hover { background:${T.accentHover}; }
.ss-bk .btn.ghost { border-color:transparent; background:transparent; }
.ss-bk .btn.round { width:30px; padding:0; justify-content:center; }
.ss-bk .body { display:grid; grid-template-columns:248px 1fr; min-height:0; }
.ss-bk .rail { border-right:1px solid ${T.line}; overflow:auto; padding:12px 10px 20px; display:flex; flex-direction:column; gap:2px; }
.ss-bk .rail .lbl, .ss-bk .lbl { font-size:${TYPE.xs}px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:${T.faint}; }
.ss-bk .rail .lbl { padding:12px 8px 6px; }
.ss-bk .ri { display:flex; align-items:flex-start; gap:8px; width:100%; text-align:left; padding:7px 8px; border-radius:${RADIUS.md}px; border:1px solid transparent;
  background:none; cursor:pointer; }
.ss-bk .ri:hover { background:${T.card}; }
.ss-bk .ri[aria-current=page] { background:${T.selected}; }
.ss-bk .ri.drop { border-color:${T.accentLine}; background:${T.accentSoft}; }
.ss-bk .ri .n { flex:none; min-width:26px; font-weight:700; color:${T.accent}; }
.ss-bk .ri .t { flex:1; min-width:0; }
.ss-bk .ri .t b { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; font-weight:500; font-size:${TYPE.sm}px; overflow:hidden; overflow-wrap:anywhere; }
.ss-bk .ri .t small { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; color:${T.faint}; font-size:${TYPE.xs}px; overflow:hidden; }
.ss-bk .ri .cnt { flex:none; font-size:${TYPE.xs}px; color:${T.muted}; background:${T.card}; border-radius:${RADIUS.pill}px; padding:1px 7px; }
.ss-bk .ri .cnt.warn { color:${T.accentInk}; background:${T.accent}; }
.ss-bk .main { overflow:auto; min-height:0; }
.ss-bk .page { max-width:1220px; margin:0 auto; padding:22px 28px 60px; }
.ss-bk .spinebar { color:${T.faint}; font-size:${TYPE.sm}px; font-style:italic; margin-bottom:10px; }
.ss-bk .shead { display:flex; align-items:baseline; gap:14px; border-bottom:1px solid ${T.lineStrong}; padding-bottom:10px; }
.ss-bk .shead .num { font-size:28px; font-weight:700; color:${T.accent}; line-height:1; }
.ss-bk .shead h2 { margin:0; font-size:${TYPE.xl}px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; flex:1; }
.ss-bk .lined { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 16px; }
.ss-bk .chip { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 10px; border-radius:${RADIUS.pill}px; background:${T.card};
  border:1px solid ${T.line}; font-size:${TYPE.sm}px; color:${T.muted}; }
.ss-bk .chip b { color:${T.text}; font-weight:600; }
.ss-bk .chip input { width:44px; background:transparent; border:0; color:${T.text}; font:inherit; font-weight:600; padding:0; outline:none; }
.ss-bk .grid { display:grid; grid-template-columns:minmax(0,1.05fr) minmax(0,1fr); gap:16px; align-items:start; }
.ss-bk .col { display:flex; flex-direction:column; gap:12px; min-width:0; }
.ss-bk .card { background:${T.card}; border:1px solid ${T.line}; border-radius:${RADIUS.lg}px; padding:12px 14px 14px; min-width:0; }
.ss-bk .card.core { border-color:${T.accentLine}; background:${T.accentSoft}; }
.ss-bk .card header { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.ss-bk .card header .sp { flex:1; }
.ss-bk .src { font-size:${TYPE.xs}px; border-radius:${RADIUS.pill}px; padding:1px 8px; border:1px solid ${T.line}; color:${T.faint}; }
.ss-bk .src.llm { color:#c9a2ff; border-color:rgba(201,162,255,.35); }
.ss-bk .src.rules { color:#7ec8ff; border-color:rgba(126,200,255,.32); }
.ss-bk .src.director { color:${T.success}; border-color:rgba(126,226,168,.35); }
.ss-bk textarea, .ss-bk input.f { width:100%; resize:none; overflow:hidden; background:transparent; border:1px solid transparent; border-radius:${RADIUS.sm}px;
  color:${T.text}; font:inherit; line-height:1.5; padding:4px 6px; margin:0 -6px; outline:none; }
.ss-bk .card.core textarea { font-size:${TYPE.lg}px; font-style:italic; }
.ss-bk textarea:hover, .ss-bk input.f:hover { border-color:${T.line}; }
.ss-bk textarea:focus, .ss-bk input.f:focus { border-color:${T.lineStrong}; background:rgba(0,0,0,.18); }
.ss-bk textarea::placeholder, .ss-bk input.f::placeholder { color:rgba(240,239,237,.34); font-style:italic; }
.ss-bk .hint { color:${T.faint}; font-size:${TYPE.xs}px; }
.ss-bk .perf { display:grid; grid-template-columns:110px 1fr; gap:4px 10px; align-items:start; }
.ss-bk .perf b { padding-top:5px; font-weight:600; font-size:${TYPE.sm}px; }
.ss-bk .lane { display:grid; grid-template-columns:1fr 1fr 24px; gap:4px 10px; }
.ss-bk .lane .hd { font-size:${TYPE.xs}px; color:${T.faint}; text-transform:uppercase; letter-spacing:.08em; }
.ss-bk .plan svg { width:100%; height:auto; display:block; border-radius:${RADIUS.md}px; }
.ss-bk .strip { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.ss-bk .fr { position:relative; min-width:0; }
.ss-bk .fr .pic { position:relative; aspect-ratio:16/9; border-radius:${RADIUS.sm}px; overflow:hidden; background:${T.raised}; border:1px solid ${T.line}; }
.ss-bk .fr .pic img { width:100%; height:100%; object-fit:cover; display:block; }
.ss-bk .fr .pic .ss-bk-arrow { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.ss-bk .fr .no { display:flex; align-items:center; gap:6px; margin-top:5px; font-weight:700; }
.ss-bk .fr .no .sp { flex:1; }
.ss-bk .fr .cap { color:${T.muted}; font-size:${TYPE.xs}px; line-height:1.35; }
.ss-bk .fr .x { width:22px; height:22px; border-radius:${RADIUS.pill}px; border:1px solid ${T.line}; background:none; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; color:${T.muted}; }
.ss-bk .fr .x:hover { color:${T.text}; border-color:${T.lineStrong}; }
.ss-bk .fr.dropped .pic::after { content:""; position:absolute; inset:0; background:linear-gradient(to top right, transparent calc(50% - 1px), ${T.danger} 50%, transparent calc(50% + 1px)); }
.ss-bk .fr.dropped .pic img { opacity:.4; }
.ss-bk .fr.dropped .no span:first-child, .ss-bk .fr.dropped .cap { text-decoration:line-through; color:${T.faint}; }
.ss-bk .fr input.f { font-size:${TYPE.xs}px; margin-top:2px; }
/* the script page with its margins */
.ss-bk .layers { display:flex; flex-wrap:wrap; gap:6px; }
.ss-bk .layer { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 9px; border-radius:${RADIUS.pill}px; border:1px solid ${T.line}; background:none; cursor:pointer; font-size:${TYPE.xs}px; color:${T.muted}; }
.ss-bk .layer::before { content:""; width:8px; height:8px; border-radius:2px; background:var(--c); }
.ss-bk .layer[aria-pressed=false] { opacity:.45; }
.ss-bk .sp3 { display:grid; grid-template-columns:minmax(150px, 0.8fr) minmax(0, 2fr) minmax(170px, 0.95fr); column-gap:14px; }
.ss-bk .sp3 .txt { font:12.5px/1.5 "Courier Prime", "Courier New", Courier, monospace; color:#ece9e2; padding:5px 12px; white-space:pre-wrap; border-left:1px solid ${T.line}; border-right:1px solid ${T.line}; border-radius:4px; min-width:0; }
.ss-bk .sp3 .txt.dialogue { padding-left:16%; padding-right:12%; }
.ss-bk .sp3 .txt.parenthetical { padding-left:24%; color:${T.muted}; }
.ss-bk .sp3 .txt.character { padding-left:34%; text-transform:uppercase; padding-bottom:0; }
.ss-bk .sp3 .txt.transition { text-align:right; text-transform:uppercase; }
.ss-bk .sp3 .txt.slug { font-weight:700; text-transform:uppercase; }
.ss-bk .sp3 .txt.has { background:linear-gradient(90deg, rgba(242,255,89,0), rgba(242,255,89,.07)); }
.ss-bk .sp3 .txt.drop { outline:1px dashed ${T.accent}; background:${T.accentSoft}; }
.ss-bk .mg { display:flex; flex-direction:column; gap:4px; padding:4px 0; min-width:0; }
.ss-bk .nt { position:relative; border-left:3px solid var(--c); background:rgba(255,255,255,.035); border-radius:0 ${RADIUS.sm}px ${RADIUS.sm}px 0; padding:4px 8px 5px; font-size:${TYPE.sm}px; line-height:1.38; cursor:grab; min-width:0; }
.ss-bk .nt:active { cursor:grabbing; }
.ss-bk .nt .k { display:flex; align-items:center; gap:6px; font-size:${TYPE.xs}px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--c); }
.ss-bk .nt .k .conf { margin-left:auto; display:inline-flex; align-items:center; gap:4px; color:${T.faint}; font-weight:500; letter-spacing:0; text-transform:none; }
.ss-bk .nt .k .conf i { display:inline-block; width:28px; height:4px; border-radius:2px; background:${T.line}; overflow:hidden; }
.ss-bk .nt .k .conf i::after { content:""; display:block; height:100%; width:var(--p); background:var(--c); }
.ss-bk .nt .why { color:${T.faint}; font-size:${TYPE.xs}px; margin-top:2px; }
.ss-bk .nt .ed { display:none; gap:4px; margin-top:4px; flex-wrap:wrap; }
.ss-bk .nt:hover .ed, .ss-bk .nt:focus-within .ed { display:flex; }
.ss-bk .nt select { background:${T.raised}; color:${T.text}; border:1px solid ${T.line}; border-radius:${RADIUS.sm}px; font:inherit; font-size:${TYPE.xs}px; padding:1px 4px; max-width:100%; }
.ss-bk .nt .del { margin-left:auto; background:none; border:0; color:${T.faint}; cursor:pointer; padding:0 2px; }
.ss-bk .wide { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 10px; }
.ss-bk .wide .nt { max-width:360px; }
/* notes page */
.ss-bk .sh { width:100%; min-height:190px; border:1px solid ${T.lineStrong}; background:rgba(0,0,0,.18); border-radius:${RADIUS.md}px; padding:12px 14px; margin:0;
  font:14px/1.6 ${FONT}; resize:vertical; overflow:auto; }
.ss-bk .tray { min-height:70px; border:1px dashed ${T.lineStrong}; border-radius:${RADIUS.md}px; padding:8px; display:flex; flex-wrap:wrap; gap:6px; }
.ss-bk .tray.drop { border-color:${T.accent}; background:${T.accentSoft}; }
.ss-bk .tray .nt { width:280px; }
.ss-bk .filed { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:8px; }
.ss-bk .where { font-size:${TYPE.xs}px; color:${T.muted}; margin-top:3px; }
.ss-bk .where b { color:${T.text}; font-weight:600; }
.ss-bk .front .spine textarea { font-size:22px; line-height:1.35; font-style:italic; }
.ss-bk .about li { margin:6px 0; color:${T.muted}; }
.ss-bk .about li b { color:${T.text}; font-weight:500; }
.ss-bk .revs .r { display:grid; grid-template-columns:18px 110px 1fr auto; gap:10px; align-items:center; padding:7px 0; border-bottom:1px solid ${T.line}; }
.ss-bk .revs .sw { width:14px; height:14px; border-radius:3px; border:1px solid ${T.lineStrong}; }
.ss-bk .gr { margin-top:8px; font-size:${TYPE.xs}px; color:${T.faint}; }
.ss-bk .gr li { margin:2px 0; }
.ss-bk .busy::after { content:""; display:inline-block; width:10px; height:10px; margin-left:6px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:ssbk-spin .8s linear infinite; }
@keyframes ssbk-spin { to { transform:rotate(360deg); } }
@media (max-width: 1100px) { .ss-bk .grid { grid-template-columns:1fr; } .ss-bk .sp3 { grid-template-columns:minmax(110px,.7fr) minmax(0,2fr) minmax(130px,.8fr); } }
`;
const REV_HEX = { White: "#ffffff", Blue: "#cfe3ff", Pink: "#ffd6e2", Yellow: "#fff3b0", Green: "#d4f2d0", Goldenrod: "#f3d68b", Buff: "#f1e4c8", Salmon: "#ffcfb8", Cherry: "#f7b6bd", Tan: "#e3d2b6" };
const SRC_LABEL = { llm: "AI draft", rules: "from the stage", director: "yours", empty: "" };
const LEFT = new Set(["subtext", "performance"]);

function autosize(ta) { const f = () => { ta.style.height = "auto"; ta.style.height = `${Math.max(28, ta.scrollHeight + 2)}px`; }; ta.addEventListener("input", f); requestAnimationFrame(f); return ta; }

export class BookView {
  constructor(ctl) {
    this.ctl = ctl;
    this.at = "front";                 // "front" | "notes" | "about" | scene id
    this.layers = new Set(CATEGORIES.map((c) => c.key));
    if (!document.getElementById("ss-bk-css")) document.head.append(h("style", { id: "ss-bk-css" }, CSS));
    this.el = h("div", { class: "ss-bk", hidden: true, role: "dialog", "aria-label": "Director's Book" });
    this.status = h("span", { class: "st", "aria-live": "polite" });
    this.draftBtn = h("button", { type: "button", class: "btn pri", title: "The local model drafts the prose of every scene page from the script and the stage (your own words are kept)",
      on: { click: () => this._draft() } }, svgI("sparkles"), "Draft with AI");
    const top = h("div", { class: "top" },
      h("span", { class: "brand" }, svgI("book", 18), "Director's Book"), this.ttl = h("span", { class: "ttl" }),
      h("span", { class: "sp" }), this.status, this.draftBtn,
      h("button", { type: "button", class: "btn", title: "Lock this revision (White, Blue, Pink...): a snapshot in the revision history", on: { click: () => this._lock() } }, svgI("lock"), "Lock revision"),
      h("button", { type: "button", class: "btn", title: "The binder as a PDF: cover, contents, every scene page", on: { click: () => this.ctl.exportPDF() } }, svgI("download"), "PDF"),
      h("button", { type: "button", class: "btn", title: "The book as a Markdown file", on: { click: () => this.ctl.exportMarkdown() } }, svgI("file"), "Markdown"),
      h("button", { type: "button", class: "btn round ghost", title: "Close the book (Esc)", "aria-label": "Close the Director's Book", on: { click: () => this.ctl.close() } }, svgI("x", 17)));
    this.rail = h("nav", { class: "rail", "aria-label": "Book contents" });
    this.main = h("main", { class: "main" });
    this.el.append(top, h("div", { class: "body" }, this.rail, this.main));
    for (const ev of ["pointerdown", "wheel", "keydown", "keyup", "contextmenu"]) this.el.addEventListener(ev, (e) => e.stopPropagation());
    this.el.addEventListener("keydown", (e) => { if (e.key === "Escape" && !/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) this.ctl.close(); });
    document.body.append(this.el);
  }

  say(m) { this.status.textContent = m || ""; this.status.title = m || ""; }
  get open() { return !this.el.hidden; }

  show(at = null) {
    if (at) this.at = at;
    this.el.hidden = false;
    this.render();
  }
  hide() { this.el.hidden = true; }

  render() {
    const sc = this.ctl.script();
    this.ttl.textContent = this.ctl.book.title || sc?.title || "";
    this._rail();
    const keep = this.main.scrollTop;
    const same = this._renderedAt === this.at;
    this.main.replaceChildren(this._page());
    this._renderedAt = this.at;
    if (same) this.main.scrollTop = keep;
  }

  _go(at) { this.at = at; this.main.scrollTop = 0; this.render(); }

  // ------------------------------------------------------------------ rail
  _rail() {
    const book = this.ctl.book, script = this.ctl.script();
    const item = (at, n, t, sub, extra = null) => {
      const b = h("button", { type: "button", class: "ri", "aria-current": this.at === at ? "page" : null, on: { click: () => this._go(at) } },
        h("span", { class: "n" }, n), h("span", { class: "t" }, h("b", {}, t), sub ? h("small", {}, sub) : null), extra);
      return b;
    };
    const kids = [h("div", { class: "lbl" }, "The whole film"),
      item("front", svgI("compass", 14), "Spine & statement", book.spine || "One line for the whole film"),
      item("notes", svgI("pen", 14), "Your notes", "Shorthand, filed by scene and line",
        unsortedNotes(book).length ? h("span", { class: "cnt warn", title: "Unsorted notes" }, String(unsortedNotes(book).length)) : book.notes.length ? h("span", { class: "cnt" }, String(book.notes.length)) : null),
      h("div", { class: "lbl" }, "Scenes")];
    for (const s of script?.scenes || []) {
      const n = notesForScene(book, script, s.id).length;
      const b = item(s.id, s.number, s.heading, (book.scenes[s.id]?.core) || s.synopsis || "", n ? h("span", { class: "cnt", title: `${n} note${n === 1 ? "" : "s"}` }, String(n)) : null);
      this._dropTarget(b, (id) => this.ctl.moveNote(id, { scope: "scene", scene_id: s.id }));
      kids.push(b);
    }
    kids.push(h("div", { class: "lbl" }, "Back matter"), item("about", svgI("info", 14), "Revisions & about", `${book.revisions.length} revision${book.revisions.length === 1 ? "" : "s"} locked`));
    this.rail.replaceChildren(...kids);
  }

  _dropTarget(el, onDrop) {
    el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-ss-note")) { e.preventDefault(); el.classList.add("drop"); } });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", (e) => { el.classList.remove("drop"); const id = e.dataTransfer.getData("text/x-ss-note"); if (id) { e.preventDefault(); onDrop(id); } });
  }

  _page() {
    if (this.at === "front") return this._front();
    if (this.at === "notes") return this._notes();
    if (this.at === "about") return this._about();
    const sc = this.ctl.script()?.scenes?.find((x) => x.id === this.at);
    return sc ? this._scene(sc) : this._front();
  }

  // ------------------------------------------------------------------ pieces
  _src(source) { return source && source !== "empty" ? h("span", { class: `src ${source}`, title: source === "llm" ? "Drafted by the local model from the script; edit it and it's yours" : source === "rules" ? "Read off the script and the stage; updates as they change" : "Your words: the model never overwrites them" }, SRC_LABEL[source]) : null; }

  _text(value, onSave, { placeholder = "", rows = 1 } = {}) {
    const ta = h("textarea", { rows: String(rows), placeholder, spellcheck: "true" });
    ta.value = value || "";
    let t0 = ta.value;
    ta.addEventListener("change", () => { if (ta.value !== t0) { t0 = ta.value; onSave(ta.value); } });
    return autosize(ta);
  }

  _fieldCard(sc, def, f, extraCls = "") {
    const save = (v) => this.ctl.edit(sc.id, def.key, v);
    let body;
    if (def.kind === "text") body = this._text(f.value, (v) => save(v.trim()), { placeholder: def.hint });
    else if (def.kind === "list") {
      body = h("div", {}, this._text((f.value || []).join("\n"), (v) => save(v.split("\n").map((x) => x.replace(/^[-•]\s*/, "").trim()).filter(Boolean)), { placeholder: `${def.hint} One per line.` }));
      if (def.key === "pitfalls") {
        const cons = this.ctl.page(sc.id).fields.constraints?.value || [];
        if (cons.length) body.append(h("div", { class: "hint", title: "Our samplers run at CFG 1, where negative prompts do nothing: pitfalls go in as positive words" }, `In the prompts: ${cons.join("; ")}`));
      }
    } else if (def.kind === "perf") {
      const rows = Object.entries(f.value || {});
      body = rows.length ? h("div", { class: "perf" }, ...rows.flatMap(([who, t]) => [h("b", {}, niceName(who)),
        this._text(t, (v) => this.ctl.editPerf(sc.id, who, v.trim()), { placeholder: "What we need from them" })])) : h("div", { class: "hint" }, "No characters in this scene.");
    } else if (def.kind === "sound") {
      const list = [...(f.value || [])];
      const commit = () => save(list.filter((r) => r.hear?.trim()));
      const grid = h("div", { class: "lane" }, h("span", { class: "hd" }, "What we hear"), h("span", { class: "hd" }, "Why"), h("span", {}));
      list.forEach((r, i) => {
        const a = this._text(r.hear, (v) => { list[i] = { ...list[i], hear: v.trim() }; commit(); }, { placeholder: "Wind, then nothing" });
        const b = this._text(r.why, (v) => { list[i] = { ...list[i], why: v.trim() }; commit(); }, { placeholder: "Why" });
        grid.append(a, b, h("button", { type: "button", class: "btn round ghost", title: "Remove", "aria-label": "Remove this sound", on: { click: () => { list.splice(i, 1); commit(); } } }, svgI("x", 13)));
      });
      body = h("div", {}, grid, h("button", { type: "button", class: "btn ghost", style: "margin-top:6px", on: { click: () => { list.push({ hear: "Silence", why: "" }); save(list); } } }, svgI("plus", 13), "Add a sound (or a silence)"));
    }
    return h("section", { class: `card ${extraCls}`, "data-field": def.key },
      h("header", {}, h("span", { class: "lbl" }, def.label), h("span", { class: "sp" }), this._src(f.source)), body);
  }

  _note(n, { where = false } = {}) {
    const c = CAT[n.category] || CAT.blocking;
    const pct = Math.round((n.confidence ?? 0) * 100);
    const script = this.ctl.script();
    const el = h("div", { class: "nt", draggable: "true", style: `--c:${c.color}`, "data-note": n.id, title: n.why ? `Why here: ${n.why}` : "" },
      h("div", { class: "k" }, c.label, n.character ? h("span", { style: `color:${T.muted};text-transform:none;letter-spacing:0` }, `· ${niceName(n.character)}`) : null,
        h("span", { class: "conf", title: `${n.by === "director" ? "Placed by you" : `Placed by ${n.by === "llm" ? "the local model" : n.by === "rules+llm" ? "the rules and the model" : n.by === "chat" ? "the Director chat" : "the rules"}`}: ${pct}% sure` }, h("i", { style: `--p:${pct}%` }), `${pct}%`)),
      h("div", {}, n.text),
      n.why ? h("div", { class: "why" }, `Why here: ${n.why}`) : null);
    if (where) {
      const sc = script?.scenes?.find((x) => x.id === n.scene_id);
      const line = sc && Number.isInteger(n.line) ? sc.elements?.[n.line]?.text : null;
      el.append(h("div", { class: "where" }, n.scope === "scene" && sc ? h("span", {}, h("b", {}, `Scene ${sc.number}`), line ? ` · “${line.length > 70 ? line.slice(0, 69) + "…" : line}”` : " · the whole scene")
        : n.scope === "character" ? h("span", {}, h("b", {}, niceName(n.character)), " · every scene they're in") : n.scope === "global" ? h("b", {}, "The whole film") : h("b", {}, "Unsorted")));
    }
    // edit: scene, line, category, delete
    const scSel = h("select", { "aria-label": "Scene" },
      h("option", { value: "unsorted" }, "Unsorted"), h("option", { value: "global" }, "Whole film"),
      n.character ? h("option", { value: "character" }, `All of ${niceName(n.character)}'s scenes`) : null,
      ...(script?.scenes || []).map((s) => h("option", { value: s.id }, `Scene ${s.number}`)));
    scSel.value = n.scope === "scene" ? n.scene_id : n.scope;
    scSel.addEventListener("change", () => {
      const v = scSel.value;
      this.ctl.moveNote(n.id, ["unsorted", "global", "character"].includes(v) ? { scope: v } : { scope: "scene", scene_id: v });
    });
    const catSel = h("select", { "aria-label": "Category" }, ...CATEGORIES.map((k) => h("option", { value: k.key }, k.label)));
    catSel.value = n.category;
    catSel.addEventListener("change", () => this.ctl.moveNote(n.id, { category: catSel.value }));
    const kids = [scSel, catSel];
    const sc = n.scope === "scene" && script?.scenes?.find((x) => x.id === n.scene_id);
    if (sc) {
      const lnSel = h("select", { "aria-label": "Line" }, h("option", { value: "" }, "Whole scene"),
        ...(sc.elements || []).map((e, i) => (e.type === "character" ? null : h("option", { value: String(i) }, `${e.character ? niceName(e.character) + ": " : ""}${e.text.slice(0, 38)}${e.text.length > 38 ? "…" : ""}`))));
      lnSel.value = Number.isInteger(n.line) ? String(n.line) : "";
      lnSel.addEventListener("change", () => this.ctl.moveNote(n.id, { scope: "scene", scene_id: sc.id, line: lnSel.value === "" ? null : Number(lnSel.value), category: n.category }));
      kids.push(lnSel);
    }
    kids.push(h("button", { type: "button", class: "del", title: "Delete this note", "aria-label": "Delete this note", on: { click: () => this.ctl.removeNote(n.id) } }, svgI("trash", 13)));
    el.append(h("div", { class: "ed" }, ...kids));
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-ss-note", n.id); e.dataTransfer.effectAllowed = "move"; });
    return el;
  }

  // ------------------------------------------------------------------ pages
  _front() {
    const b = this.ctl.book;
    const rules = globalNotes(b);
    return h("div", { class: "page front" },
      h("div", { class: "lbl" }, "The whole film"),
      h("section", { class: "card core spine", style: "margin-top:8px" }, h("header", {}, h("span", { class: "lbl" }, "The spine"), h("span", { class: "sp" }), this._src(b.edited.spine ? "director" : b.spine ? "llm" : "empty")),
        this._text(b.spine, (v) => this.ctl.editBook("spine", v.trim()), { placeholder: "One line: the core action of the whole film (Kazan)." }),
        h("div", { class: "hint" }, "Shown faintly at the top of every scene page, so each scene's Core can be checked against it."),
        !b.edited.spine && (b.spine_grounding?.flags?.length || b.spine_grounding?.dropped?.length)
          ? h("ul", { class: "gr" }, ...[...(b.spine_grounding.dropped || []), ...(b.spine_grounding.flags || [])].map((d) => h("li", {}, `Check: “${d.sentence}” (${d.why})`))) : null),
      h("div", { class: "grid", style: "margin-top:12px" },
        h("div", { class: "col" },
          h("section", { class: "card" }, h("header", {}, h("span", { class: "lbl" }, "Director's statement"), h("span", { class: "sp" }), this._src(b.edited.statement ? "director" : b.statement ? "llm" : "empty")),
            this._text(b.statement, (v) => this.ctl.editBook("statement", v.trim()), { placeholder: "Tone and visual approach for the whole film." })),
          h("section", { class: "card" }, h("header", {}, h("span", { class: "lbl" }, "Rules for every scene")),
            this._text(b.rules.join("\n"), (v) => this.ctl.editBook("rules", v.split("\n").map((x) => x.trim()).filter(Boolean)), { placeholder: "One per line: no handheld, the key is always brass…" }),
            rules.length ? h("div", { class: "hint" }, `Plus ${rules.length} from your notes: ${rules.map((n) => n.text).join(" · ")}`) : null)),
        h("div", { class: "col" },
          h("section", { class: "card" }, h("header", {}, h("span", { class: "lbl" }, "Style words for every prompt")),
            this._text(b.style.join("\n"), (v) => this.ctl.editBook("style", v.split("\n").map((x) => x.trim()).filter(Boolean)), { placeholder: "Sun-bleached, dusty, wide-open skies" }),
            h("div", { class: "hint" }, "With each scene's Imagery & Tone, these go into the still and motion prompts.")),
          h("section", { class: "card" }, h("header", {}, h("span", { class: "lbl" }, "Keep it (positive constraints)")),
            this._text(b.constraints.join("\n"), (v) => this.ctl.editBook("constraints", v.split("\n").map((x) => x.trim()).filter(Boolean)), { placeholder: "Restrained, understated performance" }),
            h("div", { class: "hint" }, "Say what you want, not what you don't: the samplers run at CFG 1, so negative prompts do nothing.")),
          h("section", { class: "card" }, h("header", {}, h("span", { class: "lbl" }, "Journal")),
            this._text(b.journal, (v) => this.ctl.editBook("journal", v), { placeholder: "Anything that doesn't fit a scene yet (Bergman's workbooks).", rows: 3 })))));
  }

  _notes() {
    const b = this.ctl.book, script = this.ctl.script();
    const ta = h("textarea", { class: "sh", placeholder: "Write in your own shorthand, one note a line:\nsc2 — keep Mara's face in shadow till she sees the badge\nchase: low & fast, no music till the crash\nEzra never looks Cole in the eye", spellcheck: "true", "aria-label": "Your shorthand notes" });
    ta.value = this.ctl.draftNotes || "";
    ta.addEventListener("input", () => { this.ctl.draftNotes = ta.value; });
    const fileBtn = h("button", { type: "button", class: "btn pri", on: { click: async () => {
      fileBtn.disabled = true; fileBtn.classList.add("busy");
      try { const n = await this.ctl.fileNotes(ta.value); if (n) { this.ctl.draftNotes = ""; } } finally { fileBtn.disabled = false; fileBtn.classList.remove("busy"); this.render(); }
    } } }, svgI("sparkles"), "File my notes");
    const tray = h("div", { class: "tray", "aria-label": "Unsorted notes" }, ...unsortedNotes(b).map((n) => this._note(n)));
    if (!unsortedNotes(b).length) tray.append(h("span", { class: "hint", style: "padding:6px" }, "Nothing unsorted. Drag a note here to take it off its scene."));
    this._dropTarget(tray, (id) => this.ctl.moveNote(id, { scope: "unsorted" }));
    const filed = b.notes.filter((n) => n.scope !== "unsorted" && n.source !== "chat");
    const chat = b.notes.filter((n) => n.source === "chat");
    const order = new Map((script?.scenes || []).map((s, i) => [s.id, i]));
    filed.sort((x, y) => (x.scope === "global" ? -1 : 0) - (y.scope === "global" ? -1 : 0) || (order.get(x.scene_id) ?? 99) - (order.get(y.scene_id) ?? 99) || (x.line ?? -1) - (y.line ?? -1));
    return h("div", { class: "page" },
      h("div", { class: "lbl" }, "Your notes"),
      h("p", { class: "hint", style: `font-size:${TYPE.sm}px;margin:6px 0 10px` }, "Lay out your outline and notes however you write them. The local model reads your shorthand and files each note on its scene, line and character, by department, with how sure it is and why. Drag any note to another scene (in the list on the left), onto a line on a scene page, or into Unsorted."),
      ta, h("div", { style: "display:flex;gap:8px;align-items:center;margin:10px 0 18px" }, fileBtn, h("span", { class: "hint" }, "Each line is one note. Your notes also show in ① Script and steer the Director.")),
      h("div", { class: "lbl", style: "margin-bottom:6px" }, `Unsorted (${unsortedNotes(b).length})`), tray,
      h("div", { class: "lbl", style: "margin:18px 0 6px" }, `Filed (${filed.length})`),
      filed.length ? h("div", { class: "filed" }, ...filed.map((n) => this._note(n, { where: true }))) : h("div", { class: "hint" }, "No notes filed yet."),
      chat.length ? h("div", {}, h("div", { class: "lbl", style: "margin:18px 0 6px" }, `Decided in the Director chat (${chat.length})`),
        h("div", { class: "filed" }, ...chat.slice(-12).reverse().map((n) => this._note(n, { where: true })))) : null);
  }

  _about() {
    const b = this.ctl.book;
    return h("div", { class: "page" },
      h("div", { class: "lbl" }, "Revision history"),
      h("div", { class: "revs card", style: "margin:8px 0 18px" }, ...(b.revisions.length ? b.revisions.slice().reverse().map((r) => h("div", { class: "r" },
        h("span", { class: "sw", style: `background:${REV_HEX[r.colour] || "#fff"}` }), h("b", {}, r.colour), h("span", {}, r.label, r.changed?.length ? h("span", { class: "hint" }, ` · ${r.changed.length} part${r.changed.length === 1 ? "" : "s"} changed`) : null),
        h("span", { class: "hint" }, new Date(r.at).toLocaleString()))) : [h("div", { class: "hint" }, `No revision locked yet. Lock revision snapshots the book as ${REV_COLOURS[0]}, then ${REV_COLOURS[1]}, ${REV_COLOURS[2]}…`)])),
      h("div", { class: "lbl" }, "About this book"),
      h("p", { style: `color:${T.muted};margin:6px 0` }, "Laid out like the directors' binders it learns from:"),
      h("ul", { class: "about" }, ...SOURCES.map(([s, w]) => h("li", {}, h("b", {}, s), `: ${w}.`))),
      h("p", { class: "hint" }, "“AI draft” is written by the local Qwen3.5 4B from the script and checked against it on the server (sentences naming anything the script doesn't are dropped). “From the stage” is read off the Soundstage set. “Yours” is never overwritten."));
  }

  _scene(sc) {
    const ctl = this.ctl, book = ctl.book, script = ctl.script();
    const pg = ctl.page(sc.id);
    ctl.rememberShots?.(sc.id, pg.shots);
    const F = pg.fields;
    const ls = linedStrip(pg);
    const day = h("input", { value: pg.story_day || "", placeholder: "—", "aria-label": "Story day" });
    day.addEventListener("change", () => ctl.setStoryDay(sc.id, day.value.trim()));
    const card = (k, cls = "") => this._fieldCard(sc, FIELDS.find((f) => f.key === k), F[k], cls);
    const dr = pg.drafted;
    const grounding = dr?.grounding && (dr.grounding.dropped?.length || dr.grounding.flags?.length)
      ? h("ul", { class: "gr" }, ...(dr.grounding.dropped || []).map((d) => h("li", {}, `Left out: “${d.sentence}” (${d.why})`)), ...(dr.grounding.flags || []).map((d) => h("li", {}, `Check: “${d.sentence}” (${d.why})`))) : null;
    // shot strip
    const strip = h("div", { class: "strip" }, ...pg.shots.map((r) => {
      const pic = h("div", { class: "pic" });
      const url = ctl.framePic(r.id);
      if (url) pic.append(h("img", { src: url, alt: `${r.no} ${r.name}` }));
      else if (!r.gone) ctl.clayFrame(sc.id, r.id).then((u) => { if (u && !pic.querySelector("img")) pic.prepend(h("img", { src: u, alt: `${r.no} ${r.name} (clay)` })); }).catch(() => {});
      if (!r.dropped) { const a = moveArrowSVG(r.move); if (a) pic.insertAdjacentHTML("beforeend", a); }
      const note = h("input", { class: "f", value: r.note || "", placeholder: "Note on this shot", "aria-label": `Note on shot ${r.no}` });
      note.addEventListener("change", () => ctl.setShotNote(sc.id, r.id, note.value.trim()));
      return h("div", { class: `fr${r.dropped ? " dropped" : ""}`, "data-shot": r.id }, pic,
        h("div", { class: "no" }, h("span", {}, r.no), h("span", { class: "sp" }),
          r.gone ? h("span", { class: "hint" }, "removed") : h("button", { type: "button", class: "x", title: r.dropped ? "Bring the shot back" : "Drop this shot (struck through, never deleted)",
            "aria-label": r.dropped ? `Restore shot ${r.no}` : `Drop shot ${r.no}`, on: { click: () => ctl.toggleDrop(sc.id, r.id) } }, svgI(r.dropped ? "plus" : "strike", 12))),
        h("div", { class: "cap" }, `${r.name} · ${r.lens}${r.height ? ` · ${r.height}` : ""}`), h("div", { class: "cap" }, `${r.move} · ${r.rig}`), note);
    }));
    // the script page with margins
    const notes = notesForScene(book, script, sc.id).filter((n) => this.layers.has(n.category));
    const layers = h("div", { class: "layers" }, ...CATEGORIES.map((c) => h("button", { type: "button", class: "layer", style: `--c:${c.color}`, "aria-pressed": String(this.layers.has(c.key)),
      on: { click: () => { if (this.layers.has(c.key)) this.layers.delete(c.key); else this.layers.add(c.key); this.render(); } } }, c.label)));
    const sp = h("div", { class: "sp3" }, h("div", { class: "lbl" }, "Subtext · Performance"), h("div", { class: "lbl", style: "padding-left:12px" }, "The scene, as written"), h("div", { class: "lbl" }, "Camera · Light · Sound · Blocking"),
      h("div"), h("div", { class: "txt slug" }, `${sc.number}  ${sc.heading}`), h("div"));
    (sc.elements || []).forEach((e, i) => {
      const on = notes.filter((n) => n.line === i);
      const txt = h("div", { class: `txt ${e.type}${on.length ? " has" : ""}`, "data-line": String(i) }, e.text);
      if (e.type !== "character") this._dropTarget(txt, (id) => ctl.moveNote(id, { scope: "scene", scene_id: sc.id, line: i }));
      sp.append(h("div", { class: "mg" }, ...on.filter((n) => LEFT.has(n.category)).map((n) => this._note(n))), txt,
        h("div", { class: "mg" }, ...on.filter((n) => !LEFT.has(n.category)).map((n) => this._note(n))));
    });
    const wide = notes.filter((n) => !Number.isInteger(n.line));
    return h("div", { class: "page" },
      book.spine ? h("div", { class: "spinebar" }, `Spine: ${book.spine}`) : null,
      h("div", { class: "shead" }, h("span", { class: "num" }, sc.number), h("h2", {}, sc.heading),
        h("button", { type: "button", class: "btn", title: "The local model drafts this scene's prose from its text and stage (your words are kept)", on: { click: () => this._draft(sc.id) } }, svgI("sparkles"), "Draft this scene")),
      h("div", { class: "lined", "aria-label": "Lined script" },
        h("span", { class: "chip" }, "Story day", day), h("span", { class: "chip" }, "Time ", h("b", {}, ls.time || "—")),
        h("span", { class: "chip" }, "Planned ", h("b", {}, String(ls.planned))), h("span", { class: "chip" }, "Shot ", h("b", {}, String(ls.shot))),
        h("span", { class: "chip" }, "Cut ", h("b", {}, String(ls.cut))), ls.dropped ? h("span", { class: "chip" }, "Dropped ", h("b", {}, String(ls.dropped))) : null,
        dr ? h("span", { class: "chip", title: dr.grounding?.ok === false ? "Some sentences were left out: they named things the script doesn't" : "Every sentence checked against the script" },
          `Drafted ${dr.by === "llm" ? "by AI" : "by the rules"} · ${new Date(dr.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`) : null),
      h("div", { class: "grid" },
        h("div", { class: "col" }, card("synopsis"), card("core", "core"), card("subtext"),
          h("div", { class: "grid", style: "gap:12px" }, card("times"), card("imagery")),
          h("div", { class: "grid", style: "gap:12px" }, card("references"), card("pitfalls")),
          card("lighting"), card("performance"), card("sound"), grounding ? h("section", { class: "card" }, h("span", { class: "lbl" }, "Grounding check"), grounding) : null),
        h("div", { class: "col" },
          h("section", { class: "card plan" }, h("header", {}, h("span", { class: "lbl" }, "Floor plan"), h("span", { class: "sp" }), h("span", { class: "hint" }, "Cameras lettered as in the strip · 1 → 2 marks")),
            h("div", { html: ctl.planSVG(sc.id, pg.shots) })),
          h("section", { class: "card" }, h("header", {}, h("span", { class: "lbl" }, "Shot strip & camera plan"), h("span", { class: "sp" }), h("span", { class: "hint" }, `${pg.shots.filter((r) => !r.dropped).length} shots`)),
            pg.shots.length ? strip : h("div", { class: "hint" }, "No shots on this scene's stage yet. Block it on ③ Set and the strip fills in.")),
          card("continuity"))),
      h("section", { class: "card", style: "margin-top:16px" },
        h("header", {}, h("span", { class: "lbl" }, "The script page · margin notes"), h("span", { class: "sp" }), layers),
        wide.length ? h("div", {}, h("div", { class: "hint" }, "On the whole scene"), h("div", { class: "wide" }, ...wide.map((n) => this._note(n)))) : null,
        sp, h("div", { class: "hint", style: "margin-top:8px" }, "Drag a note onto a line to pin it there.")));
  }

  async _draft(sceneId = null) {
    if (this.draftBtn.disabled) return;
    this.draftBtn.disabled = true; this.draftBtn.classList.add("busy");
    try { await this.ctl.draft(sceneId); } finally { this.draftBtn.disabled = false; this.draftBtn.classList.remove("busy"); this.render(); }
  }

  _lock() {
    const r = this.ctl.lockRevision();
    this.say(`Locked the ${r.colour} revision${r.changed?.length ? `: ${r.changed.length} part${r.changed.length === 1 ? "" : "s"} changed` : ""}.`);
    this.render();
  }
}
