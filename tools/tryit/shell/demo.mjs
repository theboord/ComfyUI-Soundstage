// Soundstage App, static demo: the real App widget (extensions/soundstage/soundstage.js) on a stand-in ComfyUI.
// Built by tools/tryit/build_tryit.py; the scenes are r/scenes/<key>.json, the What's new tour is tour.json.
import "./scripts/glbshim.js";
import { app } from "./scripts/app.js";
import { api, demo } from "./scripts/api.js";
import { LABEL, GLYPH, provenanceNow, stopProvenance, clipProvenance } from "./provenance.mjs";

const $ = (id) => document.getElementById(id);
export const SCENES = [
  ["Start here", [
    ["stunt", "Stunt: reverse J-turn (clay to Hollywood)"],
    ["drycreek", "Dry Creek: a script, its takes and ScriptSync"],
    ["blank", "A brand-new stage (the first-run card)"],
  ]],
  ["Water", [
    ["lake", "Lake: speedboat run"],
    ["swim", "Reef: a diver swimming"],
    ["underwater", "Underwater reef (renders)"],
  ]],
  ["Cars, stunts and horses", [
    ["car", "In the car: seated cast, see-through glass"],
    ["three", "Three in a car"],
    ["chase", "Night car chase (lit lamps)"],
    ["western", "Western: riders on horses"],
  ]],
  ["Live 3D", [
    ["physics", "Live physics: climb, mount, pick up, push"],
  ]],
  ["New sets", [
    ["fire", "Burning building"],
    ["airplane", "Airplane cabin"],
    ["train", "Train carriage"],
    ["platform", "Train station platform"],
    ["runway", "Airport runway"],
    ["clouds", "Above the clouds"],
  ]],
  ["Genres", [
    ["aliens", "Sci-fi: alien invasion"],
    ["horror", "Horror: haunted woods"],
    ["romance", "Romance: beach at sunset"],
    ["kaiju", "Monster: kaiju attack"],
    ["torch", "Flashlight search"],
  ]],
];
const KEYS = SCENES.flatMap(([, items]) => items.map(([k]) => k));
// #scene or #scene--stop (a tour stop to run once the scene is up).
const [hashKey, hashStop] = location.hash.slice(1).split("--");
const key = KEYS.includes(hashKey) ? hashKey : "stunt";
const HERO = !location.hash;   // the first screen: only on a plain visit (tour links and scene picks go straight in)

// The App's own Guide tour runs once per browser; in the demo it waits for "?" except on the brand-new stage.
try { if (key === "blank") localStorage.removeItem("ss_tour_done"); else localStorage.setItem("ss_tour_done", "1"); } catch { /* storage blocked */ }

// ---------------------------------------------------------------- scene picker
const sel = $("scene");
for (const [group, items] of SCENES) {
  const og = Object.assign(document.createElement("optgroup"), { label: group });
  for (const [k, label] of items) og.append(new Option(label, k, false, k === key));
  sel.append(og);
}
sel.addEventListener("change", () => openScene(sel.value));
function openScene(k, stop = "") {
  const h = `#${k}${stop ? `--${stop}` : ""}`;
  if (location.hash === h) location.reload();
  else { location.hash = h; location.reload(); }
}

let toastT = 0;
demo.toast = (msg) => {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 5600);
};

// ---------------------------------------------------------------- the first screen: clay | take, one wipe
// One video holds both halves side by side (left: the stage's Color pass, right: the Hollywood final), so the two can
// never drift; a canvas draws the left half up to the split and the right half after it.
let heroOpen = false, readyNow;
const ready = new Promise((r) => (readyNow = r));   // the tour and its stops exist once the module has run to the end
const HERO_FILE = "m_hero_jturn.mp4";
/** A badge's look and its one-line note (title for the mouse, aria-label for screen readers). */
function setProv(el, p, { long = "", keepText = false } = {}) {
  el.classList.toggle("live", p.mode === "live");
  el.classList.toggle("replayed", p.mode !== "live");
  el.dataset.prov = p.mode;
  el.title = p.note;
  el.setAttribute("aria-label", p.note);
  if (!keepText) {
    el.replaceChildren(`${GLYPH[p.mode]} ${LABEL[p.mode]}`);
    if (long) el.append(Object.assign(document.createElement("span"), { className: "long", textContent: long }));
  }
  return el;
}
const provBadge = (p) => setProv(Object.assign(document.createElement("span"), { className: "prov" }), p);
function heroSetup() {
  const sec = $("hero"), cv = $("heroCv"), box = cv.parentElement, knob = $("heroSplit");
  const ctx = cv.getContext("2d");
  const v = Object.assign(document.createElement("video"), { muted: true, loop: true, playsInline: true, preload: "auto", autoplay: true });
  v.src = new URL(`./r/${HERO_FILE}`, import.meta.url).href;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let split = 0.5, user = false, raf = 0, t0 = performance.now();
  const W = cv.width, H = cv.height;
  function draw() {
    raf = requestAnimationFrame(draw);
    if (!user && !still) split = 0.5 + 0.28 * Math.sin((performance.now() - t0) / 1900);
    knob.style.left = `${(split * 100).toFixed(2)}%`;
    knob.setAttribute("aria-valuenow", String(Math.round(split * 100)));
    if (v.readyState < 2) return;
    const x = Math.round(split * W), vw = v.videoWidth / 2 || W, k = vw / W;
    if (x > 0) ctx.drawImage(v, 0, 0, x * k, v.videoHeight, 0, 0, x, H);
    if (x < W) ctx.drawImage(v, vw + x * k, 0, (W - x) * k, v.videoHeight, x, 0, W - x, H);
  }
  const setFrom = (e) => { const r = box.getBoundingClientRect(); split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  box.addEventListener("pointerdown", (e) => { user = true; setFrom(e); box.setPointerCapture(e.pointerId); });
  box.addEventListener("pointermove", (e) => { if (box.hasPointerCapture(e.pointerId)) setFrom(e); });
  knob.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[e.key];
    if (d == null) return;
    e.preventDefault(); user = true; split = Math.max(0, Math.min(1, split + d));
  });
  const close = () => {
    if (!heroOpen) return;
    heroOpen = false; sec.hidden = true; cancelAnimationFrame(raf); v.pause();
    try { sessionStorage.setItem("ss_demo_hero", "0"); } catch { /* storage blocked */ }
  };
  const open = () => {
    heroOpen = true; sec.hidden = false; t0 = performance.now();
    v.play().catch(() => { /* autoplay blocked: the first frame still draws */ });
    cancelAnimationFrame(raf); draw(); $("heroGo").focus({ preventScroll: true });
  };
  $("heroGo").addEventListener("click", close);
  $("heroTour").addEventListener("click", async () => { close(); await ready; setTour(true); });
  $("heroV2s").addEventListener("click", async () => { close(); await ready; setTour(true); runStop("v2s"); });
  sec.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  $("introBtn").addEventListener("click", () => (heroOpen ? close() : open()));
  return { open, close };
}
const hero = heroSetup();
let heroSeen = null;
try { heroSeen = sessionStorage.getItem("ss_demo_hero"); } catch { /* storage blocked */ }
if (HERO && heroSeen !== "0") hero.open();

// ---------------------------------------------------------------- the scene
const data = key === "blank" ? { workflow: "Soundstage_App", note: "A brand-new stage: the first-run card offers the demo scene, a script or a video." }
  : await (await fetch(new URL(`./r/scenes/${key}.json`, import.meta.url))).json();
const vocab = await fetch(new URL("./r/canned/advisor_vocab.json", import.meta.url)).then((r) => r.json()).catch(() => ({}));
demo.scene = { key, compile: data.compile, advisor: data.advisor, vocab, cut: data.cut, cutSeconds: data.cutSeconds,
  candidates: data.candidates || {},
  renders: JSON.parse(JSON.stringify(data.props?.ss_renders || {})) };   // frozen: what the GPU actually made
await import("./extensions/soundstage/soundstage.js");

// The App graph: the stage node plus the nodes it reads and the rung outputs it listens to (same ids as the workflow).
const { Node, Widget } = app;
const W = (name, value, options) => new Widget(name, value, options);
const g = app.graph;
const v = data.widgets || {};
const stageNode = g.add(new Node(9045, "SoundstageStage", "stage"));
stageNode.properties = JSON.parse(JSON.stringify(data.props || {}));
g.add(new Node(9056, "KSampler", "Look still (Krea 2, depth-steered)", [W("seed", v.seed ?? 205204803), W("steps", 8), W("cfg", 1), W("denoise", v.denoise ?? 0.85)]));
g.add(new Node(9081, "SoundstageEditImage", "Still model (any)", [W("model", v.still_model || data.stillModels?.[1] || "", { values: data.stillModels || [] }), W("seed", 0), W("lora", "None", { values: ["None", "your_character.safetensors", "your_house_style.safetensors"] }), W("lora_strength", 1), W("steps", 0), W("cfg", 0), W("negative", ""), W("ref_files", "")]));
g.add(new Node(5516, "Sampler", "Sampler - Distilled (8 steps)", [W("cfg", 1), W("sampler_name", "euler_ancestral")]));
g.add(new Node(9034, "Sampler", "Upscale and re-sampler (3 steps)", [W("cfg", 1), W("sampler_name", "euler_ancestral")]));
g.add(new Node(5509, "PrimitiveStringMultiline", "Prompt (negative)", [W("value", "")]));
g.add(new Node(9082, "ComfySwitchNode", "Still model · use picker", [W("switch", true)]));
g.add(new Node(9083, "SoundstageGenerateVideo", "Video model (any)", [W("model", data.videoModels?.[0] || "", { values: data.videoModels || [] }), W("seed", 0), W("sound", ""), W("music", ""), W("line", "")]));
g.add(new Node(9084, "ComfySwitchNode", "Video model · use picker", [W("switch", false)]));
g.add(new Node(9086, "ComfySwitchNode", "Use touched-up still", [W("switch", false)]));
g.add(new Node(9087, "SoundstageShotSound", "Sound · line, SFX, music", ["line", "character", "voice", "dialogue_engine", "sfx_prompt", "music_mood"]
  .map((n) => W(n, (v.sound || {})[n] ?? ""))));
g.add(new Node(9091, "SoundstageLTXVoice", "LTX voice", [W("prompt", ""), W("audio_mask", 0.35), W("soundtrack", "ltx")]));
g.add(new Node(9092, "SoundstageWhen", "Audio drives the video", [W("enabled", false)]));
g.add(new Node(9096, "SoundstageQuality", "Quality · motion freedom", [W("motion_freedom", v.motion_freedom ?? 0.5), W("quality", "Draft")]));
const stepNode = g.add(new Node(9059, "SoundstageStep", "NEXT ▸ (1 Stage · 2 Look · 3 Draft · 4 Final · 5 Layers)", [W("step", 1)]));
g.add(new Node(9079, "SoundstageLook", "Look (Look tab → prompts)", [W("look", data.look || "")]));
for (const [id, title] of [[9099, "Rung 1 · Previz video"], [9060, "Rung 1 · Stage frame 1"], [9058, "Rung 2 · Look still"],
  [9063, "Rung 3 · Motion draft"], [4852, "Rung 4 · Final"], [9090, "Rung 4 · Final + sound"], [9094, "Rung 4 · Final · audio-driven"],
  [9077, "Rung 5 · Layer Pack"], [9078, "Rung 5 · Layers preview"], [9097, "Rung 5 · Layer Pack folder"]]) g.add(new Node(id, "Output", title));
app.extensionManager.workflow.activeWorkflow.path = `workflows/${data.workflow || key}.json`;

const ext = app.extensions.find((e) => e.name === "soundstage.stage");
ext.getCustomWidgets().SOUNDSTAGE_STAGE(stageNode, "stage");
$("host").append(stageNode.domWidget.element);
if (data.scene) stageNode.domWidget.value = data.scene;      // like ComfyUI restoring the workflow's widget value

demo.getShot = () => stageNode.ssStage?.activeShot().id;
demo.getStep = () => stepNode.widgets[0].value;
window.__demo = { app, api, demo, node: stageNode, key };   // tests and the tour

// The Advisor starts from the scene's own description (a new visitor hasn't typed one yet).
try {
  const desc = JSON.parse(data.look || "{}").description;
  const ta = document.querySelector(".ss-advisorview textarea");
  if (desc && ta && !ta.value) { ta.value = desc; ta.dispatchEvent(new Event("input", { bubbles: true })); }
} catch { /* no look */ }
$("sceneNote").textContent = data.note || "";
$("sceneNote").title = data.note || "";

// Open each scene where it reads best: in Color, mid-move.
const START = { lake: 40, drycreek: 40, chase: 40, stunt: 52, car: 30, three: 30, western: 40, platform: 60, runway: 60, clouds: 40, aliens: 40, kaiju: 40 };
if (key !== "blank") setTimeout(() => {
  try {
    [...root().querySelectorAll("button")].find((x) => x.getClientRects().length && x.textContent.trim() === "Color")?.click();
    if (START[key] != null) S().setFrame(START[key]);
  } catch { /* the stage isn't up */ }
}, 900);

// ---------------------------------------------------------------- What's new: tour stops
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = () => stageNode.ssPipeline;
const S = () => stageNode.ssStage;
const root = () => stageNode.domWidget.element;
const btn = (re, scope = root()) => [...scope.querySelectorAll("button")].find((b) => b.getClientRects().length && re.test((b.textContent || "").trim()));
function flash(el) {
  if (!el) return;
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const o = el.style.outline, of = el.style.outlineOffset;
  el.style.outline = "3px solid #F2FF59"; el.style.outlineOffset = "2px";
  setTimeout(() => { el.style.outline = o; el.style.outlineOffset = of; }, 2600);
}
const view = (label) => btn(new RegExp(`^${label}$`))?.click();
function selectActor(re) {
  const a = (S().toJSON().actors || []).find((x) => re.test(`${x.id} ${x.name} ${x.kind}`));
  if (a) S().select(a.id);
  return a;
}
// By kind only: the chase's driver is id "getaway", which /getaway|car/ picked before the car itself.
function selectKind(...res) {
  const all = S().toJSON().actors || [];
  for (const re of res) { const a = all.find((x) => re.test(x.kind || "")); if (a) { S().select(a.id); return a; } }
  return null;
}
const ACTIONS = {
  async set() { P().go("set"); },
  async color() { P().go("set"); await sleep(300); view("Color"); },
  async frame() { P().go("frame"); },
  async motion() { P().go("motion"); },
  async review() { P().go("review"); },
  async deliver() { P().go("deliver"); },
  async script() { P().go("script"); },
  async scriptsync() { stageNode.ssDailies?.openScriptSync(); },
  async takes() { P().go("set"); await sleep(200); stageNode.ssDailies?.openScriptSync(); await sleep(400); try { stageNode.ssDailies.bin.setView("bin"); } catch { /* */ } },
  async ripple() { P().go("motion"); await sleep(600); P().ripple?.setMode("ripple"); },
  async pose() { P().go("motion"); await sleep(600); P().ripple?.setMode("pose"); },
  async rider() { await ACTIONS.color(); await sleep(300); selectActor(/rider|cowboy|man|woman/i); },
  async seated() { await ACTIONS.color(); },
  async physics() {
    await ACTIONS.color(); await sleep(300);
    selectActor(/crate/i); await sleep(500);
    const pb = btn(/^Physics$/); pb?.click(); flash(pb);
  },
  async stunt() {
    await ACTIONS.color(); await sleep(300);
    selectKind(/^sports_car$/, /car/); await sleep(600);
    const s = [...root().querySelectorAll("select")].find((x) => x.getClientRects().length && [...x.options].some((o) => /J-turn/.test(o.text)));
    flash(s?.closest("label, .row, div") || s);
  },
  async dcc() {
    P().go("deliver"); await sleep(700);
    flash(btn(/DCC kit/i));
  },
  async firstrun() { /* the card is the stage */ },
  // Director: the panel opens; its planner and language model answer "available in the full install".
  async director() { P().go("set"); await sleep(300); stageNode.ssDirector?.open(); flash(stageNode.ssDirector?.panel); },
  async presets() { P().go("set"); await sleep(300); stageNode.ssPresets?.open("camera"); },
  async timeline() { root().querySelector('[data-tab="cut"]')?.click(); },
  async hollywood() {
    P().go("motion"); await sleep(700);
    const seg = P().m?.qSeg;
    seg?.querySelector('[data-q="Hollywood"]')?.click();
    flash(seg);
  },
  // Take checks: ⑥ Review on the shot with flagged takes (the chips are the server's real results).
  async takechecks() {
    const flagged = (S().toJSON().shots || []).find((s) => s.id === "crane");
    if (flagged) S().setActiveShot?.(flagged.id);
    P().go("review");
  },
  async viewfinder() { P().go("set"); await sleep(300); stageNode.ssViewfinder?.open(); },
  // Pitch Mode: the Director panel's Pitch button (listening, transcription and the sketches run on the GPU in the full install).
  async pitch() { P().go("set"); await sleep(300); stageNode.ssDirector?.open(); await sleep(400); flash(root().querySelector(".ss-dir .pitchb") || document.querySelector(".ss-dir .pitchb")); },
  // The Director's Book: a binder page per scene (Book in the top bar).
  async book() { P().go("script"); await sleep(400); stageNode.ssBook?.open(); },
  // Real performance: the selected person's "Real performance…" button (capture and render run on the GPU in the full install).
  async performance() {
    await ACTIONS.color(); await sleep(300);
    selectKind(/^(woman|man|child)$/); await sleep(700);
    flash(btn(/Real performance/));
  },
  // Parts (Milestone 26): the selected car's doors, lamps, steering and suspension, every channel keyable.
  async parts() {
    await ACTIONS.color(); await sleep(300);
    selectKind(/^sports_car$/, /car/); await sleep(700);
    const pp = root().querySelector(".ss-parts");
    for (const d of pp?.querySelectorAll("details") || []) if (/door|light|lamp/i.test(d.querySelector("summary")?.textContent || "")) d.open = true;
    flash(pp);
  },
  async gaits() { await ACTIONS.rider(); },
  // Drive mode (Milestone 29): the red car selected, its 🎮 Drive button shown; D starts it.
  async drive() {
    await ACTIONS.color(); await sleep(300);
    selectKind(/^sports_car$/, /car/); await sleep(700);
    flash(btn(/Drive/));
  },
  // Boats: the speedboat on the lake, playing.
  async boats() {
    await ACTIONS.color(); await sleep(300);
    selectKind(/boat|canoe|kayak|raft|dinghy|yacht/); await sleep(300);
    S().setFrame(0); await sleep(200); playStage();
  },
  // Swimming: Clay view (the kit and the kick read best in clay), the diver selected, playing.
  async swim() {
    P().go("set"); await sleep(300); view("Clay"); await sleep(300);
    selectKind(/^(woman|man|child)$/); await sleep(300);
    S().setFrame(0); await sleep(200); playStage();
  },
  // Video → 3D: the J-turn clip goes into the App's own chooser, exactly as a drop on the stage would.
  async v2s() {
    P().go("set"); await sleep(300);
    const blob = await (await fetch(new URL("./r/m_v2s_source.mp4", import.meta.url))).blob();
    const f = new File([blob], "jturn_night_street.mp4", { type: "video/mp4" });
    const inp = [...root().querySelectorAll('input[type="file"]')].find((x) => /video|mp4/.test(x.accept || ""));
    if (!inp) return;
    const dt = new DataTransfer(); dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    // The rebuild replaces the J-turn stage (the chooser's own Replace button), so the set you see is the clip's.
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const rep = [...document.querySelectorAll(".ss-vi-modal button")].find((x) => /^Replace the set/.test(x.textContent.trim()));
      if (rep) { rep.click(); break; }
    }
  },
  // ✦ One-click: ④ Frame replays its candidates, then the ✦ on the first one opens the card window.
  async oneclick() {
    P().go("frame"); await sleep(900);
    if (!(P().candidates?.[S().activeShot().id] || []).length) { P().f.goBtn.click(); await sleep(3200); }
    const b1 = [...root().querySelectorAll("button")].find((x) => x.getClientRects().length && /^One-click/.test(x.title || ""));
    flash(b1); b1?.click();
  },
};
/** Play from the current frame (the transport's own Play). */
function playStage() { btn(/^Play$/)?.click(); }
async function runStop(id) {
  const stop = tour.steps.find((s) => s.id === id);
  if (!stop) return;
  markCurrent(id);
  try { await ACTIONS[stop.do || "set"]?.(); } catch (e) { console.warn("[demo] tour stop", id, e); }
  if (stop.say) demo.toast(stop.say);
}

const tour = await fetch(new URL("./tour.json", import.meta.url)).then((r) => r.json()).catch(() => ({ steps: [] }));
function markCurrent(id) { for (const li of $("tourList").children) li.toggleAttribute("aria-current", false), li.dataset.id === id && li.setAttribute("aria-current", "step"); }
for (const s of tour.steps) {
  const li = document.createElement("li");
  li.dataset.id = s.id;
  const show = Object.assign(document.createElement("button"), { type: "button", className: "go", textContent: s.scene === key ? "Show me" : "Open" });
  show.addEventListener("click", () => {
    if (s.scene && s.scene !== key) openScene(s.scene, s.id);
    else runStop(s.id);
  });
  const row = document.createElement("div");
  row.className = "row";
  row.append(show);
  // The clips are recordings: one Replayed badge leads them, and each Watch button carries its own note.
  if ((s.clips || []).length) row.append(provBadge({ mode: "replayed", note: "Replayed: the Watch clips are recorded earlier (GPU renders or screen captures of the App)." }));
  for (const c of s.clips || []) {
    const w = Object.assign(document.createElement("button"), { type: "button", textContent: `Watch: ${c.label}` });
    const p = clipProvenance(c);
    w.dataset.prov = p.mode; w.title = p.note;
    w.addEventListener("click", () => playClip(c));
    row.append(w);
  }
  const hd = Object.assign(document.createElement("div"), { className: "hd" });
  hd.append(Object.assign(document.createElement("b"), { textContent: s.title }), provBadge(stopProvenance(s)));
  li.append(hd, Object.assign(document.createElement("p"), { textContent: s.text }), row);
  $("tourList").append(li);
}
function setTour(open) {
  $("tour").hidden = !open;
  $("tourBtn").setAttribute("aria-expanded", String(open));
  try { sessionStorage.setItem("ss_demo_tour", open ? "1" : "0"); } catch { /* storage blocked */ }
}
$("tourBtn").addEventListener("click", () => setTour($("tour").hidden));
$("tourClose").addEventListener("click", () => setTour(false));

function playClip(c) {
  const d = $("clip");
  $("clipTitle").textContent = c.label;
  $("clipNote").textContent = c.note || "";
  setProv($("clipProv"), clipProvenance(c));
  const src = new URL(`./r/${c.file}`, import.meta.url).href;
  const media = /\.(jpe?g|png)$/i.test(c.file)
    ? Object.assign(document.createElement("img"), { src, alt: c.label })
    : Object.assign(document.createElement("video"), { src, controls: true, playsInline: true, autoplay: true, muted: !!c.muted, loop: true });
  $("clipBody").replaceChildren(media);
  d.showModal();
}
$("clipClose").addEventListener("click", () => $("clip").close());
$("clip").addEventListener("close", () => $("clipBody").replaceChildren());

// A tour stop in the link (#scene--stop) runs once the stage has settled; the tour card stays open while touring.
let keepOpen = null;
try { keepOpen = sessionStorage.getItem("ss_demo_tour"); } catch { /* storage blocked */ }
if (hashStop || keepOpen === "1") setTour(true);
if (hashStop) setTimeout(() => runStop(hashStop), 1800);

// ---------------------------------------------------------------- Live or Replayed: what the visitor is looking at now
// The first screen's wipe is a recording; its note is the tour clip's own note for the same file.
setProv($("heroProv"), clipProvenance(tour.steps.flatMap((s) => s.clips || []).find((c) => c.file === HERO_FILE) || { file: HERO_FILE }), { keepText: true });
// The bar badge follows the screen: the tab that is up (a non-step tab such as Takes or the Timeline wins over the step
// bar, which keeps the last step), the step's shot and its renders, and the Video → 3D replay (Replayed while it runs
// and while its Identical? bar is up; after that the Live note says the set came from that run, until the scene changes).
function v2sNow() {
  const r = demo.v2s;
  if (!r) return null;
  const loading = r.doneAt && performance.now() - r.doneAt < 4000;   // the App loads the result, then opens the bar
  const showing = r.running || loading || [...document.querySelectorAll(".ss-v2c")].some((e) => e.getClientRects().length);
  return showing ? r : (r.doneAt ? { ...r, after: true } : null);
}
// soundstage.js showView marks these tabs on the stage root (and shows .ss-lookview for the Look).
const VIEW_CLASSES = [["ss-advmode", "advisor"], ["ss-dailiesmode", "dailies"], ["ss-cutmode", "cut"], ["ss-canvasmode", "canvas"]];
function viewNow() {
  const el = root();
  if (!el) return "";
  for (const [cls, k] of VIEW_CLASSES) if (el.classList.contains(cls)) return k;
  const look = el.querySelector(".ss-lookview");
  return look && !look.hidden ? "look" : "";
}
function provNow() {
  let step = "set", shot = null, view = "";
  try { step = P()?.current || "set"; shot = S()?.activeShot()?.id ?? null; view = viewNow(); } catch { /* the stage isn't up */ }
  return provenanceNow({ step, view, shot, scene: demo.scene, v2s: v2sNow() });
}
let provLast = "";
function drawProv() {
  const p = provNow();
  if (p.mode + p.note === provLast) return;
  provLast = p.mode + p.note;
  setProv($("prov"), p, { long: p.mode === "live" ? " in your browser" : " from a real run" });
}
$("prov").addEventListener("click", () => demo.toast(provNow().note));   // a phone has no hover: a tap shows the note
drawProv();
setInterval(drawProv, 500);
window.__demo.prov = provNow;
readyNow();
