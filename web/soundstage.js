// Soundstage frontend entry. Registers the SOUNDSTAGE_STAGE widget: a three.js stage inside the
// node (and inside App mode), with lens, sun and view controls. At queue time it renders the
// clay and depth passes from the shot camera, uploads them as temp images, and sends
// {scene, passes} as the widget's prompt value.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { Stage, DEFAULT_SCENE, ASPECTS, IMPORT_ACCEPT, formatOf, CAR_SHOTS } from "./stage/stage.mjs";
import { quickSpec } from "./stage/interior.mjs";
import { LIBRARY, OBJECT_COLORS, SEATS } from "./stage/library.mjs";
import { APPEARANCE_OPTIONS, DEFAULT_APPEARANCE, SKIN_TONES, MOUNTS } from "./stage/humans.mjs";
import { SETS, WEATHER } from "./stage/environments.mjs";
import { TIME_PRESETS, LIGHT_TYPES, clock } from "./stage/lighting.mjs";
import { LadderViewer, RUNG_NAMES } from "./ladder/ladder.mjs";
import { LookPanel } from "./look/look.mjs";
import { SceneAgent, loadScene } from "./agent/agent.mjs";
import { CutPanel } from "./cut/cut.mjs";
import { ShotStrip, readSaved } from "./cut/strip.mjs";
import { CanvasPanel } from "./canvas/canvas.mjs";
import { CameraViz, PipViewer, TopView } from "./stage/camviz.mjs";
import { TrackSheet } from "./stage/tracks.mjs";
import { Pipeline } from "./pipeline/pipeline.mjs";
import { lensCards, sunDome } from "./ui/cinegear.mjs";
import { Coach } from "./coach/coach.mjs";
import { castSig } from "./coach/rules.mjs";
import { AdvisorPanel } from "./advisor/advisor.mjs";
import * as maker from "./assets3d/maker.mjs";
import { applyTheme } from "./ui/theme.mjs";
import { icon } from "./ui/icons.mjs";
import * as THREE from "./vendor/three.module.min.mjs";
import { listenVcam, LiveVcam, listTakes, fetchTake, takeToCamera, anchorFromCamera } from "./vcam/live.mjs";

const CSS = `
.ss-stage { display:flex; flex-direction:column; gap:6px; padding:6px; background:#16191e; border-radius:6px;
  font:12px/1.3 -apple-system, "Segoe UI", sans-serif; color:#cfd5de; box-sizing:border-box; width:100%; }
.ss-bar { display:flex; flex-wrap:wrap; gap:6px 12px; align-items:center; }
.ss-bar label { display:flex; align-items:center; gap:6px; white-space:nowrap; }
.ss-bar input[type=range] { width:110px; accent-color:#e39a40; }
.ss-bar output { min-width:42px; font-variant-numeric:tabular-nums; color:#fff; }
.ss-views { display:flex; gap:2px; margin-left:auto; }
.ss-views button { background:#262b33; color:#cfd5de; border:1px solid #39404b; padding:3px 9px; cursor:pointer; font:inherit; }
.ss-views button:first-child { border-radius:4px 0 0 4px; } .ss-views button:last-child { border-radius:0 4px 4px 0; }
.ss-views button[aria-pressed=true] { background:#e39a40; color:#16191e; border-color:#e39a40; }
.ss-hint { color:#7d8694; font-size:11px; }
.ss-time { display:flex; gap:8px; align-items:center; }
.ss-time input[type=range] { flex:1; accent-color:#e39a40; }
.ss-btn { background:#262b33; color:#cfd5de; border:1px solid #39404b; border-radius:4px; padding:3px 9px; cursor:pointer; font:inherit; }
.ss-btn:focus-visible, .ss-views button:focus-visible { outline:2px solid #e39a40; outline-offset:1px; }
.ss-status { color:#e39a40; font-size:11px; min-height:14px; }
.ss-add input[type=text] { background:#0f1216; color:#e6e9ee; border:1px solid #39404b; border-radius:4px; padding:4px 8px; font:inherit; width:190px; }
.ss-sel { display:flex; gap:8px; align-items:center; }
.ss-sel[hidden] { display:none !important; }
.ss-chip { background:#3a2810; color:#e39a40; border-radius:999px; padding:2px 10px; }
.ss-tabs { display:flex; gap:2px; align-items:center; }
.ss-bar select { background:#0f1216; color:#e6e9ee; border:1px solid #39404b; border-radius:4px; padding:3px 6px; font:inherit; }
.ss-tabs button { background:#262b33; color:#cfd5de; border:1px solid #39404b; padding:4px 12px; cursor:pointer; font:inherit; font-weight:600; }
.ss-tabs button:first-child { border-radius:4px 0 0 4px; } .ss-tabs button:last-child { border-radius:0 4px 4px 0; }
.ss-tabs button[aria-pressed=true] { background:#e39a40; color:#16191e; border-color:#e39a40; }
.ss-ladderbar[hidden], .ss-ladder[hidden], .ss-stagebar[hidden], .ss-stageview[hidden] { display:none !important; }
.ss-rungs { display:flex; justify-content:space-between; color:#7d8694; font-size:11px; padding:0 2px; }
.ss-rungs span[data-ready=true] { color:#e39a40; }
.ss-stageview { position:relative; }
.ss-stage [hidden] { display:none !important; }
.ss-stage.ss-cutmode > :not(.ss-tabs):not(.ss-pipe):not(.ss-cutview) { display:none !important; }
.ss-stage.ss-pipemode > :not(.ss-tabs):not(.ss-pipe):not(.ss-pipeview) { display:none !important; }
.ss-stage.ss-advmode > :not(.ss-tabs):not(.ss-pipe):not(.ss-advisorview):not(.ss-striphost) { display:none !important; }
.ss-stage.ss-canvasmode > :not(.ss-tabs):not(.ss-pipe):not(.ss-canvasview):not(.ss-striphost):not(.ss-status) { display:none !important; }
.ss-stage.ss-full { position:fixed !important; inset:12px !important; z-index:10000 !important; width:auto !important;
  height:auto !important; overflow:auto; box-shadow:0 20px 60px rgba(0,0,0,.6); border:1px solid #39404b; }
.ss-stage.ss-full .ss-stageview canvas:not(.ss-gizmo), .ss-stage.ss-full .ss-ladder canvas { max-height:calc(100vh - 260px); object-fit:contain; }
.ss-expand { margin-left:auto; }
.ss-lightnote { color:#cfa36b; font-size:11px; font-style:italic; }
.ss-gizmo { position:absolute; top:8px; right:8px; width:84px; height:84px; cursor:pointer; }
.ss-viewbadge { position:absolute; top:8px; left:8px; font:600 11px/1 -apple-system,sans-serif; letter-spacing:.06em;
  text-transform:uppercase; padding:5px 8px; border-radius:4px; background:rgba(0,0,0,.55); color:#e6e9ee; pointer-events:none; }
.ss-viewbadge[data-free=true] { background:#e39a40; color:#16191e; }
`;

function injectCss() {
  if (document.getElementById("soundstage-css")) return;
  const s = document.createElement("style");
  s.id = "soundstage-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

function slider(label, min, max, step, value, fmt, onInput) {
  const wrap = document.createElement("label");
  const input = Object.assign(document.createElement("input"), { type: "range", min, max, step, value });
  const out = document.createElement("output");
  out.textContent = fmt(value);
  input.addEventListener("input", () => {
    out.textContent = fmt(+input.value);
    onInput(+input.value);
  });
  // Keep ComfyUI's canvas from treating slider drags as node drags; a whole slider drag is one undo step.
  input.addEventListener("pointerdown", (e) => { e.stopPropagation(); window.__ssSliding = true; });
  input.addEventListener("pointerup", () => { window.__ssSliding = false; });
  input.addEventListener("change", () => { window.__ssSliding = false; });
  wrap.append(label, input, out);
  return { wrap, input, out };
}

/**
 * Design a clay stand-in for any typed object. Uses the server cache first; otherwise queues a
 * tiny Qwen3.5 TextGenerate graph on this ComfyUI and sends its answer back to be cleaned and cached.
 */
async function designObject(name, onStatus) {
  const cached = await api.fetchApi(`/soundstage/object?name=${encodeURIComponent(name)}`);
  if (cached.status === 200) return cached.json();
  const info = await (await api.fetchApi("/soundstage/object_designer")).json();
  if (!info.available) throw new Error(`the designer model ${info.model} isn't installed`);
  onStatus(`Designing “${name}” with the local model… (first use loads the model, ~30 s)`);
  const graph = {
    ss1: { class_type: "CLIPLoader", inputs: { clip_name: info.model, type: "stable_diffusion", device: "default" } },
    ss2: { class_type: "PrimitiveStringMultiline", inputs: { value: info.system_prompt } },
    ss3: { class_type: "TextGenerate", inputs: { clip: ["ss1", 0], prompt: `Object: ${name}`, max_length: 1600,
      sampling_mode: "off", thinking: false, use_default_template: true, system_prompt: ["ss2", 0] } },
    ss4: { class_type: "PreviewAny", inputs: { source: ["ss3", 0] } },
  };
  const resp = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: api.clientId }) });
  const { prompt_id, error } = await resp.json();
  if (!prompt_id) throw new Error(error?.message || "the server refused the design job");
  const text = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out after 3 minutes")); }, 180000);
    const onExec = (ev) => {
      const d = ev.detail || {};
      if (d.prompt_id === prompt_id && d.node === "ss4") { cleanup(); resolve(d.output?.text?.[0] || ""); }
    };
    const onErr = (ev) => {
      if (ev.detail?.prompt_id === prompt_id) { cleanup(); reject(new Error(ev.detail.exception_message || "generation failed")); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      api.removeEventListener("executed", onExec);
      api.removeEventListener("execution_error", onErr);
    };
    api.addEventListener("executed", onExec);
    api.addEventListener("execution_error", onErr);
  });
  const saved = await api.fetchApi("/soundstage/object", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text }) });
  if (saved.status !== 200) throw new Error((await saved.json()).error || "unreadable design");
  return saved.json();
}

/** Short stable hash (FNV-1a, 32-bit) used to name captures after their scene. */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function uploadPass(blob, name) {
  const body = new FormData();
  body.append("image", new File([blob], name, { type: blob.type || "image/png" }));
  body.append("type", "temp");
  body.append("subfolder", "soundstage");
  body.append("overwrite", "true");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body });
  if (resp.status !== 200) throw new Error(`Soundstage: uploading ${name} failed (${resp.status})`);
  const j = await resp.json();
  return `${j.subfolder ? j.subfolder + "/" : ""}${j.name} [temp]`;
}

/** The pod may already hold this exact pass (same scene hash) from an earlier page session. */
async function passOnServer(name) {
  try {
    const r = await api.fetchApi(`/view?filename=${encodeURIComponent(name)}&subfolder=soundstage&type=temp`, { method: "HEAD" });
    return r.status === 200 ? `soundstage/${name} [temp]` : null;
  } catch { return null; }
}

function createStageWidget(node, inputName) {
  injectCss();
  applyTheme();
  const el = document.createElement("div");
  el.className = "ss-stage";
  // Right-click inside Soundstage never opens ComfyUI's canvas menu (hard to dismiss over the App); our own
  // right-click actions (delete a key, clip menu) handle the event first. Text fields keep the browser menu.
  el.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    if (!e.target.closest?.("input, textarea, [contenteditable]")) e.preventDefault();
  });
  el.addEventListener("pointerdown", (e) => { if (e.button === 2) e.stopPropagation(); });
  // Two views share the timeline: the 3D stage, and the preview ladder (fidelity slider).
  const tabs = document.createElement("div");
  tabs.className = "ss-tabs";
  const bar = document.createElement("div");
  bar.className = "ss-bar ss-stagebar";
  const view = document.createElement("div");
  view.className = "ss-stageview";
  const ladderBar = document.createElement("div");
  ladderBar.className = "ss-bar ss-ladderbar";
  ladderBar.hidden = true;
  const ladderView = document.createElement("div");
  ladderView.className = "ss-ladder";
  ladderView.hidden = true;
  el.append(tabs, bar, view, ladderBar, ladderView);
  // Expand: give the stage the whole window (App mode's side panel is narrow). Esc to return.
  const expand = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn ss-expand",
    textContent: "⤢ Expand", title: "Fill the window with the stage (Esc to return)" });
  expand.addEventListener("pointerdown", (e) => e.stopPropagation());
  const setFull = (on) => {
    el.classList.toggle("ss-full", on);
    expand.replaceChildren(icon(on ? "minimize-2" : "maximize-2", 14), on ? "Done" : "Expand");
    requestAnimationFrame(() => { stage.resize(); if (!ladderView.hidden) ladder.draw(); });
  };
  expand.addEventListener("click", () => setFull(!el.classList.contains("ss-full")));
  el.addEventListener("keydown", (e) => { if (e.key === "Escape" && el.classList.contains("ss-full")) { e.stopPropagation(); setFull(false); } });
  const mkTiny = (txt, title, fn) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: txt, title });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", fn);
    return b;
  };
  const undoBtn = mkTiny("↶", "Undo (Cmd/Ctrl+Z)", () => stage.undo());
  const redoBtn = mkTiny("↷", "Redo (Shift+Cmd/Ctrl+Z)", () => stage.redo());
  undoBtn.style.marginLeft = "auto";
  expand.style.marginLeft = "6px";
  tabs.append(undoBtn, redoBtn, expand);

  let sceneJSON = JSON.parse(JSON.stringify(DEFAULT_SCENE));
  const stage = new Stage(view, (s) => {
    sceneJSON = s;
    syncControls();
    try { drawKeys(); } catch { /* timeline not built yet */ }
    try { syncOutline(); } catch { /* not built yet */ }
    try { if (!lookView.hidden) look.refresh(); } catch { /* not built yet */ }
    rewindLadder(s);
  });
  node.ssStage = stage; // handle for the scene agent, scripts and tests

  // Editing the stage sends the ladder back to step 1, so the next Run shows the new previz video
  // (seconds) instead of re-rendering every rung. Debounced: a drag is one edit.
  let rewindT = null, lastScene = null, batchRendering = false, batchDepth = 0;
  function rewindLadder(scene) {
    if (batchRendering) { lastScene = JSON.stringify(scene || {}); return; }
    // Only a real edit counts: a Run re-renders the stage (capture) and may report an unchanged scene, and picking
    // another shot isn't an edit (it would reset the step mid-queue while that shot's passes upload).
    const key = JSON.stringify({ ...(scene || {}), active_shot: undefined });
    if (lastScene === null || key === lastScene) { lastScene = key; return; }
    lastScene = key;
    clearTimeout(rewindT);
    rewindT = setTimeout(() => {
      const stepNode = app.graph?._nodes?.find((n) => n.comfyClass === "SoundstageStep" || n.type === "SoundstageStep");
      const w = stepNode?.widgets?.find((x) => x.name === "step");
      if (w && w.value !== 1) { w.value = 1; w.callback?.(1); app.graph.setDirtyCanvas(true); }
    }, 300);
  }

  const ladder = new LadderViewer(ladderView, stage);
  const fid = slider("Fidelity", 0, RUNG_NAMES.length - 1, 0.01, 1, (v) => RUNG_NAMES[Math.round(v)], (v) => ladder.setFidelity(v));
  fid.input.style.width = "260px";
  ladder.onFidelity = (v) => { fid.input.value = v; fid.out.textContent = RUNG_NAMES[Math.round(v)]; };
  const blend = document.createElement("div");
  blend.className = "ss-views";
  for (const [m, label] of [["wipe", "Wipe"], ["fade", "Fade"]]) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    b.setAttribute("aria-pressed", String(m === "wipe"));
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => {
      blend.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      ladder.mode = m; ladder.draw();
    });
    blend.append(b);
  }
  const rungs = document.createElement("div");
  rungs.className = "ss-rungs";
  const rungSpans = RUNG_NAMES.map((n, i) => {
    const sp = document.createElement("span");
    sp.textContent = n;
    sp.dataset.ready = String(i <= 1);
    rungs.append(sp);
    return sp;
  });
  ladderBar.append(fid.wrap, blend);
  ladderView.append(rungs);
  const tabBtns = {};
  for (const [k, label] of [["stage", "Stage"], ["canvas", "Canvas"], ["advisor", "Advisor"], ["look", "Look"], ["ladder", "Ladder"], ["cut", "Cut"]]) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    b.setAttribute("aria-pressed", String(k === "stage"));
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => showView(k));
    tabBtns[k] = b;
    tabs.append(b);
  }
  // Look tab: camera body, lens character, palette, genre / movement / technique → compiled prompts.
  // The look lives on the SoundstageLook node's widget (not in the stage value) so look tweaks
  // re-run from rung 2, never re-render the stage.
  const lookView = Object.assign(document.createElement("div"), { className: "ss-lookview" });
  lookView.hidden = true;
  el.append(lookView);
  const look = new LookPanel(lookView, () => ({ ...stage.toJSON(), lighting_prompt: stage.lightingPrompt() }),
    { fetchApi: (path, init) => api.fetchApi(path, init),
      getFocal: () => stage._cameraAt(stage.frame || 0).focal_mm,
      setFocal: (mm, opts = {}) => {
        // A style's lens is a suggestion: in-car shots keep a wide lens. A lens you pick yourself is always applied.
        const use = opts.fromStyle && stage.styleFocal ? stage.styleFocal(mm) : mm;
        stage.setFocal(use);
        if (use !== mm) status.textContent = `Lens kept at ${use} mm: this camera rides in the vehicle (the style suggests ${mm} mm).`;
        try { syncControls(); } catch { /* not built yet */ }
      } });
  const lookNode = () => app.graph?._nodes?.find((n) => n.comfyClass === "SoundstageLook" || n.type === "SoundstageLook");
  const lookWidget = () => lookNode()?.widgets?.find((w) => w.name === "look");
  setTimeout(() => { try { const v = lookWidget()?.value; if (v) look.load(v); lastDesc = look.state.description; } catch {} }, 0);
  let lastDesc = null;
  look.onChange = (j) => {
    // A description is about the cast on stage when it was written; the Coach flags it once the cast changes.
    if (lastDesc !== null && j.description !== lastDesc) j.description_cast = j.description ? castSig(stage.toJSON()) : "";
    lastDesc = j.description;
    look.state.description_cast = j.description_cast || "";
    const w = lookWidget(); if (w) { w.value = JSON.stringify(j); app.graph.setDirtyCanvas(true); }
  };
  const setDescription = (text, stamp) => {
    look.state.description = text;
    look.state.description_cast = stamp ? castSig(stage.toJSON()) : "";
    lastDesc = text;
    look.refresh?.();
    const w = lookWidget(); if (w) { w.value = JSON.stringify(look.toJSON()); app.graph.setDirtyCanvas(true); }
  };

  // Cut tab: an optional editing timeline over the coverage, exporting to Avid / Premiere / Resolve.
  // Each shot's latest ladder renders are remembered per setup; the cut itself saves on the node.
  const shotRenders = {};
  // Render files per setup, saved on the node so the cut can be flattened after a reload: {setupId: {kind: fileRef}}.
  const RENDER_KIND = { 1: "previz", 2: "look", 3: "draft", 4: "final" };
  const viewURL = (f) => api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${f.type || "output"}`);
  // Also mirrored in localStorage the moment a render lands (ComfyUI writes its draft later, on its own schedule).
  const lsKey = () => `ss_renders:${app.extensionManager?.workflow?.activeWorkflow?.path || "wf"}:${node.id}`;
  const lsRenders = () => { try { return JSON.parse(localStorage.getItem(lsKey()) || "{}"); } catch { return {}; } };
  const savedRenders = () => {
    const mine = node.properties?.ss_renders && typeof node.properties.ss_renders === "object" ? node.properties.ss_renders : {};
    const ls = lsRenders();
    const out = { ...ls };
    for (const [sid, kinds] of Object.entries(mine)) out[sid] = { ...(ls[sid] || {}), ...kinds };
    return out;
  };
  // Saved renders are read lazily: ComfyUI applies node.properties after this widget is built.
  const rendersFor = (sid) => {
    const out = {};
    for (const [k, f] of Object.entries(savedRenders()[sid] || {})) if (f?.filename) out[k] = viewURL(f);
    const r = { ...out, ...(shotRenders[sid] || {}) };
    // Finals with sound are kept as final_sound / final_audio; the Cut editor, strip and Ladder read "final".
    const fin = r.final_sound || r.final_audio;
    if (fin) r.final = fin;
    return r;
  };
  const allRenders = () => {
    const ids = new Set([...Object.keys(savedRenders()), ...Object.keys(shotRenders)]);
    return Object.fromEntries([...ids].map((sid) => [sid, rendersFor(sid)]));
  };
  const rememberRender = (sid, kind, f) => {
    const all = { ...savedRenders() };
    all[sid] = { ...(all[sid] || {}), [kind]: { filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" } };
    node.properties = node.properties || {};
    node.properties.ss_renders = all;
    try { localStorage.setItem(lsKey(), JSON.stringify(all)); } catch { /* storage blocked */ }
    // A property write alone isn't seen by ComfyUI's change tracker: nudge it so the draft (and Save) keep it.
    try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch { /* older frontend */ }
  };
  // Which setup each queued prompt was for (a render can finish after you switch shots).
  const promptShot = {};
  if (!api.__ssQueueHooks) {
    api.__ssQueueHooks = [];
    const orig = api.queuePrompt.bind(api);
    api.queuePrompt = async (...args) => {
      const r = await orig(...args);
      for (const f of api.__ssQueueHooks) { try { f(r?.prompt_id); } catch { /* one listener never breaks the queue */ } }
      return r;
    };
  }
  let lastPid = null;
  // A node from a workflow you switched away from keeps its listeners: only the node on the live graph counts.
  const isLive = () => !!node.graph && app.graph?.getNodeById?.(node.id) === node;
  const onQueued = (pid) => { if (pid && isLive()) { promptShot[pid] = stage.activeShot().id; lastPid = pid; } };
  const rungListeners = [];
  api.__ssQueueHooks.push(onQueued);
  const cutView = Object.assign(document.createElement("div"), { className: "ss-cutview" });
  cutView.hidden = true;
  el.append(cutView);
  const buildCutProject = () => {
    const sc = stage.toJSON();
    return {
      name: node.title && node.title !== "Soundstage · 3D Stage" ? node.title : "Soundstage cut",
      fps: sc.shot?.fps || 24, width: stage.fw, height: stage.fh,
      shots: (sc.shots || [stage.activeShot()]).map((sh) => ({ id: sh.id, name: sh.name || sh.id, frames: sc.shot?.frames || 97,
        scene_name: "SC1", setup: sh.setup || "master", renders: rendersFor(sh.id) })),
    };
  };
  // One saved cut shared by the docked shot strip and the full Cut editor: {cut, audio, audio_tracks, excluded_shots}.
  const loadCut = () => readSaved(node.properties?.ss_cut);
  const saveCut = (v) => { node.properties = node.properties || {}; node.properties.ss_cut = v; };
  let strip = null; // created below; the Cut editor may report changes before then
  const cut = new CutPanel(cutView, {
    getProject: () => ({ ...buildCutProject(), ...loadCut() }),
    renderPreviewFrame: (shotId, frame) => {
      // Render that setup's camera without switching the stage UI to it.
      const prev = stage.state.active_shot;
      stage.state.active_shot = shotId;
      try { return stage.renderFrameTo("clay", frame); } finally { stage.state.active_shot = prev; }
    },
    onChange: (project) => {
      saveCut({ ...loadCut(), cut: project.cut, audio: project.audio, audio_tracks: project.audio_tracks });
      strip?.refresh();
    },
    onEditShot: (id, where) => editShot(id, where),
  });

  // The docked shot strip: always under the stage. Click a clip to edit that setup; + Shot adds one;
  // Advisor shots land here in order; "Editor" opens the full Cut view for audio, trims and NLE export.
  const stripHost = Object.assign(document.createElement("div"), { className: "ss-striphost" });
  view.after(stripHost);
  strip = new ShotStrip(stripHost, {
    stage, api, getRenders: () => allRenders(),
    onSelect: () => { if (view.hidden) showView("stage"); try { syncShots(); } catch { /* not built yet */ } },
    onStatus: (m) => (status.textContent = m),
    load: loadCut,
    save: (v) => { saveCut(v); if (!cutView.hidden) cut.refresh(); },
    onOpenEditor: () => showView("cut"),
    onEditShot: (id, where) => editShot(id, where),
    renderPreviewFrame: (id, f) => {
      const prev = stage.state.active_shot;
      stage.state.active_shot = id;
      try { return stage.renderFrameTo("clay", f); } finally { stage.state.active_shot = prev; }
    },
  });

  // "Edit original" from a clip (Dynamic Link style): open the step that made it, for that shot. Renders are kept
  // per shot and the cut always plays each shot's latest, so a re-render shows up in the cut by itself.
  function editShot(id, where) {
    if (id !== stage.activeShot().id) stage.setActiveShot(id);
    const name = shotName(id);
    if (where === "stage") { showView("stage"); status.textContent = `Editing ${name} on the stage. Re-render it in ③ Motion and the cut updates.`; return; }
    if (where === "canvas") {
      pipeline.selectShot(id);
      pipeline.ctx.openCanvas(pipeline.chosen[id]?.url || rendersFor(id).look || null);
      status.textContent = `Touching up ${name}'s frame. “Use my edited frame”, then re-render it in ③ Motion: the cut picks it up.`;
      return;
    }
    pipeline.go(where);
    pipeline.selectShot(id);
    status.textContent = `${name}: ${where === "frame" ? "pick or paint a new frame" : where === "motion" ? "re-render it here" : "compare its rungs"}; the cut uses whatever lands last.`;
  }

  // Cut → one video: join every clip of the cut (trimmed, in order, with its sound) into one MP4 on the server.
  // Each clip uses its best render (Final + sound › Final › Draft › Previz › Look still); a shot with none
  // becomes a black slate of the right length. "Render missing shots" queues a Final for each shot first.
  const cutBar = Object.assign(document.createElement("div"), { className: "ss-cutbar" });
  cutBar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0 2px";
  const cutBtn = (label, title) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: label, title });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    cutBar.append(b);
    return b;
  };
  const oneBtn = cutBtn("Cut → one video", "Join the whole cut into one video with sound: each clip trimmed and in order (best render per shot; a black slate where a shot has no render yet)");
  const renderAllBtn = cutBtn("Render missing shots", "Queue a Final for every shot in the cut that doesn't have one, then join the cut into one video");
  const cutOut = Object.assign(document.createElement("span"), { className: "ss-cutout" });
  cutOut.style.cssText = "font-size:12px;color:var(--ss-muted, #a9a3ad);display:flex;gap:8px;align-items:center;flex-wrap:wrap";
  cutBar.append(cutOut);
  stripHost.after(cutBar);
  const BEST = ["final_sound", "final_audio", "final", "draft", "previz", "look"];
  const cutEntries = () => (loadCut().cut || []).filter((e) => e && e.shot_id);
  const stepWidget = () => app.graph?._nodes?.find((n) => n.comfyClass === "SoundstageStep" || n.type === "SoundstageStep")
    ?.widgets?.find((x) => x.name === "step");
  const shotName = (id) => (stage.toJSON().shots || []).find((s) => s.id === id)?.name || id;

  async function flattenCut() {
    const entries = cutEntries();
    if (!entries.length) { cutOut.textContent = "The cut is empty: add shots to the strip first."; return; }
    const saved = savedRenders();
    const clips = entries.map((e) => {
      const r = saved[e.shot_id] || {};
      const kind = BEST.find((k) => r[k]);
      return { shot_id: e.shot_id, name: shotName(e.shot_id), in: e.in, out: e.out, file: kind ? r[kind] : null, kind: kind || null };
    });
    oneBtn.disabled = true;
    cutOut.textContent = `Joining ${clips.length} clips…`;
    try {
      const sc = stage.toJSON();
      const res = await api.fetchApi("/soundstage/cut/render_video", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: node.title && node.title !== "Soundstage · 3D Stage" ? node.title : "cut", fps: sc.shot?.fps || 24, clips }) });
      const j = await res.json().catch(() => ({ error: `server answered ${res.status}` }));
      if (!res.ok || j.error) throw new Error(j.error || `server answered ${res.status}`);
      const url = viewURL(j);
      const notFinal = clips.filter((c) => !/^final/.test(c.kind || "")).length;
      cutOut.textContent = "";
      const a = (label, extra) => Object.assign(document.createElement("a"), { href: url, textContent: label, ...extra });
      const watch = a("▶ Watch", { target: "_blank", rel: "noopener" });
      const dl = a("⬇ Download", { download: j.filename });
      for (const x of [watch, dl]) { x.style.color = "var(--ss-accent, #F2FF59)"; x.addEventListener("pointerdown", (e) => e.stopPropagation()); }
      cutOut.append(watch, dl, document.createTextNode(`${j.seconds}s · ${clips.length} clips` +
        (notFinal ? ` · ${notFinal} not Final yet (${j.missing?.length || 0} black slate${(j.missing?.length || 0) === 1 ? "" : "s"})` : "")));
      status.textContent = `The cut is one video now: ${j.filename}.`;
    } catch (err) {
      cutOut.textContent = `Couldn't join the cut: ${err.message}`;
    } finally {
      oneBtn.disabled = false;
    }
  }

  // Batch: switch to each shot without a Final, set the ladder to step 4 and queue it (the stage capture
  // happens at queue time, so each prompt carries its own shot). Join the cut when the last one finishes.
  let batch = null;
  api.addEventListener("execution_success", (ev) => batchDone(ev.detail?.prompt_id, true));
  api.addEventListener("execution_error", (ev) => batchDone(ev.detail?.prompt_id, false));
  api.addEventListener("execution_interrupted", (ev) => batchDone(ev.detail?.prompt_id, false));
  function batchDone(pid, ok) {
    if (!batch?.waiting.has(pid)) return;
    if (!ok) batch.failed.push(shotName(batch.waiting.get(pid)));
    batch.waiting.delete(pid);
    if (batch.waiting.size) { cutOut.textContent = `Rendering shots: ${batch.total - batch.waiting.size}/${batch.total} done…`; return; }
    const failed = batch.failed;
    batch = null;
    renderAllBtn.disabled = false;
    if (failed.length) status.textContent = `These shots didn't finish: ${failed.join(", ")}. Joining the cut with what there is.`;
    flattenCut();
  }
  async function renderMissing() {
    const saved = savedRenders();
    const todo = [...new Set(cutEntries().map((e) => e.shot_id))].filter((id) => !/final/.test(Object.keys(saved[id] || {}).join(" ")));
    if (!todo.length) { flattenCut(); return; }
    const stepW = stepWidget();
    const prevShot = stage.activeShot().id, prevStep = stepW?.value;
    const waiting = new Map();
    renderAllBtn.disabled = true;
    batchRendering = true;
    try {
      for (const [i, sid] of todo.entries()) {
        cutOut.textContent = `Queueing ${i + 1}/${todo.length}: ${shotName(sid)} (capturing the stage)…`;
        stage.setActiveShot(sid);
        if (stepW) stepW.value = 4;
        const before = new Set(Object.keys(promptShot));
        await app.queuePrompt(0, 1);
        const pid = Object.keys(promptShot).find((k) => !before.has(k));
        if (pid) waiting.set(pid, sid);
      }
    } catch (err) {
      status.textContent = `Stopped queueing: ${err.message}`;
    } finally {
      stage.setActiveShot(prevShot);
      batchRendering = false;
      if (stepW && prevStep != null) stepW.value = prevStep;
      app.graph?.setDirtyCanvas?.(true);
    }
    if (!waiting.size) { renderAllBtn.disabled = false; cutOut.textContent = "Nothing was queued."; return; }
    batch = { waiting, total: waiting.size, failed: [] };
    cutOut.textContent = `Rendering ${waiting.size} shot${waiting.size === 1 ? "" : "s"} (about 4–6 min each); the cut joins itself at the end.`;
  }
  oneBtn.addEventListener("click", () => flattenCut());
  renderAllBtn.addEventListener("click", () => renderMissing());

  // Advisor tab: describe the scene, get a shot list with the why, add the shots as camera setups.
  const advisorView = Object.assign(document.createElement("div"), { className: "ss-advisorview" });
  advisorView.hidden = true;
  el.append(advisorView);
  const advisor = new AdvisorPanel(advisorView, { api, stage, onStatus: (m) => (status.textContent = m),
    // Shots the Advisor adds go straight into the cut, in its order and at its durations.
    onShotsAdded: (ids, shots) => strip.appendShots(ids, { seconds: Object.fromEntries(ids.map((id, i) => [id, shots[i]?.seconds])) }) });

  // Canvas tab: paint, mask, magic-select and generate on the shot frame (UniCanvas-style; every model
  // call goes through ComfyUI's queue). Layers live in node properties so brush strokes never re-render rung 1.
  const canvasView = Object.assign(document.createElement("div"), { className: "ss-canvasview" });
  canvasView.hidden = true;
  el.append(canvasView);
  // Way back out of the canvas: back to the frame step, or use the edited image as the frame and go animate it.
  const canvasBack = document.createElement("div");
  canvasBack.className = "ss-canvasback";
  canvasBack.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px;padding:8px 10px;border-radius:12px;background:rgba(242,255,89,.06);border:1px solid rgba(242,255,89,.25)";
  const cbBtn = (label, title, fn, primary) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
    if (primary) b.className = "ss-primary";
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", fn);
    return b;
  };
  const cbTip = Object.assign(document.createElement("span"), { textContent: "Touch-up: paint, mask or regenerate parts of the frame. Your edits are kept here; use them as the frame when you're happy." });
  cbTip.style.cssText = "font-size:12px;color:var(--ss-muted,#a9a3ad);flex:1;min-width:200px";
  canvasBack.append(
    cbBtn("← Back to ② Frame", "Return to the frame step (your canvas edits are kept)", () => pipeline?.go("frame")),
    cbTip,
    cbBtn("✓ Use my edited frame → ③ Motion", "Animate the touched-up image instead of the generated one", () => {
      const sw = app.graph?.getNodeById?.(9086)?.widgets?.find((w) => w.name === "switch");
      if (sw) { sw.value = true; sw.callback?.(true); }
      try { pipeline.touched[stage.activeShot().id] = true; pipeline.ctx.saveChosen?.({ chosen: pipeline.chosen, touched: pipeline.touched }); } catch { /* pipeline not built */ }
      status.textContent = `Using your touched-up frame for ${stage.activeShot().name}. Render the motion when ready.`;
      pipeline?.go("motion");
    }, true));
  canvasView.prepend(canvasBack);
  const liftTo3D = async (blob, kind, info = {}) => {
    const name = info.name || `canvas_${kind}`;
    const file = new File([blob], `${name}.png`, { type: "image/png" });
    const url = (r) => api.apiURL(r.url);
    if (kind === "splat") {
      status.textContent = `Making a splat from ${name}…`;
      const r = await maker.photoToSplat(file, { proxy: true, onStatus: (m) => (status.textContent = m) });
      stage.addModel(name, url(r), "ply", { splat_up: "y", proxy_url: r.proxy ? url(r.proxy) : undefined });
    } else if (kind === "mesh") {
      status.textContent = `Building a mesh from ${name}…`;
      stage.addModel(name, url(await maker.photoToMesh(file, { kind: "object", onStatus: (m) => (status.textContent = m) })), "glb");
    } else {
      const ref = await maker.uploadImage(file, { api });
      const i = ref.lastIndexOf("/");
      stage.addCard(name, api.apiURL(`/view?filename=${encodeURIComponent(ref.slice(i + 1))}&subfolder=${encodeURIComponent(i > 0 ? ref.slice(0, i) : "")}&type=input`));
    }
    status.textContent = `${name} is on the stage. Drag it into place (G move, R rotate, T scale).`;
  };
  const canvasPanel = new CanvasPanel(canvasView, { api, app, stage, onStatus: (t) => { status.textContent = t; }, liftTo3D });
  canvasPanel.load(node.properties?.soundstage_canvas || null);
  canvasPanel.onChange = (json) => { node.properties = node.properties || {}; node.properties.soundstage_canvas = json; };

  function showView(k) {
    try { coach?.notify("tab", k); } catch { /* coach not built yet */ }
    try { pipeline?.onView(k); } catch { /* pipeline not built yet */ }
    Object.entries(tabBtns).forEach(([kk, b]) => b.setAttribute("aria-pressed", String(kk === k)));
    const isLadder = k === "ladder", isLook = k === "look", isStage = k === "stage";
    bar.hidden = !isStage; view.hidden = !isStage;
    ladderBar.hidden = !isLadder; ladderView.hidden = !isLadder;
    lookView.hidden = !isLook;
    cutView.hidden = k !== "cut";
    advisorView.hidden = k !== "advisor";
    if (k === "canvas" && canvasView.parentElement !== el) el.append(canvasView);   // back from the ② Frame editor
    if (canvasView.parentElement === el) canvasView.hidden = k !== "canvas";
    el.classList.toggle("ss-canvasmode", k === "canvas");
    if (k === "canvas") canvasPanel.refreshStage();
    el.classList.toggle("ss-advmode", k === "advisor");
    if (k === "advisor") advisor.refresh();
    el.classList.toggle("ss-cutmode", k === "cut"); // the timeline has its own transport; hide the stage rows
    el.classList.toggle("ss-pipemode", ["frame", "motion", "deliver"].includes(k)); // step screens stand alone
    if (k === "cut") { cut.refresh(); cut.resize(); } else cut.stop();
    if (isLadder) ladder.setFrame(stage.frame || 0);
    else if (isLook) look.refresh();
    else stage.resize();
  }
  // Step 5 writes the Layer Pack on the server; offer it as a download right in the tab bar.
  const packBtns = document.createElement("span");
  packBtns.hidden = true;
  tabs.append(packBtns);
  function offerLayerPack(folder) {
    const name = String(folder).split(/[\\/]/).filter(Boolean).pop();
    if (!name) return;
    const link = (label, lite, title) => Object.assign(document.createElement("a"), {
      textContent: label, title, className: "ss-btn",
      href: api.apiURL(`/soundstage/layerpack/download?name=${encodeURIComponent(name)}${lite ? "&lite=1" : ""}`),
      download: `${name}${lite ? "_lite" : ""}.zip`,
    });
    packBtns.replaceChildren(
      link("⬇ Layers", false, `Download the whole Layer Pack ${name} (layers, mattes, depth, camera, AE/Nuke/Blender/Resolve/PS builders)`),
      link("⬇ Lite", true, "Same pack without the per-frame PNG sequences (ProRes 4444 MOVs, EXRs, camera and builders kept)"));
    for (const a of packBtns.children) a.addEventListener("pointerdown", (e) => e.stopPropagation());
    packBtns.hidden = false;
    try { pipeline?.showPack([...packBtns.children].map((a) => { const c = a.cloneNode(true); c.addEventListener("pointerdown", (e) => e.stopPropagation()); return c; })); } catch { /* not built */ }
    status.textContent = `Layer Pack ${name} is ready: ⬇ Layers (everything) or ⬇ Lite (no PNG frame sequences), top right.`;
  }

  // Each Run that finishes a rung feeds the viewer (rung output nodes are titled "Rung N · …").
  api.addEventListener("executed", (ev) => {
    const d = ev.detail || {};
    const src = app.graph?.getNodeById?.(+d.node);
    if (/^Rung 5 · Layer Pack folder/.test(src?.title || "")) {
      const t = d.output?.text;
      const folder = Array.isArray(t) ? t.flat().find((x) => typeof x === "string") : t;
      if (folder) offerLayerPack(folder);
      return;
    }
    const m = /^Rung\s+(\d)/.exec(src?.title || "");
    const files = d.output?.images;
    if (!m || !files?.length) return;
    const rung = +m[1];
    if (!RENDER_KIND[rung]) return;
    const f = files[0];
    const url = api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || "")}&type=${f.type}&t=${Date.now()}`);
    // Only renders this node queued, on the live graph: never file another workflow's render under our shot.
    if (!isLive() || !promptShot[d.prompt_id]) return;
    const sid = promptShot[d.prompt_id];
    const title = src?.title || "";
    const kind = rung === 4 && /sound/i.test(title) ? "final_sound" : rung === 4 && /audio-driven/i.test(title) ? "final_audio" : RENDER_KIND[rung];
    if (f.type === "output") rememberRender(sid, kind, f);
    shotRenders[sid] = { ...shotRenders[sid], [kind]: url };
    for (const fn of rungListeners) { try { fn({ rung, kind, url, file: f, promptId: d.prompt_id, shotId: sid }); } catch { /* listener */ } }
    if (rung === 1) return;
    if (sid === stage.activeShot().id) ladder.setSource(rung, d.output?.animated?.[0] ? "video" : "image", url);
    if (!cutView.hidden) cut.refresh();
    rungSpans[rung].dataset.ready = "true";
    ladder.setFidelity(rung);
    ladder.onFidelity(rung);
  });

  const lens = slider("Lens", 14, 135, 1, sceneJSON.camera.focal_mm, (v) => `${v}mm`, (v) => stage.setFocal(v));
  const sunAz = slider("Sun", 0, 359, 1, sceneJSON.sun.azimuth_deg, (v) => `${v}°`, (v) => {
    stage.setSun(v, stage.toJSON().sun.elevation_deg); try { syncLight(); } catch {} });
  const sunEl = slider("Height", -20, 85, 1, sceneJSON.sun.elevation_deg, (v) => `${v}°`, (v) => {
    stage.setSun(stage.toJSON().sun.azimuth_deg, v); try { syncLight(); } catch {} });

  const views = document.createElement("div");
  views.className = "ss-views";
  for (const [mode, label] of [["wire", "Wire"], ["clay", "Clay"], ["color", "Color"], ["depth", "Depth"]]) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
    b.setAttribute("aria-pressed", String(mode === "clay"));
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => {
      views.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      stage.setView(mode);
    });
    views.append(b);
  }
  // Shot cam (what renders) vs Free view (fly the whole set; shot camera drawn as a frustum).
  const camMode = document.createElement("div");
  camMode.className = "ss-views";
  camMode.style.marginLeft = "0";
  const camBtns = {};
  for (const [k, label, tip] of [["shot", "Shot cam", "Frame the shot (this camera renders)"],
                                 ["free", "Free view", "Fly around the set without moving the shot camera (key: 0)"]]) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title: tip });
    b.setAttribute("aria-pressed", String(k === "shot"));
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => stage.setFreeView(k === "free"));
    camBtns[k] = b;
    camMode.append(b);
  }
  const badge = Object.assign(document.createElement("div"), { className: "ss-viewbadge", textContent: "Shot cam" });
  const gizmo = Object.assign(document.createElement("canvas"), { className: "ss-gizmo", width: 168, height: 168,
    title: "Click an axis to look along it" });
  view.append(badge, gizmo);
  stage.onView = (free) => {
    camBtns.shot.setAttribute("aria-pressed", String(!free));
    camBtns.free.setAttribute("aria-pressed", String(free));
    badge.textContent = free ? "Free view · shot camera shown" : `Shot cam · ${stage.activeShot().name}`;
    badge.dataset.free = String(free);
  };
  // Navigation compass (like Blender's axis gizmo): follows the viewport camera every render.
  const AXES = [["x", [1, 0, 0], "#e5534b"], ["y", [0, 1, 0], "#57ab5a"], ["z", [0, 0, 1], "#539bf5"]];
  let gizmoDots = [];
  stage.onRendered = (cam) => {
    const ctx = gizmo.getContext("2d");
    const R = 58, C = 84;
    ctx.clearRect(0, 0, 168, 168);
    ctx.fillStyle = "rgba(10,12,16,0.45)";
    ctx.beginPath(); ctx.arc(C, C, 80, 0, Math.PI * 2); ctx.fill();
    const inv = cam.quaternion.clone().invert();
    const dots = [];
    for (const [name, v, col] of AXES) {
      for (const sign of [1, -1]) {
        const d = new THREE.Vector3(...v).multiplyScalar(sign).applyQuaternion(inv);
        dots.push({ axis: (sign > 0 ? "+" : "-") + name, x: C + d.x * R, y: C - d.y * R, z: d.z, col, pos: sign > 0, name });
      }
    }
    dots.sort((a, b) => a.z - b.z);
    for (const d of dots) {
      if (d.pos) { ctx.strokeStyle = d.col; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(C, C); ctx.lineTo(d.x, d.y); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(d.x, d.y, d.pos ? 15 : 11, 0, Math.PI * 2);
      ctx.fillStyle = d.pos ? d.col : "rgba(20,22,26,0.9)"; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = d.col; ctx.stroke();
      if (d.pos) { ctx.fillStyle = "#0d1117"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(d.name.toUpperCase(), d.x, d.y + 1); }
    }
    gizmoDots = dots;
  };
  gizmo.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const r = gizmo.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 168, y = ((e.clientY - r.top) / r.height) * 168;
    const hit = [...gizmoDots].reverse().find((d) => Math.hypot(d.x - x, d.y - y) < 18);
    if (hit) stage.snapView(hit.axis);
  });
  stage.render();

  const lensPick = lensCards((mm) => { stage.setFocal(mm); lens.input.value = mm; lens.out.textContent = `${mm}mm`; lensPick.set(mm); });
  lensPick.set(sceneJSON.camera.focal_mm);
  lens.input.addEventListener("input", () => lensPick.set(+lens.input.value));
  const dome = sunDome((az, elv) => {
    stage.setSun(az, elv);
    sunAz.input.value = az; sunAz.out.textContent = `${az}°`;
    sunEl.input.value = elv; sunEl.out.textContent = `${elv}°`;
    try { syncLight(); } catch {}
  });
  const syncDome = () => { const s = stage.toJSON(); dome.set(s.sun.azimuth_deg, s.sun.elevation_deg, s.lighting?.north_deg || 0); };
  syncDome();
  sunAz.input.addEventListener("input", syncDome);
  sunEl.input.addEventListener("input", syncDome);
  bar.append(camMode, lens.wrap, lensPick.el, sunAz.wrap, sunEl.wrap, dome.el, views);

  // Timeline: which key you are editing, scrub, play, shot length.
  const time = document.createElement("div");
  time.className = "ss-bar ss-time";
  // Keyframes: any number of camera / object keys. Editing at the playhead auto-keys.
  const keys = document.createElement("div");
  keys.className = "ss-views";
  keys.style.marginLeft = "0";
  const keyBtns = {};
  const kb = (id, label, title, fn) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => { fn(); afterTimeChange(); });
    keyBtns[id] = b;
    keys.append(b);
  };
  kb("first", "|◀", "First key", () => stage.setKey("start"));
  kb("prev", "◀", "Previous key", () => stage.gotoKey(-1));
  kb("set", "◆ Key", "Set a key here for the camera (and the selected object)", () => stage.setKeyHere());
  kb("del", "✕", "Delete the key here", () => stage.deleteKeyHere());
  kb("next", "▶", "Next key", () => stage.gotoKey(1));
  kb("last", "▶|", "Last key", () => stage.setKey("end"));
  // Per-object tracks under the time bar (open by default; remembered per viewer).
  let tracks = null;
  const tracksHost = document.createElement("div");
  let tracksOpen = true;
  try { tracksOpen = localStorage.getItem("ss_tracks_open") !== "0"; } catch { /* storage blocked */ }
  const tracksBtn = Object.assign(document.createElement("button"), { type: "button", textContent: "Tracks",
    title: "Show a row per object: drag keys to retime, double-click to add, right-click to delete" });
  tracksBtn.setAttribute("aria-pressed", String(tracksOpen));
  tracksBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  tracksBtn.addEventListener("click", () => {
    tracksOpen = !tracksOpen;
    tracksBtn.setAttribute("aria-pressed", String(tracksOpen));
    if (tracks) tracks.hidden = !tracksOpen;
    try { localStorage.setItem("ss_tracks_open", tracksOpen ? "1" : "0"); } catch { /* storage blocked */ }
  });
  keys.append(tracksBtn);
  const scrub = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 96, step: 1, value: 0 });
  scrub.setAttribute("aria-label", "Scrub the shot");
  scrub.addEventListener("pointerdown", (e) => e.stopPropagation());
  const tc = document.createElement("output");
  const fmtTc = (f) => {
    const fps = stage.toJSON().shot.fps;
    return `${String(Math.floor(f / fps)).padStart(2, "0")}:${String(f % fps).padStart(2, "0")}`;
  };
  scrub.addEventListener("input", () => {
    stage.setFrame(+scrub.value);
    if (!ladderView.hidden) ladder.setFrame(+scrub.value);
    tc.textContent = fmtTc(+scrub.value);
    drawKeys();
  });
  const play = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Play" });
  play.addEventListener("pointerdown", (e) => e.stopPropagation());
  let playing = null;
  play.addEventListener("click", () => {
    if (playing) { cancelAnimationFrame(playing); playing = null; play.textContent = "Play"; return; }
    const { frames, fps } = stage.toJSON().shot;
    const t0 = performance.now();
    play.textContent = "Stop";
    const tick = (now) => {
      const f = Math.floor(((now - t0) / 1000) * fps);
      if (f >= frames) { playing = null; play.textContent = "Play"; return; }
      scrub.value = f; tc.textContent = fmtTc(f); stage.setFrame(f);
      if (!ladderView.hidden) ladder.setFrame(f);
      playing = requestAnimationFrame(tick);
    };
    playing = requestAnimationFrame(tick);
  });
  const dur = slider("Length", 2, 10, 1, 4, (v) => `${v}s`, (v) => {
    const s = stage.toJSON();
    stage.state.shot.frames = 8 * Math.round((v * s.shot.fps) / 8) + 1; // LTX wants 8k+1 frames
    scrub.max = stage.state.shot.frames - 1;
    stage.onChange(stage.toJSON());
  });
  const scrubCol = document.createElement("div");
  scrubCol.style.cssText = "flex:1;display:flex;flex-direction:column;gap:2px;min-width:120px";
  const keyStrip = Object.assign(document.createElement("canvas"), { height: 28 });
  keyStrip.style.cssText = "width:100%;height:14px";
  scrubCol.append(keyStrip, scrub);
  scrub.style.width = "100%";
  function drawKeys() {
    const info = stage.keyInfo();
    const w = (keyStrip.width = Math.max(200, Math.round(keyStrip.clientWidth * 2) || 600));
    const ctx = keyStrip.getContext("2d");
    ctx.clearRect(0, 0, w, 28);
    const x = (f) => 8 + (f / Math.max(1, info.last)) * (w - 16);
    const diamond = (f, y, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x(f), y - 7); ctx.lineTo(x(f) + 7, y);
      ctx.lineTo(x(f), y + 7); ctx.lineTo(x(f) - 7, y); ctx.closePath(); ctx.fill(); };
    for (const f of info.camera) diamond(f, 9, "#e39a40");
    for (const f of info.object) diamond(f, 21, "#539bf5");
    ctx.fillStyle = "#e6e9ee";
    ctx.fillRect(x(stage.frame || 0) - 1, 0, 2, 28);
    keyBtns.del.disabled = !info.camera.includes(stage.frame) && !info.object.includes(stage.frame);
    tracks?.draw();
  }
  function afterTimeChange() {
    scrub.value = stage.frame;
    tc.textContent = fmtTc(stage.frame);
    if (!ladderView.hidden) ladder.setFrame(stage.frame);
    syncControls();
    drawKeys();
  }
  time.append(keys, play, scrubCol, tc, dur.wrap);
  tracks = new TrackSheet(tracksHost, stage, {
    onFrame: (f) => { scrub.value = f; tc.textContent = fmtTc(f); if (!ladderView.hidden) ladder.setFrame(f); syncControls(); drawKeys(); },
    onKeysChanged: () => drawKeys(),
  });
  tracks.hidden = !tracksOpen;
  requestAnimationFrame(() => drawKeys());

  // Add objects by name, then select / rotate / delete them.
  const addRow = document.createElement("div");
  addRow.className = "ss-bar ss-add";
  const addInput = Object.assign(document.createElement("input"), { type: "text",
    placeholder: "Add anything: dog, man on a horse, food truck…" });
  addInput.setAttribute("aria-label", "Add an object by name");
  const addBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Add" });
  for (const x of [addInput, addBtn]) {
    x.addEventListener("pointerdown", (e) => e.stopPropagation());
    x.addEventListener("keydown", (e) => e.stopPropagation()); // keep ComfyUI shortcuts out of the text box
  }
  const doAdd = async () => {
    const text = addInput.value.trim();
    if (!text) return;
    if (ROOM_TEXT.test(text) && DIMS.test(text)) {
      addInput.value = "";
      status.textContent = `Laying out "${text}"…`;
      try {
        const spec = (await readPlan({ text })) || quickSpec(text);
        if (spec) { buildInteriorFrom(spec); return; }
      } catch (err) { status.textContent = `Couldn't lay out the room: ${err.message}`; return; }
    }
    const label = stage.addObject(text);
    if (label) {
      status.textContent = `Added ${label}. Drag it to place; use Start/End to give it a move.`;
      addInput.value = "";
      return;
    }
    // Not in the library: let the local LLM design a stand-in (cached after the first time).
    addInput.value = "";
    addBtn.disabled = true;
    try {
      const recipe = await designObject(text, (msg) => (status.textContent = msg));
      const added = stage.addCustom(text, recipe);
      status.textContent = `Added ${added} (${recipe.parts.length} parts, ${recipe.size_m.map((v) => v.toFixed(1)).join(" × ")} m). Drag it to place.`;
    } catch (err) {
      status.textContent = `Couldn't design “${text}”: ${err.message}`;
    } finally {
      addBtn.disabled = false;
    }
  };
  addBtn.addEventListener("click", doAdd);
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });

  const sel = document.createElement("div");
  sel.className = "ss-sel";
  sel.hidden = true;
  const selName = Object.assign(document.createElement("span"), { className: "ss-chip" });
  const turn = slider("Turn", -180, 180, 5, 0, (v) => `${v}°`, (v) => stage.rotateSelected(v));
  const del = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Delete" });
  del.addEventListener("pointerdown", (e) => e.stopPropagation());
  del.addEventListener("click", () => stage.removeSelected());
  const scl = slider("Scale", 0.1, 5, 0.05, 1, (v) => `${(+v).toFixed(2)}×`, (v) => stage.scaleSelected(v));
  const dup = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Duplicate",
    title: "Duplicate (Cmd/Ctrl+D)" });
  dup.addEventListener("pointerdown", (e) => e.stopPropagation());
  dup.addEventListener("click", () => { const n = stage.duplicateSelected(); if (n) status.textContent = `Added ${n}.`; syncOutline(); });
  // Gizmo mode (also G / R / T over the viewport).
  const gizmoSeg = Object.assign(document.createElement("div"), { className: "ss-views", title: "Gizmo: G move · R rotate · T scale" });
  const gizmoBtns = {};
  for (const [mode, label, ic] of [["translate", "Move", "move-3d"], ["rotate", "Rotate", "rotate-ccw"], ["scale", "Scale", "maximize-2"]]) {
    const b = Object.assign(document.createElement("button"), { type: "button", title: `${label} (${{ translate: "G", rotate: "R", scale: "T" }[mode]})` });
    b.append(icon(ic, 13), label);
    b.dataset.ssIcon = ic;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => stage.setGizmoMode(mode));
    gizmoBtns[mode] = b;
    gizmoSeg.append(b);
  }
  const mkToggle = (label, ic, title, get, set) => {
    const b = Object.assign(document.createElement("button"), { type: "button", title });
    b.append(icon(ic, 13), label);
    b.dataset.ssIcon = ic;
    const sync = () => b.setAttribute("aria-pressed", String(!!get()));
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", () => { set(!get()); sync(); });
    sync();
    return b;
  };
  const measureSeg = Object.assign(document.createElement("div"), { className: "ss-views" });
  measureSeg.append(
    mkToggle("Measure", "sliders-horizontal", "Show W×D×H of the selection, a 1.75 m person for scale, and the floor grid",
      () => stage.measure !== false, (v) => stage.setMeasure(v)),
    mkToggle("Snap", "grid-3x3", "Snap the gizmo: 0.1 m moves, 15° turns", () => !!stage.snap, (v) => stage.setSnap(v)));
  stage.onGizmoMode = (m) => { for (const [k, b] of Object.entries(gizmoBtns)) b.setAttribute("aria-pressed", String(k === m)); };
  stage.onGizmoMode(stage.gizmoMode || "translate");
  sel.append(selName, gizmoSeg, measureSeg, turn.wrap, scl.wrap, dup, del);
  const outlineWrap = document.createElement("label");
  const outlineSelEl = document.createElement("select");
  outlineSelEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  outlineSelEl.addEventListener("change", () => {
    const [type, id] = outlineSelEl.value.split("|");
    if (type === "light") stage.selectLight(id); else stage.select(id);
  });
  outlineWrap.append("Outliner", outlineSelEl);
  const outlineSel = { wrap: outlineWrap, sel: outlineSelEl };
  function syncOutline() {
    const items = stage.outline();
    const cur = outlineSelEl.value;
    outlineSelEl.replaceChildren(new Option(`— ${items.length} items —`, ""),
      ...items.map((it) => new Option(`${it.type === "light" ? "💡 " : ""}${it.name}`, `${it.type}|${it.id}`)));
    outlineSelEl.value = cur;
  }
  // Bring your own models (GLB/glTF, FBX incl. Mixamo, OBJ, PLY, STL; animation kept) and Gaussian splats
  // (.ply/.spz/.splat/.ksplat/.sog), and export the whole set as GLB.
  const fileIn = Object.assign(document.createElement("input"), { type: "file", accept: IMPORT_ACCEPT, hidden: true });
  const importBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Import 3D…",
    title: "Add your own 3D: GLB/glTF, FBX (Mixamo animations play on the timeline), OBJ, PLY, STL, or a Gaussian splat (.ply .spz .splat .ksplat .sog). Splats show in Color view; a clay stand-in drives the passes." });
  importBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  importBtn.addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    status.textContent = `Uploading ${f.name}…`;
    try {
      const body = new FormData();
      body.append("image", f, f.name);
      body.append("type", "input");
      body.append("subfolder", "soundstage_models");
      body.append("overwrite", "true");
      const r = await api.fetchApi("/upload/image", { method: "POST", body });
      if (r.status !== 200) throw new Error(`upload failed (${r.status})`);
      const j = await r.json();
      const url = api.apiURL(`/view?filename=${encodeURIComponent(j.name)}&subfolder=${encodeURIComponent(j.subfolder || "")}&type=input`);
      const fmt = formatOf(f.name);
      const name = stage.addModel(f.name.replace(/\.[a-z0-9]+$/i, ""), url, fmt);
      status.textContent = `Added ${name}. Drag it to place; Scale to resize.` +
        (["spz", "splat", "ksplat", "sog", "ply"].includes(fmt) ? " Splats show in Color view." : "");
    } catch (err) {
      status.textContent = `Couldn't import ${f.name}: ${err.message}`;
    } finally {
      fileIn.value = "";
    }
  });
  const exportBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Export GLB",
    title: "Download the whole set as a .glb (Blender, Unreal, Unity, C4D…)" });
  exportBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  exportBtn.addEventListener("click", async () => {
    try {
      const blob = await stage.exportGLB();
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `soundstage_${stage.activeShot().name.replace(/\W+/g, "_")}.glb` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      status.textContent = "Exported the set as GLB.";
    } catch (err) {
      status.textContent = `GLB export failed: ${err.message}`;
    }
  });
  // Floor plans and dimensioned room text → a true-scale interior (Higgsfield 3D Jutsu's best idea).
  async function readPlan(body) {
    try {
      const r = await api.fetchApi("/soundstage/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 404 || r.status === 405) return null;
      let j = null;
      try { j = JSON.parse(await r.text()); } catch { return null; } // not our route (yet): use the built-in layout
      if (r.status >= 400) throw new Error(j.error || `plan reader failed (${r.status})`);
      return j?.rooms?.length ? j : null;
    } catch (err) {
      if (/Failed to fetch|404/.test(String(err))) return null;
      throw err;
    }
  }
  function buildInteriorFrom(spec) {
    const out = stage.setInterior(spec);
    syncEnv();
    const rooms = out.rooms.map((r) => `${r.name} ${r.w}×${r.d} m`).join(", ");
    const warn = (spec.warnings || []).length ? ` Note: ${spec.warnings.join(" ")}` : "";
    status.textContent = `Built ${out.rooms.length} room${out.rooms.length > 1 ? "s" : ""} at true scale (${rooms}; ceiling ${out.ceiling_m} m). Free view shows it as a cutaway.${warn}`;
  }
  const ROOM_TEXT = /\b(room|rooms|studio|apartment|flat|bedroom|bathroom|kitchen|office|ldk|\dldk|hall|garage|loft|house|interior)\b/i;
  const DIMS = /\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*m\b/i;

  // Make 3D from a photo (on the pod, no downloads): a Gaussian splat (TripoSplat, with its own clay
  // mesh for the passes), a solid textured mesh, or a whole location rebuilt as the set (DA3) with
  // the photo's camera. Results land in input/soundstage/ and appear on the stage like any import.
  maker.useApi(api);
  const photoIn = Object.assign(document.createElement("input"), { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  const photoSel = mkSelect("Import image", {
    "": { label: "Import an image as…" },
    floorplan: { label: "Floor plan → true-scale interior (walls, doors, furniture)" },
    backdrop: { label: "Backdrop plate (behind everything)" },
    cutout: { label: "Cut-out card (removes the background, ~7 s)" },
    card: { label: "Card as-is (keeps the image's own alpha)" },
    set: { label: "Location photo → the whole 3D set (~5 s)" },
    video: { label: "Video clip → set + camera move (Video → Stage, ~1 min)" },
    splat: { label: "Object → Gaussian splat (detailed, ~15 s)" },
    mesh: { label: "Object → solid 3D mesh (~12 s)" },
    clear: { label: "Remove the backdrop plate" },
  }, "", (v) => {
    if (v === "clear") { stage.setBackdrop(null); status.textContent = "Backdrop removed."; }
    else if (v === "video") videoIn.click();
    else if (v) { photoIn.dataset.kind = v; photoIn.click(); }
    photoSel.sel.value = "";
  });
  // Video → Stage (Magnific "3D Scenes from video"): the clip becomes an editable layout — real-size subjects
  // with start/end marks, primitive set pieces, and the source camera move as keys you can drag in Top view.
  const videoIn = Object.assign(document.createElement("input"), { type: "file", accept: "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.mkv", hidden: true });
  videoIn.addEventListener("change", async () => {
    const f = videoIn.files?.[0];
    videoIn.value = "";
    if (!f) return;
    const say = (m) => (status.textContent = m);
    photoSel.sel.disabled = true;
    try {
      say(`Uploading ${f.name}…`);
      const body = new FormData();
      body.append("image", f, f.name);
      body.append("type", "input"); // the input root, so Soundstage · Footage lists it as the reference plate
      const up = await api.fetchApi("/upload/image", { method: "POST", body });
      if (up.status !== 200) throw new Error(`upload failed (${up.status})`);
      const video = (await up.json()).name;
      const r = await api.fetchApi("/soundstage/video2stage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404 || r.status === 405) throw new Error("Video → Stage isn't installed on this server yet (restart ComfyUI)");
      if (r.status >= 400 || !j.job) throw new Error(j.error || `start failed (${r.status})`);
      let res = null;
      for (let t = 0; t < 1200 && !res; t++) {
        await new Promise((ok) => setTimeout(ok, 1500));
        const s = await (await api.fetchApi(`/soundstage/video2stage/job?id=${j.job}`)).json();
        if (s.state === "error") throw new Error(s.error);
        if (s.state === "done") res = s.result;
        else say(`Video → Stage: ${s.step || "queued"}… ${Math.round((s.progress || 0) * 100)}%`);
      }
      if (!res) throw new Error("timed out");
      const scene = res.scene;
      for (const a of scene.actors || []) if (a.kind === "glb" && a.url?.startsWith("/view")) a.url = api.apiURL(a.url);
      if (scene.reference?.samples?.[0]) {
        const s0 = scene.reference.samples[0];
        scene.backdrop = { url: api.apiURL(`/view?filename=${encodeURIComponent(s0.filename)}&subfolder=${encodeURIComponent(s0.subfolder)}&type=input`) };
      }
      loadScene(stage, scene);
      try { syncEnv(); syncLight(); syncShots(); } catch { /* rows not built yet */ }
      const m = res.summary || {};
      say(`Rebuilt ${f.name}: ${m.objects || 0} subjects (${m.movers || 0} moving), ${m.set_pieces || 0} set pieces, ` +
        `the camera move as ${m.camera_keys || 0} keys over ${m.frames} frames. Drag the keys in Top view to re-shoot it. ` +
        `The clip is in the input folder as ${video} for Soundstage · Footage / Recast.` +
        (res.notes?.length ? ` Notes: ${res.notes.slice(0, 4).join("; ")}.` : ""));
    } catch (err) {
      say(`Couldn't rebuild ${f.name}: ${err.message}`);
    } finally {
      photoSel.sel.disabled = false;
    }
  });
  photoIn.addEventListener("change", async () => {
    const f = photoIn.files?.[0], kind = photoIn.dataset.kind;
    photoIn.value = "";
    if (!f || !kind) return;
    const name = f.name.replace(/\.[a-z0-9]+$/i, "");
    const say = (m) => (status.textContent = m);
    photoSel.sel.disabled = true;
    try {
      if (kind === "floorplan") {
        say(`Reading the floor plan ${f.name}…`);
        const ref = await maker.uploadImage(f, { api });
        const spec = await readPlan({ image: ref });
        if (!spec) throw new Error("the plan reader isn't installed on this server yet; type the rooms instead, e.g. \"bedroom 4x3.5 m\"");
        buildInteriorFrom(spec);
      } else if (kind === "backdrop" || kind === "card") {
        const ref = await maker.uploadImage(f, { api });
        const [sub, file] = ref.includes("/") ? [ref.slice(0, ref.lastIndexOf("/")), ref.slice(ref.lastIndexOf("/") + 1)] : ["", ref];
        const url = api.apiURL(`/view?filename=${encodeURIComponent(file)}&subfolder=${encodeURIComponent(sub)}&type=input`);
        if (kind === "backdrop") {
          stage.setBackdrop(url);
          if ((stage.toJSON().environment || {}).set !== "empty") { stage.setEnvironment({ set: "empty" }); syncEnv(); } // the photo is the world
          say(`${f.name} is the backdrop plate: it shows in Color view and behind the clay while you block. Place actors in it; the depth/clay passes stay clean.`);
        } else {
          stage.addCard(name, url);
          say(`Added ${name} as a card. Drag to place, Turn to face the camera, Scale to size.`);
        }
      } else if (kind === "cutout") {
        say(`Cutting ${f.name} out of its background…`);
        const r = await maker.photoToCutout(f, { onStatus: say });
        stage.addCard(name, api.apiURL(r.url));
        say(`Added ${name} as a cut-out card (${Math.round(r.seconds || 0)} s). Its silhouette drives the clay and depth passes.`);
      } else if (kind === "splat") {
        say(`Making a splat from ${f.name}… (first run loads the models, ~2–3 min)`);
        const r = await maker.photoToSplat(f, { proxy: true, onStatus: say });
        stage.addModel(name, api.apiURL(r.url), "ply", { splat_up: "y", proxy_url: r.proxy ? api.apiURL(r.proxy.url) : undefined });
        say(`Added ${name} as a splat (${(r.count || 0).toLocaleString()} gaussians, ${Math.round(r.seconds || 0)} s). It shows in Color view; Scale to size.`);
      } else if (kind === "mesh") {
        say(`Building a mesh from ${f.name}…`);
        const r = await maker.photoToMesh(f, { kind: "object", onStatus: say });
        stage.addModel(name, api.apiURL(r.url), "glb");
        say(`Added ${name} (${Math.round(r.seconds || 0)} s). Drag to place; Scale to size.`);
      } else {
        say(`Rebuilding the location from ${f.name}…`);
        const r = await maker.photoToMesh(f, { kind: "set", decimation: 2, onStatus: say });
        stage.setEnvironment({ set: "empty" });
        stage.addModel(`${name} (set)`, api.apiURL(r.url), "glb", { set_xform: r.to_stage });
        if (r.camera) stage.setCameraKeys([{ frame: 0, ...r.camera }]);
        syncEnv();
        say(`The set is now ${f.name}, seen from the photo's camera${r.fov_deg ? ` (${Math.round(r.fov_deg.h)}° wide)` : ""}. Add actors and move the camera.`);
      }
    } catch (err) {
      say(`Couldn't make 3D from ${f.name}: ${err.message}`);
    } finally {
      photoSel.sel.disabled = false;
    }
  });
  addRow.append(addInput, addBtn, importBtn, fileIn, photoSel.wrap, photoIn, videoIn, exportBtn, outlineWrap, sel);
  // Appearance (people: build, hair, wardrobe, colours; objects: colour) + ride/sit on another object.
  const apRow = document.createElement("div");
  apRow.className = "ss-bar";
  apRow.hidden = true;
  const colorInput = (label, key) => {
    const wrap = document.createElement("label");
    const inp = Object.assign(document.createElement("input"), { type: "color" });
    inp.style.cssText = "width:28px;height:20px;border:none;background:none;padding:0";
    inp.addEventListener("pointerdown", (e) => e.stopPropagation());
    inp.addEventListener("change", () => stage.setAppearance({ [key]: inp.value }));
    wrap.append(label, inp);
    return { wrap, inp, key };
  };
  const opt = (arr) => Object.fromEntries(arr.map((v) => [v, { label: v }]));
  const apBuild = mkSelect("Build", opt(APPEARANCE_OPTIONS.build), "average", (v) => stage.setAppearance({ build: v }));
  const apHair = mkSelect("Hair", opt(APPEARANCE_OPTIONS.hair), "short", (v) => stage.setAppearance({ hair: v }));
  const apTop = mkSelect("Top", opt(APPEARANCE_OPTIONS.top), "jacket", (v) => stage.setAppearance({ top: v }));
  const apBottom = mkSelect("Bottom", opt(APPEARANCE_OPTIONS.bottom), "jeans", (v) => stage.setAppearance({ bottom: v }));
  const apSkin = mkSelect("Skin", Object.fromEntries(SKIN_TONES.map((c, i) => [c, { label: `tone ${i + 1}` }])), SKIN_TONES[2],
    (v) => stage.setAppearance({ skin: v }));
  const cHair = colorInput("Hair", "hair_color"), cTop = colorInput("Top", "top_color"), cBottom = colorInput("Bottom", "bottom_color");
  const cMain = colorInput("Colour", "color");
  const rideSel = mkSelect("Ride / sit on", { "": { label: "—" } }, "", (v) => {
    const id = stage.selectedInfo()?.id;
    if (!id) return;
    if (v === "__off") stage.unmount(id); else if (v) stage.mount(id, v);
  });
  // Timed mount: on foot until the playhead frame, then they hop on and ride with it.
  // Vehicles: the shot camera can ride along (keys in the car's own space), with in-car framings.
  const followOpts = { "": { label: "—" }, all: { label: "＋ All interior shots (one per angle)" }, ride: { label: "Ride along (keep framing)" },
    ...Object.fromEntries(Object.entries(CAR_SHOTS).map(([k, v]) => [k, { label: v.label }])), off: { label: "Stop riding along" } };
  const followSel = mkSelect("In-car camera", followOpts, "", (v) => {
    const sel = stage.selectedInfo();
    if (!sel || !v) return;
    if (v === "off") { stage.setCameraFollow(null); status.textContent = "The shot camera is back in the world."; }
    else if (v === "all") {
      const names = stage.addInteriorShots(sel.id);
      status.textContent = names.length
        ? `Added ${names.length} interior shots riding with ${sel.name}: ${names.join(", ")}. They're in the cut; render them all in ③ Motion.`
        : "Pick a car (or another vehicle) first.";
      try { syncShots(); } catch { /* not built yet */ }
    }
    else {
      stage.setCameraFollow(sel.id, v === "ride" ? null : v);
      status.textContent = `The shot camera rides with ${sel.name}${v === "ride" ? "" : ": " + CAR_SHOTS[v].label}. Move the car and the world goes by outside.`;
    }
    followSel.sel.value = "";
  });
  const seatSel = mkSelect("Seat", { "0": { label: "Driver" } }, "0", (v) => {
    const sel = stage.selectedInfo();
    if (sel) stage.setSeat(sel.id, +v);
    status.textContent = `Seat: ${seatSel.sel.selectedOptions[0]?.textContent || v}.`;
  });
  const beamSel = mkSelect("Beam", { steady: { label: "On (steady)" }, flicker: { label: "Flicker" }, blink: { label: "Blink on/off" }, off: { label: "Off" } }, "steady", (v) => {
    const sel = stage.selectedInfo();
    if (sel) stage.setBeam(sel.id, v);
    status.textContent = `Flashlight: ${beamSel.sel.selectedOptions[0]?.textContent || v}. Drag it onto someone to hand it to them.`;
  });
  const hopBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn",
    title: "Stay on foot until the playhead, then hop on (move the playhead to frame 0 and press again to ride from the start)" });
  hopBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  hopBtn.addEventListener("click", () => {
    const info = stage.selectedInfo();
    if (!info?.mount_id) return;
    stage.mount(info.id, info.mount_id, info.pose, stage.frame);
    syncAppearance(stage.selectedInfo());
    status.textContent = stage.frame > 0 ? `${info.name} hops on at frame ${stage.frame}. Give them a walk to the mount before that.` : `${info.name} rides from the start.`;
  });
  const personCtl = [apBuild.wrap, apHair.wrap, cHair.wrap, apTop.wrap, cTop.wrap, apBottom.wrap, cBottom.wrap, apSkin.wrap, rideSel.wrap, seatSel.wrap, hopBtn];
  apRow.append(...personCtl, cMain.wrap, followSel.wrap, beamSel.wrap);
  const isPerson = (k) => k === "man" || k === "woman" || k === "child";
  function syncAppearance(info) {
    apRow.hidden = !info || info.kind === "glb" || info.kind === "custom" || info.kind === "card";
    if (apRow.hidden) return;
    const person = isPerson(info.kind);
    for (const w of personCtl) w.hidden = !person;
    cMain.wrap.hidden = person;
    const ap = { ...(DEFAULT_APPEARANCE[info.kind] || {}), ...(info.appearance || {}) };
    if (person) {
      apBuild.sel.value = ap.build; apHair.sel.value = ap.hair; apTop.sel.value = ap.top; apBottom.sel.value = ap.bottom;
      apSkin.sel.value = SKIN_TONES.includes(ap.skin) ? ap.skin : SKIN_TONES[2];
      cHair.inp.value = ap.hair_color; cTop.inp.value = ap.top_color; cBottom.inp.value = ap.bottom_color;
      const hosts = stage.toJSON().actors.filter((a) => a.id !== info.id && (MOUNTS[a.kind] || !isPerson(a.kind)));
      rideSel.sel.replaceChildren(new Option("—", ""), ...(info.mount_id ? [new Option("Get off / stand", "__off")] : []),
        ...hosts.map((a) => new Option(a.name, a.id)));
      rideSel.sel.value = info.mount_id || "";
      hopBtn.hidden = !info.mount_id;
      const hostKind = stage.toJSON().actors.find((a) => a.id === info.mount_id)?.kind;
      const seats = SEATS[hostKind];
      seatSel.wrap.hidden = !seats;
      if (seats) {
        seatSel.sel.replaceChildren(...seats.map((s, i) => new Option(s.name, String(i))));
        seatSel.sel.value = String(info.seat ?? 0);
      }
      const at = stage.toJSON().actors.find((a) => a.id === info.id)?.mount_at;
      hopBtn.textContent = at ? `Hops on at ${at} · set to playhead` : "Hop on at playhead";
    } else {
      cMain.inp.value = ap.color || (OBJECT_COLORS[info.kind] || ["#9a9a9a"])[0];
    }
    beamSel.wrap.hidden = info.kind !== "flashlight";
    if (info.kind === "flashlight") beamSel.sel.value = info.beam || "steady";
    followSel.wrap.hidden = !["car", "police_car", "sports_car", "hatchback", "truck", "bus", "horse", "motorcycle", "bicycle", "boat"].includes(info.kind);
  }

  stage.onInteract = (msg) => { status.textContent = msg; try { syncAppearance(stage.selectedInfo()); } catch { /* not built */ } };
  stage.onSelect = (info) => {
    tracks?.draw();
    sel.hidden = !info;
    syncAppearance(info);
    if (!info) return;
    selName.textContent = info.name;
    turn.input.value = info.rotation_deg; turn.out.textContent = `${info.rotation_deg}°`;
    scl.input.value = info.scale || 1; scl.out.textContent = `${(+(info.scale || 1)).toFixed(2)}×`;
    try { syncOutline(); outlineSel.sel.value = `object|${info.id}`; } catch {}
  };

  function mkSelect(label, options, value, onPick) {
    const wrap = document.createElement("label");
    const sel = document.createElement("select");
    for (const [k, v] of Object.entries(options)) sel.append(new Option(v.label, k, false, k === value));
    sel.addEventListener("pointerdown", (e) => e.stopPropagation());
    sel.addEventListener("change", () => onPick(sel.value));
    wrap.append(label, sel);
    return { wrap, sel };
  }

  // Coverage: several camera setups on the same set and action.
  const shotRow = document.createElement("div");
  shotRow.className = "ss-bar";
  const shotWrap = document.createElement("label");
  const shotSel = document.createElement("select");
  shotSel.addEventListener("pointerdown", (e) => e.stopPropagation());
  shotSel.addEventListener("change", () => { stage.setActiveShot(shotSel.value); afterTimeChange(); });
  shotWrap.append("Shot", shotSel);
  const SETUPS = { master: { label: "Master" }, wide: { label: "Wide" }, two_shot: { label: "Two-shot" },
    ots_a: { label: "Over-the-shoulder A" }, ots_b: { label: "Over-the-shoulder B" }, single_a: { label: "Single A" },
    single_b: { label: "Single B" }, insert: { label: "Insert" }, pov: { label: "POV" } };
  const newSetup = mkSelect("New setup", { "": { label: "—" }, ...SETUPS }, "", (v) => {
    if (!v) return;
    const name = stage.addShot(v);
    newSetup.sel.value = "";
    status.textContent = `New camera setup “${name}” starts from this view. Frame it, key a move, Run to render it.`;
    afterTimeChange();
  });
  const delShot = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Delete setup" });
  delShot.addEventListener("pointerdown", (e) => e.stopPropagation());
  delShot.addEventListener("click", () => { stage.removeShot(); afterTimeChange(); });
  const aspectSel = mkSelect("Aspect", ASPECTS, stage.toJSON().shot?.aspect || "1.85", (v) => {
    stage.setAspect(v);
    try { ladder.draw(); } catch {}
  });
  shotRow.append(shotWrap, newSetup.wrap, delShot, aspectSel.wrap);
  function syncShots() {
    const st = stage.toJSON();
    const shots = st.shots || [];
    shotSel.replaceChildren(...shots.map((x) => new Option(x.name, x.id, false, x.id === st.active_shot)));
    delShot.disabled = shots.length < 2;
    badge.textContent = stage.freeView ? "Free view · shot camera shown" : `Shot cam · ${stage.activeShot().name}`;
  }
  stage.onShots = () => { syncShots(); try { pipeline?.restoreLadder(); } catch { /* not built */ } };

  // Sound stage: set / environment, weather & elements, water tank level.
  const envRow = document.createElement("div");
  envRow.className = "ss-bar";
  const env0 = stage.toJSON().environment || {};
  const setSel = mkSelect("Set", SETS, env0.set || "plaza", (v) => { stage.setEnvironment({ set: v }); syncEnv(); });
  const wxSel = mkSelect("Elements", WEATHER, env0.weather || "none", (v) => stage.setEnvironment({ weather: v }));
  const dens = slider("Amount", 0, 1, 0.05, env0.density ?? 0.5, (v) => `${Math.round(v * 100)}%`, (v) => {
    clearTimeout(dens._t); dens._t = setTimeout(() => stage.setEnvironment({ density: v }), 120);
  });
  const waterLv = slider("Water", 0, 4, 0.1, env0.water_level ?? 2.5, (v) => `${v.toFixed(1)} m`, (v) => {
    clearTimeout(waterLv._t); waterLv._t = setTimeout(() => stage.setEnvironment({ water_level: v }), 120);
  });
  envRow.append(setSel.wrap, wxSel.wrap, dens.wrap, waterLv.wrap);
  function syncEnv() {
    const e = stage.toJSON().environment || {};
    setSel.sel.value = e.set || "plaza";
    wxSel.sel.value = e.weather || "none";
    waterLv.wrap.hidden = e.set !== "water_tank";
  }
  syncEnv();

  // Lighting: solar-accurate time of day + placeable film lights (key, fill, rim, practical, spot, neon).
  const lightRow = document.createElement("div");
  lightRow.className = "ss-bar";
  const L0 = stage.toJSON().lighting || {};
  const presetSel = mkSelect("Light", { "": { label: "Manual sun" }, ...TIME_PRESETS }, L0.preset || "", (v) => {
    if (v) stage.applyTimePreset(v); else stage.setSun(stage.toJSON().sun.azimuth_deg, stage.toJSON().sun.elevation_deg);
    syncLight();
  });
  const tod = slider("Time", 4, 22, 0.05, L0.hour ?? 17.6, (v) => clock(v), (v) => {
    presetSel.sel.value = "";
    stage.setTimeOfDay(v);
    syncLight();
  });
  const north = slider("North", 0, 359, 1, L0.north_deg ?? 0, (v) => `${v}°`, (v) => { stage.setNorth(v); syncLight(); });
  const addLightSel = mkSelect("Add light", { "": { label: "—" }, ...LIGHT_TYPES }, "", (v) => {
    if (!v) return;
    const name = stage.addLight(v);
    addLightSel.sel.value = "";
    status.textContent = `Added ${name}. Drag its glowing handle to move it.`;
    syncLight();
  });
  const three = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Auto 3-point",
    title: "Key, fill and rim around the selected actor, placed relative to the camera" });
  three.addEventListener("pointerdown", (e) => e.stopPropagation());
  three.addEventListener("click", () => { stage.autoThreePoint(); syncLight(); });
  // Lighting setups from cinematography practice (Rembrandt, book light, low-key noir…): real lights placed around
  // the subject relative to the camera, and the setup's words go into the prompt.
  const setupSel = mkSelect("Light it like…", { "": { label: "—" } }, "", (v) => {
    const s = (lightSetups || []).find((x) => x.id === v);
    if (!s) return;
    const n = stage.applyLightingSetup(s);
    syncLight();
    status.textContent = `${s.label}: ${n} lights placed around the subject (${s.ratio || ""} ratio). ${s.summary || ""}`;
  });
  let lightSetups = [];
  fetch(new URL("./look/lighting_setups.json", import.meta.url), { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null)).then((d) => {
      lightSetups = (d && (d.setups || d)) || [];
      if (!Array.isArray(lightSetups)) lightSetups = [];
      setupSel.sel.replaceChildren(new Option("—", ""), ...lightSetups.map((s) => {
        const o = new Option(s.label, s.id);
        o.title = `${s.summary || ""}${s.ratio ? ` · ${s.ratio}` : ""}`;
        return o;
      }));
    }).catch(() => {});
  lightRow.append(presetSel.wrap, tod.wrap, north.wrap, addLightSel.wrap, three, setupSel.wrap);

  // Selected light controls.
  const lightSel = document.createElement("div");
  lightSel.className = "ss-sel";
  lightSel.hidden = true;
  const lightName = Object.assign(document.createElement("span"), { className: "ss-chip" });
  const kel = slider("K", 1800, 12000, 100, 4300, (v) => `${v}K`, (v) => { clearTimeout(kel._t); kel._t = setTimeout(() => stage.updateLight({ kelvin: v }), 80); });
  const inten = slider("Power", 0.1, 10, 0.1, 3, (v) => v.toFixed(1), (v) => { clearTimeout(inten._t); inten._t = setTimeout(() => stage.updateLight({ intensity: v }), 80); });
  const lheight = slider("Height", 0.3, 8, 0.1, 2.5, (v) => `${v.toFixed(1)} m`, (v) => { clearTimeout(lheight._t); lheight._t = setTimeout(() => stage.updateLight({ height: v }), 80); });
  const soft = slider("Soft", 0, 1, 0.05, 0.5, (v) => `${Math.round(v * 100)}%`, (v) => { clearTimeout(soft._t); soft._t = setTimeout(() => stage.updateLight({ softness: v }), 80); });
  const ldel = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Delete light" });
  ldel.addEventListener("pointerdown", (e) => e.stopPropagation());
  ldel.addEventListener("click", () => { stage.removeLight(); syncLight(); });
  lightSel.append(lightName, kel.wrap, inten.wrap, lheight.wrap, soft.wrap, ldel);
  stage.onSelectLight = (l) => {
    lightSel.hidden = !l;
    if (!l) return;
    lightName.textContent = l.name;
    const set = (sl, v, f) => { sl.input.value = v; sl.out.textContent = f(v); };
    set(kel, l.kelvin, (v) => `${v}K`); set(inten, l.intensity, (v) => (+v).toFixed(1));
    set(lheight, l.position[1], (v) => `${(+v).toFixed(1)} m`); set(soft, l.softness, (v) => `${Math.round(v * 100)}%`);
  };
  const lightNote = Object.assign(document.createElement("div"), { className: "ss-lightnote" });
  function syncLight() {
    const L = stage.toJSON().lighting || {};
    const sun = stage.toJSON().sun;
    presetSel.sel.value = L.preset || "";
    if (L.mode === "time") { tod.input.value = L.hour; tod.out.textContent = clock(L.hour); }
    north.input.value = L.north_deg ?? 0; north.out.textContent = `${L.north_deg ?? 0}°`;
    sunAz.input.value = sun.azimuth_deg; sunAz.out.textContent = `${sun.azimuth_deg}°`;
    sunEl.input.value = sun.elevation_deg; sunEl.out.textContent = `${sun.elevation_deg}°`;
    lightNote.textContent = `Lighting note for the prompt: ${stage.lightingPrompt()}`;
  }
  syncLight();
  syncShots();
  syncOutline();

  // Virtual camera: a phone / Quest / Vision Pro at /soundstage/vcam drives the shot camera; takes are stabilized.
  const vcamRow = document.createElement("div");
  vcamRow.className = "ss-bar";
  const vcamBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "VCam: off",
    title: "Listen to a device running /soundstage/vcam (phone, iPad, Quest, Vision Pro)" });
  const vcamInfo = Object.assign(document.createElement("span"), { className: "ss-hint", textContent: "Open /soundstage/vcam on the device" });
  const takeSel = mkSelect("Take", { "": { label: "—" } }, "", () => {});
  const strength = slider("Steady", 0, 1, 0.05, 0.6, (v) => `${Math.round(v * 100)}%`, () => {});
  const applyTake = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Use take" });
  const snapBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", hidden: true });
  for (const b of [vcamBtn, applyTake, snapBtn]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
  vcamRow.append(vcamBtn, vcamInfo, takeSel.wrap, strength.wrap, applyTake, snapBtn);
  let vcamOff = null, lastRig = null;
  const live = new LiveVcam();
  const refreshTakes = async (selectId) => {
    try {
      const takes = await listTakes(api);
      takeSel.sel.replaceChildren(new Option("—", ""), ...takes.map((t) => new Option(t.name || t.id, t.id)));
      if (selectId) takeSel.sel.value = selectId;
    } catch { /* routes not loaded */ }
  };
  const useTake = async (rigKeys) => {
    const id = takeSel.sel.value;
    if (!id && !rigKeys) return;
    if (rigKeys) { stage.setCameraKeys(rigKeys); status.textContent = `Snapped to ${lastRig?.kind || "rig move"}.`; afterTimeChange(); return; }
    const take = await fetchTake(api, id);
    const res = takeToCamera(take, { anchor: anchorFromCamera(stage._cameraAt(0)), fps: stage.toJSON().shot.fps,
      overrides: { strength: +strength.input.value } });
    stage.setCameraKeys(res.keys);
    lastRig = res.rig;
    snapBtn.hidden = !res.rig;
    if (res.rig) snapBtn.textContent = `Snap to ${res.rig.kind}?`;
    status.textContent = `Camera now follows take ${id}, stabilized ${Math.round(+strength.input.value * 100)}% (${res.keys.length} keys).`;
    afterTimeChange();
  };
  applyTake.addEventListener("click", () => useTake());
  snapBtn.addEventListener("click", () => lastRig && useTake(lastRig.snapped.keys));
  vcamBtn.addEventListener("click", () => {
    if (vcamOff) {
      vcamOff(); vcamOff = null;
      stage.previewCamera(null);
      vcamBtn.textContent = "VCam: off";
      vcamInfo.textContent = "Open /soundstage/vcam on the device";
      return;
    }
    vcamBtn.textContent = "VCam: on";
    vcamInfo.textContent = "Waiting for the device…";
    refreshTakes();
    vcamOff = listenVcam(api, {
      onPose: (p) => { stage.previewCamera(live.update(p, anchorFromCamera(stage._cameraAt(stage.frame)))); vcamInfo.textContent = "Live"; },
      onState: (m) => { if (m.event === "record") { live.zero(); vcamInfo.textContent = "Recording…"; } },
      onTake: async (t) => { await refreshTakes(t.id); vcamInfo.textContent = "Take received"; stage.previewCamera(null); await useTake(); },
    });
  });

  // Scene agent: describe a whole scene in words, then tweak it by chat ("move the camera lower").
  const agent = new SceneAgent({ api, stage, onStatus: (m) => (status.textContent = m),
    onLoad: () => { try { syncEnv(); syncLight(); syncShots(); } catch { /* rows not built yet */ } } });
  const agentRow = document.createElement("div");
  agentRow.className = "ss-bar ss-add";
  const describeInput = Object.assign(document.createElement("input"), { type: "text",
    placeholder: "Describe your scene: two cops question a cowboy on a horse outside a diner at magic hour…" });
  describeInput.setAttribute("aria-label", "Describe the scene");
  const describeBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn", textContent: "Build scene" });
  const chatInput = Object.assign(document.createElement("input"), { type: "text",
    placeholder: "Change it: \"move the camera lower\", \"add rain\"… (Enter)" });
  chatInput.setAttribute("aria-label", "Edit the scene by chat");
  for (const x of [describeInput, describeBtn, chatInput]) {
    x.addEventListener("pointerdown", (e) => e.stopPropagation());
    x.addEventListener("keydown", (e) => e.stopPropagation());
  }
  const runAgent = async (fn) => {
    describeBtn.disabled = true;
    try { await fn(); } catch (e) { status.textContent = `Scene agent: ${e.message || e}`; }
    finally { describeBtn.disabled = false; }
  };
  describeBtn.addEventListener("click", () => describeInput.value.trim() && runAgent(() => agent.describe(describeInput.value.trim())));
  describeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") describeBtn.click(); });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !chatInput.value.trim()) return;
    const cmd = chatInput.value.trim();
    chatInput.value = "";
    runAgent(() => agent.edit(cmd));
  });
  agentRow.append(describeInput, describeBtn, chatInput);

  const status = document.createElement("div");
  status.className = "ss-status";
  const hint = document.createElement("div");
  hint.className = "ss-hint";
  hint.textContent = "Move the playhead, then frame the shot or drag objects: a ◆ key is set there automatically · Drag to orbit (all the way round) · Shift/middle-drag to pan · scroll to dolly · W A S D fly, Q/E down/up (Shift = fast) · 0 toggles Free view · drag an object to place it";
  el.append(agentRow, time, tracksHost, shotRow, envRow, lightRow, lightSel, lightNote, addRow, apRow, vcamRow, hint, status);

  function selectKey(k) {
    stage.setKey(k);
    afterTimeChange();
  }

  function syncControls() {
    const s = stage.toJSON();
    const cam = stage._cameraAt(stage.frame || 0);
    lens.input.value = cam.focal_mm; lens.out.textContent = `${Math.round(cam.focal_mm)}mm`;
    try { lensPick.set(cam.focal_mm); syncDome(); } catch { /* not built yet */ }
    if (scrub) {
      scrub.max = s.shot.frames - 1;
      dur.input.value = Math.round(s.shot.frames / s.shot.fps); dur.out.textContent = `${dur.input.value}s`;
    }
    sunAz.input.value = s.sun.azimuth_deg; sunAz.out.textContent = `${s.sun.azimuth_deg}°`;
    sunEl.input.value = s.sun.elevation_deg; sunEl.out.textContent = `${s.sun.elevation_deg}°`;
    // Scene loads (scene agent, undo, workflow load) can change the set and lighting too.
    try { syncEnv(); } catch { /* row not built yet */ }
    try { syncLight(); } catch { /* row not built yet */ }
  }

  const widget = node.addDOMWidget(inputName, "SOUNDSTAGE_STAGE", el, {
    getValue: () => JSON.stringify(stage.toJSON()),
    setValue: (v) => {
      try {
        const parsed = typeof v === "string" && v ? JSON.parse(v) : v;
        const scene = parsed?.scene ?? parsed;
        if (scene?.camera) {
          stage.load(scene);
          stage.resetHistory();   // opening a workflow: Undo starts here, never back to the default scene
          sceneJSON = stage.toJSON();
          syncControls();
          syncEnv?.();
          syncShots?.();
          try { aspectSel.sel.value = stage.toJSON().shot?.aspect || "1.85"; } catch {}
        }
      } catch (err) {
        console.warn("Soundstage: could not restore stage", err);
      }
    },
    getMinHeight: () => 720,
    hideOnZoom: false,
  });

  // At queue time: render the passes from the shot camera and send scene + file refs.
  // Same scene -> same file names -> same prompt value, so ComfyUI's cache skips every
  // rung that is already computed. Only a changed scene re-renders and re-uploads.
  let lastCapture = null;
  widget.serializeValue = async () => {
    const sceneStr = JSON.stringify(stage.toJSON());
    const stamp = hashString(sceneStr);
    // Reuse the last capture only while the server still has it (a ComfyUI restart empties temp/).
    if (lastCapture?.stamp === stamp && await passOnServer(`stage_clay_${stamp}.jpg`)) return lastCapture.value;
    const passes = {};
    const uploads = [];
    // Same layout captureSequence uses, so a pass already on the server can be reused without re-rendering.
    const frames = Math.max(1, stage.toJSON().shot?.frames || 97);
    const cols = Math.min(frames, Math.floor(16000 / stage.fw));
    passes.grid = { cols, rows: Math.ceil(frames / cols), frames, tile: [stage.fw, stage.fh] };
    for (const mode of ["clay", "depth", "id", "color"]) {
      const ext = mode === "depth" || mode === "id" ? "png" : "jpg";
      const name = `stage_${mode}_${stamp}.${ext}`;
      const have = await passOnServer(name);
      if (have) { passes[mode] = have; continue; }
      const seq = await stage.captureSequence(mode, (p) => {
        status.textContent = `Rendering ${mode} ${Math.round(p * 100)}%`;
      });
      passes.grid = { cols: seq.cols, rows: seq.rows, frames: seq.frames, tile: seq.tile };
      // Upload while the next pass renders (the tunnel to the pod is the slow part).
      uploads.push(uploadPass(seq.blob, name).then((ref) => { passes[mode] = ref; }));
    }
    if (uploads.length) status.textContent = "Uploading the stage passes…";
    await Promise.all(uploads);
    status.textContent = "";
    const value = JSON.stringify({ scene: { ...JSON.parse(sceneStr), camera_track: stage.cameraTrack(),
      lighting_prompt: stage.lightingPrompt(), id_colors: stage.idColors(),
      shot_id: stage.activeShot().id, shot_name: stage.activeShot().name }, passes });
    lastCapture = { stamp, value };
    return value;
  };

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    try { canvasPanel.dispose(); } catch { /* already gone */ }
    for (const x of [camViz, pip, topView, coach, tracks]) { try { x?.dispose?.(); } catch { /* already gone */ } }
    stage.dispose();
    return onRemoved?.apply(this, arguments);
  };
  // Camera path you can see (spline, numbered keys, lens frustum), a picture-in-picture shot-camera
  // preview while flying in Free view, and a top view where camera keys are dragged around.
  const syncFrame = (f) => { scrub.value = f; tc.textContent = fmtTc(f); drawKeys(); if (!ladderView.hidden) ladder.setFrame(f); };
  const camViz = new CameraViz(stage);
  const pip = new PipViewer(view, stage, { onFrame: syncFrame });
  const topView = new TopView(view, stage, { onFrame: syncFrame, onKeysChanged: () => drawKeys() });
  const topBtn = Object.assign(document.createElement("button"), { type: "button", textContent: "Top",
    title: "Top view: drag camera keys, re-aim, add or delete keys on the path" });
  topBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  topBtn.addEventListener("click", () => { topView.toggle(); topBtn.setAttribute("aria-pressed", String(!topView.el.hidden)); });
  camMode.append(topBtn);

  // Coach: contextual tips with one-click fixes (story order, camera through a wall, 180° line, stale renders…).
  let canvasFrom = null; // the frame last brought into the Canvas from ② Frame
  // The guided pipeline: ① Set → ② Frame → ③ Motion → ④ Review → ⑤ Deliver, with a Next button on every step.
  var pipeline = new Pipeline(el, {
    app, api, stage, look, ladder,
    showView: (k) => showView(k),
    getRenders: (sid) => rendersFor(sid),
    rememberRender: (sid, kind, f) => { if (f?.filename) { rememberRender(sid, kind, f); shotRenders[sid] = { ...shotRenders[sid], [kind]: viewURL(f) }; } },
    onRung: (fn) => rungListeners.push(fn),
    lastPromptId: () => lastPid,
    setDescription: (text) => setDescription(text, true),
    openCanvas: (url) => {
      showView("canvas");
      // Bring the chosen frame in as the top layer (once per frame), so the touch-up starts from it, not the clay.
      if (url && url !== canvasFrom) {
        canvasFrom = url;
        canvasPanel.importImage(url, "Your chosen frame").catch?.(() => {});
        status.textContent = "Your chosen frame is the top layer. Paint, mask or regenerate, then “Use my edited frame”.";
      }
    },
    // ② Frame's inline editor: the Canvas panel mounted inside the frame step, loaded with the chosen frame.
    mountCanvas: (host, url) => {
      host.append(canvasView);
      canvasView.hidden = false;
      canvasBack.hidden = true;
      try { canvasPanel.refreshStage(); } catch { /* stage not ready */ }
      if (url && url !== canvasFrom) { canvasFrom = url; canvasPanel.importImage(url, "Your chosen frame").catch?.(() => {}); }
    },
    unmountCanvas: () => { canvasView.hidden = true; canvasBack.hidden = false; el.append(canvasView); },
    flattenCut: () => flattenCut(),
    renderMissing: () => renderMissing(),
    // Every step works on every shot: the scene's shots in cut order (shots not in the cut follow).
    shots: () => {
      const all = stage.toJSON().shots || [stage.activeShot()];
      const order = cutEntries().map((e) => e.shot_id);
      const at = (id) => { const i = order.indexOf(id); return i < 0 ? 1e6 : i; };
      return [...all].sort((a, b) => at(a.id) - at(b.id) || all.indexOf(a) - all.indexOf(b));
    },
    // Nested holds (a batch over shots, each queue inside it) count up and down; the ladder is free at zero.
    setBatch: (on) => { batchDepth = Math.max(0, batchDepth + (on ? 1 : -1)); batchRendering = batchDepth > 0; },
    renderPreviewFrame: (id, f) => {
      const prev = stage.state.active_shot;
      stage.state.active_shot = id;
      try { return stage.renderFrameTo("clay", f); } finally { stage.state.active_shot = prev; }
    },
    loadChosen: () => {
      try { return node.properties?.ss_chosen || JSON.parse(localStorage.getItem(`${lsKey()}:chosen`) || "{}"); } catch { return {}; }
    },
    saveChosen: (v) => {
      node.properties = node.properties || {};
      node.properties.ss_chosen = v;
      try { localStorage.setItem(`${lsKey()}:chosen`, JSON.stringify(v)); } catch { /* storage blocked */ }
      try { app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); } catch { /* older frontend */ }
    },
    mountReview: (row) => ladderView.prepend(row),
  });
  for (const v of Object.values(pipeline.views)) el.append(v);
  node.ssPipeline = pipeline;
  node.ssLadder = ladder;
  for (const ms of [500, 2500]) setTimeout(() => { try { pipeline.restoreLadder(); } catch { /* ladder not ready */ } }, ms);

  const coach = new Coach(view, {
    stage, app, api,
    getCut: () => ({ ...buildCutProject(), ...loadCut() }),
    onAction: (kind, payload = {}) => {
      if (kind === "open_tab") { showView(payload.tab); return true; }
      if (kind === "describe") { showView("stage"); describeInput.focus(); return true; }
      if (kind === "clear_description") { setDescription("", false); return true; }
      if (kind === "keep_description") { setDescription(look.state.description, true); return true; }
      if (kind === "reorder_cut" || kind === "trim_shot") {
        const saved = loadCut();
        const cutList = [...(saved.cut || [])];
        if (kind === "reorder_cut") {
          const rank = new Map(payload.order.map((id, i) => [id, i]));
          cutList.sort((a, b) => (rank.get(a.shot_id) ?? 1e9) - (rank.get(b.shot_id) ?? 1e9));
        } else {
          const e = cutList.find((c) => c.shot_id === payload.shot_id);
          if (e) e.out = Math.max(e.in + 1, Math.round(payload.out));
        }
        saveCut({ ...saved, cut: cutList });
        strip?.refresh();
        if (!cutView.hidden) cut.refresh();
        return true;
      }
      return false; // set_step / set_freedom: the Coach falls back to the graph widgets
    },
  });

  decorate(el);
  // App title at the left of the tab bar, like the hub apps' panel headers.
  const brand = Object.assign(document.createElement("span"), { className: "ss-brand" });
  brand.append(icon("clapperboard", 15), "Soundstage");
  tabs.prepend(brand);
  return { widget };
}

// Lucide icons for the stage's buttons, matched by label, so every panel gets the same icon language
// as Comfy's hub apps without touching each button's definition.
const BUTTON_ICONS = {
  "Stage": "box", "Canvas": "wand-sparkles", "Advisor": "compass", "Look": "palette", "Ladder": "layers", "Cut": "scissors",
  "⤢ Expand": "maximize-2", "↶": "undo-2", "↷": "redo-2",
  "Build scene": "sparkles", "Add": "plus", "Import 3D…": "upload", "Export GLB": "download", "Play": "play",
  "Delete": "trash-2", "Duplicate": "copy", "Delete setup": "trash-2", "Auto 3-point": "lightbulb",
  "Wire": "grid-3x3", "Clay": "box", "Color": "palette", "Depth": "layers",
  "Shot cam": "camera", "Free view": "move-3d", "Wipe": "sliders-horizontal", "Fade": "eye",
};
const PRIMARY = new Set(["Build scene"]);
function decorate(root) {
  for (const b of root.querySelectorAll("button")) {
    if (b.dataset.ssIcon) continue;
    const label = b.textContent.trim();
    const name = BUTTON_ICONS[label];
    if (!name) continue;
    b.dataset.ssIcon = name;
    const bare = label === "↶" || label === "↷" || label === "⤢ Expand";
    b.replaceChildren(icon(name, 14), ...(bare ? (label === "⤢ Expand" ? ["Expand"] : []) : [label]));
    if (bare && label !== "⤢ Expand") b.setAttribute("aria-label", b.title || label);
    if (PRIMARY.has(label)) b.classList.add("ss-primary");
  }
}

app.registerExtension({
  name: "soundstage.stage",
  getCustomWidgets() {
    return {
      SOUNDSTAGE_STAGE(node, inputName) {
        return createStageWidget(node, inputName);
      },
    };
  },
});
