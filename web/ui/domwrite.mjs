// Write-if-changed DOM helpers for polls (Jon's canvas-speed report, 2026-11-08). A poll that re-writes the same
// style or attribute every 250-500 ms still dirties style, wakes MutationObservers (the top row re-fits on every one)
// and so keeps the page from idling. These write only when the value differs.

/** Set the given inline style properties, each only when it changed. Returns how many were written. */
export function setStyles(el, props) {
  if (!el?.style) return 0;
  let n = 0;
  for (const k in props) {
    const v = props[k] == null ? "" : String(props[k]);
    if (el.style[k] !== v) { el.style[k] = v; n++; }
  }
  return n;
}

/** Set el[key] = value (hidden, disabled, textContent, ...) only when it changed. Returns true when written. */
export function setProp(el, key, value) {
  if (!el || el[key] === value) return false;
  el[key] = value;
  return true;
}
