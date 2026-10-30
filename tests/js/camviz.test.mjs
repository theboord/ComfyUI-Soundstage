// Key cameras in the 3D stage: which key is "hot", how big they get, and the frustum's aspect.
import test from "node:test";
import assert from "node:assert/strict";
import { nearestKey, keyCamBase, keyCamFrustum } from "../../web/stage/camviz.mjs";

test("nearestKey: the key at the playhead, else the nearest in time (earlier on a tie)", () => {
  const keys = [{ frame: 0 }, { frame: 24 }, { frame: 48 }];
  assert.equal(nearestKey(keys, 24), 1);
  assert.equal(nearestKey(keys, 30), 1);
  assert.equal(nearestKey(keys, 36), 1);
  assert.equal(nearestKey(keys, 47), 2);
  assert.equal(nearestKey([], 5), -1);
});

test("keyCamBase grows with the move's size but stays between 0.25 and 1.5 m", () => {
  assert.equal(keyCamBase(0), 0.25);
  assert.ok(keyCamBase(20) > keyCamBase(5));
  assert.equal(keyCamBase(1000), 1.5);
  assert.equal(keyCamBase(NaN), 0.25);
});

test("keyCamFrustum: wider lens = wider frame, in the shot's aspect", () => {
  const w = keyCamFrustum(18, 16 / 9), t = keyCamFrustum(85, 16 / 9);
  assert.ok(w.x > t.x);
  assert.ok(Math.abs(w.x / w.y - 16 / 9) < 1e-9);
  assert.ok(Math.abs(keyCamFrustum(35, 2.39).x / keyCamFrustum(35, 2.39).y - 2.39) < 1e-9);
});
