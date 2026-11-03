// Soundstage: Edit from the timeline, the App side (Directive 9, docs/cut.md "Edit from the timeline").
// The Cut's Edit in… menu (web/cut/editlink.mjs) holds the clip's shot and hands the clip here through the Cut's host
// hook (onEditShot(shotId, where, ctx) -> editShot -> start): a trip remembers where you left the cut and which takes
// the shot had; each jump opens the step that made the clip with that clip loaded; "↩ Back to the cut" in the step bar
// brings you back to the same clip and playhead; the takes that landed meanwhile (App renders, Ripple / Pose /
// Performance / ✦ takes, new frames) are offered in the Cut, and "Replace in cut" makes one the clip's new version (one
// undoable edit; the old take stays in the clip's versions). Imported only by web/soundstage.js.
// Pure helpers (no DOM at import) are exported for tests/js/editlink.test.mjs: resolveLink, settingsFromPrompt,
// takesOfShot, beforeKeys, flattenClip, inputPathOf, frameTile, lengthCheck, backFrame.

import * as EL from "./editlink.mjs";
import { refFromViewUrl, rippleSources, viewQuery } from "../motion/ripple.mjs";
import { rippleHandOff } from "../performance/performance.mjs";
import { isClipRef, makeTarget } from "../oneclick/oneclick.mjs";
import { fileOfUrl } from "../takecheck/model.mjs";

/** What the user reads when a link is missing, per clip type (design §2.3). */
export const MISSING = {
  recipe: "This take has no readable recipe (made before recipes, or its tags were stripped): Re-generate starts from the shot's current settings.",
  look: "This still's settings come from the shot's chosen-frame record; the recipe route cannot read PNGs.",
  clay: "Clay has no file and no recipe: Re-generate starts from the shot's current settings.",
  outside: "Made by Ripple, outside the App graph, so the file has no Soundstage recipe: Re-generate runs Ripple again from the take's record (its source clip, edited frame, strength and prompt), as a new take with a new seed.",
  pose: "Made by Pose follow, outside the App graph: its record keeps only the prompt, so Re-generate opens Pose mode on the stage and frame as they are now (a new take, not a re-run).",
  performance: "Made by Performance, outside the App graph: Re-generate renders a Layout take with the shot's current settings (Performance's own inputs are not re-applied).",
  oneclick: "✦ results carry no recipe: the re-run uses the same card on the same source.",
  footage: "Imported footage: the camera original has no recipe and is not a ComfyUI file.",
  record: "This take's record is gone (a shot keeps its last 40 takes): the re-run starts from the shot's current settings.",
  frame: "No frame yet: ④ paints one from the clay.",
  chosen: "This take's own frame is named only in its prompt tag: until that is read, First frame shows the shot's chosen frame.",
};

/** Which tool made a take record on chosen[sid].takes. */
export const viaOf = (t) => (t?.ripple ? "ripple" : t?.pose ? "pose" : t?.performance ? "performance" : t?.oneclick ? "oneclick" : "app");

/** A shot's takes as the Takes bin lists them: its renders, its chosen frame, its frame candidates and the Ripple / Pose /
 *  Performance / ✦ records: [{url, rung, kind, video, created?, label?, record?}]. app = {renders, chosen, candidates}. */
export function takesOfShot({ renders = {}, chosen = null, candidates = [] } = {}) {
  const out = [];
  const add = (url, rung, extra = {}) => { if (url) out.push({ url, rung, video: EL.isVideoUrl(url), ...extra }); };
  for (const [k, rung] of [["final_sound", "final"], ["final_audio", "final"], ["final", "final"], ["draft", "draft"], ["look", "look"]]) add(renders?.[k], rung, { kind: "app" });
  if (chosen?.url) add(chosen.url, "look", { kind: "frame", seed: chosen.seed, model: chosen.model });
  for (const c of candidates || []) add(c?.url, "look", { kind: "frame", seed: c.seed, model: c.model });
  for (const t of chosen?.takes || []) {
    if (!t?.url) continue;
    const video = t.video ?? EL.isVideoUrl(t.url);
    add(t.url, !video ? "look" : t.kind === "final" ? "final" : "draft", { kind: viaOf(t), created: t.created, label: t.label, record: t, video });
  }
  return out;
}

/** The keys of every take a shot has (a trip's `before`). */
export const beforeKeys = (app) => new Set(takesOfShot(app).map((t) => EL.fileKey(t.url)));

/**
 * The App half of a clip's link (design §2): its Cut half (EL.clipContext) plus
 *   step   {app: "set" | "frame" | "motion", rung, via: "app" | "ripple" | "pose" | "performance" | "oneclick"}
 *   record the take's record on chosen[sid].takes (Ripple, Pose, Performance, ✦), when the clip is pinned to one
 *   frame  {url | ref, exact, from, seed?, model?, why?}: the frame the take started from, as far as the App knows now
 *   recipe {state: "unread" | "ok" | "missing", source, why}: what Re-generate starts from
 *   missing one plain sentence per gap
 * app = {renders, chosen, candidates} for the shot (no server: the prompt tag is read later, only when a jump needs it).
 */
export function resolveLink(link, { renders = {}, chosen = null, candidates = [] } = {}) {
  const t = link.take, type = link.footage ? "footage" : link.type;
  const record = t.pinned && t.key ? (chosen?.takes || []).find((x) => x?.url && EL.fileKey(x.url) === t.key) || null : null;
  const via = record ? viaOf(record) : EL.OUTSIDE_KINDS.includes(t.kind) ? t.kind : "app";
  const step = type === "look" ? { app: "frame", rung: 2, via } : type === "clay" ? { app: "set", rung: 1, via }
    : { app: "motion", rung: t.rung === "final" ? 4 : 3, via };
  // a frame painted in Paint Studio keeps its input/ path (`edited`) and file: ④ animates it through the touch-up still
  const painted = (c) => (c?.edited ? { edited: c.edited, file: c.file } : {});
  const shotFrame = chosen?.url ? { url: chosen.url, seed: chosen.seed, model: chosen.model, ...painted(chosen), exact: false, from: "chosen" } : null;
  const missing = [];
  let frame = shotFrame, recipe = { state: "missing", source: "", why: "" };
  if (type === "footage") {
    recipe.why = MISSING.footage;
  } else if (via === "ripple" || via === "pose" || via === "performance") {
    if (record?.edited) frame = { ref: record.edited, exact: true, from: "ripple" };
    recipe = record ? { state: "ok", source: "record", strength: record.strength, prompt: record.prompt || "", quality: record.kind === "final" ? "Final" : "Draft" }
      : { state: "missing", source: "", why: MISSING.record };
    if (!record) missing.push(MISSING.record);
    recipe.why = recipe.why || (via === "pose" ? MISSING.pose : via === "performance" ? MISSING.performance : MISSING.outside);
  } else if (via === "oneclick") {
    const from = record?.oneclick?.from || "";
    if (from && !isClipRef(from)) frame = { ref: from, exact: true, from: "oneclick" };
    recipe = record ? { state: "ok", source: "record", card: record.oneclick?.id || "", label: record.oneclick?.label || "", from }
      : { state: "missing", source: "", why: MISSING.record };
    if (!record) missing.push(MISSING.record);
    recipe.why = recipe.why || MISSING.oneclick;
  } else if (type === "look") {
    const mine = chosen?.url && EL.fileKey(chosen.url) === t.key ? chosen : (candidates || []).find((c) => c?.url && EL.fileKey(c.url) === t.key);
    frame = { url: t.url, seed: mine?.seed, model: mine?.model, ...painted(mine), exact: true, from: "still" };
    recipe = mine ? { state: "ok", source: "chosen", seed: mine.seed, model: mine.model, why: MISSING.look } : { state: "missing", source: "", why: MISSING.look };
  } else if (type === "clay") {
    recipe.why = MISSING.clay;
    if (!frame) missing.push(MISSING.frame);
  } else {
    recipe = { state: t.url ? "unread" : "missing", source: "", why: t.url ? "" : MISSING.recipe };
    if (frame) frame = { ...frame, why: MISSING.chosen };
  }
  if (recipe.why && !missing.includes(recipe.why)) missing.push(recipe.why);
  return { ...link, step, record, frame, recipe, missing };
}

/**
 * What a take's ComfyUI `prompt` tag says (soundstage/handoff/workflow.py returns it): the Quality node's settings
 * (SoundstageQuality: `quality` = the preset, `advanced` = the overrides with the seed and the Adherence: what the
 * render used), the engine (the video picker 9084 on: the router 9083's model; off: "l2r"), and the still (9082 on: the
 * picker 9081's model + seed; off: Krea 2's sampler 9056 seed; 9086 on: the touched-up still). Nodes are found by class
 * first: App node ids inside subgraphs look like "5516:1". null without a prompt.
 */
export function settingsFromPrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  const nodes = Object.values(prompt).filter((n) => n && typeof n === "object");
  const byTitle = (re) => nodes.find((n) => re.test(n._meta?.title || ""));
  const q = nodes.find((n) => n.class_type === "SoundstageQuality");
  let settings = null;
  if (q) {
    let adv = q.inputs?.advanced;
    if (typeof adv === "string") { try { adv = JSON.parse(adv); } catch { adv = null; } }
    const preset = typeof q.inputs?.quality === "string" ? q.inputs.quality : null;
    if (adv && typeof adv === "object" && !Array.isArray(adv)) settings = { ...(preset ? { preset } : {}), ...adv };
    else if (preset) settings = { preset };
  }
  const sw = (id, re) => { const n = prompt[id] || byTitle(re); const v = n?.inputs?.switch; return typeof v === "boolean" ? v : null; };
  const picker = sw("9084", /^Video model .*use picker/i);
  const router = prompt["9083"] || nodes.find((n) => n.class_type === "SoundstageGenerateVideo");
  const engine = picker === true && typeof router?.inputs?.model === "string" ? router.inputs.model : picker === false ? "l2r" : null;
  const stillPicker = sw("9082", /^Still model .*use picker/i);
  const pick = prompt["9081"] || nodes.find((n) => n.class_type === "SoundstageEditImage");
  const krea = prompt["9056"];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const still = stillPicker === true && pick ? { model: pick.inputs?.model ?? null, seed: num(pick.inputs?.seed) }
    : stillPicker === false && krea ? { model: "__krea_depth__", seed: num(krea.inputs?.seed) } : null;
  const touchup = sw("9086", /touched-up still/i) === true;
  let look = nodes.find((n) => n.class_type === "SoundstageLook")?.inputs?.look;
  if (typeof look === "string") { try { look = JSON.parse(look); } catch { look = null; } }
  return { settings, engine, still: still ? { ...still, touchup } : touchup ? { touchup } : null,
    look: look && typeof look === "object" && !Array.isArray(look) ? look : null };
}

/** The Look keys where the take's Look differs from the scene's Look now (sorted-key JSON per key). */
export function lookDiff(take, now) {
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  return Object.keys(take || {}).filter((k) => canon(take[k]) !== canon(now?.[k]));
}

/** "Cut → one video" (soundstage.js flattenCut): one clip's file. A pinned clip joins its pinned file (clay: a slate). */
export function flattenClip(e, r, best) {
  const pin = e?.take;
  if (pin) return { file: pin.url ? fileOfUrl(pin.url) : null, kind: pin.rung };
  const kind = best.find((k) => r?.[k]);
  return { file: kind ? r[kind] : null, kind: kind || null };
}

/** A frame's input/-relative path, "" when its file is not in input/: the only path ④'s touch-up still (the
 *  SoundstageCanvasImage node) reads. From a ref ("soundstage_private/b_f1.png [input]"; no [type] means input, as
 *  viewQuery reads it) or a /view URL or file of type input. */
export function inputPathOf({ ref = "", url = "", file = null } = {}) {
  if (ref) {
    const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(String(ref).trim());
    return m?.[1] && (m[2] || "input") === "input" ? m[1] : "";
  }
  const f = file || fileOfUrl(url);
  return f?.type === "input" && f.filename ? `${f.subfolder ? `${f.subfolder}/` : ""}${f.filename}` : "";
}

/**
 * The ④ tile First frame adds back for a take's frame (never chosen for you). `edited` is only ever an input/-relative
 * path, because pipeline.choose turns the touch-up still on with it: a painted frame keeps its own; a frame no seed or
 * model can re-render (a Ripple frame 1, a ✦ source, a still whose record is gone) uses its own file when that is in
 * input/, else the tile is marked ssCopy (choosing it copies the file into input/ first: attachEditLink). A frame with
 * a seed or model re-renders from them, as ④'s own tiles do (no model is Krea 2).
 */
export function frameTile(fr) {
  const file = fr.file || fileOfUrl(fr.url);
  const tile = { url: fr.url, file, seed: fr.seed ?? null, model: fr.model };
  const again = !!fr.model || fr.seed != null;
  const edited = fr.edited || (again ? "" : inputPathOf(fr.ref ? { ref: fr.ref } : { url: fr.url, file }));
  if (edited) tile.edited = edited;
  else if (!again) tile.ssCopy = true;
  return tile;
}

/**
 * Replace's length check (docs/cut.md): a take of `secs` seconds must hold every frame each clip it changes reads
 * (EL.framesNeeded: the out point, plus a dissolve's or wipe's handle out of the clip). indexes: the clicked clip, then
 * the other clips "Replace all" changes. fi {num, den}: seconds = frames * den / num; half a frame of slack.
 * -> {ok, okAll, why, whyAll}; an unknown length or rate passes ("" = it fits).
 */
export function lengthCheck(project, indexes, secs, fi) {
  const res = { ok: true, okAll: true, why: "", whyAll: "" };
  if (!Number.isFinite(secs) || !fi?.num || !fi?.den) return res;
  const s = (f) => (f * fi.den) / fi.num;
  const fits = (n) => !n || secs + s(0.5) >= s(n.need);
  const runs = (n) => `${s(n.out).toFixed(1)} s${n.post ? ` (${s(n.need).toFixed(1)} s with the ${n.post}-frame ${n.type} out of it)` : ""}`;
  const [i, ...rest] = indexes;
  const mine = EL.framesNeeded(project, i);
  if (!fits(mine)) Object.assign(res, { ok: false, okAll: false, why: `The take is ${secs.toFixed(1)} s; the clip runs to ${runs(mine)}. Trim the clip, or render a longer take.` });
  const bad = rest.map((k) => [k, EL.framesNeeded(project, k)]).find(([, n]) => !fits(n));
  if (bad) Object.assign(res, { okAll: false, whyAll: `Replace all is off: clip ${bad[0] + 1} of this setup runs to ${runs(bad[1])}; the take is ${secs.toFixed(1)} s.` });
  return res;
}

/** Where Back puts the playhead: where you left it, or, when the clip moved in the cut meanwhile, at the same offset
 *  inside the clip (trip {playhead, recIn}; clip {recIn, recOut}: where it is now). */
export function backFrame(trip, clip) {
  if (!clip || trip.recIn == null || clip.recIn === trip.recIn) return trip.playhead;
  return clip.recIn + Math.min(Math.max(0, trip.playhead - trip.recIn), Math.max(0, clip.recOut - clip.recIn - 1));
}

const hhmm = (ms) => { const d = new Date(ms || Date.now()); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const sameFile = (a, b) => (a?.url || b?.url ? !!(a?.url && b?.url) && EL.fileKey(a.url) === EL.fileKey(b.url) : a?.rung === b?.rung);

// ------------------------------------------------------------------------------------------------ the App (DOM)

const CSS = `
.ss-pipe .ss-backpill { flex:0 0 auto !important; align-self:center; display:inline-flex; gap:2px; align-items:center; }
.ss-pipe .ss-backpill[hidden] { display:none !important; }
.ss-pipe .ss-backpill button { flex:0 0 auto !important; min-width:0 !important; display:inline-flex !important; flex-direction:row !important; align-items:center !important; gap:6px;
  border-radius:999px !important; padding:7px 14px !important; background:#2a2330 !important; color:var(--ss-text,#f0efed) !important;
  border:1px solid rgba(255,255,255,.22) !important; font-weight:700; font-size:13px; cursor:pointer; white-space:nowrap; }
.ss-pipe .ss-backpill button.ss-backx { padding:7px 10px !important; font-weight:400; }
.ss-pipe .ss-backpill.ss-new button.ss-back { background:var(--ss-accent,#F2FF59) !important; color:#1a1420 !important; border-color:transparent !important; }
.ss-pipe .ss-backpill .dot { width:7px; height:7px; border-radius:50%; background:#1a1420; display:none; }
.ss-pipe .ss-backpill.ss-new .dot { display:inline-block; }
.ss-stage.ss-cl .ss-tabs.ss-toprow .ss-pipe .ss-backpill button { padding:4px 12px !important; }
.ss-editoffer { display:flex; flex-direction:column; gap:6px; margin:0 0 6px; padding:8px 10px; border-radius:10px; background:#221b28;
  border:1px solid var(--ss-accent,#F2FF59); color:var(--ss-text,#f0efed); font-size:13px; }
.ss-editoffer[hidden] { display:none; }
.ss-editoffer .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.ss-editoffer .row > span { flex:1 1 220px; }
.ss-editoffer button { border-radius:999px; padding:5px 12px; border:1px solid rgba(255,255,255,.22); background:transparent; color:inherit; cursor:pointer; font:inherit; font-size:12px; }
.ss-editoffer button.go { background:var(--ss-accent,#F2FF59); color:#1a1420; border-color:transparent; font-weight:700; }
.ss-editoffer button:disabled { opacity:.45; cursor:default; }
.ss-editoffer .why { color:#ffb340; font-size:12px; }
.ss-pipeview .cand.ss-fromcut { border-color:#e39a40 !important; }
.ss-editnote { font-size:12px; line-height:1.35; color:#f0c48a; border-left:3px solid #e39a40; padding:2px 0 2px 8px; }
.ss-pipeview .cand .ss-fromcut-tag { position:absolute; left:6px; top:6px; background:#e39a40; color:#1a1420; border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; }
`;

function injectCss() {
  if (document.getElementById("ss-editlink-app-css")) return;
  const st = document.createElement("style");
  st.id = "ss-editlink-app-css";
  st.textContent = CSS;
  document.head.append(st);
}

const el = (tag, cls, text = "") => Object.assign(document.createElement(tag), { className: cls, textContent: text });
const btn = (label, cls, fn, title = "") => {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(e); });
  return b;
};

/**
 * Attach Edit from the timeline to the App. host: {api, stage, pipeline, cut, cutView, oneClick, openShot, showView,
 * afterTimeChange, rendersFor, viewURL, showTake, sceneKey, switchScene, say}. Returns the Cut's link (menu, hover:
 * CutPanel reads them) plus start(shotId, where, ctx), back(), end(), onView(view) and the live trip.
 */
export function attachEditLink(host) {
  const { api, stage, pipeline, cut, cutView, openShot, showView, rendersFor, say = () => {} } = host;
  injectCss();
  let trip = null;
  let view = null;
  const promptCache = new Map();   // file key -> the handoff route's answer (or null)
  const appOf = (sid) => ({ renders: rendersFor(sid) || {}, chosen: pipeline.chosen?.[sid] || null, candidates: pipeline.candidates?.[sid] || [] });
  const urlOf = (ref) => (api?.apiURL ? api.apiURL(`/view?${viewQuery(ref)}`) : `/view?${viewQuery(ref)}`);
  const shotName = (link) => link.shot.name || link.shot.id;
  // The App's status line is hidden in the Cut and the step screens: in the Cut, its own status line says it too.
  const tell = (m) => { say(m); if (view === "cut") try { cut.say?.(m); } catch { /* the Cut's line */ } };
  // Back and Replace remove the button that had focus: the Cut takes it, so ⌘Z, E, Space and J/K/L work at once.
  const focusCut = () => { try { cut.root?.focus?.({ preventScroll: true }); } catch { /* no Cut root */ } };
  const tail = () => (trip?.notice ? ` ${trip.notice}` : "");

  // The Cut side: the menu (plus the shot's other takes as versions), the ✎, the keys. A jump holds the shot, then goes
  // through the Cut's host hook to start() below.
  const link = EL.attachCutLink(cut, { extend: (items, l) => withShotTakes(items, l) });

  /** The shot's Ripple / Pose / Performance / ✦ takes and its newest frames as versions the clip can switch to. */
  function withShotTakes(items, l) {
    if (l.footage) return items;
    const listed = items.filter((x) => x.where === "version").map((x) => x.take);
    const extra = takesOfShot(appOf(l.shot.id)).filter((t) => t.kind !== "app" && t.kind !== "frame" && (t.video || l.type === "look" || l.type === "clay"))
      .filter((t) => !listed.some((x) => sameFile(x, t)) && !sameFile(t, l.take)).slice(-6).reverse()
      .map((t) => ({ where: "version", label: `${t.label || t.kind} take${t.created ? ` · ${hhmm(t.created)}` : ""}`,
        take: { url: t.url, rung: t.rung, kind: t.kind, label: t.label || "", at: t.created ? hhmm(t.created) : "" }, disabled: false }));
    if (!extra.length) return items;
    const at = items.findIndex((x) => x.where === "follow" || x.where === "canvas");
    return [...items.slice(0, at), ...extra, ...items.slice(at)];
  }

  // ---- the Back pill, in the step bar before Stop (every mode's hide rule spares .ss-pipe)
  const pill = el("span", "ss-backpill");
  pill.hidden = true;
  const backBtn = btn("", "ss-back", () => back(), "Back to the cut: the same clip, the playhead where you left it");
  const label = el("span", "lbl", "↩ Back to the cut");
  backBtn.append(label, el("span", "dot"));
  pill.append(backBtn, btn("✕", "ss-backx", () => end(), "End this trip (the clip stays held on its take)"));
  backBtn.addEventListener("pointerenter", () => { if (trip?.blocked) { trip.blocked = false; refresh(); } });   // try again
  try { pipeline.bar.insertBefore(pill, pipeline.stopBtn || null); } catch { /* no step bar */ }

  // ---- the offer, at the top of the Cut view
  const offer = el("div", "ss-editoffer");
  offer.hidden = true;
  offer.addEventListener("pointerdown", (e) => e.stopPropagation());
  try { cutView.prepend(offer); } catch { /* no Cut view */ }

  // ---- take detection: App renders, Ripple / Pose / Performance / ✦ videos (new frames are found on Back)
  try {
    pipeline.ctx?.onRung?.((ev) => {
      // a render reporting in: "Can't go back yet" (a busy scene) may be true no more, so the pill offers Back again
      if (trip?.blocked) { trip.blocked = false; refresh(); }
      if (!trip || ev.shotId !== trip.clip.shot_id || ev.file?.type !== "output") return;
      const stills = trip.link.type === "look" || trip.link.type === "clay";
      if (!(ev.rung >= 3 || (stills && ev.rung === 2))) return;
      trip.events.unshift({ url: ev.url, rung: String(ev.kind || "").startsWith("final") ? "final" : ev.kind, kind: "app", video: ev.rung >= 3, created: Date.now() });
      refresh();
    });
  } catch { /* no rung events */ }
  if (typeof pipeline.onRippleTake === "function") {
    const onTake = pipeline.onRippleTake.bind(pipeline);
    pipeline.onRippleTake = (sid, take) => {
      const r = onTake(sid, take);
      try {
        if (trip && sid === trip.clip.shot_id && take?.url) {
          trip.events.unshift({ url: take.url, rung: take.kind === "final" ? "final" : "draft", kind: viaOf(take), label: take.label, record: take,
            video: take.video ?? EL.isVideoUrl(take.url), created: take.created || Date.now() });
          refresh();
        }
      } catch { /* never block the take */ }
      return r;
    };
  }
  // ④ Frame: the take's frame keeps a "From the cut" outline through every redraw (the same wrap ✦ uses)
  if (typeof pipeline._drawCandidates === "function") {
    const draw = pipeline._drawCandidates.bind(pipeline);
    pipeline._drawCandidates = (...a) => { const r = draw(...a); try { markTiles(); } catch { /* never block the candidates */ } return r; };
  }
  // "Use this frame" on a tile First frame added from output/ or temp/ (frameTile's ssCopy): the touch-up still reads
  // only input/, so the file is copied there first (as pipeline._keepFrame does for temp frames), then chosen.
  if (typeof pipeline.choose === "function") {
    const choose = pipeline.choose.bind(pipeline);
    pipeline.choose = (c, ...a) => {
      if (!c?.ssCopy) return choose(c, ...a);
      copyToInput(c).then((ok) => { if (ok) choose(c, ...a); });
      return undefined;
    };
  }
  async function copyToInput(c) {
    const f = c.file || fileOfUrl(c.url);
    const old = c.url;
    if (!f?.filename || !api?.fetchApi) { say("This frame is not in input/, so it can't be animated from here: open it in Paint Studio, then “Use as first frame”."); return false; }
    try {
      const r = await api.fetchApi(`/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" })}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = new FormData();
      body.append("image", await r.blob(), `cut_${`${f.subfolder ? `${f.subfolder}_` : ""}${f.filename}`.replace(/[^A-Za-z0-9_.-]+/g, "_")}`);
      body.append("type", "input");
      body.append("subfolder", "soundstage_frames");
      body.append("overwrite", "true");
      const u = await api.fetchApi("/upload/image", { method: "POST", body });
      if (!u.ok) throw new Error(`HTTP ${u.status}`);
      const j = await u.json();
      const sub = j.subfolder || "soundstage_frames";
      Object.assign(c, { edited: `${sub}/${j.name}`, file: { filename: j.name, subfolder: sub, type: "input" }, url: urlOf(`${sub}/${j.name} [input]`) });
      delete c.ssCopy;
      if (trip?.marked && trip.marked === EL.fileKey(old)) trip.marked = EL.fileKey(c.url);
      return true;
    } catch (e) { say(`Couldn't copy that frame into input/: ${e?.message || e}`); return false; }
  }
  function markTiles() {
    const sid = stage.activeShot?.()?.id;
    const list = pipeline.candidates?.[sid] || [];
    [...(pipeline.f?.grid?.children || [])].forEach((tile, i) => {
      const on = !!(trip?.marked && sid === trip.clip.shot_id && EL.fileKey(list[i]?.url) === trip.marked);
      tile.classList.toggle("ss-fromcut", on);
      const tag = tile.querySelector(":scope > .ss-fromcut-tag");
      if (on && !tag) tile.append(el("span", "ss-fromcut-tag", "From the cut"));
      if (!on && tag) tag.remove();
    });
  }

  function landed() {
    if (!trip) return [];
    return EL.newTakes(trip.before, [...trip.events, ...takesOfShot(appOf(trip.clip.shot_id))], trip.link.type);
  }

  function refresh() {
    if (!trip) { pill.hidden = true; offer.hidden = true; return; }
    trip.landed = landed();
    const n = trip.landed.length;
    if (!trip.blocked) label.textContent = n ? "↩ Back to the cut · new take" : "↩ Back to the cut";
    pill.classList.toggle("ss-new", n > 0);
    pill.hidden = view === "cut";
    if (view === "cut") drawOffer(); else offer.hidden = true;   // (outside the Cut its layout is not measured)
  }

  // ---- the jumps (design §3)
  async function readPrompt(url) {
    const key = EL.fileKey(url);
    if (promptCache.has(key)) return promptCache.get(key);
    let j = null;
    const ref = refFromViewUrl(url);
    if (ref && api?.fetchApi) {
      try { const r = await api.fetchApi(`/soundstage/handoff/workflow?ref=${encodeURIComponent(ref)}`); j = r.ok ? await r.json() : null; } catch { j = null; }
    }
    promptCache.set(key, j);
    return j;
  }

  /** The take's frame for ④: exact from its prompt tag when the candidate is still known, else the link's frame. */
  async function frameFor(l) {
    let fr = l.frame;
    if (l.step.via === "app" && (l.type === "final" || l.type === "draft") && l.take.url) {
      const st = settingsFromPrompt((await readPrompt(l.take.url))?.prompt)?.still;
      if (st?.seed != null) {
        const sid = l.shot.id, ch = pipeline.chosen?.[sid];
        const c = (pipeline.candidates?.[sid] || []).find((x) => x.seed === st.seed && (!st.model || !x.model || x.model === st.model))
          || (ch?.seed === st.seed ? ch : null);
        if (c?.url) fr = { url: c.url, seed: c.seed, model: c.model, file: c.file, ...(c.edited ? { edited: c.edited } : {}), exact: true, from: "prompt" };
        else fr = fr ? { ...fr, why: `This take started from seed ${st.seed}${st.model ? ` (${String(st.model).split(" ·")[0]})` : ""}; that frame is not among the shot's frames any more, so ④ shows the shot's chosen frame.` } : fr;
      }
    }
    if (fr?.ref && !fr.url) fr = { ...fr, url: urlOf(fr.ref) };
    return fr;
  }

  // A one-line note in the step's own status area (as Review's Redo does), plus the App's status line.
  const stepNote = el("div", "ss-editnote");
  function note(step, text, buttons = []) {
    text += tail();
    say(text);
    const anchor = (step === "frame" ? pipeline.f : step === "motion" ? pipeline.m : null)?.status;
    if (!anchor?.parentNode) { stepNote.remove(); return; }
    stepNote.replaceChildren(`From the cut · ${text}`, ...buttons.map((b) => { b.style.marginLeft = "8px"; return b; }));
    anchor.parentNode.insertBefore(stepNote, anchor);
  }

  function rippleTo(l, { paint = false, rerun = false } = {}) {
    const sid = l.shot.id, r = l.record;
    pipeline.go("motion");
    const ref = rerun && r?.source ? r.source : refFromViewUrl(l.take.url);
    if (!ref) { say(`${shotName(l)}: this clip has no file to Ripple (${l.type === "clay" ? "clay is drawn live" : "render a Draft first"}).`); return; }
    const c = (pipeline.chosen[sid] = pipeline.chosen[sid] || {});
    let scene = null;
    try { scene = stage.toJSON(); } catch { scene = null; }
    const listed = rippleSources({ renders: rendersFor(sid) || {}, scene, chosen: c }).some((s) => s.ref === ref);
    // A clip pinned to an older take is not on Ripple's list: it goes in through the import slot (which replaces the
    // shot's one imported clip).
    if (!listed) { rippleHandOff(c, { ref, url: rerun ? urlOf(ref) : l.take.url, name: `${shotName(l)} · ${EL.takeLabel(l.take) || "clip"}` }); pipeline._saveChosen?.(); }
    pipeline.ripple?._store?.({ source: ref });
    if (rerun && r?.edited) pipeline.ripple?._store?.({ edited: { ref: r.edited, url: urlOf(r.edited), for: ref }, strength: r.strength, prompt: r.prompt || "" });
    pipeline.ripple?.setMode?.("ripple");
    if (paint) pipeline.ripple?.editFirstFrame?.();
    note("motion", rerun ? `${shotName(l)}: Ripple again from this take's record (its source clip, edited frame, strength, prompt). “Ripple it” makes a new take: a new seed, so not the same pixels.`
      : paint ? `${shotName(l)}: frame 1 of this clip is open in Paint Studio. “Save to reference”, then “Ripple it” carries it through the clip.`
        : `${shotName(l)}: this clip is the Ripple source${listed ? "" : " (through the import slot: it replaces the shot's imported clip)"}. Edit its first frame, then Ripple it. Ripple starts at frame 0 of the clip.`);
  }

  async function oneClickOn(l, q, { ref = null } = {}) {
    const oc = host.oneClick;
    if (!oc?.open) { say("✦ One-click isn't available here."); return; }
    const t = makeTarget({ url: ref ? urlOf(ref) : l.take.url, ref: ref || "", shot: l.shot.id, take_id: l.take.key, take_kind: l.take.rung,
      label: `${shotName(l)} · ${EL.takeLabel(l.take) || "latest"}`, from: "cut" });
    if (!t) { say(`${shotName(l)}: nothing rendered to work on yet.`); return; }
    await oc.open(t);
    try { if (oc.panel?.q) { oc.panel.q.value = q || ""; oc.panel._drawGrid(); } } catch { /* the panel draws itself */ }
  }

  const JUMPS = {
    stage(l) {
      try { stage.setFreeView?.(false); } catch { /* */ }
      stage.setFrame?.(l.clip.srcFrame);
      try { host.afterTimeChange?.(); } catch { /* */ }
      pipeline.go("set");
      say(`${shotName(l)}, frame ${l.clip.srcFrame}: the stage as it is now, not as it was when this take was rendered.${tail()}`);
    },
    async frame(l) {
      const sid = l.shot.id;
      pipeline.go("frame");
      const fr = await frameFor(l);
      if (!trip || trip.link !== l) return;
      if (fr?.url) {
        const list = (pipeline.candidates[sid] = pipeline.candidates[sid] || []);
        // after a reload the take's frame is no candidate any more: add it back (never chosen for you). Its `edited` is a
        // real input/ path or nothing (frameTile); "From the cut" is the tile's tag (markTiles), not its file.
        if (!list.some((c) => EL.fileKey(c.url) === EL.fileKey(fr.url))) list.unshift(frameTile(fr));
        trip.marked = EL.fileKey(fr.url);
      }
      try { pipeline._drawCandidates(); } catch { /* frame view not built */ }
      note("frame", fr?.url ? `${shotName(l)}: ${fr.exact ? "the frame this take started from" : "the shot's chosen frame"} is outlined “From the cut”. “Use this frame” stays your click.${fr.why ? ` ${fr.why}` : ""}`
        : `${shotName(l)}: ${MISSING.frame}`);
    },
    async motion(l) {
      const sid = l.shot.id, via = l.step.via;
      if ((via === "ripple" && l.record) || via === "pose") {
        if (via === "ripple") return rippleTo(l, { rerun: true });
        pipeline.go("motion");
        pipeline.ripple?.setMode?.("pose");
        note("motion", `${shotName(l)}: Pose mode on the stage and frame as they are now: a new take, not a re-run (a Pose take keeps only its prompt${l.record?.prompt ? `: “${l.record.prompt}”` : ", and this one had none"}). Preview / Render below run it.`);
        return;
      }
      if (via === "oneclick" && l.record) return oneClickOn(l, l.record.oneclick?.label || "", { ref: l.record.oneclick?.from || null });
      pipeline.go("motion");
      pipeline.ripple?.setMode?.("layout");   // Ripple mode hides Draft and Final
      let got = null, why = l.missing.join(" ");
      if (via === "app" && l.take.url && (l.type === "final" || l.type === "draft")) {
        const j = await readPrompt(l.take.url);
        got = settingsFromPrompt(j?.prompt);
        // without ComfyUI's prompt tag: the soundstage tag (its preset, and the advanced JSON since recipe.py records it)
        const rq = j?.recipe?.quality;
        if (!got?.settings && (rq?.quality || rq?.advanced)) got = { ...(got || {}), settings: { ...(rq.quality ? { preset: rq.quality } : {}), ...(rq.advanced || {}) } };
        why = got?.settings ? "" : MISSING.recipe;
      }
      if (!trip || trip.link !== l) return;
      const s = got?.settings;
      const store = pipeline.ltx?.store;
      // the shot's own settings before the take's replace them: "Put my settings back" restores them (one click)
      const mine = s && store?.saved ? JSON.parse(JSON.stringify(store.saved(sid))) : null;
      const applyLtx = () => { try { pipeline.ltx.refresh(); pipeline.ltx.apply(sid); pipeline._syncAdherence?.(); pipeline._motionNote?.(); } catch { /* motion view not built */ } };
      if (s) { store?.put?.(sid, s); applyLtx(); }
      if (got?.engine && pipeline.m?.engine) {
        const want = got.engine === "l2r" ? pipeline.m.engine.options?.[0]?.value : got.engine;
        if (want && [...pipeline.m.engine.options].some((o) => o.value === want)) { pipeline.m.engine.value = want; pipeline._applyVideo?.(); }
      }
      const what = l.type === "look" ? "Animate this frame" : l.type === "clay" ? "Render it" : "Re-generate";
      // What differs from when the take was rendered: offered as buttons, never applied for you.
      const extras = [], differs = [];
      const st = got?.still;
      if (st?.seed != null && pipeline.chosen?.[sid]?.seed !== st.seed) {
        const c = (pipeline.candidates?.[sid] || []).find((x) => x.seed === st.seed && (!st.model || !x.model || x.model === st.model));
        if (c) extras.push(btn("Use this take's frame", "ghost", () => { try { pipeline.choose(c); } catch { /* frame view not built */ } say(`${shotName(l)}: this take's frame is the shot's frame again.`); }));
        else differs.push(`its frame (seed ${st.seed}) is no longer among the shot's frames`);
      }
      if (got?.look && host.look?.toJSON && lookDiff(got.look, host.look.toJSON()).length) {
        extras.push(btn("Use this take's Look (all shots)", "ghost", () => {
          host.look.load(got.look);
          try { host.look.onChange?.(host.look.toJSON()); } catch { /* the widget write */ }
          say("The scene's Look is this take's again (every shot of the scene uses it).");
        }));
      }
      if (mine && store?.put) extras.push(btn("Put my settings back", "ghost", () => { store.put(sid, mine); applyLtx(); say(`${shotName(l)}: its own quality settings are back.`); },
        "The shot's quality and Advanced (LTX) settings as they were before this take's were loaded"));
      note("motion", s ? `${shotName(l)}: ${what} with this take's settings (${s.preset || "Final"}${s.seed != null ? `, seed ${s.seed}` : ""}${s.adherence ? `, ${s.adherence}` : ""}). ` +
        `The same seed gives the same take only with the same frame, Look and stage${differs.length ? `: ${differs.join("; ")}` : ""}.`
        : `${shotName(l)}: ${what}. ${why || "The shot's current settings."}`, extras);
    },
    ripple: (l) => rippleTo(l),
    paint_v2v: (l) => rippleTo(l, { paint: true }),
    reshoot: (l) => oneClickOn(l, "reshoot"),
    oneclick: (l) => oneClickOn(l, ""),
    canvas(l) {
      const sid = l.shot.id;
      pipeline.ctx?.openCanvas?.(pipeline.chosen?.[sid]?.url || (rendersFor(sid) || {}).look || null);
      say(`Touching up ${shotName(l)}'s frame. “Use my edited frame”, then re-render it in ⑤ Motion; Back to the cut offers the new take.${tail()}`);
    },
    review(l) {
      pipeline.go("review");
      say(`${shotName(l)}: compare its rungs. Back to the cut when you're done.${tail()}`);
    },
  };

  /** A jump from the Cut (the Cut held the shot first): remember the trip, open the shot, run the item. */
  async function start(sid, where, ctx = {}) {
    const base = ctx.link || cut.clipContext(ctx.index, ctx.recFrame);
    if (!base) return false;
    const l = resolveLink(base, appOf(sid));
    // One trip at a time: a new one ends the old. On the same shot it keeps the old trip's takes (`before` and what
    // landed), so a take that came in meanwhile is still offered; on another shot it says which shot has one waiting.
    const prev = trip, same = !!prev && prev.clip.shot_id === String(sid);
    const waiting = prev && !same ? landed() : [];
    end({ quiet: true });
    trip = { sceneKey: host.sceneKey?.() ?? null, from: ctx.from || "cut",
      clip: { uid: l.clip.uid, index: l.clip.index, shot_id: String(sid), in: l.clip.in, out: l.clip.out },
      playhead: cut.frame, recIn: l.clip.recIn, sel: cut.sel, scrollX: cut.scrollX, ppf: cut.ppf, where, link: l,
      before: same ? prev.before : beforeKeys(appOf(sid)), events: same ? [...prev.events] : [], landed: [], marked: null, blocked: false,
      notice: waiting.length ? `(${shotName(prev.link)} still has a new take waiting: Edit in… on its clip lists it.)` : "" };
    if (!openShot(sid)) { say("That shot is not in this script any more."); trip = null; refresh(); return false; }
    refresh();
    try { await JUMPS[where]?.(l); } catch (e) { say(`Couldn't open ${where}: ${e?.message || e}`); }
    refresh();
    return true;
  }

  /** ↩ Back to the cut: the trip's scene, the Cut, the same clip selected, the playhead where it was. */
  function back() {
    if (!trip) return;
    if (trip.sceneKey != null && host.sceneKey && host.sceneKey() !== trip.sceneKey && host.switchScene) {
      const r = host.switchScene(trip.sceneKey);
      if (r && r.ok === false) {
        trip.blocked = true;
        label.textContent = `↩ Can't go back yet: ${r.why || "the scene is busy"}`;
        return;
      }
    }
    trip.blocked = false;
    showView("cut");
    const i = EL.findClip(cut.project.cut, trip.clip);
    if (i >= 0) { cut.sel = i; trip.clip.index = i; }
    cut.seek(backFrame(trip, i >= 0 ? cut.clipContext(i)?.clip : null));
    try { cut._updateButtons(); cut._inspect?.(); } catch { /* */ }
    refresh();
    focusCut();
  }

  function end({ quiet = false } = {}) {
    const had = !!trip;
    trip = null;
    pill.hidden = true;
    offer.replaceChildren();
    if (view === "cut" && !offer.hidden) showOffer(false); else offer.hidden = true;
    stepNote.remove();
    label.textContent = "↩ Back to the cut";
    try { if (had) markTiles(); } catch { /* */ }
    if (had && !quiet) tell("Trip ended: the clip stays on the take it was held on (its menu: Follow the latest render).");
  }

  /** The docked strip's "Edit in…" on clip `index`: the same menu, over the Cut's copy of the saved cut (the Cut editor
   *  holds and replaces: its Undo has the edits; the strip keeps its own undo for its own edits). */
  function fromStrip(index, anchor) {
    try { cut.refresh(); } catch { /* the Cut reads the saved cut the strip just wrote */ }
    const l = cut.clipContext(index);
    if (!l) { say("That clip is not in the cut any more."); return null; }
    return link.menu(l, anchor, { from: "strip" });
  }

  function onView(k) {
    view = k;
    if (!trip) { pill.hidden = true; offer.hidden = true; return; }
    refresh();
  }

  // ---- the offer in the Cut (design §4.5)
  const durations = new Map();   // file key -> seconds (null while reading)
  function durationOf(t) {
    const k = EL.fileKey(t.url);
    if (durations.has(k)) return durations.get(k);
    durations.set(k, null);
    if (!t.video) { durations.set(k, Infinity); return Infinity; }
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.addEventListener("loadedmetadata", () => { durations.set(k, Number.isFinite(v.duration) ? v.duration : Infinity); v.removeAttribute("src"); v.load?.(); if (view === "cut") drawOffer(); });
    v.addEventListener("error", () => { durations.set(k, Infinity); if (view === "cut") drawOffer(); });
    v.src = t.url;
    return null;
  }

  function heldSiblings(i) {
    const cur = cut.project.cut[i]?.take;
    return cut.project.cut.map((e, k) => (k !== i && String(e.shot_id) === trip.clip.shot_id && e.take && cur && sameFile(e.take, cur) ? k : -1)).filter((k) => k >= 0);
  }

  function replace(t, all) {
    if (!trip) return;
    const i = EL.findClip(cut.project.cut, trip.clip);
    if (i < 0) { tell("That clip is not in the cut any more."); return; }
    const pin = { url: t.url, rung: t.rung, ...(t.kind && t.kind !== "app" && t.kind !== "frame" ? { kind: t.kind } : {}),
      ...(t.label ? { label: t.label } : {}), ...(t.created ? { at: hhmm(t.created) } : {}) };
    const also = all ? heldSiblings(i).map((k) => ({ index: k, take: pin })) : [];
    const name = shotName(trip.link);
    // The hold was undone while the offer was up (⌘Z): the clip follows the newest render, so the take it was held on
    // goes back first, in the same edit, and lands in its versions under its own number.
    const held = trip.link.take;
    const restore = !cut.project.cut[i].take && held?.pinned && held.url
      ? { url: held.url, rung: held.rung, version: held.version || undefined, ...(held.kind ? { kind: held.kind } : {}), ...(held.label ? { label: held.label } : {}), ...(held.at ? { at: held.at } : {}) } : null;
    const ok = restore ? cut.replaceClipTake(i, restore, { also: [{ index: i, take: pin }, ...also] }) : cut.replaceClipTake(i, pin, { also });
    if (!ok) { tell(`${name} already plays that take.`); return; }
    const v = cut.project.cut[i].take?.version;
    end({ quiet: true });
    tell(`Replaced: ${name} plays v${v} now${also.length ? ` (and ${also.length} more clip${also.length === 1 ? "" : "s"} of this setup)` : ""}. ` +
      (restore ? "The hold had been undone, so the old take went back into its versions first. ⌘Z undoes both: the clip then follows the newest render."
        : "⌘Z brings the old take back; a second ⌘Z ends the hold, and the clip follows the newest render again."));
    focusCut();
  }

  /** Show or hide the offer; the Cut re-fits its rows to the space left (the banner sits above the editor). */
  function showOffer(on) {
    offer.hidden = !on;
    try { cut._fitLayout?.(); cut.requestDraw?.(); } catch { /* the Cut is not laid out yet */ }
  }

  function drawOffer() {
    if (!trip) { showOffer(false); return; }
    const name = shotName(trip.link), list = trip.landed || [];
    const rows = [];
    const leave = (fn) => () => { fn(); focusCut(); };   // End and Keep remove the focused button: the Cut takes focus
    // ✦ and Reshoot run while you stay in the Cut: the offer shows when their take lands
    if (!list.length && (trip.where === "reshoot" || trip.where === "oneclick")) { showOffer(false); return; }
    // the trip's clip is in its own scene's cut: in another scene the offer only points the way back
    if (trip.sceneKey != null && host.sceneKey && host.sceneKey() !== trip.sceneKey) {
      const row = el("div", "row");
      row.append(el("span", "", `${name} is in another scene's cut${list.length ? `, with ${list.length === 1 ? "a new take" : `${list.length} new takes`} waiting` : ""}.`),
        btn("↩ Back to its scene", "go", () => back()), btn("End", "", leave(() => end())));
      offer.replaceChildren(row);
      showOffer(true);
      return;
    }
    if (!list.length) {
      const row = el("div", "row");
      row.append(el("span", "", `Nothing new for ${name} yet.`),
        btn(trip.link.step.app === "frame" ? "Go back to ④ Frame" : trip.link.step.app === "set" ? "Go back to ③ Set" : "Go back to ⑤ Motion", "",
          () => { const k = trip.link.step.app; pipeline.go(k === "set" ? "set" : k); }),
        btn("End", "", leave(() => end())));
      rows.push(row);
    }
    const i = EL.findClip(cut.project.cut, trip.clip);
    const sibs = i >= 0 ? heldSiblings(i) : [];
    const n = 1 + sibs.length;
    for (const t of list.slice(0, 4)) {
      const secs = durationOf(t);
      // seconds = frames * den / num (cut.fi, set by every refresh): the clip and every clip Replace all changes
      const fit = i >= 0 ? lengthCheck(cut.project, [i, ...sibs], secs, cut.fi) : { ok: true, okAll: true, why: "", whyAll: "" };
      const what = t.kind && t.kind !== "app" && t.kind !== "frame" ? (t.label || t.kind) : t.rung === "look" ? "frame" : t.rung === "final" ? "Final" : "Draft";
      const row = el("div", "row");
      const when = [t.created ? hhmm(t.created) : "", Number.isFinite(secs) && secs ? `${secs.toFixed(1)} s` : ""].filter(Boolean).join(", ");
      row.append(el("span", "", `New ${what} for ${name}${when ? ` (${when})` : ""}.`));
      const rep = btn("Replace in cut", "go", () => replace(t, false), "This clip plays the new take; the old one stays in its versions (one ⌘Z undoes it)");
      const repAll = btn(`Replace all ${n} clips of this setup`, "", () => replace(t, true));
      rep.disabled = !fit.ok || secs === null;
      repAll.disabled = !fit.okAll || secs === null;
      row.append(rep);
      if (n > 1) row.append(repAll);
      row.append(btn("Compare", "", () => host.showTake?.({ id: trip.clip.shot_id, name }, { url: t.url, video: t.video, kind: t.rung, n: t.label || "new" })));
      rows.push(row);
      if (!fit.ok) rows.push(el("div", "why", fit.why));
      else if (n > 1 && !fit.okAll) rows.push(el("div", "why", fit.whyAll));
    }
    if (list.length) { const row = el("div", "row"); row.append(el("span", "", ""), btn("Keep the old one", "", leave(() => end()), "End the trip: the clip stays on its take; the new one stays listed in its menu")); rows.push(row); }
    offer.replaceChildren(...rows);
    showOffer(true);
  }

  Object.assign(link, { start, back, end, onView, refresh, fromStrip, pill, offer });
  Object.defineProperty(link, "trip", { get: () => trip });
  return link;
}
