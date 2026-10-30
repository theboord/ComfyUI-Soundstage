// node --test tests/js/
import test from "node:test";
import assert from "node:assert/strict";
import { stabilize, suggestRig, stageCameraAt, forwardOf, eulerOf } from "../../web/movefit/stabilize.mjs";

import { MOVES, take, dist, angDeg, rms, jitter, angJitter, posErr, angErr, yawPitchQ } from "./synthetic.mjs";

// ---------------------------------------------------------------- tests

test("jitter energy drops sharply and monotonically as strength rises", () => {
  for (const [name, move] of Object.entries(MOVES)) {
    const raw = take(move, { seed: 7 });
    const levels = [0, 0.25, 0.5, 0.75, 1].map((s) => jitter(stabilize(raw, { strength: s }).frames, move));
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] < levels[i - 1], `${name}: jitter not decreasing ${levels.map((x) => x.toFixed(5))}`);
    assert.ok(levels[4] < 0.05 * levels[0], `${name}: strength 1 keeps ${(levels[4] / levels[0] * 100).toFixed(1)}% of the jitter`);
    const rot = [0, 1].map((s) => angJitter(stabilize(raw, { strength: s }).frames, move));
    assert.ok(rot[1] < 0.2 * rot[0], `${name}: rotation jitter ${rot}`);
  }
});

test("strength 0 is the raw take, resampled to 24 fps", () => {
  const move = MOVES.walkAndPush, raw = take(move);
  const { frames } = stabilize(raw, { strength: 0 });
  assert.ok(Math.abs(frames.length - (8 * 24 + 1)) <= 1);
  assert.ok(Math.max(...posErr(frames, move)) < 0.03); // raw shake ~ a centimetre or two, nothing removed
  assert.ok(jitter(frames, move) > 0.002);
});

test("the stabilized path follows the intended path (no canonical move substituted)", () => {
  for (const [name, move] of Object.entries(MOVES)) {
    const raw = take(move, { seed: 3 });
    const rawErr = rms(posErr(stabilize(raw, { strength: 0 }).frames, move));
    for (const s of [0.5, 1]) {
      const { frames } = stabilize(raw, { strength: s });
      const pe = posErr(frames, move), ae = angErr(frames, move);
      assert.ok(rms(pe) < Math.max(rawErr, 0.012), `${name} s=${s}: rms pos err ${rms(pe).toFixed(4)} vs raw ${rawErr.toFixed(4)}`);
      assert.ok(Math.max(...pe) < 0.06, `${name} s=${s}: max pos err ${Math.max(...pe).toFixed(3)}`);
      assert.ok(rms(ae) < 1.0, `${name} s=${s}: rms angle err ${rms(ae).toFixed(2)} deg`);
    }
  }
});

test("timing and speed changes are preserved (walk-and-push speeds up mid-move)", () => {
  const move = MOVES.walkAndPush;
  const { frames } = stabilize(take(move, { seed: 11 }), { strength: 1 });
  // Speed per half-second window, intended vs stabilized.
  for (let a = 0.5; a < 7.5; a += 0.5) {
    const fa = Math.round(a * 24), fb = Math.round((a + 0.5) * 24);
    const vOut = dist(frames[fb].position, frames[fa].position) / 0.5;
    const vIn = dist(move.f(fb / 24).p, move.f(fa / 24).p) / 0.5;
    assert.ok(Math.abs(vOut - vIn) < 0.15 * vIn + 0.03, `t=${a}: speed ${vOut.toFixed(3)} vs intended ${vIn.toFixed(3)}`);
  }
  // No lag: the frame where the move is closest to any intended sample is that same frame.
  for (const f of [48, 96, 144]) {
    let best = -1, bd = 1e9;
    for (let g = f - 12; g <= f + 12; g++) { const d = dist(frames[f].position, move.f(g / 24).p); if (d < bd) { bd = d; best = g; } }
    assert.ok(Math.abs(best - f) <= 1, `frame ${f} matches intended frame ${best}`);
  }
});

test("crane: the pause stays a pause and the stop bumps are removed", () => {
  const move = MOVES.craneWithPause;
  const raw = take(move, { seed: 5, stops: [{ t: 3, amp: 0.04, dir: [0, 1, 0] }, { t: 7, amp: 0.04, dir: [0, 1, 0] }] });
  const rawFrames = stabilize(raw, { strength: 0 }).frames;
  const { frames } = stabilize(raw, { strength: 1 });
  const hold = frames.filter((f) => f.t >= 3.5 && f.t <= 4.5);
  for (const f of hold) assert.ok(Math.abs(f.position[1] - 2) < 0.02, `hold y ${f.position[1].toFixed(3)} at t=${f.t.toFixed(2)}`);
  for (let i = 1; i < hold.length; i++) assert.ok(dist(hold[i].position, hold[i - 1].position) * 24 < 0.03, "camera drifts during the hold");
  // Timing: the crane passes the 1.5 m mark when the operator did (t = 1.5 s), and re-starts after the hold on time.
  const cross = (fr, y, from) => fr.find((f) => f.t >= from && f.position[1] >= y).t;
  assert.ok(Math.abs(cross(frames, 1.5, 0) - 1.5) < 2 / 24);
  const intended = frames.map((f) => ({ t: f.t, position: move.f(f.t).p }));
  assert.ok(Math.abs(cross(frames, 2.4, 4.5) - cross(intended, 2.4, 4.5)) < 3 / 24);
  // Overshoot bump after the first stop: raw overshoots by ~cm, stabilized peak excursion is much smaller.
  const peak = (fr) => Math.max(...fr.filter((f) => f.t > 2.6 && f.t < 3.8).map((f) => Math.abs(f.position[1] - move.f(f.t).p[1])));
  assert.ok(peak(frames) < 0.4 * peak(rawFrames), `bump ${peak(frames).toFixed(4)} vs raw ${peak(rawFrames).toFixed(4)}`);
});

test("pan with drift: the deliberate drift and reframe survive", () => {
  const move = MOVES.panWithDrift;
  const { frames } = stabilize(take(move, { seed: 9 }), { strength: 1 });
  const last = frames[frames.length - 1];
  assert.ok(dist(last.position, move.f(6).p) < 0.025, "position drift lost");
  assert.ok(dist(last.position, frames[0].position) > 0.25, "drift was flattened");
  assert.ok(Math.abs(eulerOf(last.quaternion).yaw - 70) < 1.5, `final yaw ${eulerOf(last.quaternion).yaw}`);
  assert.ok(Math.abs(eulerOf(frames[72].quaternion).yaw - eulerOf(move.f(3).q).yaw) < 2.5, "pan timing");
});

test("horizon lock zeroes roll; without it the slow roll sway is (mostly) smoothed but present", () => {
  const raw = take(MOVES.walkAndPush, { seed: 2 });
  const locked = stabilize(raw, { strength: 0.5, horizonLock: true }).frames;
  for (const f of locked) assert.ok(Math.abs(eulerOf(f.quaternion).roll) < 0.05, `roll ${eulerOf(f.quaternion).roll}`);
  const free = stabilize(raw, { strength: 0, horizonLock: false }).frames;
  assert.ok(Math.max(...free.map((f) => Math.abs(eulerOf(f.quaternion).roll))) > 0.2);
});

test("keepHandheld re-adds low-frequency sway (footstep bob) but not tremor", () => {
  const move = MOVES.walkAndPush, raw = take(move, { seed: 4 });
  // Amplitude of the 1.8 Hz footstep bob left in the vertical error.
  const bob = (frames) => {
    let s = 0, c = 0;
    for (const f of frames) { const e = f.position[1] - move.f(f.t).p[1]; s += e * Math.sin(2 * Math.PI * 1.8 * f.t); c += 1; }
    return (2 * s) / c;
  };
  const run = (k) => stabilize(raw, { strength: 1, keepHandheld: k }).frames;
  assert.ok(Math.abs(bob(run(0))) < 0.003, `bob kept at keep=0: ${bob(run(0))}`);
  assert.ok(bob(run(1)) > 0.006, `bob not re-added at keep=1: ${bob(run(1))}`);
  assert.ok(bob(run(0.5)) > 0.002 && bob(run(0.5)) < bob(run(1)));
  assert.ok(jitter(run(1), move) < 0.35 * jitter(stabilize(raw, { strength: 0 }).frames, move), "tremor came back");
});

test("keys: the stage's Catmull-Rom through the reduced keys reproduces the stabilized frames", () => {
  for (const [name, move] of Object.entries(MOVES)) {
    const tol = 0.015;
    const { frames, keys, info } = stabilize(take(move, { seed: 6 }), { strength: 0.8, keyTolerance: tol });
    assert.ok(keys.length >= 2 && keys.length <= frames.length / 8, `${name}: ${keys.length} keys for ${frames.length} frames`);
    assert.equal(keys[0].frame, 0);
    assert.equal(keys[keys.length - 1].frame, frames.length - 1);
    assert.ok(info.maxKeyError <= tol + 1e-9, `${name}: maxKeyError ${info.maxKeyError}`);
    for (const f of frames) {
      const c = stageCameraAt(keys, f.frame);
      // Within tolerance, plus at most a third of a frame of travel along the path (an invisible timing slip).
      const prev = frames[Math.max(0, f.frame - 1)], next = frames[Math.min(frames.length - 1, f.frame + 1)];
      const step = dist(next.position, prev.position) / Math.max(1, next.frame - prev.frame);
      assert.ok(dist(c.position, f.position) <= Math.hypot(tol, tol + 0.35 * step) + 1e-4, `${name} frame ${f.frame}: ${dist(c.position, f.position)}`);
      assert.ok(dist(c.target, f.target) <= 0.15, `${name} frame ${f.frame} target`);
    }
    for (const k of keys) assert.deepEqual(Object.keys(k).sort(), ["focal_mm", "frame", "position", "target"]);
  }
});

test("stage parity: stageCameraAt matches Stage._cameraAt when stage.mjs can load in node", async (t) => {
  let Stage;
  try { ({ Stage } = await import("../../web/stage/stage.mjs")); } catch { /* needs a browser */ }
  if (!Stage?._sample) return t.skip("web/stage/stage.mjs does not load in node");
  const { keys } = stabilize(take(MOVES.walkAndPush, { seed: 8 }), { strength: 0.8 });
  for (let f = 0; f <= keys[keys.length - 1].frame; f += 7) {
    const fake = { _camKeys: () => keys };
    const ref = Stage.prototype._cameraAt.call(fake, f), mine = stageCameraAt(keys, f);
    assert.ok(dist(ref.position, mine.position) < 1e-9 && dist(ref.target, mine.target) < 1e-9);
  }
});

test("output shape, target = position + forward * focusDistance, anchor and scale", () => {
  const move = MOVES.dollyIn, raw = take(move, { shake: 0 });
  const r1 = stabilize(raw, { strength: 0.5, focal_mm: 50, focusDistance: 4 });
  const f0 = r1.frames[0];
  assert.deepEqual(Object.keys(r1.keys[0]).sort(), ["focal_mm", "frame", "position", "target"]);
  assert.equal(f0.focal_mm, 50);
  const fw = forwardOf(f0.quaternion);
  assert.ok(dist(f0.target, f0.position.map((v, k) => v + fw[k] * 4)) < 1e-9);
  // Scale 3 about the first frame; anchor drops the take at a stage position and turns it to yaw 90.
  const r2 = stabilize(raw, { strength: 0.5, scale: 3, anchor: { position: [10, 2, 0], yaw: 90 } });
  const a = r2.frames[0], b = r2.frames[r2.frames.length - 1];
  assert.ok(dist(a.position, [10, 2, 0]) < 1e-9);
  assert.ok(Math.abs(dist(a.position, b.position) - 9) < 0.02, "3 m of hand travel should be 9 m on set");
  assert.ok(Math.abs(eulerOf(a.quaternion).yaw - 90) < 0.5);
  assert.ok(b.position[0] < a.position[0] - 8.9, "after yawing 90 deg left, a forward dolly travels -X");
});

test("robust to unsorted, duplicate, sign-flipped and sparse samples", () => {
  const raw = take(MOVES.panWithDrift, { seed: 12 });
  const messy = raw.map((s, i) => ({ ...s, quaternion: i % 3 ? s.quaternion : s.quaternion.map((v) => -v) }));
  messy.push({ ...messy[10] });
  messy.reverse();
  const a = stabilize(raw, { strength: 0.7 }).frames, b = stabilize(messy, { strength: 0.7 }).frames;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(dist(a[i].position, b[i].position) < 1e-6 && angDeg(a[i].quaternion, b[i].quaternion) < 1e-4);
  assert.equal(stabilize([]).frames.length, 0);
  assert.equal(stabilize([raw[0]]).frames.length, 1);
  const sparse = raw.filter((_, i) => i % 6 === 0); // 10 Hz
  assert.ok(stabilize(sparse, { strength: 1 }).frames.every((f) => f.position.every(Number.isFinite)));
});

test("suggestRig only suggests, and recognises classic moves", () => {
  const d = suggestRig(take(MOVES.dollyIn, { seed: 1 }));
  assert.equal(d?.type, "dolly"); assert.equal(d.label, "dolly-in"); assert.match(d.question, /Snap it\?/);
  assert.ok(d.snapped.keys.length >= 2);
  const p = suggestRig(take(MOVES.panWithDrift, { seed: 1 }));
  assert.equal(p?.type, "pan"); assert.equal(p.label, "pan left");
  const c = suggestRig(take(MOVES.craneWithPause, { seed: 1 }));
  assert.equal(c?.type, "crane"); assert.equal(c.label, "crane up");
  // The snapped crane keeps the operator's pause (timing comes from their own progress).
  const hold = c.snapped.frames.filter((f) => f.frame >= 84 && f.frame <= 108);
  assert.ok(Math.abs(hold[0].position[1] - hold[hold.length - 1].position[1]) < 0.02);
  const arc = suggestRig(take(MOVES.walkAndPush, { seed: 1 }));
  assert.ok(arc === null || arc.type === "arc", `walk-and-push suggested ${arc?.type}`);
  // A wandering handheld take gets no suggestion.
  const wander = { dur: 6, f: (t) => ({ p: [Math.sin(t * 1.3) * 0.8, 1.6 + 0.2 * Math.sin(t * 2.1), Math.cos(t * 0.7) * 1.2 - t * 0.2], q: yawPitchQ(20 * Math.sin(t), 5 * Math.cos(t * 1.7)) }) };
  assert.equal(suggestRig(take(wander, { seed: 1 })), null);
  // stabilize() never snaps on its own.
  const s = stabilize(take(MOVES.dollyIn, { seed: 1 }), { strength: 1 });
  assert.ok(!("rig" in s) && s.frames.some((f) => Math.abs(f.position[0]) > 1e-4));
});
