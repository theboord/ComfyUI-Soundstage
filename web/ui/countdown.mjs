// The big render countdown (Mike 2026-11-08: "is there a big timer/countdown in the app yet?"): a card over a corner
// of the stage view, readable from across the room, while any render runs. Big mm:ss TIME LEFT from the Activity's
// EtaBook ("Learning how long this takes" with the elapsed time until the book has a run of this kind; "Longer than
// usual +mm:ss" past the average), the job and shot, a progress bar (ComfyUI's per-node progress where we have it, else
// time-based), "2 more after this", and Stop (the Activity's own cancel path). When it ends: "Done: Draft of shot 3
// (2:41)" for a few seconds, or "Failed" with a link to the reason, then it hides.
//
// No clock of its own: activity.mjs calls update(view) from the same draw that its 1 s clock (on only while a job runs)
// and the registry's changes already drive. At idle nothing ticks and an update writes nothing. The one timer here is a
// one-shot setTimeout that hides the Done / Failed card.
//
//   countdownModel(row, totals) / finishModel(row) / afterLine(totals)   pure words and numbers (tests/js/countdown.test.mjs)
//   loadCountdownPrefs() / saveCountdownPrefs(p)                         per viewer, localStorage in try/catch
//   nearestCorner(x, y, w, h) / fitSize(size, hostW, hostH) / clearOfCenter(box, host)   placement
//   createCountdown({ host, onStop, onWhy, sound })                      -> { el, update(view), dispose() }
import { fmtClock } from "./jobTimer.mjs";

export const COUNTDOWN_KEY = "ss_countdown_prefs";
export const CORNERS = ["bl", "br", "tl", "tr"];
export const DEFAULT_COUNTDOWN = { size: "big", collapsed: false, corner: "bl" };
export const HOLD_DONE_MS = 6000;     // the Done card stays this long
export const HOLD_FAIL_MS = 15000;    // a failure stays longer (it has a reason to read); × closes it sooner
export const MARGIN = 10;             // px from the stage view's edges

// The card's nominal size per mode (the CSS fixes widths and one line per row, so these hold).
export const SIZES = { big: { w: 340, h: 196 }, small: { w: 236, h: 118 }, pill: { w: 190, h: 36 } };

// ---- Words.
/** "Draft · shot 3" -> "Draft of shot 3" (the App names its renders "<step> · shot <name>"). */
export function jobPhrase(name) {
  const n = String(name || "Render").trim();
  return n.replace(/ · shot /, " of shot ");
}

/** m:ss for the Done line ("2:41"), h:mm:ss past an hour. */
export function shortClock(ms) {
  const c = fmtClock(ms);
  return c.startsWith("0") && /^\d\d:\d\d$/.test(c) ? c.slice(1) : c;
}

/** "2 more after this" / "1 more after this" (null when nothing waits). */
export function afterLine(totals) {
  const q = totals?.queued || 0;
  return q ? `${q} more after this` : null;
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

/** Everything the running card shows, from one Activity row (`reg.view().running[i]`) and the view's totals.
 *  mode: "eta" (big = time left), "learning" (no run of this kind measured yet: big = elapsed), "overdue" (past the
 *  average: big = +how far past). */
export function countdownModel(row, totals = null) {
  if (!row) return null;
  const el = row.elapsedMs ?? 0;
  const avg = Number.isFinite(row.etaAvgMs) ? row.etaAvgMs : null;
  const runs = row.etaRuns || 0;
  const rem = row.remainingMs;
  let mode, big, label;
  const sub = [];
  if (avg != null && el > avg) {
    mode = "overdue"; big = `+${fmtClock(el - avg)}`; label = "Longer than usual";
    sub.push(`${fmtClock(el)} so far`, `usually ${fmtClock(avg)}`);
    if (rem != null && row.remainingAtLeast) sub.push(`at least ${fmtClock(rem)} left`);
  } else if (avg != null && runs > 0 && rem != null) {
    mode = "eta"; big = fmtClock(rem); label = row.remainingAtLeast ? "Time left (at least)" : "Time left";
    sub.push(`${fmtClock(el)} so far`);
    if (runs < 3) sub.push(`estimate from ${runs} run${runs === 1 ? "" : "s"}`);
  } else {
    mode = "learning"; big = fmtClock(el); label = "Learning how long this takes";
    sub.push("elapsed");
    if (rem != null && row.remainingAtLeast) sub.push(`at least ${fmtClock(rem)} left`);
  }
  const p = progressOf(row);
  const stage = row.own ? row.detail?.stage || null : null;
  return { id: row.id, own: !!row.own, title: row.name || "Render", mode, big, label, sub: sub.join(" · "),
    stage, pct: p.pct, from: p.from, indeterminate: p.pct == null, after: afterLine(totals), canStop: !!row.own };
}

/** The end card for a finished row: { state: "done"|"failed"|"stopped", big, line, reason }. */
export function finishModel(row) {
  if (!row || !row.endedAt) return null;
  const what = jobPhrase(row.name);
  const took = row.elapsedMs != null ? ` (${shortClock(row.elapsedMs)})` : "";
  if (row.state === "done") return { id: row.id, state: "done", big: "Done", line: `Done: ${what}${took}`, reason: null };
  if (row.state === "failed") return { id: row.id, state: "failed", big: "Failed", line: `Failed: ${what}${took}`, reason: row.error || "Failed." };
  return { id: row.id, state: "stopped", big: "Stopped", line: `Stopped: ${what}${took}`, reason: null };
}

// ---- Preferences (per viewer).
export function normalizeCountdownPrefs(p = {}) {
  const o = p && typeof p === "object" ? p : {};
  return { size: o.size === "small" ? "small" : "big", collapsed: !!o.collapsed,
    corner: CORNERS.includes(o.corner) ? o.corner : DEFAULT_COUNTDOWN.corner };
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

// ---- Placement.
/** The corner nearest a point in a w×h host. */
export function nearestCorner(x, y, w, h) {
  return `${y < h / 2 ? "t" : "b"}${x < w / 2 ? "l" : "r"}`;
}

/** The box (host coordinates) of a w×h card in a corner. */
export function boxAt(corner, w, h, hostW, hostH, m = MARGIN) {
  const cw = Math.min(w, Math.max(0, hostW - 2 * m));
  return { x: corner[1] === "l" ? m : hostW - m - cw, y: corner[0] === "t" ? m : hostH - m - h, w: cw, h };
}

/** True when the box stays clear of the middle of the host (the central 20 % each way: the shot's centre). */
export function clearOfCenter(b, hostW, hostH) {
  const cx0 = hostW * 0.4, cx1 = hostW * 0.6, cy0 = hostH * 0.4, cy1 = hostH * 0.6;
  return b.x + b.w <= cx0 || b.x >= cx1 || b.y + b.h <= cy0 || b.y >= cy1;
}

/** The size that fits in a corner without covering the centre: the viewer's choice, else smaller, else the pill.
 *  An unknown host size (0) keeps the choice. */
export function fitSize(want, hostW, hostH, corner = "bl") {
  if (!(hostW > 0 && hostH > 0)) return want;
  const order = want === "pill" ? ["pill"] : want === "small" ? ["small", "pill"] : ["big", "small", "pill"];
  for (const s of order) {
    const z = SIZES[s];
    if (z.h + 2 * MARGIN > hostH) continue;
    if (clearOfCenter(boxAt(corner, z.w, z.h, hostW, hostH), hostW, hostH)) return s;
  }
  return "pill";
}

// ---- The card. Built with createElement and textContent only (job names come from other sessions' prompts).
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

/** The countdown card in `host` (the stage view). onStop(row): the Activity's cancel. onWhy(): open the Activity panel
 *  (where the full error and the failing node are). sound: { on(): bool, toggle() } for the chime option. */
export function createCountdown({ host, onStop = null, onWhy = null, sound = null, storage = undefined,
  setT = (f, ms) => setTimeout(f, ms), clearT = (t) => clearTimeout(t), win = globalThis.window } = {}) {
  let prefs = loadCountdownPrefs(storage);
  const el = h("div", "ss-cd");
  el.setAttribute("role", "timer");
  el.setAttribute("aria-label", "Render countdown");
  el.hidden = true;
  const head = h("div", "ss-cd-head");
  const title = h("span", "ss-cd-title");
  const sizeBtn = button("ss-cd-size", "", "");
  const foldBtn = button("ss-cd-fold", "–", "Collapse to a pill");
  const closeBtn = button("ss-cd-close", "×", "Close");
  head.append(title, sizeBtn, foldBtn, closeBtn);
  const label = h("div", "ss-cd-label");
  const big = h("div", "ss-cd-big");
  const barEl = h("div", "ss-cd-bar"), fill = h("div", "ss-cd-fill");
  barEl.append(fill);
  barEl.setAttribute("role", "progressbar");
  barEl.setAttribute("aria-valuemin", "0");
  barEl.setAttribute("aria-valuemax", "100");
  const sub = h("div", "ss-cd-sub");
  const foot = h("div", "ss-cd-foot");
  const after = h("span", "ss-cd-after");
  const why = h("a", "ss-cd-why", "Why it failed");
  why.href = "#";
  const chime = button("ss-cd-chime", "", "");
  const stop = button("ss-cd-stop", "Stop", "Stop this render now");
  foot.append(after, why, chime, stop);
  const pill = button("ss-cd-pill", "", "Show the big countdown");
  const prevEl = h("div", "ss-cd-prev");   // "Done: Draft of shot 3 (2:41)" when the next queued render took over at once
  prevEl.hidden = true;
  el.append(prevEl, head, label, big, barEl, sub, foot, pill);
  host?.append?.(el);

  let tracked = null;        // the running row we show
  let fin = null, holdT = 0, dismissed = null, last = "", stopping = null, prev = null, prevT = 0;
  let hostW = 0, hostH = 0;
  const savePrefs = (patch) => { prefs = normalizeCountdownPrefs({ ...prefs, ...patch }); saveCountdownPrefs(prefs, storage); };

  const paint = (m) => {
    const st = m.fin ? m.fin.state : "run";
    const want = prefs.collapsed ? "pill" : prefs.size;
    const size = fitSize(want, hostW, hostH, prefs.corner);
    const key = JSON.stringify([m, st, size, prefs, stopping, prev?.line || null]);
    if (key === last) return;
    last = key;
    el.hidden = false;
    el.dataset.state = st;
    el.dataset.size = size;
    el.dataset.corner = prefs.corner;
    if (m.fin) {
      const f = m.fin;
      title.textContent = f.line;
      label.textContent = f.state === "failed" ? "Render failed" : f.state === "done" ? "Finished" : "Stopped";
      big.textContent = f.big;
      sub.textContent = f.state === "failed" ? f.reason : "";
      after.textContent = m.after || "";
      why.hidden = f.state !== "failed";
      stop.hidden = true;
      el.dataset.indet = "false";
      fill.style.width = f.state === "done" ? "100%" : "0%";
      barEl.setAttribute("aria-valuenow", f.state === "done" ? "100" : "0");
      pill.textContent = f.line;
    } else {
      const r = m.run;
      title.textContent = r.title;
      label.textContent = r.label;
      big.textContent = r.big;
      sub.textContent = [r.stage ? `on ${r.stage}` : "", r.sub].filter(Boolean).join(" · ");
      after.textContent = r.after || "";
      why.hidden = true;
      stop.hidden = !r.canStop || !onStop;
      stop.disabled = stopping === r.id;
      stop.textContent = stopping === r.id ? "Stopping…" : "Stop";
      el.dataset.mode = r.mode;
      el.dataset.indet = String(r.indeterminate);
      fill.style.width = r.indeterminate ? "" : `${r.pct}%`;
      if (r.indeterminate) barEl.removeAttribute("aria-valuenow"); else barEl.setAttribute("aria-valuenow", String(r.pct));
      pill.textContent = `${r.big} · ${r.title}`;
    }
    const pl = !m.fin && prev ? prev.line : "";
    prevEl.hidden = !pl;
    prevEl.textContent = pl;
    if (prev) prevEl.dataset.state = prev.state;
    chime.hidden = !sound;
    if (sound) { const on = !!sound.on(); chime.textContent = on ? "Chime on" : "Chime off"; chime.setAttribute("aria-pressed", String(on)); chime.title = on ? "A soft chime plays when a render finishes: click to mute" : "No chime when a render finishes: click to turn it on"; }
    sizeBtn.textContent = prefs.size === "big" ? "A−" : "A+";
    sizeBtn.title = prefs.size === "big" ? "Smaller countdown" : "Bigger countdown";
    sizeBtn.setAttribute("aria-label", sizeBtn.title);
    sizeBtn.hidden = size === "pill" && !prefs.collapsed;
  };

  const hide = () => {
    if (!el.hidden) el.hidden = true;
    last = "";
  };
  const clearHold = () => { if (holdT) { clearT(holdT); holdT = 0; } };
  const holdPrev = () => {
    if (prevT) clearT(prevT);
    prevT = setT(() => { prevT = 0; prev = null; repaint(); }, prev?.state === "done" ? HOLD_DONE_MS : HOLD_FAIL_MS);
  };

  let lastView = null;
  const update = (v) => {
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
  };
  const repaint = () => { last = ""; if (lastView) update(lastView); };

  // ---- Controls.
  const stopEv = (e) => e.stopPropagation();
  for (const t of ["pointerdown", "wheel", "dblclick", "contextmenu"]) el.addEventListener(t, stopEv);
  sizeBtn.addEventListener("click", () => { savePrefs({ size: prefs.size === "big" ? "small" : "big", collapsed: false }); repaint(); });
  foldBtn.addEventListener("click", () => { savePrefs({ collapsed: true }); repaint(); });
  pill.addEventListener("click", () => { if (dragged) return; savePrefs({ collapsed: false }); repaint(); });
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

  // Drag anywhere on the card but its buttons; on release it snaps to the nearest corner (so it never sits over the
  // middle of the shot) and the corner is saved for this viewer.
  let drag = null, dragged = false;
  el.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    if (e.target?.closest?.(".ss-cd-btn:not(.ss-cd-pill), a")) return;
    const hr = host?.getBoundingClientRect?.(), er = el.getBoundingClientRect?.();
    if (!hr || !er) return;
    drag = { x: e.clientX, y: e.clientY, hr, er, id: e.pointerId };
    dragged = false;
    try { el.setPointerCapture?.(e.pointerId); } catch { /* fine */ }
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    el.dataset.drag = "true";
    el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    try { el.releasePointerCapture?.(d.id); } catch { /* fine */ }
    if (!dragged) return;
    const cx = d.er.left + d.er.width / 2 + (e.clientX - d.x) - d.hr.left, cy = d.er.top + d.er.height / 2 + (e.clientY - d.y) - d.hr.top;
    el.style.transform = "";
    delete el.dataset.drag;
    savePrefs({ corner: nearestCorner(cx, cy, d.hr.width, d.hr.height) });
    repaint();
    setT(() => { dragged = false; }, 0);   // the click that follows a drag is not a pill click
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);

  // The host's size, for fitSize: a ResizeObserver (no polling); without one, measured when the card first shows.
  let ro = null;
  const measure = () => {
    const w = host?.clientWidth || 0, hh = host?.clientHeight || 0;
    if (w !== hostW || hh !== hostH) { hostW = w; hostH = hh; if (!el.hidden) repaint(); }
  };
  try {
    const RO = win?.ResizeObserver || globalThis.ResizeObserver;
    if (RO && host) { ro = new RO(() => measure()); ro.observe(host); }
  } catch { ro = null; }
  if (!ro) measure();

  return {
    el, update,
    get prefs() { return { ...prefs }; },
    get holding() { return !!holdT; },
    dispose() { clearHold(); if (prevT) clearT(prevT); try { ro?.disconnect?.(); } catch { /* fine */ } el.remove?.(); },
  };
}

export const COUNTDOWN_CSS = `
.ss-cd { position:absolute; z-index:40; box-sizing:border-box; width:340px; max-width:calc(100% - ${2 * MARGIN}px);
  display:flex; flex-direction:column; gap:4px; padding:10px 14px 12px; border-radius:14px; cursor:grab; touch-action:none;
  background:color-mix(in srgb, var(--ss-bg, #111318) 84%, transparent); color:var(--ss-text, #eef0f4);
  border:1px solid var(--ss-line-strong, #4a505c); box-shadow:0 10px 30px rgba(0,0,0,.45); user-select:none;
  backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); }
.ss-cd[hidden] { display:none !important; }
.ss-cd[data-corner=bl] { left:${MARGIN}px; bottom:${MARGIN}px; }
.ss-cd[data-corner=br] { right:${MARGIN}px; bottom:${MARGIN}px; }
.ss-cd[data-corner=tl] { left:${MARGIN}px; top:${MARGIN}px; }
.ss-cd[data-corner=tr] { right:${MARGIN}px; top:${MARGIN}px; }
.ss-cd[data-drag=true] { cursor:grabbing; opacity:.92; transition:none; }
.ss-cd * { box-sizing:border-box; min-width:0; }
.ss-cd-prev { font-size:12px; font-weight:600; color:var(--ss-accent, #e7f06a); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd-prev[data-state=failed] { color:#ef8a7a; }
.ss-cd-prev[hidden] { display:none !important; }
.ss-cd-head { display:flex; align-items:center; gap:6px; }
.ss-cd-title { flex:1; font-weight:700; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd .ss-cd-btn { padding:2px 9px !important; font-size:12px !important; line-height:1.3; flex:none; cursor:pointer; }
.ss-cd-label { font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--ss-muted, #a9afba);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd-big { font-size:64px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:.01em;
  white-space:nowrap; overflow:hidden; color:var(--ss-text, #fff); }
.ss-cd[data-mode=overdue] .ss-cd-big { color:#f0b45a; }
.ss-cd[data-mode=learning] .ss-cd-big { color:var(--ss-muted, #c9ced6); }
.ss-cd[data-state=done] .ss-cd-big { color:var(--ss-accent, #e7f06a); }
.ss-cd[data-state=failed] .ss-cd-big { color:#ef8a7a; }
.ss-cd-bar { height:8px; border-radius:4px; background:rgba(128,128,128,.28); overflow:hidden; margin:4px 0 2px; }
.ss-cd-fill { height:100%; width:0; background:var(--ss-accent, #e39a40); border-radius:4px; transition:width .9s linear; }
.ss-cd[data-indet=true] .ss-cd-fill { width:30%; animation:ss-cd-slide 2.4s ease-in-out infinite alternate; transition:none; }
@keyframes ss-cd-slide { from { margin-left:0; } to { margin-left:70%; } }
.ss-cd-sub { font-size:12px; color:var(--ss-muted, #a9afba); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd[data-state=failed] .ss-cd-sub { color:#ef8a7a; white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.ss-cd-foot { display:flex; align-items:center; gap:8px; font-size:13px; }
.ss-cd-after { flex:1; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cd-why { color:#ef8a7a; font-weight:600; white-space:nowrap; }
.ss-cd-why[hidden], .ss-cd .ss-cd-btn[hidden] { display:none !important; }
.ss-cd .ss-cd-stop { background:#5a2a26 !important; border-color:#8a4038 !important; color:#ffd9d2 !important; font-weight:700 !important; }
.ss-cd .ss-cd-pill { display:none !important; }
.ss-cd[data-size=small] { width:236px; padding:8px 10px 10px; }
.ss-cd[data-size=small] .ss-cd-big { font-size:38px; }
.ss-cd[data-size=small] .ss-cd-title { font-size:12px; }
.ss-cd[data-size=small] .ss-cd-label, .ss-cd[data-size=small] .ss-cd-sub { font-size:11px; }
.ss-cd[data-size=small] .ss-cd-bar { height:6px; }
.ss-cd[data-size=small] .ss-cd-foot { font-size:12px; }
.ss-cd[data-size=pill] { width:auto; max-width:min(260px, calc(100% - ${2 * MARGIN}px)); padding:4px; border-radius:999px; }
.ss-cd[data-size=pill] > :not(.ss-cd-pill) { display:none !important; }
.ss-cd[data-size=pill] .ss-cd-pill { display:inline-flex !important; max-width:100%; font-weight:700 !important; font-variant-numeric:tabular-nums;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:4px 12px !important; font-size:13px !important; }
@media (prefers-reduced-motion: reduce) {
  .ss-cd-fill { transition:none; }
  .ss-cd[data-indet=true] .ss-cd-fill { animation:none; width:100%; opacity:.35; }
}
`;
