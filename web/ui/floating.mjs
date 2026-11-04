// Floating panels: every panel and pop-over that floats over the canvas can be dragged by its header, folded to a
// title chip (—), popped out to a second screen (⧉), and put back with Tools ▾ › Reset panel positions.
//
//   clampOffset(base, off, view)          pure: the offset that keeps a box (its rect without the offset) on screen
//   dockSlots(sizes, view, avoid)         pure: where chips stack on the right edge, clear of the Drive HUD
//   floatPanel(el, { key, title, handle, popout, essential, chipBtn })  -> Floater (wired to the pointer and keys)
//   resetPanelPositions()                 every panel back where the App puts it, unfolded
//   enterDrive(avoid, view) -> { restore }   Drive mode: fold the rest to chips on the edge, put them back on exit
//   popOut(floater) / dockBack(floater)   the panel itself moves to a second window and back (P2)
//
// Wrapping never rewrites a panel: a move is the CSS `translate` property (inline, !important), which composes with
// the panel's own position, transform or pop-over placement. Only a panel the App positions (absolute / fixed) moves;
// the same element in the Classic layout (in the page flow) is left alone and shows no controls.

const LS = "ss_fl_";
const MARGIN = 8, GAP = 6, STEP = 16;
const INTERACTIVE = "button, input, select, textarea, a[href], label, summary, [contenteditable=true], [role=tab], [role=button]";
const BLOCKED = "Pop-up blocked: allow pop-ups for this page to put a panel on a second screen.";

const ALL = new Set();
let notify = (m) => console.info("Soundstage:", m);
/** Where the helper's messages go (the App's status line). */
export function onFloatingMessage(fn) { notify = fn || notify; }

// ------------------------------------------------------------------------------------------------- pure geometry

const clampN = (v, a, b) => Math.min(Math.max(v, a), b);

/**
 * base: the panel's rect without any offset {left, top, width, height}; off {x, y}; view {left, top, width, height}.
 * Returns the nearest offset that keeps the whole panel inside the view (a panel bigger than the view keeps its
 * top-left corner, and so its header, in view). A panel the App placed (offset 0) that already fits is left as it is.
 */
export function clampOffset(base, off, view, margin = MARGIN) {
  const vl = view.left || 0, vt = view.top || 0, vr = vl + view.width, vb = vt + view.height;
  const x = off?.x || 0, y = off?.y || 0;
  const L = base.left + x, T = base.top + y;
  if (!x && !y && L >= vl && T >= vt && L + base.width <= vr && T + base.height <= vb) return { x: 0, y: 0 };
  const nl = clampN(L, vl + margin, Math.max(vl + margin, vr - margin - base.width));
  const nt = clampN(T, vt + margin, Math.max(vt + margin, vb - margin - base.height));
  return { x: Math.round(nl - base.left), y: Math.round(nt - base.top) };
}

export const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Chips stacked down the right edge of `view`, top to bottom, skipping anything in `avoid` (rects), then another column
 * to the left. sizes: [{width, height}]. Returns [{left, top}] in the same order.
 */
export function dockSlots(sizes, view, avoid = [], { margin = MARGIN, gap = GAP } = {}) {
  const vl = view.left || 0, vt = view.top || 0, vb = vt + view.height;
  let right = vl + view.width - margin, y = vt + margin, colW = 0;
  const out = [];
  for (const s of sizes) {
    let r = null;
    for (let guard = 0; guard < 400 && !r; guard++) {
      const c = { left: right - s.width, top: y, right, bottom: y + s.height };
      if (c.bottom > vb - margin && y > vt + margin) {   // this column is full: the next one to the left
        right -= (colW || s.width) + gap; y = vt + margin; colW = 0;
        if (right - s.width < vl + margin) { r = { ...c, left: vl + margin, top: vt + margin }; break; }
        continue;
      }
      const hit = avoid.filter((a) => overlaps(c, a));
      if (hit.length) { y = Math.max(...hit.map((a) => a.bottom)) + gap; continue; }
      r = c;
    }
    r ||= { left: right - s.width, top: y };
    out.push({ left: Math.round(r.left), top: Math.round(r.top) });
    y = r.top + s.height + gap;
    colW = Math.max(colW, s.width);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- persistence

const store = {
  get(k) { try { return JSON.parse(globalThis.localStorage?.getItem(LS + k) || "null"); } catch { return null; } },
  set(k, v) { try { globalThis.localStorage?.setItem(LS + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  clear() {
    try {
      const ls = globalThis.localStorage;
      for (let i = (ls?.length || 0) - 1; i >= 0; i--) { const k = ls.key(i); if (k?.startsWith(LS)) ls.removeItem(k); }
    } catch { /* storage blocked */ }
  },
};

// ------------------------------------------------------------------------------------------------- one panel

const viewOf = (win) => ({ left: 0, top: 0, width: win?.innerWidth || 1280, height: win?.innerHeight || 800 });

export class Floater {
  /** opts: key (storage), title, handle (element or selector inside el; none: a small bar is added), popout,
   *  essential (Drive leaves it open), chipBtn (adds —), store, win (tests: a fake window). */
  constructor(el, { key, title = "", handle = null, popout = false, essential = false, chipBtn = true, store: st = store, win = globalThis.window } = {}) {
    this.el = el; this.key = key; this.title = title; this.handleSpec = handle; this.popout = popout; this.essential = essential;
    this.chipBtn = chipBtn; this.store = st; this.win = win;
    const saved = st.get(key) || {};
    this.want = { x: +saved.x || 0, y: +saved.y || 0 };   // where the user put it
    this.off = { ...this.want };                          // what is applied (clamped to the window)
    this.chip = !!saved.chip;
    this.dock = null;                                     // Drive mode's temporary place
    this.z = 0;
    ALL.add(this);
  }

  /** Positioned by the App (absolute / fixed) and on screen: the only state in which it moves. */
  live() {
    const el = this.el;
    if (!el?.isConnected || this.out || !el.getClientRects?.().length) return false;
    const pos = this.win?.getComputedStyle?.(el)?.position;
    return pos === "absolute" || pos === "fixed";
  }

  /** The rect the App gives it, without our offset. */
  base() {
    const r = this.el.getBoundingClientRect();
    return { left: r.left - this.off.x, top: r.top - this.off.y, width: r.width, height: r.height };
  }

  /** Apply the offset (clamped to the window) and the chip state. */
  refresh(view = viewOf(this.win)) {
    const el = this.el, live = this.live();
    if (el.dataset) el.dataset.flLive = String(live);
    el.toggleAttribute?.("data-fl-chip", live && this.chip);
    if (!live) { el.style.removeProperty("translate"); el.style.removeProperty("max-height"); return; }
    this._chipHeight();
    const target = this.dock || this.want;
    const prev = this.off;
    this.off = { x: 0, y: 0 };
    el.style.removeProperty("translate");
    const b = this.base();
    this.off = this.dock ? { ...target } : clampOffset(b, target, view);
    if (this.off.x || this.off.y) el.style.setProperty("translate", `${this.off.x}px ${this.off.y}px`, "important");
    if (prev.x !== this.off.x || prev.y !== this.off.y) this._syncCtl?.();
  }

  // a panel pinned top and bottom (a tall pop-over) still shrinks to its header as a chip
  _chipHeight() {
    const el = this.el, h = this._handle;
    if (!this.chip || !h?.getBoundingClientRect) { el.style.removeProperty("max-height"); return; }
    el.style.removeProperty("max-height");
    const r = el.getBoundingClientRect(), hr = h.getBoundingClientRect();
    const cs = this.win?.getComputedStyle?.(el);
    const pad = (parseFloat(cs?.paddingBottom) || 0) + (parseFloat(cs?.borderBottomWidth) || 0);
    el.style.setProperty("max-height", `${Math.ceil(hr.bottom - r.top + pad)}px`, "important");
  }

  /** Move by a delta (a drag, the arrow keys); `save` remembers it. */
  moveBy(dx, dy, save = true) {
    const t = this.dock || this.want;
    const b = this.base();
    const n = clampOffset(b, { x: t.x + dx, y: t.y + dy }, viewOf(this.win));
    // a chip in Drive mode keeps its new place for the drive only
    if (this.dock) this.dock = n; else this.want = n;
    this.refresh();
    if (save && !this.dock) this.save();
  }

  setChip(on, save = true) {
    this.chip = !!on;
    this.refresh();
    if (save) this.save();
    this._syncCtl?.();
  }

  reset() {
    this.want = { x: 0, y: 0 }; this.dock = null; this.chip = false;
    this.refresh();
    this._syncCtl?.();
  }

  save() { this.store.set(this.key, { x: this.want.x, y: this.want.y, chip: this.chip }); }

  /** Bring it in front of the other floating panels (within its own layer: never above menus or dialogs). */
  raise() {
    const list = [...ALL].filter((f) => f.el.parentNode === this.el.parentNode);
    const top = Math.max(0, ...list.map((f) => f.z));
    if (this.z && this.z === top) return;
    this.z = top + 1;
    if (this.z > 40) {   // renumber, keeping the order
      list.sort((a, b) => a.z - b.z).forEach((f, i) => { f.z = i + 1; f._applyZ(); });
    } else this._applyZ();
  }

  _applyZ() {
    if (this.baseZ == null) { const z = parseInt(this.win?.getComputedStyle?.(this.el)?.zIndex, 10); this.baseZ = Number.isFinite(z) ? z : 1; }
    this.el.style.setProperty("z-index", String(this.baseZ + this.z), "important");
  }

  destroy() {
    ALL.delete(this);
    this._ro?.disconnect();
    if (this.out) dockBack(this);
  }

  // ---------------------------------------------------------------- the DOM: header, controls, pointer and keys
  wire() {
    const el = this.el, doc = el.ownerDocument;
    el.classList.add("ss-fl");
    el.dataset.flKey = this.key;
    injectCss(doc);
    this.ensureHandle();
    let drag = null, dragged = false;
    el.addEventListener("pointerdown", (e) => {
      if (!this.live()) return;
      this.raise();
      const h = e.target.closest?.(".ss-fl-handle");
      if (!h || !el.contains(h) || e.button !== 0) return;
      const hit = e.target.closest(INTERACTIVE);
      if (hit && hit !== h && h.contains(hit)) return;   // a button in the header still clicks
      drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, h };
    }, true);
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) { drag.moved = true; el.dataset.flDrag = "1"; try { drag.h.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
      e.preventDefault();
      drag.x = e.clientX; drag.y = e.clientY;
      this.moveBy(dx, dy, false);
    });
    const end = () => {
      if (!drag) return;
      if (drag.moved) { dragged = true; setTimeout(() => { dragged = false; }, 0); if (!this.dock) this.save(); }
      delete el.dataset.flDrag;
      drag = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("click", (e) => {
      const h = e.target.closest?.(".ss-fl-handle");
      if (!h) return;
      if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; return; }
      // a click on a chip's title opens it
      if (this.chip && !e.target.closest(".ss-fl-ctl") && !(e.target.closest(INTERACTIVE) && e.target.closest(INTERACTIVE) !== h)) { this.setChip(false); }
    }, true);
    // The header is focusable: the arrow keys move the panel (Shift: further). Esc is left to the panel.
    el.addEventListener("keydown", (e) => {
      const h = e.target.closest?.(".ss-fl-handle");
      if (!h || e.target !== h || !this.live()) return;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      const s = e.shiftKey ? STEP * 4 : STEP;
      this.moveBy(d[0] * s, d[1] * s);
    });
    el.addEventListener("pointerover", () => this.ensureHandle(), { passive: true });
    const RO = this.win?.ResizeObserver;
    if (RO) { this._ro = new RO(() => { this.ensureHandle(); this.refresh(); }); this._ro.observe(el); }
    this.refresh();
    this.ensureHandle();
    return this;
  }

  /** Finds (or makes) the header and puts the controls in it; a panel that rebuilds its header gets them back. */
  ensureHandle() {
    const el = this.el, doc = el.ownerDocument;
    const needCtl = this.chipBtn || this.popout;
    let h = typeof this.handleSpec === "string" ? el.querySelector(this.handleSpec) : this.handleSpec;
    if (h && el.contains(h)) { if (h !== this._handle) el.querySelector(":scope > .ss-fl-bar")?.remove(); } else h = null;
    if (this._handle && this._handle === (h || el.querySelector(":scope > .ss-fl-bar")) && el.contains(this._handle)
      && (!needCtl || this._handle.querySelector(":scope > .ss-fl-ctl"))) return this._handle;
    if (!h && !this.live()) return null;   // a bar only on a panel that floats now
    if (!h) {
      h = el.querySelector(":scope > .ss-fl-bar") || Object.assign(doc.createElement("div"), { className: "ss-fl-bar" });
      if (!h.firstChild) h.append(Object.assign(doc.createElement("span"), { className: "ss-fl-grip", textContent: "⠿ " + this.title }));
      if (h.parentNode !== el) el.prepend(h);
    }
    h.classList.add("ss-fl-handle");
    if (!h.matches("button, a[href], input, select, textarea") && !h.hasAttribute("tabindex")) h.tabIndex = 0;
    if (!h.title) h.title = `Drag to move ${this.title} (arrow keys too)`;
    // the direct child holding the header stays visible as a chip
    for (const c of el.children) c.classList.toggle("ss-fl-hold", c === h || c.contains(h));
    if (!needCtl) { this._handle = h; return h; }
    const ctl = Object.assign(doc.createElement("span"), { className: "ss-fl-ctl" });
    const mk =(cls, txt, tip, fn) => {
      const b = Object.assign(doc.createElement("button"), { type: "button", className: cls, textContent: txt, title: tip });
      b.setAttribute("aria-label", tip);
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      ctl.append(b);
      return b;
    };
    this._chipB = this.chipBtn ? mk("ss-fl-min", "—", `Fold ${this.title} to a chip`, () => this.setChip(!this.chip)) : null;
    this._popB = this.popout ? mk("ss-fl-pop", "⧉", `Pop ${this.title} out to its own window (a second screen)`, () => (this.out ? dockBack(this) : popOut(this))) : null;
    if (ctl.childNodes.length) {
      h.querySelector(":scope > .ss-fl-ctl")?.remove();
      // before a close button at the end of the header, so × stays the last thing
      const close = [...h.children].reverse().find((c) => c.matches("button") && /^(×|✕)?$/.test(c.textContent.trim()) && /close/i.test(c.title + (c.getAttribute("aria-label") || "")));
      h.insertBefore(ctl, close || null);
    }
    this._syncCtl = () => {
      if (this._chipB) { this._chipB.textContent = this.chip ? "▢" : "—"; this._chipB.title = this.chip ? `Open ${this.title}` : `Fold ${this.title} to a chip`; this._chipB.setAttribute("aria-label", this._chipB.title); }
      if (this._popB) { this._popB.textContent = this.out ? "⇲" : "⧉"; this._popB.title = this.out ? "Dock back into the App" : `Pop ${this.title} out to its own window (a second screen)`; }
    };
    this._syncCtl();
    this._handle = h;
    return h;
  }
}

/** Make a panel floating. Safe to call twice (returns the same Floater). */
export function floatPanel(el, opts) {
  if (!el) return null;
  if (el._ssFloat) return el._ssFloat;
  const f = new Floater(el, opts);
  el._ssFloat = f;
  if (typeof document !== "undefined" && el.ownerDocument) {
    f.wire();
    watchWindow(f.win);
  }
  return f;
}

export const floaters = () => [...ALL];

/** Every panel back where the App puts it, unfolded (Tools ▾ › Reset panel positions). */
export function resetPanelPositions() {
  store.clear();
  for (const f of ALL) f.reset();
}

let watched = null;
function watchWindow(win) {
  if (!win || watched === win) return;
  watched = win;
  let raf = 0;
  win.addEventListener("resize", () => { if (!raf) raf = win.requestAnimationFrame(() => { raf = 0; for (const f of ALL) f.refresh(); }); });
}

// ------------------------------------------------------------------------------------------------- Drive mode

/**
 * Drive mode: every panel that isn't essential folds to a chip, and the ones on screen stack on the right edge of
 * `view`, clear of `avoid` (the Drive HUD's name / REC / speed / take bars). restore() puts the layout back.
 */
export function enterDrive(avoid = [], view = null, list = [...ALL]) {
  const saved = [];
  const fs = list.filter((f) => !f.essential);
  for (const f of fs) { saved.push([f, f.chip, f.dock]); f.chip = true; f.dock = null; f.refresh(); f._syncCtl?.(); }
  const shown = fs.filter((f) => f.live());
  const v = view || viewOf(shown[0]?.win);
  const bases = shown.map((f) => f.base());
  const slots = dockSlots(bases, v, avoid);
  shown.forEach((f, i) => { f.dock = { x: Math.round(slots[i].left - bases[i].left), y: Math.round(slots[i].top - bases[i].top) }; f.refresh(v); });
  return {
    restore() {
      for (const [f, chip, dock] of saved) { f.chip = chip; f.dock = dock; f.refresh(); f._syncCtl?.(); }
      saved.length = 0;
    },
  };
}

// ------------------------------------------------------------------------------------------------- pop-out (P2)
//
// The panel itself moves into a same-origin window, so every control, listener and selection keeps working: the
// App re-renders it in place as usual. A small channel carries what the second window can't do by itself: keys
// pressed there (undo, Space, shortcuts) go to the App, and Dock back / closing the window put the panel back.

/** An in-page message channel pair (postMessage-like, async). Each end: { post(msg), on(fn), close() }. */
export function channelPair() {
  const ends = [[], []];
  const end = (i) => ({
    post(msg) { const ls = ends[1 - i]; queueMicrotask(() => { for (const fn of ls) fn(msg); }); },
    on(fn) { ends[i].push(fn); },
    close() { ends[i].length = 0; },
  });
  return [end(0), end(1)];
}

/** What a key pressed in the pop-out sends to the App (nothing while typing in a field). */
export function keyMessage(e) {
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable)) return null;
  if (e.key === "Escape") return null;   // Esc stays with the panel
  return { t: "key", key: e.key, code: e.code, shiftKey: !!e.shiftKey, metaKey: !!e.metaKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey };
}

/** The App's end: keys become key presses in the App, "dock" docks the panel back. */
export function serveMain(ch, { doc = globalThis.document, onDock = () => {} } = {}) {
  ch.on((m) => {
    if (m?.t === "key") {
      const KE = doc?.defaultView?.KeyboardEvent;
      if (!KE) return;
      const target = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc.body;
      target?.dispatchEvent(new KE("keydown", { key: m.key, code: m.code, shiftKey: m.shiftKey, metaKey: m.metaKey, ctrlKey: m.ctrlKey, altKey: m.altKey, bubbles: true, cancelable: true }));
    } else if (m?.t === "dock") onDock();
    else if (m?.t === "title" && doc) doc.title = m.text;
  });
}

const POP_CSS = `
html, body { margin:0; background:#141018; color:#f0efed; font:13px/1.4 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; min-height:100vh; }
.ss-fl-popbar { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:8px; padding:6px 10px; background:#1e1824; border-bottom:1px solid rgba(255,255,255,.12); }
.ss-fl-popbar b { flex:1; font-weight:650; }
.ss-fl-popbar button { all:unset; cursor:pointer; padding:3px 10px; border-radius:999px; background:#f2ff59; color:#1d1622; font-weight:650; }
.ss-fl-anc.ss-fl-anc.ss-fl-anc.ss-fl-anc { position:static !important; display:block !important; width:auto !important; height:auto !important; max-height:none !important; min-height:0 !important;
  overflow:visible !important; transform:none !important; inset:auto !important; margin:0 !important; padding:0 !important; border:0 !important; background:transparent !important; }
[data-fl-out].ss-fl.ss-fl.ss-fl { position:relative !important; inset:auto !important; left:auto !important; top:auto !important; translate:none !important; transform:none !important;
  width:auto !important; max-width:none !important; max-height:none !important; margin:8px !important; z-index:auto !important; }
[data-fl-out] .ss-fl-min { display:none !important; }
`;

/** Open the panel in its own window. A blocked pop-up says so and leaves the panel where it is. */
export function popOut(f, { win = f.win, say = notify } = {}) {
  if (f.out) { try { f.out.w.focus(); } catch { /* */ } return f.out; }
  const el = f.el, doc = el.ownerDocument;
  const r = el.getBoundingClientRect?.() || { width: 380, height: 520 };
  let w = null;
  try { w = win?.open?.("", `ss_pop_${f.key}`, `popup,width=${Math.max(380, Math.round(r.width) + 40)},height=${Math.max(480, Math.round(r.height) + 90)}`); } catch { w = null; }
  if (!w || !w.document) { say(BLOCKED); return null; }
  const pd = w.document;
  pd.title = `Soundstage · ${f.title}`;
  pd.head.replaceChildren(...[...doc.querySelectorAll("style, link[rel=stylesheet]")].map((s) => pd.importNode(s, true)),
    Object.assign(pd.createElement("style"), { textContent: POP_CSS }));
  for (const a of doc.documentElement.attributes) pd.documentElement.setAttribute(a.name, a.value);
  pd.body.className = doc.body.className;
  const bar = pd.createElement("div");
  bar.className = "ss-fl-popbar";
  const ttl = pd.createElement("b"); ttl.textContent = `${f.title} · second screen`;
  const back = pd.createElement("button"); back.type = "button"; back.textContent = "Dock back"; back.title = "Put this panel back in the App";
  bar.append(ttl, back);
  pd.body.replaceChildren(bar);
  // the panel's ancestors' classes, so its scoped CSS (.ss-stage …) still applies
  let host = pd.body;
  const chain = [];
  for (let a = el.parentElement; a && a !== doc.body && a !== doc.documentElement; a = a.parentElement) chain.unshift(a);
  for (const a of chain) {
    const d = pd.createElement("div");
    d.className = `${a.className || ""} ss-fl-anc`;
    for (const [k, v] of Object.entries(a.dataset || {})) d.dataset[k] = v;
    for (const p of a.style || []) if (p.startsWith("--")) d.style.setProperty(p, a.style.getPropertyValue(p));
    host.append(d); host = d;
  }
  const ph = doc.createComment("ss-fl-popout");
  const parent = el.parentNode;
  el.parentNode?.insertBefore(ph, el);
  el.dataset.flOut = "1";
  el.style.removeProperty("translate");
  el.style.removeProperty("max-height");
  el.hidden = false;
  host.append(el);   // the same element (adopted): its listeners come along
  const [mainEnd, popEnd] = channelPair();
  serveMain(mainEnd, { doc, onDock: () => dockBack(f) });
  back.addEventListener("click", () => popEnd.post({ t: "dock" }));
  pd.addEventListener("keydown", (e) => { const m = keyMessage(e); if (m) popEnd.post(m); });
  w.addEventListener("pagehide", () => dockBack(f));
  // closed by its own window button, or the App took the panel back (a layout change): dock
  const poll = setInterval(() => { if (w.closed || !pd.contains(el)) dockBack(f); }, 700);
  f.out = { w, ph, parent, poll, ch: [mainEnd, popEnd] };
  f._syncCtl?.();
  say(`${f.title} is in its own window: drag it to your second screen. Dock back puts it here again.`);
  return f.out;
}

/** Put a popped-out panel back where it was and close its window. */
export function dockBack(f) {
  const o = f.out;
  if (!o) return;
  f.out = null;
  clearInterval(o.poll);
  const el = f.el;
  delete el.dataset.flOut;
  if (o.w.document?.contains?.(el) || el.ownerDocument !== o.ph.ownerDocument) {
    if (o.ph.parentNode) o.ph.parentNode.insertBefore(el, o.ph); else o.parent?.append?.(el);
  }
  o.ph.remove?.();
  for (const c of o.ch) c.close();
  try { if (!o.w.closed) o.w.close(); } catch { /* */ }
  f._syncCtl?.();
  f.refresh();
}

// ------------------------------------------------------------------------------------------------- CSS

const CSS_ID = "ss-floating-css";
const CSS = `
.ss-fl[data-fl-live=true] .ss-fl-handle { cursor:grab; touch-action:none; user-select:none; }
.ss-fl[data-fl-drag] .ss-fl-handle { cursor:grabbing; }
.ss-fl[data-fl-drag] { transition:none !important; }
.ss-fl .ss-fl-handle:focus-visible { outline:2px solid #f2ff59; outline-offset:-2px; }
.ss-fl .ss-fl-ctl { display:none; gap:2px; margin-left:auto; flex:none; align-items:center; }
.ss-fl[data-fl-live=true] .ss-fl-ctl, .ss-fl[data-fl-out] .ss-fl-ctl { display:inline-flex; }
.ss-fl .ss-fl-ctl > button { all:unset; cursor:pointer; min-width:20px; height:20px; padding:0 4px; box-sizing:border-box; border-radius:6px; text-align:center;
  font:600 12px/20px ui-sans-serif, system-ui, sans-serif; color:inherit; opacity:.75; }
.ss-fl .ss-fl-ctl > button:hover { opacity:1; background:rgba(255,255,255,.12); }
.ss-fl .ss-fl-ctl > button:focus-visible { outline:2px solid #f2ff59; opacity:1; }
.ss-fl > .ss-fl-bar { display:none; align-items:center; gap:6px; padding:2px 4px 4px; font:600 11px/1.2 ui-sans-serif, system-ui, sans-serif; opacity:.85; pointer-events:auto; flex-basis:100%; }
.ss-fl[data-fl-live=true] > .ss-fl-bar, .ss-fl[data-fl-out] > .ss-fl-bar { display:flex; }
.ss-fl > .ss-fl-bar .ss-fl-grip { white-space:nowrap; }
.ss-fl[data-fl-chip] { overflow:hidden !important; min-height:0 !important; height:auto !important; min-width:0 !important; width:auto !important; max-width:300px !important; }
.ss-fl[data-fl-chip] > :not(.ss-fl-hold) { display:none !important; }
.ss-stage.ss-cl.ss-cl-hide .ss-fl:not([data-fl-keep]) { display:none !important; }
`;

function injectCss(doc) {
  if (!doc?.head || doc.getElementById(CSS_ID)) return;
  doc.head.append(Object.assign(doc.createElement("style"), { id: CSS_ID, textContent: CSS }));
}
