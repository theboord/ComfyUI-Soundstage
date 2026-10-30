// node --test tests/js/
import test from "node:test";
import assert from "node:assert/strict";
import { anchorFromCamera, takeToCamera, LiveVcam, listenVcam } from "../../web/vcam/live.mjs";
import { eulerOf } from "../../web/movefit/stabilize.mjs";
import { MOVES, take, dist } from "./synthetic.mjs";

test("anchorFromCamera yaw matches the stabilizer's heading convention", () => {
  const a = anchorFromCamera({ position: [1, 1.6, 2], target: [0, 1.6, 2] }); // looking -X = yaw +90
  assert.ok(Math.abs(a.yaw - 90) < 1e-9);
  assert.deepEqual(a.position, [1, 1.6, 2]);
});

test("takeToCamera: stored take -> stage keys starting at the shot camera, device settings as defaults", () => {
  const stored = { settings: { strength: 0.9, scale: 2, horizonLock: true }, samples: take(MOVES.dollyIn, { seed: 2 }) };
  const cam = { position: [-7, 1.7, -14], target: [0, 1.3, -4] };
  const r = takeToCamera(stored, { anchor: anchorFromCamera(cam) });
  assert.ok(dist(r.keys[0].position, cam.position) < 1e-3);
  assert.ok(Math.abs(eulerOf(r.frames[0].quaternion).yaw - anchorFromCamera(cam).yaw) < 0.5);
  assert.ok(Math.abs(dist(r.frames[0].position, r.frames.at(-1).position) - 6) < 0.05, "3 m dolly at scale 2");
  assert.equal(r.info.strength, 0.9);
  assert.equal(r.rig?.label, "dolly-in");
  const raw = takeToCamera(stored, { anchor: anchorFromCamera(cam), overrides: { strength: 0 }, suggest: false });
  assert.equal(raw.info.strength, 0); assert.equal(raw.rig, null);
});

test("LiveVcam maps streamed poses onto the anchor and re-zeroes on demand", () => {
  const live = new LiveVcam();
  const anchor = { position: [5, 2, 5], yaw: 180 };
  const c0 = live.update({ position: [0.3, 1.5, 0], quaternion: [0, 0, 0, 1], settings: { scale: 10 } }, anchor);
  assert.ok(dist(c0.position, [5, 2, 5]) < 1e-9);
  const c1 = live.update({ position: [0.3, 1.5, -0.1], quaternion: [0, 0, 0, 1], settings: { scale: 10 } }, anchor);
  assert.ok(dist(c1.position, [5, 2, 6]) < 1e-9, "forward 10 cm at scale 10, turned to face +Z");
  live.zero();
  assert.ok(dist(live.update({ position: [9, 9, 9], quaternion: [0, 0, 0, 1] }, anchor).position, [5, 2, 5]) < 1e-9);
});

test("listenVcam routes by message type and unsubscribes", () => {
  const seen = [];
  const api = { l: null, addEventListener(t, h) { this.l = h; this.t = t; }, removeEventListener() { this.l = null; } };
  const off = listenVcam(api, { onPose: () => seen.push("pose"), onState: (m) => seen.push(m.event), onTake: (m) => seen.push(m.id) });
  assert.equal(api.t, "soundstage.vcam");
  for (const d of [{ type: "pose" }, { type: "state", event: "record" }, { type: "take", id: "x" }, { type: "?" }]) api.l({ detail: d });
  assert.deepEqual(seen, ["pose", "record", "x"]);
  off(); assert.equal(api.l, null);
});
