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
import { feetOf, legIK, resetFeet } from "./mocap.mjs";
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
    if (sw > 0.05 && u > B.idle) F[g] = clamp(v * HORSE_FOOTFALL[g].duty / sw, 0.55 * F[g], 1.5 * F[g]) * k;
  }
  for (const g of HORSE_ORDER) {
    freq += w[g] * F[g];
    duty += w[g] * HORSE_FOOTFALL[g].duty;
    // offsets blend on the circle, from the walk's
    HORSE_FOOTFALL[g].off.forEach((o, i) => { off[i] += w[g] * (HORSE_FOOTFALL.walk.off[i] + wrapPi((o - HORSE_FOOTFALL.walk.off[i]) * TAU) / TAU); });
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
    let rate = speed[f] > idleV ? g.freq / fps * clamp(speed[f] / (idleV * 2), 0, 1) : 0;
    // A planted foot left too far behind the hips comes up now (a quick first step out of a standing start).
    const reachBack = Math.max((kind === "horse" ? 0.3 : 0.24) * height, 1.15 * g.duty * speed[f] / Math.max(g.freq, 0.3));
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
  const turn = clamp(Math.atan2(v * plan.yawRate[fi], 9.8), -0.38, 0.38);
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
    const reach = (Lg.thigh + Lg.shin) * sc * 0.985, dx = t.ankle.x - H.x, dz = t.ankle.z - H.z, hz = Math.hypot(dx, dz);
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
    back = { dx: (p.x - info.torsoRest.x) * sc.x, dy: (p.y - info.torsoRest.y) * sc.y + heave, dz: (p.z - info.torsoRest.z) * sc.z, pitch };
  }
  const state = { name: G.name, weights: w, idle, phase: ph, speed: v, heave, back, hooves: out };
  g.userData.horseGait = state;
  g.userData.gaitCycle = ph * TAU;
  return state;
}

/** Bend a leg chain about one world axis (the horse's side) so its end reaches T; small hinge steps, deterministic. */
function ccdLeg(leg, T, axis) {
  const E = new THREE.Vector3(), P = new THREE.Vector3(), e = new THREE.Vector3(), t = new THREE.Vector3(), q = new THREE.Quaternion();
  const wq = new THREE.Quaternion(), pq = new THREE.Quaternion();
  const turned = leg.chain.map(() => 0);
  for (let it = 0; it < 12; it++) {
    for (let j = leg.chain.length - 1; j >= 0; j--) {
      const b = leg.chain[j];
      b.getWorldPosition(P); leg.end.getWorldPosition(E);
      e.subVectors(E, P); t.subVectors(T, P);
      e.addScaledVector(axis, -e.dot(axis)); t.addScaledVector(axis, -t.dot(axis));
      if (e.lengthSq() < 1e-8 || t.lengthSq() < 1e-8) continue;
      let ang = Math.atan2(axis.dot(_v1.crossVectors(e, t)), e.dot(t));
      ang = clamp(ang, -0.35, 0.35);
      const lim = 0.45;                                          // a correction, never a re-pose
      ang = clamp(turned[j] + ang, -lim, lim) - turned[j];
      turned[j] += ang;
      q.setFromAxisAngle(axis, ang);
      b.getWorldQuaternion(wq);
      b.parent.getWorldQuaternion(pq);
      b.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
      b.updateMatrixWorld(true);
    }
    leg.end.getWorldPosition(E);
    if (E.distanceToSquared(T) < 1e-6) break;
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
