// The guided pipeline: ① Set → ② Frame → ③ Motion → ④ Review → ⑤ Deliver.
// A step bar over the stage, plus three new views (Frame, Motion, Deliver) that drive the App graph's own widgets
// (the step gate, the look-still sampler, the model pickers, Quality) so the user never touches raw switches.
// Every view ends with one "Next →" button. Renders come back per shot and land on the Ladder (④ Review).
import { icon } from "../ui/icons.mjs";

const STEPS = [
  { k: "set", n: 1, label: "Set", view: "stage", hint: "Block the scene in 3D: cast, camera, timing." },
  { k: "frame", n: 2, label: "Frame", view: "frame", hint: "Paint the first frame from your clay with an image model." },
  { k: "motion", n: 3, label: "Motion", view: "motion", hint: "Animate it with LTX, following your blocking." },
  { k: "review", n: 4, label: "Review", view: "ladder", hint: "Scrub clay → frame → draft → final on the Ladder." },
  { k: "deliver", n: 5, label: "Deliver", view: "deliver", hint: "Layers for VFX, the cut as one video, NLE export." },
];
const STILL_KREA = "__krea_depth__";
const VIDEO_L2R = "__ltx_l2r__";

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
    if (pid) { this.inflight.set(pid, { sid: this.ctx.stage.activeShot().id, step }); this._drawShotRows(); }
    this.ctx.app.graph.setDirtyCanvas(true);
    return r;
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
    const done = { set: !!r.previz, frame: !!r.look, motion: !!(r.final || r.final_sound || r.draft), review: !!(r.final || r.final_sound),
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

  // ------------------------------------------------------------------ ② Frame
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
    v.append(
      h("h3", {}, "② Frame: paint the first frame from your clay"),
      h("p", { class: "lede" }, "The image model keeps your blocking (layout, camera, who stands where) and adds the photography. Generate a few, pick one, and the video starts from it. Every shot gets its own frame: pick a shot below."),
      this._shotRow("frame"),
      h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, "Style"),
        h("span", { class: "status" }, "One click sets film stock, lens, palette and grade for a genre or movement (★ = suggested).")),
        f.styleHost = h("div")),
      h("div", { class: "card" }, h("div", { class: "row" }, h("strong", {}, "Camera"),
        h("span", { class: "status" }, "Body, lens, focal length and aperture: what the frame is shot on. Same as the Look tab.")),
        f.gearHost = h("div")),
      h("div", { class: "two" },
        h("div", { class: "card" }, f.clayCap = h("div", { class: "status" }, "Your clay, frame 1"), f.clay),
        h("div", { class: "card" },
          h("label", { class: "f" }, "Image model", f.model),
          h("label", { class: "f" }, h("span", { class: "row" }, "Follow the clay", f.followOut), f.follow),
          h("label", { class: "f" }, "Describe the frame (shared with the Look tab)", f.desc),
          h("div", { class: "row" }, h("span", { class: "status" }, "Variations"), f.countSeg, f.goBtn, f.allBtn)),
      ),
      f.status,
      f.grid,
      h("div", { class: "row" }, f.touch, h("label", { class: "row status" }, f.useTouch, "Use my touched-up frame"),
        h("span", { style: "flex:1" }), this._next("③ Animate this frame", "motion")),
    );
    return v;
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
    const dn = this.w(9056, "denoise")?.value;
    if (dn != null) f.follow.value = String(dn);
    f.followOut.textContent = this._followLabel();
    f.desc.value = this.ctx.look?.state?.description || "";
    const sid = this.ctx.stage.activeShot().id;
    f.useTouch.checked = !!this.touched[sid];
    this.set(9086, "switch", f.useTouch.checked);
    f.clayCap.textContent = `${this.ctx.stage.activeShot().name}: your clay, frame 1`;
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
    const krea = f.model.value === STILL_KREA;
    this.set(9082, "switch", !krea);
    if (!krea) this.set(9081, "model", f.model.value);
    this.set(9056, "denoise", +f.follow.value);
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
      for (let i = 0; i < f.count; i++) {
        const seed = base + i * 7919;
        this.set(seedNode, "seed", seed);
        f.status.textContent = `Queueing ${n > 1 ? `${shot.name} (${si + 1}/${n}), ` : ""}frame ${i + 1}/${f.count}${i === 0 ? " (the first one renders the clay passes too)" : ""}…`;
        await this.queueAt(2, { seed, model: f.model.value, seedNode });
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
      const cand = { url: ev.url, file: ev.file, seed: meta?.seed, model: meta?.model, seedNode: meta?.seedNode };
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
    f.grid.replaceChildren(...list.map((c) => {
      const isChosen = chosen && chosen.url === c.url;
      return h("div", { class: "cand", "data-chosen": String(!!isChosen), title: c.seed != null ? `seed ${c.seed}` : "",
        on: { click: () => this.choose(c) } },
        h("img", { src: c.url, alt: "candidate frame" }),
        h("div", { class: "cap" }, h("span", {}, (c.model === STILL_KREA || !c.model) ? "Krea 2" : String(c.model).split(" ·")[0]),
          h("span", { class: "pill" }, isChosen ? "✓ Chosen" : "Use this frame")));
    }));
  }

  /** Pick a candidate: lock its model + seed so the next steps reproduce exactly this frame (from cache). */
  choose(c) {
    const sid = this.ctx.stage.activeShot().id;
    this._setChosen(sid, c);
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
    this.f.status.textContent = "Frame chosen. Next: ③ Animate this frame.";
    this.mark("frame");
  }

  // ------------------------------------------------------------------ ③ Motion
  _motionView() {
    const v = h("section", { class: "ss-pipeview ss-motionview", hidden: "" });
    this.m = {};
    const m = this.m;
    m.engine = h("select", { on: { change: () => this._applyVideo() } });
    m.freedom = h("input", { type: "range", min: "0", max: "0.8", step: "0.05", value: "0.5",
      on: { input: () => { m.freeOut.textContent = this._freeLabel(); this._applyVideo(); } } });
    m.freeOut = h("span", { class: "status" });
    m.quality = "Draft";
    m.qSeg = h("span", { class: "seg row" }, ...["Draft", "Final HQ"].map((q) => h("button", { type: "button", "aria-pressed": String(q === "Draft"),
      title: q === "Draft" ? "8 + 3 distilled steps: fast previews" : "18 + 12 steps on the same curve: finer detail and steadier motion, about 2x slower",
      on: { click: (e) => { m.quality = q; for (const b of m.qSeg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget)); this._applyVideo(); } } }, q)));
    m.audio = h("input", { type: "checkbox", on: { change: () => this.set(9092, "enabled", m.audio.checked) } });
    m.sfx = h("textarea", { placeholder: "Sound effects: hooves galloping on packed dirt, wind…", style: "min-height:44px",
      on: { change: () => this.set(9087, "sfx_prompt", m.sfx.value) } });
    m.music = h("input", { type: "text", placeholder: "Music mood (optional): tense western strings", style: "background:#1a1420;color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 9px",
      on: { change: () => this.set(9087, "music_mood", m.music.value) } });
    // One-click suggestions: a click fills the field (and the node), the user can still edit it.
    const chips = (field, key, list) => h("div", { class: "row", style: "flex-wrap:wrap;gap:6px" }, ...list.map((t) =>
      h("button", { type: "button", class: "ghost", style: "font-size:12px;padding:3px 9px", title: `Use: ${t}`,
        on: { click: () => { m[field].value = t; this.set(9087, key, t); } } }, t)));
    m.musicIdeas = chips("music", "music_mood", ["tense western strings", "pulsing synth chase", "eerie horror drones",
      "warm romantic piano", "epic orchestral sci-fi", "1970s funk heist groove", "lonely solo cello", "upbeat indie road-trip guitar"]);
    m.lineIdeas = chips("line", "line", ["We're not alone.", "Drive. Don't look back.", "Did you hear that?", "I'd follow you anywhere."]);
    m.line = h("input", { type: "text", placeholder: "Dialogue line (optional)", style: "background:#1a1420;color:inherit;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 9px",
      on: { change: () => this.set(9087, "line", m.line.value) } });
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
      h("h3", {}, "③ Motion: animate it with LTX-2.5"),
      h("p", { class: "lede" }, "LTX follows your clay animation (positions, camera, timing) and paints it in the style of your chosen frame. Pick a shot below, or render them all."),
      this._shotRow("motion"),
      h("div", { class: "two" },
        h("div", { class: "card" }, h("div", { class: "status" }, "Starts from your frame"), m.frame),
        h("div", { class: "card" },
          h("label", { class: "f" }, "Video model", m.engine),
          h("label", { class: "f" }, h("span", { class: "row" }, "Motion freedom", m.freeOut), m.freedom),
          h("div", { class: "row" }, h("span", { class: "status" }, "Quality"), m.qSeg),
          h("label", { class: "f" }, "Sound (generated with the final)", m.sfx),
          h("div", { class: "row" }, m.music, m.line),
          h("div", { class: "status" }, "Music ideas"), m.musicIdeas,
          h("div", { class: "status" }, "Line ideas"), m.lineIdeas,
          h("label", { class: "row status" }, m.audio, "Let the sound/dialogue drive the video"),
          h("div", { class: "row" }, m.draftBtn, m.finalBtn),
          h("div", { class: "row" }, m.allDraft, m.allFinal))),
      m.status,
      h("div", { class: "card" }, m.vidCap = h("div", { class: "status" }, "Latest result for this shot"), m.video),
      h("div", { class: "row" }, h("span", { style: "flex:1" }), this._next("④ Review on the Ladder", "review")),
    );
    return v;
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
        if (key) m.engine.append(new Option(key.replace(" · local", " (local, image → video)").replace(/ \[[^\]]*\]$/, ""), key));
      }
    }
    m.engine.value = this.w(9084, "switch")?.value ? (this.w(9083, "model")?.value || VIDEO_L2R) : VIDEO_L2R;
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
    this.set(9096, "motion_freedom", +m.freedom.value);
    this.set(9096, "quality", m.quality === "Draft" ? "Draft" : "Final HQ");
  }

  async _render(step, allShots = false) {
    const m = this.m;
    this._applyVideo();
    const btns = [m.draftBtn, m.finalBtn, m.allDraft, m.allFinal];
    for (const b of btns) b.disabled = true;
    try {
      if (!allShots) {
        this._applyShot(this.ctx.stage.activeShot().id);
        await this.queueAt(step);
        m.status.textContent = step === 3
          ? "Draft queued: about 2–4 min warm. It appears below and on the Ladder."
          : "Final queued: about 4–6 min warm (upscale + sound). It appears below and on the Ladder.";
      } else {
        const has = (sid) => { const r = this.ctx.getRenders(sid) || {}; return step === 3 ? !!r.draft : !!(r.final_sound || r.final_audio || r.final); };
        const todo = this.shots().filter((s) => !has(s.id));
        if (!todo.length) { m.status.textContent = `Every shot already has a ${step === 3 ? "draft" : "final"}. Pick a shot and use the buttons above to redo one.`; return; }
        const noFrame = todo.filter((s) => !this.chosen[s.id]).map((s) => s.name);
        await this.forEachShot(async (s, i) => {
          m.status.textContent = `Queueing ${step === 3 ? "draft" : "final"} ${i + 1}/${todo.length}: ${s.name} (capturing the stage)…`;
          this._applyShot(s.id);
          await this.queueAt(step);
        }, todo);
        m.status.textContent = `${todo.length} ${step === 3 ? "draft" : "final"}${todo.length > 1 ? "s" : ""} queued, one after another (about ${step === 3 ? "2–4" : "4–6"} min each). Each lands on its shot.` +
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
  }

  _setChosen(sid, c) {
    this.chosen[sid] = { url: c.url, file: c.file, seed: c.seed, model: c.model, seedNode: c.seedNode };
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
    const shots = this.shots();
    this._thumbs = this._thumbs || {};
    for (const { row, where } of this.shotRows) {
      const cards = shots.map((s, i) => {
        const r = this.ctx.getRenders(s.id) || {};
        const pic = this.chosen[s.id]?.url || r.look;
        let thumb;
        if (pic) thumb = h("img", { src: pic, alt: "" });
        else {
          thumb = h("canvas", { width: "185", height: "100" });
          try {
            const c = this.ctx.renderPreviewFrame?.(s.id, 0);
            if (c) thumb.getContext("2d").drawImage(c, 0, 0, 185, 100);
          } catch { /* stage not ready */ }
        }
        const [cls, txt] = this._shotState(where, s.id);
        return h("button", { type: "button", class: "shot", "aria-pressed": String(s.id === act), title: `Work on ${s.name}`,
          on: { click: () => this.selectShot(s.id) } },
          thumb, h("span", { class: "nm" }, `${i + 1}. ${s.name}`), h("span", { class: `st ${cls}` }, txt));
      });
      row.replaceChildren(h("span", { class: "lbl" }, shots.length > 1 ? `${shots.length} shots` : "1 shot"), ...cards);
    }
  }

  // ------------------------------------------------------------------ ⑤ Deliver
  _deliverView() {
    const v = h("section", { class: "ss-pipeview ss-deliverview", hidden: "" });
    const status = h("div", { class: "status" });
    this.dStatus = status;
    this.dLinks = h("div", { class: "row" });
    const mk = (label, lede, btn, fn) => h("div", { class: "card" }, h("strong", {}, label), h("p", { class: "lede" }, lede),
      h("div", { class: "row" }, h("button", { type: "button", class: "go", on: { click: fn } }, btn)));
    v.append(
      h("h3", {}, "⑤ Deliver"),
      h("p", { class: "lede" }, "Hand the shot to post, or the whole cut to an editor. The Layer Pack is for the shot picked below."),
      this._shotRow("deliver"),
      mk("Layer Pack for VFX", "One layer per actor with mattes cut from the final frames (SAM 3.1 + BiRefNet edges), depth, the camera, and builders for After Effects, Nuke, Resolve, Blender and Photoshop.",
        "Make the Layer Pack", async () => { this._applyShot(this.ctx.stage.activeShot().id); await this.queueAt(5); status.textContent = `Layer Pack queued for ${this.ctx.stage.activeShot().name}: the final is reused from cache, then about 1 min for the mattes.`; }),
      h("div", { class: "row" }, h("button", { type: "button", class: "ghost", on: { click: async () => {
        const fin = (sid) => { const r = this.ctx.getRenders(sid) || {}; return !!(r.final_sound || r.final_audio || r.final); };
        const list = this.shots().filter((s) => fin(s.id));
        if (!list.length) { status.textContent = "No shot has a final yet: render them in ③ Motion first."; return; }
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
