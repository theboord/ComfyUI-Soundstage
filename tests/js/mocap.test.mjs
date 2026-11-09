// web/stage/people/mocap.mjs: the BVH reader (numbers only), the pace blend, and the retarget keeping limb directions.
// The real 100STYLE takes are not in the repo (local only); these use a tiny BVH written here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as M from "../../web/stage/people/mocap.mjs";

const BVH = `HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Yrotation Xrotation Zrotation
 JOINT Knee
 {
  OFFSET 0 -40 0
  CHANNELS 3 Yrotation Xrotation Zrotation
  End Site
  {
   OFFSET 0 -40 0
  }
 }
}
MOTION
Frames: 2
Frame Time: 0.5
0 90 0 0 0 0 0 0 0
10 90 0 0 0 0 0 90 0
`;

test("parseBVH reads joints, offsets, end sites and frames; bvhPose interpolates world positions", () => {
  const b = M.parseBVH(BVH);
  assert.deepEqual(b.joints.map((j) => [j.name, j.parent]), [["Hips", -1], ["Knee", 0]]);
  assert.deepEqual(b.joints[1].end, [0, -40, 0]);
  assert.equal(b.nF, 2); assert.equal(b.chan, 9);
  const p0 = M.bvhPose(b, 0).pos, p1 = M.bvhPose(b, 1).pos, ph = M.bvhPose(b, 0.5).pos;
  assert.ok(Math.abs(p0.Knee.y - 0.5) < 1e-9 && Math.abs(p1.Hips.x - 0.1) < 1e-9 && Math.abs(ph.Hips.x - 0.05) < 1e-9);
});

test("parseBVH refuses anything that is not plain numbers where numbers belong", () => {
  assert.throws(() => M.parseBVH(BVH.replace("0 90 0 0 0 0 0 0 0", "0 90 0 0 0 0 0 0 x")), /not a number|values/);
  assert.throws(() => M.parseBVH(BVH.replace("Xrotation Zrotation\n JOINT", "Xrotation Wrotation\n JOINT")), /channel/);
  assert.throws(() => M.parseBVH("HIERARCHY\nROOT A\n{\n}\n"), /MOTION/);
});

test("paceWeights: the two nearest paces blend by speed, the stride between theirs; outside the set the nearest alone", () => {
  const paces = [{ key: "slow", speed: 0.7, stride: 1.0 }, { key: "mid", speed: 1.0, stride: 1.2 }, { key: "fast", speed: 1.6, stride: 1.6 }];
  const a = M.paceWeights(0.85, paces);
  assert.ok(Math.abs(a.w.slow - 0.5) < 1e-9 && Math.abs(a.w.mid - 0.5) < 1e-9 && a.w.fast === 0 && Math.abs(a.stride - 1.1) < 1e-9);
  assert.deepEqual(M.paceWeights(0.4, paces).w, { slow: 1, mid: 0, fast: 0 });
  assert.equal(M.paceWeights(2.0, paces).stride, 1.6);
  // cadence (steps/s = 2 v / stride) moves between the clips' own instead of jumping
  const cad = (v) => (2 * v) / M.paceWeights(v, paces).stride;
  assert.ok(cad(0.7) < cad(0.85) && cad(0.85) < cad(1.0));
});
