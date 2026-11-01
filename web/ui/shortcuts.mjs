// Keyboard shortcuts: one list (what the cheat sheet shows and what tooltips quote), and the "?" cheat-sheet overlay.
// The keys themselves are handled where they always were (stage.mjs, live.mjs, soundstage.js, canvas.mjs, cut.mjs);
// this module only documents them, so a tooltip and the sheet can never disagree.
//
//   const sheet = new CheatSheet();            // sheet.toggle() / open() / close(); "?" anywhere in the App toggles it
//   withKeys("Undo", ["Mod", "Z"])             // "Undo  ⌘Z" (Ctrl+Z off a Mac): a tooltip with its shortcut hint
import { FONT, TOKENS as T } from "./theme.mjs";
import { icon } from "./icons.mjs";

/** Is this a Mac (⌘, ⌥, ⇧ glyphs) or not (Ctrl, Alt, Shift words)? */
export function isMac(nav = globalThis.navigator) {
  const p = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "";
  return /mac|iphone|ipad/i.test(p);
}

const MAC = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", Esc: "Esc", Tab: "Tab", Space: "Space", Wheel: "Wheel", Drag: "Drag",
  Left: "←", Right: "→", Up: "↑", Down: "↓", Delete: "⌫" };
const PC = { Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl", Esc: "Esc", Tab: "Tab", Space: "Space", Wheel: "Wheel", Drag: "Drag",
  Left: "←", Right: "→", Up: "↑", Down: "↓", Delete: "Delete" };

/** One key's label: "Mod" is ⌘ on a Mac, Ctrl elsewhere; a single letter is upper-cased. */
export function keyLabel(k, mac = isMac()) {
  const t = (mac ? MAC : PC)[k];
  if (t) return t;
  return String(k).length === 1 ? String(k).toUpperCase() : String(k);
}

/** A combo as text: "⌘Z" / "⇧⌘Z" on a Mac (glyphs run together; "⌥+Drag" for a word), "Ctrl+Z" / "Shift+Ctrl+Z" elsewhere. */
export function comboText(keys, mac = isMac()) {
  const parts = keys.map((k) => keyLabel(k, mac));
  const glyphs = mac && keys.slice(0, -1).every((k) => ["Mod", "Shift", "Alt", "Ctrl"].includes(k)) && parts[parts.length - 1].length === 1;
  return parts.join(glyphs ? "" : "+");
}

/** A tooltip with its shortcut: "Undo (⌘Z)". keys may be one combo or a list of alternatives ([["H"], ["Tab"]]). */
export function withKeys(title, keys, mac = isMac()) {
  if (!keys?.length) return title;
  const alts = Array.isArray(keys[0]) ? keys : [keys];
  return `${title} (${alts.map((c) => comboText(c, mac)).join(" or ")})`;
}

/**
 * Every shortcut, grouped the way the cheat sheet shows them. keys: one combo, or alts: other combos for the same thing.
 * The 3D ones are Milestone 9's live drags (web/stage/live.mjs) and the stage's own keys (web/stage/stage.mjs).
 */
export const SHORTCUTS = [
  { group: "Anywhere in the App", items: [
    { keys: ["?"], what: "Show or hide this list of shortcuts" },
    { keys: ["H"], alts: [["Tab"]], what: "Hide or show every panel, to see the whole canvas" },
    { keys: ["Mod", "Z"], what: "Undo" },
    { keys: ["Shift", "Mod", "Z"], what: "Redo" },
    { keys: ["Esc"], what: "Close a menu, a pop-over, the tour or the full window" },
    { keys: ["V"], what: "Presets: one-click camera moves, light, looks, stunts, edit styles" },
  ] },
  { group: "Move things on the set", items: [
    { keys: ["Drag"], what: "Move a person, car or prop; it pushes what it hits" },
    { keys: ["Shift", "Drag"], what: "Lock the move to one axis" },
    { keys: ["Alt", "Drag"], what: "Turn it while you hold it" },
    { keys: ["Mod", "Drag"], what: "Move without snapping to edges" },
    { keys: ["Wheel"], what: "Holding a prop: lift or lower it (let go and it drops)" },
    { keys: ["C"], what: "Dragging a person: pick up or put down a prop" },
    { keys: ["F"], what: "Frame the selected object in the view" },
    { keys: ["G"], alts: [["R"], ["T"]], what: "Move, rotate or scale handles" },
    { keys: ["P"], what: "Pose the selected person (P or Esc ends)" },
    { keys: ["Mod", "D"], what: "Duplicate the selected object" },
  ] },
  { group: "Parts of the selected object", items: [
    { keys: ["L"], what: "Headlights: dipped, full beam, off" },
    { keys: ["Shift", "L"], what: "Police light bar on / off (red and blue flashing)" },
    { keys: ["I"], what: "Indicators: left, right, hazards, off" },
    { keys: ["O"], alts: [["Shift", "O"]], what: "Open / close the driver's door (Shift: every door, hood and trunk)" },
    { keys: ["K"], what: "Key every part at the playhead (Properties › Parts: ◆ per channel)" },
  ] },
  { group: "Look around the set", items: [
    { keys: ["Drag"], what: "On empty space: orbit the view" },
    { keys: ["Shift", "Drag"], what: "On empty space: pan" },
    { keys: ["Wheel"], what: "Dolly in and out" },
    { keys: ["W"], alts: [["A"], ["S"], ["D"]], what: "Fly forward, left, back, right (Shift: faster)" },
    { keys: ["Q"], alts: [["E"]], what: "Fly down, up" },
    { keys: ["0"], what: "The shot's camera, or a free view" },
  ] },
  { group: "Edit and Paint Studio", items: [
    { keys: ["Left"], alts: [["Right"]], what: "Edit: one frame back or on (Shift: a second)" },
    { keys: ["Space"], what: "Paint Studio: hold to pan the picture" },
    { keys: ["["], alts: [["]"]], what: "Paint Studio: smaller or bigger brush" },
    { keys: ["Delete"], what: "Paint Studio: delete the selected layer" },
  ] },
];

/** Every combo in the list as text, for tests and for a quick lookup ("is F documented?"). */
export function allCombos(mac = false) {
  const out = [];
  for (const g of SHORTCUTS) for (const it of g.items) for (const c of [it.keys, ...(it.alts || [])]) out.push(comboText(c, mac));
  return out;
}

/** Should this keydown open the cheat sheet? "?" with no Ctrl / ⌘ / Alt, and never while typing in a field. */
export function isCheatSheetKey(e) {
  if (!e || e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable)) return false;
  return true;
}

const CSS = `
.ss-keys { position:fixed; inset:0; z-index:100001; display:flex; align-items:center; justify-content:center; padding:24px;
  background:rgba(10,7,13,.62); font:13px/1.45 ${FONT}; color:${T.text}; }
.ss-keys, .ss-keys * { box-sizing:border-box; }
.ss-keys[hidden] { display:none !important; }
.ss-keys-card { width:min(940px, 100%); max-height:min(720px, calc(100vh - 48px)); display:flex; flex-direction:column; background:${T.raised};
  border:1px solid ${T.lineStrong}; border-radius:16px; box-shadow:0 24px 70px rgba(0,0,0,.6); overflow:hidden; }
.ss-keys-head { display:flex; align-items:center; gap:10px; padding:14px 16px 12px 20px; border-bottom:1px solid ${T.line}; flex:none; }
.ss-keys-head .ss-icon { color:${T.accent}; }
.ss-keys-head h4 { margin:0; font-size:15px; font-weight:600; letter-spacing:.005em; flex:1 1 auto; }
.ss-keys-head .sub { color:${T.muted}; font-size:12px; }
.ss-keys-x { width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; border-radius:8px; cursor:pointer;
  background:transparent; color:${T.muted}; border:1px solid transparent; }
.ss-keys-x:hover { background:rgba(255,255,255,.07); color:${T.text}; }
.ss-keys-x:focus-visible { outline:2px solid ${T.accent}; outline-offset:2px; }
.ss-keys-body { overflow:auto; padding:4px 20px 14px; column-count:2; column-gap:32px; scrollbar-width:thin; }
.ss-keys-grp { break-inside:avoid; min-width:0; padding-bottom:6px; }
.ss-keys-grp h5 { margin:12px 0 4px; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:${T.muted}; }
.ss-keys-row { display:grid; grid-template-columns:128px minmax(0,1fr); gap:12px; align-items:baseline; padding:4px 0;
  border-top:1px solid ${T.line}; }
.ss-keys-row:first-of-type { border-top:0; }
.ss-keys-combo { display:flex; flex-wrap:wrap; gap:3px; align-items:center; color:${T.muted}; font-size:11px; }
.ss-keys kbd { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 6px; border-radius:6px;
  background:rgba(255,255,255,.06); border:1px solid ${T.lineStrong}; border-bottom-width:2px; color:${T.text};
  font:600 11px/1 ${FONT}; letter-spacing:0; }
.ss-keys-what { color:${T.text}; font-size:12px; line-height:1.4; min-width:0; }
.ss-keys-foot { flex:none; padding:10px 20px; border-top:1px solid ${T.line}; color:${T.muted}; font-size:12px; display:flex; gap:6px;
  align-items:center; }
@media (max-width: 720px) { .ss-keys-body { column-count:1; } }
`;

function applyKeysCss() {
  if (document.getElementById("soundstage-keys")) return;
  const s = document.createElement("style");
  s.id = "soundstage-keys";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const mk = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

/** <kbd> chips for one combo; alternatives are joined by a quiet "/". */
function comboEls(it, mac) {
  const box = mk("span", "ss-keys-combo");
  [it.keys, ...(it.alts || [])].forEach((c, i) => {
    if (i) box.append(mk("span", "", "/"));
    c.forEach((k, j) => {
      if (j) box.append(mk("span", "", "+"));
      box.append(mk("kbd", "", keyLabel(k, mac)));
    });
  });
  return box;
}

/** The cheat sheet: a dimmed screen with every shortcut, grouped. Esc, a click outside or "?" closes it. */
export class CheatSheet {
  constructor({ root = null, mac = isMac(), onState = null } = {}) {
    this.root = root;
    this.mac = mac;
    this.onState = onState;
    this.el = null;
    this._ret = null;
  }

  get isOpen() { return !!this.el && !this.el.hidden; }

  _build() {
    applyKeysCss();
    const x = mk("button", "ss-keys-x", icon("x", 16));
    x.type = "button";
    x.title = "Close (Esc)";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", () => this.close());
    const body = mk("div", "ss-keys-body");
    for (const g of SHORTCUTS) {
      const grp = mk("section", "ss-keys-grp", mk("h5", "", g.group));
      for (const it of g.items) grp.append(mk("div", "ss-keys-row", comboEls(it, this.mac), mk("span", "ss-keys-what", it.what)));
      body.append(grp);
    }
    const card = mk("div", "ss-keys-card",
      mk("div", "ss-keys-head", icon("keyboard", 18), mk("h4", "", "Keyboard shortcuts"), mk("span", "sub", "Hover any button to see its own"), x),
      body,
      mk("div", "ss-keys-foot", "Press", mk("kbd", "", "?"), "any time to open this list, and", mk("kbd", "", "Esc"), "to close it."));
    const el = mk("div", "ss-keys", card);
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Keyboard shortcuts");
    el.hidden = true;
    for (const t of ["pointerdown", "wheel", "contextmenu"]) el.addEventListener(t, (e) => e.stopPropagation(), { passive: t === "wheel" });
    el.addEventListener("pointerdown", (e) => { if (e.target === el) this.close(); });
    this._key = (e) => {
      if (!this.isOpen) return;
      if (e.key === "Escape" || isCheatSheetKey(e)) { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      // Nothing else reaches the canvas while the sheet is up (H / Tab would hide panels behind it).
      if (e.key !== "Tab") e.stopPropagation();
    };
    this.x = x;
    this.el = el;
    (this.root || document.body).append(el);
  }

  open() {
    if (!this.el) this._build();
    if (this.isOpen) return;
    this._ret = document.activeElement;
    this.el.hidden = false;
    window.addEventListener("keydown", this._key, true);
    try { this.x.focus({ preventScroll: true }); } catch { /* not focusable */ }
    this.onState?.(true);
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    window.removeEventListener("keydown", this._key, true);
    try { this._ret?.focus?.({ preventScroll: true }); } catch { /* gone */ }
    this.onState?.(false);
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  destroy() { this.close(); this.el?.remove(); this.el = null; }
}
