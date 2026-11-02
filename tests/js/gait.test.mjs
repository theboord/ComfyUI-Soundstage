// Foot-locked locomotion (web/stage/gait.mjs): gait choice by speed, planted feet that never slide, starting and
// stopping on real steps, horse footfalls, and seeded dust.
// node --test tests/js/gait.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { buildHuman } from "../../web/stage/humans.mjs";
import * as Gait from "../../web/stage/gait.mjs";

const FPS = 24;
const mesh = (g) => new THREE.Mesh(g);

/** A path along +Z (bending left at `curve` rad/m): speed(f) m/s, n frames. */
function path(speedAt, n = 121, curve = 0) {
  const pos = [[0, 0, 0]], yaw = [0];
  let h = 0;
  for (let f = 1; f < n; f++) {
    const v = speedAt(f) / FPS;
    h += curve * v;
    const p = pos[f - 1];
    pos.push([p[0] + Math.sin(h) * v, 0, p[2] + Math.cos(h) * v]);
    yaw.push(h);
  }
  return { pos, yaw };
}

/** Play a person along a path; per frame each foot's heel and toe (world) and whether it is planted. */
function play(speedAt, { h = 1.8, n = 121, curve = 0 } = {}) {
  const g = buildHuman("man", h, {}, mesh);
  const { pos, yaw } = path(speedAt, n, curve);
  const plan = Gait.planGait({ pos, yaw, fps: FPS, kind: "human", height: h, legs: Gait.humanFootRest(g) });
  const rows = [];
  for (let f = 0; f < n; f++) {
    g.position.set(pos[f][0], 0, pos[f][2]);
    const st = Gait.applyHuman(g, plan, f, { yaw: yaw[f], baseY: 0, support: () => 0 });
    g.updateMatrixWorld(true);
    rows.push({ st, lean: g.rotation.z, feet: ["l", "r"].map((lr, i) => ({ ...Gait.shoeContact(g, lr), stance: Gait.footAt(plan, i, f).stance })) });
  }
  return { g, plan, rows };
}

/** Worst slide (m/frame) of a planted foot's contact point (heel or toe, whichever is still) between planted frames. */
function worstSlide(rows) {
  let worst = 0, where = null;
  for (let f = 1; f < rows.length; f++) for (let i = 0; i < 2; i++) {
    const a = rows[f - 1].feet[i], b = rows[f].feet[i];
    if (!a.stance || !b.stance) continue;
    const d = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
    const s = Math.min(d(a.heel, b.heel), d(a.toe, b.toe));
    if (s > worst) { worst = s; where = { f, i }; }
  }
  return { worst, where };
}

test("gait is chosen by speed (people and horses), scaled by size", () => {
  assert.equal(Gait.humanGait(0).name, "idle");
  assert.equal(Gait.humanGait(1.3).name, "walk");
  assert.equal(Gait.humanGait(3).name, "jog");
  assert.equal(Gait.humanGait(5.5).name, "run");
  assert.equal(Gait.humanGait(1.9, 1.2).name, "jog", "a child jogs where an adult still walks");
  assert.equal(Gait.horseGait(1.5).name, "walk");
  assert.equal(Gait.horseGait(3.5).name, "trot");
  assert.equal(Gait.horseGait(6).name, "canter");
  assert.equal(Gait.horseGait(12).name, "gallop");
  assert.equal(Gait.gaitName("horse", 0), "idle");
  // Faster = longer strides AND quicker cadence; a run's foot is down for a smaller share of the stride.
  const st = (v) => v / Gait.humanGait(v).freq;
  assert.ok(st(1.4) > 1.3 && st(1.4) < 1.8, `walking stride ${st(1.4).toFixed(2)} m`);
  assert.ok(st(5.5) > 2.8 && st(5.5) < 4, `running stride ${st(5.5).toFixed(2)} m`);
  assert.ok(Gait.humanGait(5.5).freq > Gait.humanGait(1.4).freq);
  assert.ok(Gait.humanGait(5.5).duty < 0.45 && Gait.humanGait(1.4).duty > 0.55);
  // Horse footfalls: the trot moves diagonal pairs together, the walk is four even beats.
  const tr = Gait.horseGait(3.5).offsets, wk = Gait.horseGait(1.2).offsets;
  const same = (a, b) => Math.abs(((a - b) % 1 + 1.5) % 1 - 0.5) < 0.02;
  assert.ok(same(tr[0], tr[3]) && same(tr[1], tr[2]) && same(tr[0] + 0.5, tr[1]), "trot: LH with RF, LF with RH, half a stride apart");
  assert.deepEqual(wk.map((x) => +x.toFixed(2)), [0, 0.25, 0.5, 0.75]);
});

for (const [name, v] of [["walk", 1.4], ["jog", 3], ["run", 5.5]]) {
  test(`${name}: a planted foot does not slide (< 1 cm/frame) and stays on the ground`, () => {
    // stand, set off, hold the speed, stop
    const sp = (f) => (f < 10 ? 0 : f < 22 ? v * (f - 10) / 12 : f < 96 ? v : f < 104 ? v * (104 - f) / 8 : 0);
    const { rows, plan } = play(sp);
    const { worst, where } = worstSlide(rows);
    assert.ok(worst < 0.01, `stance foot slid ${(worst * 100).toFixed(2)} cm in a frame at ${JSON.stringify(where)}`);
    for (const [f, r] of rows.entries()) for (const ft of r.feet) if (ft.stance) {
      const low = Math.min(ft.heel.y, ft.toe.y);
      assert.ok(Math.abs(low) < 0.015, `planted foot off the ground at frame ${f}: ${low.toFixed(3)}`);
    }
    const peak = Math.max(...rows.map((r) => Math.max(0, ...r.feet.filter((x) => !x.stance).map((x) => Math.min(x.heel.y, x.toe.y)))));
    assert.ok(peak > 0.05, `a swinging foot clears the ground (${peak.toFixed(2)} m)`);
    assert.equal(plan.gaits[60].name, name);
  });
}

test("starting and stopping are real steps: still feet before, both feet down and still after", () => {
  const { rows, plan } = play((f) => (f < 20 ? 0 : f < 70 ? 1.4 : 0));
  for (let f = 0; f < 19; f++) assert.ok(rows[f].feet.every((x) => x.stance), `standing at frame ${f}`);
  assert.ok(rows.slice(-12).every((r) => r.feet.every((x) => x.stance)), "both feet down once settled");
  assert.equal(plan.phase[120], plan.phase[108], "the stride stops once both feet are down");
  // the last plants are under the body (a finishing step, not a foot left a stride behind)
  const bodyZ = 1.4 * 50 / FPS;
  for (const ft of rows[120].feet) { const z = (ft.heel.z + ft.toe.z) / 2; assert.ok(Math.abs(z - bodyZ) < 0.45, `foot ${z.toFixed(2)} vs body ${bodyZ.toFixed(2)}`); }
});

test("turning: the body leans into the curve, feet still planted", () => {
  const { rows } = play(() => 4.5, { curve: 0.25 });
  assert.ok(worstSlide(rows).worst < 0.01);
  assert.ok(rows[60].lean < -0.05, `leans into a left turn (${rows[60].lean.toFixed(3)})`);
});

test("horse plan: footfalls follow the gait, each hoof planted on one spot, next spot ahead", () => {
  const legs = [{ x: 0.25, z: -0.6 }, { x: 0.25, z: 0.6 }, { x: -0.25, z: -0.6 }, { x: -0.25, z: 0.6 }];
  const { pos, yaw } = path((f) => (f < 30 ? 1.5 : f < 60 ? 3.6 : f < 85 ? 6.5 : 12));
  const plan = Gait.planGait({ pos, yaw, fps: FPS, kind: "horse", height: 1.6, legs });
  assert.equal(plan.gaits[15].name, "walk");
  assert.equal(plan.gaits[45].name, "trot");
  assert.equal(plan.gaits[72].name, "canter");
  assert.equal(plan.gaits[110].name, "gallop");
  for (let i = 0; i < 4; i++) for (let f = 0; f < 121; f++) {
    const b = Gait.footAt(plan, i, f);
    if (!b.stance) assert.ok(b.next.p[1] >= b.c.p[1] - 1e-6, "the next hoof spot is ahead");
  }
  const g = plan.gaits[110];
  assert.ok(12 / g.freq > 4.5 && 12 / g.freq < 7.5, `gallop stride ${(12 / g.freq).toFixed(1)} m`);
  assert.ok(g.duty < 0.3);
});

test("dust: seeded (same frame, same particles), scales with speed and ground", () => {
  const legs = [{ x: 0.25, z: -0.6 }, { x: 0.25, z: 0.6 }, { x: -0.25, z: -0.6 }, { x: -0.25, z: 0.6 }];
  const mk = (v) => { const { pos, yaw } = path(() => v); return Gait.planGait({ pos, yaw, fps: FPS, kind: "horse", height: 1.6, legs }); };
  const ev = Gait.strikeEvents(mk(12), { id: "h" });
  const desert = Gait.groundDust("desert", "none"), street = Gait.groundDust("street_night", "none");
  const a = Gait.dustParticles(ev, 80, { fps: FPS, amount: desert.amount, color: desert.color });
  const b = Gait.dustParticles(ev, 80, { fps: FPS, amount: desert.amount, color: desert.color });
  assert.ok(a.length > 50, `a galloping horse on sand throws dust (${a.length})`);
  assert.deepEqual(a, b, "deterministic");
  assert.notDeepEqual(a, Gait.dustParticles(ev, 80, { fps: FPS, amount: desert.amount, color: desert.color, seed: 2 }), "the seed changes it");
  assert.ok(Gait.dustParticles(ev, 80, { fps: FPS, amount: street.amount }).length < a.length / 3, "asphalt barely dusts");
  const walk = Gait.dustParticles(Gait.strikeEvents(mk(1.4), { id: "h" }), 80, { fps: FPS, amount: 1 }).length;
  assert.ok(walk < a.length / 8, `a walk barely marks the ground (${walk} vs ${a.length})`);
  assert.equal(Gait.groundDust("interior").amount, 0);
});

test("mount: foot in the stirrup, spring up, off leg over the croup, settle into the ride pose (~1 s)", () => {
  assert.equal(Gait.MOUNT_FRAMES, 24);
  const a = Gait.mountMotion(0), r = Gait.mountMotion(0.2), up = Gait.mountMotion(0.5), ov = Gait.mountMotion(0.75), e = Gait.mountMotion(1);
  assert.equal(a.rise, 0); assert.equal(a.over, 0); assert.equal(a.limbs[1].hip[0], 0);
  assert.ok(r.limbs[1].hip[0] < -1.2 && r.limbs[1].knee > 1.5, "near foot lifted into the stirrup");
  assert.ok(r.limbs[1].shoulder < -2, "hands up to the saddle");
  assert.ok(up.rise > 0.95 && up.limbs[-1].hip[0] > 0.6, "standing in the stirrup, off leg swung back");
  assert.ok(Math.abs(ov.limbs[-1].hip[1]) > 1.2 && ov.over > 0.5, "off leg out and over the croup");
  // ends in humans.mjs's ride pose: hips -1.1 spread side*0.45, knees 1.3, upright, seated
  assert.equal(e.sit, 1); assert.equal(e.over, 1); assert.equal(e.lean, 0);
  for (const sd of [1, -1]) {
    assert.ok(Math.abs(e.limbs[sd].hip[0] + 1.1) < 1e-9 && Math.abs(e.limbs[sd].hip[1] - sd * 0.45) < 1e-9);
    assert.ok(Math.abs(e.limbs[sd].knee - 1.3) < 1e-9);
  }
});

test("horse cadence through canter -> gallop follows the speed (planted hooves don't slide mid-change)", () => {
  const sweep = { walk: 0.55, gallop: 1.1 };
  for (const v of [7, 7.6, 8, 8.4, 9, 11, 13]) {
    const g = Gait.horseGait(v, 1.6, sweep);
    const w = g.weights, sw = (w.walk + w.trot) * sweep.walk + (w.canter + w.gallop) * sweep.gallop;
    const base = g.duty - 0.16 * Math.max(0, Math.min(1, 1 - v / 1.5));
    // ground covered by a hoof in stance (duty / freq * v) matches the clip's sweep within 10%
    assert.ok(Math.abs(base / g.freq * v - sw) / sw < 0.1, `v=${v}: stance ${(base / g.freq * v).toFixed(2)} vs sweep ${sw.toFixed(2)}`);
  }
});
