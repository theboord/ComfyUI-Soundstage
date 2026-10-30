// Soundstage 3D asset maker: photos -> things the stage can load. Core ComfyUI nodes only, run through the
// queue exactly like the object designer, so every result lands in ComfyUI's output folder behind a /view URL.
//
//   import * as maker from "./assets3d/maker.mjs";
//   maker.useApi(api);                                       // once (ComfyUI's scripts/api.js `api`)
//   const s = await maker.photoToSplat(file);                // {url, format:"ply", bbox, ...}
//   const m = await maker.photoToMesh(file, {kind: "set"});  // {url, format:"glb", fov_deg, camera, ...}
//   const c = await maker.photoToCutout(file);               // {url, format:"png", width, height}
//
// Every function accepts a File/Blob (uploaded to input/soundstage/), or the name of an image already in
// ComfyUI's input folder ("photo.png", "soundstage/photo.png"). Options common to all: {api, onStatus,
// timeoutMs, prefix}. Results also carry {prompt_id, seconds, file:{filename, subfolder, type}}.
//
// Pipelines (official core wiring, see docs/assets3d.md):
//   splat   [BiRefNet bg removal] -> TripoSplatPreprocessImage -> DINOv3 + Flux2-VAE TripoSplatConditioning
//           -> KSampler(triposplat, 20 steps, cfg 3, dpmpp_2m/simple) -> VAEDecodeTripoSplat -> SplatToFile3D(ply)
//   mesh    object: the splat above -> SplatToMesh (vertex-coloured, closed-ish)      -> SaveGLB
//           set:    LoadDA3Model -> DA3Inference(mono) -> DA3GeometryToMesh(texture)  -> SaveGLB, + camera FOV
//   cutout  BiRefNet bg removal -> JoinImageWithAlpha -> SaveImage (RGBA PNG)

let defaultApi = null;

/** Set the ComfyUI api object used when a call does not pass {api}. */
export function useApi(api) {
  defaultApi = api;
}

const MODELS = {
  unet: "triposplat_fp16.safetensors",
  vaeDecoder: "triposplat_vae_decoder_fp16.safetensors",
  vaeFlux2: "flux2-vae-triposplat.safetensors",
  dino: "dino_v3_vit_h.safetensors",
  birefnet: "birefnet.safetensors",
  da3: "depth_anything_3_mono_large.safetensors",
};

const viewUrl = (f) => `/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}`
  + `&type=${encodeURIComponent(f.type || "output")}`;

const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

// ------------------------------------------------------------------------------------------- plumbing

async function json(api, path, init) {
  const r = await api.fetchApi(path, init);
  const body = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new Error(body.error?.message || body.error || `${path} failed (${r.status})`);
  return body;
}

/** Upload a File/Blob to input/soundstage/, or pass an existing input name through. Returns the LoadImage name. */
export async function uploadImage(input, { api = defaultApi } = {}) {
  if (typeof input === "string") return input;
  const name = input.name || `photo_${stamp()}.png`;
  const body = new FormData();
  body.append("image", input instanceof File ? input : new File([input], name, { type: input.type || "image/png" }));
  body.append("type", "input");
  body.append("subfolder", "soundstage");
  body.append("overwrite", "true");
  const j = await json(api, "/upload/image", { method: "POST", body });
  return `${j.subfolder ? j.subfolder + "/" : ""}${j.name}`;
}

/** Which background remover the pod can run: core BiRefNet (MIT) first, RMBG-2.0 node (CC BY-NC) as fallback. */
const bgCache = new WeakMap(); // per api object (one ComfyUI server)
export async function backgroundRemover({ api = defaultApi } = {}) {
  if (bgCache.has(api)) return bgCache.get(api);
  const pick = await detectRemover(api);
  if (pick.kind !== "none") bgCache.set(api, pick); // retry "none" next time: the server may have restarted
  return pick;
}

async function detectRemover(api) {
  try {
    const info = await json(api, "/object_info/LoadBackgroundRemovalModel");
    const opt = info.LoadBackgroundRemovalModel?.input?.required?.bg_removal_name;
    const names = Array.isArray(opt?.[0]) ? opt[0] : opt?.[1]?.options || [];
    if (names.includes(MODELS.birefnet)) return { kind: "core", model: MODELS.birefnet, license: "MIT" };
  } catch { /* older core */ }
  try {
    const info = await json(api, "/object_info/RMBG");
    if (info.RMBG) return { kind: "rmbg", model: "RMBG-2.0", license: "CC BY-NC 4.0 (non-commercial)" };
  } catch { /* not installed */ }
  return { kind: "none" };
}

/** Graph fragment: object mask (1 = object) for image ref `img`. Adds nodes to g, returns [nodeId, slot]. */
function maskNodes(g, img, alphaMask, bg) {
  if (bg.kind === "core") {
    g.bg1 = { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: bg.model } };
    g.bg2 = { class_type: "RemoveBackground", inputs: { bg_removal_model: ["bg1", 0], image: img } };
    return ["bg2", 0];
  }
  if (bg.kind === "rmbg") {
    g.bg2 = { class_type: "RMBG", inputs: { image: img, model: bg.model, sensitivity: 1.0, process_res: 1024, mask_blur: 0,
      mask_offset: 0, invert_output: false, refine_foreground: false, background: "Alpha", background_color: "#222222" } };
    return ["bg2", 1];
  }
  // No remover: use the photo's own alpha (LoadImage's mask is 1 where transparent, so invert it).
  g.bg3 = { class_type: "InvertMask", inputs: { mask: alphaMask } };
  return ["bg3", 0];
}

/** Queue a graph and wait for it in /history (robust to missed websocket events). Returns {outputs, seconds, prompt_id}. */
export async function runGraph(graph, { api = defaultApi, timeoutMs = 900000, onStatus = () => {}, front = false } = {}) {
  if (!api) throw new Error("maker: call useApi(api) first or pass {api}");
  const t0 = Date.now();
  const q = await json(api, "/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: api.clientId, front }) });
  if (!q.prompt_id) throw new Error(q.error?.message || "the server refused the job");
  const pid = q.prompt_id;
  let lastQueueCheck = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 750));
    let h = {};
    try { h = await json(api, `/history/${pid}`); } catch { continue; } // tunnel blink: keep waiting
    const item = h[pid];
    if (item?.status?.completed !== undefined && (item.status.completed || item.status.status_str === "error")) {
      if (item.status.status_str === "error") {
        const err = (item.status.messages || []).find((m) => m[0] === "execution_error")?.[1];
        throw new Error(err ? `${err.node_type}: ${err.exception_message}`.trim() : "the job failed");
      }
      return { outputs: item.outputs || {}, seconds: (Date.now() - t0) / 1000, prompt_id: pid };
    }
    if (Date.now() - lastQueueCheck > 5000) {
      lastQueueCheck = Date.now();
      try {
        const qq = await json(api, "/queue");
        const ahead = (qq.queue_pending || []).findIndex((x) => x[1] === pid);
        const running = (qq.queue_running || []).some((x) => x[1] === pid);
        if (ahead >= 0) onStatus(`Queued (${ahead + 1} job${ahead ? "s" : ""} ahead)…`);
        else if (running) onStatus(`Working… ${Math.round((Date.now() - t0) / 1000)} s`);
        else if (!h[pid]) {
          const again = await json(api, `/history/${pid}`).catch(() => ({}));
          if (!again[pid]) throw new Error("the job left the queue without a result (server restarted?)");
        }
      } catch (e) { if (String(e.message).includes("left the queue")) throw e; }
    }
  }
  // Give up: take the job out of the queue so an abandoned request doesn't run later.
  try {
    await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [pid] }) });
  } catch { /* best effort */ }
  throw new Error(`no result after ${Math.round(timeoutMs / 1000)} s (queue busy?)`);
}

/** First saved file of an output node: SaveGLB / SaveImage report {filename, subfolder, type}. */
function savedFile(outputs, node) {
  const o = outputs[node] || {};
  for (const key of ["3d", "result", "images", "meshes", "files", "model_3d"]) {
    const v = o[key];
    const f = Array.isArray(v) ? v.find((x) => x && typeof x === "object" && x.filename) : null;
    if (f) return f;
  }
  for (const v of Object.values(o)) {
    const f = Array.isArray(v) ? v.find((x) => x && typeof x === "object" && x.filename) : null;
    if (f) return f;
  }
  throw new Error(`no file in the output of node ${node}`);
}

async function inspect(api, f) {
  try {
    return await json(api, `/soundstage/assets3d/inspect?filename=${encodeURIComponent(f.filename)}`
      + `&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${encodeURIComponent(f.type || "output")}`);
  } catch { return {}; } // route not mounted yet: the stage can still measure the file itself
}

// ------------------------------------------------------------------------------------------- graphs

function splatNodes(g, img, alphaMask, bg, { gaussians, steps, seed, cfg, removeBg }) {
  const mask = removeBg ? maskNodes(g, img, alphaMask, bg) : maskNodes(g, img, alphaMask, { kind: "none" });
  g.t1 = { class_type: "TripoSplatPreprocessImage", inputs: { image: img, mask, erode_radius: 1, size: 1024 } };
  g.t2 = { class_type: "CLIPVisionLoader", inputs: { clip_name: MODELS.dino } };
  g.t3 = { class_type: "VAELoader", inputs: { vae_name: MODELS.vaeFlux2 } };
  g.t4 = { class_type: "TripoSplatConditioning", inputs: { clip_vision: ["t2", 0], vae: ["t3", 0], image: ["t1", 0] } };
  g.t5 = { class_type: "UNETLoader", inputs: { unet_name: MODELS.unet, weight_dtype: "default" } };
  g.t6 = { class_type: "KSampler", inputs: { model: ["t5", 0], positive: ["t4", 0], negative: ["t4", 1], latent_image: ["t4", 2],
    seed, steps, cfg, sampler_name: "dpmpp_2m", scheduler: "simple", denoise: 1 } };
  g.t7 = { class_type: "VAELoader", inputs: { vae_name: MODELS.vaeDecoder } };
  g.t8 = { class_type: "VAEDecodeTripoSplat", inputs: { samples: ["t6", 0], vae: ["t7", 0],
    num_gaussians: Math.max(32768, Math.round(gaussians / 32) * 32), seed } };
  return ["t8", 0];
}

const rand = () => Math.floor(Math.random() * 2 ** 31);

// ------------------------------------------------------------------------------------------- API

/**
 * Photo -> Gaussian splat (TripoSplat). Best on a single object or character.
 * @returns {Promise<{url, format:"ply", bbox:{min,max,size,center}|undefined, count, file, prompt_id, seconds,
 *   proxy?:{url, format:"glb"}}>}  proxy = clay mesh of the splat when {proxy:true}
 */
export async function photoToSplat(input, { gaussians = 131072, removeBg = true, steps = 20, cfg = 3, seed = rand(),
  proxy = false, proxyFaces = 40000, format = "ply", prefix = "soundstage/splat", ...o } = {}) {
  const api = o.api || defaultApi;
  const name = await uploadImage(input, { api });
  const bg = removeBg ? await backgroundRemover({ api }) : { kind: "none" };
  const g = { in: { class_type: "LoadImage", inputs: { image: name } } };
  const splat = splatNodes(g, ["in", 0], ["in", 1], bg, { gaussians, steps, seed, cfg, removeBg });
  g.f1 = { class_type: "SplatToFile3D", inputs: { splat, format } };
  g.s1 = { class_type: "SaveGLB", inputs: { mesh: ["f1", 0], filename_prefix: `${prefix}_${stamp()}` } };
  if (proxy) {
    g.m1 = { class_type: "SplatToMesh", inputs: { splat, resolution: 192, kernel: 5, smooth: 4, level: 0.6,
      min_component: 500, min_opacity: 0.02, color_sharpen: 2 } };
    // A clay stand-in only: decimate hard so the browser stays responsive (≤ proxyFaces faces, ~1-2 MB).
    g.m2 = { class_type: "DecimateMesh", inputs: { mesh: ["m1", 0], target_face_count: proxyFaces, placement_mode: "midpoint" } };
    g.s2 = { class_type: "SaveGLB", inputs: { mesh: ["m2", 0], filename_prefix: `${prefix}_proxy_${stamp()}` } };
  }
  o.onStatus?.("Building the splat…");
  const r = await runGraph(g, { api, ...o });
  const f = savedFile(r.outputs, "s1");
  const info = await inspect(api, f);
  const out = { url: viewUrl(f), format, bbox: info.bbox, count: info.count, file: f, prompt_id: r.prompt_id,
    seconds: r.seconds, seed, background: bg.kind === "none" ? "photo alpha" : `${bg.model} (${bg.license})` };
  if (proxy) {
    const pf = savedFile(r.outputs, "s2");
    out.proxy = { url: viewUrl(pf), format: "glb", file: pf, bbox: (await inspect(api, pf)).bbox };
  }
  return out;
}

/**
 * Photo -> textured mesh (GLB).
 *  kind "object": full 3D object (TripoSplat splat -> SplatToMesh, vertex colours). Background removed.
 *  kind "set":    the photo as a 2.5D location (Depth Anything 3 mono depth -> textured mesh), plus the
 *                 camera that took it, so the stage camera can be matched to the plate.
 * @returns {Promise<{url, format:"glb", kind, bbox, file, prompt_id, seconds,
 *   fov_deg?:{h, v}, camera?:{position, target, focal_mm}, to_stage?:{flip_xyz, scale, offset}}>}
 */
export async function photoToMesh(input, { kind = "object", resolution = 504, decimation = 1, seed = rand(), steps = 20,
  meshResolution = 256, faces = 100000,
  prefix = "soundstage/mesh", ...o } = {}) {
  const api = o.api || defaultApi;
  const name = await uploadImage(input, { api });
  const g = { in: { class_type: "LoadImage", inputs: { image: name } } };
  if (kind === "object") {
    const bg = await backgroundRemover({ api });
    const splat = splatNodes(g, ["in", 0], ["in", 1], bg, { gaussians: 262144, steps, seed, cfg: 3, removeBg: true });
    // 256 keeps the GLB browser-sized (~0.4 M verts); 384 (the template) gives ~0.9 M verts / 43 MB.
    g.m1 = { class_type: "SplatToMesh", inputs: { splat, resolution: meshResolution, kernel: 5, smooth: 2, level: 0.6,
      min_component: 500, min_opacity: 0.02, color_sharpen: 2 } };
  } else {
    g.d1 = { class_type: "LoadDA3Model", inputs: { model_name: MODELS.da3, weight_dtype: "default" } };
    g.d2 = { class_type: "DA3Inference", inputs: { da3_model: ["d1", 0], image: ["in", 0], resolution,
      resize_method: "upper_bound_resize", mode: "mono" } };
    g.m1 = { class_type: "DA3GeometryToMesh", inputs: { da3_geometry: ["d2", 0], batch_index: 0, decimation,
      discontinuity_threshold: 0.04, confidence_threshold: 0.1, use_sky_mask: true, texture: true } };
  }
  let mesh = ["m1", 0];
  if (kind === "object" && faces > 0) {  // SplatToMesh is ~0.4 M faces at res 256: decimate to a browser-friendly size
    g.m2 = { class_type: "DecimateMesh", inputs: { mesh, target_face_count: faces, placement_mode: "qem",
      "placement_mode.line_quadric_weight": 0, "placement_mode.feature_edge_quadric_weight": 0,
      "placement_mode.feature_edge_min_dihedral_deg": 30, "placement_mode.clamp_v_to_edge": true } };
    mesh = ["m2", 0];
  }
  g.s1 = { class_type: "SaveGLB", inputs: { mesh, filename_prefix: `${prefix}_${kind}_${stamp()}` } };
  o.onStatus?.(kind === "set" ? "Measuring the location…" : "Building the object…");
  const r = await runGraph(g, { api, ...o });
  const f = savedFile(r.outputs, "s1");
  const info = await inspect(api, f);
  const out = { url: viewUrl(f), format: "glb", kind, bbox: info.bbox, file: f, prompt_id: r.prompt_id, seconds: r.seconds };
  if (kind === "set" && info.camera) Object.assign(out, { fov_deg: info.fov_deg, camera: info.camera, intrinsics: info.intrinsics, to_stage: info.to_stage });
  return out;
}

/** Photo -> transparent PNG cut-out (for 2.5D cards). @returns {Promise<{url, format:"png", file, prompt_id, seconds, background}>} */
export async function photoToCutout(input, { prefix = "soundstage/cutout", ...o } = {}) {
  const api = o.api || defaultApi;
  const name = await uploadImage(input, { api });
  const bg = await backgroundRemover({ api });
  const g = { in: { class_type: "LoadImage", inputs: { image: name } } };
  const mask = maskNodes(g, ["in", 0], ["in", 1], bg);
  g.c1 = { class_type: "InvertMask", inputs: { mask } };
  g.c2 = { class_type: "JoinImageWithAlpha", inputs: { image: ["in", 0], alpha: ["c1", 0] } };
  g.s1 = { class_type: "SaveImage", inputs: { images: ["c2", 0], filename_prefix: `${prefix}_${stamp()}` } };
  o.onStatus?.("Cutting out…");
  const r = await runGraph(g, { api, ...o });
  const f = savedFile(r.outputs, "s1");
  return { url: viewUrl(f), format: "png", file: f, prompt_id: r.prompt_id, seconds: r.seconds,
    background: bg.kind === "none" ? "photo alpha" : `${bg.model} (${bg.license})` };
}

/** Exposed for tests and the docs: the exact graphs the functions queue. */
export const _graphs = { splatNodes, maskNodes, MODELS };
