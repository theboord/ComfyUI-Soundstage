// ✦ One-click › Effects: weather and time (Nightfall, Flood, Rain, Snow, Fog, Golden hour), Empty the scene, Cutout,
// Living photo, and the practical-FX readings of the cartoon effects (Pop, Inflate, Cake, Squish, Unzip, Gulp).
//   Stills: one FLUX 3 Klein edit with our own physical prompt (what the water, the light, the wet surfaces do).
//   Clips: the edited frame 1, then LTX Ripple carries it through the clip with its motion, camera and sound.
//   Empty the scene on a clip: the LTX-2.5 clean-plate IC-LoRA. Cutout on a clip: the LTX-2.5 alpha-gen IC-LoRA,
//   saved as ProRes 4444 with alpha plus an MP4 preview on black.
// Every prompt asks for the same camera, lens, framing, people and objects: an effect is a change of the world, not a
// new picture. Prompts are ours (docs/oneclick.md); nothing here comes from another app.
import { registerOneClick, runStillEdit, runEditThenRipple, runI2V, pickModel, loadNode, out, saveVideoNodes, KLEIN } from "./oneclick.mjs";

export const KEEP = "Keep every person, their face, hair, clothes and pose, every object, the set, the camera position, the lens and the framing exactly the same. Add nothing: no new people, animals, vehicles or objects anywhere in the picture. A real photograph from a film set, not a render.";

/** Weather and time of day: [id, label, hint, still prompt, Ripple's "what changed", preview filter, preview overlay, keywords]. */
export const WORLD = [
  ["nightfall", "Nightfall", "The same place after dark, practical lights on",
    "Make it night, about an hour after sunset: a deep blue-black sky with no sun. Every practical light is on: street lamps in sodium orange, windows in warm tungsten, car headlights and tail lights lit, signs glowing. People and objects are lit only by those practicals, with real falloff into shadow and a little film grain. No added fog, no glow on dark surfaces.",
    "The same scene at night, lit by street lamps, windows and car lights.",
    "brightness(.42) saturate(.7) contrast(1.15)", "background:radial-gradient(circle at 30% 35%, rgba(255,170,70,.35), transparent 22%), linear-gradient(180deg, rgba(8,16,48,.55), rgba(0,0,0,.25))",
    ["night", "dark", "evening", "after dark", "time"]],
  ["flood", "Flood", "Knee-deep floodwater, a real water line",
    "Flood this place knee-deep: opaque muddy brown floodwater about 50 cm deep covers the whole ground, flat and nearly still with slow ripples, leaves and small debris floating. People who are already in the picture stand in it up to just below the knee: their feet and shins are hidden under the murky surface, with ripple rings around their legs and dark wet trousers above the water line. Walls, doors, kerbs and wheels disappear into the water at a sharp water line with a dark wet band above it. The water reflects the buildings and the sky in soft, broken reflections.",
    "The same scene flooded knee-deep with muddy water.",
    "saturate(.8) brightness(.9)", "background:linear-gradient(180deg, transparent 58%, rgba(96,76,46,.8) 60%, rgba(64,52,34,.88))",
    ["water", "flooded", "storm", "disaster"]],
  ["rain", "Rain", "Heavy rain, wet streets, real reflections",
    "Make it pour with heavy rain: dark grey storm clouds, visible rain streaks in the air, splashes on the ground, puddles and wet asphalt that mirrors every light, rain dripping from edges and running down glass. Hair and clothes look damp. Soft, flat storm light.",
    "The same scene in heavy rain, everything wet.",
    "brightness(.78) saturate(.75) contrast(1.05)", "background:repeating-linear-gradient(104deg, rgba(220,230,255,.22) 0 1px, transparent 1px 7px), linear-gradient(180deg, rgba(40,48,60,.35), transparent)",
    ["storm", "wet", "weather"]],
  ["snow", "Snow", "Fresh snow on every surface, light snowfall",
    "Make it winter with fresh snow: a 10 cm layer of clean snow on the ground, roofs, cars, ledges and branches, light snow falling, cold flat white overcast light, breath visible in the cold air. Footprints and tyre tracks where people and cars have been.",
    "The same scene in snow, a fresh layer on everything.",
    "brightness(1.12) saturate(.45) contrast(.9)", "background:radial-gradient(circle, rgba(255,255,255,.75) 0 1px, transparent 1.5px) 0 0/11px 11px, linear-gradient(180deg, transparent 70%, rgba(255,255,255,.55))",
    ["winter", "cold", "weather", "christmas"]],
  ["fog", "Fog", "Dense morning fog, depth falls away",
    "Fill the place with dense morning fog: visibility falls off over 30 to 50 metres, the background fades into soft grey, lights bloom gently in the haze, low contrast, damp surfaces. The nearest people and objects stay clear.",
    "The same scene in dense fog.",
    "contrast(.7) brightness(1.08) saturate(.7)", "background:linear-gradient(180deg, rgba(205,210,215,.62), rgba(205,210,215,.28))",
    ["mist", "haze", "smoke", "weather"]],
  ["golden_hour", "Golden hour", "Low warm sun, long soft shadows",
    "Relight it at golden hour: a low warm sun about 10 degrees above the horizon, long soft shadows across the ground, warm rim light on hair and edges, a sky going from soft orange near the horizon to pale blue above.",
    "The same scene at golden hour, low warm sun.",
    "sepia(.4) saturate(1.35) hue-rotate(-10deg) brightness(1.04)", "background:linear-gradient(100deg, rgba(255,170,80,.35), transparent 60%)",
    ["sunset", "sunrise", "magic hour", "warm", "time"]],
];

for (const [id, label, hint, prompt, ripple, preview, overlay, keywords] of WORLD) {
  registerOneClick({
    id, group: "Effects", label, hint, applies: ["still", "clip"], gpu: true, minutes: 1, preview, overlay, keywords,
    jobsFor: (t) => (t?.kind === "clip" ? 2 : 1), minutesFor: (t) => (t?.kind === "clip" ? 4 : 1),
    run: (target, ctx) => (target.kind === "clip"
      ? runEditThenRipple(target, ctx, { prompt: `${prompt} ${KEEP}`, ripplePrompt: ripple }).then((r) => ({ ...r, note: "frame 1 edited, Ripple carried it" }))
      : runStillEdit(target, ctx, { prompt: `${prompt} ${KEEP}` }).then((file) => ({ file, kind: "still", engine: "FLUX 3 Klein edit" }))),
  });
}

// ------------------------------------------------------------------------------------------------ Empty the scene

export const EMPTY_STILL = "Remove every person and every vehicle from the picture and show the empty place behind them: the ground, walls, doors and windows continue naturally where they stood, with matching light, texture and perspective, and no shadows or reflections of them left behind. Keep the set, every fixed object, the camera position, the lens, the framing and the light exactly the same. A real photograph of an empty location.";

registerOneClick({
  id: "empty", group: "Effects", label: "Empty the scene", hint: "Take the people and cars out, keep the place",
  applies: ["still", "clip"], gpu: true, minutes: 1, minutesFor: (t) => (t?.kind === "clip" ? 3 : 1), keywords: ["remove", "clean plate", "erase", "people", "plate"],
  preview: "saturate(.6) brightness(1.05)", overlay: "background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.08))",
  fields: [{ id: "what", label: "What to take out (blank = people and vehicles)", placeholder: "the man in the red jacket", when: (t) => t.kind === "still" }],
  async run(target, ctx) {
    if (target.kind === "still") {
      const what = String(ctx.opts.what || "").trim();
      const prompt = what ? EMPTY_STILL.replace("every person and every vehicle", what).replace(/of them/g, "of it") : EMPTY_STILL;
      return { file: await runStillEdit(target, ctx, { prompt }), kind: "still", engine: "FLUX 3 Klein edit" };
    }
    const m = pickModel(ctx.models?.clean, /Clean-Plate/);
    if (!m) throw new Error("the LTX-2.5 clean-plate IC-LoRA isn't installed here");
    const p = {
      1: { class_type: "SoundstageClipLoad", inputs: { source: target.ref, fps: 24, start_frame: 0, max_frames: 161 } },
      2: { class_type: "SoundstageCleanPlate", inputs: { images: out(1, 0), prompt: "", negative: "", fps: out(1, 2), ...m, seed: ctx.seed() } },
      ...saveVideoNodes(out(2), out(1, 2), ctx.prefix()),
    };
    const pid = await ctx.queue(p);
    return { file: await ctx.wait(pid, "51"), kind: "clip", engine: "LTX-2.5 clean-plate IC-LoRA", note: "the plate has no sound (the people are gone)" };
  },
});

// ------------------------------------------------------------------------------------------------ Cutout

registerOneClick({
  id: "cutout", group: "Effects", label: "Cutout", hint: "The subject on transparent: PNG, or ProRes 4444 with alpha for a clip",
  applies: ["still", "clip"], gpu: true, minutes: 1, minutesFor: (t) => (t?.kind === "clip" ? 3 : 1), keywords: ["matte", "alpha", "remove background", "key", "roto", "transparent"],
  overlay: "background:repeating-conic-gradient(rgba(255,255,255,.28) 0 25%, rgba(0,0,0,.15) 0 50%) 0 0/12px 12px",
  fields: [{ id: "subject", label: "What to keep (blank = the main subject)", placeholder: "the dog", when: (t) => t.kind === "still" }],
  async run(target, ctx) {
    if (target.kind === "still") {
      const subject = String(ctx.opts.subject || "").trim();
      const m = subject ? pickModel(ctx.models?.matte, /^SAM 3/) : (pickModel(ctx.models?.matte, /^BiRefNet \(core/) || pickModel(ctx.models?.matte, /BiRefNet|RMBG|BEN2/));
      if (!m) throw new Error(subject ? "SAM 3.1 isn't installed here" : "no background-removal model here (BiRefNet)");
      const p = {
        1: loadNode(target.ref),
        2: { class_type: "SoundstageMatte", inputs: { images: out(1), prompt: subject || "person", fps: 24, ...m, seed: 0 } },
        9: { class_type: "SaveImage", inputs: { images: out(2, 0), filename_prefix: ctx.prefix() } },
      };
      const pid = await ctx.queue(p);
      return { file: await ctx.wait(pid, "9"), kind: "still", engine: subject ? `SAM 3.1 (“${subject}”)` : "BiRefNet", note: "RGBA PNG" };
    }
    const m = pickModel(ctx.models?.matte, /Alpha-Gen/);
    if (!m) throw new Error("the LTX-2.5 alpha-gen IC-LoRA isn't installed here");
    if (!ctx.models?.vhs) throw new Error("ProRes 4444 needs VideoHelperSuite (VHS_VideoCombine)");
    const p = {
      1: { class_type: "SoundstageClipLoad", inputs: { source: target.ref, fps: 24, start_frame: 0, max_frames: 161 } },
      2: { class_type: "SoundstageMatte", inputs: { images: out(1, 0), prompt: "person", fps: out(1, 2), ...m, seed: ctx.seed() } },
      // the delivery: ProRes 4444 with the alpha channel (VHS keeps RGBA as yuva444p10le)
      60: { class_type: "VHS_VideoCombine", inputs: { images: out(2, 0), frame_rate: out(1, 2), loop_count: 0, filename_prefix: ctx.prefix("alpha"),
        format: "video/ProRes", profile: "4444", pingpong: false, save_output: true, audio: out(1, 1) } },
      // the take: the subject on black, so it plays in the browser
      3: { class_type: "MaskToImage", inputs: { mask: out(2, 1) } },
      4: { class_type: "ImageBlend", inputs: { image1: out(1, 0), image2: out(3), blend_factor: 1.0, blend_mode: "multiply" } },
      ...saveVideoNodes(out(4), out(1, 2), ctx.prefix(), out(1, 1)),
    };
    const pid = await ctx.queue(p);
    const file = await ctx.wait(pid, "51");
    let prores = null;
    try {
      const e = (await (await ctx.api.fetchApi(`/history/${pid}`)).json())[pid];
      prores = e?.outputs?.["60"]?.gifs?.[0] || null;
    } catch { /* the preview is still the take */ }
    return { file, kind: "clip", engine: "LTX-2.5 alpha-gen IC-LoRA", extra: { prores }, note: prores ? `ProRes 4444 with alpha: ${prores.filename}` : "preview on black" };
  },
});

// ------------------------------------------------------------------------------------------------ Living photo

export const LIVING = "A living photograph: the exact same picture, the camera locked off on a tripod. Only what is already in the picture moves, and only a little, for five seconds: people breathe, blink and shift their weight slightly, hair and loose clothes stir in a light breeze, leaves sway, water that is already there ripples gently. Every person, boat, vehicle and object stays where it is, the same shape and size. Nothing new appears: no smoke, steam, mist, splashes, sparks or particles that are not already in the picture. The camera never moves, no zoom. Photographic, real.";

registerOneClick({
  id: "living_photo", group: "Effects", label: "Living photo", hint: "Five seconds of small real motion and sound, camera locked off",
  applies: ["still"], gpu: true, minutes: 2, keywords: ["animate", "cinemagraph", "motion", "alive", "video"], glyph: "◉",
  async run(target, ctx) {
    const r = await runI2V(target, ctx, { prompt: LIVING, seconds: 5, sound: "The quiet natural ambience of the place: air, distant traffic or birds, small movements." });
    return { ...r, note: "LTX-2.5, 5 s" };
  },
});

// ------------------------------------------------------------------------------------------------ practical FX
// Cartoon physics doesn't meet the Hollywood-real bar, so each is the way a practical effects crew would shoot it:
// a replica, a double, a puppet, a rig. Experimental: prompt-only LTX-2.5, no effect LoRAs (docs/oneclick.md).

export const PRACTICAL = [
  ["fx_pop", "Pop", "The main object bursts like a balloon prop",
    "Practical effect shot for real on set, camera locked off: the main object is a thin latex balloon replica of itself and it bursts in a fraction of a second, the skin tearing and snapping away, small fragments and a puff of talc falling and settling on the ground. People nearby flinch naturally. Real physics, real light, the sharp pop of a balloon."],
  ["fx_inflate", "Inflate", "An inflatable double slowly fills with air",
    "Practical effect shot for real on set, camera locked off: the main object is an inflatable vinyl double of itself, and over four seconds it inflates, its surfaces rounding and stretching smooth, seams pulling tight, slightly lifting off the ground. Real light and shadows move with it. The hiss of air from a blower."],
  ["fx_cake", "Cake", "It was a cake all along: a knife cuts in",
    "Practical effect shot for real on set, camera locked off: the main object is revealed as a hyper-real cake replica. A hand with a chef's knife enters, slices straight down through it and pulls the slice apart, showing real sponge layers, buttercream and fondant inside, crumbs falling. Real light, food photography detail."],
  ["fx_squish", "Squish", "A soft foam replica squashes and springs back",
    "Practical effect shot for real on set, camera locked off: the main object is a soft foam replica of itself. A gloved hand presses down on it, it squashes to half its height with real foam creases, then slowly springs back to its shape when released. Real light and contact shadows."],
  ["fx_unzip", "Unzip", "A hidden zip opens the surface like fabric",
    "Practical effect shot for real on set, camera locked off: a hidden zip runs along the main object, a hand pulls the zip pull and the surface opens like a fabric costume, the two sides peeling back to show a plain cloth lining inside. Real fabric folds, real light, the sound of a zip."],
  ["fx_gulp", "Gulp", "A creature puppet swallows it in one gulp",
    "Practical creature effect shot for real on set, camera locked off: a large, wet, realistic animatronic creature mouth rises from below the frame, opens wide, closes over the main object in one gulp and sinks back out of frame, leaving the place empty. Real skin texture, saliva sheen, real light, a deep wet gulp sound."],
];

for (const [id, label, hint, prompt] of PRACTICAL) {
  registerOneClick({
    id, group: "Effects", label, hint: `${hint} (practical FX)`, applies: ["still"], gpu: true, minutes: 2, badge: "experimental", glyph: "✸",
    keywords: ["fun", "cartoon", "viral", "effect", "fx"],
    run: (target, ctx) => runI2V(target, ctx, { prompt, seconds: 5 }).then((r) => ({ ...r, note: "experimental practical-FX reading" })),
  });
}

export const EFFECT_IDS = [...WORLD.map((w) => w[0]), "empty", "cutout", "living_photo", ...PRACTICAL.map((p) => p[0])];
export { KLEIN };
