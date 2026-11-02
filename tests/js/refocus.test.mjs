// node --test tests/js/   (✦ Camera › Refocus: the card, the tapped marks, where the depth comes from, the job, the take)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as O from "../../web/oneclick/oneclick.mjs";
import * as R from "../../web/oneclick/refocus.mjs";

const clip = O.makeTarget({ url: "/api/view?filename=final_00028_.mp4&subfolder=soundstage&type=output", shot: "s2", take_id: "t9", take_kind: "final" });
const draft = O.makeTarget({ url: "/api/view?filename=draft_00003_.mp4&subfolder=soundstage&type=output", shot: "s2", take_kind: "draft" });
const still = O.makeTarget({ url: "/api/view?filename=look_00004_.png&subfolder=soundstage&type=output", shot: "s2" });

test("the card is in Camera, works on stills and clips, and is listed for the MCP", () => {
  const s = O.getOneClick("refocus");
  assert.equal(s.group, "Camera");
  assert.equal(O.availability(s, clip), true);
  assert.equal(O.availability(s, still), true);
  assert.ok(O.MODULES.includes("refocus"));
  assert.match(O.costLabel(s, clip), /about 6 min/);
  assert.match(O.costLabel(s, still), /about 1 min/);
  const row = O.catalogFor(clip).find((r) => r.id === "refocus");
  assert.deepEqual(row.fields.filter((f) => f.type === "point").map((f) => f.id), ["a", "b"]);
  // a still has one mark and no pull timing
  const srow = O.catalogFor(still).find((r) => r.id === "refocus");
  assert.deepEqual(srow.fields.map((f) => f.id).filter((id) => ["b", "start", "land"].includes(id)), []);
});

test("tapped points: written as x,y in 0..1 and read back, junk refused", () => {
  assert.equal(O.fmtPoint(0.1234, 2), "0.123,1.000");
  assert.deepEqual(O.readPoint("0.25, 0.75"), [0.25, 0.75]);
  assert.deepEqual(O.readPoint("1.5;-2"), [1, 0]);
  assert.equal(O.readPoint("left"), null);
  assert.equal(O.readPoint(undefined), null);
});

test("the body: marks, T-stop (the shot's when auto), lens, distance, window, highlights", () => {
  const b = R.refocusBody(clip, { a: "0.2,0.4", b: "0.8,0.6", t_stop: "auto", lens: "85", subject_m: "auto", start: "0", land: "1", highlights: false },
    { lens: { t_stop: 1.8, focus_m: 2.4 } });
  assert.deepEqual(b.a, [0.2, 0.4]);
  assert.deepEqual(b.b, [0.8, 0.6]);
  assert.equal(b.t_stop, 1.8);
  assert.equal(b.focal_mm, 85);
  assert.equal(b.subject_m, null);
  assert.equal(b.focus_m, 2.4);
  assert.equal(b.start, 0);              // "0" is a real choice: the top of the take
  assert.equal(b.land, 1);
  assert.equal(b.highlights, false);
  assert.equal(b.source, clip.ref);
  const d = R.refocusBody(still, { a: "0.5,0.5", b: "0.9,0.9", t_stop: "4" });
  assert.equal(d.b, null);               // a still has no pull
  assert.equal(d.t_stop, 4);
  assert.equal(d.focal_mm, null);
  assert.equal(R.refocusBody(clip, {}).t_stop, 2);
  assert.deepEqual(R.refocusBody(clip, {}).a, [0.5, 0.5]);
});

test("depth: the stage's pass is taken only when this take's shot is open; Stage depth asks for it", () => {
  const stage = { captureSequence() {}, activeShot: () => ({ id: "s2" }) };
  const other = { captureSequence() {}, activeShot: () => ({ id: "s7" }) };
  assert.deepEqual(R.depthPlan(clip, stage, {}), { depth: "auto", capture: true, why: "" });
  assert.deepEqual(R.depthPlan(clip, other, {}), { depth: "auto", capture: false, why: "" });
  assert.deepEqual(R.depthPlan(clip, null, {}), { depth: "auto", capture: false, why: "" });
  assert.match(R.depthPlan(clip, other, { depth: "stage" }).why, /open this take's shot/);
  // DA3 with a given distance needs nothing from the stage; without one the stage gives the real distance to A
  assert.equal(R.depthPlan(clip, stage, { depth: "da3", subject_m: "2" }).capture, false);
  assert.equal(R.depthPlan(clip, stage, { depth: "da3" }).capture, true);
});

test("stageLens reads the shot's focal length per frame and its lens keys at frame 0", () => {
  const stage = { _cameraAt: (f) => ({ focal_mm: 35 + f, ...(f === 0 ? { focus_m: 3, t_stop: 2.8 } : {}) }) };
  assert.deepEqual(R.stageLens(stage, 3), { focal_mm: [35, 36, 37], focus_m: 3, t_stop: 2.8, fps: 24 });
  // frames and fps default to the shot's
  const shot = { state: { shot: { frames: 2, fps: 30 } }, _cameraAt: () => ({ focal_mm: 50 }) };
  assert.deepEqual(R.stageLens(shot), { focal_mm: [50, 50], focus_m: null, t_stop: null, fps: 30 });
});

test("Bright bokeh is off unless asked (it is invented light); the lens per frame travels without a depth sheet", () => {
  assert.equal(R.refocusBody(clip, {}).highlights, false);
  assert.equal(R.refocusBody(clip, { highlights: true }).highlights, true);
  assert.equal(O.getOneClick("refocus").fields.find((f) => f.id === "highlights").value, false);
  assert.equal(R.refocusBody(clip, {}).lens, null);
  assert.deepEqual(R.refocusBody(clip, {}, { lens: { focal_mm: [40, 41], fps: 25 } }).lens, { focal_mm: [40, 41], fps: 25 });
});

test("the Run button says no GPU when the stage's depth is picked", () => {
  const s = O.getOneClick("refocus");
  assert.equal(s.gpuWith({ depth: "stage" }), false);
  assert.equal(s.gpuWith({ depth: "auto" }), true);
  assert.equal(s.gpuWith({ depth: "da3" }), true);
});

test("DA3 with a distance given and the shot open: no depth pass, but the shot's lens and T-stop are used", async () => {
  const stage = { state: { shot: { fps: 24, frames: 3 } }, activeShot: () => ({ id: "s2" }),
    _cameraAt: (f) => ({ focal_mm: 85, ...(f === 0 ? { t_stop: 1.4, focus_m: 2 } : {}) }),
    async captureSequence() { throw new Error("must not capture"); } };
  const { calls, uploads } = await runWith(clip, { a: "0.3,0.5", b: "0.7,0.5", depth: "da3", subject_m: "2", t_stop: "auto", lens: "auto" }, stage);
  assert.equal(uploads.length, 0);
  const body = calls[0].body;
  assert.equal(body.stage, null);
  assert.equal(body.t_stop, 1.4);                         // the shot's, not T2
  assert.deepEqual(body.lens, { focal_mm: [85, 85, 85], fps: 24 });   // the shot's lens per frame, not 35 mm
});

test("the mark pickers load a clip's own frames (never its thumbnail), and Before / after plays one soundtrack", () => {
  const src = readFileSync(new URL("../../web/oneclick/oneclick.mjs", import.meta.url), "utf8");
  assert.match(src, /const src = t\?\.kind === "still" \? t\.url : null;/);
  assert.match(src, /R\.lastFrameDataURL\(t\.url\) : R\.firstFrameDataURL\(t\.url\)/);
  assert.match(src, /base\.muted = true; top\.muted = false;/);   // the property: a "muted" attribute set later does not mute
});

async function runWith(target, opts, stage = null) {
  const calls = [], steps = [], uploads = [];
  let polls = 0;
  const api = { async fetchApi(path, init = {}) {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (path === "/soundstage/refocus") return { ok: true, status: 200, json: async () => ({ job: "r1" }) };
    polls++;
    return { ok: true, json: async () => (polls < 2 ? { state: "running", step: "Refocusing frame 3 of 49", progress: 0.4 }
      : { state: "done", result: { file: { filename: "final_00028__rf_ab12cd.mp4", subfolder: R.SUB, type: "output" }, kind: "clip", depth: "da3",
        focus: { t_stop: 2, focal_mm: 50, focus_m: [2, 2, 3.1, 6] }, notes: ["depth: measured before (cached), no GPU", "B is already soft in the picture"] } }) };
  } };
  const said = [];
  const ctx = { api, opts, stage, quality: () => "Draft", seed: () => 3, progress: (t) => steps.push(t), say: (m) => said.push(m),
    upload: async (blob, name, sub, type) => { uploads.push({ name, sub, type }); return `${sub}/${name} [${type}]`; } };
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (f) => orig(f, 0);
  try { return { r: await O.getOneClick("refocus").run(target, ctx), calls, steps, said, uploads }; } finally { globalThis.setTimeout = orig; }
}

test("run: posts the job, follows its steps, lands the take with the pull in its note", async () => {
  const { r, calls, steps, said } = await runWith(clip, { a: "0.3,0.5", b: "0.7,0.5", t_stop: "2" });
  assert.equal(calls[0].path, "/soundstage/refocus");
  assert.deepEqual(calls[0].body.a, [0.3, 0.5]);
  assert.equal(calls[0].body.stage, null);
  assert.match(calls[1].path, /^\/soundstage\/refocus\/job\?id=r1$/);
  assert.equal(r.file.filename, "final_00028__rf_ab12cd.mp4");
  assert.equal(r.kind, "clip");
  assert.equal(R.refocusNote({ kind: "clip", depth: "da3", focus: { t_stop: 2, focal_mm: 50, focus_m: [2, 6] } }), "T2 · 50 mm · 2.0 m → 6.0 m · Depth Anything 3 depth (approximate)");
  assert.match(r.note, /T2 · 50 mm · 2\.0 m → 6\.0 m/);
  assert.ok(steps.some((t) => /Refocusing frame 3 of 49 \(40%\)/.test(t)));
  assert.ok(said.some((m) => /B is already soft/.test(m)));
  assert.ok(!said.some((m) => /cached/.test(m)));
  // the take keeps its kind: a final refocused is a final, a draft a draft, a still a look
  const spec = O.getOneClick("refocus");
  assert.equal(O.makeOneClickTake({ file: r.file, url: "u", spec, target: clip, kind: r.kind }).kind, "final");
  assert.equal(O.makeOneClickTake({ file: r.file, url: "u", spec, target: draft, kind: r.kind }).kind, "draft");
  assert.equal(O.makeOneClickTake({ file: { filename: "x.png" }, url: "u", spec, target: still, kind: "still" }).kind, "look");
  assert.equal(O.makeOneClickTake({ file: r.file, url: "u", spec, target: clip, kind: r.kind }).oneclick.from_take, "t9");
});

test("run with the shot open: the stage's 16-bit depth pass is rendered, uploaded and sent with the lens per frame", async () => {
  const stage = { state: { shot: { fps: 24 } }, activeShot: () => ({ id: "s2" }), _cameraAt: () => ({ focal_mm: 40 }),
    async captureSequence(mode) { this.mode = mode; return { blob: {}, cols: 4, rows: 1, frames: 4, tile: [1024, 576] }; } };
  const { calls, uploads } = await runWith(clip, { a: "0.3,0.5", b: "0.7,0.5" }, stage);
  assert.equal(stage.mode, "depth16");
  assert.equal(uploads[0].sub, R.SUB);
  assert.equal(uploads[0].type, "input");
  const st = calls[0].body.stage;
  assert.deepEqual([st.cols, st.frames, st.tile, st.fps, st.dmax], [4, 4, [1024, 576], 24, 10]);
  assert.deepEqual(st.focal_mm, [40, 40, 40, 40]);
  assert.match(st.sheet, /^soundstage_private\/refocus\/rf_s2_.*\.png \[input\]$/);
});

test("the stage's depth16 pass and the server agree on the encoding (full scale 10 diopters, R high, G low)", () => {
  const stage = readFileSync(new URL("../../web/stage/stage.mjs", import.meta.url), "utf8");
  const py = readFileSync(new URL("../../soundstage/refocus/depth.py", import.meta.url), "utf8");
  assert.match(stage, /export const REFOCUS_DMAX = 10\.0;/);
  assert.match(py, /^DMAX = 10\.0/m);
  assert.match(stage, /gl_FragColor = vec4\(hi \/ 255\.0, \(q - hi \* 256\.0\) \/ 255\.0, 0\.0, 1\.0\)/);
  assert.match(stage, /mode === "depth16" \? depth16Material : depthMaterial/);
  assert.match(stage, /const lossless = mode === "depth" \|\| mode === "depth16"/);
});
