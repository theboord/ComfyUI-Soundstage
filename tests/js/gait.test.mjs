// Foot-locked locomotion (web/stage/gait.mjs): gait choice by speed, planted feet that never slide, starting and
// stopping on real steps, horse footfalls, seeded dust, and getting on and off a horse.
// node --test tests/js/gait.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { buildHuman, applyPose } from "../../web/stage/humans.mjs";
import { footState, feetOf } from "../../web/stage/mocap.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
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

// ------------------------------------------------------------------ getting on and off a horse
// Measured on the posed body (forward kinematics of a real buildHuman figure through applyMount / applyDismount), in
// the horse's frame, against references the test works out itself: the ride pose's own stirrups at the seat, the clay
// horse's primitives (library.mjs) as an exact signed distance, and the rigged horse's posed mesh.

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};

/** A headless Stage (no WebGL) with these actors. */
function headless(actors, frames = 97) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: FPS }, actors: structuredClone(actors), environment: { set: "studio" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}
/** The clay horse (k = 1) and the rigged one, as the stage builds them, standing at the origin facing +Z. */
let _horses = null;
async function horses() {
  if (_horses) return _horses;
  const one = (simple) => headless([{ id: "h", name: "Horse", kind: "horse", height_m: 1.6, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], ...(simple ? { simple_model: true } : {}) }]);
  const clay = one(true).actorMeshes.get("h");
  const st = one(false);
  let glb;
  for (let i = 0; i < 600; i++) { glb = st.actorMeshes.get("h"); if (glb?.userData.horseShape) break; await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(glb.userData.horseShape, "the rigged horse loaded and was measured");
  return (_horses = { clay, glb, glbSDF: meshSDF(glb) });
}
/** The clay horse (library.mjs, k = 1) as an exact signed distance (m, negative inside): barrel capsule, chest,
 *  hindquarters, withers. */
function claySDF(p) {
  const ell = (c, r) => (Math.hypot((p.x - c[0]) / r[0], (p.y - c[1]) / r[1], (p.z - c[2]) / r[2]) - 1) * Math.min(...r);
  const z = Math.max(-0.45, Math.min(0.45, p.z));
  return Math.min(Math.hypot(p.x / 0.88, p.y - 1.23, p.z - z) - 0.29, ell([0, 1.25, 0.5], [0.258, 0.315, 0.375]),
    ell([0, 1.28, -0.5], [0.3136, 0.32, 0.416]), ell([0, 1.47, 0.4], [0.12, 0.16, 0.26]));
}
/** A horse group's shown, posed meshes as a signed distance: the nearest triangle; inside by ray parity along three
 *  axes (majority), the rays tested only against the triangles in their column. */
function meshSDF(hg) {
  hg.updateMatrixWorld(true);
  const inv = hg.matrixWorld.clone().invert(), tris = [], v = new THREE.Vector3();
  const shown = (o) => { for (let q = o; q && q !== hg.parent; q = q.parent) if (!q.visible) return false; return true; };
  hg.traverse((o) => {
    if (!o.isMesh || !shown(o)) return;
    const idx = o.geometry.index, n = idx ? idx.count : o.geometry.attributes.position.count;
    const P = (i) => { o.getVertexPosition(idx ? idx.getX(i) : i, v); return v.clone().applyMatrix4(o.matrixWorld).applyMatrix4(inv); };
    for (let i = 0; i + 2 < n; i += 3) tris.push(new THREE.Triangle(P(i), P(i + 1), P(i + 2)));
  });
  const boxes = tris.map((t) => new THREE.Box3().setFromPoints([t.a, t.b, t.c]));
  const B = 0.05, axes = [["y", "z", "x"], ["x", "z", "y"], ["x", "y", "z"]];
  const cols = axes.map(([u, w]) => { const m = new Map(); boxes.forEach((b, i) => { for (let a = Math.floor(b.min[u] / B); a <= Math.floor(b.max[u] / B); a++) for (let c = Math.floor(b.min[w] / B); c <= Math.floor(b.max[w] / B); c++) { const key = a * 100003 + c; if (!m.has(key)) m.set(key, []); m.get(key).push(i); } }); return m; });
  const ray = new THREE.Ray(), hit = new THREE.Vector3(), c = new THREE.Vector3();
  const inside = (p) => {
    let votes = 0;
    axes.forEach(([u, w, d], k) => {
      const o = p.clone(); o[u] += 1.3e-4; o[w] += 0.7e-4;
      ray.set(o, new THREE.Vector3(d === "x" ? 1 : 0, d === "y" ? 1 : 0, d === "z" ? 1 : 0));
      let n = 0;
      for (const i of cols[k].get(Math.floor(o[u] / B) * 100003 + Math.floor(o[w] / B)) || []) if (ray.intersectTriangle(tris[i].a, tris[i].b, tris[i].c, false, hit)) n++;
      if (n % 2) votes++;
    });
    return votes >= 2;
  };
  return (p) => {
    let best = Infinity;
    for (let i = 0; i < tris.length; i++) { if (boxes[i].distanceToPoint(p) > best) continue; tris[i].closestPointToPoint(p, c); best = Math.min(best, c.distanceTo(p)); }
    return inside(p) ? -best : best;
  };
}

/**
 * Get on (or off) and measure every frame. Horse at the origin facing yaw. Returns per frame: pelvis, hips, knees,
 * ankles, wrists, shoe corners (horse frame), knee bends, the leg spread, and the state (grip, swap), plus the
 * references: the ride pose's ankles and joints at the seat, and the climb's own key points (R).
 */
function climb({ kind = "man", h = 1.8, mode = "mount", k = 1, yaw = 0, hg = null, fromYaw = null, fps = FPS } = {}) {
  const g = buildHuman(kind, h, {}, mesh);
  const horse = new THREE.Vector3(0.7, 0, -1.3), c = Math.cos(yaw), s = Math.sin(yaw);
  const toW = (v) => new THREE.Vector3(horse.x + v[0] * c + v[2] * s, horse.y + v[1], horse.z - v[0] * s + v[2] * c);
  const toL = (w) => { const x = w.x - horse.x, z = w.z - horse.z; return new THREE.Vector3(x * c - z * s, w.y - horse.y, x * s + z * c); };
  const drop = applyPose(g, "ride", h);
  const seat = toW([0, 1.56 * k, -0.05 * k]), seatPos = new THREE.Vector3(seat.x, seat.y - drop, seat.z);
  const o = { horse, yaw, k, seatPos, h, profile: hg ? Gait.horseProfile(hg, k) : undefined, from: fromYaw != null ? { yaw: fromYaw } : undefined };
  // The ride pose itself at the seat (humans.mjs), the test's own reference.
  g.position.copy(seatPos); g.rotation.set(0, yaw, 0);
  g.updateMatrixWorld(true);
  const J = g.userData.joints, names = Object.keys(J).filter((n) => /hip|knee|shoulder|elbow|wrist|spine|neck|head/.test(n));
  const W = (n) => J[n].getWorldPosition(new THREE.Vector3());
  const ride = Object.fromEntries(names.map((n) => [n, W(n)]));
  const rideAnkle = { l: toL(footState(g, "l").ankle), r: toL(footState(g, "r").ankle) };
  const N = mode === "mount" ? Gait.mountFrames(fps) : Gait.dismountFrames(fps), rows = [];
  for (let f = 0; f <= N; f++) {
    const r = mode === "mount" ? Gait.applyMount(g, f / N, o) : Gait.applyDismount(g, f / N, o);
    g.updateMatrixWorld(true);
    const L = (n) => toL(W(n));
    const corners = (lr) => { const F = feetOf(g)[lr]; F.shoe.updateWorldMatrix(true, false); return F.corners.map((q) => toL(q.clone().applyMatrix4(F.shoe.matrixWorld))); };
    const hl = L("l_hip"), hr = L("r_hip"), kl = L("l_knee"), kr = L("r_knee");
    const tl = kl.clone().sub(hl).normalize(), tr = kr.clone().sub(hr).normalize();
    const q = g.getWorldQuaternion(new THREE.Quaternion()).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw));
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(q), down = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
    const bend = (lr) => 2 * Math.acos(Math.min(1, Math.abs(J[lr + "_knee"].quaternion.w)));
    const asin = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * 180 / Math.PI;
    rows.push({ f, t: f / N, st: r.M || r.D, R: r.R, pel: hl.clone().add(hr).multiplyScalar(0.5), hl, hr, kl, kr,
      al: toL(footState(g, "l").ankle), ar: toL(footState(g, "r").ankle), wl: L("l_wrist"), wr: L("r_wrist"), neck: L("neck"),
      cl: corners("l"), cr: corners("r"), kneeL: bend("l"), kneeR: bend("r"),
      thigh: tl.angleTo(tr) * 180 / Math.PI, side: asin(tl.dot(left)) + asin(-tr.dot(left)), flexL: tl.angleTo(down) * 180 / Math.PI,
      joints: Object.fromEntries(names.map((n) => [n, W(n)])) });
  }
  return { g, o, rows, N, ride, rideAnkle, toL, toW, h };
}
const sole = (cs) => Math.min(...cs.map((p) => p.y));
/** The deepest any leg goes into the horse (m; negative = inside): thigh and shin capsules and the shoes. */
function legDepth(r, lr, sdf, h) {
  const rad = 0.065 * h / 1.8, radS = 0.055 * h / 1.8;
  const hip = lr === "l" ? r.hl : r.hr, knee = lr === "l" ? r.kl : r.kr, ankle = lr === "l" ? r.al : r.ar;
  let m = Infinity;
  for (let i = 0; i <= 8; i++) {
    m = Math.min(m, sdf(hip.clone().lerp(knee, i / 8)) - rad, sdf(knee.clone().lerp(ankle, i / 8)) - radS);
  }
  for (const p of lr === "l" ? r.cl : r.cr) m = Math.min(m, sdf(p));
  return m;
}
const RIDERS = [["woman", 1.55], ["woman", 1.65], ["man", 1.8], ["man", 2.0]];

test("mount and dismount: they start and end on the right poses, and they are pure functions of t", () => {
  for (const [kind, h] of RIDERS) {
    const m = climb({ kind, h }), d = climb({ kind, h, mode: "dismount" });
    // seated at the end of the mount and at the start of the dismount: exactly humans.mjs's ride pose
    for (const [rows, i, what] of [[m.rows, m.rows.length - 1, "mount end"], [d.rows, 0, "dismount start"]]) {
      const worst = Math.max(...Object.entries(rows[i].joints).map(([n, p]) => p.distanceTo(m.ride[n])));
      assert.ok(worst < 0.005, `${kind} ${h} ${what}: ${worst.toFixed(4)} m off the ride pose`);
    }
    // standing at the spot (soles on the ground) at the start of the mount and the end of the dismount
    const spot = Gait.mountSpot(m.g, m.o), sp = m.toL(new THREE.Vector3(spot.x, 0, spot.z));
    for (const r of [m.rows[0], d.rows[d.rows.length - 1]]) {
      assert.ok(Math.hypot(r.pel.x - sp.x, r.pel.z - sp.z) < 0.01, `pelvis on mountSpot (${r.pel.x.toFixed(3)}, ${r.pel.z.toFixed(3)})`);
      assert.ok(Math.abs(sole(r.cl)) < 0.012 && Math.abs(sole(r.cr)) < 0.012, `soles on the ground: ${sole(r.cl).toFixed(3)} ${sole(r.cr).toFixed(3)}`);
      assert.ok(r.kneeL < 0.1 && r.kneeR < 0.1, "standing, legs straight");
    }
  }
  // A pure function of t: scrubbing about (and junk left on the spine) changes nothing.
  const a = climb(), g = a.g, p = (t) => { Gait.applyMount(g, t, a.o); g.updateMatrixWorld(true); return g.userData.joints.l_wrist.getWorldPosition(new THREE.Vector3()); };
  const ref = p(0.55);
  p(0.9); g.userData.joints.spine.rotation.set(0.3, 0.2, 0.1); p(0.1);
  assert.ok(p(0.55).distanceTo(ref) < 1e-6, "same pose at the same t");
});

test("mount: foot in the stirrup from going in to sitting down, the stirrup where the ride pose puts it", () => {
  for (const [kind, h] of RIDERS) {
    const { rows, rideAnkle, h: hh } = climb({ kind, h });
    // In the stirrup: where the ride pose's foot is, by the girth, let down for the climb but never higher than it rides.
    const inStirrup = (r) => Math.abs(r.al.x - rideAnkle.l.x) < 0.06 && Math.abs(r.al.z - rideAnkle.l.z) < 0.08
      && r.al.y <= rideAnkle.l.y + 0.01 && r.al.y > rideAnkle.l.y - 0.3 * hh / 1.8;
    // it goes in early and stays in to the end
    let iIn = rows.length - 1;
    while (iIn > 0 && inStirrup(rows[iIn - 1])) iIn--;
    assert.ok(rows[iIn].t < 0.3, `${kind} ${h}: the foot is in the stirrup only from t ${rows[iIn].t.toFixed(2)}`);
    // and once it has come to rest there it does not wander (it only rises with the leather as they sit)
    let iRest = iIn + 1;
    while (iRest < rows.length && rows[iRest].al.distanceTo(rows[iRest - 1].al) > 0.01) iRest++;
    assert.ok(rows[iRest].t - rows[iIn].t < 0.1, `${kind} ${h}: the foot settles in the stirrup by t ${rows[iRest].t.toFixed(2)}`);
    for (let i = iRest + 1; i < rows.length; i++) {
      const d = rows[i].al.distanceTo(rows[i - 1].al);
      assert.ok(d < 0.02, `${kind} ${h} f${i}: the foot moves in the stirrup ${(d * 100).toFixed(1)} cm/frame`);
    }
    assert.ok(rows[rows.length - 1].al.distanceTo(rideAnkle.l) < 0.01, "ends in the ride stirrup");
    // the shoe sits level in it with the toe forward (toward the horse's shoulder, not into its ribs)
    const r = rows[Math.round((iIn + rows.length) / 2)], toe = r.cl[1].clone().add(r.cl[3]).add(r.cl[5]).add(r.cl[7]).multiplyScalar(0.25).sub(r.cl[0].clone().add(r.cl[2]).add(r.cl[4]).add(r.cl[6]).multiplyScalar(0.25));
    assert.ok(toe.z > 0.6 * toe.length() && Math.abs(toe.y) < 0.35 * toe.length(), `toe forward and level in the stirrup (${toe.x.toFixed(2)}, ${toe.y.toFixed(2)}, ${toe.z.toFixed(2)})`);
  }
});

test("mount: the off leg goes over the croup low (boot clears it, no kick), knee soft, no split", async () => {
  const H = await horses();
  for (const [hg, sdf, label] of [[H.clay, claySDF, "clay"], [H.glb, H.glbSDF, "rigged"]]) for (const [kind, h] of RIDERS) {
    for (const mode of ["mount", "dismount"]) {
      const { rows } = climb({ kind, h, mode, hg });
      const tag = `${label} ${kind} ${h} ${mode}`;
      if (!rows[0].R.ok) continue;   // too short for this horse from the ground: the stage uses its hop (tested below)
      // leg height: the boot never goes above 1.75 m (k = 1) and, where it crosses the croup, it clears it
      const top = Math.max(...rows.map((r) => sole(r.cr)));
      assert.ok(top < 1.8, `${tag}: off boot up to ${top.toFixed(2)} m (a kick)`);
      const over = rows.filter((r) => r.cr.some((p) => Math.abs(p.x) < 0.12 && p.z < -0.3 && p.z > -1.1));
      assert.ok(over.length > 0, `${tag}: the leg goes over the croup`);
      const clear = Math.min(...over.map((r) => Math.min(...r.cr.map(sdf))));
      assert.ok(clear > -0.02, `${tag}: the boot cuts ${(-clear * 100).toFixed(1)} cm into the croup`);
      // knee soft while the foot is up over the horse (a near-straight pendulum, not folded, not flailing)
      for (const r of rows.filter((x) => sole(x.cr) > 1.2)) assert.ok(r.kneeR > 0.1 && r.kneeR < 0.55, `${tag} f${r.f}: off knee ${r.kneeR.toFixed(2)} rad over the horse`);
      // no split: with the off foot up over the horse the legs spread no more than 72 deg sideways and 115 in all; with
      // one foot on the ground no more than 118 in all (a high step, the knee out to the horse's shoulder)
      for (const r of rows) {
        const air = sole(r.cr) > R0(r) - 0.25;
        if (air) assert.ok(r.side < 72 && r.thigh < 115, `${tag} f${r.f}: legs ${r.thigh.toFixed(0)} deg apart, ${r.side.toFixed(0)} sideways, in the air`);
        assert.ok(r.thigh < 118, `${tag} f${r.f}: legs ${r.thigh.toFixed(0)} deg apart`);
        assert.ok(r.flexL < 128, `${tag} f${r.f}: near hip flexed ${r.flexL.toFixed(0)} deg (knee jammed to the chest)`);
      }
    }
  }
});
const R0 = (r) => r.R.back;

test("mount and dismount: no leg goes into the horse deeper than it sits in it (clay and rigged horse)", async () => {
  const H = await horses();
  for (const [hg, sdf, label] of [[H.clay, claySDF, "clay"], [H.glb, H.glbSDF, "rigged"]]) for (const [kind, h] of RIDERS) for (const mode of ["mount", "dismount"]) {
    const { rows } = climb({ kind, h, mode, hg });
    if (!rows[0].R.ok) continue;
    const seated = mode === "mount" ? rows[rows.length - 1] : rows[0];
    const base = Math.min(legDepth(seated, "l", sdf, h), legDepth(seated, "r", sdf, h));
    for (const r of rows.filter((_, i) => i % 2 === 0)) for (const lr of ["l", "r"]) {
      const d = legDepth(r, lr, sdf, h);
      assert.ok(d > base - 0.02, `${label} ${kind} ${h} ${mode} f${r.f}: ${lr} leg ${(-d * 100).toFixed(1)} cm into the horse (seated ${(-base * 100).toFixed(1)})`);
    }
    // the pelvis stays out from the horse until it is above its back
    for (const r of rows) if (r.pel.y < r.R.back && r.st.over === 0 && r.st.sit === 0) assert.ok(Math.abs(r.pel.x) > 0.38, `${label} ${kind} ${h} ${mode} f${r.f}: pelvis ${r.pel.x.toFixed(2)} m from the centreline below the back`);
  }
});

test("mount and dismount: real speeds (no launch, no snap, no fling) and hands on the saddle", () => {
  for (const [kind, h] of RIDERS) for (const mode of ["mount", "dismount"]) for (const k of [0.9, 1, 1.1]) {
    const { rows } = climb({ kind, h, mode, k });
    if (!rows[0].R.ok) continue;
    const tag = `${kind} ${h} ${mode} k${k}`, dt = 1 / FPS;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const v = b.pel.distanceTo(a.pel) / dt;
      assert.ok(v < 2.2, `${tag} f${i}: pelvis ${v.toFixed(2)} m/s`);
      if (i > 1) { const acc = b.pel.clone().sub(a.pel).sub(a.pel.clone().sub(rows[i - 2].pel)).length() / dt / dt; assert.ok(acc < 16, `${tag} f${i}: pelvis ${acc.toFixed(1)} m/s2`); }
      for (const p of ["al", "ar"]) assert.ok(b[p].distanceTo(a[p]) < 0.22 * k, `${tag} f${i}: ${p} ${(b[p].distanceTo(a[p]) / dt).toFixed(1)} m/s`);
      for (const p of ["wl", "wr"]) assert.ok(b[p].distanceTo(a[p]) < 0.25, `${tag} f${i}: ${p} ${(b[p].distanceTo(a[p]) / dt).toFixed(1)} m/s`);
      for (const p of ["kneeL", "kneeR"]) assert.ok(Math.abs(b[p] - a[p]) < 0.5, `${tag} f${i}: ${p} ${(Math.abs(b[p] - a[p]) / dt).toFixed(1)} rad/s`);
    }
    // hands: on the horn (left) and the cantle (right; the off side of the horn while the leg comes over; getting down,
    // the horn just behind the left)
    const seg = (p, A, B) => { const l = new THREE.Line3(new THREE.Vector3(...A), new THREE.Vector3(...B)), c = new THREE.Vector3(); l.closestPointToPoint(p, true, c); return c.distanceTo(p); };
    for (const r of rows.filter((x) => x.st.grip >= 0.999)) {
      assert.ok(seg(r.wl, r.R.horn, r.R.hornLow) < 0.05, `${tag} f${r.f}: left hand ${seg(r.wl, r.R.horn, r.R.hornLow).toFixed(3)} m off the horn`);
      const back = (p) => [p[0], p[1], p[2] - 0.07 * k];
      const dR = r.st.swap <= 0.001 ? seg(r.wr, r.R.cantle, r.R.cantLow) : Math.abs(r.st.swap - 1) < 0.001 ? r.wr.distanceTo(new THREE.Vector3(...r.R.hornOff))
        : r.st.swap >= 1.999 ? seg(r.wr, back(r.R.horn), back(r.R.hornLow)) : 0;
      assert.ok(dR < 0.05, `${tag} f${r.f}: right hand ${dR.toFixed(3)} m off the saddle`);
    }
  }
});

test("mount: the turn to the saddle is stepped (one foot planted, no skating)", () => {
  const { rows } = climb({ fromYaw: 0.4 });   // arriving facing well off the saddle
  for (let i = 1; i < rows.length && rows[i].t < 0.14; i++) {
    for (const [lr, c] of [["l", "cl"], ["r", "cr"]]) {
      const a = rows[i - 1][c], b = rows[i][c], down = sole(a) < 0.01 && sole(b) < 0.01;
      if (down) assert.ok(Math.min(...a.map((p, j) => Math.hypot(p.x - b[j].x, p.z - b[j].z))) < 0.01, `f${i}: ${lr} foot slides on the ground`);
    }
    assert.ok(sole(rows[i].cl) < 0.01 || sole(rows[i].cr) < 0.01, `f${i}: a foot on the ground`);
  }
});

test("a rider too short to get up on this horse from the ground is flagged (the stage hops them on instead)", () => {
  const child = climb({ kind: "child", h: 1.2 });
  assert.equal(child.rows[0].R.ok, false);
  for (const [kind, h] of [["woman", 1.65], ["man", 1.8], ["man", 2.0]]) for (const k of [0.9, 1, 1.1]) assert.equal(climb({ kind, h, k }).rows[0].R.ok, true, `${kind} ${h} on k ${k}`);
});

test("stage: a timed mount walks them to the stirrup, then climbs; never slides or jumps", async () => {
  const fps = FPS, N = Gait.mountFrames(fps);
  // The rider runs in from 5 m off on the OFF side and is keyed to stop 2 m short; seated at frame 280.
  const st = headless([
    { id: "h", name: "Horse", kind: "horse", height_m: 1.6, simple_model: true, position: [0, 0, 0], rotation_deg: 0, keys: [{ frame: 0, position: [0, 0, 0] }] },
    { id: "m", name: "Man", kind: "man", height_m: 1.8, position: [-5, 0, 3], keys: [{ frame: 0, position: [-5, 0, 3] }, { frame: 30, position: [-2, 0, 2] }], mount_id: "h", mount_at: 280, pose: "ride" },
  ], 300);
  const g = st.actorMeshes.get("m"), hg = st.actorMeshes.get("h"), a = st.state.actors[1];
  const W = st._climbWindow(a, st.state.actors[0], hg, g);
  assert.ok(!W.hop && W.S === 280 - N && W.E === 280, `climb ${W.S}..${W.E}`);
  assert.ok(W.fA >= 0 && W.fA < W.S, "walks there first");
  // the walk goes round the horse's head, never through it
  for (let f = W.fA; f < W.S; f++) { const p = W.pos[f]; assert.ok(claySDF(new THREE.Vector3(p[0], 1.0, p[2])) > 0.15, `f${f}: walks through the horse`); }
  let prev = null;
  for (let f = 0; f <= 290; f++) {
    st.setFrame(f);
    g.updateMatrixWorld(true);
    const hl = g.userData.joints.l_hip.getWorldPosition(new THREE.Vector3()), hr = g.userData.joints.r_hip.getWorldPosition(new THREE.Vector3());
    const pel = hl.add(hr).multiplyScalar(0.5);
    if (prev) assert.ok(pel.distanceTo(prev) < 0.2, `f${f}: the body jumps ${pel.distanceTo(prev).toFixed(2)} m`);
    prev = pel;
  }
  // the near foot ends in the ride stirrup: the stage's seated rider and the climb's last frame agree
  st.setFrame(W.E - 1); g.updateMatrixWorld(true);
  const a1 = footState(g, "l").ankle.clone();
  st.setFrame(W.E); g.updateMatrixWorld(true);
  assert.ok(footState(g, "l").ankle.distanceTo(a1) < 0.03, "no pop into the saddle");
});

test("stage: no climb onto a horse keyed to leave before they could be up, or one too tall for them (the quick hop)", () => {
  const horse = (keys) => ({ id: "h", name: "Horse", kind: "horse", height_m: 1.6, simple_model: true, position: [0, 0, 0], keys });
  const leaves = headless([horse([{ frame: 0, position: [0, 0, 0] }, { frame: 40, position: [0, 0, 0] }, { frame: 60, position: [0, 0, -8] }]),
    { id: "m", name: "Man", kind: "man", height_m: 1.8, position: [2, 0, 0], keys: [{ frame: 0, position: [2, 0, 0] }], mount_id: "h", mount_at: 36, pose: "ride" }], 97);
  const W = leaves._climbWindow(leaves.state.actors[1], leaves.state.actors[0], leaves.actorMeshes.get("h"), leaves.actorMeshes.get("m"));
  assert.ok(W.hop && /moves off/.test(W.why), JSON.stringify(W));
  const kid = headless([horse([{ frame: 0, position: [0, 0, 0] }]),
    { id: "c", name: "Kid", kind: "child", height_m: 1.2, position: [2, 0, 0], keys: [{ frame: 0, position: [2, 0, 0] }], mount_id: "h", mount_at: 150, pose: "ride" }], 200);
  assert.ok(kid._climbWindow(kid.state.actors[1], kid.state.actors[0], kid.actorMeshes.get("h"), kid.actorMeshes.get("c")).hop);
});
