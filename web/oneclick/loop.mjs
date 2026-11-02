// ✦ One-click › Loop: a seamless loop from a still or a take's frame 1, with a seam meter that says how visible the wrap
// is (a number, never a guess) and a fixer that tries, in order, a trim to the best frame pair (CPU), a bridge render
// from the last frame back to the first (GPU), then a reseed (GPU). Never a crossfade: a dissolve is a visible seam.
// Server side: soundstage/loop (graphs, seam, fix) through /soundstage/loop/{prompt,seam,fix}. docs/loop.md.
import { registerOneClick } from "./oneclick.mjs";

export const SECONDS = [["4", "4 s"], ["3", "3 s"], ["5", "5 s"], ["6", "6 s"], ["2", "2 s"]];
export const MOTION_HINT = "What moves, e.g. \"waves roll onto the sand, palms sway\" (empty: gentle natural motion)";

/** "sub/x.mp4 [output]" -> {filename, subfolder, type} (what the one-click window turns into a take). */
export function fileOfRef(ref) {
  const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(String(ref || "").trim());
  const path = m?.[1] || "", type = m?.[2] || "output";
  const j = path.lastIndexOf("/");
  return { filename: j < 0 ? path : path.slice(j + 1), subfolder: j < 0 ? "" : path.slice(0, j), type };
}
export const refOfFile = (f) => (f?.filename ? `${f.subfolder ? f.subfolder + "/" : ""}${f.filename} [${f.type || "output"}]` : "");

/** POST JSON to a Soundstage route; throws the route's own error message. */
export async function postJSON(api, path, body) {
  const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  let j = {};
  try { j = await r.json(); } catch { /* */ }
  if (!r.ok || j.error) {
    if (r.status === 404 && !j.error) throw new Error("this server needs a restart to know the loop routes");
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  return j;
}

/** The body of /soundstage/loop/prompt for a target. */
export function loopBody(target, opts = {}, { seed = 7, quality = "Draft" } = {}) {
  if (!target?.ref) throw new Error("pick a frame or a take first");
  const seconds = Math.min(8, Math.max(2, +opts.seconds || 4));
  return { source: target.ref, seconds, prompt: String(opts.motion || "").trim(), seed: Math.max(0, Math.floor(+seed || 0)),
    quality: quality === "Final" ? "Final" : "Draft", sound: opts.sound !== false };
}

/** Is report b better than a? Seamless beats visible; then the lower seam number wins. */
export function better(a, b) {
  if (!a) return !!b;
  if (!b) return false;
  const sa = a.verdict === "seamless", sb = b.verdict === "seamless";
  if (sa !== sb) return sb;
  return (+b.seam || 0) < (+a.seam || 0);
}

/** One line for the take: "Seamless · 1.2x" or "Visible seam · 6.1x (jump at frame 86) · tried trim, bridge". */
export function seamLine(rep, tried = []) {
  if (!rep) return "";
  const t = tried.filter(Boolean);
  return `${rep.badge}${t.length ? ` · tried ${t.join(", ")}` : ""}`;
}

/**
 * Fix a loop's seam in order: seal (drop the duplicate last frame, free), trim (CPU), bridge (one GPU job), keeping the
 * best result. steps = which to try. Returns {ref, report, tried: [{how, before, after, kept}]}.
 */
export async function fixSeam(ref, ctx, { steps = ["seal", "trim", "bridge"], quality = "Draft", seed = 11, motion = "", report = null } = {}) {
  const api = ctx.api;
  let best = { ref, report: report || await postJSON(api, "/soundstage/loop/seam", { ref }) };
  const tried = [];
  for (const how of steps) {
    if (best.report?.verdict === "seamless") break;
    ctx.progress?.(`Loop: ${how === "seal" ? "dropping the duplicate last frame" : how === "trim" ? "trimming to the best frame pair" : "rendering a bridge back to frame 1"}…`);
    let res;
    if (how === "bridge") {
      const b = await postJSON(api, "/soundstage/loop/fix", { ref: best.ref, how: "bridge", quality, seed, prompt: motion });
      const pid = await ctx.queue(b.prompt, "Loop bridge");
      const bf = await ctx.wait(pid, "save");
      res = await postJSON(api, "/soundstage/loop/fix", { ref: best.ref, how: "join", bridge_ref: refOfFile(bf), clip_end: b.clip_end });
    } else {
      res = await postJSON(api, "/soundstage/loop/fix", { ref: best.ref, how });
    }
    const kept = better(best.report, res.after);
    tried.push({ how, before: res.before?.badge, after: res.after?.badge, kept });
    if (kept) best = { ref: res.ref, report: res.after };
  }
  return { ...best, tried };
}

registerOneClick({
  id: "loop", group: "Loop", label: "Seamless loop", order: 0,
  hint: "Starts and ends on the same picture; the seam meter scores the wrap, and the fixer trims or bridges it",
  applies: ["still", "clip"], gpu: true, minutes: 2, jobs: 1, badge: "measured",
  jobsFor: (t) => (t?.kind ? 2 : 1), minutesFor: () => 3,
  keywords: ["loop", "seamless", "cinemagraph", "boomerang", "gif", "repeat"],
  overlay: "background:radial-gradient(circle at 50% 50%, transparent 42%, rgba(242,255,89,.28) 44% 48%, transparent 50%)",
  fields: [
    { id: "motion", label: "What moves", placeholder: MOTION_HINT },
    { id: "seconds", label: "Length", type: "select", options: SECONDS, value: "4" },
    { id: "fix", label: "If the seam shows: trim it, then one bridge render (a 2nd GPU job)", type: "check", value: true },
  ],
  async run(target, ctx) {
    const opts = ctx.opts || {};
    const quality = ctx.quality?.() || "Draft";
    const body = loopBody(target, opts, { seed: ctx.seed(), quality });
    ctx.progress?.("Loop: building the graph…");
    const g = await postJSON(ctx.api, "/soundstage/loop/prompt", body);
    const pid = await ctx.queue(g.prompt, "Seamless loop");
    const raw = await ctx.wait(pid, "save");
    const steps = opts.fix === false || opts.fix === "false" ? ["seal", "trim"] : ["seal", "trim", "bridge"];
    const fixed = await fixSeam(refOfFile(raw), ctx, { steps, quality, motion: body.prompt });
    const tried = fixed.tried.filter((t) => t.how !== "seal" || t.kept).map((t) => (t.kept ? t.how : `${t.how} (no better)`));
    return {
      file: fileOfRef(fixed.ref), kind: "clip", engine: "LTX-2.5 distilled · the same picture at frame 1 and the last frame",
      note: seamLine(fixed.report, tried),
      extra: { seam: fixed.report?.seam, seamless: fixed.report?.verdict === "seamless", seam_badge: fixed.report?.badge,
        tried: fixed.tried, raw: refOfFile(raw), seconds: body.seconds, next: fixed.report?.verdict === "seamless" ? "" : "reseed: run it again" },
    };
  },
});

registerOneClick({
  id: "loop_meter", group: "Loop", label: "Seam meter", order: 1, gpu: false,
  hint: "How visible is the jump when this clip wraps from its last frame to its first? A number, on the CPU",
  applies: ["clip"], keywords: ["seam", "loop", "check", "meter"],
  async run(target, ctx) {
    const r = await postJSON(ctx.api, "/soundstage/loop/seam", { ref: target.ref });
    const m = r.metrics || {};
    ctx.say?.(`${r.badge}: pixel ${m.pixel?.ratio}x, edges ${m.edges?.ratio}x, motion ${m.motion?.ratio}x, jerk ${m.jerk?.ratio}x of the clip's own median step${r.dup_last ? " · the last frame repeats the first (dropped)" : ""}.`);
    ctx.toast?.(r.badge);
    return null;
  },
});

registerOneClick({
  id: "loop_fix", group: "Loop", label: "Fix a loop seam", order: 2, minutes: 2, jobs: 1, badge: "measured",
  hint: "Trim to the best frame pair, then a bridge render back to frame 1: before and after, never a crossfade",
  applies: ["clip"], keywords: ["seam", "loop", "fix", "bridge", "trim"],
  async run(target, ctx) {
    const fixed = await fixSeam(target.ref, ctx, { quality: ctx.quality?.() || "Draft", seed: ctx.seed() });
    const first = fixed.tried[0]?.before || "";
    if (fixed.ref === target.ref) { ctx.say?.(`No fix beat the original (${first}).`); return null; }
    return { file: fileOfRef(fixed.ref), kind: "clip", engine: "Seam fixer (trim · bridge)", note: `${first} → ${fixed.report?.badge}`,
      extra: { seam: fixed.report?.seam, seamless: fixed.report?.verdict === "seamless", tried: fixed.tried } };
  },
});

export const LOOP_IDS = ["loop", "loop_meter", "loop_fix"];
