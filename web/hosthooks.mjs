// Small hooks the App shell (web/soundstage.js) hands to the Director / Ask host, kept here so they are testable in
// Node and soundstage.js only wires them:
//   cutSigOf(cut)        -> () => string   the Cut's current signature (host.cutSig): it changes with every edit the
//                                           Cut's own Undo can take back, so a tool can tell "the transition I added is
//                                           still the last thing that happened" before it undoes it
//   qualityHook(pipeline) -> {get(), set(values), clear(keys)}   ⑤ Motion's quality settings (host.quality), changing
//                                           the same state the Motion panel uses (the shot's LtxStore entry, the
//                                           Adherence buttons, the Follow the clay slider) and refreshing it

import { DEFAULT_PRESET } from "./motion/ltxadvanced.mjs";

/** The parts of a Cut project its own Undo snapshots (web/cut/cut.mjs _snapshot): the editable state. */
const CUT_KEYS = ["cut", "audio", "audio_tracks", "titles", "subtitles", "fade_out", "burn_subtitles", "graphics"];

/** A short stable hash of a string (FNV-1a, 32 bit, as hex) plus its length. */
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(16).padStart(8, "0")}:${s.length}`;
}

/** The signature of a Cut project's editable state (same project -> same string; any edit -> a new one). */
export function cutSignature(project) {
  if (!project) return "none";
  const pick = {};
  for (const k of CUT_KEYS) pick[k] = project[k] ?? null;
  return hashText(JSON.stringify(pick));
}

/** host.cutSig for a CutPanel (or anything with getProject() / project): a function returning the Cut's current sig. */
export function cutSigOf(cut) {
  return () => {
    try { return cutSignature(cut?.project ?? cut?.getProject?.()); } catch { return "none"; }
  };
}

/** The keys host.quality reads and writes. */
export const QUALITY_HOOK_KEYS = ["adherence", "ic_lora", "follow_clay", "preset"];

/**
 * host.quality for the Pipeline (web/pipeline/pipeline.mjs): ⑤ Motion's settings for the active shot.
 *   get()          {adherence, ic_lora, preset, follow_clay}
 *   set(values)    the same calls the Motion panel's own buttons make (preset first, then the knobs), so the panel,
 *                  the shot's saved settings and the graph agree; returns get() after
 *   clear(keys)    back to the default for those keys (the saved override removed; Follow the clay to its default
 *                  0.85); returns get() after. Unknown keys are ignored.
 */
export function qualityHook(pipeline) {
  const P = () => (typeof pipeline === "function" ? pipeline() : pipeline) ?? null;
  const get = () => {
    try {
      const p = P(), ltx = p?.ltx;
      if (!ltx) return {};   // ⑤ Motion not built yet
      const saved = ltx.saved?.() || {}, set = ltx.settings?.() || {};
      return { adherence: saved.adherence || set.adherence || "Exact", ic_lora: set.ic_lora ?? null, preset: saved.preset || null,
        follow_clay: p?.f?.follow ? +p.f.follow.value : null };
    } catch { return {}; }
  };
  const followTo = (p, v) => {
    if (!p?.f?.follow) return;
    p.f.follow.value = String(v);
    p.f.follow.dispatchEvent?.(new Event("input"));   // the slider's own handler: its label and the still model
  };
  const set = (values = {}) => {
    const p = P(), v = values || {};
    if (!p) return get();
    if (v.preset) p.ltx?.setPreset?.(v.preset);
    if (v.adherence) p._setAdherence?.(v.adherence);
    if (v.ic_lora != null) p.ltx?.patch?.({ ic_lora: v.ic_lora });
    if (v.follow_clay != null) followTo(p, v.follow_clay);
    return get();
  };
  const clear = (keys = QUALITY_HOOK_KEYS) => {
    const p = P(), ks = (Array.isArray(keys) ? keys : [keys]).filter((k) => QUALITY_HOOK_KEYS.includes(k));
    if (!p || !ks.length) return get();
    const ltx = p.ltx;
    if (ltx?.store && ks.some((k) => k !== "follow_clay")) {
      const sid = ltx.sid();
      // The preset back to the default (setPreset keeps the seed, the Adherence and the LoRAs: their own controls).
      if (ks.includes("preset")) ltx.store.setPreset(sid, DEFAULT_PRESET);
      const saved = { ...ltx.saved() };
      for (const k of ["adherence", "ic_lora"]) if (ks.includes(k)) delete saved[k];
      ltx.store.put(sid, saved);
      ltx.refresh?.(); ltx.apply?.(); p._syncAdherence?.(); p._applyVideo?.(); p._motionNote?.();
    }
    if (ks.includes("follow_clay") && p.f?.follow) followTo(p, p.f.follow.getAttribute?.("value") ?? "0.85");
    return get();
  };
  return { get, set, clear };
}
