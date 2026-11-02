// ✦ One-click › Camera › Refocus: a focus pull after the render, on any take. Tap mark A on the first frame and mark B
// on the last, pick a T-stop and when the pull happens; the server reads depth for every frame (the stage's own 3D set
// when this take's shot is open, else Depth Anything 3 on the picture: one short GPU job, cached per take), follows
// both marks through the take, eases focus from A to B in diopters like a focus ring, and re-blurs every frame on the
// CPU with a thin-lens circle of confusion and disc bokeh in linear light. The generation is not re-rendered. The result
// lands as a new take (a draft stays a draft, a final a final); Before / after in the results row wipes between them.
// Server side: soundstage/refocus through /soundstage/refocus. docs/refocus.md.
import { readPoint, registerOneClick } from "./oneclick.mjs";

export const T_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];
export const LENSES = [18, 24, 35, 50, 85, 135];
export const SUB = "soundstage_private/refocus";
const DEFAULT_T = 2;

const isClip = (t) => t?.kind === "clip";

/** Can the stage give this take its depth? -> true or a reason. (The take's shot must be the one open on the stage.) */
export function stageUsable(target, stage) {
  if (!stage?.captureSequence) return "the stage isn't open here";
  let sid = "";
  try { sid = stage.activeShot?.()?.id || ""; } catch { /* no stage */ }
  if (!sid) return "the stage isn't open here";
  if (!target?.shot || sid !== target.shot) return "open this take's shot on the stage first";
  return true;
}

/**
 * Where the depth comes from, and whether the App renders the stage's depth pass for it:
 *   depth "stage" -> the stage's (an error if it can't), "da3" -> Depth Anything 3 (the stage's pass still taken, for
 *   the real distance to A, when the shot is open and no distance was given), "auto" -> DA3 on the server, with the
 *   stage's pass along when it can (the server falls back to it when DA3 isn't installed).
 * -> {depth, capture, why}
 */
export function depthPlan(target, stage, opts = {}) {
  const want = ["stage", "da3"].includes(opts.depth) ? opts.depth : "auto";
  const ok = stageUsable(target, stage);
  if (want === "stage" && ok !== true) return { depth: want, capture: false, why: `Stage depth: ${ok}` };
  const needDistance = !opts.subject_m || opts.subject_m === "auto";
  const capture = ok === true && (want !== "da3" || needDistance);
  return { depth: want, capture, why: "" };
}

const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

/** The route's body from the card's options (and what the stage gave: its depth sheet, its lens per frame). The lens
 * comes whenever the take's shot is open, with or without the depth sheet (Depth Anything 3 with a distance given
 * renders no stage pass, but the shot's lens is still the shot's). */
export function refocusBody(target, opts = {}, { stage = null, lens = null } = {}) {
  const auto = (v) => v == null || v === "" || v === "auto";
  const a = readPoint(opts.a) || [0.5, 0.5];
  const b = isClip(target) ? readPoint(opts.b) : null;
  return {
    source: target.ref,
    a, b,
    t_stop: auto(opts.t_stop) ? (lens?.t_stop > 0 ? +lens.t_stop : DEFAULT_T) : num(opts.t_stop, DEFAULT_T),
    focal_mm: auto(opts.lens) ? null : num(opts.lens, null),
    subject_m: auto(opts.subject_m) ? null : num(opts.subject_m, null),
    focus_m: lens?.focus_m > 0 ? +lens.focus_m : null,
    start: num(opts.start, 0.25), land: num(opts.land, 0.75),
    highlights: opts.highlights === true || opts.highlights === "true",   // off unless asked: it is invented light
    depth: ["stage", "da3"].includes(opts.depth) ? opts.depth : "auto",
    stage: stage || null,
    lens: Array.isArray(lens?.focal_mm) && lens.focal_mm.length ? { focal_mm: lens.focal_mm, fps: +lens.fps || 24 } : null,
  };
}

/** The shot's lens on every frame (focal length; the focus distance and T-stop of its lens keys at frame 0). */
export function stageLens(stage, frames = Math.max(1, stage?.state?.shot?.frames || 97)) {
  const out = { focal_mm: [], focus_m: null, t_stop: null, fps: +stage?.state?.shot?.fps || 24 };
  for (let f = 0; f < frames; f++) {
    let c = null;
    try { c = stage._cameraAt(f); } catch { /* */ }
    out.focal_mm.push(+(c?.focal_mm || 0) || 35);
    if (f === 0) { out.focus_m = c?.focus_m > 0 ? +c.focus_m : null; out.t_stop = c?.t_stop > 0 ? +c.t_stop : null; }
  }
  return out;
}

/** Render the shot's Refocus depth pass (16-bit inverse distance) and upload it. -> the route's `stage` block. */
export async function captureStageDepth(stage, ctx) {
  const seq = await stage.captureSequence("depth16", (p) => ctx.progress?.(`Refocus: the stage's depth (${Math.round(p * 100)}%)`));
  const sid = String(stage.activeShot?.()?.id || "shot").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40);
  const sheet = await ctx.upload(seq.blob, `rf_${sid}_${Date.now().toString(36)}.png`, SUB, "input");
  const lens = stageLens(stage, seq.frames);
  return { stage: { sheet, cols: seq.cols, rows: seq.rows, frames: seq.frames, tile: seq.tile, fps: stage.state?.shot?.fps || 24,
    focal_mm: lens.focal_mm, dmax: 10 }, lens };
}

/** Poll a refocus job until it is done; reports its step. */
export async function waitJob(api, job, onStep = () => {}, { every = 2000, timeoutMs = 3600000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, every));
    let j;
    try { j = await (await api.fetchApi(`/soundstage/refocus/job?id=${encodeURIComponent(job)}`)).json(); } catch { continue; }
    if (j.state === "done") return j.result;
    if (j.state === "error" || j.error) throw new Error(j.error || "the refocus failed");
    onStep(j.step || "Working", j.progress || 0);
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out");
  }
}

const metres = (m) => (m == null ? "∞" : m < 1 ? `${Math.round(m * 100)} cm` : `${(+m).toFixed(1)} m`);

/** The line on the take: the stop, the pull in metres, where the depth came from. */
export function refocusNote(res) {
  const f = res?.focus || {};
  const fm = Array.isArray(f.focus_m) ? f.focus_m : [];
  const pull = fm.length > 1 && res?.kind === "clip" ? `${metres(fm[0])} → ${metres(fm[fm.length - 1])}` : `focus ${metres(fm[0])}`;
  const src = res?.depth === "stage" ? "stage depth" : "Depth Anything 3 depth (approximate)";
  return `T${f.t_stop ?? "?"} · ${f.focal_mm ?? "?"} mm · ${pull} · ${src}`;
}

registerOneClick({
  id: "refocus", group: "Camera", label: "Refocus (focus pull)", order: 30, badge: "approximate",
  hint: "Tap A and B: focus pulls from one to the other at your T-stop, real lens blur from depth, no re-render",
  applies: ["still", "clip"], gpu: true, jobs: 1,
  gpuWith: (o) => o?.depth !== "stage",      // the stage's depth needs no GPU (the Run button says so)
  minutesFor: (t) => (isClip(t) ? 6 : 1),   // DA3 (cached per take) + the CPU re-blur: 2.5-4.5 s per 1080p frame
  keywords: ["refocus", "focus", "pull", "rack", "bokeh", "depth of field", "dof", "t-stop", "aperture", "blur", "lens"],
  overlay: "background:radial-gradient(circle at 35% 45%, transparent 18%, rgba(20,16,24,.55) 52%); backdrop-filter:blur(1.2px)",
  fields: [
    { id: "a", label: "A · first frame", type: "point", frame: "first", value: "0.500,0.450",
      title: "Mark A: tap where the focus starts, on the take's first frame (arrow keys nudge it)" },
    { id: "b", label: "B · last frame", type: "point", frame: "last", value: "0.500,0.550", when: isClip,
      title: "Mark B: tap where the focus lands, on the take's last frame (arrow keys nudge it)" },
    { id: "t_stop", label: "T-stop", type: "select", value: "auto",
      title: "Auto: the open shot's T-stop, else T2. Depth of field follows the f-number; a cine lens's T-stop is its f-number less under 1/3 stop of light, so the two are used as one",
      options: [["auto", "Shot's / T2"], ...T_STOPS.map((t) => [String(t), `T${t}`])] },
    { id: "start", label: "Pull starts", type: "select", value: "0.25", when: isClip,
      options: [["0", "At the top"], ["0.1", "10% in"], ["0.25", "25% in"], ["0.4", "40% in"], ["0.5", "Halfway"]] },
    { id: "land", label: "Pull lands", type: "select", value: "0.75", when: isClip,
      options: [["0.5", "Halfway"], ["0.6", "60% in"], ["0.75", "75% in"], ["0.9", "90% in"], ["1", "At the end"]] },
    { id: "lens", label: "Lens", type: "select", value: "auto",
      title: "Auto: the open shot's focal length on every frame (zooms included); without this take's shot open on the stage, 35 mm, said on the take",
      options: [["auto", "Shot's / 35 mm"], ...LENSES.map((l) => [String(l), `${l} mm`])] },
    { id: "subject_m", label: "Distance to A", type: "select", value: "auto",
      title: "Auto: the stage's distance at A when the shot is open, else the shot's focus distance, else a guessed 2.5 m (said on the take). Depth Anything 3 gives relative depth: one real distance makes the T-stop mean a real stop",
      options: [["auto", "Stage / 2.5 m"], ["0.6", "60 cm"], ["1", "1 m"], ["1.5", "1.5 m"], ["2", "2 m"], ["3", "3 m"], ["5", "5 m"], ["10", "10 m"]] },
    { id: "depth", label: "Depth", type: "select", value: "auto",
      options: [["auto", "Auto (DA3)"], ["stage", "Stage 3D set (no GPU)"], ["da3", "Depth Anything 3"]],
      title: "Auto: Depth Anything 3 on the picture (one GPU job, cached per take), else the stage. The stage's 3D set: real distances, no GPU, but it is the clay set, not the generated pixels" },
    { id: "highlights", label: "Bright bokeh", type: "check", value: false,
      title: "Small clipped lights (practicals, bulbs) are brightened before the blur so they bloom into bright discs: light the camera never recorded. Walls, windows and white text are left alone." },
  ],
  async run(target, ctx) {
    const o = ctx.opts || {};
    const plan = depthPlan(target, ctx.stage, o);
    if (plan.why) throw new Error(plan.why);
    let stage = null, lens = null;
    if (plan.capture) {
      try { ({ stage, lens } = await captureStageDepth(ctx.stage, ctx)); } catch (e) {
        if (plan.depth === "stage") throw e;
        ctx.say?.(`Refocus: the stage's depth pass didn't render (${e.message}); using Depth Anything 3 alone.`);
      }
    }
    // the shot's lens and T-stop whenever this take's shot is open, even when no depth pass was taken
    if (!lens && stageUsable(target, ctx.stage) === true) { try { lens = stageLens(ctx.stage); } catch { /* no lens: 35 mm / T2 */ } }
    const body = refocusBody(target, o, { stage, lens });
    const r = await ctx.api.fetchApi("/soundstage/refocus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.job) throw new Error(j.error || (r.status === 404 ? "this server needs a restart to know the refocus route" : `HTTP ${r.status}`));
    const res = await waitJob(ctx.api, j.job, (step, p) => ctx.progress?.(`Refocus: ${step} (${Math.round(p * 100)}%)`));
    for (const n of res.notes || []) if (!/^depth: measured before/.test(n)) ctx.say?.(`Refocus: ${n}.`);
    return { file: res.file, kind: res.kind === "still" ? "still" : "clip",
      engine: `Refocus: ${res.depth === "stage" ? "stage depth" : "Depth Anything 3"} + thin-lens disc bokeh (CPU)`, note: refocusNote(res),
      extra: { focus: res.focus, depth: res.depth, notes: res.notes, a_track: res.a_track, b_track: res.b_track } };
  },
});

export const REFOCUS_IDS = ["refocus"];
