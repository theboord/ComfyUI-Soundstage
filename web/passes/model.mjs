// Passes: the pure half of the Passes viewer (web/passes/passes.mjs). No DOM; node-tested in tests/js/passes.test.mjs.
//
//   import { discoverPasses, edgeBand, turbo, pearson, peaks } from "./passes/model.mjs";
//
// A "pass" is something the App extracted from a video or a picture, shown so a person can judge it by eye:
//   matte   an alpha matte: ✦ Cutout (BiRefNet / SAM 3.1 RGBA PNG), a Layer Pack layer (SAM 3.1 + BiRefNet edges,
//           RGBA PNG per frame), or Video → 3D's clip masks (binary SAM 3.1 masks, COCO RLE in scene.video2stage.masks)
//   pose    a DWPose read (Real performance: face.json, pose.mp4), or a skeleton the stage draws (the clay, or the
//           SAM 3D Body capture of a Video → 3D performer, seen through the shot camera)
//   talk    a take's sound as a waveform, with the mouth-open curve of a Real performance read
//   depth   the stage depth pass (the guide the render followed), or a Layer Pack's depth AOV
// Every kind always comes back with a list; a source that isn't there is {ok: false, reason}, never left out, so the
// viewer can say why (a hidden pass reads as a missing feature).

export const KINDS = ["matte", "pose", "talk", "depth"];
export const KIND_LABEL = { matte: "Alpha matte", pose: "Pose", talk: "Talking", depth: "Depth" };

/** The band the edge view highlights: alpha strictly between these (0-1). */
export const EDGE_LO = 0.02, EDGE_HI = 0.98;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : String(v));

// ------------------------------------------------------------------------------------------------ file references

/** "sub/dir/x.png [output]" | {filename, subfolder, type} | "/view?filename=…" -> {filename, subfolder, type} (null if none). */
export function viewParts(ref) {
  if (!ref) return null;
  if (isObj(ref)) return ref.filename ? { filename: str(ref.filename), subfolder: str(ref.subfolder), type: str(ref.type || "output") } : null;
  const s = str(ref).trim();
  if (/[?&]filename=/.test(s)) {
    const q = new URLSearchParams(s.slice(s.indexOf("?") + 1));
    return { filename: q.get("filename") || "", subfolder: q.get("subfolder") || "", type: q.get("type") || "output" };
  }
  const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(s);
  const path = m?.[1] || "", type = m?.[2] || "input";
  if (!path) return null;
  const j = path.lastIndexOf("/");
  return { filename: j < 0 ? path : path.slice(j + 1), subfolder: j < 0 ? "" : path.slice(0, j), type };
}

/** A /view path (not yet through api.apiURL) for any file reference. A plain URL (blob:, http, r/…) is returned as is. */
export function viewPath(ref) {
  if (!ref) return "";
  const s = typeof ref === "string" ? ref.trim() : "";
  if (s && !/\[(input|output|temp)\]$/.test(s) && (/^(blob:|data:|https?:|\/view\?)/.test(s) || /^r\//.test(s))) return s;
  const p = viewParts(ref);
  return p ? `/view?${new URLSearchParams({ filename: p.filename, subfolder: p.subfolder, type: p.type })}` : "";
}

/** A Layer Pack file inside its folder -> /view path (packs live in output/soundstage_layerpacks/<pack>/). */
export function packPath(pack, rel) {
  const r = str(rel).replace(/^\/+/, "");
  const j = r.lastIndexOf("/");
  return viewPath({ filename: j < 0 ? r : r.slice(j + 1), subfolder: `soundstage_layerpacks/${pack}${j < 0 ? "" : "/" + r.slice(0, j)}`, type: "output" });
}

/** "layers/10_man/png/man.####.png" + frame number -> "layers/10_man/png/man.1012.png". */
export function framePath(pattern, n) {
  return str(pattern).replace(/#+/, (h) => String(Math.max(0, Math.floor(n))).padStart(h.length, "0"));
}

// ------------------------------------------------------------------------------------------------ discovery

/**
 * Which passes exist for a subject, per kind. subject:
 *   { from: "take" | "ladder" | "v2s", shot: {id, name}, take?: a Dailies take record, chosen?: pipeline.chosen[sid],
 *     renders?: rendersFor(sid), scene?: the stage JSON (shots, actors, reference, video2stage), activeShot?: id,
 *     people?: clay people on the stage (count), demo?: true in the try-it build, packs?: Layer Pack names on the server,
 *     source?: {url, start} the Video → 3D clip as the App plays it (else scene.reference.video) }
 * -> { matte: [src], pose: [src], talk: [src], depth: [src], original: {url, ref, start?} | null }
 * src = { id, type, label, ok, reason?, note?, ...params }. The first ok source of a kind is the one the viewer opens.
 */
export function discoverPasses(subject = {}) {
  const S = subject || {};
  const take = S.take || null, chosen = S.chosen || {}, scene = S.scene || {}, shot = S.shot || {};
  const demo = !!S.demo;
  const out = { matte: [], pose: [], talk: [], depth: [] };
  const add = (kind, src) => { if (!out[kind].some((s) => s.id === src.id)) out[kind].push(src); };
  const v2s = S.from === "v2s" || (!take && !!scene.reference?.video && !!scene.video2stage);
  const onStage = !!shot.id && (scene.shots || []).some((x) => x.id === shot.id);
  const isActive = !!shot.id && (S.activeShot ? S.activeShot === shot.id : scene.active_shot === shot.id);
  const oc = take?.oneclick || null;
  const takeVideo = !!take && (take.video ?? /\.(mp4|webm|mov|m4v)(?:$|[?&#])/i.test(str(take.url)));

  // ---- the original the passes are compared against (A/B, wipe, side by side, flicker)
  let original = null;
  if (v2s && S.source?.url) {
    original = { url: S.source.url, start: Number(S.source.start) || 0, fps: Number(scene.reference?.fps) || 24, label: "The source clip", video: true };
  } else if (v2s && scene.reference?.video) {
    original = { ref: `${scene.reference.video}`.includes("[") ? scene.reference.video : `${scene.reference.video} [input]`,
      start: Number((scene.video2stage?.trim || [])[0]) || Number(scene.reference?.start) || 0, fps: Number(scene.reference?.fps) || 24,
      label: "The source clip", video: true };
  } else if (oc?.from) original = { ref: oc.from, label: "The picture it was cut from", video: /\.(mp4|webm|mov|m4v)(?:\s|$|\[)/i.test(oc.from) };
  else if (take?.url) original = { url: take.url, label: `The take${take.n ? ` (Tk ${take.n})` : ""}`, video: takeVideo };

  // ---- matte
  if (oc?.id === "cutout" && !takeVideo) {
    add("matte", { id: `cutout:${take.id}`, type: "cutout_png", label: `✦ Cutout · ${oc.engine || "RGBA PNG"}`, ok: true, url: take.url,
      note: "The PNG's own alpha (8-bit), straight." });
  } else if (oc?.id === "cutout") {
    const mov = oc.prores?.filename || "";
    add("matte", { id: `cutout_clip:${take.id}`, type: "cutout_clip", label: "✦ Cutout (clip)", ok: false,
      reason: `This clip's alpha is in ProRes 4444${mov ? ` (${mov})` : ""}, and browsers can't decode ProRes. The take you see is a preview on black. ` +
        "Open the .mov in Resolve, Nuke or After Effects, or make a Layer Pack in ⑦ Deliver: its mattes are PNG frames you can judge here." });
  }
  const pack = str(chosen.layerpack || "");
  if (pack) add("matte", { id: `pack:${pack}`, type: "layerpack", label: `Layer Pack · ${pack}`, ok: true, pack,
    note: "SAM 3.1 tracks with BiRefNet edges, one RGBA PNG per frame per layer." });
  for (const p of (S.packs || []).filter((n) => n && n !== pack)) {
    add("matte", { id: `pack:${p}`, type: "layerpack", label: `Layer Pack · ${p} (not linked to this shot)`, ok: true, pack: p, unlinked: true,
      note: "Made before the App started remembering which shot a pack belongs to: check it is this shot." });
  }
  const masks = scene.video2stage?.masks;
  const maskRefs = [];
  for (const g of ["people", "objects"]) for (const [id, per] of Object.entries((isObj(masks) && masks[g]) || {})) if (isObj(per) && Object.keys(per).length) maskRefs.push(`${g}/${id}`);
  if (v2s) {
    if (maskRefs.length) {
      add("matte", { id: "v2s_masks", type: "v2s_masks", label: `Video → 3D clip masks (${maskRefs.length})`, ok: true, refs: maskRefs,
        note: "Binary SAM 3.1 masks at the rebuild's working size: there is no soft edge to judge, only where the line falls." });
    } else {
      add("matte", { id: "v2s_masks", type: "v2s_masks", label: "Video → 3D clip masks", ok: false,
        reason: demo ? "The recorded Video → 3D run in this demo kept no clip masks." : "This rebuild kept no clip masks (they come from its people and layout tracks; this run had none)." });
    }
  }
  if (!out.matte.some((s) => s.ok) && !out.matte.some((s) => s.type === "cutout_clip")) {
    add("matte", { id: "none", type: "none", label: "No matte yet", ok: false,
      reason: (demo ? "The try-it demo has no matte media: cutouts and Layer Packs are made on the GPU server, and none were recorded for it. " : "") +
        "Make one with ✦ One-click › Cutout (BiRefNet, or SAM 3.1 with a subject) on a take, or a Layer Pack in ⑦ Deliver (SAM 3.1 with BiRefNet edges, one layer per actor)." });
  }

  // ---- pose (and talk: both read a Real performance asset)
  const perfRef = take?.asset || (take?.performance ? chosen.performance?.asset : "") || chosen.performance?.asset || "";
  if (perfRef) {
    const name = take?.label?.replace(/^Performance · /, "") || chosen.performance?.name || "";
    add("pose", { id: `perf:${perfRef}`, type: "performance", label: `DWPose read · ${name || "Real performance"}`, ok: true, asset: perfRef,
      note: "Body (18 points), hands (21 each) and the 68 face points, read by DWPose on every frame of the actor's clip." });
    add("talk", { id: `perf:${perfRef}`, type: "performance", label: `Actor's voice and mouth · ${name || "Real performance"}`, ok: true, asset: perfRef });
  } else {
    add("pose", { id: "dwpose", type: "none", label: "DWPose read", ok: false,
      reason: "No DWPose read of this clip. Real performance… (select a person; it is in the Motion capture row) reads the body, both hands and the 68 face points of an actor's clip." });
  }
  const mocap = (scene.actors || []).filter((a) => a?.mocap);
  if (v2s && mocap.length) {
    add("pose", { id: "v2s_body", type: "stage_pose", label: `Captured body (SAM 3D Body) · ${mocap.map((a) => a.name || a.id).join(", ")}`, ok: !!isActive,
      ...(isActive ? {} : { reason: "Open the clip's shot (Source camera) on the stage first: the skeleton is drawn through its camera." }),
      note: "The 3D capture drawn through the clip's solved camera, over the source. It has no per-point confidence." });
  } else if (onStage && (S.people || 0) > 0) {
    add("pose", { id: "stage_pose", type: "stage_pose", label: "Stage skeleton (the clay, through the shot camera)", ok: !!isActive,
      ...(isActive ? {} : { reason: "Open this shot on the stage first: the skeleton is drawn from its camera." }),
      note: "The clay people's pose, which Pose follow hands to LTX. It is not read from the video, so it has no confidence." });
  }
  add("pose", { id: "recast", type: "none", label: "Recast guide", ok: false,
    reason: "Recast builds its DWPose guide inside the ComfyUI graph and doesn't save it, so there is nothing to show here." });

  // ---- talk
  if (takeVideo) add("talk", { id: `audio:${take.id}`, type: "audio", label: "The take's sound", ok: true, url: take.url,
    note: "The waveform of the take's own sound track (a take without sound says so)." });
  if (v2s && (original?.ref || original?.url)) add("talk", { id: "audio:v2s", type: "audio", label: "The source clip's sound", ok: true, ref: original.ref, url: original.url });
  if (!out.talk.some((s) => s.ok)) add("talk", { id: "none", type: "none", label: "No sound", ok: false,
    reason: take && !takeVideo ? "A still has no sound." : "Nothing with sound here: open a Draft or Final take, or a Real performance." });
  if (!perfRef) add("talk", { id: "mouth", type: "none", label: "Mouth-open curve", ok: false,
    reason: "The App measures the mouth only on a Real performance read (the inner-lip gap over the face height, per frame)." });

  // ---- depth
  if (pack) add("depth", { id: `packdepth:${pack}`, type: "pack_depth", label: `Layer Pack depth · ${pack}`, ok: true, pack,
    note: "aovs/depth_vis: near = white, normalised per frame (the EXRs hold true metres)." });
  if (onStage) {
    add("depth", { id: "stage_depth", type: "stage_depth", label: v2s ? "Stage depth through the clip's camera" : "Stage depth (the guide the render followed)", ok: true, shot: shot.id,
      note: "From the 3D stage: near = white, linear from 1 m to 40 m. It is not measured from the video." });
  }
  add("depth", { id: "video_depth", type: "none", label: "Depth from the video", ok: false,
    reason: v2s ? "Video → 3D runs Depth Anything 3 on the server and keeps only the fused set scan, not the per-frame depth."
      : "No depth was measured from this video: the App runs Depth Anything 3 only inside Video → 3D, and doesn't save it." });

  return { ...out, original };
}

/** The first kind with an ok source, matte first (the pass people judge most). */
export function firstKind(found) {
  return KINDS.find((k) => (found?.[k] || []).some((s) => s.ok)) || "matte";
}

/** "3 of 4": how many kinds have something to show. */
export function availableCount(found) {
  return KINDS.filter((k) => (found?.[k] || []).some((s) => s.ok)).length;
}

// ------------------------------------------------------------------------------------------------ matte maths

/**
 * The soft-edge band of an alpha matte: pixels with lo < alpha < hi. alpha: one value per pixel (0..max), or RGBA
 * (stride 4, alpha in channel 3). -> { band: Uint8Array (1 = in the band), count, fraction (of the frame),
 * boundary (pixels on the 0.5 line: >= 0.5 with a 4-neighbour below it), width (count / boundary: the band's mean
 * thickness in pixels, 0 for a hard edge), hard (no band at all but a boundary), bbox: [x0, y0, x1, y1] | null }.
 */
export function edgeBand(alpha, w, h, { lo = EDGE_LO, hi = EDGE_HI, max = 255, stride = 1, offset = 0 } = {}) {
  const n = w * h;
  const band = new Uint8Array(n);
  const a = (i) => alpha[i * stride + offset] / max;
  let count = 0, boundary = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, v = a(i);
      if (v > lo && v < hi) {
        band[i] = 1; count++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (v >= 0.5 && ((x > 0 && a(i - 1) < 0.5) || (x < w - 1 && a(i + 1) < 0.5) || (y > 0 && a(i - w) < 0.5) || (y < h - 1 && a(i + w) < 0.5))) boundary++;
    }
  }
  return { band, count, fraction: n ? count / n : 0, boundary, width: boundary ? count / boundary : 0, hard: count === 0 && boundary > 0,
    bbox: x1 < 0 ? null : [x0, y0, x1, y1] };
}

/** One line for the edge view: "Soft edge 1,204 px (0.6 %) · about 2.3 px wide". */
export function edgeLine(st) {
  if (!st) return "";
  if (!st.count && !st.boundary) return "Empty matte: nothing is kept on this frame.";
  if (st.hard) return `Hard edge: no pixel between ${EDGE_LO} and ${EDGE_HI} alpha (${st.boundary.toLocaleString("en-US")} px on the line). Hair and motion blur will cut out sharp.`;
  return `Soft edge ${st.count.toLocaleString("en-US")} px (${(st.fraction * 100).toFixed(st.fraction < 0.01 ? 2 : 1)} % of the frame) · about ${st.width.toFixed(1)} px wide`;
}

/** Rubylith: the original with red laid over what the matte throws away (opacity × (1 - alpha)). In place on rgba. */
export function rubylith(rgba, alpha, { opacity = 0.55, stride = 1, max = 255, color = [230, 20, 30] } = {}) {
  for (let i = 0, p = 0; p < rgba.length; i++, p += 4) {
    const k = opacity * (1 - alpha[i * stride + (stride === 4 ? 3 : 0)] / max);
    rgba[p] += (color[0] - rgba[p]) * k; rgba[p + 1] += (color[1] - rgba[p + 1]) * k; rgba[p + 2] += (color[2] - rgba[p + 2]) * k;
  }
  return rgba;
}

/** A busy test background (stripes, a gradient, fine checks, colour patches): fill an RGBA buffer w x h. */
export function busyBackground(w, h) {
  const px = new Uint8ClampedArray(w * h * 4);
  const pal = [[255, 40, 40], [40, 220, 60], [40, 90, 255], [255, 230, 30], [255, 255, 255], [10, 10, 10], [255, 60, 220], [30, 230, 230]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    let c;
    const u = x / Math.max(1, w), v = y / Math.max(1, h);
    if (v < 0.33) c = pal[Math.floor((x + y) / 9) % pal.length];                                   // diagonal colour stripes
    else if (v < 0.66) { const g = Math.round(u * 255); c = ((x >> 1) + (y >> 1)) % 2 ? [g, g, g] : [255 - g, 128, g]; }   // gradient with 2 px checks
    else c = (Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? pal[(Math.floor(x / 48) + 3) % pal.length] : [(x * 7) % 256, (y * 13) % 256, ((x ^ y) * 5) % 256];
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
  }
  return px;
}

// ------------------------------------------------------------------------------------------------ depth

/** Google's Turbo colour map (Mikhailov 2019, Apache-2.0), polynomial fit: t in 0..1 -> [r, g, b] 0..255. */
export function turbo(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  const c = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
  return [c(r), c(g), c(b)];
}

/** A depth value v (0..1, near = 1) through the near/far window [lo, hi] (0..1 of the encoded range) -> 0..1, near = 1. */
export function remapDepth(v, lo = 0, hi = 1) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  if (b - a < 1e-6) return v >= b ? 1 : 0;
  return Math.min(1, Math.max(0, (v - a) / (b - a)));
}

/** The stage depth encoding (near = white, linear 1..40 m) -> metres. */
export const STAGE_NEAR = 1, STAGE_FAR = 40;
export const stageMetres = (v) => STAGE_NEAR + (1 - Math.min(1, Math.max(0, v))) * (STAGE_FAR - STAGE_NEAR);

// ------------------------------------------------------------------------------------------------ pose

/** Confidence -> colour: red below 0.3 (DWPose's own cut-off), amber to 0.6, green above. */
export function confColor(c) {
  const v = Number(c);
  if (!Number.isFinite(v)) return "#ffffff";
  return v < 0.3 ? "#ff4040" : v < 0.6 ? "#ffb020" : "#3ddc84";
}

/** One frame of a Real performance face.json -> {face: [[x, y, c]] (0-1 units), body, hands: [l, r] | null}. */
export function poseFrame(kp, f) {
  const fr = kp?.frames?.[Math.max(0, Math.min((kp.frames.length || 1) - 1, Math.floor(f)))] || null;
  if (!fr) return { face: null, body: null, hands: null, mouth: null };
  return { face: fr.face || null, body: fr.body || null, hands: fr.hands || null, mouth: fr.mouth ?? null };
}

/** The mouth box of a 68-point face (points 48-67), padded, in 0-1 units; null without a face. */
export function mouthBox(face, pad = 0.6) {
  const pts = (face || []).slice(48, 68).filter((p) => p && p[2] !== 0 && p[0] >= 0 && p[1] >= 0);
  if (pts.length < 6) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = Math.max(x1 - x0, y1 - y0) * (1 + pad);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2];
}

// ------------------------------------------------------------------------------------------------ talk

/** Pearson correlation over the frames where both curves have a value (null = not read). null below 3 pairs. */
export function pearson(a, b) {
  const xs = [], ys = [];
  for (let i = 0; i < Math.min(a?.length || 0, b?.length || 0); i++) {
    if (a[i] == null || b[i] == null || !Number.isFinite(+a[i]) || !Number.isFinite(+b[i])) continue;
    xs.push(+a[i]); ys.push(+b[i]);
  }
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** The lag (frames, -k..k) where b best follows a, and its r. -> {lag, r} | null. b shifted by +lag means b is late. */
export function bestLag(a, b, k = 4) {
  let best = null;
  for (let lag = -k; lag <= k; lag++) {
    const bb = (b || []).map((_, i) => b[i + lag] ?? null);
    const r = pearson(a, bb);
    if (r != null && (!best || r > best.r)) best = { lag, r };
  }
  return best;
}

/** Audio samples -> n buckets of [min, max] (a waveform's columns). */
export function peaks(samples, n) {
  const out = [];
  const len = samples?.length || 0;
  if (!len || n <= 0) return out;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * len) / n), b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
    let lo = 0, hi = 0;
    for (let j = a; j < b && j < len; j++) { const v = samples[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out.push([lo, hi]);
  }
  return out;
}

/** f / frames as "f 12 / 96 · 0:00.50". */
export function frameLabel(f, frames, fps = 24) {
  const s = Math.max(0, f) / (fps || 24);
  return `f ${f} / ${Math.max(0, frames - 1)} · ${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

/** A still's file name: soundstage_<shot>_<kind>_<mode>_f012.png. */
export function stillName(shot, kind, mode, f) {
  const s = (v) => str(v).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
  return `soundstage_${s(shot)}_${s(kind)}_${s(mode)}_f${String(Math.max(0, Math.floor(f))).padStart(3, "0")}.png`;
}
