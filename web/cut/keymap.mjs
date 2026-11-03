// D12 (Cut as an NLE) stub from S0a commit 1; owner: S0b. Design: nle_design_v1.md §9.
// Key maps (Soundstage, Avid, Premiere). Pure.

export const DEFAULT_KEYMAP = "soundstage";
export const MAPS = { soundstage: { label: "Soundstage", exclusive: false, bindings: [] } };
export const RESERVED = [];

/** The keys today's _onKey switch handles (matched as it matches them: e.key, lower-cased, with or without Mod). */
export const LEGACY_KEYS = {
  mod: ["z", "y", "b"],
  plain: [" ", "j", "k", "l", "i", "o", "g", "b", "s", "t", "r", ",", "<", ".", ">", "x", "m", "[", "]", "Delete", "Backspace",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "=", "+", "-", "_", "\\", "Escape"],
};

export const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || "");

/** True when today's switch would handle this key. */
export function legacyClaims(e) {
  const k = e?.key || "", lower = k.length === 1 ? k.toLowerCase() : k;
  return (e.metaKey || e.ctrlKey) ? LEGACY_KEYS.mod.includes(lower) : LEGACY_KEYS.plain.includes(lower);
}

export function resolve(_mapName, _e, _ctx = {}) { return null; }
export function claimsKey(_mapName, _e, _ctx = {}) { return false; }
export function helpLines(_mapName) { return []; }
