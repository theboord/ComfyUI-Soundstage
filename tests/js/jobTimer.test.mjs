// node --test tests/js/jobTimer.test.mjs
// The running-job timer and the done-chime: formatter, percent / steps / ETA words, the chime as data, the sound
// settings, the "should it chime" decision, and the fake-DOM wiring (the timer ticks; one chime per finished job).
import test from "node:test";
import assert from "node:assert/strict";

import { fmtClock, fmtSpan, stepPercent, timeLeftText, queueLine, timerModel, CHIMES, chimeLength, noteGain, MAX_NOTE_GAIN,
  playChime, normalizeSound, loadSound, saveSound, SOUND_KEY, DEFAULT_SOUND, cuesFor, FinishWatcher } from "../../web/ui/jobTimer.mjs";
import { ActivityRegistry, EtaBook, createJobTimer, attachFinishCues } from "../../web/ui/activity.mjs";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };

test("clock: mm:ss, h:mm:ss, and a dash when unknown", () => {
  assert.equal(fmtClock(0), "00:00");
  assert.equal(fmtClock(65_900), "01:05");
  assert.equal(fmtClock(3_725_000), "1:02:05");
  assert.equal(fmtClock(null), "--:--");
  assert.equal(fmtSpan(40_000), "40 s");
  assert.equal(fmtSpan(7 * 60_000), "7 min");
});

test("percent from steps: null without steps, clamped with them", () => {
  assert.equal(stepPercent(18, 24), 75);
  assert.equal(stepPercent(0, 24), 0);
  assert.equal(stepPercent(30, 24), 100);
  assert.equal(stepPercent(null, null), null);
  assert.equal(stepPercent(3, 0), null);
});

test("time left: about / at least / range while the ETA book is thin / unknown", () => {
  assert.equal(timeLeftText(30_000, { runs: 5 }), "about 30 s left");
  assert.equal(timeLeftText(120_000, { runs: 5 }), "about 2 min left");
  assert.equal(timeLeftText(120_000, { runs: 1 }), "about 2–3 min left");
  assert.equal(timeLeftText(30_000, { runs: 0 }), "about 30 s left", "a short wait stays a plain number");
  assert.equal(timeLeftText(45_000, { atLeast: true }), "at least 45 s left");
  assert.equal(timeLeftText(null), "time left not known yet");
  assert.equal(timeLeftText(null, { overdue: true }), "taking longer than usual");
  assert.equal(queueLine({ queued: 0 }), null);
  assert.equal(queueLine({ queued: 2, etaMs: 420_000, etaPartial: false }), "2 more queued · about 7 min total");
  assert.equal(queueLine({ queued: 1, etaMs: 60_000, etaPartial: true }), "1 more queued · at least 1 min total");
  assert.equal(queueLine({ queued: 3, etaMs: null }), "3 more queued");
});

test("timer model: sampler step + percent + node; no steps -> indeterminate, never a made-up percent", () => {
  const m = timerModel({ id: "a", name: "Final · Wide", own: true, elapsedMs: 95_000, pct: 40, remainingMs: 120_000, etaRuns: 6,
    detail: { stage: "Sampling", step: 6, steps: 12 } });
  assert.deepEqual([m.clock, m.pct, m.stepText, m.left, m.node, m.indeterminate], ["01:35", 40, "step 6 / 12", "about 2 min left", "Sampling", false]);
  const loader = timerModel({ id: "b", name: "Frame", own: true, elapsedMs: 4000, pct: null, remainingMs: null, detail: { stage: "Loading model", step: null, steps: null } });
  assert.deepEqual([loader.pct, loader.indeterminate, loader.stepText, loader.left, loader.clock], [null, true, null, "time left not known yet", "00:04"]);
  const bare = timerModel({ id: "c", name: "x", elapsedMs: 1000, pct: null, step: 3, steps: 6, remainingMs: 9000, remainingAtLeast: true });
  assert.equal(bare.pct, 50, "steps alone give a percent");
  assert.equal(bare.left, "at least 9 s left");
  assert.equal(timerModel(null), null);
});

test("chime data: rising for done, gentler falling pair for stopped, short, soft, safe gains", () => {
  const { done, stopped } = CHIMES;
  assert.ok(done.notes.length >= 2 && done.notes.length <= 3);
  assert.equal(stopped.notes.length, 2);
  assert.ok(done.notes.every((n, i, a) => i === 0 || n.freq > a[i - 1].freq), "done rises");
  assert.ok(stopped.notes[1].freq < stopped.notes[0].freq, "stopped falls");
  for (const c of [done, stopped]) {
    assert.ok(["sine", "triangle"].includes(c.type));
    assert.ok(c.attack >= 0.05, "slow attack");
    assert.ok(chimeLength(c) >= 0.5 && chimeLength(c) <= 0.9, `0.5-0.9 s, got ${chimeLength(c)}`);
    for (const n of c.notes) {
      assert.ok(n.freq >= 400 && n.freq <= 1000, "mid-range, no shrill highs");
      assert.ok(n.peak > 0 && n.peak <= 1 && n.dur >= 0.4);
      assert.ok(noteGain(n.peak, 1) <= MAX_NOTE_GAIN, "never above the safe max, even at full volume");
    }
  }
  assert.ok(Math.max(...stopped.notes.map((n) => n.peak)) < Math.max(...done.notes.map((n) => n.peak)), "stopped is gentler");
  assert.equal(noteGain(1, 0), 0);
  assert.ok(noteGain(0.8, 0.5, true) < noteGain(0.8, 0.5, false), "reduced sensory settings: softer");
  assert.equal(noteGain(1, 9), MAX_NOTE_GAIN, "volume clamped");
});

function fakeAudio(state = "running") {
  const log = { osc: [], resumed: 0 };
  const param = () => ({ calls: [], setValueAtTime(v) { this.calls.push(["set", v]); }, linearRampToValueAtTime(v) { this.calls.push(["lin", v]); }, exponentialRampToValueAtTime(v) { this.calls.push(["exp", v]); } });
  return { log, state, currentTime: 10, destination: {}, resume() { log.resumed++; return Promise.resolve(); },
    createOscillator() { const o = { type: "", frequency: {}, connect() {}, start(t) { o.t = t; }, stop() {} }; log.osc.push(o); return o; },
    createGain() { return { gain: param(), connect() {} }; } };
}

test("playChime: schedules every note when running; silent (and asks to resume) while locked; never throws", () => {
  const ctx = fakeAudio();
  assert.equal(playChime("done", DEFAULT_SOUND, ctx), true);
  assert.equal(ctx.log.osc.length, 3);
  assert.deepEqual(ctx.log.osc.map((o) => o.frequency.value), CHIMES.done.notes.map((n) => n.freq));
  assert.ok(ctx.log.osc[0].t > 10, "never starts at the current instant");
  const stopped = fakeAudio();
  playChime("stopped", DEFAULT_SOUND, stopped);
  assert.equal(stopped.log.osc.length, 2);
  const locked = fakeAudio("suspended");
  assert.equal(playChime("done", DEFAULT_SOUND, locked), false);
  assert.equal(locked.log.osc.length, 0);
  assert.equal(locked.log.resumed, 1);
  assert.equal(playChime("done", DEFAULT_SOUND, null), false);
  assert.equal(playChime("done", DEFAULT_SOUND, { state: "running", get currentTime() { throw new Error("boom"); } }), false);
});

test("sound settings: defaults, clamping, persistence, blocked storage", () => {
  assert.deepEqual(loadSound(memStore()), { on: true, volume: 0.35, bgOnly: false, minSec: 15 });
  const st = memStore();
  saveSound({ on: false, volume: 0.6, bgOnly: true, minSec: 30 }, st);
  assert.deepEqual(loadSound(st), { on: false, volume: 0.6, bgOnly: true, minSec: 30 });
  assert.deepEqual(normalizeSound({ volume: 7, minSec: -3 }), { on: true, volume: 1, bgOnly: false, minSec: 0 });
  assert.deepEqual(normalizeSound({ volume: "x", minSec: "" }), DEFAULT_SOUND);
  st.m.set(SOUND_KEY, "{not json");
  assert.deepEqual(loadSound(st), DEFAULT_SOUND);
  const blocked = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
  assert.deepEqual(loadSound(blocked), DEFAULT_SOUND);
  assert.doesNotThrow(() => saveSound(DEFAULT_SOUND, blocked));
});

test("when to chime: on/off, only in the background, only past N seconds; visual cues follow the length and tab", () => {
  const p = DEFAULT_SOUND;
  assert.equal(cuesFor(p, { elapsedMs: 20_000, hidden: false }).sound, true);
  assert.equal(cuesFor(p, { elapsedMs: 5_000, hidden: false }).sound, false, "short job");
  assert.equal(cuesFor({ ...p, on: false }, { elapsedMs: 60_000, hidden: true }).sound, false);
  assert.equal(cuesFor({ ...p, bgOnly: true }, { elapsedMs: 60_000, hidden: false }).sound, false);
  assert.equal(cuesFor({ ...p, bgOnly: true }, { elapsedMs: 60_000, hidden: true }).sound, true);
  assert.equal(cuesFor({ ...p, minSec: 0 }, { elapsedMs: 0, hidden: false }).sound, true);
  const quiet = cuesFor({ ...p, on: false }, { elapsedMs: 60_000, hidden: true });
  assert.deepEqual([quiet.pulse, quiet.title], [true, true], "people who mute still get the cues");
  assert.equal(cuesFor(p, { elapsedMs: 60_000, hidden: false }).title, false, "no title change in a focused tab");
});

test("finish watcher: nothing for old jobs on load, one hit per job, own jobs only", () => {
  const w = new FinishWatcher();
  assert.deepEqual(w.check([{ id: "old", own: true, state: "done", elapsedMs: 9e4 }]), []);
  const rows = [{ id: "old", own: true, state: "done" }, { id: "n", own: true, state: "done", elapsedMs: 9e4 },
    { id: "o", own: false, state: "done" }, { id: "f", own: true, state: "failed", elapsedMs: 9e4 }];
  assert.deepEqual(w.check(rows).map((x) => [x.id, x.kind]), [["n", "done"], ["f", "stopped"]]);
  assert.deepEqual(w.check(rows), [], "not again on the next event");
});

// ---- Fake DOM wiring.
function fakeDocument() {
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.className = ""; this._text = ""; }
    append(...c) { for (const x of c) this.children.push(x); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener() {}
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    byClass(cls) { const out = []; const walk = (e) => { for (const c of e.children) { if (c.className.split(" ").includes(cls)) out.push(c); walk(c); } }; walk(this); return out; }
  }
  return { createElement: (t) => new El(t) };
}

const clockAt = (t0 = 1_000_000) => { const c = { t: t0 }; c.now = () => c.t; return c; };

test("timer DOM: ticks every second, shows percent, step, time left, node and the queue; indeterminate for a loader", () => {
  globalThis.document = fakeDocument();
  try {
    const eta = new EtaBook({ storage: memStore() });
    eta.record("final@any", 100_000);
    const c = clockAt();
    const reg = new ActivityRegistry({ eta, now: c.now, clientId: "me" });
    reg.note("p", { name: "Final · Wide", kind: "final" });
    reg.onEvent("execution_start", { prompt_id: "p" });
    reg.onEvent("progress", { prompt_id: "p", node: "12", value: 2, max: 12 });
    reg.onEvent("execution_start", { prompt_id: "q" }); // someone else's, running too
    reg.note("q2", { name: "Frame · 2A", kind: "frame" });
    const t = createJobTimer();
    assert.equal(t.el.hidden, true);
    c.t += 40_000;
    t.update(reg.view());
    const txt = () => t.el.textContent;
    assert.equal(t.el.hidden, false);
    assert.match(txt(), /Final · Wide/);
    assert.match(txt(), /00:40/);
    assert.match(txt(), /40%/);
    assert.match(txt(), /about 1 min left|about 1–2 min left/);
    assert.match(txt(), /step 2 \/ 12/);
    assert.equal(t.el.byClass("ss-jt-fill")[0].style.width, "40%");
    assert.equal(t.el.dataset.indet, "false");
    c.t += 1000;
    t.update(reg.view());
    assert.match(txt(), /00:41/, "the counter moves with the clock");
    // A job with no step info (a loader): elapsed only, indeterminate bar, no percent.
    const reg2 = new ActivityRegistry({ eta: new EtaBook({ storage: memStore() }), now: c.now });
    reg2.onEvent("execution_start", { prompt_id: "z" });
    c.t += 3000;
    const t2 = createJobTimer();
    t2.update(reg2.view());
    assert.match(t2.el.textContent, /00:03/);
    assert.doesNotMatch(t2.el.textContent, /%/);
    assert.equal(t2.el.dataset.indet, "true");
    reg2.onEvent("execution_success", { prompt_id: "z" });
    t2.update(reg2.view());
    assert.equal(t2.el.hidden, true, "hidden once nothing runs");
  } finally { delete globalThis.document; }
});

test("chime fires once per finished job, not on every event; stopped jobs get the falling tone; short jobs stay quiet", () => {
  const c = clockAt();
  const reg = new ActivityRegistry({ eta: new EtaBook({ storage: memStore() }), now: c.now, clientId: "me" });
  const played = [], pulses = [];
  const ctx = fakeAudio();
  const doc = { hidden: true, title: "Soundstage", addEventListener() {} };
  const win = { document: doc, addEventListener() {}, removeEventListener() {} };
  const sound = { prefs: { ...DEFAULT_SOUND } };
  const cues = attachFinishCues({ reg, win, sound, audio: { ctx: () => ctx }, onPulse: () => pulses.push(1) });
  const before = () => ctx.log.osc.length;
  reg.note("a", { name: "Final · A" });
  reg.onEvent("execution_start", { prompt_id: "a" });
  reg.onEvent("progress", { prompt_id: "a", node: "1", value: 1, max: 4 });
  assert.equal(before(), 0, "nothing while running");
  c.t += 60_000;
  reg.onEvent("execution_success", { prompt_id: "a" });
  assert.equal(before(), 3, "rising chime once");
  assert.equal(pulses.length, 1);
  assert.equal(doc.title, "✓ Done · Soundstage");
  reg.onEvent("status", { exec_info: { queue_remaining: 0 } });
  reg.onEvent("executed", { prompt_id: "a", node: "9", output: {} });
  reg.onEvent("progress", { prompt_id: "other", node: "1", value: 1, max: 4 });
  assert.equal(before(), 3, "later events do not chime again");
  assert.equal(pulses.length, 1);
  // A cancelled job: the falling pair.
  reg.note("b", { name: "Final · B" });
  reg.onEvent("execution_start", { prompt_id: "b" });
  c.t += 30_000;
  reg.onEvent("execution_interrupted", { prompt_id: "b" });
  assert.equal(before(), 5);
  assert.deepEqual(ctx.log.osc.slice(3).map((o) => o.frequency.value), CHIMES.stopped.notes.map((n) => n.freq));
  // A 5 s job is under the 15 s default: no sound, no pulse.
  reg.note("s", { name: "Frame · S" });
  reg.onEvent("execution_start", { prompt_id: "s" });
  c.t += 5000;
  reg.onEvent("execution_success", { prompt_id: "s" });
  assert.equal(before(), 5);
  assert.equal(pulses.length, 2);
  cues.dispose();
  assert.equal(doc.title, "Soundstage", "title restored on dispose");
});
