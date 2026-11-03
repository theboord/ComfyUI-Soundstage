// The Passes viewer (web/passes), clicked through in a hidden Chrome against a local static build of the try-it demo.
//   python3 tools/tryit/build_tryit.py --web web --out <dir>/staging
//   (cd <dir> && python3 -m http.server 8781 --bind 127.0.0.1) &
//   node tools/qa/passes_viewer.mjs http://127.0.0.1:8781/local.html <screenshot dir>
// It opens the viewer from a Takes card, a takes row (the recorded Milestone 25 performance), the Ladder bar and the
// replayed Video → 3D result, in the canvas and classic layouts and at phone width. The demo has no matte media, so the
// matte tools are driven on a synthetic Layer Pack made in the page (a soft-edged figure with hair-like strands): it
// says so in the file names. Exits 1 on a console error or a failed check. Nothing is POSTed (tools/qa/lib.mjs guard).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./lib.mjs";

const URL0 = process.argv[2] || "http://127.0.0.1:8781/local.html";
const DIR = process.argv[3] || "passes_shots";
const PORT = +(process.env.CDP_PORT || 9681);
mkdirSync(DIR, { recursive: true });
const b = await launch({ port: PORT, w: 1440, h: 900, angle: process.env.SS_ANGLE || "swiftshader" });
const fails = [];
let n = 0, mark = 0;
const ignore = (l) => /favicon\.ico|GPU stall|swiftshader|WebGL|Automatic fallback to software|\[\.WebGL|play\(\) request was interrupted|NotAllowedError/i.test(l);
const errorsSince = () => { const e = b.logs.slice(mark).filter((l) => /^(EXC|ERR|NET)/.test(l) && !ignore(l)); mark = b.logs.length; return e; };
async function shot(name, note = "") {
  await sleep(500);
  const file = join(DIR, `${String(++n).padStart(2, "0")}_${name}.png`);
  await b.shot(file);
  const errs = errorsSince();
  if (errs.length) fails.push(`${name}: ${errs.join(" | ")}`);
  console.log(`${errs.length ? "FAIL" : "ok  "} ${name}${note ? `  (${String(note).slice(0, 200)})` : ""}${errs.length ? "\n     " + errs.join("\n     ") : ""}`);
}
const check = (cond, what) => { if (!cond) fails.push(what); console.log(cond ? "ok  " : "FAIL", what); };
async function open(hash, { classic = false } = {}) {
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}#${hash}` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage && !!document.querySelector('.ss-stage')")) break; } catch { /* loading */ } }
  if (classic) { await b.ev("localStorage.setItem('ss_layout','classic'); return 1"); await b.send("Page.reload"); await sleep(1500); return open(hash); }
  await sleep(3500);
}
const js = (code) => b.ev(`const D = window.__demo, node = D?.node, stage = node?.ssStage, P = node?.ssPipeline, PV = node?.ssPasses, sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code}`);
const viewer = (code) => js(`const V = PV.viewer; ${code}`);
const state = () => viewer(`return JSON.stringify({ open: V.isOpen, kind: V.kind, src: V.src?.type, msg: V.msg.hidden ? "" : V.msg.textContent, stats: V.stats.innerText,
  tabs: Object.fromEntries(Object.entries(V.tabs).map(([k, b]) => [k, b.classList.contains("ok")])), frames: V.frames, f: V.f,
  sideways: document.documentElement.scrollWidth > innerWidth + 1, box: (() => { const r = V.el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round); })() })`).then(JSON.parse);

// A synthetic Layer Pack made in the page: 12 frames of a soft figure (blurred edge, hair-like strands at 0.2-0.5 alpha)
// moving over a plate, its background layer (the inverse) and a depth_vis pass. Served by a stand-in api on the viewer.
const SYNTH = String.raw`
  const W = 640, H = 360, N = 12, files = {};
  const blobUrl = (c) => new Promise((ok) => c.toBlob((bl) => ok(URL.createObjectURL(bl)), "image/png"));
  const cv = () => Object.assign(document.createElement("canvas"), { width: W, height: H });
  for (let f = 0; f < N; f++) {
    const m = cv(), g = m.getContext("2d"), x = 200 + f * 14;
    g.filter = "blur(2px)"; g.fillStyle = "#fff";
    g.beginPath(); g.ellipse(x, 230, 52, 110, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x, 100, 36, 0, Math.PI * 2); g.fill();
    g.filter = "blur(0.6px)";
    for (let k = 0; k < 26; k++) { g.strokeStyle = "rgba(255,255,255," + (0.2 + 0.3 * ((k * 7) % 5) / 4) + ")"; g.lineWidth = 1 + (k % 3) * 0.5;
      g.beginPath(); g.moveTo(x - 30 + k * 2.3, 78); g.quadraticCurveTo(x - 60 + k * 4, 40 - (k % 4) * 6, x - 70 + k * 5.5, 20 + (k % 5) * 4); g.stroke(); }
    const run = cv(), r = run.getContext("2d");
    r.drawImage(m, 0, 0); r.globalCompositeOperation = "source-in";
    const gr = r.createLinearGradient(x - 60, 0, x + 60, 360); gr.addColorStop(0, "#e86a2c"); gr.addColorStop(1, "#2c6ae8"); r.fillStyle = gr; r.fillRect(0, 0, W, H);
    const bg = cv(), q = bg.getContext("2d");
    const sky = q.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, "#8fb4d8"); sky.addColorStop(1, "#d9c49a"); q.fillStyle = sky; q.fillRect(0, 0, W, H);
    q.fillStyle = "#4a5a3a"; for (let i = 0; i < 8; i++) q.fillRect(i * 90 - 20, 250 - (i % 3) * 30, 60, 200);
    q.globalCompositeOperation = "destination-out"; q.drawImage(m, 0, 0);
    const d = cv(), e = d.getContext("2d");
    const dg = e.createLinearGradient(0, 0, 0, H); dg.addColorStop(0, "#111"); dg.addColorStop(1, "#888"); e.fillStyle = dg; e.fillRect(0, 0, W, H);
    e.globalCompositeOperation = "source-over"; e.globalAlpha = 0.95; e.filter = "brightness(0.85)"; e.drawImage(m, 0, 0);
    const fr = 1001 + f;
    files["layers/10_runner/png/runner." + fr + ".png"] = await blobUrl(run);
    files["layers/00_bg/png/bg." + fr + ".png"] = await blobUrl(bg);
    files["aovs/depth_vis/depth_vis." + fr + ".png"] = await blobUrl(d);
  }
  const manifest = { shot: { name: "QA_SYNTH", fps: 24, frame_start: 1001, frames: N, resolution: [W, H] }, aovs: { depth: { exr: "aovs/depth/depth.####.exr" } },
    layers: [{ id: "bg", name: "BG plate", kind: "background", z: 0, files: { png: "layers/00_bg/png/bg.####.png" } },
             { id: "runner", name: "Runner (synthetic)", kind: "character", z: 10, files: { png: "layers/10_runner/png/runner.####.png" } }] };
  const real = V.host.api;
  const rel = (path) => { const q = new URLSearchParams(String(path).split("?")[1] || ""); const sub = (q.get("subfolder") || "").replace(/^soundstage_layerpacks\/QA_SYNTH\/?/, ""); return (sub ? sub + "/" : "") + q.get("filename"); };
  V.host.api = { ...real, apiURL: (p) => (/QA_SYNTH/.test(p) ? files[rel(p)] || p : real.apiURL(p)),
    fetchApi: async (p) => (/QA_SYNTH/.test(p) && /manifest\.json/.test(p) ? new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }) : real.fetchApi(p)) };
  await V.open({ from: "ladder", shot: { id: stage.activeShot().id, name: "QA synthetic pack" }, chosen: { layerpack: "QA_SYNTH" }, label: "QA synthetic Layer Pack" });
  for (let i = 0; i < 40 && (!V.state || V.src?.type !== "layerpack"); i++) await sleep(150);
  await sleep(600);
  return 1;`;
const setMode = (m, extra = "") => viewer(`V.mode = ${JSON.stringify(m)}; ${extra} V._buildControls(); await V.render(); return 1`);

try {
  // ---------------------------------------------------------------- Takes: the button on a card and on a row
  await open("three");
  await js("document.querySelector('button[data-tab=dailies]').click(); return 1"); await sleep(2500);
  const btns = await js("return document.querySelectorAll('.ss-dailies .ss-pv-btn, .ss-pv-btn').length");
  await shot("takes_bin_passes_buttons", `${btns} Passes buttons`);
  check(btns >= 3, `every take card has a Passes button (${btns})`);
  await b.clickEl(".ss-pv-btn"); await sleep(2500);
  let s = await state();
  await shot("card_final_matte_unavailable_demo", s.msg);
  check(s.open && s.kind !== "matte" ? true : /no matte media/.test(s.msg), "a plain final opens; the matte says the demo has no matte media");
  await viewer("V.setKind('matte'); return 1"); await sleep(800);
  s = await state();
  await shot("matte_tab_demo_note", s.msg);
  check(/try-it demo has no matte media/.test(s.msg), `Matte tab on a demo take says the demo has no matte media (${s.msg.slice(0, 80)})`);
  check(!s.tabs.matte && s.tabs.depth, `tabs: matte unavailable, depth available (${JSON.stringify(s.tabs)})`);
  await b.key("Escape"); await sleep(400);
  check(!(await viewer("return V.isOpen")), "Esc closes the viewer");

  // the recorded Milestone 25 performance: open its row's button
  await js(`const card = document.querySelector('.dl-card[aria-label*="Driver profile"]'); card?.scrollIntoView({ block: 'center' }); card?.querySelector('button.tk')?.click(); return 1`); await sleep(1200);
  const SEL = "JS:[...document.querySelectorAll('.dl-takes .ss-pv-btn')].filter((x) => /Performance · m25/.test(x.title))";
  const opened = !!(await b.rect(SEL));
  await shot("takes_row_passes_button", opened ? "found" : "missing");
  if (opened) { const r = await b.rect(SEL); await b.click(r.cx, r.cy); } else {
    // fall back: the same take record the bin holds
    await js(`const t = { id: 'performance_m25_demo', n: 9, kind: 'final', url: 'r/m_perf_final.mp4', video: true, performance: true, asset: 'm_perf_asset.json [output]', label: 'Performance · m25_wow (Milestone 25 recording)' };
      PV.open({ from: 'take', shot: { id: 'profile', name: 'Driver profile' }, take: t, label: 'Driver profile · Tk 9' }); return 1`);
  }
  await sleep(5000);
  s = await state();
  check(opened, "the performance take's row in the takes list has a Passes button");
  await shot("perf_pose_dwpose_over_actor", `${s.kind} ${s.src} ${s.stats}`);
  check(s.kind === "pose" && s.src === "performance" && /face points/.test(s.stats), `a performance take opens on Pose with the DWPose read (${s.kind}/${s.src})`);
  await viewer("V.setFrame(40); V.setZoom(4); V.cx = 0.52; V.cy = 0.42; V.parts.numbers = true; V._buildControls(); await V.render(); V._drawView(); return 1"); await sleep(1500);
  await shot("perf_pose_face68_numbers_400pct", (await state()).stats);
  await viewer("V.parts.numbers = false; V.parts.conf = false; V.setZoom('fit'); V._buildControls(); await V.render(); return 1"); await sleep(1200);
  await shot("perf_pose_part_colours");
  await viewer("V.parts.conf = true; V.setKind('talk'); return 1"); await sleep(3500);
  s = await state();
  await shot("perf_talking_wave_mouth_lipsync", s.stats);
  check(s.kind === "talk" && /Lip sync: r = 0\.9/.test(s.stats) && /mouth openings/.test(s.stats), `Talking: the mouth curve, its openings and the recorded r (${s.stats.replace(/\n/g, " ").slice(0, 160)})`);
  await viewer("V.mouthZoom = true; V.setFrame(22); V._buildControls(); await V.render(); return 1"); await sleep(1200);
  await shot("perf_talking_mouth_closeup_f22");
  await viewer("V.mouthZoom = false; V.setKind('depth'); return 1"); await sleep(2500);
  s = await state();
  check(s.kind === "depth" && /nearest/.test(s.stats), `Depth: the stage depth pass draws (${s.stats.slice(0, 80)})`);
  await viewer("V.setCompare('wipe'); V.split = 0.5; V._drawView(); return 1"); await sleep(1200);
  await shot("depth_turbo_wipe_vs_take", s.stats);
  await viewer("V.depthMode = 'grey'; V.near = 0.97; V.far = 0.7; V.setCompare('side'); V._buildControls(); await V.render(); return 1"); await sleep(1500);
  await shot("depth_grey_window_side_by_side", (await state()).stats);
  const play = await viewer("V.setKind('pose'); await sleep(2500); V.setCompare('off'); const f0 = V.f; V.play(); await sleep(1600); const f1 = V.f; V.stop(); return JSON.stringify({ f0, f1 })");
  check(JSON.parse(play).f1 !== JSON.parse(play).f0, `Play advances the frame (${play})`);
  const step = await viewer("V.setFrame(10); V.step(1); const a = V.f; V.step(-1); V.step(-1); return [a, V.f].join(',')");
  check(step === "11,9", `frame step forward and back (${step})`);
  const exp = await viewer("const before = window.__blocked.length; V.exportStill(); for (let i = 0; i < 30 && window.__blocked.length === before; i++) await sleep(200); return window.__blocked.slice(before).map((x) => x.m + ' ' + x.url).join(',')");
  check(/DOWNLOAD/.test(exp), `Still saves a PNG of the view (the QA guard swallowed the download: ${exp})`);
  await b.key("Escape"); await sleep(300);

  // ---------------------------------------------------------------- the matte tools on a synthetic Layer Pack
  await viewer(SYNTH);
  s = await state();
  check(s.kind === "matte" && s.src === "layerpack" && s.frames === 12, `synthetic pack opens on the matte (${s.kind}/${s.src}, ${s.frames} frames)`);
  await setMode("matte"); await shot("synthetic_matte_bw", (await state()).stats);
  for (const [bg, extra] of [["checker", ""], ["black", ""], ["white", ""], ["color", "V.color = '#00b140';"], ["busy", ""]]) {
    await setMode("over", `V.bg = '${bg}'; ${extra}`);
    await shot(`synthetic_over_${bg}`);
  }
  await viewer("V.color = '#e0161e'; V.bg = 'color'; V._buildControls(); await V.render(); return 1"); await shot("synthetic_over_red");
  await setMode("ruby"); await shot("synthetic_rubylith");
  await setMode("edge"); s = await state();
  await shot("synthetic_edges_fit", s.stats);
  check(/Soft edge [\d,]+ px .* px wide/.test(s.stats), `the edge view counts the soft band (${s.stats.split("\n")[0]})`);
  await viewer("V.setZoom(8); V.cx = 0.37; V.cy = 0.18; V._drawView(); return 1"); await sleep(600);
  await shot("synthetic_edges_hair_800pct");
  await setMode("over", "V.bg = 'busy';"); await viewer("V.setZoom(4); V.cx = 0.37; V.cy = 0.2; V._drawView(); return 1");
  await shot("synthetic_over_busy_hair_400pct");
  const flick = await viewer("V.setZoom('fit'); V.setCompare('flicker'); const seen = new Set(); for (let i = 0; i < 8; i++) { await sleep(180); seen.add(V.abTag.textContent); } return [...seen].join(' / ')");
  await shot("synthetic_flicker", flick);
  check(/A · pass/.test(flick) && /B · original/.test(flick), `Flicker alternates the pass and the original (${flick})`);
  await viewer("V.setCompare('side'); return 1"); await shot("synthetic_side_by_side");
  await viewer("V.setCompare('wipe'); V.split = 0.45; V._drawView(); return 1"); await shot("synthetic_wipe");
  await viewer("V.setCompare('off'); V.setFrame(9); return 1"); await sleep(800); await shot("synthetic_edges_f9", (await state()).stats);
  await viewer("V.setKind('depth'); return 1"); await sleep(1500);
  s = await state();
  await shot("synthetic_pack_depth_turbo", s.src);
  check(s.src === "pack_depth", `the pack's depth AOV opens in Depth (${s.src})`);
  // a real wheel zoom and a drag pan on the canvas
  await viewer("V.setKind('matte'); return 1"); await sleep(1500);
  const cvr = await b.rect(".ss-pv .cv");
  for (let i = 0; i < 6; i++) { await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cvr.cx - 120, y: cvr.cy - 160, deltaX: 0, deltaY: -120 }); await sleep(60); }
  await b.drag(cvr.cx, cvr.cy, cvr.cx + 120, cvr.cy + 60, 400);
  const z = await viewer("return V.zoomTag.textContent");
  await shot("synthetic_wheel_zoom_and_pan", z);
  check(parseInt(z, 10) >= 200, `the mouse wheel zooms past 200 % (${z})`);
  await b.key("Escape"); await sleep(300);

  // ---------------------------------------------------------------- the Ladder bar (⑥ Review)
  await js("P.go('review'); return 1"); await sleep(2500);
  const lad = await b.rect("JS:[...document.querySelectorAll('.ss-pv-btn')].filter((x) => x.closest('.ss-ladder, [class*=ladder]'))");
  await shot("ladder_bar_passes_button", lad ? "found" : "missing");
  check(!!lad, "the Ladder bar has a Passes button");
  if (lad) { await b.click(lad.cx, lad.cy); await sleep(3000); s = await state(); await shot("ladder_passes_open", `${s.kind} ${s.msg || s.stats}`.slice(0, 160)); check(s.open, "the Ladder's Passes opens the viewer"); await b.key("Escape"); }

  // ---------------------------------------------------------------- Video → 3D: the replayed run's result
  await open("stunt--v2s");
  await sleep(4000);
  await js("[...document.querySelectorAll('.ss-vi-modal button')].find(x=>/^Rebuild$/.test(x.textContent.trim()))?.click(); return 1");
  await sleep(15000);
  const v2b = await b.rect(".ss-v2c .ss-pv-btn");
  await shot("v2s_bar_passes_button", v2b ? "found" : "missing");
  check(!!v2b, "the Video → 3D Identical? bar has a Passes button");
  if (v2b) {
    await b.click(v2b.cx, v2b.cy); await sleep(3500);
    s = await state();
    await shot("v2s_passes_first_tab", `${s.kind}/${s.src} ${s.msg}`.slice(0, 160));
    await viewer("V.setKind('matte'); return 1"); await sleep(800); s = await state();
    await shot("v2s_matte_no_masks", s.msg);
    check(/demo kept no clip masks|no matte media/.test(s.msg + s.stats + (await viewer("return V.note.innerText"))), "Video → 3D in the demo says it kept no clip masks");
    await viewer("V.setKind('pose'); return 1"); await sleep(3500); s = await state();
    await shot("v2s_pose_captured_body_over_source", `${s.src} ${s.stats}`);
    check(s.src === "stage_pose" && /on the stage/.test(s.stats), `Video → 3D pose: the captured body through the clip camera (${s.src})`);
    await viewer("V.setKind('depth'); await sleep(1500); V.setCompare('wipe'); V._drawView(); return 1"); await sleep(1500);
    await shot("v2s_depth_wipe_vs_source", (await state()).stats);
    await b.key("Escape");
  }

  // ---------------------------------------------------------------- phone width
  await open("three");
  await b.resize(390, 844); await sleep(800);
  await js(`const t = { id: 'performance_m25_demo', n: 9, kind: 'final', url: 'r/m_perf_final.mp4', video: true, performance: true, asset: 'm_perf_asset.json [output]', label: 'Performance · m25_wow (Milestone 25 recording)' };
    PV.open({ from: 'take', shot: { id: 'profile', name: 'Driver profile' }, take: t, label: 'Driver profile · Tk 9' }); return 1`); await sleep(3500);
  s = await state();
  await shot("phone_390_pose", JSON.stringify(s.box));
  check(!s.sideways && s.box[2] <= 390 && s.box[0] >= 0, `phone width: the viewer fits, no sideways scroll (${JSON.stringify(s.box)})`);
  await viewer("V.setKind('talk'); return 1"); await sleep(3000); await shot("phone_390_talking");
  await viewer("V.setKind('matte'); return 1"); await sleep(800); await shot("phone_390_matte_unavailable");
  await b.key("Escape");
  await b.resize(1440, 900); await sleep(500);

  // ---------------------------------------------------------------- classic layout
  await open("three", { classic: true });
  await js("document.querySelector('button[data-tab=dailies]').click(); return 1"); await sleep(2500);
  await b.clickEl(".ss-pv-btn"); await sleep(2500);
  s = await state();
  await shot("classic_layout_viewer", `${s.kind} ${JSON.stringify(s.box)}`);
  check(s.open, "classic layout: the viewer opens from a take card");
  await b.key("Escape");
  await b.ev("localStorage.removeItem('ss_layout'); return 1");
} catch (e) {
  fails.push(`crashed: ${e.stack || e}`);
  console.log("FAIL crashed", e);
} finally {
  b.close();
}
console.log(fails.length ? `\n${fails.length} FAILED:\n  ${fails.join("\n  ")}` : "\nall passed");
process.exit(fails.length ? 1 : 0);
