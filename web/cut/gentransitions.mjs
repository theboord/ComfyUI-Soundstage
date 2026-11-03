// Soundstage Cut: generative transitions. Between two clips pick Smoke, Water bend, Whip pan, Match cut, Light leak,
// Ink bleed, Zoom through or Morph; the App renders a short bridge with LTX-2.5 from A's picture (held exactly at the
// bridge's first frame) to B's picture (a guide at its last frame), with the Seamless-loop bridge graph: no new nodes,
// no new models. It lands in the cut like a sound generated in place: one undoable edit, here as an overlay on V1.
//
// A bridge covers record frames [at - pre, at + post) of an edit: the last `pre` frames of A and the first `post` of
// B. The cut keeps its length, so no sound moves. pre + post is an LTX length (8k + 1). Drag a bridge's ends to change
// them; after a render that makes it stale (its ends would no longer be the pictures it replaces) until re-rendered.
//
// Pure functions (placement, freshness, flatten, slots on the wire) are exported for tests/js/gentransitions.test.mjs;
// soundstage/cut/gentransitions.py is the Python twin (graph, route, the render's flatten). docs/cut.md.
// The CutPanel (web/cut/cut.mjs) calls this class through a few hooks marked "[gen-transitions hook]".

import { openPopover } from "../ui/popover.mjs";

export const MIN_FRAMES = 17;
export const MAX_FRAMES = 97;

// Labels and default lengths; the words the model reads are in soundstage/cut/gentransitions.py (a test keeps the two
// lists the same).
export const STYLES = [
  { id: "smoke", name: "Smoke", frames: 33, blurb: "Smoke rolls in over A and clears on B" },
  { id: "water_bend", name: "Water bend", frames: 41, blurb: "A bends behind moving water; B settles out of it" },
  { id: "whip_pan", name: "Whip pan", frames: 17, blurb: "A fast blurred pan off A that lands on B" },
  { id: "match_cut", name: "Match cut", frames: 17, blurb: "A's main shape holds its place and becomes B's" },
  { id: "light_leak", name: "Light leak", frames: 25, blurb: "A warm film light leak washes A out to B" },
  { id: "ink_bleed", name: "Ink bleed", frames: 41, blurb: "Ink blooms through A and draws back on B" },
  { id: "zoom_through", name: "Zoom through", frames: 25, blurb: "The camera rushes into A and out inside B" },
  { id: "morph", name: "Morph", frames: 49, blurb: "A flows like liquid and reshapes into B" },
];
export const STYLE = Object.fromEntries(STYLES.map((s) => [s.id, s]));

// ------------------------------------------------------------------ pure: lengths and placement

/** The bridge lengths LTX renders (8k + 1), 17 .. min(97, max). */
export function lengths(max = MAX_FRAMES) {
  const out = [];
  for (let n = MIN_FRAMES; n <= Math.min(MAX_FRAMES, max); n += 8) out.push(n);
  return out;
}

/** The nearest LTX length to n that is at most max (ties go short); 0 when even 17 frames don't fit. */
export function snapLength(n, max = MAX_FRAMES) {
  const ok = lengths(max);
  if (!ok.length) return 0;
  return ok.reduce((b, v) => (Math.abs(v - n) < Math.abs(b - n) ? v : b), ok[0]);
}

export const bestRender = (shot) => String(shot?.renders?.final || shot?.renders?.draft || shot?.renders?.look || "");
export const bridgeShotId = (gt) => `gt_${gt.id}`;

/** Index k of the cut event the bridge's edit goes into (A = k - 1), or -1: the occ-th time `from` is followed by `to`. */
export function locate(project, gt) {
  const cut = project.cut || [];
  let n = 0;
  for (let k = 1; k < cut.length; k++) {
    if (String(cut[k - 1].shot_id) === String(gt.from) && String(cut[k].shot_id) === String(gt.to)) {
      if (n === (gt.occ | 0)) return k;
      n++;
    }
  }
  return -1;
}

/** The anchor of edit k (into event k): {from, to, occ}, so the bridge follows its edit through reorders and ripples. */
export function anchorOf(project, k) {
  const cut = project.cut;
  const from = String(cut[k - 1].shot_id), to = String(cut[k].shot_id);
  let occ = 0;
  for (let j = 1; j < k; j++) if (String(cut[j - 1].shot_id) === from && String(cut[j].shot_id) === to) occ++;
  return { from, to, occ };
}

/** The most frames a bridge on edit k may take from A and from B: under half of each clip. */
export function maxSides(project, k) {
  const a = project.cut[k - 1], b = project.cut[k];
  return [Math.max(0, Math.floor((a.out - a.in - 1) / 2)), Math.max(0, Math.floor((b.out - b.in - 1) / 2))];
}

/** Where the bridge sits now: {k, at, pre, post, frames, a_src, b_src}, or null when its edit is gone. */
export function span(project, gt) {
  const k = locate(project, gt);
  if (k < 0) return null;
  const cut = project.cut;
  let at = 0;
  for (let j = 0; j < k; j++) at += cut[j].out - cut[j].in;
  const pre = gt.pre | 0, post = gt.post | 0;
  return { k, at, pre, post, frames: pre + post, a_src: cut[k - 1].out - pre, b_src: cut[k].in + post - 1 };
}

/** [state, why]: "ready" plays and renders; "planned" (not rendered), "stale" (the cut or a render changed under it) and
 *  "lost" (its edit is gone) are drawn but never played. Twin of status() in gentransitions.py. */
export function status(project, gt) {
  const sp = span(project, gt);
  if (!sp) return ["lost", "its cut is gone"];
  const [ma, mb] = maxSides(project, sp.k);
  if (sp.pre > ma || sp.post > mb) return ["stale", "a clip got too short for it"];
  if (!(gt.url || gt.path)) return ["planned", "not rendered yet"];
  const shots = new Map((project.shots || []).map((s) => [String(s.id), s]));
  const a = gt.a || {}, b = gt.b || {};
  if ((gt.rendered_frames | 0) !== sp.frames) return ["stale", "its length changed"];
  if (a.frame !== sp.a_src || b.frame !== sp.b_src) return ["stale", "the cut moved under it"];
  const sa = shots.get(String(gt.from)), sb = shots.get(String(gt.to));
  if (!sa || !sb || (a.media ?? "") !== bestRender(sa) || (b.media ?? "") !== bestRender(sb)) return ["stale", "a clip has a new render"];
  return ["ready", ""];
}

/** Split n frames into {pre, post} that fit the sides (ma, mb), as even as they can be: shrink n when they must.
 *  prefer: a wanted pre (an edge drag keeps the other end where it was when it can). null if 17 frames don't fit. */
export function fitSides(n, ma, mb, prefer = null) {
  const total = snapLength(Math.min(n, ma + mb), ma + mb);
  if (!total) return null;
  let pre = prefer == null ? Math.floor(total / 2) : prefer;
  pre = Math.max(total - mb, Math.min(ma, pre));
  return { pre, post: total - pre };
}

/**
 * A bridge on edit k: {gen_transitions, cut} for one commit. It replaces a bridge already on that edit and the
 * transition into event k (a dissolve under a bridge would never be seen). null when the clips are too short.
 */
export function place(project, k, style, { id = null, frames = null } = {}) {
  if (k < 1 || k >= (project.cut || []).length || !STYLE[style]) return null;
  const [ma, mb] = maxSides(project, k);
  const fit = fitSides(frames || STYLE[style].frames, ma, mb);
  if (!fit) return null;
  const anchor = anchorOf(project, k);
  const list = (project.gen_transitions || []).filter((g) => locate(project, g) !== k);
  const gt = { id: id || Math.random().toString(36).slice(2, 9), style, ...anchor, ...fit, prompt: "", seed: null, quality: "Draft", sound: true };
  const cut = project.cut.map((e, j) => {
    if (j !== k || !e.trans) return e;
    const { trans: _t, ...rest } = e;
    return rest;
  });
  return { gen_transitions: [...list, gt], cut, gt };
}

/** A bridge with its `side` end ("head" = into A, "tail" = into B) dragged to record frame f; length snaps to 8k + 1. */
export function dragEdge(project, gt, side, f) {
  const sp = span(project, gt);
  if (!sp) return gt;
  const [ma, mb] = maxSides(project, sp.k);
  // The dragged end moves; the other stays put unless 8k + 1 can't be met without moving it.
  const total = side === "head" ? snapLength(Math.round(sp.at - f) + sp.post, ma + sp.post)
    : snapLength(sp.pre + Math.round(f - sp.at), sp.pre + mb);
  const fit = total ? fitSides(total, ma, mb, side === "head" ? total - sp.post : sp.pre) : null;
  return fit ? { ...gt, ...fit } : gt;
}

/** The project with every ready bridge cut in as a clip (A shortened by pre, B by post): same length, same sound.
 *  Twin of flatten() in gentransitions.py; the render does it on the server. */
export function flatten(project) {
  const byK = new Map();
  for (const gt of project.gen_transitions || []) if (status(project, gt)[0] === "ready") byK.set(span(project, gt).k, gt);
  if (!byK.size) return project;
  const shots = [...(project.shots || [])], cut = [];
  project.cut.forEach((ev, k) => {
    const e = { ...ev };
    const gin = byK.get(k), gout = byK.get(k + 1);
    if (gin) {
      e.in += gin.post | 0;
      delete e.trans;
      const n = (gin.pre | 0) + (gin.post | 0), sid = bridgeShotId(gin);
      shots.push({ id: sid, name: `GT ${STYLE[gin.style]?.name || "Bridge"}`, frames: n, scene_name: "", setup: "Generative transition",
        scene_offset: 0, renders: { final: gin.url || gin.path }, gen_transition: gin.id });
      cut.push({ shot_id: sid, in: 0, out: n });
    }
    if (gout) e.out -= gout.pre | 0;
    cut.push(e);
  });
  return { ...project, cut, shots };
}

/** The edit (1 .. n-1) nearest record frame f, or -1 with fewer than two clips. */
export function nearestEdit(project, f) {
  let at = 0, best = -1, d = Infinity;
  (project.cut || []).forEach((e, k) => {
    if (k > 0 && Math.abs(at - f) < d) { d = Math.abs(at - f); best = k; }
    at += e.out - e.in;
  });
  return best;
}

/** "/api/view?filename=x.mp4&subfolder=s&type=output" -> "s/x.mp4 [output]" (what the route reads); "" otherwise. */
export function refOfView(url) {
  if (!url) return "";
  let u;
  try { u = new URL(String(url), "http://x"); } catch { return ""; }
  if (!/\/view$/.test(u.pathname)) return "";
  const fn = u.searchParams.get("filename");
  if (!fn) return "";
  const sub = u.searchParams.get("subfolder") || "", type = u.searchParams.get("type") || "output";
  return `${sub ? sub + "/" : ""}${fn} [${type}]`;
}

/** The two pictures of a bridge: {a, b} each {shot_id, frame, media, ref} (ref "" = live clay: capture it). */
export function ends(project, gt) {
  const sp = span(project, gt);
  if (!sp) return null;
  const shot = (id) => (project.shots || []).find((s) => String(s.id) === String(id));
  const side = (id, frame) => { const media = bestRender(shot(id)); return { shot_id: String(id), frame, media, ref: refOfView(media) }; };
  return { a: side(gt.from, sp.a_src), b: side(gt.to, sp.b_src), span: sp };
}

/** The body of POST /soundstage/cut/gentransition. */
export function requestBody(project, gt, e) {
  return { style: gt.style, frames: (gt.pre | 0) + (gt.post | 0), fps: Number(project.fps) || 24, quality: gt.quality === "Final" ? "Final" : "Draft",
    seed: gt.seed ?? 7, prompt: String(gt.prompt || ""), sound: gt.sound !== false,
    a: { ref: e.a.ref, frame: e.a.frame }, b: { ref: e.b.ref, frame: e.b.frame } };
}

/** The SaveVideo file of a /history entry (ComfyUI lists a saved video under images or videos). */
export function fileFromHistory(entry, node = "save") {
  const o = entry?.outputs?.[node] || {};
  const f = (o.videos || o.images || o.gifs || [])[0];
  return f && f.filename ? { filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" } : null;
}

// ------------------------------------------------------------------ host: queue a bridge on ComfyUI

/**
 * generateTransition(req) for CutPanel: req = {body, captures: {a?: canvas, b?: canvas}}. A captured canvas (a clip that
 * is live clay, no render on disk) is uploaded first. Then the route builds the graph, it is queued as one prompt and
 * the SaveVideo file comes back as {url, path}.
 */
export function makeTransitionGenerator(api, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const post = async (path, body) => {
    const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || (r.status === 404 ? "this server needs a restart to know the transition route" : `HTTP ${r.status}`));
    return j;
  };
  const upload = async (canvas, name) => {
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("image", blob, name);
    fd.append("type", "input");
    fd.append("subfolder", "soundstage_private/gentrans");
    fd.append("overwrite", "true");
    const r = await api.fetchApi("/upload/image", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`upload answered ${r.status}`);
    const j = await r.json();
    return `${j.subfolder ? j.subfolder + "/" : ""}${j.name} [${j.type || "input"}]`;
  };
  return async ({ body, captures = {} }) => {
    const b = JSON.parse(JSON.stringify(body));
    for (const side of ["a", "b"]) {
      if (!b[side].ref && captures[side]) b[side] = { ref: await upload(captures[side], `clay_${side}_${Date.now()}.png`), frame: 0 };
      if (!b[side].ref) throw new Error(`clip ${side.toUpperCase()} has no picture to start from`);
    }
    const g = await post("/soundstage/cut/gentransition", b);
    const q = await api.fetchApi("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: g.prompt, client_id: api.clientId ?? api.initialClientId }) });
    const qj = await q.json().catch(() => ({}));
    if (!q.ok || !qj.prompt_id) throw new Error(qj.error?.message || JSON.stringify(qj.node_errors || qj).slice(0, 200));
    const pid = qj.prompt_id, t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      if (Date.now() - t0 > timeoutMs) throw new Error("timed out");
      let h;
      try { h = (await (await api.fetchApi(`/history/${pid}`)).json())[pid]; } catch { continue; }
      if (!h) continue;
      if (h.status?.status_str === "error") throw new Error("the bridge render failed (see the ComfyUI log)");
      if (!h.status?.completed) continue;
      const f = fileFromHistory(h, "save");
      if (!f) throw new Error("the render saved no video");
      return { url: api.apiURL(`/view?${new URLSearchParams(f)}`), path: `${f.subfolder ? f.subfolder + "/" : ""}${f.filename}`,
        seconds: g.seconds, size: g.size, pictures: { a: g.a, b: g.b } };
    }
  };
}

// ------------------------------------------------------------------ UI layer over the CutPanel

const CSS = `
.ss-gt-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;cursor:pointer;
  background:linear-gradient(90deg,#4c3a8f,#7652b3);color:#fff;font:600 11px 'Soundstage Grotesk',ui-sans-serif,system-ui,sans-serif;user-select:none}
.ss-gt-chip:hover{filter:brightness(1.15)}
.ss-gt-menu{background:#1b1f26;border:1px solid #3a414c;border-radius:8px;padding:6px;
  display:grid;grid-template-columns:repeat(2,minmax(150px,1fr));gap:4px;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:calc(100vw - 32px)}
.ss-gt-menu button{all:unset;cursor:pointer;padding:6px 8px;border-radius:6px;color:#e9edf2;font:600 12px ui-sans-serif,system-ui,sans-serif}
.ss-gt-menu button small{display:block;font-weight:400;color:#9aa3af;font-size:10.5px;margin-top:2px}
.ss-gt-menu button:hover,.ss-gt-menu button:focus{background:#2a3140}
.ss-gt-card{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 8px;background:#1d1830;border-top:1px solid #4c3a8f;
  color:#e9edf2;font:12px ui-sans-serif,system-ui,sans-serif}
.ss-gt-card[hidden]{display:none}
.ss-gt-card select,.ss-gt-card input{background:#12151a;color:#e9edf2;border:1px solid #3a414c;border-radius:4px;font:12px ui-sans-serif,system-ui,sans-serif;padding:2px 4px}
.ss-gt-card input[type=text]{flex:1;min-width:120px}
.ss-gt-card button{background:#2a3140;color:#e9edf2;border:1px solid #3a414c;border-radius:4px;padding:2px 8px;cursor:pointer;font:600 12px ui-sans-serif,system-ui,sans-serif}
.ss-gt-card button.go{background:#7652b3;border-color:#9a7be0}
.ss-gt-card .st{color:#c9b8f5}
`;

function injectCSS() {
  if (typeof document === "undefined" || document.getElementById("ss-gt-css")) return;
  const s = document.createElement("style");
  s.id = "ss-gt-css";
  s.textContent = CSS;
  document.head.append(s);
}

const COLOR = { ready: "#7652b3", planned: "rgba(118,82,179,.35)", stale: "rgba(227,154,64,.55)", lost: "rgba(120,120,120,.4)" };
const EDGE_PX = 6;

export class GenTransitions {
  /**
   * @param {object} panel  the CutPanel (reads project, frame, fps; edits through panel._commit so Undo covers them)
   * @param {{generate?: Function, slot?: HTMLElement}} opts  generate: makeTransitionGenerator(api); slot: where the chip goes
   */
  constructor(panel, { generate = null, slot = null } = {}) {
    this.panel = panel;
    this.generate = generate;
    this.sel = null;              // selected bridge id
    this.busy = new Map();        // id -> "rendering" (not in the project: an undo can't resurrect a spinner)
    this.videos = new Map();      // url -> <video>
    this._drag = null;
    injectCSS();
    if (slot && typeof document !== "undefined") this._mount(slot);
    if (panel.root) panel.root.addEventListener("keydown", (e) => this._key(e), true);
  }

  get project() { return this.panel.project; }
  get list() { return this.project.gen_transitions || []; }
  byId(id) { return this.list.find((g) => g.id === id) || null; }

  // ---------------------------------------------------------------- edits (each one undoable)

  _commit(list, cut = this.project.cut) {
    this.panel._commit(cut, this.panel.sel, { gen_transitions: list });
  }

  /** Put a bridge of `style` on the edit nearest the playhead (or edit k). Returns its id, or null. */
  add(style, k = nearestEdit(this.project, Math.floor(this.panel.frame))) {
    if (k < 1) { this.panel.say("A generative transition goes between two clips: put two clips in the cut first.", { error: true }); return null; }
    const r = place(this.project, k, style);
    if (!r) { this.panel.say("These clips are too short for a bridge: it needs 17 frames, under half of each clip.", { error: true }); return null; }
    this._commit(r.gen_transitions, r.cut);
    this.select(r.gt.id);
    this.panel.say(`${STYLE[style].name} planned on the cut at ${this._tc(span(this.project, r.gt).at)}: ${r.gt.pre + r.gt.post} frames. Render it to see it.`);
    return r.gt.id;
  }

  update(id, patch) {
    const list = this.list.map((g) => (g.id === id ? { ...g, ...patch, id } : g));
    this._commit(list);
  }

  remove(id) {
    if (!this.byId(id)) return;
    this._commit(this.list.filter((g) => g.id !== id));
    if (this.sel === id) this.select(null);
    this.panel.say("Generative transition removed (⌘Z brings it back).");
  }

  /** Set the length (snapped to 8k + 1, centred on the cut, fitted to the clips). */
  setLength(id, frames) {
    const g = this.byId(id), sp = g && span(this.project, g);
    if (!sp) return;
    const [ma, mb] = maxSides(this.project, sp.k);
    const fit = fitSides(frames, ma, mb);
    if (fit) this.update(id, fit);
  }

  /** Render (or re-render) a bridge on the GPU, then put it in place: one undoable edit. */
  async render(id) {
    const g0 = this.byId(id);
    if (!g0) return false;
    if (!this.generate) { this.panel.say("Generative transitions render in the App (they need ComfyUI and LTX-2.5).", { error: true }); return false; }
    const e = ends(this.project, g0);
    if (!e) { this.panel.say("This bridge's cut is gone.", { error: true }); return false; }
    const captures = {};
    for (const side of ["a", "b"]) {
      if (e[side].ref) continue;
      const c = this.panel._renderPreviewFrame?.(e[side].shot_id, e[side].frame);
      if (c) captures[side] = c;
    }
    const seed = g0.seed ?? Math.floor(Math.random() * 2 ** 31);
    const body = requestBody(this.project, { ...g0, seed }, e);
    this.busy.set(id, "rendering");
    this.panel.requestDraw();
    this._card();
    this.panel.say(`Rendering ${STYLE[g0.style].name} (${body.frames} frames, ${body.quality}) on the GPU…`);
    try {
      const res = await this.generate({ body, captures });
      const g = this.byId(id);
      if (!g) { this.panel.say(`The bridge was removed while it rendered; its file is ${res.path}.`); return false; }
      this.update(id, { url: res.url, path: res.path, seed, rendered_frames: body.frames,
        a: { frame: e.a.frame, media: e.a.media }, b: { frame: e.b.frame, media: e.b.media } });
      const st = status(this.project, this.byId(id));
      this.panel.say(st[0] === "ready" ? `${STYLE[g.style].name} is in the cut. ▶ Preview plays it; ⌘Z takes it out.`
        : `${STYLE[g.style].name} rendered, but ${st[1]} while it ran: render it again.`, { error: st[0] !== "ready" });
      return st[0] === "ready";
    } catch (err) {
      this.panel.say(`Couldn't render the transition: ${err.message || err}`, { error: true });
      return false;
    } finally {
      this.busy.delete(id);
      this._card();
      this.panel.requestDraw();
    }
  }

  /** Play the bridge with a second of each clip around it. */
  preview(id) {
    const sp = span(this.project, this.byId(id) || {});
    if (!sp) return;
    const fps = Number(this.project.fps) || 24;
    this.panel.stop?.();
    this.panel.seek?.(Math.max(0, sp.at - sp.pre - Math.round(fps)));
    const end = sp.at + sp.post + Math.round(fps);
    this.panel.play?.(1);
    const stopAt = () => {
      if (!this.panel.speed) return;
      if (this.panel.frame >= end) { this.panel.stop(); return; }
      requestAnimationFrame(stopAt);
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(stopAt);
  }

  select(id) {
    this.sel = id;
    if (id) { this.panel.tSel = null; this.panel.aSel = null; }
    this._card();
    this.panel.requestDraw?.();
  }

  // ---------------------------------------------------------------- chip, menu, card

  _mount(slot) {
    const chip = document.createElement("span");
    chip.className = "ss-gt-chip";
    chip.textContent = "✦ Generative";
    chip.title = "Generative transitions: a short LTX-2.5 bridge from A's last picture to B's first (Smoke, Water bend, Whip pan, Match cut, Light leak, Ink bleed, Zoom through, Morph). It goes on the cut nearest the playhead.";
    chip.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); this._menu(chip); });
    slot.append(chip);
    this.chip = chip;
    const card = document.createElement("div");
    card.className = "ss-gt-card";
    card.hidden = true;
    for (const t of ["pointerdown", "keydown", "wheel"]) card.addEventListener(t, (e) => e.stopPropagation());
    (slot.closest?.(".ss-cut-bar") || slot).after(card);
    this.cardEl = card;
  }

  _menu(anchor) {
    if (this._pop) { this._pop.close("toggle"); return; }
    const m = document.createElement("div");
    m.className = "ss-gt-menu";
    m.setAttribute("role", "menu");
    for (const s of STYLES) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.append(s.name, Object.assign(document.createElement("small"), { textContent: `${s.blurb} · ${(s.frames / (this.panel.rate || 24)).toFixed(1)} s` }));
      b.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      b.addEventListener("click", () => { this._pop?.close("item"); this.add(s.id); });
      m.append(b);
    }
    // the App's pop-over layer (ui/popover.mjs): flipped and clamped to the window; Esc, outside click and arrows
    this._pop = openPopover(m, { anchor, theme: this.panel.tl || null, themeClasses: false, name: "cut-gentrans", focus: "first",
      onClose: () => { this._pop = null; } });
  }

  _card() {
    const el = this.cardEl;
    if (!el) return;
    const g = this.sel && this.byId(this.sel);
    if (!g) { el.hidden = true; el.replaceChildren(); return; }
    el.hidden = false;
    const [st, why] = status(this.project, g);
    const sp = span(this.project, g);
    const busy = this.busy.has(g.id);
    const mk = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const style = mk("select", { title: "Style" });
    for (const s of STYLES) style.append(new Option(s.name, s.id, false, s.id === g.style));
    style.onchange = () => this.update(g.id, { style: style.value });
    const len = mk("select", { title: "Length (LTX renders 8k + 1 frames); or drag the bridge's ends on V1" });
    const max = sp ? maxSides(this.project, sp.k).reduce((a, b) => a + b, 0) : MAX_FRAMES;
    const fps = this.panel.rate || Number(this.project.fps) || 24;
    for (const n of lengths(max)) len.append(new Option(`${n} f · ${(n / fps).toFixed(2)} s`, n, false, n === g.pre + g.post));
    len.onchange = () => this.setLength(g.id, +len.value);
    const words = mk("input", { type: "text", value: g.prompt || "", placeholder: "Optional: what the bridge shows (e.g. \"the smoke is red\")" });
    words.onchange = () => this.update(g.id, { prompt: words.value });
    const q = mk("select", { title: "Draft: 544 px, one pass. Final: x2 latent upsample and a refine with both pictures again" });
    for (const v of ["Draft", "Final"]) q.append(new Option(v, v, false, v === (g.quality || "Draft")));
    q.onchange = () => this.update(g.id, { quality: q.value });
    const snd = mk("label", { title: "Keep the bridge's own generated sound in the render" });
    const cb = mk("input", { type: "checkbox", checked: g.sound !== false });
    cb.onchange = () => this.update(g.id, { sound: cb.checked });
    snd.append(cb, " sound");
    const go = mk("button", { className: "go", textContent: busy ? "Rendering…" : st === "ready" ? "Re-render" : "Render (GPU)", disabled: busy || st === "lost" });
    go.onclick = () => { if (st === "ready") this.update(g.id, { seed: null }); this.render(g.id); };
    const pv = mk("button", { textContent: "▶ Preview", disabled: !sp, title: "Play the bridge with a second of each clip around it" });
    pv.onclick = () => this.preview(g.id);
    const rm = mk("button", { textContent: "Remove", title: "Remove the bridge (⌫); ⌘Z brings it back" });
    rm.onclick = () => this.remove(g.id);
    const label = { ready: "in the cut", planned: "planned: render it", stale: `stale: ${why}, render it again`, lost: why }[st];
    el.replaceChildren(mk("b", { textContent: "✦ Bridge" }), style, len, words, q, snd, go, pv, rm,
      mk("span", { className: "st", textContent: busy ? "rendering on the GPU…" : label }));
  }

  _key(e) {
    if (!this.sel || e.target?.closest?.(".ss-gt-card, input, textarea, select, [contenteditable]")) return;
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.remove(this.sel);
    } else if (e.key === "Escape") {
      e.stopImmediatePropagation();
      this.select(null);
    }
  }

  // ---------------------------------------------------------------- timeline (hooks from CutPanel)

  _bars() {
    const P = this.panel, out = [];
    const y = P._ty + P._L.th - 18;
    for (const g of this.list) {
      const sp = span(this.project, g);
      if (!sp) continue;
      out.push({ g, sp, x0: P._x(sp.at - sp.pre), x1: P._x(sp.at + sp.post), y, h: 16 });
    }
    return out;
  }

  /** [gen-transitions hook] draw the bridges on V1, under the transition bars. */
  drawTimeline(ctx, w) {
    if (!this.list.length) return;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    for (const b of this._bars()) {
      if (b.x1 < 0 || b.x0 > w) continue;
      const [st] = status(this.project, b.g);
      const busy = this.busy.has(b.g.id), ww = Math.max(6, b.x1 - b.x0);
      ctx.save();
      ctx.beginPath(); ctx.rect(b.x0, b.y, ww, b.h); ctx.clip();
      ctx.fillStyle = COLOR[st];
      ctx.fillRect(b.x0, b.y, ww, b.h);
      if (st !== "ready" || busy) {   // hatching: not playing (moving while it renders)
        ctx.strokeStyle = busy ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.35)";
        const off = busy ? (now / 40) % 8 : 0;
        for (let x = b.x0 - b.h + off; x < b.x0 + ww; x += 8) { ctx.beginPath(); ctx.moveTo(x, b.y + b.h); ctx.lineTo(x + b.h, b.y); ctx.stroke(); }
      }
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(b.x0, b.y, 3, b.h); ctx.fillRect(b.x0 + ww - 3, b.y, 3, b.h);   // the duration handles
      if (ww > 44) {
        ctx.fillStyle = "#fff"; ctx.font = "700 9px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(`✦ ${STYLE[b.g.style]?.name || "?"} ${b.sp.frames}`, b.x0 + ww / 2, b.y + b.h / 2 + 0.5);
      }
      ctx.restore();
      if (b.g.id === this.sel) { ctx.strokeStyle = "#e39a40"; ctx.lineWidth = 2; ctx.strokeRect(b.x0, b.y, ww, b.h); ctx.lineWidth = 1; }
    }
    if (this.busy.size) this.panel.requestDraw();
  }

  /** [gen-transitions hook] a pointer down on the timeline: true when it was on a bridge (selected / edge drag). */
  pointerDown(e, x, y) {
    const hit = this._bars().find((b) => y >= b.y - 2 && y <= b.y + b.h + 2 && x >= b.x0 - EDGE_PX && x <= Math.max(b.x1, b.x0 + 6) + EDGE_PX);
    if (!hit) { if (this.sel) this.select(null); return false; }
    e.stopPropagation?.();
    this.panel.stop?.();
    this.select(hit.g.id);
    const side = x <= hit.x0 + EDGE_PX ? "head" : x >= hit.x1 - EDGE_PX ? "tail" : null;
    if (!side) return true;
    const orig = hit.g;
    const P = this.panel;
    const frameAt = (cx) => (cx - P._x(0)) / P.ppf;
    const move = (ev) => {
      const r = P.tl.getBoundingClientRect();
      const next = dragEdge(this.project, orig, side, frameAt(ev.clientX - r.left));
      this._drag = next;
      this.project.gen_transitions = this.list.map((g) => (g.id === orig.id ? next : g));   // live, committed on up
      P.requestDraw();
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      const next = this._drag;
      this._drag = null;
      this.project.gen_transitions = this.list.map((g) => (g.id === orig.id ? orig : g));
      if (next && (next.pre !== orig.pre || next.post !== orig.post)) {
        this.update(orig.id, { pre: next.pre, post: next.post });
        const st = status(this.project, this.byId(orig.id));
        this.panel.say(`Bridge: ${next.pre + next.post} frames${st[0] === "stale" ? " · stale until you render it again" : ""}.`);
      }
      this._card();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    return true;
  }

  // ---------------------------------------------------------------- viewer (hook from CutPanel)

  _video(url) {
    let v = this.videos.get(url);
    if (!v) {
      v = Object.assign(document.createElement("video"), { muted: true, preload: "auto", playsInline: true });
      const redraw = () => this.panel.requestDraw?.();
      v.addEventListener("loadeddata", redraw);
      v.addEventListener("seeked", redraw);
      // Like the panel's own clips: a server without HTTP Range makes the video unseekable, so play it from memory.
      v.addEventListener("loadedmetadata", () => {
        const sk = v.seekable;
        if (v.dataset.blob || (sk.length && sk.end(sk.length - 1) >= v.duration - 0.05)) return;
        v.dataset.blob = "pending";
        fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(r.status))).then((b) => {
          v.dataset.blob = URL.createObjectURL(b);
          v.src = v.dataset.blob;
        }).catch(() => {});
      });
      v.src = url;
      this.videos.set(url, v);
    }
    return v;
  }

  /** The ready bridge covering record frame f: {g, i (its frame)}, or null. */
  at(f) {
    for (const g of this.list) {
      const sp = span(this.project, g);
      if (!sp || f < sp.at - sp.pre || f >= sp.at + sp.post) continue;
      if (status(this.project, g)[0] !== "ready") return null;
      return { g, i: f - (sp.at - sp.pre) };
    }
    return null;
  }

  /** [gen-transitions hook] draw the bridge over the picture where one plays. */
  drawViewer(ctx, f, W, H) {
    const hit = this.at(f);
    if (!hit) return false;
    const v = this._video(hit.g.url || hit.g.path);
    const fps = this.panel.rate || Number(this.project.fps) || 24;
    const want = (hit.i + 0.5) / fps;
    const P = this.panel;
    if (P.speed === 1) {
      if (Math.abs(v.currentTime - want) * fps > 2 && !v.seeking) v.currentTime = want;
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - want) * fps > 0.5) v.currentTime = want;
    }
    if (v.readyState < 2 || !v.videoWidth) { if (!P.speed) setTimeout(() => P.requestDraw(), 60); return false; }
    const s = Math.min(W / v.videoWidth, H / v.videoHeight), dw = v.videoWidth * s, dh = v.videoHeight * s;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.save();
    ctx.font = "700 12px 'Soundstage Grotesk', ui-sans-serif, system-ui, sans-serif";
    const label = `✦ ${STYLE[hit.g.style]?.name || "BRIDGE"} ${hit.i + 1}/${hit.g.pre + hit.g.post}`.toUpperCase();
    const tw = ctx.measureText(label).width + 14;
    ctx.fillStyle = COLOR.ready; ctx.fillRect(W / 2 - tw / 2, 10, tw, 20);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, W / 2, 20.5);
    ctx.restore();
    return true;
  }

  stopVideos() { for (const v of this.videos.values()) if (!v.paused) v.pause(); }

  _tc(f) {
    const fps = Math.round(Number(this.project.fps) || 24);
    const s = Math.floor(f / fps);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}:${String(f % fps).padStart(2, "0")}`;
  }
}
