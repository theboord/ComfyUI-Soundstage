// The guided pipeline: ① Script → ② Cast & Locations → ③ Set → ④ Frame → ⑤ Motion → ⑥ Review → ⑦ Deliver.
// A step bar over the stage, plus three new views (Frame, Motion, Deliver) that drive the App graph's own widgets
// (the step gate, the look-still sampler, the model pickers, Quality) so the user never touches raw switches.
// Every view ends with one "Next →" button. Renders come back per shot and land on the Ladder (⑥ Review).
import { icon } from "../ui/icons.mjs";
import { setTouchupStill } from "../touchup/touchup.mjs";
import { castPool, shotSelection, pickRefs, refLines, refLabel, shotKind, refViewParams, REF_LIMIT } from "../cast/shotcast.mjs";

const STEPS = [
  { k: "script", n: 1, label: "Script", view: "script", hint: "Bring in your screenplay: scenes, breakdown, director's notes. Optional." },
  { k: "cast", n: 2, label: "Cast & Locations", view: "cast", hint: "Characters, props and locations with reference pictures, so every shot matches." },
  { k: "set", n: 3, label: "Set", view: "stage", hint: "Block the scene in 3D clay: cast, camera, timing." },
  { k: "frame", n: 4, label: "Frame", view: "frame", hint: "Paint the first frame from your clay with an image model." },
  { k: "motion", n: 5, label: "Motion", view: "motion", hint: "Animate it with LTX, following your blocking." },
  { k: "review", n: 6, label: "Review", view: "ladder", hint: "Scrub clay → frame → draft → final on the Ladder." },
  { k: "deliver", n: 7, label: "Deliver", view: "deliver", hint: "Layers for VFX, the cut as one video, NLE export." },
];
const STILL_KREA = "__krea_depth__";
const VIDEO_L2R = "__ltx_l2r__";
// Optional second engine: MiniMax H3 through the video picker (router key starts with this). LTX stays the default.
const H3_KEY = "MiniMax H3 · local";
const H3_LABEL = "MiniMax H3 (local, looser blocking, rich motion, own sound; ~20+ min)";
const H3_CLAY_REF = "clay previz as <Video 1>";
const isH3 = (v) => typeof v === "string" && v.startsWith(H3_KEY);
const H3_MAX_REFS = 7;   // H3 takes 9 pictures: first + last frame + up to 7 references
/** A saved image ({filename, subfolder, type} or {file: ...}) as LoadImage's annotated name. */
const loadName = (x) => {
  const f = x?.file || x;
  if (!f) return "";
  if (typeof f === "string") return f;
  return f.filename ? `${f.subfolder ? f.subfolder + "/" : ""}${f.filename} [${f.type || "input"}]` : "";
};

const CSS = `
.ss-pipe { display:flex; gap:6px; align-items:stretch; margin:0 0 8px; flex-wrap:wrap; }
.ss-pipe button { flex:1 1 0; min-width:92px; display:flex; flex-direction:column; align-items:flex-start; gap:2px;
  padding:8px 10px; border-radius:12px; border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.04);
  color:var(--ss-muted,#a9a3ad); cursor:pointer; font:inherit; text-align:left; }
.ss-pipe button .n { font-size:11px; letter-spacing:.06em; text-transform:uppercase; display:flex; gap:6px; align-items:center; }
.ss-pipe button .t { font-size:14px; font-weight:600; color:var(--ss-text,#f0efed); }
.ss-pipe button[aria-current="step"] { border-color:var(--ss-accent,#F2FF59); background:rgba(242,255,89,.08); }
.ss-pipe button[aria-current="step"] .n { color:var(--ss-accent,#F2FF59); }
.ss-pipe button .done { color:#7ee2a8; }
.ss-pipeview { display:flex; flex-direction:column; gap:12px; padding:4px 2px 8px; }
.ss-pipeview h3 { margin:0; font-size:18px; color:var(--ss-text,#f0efed); }
.ss-pipeview .lede { margin:0; color:var(--ss-muted,#a9a3ad); font-size:13px; }
.ss-pipeview .card { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); border-radius:14px; padding:12px; display:flex; flex-direction:column; gap:10px; }
.ss-pipeview .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.ss-pipeview label.f { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ss-muted,#a9a3ad); flex:0 0 auto; }
.ss-pipeview select, .ss-pipeview textarea { background:#1a1420; color:var(--ss-text,#f0efed); border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:7px 9px; font:inherit; }
.ss-pipeview textarea { min-height:64px; resize:vertical; }
.ss-pipeview input[type=range] { accent-color:var(--ss-accent,#F2FF59); flex:1; }
.ss-stage .ss-pipeview button.go { background:var(--ss-accent,#F2FF59) !important; color:#1a1420 !important; border:0 !important; border-radius:999px; padding:9px 16px; font-weight:700; cursor:pointer; }
.ss-stage .ss-pipeview button.go[disabled] { opacity:.45; cursor:default; }
.ss-pipeview .ghost { background:transparent; color:var(--ss-text,#f0efed); border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:8px 14px; cursor:pointer; }
.ss-pipeview .next { align-self:flex-end; }
.ss-pipeview .seg button { border-radius:999px; border:1px solid rgba(255,255,255,.15); background:transparent; color:var(--ss-text,#f0efed); padding:5px 12px; cursor:pointer; }
.ss-stage .ss-pipeview .seg button[aria-pressed="true"] { background:var(--ss-accent,#F2FF59) !important; color:#1a1420 !important; border-color:transparent !important; }
.ss-pipeview .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
.ss-pipeview .cand { position:relative; border-radius:12px; overflow:hidden; border:2px solid transparent; background:#1a1420; cursor:pointer; }
.ss-pipeview .cand img { width:100%; display:block; aspect-ratio:1.85; object-fit:cover; }
.ss-pipeview .cand .cap { position:absolute; left:6px; bottom:6px; right:6px; display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#fff; text-shadow:0 1px 2px #000; }
.ss-pipeview .cand[data-chosen="true"] { border-color:var(--ss-accent,#F2FF59); }
.ss-pipeview .cand .pill { background:var(--ss-accent,#F2FF59); color:#1a1420; border-radius:999px; padding:2px 8px; font-weight:700; text-shadow:none; }
.ss-pipeview .clay { width:100%; border-radius:12px; display:block; }
.ss-pipeview .status { font-size:12px; color:var(--ss-muted,#a9a3ad); min-height:16px; }
.ss-pipeview video { width:100%; border-radius:12px; background:#000; }
.ss-shotrow { display:flex; gap:8px; align-items:stretch; overflow-x:auto; padding:2px 2px 6px; }
.ss-shotrow > .lbl { align-self:center; font-size:12px; color:var(--ss-muted,#a9a3ad); white-space:nowrap; }
.ss-stage .ss-shotrow button.shot { flex:0 0 150px; display:flex !important; flex-direction:column !important; align-items:stretch !important; gap:3px !important;
  padding:4px !important; border-radius:10px !important; border:2px solid rgba(255,255,255,.08) !important; background:rgba(255,255,255,.04) !important;
  color:var(--ss-text,#f0efed) !important; cursor:pointer; text-align:left; font:inherit; }
.ss-stage .ss-shotrow button.shot[aria-pressed="true"] { border-color:var(--ss-accent,#F2FF59) !important; }
.ss-shotrow .shot img, .ss-shotrow .shot canvas { width:100%; aspect-ratio:1.85; object-fit:cover; border-radius:6px; display:block; background:#1a1420; }
.ss-shotrow .shot .nm { font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-shotrow .shot .st { font-size:11px; color:var(--ss-muted,#a9a3ad); }
.ss-shotrow .shot .st.ok { color:#7ee2a8; } .ss-shotrow .shot .st.busy { color:var(--ss-accent,#F2FF59); }
.ss-ladderview > .ss-shotrow { margin:0 0 8px; }
.ss-pipeview .two { display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:start; }
@media (max-width: 640px) { .ss-pipeview .two { grid-template-columns:1fr; } }
.ss-pipeview .ss-studio { display:grid; grid-template-columns:minmax(260px, 340px) minmax(0, 1fr); gap:12px; align-items:start; }
.ss-pipeview .ss-studio-side { display:flex; flex-direction:column; gap:10px; min-width:0; position:sticky; top:8px; max-height:calc(100vh - 40px); overflow:auto; }
.ss-pipeview .ss-studio-main { display:flex; flex-direction:column; gap:10px; min-width:0; }
.ss-pipeview .ss-studio-side details > summary { cursor:pointer; font-weight:600; list-style:none; }
.ss-pipeview .ss-editbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.ss-pipeview .ss-edithost:empty { display:none; }
/* Paint Studio: the headline way to fix a first frame. */
.ss-pipeview .ss-paintcard { border-color:rgba(242,255,89,.4); background:linear-gradient(135deg, rgba(242,255,89,.10), rgba(242,255,89,.02) 60%); }
.ss-pipeview .ss-paint-head { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.ss-pipeview .ss-paint-badge { width:46px; height:46px; border-radius:14px; display:grid; place-items:center; flex:none;
  background:var(--ss-accent,#F2FF59); color:#1a1420; box-shadow:0 6px 22px rgba(242,255,89,.25); }
.ss-pipeview .ss-paint-txt { display:flex; flex-direction:column; gap:2px; flex:1; min-width:220px; }
.ss-pipeview .ss-paint-txt strong { font-size:17px; letter-spacing:.01em; }
.ss-pipeview .ss-paint-feats { display:flex; gap:6px; flex-wrap:wrap; }
.ss-pipeview .ss-paint-feats span { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:4px 10px; border-radius:999px;
  background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); color:var(--ss-text,#f0efed); }
.ss-pipeview .ss-paint-feats .ss-icon { color:var(--ss-accent,#F2FF59); }
.ss-stage .ss-pipeview button.go.ss-paint-open { padding:11px 20px !important; font-size:14px; display:inline-flex; align-items:center; gap:8px; }
.ss-pipeview .ss-studio.ss-painting { grid-template-columns:minmax(0, 1fr); }
.ss-pipeview .ss-studio.ss-painting > .ss-studio-side { display:none; }
/* Cast in this shot (④ Frame, ⑤ Motion) */
.ss-pipeview .ss-sc-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ss-pipeview .ss-sc-head strong { font-size:15px; }
.ss-pipeview .ss-sc-sizes { display:inline-flex; gap:3px; margin-left:auto; }
.ss-stage .ss-pipeview .ss-sc-sizes button { border-radius:999px; border:1px solid rgba(255,255,255,.15); background:transparent; color:var(--ss-text,#f0efed); padding:2px 9px; font-size:11px; cursor:pointer; }
.ss-stage .ss-pipeview .ss-sc-sizes button[aria-pressed="true"] { background:var(--ss-accent,#F2FF59) !important; color:#1a1420 !important; border-color:transparent !important; }
.ss-pipeview .ss-sc-group { display:flex; flex-direction:column; gap:6px; }
.ss-pipeview .ss-sc-gh { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ss-muted,#a9a3ad); font-weight:700; display:flex; gap:6px; align-items:center; }
.ss-pipeview .ss-sc-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(var(--ss-sc-tile,140px), 1fr)); gap:8px; }
.ss-pipeview .ss-sc-tile { display:flex; flex-direction:column; gap:5px; padding:5px; border-radius:12px; border:2px solid rgba(255,255,255,.08); background:rgba(255,255,255,.03); min-width:0; }
.ss-pipeview .ss-sc-tile[data-on="true"] { border-color:var(--ss-accent,#F2FF59); background:rgba(242,255,89,.06); }
.ss-pipeview .ss-sc-tile[data-over="true"] { border-color:rgba(255,170,60,.8); }
.ss-pipeview .ss-sc-pic { position:relative; aspect-ratio:1; border-radius:8px; overflow:hidden; background:#121015; cursor:pointer; }
.ss-pipeview .ss-sc-pic img { width:100%; height:100%; object-fit:cover; display:block; }
.ss-pipeview .ss-sc-pic .ph { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; font-size:11px; opacity:.6; border:1px dashed rgba(255,255,255,.2); border-radius:8px; text-align:center; padding:4px; }
.ss-pipeview .ss-sc-badge { position:absolute; left:5px; top:5px; background:var(--ss-accent,#F2FF59); color:#1a1420; border-radius:999px; padding:1px 7px; font-size:11px; font-weight:700; }
.ss-pipeview .ss-sc-badge.over { background:#ffaa3c; }
.ss-pipeview .ss-sc-nm { font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-pipeview .ss-sc-tile label { display:flex; align-items:center; gap:5px; font-size:11px; color:var(--ss-muted,#a9a3ad); cursor:pointer; }
.ss-pipeview .ss-sc-tile input[type=checkbox] { accent-color:var(--ss-accent,#F2FF59); }
.ss-stage .ss-pipeview .ss-sc-acts button { font-size:11px !important; padding:2px 8px !important; }
.ss-pipeview .ss-sc-strip { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
.ss-pipeview .ss-sc-strip .ss-sc-tile { flex:0 0 96px; }
.ss-pipeview .ss-sc-note { font-size:12px; color:var(--ss-muted,#a9a3ad); }
.ss-pipeview .ss-sc-note.warn { color:#ffc27a; }
@media (max-width: 860px) { .ss-pipeview .ss-studio { grid-template-columns:1fr; } .ss-pipeview .ss-studio-side { position:static; max-height:none; } }
`;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea")
    e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  return e;
};

/**
 * ctx: {
 *   app, api, stage, look, ladder,
 *   showView(k), getRenders(sid) -> {kind: url}, rememberRender(sid, kind, fileRef),
 *   onRung(fn(evt)) where evt = {rung, kind, url, file, promptId, shotId},
 *   flattenCut(), renderMissing(), openCanvas(), status(msg)
 * }
 */
/** Sound effects for what is on stage: moving animals/vehicles/people plus the set's ambience. */
export function suggestSfx(scene) {
  const fps = scene?.shot?.fps || 24;
  const speed = (a) => {
    const k = a.keys || [];
    if (k.length < 2) return 0;
    let d = 0;
    for (let i = 1; i < k.length; i++) d += Math.hypot(k[i].position[0] - k[i - 1].position[0], k[i].position[2] - k[i - 1].position[2]);
    return d / Math.max(1 / fps, (k[k.length - 1].frame - k[0].frame) / fps);
  };
  const parts = [];
  const add = (s) => { if (s && !parts.includes(s)) parts.push(s); };
  for (const a of scene?.actors || []) {
    const v = speed(a), k = a.kind;
    if (k === "horse") add(v > 5 ? "horses galloping hard on packed ground, hooves thundering" : v > 0.3 ? "horse hooves walking, tack jingling" : "horses snorting and shifting");
    else if (["man", "woman", "child"].includes(k) && !a.mount_id) add(v > 3 ? "footsteps running, breathing hard" : v > 0.3 ? "footsteps" : "");
    else if (k === "police_car") add(v > 0.3 ? "police siren wailing, engine revving, tyres on asphalt" : "engine idling, police radio chatter");
    else if (["car", "truck", "sports_car", "hatchback"].includes(k)) add(v > 0.3 ? (k === "sports_car" ? "sports car engine roaring, tyres on asphalt" : "engine revving, tyres on asphalt") : "engine idling");
    else if (k === "dog") add(v > 2 ? "dog running, panting" : "dog panting");
  }
  const set = scene?.environment?.set || "";
  add({ desert: "desert wind", beach: "waves breaking, gulls", forest: "birdsong, leaves rustling", street_night: "city night ambience",
    plaza: "city ambience", interior: "quiet room tone", water_tank: "water lapping" }[set] || "");
  if (scene?.environment?.weather === "rain") add("steady rain");
  return parts.join(", ");
}

export class Pipeline {
  constructor(host, ctx) {
    this.ctx = ctx;
    if (!document.getElementById("ss-pipe-css")) document.head.append(h("style", { id: "ss-pipe-css" }, CSS));
    this.bar = h("nav", { class: "ss-pipe", "aria-label": "Soundstage steps" });
    this.btns = {};
    for (const s of STEPS) {
      const b = h("button", { type: "button", title: s.hint, on: { click: () => this.go(s.k) } },
        h("span", { class: "n" }, `Step ${s.n}`, h("span", { class: "done", hidden: "" }, "✓")),
        h("span", { class: "t" }, s.label));
      this.btns[s.k] = b;
      this.bar.append(b);
    }
    // Stop: cancel what this App queued and interrupt the running render. Shown only while something renders.
    this.stopBtn = h("button", { type: "button", class: "ss-stop", hidden: "", title: "Stop: cancel the queued renders and interrupt the one running now",
      on: { click: () => this.stopAll() } }, "■ Stop");
    this.bar.append(this.stopBtn);
    if (!document.getElementById("ss-stop-css")) document.head.append(h("style", { id: "ss-stop-css" },
      ".ss-pipe .ss-stop{flex:0 0 auto!important;align-self:center;border-radius:999px!important;padding:8px 16px!important;background:#ff453a!important;color:#fff!important;border:none!important;font-weight:700!important;cursor:pointer}"));
    this._stopPoll = setInterval(() => this._refreshStop(), 2000);
    host.prepend(this.bar);
    this.shotRows = [];              // one shot picker per step screen (every step works on every shot)
    this.candidates = {};            // shotId -> [{seed, model, url, file}]
    this.chosen = {};                // shotId -> the chosen frame {url, file, seed, model, seedNode}; saved with the workflow
    this.touched = {};               // shotId -> true when that shot uses its Canvas touch-up
    this.inflight = new Map();       // promptId -> {sid, step} while a render is queued or running
    this.views = { frame: this._frameView(), motion: this._motionView(), deliver: this._deliverView() };
    this.pending = new Map();        // promptId -> {seed, model} for Frame variations
    ctx.onRung((ev) => this._onRung(ev));
    const settle = (ev) => { if (this.inflight.delete(ev.detail?.prompt_id)) this._drawShotRows(); };
    for (const t of ["execution_success", "execution_error", "execution_interrupted"]) ctx.api?.addEventListener?.(t, settle);
    setTimeout(() => this._loadChosen(), 0);   // node.properties arrive after the widget is built
    if (ctx.mountReview) ctx.mountReview(this._shotRow("review"));
    this.current = "set";
    this.mark("set");
  }

  // ------------------------------------------------------------------ graph helpers
  node(id) { return this.ctx.app.graph?.getNodeById?.(id) || this.ctx.app.graph?._nodes?.find((n) => n.id === id); }
  w(id, name) { return this.node(id)?.widgets?.find((x) => x.name === name); }
  set(id, name, value) { const x = this.w(id, name); if (x) { x.value = value; x.callback?.(value); } return !!x; }
  stepW() { return this.ctx.app.graph?._nodes?.find((n) => n.type === "SoundstageStep")?.widgets?.find((x) => x.name === "step"); }
  async queueAt(step, extra = {}) {
    const sw = this.stepW();
    if (sw) sw.value = step;
    // Hold the ladder at this step while the prompt is built (capturing and uploading passes can take seconds).
    const held = !this._holding;
    if (held) { this._holding = true; this.ctx.setBatch?.(true); }
    let r;
    try { r = await this.ctx.app.queuePrompt(0, 1); } finally { if (held) { this._holding = false; this.ctx.setBatch?.(false); } }
    const pid = this.ctx.lastPromptId?.();
    if (pid && Object.keys(extra).length) this.pending.set(pid, extra);
    if (pid) { this.inflight.set(pid, { sid: this.ctx.stage.activeShot().id, step, t: Date.now() }); this._drawShotRows(); }
    this.ctx.app.graph.setDirtyCanvas(true);
    return r;
  }

  async _refreshStop() {
    try {
      const q = await (await this.ctx.api.fetchApi("/queue")).json();
      const n = (q.queue_running || []).length + (q.queue_pending || []).length;
      this.stopBtn.hidden = n === 0;
      this.stopBtn.textContent = n > 1 ? `■ Stop (${n})` : "■ Stop";
    } catch { /* server away */ }
  }

  _say(m) {
    this.ctx.onStatus?.(m);
    for (const v of Object.values(this.views || {})) { const st = v.querySelector?.(".status"); if (st && !v.hidden) { st.textContent = m; break; } }
    const s = this.ctx.app?.graph && document.querySelector(".ss-stage .ss-status");
    if (s) s.textContent = m;
  }

  /** Cancel every queued render and interrupt the running one; the step rows clear their "painting…" marks. */
  async stopAll() {
    const api = this.ctx.api;
    this.stopBtn.disabled = true;
    try {
      const q = await (await api.fetchApi("/queue")).json();
      const pending = (q.queue_pending || []).map((x) => x[1]);
      if (pending.length) await api.fetchApi("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: pending }) });
      if ((q.queue_running || []).length) await api.fetchApi("/interrupt", { method: "POST" });
      this.inflight.clear();
      this._drawShotRows();
      this.ctx.setBatch?.(false);
      this._say(`Stopped: ${pending.length} queued render${pending.length === 1 ? "" : "s"} cancelled${(q.queue_running || []).length ? ", the running one interrupted" : ""}.`);
    } catch (e) { this._say(`Couldn't stop: ${e.message}`); }
    this.stopBtn.disabled = false;
    this._refreshStop();
  }

  /** A render this App queued is still waiting or running (entries older than an hour are taken as lost events). */
  busy() {
    const now = Date.now();
    for (const [pid, x] of this.inflight) if (x.t && now - x.t > 3600000) this.inflight.delete(pid);
    return this.inflight.size > 0;
  }

  // ------------------------------------------------------------------ navigation
  go(k) {
    const s = STEPS.find((x) => x.k === k);
    if (!s) return;
    this.ctx.showView(s.view);
    this.mark(k);
    if (k === "frame") this._refreshFrame();
    if (k === "motion") this._refreshMotion();
    if (k === "review") this.restoreLadder();
    if (k === "deliver") this._drawShotRows();
  }

  /** Called by showView for any tab: keeps the step bar in sync and shows/hides the pipeline views. */
  onView(view) {
    for (const [k, v] of Object.entries(this.views)) v.hidden = k !== view;
    const s = STEPS.find((x) => x.view === view);
    if (s) this.mark(s.k);
  }

  mark(k) {
    this.current = k;
    const r = this.ctx.getRenders(this.ctx.stage.activeShot().id) || {};
    const done = { script: !!this.ctx.hasScript?.(), cast: !!this.ctx.castDone?.(), set: !!r.previz, frame: !!r.look, motion: !!(r.final || r.final_sound || r.draft), review: !!(r.final || r.final_sound),
      deliver: false };
    for (const s of STEPS) {
      this.btns[s.k].setAttribute("aria-current", s.k === k ? "step" : "false");
      this.btns[s.k].querySelector(".done").hidden = !done[s.k];
    }
  }

  /** Put this shot's saved renders on the Ladder rungs (look still, draft, final). */
  restoreLadder() {
    const r = this.ctx.getRenders(this.ctx.stage.activeShot().id) || {};
    const L = this.ctx.ladder;
    try {
      const put = (rung, kind, url) => { if (url) { if (L.sources?.[rung]?.url !== url) L.setSource(rung, kind, url); } else L.clearSource?.(rung); };
      put(2, "image", this.chosen[this.ctx.stage.activeShot().id]?.url || r.look);
      put(3, "video", r.draft);
      put(4, "video", r.final_sound || r.final_audio || r.final);
      L.draw?.();
    } catch { /* ladder not ready */ }
    this.mark(this.current);
    this._drawShotRows();
  }

  _next(label, k) {
    return h("button", { type: "button", class: "go next", on: { click: () => this.go(k) } }, `${label} →`);
  }

  // ------------------------------------------------------------------ ④ Frame
  _frameView() {
    const v = h("section", { class: "ss-pipeview ss-frameview", hidden: "" });
    this.f = {};
    const f = this.f;
    f.clay = h("canvas", { class: "clay" });
    f.model = h("select", { on: { change: () => this._applyStillModel() } });
    f.follow = h("input", { type: "range", min: "0.55", max: "1", step: "0.01", value: "0.85",
      on: { input: () => { f.followOut.textContent = this._followLabel(); this._applyStillModel(); } } });
    f.followOut = h("span", { class: "status" });
    f.desc = h("textarea", { placeholder: "What's in the frame and how it should feel: golden hour, dust, worn leather saddles…",
      on: { change: () => this._setDescription(f.desc.value) } });
    f.count = 4;
    f.countSeg = h("span", { class: "seg row" }, ...[1, 2, 4].map((n) => h("button", { type: "button", "aria-pressed": String(n === 4),
      on: { click: (e) => { f.count = n; for (const b of f.countSeg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); } } }, `${n}`)));
    // Quality = step count, up front (the same Steps field as in Advanced). More steps add fine detail, slower.
    const QUALITY = { klein: [["Fast", 8], ["Standard", 20], ["High", 28], ["Max", 40]], krea: [["Fast", 6], ["Standard", 8], ["High", 14], ["Max", 20]] };
    f.qualSeg = h("span", { class: "seg row", title: "Steps for the image model: more = finer detail, slower. CFG stays 1 (these models are distilled)" });
    f.drawQuality = () => {
      const krea = f.model.value === STILL_KREA, cur = Math.round(+f.steps.value || 0);
      f.qualSeg.replaceChildren(...QUALITY[krea ? "krea" : "klein"].map(([label, st]) => h("button", { type: "button", "aria-pressed": String(cur === st),
        title: `${st} steps, CFG 1`,
        on: { click: () => { f.steps.value = String(st); this._applySampling(); f.drawQuality(); } } }, label)));
    };
    f.goBtn = h("button", { type: "button", class: "go", on: { click: () => this.generateFrames() } }, "Generate frames");
    f.allBtn = h("button", { type: "button", class: "ghost", title: "Queue the same number of variations for every shot in the scene",
      on: { click: () => this.generateFrames(true) } }, "…for every shot");
    f.status = h("div", { class: "status" });
    f.grid = h("div", { class: "grid" });
    f.touch = h("button", { type: "button", class: "ghost", title: "Paint, mask or regenerate parts of your chosen frame; come back with “Use my edited frame”",
      on: { click: () => {
        const sid = this.ctx.stage.activeShot().id;
        this.ctx.openCanvas(this.chosen?.[sid]?.url || (this.ctx.getRenders(sid) || {}).look || null);
      } } }, "Touch up in Canvas");
    f.useTouch = h("input", { type: "checkbox", on: { change: () => {
      this.touched[this.ctx.stage.activeShot().id] = f.useTouch.checked;
      this.set(9086, "switch", f.useTouch.checked);
    } } });
    // LoRA for the image model (FLUX 3 Klein / Krea 2): a character, product or house style.
    f.lora = h("select", { on: { change: () => this.set(9081, "lora", f.lora.value) } });
    f.loraStrength = h("input", { type: "range", min: "0", max: "1.5", step: "0.05", value: "1",
      on: { input: () => { this.set(9081, "lora_strength", +f.loraStrength.value); f.loraOut.textContent = (+f.loraStrength.value).toFixed(2); } } });
    f.loraOut = h("span", { class: "status" }, "1.00");
    f.refsCard = h("div", { class: "card" });
    const num = (min, max, step, on) => h("input", { type: "number", min, max, step, style: "width:90px", on: { change: on } });
    f.steps = num("0", "100", "1", () => this._applySampling());
    f.cfg = num("0", "20", "0.1", () => this._applySampling());
    f.sampNote = h("div", { class: "status" });
    f.neg = h("textarea", { placeholder: "Negative prompt: what to keep out (extra people, text, blur…)", style: "min-height:44px",
      on: { change: () => { this.set(9081, "negative", f.neg.value); } } });
    f.editHost = h("div", { class: "ss-edithost" });
    f.editBtn = h("button", { type: "button", class: "go ss-paint-open", title: "Open your chosen frame in Paint Studio: Generative Fill, Remove, Extend the canvas, layers and masks",
      on: { click: () => this._openEditor() } }, icon("wand-sparkles", 17), "Open Paint Studio");
    f.closeEdit = h("button", { type: "button", class: "ghost", hidden: "", on: { click: () => this._closeEditor() } }, "Close Paint Studio");
    const feat = (ic, t) => h("span", {}, icon(ic, 14), t);
    f.paintFeats = h("div", { class: "ss-paint-feats" }, feat("sparkles", "Generative Fill: mask it, describe it"),
      feat("x", "Remove people, signs, rigs"), feat("maximize-2", "Extend 16:9 → 2.39, 9:16…"),
      feat("wand-sparkles", "Magic select (SAM 3.1)"), feat("users", "Put a cast member in"), feat("layers", "Layers, history, variations"));
    v.append(
      h("h3", {}, "④ Frame: paint the first frame from your clay"),
      h("p", { class: "lede" }, "Generate a few frames from your clay, pick one, fix it in Paint Studio (fill, remove, extend the canvas), then animate it. Every shot gets its own frame: pick a shot below."),
      this._shotRow("frame"),
      f.studio = h("div", { class: "ss-studio" },
        h("div", { class: "ss-studio-side" },
          h("div", { class: "card" },
            h("label", { class: "f" }, "Image model", f.model),
            h("label", { class: "f" }, "Prompt: describe the frame (the Look tab adds camera, lens and style to it)", f.desc),
            h("label", { class: "f" }, h("span", { class: "row" }, "Follow the clay", f.followOut), f.follow),
            h("label", { class: "f" }, "LoRA (character, product, style)", f.lora),
            h("label", { class: "f" }, h("span", { class: "row" }, "LoRA strength", f.loraOut), f.loraStrength),
            h("div", { class: "row" }, h("span", { class: "status" }, "Variations"), f.countSeg),
            h("div", { class: "row" }, h("span", { class: "status" }, "Quality"), f.qualSeg),
            h("div", { class: "row" }, f.goBtn, f.allBtn)),
          f.refsCard,
          h("details", { class: "card" }, h("summary", {}, "Advanced: steps & CFG"),
            h("div", { class: "row" }, h("label", { class: "row status" }, "Steps", f.steps), h("label", { class: "row status" }, "CFG", f.cfg)),
            h("label", { class: "f" }, "Negative prompt (used when CFG is above 1)", f.neg),
            f.sampNote),
          h("details", { class: "card" }, h("summary", {}, "Style"),
            h("span", { class: "status" }, "One click sets film stock, lens, palette and grade (★ = suggested)."), f.styleHost = h("div")),
          h("details", { class: "card" }, h("summary", {}, "Camera"),
            h("span", { class: "status" }, "Body, lens, focal length and aperture. Same as the Look tab."), f.gearHost = h("div")),
          h("div", { class: "card" }, f.clayCap = h("div", { class: "status" }, "Your clay, frame 1"), f.clay)),
        h("div", { class: "ss-studio-main" },
          f.status,
          f.hero = h("img", { alt: "The chosen frame for this shot", hidden: "",
            style: "width:100%;aspect-ratio:16/9;object-fit:contain;background:#0f0d11;border-radius:14px;border:1px solid rgba(255,255,255,.08)" }),
          f.grid,
          f.paintCard = h("div", { class: "card ss-paintcard" },
            h("div", { class: "ss-paint-head" },
              h("span", { class: "ss-paint-badge" }, icon("wand-sparkles", 24)),
              h("div", { class: "ss-paint-txt" }, h("strong", {}, "Paint Studio"),
                h("span", { class: "status" }, "Get the first frame right before you animate it: a small Photoshop for this frame.")),
              f.editBtn, f.closeEdit),
            f.paintFeats,
            h("label", { class: "row status" }, f.useTouch, "Animate my edited frame (Paint Studio's “Use as first frame” turns this on)"),
            f.editHost))),
      h("div", { class: "row" }, h("span", { style: "flex:1" }), this._next("⑤ Animate this frame", "motion")),
    );
    return v;
  }

  /** Paint Studio's "Use as first frame": the painted picture (input/-relative `name`) becomes this shot's chosen
   *  frame and its touch-up still, so Motion animates it. Returns the shot id. */
  useEditedFrame({ name, url }) {
    const sid = this.ctx.stage.activeShot().id;
    const prev = this.chosen[sid] || {};
    const i = name.lastIndexOf("/");
    const file = { filename: name.slice(i + 1), subfolder: i > 0 ? name.slice(0, i) : "", type: "input" };
    const cand = { url, file, edited: name, seed: prev.seed, model: prev.model, seedNode: prev.seedNode, refFiles: prev.refFiles };
    this.candidates[sid] = [cand, ...(this.candidates[sid] || []).filter((c) => c.edited !== name)];
    this.chosen[sid] = { ...prev, url, file, edited: name };
    this.touched[sid] = true;
    this.set(9086, "switch", true);
    setTouchupStill(this.ctx.app, name);
    this.ctx.rememberRender?.(sid, "look", file);
    this._saveChosen();
    try { this.ctx.ladder.setSource(2, "image", url); } catch { /* ladder not ready */ }
    this._drawCandidates();
    this._drawShotRows();
    if (this.f) {
      this.f.useTouch.checked = true;
      this.f.status.textContent = "Your painted frame is this shot's first frame. Animate it next (Motion), or keep painting.";
    }
    this.mark(this.current);
    return sid;
  }

  // ------------------------------------------------------------------ references (character sheets, location, style)
  /** One slot per cast member on the stage (people, animals, vehicles) plus location and style. An image added to a
   *  slot is uploaded to ComfyUI's input folder and passed to the image model as a reference for every shot. */
  _refSlots() {
    let actors = [];
    try { actors = this.ctx.stage.toJSON().actors || []; } catch { /* stage not ready */ }
    const CAST = /^(man|woman|child|horse|dog|cat|car|police_car|sports_car|hatchback|truck|bicycle|motorcycle|ufo|custom)$/;
    const slots = actors.filter((a) => CAST.test(a.kind || "") && !a.carry_id && !a.set_piece && !a.set_xform)   // the cast, not the set dressing
      .map((a) => ({ key: `actor:${a.id}`, label: a.name || a.kind }));
    slots.push({ key: "location", label: "Location / background" }, { key: "style", label: "Style / look" });
    return slots;
  }

  _refNode() { return this.ctx.app?.graph?.getNodeById?.(9081) || null; }

  _refs() { return { ...(this._refNode()?.properties?.ss_refs || {}) }; }

  /** ref_files as every shot used to get them (all of ss_refs), for frames chosen before "Cast in this shot". */
  _legacyRefLines(refs = this._refs()) {
    const labels = Object.fromEntries(this._refSlots().map((s) => [s.key, s.label]));
    return Object.entries(refs).filter(([, f]) => f).map(([k, f]) => `${f} | ${labels[k] || k.replace(/^actor:/, "")}`).join("\n");
  }

  _saveRefs(refs) {
    const node = this._refNode();
    if (!node) return;
    node.properties = { ...(node.properties || {}), ss_refs: refs };
    this.set(9081, "ref_files", this._legacyRefLines(refs));
    this.ctx.app?.graph?.setDirtyCanvas?.(true, true);
  }

  async _uploadRef(key, file) {
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("subfolder", "soundstage_refs");
    body.append("type", "input");
    const r = await this.ctx.api.fetchApi("/upload/image", { method: "POST", body });
    if (!r.ok) throw new Error(`upload failed (${r.status})`);
    const j = await r.json();
    const refs = this._refs();
    refs[key] = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
    this._saveRefs(refs);
    this._drawCastRefs();
  }

  /** Old name, still called by Cast & Locations when a picture changes. */
  _drawCastRefs() { this._drawShotCast(); }

  // ------------------------------------------------------------------ Cast in this shot
  /** Everything a shot can use: ② Cast & Locations items + stage actors with a ④ Frame reference + the style ref. */
  _shotPool() {
    let actors = [];
    try { actors = this.ctx.stage.toJSON().actors || []; } catch { /* stage not ready */ }
    const keys = new Set(this._refSlots().map((s) => s.key));
    const cast = actors.filter((a) => keys.has(`actor:${a.id}`));
    return { pool: castPool(this.ctx.castItems?.() || [], cast, this._refs(), (f) => this._refURL(f)), actors: cast };
  }

  _refURL(ref) {
    const q = new URLSearchParams(refViewParams(ref));
    return this.ctx.api?.apiURL ? this.ctx.api.apiURL(`/view?${q}`) : `/view?${q}`;
  }

  /** The shot's cast keys: what you ticked for it, else who is on its stage + its scene's characters and location. */
  _shotCastKeys(sid, P = this._shotPool()) {
    const saved = (this.ctx.loadShotCast?.() || {})[sid];
    return shotSelection(P.pool, saved, { actors: P.actors, sceneLabel: this.ctx.sceneLabel?.() || null });
  }

  _toggleShotCast(sid, key, on) {
    const P = this._shotPool();
    const keys = this._shotCastKeys(sid, P).filter((k) => k !== key);
    if (on) keys.push(key);
    this.ctx.saveShotCast?.({ ...(this.ctx.loadShotCast?.() || {}), [sid]: keys });
    this._drawShotCast();
  }

  /** Write this shot's references into the image picker (9081 ref_files, at most 4, characters first). */
  _applyShotCast(sid, P = this._shotPool()) {
    const pick = pickRefs(P.pool, this._shotCastKeys(sid, P), REF_LIMIT);
    if (this.w(9081, "ref_files")) this.set(9081, "ref_files", refLines(pick.use));
    return pick;
  }

  /** The current 9081 ref_files text (recorded with each frame, so Motion reproduces exactly that frame). */
  _refFilesNow() { const x = this.w(9081, "ref_files"); return x ? String(x.value || "") : undefined; }

  _castSize() { try { return localStorage.getItem("ss-shotcast-size") || "M"; } catch { return "M"; } }

  _drawShotCast() {
    try {
      if (this.f?.refsCard) this._drawShotCastInto(this.f.refsCard, "frame");
      if (this.m?.castCard) this._drawShotCastInto(this.m.castCard, "motion");
    } catch (e) { console.warn("[Soundstage] cast in this shot", e); }
  }

  _drawShotCastInto(host, where) {
    const shot = this.ctx.stage.activeShot(), sid = shot.id;
    const P = this._shotPool();
    const keys = this._shotCastKeys(sid, P);
    // On screen in ④ Frame, the picker node always shows (and generates with) this shot's picks.
    const pick = where === "frame" && !this.views?.frame?.hidden ? this._applyShotCast(sid, P) : pickRefs(P.pool, keys, REF_LIMIT);
    const h3 = where === "motion" && isH3(this.m?.engine?.value);
    const h3pick = h3 ? pickRefs(P.pool, keys, Math.max(0, H3_MAX_REFS - ((this.chosen[sid] || {}).refs || []).length)) : null;
    const used = h3 ? h3pick.use : pick.use, over = h3 ? h3pick.dropped : pick.dropped;
    const compact = where === "motion";
    const size = this._castSize();
    const px = { S: 92, M: 150, L: 300 }[size] || 150;
    const tile = (it) => {
      const on = keys.includes(it.key), n = used.indexOf(it) + 1, isOver = over.includes(it);
      const cb = h("input", { type: "checkbox", on: { change: () => this._toggleShotCast(sid, it.key, cb.checked) } });
      cb.checked = on;
      const pic = h("div", { class: "ss-sc-pic", title: on ? `${it.name}: in this shot (click to take out)` : `${it.name}: click to put in this shot`,
        on: { click: () => this._toggleShotCast(sid, it.key, !on) } },
        it.url ? h("img", { src: it.url, alt: `${it.name} reference` })
          : h("div", { class: "ph" }, icon(shotKind(it) === "character" ? "user" : shotKind(it) === "location" ? "compass" : shotKind(it) === "wardrobe" ? "shirt" : "box", 20), "no picture yet"),
        n ? h("span", { class: "ss-sc-badge", title: `Sent to the model as reference ${n}` }, `#${n}`) : isOver ? h("span", { class: "ss-sc-badge over", title: `Over the limit of ${h3 ? H3_MAX_REFS : REF_LIMIT}: not sent` }, "over") : null);
      const kids = [pic, h("div", { class: "ss-sc-nm", title: refLabel(it) }, it.name)];
      if (!compact) {
        const up = h("input", { type: "file", accept: "image/*", hidden: "", on: { change: async (e) => {
          const fl = e.target.files?.[0]; e.target.value = "";
          if (!fl || !this.ctx.uploadRef) return;
          this._say(`Uploading ${fl.name} for ${it.name}…`);
          try { const r = await this.ctx.uploadRef(fl); this.ctx.setCastRef?.(it, r); this._drawShotCast(); this._say(`${it.name}: picture added.`); }
          catch (err) { this._say(`Couldn't add that picture: ${err.message}`); }
        } } });
        const b = (label, title, fn) => h("button", { type: "button", class: "ghost", title, on: { click: fn } }, label);
        kids.push(h("label", {}, cb, on ? "In this shot" : "Not in this shot"),
          h("div", { class: "row ss-sc-acts", style: "gap:4px" },
            it.url && this.ctx.editRef ? b("Edit", `Open ${it.name}'s picture in Paint Studio; “Save to reference” keeps the edit`, () => this._editRefImage(it)) : null,
            it.src === "stage" ? null : b(it.url ? "Replace" : "Add picture", "Upload a picture for this reference", () => up.click()), up));
      }
      return h("div", { class: "ss-sc-tile", "data-on": String(on), "data-over": String(isOver) }, ...kids);
    };
    const GROUPS = [["character", "Characters", "user"], ["location", "Location", "compass"], ["wardrobe", "Wardrobe", "shirt"], ["prop", "Props & vehicles", "box"], ["style", "Style", "sparkles"]];
    const groups = GROUPS.map(([k, label, ic]) => {
      const list = P.pool.filter((it) => shotKind(it) === k);
      if (!list.length) return null;
      if (compact) return list.map(tile);
      return h("div", { class: "ss-sc-group" }, h("div", { class: "ss-sc-gh" }, icon(ic, 13), label, h("span", { style: "opacity:.6" }, String(list.length))),
        h("div", { class: "ss-sc-grid" }, ...list.map(tile)));
    }).filter(Boolean);
    const sizes = compact ? null : h("span", { class: "ss-sc-sizes", role: "group", "aria-label": "Thumbnail size" }, ...["S", "M", "L"].map((k) =>
      h("button", { type: "button", "aria-pressed": String(size === k), title: `${k} thumbnails`,
        on: { click: () => { try { localStorage.setItem("ss-shotcast-size", k); } catch { /* storage blocked */ } this._drawShotCast(); } } }, k)));
    const names = used.map((it) => it.name).join(", ");
    const lim = h3 ? H3_MAX_REFS : REF_LIMIT;
    let note;
    if (!P.pool.length) note = "No cast yet: add characters, locations, wardrobe and props in ② Cast & Locations (or upload pictures there), then tick who is in each shot.";
    else if (!used.length) note = keys.length ? "The cast ticked for this shot has no pictures yet: add one (or generate it in ② Cast & Locations)." : "Nobody is ticked for this shot: the frame is painted from the prompt and the clay alone.";
    else note = where === "motion" && !h3
      ? `LTX animates this shot's first frame, so the cast comes in through the frame: ④ Frame paints it with ${names}. Ticks here change the next frames you generate (a chosen frame keeps the references it was painted with).`
      : `${h3 ? "H3 sees" : "Sent to the image model"}: ${used.map((it) => refLabel(it)).join(" · ")}.`;
    const warn = over.length ? `${keys.length} ticked, only ${lim} go to the model (characters first, then the location, wardrobe, props): not sent ${over.map((it) => it.name).join(", ")}.` : "";
    const krea = where === "frame" && this.f?.model?.value === STILL_KREA;
    const noNode = where === "frame" && !this.w(9081, "ref_files");
    host.style.setProperty("--ss-sc-tile", `${px}px`);
    host.replaceChildren(...[
      h("div", { class: "ss-sc-head" }, icon("users", 16), h("strong", {}, "Cast in this shot"),
        h("span", { class: "status" }, `${shot.name}: ${keys.length} ticked`), sizes,
        this.ctx.openCast ? h("button", { type: "button", class: "ghost", style: "font-size:12px;padding:3px 9px", title: "Add people, places, wardrobe and props, with pictures",
          on: { click: () => this.ctx.openCast() } }, "② Cast & Locations") : null),
      ...(compact ? [h("div", { class: "ss-sc-strip" }, ...groups.flat())] : groups),
      h("div", { class: "ss-sc-note" }, note),
      warn ? h("div", { class: "ss-sc-note warn" }, warn) : null,
      krea ? h("div", { class: "ss-sc-note warn" }, "Krea 2 + stage depth doesn't take references: pick FLUX 3 Klein to use the cast pictures.") : null,
      noNode ? h("div", { class: "ss-sc-note warn" }, "References need the updated Soundstage nodes (restart ComfyUI once).") : null].filter(Boolean));
  }

  /** A cast picture in ④ Frame's Paint Studio; "Save to reference" stores the edit on the cast item. */
  async _editRefImage(it) {
    const f = this.f;
    if (!this.ctx.editRef || !it?.url || !f) return;
    const tok = {};
    this._refTok = tok;
    await this.ctx.editRef(it, { host: f.editHost, onExit: () => {
      if (this._refTok !== tok) return;
      this._refTok = null;
      this._closeEditor();
      this._drawShotCast();
    } });
    if (this._refTok !== tok) return;
    this._paintingUI(`Editing ${it.name}'s reference: mask an area and Generative Fill, Remove or Extend, then “Save to reference”. Cancel leaves it unchanged.`);
  }

  /** Steps / CFG for the frame model: Krea 2 lives on the App's KSampler (9056), the other models on the picker node. */
  _samplingTarget() {
    const krea = this.f.model.value === STILL_KREA;
    return krea ? { id: 9056, steps: "steps", cfg: "cfg", defSteps: 8, label: "Krea 2 Turbo" } : { id: 9081, steps: "steps", cfg: "cfg", defSteps: 20, label: "FLUX 3 Klein" };
  }

  _applySampling() {
    const f = this.f, t = this._samplingTarget();
    const st = Math.round(+f.steps.value || 0), cf = +f.cfg.value || 0;
    if (t.id === 9056) { if (st) this.set(9056, "steps", st); if (cf) this.set(9056, "cfg", cf); }
    else { this.set(9081, "steps", st); this.set(9081, "cfg", cf); }
    this._samplingNote();
  }

  _syncSampling() {
    const f = this.f, t = this._samplingTarget();
    const sw = this.w(t.id, t.steps), cw = this.w(t.id, t.cfg);
    f.steps.disabled = !sw; f.cfg.disabled = !cw;
    // 0 used to mean "the model's default", which read as broken: write the real numbers instead.
    if (sw && !+sw.value) { sw.value = t.defSteps; sw.callback?.(t.defSteps); }
    if (cw && !+cw.value) { cw.value = 1; cw.callback?.(1); }
    f.steps.value = sw ? String(sw.value || 0) : "";
    f.cfg.value = cw ? String(cw.value || 0) : "";
    this._samplingNote();
    try { f.drawQuality?.(); } catch { /* not built */ }
  }

  _samplingNote() {
    const f = this.f, t = this._samplingTarget();
    if (f.steps.disabled) { f.sampNote.textContent = "Needs the updated Soundstage nodes (restart ComfyUI once)."; return; }
    const st = +f.steps.value || t.defSteps, cf = +f.cfg.value || 1;
    f.sampNote.textContent = `${t.label}: ${st} steps, CFG ${cf}. 0 = the model's tuned default. These are distilled models: ` +
      "CFG 1 is right; more steps add fine detail, slower." + (cf > 1.5 ? " CFG above ~1.5 tends to burn and roughly doubles the time." : "");
  }

  /** The Canvas editor (inpaint, outpaint, masks, layers) mounted inside ④ Frame, on the chosen frame. */
  _openEditor() {
    const f = this.f, sid = this.ctx.stage.activeShot().id;
    const url = this.chosen?.[sid]?.url || (this.ctx.getRenders(sid) || {}).look || null;
    if (!this.ctx.mountCanvas) { this.ctx.openCanvas(url); return; }
    this.ctx.mountCanvas(f.editHost, url);
    this._paintingUI(url ? "Paint Studio: mask or select an area (B, M, L, W), describe it, Generative Fill. Drag the canvas edge out (C) and Extend. Then “Use as first frame”."
      : "Pick a frame first, or paint from scratch.");
  }

  _paintingUI(msg) {
    const f = this.f;
    if (f.hero) f.hero.hidden = true;
    f.closeEdit.hidden = false;
    f.editBtn.hidden = true;
    f.paintFeats.hidden = true;
    f.grid.hidden = true;
    f.studio.classList.add("ss-painting");
    f.paintCard.scrollIntoView?.({ block: "start", behavior: "smooth" });
    f.status.textContent = msg;
  }

  _closeEditor() {
    const f = this.f;
    this.ctx.unmountCanvas?.();
    f.closeEdit.hidden = true;
    f.editBtn.hidden = false;
    f.paintFeats.hidden = false;
    f.grid.hidden = false;
    f.studio.classList.remove("ss-painting");
    this._drawCandidates();
  }

  _followLabel() {
    const d = +this.f.follow.value;
    return d >= 0.95 ? "free: new details, looser layout" : d >= 0.8 ? "balanced (recommended)" : "strict: stays very close to the clay";
  }

  _stillOptions() {
    // FLUX 3 Klein (local, steered by the stage image + control) is the default; Krea 2 + depth is the strict depth lock.
    const KLEIN = "FLUX 3 Klein · local [<$5M]";
    const opts = [];
    const pick = this.w(9081, "model");
    const values = pick?.options?.values || [];
    const keys = (Array.isArray(values) ? values : []).map((v) => (typeof v === "string" ? v : v?.key)).filter(Boolean);
    const klein = keys.find((k) => /^FLUX 3 Klein/.test(k)) || KLEIN;
    opts.push({ value: klein, label: "FLUX 3 Klein (local, recommended)" });
    opts.push({ value: STILL_KREA, label: "Krea 2 Turbo + stage depth (local, strict depth lock)" });
    for (const key of keys) {
      if (key !== klein && !/^Krea 2 Turbo/.test(key)) opts.push({ value: key, label: key.replace(" · local", " (local)").replace(/ \[[^\]]*\]$/, "") });
    }
    return opts;
  }

  _refreshFrame() {
    const f = this.f;
    if (!f.gearHost.firstChild && this.ctx.look?.makeGear) f.gearHost.append(this.ctx.look.makeGear());
    if (!f.styleHost.firstChild && this.ctx.look?.makeStyles) f.styleHost.append(this.ctx.look.makeStyles());
    try { this.ctx.look?._syncGear?.(); } catch { /* look not ready */ }
    if (!f.model.options.length) {
      for (const o of this._stillOptions()) f.model.append(new Option(o.label, o.value));
    }
    const usePicker = !!this.w(9082, "switch")?.value;
    f.model.value = usePicker ? (this.w(9081, "model")?.value || STILL_KREA) : STILL_KREA;
    const loraW = this.w(9081, "lora");
    if (loraW && !f.lora.options.length) {
      const vals = loraW.options?.values || ["None"];
      for (const v of (Array.isArray(vals) ? vals : ["None"])) f.lora.append(new Option(v === "None" ? "None" : String(v).replace(/\.safetensors$/, ""), v));
    }
    f.lora.disabled = !loraW;
    this._syncSampling();
    const negW = this.w(9081, "negative");
    f.neg.disabled = !negW;
    if (negW) f.neg.value = negW.value || "";
    if (loraW) { f.lora.value = loraW.value || "None"; f.loraStrength.value = String(this.w(9081, "lora_strength")?.value ?? 1); f.loraOut.textContent = (+f.loraStrength.value).toFixed(2); }
    const dn = this.w(9056, "denoise")?.value;
    if (dn != null) f.follow.value = String(dn);
    f.followOut.textContent = this._followLabel();
    f.desc.value = this.ctx.look?.state?.description || "";
    const sid = this.ctx.stage.activeShot().id;
    f.useTouch.checked = !!this.touched[sid];
    this.set(9086, "switch", f.useTouch.checked);
    f.clayCap.textContent = `${this.ctx.stage.activeShot().name}: your clay, frame 1`;
    this._drawCastRefs();
    this._drawShotRows();
    try {
      const c = this.ctx.stage.renderFrameTo("clay", 0);
      f.clay.width = c.width; f.clay.height = c.height;
      f.clay.getContext("2d").drawImage(c, 0, 0);
    } catch { /* stage not ready */ }
    this._drawCandidates();
  }

  _applyStillModel() {
    const f = this.f;
    queueMicrotask(() => { try { this._syncSampling(); } catch { /* view not built */ } });
    const krea = f.model.value === STILL_KREA;
    this.set(9082, "switch", !krea);
    if (!krea) this.set(9081, "model", f.model.value);
    this.set(9056, "denoise", +f.follow.value);
    queueMicrotask(() => { try { this._drawShotCast(); } catch { /* view not built */ } });
  }

  _setDescription(text) {
    try { this.ctx.setDescription(text); } catch { /* look not ready */ }
  }

  async generateFrames(allShots = false) {
    const f = this.f;
    this._applyStillModel();
    const krea = f.model.value === STILL_KREA;
    const seedNode = krea ? 9056 : 9081;
    f.goBtn.disabled = f.allBtn.disabled = true;
    const one = async (shot, si, n) => {
      const base = Math.floor(Math.random() * 1e9);
      this.set(9086, "switch", !!this.touched[shot.id]);
      const cast = this._applyShotCast(shot.id);
      if (cast.dropped.length && n === 1) this._say(`Only ${REF_LIMIT} references go to the model: ${cast.dropped.map((x) => x.name).join(", ")} left out.`);
      const refFiles = this._refFilesNow();
      for (let i = 0; i < f.count; i++) {
        const seed = base + i * 7919;
        this.set(seedNode, "seed", seed);
        f.status.textContent = `Queueing ${n > 1 ? `${shot.name} (${si + 1}/${n}), ` : ""}frame ${i + 1}/${f.count}${i === 0 ? " (the first one renders the clay passes too)" : ""}…`;
        await this.queueAt(2, { seed, model: f.model.value, seedNode, refFiles });
      }
    };
    try {
      const n = allShots ? this.shots().length : 1;
      if (allShots) await this.forEachShot((s, i) => one(s, i, n));
      else await one(this.ctx.stage.activeShot(), 0, 1);
      const total = f.count * n;
      f.status.textContent = `Rendering ${total} frame${total > 1 ? "s" : ""}${n > 1 ? ` for ${n} shots` : ""}: about 6–10 s each once the models are warm (a new shot also renders its clay passes).`;
    } catch (e) {
      f.status.textContent = `Couldn't queue: ${e.message}`;
    } finally {
      f.goBtn.disabled = f.allBtn.disabled = false;
    }
  }

  _onRung(ev) {
    if (ev.rung === 2) {
      const meta = this.pending.get(ev.promptId);
      const list = (this.candidates[ev.shotId] = this.candidates[ev.shotId] || []);
      const cand = { url: ev.url, file: ev.file, seed: meta?.seed, model: meta?.model, seedNode: meta?.seedNode, refFiles: meta?.refFiles };
      list.unshift(cand);
      if (meta) this.pending.delete(ev.promptId);
      // A shot's first frame is its pick until you choose another, so "every shot" flows straight into Motion.
      if (!this.chosen[ev.shotId] && meta) this._setChosen(ev.shotId, cand);
      if (this.f && !this.views.frame.hidden) {
        this._drawCandidates();
        this.f.status.textContent = "Pick the frame you like: “Use this frame”. The video will start from it.";
      }
    }
    if (ev.rung >= 3 && this.m && !this.views.motion.hidden) this._refreshMotion();
    if (this.current === "review" && ev.shotId === this.ctx.stage.activeShot().id) this.restoreLadder();
    this.mark(this.current);
    this._drawShotRows();
  }

  _drawCandidates() {
    const f = this.f;
    const sid = this.ctx.stage.activeShot().id;
    const list = this.candidates[sid] || [];
    const chosen = this.chosen?.[sid];
    const heroSrc = chosen?.url || (this.ctx.getRenders(sid) || {}).look || "";
    if (f.hero) { if (heroSrc && f.hero.getAttribute("src") !== heroSrc) f.hero.src = heroSrc; f.hero.hidden = !heroSrc || !f.editHost?.isConnected || !!f.editHost.firstChild; }
    f.grid.replaceChildren(...list.map((c) => {
      const isChosen = chosen && chosen.url === c.url;
      return h("div", { class: "cand", "data-chosen": String(!!isChosen), title: c.seed != null ? `seed ${c.seed}` : "",
        on: { click: () => this.choose(c) } },
        h("img", { src: c.url, alt: "candidate frame" }),
        h("div", { class: "cap" }, h("span", {}, c.edited ? "Paint Studio" : (c.model === STILL_KREA || !c.model) ? "Krea 2" : String(c.model).split(" ·")[0]),
          h("span", { class: "pill" }, isChosen ? "✓ Chosen" : "Use this frame")));
    }));
  }

  /** Pick a candidate: lock its model + seed so the next steps reproduce exactly this frame (from cache). */
  choose(c) {
    const sid = this.ctx.stage.activeShot().id;
    this._setChosen(sid, c);
    // A Paint Studio frame animates through the touch-up still; a generated one through its model + seed.
    this.touched[sid] = !!c.edited;
    this.set(9086, "switch", !!c.edited);
    if (c.edited) setTouchupStill(this.ctx.app, c.edited);
    if (this.f?.useTouch) this.f.useTouch.checked = !!c.edited;
    this._saveChosen();
    if (c.model) {
      const krea = c.model === STILL_KREA;
      this.set(9082, "switch", !krea);
      if (!krea) this.set(9081, "model", c.model);
      this.f.model.value = c.model;
    }
    if (c.seed != null) this.set(c.seedNode || 9056, "seed", c.seed);
    try { this.ctx.ladder.setSource(2, "image", c.url); } catch { /* ladder not ready */ }
    this._drawCandidates();
    this._drawShotRows();
    this.f.status.textContent = "Frame chosen. Next: ⑤ Animate this frame.";
    this.mark("frame");
  }

  // ------------------------------------------------------------------ ⑤ Motion
  _motionView() {
    const v = h("section", { class: "ss-pipeview ss-motionview", hidden: "" });
    this.m = {};
    const m = this.m;
    m.engine = h("select", { on: { change: () => this._applyVideo() } });
    m.freedom = h("input", { type: "range", min: "0", max: "0.8", step: "0.05", value: "0.5",
      on: { input: () => { m.freeOut.textContent = this._freeLabel(); this._applyVideo(); } } });
    m.freeOut = h("span", { class: "status" });
    m.h3Ref = h("input", { type: "checkbox", on: { change: () => this._applyVideo() } });
    m.h3Box = h("div", { class: "status", hidden: "" },
      "MiniMax H3 paints rich motion and its own sound in one pass, but follows your clay blocking only loosely, and a final takes about 20+ min. Drafts still preview with LTX. Your sound, music and line below go into H3's prompt.",
      h("label", { class: "row", style: "margin-top:6px" }, m.h3Ref, "Use the clay as a motion reference (<Video 1>; slower, closer blocking)"),
      m.h3Last = h("div", { style: "margin-top:6px" }),
      h("div", { style: "margin-top:6px" }, `Reference images for this shot (character or prop sheets, up to ${H3_MAX_REFS}). H3 sees them as <Picture 2>, <Picture 3>…`),
      m.h3Refs = h("div", { class: "row", style: "flex-wrap:wrap;gap:6px;margin-top:4px" }),
      h("label", { class: "row", style: "margin-top:4px" }, "Add images",
        m.h3RefIn = h("input", { type: "file", accept: "image/*", multiple: "", on: { change: (e) => this._addRefs(e.target.files) } })));
    m.quality = "Draft";   // Draft = quick look (8+3, the default while building), Final = clean motion and detail (12+6), Final HQ = hero shots (18+12)
    m.qSeg = h("span", { class: "seg row" }, ...["Draft", "Final", "Final HQ"].map((q) => h("button", { type: "button", "aria-pressed": String(q === "Draft"),
      title: { Draft: "8 + 3 steps: a quick look, faces readable", Final: "12 + 6 steps: clean motion and detail (recommended)", "Final HQ": "18 + 12 steps: hero shots, about twice as long" }[q],
      title: q === "Draft" ? "8 + 3 distilled steps: fast previews" : "18 + 12 steps on the same curve: finer detail and steadier motion, about 2x slower",
      on: { click: (e) => { m.quality = q; for (const b of m.qSeg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); this._applyVideo(); this._motionNote?.(); } } }, q)));
    m.cfg = h("input", { type: "number", min: "1", max: "10", step: "0.1", style: "width:90px",
      on: { change: () => { const v = Math.max(1, +m.cfg.value || 1); this.set(5516, "cfg", v); this.set(9034, "cfg", v); this._motionNote(); } } });
    m.sampler = h("select", { on: { change: () => { this.set(5516, "sampler_name", m.sampler.value); this.set(9034, "sampler_name", m.sampler.value); } } },
      ...["euler_ancestral", "euler", "res_multistep", "dpmpp_2m", "lcm"].map((x) => new Option(x, x)));
    m.sampNote = h("div", { class: "status" });
    m.neg = h("textarea", { placeholder: "Negative prompt for the video (used when CFG is above 1)", style: "min-height:40px",
      on: { change: () => this.set(5509, "value", m.neg.value) } });
    m.audio = h("input", { type: "checkbox", on: { change: () => this.set(9092, "enabled", m.audio.checked) } });
    m.sfx = h("textarea", { placeholder: "Sound effects: hooves galloping on packed dirt, wind…", style: "min-height:44px",
      on: { change: () => this.set(9087, "sfx_prompt", m.sfx.value) } });
    m.music = h("input", { type: "text", placeholder: "Music mood (optional): tense western strings", style: "background:#1a1420;color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 9px",
      on: { change: () => this.set(9087, "music_mood", m.music.value) } });
    // One-click suggestions: a click fills the field (and the node), the user can still edit it.
    const chips = (field, key, list) => h("div", { class: "row", style: "flex-wrap:wrap;gap:6px" }, ...list.map((t) =>
      h("button", { type: "button", class: "ghost", style: "font-size:12px;padding:3px 9px", title: `Use: ${t}`,
        on: { click: () => { m[field].value = t; this.set(9087, key, t); if (field === "line") this._lipSync(); } } }, t)));
    m.musicIdeas = chips("music", "music_mood", ["tense western strings", "pulsing synth chase", "eerie horror drones",
      "warm romantic piano", "epic orchestral sci-fi", "1970s funk heist groove", "lonely solo cello", "upbeat indie road-trip guitar"]);
    m.lineIdeas = chips("line", "line", ["We're not alone.", "Drive. Don't look back.", "Did you hear that?", "I'd follow you anywhere."]);
    m.line = h("input", { type: "text", placeholder: "Dialogue line (optional)", style: "background:#1a1420;color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 9px",
      on: { change: () => { this.set(9087, "line", m.line.value); this._lipSync(); } } });
    m.draftBtn = h("button", { type: "button", class: "ghost", on: { click: () => this._render(3) } }, "Preview motion (draft)");
    m.finalBtn = h("button", { type: "button", class: "go", on: { click: () => this._render(4) } }, "Render final + sound");
    m.allDraft = h("button", { type: "button", class: "ghost", title: "Queue a draft for every shot, each from its own chosen frame",
      on: { click: () => this._render(3, true) } }, "Draft every shot");
    m.allFinal = h("button", { type: "button", class: "ghost", title: "Queue a final with sound for every shot that doesn't have one yet",
      on: { click: () => this._render(4, true) } }, "Final for every shot");
    m.status = h("div", { class: "status" });
    m.frame = h("img", { class: "clay", alt: "chosen frame" });
    m.video = h("video", { controls: "", loop: "", muted: "", playsinline: "" });
    m.video.muted = true;   // the attribute alone doesn't mute a video created in script; unmute with its controls
    v.append(
      h("h3", {}, "⑤ Motion: animate it with LTX-2.5"),
      h("p", { class: "lede" }, "LTX follows your clay animation (positions, camera, timing) and paints it in the style of your chosen frame. Pick a shot below, or render them all."),
      this._shotRow("motion"),
      h("div", { class: "two" },
        h("div", { class: "card" }, h("div", { class: "status" }, "Starts from your frame"), m.frame),
        h("div", { class: "card" },
          h("label", { class: "f" }, "Video model", m.engine),
          m.h3Box,
          h("label", { class: "f" }, h("span", { class: "row" }, "Motion freedom", m.freeOut), m.freedom),
          h("div", { class: "row" }, h("span", { class: "status" }, "Quality"), m.qSeg),
          h("details", {}, h("summary", { class: "status", style: "cursor:pointer" }, "Advanced: steps, CFG, sampler"),
            h("div", { class: "row" }, h("label", { class: "row status" }, "CFG", m.cfg), h("label", { class: "row status" }, "Sampler", m.sampler)),
            h("label", { class: "f" }, "Negative prompt", m.neg),
            m.sampNote),
          h("label", { class: "f" }, "Sound (generated with the final)", m.sfx),
          h("div", { class: "row" }, m.music, m.line),
          h("div", { class: "status" }, "Music ideas"), m.musicIdeas,
          h("div", { class: "status" }, "Line ideas"), m.lineIdeas,
          h("label", { class: "row status" }, m.audio, "Let the sound/dialogue drive the video"),
          h("div", { class: "row" }, m.draftBtn, m.finalBtn),
          h("div", { class: "row" }, m.allDraft, m.allFinal))),
      m.castCard = h("div", { class: "card" }),
      m.status,
      h("div", { class: "card" }, m.vidCap = h("div", { class: "status" }, "Latest result for this shot"), m.video),
      h("div", { class: "row" }, h("span", { style: "flex:1" }), this._next("⑥ Review on the Ladder", "review")),
    );
    return v;
  }

  _motionNote() {
    const m = this.m;
    const steps = m.quality === "Draft" ? "8 + 3" : "18 + 12";
    const cfg = +m.cfg.value || 1;
    m.sampNote.textContent = `${m.quality}: ${steps} steps (render + upscale pass), CFG ${cfg}. LTX-2.5 here is the distilled model: ` +
      "CFG 1 is its tuned setting" + (cfg > 1 ? "; above 1 doubles render time and can over-sharpen." : ". Quality sets the steps.");
  }

  _freeLabel() {
    const f = +this.m.freedom.value;
    return f < 0.15 ? "exact: copies the clay motion" : f <= 0.55 ? "natural (recommended): real weight, same blocking" : "loose: more invention, framing may drift";
  }

  _refreshMotion() {
    const m = this.m;
    if (!m.engine.options.length) {
      m.engine.append(new Option("LTX-2.5 Layout-to-Render (local, follows your clay; recommended)", VIDEO_L2R));
      const vals = this.w(9083, "model")?.options?.values || [];
      for (const val of (Array.isArray(vals) ? vals : [])) {
        const key = typeof val === "string" ? val : val?.key;
        if (key) m.engine.append(new Option(isH3(key) ? H3_LABEL : key.replace(" · local", " (local, image → video)").replace(/ \[[^\]]*\]$/, ""), key));
      }
    }
    m.engine.value = this.w(9084, "switch")?.value ? (this.w(9083, "model")?.value || VIDEO_L2R) : VIDEO_L2R;
    if (!m.engine.value) m.engine.value = VIDEO_L2R;   // a saved picker model that isn't installed here
    m.h3Ref.checked = this.w(9083, "model.motion_ref")?.value === H3_CLAY_REF;
    this._showEngine();
    this._drawRefs();
    this._drawShotCast();
    m.cfg.value = String(this.w(5516, "cfg")?.value ?? 1);
    m.sampler.value = this.w(5516, "sampler_name")?.value || "euler_ancestral";
    m.neg.value = this.w(5509, "value")?.value || "";
    this._motionNote();
    const fr = this.w(9096, "motion_freedom")?.value;
    if (fr != null) m.freedom.value = String(fr);
    m.freeOut.textContent = this._freeLabel();
    m.audio.checked = !!this.w(9092, "enabled")?.value;
    // Sound: suggest effects from what is on stage when the field is empty, so the final always has sound.
    const sfxW = this.w(9087, "sfx_prompt");
    if (sfxW && !String(sfxW.value || "").trim()) this.set(9087, "sfx_prompt", suggestSfx(this.ctx.stage.toJSON()));
    m.sfx.value = this.w(9087, "sfx_prompt")?.value || "";
    m.music.value = this.w(9087, "music_mood")?.value || "";
    m.line.value = this.w(9087, "line")?.value || "";
    const r = this.ctx.getRenders(this.ctx.stage.activeShot().id) || {};
    const chosen = this.chosen?.[this.ctx.stage.activeShot().id];
    m.frame.src = chosen?.url || r.look || "";
    m.frame.hidden = !m.frame.src;
    const vid = r.final_sound || r.final || r.final_audio || r.draft || r.previz || "";
    if (vid && m.video.getAttribute("src") !== vid) { m.video.src = vid; m.video.play?.().catch(() => {}); }
    if (!vid) { m.video.removeAttribute("src"); m.video.load?.(); }
    m.vidCap.textContent = `Latest result for ${this.ctx.stage.activeShot().name}`;
    this._drawShotRows();
  }

  _applyVideo() {
    const m = this.m;
    const l2r = m.engine.value === VIDEO_L2R;
    this.set(9084, "switch", !l2r);
    if (!l2r) this.set(9083, "model", m.engine.value);
    if (isH3(m.engine.value)) this.set(9083, "model.motion_ref", m.h3Ref.checked ? H3_CLAY_REF : "off");
    this._showEngine();
    this._drawShotCast();
    this.set(9096, "motion_freedom", +m.freedom.value);
    this.set(9096, "quality", m.quality);
  }

  /** This shot's H3 reference images: thumbnails with a remove button. */
  _drawRefs() {
    const m = this.m, sid = this.ctx.stage.activeShot().id, c = this.chosen[sid] || {};
    const refs = c.refs || [];
    m.h3Refs.replaceChildren(...refs.map((r, i) => h("span", { style: "position:relative;display:inline-block" },
      h("img", { src: r.url || "", alt: `Picture ${i + 2}`, title: `<Picture ${i + 2}>`, style: "height:56px;border-radius:6px;display:block" }),
      h("button", { type: "button", class: "ghost", title: "Remove", style: "position:absolute;top:-6px;right:-6px;padding:0 6px;font-size:11px",
        on: { click: () => { c.refs = refs.filter((_, j) => j !== i); this._saveChosen(); this._drawRefs(); } } }, "×"))));
    m.h3RefIn.disabled = refs.length >= H3_MAX_REFS;
    m.h3Last.textContent = loadName(c.last) ? "Ends on this shot's chosen last frame (first + last frame)." : "";
  }

  async _addRefs(fileList) {
    const sid = this.ctx.stage.activeShot().id;
    const c = this.chosen[sid] = this.chosen[sid] || {};
    c.refs = c.refs || [];
    const api = this.ctx.api;
    for (const f of [...(fileList || [])].slice(0, Math.max(0, H3_MAX_REFS - c.refs.length))) {
      try {
        const body = new FormData();
        body.append("image", f);
        body.append("type", "input");
        body.append("subfolder", "soundstage_refs");
        const r = await api.fetchApi("/upload/image", { method: "POST", body });
        if (r.status !== 200) throw new Error(`upload failed (${r.status})`);
        const j = await r.json();
        const file = { filename: j.name, subfolder: j.subfolder || "", type: j.type || "input" };
        const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
        c.refs.push({ file, url: api.apiURL ? api.apiURL(`/view?${q}`) : `/view?${q}` });
      } catch (e) { this.m.status.textContent = `Couldn't add ${f.name}: ${e.message}`; }
    }
    this.m.h3RefIn.value = "";
    this._saveChosen();
    this._drawRefs();
  }

  _saveChosen() { this.ctx.saveChosen?.({ chosen: this.chosen, touched: this.touched }); }

  _showEngine() {
    const m = this.m, h3 = isH3(m.engine.value);
    m.h3Box.hidden = !h3;
    m.draftBtn.textContent = h3 ? "Preview motion (LTX draft)" : "Preview motion (draft)";
  }

  /** H3 makes its own sound: hand it the sound fields and keep the Soundstage mix (and the LTX audio-driven
   *  final) out of this queue, so the H3 final with its own audio is the one that lands. Restored afterwards. */
  async _queueVideo(step) {
    if (step !== 4 || !isH3(this.m.engine.value)) return this.queueAt(step);
    const keep = { sfx: this.w(9087, "sfx_prompt")?.value, music: this.w(9087, "music_mood")?.value,
      line: this.w(9087, "line")?.value, driven: this.w(9092, "enabled")?.value };
    this.set(9083, "sound", keep.sfx || "");
    this.set(9083, "music", keep.music || "");
    this.set(9083, "line", keep.line || "");
    for (const k of ["sfx_prompt", "music_mood", "line"]) this.set(9087, k, "");
    this.set(9092, "enabled", false);
    try { return await this.queueAt(step); } finally {
      this.set(9087, "sfx_prompt", keep.sfx ?? "");
      this.set(9087, "music_mood", keep.music ?? "");
      this.set(9087, "line", keep.line ?? "");
      if (keep.driven != null) this.set(9092, "enabled", keep.driven);
    }
  }

  /** A spoken line must drive the video (LTX audio-driven, audio latent mask 0.3), or the voice is pasted over a
   *  mouth that never heard it. Typing a line turns it on; the checkbox can still turn it off on purpose. */
  _lipSync() {
    const line = (this.w(9087, "line")?.value || "").trim();
    if (line && !this.w(9092, "enabled")?.value) {
      this.set(9092, "enabled", true);
      if (this.m?.audio) this.m.audio.checked = true;
      this._say?.("Lip sync on: the final is driven by the line, so the mouth follows the words.");
    }
  }

  async _render(step, allShots = false) {
    const m = this.m;
    this._applyVideo();
    if (step === 4 && !isH3(m.engine?.value)) this._lipSync();
    const h3 = step === 4 && isH3(m.engine.value);
    const each = h3 ? "about 20–30 min" : step === 3 ? "about 2–4 min" : "about 4–6 min";
    const btns = [m.draftBtn, m.finalBtn, m.allDraft, m.allFinal];
    for (const b of btns) b.disabled = true;
    try {
      if (!allShots) {
        this._applyShot(this.ctx.stage.activeShot().id);
        await this._queueVideo(step);
        m.status.textContent = step === 3
          ? "Draft queued: about 2–4 min warm. It appears below and on the Ladder."
          : h3 ? "MiniMax H3 final queued: about 20–30 min (picture + its own sound). It appears below and on the Ladder."
          : "Final queued: about 4–6 min warm (upscale + sound). It appears below and on the Ladder.";
      } else {
        const has = (sid) => { const r = this.ctx.getRenders(sid) || {}; return step === 3 ? !!r.draft : !!(r.final_sound || r.final_audio || r.final); };
        const todo = this.shots().filter((s) => !has(s.id));
        if (!todo.length) { m.status.textContent = `Every shot already has a ${step === 3 ? "draft" : "final"}. Pick a shot and use the buttons above to redo one.`; return; }
        const noFrame = todo.filter((s) => !this.chosen[s.id]).map((s) => s.name);
        await this.forEachShot(async (s, i) => {
          m.status.textContent = `Queueing ${step === 3 ? "draft" : "final"} ${i + 1}/${todo.length}: ${s.name} (capturing the stage)…`;
          this._applyShot(s.id);
          await this._queueVideo(step);
        }, todo);
        m.status.textContent = `${todo.length} ${step === 3 ? "draft" : "final"}${todo.length > 1 ? "s" : ""} queued, one after another (${each} each). Each lands on its shot.` +
          (noFrame.length ? ` No frame chosen yet for ${noFrame.join(", ")}: those paint a new one.` : "");
      }
    } catch (e) {
      m.status.textContent = `Couldn't queue: ${e.message}`;
    } finally {
      for (const b of btns) b.disabled = false;
    }
  }

  // ------------------------------------------------------------------ shots
  /** The scene's shots, in cut order (shots not in the cut follow). */
  shots() {
    const all = this.ctx.shots?.() || [this.ctx.stage.activeShot()];
    return all.filter(Boolean);
  }

  /** Run fn for each shot with it active on stage (each queued prompt captures its own shot), then go back. */
  async forEachShot(fn, list = this.shots()) {
    const prev = this.ctx.stage.activeShot().id;
    this.ctx.setBatch?.(true);
    try {
      for (const [i, s] of list.entries()) {
        this.ctx.stage.setActiveShot(s.id);
        await fn(s, i);
      }
    } finally {
      this.ctx.stage.setActiveShot(prev);
      this.ctx.setBatch?.(false);
      this._applyShot(prev);
      this._drawShotRows();
    }
  }

  /** Point the still model, seed and touch-up switch at this shot's chosen frame, so its video starts from it. */
  _applyShot(sid) {
    const c = this.chosen[sid];
    if (c?.model) {
      const krea = c.model === STILL_KREA;
      this.set(9082, "switch", !krea);
      if (!krea) this.set(9081, "model", c.model);
    }
    if (c?.seed != null) this.set(c.seedNode || 9056, "seed", c.seed);
    this.set(9086, "switch", !!this.touched[sid]);
    if (this.touched[sid] && c?.edited) setTouchupStill(this.ctx.app, c.edited);   // each shot keeps its own painted frame
    this.set(9083, "last_file", loadName(c?.last));
    // The image picker gets the references the chosen frame was painted with (so it comes back from cache);
    // a shot without a chosen frame gets its "Cast in this shot" picks.
    const P = this._shotPool();
    if (c?.refFiles != null && this.w(9081, "ref_files")) this.set(9081, "ref_files", c.refFiles);
    else if (c?.seed != null && !c.edited && this.w(9081, "ref_files")) this.set(9081, "ref_files", this._legacyRefLines());   // a frame from before per-shot cast
    else this._applyShotCast(sid, P);
    const manual = (c?.refs || []).map(loadName).filter(Boolean);
    const h3 = !!this.w(9084, "switch")?.value && isH3(this.w(9083, "model")?.value);
    const cast = h3 ? pickRefs(P.pool, this._shotCastKeys(sid, P), Math.max(0, H3_MAX_REFS - manual.length)).use.map((it) => it.ref) : [];
    this.set(9083, "ref_files", [...new Set([...cast, ...manual])].join("\n"));
  }

  _setChosen(sid, c) {
    this.chosen[sid] = { ...this.chosen[sid], url: c.url, file: c.file, seed: c.seed, model: c.model, seedNode: c.seedNode, edited: c.edited || undefined,
      refFiles: c.refFiles };
    if (c.file) this.ctx.rememberRender?.(sid, "look", c.file);
    this.ctx.saveChosen?.({ chosen: this.chosen, touched: this.touched });
  }

  _loadChosen() {
    const saved = this.ctx.loadChosen?.() || {};
    this.chosen = { ...(saved.chosen || {}), ...this.chosen };
    this.touched = { ...(saved.touched || {}), ...this.touched };
    this._drawShotRows();
  }

  selectShot(id) {
    if (id !== this.ctx.stage.activeShot().id) this.ctx.stage.setActiveShot(id);
    this._applyShot(id);
    if (this.current === "frame") this._refreshFrame();
    else if (this.current === "motion") this._refreshMotion();
    else if (this.current === "review") this.restoreLadder();
    this.mark(this.current);
    this._drawShotRows();
  }

  _shotRow(where) {
    const row = h("div", { class: "ss-shotrow", "data-where": where });
    this.shotRows.push({ row, where });
    return row;
  }

  _shotState(where, sid) {
    const r = this.ctx.getRenders(sid) || {};
    const busy = [...this.inflight.values()].filter((x) => x.sid === sid);
    const fin = r.final_sound || r.final_audio || r.final;
    if (where === "frame") {
      if (busy.some((x) => x.step === 2)) return ["busy", "painting…"];
      if (this.chosen[sid]) return ["ok", "✓ frame chosen"];
      const n = this.candidates[sid]?.length || 0;
      return n ? ["", `${n} to pick from`] : ["", r.look ? "has a frame" : "no frame yet"];
    }
    if (busy.some((x) => x.step >= 3)) return ["busy", busy.some((x) => x.step >= 4) ? "rendering final…" : "rendering draft…"];
    if (where === "deliver" && busy.some((x) => x.step === 5)) return ["busy", "making layers…"];
    if (fin) return ["ok", "✓ final"];
    if (r.draft) return ["", "draft only"];
    return ["", this.chosen[sid] || r.look ? "frame ✓, no video" : "nothing yet"];
  }

  _drawShotRows() {
    if (!this.shotRows?.length) return;
    const act = this.ctx.stage.activeShot().id;
    // The host may list more than the stage holds (a script's "All scenes": every scene's shots, each with its scene
    // label). A shot that is not on the stage (live === false) opens its scene through ctx.openShot when picked.
    const shots = this.ctx.rowShots?.() || this.shots();
    this._thumbs = this._thumbs || {};
    for (const { row, where } of this.shotRows) {
      const cards = shots.map((s, i) => {
        const r = this.ctx.getRenders(s.id) || {};
        const pic = this.chosen[s.id]?.url || r.look;
        const away = s.live === false;
        let thumb;
        if (pic) thumb = h("img", { src: pic, alt: "" });
        else {
          thumb = h("canvas", { width: "185", height: "100" });
          try {
            const c = away ? null : this.ctx.renderPreviewFrame?.(s.id, 0);
            if (c) thumb.getContext("2d").drawImage(c, 0, 0, 185, 100);
          } catch { /* stage not ready */ }
        }
        const [cls, txt] = this._shotState(where, s.id);
        const name = s.scene ? `${s.scene} · ${s.name}` : `${i + 1}. ${s.name}`;
        return h("button", { type: "button", class: "shot", "aria-pressed": String(s.id === act), title: away ? `Open ${name} (switches the stage to its scene)` : `Work on ${name}`,
          on: { click: () => (away ? this.ctx.openShot?.(s.id) : this.selectShot(s.id)) } },
          thumb, h("span", { class: "nm" }, name), h("span", { class: `st ${cls}` }, txt));
      });
      row.replaceChildren(h("span", { class: "lbl" }, shots.length > 1 ? `${shots.length} shots` : "1 shot"), ...cards);
    }
  }

  // ------------------------------------------------------------------ ⑦ Deliver
  _deliverView() {
    const v = h("section", { class: "ss-pipeview ss-deliverview", hidden: "" });
    const status = h("div", { class: "status" });
    this.dStatus = status;
    this.dLinks = h("div", { class: "row" });
    const mk = (label, lede, btn, fn) => h("div", { class: "card" }, h("strong", {}, label), h("p", { class: "lede" }, lede),
      h("div", { class: "row" }, h("button", { type: "button", class: "go", on: { click: fn } }, btn)));
    v.append(
      h("h3", {}, "⑦ Deliver"),
      h("p", { class: "lede" }, "Hand the shot to post, or the whole cut to an editor. The Layer Pack is for the shot picked below."),
      this._shotRow("deliver"),
      mk("Layer Pack for VFX", "One layer per actor with mattes cut from the final frames (SAM 3.1 + BiRefNet edges), depth, the camera, and builders for After Effects, Nuke, Resolve, Blender and Photoshop.",
        "Make the Layer Pack", async () => { this._applyShot(this.ctx.stage.activeShot().id); await this.queueAt(5); status.textContent = `Layer Pack queued for ${this.ctx.stage.activeShot().name}: the final is reused from cache, then about 1 min for the mattes.`; }),
      h("div", { class: "row" }, h("button", { type: "button", class: "ghost", on: { click: async () => {
        const fin = (sid) => { const r = this.ctx.getRenders(sid) || {}; return !!(r.final_sound || r.final_audio || r.final); };
        const list = this.shots().filter((s) => fin(s.id));
        if (!list.length) { status.textContent = "No shot has a final yet: render them in ⑤ Motion first."; return; }
        await this.forEachShot(async (s) => { this._applyShot(s.id); await this.queueAt(5); }, list);
        status.textContent = `${list.length} Layer Pack${list.length > 1 ? "s" : ""} queued (${list.map((s) => s.name).join(", ")}).`;
      } } }, "Layer Packs for every shot with a final")),
      this.dLinks,
      mk("The cut as one video", "Every shot in the strip, trimmed and in order, with sound. Shots without a Final are rendered first if you choose so.",
        "Cut → one video", () => this.ctx.flattenCut()),
      h("div", { class: "row" }, h("button", { type: "button", class: "ghost", on: { click: () => this.ctx.renderMissing() } }, "Render missing shots first"),
        h("button", { type: "button", class: "ghost", on: { click: () => this.ctx.showView("cut") } }, "Open the editor (Avid / Premiere / Resolve / FCP / OTIO)")),
      status,
    );
    return v;
  }

  /** The Layer Pack download links, mirrored into Deliver. */
  showPack(nodes) { this.dLinks.replaceChildren(...nodes); }
}
