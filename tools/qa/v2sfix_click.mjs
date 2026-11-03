// Headless click-through of ↻ Regenerate and Fix this object in a local build of the try-it demo:
//   python3 tools/tryit/build_tryit.py --web web --out <dir>/tryit_build && (cd <dir> && python3 -m http.server 8772 &)
//   node tools/qa/v2sfix_click.mjs http://127.0.0.1:8772/local.html <shots dir>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./lib.mjs";
const URL0 = process.argv[2], DIR = process.argv[3];
mkdirSync(DIR, { recursive: true });
const b = await launch({ port: 9681, w: 1440, h: 900 });
let n = 0; const fails = [];
const check = (c, w) => { console.log(c ? "ok  " : "FAIL", w); if (!c) fails.push(w); };
const shot = async (name) => b.shot(join(DIR, `${String(++n).padStart(2, "0")}_${name}.jpg`), { jpeg: { quality: 70 } });
const js = (code) => b.ev(`const D = window.__demo, node = D?.node, stage = node?.ssStage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)); ${code}`);
try {
  await b.send("Page.navigate", { url: `${URL0}?t=${Date.now()}#stunt--v2s` });
  for (let i = 0; i < 60; i++) { await sleep(500); try { if (await b.ev("return !!window.__demo?.node?.ssStage")) break; } catch {} }
  for (let i = 0; i < 40; i++) { await sleep(500); if (await js("return !!document.querySelector('.ss-vi-modal')")) break; }
  await sleep(1000);
  await js("[...document.querySelectorAll('.ss-vi-modal button')].find(x=>/^Rebuild$/.test(x.textContent.trim()))?.click(); return 1");
  for (let i = 0; i < 60; i++) { await sleep(500); if (await js("return !!document.querySelector('.ss-vi-job [data-act=regen]')")) break; }
  const card = await js("return document.querySelector('.ss-vi-job')?.innerText || ''");
  await shot("result_card");
  check(/Regenerate/.test(card), `the result card offers ↻ Regenerate (${card.replace(/\s+/g, " ").slice(0, 160)})`);
  await js("document.querySelector('.ss-vi-job [data-act=regen]').click(); return 1");
  await sleep(800);
  const dlg = await js("return [...document.querySelectorAll('.ss-vi-modal [data-lock]')].map(c=>c.dataset.lock+':'+c.checked).join(',')");
  await shot("regen_dialog");
  check(/camera:.*performer:.*set:/.test(dlg), `the dialog asks what to keep (${dlg})`);
  await js("document.querySelector('.ss-vi-modal [data-lock=set]').click(); document.querySelector('[data-act=regen-go]').click(); return 1");
  await sleep(4000);
  const fail = await js("return (document.querySelector('.ss-vi-job')?.innerText || '') + ' || ' + (document.querySelector('.ss-toast, #toast, .toast')?.innerText || '')");
  await shot("regen_full_install");
  check(/full install/i.test(fail), `Regenerate in the demo gives the full-install note (${fail.replace(/\s+/g, " ").slice(0, 200)})`);
  const actors = JSON.parse(await js("return JSON.stringify(stage.toJSON().actors.filter(a=>!a.mocap && a.id!=='v2s_backdrop' && !a.scan).map(a=>a.id))"));
  check(actors.length > 0, `the rebuild has objects to fix (${actors.slice(0, 6).join(", ")})`);
  const id = actors[0];
  await js(`stage.select(${JSON.stringify(id)}); stage.onSelect?.(stage.selectedInfo?.()); return 1`);
  await sleep(600);
  const btn = await js("const b = document.querySelector('[data-act=v2s-fix]'); return b ? String(!b.hidden) : 'none'");
  check(btn === "true", `the selection bar shows Fix this object for ${id} (${btn})`);
  await js("document.querySelector('[data-act=v2s-fix]').click(); return 1");
  await sleep(1500);
  const pick = await js("const p = document.querySelector('.ss-v2c-pick'); return p ? getComputedStyle(p).display : 'none'");
  await shot("fix_pick_mode");
  check(pick === "block", `Fix waits for a click on the source frame (${pick})`);
  const r = JSON.parse(await js("const p = document.querySelector('.ss-v2c-pick').getBoundingClientRect(); return JSON.stringify({x: p.left + p.width*0.5, y: p.top + p.height*0.5})"));
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  await sleep(4000);
  const fixMsg = await js("return document.querySelector('.ss-vi-job')?.innerText || ''");
  await shot("fix_full_install");
  check(/full install/i.test(fixMsg) && /Fix this object/i.test(fixMsg), `Fix in the demo gives the full-install note (${fixMsg.replace(/\s+/g, " ").slice(0, 200)})`);
  const still = await js(`return stage.toJSON().actors.some(a=>a.id===${JSON.stringify(id)})`);
  check(still, "the set is unchanged after the refused fix");
  // Remove, then Undo
  await js(`stage.select(${JSON.stringify(id)}); return 1`);
  const sel = id;
  const view = JSON.parse(await js("const r = stage.canvas.getBoundingClientRect(); return JSON.stringify({x: r.left + r.width*0.5, y: r.top + r.height*0.5})"));
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: view.x, y: view.y, button: "right", clickCount: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: view.x, y: view.y, button: "right", clickCount: 1 });
  await sleep(800);
  const menu = await js("return [...document.querySelectorAll('.ss-v2f-menu [data-fix]')].map(b=>b.dataset.fix).join(',')");
  await shot("right_click_menu");
  check(/add/.test(menu), `right-click over the view opens the fixes menu (${menu})`);
  const selAfter = await js("return stage.selected || ''");
  check(selAfter === sel, `the right-clicked object stays selected (${selAfter})`);
  if (/remove/.test(menu)) {
    await js("document.querySelector('.ss-v2f-menu [data-fix=remove]').click(); return 1");
    await sleep(800);
    const gone = await js(`return !stage.toJSON().actors.some(a=>a.id===${JSON.stringify(sel)})`);
    check(gone, `Remove (not in the video) takes ${sel} out`);
    await js("document.querySelector('.ss-vi-job [data-act=fix-undo]').click(); return 1");
    await sleep(800);
    const back = await js(`return stage.toJSON().actors.some(a=>a.id===${JSON.stringify(sel)})`);
    await shot("after_undo");
    check(back, "Undo puts it back");
  } else check(false, `right-click had no Remove for the selection (${sel})`);
  const errs = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !/favicon|WebGL|GPU stall|503/.test(l));
  check(!errs.length, `no console errors (${errs.slice(0, 3).join(" | ")})`);
} catch (e) { fails.push(e.message); console.log("EXC", e.message); } finally { b.close(); }
console.log(fails.length ? `FAILED ${fails.length}` : "ALL OK");
process.exit(fails.length ? 1 : 0);
