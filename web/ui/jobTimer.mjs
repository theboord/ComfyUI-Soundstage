// The running-job timer and the done-chime: pure helpers (no DOM), so they test without a browser.
// activity.mjs wires them to the Activity registry's rows; this file holds the words, the math and the sound.

export const SOUND_KEY = "ss_chime_prefs";
export const DEFAULT_SOUND = { on: true, volume: 0.35, bgOnly: false, minSec: 15 };

/** Never louder than this per note, whatever the slider says: a chime is a nudge, not an alarm. */
export const MAX_NOTE_GAIN = 0.2;

// ---- Words and math.
const pad = (n) => String(n).padStart(2, "0");

/** The big counter: mm:ss, or h:mm:ss past an hour. */
export function fmtClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return "--:--";
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** A short length of time in words ("40 s", "3 min", "1 h 5 min"). */
export function fmtSpan(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Percent from steps; null when there are no steps (never a made-up number). */
export function stepPercent(step, steps) {
  if (!Number.isFinite(step) || !Number.isFinite(steps) || steps <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((100 * step) / steps)));
}

/** "about 2 min left", "at least 40 s left", or a range ("about 2–3 min left") while the ETA book is thin (< 3 runs). */
export function timeLeftText(ms, { atLeast = false, overdue = false, runs = 0 } = {}) {
  if (ms == null || !Number.isFinite(ms)) return overdue ? "taking longer than usual" : "time left not known yet";
  if (atLeast) return `at least ${fmtSpan(ms)} left`;
  if (runs < 3 && ms >= 60_000) {
    const lo = Math.max(1, Math.round((ms * 0.75) / 60_000)), hi = Math.max(lo + 1, Math.round((ms * 1.4) / 60_000));
    return `about ${lo}–${hi} min left`;
  }
  return `about ${fmtSpan(ms)} left`;
}

/** "2 more queued · about 7 min total" (null when nothing is waiting). */
export function queueLine(totals) {
  const q = totals?.queued || 0;
  if (!q) return null;
  const bits = [`${q} more queued`];
  if (totals.etaMs) bits.push(`${totals.etaPartial ? "at least " : "about "}${fmtSpan(totals.etaMs)} total`);
  return bits.join(" · ");
}

/** Everything the timer shows, from one Activity row (`reg.view().running[i]`). */
export function timerModel(row) {
  if (!row) return null;
  const d = row.detail || null;
  const step = d?.steps ? d.step : row.steps ? row.step : null;
  const steps = d?.steps || row.steps || null;
  const pct = row.pct != null ? row.pct : stepPercent(step, steps);
  return {
    id: row.id, name: row.name, own: !!row.own,
    clock: fmtClock(row.elapsedMs),
    pct, indeterminate: pct == null,
    stepText: steps ? `step ${step} / ${steps}` : null,
    left: timeLeftText(row.remainingMs, { atLeast: row.remainingAtLeast, overdue: row.overdue, runs: row.etaRuns || 0 }),
    node: d?.stage || null,
  };
}

// ---- The chime, as data: [{ freq Hz, at s, dur s, peak 0..1 of the volume }], a slow attack and a long smooth decay.
export const CHIMES = {
  // Rising major triad (C5 E5 G5): "finished".
  done: { type: "sine", attack: 0.08, notes: [
    { freq: 523.25, at: 0, dur: 0.55, peak: 0.8 }, { freq: 659.25, at: 0.13, dur: 0.55, peak: 0.8 }, { freq: 783.99, at: 0.26, dur: 0.6, peak: 0.7 }] },
  // Falling major third (E5 C5), gentler: "stopped / didn't finish". Nothing minor or harsh.
  stopped: { type: "sine", attack: 0.1, notes: [
    { freq: 659.25, at: 0, dur: 0.5, peak: 0.55 }, { freq: 523.25, at: 0.2, dur: 0.6, peak: 0.5 }] },
};

/** Total length of a chime in seconds. */
export const chimeLength = (c) => Math.max(...c.notes.map((n) => n.at + n.dur));

/** The note gain for a volume 0..1 (clamped), halved again when the user asks the system for less motion/sensation. */
export function noteGain(peak, volume, reduced = false) {
  const v = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : DEFAULT_SOUND.volume));
  return Math.min(MAX_NOTE_GAIN, peak * v * MAX_NOTE_GAIN) * (reduced ? 0.6 : 1);
}

/** Play a chime on an AudioContext. Quiet failure: a blocked or missing context just means no sound. Returns true if scheduled. */
export function playChime(kind, prefs, ctx, { reduced = false } = {}) {
  try {
    const c = CHIMES[kind === "done" ? "done" : "stopped"];
    if (!ctx || ctx.state !== "running") { ctx?.resume?.()?.catch?.(() => {}); return false; }   // locked until a user gesture
    const t0 = ctx.currentTime + 0.03;
    for (const n of c.notes) {
      const g = noteGain(n.peak, prefs.volume, reduced);
      if (g <= 0) continue;
      const osc = ctx.createOscillator(), amp = ctx.createGain();
      osc.type = c.type;
      osc.frequency.value = n.freq;
      const a = t0 + n.at;
      amp.gain.setValueAtTime(0.0001, a);
      amp.gain.linearRampToValueAtTime(g, a + c.attack);
      amp.gain.exponentialRampToValueAtTime(0.0001, a + n.dur);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(a);
      osc.stop(a + n.dur + 0.05);
    }
    return true;
  } catch { return false; }
}

// ---- Settings.
export function normalizeSound(p = {}) {
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Math.max(lo, Math.min(hi, Number(v))) : d);
  return { on: p.on == null ? DEFAULT_SOUND.on : !!p.on, volume: num(p.volume, 0, 1, DEFAULT_SOUND.volume),
    bgOnly: !!p.bgOnly, minSec: Math.round(num(p.minSec, 0, 3600, DEFAULT_SOUND.minSec)) };
}

export function loadSound(storage = globalThis.localStorage) {
  try { return normalizeSound(JSON.parse(storage?.getItem(SOUND_KEY) || "{}")); } catch { return normalizeSound(); }
}

export function saveSound(prefs, storage = globalThis.localStorage) {
  try { storage?.setItem(SOUND_KEY, JSON.stringify(normalizeSound(prefs))); } catch { /* this page only */ }
}

/** What to do when a job ends: sound (needs the settings to allow it), and the visual cues for people who miss sound. */
export function cuesFor(prefs, { elapsedMs, hidden }) {
  const long = (elapsedMs ?? 0) >= prefs.minSec * 1000;
  return { sound: long && prefs.on && (!prefs.bgOnly || !!hidden), pulse: long, title: long && !!hidden };
}

/** Fires once per finished job of this browser (never for old jobs on page load, never twice for one job). */
export class FinishWatcher {
  constructor() { this.seen = new Set(); this.primed = false; }
  /** `finished`: the registry's finished rows. Returns the newly finished own jobs: [{ id, kind: "done"|"stopped", elapsedMs }]. */
  check(finished) {
    const out = [];
    for (const r of finished || []) {
      if (this.seen.has(r.id)) continue;
      this.seen.add(r.id);
      if (this.primed && r.own) out.push({ id: r.id, kind: r.state === "done" ? "done" : "stopped", elapsedMs: r.elapsedMs });
    }
    this.primed = true;
    if (this.seen.size > 200) this.seen = new Set([...this.seen].slice(-100));
    return out;
  }
}
