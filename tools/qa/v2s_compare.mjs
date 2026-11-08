// "Identical?" and Video → 3D intake, checked headless in a real Chrome on the real stage (no pod, no GPU jobs).
//   node tools/qa/v2s_compare.mjs --data <dir with clips/<clip>/{recon_result.json, source.mp4, takes/}> --clip syn_interior
//        [--sizes 1440x900,1280x800] [--port 8798] [--cdp 9653] [--out share/Video3D_Boost/v2s-match/qa]
// Checks (exit 1 on any failure):
//   - the compare bar (Overlay / Wipe / Onion / Off, solve chip, Match) and its object list need no scrolling and stay
//     inside the view;
//   - Fit to plate wins back >= 0.15 IoU on a displaced object in < 3 s, and Undo puts it back;
//   - the one-screen chooser (closed and with Advanced open), the progress card (server steps, queue, ETA, Cancel) and
//     the flaws-first result card need no scrolling;
//   - no 'DA3' or 'custom' names in the outliner; the set scan is out of look-at lists (look_at:false).
// Screenshots of each state go to --out.
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

process.env.SS_ANGLE ||= "metal";
const { launch, sleep } = await import("./lib.mjs");
const { serve } = await import("../v2s_bench/harness/serve.mjs");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const data = resolve(opt("--data", join(REPO, "tools/v2s_bench/out")));
const clip = opt("--clip", "syn_interior");
const sizes = opt("--sizes", "1440x900,1280x800").split(",").map((s) => s.split("x").map(Number));
const port = +opt("--port", 8798), cdp = +opt("--cdp", 9653);
const out = resolve(opt("--out", join(REPO, "..", "share", "Video3D_Boost", "v2s-match", "qa")));
mkdirSync(out, { recursive: true });
const srv = await serve({ root: REPO, data, takes: join(data, "clips", clip, "takes"), port });
const report = { clip, sizes: {}, failures: [] };
const fail = (size, what, v) => { report.failures.push(`${size}: ${what}`); console.log(`FAIL ${size}: ${what}`, JSON.stringify(v).slice(0, 400)); };
try {
  for (const [w, h] of sizes) {
    const tag = `${w}x${h}`;
    const b = await launch({ port: cdp, w, h, angle: process.env.SS_ANGLE });
    const R = (report.sizes[tag] = {});
    try {
      await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/tools/qa/v2s_compare.html?t=${Date.now()}` });
      for (let i = 0; i < 60 && (await b.ev("return window.__v2c?.state").catch(() => null)) !== "loaded"; i++) await sleep(500);
      R.init = await b.ev(`return await window.__v2c.init(${JSON.stringify(`clips/${clip}/recon_result.json`)}, ${JSON.stringify(`clips/${clip}/source.mp4`)})`);
      for (const m of ["wipe", "overlay", "onion"]) { await b.ev(`return await window.__v2c.mode("${m}")`); await b.shot(join(out, `${tag}_compare_${m}.jpg`), { jpeg: { quality: 70 } }); }
      R.bar = await b.ev("return window.__v2c.bar()");
      if (!R.bar.noScroll || !R.bar.inView) fail(tag, "compare bar scrolls or leaves the view", R.bar);
      await b.ev(`return await window.__v2c.mode("off")`);
      R.fit = await b.ev("return await window.__v2c.fitTest()");
      await b.shot(join(out, `${tag}_fit_after.jpg`), { jpeg: { quality: 70 } });
      if (!(R.fit.gain >= 0.15)) fail(tag, `Fit to plate gained ${R.fit.gain?.toFixed?.(3)} IoU (< 0.15)`, R.fit);
      if (!(R.fit.ms < 3000)) fail(tag, `Fit to plate took ${R.fit.ms} ms (>= 3 s)`, R.fit);
      if (!R.fit.undo) fail(tag, "Undo did not put the fitted object back", R.fit);
      if (!R.fit.list_noScroll) fail(tag, "match list scrolls", R.fit);
      R.names = await b.ev("return window.__v2c.names()");
      if (R.names.bad.length) fail(tag, "DA3 / custom names in the outliner", R.names.bad);
      if (R.names.scanLookAt.some((x) => x !== false)) fail(tag, "set scan not excluded from look-at", R.names);
      R.chooser = await b.ev(`return await window.__v2c.chooser(${JSON.stringify(`clips/${clip}/source.mp4`)})`);
      await b.shot(join(out, `${tag}_chooser_advanced.jpg`), { jpeg: { quality: 70 } });
      for (const k of ["closed", "open"]) if (!R.chooser[k].noScroll || !R.chooser[k].inView) fail(tag, `chooser (${k}) scrolls or leaves the view`, R.chooser[k]);
      R.choice = await b.ev("return await window.__v2c.chooserPick()");
      if (R.choice?.use !== "stage" || R.choice.options.samples !== 64 || R.choice.options.mode !== "add") fail(tag, "chooser did not send its options", R.choice);
      R.progress = await b.ev("return window.__v2c.jobProgress()");
      await b.shot(join(out, `${tag}_progress.jpg`), { jpeg: { quality: 70 } });
      if (!R.progress.noScroll || !R.progress.inView) fail(tag, "progress card scrolls", R.progress);
      if (!/3 jobs ahead/.test(R.progress.text) || !/Cancel/.test(R.progress.text) || !/left \(from this server/.test(R.progress.text)) fail(tag, "progress card misses queue / ETA / Cancel", R.progress.text);
      R.result = await b.ev("return window.__v2c.jobResult()");
      await b.shot(join(out, `${tag}_result.jpg`), { jpeg: { quality: 70 } });
      if (!R.result.noScroll || !R.result.inView) fail(tag, "result card scrolls", R.result);
      if (!R.result.firstIsRed || !R.result.fixButton || R.result.lockedOff) fail(tag, "result card does not lead with the red flaw and its fix", R.result);
      R.errors = (await b.ev("return window.__v2c.errors")).filter((e) => !/ResizeObserver/.test(e));
      R.console = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !/favicon|ResizeObserver/.test(l)).slice(-8);
      if (R.errors.length || R.console.length) fail(tag, "page errors", [...R.errors, ...R.console]);
    } catch (e) {
      fail(tag, `crashed: ${e.message}`, b.logs.slice(-10));
    } finally { await b.close(); }
  }
} finally { srv.close(); }
writeFileSync(join(out, `report_${clip}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, (k, v) => (k === "text" ? undefined : v), 1).slice(0, 4000));
process.exit(report.failures.length ? 1 : 0);
