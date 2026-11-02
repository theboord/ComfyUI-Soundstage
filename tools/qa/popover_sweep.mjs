#!/usr/bin/env node
// Popover sweep: every menu, drop-down, context menu and pop-over of the App must open fully inside the window, with
// every item visible and clickable (not cut off by a scrolling box, not under another panel). A hidden Chrome opens the
// App with the demo scene, then for each window size and each panel state (Tracks, Presets, Physics, Parts and
// Director open in turn) opens every menu with a real click, measures it, presses Esc and checks that it closed.
//
//   node tools/qa/popover_sweep.mjs                          # 1024x640, 1280x800, 1600x1000, 1920x1080; exits 1 on a failure
//   node tools/qa/popover_sweep.mjs --sizes 1024x640 --only strip_add,tools_menu --states none,tracks
//   node tools/qa/popover_sweep.mjs --local ui/popover.mjs,cut/strip.mjs   # serve these web/ files from the repo
//   options: --port 9980 (first DevTools port; each size takes the next)  --jobs 2  --out <dir>
//
// Never queues a render (tools/qa/lib.mjs's guard answers every POST to the queue locally). Writes report.json and
// report.md (and a PNG of every failure) to tests/visual/out/popovers-<time>/ unless --out says otherwise.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, openApp, loadWorkflow, toAppMode, openFull, INSTALL, STILL_CSS, noise, sleep, REPO } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SIZES = opt("sizes", "1024x640,1280x800,1600x1000,1920x1080").split(",").map((s) => s.split("x").map(Number));
const ONLY = opt("only", "") ? new Set(opt("only").split(",")) : null;
const STATES = opt("states", "none,tracks,presets,presets_tracks,physics,physics_tracks,parts,director").split(",");
const PORT = +opt("port", "9980");
const JOBS = Math.max(1, +opt("jobs", "2"));
const LOCAL = opt("local", "") ? opt("local").split(",") : [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = opt("out", join(REPO, "tests", "visual", "out", `popovers-${stamp}`));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Page-side checks (window.__pq). check(sel) measures every open pop-over matching sel:
 *  - its box must lie inside the window (1 px slack);
 *  - nothing may cover or clip it: a 3x3 grid of points on it must hit the pop-over itself (elementFromPoint);
 *  - every item (button, option, link, field) must be reachable: scrolled into view inside the pop-over's own scrolling
 *    boxes only (never by scrolling the page or a panel under it), its centre must then hit the item.
 */
const PAGE = String.raw`(() => {
  if (window.__pq) return 1;
  const vis = (e) => { if (!e || !e.isConnected || !e.getClientRects().length) return false; const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return false; } return true; };
  const desc = (e) => !e ? 'nothing' : (e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ((e.textContent || '').trim() ? ' "' + e.textContent.trim().replace(/\s+/g, ' ').slice(0, 24) + '"' : ''));
  const label = (e) => ((e.textContent || '').trim() || e.getAttribute('aria-label') || e.title || e.value || e.tagName).replace(/\s+/g, ' ').slice(0, 40);
  const inside = (root, e) => !!e && (root === e || root.contains(e));
  const roots = (sel) => { const all = [...document.querySelectorAll(sel)].filter(vis); return all.filter((e) => !all.some((o) => o !== e && o.contains(e))); };
  function check(root) {
    const vw = innerWidth, vh = innerHeight, r = root.getBoundingClientRect(), issues = [];
    const box = [r.left, r.top, r.width, r.height].map(Math.round);
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)
      issues.push('outside the window: x ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + vw + ', y ' + Math.round(r.top) + '..' + Math.round(r.bottom) + ' of ' + vh);
    const pe = root.style.getPropertyValue('pointer-events'), pp = root.style.getPropertyPriority('pointer-events');
    root.style.setProperty('pointer-events', 'auto', 'important');
    const cover = new Map();
    for (const fx of [0.02, 0.5, 0.98]) for (const fy of [0.02, 0.5, 0.98]) {
      const x = Math.min(r.right - 3, Math.max(r.left + 3, r.left + r.width * fx)), y = Math.min(r.bottom - 3, Math.max(r.top + 3, r.top + r.height * fy));
      if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
      const hit = document.elementFromPoint(x, y);
      if (!inside(root, hit)) cover.set(desc(hit), (cover.get(desc(hit)) || 0) + 1);
    }
    for (const [what, n] of cover) issues.push('cut off or covered at ' + n + '/9 points (by ' + what + ')');
    const saved = [];
    const items = [...root.querySelectorAll('button, [role=menuitem], [role=option], a[href], input:not([type=hidden]), select, textarea, summary')].filter(vis);
    let bad = 0;
    for (const it of items) {
      // scroll it into view inside the pop-over only
      for (let s = it.parentElement; s && s !== root.parentElement; s = s.parentElement) {
        const cs = getComputedStyle(s); if (!/(auto|scroll)/.test(cs.overflowY + cs.overflowX)) continue;
        const sr = s.getBoundingClientRect(), ir = it.getBoundingClientRect();
        saved.push([s, s.scrollTop, s.scrollLeft, s.style.scrollBehavior]);
        s.style.scrollBehavior = 'auto';   // a smooth-scrolling rail would still be moving when we look
        // to the middle of the box: a sticky header (a search field) never sits over it
        if (ir.top < sr.top || ir.bottom > sr.bottom) s.scrollTop += (ir.top + ir.height / 2) - (sr.top + sr.height / 2);
        if (ir.left < sr.left || ir.right > sr.right) s.scrollLeft += (ir.left + ir.width / 2) - (sr.left + sr.width / 2);
        if (s === root) break;
      }
      const ir = it.getBoundingClientRect(), x = ir.left + ir.width / 2, y = ir.top + ir.height / 2;
      if (x < 0 || y < 0 || x >= vw || y >= vh) { if (bad++ < 6) issues.push('item "' + label(it) + '" is outside the window'); continue; }
      const hit = document.elementFromPoint(x, y);
      if (!inside(it, hit) && !(hit && it.contains && hit.contains(it))) { if (bad++ < 6) issues.push('item "' + label(it) + '" cannot be clicked (under ' + desc(hit) + ')'); }
    }
    if (bad > 6) issues.push('... ' + (bad - 6) + ' more items unreachable');
    for (const [s, t, l, sb] of saved.reverse()) { s.scrollTop = t; s.scrollLeft = l; s.style.scrollBehavior = sb; }
    if (pe) root.style.setProperty('pointer-events', pe, pp); else root.style.removeProperty('pointer-events');
    const cs = getComputedStyle(root);
    return { box, items: items.length, issues, scrolls: root.scrollHeight > root.clientHeight + 2 && /(auto|scroll)/.test(cs.overflowY), layer: !!root.closest('.ss-pophost') };
  }
  window.__pq = {
    vis, desc,
    check(sel) { const rs = roots(sel); return JSON.stringify(rs.length ? rs.map(check) : []); },
    open(sel) { return roots(sel).length; },
    // A real click needs the trigger's centre, scrolled into view inside its panel; null when it is not on screen.
    at(sel, nth = 0, text = '') {
      let all = [...document.querySelectorAll(sel)].filter(vis);
      if (text) { const re = new RegExp(text, 'i'); all = all.filter((e) => re.test((e.textContent || '').trim() + ' ' + (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))); }
      if (!all.length) {
        const any = [...document.querySelectorAll(sel)];
        // folded into the top row's "⋯" menu (ui/toprow.mjs) at this width: the run opens it from there
        const f = any.find((e) => e.classList.contains('ss-ovf'));
        if (f) return JSON.stringify({ folded: [...f.classList].find((c) => /^ss-.+btn$/.test(c) && c !== 'ss-btn') || '' });
        // in the Properties column while Physics is docked over it: under that panel, like a covered trigger
        const d = any.find((e) => e.closest('.ss-clarea[data-phys=dock] > .ss-insp') && e.getClientRects().length);
        if (d) { const r = d.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; return JSON.stringify({ x, y, covered: true, by: desc(document.elementFromPoint(x, y)), label: label(d) }); }
      }
      const e = all[nth]; if (!e) return 'null';
      e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return JSON.stringify({ x, y, covered: !inside(e, hit) && !(hit && e.contains(hit)), by: desc(hit), label: label(e) });
    },
  };
  return 1;
})()`;

// ---------------------------------------------------------------------------------------------------- the menus
// Each case: where (a step), the trigger (a CSS selector, optional text match, or a function that opens it), the
// pop-over's selector, and needs: "tracks" (the shot strip under the canvas).
const STRIP = ".ss-strip-menu";
export const CASES = [
  { name: "scene_picker", what: "Top row: the scene picker", step: "set", trigger: ".ss-scpick", pop: ".ss-scenepop" },
  { name: "tools_menu", what: "Top row: Tools ▾", step: "set", trigger: ".ss-toolsbtn", pop: ".ss-toolsmenu" },
  { name: "look_pop", what: "Viewport: Look (style presets)", step: "set", trigger: ".ss-cl-lookbtn", pop: ".ss-clpop" },
  // with no tips the Coach pill opens nothing: skipped then
  { name: "coach", what: "Viewport: the Coach tips", step: "set", trigger: ".ss-coach-toggle", pop: ".ss-coach-cards", close: "click",
    skipIf: "const t=[...document.querySelectorAll('.ss-coach-toggle')].find(e=>e.getClientRects().length); return !t || !+(t.dataset.count||0)" },
  { name: "strip_add", what: "Cut strip: + Shot", step: "set", needs: "tracks", trigger: ".ss-strip-bar button.ss-primary", pop: STRIP },
  { name: "strip_clip_more", what: "Cut strip: a clip's … menu", step: "set", needs: "tracks",
    prep: "const c=[...document.querySelectorAll('.ss-strip-clip')].filter(e=>e.getClientRects().length).pop(); if(c) c.classList.add('ss-active'); return !!c",
    trigger: ".ss-strip-clip.ss-active .ss-strip-more", pop: STRIP },
  { name: "strip_clip_ctx", what: "Cut strip: right-click a clip", step: "set", needs: "tracks", trigger: ".ss-strip-clip", nth: -1, right: true, pop: STRIP },
  { name: "phone_pop", what: "Properties › Camera: Phone viewfinder (QR)", step: "set",
    prep: "const t=[...document.querySelectorAll('.ss-insp-tab')].find(b=>/Camera/.test(b.textContent)); t?.click(); return !!t",
    trigger: ".ss-insp button", text: "^Phone viewfinder", pop: ".ss-vf-pop", close: "x", slow: true },
  // the buttons the row has no room for (ui/toprow.mjs); nothing to open when everything fits
  { name: "more_menu", what: "Top row: ⋯ (the buttons the row has no room for)", step: "set", trigger: ".ss-morebtn", pop: ".ss-moremenu",
    skipIf: "return ![...document.querySelectorAll('.ss-stage.ss-full .ss-morebtn')].some(e=>e.getClientRects().length)" },
  { name: "keys_sheet", what: "Top row: keyboard shortcuts", step: "set", trigger: ".ss-keysbtn", pop: ".ss-keys .card, .ss-keys > div, .ss-keys", panel: true },
  { name: "guide_tour", what: "Top row: Guide (the tour card)", step: "set", trigger: ".ss-guidebtn", pop: ".ss-tour .card, .ss-tour [role=dialog], .ss-tour", panel: true },
  { name: "import_video", what: "Import video: 'What is this video for?'", step: "set",
    open: `const t=document.querySelector('.ss-stage .ss-clarea') || document.querySelector('.ss-stage'); const dt=new DataTransfer();
      dt.items.add(new File([new Uint8Array(64)], 'qa_clip.mp4', { type: 'video/mp4' }));
      t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1`,
    pop: ".ss-vi-modal .card", close: "js:document.querySelector('.ss-vi-modal .cancel')?.click()", panel: true },
  // Other steps (no Set panel applies there): once per size.
  { name: "script_scenes", what: "⑤ Motion: the Shots row's scene switcher", step: "motion", once: true, trigger: ".ss-scsw-btn", pop: ".ss-scsw-menu" },
  { name: "frame_pops", what: "④ Frame: each settings pop-over", step: "frame", once: true, trigger: ".ss-clpopbtn", each: true, pop: ".ss-clpop2", close: "x" },
  { name: "motion_pops", what: "⑤ Motion: each settings pop-over", step: "motion", once: true, trigger: ".ss-clpopbtn", each: true, pop: ".ss-clpop2", close: "x" },
  { name: "dailies_arrange", what: "Takes (Dailies): Arrange ▾", step: "dailies", once: true, trigger: ".ss-dailies .dl-btn[aria-haspopup=menu]", pop: ".dl-menu" },
  { name: "review_approval", what: "⑥ Review: a take's review pop-over", step: "review", once: true, trigger: "button.ss-appr", pop: ".ss-appr-pop", optional: true },
  { name: "cut_ctx", what: "Cut editor: right-click a clip", step: "cut", once: true,
    // a point on a clip, found with the editor's own hit test
    open: `const cv=[...document.querySelectorAll('canvas')].find(c=>c.__soundstageCut&&c.getClientRects().length); if(!cv) return 0; const L=cv.__soundstageCut;
      const r=cv.getBoundingClientRect(); for (let y=4; y<r.height; y+=6) for (let x=4; x<r.width; x+=12) { const h=L._hit(x,y); if (!h||h.type!=='clip') continue;
        const X=r.left+x+8, Y=r.top+y+4; if (X>=innerWidth||Y>=innerHeight||document.elementFromPoint(X,Y)!==cv) continue; return JSON.stringify({x:X, y:Y}); } return 0`,
    ctxCanvas: true, pop: ".ss-cut-ctx" },
  { name: "advisor_strip_add", what: "Shot ideas (Advisor): the docked strip's + Shot", step: "advisor", once: true, trigger: ".ss-strip-bar button.ss-primary", pop: STRIP },
];

// ---------------------------------------------------------------------------------------------------- panel states
const STATE_JS = {
  none: { on: "return 1", off: "return 1" },
  tracks: { on: "return 'tracks'", off: "return 'untracks'" },
  presets: { on: "__qa.node.ssPresets.open('camera'); return 1", off: "__qa.node.ssPresets.close(); return 1" },
  physics: { panel: ".ss-phys",
    on: `const st=__qa.stage; const a=st.toJSON().actors; const pick=a.find(x=>/car/.test(x.kind))||a[0]; if(pick) st.select(pick.id);
      await new Promise(r=>setTimeout(r,700)); const pb=[...__qa.el.querySelectorAll('button')].find(x=>x.textContent.trim()==='Physics'&&x.getClientRects().length); pb?.click(); return !!pb`,
    off: "const x=__qa.el.querySelector('.ss-phys:not([hidden]) .ph-head button'); x?.click(); __qa.stage.select(null); return 1" },
  parts: {
    on: `const st=__qa.stage; const a=st.toJSON().actors; const pick=a.find(x=>/sports_car|car/.test(x.kind))||a[0]; if(pick) st.select(pick.id);
      await new Promise(r=>setTimeout(r,700)); const t=[...document.querySelectorAll('.ss-insp-tab')].find(b=>/Object/.test(b.textContent)); t?.click();
      for (const d of __qa.el.querySelectorAll('.ss-parts details')) d.open=true; return !!__qa.el.querySelector('.ss-parts')`,
    off: "__qa.stage.select(null); return 1" },
  director: { on: "__qa.node.ssDirector.open(); return 1", off: "__qa.node.ssDirector.close?.(); return 1" },
};
// the same panels opened with the tracks already open (QA 2026-11-02: Presets then covered the shot strip; opening the
// tracks after the panel closed it first, so the plain states never saw that)
STATE_JS.presets_tracks = { ...STATE_JS.presets, tracks: true };
STATE_JS.physics_tracks = { ...STATE_JS.physics, tracks: true };

async function sweepSize([w, h], port) {
  const tag = `${w}x${h}`;
  const res = { size: tag, results: [], errors: [], setup: [] };
  const b = await launch({ port, w, h, localFiles: LOCAL });
  const js = (code, ms = 30000) => Promise.race([b.ev(`const __qa=window.__qa; ${code}`), sleep(ms).then(() => { throw new Error(`page busy > ${ms} ms`); })]);
  try {
    await openApp(b);
    res.setup.push(["workflow", await loadWorkflow(b)]);
    await sleep(2500);
    let app = await toAppMode(b); if (!app) { await sleep(3000); app = await toAppMode(b); }
    res.setup.push(["appMode", app]);
    await sleep(1200); await b.key("Escape");
    await b.ev(INSTALL); await openFull(b);
    await b.ev(`const s=document.createElement('style'); s.textContent=${JSON.stringify(STILL_CSS + " .ss-stage .ss-stop{display:none!important}")}; document.head.append(s); return 1`);
    for (let i = 0; i < 60; i++) {
      if (await b.ev(INSTALL).catch(() => 0) && await b.ev("return !!(window.__qa && window.__qa.node && window.__qa.node.ssDemo)")) break;
      if (i === 15 || i === 35) { await toAppMode(b); await sleep(1500); await b.key("Escape"); await openFull(b); }
      await sleep(2000);
    }
    await js("const p=__qa.p; if (p) { p._refreshStop = async () => {}; p.stopBtn.hidden = true; } return 1");
    await js("await __qa.node.ssDemo.load(); return 1", 240000);
    await sleep(6000);
    for (let i = 0; i < 20; i++) { if (await b.ev(INSTALL) && await b.ev("return !!(window.__qa.stage && window.__qa.p)")) break; await sleep(1500); }
    // the App must be up (full workspace, demo stage) before any menu is judged: a slow pod gets two more tries
    for (let t = 0; t < 3; t++) {
      if (await b.ev("return !!(window.__qa?.stage && document.querySelector('.ss-stage.ss-full .ss-tabs'))").catch(() => false)) break;
      if (t === 2) throw new Error("the App did not come up (no full workspace with the demo stage): nothing measured at this size");
      await toAppMode(b); await sleep(1500); await b.key("Escape"); await b.ev(INSTALL).catch(() => 0); await openFull(b); await sleep(2500);
    }
    await b.ev(PAGE);
    const mark0 = b.logs.length;
    const tracks = async (open) => {
      const now = await js("return document.querySelector('.ss-stage .ss-clarea')?.dataset.tl || ''");
      if ((now === "open") !== open) { const r = JSON.parse(await b.ev(`${PAGE}; return window.__pq.at('.ss-tltog')`)); if (r) { await b.click(r.x, r.y); await sleep(900); } }
    };
    const ensureFull = async () => { if (!(await js("return !!document.querySelector('.ss-stage')?.classList.contains('ss-full')"))) { await openFull(b); await sleep(1200); } };
    const goStep = async (step) => {
      await ensureFull();
      if (["script", "cast", "set", "frame", "motion", "review", "deliver"].includes(step)) await js(`__qa.p.go('${step}'); return 1`);
      else await js(`const t=[...document.querySelectorAll('.ss-stage button')].find(b=>b.dataset.tab==='${step}'||b.dataset.view==='${step}'); if (t) { t.click(); return 1 } const n=__qa.node; if (n.ssShowView) { n.ssShowView('${step}'); return 1 } return 0`);
      await sleep(1800);
    };
    const shotFail = async (name) => { try { await b.shot(join(OUT, `${tag}_${name}.png`)); } catch { /* */ } };

    async function runCase(c, state) {
      const name = `${c.name}${c.each ? "" : ""}`;
      const out = { case: c.name, what: c.what, state, size: tag };
      const mark = b.logs.length;
      try {
        if (c.skipIf && (await js(c.skipIf))) { out.skipped = "nothing to show here"; out.ok = true; out.pops = []; res.results.push(out); log(tag, state.padEnd(8), "SKIP " + c.name); return; }
        if (c.needs === "tracks") await tracks(true);
        if (c.prep) await js(c.prep);
        await sleep(300);
        await b.ev(PAGE);
        const triggers = c.each ? +(await js(`return [...document.querySelectorAll(${JSON.stringify(c.trigger)})].filter(e=>window.__pq.vis(e)).length`)) : 1;
        out.pops = [];
        for (let k = 0; k < Math.max(1, triggers); k++) {
          const one = { k };
          if (c.open && !c.ctxCanvas) await js(c.open);
          else if (c.ctxCanvas) {
            const r = await js(c.open);
            if (!r || r === 0) { one.error = "the Cut editor's timeline is not on screen"; out.pops.push(one); continue; }
            const g = JSON.parse(r);
            await b.move(g.x, g.y);
            await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: g.x, y: g.y, button: "right", buttons: 2, clickCount: 1 });
            await sleep(40);
            await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.x, y: g.y, button: "right", buttons: 0, clickCount: 1 });
          } else {
            const nth = c.nth === -1 ? `[...document.querySelectorAll(${JSON.stringify(c.trigger)})].filter(e=>window.__pq.vis(e)).length-1` : (c.each ? k : (c.nth || 0));
            let at = JSON.parse(await js(`return window.__pq.at(${JSON.stringify(c.trigger)}, ${nth}, ${JSON.stringify(c.text || "")})`));
            if (at?.folded != null) {
              // the row has no room for it at this width: it is in the "⋯" menu, so open that and click it there
              const m = JSON.parse(await js("return window.__pq.at('.ss-stage.ss-full .ss-morebtn')"));
              if (m && !m.covered) { await b.click(m.x, m.y, { after: 450 }); at = JSON.parse(await js(`return window.__pq.at(${JSON.stringify(`.ss-moremenu [data-ovf-for="${at.folded}"]`)})`)); one.via = "⋯ menu"; }
              else at = null;
            }
            if (!at) { one.error = "trigger not on screen"; out.pops.push(one); continue; }
            one.trigger = at.label;
            if (at.covered) {
              // under the big panel this state opened (Physics over the shot strip): a layout note, not a menu failure
              const panel = STATE_JS[state]?.panel;
              if (panel && (await js(`const e=document.elementFromPoint(${at.x},${at.y}); return !!e?.closest(${JSON.stringify(panel)})`))) {
                one.covered = `trigger under the open ${panel} panel (${at.by})`; out.pops.push(one); continue;
              }
              one.error = `trigger covered by ${at.by}`; out.pops.push(one); continue;
            }
            if (c.right) {
              await b.move(at.x, at.y);
              await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", buttons: 2, clickCount: 1 });
              await sleep(40);
              await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", buttons: 0, clickCount: 1 });
            } else await b.click(at.x, at.y, { after: 150 });
          }
          await sleep(700);
          // a pop-over that fetches first (the phone QR asks the server for a pairing code) gets up to 10 s
          for (let w = 0; c.slow && w < 20 && !(+(await js(`return window.__pq.open(${JSON.stringify(c.pop)})`))); w++) await sleep(500);
          const got = JSON.parse(await js(`return window.__pq.check(${JSON.stringify(c.pop)})`));
          if (!got.length) { one.error = "nothing opened"; out.pops.push(one); continue; }
          Object.assign(one, got[0]);
          if (got.length > 1) one.issues.push(`${got.length} pop-overs open at once`);
          if (one.issues.length) await shotFail(`${c.name}_${state}_${k}`);
          // close: Esc first (every menu and pop-over should close on Esc), else the case's own way
          if (!c.panel || c.close === undefined) {
            await b.key("Escape"); await sleep(350);
            one.escCloses = !(+(await js(`return window.__pq.open(${JSON.stringify(c.pop)})`)));
          }
          if (+(await js(`return window.__pq.open(${JSON.stringify(c.pop)})`))) {
            if (c.close === "x") await js(`const p=[...document.querySelectorAll(${JSON.stringify(c.pop)})].find(e=>window.__pq.vis(e)); (p?.querySelector('.ss-hudp-tog, h4 button, [aria-label=Close]'))?.click(); return 1`);
            else if (c.close?.startsWith?.("js:")) await js(`${c.close.slice(3)}; return 1`);
            else if (c.close === "click" || !c.close) { const t = JSON.parse(await js(`return window.__pq.at(${JSON.stringify(c.trigger || "body")}, 0)`)); if (t && c.trigger) await b.click(t.x, t.y, { after: 200 }); }
            await sleep(400);
          }
          one.closed = !(+(await js(`return window.__pq.open(${JSON.stringify(c.pop)})`)));
          // the layer is left empty once it closed (no host, no stray menu)
          const stray = +(await js("return document.querySelectorAll('body > .ss-pophost').length"));
          if (one.closed && stray) one.issues.push(`${stray} empty pop-over layer(s) left behind`);
          await ensureFull();
          out.pops.push(one);
        }
      } catch (e) { out.error = String(e.message || e).slice(0, 200); }
      out.consoleErrors = b.logs.slice(mark).filter((l) => /^(EXC|ERR)/.test(l) && !noise(l)).map((l) => l.slice(0, 200));
      if (c.optional && out.pops?.length && out.pops.every((p) => p.error === "trigger not on screen")) out.skipped = "not in the demo scene";
      if (out.pops?.length && out.pops.every((p) => p.covered)) { out.skipped = out.pops[0].covered; out.coveredByPanel = true; }
      out.ok = !!out.skipped || (!out.error && !out.consoleErrors.length && out.pops.length > 0 && out.pops.every((p) => !p.error && !(p.issues || []).length));
      res.results.push(out);
      const bad = out.pops.flatMap((p) => p.error ? [p.error] : (p.issues || []));
      log(tag, state.padEnd(8), (out.coveredByPanel ? "UNDER " : out.skipped ? "SKIP " : out.ok ? "PASS " : "FAIL ") + c.name, out.error || out.skipped || "", bad.slice(0, 3).join(" | "));
      if (c.needs === "tracks" && state !== "tracks" && !STATE_JS[state]?.tracks) await tracks(false);
    }

    const setCases = CASES.filter((c) => !c.once && (!ONLY || ONLY.has(c.name)));
    for (const state of STATES) {
      if (!STATE_JS[state]) continue;
      await goStep("set");
      await tracks(state === "tracks" || !!STATE_JS[state].tracks);
      const on = await js(STATE_JS[state].on);
      res.setup.push([state, on]);
      await sleep(1500);
      for (const c of setCases) { if (c.step !== "set") continue; await goStep("set"); await runCase(c, state); }
      await js(STATE_JS[state].off); await sleep(600);
      if (state === "tracks" || STATE_JS[state].tracks) await tracks(false);
    }
    for (const c of CASES.filter((x) => x.once && (!ONLY || ONLY.has(x.name)))) { await goStep(c.step); await b.ev(PAGE); await runCase(c, "none"); }
    res.consoleErrors = b.logs.slice(mark0).filter((l) => /^(EXC|ERR)/.test(l) && !noise(l)).map((l) => l.slice(0, 200));
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
    while (queue.length) { const [s, p] = queue.shift(); all.push(await sweepSize(s, p)); }
  }));
  const rows = all.flatMap((r) => r.results);
  const fails = rows.filter((r) => !r.ok);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ when: new Date().toISOString(), local: LOCAL, sizes: all }, null, 1));
  const under = rows.filter((r) => r.coveredByPanel);
  const md = ["# Popover sweep", "", `${rows.length} checks, ${fails.length} failed, ${under.length} not reachable under an open panel (listed, not counted as menu failures). Sizes: ${SIZES.map((s) => s.join("x")).join(", ")}. States: ${STATES.join(", ")}.`, ""];
  for (const r of all) {
    md.push(`## ${r.size}`, "");
    if (r.errors.length) md.push(...r.errors.map((e) => `- ERROR ${e}`), "");
    for (const x of r.results) {
      const bad = (x.pops || []).flatMap((p) => p.error ? [p.error] : (p.issues || []));
      const esc = (x.pops || []).some((p) => p.escCloses === false) ? " (Esc does not close it)" : "";
      md.push(`- ${x.coveredByPanel ? "**UNDER PANEL**" : x.skipped ? "SKIP" : x.ok ? "PASS" : "**FAIL**"} ${x.case} [${x.state}]${x.skipped ? ` (${x.skipped})` : ""}${esc}${x.error ? ` error: ${x.error}` : ""}${bad.length ? `: ${bad.join("; ")}` : ""}${x.consoleErrors?.length ? ` console: ${x.consoleErrors.join(" / ")}` : ""}`);
    }
    md.push("");
  }
  writeFileSync(join(OUT, "report.md"), md.join("\n"));
  log(`${rows.length} checks, ${fails.length} failed, ${under.length} under an open panel -> ${OUT}/report.md`);
  process.exit(fails.length || all.some((r) => r.errors.length) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
