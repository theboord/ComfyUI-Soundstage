// Soundstage Cut exporters, one per NLE in its best format:
//   Avid Media Composer: CMX3600 EDL + Avid locator .txt (AAF is written server side, soundstage/cut/aaf.py)
//   Premiere Pro: Final Cut Pro 7 XML (xmeml v5)    DaVinci Resolve: FCPXML 1.10 + OTIO    Final Cut Pro: FCPXML 1.10
// Pure functions of the project contract (docs/cut.md). soundstage/cut/export.py mirrors this file
// byte for byte; tests/test_cut.py checks the two agree.

import { audible, audioLanes, audioLen, bestRung, layout, noteItems, normalizeProject, sequenceFrames, totalFrames } from "./timeline.mjs";
import { isOverlap, mergedLevelKeys, toSRT, toVTT, transSpans } from "./fx.mjs";

// ---------------------------------------------------------------- time

/** Frame rate as {base (timecode frames per second), num, den (seconds per frame = den/num)}. */
export function fpsInfo(fps) {
  const f = Number(fps) || 24;
  for (const [nominal, base] of [[23.976, 24], [29.97, 30], [47.952, 48], [59.94, 60]]) {
    if (Math.abs(f - nominal) < 0.01) return { base, num: base * 1000, den: 1001 };
  }
  const base = Math.max(1, Math.round(f));
  return { base, num: base, den: 1 };
}

/** Non-drop timecode HH:MM:SS:FF for an absolute frame count. */
export function framesToTC(frames, base = 24) {
  const n = Math.max(0, Math.round(frames));
  const ff = n % base, s = Math.floor(n / base);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export function tcToFrames(tc, base = 24) {
  const [h, m, s, f] = String(tc).split(/[:;.]/).map(Number);
  return ((h * 60 + m) * 60 + s) * base + f;
}

/** Record start 01:00:00:00 in frames. */
export const recordStart = (base) => 3600 * base;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** FCPXML rational time for a frame count, e.g. "5/2s", "3600s", "1001/24000s". */
export function fcpTime(frames, fi) {
  const n = frames * fi.den, d = fi.num;
  if (n === 0) return "0s";
  const g = gcd(Math.abs(n), d);
  return d / g === 1 ? `${n / g}s` : `${n / g}/${d / g}s`;
}

// ---------------------------------------------------------------- media

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A render URL or path -> {path, url}. ComfyUI /view?filename=&subfolder= becomes an output-relative path. */
export function resolveMedia(raw, mediaRoot = "") {
  raw = String(raw || "");
  let rel = raw;
  const q = raw.indexOf("?");
  if (q >= 0 && /(^|[?&])filename=/.test(raw.slice(q))) {
    const params = new URLSearchParams(raw.slice(q + 1));
    rel = [params.get("subfolder"), params.get("filename")].filter(Boolean).join("/");
  }
  let path = rel;
  if (mediaRoot && rel && !SCHEME.test(rel) && !rel.startsWith("/")) path = mediaRoot.replace(/\/+$/, "") + "/" + rel;
  let url = path;
  if (path.startsWith("/")) url = "file://" + encodeURI(path);
  else if (!SCHEME.test(path)) url = encodeURI(path);
  return { path, url };
}

/**
 * Where a shot's best render lives: Final, else Draft, else the Look still, else a renders.clay
 * capture. With none of those the clip is offline at <mediaRoot>/<shot name>.mov, ready to relink.
 */
export function mediaFor(shot, mediaRoot = "") {
  const rung = bestRung(shot);
  // Imported footage (docs/source_fidelity.md): the camera original stands in until a generated render
  // exists, or is the picture itself (use: "original"). Never under mediaRoot: it lives where it was shot.
  if (shot.source && (shot.source.use === "original" || rung === "clay" || rung === "look")) {
    const { path, url } = resolveMedia(shot.source.path);
    return { rung: "source", kind: "video", path, url, offline: false, source: shot.source };
  }
  const raw = rung === "clay" ? String(shot.renders.clay || "") : String(shot.renders[rung]);
  const offline = !resolveMedia(raw).path;
  const { path, url } = resolveMedia(offline ? `${shot.name}.mov` : raw, mediaRoot);
  return { rung, kind: rung === "look" ? "image" : "video", path, url, offline };
}

/** "DRAFT stand-in: relink to the Final render", or "" for a Final. */
export function relinkNote(media) {
  if (media.rung === "final") return "";
  if (media.rung === "source") return media.source.use === "original" ? "" : "SOURCE plate stand-in: relink to the Final render";
  if (media.offline) return "CLAY offline: render the shot, then relink";
  return `${media.rung.toUpperCase()} stand-in: relink to the Final render`;
}

export const audioMedia = (a, mediaRoot = "") => resolveMedia(a.path || a.url, mediaRoot);

/** Source length of an audio clip in frames (the file is at least this long). */
const audioSrcFrames = (a) => Math.max(a.frames ?? 0, a.out);

/** A source clip's timing: its own rate, first frame (its start timecode) and cut frame -> source frame. */
export function sourceTiming(src, project) {
  const fi = fpsInfo(project.fps);
  const sfi = fpsInfo(src.fps || project.fps);
  const same = sfi.base === fi.base;
  const map = (f) => (same ? f : Math.round((f * sfi.num * fi.den) / (sfi.den * fi.num)));
  return { sfi, same, start: src.tc_start ? tcToFrames(src.tc_start, sfi.base) : 0, map };
}

/** "3840x2160 23.976 FPS", the camera original's picture in an EDL comment. */
const srcSpecText = (src) => `${src.width}x${src.height} ${Number(src.fps) || "?"} FPS${src.colour ? " " + src.colour.toUpperCase() : ""}`;

/** Notes a source clip carries into every export: proxy relink, rate mismatch. */
export function sourceNotes(src, project) {
  const out = [];
  if (src.proxy) out.push(`cut from the proxy ${src.proxy.split("/").pop()}: relink to the camera original ${src.path.split("/").pop()}`);
  if (!sourceTiming(src, project).same) out.push(`source is ${Number(src.fps)} fps in a ${Number(project.fps)} fps sequence: convert the rate on conform`);
  return out;
}

const reelBase = (name, width) => (name.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "AX").slice(0, width);

/** Reel names for shots (key: shot id) and audio clips (key: "audio:<id>"): upper-case [A-Z0-9_], cut to `width`, unique. */
/** A source clip's reel: its own reel name, else its file name (camera rolls share reels; that is right). */
export const sourceReel = (src, width = 8) => reelBase(src.reel || src.path.split("/").pop().replace(/\.[^.]+$/, ""), width);

export function reelNames(project, width = 8) {
  const used = new Set(), out = new Map();
  const add = (key, name) => {
    const base = reelBase(name, width);
    let reel = base, n = 1;
    while (used.has(reel)) { const suf = String(n++); reel = base.slice(0, width - suf.length) + suf; }
    used.add(reel);
    out.set(key, reel);
  };
  for (const s of project.shots) add(s.id, s.name);
  for (const a of project.audio || []) add("audio:" + a.id, a.label);
  return out;
}

const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

const AVID_COLORS = ["Red", "Green", "Blue", "Cyan", "Magenta", "Yellow", "Black", "White"];
/** Avid locator colour name for a note colour (anything unknown -> Red). */
export const avidColor = (c) => AVID_COLORS.find((x) => x.toLowerCase() === String(c || "").toLowerCase()) || "Red";

const gainText = (g) => (g > 0 ? "+" : "") + g.toFixed(1);

// ---------------------------------------------------------------- CMX3600

/**
 * CMX3600 EDL. Picture events first (V, contiguous from 01:00:00:00), then audio events (A, A2, A3...,
 * one channel per exported lane). Reel = shot name / clip label (8 chars, or reelWidth: 32 for Avid
 * File_32); full names in FROM CLIP NAME, media in SOURCE FILE, notes as Avid LOC lines.
 */
export function toEDL(input, { reelWidth = 8, sourceStart = 0, mediaRoot = "" } = {}) {
  const project = normalizeProject(input);
  const fi = fpsInfo(project.fps);
  const tc = (f) => framesToTC(f, fi.base);
  const reels = reelNames(project, reelWidth);
  const start = recordStart(fi.base);
  const title = oneLine(project.name).replace(/[^\x20-\x7e]/g, "").slice(0, 70) || "SOUNDSTAGE CUT";
  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  const event = (num, reel, ch, si, so, ri, ro, stc = (f) => tc(sourceStart + f), kind = "C", dur = null) =>
    `${String(num).padStart(3, "0")}  ${reel.padEnd(reelWidth)} ${ch.padEnd(5)} ${kind.padEnd(4)} ${dur == null ? "   " : String(dur).padStart(3, "0")} ` +
    `${stc(si)} ${stc(so)} ${tc(start + ri)} ${tc(start + ro)}`;
  const BL = "BL".padEnd(reelWidth);
  const blTC = (f) => tc(f);
  // Transitions (Milestone 19): a dissolve / wipe is a zero-length cut on the outgoing clip at the transition's
  // start, then a D (or W001) event into the incoming clip; a dip is a dissolve to black (BL) and one back up from it;
  // the head's fade is BL -> the first clip, the tail's the last clip -> BL. Dips to white go out as BL with a note.
  const spans = transSpans(project);
  const rows = layout(project);
  const reelOf = (row) => (mediaFor(row.shot, mediaRoot).rung === "source" ? sourceReel(row.shot.source, reelWidth) : reels.get(row.shot.id));
  const stcOf = (row) => {
    if (mediaFor(row.shot, mediaRoot).rung !== "source") return [(f) => f, undefined];
    const st = sourceTiming(row.shot.source, project);
    return [(f) => st.start + st.map(f), (f) => framesToTC(f, st.sfi.base)];
  };
  const cutLine = (n, row, recAt) => { const [m, stc] = stcOf(row); const f = m(row.in + (recAt - row.recIn)); return event(n, reelOf(row), "V", f, f, recAt, recAt, stc); };
  const white = (sp) => (sp.type === "dip_white" ? ["* SOUNDSTAGE: DIP TO WHITE (BL in the EDL: set the colour to white in the NLE)"] : []);
  let num = 0;
  rows.forEach((row, k) => {
    const m = mediaFor(row.shot, mediaRoot);
    const src = row.shot.source;
    const into = spans[k], next = spans[k + 1], tail = k === rows.length - 1 ? spans.tail : null;
    const cutAt = row.recOut - (next && !next.head ? next.pre : 0) - (tail ? tail.pre : 0);
    let recIn = row.recIn, srcIn = row.in;
    const [map, stc] = stcOf(row);
    const head = [];
    if (into && into.head) {
      head.push(event(++num, BL, "V", 0, 0, 0, 0, blTC), event(num, reelOf(row), "V", map(srcIn), map(row.in + (cutAt - row.recIn)), 0, cutAt, stc, "D", into.post),
                 "* FROM CLIP NAME: BLACK", `* TO CLIP NAME: ${oneLine(row.shot.name)}`, ...white(into));
    } else if (into && isOverlap(into.type)) {
      const a = rows[k - 1];
      recIn = into.at - into.pre; srcIn = row.in - into.pre;
      head.push(cutLine(++num, a, recIn), event(num, reelOf(row), "V", map(srcIn), map(row.in + (cutAt - row.recIn)), recIn, cutAt, stc,
                into.type === "wipe" ? "W001" : "D", into.frames), `* FROM CLIP NAME: ${oneLine(a.shot.name)}`, `* TO CLIP NAME: ${oneLine(row.shot.name)}`);
    } else if (into) {
      const a = rows[k - 1];
      if (into.pre) {
        lines.push(cutLine(++num, a, into.at - into.pre), event(num, BL, "V", 0, into.pre, into.at - into.pre, into.at, blTC, "D", into.pre),
                   `* FROM CLIP NAME: ${oneLine(a.shot.name)}`, "* TO CLIP NAME: BLACK", ...white(into), "");
      }
      if (into.post) {
        head.push(event(++num, BL, "V", 0, 0, into.at, into.at, blTC), event(num, reelOf(row), "V", map(srcIn), map(row.in + (cutAt - row.recIn)), into.at, cutAt, stc, "D", into.post),
                  "* FROM CLIP NAME: BLACK", `* TO CLIP NAME: ${oneLine(row.shot.name)}`, ...white(into));
      }
    }
    if (head.length) lines.push(...head);
    else {
      lines.push(event(++num, reelOf(row), "V", map(srcIn), map(row.in + (cutAt - row.recIn)), recIn, cutAt, stc));
      lines.push(`* FROM CLIP NAME: ${oneLine(row.shot.name)}`);
    }
    if (!m.offline) lines.push(`* SOURCE FILE: ${m.path}`);
    if (m.rung === "source") {
      lines.push(`* SOUNDSTAGE: CAMERA ORIGINAL ${srcSpecText(src)}`);
      for (const n of sourceNotes(src, project)) lines.push(`* SOUNDSTAGE: ${n}`);
    } else if (src) {
      const st = sourceTiming(src, project);
      lines.push(`* SOUNDSTAGE PLATE: ${src.path} REEL ${sourceReel(src, 32)} TC ${framesToTC(st.start + st.map(row.in), st.sfi.base)} ${srcSpecText(src)}`);
    }
    if (relinkNote(m)) lines.push(`* SOUNDSTAGE: ${relinkNote(m)}`);
    if (into && into.limited) lines.push(`* SOUNDSTAGE: ${into.type.toUpperCase()} ${into.req} FRAMES SHORTENED TO ${into.frames} (HANDLES)`);
    if (row.event.opacity) lines.push(`* SOUNDSTAGE OPACITY: ${row.event.opacity.map(([f, v]) => `${f} ${v.toFixed(2)}`).join(", ")}`);
    // one LOC per frame: Avid keeps a single locator per frame
    const locs = [];
    for (const it of noteItems(row)) {
      const same = locs.find((l) => l.src === it.src);
      if (same) same.text += " | " + it.text;
      else locs.push({ ...it });
    }
    for (const it of locs) lines.push(`* LOC: ${tc(start + row.recIn + it.src - row.in)} ${avidColor(it.color).toUpperCase().padEnd(7)} ${it.text}`);
    lines.push("");
    if (tail) {
      lines.push(cutLine(++num, row, cutAt), event(num, BL, "V", 0, tail.pre, cutAt, row.recOut, blTC, "D", tail.pre),
                 `* FROM CLIP NAME: ${oneLine(row.shot.name)}`, "* TO CLIP NAME: BLACK", ...white(tail), "");
    }
  });
  audioLanes(project).forEach((lane, k) => {
    const ch = k === 0 ? "A" : `A${k + 1}`;
    for (const a of lane.clips) {
      lines.push(event(++num, reels.get("audio:" + a.id), ch, a.in, a.out, a.start_frame, a.start_frame + audioLen(a)));
      lines.push(`* FROM CLIP NAME: ${oneLine(a.label)}`);
      lines.push(`* SOURCE FILE: ${audioMedia(a, mediaRoot).path}`);
      const fx = [];
      if (lane.name !== `A${k + 1}`) fx.push(`TRACK ${lane.name}`);
      if (a.gain_db) fx.push(`GAIN ${gainText(a.gain_db)} DB`);
      if (a.fade_in) fx.push(`FADE IN ${a.fade_in}`);
      if (a.fade_out) fx.push(`FADE OUT ${a.fade_out}`);
      if (!audible(project, a.track)) fx.push("MUTED");
      if (fx.length) lines.push(`* SOUNDSTAGE AUDIO: ${fx.join(", ")}`);
      const lk = mergedLevelKeys(a);
      if (lk) lines.push(`* SOUNDSTAGE LEVEL: ${lk.map(([f, db]) => `${f} ${gainText(db)}`).join(", ")}`);
      lines.push("");
    }
  });
  for (const t of project.titles || []) {
    lines.push(`* SOUNDSTAGE TITLE: ${tc(start + t.start_frame)} ${tc(start + t.start_frame + t.frames)} ${t.style.toUpperCase()} ${oneLine(t.text)}`);
  }
  if ((project.titles || []).length) lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------- Avid locators

/**
 * Locators for Avid, one per frame (Media Composer keeps a single locator per frame and track, so notes
 * that share a frame are joined with " | "). [{frame (record, from the head), user, color, text, length}].
 * Stand-in clips get a Cyan RELINK locator unless a note already sits on their first frame (then the
 * relink text is appended to it).
 */
export function locatorEntries(input, { relink = true } = {}) {
  const project = normalizeProject(input);
  const out = [];
  const add = (e) => {
    const same = out.find((x) => x.frame === e.frame);
    if (!same) { out.push(e); return; }
    same.text += " | " + e.text;
    same.length = Math.max(same.length, e.length);
  };
  for (const row of layout(project)) {
    for (const it of noteItems(row)) add({ frame: row.recIn + it.src - row.in, user: it.user || "NOTE", color: avidColor(it.color), text: `[${row.shot.name}] ${it.text}`, length: 1 });
    const note = relink ? relinkNote(mediaFor(row.shot)) : "";
    if (note) add({ frame: row.recIn, user: "RELINK", color: "Cyan", text: `[${row.shot.name}] ${note}`, length: row.len });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

/**
 * Avid Media Composer locator file (Markers window > right-click > Import Markers), the layout
 * ~/Notes2Markers writes: tab-separated USER, TC, TRACK, COLOR, COMMENT, LENGTH, (blank), COLOR, on V1.
 * Save it as Latin-1.
 */
export function toAvidLocators(input, opts = {}) {
  const project = normalizeProject(input);
  const fi = fpsInfo(project.fps);
  const start = recordStart(fi.base);
  const clean = (s) => oneLine(s).replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2015\u2212]/g, "-").replace(/[^\x00-\xff]/g, "?");
  const lines = locatorEntries(project, opts).map((e) =>
    [clean(e.user), framesToTC(start + e.frame, fi.base), "V1", e.color, clean(e.text), String(e.length), "", e.color].join("\t"));
  return lines.length ? lines.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------- OTIO

const rt = (v, rate) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value: v });
const tr = (start, dur, rate) => ({ OTIO_SCHEMA: "TimeRange.1", duration: rt(dur, rate), start_time: rt(start, rate) });
const OTIO_COLORS = new Set(["RED", "GREEN", "BLUE", "CYAN", "MAGENTA", "YELLOW", "BLACK", "WHITE"]);

/** OpenTimelineIO timeline (plain JSON object): V1 plus one audio track per lane. */
export function toOTIO(input, { mediaRoot = "" } = {}) {
  const project = normalizeProject(input);
  const fi = fpsInfo(project.fps);
  const rate = fi.num / fi.den;
  const clips = layout(project).map((row) => {
    const m = mediaFor(row.shot, mediaRoot);
    const src = row.shot.source;
    const meta = { shot_id: row.shot.id, scene: row.shot.scene_name, setup: row.shot.setup, rung: m.rung, relink: relinkNote(m) };
    if (src) meta.source = { ...src, notes: sourceNotes(src, project) };
    if (m.rung === "source") {
      const st = sourceTiming(src, project);
      const srate = st.sfi.num / st.sfi.den;
      const len = Math.max(src.frames, st.map(row.shot.frames));
      return {
        OTIO_SCHEMA: "Clip.2",
        metadata: { soundstage: meta },
        name: row.shot.name,
        source_range: tr(st.start + st.map(row.in), st.map(row.out) - st.map(row.in), srate),
        effects: [],
        markers: noteItems(row).map((it) => ({
          OTIO_SCHEMA: "Marker.2", metadata: {}, name: it.text.slice(0, 60),
          color: OTIO_COLORS.has(String(it.color || "").toUpperCase()) ? String(it.color).toUpperCase() : "RED",
          marked_range: tr(st.start + st.map(it.src), 0, srate), comment: it.text,
        })),
        enabled: true,
        color: null,
        media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", metadata: { soundstage: { camera_original: true, reel: sourceReel(src, 32) } },
          name: src.path.split("/").pop(), available_range: tr(st.start, len, srate), available_image_bounds: null, target_url: m.url } },
        active_media_reference_key: "DEFAULT_MEDIA",
      };
    }
    const ref = m.offline
      ? { OTIO_SCHEMA: "MissingReference.1", metadata: {}, name: row.shot.name, available_range: tr(0, row.shot.frames, rate),
          available_image_bounds: null }
      : { OTIO_SCHEMA: "ExternalReference.1", metadata: {}, name: row.shot.name, available_range: tr(0, row.shot.frames, rate),
          available_image_bounds: null, target_url: m.url };
    return {
      OTIO_SCHEMA: "Clip.2",
      metadata: { soundstage: meta },
      name: row.shot.name,
      source_range: tr(row.in, row.len, rate),
      effects: [],
      markers: noteItems(row).map((it) => ({
        OTIO_SCHEMA: "Marker.2", metadata: {}, name: it.text.slice(0, 60),
        color: OTIO_COLORS.has(String(it.color || "").toUpperCase()) ? String(it.color).toUpperCase() : "RED",
        marked_range: tr(it.src, 0, rate), comment: it.text,
      })),
      enabled: true,
      color: null,
      media_references: { DEFAULT_MEDIA: ref },
      active_media_reference_key: "DEFAULT_MEDIA",
    };
  });
  // Milestone 19: clip opacity keys ride in metadata; transitions are Transition.1 items between the clips (the head
  // fade before the first, the tail fade after the last), their place given by in_offset / out_offset.
  const spans = transSpans(project);
  layout(project).forEach((row, k) => { if (row.event.opacity) clips[k].metadata.soundstage.opacity = row.event.opacity; });
  const otioTrans = (sp) => ({ OTIO_SCHEMA: "Transition.1", metadata: { soundstage: { type: sp.type, frames: sp.frames, requested: sp.req } },
    name: { dissolve: "Cross Dissolve", dip_black: "Dip to Black", dip_white: "Dip to White", wipe: "Wipe" }[sp.type],
    transition_type: sp.type === "wipe" ? "SMPTE_Wipe" : "SMPTE_Dissolve", in_offset: rt(sp.pre, rate), out_offset: rt(sp.post, rate) });
  const v1 = [];
  clips.forEach((c, k) => { if (spans[k]) v1.push(otioTrans(spans[k])); v1.push(c); });
  if (spans.tail) v1.push(otioTrans(spans.tail));
  const track = (name, kind, children) => ({ OTIO_SCHEMA: "Track.1", metadata: {}, name, source_range: null, effects: [], markers: [],
                                             enabled: true, color: null, children, kind });
  const gap = (len) => ({ OTIO_SCHEMA: "Gap.1", metadata: {}, name: "", source_range: tr(0, len, rate), effects: [], markers: [], enabled: true, color: null });
  const audioTracks = audioLanes(project).map((lane) => {
    const children = [];
    let pos = 0;
    for (const a of lane.clips) {
      if (a.start_frame > pos) children.push(gap(a.start_frame - pos));
      children.push({
        OTIO_SCHEMA: "Clip.2",
        metadata: { soundstage: { audio_id: a.id, track: a.track, gain_db: a.gain_db, fade_in: a.fade_in, fade_out: a.fade_out,
                                  ...(a.keys || a.duck ? { level_keys: mergedLevelKeys(a) } : {}) } },
        name: a.label,
        source_range: tr(a.in, audioLen(a), rate),
        effects: [],
        markers: [],
        enabled: audible(project, a.track),
        color: null,
        media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", metadata: {}, name: a.label,
          available_range: tr(0, audioSrcFrames(a), rate), available_image_bounds: null, target_url: audioMedia(a, mediaRoot).url } },
        active_media_reference_key: "DEFAULT_MEDIA",
      });
      pos = a.start_frame + audioLen(a);
    }
    return track(lane.name, "Audio", children);
  });
  // Titles: a V2 track of generator clips (the NLE makes them its own text; the text and style are in parameters).
  function titleTrack() {
    if (!(project.titles || []).length) return [];
    const children = [];
    let pos = 0;
    for (const t of [...project.titles].sort((x, y) => x.start_frame - y.start_frame)) {
      if (t.start_frame < pos) continue;
      if (t.start_frame > pos) children.push(gap(t.start_frame - pos));
      children.push({ OTIO_SCHEMA: "Clip.2", metadata: { soundstage: { title_id: t.id, style: t.style, fade_in: t.fade_in, fade_out: t.fade_out } },
        name: t.text.slice(0, 60), source_range: tr(0, t.frames, rate), effects: [], markers: [], enabled: true, color: null,
        media_references: { DEFAULT_MEDIA: { OTIO_SCHEMA: "GeneratorReference.1", metadata: {}, name: "Title", available_range: tr(0, t.frames, rate),
          available_image_bounds: null, generator_kind: "SoundstageTitle", parameters: { text: t.text, style: t.style } } },
        active_media_reference_key: "DEFAULT_MEDIA" });
      pos = t.start_frame + t.frames;
    }
    return [track("V2", "Video", children)];
  }
  return {
    OTIO_SCHEMA: "Timeline.1",
    metadata: { soundstage: { fps: project.fps, width: project.width, height: project.height, ...(project.delivery ? { delivery: project.delivery } : {}) } },
    name: project.name,
    global_start_time: rt(recordStart(fi.base), rate),
    tracks: {
      OTIO_SCHEMA: "Stack.1", metadata: {}, name: "tracks", source_range: null, effects: [], markers: [], enabled: true, color: null,
      children: [track("V1", "Video", v1), ...titleTrack(), ...audioTracks],
    },
  };
}

// ---------------------------------------------------------------- FCPXML 1.10

/** FCPXML colorSpace for a source's colour tags (Rec.709 when untagged). */
const fcpColour = (src) => (src.primaries === "bt2020" || src.matrix.startsWith("bt2020")
  ? src.transfer === "smpte2084" ? "9-16-9 (Rec. 2020 PQ)" : src.transfer === "arib-std-b67" ? "9-18-9 (Rec. 2020 HLG)" : "9-1-9 (Rec. 2020)"
  : "1-1-1 (Rec. 709)");

/** Rational seconds a + b, a in one timebase and b in another, as FCPXML time. */
function fcpSum(fa, fia, fb, fib) {
  const n = fa * fia.den * fib.num + fb * fib.den * fia.num, d = fia.num * fib.num;
  if (n === 0) return "0s";
  const g = gcd(Math.abs(n), d);
  return d / g === 1 ? `${n / g}s` : `${n / g}/${d / g}s`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * FCPXML 1.10 for Resolve / Final Cut: a spine of asset-clips (video) and clips (Look stills); audio is
 * connected clips on lanes -1, -2... anchored to the picture above them (a gap carries audio past the end).
 */
export function toFCPXML(input, { mediaRoot = "" } = {}) {
  const project = normalizeProject(input);
  const fi = fpsInfo(project.fps);
  const t = (f) => fcpTime(f, fi);
  const rows = layout(project);
  const total = totalFrames(project);
  const seqLen = sequenceFrames(project);
  const assets = new Map();
  const formats = [];
  let nextId = 2;
  for (const row of rows) {
    if (assets.has(row.shot.id)) continue;
    const media = mediaFor(row.shot, mediaRoot);
    // The camera original keeps its own format (size, rate, colour) and starts at its own timecode.
    let src = null;
    if (media.rung === "source") {
      const s = row.shot.source, st = sourceTiming(s, project);
      src = { st, fid: `r${nextId++}`, frames: Math.max(s.frames, st.map(row.shot.frames)) };
      formats.push(`    <format id="${src.fid}" frameDuration="${fcpTime(1, st.sfi)}" width="${s.width || project.width}" ` +
                   `height="${s.height || project.height}" colorSpace="${fcpColour(s)}"/>`);
    }
    assets.set(row.shot.id, { id: `r${nextId++}`, shot: row.shot, media, src });
  }
  const lanes = audioLanes(project);
  const audioAssets = new Map(); // url -> {id, name, frames, url}
  for (const lane of lanes) for (const a of lane.clips) {
    const url = audioMedia(a, mediaRoot).url;
    const cur = audioAssets.get(url);
    if (cur) cur.frames = Math.max(cur.frames, audioSrcFrames(a));
    else audioAssets.set(url, { id: `r${nextId++}`, name: a.label, frames: audioSrcFrames(a), url });
  }

  // Milestone 19: transitions (every kind goes out as FCP's Cross Dissolve, at its real place and length) and titles
  // (Basic Title on lane 1).
  const spans = transSpans(project);
  const hasTrans = spans.some(Boolean) || !!spans.tail;
  const dissolveId = hasTrans ? `r${nextId++}` : null;
  const titles = project.titles || [];
  const titleId = titles.length ? `r${nextId++}` : null;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.10">', "  <resources>"];
  const seqSrc = project.shots.find((x) => x.source && project.delivery && x.name === project.delivery.from)?.source;
  out.push(`    <format id="r1" frameDuration="${t(1)}" width="${project.width}" height="${project.height}" colorSpace="${seqSrc ? fcpColour(seqSrc) : "1-1-1 (Rec. 709)"}"/>`);
  out.push(...formats);
  for (const a of assets.values()) {
    const still = a.media.kind === "image";
    if (a.src) {
      const { st } = a.src;
      out.push(`    <asset id="${a.id}" name="${esc(a.media.path.split("/").pop())}" start="${fcpTime(st.start, st.sfi)}" ` +
               `duration="${fcpTime(a.src.frames, st.sfi)}" hasVideo="1" format="${a.src.fid}" videoSources="1">`);
      out.push(`      <media-rep kind="original-media" src="${esc(a.media.url)}"/>`);
      out.push("    </asset>");
      continue;
    }
    out.push(`    <asset id="${a.id}" name="${esc(a.shot.name)}" start="0s" duration="${still ? "0s" : t(a.shot.frames)}" ` +
             `hasVideo="1" format="r1" videoSources="1">`);
    out.push(`      <media-rep kind="original-media" src="${esc(a.media.url)}"/>`);
    out.push("    </asset>");
  }
  for (const a of audioAssets.values()) {
    out.push(`    <asset id="${a.id}" name="${esc(a.name)}" start="0s" duration="${t(a.frames)}" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">`);
    out.push(`      <media-rep kind="original-media" src="${esc(a.url)}"/>`);
    out.push("    </asset>");
  }
  if (dissolveId) out.push(`    <effect id="${dissolveId}" name="Cross Dissolve" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/>`);
  if (titleId) out.push(`    <effect id="${titleId}" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`);
  out.push("  </resources>", "  <library>", `    <event name="${esc(project.name)}">`, `      <project name="${esc(project.name)}">`);
  const start = recordStart(fi.base);
  out.push(`        <sequence format="r1" duration="${t(seqLen)}" tcStart="${t(start)}" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`);
  out.push("          <spine>");

  // Spine items with the record range they cover and the local time their children are measured in.
  // local(d): the time d sequence frames into an item, in that item's own clock (a camera original runs on its
  // timecode and rate).
  const items = rows.map((r) => {
    const src = assets.get(r.shot.id).src;
    const local = src ? (d) => fcpSum(src.st.start + src.st.map(r.in), src.st.sfi, d, fi) : (d) => t(r.in + d);
    return { row: r, recIn: r.recIn, recOut: r.recOut, local };
  });
  if (seqLen > total) items.push({ gap: true, recIn: total, recOut: seqLen, local: (d) => t(d) });
  const anchored = items.map(() => []);
  lanes.forEach((lane, k) => {
    for (const a of lane.clips) {
      let i = items.findIndex((it) => a.start_frame >= it.recIn && a.start_frame < it.recOut);
      if (i < 0) i = items.length - 1;
      anchored[i].push({ a, lane: k + 1 });
    }
  });
  const titleAnchors = items.map(() => []);
  for (const tt of titles) {
    let i = items.findIndex((it) => tt.start_frame >= it.recIn && tt.start_frame < it.recOut);
    if (i < 0) i = items.length - 1;
    titleAnchors[i].push(tt);
  }
  let tsN = 0;
  const titleXml = (tt, it) => {
    const id = `ts${++tsN}`, size = tt.style === "lower" ? 48 : 72;
    return [`              <title ref="${titleId}" lane="1" offset="${it.local(tt.start_frame - it.recIn)}" name="${esc(tt.text.slice(0, 60))}" start="0s" duration="${t(tt.frames)}">`,
            `                <text><text-style ref="${id}">${esc(tt.text)}</text-style></text>`,
            `                <text-style-def id="${id}"><text-style font="Helvetica" fontSize="${size}" fontColor="1 1 1 1" alignment="center"/></text-style-def>`,
            "              </title>"];
  };
  const transXml = (sp) => [`            <transition name="${{ dissolve: "Cross Dissolve", dip_black: "Dip to Black", dip_white: "Dip to White", wipe: "Wipe" }[sp.type]}" ` +
    `offset="${t(start + sp.at - sp.pre)}" duration="${t(sp.frames)}">`, `              <filter-video ref="${dissolveId}" name="Cross Dissolve"/>`, "            </transition>"];
  const audioXml = ({ a, lane }, it) => {
    const asset = audioAssets.get(audioMedia(a, mediaRoot).url);
    const attrs = `ref="${asset.id}" lane="-${lane}" offset="${it.local(a.start_frame - it.recIn)}" name="${esc(a.label)}" ` +
                  `start="${t(a.in)}" duration="${t(audioLen(a))}" audioRole="effects"` + (audible(project, a.track) ? "" : ' enabled="0"');
    const lk = mergedLevelKeys(a);
    if (!a.gain_db && !a.fade_in && !a.fade_out && !lk) return [`              <asset-clip ${attrs}/>`];
    const x = [`              <asset-clip ${attrs}>`];
    if (a.fade_in || a.fade_out || lk) {
      x.push(`                <adjust-volume amount="${a.gain_db.toFixed(1)}dB">`, '                  <param name="amount">');
      if (a.fade_in) x.push(`                    <fadeIn type="easeIn" duration="${t(a.fade_in)}"/>`);
      if (a.fade_out) x.push(`                    <fadeOut type="easeIn" duration="${t(a.fade_out)}"/>`);
      if (lk) {
        x.push("                    <keyframeAnimation>");
        for (const [f, db] of lk) x.push(`                      <keyframe time="${t(a.in + f)}" value="${(a.gain_db + db).toFixed(1)}dB"/>`);
        x.push("                    </keyframeAnimation>");
      }
      x.push("                  </param>", "                </adjust-volume>");
    } else x.push(`                <adjust-volume amount="${a.gain_db.toFixed(1)}dB"/>`);
    x.push("              </asset-clip>");
    return x;
  };

  items.forEach((it, i) => {
    const inner = [];
    if (it.gap) {
      if (spans.tail && i === items.length - 1) out.push(...transXml(spans.tail));
      for (const c of anchored[i]) inner.push(...audioXml(c, it));
      for (const tt of titleAnchors[i]) inner.push(...titleXml(tt, it));
      const open = `<gap name="Gap" offset="${t(start + it.recIn)}" duration="${t(it.recOut - it.recIn)}"`;
      if (!inner.length) out.push(`            ${open}/>`);
      else out.push(`            ${open}>`, ...inner, "            </gap>");
      return;
    }
    const row = it.row;
    const a = assets.get(row.shot.id);
    const still = a.media.kind === "image";
    const timing = `offset="${t(start + row.recIn)}" name="${esc(row.shot.name)}" start="${it.local(0)}" duration="${t(row.len)}"`;
    const note = relinkNote(a.media);
    if (note) inner.push(`              <note>${esc(note)}</note>`);
    if (row.event.opacity) {
      inner.push('              <adjust-blend amount="1">', '                <param name="amount">', "                  <keyframeAnimation>",
        ...row.event.opacity.map(([f, v]) => `                    <keyframe time="${it.local(f)}" value="${v.toFixed(2)}"/>`),
        "                  </keyframeAnimation>", "                </param>", "              </adjust-blend>");
    }
    // A still sits in a <clip> holding a <video>: the form every FCPXML reader accepts.
    if (still) inner.push(`              <video ref="${a.id}" offset="${t(row.in)}" duration="${t(row.len)}"/>`);
    for (const c of anchored[i]) inner.push(...audioXml(c, it));
    for (const tt of titleAnchors[i]) inner.push(...titleXml(tt, it));
    if (spans[row.index]) out.push(...transXml(spans[row.index]));
    for (const n of noteItems(row)) inner.push(`              <marker start="${it.local(n.src - row.in)}" duration="${t(1)}" value="${esc(n.text)}"/>`);
    const open = still ? `<clip ${timing} format="r1" tcFormat="NDF"` : `<asset-clip ref="${a.id}" ${timing} tcFormat="NDF"`;
    if (!inner.length) out.push(`            ${open}/>`);
    else out.push(`            ${open}>`, ...inner, `            </${still ? "clip" : "asset-clip"}>`);
    if (spans.tail && row.index === rows.length - 1 && !items[i + 1]) out.push(...transXml(spans.tail));
  });
  out.push("          </spine>", "        </sequence>", "      </project>", "    </event>", "  </library>", "</fcpxml>", "");
  return out.join("\n");
}

// ---------------------------------------------------------------- FCP7 XML (xmeml v5) for Premiere Pro

/** Final Cut Pro 7 XML (xmeml v5), which Premiere Pro imports natively. V1 + one audio track per lane. */
export function toXMEML(input, { mediaRoot = "" } = {}) {
  const project = normalizeProject(input);
  const fi = fpsInfo(project.fps);
  const start = recordStart(fi.base);
  const rate = (ind, f = fi) => [`${ind}<rate>`, `${ind}  <timebase>${f.base}</timebase>`, `${ind}  <ntsc>${f.den === 1001 ? "TRUE" : "FALSE"}</ntsc>`, `${ind}</rate>`];
  const tcBlock = (ind, frames, f = fi, reel = "") => [`${ind}<timecode>`, ...rate(ind + "  ", f), `${ind}  <string>${framesToTC(frames, f.base)}</string>`,
                                    `${ind}  <frame>${frames}</frame>`, `${ind}  <displayformat>NDF</displayformat>`,
                                    ...(reel ? [`${ind}  <reel>`, `${ind}    <name>${esc(reel)}</name>`, `${ind}  </reel>`] : []), `${ind}</timecode>`];
  const pathurl = (p) => (p.startsWith("/") ? "file://localhost" + encodeURI(p) : encodeURI(p));
  const files = new Map(); // path -> id
  let fileN = 0, clipN = 0;
  // src: a camera original, described at its own size, rate, timecode and reel.
  const fileXml = (ind, path, frames, kind, src = null) => {
    if (files.has(path)) return [`${ind}<file id="${files.get(path)}"/>`];
    const id = `file-${++fileN}`;
    files.set(path, id);
    const f = src ? src.st.sfi : fi;
    const w = src ? src.s.width || project.width : project.width, h = src ? src.s.height || project.height : project.height;
    const media = kind === "audio"
      ? [`${ind}    <audio>`, `${ind}      <samplecharacteristics>`, `${ind}        <depth>24</depth>`, `${ind}        <samplerate>48000</samplerate>`,
         `${ind}      </samplecharacteristics>`, `${ind}      <channelcount>2</channelcount>`, `${ind}    </audio>`]
      : [`${ind}    <video>`, `${ind}      <samplecharacteristics>`, ...rate(`${ind}        `, f), `${ind}        <width>${w}</width>`,
         `${ind}        <height>${h}</height>`, `${ind}        <pixelaspectratio>square</pixelaspectratio>`,
         `${ind}      </samplecharacteristics>`, `${ind}    </video>`];
    return [`${ind}<file id="${id}">`, `${ind}  <name>${esc(path.split("/").pop())}</name>`, `${ind}  <pathurl>${esc(pathurl(path))}</pathurl>`,
            ...rate(ind + "  ", f), `${ind}  <duration>${frames}</duration>`, ...tcBlock(ind + "  ", src ? src.st.start : 0, f, src ? sourceReel(src.s, 32) : ""),
            `${ind}  <media>`, ...media, `${ind}  </media>`, `${ind}</file>`];
  };

  const seqLen = sequenceFrames(project);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE xmeml>", '<xmeml version="5">', '  <sequence id="sequence-1">',
               `    <name>${esc(project.name)}</name>`, `    <duration>${seqLen}</duration>`, ...rate("    "), ...tcBlock("    ", start),
               "    <media>", "      <video>", "        <format>", "          <samplecharacteristics>", ...rate("            "),
               `            <width>${project.width}</width>`, `            <height>${project.height}</height>`,
               "            <pixelaspectratio>square</pixelaspectratio>", "          </samplecharacteristics>", "        </format>", "        <track>"];
  const I = "            ";
  // Milestone 19: video transitions as transitionitems across the cut (Cross Dissolve, Dip to Color Dissolve, Edge
  // Wipe; the head fade "start-black", the tail "end-black"), opacity keys as the Opacity filter, titles on V2.
  const spans = transSpans(project);
  const XM_FX = { dissolve: ["Cross Dissolve", "Dissolve"], dip_black: ["Dip to Color Dissolve", "Dissolve"], dip_white: ["Dip to Color Dissolve", "Dissolve"],
                  wipe: ["Edge Wipe", "Wipe"] };
  const vTrans = (sp) => {
    const [name, cat] = XM_FX[sp.type];
    const align = sp.head ? "start-black" : sp.tail ? "end-black" : sp.pre === sp.post ? "center" : sp.pre === 0 ? "start" : sp.post === 0 ? "end" : "center";
    const x = ["          <transitionitem>", `${I}<start>${sp.at - sp.pre}</start>`, `${I}<end>${sp.at + sp.post}</end>`, `${I}<alignment>${align}</alignment>`,
               ...rate(I), `${I}<effect>`, `${I}  <name>${name}</name>`, `${I}  <effectid>${name}</effectid>`, `${I}  <effectcategory>${cat}</effectcategory>`,
               `${I}  <effecttype>transition</effecttype>`, `${I}  <mediatype>video</mediatype>`];
    if (sp.type === "dip_white" || sp.type === "dip_black") {
      const c = sp.type === "dip_white" ? 255 : 0;
      x.push(`${I}  <parameter>`, `${I}    <parameterid>color</parameterid>`, `${I}    <name>Color</name>`, `${I}    <value>`,
             `${I}      <alpha>255</alpha>`, `${I}      <red>${c}</red>`, `${I}      <green>${c}</green>`, `${I}      <blue>${c}</blue>`, `${I}    </value>`, `${I}  </parameter>`);
    }
    x.push(`${I}</effect>`, "          </transitionitem>");
    return x;
  };
  for (const row of layout(project)) {
    if (spans[row.index]) out.push(...vTrans(spans[row.index]));
    const m = mediaFor(row.shot, mediaRoot);
    const s = row.shot.source;
    if (m.rung === "source") {
      // The camera original: its own rate, timecode and reel; in/out count from its first frame.
      const st = sourceTiming(s, project), frames = Math.max(s.frames, st.map(row.shot.frames));
      out.push(`          <clipitem id="clipitem-${++clipN}">`, `${I}<name>${esc(row.shot.name)}</name>`, `${I}<enabled>TRUE</enabled>`,
               `${I}<duration>${frames}</duration>`, ...rate(I, st.sfi), `${I}<start>${row.recIn}</start>`, `${I}<end>${row.recOut}</end>`,
               `${I}<in>${st.map(row.in)}</in>`, `${I}<out>${st.map(row.out)}</out>`, ...fileXml(I, m.path, frames, "video", { s, st }));
    } else {
      out.push(`          <clipitem id="clipitem-${++clipN}">`, `${I}<name>${esc(row.shot.name)}</name>`, `${I}<enabled>TRUE</enabled>`,
               `${I}<duration>${row.shot.frames}</duration>`, ...rate(I), `${I}<start>${row.recIn}</start>`, `${I}<end>${row.recOut}</end>`,
               `${I}<in>${row.in}</in>`, `${I}<out>${row.out}</out>`, ...fileXml(I, m.path, row.shot.frames, "video"));
    }
    const said = [relinkNote(m), ...(s ? sourceNotes(s, project) : []),
                  ...(s && m.rung !== "source" ? [`plate: ${s.path} (reel ${sourceReel(s, 32)})`] : [])].filter(Boolean);
    if (said.length) out.push(`${I}<comments>`, ...said.slice(0, 4).map((c, k) => `${I}  <mastercomment${k + 1}>${esc(c)}</mastercomment${k + 1}>`), `${I}</comments>`);
    for (const n of noteItems(row)) {
      out.push(`${I}<marker>`, `${I}  <comment>${esc(n.text)}</comment>`, `${I}  <name>${esc(n.text.slice(0, 60))}</name>`,
               `${I}  <in>${n.src}</in>`, `${I}  <out>-1</out>`, `${I}</marker>`);
    }
    if (row.event.opacity) {
      out.push(`${I}<filter>`, `${I}  <effect>`, `${I}    <name>Opacity</name>`, `${I}    <effectid>opacity</effectid>`, `${I}    <effectcategory>motion</effectcategory>`,
               `${I}    <effecttype>motion</effecttype>`, `${I}    <mediatype>video</mediatype>`, `${I}    <parameter>`, `${I}      <parameterid>opacity</parameterid>`,
               `${I}      <name>Opacity</name>`, `${I}      <valuemin>0</valuemin>`, `${I}      <valuemax>100</valuemax>`, `${I}      <value>100</value>`,
               ...row.event.opacity.flatMap(([f, v]) => [`${I}      <keyframe>`, `${I}        <when>${row.in + f}</when>`, `${I}        <value>${(v * 100).toFixed(1)}</value>`, `${I}      </keyframe>`]),
               `${I}    </parameter>`, `${I}  </effect>`, `${I}</filter>`);
    }
    out.push("          </clipitem>");
  }
  if (spans.tail) out.push(...vTrans(spans.tail));
  out.push("        </track>");
  if ((project.titles || []).length) {
    out.push("        <track>");
    let pos = 0, gN = 0;
    for (const tt of [...project.titles].sort((x, y) => x.start_frame - y.start_frame)) {
      if (tt.start_frame < pos) continue;
      out.push(`          <generatoritem id="title-${++gN}">`, `${I}<name>${esc(tt.text.slice(0, 60))}</name>`, `${I}<enabled>TRUE</enabled>`,
               `${I}<duration>${tt.frames}</duration>`, ...rate(I), `${I}<start>${tt.start_frame}</start>`, `${I}<end>${tt.start_frame + tt.frames}</end>`,
               `${I}<in>0</in>`, `${I}<out>${tt.frames}</out>`, `${I}<effect>`, `${I}  <name>Text</name>`, `${I}  <effectid>Text</effectid>`,
               `${I}  <effectcategory>Text</effectcategory>`, `${I}  <effecttype>generator</effecttype>`, `${I}  <mediatype>video</mediatype>`,
               `${I}  <parameter>`, `${I}    <parameterid>str</parameterid>`, `${I}    <name>Text</name>`, `${I}    <value>${esc(tt.text)}</value>`, `${I}  </parameter>`,
               `${I}</effect>`, "          </generatoritem>");
      pos = tt.start_frame + tt.frames;
    }
    out.push("        </track>");
  }
  out.push("      </video>", "      <audio>", "        <format>", "          <samplecharacteristics>",
           "            <depth>24</depth>", "            <samplerate>48000</samplerate>", "          </samplecharacteristics>", "        </format>");
  for (const lane of audioLanes(project)) {
    out.push("        <track>");
    for (const a of lane.clips) {
      const p = audioMedia(a, mediaRoot).path;
      const s = a.start_frame, e = a.start_frame + audioLen(a);
      out.push(`          <clipitem id="clipitem-${++clipN}">`, `${I}<name>${esc(a.label)}</name>`,
               `${I}<enabled>${audible(project, a.track) ? "TRUE" : "FALSE"}</enabled>`, `${I}<duration>${audioSrcFrames(a)}</duration>`, ...rate(I),
               `${I}<start>${s}</start>`, `${I}<end>${e}</end>`, `${I}<in>${a.in}</in>`, `${I}<out>${a.out}</out>`,
               ...fileXml(I, p, audioSrcFrames(a), "audio"),
               `${I}<sourcetrack>`, `${I}  <mediatype>audio</mediatype>`, `${I}  <trackindex>1</trackindex>`, `${I}</sourcetrack>`);
      const lk = mergedLevelKeys(a);
      if (a.gain_db || lk) {
        out.push(`${I}<filter>`, `${I}  <effect>`, `${I}    <name>Audio Levels</name>`, `${I}    <effectid>audiolevels</effectid>`,
                 `${I}    <effectcategory>audiolevels</effectcategory>`, `${I}    <effecttype>audiolevels</effecttype>`,
                 `${I}    <mediatype>audio</mediatype>`, `${I}    <parameter>`, `${I}      <parameterid>level</parameterid>`,
                 `${I}      <name>Level</name>`, `${I}      <valuemin>0</valuemin>`, `${I}      <valuemax>3.98109</valuemax>`,
                 `${I}      <value>${Math.pow(10, a.gain_db / 20).toFixed(6)}</value>`,
                 ...(lk || []).flatMap(([f, db]) => [`${I}      <keyframe>`, `${I}        <when>${a.in + f}</when>`,
                   `${I}        <value>${Math.pow(10, (a.gain_db + db) / 20).toFixed(6)}</value>`, `${I}      </keyframe>`]),
                 `${I}    </parameter>`, `${I}  </effect>`, `${I}</filter>`);
      }
      out.push("          </clipitem>");
      for (const [len, at, align] of [[a.fade_in, s, "start"], [a.fade_out, e - a.fade_out, "end"]]) {
        if (!len) continue;
        out.push("          <transitionitem>", `${I}<start>${at}</start>`, `${I}<end>${at + len}</end>`, `${I}<alignment>${align}</alignment>`,
                 ...rate(I), `${I}<effect>`, `${I}  <name>Cross Fade (+3dB)</name>`, `${I}  <effectid>KGAudioTransCrossFade3dB</effectid>`,
                 `${I}  <effecttype>transition</effecttype>`, `${I}  <mediatype>audio</mediatype>`, `${I}</effect>`, "          </transitionitem>");
      }
    }
    out.push("        </track>");
  }
  out.push("      </audio>", "    </media>", "  </sequence>", "</xmeml>", "");
  return out.join("\n");
}

// ---------------------------------------------------------------- relink list

/** RELINK.txt: every shot in the cut that is not on its Final yet, and what stands in for it. */
export function toRelinkList(input, { mediaRoot = "" } = {}) {
  const project = normalizeProject(input);
  const lines = [`Soundstage relink list: ${oneLine(project.name)}`,
                 "Clips cut from stand-ins. Render the Final, then relink by clip name.", "",
                 ["CLIP", "RUNG", "MEDIA", "TODO"].join("\t")];
  const seen = new Set();
  for (const row of layout(project)) {
    if (seen.has(row.shot.id)) continue;
    seen.add(row.shot.id);
    const m = mediaFor(row.shot, mediaRoot);
    if (m.rung === "final" || (m.rung === "source" && !relinkNote(m))) continue;
    lines.push([row.shot.name, m.offline ? "clay (offline)" : m.rung === "source" ? "camera original" : m.rung, m.path, relinkNote(m)].join("\t"));
  }
  if (lines.length === 4) lines.push("(none: every clip is on its Final)");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- all at once

export const safeName = (s) => String(s || "cut").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "cut";

/**
 * Every text export, keyed by file name: <name>.edl (Avid; Premiere and Resolve read it too),
 * <name>_avid_locators.txt (Avid markers), <name>_premiere.xml (Premiere), <name>.fcpxml (Resolve,
 * Final Cut), <name>.otio (Resolve, OTIO tools) and RELINK.txt.
 */
export function exportAll(project, opts = {}) {
  const base = safeName(normalizeProject(project).name);
  return {
    [`${base}.edl`]: toEDL(project, opts),
    [`${base}_avid_locators.txt`]: toAvidLocators(project, opts),
    [`${base}_premiere.xml`]: toXMEML(project, opts),
    [`${base}.fcpxml`]: toFCPXML(project, opts),
    [`${base}.otio`]: JSON.stringify(toOTIO(project, opts), null, 2) + "\n",
    "RELINK.txt": toRelinkList(project, opts),
    ...subtitleFiles(project, base),
  };
}

/** <name>.srt and <name>.vtt when the cut has subtitles (Milestone 19). */
function subtitleFiles(project, base) {
  const p = normalizeProject(project);
  if (!(p.subtitles || []).length) return {};
  return { [`${base}.srt`]: toSRT(p), [`${base}.vtt`]: toVTT(p) };
}
