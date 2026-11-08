// Device tiers (Lifelike-only plan 4.5, moved into L1): a probe that picks TP (phone) / T0 / T1 / Hero from what the
// browser reports, a picker override saved per viewer, and the people rows of the tier table. Pure (no DOM at import),
// so node tests check the rules; the stage calls probeFromRenderer once with its WebGL renderer.
//
// FLAW (L1): the probe reads capabilities (GPU string, texture size, memory hints), it does not time a frame. The
// plan's frame-budget probe (900 ms per capture frame on T0) and the real numbers on the iMac, a 6-8 GB card and an
// iPhone are still to be measured on those machines.

/** The people rows of the tier table (plan 4.5). Budgets in bytes. */
export const PEOPLE_TIERS = {
  TP: { label: "Phone", mesh: "decimated 15k (or the stand-in)", meshTriangles: 15000, texture: 256, maxLifelike: 2, draws: 4, avatarShadow: false, gpuBudget: 20e6, liveThumbs: "off" },
  T0: { label: "Low", mesh: "decimated 30k", meshTriangles: 30000, texture: 512, maxLifelike: 6, draws: 4, avatarShadow: true, gpuBudget: 40e6, liveThumbs: "off" },
  T1: { label: "Standard", mesh: "hipoly 81-bone", meshTriangles: Infinity, texture: 1024, maxLifelike: 16, draws: 4, avatarShadow: true, gpuBudget: 120e6, liveThumbs: "on" },
  Hero: { label: "Hero", mesh: "hipoly", meshTriangles: Infinity, texture: 1024, maxLifelike: Infinity, draws: 4, avatarShadow: true, gpuBudget: Infinity, liveThumbs: "on" },
};
export const TIER_ORDER = ["TP", "T0", "T1", "Hero"];
export const TIER_KEY = "ss_tier";   // localStorage: the viewer's own pick ("auto" or a tier name)

/**
 * Pick a tier from what the device reports: {phone, gpu (renderer string), maxTexture, deviceMemoryGB, cores}.
 * Phones are TP; integrated / software GPUs (Intel HD / UHD / Iris, SwiftShader, llvmpipe, Apple GPUs on an old
 * Intel Mac report as Intel) and small textures are T0; a discrete or Apple-silicon GPU with 16k textures and 8 GB+
 * of memory is T1. Hero is never picked automatically (a render box sets it). Returns {tier, why}.
 */
export function probeTier(info = {}) {
  const gpu = String(info.gpu || "").toLowerCase();
  if (info.phone) return { tier: "TP", why: "a phone" };
  if (/swiftshader|llvmpipe|software|basic render/.test(gpu)) return { tier: "T0", why: `a software renderer (${info.gpu})` };
  if (/intel/.test(gpu)) return { tier: "T0", why: `an integrated GPU (${info.gpu})` };
  if ((info.maxTexture || 0) && info.maxTexture < 8192) return { tier: "T0", why: `textures up to ${info.maxTexture} px` };
  if ((info.deviceMemoryGB || 0) && info.deviceMemoryGB < 8) return { tier: "T0", why: `${info.deviceMemoryGB} GB of memory` };
  return { tier: "T1", why: info.gpu ? `a capable GPU (${info.gpu})` : "no limit reported" };
}

/** The tier in force: the viewer's pick if it names a tier, else the probe's. */
export function pickTier(probe, pick) {
  return TIER_ORDER.includes(pick) ? pick : probe?.tier || "T1";
}

/** What the browser reports, from a WebGL renderer (or nothing outside a browser). */
export function deviceInfo(renderer, nav = typeof navigator !== "undefined" ? navigator : null) {
  const out = { phone: false, gpu: "", maxTexture: 0, deviceMemoryGB: 0, cores: 0 };
  try {
    const gl = renderer?.getContext?.();
    if (gl) {
      out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out.gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
    }
  } catch { /* a lost context: no info */ }
  if (nav) {
    out.phone = /iPhone|iPad|iPod|Android/i.test(nav.userAgent || "") || (nav.maxTouchPoints > 1 && /Macintosh/.test(nav.userAgent || "") && !/Chrome/.test(nav.userAgent || ""));
    out.deviceMemoryGB = +nav.deviceMemory || 0;
    out.cores = +nav.hardwareConcurrency || 0;
  }
  return out;
}

/** The viewer's saved pick ("auto" when none; storage may throw in a private window). */
export function savedPick(store = typeof localStorage !== "undefined" ? localStorage : null) {
  try { return store?.getItem(TIER_KEY) || "auto"; } catch { return "auto"; }
}
export function savePick(pick, store = typeof localStorage !== "undefined" ? localStorage : null) {
  try { store?.setItem(TIER_KEY, TIER_ORDER.includes(pick) ? pick : "auto"); } catch { /* not saved: per-viewer convenience only */ }
}

/**
 * GPU memory one avatar kit takes (bytes, estimate): its textures at the tier's size (RGBA8 with mips, x 4/3), and its
 * vertex buffers (position + normal + uv + skin index / weight ~ 64 B a vertex, shared by every clone) plus each
 * clone's bone texture (81 bones x 64 B, tiny). textures = [[w, h], ...] of the maps actually used.
 */
export function avatarGpuBytes({ vertices = 0, textures = [], clones = 1, bones = 81 }, tier = "T1") {
  const T = PEOPLE_TIERS[tier]?.texture || 1024;
  let tex = 0;
  for (const [w, h] of textures) { const s = Math.min(1, T / Math.max(w, h)); tex += Math.round(w * s) * Math.round(h * s) * 4 * (4 / 3); }
  return Math.round(tex + vertices * 64 + clones * bones * 64);
}

/**
 * Which people show lifelike under the tier's cap (maxLifelike): the first N in the scene's order that have a body;
 * the rest show the marked stand-in (plan 4.5 "rest proxy"). Deterministic: the same scene gives the same set in any
 * scrub order. ids: person ids in scene order with a lifelike body.
 */
export function lifelikeSet(ids, tier) {
  const cap = PEOPLE_TIERS[tier]?.maxLifelike ?? Infinity;
  return new Set(ids.slice(0, cap));
}
