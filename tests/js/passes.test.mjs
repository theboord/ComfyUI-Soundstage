import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KINDS, discoverPasses, firstKind, availableCount, viewParts, viewPath, packPath, framePath, edgeBand, edgeLine, rubylith,
  busyBackground, turbo, remapDepth, stageMetres, confColor, poseFrame, mouthBox, pearson, bestLag, peaks, frameLabel, stillName,
} from "../../web/passes/model.mjs";

const shot = { id: "sh1", name: "1A" };
const scene = { shots: [{ id: "sh1", name: "1A" }], active_shot: "sh1", actors: [] };
const ok = (list) => list.filter((s) => s.ok);
const byType = (list, t) => list.find((s) => s.type === t);

// ------------------------------------------------------------------------------------------------ discovery

test("a plain final: no matte (with the way to make one), no pose read, its sound, the stage depth", () => {
  const take = { id: "final", n: 3, kind: "final", url: "/view?filename=final_00001_.mp4&subfolder=soundstage&type=output", video: true };
  const P = discoverPasses({ from: "take", shot, take, scene, activeShot: "sh1" });
  for (const k of KINDS) assert.ok(P[k].length > 0, `${k} is listed, not hidden`);
  assert.equal(ok(P.matte).length, 0);
  assert.match(P.matte[0].reason, /✦ One-click › Cutout/);
  assert.match(P.matte[0].reason, /Layer Pack in ⑦ Deliver/);
  assert.equal(byType(P.pose, "none").ok, false);
  assert.match(P.pose.find((s) => s.id === "recast").reason, /doesn't save it/);
  assert.equal(ok(P.talk)[0].type, "audio");
  assert.equal(ok(P.talk)[0].url, take.url);
  assert.equal(ok(P.depth)[0].type, "stage_depth");
  assert.match(P.depth.find((s) => s.id === "video_depth").reason, /Depth Anything 3/);
  assert.equal(P.original.url, take.url);
  assert.equal(P.original.video, true);
  assert.equal(firstKind(P), "talk");
  assert.equal(availableCount(P), 2);
});

test("a still ✦ Cutout opens on its alpha, compared with the picture it was cut from", () => {
  const take = { id: "oneclick_cutout_x", n: 4, kind: "look", url: "/view?filename=cut_00001_.png&subfolder=soundstage_private%2Foneclick&type=output", video: false,
    oneclick: { id: "cutout", label: "Cutout", from: "soundstage/look_00022_.png [output]", engine: "BiRefNet" } };
  const P = discoverPasses({ from: "take", shot, take, scene });
  const m = ok(P.matte);
  assert.equal(m.length, 1);
  assert.equal(m[0].type, "cutout_png");
  assert.equal(m[0].url, take.url);
  assert.equal(P.original.ref, "soundstage/look_00022_.png [output]");
  assert.equal(P.original.video, false);
  assert.equal(firstKind(P), "matte");
  assert.equal(ok(P.talk).length, 0, "a still has no sound");
  assert.match(P.talk[0].reason, /still has no sound/);
});

test("a clip ✦ Cutout says its alpha is ProRes 4444 the browser can't decode", () => {
  const take = { id: "oc", kind: "final", url: "/view?filename=cut.mp4&type=output", video: true,
    oneclick: { id: "cutout", from: "soundstage/final.mp4 [output]", prores: { filename: "alpha_00001.mov" } } };
  const P = discoverPasses({ from: "take", shot, take, scene });
  const c = byType(P.matte, "cutout_clip");
  assert.equal(c.ok, false);
  assert.match(c.reason, /ProRes 4444 \(alpha_00001\.mov\)/);
  assert.match(c.reason, /can't decode/);
  assert.ok(!P.matte.some((s) => s.type === "none"), "the clip's own reason replaces the generic one");
  assert.equal(P.original.video, true);
});

test("a shot with a Layer Pack: its mattes and depth; other packs are offered but flagged unlinked", () => {
  const P = discoverPasses({ from: "ladder", shot, take: null, chosen: { layerpack: "SH010_20261102_101500" }, scene,
    packs: ["SH010_20261102_101500", "SH010_20261101_090000"] });
  const m = ok(P.matte);
  assert.equal(m[0].type, "layerpack");
  assert.equal(m[0].pack, "SH010_20261102_101500");
  assert.equal(m[0].unlinked, undefined);
  assert.equal(m[1].pack, "SH010_20261101_090000");
  assert.equal(m[1].unlinked, true);
  assert.equal(m.length, 2, "the linked pack is not listed twice");
  assert.equal(ok(P.depth)[0].type, "pack_depth");
  assert.equal(firstKind(P), "matte");
});

test("a performance take: the DWPose read and the actor's voice and mouth", () => {
  const take = { id: "performance_x", kind: "final", url: "/view?filename=perf.mp4&type=output", video: true, performance: true,
    asset: "soundstage_private/performances/m25_wow_1/asset.json [output]", label: "Performance · m25_wow" };
  const P = discoverPasses({ from: "take", shot, take, scene, people: 1, activeShot: "sh1" });
  const p = ok(P.pose)[0];
  assert.equal(p.type, "performance");
  assert.equal(p.asset, take.asset);
  assert.match(p.label, /m25_wow/);
  assert.equal(ok(P.talk)[0].type, "performance");
  assert.ok(!P.talk.some((s) => s.id === "mouth"), "no 'no mouth curve' line when there is one");
  assert.ok(P.pose.some((s) => s.type === "stage_pose" && s.ok), "the clay skeleton is offered too");
});

test("any take of a shot rendered from a performance reaches it through the shot's chosen record", () => {
  const take = { id: "draft", kind: "draft", url: "/view?filename=d.mp4&type=output", video: true };
  const P = discoverPasses({ from: "take", shot, take, chosen: { performance: { asset: "a/asset.json [output]", name: "wow" } }, scene });
  assert.equal(ok(P.pose)[0].asset, "a/asset.json [output]");
});

test("the stage skeleton needs its shot open on the stage", () => {
  const take = { id: "d", kind: "draft", url: "/view?filename=d.mp4&type=output", video: true };
  const P = discoverPasses({ from: "take", shot, take, scene: { ...scene, shots: [...scene.shots, { id: "sh2" }] }, activeShot: "sh2", people: 2 });
  const sp = byType(P.pose, "stage_pose");
  assert.equal(sp.ok, false);
  assert.match(sp.reason, /Open this shot on the stage/);
  const none = discoverPasses({ from: "take", shot, take, scene, people: 0 });
  assert.ok(!none.pose.some((s) => s.type === "stage_pose"), "no clay people, no clay skeleton");
});

test("a Video → 3D result: its clip masks, the captured body, the source's sound, depth through the clip camera", () => {
  const rle = { size: [4, 4], counts: [0, 16] };
  const v2s = { ...scene, actors: [{ id: "p0", name: "Runner", mocap: { file: "x.json" } }],
    reference: { video: "clip.mp4", fps: 24 }, video2stage: { trim: [1.5, 4], masks: { people: { p0: { 0: rle, 1: rle } }, objects: { car: {} } } } };
  const P = discoverPasses({ from: "v2s", shot, scene: v2s, activeShot: "sh1" });
  const m = ok(P.matte)[0];
  assert.equal(m.type, "v2s_masks");
  assert.deepEqual(m.refs, ["people/p0"], "an object with no frames is not a mask");
  assert.match(m.note, /no soft edge/);
  assert.equal(byType(P.pose, "stage_pose").ok, true);
  assert.match(byType(P.pose, "stage_pose").label, /SAM 3D Body\) · Runner/);
  assert.equal(ok(P.talk)[0].ref, "clip.mp4 [input]");
  assert.match(ok(P.depth)[0].label, /clip's camera/);
  assert.match(P.depth.find((s) => s.id === "video_depth").reason, /keeps only the fused set scan/);
  assert.deepEqual([P.original.ref, P.original.start, P.original.video], ["clip.mp4 [input]", 1.5, true]);
});

test("a Video → 3D run with no masks, and the demo, say so instead of hiding the matte", () => {
  const v2s = { ...scene, reference: { video: "m_v2s_source.mp4" }, video2stage: { metres_per_unit: 1 } };
  const P = discoverPasses({ from: "v2s", shot, scene: v2s, demo: true });
  const m = byType(P.matte, "v2s_masks");
  assert.equal(m.ok, false);
  assert.match(m.reason, /demo kept no clip masks/);
  const none = byType(P.matte, "none");
  assert.match(none.reason, /try-it demo has no matte media/);
  const live = discoverPasses({ from: "v2s", shot, scene: v2s });
  assert.match(byType(live.matte, "v2s_masks").reason, /kept no clip masks/);
  assert.doesNotMatch(byType(live.matte, "none").reason, /demo/);
});

test("discovery never throws on an empty subject", () => {
  const P = discoverPasses({});
  for (const k of KINDS) assert.ok(Array.isArray(P[k]) && P[k].length);
  assert.equal(P.original, null);
  assert.equal(availableCount(P), 0);
  assert.equal(firstKind(P), "matte");
  assert.doesNotThrow(() => discoverPasses(null));
});

// ------------------------------------------------------------------------------------------------ file references

test("file references to /view paths, Layer Pack paths and frame numbers", () => {
  assert.deepEqual(viewParts("soundstage_private/performances/a/face.json [output]"), { filename: "face.json", subfolder: "soundstage_private/performances/a", type: "output" });
  assert.deepEqual(viewParts("clip.mp4"), { filename: "clip.mp4", subfolder: "", type: "input" });
  assert.deepEqual(viewParts("/view?filename=x.png&subfolder=s&type=temp&t=1"), { filename: "x.png", subfolder: "s", type: "temp" });
  assert.equal(viewParts(null), null);
  assert.equal(viewPath({ filename: "a.png", subfolder: "", type: "output" }), "/view?filename=a.png&subfolder=&type=output");
  assert.equal(viewPath("r/m_perf_final.mp4"), "r/m_perf_final.mp4", "a plain URL stays as it is");
  assert.equal(viewPath("/view?filename=a.mp4&type=output"), "/view?filename=a.mp4&type=output");
  assert.equal(packPath("SH010_1", "manifest.json"), "/view?filename=manifest.json&subfolder=soundstage_layerpacks%2FSH010_1&type=output");
  assert.equal(packPath("P", "layers/10_man/png/man.1001.png"), "/view?filename=man.1001.png&subfolder=soundstage_layerpacks%2FP%2Flayers%2F10_man%2Fpng&type=output");
  assert.equal(framePath("layers/10_man/png/man.####.png", 1012), "layers/10_man/png/man.1012.png");
  assert.equal(framePath("d.##.png", 7), "d.07.png");
});

// ------------------------------------------------------------------------------------------------ the edge band

/** A w x h matte: 0 left of x0, 255 right of x1, a linear ramp between. */
function ramp(w, h, x0, x1) {
  const a = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = x < x0 ? 0 : x >= x1 ? 255 : Math.round(((x - x0 + 1) / (x1 - x0 + 1)) * 255);
  return a;
}

test("edge band: a hard edge has no band, only a boundary", () => {
  const a = ramp(10, 4, 5, 5);
  const st = edgeBand(a, 10, 4);
  assert.equal(st.count, 0);
  assert.equal(st.boundary, 4, "one boundary pixel per row");
  assert.equal(st.hard, true);
  assert.equal(st.width, 0);
  assert.equal(st.bbox, null);
  assert.match(edgeLine(st), /^Hard edge/);
});

test("edge band: a 4 px soft ramp is a band 4 px wide, inside its box", () => {
  const w = 20, h = 6;
  const a = ramp(w, h, 8, 12);   // x 8..11 are 64, 128, 191, 255? -> (1..4)/5*255 = 51, 102, 153, 204: all inside the band
  const st = edgeBand(a, w, h);
  assert.equal(st.count, 4 * h);
  assert.equal(st.width, 4, "band pixels per boundary pixel");
  assert.deepEqual(st.bbox, [8, 0, 11, 5]);
  assert.equal(st.hard, false);
  assert.ok(Math.abs(st.fraction - (4 * h) / (w * h)) < 1e-9);
  for (let x = 0; x < w; x++) assert.equal(st.band[2 * w + x], x >= 8 && x <= 11 ? 1 : 0, `x ${x}`);
  assert.match(edgeLine(st), /Soft edge 24 px .* about 4\.0 px wide/);
});

test("edge band: the 0.02 and 0.98 limits are exclusive, and RGBA alpha works with a stride", () => {
  const vals = [0, 5, 6, 128, 249, 250, 255];   // 5/255 = 0.0196 (out), 6/255 = 0.0235 (in), 249/255 = 0.976 (in), 250/255 = 0.980 (out)
  const st = edgeBand(Uint8Array.from(vals), vals.length, 1);
  assert.deepEqual([...st.band], [0, 0, 1, 1, 1, 0, 0]);
  const rgba = new Uint8ClampedArray(vals.length * 4);
  vals.forEach((v, i) => { rgba[i * 4] = 99; rgba[i * 4 + 3] = v; });
  const st4 = edgeBand(rgba, vals.length, 1, { stride: 4, offset: 3 });
  assert.deepEqual([...st4.band], [...st.band]);
  const fl = edgeBand(Float32Array.from(vals.map((v) => v / 255)), vals.length, 1, { max: 1 });
  assert.deepEqual([...fl.band], [...st.band], "0-1 floats");
  const custom = edgeBand(Uint8Array.from(vals), vals.length, 1, { lo: 0.4, hi: 0.6 });
  assert.equal(custom.count, 1);
});

test("edge band: an empty matte says so", () => {
  const st = edgeBand(new Uint8Array(16), 4, 4);
  assert.equal(st.count + st.boundary, 0);
  assert.match(edgeLine(st), /Empty matte/);
});

test("rubylith reddens only what the matte throws away", () => {
  const rgba = new Float32Array([100, 100, 100, 255, 100, 100, 100, 255]);
  rubylith(rgba, Uint8Array.from([255, 0]), { opacity: 0.5 });
  assert.deepEqual([...rgba.slice(0, 3)], [100, 100, 100], "kept: untouched");
  assert.deepEqual([...rgba.slice(4, 7)].map(Math.round), [165, 60, 65], "thrown away: half way to red");
});

test("the busy test background is opaque and busy", () => {
  const px = busyBackground(64, 48);
  assert.equal(px.length, 64 * 48 * 4);
  let opaque = true; const cols = new Set();
  for (let i = 0; i < px.length; i += 4) { if (px[i + 3] !== 255) opaque = false; cols.add(`${px[i]},${px[i + 1]},${px[i + 2]}`); }
  assert.ok(opaque);
  assert.ok(cols.size > 40, `${cols.size} colours`);
});

// ------------------------------------------------------------------------------------------------ depth, pose, talk

test("depth: Turbo's ends, the near / far window, stage metres", () => {
  assert.deepEqual(turbo(0), [35, 23, 27]);
  assert.deepEqual(turbo(1), [144, 13, 0]);
  const mid = turbo(0.5);
  assert.ok(mid[1] > 200, "green-yellow in the middle");
  assert.equal(remapDepth(0.5, 0, 1), 0.5);
  assert.equal(remapDepth(0.5, 0.4, 0.6), 0.5);
  assert.equal(remapDepth(0.3, 0.4, 0.6), 0);
  assert.equal(remapDepth(0.9, 0.6, 0.4), 1, "the window's ends in either order");
  assert.equal(stageMetres(1), 1);
  assert.equal(stageMetres(0), 40);
  assert.equal(stageMetres(0.5), 20.5);
});

test("pose: confidence colours, a frame of face.json, the mouth box", () => {
  assert.equal(confColor(0.1), "#ff4040");
  assert.equal(confColor(0.45), "#ffb020");
  assert.equal(confColor(0.9), "#3ddc84");
  assert.equal(confColor(undefined), "#ffffff");
  const face = Array.from({ length: 70 }, () => [0.5, 0.5, 1]);
  for (let i = 48; i < 68; i++) face[i] = [0.4 + (i % 5) * 0.05, 0.6 + (i % 2) * 0.04, 0.9];
  const kp = { frames: [{ face, mouth: 0.1, body: [[0.5, 0.2, 0.8]], hands: null }, { face: null, mouth: null }] };
  assert.equal(poseFrame(kp, 0).mouth, 0.1);
  assert.equal(poseFrame(kp, 0).body.length, 1);
  assert.equal(poseFrame(kp, 9).face, null, "held on the last frame");
  assert.equal(poseFrame(null, 0).face, null);
  const b = mouthBox(face);
  assert.ok(b[0] < 0.4 && b[2] > 0.6 && b[1] < 0.6 && b[3] > 0.64);
  assert.ok(Math.abs((b[2] - b[0]) - (b[3] - b[1])) < 1e-9, "square");
  assert.equal(mouthBox(null), null);
});

test("talk: correlation over the frames both curves read, the best lag, waveform peaks", () => {
  const a = [0, 0.1, 0.2, 0.1, 0, 0.1, 0.2, 0.1, 0];
  assert.ok(Math.abs(pearson(a, a) - 1) < 1e-12);
  assert.ok(Math.abs(pearson(a, a.map((v) => -v)) + 1) < 1e-12);
  assert.equal(pearson([1, 2], [1, 2]), null, "fewer than 3 pairs");
  assert.ok(Math.abs(pearson([0, null, 0.2, 0.1, 0], [0, 0.5, 0.2, 0.1, 0]) - 1) < 1e-12, "nulls skipped");
  const late = [0, ...a.slice(0, -1)];   // b is a, one frame late
  assert.deepEqual(bestLag(a, late, 3).lag, 1);
  const p = peaks(Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]), 3);
  assert.deepEqual(p, [[0, 0.5], [-0.5, 1], [-1, 0.25]]);
  assert.deepEqual(peaks([], 4), []);
});

test("labels and the still's file name", () => {
  assert.equal(frameLabel(12, 97, 24), "f 12 / 96 · 0:00.50");
  assert.equal(stillName("1A · Mara close", "matte", "over_busy", 7), "soundstage_1A_Mara_close_matte_over_busy_f007.png");
});
