// Foot-locked locomotion for keyed movement (people and horses), and the dust their feet kick up.
//
// A keyed path only says where the body is each frame. planGait() turns it into a gait: the speed picks the gait
// (people: walk / jog / run; horses: walk / trot / canter / gallop), the speed sets the cadence and the stride, and
// every foot gets a list of contacts. A contact touches down, stays planted on ONE spot (where the body is over it at
// mid-stance) and lifts off; between contacts the foot swings to the next spot on an arc. Applying a frame puts each
// foot on its spot with two-bone IK (people: mocap.mjs legIK; horses: hinge CCD on the rigged GLB's leg bones), so a
// stance foot never slides. Above the legs: hip and shoulder counter-rotation, arm swing, a pelvis that rises and falls
// with the gait, a little head bob, leaning into turns and into acceleration. Starting and stopping are real steps:
// the phase only stops when every foot is down near its rest spot.
//
// Everything is a pure function of the keys and the frame (renders and scrubbing give the same pose every time), and
// the dust is seeded the same way (strikeEvents + dustParticles), drawn only in Clay and Color.
import * as THREE from "../vendor/three.module.min.mjs";
import { feetOf, footState, legIK, resetFeet } from "./mocap.mjs";
import { softSprite } from "./sets/common.mjs";

const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);
const wrapPi = (x) => Math.atan2(Math.sin(x), Math.cos(x));

// ------------------------------------------------------------------ gait tables
/** Speed bands (m/s) for a 1.8 m person; scaled by sqrt(height / 1.8) (Froude: longer legs, same gait faster). */
export const HUMAN_BANDS = { idle: 0.15, walk: 2.0, jog: 3.6 };
/** Speed bands (m/s) for a 1.6 m (withers) horse. */
export const HORSE_BANDS = { idle: 0.2, walk: 1.9, trot: 4.6, canter: 8.0 };

/**
 * A person's gait at speed v (m/s): name, cycle frequency (strides per second, one stride = two steps), duty factor
 * (share of the stride a foot is down), swing lift (m), and the run weight (0 walk .. 1 run) the upper body blends by.
 */
export function humanGait(v, height = 1.8) {
  const k = Math.sqrt(height / 1.8), u = v / k;
  const name = u < HUMAN_BANDS.idle ? "idle" : u < HUMAN_BANDS.walk ? "walk" : u < HUMAN_BANDS.jog ? "jog" : "run";
  const run = sstep(1.75, 2.45, u);                               // walking turns into running across ~2 m/s
  const walkF = 0.62 + 0.2 * Math.min(u, 2.4), runF = 1.15 + 0.08 * Math.min(u, 9);
  const freq = Math.max(0.5, lerp(walkF, runF, run)) / k;
  const duty = lerp(0.62 + 0.1 * clamp(1 - u, 0, 1), lerp(0.4, 0.3, sstep(3, 7, u)), run);
  const lift = k * lerp(0.07 + 0.02 * Math.min(u, 2), clamp(0.2 + 0.07 * (u - 3), 0.2, 0.45), run);
  return { name, freq, duty, lift, run, offsets: [0, 0.5] };
}

// Horse footfalls, legs in order LH, LF, RH, RF (left hind, left fore, right hind, right fore); touchdown phase in
// the stride. Walk: four-beat lateral; trot: two-beat diagonal; canter (right lead): LH, then RH + LF, then RF; gallop
// (right lead, transverse): LH, RH, LF, RF with a moment of suspension.
const HORSE_FOOTFALL = {
  walk: { off: [0, 0.25, 0.5, 0.75], duty: 0.64 },
  trot: { off: [0, 0.5, 0.5, 0], duty: 0.42 },
  canter: { off: [0, 0.25, 0.25, 0.5], duty: 0.36 },
  gallop: { off: [0, 0.42, 0.1, 0.54], duty: 0.24 },
};
const HORSE_ORDER = ["walk", "trot", "canter", "gallop"];

/** A horse's gait at speed v: name, weights of each gait (they cross-fade over ~0.6 m/s), frequency, duty, offsets. */
export function horseGait(v, height = 1.6, sweep = null) {
  const k = Math.sqrt(height / 1.6), u = v / k;
  const B = HORSE_BANDS;
  const name = u < B.idle ? "idle" : u < B.walk ? "walk" : u < B.trot ? "trot" : u < B.canter ? "canter" : "gallop";
  const t1 = sstep(B.walk - 0.3, B.walk + 0.3, u), t2 = sstep(B.trot - 0.4, B.trot + 0.4, u), t3 = sstep(B.canter - 0.6, B.canter + 0.6, u);
  const w = { walk: 1 - t1, trot: t1 * (1 - t2), canter: t2 * (1 - t3), gallop: t3 };
  const F = { walk: 0.8 + 0.08 * u, trot: 1.2 + 0.05 * u, canter: 1.45 + 0.03 * u, gallop: 1.75 + 0.035 * u };
  let freq = 0, duty = 0;
  const off = [0, 0, 0, 0];
  // With the rigged horse's own stance sweep (how far a planted hoof travels back under the body in its clips), the
  // cadence is set so the clip's legs cover exactly the ground the body does: no skating, clip shapes kept.
  if (sweep) for (const g of HORSE_ORDER) {
    const sw = (g === "walk" || g === "trot" ? sweep.walk : sweep.gallop) || 0;
    // (within a believable cadence: past it the legs reach further than the clip, and the pinning does the rest)
    if (sw > 0.05 && u > B.idle) F[g] = clamp(v * HORSE_FOOTFALL[g].duty / sw, 0.8 * F[g], 1.25 * F[g]) * k;
  }
  for (const g of HORSE_ORDER) {
    freq += w[g] * F[g];
    duty += w[g] * HORSE_FOOTFALL[g].duty;
    // offsets blend on the circle, from the walk's
    HORSE_FOOTFALL[g].off.forEach((o, i) => { off[i] += w[g] * (HORSE_FOOTFALL.walk.off[i] + wrapPi((o - HORSE_FOOTFALL.walk.off[i]) * TAU) / TAU); });
  }
  // Through a gait change the cadence follows the speed with the blended stance share and the blended clip sweep, so
  // mid-change (canter -> gallop) a planted hoof still covers exactly the ground the body does: no slide while the
  // per-gait cadences cross-fade (each was only right at its own gait's weight of 1).
  if (sweep && u > B.idle) {
    const sw = (w.walk + w.trot) * (sweep.walk || 0) + (w.canter + w.gallop) * (sweep.gallop || 0);
    if (sw > 0.05) freq = clamp(v * duty / sw * k, 0.8 * freq, 1.4 * freq);
  }
  duty += 0.16 * clamp(1 - u / 1.5, 0, 1);                       // a slow walk keeps three feet down
  return { name, weights: w, freq: freq / k, duty, lift: height * lerp(0.07, 0.2, sstep(1.5, 9, u)), offsets: off };
}

/** Which gait a kind of actor uses at a speed (for the UI, the prompt and tests). */
export function gaitName(kind, v, height) {
  return kind === "horse" ? horseGait(v, height || 1.6).name : humanGait(v, height || 1.8).name;
}

// ------------------------------------------------------------------ the plan
/**
 * Plan the footsteps of a keyed path. pos[f] = [x, y, z] and yaw[f] (radians, 0 = facing +Z) for every frame
 * 0..n-1; legs = [{x, z}] each foot's rest spot in body space (x = the body's left). kind "human" | "horse".
 * Returns {speed[], accel[], yawRate[], phase[], gaits[], legs: [{psi[], contacts: [{k, t0, t1, p: [x, z], yaw}]}]}.
 */
export function planGait({ pos, yaw, fps = 24, kind = "human", height = 1.8, legs, sweep = null }) {
  const n = pos.length, last = n - 1;
  const gaitOf = kind === "horse" ? (v) => horseGait(v, height, sweep) : (v) => humanGait(v, height);
  const P = (f) => pos[clamp(f, 0, last)];
  // Speed (m/s) from the path, lightly smoothed so a key doesn't jolt the cadence; acceleration and turn rate.
  const raw = [];
  for (let f = 0; f < n; f++) { const a = P(f - 1), b = P(f + 1), d = Math.min(2, f, last - f) || 1; raw.push(Math.hypot(b[0] - a[0], b[2] - a[2]) * fps / (f === 0 || f === last ? d : 2)); }
  const speed = raw.map((_, f) => { let s = 0, c = 0; for (let j = -2; j <= 2; j++) if (f + j >= 0 && f + j < n) { s += raw[f + j]; c++; } return s / c; });
  const accel = speed.map((_, f) => (speed[Math.min(last, f + 2)] - speed[Math.max(0, f - 2)]) * fps / Math.max(1, Math.min(last, f + 2) - Math.max(0, f - 2)));
  const yawRate = yaw.map((_, f) => wrapPi(yaw[Math.min(last, f + 1)] - yaw[Math.max(0, f - 1)]) * fps / Math.max(1, Math.min(last, f + 1) - Math.max(0, f - 1)));
  const G = speed.map((v) => gaitOf(v));
  const idleV = (kind === "horse" ? HORSE_BANDS.idle * Math.sqrt(height / 1.6) : HUMAN_BANDS.idle * Math.sqrt(height / 1.8));
  const settleRate = (kind === "horse" ? 0.8 : 0.95) / fps;
  const tol = 0.12 * height;
  const L = legs.length;
  // Phase: strides travelled. Stopped, it keeps stepping until every foot is down near the spot it will stand on.
  const phase = [0];
  const psi = legs.map((_, i) => [G[0].offsets[i]]);
  const tdPos = legs.map(() => pos[0]);
  for (let f = 1; f < n; f++) {
    const g = G[f], prev = phase[f - 1];
    // (setting off, the first step comes as the body starts to go, not once it is up to speed: the cadence looks a
    // quarter second ahead while speeding up from a stand)
    const vAhead = Math.max(speed[f], speed[Math.min(last, f + Math.round(0.25 * fps))] * (speed[f] > 0.02 ? 1 : 0));
    let rate = vAhead > idleV ? g.freq / fps * clamp(vAhead / (idleV * 2), 0, 1) : 0;
    // A planted foot left too far behind the hips comes up now (a quick first step out of a standing start).
    // (The body passes over a planted foot: it is half a stance behind at lift-off. Past ~0.6 of a stance behind, the
    // hips can only keep it by dropping, so it comes up: a foot planted while standing doesn't stay down while the body
    // speeds away from it.)
    const reachBack = Math.max((kind === "horse" ? 0.3 : 0.19) * height, (kind === "horse" ? 1.15 : 0.6) * g.duty * speed[f] / Math.max(g.freq, 0.3));
    for (let i = 0; i < L; i++) {
      const s = psi[i][f - 1], u = s - Math.floor(s);
      if (u < g.duty && Math.hypot(tdPos[i][0] - pos[f][0], tdPos[i][2] - pos[f][2]) > reachBack) rate = Math.max(rate, (g.duty - u) / 2 + 0.03);
    }
    if (!rate) {
      const down = psi.every((s) => frac(s[f - 1]) < g.duty - 0.04);
      const near = tdPos.every((p) => Math.hypot(p[0] - pos[f][0], p[2] - pos[f][2]) < tol);
      if (!(down && near)) rate = settleRate;
    }
    phase.push(prev + rate);
    for (let i = 0; i < L; i++) {
      const s = Math.max(psi[i][f - 1], phase[f] + g.offsets[i]);
      if (Math.floor(s) > Math.floor(psi[i][f - 1])) tdPos[i] = pos[f];
      psi[i].push(s);
    }
  }
  // Fractional frame where an increasing track reaches value v (extrapolated at its end rates).
  const timeAt = (arr, v) => {
    if (v <= arr[0]) { const r = Math.max(arr[Math.min(last, 1)] - arr[0], G[0].freq / fps); return Math.max(-3 * fps, (v - arr[0]) / r); }
    if (v > arr[last]) { const r = Math.max(arr[last] - arr[Math.max(0, last - 1)], 1e-3); return Math.min(last + 3 * fps, last + (v - arr[last]) / r); }
    let lo = 0, hi = last;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] >= v) hi = m; else lo = m; }
    const a = arr[lo], b = arr[hi];
    return b - a < 1e-9 ? hi : lo + (v - a) / (b - a);
  };
  const posAt = (t) => {
    if (t <= 0) { const v = [pos[Math.min(1, last)][0] - pos[0][0], pos[Math.min(1, last)][2] - pos[0][2]]; return [pos[0][0] + v[0] * t, pos[0][2] + v[1] * t]; }
    if (t >= last) { const v = [pos[last][0] - pos[Math.max(0, last - 1)][0], pos[last][2] - pos[Math.max(0, last - 1)][2]]; return [pos[last][0] + v[0] * (t - last), pos[last][2] + v[1] * (t - last)]; }
    const i = Math.floor(t), u = t - i, a = pos[i], b = pos[i + 1];
    return [lerp(a[0], b[0], u), lerp(a[2], b[2], u)];
  };
  const yawAt = (t) => { const i = clamp(Math.floor(t), 0, last), j = clamp(i + 1, 0, last), u = clamp(t - i, 0, 1); return yaw[i] + wrapPi(yaw[j] - yaw[i]) * u; };
  const legsOut = legs.map((rest, i) => {
    const arr = psi[i], contacts = [];
    for (let k = Math.floor(arr[0]) - 1; k <= Math.floor(arr[last]) + 1; k++) {
      const t0 = timeAt(arr, k);
      // Lift-off: when this stride's share of stance (the duty at that moment) has passed. Speeding up shortens it,
      // so a foot that was standing still when they set off comes up within the first step.
      let t1 = null;
      for (let f = Math.max(0, Math.ceil(t0)); f <= last; f++) {
        const d = G[f].duty;
        if (arr[f] - k >= d) {
          const pf = Math.max(f - 1, 0), a = arr[pf] - k - G[pf].duty, b = arr[f] - k - d;
          t1 = f === 0 || f - 1 < t0 ? Math.max(t0, f - 1 + (b - a > 1e-9 ? -a / (b - a) : 1)) : pf + (b - a > 1e-9 ? -a / (b - a) : 1);
          break;
        }
      }
      if (t1 === null) t1 = timeAt(arr, k + G[last].duty);
      if (t0 < 0 && t1 < 0) t1 = timeAt(arr, k + G[0].duty);
      t1 = Math.max(t0 + 1e-3, t1);
      // Planted where the body will be over it half a normal stance after touchdown (a stop's last step lands
      // under the body, not where a long standing stance would put its middle).
      const g0 = G[clamp(Math.round(t0), 0, last)], nominal = (g0.duty / Math.max(g0.freq, 0.3)) * fps;
      const tm = clamp(t0 + nominal / 2, Math.max(t0, -fps), Math.min(t1, last + fps));
      const c = posAt(tm), y = yawAt(tm), cs = Math.cos(y), sn = Math.sin(y);
      // body space -> world: +x is the body's left, +z its front
      contacts.push({ k, t0, t1, yaw: y, p: [c[0] + rest.x * cs + rest.z * sn, c[1] - rest.x * sn + rest.z * cs] });
    }
    return { psi: arr, contacts };
  });
  return { n, fps, kind, height, speed, accel, yawRate, phase, gaits: G, legs: legsOut };
}

/** Where a foot is at fractional frame t: {stance, s (0..1 through the stance or swing), c (contact), next, prev}. */
export function footAt(plan, i, t) {
  const cs = plan.legs[i].contacts;
  let lo = 0;
  while (lo < cs.length - 1 && cs[lo + 1].t0 <= t) lo++;
  const c = cs[lo];
  if (t >= c.t0 && t < c.t1) return { stance: true, s: (t - c.t0) / (c.t1 - c.t0), c, prev: cs[lo - 1] || c, next: cs[lo + 1] || c };
  const nx = cs[lo + 1];
  if (!nx || t < c.t0) return { stance: true, s: 0.5, c, prev: c, next: c };
  return { stance: false, s: clamp((t - c.t1) / Math.max(1e-6, nx.t0 - c.t1), 0, 1), c, next: nx, prev: c };
}

// ------------------------------------------------------------------ people
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

/** The clay figure's leg geometry (figure units): hips, thigh and shin lengths, and the shoe's heel / toe / sole from the ankle. */
export function humanLegs(g) {
  if (g.userData._gaitLegs) return g.userData._gaitLegs;
  const J = g.userData.joints, F = feetOf(g), out = {};
  for (const lr of ["l", "r"]) {
    const hip = J[`${lr}_hip`], knee = J[`${lr}_knee`], f = F[lr];
    if (!hip || !knee || !f) return null;
    const b = f.shoe.geometry.boundingBox;
    const yS = f.rest.y + b.min.y - f.ankle.y;
    out[lr] = { hip, knee, f, hipPos: hip.position.clone(), thigh: knee.position.length(), shin: f.ankle.length(),
      heel: new THREE.Vector3(0, yS, f.rest.z + b.min.z - f.ankle.z), toe: new THREE.Vector3(0, yS, f.rest.z + b.max.z - f.ankle.z) };
    out[lr].mid = out[lr].heel.clone().add(out[lr].toe).multiplyScalar(0.5);
  }
  Object.defineProperty(g.userData, "_gaitLegs", { value: out, enumerable: false, configurable: true });
  return out;
}

/** Rest spots of a person's feet in body space (for planGait), at this height. */
export function humanFootRest(g) {
  const L = humanLegs(g);
  if (!L) return null;
  return [{ x: L.l.hipPos.x * 0.95, z: 0 }, { x: L.r.hipPos.x * 0.95, z: 0 }];   // l, r
}

/**
 * The ankle (world) of a planted foot and its pitch: the foot lands heel first (toes up, turning about the heel), lies
 * flat, then peels off over the toe (heel up, turning about the toe). The locked point never moves.
 */
function stanceFoot(L, c, t, run, fps, ground, sc) {
  const dur = c.t1 - c.t0;
  const pHS = lerp(-0.32, -0.08, run), pTO = lerp(0.6, 0.75, run);
  const tHS = Math.min(0.2 * dur, lerp(0.12, 0.05, run) * fps), tTO = Math.min(0.45 * dur, lerp(0.22, 0.12, run) * fps);
  let pitch = 0;
  if (t - c.t0 < tHS) pitch = pHS * (1 - sstep(0, tHS, t - c.t0));
  if (c.t1 - t < tTO) pitch = pTO * sstep(0, tTO, tTO - (c.t1 - t));
  return { ankle: ankleFor(L, c.p, c.yaw, pitch, ground, sc), pitch, yaw: c.yaw };
}

/** World ankle for a foot whose sole centre (flat) is at p on the ground, turned to yaw and pitched about heel/toe. */
function ankleFor(L, p, yaw, pitch, ground, sc) {
  _q.setFromAxisAngle(Y, yaw);
  const pivot = pitch < 0 ? L.heel : pitch > 0 ? L.toe : L.mid;
  // the pivot point on the ground (flat foot placed with its sole centre at p)
  const P = _v1.copy(pivot).sub(L.mid).multiplyScalar(sc).applyQuaternion(_q).add(_v2.set(p[0], ground, p[1]));
  _q2.setFromAxisAngle(X, pitch).premultiply(_q);
  return P.clone().sub(pivot.clone().multiplyScalar(sc).applyQuaternion(_q2));
}

/** Put the shoe at a world pitch / yaw (about the ankle), whatever the shin is doing. */
function setShoe(g, f, yaw, pitch) {
  f.knee.updateWorldMatrix(true, false);
  const qk = f.knee.getWorldQuaternion(new THREE.Quaternion());
  const want = new THREE.Quaternion().setFromAxisAngle(Y, yaw).multiply(_q2.setFromAxisAngle(X, pitch));
  const local = qk.invert().multiply(want);
  f.shoe.quaternion.copy(local);
  f.shoe.position.copy(f.rest).sub(f.ankle).applyQuaternion(local).add(f.ankle);
  f.shoe.updateWorldMatrix(false, false);
}

/**
 * Pose a person at frame f from their plan: body transform (yaw with pelvis twist, lean, turn lean, pelvis height),
 * both legs by IK onto their planned ankles, shoes pitched, then arms, chest, neck and head.
 * ctx: {support(x, z) -> ground y, baseY (key height), yaw (path heading)}. Returns the gait state.
 */
export function applyHuman(g, plan, f, ctx) {
  const L = humanLegs(g), J = g.userData.joints;
  if (!L || !J) return null;
  const s = new THREE.Vector3(); g.getWorldScale(s);
  const sc = s.y || 1, fps = plan.fps;
  const fi = clamp(Math.round(f), 0, plan.n - 1);
  const v = plan.speed[fi], G = plan.gaits[fi], run = G.run;
  const ph = plan.legs.map((lg) => lg.psi[fi]);
  const [psL, psR] = ph;
  const moving = v > 0.15 || plan.phase[fi] - plan.phase[Math.max(0, fi - 1)] > 1e-6;
  const move = sstep(0.05, 0.9, v);                               // upper-body motion fades in with speed
  // Lean into the turn (centripetal, about the feet) and into acceleration; a runner leans from the ankles.
  // (a walker barely banks: the full lean is a runner's; a walker turning hard on the spot stays upright)
  const turnMax = lerp(0.08, 0.38, run), turn = clamp(Math.atan2(v * plan.yawRate[fi], 9.8), -turnMax, turnMax);
  const accelLean = clamp(plan.accel[fi] * 0.025, -0.12, 0.14);
  const pelvisYaw = -lerp(0.08, 0.05, run) * move * Math.cos(TAU * psL);
  g.rotation.order = "YXZ";
  g.rotation.set(lerp(0.0, 0.11, run) * move + accelLean, ctx.yaw + pelvisYaw, -turn);
  // Pelvis: up over the stance foot when walking (vaulting over a stiff leg), down into it when running.
  const duty = G.duty;
  const bob = lerp(0.016, -0.035, run) * move * Math.cos(2 * TAU * (psL - duty / 2)) * (plan.height / 1.8);
  const crouch = lerp(0.012, 0.05, run) * move * (plan.height / 1.8);
  g.position.y = ctx.baseY + bob - crouch;
  // Legs: reset, find each ankle target, lower the pelvis if a foot is out of reach, then IK.
  for (const lr of ["l", "r"]) { L[lr].hip.rotation.set(0, 0, 0); L[lr].knee.rotation.set(0, 0, 0); }
  resetFeet(g);
  const targets = ["l", "r"].map((lr, i) => {
    const ft = footAt(plan, i, fi), Lg = L[lr];
    const gy = (c) => (ctx.support ? ctx.support(c.p[0], c.p[1]) : 0);
    if (ft.stance) return { lr, stance: true, ...stanceFoot(Lg, ft.c, fi, run, fps, gy(ft.c), sc), at: ft.c.p, ground: gy(ft.c) };
    const a = stanceFoot(Lg, ft.c, ft.c.t1, run, fps, gy(ft.c), sc), b = stanceFoot(Lg, ft.next, ft.next.t0, run, fps, gy(ft.next), sc);
    const u = ft.s, uh = sstep(0, 1, u);
    // A runner's heel comes up under the seat early in the swing (the knee folds), then the shin reaches forward.
    const lift = G.lift * Math.pow(Math.sin(Math.PI * Math.pow(u, lerp(1, 0.6, run))), lerp(1.2, 0.8, run)) * (plan.height / 1.8);
    const ankle = a.ankle.clone().lerp(b.ankle, uh);
    ankle.y = lerp(a.ankle.y, b.ankle.y, u) + lift;
    const pitch = lerp(a.pitch, b.pitch, sstep(0.1, 0.9, u)) + lerp(-0.15, 0.25, run) * Math.sin(Math.PI * u);
    return { lr, stance: false, ankle, pitch, yaw: a.yaw + wrapPi(b.yaw - a.yaw) * uh, ground: lerp(a.ankle.y, b.ankle.y, u) };
  });
  g.updateMatrixWorld(true);
  let drop = 0;
  for (const t of targets) {
    if (!t.stance) continue;                                       // a swinging foot falls short instead
    const Lg = L[t.lr], H = Lg.hip.getWorldPosition(new THREE.Vector3());
    const reach = (Lg.thigh + Lg.shin) * sc * (ctx.reach ?? 0.985), dx = t.ankle.x - H.x, dz = t.ankle.z - H.z, hz = Math.hypot(dx, dz);
    const dy = H.y - t.ankle.y;
    if (hz < reach && Math.hypot(hz, dy) > reach) drop = Math.max(drop, dy - Math.sqrt(reach * reach - hz * hz));
  }
  g.position.y -= drop;
  g.updateMatrixWorld(true);
  for (const t of targets) { legIK(g, t.lr, t.ankle, 1); setShoe(g, L[t.lr].f, t.yaw, t.pitch); }
  // Arms swing against the legs (the right arm comes forward with the left leg); a runner pumps bent elbows.
  const armA = lerp(0.12 + 0.12 * Math.min(v, 2), 0.55 + 0.05 * Math.min(v, 7), run) * move;
  const D = Math.PI / 180;
  const opp = { l: psR, r: psL };
  for (const lr of ["l", "r"]) {
    const sh = J[`${lr}_shoulder`], el = J[`${lr}_elbow`], side = lr === "l" ? 1 : -1;
    const c = Math.cos(TAU * opp[lr]);
    if (sh) { sh.rotation.order = "XYZ"; sh.rotation.set(-armA * c + 0.04 * run, 0, -side * lerp(0.04, 0.12, run) * move); }
    if (el) { el.rotation.order = "XYZ"; el.rotation.set(-(lerp(0.18 + 0.2 * Math.max(0, -c) * move, 1.45 + 0.18 * c, run * move) + 0.12 * (1 - move)), 0, 0); }
  }
  // Chest turns against the pelvis; spine leans with speed; the head stays level and nods with the footfalls.
  const twist = (lerp(7, 11, run) * move) * Math.cos(TAU * psL);
  const set = (j, x, y, z) => { if (j) { j.rotation.order = "XYZ"; j.rotation.set(x * D, y * D, z * D); } };
  const lean = lerp(3, 9 + 4 * sstep(3.5, 7, v), run) * move + clamp(plan.accel[fi], -3, 3) * 2;
  set(J.spine, lean, twist - pelvisYaw / D, turn / D * 0.35);
  set(J.neck, -lean * 0.25, -twist * 0.35, -turn / D * 0.2);
  set(J.head, -lean * 0.15 + 1.5 * move * Math.sin(2 * TAU * psL), -twist * 0.25, -turn / D * 0.15);
  g.userData.gaitOn = true;
  g.userData.gaitCycle = plan.phase[fi] * TAU;
  return { name: G.name, speed: v, moving, targets };
}

/** How high a person's origin stands above the ground with the legs straight and the soles on it (m, world). */
export function standLift(g) {
  const L = humanLegs(g), J = g?.userData?.joints, F = g && feetOf(g);
  if (!L || !J || !F?.l) return 0;
  const sc = g.scale.y || 1, ankleY = (J.l_hip.position.y + J.l_knee.position.y + F.l.ankle.y) * sc;
  return Math.max(0, -(ankleY + L.l.heel.y * sc));
}

/** Undo a person's gait pose (hips, knees and shoes as built) before something else poses them. */
export function release(g) {
  if (!g?.userData?.gaitOn) return;
  const L = humanLegs(g);
  if (L) for (const lr of ["l", "r"]) { L[lr].hip.rotation.set(0, 0, 0); L[lr].knee.rotation.set(0, 0, 0); }
  resetFeet(g);
  g.userData.gaitOn = false;
}

/** World positions of a shoe's heel and toe (bottom centre) and its sole height, for tests and the QA. */
export function shoeContact(g, lr) {
  const L = humanLegs(g);
  if (!L) return null;
  const f = L[lr].f, b = f.shoe.geometry.boundingBox;
  f.shoe.updateWorldMatrix(true, false);
  const heel = new THREE.Vector3(0, b.min.y, b.min.z).applyMatrix4(f.shoe.matrixWorld);
  const toe = new THREE.Vector3(0, b.min.y, b.max.z).applyMatrix4(f.shoe.matrixWorld);
  return { heel, toe };
}

// ------------------------------------------------------------------ horses (the rigged GLB)
const boneNamed = (root, n) => root.getObjectByName(n) || root.getObjectByName(n.replace(/[.:/[\]]/g, "")) || root.getObjectByName(n.replace(/\./g, "_"));

/**
 * Read the rigged horse's legs once it's loaded: each leg's bone chain and hoof (the _end bone), where each hoof stands
 * at rest (body space, from the Idle pose) and how high it sits, and where in each clip the left hind touches down
 * (so the clip's own body motion stays in step with the planned footfalls). g: the actor group; R: {mixer, actions}.
 */
export function rigHorse(g, model, R) {
  const legDefs = [
    ["LH", ["BackLeg.L", "BackUpperLeg.L", "BackLowerLeg.L"], "BackLowerLeg.L_end"],
    ["LF", ["FrontUpperLeg.L", "FrontLowerLeg.L"], "FrontLowerLeg.L_end"],
    ["RH", ["BackLeg.R", "BackUpperLeg.R", "BackLowerLeg.R"], "BackLowerLeg.R_end"],
    ["RF", ["FrontUpperLeg.R", "FrontLowerLeg.R"], "FrontLowerLeg.R_end"],
  ];
  const legs = [];
  for (const [id, bones, end] of legDefs) {
    const chain = bones.map((n) => boneNamed(model, n)), e = boneNamed(model, end);
    if (chain.some((b) => !b) || !e) return null;
    legs.push({ id, chain, end: e });
  }
  const neck = ["Neck1", "Neck2", "Neck3"].map((n) => boneNamed(model, n)).filter(Boolean);
  const torso = boneNamed(model, "Torso") || boneNamed(model, "Back") || boneNamed(model, "Body");
  const only = (name, t) => { for (const [n, a] of Object.entries(R.actions)) { a.enabled = n === name; a.setEffectiveWeight(n === name ? 1 : 0); if (n === name) a.time = t; } R.mixer.update(0); g.updateMatrixWorld(true); };
  const local = (o) => g.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
  if (R.actions.Idle) only("Idle", 0);
  const rest = legs.map((l) => local(l.end));
  for (const l of legs) {   // reach of each leg (straight), body units
    const pts = [...l.chain, l.end].map(local);
    l.len = pts.slice(1).reduce((n, p, i) => n + p.distanceTo(pts[i]), 0);
  }
  const torsoRest = torso ? local(torso) : null;
  const torsoFwd = torso ? torsoAxis(g, torso) : null;
  // Each clip's footfalls, leg by leg: when the hoof lands and lifts (cycle phase) and how far it sweeps back under
  // the body while planted. The plan's own footfalls then borrow each leg's pose from the matching moment of the clip.
  const sc = new THREE.Vector3(); g.getWorldScale(sc);
  const clips = {};
  for (const name of ["Walk", "Gallop"]) {
    const act = R.actions[name];
    if (!act) continue;
    const d = act.getClip().duration || 1, N = 96;
    const tr = legs.map(() => []);
    for (let i = 0; i < N; i++) { only(name, (i / N) * d); legs.forEach((l, j) => tr[j].push(local(l.end))); }
    const legInfo = tr.map((ps) => {
      const ys = ps.map((p) => p.y), lo = Math.min(...ys), hi = Math.max(...ys), thr = lo + 0.12 * (hi - lo);
      const down = ys.map((y) => y <= thr);
      let td = 0, lf = 0.5;
      for (let i = 0; i < N; i++) if (down[i] && !down[(i - 1 + N) % N]) { td = i; break; }
      for (let k = 1; k <= N; k++) if (!down[(td + k) % N]) { lf = (td + k) % N; break; }
      const duty = (((lf - td) % N) + N) % N / N || 0.5;
      const sweep = Math.max(0, (ps[td].z - ps[(lf - 1 + N) % N].z) * sc.z);
      return { td: td / N, duty, sweep };
    });
    const sw = legInfo.map((l) => l.sweep).sort((x, y) => x - y);
    clips[name] = { dur: d, legs: legInfo, sweep: (sw[1] + sw[2]) / 2 };
  }
  if (R.actions.Idle) only("Idle", 0);
  const info = { legs, rest: rest.map((p) => ({ x: p.x, z: p.z, y: p.y })), neck, torso, torsoRest, torsoFwd, clips,
    shift: Object.fromEntries(Object.entries(clips).map(([n, c]) => [n, c.legs[0].td])),
    sweep: { walk: clips.Walk?.sweep || 0, gallop: clips.Gallop?.sweep || 0 } };
  R.gait = info;
  return info;
}

function torsoAxis(g, b) {
  const q = b.getWorldQuaternion(new THREE.Quaternion()), gq = g.getWorldQuaternion(new THREE.Quaternion()).invert();
  return new THREE.Vector3(0, 0, 1).applyQuaternion(gq.multiply(q));
}

/** Rest spots of the hooves in body space, metres (LH, LF, RH, RF) for planGait; scale: the actor group's. */
export const horseFootRest = (R, scale = 1) => R?.gait ? R.gait.rest.map((p) => ({ x: p.x * scale, z: p.z * scale })) : null;

/** Map a leg's own stride phase (stance share `dp`) onto the clip's (its touchdown `td`, stance share `dc`). */
const clipPhase = (u, dp, td, dc) => frac(td + (u < dp ? (u / dp) * dc : dc + ((u - dp) / (1 - dp)) * (1 - dc)));

/**
 * Pose the rigged horse at frame f. The body, neck and tail come from the Walk / Gallop clips (cross-faded by gait,
 * in step with the stride); each LEG is posed from its own clip at the matching moment of its own stance or swing,
 * so the clips' leg shapes play out the planned footfalls (a diagonal trot, a three-beat canter, the gallop's
 * transverse four-beat). A planted hoof is then pinned to its spot (a small hinge correction about the horse's side
 * axis), fading out through the swing. Trot bounce, turn lean and a head nod go on top.
 * ctx: {support(x, z), baseY, yaw}. Returns the state the rider uses ({weights, phase, back, speed}).
 */
export function applyHorse(g, R, plan, f, ctx) {
  const info = R.gait, fi = clamp(Math.round(f), 0, plan.n - 1);
  const v = plan.speed[fi], G = plan.gaits[fi], w = G.weights, ph = plan.phase[fi];
  const sc = new THREE.Vector3(); g.getWorldScale(sc);
  const moving = plan.phase[Math.min(plan.n - 1, fi + 1)] > plan.phase[Math.max(0, fi - 1)] + 1e-6;
  const idle = moving ? 1 - sstep(0.05, 0.5, Math.max(v, 0.3)) : 1 - sstep(0.05, 0.6, v);
  const base = { Walk: (w.walk + w.trot) * (1 - idle), Gallop: (w.canter + w.gallop) * (1 - idle), Idle: idle };
  const fps = plan.fps;
  const pose = (times) => {
    for (const [n, act] of Object.entries(R.actions)) {
      const wt = times[n] != null ? base[n] || 0 : 0;
      act.enabled = wt > 1e-4;
      act.setEffectiveWeight(wt);
      const d = act.getClip().duration || 1;
      if (times[n] != null) act.time = times[n] * d;
    }
    R.mixer.update(0);
  };
  const idleT = frac(f / fps / ((R.actions.Idle?.getClip().duration) || 1));
  // Each leg from its own moment in the clip(s).
  const legPose = info.legs.map((leg, i) => {
    const u = frac(plan.legs[i].psi[fi]);
    const times = { Idle: idleT };
    for (const n of ["Walk", "Gallop"]) { const c = info.clips[n]; if (c) times[n] = clipPhase(u, G.duty, c.legs[i].td, c.legs[i].duty); }
    pose(times);
    return leg.chain.map((b) => b.quaternion.clone());
  });
  // The body from the clip at the stride phase (the left hind's moment), then the legs put back.
  const times = { Idle: idleT };
  for (const n of ["Walk", "Gallop"]) { const c = info.clips[n]; if (c) times[n] = clipPhase(frac(plan.legs[0].psi[fi]), G.duty, c.legs[0].td, c.legs[0].duty); }
  pose(times);
  info.legs.forEach((leg, i) => leg.chain.forEach((b, j) => b.quaternion.copy(legPose[i][j])));
  // Trot: the body bounces twice a stride; every gait leans into its turns.
  const turn = clamp(Math.atan2(v * plan.yawRate[fi], 9.8), -0.3, 0.3);
  g.rotation.order = "YXZ";
  g.rotation.set(0, ctx.yaw, -turn * 0.6);
  const heave = w.trot * (1 - idle) * 0.03 * plan.height * Math.cos(2 * TAU * ph);
  g.position.y = ctx.baseY + heave;
  const nod = 0.05 * w.trot * (1 - idle) * Math.sin(2 * TAU * ph);
  for (const b of info.neck) b.rotateX(nod / Math.max(1, info.neck.length));
  g.updateMatrixWorld(true);
  // A hoof planted further out than the leg reaches pulls the body down onto it (at a fast gallop the stride's
  // ends): lower the barrel just enough, never more than a tenth of the height.
  // (Weighted as the hooves are pinned below, easing on and off their spots: the body never drops or bounces up by
  // a hand's breadth in one frame as a hoof lifts.)
  let drop = 0;
  info.legs.forEach((leg, i) => {
    const ft = footAt(plan, i, fi);
    const wt = ft.stance ? 1 : ft.s < 0.2 ? 1 - sstep(0, 0.2, ft.s) : ft.s > 0.85 ? sstep(0.85, 1, ft.s) : 0;
    if (wt <= 0) return;
    const c = ft.stance || ft.s < 0.2 ? ft.c : ft.next;
    const P = leg.chain[0].getWorldPosition(new THREE.Vector3());
    const ty = (ctx.support ? ctx.support(c.p[0], c.p[1]) : 0) + Math.max(0, info.rest[i].y * sc.y);
    const reach = leg.len * sc.y * 0.97, hz = Math.hypot(P.x - c.p[0], P.z - c.p[1]);
    if (hz < reach) drop = Math.max(drop, wt * (P.y - ty - Math.sqrt(reach * reach - hz * hz)));
  });
  if (drop > 0) { g.position.y -= Math.min(drop, 0.1 * plan.height); g.updateMatrixWorld(true); }
  // Pin planted hooves (and ease them on and off their spots at the ends of the swing).
  const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const out = [];
  info.legs.forEach((leg, i) => {
    const ft = footAt(plan, i, fi);
    const gy = (c) => (ctx.support ? ctx.support(c.p[0], c.p[1]) : 0) + Math.max(0, info.rest[i].y * sc.y);
    let T = null, wt = 0;
    if (ft.stance) { T = new THREE.Vector3(ft.c.p[0], gy(ft.c), ft.c.p[1]); wt = 1 - idle * 0.5; }
    else if (ft.s < 0.2) { T = new THREE.Vector3(ft.c.p[0], gy(ft.c), ft.c.p[1]); wt = 1 - sstep(0, 0.2, ft.s); }
    else if (ft.s > 0.85) { T = new THREE.Vector3(ft.next.p[0], gy(ft.next), ft.next.p[1]); wt = sstep(0.85, 1, ft.s); }
    if (T && wt > 0.001) {
      const E = leg.end.getWorldPosition(new THREE.Vector3());
      if (!ft.stance) T.y = Math.max(T.y, E.y);                   // easing on/off: never drag the hoof down early
      const before = leg.chain.map((b) => b.quaternion.clone());
      ccdLeg(leg, T, axis);
      if (wt < 1) { leg.chain.forEach((b, j) => b.quaternion.copy(before[j].slerp(b.quaternion, wt))); leg.chain[0].updateMatrixWorld(true); }
    }
    out.push({ id: leg.id, stance: ft.stance, target: T });
  });
  // The back the rider sits on: how far the clip has moved it from rest (body space) and how it pitches.
  let back = { dx: 0, dy: 0, dz: 0, pitch: 0 };
  if (info.torso) {
    const p = g.worldToLocal(info.torso.getWorldPosition(new THREE.Vector3()));
    const fwd = torsoAxis(g, info.torso);
    const pitch = Math.atan2(-fwd.y, Math.hypot(fwd.x, fwd.z)) - Math.atan2(-info.torsoFwd.y, Math.hypot(info.torsoFwd.x, info.torsoFwd.z));
    back = { dx: (p.x - info.torsoRest.x) * sc.x, dy: (p.y - info.torsoRest.y) * sc.y + heave - Math.min(drop, 0.1 * plan.height), dz: (p.z - info.torsoRest.z) * sc.z, pitch };
  }
  const state = { name: G.name, weights: w, idle, phase: ph, speed: v, heave, drop, back, hooves: out };
  g.userData.horseGait = state;
  g.userData.gaitCycle = ph * TAU;
  return state;
}

/** Bend a leg chain about one world axis (the horse's side) so its end reaches T; small hinge steps, deterministic. */
function ccdLeg(leg, T, axis) {
  const E = new THREE.Vector3(), P = new THREE.Vector3(), e = new THREE.Vector3(), t = new THREE.Vector3(), q = new THREE.Quaternion();
  const wq = new THREE.Quaternion(), pq = new THREE.Quaternion(), ax = new THREE.Vector3();
  const turned = leg.chain.map(() => 0), free = leg.chain.map(() => 0);
  const rotate = (b, ax, ang) => {
    q.setFromAxisAngle(ax, ang);
    b.getWorldQuaternion(wq);
    b.parent.getWorldQuaternion(pq);
    b.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
    b.updateMatrixWorld(true);
  };
  // In the leg's own plane first (about the horse's side axis: knees and hocks keep bending the way they bend)...
  for (let it = 0; it < 20; it++) {
    for (let j = leg.chain.length - 1; j >= 0; j--) {
      const b = leg.chain[j];
      b.getWorldPosition(P); leg.end.getWorldPosition(E);
      e.subVectors(E, P); t.subVectors(T, P);
      e.addScaledVector(axis, -e.dot(axis)); t.addScaledVector(axis, -t.dot(axis));
      if (e.lengthSq() < 1e-8 || t.lengthSq() < 1e-8) continue;
      let ang = clamp(Math.atan2(axis.dot(_v1.crossVectors(e, t)), e.dot(t)), -0.35, 0.35);
      ang = clamp(turned[j] + ang, -1, 1) - turned[j];           // a correction, never a full re-pose
      turned[j] += ang;
      rotate(b, axis, ang);
    }
    leg.end.getWorldPosition(E);
    if (E.distanceToSquared(T) < 1e-6) return;
  }
  // ...then a small free swing for what's left (the clip's leg sits a little in or out of where the hoof plants).
  for (let it = 0; it < 6; it++) {
    for (let j = 0; j < leg.chain.length; j++) {
      const b = leg.chain[j];
      b.getWorldPosition(P); leg.end.getWorldPosition(E);
      e.subVectors(E, P); t.subVectors(T, P);
      ax.crossVectors(e, t);
      if (ax.lengthSq() < 1e-10) continue;
      ax.normalize();
      let ang = Math.min(e.angleTo(t), 0.2 - free[j]);
      if (ang <= 0) continue;
      free[j] += ang;
      rotate(b, ax, ang);
    }
    leg.end.getWorldPosition(E);
    if (E.distanceToSquared(T) < 1e-6) return;
  }
}

/**
 * How a rider moves with the horse's gait: walk = sit and follow; trot = post (rise on one diagonal, sit the other);
 * canter = sit deep and swing with it; gallop = two-point (up off the seat, folded over the neck, knees soaking up
 * the bound so the head stays quieter than the horse's back). h: the rider's height. Returns body-space offsets.
 */
export function riderMotion(state, h = 1.8) {
  if (!state) return { lean: 0, lift: 0, pitch: 0, absorb: 0, knee: 0, hip: 0, reach: 0 };
  const w = state.weights, m = 1 - state.idle, ph = state.phase;
  const post = w.trot * m * 0.075 * h * Math.max(0, Math.sin(TAU * ph + 0.4));
  const two = w.gallop * m;
  return {
    lean: m * (0.06 * w.walk + 0.2 * w.trot + 0.16 * w.canter + 0.62 * w.gallop),
    lift: post + two * h * (0.065 + 0.012 * Math.sin(TAU * ph)) + w.canter * m * 0.012 * h * Math.sin(TAU * ph),
    pitch: m * (0.04 * w.walk * Math.sin(2 * TAU * ph) + 0.07 * w.canter * Math.sin(TAU * ph + 0.3) + 0.04 * two * Math.sin(TAU * ph + 1.2)),
    absorb: 0.25 * w.walk + 0.15 * w.trot + 0.45 * w.canter + 0.8 * two,   // share of the back's heave the rider soaks up
    knee: 0.25 * w.trot * m + 0.5 * two, hip: -0.12 * w.trot * m - 0.22 * two, reach: two,
  };
}

// ------------------------------------------------------------------ getting on and off a horse
//
// The real thing (a rider mounting from the ground on the near side, after reference): stand at the near side by the
// stirrup, turned to the saddle (a stepped pivot, one foot at a time, no skating), left hand on the horn (pommel),
// right hand on the cantle. Lift the near (left) foot into the stirrup with the knee turned out toward the horse's
// shoulder, the toe toward its shoulder (not into its ribs). One bounce on the off (right) foot, then spring up off it
// and stand in the stirrup, the hips kept out from the horse until they are above its back. Turn to the front, lean
// over the withers and swing the off leg back over the croup LOW: a near-straight pendulum from its own hip, knee soft,
// the boot just clearing the croup (a high kick is the green rider's fault). Then sit down softly while the off foot
// finds its stirrup. The near foot stays in the stirrup from going in to sitting down. Getting off is the real
// reverse: off foot out of its stirrup, weight in the near stirrup, stand, swing the off leg back over the croup, lower
// down the near side on a bending near knee with the off foot reaching for the ground, step down on it, then take the
// near foot out of the stirrup.
//
// Placed from targets (the pelvis path, both ankles, both wrists, which way each knee and elbow points) with two-bone
// IK in the horse's frame (+Z ahead, +X its left, the near side), so it holds for any rider, horse size and heading.
// The horse's own shape (horseProfile: the back line and the body's width, measured off the horse actually shown, the
// clay one or the rigged one) sets the croup the leg clears, the horn and the cantle. The stirrups at the end are where
// the ride pose puts the feet (forward kinematics of humans.mjs's "ride"), so the climb ends exactly in the ride pose.
// While climbing, the near stirrup hangs lower (let down to the rider's hip height, as short riders do), so nobody
// does a split to reach it; it comes up to the ride length as they settle.

/** Monotone cubic (PCHIP) through keys ts / vs at t: no dead stop at inner keys, no overshoot, at rest at both ends. */
function pchip(ts, vs, t) {
  const n = ts.length;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[n - 1]) return vs[n - 1];
  let i = 0;
  while (t > ts[i + 1]) i++;
  const h = (k) => ts[k + 1] - ts[k], d = (k) => (vs[k + 1] - vs[k]) / h(k);
  const m = (k) => {
    if (k === 0 || k === n - 1) return 0;
    const d0 = d(k - 1), d1 = d(k);
    if (d0 * d1 <= 0) return 0;
    const h0 = h(k - 1), h1 = h(k);
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
  };
  const hi = h(i), u = (t - ts[i]) / hi, u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * vs[i] + (u3 - 2 * u2 + u) * hi * m(i) + (3 * u2 - 2 * u3) * vs[i + 1] + (u3 - u2) * hi * m(i + 1);
}
/** A smooth track through [t, value] keys (value a number or an array, per component): see pchip. */
export function trackAt(keys, t) {
  const ts = keys.map((k) => k[0]);
  return Array.isArray(keys[0][1]) ? keys[0][1].map((_, c) => pchip(ts, keys.map((k) => k[1][c]), t)) : pchip(ts, keys.map((k) => k[1]), t);
}

/** How long getting on and off take (seconds): a working rider is up from the ground in about two seconds (1.8 to
 *  2.4; 2.4 here, the most the spring, the hips over the back before the leg crosses and a soft seat need) and down in
 *  about two. */
export const MOUNT_SECONDS = 2.4;
export const DISMOUNT_SECONDS = 2.0;
/** Frames getting on / off take at a shot's frame rate. */
export const mountFrames = (fps = 24) => Math.max(1, Math.round(MOUNT_SECONDS * fps));
export const dismountFrames = (fps = 24) => Math.max(1, Math.round(DISMOUNT_SECONDS * fps));
/** The same at 24 fps. */
export const MOUNT_FRAMES = mountFrames(24);
export const DISMOUNT_FRAMES = dismountFrames(24);
/** Which way the rider faces at the stirrup before the climb: at the saddle, a little toward the horse's head
 *  (relative to the horse's heading; -pi/2 would face its side square on). */
export const MOUNT_FACE = -1.2;

// ---------- the horse's shape

const PZ0 = -1.5, PZ1 = 1.3, PY0 = 0.5, PY1 = 2.6, PD = 0.05;
const NZ = Math.round((PZ1 - PZ0) / PD) + 1, NY = Math.round((PY1 - PY0) / PD) + 1;
/** Fill empty bins (-1) of a row from their nearest filled neighbours, then dilate by one bin (conservative). */
function fillRow(a, n, stride = 1, off = 0, dilate = true) {
  const v = Array.from({ length: n }, (_, i) => a[off + i * stride]);
  const out = v.slice();
  for (let i = 0; i < n; i++) if (v[i] < 0) {
    let l = i - 1, r = i + 1;
    while (l >= 0 && v[l] < 0) l--;
    while (r < n && v[r] < 0) r++;
    if (l >= 0 && r < n && r - l <= 4) out[i] = Math.max(v[l], v[r]);
  }
  for (let i = 0; i < n; i++) a[off + i * stride] = dilate ? Math.max(out[i], out[i - 1] ?? -1, out[i + 1] ?? -1) : out[i];
}
function newProfile() { return { top: new Float32Array(NZ).fill(-1), hw: new Float32Array(NY * NZ).fill(-1) }; }
function profileAdd(P, x, y, z) {
  const iz = Math.round((z - PZ0) / PD);
  if (iz < 0 || iz >= NZ) return;
  x = Math.abs(x);
  if (x < 0.12 && y > P.top[iz]) P.top[iz] = y;
  const iy = Math.round((y - PY0) / PD);
  if (iy < 0 || iy >= NY) return;
  if (x > P.hw[iy * NZ + iz]) P.hw[iy * NZ + iz] = x;
}
function profileDone(P) {
  // (hwFine: the half-widths with the holes filled but not dilated, for the clearances measured close: hwAt, surfaceTop)
  P.hwFine = P.hw.slice();
  for (let iy = 0; iy < NY; iy++) fillRow(P.hwFine, NZ, 1, iy * NZ, false);
  for (let iz = 0; iz < NZ; iz++) fillRow(P.hwFine, NY, NZ, iz, false);
  fillRow(P.top, NZ);
  for (let iy = 0; iy < NY; iy++) fillRow(P.hw, NZ, 1, iy * NZ);
  for (let iz = 0; iz < NZ; iz++) fillRow(P.hw, NY, NZ, iz);
  return P;
}
/**
 * The shape of a horse as shown (the built clay one or the rigged GLB, posed as it stands), measured off its meshes in
 * its own frame and divided by k (its scale against the 1.6 m horse): the top of the back along its length and the
 * half-width of the body at each height. hg: the horse's group; skip: objects to leave out (the clay's swinging legs).
 * Measure it once per horse (it walks every triangle).
 */
export function horseProfile(hg, k = 1, skip = null) {
  const P = newProfile();
  hg.updateMatrixWorld(true);
  const O = hg.getWorldPosition(new THREE.Vector3()), qi = hg.getWorldQuaternion(new THREE.Quaternion()).invert();
  const shown = (o) => { for (let p = o; p && p !== hg.parent; p = p.parent) if (!p.visible || skip?.has(p)) return false; return true; };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
  hg.traverse((o) => {
    if (!o.isMesh || !shown(o) || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    const W = (i, v) => { o.getVertexPosition(idx ? idx.getX(i) : i, v); return v.applyMatrix4(o.matrixWorld).sub(O).applyQuaternion(qi).divideScalar(k); };
    for (let i = 0; i + 2 < n; i += 3) {
      W(i, a); W(i + 1, b); W(i + 2, c);
      const e = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      const m = clamp(Math.ceil(e / 0.03), 1, 16);
      for (let u = 0; u <= m; u++) for (let v = 0; u + v <= m; v++) {
        const w = m - u - v;
        p.set((a.x * u + b.x * v + c.x * w) / m, (a.y * u + b.y * v + c.y * w) / m, (a.z * u + b.z * v + c.z * w) / m);
        profileAdd(P, p.x, p.y, p.z);
      }
    }
  });
  return profileDone(P);
}
/** The clay horse's shape (library.mjs, k = 1) from its primitives: the profile used when none is given. */
export const CLAY_HORSE_PROFILE = (() => {
  const P = newProfile();
  // [centre y, centre z, radius x, radius y, radius z]: chest, hindquarters, withers; the barrel is a capsule.
  const ell = [[1.25, 0.5, 0.258, 0.315, 0.375], [1.28, -0.5, 0.3136, 0.32, 0.416], [1.47, 0.4, 0.12, 0.16, 0.26]];
  for (let iz = 0; iz < NZ; iz++) for (let iy = 0; iy < NY; iy++) {
    const z = PZ0 + iz * PD, y = PY0 + iy * PD;
    let w = -1;
    const zc = clamp(z, -0.45, 0.45), r2 = 0.29 * 0.29 - (y - 1.23) ** 2 - (z - zc) ** 2;
    if (r2 > 0) w = Math.max(w, 0.88 * Math.sqrt(r2));
    for (const [cy, cz, rx, ry, rz] of ell) {
      const q = 1 - ((y - cy) / ry) ** 2 - ((z - cz) / rz) ** 2;
      if (q > 0) w = Math.max(w, rx * Math.sqrt(q));
    }
    // the neck: a tapering tube from the withers (1.43, 0.62) up to the poll (2.01, 1.05)
    const ax = [2.01 - 1.43, 1.05 - 0.62], L = Math.hypot(ax[0], ax[1]);
    const u = clamp(((y - 1.43) * ax[0] + (z - 0.62) * ax[1]) / (L * L), 0, 1);
    const dy = y - (1.43 + u * ax[0]), dz = z - (0.62 + u * ax[1]), rr = 0.21 + (0.11 - 0.21) * u;
    const q2 = rr * rr - dy * dy - dz * dz;
    if (q2 > 0) w = Math.max(w, Math.sqrt(q2));
    if (w >= 0) { P.hw[iy * NZ + iz] = w; if (y > P.top[iz]) P.top[iz] = y; }
  }
  return profileDone(P);
})();
/** Top of the back at z (k units), the highest over z0..z1 when given a span. */
/** How much higher a horse's back is at the seat than the clay horse's (k units: x k for metres): the seat humans.mjs
 *  MOUNTS.horse gives was set on the clay horse, so a rider on another horse (the rigged one sits 13-14 cm higher at the
 *  saddle) sits this much higher. 0 for the clay horse itself. */
export function seatRaise(prof) {
  if (!prof || prof === CLAY_HORSE_PROFILE) return 0;
  return backTop(prof, -0.1, 0) - backTop(CLAY_HORSE_PROFILE, -0.1, 0);
}
function backTop(prof, z, z1 = z) {
  let m = -1;
  for (let iz = Math.max(0, Math.floor((Math.min(z, z1) - PZ0) / PD)); iz <= Math.min(NZ - 1, Math.ceil((Math.max(z, z1) - PZ0) / PD)); iz++) m = Math.max(m, prof.top[iz]);
  return m;
}
/** Half-width of the body at height y over z0..z1 (k units): the widest, -1 where there is no body. */
function bodyHalf(prof, y, z0, z1 = z0) {
  const iy = Math.round((y - PY0) / PD);
  if (iy < 0 || iy >= NY) return -1;
  let m = -1;
  for (let iz = Math.max(0, Math.floor((Math.min(z0, z1) - PZ0) / PD)); iz <= Math.min(NZ - 1, Math.ceil((Math.max(z0, z1) - PZ0) / PD)); iz++) m = Math.max(m, prof.hw[iy * NZ + iz]);
  return m;
}
/** Half-width of the body at (y, z) (k units), bilinear across the bins (continuous; below 0 off the body). */
function hwAt(prof, y, z) {
  const fy = (y - PY0) / PD, fz = (z - PZ0) / PD, iy = Math.floor(fy), iz = Math.floor(fz), u = fy - iy, v = fz - iz;
  const hw = prof.hwFine || prof.hw, h = (a, b) => (a < 0 || a >= NY || b < 0 || b >= NZ ? -0.05 : Math.max(-0.05, hw[a * NZ + b]));
  return lerp(lerp(h(iy, iz), h(iy, iz + 1), v), lerp(h(iy + 1, iz), h(iy + 1, iz + 1), v), u);
}
/** The top of the body at (x, z) (k units): the highest point over that spot, -Infinity off the body. Continuous in x
 *  and z (linear across the bins), so a foot kept above it never jumps. */
function surfaceTop(prof, x, z) {
  const ax = Math.abs(x), fz = (z - PZ0) / PD, i0 = Math.floor(fz), u = fz - i0, hw = prof.hwFine || prof.hw;
  const col = (iz) => {
    if (iz < 0 || iz >= NZ) return -Infinity;
    for (let iy = NY - 1; iy >= 0; iy--) {
      const w = hw[iy * NZ + iz];
      if (w < ax) continue;
      const w1 = iy + 1 < NY ? Math.max(0, hw[(iy + 1) * NZ + iz]) : 0;
      return PY0 + iy * PD + (w > w1 ? PD * Math.min(1, (w - ax) / (w - w1)) : 0);
    }
    return -Infinity;
  };
  const a = col(i0), b = col(i0 + 1);
  if (a === -Infinity && b === -Infinity) return -Infinity;
  // (off the end of the body on one side: fall away over a bin rather than step)
  return lerp(a === -Infinity ? b - PD * 4 : a, b === -Infinity ? a - PD * 4 : b, u);
}

// ---------- the rider's limbs: two-bone IK with a pole (which way the knee or elbow points)

const _b1 = new THREE.Matrix4(), _b2 = new THREE.Matrix4();
/**
 * Bend root (hip / shoulder) and mid (knee / elbow) so the end (ankle / wrist, `endLocal` in mid's space) reaches
 * target (world) with the mid joint toward `pole` (a world direction). bend: +1 the knee (shin folds back), -1 the
 * elbow. w: blend from the pose as seeded (0) to the solve (1). Returns the bend angle.
 */
function limbTo(g, root, mid, endLocal, target, pole, bend, w = 1) {
  if (w <= 0) return 0;
  g.updateMatrixWorld(true);
  const sc = new THREE.Vector3(); g.getWorldScale(sc);
  const A = mid.position.clone().multiply(sc), E = endLocal.clone().multiply(sc);
  const H = root.getWorldPosition(new THREE.Vector3());
  const want = target.clone().sub(H);
  const spanAt = (th) => A.clone().add(E.clone().applyAxisAngle(X, bend * th)).length();
  const d = clamp(want.length(), spanAt(2.6) + 1e-4, spanAt(0) - 1e-5);
  let lo = 0, hi = 2.6;
  for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (spanAt(m) > d) lo = m; else hi = m; }
  const th = (lo + hi) / 2;
  const q0r = root.quaternion.clone(), q0m = mid.quaternion.clone();
  const qm = new THREE.Quaternion().setFromAxisAngle(X, bend * th);
  // In the root's own frame (rotation identity): where the end and the mid joint are.
  const El = A.clone().add(E.clone().applyQuaternion(qm)), u1 = El.clone().normalize();
  const v1 = A.clone().sub(u1.clone().multiplyScalar(A.dot(u1))).normalize(), w1 = u1.clone().cross(v1);
  const u2 = want.lengthSq() > 1e-12 ? want.clone().normalize() : u1.clone();
  let v2 = pole.clone().sub(u2.clone().multiplyScalar(pole.dot(u2)));
  if (v2.lengthSq() < 1e-8) v2 = new THREE.Vector3(0, 0, 1).sub(u2.clone().multiplyScalar(u2.z));
  v2.normalize();
  const w2 = u2.clone().cross(v2);
  _b1.makeBasis(u1, v1, w1); _b2.makeBasis(u2, v2, w2);
  const qW = new THREE.Quaternion().setFromRotationMatrix(_b2.multiply(_b1.transpose()));
  const parentW = root.parent.getWorldQuaternion(new THREE.Quaternion());
  root.quaternion.copy(parentW.invert().multiply(qW));
  mid.quaternion.copy(qm);
  if (w < 1) { root.quaternion.copy(q0r.slerp(root.quaternion, w)); mid.quaternion.copy(q0m.slerp(mid.quaternion, w)); }
  g.updateMatrixWorld(true);
  return th;
}
const legTo = (g, R, lr, target, pole, w = 1) => limbTo(g, R.J[`${lr}_hip`], R.J[`${lr}_knee`], R.F[lr].ankle, target, pole, 1, w);
const armTo = (g, R, lr, target, pole, w = 1) => limbTo(g, R.J[`${lr}_shoulder`], R.J[`${lr}_elbow`], R.J[`${lr}_wrist`].position, target, pole, -1, w);

/** Turn a shoe about its ankle to a world orientation (the clay has no ankle joint: the shoe rides the shin). */
function shoeTo(R, lr, qWorld) {
  const f = R.F[lr];
  f.knee.updateWorldMatrix(true, false);
  const qk = f.knee.getWorldQuaternion(new THREE.Quaternion());
  const local = qk.invert().multiply(qWorld);
  f.shoe.quaternion.copy(local);
  f.shoe.position.copy(f.rest).sub(f.ankle).applyQuaternion(local).add(f.ankle);
  f.shoe.updateWorldMatrix(false, false);
}
/** A shoe's world orientation: flat facing world yaw `yaw` with the heel up `heel` rad (toe down). */
const qFlat = (yaw, heel = 0) => new THREE.Quaternion().setFromAxisAngle(Y, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(X, heel));
/** A shoe's world orientation along its shin, pointed `point` rad (0 = as built, square to the shin). */
const qShin = (R, lr, point) => { R.F[lr].knee.updateWorldMatrix(true, false); return R.F[lr].knee.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().setFromAxisAngle(X, point)); };

// ---------- the rider and the horse, in the horse's frame

const RIDE_HIP_X = -1.1, RIDE_HIP_Z = 0.45, RIDE_KNEE = 1.3, RIDE_SHOULDER = -0.25, RIDE_ELBOW = -0.75;
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const add3 = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const n = len3(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const fwdOf = (psi) => [Math.sin(psi), 0, Math.cos(psi)];
const leftOf = (psi) => [Math.cos(psi), 0, -Math.sin(psi)];

/** Pose the limbs as humans.mjs's ride pose writes them (and the spine, neck and head straight). */
function ridePose(g, arms = true) {
  for (const l of g.userData.limbs || []) {
    if (l.part === "hip") l.pivot.rotation.set(RIDE_HIP_X, 0, l.side * RIDE_HIP_Z);
    else if (l.part === "knee") l.pivot.rotation.set(RIDE_KNEE, 0, 0);
    else if (arms && l.part === "shoulder") l.pivot.rotation.set(RIDE_SHOULDER, 0, -l.side * 0.08);
    else if (arms && l.part === "elbow") l.pivot.rotation.set(RIDE_ELBOW, 0, 0);
  }
}
/** Seed every limb: legs straight, arms blended from hanging (0) to the ride pose's rein hands (1). */
function seedLimbs(g, armsRide) {
  for (const l of g.userData.limbs || []) {
    if (l.part === "hip" || l.part === "knee") l.pivot.rotation.set(0, 0, 0);
    else if (l.part === "shoulder") l.pivot.rotation.set(RIDE_SHOULDER * armsRide, 0, -l.side * 0.08 * armsRide);
    else if (l.part === "elbow") l.pivot.rotation.set(RIDE_ELBOW * armsRide, 0, 0);
  }
  for (const jn of ["spine", "neck", "head"]) g.userData.joints?.[jn]?.rotation.set(0, 0, 0);
}

/**
 * Everything the climb is laid out from (horse frame, metres): the rider's measurements, the ride pose's stirrups
 * (S), wrists (Wr), knees (Kr) and seated pelvis (Q); the stirrup they climb with (Sc), the spot they stand at (C0, facing
 * face), their feet there (G), the pelvis standing in the stirrup (Ptop) and over the saddle (Pover), the horn and the
 * cantle, the croup the off leg clears (yc: its ankle height there, zc: where), and whether this rider can get up on
 * this horse from the ground at all (ok). o: see applyMount.
 */
function mountFrame(g, o) {
  const J = g.userData.joints, F = feetOf(g), sc = g.scale.y;
  const yaw = o.yaw || 0, k = o.k || 1, c = Math.cos(yaw), sn = Math.sin(yaw), H = o.horse;
  const prof = o.profile || CLAY_HORSE_PROFILE;
  const toW = (v) => new THREE.Vector3(H.x + v[0] * c + v[2] * sn, H.y + v[1], H.z - v[0] * sn + v[2] * c);
  const toL = (w) => { const x = w.x - H.x, z = w.z - H.z; return [x * c - z * sn, w.y - H.y, x * sn + z * c]; };
  const dirW = (v) => new THREE.Vector3(v[0] * c + v[2] * sn, v[1], -v[0] * sn + v[2] * c);   // a direction, horse frame -> world
  const hipY = J.l_hip.position.y * sc, hipX = Math.abs(J.l_hip.position.x) * sc;
  const thigh = J.l_knee.position.length() * sc, shin = F.l.ankle.length() * sc, span = thigh + shin;
  const s = (o.h || 1.8) / 1.8;
  // Standing: the ankle under the hip, the sole on the ground (the origin lifted so the sole touches it, as the walk
  // gait stands people).
  const L = humanLegs(g);
  const ankleY = (J.l_hip.position.y + J.l_knee.position.y + F.l.ankle.y) * sc;
  const soleY = ankleY + (L ? L.l.heel.y * sc : -0.08 * s);
  const lift = Math.max(0, -soleY);
  // The ground they stand on (horse frame): o.ground (world) when the stage gives it, else the horse's base height. (A
  // rigged horse's origin idles a couple of cm under the ground: the climb is laid out on the ground, not on it.)
  const gy = o.ground != null ? o.ground - H.y : 0;
  // The ride pose at the seat (forward kinematics): its ankles are the stirrups, its wrists the rein hands.
  g.rotation.order = "YXZ";
  g.rotation.set(0, yaw, 0);
  g.position.copy(o.seatPos);
  ridePose(g);
  resetFeet(g);
  for (const jn of ["spine", "neck", "head"]) J[jn]?.rotation.set(0, 0, 0);
  g.updateMatrixWorld(true);
  const S = { l: toL(footState(g, "l").ankle), r: toL(footState(g, "r").ankle) };
  const Kr = { l: toL(J.l_knee.getWorldPosition(new THREE.Vector3())), r: toL(J.r_knee.getWorldPosition(new THREE.Vector3())) };
  const Hr = { l: toL(J.l_hip.getWorldPosition(new THREE.Vector3())), r: toL(J.r_hip.getWorldPosition(new THREE.Vector3())) };
  // Which way the ride pose's knees point (off the hip-ankle line): the IK aims them there as they sit, so the solve
  // lands exactly on the ride pose.
  const kneePole = (lr) => { const a = Hr[lr], u = norm3([S[lr][0] - a[0], S[lr][1] - a[1], S[lr][2] - a[2]]), v = [Kr[lr][0] - a[0], Kr[lr][1] - a[1], Kr[lr][2] - a[2]];
    const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; return norm3([v[0] - d * u[0], v[1] - d * u[1], v[2] - d * u[2]]); };
  const rideKnee = { l: kneePole("l"), r: kneePole("r") };
  const seat = toL(o.seatPos);
  const Q = [seat[0], seat[1] + hipY, seat[2]];                 // the pelvis seated
  const standHip = gy + lift + hipY;
  const back = backTop(prof, seat[2] / k - 0.1, seat[2] / k + 0.1) * k;
  // The stirrup for the climb: the ride stirrup let down to the rider's hip height (the knee turns out to it, no
  // split), but no lower than lets the hips reach the back when they stand in it.
  // (A short rider keeps it a little higher, up to a hand above the hip, so standing in it gets the hips over the back.)
  const need = back + 0.06 * k - 0.975 * span;
  const Sc = [S.l[0] + 0.02 * k, Math.min(S.l[1], clamp(need, standHip - 0.03 * s, standHip + 0.08 * s)), S.l[2] - 0.04 * k];
  Sc[0] = Math.max(Sc[0], bodyHalf(prof, Sc[1] / k, Sc[2] / k - 0.15, Sc[2] / k + 0.15) * k + 0.07 * s);
  // Where they stand: facing the saddle, the stirrup ahead and to the left of the near hip, a long step away (the
  // knee goes out to it, not up into the chest), the pelvis close enough to the horse for the hands to reach.
  const face = MOUNT_FACE, f0 = fwdOf(face), l0 = leftOf(face);
  const step = 0.58 * span, side = 0.85;                       // the stirrup ~50 deg left of straight ahead
  const nh = [Sc[0] - step * (Math.cos(side) * f0[0] + Math.sin(side) * l0[0]), 0, Sc[2] - step * (Math.cos(side) * f0[2] + Math.sin(side) * l0[2])];
  const C0 = [nh[0] - hipX * l0[0], standHip, nh[2] - hipX * l0[2]];
  const ankle0 = gy + lift + ankleY;
  const G = { l: [C0[0] + hipX * l0[0], ankle0, C0[2] + hipX * l0[2]], r: [C0[0] - hipX * l0[0], ankle0, C0[2] - hipX * l0[2]] };
  // Standing in the stirrup: the near leg straight, the hips out over the near side until they are above the back (the
  // pelvis at least 0.4 m out), turned part way to the front.
  const faceTop = -1.05, lt = leftOf(faceTop);
  const outX = Math.max(0.42 * k, Sc[0] + 0.06 * s);
  const nhTop = [outX + hipX * lt[0], 0, Sc[2] - 0.02 * k];
  const reachY = Math.sqrt(Math.max(0, (0.975 * span) ** 2 - (nhTop[0] - Sc[0]) ** 2 - (nhTop[2] - Sc[2]) ** 2));
  const Ptop = [outX, Sc[1] + reachY, nhTop[2] - hipX * lt[2]];
  // The bounce is a hop on the off foot toward the horse: it lands under the hips' way up (so the spring goes up, not
  // across, and the legs stay together), the pelvis over it as before.
  const Hp = [Math.max(Ptop[0] + 0.04 * s, bodyHalf(prof, 0.6, Ptop[2] / k - 0.45, Ptop[2] / k) * k + 0.16 * s), ankle0, Ptop[2] - 0.46 * s];
  const Pb = [Hp[0] + 0.7 * (C0[0] - G.r[0]), standHip, Hp[2] + 0.7 * (C0[2] - G.r[2])];
  // The croup the off leg swings over, just behind the cantle: its highest point where the boot crosses, plus the boot.
  const zc = -0.5 * k;
  const croup = backTop(prof, zc / k - 0.15, zc / k + 0.1) * k;
  const yc = croup + 0.07 * s + 0.035;
  // Over the saddle while the leg comes over: hips above the near edge of the back.
  const Pover = [0.08 * k, Math.max(Ptop[1] - 0.03 * s, back + 0.08 * s), 0.5 * (Ptop[2] + Q[2])];
  // Hands: the horn over the withers, the cantle behind the seat (a hand's breadth above the back), and the off side of
  // the horn for the right hand once the leg is coming over.
  // (A Western horn stands a hand or so above the withers, the cantle a little above the back behind the seat.)
  const hornZ = seat[2] + 0.2 * k, cantZ = seat[2] - 0.27 * k;
  const horn = [0.05 * k, Math.max(backTop(prof, hornZ / k - 0.03, hornZ / k + 0.03) * k + 0.06 * k, back + 0.14 * k), hornZ];
  const cantle = [0.07 * k, Math.max(backTop(prof, cantZ / k - 0.06, cantZ / k + 0.06) * k + 0.08 * k, back + 0.1 * k), cantZ];
  const hornOff = [-0.06 * k, horn[1] - 0.01 * k, horn[2] - 0.02 * k];
  // A short rider (or a tall horse) can't reach the top of the horn from the ground: the hand takes the pommel lower
  // down its near side (the swell), and the cantle lower down the near side of the seat, and keeps that hold.
  // (on the saddle's side, a saddle's thickness out from the horse: never a hold inside its withers or its back)
  const onSide = (q) => { q[0] = Math.max(q[0], hwAt(prof, q[1] / k, q[2] / k) * k + 0.06 * k); return q; };
  const hornLow = onSide([0.17 * k, horn[1] - 0.24 * k, horn[2] - 0.02 * k]), cantLow = onSide([0.2 * k, cantle[1] - 0.18 * k, cantle[2]]);
  // (and further down the near side of the saddle, on its skirt, the lowest a hand keeps hold at)
  const skirt = (lo, hi) => { const p = add3(lo, add3(lo, hi, -1), 0.6); p[0] = Math.max(p[0], hwAt(prof, p[1] / k, p[2] / k) * k + 0.05 * k); return p; };
  const hornLow2 = skirt(hornLow, horn), cantLow2 = skirt(cantLow, cantle);
  const sh = J.l_shoulder, shY = (sh.userData.absY ?? (J.spine.position.y + sh.position.y)) * sc - hipY, shX = Math.abs(sh.position.x) * sc;
  const arm = (J.l_elbow.position.length() + J.l_wrist.position.length()) * sc;
  const shoulderAt = (P, psi, lean, side) => { const v = new THREE.Vector3(side * shX, shY, 0).applyEuler(new THREE.Euler(lean, psi, 0, "YXZ")); return [P[0] + v.x, P[1] + v.y, P[2] + v.z]; };
  const holdOn = (top, low, Sh) => {
    let u = 0;
    for (; u < 1; u += 0.02) { const p = lerp3(top, low, u); if (len3([p[0] - Sh[0], p[1] - Sh[1], p[2] - Sh[2]]) <= 0.95 * arm) break; }
    return lerp3(top, low, Math.min(1, u));
  };
  // (Reached for from the spot with the knees bent, the lowest the hands hold on from: the bounce, getting down.)
  const leanRef = 0.16, Cref = [C0[0], C0[1] - 0.1 * s, C0[2]];
  const gripHorn = holdOn(horn, hornLow, shoulderAt(Cref, face, leanRef, 1));
  const gripCantle = holdOn(cantle, cantLow, shoulderAt(Cref, face, leanRef, -1));
  const back7 = (p) => [p[0], p[1], p[2] - 0.07 * k];                   // the right hand just behind the left on the horn
  const gripHornR = holdOn(back7(horn), back7(hornLow), shoulderAt(Cref, face, leanRef, -1));
  // Standing in the stirrup a tall rider bends further over the saddle to keep both hands on the horn.
  let leanTop = 0.75;
  for (; leanTop < 1.2; leanTop += 0.025) {
    const L1 = shoulderAt(Ptop, faceTop, leanTop, 1), R1 = shoulderAt(Ptop, faceTop, leanTop, -1);
    if (len3([L1[0] - gripHorn[0], L1[1] - gripHorn[1], L1[2] - gripHorn[2]]) <= 0.93 * arm && len3([R1[0] - hornOff[0], R1[1] - hornOff[1], R1[2] - hornOff[2]]) <= 0.93 * arm) break;
  }
  const leanAdd = leanTop - 0.75;
  // Can they get up from the ground? Without a split (the climb stirrup at most a little above the hip), standing in it
  // their hips reach the back, and the off leg clears the croup without kicking higher than ~25 degrees above the hip.
  const ok = Sc[1] <= standHip + 0.1 * s && Ptop[1] >= back - 0.04 * k && yc - Ptop[1] <= 0.42 * span;
  return { J, F, L, sc, yaw, k, s, prof, toW, toL, dirW, shX, shY, arm, hipY, hipX, thigh, shin, span, lift, ankleY: ankle0, standHip, S, Kr, Q,
    gy, Sc, C0, face, G, Ptop, Hp, Pb, Pover, gripHorn, gripCantle, gripHornR, hornLow, cantLow, hornLow2, cantLow2, leanAdd, faceTop, zc, yc, croup, back, horn, cantle, hornOff, ok, rideKnee, Hr, seatPos: o.seatPos };
}

/** Put the body's pelvis at P (horse frame) facing psi (relative to the horse), pitched by lean (forward, about the
 *  pelvis) and rolled by roll. */
function placeBody(g, R, P, psi, lean, roll = 0) {
  g.rotation.order = "YXZ";
  g.rotation.set(lean, R.yaw + psi, roll);
  g.updateMatrix();
  const off = new THREE.Vector3(0, R.hipY, 0).applyEuler(g.rotation);
  g.position.copy(R.toW(P)).sub(off);
  g.updateMatrixWorld(true);
}
/** A hip's position (horse frame) for the pelvis at P facing psi, lean, roll. side +1 left, -1 right. */
function hipAt(R, P, psi, lean, roll, side) {
  const v = new THREE.Vector3(side * R.hipX, 0, 0).applyEuler(new THREE.Euler(lean, psi, roll, "YXZ"));
  return [P[0] + v.x, P[1] + v.y, P[2] + v.z];
}
/** Keep a pinned foot reachable: move the pelvis toward the foot when the hip is further than frac of the leg. */
function reach(R, P, psi, lean, roll, side, A, frac = 0.985) {
  const hp = hipAt(R, P, psi, lean, roll, side);
  const d = [hp[0] - A[0], hp[1] - A[1], hp[2] - A[2]], n = len3(d), max = frac * R.span;
  if (n <= max) return P;
  const e = (n - max) / n;
  return [P[0] - d[0] * e, P[1] - d[1] * e, P[2] - d[2] * e];
}
/** Where an ankle is with the heel up a rad about the toe (the foot planted at G facing world-relative psi). */
function heelUp(R, G, psi, a) {
  const L = R.L?.r, toeZ = (L ? L.toe.z : 0.17) * R.sc, solY = (L ? -L.heel.y : 0.08) * R.sc;
  const r = Math.hypot(toeZ, solY), a0 = Math.atan2(solY, toeZ);
  const f = fwdOf(psi);
  const T = [G[0] + f[0] * toeZ, G[1] - solY, G[2] + f[2] * toeZ];
  const back = r * Math.cos(a0 + a), up = r * Math.sin(a0 + a);
  return [T[0] - f[0] * back, T[1] + up, T[2] - f[2] * back];
}
/** A stepping foot: from a to b, lifted h at mid-step (u 0..1, eased); no lift for a step of under 2 cm. */
function stepArc(a, b, u, h) {
  const e = sstep(0, 1, u), p = lerp3(a, b, e);
  p[1] += h * Math.min(1, len3([b[0] - a[0], 0, b[2] - a[2]]) / 0.06) * Math.sin(Math.PI * clamp(u, 0, 1));
  return p;
}
/** The feet standing at the spot C0 facing psi (horse frame). */
const stance = (R, psi) => { const l = leftOf(psi); return { l: [R.C0[0] + R.hipX * l[0], R.ankleY, R.C0[2] + R.hipX * l[2]], r: [R.C0[0] - R.hipX * l[0], R.ankleY, R.C0[2] - R.hipX * l[2]] }; };
/** A point A brought onto the sphere of radius share x leg length about the hip when it is out of that reach (or onto
 *  it in any case with `always`): the off leg as a pendulum from its own hip, knee soft. */
function onReach(R, hip, A, share, always = false) {
  const d = [A[0] - hip[0], A[1] - hip[1], A[2] - hip[2]], n = len3(d), r = share * R.span;
  if (n < 1e-6 || (!always && n <= r)) return A.slice();
  return add3(hip, d, r / n);
}
const REACH = 0.985;                                                  // knee ~0.25 rad: straight but not locked

/** Where a rider stands to climb on, and stands after getting off: world {x, y, z, yaw} (y: the ground under the
 *  pelvis, the horse's base height); ok: false when they are too short to get up on this horse from the ground. */
export function mountSpot(g, o) {
  if (!g?.userData?.joints) return null;
  // (Measuring poses the figure in the ride pose: put it back as it was.)
  const J = g.userData.joints, F = feetOf(g);
  const saved = { p: g.position.clone(), r: g.rotation.clone(), q: [...(g.userData.limbs || []).map((l) => l.pivot.quaternion.clone())],
    t: ["spine", "neck", "head"].map((n) => J[n]?.quaternion.clone()), f: Object.values(F).map((f) => [f.shoe.position.clone(), f.shoe.quaternion.clone()]) };
  const R = mountFrame(g, o), p = R.toW([R.C0[0], R.gy, R.C0[2]]);
  g.position.copy(saved.p); g.rotation.copy(saved.r);
  (g.userData.limbs || []).forEach((l, i) => l.pivot.quaternion.copy(saved.q[i]));
  ["spine", "neck", "head"].forEach((n, i) => { if (J[n]) J[n].quaternion.copy(saved.t[i]); });
  Object.values(F).forEach((f, i) => { f.shoe.position.copy(saved.f[i][0]); f.shoe.quaternion.copy(saved.f[i][1]); });
  g.updateMatrixWorld(true);
  // (the feet as the climb starts: ankles, world; and the height of the origin standing straight-legged on them)
  const B = stance(R, R.face), feet = { l: R.toW(B.l), r: R.toW(B.r) };
  return { x: p.x, y: p.y, z: p.z, yaw: R.yaw + R.face, ok: R.ok, feet, lift: R.lift };
}

/**
 * A walk from p0 to `end` (world x, z) through `via` points: a smooth path (leaving along the way they were already
 * going, the faster the wider the turn), walked from speed v0 (m/s) at a real pace for a person of height h (slower
 * round tight turns; accelerating and stopping at about 1.4 m/s2, a run braking harder), turning from yaw0 over several
 * frames and, over the last steps, to endYaw (the way they will face).
 * Returns {T (frames), pos: [[x, 0, z]] and yaw[] for frames 0..T}. Pure.
 */
export function walkTo({ p0, v0 = [0, 0], yaw0 = 0, via = [], end, endYaw, fps = 24, h = 1.8 }) {
  const dirOf = (y) => [Math.sin(y), Math.cos(y)], len = (a) => Math.hypot(a[0], a[1]);
  const pts = [p0, ...via, end], sp0 = len(v0), fe = dirOf(endYaw);
  // tangents: along v0 when moving (else toward the next point), Catmull-Rom between, along endYaw at the end
  const tan = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)], seg = len([next[0] - prev[0], next[1] - prev[1]]) / (i === 0 || i === pts.length - 1 ? 1 : 2);
    if (i === pts.length - 1) {   // (arriving half way between the way they come and the way they will face)
      const d = [p[0] - prev[0], p[1] - prev[1]], n = len(d) || 1, b = [d[0] / n + fe[0], d[1] / n + fe[1]], nb = len(b);
      const u = nb > 0.3 ? [b[0] / nb, b[1] / nb] : fe;
      return [u[0] * Math.min(seg, 0.8), u[1] * Math.min(seg, 0.8)];
    }
    if (i === 0 && sp0 > 0.3) { const m = Math.max(Math.min(seg, 1.2), 0.9 * sp0); return [v0[0] / sp0 * m, v0[1] / sp0 * m]; }   // (the faster, the wider the turn)
    return [(next[0] - prev[0]) / 2, (next[1] - prev[1]) / 2];
  });
  const dense = [p0.slice()];
  for (let i = 0; i + 1 < pts.length; i++) for (let j = 1; j <= 32; j++) {
    const u = j / 32, h00 = 2 * u ** 3 - 3 * u * u + 1, h10 = u ** 3 - 2 * u * u + u, h01 = -2 * u ** 3 + 3 * u * u, h11 = u ** 3 - u * u;
    dense.push([0, 1].map((c) => h00 * pts[i][c] + h10 * tan[i][c] + h01 * pts[i + 1][c] + h11 * tan[i + 1][c]));
  }
  const acc = [0];
  for (let i = 1; i < dense.length; i++) acc.push(acc[i - 1] + len([dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]]));
  const L = acc[acc.length - 1];
  const at = (s) => { let i = 1; while (i < acc.length - 1 && acc[i] < s) i++; const u = clamp((s - acc[i - 1]) / Math.max(1e-9, acc[i] - acc[i - 1]), 0, 1); return [lerp(dense[i - 1][0], dense[i][0], u), lerp(dense[i - 1][1], dense[i][1], u)]; };
  // The pace along the path: a purposeful walk (1.3 m/s at 1.8 m), slower round a tight turn (no more than ~2 m/s2
  // sideways, the body turning at most ~150 deg/s), up to it at ~1.6 m/s2 and down to a stop at ~1.6 (a run brakes
  // harder, ~3).
  const vc = 1.3 * Math.sqrt(h / 1.8), aU = 1.6, aB = 3.0, aD = Math.max(1.6, sp0 * sp0 / Math.max(0.05, 2 * L)), aLat = 2.0, wMax = 2.6;
  // the heading along the way: the path's own, and round to endYaw over the last steps as they stop (they walk up
  // alongside and turn to face it, not loop round behind it); a short shuffle just turns
  const tanYaw = (s) => { const a = at(Math.max(0, s - 0.04)), b = at(Math.min(L, s + 0.04)); return Math.atan2(b[0] - a[0], b[1] - a[1]); };
  const yawS = (s) => { const tw = tanYaw(s); return tw + wrapPi(endYaw - tw) * sstep(Math.max(0, L - 0.9), L, s); };
  const M = 240, ds = L / M, v = [];
  for (let i = 0; i <= M; i++) {
    const s0 = i * ds, a0 = at(Math.max(0, s0 - 0.1)), a1 = at(s0), a2 = at(Math.min(L, s0 + 0.1));
    const th = Math.abs(wrapPi(Math.atan2(a2[0] - a1[0], a2[1] - a1[1]) - Math.atan2(a1[0] - a0[0], a1[1] - a0[1])));
    const kap = th / Math.max(0.02, 0.5 * (len([a2[0] - a1[0], a2[1] - a1[1]]) + len([a1[0] - a0[0], a1[1] - a0[1]])));
    // (and slow enough that the body turns no faster than ~150 deg/s while walking)
    const dy = Math.abs(wrapPi(yawS(Math.min(L, s0 + 0.05)) - yawS(Math.max(0, s0 - 0.05)))) / 0.1;
    // (never slower than a shuffle, ~0.5 m/s; a short shuffle just turns, so only the path's bends slow it)
    const turnCap = L > 0.3 ? Math.min(Math.sqrt(aLat / Math.max(kap, 1e-6)), wMax / Math.max(dy, 1e-6)) : Infinity;
    v.push(Math.min(Math.max(vc, Math.sqrt(Math.max(0, sp0 * sp0 - 2 * aB * s0))), Math.max(0.5, turnCap)));
  }
  v[0] = sp0; v[M] = 0;
  for (let i = 1; i <= M; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * aU * ds));                       // speeding up
  for (let i = M - 1; i >= 1; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * (L - i * ds < 1.2 ? aD : aB) * ds));   // slowing
  for (let i = 1; i < M; i++) v[i] = Math.max(v[i], Math.sqrt(Math.max(0, v[i - 1] ** 2 - 2 * aB * ds)));              // (no harder than a run brakes)
  const tS = [0];
  for (let i = 1; i <= M; i++) tS.push(tS[i - 1] + (v[i - 1] + v[i] > 1e-6 ? 2 * ds / (v[i - 1] + v[i]) : 0));
  const tot = tS[M], T = L < 0.01 ? 0 : Math.max(2, Math.ceil(tot * fps));
  const sOf = (t) => { let lo = 0, hi = M; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tS[m] < t) lo = m; else hi = m; } const u = clamp((t - tS[lo]) / Math.max(1e-9, tS[hi] - tS[lo]), 0, 1); return (lo + u) * ds; };
  const pos = [], yaw = [];
  const y00 = L > 0.3 ? tanYaw(0) : endYaw, turn = Math.abs(wrapPi(y00 - yaw0)), Tt = clamp(turn / 3.5, 0.25, 0.7) * fps;
  for (let j = 0; j <= T; j++) {
    const s = T ? sOf(j / T * tot) : L, p = at(s);
    pos.push([p[0], 0, p[1]]);
    // (turned to from yaw0 over a few frames)
    const want = L > 0.3 ? yawS(s) : yaw0 + wrapPi(endYaw - yaw0) * sstep(0, 1, j / Math.max(1, T));
    yaw.push(want + wrapPi(yaw0 - y00) * (1 - sstep(0, Tt, j)) * (L > 0.3 ? 1 : 0));
  }
  yaw[T] = endYaw;
  // (no turn faster than ~200 deg/s)
  const step = 3.5 / fps;
  for (let j = 1; j <= T; j++) yaw[j] = yaw[j - 1] + clamp(wrapPi(yaw[j] - yaw[j - 1]), -step, step);
  return { T, pos, yaw, L };
}

// ---------- one body model for getting on and getting off
//
// A climb state: pivot (0 facing the way they arrived .. 1 the saddle), shift (weight over the off foot), dip (the
// bounce), lift (near foot ground .. climb stirrup), rise (.. standing in it), over (.. hips over the saddle), sit
// (.. seated), settle (climb stirrup .. ride stirrup, knees to the ride pose), face (0 the saddle .. 1 part way .. 2 the
// front), lean (rad), heel (off heel up, rad), swing (off leg 0 hanging .. 1 behind .. 2 over the croup .. 3 down the
// off side .. 4 in its stirrup), air (off foot 0 on the ground .. 1 hanging), grip / swap (hands), arms (0 hanging ..
// 1 the ride pose's rein hands), ride (0 the IK .. 1 the ride pose itself).

/** The pelvis (horse frame), facing and lean for a state; the near foot kept in reach of its stirrup. */
function climbBody(R, st, psiA) {
  const s = R.s;
  const psi = st.face <= 0 ? psiA + wrapPi(R.face - psiA) * st.pivot : st.face <= 1 ? lerp(R.face, R.faceTop, st.face) : lerp(R.faceTop, 0, st.face - 1);
  const offFoot = stance(R, R.face).r, hop = st.hop || 0;
  const Ps = [R.C0[0] + (offFoot[0] - R.C0[0]) * 0.3 * st.shift, 0, R.C0[2] + (offFoot[2] - R.C0[2]) * 0.3 * st.shift];
  const P0 = lerp3(Ps, R.Pb, hop);
  P0[1] = R.C0[1] - 0.02 * s * st.shift - 0.06 * s * st.dip + 0.025 * s * Math.sin(Math.PI * hop);
  // The spring goes up first and over the stirrup after (straight across would fold the near leg up into the chest).
  const uh = sstep(0.15, 1, st.rise), uv = st.rise;
  let P = [P0[0] + (R.Ptop[0] - P0[0]) * uh, P0[1] + (R.Ptop[1] - P0[1]) * uv, P0[2] + (R.Ptop[2] - P0[2]) * uh];
  if (st.over > 0) P = lerp3(P, R.Pover, st.over);
  if (st.sit > 0) P = lerp3(P, R.Q, st.sit);
  if (st.low > 0) P = lerp3(P, R.Plow, st.low);
  const An = climbNear(R, st);
  const lean0 = st.lean + R.leanAdd * clamp(st.rise, 0, 1) * (1 - st.sit) * (1 - (st.low || 0));
  if (st.lift >= 1) for (let i = 0; i < 3; i++) P = reach(R, P, psi, lean0, 0, 1, An);
  // Leaning in over the saddle, but never with a shoulder into the horse's side (it leans in as the shoulders come up
  // over the back): the most lean that keeps both shoulders a shoulder's thickness out from the body.
  // (the extra lean a short rider needs standing in the stirrup is worked out per frame below, not carried over the
  // saddle, where it would put the shoulders out past the horn)
  let ln = st.lean;
  // Holding the horn: bend over the saddle further (or less, when the shoulders are already out past it) when a hand
  // would be out of reach of it, by as little as gets it back in reach.
  if ((st.grip || 0) > 0.5) {
    const sw = st.swap || 0, rightOn = sw >= 0.5 && sw <= 1.5;          // (the right hand on the off side of the horn)
    const far = (x) => Math.max(len3(add3(R.hornLow, shoulderOf(R, P, psi, x, 1), -1)) - 0.97 * R.arm,
      rightOn ? len3(add3(R.hornOff, shoulderOf(R, P, psi, x, -1), -1)) - 0.97 * R.arm : -1);
    if (far(ln) > 0) {
      // the nearest lean (0 .. 1.4 rad) that reaches, found on a grid and then exactly at its edge; else the closest
      let best = null, bestFar = Infinity, arg = ln;
      for (let x = 0; x <= 1.4001; x += 0.02) { const d = far(x); if (d <= 0 && (best === null || Math.abs(x - ln) < Math.abs(best - ln))) best = x; if (d < bestFar) { bestFar = d; arg = x; } }
      let to = arg;
      if (best !== null) { let lo = ln, hi = best; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (far(m) > 0) lo = m; else hi = m; } to = hi; }
      ln = lerp(ln, to, sstep(0.5, 1, st.grip));
    }
  }
  const lean = trunkClear(R, P, psi, ln);
  return { P, psi, lean, An };
}
/** A shoulder (horse frame) for the pelvis at P facing psi, leaning lean; side +1 left, -1 right. */
function shoulderOf(R, P, psi, lean, side) {
  const v = new THREE.Vector3(side * R.shX, R.shY, 0).applyEuler(new THREE.Euler(lean, psi, 0, "YXZ"));
  return [P[0] + v.x, P[1] + v.y, P[2] + v.z];
}
/** The lean (<= lean) at which both shoulders and the head are clear of the horse (out from its side or above it). */
function trunkClear(R, P, psi, lean) {
  const k = R.k, s = R.s, G = 0.1 * s;
  // (into the body: neither a gap out from its side at that height nor a gap above its top there)
  // Both shoulders and the head (centres, a body's half-thickness clear), and the surfaces that lead when leaning over
  // the saddle (the face, the crown, the chest and the belly, 2-4 cm clear): over the withers nothing goes into a rigged
  // horse's neck, and nothing lies in its back. [x, y above the hips, z forward, gap], m.
  const pts = [[R.shX, R.shY, 0, G], [-R.shX, R.shY, 0, G], [0, R.shY + 0.2 * s, 0, G], [0, R.shY + 0.19 * s, 0.11 * s, 0.035 * s],
    [0, R.shY + 0.31 * s, 0, 0.03 * s], [0, 1.35 * s - R.hipY, 0.12 * s, 0.03 * s], [0, 1.08 * s - R.hipY, 0.1 * s, 0.03 * s]];
  const need = (ln) => Math.max(...pts.map(([x, y, z, gap]) => { const v = new THREE.Vector3(x, y, z).applyEuler(new THREE.Euler(ln, psi, 0, "YXZ")), q = [P[0] + v.x, P[1] + v.y, P[2] + v.z], ax = Math.abs(q[0]);
    return Math.min(hwAt(R.prof, q[1] / k, q[2] / k) * k + gap - ax, surfaceTop(R.prof, Math.max(0, ax - gap) / k, q[2] / k) * k + gap - q[1]); }));
  if (lean <= 0 || need(lean) <= 0) return lean;
  if (need(0) > 0) return 0;
  let lo = 0, hi = lean;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (need(m) > 0) hi = m; else lo = m; }
  return lo;
}
/** The near foot for a state: on the ground (stepping through the pivot), on an arc out from the horse into the
 *  climb stirrup, up to the ride stirrup as they settle. */
function climbNear(R, st) {
  const G0 = st.nearGround || stance(R, R.face).l;
  if (st.lift <= 0) return G0;
  // (Up into it on an arc out from the horse; out of it, down: the foot drops out and steps back to the ground.)
  const mid = st.down ? [0.5 * (G0[0] + R.Sc[0]) + 0.1 * R.s, G0[1] + 0.4 * (R.Sc[1] - G0[1]), 0.5 * (G0[2] + R.Sc[2]) + 0.06 * R.s]
    : [0.5 * (G0[0] + R.Sc[0]) + 0.12 * R.s, G0[1] + 0.52 * (R.Sc[1] - G0[1]), 0.5 * (G0[2] + R.Sc[2]) + 0.03 * R.s];
  const A = st.lift >= 1 ? R.Sc : trackAt([[0, G0], [0.5, mid], [1, R.Sc]], st.lift);
  return st.settle > 0 ? lerp3(A, R.S.l, st.settle) : A;
}
/** The off leg's swing directions (from its hip) at a hip position: hanging, behind and out past the near haunch, the
 *  point on the croup it clears (solved on the leg's reach sphere), down the off side. */
function swingAims(R, hip) {
  const k = R.k, r = REACH * R.span, s = R.s;
  const hang = add3(hip, [0, -1, -0.1], r);
  // Over the croup: the boot crosses the midline where its reach meets the back plus clearance, laid out from the hip
  // as it is when the leg crosses (R.swingHip: fixed, so the way over never jumps while the hips are still rising).
  const H = R.swingHip || hip, clr = 0.07 * s + 0.05;
  const fz = (z) => H[0] ** 2 + (backTop(R.prof, z / k - 0.05, z / k + 0.05) * k + clr - H[1]) ** 2 + (z - H[2]) ** 2 - r * r;
  let lo = H[2] - 0.1 * k, hi = H[2] - 1.0 * k;
  if (fz(hi) < 0) hi = H[2] - 1.0 * k; else if (fz(lo) > 0) hi = lo;
  else for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (fz(m) < 0) lo = m; else hi = m; }
  const zc = hi;
  let cross = [0, backTop(R.prof, zc / k - 0.05, zc / k + 0.05) * k + clr, zc];
  // ... and the whole leg over it, not just the boot: the line from the hip to the boot clears the croup by the leg's own
  // thickness (thigh .. shin) and 2 cm everywhere along it, raised behind (hip extension, the trunk over the saddle) as
  // far as that takes, so the thigh and knee never drag through the hindquarters.
  {
    const legR = (u) => (0.06 - 0.02 * u) * s + 0.01;   // (the profile's top already stands a few cm proud of the mesh)
    const clearOf = (d) => { let m = Infinity; for (let u = 0.3; u <= 1.001; u += 0.07) { const q = add3(H, d, u * r), top = surfaceTop(R.prof, q[0] / k, q[2] / k); if (top > -Infinity) m = Math.min(m, q[1] - top * k - legR(u)); } return m; };
    const c0 = norm3(add3(cross, H, -1)), hz = Math.hypot(c0[0], c0[2]) || 1, h0 = [c0[0] / hz, 0, c0[2] / hz];
    const dirE = (e) => [h0[0] * Math.cos(e), Math.sin(e), h0[2] * Math.cos(e)];
    let e = Math.asin(clamp(c0[1], -1, 1));
    const eMax = Math.max(e, 0.45);   // (no higher than ~25 deg above the hip behind: a kick, not a mount)
    for (let i = 0; i < 40 && clearOf(dirE(e)) < 0 && e < eMax; i++) e = Math.min(eMax, e + 0.02);
    cross = add3(H, dirE(e), r);
  }
  const hwB = bodyHalf(R.prof, (cross[1] - 0.3 * k) / k, zc / k - 0.15, zc / k + 0.25) * k;
  // (behind and below the hip while it is still coming up: the leg never points up behind it)
  const behind = [Math.max(hwB, 0.2 * k) + 0.16 * s, Math.min(cross[1] - 0.24 * k, hip[1] - 0.3 * r), 0.5 * (H[2] + zc) - 0.1 * k];
  // Down the off side as soon as it is over: low, outside the haunch (not held out level, which reads as a split).
  const yOff = Math.min(cross[1] - 0.12 * k, H[1] - 0.42 * r);
  const offSide = [-(Math.max(bodyHalf(R.prof, yOff / k, zc / k - 0.2, zc / k + 0.3) * k, 0.2 * k) + 0.14 * s), yOff, zc + 0.15 * k];
  // Hanging down the off side, out round the barrel (as a leg out of its stirrup hangs).
  const bar = bodyHalf(R.prof, 1.25, -0.45, 0.45) * k + 0.09 * s, drop = Math.max(0.25 * k, hip[1] - 1.23 * k);
  const hangUp = add3(hip, norm3([-Math.min(1.1, Math.max(0.2, (bar + hip[0]) / drop)), -1, -0.05]), r);
  // Seated, the foot out of its stirrup just drops and swings back a little (the thigh stays where it sat).
  const hangSeat = [R.S.r[0] - 0.06 * k, R.S.r[1] - 0.08 * s, R.S.r[2] - 0.12 * s];
  const hangOff = lerp3(hangSeat, hangUp, sstep(0, 1, (hip[1] - R.Q[1]) / Math.max(0.05, R.Pover[1] - R.Q[1])));
  return { hang, behind, cross, offSide, hangOff };
}
/** The off hip (horse frame) when the off leg crosses the croup (the script's swing at 2). */
function crossHip(R, script, motion, psiA) {
  const ks = script.swing, i = ks.findIndex((x, j) => j > 0 && (ks[j - 1][1] - 2) * (x[1] - 2) <= 0);
  const [t0, v0] = ks[i - 1], [t1, v1] = ks[i], tc = t0 + (t1 - t0) * (2 - v0) / (v1 - v0 || 1);
  const b = climbBody(R, motion(tc), psiA);
  return hipAt(R, b.P, b.psi, b.lean, 0, -1);
}
/** The off ankle for a state, at the off hip `hip`. ground: where the off foot stands (heel up by st.heel). */
function climbOff(R, st, hip, ground) {
  if (st.swing <= 0) {
    const aim = st.air > 0 ? lerp3(ground, swingAims(R, hip).hang, st.air) : ground;
    return onReach(R, hip, aim, lerp(1, REACH, st.air));             // standing: the leg straight
  }
  if (st.air < 1) {   // (the swing has begun before the off foot is off the ground: it leaves the ground into it)
    const a = onReach(R, hip, lerp3(ground, swingAims(R, hip).hang, st.air), lerp(1, REACH, st.air));
    return lerp3(a, climbOff(R, { ...st, air: 1 }, hip, ground), st.air);
  }
  const W = swingAims(R, hip);
  if (st.swing < 3) {
    // (a pendulum: the leg's direction from the hip is what travels, so the boot sweeps at an even pace round its arc)
    const dir = (p) => norm3([p[0] - hip[0], p[1] - hip[1], p[2] - hip[2]]);
    const aim = add3(hip, trackAt([[0, dir(W.hang)], [1, dir(W.behind)], [2, dir(W.cross)], [3, dir(W.offSide)]], st.swing), 1);
    return onReach(R, hip, aim, lerp(REACH, 0.995, Math.max(0, 1 - Math.abs(st.swing - 2))), true);   // straightest over the croup
  }
  // Down the off side to hanging, then into its stirrup: the direction and the reach blend together (no straight cut
  // that folds the knee).
  const arc = (A, B, u) => {
    const a = [A[0] - hip[0], A[1] - hip[1], A[2] - hip[2]], b = [B[0] - hip[0], B[1] - hip[1], B[2] - hip[2]];
    return add3(hip, norm3(lerp3(norm3(a), norm3(b), u)), Math.min(REACH * R.span, lerp(len3(a), len3(b), u)));
  };
  const off = onReach(R, hip, W.offSide, REACH, true);
  // (the script's keys already ease in and out: linear here, so the boot doesn't stall and then dash)
  if (st.swing < 3.5) return arc(off, W.hangOff, (st.swing - 3) / 0.5);
  return arc(W.hangOff, R.S.r, (st.swing - 3.5) / 0.5);
}

/** Signed distance (k units; negative inside) from (a = |x|, y) to the body's outline in the cross-section at z, and
 *  the outward direction [da, dy]: the side walls and the top as a polyline through the bins (lerped across z). */
function outlineDist(prof, a, y, z) {
  const hw = prof.hwFine || prof.hw, fz = (z - PZ0) / PD, i0 = Math.floor(fz), u = fz - i0;
  const col = (iz) => {
    if (iz < 0 || iz >= NZ) return null;
    const pts = [];
    let top = -1, bot = -1;
    for (let iy = NY - 1; iy >= 0; iy--) if (hw[iy * NZ + iz] >= 0) { if (top < 0) top = iy; bot = iy; }
    if (top < 0) return null;
    pts.push([0, PY0 + top * PD + PD / 2]);
    for (let iy = top; iy >= bot; iy--) pts.push([Math.max(0, hw[iy * NZ + iz]), PY0 + iy * PD]);
    pts.push([0, PY0 + bot * PD - PD / 2]);
    let best = Infinity, n = [0, 1];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
      const t = clamp(((a - ax) * dx + (y - ay) * dy) / L2, 0, 1), cx = ax + dx * t, cy = ay + dy * t, d = Math.hypot(a - cx, y - cy);
      if (d < best) { best = d; n = d > 1e-9 ? [(a - cx) / d, (y - cy) / d] : [dy, -dx]; }
    }
    const fy = (y - PY0) / PD, iy = Math.round(fy);
    const inside = y > PY0 + bot * PD - PD / 2 && y < PY0 + top * PD + PD / 2 && iy >= 0 && iy < NY && a < Math.max(0, hw[iy * NZ + iz]);
    return inside ? { d: -best, n: [-n[0], -n[1]] } : { d: best, n };
  };
  const A = col(i0), B = col(i0 + 1);
  if (!A && !B) return null;
  if (!A || !B) return A || B;
  const nn = [lerp(A.n[0], B.n[0], u), lerp(A.n[1], B.n[1], u)], l = Math.hypot(nn[0], nn[1]) || 1;
  return { d: lerp(A.d, B.d, u), n: [nn[0] / l, nn[1] / l] };
}
/** How far the off boot is into the `clear` margin round the horse, as the move (horse frame, m) that takes it out
 *  along the outline's normal: its worst corner against the body's cross-section there (the horse measured as shown,
 *  k units in the profile). null when it is clear. */
function bootDeficit(R, clear) {
  const f = R.F.r, k = R.k;
  f.shoe.updateWorldMatrix(true, false);
  let best = null;
  for (const q of f.corners) {
    const p = R.toL(q.clone().applyMatrix4(f.shoe.matrixWorld)), o = outlineDist(R.prof, Math.abs(p[0]) / k, p[1] / k, p[2] / k);
    if (!o) continue;
    const need = clear - o.d * k;
    if (need > 0.002 && (!best || need > best.need)) best = { need, n: [o.n[0] * Math.sign(p[0] || 1), o.n[1], 0] };
  }
  return best && add3([0, 0, 0], best.n, best.need);
}
/** How far (m) the off leg (hip to ankle, as thick as a thigh tapering to a shin) is into the horse past `margin` of
 *  clearance at its worst point (a point u of the way down weighs 1/u: the leg turns about its hip); <= 0 when clear. */
function legLineNeed(R, hip, A, margin = 0.02) {
  const k = R.k, s = R.s;
  let m = -1;
  for (let u = 0.3; u <= 1.001; u += 0.07) {
    const q = lerp3(hip, A, u), od = outlineDist(R.prof, Math.abs(q[0]) / k, q[1] / k, q[2] / k);
    if (od) m = Math.max(m, ((0.06 - 0.02 * u) * s + margin - od.d * k) / u);
  }
  return m;
}
/** How deep (m) the near leg (thigh, shin; hip, knee and ankle in the horse frame) is into the horse, past its own
 *  thickness: 0 when clear. */
function nearLegDepth(R, hip, knee, ankle) {
  const k = R.k, s = R.s;
  let m = 0;
  for (const [a, b, r0, r1] of [[hip, knee, 0.075, 0.06], [knee, ankle, 0.055, 0.045]]) for (let u = 0.15; u <= 1.001; u += 0.17) {
    const q = lerp3(a, b, u), od = outlineDist(R.prof, Math.abs(q[0]) / k, q[1] / k, q[2] / k);
    if (od) m = Math.max(m, lerp(r0, r1, u) * s - od.d * k);
  }
  return m;
}
/** Sample points of a hand (palm and fingers): [mesh, vertex index], read once per figure. */
function armPts(g, lr) {
  const c = g.userData._armPts || (g.userData._armPts = {});
  if (c[lr]) return c[lr];
  const out = [];
  g.userData.joints[`${lr}_wrist`].traverse((o) => {
    const n = o.isMesh ? o.geometry?.attributes?.position?.count || 0 : 0, step = Math.max(1, Math.floor(n / 14));
    for (let i = 0; i < n; i += step) out.push([o, i]);
  });
  return (c[lr] = out);
}
const _v = new THREE.Vector3();
/** How far a hand (palm, fingers) is into the `clear` margin round the horse, as the move (horse frame,
 *  m) that takes the hand out along the outline's normal; null when it is clear. (As bootDeficit, for the arm.) */
function armDeficit(R, g, lr, clear) {
  const k = R.k;
  let best = null;
  for (const [o, i] of armPts(g, lr)) {
    o.getVertexPosition(i, _v).applyMatrix4(o.matrixWorld);
    const p = R.toL(_v), od = outlineDist(R.prof, Math.abs(p[0]) / k, p[1] / k, p[2] / k);
    if (!od) continue;
    const need = clear - od.d * k;
    if (need > 0.002 && (!best || need > best.need)) best = { need, n: [od.n[0] * Math.sign(p[0] || 1), od.n[1], 0] };
  }
  return best && add3([0, 0, 0], best.n, best.need);
}
/** The fingers curled round a hold (c 0 open .. 1 a loose fist), as humans.mjs's Curl. */
function curlFingers(g, lr, c) {
  for (const [id, j] of Object.entries(g.userData.joints)) {
    if (j.userData.jkind !== "finger" || !id.startsWith(lr + "_")) continue;
    const rest = j.userData.rest || [0, 0, 0], thumb = j.userData.finger === "thumb", a = c * (thumb ? 0.7 : 1.35), sd = j.userData.side || 1;
    j.rotation.order = "XYZ";
    j.rotation.set(rest[0] - (thumb ? a * 0.6 : 0), 0, -sd * (thumb ? a * 0.5 : a));
  }
}

/**
 * Where a hand is on its way from `A` (where the arm hangs or holds the reins) to its hold `B` on the saddle, at u (0
 * A .. 1 B), horse frame: up the outside of the horse first, then in over the top (never through the flank or the
 * hindquarters on the way).
 */
function handPath(A, B, u) {
  // (u is already eased in and out: the rise follows it directly, so the hand's top speed stays a reach's, ~5 m/s)
  return [lerp(A[0], B[0], sstep(0.3, 1, u)), lerp(A[1], B[1], clamp(u * 1.15, 0, 1)), lerp(A[2], B[2], sstep(0.05, 0.95, u))];
}

/** Pose the body from a climb state. Returns where the feet went. */
function poseClimb(g, R, st, psiA, offGround, offHeelYaw) {
  const { P, psi, lean, An } = climbBody(R, st, psiA);
  const hipOff = hipAt(R, P, psi, lean, 0, -1);
  const ground = st.heel > 0 ? heelUp(R, offGround, offHeelYaw, st.heel) : offGround;
  const Ao = climbOff(R, st, hipOff, ground);
  seedLimbs(g, st.arms);
  resetFeet(g);
  ridePoseLegsBlend(g, st.ride > 0 ? 1 : 0);                        // the IK blends from the ride pose itself
  placeBody(g, R, P, psi, lean);
  // (Where the arms hang, or hold the reins, before the hands go to the saddle: horse frame.)
  const J = R.J, at = (o) => R.toL(o.getWorldPosition(new THREE.Vector3()));
  const seedHand = { l: at(J.l_wrist), r: at(J.r_wrist) }, seedElbow = { l: at(J.l_elbow), r: at(J.r_elbow) }, seedSh = { l: at(J.l_shoulder), r: at(J.r_shoulder) };
  const wIK = 1 - st.ride, fw = fwdOf(psi), down = [0, -1, 0];
  // Knees: the near one forward, turned out toward the horse's shoulder for the stirrup, the ride pose's way at the
  // end; the off one forward on the ground, down (soft, behind) in the swing, the ride pose's way in its stirrup.
  // (Poles are horse-frame directions, turned to the world by R.dirW.)
  const kneeOut = norm3(add3(add3(leftOf(psi), fw, 0.6), [0, -1, 0], 0.3));   // forward-left, a little down: at the horse's shoulder
  const nearPole = lerp3(lerp3(fw, kneeOut, sstep(0, 0.6, st.lift)), R.rideKnee.l, st.settle);
  const swingPole = norm3(add3(add3(down, fw, 0.3), leftOf(psi), -1));       // soft knee down and out (not dragged through the croup)
  const offPole = st.swing <= 0 ? lerp3(fw, swingPole, st.air) : lerp3(swingPole, R.rideKnee.r, sstep(2, 3.3, st.swing));
  // The off leg in the air never drags through the hindquarters: swung out about its hip until the thigh, knee and shin
  // clear the horse by their own thickness (not just the boot).
  // (down the off side toward its stirrup the leg comes onto the horse's side as a seated leg is: the margin eases from
  // 2 cm clear to the 6 cm a seated thigh presses in, so the push lets go smoothly)
  // (getting off, the leg comes back down behind past the near haunch as the hips come out: kept clear down to there)
  const wLine = (st.down ? sstep(0.5, 1.3, st.swing) : sstep(0.9, 1.4, st.swing)) * (1 - sstep(3.2, 3.8, st.swing)) * wIK, margin = lerp(0.01, -0.06, sstep(2.2, 3.4, st.swing));
  if (wLine > 0 && legLineNeed(R, hipOff, Ao, margin) > 0) {
    // the leg raised about its hip (in its own vertical plane) by the least angle that clears it, found by halving: a
    // smooth function of the pose, so the boot never jumps as the push comes and goes
    const r0 = len3(add3(Ao, hipOff, -1)), d = norm3(add3(Ao, hipOff, -1)), up = norm3(add3([0, 1, 0], d, -d[1]));
    const at = (a) => add3(hipOff, add3(d.map((x) => x * Math.cos(a)), up, Math.sin(a)), r0);
    let lo = 0, hi = 0.8;
    if (legLineNeed(R, hipOff, at(hi), margin) > 0) lo = hi;
    else for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (legLineNeed(R, hipOff, at(m), margin) > 0) lo = m; else hi = m; }
    const moved = at(hi * wLine);
    Ao[0] = moved[0]; Ao[1] = moved[1]; Ao[2] = moved[2];
  }
  legTo(g, R, "l", R.toW(An), R.dirW(nearPole), wIK);
  // The near knee in its stirrup turns out from the horse as far as keeps the thigh and shin out of its side (no deeper
  // than the ride pose has them): a smooth turn, by how deep they would go.
  if (st.lift > 0 && wIK > 0) {
    const kneeAt = () => { R.J.l_knee.updateWorldMatrix(true, false); return R.toL(R.J.l_knee.getWorldPosition(new THREE.Vector3())); };
    const hipN = hipAt(R, P, psi, lean, 0, 1), dep = nearLegDepth(R, hipN, kneeAt(), An);
    const w = clamp((dep - 0.01) / 0.05, 0, 1) * sstep(0, 0.5, st.lift) * (1 - st.settle * st.sit);
    if (w > 0) legTo(g, R, "l", R.toW(An), R.dirW(norm3(lerp3(nearPole, [0.85, -0.2, 0.5], w))), wIK);
  }
  legTo(g, R, "r", R.toW(Ao), R.dirW(offPole), wIK);
  // Shoes: flat on the ground; level in the stirrup with the toe toward the horse's shoulder; pointed in the swing;
  // as built (square to the shin) in the ride pose.
  const qStir = qFlat(R.yaw - 0.3);
  if (st.lift <= 0) shoeTo(R, "l", qFlat(R.yaw + (st.nearYaw ?? psi)));
  else {
    const q = qFlat(R.yaw + R.face).slerp(qStir, sstep(0, 0.8, st.lift));
    if (st.settle > 0) q.slerp(qShin(R, "l", 0), st.settle);
    shoeTo(R, "l", q);
  }
  const offShoe = () => {
    if (st.air <= 0 && st.swing <= 0) shoeTo(R, "r", qFlat(R.yaw + (st.offYaw ?? R.face), st.heel));
    else if (st.swing < 3) shoeTo(R, "r", qFlat(R.yaw + R.face, st.heel).slerp(qShin(R, "r", 0.9), st.swing > 0 ? 1 : sstep(0, 0.7, st.air)));
    else shoeTo(R, "r", qShin(R, "r", 0.9 * (1 - sstep(3, 4, st.swing))));
  };
  offShoe();
  // The off boot over the croup: kept a few cm clear of the horse's actual back (raised when its corners would cut
  // into it), up to the moment it heads for its stirrup.
  const wClear = (st.swing > 0 ? 1 : st.air) * (1 - sstep(3.4, 3.8, st.swing)) * wIK;
  if (wClear > 0) for (let it = 0; it < 4; it++) {
    const mv = bootDeficit(R, 0.055 * R.s);
    if (!mv) break;
    // swung out along the reach it has (the leg turns about its hip: the knee stays as soft as it was)
    const hipR = hipAt(R, P, psi, lean, 0, -1), r0 = len3([Ao[0] - hipR[0], Ao[1] - hipR[1], Ao[2] - hipR[2]]);
    const T = add3(Ao, mv, wClear * 1.15), d = [T[0] - hipR[0], T[1] - hipR[1], T[2] - hipR[2]];
    const moved = add3(hipR, d, r0 / (len3(d) || 1));
    Ao[0] = moved[0]; Ao[1] = moved[1]; Ao[2] = moved[2];
    legTo(g, R, "r", R.toW(Ao), R.dirW(offPole), wIK);
    offShoe();
  }
  // Hands on the horn and the cantle (the right one to the off side of the horn while the leg comes over). Each hand's
  // target travels from where the arm hangs (or holds the reins) to its hold along the outside of the horse, and the arm
  // is solved onto it every frame with the elbow out away from the horse (as the seeded arm has it at the start).
  if (st.grip > 0) {
    const lw = leftOf(psi);
    // Out of reach of a hold (dipping for the spring, the trunk kept off the horse): the hand slides down the near
    // side of the horn or the cantle, as far as it must, and keeps hold there.
    const back7 = (p) => [p[0], p[1], p[2] - 0.07 * R.k];
    const slide = (A, B, C, Sh) => {
      const at = (u) => (u <= 1 ? lerp3(A, B, u) : lerp3(B, C, u - 1)), far = (u) => len3(add3(at(u), Sh, -1)) - 0.97 * R.arm;
      if (far(0) <= 0) return A;
      if (far(2) > 0) { let u = 0; for (let x = 0; x <= 2; x += 0.05) if (far(x) < far(u)) u = x; return at(u); }   // (none in reach: the nearest)
      let lo = 0, hi = 2;
      for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (far(m) > 0) lo = m; else hi = m; }
      return at(hi);
    };
    // (re-solved every frame from where the shoulder is: up in the stirrup the hand has the top of the horn again)
    const cant = slide(R.cantle, R.cantLow, R.cantLow2, seedSh.r), hornR = slide(back7(R.horn), back7(R.hornLow), back7(R.hornLow2), seedSh.r);
    const holds = { l: slide(R.horn, R.hornLow, R.hornLow2, seedSh.l), r: st.swap <= 1 ? lerp3(cant, R.hornOff, st.swap) : lerp3(R.hornOff, hornR, st.swap - 1) };
    for (const [lr, side] of [["l", 1], ["r", -1]]) {
      // away from the horse (out from its barrel, through the middle of the arm), to the rider's side, a little back
      const mid = lerp3(seedSh[lr], holds[lr], 0.5), radial = norm3([mid[0], mid[1] - 1.25 * R.k, 0]);
      const holdPole = norm3(add3(add3(radial, lw, 0.5 * side), fw, -0.3));
      // the seeded arm's own elbow direction (off the shoulder-wrist line), so the solve starts where the arm is
      const Sh = seedSh[lr], Wr = seedHand[lr], El = seedElbow[lr];
      const u = norm3([Wr[0] - Sh[0], Wr[1] - Sh[1], Wr[2] - Sh[2]]), e = [El[0] - Sh[0], El[1] - Sh[1], El[2] - Sh[2]];
      const d = e[0] * u[0] + e[1] * u[1] + e[2] * u[2], off = [e[0] - d * u[0], e[1] - d * u[1], e[2] - d * u[2]];
      const seedPole = len3(off) > 0.01 ? norm3(off) : holdPole;
      const pole = norm3(lerp3(seedPole, holdPole, sstep(0, 0.35, st.grip)));
      // the fingers close round the hold as the hand gets there
      curlFingers(g, lr, sstep(0.6, 1, st.grip));
      let T = handPath(Wr, holds[lr], st.grip);
      const wA = sstep(0, 0.12, st.grip);
      armTo(g, R, lr, R.toW(T), R.dirW(pole), wA);
      // Never a hand (palm or fingers) in the horse: lifted out along its outline, a little clear of it
      // (the hold is on tack the clay horse doesn't show: the horn stands above the withers).
      for (let it = 0; it < 8; it++) {
        R.J[`${lr}_shoulder`].updateWorldMatrix(false, true);
        const mv = armDeficit(R, g, lr, 0.015 * R.s);
        if (!mv) break;
        T = add3(T, mv, 1.15 * (st.down ? 1 : 0.35 + 0.65 * sstep(0.3, 0.9, st.grip)));   // (eased in as the hand reaches: no snap)
        armTo(g, R, lr, R.toW(T), R.dirW(pole), wA);
      }
    }
  } else for (const lr of ["l", "r"]) curlFingers(g, lr, 0);
  g.updateMatrixWorld(true);
  return { P, psi, lean, near: An, off: Ao };
}
/** The legs part way to the ride pose's joint angles (w 0..1): the seed the IK blends from at the ends. */
function ridePoseLegsBlend(g, w) {
  if (w <= 0) return;
  for (const l of g.userData.limbs || []) {
    if (l.part === "hip") l.pivot.rotation.set(RIDE_HIP_X * w, 0, l.side * RIDE_HIP_Z * w);
    else if (l.part === "knee") l.pivot.rotation.set(RIDE_KNEE * w, 0, 0);
  }
}

// ---------- the mount, as keys in seconds

/** The mount's script: each channel of the climb state as [seconds, value] keys (read-only). */
export const MK = {
  pivot: [[0, 0], [0.2, 1]],                                           // the stepped turn to the saddle (PIVOT_*)
  grip: [[0, 0], [0.6, 1], [1.95, 1], [2.25, 0]],                      // hands to the horn and the cantle (0.6 s), then the reins
  swap: [[0.95, 0], [1.3, 1]],                                         // right hand from the cantle to the off side of the horn
  shift: [[0.1, 0], [0.4, 1]],                                         // weight over the off foot while the near one goes up
  lift: [[0.16, 0], [0.62, 1]],                                        // near foot into the stirrup, as the turn ends (0.46 s)
  hop: [[0.42, 0], [0.68, 1]],                                         // one bounce: a hop on the off foot in toward the horse
  dip: [[0.56, 0], [0.74, 1], [0.9, 0.6]],                             // landing it, the load for the spring
  rise: [[0.68, 0], [1.45, 1]],                                        // the spring: up to standing in the stirrup (0.77 s)
  face: [[0.58, 0], [0.84, 0.35], [1.45, 1], [1.62, 1.35], [1.85, 1.65], [2.12, 2]],   // to the front, from the hop on
  lean: [[0, 0], [0.35, 0.16], [0.6, 0.18], [0.8, 0.24], [1.12, 0.55], [1.45, 0.75], [1.85, 0.7], [2.1, 0.32], [2.32, 0.03], [2.4, 0]],
  heel: [[0.72, 0], [1.02, 1.0]],                                      // off heel up on the spring (onto the toes)
  over: [[1.3, 0], [1.72, 1]],                                         // hips in over the back (done before the leg crosses)
  // off leg: hanging .. behind .. over the croup (the hips over the back) .. off side .. hanging .. stirrup (as they sit)
  swing: [[0.92, 0], [1.35, 1], [1.72, 2], [1.95, 3], [2.28, 3.5], [2.4, 4]],
  sit: [[1.98, 0], [2.36, 1]],                                         // down into it, softly (0.38 s)
  settle: [[1.5, 0], [2.36, 1]],                                       // near stirrup up to the ride length as the hips come over
  arms: [[1.9, 0], [2.2, 1]],                                          // (up to the reins before the hands leave the saddle)
  ride: [[2.34, 0], [2.4, 1]],                                         // the last frames hand over to the ride pose itself
};

/** The stepped pivot at the start of the mount (s): the off foot steps round first, then the near one. */
const PIVOT_OFF = 0.1, PIVOT_NEAR = [0.1, 0.2];
/** The mount's script at t (0..1 through MOUNT_SECONDS): every channel of the climb state (see poseClimb). */
export function mountMotion(t) {
  const tau = clamp(t, 0, 1) * MOUNT_SECONDS, st = { tau, low: 0, air: 0 };
  for (const [k, keys] of Object.entries(MK)) st[k] = trackAt(keys, tau);
  return st;
}
/** The off foot's ground spot through the mount: stepping round in the pivot, then the hop in toward the horse. */
function mountOffGround(R, st, A) {
  const B = stance(R, R.face);
  if (st.hop > 0) return stepArc(B.r, R.Hp, st.hop, 0.05 * R.s);
  return st.tau < PIVOT_OFF ? stepArc(A.r, B.r, st.tau / PIVOT_OFF, 0.06 * R.s) : B.r;
}

/**
 * Pose a person getting on a horse at t (0..1 through mountFrames(fps)). o: { horse: its position (Vector3), yaw: its
 * heading, k: its scale (height / 1.6), seatPos: the rider's origin when seated (world), h: the rider's height,
 * profile: horseProfile of the horse shown (default the clay one), from: {yaw} which way they faced as they arrived at
 * mountSpot (default: already facing the saddle) }. Starts standing at mountSpot (it does not travel: walk them there
 * first), ends exactly in humans.mjs's ride pose at seatPos.
 */
export function applyMount(g, t, o) {
  if (!g?.userData?.joints) return null;
  const R = mountFrame(g, o), st = mountMotion(t), tau = st.tau;
  const psiA = o.from?.yaw != null ? R.face + wrapPi(o.from.yaw - R.yaw - R.face) : R.face;
  // The stepped pivot: the off foot steps round first, then the near one (one foot always planted).
  const A = stance(R, psiA), B = stance(R, R.face), hStep = 0.06 * R.s;
  const [n0, n1] = PIVOT_NEAR;
  st.nearGround = tau < n0 ? A.l : tau < n1 ? stepArc(A.l, B.l, (tau - n0) / (n1 - n0), hStep) : B.l;
  st.offYaw = psiA + wrapPi(R.face - psiA) * sstep(0, PIVOT_OFF, tau);
  st.nearYaw = psiA + wrapPi(R.face - psiA) * sstep(n0, n1, tau);
  const offGround = mountOffGround(R, st, A);   // (the off foot steps first, then the near one)
  R.swingHip = crossHip(R, MK, (tt) => mountMotion(tt / MOUNT_SECONDS), psiA);
  // The off foot leaves the ground when the spring takes the hip out of its reach (found on the pelvis path), then
  // swings in to hang under the hip.
  const reachOff = (tt) => {
    const s2 = mountMotion(tt / MOUNT_SECONDS), b = climbBody(R, s2, psiA);
    const hip = hipAt(R, b.P, b.psi, b.lean, 0, -1), gnd = heelUp(R, R.Hp, R.face, s2.heel);
    return len3([hip[0] - gnd[0], hip[1] - gnd[1], hip[2] - gnd[2]]) - REACH * R.span;
  };
  const [r0, r1] = [MK.rise[0][0], MK.rise[MK.rise.length - 1][0]], sw0 = MK.swing[0][0];
  let lo = r0, hi = r1;
  if (reachOff(lo) > 0) hi = lo; else if (reachOff(hi) < 0) lo = hi;
  else for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (reachOff(m) > 0) hi = m; else lo = m; }
  st.air = sstep(hi, hi + 0.2, tau);
  st.offUp = hi;
  const out = poseClimb(g, R, st, psiA, offGround, R.face);
  return { M: st, R, ...out, stirrup: climbNear(R, { ...st, lift: Math.max(1, st.lift) }) };
}

// ---------- the dismount, the real reverse

/** The dismount's script, as MK. */
export const DK = {
  ride: [[0, 1], [0.12, 0]],                                           // the first frames take over from the ride pose
  grip: [[0.03, 0], [0.3, 1], [1.4, 1], [1.98, 0]],
  swap: [[0, 1], [1.2, 1], [1.45, 0]],                                 // right hand on the horn's off side, then (down) the cantle
  arms: [[0.25, 1], [0.5, 0]],                                         // (the hands on the saddle before the arms come down)
  swing: [[0.06, 4], [0.22, 3.5], [0.28, 3.5], [0.56, 3], [0.8, 2], [0.99, 1], [1.36, 0]],   // off foot out of its stirrup, hanging, then back over the croup
  settle: [[0.15, 1], [0.5, 0]],                                       // near stirrup let down as the weight comes on it
  sit: [[0.15, 1], [0.5, 0]],                                          // stand up in the near stirrup over the saddle
  over: [[0.8, 1], [1.16, 0]],                                         // hips back out over the near side once the leg is over the croup
  face: [[0.5, 2], [0.76, 1.6], [1.06, 1], [1.34, 0]],                 // the front (the leg goes back over the croup) .. the saddle
  lean: [[0, 0], [0.25, 0.3], [0.5, 0.65], [0.75, 0.72], [1, 0.7], [1.3, 0.35], [1.62, 0.2], [2, 0]],
  low: [[1.0, 0], [1.7, 1]],                                           // down the near side on a bending near knee (0.7 s)
  air: [[1.1, 1], [1.55, 0]],                                          // off foot reaching down for the ground
  lift: [[1.6, 1], [2, 0]],                                            // near foot out of the stirrup to the ground (0.4 s)
};
/** Getting down: from the low point the pelvis comes up over the off foot (s) as the near foot leaves its stirrup. */
const DK_UP = [1.5, 1.78];
/** The dismount's script at t (0..1 through DISMOUNT_SECONDS), as mountMotion. */
export function dismountMotion(t) {
  const tau = clamp(t, 0, 1) * DISMOUNT_SECONDS, st = { tau, pivot: 1, shift: 1, hop: 1, dip: 0, heel: 0, rise: 1, down: true };
  for (const [k, keys] of Object.entries(DK)) st[k] = trackAt(keys, tau);
  return st;
}

/**
 * Pose a person getting off a horse at t (0..1 through dismountFrames(fps)). o as applyMount (without from). Starts
 * exactly in the ride pose at seatPos and ends standing at mountSpot, facing the saddle, arms down.
 */
export function applyDismount(g, t, o) {
  if (!g?.userData?.joints) return null;
  const R = mountFrame(g, o), st = dismountMotion(t), tau = st.tau;
  // Down the near side until the off foot stands where the climb started from, up onto it, then the near foot comes out
  // of the stirrup and down beside it: they end standing at mountSpot, facing the saddle.
  const B = stance(R, R.face);
  R.swingHip = crossHip(R, DK, (tt) => dismountMotion(tt / DISMOUNT_SECONDS), R.face);
  R.Plow = lerp3(lowFor(R, B.r), R.C0, sstep(DK_UP[0], DK_UP[1], tau));   // up onto the off foot as the near one comes out
  const out = poseClimb(g, R, st, R.face, B.r, R.face);
  return { D: st, R, ...out, stirrup: climbNear(R, { ...st, lift: Math.max(1, st.lift) }) };
}
/** The pelvis down the near side with the near foot in the climb stirrup and the off foot on the ground at Gr. */
function lowFor(R, Gr) {
  const lt = leftOf(R.face);
  let P = [R.C0[0] + 0.03 * R.s, R.C0[1], R.C0[2]];
  // as high as the near leg and the off leg both allow (each at most 0.97 of its length), stepping down from the top
  for (let y = R.Ptop[1]; y > R.C0[1] - 0.2 * R.s; y -= 0.005) {
    P = [P[0], y, P[2]];
    const hn = [P[0] + R.hipX * lt[0], y, P[2] + R.hipX * lt[2]], ho = [P[0] - R.hipX * lt[0], y, P[2] - R.hipX * lt[2]];
    if (len3([hn[0] - R.Sc[0], hn[1] - R.Sc[1], hn[2] - R.Sc[2]]) <= 0.97 * R.span && len3([ho[0] - Gr[0], ho[1] - Gr[1], ho[2] - Gr[2]]) <= 0.96 * R.span) break;
  }
  return P;
}

// ------------------------------------------------------------------ dust
/** How dusty the ground of a set is (0 none .. 1 desert) and the colour of its dust. */
export function groundDust(set, weather) {
  const amt = { desert: 1, beach: 0.55, stadium: 0.5, forest: 0.3, plaza: 0.14, runway: 0.12, street_night: 0.08, empty: 0.12, studio: 0.04, burning_building: 0.25 }[set] ?? 0;
  const color = { desert: [0.66, 0.53, 0.39], beach: [0.74, 0.68, 0.57], stadium: [0.62, 0.48, 0.36], forest: [0.44, 0.39, 0.31] }[set] || [0.6, 0.58, 0.55];
  if (weather === "snow") return { amount: Math.max(amt, 0.5), color: [0.93, 0.95, 0.97] };
  if (weather === "rain") return { amount: amt * 0.15, color };
  return { amount: amt, color };
}

/**
 * Foot and hoof strikes of a plan: [{t (s), pos [x, y, z], v (m/s), dir [x, z] (travel), mass (0.3 a person, 1 a
 * horse), id}]. A strike throws dust in proportion to the speed; a stroll barely marks the ground.
 */
export function strikeEvents(plan, { support = null, mass = null, id = "a" } = {}) {
  const out = [], fps = plan.fps, ms = mass ?? (plan.kind === "horse" ? 1 : 0.3);
  plan.legs.forEach((lg, i) => {
    for (const c of lg.contacts) {
      if (c.t0 < 0 || c.t0 > plan.n - 1) continue;
      const f = Math.round(c.t0), v = plan.speed[f];
      if (v < 0.8) continue;
      out.push({ t: c.t0 / fps, pos: [c.p[0], support ? support(c.p[0], c.p[1]) : 0, c.p[1]], v, dir: [Math.sin(c.yaw), Math.cos(c.yaw)], mass: ms, id: `${id}:${i}:${c.k}` });
    }
  });
  return out;
}

function hash(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
const idNum = (s) => [...String(s)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 100003, 7);

/**
 * Dust at frame F: a pure function of the strikes (the same frame gives the same particles at every capture). Kicked
 * back and up from each strike, slowed by the air, rising and spreading as it fades. opts: {fps, seed, amount (ground
 * 0..1), color, wind [x, z] (m/s), max}. Returns [{p, size, alpha, color, kind: "dust"}] (environments.buildImpactFx).
 */
export function dustParticles(events, F, opts = {}) {
  const fps = opts.fps || 24, seed = opts.seed ?? 1, amount = opts.amount ?? 1, col = opts.color || [0.8, 0.67, 0.5];
  const wind = opts.wind || [0.25, 0.1], max = opts.max || 1400;
  const now = F / fps, out = [];
  if (amount <= 0) return out;
  for (const e of events) {
    const age = now - e.t;
    if (age < 0 || age > 4.2) continue;
    const k = amount * e.mass * clamp((e.v - 0.8) / 5, 0, 2.2);
    if (k <= 0.01) continue;
    const es = seed * 17.3 + idNum(e.id) * 0.731;
    const count = Math.min(e.mass > 0.5 ? 26 : 10, Math.floor((e.mass > 0.5 ? 12 : 8) * k + hash(es, 1)));
    for (let i = 0; i < count; i++) {
      const r1 = hash(es + i, 2), r2 = hash(es + i, 3), r3 = hash(es + i, 4), r4 = hash(es + i, 5);
      const life = (e.mass > 0.5 ? 1.6 : 0.9) + (e.mass > 0.5 ? 2.4 : 1.2) * r1;
      if (age > life) continue;
      const u = age / life, tau = 0.35;
      const back = -(0.25 + 0.55 * r2) * Math.min(e.v, 14) * 0.35, side = (r3 - 0.5) * 2.2, up = 0.5 + 1.3 * r4;
      const go = tau * (1 - Math.exp(-age / tau));
      const dx = e.dir[0] * back + e.dir[1] * side, dz = e.dir[1] * back - e.dir[0] * side;
      out.push({ kind: "dust", color: col.map((c, j) => clamp(c * (0.92 + 0.12 * r3) + (j === 2 ? 0.02 : 0), 0, 1)),
        p: [e.pos[0] + dx * go + wind[0] * age, Math.max(0.04, e.pos[1] + 0.05 + up * go + 0.12 * age), e.pos[2] + dz * go + wind[1] * age],
        size: (e.mass > 0.5 ? 0.45 : 0.22) + (e.mass > 0.5 ? 2.3 : 0.9) * (1 - (1 - u) * (1 - u)) * (0.6 + 0.6 * r2) * Math.sqrt(Math.min(1.5, k)),
        alpha: (e.mass > 0.5 ? 0.24 : 0.3) * Math.min(1, k) * Math.min(1, u * 12) * Math.pow(1 - u, 1.4) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * The dust cloud object (soft points, the impact-FX look). Particles fade out within a few metres of the camera, so
 * a tracking camera running through the trail sees haze, not giant sprites. userData.glass: Clay and Color only (the
 * stage hides it in Depth and the ID matte). set(parts) takes dustParticles() output.
 */
export function buildDustFx(max = 1500) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 4), size = new Float32Array(max);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  geo.setAttribute("pSize", new THREE.BufferAttribute(size, 1));
  geo.setDrawRange(0, 0);
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 1, map: softSprite(), vertexColors: true, transparent: true,
    depthWrite: false, sizeAttenuation: true });
  m.allowOverride = false;   // Clay would draw them as black squares
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("uniform float size;", "uniform float size;\nattribute float pSize;\nvarying float vFade;")
      .replace("gl_PointSize = size;", "gl_PointSize = size * pSize * projectionMatrix[1][1];")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFade = smoothstep(1.5, 7.0, -mvPosition.z);");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vFade;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.a *= vFade;");
  };
  m.customProgramCacheKey = () => "ss_gait_dust";
  const object = new THREE.Points(geo, m);
  object.frustumCulled = false;
  object.renderOrder = 2;
  object.userData.glass = true;
  const set = (parts) => {
    const n = Math.min(max, parts.length);
    for (let i = 0; i < n; i++) {
      const q = parts[i];
      pos[i * 3] = q.p[0]; pos[i * 3 + 1] = q.p[1]; pos[i * 3 + 2] = q.p[2];
      col[i * 4] = q.color[0]; col[i * 4 + 1] = q.color[1]; col[i * 4 + 2] = q.color[2]; col[i * 4 + 3] = q.alpha;
      size[i] = q.size;
    }
    geo.setDrawRange(0, n);
    for (const k of ["position", "color", "pSize"]) geo.attributes[k].needsUpdate = true;
  };
  return { object, set };
}
