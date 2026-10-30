// Soundstage Cut: the edit model. Pure functions over the project contract (docs/cut.md), no DOM.
// The cut is a gapless list of events {shot_id, in, out} (out exclusive, shot-relative frames);
// record time is the running sum of event lengths starting at 01:00:00:00.

export const RUNGS = ["clay", "look", "draft", "final"];

/** Fill defaults and drop cut events that point at missing shots. Returns a new object. */
export function normalizeProject(p) {
  const project = { ...(p || {}) };
  project.name = project.name || "Soundstage cut";
  project.fps = project.fps || 24;
  project.width = Math.round(project.width || 1920);
  project.height = Math.round(project.height || 1080);
  project.shots = (project.shots || []).map((s, i) => {
    const id = s.id != null ? String(s.id) : `shot${i + 1}`;
    return {
      id,
      name: s.name || id,
      frames: Math.max(1, Math.round(s.frames || 1)),
      scene_name: s.scene_name || "",
      setup: s.setup || "",
      scene_offset: Math.round(s.scene_offset || 0),
      renders: { ...(s.renders || {}) },
      notes: s.notes || "",
      markers: normalizeMarkers(s.markers),
    };
  });
  const byId = shotMap(project);
  project.cut = (project.cut || [])
    .filter((e) => byId.has(String(e.shot_id)))
    .map((e) => {
      const shot = byId.get(String(e.shot_id));
      const inF = clamp(Math.round(e.in ?? 0), 0, shot.frames - 1);
      const outF = clamp(Math.round(e.out ?? shot.frames), inF + 1, shot.frames);
      const ev = { shot_id: shot.id, in: inF, out: outF };
      if (e.notes && (!Array.isArray(e.notes) || e.notes.length)) ev.notes = Array.isArray(e.notes) ? e.notes.map(String) : String(e.notes);
      return ev;
    });
  project.audio = normalizeAudio(project.audio, project.fps);
  project.audio_tracks = (project.audio_tracks || [])
    .map((t) => ({ track: Math.max(1, Math.round(t.track || 1)), name: t.name ? String(t.name) : "", mute: !!t.mute, solo: !!t.solo }));
  return project;
}

function normalizeMarkers(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.text || m.comment))
    .map((m) => {
      const out = { frame: Math.max(0, Math.round(m.frame || 0)), text: String(m.text || m.comment) };
      if (m.color) out.color = String(m.color);
      if (m.user) out.user = String(m.user);
      return out;
    });
}

const baseName = (p) => String(p || "").split("?")[0].split("/").pop() || "audio";

/**
 * Audio clips: {id, track (1 = A1), url | path, start_frame (record frame from the head of the cut),
 * in, out (source frames at the project rate, out exclusive; null until the length is known),
 * gain_db, fade_in, fade_out (frames), label, frames? (source length), meta?}.
 */
export function normalizeAudio(list, _fps) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((a, i) => {
    let id = a.id != null ? String(a.id) : `a${i + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    const frames = a.frames != null ? Math.max(1, Math.round(a.frames)) : null;
    const inF = Math.max(0, Math.round(a.in || 0));
    let outF = a.out != null ? Math.round(a.out) : frames;
    if (outF != null) {
      if (frames != null) outF = Math.min(outF, frames);
      outF = Math.max(inF + 1, outF);
    }
    const len = outF != null ? outF - inF : 0;
    const fadeIn = clamp(Math.round(a.fade_in || 0), 0, len);
    const clip = {
      id,
      track: Math.max(1, Math.round(a.track || 1)),
      url: a.url ? String(a.url) : "",
      path: a.path ? String(a.path) : "",
      start_frame: Math.max(0, Math.round(a.start_frame || 0)),
      in: inF,
      out: outF,
      gain_db: Math.round(clamp(Number(a.gain_db) || 0, -60, 24) * 10) / 10,
      fade_in: fadeIn,
      fade_out: clamp(Math.round(a.fade_out || 0), 0, len - fadeIn),
      label: a.label ? String(a.label) : baseName(a.url || a.path),
      frames,
    };
    if (a.meta && typeof a.meta === "object") clip.meta = a.meta;
    return clip;
  });
}

export function shotMap(project) {
  return new Map((project.shots || []).map((s) => [String(s.id), s]));
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Best available rung for a shot: final > draft > look > clay (a renders.clay capture, or offline). */
export function bestRung(shot) {
  const r = shot?.renders || {};
  if (r.final) return "final";
  if (r.draft) return "draft";
  if (r.look) return "look";
  return "clay";
}

// ---------------------------------------------------------------- audio

export const audioLen = (a) => (a.out == null ? 0 : a.out - a.in);
export const audioEndFrame = (a) => a.start_frame + audioLen(a);

/** Last record frame any audio reaches. */
export const audioEnd = (project) => (project.audio || []).reduce((n, a) => Math.max(n, audioEndFrame(a)), 0);

/** Sequence length: picture or audio, whichever runs longer. */
export const sequenceFrames = (project) => Math.max(totalFrames(project), audioEnd(project));

export function trackState(project, track) {
  return (project.audio_tracks || []).find((t) => t.track === track) || { track, name: "", mute: false, solo: false };
}

/** Is track n heard? Solo wins over mute, like every desk. */
export function audible(project, track) {
  const solos = (project.audio_tracks || []).filter((t) => t.solo);
  if (solos.length) return solos.some((t) => t.track === track);
  return !trackState(project, track).mute;
}

/** Number of audio tracks to show: every used track, at least 2. */
export const audioTrackCount = (project) =>
  Math.max(2, ...(project.audio || []).map((a) => a.track), ...(project.audio_tracks || []).map((t) => t.track));

/**
 * Lanes for export: each track's clips in time order, overlaps pushed to an extra lane (A1, A1b, ...)
 * so no exported track has overlapping clips. Clips with no known length are left out.
 */
export function audioLanes(project) {
  const lanes = [];
  const tracks = [...new Set((project.audio || []).map((a) => a.track))].sort((x, y) => x - y);
  for (const track of tracks) {
    const clips = project.audio.filter((a) => a.track === track && a.out != null)
      .map((a, i) => ({ a, i })).sort((x, y) => x.a.start_frame - y.a.start_frame || x.i - y.i).map((x) => x.a);
    const mine = [];
    for (const a of clips) {
      let lane = mine.find((l) => audioEndFrame(l.clips[l.clips.length - 1]) <= a.start_frame);
      if (!lane) {
        lane = { track, name: "A" + track + (mine.length ? String.fromCharCode(97 + mine.length) : ""), clips: [] };
        mine.push(lane);
      }
      lane.clips.push(a);
    }
    lanes.push(...mine);
  }
  return lanes;
}

const copyAudio = (audio) => (audio || []).map((a) => ({ ...a }));

/**
 * Sync lock: after a ripple edit at record frame `at` that changes the length by `delta`, move the
 * audio that starts after the edit with it. Clips starting inside a removed range land on its start.
 */
export function rippleAudio(audio, at, delta) {
  return copyAudio(audio).map((a) => {
    if (delta > 0 && a.start_frame >= at) a.start_frame += delta;
    if (delta < 0) {
      if (a.start_frame >= at) a.start_frame += delta;
      else if (a.start_frame > at + delta) a.start_frame = at + delta;
    }
    a.start_frame = Math.max(0, a.start_frame);
    return a;
  });
}

function patchAudio(project, id, fn) {
  return copyAudio(project.audio).map((a) => (a.id === String(id) ? fn(a) || a : a));
}

/** Slide a clip to a record frame and/or track. */
export function moveAudio(project, id, start, track) {
  return patchAudio(project, id, (a) => {
    a.start_frame = Math.max(0, Math.round(start));
    if (track != null) a.track = Math.max(1, Math.round(track));
  });
}

/** Trim the head (side "in": the clip's start follows, so the sound stays in sync) or the tail. */
export function trimAudio(project, id, side, delta) {
  return patchAudio(project, id, (a) => {
    if (a.out == null) return;
    if (side === "in") {
      const d = clamp(Math.round(delta), Math.max(-a.in, -a.start_frame), a.out - a.in - 1);
      a.in += d;
      a.start_frame += d;
    } else {
      a.out = clamp(a.out + Math.round(delta), a.in + 1, a.frames ?? Infinity);
    }
    const len = a.out - a.in;
    a.fade_in = Math.min(a.fade_in, len);
    a.fade_out = Math.min(a.fade_out, len - a.fade_in);
  });
}

/** Set fade_in / fade_out (frames), kept inside the clip. */
export function fadeAudio(project, id, side, frames) {
  return patchAudio(project, id, (a) => {
    const len = audioLen(a);
    if (side === "in") a.fade_in = clamp(Math.round(frames), 0, len - a.fade_out);
    else a.fade_out = clamp(Math.round(frames), 0, len - a.fade_in);
  });
}

export function setAudio(project, id, patch) {
  return normalizeAudio(patchAudio(project, id, (a) => ({ ...a, ...patch, id: a.id })), project.fps);
}

/** Cut an audio clip in two at record frame f. */
export function splitAudio(project, id, f) {
  const out = [];
  for (const a of copyAudio(project.audio)) {
    const off = f - a.start_frame;
    if (a.id !== String(id) || a.out == null || off <= 0 || off >= audioLen(a)) { out.push(a); continue; }
    const ids = new Set(project.audio.map((x) => x.id));
    let id2 = a.id + "_b";
    while (ids.has(id2)) id2 += "_";
    out.push({ ...a, out: a.in + off, fade_out: 0, fade_in: Math.min(a.fade_in, off) },
             { ...a, id: id2, in: a.in + off, start_frame: f, fade_in: 0, fade_out: Math.min(a.fade_out, audioLen(a) - off) });
  }
  return out;
}

export function removeAudio(project, id) {
  return copyAudio(project.audio).filter((a) => a.id !== String(id));
}

/** Free track for a clip at [start, start+len): the first track with nothing there, else a new one. */
export function freeTrack(project, start, len, from = 1) {
  for (let t = from; ; t++) {
    const busy = (project.audio || []).some((a) => a.track === t && a.start_frame < start + Math.max(1, len) && audioEndFrame(a) > start);
    if (!busy) return t;
  }
}

/** Shot notes, event notes and shot markers inside the event, as [{text, src, color?, user?}]. */
export function noteItems(row) {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).replace(/\s+/g, " ").trim()).filter(Boolean);
  const items = [...list(row.shot.notes), ...list(row.event.notes)].map((text) => ({ text, src: row.in }));
  for (const m of [...(row.shot.markers || [])].sort((a, b) => a.frame - b.frame)) {
    const text = String(m.text).replace(/\s+/g, " ").trim();
    if (!text || m.frame < row.in || m.frame >= row.out) continue;
    const it = { text, src: m.frame };
    if (m.color) it.color = m.color;
    if (m.user) it.user = m.user;
    items.push(it);
  }
  return items;
}

/** Events with record positions: [{index, shot, in, out, len, recIn, recOut}] (rec frames from 0). */
export function layout(project) {
  const byId = shotMap(project);
  let rec = 0;
  return project.cut.map((e, index) => {
    const len = e.out - e.in;
    const row = { index, event: e, shot: byId.get(String(e.shot_id)), in: e.in, out: e.out, len, recIn: rec, recOut: rec + len };
    rec += len;
    return row;
  });
}

export const totalFrames = (project) => project.cut.reduce((n, e) => n + (e.out - e.in), 0);

/** The event under record frame f (null past the end). */
export function eventAt(project, f) {
  for (const row of layout(project)) if (f >= row.recIn && f < row.recOut) return row;
  return null;
}

/** Record frames of every edit point, including 0 and the end. */
export function editPoints(project) {
  const pts = [0];
  for (const row of layout(project)) pts.push(row.recOut);
  return pts;
}

/** Frame on the scene clock. Setups of one scene share actors and timing, offset by scene_offset. */
export const sceneFrame = (shot, f) => (shot.scene_offset || 0) + f;

const sameScene = (a, b) => !!(a && b && a.id !== b.id && a.scene_name && a.scene_name === b.scene_name);

/**
 * Cut on action: the in point on `shot` that continues the scene clock from `prevShot` at `prevOut`.
 * Returns null when the shots are not two setups of one scene or the frame is outside the shot.
 */
export function actionMatchIn(prevShot, prevOut, shot) {
  if (!sameScene(prevShot, shot)) return null;
  const f = sceneFrame(prevShot, prevOut) - (shot.scene_offset || 0);
  return f >= 0 && f < shot.frames ? f : null;
}

// ---------------------------------------------------------------- edits (all return a new cut array)

const copy = (cut) => cut.map((e) => ({ ...e }));

/** Move event `from` so it lands before the event currently at `to` (to = cut.length appends). */
export function moveEvent(project, from, to, { action = true } = {}) {
  const cut = copy(project.cut);
  if (from < 0 || from >= cut.length) return cut;
  const [ev] = cut.splice(from, 1);
  const at = clamp(to > from ? to - 1 : to, 0, cut.length);
  cut.splice(at, 0, ev);
  return action ? matchAction(project, cut, at) : cut;
}

/** Insert a shot (default: the whole shot) before position `at`. */
export function insertShot(project, shotId, at, { in: inF, out: outF, action = true } = {}) {
  const shot = shotMap(project).get(String(shotId));
  if (!shot) return copy(project.cut);
  const cut = copy(project.cut);
  const ev = { shot_id: shot.id, in: clamp(inF ?? 0, 0, shot.frames - 1), out: 0 };
  ev.out = clamp(outF ?? shot.frames, ev.in + 1, shot.frames);
  at = clamp(at ?? cut.length, 0, cut.length);
  cut.splice(at, 0, ev);
  return action && inF == null ? matchAction(project, cut, at) : cut;
}

/**
 * If cut[i] follows another setup of the same scene, slide its in point to continue the action
 * (keeping its length where the shot allows).
 */
export function matchAction(project, cut, i) {
  if (i <= 0 || i >= cut.length) return cut;
  const byId = shotMap(project);
  const prev = cut[i - 1], ev = cut[i];
  const inF = actionMatchIn(byId.get(prev.shot_id), prev.out, byId.get(ev.shot_id));
  if (inF == null) return cut;
  const shot = byId.get(ev.shot_id);
  const len = ev.out - ev.in;
  ev.in = inF;
  ev.out = clamp(inF + len, inF + 1, shot.frames);
  return cut;
}

/** Ripple-trim the head of event i by delta frames (positive = later in point, shorter clip). */
export function trimIn(project, i, delta) {
  const cut = copy(project.cut);
  const ev = cut[i];
  if (!ev) return cut;
  ev.in = clamp(ev.in + delta, 0, ev.out - 1);
  return cut;
}

/** Ripple-trim the tail of event i by delta frames (positive = later out point, longer clip). */
export function trimOut(project, i, delta) {
  const cut = copy(project.cut);
  const ev = cut[i];
  if (!ev) return cut;
  const shot = shotMap(project).get(ev.shot_id);
  ev.out = clamp(ev.out + delta, ev.in + 1, shot.frames);
  return cut;
}

/** Roll the edit between events i-1 and i by delta: A's out and B's in move together, length unchanged. */
export function roll(project, i, delta) {
  const cut = copy(project.cut);
  const a = cut[i - 1], b = cut[i];
  if (!a || !b) return cut;
  const sa = shotMap(project).get(a.shot_id);
  const lo = Math.max(a.in + 1 - a.out, -b.in);
  const hi = Math.min(sa.frames - a.out, b.out - 1 - b.in);
  const d = clamp(delta, lo, hi);
  a.out += d;
  b.in += d;
  return cut;
}

/** Add an edit at record frame f (no-op on an existing edit point). */
export function splitAt(project, f) {
  const cut = copy(project.cut);
  const row = eventAt(project, f);
  if (!row || f === row.recIn) return cut;
  const at = row.in + (f - row.recIn);
  const head = { ...cut[row.index], out: at };
  const tail = { ...cut[row.index], in: at };
  delete tail.notes;
  cut.splice(row.index, 1, head, tail);
  return cut;
}

/** Remove event i and close the gap. */
export function rippleDelete(project, i) {
  const cut = copy(project.cut);
  if (i >= 0 && i < cut.length) cut.splice(i, 1);
  return cut;
}

/** Extract record range [a, b): remove the frames and close the gap (Avid "Extract"). */
export function extractRange(project, a, b) {
  if (b <= a) return copy(project.cut);
  const out = [];
  for (const row of layout(project)) {
    const e = row.event;
    if (row.recOut <= a || row.recIn >= b) { out.push({ ...e }); continue; }
    if (row.recIn < a) out.push({ ...e, out: e.in + (a - row.recIn) });
    if (row.recOut > b) { const t = { ...e, in: e.in + (b - row.recIn) }; if (row.recIn < a) delete t.notes; out.push(t); }
  }
  return out;
}

/**
 * Cut-on-action in point for `shotId` placed at record frame f: continue the scene clock of whatever
 * plays at f (or ends at f). null when it is not another setup of the same scene.
 */
export function actionInAtRecord(project, f, shotId) {
  const shot = shotMap(project).get(String(shotId));
  let row = eventAt(project, f), at = f;
  if (!row && f > 0) { row = eventAt(project, f - 1); }
  if (!row || !shot || !sameScene(row.shot, shot)) return null;
  const sf = sceneFrame(row.shot, row.in + (at - row.recIn)) - (shot.scene_offset || 0);
  return sf >= 0 && sf < shot.frames ? sf : null;
}

/** Overwrite record range [a, b) with shotId from srcIn (shortened if the shot runs out). */
export function overwrite(project, a, b, shotId, srcIn = 0) {
  const shot = shotMap(project).get(String(shotId));
  if (!shot) return copy(project.cut);
  a = clamp(Math.round(a), 0, totalFrames(project));
  srcIn = clamp(Math.round(srcIn), 0, shot.frames - 1);
  const len = Math.min(Math.round(b) - a, shot.frames - srcIn);
  if (len <= 0) return copy(project.cut);
  const cut = splitAt({ ...project, cut: extractRange(project, a, a + len) }, a);
  const at = layout({ ...project, cut }).filter((r) => r.recOut <= a).length;
  cut.splice(at, 0, { shot_id: shot.id, in: srcIn, out: srcIn + len });
  return cut;
}

/** A first assembly: every shot in order, whole, cut on action between setups of one scene. */
export function stringOut(project) {
  let cut = [];
  for (const s of project.shots) cut = insertShot({ ...project, cut }, s.id, cut.length);
  return cut;
}

/** Audio after reordering event `from` to before `to` (sync lock): each clip rides with the event it starts under. */
export function audioAfterMove(project, newCut, from, to) {
  const rows = layout(project), newRows = layout({ ...project, cut: newCut });
  const order = rows.map((r) => r.index);
  const [m] = order.splice(from, 1);
  order.splice(to > from ? to - 1 : to, 0, m);
  const tail = totalFrames({ ...project, cut: newCut }) - totalFrames(project);
  return (project.audio || []).map((a) => {
    const j = rows.findIndex((r) => a.start_frame >= r.recIn && a.start_frame < r.recOut);
    if (j < 0) return { ...a, start_frame: Math.max(0, a.start_frame + tail) };
    const nr = newRows[order.indexOf(j)];
    return { ...a, start_frame: nr.recIn + Math.min(a.start_frame - rows[j].recIn, Math.max(0, nr.len - 1)) };
  });
}
