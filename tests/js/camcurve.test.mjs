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
import { takeToKeys } from "../../web/vcam/vfcore.mjs";
import { smoothAgentShots } from "../../web/hosthooks.mjs";
import { readFileSync } from "node:fs";

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
    assert.equal(st._cameraAt(k.frame).focal_mm, k.focal_mm, `focal at key ${k.frame}: exactly the key's own value`);
    assert.deepEqual(CC.cameraCurveAt(st.activeShot().camera_keys, k.frame).position, k.position, `position at key ${k.frame}: exact`);
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
  // setCameraKeys with this shot's own keys again (a copy) keeps the old curve
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
      {
        const c = stageCameraAt(shot.camera_keys, f, 2, shot.cam_speed);
        assert.ok(a.position.every((v, i) => Math.abs(v - c.position[i]) < 1e-12), `stabilize f${f} ${shot.cam_speed || ""}`);
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

test("setCameraKeys: a new move goes onto the smooth curve; a copy of an old-curve shot stays on the old one; explicit curve / camSpeed", () => {
  const st = headless(scene());
  assert.equal(st.cameraCurve(), "legacy");
  const src = structuredClone(st.activeShot().camera_keys);
  // a preset / Advisor / take: new keys -> smooth
  const move = keysC3().map((k) => ({ ...k, position: [k.position[0] + 1, k.position[1], k.position[2]] }));
  assert.equal(st.setCameraKeys(move).curve, 2);
  assert.equal(st.cameraCurve(), "smooth");
  // the Cut's "copy of the current camera": a new setup handed an old-curve shot's keys keeps the old curve
  const st2 = headless(scene());
  st2.addShot("single");
  assert.equal(st2.setCameraKeys(structuredClone(src)).curve, 1);
  assert.equal(st2.cameraCurve(), "legacy", "the copy moves exactly like its source");
  for (const f of [0, 7, 30, 55, 96]) assert.deepEqual(st2._cameraAt(f).position, Stage._sample(src, f, "position"));
  // explicit: a Discard puts the old curve back with the old keys
  assert.equal(st.setCameraKeys(src, { curve: 1 }).curve, 1);
  assert.equal(st.cameraCurve(), "legacy");
  // camSpeed: a take turns even speed off (null); "even" turns it on; left out it is kept
  st.setCameraCurve("even");
  st.setCameraKeys(move);
  assert.equal(st.cameraCurve(), "even", "a preset move keeps the shot's even speed");
  assert.equal(st.setCameraKeys(move, { camSpeed: null }).cam_speed, null);
  assert.equal(st.cameraCurve(), "smooth");
  st.setCameraKeys(move, { camSpeed: "even" });
  assert.equal(st.cameraCurve(), "even");
  assert.equal(st.setCameraKeys([]).ok, false);
});

test("stageCameraAt plays even speed like the stage; a phone take on an even-speed shot keeps its own timing", () => {
  // parity: the key fitter's copy of the stage camera on an even-speed shot
  const st = headless(scene({ cam_curve: 2, cam_speed: "even" }));
  const keys = st.activeShot().camera_keys;
  for (const f of [0, 3, 12, 30, 48, 61, 90, 96]) {
    const a = st._cameraAt(f), b = stageCameraAt(keys, f, 2, "even");
    assert.ok(a.position.every((v, i) => Math.abs(v - b.position[i]) < 1e-12), `even f${f}`);
    assert.ok(Math.abs(a.focal_mm - b.focal_mm) < 1e-12);
  }
  // a viewfinder take with its own timing: slow first half (1 m), fast second half (5 m)
  const samples = [];
  for (let i = 0; i <= 240; i++) {
    const t = i / 60, z = t < 2 ? 0.5 * t : 1 + 2.5 * (t - 2);
    samples.push({ t, position: [0, 1.6, 6 - z], quaternion: [0, 0, 0, 1], focal_mm: 35 });
  }
  const take = { samples, settings: { space: "set", startFrame: 0, fps: 24, lastFrame: 96, stabilize: false, horizonLock: true } };
  const { keys: tk, frames } = takeToKeys(take, { curve: CC.CAM_CURVE });
  const worst = (speed) => Math.max(...frames.map((fr) => len(sub(stageCameraAt(tk, fr.frame, 2, speed).position, fr.position))));
  // what the App now does: the take goes on timed (even speed off)
  const r = st.setCameraKeys(tk, { curve: CC.CAM_CURVE, camSpeed: null });
  assert.equal(r.cam_speed, null);
  assert.equal(st.cameraCurve(), "smooth");
  const onStage = Math.max(...frames.map((fr) => len(sub(st._cameraAt(fr.frame).position, fr.position))));
  // within the fitter's own along-path slip (a third of a frame's travel: 10 cm a frame in the fast half)
  assert.ok(onStage < 0.05, `the stage plays the take on time: worst ${onStage.toFixed(4)} m`);
  assert.ok(Math.abs(onStage - worst(null)) < 1e-9, "the stage and stageCameraAt agree");
  assert.ok(worst("even") > 0.5, `left on even speed the take would be re-timed: worst ${worst("even").toFixed(3)} m off`);
  // the App's take paths ask for exactly that (desktop take, phone viewfinder on the desktop and on the phone)
  const src = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), "utf8");
  assert.match(src("soundstage.js"), /stage\.setCameraKeys\(res\.keys, \{ curve: CAM_CURVE, camSpeed: null \}\)/);
  assert.match(src("vcam/desk.mjs"), /takeToKeys\(take, \{ curve: CAM_CURVE \}\)[\s\S]*stage\.setCameraKeys\(keys, \{ curve: CAM_CURVE, camSpeed: null \}\)/);
  assert.match(src("vcam/desk.mjs"), /setCameraKeys\(applied\.prev\.keys, \{ curve: applied\.prev\.curve \?\? 1, camSpeed: applied\.prev\.speed \?\? null \}\)/, "Discard restores curve and speed");
  assert.match(src("vcam/viewfinder.mjs"), /sh\.cam_curve = 2; delete sh\.cam_speed;/);
});

test("the scene agent's new shots play the smooth curve; shots already on the stage keep theirs (smoothAgentShots on a real stage)", async () => {
  const st = headless(scene());
  const old = st.activeShot().id;
  const built = { ...scene(), shots: [{ id: "a1", name: "Wide", setup: "wide", camera_keys: keysC3() }, { id: "a2", name: "Single", setup: "single", camera_keys: keysC3() }], active_shot: "a1" };
  const agent = {
    async describe() { const res = { scene: structuredClone(built) }; st.state = structuredClone(res.scene); return res; },
    async edit() {
      const op = { op: "add_shot", shot: { id: "a3", name: "Insert", setup: "insert", camera_keys: keysC3() } };
      st.state.shots.push(structuredClone(op.shot));
      return { ops: [op] };
    },
  };
  smoothAgentShots(agent, st);
  // an edit on an old scene: the shot it adds is smooth, the old shot is untouched
  const r0 = await agent.edit("add an insert");
  assert.equal(st.state.shots.find((x) => x.id === old).cam_curve, undefined, "the saved shot keeps the old curve");
  assert.equal(st.state.shots.find((x) => x.id === "a3").cam_curve, 2);
  assert.equal(r0.ops[0].shot.cam_curve, 2, "the redo copy too");
  // a build: every shot in it is new
  const res = await agent.describe("two people at a cafe");
  assert.deepEqual(st.state.shots.map((x) => x.cam_curve), [2, 2]);
  assert.deepEqual(res.scene.shots.map((x) => x.cam_curve), [2, 2], "the agent's redo scene too");
  assert.equal(smoothAgentShots(agent, st), agent, "wrapping twice is a no-op");
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

test("an old shot keyed, orbited or zoomed at the playhead keeps what was on screen (the key reads the old curve, then the shot switches)", () => {
  // C3's keys at frame 30 (between keys 12 and 48): shown z -7.325 / focal 38.50 on the old curve; writing the new
  // curve's value instead put z -7.475 / focal 37.95 in the key, a jump as the key went in.
  // (a drag writes positions to the millimetre, so it is held to 1 mm; the rest are exact)
  const near = (a, b, msg, tol = 1e-6) => assert.ok(len(sub(a.position, b.position)) < tol && len(sub(a.target, b.target)) < tol && Math.abs(a.focal_mm - b.focal_mm) < 1e-6,
    `${msg}: shown ${JSON.stringify(b)} became ${JSON.stringify(a)}`);
  const cases = {
    "set key here": (st) => st.setKeyHere(),
    "first orbit drag (what the drag edits)": (st) => { st._activeOrbit(); },
    "orbit drag by zero pixels": (st) => st._navDrag("orbit", false, 0, 0),
    "wheel zoom / focal edit (the lens key)": (st) => { const k = st._editCamera(); k.focal_mm = +k.focal_mm; },
  };
  for (const [name, act] of Object.entries(cases)) {
    const { st } = camSampler({});
    assert.equal(st.activeShot().cam_curve, undefined, "an old shot");
    st.frame = 30; st.setFrame(30);
    const shown = structuredClone(st._cameraAt(30));
    // the old and the new curve really differ here (so this test can see the jump)
    assert.ok(len(sub(CC.cameraCurveAt(keysC3(), 30).position, shown.position)) > 0.05);
    act(st);
    assert.equal(st.activeShot().cam_curve, CC.CAM_CURVE, `${name}: re-keyed, now on the smooth curve`);
    const k = st.activeShot().camera_keys.find((x) => x.frame === 30);
    assert.ok(k, `${name}: a key at the playhead`);
    const tol = name.includes("zero pixels") ? 1e-3 : 1e-6;
    near(k, shown, `${name}: the key`, tol);
    near(st._cameraAt(30), shown, `${name}: the camera at the playhead`, tol);
  }
  // a key already at the playhead is the same on both curves: editing it changes nothing either
  const { st } = camSampler({});
  st.frame = 48; st.setFrame(48);
  const shown = structuredClone(st._cameraAt(48));
  st.setKeyHere();
  near(st._cameraAt(48), shown, "an existing key");
});

test("even speed on a mixed dolly and pan: the combined camera + target measure is within 1.05 mid-shot, and so is the pan", () => {
  // the reviewer's probe: a big pan with a small, unevenly timed dolly (1 cm in the first 20 frames, 49 cm in the next 70)
  const dp = [{ frame: 0, position: [0, 0, 0], target: [-5, 0, 5], focal_mm: 35 }, { frame: 20, position: [0.01, 0, 0], target: [0, 0, 5], focal_mm: 35 },
    { frame: 90, position: [0.5, 0, 0], target: [5, 0, 5], focal_mm: 35 }];
  const at = (f) => CC.cameraCurveAt(dp, f, { even: true, arcLengthDivisions: 8192 });
  const lo = Math.ceil(90 * CC.EVEN_RAMP) + 1, hi = Math.floor(90 * (1 - CC.EVEN_RAMP)) - 1;
  const comb = [], pan = [];
  for (let f = lo; f < hi; f++) {
    const a = at(f), b = at(f + 1);
    const dpos = len(sub(b.position, a.position)), dt = len(sub(b.target, a.target));
    comb.push(Math.hypot(dpos, dt)); pan.push(dt);
  }
  const r = (xs) => Math.max(...xs) / Math.min(...xs);
  assert.ok(r(comb) <= 1.05, `combined max/min ${r(comb).toFixed(4)}`);
  assert.ok(r(pan) <= 1.05, `target (pan) max/min ${r(pan).toFixed(4)} (was 4.8 timed by position alone)`);
  // a dolly and a pan both large and differently timed: the combination is even (each alone may not be)
  const both = [{ frame: 0, position: [0, 1.6, -6], target: [-3, 1, 0], focal_mm: 35 }, { frame: 30, position: [3, 1.6, -6], target: [-2, 1, 0], focal_mm: 35 },
    { frame: 90, position: [4, 1.6, -6], target: [4, 1, 0], focal_mm: 35 }];
  const B = (f) => CC.cameraCurveAt(both, f, { even: true, arcLengthDivisions: 8192 });
  const cb = []; for (let f = lo; f < hi; f++) { const a = B(f), b = B(f + 1); cb.push(Math.hypot(len(sub(b.position, a.position)), len(sub(b.target, a.target)))); }
  assert.ok(r(cb) <= 1.05, `large dolly + pan, combined max/min ${r(cb).toFixed(4)}`);
  // still exact at both ends and pure: the same frame however it is reached
  assert.ok(len(sub(at(0).position, dp[0].position)) < 1e-9 && len(sub(at(90).target, dp[2].target)) < 1e-9);
  const seq = []; for (let f = 0; f <= 90; f++) seq.push(JSON.stringify(at(f)));
  for (const f of [77, 3, 45, 90, 0, 12, 61]) assert.equal(JSON.stringify(at(f)), seq[f]);
});
