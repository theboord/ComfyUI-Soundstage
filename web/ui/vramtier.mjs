// VRAM tier: Auto · 48 · 24 · 16 · 12 GB (Settings › Soundstage › Hardware), the GPU setup check, and freeing models
// between renders on small cards.
//
// The server applies the tier to every graph (soundstage/vram.py): smaller weight builds where installed, text
// encoders on the CPU, smaller decode tiles, a capped LTX stage 1, the x2 refine off on 12 GB. This module only
// stores the choice on the server (POST /soundstage/vram), shows what fits (GET /soundstage/vram), mirrors the
// stage-1 cap so ⑤ Motion's summary shows the size that will really render, and asks ComfyUI to unload models after
// each finished prompt when the tier says so (POST /free, the same call ComfyUI's own "Unload models" button makes).
//
// The tier table is web/ui/vram_tiers.json (Python reads it; a test keeps this copy identical).
// Only the 48 GB tier is tested on hardware. Pure helpers have no DOM and are unit-tested.

export const TIER_NAMES = ["Auto", "48", "24", "16", "12"];
export const TESTED = ["48"];
export const TIERS = {
  "48": { te_device: "default", stage1_short: null, refine: "on", free_between: false, decode: null, prefer: "quality",
    flags: [], note: "48 GB: everything as tested on the RTX 6000 Ada." },
  "24": { te_device: "cpu", stage1_short: 544, refine: "on", free_between: true,
    decode: { tile_size: 384, overlap: 64, temporal_size: 64, temporal_overlap: 16 }, prefer: "int8",
    flags: ["--reserve-vram 1"],
    note: "24 GB (untested): text encoders on the CPU, int8 weights, stage 1 at most 544p (outputs up to 1088p, so Hollywood renders at 1088p, not 1408p), smaller decode tiles, models freed after each prompt." },
  "16": { te_device: "cpu", stage1_short: 352, refine: "tiled", free_between: true,
    decode: { tile_size: 256, overlap: 32, temporal_size: 32, temporal_overlap: 8 }, prefer: "small",
    flags: ["--reserve-vram 0.4", "--disable-pinned-memory"],
    note: "16 GB (untested): needs the w4a8 LTX-2.5 build for Motion. Stage 1 at most 352p (outputs up to 704p, the size backlot renders on 16 GB). Hollywood's x2 refine stays on but decodes in small tiles, so Hollywood = Final at 704p. Text encoders on the CPU, models freed after each prompt." },
  "12": { te_device: "cpu", stage1_short: 256, refine: "off", one_pass_short: 512, free_between: true,
    decode: { tile_size: 256, overlap: 32, temporal_size: 32, temporal_overlap: 8 }, prefer: "small",
    flags: ["--reserve-vram 0.4", "--disable-pinned-memory", "--lowvram"],
    note: "12 GB (untested): the x2 refine is OFF for every preset, Hollywood included: Motion renders one pass at 512p. The w4a8 LTX-2.5 build (12.5 GB) still does not fit whole, so ComfyUI offloads part of it to system RAM: slow. Text encoders on the CPU, models freed after each prompt." },
};

/** Auto: the tier for a card with totalGb of VRAM (mirrors vram.detect). */
export function detect(totalGb) {
  if (totalGb == null) return "12";
  return totalGb >= 40 ? "48" : totalGb >= 20 ? "24" : totalGb >= 14 ? "16" : "12";
}

export function normalize(t) {
  const s = String(t ?? "Auto").replace(/gb/i, "").trim();
  return TIER_NAMES.includes(s) ? s : "Auto";
}

export function tierLabel(t) { return t === "Auto" ? "Auto (read the GPU)" : `${t} GB${TESTED.includes(t) ? " (tested)" : " (untested)"}`; }

/** LTX settings (resolveSettings) capped for the tier: mirrors vram.cap_settings. Returns {s, note}. */
export function capSettings(s, tier) {
  const r = TIERS[tier];
  const out = { ...s };
  if (!r || tier === "48") return { s: out, note: "" };
  const notes = [];
  const res = Number(out.resolution ?? 1088);
  if (r.refine === "off" && out.two_stage !== false) {
    const one = r.one_pass_short || 512;
    out.two_stage = false;
    if (res > one) out.resolution = one;
    notes.push(`x2 refine off on ${tier} GB: one pass at ${Math.min(res, one)}p`);
  } else if (out.two_stage !== false && r.stage1_short && res > 2 * r.stage1_short) {
    out.resolution = 2 * r.stage1_short;
    notes.push(`${res}p capped to ${out.resolution}p on ${tier} GB`);
  } else if (out.two_stage === false && r.stage1_short) {
    const one = r.one_pass_short || 2 * r.stage1_short;
    if (res > one) { out.resolution = one; notes.push(`one pass ${res}p capped to ${one}p on ${tier} GB`); }
  }
  if (r.decode) {
    const dec = { tile_size: 512, overlap: 64, temporal_size: 128, temporal_overlap: 32, ...(out.decode || {}) };
    out.decode = Object.fromEntries(Object.entries(dec).map(([k, v]) => [k, Math.min(v, r.decode[k] ?? v)]));
    if (out.decode.temporal_overlap >= out.decode.temporal_size) out.decode.temporal_overlap = Math.max(4, Math.floor(out.decode.temporal_size / 4));
  }
  if (r.refine === "tiled" && out.preset === "Hollywood") notes.push("Hollywood's refine runs with small decode tiles");
  return { s: out, note: notes.length ? `${notes.join("; ")} (VRAM tier, untested on this card size).` : "" };
}

/** The setup check as plain lines: the GPU, the tier, each feature's verdict, flags, smaller builds to get. */
export function reportLines(rep) {
  if (!rep) return [];
  const gpu = rep.gpu?.total_gb != null ? `${rep.gpu.name || "GPU"}: ${rep.gpu.total_gb} GB` : "No CUDA GPU found";
  const lines = [`${gpu}. VRAM tier: ${rep.setting === "Auto" ? `Auto → ${rep.tier} GB` : `${rep.tier} GB`}${rep.tested ? " (tested)" : " (untested)"}.`];
  if (rep.warning) lines.push(`⚠ ${rep.warning}`);
  for (const f of rep.features || []) lines.push(`${f.feature}: ${f.words}`);
  if (rep.launch_flags?.length) lines.push(`Start ComfyUI with: ${rep.launch_flags.join(" ")}`);
  for (const m of rep.missing_smaller || []) {
    lines.push(`Smaller build not installed (not downloaded for you): ${m.folder}/${m.file}${m.gb ? ` (${m.gb} GB)` : ""} from ${m.repo}`);
  }
  return lines;
}

export const shouldFree = (rep) => !!rep?.free_between;

export async function fetchReport(api, tier = null) {
  const r = await api.fetchApi(`/soundstage/vram${tier ? `?tier=${encodeURIComponent(tier)}` : ""}`);
  if (!r.ok) throw new Error(`setup check ${r.status}`);
  return r.json();
}

export async function saveTier(api, tier) {
  const r = await api.fetchApi("/soundstage/vram", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier: normalize(tier) }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `save ${r.status}`);
  return j;
}

/** A dismissible notice (bottom left) with the setup check. */
export function showReport(rep, doc = globalThis.document) {
  if (!doc || !rep) return null;
  doc.getElementById("ss-vram-report")?.remove();
  if (!doc.getElementById("ss-vram-css")) {
    const css = doc.createElement("style");
    css.id = "ss-vram-css";
    css.textContent = `#ss-vram-report{position:fixed;left:16px;bottom:16px;z-index:100001;max-width:min(520px,calc(100vw - 32px));
max-height:70vh;overflow:auto;background:#1c1a22;color:#ece9f2;border:1px solid #3a3644;border-radius:12px;padding:12px 30px 12px 14px;
font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#ss-vram-report b{display:block;font-size:12px;color:#b9b3c7;margin-bottom:4px;font-weight:600}
#ss-vram-report ul{margin:0;padding:0 0 0 16px}#ss-vram-report li{margin:2px 0;word-break:break-word}
#ss-vram-report li.warn{color:#ffb4a8}
#ss-vram-report button{position:absolute;top:6px;right:8px;background:none;border:none;color:#b9b3c7;font-size:16px;cursor:pointer}`;
    doc.head.append(css);
  }
  const box = doc.createElement("div");
  box.id = "ss-vram-report";
  box.setAttribute("role", "status");
  const title = doc.createElement("b");
  title.textContent = "GPU setup check";
  const ul = doc.createElement("ul");
  for (const t of reportLines(rep)) {
    const li = doc.createElement("li");
    li.textContent = t;
    if (t.startsWith("⚠") || /does not fit/.test(t)) li.className = "warn";
    ul.append(li);
  }
  const x = doc.createElement("button");
  x.type = "button"; x.textContent = "×"; x.title = "Close"; x.onclick = () => box.remove();
  box.append(title, ul, x);
  doc.body.append(box);
  return box;
}

/** Keep the last report on globalThis.__ssVram ({tier, rep}) for ⑤ Motion's summary. */
export function remember(rep) {
  globalThis.__ssVram = rep ? { tier: rep.tier, rep } : null;
  return globalThis.__ssVram;
}

/** After each finished prompt, ask ComfyUI to unload its models when the tier frees between steps. */
export function installFreeAfterRender(api) {
  if (!api?.addEventListener || api.__ssVramFree) return false;
  api.__ssVramFree = true;
  api.addEventListener("execution_success", () => {
    if (!shouldFree(globalThis.__ssVram?.rep)) return;
    api.fetchApi("/free", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {});
  });
  return true;
}

/** The ComfyUI setting (Settings › Soundstage › Hardware › VRAM tier). */
export function vramSetting(api) {
  return {
    id: "Soundstage.VRAMTier",
    category: ["Soundstage", "Hardware", "VRAM tier"],
    name: "VRAM tier (Soundstage renders)",
    tooltip: "Auto reads the GPU. 48 GB is the tested setup; 24, 16 and 12 GB are untested: smaller weight builds "
      + "(when installed), text encoders on the CPU, lower Motion resolution, smaller decode tiles, and on 12 GB no x2 "
      + "refine. A GPU setup check shows what fits after you change it.",
    type: "combo",
    options: TIER_NAMES.map((t) => ({ text: tierLabel(t), value: t })),
    defaultValue: "Auto",
    async onChange(value, old) {
      if (old === undefined) {   // page load: read what the server has, quietly
        try { remember(await fetchReport(api)); } catch { /* older server */ }
        return;
      }
      try { const rep = await saveTier(api, value); remember(rep); showReport(rep); }
      catch (e) { try { const rep = await fetchReport(api); remember(rep); showReport({ ...rep, warning: String(e.message || e) }); } catch { /* no server */ } }
    },
  };
}
