// node --test tests/js/camcurve.test.mjs
// The smooth camera curve (curve version 2, web/stage/camcurve.mjs), from the C3 smoothness report: Hermite tangents
// from the key times, an overshoot limiter, holds from rest, focal in log space, easing only at the ends, optional even
// speed; old shots keep the old curve until re-keyed; the Coach, the key fitter and the stage agree; the actors' paths
// are untouched; frame N is the same however it is reached.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import * as CC from "../../web/stage/camcurve.mjs";
import * as R from "../../web/coach/rules.mjs";
import { stageCameraAt, reduceKeys } from "../../web/movefit/stabilize.mjs";
import { playAt } from "../../web/stage/takefix.mjs";

function headless(scene) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: structuredClone(scene),
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.state.environment = { ...(st.state.environment || {}), set: "studio" };
  st.onChange = () => {};
  st.scene.add(st.root);
  try { st._buildSet(); } catch { /* not what these tests look at */ }
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}

// C3's keys: frames 0, 12, 48, 60, 96 (uneven times), equal gaps along the path, 97 frames; a gentle curve so the
// direction changes too, and a zoom 24 -> 100 mm.
const KF = [0, 12, 48, 60, 96];
const FOCAL = [24, 32, 45, 60, 100];
const keysC3 = () => KF.map((frame, i) => ({ frame, position: [2 * i, 1.6 + 0.15 * Math.sin(i), -8 + 0.4 * i * i * 0.25], target: [2 * i + 0.5, 1.2, 0], focal_mm: FOCAL[i] }));
const scene = (shot = {}) => ({ shot: { frames: 97, fps: 24 }, actors: [], camera: { position: [0, 1.6, -8], target: [0, 1.2, 0], focal_mm: 35 },
  shots: [{ id: "s", name: "S", setup: "single", camera_keys: keysC3(), ...shot }], active_shot: "s" });
const sub = (a, b) => a.map((x, i) => x - b[i]);
const len = (a) => Math.hypot(...a);

/** One-sided velocity jump at frame f: |v(f -> f+1) - v(f-1 -> f)|. */
const jumpAt = (P, f) => len(sub(sub(P(f + 1), P(f)), sub(P(f), P(f - 1))));

function camSampler(shot) {
  const st = headless(scene(shot));
  return { st, P: (f) => st._cameraAt(f).position, F: (f) => st._cameraAt(f).focal_mm };
}

test("C3 1: the velocity jump across each interior key is at most 1.5x the same measure on the neighbouring frames (the old curve fails)", () => {
  const ratios = (P) => KF.slice(1, -1).map((k) => jumpAt(P, k) / ((jumpAt(P, k - 1) + jumpAt(P, k + 1)) / 2));
  const v2 = ratios(camSampler({ cam_curve: 2 }).P);
  const v1 = ratios(camSampler({}).P);
  for (const [i, r] of v2.entries()) assert.ok(r <= 1.5, `key ${KF[i + 1]}: ${r.toFixed(2)}`);
  assert.ok(Math.max(...v1) > 1.5, `the old curve has the speed jump this fixes (worst ${Math.max(...v1).toFixed(2)})`);
  // speed itself: frame-to-frame speed ratio across each key is close to 1 (old: the 3x jump of uniform tangents)
  const sp = (P, f) => len(sub(P(f + 1), P(f)));
  const { P } = camSampler({ cam_curve: 2 });
  for (const k of KF.slice(1, -1)) { const r = sp(P, k) / sp(P, k - 1); assert.ok(r > 0.8 && r < 1.25, `speed across key ${k}: ${r.toFixed(3)}`); }
});

test("C3 2: every key is hit at its own frame (within 0.001), and a hold ramps to a true stop with nothing hiding it", () => {
  const { st, P } = camSampler({ cam_curve: 2 });
  for (const k of st.activeShot().camera_keys) {
    assert.ok(len(sub(P(k.frame), k.position)) < 1e-3, `position at frame ${k.frame}`);
    assert.ok(len(sub(st._cameraAt(k.frame).target, k.target)) < 1e-3);
    assert.ok(Math.abs(st._cameraAt(k.frame).focal_mm - k.focal_mm) < 1e-9);
  }
  // a hold between frames 30 and 50: still inside, from rest into it and out of it, never bowing back
  const hold = [{ frame: 0, position: [0, 1.6, 0], target: [0, 1, 5], focal_mm: 35 }, { frame: 30, position: [3, 1.6, 0], target: [3, 1, 5], focal_mm: 35 },
    { frame: 50, position: [3, 1.6, 0], target: [3, 1, 5], focal_mm: 35 }, { frame: 80, position: [6, 1.6, 0], target: [6, 1, 5], focal_mm: 35 }];
  const H = (f) => CC.cameraCurveAt(hold, f).position;
  for (let f = 30; f <= 50; f++) assert.deepEqual(H(f), [3, 1.6, 0], `still at ${f}`);
  assert.ok(len(sub(H(30), H(29))) < 0.01 && len(sub(H(51), H(50))) < 0.01, "arrives at rest, leaves from rest");
  for (let f = 0; f < 80; f++) assert.ok(H(f + 1)[0] >= H(f)[0] - 1e-9, `never moves backwards (frame ${f})`);
});

test("C3 3: the zoom rate (log focal) at an interior key is at least 80% of its neighbours' average (old: zero at every key)", () => {
  const rate = (F, f) => Math.log(F(f + 1)) - Math.log(F(f));
  const check = (F) => KF.slice(1, -1).map((k) => ((rate(F, k) + rate(F, k - 1)) / 2) / ((rate(F, k - 2) + rate(F, k + 1)) / 2));
  const v2 = check(camSampler({ cam_curve: 2 }).F);
  for (const [i, r] of v2.entries()) assert.ok(r >= 0.8, `key ${KF[i + 1]}: ${r.toFixed(3)}`);
  const v1 = check(camSampler({}).F);
  assert.ok(Math.min(...v1) < 0.8, `the old smoothstep stalls the zoom at keys (${Math.min(...v1).toFixed(3)})`);
});

test("C3 4: even speed, with more arc-length divisions: mid-shot max / min speed is within 1.05", () => {
  const keys = keysC3();
  const P = (f) => CC.cameraCurveAt(keys, f, { even: true, arcLengthDivisions: 8192 }).position;
  const lo = Math.ceil(96 * CC.EVEN_RAMP) + 1, hi = Math.floor(96 * (1 - CC.EVEN_RAMP)) - 1;
  const speeds = [];
  for (let f = lo; f < hi; f++) speeds.push(len(sub(P(f + 1), P(f))));
  const ratio = Math.max(...speeds) / Math.min(...speeds);
  assert.ok(ratio <= 1.05, `mid-shot max/min ${ratio.toFixed(4)}`);
  // it starts and ends on the first and last keys, at rest
  assert.ok(len(sub(P(0), keys[0].position)) < 1e-9 && len(sub(P(96), keys[4].position)) < 1e-9);
  assert.ok(len(sub(P(1), P(0))) < speeds[0] * 0.2);
  // the stage plays it from the shot's cam_speed
  const { P: SP } = camSampler({ cam_curve: 2, cam_speed: "even" });
  assert.ok(len(sub(SP(40), CC.cameraCurveAt(keys, 40, { even: true }).position)) < 1e-9);
  // a camera that only pans: timed by the target's path
  const pan = [{ frame: 0, position: [0, 1.6, 0], target: [-3, 1, 5], focal_mm: 35 }, { frame: 20, position: [0, 1.6, 0], target: [0, 1, 5], focal_mm: 35 },
    { frame: 90, position: [0, 1.6, 0], target: [4, 1, 5], focal_mm: 35 }];
  const T = (f) => CC.cameraCurveAt(pan, f, { even: true, arcLengthDivisions: 8192 }).target;
  const ts = []; for (let f = 25; f < 65; f++) ts.push(len(sub(T(f + 1), T(f))));
  assert.ok(Math.max(...ts) / Math.min(...ts) <= 1.05);
});

test("C3 gate: frame N is the same after sequential, shuffled and scrubbed evaluation (rig and all)", () => {
  for (const extra of [{ cam_curve: 2 }, { cam_curve: 2, cam_speed: "even" }, { cam_curve: 2, rig: { type: "dolly", amount: 1, seed: 7 } }, { cam_curve: 2, rig: { type: "handheld", amount: 1, seed: 3 } }]) {
    const fresh = () => headless(scene(extra));
    const at = (st, f) => JSON.stringify(st._shotCameraAt(f));
    const a = fresh(), seq = []; for (let f = 0; f <= 96; f++) seq.push(at(a, f));
    const b = fresh(), order = [...Array(97).keys()].sort((x, y) => ((x * 7919) % 97) - ((y * 7919) % 97)), shuf = new Array(97);
    for (const f of order) shuf[f] = at(b, f);
    const c = fresh(); let x = 50; const scrub = new Array(97);
    for (let n = 0; n < 400; n++) { x = (x * 37 + 11) % 97; c.setFrame(x); scrub[x] = at(c, x); }
    for (let f = 0; f <= 96; f++) {
      assert.equal(shuf[f], seq[f], `${JSON.stringify(extra)} frame ${f}: shuffled`);
      if (scrub[f]) assert.equal(scrub[f], seq[f], `${JSON.stringify(extra)} frame ${f}: scrubbed`);
    }
  }
});

test("old shots keep the old curve until re-keyed; new setups follow the shot they start from; setCameraCurve", () => {
  const st = headless(scene());
  const keys = st.activeShot().camera_keys;
  assert.equal(st.cameraCurve(), "legacy");
  for (const f of [0, 7, 30, 55, 96]) assert.deepEqual(st._cameraAt(f).position, Stage._sample(keys, f, "position"), `old curve exactly, frame ${f}`);
  // setCameraKeys (a copy, a fitted take) keeps the shot's curve
  st.setCameraKeys(keysC3());
  assert.equal(st.cameraCurve(), "legacy");
  // a new setup from a legacy shot is legacy (the Cut's duplicate copies its keys onto it: it must move the same)
  st.addShot("single");
  assert.equal(st.cameraCurve(), "legacy");
  st.setCameraKeys(keysC3());
  st.setActiveShot("s");
  const orig = st._cameraAt(30).position;
  st.setActiveShot(st.state.shots[1].id);
  assert.deepEqual(st._cameraAt(30).position, orig, "the copy moves like the original");
  // re-keying the camera on the stage (a key at the playhead) moves the shot onto the smooth curve
  st.setFrame(70);
  st.setKeyHere();
  assert.equal(st.activeShot().cam_curve, 2);
  assert.equal(st.cameraCurve(), "smooth");
  st.addShot("wide");
  assert.equal(st.activeShot().cam_curve, 2, "a setup from a smooth shot is smooth");
  // the API
  assert.deepEqual(st.setCameraCurve("even"), { ok: true, curve: "even" });
  assert.equal(st.activeShot().cam_speed, "even");
  assert.deepEqual(st.setCameraCurve("legacy"), { ok: true, curve: "legacy" });
  assert.equal(st.activeShot().cam_curve, undefined);
  assert.equal(st.setCameraCurve("bouncy").ok, false);
  // deleting a key at the playhead is a re-key too; deleting nothing is not
  st.setFrame(13); st.deleteKeyHere();
  assert.equal(st.cameraCurve(), "legacy", "no key at 13: nothing changed");
});

test("parity on a new-curve shot: the Coach's camera and track, the key fitter's playback and the stage agree; actors are untouched", () => {
  for (const extra of [{ cam_curve: 2 }, { cam_curve: 2, cam_speed: "even" }, { cam_curve: 2, rig: { type: "jib", amount: 1, seed: 5 } }]) {
    const st = headless(scene(extra));
    const shot = st.toJSON().shots[0];
    for (const f of [0, 5, 12, 31, 48, 59.5, 77, 96]) {
      const a = st._cameraAt(f), b = R.cameraAt(shot, f);
      for (const k of ["position", "target"]) assert.ok(a[k].every((v, i) => Math.abs(v - b[k][i]) < 1e-12), `coach ${k} f${f}`);
      assert.ok(Math.abs(a.focal_mm - b.focal_mm) < 1e-12);
      if (!extra.cam_speed) {
        const c = stageCameraAt(shot.camera_keys, f, 2);
        assert.ok(a.position.every((v, i) => Math.abs(v - c.position[i]) < 1e-12), `stabilize f${f}`);
      }
    }
    const live = st.cameraTrack(), mine = R.cameraTrack({ scene: st.toJSON() }, shot);
    assert.equal(mine.length, live.length);
    for (let f = 0; f < live.length; f++) assert.ok(live[f].position.every((v, i) => Math.abs(v - mine[f].position[i]) < 1e-9), `track f${f}`);
  }
  // actors share the old curve and keep it (camera keys only), as takefix.playAt replays it
  const st = headless({ ...scene({ cam_curve: 2 }), actors: [{ id: "a", kind: "man", height_m: 1.8, position: [0, 0, 0],
    keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 12, position: [2, 0, 1] }, { frame: 60, position: [5, 0, 0] }, { frame: 96, position: [9, 0, 2] }] }] });
  const a = st.state.actors[0];
  for (const f of [0, 6, 30, 70, 96]) {
    assert.deepEqual(st._actorPosAt(a, f), Stage._sample(a.keys, f, "position", false, false));
    const t = playAt(a.keys.map((k) => ({ ...k, heading_deg: 0 })), f, (k) => k.position);
    assert.ok(t.every((v, i) => Math.abs(v - Stage._sample(a.keys, f, "position", false, true)[i]) < 1e-12), "takefix replay = the stage's actor curve");
  }
});

test("the key fitter (stabilize.reduceKeys) fits keys to the curve they will play on", () => {
  // a smooth take: an S move over 97 frames
  const frames = [];
  for (let f = 0; f <= 96; f++) { const u = f / 96; frames.push({ frame: f, position: [6 * u, 1.6 + 0.3 * Math.sin(u * 6), -8 + 2 * Math.sin(u * 3)], target: [0, 1.2, 0], focal_mm: 35 }); }
  const worstOn = (keys, play) => Math.max(...frames.map((fr) => len(sub(stageCameraAt(keys, fr.frame, play).position, fr.position))));
  const fit = {};
  for (const curve of [1, 2]) {
    const { keys, maxError } = reduceKeys(frames, { tolerance: 0.015, curve });
    assert.ok(keys.length >= 2 && keys.length < 48, `${keys.length} keys`);
    assert.ok(maxError <= 0.015 + 1e-9, `curve ${curve}: max error ${maxError} (its across / along-path metric, on that curve)`);
    fit[curve] = keys;
  }
  // keys fitted for the smooth curve play back on it closer than keys fitted for the old one would
  assert.ok(worstOn(fit[2], 2) < worstOn(fit[1], 2), `${worstOn(fit[2], 2).toFixed(4)} vs ${worstOn(fit[1], 2).toFixed(4)} m`);
  // linearWeights is the curve's linear part: equal to the curve wherever the limiter and holds don't act
  const t = [0, 10, 40, 52, 96], vals = t.map((x) => [x * x * 0.001]);   // monotone, gently curving
  const ks = t.map((frame, i) => ({ frame, position: [vals[i][0], 0, 0], target: [0, 0, 1], focal_mm: 35 }));
  for (const f of [3, 10, 25, 45, 70]) {
    const w = CC.linearWeights(t, f).reduce((s, [k, wt]) => s + wt * vals[k][0], 0);
    assert.ok(Math.abs(w - CC.cameraCurveAt(ks, f).position[0]) < 1e-9, `frame ${f}`);
  }
});

test("report: peak screen speed of a fixed grid through the camera, old curve vs new (logged; the new one has no spike at keys)", () => {
  const grid = [];
  for (let x = -6; x <= 14; x += 4) for (let z = 0; z <= 8; z += 4) grid.push(new THREE.Vector3(x, 0.5, z));
  const peak = (shot) => {
    const st = headless(scene(shot));
    const px = (f) => { const c = st._cameraAt(f), cam = new THREE.PerspectiveCamera(2 * Math.atan(12 / c.focal_mm) * 180 / Math.PI, 16 / 9, 0.1, 500);
      cam.position.set(...c.position); cam.lookAt(new THREE.Vector3(...c.target)); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
      return grid.map((p) => p.clone().project(cam)).map((v) => [v.x * 960, v.y * 540]); };
    let prev = px(0), top = 0, jumps = 0, last = 0;
    for (let f = 1; f <= 96; f++) {
      const cur = px(f), s = Math.max(...cur.map((q, i) => Math.hypot(q[0] - prev[i][0], q[1] - prev[i][1])));
      top = Math.max(top, s); if (f > 1) jumps = Math.max(jumps, Math.abs(s - last)); last = s; prev = cur;
    }
    return { peak: +top.toFixed(1), worstChange: +jumps.toFixed(2) };
  };
  const before = peak({}), after = peak({ cam_curve: 2 });
  console.log(`  screen speed (px/frame at 1920x1080): old curve peak ${before.peak}, frame-to-frame change ${before.worstChange}; new curve peak ${after.peak}, change ${after.worstChange}`);
  assert.ok(after.worstChange < before.worstChange, "the biggest frame-to-frame change in screen speed is smaller on the new curve");
});
