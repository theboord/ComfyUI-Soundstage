// node --test tests/js/footshift.test.mjs
// Lifelike-only L1, part 3 (the feet carry-over from private/feet): the body's sideways shift off a break (plan.shift)
// is shared root motion (the logic rig, its shadow and bounds move with the visible body), it is re-checked against
// what is under BOTH feet every frame (an alley: a kerb and a wall), it fades out before the frames off the feet, and
// it never starts on stairs met at an angle. Real-kit tests: SKIPPED without web/stage/people/rocketbox/.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as K from "./footkit.mjs";

const kerb = [{ id: "kerb", half: [2, 0.075, 4], pos: [2, 0.075, 0], quat: [0, 0, 0, 1] }];
const kf = (frame, x, y, z) => ({ frame, position: [x, y, z] });

test("real Rocketbox: the shift moves the logic rig AND the visible body (one root motion)", { skip: K.NOT_INSTALLED }, async () => {
  const a = { id: "lb", kind: "woman", height_m: 1.68, position: [-0.03, 0, -2], keys: [kf(0, -0.03, 0, -2), kf(120, -0.03, 0, 2)] };
  const st = await K.setup("woman", a, { boxes: kerb });
  const g = st.actorMeshes.get(a.id), skin = g.userData.humanSkin;
  let shifted = 0;
  for (let f = 0; f <= 120; f += 3) {
    const p = st._actorPosAt(a, f);
    g.position.set(p[0], st._heightAt(a, f), p[2]); g.updateMatrixWorld(true);
    st.frame = f; skin.holder.position.set(0, 0, 0); st.setFrame(f);
    const [sx, sz] = skin.shift || [0, 0];
    if (Math.hypot(sx, sz) < 1e-4) continue;
    shifted++;
    // the body moved by the shift, and the logic rig with it (its hips on the body's: avatars.mjs alignRig / fitRig
    // put the rig on the visible body every clip frame since L1 review round 2, so its own place is the body's, not
    // the keys' plus the shift)
    const hp = skin.holder.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(hp.x - p[0] - sx) < 1e-6 && Math.abs(hp.z - p[2] - sz) < 1e-6, `f${f}: the body moved by the shift`);
    const J = g.userData.joints, B = skin.bones, W = (o) => o.getWorldPosition(new THREE.Vector3());
    const clayHip = W(J.l_hip).add(W(J.r_hip)).multiplyScalar(0.5), bodyHip = W(B.Bip01_L_Thigh).add(W(B.Bip01_R_Thigh)).multiplyScalar(0.5);
    assert.ok(clayHip.distanceTo(bodyHip) < 0.005, `f${f}: the rig's hips on the body's (${(clayHip.distanceTo(bodyHip) * 100).toFixed(1)} cm)`);
  }
  assert.ok(shifted > 5, `the kerb case shifts (${shifted} frames)`);
  // and it is undone before the next pose (the stage sets the rig's place itself)
  const before = g.position.clone();
  st.setFrame(st.frame);
  assert.ok(g.position.distanceTo(before) < 1e-9, "the same frame again: the same place, not shifted twice");
});

test("real Rocketbox: an alley (a kerb on one side, a wall 22 cm off on the other): the shift off the kerb never puts a shoe into the wall", { skip: K.NOT_INSTALLED }, async () => {
  const wall = { id: "wall", half: [0.05, 1.5, 4], pos: [-0.27, 1.5, 0], quat: [0, 0, 0, 1] };
  const boxes = [...kerb, wall];
  for (const kind of ["man", "woman"]) {
    const a = { id: "al", kind, height_m: K.heightOf(kind), position: [-0.03, 0, -2], keys: [kf(0, -0.03, 0, -2), kf(120, -0.03, 0, 2)] };
    const st = await K.setup(kind, a, { boxes });
    const out = K.measure(st, a, { ground: K.boxGround(boxes) });
    let deep = 0, at = -1;
    for (const r of out.rows) for (const lr of ["l", "r"]) {
      const P = r[lr].P;
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        if (y > 0.02 && Math.abs(x - wall.pos[0]) < wall.half[0] && Math.abs(z) < wall.half[2]) { const d = wall.half[0] - Math.abs(x - wall.pos[0]); if (d > deep) { deep = d; at = r.f; } }
      }
    }
    assert.ok(deep < 0.005, `${kind}: a shoe ${(deep * 100).toFixed(1)} cm into the wall (f${at})`);
  }
});

test("real Rocketbox: the shift fades out before the frames off the feet (a hop), back at 0 on the last grounded frame", { skip: K.NOT_INSTALLED }, async () => {
  // along the kerb's low side, then a hop over a low crate in the way
  const crate = { id: "c1", kind: "crate", position: [-0.03, 0, 1.0], keys: [kf(0, -0.03, 0, 1.0)] };
  const a = { id: "lh", kind: "man", height_m: 1.8, position: [-0.03, 0, -2], keys: [kf(0, -0.03, 0, -2), kf(120, -0.03, 0, 3)] };
  const st = await K.setup("man", a, { boxes: kerb });
  st.state.actors.push(crate);
  K.clayOf(st, crate).updateMatrixWorld(true);
  st.frame = 0; st.setFrame(0);
  const plan = st.actorMeshes.get(a.id).userData.humanSkin.feet?.plan;
  assert.ok(plan, "a foot plan");
  const skips = [...Array(plan.n).keys()].filter((f) => plan.skip[f]);
  if (!skips.length) return;   // (no hop on this set: nothing to fade into)
  for (const f of skips) {
    for (const g of [f - 1, f + 1]) {
      if (g < 0 || g >= plan.n || plan.skip[g]) continue;
      assert.ok(Math.hypot(plan.shift[2 * g], plan.shift[2 * g + 1]) < 1e-9, `f${g} next to an airborne frame: shift ${plan.shift[2 * g]}`);
    }
  }
});

test("real Rocketbox: stairs met at a steep angle (a climb ~11-16 degrees off the risers): no body shift on the flight", { skip: K.NOT_INSTALLED }, async () => {
  // measured 2026-11-08 without the stairs gate: the woman shifted 18 cm on 58-61 frames, the man 19 cm on 30
  const stairs = [];
  for (let i = 0; i < 5; i++) stairs.push({ id: `s${i}`, half: [0.15, 0.075 * (i + 1), 4], pos: [0.3 * i + 0.15, 0.075 * (i + 1), 0], quat: [0, 0, 0, 1] });
  stairs.push({ id: "landing", half: [1.5, 0.375, 4], pos: [3.0, 0.375, 0], quat: [0, 0, 0, 1] });
  for (const [kind, zspan] of [["man", 5], ["woman", 5], ["man", 7], ["woman", 7]]) {
    const keys = [];
    for (let f = 0; f <= 120; f += 8) { const u = f / 120, x = -0.1 + 1.4 * u; keys.push(kf(f, x, Math.max(0, Math.min(0.75, 0.5 * x + 0.075)), -zspan / 2 + zspan * u)); }
    const a = { id: "ob", kind, height_m: K.heightOf(kind), position: keys[0].position, keys };
    const st = await K.setup(kind, a, { boxes: stairs });
    st.frame = 0; st.setFrame(0);
    const plan = st.actorMeshes.get(a.id).userData.humanSkin.feet?.plan;
    assert.ok(plan);
    for (let f = 0; f < plan.n; f++) {
      const x = st._actorPosAt(a, f)[0];
      if (x < -0.1 || x > 1.6) continue;   // on the flight
      assert.ok(Math.hypot(plan.shift[2 * f], plan.shift[2 * f + 1]) < 1e-9, `${kind} f${f} (x ${x.toFixed(2)}): shifted on the stairs`);
    }
  }
});

test("real Rocketbox: a kerb on a sloping street (15 cm, a 6% grade) still shifts the body; a slope is not stairs, and the shift never steps", { skip: K.NOT_INSTALLED }, async () => {
  // review round 2 (measured on 0ce517f): the footing-only stairs gate dropped the shift on 16 of 27 frames and the
  // woman's shoe stood across the kerb's edge on 19 of 20 stance frames (the parent of part 3: 0); and the per-frame
  // halving of the shift's wall re-check made 1.3 cm/frame sideways steps
  const floorAt = (x, z) => 0.06 * (z + 4) + (x > 0 ? 0.15 : 0);
  for (const kind of ["man", "woman"]) {
    const a = { id: "sk", kind, height_m: K.heightOf(kind), position: [-0.03, 0, -2], keys: [kf(0, -0.03, 0, -2), kf(120, -0.03, 0, 2)] };
    const st = await K.setup(kind, a, { setFx: { id: "slope", floorAt } });
    const out = K.measure(st, a, { ground: (x, z) => Math.max(0, floorAt(x, z)) });
    const plan = out.skin.feet.plan, sh = (f) => Math.hypot(plan.shift[2 * f], plan.shift[2 * f + 1]);
    let shifted = 0, straddle = 0, step = 0;
    for (let f = 0; f < plan.n; f++) {
      if (sh(f) > 1e-4) shifted++;
      if (f) step = Math.max(step, Math.abs(sh(f) - sh(f - 1)));
      for (const lr of ["l", "r"]) {
        const r = out.rows[f][lr];
        if (r.state !== 1 && r.h > 0.01) continue;   // a foot down
        let lo = 0, hi = 0;
        for (let i = 0; i < r.P.length; i += 3) { if (r.P[i] > 0.005) hi++; else if (r.P[i] < -0.005) lo++; }
        if (lo && hi) straddle++;
      }
    }
    assert.ok(shifted >= 0.9 * plan.n, `${kind}: shifted on ${shifted} of ${plan.n} frames`);
    assert.equal(straddle, 0, `${kind}: a planted shoe across the kerb's edge on ${straddle} foot-frames`);
    assert.ok(step < 0.005, `${kind}: the shift moves ${(step * 100).toFixed(2)} cm in one frame`);
    const s = K.physical(out);
    assert.ok(s.pen > -0.01, `${kind}: a shoe ${(s.pen * 100).toFixed(1)} cm into the street or the kerb`);
  }
});

test("real Rocketbox: the alley's wall re-check eases its cut (no sideways step of the body over 0.5 cm a frame)", { skip: K.NOT_INSTALLED }, async () => {
  const wall = { id: "wall", half: [0.05, 1.5, 4], pos: [-0.27, 1.5, 0], quat: [0, 0, 0, 1] };
  for (const kind of ["man", "woman"]) {
    const a = { id: "al", kind, height_m: K.heightOf(kind), position: [-0.03, 0, -2], keys: [kf(0, -0.03, 0, -2), kf(120, -0.03, 0, 2)] };
    const st = await K.setup(kind, a, { boxes: [...kerb, wall] });
    st.frame = 0; st.setFrame(0);
    const plan = st.actorMeshes.get(a.id).userData.humanSkin.feet.plan;
    let step = 0, at = -1;
    for (let f = 1; f < plan.n; f++) { const d = Math.hypot(plan.shift[2 * f] - plan.shift[2 * f - 2], plan.shift[2 * f + 1] - plan.shift[2 * f - 1]); if (d > step) { step = d; at = f; } }
    assert.ok(step < 0.005, `${kind}: the body steps ${(step * 100).toFixed(2)} cm sideways at f${at}`);
  }
});
