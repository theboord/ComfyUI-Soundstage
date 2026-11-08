// Small hooks the App shell (web/soundstage.js) hands to the Director / Ask host, kept here so they are testable in
// Node and soundstage.js only wires them:
//   cutSigOf(cut)        -> () => string   the Cut's current signature (host.cutSig): it changes with every edit the
//                                           Cut's own Undo can take back, so a tool can tell "the transition I added is
//                                           still the last thing that happened" before it undoes it
//   qualityHook(pipeline) -> {get(), set(values), clear(keys)}   ⑤ Motion's quality settings (host.quality), changing
//                                           the same state the Motion panel uses (the shot's LtxStore entry, the
//                                           Adherence buttons, the Follow the clay slider) and refreshing it
//   smoothAgentShots(agent, stage)          the scene agent's new shots (a build, an edit's add_shot) play the smooth
//                                           camera curve (web/stage/camcurve.mjs): the Python agent writes no version
//   projectHook(getCtl)  -> async () => {name, id}   the open project (host.project() for Ask): id "p_<8hex>" only when
//                                           confirmed against its saved project.json, else null (window.__ssProject)
//   cutPanelHook(cut, view) -> () => CutPanel | null   the live Cut panel object (host.cut.panel()), null unless the
//                                           Cut view is mounted and shown
//   exposureHook(stage)  -> {get(), set(stops), down(stops?), reset()}   the stage's "lights down" dimmer (host.lights)
//   stageHook(stage)     -> {toJSON, select, setPose, snapshot, restore, undo}   host.stage for Ask: its edits plus a
//                                           way to take them back (snapshot() before, restore(snap) after; undo())

import { DEFAULT_PRESET } from "./motion/ltxadvanced.mjs";
import { markNewShots } from "./stage/camcurve.mjs";

/**
 * Wrap a SceneAgent's describe / edit so the shots they make go onto the smooth camera curve (cam_curve 2). describe
 * builds a whole new scene: every shot in it is new. edit: only shots whose ids were not on the stage before (an
 * add_shot op); shots already there keep their curve. The agent's redo copies (describe's scene, edit's add_shot ops)
 * are marked too, so a redo plays the same. Undo puts back what was there, curve included. Returns the agent.
 */
export function smoothAgentShots(agent, stage) {
  if (!agent || !stage || agent._smoothShots) return agent;
  agent._smoothShots = true;
  const wrap = (name) => {
    const fn = typeof agent[name] === "function" ? agent[name].bind(agent) : null;
    if (!fn) return;
    agent[name] = async (...args) => {
      const known = name === "describe" ? new Set() : new Set((stage.state?.shots || []).map((x) => x.id));
      const res = await fn(...args);
      if (markNewShots(stage.state, known)) {
        stage._rigCache = null;
        stage.setFrame?.(stage.frame);
        stage.onChange?.(stage.toJSON());
      }
      if (name === "describe" && res?.scene) markNewShots(res.scene);
      for (const op of res?.ops || []) if (op?.op === "add_shot" && op.shot && !known.has(op.shot.id)) markNewShots({ shots: [op.shot] });
      return res;
    };
  };
  wrap("describe");
  wrap("edit");
  return agent;
}

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

const PROJECT_ID = /^p_[0-9a-f]{8}$/;

/**
 * host.project() for Ask: the open project {name, id}. Reads project.json now through the page's project controller
 * (window.__ssProject.project(), web/project/projectbar.mjs), so id is the CONFIRMED id ("p_" + 8 hex) or null (not
 * saved yet, saved before ids existed, a copy, a renamed or reused name). Never throws and always settles: no
 * controller, or a failed read, falls back to the controller's sync answer (projectId() / current().name), else
 * {name: null, id: null}; a read that has not answered within opts.timeoutMs (default PROJECT_TIMEOUT_MS, 3 s)
 * resolves {name: current().name or null, id: null} (an id that was not confirmed is never given).
 */
export const PROJECT_TIMEOUT_MS = 3000;
export function projectHook(getCtl = () => globalThis.__ssProject, { timeoutMs = PROJECT_TIMEOUT_MS } = {}) {
  const clean = (name, id) => ({ name: typeof name === "string" && name ? name : null, id: typeof id === "string" && PROJECT_ID.test(id) ? id : null });
  const nameOf = (c) => { try { return c.current?.()?.name ?? null; } catch { return null; } };
  // A timeoutMs that is not a finite number >= 0 ("soon", NaN, null, {}) is the 3 s default, never 0 ms.
  const t = typeof timeoutMs === "number" ? timeoutMs : typeof timeoutMs === "string" && timeoutMs.trim() !== "" ? Number(timeoutMs) : NaN;
  const waitMs = Number.isFinite(t) && t >= 0 ? t : PROJECT_TIMEOUT_MS;
  return async () => {
    const c = getCtl?.();
    if (!c) return clean(null, null);
    const TIMEOUT = Symbol("timeout");
    let timer = null;
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => c.project()),
        new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), waitMs); }),
      ]);
      if (r === TIMEOUT) return clean(nameOf(c), null);
      return clean(r?.name ?? nameOf(c), r?.confirmed ? r.id : null);
    } catch {
      let id = null;
      try { id = c.projectId?.() ?? null; } catch { /* */ }
      return clean(nameOf(c), id);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** host.cut.panel for Ask: the live CutPanel instance (call its own methods) while the Cut is mounted AND shown (its
 * view is in the page and not hidden: the ⑥ Cut tab is open), else null. The panel object exists from the start (the
 * App builds it hidden), so a null means "the Cut isn't on screen": open the Cut view first (host.cut.show()). */
export function cutPanelHook(cut, view) {
  return () => (cut && (!view || (view.isConnected !== false && !view.hidden)) ? cut : null);
}

/** host.lights for Ask: the stage's scene dimmer (stage.setExposure, web/stage/STAGE_API.md). down(stops = 1) dims by
 * that many more stops from where it is; reset() back to 0. Each change is one stage undo step; returns the stage's
 * result ({ok, stops} or {ok: false, error}). */
export function exposureHook(stage) {
  const S = () => (typeof stage === "function" ? stage() : stage);
  const get = () => { try { return S()?.exposure?.() ?? 0; } catch { return 0; } };
  const set = (stops) => S()?.setExposure?.(stops) ?? { ok: false, error: "no stage" };
  return {
    get, set,
    down: (stops = 1) => {
      const n = Number(stops);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: `stops must be a number >= 0 (got '${stops}')` };
      return set(get() - n);
    },
    reset: () => set(0),
  };
}

/**
 * host.stage for Ask: the set edits Ask may make (select, setPose; lights go through host.lights) and how Ask takes
 * them back. snapshot() -> string (the whole scene) before an edit; restore(snap) puts that scene back as ONE new undo
 * step (so the person can still Undo Ask's restore), {ok, changed} or {ok: false, error}; undo() is the stage's own
 * Undo (the LAST step, whoever made it; {ok: false} when there is nothing to undo). Prefer snapshot / restore: a
 * stage undo() takes back the person's own edit if they made one after Ask's.
 */
export function stageHook(stage) {
  const S = () => (typeof stage === "function" ? stage() : stage);
  return {
    toJSON: () => S().toJSON(),
    select: (id) => S().select(id),
    setPose: (id, pose, opts) => S().setPose(id, pose, opts),
    snapshot: () => S().snapshot(),
    restore: (snap) => S()?.restoreSnapshot?.(snap) ?? { ok: false, error: "no stage" },
    undo: () => ({ ok: !!S()?.undo?.() }),
  };
}
