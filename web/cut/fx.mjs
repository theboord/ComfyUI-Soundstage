// Soundstage Cut, Milestone 19: transitions and fades, clip keyframes, auto-duck, loudness, beat snapping, the
// assembly from the ScriptSync lining, and subtitles from the typed dialogue. Pure functions, no DOM: the panel
// (cut.mjs), the exporters, the tests and the director (web/agent) all call these. soundstage/cut/render.py uses
// the same rules when it renders the cut to one file.

import { audible, audioLen, clamp, keyAt, layout, normalizeProject, normalizeSubtitles, sequenceFrames, shotMap, totalFrames,
         trackName } from "./timeline.mjs";
import { coverageFor, setupKind, shotCharacter, syncSegments } from "../dailies/model.mjs";

// ---------------------------------------------------------------- transitions

/** Default lengths (frames at 24 fps; scaled by the rate) for the palette. */
export const DEFAULT_TRANS_FRAMES = { dissolve: 12, dip_black: 24, dip_white: 24, wipe: 12 };

export const isOverlap = (type) => type === "dissolve" || type === "wipe";

/**
 * Where each transition really sits, handles allowed for: spans[k] for the edit into event k (k = 0 is the head:
 * a fade up), plus spans.tail for the fade at the end.
 *   {type, req, frames, pre, post, at, limited}
 * at = the record frame of the cut; the transition covers record [at - pre, at + post).
 * A dissolve or wipe overlaps the clips, so it needs handles: the outgoing clip runs `post` frames past its out
 * point (its shot must have them) and the incoming one starts `pre` frames before its in point. It is centred on
 * the cut when both sides have room, shifted when one side is short, and shortened when neither has enough
 * (limited: true). A dip fades the outgoing clip's own last frames to the colour and the incoming clip's first
 * frames up from it, so it needs no handles. No side takes more than half its clip, so transitions never overlap.
 */
export function transSpans(input) {
  const project = normalizeProject(input);
  const rows = layout(project);
  const spans = rows.map(() => null);
  const half = (r) => Math.floor(r.len / 2);
  rows.forEach((b, k) => {
    const tr = b.event.trans;
    if (!tr) return;
    if (k === 0) {
      const post = Math.min(tr.frames, Math.max(1, half(b)));
      spans[0] = { type: tr.type === "dip_white" ? "dip_white" : "dip_black", req: tr.frames, frames: post, pre: 0, post, at: 0,
                   limited: post < tr.frames, head: true };
      return;
    }
    const a = rows[k - 1];
    const N = tr.frames;
    let pre, post;
    if (isOverlap(tr.type)) {
      const hA = a.shot.frames - a.out, hB = b.in;
      const maxPost = Math.min(hA, half(b)), maxPre = Math.min(hB, half(a));
      pre = Math.min(Math.floor(N / 2), maxPre);
      post = Math.min(N - pre, maxPost);
      pre = Math.min(N - post, maxPre);
    } else {
      pre = Math.min(Math.floor(N / 2), half(a));
      post = Math.min(N - Math.floor(N / 2), half(b));
    }
    if (pre + post <= 0) return;
    spans[k] = { type: tr.type, req: N, frames: pre + post, pre, post, at: b.recIn, limited: pre + post < N };
  });
  const fo = project.fade_out;
  if (fo && rows.length) {
    const last = rows[rows.length - 1];
    const pre = Math.min(fo.frames, Math.max(1, half(last)));
    spans.tail = { type: fo.type, req: fo.frames, frames: pre, pre, post: 0, at: last.recOut, limited: pre < fo.frames, tail: true };
  } else spans.tail = null;
  return spans;
}

/** Handles a shot has at an edit: {out: frames after the outgoing clip's out point, in: frames before the incoming in}. */
export function handlesAt(project, k) {
  const rows = layout(normalizeProject(project));
  if (k <= 0 || k >= rows.length) return { out: 0, in: 0 };
  return { out: rows[k - 1].shot.frames - rows[k - 1].out, in: rows[k].in };
}

/**
 * What the picture is at record frame f, after transitions and clip opacity:
 *   {row, src, alpha, b?: {row, src}, mix (0..1, b's share), wipe (bool), dip: {color, amount}} or null past the end.
 * src may sit in a handle (outside [in, out)) during a dissolve. alpha is the clip opacity keyframe (over black).
 */
export function pictureAt(project, f, spans = transSpans(project)) {
  const rows = layout(project);
  const row = rows.find((r) => f >= r.recIn && f < r.recOut);
  if (!row) return null;
  const out = { row, src: row.in + (f - row.recIn), alpha: keyAt(row.event.opacity, f - row.recIn, 1), b: null, mix: 0, wipe: false,
                dip: null };
  const k = row.index;
  const into = spans[k], next = spans[k + 1];
  const colour = (t) => (t === "dip_white" ? "white" : "black");
  if (into && f < into.at + into.post) {
    const t = (f - (into.at - into.pre) + 0.5) / into.frames;
    if (into.head) out.dip = { color: colour(into.type), amount: 1 - (f + 0.5) / into.post };
    else if (isOverlap(into.type)) {
      const a = rows[k - 1];
      // We are on the incoming side: the outgoing clip keeps running into its handle underneath.
      out.b = { row, src: out.src };
      out.row = a; out.src = a.in + (f - a.recIn); out.mix = t; out.wipe = into.type === "wipe";
      out.alpha = keyAt(a.event.opacity, Math.min(f - a.recIn, a.len - 1), 1) * (1 - t) + out.alpha * t;
    } else out.dip = { color: colour(into.type), amount: 1 - (f - into.at + 0.5) / into.post };
  } else if (next && !next.head && f >= next.at - next.pre) {
    const t = (f - (next.at - next.pre) + 0.5) / next.frames;
    if (isOverlap(next.type)) {
      const b = rows[k + 1];
      out.b = { row: b, src: b.in + (f - b.recIn) };
      out.mix = t; out.wipe = next.type === "wipe";
    } else out.dip = { color: colour(next.type), amount: (f - (next.at - next.pre) + 0.5) / next.pre };
  }
  const tail = spans.tail;
  if (tail && f >= tail.at - tail.pre) {
    const amt = (f - (tail.at - tail.pre) + 0.5) / tail.pre;
    if (!out.dip || amt > out.dip.amount) out.dip = { color: colour(tail.type), amount: amt };
  }
  if (out.dip) out.dip.amount = clamp(out.dip.amount, 0, 1);
  out.mix = clamp(out.mix, 0, 1);
  return out;
}

// ---------------------------------------------------------------- audio level: gain, fades, keys, duck

const dbToAmp = (db) => Math.pow(10, db / 20);

/** dB offset of a clip's keys + duck at clip-local frame f. */
export const keysDb = (a, f) => keyAt(a.keys, f, 0) + keyAt(a.duck, f, 0);

/** Linear gain of an audio clip at clip-local frame f (fractional ok): gain_db + keys + duck, times the fades. */
export function clipGainAt(a, f) {
  const len = audioLen(a);
  const fade = Math.max(0, Math.min(1, a.fade_in ? f / a.fade_in : 1, a.fade_out ? (len - f) / a.fade_out : 1));
  return dbToAmp(a.gain_db + keysDb(a, f)) * fade;
}

/** Every frame where the level curve bends: 0, fade corners, each key, the end. */
export function levelBreakpoints(a) {
  const len = audioLen(a);
  const pts = new Set([0, len, a.fade_in, len - a.fade_out]);
  for (const k of [...(a.keys || []), ...(a.duck || [])]) pts.add(k[0]);
  return [...pts].filter((f) => f >= 0 && f <= len).sort((x, y) => x - y);
}

/**
 * The keys + duck merged into one dB curve [[f, db], ...] (exact: both are piecewise linear in dB), for the exports.
 * null when the clip has neither.
 */
export function mergedLevelKeys(a) {
  if (!a.keys && !a.duck) return null;
  const pts = new Set([...(a.keys || []), ...(a.duck || [])].map((k) => k[0]));
  return [...pts].sort((x, y) => x - y).map((f) => [f, Math.round(keysDb(a, f) * 10) / 10]);
}

export const DUCK_DEFAULTS = { depth_db: -12, attack: 6, release: 12, pad: 3 };

/** Tracks that hold dialogue / music by name or role (A1 Dialogue, A3 Music; DX1/DX2, MX1/MX2 in docs/audio.md). */
export function tracksByRole(project, role) {
  const n = Math.max(4, ...(project.audio || []).map((a) => a.track), ...(project.audio_tracks || []).map((t) => t.track));
  const want = role === "dialogue" ? /^(dx|dialog|dialogue|vo|voice)/i : /^(mx|music|score)/i;
  const out = [];
  for (let t = 1; t <= n; t++) if (want.test(trackName(project, t))) out.push(t);
  // Clips that say what they are count too (meta.kind from the generators).
  for (const a of project.audio || []) {
    const kind = a.meta?.kind;
    if ((role === "dialogue" ? kind === "dialogue" : kind === "music") && !out.includes(a.track)) out.push(a.track);
  }
  return out.sort((x, y) => x - y);
}

/** Record ranges where dialogue plays: merged [start, end) spans of the audible dialogue clips, padded. */
export function dialogueRegions(project, { dialogueTracks = tracksByRole(project, "dialogue"), pad = DUCK_DEFAULTS.pad, gap = 0 } = {}) {
  const spans = (project.audio || [])
    .filter((a) => a.out != null && dialogueTracks.includes(a.track) && audible(project, a.track))
    .map((a) => [Math.max(0, a.start_frame - pad), a.start_frame + audioLen(a) + pad])
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + gap) last[1] = Math.max(last[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

/**
 * Auto-duck: music dips `depth_db` under every dialogue line (attack frames before it, release frames after it,
 * lines closer than attack + release stay ducked between). Writes each music clip's `duck` keys (replacing the
 * previous duck; the clip's own rubber-band `keys` are left alone). Returns a new audio list.
 */
export function autoDuck(project, opts = {}) {
  const o = { ...DUCK_DEFAULTS, ...opts };
  const music = o.musicTracks || tracksByRole(project, "music");
  const regions = dialogueRegions(project, { dialogueTracks: o.dialogueTracks, pad: o.pad, gap: o.attack + o.release });
  return (project.audio || []).map((a) => {
    const c = { ...a };
    delete c.duck;
    if (!music.includes(a.track) || a.out == null || o.depth_db >= 0) return c;
    const len = audioLen(a), s = a.start_frame;
    const pts = [];
    for (const [r0, r1] of regions) {
      if (r1 + o.release <= s || r0 - o.attack >= s + len) continue;
      pts.push([r0 - o.attack - s, 0], [r0 - s, o.depth_db], [r1 - s, o.depth_db], [r1 + o.release - s, 0]);
    }
    if (!pts.length) return c;
    // Clip to the clip: the value at 0 and len by interpolation, nothing outside.
    const curve = (f) => {
      if (f <= pts[0][0] || f >= pts[pts.length - 1][0]) return 0;
      for (let i = 1; i < pts.length; i++) if (f <= pts[i][0]) {
        const [f0, v0] = pts[i - 1], [f1, v1] = pts[i];
        return f1 === f0 ? v1 : v0 + ((v1 - v0) * (f - f0)) / (f1 - f0);
      }
      return 0;
    };
    const keys = pts.filter(([f]) => f > 0 && f < len).map(([f, v]) => [Math.round(f), v]);
    if (pts[0][0] < 0) keys.unshift([0, Math.round(curve(0) * 10) / 10]);
    if (pts[pts.length - 1][0] > len) keys.push([len, Math.round(curve(len) * 10) / 10]);
    const dedup = [];
    for (const k of keys.sort((x, y) => x[0] - y[0])) if (!dedup.length || dedup[dedup.length - 1][0] !== k[0]) dedup.push(k);
    if (dedup.length) c.duck = dedup;
    return c;
  });
}

// ---------------------------------------------------------------- loudness (ITU-R BS.1770-4 / EBU R128)

export const LOUDNESS_TARGETS = {
  social: { lufs: -14, true_peak: -1, label: "Social −14 LUFS" },
  ebu: { lufs: -23, true_peak: -1, label: "EBU R128 −23 LUFS" },
  atsc: { lufs: -24, true_peak: -2, label: "ATSC A/85 −24 LKFS" },
};

/** K-weighting biquads (high shelf, then high pass) for a sample rate: [{b: [b0,b1,b2], a: [1,a1,a2]}, ...]. */
export function kWeighting(sr) {
  // libebur128's derivation of the BS.1770 filters for any rate (identical to the spec's 48 kHz coefficients).
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
             a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  const hp = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan((Math.PI * f0) / sr);
    const a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return [shelf, hp];
}

function biquad(x, { b, a }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * Integrated loudness (LUFS) of channels [Float32Array, ...] at sample rate sr: K-weighted, 400 ms blocks with 75%
 * overlap, absolute gate -70 LUFS, relative gate -10 LU. -Infinity for silence. Also the max sample peak (dBFS).
 */
export function loudness(channels, sr) {
  const ks = kWeighting(sr);
  const filtered = channels.map((ch) => biquad(biquad(ch, ks[0]), ks[1]));
  const n = channels[0]?.length || 0;
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  const z = [];
  for (let s = 0; s + block <= n; s += hop) {
    let sum = 0;
    for (const y of filtered) { let m = 0; for (let i = s; i < s + block; i++) m += y[i] * y[i]; sum += m / block; }
    z.push(sum);
  }
  if (!z.length && n) { let sum = 0; for (const y of filtered) { let m = 0; for (let i = 0; i < n; i++) m += y[i] * y[i]; sum += m / n; } z.push(sum); }
  const lk = (p) => -0.691 + 10 * Math.log10(p);
  const abs = z.filter((p) => p > 0 && lk(p) > -70);
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  const peak_db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  if (!abs.length) return { lufs: -Infinity, peak_db };
  const mean = (arr) => arr.reduce((s, p) => s + p, 0) / arr.length;
  const rel = lk(mean(abs)) - 10;
  const gated = abs.filter((p) => lk(p) > rel);
  return { lufs: lk(mean(gated.length ? gated : abs)), peak_db };
}

/**
 * Gain (dB) that takes a mix at `measured` LUFS to `target`, held back so the peak stays under the ceiling
 * (dBFS; true-peak is a bit above sample peak, so render.py runs ffmpeg's true-peak limiter as well).
 */
export function loudnessGain(measured, target, peak_db = -Infinity, ceiling = -1) {
  if (!Number.isFinite(measured)) return 0;
  const want = target - measured;
  return Number.isFinite(peak_db) ? Math.min(want, ceiling - peak_db) : want;
}

// ---------------------------------------------------------------- beats

/**
 * Onsets and the beat grid of a mono signal: an energy-flux novelty curve (10 ms hops), peaks over an adaptive
 * threshold, tempo from its autocorrelation (60-180 BPM), and the grid phase that lands on the most novelty.
 * {bpm, beats: [s], onsets: [s]}. Simple and fast on purpose: good enough to put cuts on the downbeat.
 */
export function detectBeats(mono, sr, { minBpm = 60, maxBpm = 180 } = {}) {
  const hop = Math.max(1, Math.round(sr * 0.01)), win = hop * 2;
  const nov = [];
  let prev = 0;
  for (let s = 0; s + win <= mono.length; s += hop) {
    let e = 0;
    for (let i = s + 1; i < s + win; i++) { const d = mono[i] - mono[i - 1]; e += d * d; }
    const le = Math.log1p(1000 * e / win);
    nov.push(Math.max(0, le - prev));
    prev = le;
  }
  const hopS = hop / sr;
  // Onsets: local maxima above the median + 1.5 x MAD of a 1 s window, 80 ms apart.
  const onsets = [];
  const W = Math.round(0.5 / hopS);
  for (let i = 1; i < nov.length - 1; i++) {
    if (!(nov[i] > nov[i - 1] && nov[i] >= nov[i + 1])) continue;
    const seg = nov.slice(Math.max(0, i - W), i + W).sort((x, y) => x - y);
    const med = seg[Math.floor(seg.length / 2)];
    const mad = seg.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[Math.floor(seg.length / 2)];
    if (nov[i] <= med + 1.5 * mad + 1e-6) continue;
    const t = i * hopS;
    if (onsets.length && t - onsets[onsets.length - 1] < 0.08) continue;
    onsets.push(t);
  }
  if (nov.length < 4) return { bpm: 0, beats: [], onsets };
  let best = 0, bestLag = 0;
  const lo = Math.round(60 / maxBpm / hopS), hi = Math.round(60 / minBpm / hopS);
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = lag; i < nov.length; i++) s += nov[i] * nov[i - lag];
    s /= nov.length - lag;
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return { bpm: 0, beats: [], onsets };
  // Refine the period to sub-hop precision with a parabola through the autocorrelation peak.
  const ac = (lag) => { let s = 0; for (let i = lag; i < nov.length; i++) s += nov[i] * nov[i - lag]; return s / (nov.length - lag); };
  const y0 = ac(bestLag - 1), y1 = ac(bestLag), y2 = ac(bestLag + 1);
  const den = y0 - 2 * y1 + y2;
  const period = bestLag + (den ? (0.5 * (y0 - y2)) / den : 0);
  let phase = 0, ph = -1;
  for (let p = 0; p < Math.ceil(period); p++) {
    let s = 0;
    for (let t = p; t < nov.length; t += period) s += nov[Math.round(t)] || 0;
    if (s > ph) { ph = s; phase = p; }
  }
  const beats = [];
  for (let t = phase; t < nov.length; t += period) beats.push(Math.round(t * hopS * 1000) / 1000);
  return { bpm: Math.round((60 / (period * hopS)) * 10) / 10, beats, onsets };
}

/** Beat times (s, within the clip's source) of a music clip -> record frames inside the clip. */
export function beatFrames(a, beatsSeconds, fps) {
  const len = audioLen(a);
  return beatsSeconds.map((t) => Math.round(t * fps) - a.in).filter((f) => f >= 0 && f < len).map((f) => f + a.start_frame);
}

/**
 * Snap cuts to the beat: roll each edit to the nearest beat frame within `tol` frames (a roll keeps the cut's
 * length and everything after it in place). Returns {cut, moved: [{edit, from, to}]}.
 */
export function snapCutsToBeats(project, beats, { tol = 6, roll } = {}) {
  let p = { ...project, cut: project.cut.map((e) => ({ ...e })) };
  const moved = [];
  for (let k = 1; k < p.cut.length; k++) {
    const at = layout(p)[k].recIn;
    let best = null;
    for (const b of beats) if (Math.abs(b - at) <= tol && (best == null || Math.abs(b - at) < Math.abs(best - at))) best = b;
    if (best == null || best === at) continue;
    const cut = roll(p, k, best - at);
    const now = layout({ ...p, cut })[k].recIn;
    if (now !== at) { moved.push({ edit: k, from: at, to: now }); p = { ...p, cut }; }
  }
  return { cut: p.cut, moved };
}

// ---------------------------------------------------------------- assemble the scene from the ScriptSync lining

const SPEAKING = new Set(["character", "parenthetical", "dialogue", "lyric"]);

/**
 * A first cut from the lined script: the wide for action (an insert when one is lined on that action line),
 * the speaker's single for their lines (then their OTS, the two-shot, the master), cutting on line ends.
 * scene: the script scene ({elements}); shots: [{id, name, setup, character?, subject?, coverage?}];
 * framesOf(id): the take's length in frames. Each element's place in a take is its share of that take's lined
 * coverage, weighted by text length (ScriptSync's own rule, dailies/model.mjs syncSegments).
 * Returns {cut: [{shot_id, in, out}], cues: [{start_frame, end_frame, text, speaker}], plan: [{i, shot_id}]}.
 */
export function assembleFromLining(scene, shots, framesOf, { minFrames = 8, pace = "speech", fps = 24 } = {}) {
  const els = scene?.elements || [];
  const lined = shots.map((sh) => {
    const cov = coverageFor(scene, sh, sh.coverage);
    const segs = new Map(syncSegments(scene, cov).map((s) => [s.i, s]));
    return { sh, cov, segs, kind: setupKind(sh), who: shotCharacter(scene, sh), frames: Math.max(1, Math.round(framesOf(sh.id) || 1)) };
  }).filter((x) => x.cov);
  const onAt = (x, i) => { const s = x.segs.get(i); return s && !s.off; };
  const rank = (prefs, i) => {
    for (const p of prefs) { const hit = lined.find((x) => x.kind === p && onAt(x, i)); if (hit) return hit; }
    return lined.find((x) => onAt(x, i)) || null;
  };
  const speakerOf = (i) => {
    for (let j = i; j >= 0; j--) {
      const e = els[j];
      if (e?.character) return e.character;
      if (!SPEAKING.has(e?.type)) break;
    }
    return null;
  };
  const plan = [];
  els.forEach((e, i) => {
    let pick = null;
    if (SPEAKING.has(e?.type)) {
      const who = speakerOf(i);
      const on = (kinds) => who && kinds.map((k) => lined.find((x) => x.kind === k && x.who === who && onAt(x, i))).find(Boolean);
      pick = on(["single", "close"]) || on(["ots", "pov"]) || rank(["two", "master", "wide"], i);
    } else if (e?.type === "action") {
      pick = lined.find((x) => x.kind === "insert" && x.cov.from === i && x.cov.to === i && onAt(x, i)) || rank(["wide", "master", "two"], i);
    } else pick = rank(["master", "wide", "two"], i);
    if (pick) plan.push({ i, pick, speaking: SPEAKING.has(e?.type), dialogue: e?.type === "dialogue" ? e : null });
  });
  // Pace. "speech" (default): a line lasts as long as it takes to say (2.6 words a second, plus a breath), an action
  // line as long as it takes to read (1.2 to 4 s), the cue and parenthetical fold into their line; the frames come
  // from where the element sits in each take, slid back when the take is shorter. "take": each element lasts as long
  // as it does in the take that covers the whole scene (master, else wide, else two-shot).
  const ref = ["master", "wide", "two"].map((k) => lined.find((x) => x.kind === k && x.cov.from === 0 && x.cov.to === els.length - 1)).find(Boolean)
    || null;
  const nWords = (t) => String(t || "").split(/\s+/).filter(Boolean).length;
  const durOf = (p) => {
    const e = els[p.i] || {};
    if (pace === "speech") {
      if (e.type === "character" || e.type === "parenthetical") return 0;
      if (e.type === "dialogue" || e.type === "lyric") return Math.round((nWords(e.text) / 2.6 + 0.35) * fps);
      if (e.type === "action") return Math.round(clamp(nWords(e.text) / 3.2, 1.2, 4) * fps);
      return Math.round(fps);
    }
    const own = p.pick.segs.get(p.i);
    const r = ref && ref.segs.get(p.i);
    return Math.max(1, Math.round(r ? (r.b - r.a) * ref.frames : (own.b - own.a) * p.pick.frames));
  };
  // Runs of one shot over consecutive lined elements -> events: {x, in, out, els: [{p, off, len}]}.
  const events = [];
  let pending = [];
  for (let p of plan) {
    let last = events[events.length - 1];
    // The take has run out on this shot: cut to another setup that covers the line, not a jump cut on the same one.
    if (last && last.x === p.pick && last.out + Math.min(durOf(p), p.pick.frames) > p.pick.frames) {
      const alt = ["master", "wide", "two", "ots", "single", "close"].map((k) => lined.find((x) => x !== p.pick && x.kind === k && onAt(x, p.i))).find(Boolean);
      if (alt) p = { ...p, pick: alt };
    }
    const seg = p.pick.segs.get(p.i), d = Math.min(durOf(p), p.pick.frames);
    if (!d) {   // a cue / parenthetical: rides with the line it belongs to
      if (last && last.x === p.pick) last.els.push({ p, off: last.out - last.in, len: 0 });
      else pending.push(p);
      continue;
    }
    if (last && last.x === p.pick && last.out + d <= p.pick.frames) { last.els.push({ p, off: last.out - last.in, len: d }); last.out += d; continue; }
    const start = Math.min(Math.floor(seg.a * p.pick.frames), Math.max(0, p.pick.frames - d));
    events.push({ x: p.pick, in: start, out: Math.min(p.pick.frames, start + d), els: [...pending.map((q) => ({ p: q, off: 0, len: 0 })), { p, off: 0, len: d }] });
    pending = [];
  }
  // A sliver (a one-word line) is folded into the clip before it when that shot also covers it, so nothing flashes.
  for (let k = 1; k < events.length; k++) {
    const ev = events[k], prev = events[k - 1];
    if (ev.out - ev.in >= minFrames || !ev.els.every((e) => onAt(prev.x, e.p.i))) continue;
    const room = prev.x.frames - prev.out, add = Math.min(room, ev.out - ev.in);
    if (add <= 0) continue;
    for (const e of ev.els) prev.els.push({ ...e, off: prev.out - prev.in + e.off });
    prev.out += add;
    events.splice(k--, 1);
  }
  const cut = [], cues = [];
  let rec = 0;
  for (const ev of events) {
    const len = ev.out - ev.in;
    cut.push({ shot_id: ev.x.sh.id, in: ev.in, out: ev.out });
    for (const e of ev.els) {
      if (!e.p.dialogue || e.off >= len) continue;
      cues.push({ start_frame: rec + e.off, end_frame: rec + Math.min(len, e.off + e.len), text: String(e.p.dialogue.text || "").trim(),
                  speaker: speakerOf(e.p.i) || "" });
    }
    rec += len;
  }
  return { cut, cues: normalizeSubtitles(cues.filter((c) => c.text)), plan: plan.map((p) => ({ i: p.i, shot_id: p.pick.sh.id })) };
}

// ---------------------------------------------------------------- subtitles

/**
 * Subtitle cues from the typed dialogue: every dialogue clip on the audio tracks (the Dialogue Line node puts the
 * line in meta.line and the speaker in meta.character) becomes a cue over the clip. No speech recognition.
 */
export function subtitlesFromDialogue(project) {
  const cues = (project.audio || []).filter((a) => a.out != null && (a.meta?.line || a.meta?.text) && (a.meta?.kind === "dialogue" || !a.meta?.kind))
    .map((a) => ({ start_frame: a.start_frame, end_frame: a.start_frame + audioLen(a), text: String(a.meta.line || a.meta.text), speaker: a.meta.character || "" }));
  return normalizeSubtitles(cues);
}

/** Split a line for subtitles: at most 2 lines of about `width` characters (on word boundaries). */
export function wrapCue(text, width = 42) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= 2) return lines;
  // Too long for two lines of `width`: two balanced lines, broken at the word nearest the middle.
  const full = words.join(" ");
  let best = 1, bd = Infinity;
  for (let k = 1; k < words.length; k++) {
    const d = Math.abs(words.slice(0, k).join(" ").length - full.length / 2);
    if (d < bd) { bd = d; best = k; }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

const msOf = (frames, fps) => Math.round((frames * 1000) / fps);
const clock = (ms, sep) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
};

/** fps as a real rate (23.976 -> 24000/1001), for subtitle clock times. */
const realRate = (fps) => {
  const f = Number(fps) || 24;
  for (const [nom, base] of [[23.976, 24], [29.97, 30], [59.94, 60]]) if (Math.abs(f - nom) < 0.01) return (base * 1000) / 1001;
  return f;
};

/** SubRip (.srt): times from the head of the cut (00:00:00,000 = record 01:00:00:00). */
export function toSRT(input) {
  const project = normalizeProject(input);
  const r = realRate(project.fps);
  return (project.subtitles || []).map((c, i) =>
    `${i + 1}\n${clock(msOf(c.start_frame, r), ",")} --> ${clock(msOf(c.end_frame, r), ",")}\n${wrapCue(c.text).join("\n")}\n`).join("\n");
}

/** WebVTT (.vtt), with the speaker as a voice tag when known. */
export function toVTT(input) {
  const project = normalizeProject(input);
  const r = realRate(project.fps);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = (project.subtitles || []).map((c) => {
    const text = wrapCue(c.text).map(esc).join("\n");
    return `${clock(msOf(c.start_frame, r), ".")} --> ${clock(msOf(c.end_frame, r), ".")}\n${c.speaker ? `<v ${esc(c.speaker)}>` : ""}${text}\n`;
  });
  return "WEBVTT\n\n" + body.join("\n");
}

/** Cue showing at record frame f, or null. */
export const cueAt = (project, f) => (project.subtitles || []).find((c) => f >= c.start_frame && f < c.end_frame) || null;

/** Title showing at record frame f with its opacity (fades): {title, alpha} or null. */
export function titleAt(project, f) {
  for (const t of project.titles || []) {
    const o = f - t.start_frame;
    if (o < 0 || o >= t.frames) continue;
    const alpha = Math.max(0, Math.min(1, t.fade_in ? (o + 0.5) / t.fade_in : 1, t.fade_out ? (t.frames - o - 0.5) / t.fade_out : 1));
    return { title: t, alpha };
  }
  return null;
}

// ---------------------------------------------------------------- render request

/**
 * The body for POST /soundstage/cut/render (soundstage/cut/render.py): the normalised project plus the output
 * spec. format: "mp4" (H.264 + AAC) | "prores" (ProRes 422 HQ + PCM in a .mov); aspect: "source" | "9:16";
 * loudness: a LOUDNESS_TARGETS key or null; burn_subtitles; reframe_x (-1..1, the 9:16 crop's centre).
 */
export function renderRequest(project, { format = "mp4", aspect = "source", loudness: lt = "social", burn_subtitles = false, reframe_x = 0 } = {}) {
  const p = normalizeProject(project);
  return {
    project: p,
    spec: { format: format === "prores" ? "prores" : "mp4", aspect: aspect === "9:16" ? "9:16" : "source",
            loudness: LOUDNESS_TARGETS[lt] ? lt : null, burn_subtitles: !!burn_subtitles, reframe_x: clamp(Number(reframe_x) || 0, -1, 1),
            frames: sequenceFrames(p), picture_frames: totalFrames(p) },
  };
}

export { shotMap };
