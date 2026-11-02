// The Director panel: a floating chat over the canvas. Type or talk ("put Mara in the sports car at night"), read the
// plan, press Apply (Enter, or say "yes"), watch the stage change, Undo any turn. Opened from the top bar or "/".
//
//   import { mountDirector } from "./agent/directorpanel.mjs";
//   const d = mountDirector({ root: el, topBar: tabs, before: keysBtn, api, stage, host, isActive: () => bool });
//   d.open(); d.send("make it rain"); d.director  // the Director (web/agent/director.mjs)
//
// Keys: "/" opens it and focuses the box · Enter sends (on an empty box: applies the plan) · Esc cancels the plan,
// then closes · hold ` (backquote) anywhere in the App to talk, or hold Space in the empty box / with the panel open.
// Voice: the browser's speech recognition where it has one, or Whisper on the ComfyUI server (offline, open weights).
// MCP: Claude Desktop / Code proposals arrive as "soundstage.director" events and run here, in view, undoable.
import { Director, BACKENDS, YES_RE, NO_RE, encodeWav, downsample, wantsGo, pickOllama } from "./director.mjs";
import { PitchSession } from "./pitch.mjs";
import { icon } from "../ui/icons.mjs";
import { statusOf, setTakeStatus, refreshBadges } from "../dailies/approval.mjs";

const CSS = `
.ss-dir { position:absolute; right:14px; bottom:64px; width:min(400px, calc(100% - 28px)); max-height:min(72%, 640px); z-index:80;
  display:flex; flex-direction:column; background:var(--ss-glass-strong, rgba(26,20,31,.94)); color:var(--ss-text, #f0efed);
  border:1px solid var(--ss-line-strong, rgba(255,255,255,.16)); border-radius:14px; box-shadow:0 18px 48px rgba(0,0,0,.5);
  backdrop-filter:blur(14px); font:13px/1.4 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; overflow:hidden; }
.ss-dir[hidden] { display:none !important; }
.ss-dir header { display:flex; align-items:center; gap:8px; padding:10px 12px 8px; border-bottom:1px solid var(--ss-line, rgba(255,255,255,.08)); }
.ss-dir header .t { font-weight:700; font-size:14px; display:flex; align-items:center; gap:6px; }
.ss-dir header .be { margin-left:auto; font-size:11px; color:var(--ss-muted, rgba(240,239,237,.68)); max-width:160px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dir header button, .ss-dir .ib { background:transparent; border:none; color:var(--ss-muted, #bbb); cursor:pointer; padding:4px; border-radius:8px; display:inline-flex; }
.ss-dir header button:hover, .ss-dir .ib:hover { background:rgba(255,255,255,.08); color:var(--ss-text, #fff); }
.ss-dir .log { flex:1 1 auto; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:8px; min-height:80px; }
.ss-dir .msg { max-width:92%; padding:7px 10px; border-radius:12px; white-space:pre-wrap; word-wrap:break-word; }
.ss-dir .msg.u { align-self:flex-end; background:var(--ss-accent-soft, rgba(242,255,89,.10)); border:1px solid var(--ss-accent-line, rgba(242,255,89,.42)); }
.ss-dir .msg.u .src { display:block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--ss-muted, #aaa); margin-bottom:2px; }
.ss-dir .msg.a { align-self:flex-start; background:rgba(255,255,255,.045); border:1px solid var(--ss-line, rgba(255,255,255,.08)); }
.ss-dir .msg.a.wait { color:var(--ss-muted, #aaa); font-style:italic; }
.ss-dir .msg ol, .ss-dir .msg ul { margin:4px 0 2px; padding-left:20px; }
.ss-dir .msg li { margin:2px 0; }
.ss-dir .msg li.no { color:var(--ss-faint, rgba(240,239,237,.54)); text-decoration:line-through; }
.ss-dir .msg li.ok::marker { color:var(--ss-success, #7ee2a8); }
.ss-dir .msg li.bad::marker { color:var(--ss-danger, #ff7a7a); }
.ss-dir .msg .why { margin-top:6px; color:var(--ss-muted, #bbb); font-size:12px; }
.ss-dir .msg .meta { margin-top:4px; font-size:11px; color:var(--ss-faint, #999); }
.ss-dir .msg .gpu { margin-top:6px; padding:6px 8px; border-radius:8px; background:rgba(255,122,122,.10); border:1px solid rgba(255,122,122,.35); font-size:12px; }
.ss-dir .row { display:flex; flex-wrap:wrap; gap:6px; margin-top:7px; }
.ss-dir .row button { border-radius:999px; padding:4px 11px; border:1px solid var(--ss-line-strong, rgba(255,255,255,.16)); background:rgba(255,255,255,.05);
  color:var(--ss-text, #eee); cursor:pointer; font:inherit; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
.ss-dir .row button.go { background:var(--ss-accent, #f2ff59) !important; color:var(--ss-accent-ink, #211927) !important; border-color:var(--ss-accent, #f2ff59) !important; font-weight:700; }
.ss-dir .row button:disabled { opacity:.45; cursor:default; }
.ss-dir .row button .k { opacity:.6; font-size:10px; margin-left:2px; }
.ss-dir .chips { display:flex; flex-wrap:wrap; gap:6px; padding:0 12px 8px; }
.ss-dir .chips button { border-radius:999px; padding:3px 10px; border:1px dashed var(--ss-line-strong, rgba(255,255,255,.2)); background:transparent; color:var(--ss-muted, #ccc); cursor:pointer; font:inherit; font-size:12px; }
.ss-dir .chips button:hover { color:var(--ss-text, #fff); border-color:var(--ss-accent-line, #f2ff59); }
.ss-dir .comp { display:flex; gap:6px; align-items:center; padding:8px 10px 6px; border-top:1px solid var(--ss-line, rgba(255,255,255,.08)); }
.ss-dir .comp input { flex:1; min-width:0; background:rgba(0,0,0,.25); color:var(--ss-text, #fff); border:1px solid var(--ss-line-strong, rgba(255,255,255,.16)); border-radius:999px; padding:8px 12px; font:inherit; }
.ss-dir .comp input:focus { outline:none; border-color:var(--ss-accent-line, #f2ff59); }
.ss-dir .comp .mic { width:34px; height:34px; border-radius:50%; justify-content:center; align-items:center; border:1px solid var(--ss-line-strong, rgba(255,255,255,.16)); }
.ss-dir .comp .mic[data-on=true] { background:#ff453a; color:#fff; border-color:#ff453a; animation:ssdirpulse 1.1s ease-in-out infinite; }
@keyframes ssdirpulse { 50% { box-shadow:0 0 0 6px rgba(255,69,58,.25); } }
.ss-dir .hint { padding:0 12px 9px; font-size:11px; color:var(--ss-faint, rgba(240,239,237,.54)); }
.ss-dir .set { padding:8px 12px; border-bottom:1px solid var(--ss-line, rgba(255,255,255,.08)); display:grid; grid-template-columns:auto 1fr; gap:6px 10px; align-items:center; font-size:12px; }
.ss-dir .set[hidden] { display:none; }
.ss-dir .set select, .ss-dir .set input[type=text], .ss-dir .set input[type=password] { background:rgba(0,0,0,.3); color:var(--ss-text, #fff); border:1px solid var(--ss-line-strong, #444); border-radius:8px; padding:4px 6px; font:inherit; min-width:0; }
.ss-dir .set label.cb { grid-column:1 / -1; display:flex; gap:6px; align-items:center; }
/* Pitch Mode (Milestone 22): live transcript, latency HUD, the storyboard filmstrip of beats. */
.ss-dir header .pitchb { color:var(--ss-text, #eee); border:1px solid var(--ss-line-strong, rgba(255,255,255,.16)); border-radius:999px; padding:3px 10px; font:inherit; font-size:12px; font-weight:700; gap:5px; align-items:center; }
.ss-dir header .pitchb .dot { width:9px; height:9px; border-radius:50%; background:#ff453a; display:inline-block; }
.ss-dir header .pitchb[aria-pressed=true] { background:#ff453a; color:#fff; border-color:#ff453a; }
.ss-dir header .pitchb[aria-pressed=true] .dot { background:#fff; animation:ssdirpulse 1.1s ease-in-out infinite; }
.ss-dir .pitch { border-top:1px solid var(--ss-line, rgba(255,255,255,.08)); padding:8px 10px 6px; display:flex; flex-direction:column; gap:6px; }
.ss-dir .pitch[hidden] { display:none; }
.ss-dir .pitch .tx { font-size:12px; min-height:18px; max-height:54px; overflow:hidden; color:var(--ss-text, #eee); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
.ss-dir .pitch .tx i { color:var(--ss-faint, #999); }
.ss-dir .pitch .hud { font:11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--ss-muted, #bbb); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-dir .pitch .hud b { color:var(--ss-accent, #f2ff59); font-weight:600; }
.ss-dir .pitch .strip { display:flex; gap:6px; overflow-x:auto; padding-bottom:4px; scroll-snap-type:x proximity; }
.ss-dir .pitch .beat { flex:0 0 132px; scroll-snap-align:end; border:1px solid var(--ss-line, rgba(255,255,255,.1)); border-radius:10px; overflow:hidden; background:rgba(0,0,0,.25); cursor:pointer; position:relative; }
.ss-dir .pitch .beat[data-sel=true] { border-color:var(--ss-accent-line, #f2ff59); }
.ss-dir .pitch .beat .im { width:100%; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; background:#0d0b10; color:var(--ss-faint, #888); font-size:11px; }
.ss-dir .pitch .beat img, .ss-dir .pitch .beat video { width:100%; aspect-ratio:16/9; object-fit:cover; display:block; }
.ss-dir .pitch .beat .im[data-st=rendering] { background:linear-gradient(90deg,#141018,#221a28,#141018); background-size:200% 100%; animation:sspitchsh 1.2s linear infinite; }
@keyframes sspitchsh { to { background-position:-200% 0; } }
.ss-dir .pitch .beat .cap { padding:4px 6px 5px; font-size:10.5px; line-height:1.25; color:var(--ss-muted, #ccc); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ss-dir .pitch .beat .n { position:absolute; left:5px; top:4px; font-size:10px; font-weight:700; background:rgba(0,0,0,.6); color:#fff; padding:0 5px; border-radius:6px; }
.ss-dir .pitch .beat .ms { position:absolute; right:5px; top:4px; font-size:10px; background:rgba(0,0,0,.6); color:#fff; padding:0 5px; border-radius:6px; }
.ss-dir .pitch .row { margin-top:0; }
.ss-dirbtn[aria-pressed=true] { background:var(--ss-accent, #f2ff59) !important; color:var(--ss-accent-ink, #211927) !important; }
`;

const EXAMPLES = [
  "Put Mara in the sports car at night, rain, camera on the hood, she's nervous",
  "Make shot 2 a slow push-in at 50 mm",
  "Drop a crate stack by the wall and have the car crash through it",
  "Use the J-turn stunt",
  "Make the first frame warmer",
  "Render a draft of shots 1 to 3",
  "Cut it together with the best takes",
];

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k === "class") e.className = v;
    else if (v === true) e.setAttribute(k, "");
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const stop = (e) => e.stopPropagation();
const editable = (t) => t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable);

// ---------------------------------------------------------------- docking geometry (pure: tested in tests/js/director_dock.test.mjs)
/** The floating things the chat must never cover: the canvas panels, pop-overs, the top view and the bottom playback row. */
export const DIR_OTHERS = ".ss-hud, .ss-hudp, .ss-clpanel, .ss-cv-panel, .ss-phys, .ss-hudpop, .ss-cl-railbox, .ss-pre, .ss-top, .ss-bottom, .ss-vi-cta, [role=dialog]";
export const DIR_W = 400, DIR_MIN = 300, DIR_GAP = 8, DIR_TOP = 58, DIR_MIN_H = 220;
const hOver = (a, b) => a.left < b.right - 1 && a.right > b.left + 1;
/**
 * Where the chat goes, in page pixels: {left, top, right, bottom, take: [elements to hide]}, or null (no room: CSS default).
 * rr is the root's rect; obstacles are [{el, r}] of everything it must not cover. Bars (short things: the playback row,
 * a top HUD) only limit it above and below; the rest (side panels) split the width into bands. It takes the rightmost
 * band at least DIR_MIN wide; failing that, the band Properties (.ss-insp) leaves when hidden.
 */
export function dockSlot(rr, obstacles, { isProps = (el) => !!el?.matches?.(".ss-insp") } = {}) {
  const tall = (o) => o.r.height >= rr.height * 0.3;
  const sides = obstacles.filter(tall), bars = obstacles.filter((o) => !tall(o));
  const top0 = rr.top + DIR_TOP;
  const tryWith = (list) => {
    // Free x-intervals across the side panels.
    const spans = list.map((o) => [o.r.left, o.r.right]).sort((a, b) => a[0] - b[0]);
    const free = [];
    let x = rr.left;
    for (const [a, b] of spans) { if (a > x) free.push([x, a]); x = Math.max(x, b); }
    if (rr.right > x) free.push([x, rr.right]);
    for (let i = free.length - 1; i >= 0; i--) {
      const [L, R] = free[i];
      const room = R - L - 2 * DIR_GAP;
      if (room < DIR_MIN) continue;
      const w = Math.min(DIR_W, room);
      const col = { left: R - DIR_GAP - w, right: R - DIR_GAP };
      let top = top0, bottom = rr.bottom - DIR_GAP;
      for (const o of bars) {
        if (!hOver(col, o.r)) continue;
        const cy = (o.r.top + o.r.bottom) / 2;
        if (cy < rr.top + rr.height / 2) top = Math.max(top, o.r.bottom + DIR_GAP); else bottom = Math.min(bottom, o.r.top - DIR_GAP);
      }
      if (bottom - top >= DIR_MIN_H) return { ...col, top, bottom };
    }
    return null;
  };
  const got = tryWith(sides);
  if (got) return { ...got, take: [] };
  const props = sides.filter((o) => isProps(o.el));
  if (!props.length) return null;
  const got2 = tryWith(sides.filter((o) => !props.includes(o)));
  return got2 ? { ...got2, take: props.map((o) => o.el) } : null;
}

export function mountDirector({ root, topBar = null, before = null, api, stage, host = {}, isActive = () => true }) {
  if (!document.getElementById("ss-dir-css")) document.head.append(h("style", { id: "ss-dir-css" }, CSS));
  if (getComputedStyle(root).position === "static") root.style.position = "relative";
  const restore0 = host.restore;
  host = { approvals: { statusOf, setTakeStatus }, ...host,
    restore: (x) => { restore0?.(x); try { refreshBadges(); } catch { /* no badges */ } } };
  const director = new Director({ api, stage, host, onEvent: (ev) => onEvent(ev) });
  let pending = null;           // the plan waiting for Apply
  let busy = false;
  let listening = null;          // {stop()} while the mic is on
  let explain = localStorage.getItem("ss_director_explain") !== "0";
  let autoApply = localStorage.getItem("ss_director_auto") === "1";
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let voice = localStorage.getItem("ss_director_voice") || (SR ? "browser" : "whisper");

  // ---------------------------------------------------------------- DOM
  const log = h("div", { class: "log", "aria-live": "polite" });
  const input = h("input", { type: "text", placeholder: "Tell the set what you want… (Enter)", "aria-label": "Talk to the Director's assistant" });
  const mic = h("button", { type: "button", class: "ib mic", title: "Hold to talk (or hold ` / Space)", "aria-label": "Hold to talk" }, icon("mic", 16));
  const sendB = h("button", { type: "button", class: "ib", title: "Send (Enter)", "aria-label": "Send" }, icon("send", 16));
  const beLbl = h("span", { class: "be" }, "");
  const setBtn = h("button", { type: "button", title: "Model, voice and how it applies", "aria-label": "Director settings" }, icon("sliders-horizontal", 15));
  const closeBtn = h("button", { type: "button", title: "Close (Esc)", "aria-label": "Close the Director panel" }, icon("x", 15));
  const pitchBtn = h("button", { type: "button", class: "pitchb", title: "Pitch Mode: talk through your idea and watch the set build itself, a sketch per beat (P)",
    "aria-label": "Pitch Mode", "aria-pressed": "false" }, h("span", { class: "dot" }), "Pitch");
  const pTx = h("div", { class: "tx", "aria-live": "polite" });
  const pHud = h("div", { class: "hud", title: "Latency of the last beat: heard (transcription), plan, model, stage, sketch on the GPU, and sentence → image" });
  const pStrip = h("div", { class: "strip", role: "list", "aria-label": "Pitch beats" });
  const pMic = h("button", { type: "button" }, icon("mic", 13), "Listening");
  const pUndo = h("button", { type: "button", title: "Undo the last beat" }, icon("rotate-ccw", 13), "Undo beat");
  const pMotion = h("button", { type: "button", title: "A very fast, low-res LTX draft of the selected beat (uses the GPU)" }, icon("video", 13), "Preview motion");
  const pLock = h("button", { type: "button", class: "go", title: "Turn the pitch into shots: one per beat, each sketch as its first frame" }, icon("check", 13), "Lock it");
  const pitchBox = h("div", { class: "pitch", hidden: true }, pTx, pHud, pStrip, h("div", { class: "row" }, pMic, pUndo, pMotion, pLock));
  const chips = h("div", { class: "chips" });
  const hint = h("div", { class: "hint" }, "Enter sends · Enter again (or say “yes”) applies · Esc cancels · hold ` or Space to talk");
  const beSel = h("select", { "aria-label": "Language model" });
  const olSel = h("select", { "aria-label": "Ollama model" });
  const vSel = h("select", { "aria-label": "Voice" });
  const apiUrl = h("input", { type: "text", placeholder: "https://…/v1", "aria-label": "API base URL" });
  const apiModel = h("input", { type: "text", placeholder: "model name", "aria-label": "API model" });
  const apiKey = h("input", { type: "password", placeholder: "API key (kept in this tab only)", "aria-label": "API key" });
  const exCb = h("input", { type: "checkbox" }); exCb.checked = explain;
  const autoCb = h("input", { type: "checkbox" }); autoCb.checked = autoApply;
  const pitchModelCb = h("input", { type: "checkbox" }); pitchModelCb.checked = localStorage.getItem("ss_director_pitch_model") === "1";
  const apiRows = [h("span", {}, "API URL"), apiUrl, h("span", {}, "API model"), apiModel, h("span", {}, "API key"), apiKey];
  const olRows = [h("span", {}, "Ollama"), olSel];
  const settings = h("div", { class: "set", hidden: true },
    h("span", {}, "Model"), beSel, ...olRows, ...apiRows, h("span", {}, "Voice"), vSel,
    h("label", { class: "cb" }, exCb, "Explain each step in film terms and suggest the next one"),
    h("label", { class: "cb" }, autoCb, "Apply without asking (renders still ask unless you say “go”)"),
    h("label", { class: "cb" }, pitchModelCb, "Pitch: the local model also reads each beat (slower, 2–6 s a beat)"));
  const panel = h("section", { class: "ss-dir", hidden: true, role: "dialog", "aria-label": "Director's assistant" },
    h("header", {}, h("span", { class: "t" }, icon("clapperboard", 16), "Director"), pitchBtn, beLbl, setBtn, closeBtn),
    settings, log, chips, pitchBox, h("div", { class: "comp" }, mic, input, sendB), hint);
  for (const ev of ["pointerdown", "wheel", "keydown", "keyup", "contextmenu"]) panel.addEventListener(ev, stop);
  root.append(panel);

  const button = h("button", { type: "button", class: "ss-btn ss-dirbtn", title: "Director: talk to the set (/)", "aria-label": "Open the Director's assistant",
    "aria-pressed": "false" }, icon("message-square", 15), h("span", { class: "lbl" }, " Director"));
  button.dataset.ssIcon = "message-square";
  button.addEventListener("pointerdown", stop);
  button.addEventListener("click", () => toggle());
  if (topBar) { if (before && before.parentNode === topBar) topBar.insertBefore(button, before); else topBar.append(button); }

  // ---------------------------------------------------------------- settings
  const fillBackends = async () => {
    const info = await director.info();
    const opts = [["auto", `Auto (${info.available ? "local Qwen3.5 4B" : "rules: Qwen3.5 4B not installed"})`], ["qwen", BACKENDS.qwen], ["ollama", BACKENDS.ollama], ["rules", BACKENDS.rules]];
    if (info.partner) opts.push(["api", BACKENDS.api]);
    beSel.replaceChildren(...opts.map(([v, l]) => h("option", { value: v }, l)));
    beSel.value = opts.some(([v]) => v === director.backend) ? director.backend : "auto";
    const models = await director.ollamaModels();
    olSel.replaceChildren(...(models.length ? models.map((m) => h("option", { value: m.name }, `${m.name}${m.size ? ` · ${m.size}` : ""}`)) : [h("option", { value: "" }, "Ollama not running")]));
    olSel.value = models.some((m) => m.name === director.ollama.model) ? director.ollama.model : (pickOllama(models)?.name || "");
    const vs = [["whisper", `Whisper on the server (offline${info.whisper?.available ? "" : ": not installed"})`]];
    if (SR) vs.unshift(["browser", "Browser speech recognition"]);
    vSel.replaceChildren(...vs.map(([v, l]) => h("option", { value: v }, l)));
    vSel.value = vs.some(([v]) => v === voice) ? voice : vs[0][0];
    apiUrl.value = director.apiModel.url; apiModel.value = director.apiModel.model;
    syncSettings();
  };
  const syncSettings = () => {
    for (const e of olRows) e.hidden = beSel.value !== "ollama";
    for (const e of apiRows) e.hidden = beSel.value !== "api";
    const lab = beSel.selectedOptions[0]?.textContent || "";
    beLbl.textContent = beSel.value === "ollama" ? `Ollama · ${olSel.value || "?"}` : lab.replace(/\s*\(.*$/, "");
  };
  beSel.addEventListener("change", () => { director.setBackend(beSel.value); syncSettings(); });
  olSel.addEventListener("change", () => { director.setOllama({ model: olSel.value }); syncSettings(); });
  vSel.addEventListener("change", () => { voice = vSel.value; localStorage.setItem("ss_director_voice", voice); });
  for (const x of [apiUrl, apiModel]) x.addEventListener("change", () => director.setApiModel({ url: apiUrl.value.trim(), model: apiModel.value.trim() }));
  apiKey.addEventListener("change", () => { director.apiModel.key = apiKey.value.trim(); });
  exCb.addEventListener("change", () => { explain = exCb.checked; localStorage.setItem("ss_director_explain", explain ? "1" : "0"); });
  autoCb.addEventListener("change", () => { autoApply = autoCb.checked; localStorage.setItem("ss_director_auto", autoApply ? "1" : "0"); });
  setBtn.addEventListener("click", () => { settings.hidden = !settings.hidden; if (!settings.hidden) fillBackends(); });
  closeBtn.addEventListener("click", () => close());

  // ---------------------------------------------------------------- log
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const say = (cls, ...kids) => { const m = h("div", { class: `msg ${cls}` }, ...kids); log.append(m); scroll(); return m; };
  const setChips = (list) => {
    chips.replaceChildren(...(list || []).map((c) => h("button", { type: "button", title: c.command, on: { click: () => send(c.command) } }, c.label)));
  };
  const greet = () => {
    say("a", "Tell me what you want on the set, in your own words. I'll show you the plan; press Apply (or Enter, or say “yes”) and watch the stage. Every change can be undone.");
    setChips(EXAMPLES.slice(0, 4).map((c) => ({ label: c.length > 34 ? `${c.slice(0, 32)}…` : c, command: c })));
  };

  function onEvent(ev) {
    if (ev.type === "thinking" && waitMsg) waitMsg.textContent = `Thinking (${ev.backend === "qwen" ? "Qwen3.5 4B on the GPU queue" : ev.backend})…`;
    if (ev.type === "step" && stepMsg) stepMsg.textContent = ev.call.plan.replace(/^I'll /, "Now: ");
  }
  let waitMsg = null, stepMsg = null;

  function planCard(p, { source = "panel" } = {}) {
    const items = p.calls.map((c) => h("li", {}, c.plan.replace(/^I'll /, "")));
    const rej = (p.rejected || []).map((r) => h("li", { class: "no", title: r.why }, `couldn't: ${r.why}`));
    const card = say("a", p.calls.length ? "Here's the plan:" : "I couldn't turn that into a change on the set.", (items.length || rej.length) ? h("ol", {}, ...items, ...rej) : null);
    const tm = p.timing || {};
    const busy = (p.notes || []).find((n) => /GPU is busy|model unavailable/.test(n));
    if (busy) card.append(h("div", { class: "meta" }, busy[0].toUpperCase() + busy.slice(1) + "."));
    card.append(h("div", { class: "meta" }, `${p.backend === "llm" ? (p.used_backend === "ollama" ? `Ollama ${director.ollama.model || ""}` : p.used_backend === "api" ? "API model" : "Qwen3.5 4B") : "rules"}` +
      ` · ${((tm.propose_ms || 0) / 1000).toFixed(1)} s${tm.llm_ms ? ` (model ${(tm.llm_ms / 1000).toFixed(1)} s)` : ""}`));
    if (!p.calls.length) {
      setChips([{ label: "Show me examples", command: "" }].filter(() => false).concat(EXAMPLES.slice(4, 7).map((c) => ({ label: c, command: c }))));
      return null;
    }
    const gpuN = p.calls.filter((c) => c.gpu).length;
    if (p.confirm) card.append(h("div", { class: "gpu" }, `This uses the GPU (${gpuN} job${gpuN === 1 ? "" : "s"}). Nothing renders until you press Apply.`));
    const go = h("button", { type: "button", class: "go" }, icon("check", 13), p.confirm ? "Apply & render" : "Apply", h("span", { class: "k" }, "⏎"));
    const no = h("button", { type: "button" }, "Cancel", h("span", { class: "k" }, "Esc"));
    const row = h("div", { class: "row" }, go, no);
    card.append(row);
    const entry = { plan: p, card, row, source, done: false };
    go.addEventListener("click", () => applyPending(entry));
    no.addEventListener("click", () => discard(entry));
    return entry;
  }

  async function applyPending(entry = pending, { confirmGpu = null } = {}) {
    if (!entry || entry.done) return null;
    entry.done = true;
    if (pending === entry) pending = null;
    entry.row.replaceChildren(h("span", { class: "meta" }, "Applying…"));
    stepMsg = entry.row.firstChild;
    busy = true;
    let res;
    try {
      res = await director.apply(entry.plan, { confirmGpu: confirmGpu ?? true, source: entry.source });
    } catch (e) {
      res = { ok: false, results: [], said: [`That didn't work: ${e.message || e}`], next: [] };
    } finally { busy = false; stepMsg = null; }
    entry.row.remove();
    const list = h("ul", {}, ...res.results.map((r) => h("li", { class: r.ok ? "ok" : "bad" }, r.said)));
    const msg = say("a", list);
    if (explain && res.explain) msg.append(h("div", { class: "why" }, res.explain));
    if (res.undoable) {
      const u = h("button", { type: "button" }, icon("undo-2", 13), "Undo this");
      u.addEventListener("click", () => { const l = director.undo(); u.disabled = true; say("a", l ? `Undid: ${l}` : "Nothing to undo."); });
      msg.append(h("div", { class: "row" }, u));
    }
    if (explain && res.next?.length) msg.append(h("div", { class: "why" }, `Next, you could: ${res.next.map((n) => n.label.toLowerCase()).join(" · ")}`));
    setChips(res.next);
    try { host.say?.(res.said.join(" ")); } catch { /* */ }
    return res;
  }

  function discard(entry = pending) {
    if (!entry || entry.done) return;
    entry.done = true;
    if (pending === entry) pending = null;
    entry.row.replaceChildren(h("span", { class: "meta" }, "Cancelled: nothing changed."));
  }

  /** Send a command (typed, spoken, or a chip). Resolves with {plan, result?}. */
  async function send(text, { source = "panel", apply = null } = {}) {
    text = String(text || "").trim();
    if (pitch.active && source === "panel") { if (text) pitch.hear(text, { final: true }); return null; }
    if (!text) { if (pending) return { result: await applyPending(pending) }; return null; }
    if (pending && YES_RE.test(text)) { say("u", text); return { result: await applyPending(pending) }; }
    if (pending && NO_RE.test(text)) { say("u", text); discard(pending); return null; }
    if (busy) { say("a wait", "One moment: still on the last one."); return null; }
    if (pending) discard(pending);
    open();
    say("u", text);
    waitMsg = say("a wait", "Reading that…");
    busy = true;
    let p;
    try { p = await director.propose(text); }
    catch (e) { waitMsg.remove(); waitMsg = null; busy = false; say("a", `I couldn't plan that: ${e.message || e}`); return null; }
    busy = false;
    waitMsg.remove(); waitMsg = null;
    const entry = planCard(p, { source });
    if (!entry) return { plan: p };
    pending = entry;
    const auto = apply ?? (autoApply && !p.confirm);
    if (auto || (p.confirm === false && p.gpu && wantsGo(text))) return { plan: p, result: await applyPending(entry) };
    return { plan: p };
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const t = input.value; input.value = ""; send(t); }
    else if (e.key === "Escape") { e.preventDefault(); if (pending) discard(pending); else { close(); host.focusStage?.(); } }
    else if (e.key === " " && !input.value && !e.repeat) { e.preventDefault(); startTalk("space"); }
  });
  input.addEventListener("keyup", (e) => { if (e.key === " " && listening?.key === "space") { e.preventDefault(); stopTalk(); } });
  sendB.addEventListener("click", () => { const t = input.value; input.value = ""; send(t); });

  // ---------------------------------------------------------------- voice
  async function startTalk(key = "mouse") {
    if (listening || (pitch.active && pitchListen)) return;    // the pitch is already listening continuously
    open();
    mic.dataset.on = "true";
    const shown = input.placeholder;
    input.placeholder = "Listening… (let go to send)";
    const done = (text) => { mic.dataset.on = "false"; input.placeholder = shown; listening = null; if (text?.trim()) { input.value = ""; send(text.trim()); } };
    if (voice === "browser" && SR) {
      const rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      let finalText = "";
      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript; else interim += ev.results[i][0].transcript;
        }
        input.value = (finalText + interim).trim();
      };
      rec.onerror = (ev) => { say("a", `The browser's speech recognition stopped (${ev.error}). Switch Voice to Whisper in ⚙ for the offline one.`); };
      let ended = false;
      rec.onend = () => { if (!ended) { ended = true; done(finalText || input.value); } };
      try { rec.start(); } catch (e) { done(""); say("a", `Mic: ${e.message}`); return; }
      listening = { key, stop: () => { try { rec.stop(); } catch { /* */ } } };
      return;
    }
    // Whisper: record PCM, encode WAV, transcribe on the server.
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { done(""); say("a", `No microphone (${e.message}).`); return; }
    const ac = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (ev) => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(ac.destination);
    listening = { key, stop: async () => {
      try { proc.disconnect(); src.disconnect(); } catch { /* */ }
      for (const t of stream.getTracks()) t.stop();
      const n = chunks.reduce((s, c) => s + c.length, 0), all = new Float32Array(n);
      let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
      const rate = ac.sampleRate;
      ac.close?.();
      if (n < rate * 0.25) { done(""); return; }
      input.placeholder = "Transcribing (Whisper)…";
      try { done(await transcribe(encodeWav(downsample(all, rate, 16000), 16000))); }
      catch (e) { done(""); say("a", `Couldn't transcribe: ${e.message}`); }
    } };
  }
  function stopTalk() { const l = listening; if (l) l.stop(); }
  async function transcribe(wav, prompt = "") {
    const headers = { "Content-Type": "audio/wav" };
    if (prompt) headers["X-Soundstage-Prompt"] = encodeURIComponent(prompt.slice(-400));
    const r = await api.fetchApi("/soundstage/director/transcribe", { method: "POST", headers, body: wav });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `server answered ${r.status}`);
    return j.text || "";
  }
  mic.addEventListener("pointerdown", (e) => { e.preventDefault(); startTalk("mouse"); });
  for (const ev of ["pointerup", "pointerleave"]) mic.addEventListener(ev, () => { if (listening?.key === "mouse") stopTalk(); });

  // ---------------------------------------------------------------- keys
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !root.isConnected || !isActive()) return;
    const typing = editable(e.target) && e.target !== input;
    if (e.key === "/" && !typing && (e.target !== input || !input.value)) { e.preventDefault(); e.stopPropagation(); open(); input.focus(); return; }
    if ((e.key === "p" || e.key === "P") && e.shiftKey && !typing && e.target !== input && !e.repeat) { e.preventDefault(); e.stopPropagation(); togglePitch(); return; }
    if ((e.key === "`" || e.code === "Backquote") && !typing && !e.repeat) { e.preventDefault(); e.stopPropagation(); startTalk("bq"); return; }
    if (e.key === " " && !panel.hidden && !typing && e.target !== input && !e.repeat) { e.preventDefault(); e.stopPropagation(); startTalk("space"); }
  };
  const onKeyUp = (e) => {
    if ((e.key === "`" || e.code === "Backquote") && listening?.key === "bq") { e.preventDefault(); stopTalk(); }
    if (e.key === " " && listening?.key === "space") { e.preventDefault(); e.stopPropagation(); stopTalk(); }
    if (e.key === "Escape" && !panel.hidden && panel.contains(document.activeElement) && !pending) close();
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKeyUp, true);

  // ---------------------------------------------------------------- Pitch Mode
  // ● Pitch (or Shift+P): the mic stays on, every sentence or clause is a beat: the set builds itself (undoable, one
  // Director step for the whole pitch, Undo beat for the last one) and a fast FLUX 3 Klein sketch of the camera view
  // lands in the filmstrip. Lock it turns the beats into shots with the sketches as first frames.
  let pitchListen = null;      // {stop()} while the pitch mic is on
  let selBeat = null;
  const pitch = new PitchSession({ api, stage, director, host, onUpdate: (_, why, x) => drawPitch(why, x),
    opts: { model: pitchModelCb.checked ? "auto" : "rules" } });
  pitchModelCb.addEventListener("change", () => { pitch.opts.model = pitchModelCb.checked ? "auto" : "rules"; localStorage.setItem("ss_director_pitch_model", pitchModelCb.checked ? "1" : "0"); });
  const fmt = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}s`);
  function drawPitch(why, x) {
    pitchBtn.setAttribute("aria-pressed", String(pitch.active));
    pitchBox.hidden = !pitch.active && !pitch.beats.length;
    pMic.replaceChildren(icon(pitchListen ? "pause" : "mic", 13), pitchListen ? "Pause mic" : "Listen");
    pUndo.disabled = !pitch.beats.length;
    pLock.disabled = !pitch.beats.length;
    const sel = selBeat && pitch.beats.includes(selBeat) ? selBeat : pitch.beats[pitch.beats.length - 1];
    pMotion.disabled = !sel?.sketch?.file || sel?.motion?.status === "rendering";
    const said = pitch.beats.slice(-3).map((b) => b.text).join(" ");
    pTx.replaceChildren(said ? `${said} ` : "", pitch.rest || pitch.interim ? h("i", {}, `${pitch.rest} ${pitch.interim}`.trim()) : "",
      !said && !pitch.rest && !pitch.interim ? h("i", {}, pitch.active ? "Listening… pitch the scene: where, when, who, what happens, where the camera is." : "Pitch paused.") : "");
    const t = pitch.hud || {};
    pHud.replaceChildren(t.n ? h("span", {}, `beat ${t.n} · heard ${fmt(t.heard_ms)} · plan ${fmt(t.plan_ms)}${t.llm_ms != null ? ` · model ${fmt(t.llm_ms)}` : ""} · sketch ${fmt(t.sketch_ms)} · `, h("b", {}, `sentence → image ${fmt(t.total_ms)}`))
      : h("span", {}, pitch.beats.length ? `beat ${pitch.beats.length} staged · sketch on the GPU…` : "Each sentence: transcribe → plan → stage → sketch"));
    const lastB = pitch.beats[pitch.beats.length - 1];
    if (lastB?.sketch?.status === "rendering" && lastB.sketch.blocked) pHud.replaceChildren(h("span", {}, "The GPU is busy with another job: sketches wait behind it (the set keeps building)."));
    if (why === "interim" || why === "heard") return;
    pStrip.replaceChildren(...pitch.beats.map((b) => {
      const st = b.sketch?.status || "none";
      const media = b.motion?.status === "done" && b.motion.url ? h("video", { src: api.apiURL ? api.apiURL(b.motion.url) : b.motion.url, muted: true, autoplay: true, loop: true, playsinline: true })
        : st === "done" ? h("img", { src: b.sketch.url, alt: `Beat ${b.n} sketch` })
          : h("div", { class: "im", "data-st": st }, { rendering: "sketching…", skipped: "skipped · click to sketch", error: "sketch failed · click to retry", none: "staged", stale: "…" }[st] || st);
      const card = h("div", { class: "beat", role: "listitem", "data-sel": String(b === sel), title: `${b.text}\n${b.caption || ""}${b.sketch?.error ? `\n(${b.sketch.error})` : ""}` },
        media, h("span", { class: "n" }, String(b.n)), b.timing?.total_ms ? h("span", { class: "ms" }, fmt(b.timing.total_ms)) : null,
        b.motion?.status === "rendering" ? h("span", { class: "ms" }, "motion…") : null,
        h("div", { class: "cap" }, b.caption || b.text));
      card.addEventListener("click", () => { selBeat = b; if (["skipped", "error"].includes(b.sketch?.status)) pitch.resketch(b); drawPitch(); });
      return card;
    }));
    if (why === "beat" || why === "sketch") pStrip.scrollLeft = pStrip.scrollWidth;
    if (why === "beat" && x) { try { host.say?.(`Pitch beat ${x.n}: ${x.caption}`); } catch { /* */ } }
    if (why === "locked") say("a", `Locked: ${x.shots.length} shot${x.shots.length === 1 ? "" : "s"}, one per beat${x.frames ? `, ${x.frames} with the sketch as first frame` : ""}. They're in the strip, ready for ④ Frame and ⑤ Motion. Undo takes it back.`);
  }

  function startPitchListen() {
    if (pitchListen) return;
    if (voice === "browser" && SR) {
      const rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      let alive = true, told = false, me = null;
      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) pitch.hear(ev.results[i][0].transcript, { final: true });
          else interim += ev.results[i][0].transcript;
        }
        if (interim) pitch.hear(interim, { interim: true });
      };
      rec.onerror = (ev) => {
        if (ev.error === "no-speech" || ev.error === "aborted") return;
        // A denied or missing mic doesn't fix itself: stop the restart loop (onend restarted it, and every restart said
        // this again, a dozen times a second; QA round 07) and say it once.
        const fatal = /not-allowed|service-not-allowed|audio-capture/.test(ev.error);
        if (fatal) { alive = false; setTimeout(() => { if (me && pitchListen === me) stopPitchListen(); }, 0); }
        if (!told) { told = true; say("a", `Speech recognition stopped (${ev.error}). Switch Voice to Whisper in ⚙ for the offline one.`); }
      };
      rec.onend = () => { if (alive && pitch.active) { try { rec.start(); } catch { /* */ } } };   // Chrome stops after ~60 s of talk
      try { rec.start(); } catch (e) { say("a", `Mic: ${e.message}`); return; }
      me = pitchListen = { stop: () => { alive = false; try { rec.stop(); } catch { /* */ } } };
    } else {
      // Whisper hears the pitch better when it knows the words to expect: film terms and the last beats.
      let warned = false;
      pitchListen = whisperStream((wav, t0) => transcribe(wav, pitch.whisperHint())
        .then((t) => t && !looksLikeNoise(t) && pitch.hear(t, { final: true, heardMs: performance.now() - t0 }))
        .catch((e) => { if (!warned) { warned = true; say("a", `Whisper didn't answer (${e.message || e}): is ComfyUI restarting? Still listening.`); } }));
    }
    drawPitch();
  }
  function stopPitchListen() { const l = pitchListen; pitchListen = null; l?.stop(); drawPitch(); }

  /** Whisper's known failure on noise or a cut word: one syllable repeated ("we-we-we-we..."). Dropped, not staged. */
  function looksLikeNoise(t) { const w = t.toLowerCase().split(/[\s-]+/).filter(Boolean); return w.length >= 8 && new Set(w).size / w.length < 0.25; }

  /** Whisper, live: cut the mic into windows at a pause (≥ 0.45 s quiet after ≥ 0.3 s of speech) or at 5 s. */
  function whisperStream(onWindow) {
    let stopped = false, stream = null, ac = null, proc = null, src = null;
    const buf = [];
    let speech = 0, quiet = 0, rate = 16000;
    const flush = () => {
      const n = buf.reduce((a, c) => a + c.length, 0);
      if (n < rate * 0.5 || speech < rate * 0.25) { buf.length = 0; speech = 0; quiet = 0; return; }
      const all = new Float32Array(n);
      let o = 0; for (const c of buf) { all.set(c, o); o += c.length; }
      buf.length = 0; speech = 0; quiet = 0;
      onWindow(encodeWav(downsample(all, rate, 16000), 16000), performance.now());
    };
    (async () => {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
      catch (e) { say("a", `No microphone (${e.message}).`); pitchListen = null; drawPitch(); return; }
      if (stopped) { for (const t of stream.getTracks()) t.stop(); return; }
      ac = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      rate = ac.sampleRate;
      src = ac.createMediaStreamSource(stream);
      // An AudioWorklet copies the mic off the main thread, so a beat staging on the main thread can't drop audio
      // (a ScriptProcessor loses whole buffers while the stage rebuilds); the ScriptProcessor is the fallback.
      const onChunk = (x) => {
        let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
        const loud = Math.sqrt(e / x.length) > 0.012;
        buf.push(x);
        if (loud) { speech += x.length; quiet = 0; } else quiet += x.length;
        const len = buf.reduce((a, c) => a + c.length, 0);
        if ((speech > rate * 0.3 && quiet > rate * 0.45) || len > rate * 5) flush();
        else if (!speech && len > rate * 1.5) buf.splice(0, buf.length - 2);   // keep a little lead-in only
      };
      try {
        const code = "registerProcessor('ss-pitch-tap', class extends AudioWorkletProcessor { constructor() { super(); this.b = new Float32Array(4096); this.n = 0; } " +
          "process(i) { const c = i[0] && i[0][0]; if (c) { for (let k = 0; k < c.length; k++) { this.b[this.n++] = c[k]; if (this.n === 4096) { this.port.postMessage(this.b); this.b = new Float32Array(4096); this.n = 0; } } } return true; } });";
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        await ac.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        proc = new AudioWorkletNode(ac, "ss-pitch-tap");
        proc.port.onmessage = (ev) => onChunk(ev.data);
        src.connect(proc); proc.connect(ac.destination);   // silent output: keeps the node pulled
      } catch {
        proc = ac.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
        src.connect(proc); proc.connect(ac.destination);
      }
    })();
    return { stop: () => { stopped = true; try { proc?.disconnect(); src?.disconnect(); } catch { /* */ } flush(); for (const t of stream?.getTracks?.() || []) t.stop(); ac?.close?.(); } };
  }

  function startPitch({ listen = true } = {}) {
    open();
    if (pending) discard(pending);
    pitch.start();
    if (listen) startPitchListen();
    input.placeholder = "Pitching: talk, or type a sentence (Enter)…";
    drawPitch("start");
  }
  function stopPitch() {
    stopPitchListen();
    pitch.stop();
    input.placeholder = "Tell the set what you want… (Enter)";
    drawPitch("stop");
  }
  function togglePitch() { if (pitch.active) stopPitch(); else startPitch(); }
  pitchBtn.addEventListener("click", togglePitch);
  pMic.addEventListener("click", () => { if (pitchListen) stopPitchListen(); else { if (!pitch.active) pitch.start(); startPitchListen(); } });
  pUndo.addEventListener("click", () => { const b = pitch.undoBeat(); if (b) say("a", `Undid beat ${b.n}: ${b.text}`); drawPitch(); });
  pMotion.addEventListener("click", async () => {
    const b = selBeat && pitch.beats.includes(selBeat) ? selBeat : pitch.beats[pitch.beats.length - 1];
    try { await pitch.previewMotion(b); } catch (e) { say("a", `Preview motion: ${e.message || e}`); }
  });
  pLock.addEventListener("click", async () => {
    stopPitchListen();
    pLock.disabled = true;
    try { await pitch.lock(); } catch (e) { say("a", `Couldn't lock the pitch: ${e.message || e}`); }
    drawPitch();
  });

  // ---------------------------------------------------------------- docking
  // Like the Presets window (web/ui/presets.mjs), the chat never covers another panel or the stage's controls. It sits
  // at the right of the free band between the side panels (the tool rail, Look, Properties...), above whatever bar runs
  // under it (the playback row: Play, Fit, Hide top view). When no band is wide enough it takes the Properties slot
  // while it's open (Properties hides, and is back when the chat closes).
  const dockState = { took: [], timer: 0 };
  function undock() { for (const el of dockState.took) el.style.visibility = el.dataset.ssPreVis || ""; dockState.took = []; }
  function dock() {
    if (panel.hidden) return null;
    const rr = root.getBoundingClientRect();
    if (!rr.width || !rr.height) return null;
    undock();   // weigh Properties again (same task: no frame shows it), so it comes back once there's room beside it
    const obstacles = [...root.querySelectorAll(DIR_OTHERS)].filter((el) => {
      if (el === panel || panel.contains(el) || el.contains(panel) || !el.getClientRects().length) return false;
      const cs = getComputedStyle(el);
      if ((cs.position !== "absolute" && cs.position !== "fixed") || cs.visibility === "hidden" || cs.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.width < rr.width * 0.9;
    }).map((el) => ({ el, r: el.getBoundingClientRect() }));
    const r = dockSlot(rr, obstacles);
    if (!r) { Object.assign(panel.style, { left: "", right: "", top: "", bottom: "", width: "", maxHeight: "" }); return null; }
    for (const el of r.take) { el.dataset.ssPreVis = el.style.visibility || ""; el.style.visibility = "hidden"; dockState.took.push(el); }
    Object.assign(panel.style, { left: "auto", top: "auto", right: Math.round(rr.right - r.right) + "px", bottom: Math.round(rr.bottom - r.bottom) + "px",
      width: Math.round(r.right - r.left) + "px", maxHeight: Math.round(r.bottom - r.top) + "px" });
    return { left: Math.round(r.left - rr.left), top: Math.round(r.top - rr.top), right: Math.round(r.right - rr.left), bottom: Math.round(r.bottom - rr.top), took: dockState.took.length };
  }
  const onResize = () => { if (!panel.hidden) { undock(); dock(); } };
  window.addEventListener("resize", onResize);

  // ---------------------------------------------------------------- open / close
  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    button.setAttribute("aria-pressed", "true");
    if (!log.childElementCount) { greet(); fillBackends(); }
    dock();
    clearInterval(dockState.timer);
    dockState.timer = setInterval(() => { if (!root.isConnected) return; dock(); }, 500);   // a panel opened, collapsed or resized under it
  }
  function close() {
    panel.hidden = true; button.setAttribute("aria-pressed", "false"); if (listening) stopTalk();
    if (pitch.active) stopPitch();
    clearInterval(dockState.timer); dockState.timer = 0; undock();
  }
  function toggle() { if (panel.hidden) { open(); input.focus(); } else close(); }

  // ---------------------------------------------------------------- MCP bridge
  // The open App reports its scene to the server (so an MCP client can plan against it) and runs what it applies.
  let lastSig = "";
  const report = async () => {
    if (!root.isConnected) return;
    try {
      const scene = stage.toJSON(), ctx = director.context();
      const sig = JSON.stringify(scene) + JSON.stringify(ctx);
      if (sig === lastSig) return;
      lastSig = sig;
      await api.fetchApi("/soundstage/director/state", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene, ctx, client_id: api.clientId || null }) });
    } catch { /* server away */ }
  };
  const timer = setInterval(report, 2500);
  setTimeout(report, 1500);
  const onRemote = async (ev) => {
    const d = ev.detail || {};
    if (!d.id || !root.isConnected) return;
    let result;
    try {
      if (d.kind === "undo") { const l = director.undo(); open(); say("u", h("span", { class: "src" }, "MCP"), "undo"); say("a", l ? `Undid: ${l}` : "Nothing to undo."); result = { ok: !!l, undid: l }; }
      else if (d.kind === "apply" && d.plan) {
        open();
        say("u", h("span", { class: "src" }, "Claude · MCP"), d.plan.command || d.plan.summary || "typed calls");
        const entry = planCard(d.plan, { source: "mcp" });
        result = entry ? await applyPending(entry, { confirmGpu: !!d.confirm_gpu }) : { ok: false, said: ["nothing to apply"] };
        result = { ok: result.ok, said: result.said, results: result.results, next: result.next, queued: result.queued };
      }
    } catch (e) { result = { ok: false, error: String(e.message || e) }; }
    lastSig = "";
    report();
    try { await api.fetchApi("/soundstage/director/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.id, result }) }); }
    catch { /* server away */ }
  };
  api.addEventListener?.("soundstage.director", onRemote);

  const destroy = () => {
    clearInterval(timer); clearInterval(dockState.timer); undock();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKeyUp, true);
    api.removeEventListener?.("soundstage.director", onRemote);
    stopPitchListen(); pitch.destroy();
    panel.remove(); button.remove();
  };
  return { director, panel, button, open, close, toggle, send, apply: () => applyPending(pending), discard: () => discard(pending),
    get pending() { return pending?.plan || null; }, startTalk, dock, isOpen: () => !panel.hidden, stopTalk, destroy, transcribe,
    pitch, startPitch, stopPitch,
    setVoice: (v) => { if (v === "browser" && !SR) return voice; voice = v; localStorage.setItem("ss_director_voice", v); if ([...vSel.options].some((o) => o.value === v)) vSel.value = v; return voice; } };
}
