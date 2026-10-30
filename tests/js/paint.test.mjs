// node --test tests/js/paint.test.mjs  (Paint Studio's pure helpers: selection grow / shrink, Extend presets)
import test from "node:test";
import assert from "node:assert/strict";

import { aspectRect, morphAlpha } from "../../web/canvas/canvas.mjs";

const box = (w, h, x0, y0, x1, y1) => {
  const a = new Uint8ClampedArray(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255;
  return a;
};
const bounds = (a, w, h) => {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
};

test("morphAlpha grows and shrinks a selection by whole pixels", () => {
  const a = box(40, 30, 10, 10, 20, 18);
  assert.deepEqual(bounds(morphAlpha(a, 40, 30, 3), 40, 30), [7, 7, 23, 21]);
  assert.deepEqual(bounds(morphAlpha(a, 40, 30, -2), 40, 30), [12, 12, 18, 16]);
  assert.equal(bounds(morphAlpha(a, 40, 30, -5), 40, 30), null);   // shrunk away
  assert.equal(morphAlpha(a, 40, 30, 0), a);
});

test("morphAlpha stays inside the canvas at the border", () => {
  const a = box(10, 10, 0, 0, 2, 2);
  assert.deepEqual(bounds(morphAlpha(a, 10, 10, 4), 10, 10), [0, 0, 6, 6]);
});

const pic = { x: 0, y: 0, w: 1920, h: 1080 };
const room = { x: -672, y: -672, w: 1920 + 1344, h: 1080 + 1344 };

test("aspectRect extends 16:9 to 2.39 around the picture without cropping it", () => {
  const r = aspectRect(pic, 2.39, room);
  assert.equal(r.h, 1080);
  assert.equal(r.w, Math.round(1080 * 2.39));
  assert.ok(r.x <= 0 && r.x + r.w >= 1920);
  assert.ok(Math.abs(r.x + r.w / 2 - 960) <= 1);   // centred
});

test("aspectRect for 9:16 keeps the width and adds height when there is room", () => {
  const big = { x: -2000, y: -3000, w: 6000, h: 8000 };
  const r = aspectRect(pic, 9 / 16, big);
  assert.equal(r.w, 1920);
  assert.equal(r.h, Math.round(1920 * 16 / 9));
});

test("aspectRect shrinks (keeping the shape) when the canvas room is too small", () => {
  const r = aspectRect(pic, 9 / 16, room);
  assert.ok(Math.abs(r.w / r.h - 9 / 16) < 0.01);
  assert.ok(r.h <= room.h && r.y >= room.y && r.y + r.h <= room.y + room.h);
  assert.ok(r.x >= room.x && r.x + r.w <= room.x + room.w);
});

test("aspectRect at the picture's own aspect is the picture", () => {
  assert.deepEqual(aspectRect(pic, 16 / 9, room), pic);
});
