// Bring a video into 3D: the one obvious way in. A clip can become the whole set (Video → Stage: location, camera move
// and the performer via SAM 3D Body) or a motion take on a person (Capture motion). This module is the UI around it:
// the "which one?" dialog, the drop target over the 3D view, and a progress / result card with elapsed time and an
// estimate. Pure DOM, no server calls (web/soundstage.js does the work).
import { icon } from "./icons.mjs";

const CSS = `
.ss-vi-modal { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; padding:16px;
  background:rgba(8,6,12,.72); backdrop-filter:blur(4px); font:13px/1.45 "Soundstage Grotesk", -apple-system, system-ui, sans-serif; color:#f0efed; }
.ss-vi-modal .card { width:min(560px, 100%); background:#1d1722; border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:18px;
  display:flex; flex-direction:column; gap:12px; box-shadow:0 30px 80px rgba(0,0,0,.55); }
.ss-vi-modal h3 { margin:0; font-size:17px; display:flex; gap:8px; align-items:center; }
.ss-vi-modal .file { color:#a9a3ad; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-vi-modal .opt { display:flex; gap:12px; align-items:flex-start; text-align:left; width:100%; cursor:pointer; font:inherit; color:inherit;
  background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.12); border-radius:12px; padding:12px; }
.ss-vi-modal .opt:hover, .ss-vi-modal .opt:focus-visible { border-color:#F2FF59; background:rgba(242,255,89,.07); outline:none; }
.ss-vi-modal .opt.def { border-color:rgba(242,255,89,.55); }
.ss-vi-modal .opt b { display:block; font-size:14px; margin-bottom:2px; }
.ss-vi-modal .opt span.d { color:#a9a3ad; }
.ss-vi-modal .opt .ic { flex:0 0 auto; color:#F2FF59; margin-top:2px; }
.ss-vi-modal .row { display:flex; justify-content:space-between; align-items:center; gap:8px; }
.ss-vi-modal .tip { color:#a9a3ad; font-size:12px; }
.ss-vi-modal button.cancel { background:transparent; color:#f0efed; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:7px 14px; cursor:pointer; font:inherit; }
.ss-vi-drop { position:absolute; inset:6px; z-index:20; display:none; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:16px;
  border:3px dashed #F2FF59; border-radius:12px; background:rgba(20,14,26,.78); color:#F2FF59; font:600 18px/1.35 "Soundstage Grotesk", system-ui, sans-serif; pointer-events:none; }
.ss-vi-drop small { display:block; font-weight:400; font-size:13px; color:#f0efed; margin-top:6px; }
.ss-vi-drop[data-on=true] { display:flex; }
.ss-vi-cta { position:absolute; left:10px; bottom:10px; z-index:6; display:flex; align-items:center; gap:6px; max-width:calc(100% - 20px);
  padding:6px 12px 6px 10px; border-radius:999px; border:1px dashed rgba(242,255,89,.7); background:rgba(20,14,26,.82); color:#F2FF59 !important;
  font:600 12px/1.2 "Soundstage Grotesk", system-ui, sans-serif; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-vi-cta:hover { background:rgba(242,255,89,.14); }
.ss-vi-cta span { overflow:hidden; text-overflow:ellipsis; }
.ss-vi-cta[data-big=true] { left:50%; top:50%; bottom:auto; transform:translate(-50%,-50%); flex-direction:column; white-space:normal; text-align:center;
  border-radius:16px; padding:16px 20px; gap:6px; font-size:15px; width:min(360px, calc(100% - 24px)); }
.ss-vi-cta[data-big=true] small { font-weight:400; color:#f0efed; font-size:12px; }
.ss-vi-cta small { display:none; }
.ss-vi-cta[data-big=true] small { display:block; }
.ss-vi-job { position:absolute; left:10px; bottom:10px; z-index:21; width:min(400px, calc(100% - 20px));
  background:rgba(24,18,30,.94); border:1px solid rgba(242,255,89,.35); border-radius:14px; padding:12px 14px; display:flex; flex-direction:column; gap:7px;
  font:13px/1.4 "Soundstage Grotesk", system-ui, sans-serif; color:#f0efed; box-shadow:0 12px 40px rgba(0,0,0,.45); }
.ss-vi-job .t { font-weight:650; font-size:14px; display:flex; gap:7px; align-items:center; }
.ss-vi-job .s { color:#d8d4dc; font-size:12px; }
.ss-vi-job[data-state=done] { background:rgba(24,18,30,.86); }
.ss-vi-job .m { color:#a9a3ad; font-size:12px; font-variant-numeric:tabular-nums; }
.ss-vi-job .bar { height:6px; border-radius:99px; background:rgba(255,255,255,.1); overflow:hidden; }
.ss-vi-job .bar i { display:block; height:100%; width:0; background:#F2FF59; border-radius:99px; transition:width .6s ease; }
.ss-vi-job .acts { display:flex; gap:8px; flex-wrap:wrap; }
.ss-vi-job .acts button { font:600 12px/1 "Soundstage Grotesk", system-ui, sans-serif; border-radius:999px; padding:8px 12px; cursor:pointer;
  border:1px solid rgba(255,255,255,.18); background:transparent; color:#f0efed; display:flex; gap:6px; align-items:center; }
.ss-vi-job .acts button.go { background:#F2FF59 !important; color:#1a1420 !important; border-color:#F2FF59 !important; }
.ss-vi-job .x { position:absolute; top:6px; right:8px; background:none !important; border:0 !important; color:#a9a3ad; cursor:pointer; font-size:16px; padding:2px 4px; }
.ss-vi-job[data-state=error] { border-color:#ff6b5e; }
.ss-vi-job[data-state=error] .t { color:#ff8a7e; }
.ss-vi-job details { color:#a9a3ad; font-size:11px; }
.ss-vi-job details summary { cursor:pointer; }
.ss-vi-head, .ss-stage button.ss-vi-head, .ss-stage button.ss-vi-head:hover:not(:disabled) { background:#F2FF59 !important; color:#1a1420 !important;
  border:1px solid #F2FF59 !important; border-radius:999px !important; padding:5px 12px !important; font-weight:700 !important;
  display:inline-flex; gap:6px; align-items:center; white-space:nowrap; cursor:pointer; flex:0 0 auto; }
.ss-stage button.ss-vi-head:hover:not(:disabled) { filter:brightness(1.08); }
.ss-stage button.ss-vi-cta { background:rgba(20,14,26,.82) !important; border:1px dashed rgba(242,255,89,.7) !important; color:#F2FF59 !important;
  font-weight:600 !important; padding:6px 12px 6px 10px !important; }
.ss-stage button.ss-vi-cta:hover:not(:disabled) { background:rgba(46,40,24,.92) !important; border-color:#F2FF59 !important; }
.ss-stage button.ss-vi-cta[data-big=true] { padding:16px 20px !important; border-radius:16px !important; }
`;

export function ensureCss() {
  if (document.getElementById("ss-vi-css")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "ss-vi-css", textContent: CSS }));
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|mxf|avi|r3d|braw|ari|arx|crm|nev)$/i;
/** Is this dropped/picked file a video clip? */
export const isVideoFile = (f) => !!f && (String(f.type || "").startsWith("video/") || VIDEO_EXT.test(f.name || ""));

/** The clip's length in seconds (from the browser's own decoder), or 0 when it can't tell. */
export function clipSeconds(file) {
  return new Promise((ok) => {
    try {
      const v = document.createElement("video");
      const url = URL.createObjectURL(file);
      const done = (s) => { URL.revokeObjectURL(url); ok(Number.isFinite(s) && s > 0 ? s : 0); };
      v.preload = "metadata";
      v.onloadedmetadata = () => done(v.duration);
      v.onerror = () => done(0);
      setTimeout(() => done(0), 4000);
      v.src = url;
    } catch { ok(0); }
  });
}

/**
 * Ask what the clip is for. person = the selected (or first) person's name, or null.
 * Resolves "stage" | "capture" | "ripple" | null (cancelled). Default: Video → Stage, unless someone is selected.
 */
export function chooseVideoUse(file, { person = null, selected = false } = {}) {
  ensureCss();
  return new Promise((resolve) => {
    const wrap = Object.assign(document.createElement("div"), { className: "ss-vi-modal" });
    const card = Object.assign(document.createElement("div"), { className: "card" });
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "What is this video for?");
    const h3 = document.createElement("h3");
    h3.append(icon("file-video-camera", 20), "What is this video for?");
    const name = Object.assign(document.createElement("div"), { className: "file", textContent: file?.name || "" });
    const opt = (k, ic, title, desc) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "opt" });
      b.dataset.choice = k;
      const t = document.createElement("div");
      t.append(Object.assign(document.createElement("b"), { textContent: title }), Object.assign(document.createElement("span"), { className: "d", textContent: desc }));
      const i = Object.assign(document.createElement("span"), { className: "ic" });
      i.append(icon(ic, 22));
      b.append(i, t);
      b.addEventListener("click", () => done(k));
      return b;
    };
    const stageOpt = opt("stage", "clapperboard", "Rebuild this clip as a 3D set (Video → Stage)",
      "The location, the camera move and the performer (SAM 3D Body motion capture) land on the stage. About 2–3 min.");
    const who = person ? `on ${person}` : "on a person";
    const capOpt = opt("capture", "person-standing", `Put this motion ${who} (Capture motion)`,
      `SAM 3D Body copies the performance (body, hands, path) onto ${person || "a clay person"}, right where they stand in your set. About 1 min.`);
    const ripOpt = opt("ripple", "wand-sparkles", "Edit this clip with Ripple (keep the footage)",
      "Change frame 1 in Paint Studio (a different person, wardrobe, night) and LTX Ripple carries it through the whole clip with its motion and sound. Opens ⑤ Motion.");
    const def = selected ? capOpt : stageOpt;
    def.classList.add("def");
    const tip = Object.assign(document.createElement("div"), { className: "tip",
      textContent: "Best: one person, head to toe in frame, 3–10 s." });
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "cancel", textContent: "Cancel" });
    cancel.addEventListener("click", () => done(null));
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.append(tip, cancel);
    card.append(h3, name, stageOpt, capOpt, ripOpt, row);
    wrap.append(card);
    for (const ev of ["pointerdown", "keydown", "wheel"]) wrap.addEventListener(ev, (e) => e.stopPropagation());
    wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    wrap.addEventListener("click", (e) => { if (e.target === wrap) done(null); });
    document.body.append(wrap);
    def.focus();
    function done(v) { wrap.remove(); resolve(v); }
  });
}

/** Turn a number of seconds into "1 min 20 s" / "45 s". */
export function fmtSecs(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/**
 * Video → Stage's steps, in order, with a typical time each (RTX-class GPU, warm-ish). frames = the clip's frame count;
 * motion capture scales with it. Used for the bar and the estimate: the server only names the step it is on.
 */
export function v2sPlan(frames = 200) {
  return [
    { key: "upload", match: /^upload/i, label: "Uploading the clip", secs: 4 },
    { key: "queued", match: /^queued/i, label: "Waiting for the GPU", secs: 1 },
    { key: "frames", match: /sampling/i, label: "Sampling frames", secs: 6 },
    { key: "depth", match: /depth/i, label: "Measuring depth (Depth Anything 3)", secs: 16 },
    { key: "track", match: /tracking the camera/i, label: "Tracking the camera", secs: 3 },
    { key: "vlm", match: /reading the shot|vision/i, label: "Reading the shot (vision model)", secs: 40 },
    { key: "set", match: /building the set/i, label: "Building the set", secs: 1 },
    { key: "mocap", match: /capturing|performance|sam 3d/i, label: "Tracking the performer (SAM 3D Body)", secs: 10 + 0.38 * frames },
  ];
}

/** Motion capture alone: upload, then SAM 3D Body over every frame. */
export function capturePlan(frames = 200) {
  return [
    { key: "upload", match: /upload/i, label: "Uploading the clip", secs: 4 },
    { key: "mocap", match: /./, label: "Tracking the performer (SAM 3D Body: body, hands, fingers)", secs: 14 + 0.22 * frames },
  ];
}

/**
 * Where a job is: plan + the step it's on + seconds since that step began -> {i, frac, left}. frac (0-1) moves with time
 * inside a step (never past 95 % of it), so the bar keeps creeping during long GPU steps instead of sitting still.
 */
export function progressAt(plan, stepIndex, inStep) {
  const total = plan.reduce((a, s) => a + s.secs, 0) || 1;
  const i = Math.max(0, Math.min(plan.length - 1, stepIndex));
  const before = plan.slice(0, i).reduce((a, s) => a + s.secs, 0);
  const cur = plan[i].secs;
  const within = Math.min(inStep, cur * 0.95);
  const after = plan.slice(i + 1).reduce((a, s) => a + s.secs, 0);
  const left = Math.max(cur - inStep, cur * 0.05) + after;
  return { i, frac: Math.min(0.99, (before + within) / total), left };
}

/** Index of the plan step a server step name belongs to (-1 when unknown). */
export function stepIndex(plan, name) {
  return plan.findIndex((s) => s.match.test(String(name || "")));
}

/**
 * The job card over the 3D view: title, step, a bar that keeps moving, elapsed and an estimate; later the result with
 * action buttons, or the error in plain words. host = the viewport element (position:relative).
 */
export class JobCard {
  constructor(host) {
    ensureCss();
    this.host = host;
    this.el = Object.assign(document.createElement("div"), { className: "ss-vi-job", hidden: true });
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    for (const ev of ["pointerdown", "wheel"]) this.el.addEventListener(ev, (e) => e.stopPropagation());
    host.append(this.el);
    this.timer = null;
  }

  /** Start tracking a job: plan from v2sPlan / capturePlan. */
  start(title, plan) {
    this.plan = plan; this.title = title; this.t0 = performance.now(); this.si = 0; this.stepT = this.t0; this.stepName = plan[0].label;
    this.el.dataset.state = "run";
    this.el.hidden = false;
    this.onShow?.();
    this.el.replaceChildren();
    const t = Object.assign(document.createElement("div"), { className: "t" });
    t.append(icon("scan-eye", 16), title);
    this.sEl = Object.assign(document.createElement("div"), { className: "s" });
    const bar = Object.assign(document.createElement("div"), { className: "bar" });
    this.barI = document.createElement("i");
    bar.append(this.barI);
    this.mEl = Object.assign(document.createElement("div"), { className: "m" });
    this.el.append(t, this.sEl, bar, this.mEl);
    clearInterval(this.timer);
    this.timer = setInterval(() => this._draw(), 500);
    this._draw();
  }

  /** The server (or the page) says which step it is on now; label overrides the plan's wording. */
  step(name, label) {
    const i = stepIndex(this.plan, name);
    if (i >= 0 && i !== this.si) { this.si = i; this.stepT = performance.now(); }
    this.stepName = label || (i >= 0 ? this.plan[i].label : name) || this.stepName;
    this._draw();
  }

  /** The text the bar shows ("Tracking the performer (SAM 3D Body)… 62 %"). */
  text() {
    const p = progressAt(this.plan, this.si, (performance.now() - this.stepT) / 1000);
    return { line: `Step ${p.i + 1} of ${this.plan.length}: ${this.stepName}… ${Math.round(p.frac * 100)}%`, p };
  }

  _draw() {
    if (!this.plan || this.el.dataset.state !== "run") return;
    const { line, p } = this.text();
    const el = (performance.now() - this.t0) / 1000;
    this.sEl.textContent = line;
    this.barI.style.width = `${Math.round(p.frac * 100)}%`;
    const over = (performance.now() - this.stepT) / 1000 > this.plan[p.i].secs && p.i === this.plan.length - 1;
    this.mEl.textContent = over
      ? `${fmtSecs(el)} elapsed · finishing up: a bit slower than usual (the first run loads the model) · you can keep working`
      : `${fmtSecs(el)} elapsed · about ${fmtSecs(Math.max(5, p.left))} left · you can keep working`;
    this.onTick?.(line);
  }

  elapsed() { return (performance.now() - (this.t0 || performance.now())) / 1000; }

  /** Finished: a short summary, buttons [{label, icon, go, run}], optional technical notes (folded away). */
  done(title, summary, actions = [], notes = []) {
    clearInterval(this.timer);
    this.onShow?.();
    this.el.dataset.state = "done";
    this.el.hidden = false;
    this._result(title, "check", summary, actions, notes);
  }

  fail(title, message, actions = []) {
    clearInterval(this.timer);
    this.onShow?.();
    this.el.dataset.state = "error";
    this.el.hidden = false;
    this._result(title, "info", message, actions, []);
  }

  _result(title, ic, summary, actions, notes) {
    const t = Object.assign(document.createElement("div"), { className: "t" });
    t.append(icon(ic, 16), title);
    const x = Object.assign(document.createElement("button"), { type: "button", className: "x", textContent: "×", title: "Close" });
    x.addEventListener("click", () => this.hide());
    const s = Object.assign(document.createElement("div"), { className: "s", textContent: summary });
    const acts = Object.assign(document.createElement("div"), { className: "acts" });
    for (const a of actions) {
      const b = Object.assign(document.createElement("button"), { type: "button", className: a.go ? "go" : "" });
      b.dataset.act = a.key || "";
      if (a.icon) b.append(icon(a.icon, 13));
      b.append(a.label);
      b.addEventListener("click", () => { if (a.close !== false) this.hide(); a.run(); });
      acts.append(b);
    }
    this.el.replaceChildren(x, t, s, ...(actions.length ? [acts] : []));
    if (notes.length) {
      const d = document.createElement("details");
      d.append(Object.assign(document.createElement("summary"), { textContent: "Technical notes" }),
        Object.assign(document.createElement("div"), { textContent: notes.join(" · ") }));
      this.el.append(d);
    }
  }

  hide() { clearInterval(this.timer); this.el.hidden = true; this.onHide?.(); }
}

/**
 * Make `target` (the stage widget) accept a dropped video; `overlayHost` (the 3D view) shows the drop frame.
 * onVideo(file) gets the clip. Other drops (images, 3D files, workflows) are left alone.
 */
export function wireVideoDrop(target, overlayHost, onVideo) {
  ensureCss();
  const ov = Object.assign(document.createElement("div"), { className: "ss-vi-drop" });
  ov.innerHTML = "Drop the video to bring it into 3D<small>Rebuild it as a set, or put the motion on a person (SAM 3D Body)</small>";
  overlayHost.append(ov);
  const hasVideo = (e) => {
    const items = [...(e.dataTransfer?.items || [])];
    return items.some((it) => it.kind === "file" && (String(it.type || "").startsWith("video/") || !it.type));
  };
  let depth = 0;
  const show = (on) => { ov.dataset.on = String(on); };
  target.addEventListener("dragenter", (e) => { if (!hasVideo(e)) return; depth++; show(true); e.preventDefault(); });
  target.addEventListener("dragover", (e) => { if (!hasVideo(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; show(true); });
  target.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) show(false); });
  target.addEventListener("drop", (e) => {
    depth = 0; show(false);
    const f = [...(e.dataTransfer?.files || [])].find(isVideoFile);
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();   // ComfyUI would otherwise try to load it as a workflow
    onVideo(f);
  });
  return ov;
}
