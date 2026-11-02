// ✦ One-click: everything a Higgsfield-style app does in one click, on any take or ④ Frame candidate, on top of the
// real 3D film set. A ✦ button on every take (Dailies cards and their takes, the Ladder) and on every ④ Frame
// candidate opens one in-canvas card window (the Presets window's style): every option visible, grouped as
// Effects · Light · Camera · Frame · Loop · Hand-off. A click asks once (it uses your GPU: how many jobs, about how
// long), runs, and the result lands as a new take on the shot (Takes, approvals, compare, Use as ④ Frame), checked
// by the take checks and the realism judge.
//
// The registry is the contract between the one-click modules (effects, light, angle, expand here; loop, reshoot,
// opencomfy, handoff in Track B):
//
//   registerOneClick({
//     id, group,            // "Effects" | "Light" | "Camera" | "Frame" | "Loop" | "Hand-off"
//     label, hint,          // card text, plain words
//     applies,              // ["still"] | ["clip"] | ["still","clip"]
//     gpu, minutes,         // false for Open in ComfyUI; shown as "$0 · about N min on your GPU"
//     available(target),    // -> true | "why not" (e.g. "needs the https bridge")
//     run(target, ctx),     // -> Promise<{take}|{still}|{file, kind}>; ctx.addTake(), ctx.toast(), ctx.undo
//   });
//   // target = { kind: "still"|"clip", ref: "sub/x.mp4 [output]", url, shot, take_id, recipe, from, label, thumb }
//
// Optional spec fields: jobs (GPU jobs a run queues, default 1), fields ([{id, label, placeholder, type, when}],
// shown in the ask strip; type "text" | "check" | "select" | "point": a tap on the take's first or last frame, value
// "x,y" in 0..1, field.frame = "first" | "last"), badge ("approximate", "exact", "experimental"), preview (a CSS filter or a draw(ctx, w, h)
// for the card thumbnail: a sketch of the effect on your own picture), order (sort inside the group).
//
// Pure helpers are exported for tests (tests/js/oneclick.test.mjs); OneClickPanel and attachOneClick are the DOM part.

import { refFromViewUrl, refOf, viewQuery, waitForOutput } from "../motion/ripple.mjs";
import { renderPreset } from "../takecheck/model.mjs";

export const GROUPS = [
  ["Effects", "Change the world in the picture: weather, time, flood, cut it out, empty it, bring it to life"],
  ["Light", "Relight it with a named film lighting setup"],
  ["Camera", "See it from another angle"],
  ["Frame", "Change the frame: wider, taller, another aspect"],
  ["Loop", "Make it loop"],
  ["Hand-off", "Take it somewhere else: ComfyUI, your phone"],
];
const GROUP_IDS = GROUPS.map((g) => g[0]);
export const PRIVATE_DIR = "soundstage_private";
export const OUT_DIR = `${PRIVATE_DIR}/oneclick`;

const REG = new Map();

/** Add (or replace, by id) a one-click. Returns the stored spec. Throws on a spec that can't work. */
export function registerOneClick(spec) {
  if (!spec || typeof spec !== "object") throw new Error("registerOneClick needs a spec object");
  const id = String(spec.id || "").trim();
  if (!/^[a-z0-9_.-]+$/i.test(id)) throw new Error(`one-click id ${JSON.stringify(spec.id)}: letters, digits, _ . - only`);
  if (!GROUP_IDS.includes(spec.group)) throw new Error(`one-click ${id}: group must be one of ${GROUP_IDS.join(", ")}`);
  if (!spec.label) throw new Error(`one-click ${id}: needs a label`);
  const applies = (Array.isArray(spec.applies) ? spec.applies : [spec.applies]).filter((k) => k === "still" || k === "clip");
  if (!applies.length) throw new Error(`one-click ${id}: applies must name "still" and/or "clip"`);
  if (typeof spec.run !== "function") throw new Error(`one-click ${id}: needs run(target, ctx)`);
  const s = { hint: "", gpu: true, minutes: 1, jobs: 1, fields: [], order: REG.size, available: () => true, ...spec, id, applies };
  REG.set(id, s);
  return s;
}
export function unregisterOneClick(id) { return REG.delete(String(id)); }
export function getOneClick(id) { return REG.get(String(id)) || null; }
export function oneClicks() { return [...REG.values()]; }

/** Can this one-click run on target? true, or a plain-words reason (never throws). */
export function availability(spec, target) {
  if (!spec) return "unknown one-click";
  if (!target?.kind) return "pick a take or a frame first";
  if (!spec.applies.includes(target.kind)) return spec.applies.includes("still") ? "works on stills: open a frame, not a clip" : "works on clips: open a draft or a final";
  try {
    const ok = spec.available ? spec.available(target) : true;
    return ok === true || ok === undefined ? true : String(ok || "not available here");
  } catch (e) { return `not available: ${e.message}`; }
}

/**
 * Every one-click for a target, grouped in GROUPS order: [{group, hint, items: [{spec, ok, why}]}]. One-clicks that
 * don't apply to this kind (stills vs clips) are still listed, greyed with the reason: nothing is hidden.
 */
export function oneClicksFor(target) {
  const out = [];
  for (const [group, hint] of GROUPS) {
    const items = oneClicks().filter((s) => s.group === group).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((spec) => { const a = availability(spec, target); return { spec, ok: a === true, why: a === true ? "" : a }; });
    // the ones that apply first, keeping registration order inside each half
    items.sort((a, b) => Number(b.ok) - Number(a.ok));
    if (items.length) out.push({ group, hint, items });
  }
  return out;
}

/** "$0 · about 2 min on your GPU" / "$0 · no GPU" (local open models cost no credits). */
export const jobsOf = (spec, target) => Math.max(1, Math.round(+(spec?.jobsFor ? spec.jobsFor(target) : spec?.jobs) || 1));
export const minutesOf = (spec, target) => +(spec?.minutesFor ? spec.minutesFor(target) : spec?.minutes) || 1;
export function costLabel(spec, target = null) {
  if (!spec?.gpu) return "$0 · no GPU";
  const m = minutesOf(spec, target);
  const jobs = jobsOf(spec, target);
  return `$0 · about ${m < 1 ? "<1" : m % 1 ? m.toFixed(1) : m} min on your GPU${jobs > 1 ? ` · ${jobs} jobs` : ""}`;
}

/** The question asked before a GPU run. */
export function askText(spec, target) {
  const what = target?.label || (target?.kind === "clip" ? "this clip" : "this frame");
  if (!spec.gpu) return `${spec.label} on ${what}.`;
  const jobs = jobsOf(spec, target);
  return `${spec.label} on ${what}: ${jobs} job${jobs > 1 ? "s" : ""} on your GPU, about ${minutesOf(spec, target)} min. Local models, no credits. The result lands as a new take.`;
}

const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v|avi)(\s*\[(input|output|temp)\])?$/i;
/** Is a file reference / URL a clip? */
export function isClipRef(refOrUrl) {
  const s = String(refOrUrl || "");
  if (/\/view\?/.test(s)) { const r = refFromViewUrl(s); return VIDEO_RE.test(r); }
  return VIDEO_RE.test(s);
}

/**
 * A one-click target from what the App shows: a take record (Dailies), a ④ Frame candidate, a Ladder layer.
 *   {url, file?, ref?, shot, take_id?, label?, thumb?, from?, recipe?, stage?}
 * stage = true when the still is the stage's own frame of the active shot (exact angles and depth locks need it).
 */
export function makeTarget({ url = "", file = null, ref = "", shot = "", take_id = "", take_kind = "", label = "", thumb = "", from = "take",
  recipe = null, stage = false, width = 0, height = 0 } = {}) {
  const r = ref || (file ? refOf(file) : "") || refFromViewUrl(url);
  if (!r) return null;
  return { kind: isClipRef(r) ? "clip" : "still", ref: r, url: url || "", shot: String(shot || ""), take_id: String(take_id || ""),
    take_kind: String(take_kind || ""), label: label || "", thumb: thumb || (isClipRef(r) ? "" : url), from, recipe, stage: !!stage, width: +width || 0, height: +height || 0 };
}

/** A tapped point "x,y" (0..1, 3 decimals), and back: [x, y] or null. */
export function fmtPoint(x, y) {
  const c = (v) => Math.min(1, Math.max(0, +v || 0)).toFixed(3);
  return `${c(x)},${c(y)}`;
}
export function readPoint(v) {
  const m = /^\s*(-?[\d.]+)\s*[,;]\s*(-?[\d.]+)\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  const x = +m[1], y = +m[2];
  return Number.isFinite(x) && Number.isFinite(y) ? [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] : null;
}

/** Where a one-click saves: output/soundstage_private/oneclick/<shot>_<id> (private: never the shared refs). */
export function outPrefix(target, id) {
  const sid = String(target?.shot || "shot").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40) || "shot";
  return `${OUT_DIR}/${sid}_${String(id).replace(/[^a-z0-9_-]+/gi, "_")}`;
}

/** A finished one-click -> a take on the shot (pipeline.chosen[sid].takes; the Takes bin and the Ladder read it). */
export function makeOneClickTake({ file, url, spec, target, kind, extra = {}, now = Date.now() }) {
  const clip = (kind || (isClipRef(refOf(file)) ? "clip" : "still")) === "clip";
  const take = {
    id: `oneclick_${spec.id}_${now.toString(36)}`, kind: clip ? (target?.kind === "clip" && /final/.test(target?.take_kind || "") ? "final" : "draft") : "look",
    url, file, created: now, label: `✦ ${spec.label}`, video: clip,
    oneclick: { id: spec.id, label: spec.label, from: target?.ref || "", from_take: target?.take_id || "", badge: spec.badge || "", ...extra },
  };
  return take;
}

/** Append a take to a shot's chosen record (mutates and returns it): the same list Ripple and Pose takes use. */
export function addTake(chosen, take) {
  const c = chosen || {};
  c.takes = [...(Array.isArray(c.takes) ? c.takes : []), take].slice(-40);
  return c;
}

// ------------------------------------------------------------------------------------------------ graph helpers
// API-prompt fragments the one-click modules share. Node ids are strings; out(id, i) is a link.

export const out = (id, i = 0) => [String(id), i];

/** The model keys this ComfyUI can run per router node, from /object_info: {edit, fill, matte, clean, video}. */
export function modelsFromObjectInfo(info = {}) {
  const keys = (n) => {
    const spec = info?.[n]?.input?.required?.model;
    return (spec?.[1]?.options || []).map((o) => {
      const nested = {};
      for (const sec of ["required", "optional"]) for (const [k, v] of Object.entries(o.inputs?.[sec] || {})) {
        const d = v?.[1]?.default ?? (Array.isArray(v?.[0]) ? v[0][0] : undefined);
        if (d !== undefined) nested[`model.${k}`] = d;
      }
      return { key: o.key, nested };
    });
  };
  return { edit: keys("SoundstageEditImage"), fill: keys("SoundstageFill"), matte: keys("SoundstageMatte"),
    clean: keys("SoundstageCleanPlate"), video: keys("SoundstageGenerateVideo"),
    ripple: !!info?.SoundstageRipple, padfill: !!info?.SoundstagePadForFill, vhs: !!info?.VHS_VideoCombine };
}

/** The first model whose key matches re: {model, ...nested} for a router node's inputs, or null. */
export function pickModel(list, re) {
  const m = (list || []).find((x) => re.test(x.key));
  return m ? { model: m.key, ...m.nested } : null;
}
export const KLEIN = /^FLUX 3 Klein/;
export const KREA = /^Krea 2 Turbo/;

/** A picture by file reference (a clip gives its frame 1): SoundstageImageLoad. */
export function loadNode(ref) { return { class_type: "SoundstageImageLoad", inputs: { source: ref } }; }

/** SoundstageEditImage inputs (the router fills in the backend graph). */
export function editInputs({ image, prompt, model, seed = 7, width = 0, height = 0, control = null, refs = [], denoise = null, steps = 0 }) {
  if (!model) throw new Error("no image edit model on this ComfyUI (FLUX 3 Klein or Krea 2)");
  const inp = { image, prompt: String(prompt || ""), negative: "", width: Math.round(width) || 0, height: Math.round(height) || 0, ...model,
    seed: Math.max(0, Math.floor(+seed || 0)), lora: "None", lora_strength: 1.0, steps: Math.max(0, steps | 0), cfg: 0, ref_files: "" };
  if (control) inp.control_image = control;
  refs.slice(0, 3).forEach((r, i) => { inp[`ref_${i + 1}`] = r; });
  if (denoise != null) {
    if (/^Krea/.test(model.model)) inp["model.denoise"] = +(+denoise).toFixed(2);
    else inp.stage_denoise = +(+denoise).toFixed(2);
  }
  return inp;
}

/** One still edit: load the picture (a clip's frame 1), edit it, save a PNG. Output node "9". */
export function stillEditPrompt({ source, prompt, model, seed, prefix, width = 0, height = 0, control = null, refs = [], denoise = null }) {
  if (!source) throw new Error("no picture to edit");
  return {
    1: loadNode(source),
    2: { class_type: "SoundstageEditImage", inputs: editInputs({ image: out(1), prompt, model, seed, width, height, control, refs, denoise }) },
    9: { class_type: "SaveImage", inputs: { images: out(2), filename_prefix: prefix } },
  };
}

/** h264 MP4 of IMAGE frames (+ audio link): CreateVideo -> SaveVideo. */
export function saveVideoNodes(images, fps, prefix, audio = null, ids = ["50", "51"]) {
  return {
    [ids[0]]: { class_type: "CreateVideo", inputs: { images, fps: typeof fps === "number" ? fps : fps, ...(audio ? { audio } : {}) } },
    [ids[1]]: { class_type: "SaveVideo", inputs: { video: out(ids[0]), filename_prefix: prefix, format: "mp4", "format.codec": "h264" } },
  };
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

// ------------------------------------------------------------------------------------------------ DOM

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
};
const stop = (e) => e.stopPropagation();

function ensureCss() {
  if (document.getElementById("ss-oc-css")) return;
  const link = h("link", { id: "ss-oc-css", rel: "stylesheet", href: new URL("./oneclick.css", import.meta.url).href });
  document.head.append(link);
}

/** The ✦ button: put it on a take card, a takes row, a ④ Frame candidate or the Ladder bar. */
export function oneClickButton(getTarget, open, { small = false, title = "One-click effects, relight, new angle, expand…" } = {}) {
  const b = h("button", { type: "button", class: `ss-oc-btn${small ? " sm" : ""}`, title, "aria-label": "One-click", "data-act": "oneclick" },
    h("span", { class: "st" }, "✦"), small ? null : h("span", { class: "tx" }, "One-click"));
  b.addEventListener("pointerdown", stop);
  b.addEventListener("click", (e) => {
    e.stopPropagation(); e.preventDefault();
    const t = typeof getTarget === "function" ? getTarget() : getTarget;
    open(t, b);
  });
  return b;
}

/**
 * The one-click window: one floating panel over the App (like Presets), the target on the left of its head, a card
 * grid per group, an ask strip at the foot, and the results of this session (each a take on its shot).
 * host = { api, root, addTake(sid, take, target), toast(msg), checks, stage, pipeline, say(msg), quality() }
 */
export class OneClickPanel {
  constructor(host) {
    ensureCss();
    this.host = host;
    this.models = null;
    this.running = new Map();   // spec id + target ref -> status text
    this.results = [];
    this.q = h("input", { type: "search", class: "ss-oc-q", placeholder: "Search: night, rain, relight, cutout, wider…", "aria-label": "Search one-clicks",
      on: { input: () => this._drawGrid() } });
    this.thumb = h("img", { class: "ss-oc-tgt", alt: "" });
    this.tname = h("div", { class: "ss-oc-tn" });
    this.grid = h("div", { class: "ss-oc-grid", role: "list" });
    this.ask = h("div", { class: "ss-oc-ask", hidden: true });
    this.foot = h("div", { class: "ss-oc-foot" }, this.status = h("span", { class: "tx" }, "Pick one. Each result lands as a new take on the shot."));
    this.res = h("div", { class: "ss-oc-res", hidden: true });
    this.cmp = h("div", { class: "ss-oc-cmp", hidden: true });   // before / after wipe of a result, in place of the cards
    this.el = h("div", { class: "ss-oc", hidden: true, role: "dialog", "aria-label": "One-click" },
      h("div", { class: "ss-oc-head" }, h("span", { class: "t" }, h("span", { class: "st" }, "✦"), "One-click"), this.thumb, this.tname, this.q,
        h("button", { type: "button", class: "ib", title: "Close (Esc)", "aria-label": "Close", on: { click: () => this.close() } }, "✕")),
      this.grid, this.cmp, this.res, this.ask, this.foot);
    for (const ev of ["pointerdown", "wheel", "keydown"]) this.el.addEventListener(ev, (e) => { if (ev !== "keydown" || e.key !== "Escape") e.stopPropagation(); }, { passive: ev === "wheel" });
    this.el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); if (!this.cmp.hidden) this._hideCompare(); else if (!this.ask.hidden) this._hideAsk(); else this.close(); } });
    (host.root || document.body).append(this.el);
  }

  get isOpen() { return !this.el.hidden; }

  async open(target) {
    if (!target) { this.host.say?.("Nothing to work on yet: render a frame or a take first."); return; }
    this.target = target;
    this.el.hidden = false;
    this._hideAsk();
    if (!target.thumb && target.kind === "clip" && target.url) {
      // a clip's card previews are drawn on its frame 1 (read in the browser, like Ripple's)
      import("../motion/ripple.mjs").then((R) => R.firstFrameDataURL(target.url)).then((u) => {
        target.thumb = u;
        if (this.target === target && this.isOpen) { this.thumb.src = u; this.thumb.hidden = false; this._drawGrid(); }
      }).catch(() => { /* no preview: the glyphs stay */ });
    }
    this.thumb.hidden = !target.thumb;
    if (target.thumb) this.thumb.src = target.thumb;
    this.tname.replaceChildren(h("b", {}, target.label || (target.kind === "clip" ? "Clip" : "Frame")),
      h("span", {}, target.kind === "clip" ? "Clip · effects carry through every frame (Ripple)" : "Still"));
    this._drawGrid();
    this.grid.scrollTop = 0;
    this._drawResults();
    if (!this.models) this.refreshModels().then(() => this._drawGrid());
    setTimeout(() => { try { this.q.focus({ preventScroll: true }); } catch { /* detached */ } }, 0);
  }

  close() { this.el.hidden = true; this._hideAsk(); this._hideCompare(); }

  async refreshModels() {
    const api = this.host.api;
    const names = ["SoundstageEditImage", "SoundstageFill", "SoundstageMatte", "SoundstageCleanPlate", "SoundstageGenerateVideo", "SoundstageRipple",
      "SoundstagePadForFill", "VHS_VideoCombine"];
    const info = {};
    await Promise.all(names.map(async (n) => {
      try { const r = await api.fetchApi(`/object_info/${n}`); if (r.ok) Object.assign(info, await r.json()); } catch { /* missing node */ }
    }));
    this.models = modelsFromObjectInfo(info);
    ONECLICK_ENV.models = this.models;
    return this.models;
  }

  _drawGrid() {
    const t = this.target;
    const q = this.q.value.trim().toLowerCase();
    const groups = oneClicksFor(t);
    const kids = [];
    for (const g of groups) {
      const items = g.items.filter(({ spec }) => !q || `${spec.label} ${spec.hint} ${spec.group} ${(spec.keywords || []).join(" ")}`.toLowerCase().includes(q));
      if (!items.length) continue;
      kids.push(h("div", { class: "ss-oc-gh", title: g.hint }, h("b", {}, g.group), h("span", {}, g.hint)));
      for (const it of items) kids.push(this._card(it));
    }
    if (!kids.length) kids.push(h("div", { class: "ss-oc-empty" }, q ? `Nothing matches “${this.q.value}”.` : "No one-clicks are installed."));
    this.grid.replaceChildren(...kids);
  }

  _card({ spec, ok, why }) {
    const t = this.target;
    const key = `${spec.id}|${t?.ref}`;
    const busy = this.running.get(key);
    const pv = h("div", { class: "pv" });
    if (t?.thumb) {
      const img = h("img", { src: t.thumb, alt: "", draggable: "false", loading: "lazy" });
      if (typeof spec.preview === "string") img.style.filter = spec.preview;
      pv.append(img);
      if (spec.overlay) pv.append(h("span", { class: "ov", style: spec.overlay }));
    } else pv.append(h("span", { class: "gl" }, spec.glyph || "✦"));
    const card = h("button", { type: "button", class: "ss-oc-card", role: "listitem", "data-id": spec.id, "aria-disabled": String(!ok),
      title: ok ? `${spec.label}: ${spec.hint}` : `${spec.label}: ${why}`, on: { click: () => (ok ? this._askFor(spec) : this._say(`${spec.label}: ${why}.`)) } },
    pv, h("span", { class: "nm" }, spec.label), h("span", { class: "sm" }, ok ? spec.hint : why),
    h("span", { class: "co" }, costLabel(spec, t)),
    spec.badge ? h("span", { class: `bd ${spec.badge}` }, spec.badge) : null,
    busy ? h("span", { class: "bz" }, busy) : null);
    return card;
  }

  _say(m) { this.status.textContent = m; }

  _askFor(spec) {
    const t = this.target;
    const fields = (spec.fields || []).filter((f) => !f.when || f.when(t));
    const inputs = {};
    const points = [];   // "point" fields (Refocus's marks) sit side by side at the left, the other controls in a grid beside them
    const rows = fields.map((f) => {
      if (f.type === "point") { const p = this._pointField(f, t); inputs[f.id] = p.input; points.push(p.el); return null; }
      const inp = f.type === "check" ? h("input", { type: "checkbox" }) : f.type === "select"
        ? h("select", {}, ...(f.options || []).map(([v, l]) => h("option", { value: v }, l)))
        : h("input", { type: "text", placeholder: f.placeholder || "" });
      if (f.value != null) { if (f.type === "check") inp.checked = !!f.value; else inp.value = String(f.value); }
      inputs[f.id] = inp;
      if (f.title) inp.title = f.title;
      return f.type === "check" ? h("label", { class: "ck", title: f.title || "" }, inp, f.label) : h("label", { class: "fl", title: f.title || "" }, h("span", {}, f.label), inp);
    }).filter(Boolean);
    const readOpts = () => {
      const opts = {};
      for (const [k, el] of Object.entries(inputs)) opts[k] = el.type === "checkbox" ? el.checked : el.value;
      return opts;
    };
    // spec.gpuWith(opts, target): whether these choices use the GPU (Refocus on the stage's depth does not)
    const runLabel = () => ((spec.gpuWith ? spec.gpuWith(readOpts(), t) : spec.gpu) ? `Run (${costLabel(spec, t).replace(/^\$0 · /, "")})` : spec.gpu ? "Run (no GPU)" : "Go");
    const go = h("button", { type: "button", class: "go", "data-act": "oneclick-run" }, runLabel());
    const cancel = h("button", { type: "button", on: { click: () => this._hideAsk() } }, "Cancel");
    go.addEventListener("click", () => {
      const opts = readOpts();
      this._hideAsk();
      this.run(spec, t, opts);
    });
    const ask = askText(spec, t);
    const fs = points.length
      ? h("div", { class: "fs split" }, h("div", { class: "pts" }, ...points), h("div", { class: "ctl" }, ...rows))
      : rows.length ? h("div", { class: "fs" }, ...rows) : null;
    if (fs && spec.gpuWith) fs.addEventListener("change", () => { go.textContent = runLabel(); });
    this.ask.classList.toggle("compact", !!points.length);
    this.ask.replaceChildren(h("div", { class: "q", title: ask }, h("b", {}, spec.label), h("span", {}, ask)),
      ...(fs ? [fs] : []), h("div", { class: "row" }, cancel, go));
    this.ask.hidden = false;
    setTimeout(() => (Object.keys(inputs).length ? (points.length ? this.ask.querySelector(".pick") : Object.values(inputs)[0]) : go)?.focus?.(), 0);
  }

  _hideAsk() { this.ask.hidden = true; this.ask.replaceChildren(); }

  /**
   * A "point" field: the take's first (or last) frame, tap it to set the mark (arrow keys nudge it 1%, Shift 5%).
   * -> {el, input} where input.value is "x,y" in 0..1 (what opts gets).
   */
  _pointField(f, t) {
    const input = h("input", { type: "hidden", value: f.value != null ? String(f.value) : "0.500,0.500" });
    const img = h("img", { alt: "", draggable: "false" });
    const dot = h("span", { class: "dot", "aria-hidden": "true" });
    const read = h("span", { class: "rd" });
    const box = h("div", { class: "pick", tabindex: "0", role: "button", "aria-label": `${f.label}: tap the frame to set the mark` }, img, dot);
    const place = () => {
      const p = readPoint(input.value) || [0.5, 0.5];
      dot.style.left = `${img.offsetLeft + p[0] * (img.clientWidth || 0)}px`;
      dot.style.top = `${img.offsetTop + p[1] * (img.clientHeight || 0)}px`;
      read.textContent = `${Math.round(p[0] * 100)}% across, ${Math.round(p[1] * 100)}% down`;
    };
    const set = (x, y) => { input.value = fmtPoint(x, y); place(); };
    img.addEventListener("load", place);
    img.addEventListener("click", (e) => { const r = img.getBoundingClientRect(); set((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); });
    box.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      const p = readPoint(input.value) || [0.5, 0.5], k = e.shiftKey ? 0.05 : 0.01;
      set(p[0] + d[0] * k, p[1] + d[1] * k);
    });
    const last = f.frame === "last" && t?.kind === "clip";
    // a clip's marks are tapped on the clip's own frames: its thumbnail can be another picture (a Dailies take's look
    // still, a Ladder draft's chosen Frame), with another framing or aspect
    const src = t?.kind === "still" ? t.url : null;
    if (src) img.src = src;
    else if (t?.url) {
      read.textContent = last ? "loading the last frame…" : "loading the first frame…";
      import("../motion/ripple.mjs").then((R) => (last ? R.lastFrameDataURL(t.url) : R.firstFrameDataURL(t.url)))
        .then((u) => { img.src = u; }).catch(() => { read.textContent = "the frame did not load: the mark stays at the centre"; });
    }
    setTimeout(place, 0);
    return { input, el: h("div", { class: "fl pt", title: f.title || "" }, h("span", {}, f.label), box, read, input) };
  }

  /** Before / after: the take the one-click started from under its result, a wipe, videos in sync. Shown in place of
   * the cards (in the window, no scrolling); Esc or the Back button returns. */
  _compare(r) {
    const before = r.target?.url, after = r.take?.url;
    if (!before || !after) return;
    const video = !!r.take?.video;
    const mk = (src, cls) => (video ? h("video", { src, class: cls, muted: true, loop: true, playsinline: true, preload: "auto" })
      : h("img", { src, class: cls, alt: "" }));
    const base = mk(before, "base"), top = mk(after, "top");
    if (video) { base.muted = true; top.muted = false; }   // one soundtrack (the result's): two would echo
    const line = h("div", { class: "line" });
    const slider = h("input", { type: "range", min: "0", max: "100", value: "50", "aria-label": "Before / after" });
    const placeWipe = () => { const v = +slider.value; top.style.clipPath = `inset(0 0 0 ${v}%)`; line.style.left = `${v}%`; };
    slider.addEventListener("input", placeWipe);
    const kids = [h("div", { class: "stage" }, base, top, line, h("span", { class: "tag l" }, "Before"), h("span", { class: "tag r" }, `✦ ${r.spec.label}`))];
    const bar = [slider];
    if (video) {
      top.addEventListener("play", () => { base.currentTime = top.currentTime; base.play().catch(() => {}); });
      top.addEventListener("pause", () => base.pause());
      top.addEventListener("seeked", () => { base.currentTime = top.currentTime; });
      top.addEventListener("timeupdate", () => { if (Math.abs(base.currentTime - top.currentTime) > 0.08) base.currentTime = top.currentTime; });
      bar.unshift(h("button", { type: "button", title: "Play / pause (both)", on: { click: () => (top.paused ? top.play().catch(() => {}) : top.pause()) } }, "▶ / ❚❚"));
    }
    bar.push(h("button", { type: "button", title: "Back to the one-clicks (Esc)", on: { click: () => this._hideCompare() } }, "✕ Back"));
    this.cmp.replaceChildren(...kids, h("div", { class: "bar" }, ...bar));
    placeWipe();
    this.grid.hidden = true; this.cmp.hidden = false;
    if (video) top.play().catch(() => { top.muted = true; top.play().catch(() => {}); });   // autoplay with sound refused: play muted
  }

  _hideCompare() {
    if (!this.cmp || this.cmp.hidden) return;
    for (const v of this.cmp.querySelectorAll("video")) { try { v.pause(); } catch { /* */ } }
    this.cmp.hidden = true; this.cmp.replaceChildren(); this.grid.hidden = false;
  }

  /** Run one one-click on a target (also what the MCP tool and tests call). Resolves to the take, or null. */
  async run(spec, target, opts = {}) {
    if (typeof spec === "string") spec = getOneClick(spec);
    const a = availability(spec, target);
    if (a !== true) { this._say(`${spec?.label || "One-click"}: ${a}.`); return null; }
    const key = `${spec.id}|${target.ref}`;
    const setBusy = (txt) => { if (txt) this.running.set(key, txt); else this.running.delete(key); if (this.isOpen) this._drawGrid(); };
    setBusy("Queued…");
    const ctx = this._ctx(spec, target, opts, setBusy);
    const t0 = Date.now();
    try {
      const r = await spec.run(target, ctx);
      if (!r) { setBusy(null); return null; }
      let take = r.take || null;
      if (!take && r.file) {
        const url = this._url(refOf(r.file)) + `&t=${Date.now()}`;
        take = makeOneClickTake({ file: r.file, url, spec, target, kind: r.kind, extra: { ...(r.extra || {}), engine: r.engine || "", note: r.note || "", seconds: Math.round((Date.now() - t0) / 1000) } });
      }
      if (take && !r.added) this.host.addTake?.(target.shot, take, target, r);
      const res = { spec, target, take, note: r.note || "", engine: r.engine || "", extra: r.extra || {}, at: Date.now() };
      this.results.unshift(res);
      this.results = this.results.slice(0, 12);
      setBusy(null);
      this._say(`${spec.label} landed as a take${target.label ? ` on ${target.label}` : ""}${r.note ? `: ${r.note}` : ""}.`);
      this.host.toast?.(`✦ ${spec.label} landed as a new take.`);
      this._drawResults();
      this._judge(res);
      return take;
    } catch (e) {
      setBusy(null);
      this._say(`${spec.label} failed: ${e.message}`);
      return null;
    }
  }

  _url(ref) { const q = viewQuery(ref); const api = this.host.api; return api?.apiURL ? api.apiURL(`/view?${q}`) : `/view?${q}`; }

  _ctx(spec, target, opts, setBusy) {
    const api = this.host.api, self = this;
    return {
      api, opts, spec, models: this.models || ONECLICK_ENV.models || {}, stage: this.host.stage, pipeline: this.host.pipeline,
      quality: () => this.host.quality?.() || "Draft",
      seed: randomSeed,
      prefix: (suffix = "") => outPrefix(target, spec.id + (suffix ? `_${suffix}` : "")),
      progress: (t) => setBusy(t),
      toast: (m) => self.host.toast?.(m),
      say: (m) => self._say(m),
      url: (ref) => self._url(ref),
      addTake: (take) => self.host.addTake?.(target.shot, take, target),
      async queue(prompt, label = spec.label) {
        setBusy(`${label}: queued…`);
        const res = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, client_id: api.clientId, extra_data: { soundstage_oneclick: { id: spec.id, shot: target.shot } } }) });
        const q = await res.json();
        if (!res.ok || q.error) {
          const ne = Object.values(q.node_errors || {})[0];
          throw new Error(ne ? `${ne.class_type}: ${ne.errors?.[0]?.message || ""} ${ne.errors?.[0]?.details || ""}`.trim() : q.error?.message || `HTTP ${res.status}`);
        }
        try { self.host.pipeline?.inflight?.set(q.prompt_id, { sid: target.shot, step: "oneclick" }); } catch { /* */ }
        setBusy(`${label}: rendering…`);
        return q.prompt_id;
      },
      async wait(pid, outId) {
        try { return await waitForOutput(api, pid, String(outId)); }
        finally { try { self.host.pipeline?.inflight?.delete(pid); self.host.pipeline?._drawShotRows?.(); } catch { /* */ } }
      },
      async upload(blob, name, subfolder = PRIVATE_DIR, type = "input") {
        const body = new FormData();
        body.append("image", new File([blob], name, { type: blob.type || "image/png" }));
        body.append("type", type); body.append("subfolder", subfolder); body.append("overwrite", "true");
        const r = await api.fetchApi("/upload/image", { method: "POST", body });
        if (r.status !== 200) throw new Error(`upload failed (${r.status})`);
        const j = await r.json();
        return `${j.subfolder ? j.subfolder + "/" : ""}${j.name} [${type}]`;
      },
    };
  }

  /** The take checks and the realism judge on a result (the same chips the Ladder and Dailies show). */
  async _judge(res) {
    const checks = this.host.checks;
    const f = res.take?.file;
    if (!checks || !f?.filename) return;
    res.judging = true; this._drawResults();
    try {
      if (res.take.video) res.check = await checks.check(f);
      res.realism = await checks.judge(f, 0);
    } catch (e) { res.realism = { verdict: "unavailable", error: e.message }; }
    res.judging = false;
    if (res.take) res.take.oneclick.realism = res.realism?.verdict ? { verdict: res.realism.verdict, score: res.realism.score } : null;
    this._drawResults();
  }

  _drawResults() {
    const list = this.results.filter((r) => !this.target || r.target.shot === this.target.shot);
    this.res.hidden = !list.length;
    this.res.replaceChildren(h("div", { class: "lab" }, "Results (each is a take on its shot)"),
      h("div", { class: "row" }, ...list.map((r) => {
        const t = r.take;
        const media = t?.video ? h("video", { src: t.url, muted: true, loop: true, playsinline: true, preload: "metadata",
          on: { mouseenter: (e) => e.target.play().catch(() => {}), mouseleave: (e) => e.target.pause() } })
          : h("img", { src: t?.url || "", alt: "" });
        const rv = r.realism;
        const chip = r.judging ? h("span", { class: "ch" }, "judging…")
          : rv?.verdict === "pass" ? h("span", { class: "ch ok", title: "Realism judge" }, `✓ real ${rv.score}/10`)
            : rv?.verdict === "fail" ? h("span", { class: "ch bad", title: (rv.defects || []).map((d) => d.label).join("\n") }, `✗ looks generated ${rv.score}/10`)
              : rv ? h("span", { class: "ch", title: rv.error || rv.why || "" }, "not judged") : null;
        return h("div", { class: "it" }, media, h("span", { class: "nm" }, `✦ ${r.spec.label}`),
          r.spec.badge ? h("span", { class: `bd ${r.spec.badge}` }, r.spec.badge) : null, chip,
          h("div", { class: "acts" },
            h("button", { type: "button", title: "Open this take", on: { click: () => this.host.openTake?.(r.target.shot, t) } }, "Open"),
            r.target?.url && t?.url ? h("button", { type: "button", title: "Wipe between the take it started from and this result", on: { click: () => this._compare(r) } }, "Before / after") : null,
            !t?.video && this.host.useAsFrame ? h("button", { type: "button", title: "Use it as this shot's ④ Frame", on: { click: () => this.host.useAsFrame(r.target.shot, t) } }, "Use as ④ Frame") : null,
            h("button", { type: "button", title: "Run another one-click on this result", on: { click: () => this.open(makeTarget({ url: t.url, file: t.file, shot: r.target.shot, take_id: t.id, label: `✦ ${r.spec.label}`, from: "result" })) } }, "✦ again")));
      })));
  }
}

/** Shared state the modules read (the probed models). */
export const ONECLICK_ENV = { models: null, stage: null };

/** Small numbers about a picture: its size (for edit nodes that keep the input size, and video sizes). */
export function imageSize(url) {
  return new Promise((resolve) => {
    if (!url || typeof Image === "undefined") { resolve({ width: 0, height: 0 }); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

// ------------------------------------------------------------------------------------------------ mount

/** Which take of a shot an MCP call means: "3" / 3 = Tk 3, "" = the circled, else the latest final > draft > frame. */
export function pickTake(takes, which) {
  const list = Array.isArray(takes) ? takes.filter((t) => t?.url) : [];
  if (!list.length) return null;
  if (which != null && which !== "") {
    const n = parseInt(String(which).replace(/^tk\s*/i, ""), 10);
    return list.find((t) => t.n === n) || list.find((t) => t.id === String(which)) || null;
  }
  const c = list.find((t) => t.circled);
  if (c) return c;
  for (const k of ["final", "draft", "look"]) { const hit = [...list].reverse().find((t) => t.kind === k); if (hit) return hit; }
  return list[list.length - 1];
}

/** The one-clicks as plain data for the MCP tool / the server (no functions). */
export function catalogFor(target) {
  return oneClicksFor(target).flatMap((g) => g.items.map(({ spec, ok, why }) => ({ id: spec.id, group: spec.group, label: spec.label, hint: spec.hint,
    applies: spec.applies, gpu: !!spec.gpu, minutes: minutesOf(spec, target), jobs: jobsOf(spec, target), badge: spec.badge || "", ok, why,
    fields: (spec.fields || []).filter((f) => !f.when || !target || f.when(target)).map((f) => ({ id: f.id, label: f.label, type: f.type || "text" })) })));
}

/**
 * Wire ✦ into the App: the Dailies take cards and rows (bin.mjs oneClickTake hook), the Ladder bar (ladder.extraBar),
 * every ④ Frame candidate (after pipeline._drawCandidates), and the MCP relay (soundstage.oneclick events).
 * host = { api, root, stage, pipeline, ladder, takeChecks, say, toast, showTake, getShots, takesOf(sid), refresh() }
 */
// The one-click modules the App loads (each registers its cards). Track B adds "loop", "reshoot", "opencomfy", "handoff".
// refocus is listed here (not imported by soundstage.js like Track B) so the MCP catalog (catalog.py) knows it.
export const MODULES = ["effects", "light", "angle", "expand", "refocus"];

export function attachOneClick(host) {
  const { api, stage, pipeline, ladder } = host;
  ONECLICK_ENV.stage = stage;
  const ready = Promise.all(MODULES.map((m) => import(`./${m}.mjs`).catch((e) => console.warn(`Soundstage one-click: ${m} didn't load`, e))));
  const shotName = (sid) => { try { return (stage.toJSON().shots || []).find((s) => s.id === sid)?.name || sid; } catch { return sid; } };
  const panel = new OneClickPanel({
    api, root: host.root, stage, pipeline, checks: host.takeChecks, say: host.say, toast: host.toast || host.say,
    quality: () => (renderPreset(pipeline) === "Draft" ? "Draft" : "Final"),
    openTake: (sid, take) => host.showTake?.(sid, take),
    addTake(sid, take, target) {
      if (!pipeline || !sid) return;
      addTake(pipeline.chosen[sid] = pipeline.chosen[sid] || {}, take);
      if (!take.video) {
        // a still result is also a ④ Frame candidate of its shot: one click on it makes it the shot's frame
        const list = (pipeline.candidates[sid] = pipeline.candidates[sid] || []);
        list.unshift({ url: take.url, file: take.file, edited: take.label, oneclick: take.oneclick, seed: null, model: "One-click" });
        try { if (sid === stage.activeShot().id) pipeline._drawCandidates(); } catch { /* frame view not built */ }
      }
      pipeline._saveChosen?.();
      if (take.video) { try { pipeline.onRippleTake?.(sid, take); } catch { /* */ } }
      try { host.refresh?.(); } catch { /* */ }
    },
    useAsFrame(sid, take) {
      if (sid !== stage.activeShot().id) { host.say?.(`Open ${shotName(sid)} first, then use the frame.`); return; }
      const c = (pipeline.candidates[sid] || []).find((x) => x.url === take.url);
      if (c) { pipeline.choose(c); pipeline.go?.("frame"); host.say?.(`✦ ${take.oneclick?.label || "One-click"} is now the ④ Frame of ${shotName(sid)}.`); }
    },
  });
  const open = async (t) => { await ready; return t ? panel.open(t) : host.say?.("Nothing to work on yet: render a frame or a take first."); };

  // Dailies: the hero take on each card and every row of its takes list
  function decorate(el, take, shot, where = "card") {
    if (!el || !take?.url || take.kind === "previz") return;
    const target = () => makeTarget({ url: take.url, file: take.file, shot: shot.id, take_id: take.id, take_kind: take.kind,
      label: `${shot.name || shot.id} · Tk ${take.n || 1}`, thumb: take.thumb || (take.video ? "" : take.url), from: "take" });
    const b = oneClickButton(target, open, { small: true, title: `One-click on take ${take.n || 1}: effects, relight, new angle, expand…` });
    // a card: in its caption row, before "N takes"; a row of the takes list: at its end
    const tk = where === "card" ? el.querySelector(":scope > button.tk") : null;
    if (tk) el.insertBefore(b, tk); else el.append(b);
  }

  // Ladder: one ✦ for the best layer on view (final > draft > frame)
  if (ladder) {
    ladder.extraBar = () => {
      const s = ladder.sources || {};
      const rung = [4, 3, 2].find((r) => s[r]?.url);
      if (rung == null) return [];
      const sh = stage.activeShot();
      const b = oneClickButton(() => makeTarget({ url: s[rung].url, shot: sh.id, label: `${sh.name} · ${rung === 4 ? "Final" : rung === 3 ? "Draft" : "Frame"}`,
        take_kind: rung === 4 ? "final" : rung === 3 ? "draft" : "look", thumb: rung === 2 ? s[rung].url : (pipeline?.chosen?.[sh.id]?.url || ""),
        from: "ladder", stage: rung === 2 && !pipeline?.chosen?.[sh.id]?.edited }), open, { title: `One-click on the ${rung === 4 ? "final" : rung === 3 ? "draft" : "frame"} on view` });
      return [Object.assign(document.createElement("span"), { className: "sep" }), b];
    };
    try { ladder._drawBar(); } catch { /* not built */ }
  }

  // ④ Frame: a ✦ on every candidate
  if (pipeline && !pipeline._ssOneClick) {
    pipeline._ssOneClick = true;
    const draw = pipeline._drawCandidates.bind(pipeline);
    pipeline._drawCandidates = (...a) => {
      const r = draw(...a);
      try {
        const sid = stage.activeShot().id, sh = stage.activeShot();
        const list = pipeline.candidates[sid] || [];
        [...(pipeline.f?.grid?.children || [])].forEach((el, i) => {
          const c = list[i];
          if (!c?.url || el.querySelector(":scope > .ss-oc-btn")) return;
          if (c.oneclick) { const cap = el.querySelector(".cap > span"); if (cap) cap.textContent = c.edited || "✦ One-click"; }
          el.append(oneClickButton(() => makeTarget({ url: c.url, file: c.file, shot: sid, label: `${sh.name} · frame${c.seed != null ? ` ${c.seed}` : ""}`,
            thumb: c.url, from: "frame", stage: !c.edited && !c.oneclick, take_kind: "look" }), open, { small: true }));
        });
      } catch { /* never block the candidates */ }
      return r;
    };
    try { pipeline._drawCandidates(); } catch { /* frame view not built */ }
  }

  // MCP relay (soundstage/oneclick/routes.py): list / propose / run on a shot's take, answered by this App
  async function resolveTarget({ shot, take } = {}) {
    let shots = [];
    try { shots = stage.toJSON().shots || []; } catch { /* */ }
    const n = parseInt(shot, 10);
    const sh = shot == null || shot === "" ? stage.activeShot() : (Number.isFinite(n) && String(n) === String(shot).trim() ? shots[n - 1] : shots.find((s) => s.name === shot || s.id === shot));
    if (!sh) throw new Error(`no shot ${shot}`);
    const t = pickTake(host.takesOf?.(sh) || [], take);
    if (!t) throw new Error(`${sh.name}: no take${take ? ` ${take}` : ""} yet`);
    return makeTarget({ url: t.url, file: t.file, shot: sh.id, take_id: t.id, take_kind: t.kind, label: `${sh.name} · Tk ${t.n || 1}`,
      thumb: t.thumb || (t.video ? "" : t.url), from: "mcp" });
  }
  async function onRelay(ev) {
    const d = ev.detail || {};
    let result;
    try {
      await ready;
      const target = await resolveTarget(d);
      if (!panel.models) await panel.refreshModels();
      if (d.kind === "list") result = { target: { label: target.label, kind: target.kind }, oneclicks: catalogFor(target) };
      else {
        const spec = getOneClick(d.oneclick);
        if (!spec) throw new Error(`unknown one-click ${d.oneclick}: list them first`);
        const a = availability(spec, target);
        if (a !== true) throw new Error(`${spec.label}: ${a}`);
        if (d.kind === "propose") result = { target: { label: target.label, kind: target.kind }, plan: askText(spec, target), gpu: !!spec.gpu, cost: costLabel(spec, target) };
        else {
          host.say?.(`MCP: ✦ ${spec.label} on ${target.label}…`);
          const tk = await panel.run(spec, target, d.opts || {});
          if (!tk) throw new Error(panel.status.textContent || "it didn't finish");
          const res = panel.results.find((r) => r.take === tk);
          for (let i = 0; i < 300 && res?.judging !== false && !res?.realism; i++) await new Promise((r) => setTimeout(r, 1000));
          result = { ok: true, label: tk.label, file: tk.file, url: tk.url, kind: tk.kind, realism: res?.realism ? { verdict: res.realism.verdict, score: res.realism.score,
            defects: (res.realism.defects || []).map((x) => x.label) } : null, note: res?.note || "" };
        }
      }
    } catch (e) { result = { error: e.message }; }
    try { await api.fetchApi("/soundstage/oneclick/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.id, result }) }); } catch { /* server gone */ }
  }
  try { api.addEventListener?.("soundstage.oneclick", onRelay); } catch { /* older frontend */ }

  return { panel, open, decorate, ready, run: async (id, target, opts) => { await ready; return panel.run(getOneClick(id), target, opts); }, resolveTarget };
}

// ------------------------------------------------------------------------------------------------ shared runners

/** Pixels for an edit: the target's own size when known (capped at maxMP megapixels), else 0 x 0 (Klein: 1 MP). */
export function editSize(target, maxMP = 2.1) {
  const w = +target?.width || 0, hh = +target?.height || 0;
  if (!w || !hh) return { width: 0, height: 0 };
  const s = Math.min(1, Math.sqrt((maxMP * 1e6) / (w * hh)));
  return { width: Math.max(256, Math.round((w * s) / 16) * 16), height: Math.max(256, Math.round((hh * s) / 16) * 16) };
}

/** A video size for LTX from a picture's aspect: long side `long`, both multiples of 64. */
export function ltxSize(width, height, long = 1280) {
  const w = +width || 16, hh = +height || 9;
  const s = long / Math.max(w, hh);
  const snap = (v) => Math.max(256, Math.round((v * s) / 64) * 64);
  return { width: snap(w), height: snap(hh) };
}

/** Make sure a still target knows its size (edits keep it). */
export async function withSize(target) {
  if (target.kind === "still" && !(target.width && target.height) && target.url) Object.assign(target, await imageSize(target.url));
  return target;
}

/** One still edit with the router (Klein by default): -> the saved PNG file. */
export async function runStillEdit(target, ctx, { prompt, model = null, control = null, refs = [], denoise = null, suffix = "", size = null, extraNodes = null }) {
  const m = model || pickModel(ctx.models?.edit, KLEIN) || pickModel(ctx.models?.edit, KREA);
  if (!m) throw new Error("no image edit model here (FLUX 3 Klein or Krea 2)");
  const sz = size || editSize(await withSize(target));
  const p = stillEditPrompt({ source: target.ref, prompt, model: m, seed: ctx.seed(), prefix: ctx.prefix(suffix), ...sz, control, refs, denoise });
  if (extraNodes) Object.assign(p, extraNodes);
  const pid = await ctx.queue(p);
  return ctx.wait(pid, "9");
}

/**
 * A clip edit: frame 1 edited as a still (Klein), then LTX Ripple carries it through the whole clip with its motion,
 * camera and sound (web/motion/ripple.mjs). Two GPU jobs. -> {file, kind: "clip", extra: {frame1}}
 */
export async function runEditThenRipple(target, ctx, { prompt, ripplePrompt = "", model = null, strength = null, colorMatch = "off" }) {
  const { buildRipplePrompt, RIPPLE_STRENGTH } = await import("../motion/ripple.mjs");
  ctx.progress("Frame 1: editing (job 1 of 2)…");
  const f1 = await runStillEdit(target, ctx, { prompt, model, suffix: "f1", size: { width: 0, height: 0 } });
  const edited = refOf(f1);
  const rp = buildRipplePrompt({ source: target.ref, edited, prompt: ripplePrompt, strength: strength ?? RIPPLE_STRENGTH, quality: ctx.quality(),
    seed: ctx.seed(), colorMatch, keepAudio: true, prefix: ctx.prefix() });
  ctx.progress("Ripple: carrying it through the clip (job 2 of 2)…");
  const pid = await ctx.queue(rp, "Ripple");
  const file = await ctx.wait(pid, "2");
  return { file, kind: "clip", extra: { frame1: f1 }, engine: "FLUX 3 Klein frame 1 → LTX Ripple" };
}

/** LTX-2.5 image-to-video from a still (Living photo, the practical effects): -> {file, kind: "clip"}. */
export async function runI2V(target, ctx, { prompt, seconds = 5, sound = "" }) {
  const m = pickModel(ctx.models?.video, /^LTX-2\.5/);
  if (!m) throw new Error("LTX-2.5 isn't installed here");
  await withSize(target);
  const { width, height } = ltxSize(target.width, target.height, ctx.quality() === "Final" ? 1920 : 1280);
  const frames = Math.round(seconds * 24 / 8) * 8 + 1;
  const p = {
    1: loadNode(target.ref),
    2: { class_type: "SoundstageGenerateVideo", inputs: { prompt, negative: "", first_frame: out(1), width, height, frames, fps: 24, ...m,
      seed: ctx.seed(), sound, music: "", line: "", last_file: "", ref_files: "" } },
    3: { class_type: "SaveVideo", inputs: { video: out(2), filename_prefix: ctx.prefix(), format: "mp4", "format.codec": "h264" } },
  };
  const pid = await ctx.queue(p);
  return { file: await ctx.wait(pid, "3"), kind: "clip", engine: "LTX-2.5 image to video" };
}

/** A canvas -> PNG blob. */
export function canvasBlob(c) {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("couldn't read the stage pass"))), "image/png"));
}

/**
 * The stage's own pass of the open shot at frame 0 ("depth", "color", "clay"), optionally through another camera
 * (stage.previewCamera: nothing on the shot changes), uploaded to input/soundstage_private/oneclick/. -> file ref.
 */
export async function stagePass(stage, ctx, mode, { camera = null, name = mode } = {}) {
  if (!stage?.renderFrameTo) throw new Error("the stage isn't open here");
  let canvas;
  if (camera) stage.previewCamera(camera);
  try {
    const c = stage.renderFrameTo(mode, 0);
    canvas = document.createElement("canvas");
    canvas.width = c.width; canvas.height = c.height;
    canvas.getContext("2d").drawImage(c, 0, 0);
  } finally { if (camera) stage.previewCamera(null); }
  return ctx.upload(await canvasBlob(canvas), `oc_${name}_${Date.now().toString(36)}.png`, OUT_DIR, "input");
}

/** Exact stage features (depth locks, exact angles) need the still to be the open shot's own frame. */
export function stageReason(target, stage) {
  if (!target?.stage) return "needs a frame painted from the stage: use it on a ④ Frame candidate";
  let sid = "";
  try { sid = stage?.activeShot?.()?.id || ""; } catch { /* no stage */ }
  if (!sid) return "the stage isn't open here";
  if (sid !== target.shot) return "open this frame's shot on the stage first";
  return true;
}
