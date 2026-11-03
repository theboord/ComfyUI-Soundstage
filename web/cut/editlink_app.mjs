// Soundstage: Edit from the timeline, the App side (Directive 9, docs/cut.md "Edit from the timeline").
// The Cut's Edit in… menu (web/cut/editlink.mjs) holds the clip's shot and hands the clip here through the Cut's host
// hook (onEditShot(shotId, where, ctx) -> editShot -> start): a trip remembers where you left the cut and which takes
// the shot had; each jump opens the step that made the clip with that clip loaded; "↩ Back to the cut" in the step bar
// brings you back to the same clip and playhead; the takes that landed meanwhile (App renders, Ripple / Pose /
// Performance / ✦ takes, new frames) are offered in the Cut, and "Replace in cut" makes one the clip's new version (one
// undoable edit; the old take stays in the clip's versions). Imported only by web/soundstage.js.
// Pure helpers (no DOM at import) are exported for tests/js/editlink.test.mjs: resolveLink, settingsFromPrompt,
// takesOfShot, beforeKeys, flattenClip.

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
  outside: "Made outside the App graph, so the file has no Soundstage recipe: the re-run uses the take's record.",
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
  const shotFrame = chosen?.url ? { url: chosen.url, seed: chosen.seed, model: chosen.model, exact: false, from: "chosen" } : null;
  const missing = [];
  let frame = shotFrame, recipe = { state: "missing", source: "", why: "" };
  if (type === "footage") {
    recipe.why = MISSING.footage;
  } else if (via === "ripple" || via === "pose" || via === "performance") {
    if (record?.edited) frame = { ref: record.edited, exact: true, from: "ripple" };
    recipe = record ? { state: "ok", source: "record", strength: record.strength, prompt: record.prompt || "", quality: record.kind === "final" ? "Final" : "Draft" }
      : { state: "missing", source: "", why: MISSING.record };
    if (!record) missing.push(MISSING.record);
    recipe.why = recipe.why || MISSING.outside;
  } else if (via === "oneclick") {
    const from = record?.oneclick?.from || "";
    if (from && !isClipRef(from)) frame = { ref: from, exact: true, from: "oneclick" };
    recipe = record ? { state: "ok", source: "record", card: record.oneclick?.id || "", label: record.oneclick?.label || "", from }
      : { state: "missing", source: "", why: MISSING.record };
    if (!record) missing.push(MISSING.record);
    recipe.why = recipe.why || MISSING.oneclick;
  } else if (type === "look") {
    const mine = chosen?.url && EL.fileKey(chosen.url) === t.key ? chosen : (candidates || []).find((c) => c?.url && EL.fileKey(c.url) === t.key);
    frame = { url: t.url, seed: mine?.seed, model: mine?.model, exact: true, from: "still" };
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
  try { pipeline.bar.insertBefore(pill, pipeline.stopBtn || null); } catch { /* no step bar */ }

  // ---- the offer, at the top of the Cut view
  const offer = el("div", "ss-editoffer");
  offer.hidden = true;
  offer.addEventListener("pointerdown", (e) => e.stopPropagation());
  try { cutView.prepend(offer); } catch { /* no Cut view */ }

  // ---- take detection: App renders, Ripple / Pose / Performance / ✦ videos (new frames are found on Back)
  try {
    pipeline.ctx?.onRung?.((ev) => {
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
    if (view === "cut") drawOffer(); else offer.hidden = true;
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
        if (c?.url) fr = { url: c.url, seed: c.seed, model: c.model, file: c.file, exact: true, from: "prompt" };
        else fr = fr ? { ...fr, why: `This take started from seed ${st.seed}${st.model ? ` (${String(st.model).split(" ·")[0]})` : ""}; that frame is not among the shot's frames any more, so ④ shows the shot's chosen frame.` } : fr;
      }
    }
    if (fr?.ref && !fr.url) fr = { ...fr, url: urlOf(fr.ref) };
    return fr;
  }

  // A one-line note in the step's own status area (as Review's Redo does), plus the App's status line.
  const stepNote = el("div", "ss-editnote");
  function note(step, text, buttons = []) {
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
    note("motion", rerun ? `${shotName(l)}: the Ripple take again, from its record (clip, edited frame, strength, prompt). “Ripple it” runs it.`
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
      say(`${shotName(l)}, frame ${l.clip.srcFrame}: the stage as it is now, not as it was when this take was rendered.`);
    },
    async frame(l) {
      const sid = l.shot.id;
      pipeline.go("frame");
      const fr = await frameFor(l);
      if (!trip || trip.link !== l) return;
      if (fr?.url) {
        const list = (pipeline.candidates[sid] = pipeline.candidates[sid] || []);
        if (!list.some((c) => EL.fileKey(c.url) === EL.fileKey(fr.url))) {
          // after a reload the take's frame is no candidate any more: add it back, as ✦ does (never chosen for you)
          list.unshift({ url: fr.url, file: fr.file || fileOfUrl(fr.url), seed: fr.seed ?? null, model: fr.model,
            ...(fr.from === "ripple" ? { edited: "Ripple frame 1" } : fr.from === "oneclick" ? { edited: "✦ source" } : fr.model ? {} : { edited: "From the cut" }) });
        }
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
        note("motion", `${shotName(l)}: Pose follow again (the record keeps its prompt: ${l.record?.prompt || "none"}). Preview / Render below run it.`);
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
      if (s) {
        pipeline.ltx?.store?.put?.(sid, s);
        try { pipeline.ltx.refresh(); pipeline.ltx.apply(sid); pipeline._syncAdherence?.(); pipeline._motionNote?.(); } catch { /* motion view not built */ }
      }
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
      say(`Touching up ${shotName(l)}'s frame. “Use my edited frame”, then re-render it in ⑤ Motion; Back to the cut offers the new take.`);
    },
    review(l) {
      pipeline.go("review");
      say(`${shotName(l)}: compare its rungs. Back to the cut when you're done.`);
    },
  };

  /** A jump from the Cut (the Cut held the shot first): remember the trip, open the shot, run the item. */
  async function start(sid, where, ctx = {}) {
    const base = ctx.link || cut.clipContext(ctx.index, ctx.recFrame);
    if (!base) return false;
    const l = resolveLink(base, appOf(sid));
    end({ quiet: true });   // one trip at a time: a new one ends the old
    trip = { sceneKey: host.sceneKey?.() ?? null, from: ctx.from || "cut",
      clip: { uid: l.clip.uid, index: l.clip.index, shot_id: String(sid), in: l.clip.in, out: l.clip.out },
      playhead: cut.frame, sel: cut.sel, scrollX: cut.scrollX, ppf: cut.ppf, where, link: l, before: beforeKeys(appOf(sid)),
      events: [], landed: [], marked: null, blocked: false };
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
    cut.seek(trip.playhead);
    try { cut._updateButtons(); cut._inspect?.(); } catch { /* */ }
    refresh();
  }

  function end({ quiet = false } = {}) {
    const had = !!trip;
    trip = null;
    pill.hidden = true;
    offer.hidden = true;
    offer.replaceChildren();
    stepNote.remove();
    label.textContent = "↩ Back to the cut";
    try { if (had) markTiles(); } catch { /* */ }
    if (had && !quiet) say("Trip ended: the clip stays on the take it was held on (its menu: Follow the latest render).");
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
    if (i < 0) { say("That clip is not in the cut any more."); return; }
    const pin = { url: t.url, rung: t.rung, ...(t.kind && t.kind !== "app" && t.kind !== "frame" ? { kind: t.kind } : {}),
      ...(t.label ? { label: t.label } : {}), ...(t.created ? { at: hhmm(t.created) } : {}) };
    const also = all ? heldSiblings(i).map((k) => ({ index: k, take: pin })) : [];
    const name = shotName(trip.link);
    if (!cut.replaceClipTake(i, pin, { also })) { say(`${name} already plays that take.`); return; }
    const v = cut.project.cut[i].take?.version;
    end({ quiet: true });
    say(`Replaced: ${name} plays v${v} now${also.length ? ` (and ${also.length} more clip${also.length === 1 ? "" : "s"} of this setup)` : ""}. ` +
      "⌘Z brings the old take back; a second ⌘Z ends the hold, and the clip follows the newest render again.");
  }

  function drawOffer() {
    if (!trip) { offer.hidden = true; return; }
    const name = shotName(trip.link), list = trip.landed || [];
    const rows = [];
    // ✦ and Reshoot run while you stay in the Cut: the offer shows when their take lands
    if (!list.length && (trip.where === "reshoot" || trip.where === "oneclick")) { offer.hidden = true; return; }
    if (!list.length) {
      const row = el("div", "row");
      row.append(el("span", "", `Nothing new for ${name} yet.`),
        btn(trip.link.step.app === "frame" ? "Go back to ④ Frame" : trip.link.step.app === "set" ? "Go back to ③ Set" : "Go back to ⑤ Motion", "",
          () => { const k = trip.link.step.app; pipeline.go(k === "set" ? "set" : k); }),
        btn("End", "", () => end()));
      rows.push(row);
    }
    const i = EL.findClip(cut.project.cut, trip.clip);
    const n = i >= 0 ? 1 + heldSiblings(i).length : 1;
    const clipSecs = (trip.clip.out) / (cut.rate || 24);
    for (const t of list.slice(0, 4)) {
      const secs = durationOf(t);
      const short = Number.isFinite(secs) && secs !== null && secs + 0.5 / (cut.rate || 24) < clipSecs;
      const what = t.kind && t.kind !== "app" && t.kind !== "frame" ? (t.label || t.kind) : t.rung === "look" ? "frame" : t.rung === "final" ? "Final" : "Draft";
      const row = el("div", "row");
      const when = [t.created ? hhmm(t.created) : "", Number.isFinite(secs) && secs ? `${secs.toFixed(1)} s` : ""].filter(Boolean).join(", ");
      row.append(el("span", "", `New ${what} for ${name}${when ? ` (${when})` : ""}.`));
      const rep = btn("Replace in cut", "go", () => replace(t, false), "This clip plays the new take; the old one stays in its versions (one ⌘Z undoes it)");
      const repAll = btn(`Replace all ${n} clips of this setup`, "", () => replace(t, true));
      rep.disabled = repAll.disabled = short || secs === null;
      row.append(rep);
      if (n > 1) row.append(repAll);
      row.append(btn("Compare", "", () => host.showTake?.({ id: trip.clip.shot_id, name }, { url: t.url, video: t.video, kind: t.rung, n: t.label || "new" })));
      rows.push(row);
      if (short) rows.push(el("div", "why", `The take is ${secs.toFixed(1)} s; the clip runs to ${clipSecs.toFixed(1)} s. Trim the clip, or render a longer take.`));
    }
    if (list.length) { const row = el("div", "row"); row.append(el("span", "", ""), btn("Keep the old one", "", () => end(), "End the trip: the clip stays on its take; the new one stays listed in its menu")); rows.push(row); }
    offer.replaceChildren(...rows);
    offer.hidden = false;
  }

  Object.assign(link, { start, back, end, onView, refresh, fromStrip, pill, offer });
  Object.defineProperty(link, "trip", { get: () => trip });
  return link;
}
