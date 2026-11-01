// First run: a short, skippable guided tour (coach marks pointing at the real controls) and an empty-state card on a
// brand-new stage with three ways in (the demo scene, a script, a video). The tour runs once per browser (remembered
// in localStorage, every access in try/catch) and comes back from the "?" Guide button in the top row.
//
//   const tour = new Tour(steps, { onEnd });   // steps: [{ id, title, text, target: () => Element | Element[] | null, before? }]
//   tour.start();
//   const card = emptyCard({ onDemo, onScript, onVideo, onClose });
import { TOKENS as T, FONT } from "./theme.mjs";
import { icon } from "./icons.mjs";

const LS_TOUR = "ss_tour_done";

/** Has this browser seen (or skipped) the tour? Blocked storage counts as seen, so it never nags on every load. */
export function tourSeen(storage = globalThis.localStorage) {
  try { return storage?.getItem(LS_TOUR) === "1"; } catch { return true; }
}

export function markTourSeen(storage = globalThis.localStorage) {
  try { storage?.setItem(LS_TOUR, "1"); } catch { /* storage blocked */ }
}

/** The tour, one sentence a step. The host adds where each one points (target) and what to open first (before). */
export const TOUR_STEPS = [
  { id: "start", title: "Start here",
    text: "Import a script, turn a video clip into 3D with Import video, or try the demo scene: each one builds a stage for you." },
  { id: "scene", title: "Pick a scene",
    text: "Pick a scene here and the stage builds itself: the set, the light, the people and the cars." },
  { id: "block", title: "③ Set: block it",
    text: "Click a person or a car to select it: its bar has Move, Rotate and Scale, the yellow ring at its feet turns it, and dragging empty space looks around." },
  { id: "frame", title: "④ Frame",
    text: "Press Generate frames to paint real-looking first frames from your 3D clay, then click the one you like." },
  { id: "motion", title: "⑤ Motion",
    text: "Make a quick Draft first to check the movement, then render the Final with sound." },
  { id: "finish", title: "⑥ Review · ⑦ Deliver",
    text: "Compare clay, frame, draft and final in Review, then export your video and VFX layers in Deliver." },
];

/**
 * A brand-new stage: no script, nothing rendered, and the stage is still the default scene (Actor A and Actor B on
 * the plaza, at most the one Master camera). Anything the user added, moved or imported makes it not new.
 */
export function isBrandNewStage(scene, { hasScript = false, renders = 0 } = {}) {
  if (!scene || hasScript || renders > 0) return false;
  const actors = scene.actors || [];
  if (actors.length !== 2 || actors.some((a) => !["actor_a", "actor_b"].includes(a.id))) return false;
  if (actors.some((a) => a.mount_id || a.mocap || a.pose || a.appearance || (a.keys || []).length > 2)) return false;
  if ((scene.environment?.set || "plaza") !== "plaza") return false;
  const props = scene.props || [];
  if (props.length !== 4 || props.some((p) => !["building", "planter_l", "planter_r", "lamp"].includes(p.id))) return false;
  if ((scene.shots || []).length > 1) return false;
  if ((scene.lighting?.lights || []).length) return false;
  return true;
}

/**
 * Where a coach-mark card goes: under the target if it fits, else above, right, left; with no target, centred.
 * Always kept inside the viewport (margin m). Returns {left, top, side}.
 */
export function placeCard(target, card, view, { gap = 14, m = 12 } = {}) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  if (!target) return { left: Math.round((view.w - card.w) / 2), top: Math.round((view.h - card.h) / 2), side: "center" };
  const cx = (target.left + target.right) / 2, cy = (target.top + target.bottom) / 2;
  const fits = {
    below: target.bottom + gap + card.h <= view.h - m,
    above: target.top - gap - card.h >= m,
    right: target.right + gap + card.w <= view.w - m,
    left: target.left - gap - card.w >= m,
  };
  const side = ["below", "above", "right", "left"].find((s) => fits[s]) || "inside";
  let left, top;
  if (side === "below" || side === "above") {
    left = cx - card.w / 2;
    top = side === "below" ? target.bottom + gap : target.top - gap - card.h;
  } else if (side === "right" || side === "left") {
    top = cy - card.h / 2;
    left = side === "right" ? target.right + gap : target.left - gap - card.w;
  } else {
    // The target fills the screen (the whole canvas): sit inside it, near its bottom.
    left = cx - card.w / 2;
    top = Math.min(target.bottom, view.h) - card.h - 3 * m;
  }
  return { left: Math.round(clamp(left, m, view.w - card.w - m)), top: Math.round(clamp(top, m, view.h - card.h - m)), side };
}

/**
 * Is a target's box hidden (in part) by the box it is seen through (the viewport, or a scrolling panel such as
 * ComfyUI's App side panel)? A target taller than the box counts as shown once its top is in view. tol = px slack.
 */
export function outOfView(r, box, tol = 2) {
  if (!r || !box) return false;
  const tooTall = r.bottom - r.top > box.bottom - box.top;
  const topIn = r.top >= box.top - tol && r.top <= box.bottom - 24;
  if (tooTall) return !topIn;
  return r.top < box.top - tol || r.bottom > box.bottom + tol;
}

/** The nearest ancestor that scrolls vertically (its content taller than it), or null. */
function scrollParent(e) {
  for (let p = e?.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

/** The bounding box of several elements (the visible ones), or null. */
export function unionRect(rects) {
  const rs = rects.filter((r) => r && r.width > 0 && r.height > 0);
  if (!rs.length) return null;
  const left = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top));
  const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

const CSS = `
.ss-tour { position:fixed; inset:0; z-index:100000; font:13px/1.45 ${FONT}; color:${T.text}; }
.ss-tour, .ss-tour * { box-sizing:border-box; }
.ss-tour-hole { position:fixed; border-radius:14px; border:2px solid ${T.accent}; pointer-events:none;
  box-shadow:0 0 0 9999px rgba(10,7,13,.66), 0 0 0 6px rgba(242,255,89,.18); transition:left .18s, top .18s, width .18s, height .18s; }
.ss-tour-hole[data-none=true] { border:0; width:0 !important; height:0 !important; left:50% !important; top:50% !important; }
.ss-tour-card { position:fixed; width:340px; max-width:calc(100vw - 24px); background:${T.raised}; border:1px solid ${T.lineStrong};
  border-radius:16px; padding:14px 16px 12px; box-shadow:0 18px 50px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:8px;
  transition:left .18s, top .18s; }
.ss-tour-top { display:flex; align-items:center; gap:8px; }
.ss-tour-count { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:${T.muted}; font-weight:600; }
.ss-tour-dots { display:flex; gap:4px; margin-left:auto; }
.ss-tour-dots i { width:6px; height:6px; border-radius:50%; background:${T.lineStrong}; }
.ss-tour-dots i[data-on=true] { background:${T.accent}; }
.ss-tour-card h4 { margin:0; font-size:16px; font-weight:700; color:${T.text}; }
.ss-tour-card p { margin:0; font-size:13.5px; color:${T.text}; opacity:.9; }
.ss-tour-btns { display:flex; gap:8px; align-items:center; margin-top:4px; }
.ss-tour-btns button { font:600 13px ${FONT}; border-radius:999px; padding:6px 14px; cursor:pointer; border:1px solid ${T.lineStrong};
  background:transparent; color:${T.text}; }
.ss-tour-btns button:disabled { opacity:.35; cursor:default; }
.ss-tour-btns .skip { border-color:transparent; color:${T.muted}; padding-left:2px; margin-right:auto; }
.ss-tour-btns .next { background:${T.accent}; color:${T.accentInk}; border-color:${T.accent}; }
.ss-tour-btns button:focus-visible { outline:2px solid ${T.accent}; outline-offset:2px; }

/* The empty-state card on a brand-new stage (Milestone 14: the first five seconds). One yellow way in, two quiet ones,
   type on the App's scale, a soft entrance, and the stage dimmed around it so the eye lands on the card. */
.ss-stage .ss-empty { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:12; width:min(600px, calc(100% - 24px));
  max-height:calc(100% - 16px); overflow:auto; scrollbar-width:none;
  background:rgba(30,23,36,.94); border:1px solid ${T.lineStrong}; border-radius:18px; padding:22px 22px 14px;
  box-shadow:0 24px 70px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
  backdrop-filter:blur(16px) saturate(1.2); -webkit-backdrop-filter:blur(16px) saturate(1.2); display:flex; flex-direction:column; gap:14px;
  animation:ss-empty-in .32s cubic-bezier(.2,.8,.2,1) both; }
@keyframes ss-empty-in { from { opacity:0; transform:translate(-50%,calc(-50% + 10px)) scale(.985); } to { opacity:1; transform:translate(-50%,-50%); } }
@media (prefers-reduced-motion: reduce) { .ss-stage .ss-empty { animation:none; } }
.ss-stage .ss-empty[hidden], .ss-stage[data-tour]:not([data-tour=start]) .ss-empty { display:none !important; }
.ss-stage .ss-empty .eyebrow { margin:0; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:${T.muted}; }
.ss-stage .ss-empty h4 { margin:-8px 0 0; font-size:22px; line-height:1.2; font-weight:600; letter-spacing:-.005em; color:${T.text}; }
.ss-stage .ss-empty .sub { margin:-8px 0 2px; color:${T.muted}; font-size:13px; }
.ss-stage .ss-empty .ways { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
.ss-stage .ss-empty button.way { display:flex !important; flex-direction:column !important; align-items:flex-start !important; gap:8px !important;
  padding:14px 14px 16px !important; border-radius:14px !important; text-align:left; min-height:132px; white-space:normal;
  background:rgba(255,255,255,.035) !important; border:1px solid ${T.line} !important; }
.ss-stage .ss-empty button.way:hover:not(:disabled) { background:rgba(255,255,255,.07) !important; border-color:${T.lineStrong} !important; }
.ss-stage .ss-empty button.way .ss-icon { width:20px; height:20px; padding:7px; box-sizing:content-box; border-radius:10px; background:rgba(255,255,255,.06);
  color:${T.text}; }
.ss-stage .ss-empty button.way b { font-size:14px; line-height:1.25; font-weight:600; }
.ss-stage .ss-empty button.way span { font-size:12px; color:${T.muted}; font-weight:400; line-height:1.4; }
.ss-stage .ss-empty button.way.main { background:${T.accent} !important; color:${T.accentInk} !important; border-color:${T.accent} !important;
  box-shadow:0 8px 26px rgba(242,255,89,.16); }
.ss-stage .ss-empty button.way.main:hover:not(:disabled) { background:${T.accentHover} !important; border-color:${T.accentHover} !important; }
.ss-stage .ss-empty button.way.main .ss-icon { background:rgba(33,25,39,.10); color:${T.accentInk}; }
.ss-stage .ss-empty button.way.main span { color:rgba(33,25,39,.78); }
.ss-stage .ss-empty .foot { display:flex; align-items:center; gap:8px; padding-top:10px; border-top:1px solid ${T.line}; }
.ss-stage .ss-empty .foot button { font-size:12px !important; padding:4px 10px !important; background:transparent !important; border-color:transparent !important;
  color:${T.muted} !important; margin-left:-10px; }
.ss-stage .ss-empty .foot button:hover:not(:disabled) { color:${T.text} !important; background:rgba(255,255,255,.06) !important; }
.ss-stage .ss-empty .foot .keys { margin-left:auto; display:inline-flex; align-items:center; gap:6px; color:${T.faint}; font-size:12px; }
.ss-stage .ss-empty .foot kbd { font:600 11px/1 ${FONT}; padding:3px 6px; border-radius:5px; border:1px solid ${T.lineStrong}; border-bottom-width:2px;
  color:${T.muted}; background:rgba(255,255,255,.04); }
/* While the card is up, the stage behind it steps back, and the header's Import video is a quiet copy of the card's third way. */
.ss-stage .ss-vpcell:has(> .ss-empty:not([hidden])) { position:relative; }
.ss-stage .ss-vpcell:has(> .ss-empty:not([hidden])) > .ss-stageview::after { content:""; position:absolute; inset:0; pointer-events:none; z-index:5;
  border-radius:inherit; background:radial-gradient(120% 95% at 50% 50%, rgba(18,13,22,.30) 0%, rgba(18,13,22,.72) 100%); }
.ss-stage:has(.ss-vpcell > .ss-empty:not([hidden])) .ss-stageview > .ss-vi-cta:not([data-big=true]) { display:none !important; }
.ss-stage:has(.ss-vpcell > .ss-empty:not([hidden])) button.ss-vi-head { background:${T.raised} !important; color:${T.text} !important;
  border-color:${T.lineStrong} !important; }
.ss-stage[data-ws=narrow] .ss-empty { position:relative; left:auto; top:auto; transform:none; width:auto; margin:8px 0; animation:none; }
@container (max-width: 520px) { .ss-stage .ss-empty .ways { grid-template-columns:1fr; } .ss-stage .ss-empty button.way { min-height:0; } }
.ss-stage[data-ws=narrow] .ss-empty .ways { grid-template-columns:1fr; }
.ss-stage[data-ws=narrow] .ss-empty button.way { min-height:0; }
`;

export function applyFirstRunCss() {
  if (document.getElementById("soundstage-firstrun")) return;
  const s = document.createElement("style");
  s.id = "soundstage-firstrun";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const mk = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const btn = (cls, label, fn, title = "") => {
  const b = mk("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", fn);
  return b;
};

/** The empty-state card: three big ways in, and a quiet "start from a blank stage". */
export function emptyCard({ onDemo, onScript, onVideo, onClose }) {
  const way = (cls, ic, title, sub, fn, tip) => {
    const b = btn(`way ${cls}`, [icon(ic, 24), mk("b", "", title), mk("span", "", sub)], fn, tip);
    return b;
  };
  const card = mk("section", "ss-empty");
  card.setAttribute("aria-label", "Start a new scene");
  for (const t of ["pointerdown", "wheel"]) card.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
  card.append(
    mk("p", "eyebrow", "New stage"),
    mk("h4", "", "Let's make a shot"),
    mk("p", "sub", "Pick a way in. Everything stays editable."),
    mk("div", "ways",
      way("main", "clapperboard", "Try the demo scene", "A night car chase, already blocked with three camera angles.", onDemo,
        "Loads the sample script and its car chase scene (police car, sports car, three shots)"),
      way("", "file-text", "Import a script", "A screenplay (PDF, Fountain, FDX or text) becomes scenes you can stage.", onScript,
        "Opens ① Script: import a screenplay, then pick a scene and the stage builds itself"),
      way("", "file-video-camera", "Import a video", "A clip becomes a 3D set with its camera and performer.", onVideo,
        "Turns a video into 3D: its camera, the performer's motion (SAM 3D Body) and the set pieces")),
    mk("div", "foot", btn("", "Start from a blank stage", onClose, "Hide this card and block the scene yourself"),
      mk("span", "keys", "Shortcuts", mk("kbd", "", "?"))),
  );
  return card;
}

/** The coach-mark tour: a dimmed screen with a hole around the real control, and a card with Back / Next / Skip. */
export class Tour {
  constructor(steps, { onEnd = null, root = null, font = null } = {}) {
    applyFirstRunCss();
    this.steps = steps;
    this.onEnd = onEnd;
    this.root = root || document.body;
    this.font = font;
    this.i = -1;
    this.el = null;
  }

  get open() { return !!this.el; }

  start(i = 0) {
    this.close(false);
    const el = mk("div", "ss-tour");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Soundstage guided tour");
    if (this.font) el.style.fontFamily = this.font;
    this.hole = mk("div", "ss-tour-hole");
    this.count = mk("span", "ss-tour-count");
    this.dots = mk("span", "ss-tour-dots", ...this.steps.map(() => mk("i")));
    this.title = mk("h4");
    this.text = mk("p");
    this.text.setAttribute("aria-live", "polite");
    this.backBtn = btn("back", "Back", () => this.go(this.i - 1));
    this.nextBtn = btn("next", "Next", () => (this.i >= this.steps.length - 1 ? this.close(true) : this.go(this.i + 1)));
    this.skipBtn = btn("skip", "Skip tour", () => this.close(false));
    this.card = mk("div", "ss-tour-card", mk("div", "ss-tour-top", this.count, this.dots), this.title, this.text,
      mk("div", "ss-tour-btns", this.skipBtn, this.backBtn, this.nextBtn));
    el.append(this.hole, this.card);
    // Nothing under the dim layer reacts while the tour is up (ComfyUI's canvas included).
    for (const t of ["pointerdown", "wheel", "contextmenu"]) el.addEventListener(t, (e) => e.stopPropagation(), { passive: t === "wheel" });
    this._key = (e) => {
      if (!this.el) return;
      const k = e.key;
      if (k === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(false); return; }
      if (k === "ArrowRight") { e.preventDefault(); e.stopPropagation(); this.nextBtn.click(); return; }
      if (k === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); if (this.i > 0) this.go(this.i - 1); return; }
      if (k === "Tab" || k === "h" || k === "H") e.stopPropagation();   // keep the canvas's panel-hiding keys out of the tour
    };
    window.addEventListener("keydown", this._key, true);
    this._re = () => this.place();
    window.addEventListener("resize", this._re);
    this._poll = setInterval(this._re, 300);   // views open, panels settle: keep the hole on the control
    this.el = el;
    this.root.append(el);
    this.go(i);
  }

  async go(i) {
    if (!this.el) return;
    i = Math.max(0, Math.min(i, this.steps.length - 1));
    const s = this.steps[i];
    this.i = i;
    try { await s.before?.(); } catch (e) { console.warn("[Soundstage] tour step", e); }
    if (!this.el || this.i !== i) return;
    this.count.textContent = `${i + 1} of ${this.steps.length}`;
    [...this.dots.children].forEach((d, k) => (d.dataset.on = String(k === i)));
    this.title.textContent = s.title;
    this.text.textContent = s.text;
    this.backBtn.disabled = i === 0;
    this.nextBtn.textContent = i === this.steps.length - 1 ? "Done" : "Next";
    this._reveal();
    this.place();
    requestAnimationFrame(() => this.place());
    try { this.nextBtn.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
  }

  /** Bring the step's control into view when a scrolling panel (the App's narrow side panel) has it out of sight. */
  _reveal() {
    let t = null;
    try { t = this.steps[this.i]?.target?.(); } catch { t = null; }
    const first = (Array.isArray(t) ? t : [t]).find((x) => x && x.isConnected && x.getClientRects().length);
    if (!first) return;
    const sp = scrollParent(first);
    const vb = { top: 0, bottom: window.innerHeight };
    const pb = sp ? sp.getBoundingClientRect() : null;
    const box = pb ? { top: Math.max(vb.top, pb.top), bottom: Math.min(vb.bottom, pb.bottom) } : vb;
    if (outOfView(first.getBoundingClientRect(), box)) {
      try { first.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch { /* old browser */ }
    }
  }

  _rect() {
    const s = this.steps[this.i];
    let t = null;
    try { t = s?.target?.(); } catch { t = null; }
    const els = (Array.isArray(t) ? t : [t]).filter((x) => x && x.isConnected && x.getClientRects().length);
    return unionRect(els.map((x) => x.getBoundingClientRect()));
  }

  place() {
    if (!this.el) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    let r = this._rect();
    const pad = 6;
    if (r) {
      // Keep the hole on screen.
      const left = Math.max(4, r.left - pad), top = Math.max(4, r.top - pad);
      const right = Math.min(vw - 4, r.right + pad), bottom = Math.min(vh - 4, r.bottom + pad);
      r = { left, top, right, bottom, width: right - left, height: bottom - top };
      Object.assign(this.hole.style, { left: `${left}px`, top: `${top}px`, width: `${r.width}px`, height: `${r.height}px` });
      this.hole.dataset.none = "false";
    } else this.hole.dataset.none = "true";
    const cw = this.card.offsetWidth || 340, ch = this.card.offsetHeight || 160;
    const p = placeCard(r, { w: cw, h: ch }, { w: vw, h: vh });
    this.card.style.left = `${p.left}px`;
    this.card.style.top = `${p.top}px`;
    this.card.dataset.side = p.side;
  }

  close(done = false) {
    if (!this.el) return;
    window.removeEventListener("keydown", this._key, true);
    window.removeEventListener("resize", this._re);
    clearInterval(this._poll);
    this.el.remove();
    this.el = null;
    const i = this.i;
    this.i = -1;
    this.onEnd?.({ done, step: i });
  }
}
