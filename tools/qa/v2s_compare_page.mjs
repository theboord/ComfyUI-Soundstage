// The page tools/qa/v2s_compare.mjs drives: the real stage (web/stage/stage.mjs), a Video → 3D rebuild loaded into it,
// and the real Video → 3D UI (web/ui/v2scompare.mjs, web/ui/videoimport.mjs) over it. window.__v2c exposes each check.
import { Stage } from "../../web/stage/stage.mjs";
import { mountCompare, rleDecode, labelIds, pickPalette } from "../../web/ui/v2scompare.mjs";
import { JobCard, chooseVideoUse, v2sPlan, flawsFromNotes } from "../../web/ui/videoimport.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = (window.__v2c = { state: "starting", errors: [] });
window.addEventListener("error", (e) => st.errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => st.errors.push(String(e.reason?.message || e.reason)));
let inflight = 0, lastNet = performance.now();
const of = window.fetch.bind(window);
window.fetch = (...a) => { inflight++; lastNet = performance.now(); return of(...a).finally(() => { inflight--; lastNet = performance.now(); }); };
async function settle(quietMs = 1500, maxMs = 90000) {
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) { if (inflight === 0 && performance.now() - lastNet > quietMs) return true; await sleep(100); }
  return false;
}
const view = document.getElementById("view");
let stage, compare, chooser = null, job = null;

/** bool HxW (row-major Uint8Array) -> COCO RLE. */
function rleEncode(data, w, h) {
  const counts = [];
  let cur = 0, n = 0;
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { const v = data[y * w + x]; if (v !== cur) { counts.push(n); n = 0; cur = v; } n++; }
  counts.push(n);
  return { size: [h, w], counts };
}
const noScroll = (el) => !!el && el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
const inView = (el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

st.init = async (scenePath, videoPath) => {
  let scene = await (await of(`/data/${scenePath}`)).json();
  scene = scene.scene && !scene.actors ? scene.scene : scene;
  stage = new Stage(document.getElementById("stage"), () => {});
  stage.fetchApi = (u) => window.fetch(u);
  stage.load(scene);
  stage.setFrame(0);
  await settle(2000, 120000);
  stage.setView("color");
  stage.setFreeView?.(false);
  compare = mountCompare({ stage, host: view, videoUrl: `/data/${videoPath}`, onStatus: (t) => { st.status = t; },
    lockCamera: () => { st.locked = true; } });
  compare.setMode("wipe");
  await sleep(1500);
  st.state = "ready";
  return { actors: stage.state.actors.length, scan: stage.state.actors.filter((a) => a.scan).map((a) => a.name), fw: stage.fw, fh: stage.fh };
};

st.bar = () => ({ noScroll: noScroll(compare.el) && noScroll(compare.list), inView: inView(compare.el), box: box(compare.el),
  modes: Object.keys(compare.modeBtns), solve: compare.solveChip.textContent });

st.mode = async (m) => { compare.setMode(m); stage.setFrame(Math.round((stage.state.shot.frames - 1) / 2)); await sleep(1200); return compare.mode; };

/**
 * Fit to plate, measured: a sofa's clip masks are its own ID silhouettes at a known pose on 6 frames; it is then put
 * 0.7 m off, turned 30 deg and shrunk 15 % (a typical LAYOUT miss). Fit must win back >= 0.15 IoU in < 3 s.
 */
st.fitTest = async () => {
  const s = stage.toJSON();
  const last = s.shot.frames - 1;
  const cam0 = s.shots?.[0]?.camera_keys?.[0];
  const p = cam0 ? cam0.target : [0, 0, 3];
  const truth = { id: "qa_sofa", name: "Sofa (QA)", kind: "sofa", position: [p[0], 0, p[2]], keys: [{ frame: 0, position: [p[0], 0, p[2]] }],
    rotation_deg: 20, height_m: 0.85, source: { mask_ref: "objects/qa_sofa" } };
  s.actors.push(truth);
  stage.load(s); stage.setFrame(0); await settle(500, 20000);
  const W = 256, H = Math.round((W * stage.fh) / stage.fw);
  const frames = [0, 1, 2, 3, 4, 5].map((i) => Math.round((i * last) / 5));
  const masks = { objects: { qa_sofa: {} } };
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingEnabled = false;
  const ids = stage.idColors(), raw = stage.state.actors.map((x) => ids[x.id]);
  const k = stage.state.actors.findIndex((x) => x.id === "qa_sofa");
  let cols = null;
  for (const f of frames) {
    g.drawImage(stage.renderFrameTo("id", f), 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;
    cols = cols || pickPalette(px, W * H, raw);
    const lab = labelIds(px, W * H, cols), m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = lab[i] === k ? 1 : 0;
    masks.objects.qa_sofa[f] = rleEncode(m, W, H);
  }
  const area = frames.map((f) => rleDecode(masks.objects.qa_sofa[f]).data.reduce((a, b) => a + b, 0) / (W * H));
  const s2 = stage.toJSON();
  const a = s2.actors.find((x) => x.id === "qa_sofa");
  a.position = [p[0] + 0.7, 0, p[2] - 0.4]; a.keys = [{ frame: 0, position: [...a.position] }]; a.rotation_deg = 50; a.scale = 0.85;
  stage.load(s2); stage.setFrame(0); stage.onChange(stage.toJSON()); await settle(500, 20000);
  compare.masks = masks;
  const before = await compare.scoreAll({ frames: 6 });
  const t0 = performance.now();
  const lb = await compare._localBox("qa_sofa");
  st.dbg = { lb, cam: compare._cams([0])[0].vp.map((x) => +x.toFixed(3)) };
  const fit = await compare.fit("qa_sofa");
  const ms = performance.now() - t0;
  await settle(300, 10000);
  compare.scores = null;
  const after = await compare.scoreAll({ frames: 6 });
  const iouB = before.objects.find((o) => o.id === "qa_sofa")?.iou, iouA = after.objects.find((o) => o.id === "qa_sofa")?.iou;
  // undo restores the displaced pose
  const undone = stage.undo();
  const back = stage.state.actors.find((x) => x.id === "qa_sofa");
  return { dbg: st.dbg, mask_area: area.map((x) => +x.toFixed(4)), iou_before: iouB, iou_after: iouA, gain: iouA - iouB, ms: Math.round(ms), fit,
    undo: !!(undone && back && Math.abs(back.position[0] - (p[0] + 0.7)) < 1e-3), status: st.status, list_noScroll: noScroll(compare.list) && noScroll(compare.el),
    rows: compare.list.querySelectorAll(".obj").length, levels: after.objects.map((o) => o.level), match: after.match };
};

st.names = () => {
  const names = stage.outline().map((o) => o.name || "");
  return { bad: names.filter((n) => /\bDA3\b|^custom$|\bcustom\b/i.test(n)), scanLookAt: stage.state.actors.filter((a) => a.scan).map((a) => a.look_at) };
};

st.chooser = async (videoPath, cast = 3) => {
  const blob = await (await of(`/data/${videoPath}`)).blob();
  const file = new File([blob], "clip.mp4", { type: "video/mp4" });
  chooser = chooseVideoUse(file, { person: "Woman 1", cast, secs: 5.04, history: [] });
  await sleep(3500);
  const card = document.querySelector(".ss-vi-modal .card");
  const adv = card.querySelector("details.adv");
  const closed = { noScroll: noScroll(card), inView: inView(card), box: box(card) };
  adv.open = true;
  await sleep(200);
  const open = { noScroll: noScroll(card), inView: inView(card), box: box(card) };
  return { closed, open, thumbs: card.querySelectorAll(".film img").length, quality: [...card.querySelectorAll(".rrow .seg button")].map((b) => b.textContent) };
};

st.chooserPick = async () => {
  const card = document.querySelector(".ss-vi-modal .card");
  card.querySelector('.seg button[data-k="max"]').click();
  card.querySelector('.seg button[data-k="add"]').click();
  card.querySelector("button.go").click();
  return await chooser;
};

st.jobProgress = () => {
  job = job || new JobCard(view);
  job.start("Video → 3D set: clip.mp4", v2sPlan(121, 32), { onCancel: () => { st.cancelled = true; } });
  job.serverStatus({ state: "running", step: "Solving the camera", step_index: 3, steps: ["Reading every frame", "Measuring depth", "Finding people and things",
    "Solving the camera", "Full-body motion", "Naming what's in frame", "Building the set", "Fusing the set scan", "Writing"],
    queue_position: 3, elapsed_s: 214, eta_s: 431 });
  return { noScroll: noScroll(job.el), inView: inView(job.el), box: box(job.el), text: job.el.textContent };
};

st.jobResult = () => {
  const notes = [{ text: "Camera solve confidence 31 %: the move may be wrong past frame 80", level: "red", fix: { action: "lock_camera", label: "Lock to frame 0" } },
    { text: "Woman 1 occluded frames 40-58: filled", level: "amber" }, { text: "Unidentified object near the window, 1.2 % of frame", level: "amber" },
    { text: "Sofa partly seen: depth completed from a typical sofa", level: "amber" }, "depth: straightened on the floor"];
  const flaws = flawsFromNotes(notes, { lock_camera: () => { st.locked = true; } });
  job.done("Rebuilt, with problems to check", "2 people with 5.0 s of full-body motion, 9 things at real size, and a set scan of the location, seen through the clip's camera (14 keys). Took 12 min 40 s.",
    [{ key: "play", label: "Play the take", icon: "play", go: true, run: () => {} }, { key: "compare", label: "Identical? Compare", icon: "scan-eye", run: () => {} },
      { key: "undo", label: "Undo: bring the old set back", icon: "undo-2", run: () => {} }, { key: "frame", label: "Shoot it → Frame", icon: "image", run: () => {} }], notes.map((n) => n.text || n), flaws);
  const first = job.el.querySelector(".flaws .flaw");
  return { noScroll: noScroll(job.el), inView: inView(job.el), box: box(job.el), firstFlaw: first?.textContent || null,
    firstIsRed: first?.dataset.level === "red", fixButton: !!first?.querySelector("button"), lockedOff: /locked off/i.test(job.el.textContent) };
};

st.state = "loaded";
