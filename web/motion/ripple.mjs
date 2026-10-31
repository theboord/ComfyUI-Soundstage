// ⑤ Motion → Follow: Layout (the clay, default) · Pose (body + hands + face, experimental) · Ripple edit.
// Ripple edit: pick any clip (a draft, a final, an imported clip), "Edit first frame" opens its frame 1 in Paint Studio,
// "Ripple it" runs LTX-2.5 + the LTX Ripple IC-LoRA (SoundstageRipple) and the edit is carried through the whole clip
// with its motion, timing, camera and sound. The result lands as a new take on the shot (Takes, approvals, compare).
// Pure helpers are exported for tests (tests/js/ripple.test.mjs); RippleControls is the DOM part the pipeline mounts.

export const FOLLOW_MODES = [
  ["layout", "Layout", "Follow the clay: positions, camera and timing from your 3D blocking (default)"],
  ["pose", "Pose", "Experimental: an OpenPose skeleton of every clay actor (body, hands and face) drives LTX through the union-control IC-LoRA"],
  ["ripple", "Ripple edit", "Edit frame 1 of any clip in Paint Studio and Ripple carries the edit through the whole clip, keeping its motion and sound"],
];
export const RIPPLE_STRENGTH = 1.35;
// Imported footage, its edited frames and the Ripple results stay in their own folders (never the shared refs).
export const PRIVATE_DIR = "soundstage_private";

/** A /view URL (absolute or relative) -> ComfyUI's annotated file reference "sub/name.ext [type]". */
export function refFromViewUrl(url) {
  const u = String(url || "");
  const i = u.indexOf("?");
  if (i < 0 || !/\/view\?/.test(u)) return "";
  const q = new URLSearchParams(u.slice(i + 1));
  const fn = q.get("filename");
  if (!fn) return "";
  const sub = q.get("subfolder") || "";
  return `${sub ? sub + "/" : ""}${fn} [${q.get("type") || "output"}]`;
}

/** {filename, subfolder, type} or "sub/x [type]" -> annotated reference. */
export function refOf(f) {
  if (!f) return "";
  if (typeof f === "string") return /\[(input|output|temp)\]$/.test(f) ? f : `${f} [input]`;
  return f.filename ? `${f.subfolder ? f.subfolder + "/" : ""}${f.filename} [${f.type || "output"}]` : "";
}

/** Annotated reference -> /view query string (without the leading /view?). */
export function viewQuery(ref) {
  const m = /^(.*?)(?:\s*\[(input|output|temp)\])?$/.exec(String(ref || "").trim());
  const path = m?.[1] || "", type = m?.[2] || "input";
  const j = path.lastIndexOf("/");
  return new URLSearchParams({ filename: j < 0 ? path : path.slice(j + 1), subfolder: j < 0 ? "" : path.slice(0, j), type }).toString();
}

/**
 * The clips a shot can Ripple, best first: an imported clip set for Ripple, the final, the draft, the clip the scene
 * was rebuilt from (Video → Stage), earlier Ripple takes (edit an edit). [{key, label, ref, url}]
 */
export function rippleSources({ renders = {}, scene = null, chosen = null } = {}) {
  const out = [];
  const add = (key, label, ref, url) => { if (ref && !out.some((s) => s.ref === ref)) out.push({ key, label, ref, url: url || "" }); };
  const imp = chosen?.ripple?.clip;
  if (imp?.ref) add("import", `Imported clip · ${imp.name || imp.ref.replace(/ \[\w+\]$/, "").split("/").pop()}`, imp.ref, imp.url);
  const fin = renders.final_sound || renders.final_audio || renders.final;
  if (fin) add("final", "This shot's final", refFromViewUrl(fin), fin);
  if (renders.draft) add("draft", "This shot's draft", refFromViewUrl(renders.draft), renders.draft);
  const v = scene?.reference?.video;
  if (v) add("reference", `The clip this scene was rebuilt from · ${String(v).split("/").pop()}`, refOf(String(v)), "");
  const takes = Array.isArray(chosen?.takes) ? chosen.takes : [];
  takes.filter((t) => t?.ripple && t.file).slice().reverse()
    .forEach((t, i) => add(`take_${t.id || i}`, `Ripple take ${t.n || takes.length - i} (edit it again)`, refOf(t.file), t.url));
  return out;
}

/** The API prompt for one Ripple render: SoundstageRipple -> SaveVideo. */
export function buildRipplePrompt({ source, edited, prompt = "", strength = RIPPLE_STRENGTH, quality = "Draft", seed = 7,
  maxFrames = 161, colorMatch = "off", keepAudio = true, prefix = `${PRIVATE_DIR}/ripple` }) {
  if (!source) throw new Error("pick a clip to Ripple");
  if (!edited) throw new Error("edit frame 1 first (Edit first frame)");
  return {
    1: { class_type: "SoundstageRipple", inputs: { source, edited_frame: edited, prompt: String(prompt || ""),
      edit_strength: +(+strength).toFixed(2), quality: quality === "Final" ? "Final" : "Draft", seed: Math.max(0, Math.floor(+seed || 0)),
      max_frames: Math.max(9, Math.floor(+maxFrames || 161)), color_match: colorMatch, keep_audio: !!keepAudio } },
    2: { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: prefix, format: "mp4", "format.codec": "h264" } },
  };
}

/** A finished render -> a take record kept on the shot (pipeline.chosen[sid].takes; the Takes bin reads it). */
export function makeTake({ file, url, quality = "Draft", strength = RIPPLE_STRENGTH, source = "", edited = "", prompt = "",
  follow = "ripple", now = Date.now() }) {
  const kind = quality === "Final" ? "final" : "draft";
  return { id: `${follow}_${now.toString(36)}`, kind, url, file, created: now, label: follow === "pose" ? "Pose" : "Ripple",
    [follow]: true, ...(follow === "ripple" ? { strength: +(+strength).toFixed(2), source, edited } : {}), prompt };
}

/** Append a take to a shot's chosen record (mutates and returns it). */
export function addTake(chosen, take) {
  const c = chosen || {};
  c.takes = [...(Array.isArray(c.takes) ? c.takes : []), take].slice(-40);
  return c;
}

export function strengthLabel(v) {
  const s = +v;
  return `${s.toFixed(2)}${Math.abs(s - RIPPLE_STRENGTH) < 0.001 ? " (recommended)" : s > RIPPLE_STRENGTH ? " · carries harder" : " · gentler"}`;
}

// ------------------------------------------------------------------------------------------------ DOM

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  if (/^(button|input|select|textarea)$/.test(tag)) e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  return e;
};

const CSS = `
.ss-follow { display:flex; flex-direction:column; gap:8px; }
.ss-follow .seg { display:flex; gap:4px; flex-wrap:wrap; }
.ss-follow .seg button { flex:1 1 auto; }
.ss-follow .exp { font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:#ffb35c; margin-left:4px; }
.ss-ripple { display:flex; flex-direction:column; gap:8px; }
.ss-ripple .thumbs { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.ss-ripple .thumbs figure { margin:0; display:flex; flex-direction:column; gap:3px; }
.ss-ripple .thumbs img { width:100%; aspect-ratio:auto; max-height:150px; object-fit:contain; background:#0d0a10; border-radius:8px; display:block; }
.ss-ripple .thumbs figcaption { font-size:11px; color:var(--ss-muted,#a9a3ad); }
.ss-ripple select, .ss-ripple input[type=text] { background:#1a1420; color:var(--ss-text,#f0efed); border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:6px 8px; font:inherit; min-width:0; }
.ss-ripple .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ss-ripple label.f { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ss-muted,#a9a3ad); }
.ss-ripple-cmp { position:relative; width:100%; border-radius:12px; overflow:hidden; background:#000; }
.ss-ripple-cmp video { width:100%; display:block; }
.ss-ripple-cmp video.top { position:absolute; inset:0; height:100%; object-fit:contain; }
.ss-ripple-cmp .line { position:absolute; top:0; bottom:0; width:2px; background:var(--ss-accent,#F2FF59); pointer-events:none; }
.ss-ripple-cmp .tag { position:absolute; top:8px; font-size:11px; font-weight:700; color:#fff; text-shadow:0 1px 2px #000; }
.ss-ripple-cmp input[type=range] { position:absolute; left:0; right:0; bottom:6px; width:96%; margin:0 2%; }
.ss-clmedia > .ss-ripple-cmp:not([hidden]) { position:absolute; inset:0; z-index:2; border-radius:10px; }
.ss-clmedia > .ss-ripple-cmp video { height:100%; object-fit:contain; }
`;

function ensureCss() {
  if (document.getElementById("ss-ripple-css")) return;
  document.head.append(h("style", { id: "ss-ripple-css" }, CSS));
}

/** Frame 1 of a video URL as a PNG data URL (the start of what Ripple edits). */
export function firstFrameDataURL(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    const fail = () => reject(new Error("the clip didn't load in the browser"));
    const t = setTimeout(fail, 30000);
    v.addEventListener("error", () => { clearTimeout(t); fail(); });
    v.addEventListener("loadeddata", () => { try { v.currentTime = 0; } catch { /* already there */ } });
    v.addEventListener("seeked", () => {
      clearTimeout(t);
      try {
        const c = document.createElement("canvas");
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        resolve(c.toDataURL("image/png"));
      } catch (e) { reject(e); }
    }, { once: true });
    v.src = url;
  });
}

/**
 * The Follow chooser and the Ripple controls inside ⑤ Motion. host = the pipeline (chosen, ctx, _saveChosen, m).
 * Elements: el (Follow card for the side panel), rippleBtn (for the bottom bar), editHost (Paint Studio over the canvas),
 * compare (before / after wipe over the canvas).
 */
export class RippleControls {
  constructor(pipe) {
    ensureCss();
    this.p = pipe;
    this.mode = "layout";
    this.quality = () => pipe.m?.quality === "Draft" ? "Draft" : "Final";
    this.seg = h("div", { class: "seg row" }, ...FOLLOW_MODES.map(([k, t, tip]) => h("button", { type: "button", "data-follow": k,
      "aria-pressed": String(k === "layout"), title: tip, on: { click: () => this.setMode(k) } }, t, k === "pose" ? h("span", { class: "exp" }, "exp") : null)));
    this.note = h("div", { class: "status" });
    this.source = h("select", { "aria-label": "Clip to Ripple", on: { change: () => this._pickSource() } });
    this.upload = h("input", { type: "file", accept: "video/*", hidden: true, on: { change: (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) this.importClip(f); } } });
    this.uploadBtn = h("button", { type: "button", class: "ghost", title: "Use a clip from your computer", on: { click: () => this.upload.click() } }, "Upload a clip…");
    this.srcImg = h("img", { alt: "Frame 1 of the clip" });
    this.editImg = h("img", { alt: "Your edited frame 1", hidden: true });
    this.editBtn = h("button", { type: "button", class: "ghost", "data-act": "ripple-edit",
      title: "Open frame 1 of this clip in Paint Studio: swap the person, change wardrobe or background, relight. Then “Save to reference”",
      on: { click: () => this.editFirstFrame() } }, "✎ Edit first frame");
    this.strength = h("input", { type: "range", min: "0.8", max: "2", step: "0.05", value: String(RIPPLE_STRENGTH),
      on: { input: () => { this.strengthOut.textContent = strengthLabel(this.strength.value); this._store({ strength: +this.strength.value }); } } });
    this.strengthOut = h("span", { class: "status" }, strengthLabel(RIPPLE_STRENGTH));
    this.prompt = h("input", { type: "text", placeholder: "What changed (optional): a teenage boy, night, red jacket…",
      on: { change: () => this._store({ prompt: this.prompt.value }) } });
    this.rippleBtn = h("button", { type: "button", class: "go", "data-act": "ripple-run",
      title: "Carry your frame-1 edit through the whole clip with LTX Ripple (keeps the clip's motion, camera and sound)",
      on: { click: () => this.run() } }, "Ripple it");
    this.status = h("div", { class: "status" });
    this.rippleBox = h("div", { class: "ss-ripple", hidden: true },
      h("label", { class: "f" }, "Clip", this.source),
      h("div", { class: "row" }, this.uploadBtn, this.upload),
      h("div", { class: "thumbs" },
        h("figure", {}, this.srcImg, h("figcaption", {}, "Frame 1 now")),
        h("figure", {}, this.editImg, this.editCap = h("figcaption", {}, "Your edit: none yet"))),
      this.editBtn,
      h("label", { class: "f" }, h("span", { class: "row" }, "Edit strength", this.strengthOut), this.strength),
      h("label", { class: "f" }, "Describe the change (optional)", this.prompt),
      h("div", { class: "row" }, this.rippleBtnPanel = h("button", { type: "button", class: "go", "data-act": "ripple-run-panel",
        on: { click: () => this.run() } }, "Ripple it")),
      this.status);
    this.el = h("div", { class: "ss-follow" }, h("div", { class: "status" }, "Follow"), this.seg, this.note, this.rippleBox);
    this.editHost = h("div", { class: "ss-edithost ss-ripple-edithost" });
    this.compare = h("div", { class: "ss-ripple-cmp", hidden: true });
    this._setNote();
  }

  get sid() { return this.p.ctx.stage.activeShot().id; }
  get rec() { const c = this.p.chosen[this.sid] = this.p.chosen[this.sid] || {}; return (c.ripple = c.ripple || {}); }
  _store(v) { Object.assign(this.rec, v); this.p._saveChosen(); }
  _api() { return this.p.ctx.api; }
  _url(ref) { const q = viewQuery(ref); return this._api()?.apiURL ? this._api().apiURL(`/view?${q}`) : `/view?${q}`; }

  setMode(k) {
    this.mode = FOLLOW_MODES.some((x) => x[0] === k) ? k : "layout";
    for (const b of this.seg.children) b.setAttribute("aria-pressed", String(b.dataset.follow === this.mode));
    this.rippleBox.hidden = this.mode !== "ripple";
    this.compare.hidden = this.mode !== "ripple" || !this.compare.firstChild;
    try { this.p.onFollow?.(this.mode); } catch { /* pipeline hook */ }
    this._setNote();
    if (this.mode === "ripple") this.refresh();
  }

  _setNote() {
    this.note.textContent = this.mode === "pose"
      ? "Experimental: your clay actors as OpenPose skeletons (body, hands, face) drive LTX through the union-control IC-LoRA (made for LTX 2.3). Uses Preview / Render below."
      : this.mode === "ripple" ? "Change frame 1 of a clip, then Ripple carries the change through every frame: same motion, camera and sound."
        : "LTX follows your clay animation: positions, camera and timing.";
  }

  /** Refill the clip list and the two thumbnails for the active shot. */
  refresh() {
    const sid = this.sid;
    let scene = null;
    try { scene = this.p.ctx.stage.toJSON(); } catch { scene = null; }
    const list = rippleSources({ renders: this.p.ctx.getRenders(sid) || {}, scene, chosen: this.p.chosen[sid] });
    this.sources = list;
    const r = this.rec;
    this.source.replaceChildren(...(list.length ? list.map((s) => new Option(s.label, s.ref)) : [new Option("No clip yet: render a draft, or upload / import a clip", "")]));
    if (r.source && list.some((s) => s.ref === r.source)) this.source.value = r.source;
    else if (list[0]) { this.source.value = list[0].ref; r.source = list[0].ref; }
    this.strength.value = String(r.strength ?? RIPPLE_STRENGTH);
    this.strengthOut.textContent = strengthLabel(this.strength.value);
    this.prompt.value = r.prompt || "";
    this._thumbs();
    try { this.p.onRippleSource?.(this._srcUrl(), !!(r.last && r.last.source === this.source.value)); } catch { /* pipeline hook */ }
    this.editBtn.disabled = !this.source.value;
    const ready = !!(this.source.value && r.edited?.ref && r.edited.for === this.source.value);
    for (const b of [this.rippleBtn, this.rippleBtnPanel]) b.disabled = !ready || !!this.busy;
    if (!this.busy) this.status.textContent = this._sticky && this._sticky.for === this.source.value ? this._sticky.text
      : !this.source.value ? "Pick or bring in a clip." : ready ? "Ready: Ripple it." : "Next: Edit first frame.";
    this._drawCompare();
  }

  _srcUrl() { const s = (this.sources || []).find((x) => x.ref === this.source.value); return s?.url || (this.source.value ? this._url(this.source.value) : ""); }

  async _thumbs() {
    const r = this.rec, url = this._srcUrl(), want = this.source.value;
    const ed = r.edited && r.edited.for === want ? r.edited : null;
    this.editImg.hidden = !ed;
    if (ed) this.editImg.src = ed.url;
    this.editCap.textContent = ed ? "Your edit" : "Your edit: none yet";
    if (!url) { this.srcImg.removeAttribute("src"); return; }
    if (this._thumbFor === want) return;
    this._thumbFor = want;
    try { this._frame1 = await firstFrameDataURL(url); if (this._thumbFor === want) this.srcImg.src = this._frame1; }
    catch { this.srcImg.removeAttribute("src"); }
  }

  _pickSource() { this._sticky = null; this._store({ source: this.source.value }); this.refresh(); }

  /** A clip from the computer (or Import video → Ripple): uploaded to input/soundstage_private/, then picked. */
  async importClip(file) {
    const api = this._api();
    this.status.textContent = `Uploading ${file.name}…`;
    try {
      const body = new FormData();
      body.append("image", file, file.name);
      body.append("type", "input");
      body.append("subfolder", PRIVATE_DIR);
      body.append("overwrite", "true");
      const res = await api.fetchApi("/upload/image", { method: "POST", body });
      if (res.status !== 200) throw new Error(`upload failed (${res.status})`);
      const j = await res.json();
      const ref = `${j.subfolder ? j.subfolder + "/" : ""}${j.name} [input]`;
      this._store({ clip: { ref, url: this._url(ref), name: file.name }, source: ref });
      this.setMode("ripple");
      this.refresh();
      this.status.textContent = `${file.name} is in. Next: Edit first frame.`;
      return ref;
    } catch (e) { this.status.textContent = `Couldn't bring in ${file.name}: ${e.message}`; return null; }
  }

  /** Frame 1 of the clip in Paint Studio, over the Motion canvas. "Save to reference" keeps the edit for Ripple. */
  async editFirstFrame() {
    const src = this.source.value;
    if (!src) { this.status.textContent = "Pick a clip first."; return; }
    if (!this.p.ctx.editRef) { this.status.textContent = "Paint Studio isn't available here."; return; }
    this.status.textContent = "Opening frame 1 in Paint Studio…";
    let url;
    try { url = this._thumbFor === src && this._frame1 ? this._frame1 : await firstFrameDataURL(this._srcUrl()); }
    catch (e) { this.status.textContent = `Couldn't read frame 1: ${e.message}`; return; }
    const shot = this.p.ctx.stage.activeShot();
    const tok = (this._tok = {});
    this._sticky = null;
    this.editing = true;
    this.p.onRippleEditor?.(true);
    await this.p.ctx.editRef({ name: `${shot?.name || "shot"} frame 1`, url, subfolder: PRIVATE_DIR }, {
      host: this.editHost,
      onSaved: (r) => {
        const ref = /\[(input|output|temp)\]$/.test(r.ref) ? r.ref : `${r.ref} [input]`;
        this._store({ edited: { ref, url: r.url, for: src } });
        this.status.textContent = "Edit saved. Ripple it.";
      },
      onExit: () => {
        if (this._tok !== tok) return;
        this.editing = false;
        this.p.ctx.unmountCanvas?.();
        this.p.onRippleEditor?.(false);
        this.refresh();
      },
    });
    this.status.textContent = "Paint Studio: describe the new frame and use Whole frame (or mask an area and Generative Fill), Keep a variation, then “Save to reference”.";
  }

  /** Queue the Ripple render; when it lands it becomes a take on the shot. */
  async run() {
    const r = this.rec, src = this.source.value;
    if (!src || !r.edited?.ref || r.edited.for !== src) { this.status.textContent = "Edit frame 1 first."; return; }
    const sid = this.sid, quality = this.quality(), strength = +this.strength.value;
    let prompt;
    try {
      prompt = buildRipplePrompt({ source: src, edited: r.edited.ref, prompt: this.prompt.value, strength, quality,
        seed: Math.floor(Math.random() * 2 ** 31), prefix: `${PRIVATE_DIR}/ripple` });
    } catch (e) { this.status.textContent = e.message; return; }
    this.busy = true;
    this.refresh();
    const api = this._api();
    const stop = this.p._tick?.(this.status, `Rippling (${quality}, strength ${strength.toFixed(2)}): about ${quality === "Final" ? "4–8" : "2–4"} min`);
    try {
      const res = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: api.clientId }) });
      const q = await res.json();
      if (!res.ok || q.error) {
        const ne = Object.values(q.node_errors || {})[0];
        throw new Error(ne ? `${ne.class_type}: ${ne.errors?.[0]?.message || ""} ${ne.errors?.[0]?.details || ""}` : q.error?.message || `HTTP ${res.status}`);
      }
      this.p.inflight?.set(q.prompt_id, { sid, step: "ripple" });
      this.p._drawShotRows?.();
      const file = await waitForOutput(api, q.prompt_id, "2");
      stop?.();
      const url = this._url(refOf(file)) + `&t=${Date.now()}`;
      const take = makeTake({ file, url, quality, strength, source: src, edited: r.edited.ref, prompt: this.prompt.value });
      addTake(this.p.chosen[sid] = this.p.chosen[sid] || {}, take);
      r.last = { url, source: src };
      this.p._saveChosen();
      this.p.onRippleTake?.(sid, take);
      this._sticky = { for: src, text: `Ripple take landed (${quality}, strength ${strength.toFixed(2)}). It's in Takes; drag the line on the picture to compare it with the clip.` };
    } catch (e) {
      stop?.();
      this._sticky = { for: src, text: `Ripple failed: ${e.message}` };
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  /** Before / after wipe: the source clip under the Ripple result, synced. */
  _drawCompare() {
    const r = this.rec;
    const last = r.last && r.last.source === this.source.value ? r.last : null;
    if (!last) { this.compare.replaceChildren(); this.compare.hidden = true; return; }
    if (this.compare.dataset.url === last.url) { this.compare.hidden = this.mode !== "ripple"; return; }
    this.compare.dataset.url = last.url;
    const base = h("video", { src: this._srcUrl(), muted: true, loop: true, playsinline: true });
    const top = h("video", { src: last.url, class: "top", loop: true, playsinline: true, controls: false });
    base.muted = true;
    const line = h("div", { class: "line" });
    const slider = h("input", { type: "range", min: "0", max: "100", value: "50", "aria-label": "Before / after" });
    const place = () => { const v = +slider.value; top.style.clipPath = `inset(0 0 0 ${v}%)`; line.style.left = `${v}%`; };
    slider.addEventListener("input", place);
    top.addEventListener("play", () => { base.currentTime = top.currentTime; base.play().catch(() => {}); });
    top.addEventListener("pause", () => base.pause());
    top.addEventListener("seeked", () => { base.currentTime = top.currentTime; });
    top.addEventListener("timeupdate", () => { if (Math.abs(base.currentTime - top.currentTime) > 0.08) base.currentTime = top.currentTime; });
    const play = h("button", { type: "button", class: "ghost", style: "position:absolute;right:8px;top:6px;padding:2px 10px",
      on: { click: () => (top.paused ? top.play() : top.pause()) } }, "▶ / ❚❚");
    this.compare.replaceChildren(base, top, line, h("span", { class: "tag", style: "left:8px" }, "Clip"),
      h("span", { class: "tag", style: "right:90px" }, "Ripple"), play, slider);
    place();
    this.compare.hidden = this.mode !== "ripple";
  }
}

/** Poll /history until node `outId` of prompt `pid` has saved a file; returns {filename, subfolder, type}. */
export async function waitForOutput(api, pid, outId, { timeoutMs = 3600000, every = 2000 } = {}) {
  const t0 = Date.now();
  let misses = 0;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, every));
    let e;
    try { e = (await (await api.fetchApi(`/history/${pid}`)).json())[pid]; misses = 0; }
    catch { if (++misses > 30) throw new Error("lost touch with the server"); continue; }
    if (!e) continue;
    if (e.status?.status_str === "error") {
      const msg = (e.status.messages || []).find((m) => m[0] === "execution_error")?.[1];
      throw new Error(msg ? `${msg.node_type}: ${msg.exception_message}`.slice(0, 300) : "the render failed (see the ComfyUI console)");
    }
    const o = e.outputs?.[outId];
    const f = o?.images?.[0] || o?.videos?.[0] || o?.gifs?.[0];
    if (f) return f;
    if (e.status?.completed) throw new Error("finished without a video");
  }
  throw new Error("timed out");
}
