// Live sampling previews (Mike 2026-11-09: "Let's definitely do an image generation preview. For video, have it as an
// option somebody can enable ... as a preview to make sure what's generating for the video is on the right track").
//
// How ComfyUI does it (read on the 0.44.2 pod; 0.43.2 is the same):
//  * The App asks per job: the prompt's extra_data.preview_method ("none" | "auto" | "latent2rgb" | "taesd"; execution.py
//    set_preview_method). No server restart, no --preview-method flag needed. The frontend's api.queuePrompt(number,
//    {output, workflow}, {previewMethod}) puts it there, so the App only sets options.previewMethod on its own queues.
//  * Every sampler (KSampler, SamplerCustom, SamplerCustomAdvanced, and so every router-expanded graph) calls
//    latent_preview.prepare_callback -> ProgressBar.update_absolute(step, total, preview) once per step.
//  * The preview goes over the websocket ONLY to the prompt's client_id, as a binary frame:
//      [u32 BE event] ...  event 1 PREVIEW_IMAGE:               [u32 BE image type 1=JPEG 2=PNG][image bytes]
//                          event 4 PREVIEW_IMAGE_WITH_METADATA: [u32 BE json length][json][image bytes]
//    json = {node_id, prompt_id, display_node_id, parent_node_id, real_node_id, image_type}. Event 4 is sent when the
//    socket said {"type":"feature_flags","data":{"supports_preview_metadata":true}} first (the ComfyUI frontend does).
//    The frontend dispatches b_preview_with_metadata {blob, nodeId, displayNodeId, parentNodeId, realNodeId, jobId}
//    (promptId in older frontends) and then b_preview (the bare blob) for the same frame.
//  * A "progress" JSON message {value, max, prompt_id, node} follows each step, previews on or off.
//  * Decoders: Latent2RGB (a fixed 3×C matrix: colour layout, soft, low resolution) for every family here; TAESD-style
//    tiny decoders only when the file is in models/vae_approx (taef2_decoder for FLUX.2/Klein/Krea 2, taeltx_2 for LTX,
//    taeh3 for MiniMax H3). For video both decoders show only the FIRST latent frame of the clip.
//
//   parsePreviewFrame(buf)                    -> {event, mime, meta, image} | null   (a raw websocket binary frame)
//   previewFromEvent(type, detail)            -> {pid, node, display, blob} | null   (the frontend's two events)
//   previewMethodFor({kind, approx, videoOn}) -> "latent2rgb" | "taesd" | "none" | null (null: leave the job alone)
//   withPreviewOption(args, method)           -> args with options.previewMethod set (api.queuePrompt's 3rd arg)
//   stepLabel(state)                          -> "step 6/12" | "pass 2 · step 3/8"
//   loadVideoPreview / saveVideoPreview       the Motion switch, per viewer (localStorage, try/catch)
//   LivePreviews                              prompt id -> latest preview url + step, only for prompts it was told about
//   attachLivePreviews(api, lp)               wires the frontend's events into a LivePreviews; returns dispose()

export const VIDEO_PREVIEW_KEY = "ss_video_preview";
// Measured on the L40 pod, 2026-11-09, one LTX-2.5 distilled Draft each way (768×416, 49 frames, 8 + 3 steps), ComfyUI's
// own step rate: off 2.57 / 1.57 it/s, on (Latent2RGB) 2.66 / 1.54 it/s, i.e. within run-to-run noise. MiniMax H3's
// tiny-decoder (taeh3) preview was not measured: it decodes a frame per step, so it costs more than Latent2RGB.
export const VIDEO_PREVIEW_COST = "no measurable cost on an LTX-2.5 Draft (L40: 2.57 vs 2.66 steps/s); MiniMax H3's sharper preview is not measured and costs more";
export const VIDEO_PREVIEW_LABEL = "Live preview while rendering (slower)";
export const VIDEO_PREVIEW_TIP = `Show the video's preview while it samples, one picture per step, so you can stop a take that is going the ` +
  `wrong way. Cost: ${VIDEO_PREVIEW_COST}. ComfyUI previews the clip's FIRST frame only (its colour layout, soft), not ` +
  `the motion. Off: the App asks ComfyUI for no previews at all.`;

const EV_PREVIEW = 1, EV_PREVIEW_META = 4;

/** One raw websocket binary frame (ArrayBuffer, typed array or Node Buffer) -> {event, mime, meta, image} or null. */
export function parsePreviewFrame(buf) {
  let u8;
  if (buf instanceof ArrayBuffer) u8 = new Uint8Array(buf);
  else if (ArrayBuffer.isView(buf)) u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else return null;
  if (u8.byteLength < 8) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const event = dv.getUint32(0);
  if (event === EV_PREVIEW) {
    const t = dv.getUint32(4);
    return { event, mime: t === 2 ? "image/png" : "image/jpeg", meta: null, image: u8.subarray(8) };
  }
  if (event === EV_PREVIEW_META) {
    const n = dv.getUint32(4);
    if (8 + n > u8.byteLength) return null;
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + n))); } catch { return null; }
    return { event, mime: meta?.image_type || "image/jpeg", meta, image: u8.subarray(8 + n) };
  }
  return null;
}

/** The frontend's events -> {pid, node, display, blob}. b_preview has no prompt id (pid null: the running job's). */
export function previewFromEvent(type, detail) {
  if (!detail) return null;
  if (type === "b_preview_with_metadata") {
    const blob = detail.blob;
    if (!blob) return null;
    const pid = detail.jobId ?? detail.promptId ?? detail.prompt_id ?? null;
    const str = (x) => (x == null ? null : String(x));
    return { pid: str(pid), node: str(detail.nodeId ?? detail.realNodeId), display: str(detail.displayNodeId ?? detail.parentNodeId ?? detail.nodeId), blob };
  }
  if (type === "b_preview") return { pid: null, node: null, display: null, blob: detail };
  return null;
}

/** Which tiny decoder each family uses (latent_formats.py taesd_decoder_name). */
export const TAE_FOR = { image: "taef2_decoder", ltx: "taeltx_2", h3: "taeh3" };

/**
 * The preview method for one App job. kind: "image" (④ Frame, always on) | "ltx" | "h3" (⑤ Motion, only with the
 * switch on; off asks for "none", so a server started with --preview-method still spends nothing). approx: the file
 * names in models/vae_approx (null: not known yet). "taesd" only where that family's tiny decoder is installed, as
 * ComfyUI's own "auto" means Latent2RGB and a missing decoder only logs a warning per sampler. Unknown kind: null.
 */
export function previewMethodFor({ kind, approx = null, videoOn = false } = {}) {
  if (!TAE_FOR[kind]) return null;
  if (kind !== "image" && !videoOn) return "none";
  const tae = TAE_FOR[kind];
  return (approx || []).some((f) => String(f).startsWith(tae)) ? "taesd" : "latent2rgb";
}

/** api.queuePrompt(number, prompt, options): the same args with options.previewMethod = method (null: unchanged). */
export function withPreviewOption(args, method) {
  if (!method) return args;
  const a = [...args];
  while (a.length < 2) a.push(undefined);
  a[2] = { ...(a[2] && typeof a[2] === "object" ? a[2] : {}), previewMethod: method };
  return a;
}

/** "step 6/12"; a second sampler in the same job (the depth pass, the cast pass) says which pass it is. */
export function stepLabel(st) {
  if (!st || !st.steps) return st?.url ? "sampling…" : "waiting for the GPU…";
  const step = `step ${Math.max(0, Math.min(st.step, st.steps))}/${st.steps}`;
  return st.pass > 1 ? `pass ${st.pass} · ${step}` : step;
}

export function loadVideoPreview(storage) {
  try {
    const s = storage === undefined ? globalThis.localStorage : storage;
    return s?.getItem(VIDEO_PREVIEW_KEY) === "1";
  } catch { return false; }
}

export function saveVideoPreview(on, storage) {
  try {
    const s = storage === undefined ? globalThis.localStorage : storage;
    s?.setItem(VIDEO_PREVIEW_KEY, on ? "1" : "0");
    return true;
  } catch { return false; /* storage blocked: this page only */ }
}

/**
 * The latest preview per prompt, for the prompts the App queued (track(pid, info)); every other prompt's previews are
 * dropped. Object URLs are made per frame and the previous one revoked; untrack/dispose revoke the last. Video jobs
 * also keep the last `keep` frames (the Motion strip). onChange(fn) -> off(); fn(pid, state).
 */
export class LivePreviews {
  constructor({ createURL = (b) => URL.createObjectURL(b), revokeURL = (u) => URL.revokeObjectURL(u), keep = 12, now = () => Date.now() } = {}) {
    this.createURL = createURL; this.revokeURL = revokeURL; this.keep = keep; this.now = now;
    this.jobs = new Map();
    this.running = null;      // the prompt executing now (for b_preview, which has no prompt id)
    this.listeners = new Set();
  }

  track(pid, info = {}) {
    if (!pid) return null;
    const k = String(pid);
    if (!this.jobs.has(k)) this.jobs.set(k, { pid: k, ...info, url: null, frames: [], step: 0, steps: 0, pass: 0, node: null, nodes: [], at: 0 });
    return this.jobs.get(k);
  }

  get(pid) { return pid == null ? null : this.jobs.get(String(pid)) || null; }
  has(pid) { return pid != null && this.jobs.has(String(pid)); }
  list(pred = () => true) { return [...this.jobs.values()].filter(pred); }

  untrack(pid) {
    const st = this.get(pid);
    if (!st) return false;
    for (const u of new Set([st.url, ...st.frames])) if (u) this.revokeURL(u);
    this.jobs.delete(String(pid));
    if (this.running === String(pid)) this.running = null;
    this._emit(String(pid), null);
    return true;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(pid, st) { for (const f of this.listeners) { try { f(pid, st); } catch { /* one listener never breaks the others */ } } }

  /** A preview frame: {pid, node, blob}. pid null = the running job's (old frontends). Returns the state or null. */
  onPreview(p) {
    if (!p?.blob) return null;
    const st = this.get(p.pid ?? this.running);
    if (!st) return null;
    if (p.node != null && p.node !== st.node) this._enterNode(st, p.node);
    const url = this.createURL(p.blob);
    if (st.video) {
      st.frames.push(url);
      while (st.frames.length > this.keep) { const old = st.frames.shift(); if (old !== url) this.revokeURL(old); }
    } else if (st.url) this.revokeURL(st.url);
    st.url = url;
    st.at = this.now();
    this._emit(st.pid, st);
    return st;
  }

  /** ComfyUI's "progress" {value, max, prompt_id, node}: the step count of the sampler that previews. */
  onProgress(d) {
    const st = this.get(d?.prompt_id ?? this.running);
    if (!st || !Number.isFinite(d.value) || !Number.isFinite(d.max) || d.max <= 0) return null;
    const node = d.node != null ? String(d.node) : st.node;
    // A step bar from a node that never previews (a VAE decode, a stage pass) doesn't count as a pass or a step.
    if (node !== st.node && !st.nodes.includes(node)) { st.other = { node, value: d.value, max: d.max }; return null; }
    if (node !== st.node) this._enterNode(st, node);
    st.step = d.value; st.steps = d.max;
    this._emit(st.pid, st);
    return st;
  }

  onExecuting(pid) { this.running = pid == null ? null : String(pid); }

  _enterNode(st, node) {
    st.node = node;
    if (!st.nodes.includes(node)) { st.nodes.push(node); st.pass = st.nodes.length; }
    // the step count we saw for this node before its first preview (progress comes right after each preview)
    if (st.other?.node === node) { st.step = st.other.value; st.steps = st.other.max; } else { st.step = 0; st.steps = 0; }
    st.other = null;
  }

  dispose() { for (const pid of [...this.jobs.keys()]) this.untrack(pid); this.listeners.clear(); }
}

/** Wire the ComfyUI frontend's events into `lp`. One frame arrives as b_preview_with_metadata then b_preview: once the
 *  metadata kind has been seen, the bare one is ignored (else it would land twice). Returns dispose(). */
export function attachLivePreviews(api, lp) {
  let sawMeta = false;
  const onMeta = (ev) => { sawMeta = true; lp.onPreview(previewFromEvent("b_preview_with_metadata", ev?.detail)); };
  const onBare = (ev) => { if (!sawMeta) lp.onPreview(previewFromEvent("b_preview", ev?.detail)); };
  const onProg = (ev) => lp.onProgress(ev?.detail);
  const onExec = (ev) => { const d = ev?.detail; const pid = d && typeof d === "object" ? d.prompt_id : null; if (pid) lp.onExecuting(pid); };
  const onStart = (ev) => { if (ev?.detail?.prompt_id) lp.onExecuting(ev.detail.prompt_id); };
  const pairs = [["b_preview_with_metadata", onMeta], ["b_preview", onBare], ["progress", onProg], ["executing", onExec], ["execution_start", onStart]];
  for (const [t, f] of pairs) api?.addEventListener?.(t, f);
  return () => { for (const [t, f] of pairs) api?.removeEventListener?.(t, f); };
}

/** models/vae_approx file names from ComfyUI (GET /models/vae_approx), once per api; [] when it can't say. */
export async function vaeApprox(api) {
  if (!api) return [];
  if (api.__ssVaeApprox) return api.__ssVaeApprox;
  api.__ssVaeApprox = (async () => {
    try { const r = await api.fetchApi("/models/vae_approx"); const j = r?.ok ? await r.json() : []; return Array.isArray(j) ? j : []; } catch { return []; }
  })();
  return api.__ssVaeApprox;
}

export const LIVE_CSS = `
.ss-pipe .cand.ss-live{position:relative;cursor:default}
.ss-pipe .cand.ss-live img{filter:saturate(1.05)}
.ss-pipe .cand.ss-live .ss-live-step,.ss-livehero .ss-live-step{position:absolute;left:8px;top:8px;background:rgba(10,8,12,.78);color:#fff;
  font:600 12px/1.2 system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:3px 8px;border-radius:999px}
.ss-pipe .cand.ss-live .ss-live-empty{display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;color:#9aa3b0;font-size:12px;background:#0f0d11}
.ss-pipe .cand.ss-live[data-sel="true"]{outline:2px solid #ffb547}
.ss-livehero{position:relative}
.ss-livehero[hidden],.ss-livevid[hidden]{display:none!important}
.ss-stage.ss-cl[data-ws=narrow] .ss-clmedia{position:relative}
.ss-stage.ss-cl .ss-clmedia > .ss-livehero,.ss-stage.ss-cl .ss-clmedia > .ss-livevid{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;gap:6px;
  align-items:stretch;justify-content:center;background:#0f0d11;border-radius:10px;padding:0;border:0}
.ss-stage.ss-cl .ss-clmedia > .ss-livehero > img{flex:1;width:100%!important;height:auto!important;min-height:0;aspect-ratio:auto;object-fit:contain;border:0}
.ss-stage.ss-cl .ss-clmedia > .ss-livevid > .ss-livehero{flex:1;min-height:0;display:flex}
.ss-stage.ss-cl .ss-clmedia > .ss-livevid > .ss-livehero > img{flex:1;width:100%!important;height:100%!important;aspect-ratio:auto;object-fit:contain;border:0}
.ss-stage.ss-cl .ss-clmedia > .ss-livevid > .status{position:absolute;left:10px;bottom:66px;background:rgba(10,8,12,.78);color:#fff;padding:3px 8px;border-radius:999px;font-weight:600;font-size:12px}
.ss-stage.ss-cl .ss-clmedia > .ss-livevid > .ss-livestrip{flex:0 0 auto;justify-content:center;padding:0 8px 8px}
.ss-livehero img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#0f0d11;border-radius:14px;border:1px solid rgba(255,181,71,.45);image-rendering:auto}
.ss-livehero .ss-live-tag{position:absolute;right:10px;top:8px;background:rgba(255,181,71,.92);color:#1a1208;font:700 11px/1 system-ui,sans-serif;padding:4px 8px;border-radius:999px;letter-spacing:.04em}
.ss-livevid{display:grid;gap:6px}
.ss-livevid .ss-livehero img{border-color:rgba(120,190,255,.45)}
.ss-livevid .ss-livestrip{display:flex;gap:4px;overflow-x:auto}
.ss-livevid .ss-livestrip img{height:44px;border-radius:6px;border:1px solid rgba(255,255,255,.1)}
.ss-livevid .ss-livestrip img[data-cur="true"]{border-color:#78beff}
`;
