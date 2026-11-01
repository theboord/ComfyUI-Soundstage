// Soundstage QA: a hidden (headless) Chrome driven over the DevTools protocol, with Node's built-in WebSocket.
// No npm packages. Used by tools/qa/visual_baseline.mjs and by the QA rounds' end-to-end scripts.
//
// Safety: a guard runs before any page code and answers every non-GET to /prompt, /queue, /interrupt, /free,
// /settings, /userdata, /upload/ and /soundstage/ locally (no GPU renders, no queue changes, nothing written to
// the server or to Mike's ComfyUI settings). Each run uses a throwaway Chrome profile.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const BASE = process.env.SS_URL || "http://127.0.0.1:8189";

export const GUARD = String.raw`(() => { if (window.__fetchGuard) return; window.__fetchGuard = true; window.__blocked = [];
  try { if (!window.name.includes('FIRSTRUN')) localStorage.setItem('ss_tour_done','1'); } catch {}
  const bad = (u, m) => m !== "GET" && m !== "HEAD" && (/\/(prompt|interrupt|queue|free)(\?|\/|$)/.test(u) || /\/(settings|userdata)(\/|\?|$)/.test(u) || (/\/upload\/|\/soundstage\//.test(u) && !/\/soundstage\/look\/compile/.test(u)));
  const of = window.fetch.bind(window);
  window.fetch = (u, init = {}) => { const url = String((u && u.url) || u); const m = String((init && init.method) || (u && u.method) || 'GET').toUpperCase();
    if (bad(url, m)) { window.__blocked.push({ url, m, t: Date.now() }); return Promise.resolve(new Response(JSON.stringify({ prompt_id: 'blocked', number: 0, node_errors: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
    return of(u, init); };
  const ox = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u, ...a) { if (bad(String(u), String(m).toUpperCase())) { window.__blocked.push({ url: String(u), m, xhr: 1 }); u = 'about:blank'; } return ox.call(this, m, u, ...a); };
  // A downloaded file (the DCC kit, a Layer Pack link) must never leave the page: anchors with download= are swallowed.
  const oc = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { window.__blocked.push({ url: this.href.slice(0, 80), m: 'DOWNLOAD' }); return; } return oc.call(this); };
})();`;

// Freezes CSS animation / transitions / carets so two captures of the same screen match.
export const STILL_CSS = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}";

/** Start a hidden Chrome at w x h. opts: port, firstRun (keep the Guide tour unseen), localFiles (serve these web/ files from the repo),
 *  angle: "swiftshader" (default, what the baselines use) or "metal" (real GPU: use it for demo-scene flows; SS_ANGLE=metal sets it). */
export async function launch({ port = 9770, w = 1440, h = 900, firstRun = false, localFiles = [], angle = process.env.SS_ANGLE || "swiftshader" } = {}) {
  let W = w, H = h;
  const prof = mkdtempSync(join(tmpdir(), "ssqa-"));
  const flags = ["--headless=new", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "--hide-scrollbars",
    ...(angle === "swiftshader" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [`--use-angle=${angle}`, "--enable-gpu", "--ignore-gpu-blocklist"]), "--no-first-run", "--no-default-browser-check", "--mute-audio",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--force-color-profile=srgb", "--font-render-hinting=none", `--user-data-dir=${prof}`, "about:blank"];
  const chrome = spawn(CHROME, flags, { stdio: "ignore" });
  let list;
  for (let i = 0; i < 80 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(250); } }
  if (!list) { chrome.kill(); throw new Error(`Chrome did not start on port ${port}`); }
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const handlers = new Set(); const logs = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "").slice(0, 600));
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning"))
      logs.push((m.params.type === "error" ? "ERR " : "WARN ") + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 600));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") logs.push("NET " + m.params.entry.text + " " + (m.params.entry.url || ""));
    // A "Leave site?" (beforeunload) or alert dialog would stall the page: accept it.
    if (m.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
    for (const hd of handlers) hd(m);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Page.setInterceptFileChooserDialog", { enabled: true });   // a file picker never opens
  await send("Page.addScriptToEvaluateOnNewDocument", { source: (firstRun ? "window.name = window.name.includes('FIRSTRUN') ? window.name : 'FIRSTRUN';" : "") + GUARD });
  // Serve the listed extension files from this repo (check a fix before it is deployed to the pod).
  if (localFiles.length) {
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/extensions/ComfyUI-Soundstage/*", requestStage: "Request" }] });
    handlers.add((m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const rel = decodeURIComponent(new URL(m.params.request.url).pathname.replace(/^.*\/extensions\/ComfyUI-Soundstage\//, ""));
      if (localFiles.includes(rel)) {
        send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }],
          body: readFileSync(join(REPO, "web", rel)).toString("base64") });
      } else send("Fetch.continueRequest", { requestId: m.params.requestId });
    });
  }
  const ev = async (js) => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const rect = (sel, nth = 0) => ev(`const s=${JSON.stringify(sel)}; const all = s.startsWith("JS:") ? [].concat((0,eval)(s.slice(3))||[]) : [...document.querySelectorAll(s)];
    const vis = all.filter((e) => e && e.getClientRects().length && e.getBoundingClientRect().width > 0);
    const e = vis[${nth}]; if (!e) return null; const b = e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height,cx:b.x+b.width/2,cy:b.y+b.height/2};`);
  const byText = (re, sel = "button") => rect(`JS:[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>new RegExp(${JSON.stringify(re)},"i").test((e.textContent||"").trim()))`);
  let px = W / 2, py = H / 2, buttons = 0;
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: buttons || type !== "mouseMoved" ? "left" : "none", buttons, clickCount: 1, pointerType: "mouse", ...extra });
  async function move(x, y, steps = 8) { const x0 = px, y0 = py; for (let i = 1; i <= steps; i++) { px = x0 + (x - x0) * i / steps; py = y0 + (y - y0) * i / steps; await mouse("mouseMoved", px, py); await sleep(8); } }
  async function click(x, y, { after = 250, mods = 0 } = {}) {
    await move(x, y); buttons = 1; await mouse("mousePressed", x, y, { modifiers: mods }); await sleep(50);
    buttons = 0; await mouse("mouseReleased", x, y, { modifiers: mods }); await sleep(after);
  }
  async function clickEl(sel, opts = {}) { const r = typeof sel === "string" ? await rect(sel, opts.nth || 0) : sel; if (!r) return null; await click(r.cx, r.cy, opts); return r; }
  async function clickText(re, sel = "button", opts = {}) { const r = await byText(re, sel); if (!r) return null; await click(r.cx, r.cy, opts); return r; }
  /** Press at (x0,y0), drag in real time to (x1,y1) over dur ms, release. */
  async function drag(x0, y0, x1, y1, dur = 700, { mods = 0 } = {}) {
    await move(x0, y0); buttons = 1;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, modifiers: mods });
    const t0 = Date.now();
    for (;;) { const t = Math.min(1, (Date.now() - t0) / dur); px = x0 + (x1 - x0) * t; py = y0 + (y1 - y0) * t;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "left", buttons: 1, modifiers: mods }); if (t >= 1) break; await sleep(16); }
    await sleep(60); buttons = 0;
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1, modifiers: mods });
  }
  const VK = { Tab: 9, Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Backspace: 8, " ": 32 };
  async function key(k, { mods = 0 } = {}) {
    const code = k.length === 1 ? (k === " " ? "Space" : /[0-9]/.test(k) ? "Digit" + k : "Key" + k.toUpperCase()) : k;
    const v = VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    const text = k.length === 1 && !(mods & 6) ? k : undefined;   // no text with Ctrl / Cmd
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: v, nativeVirtualKeyCode: v, modifiers: mods, text });
    await sleep(40);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: v, nativeVirtualKeyCode: v, modifiers: mods });
  }
  /** Screenshot. jpeg: { quality, width } scales the capture to that width (baselines are ~1280 wide). */
  async function shot(file, { jpeg = null } = {}) {
    const params = jpeg ? { format: "jpeg", quality: jpeg.quality || 62 } : { format: "png" };
    if (jpeg?.width && jpeg.width !== W) params.clip = { x: 0, y: 0, width: W, height: H, scale: jpeg.width / W };
    const r = await send("Page.captureScreenshot", params);
    const buf = Buffer.from(r.result.data, "base64");
    if (file) writeFileSync(file, buf);
    return buf;
  }
  async function resize(w2, h2) { W = w2; H = h2; await send("Emulation.setDeviceMetricsOverride", { width: w2, height: h2, deviceScaleFactor: 1, mobile: false }); await ev("window.dispatchEvent(new Event('resize')); return 1"); }
  const close = () => { try { ws.close(); } catch {} chrome.kill(); try { rmSync(prof, { recursive: true, force: true }); } catch {} };
  return { send, ev, rect, byText, click, clickEl, clickText, drag, key, move, shot, resize, close, logs, handlers, get W() { return W; }, get H() { return H; } };
}

/** Wait for the server, then load ComfyUI and wait for its app. */
export async function openApp(b, url = `${BASE}/?qa=${Date.now()}`) {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/queue`)).status === 200) break; } catch {} await sleep(2000); }
  await b.send("Page.navigate", { url });
  // An evaluate sent while the page is still loading can wait a long time: each check gets 3 s.
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try { if (await Promise.race([b.ev("return !!window.comfyAPI?.app?.app?.graph"), sleep(3000).then(() => false)])) break; } catch {}
  }
  await sleep(1500);
}

/** Load a shipped workflow (example_workflows/<wf>) into the graph. */
export async function loadWorkflow(b, wf = "Soundstage_App.json") {
  const json = readFileSync(join(REPO, "example_workflows", wf), "utf8");
  return b.ev(`const app = window.comfyAPI.app.app; const wf = ${json};
    for (let t = 0; t < 4; t++) { try { await app.loadGraphData(wf); return 1; } catch (e) { await new Promise(r => setTimeout(r, 2000)); } }
    return 0;`);
}

/** Switch ComfyUI to App (linear) mode, where the Soundstage stage sits in the side panel. */
export async function toAppMode(b) {
  return b.ev(`const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const app=window.comfyAPI.app.app;
    const inApp=()=>{ const g=document.querySelector('canvas#graph-canvas'); const gv=!!(g&&g.getClientRects().length&&g.getBoundingClientRect().width>200); return !gv && /Number of runs/.test(document.body.innerText); };
    const ok=()=>{ const e=document.querySelector('.ss-stage'); return inApp() && e && e.getBoundingClientRect().width>50; };
    for (let t=0;t<5 && !ok();t++){ await app.extensionManager.command.execute('Comfy.ToggleLinear'); await sleep(2500); }
    return ok();`);
}

/** Page-side handles: window.__qa = { app, node, p (pipeline), stage, el (the .ss-stage root) }. */
export const INSTALL = `const app=window.comfyAPI.app.app; const el=document.querySelector('.ss-stage');
  const nodes=app.graph?._nodes||[];
  const node=nodes.find(x=>x?.ssStage&&el?.contains(x.ssStage.canvas))||nodes.find(x=>x?.ssStage);
  window.__qa={app,node,p:node?.ssPipeline,stage:node?.ssStage,el};
  return !!node;`;

/** Open the full workspace (the giant canvas) from the App panel. */
export async function openFull(b) {
  const isFull = () => b.ev("return !!document.querySelector('.ss-stage')?.classList.contains('ss-full')");
  if (await isFull()) return true;
  await b.clickText("Open the full workspace"); await sleep(2500);
  return isFull();
}

/**
 * Layout health of the current screen:
 *  pageScroll: the page itself scrolls (scrollHeight > innerHeight), pageOverflowX likewise sideways;
 *  clipped: visible text cut by its own box (scrollWidth > clientWidth) - ellipsis marks the ones cut on purpose;
 *  overlaps: floating panels on the canvas that cover each other; scrollers: boxes in the stage that scroll.
 */
export const METRICS = `const el=document.querySelector('.ss-stage')||document.body;
  const vis=(e)=>{ if(!e||!e.getClientRects().length) return false; const r=e.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; const cs=getComputedStyle(e); return cs.visibility!=='hidden'&&+cs.opacity!==0; };
  const inView=(r)=>r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;
  const R=(e)=>e.getBoundingClientRect();
  const se=document.scrollingElement||document.documentElement;
  const label=(e)=>((e.textContent||e.getAttribute('aria-label')||e.title||'').trim().replace(/\\s+/g,' ').slice(0,48));
  const clipped=[];
  for (const e of el.querySelectorAll('button, label, span, b, strong, h3, h4, small, .lbl, .t, .nm, .status, div')) {
    if (!vis(e) || e.clientWidth<=0) continue;
    if ([...e.childNodes].some(n=>n.nodeType===1 && !/^(SPAN|B|I|SMALL|STRONG|EM|SVG|svg)$/.test(n.tagName))) continue;   // text leaves only
    if (!(e.textContent||'').trim()) continue;
    if (e.scrollWidth <= e.clientWidth + 1) continue;
    const cs=getComputedStyle(e); if (cs.overflowX==='visible' && cs.textOverflow!=='ellipsis') continue;
    if (/(auto|scroll)/.test(cs.overflowX)) continue;   // a strip that scrolls sideways on purpose
    const r=R(e); if (!inView(r)) continue;
    clipped.push({ text: label(e), ellipsis: cs.textOverflow==='ellipsis', w: Math.round(e.clientWidth), need: e.scrollWidth });
  }
  const sel='.ss-hud, .ss-hudp, .ss-clpanel, .ss-cv-panel, .ss-phys, .ss-hudpop, [role=dialog]';
  const panels=[...el.querySelectorAll(sel)].filter(vis).filter(e=>{ const cs=getComputedStyle(e); return cs.position==='absolute'||cs.position==='fixed'; });
  const overlaps=[];
  for (let i=0;i<panels.length;i++) for (let j=i+1;j<panels.length;j++) {
    const a=panels[i], c=panels[j]; if (a.contains(c)||c.contains(a)) continue;
    const ra=R(a), rc=R(c); const ix=Math.min(ra.right,rc.right)-Math.max(ra.left,rc.left), iy=Math.min(ra.bottom,rc.bottom)-Math.max(ra.top,rc.top);
    if (ix>8&&iy>8) overlaps.push({ a: String(a.className).slice(0,40)+' '+label(a).slice(0,20), b: String(c.className).slice(0,40)+' '+label(c).slice(0,20), px: Math.round(ix)+'x'+Math.round(iy) });
  }
  const scrollers=[...el.querySelectorAll('*')].filter(e=>vis(e)&&e.clientHeight>20&&e.scrollHeight>e.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(e).overflowY))
    .map(e=>(typeof e.className==='string'&&e.className?e.className.split(' ')[0]:e.tagName)+' '+e.scrollHeight+'/'+e.clientHeight);
  const offscreen=[...el.querySelectorAll('button')].filter(vis).filter(e=>{ const r=R(e); if(!inView(r)) return false; return r.right>innerWidth+1||r.bottom>innerHeight+1; }).map(label).slice(0,10);
  return JSON.stringify({ view: innerWidth+'x'+innerHeight, pageScroll: se.scrollHeight>innerHeight+2, pageScrollH: se.scrollHeight,
    pageOverflowX: se.scrollWidth>innerWidth+1, clipped: clipped.slice(0,30), clippedHard: clipped.filter(c=>!c.ellipsis).length,
    overlaps: overlaps.slice(0,12), scrollers: scrollers.slice(0,12), offscreen });`;

/** Console lines that are ComfyUI / browser noise, not Soundstage. */
export function noise(l) {
  return /api\.comfy\.org|Three\.js|THREE\.|legacy queue|internal module|user\.css|templates\.json|subgraphs|MaskEditor|layout total|getCanvas: canvas is null|input\.link is deprecated|checkState\(\) is deprecated|swiftshader|WebGL|GPU stall|favicon|manager|ComfyUI-Manager|registry|\[Jobs API\]|Failed to fetch queue|\[DOM\] Input elements|Unrecognized feature|deprecated/i.test(l);
}
