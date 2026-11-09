// node --test tests/js/sitstand.test.mjs
// Timed sit-down / stand-up (web/stage/people/sitstand.mjs, stage.setPose(id, "sit" | "stand", {on, at, until})): the
// timing and curves, the keys and spans the API writes, the heading (turning round to the seat's way), a seat the
// person is keyed onto is a seat and not ground, and on the real Rocketbox bodies: the hips land on the seat, the feet
// don't slide through the sit and the stand, the handovers don't pop, and the stand-up goes back to the idle and the
// walk.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as SS from "../../web/stage/people/sitstand.mjs";
import * as A from "../../web/stage/people/avatars.mjs";
import * as K from "./footkit.mjs";

const fps = 24;

test("sitstand: phases and timing (turn 0.9 s, down 1.1 s, up 1.2 s at 24 fps)", () => {
  assert.deepEqual(SS.frames(24), { turn: 22, down: 26, up: 29 });
  const span = { on: "c", at: 60, to: 150 };
  assert.deepEqual(SS.window(span, fps), { start: 60, down: 82, seated: 108, up: 150, end: 179 });
  assert.equal(SS.phaseAt(span, 59, fps), null, "walking up: not in it");
  assert.equal(SS.phaseAt(span, 60, fps).phase, "turn");
  assert.equal(SS.phaseAt(span, 82, fps).phase, "down");
  assert.equal(SS.phaseAt(span, 108, fps).phase, "seated");
  assert.equal(SS.phaseAt(span, 150, fps).phase, "up");
  assert.equal(SS.phaseAt(span, 178, fps).phase, "up");
  assert.equal(SS.phaseAt(span, 179, fps), null, "standing again: back on the keys");
  // open ends: seated from the shot's start, seated to its end
  assert.equal(SS.phaseAt({ on: "c", at: null, to: 40 }, 0, fps).phase, "seated");
  assert.equal(SS.phaseAt({ on: "c", at: 10, to: null }, 5000, fps).phase, "seated");
  assert.match(SS.spanError({ on: "c", at: 60, to: 90 }, fps), /before they are seated/);
  assert.match(SS.spanError({ on: "c", at: -1 }, fps), /before frame 0/);
  assert.equal(SS.spanError({ on: "c", at: 0, to: 48 }, fps), null);
});

test("sitstand: the curves start standing and end seated (and back), continuous, the hips land softly", () => {
  for (const ph of ["down", "up"]) {
    const a = SS.curves(ph, 0), b = SS.curves(ph, 1);
    const [s0, s1] = ph === "down" ? [0, 1] : [1, 0];
    for (const k of ["back", "down", "w"]) { assert.ok(Math.abs(a[k] - s0) < 1e-9, `${ph} ${k} starts at ${s0}`); assert.ok(Math.abs(b[k] - s1) < 1e-9, `${ph} ${k} ends at ${s1}`); }
    assert.ok(Math.abs(a.lean) < 1e-9 && Math.abs(b.lean) < 1e-6, `${ph}: upright at both ends`);
    let maxLean = 0;
    for (let i = 1; i <= 200; i++) {
      const p = SS.curves(ph, (i - 1) / 200), q = SS.curves(ph, i / 200);
      for (const k of ["back", "down", "w", "lean"]) assert.ok(Math.abs(q[k] - p[k]) < 0.03, `${ph} ${k} continuous at ${i / 200}`);
      maxLean = Math.max(maxLean, q.lean);
    }
    assert.ok(maxLean > 0.45, `${ph}: the trunk leans over the knees (${maxLean.toFixed(2)} rad)`);
  }
  // sitting down: the hips go back before they come down; the descent's speed is zero at the seat
  const d = (t) => SS.curves("down", t);
  assert.ok(d(0.3).back > d(0.3).down + 0.2, "back first, then down");
  assert.ok(d(1).down - d(0.98).down < 1e-3, "soft landing");
  // standing up: the trunk leans before the hips leave the seat
  const u = (t) => SS.curves("up", t);
  assert.ok(u(0.2).down > 0.999 && u(0.2).lean > 0.3, "leaning forward while still on the seat");
});

// ---------------------------------------------------------------- the stage: keys, spans, heading, the seat as ground
async function sitScene(kind, { install = true } = {}) {
  const h = K.heightOf(kind);
  const person = { id: "p", name: "Jane Doe", kind, height_m: h, position: [-3, 0, 0.3], keys: [{ frame: 0, position: [-3, 0, 0.3] }] };
  const chair = { id: "c1", name: "chair", kind: "chair", height_m: 0.9, rotation_deg: -90, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] };
  const st = K.bareStage([person, chair], { frames: 241 });
  const g = K.clayOf(st, person);
  const cg = K.clayOf(st, chair); cg.rotation.y = -Math.PI / 2; cg.updateMatrixWorld(true);
  if (install) { const kits = await K.realKits(); st._loadKit = () => kits[kind]; A.attachKit(st, person, g, kits[kind]); await null; }
  return { st, person, chair, g };
}

test("setPose sit {at}: walks to the stand spot in front of the chair, a span, the keys hold there; stand {at, away} ends it and steps away", async () => {
  const { st, person } = await sitScene("woman", { install: false });
  st.frame = 0;
  const r = st.setPose("p", "sit", { on: "c1", at: "auto" });
  assert.equal(r.ok, true, r.error);
  // the chair faces -X (rotation -90): the stand spot is 0.36 m x 1.68/1.8 in front of the seat
  assert.ok(Math.abs(r.stand[0] + 0.336) < 1e-3 && Math.abs(r.stand[1]) < 1e-3, `stand spot ${r.stand}`);
  assert.ok(r.at > 48 && r.at < 90, `arrives after an easy walk of 2.68 m: frame ${r.at}`);
  assert.deepEqual(person.sit_spans, [{ on: "c1", at: r.at, to: null }]);
  assert.deepEqual(person.keys.map((k) => k.frame), [0, r.at, 240], "start, arrival, held to the shot's end");
  // seated to the end: stand them up at 150, then 1.2 m away
  const s = st.setPose("p", "stand", { at: 150, away: 1.2 });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.standing, 179);
  assert.deepEqual(person.sit_spans, [{ on: "c1", at: r.at, to: 150 }]);
  const ks = person.keys;
  assert.deepEqual(ks.slice(0, 3).map((k) => k.frame), [0, r.at, 179]);
  assert.ok(ks[3].frame > 179 && Math.abs(ks[3].position[0] - (-0.336 - 1.2)) < 1e-3, `a step away along the seat's facing: ${JSON.stringify(ks[3])}`);
  // refusals change nothing
  const before = JSON.stringify(person);
  assert.match(st.setPose("p", "stand", { at: 20 }).error, /isn't seated at frame 20/);
  assert.match(st.setPose("p", "sit", { on: "c1", at: 60, until: 70 }).error, /before they are seated/);
  assert.match(st.setPose("p", "sit", { on: "c1", at: "soon" }).error, /bad 'at'/);
  assert.equal(JSON.stringify(person), before);
  // "<n>s" times; one person per seat
  const other = { id: "q", name: "John Doe", kind: "man", height_m: 1.8, position: [2, 0, 0], keys: [{ frame: 0, position: [2, 0, 0] }] };
  st.state.actors.push(other); K.clayOf(st, other);
  assert.match(st.setPose("q", "sit", { on: "c1", at: "2s" }).error, /taken by 'Jane Doe'/);
});

test("timed sit: the seat's way from the turn on, the logic rig seated on the chair, and a key on the chair is a seat, not ground", async () => {
  const { st, person, g } = await sitScene("man", { install: false });
  st.frame = 0;
  const r = st.setPose("p", "sit", { on: "c1", at: 40, until: 140 });
  assert.equal(r.ok, true, r.error);
  const w = SS.window(person.sit_spans[0], fps);
  const yaw = -Math.PI / 2, d = (x) => Math.abs(Math.atan2(Math.sin(x - yaw), Math.cos(x - yaw)));
  assert.ok(d(st._headingAt(person, w.start - 2)) > 2.5, "still facing the chair while walking up (no turning round early)");
  assert.ok(d(st._headingAt(person, w.down)) < 0.02, `turned round by the sit-down: ${st._headingAt(person, w.down)}`);
  for (const f of [w.seated, 120, w.up, w.end - 1]) assert.ok(d(st._headingAt(person, f)) < 1e-6, `facing the seat's way at ${f}`);
  assert.equal(st._sitSpec(person, w.start + 3), null, "turning round: on the feet");
  for (const [f, ph] of [[w.down, "down"], [w.seated, "seated"], [w.up + 2, "up"]]) assert.equal(st._sitSpec(person, f)?.span.phase, ph);
  assert.equal(st._sitSpec(person, w.end), null);
  // the keys hold them at the stand spot on the floor: the chair is never their ground ...
  for (let f = 0; f <= 240; f += 10) assert.equal(st._heightAt(person, f), 0, `on the floor at ${f}`);
  // ... even keyed right onto the chair's seat (0153fa5: a key inside a prop's footprint puts them ON it; with a timed
  // sit on that chair, a key there is sitting on it)
  person.keys.splice(2, 0, { frame: 100, position: [0, 0, 0] });
  st._yCache?.delete(person);
  assert.equal(st._heightAt(person, 100), 0, "a key on the chair they sit on: not lifted onto its top");
  delete person.sit_spans;
  st._yCache?.delete(person);
  assert.ok(st._heightAt(person, 100) > 0.4, "without the sit, the same key stands them on the chair (0153fa5 unchanged)");
});

// ---------------------------------------------------------------- the real Rocketbox bodies
const W = (b) => b.getWorldPosition(new THREE.Vector3());
for (const kind of ["woman", "man"]) {
  test(`real Rocketbox ${kind}: walks to the chair, sits (hips on the seat), holds, stands, walks away: no foot sliding, no pop, back to idle and walk`, { skip: K.NOT_INSTALLED }, async () => {
    const { st, person } = await sitScene(kind);
    st.frame = 0;
    const r = st.setPose("p", "sit", { on: "c1", at: "auto" });
    assert.equal(r.ok, true, r.error);
    st.frame = r.seated + 30;
    assert.equal(st.setPose("p", "stand", { at: r.seated + 30, away: 1.2 }).ok, true);
    const span = person.sit_spans[0], w = SS.window(span, fps), h = K.heightOf(kind);
    const out = K.measure(st, person);
    const skin = out.skin;
    assert.ok(skin.kit.seated, "the seated idle is installed (the real Rocketbox clip plays on the seat)");
    const rows = out.rows, hip = (f) => rows[f].l.hip.clone().add(rows[f].r.hip).multiplyScalar(0.5);
    // 1. hips on the seat: 0.47 m seat, +0.10 x h/1.8, 0.06 x h/1.8 back from its centre (the chair faces -X)
    const want = new THREE.Vector3(0.06 * h / 1.8, 0.47 + 0.10 * h / 1.8, 0);
    for (let f = w.seated; f < w.up; f++) assert.ok(hip(f).distanceTo(want) < 0.01, `${kind} f${f}: hips ${hip(f).toArray().map((v) => v.toFixed(3))} on the seat`);
    // 2. timing: standing when the sit-down starts, seated when it ends, standing again when the stand-up ends
    const standY = hip(w.start - 1).y;
    assert.ok(standY > 0.8 * h / 1.8 * 0.9, `standing hips ${standY.toFixed(3)}`);
    assert.ok(Math.abs(hip(w.down).y - standY) < 0.02, "the sit-down starts from standing");
    assert.ok(hip(w.down + Math.round(0.5 * (w.seated - w.down))).y < standY - 0.1, "halfway down by the middle of the sit-down");
    assert.ok(Math.abs(hip(w.end).y - standY) < 0.03, `standing again at the end of the stand-up: ${hip(w.end).y.toFixed(3)}`);
    // 3. no foot sliding through the sit and the stand: every shoe vertex touching the ground on two frames in a row
    // moves under 1 cm (the footplant tests' bar), and from the frame before the sit-down to the end of the stand-up
    // a touching vertex drifts under 2 cm from where it touched down (the feet stay planted)
    let slide = 0, at = "", drift = 0, dat = "";
    const touch = 0.005;
    for (const lr of ["l", "r"]) {
      const start = new Map();
      for (let f = w.down - 1; f <= w.end; f++) {
        const c = rows[f][lr], p = rows[f - 1][lr];
        for (let k = 0; k < c.H.length; k++) {
          const dxz = Math.hypot(c.P[3 * k] - p.P[3 * k], c.P[3 * k + 2] - p.P[3 * k + 2]);
          if (c.H[k] < touch && p.H[k] < touch && dxz > slide) { slide = dxz; at = `${lr} f${f}`; }
          if (!(c.H[k] < touch)) { start.delete(k); continue; }
          const s0 = start.get(k);
          if (!s0) { start.set(k, [c.P[3 * k], c.P[3 * k + 2]]); continue; }
          const dd = Math.hypot(c.P[3 * k] - s0[0], c.P[3 * k + 2] - s0[1]);
          if (dd > drift) { drift = dd; dat = `${lr} f${f}`; }
        }
      }
    }
    assert.ok(slide <= 0.01, `${kind}: a touching shoe slid ${(100 * slide).toFixed(2)} cm in a frame (${at})`);
    assert.ok(drift <= 0.02, `${kind}: a planted shoe drifted ${(100 * drift).toFixed(2)} cm (${dat})`);
    // the soles stay on the ground while the weight is on them (sit-down, seated hold off the shuffle, stand-up start)
    for (const f of [w.down + 8, w.seated + 2, w.up + 4]) for (const lr of ["l", "r"]) assert.ok(Math.abs(rows[f][lr].h) < 0.012, `${kind} f${f} ${lr}: sole ${(100 * rows[f][lr].h).toFixed(1)} cm off the ground`);
    // 4. no pop at the handovers (clip -> sit-down, stand-up -> clip): the hips move as they do in the frames around
    for (const f of [w.down, w.end]) {
      const jump = hip(f).distanceTo(hip(f - 1)), before = hip(f - 1).distanceTo(hip(f - 2)), after = hip(f + 1).distanceTo(hip(f));
      assert.ok(jump < 0.025 && jump < 3 * Math.max(before, after, 0.004), `${kind} f${f}: hips ${(100 * jump).toFixed(2)} cm (around: ${(100 * before).toFixed(2)}, ${(100 * after).toFixed(2)})`);
    }
    // 5. back to the idle and the walk: the clip owns the frame after the stand-up, standing (idle), then walks away
    st.frame = w.end; A.avatarsAt(st);
    assert.equal(skin.owner, "clip", `the clip owns f${w.end} (${skin.ownerReason})`);
    // (the step away is keyed from this frame on, so the walk is just setting off from standing: mostly the idle)
    assert.ok(skin.weights.idle > 0.8 && !(skin.weights.run > 0), `idle at f${w.end}: ${JSON.stringify(skin.weights)}`);
    const walkF = w.end + 24;
    st.frame = walkF; A.avatarsAt(st);
    assert.equal(skin.owner, "clip");
    assert.ok((skin.weights.walk || 0) > 0.5, `walking away at f${walkF}: ${JSON.stringify(skin.weights)}`);
    assert.ok(hip(walkF).x < -0.336 - 0.3, `stepped away from the chair: ${hip(walkF).x.toFixed(2)}`);
    // the seat owns the transition frames; the rig never does
    for (const f of [w.down, w.seated, w.up, w.end - 1]) { st.frame = f; A.avatarsAt(st); assert.equal(skin.owner, "seat", `f${f}: ${skin.owner} (${skin.ownerReason})`); }
  });
}

test("stand {at} from a whole-shot seat (an earlier shot sat them down): becomes a sit held from the shot's start, then up", async () => {
  const { st, person } = await sitScene("woman", { install: false });
  assert.equal(st.setPose("p", "sit", { on: "c1" }).ok, true, "a plain (whole-shot) sit");
  assert.equal(person.mount_id, "c1");
  const r = st.setPose("p", "stand", { at: 48 });
  assert.equal(r.ok, true, r.error);
  assert.equal(person.mount_id, undefined);
  assert.deepEqual(person.sit_spans, [{ on: "c1", at: null, to: 48 }]);
  assert.equal(st._sitSpec(person, 0)?.span.phase, "seated", "seated from the first frame");
  assert.equal(st._sitSpec(person, 50)?.span.phase, "up");
  assert.equal(st._sitSpec(person, 48 + 29), null, "standing at the stand spot after 1.2 s");
  assert.deepEqual(person.keys.map((k) => k.frame), [0, 77]);
});

test("Director sit / stand executors call the timed setPose (seconds to frames, 'auto' arrival, a step away)", async () => {
  const { EXEC } = await import("../../web/agent/director.mjs");
  const calls = [];
  const stage = { state: { shot: { fps: 24 } }, frame: 30, setPose: (id, pose, opts) => { calls.push([id, pose, opts]); return pose === "sit" ? { ok: true, at: 60, seated: 108, until: null } : { ok: true, at: opts.at }; } };
  let r = await EXEC.sit.call({ stage }, { target: "Jane", target_id: "p", on: "Chair", on_id: "c1" });
  assert.equal(r.ok, true); assert.match(r.said, /sits down at 2\.5 s \(seated by 4\.5 s\)/);
  r = await EXEC.sit.call({ stage }, { target: "Jane", target_id: "p", on: "Chair", on_id: "c1", time: 1, until: 6 });
  assert.deepEqual(calls[1], ["p", "sit", { on: "c1", at: 24, until: 144 }]);
  r = await EXEC.stand.call({ stage }, { target: "Jane", target_id: "p" });
  assert.deepEqual(calls[2], ["p", "stand", { at: 30, away: 0.8 }]);
  const bad = { ...stage, setPose: () => ({ ok: false, error: "nope" }) };
  assert.equal((await EXEC.stand.call({ stage: bad }, { target: "Jane", target_id: "p" })).ok, false);
});

test("timed sit from behind the chair: the walk goes round it (a key beside it), never through the seat", async () => {
  const { st, person } = await sitScene("man", { install: false });
  // the chair faces -X; start 2 m behind it (+X)
  person.keys = [{ frame: 0, position: [2, 0, 0.05] }]; person.position = [2, 0, 0.05];
  st.frame = 0;
  const r = st.setPose("p", "sit", { on: "c1", at: "auto" });
  assert.equal(r.ok, true, r.error);
  assert.equal(person.keys.length, 4, JSON.stringify(person.keys));
  for (let f = 0; f <= r.at; f++) {
    const p = st._actorPosAt(person, f);
    assert.ok(Math.hypot(p[0], p[2]) > 0.3, `f${f}: ${p[0].toFixed(2)}, ${p[2].toFixed(2)} is through the chair`);
  }
});
