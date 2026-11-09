// The render-time estimator (Mike 2026-11-08: "make the time-left an actual ESTIMATE from previous runs and the job's
// size, not just a per-kind average"). Pure math, no DOM; activity.mjs feeds it and the top countdown shows it.
//
// What it learns, per machine (GPU) + model + kind + resolution bucket, from this machine's own finished runs:
//   ms per sampler step per stage (stage 1, stage 2 ...), per unit of work u = megapixels x frames x generations
//   model load time, cold (loaders actually ran) and warm (loaders cached by ComfyUI)
//   VAE decode ms per u, and the rest (fixed overheads: encoders, saves, setup) in ms
//   how far off its own predictions were (a rolling relative error), which becomes the "±"
// Before a job starts: total = load (cold or warm) + sum(steps x ms/step/u x u) + decode/u x u + overhead, from the
// queued graph's own step counts, size, frames and batch. While it runs: refined from ComfyUI's progress (the node it is
// on, step i/N, this run's measured ms per step), so the countdown converges. With no history at all: a seed from the
// repo's docs ("rough first guess", ±50 %), scaled by the job's size.
//
//   jobShape(apiPrompt)                 -> { model, width, height, frames, batch, stages:[{id, steps}], decodeIds, loaderIds }
//   new Estimator({ storage, machine })  .predict(shape, kind, { warm })   .live(pred, progress)   .learn(shape, kind, measured)
//   sureText(est)                       -> "about · ±0:40" / "±1:10 · from 2 runs" / "rough first guess · ±2:30"
//   machineName(api)                    one GET /system_stats at start: the GPU's name keys the book

export const EST_KEY = "ss_estimator_v1";
const ALPHA = 0.35;              // weight of the newest run in the rolling averages
const MAX_ENTRIES = 80;

// Sampler / loader / decode node types (the same families as activity.mjs's STAGES table).
const SAMPLER = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced|SamplerDPMPP\w*|LTXVSampler\w*|SoundstageGenerateVideo)$/;
const LOADER = /^(UNETLoader|CheckpointLoader\w*|CLIPLoader|DualCLIPLoader|TripleCLIPLoader|CLIPVisionLoader|VAELoader|LoraLoader\w*|LTXICLoRALoader\w*|SoundstageLTXLoRA|LatentUpscaleModelLoader|UpscaleModelLoader|LoadDA3Model|SAM3DBody_Loader|\w+ModelLoader|\w+Loader)$/;
const DECODE = /^(VAEDecode\w*|LTXVTiledVAEDecode|LTXVSpatioTemporalTiledVAEDecode|LTXVAudioVAEDecode)$/;
const LATENT = /^(EmptyLTXVLatentVideo|EmptyLatentImage|EmptySD3LatentImage|EmptyHunyuanLatent\w*|LTXVImgToVideo\w*|SoundstageGenerateVideo|SoundstageGenerateImage)$/;
const MODEL_LOADER = /^(UNETLoader|CheckpointLoader\w*|SoundstageGenerateVideo|SoundstageGenerateImage)$/;

export const isSampler = (ct) => SAMPLER.test(String(ct || ""));
export const isLoader = (ct) => LOADER.test(String(ct || ""));
export const isDecode = (ct) => DECODE.test(String(ct || ""));

// First guesses from the repo's docs, for a job of `u` units (docs/QUICKSTART.md, docs/TUTORIAL.md, docs/recast.md,
// docs/loop.md): Draft 1984x1088, 5 s at 24 fps (u ≈ 261) "about 3 min" to "6–7 min"; Final "about 13 min" / "8–9 min";
// a ④ Frame at Fast about 1 min an image; Recast final 13.5 min; Video → 3D's two jobs about 4 min.
export const SEEDS = {
  draft: { ms: 5 * 60_000, u: 261 }, final: { ms: 11 * 60_000, u: 261 }, hollywood: { ms: 20 * 60_000, u: 261 },
  frame: { ms: 60_000, u: 1.3 }, layers: { ms: 3 * 60_000, u: 261 }, video3d: { ms: 4 * 60_000, u: null },
  interp: { ms: 60_000, u: null }, oneclick: { ms: 6 * 60_000, u: null }, performance: { ms: 4 * 60_000, u: null },
  voice: { ms: 60_000, u: null }, cut: { ms: 2 * 60_000, u: null }, other: null,
};

// ---- The job's shape, from the API-format prompt it was queued with.
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** A node input as a number: a literal, or a link to a primitive (PrimitiveInt, PrimitiveNode...) holding one. */
function valueOf(prompt, v, depth = 0) {
  const n = num(v);
  if (n != null) return n;
  if (Array.isArray(v) && v.length === 2 && prompt[v[0]] && depth < 3) {
    const src = prompt[v[0]];
    for (const k of ["value", "int", "number", "Number", "steps"]) { const x = valueOf(prompt, src.inputs?.[k], depth + 1); if (x != null) return x; }
  }
  return null;
}

function stepsOf(prompt, node) {
  const i = node.inputs || {};
  let s = valueOf(prompt, i.steps);
  const a = valueOf(prompt, i.start_at_step), b = valueOf(prompt, i.end_at_step);
  if (s != null && a != null && b != null && b > a && b - a < s) s = b - a;
  if (s != null) return s;
  // SamplerCustom*: the steps live on the sigmas' scheduler (BasicScheduler, LTXVScheduler ...) or a ManualSigmas list.
  for (const key of ["sigmas", "guider"]) {
    const link = i[key];
    if (!Array.isArray(link) || !prompt[link[0]]) continue;
    const src = prompt[link[0]];
    const st = valueOf(prompt, src.inputs?.steps);
    if (st != null) return st;
    if (typeof src.inputs?.sigmas === "string") { const k = src.inputs.sigmas.split(/[\s,]+/).filter((x) => x !== "" && Number.isFinite(Number(x))).length; if (k > 1) return k - 1; }
  }
  return null;
}

/** Every node a node depends on (ids), following input links. */
function ancestors(prompt, id, seen = new Set()) {
  for (const v of Object.values(prompt[id]?.inputs || {})) {
    if (Array.isArray(v) && v.length === 2 && prompt[v[0]] && !seen.has(String(v[0]))) { seen.add(String(v[0])); ancestors(prompt, String(v[0]), seen); }
  }
  return seen;
}

const baseName = (s) => String(s || "").split(/[\\/]/).pop().replace(/\.(safetensors|gguf|ckpt|pt|pth|bin)$/i, "").slice(0, 60);

export function jobShape(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  const ids = Object.keys(prompt).filter((id) => typeof prompt[id]?.class_type === "string");
  if (!ids.length) return null;
  const samplerIds = ids.filter((id) => SAMPLER.test(prompt[id].class_type));
  // Stage order: a sampler that depends on another runs after it.
  const depth = new Map(samplerIds.map((id) => { const a = ancestors(prompt, id); return [id, samplerIds.filter((o) => o !== id && a.has(o)).length]; }));
  const stages = samplerIds.sort((x, y) => depth.get(x) - depth.get(y) || Number(x) - Number(y))
    .map((id) => ({ id, steps: stepsOf(prompt, prompt[id]) }));
  let width = null, height = null, frames = null, batch = null, area = 0;
  for (const id of ids) {
    const n = prompt[id], i = n.inputs || {};
    const w = valueOf(prompt, i.width), h = valueOf(prompt, i.height);
    if (w == null || h == null) continue;
    const pref = LATENT.test(n.class_type) ? 1e12 : 0;   // the latent's own size wins over any other width/height
    if (pref + w * h <= area) continue;
    area = pref + w * h;
    width = w; height = h;
    frames = valueOf(prompt, i.length ?? i.frames ?? i.num_frames ?? i.frame_count);
    batch = valueOf(prompt, i.batch_size ?? i.variations ?? i.count);
  }
  let model = null;
  for (const id of ids) {
    const n = prompt[id];
    if (!MODEL_LOADER.test(n.class_type)) continue;
    const name = n.inputs?.unet_name ?? n.inputs?.ckpt_name ?? n.inputs?.model ?? n.inputs?.model_name;
    if (typeof name === "string" && name) { model = baseName(name); break; }
  }
  for (const id of ids) {   // no main model loader: the first loader's file names the job's model
    if (model) break;
    if (!/Loader$/.test(prompt[id].class_type)) continue;
    const f = Object.values(prompt[id].inputs || {}).find((v) => typeof v === "string" && /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i.test(v));
    if (f) model = baseName(f);
  }
  return { model, width, height, frames, batch, stages,
    decodeIds: ids.filter((id) => DECODE.test(prompt[id].class_type)), loaderIds: ids.filter((id) => LOADER.test(prompt[id].class_type)) };
}

/** Units of work: megapixels x frames x generations (1 when the size is unknown). */
export function unitsOf(shape, fallback = {}) {
  const w = shape?.width ?? fallback.width, h = shape?.height ?? fallback.height;
  const mp = w && h ? (w * h) / 1e6 : null;
  if (mp == null) return null;
  return mp * Math.max(1, shape?.frames || 1) * Math.max(1, shape?.batch || 1);
}

export function resBucket(w, h) {
  const px = (Number(w) || 0) * (Number(h) || 0);
  return !px ? "any" : px <= 640 * 360 ? "sd" : px <= 1280 * 720 ? "hd" : px <= 1920 * 1088 ? "fhd" : "uhd";
}

// ---- Words for how sure it is.
const mss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
};

/** "about · ±0:40" (3+ runs) / "±1:10 · from 2 runs" / "rough first guess · ±2:30" (no runs here yet). */
export function sureText(e) {
  if (!e || e.ms == null) return "";
  const pm = e.pm != null && e.pm >= 1000 ? ` ±${mss(e.pm)}` : "";
  if (e.sure === "rough") return `rough first guess ·${pm || " ±50%"}`;
  if (e.sure === "range") return `${pm.trim() || "±"} · from ${e.runs} run${e.runs === 1 ? "" : "s"}`;
  return `about${pm}`;
}

// ---- The book.
const ewma = (prev, x, n) => (prev == null || !n ? x : prev * (1 - ALPHA) + x * ALPHA);

export class Estimator {
  constructor({ storage = safeStorage(), key = EST_KEY, machine = "this machine" } = {}) {
    this.storage = storage;
    this.key = key;
    this.machine = machine;
    this.book = {};
    this.lastModel = null;   // the model of the last finished job here: loaded and warm, unless the server unloaded it
    try { const j = JSON.parse(storage?.getItem(key) || "{}"); if (j && typeof j === "object") this.book = j; } catch { this.book = {}; }
  }

  keyOf(shape, kind, fb = {}) {
    return `${this.machine}|${shape?.model || "?"}|${kind}|${resBucket(shape?.width ?? fb.width, shape?.height ?? fb.height)}`;
  }

  save() {
    const keys = Object.keys(this.book);
    if (keys.length > MAX_ENTRIES) for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.book[k];
    try { this.storage?.setItem(this.key, JSON.stringify(this.book)); } catch { /* storage blocked: this page only */ }
  }

  /** Total and phases for a job before it starts. null when there is nothing to go on (no history, no seed). */
  predict(shape, kind, { warm = null, width = null, height = null } = {}) {
    const fb = { width, height };
    const u = unitsOf(shape, fb);
    const e = this.book[this.keyOf(shape, kind, fb)];
    const isWarm = warm != null ? !!warm : !!(shape?.model && this.lastModel === shape.model);
    if (e && e.n && u != null && Array.isArray(e.step) && e.step.length) {
      const load = isWarm ? (e.loadWarm ?? (e.loadCold != null ? e.loadCold * 0.1 : 0)) : (e.loadCold ?? e.loadWarm ?? 0);
      const stages = (shape?.stages?.length ? shape.stages : e.step.map(() => ({ steps: null }))).map((s, i) => {
        const per = (e.step[i] ?? e.step[e.step.length - 1]) * u;
        const steps = s.steps ?? e.steps?.[i] ?? 8;
        return { steps, msPerStep: per, ms: steps * per };
      });
      const decode = (e.decode ?? 0) * u;
      const other = e.other ?? 0;
      const ms = load + stages.reduce((a, s) => a + s.ms, 0) + decode + other;
      const err = e.err ?? (e.n >= 3 ? 0.15 : 0.3);
      return { ms, pm: ms * Math.max(0.08, err), sure: e.n >= 3 ? "about" : "range", runs: e.n, warm: isWarm, u,
        phases: { load, stages, decode, other } };
    }
    // Same kind on this machine at any size or model: its rate per unit (or its plain average).
    const kindKey = `${this.machine}|*|${kind}`;
    const k = this.book[kindKey];
    if (k && k.n) {
      const ms = u != null && k.perU ? k.perU * u : k.ms;
      return { ms, pm: ms * Math.max(0.15, k.err ?? 0.35), sure: "range", runs: k.n, warm: isWarm, u, phases: null };
    }
    const seed = SEEDS[kind];
    if (!seed) return null;
    const scale = seed.u && u != null ? Math.max(0.25, Math.min(4, u / seed.u)) : 1;
    const ms = seed.ms * scale;
    return { ms, pm: ms * 0.5, sure: "rough", runs: 0, warm: isWarm, u, phases: null };
  }

  /** Time left while it runs, refined from the progress we see. progress: { elapsedMs, phase: "load"|"sample"|"decode"|
   *  "other"|null, stage (index into the stages), step, steps, liveStepMs (this run's measured ms per step, or null),
   *  phaseElapsedMs, stagesDone }. Returns { ms, pm, sure, runs, over }. */
  live(pred, p) {
    if (!pred) return null;
    const el = p.elapsedMs || 0;
    const ph = pred.phases;
    let ms;
    if (!ph) {
      // No phase model (seed or kind average): time-based, unless a sampler's live rate says more is left.
      ms = pred.ms - el;
      if (p.phase === "sample" && p.liveStepMs && p.steps) ms = Math.max(ms, (p.steps - p.step) * p.liveStepMs);
    } else {
      const st = ph.stages;
      const cur = p.phase === "sample" && st[p.stage] ? st[p.stage] : null;
      // This run's speed against the book's, from the sampler running now (two or more steps in), clamped.
      const speed = cur && p.liveStepMs && cur.msPerStep > 0 ? Math.max(0.33, Math.min(3, p.liveStepMs / cur.msPerStep)) : (p.speed || 1);
      const done = Math.max(0, p.stagesDone || 0);
      if (p.phase === "load" || p.phase == null && done === 0) {
        const loadLeft = Math.max(ph.load * 0.1, ph.load - (p.phaseElapsedMs || 0), 0);
        ms = loadLeft + st.reduce((a, s) => a + s.ms, 0) + ph.decode + ph.other * 0.8;
      } else if (cur) {
        const per = p.liveStepMs || cur.msPerStep * speed;
        ms = Math.max(0, (p.steps ?? cur.steps) - (p.step ?? 0)) * per;
        for (let i = p.stage + 1; i < st.length; i++) ms += st[i].ms * speed;
        ms += ph.decode * speed + ph.other * 0.4;
      } else if (p.phase === "decode") {
        ms = Math.max(0, ph.decode * speed - (p.phaseElapsedMs || 0)) + ph.other * 0.3;
      } else {
        // between stages, or the tail (saving, encoders): what the stages not yet run cost, plus a share of the overhead.
        ms = 0;
        for (let i = done; i < st.length; i++) ms += st[i].ms * speed;
        ms += (done < st.length ? ph.decode * speed : 0) + Math.max(0, ph.other * (done < st.length ? 0.6 : 0.3) - (p.phaseElapsedMs || 0));
      }
    }
    ms = Math.max(1000, Math.round(ms));
    // The ± shrinks with what is left.
    const rel = pred.ms > 0 ? pred.pm / pred.ms : 0.5;
    return { ms, pm: Math.round(ms * rel), sure: pred.sure, runs: pred.runs, over: el > pred.ms };
  }

  /** A finished run: measured { totalMs, loadMs, cold, stages:[{steps, ms}], decodeMs }, and what was predicted. */
  learn(shape, kind, m, predictedMs = null, fb = {}) {
    if (!m || !Number.isFinite(m.totalMs) || m.totalMs <= 0) return;
    const u = unitsOf(shape, fb);
    const key = this.keyOf(shape, kind, fb);
    const e = this.book[key] || { n: 0 };
    if (u != null && m.stages?.length) {
      e.step = e.step || [];
      e.steps = e.steps || [];
      m.stages.forEach((s, i) => {
        if (!(s.steps > 0) || !(s.ms > 0)) return;
        e.step[i] = ewma(e.step[i], s.ms / s.steps / u, e.n);
        e.steps[i] = s.steps;
      });
      if (m.decodeMs > 0) e.decode = ewma(e.decode, m.decodeMs / u, e.n);
    }
    if (m.loadMs != null) {
      if (m.cold) { e.loadCold = ewma(e.loadCold, m.loadMs, e.nc); e.nc = (e.nc || 0) + 1; }
      else { e.loadWarm = ewma(e.loadWarm, m.loadMs, e.nw); e.nw = (e.nw || 0) + 1; }
    }
    const sampled = (m.stages || []).reduce((a, s) => a + (s.ms || 0), 0);
    const other = Math.max(0, m.totalMs - (m.loadMs || 0) - sampled - (m.decodeMs || 0));
    e.other = ewma(e.other, other, e.n);
    if (predictedMs > 0) e.err = ewma(e.err, Math.min(1, Math.abs(m.totalMs - predictedMs) / predictedMs), e.n);
    e.n += 1;
    this.book[key] = e;
    const kk = `${this.machine}|*|${kind}`;
    const k = this.book[kk] || { n: 0 };
    k.ms = ewma(k.ms, m.totalMs, k.n);
    if (u != null) k.perU = ewma(k.perU, m.totalMs / u, k.n);
    if (predictedMs > 0) k.err = ewma(k.err, Math.min(1, Math.abs(m.totalMs - predictedMs) / predictedMs), k.n);
    k.n += 1;
    this.book[kk] = k;
    if (shape?.model) this.lastModel = shape.model;
    this.save();
  }
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** The GPU's name, once, so the book is per machine ("NVIDIA GeForce RTX 5090"). Quiet failure: "this machine". */
export async function machineName(api) {
  try {
    const r = await api.fetchApi("/system_stats");
    if (!r || (r.status && r.status !== 200)) return null;
    const j = await r.json();
    const d = j?.devices?.[0];
    return d?.name ? String(d.name).replace(/^cuda:\d+\s*/, "").slice(0, 60) : null;
  } catch { return null; }
}
