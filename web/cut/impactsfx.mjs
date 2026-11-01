// Impact sounds on A2 (Milestone 21): one cue per baked hit (scene.physics.events), placed where the hit lands in the
// cut. The server picks the cues (material, gain by impulse; soundstage/cut/impact_sfx.py) from a small synthesised
// library cached once in the output folder; this file only maps them onto the timeline.
import * as TL from "./timeline.mjs";

/**
 * Audio clips for the cues in a cut. cues: [{frame (shot frame), material, gain_db, variant}]; library: {material:
 * [{url, seconds}]}. A hit shows in every clip whose source range holds its frame (a coverage cut can show the same
 * hit twice: each gets its cue). Returns normalised clip objects for A2 tagged meta.impact.
 */
export function impactClips(project, cues, library, fps = 24) {
  const out = [];
  for (const row of TL.layout(project)) {
    if (!row.shot) continue;
    for (const c of cues || []) {
      if (c.frame < row.in || c.frame >= row.out) continue;
      const files = library?.[c.material] || library?.wood || [];
      const f = files[(c.variant || 0) % Math.max(1, files.length)];
      if (!f?.url) continue;
      const frames = Math.max(1, Math.round((f.seconds || 1) * fps));
      out.push({ id: `impact_${row.index}_${c.frame}`, track: TL.ROLE_TRACK.sfx, url: f.url, start_frame: row.recIn + (c.frame - row.in),
        in: 0, out: frames, frames, gain_db: c.gain_db || 0, fade_out: Math.min(6, frames - 1), label: `${c.material} hit`,
        meta: { impact: true, shot: row.shot.id, frame: c.frame, material: c.material } });
    }
  }
  return out;
}

/** The project's audio with its old impact cues replaced by new ones (re-running never stacks them). */
export function withImpactClips(project, clips) {
  return TL.normalizeAudio([...(project.audio || []).filter((a) => !a.meta?.impact), ...clips], project.fps);
}
