// Every tour stop and every "Watch" clip at one window size: the clip loads and plays (or the still decodes),
// nothing on the page chrome (bar, first screen, tour card, clip dialog) is clipped or off-screen, zero console errors.
//   SIZE=390x844 node tools/tryit/verify_tour.mjs http://127.0.0.1:8771/local.html <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "../qa/lib.mjs";

const URL0 = process.argv[2] || "http://127.0.0.1:8771/local.html";
const DIR = process.argv[3] || "tour_shots";
const PORT = +(process.env.CDP_PORT || 9885);
const [W, H] = (process.env.SIZE || "1440x900").split("x").map(Number);
mkdirSync(DIR, { recursive: true });
const b = await launch({ port: PORT, w: W, h: H });
if (W < 768) await b.resize(W, H);
const fails = [], rows = [];
const ignore = (l) => /favicon\.ico|GPU stall|swiftshader|WebGL|Automatic fallback to software|\[\.WebGL/i.test(l);
let mark = 0, n = 0;
const errs = () => { const e = b.logs.slice(mark).filter((l) => /^(EXC|ERR|NET)/.test(l) && !ignore(l)); mark = b.logs.length; return e; };
const check = (ok, what) => { (ok ? console.log("ok  ", what) : (fails.push(what), console.log("FAIL", what))); };
async function shot(name, note = "") {
  await sleep(300);
  await b.shot(join(DIR, `${String(++n).padStart(2, "0")}_${name}.jpg`), { jpeg: { quality: 72 } });
  const e = errs(); rows.push({ name, note, errors: e });
  if (e.length) fails.push(`${name}: console ${e.join(" | ")}`);
  console.log(`${e.length ? "FAIL" : "ok  "} ${name}${note ? `  (${note})` : ""}${e.length ? "\n     " + e.join("\n     ") : ""}`);
}
// Hard text cuts and boxes that leave the window, inside the page's own chrome (not the App widget, which the QA guard covers).
const CLIP = (sel) => `const out = []; const vw = innerWidth, vh = innerHeight;
  for (const root of document.querySelectorAll(${JSON.stringify(sel)})) { if (root.hidden || !root.getClientRects().length) continue;
    for (const e of [root, ...root.querySelectorAll('*')]) { if (!e.getClientRects().length) continue; const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden') continue; const r = e.getBoundingClientRect(); const tag = (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')) + ' "' + (e.textContent || '').trim().slice(0, 30) + '"';
      const ell = cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' && cs.webkitLineClamp;
      if (!ell && /hidden|clip/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1) out.push('cut-x ' + tag);
      if (!ell && /hidden|clip/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1 && cs.overflowY !== 'auto') out.push('cut-y ' + tag);
      const fixedScroll = root.id === 'hero' || root.id === 'tour';   // these scroll inside themselves
      if ((e.tagName === 'BUTTON' || e.tagName === 'SELECT') && (r.right > vw + 1 || r.left < -1 || (!fixedScroll && r.bottom > vh + 1))) out.push('offscreen ' + tag + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    } }
  if (document.documentElement.scrollWidth > vw + 1) out.push('page scrolls sideways ' + document.documentElement.scrollWidth);
  return JSON.stringify(out);`;

try {
  // ---- the first screen on a plain visit
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}` });
  for (let i = 0; i < 40; i++) { await sleep(500); try { if (await b.ev("return !document.getElementById('hero')?.hidden")) break; } catch { /* loading */ } }
  await sleep(4000);
  const heroClip = JSON.parse(await b.ev(CLIP("#hero")));
  const hero = JSON.parse(await b.ev(`const c = document.getElementById('heroCv'), x = c.getContext('2d');
    const px = (u) => { const d = x.getImageData(Math.round(u * c.width), c.height / 2, 1, 1).data; return d[0] + d[1] + d[2]; };
    const f = document.querySelector('#hero figure').getBoundingClientRect(), h = document.getElementById('heroTitle').getBoundingClientRect(), g = document.getElementById('heroGo').getBoundingClientRect();
    const v = [...document.querySelectorAll('video')].map((v) => ({ rs: v.readyState, t: +v.currentTime.toFixed(2), paused: v.paused }));
    return JSON.stringify({ lit: px(0.2) + px(0.8), fig: [Math.round(f.top), Math.round(f.height)], title: Math.round(h.top), goBottom: Math.round(g.bottom), aboveFold: g.bottom <= innerHeight, v })`));
  await shot("hero", JSON.stringify(hero));
  check(!heroClip.length, `first screen: nothing clipped ${heroClip.join("; ")}`);
  check(hero.lit > 30, "first screen: the wipe draws");
  check(hero.aboveFold, `first screen: the main button is above the fold (bottom ${hero.goBottom} / ${H})`);
  // the wipe moves when dragged
  const ba = await b.rect("#hero .ba");
  if (ba) { await b.drag(ba.x + ba.w * 0.5, ba.cy, ba.x + ba.w * 0.15, ba.cy, 500); await sleep(500); }
  const now = await b.ev("return document.getElementById('heroSplit').getAttribute('aria-valuenow')");
  await shot("hero_dragged", `split ${now}`);
  check(+now < 30, `first screen: dragging moves the wipe (${now})`);
  await b.ev("document.getElementById('heroTour').click(); return 1"); await sleep(4000);
  const barClip = JSON.parse(await b.ev(CLIP(".bar, #tour")));
  await shot("tour_open", `${await b.ev("return document.querySelectorAll('#tourList li').length")} stops`);
  check(!barClip.length, `bar + tour card: nothing clipped ${barClip.join("; ")}`);

  // ---- every stop, through its own button, and every clip
  const stops = JSON.parse(await b.ev("return JSON.stringify([...document.querySelectorAll('#tourList li')].map((li) => li.dataset.id))"));
  for (const id of stops) {
    await b.ev("document.querySelector('.ss-vi-modal button')&&[...document.querySelectorAll('.ss-vi-modal button')].find((x)=>/^Cancel$/.test(x.textContent.trim()))?.click(); return 1");   // the Video → 3D stop leaves the App's chooser open
    for (let i = 0; i < 2; i++) {   // click the stop's Open / Show me (Open reloads into the scene; then Show me runs it)
      if (await b.ev("return document.getElementById('tour').hidden")) await b.ev("document.getElementById('tourBtn').click(); return 1");
      const label = await b.ev(`const li = document.querySelector('#tourList li[data-id="${id}"]'); const g = li.querySelector('button.go'); li.scrollIntoView({ block: 'nearest' }); return g.textContent`);
      const r = await b.ev(`const g = document.querySelector('#tourList li[data-id="${id}"] button.go').getBoundingClientRect(); return JSON.stringify({ x: g.x + g.width / 2, y: g.y + g.height / 2 })`);
      const p = JSON.parse(r); await b.click(p.x, p.y);
      if (label === "Show me") break;
      for (let k = 0; k < 60; k++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage && !!document.querySelector('.ss-stage')")) break; } catch { /* reloading */ } }
      await sleep(2500);
      if (await b.ev(`return document.querySelector('#tourList li[aria-current]')?.dataset.id === '${id}'`)) break;   // the hash ran it
    }
    await sleep(4500);
    const cur = await b.ev("return document.querySelector('#tourList li[aria-current]')?.dataset.id || ''");
    const c1 = JSON.parse(await b.ev(CLIP(".bar, #tour")));
    // the stage itself must be visible: the tour card may cover it at phone width, so screenshot with the card closed too
    await shot(`stop_${id}`, `current ${cur}`);
    check(cur === id, `stop ${id}: runs (current ${cur})`);
    check(!c1.length, `stop ${id}: nothing clipped ${c1.join("; ")}`);
    if (W < 768) { await b.ev("document.getElementById('tourClose').click(); return 1"); await shot(`stop_${id}_stage`); }
    const nClips = await b.ev(`if (document.getElementById('tour').hidden) document.getElementById('tourBtn').click(); return document.querySelectorAll('#tourList li[data-id="${id}"] .row button:not(.go)').length`);
    for (let j = 0; j < nClips; j++) {
      await b.ev(`document.querySelectorAll('#tourList li[data-id="${id}"] .row button:not(.go)')[${j}].click(); return 1`);
      await sleep(3500);
      const m = JSON.parse(await b.ev(`const d = document.getElementById('clip'), v = d.querySelector('video'), im = d.querySelector('img'), r = d.getBoundingClientRect();
        const t0 = v ? v.currentTime : 0; await new Promise((ok) => setTimeout(ok, 1200));
        const o = { title: document.getElementById('clipTitle').textContent, open: d.open, fits: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, rect: [Math.round(r.width), Math.round(r.height)] };
        if (v) Object.assign(o, { kind: 'video', rs: v.readyState, vw: v.videoWidth, paused: v.paused, adv: +(v.currentTime - t0).toFixed(2), dur: +v.duration.toFixed(1), err: v.error && v.error.code });
        if (im) Object.assign(o, { kind: 'img', ok: im.complete && im.naturalWidth > 0, nw: im.naturalWidth });
        return JSON.stringify(o)`));
      await shot(`stop_${id}_clip${j + 1}`, JSON.stringify(m));
      if (m.kind === "video") check(m.rs >= 3 && m.vw > 0 && !m.paused && (m.adv > 0.3 || m.adv < 0) && !m.err, `stop ${id} · ${m.title}: video plays (rs ${m.rs}, +${m.adv}s of ${m.dur}s)`);
      else check(m.ok, `stop ${id} · ${m.title}: still decodes (${m.nw}px)`);
      check(m.fits, `stop ${id} · ${m.title}: dialog fits the window (${m.rect})`);
      await b.ev("document.getElementById('clipClose').click(); return 1"); await sleep(400);
    }
  }
} catch (e) { fails.push("crashed: " + e.message); console.log("FAIL crashed", e); }
finally { writeFileSync(join(DIR, "report.json"), JSON.stringify({ size: `${W}x${H}`, fails, rows }, null, 1)); b.close(); }
console.log(fails.length ? `\n${fails.length} FAILED:\n- ${fails.join("\n- ")}` : "\nall clear");
process.exit(fails.length ? 1 : 0);
