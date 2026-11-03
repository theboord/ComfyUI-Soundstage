// Soundstage QA: builds the playback bench's cut (a project in web/cut/demo_project.json's format) from a media list.
//
//   node tools/qa/playback_fixture.mjs --media <media.json> --out <project.json> [--seconds 60] [--seed 8]
//        [--min 2] [--max 5] [--clay 2] [--bed /bench-media/bed.wav] [--name "Playback bench"] [--width 2624 --height 1408]
//
// media.json: [{ "filename": "final_00071_.mp4", "subfolder": "soundstage", "type": "output", "frames": 113,
//                "rung": "final" | "draft", "url"?: "<explicit url>" }, ...]
// Each media file becomes one shot (its render on that rung); --clay adds shots with no render, which the Cut plays as
// clay. The cut cuts on whole frames at 24 fps, every --min..--max seconds, reuses shots with different in-points
// (cutting back to a setup, as an edit does), includes one jump cut (a shot followed by itself) and at least one clay
// shot. The same seed and media list always give the same cut.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The URL the app gives a render (web/soundstage.js viewURL: api.apiURL("/view?...")). */
export function viewUrl(m) {
  if (m.url) return m.url;
  return "/api/view?" + new URLSearchParams({ filename: m.filename, subfolder: m.subfolder || "", type: m.type || "output" });
}

const SETUPS = ["master", "OTS A", "OTS B", "single B", "insert"];   // the clay stand-in in demo.html frames these

/**
 * Build the project. media: the list above. Returns {project, notes}.
 * opts: seconds (60), fps (24), seed (8), min/max seconds per event (2..5), clay (number of clay-only shots, >= 1),
 * bed (an audio URL laid under the whole cut on A1, or null), width/height (the project frame; default the widest media).
 */
export function buildFixture(media, { seconds = 60, fps = 24, seed = 8, min = 2, max = 5, clay = 2, bed = null, name = "Playback bench", width, height } = {}) {
  if (!Array.isArray(media) || !media.length) throw new Error("media list is empty");
  const rand = rng(seed);
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const shots = media.map((m, i) => ({
    id: `take${i + 1}`, name: `T${i + 1}_${String(m.filename || m.url).replace(/\.[^.]+$/, "").slice(0, 28)}`,
    frames: m.frames, scene_name: "SC1 Diner - INT NIGHT", setup: SETUPS[i % SETUPS.length], scene_offset: 0,
    renders: { [m.rung || "final"]: viewUrl(m) },
  }));
  for (let k = 0; k < Math.max(1, clay); k++) {
    shots.push({ id: `clay${k + 1}`, name: `C${k + 1}_NO_RENDER`, frames: 240, scene_name: "SC1 Diner - INT NIGHT",
      setup: SETUPS[(media.length + k) % SETUPS.length], scene_offset: 24 * k, renders: {} });
  }
  const total = Math.round(seconds * fps);
  const lo = Math.round(min * fps), hi = Math.round(max * fps);
  // Shot order: every take twice or more, the clay shots spread through the cut, never the same shot twice in a row
  // except the one planned jump cut.
  const takeIds = shots.filter((s) => s.id.startsWith("take")).map((s) => s.id);
  const clayIds = shots.filter((s) => s.id.startsWith("clay")).map((s) => s.id);
  const cut = [];
  let rec = 0, prev = null, jumpDone = false, n = 0, nClay = 0;
  const bag = [];
  while (rec < total) {
    let len = Math.min(ri(lo, hi), total - rec);
    if (total - rec - len > 0 && total - rec - len < lo) len = total - rec;   // never leave a sliver at the tail
    let id;
    if (!jumpDone && n === 5 && prev && prev.startsWith("take")) { id = prev; jumpDone = true; }     // the jump cut
    else if (clayIds.length && n % Math.max(3, Math.floor(16 / clayIds.length)) === 2) id = clayIds[nClay++ % clayIds.length];
    else {
      if (!bag.length) bag.push(...takeIds.map((x) => [rand(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]));
      id = bag.shift();
      if (id === prev && bag.length) { bag.push(id); id = bag.shift(); }
    }
    const shot = shots.find((s) => s.id === id);
    len = Math.min(len, shot.frames);
    const last = cut.length && cut[cut.length - 1];
    let inF = ri(0, shot.frames - len);
    if (id === prev && last) inF = Math.min(shot.frames - len, last.out + ri(6, 24));   // jump forward in the same take
    cut.push({ shot_id: id, in: inF, out: inF + len });
    rec += len; prev = id; n++;
  }
  // Clay must appear even in a very short cut.
  if (clayIds.length && !cut.some((e) => e.shot_id.startsWith("clay"))) {
    const e = cut[Math.min(2, cut.length - 1)];
    const len = e.out - e.in;
    Object.assign(e, { shot_id: clayIds[0], in: 0, out: len });
  }
  const widest = media.reduce((a, m) => ((m.width || 0) > (a.width || 0) ? m : a), media[0]);
  const project = {
    name, fps, width: width || widest.width || 1920, height: height || widest.height || 1080, shots, cut,
    audio: bed ? [{ id: "bed", track: 1, url: bed, start_frame: 0, in: 0, out: total, gain_db: -12, label: "Bench bed (local file)" }] : [],
  };
  const edits = [];
  for (let i = 0, r = 0; i < cut.length; i++) { edits.push(r); r += cut[i].out - cut[i].in; }
  return { project, notes: { totalFrames: total, events: cut.length, editPoints: edits.slice(1), clayEvents: cut.filter((e) => e.shot_id.startsWith("clay")).length,
    jumpCut: cut.findIndex((e, i) => i > 0 && cut[i - 1].shot_id === e.shot_id) } };
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const mediaPath = arg("--media"), out = arg("--out");
  if (!mediaPath || !out) { console.error("usage: node tools/qa/playback_fixture.mjs --media <media.json> --out <project.json> [--seconds 60] [--seed 8] [--clay 2] [--bed <url>]"); process.exit(2); }
  const { project, notes } = buildFixture(JSON.parse(readFileSync(mediaPath, "utf8")), {
    seconds: Number(arg("--seconds", 60)), seed: Number(arg("--seed", 8)), min: Number(arg("--min", 2)), max: Number(arg("--max", 5)),
    clay: Number(arg("--clay", 2)), bed: arg("--bed"), name: arg("--name", "Playback bench"),
    width: arg("--width") ? Number(arg("--width")) : undefined, height: arg("--height") ? Number(arg("--height")) : undefined,
  });
  writeFileSync(out, JSON.stringify(project, null, 2));
  console.log(JSON.stringify(notes));
}
