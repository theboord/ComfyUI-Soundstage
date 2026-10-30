// Browser-only "try the stage" page: the real Soundstage Stage (three.js) with no ComfyUI and no server routes.
// Only sibling static files are fetched (lighting setups, style presets, GLB models).
import { Stage } from "../stage/stage.mjs";
import { icon } from "../ui/icons.mjs";
import { lensCards, sunDome } from "../ui/cinegear.mjs";
import { PRESETS } from "./scenes.mjs";
import { VOCAB } from "../look/vocab.mjs";
import { showSteps } from "./steps.mjs";

// Real names for the look ids a style suggests (stocks, lenses): "ilford_hp5" -> "Ilford HP5 (B&W)".
const LABELS = new Map(Object.values(VOCAB).filter(Array.isArray).flat().filter((o) => o?.id).map((o) => [o.id, o.label]));

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };

const stage = new Stage($("viewport"), () => {});
window.__stage = stage; // handy for poking at it from the console
stage.onInteract = (msg) => status(msg);

let playing = false, presetId = null, raf = 0, t0 = 0, f0 = 0;
const fps = () => stage.state.shot?.fps || 24;
const lastFrame = () => Math.max(1, (stage.state.shot?.frames || 97) - 1);

function timecode(f) {
  const r = fps(), s = Math.floor(f / r), ff = f % r;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

// ---------- transport ----------
const playBtn = $("play"), scrub = $("scrub");
function showFrame() {
  scrub.max = lastFrame();
  scrub.value = stage.frame;
  $("tc").textContent = `${timecode(stage.frame)}  ·  f${stage.frame}/${lastFrame()}`;
}
function setPlaying(on) {
  playing = on;
  playBtn.replaceChildren(icon(on ? "pause" : "play", 18));
  playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
  cancelAnimationFrame(raf);
  if (on) { t0 = performance.now(); f0 = stage.frame >= lastFrame() ? 0 : stage.frame; raf = requestAnimationFrame(tick); }
}
function tick(now) {
  if (!playing) return;
  const f = (f0 + Math.floor(((now - t0) / 1000) * fps())) % (lastFrame() + 1);
  if (f !== stage.frame) { stage.setFrame(f); showFrame(); }
  raf = requestAnimationFrame(tick);
}
playBtn.onclick = () => setPlaying(!playing);
scrub.oninput = () => { setPlaying(false); stage.setFrame(+scrub.value); showFrame(); };
document.addEventListener("keydown", (e) => {
  if (e.target?.closest?.("input, select, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); setPlaying(!playing); }
  if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
    setPlaying(false); stage.setFrame(stage.frame + (e.code === "ArrowRight" ? 1 : -1)); showFrame();
  }
});

// ---------- segmented buttons ----------
function seg(el, items, onPick) {
  el.innerHTML = "";
  const btns = items.map(([value, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.dataset.value = value;
    b.onclick = () => { mark(value); onPick(value); };
    el.append(b);
    return b;
  });
  const mark = (v) => btns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(v))));
  return { mark };
}

const viewSeg = seg($("views"), [["wire", "Wire"], ["clay", "Clay"], ["color", "Color"], ["depth", "Depth"]], (m) => stage.setView(m));
const camSeg = seg($("camMode"), [["shot", "Shot cam"], ["free", "Free view"]], (m) => {
  stage.setFreeView(m === "free");
  status(m === "free" ? "Free view: look around freely; the shots don't change. Lost? Tap Shot cam to jump back to the shot." : "Shot cam: what the selected shot films. Dragging here re-aims the shot at the playhead.");
});
$("viewport").addEventListener("pointerdown", () => { if (playing) setPlaying(false); }, true);   // hold still while you grab things
$("undo").addEventListener("click", () => { status(stage.undo() ? "Undone." : "Nothing to undo."); });
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) {
    e.preventDefault();
    status((e.shiftKey ? stage.redo() : stage.undo()) ? (e.shiftKey ? "Redone." : "Undone.") : "Nothing to undo.");
  }
});
stage.onView = (free) => camSeg.mark(free ? "free" : "shot");

function renderShots() {
  const shots = stage.state.shots || [];
  const s = seg($("shots"), shots.map((x) => [x.id, x.name]), (id) => {
    if (stage.freeView) stage.setFreeView(false);
    stage.setActiveShot(id);
  });
  s.mark(stage.state.active_shot);
  lens.set(currentFocal());
}
stage.onShots = () => { renderShots(); };

// ---------- lens ----------
const currentFocal = () => {
  const keys = stage.activeShot().camera_keys;
  return keys[0]?.focal_mm || 35;
};
const lens = lensCards((mm) => { stage.setFocal(mm); lens.set(mm); status(`${mm} mm on "${stage.activeShot().name}" (the camera key at the playhead).`); });
$("lens").append(lens.el);

// ---------- sun ----------
const az = $("sunAz"), el = $("sunEl");
const dome = sunDome((a, e) => { az.value = a; el.value = e; applySun(); });
$("dome").append(dome.el);
function applySun() {
  stage.setSun(+az.value, +el.value);
  $("sunAzV").textContent = `${az.value}°`;
  $("sunElV").textContent = `${el.value}°`;
  dome.set(+az.value, Math.max(0, +el.value));
}
az.oninput = el.oninput = applySun;
function syncSun() {
  const s = stage.state.sun || { azimuth_deg: 235, elevation_deg: 18 };
  az.value = Math.round(s.azimuth_deg); el.value = Math.round(s.elevation_deg);
  $("sunAzV").textContent = `${az.value}°`; $("sunElV").textContent = `${el.value}°`;
  dome.set(+az.value, Math.max(0, +el.value));
}

// ---------- lighting setups ----------
let setups = [];
fetch(new URL("../look/lighting_setups.json", import.meta.url)).then((r) => r.json()).then((d) => {
  setups = d.setups || [];
  const sel = $("lightLike");
  for (const s of setups) {
    const o = document.createElement("option");
    o.value = s.id; o.textContent = s.label;
    sel.append(o);
  }
}).catch((e) => status(`Could not load lighting setups (${e.message}).`));
$("lightLike").onchange = (e) => {
  const s = setups.find((x) => x.id === e.target.value);
  if (!s) return;
  const n = stage.applyLightingSetup(s);
  const who = stage.state.actors.find((x) => x.id === stage.selected) || stage.state.actors[0];
  status(`${s.label}: ${n} light${n === 1 ? "" : "s"} placed around ${who?.name || "the subject"}, relative to the camera. ${s.summary || ""}`);
  showPrompt();
};

function showPrompt() { $("prompt").textContent = stage.lightingPrompt() || ""; }

// ---------- add ----------
$("addForm").onsubmit = (e) => {
  e.preventDefault();
  const raw = $("addText").value.trim();
  if (!raw) return;
  // "2 men", "three horses": add that many (up to 6).
  const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2, pair: 2 };
  const m = /^(a couple of|a pair of|\d+|an?|one|two|three|four|five|six)\s+(.+)$/i.exec(raw);
  const count = m ? Math.min(6, +m[1] || WORDS[m[1].toLowerCase().replace(/^a (couple|pair) of$/, "$1")] || 1) : 1;
  let text = m ? m[2] : raw;
  const single = { men: "man", women: "woman", children: "child", people: "man", persons: "man" }[text.toLowerCase()];
  if (single) text = single; else if (count > 1) text = text.replace(/(?<=\w{3})s$/i, "");
  const labels = [];
  const h0 = stage._hist?.length ?? 0;
  for (let i = 0; i < count; i++) { const l = stage.addObject(text); if (!l) break; labels.push(l); }
  if (labels.length > 1 && stage._hist) stage._hist.splice(h0, labels.length - 1);   // one Undo removes the whole group
  const label = labels.join(", ");
  status(label ? `Added ${label}. Drag ${labels.length > 1 ? "them" : "it"} in the viewport; drop a person on a horse or car to mount, or a small prop on a person to hand it over.`
    : `"${raw}" is not in the library. Try: horse, police car, sports car, flashlight, dog, bench, crate, tree.`);
  if (label) $("addText").value = "";
};

// ---------- selection (flashlight beam) ----------
stage.onSelect = (info) => {
  const box = $("selection");
  if (!info) { box.hidden = true; return; }
  box.hidden = false;
  const a = stage.state.actors.find((x) => x.id === info.id);
  $("selName").textContent = a?.name || info.kind || info.id;
  status(`Selected ${a?.name || info.kind}. ` + (a?.kind === "flashlight" ? "Pick its beam below, or drag it onto a person to hand it over."
    : ["man", "woman", "child"].includes(a?.kind) ? "Drag onto a horse or car to get on or in." : "Drag it to move it.")
    + " The faint yellow figure beside it is a 1.75 m person, for scale.");
  const beam = $("beam");
  beam.hidden = a?.kind !== "flashlight";
  if (a?.kind === "flashlight") beamSeg.mark(a.beam || "steady");
};
const beamSeg = seg($("beamBtns"), [["steady", "Steady"], ["flicker", "Flicker"], ["blink", "Blink"], ["off", "Off"]], (m) => {
  if (stage.selected) { stage.setBeam(stage.selected, m); showPrompt(); }
});

// ---------- genre styles ----------
fetch(new URL("../look/style_presets.json", import.meta.url)).then((r) => r.json()).then((list) => {
  const strip = $("styles");
  for (const p of list) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = p.label;
    b.onclick = () => {
      for (const x of strip.children) x.setAttribute("aria-pressed", String(x === b));
      const mm = p.focal_mm ? stage.styleFocal(p.focal_mm) : null;
      if (mm) { stage.setFocal(mm); lens.set(mm); }
      const s = p.suggest || {};
      const rng = s.focal_range_mm ? `${s.focal_range_mm[0]}–${s.focal_range_mm[1]} mm` : null;
      const fmt = (v) => LABELS.get(v) || String(v).replace(/_/g, " ");
      $("styleInfo").innerHTML = "";
      const h = document.createElement("strong"); h.textContent = p.label;
      const sum = document.createElement("p"); sum.textContent = p.summary || "";
      const dl = document.createElement("p");
      dl.className = "muted";
      dl.textContent = [mm && `Lens ${mm !== p.focal_mm ? "kept at" : "set to"} ${mm} mm${mm !== p.focal_mm ? ` (the style suggests ${p.focal_mm} mm; this camera rides in or on the car, so it keeps its own lens)` : rng ? ` (range ${rng})` : ""}`,
        s.lenses?.length && `glass: ${s.lenses.map(fmt).join(", ")}`,
        s.film_stocks?.length && `stock: ${s.film_stocks.map(fmt).join(", ")}`,
        p.craft?.lighting && `light: ${p.craft.lighting}`].filter(Boolean).join(" · ");
      $("styleInfo").append(h, sum, dl);
    };
    strip.append(b);
  }
}).catch(() => {});

// ---------- presets ----------
function loadPreset(p) {
  setPlaying(false);
  presetId = p.id;
  for (const b of $("presets").children) b.setAttribute("aria-pressed", String(b.dataset.id === p.id));
  stage.freeInit = false;            // free view re-centres on the new set
  stage.setFreeView(false);
  stage.load(p.make());
  stage.resetHistory();              // Undo never jumps back to a previous preset
  stage.select(null);
  stage.setView(p.view);
  viewSeg.mark(p.view);
  $("lightLike").value = "";
  renderShots();
  syncSun();
  showFrame();
  showPrompt();
  showSteps(p.id);
  status(`Loaded "${p.label}". Press Play, switch shots, or drag in the viewport to move the camera.`);
}
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = p.label; b.dataset.id = p.id;
  b.onclick = () => { loadPreset(p); setPlaying(true); };
  $("presets").append(b);
}

loadPreset(PRESETS[0]);
window.__tryit = { loadPreset: (i) => loadPreset(PRESETS[i]), setPlaying, showFrame };
