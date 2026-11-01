// Motion capture cleanup (web/stage/mocap.mjs, "Stick feet to ground"): foot-contact detection, planting on the floor or
// the surface under the foot, the pelvis height solve, and the leg IK that stops a planted foot sliding.
// node --test tests/js/footcontact.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { buildHuman } from "../../web/stage/humans.mjs";
import * as M from "../../web/stage/mocap.mjs";

const N = 72, FPS = 24;
const mesh = (g) => new THREE.Mesh(g);

/**
 * A synthetic SAM 3D Body take: a person standing (facing +Z, +X their left) who lifts the left foot for a step in
 * frames 20-31. drift: the capture's monocular depth floats the whole body this many metres (creeping in over frames 34-58).
 * jump: frames 50-61 the whole body goes up a 0.3 m ballistic arc. jitter: root wobble in X (metres, per frame).
 */
function synthTake({ drift = 0, jump = false, jitter = 0 } = {}) {
  const P = (x, y, z) => [x, y, z];
  const body = [], root = [];
  for (let i = 0; i < N; i++) {
    const step = i >= 20 && i <= 31 ? Math.sin(Math.PI * (i - 20) / 11) : 0;
    const lAnk = P(0.1, 0.08 + 0.4 * step, -0.05 * step), lKnee = P(0.1, 0.5 + 0.2 * step, 0.3 * step);
    body.push([P(0, 1.65, 0.1), P(0, 1.45, 0), P(-0.18, 1.42, 0), P(-0.22, 1.15, 0), P(-0.22, 0.9, 0.02), P(0.18, 1.42, 0), P(0.22, 1.15, 0),
      P(0.22, 0.9, 0.02), P(-0.1, 0.9, 0), P(-0.1, 0.5, 0.01), P(-0.1, 0.08, 0), P(0.1, 0.9, 0), lKnee, lAnk,
      P(-0.03, 1.68, 0.09), P(0.03, 1.68, 0.09), P(-0.08, 1.66, 0), P(0.08, 1.66, 0)]);
    let y = drift * Math.min(1, Math.max(0, (i - 34) / 24));
    if (jump && i >= 50 && i <= 61) { const t = (i - 50) / 11; y += 4 * 0.3 * t * (1 - t); }
    root.push([jitter ? jitter * Math.sin(i * 0.5) : 0, y, 0]);
  }
  return M.retarget({ fps: FPS, frames: N, body, root, hands: [] });
}

/** Play take on a 1.8 m figure; per frame: each sole's height over support(x,z), and the foot centres. */
function play(take, { stick = true, support = null, h = 1.8 } = {}) {
  const g = buildHuman("man", h, {}, mesh);
  const mocap = { start: 0, travel: true, ...(stick ? {} : { stick: false }) };
  const base = { x: 0, y: 0, z: 0, yaw: 0, ...(support ? { support } : {}) };
  base.at = () => base;
  const rows = [];
  for (let f = 0; f < take.n; f++) {
    M.apply(g, take, mocap, f, base, h, FPS);
    const row = {};
    for (const lr of ["l", "r"]) {
      const s = M.footState(g, lr);
      row[lr] = { h: s.sole - (support ? support(s.center.x, s.center.z) : 0), c: s.center.clone() };
    }
    rows.push(row);
  }
  return rows;
}

test("cleanRuns closes short gaps and drops blips", () => {
  const f = [1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1].map(Boolean);
  assert.deepEqual(M.cleanRuns(f, 3, 2).map(Number), [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("contact detection: a planted foot is slow and low; a step, a swing and a jump's apex are not contacts", () => {
  const t = synthTake({ jump: true });
  // right foot: down all the time except the jump; left foot: up for its step (frames ~21-30) and the jump
  for (const i of [5, 15, 40, 45, 68]) { assert.ok(t.contact.l[i], `l planted at ${i}`); assert.ok(t.contact.r[i], `r planted at ${i}`); }
  for (const i of [24, 25, 26]) assert.ok(!t.contact.l[i], `left foot mid-step at ${i} is not a contact`);
  for (const i of [24, 25, 26]) assert.ok(t.contact.r[i], `right foot carries the weight at ${i}`);
  for (const i of [54, 55, 56, 57]) assert.ok(!t.contact.l[i] && !t.contact.r[i], `jump apex ${i}: both feet off`);
  // weights ease in and out, anchors sit inside their contact
  assert.equal(t.plant.r[0], 1, "a contact running off the start of the take is fully planted");
  assert.ok(t.plant.l[20] < 1 && t.plant.l[10] === 1);
  const a = t.plant.anchor.l[10];
  assert.ok(a >= 0 && t.contact.l[a]);
});

test("contact detection ignores slow depth drift: a floating capture still has its feet down", () => {
  const t = synthTake({ drift: 0.1 });
  for (const i of [40, 50, 60, 70]) assert.ok(t.contact.l[i] && t.contact.r[i], `planted at ${i}`);
  assert.ok(t.frames.slice(32).every((f) => f.lift < 0.01), "no lift where the capture merely drifted");
});

test("solvePelvis: the lowest planted sole touches its support; jumps keep their height; nothing goes under", () => {
  // planted left sole 5 cm up over a 0 floor, right foot raised (not planted): come down 5 cm
  assert.ok(Math.abs(M.solvePelvis([{ sole: 0.05, support: 0, w: 1 }, { sole: 0.3, support: 0, w: 0 }]) + 0.05) < 1e-9);
  // planted on a 15 cm step: rise to it
  assert.ok(Math.abs(M.solvePelvis([{ sole: 0.02, support: 0.15, w: 1 }, { sole: 0.4, support: 0, w: 0 }]) - 0.13) < 1e-9);
  // airborne (no plant): the lowest foot rides `lift` over its support
  assert.ok(Math.abs(M.solvePelvis([{ sole: 0.1, support: 0, w: 0 }, { sole: 0.2, support: 0, w: 0 }], 0.3) - 0.2) < 1e-9);
  // a free foot lower than the planted one may not sink: lift so it touches instead
  assert.ok(Math.abs(M.solvePelvis([{ sole: 0.0, support: 0, w: 1 }, { sole: -0.04, support: 0, w: 0 }]) - 0.04) < 1e-9);
  // half planted: a blend of touching and free
  const half = M.solvePelvis([{ sole: 0.1, support: 0, w: 0.5 }, { sole: 0.2, support: 0, w: 0 }], 0.2);
  assert.ok(Math.abs(half - (0.5 * -0.1 + 0.5 * 0.1)) < 1e-9);
});

test("plant: a drifting capture stays on the floor with Stick on, and floats with it off", () => {
  const t = synthTake({ drift: 0.1 });
  const on = play(t), off = play(t, { stick: false });
  for (let f = 0; f < N; f++) {
    const full = ["l", "r"].filter((lr) => t.plant[lr][f] > 0.999);
    if (full.length) assert.ok(Math.abs(Math.min(on[f].l.h, on[f].r.h)) < 0.005, `feet on the floor at ${f}: ${on[f].l.h} ${on[f].r.h}`);
    // away from a hand-over (a foot easing in or out may lift the hips a touch so it doesn't dip under the floor)
    const easing = ["l", "r"].some((lr) => t.plant[lr][f] > 0 && t.plant[lr][f] < 1);
    if (!easing) for (const lr of full) assert.ok(on[f][lr].h < 0.02, `${lr} planted at ${f}: ${on[f][lr].h}`);
    assert.ok(Math.min(on[f].l.h, on[f].r.h) > -0.005, `no foot under the floor at ${f}`);
  }
  const floatOff = Math.min(off[60].l.h, off[60].r.h), floatOn = Math.min(on[60].l.h, on[60].r.h);
  assert.ok(floatOff > 0.05, `old behaviour floats (${floatOff})`);
  assert.ok(Math.abs(floatOn) < 0.005, `stuck (${floatOn})`);
});

test("plant on the support surface: a foot over a raised platform stands on its top", () => {
  const t = synthTake();
  const support = (x) => (x < 0 ? 0.2 : 0);      // the right foot (-X) is over a 20 cm riser
  const rows = play(t, { support });
  for (const f of [5, 10, 40, 60]) assert.ok(Math.abs(rows[f].r.h) < 0.005 && rows[f].l.h > -0.005, `frame ${f}`);
});

test("jumps keep their arc", () => {
  const t = synthTake({ jump: true });
  const rows = play(t);
  const apex = Math.min(rows[55].l.h, rows[55].r.h);
  assert.ok(apex > 0.15, `airborne at the apex (${apex})`);
  assert.ok(Math.abs(Math.min(rows[45].l.h, rows[45].r.h)) < 0.005 && Math.abs(Math.min(rows[66].l.h, rows[66].r.h)) < 0.01, "down before and after");
});

test("leg IK: a planted foot doesn't slide when the capture's root wobbles", () => {
  const t = synthTake({ jitter: 0.04 });
  const on = play(t), off = play(t, { stick: false });
  const drift = (rows, lr, a, b) => Math.max(...rows.slice(a, b).map((r) => Math.hypot(r[lr].c.x - rows[a][lr].c.x, r[lr].c.z - rows[a][lr].c.z)));
  // inside the right foot's long contact (full weight), it stays put
  const span = [];
  for (let f = 0; f < N; f++) if (t.plant.r[f] === 1 && t.plant.anchor.r[f] === t.plant.anchor.r[10]) span.push(f);
  const a = span[0], b = span.at(-1) + 1;
  assert.ok(b - a > 10);
  assert.ok(drift(off, "r", a, b) > 0.03, "the raw take slides");
  assert.ok(drift(on, "r", a, b) < 0.004, `pinned (${drift(on, "r", a, b)})`);
});
