#!/usr/bin/env node
// Scene strip check: the "Set up scene …" button must never sit on a shot tile. A hidden Chrome opens the App on a
// project with a script (default: the pod's Last_Light_on_Route_9 workflow, 14 setups in scene 1), opens the scene
// drop-down at each width, and for every shot tile scrolls it into view the way a person would and checks that a click
// at its centre lands on the tile, and that the setup button's box doesn't intersect any tile or the tile row.
//
//   SS_ANGLE=metal node tools/qa/scenestrip_overlap.mjs                         # 1024, 1280, 1600, 1920; exits 1 on a failure
//   SS_ANGLE=metal node tools/qa/scenestrip_overlap.mjs --sizes 1600x1000 --wf Last_Light_on_Route_9.json
//   SS_ANGLE=metal node tools/qa/scenestrip_overlap.mjs --local script/scenestrip.mjs,soundstage.js   # a fix before deploy
//   options: --port 9868  --out <dir>
//
// Never queues a render and never saves (tools/qa/lib.mjs's guard). Writes report.json and a PNG per width.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, toAppMode, openFull, INSTALL, sleep, REPO } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SIZES = opt("sizes", "1024x640,1280x800,1600x1000,1920x1080").split(",").map((s) => s.split("x").map(Number));
const WF = opt("wf", "Last_Light_on_Route_9.json");
const LOCAL = opt("local", "") ? opt("local").split(",") : [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = opt("out", join(REPO, "tests", "visual", "out", `scenestrip-${stamp}`));
mkdirSync(OUT, { recursive: true });

/** Page side: open the scene drop-down, then check every tile and the setup button. */
export const CHECK = String.raw`
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const pop=document.querySelector('.ss-scenepop');
  if (pop && pop.hidden) { document.querySelector('button.ss-scpick')?.click(); await sleep(1000); }
  const strip=(pop && !pop.hidden && pop.querySelector('.ss-scstrip')) || [...document.querySelectorAll('.ss-scstrip')].find(e=>e.getClientRects().length);
  if (!strip) return { error: 'no scene strip on screen' };
  const R=(e)=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top,r:r.right,b:r.bottom}};
  const hit=(a,b)=>a.x<b.r-1&&b.x<a.r-1&&a.y<b.b-1&&b.y<a.b-1;
  const rail=strip.querySelector('.rail');
  const acts=[...strip.querySelectorAll('.act button')].filter(b=>b.getClientRects().length);
  const setup=acts.find(b=>/^Set up scene/.test(b.textContent.trim()));
  const tiles=[...strip.querySelectorAll('button.shot')].filter(b=>b.getClientRects().length);
  const bad=[];
  for (const b of acts) if (hit(R(b), R(rail))) bad.push('"'+b.textContent.trim().slice(0,30)+'" overlaps the tile row');
  // As laid out (the row scrolled to its start): no tile's box may reach under a button, and every tile whose centre
  // shows in the row takes a click there. (The old side column sat over the row's last tiles: a click aimed at the
  // part of 1M you could see landed on "Set up scene 1".)
  rail.style.scrollBehavior='auto'; rail.scrollLeft=0; await sleep(150);
  const RR=R(rail);
  for (const t of tiles) {
    const name=t.textContent.trim().split(' ')[0], r=R(t);
    for (const b of acts) if (hit(R(b), r)) bad.push(name+' (as laid out) runs under "'+b.textContent.trim().slice(0,30)+'"');
    const cx=(Math.max(r.x,RR.x)+Math.min(r.r,RR.r))/2, cy=(r.y+r.b)/2;
    if (cx>RR.x && cx<RR.r && Math.min(r.r,RR.r)-Math.max(r.x,RR.x)>8) { const e=document.elementFromPoint(cx,cy);
      if (!(e && t.contains(e))) bad.push(name+': a click on the part that shows lands on '+((e&&e.textContent||e&&e.tagName||'nothing').trim().slice(0,30))); }
  }
  for (const t of tiles) {
    t.scrollIntoView({inline:'nearest', block:'nearest'}); rail.style.scrollBehavior='auto'; await sleep(120);
    const r=t.getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    const name=t.textContent.trim().split(' ')[0];
    if (!(e && t.contains(e))) bad.push(name+': a click at its centre lands on '+((e&&e.textContent||e&&e.tagName||'nothing').trim().slice(0,30)));
    for (const b of acts) if (hit(R(b), R(t))) bad.push(name+' is under "'+b.textContent.trim().slice(0,30)+'"');
  }
  rail.scrollLeft=0;
  return { tiles: tiles.length, setup: setup ? setup.textContent.trim() : null, setupBox: setup ? R(setup) : null, rail: R(rail), strip: R(strip), bad };`;

const b = await launch({ port: +opt("port", "9868"), w: SIZES[0][0], h: SIZES[0][1], localFiles: LOCAL });
const report = [];
let fail = 0;
try {
  await openApp(b); await sleep(5000);   // let ComfyUI restore its own tabs first, or it replaces the project
  // the saved project, read by the page itself (loadGraphData opens it in App mode: it was saved there)
  const loaded = await b.ev(`const app=window.comfyAPI.app.app;
    const wf=await (await fetch('/api/userdata/workflows%2F'+encodeURIComponent(${JSON.stringify(WF)})+'?qa='+Date.now())).json();
    await app.loadGraphData(wf, true, true, ${JSON.stringify(WF.replace(/\.json$/, ""))}); return 1;`);
  if (loaded !== 1) console.log("load:", JSON.stringify(loaded).slice(0, 300));
  await sleep(9000);
  await toAppMode(b); await openFull(b); await b.ev(INSTALL); await sleep(1500);
  console.log("opened:", JSON.stringify(await b.ev("return {tab: document.title, full: !!document.querySelector('.ss-stage.ss-full'), pick: !!document.querySelector('button.ss-scpick')}")));
  for (const [w, h] of SIZES) {
    await b.resize(w, h); await sleep(1500);
    const r = (await b.ev(CHECK)) || {};
    await b.shot(join(OUT, `strip_${w}x${h}.png`));
    const ok = !r.error && r.tiles > 0 && !(r.bad || []).length;
    if (!ok) fail++;
    report.push({ size: `${w}x${h}`, ok, ...r });
    console.log(`${w}x${h}`, ok ? "PASS" : "FAIL", `${r.tiles || 0} tiles`, r.setup ? "setup shown" : "no setup button", (r.bad || []).join("; ") || r.error || "");
  }
} finally { b.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
console.log("report:", join(OUT, "report.json"));
process.exit(fail ? 1 : 0);
