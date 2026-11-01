// Click through the try-it demo in a hidden Chrome before publishing: every scene loads, every step and tour stop runs,
// the replays, live drags, stunt picker, DCC kit and the full-install notices work, with zero console errors.
//   node tools/tryit/test_tryit.mjs http://127.0.0.1:8771/local.html <screenshot dir>
// Exits 1 on any console error or failed check. Screenshots: <dir>/<nn>_<name>.jpg.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "../qa/lib.mjs";

const URL0 = process.argv[2] || "http://127.0.0.1:8771/local.html";
const DIR = process.argv[3] || "tryit_shots";
const PORT = +(process.env.CDP_PORT || 9673);
const [W, H] = (process.env.SIZE || "1440x900").split("x").map(Number);
mkdirSync(DIR, { recursive: true });
const b = await launch({ port: PORT, w: W, h: H });
const fails = [], report = [];
let n = 0;
const ignore = (l) => /favicon\.ico|GPU stall|swiftshader|WebGL|Automatic fallback to software|\[\.WebGL/i.test(l);
let mark = 0;
function errorsSince() { const e = b.logs.slice(mark).filter((l) => /^(EXC|ERR|NET)/.test(l) && !ignore(l)); mark = b.logs.length; return e; }
async function shot(name, note = "") {
  await b.move(2, 2);
  await sleep(400);
  const file = join(DIR, `${String(++n).padStart(2, "0")}_${name}.jpg`);
  await b.shot(file, { jpeg: { quality: 70 } });
  const errs = errorsSince();
  report.push({ name, file, note, errors: errs });
  if (errs.length) fails.push(`${name}: ${errs.join(" | ")}`);
  console.log(`${errs.length ? "FAIL" : "ok  "} ${name}${note ? `  (${note})` : ""}${errs.length ? "\n     " + errs.join("\n     ") : ""}`);
}
function check(cond, what) { if (!cond) { fails.push(what); console.log("FAIL", what); } else console.log("ok  ", what); }
async function open(hash) {
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}#${hash}` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage && !!document.querySelector('.ss-stage')")) break; } catch { /* loading */ } }
  await sleep(3500);
}
const js = (code) => b.ev(`const D = window.__demo, node = D?.node, stage = node?.ssStage, P = node?.ssPipeline, sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code}`);
/** Screen point of an actor (its middle). */
const at = (id, y = 0.5) => js(`const g = stage.actorMeshes.get(${JSON.stringify(id)}); if (!g) return null; g.updateMatrixWorld(true);
  const box = new (g.position.constructor)(); const p = g.getWorldPosition(box); p.y += ${y}; p.project(stage.camera);
  const r = stage.canvas.getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };`);

try {
  // ---------------------------------------------------------------- every scene loads clean
  const keys = await (async () => { await open("drycreek"); return js("return [...document.querySelectorAll('#scene option')].map((o) => o.value)"); })();
  check(keys.length >= 20, `scene picker lists ${keys.length} scenes`);
  errorsSince();
  for (const k of keys) {
    await open(k);
    const info = JSON.parse(await js(`return JSON.stringify({ set: stage.toJSON().environment.set, actors: stage.toJSON().actors.length, shots: stage.toJSON().shots.length,
      script: !!node.ssScript?.script, renders: Object.keys(node.properties?.ss_renders || {}).length, card: !!node.ssDemo?.visible })`));
    await shot(`scene_${k}`, `${info.set}, ${info.actors} objects, ${info.shots} shots, ${info.renders} rendered${info.script ? ", script" : ""}${info.card ? ", first-run card" : ""}`);
    if (k === "blank") check(info.card, "brand-new stage shows the first-run card");
  }

  // ---------------------------------------------------------------- the seven steps on Dry Creek
  await open("drycreek");
  for (const st of ["script", "cast", "set", "frame", "motion", "review", "deliver"]) {
    await js(`P.go('${st}'); return 1`); await sleep(2200);
    await shot(`drycreek_step_${st}`);
  }
  await js("node.ssDailies.openScriptSync(); return 1"); await sleep(2500);
  const lined = await js("return document.querySelectorAll('.ss-dailies img, .ss-dailies video, .ss-dailies canvas').length");
  await shot("drycreek_scriptsync", `${lined} take pictures on the lined script`);
  check(lined > 0, "ScriptSync shows takes");

  // ---------------------------------------------------------------- replays: Frame (4 variations) and Motion on the stunt
  await open("stunt");
  await js("P.go('frame'); return 1"); await sleep(1500);
  await js("P.f.goBtn.click(); return 1"); await sleep(5000);
  const cands = await js("return P.candidates[stage.activeShot().id]?.length || 0");
  await shot("stunt_frame_replay", `${cands} frames`);
  check(cands >= 4, "④ Frame replays the four FLUX 3 Klein variations");
  await js("P.go('motion'); return 1"); await sleep(1500);
  await js("P.m.draftBtn.click(); return 1"); await sleep(4000);
  await shot("stunt_motion_draft");
  await js("P.m.finalBtn?.click(); return 1"); await sleep(4000);
  await shot("stunt_motion_final");
  const rs = await js("return JSON.stringify(Object.keys(node.properties.ss_renders?.jturn || {}))");
  check(/draft/.test(rs) && /final/.test(rs), `Motion replays draft and final (${rs})`);

  // ---------------------------------------------------------------- stunt picker on a live car
  await js("P.go('set'); return 1"); await sleep(1200);
  await js("stage.select('sports_car'); return 1"); await sleep(1200);
  const opts = await js("const s=[...document.querySelectorAll('.ss-stage select')].find(x=>x.getClientRects().length&&[...x.options].some(o=>/J-turn/.test(o.text))); if(!s) return ''; s.value=[...s.options].find(o=>/Donut/.test(o.text)).value; s.dispatchEvent(new Event('change',{bubbles:true})); return [...s.options].map(o=>o.text).join('|')");
  await sleep(1200);
  await js("stage.setFrame(60); return 1"); await sleep(800);
  await shot("stunt_picker_donut", opts);
  check(/Donut/.test(opts), "Stunt picker lists the stunts and applies one");

  // ---------------------------------------------------------------- live physics: climb, mount, pick up, push, solver switch
  await open("physics");
  await js("P.go('set'); return 1"); await sleep(1000);
  const hd = async (from, to, dur = 1600, ty = 0.9) => { const a = await at(from, 1.0), c = await at(to, ty); if (!a || !c) return false; await b.drag(a.x, a.y, c.x, c.y, dur); await sleep(1800); return true; };
  await js("stage.select('sam'); return 1"); await sleep(400);
  const y0 = await js("return stage.actorMeshes.get('sam').position.y");
  await hd("sam", "crate_a", 1600, 0.5);   // aim at the crate's top face (0.9 m lands behind it)
  const y1 = await js("return stage.actorMeshes.get('sam').position.y");
  await shot("physics_climb", `Sam y ${(+y0).toFixed(2)} -> ${(+y1).toFixed(2)}`);
  check(y1 > y0 + 0.3, "dragging Sam onto a crate climbs it");
  await hd("sam", "horse");
  const mounted = await js("const a = stage.toJSON().actors.find(x=>x.id==='sam'); return a.mount_id || a.pose || ''");
  await shot("physics_mount", `Sam: ${mounted}`);
  await hd("sam", "box_1");
  await b.key("c"); await sleep(1500);
  await shot("physics_pickup");
  const ca = await at("crate_a", 0.4), cb = await at("crate_c", 0.4);
  await js("stage.select('crate_a'); return 1"); await sleep(300);
  if (ca && cb) { await b.drag(ca.x, ca.y, cb.x + 40, cb.y, 1500); await sleep(2000); }
  await shot("physics_push");
  await js("stage.select('crate_b'); return 1"); await sleep(600);
  await js("const pb=[...document.querySelectorAll('.ss-stage button')].find(x=>x.textContent.trim()==='Physics'&&x.getClientRects().length); pb?.click(); return !!pb"); await sleep(1200);
  const gpu = await js(`const p=document.querySelector('.ss-phys:not([hidden])'); if(!p) return 'no panel';
    const s=[...p.querySelectorAll('select, button, input')].find(x=>/GPU/i.test(x.textContent||'')||[...(x.options||[])].some(o=>/GPU/.test(o.text)));
    if (s?.options) { s.value=[...s.options].find(o=>/GPU/.test(o.text)).value; s.dispatchEvent(new Event('change',{bubbles:true})); } else s?.click();
    await sleep(2500); return (p.innerText||'').replace(/\\s+/g,' ').slice(0,200)`);
  await shot("physics_panel_gpu_fallback", gpu.slice(0, 120));
  check(!/no panel/.test(gpu), "Physics panel opens and the GPU switch falls back cleanly");

  // ---------------------------------------------------------------- full-install features degrade with a note, never an error
  await open("drycreek");
  await js("P.go('motion'); return 1"); await sleep(1500);
  await js("P.ripple?.setMode('ripple'); return 1"); await sleep(1500);
  await shot("motion_follow_ripple");
  await js("P.ripple?.setMode('pose'); return 1"); await sleep(1500);
  await shot("motion_follow_pose");
  await js("P.go('deliver'); return 1"); await sleep(1800);
  const dcc = await js("const x=[...document.querySelectorAll('.ss-stage button')].find(b=>/DCC kit/i.test(b.textContent)&&b.getClientRects().length); x?.scrollIntoView({block:'center'}); return x ? x.textContent.trim() : ''");
  await sleep(600);
  await shot("deliver_dcc_card", dcc);
  check(!!dcc, "⑦ Deliver shows the DCC kit card");
  await js("[...document.querySelectorAll('.ss-stage button')].find(b=>/DCC kit/i.test(b.textContent)&&b.getClientRects().length)?.click(); return 1"); await sleep(4000);
  await shot("deliver_dcc_built", (await js("return JSON.stringify(window.__blocked||[])")).slice(0, 140));
  await js("const r = await D.api.fetchApi('/soundstage/director/chat', {method:'POST', body:'{}'}); return r.status"); await sleep(400);
  await shot("full_install_notice", await js("return document.getElementById('toast').textContent"));
  await js("P.go('set'); return 1"); await sleep(1000);
  await js("[...document.querySelectorAll('.ss-stage button')].find(b=>/^Import video$/.test(b.textContent.trim())&&b.getClientRects().length)?.click(); return 1"); await sleep(1500);
  await shot("import_video_chooser");
  await js("document.querySelector('.ss-vi-modal .cancel')?.click(); return 1"); await sleep(500);

  // ---------------------------------------------------------------- since the contest: Director, Presets, Timeline, Hollywood, take checks, viewfinder
  const toast = () => js("const t = document.getElementById('toast'); return t.hidden ? '' : t.textContent");
  await open("chase");
  await js("node.ssDirector.open(); return 1"); await sleep(2500);
  const dirToast = await toast();
  const olStatus = await js("return (await fetch('http://127.0.0.1:11434/api/tags')).status");
  await shot("director_panel", dirToast);
  check(/Director.*full install/.test(dirToast) && olStatus === 503, `Director: the LLM says "available in the full install" (Ollama probe ${olStatus})`);
  await js("node.ssDirector.close(); node.ssPresets.open('camera'); return 1"); await sleep(1500);
  const cards = await js("return node.ssPresets.list().length");
  await shot("presets_window", `${cards} presets`);
  check(cards > 10 && await js("return node.ssPresets.isOpen()"), `Presets window opens (${cards} presets)`);
  await js("node.ssPresets.close(); document.querySelector('[data-tab=\"cut\"]').click(); return 1"); await sleep(2000);
  const tl = await js("const v = document.querySelector('.ss-cutview'); return v && !v.hidden ? v.innerText.length : 0");
  await shot("timeline", `${tl} chars of Timeline UI`);
  check(tl > 0, "the Timeline (Edit tab) opens");
  const tlr = await js("const r = await D.api.fetchApi('/soundstage/cut/render', {method:'POST', body:'{}'}); await sleep(300); return r.status + ' ' + document.getElementById('toast').textContent");
  check(/^503 .*Timeline.*full install/.test(tlr), `Timeline render: ${tlr.slice(0, 90)}`);
  await js("document.querySelector('[data-tab=\"stage\"]')?.click(); stage.setActiveShot('crane'); P.go('review'); return 1"); await sleep(5000);
  const chips = await js("return [...document.querySelectorAll('.ss-tc-strip .ss-tc-take')].map((e) => e.innerText.replace(/\\s+/g, ' ')).join(' | ')");
  await shot("takechecks_ladder", chips.slice(0, 140));
  check(/black|smear|clean|wrong way/i.test(chips), `take checks show the server's chips (${chips.slice(0, 80)})`);
  await js("P.go('motion'); return 1"); await sleep(1200);
  await js("P.m.qSeg.querySelector('[data-q=\"Hollywood\"]').click(); return 1"); await sleep(800);
  const q = await js("return P.m.qSeg.querySelector('[aria-pressed=\"true\"]')?.dataset.q || ''");
  await shot("motion_hollywood", q);
  check(q === "Hollywood", "⑤ Motion's Quality switches to Hollywood");
  await js("P.go('set'); node.ssViewfinder.open(); return 1"); await sleep(1500);
  const vfToast = await toast();
  await shot("phone_viewfinder", vfToast);
  check(/viewfinder.*full install/i.test(vfToast), "phone viewfinder: the vcam bridge says \"available in the full install\"");
  await js("node.ssViewfinder.close(); return 1");

  // ---------------------------------------------------------------- What's new tour: every stop, and a clip
  await open("drycreek");
  const stops = JSON.parse(await js("return JSON.stringify((await (await fetch(new URL('./tour.json', document.baseURI))).json()).steps.map(s=>[s.id,s.scene]))"));
  for (const [id, scene] of stops) {
    await open(`${scene}--${id}`);
    await sleep(2500);
    await shot(`tour_${id}`);
  }
  await js("[...document.querySelectorAll('#tourList button')].find(x=>/^Watch/.test(x.textContent))?.click(); return 1"); await sleep(2500);
  const playing = await js("const v=document.querySelector('#clip video'); return v ? v.readyState : -1");
  await shot("tour_clip_player", `readyState ${playing}`);
  check(playing >= 2, "a tour clip plays");

  // ---------------------------------------------------------------- phone width
  await b.resize(390, 844);
  await open("chase");
  const wide = await js("return document.documentElement.scrollWidth > innerWidth + 1");
  await shot("phone_chase", `page scrolls sideways: ${wide}`);
  check(!wide, "no sideways page scroll at phone width");
} finally {
  writeFileSync(join(DIR, "report.json"), JSON.stringify({ fails, report }, null, 1));
  b.close();
}
console.log(fails.length ? `\n${fails.length} FAILED:\n- ${fails.join("\n- ")}` : "\nall clear");
process.exit(fails.length ? 1 : 0);
