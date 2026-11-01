#!/usr/bin/env node
// Soundstage visual regression guard ("protect it").
//
// Loads the App in a hidden Chrome at 1280x800, 1440x900 and 1920x1080, captures a fixed list of screens, and
// compares each with its baseline in tests/visual/baselines/<size>/<screen>.jpg (JPEG, 1280 wide).
// Besides the pixels it records, per screen: console errors, page scroll (scrollHeight > innerHeight), clipped text
// (scrollWidth > clientWidth), overlapping floating panels and boxes that scroll. Anything new against the
// baseline is flagged too. Writes report.md + report.json + the captures and red-on-grey diff images.
//
//   node tools/qa/visual_baseline.mjs                 compare against the baselines (exit 1 on a failure)
//   node tools/qa/visual_baseline.mjs --update        (re)write the baselines from this run
//   options: --sizes 1280x800,1920x1080  --only step_3_set,physics_panel  --threshold 0.02  --port 9770
//            --jobs 3 (sizes in parallel)  --out <dir>  --local ui/firstrun.mjs,... (serve web/ files from the repo)
//
// Needs: Google Chrome, the pod's ComfyUI at http://127.0.0.1:8189 (SS_URL to change). Never queues a render.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, loadWorkflow, toAppMode, openFull, INSTALL, METRICS, STILL_CSS, noise, sleep, REPO } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const UPDATE = args.includes("--update");
const SIZES = opt("sizes", "1280x800,1440x900,1920x1080").split(",").map((s) => s.split("x").map(Number));
const ONLY = opt("only", "") ? new Set(opt("only").split(",")) : null;
const THRESH = +opt("threshold", "0.02");
const PORT = +opt("port", "9770");
const JOBS = Math.max(1, +opt("jobs", "3"));
const LOCAL = opt("local", "") ? opt("local").split(",") : [];
const BASE_DIR = join(REPO, "tests", "visual", "baselines");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = opt("out", join(REPO, "tests", "visual", "out", stamp));
const JPEG = { width: 1280, quality: 62 };

/**
 * The fixed screens, in the order they are reached (each builds on the state the previous one left).
 * run(ctx) puts the App in that state; ctx = { b, js } where js(code) runs in the page with window.__qa set.
 */
export const SCREENS = [
  { name: "app_panel", what: "ComfyUI App mode: the stage in the narrow side panel",
    run: async ({ b }) => { await b.ev("document.querySelector('.ss-stage')?.scrollIntoView({block:'start'}); return 1"); } },
  { name: "firstrun_card", what: "Full workspace, brand-new stage: the 'Let's make a shot' card",
    run: async ({ b }) => { await openFull(b); await sleep(1200); } },
  { name: "step_1_script", what: "① Script with the demo scene loaded", demo: true, step: "script" },
  { name: "step_2_cast", what: "② Cast", step: "cast" },
  { name: "step_3_set", what: "③ Set: the giant canvas", step: "set" },
  { name: "step_4_frame", what: "④ Frame", step: "frame" },
  { name: "step_5_motion", what: "⑤ Motion", step: "motion" },
  { name: "step_6_review", what: "⑥ Review", step: "review" },
  { name: "step_7_deliver", what: "⑦ Deliver", step: "deliver" },
  { name: "toprow_render_queued", what: "③ Set while a render is queued: Stop in the step row, step names whole",
    run: async ({ js }) => { await js("document.getElementById('qa-nostop')?.setAttribute('media', 'not all'); __qa.p.go('set'); __qa.p.stopBtn.hidden = false; __qa.p.stopBtn.textContent = '■ Stop (2)'; return 1"); await sleep(1200); },
    after: async ({ js }) => { await js("__qa.p.stopBtn.hidden = true; document.getElementById('qa-nostop')?.removeAttribute('media'); return 1"); } },
  { name: "canvas_hidden", what: "③ Set with every floating panel hidden (H)",
    run: async ({ b, js }) => { await js("__qa.p.go('set'); return 1"); await sleep(1500); await hoverCanvas(b); await b.key("h"); await sleep(800); },
    after: async ({ b }) => { await hoverCanvas(b); await b.key("h"); await sleep(600); } },
  { name: "scriptsync", what: "ScriptSync: the lined script (Takes)",
    run: async ({ js }) => { await js("const s=[...__qa.el.querySelectorAll('button')].find(x=>/ScriptSync/.test(x.textContent)); s?.click(); return !!s"); await sleep(2500); } },
  { name: "import_video_chooser", what: "Import video: 'What is this video for?'",
    run: async ({ js }) => {
      await js("__qa.p.go('set'); return 1"); await sleep(1500);
      await js(`const t=__qa.el.querySelector('.ss-stageview, .ss-clarea') || __qa.el; const dt=new DataTransfer();
        dt.items.add(new File([new Uint8Array(64)], 'qa_clip.mp4', { type: 'video/mp4' }));
        t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1`);
      await sleep(1200);
    },
    after: async ({ js }) => { await js("document.querySelector('.ss-vi-modal .cancel')?.click(); return 1"); await sleep(500); } },
  { name: "motion_follow_ripple", what: "⑤ Motion › Follow: Ripple edit",
    run: async ({ js }) => { await js("__qa.p.go('motion'); return 1"); await sleep(2000); await js("__qa.p.ripple.setMode('ripple'); return 1"); await sleep(1500); },
    after: async ({ js }) => { await js("__qa.p.ripple.setMode('layout'); return 1"); await sleep(600); } },
  { name: "motion_sound_pop", what: "⑤ Motion › the Sound & music pop-over",
    run: async ({ js }) => { await js("__qa.p.go('motion'); return 1"); await sleep(1500); await js("__qa.el.querySelector('.ss-clpopbtn:not([hidden])')?.click(); return 1"); await sleep(1000); },
    after: async ({ js }) => { await js("__qa.el.querySelector('.ss-clpopbtn[aria-expanded=true]')?.click(); return 1"); await sleep(500); } },
  { name: "physics_panel", what: "③ Set › an object selected › Physics",
    run: async ({ js }) => {
      await js("__qa.p.go('set'); return 1"); await sleep(1500);
      await js(`const st=__qa.stage; const a=st.toJSON().actors; const pick=a.find(x=>/car/.test(x.kind))||a[0]; if(pick) st.select(pick.id);
        await new Promise(r=>setTimeout(r,600)); const pb=[...__qa.el.querySelectorAll('button')].find(x=>x.textContent.trim()==='Physics'&&x.getClientRects().length); pb?.click(); return !!pb`);
      await sleep(1200);
    },
    after: async ({ js }) => { await js("const x=__qa.el.querySelector('.ss-phys:not([hidden]) .ph-head button'); x?.click(); __qa.stage.select(null); return 1"); await sleep(500); } },
  { name: "presets_panel", what: "③ Set › Presets (V): camera moves, each card a clay preview rendered from the stage",
    run: async ({ b, js }) => {
      // Reduced motion: each card holds one frame of its loop, so the capture is the same every run.
      await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await js("__qa.p.go('set'); return 1"); await sleep(1500);
      await js("__qa.node.ssPresets.open('camera'); return 1");
      for (let i = 0; i < 80; i++) { await sleep(500); if (await js("const L=__qa.node.ssPresets.live; return !!L && !L.queue.length && !L.running")) break; }
      await sleep(800);
    },
    after: async ({ b, js }) => { await js("__qa.node.ssPresets.close(); return 1"); await b.send("Emulation.setEmulatedMedia", { features: [] }); await sleep(400); } },
  { name: "deliver_dcc_kit", what: "⑦ Deliver › the Blender · Unreal · Maya · Nuke (DCC kit) card",
    run: async ({ js }) => { await js("__qa.p.go('deliver'); return 1"); await sleep(2000);
      await js("const c=[...__qa.el.querySelectorAll('.card')].find(x=>/DCC kit/.test(x.textContent)&&x.getClientRects().length); c?.scrollIntoView({block:'center'}); return !!c"); await sleep(800); } },
];

async function hoverCanvas(b) {
  const r = await b.rect(".ss-stage .ss-clarea canvas, .ss-stage canvas");
  if (r) await b.move(r.x + r.w * 0.5, r.y + r.h * 0.5);
}

/** Capture every screen at one size. Returns { size, screens: { name: { jpg, metrics, errors, ok } } }. */
async function captureSize([w, h], port) {
  const tag = `${w}x${h}`;
  const dir = join(OUT, tag);
  mkdirSync(dir, { recursive: true });
  const b = await launch({ port, w, h, firstRun: false, localFiles: LOCAL });
  const res = { size: tag, screens: {}, setup: [] };
  try {
    await openApp(b);
    res.setup.push(["workflow", await loadWorkflow(b)]);
    await sleep(2500);
    let app = await toAppMode(b);
    if (!app) { await sleep(3000); app = await toAppMode(b); }   // ComfyUI's mode toggle can miss under load: once more
    res.setup.push(["appMode", app]);
    if (!app) throw new Error("ComfyUI did not switch to App mode: no screen captured at this size (run it again)");
    await sleep(1500);
    await b.key("Escape");
    res.setup.push(["install", await b.ev(INSTALL)]);
    await b.ev(`const s=document.createElement('style'); s.id='qa-still'; s.textContent=${JSON.stringify(STILL_CSS)}; document.head.append(s); return 1`);
    const js = (code) => b.ev(`const __qa=window.__qa; ${code}`);
    // Stop shows while the pod's queue has work (anyone's): keep it out of every screen but the one that asks for it.
    const quietStop = "if (__qa.p) { __qa.p._refreshStop = async () => {}; __qa.p.stopBtn.hidden = true; } if (!document.getElementById('qa-nostop')) document.head.append(Object.assign(document.createElement('style'), { id: 'qa-nostop', textContent: '.ss-stage .ss-stop { display:none !important; }' })); return 1";
    await js(quietStop);
    let demoDone = false;
    for (const sc of SCREENS) {
      const wanted = !ONLY || ONLY.has(sc.name);
      const mark = b.logs.length;
      try {
        if (sc.demo && !demoDone) {
          await openFull(b);
          await js("await __qa.node.ssDemo.load(); return 1");
          await sleep(6000);
          await js("try { __qa.stage.setFrame?.(0); } catch {} return 1");
          await js(quietStop);
          demoDone = true;
        }
        if (sc.step) { await openFull(b); await js(`__qa.p.go('${sc.step}'); return 1`); await sleep(3000); }
        if (sc.run && (wanted || sc.name === "app_panel" || sc.name === "firstrun_card")) await sc.run({ b, js });
        if (wanted) {
          await sleep(500);
          await b.move(2, 2);   // the pointer off every control (no hover states)
          const metrics = JSON.parse(await b.ev(METRICS));
          const file = join(dir, `${sc.name}.jpg`);
          await b.shot(file, { jpeg: JPEG });
          const errors = b.logs.slice(mark).filter((l) => /^(EXC|ERR)/.test(l) && !noise(l));
          res.screens[sc.name] = { jpg: file, metrics, errors, what: sc.what };
          console.log(`  ${tag} ${sc.name}${errors.length ? `  (${errors.length} console error${errors.length > 1 ? "s" : ""})` : ""}`);
        }
        if (sc.after) await sc.after({ b, js });
      } catch (e) {
        res.screens[sc.name] = { error: String(e.message || e).slice(0, 300), what: sc.what };
        console.log(`  ${tag} ${sc.name}  FAILED TO CAPTURE: ${String(e.message || e).slice(0, 160)}`);
      }
    }
    res.blocked = await b.ev("return (window.__blocked||[]).length").catch(() => -1);
    // Pixel diffs, in this same Chrome on a blank page.
    await b.send("Page.navigate", { url: "about:blank" });
    await sleep(800);
    for (const [name, s] of Object.entries(res.screens)) {
      const basef = join(BASE_DIR, tag, `${name}.jpg`);
      if (!s.jpg || !existsSync(basef)) continue;
      const a = readFileSync(basef).toString("base64"), c = readFileSync(s.jpg).toString("base64");
      const out = JSON.parse(await b.ev(`${DIFF_JS}; return JSON.stringify(await diff('data:image/jpeg;base64,${a}', 'data:image/jpeg;base64,${c}'));`));
      s.diff = out.ratio;
      s.diffBox = out.box;
      if (out.img) { const f = join(dir, `${name}.diff.jpg`); writeFileSync(f, Buffer.from(out.img.split(",")[1], "base64")); s.diffImg = f; }
    }
  } catch (e) {
    res.screens.setup = { error: String(e.message || e).slice(0, 300), what: "Open ComfyUI, load the workflow, App mode" };
    console.log(`  ${tag} SETUP FAILED: ${String(e.message || e).slice(0, 160)}`);
  } finally {
    res.console = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !noise(l));
    b.close();
  }
  return res;
}

// In the page: scale both to 640 wide (averages away JPEG noise), count pixels whose largest channel moved > 32.
const DIFF_JS = `async function diff(a, c) {
  const load = (u) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = u; });
  const [A, C] = await Promise.all([load(a), load(c)]);
  const w = 640, h = Math.round(640 * A.height / A.width);
  const px = (img) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h); return g.getImageData(0, 0, w, h); };
  const da = px(A), dc = px(C);
  const out = document.createElement('canvas'); out.width = w; out.height = h; const g = out.getContext('2d'); const od = g.createImageData(w, h);
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    const k = i * 4, d = Math.max(Math.abs(da.data[k] - dc.data[k]), Math.abs(da.data[k+1] - dc.data[k+1]), Math.abs(da.data[k+2] - dc.data[k+2]));
    const grey = (dc.data[k] + dc.data[k+1] + dc.data[k+2]) / 3 * 0.45;
    if (d > 32) { n++; od.data[k] = 255; od.data[k+1] = 40; od.data[k+2] = 40; const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    else { od.data[k] = od.data[k+1] = od.data[k+2] = grey; }
    od.data[k+3] = 255;
  }
  g.putImageData(od, 0, 0);
  const ratio = n / (w * h);
  return { ratio, box: x1 < 0 ? null : [x0, y0, x1, y1].map((v) => Math.round(v * 2)), img: n ? out.toDataURL('image/jpeg', 0.7) : null };
}`;

/** New layout problems against the baseline metrics (things that were not there before). */
export function layoutRegressions(now, base) {
  const out = [];
  if (!now) return out;
  if (now.pageScroll && !base?.pageScroll) out.push(`the page now scrolls (scrollHeight ${now.pageScrollH})`);
  if (now.pageOverflowX && !base?.pageOverflowX) out.push("the page now scrolls sideways");
  const was = new Set((base?.clipped || []).map((c) => c.text));
  const cut = (now.clipped || []).filter((c) => !c.ellipsis && !was.has(c.text));
  if (cut.length) out.push(`newly clipped text: ${cut.slice(0, 5).map((c) => `"${c.text}"`).join(", ")}`);
  const ovWas = new Set((base?.overlaps || []).map((o) => o.a + "|" + o.b));
  const ov = (now.overlaps || []).filter((o) => !ovWas.has(o.a + "|" + o.b));
  if (ov.length) out.push(`new overlapping panels: ${ov.slice(0, 3).map((o) => `${o.a.trim()} × ${o.b.trim()}`).join("; ")}`);
  const offWas = new Set(base?.offscreen || []);
  const off = (now.offscreen || []).filter((t) => !offWas.has(t));
  if (off.length) out.push(`buttons cut by the window edge: ${off.slice(0, 4).join(", ")}`);
  return out;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`Soundstage visual check → ${OUT}${UPDATE ? "  (updating baselines)" : ""}`);
  const queue = SIZES.map((s, i) => [s, PORT + i]);
  const results = [];
  const worker = async () => { while (queue.length) { const [s, p] = queue.shift(); results.push(await captureSize(s, p)); } };
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, worker));
  results.sort((a, c) => a.size.localeCompare(c.size, undefined, { numeric: true }));

  const rows = [];
  let fails = 0;
  for (const r of results) {
    const bdir = join(BASE_DIR, r.size);
    const bm = existsSync(join(bdir, "metrics.json")) ? JSON.parse(readFileSync(join(bdir, "metrics.json"), "utf8")) : {};
    for (const [name, s] of Object.entries(r.screens)) {
      const notes = [];
      let status;
      if (s.error) { status = "ERROR"; notes.push(s.error); }
      else {
        const lay = UPDATE ? [] : layoutRegressions(s.metrics, bm[name]);
        const newErr = UPDATE ? [] : s.errors.filter((e) => !(bm[name]?.errors || []).some((x) => x.slice(0, 80) === e.slice(0, 80)));
        if (s.diff == null) status = UPDATE ? "BASELINE" : "NEW";
        else status = s.diff > THRESH ? "CHANGED" : "PASS";
        if (lay.length || newErr.length) status = status === "PASS" ? "LAYOUT" : status;
        notes.push(...lay, ...newErr.map((e) => "console: " + e.slice(0, 160)));
        if (s.metrics?.pageScroll) notes.push("page scrolls");
        const hard = (s.metrics?.clipped || []).filter((c) => !c.ellipsis);
        if (hard.length) notes.push(`${hard.length} clipped text`);
        if (s.metrics?.overlaps?.length) notes.push(`${s.metrics.overlaps.length} panel overlap(s)`);
      }
      if (!UPDATE && ["CHANGED", "LAYOUT", "ERROR"].includes(status)) fails++;
      rows.push({ size: r.size, screen: name, what: s.what, status, diff: s.diff, diffBox: s.diffBox, notes, jpg: s.jpg, diffImg: s.diffImg, metrics: s.metrics, errors: s.errors });
    }
    if (UPDATE) {
      mkdirSync(bdir, { recursive: true });
      const m = {};
      for (const [name, s] of Object.entries(r.screens)) {
        if (!s.jpg) continue;
        writeFileSync(join(bdir, `${name}.jpg`), readFileSync(s.jpg));
        m[name] = { ...s.metrics, errors: s.errors };
      }
      // Keep the screens this run did not capture (--only).
      writeFileSync(join(bdir, "metrics.json"), JSON.stringify({ ...bm, ...m }, null, 1));
    }
  }
  const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);
  const md = [`# Soundstage visual check · ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT`, "",
    `Threshold ${pct(THRESH)} of pixels changed. ${UPDATE ? "Baselines updated from this run." : `${fails} failing screen(s).`}`, "",
    "| Size | Screen | Status | Pixels changed | Notes |", "|---|---|---|---|---|",
    ...rows.map((x) => `| ${x.size} | ${x.screen} | ${x.status} | ${pct(x.diff)} | ${x.notes.join("; ").replace(/\|/g, "/")} |`), "",
    "## Console errors (Soundstage, not ComfyUI noise)", "",
    ...results.map((r) => `- ${r.size}: ${r.console.length ? r.console.length + "\n" + r.console.slice(0, 15).map((l) => "  - `" + l.slice(0, 220).replace(/`/g, "'") + "`").join("\n") : "none"}`), "",
    `Blocked server writes (the guard working): ${results.map((r) => `${r.size} ${r.blocked}`).join(", ")}`];
  writeFileSync(join(OUT, "report.md"), md.join("\n"));
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ when: new Date().toISOString(), threshold: THRESH, update: UPDATE, rows, setup: results.map((r) => [r.size, r.setup]), console: results.map((r) => [r.size, r.console]) }, null, 1));
  console.log(md.slice(4, 6 + rows.length).join("\n"));
  console.log(`\nReport: ${join(OUT, "report.md")}`);
  process.exit(fails ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
