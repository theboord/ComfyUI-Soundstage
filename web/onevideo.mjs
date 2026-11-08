// Cut → one video: what the one-video join (POST /soundstage/cut/render_video, soundstage/cut/assemble.py) can and
// can't honour, decided on the RAW saved cut before anything is flattened. Pure, no DOM; tests in
// tests/js/onevideo.test.mjs. docs/cut.md "Cut → one video".
//
// The rule set is pluggable: when the Cut (web/cut/*) exports a pure oneVideoSupport(rawCut) -> {ok, reasons}, the App
// calls it (the Cut knows its own fields best); otherwise localOneVideoSupport below, the same shape, is used.
// reasons: [{code, count?, text}], text a short noun phrase ("gaps (2)", "an upper picture track").
// The one-video join itself handles gaps (black picture + silence of the gap's exact length), so a cut whose only
// reasons are "gaps" is joined, not refused; anything else is refused in plain words and nothing changes.

export const HOOK_NAME = "oneVideoSupport";
export const GAP_CODE = "gaps";
const SHOT_KINDS = new Set([undefined, null, "", "shot", "clip"]);

const plural = (n, one, many) => (n === 1 ? one : many);

/** Frames a gap entry lasts: its frames / length / duration field, else out - in. NaN when unusable. */
export function gapFrames(e) {
  for (const k of ["frames", "length", "duration"]) {
    const v = Number(e?.[k]);
    if (e?.[k] != null && Number.isFinite(v)) return Math.round(v);
  }
  const a = Number(e?.in ?? 0), b = Number(e?.out);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round(b - a) : NaN;
}

const isGap = (e) => e && typeof e === "object" && (e.kind === "gap" || e.type === "gap" || e.gap === true);

/** Tracks with at least one clip in them: an array of clips, or {clips|events|items: [...]}. */
function countPictureTracks(raw) {
  const nonEmpty = (t) => {
    if (Array.isArray(t)) return t.some((x) => x != null);
    if (t && typeof t === "object") return ["clips", "events", "items", "cut"].some((k) => Array.isArray(t[k]) && t[k].some((x) => x != null));
    return false;
  };
  let n = 0;
  if (nonEmpty(raw?.video)) n += 1;
  if (Array.isArray(raw?.video_tracks)) n += raw.video_tracks.filter(nonEmpty).length;
  else if (raw?.video_tracks && typeof raw.video_tracks === "object") n += Object.values(raw.video_tracks).filter(nonEmpty).length;
  return n;
}

/** The local rule set (used until the Cut exports its own oneVideoSupport). Never throws. */
export function localOneVideoSupport(raw) {
  const cut = Array.isArray(raw) ? raw : Array.isArray(raw?.cut) ? raw.cut : [];
  const reasons = [];
  let gaps = 0, badGaps = 0, detached = 0, noShot = 0;
  const kinds = new Map();
  for (const e of cut) {
    if (e == null || typeof e !== "object") continue;   // a null slot was always skipped; keep that
    if (isGap(e)) {
      const f = gapFrames(e);
      if (Number.isFinite(f) && f >= 1) gaps += 1;
      else if (!(Number.isFinite(f) && f === 0)) badGaps += 1;   // a zero-length gap is no gap at all
      continue;
    }
    if (!SHOT_KINDS.has(e.kind)) { kinds.set(String(e.kind), (kinds.get(String(e.kind)) || 0) + 1); continue; }
    if (!e.shot_id) { noShot += 1; continue; }
    if (e.audio_detached != null && e.audio_detached !== false) detached += 1;
  }
  const tracks = countPictureTracks(raw);
  if (gaps) reasons.push({ code: GAP_CODE, count: gaps, text: `gaps (${gaps})` });
  if (badGaps) reasons.push({ code: "bad_gap", count: badGaps, text: `${badGaps} ${plural(badGaps, "gap", "gaps")} with no length` });
  if (tracks) reasons.push({ code: "upper_video", count: tracks, text: tracks === 1 ? "an upper picture track" : `${tracks} upper picture tracks` });
  if (detached) reasons.push({ code: "audio_detached", count: detached, text: `detached audio on ${detached} ${plural(detached, "clip", "clips")}` });
  for (const [k, n] of kinds) reasons.push({ code: "unknown_kind", count: n, text: `${n} ${plural(n, "clip", "clips")} of a kind it doesn't know ("${k.slice(0, 24)}")` });
  if (noShot) reasons.push({ code: "no_shot", count: noShot, text: `${noShot} ${plural(noShot, "clip", "clips")} with no shot` });
  return { ok: reasons.length === 0, reasons };
}

/** A hook's answer in the shape we use, or null when it is unusable. Strings are accepted as reasons. */
function normalizeAnswer(ans) {
  if (!ans || typeof ans !== "object" || typeof ans.ok !== "boolean") return null;
  const reasons = (Array.isArray(ans.reasons) ? ans.reasons : []).map((r) => {
    if (typeof r === "string") return { code: /\bgap/i.test(r) && !/no length/i.test(r) ? GAP_CODE : "other", text: r };
    if (r && typeof r === "object") return { code: String(r.code || "other"), count: r.count, text: String(r.text || r.message || r.code || "something") };
    return null;
  }).filter(Boolean);
  if (!ans.ok && !reasons.length) reasons.push({ code: "other", text: "something it can't include" });
  return { ok: ans.ok, reasons };
}

/** "a, b and c". */
const listing = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * Decide on the raw cut. hook: the Cut's oneVideoSupport when it exports one (a throw or a malformed answer falls
 * back to the local rules). Returns {ok, gapsOnly, reasons, source: "cut"|"local", message}; message is "" when the
 * join can go ahead (ok, or gaps only).
 */
export function checkOneVideo(raw, hook = null) {
  let res = null, source = "local";
  if (typeof hook === "function") {
    try { res = normalizeAnswer(hook(raw)); if (res) source = "cut"; } catch { res = null; }
  }
  if (!res) res = localOneVideoSupport(raw);
  const gapsOnly = !res.ok && res.reasons.length > 0 && res.reasons.every((r) => r.code === GAP_CODE);
  const message = res.ok || gapsOnly ? ""
    : `This cut has ${listing(res.reasons.map((r) => r.text))}; one-video export can't include ${res.reasons.length === 1 && res.reasons[0].count === 1 ? "it" : "them"} yet.`;
  return { ok: res.ok, gapsOnly, reasons: res.reasons, source, message };
}

/** The first oneVideoSupport function exported by any of the given module namespaces, else null. */
export function findHook(...namespaces) {
  for (const ns of namespaces) {
    try { if (ns && typeof ns[HOOK_NAME] === "function") return ns[HOOK_NAME]; } catch { /* a getter that throws */ }
  }
  return null;
}

/**
 * The clips the server joins, in cut order, from the RAW cut: shots as before ({shot_id, name, in, out, file, kind}),
 * gaps as {gap: true, frames, in: 0, out: frames}. shotFile(e) -> {file, kind} (flattenClip with the saved renders).
 * Only call it after checkOneVideo said ok or gapsOnly.
 */
export function oneVideoClips(raw, { shotFile, shotName = (id) => id } = {}) {
  const cut = Array.isArray(raw) ? raw : Array.isArray(raw?.cut) ? raw.cut : [];
  const out = [];
  for (const e of cut) {
    if (e == null || typeof e !== "object") continue;
    if (isGap(e)) {
      const f = gapFrames(e);
      if (Number.isFinite(f) && f >= 1) out.push({ gap: true, frames: f, in: 0, out: f });
      continue;
    }
    if (!e.shot_id) continue;
    out.push({ shot_id: e.shot_id, name: shotName(e.shot_id), in: e.in, out: e.out, ...(shotFile ? shotFile(e) : {}) });
  }
  return out;
}

/** Things today's cut carries that the one-video join leaves out (it never had them; the Cut's Render has). */
export function leftOut(raw) {
  const cut = Array.isArray(raw?.cut) ? raw.cut : [];
  const out = [];
  const trans = cut.filter((e) => e && e.trans).length;
  if (trans) out.push(`${trans} ${plural(trans, "transition", "transitions")}`);
  if (Array.isArray(raw?.titles) && raw.titles.length) out.push("titles");
  if (Array.isArray(raw?.graphics) && raw.graphics.length) out.push("graphics");
  if (Array.isArray(raw?.audio) && raw.audio.length) out.push("the sound tracks");
  return out;
}
