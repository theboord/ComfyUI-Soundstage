import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import {
  rleDecode, resampleMask, iouOf, maskRefOf, maskAt, maskFrames, matchFormula, chipLevel, sampleFrames, solveChipText,
  sparkPath, mul4, projectPt, convexHull, rasterPoly, boxCorners, boxSilhouette, fitSearch, groundUnder, maskAnchor,
  simplifyKeys, swapChoices, deltaE,
} from "../../web/ui/v2scompare.mjs";

// COCO helpers (pycocotools semantics: column-major runs, starting with a zero run)
function encode(mask, w, h) {
  const flat = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) flat.push(mask[y * w + x]);
  const counts = [];
  let cur = 0, n = 0;
  for (const v of flat) { if (v !== cur) { counts.push(n); n = 0; cur = v; } n++; }
  counts.push(n);
  return { size: [h, w], counts };
}
function toString(cnts) {
  let s = "";
  for (let i = 0; i < cnts.length; i++) {
    let x = cnts[i];
    if (i > 2) x -= cnts[i - 2];
    let more = true;
    while (more) {
      let c = x & 0x1f;
      x >>= 5;
      more = c & 0x10 ? x !== -1 : x !== 0;
      if (more) c |= 0x20;
      s += String.fromCharCode(c + 48);
    }
  }
  return s;
}

test("RLE decodes COCO column-major runs, list and compressed", () => {
  const w = 7, h = 5, m = new Uint8Array(w * h);
  for (const [x, y] of [[0, 0], [1, 0], [3, 2], [3, 3], [6, 4], [5, 1]]) m[y * w + x] = 1;
  const r = encode(m, w, h);
  assert.deepEqual([...rleDecode(r).data], [...m]);
  assert.deepEqual([...rleDecode({ size: r.size, counts: toString(r.counts) }).data], [...m]);
  assert.equal(rleDecode(null), null);
  const big = resampleMask(rleDecode(r), 14, 10);
  assert.equal(big.w, 14);
  assert.equal(big.data[0], 1);
  assert.equal(big.data.reduce((a, b) => a + b, 0), 6 * 4);
});

test("IoU, mask refs and frames", () => {
  assert.deepEqual(iouOf(Uint8Array.from([1, 1, 0, 0]), Uint8Array.from([0, 1, 1, 0])), { inter: 1, union: 3, iou: 1 / 3 });
  assert.equal(iouOf(new Uint8Array(4), new Uint8Array(4)).iou, 0);
  const masks = { people: { p1: { 3: encode(Uint8Array.from([1, 0, 0, 1]), 2, 2), 10: encode(Uint8Array.from([1, 1, 1, 1]), 2, 2) } },
    objects: { sofa: { "4": encode(Uint8Array.from([0, 1, 0, 0]), 2, 2) } } };
  assert.equal(maskRefOf({ id: "x", source: { mask_ref: "objects/sofa" } }, masks), "objects/sofa");
  assert.equal(maskRefOf({ id: "p1" }, masks), "people/p1");
  assert.equal(maskRefOf({ id: "nobody" }, masks), null);
  assert.deepEqual(maskFrames(masks, "people/p1"), [3, 10]);
  assert.deepEqual([...maskAt(masks, "objects/sofa", 4).data], [0, 1, 0, 0]);
  assert.equal(maskAt(masks, "objects/sofa", 5), null);
});

test("scores: the bench MATCH formula and the chip colours", () => {
  assert.equal(matchFormula(1, 1, 1), 100);
  assert.ok(Math.abs(matchFormula(0.4, 0.5, 0.6) - 47) < 1e-9);
  assert.equal(chipLevel(0.7), "green");
  assert.equal(chipLevel(0.55), "amber");
  assert.equal(chipLevel(0.39), "red");
  assert.equal(chipLevel(null), "none");
  assert.deepEqual(sampleFrames(120, 5), [0, 30, 60, 90, 120]);
  assert.deepEqual(sampleFrames(3, 24), [0, 1, 2, 3]);
  assert.deepEqual(sampleFrames(0), [0]);
});

test("solve chip reads like a matchmove report", () => {
  assert.equal(solveChipText({ rms_px: 0.62, confidence: 0.92, focal_mm: [35, 37, 42], zoom: true, roll_deg: [-4.6, 2, 5.2], mode: "free" }),
    "Solve 0.6 px · 92 % · 35→42 mm · roll ±5°");
  assert.equal(solveChipText({ rms_px: 0.4, focal_mm: [50, 50], roll_deg: [0.2], mode: "nodal" }), "Solve 0.4 px · 50 mm · roll ±0.2° · nodal");
  assert.equal(solveChipText(null), null);
  const sp = sparkPath([0.2, 0.4, 2.5, 0.3], 100, 10);
  assert.ok(sp.d.startsWith("M0.0,"));
  assert.deepEqual(sp.red, [2]);
});

test("projection, silhouettes and the ground under a pixel agree with three.js", () => {
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
  cam.position.set(2, 1.6, -6);
  cam.lookAt(0, 0.8, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const vp = mul4(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
  const ivp = mul4(cam.matrixWorld.elements, cam.projectionMatrixInverse.elements);
  const W = 320, H = 180;
  const p = new THREE.Vector3(0.5, 0, 1).project(cam);
  const px = projectPt(vp, [0.5, 0, 1], W, H);
  assert.ok(Math.abs(px[0] - ((p.x + 1) / 2) * W) < 1e-6 && Math.abs(px[1] - ((1 - p.y) / 2) * H) < 1e-6);
  const g = groundUnder(ivp, px[0], px[1], W, H);
  assert.ok(Math.abs(g[0] - 0.5) < 1e-6 && Math.abs(g[2] - 1) < 1e-6 && g[1] === 0);
  assert.equal(groundUnder(ivp, W / 2, 0, W, H), null);   // above the horizon
  assert.equal(projectPt(vp, [2, 1.6, -20], W, H), null);   // behind the camera
  const box = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  const c = boxCorners(box, { x: 1, y: 0, z: 2, yaw: Math.PI / 2, s: 2 });
  assert.ok(c.every((q) => Math.abs(Math.abs(q[0] - 1) - 1) < 1e-9 && Math.abs(Math.abs(q[2] - 2) - 1) < 1e-9));
  const sil = boxSilhouette(box, { x: 0, y: 0, z: 0, yaw: 0, s: 1 }, vp, W, H);
  const n = sil.reduce((a, b) => a + b, 0);
  assert.ok(n > 200 && n < W * H / 2);
  const centre = projectPt(vp, [0, 0.5, 0], W, H);
  assert.equal(sil[Math.round(centre[1]) * W + Math.round(centre[0])], 1);
  assert.equal(convexHull([[0, 0], [1, 0], [0.5, 0.2], [1, 1], [0, 1]]).length, 4);
  assert.equal(rasterPoly([[0, 0], [4, 0], [4, 4], [0, 4]], 8, 8).reduce((a, b) => a + b, 0), 16);
});

test("Fit to plate: the local search recovers a displaced, turned, mis-sized box from its silhouettes", () => {
  const W = 128, H = 72;
  const cams = [[3, 1.6, -6], [-2, 1.7, -5.5], [0.5, 2.2, -7]].map(([x, y, z]) => {
    const cam = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 500);
    cam.position.set(x, y, z); cam.lookAt(0, 0.5, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    return mul4(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
  });
  const box = { min: [-1, 0, -0.45], max: [1, 0.85, 0.45] };   // a sofa
  const truth = { x: 0.3, y: 0, z: 0.4, yaw: 0.5, s: 1.0 };
  const masks = cams.map((vp) => boxSilhouette(box, truth, vp, W, H));
  const score = (p) => cams.reduce((a, vp, i) => a + iouOf(masks[i], boxSilhouette(box, { ...p, y: 0 }, vp, W, H)).iou, 0) / cams.length;
  const start = { x: -0.5, z: 1.1, yaw: 0.0, s: 0.8 };
  const before = score(start);
  const t0 = Date.now();
  const r = fitSearch(score, start, { x: 1, z: 1, yaw: 0.35, s: 0.12 }, { maxEvals: 400 });
  assert.ok(r.score > 0.85, `fit IoU ${r.score}`);
  assert.ok(r.score - before >= 0.15);
  assert.ok(Math.abs(r.params.x - truth.x) < 0.15 && Math.abs(r.params.z - truth.z) < 0.15);
  assert.ok(Date.now() - t0 < 3000);
  // a deadline stops it
  const quick = fitSearch(score, start, { x: 1, z: 1, yaw: 0.35, s: 0.12 }, { deadline: Date.now() - 1 });
  assert.equal(quick.evals, 1);
});

test("mask anchors, key thinning, swaps and colour distance", () => {
  const m = { w: 4, h: 4, data: Uint8Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0]) };
  const a = maskAnchor(m);
  assert.equal(a.by, 4);
  assert.equal(a.bx, 2);
  assert.ok(Math.abs(a.area - 6 / 16) < 1e-9);
  assert.equal(maskAnchor({ w: 2, h: 2, data: new Uint8Array(4) }), null);
  const line = Array.from({ length: 11 }, (_, i) => ({ frame: i * 2, position: [i * 0.5, 0, 0] }));
  assert.equal(simplifyKeys(line, 0.05).length, 2);
  const arc = Array.from({ length: 21 }, (_, i) => ({ frame: i, position: [Math.cos(i / 60) * 20, 0, Math.sin(i / 60) * 20] }));
  const k = simplifyKeys(arc, 0.05);
  assert.ok(k.length > 3 && k.length < 21 && k[0].frame === 0 && k[k.length - 1].frame === 20);
  assert.deepEqual(swapChoices("sofa"), ["armchair", "chair", "bench"]);
  assert.deepEqual(swapChoices("ufo"), []);
  assert.equal(deltaE([10, 20, 30, 255], [10, 20, 30, 255], 0), 0);
  assert.ok(deltaE([255, 255, 255, 255], [0, 0, 0, 255], 0) > 99);
});
