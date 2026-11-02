// ✦ One-click › Light: the App's 18 film lighting setups (web/look/lighting_setups.json, with sources) as one-click
// relights. A still: one FLUX 3 Klein edit that changes only the light (direction, hardness, colour temperature,
// shadows, contrast ratio). On a ④ Frame candidate of the open shot, an experimental box adds a Krea 2 repaint locked
// to the stage's exact depth pass (Krea2 depth-control LoRA), so nothing moves while the light changes. A clip: the
// relit frame 1, then LTX Ripple carries it through the clip with colour matching off (the relight stays).
import { registerOneClick, runStillEditLocked, runEditThenRipple, stagePass, stageReason, pickModel, editSize, withSize, stillEditPrompt,
  editInputs, out, KLEIN, KREA, ONECLICK_ENV, plateLockField, plateLockNode, plateLockOn, fidelityFromHistory } from "./oneclick.mjs";
import { KEEP } from "./effects.mjs";

async function loadSetups() {
  const url = new URL("../look/lighting_setups.json", import.meta.url);
  try {
    if (url.protocol === "file:") {
      const fs = await import("node:fs");
      return JSON.parse(fs.readFileSync(url, "utf8")).setups || [];
    }
    return (await (await fetch(url, { cache: "no-cache" })).json()).setups || [];
  } catch { return []; }
}
export const SETUPS = await loadSetups();

const ROLE = { key: "the key light", fill: "a fill", back: "a backlight", hair: "a hair light", kicker: "a kicker", bounce: "a bounce fill",
  background: "a light on the background", practical: "a practical lamp", under: "a light", top: "a single light" };

export function kelvinWords(k) {
  if (k < 2300) return `flame-orange ${k} K`;
  if (k < 3000) return `warm tungsten ${k} K`;
  if (k < 3600) return `tungsten ${k} K`;
  if (k < 4800) return `neutral ${k} K`;
  if (k < 6200) return `daylight ${k} K`;
  if (k < 8000) return `cool blue ${k} K`;
  return `cyan-blue ${k} K`;
}

/** One light in words, relative to the key's side ("one side" / "the other side"). */
export function lightWords(l, keySign = 1) {
  const az = +l.azimuth_deg || 0, el = +l.elevation_deg || 0, a = Math.abs(az);
  const side = Math.sign(az) === 0 ? "" : Math.sign(az) === keySign ? "one side" : "the other side";
  const dir = a < 20 ? "from the front, beside the camera" : a < 70 ? `from about ${Math.round(a / 5) * 5}° to ${side}` : a < 110 ? `from ${side}, square to the subject`
    : a < 160 ? `from behind on ${side}` : "from straight behind";
  const height = el > 60 ? "straight overhead" : el > 25 ? "high" : el > -10 ? "at eye level" : "from below";
  const soft = (+l.softness || 0) < 0.2 ? "hard" : (+l.softness || 0) < 0.6 ? "medium-soft" : "soft";
  const who = l.role === "under" ? "a light from below" : l.role === "top" ? "a single bare light straight overhead" : ROLE[l.role] || `a ${l.type} light`;
  return `${who}, ${soft}, ${kelvinWords(+l.kelvin || 3200)}, ${l.role === "top" || l.role === "under" ? "" : `${dir}, ${height}`}`.replace(/,\s*$/, "");
}

/** The relight instruction for one setup (Klein). */
export function relightPrompt(s) {
  const key = (s.lights || []).find((l) => l.role === "key") || s.lights?.[0];
  const sign = Math.sign(+key?.azimuth_deg || 1) || 1;
  const lights = (s.lights || []).map((l) => lightWords(l, sign)).join("; ");
  const sun = s.sun?.use === "off" ? " No sunlight." : "";
  const name = /light|lit\b|rim|glow/i.test(s.label) ? s.label : `${s.label} lighting`;
  return `Relight this picture with ${name}: ${s.summary} The lights: ${lights}. Key-to-fill ratio ${s.ratio}.${sun} Look: ${s.prompt_words}. ` +
    `Change only the light: its direction, hardness and colour, the shadows, the highlights and the contrast. ${KEEP}`;
}

/** The card's sketch of the setup on your own picture: brightness and contrast from the ratio, colour from the key. */
export function relightPreview(s) {
  const key = (s.lights || []).find((l) => l.role === "key") || s.lights?.[0] || {};
  const r = parseFloat(String(s.ratio)) || 4;
  const k = +key.kelvin || 3200;
  const lowKey = r >= 8 || /silhouette/.test(s.id);
  const filter = `brightness(${lowKey ? 0.62 : r <= 2 ? 1.12 : 0.95}) contrast(${lowKey ? 1.35 : r <= 2 ? 0.88 : 1.08})${k < 3000 ? " sepia(.45) saturate(1.3)" : k > 6200 ? " hue-rotate(190deg) saturate(.6)" : ""}`;
  const az = +key.azimuth_deg || 0;
  const from = az > 20 ? "90deg" : az < -20 ? "270deg" : "180deg";
  const overlay = /silhouette|golden_backlit/.test(s.id) ? "background:radial-gradient(circle at 50% 45%, rgba(255,220,160,.55), transparent 55%)"
    : `background:linear-gradient(${from}, rgba(255,240,215,.28), transparent 55%, rgba(0,0,0,${lowKey ? 0.5 : 0.25}))`;
  return { filter, overlay };
}

/** Klein relight, then a Krea 2 img2img locked to the stage depth (one job): the light changes, the geometry holds.
 * plateLock: node 5 puts the result back on the original (look mode) and 9 saves that; 7 keeps the unlocked Krea pass. */
export function depthLockedRelightPrompt({ source, prompt, klein, krea, depth, seed, prefix, width = 0, height = 0, denoise = 0.45, plateLock = false }) {
  const p = {
    1: { class_type: "SoundstageImageLoad", inputs: { source } },
    2: { class_type: "SoundstageEditImage", inputs: editInputs({ image: out(1), prompt, model: klein, seed, width, height }) },
    3: { class_type: "SoundstageImageLoad", inputs: { source: depth } },
    4: { class_type: "SoundstageEditImage", inputs: editInputs({ image: out(2), prompt: `${prompt}`, model: krea, seed, width, height, control: out(3), denoise }) },
    9: { class_type: "SaveImage", inputs: { images: out(4), filename_prefix: prefix } },
    // the Klein relight before the lock, kept beside it for comparison
    8: { class_type: "SaveImage", inputs: { images: out(2), filename_prefix: `${prefix}_klein` } },
  };
  if (plateLock) {
    p[5] = plateLockNode(out(1), out(4), "look", { seed });
    p[9].inputs.images = out(5, 0);
    p[7] = { class_type: "SaveImage", inputs: { images: out(4), filename_prefix: `${prefix}_raw` } };
  }
  return p;
}

SETUPS.forEach((s, i) => {
  const { filter, overlay } = relightPreview(s);
  registerOneClick({
    id: `relight_${s.id}`, group: "Light", label: s.label, hint: s.summary, applies: ["still", "clip"], gpu: true, minutes: 1, order: i,
    preview: filter, overlay, keywords: ["relight", "lighting", "light", ...(s.good_for || [])],
    jobsFor: (t) => (t?.kind === "clip" ? 2 : 1), minutesFor: (t) => (t?.kind === "clip" ? 4 : 1),
    // off by default: tested 2026-11-02 (Neon on the night chase), the Krea 2 pass at 0.45 painted a different street with
    // three invented people, while the Klein relight alone kept every object (docs/oneclick.md)
    plateLock: "look",
    fields: [{ id: "lock", type: "check", value: false, label: "Experimental: add a Krea 2 pass locked to the stage depth (it can invent things)",
      when: (t) => t.kind === "still" && stageReason(t, ONECLICK_ENV.stage) === true }, plateLockField("look")],
    async run(target, ctx) {
      const prompt = relightPrompt(s);
      if (target.kind === "clip") {
        const r = await runEditThenRipple(target, ctx, { prompt, ripplePrompt: `The same scene relit with ${s.label.toLowerCase()} lighting.`, colorMatch: "off", lock: "look" });
        return { ...r, note: `${s.label}: frame 1 relit, Ripple carried it` };
      }
      if (ctx.opts.lock && stageReason(target, ctx.stage) === true) {
        const klein = pickModel(ctx.models?.edit, KLEIN), krea = pickModel(ctx.models?.edit, KREA);
        if (klein && krea) {
          ctx.progress("Reading the stage depth…");
          const depth = await stagePass(ctx.stage, ctx, "depth");
          const plateLock = plateLockOn(ctx);
          const p = depthLockedRelightPrompt({ source: target.ref, prompt, klein, krea, depth, seed: ctx.seed(), prefix: ctx.prefix("lock"), ...editSize(await withSize(target)), plateLock });
          const pid = await ctx.queue(p);
          const file = await ctx.wait(pid, "9");
          let kleinFile = null, raw = null, fidelity = null;
          try {
            const e = (await (await ctx.api.fetchApi(`/history/${pid}`)).json())[pid];
            kleinFile = e?.outputs?.["8"]?.images?.[0] || null;
            if (plateLock) { raw = e?.outputs?.["7"]?.images?.[0] || null; fidelity = fidelityFromHistory(e, "5"); }
          } catch { /* the locked one is the take */ }
          return { file, kind: "still", engine: "FLUX 3 Klein relight → Krea 2 on the stage depth", extra: { setup: s.id, depth_locked: true, klein: kleinFile, ...(plateLock ? { raw, fidelity } : {}) } };
        }
      }
      const { file, raw, fidelity } = await runStillEditLocked(target, ctx, "look", { prompt });
      return { file, kind: "still", engine: "FLUX 3 Klein relight", extra: { setup: s.id, ...(raw ? { raw, fidelity } : {}) } };
    },
  });
});

export const LIGHT_IDS = SETUPS.map((s) => `relight_${s.id}`);
export { stillEditPrompt };
