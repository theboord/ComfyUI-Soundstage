// ✦ One-click › Camera › Reshoot: the same take from a slightly different camera. The take is measured in 3D frame by
// frame (Depth Anything 3, the model Video → Stage uses), the camera is re-aimed relative to the original on every frame
// (so the original move is kept), the new view's depth becomes the guide and the warped frame 1 the first frame of an
// LTX-2.5 union-control render (Recast's engine) with the take's own sound. Capped where it stays real: ±15° orbit,
// ±8° rise, a 25% dolly, 0.7–1.6x lens. Server side: soundstage/reshoot through /soundstage/reshoot. docs/reshoot.md.
import { registerOneClick } from "./oneclick.mjs";
import { fileOfRef } from "./loop.mjs";

export const LIMITS = { orbit_deg: [-15, 15], tilt_deg: [-8, 8], dolly: [-0.25, 0.25], lens: [0.7, 1.6] };
export const MOVES = [
  ["orbit_right", "Orbit right 10°", { orbit_deg: 10 }], ["orbit_left", "Orbit left 10°", { orbit_deg: -10 }],
  ["push_in", "Push in 15%", { dolly: 0.15 }], ["pull_out", "Pull out 15%", { dolly: -0.15 }],
  ["longer_lens", "Longer lens (1.35x)", { lens: 1.35 }], ["wider_lens", "Wider lens (0.8x)", { lens: 0.8 }],
  ["higher", "Higher 6°", { tilt_deg: 6 }], ["lower", "Lower 6°", { tilt_deg: -6 }],
  ["orbit_right_max", "Orbit right 15° (the limit)", { orbit_deg: 15 }], ["orbit_left_max", "Orbit left 15° (the limit)", { orbit_deg: -15 }],
];

/** A move clamped to the safe range: {orbit_deg, tilt_deg, dolly, lens} + what was held back. */
export function clampMove(m = {}) {
  const def = { orbit_deg: 0, tilt_deg: 0, dolly: 0, lens: 1 };
  const out = {}, notes = [];
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    let v = Number(m[k] ?? def[k]);
    if (!Number.isFinite(v)) v = def[k];
    if (v < lo || v > hi) notes.push(`${k.replace("_deg", "")} ${v} held at ${Math.min(hi, Math.max(lo, v))}`);
    out[k] = Math.min(hi, Math.max(lo, v));
  }
  return { move: out, notes };
}

/** "orbit 12, dolly 0.1, lens 1.2, tilt -4" -> a move (the free-text box), or null when nothing was understood. */
export function parseMove(text) {
  const m = {};
  const s = String(text || "").toLowerCase();
  const num = (re) => { const r = re.exec(s); return r ? parseFloat(r[1]) : null; };
  const o = num(/orbit\s*(-?\d+(?:\.\d+)?)/), t = num(/(?:tilt|rise|jib)\s*(-?\d+(?:\.\d+)?)/);
  const d = num(/(?:dolly|push)\s*(-?\d+(?:\.\d+)?)/), l = num(/lens\s*(\d+(?:\.\d+)?)/);
  if (o != null) m.orbit_deg = o;
  if (t != null) m.tilt_deg = t;
  if (d != null) m.dolly = Math.abs(d) > 1 ? d / 100 : d;   // "dolly 15" = 15%
  if (l != null) m.lens = l;
  return Object.keys(m).length ? m : null;
}

export function moveOf(opts = {}) {
  return parseMove(opts.custom) || (MOVES.find((x) => x[0] === opts.move) || MOVES[0])[2];
}

/** Poll a reshoot job until it is done; reports its step. */
export async function waitJob(api, job, onStep = () => {}, { every = 2000, timeoutMs = 3600000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, every));
    // checked before the poll: a server that stopped answering must still time out (the catch below skips the rest)
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out");
    let j;
    try { j = await (await api.fetchApi(`/soundstage/reshoot/job?id=${encodeURIComponent(job)}`)).json(); } catch { continue; }
    if (j.state === "done") return j.result;
    if (j.state === "error" || j.error) throw new Error(j.error || "the reshoot failed");
    onStep(j.step || "Working", j.progress || 0);
  }
}

/** The line on the take: the move in words, and how much of the view had to be invented. */
export function reshootNote(res) {
  const inv = res?.holes != null ? ` · ${Math.round(res.holes * 100)}% of the new view never seen by the original camera` : "";
  return `${res?.words || "new angle"}${inv}`;
}

registerOneClick({
  id: "reshoot", group: "Camera", label: "Reshoot from a new angle", order: 20, badge: "exact",
  hint: "Same take, camera moved: orbit, rise, dolly or lens, the performance and sound kept (capped where it stays real)",
  applies: ["clip"], gpu: true, minutes: 4, jobs: 2,
  keywords: ["reshoot", "camera", "angle", "orbit", "dolly", "lens", "re-aim", "recam"],
  overlay: "background:linear-gradient(115deg, transparent 40%, rgba(242,255,89,.22) 41% 59%, transparent 60%)",
  fields: [
    { id: "move", label: "Move", type: "select", options: MOVES.map(([k, l]) => [k, l]), value: "orbit_right" },
    { id: "custom", label: "Or type it", placeholder: "orbit 12, tilt -4, dolly 10, lens 1.2 (within ±15°, ±8°, 25%, 0.7–1.6x)" },
  ],
  async run(target, ctx) {
    const { move, notes } = clampMove(moveOf(ctx.opts || {}));
    if (notes.length) ctx.say?.(`Reshoot: ${notes.join("; ")} (past that the render has to invent what the camera never saw).`);
    const r = await ctx.api.fetchApi("/soundstage/reshoot", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: target.ref, move, quality: ctx.quality?.() || "Draft", seed: ctx.seed(), keep_sound: true }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.job) throw new Error(j.error || (r.status === 404 ? "this server needs a restart to know the reshoot route" : `HTTP ${r.status}`));
    const res = await waitJob(ctx.api, j.job, (step, p) => ctx.progress?.(`Reshoot: ${step} (${Math.round(p * 100)}%)`));
    return { file: res.file, kind: "clip", engine: "Depth Anything 3 per frame + LTX-2.5 union control (Recast)", note: reshootNote(res),
      extra: { move: res.move, words: res.words, holes: res.holes, preview: res.preview, guide: res.guide, notes: res.notes } };
  },
});

export const RESHOOT_IDS = ["reshoot"];
export { fileOfRef };
