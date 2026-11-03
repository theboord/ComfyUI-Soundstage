#!/usr/bin/env node
// README media v3: re-captures every UI still and UI GIF that README.md and docs/TUTORIAL.md show, from THIS branch's
// web/ code, in a hidden Chrome, over a running Soundstage ComfyUI (the pod through its tunnel at http://127.0.0.1:8189).
//
//   CHROME=<chrome> node tools/qa/readme_media_v3.mjs                       every entry -> docs/media/<same file name>
//   node tools/qa/readme_media_v3.mjs --only cast,step2_frame --out <dir>   some entries, somewhere else
//   node tools/qa/readme_media_v3.mjs --list                                the entries and what each shows
//   options: --port 9840 (DevTools port)  --angle d3d11 (GPU: d3d11 on Windows, metal on a Mac; swiftshader = CPU)
//
// How it stays honest and safe:
//   - Every file under /extensions/ComfyUI-Soundstage/ is served from this repo's web/ (lib.mjs serveWeb), so the
//     pictures show the App as it is on this branch even when the server runs older code.
//   - lib.mjs's guard answers every write locally: nothing is queued, uploaded or saved on the server.
//   - Takes, frames and videos are real renders already on the server (GET /view): a scene from tools/tryit/scenes/ is
//     opened like a saved workflow (the stage value plus the stage node's properties ss_renders, ss_chosen, ss_cut,
//     ss_script), the way a user reopens their own work. Cast pictures are the ones the App generated
//     (output/soundstage/cast/). Nothing is drawn over the App: GIF captions sit in a strip above it, and the two
//     composites (new_sets, camera_rigs) are the stage's own renders laid out in a grid with a label strip per tile.
//   - Where the App needs a server write to show something, the answer comes from this branch's own code instead of
//     the shared server: the Director's plan from soundstage/agent/director.py (its rules planner, run locally), and
//     the phone viewfinder's scene through its socket (what the desk would publish), from tools/tryit/scenes/chase.json.
//     timeline.jpg is the Cut harness page (web/cut/demo.html, the real CutPanel on its demo cut).
//   - Stills are JPEG q85 from Chrome; GIFs are built with ffmpeg (one palette per GIF), each with an H.264 MP4 twin.
//
// Needs: Google Chrome, ffmpeg on PATH (GIFs), Python 3 (director.jpg), the Soundstage ComfyUI at SS_URL
// (default http://127.0.0.1:8189). DevTools port: --port (default 9840); the Director's planner listens on 9858.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { launch, openApp, toAppMode, openFull, INSTALL, STILL_CSS, sleep, REPO, BASE } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = opt("out", join(REPO, "docs", "media"));
const ONLY = opt("only", "") ? new Set(opt("only").split(",").map((s) => s.replace(/\.(jpg|gif)$/, ""))) : null;
const PORT = +opt("port", "9840");
const ANGLE = opt("angle", process.env.SS_ANGLE || (process.platform === "darwin" ? "metal" : process.platform === "win32" ? "d3d11" : "swiftshader"));
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const SCENES = join(REPO, "tools", "tryit", "scenes");
const WORK = join(tmpdir(), `ss_readme_media_${process.pid}`);

// ------------------------------------------------------------------------------------------------ opening a scene

/** A demo scene (tools/tryit/scenes/<key>.json) as the shipped App workflow with that stage and those node properties. */
function sceneWorkflow(key) {
  const wf = JSON.parse(readFileSync(join(REPO, "example_workflows", "Soundstage_App.json"), "utf8"));
  if (!key) return wf;
  const d = JSON.parse(readFileSync(join(SCENES, `${key}.json`), "utf8"));
  const props = structuredClone(d.props || {});
  // The try-it page keeps its media under r/: in ComfyUI a chosen frame is read from the server by its file.
  for (const c of Object.values(props.ss_chosen?.chosen || {})) {
    if (c?.file?.filename && !/^\/|^https?:/.test(c.url || "")) c.url = viewPath(c.file);
  }
  const node = wf.nodes.find((n) => n.type === "SoundstageStage");
  node.widgets_values = [typeof d.scene === "string" ? d.scene : JSON.stringify(d.scene)];
  node.properties = { ...(node.properties || {}), ...props };
  return wf;
}
const viewPath = (f) => `/api/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" })}`;

/** Load ComfyUI, open `scene` (a tryit scene key, "demo" for the App's own demo scene, or null for a new stage),
 *  switch to App mode and open the full workspace. Returns js(code) that runs in the page with __qa set. */
export async function openScene(b, scene, { full = true, still = true } = {}) {
  await openApp(b, `${BASE}/?readme=${Date.now()}`);
  const wf = sceneWorkflow(scene && scene !== "demo" ? scene : null);
  const ok = await b.ev(`const app = window.comfyAPI.app.app; const wf = ${JSON.stringify(wf)};
    for (let t = 0; t < 4; t++) { try { await app.loadGraphData(wf); return 1; } catch (e) { await new Promise(r => setTimeout(r, 2000)); } }
    return 0;`);
  if (!ok) throw new Error("the workflow did not load");
  await sleep(2500);
  let app = await toAppMode(b);
  if (!app) { await sleep(3000); app = await toAppMode(b); }
  if (!app) throw new Error("ComfyUI did not switch to App mode");
  await sleep(1500);
  await b.key("Escape");
  if (!(await b.ev(INSTALL))) throw new Error("no Soundstage stage node");
  if (still) await b.ev(`if (!document.getElementById('qa-still')) { const s=document.createElement('style'); s.id='qa-still'; s.textContent=${JSON.stringify(STILL_CSS)}; document.head.append(s); } return 1`);
  const js = (code) => b.ev(`const __qa=window.__qa; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); ${code}`);
  // Stop shows while the server's queue has anyone's work: keep it out of the pictures.
  await js("if (__qa.p) { __qa.p._refreshStop = async () => {}; __qa.p.stopBtn.hidden = true; } if (!document.getElementById('qa-nostop')) document.head.append(Object.assign(document.createElement('style'), { id: 'qa-nostop', textContent: '.ss-stage .ss-stop { display:none !important; }' })); return 1");
  if (full) { await openFull(b); await sleep(1200); }
  // A brand-new stage greets you with the "Let's make a shot" card: start from the blank stage, like a user would.
  if (!scene && full) await js("const x=[...__qa.el.querySelectorAll('button')].find(e=>e.getClientRects().length&&/^Start from a blank stage$/.test(e.textContent.trim())); x?.click(); return !!x");
  if (scene === "demo") { await js("await __qa.node.ssDemo.load(); return 1"); await sleep(6000); }
  else if (scene) await sleep(3000);
  return js;
}

/** Wait until every <img> / <video> on screen has loaded (no half-loaded thumbnails in a picture). */
export async function settleMedia(b, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const left = await b.ev(`const vis=(e)=>{ const r=e.getBoundingClientRect(); return r.width>8&&r.height>8&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&getComputedStyle(e).visibility!=='hidden'; };
      const imgs=[...document.querySelectorAll('img')].filter(vis).filter(i=>i.src&&!(i.complete&&i.naturalWidth>0));
      const vids=[...document.querySelectorAll('video')].filter(vis).filter(v=>v.src&&v.readyState<2);
      return imgs.length+vids.length;`);
    if (!left) return true;
    await sleep(400);
  }
  return false;
}

// ------------------------------------------------------------------------------------------------ captures

/** The full workspace's own box (without the strip of ComfyUI that shows around it), or the window. */
async function panelBox(b) {
  const r = await b.rect(".ss-stage.ss-full");
  if (!r) return { x: 0, y: 0, width: b.W, height: b.H };
  const x = Math.ceil(r.x), y = Math.ceil(r.y);
  return { x, y, width: Math.floor(r.x + r.w) - x, height: Math.floor(r.y + r.h) - y };
}

/** A still as JPEG q85: the full workspace's box (default), the window (panel: false) or clip {x,y,width,height},
 *  scaled to `width` when given. */
export async function still(b, name, { clip = null, width = null, quality = 85, panel = true } = {}) {
  const c = clip || (panel ? await panelBox(b) : { x: 0, y: 0, width: b.W, height: b.H });
  const scale = width ? width / c.width : 1;
  const r = await b.send("Page.captureScreenshot", { format: "jpeg", quality, clip: { ...c, scale }, captureBeyondViewport: false });
  if (!r.result?.data) throw new Error(`screenshot failed: ${JSON.stringify(r.error || r).slice(0, 200)}`);
  const f = join(OUT, name);
  writeFileSync(f, Buffer.from(r.result.data, "base64"));
  return f;
}

/** A bold font for the GIF caption strips (CAPTION_FONT overrides). */
const CAPTION_FONT = process.env.CAPTION_FONT || { win32: "C:/Windows/Fonts/segoeuib.ttf", darwin: "/System/Library/Fonts/Supplemental/Arial Bold.ttf" }[process.platform]
  || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const ffPath = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1\\:");

/** Frames for a GIF: screenshots of the page (grab / roll, each keeps the time it was taken, so the GIF plays at the
 *  real pace) or pictures made in the page (add). A caption puts one line in a strip above the App, never over it. */
class Recorder {
  constructor(b, name, { clip = null, width = null } = {}) {
    this.b = b; this.name = name; this.clip = clip; this.width = width; this.frames = [];
    this.dir = join(WORK, name.replace(/\W/g, "_")); rmSync(this.dir, { recursive: true, force: true }); mkdirSync(this.dir, { recursive: true });
  }
  _file() { return join(this.dir, `f${String(this.frames.length).padStart(5, "0")}.png`); }
  async grab(hold = null, caption = null) {
    const c = this.clip || { x: 0, y: 0, width: this.b.W, height: this.b.H };
    const scale = this.width ? this.width / c.width : 1;
    const r = await this.b.send("Page.captureScreenshot", { format: "png", clip: { ...c, scale } });
    const f = this._file();
    writeFileSync(f, Buffer.from(r.result.data, "base64"));
    this.frames.push({ f, t: Date.now(), hold, caption });
  }
  /** A picture made in the page (a data: URL), shown for `hold` seconds. */
  add(dataUrl, hold, caption = null) {
    const f = this._file();
    writeFileSync(f, Buffer.from(String(dataUrl).split(",")[1], "base64"));
    this.frames.push({ f, t: Date.now(), hold, caption });
  }
  /** Grab frames for `ms` while something happens on its own (a drag in flight, playback). */
  async roll(ms, every = 80, caption = null) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = Date.now(); await this.grab(null, caption); await sleep(Math.max(0, every - (Date.now() - t))); } }
  /** Hold the last frame a while longer (the GIF rests on it). */
  rest(s) { if (this.frames.length) this.frames[this.frames.length - 1].hold = s; }
  /** Write <name>.gif (one palette for the GIF, fps) and <name>.mp4 (H.264, yuv420p, CRF 20, no audio). */
  build({ fps = 12, maxColors = 192, width = null, captionH = 44, fontSize = 21 } = {}) {
    if (this.frames.length < 2) throw new Error(`${this.name}: only ${this.frames.length} frame(s)`);
    // Each frame lasts until the next one was taken (or its hold); the concat list keeps the real pacing.
    const lines = [], segs = [];
    let t = 0;
    this.frames.forEach((fr, i) => {
      const next = this.frames[i + 1];
      const dur = fr.hold != null ? fr.hold : next ? Math.max(0.03, (next.t - fr.t) / 1000) : 1.2;
      lines.push(`file '${fr.f.replace(/\\/g, "/")}'`, `duration ${dur.toFixed(3)}`);
      const last = segs[segs.length - 1];
      if (last && last.caption === fr.caption) last.b = t + dur; else segs.push({ caption: fr.caption, a: t, b: t + dur });
      t += dur;
    });
    lines.push(`file '${this.frames[this.frames.length - 1].f.replace(/\\/g, "/")}'`);
    const list = join(this.dir, "list.txt");
    writeFileSync(list, lines.join("\n"));
    const pre = [];
    if (segs.some((s) => s.caption)) {
      pre.push(`pad=iw:ih+${captionH}:0:${captionH}:color=0x17141c`);
      segs.forEach((s, i) => {
        if (!s.caption) return;
        const tf = join(this.dir, `cap${i}.txt`);
        writeFileSync(tf, s.caption);
        pre.push(`drawtext=fontfile='${ffPath(CAPTION_FONT)}':textfile='${ffPath(tf)}':fontcolor=0xF2FF59:fontsize=${fontSize}:x=16:y=(${captionH}-th)/2:enable='between(t,${s.a.toFixed(3)},${(s.b - 0.001).toFixed(3)})'`);
      });
    }
    const gif = join(OUT, `${this.name}.gif`), mp4 = join(OUT, `${this.name}.mp4`);
    const vf = [...pre, `fps=${fps}`, width ? `scale=${width}:-2:flags=lanczos` : "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos"].join(",");
    run(FFMPEG, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf",
      `${vf},split[a][b];[a]palettegen=max_colors=${maxColors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", gif]);
    run(FFMPEG, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `${vf},format=yuv420p`, "-c:v", "libx264",
      "-crf", "20", "-preset", "slow", "-movflags", "+faststart", "-an", mp4]);
    return { gif, mp4, bytes: statSync(gif).size, frames: this.frames.length, seconds: +t.toFixed(2) };
  }
}
function run(cmd, a) { const r = spawnSync(cmd, a, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.error || "").toString().slice(0, 400)}`); return r.stdout; }

// ------------------------------------------------------------------------------------------------ page helpers

const step = (js, k, ms = 2500) => js(`__qa.p.go('${k}'); return 1`).then(() => sleep(ms));
const tab = (js, k, ms = 1500) => js(`const b=__qa.el.querySelector('button[data-tab="${k}"]'); b?.click(); return !!b`).then(async (ok) => { await sleep(ms); return ok; });
const clickBtn = (js, re, scope = "__qa.el") => js(`const b=[...${scope}.querySelectorAll('button')].find(x=>x.getClientRects().length&&${re}.test((x.textContent||'').trim())); b?.click(); return !!b`);
/** The 3D view's box on screen (the stage canvas and its own overlays). */
const viewBox = async (b) => { const r = await b.rect(".ss-stage .ss-stageview"); return r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }; };
/** One stage frame through the active shot's camera, rendered by the stage itself (no UI): a PNG data URL. */
const stageFrame = (js, mode, frame) => js(`return __qa.stage.renderFrameTo(${JSON.stringify(mode)}, ${frame}).toDataURL('image/png')`);
/** Tiles ({src: data URL, label}) in a grid, each with a label strip above, drawn in the page: a data URL. */
const grid = (js, tiles, { cols = 2, w = 600, h = 338, label = 34, font = 17, type = "image/jpeg", q = 0.88 } = {}) => js(`
  const tiles = ${JSON.stringify(tiles)}, cols = ${cols}, w = ${w}, h = ${h}, L = ${label};
  const cv = document.createElement('canvas'); cv.width = cols * w; cv.height = Math.ceil(tiles.length / cols) * (h + L);
  const g = cv.getContext('2d'); g.fillStyle = '#17141c'; g.fillRect(0, 0, cv.width, cv.height);
  const load = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
  for (let k = 0; k < tiles.length; k++) {
    const t = tiles[k], x = (k % cols) * w, y = Math.floor(k / cols) * (h + L);
    if (t.src) { const im = await load(t.src); const s = Math.max(w / im.width, h / im.height), dw = im.width * s, dh = im.height * s;
      g.save(); g.beginPath(); g.rect(x, y + L, w, h); g.clip(); g.drawImage(im, x + (w - dw) / 2, y + L + (h - dh) / 2, dw, dh); g.restore(); }
    if (t.label) { g.fillStyle = '#F2FF59'; g.font = '700 ${font}px "Segoe UI", system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText(t.label, x + 12, y + L / 2 + 1); }
    g.fillStyle = '#17141c'; g.fillRect(x + w - 2, y, 4, h + L); g.fillRect(x, y + h + L - 2, w, 4);
  }
  return cv.toDataURL(${JSON.stringify(type)}, ${q});`);
/** Write a data URL as a file in the output folder. */
const writeData = (name, dataUrl) => { const f = join(OUT, name); writeFileSync(f, Buffer.from(String(dataUrl).split(",")[1], "base64")); return f; };
/** Screen position of a 3D point (world coordinates) in the stage's viewport. */
const screenOf = (js, p) => js(`const st=__qa.stage; const cam=st._viewportCamera(); const V=cam.position.constructor; const v=new V(...${JSON.stringify(p)}).project(cam);
  const r=st.canvas.getBoundingClientRect(); return { x: r.x + (v.x + 1) / 2 * r.width, y: r.y + (1 - v.y) / 2 * r.height };`);

// ------------------------------------------------------------------------------------------------ the entries
// Each entry: file, what (what the picture shows), scene (tryit scene key, "demo", or null), size [w, h], run(ctx).

// The pictures ② Cast generated for the sample script (output/soundstage/cast/ on the server), by file-name slug.
// Garments and props whose generated picture missed (a "duster" that came back as an SUV) are left empty on purpose.
const CAST_PICS = { ezra: "ezra_00004_.png", mara: "mara_00003_.png", deputy_cole: "deputy_cole_00002_.png",
  ext_desert_outside_dry_creek: "ext_desert_outside_dry_creek_00001_.png", ext_dry_creek_main_street: "ext_dry_creek_main_street_00001_.png",
  int_sports_car_moving: "int_sports_car_moving_00001_.png", ext_pacific_beach: "ext_pacific_beach_00001_.png",
  holster: "holster_00001_.png", boots: "boots_00001_.png", brass_key: "brass_key_00001_.png", horses: "horses_00001_.png",
  hawk: "hawk_00001_.png", police_radio: "police_radio_00001_.png", sports_car: "sports_car_00003_.png", police_car: "police_car_00002_.png",
  car_radio: "car_radio_00001_.png" };
/** The Director's rules planner from THIS repo (soundstage/agent/director.py, pure Python), on a local port. The App asks
 *  the server for a plan with a POST, which the guard keeps off the shared server: the page's plan request goes here
 *  instead, so the plan on screen is the one this branch's server code makes. Returns { port, stop }. */
async function localPlanner(port = 9858) {
  const py = `import sys, json
sys.path.insert(0, ${JSON.stringify(REPO)})
from soundstage.agent import director as D
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Headers', 'Content-Type'); self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        res = D.plan(str(b.get('command', '')), b.get('scene') or {}, b.get('ctx') or {}, b.get('llm_text'))
        out = json.dumps(res).encode()
        self.send_response(200); self._cors(); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', ${port}), H).serve_forever()
`;
  const proc = spawn(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), ["-I", "-c", py], { stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/`, { method: "OPTIONS" }); break; } catch { await sleep(250); } }
  return { port, stop: () => { try { proc.kill(); } catch { /* gone */ } } };
}

/** A real mouse drag from a to z in `steps` moves, a frame grabbed after each, so the GIF sees the drag happen. */
async function dragRec(b, r, [x0, y0], [x1, y1], { steps = 14, caption = null, pause = 40 } = {}) {
  await b.move(x0, y0, 6);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
  await sleep(60); await r.grab(null, caption);
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(pause); await r.grab(null, caption);
  }
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
  await b.move(x1 + 0.5, y1 + 0.5, 1);
}
/** A box {x,y,width,height} for an element (CSS selector), rounded to whole pixels. */
const elBox = async (b, sel) => { const r = await b.rect(sel); return r && { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }; };
/** Screen position of a pose dot (joint id or IK handle id) of the person in pose mode. */
const dotXY = (js, id) => js(`const st=__qa.stage, m=st.poser.dots.get(${JSON.stringify(id)}); if(!m) return null; const cam=st._viewportCamera();
  const v=m.getWorldPosition(new cam.position.constructor()).project(cam); const r=st.canvas.getBoundingClientRect();
  return { x: r.x + (v.x + 1) / 2 * r.width, y: r.y + (1 - v.y) / 2 * r.height };`);

/** A person on a new stage, framed head to toe from the front (a little to one side) through the shot camera, selected,
 *  in pose mode (Pose in 3D). The camera is keyed like any shot camera; FLIP=-1 puts it behind them. */
async function poseSetup(js, { dist = 4.7, side = 1.0, flip = 1 } = {}) {
  return js(`const st=__qa.stage; const j=st.toJSON(); const a=j.actors.find(x=>/man|woman/.test(x.kind)) || j.actors[0];
    const g=st.actorMeshes.get(a.id); const V=g.position.constructor; const p=g.getWorldPosition(new V()); const f=g.getWorldDirection(new V()).setY(0).normalize().multiplyScalar(${flip});
    const r=new V(f.z, 0, -f.x);
    const cam=[p.x+f.x*${dist}+r.x*${side}, 1.3, p.z+f.z*${dist}+r.z*${side}];
    st.setCameraKeys([{ frame:0, position:cam, target:[p.x, 0.9, p.z], focal_mm:35 }]);
    st.setFrame(0); st.select(a.id); await sleep(400); st.setPoseMode(true); st.render(); return a.id`);
}
const DIRECTOR_NOTE = "Keep the deputy in silhouette. Neon on wet asphalt; push in slowly on Mara.";

export const ENTRIES = [
  { file: "script_tab.jpg", size: [1624, 1024], scene: "demo", what: "① Script: the sample script, scene 2 with outline, director's notes, breakdown and the page",
    run: async ({ js, still }) => {
      await step(js, "script");
      await js(`const ta=[...__qa.el.querySelectorAll('textarea')].find(t=>t.getClientRects().length&&/notes/i.test(t.placeholder||''));
        if (ta) { ta.value=${JSON.stringify(DIRECTOR_NOTE)}; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.dispatchEvent(new Event('change',{bubbles:true})); ta.blur(); } return !!ta`);
      await sleep(800);
      return still("script_tab.jpg");
    } },
  { file: "cast.jpg", size: [1784, 1024], scene: "demo", what: "② Cast & Locations with the pictures the App generated (characters, locations, wardrobe, props)",
    run: async ({ js, still, settle }) => {
      await js(`const { castList } = await import('/extensions/ComfyUI-Soundstage/cast/cast.mjs');
        const pics = ${JSON.stringify(CAST_PICS)}; const items = {};
        const slug = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/ /g,'_');
        for (const it of castList(__qa.node.ssScript.script, __qa.stage.toJSON())) { const f = pics[slug(it.name)];
          if (f) items[it.key] = { ref: 'soundstage/cast/' + f + ' [output]', url: '/api/view?' + new URLSearchParams({ filename: f, subfolder: 'soundstage/cast', type: 'output' }) }; }
        __qa.node.properties.ss_cast = { items, extra: [] }; return Object.keys(items).length`);
      await step(js, "cast", 3000);
      await settle();
      // Fit (the default) lays the cards out for the room once the pictures are in. At 1600 x 1000 it wraps the ninth prop
      // card below the bottom edge (the cards come out wider than its sum allows), so this window is a little wider.
      await js("const f=[...__qa.el.querySelectorAll('button')].find(x=>x.getClientRects().length&&x.textContent.trim()==='Fit'); f?.click(); window.dispatchEvent(new Event('resize')); return !!f");
      await sleep(1200); await settle();
      return still("cast.jpg");
    } },
  { file: "tool_dock.jpg", size: [1624, 1024], scene: "demo", what: "The workspace on ③ Set: step bar, top row, tool dock, the 3D view and the inspector",
    run: async ({ b, js, still }) => { await step(js, "set", 2000); await b.move(2, 2); return still("tool_dock.jpg"); } },
  { file: "step1_set.jpg", size: [1624, 1055], scene: "chase", what: "③ Set: the night chase in Color, Wide crane shot, the sports car selected (tool rail, viewport, Properties, transport)",
    run: async ({ b, js, still }) => {
      await js("__qa.p.selectShot('crane'); return 1"); await sleep(800);
      await step(js, "set", 2000);
      await clickBtn(js, /^Color$/); await sleep(600);
      await js("__qa.stage.setFrame(30); __qa.stage.select('sports_car'); return 1");
      await sleep(1500); await b.move(2, 2);
      return still("step1_set.jpg");
    } },
  { file: "step2_frame.jpg", size: [1624, 1055], scene: "chase", what: "④ Frame: the chosen first frame, the shot row, Follow the clay with Lock to the stage depth, the Style picker open",
    run: async ({ b, js, still, settle }) => {
      await js("__qa.p.selectShot('tracking'); return 1"); await sleep(600);
      await step(js, "frame", 3000); await settle();
      await js(`const r=[...__qa.el.querySelectorAll('button, [role=button]')].find(x=>x.getClientRects().length&&/^Style/.test((x.textContent||'').trim())); r?.click(); return !!r`);
      await sleep(1500); await settle(); await b.move(2, 2);
      return still("step2_frame.jpg");
    } },
  { file: "step3_motion.jpg", size: [1624, 1055], scene: "chase", what: "⑤ Motion: the chosen frame and its rendered final, video model, adherence, Draft · Final · Hollywood, sound and dialogue",
    run: async ({ b, js, still, settle }) => {
      await js("__qa.p.selectShot('tracking'); return 1"); await sleep(600);
      await step(js, "motion", 3500); await settle();
      await js("const v=[...__qa.el.querySelectorAll('video')].find(x=>x.getClientRects().length); if (v) { v.pause(); v.currentTime = Math.min(2.2, (v.duration || 4) * 0.5); } return !!v"); await sleep(1200);
      await b.move(2, 2);
      return still("step3_motion.jpg");
    } },
  { file: "step4_ladder.jpg", size: [1624, 1055], scene: "chase", what: "⑥ Review: the Ladder's 3-way compare, Color | Draft | Final, on the tracking shot mid-move",
    run: async ({ b, js, still, settle }) => {
      await js("__qa.p.selectShot('tracking'); __qa.stage.setFrame(40); return 1"); await sleep(600);
      await step(js, "review", 3500);
      await clickBtn(js, /^Color$/); await sleep(1500);   // LEFT: the Color pass (the README: Clay or Color | Draft | Final)
      await settle(); await b.move(2, 2); return still("step4_ladder.jpg");
    } },
  { file: "paint_studio.jpg", size: [1624, 1024], scene: "chase", what: "Paint Studio on the chosen frame: tool rail, layers, history, a brush mask and the Generative Fill bar (Fill, Remove, Extend, Whole frame)",
    run: async ({ b, js, still, settle }) => {
      await js("__qa.p.selectShot('crane'); return 1"); await sleep(800);
      await step(js, "frame", 3000); await settle();
      await clickBtn(js, /^Open Paint Studio$/); await sleep(4000); await settle();
      const v = await b.rect(".ss-cv-view canvas, .ss-cv canvas");
      if (!v) throw new Error("Paint Studio did not open");
      // A brush mask on the wet sidewalk at the right of the frame.
      const img = await js("const c=[...document.querySelectorAll('.ss-cv canvas')].filter(x=>x.getClientRects().length).sort((a,b)=>b.width*b.height-a.width*a.height)[0]; const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}");
      const P = (fx, fy) => [img.x + img.w * fx, img.y + img.h * fy];
      for (const [a, z] of [[[0.70, 0.74], [0.80, 0.74]], [[0.70, 0.79], [0.80, 0.79]], [[0.71, 0.84], [0.79, 0.84]]]) { await b.drag(...P(...a), ...P(...z), 600); await sleep(250); }
      await js(`const i=document.querySelector('.ss-cv-prompt'); if(i){ i.focus(); i.value='a battered metal trash can on the wet sidewalk'; i.dispatchEvent(new Event('input',{bubbles:true})); i.blur(); } return !!i`);
      await sleep(600); await b.move(2, 2);
      return still("paint_studio.jpg");
    } },
  { file: "presets.jpg", size: [1464, 914], scene: "demo", what: "Presets (V) docked beside Properties: 15 camera moves rendered live from the stage, the racing set included, after Arm car tracking was applied",
    run: async ({ b, js, still }) => {
      await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await step(js, "set", 1500);
      await js("__qa.node.ssPresets.open('camera'); return 1");
      for (let i = 0; i < 90; i++) { await sleep(500); if (await js("const L=__qa.node.ssPresets.live; return !L || (!L.queue.length && !L.running)")) break; }
      await js("await __qa.node.ssPresets.apply('arm_car'); return 1"); await sleep(1500); await b.move(2, 2);
      return still("presets.jpg");
    } },
  { file: "camera_keys.jpg", size: [1424, 926], scene: "demo", what: "③ Set in Free view with Show cameras: a numbered camera at every key of the crane shot, the shot camera inset",
    run: async ({ b, js, still }) => {
      await step(js, "set", 1500);
      await js("const s=__qa.stage.toJSON().shots.find(x=>/__crane$/.test(x.id)); if (s) __qa.p.selectShot(s.id); __qa.stage.setEnvironment({ weather: 'none' }); return s?.id||null"); await sleep(1200);
      await clickBtn(js, /^Free view$/); await sleep(1000);
      await clickBtn(js, /^Show cameras$/); await sleep(800);
      // Look across the whole crane move from the side and above, so every numbered camera is in view.
      await js(`const st=__qa.stage, ks=st.activeShot().camera_keys; const P=ks.map(k=>k.position), T=ks.map(k=>k.target);
        const c=[0,1,2].map(i=>[...P,...T].reduce((a,p)=>a+p[i],0)/(P.length+T.length));
        const span=Math.max(...[...P,...T].map(p=>Math.hypot(p[0]-c[0],p[2]-c[2])));
        st.free={ position:[c[0]+span*1.15, c[1]+span*0.75, c[2]-span*0.25], target:[c[0], Math.max(0.5,c[1]-1.5), c[2]] }; st._applyActive(); return span`);
      await sleep(1500); await b.move(2, 2);
      return still("camera_keys.jpg", { clip: await viewBox(b) });
    } },
  { file: "app_mode.jpg", size: [1400, 1000], scene: "demo", open: { full: false }, what: "ComfyUI App mode: the Soundstage stage in the side panel (step bar, the full-workspace button, the camera view)",
    run: async ({ b, still }) => { await sleep(1500); await b.move(700, 450); return still("app_mode.jpg", { panel: false }); } },
  { file: "dailies.jpg", size: [1624, 1037], scene: "drycreek", what: "Takes (Dailies): scene 2's setups and their real takes as an Avid-style bin",
    run: async ({ b, js, still, settle }) => {
      await tab(js, "dailies", 2500);
      await js("try { __qa.node.ssDailies.bin.setView('bin'); } catch {} return 1"); await sleep(1500);
      // Bigger frames: the bin's own size slider.
      await js(`const r=[...__qa.el.querySelectorAll('input[type=range]')].find(x=>x.getClientRects().length&&x.closest('.ss-dailies, .ss-dailieshost')); if(r){ r.value=r.max; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); } return !!r`);
      await sleep(1500);
      await js("const t=[...__qa.el.querySelectorAll('.ss-dailieshost button.tk')].filter(x=>x.getClientRects().length)[1]; t?.click(); return !!t");
      await sleep(2000); await settle(); await b.move(2, 2);
      return still("dailies.jpg");
    } },
  { file: "lined_script.jpg", size: [1624, 924], scene: "drycreek", what: "ScriptSync: scene 2's coverage lines with each setup's thumbnail on the page, the player beside it",
    run: async ({ b, js, still, settle }) => {
      await js("__qa.node.ssDailies.openScriptSync('sc_2'); return 1"); await sleep(3000);
      await clickBtn(js, /^Got it$/); await sleep(800);
      const L = await js(`const g=[...__qa.el.querySelectorAll('svg g.ln')].filter(x=>x.getClientRects().length)[1]; const r=g?.querySelector('path.hit')?.getBoundingClientRect(); return r?{x:r.x+r.width/2,y:r.y+r.height*0.45}:null`);
      if (L) { await b.click(L.x, L.y, { after: 1500 }); }
      await settle(); await b.move(2, 2);
      return still("lined_script.jpg");
    } },
  { file: "new_sets.jpg", size: [1424, 926], scene: null, what: "The new sets in clay and colour, each set up by the App from a slugline (tools/tryit/scenes)",
    run: async ({ b, js }) => {
      const SETS = [["swim", "Underwater coral reef", 40], ["fire", "Burning building", 40], ["airplane", "Airplane cabin", 40],
        ["train", "Train carriage", 40], ["platform", "Station platform", 60], ["clouds", "Above the clouds", 40]];
      const tiles = [];
      for (const [key, label, f] of SETS) {
        const j2 = await openScene(b, key);
        tiles.push({ src: await stageFrame(j2, "color", f), label });
      }
      return writeData("new_sets.jpg", await grid(js, tiles, { cols: 2, w: 640, h: 360, label: 36 }));
    } },
  { file: "exports.jpg", size: [1624, 1024], scene: "chase", what: "⑦ Deliver: the cut as one video, the VFX Layer Pack and the Blender · Unreal · Maya · Nuke kit, beside the shot's final",
    run: async ({ b, js, still, settle }) => { await js("__qa.p.selectShot('tracking'); return 1"); await step(js, "deliver", 3500); await settle(); await b.move(2, 2); return still("exports.jpg"); } },
  { file: "timeline.jpg", size: [1400, 1400], page: "cut/demo.html", what: "The Cut timeline (the Cut harness, its demo cut): toolbar rows, V3 with a Lower third just added, V2 title, V1 with dips and dissolves, subtitles, A1-A3",
    run: async ({ b, js, still, settle }) => {
      await sleep(3000); await settle();
      // Edit it like a user: a transition chip clicked goes on the cut nearest the playhead; + Title adds a V2 title there.
      for (const [chip, f] of [["Dissolve", 60], ["Dip black", 110], ["Dip white", 150]]) {
        await js(`window.cutPanel.seek(${f}); return 1`); await sleep(300);
        const c = await b.byText(`^${chip}$`, "#cut span.ss-cut-fx");
        if (c) { await b.click(c.cx, c.cy, { after: 500 }); }
      }
      await js("window.cutPanel.seek(6); return 1"); await sleep(300);
      await clickBtn(js, /^\+ Title$/, "document"); await sleep(800);
      // + Graphic… > Lower third, at 2 s: a V3 motion-graphics clip, the way a user adds one.
      await js(`window.cutPanel.seek(48); await sleep(300); const g=[...document.querySelectorAll('#cut select')].find(x=>x.options[0]?.text.startsWith('+ Graphic'));
        if (g) { const o=[...g.options].find(x=>/Lower third/i.test(x.text)); g.value=o?.value||''; g.dispatchEvent(new Event('change',{bubbles:true})); } return !!g`);
      await sleep(1500); await b.move(2, 2);
      const box = await js(`const c=document.querySelector('#cut'), v=c.querySelector('canvas'); const r=c.getBoundingClientRect(), q=v.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(q.bottom + 4), width: Math.round(r.width), height: Math.round(r.bottom - q.bottom - 4) };`);
      return still("timeline.jpg", { clip: box });
    } },
  { file: "pose_3d.jpg", size: [1424, 926], scene: null, what: "Pose in 3D: a person in pose mode, the rotate ring on the head, a dot on every joint",
    run: async ({ b, js, still }) => {
      await step(js, "set", 1500);
      await poseSetup(js);
      await js("__qa.stage.poser.pickJoint('head'); __qa.stage.render(); return 1"); await sleep(800); await b.move(2, 2);
      return still("pose_3d.jpg", { clip: await viewBox(b) });
    } },
  { file: "camera_rigs.gif", size: [1424, 926], scene: null, what: "The same push-in on four rigs (free, dolly, jib, handheld): the shot camera rendered by the stage, 2 x 2",
    run: async ({ js, rec }) => {
      const RIGS = await js("const m = await import('/extensions/ComfyUI-Soundstage/stage/camrig.mjs'); return Object.fromEntries(Object.entries(m.RIGS).map(([k,v])=>[k,v.label]))");
      const kinds = ["free", "dolly", "jib", "handheld"];
      // One push-in on two people on the empty stage: 12 m out to 3.4 m in over 60 frames, then the keys hold, so each rig's
      // start, stop and settle show. Every rig is the same keys; only the rig changes.
      const k = (frame, z, y) => ({ frame, position: [0, y, z], target: [0, 1.25, 0], focal_mm: 35 });
      const scene = { version: 2, shot: { frames: 97, fps: 24 }, environment: { set: "empty", weather: "none", density: 0.5, water_level: 2.5 },
        sun: { azimuth_deg: 35, elevation_deg: 35 },
        lighting: { mode: "manual", hour: 15, day_of_year: 200, latitude: 34.05, north_deg: 0, overcast: false, preset: null, lights: [] },
        actors: [{ id: "man", name: "Man", kind: "man", height_m: 1.78, rotation_deg: 0, position: [-0.55, 0, 0], keys: [{ frame: 0, position: [-0.55, 0, 0] }] },
          { id: "woman", name: "Woman", kind: "woman", height_m: 1.68, rotation_deg: 0, position: [0.55, 0, 0], keys: [{ frame: 0, position: [0.55, 0, 0] }] }],
        props: [], shots: [{ id: "push", name: "Push in", setup: "master", camera_keys: [k(0, 12, 1.6), k(60, 3.4, 1.55), k(96, 3.4, 1.55)] }],
        active_shot: "push", camera: k(0, 12, 1.6) };
      await js(`__qa.stage.load(${JSON.stringify(scene)}); return 1`); await sleep(1500);
      const n = 97;
      const frames = {};
      for (const k of kinds) {
        await js(`__qa.stage.setRig('${k}', 1); return 1`); await sleep(300);
        frames[k] = [];
        for (let f = 0; f < n; f += 2) frames[k].push(await stageFrame(js, "clay", f));
      }
      const r = rec("camera_rigs");
      for (let i = 0; i < frames.free.length; i++) {
        r.add(await grid(js, kinds.map((k) => ({ src: frames[k][i], label: RIGS[k] || k })), { cols: 2, w: 480, h: 270, label: 30, font: 16, type: "image/png" }), 1 / 12);
      }
      r.rest(1.0);
      return r.build({ fps: 12, maxColors: 128 });
    } },
  { file: "pose_3d.gif", size: [1424, 926], scene: null, what: "Pose in 3D: click a joint for the rotate ring, drag the yellow hand and foot dots (two-bone IK)",
    run: async ({ b, js, rec }) => {
      await step(js, "set", 1500);
      await poseSetup(js); await sleep(800); await b.move(2, 2);
      // The person and the space around them (the middle of the view), so the joints read at README size.
      const v = await viewBox(b);
      const r = rec("pose_3d", { clip: { x: v.x + Math.round(v.width * 0.16), y: v.y, width: Math.round(v.width * 0.56), height: v.height }, width: 640 });
      const C1 = "Click a joint: the rotate ring turns it", C2 = "Drag the yellow hand dot: the arm follows (IK)", C3 = "Drag a foot dot: the knee bends on its hinge";
      await r.grab(0.9, C1);
      for (const j of ["head", "r_shoulder", "r_elbow"]) {
        const p = await dotXY(js, j); if (!p) continue;
        await b.click(p.x, p.y, { after: 300 }); await b.move(2, 2); await r.grab(0.85, C1);
      }
      const h = await dotXY(js, "r_hand");
      if (h) { await dragRec(b, r, [h.x, h.y], [h.x + 40, h.y - 190], { steps: 12, caption: C2 }); await sleep(300); await b.move(2, 2); await r.grab(1.0, C2); }
      const f = await dotXY(js, "l_foot");
      if (f) { await dragRec(b, r, [f.x, f.y], [f.x - 25, f.y - 90], { steps: 10, caption: C3 }); await sleep(300); await b.move(2, 2); await r.grab(1.6, C3); }
      return r.build({ fps: 12, maxColors: 160 });
    } },
  { file: "scriptsync.gif", size: [1624, 924], scene: "drycreek", what: "ScriptSync: click a coverage line and that take loads in the player at that moment; Edit lining drags a line's end",
    run: async ({ b, js, rec, settle }) => {
      await js("__qa.node.ssDailies.openScriptSync('sc_1'); return 1"); await sleep(3000);
      await clickBtn(js, /^Got it$/); await sleep(800); await settle(); await b.move(2, 2);
      const r = rec("scriptsync", { clip: await elBox(b, ".ss-stage .ss-dailieshost"), width: 960 });
      const C1 = "Click a coverage line: that take loads in the player, cued to that line", C2 = "Edit lining: drag a line's end to re-line the setup";
      await r.grab(1.0, C1);
      const lines = await js(`return [...__qa.el.querySelectorAll('svg g.ln')].filter(g=>g.getClientRects().length).map(g=>{ const r=g.querySelector('path.hit').getBoundingClientRect(); return { id: g.dataset.id, x: r.x + r.width / 2, y0: r.y, h: r.height }; })`);
      const picks = [[0, 0.75], [1, 0.3], [2, 0.55]];
      for (const [k, fy] of picks) {
        const L = lines[k % lines.length]; if (!L) continue;
        await b.click(L.x, L.y0 + L.h * fy, { after: 200 }); await b.move(2, 2);
        await settle(4000); await r.roll(1500, 120, C1);
      }
      await clickBtn(js, /^Edit lining$/); await sleep(500); await b.move(2, 2); await r.grab(0.8, C2);
      const hd = await js(`const L=[...__qa.el.querySelectorAll('svg g.ln')].filter(g=>g.getClientRects().length)[1]; const c=L?.querySelector('circle.hdl[data-end=to]'); if(!c) return null; const r=c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
      if (hd) { await dragRec(b, r, [hd.x, hd.y], [hd.x, hd.y - 120], { steps: 14, caption: C2, pause: 60 }); await sleep(600); await b.move(2, 2); await r.grab(1.8, C2); }
      return r.build({ fps: 10, maxColors: 160 });
    } },
  { file: "cut_editor.gif", size: [1144, 800], scene: "chase", what: "The Cut editor on the scene's real takes: Split at the playhead, then a clip dragged to the end of the timeline",
    run: async ({ b, js, rec, settle }) => {
      await tab(js, "cut", 3000); await settle();
      await js("const C=__qa.node.ssCut; C.zoomFit?.(); return 1"); await sleep(800); await b.move(2, 2);
      const r = rec("cut_editor", { clip: await elBox(b, ".ss-stage .ss-cutview"), width: 960 });
      const C1 = "Split: an edit at the playhead (B)", C2 = "Drag a clip anywhere on the timeline: here to the end";
      // The clips on V1, read from the timeline's own hit test.
      const clips = async () => js(`const C=__qa.node.ssCut; const L=C._L; const y=L.sy-3-L.th/2; const W=C.tl.clientWidth; const out=[];
        for (let x=0; x<W; x+=2) { const h=C._hit(x,y); if (h.type!=='clip') continue; const o=out[out.length-1]; if (o&&o.idx===h.idx&&x-o.x1<=4) o.x1=x; else out.push({ idx:h.idx, x0:x, x1:x }); }
        const R=C.tl.getBoundingClientRect(); return out.map(o=>({ idx:o.idx, x0:R.x+o.x0, x1:R.x+o.x1, y:R.y+y }));`);
      let cs = await clips();
      if (!cs.length) throw new Error("no clips on V1");
      await r.grab(1.0, C1);
      const mid = (cs[0].x0 + cs[0].x1) / 2;
      await js(`const C=__qa.node.ssCut; const R=C.tl.getBoundingClientRect(); C.seek(Math.round(C._frameAt(${mid} - R.x))); return 1`);
      await sleep(600); await b.move(2, 2); await r.grab(0.9, C1);
      await clickBtn(js, /^Split$/); await sleep(700); await b.move(2, 2); await r.grab(1.4, C1);
      cs = await clips();
      const src = cs[1], last = cs[cs.length - 1];
      if (src && last) {
        await dragRec(b, r, [(src.x0 + src.x1) / 2, src.y], [last.x1 + (src.x1 - src.x0) / 2 + 8, src.y], { steps: 18, caption: C2, pause: 60 });
        await sleep(800); await b.move(2, 2); await r.grab(0.6, C2);
        await js("__qa.node.ssCut.seek(0); return 1"); await sleep(500); await b.move(2, 2);
        await r.grab(2.4, C2);
      }
      return r.build({ fps: 10, maxColors: 160 });
    } },
  { file: "live3d_climb.gif", size: [1424, 926], scene: "physics", what: "Live 3D: a person dragged onto a crate climbs it, then walks to the table and climbs onto it",
    run: async ({ b, js, rec }) => {
      await step(js, "set", 1500);
      await clickBtn(js, /^Color$/); await sleep(800);
      await js("__qa.el.classList.add('ss-cl-hide'); window.dispatchEvent(new Event('resize')); return 1"); await sleep(1200);
      await b.move(2, 2);
      // The part of the set where it happens (the table, the crates and Sam), so it reads at README size.
      const v = await viewBox(b);
      const r = rec("live3d_climb", { clip: { x: v.x + Math.round(v.width * 0.06), y: v.y + Math.round(v.height * 0.16), width: Math.round(v.width * 0.72), height: Math.round(v.height * 0.84) }, width: 720 });
      const C1 = "Drag a person onto a crate: they climb up", C2 = "Then on to the table: they walk over and climb it";
      await r.grab(0.8, C1);
      const pos = (id) => js(`const a=__qa.stage.state.actors.find(x=>x.id===${JSON.stringify(id)}); const g=__qa.stage.actorMeshes.get(a.id); const v=g.getWorldPosition(new g.position.constructor()); return [v.x, v.y, v.z];`);
      const sam = await pos("sam"), crate = await pos("crate_a"), table = await pos("table");
      const s0 = await screenOf(js, [sam[0], sam[1] + 1.0, sam[2]]), c0 = await screenOf(js, [crate[0], crate[1] + 0.8, crate[2]]);
      await dragRec(b, r, [s0.x, s0.y], [c0.x, c0.y], { steps: 16, caption: C1, pause: 50 });
      await r.roll(2000, 90, C1);
      const sam2 = await pos("sam");
      const s1 = await screenOf(js, [sam2[0], sam2[1] + 1.0, sam2[2]]), t0 = await screenOf(js, [table[0], table[1] + 0.75, table[2]]);
      await dragRec(b, r, [s1.x, s1.y], [t0.x, t0.y], { steps: 18, caption: C2, pause: 50 });
      await r.roll(2400, 90, C2);
      r.rest(1.2);
      return r.build({ fps: 12, maxColors: 160 });
    } },
  { file: "phone_viewfinder.jpg", size: [844, 390], custom: true, what: "The phone viewfinder (web/vcam/viewfinder.html) at phone landscape, live on the chase scene's tracking shot",
    run: async ({ b }) => {
      // The desktop App publishes its scene to the server, which pushes it down the phone's socket. That publish is a
      // server write (the guard blocks it), so the phone's socket gets the same message here, from the same scene file.
      const d = JSON.parse(readFileSync(join(SCENES, "chase.json"), "utf8"));
      const scene = typeof d.scene === "string" ? JSON.parse(d.scene) : d.scene;
      scene.active_shot = "tracking";
      await b.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 1.3, mobile: true });
      await b.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const SCENE = ${JSON.stringify(scene)}; const OW = window.WebSocket;
        window.WebSocket = function (url, p) { if (!/\\/soundstage\\/vcam\\/ws/.test(String(url))) return new OW(url, p);
          const ws = { readyState: 0, url: String(url), send() {}, close() { this.readyState = 3; }, addEventListener() {}, removeEventListener() {} };
          setTimeout(() => { ws.readyState = 1; ws.onopen && ws.onopen({}); setTimeout(() => ws.onmessage && ws.onmessage({ data: JSON.stringify({ type: 'scene', scene: SCENE, rev: 1, sync: { frame: 40, playing: false, fps: 24 } }) }), 300); }, 200);
          return ws; };
        window.WebSocket.OPEN = 1; window.WebSocket.CLOSED = 3; })();` });
      await b.send("Page.navigate", { url: `${BASE}/extensions/ComfyUI-Soundstage/vcam/viewfinder.html` });
      await sleep(2500);
      await b.ev("window.SS_BASE = '/extensions/ComfyUI-Soundstage'; await import('/extensions/ComfyUI-Soundstage/vcam/viewfinder.mjs'); return 1");
      await sleep(3000);
      const go = await b.byText("^Start$");   // the phone's own start screen: tap Start
      if (go) await b.click(go.cx, go.cy, { after: 500 });
      await sleep(6000); await b.move(2, 2);
      const r = await b.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
      return writeData("phone_viewfinder.jpg", "data:image/jpeg;base64," + r.result.data);
    } },
  { file: "director.jpg", size: [1624, 1024], scene: "demo", what: "The Director docked beside Properties: the README's own request becomes a plan (rules planner from this branch), applied, with Undo this",
    run: async ({ b, js, still }) => {
      const lp = await localPlanner();
      try {
        await step(js, "set", 1500);
        await js(`const g = window.fetch; window.fetch = (u, init = {}) => { const url = String((u && u.url) || u);
          if (/\\/soundstage\\/director\\/plan(\\?|$)/.test(url)) return g('http://127.0.0.1:${lp.port}/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: init.body });
          return g(u, init); }; return 1`);
        await js("const D=__qa.node.ssDirector; D.director.setBackend('rules'); D.open(); return 1"); await sleep(1500);
        const inp = await b.rect("JS:[...document.querySelectorAll('input')].filter(i=>/Tell the set what you want/.test(i.placeholder||''))");
        if (!inp) throw new Error("the Director panel did not open");
        await b.click(inp.cx, inp.cy, { after: 300 });
        await b.send("Input.insertText", { text: "put Mara in the sports car at night, rain, camera on the hood, she's nervous" });
        await sleep(300); await b.key("Enter"); await sleep(3500);
        await clickBtn(js, /^Apply/); await sleep(3000); await b.move(2, 2);
        return still("director.jpg");
      } finally { lp.stop(); }
    } },
];

// ------------------------------------------------------------------------------------------------ runner

async function main() {
  if (args.includes("--list")) { for (const e of ENTRIES) console.log(`${e.file.padEnd(22)} ${e.size.join("x").padEnd(10)} ${e.scene || "-"}  ${e.what}`); return; }
  mkdirSync(OUT, { recursive: true }); mkdirSync(WORK, { recursive: true });
  const todo = ENTRIES.filter((e) => !ONLY || ONLY.has(e.file.replace(/\.(jpg|gif)$/, "")));
  if (!todo.length) { console.log("Nothing to do (see --list)."); return; }
  console.log(`README media v3 -> ${OUT}  (angle ${ANGLE}, ${todo.length} entr${todo.length > 1 ? "ies" : "y"})`);
  let b = null, size = "";
  const results = [];
  try {
    for (const e of todo) {
      const sz = e.size.join("x");
      if (!b || sz !== size) { b?.close(); b = await launch({ port: PORT, w: e.size[0], h: e.size[1], serveWeb: true, angle: e.angle || ANGLE }); size = sz; }
      const mark = b.logs.length, t0 = Date.now();
      try {
        let js;
        if (e.custom) js = null;   // the entry opens its own page
        else if (e.page) {   // a page of its own (the Cut harness): no ComfyUI graph
          await b.send("Page.navigate", { url: `${BASE}/extensions/ComfyUI-Soundstage/${e.page}` });
          await sleep(4000);
          js = (code) => b.ev(`const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); ${code}`);
        } else js = await openScene(b, e.scene, e.open || {});
        const out = await e.run({ b, js, still: (n, o) => still(b, n, o), rec: (n, o) => new Recorder(b, n, o), settle: (ms) => settleMedia(b, ms) });
        const errs = b.logs.slice(mark).filter((l) => /^(EXC|ERR)/.test(l) && !/api\.comfy\.org|getCanvas|user\.css|favicon|Three\.js|deprecated/i.test(l));
        results.push({ file: e.file, ok: true, secs: Math.round((Date.now() - t0) / 1000), out, errs });
        console.log(`  ${e.file}  ok (${Math.round((Date.now() - t0) / 1000)} s)${errs.length ? `  console errors: ${errs.length}\n    ${errs.slice(0, 4).map((x) => x.slice(0, 200)).join("\n    ")}` : ""}`);
      } catch (err) {
        results.push({ file: e.file, ok: false, error: String(err?.stack || err).slice(0, 600) });
        console.log(`  ${e.file}  FAILED: ${String(err?.message || err).slice(0, 300)}`);
      }
    }
    const blocked = await b?.ev("return (window.__blocked||[]).map(x=>x.m+' '+x.url.slice(0,80))").catch(() => []);
    if (blocked?.length) console.log(`Guard answered locally: ${blocked.length} write(s), e.g. ${blocked.slice(0, 3).join(" | ")}`);
  } finally { b?.close(); }
  writeFileSync(join(WORK, "results.json"), JSON.stringify(results, null, 1));
  const bad = results.filter((r) => !r.ok);
  console.log(`${results.length - bad.length}/${results.length} captured.${bad.length ? ` Failed: ${bad.map((r) => r.file).join(", ")}` : ""}`);
  process.exitCode = bad.length ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url.replace(/\\/g, "/").toLowerCase().endsWith(basename(process.argv[1]).toLowerCase());
if (isMain) main();
