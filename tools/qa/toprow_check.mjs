#!/usr/bin/env node
// Fit check: at small windows (Mike's iMac is 1024 pt wide) every control of the full workspace must be on screen and
// clickable. A hidden Chrome opens the App with the demo scene and, at each size:
//   1. top row: in every step and tool view, and with a render's Stop button showing, each control of the top row lies
//      inside the window and inside the row, and a click at its centre lands on it; the "⋯" menu (ui/toprow.mjs) holds
//      the rest, every item inside the window and clickable;
//   2. whole App: in every step, no visible button, field or menu lies partly outside the window, and none is covered by
//      another panel (a control scrolled out of its own scrolling box is fine: scrolling brings it back);
//   3. Physics: with the tracks open and Physics open on a car, the shot strip's + Shot, clips and their … menus stay
//      uncovered.
//
//   SS_ANGLE=metal node tools/qa/toprow_check.mjs                       # 1024x640 and 1280x800; exits 1 on a failure
//   SS_ANGLE=metal node tools/qa/toprow_check.mjs --sizes 1024x640 --only toprow
//   SS_ANGLE=metal node tools/qa/toprow_check.mjs --local ui/toprow.mjs,soundstage.js   # check a fix before deploying it
//   options: --port 9830  --jobs 2  --out <dir>  --only toprow,app,physics
//
// Never queues a render (tools/qa/lib.mjs's guard). Writes report.json, report.md and a PNG of every failing screen to
// tests/visual/out/toprow-<time>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, loadWorkflow, toAppMode, openFull, INSTALL, STILL_CSS, noise, sleep, REPO } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SIZES = opt("sizes", "1024x640,1280x800").split(",").map((s) => s.split("x").map(Number));
const ONLY = new Set(opt("only", "toprow,app,physics").split(","));
const PORT = +opt("port", "9830");
const JOBS = Math.max(1, +opt("jobs", "2"));
const LOCAL = opt("local", "") ? opt("local").split(",") : [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = opt("out", join(REPO, "tests", "visual", "out", `toprow-${stamp}`));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const STEPS = ["script", "cast", "set", "frame", "motion", "review", "deliver"];
export const TOOLS = ["canvas", "advisor", "look", "dailies", "cut"];

/** Page-side checks (window.__fq). */
export const PAGE = String.raw`(() => {
  if (window.__fq) return 1;
  // a closed <details> keeps a layout box for its content (Chrome's ::details-content), but nothing of it shows
  const vis = (e) => { if (!e || !e.isConnected || !e.getClientRects().length) return false; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    for (let x = e, c = null; x && x.nodeType === 1; c = x, x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
      if (x.tagName === 'DETAILS' && !x.open && !(c && c.tagName === 'SUMMARY')) return false; } return true; };
  const desc = (e) => !e ? 'nothing' : (e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ((e.textContent || '').trim() ? ' "' + e.textContent.trim().replace(/\s+/g, ' ').slice(0, 24) + '"' : ''));
  const label = (e) => ((e.textContent || '').trim() || e.getAttribute('aria-label') || e.title || e.value || e.placeholder || e.tagName).replace(/\s+/g, ' ').slice(0, 40);
  const mine = (e, hit) => !!hit && (e === hit || e.contains(hit) || hit.contains(e) || (e.labels && [...e.labels].some((l) => l === hit || l.contains(hit))));
  const scrolls = (cs) => /(auto|scroll)/.test(cs.overflowX + cs.overflowY);
  const clips = (cs) => /(hidden|clip)/.test(cs.overflowX + cs.overflowY);
  // one control: scrolled to the middle of each scrolling box it sits in (never the page), then it must lie inside the
  // window, not be cut by a box that cannot scroll, and a click at the centre of what shows must reach it
  function one(e, box) {
    const saved = [], out = [], vw = innerWidth, vh = innerHeight;
    for (let s = e.parentElement; s && s !== document.body && s !== document.documentElement; s = s.parentElement) {
      const cs = getComputedStyle(s); if (!scrolls(cs)) continue;
      // its content box: a box padded clear of a bar floating over it (the Look view over the timeline) scrolls past it
      const b0 = s.getBoundingClientRect(), ir = e.getBoundingClientRect();
      const sr = { top: b0.top + (parseFloat(cs.paddingTop) || 0), bottom: b0.bottom - (parseFloat(cs.paddingBottom) || 0), left: b0.left, right: b0.right };
      sr.height = sr.bottom - sr.top; sr.width = sr.right - sr.left;
      saved.push([s, s.scrollTop, s.scrollLeft, s.style.scrollBehavior]); s.style.scrollBehavior = 'auto';
      if (ir.top < sr.top || ir.bottom > sr.bottom) s.scrollTop += (ir.top + ir.height / 2) - (sr.top + sr.height / 2);
      if (ir.left < sr.left || ir.right > sr.right) s.scrollLeft += (ir.left + ir.width / 2) - (sr.left + sr.width / 2);
    }
    try {
      const r = e.getBoundingClientRect();
      let L = r.left, T = r.top, R = r.right, B = r.bottom, cut = null;
      // only the boxes that really clip it: an absolute box escapes its static ancestors, a fixed one all of them
      let pos = getComputedStyle(e).position;
      for (let x = e.parentElement; x && x !== document.documentElement; x = x.parentElement) {
        if (pos === 'fixed') break;
        const cs = getComputedStyle(x);
        // x is not the containing block of an absolute box (static, no transform): it does not clip it
        if (pos === 'absolute' && cs.position === 'static' && cs.transform === 'none' && cs.contain === 'none') continue;
        pos = cs.position;
        if (!scrolls(cs) && !clips(cs)) continue;
        const q = x.getBoundingClientRect();
        if (!scrolls(cs) && !cut && (r.left < q.left - 2 || r.right > q.right + 2 || r.top < q.top - 2 || r.bottom > q.bottom + 2)) cut = x;
        L = Math.max(L, q.left); T = Math.max(T, q.top); R = Math.min(R, q.right); B = Math.min(B, q.bottom);
      }
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)
        out.push('outside the window (x ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw + ', y ' + Math.round(r.top) + '..' + Math.round(r.bottom) + ' of ' + vh + ')');
      else if (cut) out.push('cut off by ' + desc(cut));
      if (box && (r.left < box.left - 1 || r.right > box.right + 1)) out.push('runs past the row (x ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + Math.round(box.left) + '..' + Math.round(box.right) + ')');
      if (R - L < 2 || B - T < 2) { if (!out.length) out.push('not visible: cut off by a box around it'); }
      else {
        const x = Math.min(vw - 2, Math.max(1, (L + R) / 2)), y = Math.min(vh - 2, Math.max(1, (T + B) / 2));
        const hit = document.elementFromPoint(x, y);
        if (!mine(e, hit)) out.push('covered by ' + desc(hit));
      }
      return out.length ? { what: desc(e).slice(0, 60), label: label(e), issues: out } : { ok: label(e) };
    } finally { for (const [s, t, l, sb] of saved.reverse()) { s.scrollTop = t; s.scrollLeft = l; s.style.scrollBehavior = sb; } }
  }
  const CTRL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=menuitem], [role=tab]';
  window.__fq = {
    // every control of the top row
    toprow() {
      const row = [...document.querySelectorAll('.ss-stage.ss-full .ss-tabs.ss-toprow')].find(vis); if (!row) return JSON.stringify({ error: 'no top row' });
      const box = row.getBoundingClientRect();
      const ctrls = [...row.querySelectorAll(CTRL)].filter(vis).filter((e) => !e.closest('.ss-toppop'));
      const res = ctrls.map((e) => one(e, box)).filter(Boolean);
      const folded = [...row.querySelectorAll(':scope > .ss-ovf')].filter((e) => !e.classList.contains('ss-morebtn')).map(label);
      return JSON.stringify({ row: [Math.round(box.left), Math.round(box.right), row.clientWidth, row.scrollWidth], count: ctrls.length,
        bad: res.filter((x) => x.issues), names: res.filter((x) => x.ok).map((x) => x.ok), folded,
        more: vis(row.querySelector(':scope > .ss-morebtn')) });
    },
    // the "⋯" menu, once open
    menu() {
      const m = [...document.querySelectorAll('.ss-moremenu')].find(vis); if (!m) return JSON.stringify({ error: 'the ⋯ menu did not open' });
      const items = [...m.querySelectorAll('[role=menuitem]')].filter(vis);
      const res = items.map((e) => one(e, null)).filter(Boolean);
      const r = m.getBoundingClientRect();
      const inside = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      return JSON.stringify({ inside, items: items.map(label), bad: res.filter((x) => x.issues), for: items.map((e) => e.dataset.ovfFor) });
    },
    // every visible control in the App (the open pop-over layer included)
    app(scope) {
      const roots = [...document.querySelectorAll('.ss-stage.ss-full, body > .ss-pophost')].filter(vis);
      const ctrls = roots.flatMap((r) => [...r.querySelectorAll(scope || CTRL)]).filter(vis)
        .filter((e) => !e.closest('canvas, .ss-pane-hidden') && !(e.tagName === 'INPUT' && e.type === 'file'));
      const res = ctrls.map((e) => one(e, null)).filter(Boolean);
      return JSON.stringify({ count: ctrls.length, bad: res.filter((x) => x.issues) });
    },
  };
  return 1;
})()`;

async function checkSize([w, h], port) {
  const tag = `${w}x${h}`;
  const res = { size: tag, checks: [], errors: [] };
  const b = await launch({ port, w, h, localFiles: LOCAL });
  const js = (code, ms = 30000) => Promise.race([b.ev(`const __qa=window.__qa; ${code}`), sleep(ms).then(() => { throw new Error(`page busy > ${ms} ms`); })]);
  const add = async (name, ok, detail, shotIt = true) => {
    res.checks.push({ name, ok, detail });
    log(tag, ok ? "PASS" : "FAIL", name, ok ? "" : JSON.stringify(detail).slice(0, 300));
    if (!ok && shotIt) { try { await b.shot(join(OUT, `${tag}_${name.replace(/[^a-z0-9]+/gi, "_")}.png`)); } catch { /* */ } }
  };
  try {
    await openApp(b);
    await loadWorkflow(b);
    await sleep(2500);
    let app = await toAppMode(b); if (!app) { await sleep(3000); app = await toAppMode(b); }
    await sleep(1200); await b.key("Escape");
    await b.ev(INSTALL); await openFull(b);
    await b.ev(`const s=document.createElement('style'); s.id='qa-still'; s.textContent=${JSON.stringify(STILL_CSS)}; document.head.append(s); return 1`);
    for (let i = 0; i < 60; i++) {
      if (await b.ev(INSTALL).catch(() => 0) && await b.ev("return !!(window.__qa && window.__qa.node && window.__qa.node.ssDemo)")) break;
      if (i === 15 || i === 35) { await toAppMode(b); await sleep(1500); await b.key("Escape"); await openFull(b); }
      await sleep(2000);
    }
    await js("const p=__qa.p; if (p) { p._refreshStop = async () => {}; p.stopBtn.hidden = true; } return 1");
    await js("await __qa.node.ssDemo.load(); return 1", 240000);
    await sleep(6000);
    for (let i = 0; i < 20; i++) { if (await b.ev(INSTALL) && await b.ev("return !!(window.__qa.stage && window.__qa.p)")) break; await sleep(1500); }
    for (let t = 0; t < 3; t++) {
      if (await b.ev("return !!(window.__qa?.stage && document.querySelector('.ss-stage.ss-full .ss-tabs'))").catch(() => false)) break;
      if (t === 2) throw new Error("the App did not come up (no full workspace with the demo stage)");
      await toAppMode(b); await sleep(1500); await b.key("Escape"); await b.ev(INSTALL).catch(() => 0); await openFull(b); await sleep(2500);
    }
    await b.ev(PAGE);
    const mark0 = b.logs.length;
    const ensureFull = async () => { if (!(await js("return !!document.querySelector('.ss-stage')?.classList.contains('ss-full')"))) { await openFull(b); await sleep(1200); } };
    const go = async (k) => {
      await ensureFull();
      if (STEPS.includes(k)) await js(`__qa.p.go('${k}'); return 1`);
      else await js(`const n=__qa.node; const t=[...document.querySelectorAll('.ss-stage button')].find(b=>b.dataset.tab==='${k}'); if (t) { t.click(); return 1 } return 0`);
      await sleep(1600);
      await ensureFull();
    };
    const tracks = async (open) => {
      const now = await js("return document.querySelector('.ss-stage .ss-clarea')?.dataset.tl || ''");
      if ((now === "open") !== open) { await js("document.querySelector('.ss-stage .ss-tltog')?.click(); return 1"); await sleep(900); }
    };

    // ---- 1. the top row
    if (ONLY.has("toprow")) {
      const views = [...STEPS, ...TOOLS, "stop"];
      for (const v of views) {
        if (v === "stop") { await go("set"); await js("__qa.p.stopBtn.hidden = false; document.getElementById('qa-stopoff')?.remove(); return 1"); await sleep(600); }
        else await go(v);
        const r = JSON.parse(await js("return window.__fq.toprow()"));
        await add(`toprow [${v}]`, !r.error && !r.bad.length && r.count > 4, r.error || { bad: r.bad, folded: r.folded, row: r.row });
        if (v === "set" || v === "stop") {
          // the ⋯ menu holds the rest: inside the window, every item clickable, Esc closes it
          if (r.folded?.length) {
            const at = JSON.parse(await js("const m=document.querySelector('.ss-stage.ss-full .ss-morebtn'); const q=m.getBoundingClientRect(); return JSON.stringify({x:q.left+q.width/2,y:q.top+q.height/2})"));
            await b.click(at.x, at.y, { after: 500 });
            const m = JSON.parse(await js("return window.__fq.menu()"));
            const same = JSON.stringify([...(m.items || [])].sort()) === JSON.stringify([...r.folded].sort());
            await add(`more_menu [${v}]`, !m.error && m.inside && !m.bad.length && same, m.error || { items: m.items, folded: r.folded, bad: m.bad, inside: m.inside });
            await b.key("Escape"); await sleep(350);
            const gone = await js("return ![...document.querySelectorAll('.ss-moremenu')].some(e=>e.getClientRects().length) && !document.querySelector('body > .ss-pophost')");
            await add(`more_menu_closes [${v}]`, gone, { gone });
          }
        }
        if (v === "stop") await js("__qa.p.stopBtn.hidden = true; return 1");
      }
    }

    // ---- 2. every control in the App, step by step (tracks folded, then open on ③ Set)
    if (ONLY.has("app")) {
      for (const v of [...STEPS, ...TOOLS, "set+tracks"]) {
        if (v === "set+tracks") { await go("set"); await tracks(true); } else await go(v);
        const r = JSON.parse(await js("return window.__fq.app()"));
        await add(`app [${v}]`, !r.bad.length && r.count > 5, { count: r.count, bad: r.bad.slice(0, 12) });
        if (v === "set+tracks") await tracks(false);
      }
    }

    // ---- 3. Physics never covers the shot strip
    if (ONLY.has("physics")) {
      await go("set"); await tracks(true);
      // the accent button keeps its contrast on hover ("+ Shot" went dark text on dark: QA 2026-11-02)
      const at = JSON.parse(await js("const e=[...document.querySelectorAll('.ss-strip-bar button.ss-primary')].find(x=>x.getClientRects().length); if(!e) return 'null'; const r=e.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})"));
      if (at) {
        await b.move(at.x, at.y); await sleep(250);
        const c = JSON.parse(await js(`const e=document.elementFromPoint(${at.x},${at.y})?.closest('button'); const cs=getComputedStyle(e);
          const rgb=(s)=>(s.match(/[\d.]+/g)||[]).slice(0,3).map(Number); const L=(c)=>{const [r,g,b]=c.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*r+0.7152*g+0.0722*b;};
          const a=L(rgb(cs.backgroundColor)), t=L(rgb(cs.color)); return JSON.stringify({hover:e.matches(':hover'), bg:cs.backgroundColor, color:cs.color, ratio:+((Math.max(a,t)+0.05)/(Math.min(a,t)+0.05)).toFixed(2)})`));
        await add("primary_hover_contrast [+ Shot]", c.hover && c.ratio >= 4.5, c);
        await b.move(5, 5);
      }
      const on = await js(`const st=__qa.stage; const a=st.toJSON().actors; const pick=a.find(x=>/car/.test(x.kind))||a[0]; if(pick) st.select(pick.id);
        await new Promise(r=>setTimeout(r,700)); const pb=[...__qa.el.querySelectorAll('button')].find(x=>x.textContent.trim()==='Physics'&&x.getClientRects().length); pb?.click(); return !!pb`);
      await sleep(1500);
      const open = await js("return !!document.querySelector('.ss-stage .ss-phys:not([hidden])')");
      const r = JSON.parse(await js("return window.__fq.app('.ss-strip button, .ss-strip-clip, .ss-strip-more, .ss-bottom button, .ss-bottom input, .ss-bottom select')"));
      const mode = await js("return document.querySelector('.ss-stage .ss-clarea')?.dataset.phys || ''");
      await add("physics_vs_strip [tracks open]", on && open && !r.bad.length && r.count > 3, { on, open, mode, count: r.count, bad: r.bad.slice(0, 12) });
      const all = JSON.parse(await js("return window.__fq.app()"));
      await add("physics_app [tracks open]", !all.bad.length, { mode, bad: all.bad.slice(0, 12) });
      await tracks(false); await sleep(600);
      const r2 = JSON.parse(await js("return window.__fq.app('.ss-bottom button, .ss-bottom input, .ss-phys button, .ss-phys input, .ss-phys select')"));
      const mode2 = await js("return document.querySelector('.ss-stage .ss-clarea')?.dataset.phys || ''");
      await add("physics_vs_strip [tracks folded]", !r2.bad.length, { mode: mode2, bad: r2.bad.slice(0, 12) });
      await js("const x=__qa.el.querySelector('.ss-phys:not([hidden]) .ph-head button'); x?.click(); __qa.stage.select(null); return 1");
    }
    res.consoleErrors = b.logs.slice(mark0).filter((l) => /^(EXC|ERR)/.test(l) && !noise(l)).map((l) => l.slice(0, 200));
    if (res.consoleErrors.length) await add("console", false, res.consoleErrors.slice(0, 6), false);
    res.blocked = await b.ev("return (window.__blocked||[]).filter(x=>x.m!=='GET').length").catch(() => -1);
  } catch (e) {
    res.errors.push(String(e.stack || e.message || e).slice(0, 400));
    log(tag, "ERROR", String(e.message || e).slice(0, 200));
  } finally { b.close(); }
  return res;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const all = [];
  const queue = SIZES.map((s, i) => [s, PORT + i]);
  await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    while (queue.length) { const [s, p] = queue.shift(); all.push(await checkSize(s, p)); }
  }));
  const rows = all.flatMap((r) => r.checks);
  const fails = rows.filter((r) => !r.ok);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ when: new Date().toISOString(), local: LOCAL, sizes: all }, null, 1));
  const md = ["# Fit check: top row, every control, Physics vs the strip", "", `${rows.length} checks, ${fails.length} failed. Sizes: ${SIZES.map((s) => s.join("x")).join(", ")}.`, ""];
  for (const r of all) {
    md.push(`## ${r.size}`, "");
    if (r.errors.length) md.push(...r.errors.map((e) => `- ERROR ${e}`), "");
    for (const c of r.checks) md.push(`- ${c.ok ? "PASS" : "**FAIL**"} ${c.name}${c.ok ? "" : `: ${JSON.stringify(c.detail).slice(0, 600)}`}`);
    md.push("");
  }
  writeFileSync(join(OUT, "report.md"), md.join("\n"));
  log(`${rows.length} checks, ${fails.length} failed -> ${OUT}/report.md`);
  process.exit(fails.length || all.some((r) => r.errors.length) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
