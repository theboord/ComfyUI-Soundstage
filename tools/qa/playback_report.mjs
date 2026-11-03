// Soundstage QA: the playback bench's table. Reads every run summary (<label>.json written by playback_bench.mjs) in a
// folder and prints one markdown row per run, so a fix can be compared with the baseline run for run.
//
//   node tools/qa/playback_report.mjs <runs dir> [--json all_runs.json]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const f1 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(1));
const f0 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : Math.round(x).toString());

/** Run summaries in `dir` (files with a label and a dropped count), in a stable order. */
export function loadRuns(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".summary.json")) continue;
    try { const s = JSON.parse(readFileSync(join(dir, f), "utf8")); if (s && s.label && "dropped" in s) out.push(s); } catch { /* not a summary */ }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export const HEADER = ["run", "profile", "network", "mode", "dropped/min", "lost at cuts / mid-clip", "vPQ dropped/total", "waiting", "seeks in play",
  "A/V median / p95 / max ms", "worst cut hitch ms (first picture ms)", "first frame ms", "GPU % (NVDEC %)"];

/** Worst hitch to an in-sync picture, then (worst wait for any picture of the incoming clip); "never in sync" counts clips
 *  that never got within a frame of the timeline. */
function hitchCell(h) {
  const pic = (h.list || []).reduce((m, x) => Math.max(m, x.firstPicMs ?? 0), 0);
  return `${f0(h.worstMs)} (${f0(pic)})` + (h.censored ? `, ${h.censored} never in sync` : "");
}

/** One markdown row per run. */
export function tableRows(runs) {
  return runs.map((s) => {
    const prof = s.profile + (s.cores ? `+cores ${s.cores}` : "") + (s.throttle ? ` (x${s.throttle})` : "");
    const g = s.checks?.gpu;
    return [s.label, prof, s.network, s.mode, f1(s.droppedPerMin), `${s.lostAtCuts} / ${s.lostMidClip}`, `${s.quality.dropped}/${s.quality.total}`, s.waiting, s.seeksDuringPlay,
      `${f1(s.av.medianMs)} / ${f1(s.av.p95AbsMs)} / ${f1(s.av.maxAbsMs)}`, hitchCell(s.hitch), f0(s.firstFrameMs),
      g && g.samples ? `${f0(g.gpu.mean)} (${f0(g.decoder.mean)})` : "n/a"];
  });
}

export function markdown(runs) {
  const rows = tableRows(runs);
  return [`| ${HEADER.join(" | ")} |`, `|${HEADER.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node tools/qa/playback_report.mjs <runs dir> [--json out.json]"); process.exit(2); }
  const runs = loadRuns(dir);
  console.log(markdown(runs));
  const i = process.argv.indexOf("--json");
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], JSON.stringify(runs, null, 1));
}
