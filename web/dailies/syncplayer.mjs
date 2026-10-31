// ScriptSync player: the panel beside the lined script (lined.mjs) that plays the take you clicked, cued to the
// script line you clicked, like Avid ScriptSync's source monitor. It also lists the setup's takes (click one to swap
// the player) and holds the lining tools (Edit lining, Add line, Delete line, Undo).
//
//   const pl = new SyncPlayer(parentEl, { onSeek(elementIndex), onPickTake(take), onFull(), onEdit(on), onAdd(), onDelete(), onUndo(),
//     onDragTake(take) });
//   pl.load({ st, take, takes, scene, at, seconds });   // st: the lined script's setup record {shot, label, color, cov, ...}
//   pl.setCue(elementIndex)                              // the line under the playhead moved (a click on the take bar, the video)
//   pl.setLining({ edit, canUndo, lined, placing })      // refresh the lining tools
//
// Videos play from the cue; a still take shows its frame with the cue marked on the take bar (nothing pretends to
// play). A video that will not load falls back to its still.
import { syncSegments, elementAtFraction, KIND_LABEL } from "./model.mjs";

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

const STYLE = `
.ss-lined .lp-side { display:flex; flex-direction:column; gap:10px; min-width:0; min-height:0; overflow:auto; scrollbar-width:thin;
  background:#1d1722; border:1px solid var(--lp-line); border-radius:12px; padding:10px; }
.ss-lined .sp-head { display:flex; align-items:baseline; gap:8px; min-width:0; }
.ss-lined .sp-head .k { text-transform:uppercase; letter-spacing:.08em; font-size:10.5px; font-weight:600; color:var(--lp-muted); flex:none; }
.ss-lined .sp-head b { font:700 13px/1 ui-monospace, "SF Mono", Menlo, monospace; color:var(--c, var(--lp-accent)); flex:none; }
.ss-lined .sp-head .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--lp-text); font-size:12.5px; }
.ss-lined .sp-view { position:relative; aspect-ratio:16/9; border-radius:9px; overflow:hidden; background:#0f0c12; flex:none;
  box-shadow:0 0 0 1.5px var(--c, rgba(255,255,255,.1)); transition:box-shadow .2s; }
.ss-lined .sp-view > img, .ss-lined .sp-view > video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
.ss-lined .sp-view[data-flash] { animation:sp-flash .6s ease-out; }
@keyframes sp-flash { 0% { box-shadow:0 0 0 1.5px var(--c), 0 0 0 7px var(--c); } 100% { box-shadow:0 0 0 1.5px var(--c), 0 0 0 0 transparent; } }
.ss-lined .sp-view .slate { position:absolute; left:8px; top:8px; display:flex; gap:6px; align-items:center; padding:3px 8px; border-radius:999px;
  background:rgba(10,8,12,.72); font:700 11.5px/1.2 ui-monospace, Menlo, monospace; color:#fff; backdrop-filter:blur(4px); }
.ss-lined .sp-view .slate i { width:9px; height:9px; border-radius:3px; background:var(--c); }
.ss-lined .sp-view .cue { position:absolute; left:8px; right:8px; bottom:8px; padding:5px 9px; border-radius:8px; background:rgba(10,8,12,.74);
  color:#fff; font-size:12px; line-height:1.3; backdrop-filter:blur(4px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-lined .sp-view .cue b { color:var(--lp-accent); font-weight:600; }
.ss-lined .sp-view .empty { position:absolute; inset:0; display:grid; place-items:center; text-align:center; padding:18px; color:var(--lp-muted); font-size:12.5px; }
.ss-lined .sp-bar { position:relative; height:16px; border-radius:5px; background:rgba(255,255,255,.05); cursor:pointer; flex:none; overflow:hidden; }
.ss-lined .sp-bar .sg { position:absolute; top:3px; bottom:3px; background:var(--c); opacity:.38; border-right:1px solid #1d1722; }
.ss-lined .sp-bar .sg.off { background:repeating-linear-gradient(135deg, var(--c) 0 3px, transparent 3px 6px); opacity:.5; }
.ss-lined .sp-bar .sg[data-cur] { opacity:.95; }
.ss-lined .sp-bar .ph { position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; background:#fff; box-shadow:0 0 0 1px rgba(0,0,0,.4); pointer-events:none; }
.ss-lined .sp-ctl { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--lp-muted); flex:none; white-space:nowrap; min-width:0; }
.ss-lined .sp-head .kd { flex:none; font-size:11.5px; color:var(--lp-muted); white-space:nowrap; }
.ss-lined .sp-ctl .tc { font:600 11.5px/1 ui-monospace, Menlo, monospace; color:var(--lp-text); }
.ss-lined .sp-ctl .grow { flex:1; }
.ss-lined .sp-ctl .pill { font-size:11px; padding:2px 7px; border-radius:999px; border:1px solid var(--lp-line2); }
.ss-lined .lp-side button.sp-b { display:inline-flex; align-items:center; gap:6px; cursor:pointer; font:inherit; font-size:12px; line-height:1.2;
  background:rgba(255,255,255,.05) !important; color:var(--lp-text) !important; border:1px solid var(--lp-line2) !important;
  border-radius:999px !important; padding:4px 10px !important; }
.ss-lined .lp-side button.sp-b:hover:not(:disabled) { background:rgba(255,255,255,.1) !important; }
.ss-lined .lp-side button.sp-b:disabled { opacity:.4; cursor:default; }
.ss-lined .lp-side button.sp-b[aria-pressed=true] { background:rgba(242,255,89,.14) !important; border-color:rgba(242,255,89,.55) !important; color:#f6ffad !important; }
.ss-lined .lp-side button.sp-b.warn:hover:not(:disabled) { border-color:rgba(248,113,113,.6) !important; color:#fca5a5 !important; }
.ss-lined .sp-line { font:13px/1.35 "Courier Prime", "Courier New", Courier, monospace; color:var(--lp-text); padding:7px 9px; border-radius:8px;
  background:rgba(255,255,255,.04); border-left:3px solid var(--c, var(--lp-line2)); flex:none; max-height:4.2em; overflow:hidden; }
.ss-lined .sp-line .who { display:block; font-size:11px; letter-spacing:.06em; color:var(--lp-muted); }
.ss-lined .sp-sec { display:flex; align-items:center; gap:8px; text-transform:uppercase; letter-spacing:.08em; font-size:10.5px; font-weight:600;
  color:var(--lp-muted); margin-top:2px; flex:none; }
.ss-lined .sp-sec .aside { margin-left:auto; text-transform:none; letter-spacing:0; font-weight:400; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ss-lined .sp-sec > button.sp-b { margin-left:auto; text-transform:none; letter-spacing:0; font-weight:600; }
.ss-lined .sp-takes { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px; flex:none; }
.ss-lined .lp-side button.sp-tk { position:relative; display:flex; flex-direction:column; gap:3px; align-items:stretch; cursor:pointer; padding:3px !important;
  background:rgba(255,255,255,.03) !important; border:1px solid var(--lp-line) !important; border-radius:8px !important; color:var(--lp-text) !important; font:inherit; text-align:left; }
.ss-lined .lp-side button.sp-tk:hover { border-color:var(--lp-line2) !important; }
.ss-lined .lp-side button.sp-tk[aria-pressed=true] { border-color:var(--c) !important; box-shadow:0 0 0 1px var(--c); background:rgba(255,255,255,.07) !important; }
.ss-lined .sp-tk .im { aspect-ratio:16/9; border-radius:5px; background:#120e15 center/cover no-repeat; }
.ss-lined .sp-tk .t { display:flex; gap:4px; align-items:baseline; font-size:11px; padding:0 2px 1px; white-space:nowrap; overflow:hidden; }
.ss-lined .sp-tk .t b { font:700 11px/1 ui-monospace, Menlo, monospace; }
.ss-lined .sp-tk .t span { color:var(--lp-muted); overflow:hidden; text-overflow:ellipsis; }
.ss-lined .sp-tk .star { position:absolute; top:-5px; right:-5px; width:15px; height:15px; border-radius:50%; background:var(--c); color:#fff;
  font:700 10px/15px system-ui, sans-serif; text-align:center; box-shadow:0 0 0 1.5px #1d1722; }
.ss-lined .sp-edit { display:flex; flex-wrap:wrap; gap:6px; flex:none; }
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("ss-syncplayer-css")) return;
  document.head.append(h("style", { id: "ss-syncplayer-css" }, STYLE));
}

const fmtTc = (s) => {
  if (!Number.isFinite(s) || s < 0) return "";
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
};
const cssUrl = (u) => String(u).replace(/["\\\n]/g, (c) => (c === "\n" ? "" : `\\${c}`));

export class SyncPlayer {
  constructor(parent, opts = {}) {
    const noop = () => {};
    this.o = { onSeek: noop, onPickTake: noop, onFull: null, onEdit: noop, onAdd: noop, onDelete: noop, onUndo: noop, ...opts };
    injectCss();
    this.cur = null;
    this.el = h("aside", { class: "lp-side", "aria-label": "ScriptSync player" });
    this.headEl = h("div", { class: "sp-head" }, h("span", { class: "k" }, "Player"));
    this.view = h("div", { class: "sp-view" }, h("div", { class: "empty" }, "Click any coverage line on the script: its take plays here from that moment."));
    this.bar = h("div", { class: "sp-bar", role: "slider", tabindex: "0", "aria-label": "Take position (one segment per script line)",
      on: { pointerdown: (e) => this._barSeek(e), keydown: (e) => this._barKey(e) } });
    this.ctl = h("div", { class: "sp-ctl" });
    this.lineEl = h("div", { class: "sp-line ss-mono", hidden: "" });
    this.takesHead = h("div", { class: "sp-sec" }, "Takes");
    this.takesEl = h("div", { class: "sp-takes", role: "group", "aria-label": "Takes of this setup" });
    this.editBtn = h("button", { type: "button", class: "sp-b", "aria-pressed": "false",
      title: "Edit lining: fix where each setup's coverage line runs on the script", on: { click: () => this.o.onEdit(this.editBtn.getAttribute("aria-pressed") !== "true") } },
      "✎ Edit lining");
    this.addBtn = h("button", { type: "button", class: "sp-b", title: "Draw this setup's line on the script: click the line where it starts", on: { click: () => this.o.onAdd() } }, "+ Add line");
    this.delBtn = h("button", { type: "button", class: "sp-b warn", title: "Remove this setup's line from the script (Undo brings it back)", on: { click: () => this.o.onDelete() } }, "Delete line");
    this.undoBtn = h("button", { type: "button", class: "sp-b", title: "Undo the last lining change (⌘Z / Ctrl+Z)", on: { click: () => this.o.onUndo() } }, "↶ Undo");
    this.el.append(this.headEl, this.view, this.bar, this.ctl, this.lineEl, this.takesHead, this.takesEl,
      h("div", { class: "sp-sec" }, "Lining", this.editBtn), h("div", { class: "sp-edit" }, this.addBtn, this.delBtn, this.undoBtn));
    parent.append(this.el);
    this.setLining({});
  }

  destroy() { this._stopMedia(); this.el.remove(); }

  /** Load a take, cued to at.elementIndex. */
  load({ st, take, takes = [], scene, at = null, seconds = null }) {
    const same = this.cur && this.cur.take?.id === take?.id && this.cur.st?.shot.id === st?.shot.id;
    this.cur = { st, take, takes, scene, at, seconds: take?.seconds || seconds || null, i: at?.elementIndex ?? st?.cov?.from ?? 0 };
    this.el.style.setProperty("--c", st?.color || "");
    this.headEl.replaceChildren(h("span", { class: "k" }, "Player"), h("b", {}, take ? `${st.label}-${take.n}` : st?.label || ""),
      h("span", { class: "nm", title: st?.shot?.name || "" }, st?.shot?.name || ""),
      take ? h("span", { class: "kd" }, `${KIND_LABEL[take.kind] || ""}${take.circled ? " ★" : ""}`) : null);
    if (!take) {
      this._stopMedia();
      this.view.replaceChildren(h("div", { class: "empty" }, st ? `${st.label} has no takes yet.` : "Click any coverage line on the script."));
    } else if (!same || !this.media) {
      this._mount(take);
    }
    this.view.removeAttribute("data-flash"); void this.view.offsetWidth; this.view.setAttribute("data-flash", "");
    this._takes();
    this.setCue(this.cur.i, { seek: true });
  }

  /** The cue moved to element i (from the script, the bar or the video). */
  setCue(i, { seek = false } = {}) {
    if (!this.cur) return;
    const c = this.cur;
    c.i = i;
    const segs = syncSegments(c.scene, c.st?.cov);
    const seg = segs.find((s) => s.i === i) || segs[0];
    c.frac = this._mediaFrac ?? seg?.a ?? 0;
    if (seek) { this._mediaFrac = null; c.frac = seg?.a ?? 0; this._seekMedia(c.frac); }
    this._drawBar(segs);
    const els = c.scene?.elements || [];
    const el = els[i];
    const n = (c.st?.cov ? i - c.st.cov.from : 0) + 1;
    const secs = c.seconds ? c.frac * c.seconds : null;
    const cueTxt = h("div", { class: "cue" }, h("b", {}, `Line ${i + 1}`), ` of the scene · ${secs != null ? `${fmtTc(secs)} into the take` : `${Math.round(c.frac * 100)}% into the take`}`);
    this.view.querySelector(".cue")?.remove();
    this.view.querySelector(".slate")?.remove();
    if (c.take) this.view.append(h("div", { class: "slate" }, h("i"), `${c.st.label}-${c.take.n}`), cueTxt);
    if (el) {
      // A character cue reads with the speech under it.
      const speech = el.type === "character" ? els.slice(i + 1, i + 3).find((x) => x?.type === "dialogue") : null;
      const who = el.type === "character" ? String(el.text || "") : el.type === "dialogue" || el.type === "parenthetical" ? (el.character || "") : "";
      this.lineEl.replaceChildren(who ? h("span", { class: "who" }, who) : "", String((speech || (el.type === "character" ? null : el))?.text || ""));
      this.lineEl.hidden = false;
      this.lineEl.title = `Script line ${i + 1}${n > 0 ? ` (line ${n} of this setup's coverage)` : ""}`;
    } else this.lineEl.hidden = true;
    const playing = this.media?.tagName === "VIDEO" && !this.media.paused;
    const kids = [];
    if (this.media?.tagName === "VIDEO" && !this._failed) {
      kids.push(h("button", { type: "button", class: "sp-b", title: playing ? "Pause" : "Play from here", on: { click: () => this.toggle() } }, playing ? "❚❚ Pause" : "▶ Play"));
    } else if (c.take) kids.push(h("span", { class: "pill", title: "This take is a still frame: the bar shows where the line falls in the take" }, "Still frame"));
    kids.push(h("span", { class: "tc" }, c.seconds ? `${fmtTc(secs)} / ${fmtTc(c.seconds)}` : c.take ? `${Math.round(c.frac * 100)}%` : ""));
    kids.push(h("span", { class: "grow" }));
    if (this.o.onFull && c.take) kids.push(h("button", { type: "button", class: "sp-b", title: "Open this take full size", on: { click: () => this.o.onFull(c) } }, "⤢ Full size"));
    this.ctl.replaceChildren(...kids);
  }

  setLining({ edit = false, canUndo = false, lined = false, placing = false, has = false }) {
    this.editBtn.setAttribute("aria-pressed", String(!!edit));
    this.addBtn.disabled = !has || lined;
    this.addBtn.setAttribute("aria-pressed", String(!!placing));
    this.addBtn.textContent = placing ? "Click a script line…" : "+ Add line";
    this.delBtn.disabled = !has || !lined;
    this.undoBtn.disabled = !canUndo;
  }

  toggle() {
    const v = this.media;
    if (v?.tagName !== "VIDEO") return;
    if (v.paused) v.play?.().catch(() => {}); else v.pause();
  }

  /** Called when the element re-enters the page (a video pauses when it leaves it). */
  resume() { if (this._wasPlaying && this.media?.tagName === "VIDEO" && this.media.paused) this.media.play?.().catch(() => {}); }

  // ---------------------------------------------------------------- internals

  _takes() {
    const c = this.cur;
    const takes = c?.takes || [];
    this.takesHead.replaceChildren(document.createTextNode(c?.st ? `Takes · ${c.st.label}` : "Takes"),
      h("span", { class: "aside", title: "Click a take to load it; drag one onto the script to line its setup from there" }, takes.length ? `${takes.length} take${takes.length > 1 ? "s" : ""} · click to load` : ""));
    this.takesEl.replaceChildren(...takes.map((t) => h("button", { type: "button", class: "sp-tk", draggable: "true", "data-take": t.id,
      "aria-pressed": String(t.id === c.take?.id), title: `${c.st.label}-${t.n} · ${KIND_LABEL[t.kind] || ""}${t.circled ? " · circled" : ""}: load in the player`,
      on: { click: () => this.o.onPickTake(t),
        dragstart: (e) => { try { e.dataTransfer.setData("text/x-ss-take", JSON.stringify({ shot: c.st.shot.id, take: t.id })); e.dataTransfer.effectAllowed = "copy"; } catch { /* old browser */ } this.o.onDragTake?.(t, true); },
        dragend: () => this.o.onDragTake?.(t, false) } },
      h("div", { class: "im", style: t.thumb ? `background-image:url("${cssUrl(t.thumb)}")` : "" }),
      h("div", { class: "t" }, h("b", {}, `Tk ${t.n}`), h("span", {}, KIND_LABEL[t.kind] || "")),
      t.circled ? h("span", { class: "star", title: "Circled take" }, "★") : null)));
  }

  _mount(take) {
    this._stopMedia();
    this._failed = false;
    this._mediaFrac = null;
    let m;
    if (take.video) {
      m = h("video", { src: take.url, poster: take.thumb || undefined, playsinline: "", preload: "auto" });
      m.addEventListener("loadedmetadata", () => this._seekMedia(this.cur?.frac ?? 0, true));
      m.addEventListener("timeupdate", () => this._onTime());
      m.addEventListener("play", () => { this._wasPlaying = true; this.setCue(this.cur.i); });
      m.addEventListener("pause", () => { if (m.isConnected) this._wasPlaying = false; this.setCue(this.cur.i); });
      m.addEventListener("error", () => {
        // No video on this server (or a format the browser can't play): show the take's frame.
        this._failed = true;
        if (take.thumb) { const im = h("img", { src: take.thumb, alt: "" }); m.replaceWith(im); this.media = im; }
        if (this.cur) this.setCue(this.cur.i);
      });
    } else {
      m = h("img", { src: take.url || take.thumb, alt: "" });
    }
    this.media = m;
    this.view.replaceChildren(m);
  }

  _stopMedia() {
    if (this.media?.tagName === "VIDEO") { try { this.media.pause(); this.media.removeAttribute("src"); this.media.load(); } catch { /* gone */ } }
    this.media = null;
    this._wasPlaying = false;
  }

  _seekMedia(frac, autoplay = false) {
    const v = this.media;
    if (v?.tagName !== "VIDEO" || !(v.duration > 0)) return;
    this._seeking = true;
    v.currentTime = Math.min(v.duration - 0.05, frac * v.duration);
    setTimeout(() => { this._seeking = false; }, 120);
    if (autoplay) v.play?.().catch(() => {});
  }

  _onTime() {
    const v = this.media, c = this.cur;
    if (!c || v?.tagName !== "VIDEO" || !(v.duration > 0) || this._seeking) return;
    const frac = v.currentTime / v.duration;
    this._mediaFrac = frac;
    const i = elementAtFraction(c.scene, c.st.cov, frac);
    if (i != null && i !== c.i) { this.o.onSeek(i, { fromMedia: true }); }
    this.setCue(i ?? c.i);
    this._mediaFrac = null;
    c.frac = frac;
    this._drawBar(syncSegments(c.scene, c.st.cov));
  }

  _drawBar(segs) {
    const c = this.cur;
    const kids = segs.map((s) => h("div", { class: `sg${s.off ? " off" : ""}`, "data-cur": s.i === c.i ? "" : undefined,
      style: `left:${(s.a * 100).toFixed(2)}%;width:${((s.b - s.a) * 100).toFixed(2)}%`, title: `Script line ${s.i + 1}${s.off ? " (off camera)" : ""}` }));
    kids.push(h("div", { class: "ph", style: `left:${((c.frac || 0) * 100).toFixed(2)}%` }));
    this.bar.replaceChildren(...kids);
    this.bar.setAttribute("aria-valuetext", `Script line ${c.i + 1}`);
  }

  _barSeek(e) {
    const c = this.cur;
    if (!c?.st?.cov) return;
    e.stopPropagation();
    const r = this.bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    const i = elementAtFraction(c.scene, c.st.cov, frac);
    c.frac = frac;
    this._seekMedia(frac);
    this.o.onSeek(i, { fromBar: true });
    this._mediaFrac = frac;
    this.setCue(i);
    this._mediaFrac = null;
  }

  _barKey(e) {
    const c = this.cur;
    if (!c?.st?.cov || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    e.stopPropagation();
    const i = Math.max(c.st.cov.from, Math.min(c.st.cov.to, c.i + (e.key === "ArrowLeft" ? -1 : 1)));
    this.o.onSeek(i, { fromBar: true });
    this.setCue(i, { seek: true });
  }
}

