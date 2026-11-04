// Activity: every job on the shared GPU queue in one place (Mike 2026-11-03: "we should see all the tasks being done, how
// long they've been going, when they'll be completed, and what's coming up next"), and for your own running job, which
// node it is on (Mike 2026-11-02: "oh, it's going through the KSampler now, or it's doing the depth map now").
//
// Four sources, none of them heavy:
//   - ComfyUI's websocket events for the jobs this browser queued: execution_start, execution_cached, executing (its
//     detail is the bare node id in the ComfyUI frontend, not an object), progress (sampler steps), progress_state
//     (newer ComfyUI: every node's state), executed, execution_success, execution_error, execution_interrupted, and
//     status (its detail is {exec_info:{queue_remaining}}).
//   - Each prompt this page POSTs to /prompt (seen once, at queue time, in api.fetchApi): node id -> class_type and
//     title, so a node id from the events reads "Sampling: stage 1" or "Depth map".
//   - GET /soundstage/queue_summary (web/ui/queue.mjs) for who is queued and in what order, every session's jobs, with a
//     short label and the client id. Never the full GET /queue or GET /history: a job of ours that leaves the queue
//     without an event is looked up by its own GET /history/{prompt_id}.
//   - The App's own job registry: any part of the App names a job it queued with
//       window.dispatchEvent(new CustomEvent("soundstage:job", { detail: { prompt_id, name, kind, trigger, width, height } }))
//     or registry.note(prompt_id, {...}); a job nobody names keeps the server's label.
//
//   const reg = new ActivityRegistry({ clientId })     reg.onEvent(type, detail)  reg.applySummary(summary)
//   reg.graph(prompt_id, apiPrompt)                    reg.applyHistory(prompt_id, historyEntry | null)
//   reg.view(now) -> { running:[], queued:[], finished:[], totals:{ running, queued, etaMs, etaPartial } }
//   stageOf(classType, ...) / graphOf(apiPrompt)       the node -> stage name table
//   pillText(totals, running0)  -> "Sampling: stage 1 · 12/18 · 2 queued · ~6 min"
//   renderPanel(view, { onCancel, raw, open })        -> the panel's DOM
//   mountActivity({ api, row, before, theme })        -> the top-row pill and its panel, wired to the live App
import { openPopover, closePopover, isPopoverOpen } from "./popover.mjs";
import { queueSummary } from "./queue.mjs";
import { timerModel, queueLine, loadSound, saveSound, cuesFor, FinishWatcher, playChime } from "./jobTimer.mjs";

export const JOB_EVENT = "soundstage:job";
export const ETA_KEY = "ss_activity_eta";
export const RAW_KEY = "ss_activity_raw";   // "Node types" in Details: raw class_type and node id instead of plain names
const FINISHED_KEEP = 12;            // finished / failed jobs kept in the panel
const ETA_ALPHA = 0.3;               // rolling average weight of the newest run
const DETAIL_KEEP = 60;              // node lines kept per job in Details

// ---- Job kinds: a plain name, and the key the ETA book averages by. Matched on the App's name or the server label.
export const KINDS = [
  ["hollywood", /hollywood/i, "Hollywood render"],
  ["final", /\bfinal\b/i, "Final render"],
  ["draft", /\bdraft\b/i, "Draft render"],
  ["interp", /interpolat|\brife\b|film fps/i, "Frame interpolation"],
  ["frame", /\bframe\b|④/i, "Frame"],
  ["layers", /\blayers?\b/i, "Layers"],
  ["performance", /performance|real read|perf read/i, "Real performance read"],
  ["voice", /voice|\brvc\b|seed-?vc/i, "Voice conversion"],
  ["video3d", /video\s*(→|->|to)\s*3d|\bv2s\b|sam ?3d|\btrack(ing)?\b/i, "Video → 3D"],
  ["oneclick", /one-?click|\bloop\b|reshoot/i, "One-click job"],
  ["bake", /\bbake/i, "Bake"],
  ["cut", /\bcut\b|export|conform|assemble/i, "Cut render"],
  ["takecheck", /take ?check|realism|judge/i, "Take check"],
  ["model", /model call/i, "Model call"],
  ["stage", /\bstage\b/i, "Stage"],
];

export function kindOf(text) {
  const t = String(text || "");
  for (const [k, re] of KINDS) if (re.test(t)) return k;
  return "other";
}

export function kindName(kind) {
  return KINDS.find(([k]) => k === kind)?.[2] || "Render";
}

/** The ETA book's key: the kind plus a coarse resolution bucket (a 4K Final is not a 720p Final). */
export function etaKey(kind, width = 0, height = 0) {
  const px = (Number(width) || 0) * (Number(height) || 0);
  const res = !px ? "any" : px <= 640 * 360 ? "sd" : px <= 1280 * 720 ? "hd" : px <= 1920 * 1080 ? "fhd" : "uhd";
  return `${kind}@${res}`;
}

// ---- Stage names: what a node does, in words, from its class_type. The first match wins; `role` drives the stage
// counter (samplers and latent upscalers) and the inner step bar. Anything not listed shows its class_type.
export const STAGES = [
  [/^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced|SamplerDPMPP\w*|LTXVSampler\w*|SoundstageGenerateVideo)$/, "Sampling", "sampler"],
  [/^(LTXVLatentUpsampler|LatentUpscale|LatentUpscaleBy|LatentUpscaleModel\w*Apply)$/, "Upscaling", "upscale"],
  [/^(ImageUpscaleWithModel|ImageScaleBy|ImageScale|UpscaleModel\w*)$/, "Upscaling the image", ""],
  [/^(TextGenerateLTX2Prompt|GemmaAPITextEncode|Gemma\w*TextEncode\w*|LTXV?GemmaEnhance\w*)$/, "Encoding prompt (Gemma)", ""],
  [/^(CLIPTextEncode\w*|TextEncode\w*|T5TextEncode\w*)$/, "Encoding prompt", ""],
  [/^TextGenerate$/, "Model call (text)", ""],
  [/^(LTXVConditioning|ConditioningCombine|ConditioningSetArea\w*|CFGGuider|BasicGuider)$/, "Conditioning", ""],
  [/^(DA3Inference|DepthAnything\w*|MiDaS\w*|Zoe\w*|\w*DepthMap\w*|\w*Depth(Estimat\w*|Preprocessor))$/, "Depth map", ""],
  [/^(DWPreprocessor|DWPose\w*|OpenposePreprocessor|SoundstagePoseFollow)$/, "Pose (DWPose)", ""],
  [/^(CannyEdgePreprocessor|Canny)$/, "Edges (Canny)", ""],
  [/^(SAM3Segment|SAM3_Detect|SAM2?\w*Segment\w*|GroundingDino\w*)$/, "Masking (SAM 3)", ""],
  [/^SAM3DBody_\w+$/, "Body tracking (SAM 3D Body)", ""],
  [/^(RMBG|RemoveBackground|LoadBackgroundRemovalModel|SoundstageMatte|SoundstageActorMatte)$/, "Matte (background removal)", ""],
  [/^(VAEDecodeTiled|LTXVTiledVAEDecode|LTXVSpatioTemporalTiledVAEDecode)$/, "Decoding video (VAE)", ""],
  [/^(LTXVAudioVAEDecode|VAEDecodeAudio)$/, "Decoding audio (VAE)", ""],
  [/^VAEDecode\w*$/, "Decoding (VAE)", ""],
  [/^(VAEEncodeAudio|LTXVAudioVAEEncode)$/, "Encoding audio (VAE)", ""],
  [/^VAEEncode\w*$/, "Encoding (VAE)", ""],
  [/^(Krea2Control\w*)$/, "Control (Krea 2)", ""],
  [/^(LTXVImgToVideo\w*|LTXAddVideoICLoRAGuide|LTXVAddGuide\w*|LTXVCropGuides)$/, "Guides (LTX)", ""],
  [/^(EmptyLTXVLatentVideo|EmptyLatentImage|EmptySD3LatentImage|LTXVEmptyLatentAudio|EmptyHunyuanLatent\w*)$/, "Empty latent", ""],
  [/^(UNETLoader|CheckpointLoader\w*|CLIPLoader|DualCLIPLoader|TripleCLIPLoader|CLIPVisionLoader|VAELoader|LoraLoader\w*|LTXICLoRALoader\w*|SoundstageLTXLoRA|LatentUpscaleModelLoader|UpscaleModelLoader|LoadDA3Model|SAM3DBody_Loader|\w+ModelLoader|\w+Loader)$/, "Loading model", ""],
  [/^(LoadImage\w*|LoadVideo|VHS_LoadVideo\w*|SoundstageClipLoad|SoundstageImageLoad|LoadAudio)$/, "Loading input", ""],
  [/^(RIFE\w*|FILM\w*|\w*Interpolat\w*)$/, "Frame interpolation", ""],
  [/^(SaveVideo|SoundstageSaveVideo|VHS_VideoCombine)$/, "Saving MP4", ""],
  [/^CreateVideo$/, "Assembling video", ""],
  [/^(SaveImage|SaveAnimatedWEBP|SaveAnimatedPNG)$/, "Saving image", ""],
  [/^(SaveAudio\w*)$/, "Saving audio", ""],
  [/^(SaveGLB|SplatToFile3D|SoundstageDA3Export)$/, "Saving 3D", ""],
  [/^(PreviewImage|PreviewAny|PreviewAudio)$/, "Preview", ""],
  [/^SoundstageStage$/, "3D stage (clay passes)", ""],
  [/^SoundstageLook$/, "Look", ""],
  [/^SoundstageEditImage$/, "Editing the image", ""],
  [/^(SoundstageGenerateImage|SoundstageCanvasImage)$/, "Generating the image", ""],
  [/^(SoundstageShotSound|SoundstageSFX|SoundstageDialogue|SoundstageAudioFit)$/, "Sound", ""],
  [/^SoundstageAudioQC$/, "Sound check", ""],
  [/^SoundstageLayerPack\w*$/, "Layer pack", ""],
  [/^SoundstageFrameCheck$/, "Frame check", ""],
  [/^SoundstageChatterboxVC$/, "Voice conversion", ""],
  [/^SoundstagePerformance\w*$/, "Performance read", ""],
  [/^SoundstageRecast\w*$/, "Recast", ""],
  [/^(SoundstageCleanPlate|SoundstageFill|SoundstagePadForFill)$/, "Clean plate", ""],
  [/^SoundstageMocap$/, "Motion capture", ""],
  [/^(DA3GeometryToMesh|SplatToMesh|DecimateMesh|TripoSplat\w*|VAEDecodeTripoSplat)$/, "Building 3D", ""],
  [/^(SoundstageStep|SoundstageGate|SoundstageWhen|SoundstageQuality|SoundstageMatchSize|ComfySwitchNode|ComfyNotNode|ComfyMathExpression|StringContains|StringConcatenate|LTXFloatToInt|Primitive\w*|GetImageSize|GetVideoComponents|Reroute|KSamplerSelect|ManualSigmas|RandomNoise|\w*Scheduler)$/, "Setup", ""],
];

/** {name, role} for a class_type ("" role for most). Unknown class types keep their class_type as the name. */
export function stageOf(classType) {
  const ct = String(classType || "");
  for (const [re, name, role] of STAGES) if (re.test(ct)) return { name, role };
  return { name: ct || "Node", role: "" };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A node title the user (or the workflow) set: not the class_type and not the node's default display name. */
export function customTitle(title, classType, defaultTitle = null) {
  const t = String(title || "").trim();
  if (!t) return null;
  const n = norm(t);
  if (n === norm(classType)) return null;
  const d = typeof defaultTitle === "function" ? defaultTitle(classType) : defaultTitle;
  if (d && n === norm(d)) return null;
  return t.slice(0, 80);
}

// Upscale factor from the upsampler's own inputs or the model it loads: "ltx-2-spatial-upscaler-x2-1.0" -> 2.
function factorOf(prompt, node, depth = 0) {
  if (!node || depth > 2) return null;
  for (const [k, v] of Object.entries(node.inputs || {})) {
    if (typeof v === "number" && /scale_by|factor|upscale/i.test(k) && v > 1 && v <= 8) return v;
    if (typeof v === "string") {
      const m = /(?:^|[^a-z0-9])x(\d(?:\.\d+)?)(?![0-9])/i.exec(v) || /(?:^|[^a-z0-9.])(\d(?:\.\d+)?)x(?![a-z0-9])/i.exec(v);
      if (m && Number(m[1]) > 1) return Number(m[1]);
    }
    if (Array.isArray(v) && v.length === 2 && prompt[v[0]]) { const f = factorOf(prompt, prompt[v[0]], depth + 1); if (f) return f; }
  }
  return null;
}

/** API-format prompt -> {nodes: {id: {ct, title, factor}}, total, multi}. `multi`: more than one sampling stage, so
 *  sampler and upscaler names carry ": stage N". No payloads are kept. */
export function graphOf(prompt, { defaultTitle = null } = {}) {
  if (!prompt || typeof prompt !== "object") return null;
  const nodes = {};
  let samplers = 0, upscalers = 0;
  for (const [id, n] of Object.entries(prompt)) {
    if (!n || typeof n !== "object" || typeof n.class_type !== "string") continue;
    const { role } = stageOf(n.class_type);
    if (role === "sampler") samplers += 1;
    if (role === "upscale") upscalers += 1;
    nodes[id] = { ct: n.class_type, title: customTitle(n._meta?.title, n.class_type, defaultTitle),
      factor: role === "upscale" ? factorOf(prompt, n) : null };
  }
  const total = Object.keys(nodes).length;
  return total ? { nodes, total, multi: samplers > 1 || (samplers >= 1 && upscalers >= 1) } : null;
}

// ---- Measured history: a small rolling average of how long each kind took, per browser (localStorage, try/catch).
export class EtaBook {
  constructor({ storage = safeStorage(), key = ETA_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.avg = {};
    try { const j = JSON.parse(storage?.getItem(key) || "{}"); if (j && typeof j === "object") this.avg = j; } catch { this.avg = {}; }
  }
  /** Average ms for a key, falling back to the kind at any resolution; null when never measured. */
  get(key) {
    const hit = this.avg[key] || this.avg[`${String(key).split("@")[0]}@any`];
    return hit && Number.isFinite(hit.ms) ? hit.ms : null;
  }
  /** How many runs back this average (0 = never measured): a thin book gets a range, not a single number. */
  runs(key) {
    const hit = this.avg[key] || this.avg[`${String(key).split("@")[0]}@any`];
    return hit ? hit.n || 1 : 0;
  }
  record(key, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const add = (k) => {
      const prev = this.avg[k];
      this.avg[k] = prev ? { ms: Math.round(prev.ms * (1 - ETA_ALPHA) + ms * ETA_ALPHA), n: (prev.n || 1) + 1 } : { ms: Math.round(ms), n: 1 };
    };
    add(key);
    const any = `${String(key).split("@")[0]}@any`;
    if (any !== key) add(any);
    const keys = Object.keys(this.avg);
    if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete this.avg[k];
    try { this.storage?.setItem(this.key, JSON.stringify(this.avg)); } catch { /* storage blocked: this page only */ }
  }
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// ---- Errors in plain words.
const ERRORS = [
  [/out of memory|CUDA error: out of memory|\bOOM\b/i, "Ran out of GPU memory. Try a smaller size, fewer frames, or wait for the queue to clear."],
  [/no such file|not found|FileNotFoundError/i, "A file it needed wasn't on the server (a model or an input)."],
  [/interrupt|cancel/i, "Cancelled."],
  [/connection|timed? ?out|ECONNRESET/i, "Lost the connection to the server while it ran."],
  [/value not in list|required input|prompt_outputs_failed_validation|invalid prompt/i, "The job's settings didn't pass ComfyUI's check (a missing model or input)."],
];

export function plainError(detail) {
  const msg = String(detail?.exception_message || detail?.message || (typeof detail === "string" ? detail : "") || "").trim();
  for (const [re, words] of ERRORS) if (re.test(msg)) return words;
  const where = detail?.node_type ? ` (in ${detail.node_type})` : "";
  const first = msg.split("\n")[0].slice(0, 160);
  return first ? `Failed${where}: ${first}` : `Failed${where}.`;
}

// The executing event's detail: the bare node id (ComfyUI frontend) or {node, display_node, prompt_id} (the try-it
// demo, older code). null means the prompt finished.
function executingOf(d) {
  if (d == null || typeof d !== "object") return { pid: null, node: d == null ? null : String(d) };
  const node = d.display_node ?? d.node;
  return { pid: d.prompt_id || null, node: node == null ? null : String(node) };
}

// ---- The registry.
export class ActivityRegistry {
  constructor({ clientId = null, eta = new EtaBook(), now = () => Date.now(), defaultTitle = null } = {}) {
    this.clientId = clientId;
    this.eta = eta;
    this.now = now;
    this.defaultTitle = defaultTitle;
    this.jobs = new Map();
    this.notes = new Map();     // names the App gave its jobs, kept even before the job shows in the queue
    this.graphs = new Map();    // prompt id -> graphOf(prompt), from POST /prompt (may arrive after execution_start)
    this.counts = { running: 0, pending: 0 };
    this.listeners = new Set();
    this.runningPid = null;     // the job the bare-node-id `executing` events belong to
    this.lost = new Set();      // own jobs that left the queue with no event: looked up by GET /history/{id}
  }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  changed() { for (const f of this.listeners) { try { f(); } catch { /* a listener never breaks the registry */ } } }

  job(pid) {
    let j = this.jobs.get(pid);
    if (!j) {
      j = { id: pid, state: "queued", position: null, label: "", own: null, queuedAt: this.now(), startedAt: null,
        endedAt: null, step: null, steps: null, error: null, outputs: [], preview: null,
        nodes: new Map(), order: [], cur: null, cached: 0, errNode: null, errMsg: null, stopNode: null };
      this.jobs.set(pid, j);
      const n = this.notes.get(pid);
      if (n) Object.assign(j, n, { own: true });
      if (this.graphs.has(pid)) j.own = true;
    }
    return j;
  }

  /** The App's own registry: a name for a job this page queued. */
  note(pid, info = {}) {
    if (!pid) return;
    const n = { ...(this.notes.get(pid) || {}), ...pick(info, ["name", "kind", "trigger", "width", "height", "shot"]) };
    this.notes.set(pid, n);
    if (this.notes.size > 200) this.notes.delete(this.notes.keys().next().value);
    Object.assign(this.job(pid), n, { own: true });
    this.changed();
  }

  /** The prompt this page queued (API format), seen once at queue time: node names for the events. */
  graph(pid, prompt) {
    if (!pid || pid === "blocked") return;
    const g = prompt && typeof prompt === "object" && prompt.nodes && prompt.total ? prompt : graphOf(prompt, { defaultTitle: this.defaultTitle });
    if (!g) return;
    this.graphs.set(pid, g);
    if (this.graphs.size > 40) this.graphs.delete(this.graphs.keys().next().value);
    this.job(pid).own = true;
    this.changed();
  }

  // A node starts (or is seen running): the one before it is done.
  nodeStart(j, id, t) {
    if (id == null) return null;
    let n = j.nodes.get(id);
    if (n && n.state !== "running" && n.state !== "pending") return n;   // done / cached nodes don't restart
    if (j.cur && j.cur !== id) this.nodeEnd(j, j.cur, "done", t);
    if (!n) { n = { id, state: "running", startedAt: t, endedAt: null, step: null, steps: null }; j.nodes.set(id, n); j.order.push(id); }
    else { n.state = "running"; n.startedAt = n.startedAt || t; }
    if (j.cur !== id) { j.step = n.step; j.steps = n.steps; }
    j.cur = id;
    return n;
  }

  // A sampler's step: the first one seen and the latest, for its own step rate.
  stepAt(n, value, max, t) {
    if (n.p0 == null || value < n.p0.step) n.p0 = { step: value, t };
    n.step = value; n.steps = max; n.pt = t;
  }

  nodeEnd(j, id, state, t) {
    const n = j.nodes.get(id);
    if (!n) return;
    if (n.state === "running" || n.state === "pending") { n.state = state; n.endedAt = t; }
    if (j.cur === id) { j.cur = null; j.step = null; j.steps = null; }
  }

  /** ComfyUI websocket events (detail = event.detail). */
  onEvent(type, d = {}) {
    if (type === "status") {
      const r = d?.exec_info?.queue_remaining ?? d?.status?.exec_info?.queue_remaining;
      if (Number.isFinite(r) && r === 0) this.settleAll();
      this.changed();
      return;
    }
    let pid = d?.prompt_id || null;
    let node = null;
    if (type === "executing") { const e = executingOf(d); pid = e.pid || this.runningPid; node = e.node; }
    if (!pid) return;
    const j = this.job(pid);
    const t = this.now();
    const run = () => { j.state = "running"; j.position = 0; j.startedAt = j.startedAt || t; this.runningPid = pid; };
    switch (type) {
      case "execution_start":
        run(); break;
      case "execution_cached":
        if (!j.endedAt) run();
        for (const id of d.nodes || []) {
          const k = String(id);
          if (j.nodes.has(k)) continue;
          j.nodes.set(k, { id: k, state: "cached", startedAt: t, endedAt: t, step: null, steps: null });
          j.order.push(k);
          j.cached += 1;
        }
        break;
      case "executing":
        if (node == null) { if (j.state === "running") { if (j.cur) this.nodeEnd(j, j.cur, "done", t); this.finish(j, "done", t); } }
        else if (!j.endedAt) { run(); this.nodeStart(j, node, t); }
        break;
      case "progress": {
        if (j.endedAt) break;
        run();
        const id = d.node != null ? String(d.node) : j.cur;
        // A sampler seen first through its steps (no `executing` before it): as the job's first node, it began when the job did.
        const first = id != null && !j.nodes.has(id) && !j.order.length;
        const n = id != null ? this.nodeStart(j, id, first ? j.startedAt : t) : null;
        if (Number.isFinite(d.value) && Number.isFinite(d.max) && d.max > 0) {
          j.step = d.value; j.steps = d.max;
          if (n) this.stepAt(n, d.value, d.max, t);
        }
        break;
      }
      case "progress_state":
        if (j.endedAt) break;
        run();
        for (const [key, s] of Object.entries(d.nodes || {})) {
          const id = String(s?.display_node_id ?? s?.node_id ?? key);
          if (s?.state === "running") {
            const n = this.nodeStart(j, id, t);
            if (n && Number.isFinite(s.value) && Number.isFinite(s.max) && s.max > 1) { this.stepAt(n, s.value, s.max, t); j.step = s.value; j.steps = s.max; }
          } else if (s?.state === "finished") {
            if (!j.nodes.has(id)) { j.nodes.set(id, { id, state: "running", startedAt: t, endedAt: null, step: null, steps: null }); j.order.push(id); }
            this.nodeEnd(j, id, "done", t);
          } else if (s?.state === "error") {
            if (!j.nodes.has(id)) { j.nodes.set(id, { id, state: "running", startedAt: t, endedAt: null, step: null, steps: null }); j.order.push(id); }
            this.nodeEnd(j, id, "error", t);
          }
        }
        break;
      case "executed": {
        const id = d.display_node ?? d.node;
        if (id != null && !j.endedAt) { if (!j.nodes.has(String(id))) this.nodeStart(j, String(id), t); this.nodeEnd(j, String(id), "done", t); }
        for (const kind of ["images", "gifs", "videos", "video", "audio"]) {
          for (const f of d.output?.[kind] || []) if (f?.filename) j.outputs.push({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output", kind });
        }
        if (j.outputs.length > 8) j.outputs.splice(0, j.outputs.length - 8);
        break;
      }
      case "execution_success":
        if (j.cur) this.nodeEnd(j, j.cur, "done", t);
        this.finish(j, "done", t); break;
      case "execution_error": {
        const id = d.node_id != null ? String(d.node_id) : j.cur;
        if (id != null) {
          if (!j.nodes.has(id)) this.nodeStart(j, id, t);
          for (const k of j.nodes.keys()) if (k !== id) this.nodeEnd(j, k, "done", t);
          this.nodeEnd(j, id, "error", t);
        }
        j.errNode = id != null ? { id, ct: d.node_type || null } : null;
        j.errMsg = String(d.exception_message || "").trim().split("\n")[0].slice(0, 300) || null;
        j.error = plainError(d);
        this.finish(j, "failed", t); break;
      }
      case "execution_interrupted": {
        const id = d.node_id != null ? String(d.node_id) : j.cur;
        if (id != null && j.nodes.has(id)) this.nodeEnd(j, id, "stopped", t);
        j.stopNode = id != null ? { id, ct: d.node_type || null } : null;
        j.error = "Cancelled.";
        this.finish(j, "cancelled", t); break;
      }
      default: return;
    }
    this.changed();
  }

  finish(j, state, t) {
    if (this.runningPid === j.id) this.runningPid = null;
    this.lost.delete(j.id);
    if (j.endedAt) { if (state !== "done") j.state = state; return; }
    j.state = state;
    j.endedAt = t;
    j.position = null;
    if (j.cur) this.nodeEnd(j, j.cur, state === "done" ? "done" : "stopped", t);
    if (state === "done" && j.startedAt) {
      const kind = j.kind || kindOf(j.name || j.label);
      this.eta.record(etaKey(kind, j.width, j.height), t - j.startedAt);
    }
  }

  /** Nothing left on the server: our jobs still marked running or queued are looked up; other sessions' leave. */
  settleAll() {
    for (const j of [...this.jobs.values()]) {
      if (j.endedAt || (j.state !== "running" && j.state !== "queued")) continue;
      if (j.own) this.lost.add(j.id);
      else this.jobs.delete(j.id);
    }
  }

  /** Own jobs to look up by GET /history/{id} (and forget the list). */
  takeLost() { const ids = [...this.lost]; this.lost.clear(); return ids; }

  /** GET /history/{id} for one of our jobs that left the queue without an event (null: the server has no record). The
   *  entry's status messages replay as events, so a missed error still names its node. */
  applyHistory(pid, entry) {
    const j = this.jobs.get(pid);
    if (!j || j.endedAt) return;
    const t = this.now();
    if (!entry || typeof entry !== "object") {
      if (j.startedAt) this.finish(j, "done", t);
      else { j.error = "Taken off the queue."; this.finish(j, "cancelled", t); }
      this.changed();
      return;
    }
    if (!this.graphs.has(pid) && Array.isArray(entry.prompt) && entry.prompt[2]) this.graph(pid, entry.prompt[2]);
    const msgs = Array.isArray(entry.status?.messages) ? entry.status.messages : [];
    const ts = (name) => msgs.find((m) => m?.[0] === name)?.[1]?.timestamp;
    const t0 = ts("execution_start");
    for (const m of msgs) {
      if (!Array.isArray(m) || typeof m[0] !== "string" || m[0] === "execution_start") continue;
      if (j.endedAt) break;
      this.onEvent(m[0], { ...(m[1] || {}), prompt_id: pid });
    }
    for (const [id, out] of Object.entries(entry.outputs || {})) if (!j.endedAt) this.onEvent("executed", { prompt_id: pid, node: id, output: out });
    if (!j.endedAt) {
      const s = entry.status?.status_str;
      if (s === "error") { j.error = j.error || "Failed."; this.finish(j, "failed", t); }
      else this.finish(j, "done", t);
    }
    // The server's own clock for how long it ran (we missed the live events).
    const t1 = ts("execution_success") || ts("execution_error") || ts("execution_interrupted");
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) { j.startedAt = j.endedAt - (t1 - t0); }
    this.changed();
  }

  /** GET /soundstage/queue_summary: positions, labels and owners for every job on the queue. `askedAt`: when the
   *  request left, so a job queued while it was in flight is not taken for one that left. */
  applySummary(s, { askedAt = null } = {}) {
    if (!s || !Array.isArray(s.items)) return;
    this.counts = { running: s.running | 0, pending: s.pending | 0 };
    const seen = new Set();
    for (const it of s.items) {
      if (!it?.prompt_id) continue;
      seen.add(it.prompt_id);
      const j = this.job(it.prompt_id);
      if (j.endedAt) continue;   // a late summary never revives a finished job
      j.label = it.label || j.label;
      j.position = it.position;
      if (it.client_id != null) j.own = j.own || (!!this.clientId && it.client_id === this.clientId);
      if (it.state === "running") { j.state = "running"; j.startedAt = j.startedAt || this.now(); }
      else j.state = "queued";
    }
    // Truncated summaries (limit) can't tell us a job left; only prune when the summary listed everything.
    const complete = s.items.length >= (s.running | 0) + (s.pending | 0);
    if (complete) {
      for (const j of [...this.jobs.values()]) {
        if (seen.has(j.id) || j.endedAt) continue;
        if (j.state !== "running" && j.state !== "queued") continue;
        if (askedAt != null && j.queuedAt > askedAt) continue;
        if (j.own) this.lost.add(j.id);
        else this.jobs.delete(j.id);
      }
    }
    this.changed();
  }

  /** {ms, atLeast, over} left for a job: the measured average for its kind, else the running sampler's step rate (a
   *  lower bound: other nodes follow), else null. `over`: running past its average. */
  remaining(j, now = this.now()) {
    const kind = j.kind || kindOf(j.name || j.label);
    const avg = this.eta.get(etaKey(kind, j.width, j.height));
    if (j.state === "queued") return { ms: avg, atLeast: false, over: false };
    const el = j.startedAt ? now - j.startedAt : 0;
    if (avg != null && avg - el > 0) return { ms: avg - el, atLeast: false, over: false };
    if (j.steps && j.step > 0) {
      // This sampler's own step rate (two samples apart when we have them), counted on from its latest step.
      const n = j.cur ? j.nodes.get(j.cur) : null;
      const pt = n?.pt ?? now;
      const per = n?.p0 && j.step > n.p0.step ? (pt - n.p0.t) / (j.step - n.p0.step) : (pt - (n?.startedAt ?? j.startedAt ?? pt)) / j.step;
      return { ms: Math.max(1000, Math.round(per * (j.steps - j.step) - (now - pt))), atLeast: true, over: avg != null };
    }
    return { ms: null, atLeast: false, over: avg != null };
  }

  /** Node-level detail for one of our jobs: stage names in run order, step progress, node counts. */
  detail(j, now) {
    const g = this.graphs.get(j.id) || null;
    const info = (id) => g?.nodes?.[id] || null;
    let stage = 1, samplerInStage = false;
    const lines = [];
    for (const id of j.order) {
      const n = j.nodes.get(id);
      const nf = info(id);
      const ct = nf?.ct || null;
      const st = ct ? stageOf(ct) : { name: `Node ${id}`, role: "" };
      let name = st.name;
      if (n.state !== "cached") {
        if (st.role === "upscale") { if (samplerInStage) { stage += 1; samplerInStage = false; } }
        if (st.role === "sampler") { if (samplerInStage) stage += 1; samplerInStage = true; }
      }
      if (st.role === "upscale") name = nf?.factor ? `${name} ×${nf.factor}` : name;
      if (g?.multi && st.role && n.state !== "cached") name = `${name}: stage ${stage}`;
      if (nf?.title) name = nf.title;
      lines.push({ id, ct, name, raw: ct ? `${ct} #${id}` : `#${id}`, state: n.state, role: st.role,
        ms: n.endedAt != null && n.state !== "cached" ? n.endedAt - n.startedAt : n.state === "running" ? now - n.startedAt : null,
        step: n.step, steps: n.steps });
    }
    const cur = j.cur ? lines.find((l) => l.id === j.cur) : null;
    const done = lines.filter((l) => l.state === "done" || l.state === "cached").length;
    const total = g?.total ? Math.max(g.total, lines.length) : null;
    const nameOf = (ref) => {
      if (!ref) return null;
      const l = lines.find((x) => x.id === ref.id);
      const ct = l?.ct || ref.ct || null;
      return { id: ref.id, ct, name: l?.name || (ct ? stageOf(ct).name : `Node ${ref.id}`), raw: ct ? `${ct} #${ref.id}` : `#${ref.id}` };
    };
    return {
      stage: cur?.name || null, stageRaw: cur?.raw || null, role: cur?.role || "",
      step: cur && cur.steps ? cur.step : null, steps: cur && cur.steps ? cur.steps : null,
      stepPct: cur && cur.steps ? Math.max(0, Math.min(100, Math.round((100 * cur.step) / cur.steps))) : null,
      done, total, cached: j.cached, named: !!g,
      nodes: lines.slice(-DETAIL_KEEP), more: Math.max(0, lines.length - DETAIL_KEEP),
      errorNode: nameOf(j.errNode), errorMsg: j.errMsg, stopNode: nameOf(j.stopNode),
    };
  }

  view(now = this.now()) {
    const all = [...this.jobs.values()].map((j) => this.row(j, now));
    const running = all.filter((r) => r.state === "running").sort((a, b) => Number(b.own) - Number(a.own));
    const queued = all.filter((r) => r.state === "queued").sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    const finished = all.filter((r) => r.endedAt).sort((a, b) => b.endedAt - a.endedAt).slice(0, FINISHED_KEEP);
    // Estimated start for each queued job: what runs now plus everything ahead of it.
    let ahead = 0, partial = false;
    for (const r of running) { if (r.remainingMs == null) partial = true; else { ahead += r.remainingMs; if (r.remainingAtLeast) partial = true; } }
    for (const r of queued) {
      r.startsInMs = partial && ahead === 0 ? null : ahead;
      r.startsPartial = partial;
      if (r.remainingMs == null) partial = true; else ahead += r.remainingMs;
    }
    // Other sessions' jobs past the summary's list still count in the totals.
    const runningN = Math.max(running.length, this.counts.running);
    const queuedN = Math.max(queued.length, this.counts.pending);
    if (queuedN > queued.length) partial = true;
    // Forget the oldest finished jobs.
    const done = [...this.jobs.values()].filter((j) => j.endedAt).sort((a, b) => b.endedAt - a.endedAt);
    for (const j of done.slice(FINISHED_KEEP)) this.jobs.delete(j.id);
    return { running, queued, finished, totals: { running: runningN, queued: queuedN, etaMs: ahead || null, etaPartial: partial } };
  }

  row(j, now) {
    const kind = j.kind || kindOf(j.name || j.label);
    const base = j.name || j.label || kindName(kind);
    const elapsedMs = j.startedAt ? (j.endedAt || now) - j.startedAt : null;
    const rem = j.endedAt ? { ms: null, atLeast: false, over: false } : this.remaining(j, now);
    // Node detail only for this browser's jobs (the events come to the session that queued them).
    const detail = j.own && (j.nodes.size || this.graphs.has(j.id)) ? this.detail(j, now) : null;
    let pct = null;
    if (j.state === "running") {
      if (elapsedMs != null && rem.ms != null && !rem.atLeast && elapsedMs + rem.ms > 0) pct = Math.round((100 * elapsedMs) / (elapsedMs + rem.ms));
      else if (detail?.total) pct = Math.round((100 * (detail.done + (detail.steps ? detail.step / detail.steps : 0))) / detail.total);
      else if (j.steps) pct = Math.round((100 * j.step) / j.steps);
      if (pct != null) pct = Math.max(0, Math.min(99, pct));
    }
    return { id: j.id, kind, name: base, state: j.state, own: !!j.own, position: j.position, trigger: j.trigger || "",
      elapsedMs, etaRuns: this.eta.runs(etaKey(kind, j.width, j.height)), remainingMs: rem.ms, remainingAtLeast: rem.atLeast, overdue: rem.over && rem.ms == null, pct,
      step: j.state === "running" ? j.step : null, steps: j.state === "running" ? j.steps : null,
      endedAt: j.endedAt, error: j.error, outputs: j.outputs.slice(), preview: j.preview, detail,
      waitedMs: j.state === "queued" ? now - j.queuedAt : null };
  }
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] != null && o[k] !== "") out[k] = o[k];
  return out;
}

// ---- Words.
export function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function clock(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const secs = (ms) => (ms == null ? "" : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : dur(ms));

/** The pill: the stage of our running job first (when we know it), then the counts and the time to clear the queue. */
export function pillText(t, run = null) {
  const parts = [];
  const d = run?.own ? run.detail : null;
  if (d?.stage) parts.push(d.steps ? `${d.stage} · ${d.step}/${d.steps}` : d.stage);
  if (!t || (!t.running && !t.queued)) return parts.length ? parts.join(" · ") : "Idle";
  if (t.running && !parts.length) parts.push(`${t.running} running`);
  else if (t.running > 1) parts.push(`+${t.running - 1} running`);
  if (t.queued) parts.push(`${t.queued} queued`);
  if (t.etaMs) parts.push(`${t.etaPartial ? "≥" : "~"}${dur(t.etaMs)}`);
  return parts.join(" · ");
}

export function viewUrl(f) {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" });
  return `/view?${q}`;
}

// ---- The panel. Built with document.createElement only (labels come from other sessions' prompts, so text only).
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function bar(pct, cls = "ss-act-bar") {
  const b = h("div", cls);
  const f = h("div", "ss-act-fill");
  f.style.width = `${pct ?? 0}%`;
  b.append(f);
  b.setAttribute("role", "progressbar");
  b.setAttribute("aria-valuemin", "0");
  b.setAttribute("aria-valuemax", "100");
  if (pct != null) b.setAttribute("aria-valuenow", String(pct));
  return b;
}

const MARK = { done: "✓", cached: "↺", running: "▶", error: "✗", stopped: "■", pending: "·" };

/** The node list: what ran, in order, with its time; cached nodes folded into one line. */
function detailsList(d, { raw = false, open = false, onToggle = null, onRaw = null, id = "" } = {}) {
  const det = h("details", "ss-act-det");
  det.open = !!open;
  det.dataset.id = id;
  const counts = [d.total ? `${d.done} of ${d.total} nodes` : `${d.done} nodes done`];
  if (d.cached) counts.push(`${d.cached} cached`);
  det.append(h("summary", null, `Details · ${counts.join(" · ")}`));
  det.addEventListener("toggle", () => onToggle?.(det.open));
  const opts = h("label", "ss-act-raw");
  const cb = h("input");
  cb.type = "checkbox";
  cb.checked = !!raw;
  cb.addEventListener("change", () => onRaw?.(cb.checked));
  opts.append(cb, document.createTextNode(" Node types (class and id)"));
  det.append(opts);
  const ul = h("ol", "ss-act-nodes");
  const cached = d.nodes.filter((l) => l.state === "cached");
  if (d.more) ul.append(h("li", "ss-act-node ss-act-dim", `… ${d.more} earlier`));
  if (cached.length) {
    const names = raw ? cached.map((l) => l.raw) : [...new Set(cached.map((l) => l.name))];
    ul.append(h("li", "ss-act-node ss-act-dim", `${MARK.cached} ${cached.length} cached, skipped: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}`));
  }
  for (const l of d.nodes) {
    if (l.state === "cached") continue;
    const li = h("li", `ss-act-node ss-act-n-${l.state}`);
    li.dataset.node = l.id;
    const bits = [`${MARK[l.state] || "·"} ${raw ? l.raw : l.name}`];
    if (l.steps) bits.push(`${l.step}/${l.steps}`);
    if (l.ms != null) bits.push(secs(l.ms));
    li.textContent = bits.join(" · ");
    if (!raw && l.ct && l.name !== l.ct) li.title = `${l.ct} #${l.id}`;
    ul.append(li);
  }
  if (!d.nodes.length) ul.append(h("li", "ss-act-node ss-act-dim", "Waiting for the first node…"));
  det.append(ul);
  return det;
}

/** The sound settings: on/off, volume, only in the background, only for jobs longer than N seconds, and a Test button. */
function soundBox(sound) {
  const { prefs, onChange, onTest } = sound;
  const det = h("details", "ss-act-sound");
  det.open = !!sound.open;
  det.addEventListener("toggle", () => sound.onToggle?.(det.open));
  det.append(h("summary", null, `Sound · ${prefs.on ? "chime on" : "off"}`));
  const field = (label, input) => { const l = h("label", "ss-act-field"); l.append(input, h("span", null, label)); det.append(l); return input; };
  const box = (key, label) => {
    const i = h("input"); i.type = "checkbox"; i.checked = !!prefs[key];
    i.addEventListener("change", () => onChange({ [key]: i.checked }));
    return field(label, i);
  };
  box("on", "Play a soft chime when a job finishes");
  const vol = h("input"); vol.type = "range"; vol.min = "0"; vol.max = "1"; vol.step = "0.05"; vol.value = String(prefs.volume);
  vol.setAttribute("aria-label", "Chime volume");
  vol.addEventListener("input", () => onChange({ volume: Number(vol.value) }, { quiet: true }));
  field("Volume", vol);
  box("bgOnly", "Only when this tab is in the background");
  const min = h("input"); min.type = "number"; min.min = "0"; min.max = "3600"; min.value = String(prefs.minSec);
  min.addEventListener("change", () => onChange({ minSec: Number(min.value) }));
  field("Only for jobs longer than (seconds)", min);
  const row = h("div", "ss-act-testrow");
  for (const [k, t] of [["done", "Test: finished"], ["stopped", "Test: stopped"]]) {
    const b = h("button", "ss-btn ss-act-test", t); b.type = "button";
    b.addEventListener("click", (e) => { e.stopPropagation(); onTest(k); });
    row.append(b);
  }
  det.append(row);
  return det;
}

export function renderPanel(v, { onCancel = null, urlOf = viewUrl, raw = false, open = {}, onToggle = null, onRaw = null, sound = null } = {}) {
  const root = h("div", "ss-act");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Activity");
  root.append(h("div", "ss-act-head", `Activity · ${pillText(v.totals)}`));
  if (sound) root.append(soundBox(sound));
  const nodeWord = (n) => (n ? (raw ? n.raw : n.name) : null);
  const section = (title, rows, fill) => {
    const s = h("section", "ss-act-sec");
    s.append(h("h4", null, title));
    if (!rows.length) s.append(h("div", "ss-act-empty", "Nothing here."));
    for (const r of rows) {
      const li = h("div", `ss-act-row ss-act-${r.state}`);
      li.dataset.id = r.id;
      const top = h("div", "ss-act-top");
      top.append(h("span", "ss-act-name", r.name));
      if (!r.own) top.append(h("span", "ss-act-other", "another session"));
      li.append(top);
      fill(li, r);
      if (r.own && onCancel && (r.state === "running" || r.state === "queued")) {
        const b = h("button", "ss-btn ss-act-cancel", "Cancel");
        b.type = "button";
        b.title = r.state === "running" ? "Stop this job now" : "Take this job off the queue";
        b.addEventListener("click", (e) => { e.stopPropagation(); onCancel(r); });
        li.append(b);
      }
      s.append(li);
    }
    root.append(s);
  };
  section("Running now", v.running, (li, r) => {
    if (r.preview) { const img = h("img", "ss-act-thumb"); img.src = r.preview; img.alt = ""; li.prepend(img); }
    const d = r.detail;
    if (d?.stage || d?.named) {
      const st = h("div", "ss-act-stage");
      st.append(h("span", "ss-act-stagename", d.stage ? (raw ? d.stageRaw : d.stage) : "Starting…"));
      if (d.steps) st.append(h("span", "ss-act-steps", `step ${d.step}/${d.steps}`));
      li.append(st);
      if (d.steps) li.append(bar(d.stepPct, "ss-act-bar ss-act-stepbar"));
    } else if (r.steps) {
      li.append(h("div", "ss-act-stage", `step ${r.step}/${r.steps}`));
    }
    li.append(bar(r.pct));
    const bits = [r.pct != null ? `${r.pct}%` : "working"];
    if (d) bits.push(d.total ? `node ${Math.min(d.done + 1, d.total)} of ${d.total}` : `${d.done} nodes done`);
    if (d?.cached) bits.push(`${d.cached} cached`);
    bits.push(`${clock(r.elapsedMs)} so far`);
    bits.push(r.remainingMs != null ? `${r.remainingAtLeast ? "at least" : "about"} ${dur(r.remainingMs)} left`
      : r.overdue ? "longer than usual" : "time left not known yet");
    li.append(h("div", "ss-act-meta", bits.join(" · ")));
    if (!r.own) li.append(h("div", "ss-act-meta ss-act-dim", "Node detail shows in the session that queued it."));
    if (d) li.append(detailsList(d, { raw, open: !!open[r.id], id: r.id, onToggle: (o) => onToggle?.(r.id, o), onRaw }));
  });
  section("Queued next", v.queued, (li, r) => {
    const bits = [r.position ? `#${r.position} in line` : "in line"];
    if (r.trigger) bits.push(`from ${r.trigger}`);
    if (r.startsInMs != null) bits.push(`starts in ${r.startsPartial ? "at least " : "about "}${dur(r.startsInMs)}`);
    else bits.push("start time not known yet");
    li.append(h("div", "ss-act-meta", bits.join(" · ")));
  });
  section("Finished recently", v.finished, (li, r) => {
    const d = r.detail;
    const word = r.state === "done" ? "Done" : r.state === "cancelled" ? "Cancelled" : "Failed";
    const bits = [word];
    if (r.state === "cancelled" && d?.stopNode) bits[0] = `Cancelled at ${nodeWord(d.stopNode)}`;
    if (r.elapsedMs != null) bits.push(`took ${dur(r.elapsedMs)}`);
    if (d?.cached) bits.push(`${d.cached} cached`);
    li.append(h("div", "ss-act-meta", bits.join(" · ")));
    if (r.state === "failed") {
      if (d?.errorNode) li.append(h("div", "ss-act-err", `Failed at ${d.errorNode.name}${d.errorNode.ct ? ` (${d.errorNode.raw})` : ""}`));
      if (r.error) li.append(h("div", "ss-act-err", r.error));
      if (d?.errorMsg && !(r.error || "").includes(d.errorMsg)) li.append(h("div", "ss-act-errraw", d.errorMsg));
    } else if (r.state === "cancelled" && r.error && r.error !== "Cancelled.") li.append(h("div", "ss-act-meta", r.error));
    for (const f of r.outputs.slice(-3)) {
      const a = h("a", "ss-act-link", f.filename);
      a.href = urlOf(f);
      a.target = "_blank";
      a.rel = "noopener";
      li.append(a);
    }
    if (d && d.nodes.length) li.append(detailsList(d, { raw, open: !!open[r.id], id: r.id, onToggle: (o) => onToggle?.(r.id, o), onRaw }));
  });
  return root;
}

export const ACTIVITY_CSS = `
.ss-actbtn { position:relative; display:inline-flex; align-items:center; gap:6px; margin-left:6px; white-space:nowrap; flex:none; overflow:hidden; }
.ss-actbtn[data-busy=true] { color:var(--ss-accent, #e39a40) !important; }
.ss-actbtn .ss-act-dot { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.5; flex:none; }
.ss-actbtn[data-busy=true] .ss-act-dot { opacity:1; animation:ss-act-pulse 1.4s ease-in-out infinite; }
.ss-actbtn .ss-act-lbl { display:inline-block; max-width:22em; overflow:hidden; text-overflow:ellipsis; vertical-align:bottom; }
.ss-stage[data-tw=s] .ss-actbtn .ss-act-lbl, .ss-stage[data-ws=narrow] .ss-actbtn .ss-act-lbl { max-width:11em; }
.ss-actbtn[data-pulse=true] { animation:ss-act-done 1.6s ease-out 1; }
@keyframes ss-act-done { 0% { box-shadow:0 0 0 0 color-mix(in srgb, var(--ss-accent, #e39a40) 60%, transparent); } 100% { box-shadow:0 0 0 12px transparent; } }
.ss-jobtimer { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 14px; padding:6px 10px 8px; position:relative; font-size:12px; }
.ss-jobtimer[hidden] { display:none; }
.ss-jobtimer .ss-jt-name { font-weight:600; max-width:24em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-jobtimer .ss-jt-clock { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.02em; }
.ss-jobtimer .ss-jt-pct { font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; }
.ss-jobtimer .ss-jt-dim { opacity:.75; }
.ss-jobtimer .ss-jt-bar { flex:1 0 100%; height:5px; border-radius:3px; background:rgba(128,128,128,.25); overflow:hidden; }
.ss-jobtimer .ss-jt-fill { height:100%; width:0; background:var(--ss-accent, #e39a40); border-radius:3px; transition:width .9s linear; }
.ss-jobtimer[data-indet=true] .ss-jt-fill { width:35%; animation:ss-jt-slide 2.4s ease-in-out infinite alternate; transition:none; }
@keyframes ss-jt-slide { from { margin-left:0; } to { margin-left:65%; } }
@media (prefers-reduced-motion: reduce) {
  .ss-actbtn[data-pulse=true], .ss-jobtimer[data-indet=true] .ss-jt-fill { animation:none; }
  .ss-jobtimer .ss-jt-fill { transition:none; }
  .ss-jobtimer[data-indet=true] .ss-jt-fill { width:100%; opacity:.35; }
}
.ss-act-sound { margin:4px 0 8px; font-size:12px; }
.ss-act-sound .ss-act-field { display:flex; align-items:center; gap:8px; margin:4px 0; }
.ss-act-sound input[type=number] { width:5em; }
.ss-act-testrow { display:flex; gap:6px; margin-top:6px; }
.ss-actbtn .ss-act-mini { position:absolute; left:0; right:0; bottom:0; height:2px; background:transparent; pointer-events:none; }
.ss-actbtn .ss-act-mini > i { display:block; height:100%; width:0; background:currentColor; opacity:.9; transition:width .3s linear; }
.ss-actbtn .ss-act-mini[hidden] { display:none; }
@keyframes ss-act-pulse { 50% { opacity:.3; } }
@media (prefers-reduced-motion: reduce) { .ss-actbtn .ss-act-dot { animation:none !important; } .ss-actbtn .ss-act-mini > i { transition:none; } }
@media (max-width: 520px) { .ss-actbtn .ss-act-lbl { max-width:8.5em !important; } }
.ss-act { width:min(440px, calc(100vw - 32px)); max-width:calc(100vw - 32px); box-sizing:border-box; max-height:min(72vh, 680px); overflow:auto; overflow-x:hidden; padding:10px; display:flex; flex-direction:column; gap:10px;
  background:var(--ss-panel, #1d2128); color:var(--ss-text, #cfd5de); border:1px solid var(--ss-line, #39404b); border-radius:8px; font-size:12px; }
.ss-act * { box-sizing:border-box; min-width:0; }
.ss-act-head { font-weight:700; overflow-wrap:anywhere; }
.ss-act-sec h4 { margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--ss-dim, #7d8694); }
.ss-act-empty, .ss-act-dim { color:var(--ss-dim, #7d8694); }
.ss-act-row { display:flex; flex-direction:column; gap:3px; padding:6px 0; border-top:1px solid var(--ss-line, #2b3039); }
.ss-act-top { display:flex; gap:6px; align-items:baseline; }
.ss-act-name { font-weight:600; flex:1; min-width:0; overflow-wrap:anywhere; }
.ss-act-other { font-size:10px; color:var(--ss-dim, #7d8694); white-space:nowrap; }
.ss-act-thumb { width:96px; max-height:64px; object-fit:cover; border-radius:4px; }
.ss-act-stage { display:flex; gap:8px; align-items:baseline; font-weight:600; color:var(--ss-text, #e3e7ee); }
.ss-act-stagename { flex:1; overflow-wrap:anywhere; }
.ss-act-steps { font-variant-numeric:tabular-nums; color:var(--ss-dim, #9aa3b0); white-space:nowrap; font-weight:500; }
.ss-act-bar { height:5px; background:var(--ss-line, #2b3039); border-radius:3px; overflow:hidden; }
.ss-act-stepbar { height:3px; }
.ss-act-stepbar .ss-act-fill { background:#7fb2e5; }
.ss-act-fill { height:100%; background:var(--ss-accent, #e39a40); }
.ss-act-meta { color:var(--ss-dim, #9aa3b0); overflow-wrap:anywhere; }
.ss-act-err { color:#ef8a7a; overflow-wrap:anywhere; }
.ss-act-errraw { color:#d9a59c; font-family:ui-monospace, Menlo, monospace; font-size:11px; overflow-wrap:anywhere; white-space:pre-wrap; }
.ss-act-link { color:var(--ss-accent, #e39a40); overflow-wrap:anywhere; }
.ss-act-cancel { align-self:flex-start; padding:2px 8px !important; font-weight:500 !important; }
.ss-act-det { margin-top:2px; }
.ss-act-det > summary { cursor:pointer; color:var(--ss-dim, #9aa3b0); user-select:none; }
.ss-act-raw { display:flex; gap:4px; align-items:center; margin:4px 0; color:var(--ss-dim, #9aa3b0); font-size:11px; cursor:pointer; }
.ss-act-nodes { list-style:none; margin:0; padding:0 0 0 2px; display:flex; flex-direction:column; gap:1px; max-height:220px; overflow:auto; overflow-x:hidden;
  font-variant-numeric:tabular-nums; }
.ss-act-node { overflow-wrap:anywhere; }
.ss-act-n-running { color:var(--ss-accent, #e39a40); font-weight:600; }
.ss-act-n-error { color:#ef8a7a; }
.ss-act-n-stopped { color:var(--ss-dim, #9aa3b0); }
`;

// ---- Cancel: own jobs only (the server can't tell sessions apart; the App only offers it on jobs this page queued).
export async function cancelJob(api, row) {
  if (!row?.own) return false;
  try {
    if (row.state === "running") {
      await api.fetchApi("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: row.id }) });
    } else {
      await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [row.id] }) });
    }
    return true;
  } catch { return false; }
}

/** One of our jobs that left the queue without an event: its own history entry (never the full GET /history). */
export async function historyOf(api, pid) {
  try {
    const r = await api.fetchApi(`/history/${encodeURIComponent(pid)}`);
    if (!r || (r.status && r.status !== 200)) return null;
    const j = await r.json();
    return j && typeof j === "object" ? j[pid] || null : null;
  } catch { return null; }
}

/** One poll: the light queue summary, then GET /history/{id} for each of our jobs that left the queue unseen. The
 *  only two reads the Activity makes (tests/js/activity.test.mjs checks it). */
export async function syncOnce(api, reg) {
  const askedAt = reg.now();
  const q = await queueSummary(api, { limit: 200 });
  if (q) reg.applySummary(q, { askedAt });
  for (const pid of reg.takeLost()) reg.applyHistory(pid, await historyOf(api, pid));
}

/** Watch POST /prompt on the App's api (every part of the App queues through api.fetchApi): the prompt's node names go
 *  to the registry under the prompt id the server answers with. Installed once per api. */
export function watchQueueing(api, reg) {
  if (!api || typeof api.fetchApi !== "function" || api.__ssActivityFetch) return false;
  const orig = api.fetchApi.bind(api);
  api.__ssActivityFetch = orig;
  api.fetchApi = api.__ssActivityWrapped = async (path, init = {}) => {
    const r = await orig(path, init);
    try {
      if (String(init?.method || "GET").toUpperCase() === "POST" && /^\/prompt(\?|$)/.test(String(path)) && typeof init.body === "string"
        && r && typeof r.clone === "function" && (!r.status || r.status === 200)) {
        const body = init.body;
        r.clone().json().then((j) => {
          if (!j?.prompt_id || j.prompt_id === "blocked") return;
          const p = JSON.parse(body)?.prompt;
          reg.graph(j.prompt_id, graphOf(p, { defaultTitle: reg.defaultTitle }));
        }).catch(() => { /* not JSON: nothing to name */ });
      }
    } catch { /* naming a job is never worth breaking the queue */ }
    return r;
  };
  return true;
}

/** The node's default title in this ComfyUI (so a title nobody changed is not taken for a custom one). */
function liveDefaultTitle(ct) {
  try { return globalThis.LiteGraph?.registered_node_types?.[ct]?.title || null; } catch { return null; }
}

const WS_EVENTS = ["status", "execution_start", "execution_cached", "executing", "progress", "progress_state", "executed",
  "execution_success", "execution_error", "execution_interrupted"];

// One registry, one set of listeners and one poll per api, however many Stage nodes mount a pill.
const shared = new WeakMap();

function sharedFor(api, win) {
  let s = shared.get(api);
  if (s) return s;
  const reg = new ActivityRegistry({ clientId: api.clientId || api.initialClientId || null, defaultTitle: liveDefaultTitle });
  s = { reg, refs: 0, pills: new Set(), timer: 0, inflight: false, stopped: false, sound: { prefs: loadSound() } };
  // Browsers keep audio locked until the first click or key: make the context then (before that, the chime is skipped).
  const audio = s.audio = { c: null, ctx: () => audio.c,
    unlock() {
      try { const AC = win?.AudioContext || win?.webkitAudioContext; if (!audio.c && AC) audio.c = new AC(); audio.c?.resume?.()?.catch?.(() => {}); } catch { /* no sound: fine */ }
      return audio.c;
    } };
  const unlockEvents = ["pointerdown", "keydown"];
  const onUnlock = () => { audio.unlock(); for (const t of unlockEvents) win?.removeEventListener?.(t, onUnlock, true); };
  for (const t of unlockEvents) win?.addEventListener?.(t, onUnlock, true);
  s.cues = attachFinishCues({ reg, win, sound: s.sound, audio, onPulse: () => { for (const p of s.pills) p.pulse?.(); } });
  s.test = (kind) => playChime(kind, s.sound.prefs, audio.unlock(), { reduced: s.cues.reduced() });
  const handlers = WS_EVENTS.map((t) => [t, (ev) => { if (!reg.clientId && api.clientId) reg.clientId = api.clientId; reg.onEvent(t, ev?.detail); }]);
  for (const [t, f] of handlers) api.addEventListener?.(t, f);
  // The live preview ComfyUI sends while sampling (no prompt id: it belongs to the job running now).
  let lastPreview = null;
  const onPreview = (ev) => {
    const blob = ev?.detail;
    if (!blob || typeof URL?.createObjectURL !== "function") return;
    const run = reg.jobs.get(reg.runningPid) || [...reg.jobs.values()].find((j) => j.state === "running" && j.own);
    if (!run) return;
    if (lastPreview) URL.revokeObjectURL(lastPreview);
    lastPreview = run.preview = URL.createObjectURL(blob);
  };
  api.addEventListener?.("b_preview", onPreview);
  const onJob = (ev) => { const d = ev?.detail || {}; reg.note(d.prompt_id, d); };
  win?.addEventListener?.(JOB_EVENT, onJob);
  watchQueueing(api, reg);

  s.poll = async () => {
    if (s.stopped || s.inflight) return;
    s.inflight = true;
    try { await syncOnce(api, reg); } finally { s.inflight = false; }
  };
  const tick = () => {
    if (s.stopped) return;
    const v = reg.view();
    const busy = v.totals.running || v.totals.queued || [...s.pills].some((p) => p.isOpen());
    if (!globalThis.document?.hidden) s.poll();
    else for (const pid of reg.takeLost()) historyOf(api, pid).then((e) => reg.applyHistory(pid, e));
    s.timer = setTimeout(tick, busy ? 4000 : 20000);
  };
  // status (queue_remaining 0) can mark jobs lost between polls: look them up soon, not at the next tick.
  const offLost = reg.onChange(() => {
    if (!reg.lost.size || s.inflight || s.soon) return;
    s.soon = setTimeout(() => { s.soon = 0; s.poll(); }, 300);
  });
  s.start = () => tick();
  s.dispose = () => {
    s.stopped = true; clearTimeout(s.timer); clearTimeout(s.soon); offLost();
    s.cues.dispose();
    for (const t of unlockEvents) win?.removeEventListener?.(t, onUnlock, true);
    for (const [t, f] of handlers) api.removeEventListener?.(t, f);
    api.removeEventListener?.("b_preview", onPreview);
    win?.removeEventListener?.(JOB_EVENT, onJob);
    if (lastPreview) URL.revokeObjectURL(lastPreview);
    // put fetchApi back only if nobody wrapped it after us
    if (api.__ssActivityFetch && api.fetchApi === api.__ssActivityWrapped) { api.fetchApi = api.__ssActivityFetch; delete api.__ssActivityFetch; delete api.__ssActivityWrapped; }
    shared.delete(api);
  };
  shared.set(api, s);
  s.start();
  return s;
}

// ---- The prominent timer for the running job, under the top row.
/** The timer's DOM and an update(view) that paints the running job (or hides when nothing runs). Text only. */
export function createJobTimer() {
  const el = h("div", "ss-jobtimer");
  el.setAttribute("role", "timer");
  el.setAttribute("aria-label", "Running job timer");
  el.hidden = true;
  const name = h("span", "ss-jt-name"), clockEl = h("span", "ss-jt-clock"), pct = h("span", "ss-jt-pct"),
    step = h("span", "ss-jt-dim"), left = h("span", "ss-jt-dim"), node = h("span", "ss-jt-dim"), queue = h("span", "ss-jt-dim");
  const bar = h("div", "ss-jt-bar"), fill = h("div", "ss-jt-fill");
  bar.append(fill);
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  el.append(name, clockEl, pct, step, left, node, queue, bar);
  const update = (v) => {
    const run = v.running.find((r) => r.own) || v.running[0] || null;
    const m = timerModel(run);
    el.hidden = !m;
    if (!m) return null;
    name.textContent = m.name;
    clockEl.textContent = m.clock;
    pct.textContent = m.pct != null ? `${m.pct}%` : "";
    step.textContent = m.stepText || "";
    left.textContent = m.left;
    node.textContent = m.node && m.own ? `on ${m.node}` : "";
    queue.textContent = queueLine(v.totals) || "";
    el.dataset.indet = String(m.indeterminate);
    fill.style.width = m.indeterminate ? "" : `${m.pct}%`;
    if (m.indeterminate) bar.removeAttribute?.("aria-valuenow"); else bar.setAttribute("aria-valuenow", String(m.pct));
    return m;
  };
  return { el, update };
}

/** One chime and one set of visual cues per finished job of this browser: sound (if the settings allow), the pill
 *  pulse, and a "✓ Done" tab title until the tab is focused. */
export function attachFinishCues({ reg, win = globalThis.window, sound, audio, onPulse = null }) {
  const watcher = new FinishWatcher();
  const doc = win?.document;
  let saved = null;
  const restore = () => { if (saved != null && doc) { doc.title = saved; saved = null; } };
  const onVis = () => { if (!doc?.hidden) restore(); };
  win?.addEventListener?.("focus", restore);
  doc?.addEventListener?.("visibilitychange", onVis);
  const reduced = () => { try { return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch { return false; } };
  const check = () => {
    for (const f of watcher.check(reg.view().finished)) {
      const cue = cuesFor(sound.prefs, { elapsedMs: f.elapsedMs, hidden: !!doc?.hidden });
      if (cue.sound) playChime(f.kind, sound.prefs, audio.ctx(), { reduced: reduced() });
      if (cue.pulse) onPulse?.();
      if (cue.title && doc) { if (saved == null) saved = doc.title; doc.title = `${f.kind === "done" ? "✓ Done" : "■ Stopped"} · ${String(saved).replace(/^(✓ Done|■ Stopped) · /, "")}`; }
    }
  };
  const off = reg.onChange(check);
  return { watcher, check, reduced, dispose() { off(); win?.removeEventListener?.("focus", restore); doc?.removeEventListener?.("visibilitychange", onVis); restore(); } };
}

function readRaw() { try { return globalThis.localStorage?.getItem(RAW_KEY) === "1"; } catch { return false; } }
function writeRaw(on) { try { globalThis.localStorage?.setItem(RAW_KEY, on ? "1" : "0"); } catch { /* this page only */ } }

/** The live wiring: a pill before `before` in `row` (outside the ⋯ fold order) and its panel, on the shared registry. */
export function mountActivity({ api, row, before = null, theme = null, win = globalThis.window }) {
  if (!document.getElementById("ss-activity-css")) {
    const st = h("style");
    st.id = "ss-activity-css";
    st.textContent = ACTIVITY_CSS;
    document.head.append(st);
  }
  const s = sharedFor(api, win);
  s.refs += 1;
  const reg = s.reg;
  const btn = h("button", "ss-btn ss-actbtn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.dataset.ssIcon = "activity";
  const dot = h("span", "ss-act-dot");
  const lbl = h("span", "ss-act-lbl", "Idle");
  const mini = h("span", "ss-act-mini");
  const miniFill = h("i");
  mini.append(miniFill);
  mini.hidden = true;
  btn.append(dot, lbl, mini);
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  row.insertBefore(btn, before && before.parentNode === row ? before : null);
  const timer = createJobTimer();
  row.parentNode?.insertBefore(timer.el, row.nextSibling);
  let pulseT = 0;

  let panel = null, pressed = false, pending = 0, raw = readRaw();
  const open = {};   // which jobs' Details are open (kept across redraws)
  const isOpen = () => !!(panel && isPopoverOpen(panel));
  const setSound = (patch, { quiet = false } = {}) => {
    s.sound.prefs = { ...s.sound.prefs, ...patch };
    saveSound(s.sound.prefs);
    if (!quiet) paint();
  };
  const soundOpt = () => ({ prefs: s.sound.prefs, onChange: setSound, onTest: s.test, open: open.sound, onToggle: (o) => { open.sound = o; } });
  const opts = () => ({ onCancel, raw, open, sound: soundOpt(), onToggle: (id, o) => { open[id] = o; },
    onRaw: (on) => { raw = on; writeRaw(on); paint(); } });
  // The panel is rebuilt at most 4 times a second, and never while a button in it is pressed (a click would land on
  // a replaced button and be lost).
  const paint = () => {
    pending = 0;
    if (!isOpen()) return;
    const ae = win?.document?.activeElement;
    if (pressed || (ae && ae.tagName === "INPUT" && panel.contains?.(ae))) { pending = setTimeout(paint, 150); return; }
    const top = panel.scrollTop;
    const lists = [...panel.querySelectorAll(".ss-act-nodes")].map((u) => [u.closest(".ss-act-det")?.dataset.id, u.scrollTop]);
    panel.replaceChildren(...renderPanel(reg.view(), opts()).childNodes);
    panel.scrollTop = top;
    for (const [id, st] of lists) { const u = panel.querySelector(`.ss-act-det[data-id="${CSS.escape(id || "")}"] .ss-act-nodes`); if (u) u.scrollTop = st; }
  };
  const draw = () => {
    if (!reg.clientId && api.clientId) reg.clientId = api.clientId;
    const v = reg.view();
    const run = v.running.find((r) => r.own) || v.running[0] || null;
    const txt = pillText(v.totals, run);
    lbl.textContent = txt;
    btn.title = `Activity: ${txt}. Every job on the GPU queue, which node yours is on, time left and Cancel for yours`;
    btn.setAttribute("aria-label", btn.title);
    btn.dataset.busy = String(!!(v.totals.running || v.totals.queued));
    timer.update(v);
    mini.hidden = !(run && run.pct != null);
    if (run && run.pct != null) miniFill.style.width = `${run.pct}%`;
    if (isOpen() && !pending) pending = setTimeout(paint, 250);
  };
  const onCancel = async (r) => { await cancelJob(api, r); s.poll(); };
  btn.addEventListener("click", () => {
    if (isOpen()) { closePopover(panel); return; }
    panel = renderPanel(reg.view(), opts());
    panel.classList.add("ss-toppop");
    for (const t of ["pointerdown", "wheel"]) panel.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    panel.addEventListener("pointerdown", () => { pressed = true; }, { capture: true });
    openPopover(panel, { anchor: btn, owner: btn, theme: theme || row, align: "end", gap: 6, name: "activity", remove: true });
    s.poll();
  });
  const up = () => { pressed = false; };
  win?.addEventListener?.("pointerup", up, true);
  win?.addEventListener?.("pointercancel", up, true);
  const pill = { isOpen, pulse() {
    btn.dataset.pulse = "true";
    clearTimeout(pulseT);
    pulseT = setTimeout(() => { delete btn.dataset.pulse; }, 1800);
  } };
  s.pills.add(pill);
  const offChange = reg.onChange(draw);
  draw();
  // The elapsed clocks tick once a second (the pill's ETA and the open panel).
  const sec = setInterval(draw, 1000);
  return {
    button: btn, registry: reg, draw, poll: () => s.poll(),
    dispose() {
      clearInterval(sec); clearTimeout(pending); clearTimeout(pulseT); offChange(); timer.el.remove?.(); s.pills.delete(pill);
      win?.removeEventListener?.("pointerup", up, true);
      win?.removeEventListener?.("pointercancel", up, true);
      if (isOpen()) closePopover(panel);
      btn.remove();
      s.refs -= 1;
      if (s.refs <= 0) s.dispose();
    },
  };
}
