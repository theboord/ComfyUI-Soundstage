// Stunt-car vehicle dynamics: the car stunts are driven, not hand-keyed.
//
// The model is a planar four-wheel car with these parts:
// - Body: a rigid body in x, z and yaw.
// - Wheels: each one spins as a state of its own, so a wheel locks under the handbrake and spins up on a launch.
// - Tyres: a Pacejka "magic formula" tyre for every wheel. Combined slip comes from the contact patch's slip velocity
//   (longitudinal and lateral together), so locking, spinning and sliding sideways all use one curve. The force
//   limit is a friction ellipse.
// - Normal loads: each wheel's load comes from longitudinal and lateral weight transfer through the CG height.
// - Sprung mass: roll and pitch are damped oscillators driven by the real accelerations, at about 1.3 Hz with low
//   damping. The body leans, overshoots and wobbles back. That motion feeds back into the weight transfer, so the
//   tyres feel the wobble too.
//
// The driver is a script of timed or triggered control steps: throttle, brake, handbrake, steering and gear (R, N,
// D). A step fires at a time ("at"), a set time after the step before it ("after"), or when the car has turned far
// enough or slowed enough ("when"). The run is fixed-step and has no randomness, so the same script gives the same
// stunt every time.
//
// Sources for the numbers are in share/Stunt_Dynamics/RESEARCH.md:
// - Pacejka coefficients for dry and wet tarmac: the MathWorks Tire-Road Interaction (Magic Formula) block.
// - Wet-asphalt peak friction of 0.5–0.7: the tyre friction tables.
// - Roll gradient of 5–7 °/g for passenger cars and a ride frequency of 1–1.5 Hz: suspension references.
//
// Frames are local to the stunt: +z is the way it travels, heading = atan2(x, z) as on the stage, and the car's own
// +y (body frame) is its left. roll > 0 leans the body onto its right-hand tyres; pitch > 0 is nose up.

const G = 9.81, D2R = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Tyre-road surfaces: peak μ plus the Magic Formula shape (B stiffness, C shape, E curvature). */
export const SURFACES = {
  wet: { label: "Wet asphalt", mu: 0.62, B: 12, C: 2.3, E: 1.0, smoke: 1.3, spray: true },   // less energy, but water sheets off
  dry: { label: "Dry asphalt", mu: 0.9, B: 10, C: 1.9, E: 0.97, smoke: 1.0, spray: false },
};

/** A rear-drive sports coupé (the stunt car). The other kinds scale it (see carParams). */
export const CAR = {
  mass: 1450,         // kg
  a: 1.2, b: 1.45,    // CG to the front and rear axles, m (wheelbase 2.65)
  track: 1.58, h: 0.5, // track width and CG height, m
  k: 1.28,            // yaw radius of gyration, m (Iz = m k² ≈ 2400 kg m²)
  R: 0.33, Iw: 1.2,   // wheel radius, m, and spin inertia, kg m²
  steerMax: 34,       // road-wheel lock, degrees
  torque: 3800,       // wheel torque at the axle in 1st and reverse, N m
  power: 280e3,       // W
  vRev: 14.5, gears: [16, 27, 40, 55], // rev-limited tread speed in reverse and in each forward gear, m/s
  brake: 9000, brakeFront: 0.68, handbrake: 3200, // N m in total
  roll: { grad: 6.0, hz: 1.3, zeta: 0.25 },  // roll gradient deg/g, natural frequency, damping ratio
  pitch: { grad: 2.4, hz: 1.5, zeta: 0.3 },
  rollFront: 0.56,    // share of the lateral load transfer taken by the front axle
  cda: 0.7, crr: 0.013,
  diffLock: 30,       // N m per rad/s of spin difference across the rear axle: a nearly open diff
};

const KIND_SCALE = {
  sports_car: {}, car: { mass: 1500, h: 0.55, roll: { grad: 6.5, hz: 1.2, zeta: 0.26 } },
  police_car: { mass: 1800, a: 1.35, b: 1.55, h: 0.6, k: 1.38, roll: { grad: 6.8, hz: 1.15, zeta: 0.26 } },
  hatchback: { mass: 1200, a: 1.05, b: 1.5, track: 1.5, h: 0.55, k: 1.2, roll: { grad: 6.5, hz: 1.3, zeta: 0.27 } },
  truck: { mass: 2300, a: 1.6, b: 1.9, track: 1.7, h: 0.8, k: 1.55, roll: { grad: 7.5, hz: 1.05, zeta: 0.25 }, torque: 5200 },
};

/**
 * Stunt-prepped suspension (the default for the stunt presets). Stunt cars are softened so the body reads on camera:
 * softer springs and the anti-roll bars off (roll gradient × ~1.6, past the 5–7 °/g of a stock car), ride frequency
 * near 1 Hz (the soft end of the 0.5–1.5 Hz passenger range) and light damping, so the body leans 6–9° in the flick and
 * rocks one to two cycles as it settles. Pitch the same way: a visible dive on the brakes and squat on a launch.
 */
export const STUNT_SUSPENSION = { roll: { gradK: 1.6, hz: 1.0, zeta: 0.16 }, pitch: { gradK: 1.9, hz: 1.15, zeta: 0.2 }, steerMax: 52 };

/** The car for a kind, with an optional mass override (inertia scales with it) and suspension ("stock" | "stunt"). */
export function carParams(kind = "sports_car", mass = null, suspension = "stock") {
  const s = KIND_SCALE[kind] || {};
  const c = { ...CAR, ...s, roll: { ...CAR.roll, ...(s.roll || {}) }, pitch: { ...CAR.pitch, ...(s.pitch || {}) } };
  if (suspension === "stunt") for (const ax of ["roll", "pitch"]) {
    const t = STUNT_SUSPENSION[ax];
    c[ax] = { grad: +(c[ax].grad * t.gradK).toFixed(2), hz: Math.min(c[ax].hz, t.hz), zeta: t.zeta };
  }
  // An angle kit (drift / stunt cars run 50–65° of lock), so the front wheels can follow the tail round a donut.
  // (A welded diff, diffLock ~1500, was tried: it changed nothing in the donut and slowed the J-turn, so it is off.)
  if (suspension === "stunt") c.steerMax = STUNT_SUSPENSION.steerMax;
  if (Number.isFinite(mass) && mass > 300) {
    c.torque *= Math.sqrt(mass / c.mass);   // a heavier car of the same family has a bigger engine, not a proportional one
    c.mass = mass;
  }
  return c;
}

/** Magic Formula on a bounded slip s (radians-like, 0..π/2): the share of μ·Fz the tyre gives. */
export function magic(s, surf) {
  const Bs = surf.B * s;
  return Math.sin(surf.C * Math.atan(Bs - surf.E * (Bs - Math.atan(Bs))));
}

const VREG = 1.5;
/** The driver's hands when aiming the nose: degrees of steer per degree of heading error, per °/s of yaw, and the
 *  fastest a stunt driver winds the wheel (road-wheel degrees per second). */
/** The donut driver's gains: slide angle (deg) held by the throttle, yaw rate by the wheel. */
export const DONUT = { beta: 55, s0: 3, ky: 0.2, kyi: 0.15, iMax: 200, thr0: 0.2, ks: 0.4, off0: 10, kb: -0.2, kr: 0.05 };
export const AIM = { kp: 0.9, kd: 0.12, rate: 160 };   // m/s: the slip reference never drops below this (a car at rest is held, not divided by zero)

/**
 * One tyre. vx, vy: contact-patch velocity in the wheel's frame (m/s); wR: the tread's speed (ω·R); Fz (N).
 * Combined slip σ = |slip velocity| / max(|ωR|, |vx|, VREG), and s = atan σ. A pure slip angle α gives s = α, a
 * locked wheel gives 45°, and a wheel sliding sideways goes to 90°. Then F = μ·Fz·MF(s) against the slip velocity,
 * scaled on the friction ellipse (μx, μy). Returns {fx, fy, s (deg), vs (slip speed, m/s)}.
 */
export function tyreForce(vx, vy, wR, Fz, surf) {
  const sx = vx - wR, sy = vy, vs = Math.hypot(sx, sy);
  if (Fz <= 0 || vs < 1e-9) return { fx: 0, fy: 0, s: 0, vs: 0 };
  const sigma = vs / Math.max(Math.abs(wR), Math.abs(vx), VREG);
  const s = Math.atan(sigma);
  const f = surf.mu * Fz * magic(s, surf);
  return { fx: -f * 1.0 * sx / vs, fy: -f * 0.95 * sy / vs, s: s / D2R, vs };
}

/** Slope of the tyre's force with the tread speed (for the implicit wheel update). */
function tyreStiff(vx, wR, Fz, surf) {
  const ref = Math.max(Math.abs(wR), Math.abs(vx), VREG);
  return surf.mu * Math.max(0, Fz) * surf.B * surf.C / ref;
}

// ---------- the driver ----------

/**
 * Driver scripts. Every step's `set` moves the controls toward new targets over `ramp` seconds:
 * - throttle, brake and handbrake run 0..1;
 * - steer is the road-wheel angle in degrees (+ = left), or "aim" (hold the nose on aim_deg, with counter-steer);
 * - gear is R, N, D (shifts up by itself) or D1..D4 (held in that gear, as for a burnout);
 * - hold_kmh sets the throttle to hold that speed.
 * Triggers: at (seconds), after (seconds after the step before), when {turned_deg, speed_below, speed_above}.
 * `side` (+1 left, −1 right) mirrors every steer value.
 */
export function driverScript(kind, p = {}) {
  const entry = p.entry_kmh ?? DEFAULTS[kind]?.entry_kmh ?? 40;
  const lock = p.lock_deg ?? CAR.steerMax;
  if (kind === "reverse_jturn") {
    const flick = p.flick_s ?? 1.25;
    return { start: { reverse: true, kmh: entry }, steps: [
      { at: 0, set: { gear: "R", hold_kmh: entry, steer: 0 } },
      // Lift, clutch in, a hard flick of the wheel and a stab of the brake: the trailing nose goes light and swings out.
      { at: flick, set: { throttle: 0, hold_kmh: null, gear: "N", steer: lock, ramp: 0.16 } },
      { after: p.brake_delay_s ?? 0.1, set: { brake: p.brake ?? 0, ramp: 0.08 } },
      { after: 0.35, set: { brake: 0, ramp: 0.15 } },
      // Past the sideways point the driver unwinds the wheel and catches the rotation.
      { when: { turned_deg: 95 }, set: { steer: 0, ramp: 0.3 } },
      // Drive in first as the nose comes round, and floor it: the rears light up (the driver lets them spin, about
      // 6 m/s of slip), the tail steps out and he catches the fishtail on the new line. Short-shift once it hooks up.
      { when: { turned_deg: 140 }, set: { gear: "D1", steer: "aim", aim_turn: 180, aim_kp: p.aim_kp ?? 1.4, aim_kd: p.aim_kd ?? 0.1, aim_lag_s: p.aim_lag_s ?? 0.14, throttle: 1, spin_ms: p.launch_spin_ms ?? 6, ramp: 0.12 } },
      { when: { speed_above: 13.5 }, set: { gear: "D", spin_ms: 3 } },
    ] };
  }
  if (kind === "handbrake_180") {
    const pull = p.flick_s ?? 1.5;
    return { start: { reverse: false, kmh: entry }, steps: [
      { at: 0, set: { gear: "D", hold_kmh: entry, steer: 0 } },
      // The entry: a feint away (the Scandinavian flick: the body rolls out and swings back like a pendulum) with a
      // stab of the brakes to load the nose, then a sharp turn-in and the handbrake yanked together. The rears lock
      // and the tail comes round fast.
      { at: pull - (p.hb_feint_s ?? 0.25), set: { throttle: 0, hold_kmh: null, gear: "N", steer: -(p.hb_feint ?? 0.25) * lock, brake: p.hb_brake ?? 0, ramp: 0.12 } },
      { at: pull, set: { steer: (p.hb_lock ?? 1) * lock, ramp: p.hb_ramp ?? 0.1 } },
      { after: p.hb_delay ?? 0.04, set: { handbrake: 1, brake: 0, ramp: 0.05 } },
      { when: { turned_deg: p.hb_unwind ?? 90, or: { speed_below: (p.hb_release_ms ?? 3.5) + 1 } }, set: { steer: 0, ramp: 0.25 } },
      // Off the handbrake, first gear and full throttle while the car is still rotating: the spinning rears kill the
      // last of the slide and pull it away the other way; he catches the nose on the new line.
      // (or sooner, if the slide has nearly died: the rest of the turn comes round under power).
      { when: { turned_deg: p.hb_release ?? 130, or: { speed_below: p.hb_release_ms ?? 3.5 } }, set: { handbrake: 0, gear: "D1", steer: "aim", aim_turn: 180, aim_kp: 1.4, aim_kd: 0.1, aim_lag_s: 0.12,
        throttle: 1, spin_ms: 6, ramp: 0.12 } },
      { when: { speed_above: 13.5 }, set: { gear: "D", spin_ms: 3 } },
    ] };
  }
  if (kind === "donut") {
    return { start: { reverse: false, kmh: entry }, steps: [
      { at: 0, set: { gear: "D", hold_kmh: entry, steer: 0 } },
      // Turn in and floor it: the rear tyres break loose and the car pivots round its nose.
      { at: p.flick_s ?? 0.7, set: { hold_kmh: null, gear: p.gear ?? "D2", steer: lock, throttle: 1, ramp: 0.3 } },
      // From here the closed loop holds the donut for as long as the shot lasts (see DONUT), then drives out.
      // Opposite lock to hold the slide; the throttle keeps the rears spinning, modulated on the yaw rate.
      { when: { turned_deg: 80 }, set: { steer: "track", offset_deg: p.donut_steer ?? 8, yaw_hold: p.yaw_rate ?? 110, ramp: 0.35 } },
      { when: { turned_deg: p.donut_turns_deg ?? 750 }, set: { yaw_hold: null, throttle: 0.25, steer: "aim", aim_turn: (p.donut_turns_deg ?? 750) + 90, ramp: 0.3 } },
      { after: 0.45, set: { throttle: 0.9, ramp: 0.4 } },
    ] };
  }
  return null;
}

/** Per-stunt defaults the user can change: entry speed, surface, mass. */
export const DEFAULTS = {
  reverse_jturn: { entry_kmh: 40, surface: "wet" },
  handbrake_180: { entry_kmh: 40, surface: "wet" },
  donut: { entry_kmh: 10, surface: "wet" },
};

// ---------- the simulation ----------

/**
 * Drive a script. Returns per output frame (0..frames-1 at fps):
 * {t, x, z, h (deg, unwrapped), roll, pitch (deg), speed (m/s), yawRate (deg/s), beta (body slip, deg),
 *  slip [FL, FR, RL, RR] (deg), slipSpeed [..] (m/s), load [..] (N), smoke {amount, wheels}, controls}.
 */
export function simulate(script, { car = CAR, surface = "wet", frames = 121, fps = 24, side = 1, substeps = 100 } = {}) {
  const surf = typeof surface === "string" ? SURFACES[surface] || SURFACES.wet : surface;
  const m = car.mass, Iz = m * car.k * car.k, L = car.a + car.b, tw = car.track / 2;
  const W = [[car.a, tw, true], [car.a, -tw, true], [-car.b, tw, false], [-car.b, -tw, false]];   // x fwd, y left, front?
  const v0 = (script.start.kmh || 0) / 3.6 * (script.start.reverse ? -1 : 1);
  // State: position (local x, z), heading (rad), body velocities, yaw rate, wheel spins, body roll / pitch.
  let X = 0, Z = 0, H = script.start.reverse ? Math.PI : 0, vx = v0, vy = 0, r = 0;
  const w = W.map(() => v0 / car.R);
  let roll = 0, rollV = 0, pitch = 0, pitchV = 0, axF = 0, ayF = 0;
  const ctl = { throttle: 0, brake: 0, handbrake: 0, steer: 0, gear: script.start.reverse ? "R" : "D" };
  const tgt = { ...ctl }, rate = { throttle: 1e9, brake: 1e9, handbrake: 1e9, steer: 1e9 };
  let feather = 1, spinOk = 3, aimK = AIM, track = null, hold = null, aim = null, yawHold = null, yawI = 0, fired = -1, firedAt = 0;
  const H0 = H;
  const hist = new Array(Math.ceil(0.4 * fps * substeps) + 1);   // the driver's view of heading and yaw rate, for his reaction lag
  let histI = 0;
  const dt = 1 / (fps * substeps);
  const out = [];
  const Fz0 = W.map(([x]) => m * G * (x > 0 ? car.b : car.a) / L / 2);
  let last = { slip: [0, 0, 0, 0], vs: [0, 0, 0, 0], Fz: Fz0.slice() };
  const rollW = 2 * Math.PI * car.roll.hz, pitchW = 2 * Math.PI * car.pitch.hz;
  for (let step = 0; step < frames * substeps; step++) {
    const t = step * dt, speed = Math.hypot(vx, vy), turned = Math.abs(H - H0) / D2R;
    histI = (histI + 1) % hist.length; hist[histI] = [H, r];
    if (step % substeps === 0) {
      const f = step / substeps;
      out.push({ t, x: X, z: Z, h: H / D2R, roll, pitch, speed, yawRate: r / D2R,
        beta: speed > 0.5 ? Math.atan2(vy, Math.abs(vx)) / D2R : 0,
        slip: last.slip.slice(), slipSpeed: last.vs.slice(), load: last.Fz.slice(), tread: w.map((x) => +(x * car.R).toFixed(3)),
        controls: { ...ctl, steer: +ctl.steer.toFixed(2) }, frame: f });
    }
    // The driver: fire the next step when its trigger is met, then move the controls toward their targets.
    // A trigger: every condition in `when` holds (turned_deg, speed_below, speed_above), or every one in `when.or`.
    const whenOk = (w) => (w.turned_deg === undefined || turned >= w.turned_deg)
      && (w.speed_below === undefined || speed < w.speed_below) && (w.speed_above === undefined || speed > w.speed_above);
    while (fired + 1 < script.steps.length) {
      const s = script.steps[fired + 1];
      const ok = s.at !== undefined ? t >= s.at - 1e-9
        : s.after !== undefined ? t >= firedAt + s.after - 1e-9
        : s.when ? whenOk(s.when) || (s.when.or ? whenOk(s.when.or) : false) : true;
      if (!ok) break;
      fired++; firedAt = t;
      const set = s.set || {}, ramp = Math.max(1e-3, set.ramp ?? 0.001);
      for (const k of ["throttle", "brake", "handbrake"]) if (Number.isFinite(set[k])) { tgt[k] = set[k]; rate[k] = Math.abs(set[k] - ctl[k]) / ramp + 1e-6; }
      if ("hold_kmh" in set) hold = set.hold_kmh;
      if (Number.isFinite(set.spin_ms)) spinOk = set.spin_ms;
      if ("yaw_hold" in set) { yawHold = set.yaw_hold; yawI = 0; }
      if (set.gear) ctl.gear = set.gear;
      // "aim": hold the nose at aim_turn degrees round from the start, the way the car has been rotating.
      if (set.steer === "track") { aim = null; track = side * (set.offset_deg ?? 0); rate.steer = AIM.rate; }
      else track = null;
      if (set.steer === "aim") { aim = H0 + (Math.sign(H - H0) || 1) * (set.aim_turn ?? 180) * D2R; aimK = { kp: set.aim_kp ?? AIM.kp, kd: set.aim_kd ?? AIM.kd, lag: set.aim_lag_s ?? 0 }; }
      else if (Number.isFinite(set.steer)) { aim = null; tgt.steer = side * set.steer; rate.steer = Math.abs(tgt.steer - ctl.steer) / ramp + 1e-6; }
    }
    if (hold !== null) tgt.throttle = clamp(0.25 * (hold / 3.6 - speed) + 0.35 * (hold / 3.6 > speed ? 1 : 0), 0, 1), rate.throttle = 4;
    if (yawHold !== null) {
      // Holding a donut (closed loop, after Hindiyeh & Gerdes: the rear tyres' spin sets how much side grip they
      // keep, the front wheels set the yaw moment):
      // - outer loop: the yaw-rate error (PI) sets how fast the rear treads should spin past the road; a slow
      //   rotation asks for more spin, so the rears let go and the tail swings wider;
      // - inner loop: the throttle chases that rear spin (fast, like a driver on the rev limiter);
      // - the wheel tracks the front axle's slide (opposite lock), plus an offset that holds the slide angle β.
      const bAbs = speed > 0.5 ? Math.abs(Math.atan2(vy, Math.abs(vx))) / D2R : 0;
      const er = yawHold - Math.abs(r) / D2R, vsR = Math.max(last.vs[2], last.vs[3]);
      yawI = clamp(yawI + er * dt, -DONUT.iMax, DONUT.iMax);
      const spinT = clamp(DONUT.s0 + DONUT.ky * er + DONUT.kyi * yawI, 2, 30);
      tgt.throttle = clamp(DONUT.thr0 + DONUT.ks * (spinT - vsR), 0.05, 1); rate.throttle = 6;
      if (track !== null) track = side * clamp(DONUT.off0 + DONUT.kb * (DONUT.beta - bAbs) + DONUT.kr * er, -12, 25);
    }
    if (aim !== null) {
      // Aim the nose (the target heading mirrored with the side, measured from the start), counter-steering the yaw.
      // Steer the nose onto the target and damp the yaw (counter-steer). Steering works the other way in reverse.
      // A driver reacts a beat late (aim_lag_s): he steers on where the nose was, which is what makes a fishtail.
      const back = Math.min(hist.length - 1, Math.round((aimK.lag || 0) / dt)), seen = hist[(histI - back + hist.length) % hist.length] || [H, r];
      const e = (aim - seen[0]) / D2R, dir = vx >= 0 ? 1 : -1;
      tgt.steer = clamp(dir * (aimK.kp * e - aimK.kd * seen[1] / D2R), -car.steerMax, car.steerMax);
      rate.steer = AIM.rate;
    }
    if (track !== null) {
      // Drifting hands: point the front wheels down the way the front axle is going (opposite lock follows the
      // slide by itself), plus a few degrees into the turn to keep the nose pulling round.
      tgt.steer = clamp(Math.atan2(vy + r * car.a, Math.max(0.3, Math.abs(vx))) / D2R * Math.sign(vx || 1) + track, -car.steerMax, car.steerMax);
    }
    for (const k of ["throttle", "brake", "handbrake", "steer"]) {
      const d = tgt[k] - ctl[k], mv = rate[k] * dt;
      ctl[k] = Math.abs(d) <= mv ? tgt[k] : ctl[k] + Math.sign(d) * mv;
    }
    const delta = clamp(ctl.steer, -car.steerMax, car.steerMax) * D2R;

    // Normal loads: static, plus weight transfer from the accelerations; partly instantaneous (the unsprung and
    // geometric part), mostly through the sprung body's roll / pitch state, so the wobble reaches the tyres.
    const ayEff = 0.35 * ayF + 0.65 * (roll / car.roll.grad) * G;
    const axEff = 0.35 * axF + 0.65 * (pitch / car.pitch.grad) * G;
    const dLong = m * axEff * car.h / L;
    const dLat = m * ayEff * car.h / car.track;
    const Fz = W.map(([x, y, front], i) => {
      const axle = Fz0[i] * 2 + (front ? -dLong : dLong);
      const share = front ? car.rollFront : 1 - car.rollFront;
      return Math.max(0, axle / 2 + (y > 0 ? -1 : 1) * share * dLat);
    });

    // Drive: torque at the driven (rear) axle, open-ish diff with a little locking.
    let Tdrive = 0;
    const wRear = (w[2] + w[3]) / 2, vWheel = wRear * car.R;
    if (ctl.gear === "R" || ctl.gear[0] === "D") {
      // Reverse is one gear. Drive shifts up on road speed (an automatic, or a stunt driver short-shifting); torque
      // at the wheels falls with each taller gear, and the tread can't spin past the gear's rev limit.
      const dir = ctl.gear === "R" ? -1 : 1;
      let limit = car.vRev, gearT = car.torque;
      if (dir > 0) {
        const auto = car.gears.findIndex((g) => Math.abs(vx) < 0.8 * g);
        const gi = ctl.gear.length > 1 ? clamp(+ctl.gear[1] - 1, 0, car.gears.length - 1) : auto < 0 ? car.gears.length - 1 : auto;
        limit = car.gears[gi];
        gearT = car.torque * car.gears[0] / limit;
      }
      const avail = Math.min(gearT, car.power * car.R / Math.max(1, Math.abs(vWheel)));
      // The driver feathers the throttle when the rears spin up past the slip he allows (spinOk m/s: a few on the
      // road, more on a stunt launch; not at all while holding a donut on the yaw).
      const vsR = Math.max(last.vs[2], last.vs[3]);
      feather += ((yawHold === null ? clamp(1 - (vsR - spinOk) / 3, 0.15, 1) : 1) - feather) * dt / 0.12;
      Tdrive = dir * ctl.throttle * feather * avail * clamp((limit - dir * vWheel) / 1.0, 0, 1);
      if (ctl.throttle < 0.05) Tdrive -= Math.sign(wRear) * 220 * Math.min(1, Math.abs(vWheel) / 2);   // engine braking
    }

    let Fx = 0, Fy = 0, Mz = 0;
    const slip = [], vsA = [];
    for (let i = 0; i < 4; i++) {
      const [px, py, front] = W[i];
      const cvx = vx - r * py, cvy = vy + r * px;
      const d = front ? delta : 0, c = Math.cos(d), s = Math.sin(d);
      const wvx = cvx * c + cvy * s, wvy = -cvx * s + cvy * c;
      // Wheel spin, implicit in the tyre's stiffness (stable at any step), then the brakes as Coulomb friction.
      let T = front ? 0 : Tdrive / 2 + (i === 2 ? 1 : -1) * (car.diffLock ?? 30) * (w[3] - w[2]);
      const tf0 = tyreForce(wvx, wvy, w[i] * car.R, Fz[i], surf);
      const k = tyreStiff(wvx, w[i] * car.R, Fz[i], surf) * car.R * car.R;
      const Ieff = car.Iw + dt * k;
      let wn = w[i] + dt * (T - tf0.fx * car.R) / Ieff;
      const Tb = ctl.brake * car.brake * (front ? car.brakeFront : 1 - car.brakeFront) / 2 + (front ? 0 : ctl.handbrake * car.handbrake / 2);
      const dec = Tb * dt / Ieff;
      wn = Math.abs(wn) <= dec ? 0 : wn - Math.sign(wn) * dec;
      w[i] = wn;
      const tf = tyreForce(wvx, wvy, w[i] * car.R, Fz[i], surf);
      const bx = tf.fx * c - tf.fy * s, by = tf.fx * s + tf.fy * c;
      Fx += bx; Fy += by; Mz += px * by - py * bx;
      slip.push(tf.s); vsA.push(tf.vs);
    }
    // Aero drag and rolling resistance.
    const drag = 0.5 * 1.2 * car.cda * speed;
    Fx += -drag * vx - car.crr * m * G * Math.tanh(vx / 0.5);
    Fy += -drag * vy;
    const ax = Fx / m, ay = Fy / m;
    vx += (ax + r * vy) * dt;
    vy += (ay - r * vx) * dt;
    r += (Mz / Iz) * dt;
    H += r * dt;
    const sh = Math.sin(H), ch = Math.cos(H);
    X += (vx * sh + vy * ch) * dt;   // forward (sin H, cos H); left (cos H, −sin H)
    Z += (vx * ch - vy * sh) * dt;
    // The sprung body: damped oscillators toward the steady lean the accelerations ask for.
    const fa = dt / (0.02 + dt);
    axF += (ax - axF) * fa; ayF += (ay - ayF) * fa;
    const rollT = car.roll.grad * ayF / G, pitchT = car.pitch.grad * axF / G;
    // Bump stops: past 8.5° of roll (5° of pitch) the body meets a stiff rubber stop instead of leaning on and on.
    const bumpR = Math.abs(roll) > 8.5 ? -6 * rollW * rollW * (roll - Math.sign(roll) * 8.5) : 0;
    const bumpP = Math.abs(pitch) > 5 ? -6 * pitchW * pitchW * (pitch - Math.sign(pitch) * 5) : 0;
    rollV += (rollW * rollW * (rollT - roll) - 2 * car.roll.zeta * rollW * rollV + bumpR) * dt; roll += rollV * dt;
    pitchV += (pitchW * pitchW * (pitchT - pitch) - 2 * car.pitch.zeta * pitchW * pitchV + bumpP) * dt; pitch += pitchV * dt;
    last = { slip, vs: vsA, Fz };
  }
  // Smoke (dry) or spray (wet) from the slip energy: the power each tyre burns sliding, μ·Fz × slip speed. A tyre
  // scrubbing past ~4 kW starts to smoke; ~25 kW (a locked or spinning wheel at 8 m/s on a dry road) is a full cloud.
  // On a wet road the same energy throws up a sheet of spray instead (the kind is in `smoke.kind`).
  for (const o of out) {
    const amt = o.slipSpeed.map((vs, i) => clamp((surf.mu * o.load[i] * vs - 4000) / 21000, 0, 1) * surf.smoke);
    const fr = Math.max(amt[0], amt[1]), re = Math.max(amt[2], amt[3]), a = Math.min(1, Math.max(fr, re));
    o.smoke = { amount: +a.toFixed(3), wheels: a <= 0.01 ? "" : fr > 0.45 * a && re > 0.45 * a ? "all" : fr > re ? "front" : "rear",
      kind: surf.spray ? "spray" : "smoke" };
  }
  return out;
}

/**
 * Metrics for checking a run against the researched ranges:
 * - rotation_s: the time from 10° to 170° of the 180°;
 * - slide_m: the distance travelled from the flick to the moment the nose is round (within 10° of the end heading);
 * - peak yaw rate (°/s), peak and steady roll (°), peak pitch (°), peak tyre slip (°), the speed at the flick;
 * - roll_hz: the body's wobble frequency after the turn, measured from the zero crossings.
 */
export function metrics(run, { turn = 180 } = {}) {
  const h0 = run[0].h, sgn = Math.sign(run[run.length - 1].h - h0) || 1;
  const turned = run.map((o) => (o.h - h0) * sgn);
  const tAt = (deg) => { const i = turned.findIndex((x) => x >= deg); return i < 0 ? null : run[i].t; };
  const flickI = run.findIndex((o) => Math.abs(o.controls.steer) > 3 || o.controls.handbrake > 0.1);
  const t10 = tAt(0.055 * turn), t90 = tAt(0.945 * turn), done = run.findIndex((o, i) => turned[i] >= turn - 10);
  let slide = 0;
  if (flickI >= 0 && done > flickI) for (let i = flickI + 1; i <= done; i++) slide += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
  const win = run.slice(Math.max(0, flickI), done > 0 ? Math.min(run.length, done + 24) : run.length);
  const absMax = (arr) => Math.max(0, ...arr.map(Math.abs));
  // Wobble: the roll's zero crossings, after the peak, measured about the run's own settling value.
  const rolls = run.map((o) => o.roll), pk = rolls.reduce((bi, v, i) => (Math.abs(v) > Math.abs(rolls[bi]) ? i : bi), 0);
  const cross = [];
  for (let i = pk + 1; i < run.length; i++) if (Math.sign(rolls[i]) !== Math.sign(rolls[i - 1]) && rolls[i - 1] !== 0) cross.push(run[i].t);
  const roll_hz = cross.length >= 3 ? (cross.length - 1) / 2 / (cross[cross.length - 1] - cross[0]) : null;
  return {
    entry_kmh: flickI >= 0 ? +(run[flickI].speed * 3.6).toFixed(1) : null,
    rotation_s: t10 !== null && t90 !== null ? +(t90 - t10).toFixed(2) : null,
    slide_m: +slide.toFixed(1),
    peak_yaw_rate: +absMax(run.map((o) => o.yawRate)).toFixed(0),
    peak_roll: +absMax(win.map((o) => o.roll)).toFixed(1),
    peak_pitch: +absMax(win.map((o) => o.pitch)).toFixed(1),
    peak_slip: +Math.max(...run.map((o) => Math.max(...o.slip))).toFixed(0),
    peak_beta: +absMax(run.map((o) => o.beta)).toFixed(0),
    roll_crossings: cross.length,
    roll_hz: roll_hz && +roll_hz.toFixed(2),
    turned_deg: +turned[turned.length - 1].toFixed(0),
  };
}

// ---------- live driving (Milestone 29, Drive mode) ----------

/**
 * The same car, stepped live from a player's controls (web/stage/drive.mjs): the planar body, the four spinning wheels,
 * the Magic Formula tyres on combined slip, weight transfer and the sprung body, exactly the equations of simulate()
 * (a test drives both with the same controls and gets the same run). The driver here is a person on a controller, so
 * there is no script: step(ctl, dt) takes {throttle, brake, handbrake 0..1, steer (road-wheel degrees, + left),
 * gear "D" | "R" | "N"} and advances the car by dt seconds in fixed substeps. Positions are in the stage's world:
 * heading = atan2(x, z), as everywhere on the stage.
 */
export class LiveCar {
  constructor({ car = CAR, surface = "dry", x = 0, z = 0, heading = 0, speed = 0, substeps = 100, fps = 24 } = {}) {
    this.car = car;
    this.surf = typeof surface === "string" ? SURFACES[surface] || SURFACES.dry : surface;
    this.dtStep = 1 / (fps * substeps);
    const m = car.mass, L = car.a + car.b, tw = car.track / 2;
    this.k = { m, Iz: m * car.k * car.k, L, W: [[car.a, tw, true], [car.a, -tw, true], [-car.b, tw, false], [-car.b, -tw, false]],
      rollW: 2 * Math.PI * car.roll.hz, pitchW: 2 * Math.PI * car.pitch.hz };
    this.k.Fz0 = this.k.W.map(([px]) => m * G * (px > 0 ? car.b : car.a) / L / 2);
    Object.assign(this, { X: x, Z: z, H: heading, vx: speed, vy: 0, r: 0, w: this.k.W.map(() => speed / car.R),
      roll: 0, rollV: 0, pitch: 0, pitchV: 0, axF: 0, ayF: 0, feather: 1, spinOk: 3, acc: 0 });
    this.last = { slip: [0, 0, 0, 0], vs: [0, 0, 0, 0], Fz: this.k.Fz0.slice() };
    this.ctl = { throttle: 0, brake: 0, handbrake: 0, steer: 0, gear: "D" };
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  /** Forward speed (m/s, negative in reverse). */
  get forward() { return this.vx; }
  /** Body slip angle (deg): how sideways the car is going. */
  get beta() { return this.speed > 0.5 ? Math.atan2(this.vy, Math.abs(this.vx)) / D2R : 0; }
  /** The gear the automatic is in: "R", "N" or 1..4. */
  get gearLabel() {
    if (this.ctl.gear === "R") return "R";
    if (this.ctl.gear === "N") return "N";
    const i = this.car.gears.findIndex((g) => Math.abs(this.vx) < 0.8 * g);
    return String(i < 0 ? this.car.gears.length : i + 1);
  }
  /** Smoke or spray from the slip energy now (0..1), as simulate() works it out. */
  get smoke() { return this.smokeInfo.amount; }
  /** {amount 0..1, wheels: "" | "front" | "rear" | "all"} now, as simulate() keys it for the stage's smoke. */
  get smokeInfo() {
    const amt = this.last.vs.map((vs, i) => clamp((this.surf.mu * this.last.Fz[i] * vs - 4000) / 21000, 0, 1) * this.surf.smoke);
    const fr = Math.max(amt[0], amt[1]), re = Math.max(amt[2], amt[3]), a = Math.min(1, Math.max(fr, re));
    return { amount: +a.toFixed(3), wheels: a <= 0.01 ? "" : fr > 0.45 * a && re > 0.45 * a ? "all" : fr > re ? "front" : "rear" };
  }

  /** Advance by dt seconds with these controls (held over the interval). Returns this. */
  step(ctl, dt) {
    Object.assign(this.ctl, ctl);
    this.acc += dt;
    while (this.acc >= this.dtStep - 1e-12) { this._sub(this.dtStep); this.acc -= this.dtStep; }
    return this;
  }

  /** One substep: the body of simulate()'s loop after the driver (same order, same numbers). */
  _sub(dt) {
    const car = this.car, surf = this.surf, ctl = this.ctl, { m, Iz, L, W, Fz0, rollW, pitchW } = this.k;
    let { vx, vy, r, H, X, Z, roll, rollV, pitch, pitchV, axF, ayF, feather } = this;
    const w = this.w, last = this.last, spinOk = this.spinOk;
    const speed = Math.hypot(vx, vy);
    const delta = clamp(ctl.steer, -car.steerMax, car.steerMax) * D2R;
    const ayEff = 0.35 * ayF + 0.65 * (roll / car.roll.grad) * G;
    const axEff = 0.35 * axF + 0.65 * (pitch / car.pitch.grad) * G;
    const dLong = m * axEff * car.h / L, dLat = m * ayEff * car.h / car.track;
    const Fz = W.map(([, y, front], i) => {
      const axle = Fz0[i] * 2 + (front ? -dLong : dLong);
      const share = front ? car.rollFront : 1 - car.rollFront;
      return Math.max(0, axle / 2 + (y > 0 ? -1 : 1) * share * dLat);
    });
    let Tdrive = 0;
    const wRear = (w[2] + w[3]) / 2, vWheel = wRear * car.R;
    if (ctl.gear === "R" || ctl.gear[0] === "D") {
      const dir = ctl.gear === "R" ? -1 : 1;
      let limit = car.vRev, gearT = car.torque;
      if (dir > 0) {
        const auto = car.gears.findIndex((g) => Math.abs(vx) < 0.8 * g);
        const gi = ctl.gear.length > 1 ? clamp(+ctl.gear[1] - 1, 0, car.gears.length - 1) : auto < 0 ? car.gears.length - 1 : auto;
        limit = car.gears[gi];
        gearT = car.torque * car.gears[0] / limit;
      }
      const avail = Math.min(gearT, car.power * car.R / Math.max(1, Math.abs(vWheel)));
      const vsR = Math.max(last.vs[2], last.vs[3]);
      feather += (clamp(1 - (vsR - spinOk) / 3, 0.15, 1) - feather) * dt / 0.12;
      Tdrive = dir * ctl.throttle * feather * avail * clamp((limit - dir * vWheel) / 1.0, 0, 1);
      if (ctl.throttle < 0.05) Tdrive -= Math.sign(wRear) * 220 * Math.min(1, Math.abs(vWheel) / 2);
    }
    let Fx = 0, Fy = 0, Mz = 0;
    const slip = [], vsA = [];
    for (let i = 0; i < 4; i++) {
      const [px, py, front] = W[i];
      const cvx = vx - r * py, cvy = vy + r * px;
      const d = front ? delta : 0, c = Math.cos(d), s = Math.sin(d);
      const wvx = cvx * c + cvy * s, wvy = -cvx * s + cvy * c;
      const T = front ? 0 : Tdrive / 2 + (i === 2 ? 1 : -1) * (car.diffLock ?? 30) * (w[3] - w[2]);
      const tf0 = tyreForce(wvx, wvy, w[i] * car.R, Fz[i], surf);
      const k = tyreStiff(wvx, w[i] * car.R, Fz[i], surf) * car.R * car.R;
      const Ieff = car.Iw + dt * k;
      let wn = w[i] + dt * (T - tf0.fx * car.R) / Ieff;
      const Tb = ctl.brake * car.brake * (front ? car.brakeFront : 1 - car.brakeFront) / 2 + (front ? 0 : ctl.handbrake * car.handbrake / 2);
      const dec = Tb * dt / Ieff;
      wn = Math.abs(wn) <= dec ? 0 : wn - Math.sign(wn) * dec;
      w[i] = wn;
      const tf = tyreForce(wvx, wvy, w[i] * car.R, Fz[i], surf);
      const bx = tf.fx * c - tf.fy * s, by = tf.fx * s + tf.fy * c;
      Fx += bx; Fy += by; Mz += px * by - py * bx;
      slip.push(tf.s); vsA.push(tf.vs);
    }
    const drag = 0.5 * 1.2 * car.cda * speed;
    Fx += -drag * vx - car.crr * m * G * Math.tanh(vx / 0.5);
    Fy += -drag * vy;
    const ax = Fx / m, ay = Fy / m;
    vx += (ax + r * vy) * dt;
    vy += (ay - r * vx) * dt;
    r += (Mz / Iz) * dt;
    H += r * dt;
    const sh = Math.sin(H), ch = Math.cos(H);
    X += (vx * sh + vy * ch) * dt;
    Z += (vx * ch - vy * sh) * dt;
    const fa = dt / (0.02 + dt);
    axF += (ax - axF) * fa; ayF += (ay - ayF) * fa;
    const rollT = car.roll.grad * ayF / G, pitchT = car.pitch.grad * axF / G;
    const bumpR = Math.abs(roll) > 8.5 ? -6 * rollW * rollW * (roll - Math.sign(roll) * 8.5) : 0;
    const bumpP = Math.abs(pitch) > 5 ? -6 * pitchW * pitchW * (pitch - Math.sign(pitch) * 5) : 0;
    rollV += (rollW * rollW * (rollT - roll) - 2 * car.roll.zeta * rollW * rollV + bumpR) * dt; roll += rollV * dt;
    pitchV += (pitchW * pitchW * (pitchT - pitch) - 2 * car.pitch.zeta * pitchW * pitchV + bumpP) * dt; pitch += pitchV * dt;
    Object.assign(this, { vx, vy, r, H, X, Z, roll, rollV, pitch, pitchV, axF, ayF, feather });
    this.last = { slip, vs: vsA, Fz };
  }

  /** Stop dead where it is (it hit a wall): the body's velocities and the wheel spins go to the impact's leftovers. */
  bump(nx, nz, restitution = 0.15) {
    // World velocity, its component into the wall (normal n points out of the wall) removed (and a little bounce).
    const sh = Math.sin(this.H), ch = Math.cos(this.H);
    let wx = this.vx * sh + this.vy * ch, wz = this.vx * ch - this.vy * sh;
    const into = wx * nx + wz * nz;
    if (into < 0) { wx -= (1 + restitution) * into * nx; wz -= (1 + restitution) * into * nz; }
    wx *= 0.7; wz *= 0.7;
    this.vx = wx * sh + wz * ch; this.vy = wx * ch - wz * sh;
    this.r *= 0.5;
    for (let i = 0; i < 4; i++) this.w[i] = this.vx / this.car.R;
  }
}
