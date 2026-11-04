// The one add-on LoRA of ④ Frame (pipeline.mjs) and ⑤ Motion's Extra LoRA (web/motion/ltxadvanced.mjs): every LoRA in
// models/loras, the ones whose name or folder says they fit the model first. Pure (tests/js/loras.test.mjs). The server
// reads each chosen file's own header and stops with a sentence when it was made for another family
// (soundstage/router/lora_check.py, soundstage/nodes_quality.py SoundstageLTXLoRA).

export const LORA_FAMILY = [
  ["klein", /klein|flux[-_ .]?[23]\b|flux[-_ .]?[23][-_ .]/i], ["krea", /krea/i], ["ltx", /ltx/i], ["wan", /\bwan[-_ .]?\d|wan2|(^|[\\/_-])wan([\\/_-]|$)/i],
  ["hunyuan", /hunyuan/i], ["qwen", /qwen/i], ["sdxl", /sdxl|(^|[^a-z])xl([^a-z]|$)|pony|illustrious/i],
  ["flux1", /flux[-_ .]?(?:1|dev|schnell)\b|flux[-_ .]?1[-_ .]/i], ["sd", /\bsd[-_ ]?(?:1\.?5|15|2\.?1|v1|v2)\b/i],
];
const LORA_PRIVATE = /(^|[\\/])(downloads?|private|nda|clients?)([\\/]|$)/i;
export const LORA_MATCH_LABEL = "Matches this model", LORA_OTHER_LABEL = "Other LoRAs (may not work with this model)";
/** The model family a LoRA's name or folder says it is for, or null. */
export function loraFamily(name) {
  const s = String(name || "");
  return LORA_FAMILY.find(([, rx]) => rx.test(s))?.[0] || null;
}
/** The family of the image model that paints the frame (the frame node's model key), or null. */
export const frameModelFamily = (key) => (/klein/i.test(String(key || "")) ? "klein" : /^Krea 2/i.test(String(key || "")) ? "krea" : null);
/** -> {match: [...], other: [...]} of LoRA file names ("None" is not in either). */
export function stillLoraGroups(vals, modelKey = null, current = null) {
  const fam = frameModelFamily(modelKey);
  const match = [], other = [];
  for (const v of vals || []) {
    const s = String(v);
    if (s === "None" || !s || match.includes(s) || other.includes(s)) continue;
    if (LORA_PRIVATE.test(s) && s !== current) continue;
    (fam && loraFamily(s) === fam ? match : other).push(s);
  }
  return { match, other };
}
/** The warning under the add-on list ("" when the LoRA matches the frame model, or there is none). */
export function stillLoraWarning(name, modelKey = null) {
  if (!name || name === "None") return "";
  const fam = frameModelFamily(modelKey), got = loraFamily(name);
  if (fam && got === fam) return "";
  const NAMES = { klein: "FLUX 3 Klein", krea: "Krea 2", ltx: "LTX video", wan: "Wan video", hunyuan: "HunyuanVideo", qwen: "Qwen-Image", sdxl: "SDXL", flux1: "FLUX.1", sd: "Stable Diffusion 1.5/2" };
  const model = NAMES[fam] || "this model";
  return got ? `Looks like a ${NAMES[got]} LoRA: it may not work with ${model} (if its file says so, the frame stops and tells you).`
    : `Not sure this LoRA was made for ${model}: it may do nothing, or change the picture in odd ways. Try a strength of 0.6–0.8 first.`;
}
/** ⑤ Motion's Extra LoRA list: {match: LTX LoRAs, other: the rest}; the chosen one stays listed even if it's gone. */
export function ltxLoraGroups(vals, current = null) {
  const match = [], other = [];
  const all = [...(vals || []).map(String), ...(current && current !== "None" ? [String(current)] : [])];
  for (const s of all) {
    if (!s || s === "None" || match.includes(s) || other.includes(s)) continue;
    if (LORA_PRIVATE.test(s) && s !== current) continue;
    (loraFamily(s) === "ltx" ? match : other).push(s);
  }
  return { match, other };
}

// ---- the LoRA stack (QA 2026-11-04: several at once). Rows are {name, strength}, applied in order. Pure.
/** Any saved shape -> a clean stack: an array of {name, strength}, or one old single pick ({name, strength} / "file"), or nothing. */
export function normalizeStack(raw, max = 8) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : typeof raw === "string" && raw && raw !== "None" ? [{ name: raw }] : [];
  const out = [];
  for (const r of list) {
    const name = typeof r === "string" ? r : r?.name;
    if (!name || name === "None") continue;
    const s = typeof r === "object" && r.strength !== undefined && r.strength !== "" && Number.isFinite(+r.strength) ? +r.strength : 1;
    out.push({ name: String(name), strength: Math.max(-4, Math.min(4, s)) });
    if (out.length >= max) break;
  }
  return out;
}
/** The single add-on of before the stack (④ Frame's lora + lora_strength widgets) as a one-row stack. */
export const stackFromLegacy = (name, strength = 1) => normalizeStack(name && name !== "None" ? [{ name, strength }] : []);
/** The warning under an LTX stack row ("" when it looks like an LTX LoRA, or none is picked). */
export function ltxLoraWarning(name) {
  if (!name || name === "None") return "";
  const got = loraFamily(name);
  if (got === "ltx") return "";
  const NAMES = { klein: "FLUX 3 Klein", krea: "Krea 2", wan: "Wan video", hunyuan: "HunyuanVideo", qwen: "Qwen-Image", sdxl: "SDXL", flux1: "FLUX.1", sd: "Stable Diffusion 1.5/2" };
  return got ? `Looks like a ${NAMES[got]} LoRA: it may not work with LTX video (if its file says so, the render stops and tells you).`
    : "Not sure this LoRA was made for LTX video: it may do nothing, or change the picture in odd ways.";
}
