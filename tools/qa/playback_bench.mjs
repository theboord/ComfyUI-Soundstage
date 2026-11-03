// Soundstage QA: real-time playback bench for the Cut editor (Directive 8).
//
// Plays a whole cut at 1x through the Cut panel's own play path (web/cut/demo.html + cut.mjs, served as committed by
// tools/qa/playback_server.mjs) in a Chrome driven over the DevTools protocol (tools/qa/lib.mjs), and measures what
// reached the viewer, tick by tick, against what the timeline asked for:
//   - dropped frames per minute (tools/qa/playback_metrics.mjs countDrops: frames that never reached the screen, and
//     pictures held past their cadence), getVideoPlaybackQuality per <video>, 'waiting' / 'stalled' events, and every
//     currentTime assignment (seek) made during playback;
//   - A/V offset: the picture on screen vs the record position the WebAudio output is playing at that instant;
//   - the hitch at each edit point; time to first frame; seek latency for scrubs and J / K / L.
// Which source frame was drawn: the probe wraps CanvasRenderingContext2D.drawImage on the viewer's picture canvas and,
// right after a <video> is drawn, reads that element's current frame timestamp with new VideoFrame(video) (WebCodecs),
// the same frame drawImage painted. requestVideoFrameCallback logs every frame each element presented, as a cross-check.
//
//   node tools/qa/playback_bench.mjs --project <fixture.json> --out <dir> [--profile desktop|laptop-sim|stress]
//        [--local-media <dir>[,<dir>]] [--bench-media <dir>] [--runs 2] [--headful] [--label name] [--no-jkl]
//        [--port 8790] [--cdp 9780] [--pod http://127.0.0.1:8189] [--cores <hex affinity mask>]
//   node tools/qa/playback_bench.mjs --reanalyse <dir>/<label>.raw.json.gz [--write <label>.json]   # recompute a run's numbers
//   node tools/qa/playback_report.mjs <dir>                                                         # one table row per run
//
// Profiles: desktop = ANGLE d3d11 on the GPU, hardware video decode. laptop-sim = the same plus
// --disable-accelerated-video-decode and CDP CPU throttling x4 (the "normal laptop" target). stress = laptop-sim at x20.
// CDP CPU throttling slows the renderer's main thread; the software decoder's threads are not throttled (use --cores to
// pin Chrome to fewer, slower cores as well). Chrome runs with --disable-audio-output: a fake audio sink that consumes
// audio in real time, so WebAudio's clock runs without making a sound (and on machines whose default output device
// never clocks, as on the rig this was written on, the Cut would otherwise fall back to the wall clock).
//
// Safety: the page's fetches pass lib.mjs's guard; the server proxies only GET /view to the pod; nothing is POSTed.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { launch, sleep } from "./lib.mjs";
import { startServer } from "./playback_server.mjs";
import * as M from "./playback_metrics.mjs";
import * as TL from "../../web/cut/timeline.mjs";

export const PROFILES = {
  desktop: { angle: "d3d11", flags: [], throttle: 1, note: "GPU (ANGLE d3d11), hardware video decode" },
  "laptop-sim": { angle: "d3d11", flags: ["--disable-accelerated-video-decode"], throttle: 4, note: "software video decode, CPU throttle x4 (main thread)" },
  stress: { angle: "d3d11", flags: ["--disable-accelerated-video-decode"], throttle: 20, note: "software video decode, CPU throttle x20 (main thread)" },
};

/** Runs in the page before any of its scripts (Page.addScriptToEvaluateOnNewDocument). */
export const PROBE = String.raw`(() => {
  if (window.__pb) return;
  const now = () => performance.now();
  const P = window.__pb = { vids: [], ev: [], ct: [], plays: [], ticks: [], keys: [], seeks: [], longtasks: [], phase: "load", pctx: null, vfErr: 0, vfOk: 0 };
  const track = (v) => {
    if (v.__pb != null) return;
    const id = P.vids.length;
    Object.defineProperty(v, "__pb", { value: id });
    const r = { id, url: "", n: {}, rvfc: [], q: [] };
    Object.defineProperty(r, "el", { value: v });
    P.vids.push(r);
    for (const e of ["waiting", "stalled", "seeking", "seeked", "playing", "pause", "play", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "error", "emptied", "ended", "ratechange"]) {
      v.addEventListener(e, () => { r.n[P.phase + ":" + e] = (r.n[P.phase + ":" + e] || 0) + 1; P.ev.push([now(), id, e, v.currentTime, P.phase]); });
    }
    const cb = (t, md) => { r.rvfc.push([t, md.mediaTime, md.presentedFrames, md.expectedDisplayTime, md.processingDuration == null ? null : md.processingDuration, P.phase]); v.requestVideoFrameCallback(cb); };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(cb);
  };
  const oc = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, opts) { const el = oc.call(this, tag, opts); if (String(tag).toLowerCase() === "video") track(el); return el; };
  const sd = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get: sd.get, set(x) {
    if (this.__pb != null) { const r = P.vids[this.__pb]; if (!r.url && x && !String(x).startsWith("blob:")) r.url = String(x); if (x && !String(x).startsWith("blob:")) r.cur = String(x); if (String(x).startsWith("blob:")) r.blob = 1; }
    return sd.set.call(this, x); } });
  const cd = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", { configurable: true, get: cd.get, set(x) {
    const p = window.cutPanel;
    P.ct.push([now(), this.__pb == null ? -1 : this.__pb, x, cd.get.call(this), P.phase, p ? p.speed : 0, p && p._activeVideo === this ? 1 : 0, this.paused ? 1 : 0]);
    return cd.set.call(this, x); } });
  const op = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { P.plays.push([now(), this.__pb == null ? -1 : this.__pb, P.phase]); return op.call(this); };
  const od = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (src, ...a) {
    const res = od.call(this, src, ...a);
    if (this === P.pctx) {
      if (src instanceof HTMLVideoElement) {
        let ts = null;
        try { const vf = new VideoFrame(src); ts = vf.timestamp; vf.close(); P.vfOk++; } catch (e) { P.vfErr++; }
        P.last = ["v", src.__pb == null ? -1 : src.__pb, ts, src.currentTime, src.readyState, null, null, src.__pb == null ? null : P.vids[src.__pb].cur || null];
      } else if (src instanceof HTMLCanvasElement && P.clay) P.last = ["c", -1, null, null, null, P.clay[0], P.clay[1]];
      else P.last = ["o", -1, null, null, null, null, null];
    }
    return res;
  };
  addEventListener("keydown", (e) => P.keys.push([e.timeStamp, e.key, P.phase]), true);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration, P.phase]); }).observe({ type: "longtask", buffered: true }); } catch {}
  P.seek = (f) => { P.seeks.push([now(), f, P.phase]); window.cutPanel.seek(f); };
  P.quality = () => P.vids.map((r) => { const q = r.el.getVideoPlaybackQuality(); return [r.id, q.totalVideoFrames, q.droppedVideoFrames, q.corruptedVideoFrames || 0]; });
  const install = (p) => {
    P.pctx = p.pctx;
    const tick = p._tick.bind(p), clay = p._clay.bind(p);
    p._clay = (shot, f) => { P.clay = [shot.id, f]; return clay(shot, f); };
    p._tick = (t) => {
      const s = now();
      P.last = null; P.clay = null;
      tick(t);
      const ac = p._ac, ck = p._aClock;
      let au = null;
      if (ac && ck) { const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : {}; au = [ac.currentTime, ts.contextTime ?? null, ts.performanceTime ?? null, ck.t0, ck.from, ck.stuck ? 1 : 0, ac.state === "running" ? 1 : 0]; }
      P.ticks.push([t, s, now(), p.frame, p.speed, P.last, au, P.phase]);
    };
  };
  const wait = () => { if (window.cutPanel && window.cutPanel._tick) install(window.cutPanel); else requestAnimationFrame(wait); };
  requestAnimationFrame(wait);
})();`;

/** The cut's rows for the metrics: TL.layout plus the picture key each row plays (best loaded rung, else clay). */
export function rowsOf(project) {
  const p = TL.normalizeProject(project);
  return TL.layout(p).map((r) => {
    const rd = r.shot?.renders || {};
    return { index: r.index, recIn: r.recIn, recOut: r.recOut, in: r.in, key: rd.final || rd.draft || "clay:" + r.shot?.id, rung: rd.final ? "final" : rd.draft ? "draft" : "clay", shot: r.shot?.id };
  });
}

/** A drawn element's URL as the take it shows: /soundstage/proxy?...&w=N is that take's /view URL. */
export function takeOf(u) {
  if (!u) return null;
  const m = /^(.*?)soundstage\/proxy\?(.*)$/.exec(u);
  if (!m) return u;
  const q = new URLSearchParams(m[2]);
  for (const k of ["w", "probe", "v"]) q.delete(k);
  return `${m[1]}view?${q}`;
}

/** Turn the probe's raw tick log into metric ticks ({t, tl, draw, au, speed, phase}). */
export function ticksOf(raw, fps) {
  const urlOf = new Map(raw.vids.map((v) => [v.id, v.url]));
  return raw.ticks.map(([t, run, , frame, speed, last, au, phase]) => {
    let draw = null;
    if (last && last[0] === "v") {
      const ts = last[2];
      // the take the element plays at this draw (a pooled element is re-pointed at other takes; a proxy maps back to its take)
      draw = { key: takeOf(last[7]) || urlOf.get(last[1]) || "video:" + last[1], vid: last[1], src: ts != null ? Math.round((ts / 1e6) * fps) : Math.round(last[3] * fps - 0.5), exact: ts != null };
    } else if (last && last[0] === "c") draw = { key: "clay:" + last[5], src: last[6], exact: true };
    else if (last) draw = { key: "other", src: -1, exact: false };
    return { t, run, tl: Math.floor(frame + 1e-6), frame, speed, phase, draw,
      au: au ? { now: au[0], ctx: au[1], perf: au[2], t0: au[3], from: au[4], stuck: !!au[5], running: !!au[6] && !au[5] && au[2] > 0 } : null };
  });
}

function startGpuLog() {
  const rows = [];
  let p = null;
  try {
    p = spawn("nvidia-smi", ["--query-gpu=utilization.gpu,utilization.decoder,utilization.encoder", "--format=csv,noheader,nounits", "-lms", "500"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const v = l.split(",").map((x) => Number(x.trim())); if (v.length === 3 && v.every(Number.isFinite)) rows.push([Date.now(), ...v]); } });
    p.on("error", () => {});
  } catch { /* no nvidia-smi */ }
  return { rows, stop: () => { try { p?.kill(); } catch {} } };
}

const gpuSummary = (rows, a, b) => {
  const r = rows.filter((x) => x[0] >= a && x[0] <= b);
  return { samples: r.length, gpu: M.stats(r.map((x) => x[1])), decoder: M.stats(r.map((x) => x[2])) };
};

/** Windows: pin this bench's Chrome (found by its DevTools port) and the processes it started to `mask` (hex string).
 *  Processes Chrome starts later (the page's renderer) inherit the browser process's affinity. */
async function setAffinity(cdpPort, mask) {
  const ps = `$m=[IntPtr]${Number(mask)}; $b=Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${cdpPort}( |$)' };
    foreach($p in $b){ $ids=@($p.ProcessId) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.ProcessId)" | ForEach-Object { $_.ProcessId });
      foreach($i in $ids){ try { (Get-Process -Id $i).ProcessorAffinity=$m } catch {} } }`;
  await new Promise((r) => spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" }).on("exit", r).on("error", r));
}

/** One run: open the cut, wait for its media, play it through at 1x, then scrub and J / K / L. Returns {raw, summary}. */
export async function runOnce(opts) {
  const { project, profile = "desktop", localMedia = [], benchMedia = null, headful = false, port = 8790, cdp = 9780, pod, logDir, label, jkl = true, cores = null } = opts;
  const prof = PROFILES[profile];
  if (!prof) throw new Error(`unknown profile ${profile}`);
  const fixture = JSON.parse(readFileSync(project, "utf8"));
  const fps = fixture.fps || 24;
  const rows = rowsOf(fixture);
  const total = rows.length ? rows[rows.length - 1].recOut : 0;
  mkdirSync(logDir, { recursive: true });
  const srv = await startServer({ port, project, pod, localMedia, benchMedia, logFile: join(logDir, `${label}.requests.jsonl`) });
  const gpu = startGpuLog();
  const flags = ["--disable-audio-output", "--autoplay-policy=no-user-gesture-required", ...prof.flags, ...(headful ? ["--window-position=-2400,0"] : [])];
  const b = await launch({ port: cdp, w: 1440, h: 900, angle: prof.angle, headless: !headful, extraFlags: flags });
  const marks = {};
  try {
    if (cores && process.platform === "win32") await setAffinity(cdp, cores);
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    await b.send("Performance.enable", { timeDomain: "timeTicks" });
    if (prof.throttle > 1) await b.send("Emulation.setCPUThrottlingRate", { rate: prof.throttle });
    marks.navWall = Date.now();
    await b.send("Page.navigate", { url: `http://127.0.0.1:${srv.port}/cut/demo.html?bench=${encodeURIComponent(label)}` });
    // Wait for the panel and for every <video> to have data to play (HAVE_FUTURE_DATA), at most 90 s.
    let ready = null;
    for (let i = 0; i < 360; i++) {
      await sleep(250);
      let st;
      try { st = await Promise.race([b.ev(`const p = window.cutPanel; if (!p || !window.__pb) return null;
        const vs = [...p.media.values()].filter((m) => m.kind === "video");
        return { n: vs.length, ok: vs.filter((m) => m.ok === true).length, bad: vs.filter((m) => m.ok === false).length, rs: vs.map((m) => m.el.readyState), t: performance.now() };`), sleep(5000).then(() => null)]); } catch { st = null; }
      if (st && st.n && st.rs.every((r) => r >= 3)) { ready = st; break; }
      if (st && st.bad) { ready = st; break; }
    }
    marks.readyWall = Date.now();
    await sleep(1000);
    const perf0 = (await b.send("Performance.getMetrics")).result?.metrics || [];
    const quality0 = await b.ev("return window.__pb.quality()");
    // Play the whole cut from the head: Space on the focused panel (a real key press, as a person would).
    await b.ev(`window.cutPanel.stop(); window.cutPanel.seek(0); window.__pb.phase = "play"; window.cutPanel.root.focus({ preventScroll: true }); return 1`);
    await sleep(600);
    marks.playWall = Date.now();
    await b.key(" ");
    const limit = Date.now() + ((total / fps) * 1000 + 30000) * Math.max(1, prof.throttle / 4);
    await sleep(2000);
    while (Date.now() < limit) {
      const sp = await Promise.race([b.ev("return window.cutPanel.speed"), sleep(4000).then(() => null)]).catch(() => null);
      if (sp === 0) break;
      await sleep(500);
    }
    marks.endWall = Date.now();
    const perf1 = (await b.send("Performance.getMetrics")).result?.metrics || [];
    const quality = await b.ev("return window.__pb.quality()");
    // Scrubs: six clicks on the timeline (the panel's seek), into different clips, deep into each take's GOP.
    await b.ev(`window.__pb.phase = "scrub"; return 1`);
    const vidRows = rows.filter((r) => !r.key.startsWith("clay:"));
    const scrubTo = [3, 6, 9, 12, 15, 2].map((i) => rows[Math.min(i, rows.length - 1)]).map((r) => r.recIn + Math.floor((r.recOut - r.recIn) / 2));
    for (const f of scrubTo) { await b.ev(`window.__pb.seek(${f}); return 1`); await sleep(2500 * Math.max(1, prof.throttle / 8)); }
    // J / K / L from the middle of a rendered clip.
    if (jkl && vidRows.length) {
      await b.ev(`window.__pb.phase = "jkl"; window.cutPanel.root.focus({ preventScroll: true }); return 1`);
      const r = vidRows[Math.min(4, vidRows.length - 1)];
      await b.ev(`window.__pb.seek(${r.recIn + 10}); return 1`);
      await sleep(2500);
      for (const [k, ms] of [["l", 2000], ["l", 1500], ["k", 1500], ["j", 2000], ["k", 1500]]) { await b.key(k); await sleep(ms); }
    }
    await b.ev(`window.__pb.phase = "done"; return 1`);
    const raw = JSON.parse(await b.ev(`const P = window.__pb, p = window.cutPanel;
      return JSON.stringify({ vids: P.vids, ev: P.ev, ct: P.ct, plays: P.plays, ticks: P.ticks, keys: P.keys, seeks: P.seeks, longtasks: P.longtasks,
        vfOk: P.vfOk, vfErr: P.vfErr, ua: navigator.userAgent, timeOrigin: performance.timeOrigin,
        media: [...p.media.entries()].map(([u, m]) => ({ url: u, kind: m.kind, ok: m.ok, blob: !!m.blob, rs: m.el.readyState, w: m.el.videoWidth, h: m.el.videoHeight, id: m.el.__pb })),
        audio: [...p.abufs.entries()].map(([u, a]) => ({ url: u, state: a.state, error: a.error })), ac: p._ac ? { state: p._ac.state, base: p._ac.baseLatency, out: p._ac.outputLatency } : null });`));
    raw.quality = quality;
    raw.quality0 = quality0;
    raw.perf = { before: Object.fromEntries(perf0.map((m) => [m.name, m.value])), after: Object.fromEntries(perf1.map((m) => [m.name, m.value])) };
    raw.marks = marks;
    raw.ready = ready;
    raw.logs = b.logs.slice(0, 200);
    raw.gpu = gpu.rows;
    raw.server = { ...srv.stats };
    raw.meta = { profile, label, local: localMedia.length > 0, headful, throttle: prof.throttle, cores, flags, fps, project: resolve(project) };
    const summary = analyse(raw, { fixture, rows, fps, profile, label, local: localMedia.length > 0, headful, throttle: prof.throttle });
    return { raw, summary };
  } finally {
    gpu.stop();
    b.close();
    await srv.close();
  }
}

/** Everything the bench reports for one run, from the raw probe log. */
export function analyse(raw, { rows, fps, profile, label, local, headful, throttle }) {
  const ticks = ticksOf(raw, fps);
  const seqAll = M.screenTimeline(ticks, rows);
  const playKey = raw.keys.find((k) => k[2] === "play" && k[1] === " ");
  const tPlay = playKey ? playKey[0] : null;
  const inPlay = seqAll.filter((s, i) => ticks[i].phase === "play" && ticks[i].speed === 1 && (tPlay == null || s.t >= tPlay));
  const total = rows.length ? rows[rows.length - 1].recOut : 0;
  const lastTl = inPlay.length ? inPlay[inPlay.length - 1].tl : 0;
  // The frame play started on was already up (paused) when the key went down: the count starts on the next one.
  const from = inPlay.length ? inPlay[0].tl + 1 : 0, to = Math.min(total, lastTl + 1);
  const vsync = M.vsyncOf(inPlay);
  const drops = M.countDrops(inPlay, rows, { fps, vsync, from, to });
  const played = to - from;
  const editSet = rows.slice(1).map((r) => r.recIn);
  const nearCut = (F) => editSet.some((e) => F >= e - 2 && F < e + 6);
  const lostAtCut = drops.lostFrames.filter(nearCut).length;
  const av = M.avOffsets(inPlay, rows, { fps, presentMs: vsync, startT: tPlay ?? undefined });
  const avS = M.stats(av);
  const avAbs = M.stats(av.map(Math.abs));
  const hitches = M.cutHitches(inPlay, rows, { from, to });
  const hS = M.stats(hitches.map((h) => h.hitchMs));
  // Time to first frame: navigation -> the first tick showing the head of the cut (rAF times are ms since navigation).
  const head = M.expectedAt(rows, 0);
  const first = seqAll.find((s) => s.shown && head && s.shown.key === head.key && s.shown.src === head.src);
  const playStart = tPlay != null ? M.reactionMs(seqAll, rows, tPlay, (rec) => rec != null && rec > from) : null;
  // Seeks while playing: every currentTime assignment between the play key and the end of play.
  const tEnd = inPlay.length ? inPlay[inPlay.length - 1].t : Infinity;
  const ctPlay = raw.ct.filter((c) => c[4] === "play" && c[0] >= (tPlay ?? 0) && c[0] <= tEnd);
  const ev = (name) => raw.ev.filter((e) => e[4] === "play" && e[2] === name && e[0] >= (tPlay ?? 0) && e[0] <= tEnd).length;
  const q0 = new Map((raw.quality0 || []).map((q) => [q[0], q]));
  const qual = (raw.quality || []).map(([id, tot, dr]) => ({ id, total: tot - (q0.get(id)?.[1] || 0), dropped: dr - (q0.get(id)?.[2] || 0) }));
  // Scrubs and J / K / L.
  const scrubSeeks = raw.seeks.filter((s) => s[2] === "scrub").map((s) => ({ t: s[0], frame: s[1] }));
  const seqScrub = seqAll.filter((s, i) => ticks[i].phase === "scrub");
  const scrubs = M.seekLatencies(seqScrub, rows, scrubSeeks);
  const seqJ = seqAll.filter((s, i) => ticks[i].phase === "jkl");
  const jk = raw.keys.filter((k) => k[2] === "jkl" && /^[jkl]$/.test(k[1]));
  const jklOut = [];
  for (let i = 0; i < jk.length; i++) {
    const [t, key] = jk[i];
    const next = i + 1 < jk.length ? jk[i + 1][0] : Infinity;
    const before = [...seqJ].reverse().find((s) => s.t < t);
    const o0 = before ? M.rowOfShown(rows, before.shown, before.tl) : null;
    const rec0 = o0 ? o0.rec : before?.tl;
    let ms;
    if (key === "l") ms = M.reactionMs(seqJ, rows, t, (rec) => rec != null && rec > rec0, next);
    else if (key === "j") ms = M.reactionMs(seqJ, rows, t, (rec) => rec != null && rec < rec0, next);
    else {   // K: until the picture is the correct one for where the playhead stopped
      const stopT = seqJ.filter((s) => s.run >= t && s.run < next);
      const hit = stopT.find((s, k2) => s.shown && s.exp && s.shown.key === s.exp.key && s.shown.src === s.exp.src && stopT.slice(k2).every((u) => u.tl === s.tl));
      ms = hit ? Math.max(0, hit.run - t) : null;
    }
    jklOut.push({ key, ms, distinctPerSec: key === "k" ? null : M.distinctPerSecond(seqJ, t + 300, Math.min(next, t + 1800)) });
  }
  const exact = ticks.filter((k) => k.phase === "play" && k.draw && k.draw.key !== "other" && !k.draw.key.startsWith("clay:"));
  // Cross-check: the frame VideoFrame says was drawn vs the last frame requestVideoFrameCallback reported presented by that
  // element before the tick (rVFC runs a rendering step late, so +1 is expected whenever the draw itself advanced the frame).
  const rv = new Map(raw.vids.map((v) => [v.id, v.rvfc]));
  const xc = { same: 0, plus1: 0, other: 0, none: 0 };
  for (const k of exact) {
    if (!k.draw.exact) continue;
    const list = rv.get(k.draw.vid) || [];
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m][0] <= k.t) { at = m; lo = m + 1; } else hi = m - 1; }
    if (at < 0) { xc.none++; continue; }
    const d = k.draw.src - Math.round(list[at][1] * fps);
    if (d === 0) xc.same++; else if (d === 1) xc.plus1++; else xc.other++;
  }
  const rafGaps = M.stats(inPlay.slice(1).map((s, i) => s.t - inPlay[i].t));
  const clock = (() => {
    const au = inPlay.filter((s) => s.au);
    if (!au.length) return "wall (no audio clips)";
    if (au.some((s) => s.au.stuck)) return "wall (audio clock stuck)";
    return au.every((s) => s.au.running) ? "audio (WebAudio)" : "mixed";
  })();
  const lt = raw.longtasks.filter((l) => l[2] === "play");
  const gpuPlay = gpuSummary(raw.gpu || [], raw.marks?.playWall || 0, raw.marks?.endWall || Date.now());
  const pd = (k) => (raw.perf?.after?.[k] ?? 0) - (raw.perf?.before?.[k] ?? 0);
  return {
    label, profile, network: local ? "local-media" : "tunnel", mode: headful ? "headful" : "headless", throttle, cores: raw.meta?.cores || null,
    played: { frames: played, seconds: played / fps, from, to, wallSeconds: inPlay.length ? (inPlay[inPlay.length - 1].t - inPlay[0].t) / 1000 : 0, clock },
    dropped: drops.dropped, droppedPerMin: M.perMinute(drops.dropped, played, fps), lost: drops.lost, lostAtCuts: lostAtCut, lostMidClip: drops.lost - lostAtCut,
    heldExcess: drops.heldExcess, holds: drops.holds.length, worstHoldMs: drops.holds.reduce((m, h) => Math.max(m, h.ms), 0), holdLimitMs: drops.holdLimitMs,
    perRow: drops.perRow,
    quality: { total: qual.reduce((s, q) => s + q.total, 0), dropped: qual.reduce((s, q) => s + q.dropped, 0), perVideo: qual },
    waiting: ev("waiting"), stalled: ev("stalled"),
    seeksDuringPlay: ctPlay.length, seeksOnActive: ctPlay.filter((c) => c[6] === 1).length, seeksPreroll: ctPlay.filter((c) => c[6] === 0).length,
    playCalls: raw.plays.filter((p) => p[2] === "play" && p[0] >= (tPlay ?? 0) && p[0] <= tEnd).length,
    av: { n: avS.n, medianMs: avS.median, p95AbsMs: avAbs.p95, maxAbsMs: avAbs.max, meanMs: avS.mean },
    hitch: { worstMs: hS.max, medianMs: hS.median, censored: hitches.filter((h) => h.censored).length, list: hitches },
    firstFrameMs: first ? first.run : null, playStartMs: playStart,
    scrubs, scrubMedianMs: M.stats(scrubs.map((s) => s.ms)).median, scrubMaxMs: M.stats(scrubs.map((s) => s.ms)).max, scrubMissed: scrubs.filter((s) => s.ms == null).length,
    jkl: jklOut,
    checks: {
      vsyncMs: vsync, rafGapP95: rafGaps.p95, rafGapMax: rafGaps.max, ticks: inPlay.length,
      exactFrameIds: exact.length ? exact.filter((k) => k.draw.exact).length / exact.length : null, videoFrameErrors: raw.vfErr, rvfcCrossCheck: xc,
      mediaOk: (raw.media || []).filter((m) => m.kind === "video").every((m) => m.ok === true), mediaBlob: (raw.media || []).some((m) => m.blob),
      audio: raw.audio, ac: raw.ac, longTasks: lt.length, longTaskMs: lt.reduce((s, l) => s + l[1], 0),
      readyMs: raw.marks ? raw.marks.readyWall - raw.marks.navWall : null, readyState: raw.ready,
      mainThreadBusyS: { task: pd("TaskDuration"), script: pd("ScriptDuration"), layout: pd("LayoutDuration"), style: pd("RecalcStyleDuration") },
      gpu: gpuPlay, server: raw.server, consoleErrors: (raw.logs || []).filter((l) => !/favicon/.test(l)).slice(0, 10), ua: raw.ua,
    },
  };
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")) && arg("--reanalyse")) {
  // Recompute a run's summary from its raw log (after a change to the metrics): --reanalyse <label.raw.json.gz> [--project <fixture.json>]
  const { gunzipSync } = await import("node:zlib");
  const raw = JSON.parse(gunzipSync(readFileSync(arg("--reanalyse"))));
  const m = raw.meta || {};
  const fixture = JSON.parse(readFileSync(arg("--project", m.project), "utf8"));
  const summary = analyse(raw, { rows: rowsOf(fixture), fps: fixture.fps || 24, profile: m.profile, label: m.label, local: m.local, headful: m.headful, throttle: m.throttle });
  const outFile = arg("--write");
  if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 1)); else console.log(JSON.stringify(summary, null, 1));
} else if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const project = arg("--project"), out = arg("--out");
  if (!project || !out) { console.error("usage: node tools/qa/playback_bench.mjs --project <fixture.json> --out <dir> [--profile desktop|laptop-sim|stress] [--local-media <dir>] [--bench-media <dir>] [--runs 2] [--headful] [--label name]"); process.exit(2); }
  const profile = arg("--profile", "desktop"), runs = Number(arg("--runs", 1)), headful = process.argv.includes("--headful");
  const lm = arg("--local-media");
  const base = arg("--label", `${profile}_${lm ? "local" : "tunnel"}_${headful ? "headful" : "headless"}`);
  mkdirSync(out, { recursive: true });
  const all = [];
  for (let k = 1; k <= runs; k++) {
    const label = `${base}_r${k}`;
    const { raw, summary } = await runOnce({ project, profile, localMedia: lm ? lm.split(",") : [], benchMedia: arg("--bench-media"), headful,
      port: Number(arg("--port", 8790)), cdp: Number(arg("--cdp", 9780)), pod: arg("--pod", "http://127.0.0.1:8189"), logDir: out, label,
      jkl: !process.argv.includes("--no-jkl"), cores: arg("--cores") });
    writeFileSync(join(out, `${label}.raw.json.gz`), gzipSync(JSON.stringify(raw)));
    writeFileSync(join(out, `${label}.json`), JSON.stringify(summary, null, 1));
    all.push(summary);
    const s = summary;
    console.log(`${label}: dropped ${s.dropped} (${s.droppedPerMin?.toFixed(1)}/min; lost ${s.lost} [${s.lostAtCuts} at cuts, ${s.lostMidClip} mid-clip], held ${s.heldExcess}) | vpq ${s.quality.dropped}/${s.quality.total} | waiting ${s.waiting} | seeks ${s.seeksDuringPlay} | A/V med ${s.av.medianMs?.toFixed(1)} p95 ${s.av.p95AbsMs?.toFixed(1)} max ${s.av.maxAbsMs?.toFixed(1)} ms | worst hitch ${s.hitch.worstMs?.toFixed(0)} ms | first frame ${s.firstFrameMs?.toFixed(0)} ms | clock ${s.played.clock}`);
    await sleep(1500);
  }
  writeFileSync(join(out, `${base}.summary.json`), JSON.stringify(all, null, 1));
  process.exit(0);   // the proxy's keep-alive socket to the pod would otherwise hold the process open
}
