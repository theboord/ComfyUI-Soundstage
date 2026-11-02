// Soundstage pop-over layer: every menu, drop-down, context menu and pop-over opens here, in a top-level layer on
// document.body (position:fixed), so no scrolling box, panel or the window edge can cut it off.
//
//   placePopover(anchor, size, view, opts)   pure placement maths (tests/js/popover.test.mjs)
//   openPopover(el, { anchor, ... })         moves el into the layer beside its anchor; returns { el, close, update }
//   closePopover(el) / isPopoverOpen(el)
//
// The pop-over flips to the other side of its anchor when it does not fit, is clamped to the window, and scrolls
// inside when it is taller (or wider) than the window. Esc closes it, a click outside closes it, and the arrow keys,
// Home and End move between its items. On close the element goes back where it came from (hidden), so callers
// keep one element and the same CSS.

const MARGIN = 8;      // never closer than this to the window edge
const GAP = 4;         // between the anchor and the pop-over
const MIN_H = 120;     // below this, a side is "too small": use the whole window height instead

/**
 * Where a pop-over of `size` goes next to `anchor` inside a `view`.
 *   anchor: {left, top, right, bottom} (a point: left === right, top === bottom)
 *   size:   {width, height} the pop-over's natural size (before any max-height)
 *   view:   {width, height} the window
 *   opts:   side "bottom" | "top" (preferred), align "start" | "end" | "center", gap, margin, minHeight
 * Returns {left, top, maxHeight, maxWidth, side, scrolls}: the box always lies inside the view.
 */
export function placePopover(anchor, size, view, opts = {}) {
  const m = opts.margin ?? MARGIN, gap = opts.gap ?? GAP, minH = opts.minHeight ?? MIN_H;
  const vw = Math.max(0, view.width), vh = Math.max(0, view.height);
  const a = {
    left: num(anchor.left), top: num(anchor.top),
    right: num(anchor.right ?? anchor.left), bottom: num(anchor.bottom ?? anchor.top),
  };
  const w = Math.max(0, num(size.width)), hgt = Math.max(0, num(size.height));
  // ---- vertical: the preferred side if it fits, else the other side if it fits, else the roomier side (scrolling)
  const full = Math.max(0, vh - 2 * m);
  const below = Math.min(full, vh - m - (a.bottom + gap)), above = Math.min(full, a.top - gap - m);
  const pref = opts.side === "top" ? "top" : "bottom";
  const room = (s) => (s === "top" ? above : below);
  const other = pref === "top" ? "bottom" : "top";
  let side = pref;
  if (hgt > room(pref)) side = hgt <= room(other) ? other : (room(other) > room(pref) ? other : pref);
  let maxHeight = Math.min(hgt, Math.max(0, room(side)));
  let top = side === "top" ? a.top - gap - maxHeight : a.bottom + gap;
  if (maxHeight < Math.min(hgt, minH)) {
    // Neither side has room (an anchor in a corner of a short window): use the whole window height, over the anchor.
    side = "over";
    maxHeight = Math.min(hgt, Math.max(0, vh - 2 * m));
    top = Math.min(Math.max(m, a.bottom + gap), vh - m - maxHeight);
  }
  // an anchor partly out of the window still gets a pop-over fully in it
  top = Math.max(m, Math.min(top, vh - m - maxHeight));
  if (vh < 2 * m + maxHeight) top = Math.max(0, (vh - maxHeight) / 2);
  // ---- horizontal: aligned to the anchor, then clamped; wider than the window -> the window's width, scrolling
  const maxWidth = Math.min(w, Math.max(0, vw - 2 * m));
  let left = opts.align === "end" ? a.right - maxWidth : opts.align === "center" ? (a.left + a.right) / 2 - maxWidth / 2 : a.left;
  left = Math.max(m, Math.min(left, vw - m - maxWidth));
  if (vw < 2 * m + maxWidth) left = Math.max(0, (vw - maxWidth) / 2);
  return {
    left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(maxHeight), maxWidth: Math.floor(maxWidth),
    side, scrolls: maxHeight < hgt - 0.5 || maxWidth < w - 0.5,
  };
}

const num = (v) => (Number.isFinite(+v) ? +v : 0);

// ------------------------------------------------------------------------------------------------- the layer

const STYLE_ID = "ss-poplayer-css";
const CSS = `
body > .ss-pophost.ss-pophost.ss-pophost.ss-pophost.ss-pophost { position:fixed !important; inset:0 !important; width:auto !important; height:auto !important;
  margin:0 !important; padding:0 !important; border:0 !important; border-radius:0 !important; background:transparent !important;
  box-shadow:none !important; outline:0 !important; overflow:visible !important; pointer-events:none !important; display:block !important;
  transform:none !important; filter:none !important; backdrop-filter:none !important; contain:none !important; opacity:1 !important;
  z-index:2147483000 !important; min-width:0 !important; min-height:0 !important; max-width:none !important; max-height:none !important; }
body > .ss-pophost.ss-pophost.ss-pophost > .ss-popover.ss-popover.ss-popover { position:fixed !important; pointer-events:auto !important; box-sizing:border-box !important;
  right:auto !important; bottom:auto !important; transform:none !important; margin:0 !important; z-index:1 !important; }
body > .ss-pophost.ss-pophost.ss-pophost > .ss-popover.ss-popover.ss-popover.ss-pop-scrolls { overflow:auto !important; overscroll-behavior:contain; }
body > .ss-pophost:not(.ss-stage) { color:#f0efed; font:13px/1.4 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; }
`;

function injectCSS(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.append(s);
}

const open = new Map();   // el -> state (most recent last)
const ITEMS = "[role=menuitem]:not([disabled]):not([aria-disabled=true]), [role=option]:not([aria-disabled=true]), button:not(:disabled), a[href], input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
const STOP = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "keydown", "keyup", "keypress"];

const rectOf = (a) => {
  if (!a) return null;
  if (typeof a.getBoundingClientRect === "function") {
    if (!a.isConnected) return null;
    const r = a.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  if (a.clientX != null) return { left: a.clientX, top: a.clientY, right: a.clientX, bottom: a.clientY, width: 0, height: 0 };
  if (a.left != null) return { left: a.left, top: a.top, right: a.right ?? a.left, bottom: a.bottom ?? a.top };
  return null;
};

/** True while el is open in the layer. */
export function isPopoverOpen(el) { return open.has(el); }

/** Close el if it is open in the layer (runs its onClose). */
export function closePopover(el, why = "api") { open.get(el)?.close(why); }

/** Close every open pop-over (a step change, a layout switch). */
export function closeAllPopovers(why = "api") { for (const s of [...open.values()].reverse()) s.close(why); }

/**
 * Open el in the top-level layer next to anchor (an element, a mouse event or {left, top, right, bottom}).
 * opts:
 *   side "bottom" | "top", align "start" | "end" | "center", gap, margin
 *   owner      the element that toggles it (a click on it is not an "outside" click; gets aria-expanded)
 *   width      a fixed width in px, or an element whose width it takes (a drop-down under a wide bar)
 *   minWidth   at least the anchor's width (true) or px
 *   theme      the element whose look it keeps (its .ss-stage classes and CSS variables); default: the anchor's App
 *   themeClasses  false: CSS variables only, no .ss-stage classes (a pop-over styled on its own, outside the App's rules)
 *   focus      "first" (default for menus) | false
 *   restore    put el back where it came from on close (default true when it was in the page)
 *   remove     remove el on close (default: when it was not in the page)
 *   onClose(why)  why: "escape" | "outside" | "api" | "anchor" | "replaced" | "item"
 *   closeOnItem   close after a click on a button inside it (menus)
 */
export function openPopover(el, opts = {}) {
  const doc = el.ownerDocument || document;
  const win = doc.defaultView || window;
  injectCSS(doc);
  if (open.has(el)) open.get(el).close("replaced");
  const anchorEl = opts.anchor && typeof opts.anchor.getBoundingClientRect === "function" ? opts.anchor : null;
  const anchorPt = anchorEl ? null : rectOf(opts.anchor);
  const owner = opts.owner || anchorEl;
  const home = el.isConnected ? { parent: el.parentNode, next: el.nextSibling } : null;
  const restore = opts.restore ?? !!home;
  const remove = opts.remove ?? !home;
  const saved = el.getAttribute("style");

  // The host keeps the App's look: its .ss-stage classes (theme rules) and every CSS variable from the theme root.
  // CSS variables inherit, so the anchor's computed style holds its panel's and the App's.
  const varsFrom = opts.theme || anchorEl || (home?.parent?.nodeType === 1 ? home.parent : null);
  const themeRoot = opts.themeClasses === false ? null : varsFrom?.closest?.(".ss-stage") || null;
  const host = doc.createElement("div");
  host.className = "ss-pophost";
  if (themeRoot) {
    // not the view-mode classes: ".ss-stage.ss-dailiesmode > :not(.ss-dailiesview)" (and the like) hide every other child
    for (const c of themeRoot.classList) if (c !== "ss-pophost" && !(/^ss-[a-z]+mode$/.test(c) && c !== "ss-wsmode")) host.classList.add(c);
    for (const [k, v] of Object.entries(themeRoot.dataset || {})) host.dataset[k] = v;
  }
  if (varsFrom) {
    try {
      const cs = win.getComputedStyle(varsFrom);
      for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (p.startsWith("--")) host.style.setProperty(p, cs.getPropertyValue(p)); }
    } catch { /* jsdom */ }
  }
  host.dataset.popfor = opts.name || (typeof el.className === "string" ? el.className.split(" ")[0] : "") || "pop";
  for (const t of STOP) host.addEventListener(t, (e) => e.stopPropagation());
  doc.body.append(host);
  el.classList.add("ss-popover");
  el.hidden = false;
  host.append(el);
  owner?.setAttribute?.("aria-expanded", "true");
  const before = doc.activeElement;

  const state = { el, host, closed: false };
  const update = () => {
    if (state.closed) return;
    // An anchor that re-rendered away (or hid) keeps its last place: the pop-over stays where it opened.
    let ar = anchorEl ? rectOf(anchorEl) : anchorPt;
    if (ar && anchorEl && ar.width === 0 && ar.height === 0) ar = null;
    if (ar) state.last = ar; else ar = state.last;
    if (!ar) { state.close("anchor"); return; }
    // measure the natural size: no limits, at its final left so wrapping is right
    // its own CSS max-height (a design cap, e.g. 260 px) still holds; the window is the other cap
    el.style.maxHeight = ""; el.style.left = "0px"; el.style.top = "0px";
    let cssMax = Infinity;
    try { const mh = parseFloat(win.getComputedStyle(el).maxHeight); if (Number.isFinite(mh) && mh > 0) cssMax = mh; } catch { /* */ }
    el.style.maxHeight = "none"; el.style.maxWidth = "none";
    el.classList.remove("ss-pop-scrolls");
    const wFix = typeof opts.width === "number" ? opts.width : opts.width?.getBoundingClientRect ? opts.width.getBoundingClientRect().width : null;
    if (wFix) el.style.width = Math.round(wFix) + "px";
    const minW = opts.minWidth === true ? ar.right - ar.left : +opts.minWidth || 0;
    if (minW) el.style.minWidth = Math.round(minW) + "px";
    const vw = doc.documentElement.clientWidth || win.innerWidth, vh = doc.documentElement.clientHeight || win.innerHeight;
    if (wFix) el.style.width = Math.round(Math.min(wFix, vw - 2 * (opts.margin ?? MARGIN))) + "px";
    const full = el.scrollHeight > el.offsetHeight ? el.scrollHeight + (el.offsetHeight - el.clientHeight) : el.offsetHeight;
    const nat = { width: el.offsetWidth, height: Math.min(cssMax, full) };
    const p = placePopover(ar, nat, { width: vw, height: vh }, opts);
    el.style.left = p.left + "px";
    el.style.top = p.top + "px";
    el.style.maxHeight = p.maxHeight + "px";
    el.style.maxWidth = p.maxWidth + "px";
    el.classList.toggle("ss-pop-scrolls", p.scrolls || full > p.maxHeight + 1);
    el.dataset.side = p.side;
  };

  const items = () => [...el.querySelectorAll(ITEMS)].filter((x) => x.getClientRects().length);
  const onKey = (e) => {
    if (state.closed || [...open.values()].at(-1) !== state) return;   // only the top-most one
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.(); state.close("escape"); return; }
    if (!el.contains(doc.activeElement)) return;
    const tag = doc.activeElement?.tagName || "";
    if (tag === "SELECT" || tag === "TEXTAREA" || doc.activeElement?.isContentEditable) return;   // their own arrow keys
    const typing = tag === "INPUT";
    if (typing && !/^(ArrowDown|ArrowUp)$/.test(e.key)) return;
    const list = items(); if (!list.length) return;
    const i = list.indexOf(doc.activeElement);
    let j = null;
    if (e.key === "ArrowDown") j = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === "ArrowUp") j = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    else if (e.key === "Home" && !typing) j = 0;
    else if (e.key === "End" && !typing) j = list.length - 1;
    if (j == null) return;
    e.preventDefault(); e.stopPropagation();
    list[j].focus({ preventScroll: false });
  };
  const onDown = (e) => {
    if (state.closed) return;
    const t = e.target;
    if (el.contains(t)) return;
    if (owner && owner.contains?.(t)) return;           // the owner toggles it itself
    // a pop-over opened from this one (a nested menu) counts as inside
    for (const s of open.values()) if (s !== state && s.el.contains(t) && s.parent === state) return;
    if (opts.keepOpen?.(t)) return;
    state.close("outside");
  };
  const onClick = (e) => { if (opts.closeOnItem && e.target.closest?.("button, [role=menuitem], [role=option]") && el.contains(e.target)) setTimeout(() => state.close("item"), 0); };
  const onScroll = (e) => { if (!el.contains(e.target)) later(); };
  // Re-place when the anchor moves or resizes, or the content changes (one frame later, never in a loop:
  // a ResizeObserver on the pop-over itself would see its own max-height change)
  let raf = 0;
  const later = () => { if (!raf && !state.closed) raf = (win.requestAnimationFrame || setTimeout)(() => { raf = 0; update(); }); };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
  const mo = typeof MutationObserver === "function" ? new MutationObserver(later) : null;

  state.close = (why = "api") => {
    if (state.closed) return;
    state.closed = true;
    open.delete(el);
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerdown", onDown, true);
    el.removeEventListener("click", onClick);
    win.removeEventListener("resize", later);
    doc.removeEventListener("scroll", onScroll, true);
    ro?.disconnect();
    mo?.disconnect();
    const hadFocus = el.contains(doc.activeElement);
    el.classList.remove("ss-popover", "ss-pop-scrolls");
    delete el.dataset.side;
    if (saved == null) el.removeAttribute("style"); else el.setAttribute("style", saved);
    if (restore && home?.parent) {
      el.hidden = true;
      try { home.parent.insertBefore(el, home.next && home.next.parentNode === home.parent ? home.next : null); } catch { home.parent.append?.(el); }
    } else if (remove) el.remove();
    host.remove();
    owner?.setAttribute?.("aria-expanded", "false");
    if (hadFocus && (why === "escape" || why === "item")) {
      const back = owner?.focus ? owner : before;
      try { back?.focus?.({ preventScroll: true }); } catch { /* */ }
    }
    opts.onClose?.(why);
  };
  state.update = update;
  state.parent = opts.parent ? open.get(opts.parent) || null : null;
  open.set(el, state);

  doc.addEventListener("keydown", onKey, true);
  // the click that opened it is still being dispatched: listen from the next turn
  setTimeout(() => { if (!state.closed) doc.addEventListener("pointerdown", onDown, true); }, 0);
  el.addEventListener("click", onClick);
  win.addEventListener("resize", later);
  doc.addEventListener("scroll", onScroll, true);
  update();
  if (anchorEl) ro?.observe(anchorEl);
  mo?.observe(el, { childList: true, subtree: true, characterData: true });
  if (opts.focus !== false && (opts.focus === "first" || el.getAttribute("role") === "menu" || el.getAttribute("role") === "listbox")) {
    const f = items()[0];
    try { f?.focus({ preventScroll: true }); } catch { /* */ }
  }
  return { el, close: state.close, update };
}

/**
 * A menu of items in the layer. items: { label, icon?, run, disabled?, danger?, title? } | "-" | { header }.
 * makeIcon(name) builds an icon node. Returns the handle from openPopover.
 */
export function openMenu(items, anchor, { className = "ss-popmenu", makeIcon = null, ...opts } = {}) {
  const doc = (anchor?.ownerDocument) || (anchor?.target?.ownerDocument) || document;
  const m = doc.createElement("div");
  m.className = className;
  m.setAttribute("role", "menu");
  for (const it of items) {
    if (it === "-") { m.append(doc.createElement("hr")); continue; }
    if (it.header) { const hd = doc.createElement("div"); hd.className = "ss-popmenu-h"; hd.setAttribute("role", "presentation"); hd.textContent = it.header; m.append(hd); continue; }
    const b = doc.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (it.danger) b.classList.add("ss-danger");
    if (it.title) b.title = it.title;
    if (it.icon && makeIcon) b.append(makeIcon(it.icon, 14));
    b.append(doc.createTextNode(it.label));
    b.disabled = !!it.disabled;
    b.addEventListener("click", (e) => { e.stopPropagation(); handle.close("item"); it.run?.(); });
    m.append(b);
  }
  const handle = openPopover(m, { focus: "first", remove: true, ...opts, anchor: anchor?.target && anchor.clientX != null ? anchor : anchor });
  return handle;
}
