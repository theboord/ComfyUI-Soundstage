// Bring a video into 3D: the one obvious way in. A clip can become the whole set (Video → Stage: location, camera move
// and the performer via SAM 3D Body) or a motion take on a person (Capture motion). This module is the UI around it:
// the "which one?" dialog, the drop target over the 3D view, and a progress / result card with elapsed time and an
// estimate. Pure DOM, no server calls (web/soundstage.js does the work).
import { icon } from "./icons.mjs";

const CSS = `
.ss-vi-modal { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center; padding:16px;
  background:rgba(8,6,12,.72); backdrop-filter:blur(4px); font:13px/1.45 "Soundstage Grotesk", -apple-system, system-ui, sans-serif; color:#f0efed; }
.ss-vi-modal .card { width:min(620px, 100%); max-height:calc(100vh - 32px); box-sizing:border-box; background:#1d1722; border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:16px;
  display:flex; flex-direction:column; gap:9px; box-shadow:0 30px 80px rgba(0,0,0,.55); }
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
.ss-vi-modal .opts3 { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:8px; }
.ss-vi-modal .opts3 .opt { padding:9px; gap:8px; }
.ss-vi-modal .opts3 .opt b { font-size:13px; }
.ss-vi-modal .opts3 .opt span.d { font-size:11.5px; line-height:1.3; display:block; hyphens:auto; overflow-wrap:break-word; }
.ss-vi-modal .rb { display:flex; flex-direction:column; gap:7px; border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:10px; background:rgba(255,255,255,.025); }
.ss-vi-modal .rrow { display:flex; align-items:center; gap:8px; min-width:0; }
.ss-vi-modal .rrow .lab { width:56px; flex:0 0 auto; color:#a9a3ad; font-size:12px; }
.ss-vi-modal .seg { display:flex; flex-wrap:wrap; gap:4px; min-width:0; }
.ss-vi-modal .seg button { font:600 11.5px/1 "Soundstage Grotesk", system-ui, sans-serif; color:#f0efed; background:transparent; cursor:pointer;
  border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:6px 10px; white-space:nowrap; max-width:100%; }
.ss-vi-modal .seg button.long { white-space:normal; text-align:left; line-height:1.25; border-radius:12px; }
.ss-vi-modal .seg button[aria-checked=true] { background:#F2FF59; color:#1a1420; border-color:#F2FF59; }
.ss-vi-modal .strip { position:relative; height:54px; }
.ss-vi-modal .film { position:absolute; inset:0 0 14px 0; display:flex; overflow:hidden; border-radius:6px; background:#120e16; color:#a9a3ad; font-size:11px; align-items:center; justify-content:center;
  --a:0%; --b:100%; }
.ss-vi-modal .film img { flex:1 1 0; min-width:0; height:100%; object-fit:cover; }
.ss-vi-modal .film::before, .ss-vi-modal .film::after { content:""; position:absolute; top:0; bottom:0; background:rgba(8,6,12,.72); pointer-events:none; }
.ss-vi-modal .film::before { left:0; width:var(--a); } .ss-vi-modal .film::after { right:0; width:calc(100% - var(--b)); }
.ss-vi-modal .pick { position:absolute; inset:0 0 14px 0; display:flex; justify-content:center; cursor:crosshair; }
.ss-vi-modal .pick[hidden] { display:none; }
.ss-vi-modal .pick img { height:100%; border-radius:6px; }
.ss-vi-modal .pick .dot { position:absolute; width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%; border:2px solid #F2FF59; background:rgba(242,255,89,.35); pointer-events:none; }
.ss-vi-modal .strip input[type=range] { position:absolute; left:0; right:0; bottom:0; width:100%; margin:0; height:14px; background:transparent; pointer-events:none; -webkit-appearance:none; appearance:none; accent-color:#F2FF59; }
.ss-vi-modal .strip input[type=range]::-webkit-slider-thumb { pointer-events:auto; }
.ss-vi-modal .strip input[type=range]::-moz-range-thumb { pointer-events:auto; }
.ss-vi-modal .tl { color:#a9a3ad; font-size:11.5px; font-variant-numeric:tabular-nums; margin-top:-3px; }
.ss-vi-modal details.adv summary { cursor:pointer; color:#a9a3ad; font-size:12px; }
.ss-vi-modal .adv .grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:6px 10px; margin-top:6px; }
.ss-vi-modal .adv label { display:flex; flex-direction:column; gap:3px; font-size:11px; color:#a9a3ad; min-width:0; }
.ss-vi-modal .adv label.wide { grid-column:1 / -1; }
.ss-vi-modal .adv label.chk { flex-direction:row; align-items:center; gap:6px; grid-column:span 3; }
.ss-vi-modal .adv p.consent { grid-column:1 / -1; margin:-2px 0 2px 24px; font-size:11px; line-height:1.35; color:#c9c3cd; }
.ss-vi-modal .adv input[type=number], .ss-vi-modal .adv input[type=text] { font:inherit; font-size:12px; color:#f0efed; background:#120e16; border:1px solid rgba(255,255,255,.16); border-radius:7px; padding:5px 7px; min-width:0; }
.ss-vi-modal .btns { display:flex; gap:8px; flex:0 0 auto; }
.ss-vi-modal button.go { background:#F2FF59; color:#1a1420; border:1px solid #F2FF59; border-radius:999px; padding:7px 16px; cursor:pointer; font:700 13px/1 "Soundstage Grotesk", system-ui, sans-serif; }
.ss-vi-job .q { color:#ffcf6b; font-size:12px; }
.ss-vi-job .flaws { display:flex; flex-direction:column; gap:5px; }
.ss-vi-job .flaw { display:flex; gap:7px; align-items:flex-start; font-size:12px; color:#ffd2cc; }
.ss-vi-job .flaw[data-level=amber] { color:#ffe2a6; }
.ss-vi-job .flaw .tx { flex:1; min-width:0; }
.ss-vi-job .flaw button { flex:0 0 auto; font:600 11px/1 "Soundstage Grotesk", system-ui, sans-serif; border-radius:999px; padding:5px 9px; cursor:pointer;
  border:1px solid rgba(255,138,126,.6); background:transparent; color:#ffd2cc; }
.ss-vi-job .flaw[data-level=amber] button { border-color:rgba(255,207,107,.6); color:#ffe2a6; }
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

/** The opt-in wardrobe reference's consent line (soundstage/video2stage/wardrobe.py CONSENT says the same). */
export const WARDROBE_REF_CONSENT = "Sends a crop of the person from the clip, with the face blurred, to the Frame still so it copies their build and clothes. Only for footage you have the right to use; the face is never sent.";

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

/** Video → 3D quality presets: depth samples over the clip (the server's own auto picks 24-64 by parallax). */
export const QUALITY = [
  { key: "fast", samples: 16, label: "Fast" },
  { key: "standard", samples: 32, label: "Standard" },
  { key: "max", samples: 64, label: "Max" },
];

/**
 * Honest time for a Video → 3D run, in seconds. history = the server's recent runs [{secs (clip length), samples,
 * total_s}] (GET /soundstage/video2stage/runs, when the server keeps one); without it, the measured baseline
 * (2026-11-02: 11-26 min for 5 s clips at 16 samples on the shared RTX 6000) scaled by length and samples.
 * Returns {secs, from: "history" | "estimate"}.
 */
export function estimateSecs(clipSecs, samples = 16, history = []) {
  const runs = (history || []).filter((r) => r && r.total_s > 0 && r.secs > 0);
  if (runs.length) {
    // per-run rate: total = a + b * clipSecs * (samples / 16)^0.5, fitted as a median ratio
    const k = runs.map((r) => r.total_s / (60 + r.secs * 120 * Math.sqrt((r.samples || 16) / 16)));
    k.sort((x, y) => x - y);
    const m = k[Math.floor(k.length / 2)];
    return { secs: m * (60 + clipSecs * 120 * Math.sqrt(samples / 16)), from: "history" };
  }
  return { secs: 60 + Math.max(1, clipSecs) * 120 * Math.sqrt(samples / 16), from: "estimate" };
}

/** Wording shared by every Video → 3D entry point (the header button, the ⊕ menu, the drop target, the tool row). */
export const V2S_LABEL = "Video → 3D set";
export const V2S_TIP = "Rebuild a clip as a 3D set: the camera move, every person's full-body motion and the things in " +
  "frame at real size, with a photographic set scan behind them. Best on 3-10 s shots with some camera or subject " +
  "movement; a 5 s clip takes about 10-25 min on the shared GPU.";
export const V2S_LIMITS = "Works best on 3-10 s, one setup, no cuts. Mirrors, glass, water and heavy motion blur rebuild poorly; " +
  "faces are never copied.";

/** Grab n small frames across a clip (for the trim filmstrip and the people pick). Resolves [{t, url}] or []. */
export function filmstrip(file, n = 8, w = 96) {
  return new Promise((ok) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; ok(v); } };
    try {
      const v = document.createElement("video");
      const url = URL.createObjectURL(file);
      v.muted = true; v.preload = "auto"; v.src = url;
      const out = [];
      const cv = document.createElement("canvas");
      setTimeout(() => { URL.revokeObjectURL(url); finish(out); }, 8000);
      v.onloadedmetadata = async () => {
        const d = v.duration || 0;
        cv.width = w; cv.height = Math.max(1, Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16)));
        for (let i = 0; i < n && d > 0; i++) {
          const t = Math.min(d - 0.01, (i * d) / Math.max(1, n - 1));
          await new Promise((r) => { v.onseeked = r; v.currentTime = t; setTimeout(r, 1500); });
          try { cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height); out.push({ t, url: cv.toDataURL("image/jpeg", 0.7) }); } catch { break; }
        }
        URL.revokeObjectURL(url);
        finish(out);
      };
      v.onerror = () => { URL.revokeObjectURL(url); finish([]); };
    } catch { finish([]); }
  });
}

/**
 * Ask what the clip is for, on one screen (no scrolling). person = the selected (or first) person's name, or null;
 * cast = how many things are on the stage now; secs = the clip length; history = server run history (estimateSecs).
 * Resolves {use: "stage", options} | {use: "capture"} | {use: "ripple"} | null (cancelled). options is the
 * Video → 3D request: {quality, samples, trim:[in,out], people:"all"|{point:[u,v,0]}, mode:"replace"|"add",
 * vlm, backdrop, lens:{focal_mm?, sensor_mm?, camera_height_m?}, objects?}.
 */
export function chooseVideoUse(file, { person = null, selected = false, cast = 0, secs = 0, history = [] } = {}) {
  ensureCss();
  return new Promise((resolve) => {
    const wrap = Object.assign(document.createElement("div"), { className: "ss-vi-modal", lang: "en" });   // lang lets narrow cards hyphenate
    const card = Object.assign(document.createElement("div"), { className: "card" });
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "What is this video for?");
    const h3 = document.createElement("h3");
    h3.append(icon("file-video-camera", 20), "What is this video for?");
    const name = Object.assign(document.createElement("div"), { className: "file", textContent: `${file?.name || ""}${secs ? ` · ${secs.toFixed(1)} s` : ""}` });
    const opt = (k, ic, title, desc) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "opt" });
      b.dataset.choice = k;
      const t = document.createElement("div");
      t.append(Object.assign(document.createElement("b"), { textContent: title }), Object.assign(document.createElement("span"), { className: "d", textContent: desc }));
      const i = Object.assign(document.createElement("span"), { className: "ic" });
      i.append(icon(ic, 20));
      b.append(i, t);
      return b;
    };
    const who = person ? `on ${person}` : "on a person";
    const stageOpt = opt("stage", "clapperboard", "Rebuild as a 3D set", "Camera, people, things, set scan");
    const capOpt = opt("capture", "person-standing", "Capture motion", `Copy the performance ${who}`);
    const ripOpt = opt("ripple", "wand-sparkles", "Edit with Ripple", "Keep the footage, change frame 1");
    capOpt.addEventListener("click", () => done({ use: "capture" }));
    ripOpt.addEventListener("click", () => done({ use: "ripple" }));
    const opts3 = Object.assign(document.createElement("div"), { className: "opts3" });
    opts3.append(stageOpt, capOpt, ripOpt);
    // ---- Rebuild options (one screen)
    const st = { quality: "standard", trim: [0, secs || 0], people: "all", point: null, mode: cast ? "add" : "replace",
      vlm: true, backdrop: true, wardrobe_ref: false, focal_mm: "", sensor_mm: "", camera_height_m: "", objects: "" };
    const panel = Object.assign(document.createElement("div"), { className: "rb" });
    const seg = (label, items, key, onPick) => {
      const row = Object.assign(document.createElement("div"), { className: "rrow" });
      const l = Object.assign(document.createElement("span"), { className: "lab", textContent: label });
      const g = Object.assign(document.createElement("div"), { className: "seg" });
      g.setAttribute("role", "radiogroup");
      g.setAttribute("aria-label", label);
      const btns = items.map(([k, text, tip]) => {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title: tip || "" });
        if (text.length > 28) b.classList.add("long");   // a long chip wraps inside a narrow dialog instead of running off it
        b.dataset.k = k;
        b.setAttribute("role", "radio");
        b.addEventListener("click", () => { st[key] = k; sync(); onPick?.(k); });
        return b;
      });
      g.append(...btns);
      row.append(l, g);
      row.sync = () => btns.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.k === st[key])));
      return row;
    };
    const qRow = seg("Quality", QUALITY.map((q) => {
      const e = estimateSecs(Math.max(0.5, (st.trim[1] || secs || 5) - (st.trim[0] || 0)), q.samples, history);
      return [q.key, `${q.label} ${q.samples} · ${e.from === "history" ? "" : "≈"}${e.secs >= 120 ? `${Math.round(e.secs / 60)} min` : fmtSecs(e.secs)}`,
        `${q.samples} depth samples. ${e.from === "history" ? "From this server's recent runs." : "Estimate from the measured baseline (no history on this server yet)."}`];
    }), "quality");
    // trim filmstrip
    const strip = Object.assign(document.createElement("div"), { className: "strip" });
    const film = Object.assign(document.createElement("div"), { className: "film" });
    const pick = Object.assign(document.createElement("div"), { className: "pick", hidden: true, title: "Click the person to rebuild" });
    const pickImg = document.createElement("img");
    const dot = Object.assign(document.createElement("i"), { className: "dot", hidden: true });
    pick.append(pickImg, dot);
    const tIn = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 1000, value: 0, className: "tin" });
    const tOut = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 1000, value: 1000, className: "tout" });
    tIn.setAttribute("aria-label", "Trim in");
    tOut.setAttribute("aria-label", "Trim out");
    const tLab = Object.assign(document.createElement("span"), { className: "tl" });
    const onTrim = () => {
      let a = +tIn.value, b = +tOut.value;
      if (b - a < 20) { if (document.activeElement === tIn) a = tIn.value = b - 20; else b = tOut.value = a + 20; }
      st.trim = [+(a / 1000 * secs).toFixed(2), +(b / 1000 * secs).toFixed(2)];
      tLab.textContent = secs ? `Trim ${st.trim[0].toFixed(1)}–${st.trim[1].toFixed(1)} s (${(st.trim[1] - st.trim[0]).toFixed(1)} s)` : "Trim: whole clip";
      film.style.setProperty("--a", `${a / 10}%`); film.style.setProperty("--b", `${b / 10}%`);
    };
    tIn.addEventListener("input", onTrim);
    tOut.addEventListener("input", onTrim);
    strip.append(film, pick, tIn, tOut);
    const pRow = seg("People", [["all", "Everyone", "Every person in the clip gets their own full-body take"],
      ["point", "Pick one on frame 1", "Click the person on the first frame"]], "people", (k) => { pick.hidden = k !== "point"; film.hidden = k === "point"; });
    pick.addEventListener("click", (e) => {
      const r = pickImg.getBoundingClientRect();
      const u = (e.clientX - r.left) / Math.max(1, r.width), v = (e.clientY - r.top) / Math.max(1, r.height);
      if (u < 0 || u > 1 || v < 0 || v > 1) return;
      st.point = [+u.toFixed(4), +v.toFixed(4), 0];
      dot.hidden = false; dot.style.left = `${u * 100}%`; dot.style.top = `${v * 100}%`;
    });
    const mRow = seg("Stage", [["replace", cast ? `Replace the set (${cast} things; Undo brings them back)` : "Replace the set", "Clear the stage and load the rebuild"],
      ["add", "Add to it", "Keep what is on the stage and add the rebuild"]], "mode");
    const adv = document.createElement("details");
    adv.className = "adv";
    const sum = Object.assign(document.createElement("summary"), { textContent: "Advanced: lens, camera height, what to look for, set scan" });
    const grid = Object.assign(document.createElement("div"), { className: "grid" });
    const num = (key, label, ph, step = "0.1") => {
      const l = document.createElement("label");
      const i = Object.assign(document.createElement("input"), { type: "number", step, min: 0, placeholder: ph });
      i.addEventListener("input", () => { st[key] = i.value; });
      l.append(label, i);
      return l;
    };
    const objs = document.createElement("label");
    const oi = Object.assign(document.createElement("input"), { type: "text", placeholder: "e.g. red sofa, bicycle, street sign" });
    oi.addEventListener("input", () => { st.objects = oi.value; });
    objs.className = "wide";
    objs.append("Objects to find (besides everything the model sees)", oi);
    const bdl = document.createElement("label");
    bdl.className = "chk";
    const bd = Object.assign(document.createElement("input"), { type: "checkbox", checked: true });
    bd.addEventListener("change", () => { st.backdrop = bd.checked; });
    bdl.append(bd, "Set scan (splat + mesh of the real location)");
    const vl = document.createElement("label");
    vl.className = "chk";
    const vb = Object.assign(document.createElement("input"), { type: "checkbox", checked: true });
    vb.addEventListener("change", () => { st.vlm = vb.checked; });
    vl.append(vb, "Name things with the vision model");
    const wrl = document.createElement("label");
    wrl.className = "chk";
    wrl.title = WARDROBE_REF_CONSENT;
    const wr = Object.assign(document.createElement("input"), { type: "checkbox", checked: false });
    wr.addEventListener("change", () => { st.wardrobe_ref = wr.checked; });
    wrl.append(wr, "Wardrobe reference for the Frame still (face blurred; only footage you may use)");
    // The consent words on screen, not only in a hover tooltip (touch screens never show a tooltip).
    const wrc = Object.assign(document.createElement("p"), { className: "consent", textContent: WARDROBE_REF_CONSENT });
    wrc.dataset.consent = "wardrobe_ref";
    wr.setAttribute("aria-describedby", (wrc.id = "ss-vi-wardrobe-consent"));
    grid.append(num("focal_mm", "Focal mm", "auto", "1"), num("sensor_mm", "Sensor width mm", "36", "0.1"),
      num("camera_height_m", "Camera height m", "auto"), objs, bdl, vl, wrl, wrc);
    adv.append(sum, grid);
    panel.append(qRow, strip, tLab, pRow, mRow, adv);
    const sync = () => { for (const r of [qRow, pRow, mRow]) r.sync(); };
    sync();
    onTrim();
    filmstrip(file, 8).then((fr) => {
      film.replaceChildren(...fr.map((x) => Object.assign(document.createElement("img"), { src: x.url, alt: "" })));
      if (fr[0]) pickImg.src = fr[0].url;
      if (!fr.length) film.textContent = "No preview (the browser can't decode this clip); the server still can.";
    });
    const tip = Object.assign(document.createElement("div"), { className: "tip", textContent: V2S_LIMITS });
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "cancel", textContent: "Cancel" });
    cancel.addEventListener("click", () => done(null));
    const go = Object.assign(document.createElement("button"), { type: "button", className: "go", textContent: "Rebuild" });
    go.dataset.choice = "rebuild";
    const doRebuild = () => {
      if (st.people === "point" && !st.point) { pick.hidden = false; film.hidden = true; tip.textContent = "Click the person on the first frame first (or choose Everyone)."; return; }
      const q = QUALITY.find((x) => x.key === st.quality) || QUALITY[1];
      const lens = {};
      for (const k of ["focal_mm", "sensor_mm", "camera_height_m"]) if (st[k] !== "" && Number(st[k]) > 0) lens[k] = Number(st[k]);
      const options = { quality: q.key, samples: q.samples, people: st.people === "point" ? { point: st.point } : "all", mode: st.mode,
        vlm: st.vlm, backdrop: st.backdrop, lens };
      if (st.wardrobe_ref) options.wardrobe_ref = true;
      if (secs && (st.trim[0] > 0.01 || st.trim[1] < secs - 0.01)) options.trim = st.trim;
      if (st.objects.trim()) options.objects = st.objects.trim();
      done({ use: "stage", options });
    };
    go.addEventListener("click", doRebuild);
    stageOpt.addEventListener("click", doRebuild);
    const row = Object.assign(document.createElement("div"), { className: "row" });
    const btns = Object.assign(document.createElement("div"), { className: "btns" });
    btns.append(cancel, go);
    row.append(tip, btns);
    card.append(h3, name, opts3, panel, row);
    wrap.append(card);
    for (const ev of ["pointerdown", "keydown", "wheel"]) wrap.addEventListener(ev, (e) => e.stopPropagation());
    wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    wrap.addEventListener("click", (e) => { if (e.target === wrap) done(null); });
    document.body.append(wrap);
    (selected ? capOpt : go).focus();
    if (selected) capOpt.classList.add("def"); else stageOpt.classList.add("def");
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
 * Video → 3D's steps, in order, with a typical time each (shared RTX 6000, measured 2026-11-02: a 5 s clip took
 * 11-26 min end to end). Only a fallback: the server reports its own steps, queue position and ETA (/job), and the card
 * shows those whenever they come. frames = the clip's frame count; samples = depth samples.
 */
export function v2sPlan(frames = 120, samples = 16) {
  const k = Math.sqrt(samples / 16);
  return [
    { key: "upload", match: /^upload/i, label: "Uploading the clip", secs: 4 },
    { key: "queued", match: /^queued|waiting/i, label: "Waiting for the GPU", secs: 5 },
    { key: "frames", match: /sampling|decod|frames/i, label: "Reading every frame", secs: 8 },
    { key: "depth", match: /depth/i, label: "Measuring depth (Depth Anything 3)", secs: 40 * k },
    { key: "people", match: /people|person|segment|sam 3\.1|masks/i, label: "Finding every person and thing (SAM 3.1)", secs: 150 },
    { key: "track", match: /tracking the camera|solv|camera/i, label: "Solving the camera", secs: 60 * k },
    { key: "vlm", match: /reading the shot|vision|inventory/i, label: "Naming what's in frame (vision model)", secs: 90 },
    { key: "mocap", match: /capturing|performance|sam 3d|pose|body/i, label: "Full-body motion for every person (SAM 3D Body)", secs: 30 + 0.4 * frames },
    { key: "set", match: /building the set|layout|measur|assembl/i, label: "Building the set at real size", secs: 60 },
    { key: "backdrop", match: /backdrop|scan|splat/i, label: "Fusing the set scan", secs: 25 },
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

/** Red first, then amber; notes without a level are not flaws. */
export function sortFlaws(flaws) {
  const rank = { red: 0, amber: 1 };
  return (flaws || []).filter((f) => f && f.text && f.level in rank).sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * The server's notes -> flaws for the result card. Accepts strings or {text, level, fix:{action, label}}; a plain string
 * is a flaw when it reads like one (failed, could not, no ..., low confidence). Fix actions are looked up in fixes.
 */
export function flawsFromNotes(notes, fixes = {}) {
  const out = [];
  for (const n of notes || []) {
    if (n && typeof n === "object") {
      if (n.level === "red" || n.level === "amber" || n.level === "warn" || n.level === "error") {
        const level = n.level === "error" ? "red" : n.level === "warn" ? "amber" : n.level;
        const fx = n.fix && fixes[n.fix.action] ? { action: n.fix.action, label: n.fix.label || n.fix.action, run: fixes[n.fix.action] } : null;
        out.push({ text: n.text, level, fix: fx });
      }
    } else if (typeof n === "string" && /\b(failed|could not|couldn't|unusable|no (?:local |usable )?\w+ (?:found|model)|low confidence|drift|left out|disagree)/i.test(n)) {
      out.push({ text: n, level: /failed|could not|couldn't|unusable/i.test(n) ? "red" : "amber", fix: null });
    }
  }
  return out;
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

  /** Start tracking a job: plan from v2sPlan / capturePlan. onCancel: shows a Cancel button that calls it. */
  start(title, plan, { onCancel = null } = {}) {
    this.server = null;
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
    this.qEl = Object.assign(document.createElement("div"), { className: "q", hidden: true });
    this.el.append(t, this.sEl, bar, this.qEl, this.mEl);
    if (onCancel) {
      const acts = Object.assign(document.createElement("div"), { className: "acts" });
      const c = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
      c.dataset.act = "cancel";
      c.title = "Stop this rebuild: only its own GPU jobs are removed from the queue";
      c.addEventListener("click", () => { c.disabled = true; c.textContent = "Cancelling…"; onCancel(); });
      acts.append(c);
      this.el.append(acts);
    }
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

  /**
   * The server's own progress (/soundstage/video2stage/job): {step, step_index, steps[], queue_position, elapsed_s,
   * eta_s}. Once it reports, the card shows its numbers instead of the plan's guesses.
   */
  serverStatus(s) {
    if (!s || this.el.dataset.state !== "run") return;
    if (Array.isArray(s.steps) && s.steps.length && Number.isFinite(s.step_index)) {
      this.server = { ...s, at: performance.now() };
    } else if (s.step) this.step(s.step);
    if (Number.isFinite(s.queue_position) && s.queue_position > 0) {
      this.qEl.hidden = false;
      this.qEl.textContent = `${s.queue_position} job${s.queue_position > 1 ? "s" : ""} ahead in the GPU queue, not ours: ours starts after them`;
    } else this.qEl.hidden = true;
    this._draw();
  }

  /** The text the bar shows ("Step 3 of 9: Solving the camera… 62 %"). */
  text() {
    const sv = this.server;
    if (sv) {
      const since = (performance.now() - sv.at) / 1000;
      const el = (sv.elapsed_s || 0) + since;
      const eta = Number.isFinite(sv.eta_s) ? Math.max(0, sv.eta_s - since) : null;
      const frac = eta != null ? Math.min(0.99, el / Math.max(1, el + eta)) : Math.min(0.99, (sv.step_index + 0.5) / sv.steps.length);
      return { line: `Step ${sv.step_index + 1} of ${sv.steps.length}: ${sv.step || sv.steps[sv.step_index]}… ${Math.round(frac * 100)}%`,
        p: { i: sv.step_index, frac, left: eta }, server: true, el };
    }
    const p = progressAt(this.plan, this.si, (performance.now() - this.stepT) / 1000);
    return { line: `Step ${p.i + 1} of ${this.plan.length}: ${this.stepName}… ${Math.round(p.frac * 100)}%`, p };
  }

  _draw() {
    if (!this.plan || this.el.dataset.state !== "run") return;
    const tx = this.text(), { line, p } = tx;
    const el = (performance.now() - this.t0) / 1000;
    this.sEl.textContent = line;
    this.barI.style.width = `${Math.round(p.frac * 100)}%`;
    if (tx.server) {
      this.mEl.textContent = p.left != null
        ? `${fmtSecs(el)} elapsed · about ${fmtSecs(Math.max(5, p.left))} left (from this server's recent runs) · you can keep working`
        : `${fmtSecs(el)} elapsed · no time estimate yet (first runs on this server) · you can keep working`;
      this.onTick?.(line);
      return;
    }
    const over = (performance.now() - this.stepT) / 1000 > this.plan[p.i].secs && p.i === this.plan.length - 1;
    this.mEl.textContent = over
      ? `${fmtSecs(el)} elapsed · slower than the estimate (the GPU is shared, or the first run loads the models) · you can keep working`
      : `${fmtSecs(el)} elapsed · roughly ${fmtSecs(Math.max(5, p.left))} left (estimate) · you can keep working`;
    this.onTick?.(line);
  }

  elapsed() { return (performance.now() - (this.t0 || performance.now())) / 1000; }

  /**
   * Finished: a short summary, buttons [{label, icon, go, run}], optional technical notes (folded away).
   * flaws: [{text, level: "red"|"amber", fix?: {label, run}}] lead the card, worst first, each with its fix button.
   */
  done(title, summary, actions = [], notes = [], flaws = []) {
    clearInterval(this.timer);
    this.onShow?.();
    this.el.dataset.state = "done";
    this.el.hidden = false;
    this._result(title, flaws.some((f) => f.level === "red") ? "info" : "check", summary, actions, notes, flaws);
  }

  fail(title, message, actions = []) {
    clearInterval(this.timer);
    this.onShow?.();
    this.el.dataset.state = "error";
    this.el.hidden = false;
    this._result(title, "info", message, actions, []);
  }

  _result(title, ic, summary, actions, notes, flaws = []) {
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
    const fl = sortFlaws(flaws);
    const box = Object.assign(document.createElement("div"), { className: "flaws" });
    for (const f of fl.slice(0, 3)) {
      const row = Object.assign(document.createElement("div"), { className: "flaw" });
      row.dataset.level = f.level;
      row.append(icon("info", 13), Object.assign(document.createElement("span"), { className: "tx", textContent: f.text }));
      if (f.fix?.run) {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: f.fix.label });
        b.dataset.fix = f.fix.action || "";
        b.addEventListener("click", () => { b.disabled = true; f.fix.run(); });
        row.append(b);
      }
      box.append(row);
    }
    if (fl.length > 3) box.append(Object.assign(document.createElement("div"), { className: "m", textContent: `+${fl.length - 3} more in the technical notes` }));
    this.el.replaceChildren(x, t, ...(fl.length ? [box] : []), s, ...(actions.length ? [acts] : []));
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
  ov.innerHTML = `Drop the video to bring it into 3D<small>${V2S_LABEL}: camera, people, things and a set scan. Or put the motion on a person.</small>`;
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
