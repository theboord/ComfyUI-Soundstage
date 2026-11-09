// People walk like people, not robots (2026-11-08): a stop and a start are eased, the speed doesn't step at a key, the
// body turns ahead of the path and eases into a turn, the head leads into it, each person swings their arms their own
// way and more when walking faster, a standing person breathes, the idle runs at each person's own pace, and the feet
// stay grounded through it all. Every test here fails on the parent commit (08dd88d); numbers in the messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as C from "../../web/stage/people/avatarcore.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import * as K from "./footkit.mjs";

const FPS = 24;
const deg = (r) => (r * 180) / Math.PI;
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const kf = (frame, p) => ({ frame, position: p });
// the audit scene: walk a curve, stop, turn round, walk off again (CHANGELOG 2026-11-08)
const SCENE = {
  man: [kf(0, [-3.2, 0, 1.2]), kf(48, [-1.4, 0, -0.4]), kf(96, [1.2, 0, -0.5]), kf(128, [1.2, 0, -0.5]), kf(170, [0.4, 0, 1.4]), kf(216, [-1.8, 0, 2.0])],
  woman: [kf(0, [-3.6, 0, 2.2]), kf(52, [-1.7, 0, 0.5]), kf(100, [1.0, 0, 0.5]), kf(132, [1.0, 0, 0.5]), kf(174, [0.0, 0, 2.3]), kf(220, [-2.4, 0, 2.9])],
};
const person = (kind, keys, id = `p_${kind}`) => ({ id, kind, height_m: K.heightOf(kind), position: keys[0].position, keys });
const speeds = (st, a) => {
  const n = st._lastFrame() + 1, v = new Array(n).fill(0);
  for (let f = 1; f < n - 1; f++) { const p = st._actorPosAt(a, f - 1), q = st._actorPosAt(a, f + 1); v[f] = Math.hypot(q[0] - p[0], q[2] - p[2]) * FPS / 2; }
  return v;
};

test("a person slows into a stop and sets off again from standing (no dead stop or start in one frame); every key on its frame", () => {
  for (const kind of ["man", "woman"]) {
    const a = person(kind, SCENE[kind]);
    const st = K.bareStage([a], { frames: 241 });
    const v = speeds(st, a), keys = SCENE[kind];
    const stop = keys[2].frame, go = keys[3].frame;
    // was 0.71-0.74 m/s one frame before the stop and 8.9-9.2 m/s^2 of braking (a dead stop)
    assert.ok(v[stop - 1] < 0.15, `${kind}: ${v[stop - 1].toFixed(2)} m/s one frame before the stop`);
    let brake = 0, push = 0;
    for (let f = stop - 15; f <= stop + 1; f++) brake = Math.max(brake, Math.abs(v[f] - v[f - 1]) * FPS);
    for (let f = go; f <= go + 15; f++) push = Math.max(push, Math.abs(v[f] - v[f - 1]) * FPS);
    assert.ok(brake < 6.5, `${kind}: braking ${brake.toFixed(1)} m/s^2`);
    // was 0.65 m/s on the first frame after the hold (8.1-8.2 m/s^2)
    assert.ok(v[go + 1] < 0.12 && push < 4.5, `${kind}: ${v[go + 1].toFixed(2)} m/s a frame after setting off, ${push.toFixed(1)} m/s^2`);
    // ... and up to speed within about two steps
    const cruise = Math.max(...v.slice(go, keys[5].frame));
    const t90 = v.slice(go).findIndex((x) => x >= 0.9 * cruise) / FPS;
    assert.ok(t90 > 0.3 && t90 < 1.2, `${kind}: ${t90.toFixed(2)} s to 90 % of the walking speed`);
    // no step in speed at a middle key (was 0.08-0.11 m/s at the curve's key)
    const k = keys[4].frame;
    assert.ok(Math.abs(v[k + 1] - v[k - 1]) < 0.05, `${kind}: the speed steps ${Math.abs(v[k + 1] - v[k - 1]).toFixed(3)} m/s at the key at f${k}`);
    for (const key of keys) {
      const p = st._actorPosAt(a, key.frame);
      assert.ok(Math.hypot(p[0] - key.position[0], p[2] - key.position[2]) < 1e-6, `${kind}: on the key at f${key.frame}`);
    }
  }
});

test("walked through the whole shot, recorded takes, rides and stunt keys keep the path's own timing", () => {
  const through = person("man", [kf(0, [-3, 0, 0]), kf(120, [3, 0, 0])]);
  const take = person("woman", Array.from({ length: 41 }, (_, i) => kf(i, [i < 20 ? 0.1 * i : 2, 0, 0])), "take");   // a key a frame (Drive)
  const rider = { ...person("man", SCENE.man, "rider"), mount_spans: [{ host: "car", seat: 0, from: 20, to: 40 }] };
  const st = K.bareStage([through, take, rider], { frames: 121 });
  for (const a of [through, take, rider]) for (let f = 0; f <= 120; f += 7) {
    const p = st._actorPosAt(a, f), q = Stage._sample(st._actorKeys(a), f, "position", false, false);
    assert.ok(Math.hypot(p[0] - q[0], p[2] - q[2]) < 1e-9, `${a.id} f${f}: retimed`);
  }
});

test("the body turns a little before the path does and eases into a turn (no 540 deg/s spin)", () => {
  for (const kind of ["man", "woman"]) {
    const a = person(kind, SCENE[kind]);
    const st = K.bareStage([a], { frames: 241 });
    const n = st._lastFrame() + 1, h = Array.from({ length: n }, (_, f) => st._headingAt(a, f));
    let rate = 0, jerk = 0;
    for (let f = 1; f < n; f++) rate = Math.max(rate, Math.abs(deg(wrap(h[f] - h[f - 1]))) * FPS);
    for (let f = 2; f < n; f++) jerk = Math.max(jerk, Math.abs(deg(wrap(h[f] - h[f - 1]) - wrap(h[f - 1] - h[f - 2]))) * FPS * FPS);
    // was 540 deg/s, starting and stopping dead (a change of 540 deg/s in one frame: 13000 deg/s^2)
    assert.ok(rate < 320, `${kind}: turns at ${rate.toFixed(0)} deg/s`);
    assert.ok(jerk < 3000, `${kind}: the turn rate changes ${jerk.toFixed(0)} deg/s^2`);
    // on the curve (frames 20-90) the facing changes a few frames BEFORE the travel direction does (was 0)
    const travel = (f) => { const p = st._actorPosAt(a, f - 1), q = st._actorPosAt(a, f + 1); return Math.atan2(q[0] - p[0], q[2] - p[2]); };
    let best = 0, bestC = -Infinity;
    for (let L = -4; L <= 12; L++) {
      let c = 0;
      for (let f = 20; f <= 90; f++) c += wrap(h[f] - h[f - 1]) * wrap(travel(f + L) - travel(f + L - 1));
      if (c > bestC) { bestC = c; best = L; }
    }
    assert.ok(best >= 3, `${kind}: the body leads the path by ${best} frames`);
  }
});

test("the idle runs at each person's own pace (two people standing side by side don't shift their weight in step)", () => {
  const clips = { idle: { duration: 10 }, walk: { duration: 1.2 }, run: { duration: 0.73 } };
  const rate = (seed) => { const a = C.clipTimes({ frame: 0, fps: 24, seed }, clips).idle, b = C.clipTimes({ frame: 24, fps: 24, seed }, clips).idle; return ((b - a) % 10 + 10) % 10; };
  const r = [0.13, 0.37, 0.61, 0.88].map(rate);
  // was exactly 1 s of idle per second for everyone
  assert.ok(Math.max(...r) - Math.min(...r) > 0.05, `idle seconds per second: ${r.map((x) => x.toFixed(3))}`);
  assert.ok(r.every((x) => x > 0.88 && x < 1.12), "within 10 % of the clip's own pace");
  assert.ok(Math.abs(rate(0) - 1) < 1e-9, "seed 0 plays the clip at its own rate");
});

// ---------------------------------------------------------------- the real Rocketbox bodies
/** Per frame: the head's yaw off the body's heading, the left upper arm's swing (deg, along the heading), the chest's
 *  pitch (deg, forward, relative to the heading). */
function playBody(st, a) {
  const g = st.actorMeshes.get(a.id), skin = g.userData.humanSkin, rows = [], v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let f = 0; f <= st._lastFrame(); f++) {
    st.frame = f;
    const p = st._actorPosAt(a, f);
    g.position.set(p[0], st._heightAt(a, f), p[2]); g.rotation.set(0, st._headingAt(a, f), 0); g.updateMatrixWorld(true);
    A.avatarsAt(st);
    skin.holder.updateMatrixWorld(true);
    const b = skin.bones, hd = st._headingAt(a, f), fx = Math.sin(hd), fz = Math.cos(hd);
    b.Bip01_Head.getWorldPosition(v); b.Bip01_MNose.getWorldPosition(w);
    const headYaw = deg(wrap(Math.atan2(w.x - v.x, w.z - v.z) - hd));
    b.Bip01_L_UpperArm.getWorldPosition(v); b.Bip01_L_Forearm.getWorldPosition(w);
    const arm = deg(Math.atan2((w.x - v.x) * fx + (w.z - v.z) * fz, v.y - w.y));
    b.Bip01_Spine2.getWorldPosition(v); b.Bip01_Neck.getWorldPosition(w);
    const chest = deg(Math.atan2((w.x - v.x) * fx + (w.z - v.z) * fz, w.y - v.y));
    rows.push({ f, headYaw, arm, chest, heading: hd });
  }
  return rows;
}
const range = (xs) => Math.max(...xs) - Math.min(...xs);

test("real Rocketbox: the head turns into a turn before the body does", { skip: K.NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    const a = person(kind, SCENE[kind]);
    const st = await K.setup(kind, a, { frames: 241 });
    const rows = playBody(st, a);
    // the turn round after the stop (the body turns over frames ~110-135): the head is ahead of it, toward the turn
    const turn = wrap(rows[140].heading - rows[100].heading);
    let lead = 0;
    for (let f = 100; f <= 135; f++) lead = Math.max(lead, Math.sign(turn) * rows[f].headYaw);
    // was 3.8 / 13.5 degrees at most off the body, never ahead of it into the turn
    assert.ok(lead > 12, `${kind}: the head ${lead.toFixed(1)} deg ahead of the body into the turn`);
  }
});

test("real Rocketbox: arm swing grows with walking speed and differs person to person", { skip: K.NOT_INSTALLED }, async () => {
  const swing = async (id, v) => {
    const d = v * 5, a = { id, kind: "man", height_m: 1.8, position: [-d / 2, 0, 0], keys: [kf(0, [-d / 2, 0, 0]), kf(120, [d / 2, 0, 0])] };
    const st = await K.setup("man", a, { frames: 121 });
    return range(playBody(st, a).slice(45, 75).map((r) => r.arm));
  };
  const slow = await swing("crowd_0", 0.7), fast = await swing("crowd_0", 1.5);
  // was 27.4 deg at 0.7 m/s and 27.5 at 1.7 m/s
  assert.ok(fast > 1.15 * slow, `arm swing ${slow.toFixed(1)} deg at 0.7 m/s, ${fast.toFixed(1)} at 1.5`);
  const crowd = [];
  for (let i = 0; i < 4; i++) crowd.push(await swing(`crowd_${i}`, 1.2));
  const spread = range(crowd) / (crowd.reduce((s, x) => s + x, 0) / crowd.length);
  // was 0.4 % between four men on the same keys
  assert.ok(spread > 0.05, `four men's arm swing: ${crowd.map((x) => x.toFixed(1))} deg (${(100 * spread).toFixed(1)} % apart)`);
});

test("real Rocketbox: standing still the chest breathes; stopping, the upper body rocks forward and settles", { skip: K.NOT_INSTALLED }, async () => {
  const L = await import("../../web/stage/people/locomotion.mjs");
  for (const kind of ["man", "woman"]) {
    const a = person(kind, SCENE[kind]);
    const on = playBody(await K.setup(kind, a, { frames: 241 }), a);
    L.OPTS.layer = false;
    let off;
    try { off = playBody(await K.setup(kind, person(kind, SCENE[kind]), { frames: 241 }), a); } finally { L.OPTS.layer = true; }
    const d = on.map((r, f) => r.chest - off[f].chest);
    // the stop at SCENE[kind][2]: a lean that rocks and settles within ~1 s (was nothing over the clip)
    const s = SCENE[kind][2].frame;
    const rock = range(d.slice(s - 10, s + 20)), later = range(d.slice(s + 24, s + 30));
    assert.ok(rock > 1.0, `${kind}: the upper body rocks ${rock.toFixed(2)} deg at the stop`);
    assert.ok(later < rock / 2, `${kind}: and settles (${later.toFixed(2)} deg a second later)`);
    // a breath: a standing person's chest moves on its own, slowly (0.2-0.3 Hz), under a degree
    const b = { id: `stand_${kind}`, kind, height_m: K.heightOf(kind), position: [0, 0, 0], keys: [kf(0, [0, 0, 0])] };
    const st = await K.setup(kind, b, { frames: 241 });
    const r1 = playBody(st, b).map((r) => r.chest);
    L.OPTS.layer = false;
    let r0;
    try { r0 = playBody(await K.setup(kind, { ...b }, { frames: 241 }), b).map((r) => r.chest); } finally { L.OPTS.layer = true; }
    const br = r1.map((x, f) => x - r0[f]);
    assert.ok(range(br) > 0.3 && range(br) < 2, `${kind}: the breath moves the chest ${range(br).toFixed(2)} deg`);
    let flips = 0; for (let f = 1; f < br.length; f++) if (Math.sign(br[f]) !== Math.sign(br[f - 1])) flips++;
    assert.ok(flips >= 2 && flips <= 6, `${kind}: ${flips} zero crossings in 10 s (a slow breath)`);
  }
});

test("real Rocketbox: the audit scene's feet stay grounded (curve, stop, turn round, set off)", { skip: K.NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    const a = person(kind, SCENE[kind]);
    const st = await K.setup(kind, a, { frames: 241 });
    const s = K.physical(K.measure(st, a));
    // was: the man's pelvis dropped 4.3 cm to reach a planted foot, the woman's touching sole slid 1.08 cm in a frame
    assert.ok(s.pen > -0.01 && s.slide <= 0.01 && s.float === 0 && s.drop <= 0.025, `${kind}: ${K.fmt(s)}`);
  }
});
