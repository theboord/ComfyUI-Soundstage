// Model-file safety net for shipped workflows (pure: no DOM, no ComfyUI imports; tests/js/modelmatch.test.mjs).
//
// A workflow names a model file by the spelling its author had (`ltx-2.5-…-bf16.safetensors`, a LoRA at the folder
// root). Another install has the same model as a different build (`…-comfy-int8-convrot`) or under a subfolder
// (`ltx2.5/…`). ComfyUI then rejects the loader at queue time and every output behind it is dropped without a word.
// When a workflow loads, each loader widget whose value is not in its own option list is pointed at the closest
// installed file of the same model family; if there is none, the App says which file is missing.

export const MODELS_DOC_URL = "https://github.com/theboord/ComfyUI-Soundstage/blob/main/MODELS.md";

const MODEL_EXT = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)$/i;

// Precision and packaging words: two files that differ only in these are builds of the same model.
const PRECISION = ["fp32", "bf16", "fp16", "fp8", "int8", "fp4", "nvfp4", "int4"];
const PACKAGING = new Set(["comfy", "comfyui", "convrot", "scaled", "e4m3fn", "e5m2", "e4m3", "awq", "pruned", "dynamic", "mixed", "quant", "quantized", "fp8e4m3fn", "fp8e5m2"]);
const PREC_SET = new Set(PRECISION);

export const isModelFile = (v) => typeof v === "string" && MODEL_EXT.test(v.trim());

/** "loras/ltx2.5/foo-bf16.safetensors" -> "foo-bf16.safetensors" (either slash). */
export const baseName = (p) => String(p).split(/[\\/]/).pop();

/** The folder part ("ltx2.5/"), "" at the root. */
export const folderOf = (p) => { const s = String(p).replace(/\\/g, "/"); const i = s.lastIndexOf("/"); return i < 0 ? "" : s.slice(0, i + 1); };

const stem = (p) => baseName(p).replace(MODEL_EXT, "");

/** Lower-case words of the file name (no folder, no extension). Dots stay inside version numbers ("2.5", "1.0"). */
export function modelTokens(p) {
  return stem(p).toLowerCase().split(/[-_\s+]+/).filter(Boolean);
}

/** The precision word(s) in a file name, e.g. ["bf16"], ["int8"]. */
export function precisionOf(p) {
  return modelTokens(p).filter((t) => PREC_SET.has(t));
}

/**
 * The model family: the name's words without precision/packaging words, joined with no separator so that
 * "Krea-2-Turbo" and "krea2_turbo_fp8_scaled" agree ("krea2turbo"). Two files with the same family are builds
 * of the same weights.
 */
export function familyKey(p) {
  return modelTokens(p).filter((t) => !PREC_SET.has(t) && !PACKAGING.has(t)).join("");
}

const precRank = (p) => {
  const r = precisionOf(p).map((t) => PRECISION.indexOf(t));
  return r.length ? Math.min(...r) : -1;
};

/**
 * The installed file that best stands in for `wanted`, or null.
 *   1. the same file name in another folder (the LoRA under `ltx2.5/`);
 *   2. the same family in another precision (bf16 -> int8-convrot), the nearest precision first, then the higher one;
 * ties go to the shallower folder, then alphabetical order. A different family is never offered: a wrong model
 * that loads is worse than a clear "missing" message.
 */
export function closestModel(wanted, options) {
  if (!isModelFile(wanted)) return null;
  const list = (options || []).filter((o) => typeof o === "string" && isModelFile(o));
  if (list.includes(wanted)) return wanted;
  const wb = baseName(wanted).toLowerCase();
  const wf = familyKey(wanted);
  if (!wf) return null;
  const wr = precRank(wanted);
  const scored = [];
  for (const o of list) {
    let tier;
    if (baseName(o).toLowerCase() === wb) tier = 0;
    else if (familyKey(o) === wf) tier = 1;
    else continue;
    const r = precRank(o);
    const dist = wr < 0 || r < 0 ? (wr === r ? 0 : 1) : Math.abs(r - wr);
    scored.push({ o, k: [tier, dist, r < 0 ? 99 : r, folderOf(o).split("/").length, o] });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => { for (let i = 0; i < a.k.length; i++) { if (a.k[i] < b.k[i]) return -1; if (a.k[i] > b.k[i]) return 1; } return 0; });
  return scored[0].o;
}

/** "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors" -> "ltx-2.5-…int8-convrot". */
export function shortModelName(p, withFolder = true) {
  const s = stem(p);
  const dir = withFolder ? folderOf(p) : "";
  if (s.length <= 30) return dir + s;
  const parts = s.split(/([-_])/);           // keep the separators
  const words = parts.filter((_, i) => i % 2 === 0);
  const pi = words.findIndex((w) => PREC_SET.has(w.toLowerCase()));
  // head: the first two words ("ltx-2.5-"), tail: from the precision word on (or the last three words).
  const at = (wi) => parts.slice(0, wi * 2).join("").length;
  const head = s.slice(0, at(2));
  const tail = pi >= 2 ? s.slice(at(pi)) : s.slice(at(Math.max(2, words.length - 3)));
  return dir + head + "…" + tail;
}

/** Why the swap happened, in the user's words: "you don't have the bf16 file" / "found it in ltx2.5/". */
export function swapReason(wanted, got) {
  const wp = precisionOf(wanted).join("-");
  if (baseName(wanted).toLowerCase() === baseName(got).toLowerCase()) return `found it in ${folderOf(got) || "the models folder"}`;
  return wp ? `you don't have the ${wp} file` : `you don't have ${baseName(wanted)}`;
}

/** One line for the notice. */
export function describeSwap(wanted, got) {
  const moved = baseName(wanted).toLowerCase() === baseName(got).toLowerCase();
  return `Using ${shortModelName(got, !moved)} (${swapReason(wanted, got)})`;
}

/**
 * Plan the fixes for a list of loader widgets.
 *   items: [{ id, node, widget, value, options }]   (id: anything the caller needs back, e.g. the widget object)
 * Returns { swaps: [{ id, from, to, node, widget }], missing: [{ id, value, node, widget }] }.
 * Values already in the list, non-model values and widgets without an option list are left alone.
 */
export function planModelFixes(items) {
  const swaps = [], missing = [];
  for (const it of items || []) {
    const { value, options } = it;
    if (!isModelFile(value) || !Array.isArray(options)) continue;
    if (options.includes(value)) continue;
    // A combo that never held model files (a label picker that happens to end in ".pt") is not a loader.
    if (options.length && !options.some(isModelFile)) continue;
    const to = closestModel(value, options);
    if (to && to !== value) swaps.push({ id: it.id, from: value, to, node: it.node, widget: it.widget });
    else missing.push({ id: it.id, value, node: it.node, widget: it.widget });
  }
  return { swaps, missing };
}

/** The notice's lines: one per distinct swap, then one per distinct missing file. */
export function noticeLines(plan) {
  const seen = new Set();
  const swaps = [], missing = [];
  for (const s of plan.swaps) { const k = s.from + "→" + s.to; if (!seen.has(k)) { seen.add(k); swaps.push(describeSwap(s.from, s.to)); } }
  for (const m of plan.missing) { const k = "!" + m.value; if (!seen.has(k)) { seen.add(k); missing.push(`Missing ${m.value}${m.node ? ` (${m.node})` : ""}`); } }
  return { swaps, missing };
}
