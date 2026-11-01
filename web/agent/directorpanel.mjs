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
  const apiRows = [h("span", {}, "API URL"), apiUrl, h("span", {}, "API model"), apiModel, h("span", {}, "API key"), apiKey];
  const olRows = [h("span", {}, "Ollama"), olSel];
  const settings = h("div", { class: "set", hidden: true },
    h("span", {}, "Model"), beSel, ...olRows, ...apiRows, h("span", {}, "Voice"), vSel,
    h("label", { class: "cb" }, exCb, "Explain each step in film terms and suggest the next one"),
    h("label", { class: "cb" }, autoCb, "Apply without asking (renders still ask unless you say “go”)"));
  const panel = h("section", { class: "ss-dir", hidden: true, role: "dialog", "aria-label": "Director's assistant" },
    h("header", {}, h("span", { class: "t" }, icon("clapperboard", 16), "Director"), beLbl, setBtn, closeBtn),
    settings, log, chips, h("div", { class: "comp" }, mic, input, sendB), hint);
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
    if (listening) return;
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
  async function transcribe(wav) {
    const r = await api.fetchApi("/soundstage/director/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
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

  // ---------------------------------------------------------------- open / close
  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    button.setAttribute("aria-pressed", "true");
    if (!log.childElementCount) { greet(); fillBackends(); }
  }
  function close() { panel.hidden = true; button.setAttribute("aria-pressed", "false"); if (listening) stopTalk(); }
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
    clearInterval(timer);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKeyUp, true);
    api.removeEventListener?.("soundstage.director", onRemote);
    panel.remove(); button.remove();
  };
  return { director, panel, button, open, close, toggle, send, apply: () => applyPending(pending), discard: () => discard(pending),
    get pending() { return pending?.plan || null; }, startTalk, stopTalk, destroy, transcribe };
}
