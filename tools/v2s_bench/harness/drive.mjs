// Run stage-probe jobs in a hidden Chrome (real GPU: SS_ANGLE=metal by default here).
//   node tools/v2s_bench/harness/drive.mjs --data <bench data dir> [--takes <dir>] [--port 8795] [--cdp 9681] <job.json> ...
// Each job path is relative to --data. The page imports the repo's own web/stage modules, so what it measures and renders
// is what the App shows. It only GETs from ComfyUI (mocap takes via /view); it never queues or uploads anything.
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

process.env.SS_ANGLE ||= "metal";
const { launch, sleep } = await import("../../qa/lib.mjs");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const data = resolve(opt("--data", join(REPO, "tools/v2s_bench/out")));
const takes = opt("--takes", null);
const port = +opt("--port", 8795);
const cdp = +opt("--cdp", 9681);
const jobs = args;
if (!jobs.length) { console.error("no jobs"); process.exit(2); }

const srv = await serve({ root: REPO, data, takes: takes ? resolve(takes) : null, port });
const b = await launch({ port: cdp, w: 1100, h: 700, angle: process.env.SS_ANGLE });
let failed = 0;
try {
  for (const job of jobs) {
    const t0 = Date.now();
    await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/tools/v2s_bench/harness/probe.html?job=${encodeURIComponent(job)}&t=${t0}` });
    let s = null, last = "";
    for (let i = 0; i < 3600; i++) {
      await sleep(1000);
      try { s = await Promise.race([b.ev("return window.__probe ? JSON.parse(JSON.stringify(window.__probe)) : null"), sleep(5000).then(() => null)]); } catch { s = null; }
      if (!s) continue;
      const line = `${job}: ${s.state} ${s.f}/${s.n}`;
      if (line !== last && (s.f % 20 === 0 || s.state !== "running")) { console.log(line, `${Math.round((Date.now() - t0) / 1000)} s`); last = line; }
      if (s.state === "done" || s.state === "error") break;
    }
    if (!s || s.state !== "done") { failed++; console.log(`FAILED ${job}:`, JSON.stringify(s?.errors || []).slice(0, 2000)); }
    else if (s.errors?.length) console.log(`  page errors: ${JSON.stringify(s.errors).slice(0, 800)}`);
    const logs = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !/favicon/.test(l));
    if (logs.length) console.log("  console:", logs.slice(-6).join("\n  "));
    b.logs.length = 0;
  }
} finally {
  await b.close();
  srv.close();
}
process.exit(failed ? 1 : 0);
