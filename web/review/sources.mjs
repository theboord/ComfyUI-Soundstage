// Which files the synced review shows for the current shot, from the App's saved takes (rendersFor(shotId)):
//   Clay        the stage preview video (rung 1, "previz": the grey clay pass the generators were guided by)
//   Colour clay the lifelike colour stage, drawn live from the 3D stage at each frame (there is no file for it)
//   Draft       the latest Draft
//   Final       the latest Final (with sound when it has it)

/** Spec for SyncReview.setSources. renders: { previz, draft, final, final_sound, final_audio } URLs; stage: the 3D stage. */
export function shotReviewSources(renders = {}, stage = null) {
  const shot = stage?.state?.shot || {};
  const fps = shot.fps > 0 ? shot.fps : 24;
  const frames = shot.frames > 0 ? shot.frames : 0;
  const final = renders.final_sound || renders.final_audio || renders.final || null;
  const live = stage?.renderFrameTo && frames ? {
    fps, frames,
    width: stage.fw || 960, height: stage.fh || 540,
    draw(canvas, frame) {
      const src = stage.renderFrameTo("color", Math.min(frames - 1, Math.max(0, frame)));
      if (canvas.width !== src.width || canvas.height !== src.height) { canvas.width = src.width; canvas.height = src.height; }
      canvas.getContext("2d").drawImage(src, 0, 0);
    },
  } : null;
  return {
    fps,
    slots: [
      renders.previz ? { label: "Clay", url: renders.previz } : null,
      live ? { label: "Colour clay", live } : null,
      renders.draft ? { label: "Draft", url: renders.draft } : null,
      final ? { label: "Final", url: final } : null,
    ],
  };
}
