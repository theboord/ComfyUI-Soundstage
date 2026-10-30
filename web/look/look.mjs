// Soundstage LOOK panel: Cinema-Studio-style look controls (camera body, lens character, aperture, film stock,
// colour palette, genre -> subgenre, national cinema / movement, era, director technique, mood, energy, grade,
// "describe the scene") with a live preview of the two compiled prompts.
//
//   const panel = new LookPanel(container, () => sceneJSON, { fetchApi: api.fetchApi.bind(api) });
//   panel.onChange = (look) => { lookWidget.value = JSON.stringify(look); };
//   panel.load(savedLook);  panel.refresh();  // after the stage changes
//   panel.toJSON();         panel.dispose();
//
// The preview is compiled on the server (POST /soundstage/look/compile, soundstage/look/routes.py) by the same
// code the SoundstageLook node runs, so what you see is exactly what the node outputs. Self-contained: imports
// only ./vocab.mjs, injects its own CSS, no ComfyUI imports (pass fetchApi to respect ComfyUI's base path).
import { VOCAB } from "./vocab.mjs";
import { bodyIcon, lensIcon, fovIcon, irisIcon, injectGearCss } from "../ui/cinegear.mjs";

const CSS = `
.ss-look { display:flex; flex-direction:column; gap:8px; padding:6px; background:#16191e; border-radius:6px;
  font:12px/1.3 -apple-system, "Segoe UI", sans-serif; color:#cfd5de; box-sizing:border-box; width:100%; }
.ss-look * { box-sizing:border-box; }
.ss-look h4 { margin:2px 0 0; font-family:inherit; font-size:11px; font-weight:600; line-height:1.2; letter-spacing:.06em; text-transform:uppercase; color:#7d8694; }
.ss-look-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.ss-look-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:6px 10px; }
.ss-look label.ss-f { display:flex; flex-direction:column; gap:3px; min-width:0; }
.ss-look label.ss-f > span { color:#9aa3b0; font-size:11px; }
.ss-look select, .ss-look input[type=text], .ss-look textarea { background:#0f1216; color:#e6e9ee; border:1px solid #39404b;
  border-radius:4px; padding:4px 6px; font:inherit; width:100%; min-width:0; }
.ss-look textarea { resize:vertical; }
.ss-look select:focus-visible, .ss-look input:focus-visible, .ss-look textarea:focus-visible, .ss-look button:focus-visible
  { outline:2px solid #e39a40; outline-offset:1px; }
.ss-look input[type=range] { accent-color:#e39a40; width:100%; }
.ss-look :disabled { opacity:.45; cursor:default; }
.ss-look .ss-btn { background:#262b33; color:#cfd5de; border:1px solid #39404b; border-radius:4px; padding:3px 9px;
  cursor:pointer; font:inherit; white-space:nowrap; }
.ss-look .ss-btn:hover { border-color:#e39a40; }
.ss-look .ss-btn.ss-primary { background:#e39a40; color:#16191e; border-color:#e39a40; font-weight:600; }
.ss-look .ss-hint { color:#7d8694; font-size:11px; min-height:13px; }
.ss-look-briefcard { display:block !important; padding:8px 10px; }
.ss-look-briefcard summary { cursor:pointer; font-weight:600; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ss-muted, #9aa3b0); }
.ss-look-brief { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:6px 10px; margin-top:8px; }
.ss-look .ss-kb { color:#cfa36b; font-size:11px; }
.ss-pals { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px, 1fr)); gap:5px; max-height:150px; overflow:auto; padding:1px; }
.ss-pal { display:flex; flex-direction:column; gap:3px; padding:4px; border:1px solid #2c323b; border-radius:4px;
  background:#1c2026; cursor:pointer; text-align:left; color:#cfd5de; font:inherit; font-size:11px; }
.ss-pal[aria-pressed=true] { border-color:#e39a40; box-shadow:0 0 0 1px #e39a40 inset; }
.ss-pal .ss-strip { display:flex; height:14px; border-radius:2px; overflow:hidden; }
.ss-pal .ss-strip i { flex:1; }
.ss-styles { display:grid; grid-template-columns:repeat(auto-fill, minmax(132px, 1fr)); gap:6px; max-height:230px; overflow:auto; padding:1px; }
.ss-stage button.ss-style { display:flex !important; flex-direction:column !important; align-items:stretch !important; gap:3px !important; border-radius:10px !important; padding:6px !important; text-align:left; }
.ss-stage button.ss-style .ss-strip { display:flex !important; flex-direction:row !important; height:14px; width:100%; border-radius:4px; overflow:hidden; }
.ss-stage button.ss-style .ss-strip i { flex:1 1 0 !important; height:100% !important; display:block; }
.ss-stage button.ss-style .nm { font-size:12px; font-weight:600; }
.ss-stage button.ss-style .gp { font-size:10px; color:var(--ss-muted,#a9a3ad); }
.ss-stage button.ss-style[aria-pressed=true] { border-color:var(--ss-accent,#F2FF59) !important; }
.ss-stylenotes { margin:8px 0; padding:10px 12px; border-radius:12px; background:rgba(242,255,89,.05); border:1px solid rgba(242,255,89,.2); font-size:12px; line-height:1.45; }
.ss-stylenotes p { margin:4px 0; } .ss-stylenotes ul { margin:4px 0 4px 16px; padding:0; } .ss-stylenotes .refs { color:var(--ss-muted,#a9a3ad); }
.ss-stage .ss-gear button.gear.sugg span::after { content:' ★'; color:var(--ss-accent,#F2FF59); }
.ss-stage button.ss-pal { display:flex !important; flex-direction:column !important; align-items:stretch !important; gap:4px !important; border-radius:10px !important; padding:5px !important; min-width:0; }
.ss-stage button.ss-pal .ss-strip { display:flex !important; flex-direction:row !important; flex-wrap:nowrap !important; height:18px; width:100%; border-radius:5px; overflow:hidden; }
.ss-stage button.ss-pal .ss-strip i { flex:1 1 0 !important; width:auto !important; min-width:6px; height:100% !important; display:block; }
.ss-stage button.ss-pal span { font-size:11px; text-align:left; }
.ss-stage button.ss-pal[aria-pressed=true] { border-color:var(--ss-accent,#F2FF59) !important; }
.ss-pal span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-sw { display:flex; flex-direction:column; align-items:center; gap:2px; }
.ss-sw input[type=color] { width:34px; height:26px; padding:0; border:1px solid #39404b; border-radius:4px; background:none; cursor:pointer; }
.ss-sw input[type=text] { width:66px; font-size:11px; padding:2px 4px; text-align:center; }
.ss-sw button { background:none; border:none; color:#7d8694; cursor:pointer; font-size:11px; padding:0; }
.ss-grade { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:4px 12px; }
.ss-grade label { display:grid; grid-template-columns:62px 1fr 34px; align-items:center; gap:6px; }
.ss-grade output { text-align:right; font-variant-numeric:tabular-nums; color:#fff; }
.ss-prev { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:8px; }
.ss-prev > div { display:flex; flex-direction:column; gap:4px; min-width:0; }
.ss-prev textarea { min-height:110px; color:#e6e9ee; background:#0b0d10; font:11.5px/1.4 ui-monospace, Menlo, monospace; }
.ss-prev .ss-neg { min-height:38px; color:#c7a0a0; }
.ss-prevhead { display:flex; align-items:center; gap:6px; }
.ss-prevhead b { color:#e39a40; font-size:11px; letter-spacing:.05em; text-transform:uppercase; }
.ss-prevhead .ss-btn { margin-left:auto; padding:1px 7px; font-size:11px; }
.ss-notes { color:#e39a40; font-size:11px; }
.ss-chip { background:#3a2810; color:#e39a40; border-radius:999px; padding:1px 8px; font-size:11px; }
`;

function injectCss() {
  if (document.getElementById("soundstage-look-css")) return;
  const s = document.createElement("style");
  s.id = "soundstage-look-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
};

export const DEFAULT_LOOK = Object.freeze({
  version: 1, camera_body: "auto", lens: "auto", aperture: "auto", film_stock: "auto",
  palette: { preset: "auto", name: "", swatches: [] },
  genre: "general", subgenre: "", movement: "auto", era: "auto", technique: "auto",
  mood: "auto", mood_intensity: 0.5, energy: "auto",
  grade: { contrast: 0, saturation: 0, warmth: 0, grain: 0, halation: 0, vignette: 0 },
  description: "", negative: "", description_cast: "", style: "",
  brief: { world: "", atmosphere: "", surfaces: "", furniture: "", colour: "", light: "", outside: "" },
});

// Restyle brief (after 3D Jutsu's final-render brief): one line per aspect of the target world.
const BRIEF = [
  ["world", "Target world", "e.g. a rain-soaked Seoul back street in 1998"],
  ["atmosphere", "Air / atmosphere", "e.g. humid haze, steam from vents"],
  ["surfaces", "Surfaces (walls, floor, ceiling)", "e.g. wet asphalt, tiled walls, rusted shutters"],
  ["furniture", "Furniture / set dressing state", "e.g. worn, cluttered, plastic chairs stacked"],
  ["colour", "Colour", "e.g. cold green fluorescents against warm skin"],
  ["light", "Light", "e.g. one sodium lamp, neon spill from the left"],
  ["outside", "Outside the windows", "e.g. a neon-lit alley, rain streaks"],
];

const clone = (o) => JSON.parse(JSON.stringify(o));
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const normHex = (h) => {
  const m = HEX.exec((h || "").trim());
  if (!m) return null;
  const s = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return "#" + s.toLowerCase();
};

const FOCALS = [14, 18, 24, 28, 35, 50, 65, 85, 100, 135];

// field -> [vocab list, label, tooltip]
const SELECTS = [
  ["camera_body", "camera_bodies", "Camera body", "Sensor / film format the image is captured on"],
  ["lens", "lenses", "Lens character", "How the glass renders: sharpness, bokeh, flares. Focal length stays on the Stage camera"],
  ["aperture", "apertures", "Aperture", "Depth of field"],
  ["film_stock", "film_stocks", "Film stock / sensor look", "Emulsion, lab process or video format"],
  ["genre", "genres", "Genre", "Genre logic: framing, light and pacing"],
  ["subgenre", null, "Subgenre", "Narrows the genre"],
  ["movement", "movements", "National cinema / movement", "Film movement or national cinema"],
  ["era", "eras", "Era", "When the film looks like it was made"],
  ["technique", "techniques", "Director technique", "Named by what it does. Diamond = from the cinematic knowledge base"],
  ["mood", "moods", "Mood / emotion", "Emotion the shot should produce"],
  ["energy", "energies", "Energy", "Pacing of the motion (LTX prompt only)"],
];

/** k-means swatches from an image file (5 colours, sorted dark to light). */
async function swatchesFromImage(file, k = 5) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) px.push([d[i], d[i + 1], d[i + 2]]);
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  px.sort((a, b) => lum(a) - lum(b));
  let cent = Array.from({ length: k }, (_, j) => [...px[Math.floor(((j + 0.5) / k) * px.length)]]);
  for (let it = 0; it < 12; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let best = 0, bd = Infinity;
      cent.forEach((q, j) => {
        const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (dd < bd) { bd = dd; best = j; }
      });
      const s = sum[best];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    cent = cent.map((q, j) => (sum[j][3] ? sum[j].slice(0, 3).map((v) => v / sum[j][3]) : q));
  }
  return cent.sort((a, b) => lum(a) - lum(b))
    .map((q) => "#" + q.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""));
}

function randomPalette() {
  const h = Math.random() * 360, comp = (h + 150 + Math.random() * 60) % 360;
  const hsl = (H, S, L) => {
    const a = S * Math.min(L, 1 - L);
    const f = (n) => { const kk = (n + H / 30) % 12; return L - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)); };
    return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  };
  return [hsl(h, 0.5, 0.1), hsl(h, 0.45, 0.28), hsl(h, 0.35, 0.55), hsl(comp, 0.6, 0.6), hsl(comp, 0.5, 0.82)];
}

export class LookPanel {
  /**
   * @param {HTMLElement} container  where the panel mounts
   * @param {() => object|null} getScene  current stage scene JSON (stage.toJSON(), ideally + lighting_prompt)
   * @param {{fetchApi?: (path: string, init?: object) => Promise<Response>, debounceMs?: number}} [options]
   */
  constructor(container, getScene, options = {}) {
    injectCss();
    this.getScene = getScene || (() => null);
    this.fetchApi = options.fetchApi || ((path, init) => fetch(path, init));
    this.debounceMs = options.debounceMs ?? 250;
    this.getFocal = options.getFocal || null;     // the Stage camera's focal length (Focal length column)
    this.setFocal = options.setFocal || null;
    this.onChange = null;
    this.state = clone(DEFAULT_LOOK);
    this._seq = 0;
    this.root = el("div", { class: "ss-look" });
    container.appendChild(this.root);
    this._build();
    this._sync();
    this._ro = new ResizeObserver(() => {
      const w = this.root.clientWidth;
      if (w > 0 && !this._wasVisible) this.refresh();   // the tab was just shown: the stage may have changed
      this._wasVisible = w > 0;
    });
    this._ro.observe(this.root);
  }

  // ---------- public API ----------
  toJSON() { return clone(this.state); }

  load(json) {
    let data = json;
    if (typeof json === "string") {
      try { data = json.trim() ? JSON.parse(json) : {}; } catch { data = {}; }
    }
    const s = clone(DEFAULT_LOOK);
    if (data && typeof data === "object") {
      for (const k of Object.keys(s)) if (data[k] !== undefined) s[k] = clone(data[k]);
      if (typeof s.palette === "string") s.palette = { preset: s.palette, name: "", swatches: [] };
      s.palette = { ...DEFAULT_LOOK.palette, ...(s.palette || {}) };
      const preset = this._opt("palettes", s.palette.preset);
      if (preset && !(s.palette.swatches || []).length) {
        s.palette.swatches = [...preset.swatches];
        s.palette.name = s.palette.name || (preset.id === "auto" ? "" : preset.label);
      }
      s.grade = { ...DEFAULT_LOOK.grade, ...(s.grade || {}) };
      s.brief = { ...DEFAULT_LOOK.brief, ...(s.brief && typeof s.brief === "object" ? s.brief : {}) };
    }
    this.state = s;
    this._sync();
    this.refresh();
  }

  /** Recompile the preview (call after the stage scene changes). */
  refresh() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this._compile(), this.debounceMs);
  }

  dispose() {
    clearTimeout(this._t);
    this._ro?.disconnect();
    this.root.remove();
  }

  // ---------- state ----------
  _set(patch) {
    Object.assign(this.state, patch);
    this._sync();
    this.onChange?.(this.toJSON());
    this.refresh();
  }

  _opt(list, id) { return (VOCAB[list] || []).find((o) => o.id === id); }

  _subgenres() { return this._opt("genres", this.state.genre)?.subgenres || []; }

  // ---------- build ----------
  _build() {
    const r = this.root;
    // Type a look
    this.typed = el("input", { type: "text", placeholder: "Type a look: Korean thriller, anamorphic, teal-orange…",
      "aria-label": "Type a look", onkeydown: (e) => { if (e.key === "Enter") this._parseTyped(); } });
    r.append(el("div", { class: "ss-look-row" }, this.typed,
      el("button", { class: "ss-btn ss-primary", type: "button", onclick: () => this._parseTyped() }, "Apply"),
      el("button", { class: "ss-btn", type: "button", title: "Reset every look control",
        onclick: () => { this.load(DEFAULT_LOOK); this.onChange?.(this.toJSON()); } }, "Reset")));
    this.typedNote = el("div", { class: "ss-hint" });
    r.append(this.typedNote);

    // Describe the scene
    this.desc = el("textarea", { rows: 2, placeholder: "Describe the scene: who they are, wardrobe, props, place details. "
      + "Blocking, lens and time of day come from the Stage.", "aria-label": "Describe the scene",
      oninput: () => { this.state.description = this.desc.value; this.onChange?.(this.toJSON()); this.refresh(); } });
    r.append(el("h4", {}, "Describe the scene"), this.desc);

    // Styles: one click sets the whole package for a genre / movement (from the film-language research).
    r.append(el("h4", {}, "Style"));
    this.styleHost = el("div", { class: "ss-styles" });
    this.styleNotes = el("div", { class: "ss-stylenotes", hidden: "" });
    r.append(this.styleHost, this.styleNotes);
    this._loadStyles();

    // Camera package: Body / Lens / Focal length / Aperture as picture cards (like a camera rental sheet).
    injectGearCss();
    r.append(el("h4", {}, "Camera"));
    this.gear = this.makeGear();
    r.append(this.gear);
    // Camera & look selects
    r.append(el("h4", {}, "Style"));
    const grid = el("div", { class: "ss-look-grid" });
    this.sel = {};
    for (const [field, list, label, tip] of SELECTS) {
      const s = el("select", { "aria-label": label, title: tip,
        onchange: () => {
          const patch = { [field]: s.value };
          if (field === "genre") patch.subgenre = "";
          this._set(patch);
        } });
      this.sel[field] = { s, list };
      const f = el("label", { class: "ss-f" }, el("span", {}, label), s);
      if (["camera_body", "lens", "aperture"].includes(field)) f.hidden = true;   // shown as cards above
      if (field === "mood") {
        this.intensity = el("input", { type: "range", min: 0, max: 1, step: 0.05, "aria-label": "Mood intensity",
          title: "Intensity: low = a faint undertone, high = full intensity",
          oninput: () => { this.state.mood_intensity = +this.intensity.value; this.onChange?.(this.toJSON()); this.refresh(); } });
        f.append(this.intensity);
      }
      grid.append(f);
    }
    r.append(grid);
    this.hint = el("div", { class: "ss-hint" });
    r.append(this.hint);

    // Palette
    r.append(el("h4", {}, "Colour palette"));
    this.pals = el("div", { class: "ss-pals", role: "listbox", "aria-label": "Palette presets" });
    for (const p of VOCAB.palettes) {
      const strip = el("div", { class: "ss-strip" },
        ...(p.swatches.length ? p.swatches : ["#262b33"]).map((h) => el("i", { style: `background:${h}` })));
      const b = el("button", { class: "ss-pal", type: "button", title: p.hint || p.still || "No palette logic",
        "aria-pressed": "false", "data-id": p.id,
        onclick: () => this._set({ palette: { preset: p.id, name: p.id === "auto" ? "" : p.label, swatches: [...p.swatches] } }) },
        strip, el("span", {}, p.label));
      this.pals.append(b);
    }
    r.append(this.pals);
    this.swRow = el("div", { class: "ss-look-row" });
    this.palName = el("input", { type: "text", placeholder: "Palette name", style: "width:150px",
      "aria-label": "Palette name",
      oninput: () => { this.state.palette = { ...this.state.palette, name: this.palName.value }; this.onChange?.(this.toJSON()); this.refresh(); } });
    this.fileIn = el("input", { type: "file", accept: "image/*", style: "display:none",
      onchange: async () => {
        const f = this.fileIn.files?.[0];
        if (!f) return;
        try {
          const sw = await swatchesFromImage(f);
          this._set({ palette: { preset: "custom", name: f.name.replace(/\.[^.]+$/, ""), swatches: sw } });
        } catch (e) { this.typedNote.textContent = `Could not read that image: ${e.message}`; }
        this.fileIn.value = "";
      } });
    r.append(el("div", { class: "ss-look-row" }, this.swRow,
      el("button", { class: "ss-btn", type: "button", title: "Add a swatch",
        onclick: () => this._editSwatches((sw) => sw.length < 12 && sw.push(sw[sw.length - 1] || "#808080")) }, "+ Swatch"),
      el("button", { class: "ss-btn", type: "button", onclick: () => this._set({ palette: { preset: "custom", name: "Random", swatches: randomPalette() } }) }, "Randomize"),
      el("button", { class: "ss-btn", type: "button", title: "Extract 5 swatches from a reference image",
        onclick: () => this.fileIn.click() }, "From image…"),
      this.palName, this.fileIn));

    // Grade
    r.append(el("h4", {}, "Grade"));
    const gr = el("div", { class: "ss-grade" });
    this.gradeIn = {};
    for (const [k, spec] of Object.entries(VOCAB.grade)) {
      const out = el("output");
      const inp = el("input", { type: "range", min: spec.min, max: spec.max, step: 0.05, "aria-label": spec.label,
        title: `${spec.low || "none"}  ↔  ${spec.high}`,
        oninput: () => { this.state.grade = { ...this.state.grade, [k]: +inp.value }; out.textContent = (+inp.value).toFixed(2);
          this.onChange?.(this.toJSON()); this.refresh(); } });
      this.gradeIn[k] = { inp, out };
      gr.append(el("label", {}, el("span", {}, spec.label), inp, out));
    }
    r.append(gr);
    this.neg = el("input", { type: "text", placeholder: "Extra negative words (optional)", "aria-label": "Extra negative",
      oninput: () => { this.state.negative = this.neg.value; this.onChange?.(this.toJSON()); this.refresh(); } });
    r.append(this.neg);

    // Restyle brief (collapsible card)
    this.briefIn = {};
    const briefBody = el("div", { class: "ss-look-brief" });
    for (const [key, label, ph] of BRIEF) {
      const inp = el("input", { type: "text", placeholder: ph, "aria-label": label,
        oninput: () => { this.state.brief = { ...this.state.brief, [key]: inp.value }; this._briefCount(); this.onChange?.(this.toJSON()); this.refresh(); } });
      this.briefIn[key] = inp;
      briefBody.append(el("label", { class: "ss-f" }, el("span", {}, label), inp));
    }
    this.briefSum = el("summary", {}, "Restyle brief");
    this.briefCard = el("details", { class: "ss-look-row ss-look-briefcard" }, this.briefSum,
      el("div", { class: "ss-hint" }, "Describes the finished world. The motion prompt always ends by locking layout, placement, scale and camera motion to the stage."),
      briefBody);
    r.append(this.briefCard);

    // Preview
    r.append(el("h4", {}, "Compiled prompts"));
    const box = (title, cls, rows) => {
      const ta = el("textarea", { readonly: "", rows, class: cls || "", "aria-label": title });
      const copy = el("button", { class: "ss-btn", type: "button", onclick: async () => {
        try { await navigator.clipboard.writeText(ta.value); copy.textContent = "Copied"; }
        catch { ta.select(); document.execCommand?.("copy"); copy.textContent = "Copied"; }
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      } }, "Copy");
      return { ta, head: el("div", { class: "ss-prevhead" }, el("b", {}, title), copy) };
    };
    const still = box("Look still · frame 1", "", 6), neg = box("Still negative", "ss-neg", 2), mot = box("Motion · LTX", "", 8);
    this.prevStill = still.ta; this.prevNeg = neg.ta; this.prevMotion = mot.ta;
    r.append(el("div", { class: "ss-prev" },
      el("div", {}, still.head, still.ta, neg.head, neg.ta),
      el("div", {}, mot.head, mot.ta)));
    this.status = el("div", { class: "ss-notes", role: "status" });
    this.kbLine = el("div", { class: "ss-kb" });
    r.append(this.status, this.kbLine);
  }

  _fillSelect(field) {
    const { s, list } = this.sel[field];
    const opts = field === "subgenre"
      ? [{ id: "", label: this._subgenres().length ? "Any" : "—" }, ...this._subgenres()]
      : VOCAB[list];
    const want = this.state[field] ?? "";
    if (s._for !== (field === "subgenre" ? this.state.genre : list)) {
      s.replaceChildren(...opts.map((o) => el("option", { value: o.id, title: o.hint || o.still || "" },
        (o.kb ? "◆ " : "") + o.label + (o.wheel ? "  ·  wheel" : ""))));
      s._for = field === "subgenre" ? this.state.genre : list;
    }
    s.disabled = field === "subgenre" && !this._subgenres().length;
    s.value = opts.some((o) => o.id === want) ? want : opts[0]?.id ?? "";
    if (field === "film_stock") {   // ★ the style's suggested stocks
      const sug = this._style?.suggest?.film_stocks || [];
      for (const o of s.options) {
        const base = o.textContent.replace(/ ★$/, "");
        o.textContent = sug.includes(o.value) ? `${base} ★` : base;
      }
    }
  }

  _editSwatches(fn) {
    const sw = [...(this.state.palette.swatches || [])];
    if (fn(sw) === false) return;
    // Editing a preset makes it custom; drop the preset's own name so the prompt doesn't claim it.
    const preset = this._opt("palettes", this.state.palette.preset);
    const name = preset && this.state.palette.name === preset.label ? "" : this.state.palette.name;
    this._set({ palette: { ...this.state.palette, preset: "custom", name, swatches: sw } });
  }

  _renderSwatches() {
    const sw = this.state.palette.swatches || [];
    this.swRow.replaceChildren(...sw.map((h, i) => {
      const color = el("input", { type: "color", value: normHex(h) || "#808080", "aria-label": `Swatch ${i + 1}` });
      const hex = el("input", { type: "text", value: h, "aria-label": `Swatch ${i + 1} hex`, spellcheck: "false" });
      color.addEventListener("input", () => { hex.value = color.value; });
      color.addEventListener("change", () => this._editSwatches((s) => { s[i] = color.value; }));
      hex.addEventListener("change", () => {
        const v = normHex(hex.value);
        if (!v) { hex.value = h; return; }
        this._editSwatches((s) => { s[i] = v; });
      });
      const del = el("button", { type: "button", title: "Remove swatch", "aria-label": `Remove swatch ${i + 1}`,
        onclick: () => this._editSwatches((s) => { s.splice(i, 1); }) }, "✕");
      return el("div", { class: "ss-sw" }, color, hex, del);
    }));
  }

  _briefCount() {
    const n = Object.values(this.state.brief || {}).filter((v) => (v || "").trim()).length;
    this.briefSum.textContent = n ? `Restyle brief · ${n} set` : "Restyle brief";
  }

  async _loadStyles() {
    try {
      const res = await fetch(new URL("./style_presets.json", import.meta.url), { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      this.styles = Array.isArray(data) ? data : data.styles || [];
    } catch { this.styles = []; }
    for (const host of this._styleHosts || []) this._fillStyles(host);
    this._fillStyles(this.styleHost);
  }

  /** A grid of style cards (can be built more than once: Look tab and the Frame step). */
  makeStyles() {
    const host = el("div", { class: "ss-styles" });
    (this._styleHosts = this._styleHosts || []).push(host);
    if (this.styles) this._fillStyles(host);
    return host;
  }

  _fillStyles(host) {
    if (!host || !this.styles?.length) return;
    host.replaceChildren(...this.styles.map((s) => {
      const pal = this._opt("palettes", s.look?.palette);
      const strip = el("div", { class: "ss-strip" }, ...((pal?.swatches?.length ? pal.swatches : ["#2a2330"]).map((c) => el("i", { style: `background:${c}` }))));
      const b = el("button", { type: "button", class: "ss-style", "data-id": s.id, title: s.summary || s.label,
        onclick: () => this.applyStyle(s.id) }, strip, el("span", { class: "nm" }, s.label), el("span", { class: "gp" }, s.group || ""));
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      return b;
    }));
    this._syncStyles();
  }

  /** Apply a style: the look fields, grade and the Stage lens, plus the director's notes and ★ suggestions. */
  applyStyle(id) {
    const s = (this.styles || []).find((x) => x.id === id);
    if (!s) return;
    const lk = { ...(s.look || {}) };
    const patch = {};
    for (const k of ["camera_body", "lens", "aperture", "film_stock", "genre", "subgenre", "movement", "era", "technique", "mood", "energy"]) {
      if (lk[k] !== undefined) patch[k] = lk[k] || (k === "subgenre" ? "" : "auto");
    }
    if (lk.palette) {
      const p = this._opt("palettes", lk.palette);
      patch.palette = { preset: lk.palette, name: p?.label || "", swatches: [...(p?.swatches || [])] };
    }
    if (lk.grade) patch.grade = { ...this.state.grade, ...lk.grade };
    patch.style = s.id;
    this._set(patch);
    if (s.focal_mm) this.setFocal?.(+s.focal_mm, { fromStyle: true });
    this._syncGear();
  }

  _syncStyles() {
    const id = this.state.style;
    for (const host of [this.styleHost, ...(this._styleHosts || [])]) {
      for (const b of host?.children || []) b.setAttribute("aria-pressed", String(b.dataset.id === id));
    }
    const s = (this.styles || []).find((x) => x.id === id);
    this._style = s || null;
    if (!this.styleNotes) return;
    this.styleNotes.hidden = !s;
    if (!s) return;
    const c = s.craft || {};
    this.styleNotes.replaceChildren(
      el("strong", {}, `${s.label}: director's notes`),
      el("p", {}, s.summary || ""),
      ...[["Lighting", c.lighting], ["Camera", c.camera_movement], ["Framing", c.framing]].filter(([, v]) => v).map(([k, v]) => el("p", {}, el("b", {}, `${k}: `), v)),
      ...(c.shot_tips?.length ? [el("ul", {}, ...c.shot_tips.map((x) => el("li", {}, x)))] : []),
      ...(s.references?.length ? [el("p", { class: "refs" }, "See: " + s.references.join(" · "))] : []),
      el("p", { class: "refs" }, "★ marks the suggested film stocks, lenses, focal lengths and apertures for this style."));
  }

  /** A Body / Lens / Focal length / Aperture picker bound to this look (can be built more than once). */
  makeGear() {
    injectGearCss();
    const root = el("div", { class: "ss-gear" });
    const set = {};
    const col = (title, items, icon, onPick, key) => {
      const c = el("div", { class: "col" }, el("h5", {}, title));
      set[key] = [];
      for (const it of items) {
        const b = el("button", { type: "button", class: "gear", title: it.hint || it.label, "data-id": String(it.id),
          onclick: () => onPick(it.id) });
        b.innerHTML = `<span>${it.label.replace(/</g, "&lt;")}</span>` + icon(it.id);
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        set[key].push(b);
        c.append(b);
      }
      return c;
    };
    const lab = (list) => (VOCAB[list] || []).map((o) => ({ id: o.id, label: o.id === "auto" ? "Auto" : o.label, hint: o.hint }));
    const focals = FOCALS.map((mm) => ({ id: mm, label: `${mm}mm`,
      hint: `${(2 * Math.atan(18 / mm) * 180 / Math.PI).toFixed(0)}° field of view. Sets the Stage camera at the playhead.` }));
    root.append(
      col("Body", lab("camera_bodies"), bodyIcon, (id) => this._set({ camera_body: id }), "camera_body"),
      col("Lens", lab("lenses"), lensIcon, (id) => this._set({ lens: id }), "lens"),
      col("Focal length", focals, fovIcon, (mm) => { this.setFocal?.(mm); this._syncGear(); this.refresh(); }, "focal"),
      col("Aperture", lab("apertures"), irisIcon, (id) => this._set({ aperture: id }), "aperture"));
    (this._gearSets = this._gearSets || []).push(set);
    this._syncGear();
    return root;
  }

  _syncGear() {
    if (!this._gearSets) return;
    const focal = this.getFocal?.();
    const near = focal ? FOCALS.reduce((a, b) => (Math.abs(b - focal) < Math.abs(a - focal) ? b : a)) : null;
    const sg = this._style?.suggest || {};
    const fr = sg.focal_range_mm || null;
    const suggested = { lens: sg.lenses || [], aperture: sg.apertures || [], camera_body: [] };
    for (const set of this._gearSets) for (const [key, btns] of Object.entries(set)) {
      const cur = key === "focal" ? String(near) : String(this.state[key] || "auto");
      for (const b of btns) {
        b.setAttribute("aria-pressed", String(b.dataset.id === cur));
        const star = key === "focal" ? !!fr && +b.dataset.id >= fr[0] && +b.dataset.id <= fr[1] : (suggested[key] || []).includes(b.dataset.id);
        b.classList.toggle("sugg", star);
      }
    }
  }

  _sync() {
    this._syncStyles?.();
    this._syncGear();
    for (const field of Object.keys(this.sel)) this._fillSelect(field);
    for (const [k, inp] of Object.entries(this.briefIn || {})) if (document.activeElement !== inp) inp.value = this.state.brief?.[k] || "";
    if (this.briefSum) this._briefCount();
    if (this.desc.value !== this.state.description) this.desc.value = this.state.description || "";
    this.intensity.value = this.state.mood_intensity ?? 0.5;
    this.intensity.disabled = !this.state.mood || this.state.mood === "auto";
    const pid = this.state.palette.preset || "auto";
    for (const b of this.pals.children) b.setAttribute("aria-pressed", String(b.dataset.id === pid));
    if (document.activeElement !== this.palName) this.palName.value = this.state.palette.name || "";
    this._renderSwatches();
    for (const [k, { inp, out }] of Object.entries(this.gradeIn)) {
      inp.value = this.state.grade[k] ?? 0;
      out.textContent = (+inp.value).toFixed(2);
    }
    if (document.activeElement !== this.neg) this.neg.value = this.state.negative || "";
    // One-line hint for the most specific choice.
    const picks = SELECTS.map(([f, list]) => (f === "subgenre"
      ? this._subgenres().find((o) => o.id === this.state.subgenre)
      : this._opt(list, this.state[f]))).filter((o) => o && o.id !== "auto" && o.id !== "general" && o.id !== "");
    this.hint.textContent = picks.filter((o) => o.hint).map((o) => `${o.label}: ${o.hint}`).join("  ·  ");
  }

  async _parseTyped() {
    const text = this.typed.value.trim();
    if (!text) return;
    try {
      const res = await this.fetchApi("/soundstage/look/parse", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const look = { ...this.toJSON() };
      for (const [k, v] of Object.entries(data.look || {})) {
        if (k === "palette") {
          const p = this._opt("palettes", v.preset);
          look.palette = { preset: v.preset, name: p?.label || "", swatches: [...(p?.swatches || [])] };
        } else if (k === "subgenre") {
          look.subgenre = v;
          look.genre = VOCAB.genres.find((g) => g.subgenres?.some((s) => s.id === v))?.id || look.genre;
        } else look[k] = v;
      }
      this.load(look);
      this.onChange?.(this.toJSON());
      this.typedNote.textContent = (data.matched || []).length
        ? "Applied: " + data.matched.map((m) => m.split(" -> ")[1]).join(", ")
        : "No look words recognised; the text went into the scene description.";
    } catch (e) {
      this.typedNote.textContent = `Could not parse the look (server route missing?): ${e.message}`;
    }
  }

  async _compile() {
    const seq = ++this._seq;
    let scene = null;
    try { scene = this.getScene() || null; } catch { scene = null; }
    try {
      const res = await this.fetchApi("/soundstage/look/compile", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look: this.state, scene }) });
      const data = await res.json();
      if (seq !== this._seq) return;              // a newer edit is already compiling
      if (!res.ok) throw new Error(data.error || res.statusText);
      this.prevStill.value = data.still_prompt;
      this.prevNeg.value = data.still_negative;
      this.prevMotion.value = data.motion_prompt;
      const f1 = data.frame1 || {};
      this.status.textContent = [`Frame 1: ${f1.people ?? "?"} ${f1.people === 1 ? "person" : "people"}, ${f1.size || "?"}, ${Math.round(f1.focal_mm || 0)}mm`,
        ...(data.notes || [])].join("  ·  ");
      this.kbLine.replaceChildren(...(data.kb || []).map((k) => el("span", { title: k.summary }, el("span", { class: "ss-chip" }, k.name), " ", k.summary, " ")));
    } catch (e) {
      if (seq !== this._seq) return;
      this.status.textContent = `Preview unavailable: ${e.message}. The SoundstageLook node still compiles at run time.`;
    }
  }
}

export default LookPanel;
