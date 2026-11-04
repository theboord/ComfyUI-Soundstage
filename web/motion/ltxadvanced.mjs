// ⑤ Motion: the render presets (Draft · Final · Advanced) and the "Advanced (LTX)" pop-over.
//
// The presets are web/motion/ltx_presets.json (soundstage/ltx_settings.py reads the same file; a test keeps the copy
// below identical). A shot's settings are {preset, ...overrides}, saved per shot in the Stage node's properties
// (ss_ltx) and written to the Quality node's `advanced` widget at queue time. Python resolves them into the graph:
// stage-1 size, steps + scheduler + shift → sigmas, two-stage / one pass, temporal x2, CFG, seed, IC-LoRA, decode
// tiles, codec / CRF. Draft and Final are fixed recipes; Advanced starts from Final and every knob is the user's:
// editing a quality knob on Draft or Final turns the shot into Advanced (its values carried over), "Reset to Draft /
// Final" goes back. The retired Hollywood preset (1408p, CRF 12) loads as Advanced with its old values (LEGACY_PRESETS).
//
// Pure helpers (resolveSettings, stageSizes, estimateSeconds, compactSettings) have no DOM and are unit-tested.
import { ltxLoraGroups, ltxLoraWarning, normalizeStack } from "../pipeline/loras.mjs";
import { createLoraStack } from "../pipeline/lorastack.mjs";

export const PRESETS = {
  Draft: {
    label: "Draft", tip: "A quick look: 8 + 3 steps, 1080p class. Faces readable, motion approximate.",
    resolution: 1088, two_stage: true, steps_1: 8, steps_2: 3, s2_start: 0.909375, sampler: "euler_ancestral", cfg: 1.0,
    temporal_x2: false, decode: { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 }, codec: "h264", crf: 18,
  },
  Final: {
    label: "Final", tip: "Clean motion and detail: 12 + 6 steps, 1080p class, high-bitrate H.264. The default.",
    resolution: 1088, two_stage: true, steps_1: 12, steps_2: 6, s2_start: 0.909375, sampler: "euler_ancestral", cfg: 1.0,
    temporal_x2: false, decode: { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 }, codec: "h264", crf: 14,
  },
  Advanced: {
    label: "Advanced", tip: "Your own numbers: starts from Final (12 + 6 steps, 1080p class) and opens every setting: steps, shift, scheduler, sampler, CFG, seed, resolution, codec…",
    resolution: 1088, two_stage: true, steps_1: 12, steps_2: 6, s2_start: 0.909375, sampler: "euler_ancestral", cfg: 1.0,
    temporal_x2: false, decode: { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 }, codec: "h264", crf: 14,
  },
};
export const PRESET_NAMES = ["Draft", "Final", "Advanced"];
/** Retired presets (ltx_presets.json "legacy"): a shot saved on one resolves to Advanced pre-filled with its values. */
export const LEGACY_PRESETS = {
  Hollywood: {
    label: "Hollywood (retired)", tip: "The retired Hollywood preset (1408p, 12 + 6 steps, CRF 12): a shot saved on it opens as Advanced with these values.",
    resolution: 1408, two_stage: true, steps_1: 12, steps_2: 6, s2_start: 0.909375, sampler: "euler_ancestral", cfg: 1.0,
    temporal_x2: false, decode: { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 }, codec: "h264", crf: 12,
  },
};
/** The hero recipe (the old Hollywood numbers) as Advanced overrides: the "Hero final" preset recipe uses it. */
export const HERO = { resolution: 1408, steps_1: 12, steps_2: 6, crf: 12 };
// ⑤ Motion › Adherence: how tightly the render follows the clay (ltx_presets.json "adherence"; a test keeps them equal).
// Measured in share/Blocking_Adherence/REPORT.txt. Each level sets the raw knobs Advanced (LTX) can still override.
export const ADHERENCE = {
  default: "Exact",
  levels: {
    Loose: {
      label: "Loose", tip: "More invention: a softened clay guide and a lighter Layout IC-LoRA. Natural motion, but positions and framing can drift (the old default).",
      motion_freedom: 0.5, guide_blur: 10, ic_lora: 0.825, reference: 1.0,
    },
    Balanced: {
      label: "Balanced", tip: "Close to the clay with a little freedom for gait and limbs.",
      motion_freedom: 0.25, guide_blur: 6, ic_lora: 0.92, reference: 0.75,
    },
    Exact: {
      label: "Exact", tip: "As close to the clay as LTX goes: a sharp clay guide, the full Layout IC-LoRA, and your frame as a lighter look reference so it can't pull the shot off its marks.",
      motion_freedom: 0.0, guide_blur: 0, ic_lora: 1.0, reference: 0.5,
    },
  },
};
export const ADHERENCE_NAMES = ["Loose", "Balanced", "Exact"];
export const DEFAULT_PRESET = "Final";
export const SAMPLERS = ["euler_ancestral", "euler", "res_multistep", "dpmpp_2m", "lcm"];
export const SCHEDULERS = [["distilled", "Distilled (LTX-2.5's tuned curve)"], ["linear", "Linear (even steps, LTXVScheduler's base)"],
  ["linear_quadratic", "Linear-quadratic (LTX's paper schedule)"]];
export const MIN_STEPS_1 = 1;   // below 8 the distilled curve is thinned (ltx_settings.sigmas_1); the other schedulers take any count
export const CODECS = [["h264", "H.264 MP4 (plays everywhere)"], ["prores_hq", "ProRes 422 HQ master (.mov) + H.264 preview"]];
export const RESOLUTIONS = [[544, "544p (fast, half HD)"], [720, "720p"], [1088, "1080p (1088)"], [1408, "1440p (1408)"], [1536, "1536p"]];
export const DECODES = [
  ["512/64/128/32", "Small tiles (least memory)", { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32 }],
  ["768/192/128/32", "Medium tiles, wide overlap (cleaner seams)", { tile_size: 768, overlap: 192, temporal_size: 128, temporal_overlap: 32 }],
  ["1024/256/128/48", "Large tiles (fastest, most memory)", { tile_size: 1024, overlap: 256, temporal_size: 128, temporal_overlap: 48 }],
];
const KEYS = ["resolution", "two_stage", "steps_1", "steps_2", "s2_start", "sigmas_1", "sigmas_2", "sampler", "scheduler", "shift", "cfg", "seed",
  "ic_lora", "fps", "temporal_x2", "decode", "codec", "crf", "loras", "adherence", "guide_blur", "reference", "from"];
/** The quality knobs: changing one of these on a Draft / Final shot makes it Advanced. The seed (the take), Adherence and
 *  its raw knobs (the blocking) and the LoRAs (add-ons) are their own controls and never move a shot off its preset. */
export const QUALITY_KEYS = ["resolution", "two_stage", "steps_1", "steps_2", "s2_start", "sigmas_1", "sigmas_2", "sampler", "scheduler", "shift",
  "cfg", "fps", "temporal_x2", "decode", "codec", "crf"];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (v === null || v === undefined || v === "" || !Number.isFinite(+v) ? d : +v);

/** Preset + overrides → complete settings (mirrors soundstage/ltx_settings.resolve). */
export function resolveSettings(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const legacy = LEGACY_PRESETS[s.preset];
  const name = legacy ? "Advanced" : PRESET_NAMES.includes(s.preset) ? s.preset : DEFAULT_PRESET;
  const out = { ...structuredClone(PRESETS[name]), ...(legacy ? structuredClone(legacy) : {}), preset: name, label: PRESETS[name].label, tip: PRESETS[name].tip };
  for (const k of KEYS) if (s[k] !== undefined && s[k] !== null && s[k] !== "") out[k] = s[k];
  // The LoRA stack. A shot saved before it had one extra_lora ({name, strength}): it loads as a one-row stack.
  const stack = normalizeStack(s.loras !== undefined ? s.loras : s.extra_lora);
  if (stack.length) out.loras = stack; else delete out.loras;
  out.resolution = Math.round(clamp(num(out.resolution, 1088), 256, 2176));
  out.two_stage = !!out.two_stage;
  out.steps_1 = Math.round(clamp(num(out.steps_1, 8), MIN_STEPS_1, 60));
  out.steps_2 = Math.round(clamp(num(out.steps_2, 3), 1, 40));
  out.s2_start = clamp(num(out.s2_start, 0.909375), 0.3, 1);
  out.cfg = clamp(num(out.cfg, 1), 1, 10);
  out.sampler = SAMPLERS.includes(out.sampler) ? out.sampler : "euler_ancestral";
  out.scheduler = SCHEDULERS.some(([k]) => k === out.scheduler) ? out.scheduler : "distilled";
  out.shift = clamp(num(out.shift, 1) || 1, 0.1, 10);
  if (name === "Advanced") out.from = ["Draft", "Final"].includes(out.from) ? out.from : "Final"; else delete out.from;
  out.codec = CODECS.some(([k]) => k === out.codec) ? out.codec : "h264";
  out.crf = Math.round(clamp(num(out.crf, 14), 0, 51));
  out.temporal_x2 = !!out.temporal_x2;
  if (!ADHERENCE_NAMES.includes(out.adherence)) out.adherence = ADHERENCE.default;
  return out;
}

/** The raw knobs of resolved settings: the Adherence level's, each overridden by an explicit value
 *  (mirrors soundstage/ltx_settings.adherence_knobs). */
export function adherenceKnobs(s) {
  const name = ADHERENCE_NAMES.includes(s?.adherence) ? s.adherence : ADHERENCE.default;
  const lv = ADHERENCE.levels[name];
  const set = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(+v);
  return {
    adherence: name, motion_freedom: lv.motion_freedom,
    ic_lora: set(s?.ic_lora) ? clamp(+s.ic_lora, 0, 2) : lv.ic_lora,
    guide_blur: set(s?.guide_blur) ? Math.round(clamp(+s.guide_blur, 0, 32)) : lv.guide_blur,
    reference: set(s?.reference) ? clamp(+s.reference, 0, 1) : lv.reference,
  };
}

/** Only what differs from the preset (what is saved per shot and sent to the Quality node). */
export function compactSettings(s) {
  const r = resolveSettings(s), base = resolveSettings({ preset: r.preset }), out = { preset: r.preset };
  if (r.preset !== "Advanced") delete r.from;
  for (const k of KEYS) if (r[k] !== undefined && JSON.stringify(r[k]) !== JSON.stringify(base[k])) out[k] = r[k];
  return out;
}

/** Output and stage-1 sizes for a clay guide w×h (mirrors ltx_settings.stage_sizes). */
export function stageSizes(w, h, s) {
  const k = s.resolution / Math.max(1, Math.min(w, h));
  const snap = (v) => Math.max(64, Math.floor(v / 32) * 32);
  if (s.two_stage) { const a = [snap(w * k / 2), snap(h * k / 2)]; return { stage1: a, output: [a[0] * 2, a[1] * 2] }; }
  const a = [snap(w * k), snap(h * k)];
  return { stage1: a, output: a };
}

// Measured on the RTX 6000 Ada (48 GB), int8 distilled LTX-2.5 (share/Milestone18_Hollywood/REPORT.txt): seconds per
// step = a*T + b*T² (T = latent tokens in millions), ~70 s to stage the model per sampler, decode + save per Mpx.
export const CALIB = { a: 364, b: 15600, init: 70, fixed: 60, decode_per_mpx: 0.28 };

/** Rough render time in seconds for a final (warm GPU). Mirrors ltx_settings.estimate_seconds. */
export function estimateSeconds(s, w, h, frames, c = CALIB) {
  const sz = stageSizes(w, h, s), latF = Math.floor((frames - 1) / 8) + 1, g = s.cfg > 1 ? 2 : 1;
  const step = (wh) => { const t = Math.floor(wh[0] / 32) * Math.floor(wh[1] / 32) * latF / 1e6; return (c.a * t + c.b * t * t) * g; };
  let t = c.fixed + c.init + s.steps_1 * step(sz.stage1);
  if (s.two_stage) t += c.init + s.steps_2 * step(sz.output);
  t += sz.output[0] * sz.output[1] * frames / 1e6 * (s.temporal_x2 ? 2 : 1) * c.decode_per_mpx;
  return Math.round(t);
}

export function fmtTime(sec) {
  if (sec < 90) return `about ${Math.max(10, Math.round(sec / 10) * 10)} s`;
  const m = sec / 60;
  return m < 10 ? `about ${Math.round(m * 2) / 2} min`.replace(".0 ", " ") : `about ${Math.round(m)} min`;
}

/** The one-line summary under the quality buttons. */
export function summary(s, w, h, frames, fps = 24) {
  const sz = stageSizes(w, h, s);
  const steps = s.two_stage ? `${s.steps_1} + ${s.steps_2} steps` : `${s.steps_1} steps, one pass`;
  const outF = s.temporal_x2 ? frames * 2 - 1 : frames, outFps = (s.fps || fps) * (s.temporal_x2 ? 2 : 1);
  const codec = s.codec === "prores_hq" ? "ProRes 422 HQ + H.264" : `H.264 CRF ${s.crf}`;
  return `${s.preset}: ${sz.output[0]}×${sz.output[1]}, ${steps}, ${outF} frames at ${outFps} fps, ` +
    `${codec}. ${fmtTime(estimateSeconds(s, w, h, frames))} for the final on this GPU.`;
}

/** Per-shot settings store: {sid: {preset, ...overrides}} kept compact, saved through `save` on every change. */
export class LtxStore {
  constructor(byShot = {}, save = null) { this.byShot = { ...(byShot || {}) }; this.save = save; }
  saved(sid) { return this.byShot[sid] || { preset: DEFAULT_PRESET }; }
  settings(sid) { return resolveSettings(this.saved(sid)); }
  put(sid, s) { this.byShot[sid] = compactSettings(s); try { this.save?.(this.byShot); } catch { /* no store */ } return this.byShot[sid]; }
  /** Change settings. A quality knob (QUALITY_KEYS) edited on a Draft / Final shot makes it Advanced, with every other
   *  value carried over from that preset, so the picture only changes by what was edited; "Reset to Draft / Final" undoes it. */
  patch(sid, over) {
    const saved = this.saved(sid), cur = resolveSettings(saved);
    const moves = cur.preset !== "Advanced" && Object.keys(over || {}).some((k) => QUALITY_KEYS.includes(k) && JSON.stringify(over[k] ?? null) !== JSON.stringify(cur[k] ?? null));
    if (!moves) return this.put(sid, { ...saved, ...over });
    const full = {};
    for (const k of KEYS) if (cur[k] !== undefined && cur[k] !== null) full[k] = cur[k];
    return this.put(sid, { ...full, ...over, preset: "Advanced", from: cur.preset });
  }
  /** A preset click starts clean from that preset; the seed is kept (it is the take, not the quality). Advanced starts
   *  from Final's values and remembers where it came from (the "Reset to …" button). */
  setPreset(sid, q) {
    const saved = this.saved(sid), { seed, adherence } = saved, loras = resolveSettings(saved).loras;   // the take, the blocking and the add-ons are their own controls
    const keep = { ...(seed != null ? { seed } : {}), ...(adherence ? { adherence } : {}), ...(loras?.length ? { loras } : {}) };
    if (q === "Advanced") {
      const cur = resolveSettings(saved);
      return this.put(sid, { preset: "Advanced", from: cur.preset === "Advanced" ? cur.from : cur.preset, ...keep });
    }
    return this.put(sid, { preset: q, ...keep });
  }
  /** The hero recipe: Advanced with the retired Hollywood numbers (1408p, 12 + 6 steps, CRF 12). */
  setHero(sid) { this.setPreset(sid, "Advanced"); return this.put(sid, { ...this.saved(sid), ...HERO }); }
  /** Back to the preset an Advanced shot started from (or Draft / Final itself: clears the add-on overrides only). */
  reset(sid) { const s = resolveSettings(this.saved(sid)); return this.setPreset(sid, s.preset === "Advanced" ? s.from : s.preset); }
  /** Write a shot's settings into the App graph: the Quality node (preset + advanced JSON) and both samplers. */
  writeGraph(set, sid) {
    const s = this.settings(sid);
    set(9096, "quality", s.preset);
    set(9096, "advanced", JSON.stringify(compactSettings(s)));
    set(5516, "sampler_name", s.sampler);
    set(9034, "sampler_name", s.sampler);
    return s;
  }
}

// ------------------------------------------------------------------------------------------------ the UI
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [t, f] of Object.entries(v)) e.addEventListener(t, f);
    else if (k === "class") e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
};

const CSS = `
.ss-ltxadv { display:flex; flex-direction:column; gap:8px; font-size:12px; }
.ss-ltxadv .g { display:grid; grid-template-columns:minmax(110px, 40%) 1fr; gap:6px 10px; align-items:center; }
.ss-ltxadv .g > label { color:var(--ss-muted,#a9a3ad); }
.ss-ltxadv input[type=number] { width:84px; }
.ss-ltxadv input[type=text] { width:100%; }
.ss-ltxadv select, .ss-ltxadv input[type=number], .ss-ltxadv input[type=text] { background:#1a1420; color:inherit;
  border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:4px 6px; font:inherit; min-width:0; }
.ss-ltxadv h4 { margin:6px 0 0; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--ss-muted,#a9a3ad); }
.ss-ltxadv .note { color:var(--ss-muted,#a9a3ad); font-size:11px; line-height:1.35; }
.ss-ltxadv .est { font-weight:600; }
.ss-ltxadv .chg { color:#ffb340; }
`;

export class LtxAdvanced {
  /** pipe: the Pipeline (graph helpers set / w, ctx with stage and loadLtx / saveLtx). */
  constructor(pipe) {
    this.pipe = pipe;
    let saved = {};
    try { saved = pipe.ctx.loadLtx?.() || {}; } catch { /* no store */ }
    this.store = new LtxStore(saved, (v) => pipe.ctx.saveLtx?.(v));
    if (typeof document !== "undefined" && !document.getElementById("ss-ltxadv-css")) document.head.append(h("style", { id: "ss-ltxadv-css" }, CSS));
    this.seg = h("span", { class: "seg row" }, ...PRESET_NAMES.map((q) => h("button", { type: "button", "data-q": q, "aria-pressed": String(q === DEFAULT_PRESET),
      title: PRESETS[q].tip, on: { click: () => this.setPreset(q) } }, q)));
    this.btn = h("button", { type: "button", class: "ghost ss-ltxbtn", title: "Advanced (LTX): resolution, steps, shift, scheduler, sigmas, two-stage, temporal x2, CFG, seed, LoRAs, decode tiles, codec",
      "aria-expanded": "false", on: { click: () => this.toggle() } }, "Advanced (LTX)");
    this.panel = h("div", { class: "card ss-ltxadv", hidden: "" });
    this.pop = null;   // the canvas layout hands us a hudPop to live in
    this._build();
  }

  sid() { return this.pipe.ctx.stage.activeShot().id; }
  saved(sid = this.sid()) { return this.store.saved(sid); }
  settings(sid = this.sid()) { return this.store.settings(sid); }
  dims() {
    const st = this.pipe.ctx.stage, j = st.toJSON?.() || {};
    const w = st.fw || 960, hh = st.fh || 512;
    return { w, h: hh, frames: Math.max(9, j.shot?.frames || 97), fps: j.shot?.fps || 24 };
  }

  /** A quality button. Advanced also opens the settings (pre-filled from Final, or the shot's own numbers if it already is Advanced). */
  setPreset(q) {
    const was = this.settings().preset;
    if (!(q === "Advanced" && was === "Advanced")) this.store.setPreset(this.sid(), q);
    this.refresh(); this.apply(); this.pipe._motionNote?.();
    if (q === "Advanced") this.toggle(true);
  }
  /** The hero recipe (presets.json "Hero final"): Advanced with the retired Hollywood numbers. */
  setHero() { this.store.setHero(this.sid()); this.refresh(); this.apply(); this.pipe._motionNote?.(); }
  reset() { this.store.reset(this.sid()); this.refresh(); this.apply(); this.pipe._motionNote?.(); }
  patch(over) { this.store.patch(this.sid(), over); this.refresh(); this.apply(); this.pipe._motionNote?.(); }
  /** Write a shot's settings into the graph (the Quality node's advanced JSON + the samplers' combo). */
  apply(sid = this.sid()) { return this.store.writeGraph((id, k, v) => this.pipe.set(id, k, v), sid); }

  toggle(want) {
    if (this.pop && this.pop.el.isConnected) { const o = want ?? !this.pop.isOpen(); if (o) { for (const x of this.pipe._pops || []) if (x !== this.pop) x.close?.(); this.pop.open(); } else this.pop.close(); }
    else { const o = want ?? this.panel.hidden; this.panel.hidden = !o; }
    const open = this.pop?.el.isConnected ? this.pop.isOpen() : !this.panel.hidden;
    this.btn.setAttribute("aria-expanded", String(open));
    if (open) this.refresh();
  }

  /** Canvas layout: live inside a hudPop beside the panel. */
  usePop(pop, mover) {
    this.pop = pop;
    this.panel.hidden = false;
    if (mover) mover.move(this.panel, pop.body); else pop.body.append(this.panel);
    pop.onState = (o) => this.btn.setAttribute("aria-expanded", String(o));
  }

  _build() {
    const f = (this.f = {});
    const sel = (opts, on) => h("select", { on: { change: on } }, ...opts.map(([v, t]) => { const o = h("option", { value: String(v) }, t); return o; }));
    const n = (min, max, step, on) => h("input", { type: "number", min, max, step, on: { change: on } });
    const row = (label, ctl, tip) => [h("label", { title: tip || "" }, label), ctl];
    f.res = sel(RESOLUTIONS, () => this.patch({ resolution: +f.res.value }));
    f.two = h("input", { type: "checkbox", on: { change: () => this.patch({ two_stage: f.two.checked }) } });
    f.s1 = n(MIN_STEPS_1, 60, 1, () => this.patch({ steps_1: +f.s1.value }));
    f.s2 = n(1, 40, 1, () => this.patch({ steps_2: +f.s2.value }));
    f.s2start = sel([["0.909375", "0.909 (re-draws more detail)"], ["0.85", "0.85 (Lightricks' 2.5 default, keeps stage 1)"]],
      () => this.patch({ s2_start: +f.s2start.value }));
    f.sig1 = h("input", { type: "text", placeholder: "auto from steps (e.g. 1.0, 0.99375, …, 0.0)", on: { change: () => this.patch({ sigmas_1: f.sig1.value.trim() }) } });
    f.sig2 = h("input", { type: "text", placeholder: "auto from steps", on: { change: () => this.patch({ sigmas_2: f.sig2.value.trim() }) } });
    f.sampler = sel(SAMPLERS.map((x) => [x, x]), () => this.patch({ sampler: f.sampler.value }));
    f.sched = sel(SCHEDULERS, () => this.patch({ scheduler: f.sched.value }));
    f.shift = n(0.1, 10, 0.05, () => this.patch({ shift: +f.shift.value || 1 }));
    f.cfg = n(1, 10, 0.1, () => this.patch({ cfg: +f.cfg.value || 1 }));
    f.seed = n(0, 2 ** 48, 1, () => this.patch({ seed: Math.max(0, Math.round(+f.seed.value || 0)) }));
    f.seedNew = h("button", { type: "button", class: "ghost", title: "A new random seed: a different take with the same settings",
      on: { click: () => this.patch({ seed: Math.floor(Math.random() * 2 ** 31) }) } }, "New take");
    f.fps = sel([["", "The shot's rate"], ["24", "24"], ["25", "25"], ["30", "30"], ["48", "48"]], () => this.patch({ fps: f.fps.value ? +f.fps.value : null }));
    f.frames = h("span", { class: "note" });
    f.temporal = h("input", { type: "checkbox", on: { change: () => this.patch({ temporal_x2: f.temporal.checked }) } });
    f.ic = h("input", { type: "number", min: 0, max: 2, step: 0.05, placeholder: "auto", on: { change: () => this.patch({ ic_lora: f.ic.value === "" ? null : +f.ic.value }) } });
    f.blur = h("input", { type: "number", min: 0, max: 32, step: 1, placeholder: "auto", on: { change: () => this.patch({ guide_blur: f.blur.value === "" ? null : +f.blur.value }) } });
    f.ref = h("input", { type: "number", min: 0, max: 1, step: 0.05, placeholder: "auto", on: { change: () => this.patch({ reference: f.ref.value === "" ? null : +f.ref.value }) } });
    f.loras = createLoraStack({ h, min: -2, max: 2, fallback: 0.8, matchLabel: "LTX LoRAs", otherLabel: "Other LoRAs (may not work with LTX)",
      groups: (cur) => ltxLoraGroups(this._loraValues(), cur), warn: ltxLoraWarning,
      onChange: (rows) => this.patch({ loras: rows.length ? rows : null }) });
    f.decode = sel(DECODES.map(([k, t]) => [k, t]), () => this.patch({ decode: DECODES.find(([k]) => k === f.decode.value)?.[2] }));
    f.codec = sel(CODECS, () => this.patch({ codec: f.codec.value }));
    f.crf = n(0, 51, 1, () => this.patch({ crf: +f.crf.value }));
    f.est = h("div", { class: "note est" });
    f.base = h("div", { class: "note" });
    f.reset = h("button", { type: "button", class: "ghost", title: "Back to the preset this shot started from; the seed, Adherence and LoRAs stay", on: { click: () => this.reset() } }, "Reset to preset");
    this.panel.append(
      h("div", { class: "row" }, f.base, h("span", { style: "flex:1" }), f.reset),
      h("h4", {}, "Size and time"),
      h("div", { class: "g" }, ...row("Output resolution", f.res, "The final's shorter side. Two-stage renders stage 1 at half and upscales x2 in latent space."),
        ...row("Two-stage", h("label", { class: "row" }, f.two, "half-res render → learned x2 upscaler → refine (same seed)")),
        ...row("Frame rate", f.fps, "The clay animation is retimed to this rate."), ...row("Frames", f.frames),
        ...row("Temporal x2", h("label", { class: "row" }, f.temporal, "LTX-2.5 temporal upscaler: twice the frames (48 fps from 24)"))),
      h("h4", {}, "Sampling"),
      h("div", { class: "g" }, ...row("Steps, stage 1", f.s1, "Draft 8, Final 12. Below 8 the distilled curve is thinned (its nine tuned knots sampled evenly), which is untested on the GPU: use it for rough drafts. The Linear and Linear-quadratic schedulers take any count."),
        ...row("Steps, stage 2", f.s2, "The refine pass after the x2 latent upscale: Draft 3, Final 6."), ...row("Stage-2 start", f.s2start),
        ...row("Scheduler", f.sched, "The curve the step counts are spread on. Distilled = Lightricks' tuned knots (Draft and Final, bit for bit). Linear = even steps (what LTXVScheduler starts from). Linear-quadratic = LTX's paper schedule, finer steps near the end. Manual sigmas override it."),
        ...row("Shift", f.shift, "Sigma shift, the same curve as ModelSamplingLTXV / LTXVScheduler's shift (this graph feeds sigmas directly, so it is applied to the schedule). 1 = as tuned. Above 1 spends more steps at high noise (composition, motion), below 1 more on fine detail. Stage 2 keeps its start sigma."),
        ...row("Sigmas 1 (manual)", f.sig1, "Overrides the steps, scheduler and shift. Comma-separated, descending, ending at 0."), ...row("Sigmas 2 (manual)", f.sig2),
        ...row("Sampler", f.sampler), ...row("CFG", f.cfg, "LTX-2.5 here is the distilled model: CFG 1 is its tuned setting. Above 1 doubles the time and uses the negative prompt."),
        ...row("Seed", h("span", { class: "row" }, f.seed, f.seedNew), "The same seed is used in both stages (refinement, not a new take).")),
      h("div", { class: "note" }, "STG and CFG rescale need the non-distilled LTX-2.5 dev model, which is not installed here (see MODELS.md); the distilled model has guidance baked in."),
      h("h4", {}, "Blocking (Adherence)"),
      h("div", { class: "g" }, ...row("Layout IC-LoRA", f.ic, "How literally LTX follows the clay animation. Empty = from Adherence (Exact 1.0, Balanced 0.92, Loose 0.825). Above 1.1 tested no tighter."),
        ...row("Clay guide blur (px)", f.blur, "Softens the clay guide so LTX redraws limbs and gait. 0 = sharp. Empty = from Adherence (Exact 0, Balanced 6, Loose 10)."),
        ...row("Frame reference", f.ref, "How strongly your chosen frame steers the look. 1 also pulls the composition toward the frame (the opening can start off its marks); lower lets the clay win. Below 0.4 the render turns clay-grey. Empty = from Adherence (Exact 0.5).")),
      h("h4", {}, "LoRAs (your stack, applied in order)"),
      h("div", { class: "note" }, "Style, character or detail add-ons on the video model. The Layout IC-LoRA above is separate: Adherence sets it."),
      f.loras.el,
      h("h4", {}, "Decode and output"),
      h("div", { class: "g" }, ...row("VAE decode tiles", f.decode), ...row("Codec", f.codec), ...row("H.264 CRF", f.crf, "Lower = better and bigger. 14 is visually lossless for these renders; 18 was the old default.")),
      f.est);
  }

  /** Every LoRA the server has (node 9101's lora_name list). */
  _loraValues() {
    const w = this.pipe.w(9101, "lora_name");
    return Array.isArray(w?.options?.values) ? w.options.values.filter((x) => typeof x === "string") : [];
  }

  /** A workflow without the slot (the lean Soundstage_App.json) says so instead of offering a list that can only say None. */
  _loraOptions() {
    const f = this.f, w = this.pipe.w(9101, "lora_name");
    const sig = `${!!w}|${this._loraValues().length}`;
    if (sig === this._loraSig) return;
    this._loraSig = sig;
    f.loras.setDisabled(!w, w ? "" : "This workflow has no LoRA slot: open Soundstage_App_Full (the full App) to add LoRAs.");
  }

  refresh() {
    const s = this.settings(), sv = this.saved(), f = this.f, d = this.dims();
    for (const b of this.seg.children) b.setAttribute("aria-pressed", String(b.dataset.q === s.preset));
    for (const b of this.seg.children) b.title = `${PRESETS[b.dataset.q].tip} ${fmtTime(estimateSeconds(resolveSettings({ preset: b.dataset.q }), d.w, d.h, d.frames))} here.`;
    if (!f.res.querySelector(`option[value="${s.resolution}"]`)) f.res.append(h("option", { value: String(s.resolution) }, `${s.resolution}p`));
    f.res.value = String(s.resolution);
    f.two.checked = s.two_stage;
    f.s1.value = String(s.steps_1); f.s2.value = String(s.steps_2); f.s2.disabled = f.s2start.disabled = f.sig2.disabled = !s.two_stage;
    f.s2start.value = Math.abs(s.s2_start - 0.85) < 1e-6 ? "0.85" : "0.909375";
    f.sig1.value = s.sigmas_1 || ""; f.sig2.value = s.sigmas_2 || "";
    f.sampler.value = s.sampler; f.sched.value = s.scheduler; f.shift.value = String(s.shift); f.cfg.value = String(s.cfg); f.seed.value = String(s.seed ?? 42);
    f.fps.value = s.fps ? String(s.fps) : "";
    const fps = s.fps || d.fps, fr = Math.max(9, Math.floor(((d.frames - 1) / d.fps * fps) / 8) * 8 + 1);
    f.frames.textContent = `${s.temporal_x2 ? fr * 2 - 1 : fr} (${((d.frames - 1) / d.fps).toFixed(1)} s from the shot's timeline)`;
    f.temporal.checked = s.temporal_x2;
    f.ic.value = s.ic_lora == null ? "" : String(s.ic_lora);
    f.blur.value = s.guide_blur == null ? "" : String(s.guide_blur);
    f.ref.value = s.reference == null ? "" : String(s.reference);
    const ak = adherenceKnobs(s);
    f.ic.placeholder = `auto (${ak.ic_lora})`; f.blur.placeholder = `auto (${ak.guide_blur})`; f.ref.placeholder = `auto (${ak.reference})`;
    this._loraOptions();
    if (JSON.stringify(f.loras.get()) !== JSON.stringify(s.loras || [])) f.loras.set(s.loras || []);   // a shot switch or a migrated save
    const dk = DECODES.find(([, , v]) => JSON.stringify(v) === JSON.stringify(s.decode))?.[0];
    if (dk) f.decode.value = dk;
    f.codec.value = s.codec; f.crf.value = String(s.crf);
    const changed = Object.keys(compactSettings(sv)).filter((k) => !["preset", "from"].includes(k));
    f.base.textContent = s.preset === "Advanced" ? (changed.length ? `Advanced (from ${s.from}), changed: ${changed.join(", ")}` : `Advanced: Final's numbers, yours to change`)
      : changed.length ? `${s.preset} preset, changed: ${changed.join(", ")}` : `${s.preset} preset, as tuned`;
    f.base.classList.toggle("chg", changed.length > 0);
    f.reset.textContent = s.preset === "Advanced" ? `Reset to ${s.from}` : "Reset to preset";
    f.est.textContent = summary(s, d.w, d.h, d.frames, d.fps);
    this.btn.textContent = changed.length ? "Advanced (LTX) •" : "Advanced (LTX)";
  }
}
