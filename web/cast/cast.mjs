// ② Cast & Locations: everyone and everything the shots need to keep consistent. The list comes from the script's
// breakdown (characters who speak, props / vehicles / animals in the action, each scene's location), or from the stage
// when there is no script. Each item gets a description and a reference picture (upload a character sheet / photo, or
// generate one with FLUX 3 Klein). References flow into ④ Frame's references by name, so a face, a costume, a car or a
// diner looks the same in every shot.
//
//   const cast = new CastPanel(el, { getScript, getStage, load, save, upload, generate, applyRefs, onStatus });
//   cast.render();
import { icon } from "../ui/icons.mjs";
import { CLOTHES } from "./shotcast.mjs";

const CSS = `
.ss-cast { display:flex; flex-direction:column; gap:14px; padding:4px 2px 12px; }
.ss-cast .head { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; }
.ss-cast .head h2 { margin:0; font-size:20px; font-weight:700; }
.ss-cast .head .sub { opacity:.7; max-width:72ch; }
.ss-cast .grow { flex:1; }
.ss-cast section { display:flex; flex-direction:column; gap:8px; }
.ss-cast section > .sh { display:flex; align-items:center; gap:8px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; font-size:12px; opacity:.85; }
.ss-cast section > .sh .count { opacity:.6; font-weight:600; }
.ss-cast .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(var(--ss-cast-tile, 210px), 1fr)); gap:12px; }
.ss-cast .sizes { display:inline-flex; gap:4px; align-items:center; font-size:12px; }
.ss-cast .sizes .lbl { opacity:.65; margin-right:2px; }
.ss-cast .sizes button[aria-pressed="true"] { background:#f2ff59; color:#111; border-color:#f2ff59; font-weight:650; }
.ss-cast .pic img { cursor:zoom-in; }
.ss-cast .card { display:flex; flex-direction:column; gap:8px; padding:10px; border-radius:14px; background:rgba(255,255,255,.035);
  border:1px solid rgba(255,255,255,.08); min-width:0; }
.ss-cast .card.has { border-color:rgba(242,255,89,.35); }
.ss-cast .pic { position:relative; aspect-ratio:1; border-radius:10px; overflow:hidden; background:#121015;
  border:1px dashed rgba(255,255,255,.18); display:flex; align-items:center; justify-content:center; }
.ss-cast .card.has .pic { border-style:solid; border-color:rgba(255,255,255,.1); }
.ss-cast .pic img { width:100%; height:100%; object-fit:cover; }
.ss-cast .pic .ph { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; font-size:12px; width:100%; height:100%; color:rgba(255,255,255,.75); }
.ss-cast .pic .ph .ini { font-size:calc(var(--ss-cast-tile, 150px) * .32); font-weight:800; letter-spacing:-.02em; color:rgba(255,255,255,.92); line-height:1; text-shadow:0 2px 12px rgba(0,0,0,.35); }
.ss-cast .pic .ph .gen { margin-top:4px; padding:4px 10px; border-radius:999px; background:rgba(0,0,0,.35); font-weight:600; }
.ss-cast .genall { background:#f2ff59 !important; color:#111 !important; border-color:#f2ff59 !important; font-weight:700; border-radius:999px; padding:6px 14px; cursor:pointer; display:inline-flex; gap:6px; align-items:center; }
.ss-cast .genall:disabled { opacity:.5; cursor:default; }
.ss-cast .pic .busy { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.55); font-size:12px; text-align:center; padding:8px; }
.ss-cast .name { font-weight:700; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cast .meta { font-size:11px; opacity:.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-cast textarea { width:100%; box-sizing:border-box; min-height:52px; resize:vertical; font:inherit; font-size:12px; color:inherit;
  background:rgba(0,0,0,.25); border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:6px 8px; }
.ss-cast .acts { display:flex; gap:6px; flex-wrap:wrap; }
.ss-cast .btn { display:inline-flex; align-items:center; gap:5px; border-radius:999px; padding:4px 10px; font:inherit; font-size:12px;
  cursor:pointer; background:rgba(255,255,255,.06); color:inherit; border:1px solid rgba(255,255,255,.14); }
.ss-cast .btn:hover:not(:disabled) { border-color:#f2ff59; }
.ss-cast .btn.primary { background:#f2ff59; color:#111; border-color:#f2ff59; font-weight:650; }
.ss-cast .btn:disabled { opacity:.45; cursor:default; }
.ss-cast .add { display:flex; gap:6px; }
.ss-cast .add input { font:inherit; font-size:12px; color:inherit; background:rgba(0,0,0,.25); border:1px solid rgba(255,255,255,.12);
  border-radius:999px; padding:4px 10px; min-width:0; }
.ss-cast .empty { opacity:.6; font-size:12px; padding:6px 2px; }
/* Fit: tiles exactly the computed size (no stretching) and compact cards: the picture, its name, and its buttons over the
   bottom of the picture as icon buttons (names in the tooltips). The description opens over the picture (pencil button). */
.ss-cast[data-fit=true] { flex-direction:row; flex-wrap:wrap; align-items:flex-start; align-content:flex-start; gap:10px 24px; padding-bottom:4px; }
.ss-cast[data-fit=true] > .head { flex:1 1 100%; }
.ss-cast[data-fit=true] > section { flex:none; min-width:0; max-width:100%; }
.ss-cast[data-fit=true] section > .sh .add input { width:150px; }
.ss-cast[data-fit=true] .head .sub { max-width:110ch; }
.ss-cast[data-fit=true] .grid { grid-template-columns:repeat(auto-fill, var(--ss-cast-tile, 150px)); gap:10px; justify-content:start; }
.ss-cast[data-fit=true] section { gap:6px; }
.ss-cast[data-fit=true] .card { position:relative; padding:5px; gap:4px; border-radius:12px; }
.ss-cast[data-fit=true] .name { font-size:12px; font-weight:600; padding:0 2px; }
.ss-cast[data-fit=true] .meta { display:none; }
.ss-cast[data-fit=true] .pic .ph { font-size:0; gap:4px; }
.ss-cast[data-fit=true] .pic .ph .ini { font-size:calc(var(--ss-cast-tile, 150px) * .3); }
.ss-cast[data-fit=true] .pic .ph .ss-icon { width:18px; height:18px; opacity:.85; }
.ss-cast[data-fit=true] .card:not(.desc) textarea { display:none; }
.ss-cast[data-fit=true] .card.desc textarea { position:absolute; z-index:3; left:5px; top:5px; width:var(--ss-cast-tile, 150px); height:var(--ss-cast-tile, 150px);
  min-height:0; resize:none; font-size:12px; background:rgba(20,15,25,.96); }
.ss-cast[data-fit=true] .acts { position:absolute; z-index:4; left:5px; width:var(--ss-cast-tile, 150px); top:calc(5px + var(--ss-cast-tile, 150px) - 30px);
  gap:3px; justify-content:center; flex-wrap:nowrap; }
.ss-cast[data-fit=true] .acts .btn { font-size:0 !important; gap:0 !important; padding:4px 6px !important; background:rgba(20,15,25,.84) !important;
  border-color:rgba(255,255,255,.18) !important; }
.ss-cast[data-fit=true] .acts .btn.primary { color:#f0efed !important; font-weight:400 !important; }
.ss-cast[data-fit=true] .acts .btn:hover:not(:disabled) { background:rgba(52,44,59,.95) !important; }
.ss-cast[data-fit=true] .acts .btn .ss-icon { width:14px; height:14px; }
.ss-cast[data-fit=true] .card.desc .acts .btn:not(.descbtn) { display:none; }
.ss-cast .acts .descbtn { display:none; }
.ss-cast[data-fit=true] .acts .descbtn { display:inline-flex; }
.ss-cast[data-fit=true] .card.has-desc .descbtn .ss-icon { color:#f2ff59; }
`;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [e, fn] of Object.entries(v)) el.addEventListener(e, fn);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v != null && v !== false) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
const title = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const PEOPLE = new Set(["man", "woman", "child"]);
const PROP_CATS = ["props", "vehicles", "animals", "wardrobe"];
/** Hints that mark a vehicle: the script breakdown's "vehicle" or a stage kind (car, sports_car, police_car…). */
const VEHICLE = /^(vehicle|car|sports_car|police_car|hatchback|truck|van|bus|taxi|jeep|pickup|motorcycle|bicycle)$/;
const SIZES = [["Fit", 0], ["S", 150], ["M", 210], ["L", 300], ["XL", 420]];

/**
 * "Fit" (the default, Milestone 14): the largest square thumbnail at which every card of every section fits the view
 * without scrolling (QA round 02: ② Cast was 2,164 px of cards in a 792 px view). Sections sit side by side when they
 * are short (three characters next to four locations), each at least secMin wide for its heading and Add box.
 * counts: cards per section; width / height: the room; extra: a card's height minus its picture; head: the title
 * row; sec: a section's heading row (an empty section shows one line instead of cards).
 * Returns { tile, widths (px per section), lines (section indexes per line) }; tile is min when nothing fits.
 */
export function fitLayout(counts, { width, height, extra = 120, gap = 10, head = 64, sec = 34, empty = 22, secMin = 360, secGap = 24,
  lineGap = 10, min = 56, max = 210, step = 2 } = {}) {
  if (!(width > 0) || !(height > 0)) return { tile: 150, widths: counts.map(() => null), lines: [counts.map((_, i) => i)] };
  let last = null;
  for (let t = max; t >= min; t -= step) {
    const cols = Math.max(1, Math.floor((width + gap) / (t + gap)));
    const widths = counts.map((n) => Math.min(width, Math.max(secMin, Math.min(n, cols) * (t + gap) - gap)));
    const hOf = (i) => { const n = counts[i], c = Math.max(1, Math.floor((widths[i] + gap) / (t + gap))), rows = Math.ceil(n / c);
      return sec + gap + (n ? rows * (t + extra) + (rows - 1) * gap : empty); };
    const lines = [];
    for (let i = 0; i < counts.length; i++) {
      const ln = lines[lines.length - 1];
      const used = ln ? ln.reduce((a, j) => a + widths[j] + secGap, 0) : Infinity;
      if (ln && used + widths[i] <= width) ln.push(i); else lines.push([i]);
    }
    const h = head + lines.reduce((a, ln) => a + Math.max(...ln.map(hOf)), 0) + (lines.length - 1) * lineGap;
    last = { tile: t, widths, lines };
    if (h <= height) return last;
  }
  return last;
}

/** The tile size alone (see fitLayout). */
export function fitTile(counts, opts) { return fitLayout(counts, opts).tile; }

/**
 * The list of things to cast, from the script (preferred) or the stage. Pure (testable):
 * returns [{key, kind: 'character'|'prop'|'wardrobe'|'location', name, scenes: [labels], hint}].
 */
export function castList(script, stage) {
  const out = new Map();
  const put = (kind, name, scene, hint = "") => {
    if (!name) return;
    const key = `${kind}:${slug(name)}`;
    const it = out.get(key) || { key, kind, name: kind === "location" ? name : title(name), scenes: [], hint };
    if (scene && !it.scenes.includes(scene)) it.scenes.push(scene);
    if (hint && !it.hint) it.hint = hint;
    out.set(key, it);
  };
  if (script?.scenes?.length) {
    for (const sc of script.scenes) {
      const label = `Sc ${sc.number || sc.index + 1}`;
      for (const c of sc.characters || []) put("character", c, label);
      for (const c of sc.breakdown?.cast || []) put("character", c, label);
      for (const cat of PROP_CATS) for (const p of sc.breakdown?.[cat] || [])
        put(cat === "wardrobe" || (cat === "props" && CLOTHES.test(p)) ? "wardrobe" : "prop", p, label, cat === "vehicles" ? "vehicle" : cat === "animals" ? "animal" : "");
      const loc = [sc.int_ext, sc.location].filter(Boolean).join(". ");
      if (sc.location) put("location", loc, label, sc.time ? sc.time.toLowerCase() : "");
    }
  } else if (stage) {
    for (const a of stage.actors || []) {
      if (a.set_xform || a.kind === "glb" || a.kind === "card") continue;
      if (PEOPLE.has(a.kind)) put("character", a.name || a.kind, "", a.kind);
      else put("prop", a.name || a.kind, "", a.kind);
    }
    const set = stage.environment?.set;
    if (set) put("location", set.replace(/_/g, " "), "", stage.environment?.weather && stage.environment.weather !== "none" ? stage.environment.weather : "");
  }
  return [...out.values()];
}

/** The prompt for a generated reference picture. */
export function refPrompt(it, desc) {
  const d = (desc || "").trim();
  if (it.kind === "character")
    return `Character reference sheet of ${it.name}${d ? `, ${d}` : ""}: full body front view, side view and back view side by side, ` +
      "neutral standing pose, plain light grey studio background, even soft lighting, photographic, consistent costume and face, no text";
  if (it.kind === "wardrobe")
    return `Wardrobe reference photo of ${it.name}${d ? `, ${d}` : ""}: the garment on a plain mannequin, front view, whole piece in frame, ` +
      "plain light grey studio background, soft even light, photographic, true fabric colour and texture, no face, no text";
  // A car, truck or bike gets a turnaround of the one vehicle, so a car seen tail-first in frame 1 keeps the same
  // front, flanks and lamps when it turns round in the shot (an image model otherwise invents an end it never saw).
  if (it.kind === "prop" && VEHICLE.test(it.hint || ""))
    return `Vehicle reference sheet of ${it.name}${d ? `, ${d}` : ""}: the same vehicle four times in a two-by-two grid, front view, ` +
      "rear view, side profile and front three-quarter view, identical design, paint, lights and wheels in every view, " +
      "plain light grey studio floor and background, soft even light, photographic, no people, no text";
  if (it.kind === "prop")
    return `Product reference photo of ${it.name}${d ? `, ${d}` : ""}${it.hint ? ` (${it.hint})` : ""}, three-quarter view, whole object in frame, ` +
      "plain light grey studio background, soft even light, photographic, no text";
  return `Location reference photograph: ${it.name}${it.hint ? `, ${it.hint}` : ""}${d ? `, ${d}` : ""}. Wide establishing view, ` +
    "no people, cinematic still, natural light, photographic, no text";
}

const initials = (n) => String(n || "?").replace(/^(the|a)\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const hue = (n) => { let x = 0; for (const c of String(n)) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
const TOD = [[/night|midnight/i, "#0b1530", "#2a3f7a"], [/dusk|evening|sunset|magic/i, "#3a1530", "#e0703a"], [/dawn|morning/i, "#2a2a4a", "#f0b07a"],
  [/day|noon|afternoon/i, "#2f6fa8", "#cfe3ef"]];
/** A placeholder background: a character's own colour, a location's time of day from its slugline. */
function placeholderBg(it) {
  if (it.kind === "location") {
    const s = `${it.name} ${(it.scenes || []).join(" ")} ${it.hint || ""}`;
    const t = TOD.find(([re]) => re.test(s)) || [null, "#2b2440", "#6a5a8a"];
    return `linear-gradient(180deg, ${t[2]} 0%, ${t[1]} 100%)`;
  }
  const h0 = hue(it.name);
  return `radial-gradient(120% 90% at 30% 20%, hsl(${h0} 55% 45%) 0%, hsl(${(h0 + 40) % 360} 45% 22%) 70%)`;
}

export class CastPanel {
  /**
   * opts: getScript() -> Script|null; getStage() -> stage JSON; load() -> saved {items: {key: {description, ref, url}}};
   * save(data); upload(file) -> {ref, url}; generate(prompt, name) -> Promise<{ref, url}>; applyRefs(items) pushes the
   * pictures into ④ Frame's references; edit(item, done({ref, url})) opens the picture in Paint Studio; onStatus(text).
   */
  constructor(container, opts) {
    this.o = opts;
    this.busy = new Set();
    if (!document.getElementById("ss-cast-css")) document.head.append(h("style", { id: "ss-cast-css" }, CSS));
    this.el = h("div", { class: "ss-cast" });
    try { this.size = localStorage.getItem("ss-cast-size") || "Fit"; } catch { this.size = "Fit"; }
    if (!SIZES.some(([k]) => k === this.size)) this.size = "Fit";
    // Fit follows the window: a new size re-fits (once the layout settles).
    try {
      let last = "";
      this._ro = new ResizeObserver(() => {
        if (this.size !== "Fit") return;
        const r = container.getBoundingClientRect(), key = `${Math.round(r.width)}x${Math.round(r.height)}`;
        if (key === last || !r.width) return;
        last = key;
        clearTimeout(this._roT);
        this._roT = setTimeout(() => this._fit(), 60);
      });
      this._ro.observe(container);
    } catch { /* no ResizeObserver: Fit is computed at each render */ }
    this.container = container;
    for (const t of ["pointerdown", "wheel", "keydown"]) this.el.addEventListener(t, (e) => e.stopPropagation(), { passive: t === "wheel" });
    container.append(this.el);
  }

  data() { const d = this.o.load?.() || {}; d.items = d.items || {}; d.extra = d.extra || []; return d; }

  _save(d) { this.o.save?.(d); try { this.o.applyRefs?.(this.items()); } catch { /* frame not ready */ } }

  /** Everything to cast, with saved descriptions / pictures merged in. */
  items() {
    const d = this.data();
    const list = castList(this.o.getScript?.(), this.o.getStage?.());
    for (const x of d.extra) if (!list.some((y) => y.key === x.key)) list.push({ ...x, scenes: [] });
    // Garments used to be filed as props: keep their saved pictures under the new wardrobe key.
    const saved = (it) => d.items[it.key] || (it.kind === "wardrobe" ? d.items[it.key.replace(/^wardrobe:/, "prop:")] : null) || {};
    return list.map((it) => ({ ...it, ...saved(it) }));
  }

  _set(key, patch) {
    const d = this.data();
    d.items[key] = { ...(d.items[key] || {}), ...patch };
    this._save(d);
  }

  async _upload(it, file) {
    this.busy.add(it.key); this.render();
    try {
      const r = await this.o.upload(file);
      this._set(it.key, { ref: r.ref, url: r.url });
      this.o.onStatus?.(`${it.name}: reference added. ④ Frame uses it for every shot ${it.kind === "location" ? "at this location" : "they are in"}.`);
    } catch (e) { this.o.onStatus?.(`Couldn't add that picture: ${e.message}`); }
    this.busy.delete(it.key); this.render();
  }

  /** Generate every picture that is missing, one after another. */
  async generateAll() {
    if (this._genAll || !this.o.generate) return;
    const todo = this.items().filter((x) => !x.url && !this.busy.has(x.key));
    if (!todo.length) { this.o.onStatus?.("Every card already has a picture."); return; }
    this._genAll = true; this.render();
    let n = 0;
    for (const it of todo) {
      if (!this._genAll) break;
      n += 1;
      this.o.onStatus?.(`Generating ${n} of ${todo.length}: ${it.name}…`);
      await this._generate(it);
    }
    this._genAll = false; this.render();
    this.o.onStatus?.(`Generated ${n} pictures. Edit any description and Regenerate, or upload your own.`);
  }

  async _generate(it) {
    // The description as it reads now: the card's `it` is from its last render, and typing is saved only after a
    // 400 ms pause, so "type a description, click Generate" used to generate from the old (often empty) one.
    const ta = [...this.el.querySelectorAll("textarea")].find((x) => x.getAttribute("aria-label") === `${it.name} description`);
    const saved = this.data().items[it.key]?.description;
    const description = ta ? ta.value : saved ?? it.description;
    if (ta && description !== (saved || "")) this._set(it.key, { description });
    it = { ...it, description };
    this.busy.add(it.key); this.render();
    try {
      this.o.onStatus?.(`Generating ${it.name} with FLUX 3 Klein…`);
      const r = await this.o.generate(refPrompt(it, it.description), it.name, (m) => { this.o.onStatus?.(`${it.name}: ${m}`); });
      this._set(it.key, { ref: r.ref, url: r.url });
      this.o.onStatus?.(`${it.name}: reference generated. Not right? Edit the description and generate again, or upload your own.`);
    } catch (e) { this.o.onStatus?.(`Couldn't generate ${it.name}: ${e.message}`); }
    this.busy.delete(it.key); this.render();
  }

  _card(it) {
    const pick = h("input", { type: "file", accept: "image/*", hidden: true, on: { change: (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) this._upload(it, f); } } });
    const busy = this.busy.has(it.key);
    const ph = h("div", { class: "ph" }, h("span"), it.kind === "character" ? "No character sheet yet" : it.kind === "prop" ? "No reference yet" : it.kind === "wardrobe" ? "No wardrobe picture yet" : "No location photo yet");
    ph.firstChild.replaceWith(icon(it.kind === "character" ? "user" : it.kind === "location" ? "compass" : it.kind === "wardrobe" ? "shirt" : "box", 26));
    // An empty card still looks like something: initials on a colour of their own, a location in its time of day.
    ph.style.background = placeholderBg(it);
    if (it.kind === "character") ph.prepend(h("div", { class: "ini" }, initials(it.name)));
    const img = it.url ? h("img", { src: it.url, alt: `${it.name} reference`, title: "Open full size" }) : null;
    img?.addEventListener("click", () => window.open(it.url, "_blank", "noopener"));
    const pic = h("div", { class: "pic" }, img || ph,
      busy ? h("div", { class: "busy" }, "Working… (FLUX 3 Klein on the GPU)") : null);
    pic.addEventListener("dragover", (e) => e.preventDefault());
    pic.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) this._upload(it, f); });
    const desc = h("textarea", { placeholder: it.kind === "character" ? "Who they are on screen: age, build, hair, costume…" :
      it.kind === "prop" ? "What it looks like: make, colour, era, condition…" : it.kind === "wardrobe" ? "Cut, fabric, colour, wear: a red wool coat, frayed cuffs…" : "What it looks like: era, mood, materials, time of day…",
      "aria-label": `${it.name} description` });
    desc.value = it.description || "";
    let t;
    desc.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => this._set(it.key, { description: desc.value }), 400); });
    const btn = (label, ic, fn, cls = "btn", dis = false) => {
      const b = h("button", { type: "button", class: cls, disabled: dis || busy, title: label, "aria-label": `${label}: ${it.name}` }, h("span"), label);
      b.firstChild.replaceWith(icon(ic, 13));
      b.addEventListener("click", fn);
      return b;
    };
    desc.addEventListener("keydown", (e) => { if (e.key === "Escape") desc.closest(".card")?.classList.remove("desc"); });
    return h("div", { class: `card${it.url ? " has" : ""}${(it.description || "").trim() ? " has-desc" : ""}` }, pic,
      h("div", { class: "name", title: [it.name, it.scenes?.length ? it.scenes.join(" · ") : "", it.hint].filter(Boolean).join(" · ") }, it.name),
      h("div", { class: "meta" }, [it.scenes?.length ? it.scenes.join(" · ") : "", it.hint].filter(Boolean).join(" · ") || " "),
      desc,
      h("div", { class: "acts" },
        btn("Describe", "file-text", (e) => {
          const card = e.currentTarget.closest(".card");
          const open = card.classList.toggle("desc");
          if (open) setTimeout(() => desc.focus({ preventScroll: true }), 0);
        }, "btn descbtn"),
        btn(it.url ? "Regenerate" : "Generate", "sparkles", () => this._generate(it), it.url ? "btn" : "btn primary", !this.o.generate),
        btn(it.url ? "Replace" : "Upload", "upload", () => pick.click()),
        it.url && this.o.edit ? btn("Edit", "wand-sparkles", () => this.editItem(it)) : null,
        it.url ? btn("Clear", "x", () => { this._set(it.key, { ref: null, url: null }); this.render(); }) : null),
      pick);
  }

  /** Open the reference picture in Paint Studio; its "Save to reference" replaces this item's picture. */
  editItem(it) {
    this.o.edit?.(it, (r) => {
      this._set(it.key, { ref: r.ref, url: r.url });
      this.o.onStatus?.(`${it.name}: edited reference saved. ④ Frame uses the new picture.`);
      this.render();
    });
  }

  _sizes() {
    const box = h("div", { class: "sizes", role: "group", "aria-label": "Thumbnail size" }, h("span", { class: "lbl" }, "Size"));
    for (const [k] of SIZES) {
      const b = h("button", { type: "button", class: "btn", "aria-pressed": String(this.size === k),
        title: k === "Fit" ? "Fit every card on one screen" : `${k} thumbnails` }, k);
      b.addEventListener("click", () => { this.size = k; try { localStorage.setItem("ss-cast-size", k); } catch { /* private mode */ } this.render(); });
      box.append(b);
    }
    return box;
  }

  _section(kind, label, ic, list) {
    const d = this.data();
    const inp = h("input", { placeholder: kind === "character" ? "Add a character…" : kind === "prop" ? "Add a prop or vehicle…" : kind === "wardrobe" ? "Add a costume piece…" : "Add a location…", "aria-label": `Add ${label}` });
    const add = () => {
      const name = inp.value.trim();
      if (!name) return;
      const key = `${kind}:${slug(name)}`;
      if (!d.extra.some((x) => x.key === key)) d.extra.push({ key, kind, name: kind === "location" ? name : title(name) });
      this._save(d); this.render();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    const plus = h("button", { type: "button", class: "btn" }, "Add");
    plus.addEventListener("click", add);
    const sh = h("div", { class: "sh" }, h("span"), label, h("span", { class: "count" }, `${list.length}`), h("span", { class: "grow" }), h("div", { class: "add" }, inp, plus));
    sh.firstChild.replaceWith(icon(ic, 15));
    return h("section", {}, sh, list.length ? h("div", { class: "grid" }, ...list.map((it) => this._card(it)))
      : h("div", { class: "empty" }, kind === "character" ? "No characters yet: import a script, put people on the stage, or add one here." :
        kind === "prop" ? "No props yet." : kind === "wardrobe" ? "No wardrobe yet: add a costume piece (a coat, a hat, a uniform) to keep it the same in every shot." : "No locations yet."));
  }

  render() {
    const all = this.items();
    const by = (k) => all.filter((x) => x.kind === k);
    const done = all.filter((x) => x.url).length;
    const src = this.o.getScript?.()?.scenes?.length ? "from your script's breakdown" : "from the stage (import a script for the full breakdown)";
    this.el.dataset.fit = String(this.size === "Fit");
    if (this.size !== "Fit") this.el.style.setProperty("--ss-cast-tile", `${(SIZES.find(([k]) => k === this.size) || SIZES[2])[1]}px`);
    this.el.replaceChildren(
      h("div", { class: "head" },
        h("div", {}, h("h2", {}, "Cast & Locations"),
          h("div", { class: "sub" }, `Everyone and everything that must look the same in every shot, ${src}. Give each one a picture: ④ Frame shows it to the image model, so faces, costumes, cars and places stay the same.`)),
        h("div", { class: "grow" }),
        this._sizes(),
        h("div", { class: "meta" }, `${done} of ${all.length} have a reference`),
        (() => {
          const missing = all.length - done;
          const b = h("button", { type: "button", class: "genall", disabled: !this.o.generate || !missing || this._genAll,
            title: "FLUX 3 Klein makes a character sheet or location picture for every empty card (about 7 s each)" },
            h("span"), this._genAll ? "Generating…" : missing ? `Generate all missing (${missing})` : "All generated");
          b.firstChild.replaceWith(icon("sparkles", 14));
          b.addEventListener("click", () => this.generateAll());
          return b;
        })()),
      this._section("character", "Characters", "user", by("character")),
      this._section("location", "Locations", "compass", by("location")),
      this._section("wardrobe", "Wardrobe", "shirt", by("wardrobe")),
      this._section("prop", "Props, vehicles & animals", "box", by("prop")));
    if (this.size === "Fit") this._fit();
  }

  /** Fit: measure the room and one card, then size the thumbnails so the whole page fits without scrolling. */
  _fit() {
    if (this.size !== "Fit") return;
    const box = this.container || this.el.parentElement;
    const W = this.el.clientWidth, H = (box?.clientHeight || 0) - 14;
    const secs = [...this.el.querySelectorAll(":scope > section")];
    if (!W || H < 200) { this.el.style.setProperty("--ss-cast-tile", "150px"); for (const sc of secs) sc.style.width = ""; return; }
    const card = this.el.querySelector(".card"), pic = card?.querySelector(".pic");
    const extra = card && pic ? Math.ceil(card.offsetHeight - pic.offsetHeight) : 120;
    const head = this.el.querySelector(".head")?.offsetHeight || 64;
    const counts = secs.map((sc) => sc.querySelectorAll(".card").length);
    const fit = fitLayout(counts, { width: W, height: H, extra, head: head + 10 });
    this.el.style.setProperty("--ss-cast-tile", `${fit.tile}px`);
    secs.forEach((sc, i) => { sc.style.width = fit.widths[i] ? `${fit.widths[i]}px` : ""; });
  }
}
