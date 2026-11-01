// The Director's Book (Milestone 23): the controller. Opened from ① Script or the top bar; draws the BookView, keeps
// the book in the workflow (node.properties.ss_book) and in ComfyUI's user data (POST /soundstage/book/save), drafts
// prose with the local model (the same TextGenerate run as the Director: soundstage/book/draft.py builds the prompt and
// checks the answer against the script), files the director's shorthand (soundstage/book/place.py), exports the PDF
// binder (the browser's print, web/book/print.mjs) and Markdown, and is the Director's living memory:
//
//   const book = mountBook({ topBar, before, api, stage, host });
//   book.open("sc_2");                     // the book at scene 2
//   book.context()                         // getBookContext for the live scene: what the Director / Pitch read
//   book.recordDecision({ command, calls, results })   // the Director writes back what was decided in chat
//   await book.fileNotes("sc2 — keep Mara's face in shadow till she sees the badge")
//
// host: { getScript(), liveScene(), sceneStage(id), look(), setLook(patch), renders(sid), chosenPic(sid), cutIds(),
//         order(), props(), save(), status(msg), openScene(id) }
import { normalizeBook, emptyBook, pageFor, setField, setBookField, mergeDraft, mergeSpine, addPlacements, moveNote, removeNote,
  splitShorthand, getBookContext, recordDecision, addRevision, toggleDropped, rememberShots, scenePage, toMarkdown, notesForScene, notesOnLine } from "./model.mjs";
import { floorPlanSVG } from "./floorplan.mjs";
import { printHTML } from "./print.mjs";
import { ClayFrames } from "./clay.mjs";
import { BookView } from "./view.mjs";
import { runLocalModel } from "../agent/agent.mjs";

export { getBookContext };

const BOOK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ss-icon"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';

/** The script without its bulky bits, for the server's prompts and its stored copy. */
export function compactScript(s) {
  if (!s) return null;
  return { title: s.title, author: s.author, characters: s.characters,
    scenes: (s.scenes || []).map((x) => ({ id: x.id, number: x.number, heading: x.heading, int_ext: x.int_ext, location: x.location, time: x.time,
      elements: x.elements, characters: x.characters, synopsis: x.synopsis, outline: x.outline, breakdown: x.breakdown, stage_hint: x.stage_hint })) };
}

/** A few words about a scene's stage for the drafting prompt (the model never sees coordinates). */
export function stageFacts(stage, look, rows = []) {
  if (!stage) return {};
  const L = stage.lighting || {};
  return { set: stage.environment?.set, time: L.preset || (L.hour != null ? `${L.hour}h` : ""), weather: stage.environment?.weather,
    shots: rows.filter((r) => !r.dropped).map((r) => `${r.no} ${r.name}, ${r.lens}, ${r.move}`),
    look: [look?.description, look?.style].filter((x) => typeof x === "string" && x).join(", ") };
}

export function mountBook({ topBar = null, before = null, api, stage, host = {} }) {
  const H = { getScript: () => null, liveScene: () => null, sceneStage: () => null, look: () => null, setLook: null, renders: () => ({}),
    chosenPic: () => null, cutIds: () => new Set(), order: () => null, props: () => ({}), save: () => {}, status: () => {}, ...host };
  let book = normalizeBook(H.props()?.ss_book, H.getScript());
  let saveT = null, lookSig = "", lastLive = null;
  const clay = stage ? new ClayFrames({ stage }) : null;

  const script = () => H.getScript();
  const stageOf = (id) => { try { return H.sceneStage(id); } catch { return null; } };
  const pageOpts = (id) => ({ renders: (sid) => { try { return H.renders(sid) || {}; } catch { return {}; } }, cutIds: (() => { try { return H.cutIds(id) || new Set(); } catch { return new Set(); } })(),
    order: id === H.liveScene() ? H.order?.() : null });
  const page = (id) => { const sc = script()?.scenes?.find((x) => x.id === id); return sc ? pageFor(book, script(), sc, stageOf(id), H.look(), pageOpts(id)) : null; };

  function persist({ server = true } = {}) {
    const props = H.props();
    if (props) props.ss_book = book;
    try { H.save(); } catch { /* host away */ }
    syncLook();
    if (!server) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      api?.fetchApi?.("/soundstage/book/save", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ book: { ...book, script: compactScript(script()) } }) }).catch(() => {});
    }, 1200);
  }
  const changed = () => { persist(); if (view.open) view.render(); try { H.onNotes?.(); } catch { /* */ } };

  /** The live scene's Imagery & Tone + positive Pitfalls into the Look (the still and motion prompts read them). */
  function syncLook() {
    if (!H.setLook) return;
    const live = H.liveScene();
    const p = getBookContext(book, script(), live).prompt;
    const sig = JSON.stringify(p);
    if (sig === lookSig) return;
    lookSig = sig;
    try { H.setLook({ book: p.style.length || p.constraints.length ? p : null }); } catch { /* look not built */ }
  }

  async function llm(mode, body) {
    const p = await (await api.fetchApi("/soundstage/book/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ...body }) })).json();
    return runLocalModel(api, p, { timeoutMs: 360000 });   // a render running on the shared GPU goes first
  }
  async function post(path, body) {
    const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 200) throw new Error(j.error || `${path} failed`);
    return j;
  }
  async function modelReady() {
    try { return !!(await (await api.fetchApi("/soundstage/book/info")).json()).available; } catch { return false; }
  }

  /** Draft one scene's page (or every scene, then the spine) with the local model. Returns the per-scene results. */
  async function draft(sceneId = null) {
    const s = script();
    if (!s) { view.say("Load a script first (① Script)."); return []; }
    if (!(await modelReady())) { view.say("The local model (Qwen3.5 4B) isn't installed on this server: the pages keep what the script and stage say."); return []; }
    const ids = sceneId ? [sceneId] : s.scenes.map((x) => x.id);
    const cs = compactScript(s);
    const out = [];
    for (const [i, id] of ids.entries()) {
      const sc = s.scenes.find((x) => x.id === id);
      view.say(`Drafting scene ${sc.number} (${i + 1} of ${ids.length}) with the local model…`);
      const t0 = performance.now();
      try {
        const pg = page(id);
        const facts = stageFacts(stageOf(id), H.look(), pg?.shots || []);
        const llm_text = await llm("draft", { script: cs, scene_id: id, stage: facts });
        const res = await post("/soundstage/book/draft", { script: cs, scene_id: id, llm_text });
        // The script's own synopsis is the writer's: the model doesn't restate it (it tends to drift from the page).
        if (sc.synopsis && res.sections) delete res.sections.synopsis;
        const filled = mergeDraft(book, id, res.sections, { by: res.backend === "llm" ? "llm" : "rules", grounding: res.grounding });
        out.push({ id, ms: Math.round(performance.now() - t0), filled, grounding: res.grounding, llm_text });
        persist({ server: false });
        if (view.open) view.render();
      } catch (e) { out.push({ id, error: String(e.message || e) }); }
    }
    if (!sceneId) {
      view.say("Drafting the spine…");
      try {
        const llm_text = await llm("spine", { script: cs });
        const res = await post("/soundstage/book/spine", { script: cs, llm_text });
        mergeSpine(book, res);
        book.spine_grounding = res.grounding || null;
        out.push({ id: "spine", ...res });
      } catch (e) { out.push({ id: "spine", error: String(e.message || e) }); }
    }
    persist();
    const bad = out.filter((r) => r.error).length;
    view.say(bad ? `Drafted with ${bad} problem${bad === 1 ? "" : "s"}: ${out.find((r) => r.error).error}` : `Drafted ${ids.length === 1 ? "the scene" : `${ids.length} scenes and the spine`}. Your own words were kept.`);
    if (view.open) view.render();
    return out;
  }

  /** The director's shorthand -> filed notes (the model reads it; the rules answer when it can't). */
  async function fileNotes(text, { useModel = true } = {}) {
    const lines = splitShorthand(text);
    const s = script();
    if (!lines.length) return [];
    if (!s) { view.say("Load a script first: notes are filed onto its scenes."); return []; }
    const cs = compactScript(s);
    let llm_text = null;
    if (useModel && (await modelReady())) {
      view.say(`Reading ${lines.length} note${lines.length === 1 ? "" : "s"} with the local model…`);
      try { llm_text = await llm("place", { script: cs, notes: lines }); } catch (e) { view.say(`The model didn't answer (${e.message}); filing by the rules.`); }
    }
    const res = await post("/soundstage/book/place", { script: cs, notes: lines, llm_text });
    const added = addPlacements(book, res.placements);
    const uns = added.filter((n) => n.scope === "unsorted").length;
    view.say(`Filed ${added.length - uns} of ${added.length} note${added.length === 1 ? "" : "s"}${uns ? `; ${uns} in Unsorted` : ""} (${res.backend}).`);
    changed();
    return added;
  }

  const ctl = {
    get book() { return book; },
    script, page, draftNotes: "",
    edit: (id, key, v) => { setField(book, id, key, v); changed(); },
    editPerf: (id, who, v) => { const p = scenePage(book, id); const perf = { ...(page(id)?.fields.performance.value || {}), [who]: v }; p.performance = perf; p.edited_perf = { ...(p.edited_perf || {}), [who]: true }; p.src.performance = "director"; p.edited.performance = true; changed(); },
    editBook: (k, v) => { setBookField(book, k, v); changed(); },
    moveNote: (id, o) => { moveNote(book, id, o); changed(); },
    removeNote: (id) => { removeNote(book, id); changed(); },
    toggleDrop: (id, sid) => { toggleDropped(book, id, sid); changed(); },
    setShotNote: (id, sid, v) => { const p = scenePage(book, id); if (v) p.shot_notes[sid] = v; else delete p.shot_notes[sid]; changed(); },
    setStoryDay: (id, v) => { scenePage(book, id).story_day = v; changed(); },
    rememberShots: (id, rows) => { const before = JSON.stringify(scenePage(book, id).shots_seen); rememberShots(book, id, rows); if (JSON.stringify(book.scenes[id].shots_seen) !== before) persist({ server: false }); },
    lockRevision: (label) => { const r = addRevision(book, label); persist(); return r; },
    framePic: (sid) => { try { return H.chosenPic(sid) || null; } catch { return null; } },
    clayFrame: (id, sid) => { const st = stageOf(id); return clay && st ? clay.frame(st, sid) : Promise.resolve(null); },
    planSVG: (id, rows) => floorPlanSVG(stageOf(id), rows, { theme: "screen", title: `Floor plan, scene ${script()?.scenes?.find((x) => x.id === id)?.number || ""}` }),
    draft, fileNotes,
    exportPDF: () => exportPDF(),
    exportMarkdown: () => exportMarkdown(),
    close: () => close(),
  };
  const view = new BookView(ctl);

  // ---------------------------------------------------------------- export
  async function pagesAll() { return (script()?.scenes || []).map((sc) => page(sc.id)).filter(Boolean); }
  /** The print document (cover, contents, scenes) with clay / chosen frames inline. */
  async function buildPrint() {
    const pages = await pagesAll();
    const frames = {}, plans = {};
    for (const pg of pages) {
      plans[pg.scene.id] = floorPlanSVG(stageOf(pg.scene.id), pg.shots, { theme: "print", w: 720, h: 360 });
      for (const r of pg.shots) {
        frames[r.id] = ctl.framePic(r.id) || (r.gone ? null : await ctl.clayFrame(pg.scene.id, r.id).catch(() => null));
        if (frames[r.id] && !/^data:/.test(frames[r.id])) frames[r.id] = await toDataURL(frames[r.id]).catch(() => frames[r.id]);
      }
    }
    return printHTML(book, script(), pages, { frames, plans });
  }
  async function exportPDF() {
    view.say("Typesetting the binder…");
    const html = await buildPrint();
    const fr = Object.assign(document.createElement("iframe"), { title: "Director's Book print" });
    fr.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
    document.body.append(fr);
    fr.srcdoc = html;
    await new Promise((r) => fr.addEventListener("load", r, { once: true }));
    await Promise.all([...fr.contentDocument.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
    view.say("Choose “Save as PDF” in the print dialog.");
    fr.contentWindow.focus();
    fr.contentWindow.print();
    setTimeout(() => fr.remove(), 60000);
    return html;
  }
  function download(name, text, type) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const slug = () => String(book.title || script()?.title || "directors_book").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  async function exportMarkdown() {
    const md = toMarkdown(book, script(), await pagesAll());
    download(`${slug()}_directors_book.md`, md, "text/markdown");
    view.say("Markdown saved.");
    return md;
  }
  async function toDataURL(url) {
    const b = await (await fetch(url)).blob();
    return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  }

  // ---------------------------------------------------------------- open / close, top bar, events
  function open(at = null) {
    if (!book.title && script()?.title) book.title = script().title;
    view.show(at || (script() ? (H.liveScene() && script().scenes.some((x) => x.id === H.liveScene()) ? H.liveScene() : view.at) : "front"));
    button?.setAttribute("aria-pressed", "true");
  }
  function close() { view.hide(); button?.setAttribute("aria-pressed", "false"); }

  let button = null;
  if (topBar) {
    button = document.createElement("button");
    Object.assign(button, { type: "button", className: "ss-btn ss-bookbtn", title: "Director's Book: one page per scene (intent, lighting, camera plan, floor plan, storyboard, notes), as a PDF binder" });
    button.setAttribute("aria-label", "Open the Director's Book");
    button.setAttribute("aria-pressed", "false");
    button.dataset.ssIcon = "book-open";
    button.innerHTML = `${BOOK_ICON}<span class="lbl"> Book</span>`;
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("click", () => (view.open ? close() : open()));
    if (before && before.parentNode === topBar) topBar.insertBefore(button, before); else topBar.append(button);
  }
  // A note the server stored (the Pitch agent, MCP) joins the open book.
  try {
    api?.addEventListener?.("soundstage.book", (ev) => {
      const n = ev.detail?.note;
      if (n?.id && !book.notes.some((x) => x.id === n.id)) { book.notes.push(n); changed(); }
    });
  } catch { /* no socket */ }
  // The live scene changes (scene switch): its Imagery & Pitfalls go to the Look.
  const tick = setInterval(() => { const l = H.liveScene(); if (l !== lastLive) { lastLive = l; syncLook(); } }, 1500);

  return {
    open, close, view, ctl, clay,
    get book() { return book; },
    /** Replace the book (tests, a loaded workflow). */
    load(b) { book = normalizeBook(b, script()); persist({ server: false }); if (view.open) view.render(); },
    reset() { book = emptyBook(script()); persist(); if (view.open) view.render(); },
    /** getBookContext for a scene (default: the live one): the Director's and Pitch's living memory. */
    context: (sceneId = null) => getBookContext(book, script(), sceneId ?? H.liveScene()),
    /** The Director writes back what was decided in chat. */
    recordDecision: (d = {}) => { const n = recordDecision(book, { sceneId: H.liveScene(), ...d }); if (n) changed(); return n; },
    /** A note from anyone (Pitch, a script): placed like shorthand unless a scene is given. */
    addNote: async (text, { sceneId = null, category = null, line = null, source = "pitch" } = {}) => {
      if (sceneId) { const [n] = addPlacements(book, [{ text, scope: "scene", scene_id: sceneId, line, category: category || "blocking", confidence: 1, why: `written by ${source}`, by: source }], { source }); changed(); return n; }
      const [n] = await fileNotes(text, { useModel: false });
      if (n) n.source = source;
      return n;
    },
    notesFor: (sceneId) => notesForScene(book, script(), sceneId),
    notesOnLine: (sceneId, line) => notesOnLine(book, sceneId, line),
    draft, fileNotes, exportPDF, exportMarkdown, buildPrint,
    markdown: async () => toMarkdown(book, script(), await pagesAll()),
    syncLook,
    dispose() { clearInterval(tick); clay?.dispose(); view.el.remove(); button?.remove(); },
  };
}
