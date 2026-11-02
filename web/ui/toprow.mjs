// The full workspace's top row fits any window from 900 px up. Below 1400 px the right-hand buttons are icons only
// (their tooltips keep the words); when the row is still too long, whole buttons fold into a "⋯" menu, the least used
// first, so every control stays on screen and clickable (QA 2026-11-02: at 1024 wide the row held 1127 px in 982, and
// Director, Guide and Done ran past the window's right edge). The steps, the scene picker, Tools and Done never fold.
//
//   const fit = topRowFit({ row, more, order })   order: the foldable buttons, the first to fold first
//   fit.fit()      measure and fold (called on every resize and every change in the row)
//   fit.folded()   the buttons in the "⋯" menu now
//   fit.open()     the "⋯" menu, in the pop-over layer (ui/popover.mjs)
import { openPopover, closePopover, isPopoverOpen } from "./popover.mjs";
import { icon } from "./icons.mjs";

/** Folded buttons carry this class (display:none in the row; the menu runs them). */
export const FOLDED = "ss-ovf";

/** The words a button stands for: its label, else its tooltip up to the ":" or the shortcut hint. */
export function buttonName(b) {
  const lbl = b.querySelector?.(".lbl")?.textContent?.trim();
  if (lbl) return lbl;
  const t = (b.getAttribute?.("aria-label") || b.title || b.textContent || "").trim();
  return t.split(/:\s| \(/)[0].trim() || "More";
}

/** The rest of its tooltip (the menu's second line). */
export function buttonDesc(b) {
  const t = (b.title || "").trim();
  const i = t.indexOf(": ");
  return i > 0 ? t.slice(i + 2) : "";
}

/**
 * Fold buttons until the row fits. overflows() says whether the row is still too long; fold(b) / unfoldAll() change it.
 * Pure of layout so it can be tested: returns the buttons folded, in order.
 */
export function foldUntilFits({ order, overflows, fold, unfoldAll, showMore }) {
  unfoldAll();
  showMore(false);
  if (!overflows()) return [];
  showMore(true);
  const done = [];
  for (const b of order) {
    if (!overflows()) break;
    fold(b);
    done.push(b);
  }
  return done;
}

export function topRowFit({ row, more, order, theme = null }) {
  let folded = [];
  let menu = null;
  const live = () => (typeof order === "function" ? order() : order).filter((b) => b && b.parentNode === row);
  // Only a single-line row folds: the App's narrow side panel wraps its row instead.
  const single = () => { try { return getComputedStyle(row).flexWrap === "nowrap"; } catch { return false; } };
  const shown = (b) => !b.hidden && b.getClientRects().length > 0;

  function fit() {
    if (!row.isConnected) return folded;
    const can = single() && row.getClientRects().length > 0;
    folded = foldUntilFits({
      // a button some other code hid (Book before a script) neither counts nor folds
      order: can ? live() : [],
      overflows: () => can && row.scrollWidth > row.clientWidth + 1,
      fold: (b) => { if (shown(b)) b.classList.add(FOLDED); },
      unfoldAll: () => { for (const b of live()) b.classList.remove(FOLDED); },
      showMore: (on) => more.classList.toggle(FOLDED, !on),
    }).filter((b) => b.classList.contains(FOLDED));
    if (!folded.length) { more.classList.add(FOLDED); if (menu && isPopoverOpen(menu)) closePopover(menu); }
    more.title = folded.length ? `More: ${folded.map(buttonName).join(", ")}` : "More";
    more.setAttribute("aria-label", more.title);
    return folded;
  }

  function open() {
    if (menu && isPopoverOpen(menu)) { closePopover(menu); return null; }
    menu = document.createElement("div");
    menu.className = "ss-toppop ss-toolsmenu ss-moremenu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "More");
    for (const b of folded) {
      const it = document.createElement("button");
      it.type = "button";
      it.setAttribute("role", "menuitem");
      it.title = b.title || "";
      it.dataset.ovfFor = [...b.classList].find((c) => /^ss-.+btn$/.test(c) && c !== "ss-btn") || "";
      const pressed = b.getAttribute("aria-pressed");
      if (pressed) it.setAttribute("aria-pressed", pressed);
      const desc = buttonDesc(b);
      if (desc) it.dataset.desc = desc;
      const svg = b.querySelector("svg");
      it.append(svg ? svg.cloneNode(true) : icon(b.dataset.ssIcon || "ellipsis", 14),
        Object.assign(document.createElement("span"), { className: "lbl", textContent: buttonName(b) }));
      it.addEventListener("pointerdown", (e) => e.stopPropagation());
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        closePopover(menu, "item");
        b.click();   // the real button: its panel, its pressed state and its shortcut stay one thing
      });
      menu.append(it);
    }
    for (const t of ["pointerdown", "wheel"]) menu.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    return openPopover(menu, { anchor: more, owner: more, theme: theme || row, align: "end", gap: 6, name: "more", focus: "first", remove: true });
  }

  more.addEventListener("click", () => open());
  // Re-fit on a resize and on any change in the row (a Stop button, a longer scene name, Tools showing its tool's
  // name), one frame later so a fit never runs inside its own observer.
  let raf = 0;
  const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fit(); }); };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
  ro?.observe(row);
  const mo = typeof MutationObserver === "function" ? new MutationObserver(later) : null;
  mo?.observe(row, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  return { fit, later, open, folded: () => folded.slice(), disconnect() { ro?.disconnect(); mo?.disconnect(); } };
}
