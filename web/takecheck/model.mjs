// Takes that check themselves (Milestone 16): the pure part. No DOM, no ComfyUI imports (tests/js/takecheck.test.mjs).
//
//   takeChips(result)           the chips a take shows on the Ladder and in Dailies: ✓ clean, or ⚠ freeze 2.1–2.6 s…
//   blockingChip(blocking)      "Follows blocking 87%" with the hover breakdown; "can't tell" is never green
//   fileOfUrl(url)              a /view URL -> {filename, subfolder, type}
//   estimate(timing, rung, …)   "$0 · about 2 min on your GPU" from the measured render times
//   readiness(...)              each step's "Ready" / "Needs 2" chip from the server's answer + the graph's loaders
//   parseMp4Tags(bytes)         the metadata tags of an MP4 (the recipe travels in them)
//   recipeFromTags(tags)        the Soundstage recipe in those tags (the soundstage tag, else rebuilt)
//   realismChip(realism)        the realism judge's chip: "✓ real 9.5/10" or red "✗ AI slop: rear lights incoherent, f24–64"
//   rerollOffer(res, offered)   whether a judged Hollywood take earns its one automatic re-roll offer

export const MODELS_DOC_URL = "https://github.com/theboord/ComfyUI-Soundstage/blob/main/MODELS.md";

const fmtPct = (x) => `${Math.round(x * 100)}%`;

/** The chips of a take check result (server: soundstage/takecheck/check.py). */
export function takeChips(result) {
  if (!result) return [{ tone: "info", text: "Checking…", title: "Fast CPU checks on this take: black, freeze, jumps, smear, faces, car direction" }];
  if (result.error) return [{ tone: "info", text: "Not checked", title: String(result.error) }];
  const chips = Array.isArray(result.chips) ? result.chips : [];
  const ran = Object.keys(result.checks || {}).join(", ");
  return chips.map((c) => ({
    tone: c.tone || "warn",
    text: c.text,
    start: c.start ?? null,
    title: c.tone === "ok"
      ? `No problems found (${ran}). ${result.frames || "?"} frames checked in ${result.elapsed_s ?? "?"} s on the CPU.`
      : [c.text.replace(/^⚠\s*/, ""), c.detail].filter(Boolean).join(": "),
  }));
}

/** The realism judge's chip (server: soundstage/takecheck/realism.py chip()). null = not judged and not asked. */
export function realismChip(r) {
  if (!r) return null;
  if (r.pending) return { tone: "info", text: "Realism: judging…", title: "The VFX-supervisor pass: a local vision model inspects the main subjects (about a minute, queued on the GPU)." };
  if (r.error || r.verdict === "unavailable") return { tone: "info", text: "Realism: not judged", title: String(r.error || r.why || "no vision model on this server") };
  const lines = [`VFX-supervisor score ${r.score}/10${r.model ? ` (${r.model}` : ""}${r.frames_judged ? `, ${r.frames_judged} frames)` : r.model ? ")" : ""}`];
  for (const d of r.defects || []) lines.push(`✗ ${d.label}${d.examples?.[0] ? `: ${d.examples[0]}` : ""}`);
  for (const d of (r.minor || []).slice(0, 4)) lines.push(`· ${d.label}`);
  if (r.verdict === "pass") return { tone: "ok", text: `✓ real ${r.score}/10`, title: lines.join("\n"), kind: "realism" };
  const first = r.defects?.[0];
  return { tone: "bad", text: `✗ AI slop: ${first?.label || "looks generated"}`, title: lines.join("\n"), kind: "realism",
    start: first?.frames?.length ? first.frames[0] : null, frame: true };
}

/** A Hollywood take the judge failed gets ONE automatic re-roll offer per shot: not again for the re-roll itself
 *  (a second failure means the shot needs a fix, not more GPU), not for drafts, not for unjudged takes.
 *  offered: Set of shot keys already offered. */
export function rerollOffer(res, shotKey, offered) {
  if (!res || res.error || !res.hollywood) return false;
  if (res.realism?.verdict !== "fail") return false;
  return !offered?.has?.(shotKey);
}

/** The one blocking score per take, with its breakdown for the hover. */
export function blockingChip(b) {
  if (!b) return null;
  const lines = [];
  const cam = b.camera;
  if (cam?.conclusive) lines.push(`Camera move: ${fmtPct(cam.agree)} of ${cam.steps} steps go the way the stage camera does`);
  else if (cam) lines.push(`Camera move: not measurable${cam.why ? ` (${cam.why})` : " (too little texture or motion)"}`);
  for (const a of b.actors || []) {
    const drift = a.drift_at?.length ? `; off its mark at ${a.drift_at.slice(0, 4).map((t) => `${t} s`).join(", ")}${a.drift_at.length > 4 ? "…" : ""}` : "";
    lines.push(`${a.name}: on its mark ${fmtPct(a.on_mark)} of ${a.frames} frames (IoU ${a.iou.toFixed(2)})${a.matched ? "" : ", never found in the take"}${drift}`);
  }
  if (b.actors_note) lines.push(`Actors: ${b.actors_note}`);
  if (b.needs_actors) lines.push("Actors: not measured yet. Measure runs SAM 3.1 on the take (about 20 s of GPU).");
  if (b.score == null) {
    return { tone: "info", text: "Blocking: can't tell", title: ["Inconclusive: nothing could be measured, so this is not a pass.", ...lines].join("\n"),
      action: b.needs_actors ? "measure" : null };
  }
  const pct = Math.round(b.score * 100);
  const tone = b.score >= 0.75 ? "ok" : b.score >= 0.5 ? "warn" : "bad";
  const partial = b.needs_actors ? " (camera)" : "";
  return {
    tone: b.needs_actors && tone === "ok" ? "info" : tone,     // a camera-only score is never shown as a full pass
    text: `Follows blocking ${pct}%${partial}`,
    title: [`Score from ${b.basis}.`, ...lines].join("\n"),
    action: b.needs_actors ? "measure" : null,
  };
}

/** A ComfyUI /view URL (absolute or relative) -> {filename, subfolder, type}, or null. */
export function fileOfUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, "http://x");
    const filename = u.searchParams.get("filename");
    if (!filename) return null;
    return { filename, subfolder: u.searchParams.get("subfolder") || "", type: u.searchParams.get("type") || "output" };
  } catch { return null; }
}

/** A file ref as LoadImage-style annotated name: "soundstage/final_00001_.mp4 [output]". */
export const annotated = (f) => `${f.subfolder ? `${f.subfolder}/` : ""}${f.filename} [${f.type || "output"}]`;

// ------------------------------------------------------------------------------------------- estimates

/** "$0 · about 2 min on your GPU" (mirrors soundstage/takecheck/timing.py label). */
export function estimateLabel(seconds) {
  if (!(seconds > 0)) return "";
  const t = seconds < 60 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} s` : `about ${Math.max(1, Math.round(seconds / 60))} min`;
  return `$0 · ${t} on your GPU`;
}

const DEFAULTS = { frame: { seconds: 20, frames: 1 }, draft: { seconds: 95, frames: 121 }, final: { seconds: 360, frames: 121 },
  final_hq: { seconds: 720, frames: 121 }, layers: { seconds: 60, frames: 121 } };

/** Seconds for one run of a rung: per-frame median × this shot's frames (a frame: per image × count). */
export function estimateSeconds(timing, rung, frames = 121, count = 1) {
  const t = timing?.[rung] || DEFAULTS[rung] || DEFAULTS.draft;
  if (rung === "frame") return Math.round((t.seconds || 20) * Math.max(1, count));
  const per = t.per_frame ?? (t.seconds / Math.max(1, t.frames || 121));
  return Math.round(per * Math.max(1, frames || 121) * Math.max(1, count));
}

/** The final's rung key for ⑤ Motion's Quality picker (Draft / Final / Final HQ). */
export const finalRung = (quality) => (/hq/i.test(String(quality || "")) ? "final_hq" : "final");

// ------------------------------------------------------------------------------------------- readiness

const STEP_OF = [
  [/ltx|gemma4|minimax|h3_|chatterbox|mmaudio|audio/i, "motion"],
  [/flux|krea|qwen3vl|qwen_image|klein|depth-control/i, "frame"],
  [/sam3|birefnet/i, "deliver"],
  [/qwen3\.5/i, "set"],
];
/** Which step a missing model file or node belongs to (by family; anything else counts for Motion, the run step). */
export function stepForFile(name) {
  for (const [re, st] of STEP_OF) if (re.test(String(name || ""))) return st;
  return "motion";
}

/**
 * Merge the server's per-step needs with what the live graph lacks (loader widgets without their file, node types
 * that didn't load). Returns {step: {status, needs: [{what, detail, required}]}}.
 */
export function readiness(serverSteps, graphMissing = [], missingNodes = []) {
  const out = {};
  const keys = ["script", "cast", "set", "frame", "motion", "review", "deliver"];
  for (const k of keys) out[k] = { status: "ready", needs: [...((serverSteps?.[k]?.needs) || [])] };
  for (const m of graphMissing) {
    const st = stepForFile(m.value);
    if (!out[st].needs.some((n) => n.what === m.value)) out[st].needs.push({ what: m.value, detail: m.node ? `used by ${m.node}` : "a loader in the App", required: true });
  }
  for (const t of missingNodes) {
    const st = stepForFile(t);
    if (!out[st].needs.some((n) => n.what === `node ${t}`)) out[st].needs.push({ what: `node ${t}`, detail: "its node pack isn't installed", required: true });
  }
  for (const k of keys) {
    const n = out[k].needs;
    out[k].status = n.some((x) => x.required) ? "needs" : n.length ? "partial" : "ready";
  }
  return out;
}

/** The chip on a step button. */
export function readinessChip(st) {
  if (!st) return null;
  const n = st.needs?.length || 0;
  if (st.status === "ready") return { tone: "ok", text: "Ready", title: "Ready to run: every node and model file this step uses is installed." };
  const list = (st.needs || []).map((x) => `• ${x.what}${x.folder ? ` (models/${x.folder}/)` : ""}${x.detail ? ` — ${x.detail}` : ""}${x.required ? "" : " (optional)"}`);
  if (st.status === "partial") return { tone: "info", text: "Ready*", title: ["Ready to run. Optional extras missing:", ...list, "Where to get them: MODELS.md"].join("\n") };
  return { tone: "bad", text: n === 1 ? "Needs 1" : `Needs ${n}`, title: ["Not ready: this step needs", ...list, "Where to get them: MODELS.md"].join("\n") };
}

// ------------------------------------------------------------------------------------------- the recipe in the MP4

const td = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
const str4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const u32 = (u8, o) => ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];

/** Boxes inside [start, end): [{type, start, size, body}] (body = first byte after the 8/16-byte header). */
function boxes(u8, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(u8, o);
    const type = str4(u8, o + 4);
    let hdr = 8;
    if (size === 1 && o + 16 <= end) { size = u32(u8, o + 8) * 2 ** 32 + u32(u8, o + 12); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, start: o, size, body: o + hdr });
    o += size;
  }
  return out;
}

/** Tags from a 'meta' box written by ffmpeg's use_metadata_tags (hdlr mdta + keys + ilst). */
function metaTags(u8, meta, out) {
  const end = meta.start + meta.size;
  // QuickTime 'meta' has no version/flags; ISO 'meta' is a full box (4 more bytes). Try both.
  for (const skip of [0, 4]) {
    const kids = boxes(u8, meta.body + skip, end);
    if (!kids.length || !kids.every((b) => /^[a-z]{4}$/i.test(b.type))) continue;
    const keysBox = kids.find((b) => b.type === "keys");
    const ilst = kids.find((b) => b.type === "ilst");
    if (!keysBox || !ilst) return;
    const n = u32(u8, keysBox.body + 4);
    const names = [];
    let o = keysBox.body + 8;
    for (let i = 0; i < n && o + 8 <= keysBox.start + keysBox.size; i++) {
      const sz = u32(u8, o);
      names.push(td.decode(u8.subarray(o + 8, o + sz)));
      o += Math.max(8, sz);
    }
    for (const item of boxes(u8, ilst.body, ilst.start + ilst.size)) {
      const idx = u32(u8, item.start + 4);         // the item's type is its 1-based key index
      const data = boxes(u8, item.body, item.start + item.size).find((b) => b.type === "data");
      if (!data || !names[idx - 1]) continue;
      out[names[idx - 1]] = td.decode(u8.subarray(data.body + 8, data.start + data.size));
    }
    return;
  }
}

/** All metadata tags in an MP4's bytes (the moov box is enough): {name: string}. */
export function parseMp4Tags(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = {};
  const walk = (start, end, depth) => {
    for (const b of boxes(u8, start, end)) {
      if (b.type === "meta") metaTags(u8, b, out);
      else if (depth < 3 && (b.type === "moov" || b.type === "udta")) walk(b.body, b.start + b.size, depth + 1);
    }
  };
  walk(0, u8.length, 0);
  return out;
}

/** Read just the moov box of a File/Blob (a few hundred KB even for a long take) and parse its tags. */
export async function readFileTags(file) {
  const read = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  let o = 0;
  for (let i = 0; i < 64 && o + 8 <= file.size; i++) {
    const h = await read(o, o + 16);
    let size = u32(h, 0);
    const type = str4(h, 4);
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    else if (size === 0) size = file.size - o;
    if (size < 8) break;
    if (type === "moov") return parseMp4Tags(await read(o, o + size));
    o += size;
  }
  return {};
}

const jparse = (v) => { if (v && typeof v === "object") return v; try { return typeof v === "string" && v.trim() ? JSON.parse(v) : null; } catch { return null; } };

/** The Soundstage recipe in an MP4's tags (mirrors soundstage/takecheck/recipe.py from_tags), or null. */
export function recipeFromTags(tags) {
  const rec = jparse(tags?.soundstage);
  if (rec && typeof rec.scene === "object" && rec.scene) return { ...rec, source: rec.source || "soundstage tag" };
  const prompt = jparse(tags?.prompt);
  if (prompt) {
    const nodes = Object.values(prompt).filter((n) => n && typeof n === "object");
    const st = nodes.find((n) => n.class_type === "SoundstageStage");
    const raw = jparse(st?.inputs?.stage);
    const scene = raw?.scene ?? raw;
    if (scene && scene.camera) {
      const lit = (v) => (Array.isArray(v) && v.length === 2 && Number.isInteger(v[1]) ? null : v);
      const step = lit(nodes.find((n) => n.class_type === "SoundstageStep")?.inputs?.step);
      const look = jparse(lit(nodes.find((n) => n.class_type === "SoundstageLook")?.inputs?.look));
      const seeds = {};
      const vs = lit(nodes.find((n) => n.class_type === "SoundstageAudioDrivenShot")?.inputs?.seed);
      if (Number.isFinite(vs)) seeds.video = vs;
      const ls = lit(nodes.find((n) => n.class_type === "RandomNoise")?.inputs?.noise_seed);
      if (Number.isFinite(ls)) seeds.ltx = ls;
      const shot = (scene.shots || []).find((s) => s.id === scene.active_shot);
      return { v: 1, app: "Soundstage", scene, look: look || undefined, step: step ?? undefined,
        rung: { 2: "frame", 3: "draft", 4: "final", 5: "layers" }[step] || undefined, seeds,
        shot: { id: scene.active_shot, name: shot?.name }, source: "rebuilt from the prompt tag" };
    }
  }
  const wf = jparse(tags?.workflow);
  const node = (wf?.nodes || []).find((n) => n.type === "SoundstageStage");
  const raw = jparse(node?.widgets_values?.[0]);
  const scene = raw?.scene ?? raw;
  if (scene?.camera) return { v: 1, app: "Soundstage", scene, shot: { id: scene.active_shot }, source: "rebuilt from the workflow tag" };
  return null;
}

/** One line for the restore dialog: "Final · Chase cam (police hood) · seed 42". */
export function recipeLine(rec) {
  if (!rec) return "";
  const shot = rec.shot?.name || rec.shot?.id || (rec.scene?.active_shot ?? "");
  const seed = rec.seeds?.video ?? rec.seeds?.ltx;
  const rung = rec.rung ? rec.rung[0].toUpperCase() + rec.rung.slice(1) : "";
  const n = (rec.scene?.actors || []).length;
  return [rung, shot, `${n} on the stage`, seed != null ? `seed ${seed}` : ""].filter(Boolean).join(" · ");
}
