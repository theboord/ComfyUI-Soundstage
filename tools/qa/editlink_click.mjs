// Edit from the timeline (Directive 9, docs/cut.md), clicked through headless at the Cut level: the real Cut editor
// (web/cut/demo.html), the real Edit in… menu, ✎ and E key (web/cut/editlink.mjs) and the App side's trip, Back pill and
// Replace offer (web/cut/editlink_app.mjs) over a stub App. No ComfyUI and no pod: a GET/HEAD-only server on 127.0.0.1
// serves web/ and /view from a temp folder of synthetic clips that ffmpeg makes (a_v1 red, a_v2 blue, b green, 4 s).
// lib.mjs's guard answers every non-GET to /prompt, /queue, /upload/, /soundstage/ inside the page.
//
//   CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node tools/qa/editlink_click.mjs [--port 8797] [--cdp 9657]
//        [--out <dir>] [--w 1280] [--h 900]
//
// Steps (design §6.3): right-click a clip -> the Edit in… items; Re-generate -> the jump, the hold (clips 0 and 2 on
// a_v1, one history entry); a new render of the shot -> the held clips stay on a_v1, the pill says "new take"; Back ->
// the same clip and playhead, the offer; Replace in cut -> clip 0 plays a_v2 (v1 in its versions), in/out and the
// dissolve unchanged, clip 2 still a_v1, one history entry; ⌘Z / ⇧⌘Z; the exports (two reels, two assets); the ✎ and
// the E key; the viewer's pixels (frame 10 blue now; frame 75 red needs D8's media loader: reported, not failed).
// Exit 1 on any failed check or page error. One screenshot per step goes to --out (default: a temp folder).
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { launch, sleep, REPO } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const port = +opt("--port", 8797), cdp = +opt("--cdp", 9657);
const W = +opt("--w", 1280), H = +opt("--h", 900);
const out = resolve(opt("--out", mkdtempSync(join(tmpdir(), "ss_editlink_"))));
mkdirSync(out, { recursive: true });
const WEB = join(REPO, "web");

// ---- synthetic media: 4 s, 24 fps, one colour each
const media = mkdtempSync(join(tmpdir(), "ss_editlink_media_"));
mkdirSync(join(media, "output", "soundstage"), { recursive: true });
for (const [name, colour] of [["a_v1", "red"], ["a_v2", "blue"], ["b", "green"]]) {
  const f = join(media, "output", "soundstage", `${name}.mp4`);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=24:d=4`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", f], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(f)) { console.error(`ffmpeg failed for ${name}: ${r.stderr || r.error}`); process.exit(1); }
}

// ---- a GET/HEAD-only server: web/ at /, ComfyUI-style /view?filename=&subfolder=&type= from the media folder
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".wav": "audio/wav", ".woff2": "font/woff2" };
const inside = (root, p) => { const f = normalize(p); return f === root || f.startsWith(root + sep) ? f : null; };
const srv = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
  const u = new URL(req.url, "http://x");
  let file = null;
  if (u.pathname === "/view" || u.pathname === "/api/view") {
    file = inside(join(media, u.searchParams.get("type") || "output"), join(media, u.searchParams.get("type") || "output",
      u.searchParams.get("subfolder") || "", u.searchParams.get("filename") || ""));
  } else file = inside(WEB, join(WEB, decodeURIComponent(u.pathname)));
  let st = null;
  try { st = file && statSync(file); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404); res.end(); return; }
  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    const a = range[1] ? +range[1] : 0, b = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Length": b - a + 1, "Content-Range": `bytes ${a}-${b}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file, { start: a, end: b }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(port, "127.0.0.1", r));

// ---- the page side: the fixture, the Cut's host, a stub App with the real editlink_app on it
const SETUP = String.raw`
const TL = await import("/cut/timeline.mjs");
const { savedFields } = await import("/cut/cut.mjs");
const APP = await import("/cut/editlink_app.mjs");
const P = window.cutPanel;
const V = (n, t) => "/view?filename=" + n + "&subfolder=soundstage&type=output" + (t ? "&t=" + t : "");
window.__V = V;
let host = { name: "D9 click-through", fps: 24, width: 1280, height: 720, audio: [], audio_tracks: [], fade_out: { type: "dip_black", frames: 12 },
  shots: [{ id: "a", name: "Sc 3 · Wide", frames: 96, setup: "wide", scene_name: "SC3", renders: { final: V("a_v1.mp4", 1) } },
          { id: "b", name: "Sc 3 · Close", frames: 96, setup: "close", scene_name: "SC3", renders: { final: V("b.mp4", 1) } }],
  cut: [{ shot_id: "a", in: 0, out: 40 }, { shot_id: "b", in: 0, out: 30, trans: { type: "dissolve", frames: 6 } }, { shot_id: "a", in: 40, out: 80 }] };
window.__host = () => host;
window.__setRender = (sid, rung, url) => { host = { ...host, shots: host.shots.map((s) => (s.id === sid ? { ...s, renders: { ...s.renders, [rung]: url } } : s)) }; };
P._getProject = () => host;
P._onChange = (p) => { host = { ...host, ...JSON.parse(JSON.stringify(savedFields(p))) }; };
P.setProject(host);
const log = (window.__log = []);
const bar = document.createElement("nav");
bar.className = "ss-pipe";
const stop = Object.assign(document.createElement("button"), { className: "ss-stop", hidden: true, textContent: "Stop" });
bar.append(Object.assign(document.createElement("button"), { textContent: "⑤ Motion" }), stop);
document.querySelector("main").prepend(bar);
const cutView = document.getElementById("cut");
let link = null;
window.__view = "cut";
function showView(k) {
  window.__view = k;
  cutView.style.display = k === "cut" ? "" : "none";
  if (k === "cut") { P.refresh(); P.resize(); } else P.stop();
  link?.onView(k);
}
const pipeline = {
  bar, stopBtn: stop, chosen: {}, candidates: {}, current: "cut", m: null, f: null,
  ctx: { onRung: (fn) => { window.__rung = fn; }, openCanvas: (u) => log.push(["openCanvas", u]) },
  go: (k) => { log.push(["go", k]); showView(k === "set" ? "stage" : k === "review" ? "ladder" : k); },
  onRippleTake(sid, take) { log.push(["onRippleTake", sid, take.url]); },
  ripple: { setMode: (m) => log.push(["ripple.setMode", m]), _store: (v) => log.push(["ripple._store", v]), editFirstFrame: () => log.push(["editFirstFrame"]) },
  ltx: { store: { put: (sid, s) => log.push(["ltx.put", sid, s]) }, refresh() {}, apply() {} },
  _drawCandidates() {}, _saveChosen() {},
};
const stage = { activeShot: () => ({ id: window.__active || "a" }), setFrame: (f) => log.push(["stage.setFrame", f]), setFreeView() {}, toJSON: () => ({}) };
link = APP.attachEditLink({ api: null, stage, pipeline, cut: P, cutView, oneClick: { open: async (t) => log.push(["oneClick.open", t.ref]) },
  openShot: (sid) => { log.push(["openShot", sid]); window.__active = sid; return true; }, showView, afterTimeChange() {},
  rendersFor: (sid) => ({ ...(host.shots.find((s) => s.id === sid)?.renders || {}) }), viewURL: (f) => V(f.filename),
  showTake: (shot, take) => log.push(["showTake", take.url]), sceneKey: () => "sc3", switchScene: () => ({ ok: true }), say: (m) => log.push(["say", m]) });
P.editLink = link;
window.__showView = showView;
window.__link = link;
// the App's H1 / H2: the Cut's host hook goes to the trip
P._onEditShot = (id, where, ctx) => { log.push(["jump", id, where, JSON.parse(JSON.stringify({ ...ctx, link: undefined }))]); return link.start(id, where, ctx); };
link.onView("cut");
P.fit();
P.seek(17);   // the playhead Back must restore
P.requestDraw();
return { cut: P.project.cut.length, shots: P.project.shots.length };`;

const HELP = String.raw`
window.__plays = () => window.TLmod.layout(window.cutPanel.project).map((r) => { const u = r.shot.renders.final || r.shot.renders.draft || ""; return (u.match(/filename=([^&]+)/) || [])[1] || r.shot.renders.look || "clay"; });
window.__clipPoint = (idx) => { const cv = window.cutPanel.tl, L = window.cutPanel, r = cv.getBoundingClientRect();
  for (let y = 4; y < r.height; y += 4) for (let x = 4; x < r.width; x += 6) { const h = L._hit(x, y); if (h && h.type === "clip" && h.idx === idx) {
    const X = r.left + x + 10, Y = r.top + y + 6; const h2 = L._hit(x + 10, y + 6); if (h2.type === "clip" && h2.idx === idx && document.elementFromPoint(X, Y) === cv) return { x: X, y: Y }; } }
  return null; };
window.__menu = () => { const m = [...document.querySelectorAll(".ss-cut-ctx")].find((e) => e.getClientRects().length); if (!m) return null;
  return { head: m.querySelector(".ss-em-head")?.textContent || "", items: [...m.querySelectorAll("button[role=menuitem]")].map((b) => ({ where: b.dataset.where,
    label: b.querySelector(".ss-em-l")?.textContent || b.textContent, sub: b.querySelector(".ss-em-s")?.textContent || "", disabled: b.disabled })),
    focused: document.activeElement?.dataset?.where || null }; };
window.__pixel = async (f) => { const P = window.cutPanel; P.stop(); P.seek(f);
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 100)); P.requestDraw(); await new Promise((r) => requestAnimationFrame(r)); }
  const d = P.vctx.getImageData(P.viewer.width / 2, P.viewer.height / 2, 1, 1).data; return [d[0], d[1], d[2]]; };
return 1;`;

const report = { out, steps: [], failures: [], clicked: [] };
const check = (step, what, ok, got) => { report.steps.push({ step, what, ok: !!ok, got }); if (!ok) { report.failures.push(`${step}: ${what}`); console.log(`FAIL ${step}: ${what}`, JSON.stringify(got)?.slice(0, 500)); } else console.log(`ok   ${step}: ${what}`); };
const b = await launch({ port: cdp, w: W, h: H });
const snap = (name) => b.shot(join(out, `${name}.png`));
try {
  await b.send("Page.navigate", { url: `http://127.0.0.1:${port}/cut/demo.html?t=${Date.now()}` });
  for (let i = 0; i < 60 && !(await b.ev("return !!window.cutPanel").catch(() => false)); i++) await sleep(250);
  await b.ev(`window.TLmod = await import("/cut/timeline.mjs"); return 1`);
  report.setup = await b.ev(SETUP);
  await b.ev(HELP);
  await sleep(800);
  await snap("00_cut");

  // 1-2 · right-click clip 0: the Edit in… menu
  const p0 = await b.ev("return window.__clipPoint(0)");
  check(2, "found a point on clip 0 with the Cut's own hit test", p0, p0);
  await b.move(p0.x, p0.y);
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p0.x, y: p0.y, button: "right", buttons: 2, clickCount: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p0.x, y: p0.y, button: "right", buttons: 0, clickCount: 1 });
  report.clicked.push("right-click on clip 0");
  await sleep(300);
  const m1 = await b.ev("return window.__menu()");
  await snap("02_menu_clip0");
  const want = ["First frame", "Re-generate", "Re-block", "Ripple", "Paint video-to-video", "Recast camera", "✦ One-click cards…"];
  check(2, "the menu (.ss-cut-ctx) lists First frame, Re-generate, Re-block, Ripple, Paint video-to-video, Recast camera, One-click",
    m1 && want.every((w) => m1.items.some((it) => it.label === w && !it.disabled)), m1);
  check(2, "its head line names the clip and its take", /^Sc 3 · Wide · Final/.test(m1?.head || ""), m1?.head);
  check(2, "the first enabled item has focus (arrows / Enter / Esc work)", m1?.focused === "frame", m1?.focused);

  // 3 · Re-generate: the jump, the hold
  const hist0 = await b.ev("return window.cutPanel.history.length");
  const reg = await b.byText("^Re-generate", ".ss-cut-ctx button");
  await b.click(reg.cx, reg.cy);
  report.clicked.push("Re-generate");
  await sleep(400);
  const j = await b.ev(`const P = window.cutPanel; return { jump: window.__log.find((x) => x[0] === "jump"), go: window.__log.filter((x) => x[0] === "go").map((x) => x[1]),
    cut: P.project.cut.map((e) => ({ take: e.take?.url || null, v: e.take?.version ?? null, uid: e.uid || null })), hist: P.history.length, view: window.__view,
    pill: (() => { const e = document.querySelector(".ss-backpill"); return e && !e.hidden ? e.textContent : null; })() }`);
  await snap("03_regenerate_away");
  const ctx = j.jump?.[3] || {};
  check(3, "the host hook got where = motion and ctx {index 0, uid, take {rung final, url a_v1}, frame}",
    j.jump?.[2] === "motion" && ctx.index === 0 && /^c/.test(ctx.uid || "") && ctx.take?.rung === "final" && /a_v1\.mp4/.test(ctx.take?.url) && ctx.frame >= 0 && !/[?&]t=/.test(ctx.take?.url), j.jump);
  check(3, "⑤ Motion is up (pipeline.go('motion'))", j.go.includes("motion") && j.view === "motion", j.go);
  check(3, "clips 0 and 2 are held at a_v1, clip 1 is not, one uid", /a_v1/.test(j.cut[0].take) && /a_v1/.test(j.cut[2].take) && !j.cut[1].take && j.cut[0].uid && !j.cut[2].uid, j.cut);
  check(3, "history grew by 1", j.hist === hist0 + 1, [hist0, j.hist]);
  check(3, "the Back pill shows in the step bar", /Back to the cut/.test(j.pill || ""), j.pill);

  // 4 · a new render of shot a lands (as the App's executed handler reports it): the held clips stay on a_v1
  const r4 = await b.ev(`const u = window.__V("a_v2.mp4", Date.now()); window.__setRender("a", "final", u);
    window.__rung({ rung: 4, kind: "final", url: u, file: { filename: "a_v2.mp4", subfolder: "soundstage", type: "output" }, shotId: "a" });
    window.cutPanel.refresh(); return { plays: window.__plays(), pill: document.querySelector(".ss-backpill").textContent, cls: document.querySelector(".ss-backpill").className }`);
  await snap("04_new_take_landed");
  check(4, "after the shot's new render and refresh(), clips 0 and 2 still play a_v1", r4.plays[0] === "a_v1.mp4" && r4.plays[2] === "a_v1.mp4" && r4.plays[1] === "b.mp4", r4.plays);
  check(4, "the pill says new take", /new take/.test(r4.pill) && /ss-new/.test(r4.cls), r4.pill);

  // 5 · Back, then Replace in cut from the offer
  await b.ev(`window.cutPanel.sel = 1; window.cutPanel.seek(0); return 1`);   // move away; Back must restore clip 0 and the playhead
  const backBtn = await b.rect(".ss-backpill .ss-back");
  await b.click(backBtn.cx, backBtn.cy);
  report.clicked.push("↩ Back to the cut");
  let offer = null;
  for (let i = 0; i < 40; i++) {
    offer = await b.ev(`const o = document.querySelector(".ss-editoffer"); const r = [...(o?.querySelectorAll("button") || [])].find((x) => x.textContent === "Replace in cut");
      return { shown: !!o && !o.hidden, text: o?.textContent || "", ready: !!r && !r.disabled, view: window.__view, sel: window.cutPanel.sel, frame: window.cutPanel.frame }`);
    if (offer.ready) break;
    await sleep(150);
  }
  await snap("05_back_offer");
  check(5, "Back opens the Cut with clip 0 selected and the playhead where it was (17)", offer.view === "cut" && offer.sel === 0 && offer.frame === 17, offer);
  check(5, "the offer reads New Final for Sc 3 · Wide and Replace is enabled (the take is long enough)", offer.shown && /New Final for Sc 3 · Wide/.test(offer.text) && offer.ready, offer.text);
  const before5 = await b.ev(`const P = window.cutPanel; return { hist: P.history.length, cut: JSON.parse(JSON.stringify(P.project.cut)) }`);
  const rep = await b.byText("^Replace in cut$", ".ss-editoffer button");
  await b.click(rep.cx, rep.cy);
  report.clicked.push("Replace in cut");
  await sleep(300);
  const a5 = await b.ev(`const P = window.cutPanel; return { hist: P.history.length, cut: JSON.parse(JSON.stringify(P.project.cut)), plays: window.__plays(),
    offer: !document.querySelector(".ss-editoffer").hidden, pill: !document.querySelector(".ss-backpill").hidden }`);
  await snap("05_replaced");
  check(5, "clip 0 plays a_v2 and keeps a_v1 as versions[0]", a5.plays[0] === "a_v2.mp4" && /a_v1/.test(a5.cut[0].versions?.[0]?.url) && a5.cut[0].take.version === 2, a5.cut[0]);
  check(5, "clip 0's in/out, uid and clip 1's dissolve are unchanged; fade_out stays",
    a5.cut[0].in === before5.cut[0].in && a5.cut[0].out === before5.cut[0].out && a5.cut[0].uid === before5.cut[0].uid &&
    JSON.stringify(a5.cut[1]) === JSON.stringify(before5.cut[1]), { before: before5.cut[1], after: a5.cut[1] });
  check(5, "clip 2 still plays a_v1", a5.plays[2] === "a_v1.mp4", a5.plays);
  check(5, "history grew by 1, the trip ended (no offer, no pill)", a5.hist === before5.hist + 1 && !a5.offer && !a5.pill, a5);

  // 6 · ⌘Z / ⇧⌘Z on the Cut (Ctrl here)
  await b.ev("window.cutPanel.root.focus(); return 1");
  await b.key("z", { mods: 2 });
  await sleep(150);
  const u6 = await b.ev("return window.__plays()");
  await b.key("z", { mods: 2 | 8 });
  await sleep(150);
  const r6 = await b.ev("return window.__plays()");
  report.clicked.push("Ctrl+Z", "Ctrl+Shift+Z");
  check(6, "Ctrl+Z puts clip 0 back on a_v1, Ctrl+Shift+Z on a_v2", u6[0] === "a_v1.mp4" && r6[0] === "a_v2.mp4", { undo: u6, redo: r6 });

  // 7 · exports: one reel and one asset per file
  const e7 = await b.ev(String.raw`const f = window.cutPanel.exportFiles(); const edl = f[Object.keys(f).find((k) => k.endsWith(".edl"))]; const fcp = f[Object.keys(f).find((k) => k.endsWith(".fcpxml"))];
    const reels = new Set(); let src = []; for (const blk of edl.split("\n\n")) { if (!/FROM CLIP NAME: Sc 3 · Wide/.test(blk)) continue; for (const l of blk.split("\n")) if (/^\d{3} /.test(l)) reels.add(l.split(/\s+/)[1]); }
    return { reels: [...reels].filter((r) => r !== "BL"), assets: (fcp.match(/<asset id="r\d+" name="Sc 3 · Wide"/g) || []).length, files: (edl.match(/SOURCE FILE: \S+/g) || []) }`);
  check(7, "the EDL has two reels for shot a, the FCPXML two assets", e7.reels.length >= 2 && e7.assets === 2, e7);

  // 8 · the ✎ on hover, and the E key
  const p1 = await b.ev("return window.__clipPoint(1)");
  await b.move(p1.x, p1.y, 12);
  await sleep(200);
  const pen = await b.ev(`const e = document.querySelector(".ss-editpencil"); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); const P = window.cutPanel;
    const row = window.TLmod.layout(P.project)[1], c = P.tl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height,
    clip: { left: c.left + P._x(row.recIn), right: c.left + P._x(row.recOut), top: c.top + P._ty, bottom: c.top + P._ty + P._L.th } }`);
  await snap("08_pencil");
  check(8, "hovering clip 1 shows .ss-editpencil inside its rectangle",
    pen && pen.x >= pen.clip.left && pen.x + pen.w <= pen.clip.right + 1 && pen.y >= pen.clip.top && pen.y + pen.h <= pen.clip.bottom + 1, pen);
  if (pen) { await b.click(pen.x + pen.w / 2, pen.y + pen.h / 2); report.clicked.push("✎ on clip 1"); }
  await sleep(300);
  const m8 = await b.ev("return window.__menu()");
  await snap("08_pencil_menu");
  check(8, "a click on the ✎ opens the menu for clip 1", /^Sc 3 · Close/.test(m8?.head || ""), m8?.head);
  await b.key("Escape");
  await sleep(200);
  check(8, "Esc closes it", !(await b.ev("return window.__menu()")), null);
  await b.ev("const P = window.cutPanel; P.sel = 1; P._updateButtons(); P.root.focus(); return 1");
  await b.key("e");
  report.clicked.push("E with clip 1 selected");
  await sleep(300);
  const m8e = await b.ev("return window.__menu()");
  await snap("08_key_e_menu");
  check(8, "E on the selected clip opens the menu, anchored to the clip", /^Sc 3 · Close/.test(m8e?.head || ""), m8e?.head);
  await b.key("Escape");
  await sleep(200);
  check(8, "Esc closes it", !(await b.ev("return window.__menu()")), null);
  // Versions in the menu of the replaced clip: v1 listed, v2 playing, Follow the latest render
  const m8v = await b.ev("window.cutPanel.sel = 0; return 1").then(() => b.key("e")).then(() => sleep(300)).then(() => b.ev("return window.__menu()"));
  await snap("08_versions");
  check(8, "the replaced clip's menu lists v1, v2 (playing) and Follow the latest render",
    m8v && m8v.items.some((x) => x.where === "version" && /^v1 · Final/.test(x.label) && !x.disabled) && m8v.items.some((x) => x.where === "version" && /^v2 · Final/.test(x.label) && x.disabled) &&
    m8v.items.some((x) => x.where === "follow"), m8v?.items.filter((x) => x.where === "version" || x.where === "follow"));
  await b.key("Escape");

  // 9 · the viewer's pixels: frame 10 plays a_v2 (blue) now; frame 75 needs D8's loader for a file no shot render holds
  const px10 = await b.ev("return await window.__pixel(10)");
  const px75 = await b.ev("return await window.__pixel(75)");
  await snap("09_viewer_f75");
  const blue = (c) => c[2] > 150 && c[0] < 90 && c[1] < 90, red = (c) => c[0] > 150 && c[1] < 90 && c[2] < 90;
  check(9, "the viewer shows blue (a_v2) at record frame 10", blue(px10), px10);
  report.pending = { what: "record frame 75 shows red (a_v1, pinned on clip 2): needs D8 to load every URL a layout row plays (cut_interface_v1.md A2)",
    pixel: px75, red: red(px75) };
  console.log(`info 9: frame 75 pixel ${JSON.stringify(px75)} (${red(px75) ? "red: OK" : "not red: expected until D8's media loader lands"})`);

  // 10 · every other jump on clip 1 (shot b, Final), through the menu: what the stub App was asked to do
  const JUMPS = [["First frame", "frame", (L) => L.some((x) => x[0] === "go" && x[1] === "frame")],
    ["Re-block", "stage", (L) => L.some((x) => x[0] === "stage.setFrame" && Number.isInteger(x[1])) && L.some((x) => x[0] === "go" && x[1] === "set")],
    ["Ripple", "ripple", (L) => L.some((x) => x[0] === "ripple._store" && x[1].source === "soundstage/b.mp4 [output]") && L.some((x) => x[0] === "ripple.setMode" && x[1] === "ripple")],
    ["Paint video-to-video", "paint_v2v", (L) => L.some((x) => x[0] === "editFirstFrame")],
    ["Recast camera", "reshoot", (L) => L.some((x) => x[0] === "oneClick.open" && x[1] === "soundstage/b.mp4 [output]")],
    ["✦ One-click cards…", "oneclick", (L) => L.some((x) => x[0] === "oneClick.open")],
    ["Touch up its frame in Paint Studio", "canvas", (L) => L.some((x) => x[0] === "openCanvas")],
    ["Compare in ⑥ Review", "review", (L) => L.some((x) => x[0] === "go" && x[1] === "review")]];
  for (const [text, where, ok] of JUMPS) {
    await b.ev(`window.__link.end({ quiet: true }); window.__showView("cut"); window.__log.length = 0; const P = window.cutPanel; P.sel = 1; P._updateButtons(); P.root.focus(); return 1`);
    await sleep(150);
    await b.key("e");
    await sleep(250);
    const it = await b.byText("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ".ss-cut-ctx button");
    if (!it) { check(10, `${where}: the item is in the menu`, false, text); continue; }
    await b.click(it.cx, it.cy);
    report.clicked.push(text + " (clip 1)");
    await sleep(350);
    const L = await b.ev("return window.__log.map((x) => x.slice(0, 3))");
    const jumped = L.find((x) => x[0] === "jump");
    const trip = await b.ev("const t = window.__link.trip; return t ? { where: t.where, shot: t.clip.shot_id, uid: t.clip.uid } : null");
    check(10, `${text}: the host hook got where=${where}, a trip on shot b, and the App did it`, jumped?.[2] === where && trip?.where === where && trip?.shot === "b" && ok(L), { L: L.filter((x) => x[0] !== "say"), trip });
  }
  await b.ev(`window.__link.end({ quiet: true }); window.__showView("cut"); return 1`);
  await snap("10_after_jumps");

  const errs = b.logs.filter((l) => /^(EXC|ERR)/.test(l) && !/favicon|ResizeObserver/.test(l));
  check("all", "no page errors", !errs.length, errs.slice(-8));
  report.log = await b.ev("return window.__log.filter((x) => x[0] !== 'say').map((x) => x.slice(0, 3))");
} catch (e) {
  report.failures.push(`crashed: ${e.message}`);
  console.log("CRASH", e.stack, b.logs.slice(-10));
} finally {
  b.close();
  srv.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
console.log(`\n${report.steps.filter((s) => s.ok).length}/${report.steps.length} checks passed; screenshots and report.json in ${out}`);
process.exit(report.failures.length ? 1 : 0);
