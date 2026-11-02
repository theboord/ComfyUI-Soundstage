// node --test tests/js/coach.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import * as R from "../../web/coach/rules.mjs";
import { CoachEngine } from "../../web/coach/coach.mjs";
import { applyOpsToScene, inverseOf } from "../../web/agent/agent.mjs";

const key = (frame, position, target, focal_mm = 35) => ({ frame, position, target, focal_mm });
const actor = (id, kind, keys, extra = {}) => ({ id, name: id, kind, position: keys[0].position, keys, rotation_deg: 0, ...extra });
const still = (x, z) => [{ frame: 0, position: [x, 0, z] }];

/** Two people facing each other across X, cameras on the -Z side (the agent's default layout). */
function duo(extra = {}) {
  return {
    shot: { frames: 97, fps: 24 }, environment: { set: "plaza" },
    actors: [actor("Ann", "woman", still(-1, 0)), actor("Bob", "man", still(1, 0))],
    shots: [
      { id: "w", name: "Wide", setup: "wide", camera_keys: [key(0, [0, 1.5, -8], [0, 1.2, 0], 28)] },
      { id: "a", name: "Single on Ann", setup: "single_a", camera_keys: [key(0, [0.5, 1.6, -2], [-1, 1.5, 0], 65)] },
      { id: "b", name: "Single on Bob", setup: "single_b", camera_keys: [key(0, [-0.5, 1.6, -2], [1, 1.5, 0], 65)] },
    ],
    active_shot: "w",
    ...extra,
  };
}
const ctxOf = (scene, more = {}) => ({ scene, aspect: 960 / 512, step: 1, motionFreedom: 0, lookPicked: true,
  sceneHash: R.sceneHash(scene), finalHash: null, editedSinceRun: false, ...more });
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

/** Apply a rule's fix, check it cleared the problem, and that the ops undo exactly. */
function applyFix(scene, item) {
  const ops = item.actions.find((a) => a.kind === "ops").payload;
  const after = applyOpsToScene(scene, ops);
  // applyOps also refreshes the derived flat camera fields; refresh the original the same way before comparing.
  assert.equal(canon(applyOpsToScene(after, inverseOf(ops))), canon(applyOpsToScene(scene, [{ op: "noop" }])), "fix undoes exactly");
  return after;
}

// ------------------------------------------------------------------ rules

test("a clean two-hander raises nothing", () => {
  const ctx = ctxOf(duo(), { cut: { cut: [{ shot_id: "w", in: 0, out: 96 }, { shot_id: "a", in: 0, out: 96 }, { shot_id: "b", in: 0, out: 96 }] } });
  for (const ev of ["stage", "shots", "run"]) assert.deepEqual(R.advise(ev, ctx).map((x) => x.rule), [], ev);
});

test("story order: Advisor numbers out of order -> Reorder restores them", () => {
  const s = duo();
  s.shots.forEach((sh, i) => (sh.advisor = { shot: i + 1 }));
  const ctx = ctxOf(s, { cut: { cut: [{ shot_id: "w" }, { shot_id: "b" }, { shot_id: "a" }] } });
  const [item] = R.storyOrder(ctx);
  assert.equal(item.rule, "story_order");
  assert.deepEqual(item.actions[0].payload.order, ["w", "a", "b"]);
});

test("story order: a close-up first with a wide later -> move the wide first", () => {
  const ctx = ctxOf(duo(), { cut: { cut: [{ shot_id: "a" }, { shot_id: "w" }, { shot_id: "b" }] } });
  const [item] = R.storyOrder(ctx);
  assert.deepEqual(item.actions[0].payload.order, ["w", "a", "b"]);
});

test("camera inside the room wall / under the floor / inside an object -> moved out, framing kept", () => {
  const s = duo({ environment: { set: "interior" } });
  s.shots[0].camera_keys = [key(0, [0, 1.5, 6], [0, 1.2, 0], 28)];          // behind the back wall (z 4.75)
  s.shots[1].camera_keys = [key(0, [0.5, -0.3, -2], [-1, 1.5, 0], 65)];     // under the floor
  s.actors.push(actor("Car", "car", still(3, -2)));
  s.shots[2].camera_keys = [key(0, [3, 1.0, -2], [1, 1.5, 0], 65)];         // inside the car
  const items = R.cameraClipping(ctxOf(s));
  assert.equal(items.length, 3);
  assert.match(items[0].text, /outside the room walls/);
  assert.match(items[1].text, /below the floor/);
  assert.match(items[2].text, /inside Car/);
  let fixed = s;
  for (const it of items) fixed = applyFix(fixed, it);
  assert.deepEqual(R.cameraClipping(ctxOf(fixed)), []);
  assert.ok(fixed.shots[0].camera_keys[0].focal_mm < 28, "pulled closer -> wider lens keeps the framing");
});

test("someone walks out of a single before the cut ends -> trim", () => {
  const s = duo();
  s.actors[0].keys = [{ frame: 0, position: [-1, 0, 0] }, { frame: 40, position: [-12, 0, 0] }];
  const ctx = ctxOf(s, { cut: { cut: [{ shot_id: "a", in: 0, out: 96 }] } });
  const [item] = R.framing(ctx).filter((x) => x.rule === "leaves_frame");
  assert.ok(item, "fires");
  const { shot_id, out } = item.actions[0].payload;
  assert.equal(shot_id, "a");
  assert.ok(out > 10 && out < 60);
});

test("a single where the subject is a speck -> push in", () => {
  const s = duo();
  s.shots[1].camera_keys = [key(0, [0, 1.6, -40], [-1, 1.5, 0], 24)];
  const item = R.framing(ctxOf(s)).find((x) => x.rule === "tiny_subject");
  assert.ok(item);
  const after = applyFix(s, item);
  assert.ok(after.shots[1].camera_keys[0].focal_mm > 40);
  assert.equal(R.framing(ctxOf(s, { cut: { cut: [{ shot_id: "w" }] } })).filter((x) => x.rule === "tiny_subject").length, 0,
    "shots not in the cut are not judged");
});

test("180-degree crossing between consecutive shots -> mirror fixes it", () => {
  const s = duo();
  s.shots[2].camera_keys = [key(0, [-0.5, 1.6, 2], [1, 1.5, 0], 65)];       // Bob's single from the +Z side
  const ctx = ctxOf(s, { cut: { cut: [{ shot_id: "a" }, { shot_id: "b" }] } });
  const [item] = R.lineCrossing(ctx);
  assert.equal(item.rule, "line_crossing");
  const after = applyFix(s, item);
  assert.deepEqual(R.lineCrossing(ctxOf(after, { cut: ctx.cut })), []);
  assert.ok(after.shots[2].camera_keys[0].position[2] < 0);
});

test("too fast: a 30 m/s man and a 40 m/s horse -> slowed to a believable speed", () => {
  const s = duo();
  s.actors[1].keys = [{ frame: 0, position: [1, 0, 0] }, { frame: 24, position: [31, 0, 0] }];
  s.actors.push(actor("Horse", "horse", [{ frame: 0, position: [0, 0, 5] }, { frame: 96, position: [0, 0, 165] }]));
  const items = R.tooFast(ctxOf(s));
  assert.deepEqual(items.map((x) => x.rule), ["too_fast", "too_fast"]);
  let fixed = s;
  for (const it of items) fixed = applyFix(fixed, it);
  assert.deepEqual(R.tooFast(ctxOf(fixed)), []);
  assert.equal(fixed.actors[1].keys[0].frame, 0);
  // Mounted riders are judged through their mount only.
  const ridden = duo();
  ridden.actors[0].mount_id = "x";
  ridden.actors[0].keys = [{ frame: 0, position: [0, 0, 0] }, { frame: 1, position: [50, 0, 0] }];
  assert.deepEqual(R.tooFast(ctxOf(ridden)), []);
});

test("stale render / high step / motion freedom / no look / empty scene", () => {
  const s = duo();
  assert.equal(R.staleRender(ctxOf(s, { step: 4, finalHash: "old" }))[0].actions[0].payload.step, 1);
  assert.deepEqual(R.staleRender(ctxOf(s, { step: 4, finalHash: R.sceneHash(s) })), []);
  assert.equal(R.staleRender(ctxOf(s, { step: 3, editedSinceRun: true }))[0].rule, "step_high");
  assert.equal(R.motionFreedom(ctxOf(s, { motionFreedom: 0.9 }))[0].actions[0].payload.value, 0.5);
  assert.deepEqual(R.motionFreedom(ctxOf(s, { motionFreedom: 0.4 })), [], "the normal range is quiet");
  assert.deepEqual(R.motionFreedom(ctxOf(s)), []);
  assert.equal(R.noLook(ctxOf(s, { lookPicked: false }))[0].actions[0].payload.tab, "look");
  assert.deepEqual(R.noLook(ctxOf(s, { lookPicked: null })), [], "unknown look state stays quiet");
  const empty = { ...duo(), actors: [] };
  assert.deepEqual(R.emptyScene(ctxOf(empty))[0].actions.map((a) => a.kind), ["describe", "open_tab"]);
});

test("the tour walks 4 steps then stops", () => {
  for (let i = 0; i < R.TOUR.length; i++) {
    const [t] = R.tour({ tourStep: i });
    assert.equal(t.actions[0].kind, i < R.TOUR.length - 1 ? "tour_next" : "tour_done");
  }
  assert.deepEqual(R.tour({ tourStep: R.TOUR.length }), []);
});

test("errors outrank warnings outrank tips; a broken rule never throws", () => {
  const s = duo({ environment: { set: "interior" } });
  s.shots[0].camera_keys = [key(0, [0, 1.5, 6], [0, 1.2, 0], 28)];
  const items = R.advise("run", ctxOf(s, { lookPicked: false, motionFreedom: 0.9 }));
  const rank = items.map((x) => R.LEVEL_RANK[x.level]);
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
  assert.equal(items[0].level, "error");
  assert.equal(items.at(-1).level, "tip");
  assert.doesNotThrow(() => R.advise("run", { scene: { shots: [{ id: "x" }], actors: [{ kind: "man" }] } }));
});

test("sceneHash ignores the per-frame camera track and the active shot", () => {
  const s = duo();
  assert.equal(R.sceneHash(s), R.sceneHash({ ...s, active_shot: "a", camera_track: [1, 2, 3] }));
  assert.notEqual(R.sceneHash(s), R.sceneHash({ ...s, environment: { set: "forest" } }));
});

// ------------------------------------------------------------------ engine

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test("engine: at most two cards; Not now snoozes until the scene changes; Don't show again persists", () => {
  const st = memStorage();
  const eng = new CoachEngine(st);
  eng.tourDone();
  const s = duo({ environment: { set: "interior" } });
  s.shots[0].camera_keys = [key(0, [0, 1.5, 6], [0, 1.2, 0], 28)];
  s.shots[1].camera_keys = [key(0, [0.5, -0.3, -2], [-1, 1.5, 0], 65)];
  const ctx = ctxOf(s, { motionFreedom: 0.9 });
  const shown = eng.pick("run", ctx);
  assert.equal(shown.length, 2);
  eng.snooze(shown[0].key, ctx.sceneHash);
  assert.ok(!eng.pick("run", ctx).some((x) => x.key === shown[0].key), "snoozed");
  const changed = ctxOf({ ...s, environment: { set: "interior", weather: "rain" } }, { motionFreedom: 0.9 });
  assert.ok(eng.pick("run", changed).some((x) => x.key === shown[0].key), "back after an edit");
  eng.mute("camera_clip");
  assert.ok(!eng.pick("run", ctx).some((x) => x.rule === "camera_clip"));
  const again = new CoachEngine(st);
  assert.ok(again.muted.has("camera_clip"), "persisted");
  again.setEnabled(false);
  assert.deepEqual(again.pick("run", ctx), []);
  assert.equal(new CoachEngine(st).enabled, false);
});

test("engine survives storage that throws (private mode)", () => {
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const eng = new CoachEngine(bad);
  assert.equal(eng.enabled, true);
  assert.doesNotThrow(() => { eng.mute("x"); eng.tourNext(); eng.setEnabled(false); });
  assert.doesNotThrow(() => new CoachEngine(undefined));
});

test("first open shows the tour, then the empty-scene card", () => {
  const eng = new CoachEngine(memStorage());
  const empty = { ...duo(), actors: [] };
  const first = eng.pick("open", ctxOf(empty));
  assert.equal(first[0].rule, "tour");
  assert.equal(first[1].rule, "empty_scene");
});

test("interpolation matches the stage (Catmull-Rom, eased ends)", async () => {
  const { Stage } = await import("../../web/stage/stage.mjs");
  const keys = [key(0, [0, 1, 0], [0, 1, 5]), key(40, [3, 1.5, 2], [1, 1, 6]), key(96, [6, 2, -1], [2, 1, 9])];
  for (const f of [0, 13, 40, 71, 96]) {
    assert.deepEqual(R.sample(keys, f, "position").map((x) => x.toFixed(6)), Stage._sample(keys, f, "position").map((x) => x.toFixed(6)));
  }
});

// ------------------------------------------------------------------ the camera the shot really films (rigs)

test("cameraTrack: the Coach judges the stage's own shot camera (keys through the rig), frame for frame", async () => {
  const THREE = await import("../../web/vendor/three.module.min.mjs");
  const { Stage } = await import("../../web/stage/stage.mjs");
  const s = duo();
  s.shots[0].camera_keys = [key(0, [-4, 1.6, -8], [0, 1.2, 0], 28), key(48, [0, 2.2, -7], [0, 1.2, 0], 32), key(96, [4, 1.6, -8], [0, 1.2, 0], 28)];
  const st = Object.create(Stage.prototype);
  Object.assign(st, { state: structuredClone(s), view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(),
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onSelect() {}, onInteract() {}, _buildLights() {}, onChange() {} });
  st.state.active_shot = "w";
  for (const rig of ["jib", "handheld", "aerial", "dolly", "tripod"]) {
    st.setRig(rig);
    const live = st.cameraTrack(), mine = R.cameraTrack(ctxOf(st.toJSON()), st.toJSON().shots[0]);
    assert.equal(mine.length, live.length);
    for (let f = 0; f < live.length; f++) {
      for (const fld of ["position", "target"]) assert.ok(live[f][fld].every((v, i) => Math.abs(v - mine[f][fld][i]) < 1e-9), `${rig} f${f} ${fld}`);
      assert.ok(Math.abs(live[f].focal_mm - mine[f].focal_mm) < 1e-9);
    }
  }
  // A caller with the live stage can hand its tracks in.
  const given = { w: [{ position: [0, 9, 0], target: [0, 0, 1], focal_mm: 35 }] };
  assert.equal(R.cameraTrack(ctxOf(s, { cameraTracks: given }), s.shots[0]), given.w);
});

test("rig limits: a tripod asked to travel, a slider longer than any rail, a dolly faster than grips can push", () => {
  const s = duo();
  s.shots[0].camera_keys = [key(0, [-2, 1.6, -8], [0, 1.2, 0], 28), key(96, [2, 1.6, -8], [0, 1.2, 0], 28)];   // 4 m in 4 s
  s.shots[0].rig = { type: "tripod", amount: 1, seed: 3 };
  let [item] = R.rigLimits(ctxOf(s));
  assert.equal(item?.rule, "rig_limits");
  assert.match(item.text, /tripod has to travel 4\.0 m/);
  assert.match(item.actions[0].label, /dolly/);
  let fixed = applyFix(s, item);
  assert.equal(fixed.shots[0].rig.type, "dolly");
  assert.equal(fixed.shots[0].rig.seed, 3, "the fix keeps the rest of the rig");
  assert.deepEqual(R.rigLimits(ctxOf(fixed)), []);
  // A slider can run 1.5 m at most.
  s.shots[0].rig = { type: "slider", amount: 1 };
  [item] = R.rigLimits(ctxOf(s));
  assert.match(item.text, /slider has to travel/);
  // 12 m across in 4 s on a dolly (4.7 m/s at its peak): grips can't push that fast; an operator on foot can.
  const fast = duo();
  fast.shots[0].camera_keys = [key(0, [-6, 2, -10], [0, 1.2, 0], 28), key(96, [6, 2, -10], [0, 1.2, 0], 28)];
  fast.shots[0].rig = { type: "dolly", amount: 1 };
  [item] = R.rigLimits(ctxOf(fast));
  assert.match(item.text, /dolly has to move at \d+\.\d m\/s, but grips push a dolly at a brisk walk/);
  assert.match(item.actions[0].label, /^Use an? (handheld operator|Steadicam|aerial gimbal)$/);
  fixed = applyFix(fast, item);
  assert.deepEqual(R.rigLimits(ctxOf(fixed)), []);
  // A quick 3 m dolly move in 1.25 s (over a g of acceleration): or take it slower, the keys stretched over more of the shot.
  const quick = duo();
  quick.shots[0].camera_keys = [key(0, [-1.5, 1.6, -8], [0, 1.2, 0], 28), key(30, [1.5, 1.6, -8], [0, 1.2, 0], 28)];
  quick.shots[0].rig = { type: "dolly", amount: 1 };
  [item] = R.rigLimits(ctxOf(quick));
  const slow = item.actions.find((a) => a.label === "Take it slower");
  assert.ok(slow, "the shot has room to take longer");
  const slowed = applyFix(quick, { actions: [slow] });
  assert.ok(slowed.shots[0].camera_keys[1].frame > 30 && slowed.shots[0].camera_keys[1].frame <= 96);
  assert.deepEqual(R.rigLimits(ctxOf(slowed)), [], "slower is within what grips can do");
  // Free cameras and rigs at amount 0 are the keys as set: never judged.
  fast.shots[0].rig = { type: "dolly", amount: 0 };
  assert.deepEqual(R.rigLimits(ctxOf(fast)), []);
  fast.shots[0].rig = { type: "free" };
  assert.deepEqual(R.rigLimits(ctxOf(fast)), []);
  assert.ok(R.RULES.stage.includes(R.rigLimits) && R.RULES.run.includes(R.rigLimits));
});

test("camera clipping judges the rig: keys clear but the rig takes it through the floor -> back to the keys as set", () => {
  const s = duo();
  s.shots[0].rig = { type: "jib", amount: 1 };
  const track = Array.from({ length: 97 }, (_, f) => ({ position: [0, f === 40 ? 0.02 : 1.5, -8], target: [0, 1.2, 0], focal_mm: 28 }));
  const [item] = R.cameraClipping(ctxOf(s, { cameraTracks: { w: track } }));
  assert.match(item.text, /below the floor at 1\.7 s \(the keys are clear: the jib takes it there\)/);
  const fixed = applyFix(s, item);
  assert.equal(fixed.shots[0].rig.type, "free");
  assert.deepEqual(R.cameraClipping(ctxOf(fixed)), []);
});

test("ride-along shots: a camera in its own car is not 'inside' it, and the judging happens in the world", () => {
  const s = duo();
  s.actors.push(actor("Car", "car", [{ frame: 0, position: [-25, 0, -20] }, { frame: 96, position: [25, 0, -20] }], { rotation_deg: 90 }));
  // A dashboard two-shot in the car's own space: inside the car's footprint on purpose.
  s.shots.push({ id: "dash", name: "Dashboard", setup: "two_shot", camera_follow: "Car", rig: { type: "handheld", amount: 1 },
    camera_keys: [key(0, [0.3, 1.1, 0.9], [0, 1.0, -0.5], 24)] });
  assert.deepEqual(R.cameraClipping(ctxOf(s)).map((x) => x.key), []);
  const tr = R.cameraTrack(ctxOf(s), s.shots[3]);
  assert.ok(Math.abs(tr[96].position[0] - (25 + 0.9)) < 0.05 && Math.abs(tr[96].position[2] - (-20 - 0.3)) < 0.05, "the camera rides 50 m across the plaza with the car");
  assert.deepEqual(R.rigLimits(ctxOf(s)), [], "an operator sitting in the car is not 'running at 15 m/s'");
});

test("coach sample mirrors the stage's holds (two keys at the same spot stay still)", async () => {
  const { Stage } = await import("../../web/stage/stage.mjs");
  const keys = [{ frame: 0, position: [0, 0, 0] }, { frame: 30, position: [4, 0, 0] }, { frame: 60, position: [4, 0, 0] }, { frame: 96, position: [0, 0, 6] }];
  for (const f of [35, 45, 55]) assert.deepEqual(R.sample(keys, f, "position", false), Stage._sample(keys, f, "position", false));
});
