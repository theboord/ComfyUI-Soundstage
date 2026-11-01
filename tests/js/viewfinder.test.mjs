// Phone viewfinder (Milestone 20): lens / focus / aperture mapping, framing, gyro, the rig, key recording + smoothing,
// the sync protocol and the QR encoder. node --test tests/js/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../../web/vcam/vfcore.mjs";
import { qrMatrix, rsEncode } from "../../web/vcam/qr.mjs";
import { takeToCamera } from "../../web/vcam/live.mjs";
import { eulerOf, forwardOf, qrotate, stageCameraAt } from "../../web/movefit/stabilize.mjs";

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (±${eps})`);

test("lens buttons are the App's prime set and the nearest prime is picked in log space", () => {
  assert.deepEqual(V.PRIMES, [14, 18, 24, 35, 50, 85, 135]);
  assert.equal(V.nearestPrime(40), 35);
  assert.equal(V.nearestPrime(44), 50);
  assert.equal(V.nearestPrime(100), 85);
  assert.equal(V.nearestPrime(500), 135);
});

test("zoom: pinch scales with the spread, the rocker is exponential, both clamp, smoothing converges", () => {
  near(V.pinchFocal(35, 100, 200), 70, 1e-9);
  near(V.pinchFocal(35, 200, 100), 17.5, 1e-9);
  assert.equal(V.pinchFocal(35, 100, 10000), V.FOCAL_MAX);
  assert.equal(V.pinchFocal(35, 100, 1), V.FOCAL_MIN);
  near(V.rockerFocal(35, 1, 1, 0.7), 35 * Math.exp(0.7), 1e-9);
  near(V.rockerFocal(V.rockerFocal(35, 1, 0.5), -1, 0.5), 35, 1e-9);
  let f = 24;
  for (let i = 0; i < 60; i++) f = V.approach(f, 85, 1 / 60, 0.09, true);
  near(f, 85, 0.05, "1 s of smoothing");
  // frame-rate independent: 30 steps of 1/30 s == 60 steps of 1/60 s
  let a = 24, b = 24;
  for (let i = 0; i < 30; i++) a = V.approach(a, 85, 1 / 30, 0.2, true);
  for (let i = 0; i < 60; i++) b = V.approach(b, 85, 1 / 60, 0.2, true);
  near(a, b, 1e-9);
});

test("focus ring: diopter-based, 0 = 0.3 m, 1 = infinity, round-trips", () => {
  assert.equal(V.ringToFocus(0), 0.3);
  assert.equal(V.ringToFocus(1), V.FOCUS_INF);
  for (const m of [0.3, 0.5, 1, 2, 5, 10, 40]) near(V.ringToFocus(V.focusToRing(m)), m, m * 1e-9);
  const u = V.FOCUS_MARKS.map(V.focusToRing);
  for (let i = 1; i < u.length; i++) assert.ok(u[i] > u[i - 1], "marks in order");
  assert.ok(V.focusToRing(1) > 0.4 && V.focusToRing(1) < 0.5 && V.focusToRing(5) > 0.7 && V.focusToRing(5) < 0.8, "1 m and 5 m land under a thumb");
  assert.equal(V.fmtFocus(0.45), "45 cm");
  assert.equal(V.fmtFocus(2.44), "2.4 m");
  assert.equal(V.fmtFocus(1000), "∞");
});

test("T-stop slider: 8 stops T1.4..T22 in thirds, engraved names, round-trips", () => {
  assert.equal(V.sliderToStop(0), 1.4);
  assert.equal(V.sliderToStop(1), 22);
  for (const n of V.FULL_STOPS) assert.equal(V.sliderToStop(V.stopToSlider(n)), n);
  assert.equal(V.sliderToStop(V.stopToSlider(2.8) + 1 / 24), 3.2);   // a third of a stop up
  assert.equal(V.fmtStop(2.83), "T2.8");
  assert.equal(V.fmtStop(11.3), "T11");
});

test("depth of field and circle of confusion follow the thin-lens formulas", () => {
  const d = V.dofLimits(50, 2.8, 3);
  near(d.hyper, 0.05 ** 2 / (2.8 * 0.00003) + 0.05, 1e-9);
  assert.ok(d.near < 3 && d.far > 3 && d.far - d.near < 0.7, "50 mm T2.8 at 3 m is shallow");
  assert.equal(V.dofLimits(24, 16, 10).far, Infinity, "past hyperfocal");
  assert.equal(V.cocPx(50, 2.8, 3, 3, 1000), 0, "in focus");
  // stopping down two stops halves... quarters? the blur scales with 1/N
  near(V.cocPx(50, 2.8, 3, 10, 1000) / V.cocPx(50, 5.6, 3, 10, 1000), 2, 1e-9);
  near(V.cocPx(50, 2.8, 3, 10, 1000), V.cocScale(50, 2.8, 3, 1000) * Math.abs(10 - 3) / 10, 1e-9);
  assert.ok(V.cocPx(85, 1.4, 2, 20, 1000) > V.cocPx(24, 1.4, 2, 20, 1000), "longer lens, more blur");
});

test("framing: the delivery frame fits the phone and its vertical FOV matches the stage", () => {
  const r = V.viewRect(844, 390, 1.875, 35);
  near(r.rect.h, 390, 1e-9); near(r.rect.w, 390 * 1.875, 1e-9); near(r.rect.x, (844 - 731.25) / 2, 1e-9);
  near(r.vfov, V.vfovOf(35, 1.875), 1e-9, "frame fills the height: same vfov as the shot");
  const s = V.viewRect(844, 390, 2.375, 35);           // scope is wider than the phone: fit the width
  near(s.rect.w, 844, 1e-9);
  near(Math.tan((s.vfov * Math.PI) / 360) * (s.rect.h / 390), Math.tan((V.vfovOf(35, 2.375) * Math.PI) / 360), 1e-9);
  const m = V.innerAspect({ x: 0, y: 0, w: 750, h: 400 }, 2.39);
  near(m.w / m.h, 2.39, 1e-9); near(m.w, 750, 1e-9);
  assert.equal(V.timecode(24 * 61 + 5, 24), "00:01:01:05");
});

test("gyro: a sideways phone held upright looks at the horizon, tilting it down tilts the camera", () => {
  const q = V.gyroQuat(0, 0, -90, 90);
  const f = forwardOf(q), up = qrotate(q, [0, 1, 0]);
  near(f[1], 0, 1e-9, "level"); near(up[1], 1, 1e-9, "upright");
  near(eulerOf(V.gyroQuat(0, 0, -60, 90)).pitch, -30, 1e-6, "30° down");
  near(V.rollRad(V.gyroQuat(0, 0, -90, 90)), 0, 1e-9);
  const yp = V.quatYawPitch(30, -10);
  near(eulerOf(yp).yaw, 30, 1e-9); near(eulerOf(yp).pitch, -10, 1e-9);
});

test("rig: re-centre = the shot camera; heading is relative, tilt absolute; the stick walks smoothly", () => {
  const rig = new V.VfRig();
  const shot = { position: [2, 1.6, 8], target: [2, 1.6, 0] };   // looking -Z
  rig.recenter(shot);
  const g = V.gyroQuat(123, 0, -90, 90);                          // whatever the phone's compass says
  let c = rig.step(1 / 60, { gyro: g });
  assert.deepEqual(c.position, [2, 1.6, 8]);
  near(eulerOf(c.quaternion).yaw, 0, 1e-6, "phone heading at re-centre = the shot camera's");
  c = rig.step(1 / 60, { gyro: V.gyroQuat(153, 0, -90, 90) });   // turn the phone 30° left
  near(eulerOf(c.quaternion).yaw, 30, 1e-6);
  // full stick forward for 2 s: eased start, then ~speed m/s along the heading
  rig.recenter(shot);
  let p0 = null;
  for (let i = 0; i < 120; i++) { c = rig.step(1 / 60, { stick: [0, 1] }); if (i === 0) p0 = c.position; }
  assert.ok(p0[2] > 7.99, "no jump on the first frame");
  assert.ok(c.position[2] < 8 - 1.8 && c.position[2] > 8 - 2.4, `walked ~2 m: ${c.position[2]}`);
  near(c.position[0], 2, 1e-9);
  // no gyro: drag to look
  rig.recenter(shot); rig.look(10, 5);
  c = rig.step(1 / 60, {});
  near(eulerOf(c.quaternion).yaw, 10, 1e-6); near(eulerOf(c.quaternion).pitch, 5, 1e-6);
  // level on: a rolled phone still gives a level camera; off: the roll comes through
  const rolled = V.gyroQuat(0, 0, -80, 90);
  const tilt = (deg) => { const q = rolled; return q; };
  rig.recenter(shot); rig.level = true;
  near(rig.step(1 / 60, { gyro: tilt() }).roll, 0, 1e-12);
});

// A synthetic viewfinder take: a push-in with a rack focus at 1.5-2.5 s, an iris change, zoom from 35 to 50 mm.
function synthTake({ seconds = 4, hz = 60, jitter = 0.002, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const samples = [];
  for (let i = 0; i <= seconds * hz; i++) {
    const t = i / hz, u = t / seconds;
    const rack = Math.min(1, Math.max(0, (t - 1.5) / 1)), e = rack * rack * (3 - 2 * rack);
    samples.push({ t, position: [jitter * rnd(), 1.6 + jitter * rnd(), 6 - 2 * u * u * (3 - 2 * u)], quaternion: [0, 0, 0, 1],
      focal_mm: 35 + 15 * u, focus_m: 1 / (1 / 1.5 + (1 / 6 - 1 / 1.5) * e), t_stop: t < 3 ? 2.8 : 5.6 });
  }
  return { samples, settings: { space: "set", startFrame: 0, fps: 24, lastFrame: 96, stabilize: false, horizonLock: true } };
}

test("recording: samples -> keys at the stage fps; the stage's playback of the keys follows the take", () => {
  const take = synthTake();
  const { keys, lensKeys, frames, info } = V.takeToKeys(take);
  assert.equal(frames.length, 97); assert.equal(frames[0].frame, 0); assert.equal(frames.at(-1).frame, 96);
  assert.ok(keys.length >= 2 && keys.length < 60, `${keys.length} keys`);
  assert.equal(info.keys, keys.length);
  for (const k of lensKeys) for (const f of ["focus_m", "t_stop"]) assert.ok(Number.isFinite(k[f]), `lens key has ${f}`);
  assert.ok(lensKeys.length >= 3 && lensKeys.length < 40, `${lensKeys.length} lens keys`);
  assert.equal(info.lensKeys, lensKeys.length);
  let worstP = 0, worstD = 0, worstS = 0, worstF = 0;
  for (const fr of frames) {
    const c = stageCameraAt(keys, fr.frame), l = V.lensAt(lensKeys, fr.frame);
    worstP = Math.max(worstP, Math.hypot(...c.position.map((v, k) => v - fr.position[k])));
    worstF = Math.max(worstF, Math.abs(c.focal_mm - fr.focal_mm));
    worstD = Math.max(worstD, Math.abs(1 / l.focus_m - 1 / fr.focus_m));
    worstS = Math.max(worstS, Math.abs(Math.log2(l.t_stop / fr.t_stop)));
  }
  assert.ok(worstP < 0.02, `path ${worstP}`);
  assert.ok(worstF < 0.8, `focal ${worstF}`);
  assert.ok(worstD < 0.05, `focus ${worstD} diopters`);
  assert.ok(worstS < 0.2, `iris ${worstS} stops`);
  // the rack is in the right place: before 1.5 s focus is near 1.5 m, after 2.5 s near 6 m
  near(V.lensAt(lensKeys, 24).focus_m, 1.5, 0.12); near(V.lensAt(lensKeys, 72).focus_m, 6, 0.8);
  near(V.lensAt(lensKeys, 60).t_stop, 2.8, 0.3); near(V.lensAt(lensKeys, 84).t_stop, 5.6, 0.5);
});

test("smoothing: light filtering removes sensor jitter without lag; Stabilize removes more", () => {
  const take = synthTake({ jitter: 0.03, seed: 3 });
  const hf = (frames) => { let e = 0; for (let i = 1; i < frames.length - 1; i++) e += Math.abs(frames[i + 1].position[0] - 2 * frames[i].position[0] + frames[i - 1].position[0]); return e; };
  const rawFrames = Array.from({ length: 97 }, (_, f) => ({ position: take.samples[Math.round((f / 24) * 60)].position }));
  const light = V.takeToKeys(take).frames, stab = V.takeToKeys(take, { stabilize: true }).frames;
  assert.ok(hf(light) < hf(rawFrames) * 0.5, `light ${hf(light)} vs raw ${hf(rawFrames)}`);
  assert.ok(hf(stab) < hf(light), `stabilized ${hf(stab)} < light ${hf(light)}`);
  near(light[48].position[2], 5, 0.02, "no lag mid-move");
});

test("takeToCamera keeps a viewfinder take on the set (no re-anchoring) and carries its lens channels", () => {
  const take = synthTake();
  const r = takeToCamera(take, { anchor: { position: [50, 0, 50], yaw: 90 } });
  near(r.keys[0].position[2], 6, 0.02);
  assert.equal(r.rig, null);
  assert.ok(r.lensKeys.length >= 2 && r.lensKeys.every((k) => k.focus_m > 0 && k.t_stop > 0));
});

test("reduceLensKeys: a focus pull gets keys where it happens, a steady lens only two", () => {
  const frames = Array.from({ length: 49 }, (_, f) => ({ frame: f, focus_m: f < 20 ? 2 : f > 28 ? 8 : 1 / (0.5 + (0.125 - 0.5) * ((f - 20) / 8)), t_stop: 2.8 }));
  const out = V.reduceLensKeys(frames);
  assert.ok(out.length > 2, `${out.length} keys`);
  for (const fr of frames) near(1 / V.lensAt(out, fr.frame).focus_m, 1 / fr.focus_m, 0.031);
  assert.deepEqual(out.map((k) => k.frame), [...out.map((k) => k.frame)].sort((a, b) => a - b));
  assert.ok(out.slice(1, -1).every((k) => k.frame >= 15 && k.frame <= 33), "the extra keys sit on the pull");
  assert.equal(V.reduceLensKeys(frames.map((f) => ({ ...f, focus_m: 3 }))).length, 2);
});

test("TakeRecorder: monotonic samples, clock maps to stage frames", () => {
  const r = new V.TakeRecorder();
  r.start(100, 0, 24);
  const cam = { position: [0, 1, 2], quaternion: [0, 0, 0, 1], focal_mm: 35, focus_m: 3, t_stop: 2.8 };
  r.add(100, cam); r.add(100.5, cam); r.add(100.4, cam); r.add(101, cam);
  assert.deepEqual(r.samples.map((s) => s.t), [0, 0.5, 1]);
  near(r.clock(102).frame, 48, 1e-9);
  r.stop(); r.add(103, cam);
  assert.equal(r.samples.length, 3);
});

test("protocol: vf messages, scene signature ignores cameras, cameras patch in place, server messages validated", () => {
  const m = V.vfMessage({ position: [1, 2, 3], target: [0, 0, 0], focal_mm: 50.123, focus_m: 2.5, t_stop: 2.8, roll: 0.01 }, { frame: 12.345, recording: true });
  assert.equal(m.type, "vf"); assert.equal(m.cam.focal_mm, 50.12); assert.equal(m.frame, 12.35); assert.equal(m.recording, true);
  assert.deepEqual(V.vfState("keep", { id: "x" }), { type: "vfstate", event: "keep", data: { id: "x" } });
  const a = { actors: [{ id: "a" }], camera_keys: [{ frame: 0 }], shots: [{ id: "s1", camera_keys: [{ frame: 0, position: [0, 0, 0] }] }], active_shot: "s1" };
  const b = JSON.parse(JSON.stringify(a)); b.shots[0].camera_keys = [{ frame: 0, position: [1, 1, 1] }]; b.shots[0].rig = { type: "free" }; b.shots[0].lens_keys = [{ frame: 0, focus_m: 2, t_stop: 4 }];
  assert.equal(V.sceneSig(a), V.sceneSig(b), "camera edits don't rebuild the set");
  const c = JSON.parse(JSON.stringify(a)); c.actors.push({ id: "b" });
  assert.notEqual(V.sceneSig(a), V.sceneSig(c));
  const st = JSON.parse(JSON.stringify(a));
  V.patchCameras(st, b);
  assert.deepEqual(st.shots[0].camera_keys[0].position, [1, 1, 1]); assert.deepEqual(st.shots[0].rig, { type: "free" });
  assert.equal(st.shots[0].lens_keys[0].t_stop, 4);
  assert.equal(V.parseServer('{"type":"scene","scene":{"a":1}}').type, "scene");
  assert.equal(V.parseServer('{"type":"scene"}'), null);
  assert.equal(V.parseServer('{"type":"exec"}'), null);
  assert.equal(V.parseServer("nope"), null);
  assert.equal(V.parseServer({ type: "sync", frame: "x" }), null);
  assert.equal(V.viewfinderUrl("http://127.0.0.1:8189"), "http://127.0.0.1:8189/soundstage/vcam/viewfinder");
  assert.equal(V.viewfinderUrl("http://127.0.0.1:8189", { url: "https://mac.local:8443/soundstage/vcam/viewfinder?vk=k" }), "https://mac.local:8443/soundstage/vcam/viewfinder?vk=k");
  assert.ok(V.isLoopback("http://127.0.0.1:8189/x") && V.isLoopback("http://localhost/") && !V.isLoopback("https://mac.local:8443/"));
});

test("stage keys carry the lens channels and play them back like vfcore.lensAt", async () => {
  // Stage._cameraAt and lensAt use the same easing; compare on a 3-key set.
  const keys = [{ frame: 0, focus_m: 1, t_stop: 2, roll: 0 }, { frame: 10, focus_m: 4, t_stop: 8, roll: 0.1 }, { frame: 30, focus_m: 4, t_stop: 8, roll: 0 }];
  const l = V.lensAt(keys, 5);
  near(1 / l.focus_m, (1 + 0.25) / 2, 1e-9, "half-way in diopters");
  near(l.t_stop, 4, 1e-9, "half-way in stops");
  near(l.roll, 0.05, 1e-9);
  assert.deepEqual(V.lensAt([{ frame: 0 }, { frame: 10 }], 5), {}, "old keys: nothing");
  const src = (await import("node:fs")).readFileSync(new URL("../../web/stage/stage.mjs", import.meta.url), "utf8");
  assert.match(src, /cam\.focus_m = 1 \/ \(1 \/ ka\.focus_m \+ \(1 \/ kb\.focus_m - 1 \/ ka\.focus_m\) \* e\)/);
  assert.match(src, /const lk = this\.activeShot\?\.\(\)\?\.lens_keys;/, "the stage plays the shot's lens_keys");
  assert.match(src, /setLensKeys\(keys\) \{/);
});

test("QR: Reed-Solomon, structure (finders, timing, format), versions grow with the text", () => {
  // RS codewords of "HELLO WORLD" 1-M data (a well-known worked example)
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  const url = "https://michaels-imac-pro.local:8443/soundstage/vcam/viewfinder?vk=Zx81kq0PbT3sWf7yA2x9Lm";
  const q = qrMatrix(url);
  assert.equal(q.size, q.version * 4 + 17);
  const m = q.modules;
  for (const [r0, c0] of [[0, 0], [0, q.size - 7], [q.size - 7, 0]]) {
    for (let i = 0; i < 7; i++) { assert.equal(m[r0][c0 + i], true); assert.equal(m[r0 + 6][c0 + i], true); assert.equal(m[r0 + i][c0], true); }
    assert.equal(m[r0 + 1][c0 + 1], false); assert.equal(m[r0 + 3][c0 + 3], true);
  }
  for (let i = 8; i < q.size - 8; i++) assert.equal(m[6][i], i % 2 === 0, "timing");
  assert.equal(m[q.size - 8][8], true, "dark module");
  assert.ok(qrMatrix("x".repeat(200)).version > qrMatrix("x".repeat(20)).version);
  assert.throws(() => qrMatrix("x".repeat(400)));
});
