// Live or replayed: what the try-it demo computes in the visitor's browser and what it plays back from a real run.
// Worked out from the data the demo ships, never per page: a scene's recorded renders (props.ss_renders), ④ Frame
// candidates, saved Advisor answer, saved Look compile and joined cut, the tour's clips (tour.json), the recorded
// Video → 3D run (r/canned/v2s_run.json). A new scene, clip or stop is labelled by the same rules. The shell (demo.mjs)
// draws the badges; tests/js/tryit_provenance.test.mjs checks that every replayed item is labelled Replayed and
// everything else Live. No DOM here.

export const LIVE = "live";
export const REPLAYED = "replayed";
export const LABEL = { [LIVE]: "Live", [REPLAYED]: "Replayed" };
export const GLYPH = { [LIVE]: "●", [REPLAYED]: "↺" };

export const LIVE_NOTE = "Live: computed in your browser. The real App code runs the 3D stage, the physics, stunts "
  + "and Drive mode. No image or video model runs in the demo.";

// The App steps that show renders. There the demo plays back what a GPU made earlier for the shot.
export const RENDER_STEPS = { frame: "④ Frame", motion: "⑤ Motion", review: "⑥ Review", deliver: "⑦ Deliver" };
// The files each step shows first (the rest of the shot's recorded files follow in the note).
const STEP_FILES = {
  motion: ["draft", "final", "final_sound", "final_audio"],
  review: ["final_sound", "final", "final_audio", "draft"],
  deliver: ["final_sound", "final_audio", "final", "draft", "look"],   // pipeline.mjs _refreshDeliver: the best video, the look as its poster
};
// The tabs that are not one of the seven steps (soundstage.js showView). The shell reads which one is up from the stage
// root (ss-advmode, .ss-lookview, ss-dailiesmode, ss-cutmode, ss-canvasmode), so the badge follows the screen, not the
// last step visited.
export const VIEWS = { advisor: "Shot ideas", look: "Look", dailies: "Takes", cut: "Edit (the Timeline)", canvas: "Paint Studio" };
// The kinds of recorded render a take or a Timeline clip is made of (soundstage.js BEST, plus the draft).
const TAKE_KINDS = ["final_sound", "final_audio", "final", "draft"];

// Tour stop actions (ACTIONS in demo.mjs) that land on a replay. Every other action opens the live stage or a live
// panel. tests/js/tryit_provenance.test.mjs fails when demo.mjs gains an action that is in neither list.
export const REPLAY_ACTIONS = {
  frame: "④ Frame plays back the frames a GPU made earlier for this shot.",
  motion: "⑤ Motion plays back the draft and final a GPU made earlier for this shot.",
  review: "⑥ Review shows takes a GPU made earlier, with the checks the server ran on them.",
  deliver: "⑦ Deliver plays this shot's final (or draft) as a GPU made it earlier; Cut → one video returns the cut joined earlier on the server.",
  dcc: "⑦ Deliver plays this shot's final as a GPU made it earlier; the DCC kit button itself builds its download in your browser.",
  timeline: "The clips on the Timeline are renders a GPU made earlier; trimming and ordering them is live.",
  takechecks: "The take-check chips are the server's real results for takes made earlier.",
  hollywood: "⑤ Motion plays back takes a GPU made earlier; the quality switch itself is live.",
  ripple: "⑤ Motion plays back takes a GPU made earlier; Ripple renders need the full install.",
  pose: "⑤ Motion plays back takes a GPU made earlier; Pose renders need the full install.",
  scriptsync: "ScriptSync plays the takes a GPU made earlier for this script.",
  takes: "The takes bin plays takes a GPU made earlier for this script.",
  v2s: "Rebuild plays back one recorded Video → 3D run of this clip made on the pod (most of that run's wall time was queue wait).",
  oneclick: "④ Frame plays back FLUX 3 Klein frames made earlier; running a ✦ card needs the full install.",
};
export const LIVE_ACTIONS = ["set", "color", "script", "rider", "seated", "physics", "stunt", "firstrun",
  "director", "presets", "viewfinder", "pitch", "book", "performance", "parts", "gaits", "drive", "boats", "swim"];

const fileOf = (f) => (f && typeof f === "object" ? f.filename : f) || "";
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const rendersOf = (scene) => scene?.renders || scene?.props?.ss_renders || {};

/** The recorded files one shot replays: its renders ({kind: fileRef}) and its ④ Frame candidates. `scene` is
 *  demo.scene ({renders, candidates, cut}) or a scene file ({props: {ss_renders}, candidates, cut}). */
export function shotReplays(scene, shotId) {
  const r = rendersOf(scene)[shotId] || {};
  return uniq([...Object.values(r).map(fileOf), ...((scene?.candidates || {})[shotId] || []).map(fileOf)]);
}

/** Every recorded file a scene file replays: [{shot, file}] (renders, candidates, and the joined cut as shot ""). */
export function sceneReplays(sceneFile) {
  const out = [];
  const shots = new Set([...Object.keys(rendersOf(sceneFile)), ...Object.keys(sceneFile?.candidates || {})]);
  for (const shot of shots) for (const file of shotReplays(sceneFile, shot)) out.push({ shot, file });
  if (sceneFile?.cut) out.push({ shot: "", file: sceneFile.cut });
  return out;
}

/** The recorded takes (drafts and finals) across every shot of a scene: what the Takes bin and the Timeline hold. */
export function sceneTakes(scene) {
  return uniq(Object.values(rendersOf(scene)).flatMap((r) => TAKE_KINDS.map((k) => fileOf(r?.[k]))));
}

const list = (files, n = 3) => files.slice(0, n).join(", ") + (files.length > n ? ` and ${files.length - n} more` : "");

/** The Video → 3D run's note: which clip, how long the pod run took (wall time, most of it queue), how long the replay takes. */
export function v2sNote(rec, replaySeconds = 9) {
  const min = rec?.total_s ? `${Math.round(rec.total_s / 60)} min wall time on the pod, most of it queue wait` : "a run on the pod";
  return `Replayed: one recorded Video → 3D run of ${rec?.clip || "the demo clip"} (${min}), played back in ${replaySeconds} s. `
    + "The rebuilt set and the Identical? scores are that run's real output. Your own clip needs the full install.";
}
/** After the recorded run has played back and its Identical? bar is closed: the set it built stays on the stage. */
export function v2sAfterNote(rec) {
  return `The set on the stage was rebuilt by the recorded Video → 3D run of ${rec?.clip || "the demo clip"} (that run's real `
    + "output, loaded through the App); everything you do with it now runs in your browser.";
}

/** A tab that is not one of the seven steps: Shot ideas, Look, Takes, the Timeline, Paint Studio. */
function viewProvenance(view, { step, shot, scene }) {
  const where = VIEWS[view];
  if (view === "advisor") {
    return scene?.advisor
      ? { mode: REPLAYED, note: `Replayed: ${where} shows the Advisor's answer computed earlier on the server for this scene; `
        + "it is the same answer whatever you type. The panel itself is live." }
      : { mode: LIVE, note: `${where}: this scene has no saved Advisor answer (the Advisor runs on the server in the full install). ${LIVE_NOTE}` };
  }
  if (view === "look") {
    return scene?.compile
      ? { mode: REPLAYED, note: "Replayed: the Look's compiled prompts were computed earlier on the server for this scene and do not "
        + "change when you edit the Look (⑤ Motion's prompt comes from the same saved compile). The controls themselves are live." }
      : { mode: LIVE, note: `${where}: this scene has no saved compile, so the prompt preview says it is unavailable. ${LIVE_NOTE}` };
  }
  if (view === "dailies") {
    const takes = sceneTakes(scene);
    return takes.length
      ? { mode: REPLAYED, note: `Replayed: the Takes bin (and ScriptSync) plays takes a GPU made earlier for this scene (${list(takes)}). `
        + "The bin itself is live." }
      : { mode: LIVE, note: `${where}: this scene has no recorded takes. ${LIVE_NOTE}` };
  }
  if (view === "cut") {
    const files = uniq([...sceneTakes(scene), scene?.cut]);
    return files.length
      ? { mode: REPLAYED, note: `Replayed: the clips on the Timeline are renders a GPU made earlier (${list(files)}). Trimming and `
        + "ordering them is live" + (scene?.cut ? `; Cut → one video returns the cut joined earlier on the server (${scene.cut}), not your trims.` : ".") }
      : { mode: LIVE, note: `${where}: this scene has no recorded clips; trimming and ordering run in your browser. ${LIVE_NOTE}` };
  }
  if (view === "canvas") {
    // Paint Studio opened from ④ Frame holds that frame; the step bar stays on ④ Frame while it is up.
    const r = rendersOf(scene)[shot] || {};
    const frames = step === "frame" ? uniq([fileOf(r.look), ...((scene?.candidates || {})[shot] || []).map(fileOf)]) : [];
    return frames.length
      ? { mode: REPLAYED, note: `Replayed: the picture in ${where} is a frame a GPU made earlier (${list(frames)}). The painting tools `
        + "are live; anything that calls an image model needs the full install." }
      : { mode: LIVE, note: `${where}: the painting tools run in your browser; anything that calls an image model needs the full install. ${LIVE_NOTE}` };
  }
  return null;
}

/** What the visitor is looking at right now.
 *  state: { step: the App step (P().current), view: the non-step tab that is up (a VIEWS key) or "", shot: the active
 *           shot id, scene: demo.scene, v2s: the recorded Video → 3D run (null when none ran; `after: true` once it has
 *           played back and its Identical? bar is closed) } */
export function provenanceNow({ step, view, shot, scene, v2s } = {}) {
  if (v2s && !v2s.after) return { mode: REPLAYED, note: v2sNote(v2s, v2s.replaySeconds) };
  const after = (p) => (v2s?.after && p.mode === LIVE ? { ...p, note: `${p.note} ${v2sAfterNote(v2s)}` } : p);
  const byView = VIEWS[view] ? viewProvenance(view, { step, shot, scene }) : null;
  if (byView) return after(byView);
  const where = RENDER_STEPS[step];
  if (where) {
    // The step's own files first (④ the frames, ⑤ the clips, ⑥ the finals, ⑦ the final, its poster and the cut), then the rest.
    const r = rendersOf(scene)[shot] || {};
    const own = step === "frame" ? [r.look, ...((scene?.candidates || {})[shot] || [])] : STEP_FILES[step].map((k) => r[k]);
    const all = shotReplays(scene, shot);
    const cut = step === "deliver" && scene?.cut ? scene.cut : "";
    const files = uniq([...(all.length ? [...own.map(fileOf), ...all] : []), cut]);
    if (files.length) {
      const lead = all.length ? `${where} shows renders a GPU made earlier for this shot (${list(files)}).`
        : `${where}: this shot has no recorded render.`;
      const cutNote = cut ? ` Cut → one video returns the cut joined earlier on the server (${cut}), not a new join.` : "";
      return { mode: REPLAYED, note: `Replayed: ${lead}${cutNote} Nothing is generated in your browser. The stage beside it is live.` };
    }
    return after({ mode: LIVE, note: `${where}: this shot has no recorded render, so Run has nothing to play back. ${LIVE_NOTE}` });
  }
  return after({ mode: LIVE, note: LIVE_NOTE });
}

/** A tour stop (tour.json): what its "Show me" opens. */
export function stopProvenance(stop) {
  const why = REPLAY_ACTIONS[stop?.do || "set"];
  return why ? { mode: REPLAYED, note: `Replayed: ${why}` } : { mode: LIVE, note: LIVE_NOTE };
}

/** A clip or still (a tour "Watch" clip, the first screen's wipe): always a file recorded earlier, so always replayed. */
export function clipProvenance(clip) {
  const note = clip?.note ? ` ${clip.note}` : "";
  return { mode: REPLAYED, note: `Replayed: recorded earlier (a GPU render or a screen capture of the App), shown as it was made: ${clip?.file || "a file"}.${note}` };
}

// ---------------------------------------------------------------- your edits, replayed renders
// ④ Frame and ⑤ Motion replay what a GPU made earlier for the scene as it shipped. When the visitor has changed the
// stage (moved a person, the camera, added something) and asks for a new frame or render, the replay is still the old
// one: say so next to it, and label every replayed frame, so the same four frames coming back never look like a bug.
export const INSTALL_URL = "https://github.com/theboord/ComfyUI-Soundstage#install";
export const RECORDED_LABEL = "Recorded example";
export const EDITED_NOTE = "This demo replays recorded renders, so your edits don't re-render here. "
  + "With the full install, ④ makes new frames from your edited set.";
export const RECORDED_NOTE = "Recorded example: a frame a GPU made earlier for this scene as it shipped, replayed here. "
  + "Nothing is generated in your browser.";

// What a render is made from: the cast and their moves, every setup's camera, the set and the light. Selection, the
// playhead and the view mode are not (they don't change a render). Numbers are rounded so float noise is not an edit.
const STAGE_KEYS = ["actors", "shots", "environment", "lighting", "sun", "camera"];
const TRANSIENT = new Set(["selected", "selection", "frame", "playhead", "view", "free_view", "freeView", "hover", "_ui"]);
function canon(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) if (!TRANSIENT.has(k) && v[k] !== undefined) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
/** A fingerprint of everything on the stage that a render is made from (stage.toJSON()). */
export function stageSig(state) {
  const s = state || {};
  return JSON.stringify(STAGE_KEYS.map((k) => canon(s[k] ?? null)));
}
/** Which scene the stage holds (a script's scenes tag their shots with scene_id); one baseline per scene. */
export const sceneKeyOf = (state) => [...new Set((state?.shots || []).map((x) => x?.scene_id || ""))].sort().join("|");
/** Remember the stage as it is now as the scene's untouched state (only the first time, unless `force`). */
export function rememberBaseline(base, state, force = false) {
  const k = sceneKeyOf(state);
  if (force || !(k in base)) base[k] = stageSig(state);
  return base;
}
/** Has the visitor changed this scene's stage since it loaded? (false before a baseline exists) */
export function editedSince(base, state) {
  const k = sceneKeyOf(state);
  return k in (base || {}) && base[k] !== stageSig(state);
}
/** The note for a replay the visitor asked for (ladder step 2 = ④ Frame, 3-4 = ⑤ Motion): null on an unedited stage. */
export function replayNotice({ step, edited } = {}) {
  if (!edited || !(step >= 2 && step <= 4)) return null;   // ⑦'s Layer Pack has its own full-install note
  const where = step >= 3 ? "⑤ Motion" : "④ Frame";
  return { mode: REPLAYED, where, note: EDITED_NOTE, link: INSTALL_URL, linkText: "How to install",
    label: `${GLYPH[REPLAYED]} ${RECORDED_LABEL}`, toast: `${where}: these are the recorded renders, not your edited set. ${EDITED_NOTE}` };
}
