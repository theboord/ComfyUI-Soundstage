// Passes: everything the App extracted from a video, shown so you can judge it by eye. One full-window viewer over
// the App (both layouts, any width), opened from a take (Dailies card and takes row), the Ladder bar (⑥ Review) and
// the Video → 3D result. Four tabs, matte first:
//   Alpha matte  the matte in black and white; the cut-out over a checker, black, white, any flat colour or a busy
//                test background; a red rubylith over the original; the edge band (0.02 < alpha < 0.98) lit up with
//                its size and width; zoom to 800 % with pan; frame by frame; A/B flicker against the original
//   Pose         the DWPose read over the actor (body, hands, the 68 face points and pupils) with confidence colours
//                and a toggle per part; or the clay / SAM 3D Body skeleton through the shot camera
//   Talking      the sound's waveform under the timeline with the mouth-open curve and its openings
//   Depth        greyscale or Turbo, near / far sliders, split against the source
// Common: play, scrub, frame step, A/B wipe, side by side, flicker, zoom and export a still of the view.
// What it reads, and what is missing (with the reason), comes from model.mjs discoverPasses.
import { icon } from "../ui/icons.mjs";
import {
  KINDS, KIND_LABEL, discoverPasses, firstKind, viewPath, packPath, framePath, edgeBand, edgeLine, rubylith, busyBackground,
  turbo, remapDepth, stageMetres, confColor, poseFrame, mouthBox, pearson, bestLag, peaks, frameLabel, stillName,
} from "./model.mjs";

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "style") e.style.cssText = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
};
const canvas = (w = 1, hh = 1) => Object.assign(document.createElement("canvas"), { width: Math.max(1, w | 0), height: Math.max(1, hh | 0) });
const ctx2d = (c) => c.getContext("2d", { willReadFrequently: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureCss() {
  if (document.getElementById("ss-pv-css")) return;
  document.head.append(h("link", { id: "ss-pv-css", rel: "stylesheet", href: new URL("./passes.css", import.meta.url).href }));
}

// ------------------------------------------------------------------------------------------------ frame sources

/**
 * One <video> read frame by frame: at(f) seeks to the middle of frame f and resolves with the element. The clip is
 * fetched whole into a blob first: a server that doesn't answer Range requests (a static host, python -m http.server)
 * leaves a streamed <video> unseekable, and every frame would be frame 0.
 */
class VideoFrames {
  constructor(url, { fps = 24, start = 0 } = {}) {
    this.fps = fps; this.start = start;
    this.v = h("video", { muted: true, playsinline: true, preload: "auto", crossorigin: "anonymous" });
    this.v.muted = true;
    this.q = Promise.resolve();
    this.ready = (async () => {
      let src = url;
      if (!/^(blob|data):/.test(url)) {
        try { const r = await fetch(url); if (r.ok) src = this.blob = URL.createObjectURL(await r.blob()); } catch { /* stream it instead */ }
      }
      await new Promise((ok, bad) => {
        this.v.addEventListener("loadeddata", ok, { once: true });
        this.v.addEventListener("error", () => bad(new Error("the clip didn't load")), { once: true });
        this.v.src = src;
      });
      return this;
    })();
    this.ready.catch(() => {});
  }
  get w() { return this.v.videoWidth || 1; }
  get hgt() { return this.v.videoHeight || 1; }
  get frames() { const d = this.v.duration; return Number.isFinite(d) && d > 0 ? Math.max(1, Math.round((d - this.start) * this.fps)) : 1; }
  at(f) {
    const run = async () => {
      await this.ready;
      const d = Number.isFinite(this.v.duration) ? this.v.duration : Infinity;
      const t = Math.min(Math.max(0, this.start + (Math.max(0, f) + 0.5) / this.fps), Math.max(0, d - 0.001));
      if (Math.abs(this.v.currentTime - t) > 1e-4 || this.v.readyState < 2) {
        await new Promise((ok) => {
          const done = () => { this.v.removeEventListener("seeked", done); ok(); };
          this.v.addEventListener("seeked", done);
          this.v.currentTime = t;
          setTimeout(done, 2500);
        });
      }
      return this.v;
    };
    this.q = this.q.then(run, run);
    return this.q;
  }
  destroy() { try { this.v.removeAttribute("src"); this.v.load(); if (this.blob) URL.revokeObjectURL(this.blob); } catch { /* gone */ } }
}

/** Pictures by URL, decoded once (a small LRU), so stepping back and forth doesn't refetch. */
class Pictures {
  constructor(n = 48) { this.n = n; this.m = new Map(); }
  get(url) {
    if (this.m.has(url)) { const p = this.m.get(url); this.m.delete(url); this.m.set(url, p); return p; }
    const p = new Promise((ok, bad) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => ok(im);
      im.onerror = () => bad(new Error(`couldn't load ${decodeURIComponent(String(url).split("filename=")[1]?.split("&")[0] || url)}`));
      im.src = url;
    });
    p.catch(() => this.m.delete(url));
    this.m.set(url, p);
    while (this.m.size > this.n) this.m.delete(this.m.keys().next().value);
    return p;
  }
}

/** Draw any image source into a W x H canvas (cover-free: stretched to the same frame, the passes share one raster). */
function drawTo(c, src, W, H) {
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = ctx2d(c);
  g.clearRect(0, 0, W, H);
  if (src) g.drawImage(src, 0, 0, W, H);
  return c;
}

// ------------------------------------------------------------------------------------------------ the viewer

const BG = [["checker", "Checker"], ["black", "Black"], ["white", "White"], ["color", "Colour"], ["busy", "Busy test"]];
const MATTE_MODES = [["matte", "Matte", "The matte in black and white (white = kept)"], ["over", "Over", "The cut-out over a background"],
  ["ruby", "Rubylith", "Red over what the matte throws away, on the original"], ["edge", "Edges", "Only the soft band (0.02 < alpha < 0.98), lit up"]];
const COMPARE = [["off", "Off"], ["wipe", "Wipe"], ["side", "Side by side"], ["flicker", "Flicker"]];
const ZOOMS = [["fit", "Fit"], [1, "100 %"], [2, "200 %"], [4, "400 %"], [8, "800 %"]];
// OpenPose COCO-18 limbs and colours, the way DWPose draws them (web/stage/posepass.mjs)
const LIMBS = [[1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]];
const LCOL = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170], [0, 255, 255],
  [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]];
const HAND = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];

/**
 * host = { api, stage, say(msg) }. open(subject) with a discoverPasses subject (see model.mjs); the viewer adds the
 * stage's scene, active shot, people count, the Layer Packs on the server and the demo flag itself.
 */
export class PassesViewer {
  constructor(host) {
    ensureCss();
    this.host = host;
    this.pics = new Pictures();
    this.videos = new Map();
    this.json = new Map();
    this.f = 0; this.frames = 1; this.fps = 24;
    this.kind = "matte"; this.mode = "matte"; this.bg = "checker"; this.color = "#00b140";
    this.compare = "off"; this.split = 0.5; this.zoom = "fit"; this.cx = 0.5; this.cy = 0.5;
    this.depthMode = "turbo"; this.near = 1; this.far = 0; this.dim = 0.55;
    this.parts = { body: true, hands: true, face: true, conf: true, numbers: false };
    this.mouthZoom = false;
    this.gen = 0;
    this.pass = canvas(); this.orig = canvas(); this.comp = canvas();
    this._build();
  }

  get isOpen() { return !this.el.hidden; }

  _build() {
    this.tabs = {};
    const tabRow = h("div", { class: "tabs", role: "tablist", "aria-label": "Pass" });
    KINDS.forEach((k, i) => {
      const b = h("button", { type: "button", role: "tab", class: "tab", "data-kind": k, title: `${KIND_LABEL[k]} (${i + 1})`, on: { click: () => this.setKind(k) } },
        h("span", { class: "dot" }), h("span", { class: "tx" }, KIND_LABEL[k]));
      this.tabs[k] = b; tabRow.append(b);
    });
    this.who = h("span", { class: "who" });
    this.cv = h("canvas", { class: "cv", "aria-label": "The pass", tabindex: "-1" });
    this.zoomTag = h("span", { class: "ztag" });
    this.abTag = h("span", { class: "abtag", hidden: true });
    this.msg = h("div", { class: "msg", hidden: true });
    this.view = h("div", { class: "view" }, this.cv, this.zoomTag, this.abTag, this.msg);
    this.srcSel = h("select", { class: "src", "aria-label": "Source", on: { change: () => this._pickSource(this.srcSel.value) } });
    this.note = h("div", { class: "note" });
    this.ctl = h("div", { class: "ctl" });
    this.stats = h("div", { class: "stats", "aria-live": "polite" });
    this.side = h("div", { class: "side" }, h("label", { class: "lab" }, "Source"), this.srcSel, this.note, this.ctl, this.stats);
    this.wave = h("canvas", { class: "wave", "aria-label": "Sound and mouth over time", on: { pointerdown: (e) => this._waveSeek(e) } });
    this.waveRow = h("div", { class: "waverow", hidden: true }, this.wave);
    // transport
    const tb = (ic, title, fn) => h("button", { type: "button", class: "ib", title, "aria-label": title, on: { click: fn } }, icon(ic, 15));
    this.playBtn = tb("play", "Play (Space)", () => this.togglePlay());
    this.scrub = h("input", { type: "range", class: "scrub", min: 0, max: 0, value: 0, "aria-label": "Frame", on: { input: () => this.setFrame(+this.scrub.value) } });
    this.flabel = h("span", { class: "fl" });
    this.cmp = h("div", { class: "seg", role: "group", "aria-label": "Compare with the original" });
    this.cmpBtns = {};
    for (const [k, l] of COMPARE) {
      const b = h("button", { type: "button", "data-c": k, on: { click: () => this.setCompare(k) } }, l);
      this.cmpBtns[k] = b; this.cmp.append(b);
    }
    this.zoomSel = h("select", { class: "zoom", "aria-label": "Zoom", on: { change: () => this.setZoom(this.zoomSel.value === "fit" ? "fit" : +this.zoomSel.value) } },
      ZOOMS.map(([v, l]) => h("option", { value: String(v) }, l)));
    this.exportBtn = h("button", { type: "button", class: "b", title: "Save a PNG of the view as it is now", on: { click: () => this.exportStill() } }, icon("download", 14), "Still");
    this.foot = h("div", { class: "foot" },
      h("div", { class: "tr" }, tb("step-back", "Previous frame (←)", () => this.step(-1)), this.playBtn, tb("step-forward", "Next frame (→)", () => this.step(1)), this.scrub, this.flabel),
      h("div", { class: "tr2" }, h("span", { class: "lab" }, "Original"), this.cmp, this.zoomSel, this.exportBtn));
    this.el = h("div", { class: "ss-pv", hidden: true, role: "dialog", "aria-label": "Passes", tabindex: "-1" },
      h("div", { class: "head" }, h("span", { class: "t" }, icon("layers", 16), "Passes"), this.who, tabRow,
        h("button", { type: "button", class: "ib", title: "Close (Esc)", "aria-label": "Close", on: { click: () => this.close() } }, icon("x", 16))),
      h("div", { class: "body" }, this.view, this.side), this.waveRow, this.foot);
    for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === "wheel" });
    this.el.addEventListener("keydown", (e) => this._key(e));
    this.el.addEventListener("keyup", (e) => e.stopPropagation());
    this._wireView();
    this._ro = new ResizeObserver(() => { this._drawView(); this._drawWave(); });
    this._ro.observe(this.view);
    this._ro.observe(this.waveRow);
    document.body.append(this.el);
  }

  // -------------------------------------------------------------------------------------------- open / close

  async open(subject) {
    const og = this.openGen = (this.openGen || 0) + 1;
    this.gen++;
    this.stop();
    this.subject = subject || {};
    const S = this._enrich(this.subject);
    this.found = discoverPasses(S);
    this.el.hidden = false;
    this.f = 0; this.setZoom("fit"); this.setCompare("off");
    this.who.replaceChildren(h("b", {}, subject?.label || subject?.shot?.name || "Passes"),
      h("span", {}, subject?.take ? (subject.take.label || `Tk ${subject.take.n || 1} · ${subject.take.kind}`) : subject?.from === "v2s" ? "Video → 3D result" : "Review"));
    // Layer Packs on the server (listed, not linked, when the shot has none of its own): one request, quiet on failure
    if (!this.host.demo) {
      this._packs().then((packs) => {
        if (og !== this.openGen || this.el.hidden || !packs.length) return;
        this.found = discoverPasses({ ...S, packs });
        this._drawTabs(); if (this.kind === "matte" || this.kind === "depth") this._drawSources();
      });
    }
    this._drawTabs();
    this.setKind(subject?.kind || firstKind(this.found));
    setTimeout(() => { try { this.el.focus({ preventScroll: true }); } catch { /* detached */ } }, 0);
  }

  close() {
    this.stop();
    this.el.hidden = true;
    this.gen++;
    for (const v of this.videos.values()) v.destroy();
    this.videos.clear();
    if (this.audio) { this.audio.pause(); this.audio = null; }
  }

  _enrich(s) {
    const st = this.host.stage;
    let scene = s.scene, active = s.activeShot, people = s.people;
    try { scene = scene || st?.toJSON?.(); } catch { /* no stage */ }
    try { active = active || st?.activeShot?.()?.id; } catch { /* */ }
    try { people = people ?? [...(st?.actorMeshes?.values?.() || [])].filter((g) => g?.userData?.joints?.l_shoulder).length; } catch { people = 0; }
    return { ...s, scene, activeShot: active, people, demo: !!this.host.demo };
  }

  async _packs() {
    try {
      const r = await this.host.api.fetchApi("/soundstage/layerpack/list");
      if (!r.ok) return [];
      return ((await r.json()).packs || []).map((p) => p.name).filter(Boolean).slice(0, 30);
    } catch { return []; }
  }

  // -------------------------------------------------------------------------------------------- tabs and sources

  _drawTabs() {
    for (const k of KINDS) {
      const list = this.found?.[k] || [];
      const ok = list.some((s) => s.ok);
      const b = this.tabs[k];
      b.classList.toggle("ok", ok);
      b.setAttribute("aria-selected", String(k === this.kind));
      b.title = ok ? `${KIND_LABEL[k]} (${KINDS.indexOf(k) + 1})` : `${KIND_LABEL[k]}: not available here. ${(list.find((s) => !s.ok) || {}).reason || ""}`;
    }
  }

  setKind(k) {
    if (!KINDS.includes(k)) return;
    this.kind = k;
    this._drawTabs();
    this._drawSources();
    this.waveRow.hidden = k !== "talk";
    const first = (this.found?.[k] || []).find((s) => s.ok) || (this.found?.[k] || [])[0];
    this._pickSource(first?.id);
  }

  _drawSources() {
    const list = this.found?.[this.kind] || [];
    const cur = this.src?.id;
    this.srcSel.replaceChildren(...list.map((s) => h("option", { value: s.id, disabled: !s.ok, title: s.reason || s.note || "" }, `${s.ok ? "" : "✕ "}${s.label}`)));
    if (cur && list.some((s) => s.id === cur && s.ok)) this.srcSel.value = cur;
  }

  async _pickSource(id) {
    const gen = ++this.gen;
    this.stop();
    const list = this.found?.[this.kind] || [];
    const src = list.find((s) => s.id === id) || list[0];
    this.src = src;
    if (src) this.srcSel.value = src.id;
    const missing = list.filter((s) => !s.ok);
    this.note.replaceChildren(...(src?.note ? [h("p", {}, src.note)] : []),
      ...(missing.length ? [h("details", { class: "miss" }, h("summary", {}, `Not available here (${missing.length})`),
        ...missing.map((s) => h("p", {}, h("b", {}, s.label), ": ", s.reason || "")))] : []));
    this.ctl.replaceChildren();
    this.stats.textContent = "";
    this.state = null;
    if (!src || !src.ok) {
      this._message(src ? `${src.label}: ${src.reason}` : "Nothing here.");
      this.frames = 1; this._syncTransport();
      this._clear();
      return;
    }
    this._message("Loading…");
    try {
      this.state = await this._load(src, gen);
      if (gen !== this.gen) return;
      this._message("");
      this._buildControls();
      this.frames = Math.max(1, this.state.frames || 1);
      this.fps = this.state.fps || 24;
      this.f = Math.min(this.f, this.frames - 1);
      this._syncTransport();
      this._syncCompare();
      if (this.kind === "talk") this._loadWave(gen);
      await this.render();
    } catch (e) {
      if (gen !== this.gen) return;
      this._message(`${src.label}: ${e.message || e}`);
      this._clear();
    }
  }

  _message(t) { this.msg.hidden = !t; this.msg.textContent = t || ""; }
  _clear() { const g = this.cv.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.cv.width, this.cv.height); }

  // -------------------------------------------------------------------------------------------- loading

  url(path) { const api = this.host.api; return path && api?.apiURL && /^\/view\?/.test(path) ? api.apiURL(path) : path; }

  _video(path, opts = {}) {
    const u = this.url(path);
    const key = `${u}|${opts.start || 0}|${opts.fps || 24}`;
    if (!this.videos.has(key)) this.videos.set(key, new VideoFrames(u, opts));
    return this.videos.get(key);
  }

  async _json(path) {
    if (this.json.has(path)) return this.json.get(path);
    const p = (async () => {
      const r = await this.host.api.fetchApi(path);
      if (!r.ok) throw new Error(`not found (${r.status})`);
      return r.json();
    })();
    p.catch(() => this.json.delete(path));
    this.json.set(path, p);
    return p;
  }

  /** The original the pass is compared against: {at(f) -> image source, w, h, frames} or null. */
  _original(o = this.found?.original) {
    if (!o) return null;
    const path = o.url || viewPath(o.ref);
    if (!path) return null;
    if (o.video) {
      const v = this._video(path, { fps: o.fps || 24, start: o.start || 0 });
      return { at: (f) => v.at(f), get w() { return v.w; }, get h() { return v.hgt; }, get frames() { return v.frames; }, ready: v.ready, label: o.label };
    }
    const u = this.url(path);
    return { at: () => this.pics.get(u), ready: this.pics.get(u), label: o.label, frames: 1, still: true };
  }

  async _load(src) {
    const t = src.type;
    if (t === "cutout_png") {
      const u = this.url(viewPath(src.url));
      const im = await this.pics.get(u);
      const orig = this._original();
      try { await orig?.ready; } catch { /* no original */ }
      return { frames: 1, fps: 24, w: im.naturalWidth, h: im.naturalHeight, orig, cut: () => this.pics.get(u) };
    }
    if (t === "layerpack") {
      const man = await this._json(packPath(src.pack, "manifest.json"));
      const layers = (man.layers || []).filter((l) => l?.files?.png);
      if (!layers.length) throw new Error("this pack has no layer frames (was it exported with PNG frames?)");
      const fs = man.shot?.frame_start ?? 1001, N = man.shot?.frames || 1;
      const [W, H] = man.shot?.resolution || [0, 0];
      const urlOf = (L, f) => this.url(packPath(src.pack, framePath(L.files.png, fs + Math.min(N - 1, Math.max(0, f)))));
      const pick = layers.find((l) => l.kind !== "background") || layers[0];
      const st = { frames: N, fps: man.shot?.fps || 24, w: W, h: H, man, layers, layer: pick.id, pack: src.pack, fs };
      st.cut = (f) => this.pics.get(urlOf(layers.find((l) => l.id === st.layer) || pick, f));
      // the original frame: every layer back to front (the layers split the frame, so they add up to it)
      st.orig = { label: "All layers together (the final frame)", at: async (f) => {
        const ims = await Promise.all(layers.slice().sort((a, b) => a.z - b.z).map((L) => this.pics.get(urlOf(L, f))));
        const c = canvas(W || ims[0].naturalWidth, H || ims[0].naturalHeight), g = ctx2d(c);
        g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
        for (const im of ims) g.drawImage(im, 0, 0, c.width, c.height);
        return c;
      } };
      const dep = man.aovs?.depth;
      if (dep) st.depthOf = (f) => this.pics.get(this.url(packPath(src.pack, framePath("aovs/depth_vis/depth_vis.####.png", fs + f))));
      return st;
    }
    if (t === "v2s_masks") {
      const orig = this._original();
      await orig.ready;
      const masks = this.host.stage?.state?.video2stage?.masks || this.subject?.scene?.video2stage?.masks || {};
      const { rleDecode, resampleMask, maskAt } = await import("../ui/v2scompare.mjs");
      const st = { frames: orig.frames, fps: 24, w: orig.w, h: orig.h, orig, refs: src.refs, ref: "all" };
      st.mask = (f) => {
        const refs = st.ref === "all" ? src.refs : [st.ref];
        let out = null;
        for (const r of refs) {
          const m = resampleMask(maskAt(masks, r, f) ? maskAt(masks, r, f) : null, st.w, st.h);
          if (!m) continue;
          if (!out) out = new Uint8Array(st.w * st.h);
          for (let i = 0; i < out.length; i++) if (m.data[i]) out[i] = 255;
        }
        return out;
      };
      void rleDecode;
      return st;
    }
    if (t === "performance") {
      const assetPath = viewPath(src.asset);
      const a = await this._json(assetPath);
      const kp = a.files?.keypoints ? await this._json(viewPath(a.files.keypoints)).catch(() => null) : null;
      const srcRef = a.source;
      const orig = srcRef ? this._original({ ref: srcRef, video: true, fps: a.fps || 24, label: "The actor's clip" }) : null;
      const pose = a.files?.pose ? this._video(viewPath(a.files.pose), { fps: a.fps || 24 }) : null;
      try { await orig?.ready; } catch { /* missing clip */ }
      const res = a.result_keypoints ? await this._json(viewPath(a.result_keypoints)).catch(() => null) : null;
      const W = a.width || orig?.w || 1280, H = a.height || orig?.h || 720;
      return { frames: a.frames || kp?.frames?.length || orig?.frames || 1, fps: a.fps || 24, w: W, h: H, asset: a, kp, orig, pose, res,
        vector: !!kp?.frames?.some((fr) => fr?.body), audio: a.files?.audio ? viewPath(a.files.audio) : (srcRef ? viewPath(srcRef) : "") };
    }
    if (t === "stage_pose") {
      const orig = this._original();
      try { await orig?.ready; } catch { /* */ }
      const st = this.host.stage;
      return { frames: Math.max(1, st?.state?.shot?.frames || orig?.frames || 97), fps: st?.state?.shot?.fps || 24, w: orig?.w || st?.fw || 1280, h: orig?.h || st?.fh || 720, orig, stagePose: true };
    }
    if (t === "audio") {
      const path = src.url ? viewPath(src.url) : viewPath(src.ref);
      const v2s = src.id === "audio:v2s";
      const orig = this._original(v2s ? this.found.original : { url: src.url, video: true, label: "The take" });
      try { await orig?.ready; } catch { /* */ }
      return { frames: orig?.frames || 1, fps: 24, w: orig?.w || 1280, h: orig?.h || 720, orig, audio: path, audioStart: v2s ? this.found.original?.start || 0 : 0 };
    }
    if (t === "stage_depth") {
      const st = this.host.stage;
      if (!st?.renderFrameTo) throw new Error("the 3D stage isn't here");
      const orig = this._original();
      try { await orig?.ready; } catch { /* */ }
      return { frames: Math.max(1, st.state?.shot?.frames || 97), fps: st.state?.shot?.fps || 24, w: st.fw, h: st.fh, orig, stageDepth: src.shot, metres: true };
    }
    if (t === "pack_depth") {
      const st = await this._load({ ...src, type: "layerpack" });
      if (!st.depthOf) throw new Error("this Layer Pack has no depth AOV");
      return { ...st, packDepth: true };
    }
    throw new Error("not readable here");
  }

  // -------------------------------------------------------------------------------------------- controls per tab

  _buildControls() {
    const s = this.state, k = this.kind;
    const seg = (items, cur, set, label) => {
      const g = h("div", { class: "seg", role: "group", "aria-label": label });
      for (const [v, l, tip] of items) g.append(h("button", { type: "button", "aria-pressed": String(v === cur), title: tip || l,
        on: { click: () => { set(v); [...g.children].forEach((b, i) => b.setAttribute("aria-pressed", String(items[i][0] === v))); this.render(); } } }, l));
      return g;
    };
    const row = (lab, ...kids) => h("div", { class: "row" }, h("span", { class: "lab" }, lab), ...kids);
    const tog = (key, label, obj = this.parts) => h("label", { class: "tg" }, Object.assign(h("input", { type: "checkbox", on: { change: (e) => { obj[key] = e.target.checked; this.render(); } } }), { checked: !!obj[key] }), label);
    const kids = [];
    if (k === "matte") {
      if (s.layers?.length > 1) kids.push(row("Layer", Object.assign(h("select", { on: { change: (e) => { s.layer = e.target.value; this.render(); } } },
        s.layers.map((L) => h("option", { value: L.id }, `${L.name} (${L.kind})`))), { value: s.layer })));
      if (s.refs?.length > 1) kids.push(row("Mask", Object.assign(h("select", { on: { change: (e) => { s.ref = e.target.value; this.render(); } } },
        h("option", { value: "all" }, "All together"), s.refs.map((r) => h("option", { value: r }, r.replace("/", " · ")))), { value: s.ref })));
      kids.push(row("View", seg(MATTE_MODES, this.mode, (v) => { this.mode = v; this._syncBg(); }, "Matte view")));
      this.bgRow = row("Behind", seg(BG.map(([v, l]) => [v, l]), this.bg, (v) => { this.bg = v; }, "Background"),
        Object.assign(h("input", { type: "color", class: "col", title: "The flat colour (Colour)", "aria-label": "Flat colour",
          on: { input: (e) => { this.color = e.target.value; this.bg = "color"; this._buildControls(); this.render(); } } }), { value: this.color }));
      kids.push(this.bgRow);
      kids.push(h("p", { class: "hint" }, "Zoom to 200-800 % on hair and hands (wheel or the zoom menu), drag to pan, ← → for frames, Flicker for A/B."));
    } else if (k === "pose") {
      if (s.stagePose) kids.push(row("Show", tog("body", "Body"), tog("hands", "Hands"), tog("face", "Face")));
      else {
        kids.push(row("Show", tog("body", "Body"), tog("hands", "Hands"), tog("face", "Face (68)"), tog("numbers", "Numbers")));
        kids.push(row("Colour", tog("conf", "By confidence")));
        kids.push(h("p", { class: "hint" }, h("span", { style: "color:#3ddc84" }, "● ≥ 0.6"), "  ", h("span", { style: "color:#ffb020" }, "● 0.3-0.6"), "  ",
          h("span", { style: "color:#ff4040" }, "● < 0.3 (DWPose drops it)")));
        if (!s.vector) kids.push(h("p", { class: "hint" }, "This read is older than the per-point body data: body and hands show as DWPose drew them (pose.mp4), so only the face has confidence."));
      }
      kids.push(row("Picture", Object.assign(h("input", { type: "range", min: 0, max: 100, "aria-label": "Picture brightness", on: { input: (e) => { this.dim = e.target.value / 100; this.render(); } } }), { value: Math.round(this.dim * 100) })));
    } else if (k === "talk") {
      if (s.asset) kids.push(row("Picture", tog("mouthZoom", "Mouth close-up", this)));
      kids.push(h("p", { class: "hint" }, "Play (Space) plays the sound. Click the strip to jump to a moment."));
    } else if (k === "depth") {
      kids.push(row("Colour", seg([["grey", "Greyscale"], ["turbo", "Turbo"]], this.depthMode, (v) => { this.depthMode = v; }, "Depth colour")));
      const lab = (v) => (s.metres ? `${stageMetres(v).toFixed(1)} m` : `${Math.round(v * 100)} %`);
      const nearOut = h("output", {}, lab(this.near)), farOut = h("output", {}, lab(this.far));
      kids.push(row("Near", Object.assign(h("input", { type: "range", min: 0, max: 100, "aria-label": "Near", on: { input: (e) => { this.near = e.target.value / 100; nearOut.textContent = lab(this.near); this.render(); } } }), { value: Math.round(this.near * 100) }), nearOut));
      kids.push(row("Far", Object.assign(h("input", { type: "range", min: 0, max: 100, "aria-label": "Far", on: { input: (e) => { this.far = e.target.value / 100; farOut.textContent = lab(this.far); this.render(); } } }), { value: Math.round(this.far * 100) }), farOut));
      kids.push(h("p", { class: "hint" }, "Near and far set the window that the grey or the colours spread over. Wipe or Side by side splits it against the source."));
    }
    this.ctl.replaceChildren(...kids);
    this._syncBg();
  }

  _syncBg() { if (this.bgRow) this.bgRow.hidden = this.mode !== "over"; }

  // -------------------------------------------------------------------------------------------- transport

  _syncTransport() {
    this.scrub.max = String(Math.max(0, this.frames - 1));
    this.scrub.value = String(this.f);
    this.scrub.disabled = this.frames <= 1;
    this.flabel.textContent = this.frames > 1 ? frameLabel(this.f, this.frames, this.fps) : "still";
  }

  _syncCompare() {
    const has = !!this.state?.orig && !(this.kind === "talk");
    for (const [k, b] of Object.entries(this.cmpBtns)) {
      b.disabled = k !== "off" && !has;
      b.setAttribute("aria-pressed", String(k === this.compare));
      b.title = has ? "" : "No original to compare with here";
    }
    if (!has && this.compare !== "off") this.setCompare("off");
  }

  setCompare(c) {
    this.compare = c;
    for (const [k, b] of Object.entries(this.cmpBtns)) b.setAttribute("aria-pressed", String(k === c));
    clearInterval(this._flick);
    this._showOrig = false;
    if (c === "flicker") this._flick = setInterval(() => { this._showOrig = !this._showOrig; this._drawView(); }, 333);
    this._drawView();
  }

  setZoom(z) { this.zoom = z; this._syncZoomSel(); this._drawView(); }

  /** The zoom menu shows the zoom, a wheel zoom (say 650 %) as its own entry. */
  _syncZoomSel() {
    const std = ZOOMS.some(([v]) => String(v) === String(this.zoom));
    let cust = this.zoomSel.querySelector("option[value=custom]");
    if (!std) {
      if (!cust) { cust = h("option", { value: "custom", disabled: true }); this.zoomSel.append(cust); }
      cust.textContent = `${Math.round(this.zoom * 100)} %`;
      this.zoomSel.value = "custom";
    } else { cust?.remove(); this.zoomSel.value = String(this.zoom); }
  }

  setFrame(f) {
    this.f = Math.max(0, Math.min(this.frames - 1, Math.round(f)));
    this._syncTransport();
    this.render();
  }

  step(d) { this.stop(); this.setFrame((this.f + d + this.frames) % this.frames); }

  togglePlay() { if (this.playing) this.stop(); else this.play(); }

  play() {
    if (this.frames <= 1) return;
    this.playing = true;
    this.playBtn.replaceChildren(icon("pause", 15));
    const f0 = this.f, t0 = performance.now();
    if (this.kind === "talk" && this.state?.audio) {
      if (!this.audio) { this.audio = h("audio", { preload: "auto", crossorigin: "anonymous" }); this.audio.src = this._audioUrl || this.url(this.state.audio); }
      this.audio.currentTime = (this.state.audioStart || 0) + f0 / this.fps;
      this.audio.play().catch(() => {});
    }
    const tick = () => {
      if (!this.playing) return;
      const a = this.audio && !this.audio.paused ? this.audio : null;
      let f = a ? Math.floor((a.currentTime - (this.state.audioStart || 0)) * this.fps) : f0 + Math.floor(((performance.now() - t0) / 1000) * this.fps);
      if (f >= this.frames) { this.stop(); this.setFrame(0); this.play(); return; }
      if (f !== this.f) { this.f = f; this._syncTransport(); this.render(); this._drawWave(); }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    try { this.audio?.pause(); } catch { /* */ }
    this.playBtn?.replaceChildren(icon("play", 15));
  }

  _key(e) {
    if (e.target?.closest?.("input[type=color], select")) { if (e.key === "Escape") { e.stopPropagation(); this.close(); } return; }
    const k = e.key;
    let used = true;
    if (k === "Escape") this.close();
    else if (k === " ") this.togglePlay();
    else if (k === "ArrowLeft" || k === ",") this.step(-1);
    else if (k === "ArrowRight" || k === ".") this.step(1);
    else if (/^[1-4]$/.test(k) && !e.target?.closest?.("input")) this.setKind(KINDS[+k - 1]);
    else if (k === "+" || k === "=") this.setZoom(this.zoom === "fit" ? 2 : Math.min(8, this.zoom * 2));
    else if (k === "-") this.setZoom(this.zoom === "fit" || this.zoom <= 1 ? "fit" : this.zoom / 2);
    else if (k === "0") this.setZoom("fit");
    else if (k === "f" || k === "F") this.setCompare(this.compare === "flicker" ? "off" : "flicker");
    else used = false;
    e.stopPropagation();
    if (used) e.preventDefault();
  }

  // -------------------------------------------------------------------------------------------- rendering a frame

  /** Render the current frame into this.pass (the pass view) and this.orig, then draw. Stale renders are dropped. */
  async render() {
    this._want = this.f;
    if (this._busy) return;
    this._busy = true;
    try {
      while (this._want != null) {
        const f = this._want; this._want = null;
        const gen = this.gen;
        try { await this._renderFrame(f, gen); } catch (e) { if (gen === this.gen) this._message(String(e.message || e)); }
        if (gen === this.gen) this._drawView();
      }
    } finally { this._busy = false; }
  }

  async _renderFrame(f, gen) {
    const s = this.state;
    if (!s) return;
    const W = s.w || 1, H = s.h || 1;
    let origSrc = null;
    if (s.orig) { try { origSrc = await s.orig.at(f); } catch { origSrc = null; } }
    if (gen !== this.gen) return;
    if (origSrc) drawTo(this.orig, origSrc, W, H); else { this.orig.width = W; this.orig.height = H; }
    this._hasOrig = !!origSrc;
    if (this.kind === "matte") await this._renderMatte(f, W, H, gen);
    else if (this.kind === "pose") await this._renderPose(f, W, H, gen);
    else if (this.kind === "talk") await this._renderTalk(f, W, H);
    else if (this.kind === "depth") await this._renderDepth(f, W, H, gen);
  }

  /** The matte (alpha 0-255 per pixel) and the cut-out (premultiplied colour) of frame f. */
  async _matteOf(f, W, H) {
    const s = this.state;
    const cut = canvas(W, H), g = ctx2d(cut);
    let alpha;
    if (s.cut) {
      const im = await s.cut(f);
      g.drawImage(im, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      alpha = new Uint8Array(W * H);
      for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
    } else {
      alpha = s.mask(f) || new Uint8Array(W * H);
      g.drawImage(this.orig, 0, 0, W, H);
      const id = g.getImageData(0, 0, W, H);
      for (let i = 0; i < alpha.length; i++) { const k = alpha[i] / 255; id.data[i * 4] *= k; id.data[i * 4 + 1] *= k; id.data[i * 4 + 2] *= k; id.data[i * 4 + 3] = alpha[i]; }
      g.putImageData(id, 0, 0);
    }
    return { cut, alpha };
  }

  async _renderMatte(f, W, H, gen) {
    const { cut, alpha } = await this._matteOf(f, W, H);
    if (gen !== this.gen) return;
    const p = this.pass; p.width = W; p.height = H;
    const g = ctx2d(p);
    const st = edgeBand(alpha, W, H);
    if (this.mode === "matte") {
      const id = g.createImageData(W, H);
      for (let i = 0; i < alpha.length; i++) { const v = alpha[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
      g.putImageData(id, 0, 0);
    } else if (this.mode === "over") {
      this._paintBg(g, W, H);
      g.drawImage(cut, 0, 0);
    } else if (this.mode === "ruby") {
      if (!this._hasOrig) g.drawImage(cut, 0, 0);
      else {
        g.drawImage(this.orig, 0, 0);
        const id = g.getImageData(0, 0, W, H);
        rubylith(id.data, alpha);
        g.putImageData(id, 0, 0);
      }
    } else if (this.mode === "edge") {
      g.drawImage(this._hasOrig ? this.orig : cut, 0, 0);
      const id = g.getImageData(0, 0, W, H), d = id.data;
      for (let i = 0; i < alpha.length; i++) {
        const q = i * 4;
        if (st.band[i]) {   // in the band: magenta (alpha near 0) through yellow (near 1)
          const a = alpha[i] / 255;
          d[q] = 255; d[q + 1] = Math.round(40 + 215 * a); d[q + 2] = Math.round(220 * (1 - a)); d[q + 3] = 255;
        } else {            // outside: the picture, dark and grey, so the band stands out
          const l = (d[q] * 0.299 + d[q + 1] * 0.587 + d[q + 2] * 0.114) * (alpha[i] > 127 ? 0.32 : 0.14);
          d[q] = d[q + 1] = d[q + 2] = l;
        }
      }
      g.putImageData(id, 0, 0);
    }
    const kept = alpha.reduce((n, v) => n + (v > 127 ? 1 : 0), 0);
    this.stats.replaceChildren(h("p", {}, h("b", {}, edgeLine(st))),
      h("p", {}, `Kept ${(100 * kept / Math.max(1, W * H)).toFixed(1)} % of the frame · ${W}×${H}`),
      ...(st.bbox ? [h("p", { class: "dim" }, `Band inside x ${st.bbox[0]}-${st.bbox[2]}, y ${st.bbox[1]}-${st.bbox[3]}`)] : []));
  }

  _paintBg(g, W, H) {
    if (this.bg === "checker") {
      const s = Math.max(8, Math.round(Math.min(W, H) / 48));
      for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) { g.fillStyle = ((x / s + y / s) & 1) ? "#9a9a9a" : "#d8d8d8"; g.fillRect(x, y, s, s); }
    } else if (this.bg === "busy") {
      if (!this._busyBg || this._busyBg.width !== W || this._busyBg.height !== H) {
        this._busyBg = canvas(W, H);
        const id = ctx2d(this._busyBg).createImageData(W, H);
        id.data.set(busyBackground(W, H));
        ctx2d(this._busyBg).putImageData(id, 0, 0);
      }
      g.drawImage(this._busyBg, 0, 0);
    } else {
      g.fillStyle = this.bg === "black" ? "#000" : this.bg === "white" ? "#fff" : this.color;
      g.fillRect(0, 0, W, H);
    }
  }

  async _renderPose(f, W, H, gen) {
    const s = this.state;
    const p = this.pass; p.width = W; p.height = H;
    const g = ctx2d(p);
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    if (this._hasOrig) { g.globalAlpha = this.dim; g.drawImage(this.orig, 0, 0); g.globalAlpha = 1; }
    const k = Math.max(1, Math.min(W, H) / 512);
    let people = [];
    let shown = { body: 0, hands: 0, face: 0, low: 0, all: 0 };
    if (s.stagePose) {
      const st = this.host.stage;
      const P = await import("../stage/posepass.mjs");
      const keep = st.frame;
      try { st.setFrameSilent(f); people = P.stagePeople(st, W, H); } finally { st.setFrameSilent(keep); try { st.render?.(); } catch { /* */ } }
      if (gen !== this.gen) return;
      const tri = (pt) => (pt ? [pt[0] / W, pt[1] / H, NaN] : null);
      people = people.map((pp) => ({ body: (pp.body || []).map(tri), hands: (pp.hands || []).map((hd) => (hd ? hd.map(tri) : null)), face: pp.face ? pp.face.map(tri) : null }));
    } else {
      const fr = poseFrame(s.kp, f);
      people = [{ body: fr.body, hands: fr.hands, face: fr.face }];
      if (!s.vector && s.pose && (this.parts.body || this.parts.hands)) {
        try {
          const pv = await s.pose.at(f);
          if (gen !== this.gen) return;
          g.globalCompositeOperation = "screen"; g.drawImage(pv, 0, 0, W, H); g.globalCompositeOperation = "source-over";
        } catch { /* no pose video */ }
      }
    }
    const byConf = this.parts.conf && !s.stagePose;
    const visible = (pt) => pt && pt[0] >= 0 && pt[1] >= 0 && !(pt[2] <= 0);
    const col = (pt, fallback) => (byConf && Number.isFinite(pt?.[2]) ? confColor(pt[2]) : fallback);
    const X = (pt) => pt[0] * W, Y = (pt) => pt[1] * H;
    for (const pp of people) {
      if (this.parts.body && pp.body) {
        LIMBS.forEach(([i, j], n) => {
          const A = pp.body[i], B = pp.body[j];
          if (!visible(A) || !visible(B)) return;
          g.strokeStyle = byConf ? col({ 2: Math.min(A[2], B[2]) }, "") : `rgba(${LCOL[n].join(",")},0.8)`;
          g.lineWidth = 4 * k; g.lineCap = "round";
          g.beginPath(); g.moveTo(X(A), Y(A)); g.lineTo(X(B), Y(B)); g.stroke();
        });
        pp.body.forEach((pt, i) => {
          shown.all++;
          if (!visible(pt)) return;
          shown.body++; if (pt[2] < 0.3) shown.low++;
          g.fillStyle = col(pt, `rgb(${LCOL[i].join(",")})`);
          g.beginPath(); g.arc(X(pt), Y(pt), 4.5 * k, 0, Math.PI * 2); g.fill();
          g.strokeStyle = "#000"; g.lineWidth = 1; g.stroke();
        });
      }
      if (this.parts.hands) for (const hd of pp.hands || []) {
        if (!hd) continue;
        HAND.forEach(([i, j], n) => {
          const A = hd[i], B = hd[j];
          if (!visible(A) || !visible(B)) return;
          const c = byConf ? col({ 2: Math.min(A[2], B[2]) }, "") : `hsl(${Math.round((n / HAND.length) * 360)},100%,55%)`;
          g.strokeStyle = c; g.lineWidth = 2 * k;
          g.beginPath(); g.moveTo(X(A), Y(A)); g.lineTo(X(B), Y(B)); g.stroke();
        });
        for (const pt of hd) {
          shown.all++;
          if (!visible(pt)) continue;
          shown.hands++; if (pt[2] < 0.3) shown.low++;
          g.fillStyle = col(pt, "#2d6bff"); g.beginPath(); g.arc(X(pt), Y(pt), 2.6 * k, 0, Math.PI * 2); g.fill();
        }
      }
      if (this.parts.face && pp.face) {
        pp.face.forEach((pt, i) => {
          shown.all++;
          if (!visible(pt)) return;
          shown.face++; if (pt[2] < 0.3) shown.low++;
          g.fillStyle = col(pt, i >= 68 ? "#00e5ff" : "#ffffff");
          g.beginPath(); g.arc(X(pt), Y(pt), (i >= 68 ? 2.4 : 1.8) * k, 0, Math.PI * 2); g.fill();
          if (this.parts.numbers) { g.fillStyle = "#f2ff59"; g.font = `${Math.max(7, 6 * k)}px ui-monospace, monospace`; g.fillText(String(i), X(pt) + 2.5 * k, Y(pt) - 2 * k); }
        });
      }
    }
    const fr = s.kp ? poseFrame(s.kp, f) : null;
    this.stats.replaceChildren(
      h("p", {}, h("b", {}, s.stagePose ? `${people.length} ${people.length === 1 ? "person" : "people"} on the stage at this frame`
        : `Seen: ${shown.body ? `${shown.body} body · ` : ""}${shown.hands ? `${shown.hands} hand · ` : ""}${shown.face} face points`)),
      ...(byConf && shown.low ? [h("p", {}, `${shown.low} point${shown.low === 1 ? "" : "s"} below 0.3 confidence on this frame.`)] : []),
      ...(s.asset ? [h("p", { class: "dim" }, `Face read on ${Math.round((s.asset.face_seen || 0) * 100)} % of ${s.asset.frames} frames${fr?.mouth != null ? ` · mouth open ${fr.mouth.toFixed(3)}` : ""}`)] : []));
  }

  async _renderTalk(f, W, H) {
    const s = this.state;
    const p = this.pass;
    const fr = s.kp ? poseFrame(s.kp, f) : null;
    const box = this.mouthZoom && fr?.face ? mouthBox(fr.face) : null;
    if (box) {
      const sx = box[0] * W, sy = box[1] * H, sw = (box[2] - box[0]) * W, sh = (box[3] - box[1]) * H;
      const S = 512;
      p.width = S; p.height = Math.round(S * sh / sw);
      const g = ctx2d(p);
      g.imageSmoothingEnabled = true;
      g.drawImage(this.orig, sx, sy, sw, sh, 0, 0, p.width, p.height);
      g.fillStyle = "#f2ff59";
      for (const pt of fr.face.slice(48, 68)) if (pt && pt[2] > 0) { g.beginPath(); g.arc((pt[0] * W - sx) * p.width / sw, (pt[1] * H - sy) * p.height / sh, 3, 0, Math.PI * 2); g.fill(); }
    } else {
      p.width = W; p.height = H;
      const g = ctx2d(p);
      g.drawImage(this.orig, 0, 0);
      if (fr?.face) {
        const k = Math.max(1, Math.min(W, H) / 512);
        fr.face.forEach((pt, i) => { if (!pt || pt[2] <= 0) return; g.fillStyle = i >= 48 && i < 68 ? "#f2ff59" : "rgba(255,255,255,.55)"; g.beginPath(); g.arc(pt[0] * W, pt[1] * H, (i >= 48 ? 2.2 : 1.4) * k, 0, Math.PI * 2); g.fill(); });
      }
    }
    this._drawWave();
    this._talkStats(f);
  }

  _talkStats(f) {
    const s = this.state, a = s.asset;
    const kids = [];
    if (a) {
      const m = a.mouth?.[f];
      kids.push(h("p", {}, h("b", {}, m == null ? "Mouth not read on this frame" : `Mouth open ${m.toFixed(3)}`), " (inner-lip gap over face height)"));
      if (a.onsets?.length) kids.push(h("p", {}, `${a.onsets.length} mouth openings: ${a.onsets.map((t) => `${t.toFixed(2)} s`).join(", ")}`));
      if (s.res?.frames) {
        const curve = s.res.frames.map((x) => x?.mouth ?? null);
        const r = pearson(a.mouth || [], curve), lag = bestLag(a.mouth || [], curve);
        kids.push(h("p", {}, h("b", {}, `Lip sync: r = ${r == null ? "n/a" : r.toFixed(2)}`), lag ? ` (best at ${lag.lag > 0 ? "+" : ""}${lag.lag} frames, r = ${lag.r.toFixed(2)})` : "",
          ". The yellow line is the actor, the blue line the render."));
        kids.push(h("p", { class: "dim" }, a.result_note || "The render's mouth was read with DWPose offline."));
      } else kids.push(h("p", { class: "dim" }, "No lip-sync measure: the App doesn't read the render's mouth yet (Milestone 25 measured r = 0.92 offline, with DWPose on the result)."));
    }
    if (this._waveInfo) kids.push(h("p", { class: "dim" }, this._waveInfo));
    this.stats.replaceChildren(...kids);
  }

  async _renderDepth(f, W, H, gen) {
    const s = this.state;
    let src;
    if (s.stageDepth) {
      const st = this.host.stage;
      try { src = st.renderFrameTo("depth", f, { shot: s.stageDepth }); } catch (e) { throw new Error(`the stage couldn't draw depth (${e.message})`); }
      W = s.w = st.fw; H = s.h = st.fh;
    } else src = await s.depthOf(f);
    if (gen !== this.gen) return;
    const p = this.pass; drawTo(p, src, W, H);
    const g = ctx2d(p);
    const id = g.getImageData(0, 0, W, H), d = id.data;
    let lo = 1, hi = 0;
    for (let q = 0; q < d.length; q += 4) {
      const v = d[q] / 255;
      if (v > 0.002) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const t = remapDepth(v, this.far, this.near);
      if (this.depthMode === "turbo") { const c = turbo(t); d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; }
      else d[q] = d[q + 1] = d[q + 2] = Math.round(t * 255);
      d[q + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    if (this.orig.width !== W || this.orig.height !== H) { const o = canvas(W, H); ctx2d(o).drawImage(this.orig, 0, 0, W, H); this.orig = o; }
    const fmt = (v) => (s.metres ? `${stageMetres(v).toFixed(1)} m` : `${Math.round(v * 100)} %`);
    this.stats.replaceChildren(h("p", {}, h("b", {}, hi >= lo ? `On this frame: nearest ${fmt(hi)}, farthest ${fmt(lo)}` : "Nothing in range on this frame")),
      h("p", { class: "dim" }, s.metres ? "8-bit stage depth: steps of about 0.15 m." : "depth_vis is normalised per frame, so its grey levels don't compare across frames."));
  }

  // -------------------------------------------------------------------------------------------- the view (zoom, pan, compare)

  _content() {
    const P = this.pass, O = this.orig;
    const W = P.width, H = P.height;
    const c = this.comp;
    const orig = this._hasOrig && this.kind !== "talk";
    if (this.compare === "side" && orig) {
      const gap = Math.round(W * 0.02);
      c.width = W * 2 + gap; c.height = H;
      const g = c.getContext("2d");
      g.fillStyle = "#111"; g.fillRect(0, 0, c.width, H);
      g.drawImage(O, 0, 0, W, H); g.drawImage(P, W + gap, 0);
      return c;
    }
    if (this.compare === "wipe" && orig) {
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      g.drawImage(P, 0, 0);
      const x = Math.round(W * this.split);
      g.drawImage(O, 0, 0, x, H * (O.height / H), 0, 0, x, H);
      g.fillStyle = "#f2ff59"; g.fillRect(x - 1, 0, 2, H);
      return c;
    }
    if (this.compare === "flicker" && orig && this._showOrig) return O;
    return P;
  }

  _scale(C) {
    const cw = this.cv.clientWidth || 1, ch = this.cv.clientHeight || 1;
    const fit = Math.min(cw / C.width, ch / C.height);
    return this.zoom === "fit" ? fit : this.zoom;
  }

  _drawView() {
    if (this.el.hidden || !this.state) return;
    const C = this._content();
    if (!C.width || !C.height) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, this.cv.clientWidth), ch = Math.max(1, this.cv.clientHeight);
    if (this.cv.width !== Math.round(cw * dpr) || this.cv.height !== Math.round(ch * dpr)) { this.cv.width = Math.round(cw * dpr); this.cv.height = Math.round(ch * dpr); }
    const g = this.cv.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#0b0a0d"; g.fillRect(0, 0, this.cv.width, this.cv.height);
    const s = this._scale(C);
    if (this.zoom === "fit") { this.cx = 0.5; this.cy = 0.5; }
    const dw = C.width * s, dh = C.height * s;
    // keep the pan inside the picture
    const minCx = Math.min(0.5, cw / 2 / dw), minCy = Math.min(0.5, ch / 2 / dh);
    this.cx = Math.max(minCx, Math.min(1 - minCx, this.cx)); this.cy = Math.max(minCy, Math.min(1 - minCy, this.cy));
    const ox = cw / 2 - this.cx * dw, oy = ch / 2 - this.cy * dh;
    this._xf = { s, ox, oy, W: C.width, H: C.height };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = s < 1.99;   // 200 % and up: square pixels, so an edge can be judged pixel by pixel
    g.drawImage(C, ox, oy, dw, dh);
    const pct = Math.round(s * 100);
    this.zoomTag.textContent = `${pct} %${this.zoom === "fit" ? " (fit)" : ""}`;
    const ab = this.compare === "flicker" && this._hasOrig ? (this._showOrig ? "B · original" : "A · pass") : this.compare === "wipe" && this._hasOrig ? "original | pass" : this.compare === "side" && this._hasOrig ? "original · pass" : "";
    this.abTag.hidden = !ab; this.abTag.textContent = ab;
  }

  _wireView() {
    let drag = null;
    this.cv.addEventListener("wheel", (e) => {
      if (!this._xf) return;
      e.preventDefault();
      const r = this.cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const { s, ox, oy, W, H } = this._xf;
      const px = (mx - ox) / (W * s), py = (my - oy) / (H * s);   // 0-1 in the picture under the cursor
      const next = Math.max(0.1, Math.min(8, s * (e.deltaY < 0 ? 1.25 : 0.8)));
      this.zoom = next; this._syncZoomSel();
      // keep that point under the cursor
      const dw = W * next, dh = H * next;
      this.cx = (r.width / 2 - mx) / dw + px; this.cy = (r.height / 2 - my) / dh + py;
      this._drawView();
    }, { passive: false });
    this.cv.addEventListener("pointerdown", (e) => {
      if (!this._xf) return;
      const r = this.cv.getBoundingClientRect();
      const { s, ox, W } = this._xf;
      const splitX = ox + W * s * this.split;
      const wipe = this.compare === "wipe" && this._hasOrig && Math.abs(e.clientX - r.left - splitX) < 14;
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, wipe };
      this.cv.setPointerCapture?.(e.pointerId);
      this.el.focus({ preventScroll: true });
    });
    this.cv.addEventListener("pointermove", (e) => {
      if (!this._xf) return;
      const r = this.cv.getBoundingClientRect();
      const { s, ox, W, H } = this._xf;
      if (!drag) { this.cv.style.cursor = this.compare === "wipe" && Math.abs(e.clientX - r.left - (ox + W * s * this.split)) < 14 ? "ew-resize" : this.zoom === "fit" ? "default" : "grab"; return; }
      if (drag.wipe) { this.split = Math.max(0, Math.min(1, (e.clientX - r.left - ox) / (W * s))); this._drawView(); return; }
      if (this.zoom === "fit") return;
      this.cx = drag.cx - (e.clientX - drag.x) / (W * s); this.cy = drag.cy - (e.clientY - drag.y) / (H * s);
      this._drawView();
    });
    const end = () => { drag = null; };
    this.cv.addEventListener("pointerup", end);
    this.cv.addEventListener("pointercancel", end);
    this.cv.addEventListener("dblclick", () => this.setZoom(this.zoom === "fit" ? 2 : "fit"));
  }

  // -------------------------------------------------------------------------------------------- the talk strip

  async _loadWave(gen) {
    this._wave = null; this._waveInfo = "";
    if (this.audio) { this.audio.pause(); this.audio = null; }
    const path = this.state?.audio;
    if (!path) { this._waveInfo = "No sound to draw."; this._drawWave(); return; }
    try {
      const r = await fetch(this.url(path));
      if (!r.ok) throw new Error(`${r.status}`);
      const buf = await r.arrayBuffer();
      // play from this copy: a seek into a streamed file needs Range requests the static demo host may not answer
      if (this._audioUrl) URL.revokeObjectURL(this._audioUrl);
      this._audioUrl = URL.createObjectURL(new Blob([buf], { type: r.headers.get("Content-Type") || "video/mp4" }));
      if (this.audio) { this.audio.pause(); this.audio = null; }
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ac = new AC(1, 2, 44100);
      const audio = await ac.decodeAudioData(buf);
      if (gen !== this.gen) return;
      // the part of the sound under the timeline (a Video → 3D clip starts at its trim)
      const st = Math.floor((this.state.audioStart || 0) * audio.sampleRate);
      const len = Math.floor((this.frames / (this.fps || 24)) * audio.sampleRate);
      const data = audio.getChannelData(0).subarray(Math.min(st, audio.length), Math.min(audio.length, st + len));
      this._wave = { data, seconds: data.length / audio.sampleRate };
      this._waveInfo = `Sound: ${audio.duration.toFixed(2)} s, ${audio.sampleRate} Hz`;
    } catch (e) {
      if (gen !== this.gen) return;
      this._waveInfo = /decode|EncodingError|Unable/i.test(String(e?.message || e?.name)) ? "This clip has no sound track the browser can read." : `The sound didn't load (${e.message || e}).`;
    }
    this._drawWave();
    this._talkStats(this.f);
  }

  _drawWave() {
    if (this.waveRow.hidden) return;
    const c = this.wave, dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, c.clientWidth), ch = Math.max(1, c.clientHeight);
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "rgba(255,255,255,.04)"; g.fillRect(0, 0, cw, ch);
    const total = this.frames / (this.fps || 24);
    const mid = ch / 2;
    if (this._wave) {
      const cols = peaks(this._wave.data, Math.round(cw));
      const sx = Math.min(1, this._wave.seconds / Math.max(1e-6, total));
      g.fillStyle = "rgba(160,200,255,.55)";
      cols.forEach(([lo, hi], i) => { const x = i * sx; g.fillRect(x, mid - hi * mid * 0.95, Math.max(1, sx), Math.max(1, (hi - lo) * mid * 0.95)); });
    }
    const curve = (vals, color) => {
      if (!vals?.length) return;
      const max = Math.max(0.05, ...vals.filter((v) => v != null));
      g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const x = ((i + 0.5) / this.frames) * cw, y = ch - 3 - (v / max) * (ch - 8);
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      });
      g.stroke();
    };
    const a = this.state?.asset;
    if (a) {
      curve(a.mouth, "#f2ff59");
      if (this.state.res?.frames) curve(this.state.res.frames.map((x) => x?.mouth ?? null), "#5fb3ff");
      g.fillStyle = "#f2ff59";
      for (const t of a.onsets || []) g.fillRect((t / total) * cw - 0.5, 0, 1, 6);
    }
    const x = ((this.f + 0.5) / Math.max(1, this.frames)) * cw;
    g.fillStyle = "#ffffff"; g.fillRect(x - 0.5, 0, 1.5, ch);
    g.fillStyle = "rgba(240,239,237,.7)"; g.font = "10px ui-sans-serif, system-ui";
    g.fillText(a ? "sound · mouth open (yellow)" + (this.state.res ? " · render (blue)" : "") : "sound", 6, 12);
  }

  _waveSeek(e) {
    e.stopPropagation();
    const r = this.wave.getBoundingClientRect();
    const f = Math.floor(((e.clientX - r.left) / Math.max(1, r.width)) * this.frames);
    const wasPlaying = this.playing;
    this.stop();
    this.setFrame(f);
    if (wasPlaying) this.play();
  }

  // -------------------------------------------------------------------------------------------- export

  exportStill() {
    const shot = this.subject?.shot?.name || this.subject?.shot?.id || "shot";
    const mode = this.kind === "matte" ? `${this.mode}${this.mode === "over" ? `_${this.bg}` : ""}` : this.kind === "depth" ? this.depthMode : this.compare;
    const name = stillName(shot, this.kind, mode, this.f);
    this.cv.toBlob((b) => {
      if (!b) { this.host.say?.("Couldn't make the still."); return; }
      const u = URL.createObjectURL(b);
      const a = h("a", { href: u, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30000);
      this.host.say?.(`Saved ${name}.`);
    }, "image/png");
  }
}

// ------------------------------------------------------------------------------------------------ wiring into the App

/** The Passes button: a take card or row (small), the Ladder bar, the Video → 3D bar. */
export function passesButton(getSubject, open, { small = false, label = null, title = "Passes: judge the matte, pose, talking and depth by eye" } = {}) {
  const b = h("button", { type: "button", class: `ss-pv-btn${small ? " sm" : ""}`, title, "aria-label": title, "data-act": "passes" },
    icon("layers", small ? 12 : 13), small ? null : h("span", {}, label || "Passes"));
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); open(typeof getSubject === "function" ? getSubject() : getSubject); });
  return b;
}

/**
 * host = { api, stage, pipeline, ladder, say(msg), v2sSource() -> {url, start} (the Video → 3D clip as the Identical? bar plays it) }. Returns { open(subject), decorate(el, take, shot, where), ladderParts(), v2sButton(), viewer }.
 */
export function attachPasses(host) {
  ensureCss();
  const { stage, pipeline, ladder } = host;
  const demo = host.api?.clientId === "demo";
  let viewer = null;
  const get = () => (viewer ||= new PassesViewer({ api: host.api, stage, say: host.say, demo }));
  const open = (subject) => get().open(subject);
  const chosenOf = (sid) => { try { return pipeline?.chosen?.[sid] || null; } catch { return null; } };

  function decorate(el, take, shot, where = "card") {
    if (!el || !take?.url || take.kind === "previz") return;
    if (el.querySelector(":scope > .ss-pv-btn")) return;
    const b = passesButton(() => ({ from: "take", shot: { id: shot.id, name: shot.name }, take, chosen: chosenOf(shot.id), label: `${shot.name || shot.id} · Tk ${take.n || 1}` }),
      open, { small: where === "card", label: where === "row" ? "Passes" : null, title: `Passes of take ${take.n || 1}${take.label ? ` (${take.label})` : ""}: matte, pose, talking, depth` });
    const tk = where === "card" ? el.querySelector(":scope > button.tk") : null;
    if (tk) el.insertBefore(b, tk); else el.append(b);   // a takes row gets one more grid column for it (passes.css)
  }

  function ladderParts() {
    const s = ladder?.sources || {};
    const rung = [4, 3, 2].find((r) => s[r]?.url);
    const sh = stage.activeShot();
    const take = rung == null ? null : { id: `ladder_${rung}`, kind: rung === 4 ? "final" : rung === 3 ? "draft" : "look", url: s[rung].url, video: rung !== 2, label: rung === 4 ? "Final" : rung === 3 ? "Draft" : "Frame" };
    return [passesButton(() => ({ from: "ladder", shot: { id: sh.id, name: sh.name }, take, chosen: chosenOf(sh.id), label: `${sh.name} · ${take?.label || "Review"}` }), open,
      { title: "Passes of the layer on view: matte, pose, talking, depth" })];
  }

  function v2sSubject() {
    const sh = stage.activeShot();
    // the clip as the Identical? bar plays it (its own upload name and trim start), when the App has the bar up
    let source = null;
    try { source = host.v2sSource?.() || null; } catch { source = null; }
    return { from: "v2s", shot: { id: sh?.id, name: sh?.name || "Source camera" }, source, label: `${sh?.name || "Video → 3D"} · the clip` };
  }
  const v2sButton = () => passesButton(v2sSubject, open, { title: "Passes of the source clip: its masks, the captured body, sound and depth" });

  if (ladder) {
    const prev = ladder.extraBar;
    ladder.extraBar = () => [...(prev?.() || []), ...ladderParts()];
    try { ladder._drawBar(); } catch { /* not built */ }
  }
  return { open, decorate, ladderParts, v2sButton, openV2s: () => open(v2sSubject()), get viewer() { return viewer; } };
}
