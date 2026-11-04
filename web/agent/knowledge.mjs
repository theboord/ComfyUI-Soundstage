// ✦ Ask's knowledge (docs/assistant.md): search_docs over the App catalog (every labelled control, preset, rig, look,
// quality setting, shortcut and the 7 steps, extracted from the source by tools/build_knowledge.mjs) and the README +
// docs/**/*.md in chunks. BM25 ranking, no model, no network; every hit says where it lives ("⑤ Motion › Advanced
// (LTX)", "docs/sfx.md › Squibs"). SOUNDSTAGE_MAP is the short map the system prompt carries (under ~1,500 tokens).
//
//   const k = await loadKnowledge();          // fetches web/agent/knowledge/*.json once (Node: reads the files)
//   k.search("stage-2 start", 5)              // [{title, where, text, kind, score}]
//   KnowledgeIndex.from(catalog, docs)        // tests: build from objects
const STOP = new Set("a an and are as at be by can do does for from how i in into is it its me my of on or our so that the their them then there this to up was we what when where which who why will with you your".split(" "));

/** Words for matching: lower case, split on non-letters, a light stem (plurals, -ing, -ed), no stop words. */
export function tokens(text) {
  return String(text || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem);
}
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** The catalog and doc chunks as search records: [{kind, title, where, text, boost}]. */
export function records(catalog = {}, docs = {}) {
  const out = [];
  const put = (kind, title, where, text, boost = 1) => out.push({ kind, title: String(title), where: String(where), text: String(text || ""), boost });
  for (const s of catalog.steps || []) put("step", `${s.n} ${s.label}`, "the step bar (top)", `Step ${s.n} ${s.label}`, 1.5);
  for (const c of catalog.controls || []) put("control", c.label, `${c.where} (${c.file})`, c.help, 2);
  for (const p of catalog.presets || []) put("preset", `${p.label} (${p.kind} preset "${p.id}")`, p.where, `${p.words.join(", ")}. ${p.summary}`, 2);
  for (const r of catalog.sfx_rigs || []) put("sfx_rig", `${r.label} (SFX rig "${r.id}")`, "③ Set › Add object › SFX rigs, then the rig's card", `practical effect rig ${r.id.replace(/_/g, " ")}`, 1.5);
  for (const l of catalog.looks || []) put("look", `${l.label} (look "${l.id}")`, "④ Frame › Look › Style", "a look / grade preset", 1);
  for (const l of catalog.lighting_setups || []) put("lighting", `${l.label} (lighting setup "${l.id}")`, "③ Set › Lighting", "a lighting setup", 1);
  const q = catalog.quality || {};
  for (const p of q.ltx_presets || []) put("quality", `${p.name} (LTX quality preset)`, "⑤ Motion › quality (Draft / Final / Hollywood)", `${p.tip} ${p.resolution}p, steps ${p.steps?.join(" + ")}, stage-2 start ${p.s2_start}`, 2);
  for (const a of q.adherence || []) put("quality", `Adherence: ${a.level}`, "⑤ Motion › Adherence (Loose · Balanced · Exact)", `${a.tip} ${a.knobs}. Follow the clay blocking.`, 2);
  for (const e of q.engines || []) put("engine", e, "⑤ Motion › Engine", "video engine choice", 1);
  for (const s of catalog.shortcuts || []) put("shortcut", `${s.keys.replace(/Mod/g, "⌘/Ctrl")}: ${s.what}`, `keyboard shortcut (${s.group}; ? shows them all)`, s.what, 1.5);
  for (const d of docs.chunks || []) put("doc", d.heading, `${d.doc} › ${d.heading}`, d.text, 1);
  return out;
}

/** BM25 (k1 1.2, b 0.75) over title (weighted by boost) + where + text. */
export class KnowledgeIndex {
  constructor(recs) {
    this.recs = recs;
    this.df = new Map();
    this.docs = recs.map((r) => {
      const title = tokens(r.title), body = tokens(`${r.where} ${r.text}`);
      const tf = new Map();
      for (const w of title) tf.set(w, (tf.get(w) || 0) + 2 * r.boost);
      for (const w of body) tf.set(w, (tf.get(w) || 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
      return { tf, len: title.length * 2 + body.length, phrase: `${r.title} ${r.text}`.toLowerCase() };
    });
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }
  static from(catalog, docs) { return new KnowledgeIndex(records(catalog, docs)); }

  /** -> [{title, where, text (≤ 360 chars), kind, score}], best first. */
  search(query, k = 5, { kinds = null } = {}) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = this.docs.length, phrase = String(query).toLowerCase().trim();
    const hits = [];
    this.docs.forEach((d, i) => {
      const r = this.recs[i];
      if (kinds && !kinds.includes(r.kind)) return;
      let s = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - this.df.get(w) + 0.5) / (this.df.get(w) + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / this.avg));
      }
      if (!s) return;
      if (phrase.length > 4 && d.phrase.includes(phrase)) s *= 1.6;   // the exact words: a label typed as it reads
      hits.push({ i, s });
    });
    return hits.sort((a, b) => b.s - a.s).slice(0, k).map(({ i, s }) => {
      const r = this.recs[i];
      return { title: r.title, where: r.where, text: r.text.length > 360 ? `${r.text.slice(0, 359)}…` : r.text, kind: r.kind, score: +s.toFixed(3) };
    });
  }
}

let loading = null;
/** The App's own index (cached). Browser: fetch next to this file; Node: read the files. */
export function loadKnowledge() {
  if (loading) return loading;
  loading = (async () => {
    const get = async (n) => {
      const url = new URL(`./knowledge/${n}`, import.meta.url);
      if (url.protocol === "file:") { const fs = await import("node:fs"); return JSON.parse(fs.readFileSync(url, "utf8")); }
      return (await fetch(url)).json();
    };
    const [catalog, docs] = await Promise.all([get("catalog.json"), get("docs.json")]);
    const idx = KnowledgeIndex.from(catalog, docs);
    idx.catalog = catalog;
    return idx;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** search_docs as a tool result: cites where each answer lives. */
export function searchDocsResult(idx, query, k = 5) {
  const hits = idx ? idx.search(query, k) : [];
  return { tool: "search_docs", ok: true, title: `Search: ${query}`, hits,
    said: hits.length ? `Found ${hits.length} place${hits.length === 1 ? "" : "s"} for "${query}": ${hits.slice(0, 3).map((h) => `${h.title} (${h.where})`).join("; ")}.` :
      `Nothing in the App or its docs matches "${query}".`,
    observe: hits.map((h) => `${h.title} @ ${h.where}: ${h.text.slice(0, 160)}`).join("\n") || "no hits" };
}

/** The short map of the App for the system prompt (the full catalog stays behind search_docs). */
export const SOUNDSTAGE_MAP = `SOUNDSTAGE MAP (a ComfyUI film-set App; ⌘/Ctrl+K opens ✦ Ask, ? lists every shortcut, ⌘Z undoes)
① Script: import a screenplay (Fountain/FDX/PDF/text) or a sample; scenes, the breakdown (cast, props, set dressing, wardrobe, vehicles, animals), the scene strip.
② Cast & Locations: a card per character / prop / wardrobe / location: description + reference picture (✨ Generate or Regenerate one card with FLUX 3 Klein, upload, or edit in Paint Studio). References flow into ④ Frame by name so faces and cars stay the same.
③ Set: a 3D stage. Tool rail: Build with AI, Add object (props, vehicles, people, SFX rigs: explosion, fire, sparks, bullet-hit squib, body squib / blood pack, breakaway glass, smoke bomb, flare, stab gag), Person, Interact, Capture motion (record yourself), Video → Stage, Photo → 3D, Camera (setups, lens mm, rig: tripod/dolly/steadicam/handheld/drone, moves: push in, pull out, truck, crane, orbit), Set & weather, Lighting. Shots = camera setups (coverage) with a length; an object's card has Physics (dynamic, Breakable, bake), Parts, Pose. Presets window (V): Camera moves, Lighting, Looks, Action (car stunts: reverse J-turn, donut, handbrake 180; crate crash, impact shake, drop, throw; SFX: car explosion, building blast, sparks shower, squib hit; boats, climb, swim), Edit styles, Recipes. Phone viewfinder: frame the shot with your phone as a virtual camera.
④ Frame: paint each shot's first frame from the clay (Generate frames). Frame models: FLUX 3 Klein (default) or Krea 2 Turbo (Strict depth lock); "Follow the clay" slider (0.55-1) = how closely the still keeps the stage's shapes; LoRA add-on; Look / grade.
⑤ Motion: video from the clay + frame. Engine: LTX-2.5 Layout-to-Render (local, follows your clay) or MiniMax H3 (loose). Quality: Draft (fast look) / Final / Hollywood. Adherence: Loose · Balanced · Exact (default Exact) sets clay guide blur, Layout IC-LoRA strength, frame reference. Advanced (LTX): steps, Stage-2 start, Clay guide blur, IC-LoRA strength, seed, codec. Final + sound adds audio; Real performance / Recast swaps in a filmed performance; lip sync for dialogue.
⑥ Review: the ladder of takes (clay → look → draft → final), Dailies (approve / changes / reject), Take check, Cut: the editor (assemble the scene, trim, transitions: cross dissolve, dip to black/white, wipe; fade up/out; titles, subtitles; audio tracks Dialogue / SFX / Music / Ambience; right-click a clip → Edit in…).
⑦ Deliver: render the cut (MP4 / ProRes), Collect project. Projects pill (top row): Save / Open / autosave. Director's Book: scene intent, rules, notes.
Ask can also run the Director's planner for set orders ("make it rain", "put Mara in the car"): a plan first, then Apply, one Undo.`;
