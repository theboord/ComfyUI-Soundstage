// Soundstage QA: the playback bench's math (tools/qa/playback_bench.mjs). Pure functions, no DOM, no I/O;
// tests/js/playback_metrics.test.mjs covers them.
//
// Vocabulary
//   rows   the cut laid out on the record timeline: [{index, recIn, recOut, in, key}] (recOut exclusive). key names the
//          picture source: the render's URL, or "clay:<shot id>" for a shot that plays its clay.
//   ticks  one entry per requestAnimationFrame tick of the Cut panel: {t, run, tl, draw}. t is the rAF timestamp (ms;
//          the frame's begin time), run the performance.now() at which the tick actually ran (later when the main
//          thread is busy; latencies from a request use it),
//          tl the panel's timeline frame after its advance (Math.floor(panel.frame)), draw the last picture drawn into
//          the viewer that tick as {key, src} (src = source frame of that media), or null when the viewer kept its picture.
//   seq    screenTimeline(ticks, rows): what was on screen after each tick, with what the timeline asked for.

/** {n, mean, median, p95, max, min} of a list of numbers (nearest-rank percentiles). Empty: n 0 and nulls. */
export function stats(xs) {
  const a = (xs || []).filter((x) => Number.isFinite(x)).slice().sort((p, q) => p - q);
  if (!a.length) return { n: 0, mean: null, median: null, p95: null, max: null, min: null };
  const at = (q) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
  return { n: a.length, mean: a.reduce((s, x) => s + x, 0) / a.length, median: at(0.5), p95: at(0.95), max: a[a.length - 1], min: a[0] };
}

/** The row under record frame f (binary search; rows sorted by recIn, contiguous or not), or null. */
export function rowAt(rows, f) {
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = rows[mid];
    if (f < r.recIn) hi = mid - 1;
    else if (f >= r.recOut) lo = mid + 1;
    else return r;
  }
  return null;
}

/** What the timeline asks for at record frame f: {row, key, src}, or null outside the cut. */
export function expectedAt(rows, f) {
  const r = rowAt(rows, f);
  return r ? { row: r.index, key: r.key, src: r.in + (f - r.recIn) } : null;
}

/**
 * Which row a picture on screen belongs to: among the rows playing that key whose source range holds its frame, the
 * one whose record position for it is nearest the timeline frame tl (a take reused in several rows, or cut against
 * itself, has one frame in several rows). Returns {row, rec} or null.
 */
export function rowOfShown(rows, shown, tl) {
  if (!shown) return null;
  let best = null;
  for (const r of rows) {
    if (r.key !== shown.key || shown.src < r.in || shown.src >= r.in + (r.recOut - r.recIn)) continue;
    const rec = r.recIn + (shown.src - r.in);
    if (!best || Math.abs(rec - tl) < Math.abs(best.rec - tl)) best = { row: r.index, rec };
  }
  return best;
}

/**
 * What was on screen after each tick: [{t, tl, exp, shown, drew}]. A tick that drew nothing leaves the previous
 * picture up (the Cut keeps its last good picture), so `shown` carries over; drew says whether this tick drew.
 */
export function screenTimeline(ticks, rows) {
  let shown = null;
  return ticks.map((k) => {
    if (k.draw) shown = { key: k.draw.key, src: k.draw.src };
    return { t: k.t, run: k.run ?? k.t, tl: k.tl, exp: expectedAt(rows, k.tl), shown, drew: !!k.draw, au: k.au || null };
  });
}

const same = (a, b) => !!a && !!b && a.key === b.key && a.src === b.src;

/** The vsync interval from rAF timestamps: the median gap between consecutive ticks (ms). */
export function vsyncOf(seq) {
  const gaps = [];
  for (let i = 1; i < seq.length; i++) { const g = seq[i].t - seq[i - 1].t; if (g > 0) gaps.push(g); }
  return stats(gaps).median || 1000 / 60;
}

/** The longest a picture may stay up at `fps` on a `vsync` display: the longest normal cadence plus half a vsync
 *  (24 fps on 60 Hz alternates 2 and 3 vsyncs, 33 / 50 ms, so anything past ~58 ms is a hold). */
export function holdLimit(fps, vsync) {
  return Math.ceil(1000 / fps / vsync - 1e-6) * vsync + vsync / 2;
}

/** For every timeline frame in [from, to): the time the timeline first reached it (first tick with tl >= F). */
export function dueTimes(seq, from, to) {
  const due = new Map();
  let i = 0;
  for (let F = from; F < to; F++) {
    while (i < seq.length && seq[i].tl < F) i++;
    if (i >= seq.length) break;
    due.set(F, seq[i].t);
  }
  return due;
}

/**
 * Dropped frames over a played span [from, to) of timeline frames (the timeline is the Cut's own clock: 24 per second).
 *  - lost: a timeline frame whose correct source frame (its row's take and source frame) never reached the screen
 *    within ±windowMs of the moment the timeline reached it.
 *  - held: a picture that stayed up longer than holdLimit() (longer than its cadence allows) sat over the slots of the
 *    timeline frames that came due while it overstayed (from one frame after it went up until it was replaced).
 * One stall usually shows up both ways (a repeat, then frames skipped to catch up; or a late start, then the clip's
 * last frames cut off), so each row (clip) counts max(lost, held) and `dropped` sums the rows.
 * Returns the totals, the lost and held frame lists, the holds and the per-row counts.
 */
export function countDrops(seq, rows, { fps = 24, vsync, from, to, windowMs = 1000 } = {}) {
  const frameMs = 1000 / fps;
  const vs = vsync || vsyncOf(seq);
  const limit = holdLimit(fps, vs);
  const lo = from ?? (seq.length ? seq[0].tl : 0), hi = to ?? (seq.length ? seq[seq.length - 1].tl + 1 : 0);
  const due = dueTimes(seq, lo, hi);
  // When was each row's source frame on screen? (A picture counts for the row it belongs to, see rowOfShown.)
  const onAt = new Map();
  for (const s of seq) {
    const o = rowOfShown(rows, s.shown, s.tl);
    if (!o) continue;
    const k = o.row + "|" + s.shown.src;
    if (!onAt.has(k)) onAt.set(k, []);
    onAt.get(k).push(s.t);
  }
  const perRow = new Map();
  const bump = (row, field) => { if (row == null) return; const r = perRow.get(row) || { row, lost: 0, held: 0 }; r[field]++; perRow.set(row, r); };
  const lost = [];
  let checked = 0;
  for (const [F, tF] of due) {
    const e = expectedAt(rows, F);
    if (!e) continue;
    checked++;
    const times = onAt.get(e.row + "|" + e.src) || [];
    if (!times.some((t) => Math.abs(t - tF) <= windowMs)) { lost.push(F); bump(e.row, "lost"); }
  }
  // Holds: runs of one picture, from its first tick to the first tick of the next picture.
  const holds = [], held = [];
  const dueList = [...due.entries()];
  let i0 = 0;
  for (let i = 1; i < seq.length; i++) {
    if (same(seq[i].shown, seq[i0].shown)) continue;
    const a = seq[i0].t, b = seq[i].t;
    if (seq[i0].shown && b - a > limit) {
      const slots = dueList.filter(([, tF]) => tF >= a + frameMs && tF < b).map(([F]) => F);
      for (const F of slots) { const e = expectedAt(rows, F); if (e) { held.push(F); bump(e.row, "held"); } }
      holds.push({ t: a, tl: seq[i0].tl, ms: b - a, slots: slots.length, key: seq[i0].shown.key, src: seq[i0].shown.src });
    }
    i0 = i;
  }
  const rowsOut = [...perRow.values()].sort((x, y) => x.row - y.row).map((r) => ({ ...r, dropped: Math.max(r.lost, r.held) }));
  return {
    checked, lost: lost.length, lostFrames: lost, heldExcess: held.length, heldFrames: held, holds,
    dropped: rowsOut.reduce((n, r) => n + r.dropped, 0), perRow: rowsOut, holdLimitMs: limit, vsyncMs: vs,
  };
}

/** Frames per minute of record time: n events over `frames` timeline frames at fps. */
export function perMinute(n, frames, fps = 24) {
  return frames > 0 ? n / (frames / fps / 60) : null;
}

/**
 * Picture-vs-sound offset per tick (ms; positive = the picture is AHEAD of the sound). The picture is the source frame on
 * screen, placed at the centre of its record-frame slot; the sound is the record position the audio output is playing
 * when that picture is presented (rAF time + presentMs), from AudioContext.getOutputTimestamp() read in the same tick:
 *   audioFrame = from + (ctxTime + (present - perfTime) / 1000 - t0) * fps.
 * Only ticks whose picture is from the row the timeline is in, after `settleMs` of play, with a running audio clock.
 * au per tick: {ctx, perf, t0, from, running}.
 */
export function avOffsets(seq, rows, { fps = 24, presentMs = 1000 / 60, settleMs = 500, startT = null } = {}) {
  const out = [];
  const t0 = startT ?? (seq.length ? seq[0].t : 0);
  for (const s of seq) {
    if (!s.au || !s.au.running || !s.shown || !s.exp || s.t - t0 < settleMs) continue;
    if (!(s.au.perf > 0)) continue;
    const o = rowOfShown(rows, s.shown, s.tl);
    if (!o || o.row !== s.exp.row) continue;   // a picture from another clip is a hitch, not a sync offset
    const pic = o.rec + 0.5;
    const present = s.t + presentMs;
    const aud = s.au.from + (s.au.ctx + (present - s.au.perf) / 1000 - s.au.t0) * fps;
    out.push(((pic - aud) / fps) * 1000);
  }
  return out;
}

/**
 * Hitch at each edit point inside [from, to): ms from the tick at which the timeline reached the edit to the first tick
 * showing the incoming row's picture within ±tolFrames of the frame the timeline is on (hitchMs; 0 = the incoming
 * frame was up on the first tick of the clip). censored: true when that never happened before the clip ended (hitchMs is
 * then the clip's whole on-screen time). firstPicMs: ms to the first picture of the incoming row at all (in sync or
 * not), so a clip that runs a few frames late but moves (censored, small firstPicMs) reads apart from a frozen one
 * (both large). lagFrames: the median of (timeline frame - record frame on screen) over the clip's ticks.
 */
export function cutHitches(seq, rows, { from = 0, to = Infinity, tolFrames = 1 } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.index === 0 || r.recIn <= from || r.recIn >= to) continue;
    const i0 = seq.findIndex((s) => s.tl >= r.recIn);
    if (i0 < 0) continue;
    let ok = null, pic = null, i = i0;
    const lags = [];
    for (; i < seq.length && seq[i].tl < r.recOut; i++) {
      const s = seq[i];
      const o = rowOfShown(rows, s.shown, s.tl);
      if (!o || o.row !== r.index) continue;
      pic ??= s;
      lags.push(s.tl - o.rec);
      if (!ok && Math.abs(o.rec - s.tl) <= tolFrames) ok = s;
    }
    const last = seq[Math.min(i, seq.length - 1)];
    out.push({ index: r.index, recIn: r.recIn, key: r.key, dueT: seq[i0].t, hitchMs: ok ? ok.t - seq[i0].t : last.t - seq[i0].t, censored: !ok,
      firstPicMs: pic ? pic.t - seq[i0].t : null, lagFrames: stats(lags).median });
  }
  return out;
}

/** ms from each request {t, frame} (performance.now()) to the first tick that ran after it and shows that frame's
 *  correct picture (null if none did before the next request). */
export function seekLatencies(seq, rows, requests) {
  return requests.map((q, k) => {
    const end = k + 1 < requests.length ? requests[k + 1].t : Infinity;
    const e = expectedAt(rows, q.frame);
    const hit = e && seq.find((s) => (s.run ?? s.t) >= q.t && (s.run ?? s.t) < end && same(s.shown, e));
    return { frame: q.frame, ms: hit ? Math.max(0, (hit.run ?? hit.t) - q.t) : null };
  });
}

/** ms from a key press at time t (event timeStamp) to the first tick that ran after it whose picture satisfies
 *  pred(shownRecordFrame, tick), or null. */
export function reactionMs(seq, rows, t, pred, untilT = Infinity) {
  for (const s of seq) {
    const at = s.run ?? s.t;
    if (at < t || at >= untilT || !s.shown || !s.exp) continue;
    const o = rowOfShown(rows, s.shown, s.tl);
    if (pred(o ? o.rec : null, s)) return Math.max(0, at - t);
  }
  return null;
}

/** Distinct correct pictures per second shown over [t0, t1): how smooth a shuttle or reverse play looked. */
export function distinctPerSecond(seq, t0, t1) {
  const seen = new Set();
  for (const s of seq) if (s.t >= t0 && s.t < t1 && s.shown) seen.add(s.shown.key + "|" + s.shown.src);
  return t1 > t0 ? seen.size / ((t1 - t0) / 1000) : null;
}
