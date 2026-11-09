// The big render countdown (Mike 2026-11-08: "is there a big timer/countdown in the app yet?", then: "put it AT THE
// TOP of the App ... show BOTH clearly: how long it has been running and how much longer it will run"). A full-width
// band just above the App's top bar, readable from across the room while any render runs:
//   the job and shot · ELAPSED mm:ss · TIME LEFT mm:ss with how sure it is ("about ±0:40", "rough first guess") from the
//   size-aware estimator (web/ui/estimator.mjs), "Learning how long this takes" when there is nothing to go on, "longer
//   than usual +mm:ss" past the estimate · a progress bar (ComfyUI's per-node progress where we have it, else time) ·
//   "2 more after this · all done in about 7:30" · Stop (the Activity's own cancel).
// When it ends: "Done: Draft of shot 3 (2:41)" for a few seconds, or "Failed" with a link to the reason, then it hides.
// It sits in the page flow (never over the stage or the shot monitor), above the top bar, and shows in every view.
//
// No clock of its own: activity.mjs calls update(view) from the same draw that its 1 s clock (on only while a job runs)
// and the registry's changes already drive. At idle nothing ticks and an update writes nothing. The only timers here
// are one-shot setTimeouts that hide the Done / Failed state.
//
//   countdownModel(row, totals) / finishModel(row) / afterLine(totals)   pure words and numbers (tests/js/countdown.test.mjs)
//   loadCountdownPrefs() / saveCountdownPrefs(p)                         big / small and collapsed, per viewer (try/catch)
//   createCountdown({ onStop, onWhy, sound })                           -> { el, update(view), dispose() }
import { fmtClock } from "./jobTimer.mjs";
import { sureText } from "./estimator.mjs";

export const COUNTDOWN_KEY = "ss_countdown_prefs";
export const DEFAULT_COUNTDOWN = { size: "big", collapsed: false };
export const HOLD_DONE_MS = 6000;     // the Done state stays this long
export const HOLD_FAIL_MS = 15000;    // a failure stays longer (it has a reason to read); × closes it sooner

// ---- Words.
/** "Draft · shot 3" -> "Draft of shot 3" (the App names its renders "<step> · shot <name>"). */
export function jobPhrase(name) {
  return String(name || "Render").trim().replace(/ · shot /, " of shot ");
}

/** m:ss ("2:41"), h:mm:ss past an hour. */
export function shortClock(ms) {
  const c = fmtClock(ms);
  return /^0\d:\d\d$/.test(c) ? c.slice(1) : c;
}

/** "2 more after this · all done in about 7:30" (null when nothing waits). */
export function afterLine(totals) {
  const q = totals?.queued || 0;
  if (!q) return null;
  const all = totals.etaMs ? ` · all done in ${totals.etaPartial ? "at least" : "about"} ${shortClock(totals.etaMs)}` : "";
  return `${q} more after this${all}`;
}

/** Progress for the bar: ComfyUI's per-node progress (nodes done + the running sampler's steps) where we have it, else
 *  the row's time-based percent, else the bare step count. null: no basis, the bar is indeterminate. */
export function progressOf(row) {
  const d = row?.detail;
  if (d?.total) {
    const p = Math.round((100 * (d.done + (d.steps ? d.step / d.steps : 0))) / d.total);
    return { pct: Math.max(0, Math.min(99, p)), from: "nodes" };
  }
  if (row?.pct != null) return { pct: row.pct, from: "time" };
  if (row?.steps) return { pct: Math.max(0, Math.min(99, Math.round((100 * row.step) / row.steps))), from: "steps" };
  return { pct: null, from: null };
}

/** Everything the running band shows, from one Activity row (`reg.view().running[i]`) and the view's totals. Both clocks:
 *  `elapsed` always; the time-left slot by mode: "eta" (mm:ss left, from this machine's runs), "guess" (mm:ss from the
 *  docs' numbers: no run measured here yet), "overdue" (no estimate left, +mm:ss past the usual), "learning" (nothing to
 *  go on). */
export function countdownModel(row, totals = null) {
  if (!row) return null;
  const el = row.elapsedMs ?? 0;
  const usual = Number.isFinite(row.predMs) ? row.predMs : Number.isFinite(row.etaAvgMs) ? row.etaAvgMs : null;
  const runs = row.estRuns ?? row.etaRuns ?? 0;
  const rem = row.remainingMs;
  const late = usual != null && el > usual ? `longer than usual +${fmtClock(el - usual)}` : "";
  let mode, leftLabel = "Time left", left, leftNote = "";
  if (rem != null) {
    mode = row.estSure === "rough" ? "guess" : late ? "late" : "eta";
    left = fmtClock(rem);
    if (row.remainingAtLeast) leftLabel = "Time left (at least)";
    const sure = row.estSure ? sureText({ ms: rem, pm: row.estPm, sure: row.estSure, runs })
      : row.remainingAtLeast ? "" : runs >= 3 ? "about" : runs ? `estimate from ${runs} run${runs === 1 ? "" : "s"}` : "";
    leftNote = [sure, late].filter(Boolean).join(" · ");
  } else if (late) {
    mode = "overdue"; leftLabel = "Longer than usual"; left = `+${fmtClock(el - usual)}`; leftNote = `usually ${fmtClock(usual)}`;
  } else {
    mode = "learning"; left = "Learning how long this takes";
  }
  const p = progressOf(row);
  return { id: row.id, own: !!row.own, title: row.name || "Render", stage: row.own ? row.detail?.stage || null : null,
    elapsed: fmtClock(el), mode, leftLabel, left, leftNote,
    pct: p.pct, from: p.from, indeterminate: p.pct == null, after: afterLine(totals), canStop: !!row.own };
}

/** The end state for a finished row: { state: "done"|"failed"|"stopped", big, line, took, reason }. */
export function finishModel(row) {
  if (!row || !row.endedAt) return null;
  const what = jobPhrase(row.name);
  const took = row.elapsedMs != null ? shortClock(row.elapsedMs) : null;
  const tk = took ? ` (${took})` : "";
  if (row.state === "done") return { id: row.id, state: "done", big: "Done", line: `Done: ${what}${tk}`, took, reason: null };
  if (row.state === "failed") return { id: row.id, state: "failed", big: "Failed", line: `Failed: ${what}${tk}`, took, reason: row.error || "Failed." };
  return { id: row.id, state: "stopped", big: "Stopped", line: `Stopped: ${what}${tk}`, took, reason: null };
}

// ---- Preferences (per viewer).
export function normalizeCountdownPrefs(p = {}) {
  const o = p && typeof p === "object" ? p : {};
  return { size: o.size === "small" ? "small" : "big", collapsed: !!o.collapsed };
}

export function loadCountdownPrefs(storage) {
  try {
    const s = storage === undefined ? globalThis.localStorage : storage;
    return normalizeCountdownPrefs(JSON.parse(s?.getItem(COUNTDOWN_KEY) || "{}"));
  } catch { return normalizeCountdownPrefs(); }
}

export function saveCountdownPrefs(p, storage) {
  try {
    const s = storage === undefined ? globalThis.localStorage : storage;
    s?.setItem(COUNTDOWN_KEY, JSON.stringify(normalizeCountdownPrefs(p)));
    return true;
  } catch { return false; /* storage blocked: this page only */ }
}

// ---- The band. Built with createElement and textContent only (job names come from other sessions' prompts).
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(cls, text, title) {
  const b = h("button", `ss-cd-btn ${cls}`, text);
  b.type = "button";
  if (title) { b.title = title; b.setAttribute("aria-label", title); }
  return b;
}

function clockBox(cls, label) {
  const box = h("div", `ss-cd-clock ${cls}`);
  const l = h("div", "ss-cd-label", label), v = h("div", "ss-cd-val"), n = h("div", "ss-cd-note");
  box.append(l, v, n);
  return { box, l, v, n };
}

/** The countdown band. onStop(row): the Activity's cancel. onWhy(): open the Activity panel (the full error and the
 *  failing node). sound: { on(): bool, toggle() } for the chime option. */
export function createCountdown({ onStop = null, onWhy = null, sound = null, storage = undefined,
  setT = (f, ms) => setTimeout(f, ms), clearT = (t) => clearTimeout(t) } = {}) {
  let prefs = loadCountdownPrefs(storage);
  const el = h("div", "ss-cd");
  el.setAttribute("role", "timer");
  el.setAttribute("aria-label", "Render countdown");
  el.hidden = true;
  const prevEl = h("div", "ss-cd-prev");   // "Done: Draft of shot 3 (2:41)" when the next queued render took over at once
  prevEl.hidden = true;
  const job = h("div", "ss-cd-job");
  const title = h("div", "ss-cd-title"), sub = h("div", "ss-cd-sub");
  job.append(prevEl, title, sub);
  const elapsed = clockBox("ss-cd-elapsed", "Elapsed");
  const left = clockBox("ss-cd-left", "Time left");
  const side = h("div", "ss-cd-side");
  const after = h("div", "ss-cd-after");
  const why = h("a", "ss-cd-why", "Why it failed");
  why.href = "#";
  const btns = h("div", "ss-cd-btns");
  const chime = button("ss-cd-chime", "", "");
  const stop = button("ss-cd-stop", "Stop", "Stop this render now");
  const sizeBtn = button("ss-cd-size", "", "");
  const foldBtn = button("ss-cd-fold", "–", "Collapse to a pill");
  const closeBtn = button("ss-cd-close", "×", "Close");
  btns.append(chime, stop, sizeBtn, foldBtn, closeBtn);
  side.append(after, why, btns);
  const main = h("div", "ss-cd-main");
  main.append(job, elapsed.box, left.box, side);
  const barEl = h("div", "ss-cd-bar"), fill = h("div", "ss-cd-fill");
  barEl.append(fill);
  barEl.setAttribute("role", "progressbar");
  barEl.setAttribute("aria-valuemin", "0");
  barEl.setAttribute("aria-valuemax", "100");
  const pill = button("ss-cd-pill", "", "Show the big countdown");
  el.append(main, barEl, pill);

  let tracked = null;        // the running row we show
  let fin = null, holdT = 0, dismissed = null, last = "", stopping = null, prev = null, prevT = 0, lastView = null;
  const savePrefs = (patch) => { prefs = normalizeCountdownPrefs({ ...prefs, ...patch }); saveCountdownPrefs(prefs, storage); };

  const paint = (m) => {
    const st = m.fin ? m.fin.state : "run";
    const size = prefs.collapsed ? "pill" : prefs.size;
    const key = JSON.stringify([m, st, size, stopping, prev?.line || null, sound ? !!sound.on() : null]);
    if (key === last) return;
    last = key;
    el.hidden = false;
    el.dataset.state = st;
    el.dataset.size = size;
    if (m.fin) {
      const f = m.fin;
      el.dataset.mode = f.state;
      title.textContent = f.line;
      sub.textContent = f.state === "failed" ? f.reason : "";
      elapsed.l.textContent = "Took"; elapsed.v.textContent = f.took || "--:--"; elapsed.n.textContent = "";
      left.l.textContent = f.state === "done" ? "Finished" : f.state === "failed" ? "Render failed" : "Stopped";
      left.v.textContent = f.big; left.n.textContent = "";
      after.textContent = m.after || "";
      why.hidden = f.state !== "failed";
      stop.hidden = true;
      el.dataset.indet = "false";
      fill.style.width = f.state === "done" ? "100%" : "0%";
      barEl.setAttribute("aria-valuenow", f.state === "done" ? "100" : "0");
      pill.textContent = f.line;
    } else {
      const r = m.run;
      el.dataset.mode = r.mode;
      title.textContent = r.title;
      sub.textContent = r.stage ? `on ${r.stage}` : r.own ? "" : "another session's render";
      elapsed.l.textContent = "Elapsed"; elapsed.v.textContent = r.elapsed; elapsed.n.textContent = "";
      left.l.textContent = r.leftLabel; left.v.textContent = r.left; left.n.textContent = r.leftNote;
      after.textContent = r.after || "";
      why.hidden = true;
      stop.hidden = !r.canStop || !onStop;
      stop.disabled = stopping === r.id;
      stop.textContent = stopping === r.id ? "Stopping…" : "Stop";
      el.dataset.indet = String(r.indeterminate);
      fill.style.width = r.indeterminate ? "" : `${r.pct}%`;
      if (r.indeterminate) barEl.removeAttribute("aria-valuenow"); else barEl.setAttribute("aria-valuenow", String(r.pct));
      const l = r.mode === "learning" ? "learning" : r.mode === "overdue" ? `${r.left} over` : `${r.left} left`;
      pill.textContent = `${r.title} · ${r.elapsed} · ${l}`;
    }
    const pl = !m.fin && prev ? prev.line : "";
    prevEl.hidden = !pl;
    prevEl.textContent = pl;
    if (prev) prevEl.dataset.state = prev.state;
    chime.hidden = !sound;
    if (sound) {
      const on = !!sound.on();
      chime.textContent = on ? "Chime on" : "Chime off";
      chime.setAttribute("aria-pressed", String(on));
      chime.title = on ? "A soft chime plays when a render finishes: click to mute" : "No chime when a render finishes: click to turn it on";
    }
    sizeBtn.textContent = prefs.size === "big" ? "A−" : "A+";
    sizeBtn.title = prefs.size === "big" ? "Smaller countdown" : "Bigger countdown";
    sizeBtn.setAttribute("aria-label", sizeBtn.title);
  };

  const hide = () => { if (!el.hidden) el.hidden = true; last = ""; };
  const clearHold = () => { if (holdT) { clearT(holdT); holdT = 0; } };
  const repaint = () => { last = ""; if (lastView) update(lastView); };
  const holdPrev = () => {
    if (prevT) clearT(prevT);
    prevT = setT(() => { prevT = 0; prev = null; repaint(); }, prev?.state === "done" ? HOLD_DONE_MS : HOLD_FAIL_MS);
  };

  function update(v) {
    lastView = v;
    const running = v?.running || [];
    const run = running.find((r) => r.own) || running[0] || null;
    if (run) {
      if (fin) { prev = fin; fin = null; clearHold(); holdPrev(); }
      if (tracked && tracked.id !== run.id) {
        dismissed = null;
        stopping = null;
        const old = (v.finished || []).find((r) => r.id === tracked.id);
        if (old) { prev = finishModel(old); holdPrev(); }
      }
      tracked = run;
      if (dismissed === run.id) { hide(); return; }
      paint({ run: countdownModel(run, v.totals), fin: null });
      return;
    }
    if (tracked) {
      const done = (v?.finished || []).find((r) => r.id === tracked.id);
      tracked = null;
      stopping = null;
      if (done) {
        fin = finishModel(done);
        clearHold();
        holdT = setT(() => { holdT = 0; fin = null; hide(); }, fin.state === "done" ? HOLD_DONE_MS : HOLD_FAIL_MS);
      }
    }
    if (fin && dismissed !== fin.id) { paint({ fin, after: afterLine(v?.totals) }); return; }
    if (!el.hidden) hide();
  }

  // ---- Controls.
  const stopEv = (e) => e.stopPropagation();
  for (const t of ["pointerdown", "wheel", "dblclick", "contextmenu"]) el.addEventListener(t, stopEv);
  sizeBtn.addEventListener("click", () => { savePrefs({ size: prefs.size === "big" ? "small" : "big", collapsed: false }); repaint(); });
  foldBtn.addEventListener("click", () => { savePrefs({ collapsed: true }); repaint(); });
  pill.addEventListener("click", () => { savePrefs({ collapsed: false }); repaint(); });
  closeBtn.addEventListener("click", () => {
    if (fin) { dismissed = fin.id; fin = null; clearHold(); hide(); return; }
    if (tracked) { dismissed = tracked.id; hide(); }
  });
  stop.addEventListener("click", () => {
    if (!tracked?.own || !onStop || stopping === tracked.id) return;
    stopping = tracked.id;
    repaint();
    Promise.resolve(onStop(tracked)).catch(() => {});
  });
  why.addEventListener("click", (e) => { e.preventDefault(); onWhy?.(); });
  chime.addEventListener("click", () => { sound?.toggle?.(); repaint(); });

  return {
    el, update,
    get prefs() { return { ...prefs }; },
    get holding() { return !!holdT; },
    dispose() { clearHold(); if (prevT) clearT(prevT); el.remove?.(); },
  };
}

// The band sits just above the top bar, a direct child of the App (.ss-stage). The App's modes (Cut, Script, Takes,
// Canvas ...) hide every child but their own view with ".ss-stage.ss-cutmode > :not(...)" rules: the long selector
// below outranks them so the countdown shows in every mode.
export const COUNTDOWN_CSS = `
.ss-stage > .ss-cd.ss-cd.ss-cd.ss-cd.ss-cd.ss-cd.ss-cd.ss-cd.ss-cd:not([hidden]) { display:flex !important; }
.ss-cd { flex:none; box-sizing:border-box; display:flex; flex-direction:column; gap:6px; margin:0 0 6px;
  padding:10px 14px 12px; border-radius:14px; background:var(--ss-card, #1b1e25); color:var(--ss-text, #eef0f4);
  border:1px solid var(--ss-line-strong, #4a505c); min-width:0; }
.ss-cd[hidden] { display:none !important; }
.ss-cd * { box-sizing:border-box; min-width:0; }
.ss-cd-main { display:flex; align-items:center; gap:10px 28px; flex-wrap:wrap; }
.ss-cd-job { flex:1 1 220px; display:flex; flex-direction:column; gap:2px; }
.ss-cd-title { font-weight:700; font-size:20px; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd-sub { font-size:13px; color:var(--ss-muted, #a9afba); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd[data-state=failed] .ss-cd-sub { color:#ef8a7a; white-space:normal; }
.ss-cd-prev { font-size:12px; font-weight:600; color:var(--ss-accent, #e7f06a); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd-prev[data-state=failed] { color:#ef8a7a; }
.ss-cd-prev[hidden] { display:none !important; }
.ss-cd-clock { flex:none; display:flex; flex-direction:column; align-items:flex-start; }
.ss-cd-label { font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--ss-muted, #a9afba); white-space:nowrap; }
.ss-cd-val { font-size:56px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.01em; white-space:nowrap; }
.ss-cd-note { font-size:12px; color:var(--ss-muted, #a9afba); white-space:nowrap; min-height:1em; }
.ss-cd-elapsed .ss-cd-val { color:var(--ss-text, #fff); }
.ss-cd-left .ss-cd-val { color:var(--ss-accent, #e7f06a); }
.ss-cd[data-mode=guess] .ss-cd-left .ss-cd-val { opacity:.8; }
.ss-cd[data-mode=learning] .ss-cd-left .ss-cd-val { font-size:22px; line-height:1.25; color:var(--ss-muted, #c9ced6); white-space:normal; max-width:12em; }
.ss-cd[data-mode=overdue] .ss-cd-left .ss-cd-val, .ss-cd[data-mode=late] .ss-cd-left .ss-cd-note { color:#f0b45a; }
.ss-cd[data-mode=failed] .ss-cd-left .ss-cd-val { color:#ef8a7a; }
.ss-cd-side { flex:0 1 auto; display:flex; flex-direction:column; align-items:flex-end; gap:6px; margin-left:auto; }
.ss-cd-after { font-size:15px; font-weight:700; white-space:nowrap; }
.ss-cd-after:empty { display:none; }
.ss-cd-why { color:#ef8a7a; font-weight:600; white-space:nowrap; }
.ss-cd-btns { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.ss-cd-why[hidden], .ss-cd .ss-cd-btn[hidden] { display:none !important; }
.ss-cd .ss-cd-btn { padding:3px 10px !important; font-size:12px !important; line-height:1.3; flex:none; cursor:pointer; }
.ss-cd .ss-cd-stop { background:#5a2a26 !important; border-color:#8a4038 !important; color:#ffd9d2 !important; font-weight:700 !important; padding:5px 16px !important; font-size:14px !important; }
.ss-cd-bar { height:10px; border-radius:5px; background:rgba(128,128,128,.28); overflow:hidden; }
.ss-cd-fill { height:100%; width:0; background:var(--ss-accent, #e39a40); border-radius:5px; transition:width .9s linear; }
.ss-cd[data-indet=true] .ss-cd-fill { width:30%; animation:ss-cd-slide 2.4s ease-in-out infinite alternate; transition:none; }
@keyframes ss-cd-slide { from { margin-left:0; } to { margin-left:70%; } }
.ss-cd .ss-cd-pill { display:none !important; }
.ss-cd[data-size=small] { padding:6px 10px 8px; gap:4px; }
.ss-cd[data-size=small] .ss-cd-main { gap:6px 18px; }
.ss-cd[data-size=small] .ss-cd-title { font-size:14px; }
.ss-cd[data-size=small] .ss-cd-val { font-size:28px; }
.ss-cd[data-size=small][data-mode=learning] .ss-cd-left .ss-cd-val { font-size:14px; }
.ss-cd[data-size=small] .ss-cd-label, .ss-cd[data-size=small] .ss-cd-note { font-size:10px; }
.ss-cd[data-size=small] .ss-cd-after { font-size:13px; }
.ss-cd[data-size=small] .ss-cd-bar { height:6px; }
.ss-cd[data-size=pill] { flex:none; align-self:flex-start; max-width:100%; padding:3px; border-radius:999px; margin:0 0 4px; }
.ss-cd[data-size=pill] > :not(.ss-cd-pill) { display:none !important; }
.ss-cd[data-size=pill] .ss-cd-pill { display:inline-flex !important; max-width:100%; font-weight:700 !important; font-variant-numeric:tabular-nums;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:4px 14px !important; font-size:14px !important; }
/* Phone width: the job on its own line, the two clocks side by side, the buttons under them. */
@media (max-width: 600px) {
  .ss-cd { padding:8px 10px 10px; }
  .ss-cd-main { gap:6px 16px; }
  .ss-cd-job { flex:1 0 100%; }
  .ss-cd-title { font-size:16px; }
  .ss-cd-clock { flex:1 1 40%; }
  .ss-cd-val { font-size:40px; }
  .ss-cd-note { white-space:normal; }
  .ss-cd[data-mode=learning] .ss-cd-left .ss-cd-val { font-size:15px; }
  .ss-cd-side { flex:1 0 100%; flex-direction:row; align-items:center; justify-content:space-between; margin-left:0; flex-wrap:wrap; }
  .ss-cd-after { white-space:normal; }
}
@media (prefers-reduced-motion: reduce) {
  .ss-cd-fill { transition:none; }
  .ss-cd[data-indet=true] .ss-cd-fill { animation:none; width:100%; opacity:.35; }
}
`;
