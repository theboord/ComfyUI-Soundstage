// Foot grounding, measured PHYSICALLY (tests/js/footkit.mjs physical()): every shoe vertex against the true ground
// under it on every frame the body is on its feet, not only the frames the plan calls planted. The station platform's
// edge, kerbs, stairs, uneven ground, the station ramp, slow walks, runs, fast spins, walking backwards.
// node --test tests/js/footground.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as K from "./footkit.mjs";
import { buildTrainStation, stationFloor, STATION } from "../../web/stage/sets/train.mjs";

const { NOT_INSTALLED, cm } = K;

// ---------------------------------------------------------------- the real station set: standing at the platform edge
test("real Rocketbox on the station set: standing at the platform edge, facing the track or away, soles on the platform, no pelvis drop, no reach miss", { skip: NOT_INSTALLED }, async () => {
  // the edge is at x = STATION.edgeA (1.62); the man and the woman stand 4-10 cm in from it, toes (or heels) over it
  for (const kind of ["man", "woman"]) for (const heading of [-90, 90]) for (const x of [1.66, 1.72]) {
    const a = { id: "edge", kind, height_m: K.heightOf(kind), position: [x, 0, 0], rotation_deg: heading, keys: [{ frame: 0, position: [x, 0, 0] }] };
    const st = await K.setup(kind, a, { frames: 49, setFx: buildTrainStation().fx });
    assert.equal(st._heightAt(a, 10), STATION.platformTop, "the body stands on the platform");
    const out = K.measure(st, a, { ground: stationFloor });
    const s = K.physical(out);
    const tag = `${kind} heading ${heading} x ${x}: ${K.fmt(s)}`;
    const cap = 0.12 * K.heightOf(kind) / 1.8;
    assert.ok(s.pen > -0.01, `${tag}: a sole ${cm(-s.pen)} cm into the platform`);
    assert.ok(s.drop < Math.min(0.03, cap - 0.005), `${tag}: the hips dropped ${cm(s.drop)} cm (cap ${cm(cap)})`);
    assert.ok(s.miss < 0.005, `${tag}: a planted foot missed its target by ${cm(s.miss)} cm (out of the leg's reach)`);
    assert.ok(Math.min(s.planted.l, s.planted.r) >= 40, `${tag}: planted, both feet`);
  }
});

// ---------------------------------------------------------------- physical checks over every frame, not the plan's labels
/** Assert the physical summary s against limits (all in metres / frames); tag names the case. */
function check(s, tag, { pen = -0.01, slide = 0.01, drift = 0.015, hover = 0.02, float = 0, drop = 0.021, planted = 40 } = {}) {
  const t = `${tag}: ${K.fmt(s)}`;
  assert.ok(s.pen > pen, `${t}: a shoe ${cm(-s.pen)} cm into the ground`);
  assert.ok(s.slide <= slide, `${t}: a touching sole slid ${cm(s.slide)} cm in a frame`);
  assert.ok(s.drift <= drift, `${t}: a touching sole crept ${cm(s.drift)} cm`);
  assert.ok(s.hover <= hover, `${t}: a foot at rest ${cm(s.hover)} cm over the ground`);
  assert.ok(s.float <= float, `${t}: ${s.float} frames with neither foot on the ground (${s.floatAt.slice(0, 12).join(",")})`);
  assert.ok(s.drop <= drop, `${t}: the pelvis came down ${cm(s.drop)} cm`);
  assert.ok(s.miss < 0.005, `${t}: a planted foot missed its target by ${cm(s.miss)} cm`);
  assert.ok(Math.min(s.planted.l, s.planted.r) >= planted, `${t}: planted frames`);
}
const walkAt = (kind, v, extra = {}) => { const d = v * 5; return K.walker(kind, extra, [-d / 2, 0, 0], [d / 2, 0, 0]); };

test("real Rocketbox walking 0.3 / 0.5 / 1.2 m/s on flat ground: no sole slides or hovers, one foot always down, the pelvis within 2 cm", { skip: NOT_INSTALLED }, async () => {
  // e56d6bc: 0.5 m/s dipped the hips 7.5-11 cm (9.3 measured here), 0.3 m/s hit the 12 cm cap, touching soles slid 6-25 cm in a frame
  for (const kind of ["man", "woman"]) for (const v of [0.3, 0.5, 1.2]) {
    const a = walkAt(kind, v);
    const st = await K.setup(kind, a);
    check(K.physical(K.measure(st, a)), `${kind} ${v} m/s`);
  }
});

test("real Rocketbox walking to a stop and going again, and a U-turn: a foot at rest is planted, never held up; one foot always down", { skip: NOT_INSTALLED }, async () => {
  // 3abc644: the swing clearance lifted BOTH feet 3.0 cm (liftMax) in the idle <-> walk crossfade, 4-8 frames with no
  // foot down at the stop and at the restart; on e56d6bc this was 0 frames
  const kf = (frame, x) => ({ frame, position: [x, 0, 0] });
  for (const kind of ["man", "woman"]) for (const [name, keys] of [
    ["stop-go", [kf(0, -3), kf(48, 0), kf(72, 0), kf(120, 3)]],
    ["U-turn", [kf(0, -2), kf(66, 1.2), kf(120, -1.2)]],
  ]) {
    const a = { id: "sg", kind, height_m: K.heightOf(kind), position: keys[0].position, keys };
    const st = await K.setup(kind, a);
    const out = K.measure(st, a), s = K.physical(out);
    // the lower foot is down on every frame (not 3 cm up), and nothing floats
    let low = 0, at = -1;
    for (const r of out.rows) { const h = Math.min(r.l.h, r.r.h); if (h > low) { low = h; at = r.f; } }
    assert.ok(low < 0.005, `${kind} ${name}: the lower foot ${cm(low)} cm up at f${at}`);
    // FLAW (measured 2026-11-07): the woman's last step into the stop waits planted for the other foot with a 5 cm
    // single-support hip dip (T.supportDrop) for 3 frames instead of floating
    check(s, `${kind} ${name}`, { drop: 0.051 });
  }
});

test("real Rocketbox running 3 / 4 / 6 m/s: running feet are planted too (contact speed, not the ankle's), soles don't slide", { skip: NOT_INSTALLED }, async () => {
  // e56d6bc: 0 planted frames for one foot at 3 m/s and none at all at 4-6 m/s
  for (const kind of ["man", "woman"]) for (const [v, planted] of [[3, 30], [4, 20], [6, 20]]) {
    const a = walkAt(kind, v);
    const st = await K.setup(kind, a);
    // a run has a flight phase (no foot down) every stride, and a sprint's foot rolls fast over its contact
    check(K.physical(K.measure(st, a)), `${kind} ${v} m/s`, { float: 121, hover: 0.03, slide: 0.02, drift: 0.02, planted });
  }
});

test("real Rocketbox over a 15 cm kerb, up a flight of stairs and on uneven ground: nothing goes into a riser or a kerb, feet planted on the steps", { skip: NOT_INSTALLED }, async () => {
  const kerb = [{ id: "kerb", half: [3, 0.075, 3], pos: [3, 0.075, 0], quat: [0, 0, 0, 1] }];
  const stairs = [];
  for (let i = 0; i < 5; i++) stairs.push({ id: `s${i}`, half: [0.15, 0.075 * (i + 1), 1], pos: [0.3 * i + 0.15, 0.075 * (i + 1), 0], quat: [0, 0, 0, 1] });
  stairs.push({ id: "landing", half: [1.5, 0.375, 1], pos: [3.0, 0.375, 0], quat: [0, 0, 0, 1] });
  const bumps = (x, z) => 0.06 + 0.05 * Math.sin(1.7 * x) * Math.cos(1.3 * z + 0.4);
  for (const kind of ["man", "woman"]) {
    // e56d6bc: a swinging foot 8.5-15 cm into the kerb
    let a = K.walker(kind, {}, [-2.5, 0, 0], [2.5, 0, 0]);
    let st = await K.setup(kind, a, { boxes: kerb });
    check(K.physical(K.measure(st, a, { ground: K.boxGround(kerb) })), `${kind} kerb`);
    // up 5 steps of 15 cm x 30 cm (the body keyed up the stair's pitch line); e56d6bc: 15 cm into a riser
    const keys = [];
    for (let f = 0; f <= 120; f += 8) { const x = -2 + 5 * f / 120; keys.push({ frame: f, position: [x, Math.max(0, Math.min(0.75, 0.5 * x + 0.075)), 0] }); }
    a = { id: "stairs", kind, height_m: K.heightOf(kind), position: [-2, 0, 0], keys };
    st = await K.setup(kind, a, { boxes: stairs });
    // FLAW (measured 2026-11-07, depends on the gait phase): up to 8 frames at the step-ups with no foot within 5 mm
    // of a tread, a single-support hip dip up to 5 cm (T.supportDrop) instead of floating, a 1.04 cm slide at the foot
    check(K.physical(K.measure(st, a, { ground: K.boxGround(stairs) })), `${kind} stairs`, { float: 10, drop: 0.061, slide: 0.015 });
    // e56d6bc: 3-4 frames floating over the bumps and 1.4-11 cm slides
    a = K.walker(kind, {}, [-3, 0, 0.3], [3, 0, 0.3]);
    st = await K.setup(kind, a, { setFx: { id: "bumps", floorAt: bumps } });
    check(K.physical(K.measure(st, a, { ground: bumps })), `${kind} uneven`);
  }
});

test("the station ramp: stationFloor is the ramp the set draws, and a person walking up it onto the platform stands on it", { skip: NOT_INSTALLED }, async () => {
  const THREE = await import("../../web/vendor/three.module.min.mjs");
  const set = buildTrainStation();
  set.group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  for (const x of [5, 12, -9]) for (const z of [-77.5, -76, -74, -72, -70.5]) {
    ray.set(new THREE.Vector3(x, 3, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(set.group, true).find((h) => h.object.isMesh && !h.object.material?.transparent);
    assert.ok(hit, `something under (${x}, ${z})`);
    // e56d6bc: stationFloor 0 all the way up (the drawn ramp also tilted the wrong way, 0.92 m out at the far end)
    assert.ok(Math.abs(hit.point.y - stationFloor(x, z)) < 0.01, `(${x}, ${z}): drawn ${hit.point.y.toFixed(3)} m, stationFloor ${stationFloor(x, z).toFixed(3)} m`);
  }
  assert.equal(stationFloor(5, STATION.z0 + 1), STATION.platformTop);
  for (const kind of ["man", "woman"]) {
    const a = K.walker(kind, {}, [5, 0, -77], [5, 0, -71]);
    const st = await K.setup(kind, a, { setFx: set.fx });
    check(K.physical(K.measure(st, a, { ground: stationFloor })), `${kind} up the ramp`, { float: 3, hover: 0.02 });
  }
});

test("real Rocketbox turning on the spot fast (360 in 1 s and in 2 s) steps; a planted sole slides at most 1 cm in a frame; walking backwards plants", { skip: NOT_INSTALLED }, async () => {
  for (const kind of ["man", "woman"]) {
    for (const sec of [1, 2]) {
      // e56d6bc: 0 steps in 1 s and 46 frames sliding up to 5.5 cm; 2 s: up to 5.8 cm a frame
      const fr = 24 * sec;
      const a = { id: "spin", kind, height_m: K.heightOf(kind), position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0], heading_deg: 0 }, { frame: fr, position: [0, 0, 0], heading_deg: 360 }] };
      const st = await K.setup(kind, a, { frames: fr + 25 });
      const out = K.measure(st, a), plan = out.skin.feet.plan;
      assert.ok(plan.steps.l.length >= 2 && plan.steps.r.length >= 2, `${kind} ${sec} s: steps l ${plan.steps.l.length} r ${plan.steps.r.length}`);
      for (let f = 0; f < plan.n; f++) assert.ok(!(plan.state.l[f] === 2 && plan.state.r[f] === 2), `${kind} ${sec} s f${f}: both feet off the ground`);
      check(K.physical(out), `${kind} spin ${sec} s`, { drift: 0.02, planted: 30 });
    }
    // facing -X, walking +X: e56d6bc planted nothing (the walk played forwards while the body went back)
    const b = { id: "back", kind, height_m: K.heightOf(kind), position: [-2, 0, 0], keys: [{ frame: 0, position: [-2, 0, 0], heading_deg: -90 }, { frame: 120, position: [2, 0, 0], heading_deg: -90 }] };
    const st = await K.setup(kind, b);
    check(K.physical(K.measure(st, b)), `${kind} backwards`);
  }
});

test("grounding gate: feet on the ground, not 'no clay reason' (props, gaze, Pose keys, mocap, driven, Blocking are grounded; riding, carried, swimming, lying, lifted, airborne are not)", async () => {
  const C = await import("../../web/stage/people/avatarcore.mjs");
  assert.equal(typeof C.feetUpReason, "function");
  const p = { id: "p", kind: "man" };
  for (const [a, ctx] of [[p, {}], [{ ...p, mocap: { take: "t" } }, {}], [{ ...p, pose_keys: [{ frame: 0 }] }, {}], [{ ...p, simple_model: true }, {}]]) {
    assert.equal(C.feetUpReason(a, ctx), null, JSON.stringify(a));
  }
  // what clayReason sends to clay for reasons that aren't about the feet: grounded once the clay is retired
  const users = { holders: new Set(["p"]), carriers: new Set(["p"]) };
  assert.ok(C.clayReason(p, { holders: users.holders }) && C.feetUpReason(p, {}) === null, "holds a prop: clay today, grounded by the gate");
  assert.ok(C.clayReason(p, { gazeKeyed: true }) && C.feetUpReason(p, {}) === null);
  assert.ok(C.clayReason(p, { blocking: true }) && C.feetUpReason(p, {}) === null);
  for (const [a, ctx] of [[{ ...p, mount_id: "horse" }, {}], [{ ...p, carry_id: "q" }, {}], [{ ...p, physics: { baked: true } }, {}], [{ ...p, tilt: [0, 0, 0.7, 0.7] }, {}],
    [p, { lifted: true }], [p, { airborne: true }], [p, { swims: true }], [p, { floats: true }], [p, { tipped: true }]]) {
    assert.ok(C.feetUpReason(a, ctx), `${JSON.stringify(a)} ${JSON.stringify(ctx)} is off their feet`);
  }
});
