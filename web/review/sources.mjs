// Which files the synced review shows for the current shot, from the App's saved takes (rendersFor(shotId)):
//   Clay        the stage preview video (rung 1, "previz": the grey clay pass the generators were guided by)
//   Colour clay the lifelike colour stage, drawn live from the 3D stage at each frame (there is no file for it)
//   Draft       the latest Draft
//   Final       the latest Final (with sound when it has it)

/** Can the 3D stage draw a frame yet? */
export const stageReady = (stage) => !!(stage?.renderFrameTo && stage.fw > 0 && stage.fh > 0 && stage.state?.shot?.frames > 0);

/** Spec for SyncReview.setSources. renders: { previz, draft, final, final_sound, final_audio } URLs; stage: the 3D stage. */
export function shotReviewSources(renders = {}, stage = null) {
  const shot = stage?.state?.shot || {};
  const fps = shot.fps > 0 ? shot.fps : 24;
  const frames = shot.frames > 0 ? shot.frames : 0;
  const final = renders.final_sound || renders.final_audio || renders.final || null;
  const live = stage?.renderFrameTo && frames ? {
    fps, frames,
    width: stage.fw || 960, height: stage.fh || 540,
    /** The stage can draw: it has a frame size (before the scene is up the snapshot is 0 x 0, or the render throws). */
    ready: () => stageReady(stage),
    draw(canvas, frame) {
      const src = stage.renderFrameTo("color", Math.min(frames - 1, Math.max(0, frame)));
      if (!src?.width || !src?.height) throw new Error("the stage is not ready");
      if (canvas.width !== src.width || canvas.height !== src.height) { canvas.width = src.width; canvas.height = src.height; }
      canvas.getContext("2d").drawImage(src, 0, 0);
    },
  } : null;
  // Review opened before the stage was up (the App's start screen): no shot length yet. The tile waits and the player
  // re-reads the sources when the stage first renders (SyncReview.stageReady, called from the stage's onRendered).
  const waiting = !live && stage?.renderFrameTo ? { label: "Colour clay", waitStage: true } : null;
  return {
    fps,
    slots: [
      renders.previz ? { label: "Clay", url: renders.previz } : null,
      live ? { label: "Colour clay", live } : waiting,
      renders.draft ? { label: "Draft", url: renders.draft } : null,
      final ? { label: "Final", url: final } : null,
    ],
  };
}
