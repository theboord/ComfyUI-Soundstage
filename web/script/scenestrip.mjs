// The scene strip: one slim row over ③ Set, ④ Frame and ⑤ Motion. A chip per script scene (number, INT/EXT and
// place, time of day, who is in it), scrollable; the active scene's chip opens to show its shots as small thumbnails
// with a status dot. Click a scene to set it up on the stage, a shot to work on it; ◀ ▶ or ←/→ step through scenes.
// Without a script it shows the stage's shots only.
//
// In the canvas layout the strip folds into the App's top row: strip.pick is a compact "scene ▾" button (scene
// number, place, time of day, the shot) that opens the full strip as a drop-down; ◀ ▶ sit beside it.
//
//   const strip = new SceneStrip(host, { getScript, current, getShots, activeShot, onScene, onShot, shotStatus,
//     setupInfo, onSetup, onUndo });
//   strip.render();
import { sceneChip, stepScene } from "./scenesetup.mjs";

const CSS = `
.ss-scstrip { display:flex; align-items:stretch; gap:6px; height:64px; margin:0 0 8px; min-width:0; }
.ss-scstrip[hidden] { display:none; }
/* Over ④ Frame / ⑤ Motion the workspace hides everything but the step view: the strip stays. */
.ss-stage.ss-stage.ss-pipemode > .ss-scstrip.ss-scstrip:not([hidden]) { display:flex !important; }
.ss-stage .ss-scstrip button { font:inherit; color:var(--ss-text,#f0efed); cursor:pointer; }
.ss-stage .ss-scstrip .nav { flex:0 0 28px; border-radius:10px !important; border:1px solid rgba(255,255,255,.1) !important; background:rgba(255,255,255,.04) !important;
  display:flex; align-items:center; justify-content:center; padding:0 !important; font-size:15px; }
.ss-stage .ss-scstrip .nav:disabled { opacity:.3; cursor:default; }
.ss-scstrip .rail { flex:1; min-width:0; display:flex; gap:6px; overflow-x:auto; overflow-y:hidden; scroll-behavior:smooth; scrollbar-width:thin; padding-bottom:2px; }
.ss-stage .ss-scstrip .chip { flex:0 0 auto; display:flex; align-items:center; gap:8px; height:60px; max-width:230px; padding:4px 10px 4px 8px !important;
  border-radius:12px !important; border:1px solid rgba(255,255,255,.09) !important; background:rgba(255,255,255,.035) !important; text-align:left; }
.ss-stage .ss-scstrip .chip:hover { border-color:rgba(242,255,89,.45) !important; }
.ss-stage .ss-scstrip .chip[aria-current="true"] { max-width:none; border-color:var(--ss-accent,#F2FF59) !important; background:rgba(242,255,89,.07) !important; }
.ss-scstrip .num { font-size:20px; font-weight:800; min-width:22px; text-align:center; color:var(--ss-text,#f0efed); }
.ss-scstrip .chip[aria-current="true"] .num { color:var(--ss-accent,#F2FF59); }
.ss-scstrip .meta { display:flex; flex-direction:column; gap:3px; min-width:0; max-width:170px; }
.ss-scstrip .where { font-size:12px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-scstrip .sub { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--ss-muted,#a9a3ad); white-space:nowrap; }
.ss-scstrip .tod { display:inline-flex; align-items:center; gap:3px; }
.ss-scstrip .tod i { width:8px; height:8px; border-radius:50%; display:inline-block; }
.ss-scstrip .ini { display:inline-flex; }
.ss-scstrip .ini b { width:17px; height:17px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:750;
  background:#3a3342; color:#f0efed; border:1px solid #1a1420; margin-left:-4px; }
.ss-scstrip .ini b:first-child { margin-left:0; }
.ss-scstrip .shots { display:flex; gap:5px; align-items:center; padding-left:6px; border-left:1px solid rgba(255,255,255,.1); }
.ss-stage .ss-scstrip .shot { position:relative; width:84px; height:46px; padding:0 !important; border-radius:7px !important; overflow:hidden;
  border:2px solid transparent !important; background:#1a1420 !important; flex:0 0 auto; }
.ss-stage .ss-scstrip .shot[aria-pressed="true"] { border-color:var(--ss-accent,#F2FF59) !important; }
.ss-scstrip .shot img, .ss-scstrip .shot canvas { width:100%; height:100%; object-fit:cover; display:block; }
.ss-scstrip .shot .nm { position:absolute; left:3px; bottom:1px; right:12px; font-size:9px; color:#fff; text-shadow:0 1px 2px #000; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:left; }
.ss-scstrip .shot .dot { position:absolute; top:3px; right:3px; width:8px; height:8px; border-radius:50%; background:transparent; box-shadow:0 0 0 1px rgba(0,0,0,.5); }
.ss-scstrip .dot.final, .ss-scstrip .dot.approved { background:#7ee2a8; }
.ss-scstrip .dot.draft { background:#f5b84a; }
.ss-scstrip .dot.frame { background:#8fb8ff; }
.ss-scstrip .dot.busy { background:var(--ss-accent,#F2FF59); animation:ss-scdot 1s ease-in-out infinite alternate; }
.ss-scstrip .dot.rejected { background:#ff5a4f; }
.ss-scstrip .dot.changes { background:#ff9a3d; }
.ss-stage button.ss-scpick { display:inline-flex !important; align-items:center; gap:8px !important; min-width:0; max-width:100%; height:34px;
  padding:2px 10px 2px 8px !important; border-radius:10px !important; text-align:left; }
.ss-scpick .num { font-size:15px; font-weight:800; color:var(--ss-accent,#F2FF59); flex:none; }
.ss-scpick .meta { display:flex; flex-direction:column; min-width:0; line-height:1.15; }
.ss-scpick .where { font-size:12px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--ss-text,#f0efed); }
.ss-scpick .sub { display:flex; align-items:center; gap:4px; font-size:10.5px; color:var(--ss-muted,#a9a3ad); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-scpick .sub i { width:7px; height:7px; border-radius:50%; display:inline-block; flex:none; }
.ss-scpick .car { flex:none; font-size:11px; color:var(--ss-muted,#a9a3ad); margin-left:auto; }
.ss-scpick[data-setup=true] .car { color:var(--ss-accent,#F2FF59); }
.ss-scpick[data-setup=true] .car::before { content:"●"; font-size:8px; margin-right:3px; vertical-align:2px; }
@keyframes ss-scdot { from { opacity:.35; } to { opacity:1; } }
.ss-scstrip .noshot { font-size:11px; color:var(--ss-muted,#a9a3ad); }
.ss-scstrip .act { flex:0 0 auto; display:flex; flex-direction:column; justify-content:center; gap:4px; max-width:300px; }
.ss-stage .ss-scstrip .act button { border-radius:999px !important; padding:5px 12px !important; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:300px;
  border:1px solid rgba(255,255,255,.16) !important; background:rgba(255,255,255,.05) !important; }
.ss-stage .ss-scstrip .act button.go { background:var(--ss-accent,#F2FF59) !important; color:#1a1420 !important; border-color:transparent !important; font-weight:700; }
`;

const TOD = { day: ["#ffd75a", "Day"], night: ["#6f86ff", "Night"], dawn: ["#ff9f7a", "Dawn"], dusk: ["#ff8a3d", "Dusk"], cont: ["#a9a3ad", "Continuous"] };

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.className = v;
    else if (v === true) e.setAttribute(k, "");
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};

const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * What the compact scene button shows: the scene on the stage (number, place, time of day) and the shot being worked
 * on. Without a script: "The stage" and its shot count.
 */
export function pickInfo(scenes, cur, shots, active) {
  const list = scenes || [];
  const sh = (shots || []).find((s) => s.id === active) || null;
  const shot = sh ? String(sh.name || sh.id) : "";
  if (!list.length) {
    const n = (shots || []).length;
    return { num: "", where: "The stage", time: null, shot, sub: `${n} shot${n === 1 ? "" : "s"}`, scenes: 0 };
  }
  const sc = list.find((x) => x.id === cur) || null;
  if (!sc) return { num: "", where: "Pick a scene", time: null, shot, sub: `${list.length} scene${list.length === 1 ? "" : "s"}`, scenes: list.length };
  const c = sceneChip(sc);
  return { num: c.number, where: c.where || sc.heading || "", time: c.time, shot, sub: shot, scenes: list.length };
}

export class SceneStrip {
  constructor(host, o) {
    this.o = o;
    if (!document.getElementById("ss-scstrip-css")) document.head.append(h("style", { id: "ss-scstrip-css" }, CSS));
    this.el = h("div", { class: "ss-scstrip", role: "toolbar", "aria-label": "Scenes and shots" });
    for (const t of ["pointerdown", "wheel"]) this.el.addEventListener(t, (e) => e.stopPropagation(), { passive: t === "wheel" });
    this.prev = h("button", { type: "button", class: "nav", title: "Previous scene (←)", "aria-label": "Previous scene", on: { click: () => this.step(-1) } }, "◀");
    this.next = h("button", { type: "button", class: "nav", title: "Next scene (→)", "aria-label": "Next scene", on: { click: () => this.step(1) } }, "▶");
    this.rail = h("div", { class: "rail" });
    // A wheel over the rail scrolls it sideways (one row, no vertical scroll).
    this.rail.addEventListener("wheel", (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.rail.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    this.act = h("div", { class: "act" });
    this.el.append(this.prev, this.rail, this.next, this.act);
    // The compact form (canvas layout): one button naming the scene on the stage; the host decides what it opens.
    this.pick = h("button", { type: "button", class: "ss-scpick", "aria-haspopup": "true", "aria-expanded": "false",
      on: { click: () => this.onPick?.() } });
    this.onPick = null;
    this.pick.addEventListener("pointerdown", (e) => e.stopPropagation());
    this._thumbs = new Map();   // shot id -> {canvas, t}
    this._key = (e) => this._onKey(e);
    window.addEventListener("keydown", this._key, true);   // before ComfyUI's own key bindings
    host.append(this.el);
  }

  dispose() { window.removeEventListener("keydown", this._key, true); this.el.remove(); }

  _onKey(e) {
    if (this.el.hidden || !this.el.isConnected || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const t = e.target;
    if (t && (EDITABLE.test(t.tagName || "") || t.isContentEditable || t.closest?.(".ss-cv, .ss-cut, .ss-strip, [role=slider], dialog, [role=dialog]"))) return;   // a dialog's arrows are its own (Presets cards)
    if (!this.el.offsetParent && !this.pick.offsetParent) return;   // not on screen (folded: the scene button is)
    if (!this.o.getScript?.()?.scenes?.length) return;
    e.preventDefault();
    e.stopPropagation();
    this.step(e.key === "ArrowLeft" ? -1 : 1);
  }

  step(dir) {
    const scenes = this.o.getScript?.()?.scenes || [];
    const id = stepScene(scenes, this.o.current?.(), dir);
    if (id) this.o.onScene?.(id);
  }

  /** Coalesced redraw (many callers in a row draw once). */
  render() {
    if (this._raf) return;
    const run = () => { this._raf = 0; try { this._draw(); } catch (e) { console.warn("[Soundstage] scene strip", e); } };
    this._raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : setTimeout(run, 0);
  }

  _thumb(s) {
    const t = typeof s.thumb === "string" ? s.thumb : null;
    if (t) return h("img", { src: t, alt: "" });
    const c = h("canvas", { width: "168", height: "92" });
    const cached = this._thumbs.get(s.id);
    if (cached && Date.now() - cached.t < 4000) { c.getContext("2d").drawImage(cached.canvas, 0, 0); return c; }
    if (typeof s.thumb === "function") {
      try {
        const src = s.thumb();
        if (src) {
          c.getContext("2d").drawImage(src, 0, 0, 168, 92);
          const keep = h("canvas", { width: "168", height: "92" });
          keep.getContext("2d").drawImage(c, 0, 0);
          this._thumbs.set(s.id, { canvas: keep, t: Date.now() });
        }
      } catch { /* stage not ready */ }
    }
    return c;
  }

  _shots(list, active) {
    if (!list.length) return h("span", { class: "noshot" }, "no shots yet");
    return h("div", { class: "shots" }, ...list.map((s) => {
      const st = this.o.shotStatus?.(s.id) || null;
      return h("button", { type: "button", class: "shot", "aria-pressed": String(s.id === active), title: `${s.name}${st?.title ? ` · ${st.title}` : ""}`,
        on: { click: (e) => { e.stopPropagation(); this.o.onShot?.(s.id); } } },
        this._thumb(s), h("span", { class: "nm" }, s.name), h("span", { class: `dot ${st?.cls || ""}` }));
    }));
  }

  _drawPick(scenes, cur, shots, active) {
    const p = pickInfo(scenes, cur, shots, active);
    const [col, todLabel] = TOD[p.time] || [null, ""];
    this.pick.replaceChildren(...[
      p.num ? h("span", { class: "num" }, p.num) : null,
      h("span", { class: "meta" }, h("span", { class: "where" }, p.where),
        h("span", { class: "sub" }, col ? h("i", { style: `background:${col}`, title: todLabel }) : null, p.sub || "")),
      h("span", { class: "car", "aria-hidden": "true" }, "▾")].filter(Boolean));
    this.pick.title = `${p.num ? `Scene ${p.num}: ` : ""}${p.where}${p.shot ? ` · shot: ${p.shot}` : ""}\nClick to pick a scene or a shot${scenes.length ? " (← → step through scenes)" : ""}`;
  }

  _draw() {
    const scenes = this.o.getScript?.()?.scenes || [];
    let shots = [];
    try { shots = this.o.getShots?.() || []; } catch { /* host not ready */ }
    const cur = this.o.current?.() || null;
    const active = this.o.activeShot?.() || null;
    const chips = [];
    if (!scenes.length) {
      // No script: the stage as one scene, its shots only.
      chips.push(h("div", { class: "chip", "aria-current": "true" }, h("span", { class: "num" }, "▣"),
        h("div", { class: "meta" }, h("span", { class: "where" }, "The stage"), h("span", { class: "sub" }, `${shots.length} shot${shots.length === 1 ? "" : "s"}`)),
        this._shots(shots, active)));
    }
    for (const sc of scenes) {
      const c = sceneChip(sc);
      const on = sc.id === cur;
      const mine = shots.filter((s) => s.scene_id === sc.id);
      const [col, todLabel] = TOD[c.time] || [null, ""];
      const chip = h(on ? "div" : "button", { type: on ? null : "button", class: "chip", "aria-current": String(on), "data-id": sc.id,
        title: `Scene ${c.number}: ${sc.heading || c.where}${c.names.length ? `\n${c.names.join(", ")}` : ""}\n${mine.length} shot${mine.length === 1 ? "" : "s"}${on ? "" : "\nClick to set it up on the stage"}`,
        on: { click: () => { if (!on) this.o.onScene?.(sc.id); } } },
        h("span", { class: "num" }, c.number),
        h("div", { class: "meta" }, h("span", { class: "where" }, c.where || sc.heading || ""),
          h("span", { class: "sub" }, col ? h("span", { class: "tod" }, h("i", { style: `background:${col}` }), c.timeText ? c.timeText.toLowerCase() : todLabel) : null,
            c.initials.length ? h("span", { class: "ini" }, ...c.initials.slice(0, 4).map((x, i) => h("b", { title: c.names[i] }, x))) : null,
            on ? null : h("span", {}, mine.length ? `${mine.length}▸` : ""))),
        on ? this._shots(mine, active) : null);
      chips.push(chip);
    }
    this.rail.replaceChildren(...chips);
    const i = scenes.findIndex((x) => x.id === cur);
    this.prev.disabled = !scenes.length || i === 0;
    this.next.disabled = !scenes.length || i === scenes.length - 1;
    this.prev.hidden = this.next.hidden = !scenes.length;
    this._drawPick(scenes, cur, shots, active);
    // The setup action for the scene on the stage (and Undo right after one).
    const info = this.o.setupInfo?.() || null;
    const acts = [];
    if (info?.canUndo) acts.push(h("button", { type: "button", title: `Undo: ${info.undoLabel || "the scene setup"}`, on: { click: () => this.o.onUndo?.() } }, "↶ Undo setup"));
    if (info?.label && info.changes > 0) acts.push(h("button", { type: "button", class: info.canUndo ? "" : "go", title: `${info.label}: its set, time of day, characters and vehicles (adds what's missing, removes nothing you placed)`,
      on: { click: () => this.o.onSetup?.() } }, info.label));
    this.act.replaceChildren(...acts);
    this.act.hidden = !acts.length;
    // Folded, a dot on the scene button says "this scene can be set up" (the button itself is in the drop-down).
    this.pick.dataset.setup = String(acts.some((b) => b.classList.contains("go")));
    // Keep the active scene in view.
    const a = this.rail.querySelector('.chip[aria-current="true"]');
    if (a && this._lastCur !== cur) {
      this._lastCur = cur;
      const r = a.offsetLeft - this.rail.offsetLeft;
      if (r < this.rail.scrollLeft || r + a.offsetWidth > this.rail.scrollLeft + this.rail.clientWidth) this.rail.scrollLeft = Math.max(0, r - 40);
    }
  }
}
