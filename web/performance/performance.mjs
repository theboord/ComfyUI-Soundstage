// Use a real performance (docs/performance.md): record (webcam + mic, or a phone clip) or import a real actor, read their
// body, hands and face with DWPose and keep their voice (SoundstagePerformanceSave), preview the face / pose overlay,
// then Apply to shot: SoundstagePerformance renders the shot's frame with the actor's performance through the LTX
// union-control IC-LoRA, their voice in the sampler (0.3 audio noise mask, the lip-sync fix) and on the result.
// "Keep the real footage" hands the clip to ⑤ Motion's Ripple edit instead.
import { refOf, viewQuery, firstFrameRef, addTake, waitForOutput } from "../motion/ripple.mjs";
import { matchesActor } from "../cast/shotcast.mjs";
import { queueSummary } from "../ui/queue.mjs";

export const PRIVATE_INPUT = "soundstage_private/performances";
export const QUALITIES = ["Draft", "Final", "Hollywood"];
export const CONSENT_TEXT = "I am the performer in this clip, or the performer agreed that their performance (face, body and voice) may drive a character in this project.";

const safeName = (s) => (String(s || "take").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "take");

/** The node id of the voice change in the capture job (between the clip's sound ["1", 1] and Save's audio). */
export const VOICE_NODE = "10";

/** The capture job: Load Clip -> DWPose (body + hands + face) -> Save Performance (node "3" returns the asset JSON).
 *  voice = a saved Character Voice name: the clip's sound goes through Chatterbox VC (node VOICE_NODE) first, so the
 *  asset keeps the performer's timing, breaths and pauses in the character's voice. "" keeps the performer's voice. */
export function buildCaptureGraph({ source, name = "take", performer = "", consent = false, maxFrames = 241, character = "", voice = "", voiceSeed = 0, tail = "" }) {
  if (!source) throw new Error("bring in a clip first");
  if (!consent) throw new Error("tick the consent box first");
  if (!String(performer).trim()) throw new Error("say who the performer is");
  const g = buildCaptureNodes({ source, name, performer, maxFrames, character });
  // "hold": the server pads the clip up to 8k+1 frames (last frame held, silence) instead of dropping its tail.
  if (tail === "hold") g[1].inputs.tail = "hold";
  const v = String(voice || "").trim();
  if (v) {
    g[VOICE_NODE] = { class_type: "SoundstageChatterboxVC", inputs: { audio: g[3].inputs.audio, voice_name: v, seed: Math.max(0, Math.floor(+voiceSeed || 0)) } };
    g[3].inputs.audio = [VOICE_NODE, 0];
  }
  return g;
}

function buildCaptureNodes({ source, name, performer, maxFrames, character }) {
  return {
    1: { class_type: "SoundstageClipLoad", inputs: { source, fps: 24, start_frame: 0, max_frames: Math.max(9, Math.min(481, Math.floor(+maxFrames || 241))) } },
    2: { class_type: "DWPreprocessor", inputs: { image: ["1", 0], detect_hand: "enable", detect_body: "enable", detect_face: "enable",
      resolution: 768, bbox_detector: "yolox_l.onnx", pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt", scale_stick_for_xinsr_cn: "disable" } },
    3: { class_type: "SoundstagePerformanceSave", inputs: { frames: ["1", 0], pose: ["2", 0], keypoints: ["2", 1], audio: ["1", 1], fps: ["1", 2],
      name: safeName(name), performer: String(performer).trim(), consent: true, source, character: String(character || "") } },
  };
}

/** A saved voice's name for a character: "Mara Voss" -> "MARA_VOSS" (voices.safe_name, upper case). */
export const voiceNameFor = (name) => String(name || "").replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "_").slice(0, 48).toUpperCase();

/** The ② Cast entry for a stage actor (by name), or null. */
export function castEntryFor(items, actor) {
  return (items || []).find((it) => (it.kind || "character") === "character" && matchesActor({ ...it, kind: "character" }, actor)) || null;
}

/** The full names a script gives a character cue: "EZRA" + the action line "EZRA HALE (60s, ...)" -> ["EZRA HALE"].
 *  A Fountain character cue is usually the first name only, while the voice was saved under the full name. */
export function fullNamesIn(script, who) {
  const first = String(who || "").trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z'-]/g, "");
  if (!first || !script?.scenes) return [];
  const out = new Set(), re = new RegExp(`\\b${first}\\s+([A-Z][A-Z'-]{1,})\\b`, "g");
  for (const sc of script.scenes) for (const e of sc.elements || []) {
    if (e?.type !== "action" || typeof e.text !== "string") continue;
    for (const m of e.text.matchAll(re)) if (m[1] !== first) out.add(`${first} ${m[1]}`);
  }
  return [...out];
}

/** Saved-voice names to try for a character, best first: its aliases / full names, then its own name. */
export function voiceCandidates(who, aliases = []) {
  const out = [];
  for (const n of [...(aliases || []), who]) { const v = voiceNameFor(n); if (v && !out.includes(v)) out.push(v); }
  return out;
}

/** The saved voice that belongs to a character, or "": an exact name or alias ("EZRA HALE" -> EZRA_HALE), a voice
 *  saved for that character, or the one voice whose name / character starts with the character's first name
 *  ("Ezra" -> EZRA_HALE). Ambiguous first names ("EZRA_HALE" and "EZRA_YOUNG") match nothing. */
export function matchVoice(who, saved = [], aliases = []) {
  const list = Array.isArray(saved) ? saved.filter((v) => v?.name) : [];
  const cands = voiceCandidates(who, aliases);
  for (const c of cands) {
    const v = list.find((x) => x.name.toUpperCase() === c) || list.find((x) => voiceNameFor(x.character) === c);
    if (v) return v.name;
  }
  const first = voiceNameFor(String(who || "").trim().split(/\s+/)[0]);
  if (!first) return "";
  const hits = list.filter((x) => [x.name.toUpperCase(), voiceNameFor(x.character)].some((n) => n === first || n.startsWith(first + "_")));
  return hits.length === 1 ? hits[0].name : "";
}

/**
 * The Voice choice: keep the performer's voice, or convert it to the character's voice (the cast entry's `voice`, else
 * the saved voice that matches the character by name or alias), then any other saved voice.
 * -> {options: [{value, label}], value}.
 * saved = GET /soundstage/voices, or null when the server can't list them yet (a route added since the last restart):
 * then the best candidate name is offered, full name first ("Ezra" in a script that says "EZRA HALE" -> EZRA_HALE),
 * which the server also resolves by name (soundstage/audio/voices.resolve_name).
 * A cast voice the server doesn't have ("EZRA") is replaced by the voice that matches, when one does.
 * value is the character's voice once chosen on the cast entry, else "" (keep mine).
 */
export function voiceChoices({ who = "", castVoice = "", saved = [], aliases = [] } = {}) {
  const known = Array.isArray(saved);
  const list = known ? saved : [];
  const names = list.map((v) => v.name);
  const match = known ? matchVoice(who, list, aliases) : (voiceCandidates(who, aliases)[0] || "");
  const stale = known && castVoice && !names.includes(castVoice) && match;
  const mine = (stale ? match : castVoice) || match;
  const options = [{ value: "", label: "Keep my voice" }];
  if (mine) options.push({ value: mine, label: `Convert to ${who || mine} (${mine})${known && !names.includes(mine) ? " · not saved yet" : ""}` });
  for (const v of list) if (v.name !== mine) options.push({ value: v.name, label: `Convert to ${v.character && voiceNameFor(v.character) !== v.name ? `${v.character} (${v.name})` : v.name}` });
  return { options, value: castVoice ? mine : "" };
}

let tailSupport = null;
/** Does this server's Load Clip take tail = "hold" (added 2026-11-02; needs the server restarted)? Asked once. */
export async function clipTailSupported(api) {
  if (tailSupport) return tailSupport;
  tailSupport = (async () => {
    try {
      const r = await api.fetchApi("/object_info/SoundstageClipLoad");
      if (!r.ok) return false;
      const j = await r.json();
      const i = j?.SoundstageClipLoad?.input || {};
      return !!(i.optional?.tail || i.required?.tail);
    } catch { return false; }
  })();
  return tailSupport;
}

/** GET /soundstage/voices -> [{name, character, duration_s, owner}], or null when the server has no such route. */
export async function savedVoices(api) {
  try {
    const r = await api.fetchApi("/soundstage/voices");
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.voices) ? j.voices : null;
  } catch { return null; }
}

/** The render job: SoundstagePerformance -> SaveVideo (node "2"). */
export function buildPerformancePrompt({ asset, firstFrame, prompt = "", quality = "Draft", width, height, seed = 7, targetBox = null,
  audioMask = 0.3, keepVoice = true, prefix = "soundstage_private/performance" }) {
  if (!asset) throw new Error("capture a performance first");
  if (!firstFrame) throw new Error("pick or paint this shot's frame in ④ Frame first");
  return {
    1: { class_type: "SoundstagePerformance", inputs: { asset, first_frame: firstFrame, prompt: String(prompt || ""),
      quality: QUALITIES.includes(quality) ? quality : "Draft", width: Math.round(width), height: Math.round(height),
      seed: Math.max(0, Math.floor(+seed || 0)), target_box: targetBox ? JSON.stringify(targetBox.map((v) => +(+v).toFixed(4))) : "",
      audio_mask: +(+audioMask).toFixed(2), keep_voice: !!keepVoice } },
    2: { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: prefix, format: "mp4", "format.codec": "h264" } },
  };
}

/** A pixel person {body, hands, face} (web/stage/posepass toPixels) -> its 0-1 box in a W x H frame, or null. */
export function boxOfPerson(person, W, H) {
  const pts = [...(person?.body || []), ...(person?.face || []), ...((person?.hands || []).flat())].filter(Boolean);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const c = (v, d) => Math.max(0, Math.min(1, v / d));
  const b = [c(Math.min(...xs), W), c(Math.min(...ys), H), c(Math.max(...xs), W), c(Math.max(...ys), H)];
  return b[2] > b[0] && b[3] > b[1] ? b.map((v) => +v.toFixed(4)) : null;
}

/** Where the character stands in the shot camera right now (0-1 box), from the same keypoints the pose pass draws. */
export async function characterBox(stage, id) {
  const P = await import("../stage/posepass.mjs");
  const g = stage.actorMeshes?.get?.(id);
  if (!g?.userData?.joints?.l_shoulder) return null;
  const W = 640, H = Math.round(640 * stage.fh / stage.fw);
  stage._syncShotCamera?.();   // the active shot's camera, never the last setup a thumbnail rendered
  const cam = stage.camera.clone();
  cam.aspect = stage.fw / stage.fh; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  const kp = P.personKeypoints(g, cam.position);
  return kp ? boxOfPerson(P.toPixels(kp, cam, W, H), W, H) : null;
}

// A phone take is framed chest-up (a hand above the head to the belt), so its box runs out of the bottom of the frame
// and has no hips or legs. Fitting that box to a whole character (a rider: hat to stirrups) made the actor's head
// twice too big. A chest-up take, or a seated character (on a horse, in a car), is fitted face to face instead: the
// upper body comes from the take, the hips, legs and horse from the shot's frame.
export const CUT_OFF = 0.97;

/** Median 0-1 box of the actor's face over a capture's face.json frames ({face: [[x, y, c] x 70]}), or null. */
export function faceBoxOfFrames(frames, minConf = 0.3) {
  const boxes = [];
  for (const f of frames || []) {
    const pts = (f?.face || []).slice(0, 68).filter((p) => p && p[2] >= minConf && (p[0] > 0 || p[1] > 0));
    if (pts.length < 20) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  if (!boxes.length) return null;
  const mid = (i) => { const v = boxes.map((b) => b[i]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  return [0, 1, 2, 3].map((i) => +mid(i).toFixed(4));
}

/** A pixel person's face (68 points) -> its 0-1 box, unclamped (a face near the frame edge keeps its size), or null. */
export function faceBoxOfPerson(person, W, H) {
  const pts = (person?.face || []).filter(Boolean);
  if (pts.length < 20) return null;
  const xs = pts.map((p) => p[0] / W), ys = pts.map((p) => p[1] / H);
  const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return b[2] > b[0] && b[3] > b[1] ? b.map((v) => +v.toFixed(4)) : null;
}

/** The box to hand SoundstagePerformance (it fits the asset's box onto it: same height, centre x and top).
 *  Face to face for a chest-up take or a seated character: the actor's box carried by the transform that puts the
 *  actor's face on the character's face. Otherwise the character's whole box, as before. -> {box, fit} */
export function fitTarget({ actorBox, actorFace, charBox, charFace, seated = false }) {
  const ok = (b) => Array.isArray(b) && b.length === 4 && b[2] > b[0] && b[3] > b[1];
  if (ok(actorBox) && ok(actorFace) && ok(charFace) && (actorBox[3] >= CUT_OFF || seated)) {
    const s = (charFace[3] - charFace[1]) / (actorFace[3] - actorFace[1]);
    const dx = (charFace[0] + charFace[2]) / 2 - (actorFace[0] + actorFace[2]) / 2 * s;
    const dy = charFace[1] - actorFace[1] * s;
    return { box: [actorBox[0] * s + dx, actorBox[1] * s + dy, actorBox[2] * s + dx, actorBox[3] * s + dy].map((v) => +v.toFixed(4)), fit: "face" };
  }
  return { box: ok(charBox) ? charBox : null, fit: ok(charBox) ? "body" : "" };
}

/** The active shot's own camera at frame 0 (where the take starts), not whatever the viewport shows: from ④ Frame or
 *  a free view, stage.camera can be somewhere else entirely, and the fit then lands the actor in the wrong place. */
export async function shotCamera(stage) {
  const cam = stage.camera.clone();
  cam.aspect = stage.fw / stage.fh;
  const c = stage._shotCameraAt?.(0);
  if (c?.position && c?.target) {
    const { vfovFromFocal } = await import("../stage/interop/units.mjs");
    cam.position.set(...c.position);
    if (c.focal_mm) cam.fov = vfovFromFocal(c.focal_mm, cam.aspect);
    cam.up.set(0, 1, 0);
    cam.lookAt(...c.target);
    if (c.roll) cam.rotateZ(c.roll);
  }
  cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  return cam;
}

/** Where the character is in the shot camera: {box (clamped), face (unclamped), seated}, or null. */
export async function characterTarget(stage, id) {
  const P = await import("../stage/posepass.mjs");
  const g = stage.actorMeshes?.get?.(id);
  if (!g?.userData?.joints?.l_shoulder) return null;
  const W = 640, H = Math.round(640 * stage.fh / stage.fw);
  const cam = await shotCamera(stage);
  const kp = P.personKeypoints(g, cam.position);
  if (!kp) return null;
  const px = P.toPixels(kp, cam, W, H);
  const a = (stage.state?.actors || []).find((x) => x.id === id);
  return { box: boxOfPerson(px, W, H), face: faceBoxOfPerson(px, W, H), seated: !!(a?.mount_id || a?.seat) };
}

/** A finished render -> a take record on the shot (the Takes bin lists it with Ripple / Pose takes). */
export function makePerformanceTake({ file, url, quality = "Draft", asset = "", name = "", prompt = "", now = Date.now() }) {
  return { id: `performance_${now.toString(36)}`, kind: quality === "Draft" ? "draft" : "final", url, file, created: now,
    label: name ? `Performance · ${name}` : "Performance", performance: true, quality, asset, prompt };
}

/** The clip as an imported Ripple source on the shot's chosen record (⑤ Motion → Ripple edit keeps the real footage). */
export function rippleHandOff(chosen, { ref, url = "", name = "" }) {
  const c = chosen || {};
  c.ripple = { ...(c.ripple || {}), clip: { ref, url, name }, source: ref };
  return c;
}

/** One-line summary of a capture: length, face coverage, syllables. */
export function captureSummary(a) {
  if (!a) return "";
  const face = Math.round((a.face_seen || 0) * 100);
  const parts = [`${(+a.seconds || 0).toFixed(1)} s`, `face read on ${face}% of frames`];
  if (a.has_audio) parts.push(`${a.voice ? `voice converted to ${a.voice}` : "voice kept"} · ${(a.onsets || []).length} mouth openings`);
  else parts.push("no sound in this clip");
  return parts.join(" · ");
}

/** SVG path of the mouth-open curve in a w x h box (gaps where the face wasn't read). */
export function mouthPath(curve, w = 300, h = 40) {
  const vals = (curve || []).filter((v) => v != null);
  if (!vals.length) return "";
  const max = Math.max(0.05, ...vals);
  let d = "", pen = false;
  (curve || []).forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const x = (i / Math.max(1, curve.length - 1)) * w, y = h - (v / max) * (h - 2) - 1;
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/** Consent is per performer: the warning when the asset says someone else performed. */
export function consentLine(asset) {
  const c = asset?.consent;
  return c?.performer ? `Performer: ${c.performer} · consent ${c.date || "recorded"}` : "No consent record";
}

/** How long the clip runs vs how much of it the read kept: LTX needs 8k+1 frames, so an older server drops up to
 *  7 frames (0.29 s) off the end, and a server with ClipLoad's tail = "hold" holds the last frame instead.
 *  -> {dropped_s, held_s, text} (text "" when nothing worth saying). */
export function tailNote(clipSeconds, a) {
  const clip = +clipSeconds || 0, read = +(a?.seconds) || 0, held = +(a?.tail_held_s) || 0;
  if (!clip || !read) return { dropped_s: 0, held_s: held, text: "" };
  const dropped = Math.max(0, +(clip - read).toFixed(2));
  if (held > 0.04) return { dropped_s: 0, held_s: held, text: `The last frame is held ${held.toFixed(2)} s so the clip fills LTX's length: no word is lost.` };
  if (dropped >= 0.05) return { dropped_s: dropped, held_s: 0, text: `The read keeps ${read.toFixed(2)} s of this ${clip.toFixed(2)} s clip: the last ${dropped.toFixed(2)} s are dropped (LTX needs 8k+1 frames). If a word ends there, re-cut the clip with ½ s after the last word.` };
  return { dropped_s: dropped, held_s: 0, text: "" };
}

/** The 8k+1 frame count LTX keeps for a clip of n frames: "trim" (largest <= n) or "hold" (smallest >= n). */
export const ltxFrames = (n, tail = "trim") => {
  n = Math.max(1, Math.floor(+n || 0));
  if (n < 9) return tail === "hold" ? 9 : n;
  return tail === "hold" ? Math.ceil((n - 1) / 8) * 8 + 1 : Math.floor((n - 1) / 8) * 8 + 1;
};

/**
 * Follow one prompt on a shared GPU without polling the full /queue: the websocket says when it starts
 * (execution_start / executing carry its prompt_id) and the light queue summary (when the server has it) says how
 * many jobs are ahead. Start it BEFORE queueing (an early execution_start is kept), then .track(pid).
 * -> {track(pid), state() -> "queued" | "running", ahead() -> number | null, text(doing, s), stop()}
 */
export function followPrompt(api, { summary = queueSummary, every = 10000 } = {}) {
  const started = new Set();
  let pid = null, ahead = null, timer = null, ranFrom = null;
  const on = (e) => {
    const d = e?.detail;
    const id = d?.prompt_id ?? (typeof d === "object" && d ? d.prompt_id : null);
    if (id) started.add(id);
  };
  const evs = ["execution_start", "executing", "progress", "executed", "execution_cached"];
  for (const ev of evs) try { api.addEventListener?.(ev, on); } catch { /* no events (tests) */ }
  const poll = async () => {
    if (!pid || started.has(pid)) return;
    const q = await summary(api, { ids: [pid] });
    const it = q?.items?.find((x) => x.prompt_id === pid);
    if (it?.state === "running") started.add(pid);
    else if (it && Number.isFinite(it.position)) ahead = it.position;
    else if (q && !it) ahead = null;
  };
  return {
    track(id) { pid = id; clearInterval(timer); poll(); timer = setInterval(poll, Math.min(every, 2 ** 31 - 1)); return this; },
    state: () => (pid && started.has(pid) ? "running" : "queued"),
    ahead: () => ahead,
    started: (id) => started.has(id),
    text(doing, s) {
      // Once it runs, count from the start (a 40-minute wait in the queue is not 40 minutes of reading).
      if (pid && started.has(pid)) { if (ranFrom == null) ranFrom = s; return `${doing} ${s - ranFrom} s`; }
      const n = ahead;
      return `Waiting in the queue${n != null ? ` (${n} job${n === 1 ? "" : "s"} ahead)` : ""}: the GPU is shared, your job starts when the card is free. ${s} s`;
    },
    stop() { clearInterval(timer); for (const ev of evs) try { api.removeEventListener?.(ev, on); } catch { /* */ } },
  };
}

// ------------------------------------------------------------------ the dialog (browser only)

const CSS = `
.ss-perf [hidden] { display:none !important; }
.ss-perf { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:rgba(8,8,10,.78);
  backdrop-filter:blur(6px); font:13px/1.45 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; color:#f4f4f5; }
.ss-perf .card { width:min(820px, 94vw); max-height:94vh; overflow:auto; background:#18181b; border:1px solid rgba(255,255,255,.1);
  border-radius:18px; padding:18px; display:flex; flex-direction:column; gap:12px; box-shadow:0 30px 80px rgba(0,0,0,.5); }
.ss-perf h3 { margin:0; font-size:18px; font-weight:650; }
.ss-perf .sub, .ss-perf .tip { opacity:.72; }
.ss-perf .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ss-perf .grow { flex:1; }
.ss-perf .view { position:relative; border-radius:12px; overflow:hidden; background:#000; aspect-ratio:16/9; }
.ss-perf video { width:100%; height:100%; object-fit:contain; display:block; }
.ss-perf .mirror { transform:scaleX(-1); }
.ss-perf .count { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:110px; font-weight:700;
  color:#f2ff59; text-shadow:0 4px 30px rgba(0,0,0,.6); pointer-events:none; }
.ss-perf .rec { position:absolute; top:12px; left:12px; padding:4px 10px; border-radius:999px; background:rgba(0,0,0,.6); }
.ss-perf .rec::before { content:""; display:inline-block; width:9px; height:9px; border-radius:50%; background:#ff453a; margin-right:6px; }
.ss-perf button { font:inherit; border-radius:999px; padding:8px 16px; cursor:pointer; border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06); color:inherit; }
.ss-perf button.primary { background:#f2ff59; color:#111; border-color:#f2ff59; font-weight:650; }
.ss-perf button:disabled { opacity:.45; cursor:default; }
.ss-perf select { font:inherit; background:#27272a; color:inherit; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:6px 8px; max-width:100%; }
.ss-perf input[type=text] { font:inherit; background:#27272a; color:inherit; border:1px solid rgba(255,255,255,.14); border-radius:8px; padding:6px 8px; }
.ss-perf .consent { display:flex; gap:8px; align-items:flex-start; padding:8px 10px; border-radius:10px; background:rgba(242,255,89,.05);
  border:1px solid rgba(242,255,89,.18); }
.ss-perf .status { min-height:1.4em; }
.ss-perf svg.mouth { width:100%; height:44px; background:rgba(255,255,255,.04); border-radius:8px; }
.ss-perf svg.mouth path { fill:none; stroke:#f2ff59; stroke-width:1.5; }`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k in e && typeof v !== "string") e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

async function upload(api, blob, fileName) {
  const body = new FormData();
  body.append("image", blob, fileName);
  body.append("type", "input");
  body.append("subfolder", PRIVATE_INPUT);
  body.append("overwrite", "true");
  const r = await api.fetchApi("/upload/image", { method: "POST", body });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  const j = await r.json();
  return `${j.subfolder ? j.subfolder + "/" : ""}${j.name} [input]`;
}

async function queue(api, prompt) {
  const res = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: api.clientId }) });
  const q = await res.json();
  if (!res.ok || q.error) {
    const ne = Object.values(q.node_errors || {})[0];
    throw new Error(ne ? `${ne.class_type}: ${ne.errors?.[0]?.message || ""} ${ne.errors?.[0]?.details || ""}` : q.error?.message || `HTTP ${res.status}`);
  }
  return q.prompt_id;
}

async function waitText(api, pid, outId, onTick) {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    onTick?.(Math.round((Date.now() - t0) / 1000));
    let e;
    try { e = (await (await api.fetchApi(`/history/${pid}`)).json())[pid]; } catch { continue; }
    if (!e) continue;
    if (e.status?.status_str === "error") {
      const m = (e.status.messages || []).find((x) => x[0] === "execution_error")?.[1];
      throw new Error(m ? `${m.node_type}: ${m.exception_message}`.slice(0, 300) : "the capture failed");
    }
    const t = e.outputs?.[outId]?.text?.[0];
    if (t) return JSON.parse(t);
    if (e.status?.completed) throw new Error("the capture finished without an asset");
    if (Date.now() - t0 > 1800000) throw new Error("timed out");
  }
}

/** The "Use a real performance…" dialog for one character. Resolves when closed. */
export function openPerformance({ api, stage, actorId, pipeline = () => null, cast = () => null, onStatus = () => {} }) {
  if (!document.getElementById("ss-perf-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-perf-css", textContent: CSS }));
  const actor = stage.state.actors.find((a) => a.id === actorId);
  const who = actor?.name || "this character";
  // The dialog belongs to the shot it was opened on: Apply and Render go to that shot even if the strip changes.
  const pinned = stage.activeShot?.() || null;
  const pinnedId = pinned?.id || null;
  let clipRef = "", clipUrl = "", clipName = "", asset = actor?.performance?.data || null, stream = null;
  const url = (ref) => { const q = viewQuery(ref); return api.apiURL ? api.apiURL(`/view?${q}`) : `/view?${q}`; };

  const status = el("div", { class: "status" });
  const video = el("video", { playsinline: true, controls: true, loop: true });
  const count = el("div", { class: "count", hidden: true });
  const recTag = el("div", { class: "rec", hidden: true }, "0.0 s");
  const view = el("div", { class: "view", hidden: true }, video, count, recTag);
  const file = el("input", { type: "file", accept: "video/*,.mp4,.mov,.webm,.mkv", hidden: true });
  const performer = el("input", { type: "text", placeholder: "Performer: your name, or the actor who agreed", value: asset?.consent?.performer || "" });
  const consent = el("input", { type: "checkbox" });
  const clay = el("input", { type: "checkbox" });
  // Voice: keep the performer's own voice, or convert it to the character's voice (stored on the ② Cast entry).
  const castPanel = () => { try { return cast() || null; } catch { return null; } };
  const castItem = () => { const c = castPanel(); try { return c ? castEntryFor(c.items(), actor) : null; } catch { return null; } };
  const voiceSel = el("select", { "aria-label": "Voice", title: "Your timing, breaths and pauses are kept; only the voice changes (Chatterbox VC on the GPU)" });
  const fillVoices = (saved) => {
    const it = castItem(), c = castPanel();
    let script = null;
    try { script = c?.o?.getScript?.() || null; } catch { script = null; }
    const aliases = [...(it?.aliases || []), it?.full_name, actor?.full_name, ...fullNamesIn(script, who)].filter(Boolean);
    const cur = voiceSel.value, { options, value } = voiceChoices({ who, castVoice: it?.voice || "", saved, aliases });
    voiceSel.replaceChildren(...options.map((o) => el("option", { value: o.value }, o.label)));
    voiceSel.value = [cur, value].find((v) => v && options.some((o) => o.value === v)) || "";
  };
  fillVoices(null);   // unknown until the server answers: never flag a voice "not saved yet" on a guess
  savedVoices(api).then(fillVoices);
  voiceSel.onchange = () => {
    const it = castItem(), c = castPanel();
    if (voiceSel.value && it && c?.setVoice) c.setVoice(it.key, voiceSel.value);   // the character's voice from now on
    if (asset && voiceSel.value !== (asset.voice || "")) say("Voice changed: Read the performance again to hear it.");
  };
  const mouth = el("div", { hidden: true });
  const summary = el("div", { class: "sub" });
  const recBtn = el("button", { type: "button" }, "● Record (camera + mic)");
  const impBtn = el("button", { type: "button" }, "Import a clip…");
  const capBtn = el("button", { type: "button", class: "primary", disabled: true }, "Read the performance");
  const applyBtn = el("button", { type: "button", class: "primary", disabled: !asset }, "Apply to shot");
  const rippleBtn = el("button", { type: "button", disabled: !asset && !clipRef, title: "Keep the real footage: ⑤ Motion → Ripple edit carries a frame-1 change through this clip, with its own motion, face and voice" }, "Keep the real footage (Ripple)");
  const renderRow = el("div", { class: "row", hidden: true }, el("span", { class: "sub" }, "Render the shot with this performance:"),
    ...QUALITIES.map((q) => el("button", { type: "button", "data-q": q, on: { click: () => render(q) } }, q)));
  const closeBtn = el("button", { type: "button" }, "Close");
  const card = el("div", { class: "card", role: "dialog", "aria-label": "Use a real performance" },
    el("h3", {}, `Use a real performance → ${who}${pinned?.name ? ` · shot ${pinned.name}` : ""}`),
    el("div", { class: "sub" }, `Record or import a real actor with their voice. Their body, face and voice drive ${who}: the timing, expressions and lip sync are kept.`),
    el("div", { class: "row" }, recBtn, impBtn, file, el("span", { class: "tip" }, "On a phone: film chest-up for dialogue (head to toe for action), then Import.")),
    view,
    el("label", { class: "consent" }, consent, el("span", {}, CONSENT_TEXT)),
    el("div", { class: "row" }, performer, el("label", { class: "row tip", title: "Also run SAM 3D Body so the clay figure moves like the actor (best with a head-to-toe clip)" }, clay, "Also drive the clay body (SAM 3D Body)")),
    el("div", { class: "row" }, el("span", { class: "sub" }, "Voice"), voiceSel, el("span", { class: "tip" }, "Your timing is kept: the converted voice lines up with your mouth.")),
    el("div", { class: "row" }, capBtn, el("span", { class: "grow" }), rippleBtn, applyBtn),
    mouth, summary, renderRow, status,
    el("div", { class: "row" }, el("span", { class: "grow" }), closeBtn));
  const wrap = el("div", { class: "ss-perf" }, card);
  document.body.append(wrap);
  wrap.addEventListener("pointerdown", (e) => e.stopPropagation());
  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });
  let resolveClose;
  const closed = new Promise((r) => { resolveClose = r; });
  const close = () => { stream?.getTracks().forEach((t) => t.stop()); wrap.remove(); resolveClose(); };
  closeBtn.onclick = close;
  const say = (t) => { status.textContent = t; };
  const ready = () => { capBtn.disabled = !(clipRef && consent.checked && performer.value.trim()); rippleBtn.disabled = !clipRef && !asset; };
  consent.onchange = ready; performer.oninput = ready;

  const showAsset = (a) => {
    asset = a;
    view.hidden = false;
    video.classList.remove("mirror"); video.srcObject = null; video.muted = false;
    video.src = url(a.files.overlay); video.play().catch(() => {});
    const d = mouthPath(a.mouth, 300, 40);
    mouth.hidden = !d;
    mouth.innerHTML = d ? `<svg class="mouth" viewBox="0 0 300 40" preserveAspectRatio="none" aria-label="Mouth open over time"><path d="${d}"/></svg>` : "";
    summary.textContent = `${captureSummary(a)} · ${consentLine(a)}`;
    applyBtn.disabled = false; ready();
  };
  if (asset) showAsset(asset);

  let clipSeconds = 0;
  const bring = async (blob, name) => {
    say("Uploading the clip…");
    clipSeconds = 0;
    try {
      clipName = safeName(name || blob.name || "take");
      clipRef = await upload(api, blob, `perf_${clipName}_${Date.now().toString(36)}${(blob.name?.match(/\.[A-Za-z0-9]+$/)?.[0] || ".webm").toLowerCase()}`);
      clipUrl = url(clipRef);
      view.hidden = false; video.srcObject = null; video.classList.remove("mirror"); video.src = clipUrl; video.muted = false;
      video.addEventListener("loadedmetadata", () => { if (Number.isFinite(video.duration)) clipSeconds = video.duration; }, { once: true });
      say("Clip ready. Tick consent, name the performer, then Read the performance.");
      ready();
      if (clay.checked) {
        const { captureTake } = await import("../stage/mocapcapture.mjs");
        captureTake(api, blob, { name: clipName }).then((take) => { say(`${stage.setMocap(actorId, take, { start: 0 })} Clay body captured too.`); })
          .catch((e) => say(`Clay body capture failed (${e.message}); the face + voice performance is unaffected.`));
      }
    } catch (e) { say(`Couldn't bring in the clip: ${e.message}`); }
  };
  impBtn.onclick = () => file.click();
  file.onchange = () => { const f = file.files?.[0]; file.value = ""; if (f) bring(f, f.name); };

  recBtn.onclick = async () => {
    try {
      stream = stream || await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { say(`The camera or microphone is not available here (${e.message}). Film it on your phone and Import instead.`); return; }
    view.hidden = false; video.src = ""; video.srcObject = stream; video.muted = true; video.classList.add("mirror"); video.play().catch(() => {});
    recBtn.disabled = impBtn.disabled = true;
    count.hidden = false;
    for (const n of ["3", "2", "1", "Action!"]) { count.textContent = n; await new Promise((r) => setTimeout(r, 750)); }
    count.hidden = true;
    const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
    const chunks = [];
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8e6 } : undefined);
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const t0 = performance.now();
    recTag.hidden = false;
    const cut = el("button", { type: "button", class: "primary" }, "Cut");
    recBtn.after(cut);
    const timer = setInterval(() => { const t = (performance.now() - t0) / 1000; recTag.textContent = `${t.toFixed(1)} s / 10 s`; if (t >= 10) rec.stop(); }, 100);
    cut.onclick = () => rec.state === "recording" && rec.stop();
    rec.onstop = () => {
      clearInterval(timer); cut.remove(); recTag.hidden = true; recBtn.disabled = impBtn.disabled = false;
      const mp4 = (rec.mimeType || "").includes("mp4");
      bring(new File(chunks, `take_${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${mp4 ? ".mp4" : ".webm"}`, { type: rec.mimeType || "video/webm" }));
    };
    rec.start(250);
  };

  capBtn.onclick = async () => {
    capBtn.disabled = true;
    try {
      const voice = voiceSel.value;
      const tail = (await clipTailSupported(api)) ? "hold" : "";
      const doing = `Reading body, hands and face on the GPU (DWPose)${voice ? ` and converting the voice to ${voice}` : ""}…`;
      const follow = followPrompt(api);
      let a;
      try {
        const pid = await queue(api, buildCaptureGraph({ source: clipRef, name: clipName || who, performer: performer.value, consent: consent.checked, character: who,
          voice, voiceSeed: 0, tail }));
        follow.track(pid);
        say(follow.text(doing, 0));
        a = await waitText(api, pid, "3", (s) => say(follow.text(doing, s)));
      } finally { follow.stop(); }
      if (voice) a.voice = voice;
      if (tail === "hold" && clipSeconds && +a.seconds > clipSeconds) a.tail_held_s = +(+a.seconds - clipSeconds).toFixed(2);
      showAsset(a);
      const t = tailNote(clipSeconds, a).text;
      say(`Here is what was read: the skeleton and face landmarks over the actor, with their voice. Apply to shot when it looks right.${t ? ` ${t}` : ""}`);
    } catch (e) { say(`Performance capture failed: ${e.message}`); } finally { ready(); }
  };

  // The pinned shot; if the strip moved on, go back to it first (the fit and the motion prompt read the active shot).
  const shot = () => {
    if (!pinnedId) return stage.activeShot?.() || null;
    if (stage.activeShot?.()?.id !== pinnedId && stage.setActiveShot) {
      stage.setActiveShot(pinnedId);
      onStatus(`Back on shot ${pinned?.name || pinnedId}: this Real performance dialog was opened on it.`);
    }
    return (stage.state?.shots || []).find((x) => x.id === pinnedId) || stage.activeShot?.() || null;
  };
  applyBtn.onclick = async () => {
    if (!asset) return;
    const a = stage.state.actors.find((x) => x.id === actorId);
    if (a) a.performance = { asset: asset.file, name: asset.name, data: asset };
    const sid = shot()?.id;   // back on the pinned shot before the fit reads its camera
    let box = null, fit = "";
    try {
      const t = await characterTarget(stage, actorId);
      let actorFace = asset.face_box || null;
      if (!actorFace && asset.files?.keypoints) {
        try { actorFace = faceBoxOfFrames((await (await api.fetchApi(`/view?${viewQuery(asset.files.keypoints)}`)).json()).frames); } catch { actorFace = null; }
        if (actorFace) asset.face_box = actorFace;
      }
      ({ box, fit } = fitTarget({ actorBox: asset.box, actorFace, charBox: t?.box, charFace: t?.face, seated: t?.seated }));
    } catch { box = null; }
    const p = pipeline();
    if (p && sid) {
      const c = p.chosen[sid] = p.chosen[sid] || {};
      c.performance = { asset: asset.file, actor: actorId, name: asset.name, box, fit };
      p._saveChosen?.();
    }
    try { stage.onChange?.(stage.toJSON()); } catch { /* stage listener */ }
    renderRow.hidden = false;
    const how = fit === "face" ? " (fitted face to face: your upper body on the character, the rest from the frame)" : box ? "" : " (character not in view: the actor's own framing is used)";
    say(`${who} now performs ${asset.name}${how}. Render a Draft first.`);
    onStatus(`${who} has a real performance (${asset.name}).`);
  };

  rippleBtn.onclick = () => {
    const p = pipeline(), sid = shot()?.id;
    const ref = clipRef || asset?.source;
    if (!p || !sid || !ref) { say("Open a shot first."); return; }
    rippleHandOff(p.chosen[sid] = p.chosen[sid] || {}, { ref, url: clipUrl || url(ref), name: clipName || asset?.name || "performance" });
    p._saveChosen?.();
    close();
    try { p.go?.("motion"); p.ripple?.setMode("ripple"); p.ripple?.refresh(); } catch { /* pipeline not built */ }
    onStatus("The real clip is in ⑤ Motion → Ripple edit: change frame 1 and Ripple keeps the actor's motion, face and voice.");
  };

  async function render(quality) {
    const p = pipeline(), sid = shot()?.id;
    if (!p || !sid || !asset) { say("Apply to a shot first."); return; }
    const first = firstFrameRef(p.chosen[sid], p.ctx?.getRenders?.(sid) || {});
    let prompt = "";
    try { prompt = (await p._motionPrompt?.()) || ""; } catch { prompt = ""; }
    let req;
    try {
      req = buildPerformancePrompt({ asset: asset.file, firstFrame: first, prompt, quality, width: stage.fw, height: stage.fh,
        seed: Math.floor(Math.random() * 2 ** 31), targetBox: p.chosen[sid]?.performance?.box || null });
    } catch (e) { say(e.message); return; }
    for (const b of renderRow.querySelectorAll("button")) b.disabled = true;
    try {
      const follow = followPrompt(api);
      const doing = `Rendering shot ${pinned?.name || sid} with the performance (${quality})…`;
      let f, tick;
      try {
        const pid = await queue(api, req);
        follow.track(pid);
        p.inflight?.set(pid, { sid, step: "performance" });
        say(follow.text(doing, 0));
        const t0 = Date.now();
        tick = setInterval(() => say(follow.text(doing, Math.round((Date.now() - t0) / 1000))), 1000);
        f = await waitForOutput(api, pid, "2");
      } finally { clearInterval(tick); follow.stop(); }
      const take = makePerformanceTake({ file: f, url: url(refOf(f)) + `&t=${Date.now()}`, quality, asset: asset.file, name: asset.name, prompt });
      addTake(p.chosen[sid] = p.chosen[sid] || {}, take);
      p._saveChosen?.();
      p.onRippleTake?.(sid, take);
      video.src = take.url; video.play().catch(() => {});
      say(`Performance ${quality.toLowerCase()} landed as a take: the actor's timing, face and voice on ${who}. It's in Takes.`);
    } catch (e) { say(`Performance render failed: ${e.message}`); } finally { for (const b of renderRow.querySelectorAll("button")) b.disabled = false; }
  }
  return closed;
}

/** Hook: a "Real performance…" button beside Motion capture's Act it out, on the selected person's panel. */
export function mountPerformance(posePanel, { api, stage, pipeline = () => null, cast = () => null, onStatus = () => {} } = {}) {
  if (!posePanel?.mcAct || posePanel.perfBtn) return null;
  const btn = posePanel._tool("scan-eye", "Real performance…", "Use a real performance: record or import an actor with their voice; their body, face and lip sync drive this character");
  btn.dataset.act = "performance";
  btn.addEventListener("click", () => {
    const id = posePanel.id || stage.selected;
    if (!id) { onStatus("Select a person first."); return; }
    if (!api) { onStatus("Real performances need the ComfyUI server (DWPose and LTX run on the GPU)."); return; }
    openPerformance({ api, stage, actorId: id, pipeline, cast, onStatus });
  });
  posePanel.mcAct.after(btn);
  posePanel.perfBtn = btn;
  return btn;
}
