// ✦ One-click › Camera: a new angle on a still, two honest ways, and the card says which one ran.
//   Approximate (any still): FLUX 3 Klein re-imagines the same moment from a small orbit, a low or high angle, a push in
//     or a pull back. One picture can't show what was behind things: whatever the move reveals is invented.
//   Exact (a ④ Frame candidate of the open shot): the shot camera moves on the 3D stage (nothing on the shot changes:
//     stage.previewCamera), the stage renders its Color and Depth passes from there, and Klein paints the new frame
//     locked to that geometry (the ④ Frame lock recipe), with the original frame as the look to keep.
// On clips the camera move is Reshoot (Track B: web/oneclick/reshoot.mjs).
import { registerOneClick, runStillEdit, stagePass, stageReason, pickModel, editSize, withSize, editInputs, out, KLEIN, ONECLICK_ENV } from "./oneclick.mjs";
import { KEEP } from "./effects.mjs";

/** [id, label, hint, the Klein instruction for an approximate move, the stage move for an exact one] */
export const MOVES = [
  ["orbit_left", "Orbit left", "About 20° around the subject to the left",
    "Show the exact same moment photographed from a camera moved about 20 degrees to the left around the main subject, at the same height and distance, still aimed at the subject. The background shifts with real parallax.",
    { orbit: 20 }],
  ["orbit_right", "Orbit right", "About 20° around the subject to the right",
    "Show the exact same moment photographed from a camera moved about 20 degrees to the right around the main subject, at the same height and distance, still aimed at the subject. The background shifts with real parallax.",
    { orbit: -20 }],
  ["low_angle", "Low angle", "Camera near the ground, looking up",
    "Show the exact same moment photographed from a low camera about 40 cm above the ground, looking up at the main subject from the same distance. The horizon drops low in the frame, more sky or ceiling shows.",
    { low: true }],
  ["high_angle", "High angle", "Camera raised, looking down",
    "Show the exact same moment photographed from a camera raised about 2.5 metres higher, looking down at the main subject from the same distance. More ground shows, the horizon rises.",
    { high: true }],
  ["push_in", "Push in", "Closer, same lens",
    "Show the exact same moment photographed from a camera moved closer, a third of the way towards the main subject, with the same lens: a tighter shot, the subject larger in frame, real perspective change.",
    { push: 0.35 }],
  ["pull_back", "Pull back", "Further back, same lens: a wider shot",
    "Show the exact same moment photographed from a camera moved back to about one and a half times the distance, with the same lens: a wider shot that shows more of the place around the subject.",
    { push: -0.5 }],
];

const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const len = (a) => Math.hypot(...a);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/**
 * The shot camera {position, target, focal_mm, roll?} after a move: {orbit: deg (+ = to the camera's left)},
 * {low: true}, {high: true}, {push: share of the distance (+ closer, - further)}. Y is up, metres (the stage).
 */
export function moveCamera(cam, move) {
  const p = [...cam.position], t = [...cam.target];
  const off = sub(p, t);
  let np = p;
  if (move.orbit) {
    const th = (move.orbit * Math.PI) / 180;
    const rot = (a) => [off[0] * Math.cos(a) + off[2] * Math.sin(a), off[1], -off[0] * Math.sin(a) + off[2] * Math.cos(a)];
    const fwd = sub(t, p), right = cross(fwd, [0, 1, 0]);
    let cand = add(t, rot(th));
    // + orbit moves the camera to its own left (against its right vector)
    if (dot(sub(cand, p), right) * Math.sign(move.orbit) > 0) cand = add(t, rot(-th));
    np = cand;
  } else if (move.low) {
    const flat = Math.hypot(off[0], off[2]) || 1, d = len(off);
    const y = 0.4, k = Math.sqrt(Math.max(0.01, d * d - (y - t[1]) ** 2)) / flat;
    np = [t[0] + off[0] * k, y, t[2] + off[2] * k];
  } else if (move.high) {
    np = [p[0], p[1] + 2.5, p[2]];
  } else if (move.push) {
    np = add(t, off.map((v) => v * (1 - move.push)));
  }
  return { ...cam, position: np.map((v) => +v.toFixed(4)), target: t };
}

/**
 * The exact angle: Klein on the moved camera's Color pass, locked to its Depth pass (the ④ Frame lock recipe).
 * The original frame is NOT given as a reference: tested 2026-11-02, Klein then copied the original's camera and
 * ignored the moved passes (docs/oneclick.md). The look comes from the shot's description instead.
 */
export function exactAnglePrompt({ color, depth, prompt, model, seed, prefix, width, height, denoise = 0.9 }) {
  return {
    1: { class_type: "SoundstageImageLoad", inputs: { source: color } },
    2: { class_type: "SoundstageImageLoad", inputs: { source: depth } },
    4: { class_type: "SoundstageEditImage", inputs: editInputs({ image: out(1), prompt, model, seed, width, height, control: out(2), denoise }) },
    9: { class_type: "SaveImage", inputs: { images: out(4), filename_prefix: prefix } },
  };
}

export const EXACT_LOOK = "A real photograph of this scene from exactly this camera: every person, vehicle and object where the first image puts it, at its size, nothing added, nothing missing. Real materials, real light, photographic.";

MOVES.forEach(([id, label, hint, prompt, move], i) => {
  registerOneClick({
    id: `angle_${id}`, group: "Camera", label, hint: `${hint}. Approximate: what it reveals is invented`, applies: ["still"], gpu: true, minutes: 1,
    badge: "approximate", order: i, keywords: ["angle", "camera", "new angle", "orbit", "reframe"], glyph: "⟲",
    run: (target, ctx) => runStillEdit(target, ctx, { prompt: `${prompt} ${KEEP.replace(" the camera position, the lens and the framing", " the lens")}` })
      .then((file) => ({ file, kind: "still", engine: "FLUX 3 Klein (approximate angle)", extra: { move: id } })),
  });
  registerOneClick({
    id: `exact_${id}`, group: "Camera", label: `${label} · exact`, hint: `${hint}, from the 3D stage: the real geometry. Experimental: the look is painted again from the shot's words, so it can come out clay-like`, applies: ["still"], gpu: true, minutes: 1,
    badge: "experimental", order: 100 + i, keywords: ["angle", "camera", "new angle", "stage", "exact"], glyph: "⟲",
    available: (t) => stageReason(t, ctxStage()),
    async run(target, ctx) {
      const st = ctx.stage;
      const ok = stageReason(target, st);
      if (ok !== true) throw new Error(ok);
      const model = pickModel(ctx.models?.edit, KLEIN);
      if (!model) throw new Error("FLUX 3 Klein isn't installed here");
      const cam = moveCamera(st._shotCameraAt(0), move);
      ctx.progress("Moving the shot camera on the stage, rendering its passes…");
      const color = await stagePass(st, ctx, "color", { camera: cam, name: `${id}_color` });
      const depth = await stagePass(st, ctx, "depth", { camera: cam, name: `${id}_depth` });
      const desc = String(ctx.pipeline?.ctx?.look?.state?.description || "").trim();
      const sz = editSize(await withSize(target));
      const p = exactAnglePrompt({ color, depth, prompt: `${desc ? desc + " " : ""}${EXACT_LOOK}`, model, seed: ctx.seed(),
        prefix: ctx.prefix(), width: sz.width || st.fw, height: sz.height || st.fh });
      const pid = await ctx.queue(p);
      return { file: await ctx.wait(pid, "9"), kind: "still", engine: "stage camera + FLUX 3 Klein locked to the stage depth", extra: { move: id, camera: cam } };
    },
  });
});

function ctxStage() { return ONECLICK_ENV.stage; }

export const ANGLE_IDS = MOVES.flatMap(([id]) => [`angle_${id}`, `exact_${id}`]);
