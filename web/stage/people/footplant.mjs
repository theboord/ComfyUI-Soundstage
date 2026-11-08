// Foot grounding for lifelike people: the stance foot is planted on the ground under it, with two-bone leg IK on the
// avatar's own skeleton. Measured before this (2026-11-07, try-it demo, real GPU render): planted feet slid 5-9 cm/s,
// one idle foot hovered 3-5 mm, the idle <-> walk crossfade sank the feet up to 26 mm into the floor, and a turn on
// the spot swivelled the whole body over sliding feet. All of it came from the Rocketbox clips themselves.
//
// How it works (people/avatars.mjs avatarsAt calls it after the clips are posed):
//   1. footRig(model, mesh), once per avatar in the bind pose: per foot the thigh / calf / foot / toe bones, a few
//      dozen SOLE points (the lowest vertex of each patch of the shoe, plus the shoe's lowest point toward every way
//      the foot tips, out to the toe cap and the heel's back; real skinned vertices, so the shoe's own thickness
//      counts, not the bones: the toe bone sits 1.5-7 mm above the sole) and the sole's up / forward axes in the foot
//      bone (on the Rocketbox Biped forward is the bone's local +Y, up its local -X).
//   2. clipFloors(...), once per avatar: each clip's own standing sole height (the median of the lowest sole over the
//      loop), so the body offset follows the clip that plays (walk and run sat up to 2 cm off the idle's floor).
//   3. planFeet(...), once per person per shot (cached like the gait table): the clip is played frame by frame and a
//      foot is in stance while its sole is near the body's OWN footing and its contact (the slowest sole point near
//      the lowest, the body's turn and climb taken out) is slow; the limits widen with the body's speed, so runs plant.
//      Each planted frame keeps the clip's own roll (heel strike to toe off) laid on the ground's slope, with the
//      touching patch pinned from the stance's middle outward, lowered until the sole point nearest the ground under
//      it touches (edges and steps: the foot level on the highest ground under it). A frame the leg can't reach with
//      at most 2 cm of pelvis drop (6 cm when it is the only foot down) or far from the body's footing is not planted.
//      A long stance whose foot would twist or drift (a turn on the spot) is broken into real steps, one foot at a
//      time, quicker in a fast turn, the planted foot turning on its ball with the heel up. A foot dragged along the
//      floor between two plants is a lifted step. Ramps blend in and out of every plant (shorter at a run), and
//      between plants the foot moves up or down by the ground (dY), so it follows the terrain from plant to plant.
//   4. groundFeet(skin, plan, f), per frame: the pelvis comes down when a planted foot is out of the leg's reach,
//      then two-bone IK (thigh, calf; the knee stays on the side the clip bends it to) puts each foot on its target;
//      a foot not planted is kept clear of the ground under every sole point (plan.ground: stairs, kerbs, bumps), the
//      more so the further it moves from its plant, so a sole only ever touches where it plants.
// Third pass (2026-11-08): walking, one foot is always down (steps wait for the other foot, land early, or the other
// waits); the clearance counts only ground the leg could step onto and never folds the leg (T.minLeg), and a plant is
// refused too high as well as too low; a sprint's 1-frame touch-down is kept and not lifted.
// Everything is a pure function of the keys and the frame: the plan is built from the whole shot at once, and a
// frame reads only the plan and the clip pose at that frame, so scrubbing in any order gives the same feet.
// Nothing here reads the clay figure: it works on whatever skeleton drives the visible body.
import * as THREE from "../../vendor/three.module.min.mjs";

/** Rocketbox Biped leg bones (FBXLoader turns the spaces into underscores). */
export const LEG_BONES = {
  l: { thigh: "Bip01_L_Thigh", calf: "Bip01_L_Calf", foot: "Bip01_L_Foot", toe: "Bip01_L_Toe0" },
  r: { thigh: "Bip01_R_Thigh", calf: "Bip01_R_Calf", foot: "Bip01_R_Foot", toe: "Bip01_R_Toe0" },
};
export const PELVIS_ROOT = "Bip01";
const SIDES = ["l", "r"];
const UP = new THREE.Vector3(0, 1, 0);

/** Tunables, in metres and seconds for a 1.8 m person (scaled by height). */
export const FOOT = {
  hIn: 0.025, hOut: 0.04,        // sole height over the ground to start / keep a stance
  vIn: 0.3, vOut: 0.45,          // foot bone speed (m/s) to start / keep a stance
  minStance: 3, maxGap: 1,       // frames: shorter stances are dropped, shorter lifts are closed
  minStanceFast: 1, runSpeed: 2.6, // ... but a stance of 1 frame is kept at this body speed (m/s) and up (a sprint's touch-down)
  vFast: 0.45, sprint: 6,        // ... where the contact may move this share of the body's speed (from T.vRun at runSpeed to this at sprint m/s)
  walkMax: 2.0,                  // m/s: under this body speed one foot is always down (no flight phase)
  vRun: 0.15,                    // the contact speed limits widen by this per m/s of body speed (a run's roll)
  ramp: 0.125,                   // s: blend into / out of a plant
  liftPerM: 1.5, liftMax: 0.03,  // a moving foot not planted clears the ground by this much per m it is from its plant (at most
  liftSpeed: 0.3,                // liftMax), in full at this foot speed (m/s): a sole only touches where it plants, it never
                                 // slides along the ground into it or out of it; a foot at rest is not held off the ground
  stepDist: 0.2, stepYaw: 0.7,   // a planted foot drifting this far (m) or twisting this much (rad) is one unit
  stepTime: 0.3, stepLift: 0.05, // a turn step: duration (s), lift (m)
  stepMin: 4, stepTwist: 0.6,    // frames, rad: the quickest step; how far the body may turn during one
  pivot: 0.5, pivotRate: 0.07,   // a planted foot turns this share of the body's turn (on its ball), at most this (rad) a frame
  heelFrom: 0.02, heelPerRad: 2.5, heelMax: 0.3, // a planted foot turned this far (rad) from its anchor lifts its heel (rad / rad, at most)
  far: 0.3,                      // a stance whose ground is this far from the body's height is not planted
  minLeg: 0.45,                  // of the leg's length: a target closer to the hip than this (the leg folded up) is refused
  stillSpeed: 0.15,              // m/s: a body slower than this stands on its own footing, not on a top beside it
  edge: 0.02,                    // the ground under one sole is off its plane by more than this: an edge or a step (the foot sits flat on the top)
  dropOK: 0.02,                  // a planted frame the leg can reach only with the hips down more than this is not planted ...
  supportDrop: 0.06,             // ... unless it's the only foot down, up to this much (a short dip, not both feet in the air)
  maxDrop: 0.12,                 // the pelvis comes down at most this much
  reach: 0.999,                  // of the leg's length, before the pelvis comes down
};

const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const smooth01 = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

/**
 * Per avatar, in the bind pose (the template as loaded): the leg bones and the sole vertices of each foot. null when
 * the skeleton has no Biped legs (a stub, another rig): such a body is not grounded.
 */
export function footRig(model, mesh, { bones = LEG_BONES } = {}) {
  if (!mesh?.isSkinnedMesh || !mesh.skeleton) return null;
  model.updateMatrixWorld(true);
  const list = mesh.skeleton.bones, idx = (n) => list.findIndex((b) => b.name === n);
  const geo = mesh.geometry, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, n = geo.attributes.position?.count || 0;
  if (!si || !sw || !n) return null;
  const out = { bones, root: PELVIS_ROOT };
  const v = new THREE.Vector3();
  for (const lr of SIDES) {
    const B = bones[lr];
    if (!["thigh", "calf", "foot", "toe"].every((k) => model.getObjectByName(B[k]))) return null;
    const fi = idx(B.foot), ti = idx(B.toe);
    if (fi < 0) return null;
    const foot = model.getObjectByName(B.foot);
    const fw = foot.getWorldPosition(new THREE.Vector3()), fq = foot.getWorldQuaternion(new THREE.Quaternion());
    const cand = [];
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) { const b = si.getComponent(i, k); if (b === fi || b === ti) w += sw.getComponent(i, k); }
      if (w < 0.95) continue;   // only vertices the foot and toe carry alone: the leg IK can't move them off the plan
      mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
      cand.push([i, v.x, v.y, v.z]);
    }
    if (cand.length < 6) return null;
    const minY = Math.min(...cand.map((c) => c[2]));
    const low = cand.filter((c) => c[2] < minY + 0.45 * (fw.y - minY));
    const zs = low.map((c) => c[3]), xs = low.map((c) => c[1]);
    const z0 = Math.min(...zs), z1 = Math.max(...zs), x0 = Math.min(...xs), x1 = Math.max(...xs);
    const bins = new Map();
    for (const c of low) {
      const bz = Math.min(9, Math.floor(10 * (c[3] - z0) / Math.max(1e-6, z1 - z0))), bx = Math.min(2, Math.floor(3 * (c[1] - x0) / Math.max(1e-6, x1 - x0)));
      const k = bz * 3 + bx, b = bins.get(k);
      if (!b || c[2] < b[2]) bins.set(k, c);
    }
    // ... and the shoe's lowest point for every way the foot tips (heel strike pitches the toe up 30-40 degrees, toe
    // off the heel; a roll to the side): the support points of the shoe toward down-tilted directions, so a pitched
    // foot's heel rim or toe cap is measured too (the flat patches alone let a pitched heel go 1.2 cm into the floor)
    // (out to the front of the toe cap and the back of the heel: a swing that meets a stair's riser is caught there)
    for (let pd = -88; pd <= 88; pd += 8) for (let rd = -32; rd <= 32; rd += 16) {
      const p = pd * Math.PI / 180, r = rd * Math.PI / 180;
      const dx = Math.sin(r), dy = -Math.cos(p) * Math.cos(r), dz = Math.sin(p) * Math.cos(r);
      let best = null, bv = -Infinity;
      for (const c of cand) { const s = c[1] * dx + c[2] * dy + c[3] * dz; if (s > bv) { bv = s; best = c; } }
      if (best) bins.set(`d${pd},${rd}`, best);
    }
    const sole = [...new Map([...bins.values()].map((c) => [c[0], c])).values()].sort((a, b) => a[0] - b[0]);
    const inv = fq.clone().invert();
    out[lr] = {
      sole: Int32Array.from(sole.map((c) => c[0])),
      // the sole's up axis and the foot's forward, in the foot bone's own frame, from the bind pose (it stands flat,
      // facing world +Z). On the Rocketbox Biped forward comes out as the bone's local +Y and up as its local -X, NOT
      // its Z: anything that walks the sole heel to toe must go along fwd and up, never a fixed local axis.
      up: UP.clone().applyQuaternion(inv).normalize(),
      fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(inv).normalize(),
      heelZ: z0, toeZ: z1, ankleY: fw.y - minY,
    };
  }
  return out;
}

/** The skinned world positions of a foot's sole vertices (bones' world matrices must be current). out: Float64Array(3k). */
export function solePoints(mesh, side, out = new Float64Array(3 * side.sole.length)) {
  const v = _v0;
  for (let k = 0; k < side.sole.length; k++) {
    mesh.getVertexPosition(side.sole[k], v).applyMatrix4(mesh.matrixWorld);
    out[3 * k] = v.x; out[3 * k + 1] = v.y; out[3 * k + 2] = v.z;
  }
  return out;
}
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();

/** [[a, b], [b, c], ...] of a list. */
const pairs = (xs) => xs.slice(1).map((x, i) => [xs[i], x]);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * Each clip's own standing sole height (avatar units, the model at the origin, unscaled): the median over one loop of
 * the lowest sole vertex of either foot. The body is lowered by the blend of these by the clip weights, so the walk
 * and the run stand on the floor too (the idle's floor alone left the run's planted foot 2 cm under it).
 */
export function clipFloors(template, clips, rig, { samples = 24 } = {}) {
  if (!rig) return null;
  const m = cloneSkinned(template);
  let mesh = null;
  m.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  const out = {};
  for (const [k, c] of Object.entries(clips)) {
    if (!c?.clip) continue;
    const mixer = new THREE.AnimationMixer(m);
    const act = mixer.clipAction(c.clip);
    act.play();
    const lows = [];
    for (let s = 0; s < samples; s++) {
      mixer.setTime((s / samples) * c.clip.duration);
      m.updateMatrixWorld(true);
      let lo = Infinity;
      for (const lr of SIDES) { const p = solePoints(mesh, rig[lr]); for (let i = 1; i < p.length; i += 3) lo = Math.min(lo, p[i]); }
      lows.push(lo);
    }
    out[k] = median(lows);
    mixer.stopAllAction();
    mixer.uncacheRoot(m);
  }
  return out;
}
let cloneSkinned = (o) => o.clone(true);
/** avatars.mjs passes SkeletonUtils.clone (a plain clone would share the template's bones). */
export function setCloner(fn) { cloneSkinned = fn; }

/** The body's floor offset (avatar units) for these clip weights: the clips' own floors blended, else the idle's. */
export function floorFor(kit, w) {
  const F = kit?.floors, base = kit?.floor || 0;
  if (!F || !w) return base;
  let s = 0, t = 0;
  for (const k in w) { if (!(w[k] > 0)) continue; s += w[k] * (F[k] ?? base); t += w[k]; }
  return t > 0 ? s / t : base;
}

/** Runs of true at least minLen long; gaps of false up to maxGap between two runs closed (cleaned copy). */
export function cleanRuns(flags, minLen = 3, maxGap = 1) {
  const f = Array.from(flags, Boolean), n = f.length;
  for (let i = 0; i < n;) {
    if (f[i]) { i++; continue; }
    let j = i; while (j < n && !f[j]) j++;
    if (i > 0 && j < n && j - i <= maxGap) for (let q = i; q < j; q++) f[q] = true;
    i = j;
  }
  for (let i = 0; i < n;) {
    if (!f[i]) { i++; continue; }
    let j = i; while (j < n && f[j]) j++;
    if (j - i < minLen) for (let q = i; q < j; q++) f[q] = false;
    i = j;
  }
  return f;
}

/** [start, end) of every run of true. */
export function runsOf(flags) {
  const out = [];
  for (let i = 0; i < flags.length;) {
    if (!flags[i]) { i++; continue; }
    let j = i; while (j < flags.length && flags[j]) j++;
    out.push([i, j]); i = j;
  }
  return out;
}

/**
 * Stance flags from sole heights (m over the body's own footing) and contact speeds (m/s, the slowest low sole
 * vertex), with hysteresis; skip[f] is never one. opt.vAdd[f] widens the speed limits (a running foot rolls over its
 * contact faster than a walking one), opt.fast[f] lets a stance be T.minStanceFast frames long (a sprint's foot is
 * down for 2-3 frames at 24 fps).
 */
export function detectStance(h, v, skip, k = 1, T = FOOT, { vAdd = null, fast = null } = {}) {
  const n = h.length, f = new Array(n).fill(false);
  let on = false;
  for (let i = 0; i < n; i++) {
    if (skip?.[i]) { on = false; continue; }
    const va = vAdd?.[i] || 0;
    on = on ? h[i] < T.hOut * k && v[i] < T.vOut * k + va : h[i] < T.hIn * k && v[i] < T.vIn * k + va;
    f[i] = on;
  }
  const short = Math.min(T.minStance, T.minStanceFast ?? T.minStance);
  const c = cleanRuns(f, short, T.maxGap);
  for (const [i, j] of runsOf(c)) {
    if (j - i >= T.minStance) continue;
    let ok = !!fast;
    for (let q = i; q < j && ok; q++) ok = !!fast[q];
    if (!ok) for (let q = i; q < j; q++) c[q] = false;
  }
  for (let i = 0; i < n; i++) if (skip?.[i]) c[i] = false;
  return c;
}

/**
 * Break long stances into segments, each locked to its own anchor frame, with a step between them, when the foot would
 * drift or twist too far under a body that turns or creeps (drift[f] = cumulative drift units of the clip's own foot
 * in the world). Both feet together: one foot steps at a time, and only while the other is planted. A stance whose
 * whole drift stays under 1 unit (every walk and run stance) is one segment anchored at its middle frame.
 * Returns {l: [{from, to, anchor}], r: [...], steps: {l: [{from, to}], r: [...]}} (from inclusive, to exclusive).
 */
export function scheduleSteps(stance, drift, stepFrames) {
  const SF = typeof stepFrames === "function" ? stepFrames : () => stepFrames;   // per frame: quicker steps in a fast turn
  const segs = { l: [], r: [] }, steps = { l: [], r: [] };
  const firstReach = (lr, from, end, units) => { for (let f = from; f < end; f++) if (drift[lr][f] - drift[lr][from] >= units) return f; return end - 1; };
  const runs = { l: runsOf(stance.l), r: runsOf(stance.r) };
  const long = { l: [], r: [] };
  for (const lr of SIDES) for (const [i, j] of runs[lr]) {
    if (drift[lr][j - 1] - drift[lr][i] < 1 || j - i < 2 * SF(i) + 4) segs[lr].push({ from: i, to: j, anchor: (i + j - 1) >> 1 });
    else long[lr].push([i, j]);
  }
  if (!long.l.length && !long.r.length) return { segs, steps };
  const n = stance.l.length;
  const cur = { l: null, r: null }, busyUntil = { l: -1, r: -1 };
  const runAt = (lr, f) => long[lr].find(([i, j]) => f >= i && f < j) || null;
  for (let f = 0; f < n; f++) {
    for (const lr of SIDES) {
      const o = lr === "l" ? "r" : "l", run = runAt(lr, f);
      if (!run) { if (cur[lr]) { cur[lr].to = f; segs[lr].push(cur[lr]); cur[lr] = null; } continue; }
      if (!cur[lr] && f === run[0]) cur[lr] = { from: f, to: run[1], anchor: firstReach(lr, f, run[1], 0.5) };
      if (!cur[lr] || f < busyUntil[lr]) continue;
      const end = run[1], stepFrames = SF(f);
      if (drift[lr][f] - drift[lr][cur[lr].anchor] < 0.5 || f + stepFrames + 2 >= end) continue;
      // the other foot must be planted for the whole step, and not stepping itself
      if (busyUntil[o] > f || !stance[o][f] || !stance[o][Math.min(n - 1, f + stepFrames)]) continue;
      cur[lr].to = f; segs[lr].push(cur[lr]);
      const land = f + stepFrames;
      steps[lr].push({ from: f, to: land });
      cur[lr] = { from: land, to: end, anchor: Math.max(land, firstReach(lr, land, end, 0.5)) };
      busyUntil[lr] = land;
    }
  }
  for (const lr of SIDES) if (cur[lr]) segs[lr].push(cur[lr]);
  for (const lr of SIDES) segs[lr].sort((a, b) => a.from - b.from);
  return { segs, steps };
}

/** The 0..1 blend weight of a frame `d` frames outside a plant (d = 1 is the frame next to it), over `ramp` frames. */
export const rampWeight = (d, ramp) => (d <= 0 ? 1 : d > ramp ? 0 : smooth01(1 - d / (ramp + 1)));

/**
 * The foot plan of one person for one shot. Poses the avatar's clip at every frame (poseRaw(f) places the body and
 * plays the clip; it returns false for a frame that is not grounded: in the air, lifted, ...), and reads per foot the
 * sole and the ground. ground(x, z, f) = the walkable height under (x, z) at frame f; baseY(f) = the body's height.
 * Returns {n, state: {l: Uint8Array, r}, w: {l: Float32Array, r}, pos: {l: Float64Array(3n)}, quat: {l: Float64Array(4n)},
 * gy: {l: Float64Array(n)}, segs, steps} or null (no rig). state: 0 free, 1 planted, 2 stepping, 3 blending in / out.
 */
export function planFeet({ n, fps = 24, heightM = 1.8, rig, mesh, bones, holder = null, poseRaw, ground, baseY = () => 0, T = FOOT }) {
  if (!rig || !mesh || !n) return null;
  // the shortest stance is a time (T.minStance frames at 24 fps): at 12 fps a 2-frame plant is as long, and dropping it
  // left a run up a 20 degree hill with no foot down for 6 frames (half a second)
  if (fps !== 24) T = { ...T, minStance: Math.max(T.minStanceFast ?? 1, Math.round(T.minStance * fps / 24)) };
  const k = Math.max(0.4, Math.min(1.6, heightM / 1.8));
  const raw = {}, skip = new Array(n).fill(false);
  for (const lr of SIDES) {
    const K = rig[lr].sole.length;
    raw[lr] = { pos: new Float64Array(3 * n), quat: new Float64Array(4 * n), scale: new Float64Array(n), loc: new Float64Array(3 * K * n), h: new Float64Array(n), gy: new Float64Array(n), yaw: new Float64Array(n), low: new Float64Array(3 * n),
      hip: new Float64Array(3 * n), leg: new Float64Array(n), world: new Float64Array(3 * K * n), hb: new Float64Array(n), base: new Float64Array(n) };
  }
  const pts = {};
  raw.root = new Float64Array(3 * n); raw.yaw = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    if (poseRaw(f) === false) skip[f] = true;
    if (bones.root) { bones.root.getWorldPosition(_v0); raw.root.set([_v0.x, _v0.y, _v0.z], 3 * f); }
    // the body's heading (the holder the clip plays in; the pelvis sways)
    const yo = holder || bones.root;
    if (yo) { _v0.set(0, 0, 1).applyQuaternion(yo.getWorldQuaternion(_q1)); raw.yaw[f] = Math.atan2(_v0.x, _v0.z); }
    for (const lr of SIDES) {
      const R = raw[lr], side = rig[lr], foot = bones[lr].foot;
      // the hip and the leg's length as posed (the reach guard: a planted target the leg can't reach is refused)
      bones[lr].thigh.getWorldPosition(_v0); bones[lr].calf.getWorldPosition(_v1); foot.getWorldPosition(_v2);
      R.hip.set([_v0.x, _v0.y, _v0.z], 3 * f); R.leg[f] = _v0.distanceTo(_v1) + _v1.distanceTo(_v2);
      foot.matrixWorld.decompose(_v1, _q0, _v2);
      R.pos.set([_v1.x, _v1.y, _v1.z], 3 * f); R.quat.set([_q0.x, _q0.y, _q0.z, _q0.w], 4 * f); R.scale[f] = _v2.x;
      const p = (pts[lr] = solePoints(mesh, side, pts[lr]));
      _m0.copy(foot.matrixWorld).invert();
      let lo = Infinity, li = 0;
      for (let q = 0; q < side.sole.length; q++) {
        _v0.set(p[3 * q], p[3 * q + 1], p[3 * q + 2]);
        if (_v0.y < lo) { lo = _v0.y; li = q; }
        _v0.applyMatrix4(_m0);
        R.loc.set([_v0.x, _v0.y, _v0.z], 3 * (side.sole.length * f + q));
      }
      R.low.set([p[3 * li], p[3 * li + 1], p[3 * li + 2]], 3 * f);
      R.gy[f] = ground(_v1.x, _v1.z, f);
      R.h[f] = lo - ground(p[3 * li], p[3 * li + 2], f);
      // the sole over the body's OWN footing (the clip's contact, whatever the ground under it does: a step, a bump)
      R.base[f] = baseY(f); R.hb[f] = lo - R.base[f];
      R.world.set(p, 3 * side.sole.length * f);
      _v3.copy(side.fwd).applyQuaternion(_q0);
      R.yaw[f] = Math.atan2(_v3.x, _v3.z);
    }
  }
  // the body's ground speed (the pelvis over about a quarter second), for the run's wider limits
  const body = new Float64Array(n), rootP = raw.root;
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 3), b = Math.min(n - 1, f + 3);
    body[f] = b > a ? Math.hypot(rootP[3 * b] - rootP[3 * a], rootP[3 * b + 2] - rootP[3 * a + 2]) * fps / (b - a) : 0;
  }
  // the slope of the ground at the body's footing (per frame, x and z): the smaller of the one-sided differences 10 cm
  // either way (0 when they disagree in sign), at most 35 degrees, so a ledge or a platform beside the body is no slope
  // but a hill is. A foot at rest is kept clear of its own footing laid along this slope (groundFeet), not of a level
  // one: at the end of a shot up a 10 degree hill the front foot stood 4.7 cm into it
  const slope = new Float64Array(2 * n), sd = 0.1 * k;
  for (let f = 0; f < n; f++) {
    if (skip[f]) continue;
    const x = rootP[3 * f], z = rootP[3 * f + 2], g0 = ground(x, z, f);
    const mm = (a, b) => (a * b <= 0 ? 0 : Math.sign(a) * Math.min(Math.abs(a), Math.abs(b), 0.7));
    slope[2 * f] = mm((ground(x + sd, z, f) - g0) / sd, (g0 - ground(x - sd, z, f)) / sd);
    slope[2 * f + 1] = mm((ground(x, z + sd, f) - g0) / sd, (g0 - ground(x, z - sd, f)) / sd);
  }
  // (at a run's speed the contact may move up to T.vFast of the body's speed: a sprint's foot rolls over its contact
  // at 2-4 m/s while the swing moves at twice the body's speed; it is down a frame or two, T.minStanceFast)
  const fast = Array.from(body, (s) => s >= T.runSpeed);
  const vFrac = Array.from(body, (s) => T.vRun + (T.vFast - T.vRun) * smooth01((s - T.runSpeed) / (T.sprint - T.runSpeed)));
  const vAdd = Array.from(body, (s, f) => (fast[f] ? Math.max(T.vRun * s, vFrac[f] * s - T.vIn * k) : T.vRun * s));
  // contact speeds (the slowest sole vertex within 1 cm of the lowest: the point the foot rolls over, heel, ball or
  // toe; the ankle bone moves at 2 m/s through a run's stance) and drift units (the clip's own foot moving or turning)
  const stance = {}, drift = {}, contact = {};
  for (const lr of SIDES) {
    const R = raw[lr], v = new Float64Array(n), d = new Float64Array(n), K = rig[lr].sole.length, W = R.world;
    for (let f = 0; f < n; f++) {
      const a = Math.max(0, f - 1), b = Math.min(n - 1, f + 1);
      let lo = Infinity, best = Infinity;
      for (let q = 0; q < K; q++) lo = Math.min(lo, W[3 * (K * f + q) + 1]);
      // with the body's own turn taken out (each point turned about the pelvis into frame f's heading): a body
      // turning on the spot swings an idle foot round at 0.6 m/s, and that foot is still standing
      const turn = (g, i) => {
        const t = wrap(raw.yaw[f] - raw.yaw[g]), c = Math.cos(t), sn = Math.sin(t), cx = raw.root[3 * g], cz = raw.root[3 * g + 2];
        const x = W[i] - cx, z = W[i + 2] - cz;
        return [cx + c * x + sn * z, W[i + 1] - R.base[g], cz - sn * x + c * z];   // over the body's own footing: going up a stair or a ramp is not the foot moving
      };
      if (b > a) for (let q = 0; q < K; q++) {
        if (W[3 * (K * f + q) + 1] > lo + 0.01 * k) continue;
        const A = turn(a, 3 * (K * a + q)), B = turn(b, 3 * (K * b + q));
        best = Math.min(best, Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) * fps / (b - a));
      }
      v[f] = Number.isFinite(best) ? best : 0;
      if (f) {
        const dy = Math.atan2(Math.sin(R.yaw[f] - R.yaw[f - 1]), Math.cos(R.yaw[f] - R.yaw[f - 1]));
        d[f] = d[f - 1] + Math.hypot(R.pos[3 * f] - R.pos[3 * f - 3], R.pos[3 * f + 2] - R.pos[3 * f - 1]) / (T.stepDist * k) + Math.abs(dy) / T.stepYaw;
      }
    }
    // stance from the sole over the body's own footing, not over the ground under it: the clip's own contact. On a
    // step, a kerb or a bump the ground under the foot is off the footing, and that ground decides where it plants.
    stance[lr] = detectStance(R.hb, v, skip, k, T, { vAdd, fast });
    // (a stance on ground far from the body's own height, a foot over a platform's edge, is refused frame by frame
    // below, with the planted sole's real height, and so is a target the leg can't reach)
    drift[lr] = d;
    // the clip's own touch-downs at a run's speed, stance or not: the sole at the body's footing and its contact slow (a sprint's foot
    // is down for one frame or two, too short to plant; the swing clearance must not hold it 3 cm up there)
    const ct = (contact[lr] = new Uint8Array(n));
    // (slow: under the stance limit, or at a run's speed under vFrac of the body's speed; a swinging foot moves at
    // twice the body's)
    for (let f = 0; f < n; f++) ct[f] = fast[f] && !skip[f] && R.hb[f] < T.hOut * k && v[f] < Math.max(T.vOut * k + vAdd[f], vFrac[f] * body[f]) ? 1 : 0;
  }
  // a step lasts T.stepTime, quicker in a fast turn (the body turning T.stepTwist while one foot is up): a 360 in 1 s
  // steps in 4 frames instead of 7, so the planted foot never twists far before the other comes down
  const base = Math.max(4, Math.round(T.stepTime * fps)), yawRate = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 3), b = Math.min(n - 1, f + 3);
    yawRate[f] = b > a ? Math.abs(wrap(raw.yaw[b] - raw.yaw[a])) / (b - a) : 0;
  }
  const stepFrames = (f) => Math.max(T.stepMin, Math.min(base, Math.round(T.stepTwist / Math.max(1e-6, yawRate[f]))));
  const { segs, steps } = scheduleSteps(stance, drift, stepFrames);
  const ramp = Math.max(1, Math.round(T.ramp * fps));
  const plan = { n, k, fps, state: {}, w: {}, pos: {}, quat: {}, gy: {}, dY: {}, near: {}, liftK: {}, segs, steps, skip, ground, base: raw.l.base, contact, slope, rootXZ: rootP };
  const out = {};
  for (const lr of SIDES) {
    const R = raw[lr], side = rig[lr], K = side.sole.length;
    const st = new Uint8Array(n), w = new Float32Array(n), P = new Float64Array(3 * n), Q = new Float64Array(4 * n), needs = new Float64Array(n), G = new Float64Array(n).fill(NaN);
    out[lr] = { st, w, P, Q, needs, G };
    // planted frames: each segment's anchor pose, aligned to the ground's slope, lowered onto it frame by frame
    for (const s of segs[lr]) {
      const a = s.anchor;
      _v1.fromArray(R.pos, 3 * a); _q0.fromArray(R.quat, 4 * a);
      const sc = R.scale[a];
      _m0.compose(_v1, _q0, _v2.setScalar(sc));
      const loc = (q) => _v0.fromArray(R.loc, 3 * (K * a + q)).applyMatrix4(_m0).clone();
      // the ground plane under the anchored foot, from three sole points found along the foot's OWN axes (heel = least
      // forward, toe = most forward, the side = furthest across): rig fwd / up, never the bone's local Z (on the
      // Rocketbox skeleton forward is local +Y, and picking by local Z put all three on the forefoot)
      const lat = new THREE.Vector3().crossVectors(side.up, side.fwd).normalize();
      let hi = 0, ti = 0, si = 0, hv = Infinity, tv = -Infinity, sv = -Infinity;
      for (let q = 0; q < K; q++) {
        _v0.fromArray(R.loc, 3 * (K * a + q));
        const fw = _v0.dot(side.fwd), la = Math.abs(_v0.dot(lat));
        if (fw < hv) { hv = fw; hi = q; }
        if (fw > tv) { tv = fw; ti = q; }
        if (la > sv) { sv = la; si = q; }
      }
      const ph = loc(hi), pt = loc(ti), ps = loc(si);
      for (const p of [ph, pt, ps]) p.y = ground(p.x, p.z, a);
      const nrm = new THREE.Vector3().subVectors(pt, ph).cross(new THREE.Vector3().subVectors(ps, ph));
      if (nrm.lengthSq() > 1e-12) nrm.normalize(); else nrm.copy(UP);
      if (nrm.y < 0) nrm.negate();
      if (!(nrm.y > 0.8)) nrm.copy(UP);   // steeper than ~37 degrees: not a slope a foot lies on
      // an edge or a step under the foot (the ground under some sole point is off that plane by more than T.edge): the
      // foot stands level, resting on the highest ground under it (toes over a platform's edge rest on the edge, they
      // don't follow the drop)
      const planeY = (x, z) => ph.y - (nrm.x * (x - ph.x) + nrm.z * (z - ph.z)) / nrm.y;
      for (let q = 0; q < K; q++) {
        const p = loc(q);
        if (Math.abs(ground(p.x, p.z, a) - planeY(p.x, p.z)) > T.edge * k) { nrm.copy(UP); break; }
      }
      // the clip's feet are posed for level ground: tilted by the ground's own slope (world up to its normal), not by
      // flattening the anchor frame's sole (a stance whose middle is a heel-off pose, the first one of a walk starting
      // mid-stride, was flattened 7 cm down into a pose the clip never had)
      const qAlign = new THREE.Quaternion().setFromUnitVectors(UP, nrm);
      // Each planted frame keeps the clip's OWN roll (heel strike, flat, heel off, toe off: the foot's turn relative to
      // the anchor, laid on the slope), and the sole points it stands on are pinned: from the anchor outward, frame by
      // frame, the foot is moved back by however far the clip carried the points touching the ground (the contact
      // patch: the sole points within 3 mm of the lowest along the ground's normal). A foot turning with the body (a
      // spin, a curve) lifts its heel and turns on the ball, so the toes don't sweep the floor.
      const qf = new Array(s.to - s.from), pf = new Array(s.to - s.from);
      for (let f = s.from; f < s.to; f++) {
        const q = new THREE.Quaternion().fromArray(R.quat, 4 * f);
        // the foot turns T.pivot of the clip's turn, at most T.pivotRate a frame (its ball patch sweeps under 1 cm)
        const dy = wrap(R.yaw[f] - R.yaw[a]), turn = Math.sign(dy) * Math.min(T.pivot * Math.abs(dy), T.pivotRate * Math.abs(f - a));
        const dyaw = Math.abs(turn);
        q.premultiply(qAlign);
        q.premultiply(_q1.setFromAxisAngle(nrm, turn - dy));
        const heel = Math.min(T.heelMax, T.heelPerRad * Math.max(0, dyaw - T.heelFrom));
        if (heel > 0) {
          const fw = side.fwd.clone().applyQuaternion(q), axis = new THREE.Vector3().crossVectors(nrm, fw);
          if (axis.lengthSq() > 1e-9) q.premultiply(_q1.setFromAxisAngle(axis.normalize(), heel));
        }
        qf[f - s.from] = q; pf[f - s.from] = new THREE.Vector3().fromArray(R.pos, 3 * f);
      }
      const vtx = (f, q, out) => { _m1.compose(pf[f - s.from], qf[f - s.from], _v2.setScalar(R.scale[f])); return out.fromArray(R.loc, 3 * (K * f + q)).applyMatrix4(_m1); };
      // the contact patch of frame g and how far it moved from frame h's pose to g's (same points)
      const moved = (g, h) => {
        let lo = Infinity;
        for (let q = 0; q < K; q++) lo = Math.min(lo, vtx(g, q, _v0).dot(nrm));
        let cx = 0, cz = 0, c = 0;
        for (let q = 0; q < K; q++) {
          const vg = vtx(g, q, _v0);
          if (vg.dot(nrm) > lo + 0.003 * k) continue;
          const vh = vtx(h, q, _v3);
          cx += vg.x - vh.x; cz += vg.z - vh.z; c++;
        }
        return c ? [cx / c, cz / c] : [0, 0];
      };
      const off = new Float64Array(2 * (s.to - s.from));
      for (let g = a + 1; g < s.to; g++) { const [dx, dz] = moved(g, g - 1), i = g - s.from; off[2 * i] = off[2 * i - 2] - dx; off[2 * i + 1] = off[2 * i - 1] - dz; }
      for (let g = a - 1; g >= s.from; g--) { const [dx, dz] = moved(g, g + 1), i = g - s.from; off[2 * i] = off[2 * i + 2] - dx; off[2 * i + 1] = off[2 * i + 3] - dz; }
      for (let f = s.from; f < s.to; f++) {
        const i = f - s.from, pA = pf[i];
        pA.x += off[2 * i]; pA.z += off[2 * i + 1];
        // lowered until the sole point nearest the ground UNDER IT touches (the ground under each point, so nothing
        // goes in at an edge, a step or a bump)
        const settle = (gnd) => {
          let gap = Infinity, lowY = Infinity;
          for (let q = 0; q < K; q++) {
            vtx(f, q, _v0);
            gap = Math.min(gap, _v0.y - gnd(_v0.x, _v0.z));
            lowY = Math.min(lowY, _v0.y);
          }
          return Number.isFinite(gap) ? { y: pA.y - gap, ground: lowY - gap } : null;
        };
        const hx = R.hip[3 * f], hy = R.hip[3 * f + 1], hz = R.hip[3 * f + 2], L = R.leg[f] * T.reach, by = baseY(f);
        // the reach guard, both ways: the hips this frame (as the clip poses them) must reach the target with at most
        // T.supportDrop of pelvis drop (too low), and the leg must not fold up under them to get there (too high: a
        // body keyed beside a platform or a ledge had its feet put up on the top, above its own hips)
        const reachable = (y) => {
          const dh = Math.hypot(pA.x - hx, pA.z - hz);
          const need = dh >= L ? Infinity : hy - y - Math.sqrt(L * L - dh * dh);
          return need <= T.supportDrop * k && Math.hypot(dh, hy - y) >= T.minLeg * R.leg[f] ? need : null;
        };
        // a body standing still stands on its own footing: a sole over a higher top beside it (toes over a ledge, heels
        // against a platform wall) doesn't lift the foot onto it
        const still = body[f] < T.stillSpeed;
        let at = settle((x, z) => ground(x, z, f)), need = at ? reachable(at.y) : null;
        if (at && (need === null || (still && at.ground > by + T.edge * k))) {
          at = settle((x, z) => Math.min(ground(x, z, f), by)); need = at ? reachable(at.y) : null;
        }
        if (!at || need === null) continue;
        const y = at.y;
        // a planted sole far above or below the body's own footing (a foot over a drop, a box beside) is not planted
        if (Math.abs(at.ground - by) > T.far * k) continue;
        // more pelvis drop than T.dropOK: only a candidate, planted below if it's the only foot the clip has down
        st[f] = need > T.dropOK * k ? 4 : 1; w[f] = st[f] === 1 ? 1 : 0; needs[f] = need; G[f] = at.ground;
        P[3 * f] = pA.x; P[3 * f + 1] = y; P[3 * f + 2] = pA.z;
        Q.set([qf[i].x, qf[i].y, qf[i].z, qf[i].w], 4 * f);
      }
    }
  }
  // Support: a frame the leg reaches only with more than T.dropOK of pelvis drop (up to T.supportDrop) is planted
  // anyway when it is the only foot the clip has down (the other foot is not planted and is up in the clip): a short
  // dip of the hips on a stair or a steep step instead of both feet in the air (floating). Else it is free.
  for (let f = 0; f < n; f++) for (const lr of SIDES) {
    const o = lr === "l" ? "r" : "l", A = out[lr], B = out[o];
    if (A.st[f] !== 4) continue;
    const otherDown = B.st[f] === 1 || raw[o].hb[f] <= T.hIn * k;
    const otherBetter = B.st[f] === 4 && B.needs[f] < A.needs[f];
    if (!otherDown && !otherBetter) { A.st[f] = 1; A.w[f] = 1; } else { A.st[f] = 0; A.w[f] = 0; }
  }
  // how far the hips must come down at frame f for leg lr to reach a foot bone at (x, y, z) (Infinity: never)
  const needDropOf = (lr, f, x, y, z) => {
    const R = raw[lr], L = R.leg[f] * T.reach, dh = Math.hypot(x - R.hip[3 * f], z - R.hip[3 * f + 2]);
    return dh >= L ? Infinity : R.hip[3 * f + 1] - y - Math.sqrt(L * L - dh * dh);
  };
  // an arc of foot lr from its plant at frame a to the one at frame b (frames a+1 .. b-1), lifted by `lift` in the middle;
  // mark false only checks the leg reaches it all the way
  const arcOf = (lr, a, b, lift, mark, lim = T.dropOK) => {
    const { st, w, P, Q } = out[lr];
    for (let f = a + 1; f < b; f++) {
      const t = smooth01((f - a) / (b - a));
      _v1.fromArray(P, 3 * a).lerp(_v0.fromArray(P, 3 * b), t);
      _v1.y += lift * Math.sin(Math.PI * (f - a) / (b - a));
      if (!mark) { if (needDropOf(lr, f, _v1.x, _v1.y, _v1.z) > lim * k) return false; continue; }
      _q0.fromArray(Q, 4 * a).slerp(_q1.fromArray(Q, 4 * b), t);
      st[f] = 2; w[f] = 1;
      P.set([_v1.x, _v1.y, _v1.z], 3 * f); Q.set([_q0.x, _q0.y, _q0.z, _q0.w], 4 * f);
    }
    return true;
  };
  // foot lr held planted at frame src's target over frames [from, to) (a step that waits for the other foot, or lands
  // early); false (nothing changed) when the leg can't reach it on one of them
  const holdOf = (lr, src, from, to, lim = T.supportDrop) => {
    const { st, w, P, Q, G } = out[lr], R = raw[lr], K = rig[lr].sole.length, ys = new Float64Array(Math.max(0, to - from)), gs = ys.slice();
    _q0.fromArray(Q, 4 * src);
    for (let f = from; f < to; f++) {
      // the held foot keeps its turn and place; the clip's own toe bend of frame f settles it onto the ground (the
      // lowest sole point touching), so a toe that bends up doesn't lift the held foot off the floor
      _m1.compose(_v1.fromArray(P, 3 * src), _q0, _v2.setScalar(R.scale[f]));
      let gap = Infinity, gy = NaN;
      for (let q = 0; q < K; q++) {
        _v0.fromArray(R.loc, 3 * (K * f + q)).applyMatrix4(_m1);
        const g = ground(_v0.x, _v0.z, f);
        if (_v0.y - g < gap) { gap = _v0.y - g; gy = g; }
      }
      const y = P[3 * src + 1] - (Number.isFinite(gap) ? gap : 0);
      // it is the only foot down meanwhile: the hips may dip as for a support frame
      if (skip[f] || needDropOf(lr, f, P[3 * src], y, P[3 * src + 2]) > lim * k) return false;
      ys[f - from] = y; gs[f - from] = gy;
    }
    for (let f = from; f < to; f++) {
      st[f] = 1; w[f] = 1; G[f] = gs[f - from]; P.copyWithin(3 * f, 3 * src, 3 * src + 3); P[3 * f + 1] = ys[f - from]; Q.copyWithin(4 * f, 4 * src, 4 * src + 4);
    }
    return true;
  };
  const shuffles = [];
  for (const lr of SIDES) {
    const R = raw[lr], { st, w } = out[lr];
    // planted runs the guard cut shorter than a stance are dropped
    for (const [i, j] of runsOf(st)) {
      if (j - i >= T.minStance || (j - i >= T.minStanceFast && fast[i] && fast[j - 1])) continue;
      for (let f = i; f < j; f++) { st[f] = 0; w[f] = 0; }
    }
    // turn steps: from one anchor to the next, lifted on an arc
    for (const s of steps[lr]) {
      const a = s.from - 1, b = s.to;
      if (a < 0 || b >= n || st[a] !== 1 || st[b] !== 1) continue;
      arcOf(lr, a, b, T.stepLift * k, true);
    }
    // a shuffle: the clip's foot moves from one plant to the next without lifting (a slow walk's idle <-> walk blend
    // drags it along the floor). Blending across that gap slid a touching sole up to 24 cm in a frame; it is a real
    // step instead, lifted on an arc (the leg must reach it all the way, as for a plant).
    for (const [[, j0], [i1]] of pairs(runsOf(Array.from(st, (x) => x === 1)))) {
      const a = j0 - 1, b = i1;
      if (b - a < 2 || b - a > Math.round(0.75 * fps)) continue;
      let lifted = false, blocked = false;
      for (let f = a; f <= b; f++) { if (skip[f] || st[f] === 2) blocked = true; if (f > a && f < b && R.hb[f] > T.stepLift * k) lifted = true; }
      if (blocked || lifted) continue;
      shuffles.push({ lr, a, b });
    }
  }
  // Both feet together, in time order: a shuffle step is taken only while the other foot is planted (a walk coming to
  // a stop drags BOTH feet in the clip's crossfade; stepping them at once left the body with no foot down for 4-8
  // frames). A step the other foot overlaps lands early and waits planted, or waits planted and steps later, whichever
  // leaves the longer step; neither fits: the clip's own drag (blended).
  shuffles.sort((x, y) => x.a - y.a || (x.lr < y.lr ? -1 : 1));
  for (const { lr, a, b } of shuffles) {
    const o = lr === "l" ? "r" : "l", O = out[lr], { st, P } = O, so = out[o].st;
    if (st[a] !== 1 || st[b] !== 1) continue;
    // the other foot's time off the ground inside this step: from c to d (d: it is planted again, looked for past b)
    let c = -1;
    for (let f = a + 1; f < b; f++) if (so[f] !== 1) { c = f; break; }
    const dist = (x, y) => Math.hypot(P[3 * y] - P[3 * x], P[3 * y + 2] - P[3 * x + 2]);
    const lift = (x, y) => T.stepLift * k * Math.min(1, dist(x, y) / (0.15 * k));
    const step = (x, y) => { const L = lift(x, y); if (!arcOf(lr, x, y, L, false)) return false; arcOf(lr, x, y, L, true); return true; };
    // (a run has its flight phase: both feet off is right there, the step is taken as it comes)
    if (c < 0 || body[a] >= T.walkMax) { step(a, b); continue; }
    let d = c;
    while (d < n && so[d] !== 1) d++;
    // a step of this length takes at least this many frames (the foot at most ~7 cm a frame, 1.7 m/s on average)
    const len = Math.max(3, Math.ceil(dist(a, b) / (0.07 * k)));
    const snap = () => [st.slice(), O.w.slice(), P.slice(), O.Q.slice(), O.G.slice()];
    const back = (S) => { st.set(S[0]); O.w.set(S[1]); P.set(S[2]); O.Q.set(S[3]); O.G.set(S[4]); };
    const ownPlanted = (x, y) => { for (let f = x; f <= y; f++) if (f < 0 || f >= n || skip[f] || st[f] !== 1) return false; return true; };
    const otherPlanted = (x, y) => { for (let f = x; f <= y; f++) if (f < 0 || f >= n || so[f] !== 1) return false; return true; };
    // late: planted at a's target until the other foot is down again (d), then the step, landing at b2 in the next
    // plant (a walk coming to a stop: the last step waits for the other foot)
    const late = (lim) => {
      const s0 = d - 1, b2 = Math.max(b, s0 + len);
      if (s0 <= a || !ownPlanted(b, b2) || !otherPlanted(d, b2)) return false;
      const S = snap();
      if (holdOf(lr, a, a + 1, s0 + 1, lim) && step(s0, b2)) return true;
      back(S); return false;
    };
    // early: the step leaves the plant before (a2) and lands before the other foot lifts (c), then waits planted at
    // b's target (a walk starting from standing: the first step goes before the other foot leaves)
    const early = (lim) => {
      const e = c, a2 = Math.min(a, e - len);
      if (!ownPlanted(a2, a) || !otherPlanted(a2, e - 1)) return false;
      const S = snap();
      P.copyWithin(3 * e, 3 * b, 3 * b + 3); O.Q.copyWithin(4 * e, 4 * b, 4 * b + 4); st[e] = 1; O.w[e] = 1;
      if (holdOf(lr, b, e, b, lim) && step(a2, e)) return true;
      back(S); return false;
    };
    // neither: the other foot waits planted where it was (c - 1) until this step is down, then goes (a walk starting
    // from standing: the clip's crossfade lifts both feet at once)
    const wait = (lim) => {
      const So = [so.slice(), out[o].w.slice(), out[o].P.slice(), out[o].Q.slice(), out[o].G.slice()];
      if (holdOf(o, c - 1, c, b + 1, lim) && step(a, b)) return true;
      so.set(So[0]); out[o].w.set(So[1]); out[o].P.set(So[2]); out[o].Q.set(So[3]); out[o].G.set(So[4]); return false;
    };
    for (const lim of [T.dropOK, T.supportDrop]) if (late(lim) || early(lim) || wait(lim)) break;
  }
  // Walking (not a run's flight): no frame with both feet off the ground. Whatever is left of one (two real steps the
  // clip's crossfade takes at once, at a start, a stop or a turn) is closed by holding one foot planted: the foot that
  // left last stays where it was until the other is down and then steps to its next plant, or the foot that lands
  // first steps there early and waits, whichever changes the fewest frames the leg can reach (the hips level first,
  // else a support dip).
  const offBoth = (f) => !skip[f] && out.l.st[f] !== 1 && out.r.st[f] !== 1 && body[f] < T.walkMax;
  const arcLift = (lr, x, y) => { const P = out[lr].P; return T.stepLift * k * Math.min(1, Math.hypot(P[3 * y] - P[3 * x], P[3 * y + 2] - P[3 * x + 2]) / (0.15 * k)); };
  const stepOf = (lr, x, y, lim) => { const L = arcLift(lr, x, y); if (!arcOf(lr, x, y, L, false, lim)) return false; arcOf(lr, x, y, L, true); return true; };
  for (let c = 0; c < n; c++) {
    if (!offBoth(c)) continue;
    let d = c; while (d < n && offBoth(d)) d++;
    const opts = [];
    for (const lr of SIDES) {
      const st = out[lr].st;
      let p = c - 1; while (p >= 0 && st[p] !== 1 && !skip[p]) p--;
      let q = d; while (q < n && st[q] !== 1 && !skip[q]) q++;
      const hasP = p >= 0 && st[p] === 1, hasQ = q < n && st[q] === 1;
      if (!hasP || !hasQ) continue;   // the shot starts or ends mid-stride: nothing to hold from
      // late: held at p's target over (p, d), then a step d-1 -> q
      if (q - (d - 1) >= 2) opts.push({ lr, kind: "late", p, q, cost: q - p - 1 });
      // early: a step p -> c onto q's target, then held there over [c, q)
      if (c - p >= 2) opts.push({ lr, kind: "early", p, q, cost: q - p - 1 + (q - c) / n });
    }
    opts.sort((x, y) => x.cost - y.cost);
    const tryOpt = (o, lim) => {
      const O = out[o.lr], S = [O.st.slice(), O.w.slice(), O.P.slice(), O.Q.slice(), O.G.slice()];
      let ok;
      if (o.kind === "late") ok = holdOf(o.lr, o.p, o.p + 1, d, lim) && stepOf(o.lr, d - 1, o.q, lim);
      else ok = holdOf(o.lr, o.q, c, o.q, lim) && stepOf(o.lr, o.p, c, lim);
      if (!ok) { O.st.set(S[0]); O.w.set(S[1]); O.P.set(S[2]); O.Q.set(S[3]); O.G.set(S[4]); }
      return ok;
    };
    let done = false;
    for (const lim of [T.dropOK, T.supportDrop]) {
      for (const o of opts) if (tryOpt(o, lim)) { done = true; break; }
      if (done) break;
    }
    c = d;
  }
  // a run's touch-down next to a plant that the stance limits left out (the shot's first frame, a contact a little
  // faster than the limit): held at that plant, so the touching sole doesn't slide into it or out of it
  for (const lr of SIDES) {
    const st = out[lr].st, ct = contact[lr];
    for (let f = 0; f < n; f++) {
      if (st[f] || !ct[f] || !fast[f]) continue;
      const src = f > 0 && st[f - 1] === 1 ? f - 1 : f + 1 < n && st[f + 1] === 1 ? f + 1 : -1;
      if (src >= 0) holdOf(lr, src, f, f + 1, T.dropOK);
    }
  }
  for (const lr of SIDES) {
    const R = raw[lr], { st, w, P, Q } = out[lr];
    const needDrop = (f, x, y, z) => needDropOf(lr, f, x, y, z);
    // blend in before a plant and out after it, toward the nearest planted frame; shorter ramps at a run's speed
    // (the hips cover 15 cm a frame), and a blend the leg can't reach is weighted down until it can
    for (let f = 0; f < n; f++) {
      if (st[f] || skip[f]) continue;
      const rf = Math.max(1, Math.round(ramp * Math.min(1, 1.4 / Math.max(1e-6, body[f]))));
      let best = 0, bd = Infinity;
      for (let d = 1; d <= rf; d++) {
        if (f - d >= 0 && st[f - d] === 1) { bd = d; best = f - d; break; }
        if (f + d < n && st[f + d] === 1) { bd = d; best = f + d; break; }
      }
      // a skipped frame between this one and the plant stops the blend (no plant reaches across a jump)
      if (bd === Infinity) continue;
      let blocked = false;
      for (let q = Math.min(f, best); q <= Math.max(f, best); q++) if (skip[q]) blocked = true;
      if (blocked) continue;
      st[f] = 3; w[f] = rampWeight(bd, rf);
      P.set(P.subarray(3 * best, 3 * best + 3), 3 * f); Q.set(Q.subarray(4 * best, 4 * best + 4), 4 * f);
    }
    // the clip's foot moved up or down by the ground: dY[f] at a planted frame is how far the plant moved the foot
    // bone vertically; between plants it goes smoothly from the last plant's to the next one's (a foot swings from
    // one step of a stair to the next, from a hollow to a bump), faded out next to a jump (the clip's own legs there)
    const dY = new Float64Array(n), near = new Float64Array(3 * n).fill(NaN), liftK = new Float32Array(n), topG = new Float64Array(n).fill(NaN);
    // the ground under each plant (the swing between two plants may clear up to the higher of them)
    const pg = (f) => (Number.isFinite(out[lr].G[f]) ? out[lr].G[f] : ground(P[3 * f], P[3 * f + 2], f));
    {
      let prev = -1;
      const nextPlanted = new Int32Array(n).fill(-1);
      for (let f = n - 1, nx = -1; f >= 0; f--) { if (skip[f]) nx = -1; else if (st[f] === 1) nx = f; nextPlanted[f] = nx; }
      for (let f = 0; f < n; f++) {
        if (skip[f]) { prev = -1; continue; }
        if (st[f] === 1) { prev = f; dY[f] = P[3 * f + 1] - R.pos[3 * f + 1]; continue; }
        const nx = nextPlanted[f];
        const dp = prev >= 0 ? P[3 * prev + 1] - R.pos[3 * prev + 1] : null, dn = nx >= 0 ? P[3 * nx + 1] - R.pos[3 * nx + 1] : null;
        let d = dp === null ? (dn ?? 0) : dn === null ? dp : dp + (dn - dp) * smooth01((f - prev) / (nx - prev));
        let ds = Infinity;
        for (let q = 1; q <= ramp + 1; q++) if ((f - q >= 0 && skip[f - q]) || (f + q < n && skip[f + q])) { ds = q; break; }
        if (ds !== Infinity) d *= (ds - 1) / (ramp + 1);
        dY[f] = d;
        // the plant this foot comes from or goes to, the nearer in time (the swing clearance grows with the distance)
        const c = prev < 0 ? nx : nx < 0 ? prev : (f - prev <= nx - f ? prev : nx);
        if (c >= 0) near.set(P.subarray(3 * c, 3 * c + 3), 3 * f);
        topG[f] = Math.max(prev >= 0 ? pg(prev) : -Infinity, nx >= 0 ? pg(nx) : -Infinity);
        const a = Math.max(0, f - 1), b = Math.min(n - 1, f + 1);
        const sp = b > a ? Math.hypot(R.pos[3 * b] - R.pos[3 * a], R.pos[3 * b + 2] - R.pos[3 * a + 2]) * fps / (b - a) : 0;
        liftK[f] = smooth01(sp / T.liftSpeed);
      }
    }
    // the blends, weighted down where the leg can't reach (the target with the clip's foot moved by dY)
    for (let f = 0; f < n; f++) {
      if (st[f] !== 3) continue;
      const cx = R.pos[3 * f], cy = R.pos[3 * f + 1] + dY[f], cz = R.pos[3 * f + 2];
      const at = (t) => needDrop(f, cx + (P[3 * f] - cx) * t, cy + (P[3 * f + 1] - cy) * t, cz + (P[3 * f + 2] - cz) * t);
      if (at(w[f]) <= T.dropOK * k) continue;
      let lo = 0, hi = w[f];
      for (let it = 0; it < 10; it++) { const m = 0.5 * (lo + hi); if (at(m) <= T.dropOK * k) lo = m; else hi = m; }
      w[f] = lo;
    }
    plan.dY[lr] = dY; plan.near[lr] = near; plan.liftK[lr] = liftK; (plan.topG ||= {})[lr] = topG;
    plan.state[lr] = st; plan.w[lr] = w; plan.pos[lr] = P; plan.quat[lr] = Q; plan.gy[lr] = R.gy;
  }
  return plan;
}

/** Set a bone's world rotation (its parent's world matrices must be current). */
function setWorldQuat(bone, qw) {
  bone.parent.getWorldQuaternion(_q1);
  bone.quaternion.copy(_q1.invert().multiply(qw));
  bone.updateMatrixWorld(true);
}

const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3(), _T = new THREE.Vector3(), _P = new THREE.Vector3(), _D = new THREE.Vector3();
/**
 * Two-bone IK: turn the thigh and the calf so the foot bone's origin lands on target (a world point), keeping the
 * knee on the side the pose bends it to (poleHint, a world direction, when the leg is straight), then give the foot
 * the world rotation footQuat (null: keep its own). The target is clamped to what the leg can reach.
 */
export function twoBoneIK(thigh, calf, foot, target, footQuat = null, poleHint = null) {
  thigh.getWorldPosition(_A); calf.getWorldPosition(_B); foot.getWorldPosition(_C);
  const a = _A.distanceTo(_B), b = _B.distanceTo(_C);
  _D.subVectors(target, _A);
  const d = Math.max(Math.abs(a - b) + 1e-5, Math.min(a + b - 1e-5, _D.length()));
  if (_D.lengthSq() < 1e-12 || a < 1e-6 || b < 1e-6) return false;
  _D.normalize();
  // the side the pose bends the knee to: the knee off the hip-to-foot line as posed, then square to the target line
  _P.subVectors(_B, _A); _v2.subVectors(_C, _A).normalize(); _P.addScaledVector(_v2, -_P.dot(_v2));
  if (_P.lengthSq() < 1e-8 * a * a && poleHint) _P.copy(poleHint);
  _P.addScaledVector(_D, -_P.dot(_D));
  if (_P.lengthSq() < 1e-12) return false;
  _P.normalize();
  const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))), sinA = Math.sqrt(1 - cosA * cosA);
  // the knee where it has to be: a along the target line, a sin(A) toward the pole
  _T.copy(_A).addScaledVector(_D, a * cosA).addScaledVector(_P, a * sinA);
  _q0.setFromUnitVectors(_v0.subVectors(_B, _A).normalize(), _v1.subVectors(_T, _A).normalize());
  setWorldQuat(thigh, _q0.multiply(thigh.getWorldQuaternion(new THREE.Quaternion())));
  calf.getWorldPosition(_B); foot.getWorldPosition(_C);
  _T.copy(_A).addScaledVector(_D, d);
  _q0.setFromUnitVectors(_v0.subVectors(_C, _B).normalize(), _v1.subVectors(_T, _B).normalize());
  setWorldQuat(calf, _q0.multiply(calf.getWorldQuaternion(new THREE.Quaternion())));
  if (footQuat) setWorldQuat(foot, footQuat);
  return true;
}

/** Put back the clip's own values groundFeet saved (call before the mixer poses the next frame). */
export function restoreClipPose(saved) {
  if (!saved?.length) return;
  for (const [o, prop, v] of saved) o[prop].copy(v);
  saved.length = 0;
}

/** The named leg bones of a posed avatar clone ({l: {thigh, calf, foot, toe}, r, root}), or null. */
export function legBones(skinBones, rig) {
  if (!rig) return null;
  const out = { root: skinBones[rig.root] };
  for (const lr of SIDES) {
    const B = rig.bones[lr], o = {};
    for (const k of ["thigh", "calf", "foot", "toe"]) { o[k] = skinBones[B[k]]; if (!o[k]) return null; }
    out[lr] = o;
  }
  return out.root ? out : null;
}

/**
 * Ground the feet of an avatar posed by its clip at frame f (after avatars.drive and placeHolder): the plan's target
 * per foot, blended with the clip's own foot (moved up or down by the ground between plants, plan.dY) by the plan's
 * weight; the pelvis lowered when a planted foot is out of reach; the legs solved; a foot that is not planted kept
 * clear of the ground under EVERY sole point (plan.ground, the same surface the plan planted on: stairs, kerbs, bumps),
 * the more so the further it is from its plant. Returns {drop, feet: {l: w, r: w}, miss: {l, r}} or null.
 */
export function groundFeet({ plan, rig, mesh, bones, holder, frame, saved = null, T = FOOT }) {
  if (!plan || !bones) return null;
  // The clip's own values of every bone this changes, for restoreClipPose: three's PropertyMixer only writes a bone
  // when the clip's value differs from what it wrote last, so the same frame posed again would keep these IK values.
  if (saved) {
    saved.length = 0;
    saved.push([bones.root, "position", bones.root.position.clone()]);
    for (const lr of SIDES) for (const k of ["thigh", "calf", "foot"]) saved.push([bones[lr][k], "quaternion", bones[lr][k].quaternion.clone()]);
  }
  const f = Math.max(0, Math.min(plan.n - 1, Math.round(frame)));
  if (plan.skip[f]) return { drop: 0, feet: { l: 0, r: 0 }, miss: { l: 0, r: 0 } };
  holder.updateMatrixWorld(true);
  const tgt = {}, fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(holder.getWorldQuaternion(new THREE.Quaternion()));
  let drop = 0;
  for (const lr of SIDES) {
    const w = plan.w[lr][f], dy = plan.dY?.[lr]?.[f] || 0;
    if (!(w > 0) && Math.abs(dy) < 1e-5) continue;
    const B = bones[lr];
    const pos = B.foot.getWorldPosition(new THREE.Vector3());
    pos.y += dy;
    const quat = B.foot.getWorldQuaternion(new THREE.Quaternion());
    if (w > 0) { pos.lerp(_v0.fromArray(plan.pos[lr], 3 * f), w); quat.slerp(_q0.fromArray(plan.quat[lr], 4 * f), w); }
    tgt[lr] = { pos, quat, w };
    if (!(w > 0)) continue;
    // out of reach: how far the hips must come down for the leg to reach (weighted, so it eases in and out)
    const H = B.thigh.getWorldPosition(new THREE.Vector3());
    const L = (H.distanceTo(B.calf.getWorldPosition(_v1)) + _v1.distanceTo(B.foot.getWorldPosition(_v2))) * T.reach;
    const hz = Math.hypot(pos.x - H.x, pos.z - H.z), vy = H.y - pos.y;
    if (hz < L) { const need = vy - Math.sqrt(L * L - hz * hz); if (need > 0) drop = Math.max(drop, need * w); }
  }
  drop = Math.min(drop, T.maxDrop * plan.k);
  if (drop > 1e-6 && bones.root?.parent) {
    const wp = bones.root.getWorldPosition(new THREE.Vector3());
    wp.y -= drop;
    bones.root.position.copy(bones.root.parent.worldToLocal(wp));
    bones.root.updateMatrixWorld(true);
  }
  for (const lr of SIDES) if (tgt[lr]) twoBoneIK(bones[lr].thigh, bones[lr].calf, bones[lr].foot, tgt[lr].pos, tgt[lr].quat, fwd);
  // a foot not planted never goes into the ground under any of its sole points (the lowered hips, a blend, a swing
  // over a stair's nosing or a kerb), and the further it is from its plant the more it clears the ground
  const ground = plan.ground;
  const miss = { l: 0, r: 0 };
  for (const lr of SIDES) {
    const B = bones[lr];
    if (plan.state[lr][f] === 1) { miss[lr] = B.foot.getWorldPosition(_v3).distanceTo(_v0.fromArray(plan.pos[lr], 3 * f)); continue; }
    const p = solePoints(mesh, rig[lr]);
    const fp = B.foot.getWorldPosition(new THREE.Vector3());
    let margin = 0;
    const nr = plan.near?.[lr];
    // (none where the clip's own foot touches down: a run's or a sprint's contact frame stays on the ground)
    if (nr && Number.isFinite(nr[3 * f]) && !plan.contact?.[lr]?.[f]) margin = (plan.liftK?.[lr]?.[f] ?? 1) * Math.min(T.liftMax * plan.k, T.liftPerM * Math.hypot(fp.x - nr[3 * f], fp.z - nr[3 * f + 2]));
    // Only ground the leg could step onto counts: none over the body's own footing for a foot at rest, up to T.far for
    // one swinging (a kerb, a stair's nosing) or up to the higher of the plants it swings between; a foot standing
    // beside a platform or a ledge is not pushed up onto its top. And the push never folds the leg closer to the hip than T.minLeg of its length.
    // (the footing laid along the slope of the ground at the body: on a hill the ground under a foot at rest is above
    // or below the body's own footing and that is no top beside it)
    const lk = plan.liftK?.[lr]?.[f] ?? 1, base = plan.base?.[f];
    const tg = plan.topG?.[lr]?.[f];
    const gx = plan.slope?.[2 * f] || 0, gz = plan.slope?.[2 * f + 1] || 0, rx = plan.rootXZ?.[3 * f] ?? 0, rz = plan.rootXZ?.[3 * f + 2] ?? 0;
    const up0 = T.far * plan.k * smooth01(lk / 0.25), tgTop = Number.isFinite(tg) ? tg + T.edge * plan.k : -Infinity;
    let under = 0;
    for (let i = 0; i < p.length; i += 3) {
      const top = Number.isFinite(base) ? Math.max(base + gx * (p[i] - rx) + gz * (p[i + 2] - rz) + up0, tgTop) : Infinity;
      const gy = Math.min(top, ground ? ground(p[i], p[i + 2], f) : plan.gy[lr][f]);
      under = Math.max(under, gy + margin - p[i + 1]);
    }
    if (under > 1e-4) {
      const H = B.thigh.getWorldPosition(_v3), L = H.distanceTo(B.calf.getWorldPosition(_v1)) + _v1.distanceTo(fp), m = T.minLeg * L;
      const dh = Math.hypot(fp.x - H.x, fp.z - H.z);
      const capY = dh >= m ? Infinity : H.y - Math.sqrt(m * m - dh * dh);
      under = Math.min(under, Math.max(0, capY - fp.y));
    }
    if (under > 1e-4) {
      const q = B.foot.getWorldQuaternion(new THREE.Quaternion());
      twoBoneIK(B.thigh, B.calf, B.foot, fp.addScaledVector(UP, under), q, fwd);
    }
  }
  return { drop, feet: { l: tgt.l?.w || 0, r: tgt.r?.w || 0 }, miss };
}
