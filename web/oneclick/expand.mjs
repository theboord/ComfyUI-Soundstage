// ✦ One-click › Frame: Expand a still to another aspect (2.39:1, 1.85:1, 16:9, 4:3, 1:1, 9:16) with Paint Studio's
// Extend: SoundstagePadForFill grows the canvas (never crops) and SoundstageFill paints only the new area, FLUX 3 Klein
// by default, with a feathered, colour-matched seam: nothing inside the original frame changes.
// Clips: the LTX-2.3 in/out-painting IC-LoRA has not been tested on LTX-2.5 yet, so the clip card says so.
import { registerOneClick, pickModel, loadNode, out, withSize, KLEIN } from "./oneclick.mjs";

export const ASPECTS = [["2.39:1", 2.39, "Anamorphic scope"], ["1.85:1", 1.85, "Flat widescreen"], ["16:9", 16 / 9, "HD / streaming"],
  ["4:3", 4 / 3, "Academy-ish"], ["1:1", 1, "Square, for the feed"], ["9:16", 9 / 16, "Vertical, for phones"]];

export const EXTEND_PROMPT = "The same place continuing beyond the frame: the ground, walls, sky and set carry on naturally with the same light, lens perspective and grain. Nothing new and eye-catching at the edges, no extra people.";

/** Padding a picture needs to reach an aspect without cropping (the same rule as SoundstagePadForFill). */
export function padFor(width, height, aspect) {
  const w = +width, hh = +height;
  if (!w || !hh) return null;
  const cur = w / hh;
  if (Math.abs(cur - aspect) / aspect < 0.01) return { left: 0, top: 0, right: 0, bottom: 0, none: true };
  if (aspect > cur) { const nw = Math.round(hh * aspect), d = nw - w; return { left: Math.floor(d / 2), right: d - Math.floor(d / 2), top: 0, bottom: 0 }; }
  const nh = Math.round(w / aspect), d = nh - hh;
  return { left: 0, right: 0, top: Math.floor(d / 2), bottom: d - Math.floor(d / 2) };
}

/** Load -> SoundstagePadForFill -> SoundstageFill (extend) -> SaveImage ("9"). */
export function expandPrompt({ source, aspect, prompt = "", model, seed = 7, prefix }) {
  if (!model) throw new Error("no image edit model here (FLUX 3 Klein or Krea 2)");
  return {
    1: loadNode(source),
    2: { class_type: "SoundstagePadForFill", inputs: { image: out(1), aspect, anchor: "center", left: 0, top: 0, right: 0, bottom: 0 } },
    3: { class_type: "SoundstageFill", inputs: { image: out(2, 0), mask: out(2, 1), prompt: String(prompt || EXTEND_PROMPT), mode: "extend", negative: "", ...model,
      seed: Math.max(0, Math.floor(+seed || 0)), lora: "None", lora_strength: 1.0, steps: 0, cfg: 0, ref_files: "", grow: 8, feather: 24, context: 0.6,
      megapixels: 1.0, overlap: 48, denoise: 1.0, color_match: true } },
    9: { class_type: "SaveImage", inputs: { images: out(3, 0), filename_prefix: prefix } },
  };
}

ASPECTS.forEach(([key, aspect, what], i) => {
  registerOneClick({
    id: `expand_${key.replace(/[:.]/g, "_")}`, group: "Frame", label: `Expand to ${key}`, hint: `${what}: new picture beyond the edges, the frame itself untouched`,
    applies: ["still"], gpu: true, minutes: 1, order: i, keywords: ["expand", "outpaint", "extend", "wider", "aspect", "reframe", key],
    overlay: aspect >= 1.7 ? "background:linear-gradient(90deg, rgba(242,255,89,.25) 0 12%, transparent 12% 88%, rgba(242,255,89,.25) 88%)"
      : "background:linear-gradient(180deg, rgba(242,255,89,.25) 0 14%, transparent 14% 86%, rgba(242,255,89,.25) 86%)",
    available: (t) => {
      const pad = padFor(t.width, t.height, aspect);
      return pad?.none ? `it's already ${key}` : true;
    },
    async run(target, ctx) {
      await withSize(target);
      const pad = padFor(target.width, target.height, aspect);
      if (pad?.none) throw new Error(`it's already ${key}`);
      const model = pickModel(ctx.models?.fill, KLEIN) || pickModel(ctx.models?.fill, /./);
      const desc = String(ctx.pipeline?.ctx?.look?.state?.description || "").trim();
      const p = expandPrompt({ source: target.ref, aspect: key, prompt: desc ? `${desc} ${EXTEND_PROMPT}` : EXTEND_PROMPT, model, seed: ctx.seed(), prefix: ctx.prefix() });
      const pid = await ctx.queue(p);
      return { file: await ctx.wait(pid, "9"), kind: "still", engine: "Generative Fill · Extend (FLUX 3 Klein)", extra: { aspect: key, pad } };
    },
  });
});

registerOneClick({
  id: "expand_clip", group: "Frame", label: "Expand a clip", hint: "Out-paint every frame of a clip to a wider aspect",
  applies: ["clip"], gpu: true, minutes: 6, order: 50, keywords: ["expand", "outpaint", "wider", "video"],
  available: () => "not yet: the LTX-2.3 in/out-painting IC-LoRA needs one test on LTX-2.5 first (docs/oneclick.md)",
  run: async () => { throw new Error("not available yet"); },
});

export const EXPAND_IDS = [...ASPECTS.map(([k]) => `expand_${k.replace(/[:.]/g, "_")}`), "expand_clip"];
