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
.ss-cast .pic .ph { display:flex; flex-direction:column; align-items:center; gap:6px; opacity:.55; font-size:12px; }
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
.ss-cast .empty { opacity:.6; font-size:12px; padding:6px 2px; }`;

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
const SIZES = [["S", 150], ["M", 210], ["L", 300], ["XL", 420]];

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
  if (it.kind === "prop")
    return `Product reference photo of ${it.name}${d ? `, ${d}` : ""}${it.hint ? ` (${it.hint})` : ""}, three-quarter view, whole object in frame, ` +
      "plain light grey studio background, soft even light, photographic, no text";
  return `Location reference photograph: ${it.name}${it.hint ? `, ${it.hint}` : ""}${d ? `, ${d}` : ""}. Wide establishing view, ` +
    "no people, cinematic still, natural light, photographic, no text";
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
    try { this.size = localStorage.getItem("ss-cast-size") || "M"; } catch { this.size = "M"; }
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

  async _generate(it) {
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
      const b = h("button", { type: "button", class: cls, disabled: dis || busy }, h("span"), label);
      b.firstChild.replaceWith(icon(ic, 13));
      b.addEventListener("click", fn);
      return b;
    };
    return h("div", { class: `card${it.url ? " has" : ""}` }, pic,
      h("div", { class: "name", title: it.name }, it.name),
      h("div", { class: "meta" }, [it.scenes?.length ? it.scenes.join(" · ") : "", it.hint].filter(Boolean).join(" · ") || " "),
      desc,
      h("div", { class: "acts" },
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
      const b = h("button", { type: "button", class: "btn", "aria-pressed": String(this.size === k), title: `${k} thumbnails` }, k);
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
    this.el.style.setProperty("--ss-cast-tile", `${(SIZES.find(([k]) => k === this.size) || SIZES[1])[1]}px`);
    this.el.replaceChildren(
      h("div", { class: "head" },
        h("div", {}, h("h2", {}, "Cast & Locations"),
          h("div", { class: "sub" }, `Everyone and everything that must look the same in every shot, ${src}. Add a character sheet, a photo, or generate one; ④ Frame shows each picture to the image model, so faces, costumes, cars and places stay consistent.`)),
        h("div", { class: "grow" }),
        this._sizes(),
        h("div", { class: "meta" }, `${done} of ${all.length} have a reference`)),
      this._section("character", "Characters", "user", by("character")),
      this._section("location", "Locations", "compass", by("location")),
      this._section("wardrobe", "Wardrobe", "shirt", by("wardrobe")),
      this._section("prop", "Props, vehicles & animals", "box", by("prop")));
  }
}
