// Demo dailies for web/dailies/preview.html: the sample script (script/demo_script.mjs) plus one ORIGINAL two-person
// dialogue scene written for this demo only (the sample's scenes are short on dialogue), fake camera setups and takes
// with thumbnails drawn on a canvas. No external images, no real people: figures are flat silhouettes seen from the
// side or behind.
//
//   import { demoDailies } from "./demo_dailies.mjs";
//   const { script, shots, renders } = demoDailies();      // renders: {shotId: [take, ...]} (the take-list form)
import { demoScript } from "../script/demo_script.mjs";

const A = (text) => ({ type: "action", text });
const C = (character, ext = "") => ({ type: "character", text: ext ? `${character} ${ext}` : character, character });
const P = (character, text) => ({ type: "parenthetical", text, character });
const D = (character, text) => ({ type: "dialogue", text, character });

/** Scene 4, written for the dailies demo: the epilogue in a roadside diner. */
export const DINER_SCENE = {
  id: "sc_4", number: "4", heading: "INT. ROADSIDE DINER - NIGHT", int_ext: "INT", location: "ROADSIDE DINER", time: "NIGHT",
  index: 4, eighths: 13, numbered: true, section: "",
  elements: [
    A("Neon hums in the window: EAT, the T burned out. Rain streaks the glass. The place is empty but for a COOK scraping the grill."),
    A("Mara sits in the corner booth, hair still stiff with salt, both hands around a mug of coffee. A slice of pie sits untouched."),
    A("The door bell JANGLES. Ezra steps in out of the rain, hat dripping, and takes the seat across from her without asking."),
    C("EZRA"), D("EZRA", "Drove all night to find you, and you're eating pie."),
    C("MARA"), D("MARA", "I'm not eating it. I'm looking at it."),
    C("EZRA"), P("EZRA", "(re: the car outside)"), D("EZRA", "You kept her running. Your father would've liked that."),
    C("MARA"), D("MARA", "My father would've wanted the key back."),
    A("Ezra reaches into his coat and sets a second brass KEY on the formica between them."),
    C("EZRA"), D("EZRA", "He had two made. Never trusted himself with just the one."),
    A("Mara stares at it. Doesn't touch it."),
    C("MARA"), P("MARA", "(quiet)"), D("MARA", "I threw the other one in the ocean."),
    C("EZRA"), D("EZRA", "I know. I watched you do it."),
    A("A long beat. The cook's radio murmurs. Mara almost smiles."),
    C("MARA"), D("MARA", "Then why bring this one?"),
    C("EZRA"), D("EZRA", "Because you're going to need a reason to come home."),
    A("He slides out of the booth, touches the brim of his hat and walks back into the rain. Mara turns the key over in her fingers."),
  ],
  characters: ["EZRA", "MARA"],
  synopsis: "Ezra finds Mara in a diner and gives her the second key.",
  outline: "Neon hums in the window. Mara sits in the corner booth; Ezra comes in out of the rain.",
  breakdown: { cast: ["EZRA", "MARA"], extras: ["cook"], props: ["coffee mug", "pie", "brass key", "hat"], vehicles: [], animals: [], wardrobe: ["hat"],
    sfx: ["rain on window"], sound: ["door bell", "radio"], music: [], set_dressing: ["neon sign", "booth", "grill"], stunts: [] },
  stage_hint: { set: "interior", time_of_day: "night", weather: "rain", objects: [] },
  notes: "",
};

// Setups per scene, in shooting order (so the first is the bare scene number, then A, B, C... skipping I and O).
// [name, setup, extra, takes: kinds oldest first]
const DINER_SHOTS = [
  ["Master · booth wide", "master", {}, ["previz", "look", "look", "final", "final"]],
  ["Wide · Ezra comes in", "wide", { coverage: { from: 0, to: 4, offscreen: [] } }, ["previz", "look", "draft"]],
  ["Two-shot · booth profile", "two_shot", {}, ["previz", "look", "look", "draft", "final"]],
  ["OTS · on Mara", "ots_a", {}, ["previz", "look", "final", "final"]],
  ["OTS · on Ezra", "ots_b", {}, ["previz", "look", "look", "final"]],
  ["Single · Mara", "single_a", {}, ["previz", "look", "final"]],
  ["Single · Ezra", "single_b", {}, ["previz", "look", "draft", "final"]],
  ["CU · Mara", "close", { character: "MARA" }, ["look", "look", "final"]],
  ["Insert · the key", "insert", { subject: "key formica" }, ["look", "final"]],
  ["Insert · neon sign", "insert", { subject: "neon" }, ["look", "look"]],
  ["CU · Ezra", "close", { character: "EZRA" }, ["previz", "look"]],
];
const DESERT_SHOTS = [
  ["Master · the standoff", "master", {}, ["previz", "look", "final", "final"]],
  ["Wide · riders come in", "wide", { coverage: { from: 0, to: 2, offscreen: [] } }, ["previz", "look", "final"]],
  ["Single · Ezra", "single_a", { character: "EZRA" }, ["previz", "look", "look", "final"]],
  ["Single · Mara", "single_b", { character: "MARA" }, ["previz", "look", "final"]],
  ["OTS · on Mara", "ots", { character: "MARA" }, ["look", "final"]],
  ["Insert · key in the dirt", "insert", { subject: "key dirt" }, ["look", "final"]],
];
// Which takes are circled (take number), per scene and setup index; the rest are left for the editor to pick.
const CIRCLED = { sc_4: { 0: 4, 2: 5, 3: 3, 5: 3, 6: 4, 8: 2 }, sc_1: { 0: 3, 2: 4, 5: 2 } };

const KIND_SECONDS = { previz: 5.04, draft: 5.04, final: 6.04 };

/** Script with the diner scene appended, shots for scenes 1 and 4, and their takes (take-list form) with drawn thumbs. */
export function demoDailies({ thumbs = true, real = null } = {}) {   // real: {sc_4: [url per setup], sc_1: [...]} = rendered frames
  const script = demoScript();
  script.scenes.push(structuredClone(DINER_SCENE));
  script.characters = script.characters.map((c) => (c.name === "MARA" || c.name === "EZRA" ? { ...c, scenes: [...c.scenes, "sc_4"] } : c));
  const shots = [], renders = {};
  const add = (sceneId, list, look) => list.forEach(([name, setup, extra, kinds], idx) => {
    const id = `${sceneId}__dl_${idx + 1}`;
    shots.push({ id, name, setup, scene_id: sceneId, ...structuredClone(extra) });
    const circ = CIRCLED[sceneId]?.[idx];
    renders[id] = kinds.map((kind, k) => {
      const n = k + 1;
      const thumb = real?.[sceneId]?.[idx] || (thumbs ? drawThumb({ look, setup, name, kind, take: n, subject: extra.subject || extra.character || name }) : null);
      // Real frames are stills: every take of the setup opens on its rendered frame (no stand-in video files).
      // (One rendered frame per setup: each take's url gets its take number so the takes stay apart.)
      const realUrl = real?.[sceneId]?.[idx] ? `${thumb}${thumb.includes("?") ? "&" : "?"}tk=${n}` : null;
      const url = realUrl || (kind === "look" ? thumb : `demo/${sceneId}/${idx}-${n}.mp4`);
      return { id: `t${n}`, kind, n, url, thumb, video: !realUrl && kind !== "look",
        seconds: KIND_SECONDS[kind] || null, circled: circ === n, created: 1000 + n };
    });
  });
  add("sc_1", DESERT_SHOTS, "desert");
  add("sc_4", DINER_SHOTS, "diner");
  return { script, shots, renders };
}

// ------------------------------------------------------------------------------------------------ thumbnails

const W = 384, H = 216;
const cache = new Map();

/** A 16:9 frame for a setup, as a JPEG data URL. Previz takes are grey clay; finals get a warmer grade and grain. */
export function drawThumb(o) {
  const key = JSON.stringify(o);
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const rnd = mulberry(hash(key));
  // Take-to-take variation: a small reframe.
  const jx = (rnd() - 0.5) * 18, jy = (rnd() - 0.5) * 8, zoom = 1 + (rnd() - 0.5) * 0.06;
  g.save();
  g.translate(W / 2 + jx, H / 2 + jy); g.scale(zoom, zoom); g.translate(-W / 2, -H / 2);
  (o.look === "desert" ? desert : diner)(g, o, rnd);
  g.restore();
  grade(g, o, rnd);
  const url = c.toDataURL("image/jpeg", 0.86);
  cache.set(key, url);
  return url;
}

function grade(g, o, rnd) {
  const img = g.getImageData(0, 0, W, H), d = img.data;
  const clay = o.kind === "previz";
  const warm = o.kind === "final" ? 1 : o.kind === "draft" ? 0.5 : 0.75;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], gg = d[i + 1], b = d[i + 2];
    if (clay) {
      const l = 0.3 * r + 0.59 * gg + 0.11 * b;
      const v = 70 + l * 0.62;
      r = v * 1.02; gg = v; b = v * 0.97;
    } else {
      r = r * (1 + 0.06 * warm); b = b * (1 - 0.05 * warm);
      if (o.kind === "final") { const n = (rnd() - 0.5) * 14; r += n; gg += n; b += n; }
    }
    d[i] = r; d[i + 1] = gg; d[i + 2] = b;
  }
  g.putImageData(img, 0, 0);
  // Vignette.
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.7);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, clay ? "rgba(0,0,0,.25)" : "rgba(0,0,0,.5)");
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  if (clay) {
    // Previz: the stage grid on the floor and a frame line.
    g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 1;
    for (let k = 1; k < 8; k++) { g.beginPath(); g.moveTo(W / 2 + (k - 4) * 22, H * 0.62); g.lineTo(W / 2 + (k - 4) * 90, H); g.stroke(); }
    g.strokeStyle = "rgba(242,255,89,.55)"; g.setLineDash([5, 4]); g.strokeRect(10.5, 10.5, W - 21, H - 21); g.setLineDash([]);
  }
}

// --- figures: flat silhouettes, side or back on.
function figure(g, x, y, s, { hat = false, hair = false, color = "#14100f", rim = null, facing = 1, seated = false } = {}) {
  g.save();
  g.translate(x, y); g.scale(s * facing, s);
  g.fillStyle = color;
  // Shoulders / torso.
  g.beginPath();
  g.moveTo(-34, seated ? 60 : 120); g.quadraticCurveTo(-36, 6, -6, -2); g.lineTo(6, -2); g.quadraticCurveTo(36, 6, 34, seated ? 60 : 120); g.closePath(); g.fill();
  // Neck and head.
  g.fillRect(-6, -14, 12, 16);
  g.beginPath(); g.ellipse(2, -30, 14, 17, 0, 0, Math.PI * 2); g.fill();
  if (hair) { g.beginPath(); g.moveTo(-13, -38); g.quadraticCurveTo(-18, -4, -10, 14); g.lineTo(6, 6); g.quadraticCurveTo(0, -20, 12, -42); g.closePath(); g.fill(); }
  if (hat) {
    g.beginPath(); g.ellipse(2, -42, 28, 6, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(-12, -42); g.quadraticCurveTo(-12, -62, 2, -60); g.quadraticCurveTo(16, -62, 16, -42); g.closePath(); g.fill();
  }
  if (rim) {
    g.strokeStyle = rim; g.lineWidth = 2.2 / s; g.globalAlpha = 0.8;
    g.beginPath(); g.ellipse(2, -30, 14, 17, 0, -0.9, 0.9); g.stroke();
    g.beginPath(); g.moveTo(8, -2); g.quadraticCurveTo(36, 6, 34, 60); g.stroke();
    g.globalAlpha = 1;
  }
  g.restore();
}

function desert(g, o, rnd) {
  const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
  sky.addColorStop(0, "#3b2a4a"); sky.addColorStop(0.55, "#c4624a"); sky.addColorStop(1, "#f2a65a");
  g.fillStyle = sky; g.fillRect(-40, -40, W + 80, H + 80);
  const sun = g.createRadialGradient(W * 0.68, H * 0.56, 2, W * 0.68, H * 0.56, 70);
  sun.addColorStop(0, "#fff3c4"); sun.addColorStop(0.2, "#ffc56b"); sun.addColorStop(1, "rgba(255,160,80,0)");
  g.fillStyle = sun; g.fillRect(0, 0, W, H);
  // Ridge line and flats.
  g.fillStyle = "#4a2c33";
  g.beginPath(); g.moveTo(-40, H * 0.6);
  for (let x = -40; x <= W + 40; x += 24) g.lineTo(x, H * 0.6 - 10 - Math.sin(x * 0.03) * 8 - rnd() * 6);
  g.lineTo(W + 40, H + 40); g.lineTo(-40, H + 40); g.fill();
  const ground = g.createLinearGradient(0, H * 0.62, 0, H);
  ground.addColorStop(0, "#8a5a3c"); ground.addColorStop(1, "#5b3826");
  g.fillStyle = ground; g.fillRect(-40, H * 0.63, W + 80, H);
  const k = setupKindOf(o.setup);
  const ezra = { hat: true, color: "#1b1210", rim: "#ffcf8a" }, mara = { hair: true, color: "#1b1210", rim: "#ffcf8a" };
  if (k === "insert") {
    g.fillStyle = "#7a4c33"; g.fillRect(-40, -40, W + 80, H + 80);
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(40,20,10,${rnd() * 0.25})`; g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 3, 1 + rnd() * 2); }
    key(g, W * 0.5, H * 0.55, 1.6, -0.3);
    return;
  }
  if (k === "master" || k === "wide") {
    const sm = k === "master" ? 0.32 : 0.42;
    horse(g, W * 0.24, H * 0.7, sm, 1); figure(g, W * 0.24, H * 0.7 - 70 * sm, sm * 0.9, { ...ezra, seated: true });
    horse(g, W * 0.78, H * 0.7, sm, -1); figure(g, W * 0.78, H * 0.7 - 70 * sm, sm * 0.9, { ...mara, seated: true, facing: -1 });
    return;
  }
  if (k === "ots") {
    figure(g, W * 0.72, H * 0.55, 1.05, { ...mara, facing: -1 });
    figure(g, W * 0.12, H * 0.72, 2.4, { ...ezra, color: "#0c0807", rim: null });
    return;
  }
  const who = /ezra/i.test(o.subject) ? ezra : mara;
  const s = k === "close" ? 2.1 : 1.35;
  figure(g, W * (who === ezra ? 0.4 : 0.6), H * (k === "close" ? 0.78 : 0.62), s, { ...who, facing: who === ezra ? 1 : -1 });
}

function horse(g, x, y, s, f) {
  g.save(); g.translate(x, y); g.scale(s * f, s); g.fillStyle = "#1d1311";
  g.beginPath(); g.ellipse(0, -60, 52, 22, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(40, -70); g.lineTo(70, -110); g.lineTo(84, -104); g.lineTo(58, -60); g.fill();
  for (const lx of [-40, -26, 26, 40]) g.fillRect(lx, -50, 7, 50);
  g.restore();
}

function key(g, x, y, s, rot) {
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(s, s);
  g.shadowColor = "rgba(0,0,0,.45)"; g.shadowBlur = 8; g.shadowOffsetY = 4;
  const m = g.createLinearGradient(-50, -10, 50, 10);
  m.addColorStop(0, "#8a6418"); m.addColorStop(0.45, "#f3d27a"); m.addColorStop(1, "#a37a22");
  g.fillStyle = m;
  g.beginPath(); g.arc(-40, 0, 16, 0, Math.PI * 2); g.fill();
  g.fillRect(-28, -4, 72, 8);
  g.fillRect(28, 4, 6, 10); g.fillRect(38, 4, 6, 7);
  g.shadowBlur = 0; g.globalCompositeOperation = "destination-out";
  g.beginPath(); g.arc(-40, 0, 6, 0, Math.PI * 2); g.fill();
  g.restore();
}

function diner(g, o, rnd) {
  // Back wall, window with rain and neon, booth, counter.
  const wall = g.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, "#3a2a2a"); wall.addColorStop(1, "#24191b");
  g.fillStyle = wall; g.fillRect(-40, -40, W + 80, H + 80);
  const k = setupKindOf(o.setup);
  const neon = (x, y, s) => {
    g.save(); g.font = `700 ${32 * s}px Georgia, serif`; g.textAlign = "center";
    g.shadowColor = "#ff3b6b"; g.shadowBlur = 18 * s; g.fillStyle = "#ff7a9a"; g.fillText("EA", x - 9 * s, y);
    g.shadowBlur = 0; g.fillStyle = "rgba(120,60,70,.6)"; g.fillText("T", x + 22 * s, y); g.restore();
  };
  const windowAt = (x, y, w, hh) => {
    const night = g.createLinearGradient(0, y, 0, y + hh);
    night.addColorStop(0, "#0f1a2e"); night.addColorStop(1, "#1d2f4a");
    g.fillStyle = night; g.fillRect(x, y, w, hh);
    g.strokeStyle = "rgba(170,200,255,.28)"; g.lineWidth = 1;
    for (let i = 0; i < 40; i++) { const rx = x + rnd() * w, ry = y + rnd() * hh; g.beginPath(); g.moveTo(rx, ry); g.lineTo(rx - 2, ry + 8 + rnd() * 10); g.stroke(); }
    g.strokeStyle = "#160f10"; g.lineWidth = 6; g.strokeRect(x, y, w, hh);
    g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + hh); g.stroke();
  };
  const glow = (x, y, r, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, col); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); };
  const ezra = { hat: true, color: "#140e0e", rim: "#ff8fa8" }, mara = { hair: true, color: "#140e0e", rim: "#ffc98a" };
  if (k === "insert") {
    if (/neon/i.test(o.subject)) {
      windowAt(-10, -10, W + 20, H + 20); neon(W / 2, H * 0.6, 3.1); glow(W / 2, H * 0.5, 180, "rgba(255,60,110,.18)");
    } else {
      const top = g.createLinearGradient(0, 0, W, H); top.addColorStop(0, "#c9c2b0"); top.addColorStop(1, "#9c9483");
      g.fillStyle = top; g.fillRect(-40, -40, W + 80, H + 80);
      for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(90,80,70,${0.08 + rnd() * 0.1})`; g.beginPath(); g.arc(rnd() * W, rnd() * H, 1 + rnd() * 3, 0, 7); g.fill(); }
      g.fillStyle = "#e8e1d4"; g.beginPath(); g.ellipse(W * 0.2, H * 0.3, 52, 46, 0, 0, 7); g.fill();
      g.fillStyle = "#3a2216"; g.beginPath(); g.ellipse(W * 0.2, H * 0.3, 36, 31, 0, 0, 7); g.fill();
      glow(W * 0.6, H * 0.3, 140, "rgba(255,90,130,.18)");
      key(g, W * 0.6, H * 0.62, 1.5, 0.25);
    }
    return;
  }
  if (k === "master" || k === "wide") {
    windowAt(W * 0.1, H * 0.12, W * 0.5, H * 0.38); neon(W * 0.35, H * 0.38, 0.9); glow(W * 0.35, H * 0.3, 120, "rgba(255,60,110,.2)");
    // Counter, grill light, cook.
    g.fillStyle = "#4c3326"; g.fillRect(W * 0.66, H * 0.55, W * 0.4, H * 0.5);
    glow(W * 0.85, H * 0.35, 90, "rgba(255,190,110,.28)");
    figure(g, W * 0.86, H * 0.5, 0.55, { color: "#1c1312", facing: -1 });
    // Booth.
    g.fillStyle = "#7a1f25"; g.fillRect(W * 0.12, H * 0.55, W * 0.46, H * 0.32);
    g.fillStyle = "#a99f8a"; g.fillRect(W * 0.2, H * 0.62, W * 0.3, 8);
    figure(g, W * 0.24, H * 0.62, 0.5, { ...mara, seated: true });
    if (k === "master") figure(g, W * 0.46, H * 0.62, 0.5, { ...ezra, seated: true, facing: -1 });
    else { g.fillStyle = "#1a2234"; g.fillRect(W * 0.02, H * 0.18, W * 0.07, H * 0.62); figure(g, W * 0.07, H * 0.55, 0.62, { ...ezra, facing: 1 }); }
    g.fillStyle = "#2b1d1a"; g.fillRect(-40, H * 0.87, W + 80, H);
    return;
  }
  windowAt(W * 0.05, H * 0.04, W * 0.9, H * 0.5); neon(W * 0.5, H * 0.32, 1.3); glow(W * 0.5, H * 0.25, 170, "rgba(255,60,110,.22)");
  g.fillStyle = "#7a1f25"; g.fillRect(-40, H * 0.54, W + 80, H * 0.2);
  g.fillStyle = "#b5ab95"; g.fillRect(-40, H * 0.74, W + 80, H * 0.3);
  if (k === "two") {
    figure(g, W * 0.24, H * 0.7, 0.95, { ...mara, seated: true });
    figure(g, W * 0.76, H * 0.7, 0.95, { ...ezra, seated: true, facing: -1 });
    return;
  }
  const onEzra = /ezra/i.test(o.subject) || /_b$/.test(o.setup || "") && !/mara/i.test(o.subject);
  const who = onEzra ? ezra : mara, other = onEzra ? mara : ezra;
  if (k === "ots") {
    figure(g, W * (onEzra ? 0.3 : 0.68), H * 0.68, 1.15, { ...who, seated: true, facing: onEzra ? 1 : -1 });
    figure(g, W * (onEzra ? 0.92 : 0.08), H * 0.9, 2.6, { ...other, color: "#0b0707", rim: null, seated: true, facing: onEzra ? -1 : 1 });
    return;
  }
  const s = k === "close" ? 2.3 : 1.5;
  figure(g, W * (onEzra ? 0.42 : 0.58), H * (k === "close" ? 0.84 : 0.72), s, { ...who, seated: true, facing: onEzra ? 1 : -1 });
}

function setupKindOf(setup) {
  const s = String(setup || "");
  if (/^master/.test(s)) return "master";
  if (/^wide/.test(s)) return "wide";
  if (/^two/.test(s)) return "two";
  if (/^ots/.test(s)) return "ots";
  if (/^close/.test(s)) return "close";
  if (/^insert/.test(s)) return "insert";
  return "single";
}

function hash(str) { let x = 2166136261; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------------------------------------ approvals

// Demo review statuses (invented): [sceneId, setup index, status, note]. Applied to each setup's current take.
const DEMO_REVIEWS = [
  ["sc_4", 0, "approved"], ["sc_4", 1, "changes", "Hold the door a beat longer before he comes in"], ["sc_4", 2, "approved"],
  ["sc_4", 3, "approved"], ["sc_4", 5, "changes", "Warmer neon on her face, less blue"], ["sc_4", 6, "rejected"],
  ["sc_4", 8, "approved"], ["sc_1", 0, "approved"], ["sc_1", 1, "changes", "Dust kicks up too early"],
];

/** A demo approvals store ({shotId: {takeKey: {s, note}}}) for the preview: a mix of approved, to-fix and rejected. */
export async function demoApprovals(shots, renders) {
  const { takesFor, currentTake, withTakeStatus } = await import("./model.mjs");
  let store = {};
  for (const [sceneId, idx, s, note] of DEMO_REVIEWS) {
    const shot = shots.filter((x) => x.scene_id === sceneId)[idx];
    const take = shot && currentTake(takesFor(shot, renders[shot.id] || []));
    if (take) store = withTakeStatus(store, shot.id, take, s, note || "", { kind: take.kind, t: 1 });
  }
  return store;
}
