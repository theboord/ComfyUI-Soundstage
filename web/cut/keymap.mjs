// D12 (the Cut as an NLE) key maps, owner S0b. Design: nle_design_v1.md §9 (the Avid map row by row: §9.3a).
// Pure: no DOM. A binding is {key, action, arg?, when?, help?, note?}:
// - key: "Mod+Shift+Alt+<code>" with a physical key code (e.code: KeyV, Comma, Digit2, ArrowLeft, Space, Tab...), or
//   {win, mac} for a per-platform key. Mod = Ctrl or Cmd. Mod+letter follows the printed letter (e.key), with e.code
//   as the fallback when e.key is not Latin. AltGr (Ctrl+Alt without a Mac) never matches.
// - action: a CutPanel.actions name (nle_core.mjs, or a later piece). "later" says the key is Avid's / Premiere's but
//   its piece is not built yet; "legacy" runs today's switch for that key (same meaning, e.g. Delete).
// - when: conditions that must all hold (trim, src, sel, aSel, tool, drag, root, bin). Trim Mode bindings are a modal
//   layer checked first; then the binding with the most conditions; an unconditional binding last.

export const DEFAULT_KEYMAP = "soundstage";

/** The keys today's _onKey switch handles (matched as it matches them: e.key, lower-cased, with or without Mod). */
export const LEGACY_KEYS = {
  mod: ["z", "y", "b"],
  plain: [" ", "j", "k", "l", "i", "o", "g", "b", "s", "t", "r", ",", "<", ".", ">", "x", "m", "[", "]", "Delete", "Backspace",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "=", "+", "-", "_", "\\", "Escape"],
};

/** Keys no map binds (§9.2): the browser's, the OS's and the App's. Checked by the tests. */
export const RESERVED = [
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ..."NTWQPFHML".split("").map((c) => `Mod+Key${c}`), ...Array.from({ length: 10 }, (_, i) => `Mod+Digit${i}`), "Mod+Equal", "Mod+Minus",
  ..."NTWIJCKMO".split("").map((c) => `Mod+Shift+Key${c}`), "Mod+Tab",
  "Backquote", "Shift+KeyP", "Shift+Slash",
  { mac: "Mod+ArrowLeft" }, { mac: "Mod+ArrowRight" }, { mac: "Mod+Alt+ArrowLeft" }, { mac: "Mod+Alt+ArrowRight" },
  { win: "Alt+ArrowLeft" }, { win: "Alt+ArrowRight" },
];

/** C's Edit in… keys (D9). E is free only where C's listener skips handled keys (depcheck: it does), so Avid may take E. */
export const C_KEYS = ["Shift+KeyE", "Shift+F10", "ContextMenu"];

const later = (key, note, extra = {}) => ({ key, action: "later", note, ...extra });

// ---- Avid: Media Composer's default keyboard [AV99, LK23, MV09], nle_design §9.3a
const AVID = [
  // number row
  { key: "Digit1", action: "stepBig", arg: -1, help: "1/2 ∓10 (8 at 24p)" }, { key: "Digit2", action: "stepBig", arg: 1 },
  { key: "Digit3", action: "step", arg: -1, help: "3/4 ∓1" }, { key: "Digit4", action: "step", arg: 1 },
  { key: "Digit5", action: "togglePlay", help: "5 play" }, { key: "Digit6", action: "playInOut", help: "6 play IN-OUT" },
  later("Digit8", "V1 targeting comes with trims (D12-3)."),
  later("Digit9", "A1 targeting comes with trims (D12-3)."), later("Digit0", "A2 targeting comes with trims (D12-3)."),
  later("Minus", "A3 targeting comes with trims (D12-3)."), later("Equal", "A4 targeting comes with trims (D12-3)."),
  // top row
  { key: "Tab", action: "togglePlay", when: ["root"] },
  { key: "KeyQ", action: "gotoIn", help: "Q/W go to IN/OUT" }, { key: "KeyW", action: "gotoOut" },
  { key: "KeyE", action: "markIn", help: "E/R or I/O mark" }, { key: "KeyR", action: "markOut" },
  { key: "KeyT", action: "markClip", help: "T mark clip" },
  later("KeyY", "Source/Record mode leaves Trim Mode: trims come in D12-3."),
  later("KeyU", "Trim Mode comes in D12-3."), later("KeyP", "Trim Mode comes in D12-3."),
  later("BracketLeft", "Trim Mode comes in D12-3."), later("BracketRight", "Trim Mode comes in D12-3."),
  { key: "KeyI", action: "markIn" }, { key: "KeyO", action: "markOut" },
  { key: "Backslash", action: "dissolve", help: "\\ dissolve" },
  // home row
  { key: "KeyA", action: "prevEdit", help: "A/S previous/next edit" }, { key: "KeyS", action: "nextEdit" },
  { key: "KeyD", action: "clearIn", help: "D/F/G clear IN/OUT/both" }, { key: "KeyF", action: "clearOut" }, { key: "KeyG", action: "clearMarks" },
  { key: "KeyH", action: "focus", help: "H focus" },
  { key: "KeyJ", action: "shuttleRev", help: "J K L shuttle (2 3 5 8×)" }, { key: "KeyK", action: "pause" }, { key: "KeyL", action: "shuttleFwd" },
  later("Quote", "Keyframes come with the mixer (D12-2)."),
  // bottom row
  later("KeyZ", "Lift needs filler: it is switched off until filler lands."),
  { key: "KeyX", action: "extract", help: "X extract" },
  later("KeyV", "Splice-in comes with the source monitor (Edit workspace)."),
  later("KeyB", "Overwrite comes with the source monitor (Edit workspace)."),
  // other keys
  { key: "ArrowLeft", action: "step", arg: -1 }, { key: "ArrowRight", action: "step", arg: 1 },
  { key: "ArrowUp", action: "prevEdit" }, { key: "ArrowDown", action: "nextEdit" },
  { key: "Home", action: "head" }, { key: "End", action: "tail" },
  { key: "Space", action: "togglePlay", help: "Space play" },
  { key: "Escape", action: "escape", help: "Esc source/record" },
  { key: "Delete", action: "legacy" }, { key: "Backspace", action: "legacy" },
  // shift layer (LK23)
  later("Shift+KeyA", "Segment tools come with trims (D12-3)."), later("Shift+KeyS", "Segment tools come with trims (D12-3)."),
  later("Shift+Tab", "Segment tools come with trims (D12-3).", { when: ["root"] }),
  later("Shift+KeyF", "Trim types come with trims (D12-3)."), later("Shift+KeyD", "Trim types come with trims (D12-3)."),
  later("Shift+KeyT", "Mark Markers comes with markers (D12-3)."),
  // alt layer (Option on a Mac)
  { key: "Alt+Digit3", action: "stepBig", arg: -1 }, { key: "Alt+Digit4", action: "stepBig", arg: 1 },
  { key: "Alt+Digit6", action: "loopInOut", help: "⌥6 loop IN-OUT" },
  { key: "Alt+KeyQ", action: "markIn" }, { key: "Alt+KeyW", action: "markOut" },
  { key: "Alt+KeyI", action: "gotoIn" }, { key: "Alt+KeyO", action: "gotoOut" },
  { key: "Alt+KeyE", action: "gotoIn" }, { key: "Alt+KeyR", action: "gotoOut" },
  { key: "Alt+KeyJ", action: "shuttleDown" }, { key: "Alt+KeyL", action: "shuttleUp" },
  later("Alt+KeyU", "Trim Mode comes in D12-3."), later("Alt+KeyA", "Trim Mode comes in D12-3."), later("Alt+KeyS", "Trim Mode comes in D12-3."),
  { key: "Alt+KeyT", action: "markClip" },
  later("Alt+KeyV", "Splice-in comes with the source monitor (Edit workspace)."),
  later("Alt+KeyB", "Overwrite comes with the source monitor (Edit workspace)."),
  { key: { mac: "Alt+ArrowLeft" }, action: "stepBig", arg: -1 }, { key: { mac: "Alt+ArrowRight" }, action: "stepBig", arg: 1 },
  // ctrl layer (Cmd on a Mac); Mod+R, Mod+[ / ] and Mod+J only while the Cut itself has focus (§9.2)
  { key: "Mod+KeyZ", action: "undo", help: "⌘Z undo" }, { key: "Mod+Shift+KeyZ", action: "redo" },
  { key: "Mod+KeyR", action: "redo", when: ["root"], help: "⌘R redo" },
  { key: "Mod+BracketRight", action: "zoomIn", when: ["root"], help: "⌘]/⌘[ zoom" }, { key: "Mod+BracketLeft", action: "zoomOut", when: ["root"] },
  { key: "Mod+Slash", action: "fit", help: "⌘/ fit" }, { key: "Mod+KeyJ", action: "zoomBack", when: ["root"] },
  later("Mod+KeyU", "New audio track comes with the mixer (D12-2)."),
  later("Mod+KeyA", "Track selection comes with trims (D12-3).", { when: ["root"] }),
  // Soundstage actions with no Media Composer default key (marked S in §9.3a)
  later("Shift+KeyM", "Markers come in D12-3."), later("Shift+Period", "Markers come in D12-3."), later("Shift+Comma", "Markers come in D12-3."),
  later("Shift+KeyN", "Match frame comes with the source monitor (Edit workspace)."),
  { key: "Mod+KeyB", action: "split", help: "⌘B add edit" },
  { key: "Alt+KeyM", action: "matchAction" },
  { key: "Alt+BracketLeft", action: "clipGain", arg: -1 }, { key: "Alt+BracketRight", action: "clipGain", arg: 1 },
  { key: "Shift+Quote", action: "keysMode" },
];

// ---- Premiere (§9.3b): ✓ rows as Premiere's defaults, S rows Soundstage's choice
const PREMIERE = [
  { key: "Space", action: "togglePlay", help: "Space play" },
  { key: "KeyJ", action: "shuttleRev", help: "J K L shuttle" }, { key: "KeyK", action: "stop" }, { key: "KeyL", action: "shuttleFwd" },
  { key: "ArrowLeft", action: "step", arg: -1 }, { key: "ArrowRight", action: "step", arg: 1 },
  { key: "Shift+ArrowLeft", action: "stepSecond", arg: -1 }, { key: "Shift+ArrowRight", action: "stepSecond", arg: 1 },
  { key: "ArrowUp", action: "prevEdit" }, { key: "ArrowDown", action: "nextEdit" },
  { key: "Home", action: "head" }, { key: "End", action: "tail" },
  { key: "KeyI", action: "markIn", help: "I/O mark" }, { key: "KeyO", action: "markOut" }, { key: "KeyX", action: "markClip", help: "X mark clip" },
  { key: "Alt+KeyI", action: "clearIn" }, { key: "Alt+KeyO", action: "clearOut" }, { key: "Alt+KeyX", action: "clearMarks", help: "⌥X clear" },
  { key: "Shift+KeyI", action: "gotoIn" }, { key: "Shift+KeyO", action: "gotoOut" },
  { key: "Shift+Digit2", action: "monSrc" }, { key: "Shift+Digit4", action: "monRec" },
  later("Comma", "Insert comes with the source monitor (Edit workspace)."),
  later("Period", "Overwrite comes with the source monitor (Edit workspace)."),
  later("Semicolon", "Lift needs filler: it is switched off until filler lands."),
  { key: "Quote", action: "extract", help: "' extract" },
  later("KeyF", "Match frame comes with the source monitor (Edit workspace)."),
  later("Shift+KeyR", "Reverse match frame comes with the source monitor (Edit workspace)."),
  { key: "Mod+KeyK", action: "split", help: "⌘K add edit" },
  { key: "Shift+Delete", action: "rippleDelete", help: "⇧⌫ ripple delete" }, { key: "Shift+Backspace", action: "rippleDelete" },
  later("Delete", "Lift needs filler: Shift+Delete ripple-deletes."), later("Backspace", "Lift needs filler: Shift+Delete ripple-deletes."),
  { key: "Mod+KeyD", action: "dissolve", help: "⌘D dissolve" },
  later("Mod+Shift+KeyD", "Audio crossfades come with the mixer (D12-2)."),
  { key: "Alt+KeyM", action: "matchAction" },
  { key: "Alt+Shift+Comma", action: "slip", arg: -1 }, { key: "Alt+Shift+Period", action: "slip", arg: 1 },
  later("Alt+Comma", "Slide comes with trims (D12-3)."), later("Alt+Period", "Slide comes with trims (D12-3)."),
  { key: "KeyP", action: "keysMode" },
  { key: "BracketLeft", action: "clipGain", arg: -1 }, { key: "BracketRight", action: "clipGain", arg: 1 },
  { key: "Mod+KeyZ", action: "undo", help: "⌘Z undo" }, { key: "Mod+Shift+KeyZ", action: "redo" },
  { key: "Equal", action: "zoomIn", help: "= - \\ zoom" }, { key: "Minus", action: "zoomOut" }, { key: "Backslash", action: "fit" },
  later("Shift+KeyT", "Trim Mode comes in D12-3."), later("KeyQ", "Ripple trims come in D12-3."), later("KeyW", "Ripple trims come in D12-3."),
  later("KeyV", "Tools come in D12-3."), later("KeyB", "Tools come in D12-3."), later("KeyN", "Tools come in D12-3."),
  later("KeyY", "Tools come in D12-3."), later("KeyU", "Tools come in D12-3."),
  later("KeyM", "Markers come in D12-3."), later("Shift+KeyM", "Markers come in D12-3."), later("Alt+Shift+KeyM", "Markers come in D12-3."),
  { key: "Escape", action: "deselect" },
];

// The Soundstage map binds new actions only to keys today's switch does not use (none yet; the pieces add theirs).
const SOUNDSTAGE = [];

export const MAPS = {
  avid: { label: "Avid", exclusive: true, bindings: AVID },
  premiere: { label: "Premiere", exclusive: true, bindings: PREMIERE },
  soundstage: { label: "Soundstage", exclusive: false, bindings: SOUNDSTAGE },
};
/** Picker order (§9.1): Avid first, then Premiere; Soundstage stays the default. */
export const PICKER = ["avid", "premiere", "soundstage"];

export const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "");

/** True when today's switch would handle this key. */
export function legacyClaims(e) {
  const k = e?.key || "", lower = k.length === 1 ? k.toLowerCase() : k;
  return (e.metaKey || e.ctrlKey) ? LEGACY_KEYS.mod.includes(lower) : LEGACY_KEYS.plain.includes(lower);
}

/** A key spec for this platform ({win, mac} picks one; a missing side means not bound there). */
export function specFor(key, mac) {
  return typeof key === "string" ? key : (mac ? key.mac : key.win) || null;
}

/** {mod, shift, alt, code} of "Mod+Shift+KeyV". */
export function parseSpec(spec) {
  const parts = spec.split("+");
  const code = parts.pop() || "Plus";
  return { mod: parts.includes("Mod"), shift: parts.includes("Shift"), alt: parts.includes("Alt"), code };
}

/** Does this key event match the spec? Physical key (e.code), exact modifiers; Mod+letter follows the printed letter. */
export function matches(spec, e, mac = false) {
  const s = parseSpec(spec);
  const mod = !!(e.metaKey || e.ctrlKey);
  if (!mac && e.ctrlKey && e.altKey) return false;   // AltGr
  if (mod !== s.mod || !!e.shiftKey !== s.shift || !!e.altKey !== s.alt) return false;
  if (s.mod && /^Key[A-Z]$/.test(s.code)) {
    const k = e.key || "";
    if (/^[a-z]$/i.test(k)) return k.toLowerCase() === s.code.slice(3).toLowerCase();
  }
  return e.code === s.code;
}

/** The binding the active map runs for this key in this context, or null (§9.1 resolution order). */
export function resolve(mapName, e, ctx = {}) {
  const map = MAPS[mapName];
  if (!map || !e) return null;
  if (mapName === DEFAULT_KEYMAP && legacyClaims(e)) return null;   // today's switch keeps every key it had
  const mac = !!ctx.mac;
  let best = null, bestRank = -1;
  for (const b of map.bindings) {
    const spec = specFor(b.key, mac);
    if (!spec || !matches(spec, e, mac)) continue;
    const when = b.when || [];
    if (!when.every((c) => ctx[c])) continue;
    const rank = (when.includes("trim") ? 1000 : 0) + when.length;
    if (rank > bestRank) { best = b; bestRank = rank; }
  }
  return best;
}

export function claimsKey(mapName, e, ctx = {}) { return !!resolve(mapName, e, ctx); }

const LABEL = { Space: "Space", Escape: "Esc", Backslash: "\\", Quote: "'", Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Delete: "Del", Backspace: "⌫" };
/** A US label for a key spec ("Mod+Shift+KeyZ" -> "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere). */
export function keyLabel(spec, mac = false) {
  const s = parseSpec(spec);
  const name = LABEL[s.code] || s.code.replace(/^Key|^Digit/, "");
  const mods = [s.mod && (mac ? "⌘" : "Ctrl+"), s.alt && (mac ? "⌥" : "Alt+"), s.shift && (mac ? "⇧" : "Shift+")].filter(Boolean).join("");
  return mods + name;
}

/** The help line's entries for a map (bindings that carry a help text). */
export function helpLines(mapName) {
  return (MAPS[mapName]?.bindings || []).filter((b) => b.help).map((b) => b.help);
}
