// Watercraft dynamics: the boats float, plane, heel and are paddled by physics, not hand-keyed (beside vehsim.mjs).
//
// Every hull is described once (HULLS: length, beam, depth, rocker, deadrise, plan form) and both the clay mesh
// (library.mjs lofts it) and the physics read that description, so what you see is what floats.
//
// The model, per fixed step (240 Hz):
// - Buoyancy over hull sample points: the waterplane is cut into columns (about 15 stations x 7 across). Each column's
//   bottom follows the hull (keel rocker, deadrise or round bilge); its immersion under the wave surface (waves.mjs)
//   gives ρ g A d. Summed with their lever arms that is heave, pitch and roll: the hull finds its own waterline, rides
//   the swell, and rights itself through its real waterplane (no fake sine bob).
// - Damping and added mass: heave, pitch and roll are damped to a fraction of critical (ζ 0.2 / 0.25 / 0.08 for a
//   displacement hull, the roll lightest: boats roll for a long time) with an added mass of about the displaced water.
// - Resistance: ITTC-57 skin friction on the wetted area, a wave-making hump at Froude numbers 0.35–0.5 and air drag.
// - Planing (speedboats, the fishing boat partly): Savitsky's (1964) prismatic-hull lift C_L0 = τ^1.1 (0.012 λ^½),
//   with the deadrise correction C_Lβ = C_L0 − 0.0065 β C_L0^0.6 and the centre of pressure
//   lp/λb = 0.75 − 1/(5.21 Cv²/λ² + 2.39), where τ (trim) and λ (wetted length / beam) come from the hull points
//   actually under water. The transom runs dry as the boat passes Fn ≈ 0.4 (it ventilates), so the stern loses
//   support and the bow climbs (the hump), then the dynamic lift carries the hull up and it levels out as it planes.
// - Thrust: an outboard or inboard with a propulsive efficiency (T = ηP/V, capped at bollard pull), vectored by the
//   steering (outboards) or with a rudder; motor trim tilts the thrust line (trim out = bow up).
// - Sails: apparent wind from the true wind and the boat's velocity; lift and drag of the sail at its angle of attack
//   (stall past ~22°, luffing below ~6°); the heeled sail sees only cos φ of the wind (force ∝ cos² φ); the keel or
//   centreboard is a foil that resists leeway; heeling moment = side force × (CE height − CLR depth) against the
//   hull's own righting moment (points), ballast and the crew hiking out.
// - Paddles and oars: each paddler has a stroke cycle (catch, drive, exit, recovery) at a cadence; during the drive the
//   blade moves aft relative to the boat at s(u) and pushes with ½ ρ C_D A (s − u)², so the boat surges each stroke and
//   a single-blade stroke yaws it (the J-stroke corrects it at the stern). The phase per seat is output so the people
//   on board pull in sync with the thrust that moves the hull.
//
// Frames: body x forward, y left, z up (the stage: +Z, +X, +Y), origin at midship on the keel's lowest point.
// heading = atan2(x, z) as on the stage; pitch > 0 bow up; roll > 0 leans onto the right side (as vehsim).
// The run is deterministic: fixed step, no randomness (the waves are seeded).
import { heightAt, velocityAt, G, RHO_FRESH, RHO_SEA } from "./waves.mjs";

const D2R = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const NU = 1.19e-6, RHO_AIR = 1.225;

// ------------------------------------------------------------------ the boats

/**
 * Hull and rig per kind. L: length overall (m), B: beam at the sheer, D: depth keel to sheer at midship, mass: loaded
 * (hull + engine + crew, kg), zcg: centre of gravity above the keel, lcg: ahead of midship (m). plan: "transom" |
 * "double" (pointed both ends) | "raft" | "logs"; section: "vee" | "round" | "flat" | "tube" | "logs"; deadrise (deg,
 * aft) / deadriseBow; rocker (keel rise at the ends, m); forefoot (planing bow rise share of D); sheer (sheer rise at
 * the bow, m); transom: stern width share. drive: "outboard" | "inboard" | "sail" | "paddle" | "oars" | "raft" | "pole".
 * Sources: manufacturer specs of typical boats (a 21 ft bowrider, a 27 ft Down East workboat, a Laser, a 32 ft
 * cruiser-racer, a 16 ft Prospector canoe, a 17 ft sea kayak, a 12 ft rowing skiff, a 14 ft self-bailing raft).
 */
export const HULLS = {
  speedboat: { label: "Speedboat", L: 6.4, B: 2.44, D: 1.05, mass: 1550, zcg: 0.62, lcg: -0.55, plan: "transom", section: "vee", deadrise: 19, deadriseBow: 40,
    rocker: 0, forefoot: 0.55, sheer: 0.22, transom: 0.86, drive: "outboard", power: 165e3, eta: 0.56, bollard: 6200, steerMax: 32, trimRange: [-4, 8],
    planing: true, wave: 0.15, kp: 0.26, kr: 0.36, windage: 2.6, seats: 5 },
  fishing_boat: { label: "Fishing boat", L: 8.3, B: 2.9, D: 1.45, mass: 4300, zcg: 1.05, lcg: -0.45, plan: "transom", section: "vee", deadrise: 14, deadriseBow: 38,
    rocker: 0, forefoot: 0.45, sheer: 0.35, transom: 0.8, drive: "inboard", power: 200e3, eta: 0.52, bollard: 13000, steerMax: 35, rudderArea: 0.2,
    planing: true, wave: 0.17, kp: 0.27, kr: 0.38, windage: 7.5, seats: 4 },
  dinghy: { label: "Sailing dinghy", L: 4.2, B: 1.39, D: 0.42, mass: 140, zcg: 0.42, lcg: -0.25, plan: "transom", section: "round", bilge: 6, deadrise: 8, deadriseBow: 30,
    rocker: 0.08, forefoot: 0.25, sheer: 0.08, transom: 0.72, drive: "sail", sails: [{ id: "main", area: 7.06, ce: [-0.05, 2.6], tack: 0.65, boomLen: 2.75, mastH: 6.4 }],
    foil: { area: 0.31, AR: 4.2, depth: 0.85, x: 0.3 }, rudderArea: 0.12, crewMass: 80, hike: 1.05, rigI: 110, heelEase: 7, wave: 0.07, kp: 0.27, kr: 0.34, windage: 0.6, seats: 2, planing: true },
  yacht: { label: "Sailing yacht", L: 9.8, B: 3.3, D: 1.35, mass: 4600, zcg: 0.35, lcg: -0.2, plan: "transom", section: "round", bilge: 2.5, deadrise: 10, deadriseBow: 34,
    rocker: 0.22, forefoot: 0.3, sheer: 0.35, transom: 0.7, drive: "sail", ballast: { mass: 1650, z: -1.15 },
    sails: [{ id: "main", area: 26, ce: [-1.5, 5.6], tack: 0.9, boomLen: 4.1, mastH: 14.2 }, { id: "jib", area: 21, ce: [1.0, 4.6], tack: 4.05, foot: 3.5, mastH: 12.6 }],
    foil: { area: 1.35, AR: 2.6, depth: 1.75, x: -0.35 }, rudderArea: 0.42, engine: 15e3, rigI: 7000, wave: 0.09, kp: 0.27, kr: 0.36, windage: 4.5, seats: 6 },
  canoe: { label: "Canoe", L: 4.88, B: 0.9, D: 0.36, mass: 195, zcg: 0.36, lcg: 0, plan: "double", section: "round", bilge: 3.5, deadrise: 4, deadriseBow: 14,
    rocker: 0.05, sheer: 0.2, drive: "paddle", style: "canoe", spm: 42, blade: 0.12, stroke: 2.9, drivePhase: 0.46,
    paddlers: [{ x: 1.45, side: -1 }, { x: -1.55, side: 1, stern: true }], wave: 0.012, kp: 0.26, kr: 0.33, windage: 0.5, seats: 2 },
  kayak: { label: "Kayak", L: 5.2, B: 0.6, D: 0.33, mass: 110, zcg: 0.24, lcg: 0, plan: "double", section: "round", bilge: 3.5, deadrise: 6, deadriseBow: 20,
    rocker: 0.06, sheer: 0.08, drive: "paddle", style: "kayak", spm: 66, blade: 0.095, stroke: 3.3, drivePhase: 0.5,
    paddlers: [{ x: -0.15, side: 0 }], wave: 0.01, kp: 0.25, kr: 0.3, windage: 0.3, seats: 1 },
  rowboat: { label: "Rowboat", L: 3.7, B: 1.42, D: 0.5, mass: 260, zcg: 0.42, lcg: -0.05, plan: "transom", section: "round", bilge: 3.5, deadrise: 10, deadriseBow: 30,
    rocker: 0.08, forefoot: 0.3, sheer: 0.16, transom: 0.66, drive: "oars", style: "row", spm: 24, blade: 0.08, stroke: 2.4, drivePhase: 0.38, oarRatio: 2.3,
    paddlers: [{ x: 0.1, side: 0, facing: -1 }], wave: 0.02, kp: 0.27, kr: 0.35, windage: 0.6, seats: 3 },
  raft: { label: "Whitewater raft", L: 4.3, B: 2.0, D: 0.5, mass: 640, zcg: 0.38, lcg: 0, plan: "raft", section: "tube", tubeR: 0.255,
    rocker: 0.16, sheer: 0.12, drive: "raft", style: "raft", spm: 50, blade: 0.11, stroke: 2.7, drivePhase: 0.45,
    paddlers: [{ x: 1.1, side: 1 }, { x: 1.1, side: -1 }, { x: 0.2, side: 1 }, { x: 0.2, side: -1 }, { x: -0.7, side: 1 }, { x: -1.55, side: 0, guide: true }],
    wave: 0.02, kp: 0.28, kr: 0.3, windage: 1.2, seats: 6 },
  log_raft: { label: "Log raft", L: 3.6, B: 2.5, D: 0.34, mass: 560, zcg: 0.3, lcg: 0, plan: "logs", section: "logs", logs: 8, logR: 0.155,
    rocker: 0, sheer: 0, drive: "pole", style: "pole", spm: 14, blade: 0.05, stroke: 1.6, drivePhase: 0.55,
    paddlers: [{ x: -1.2, side: -1, stand: true }], wave: 0.04, kp: 0.3, kr: 0.38, windage: 0.5, seats: 2 },
};
// The older library kinds ride the nearest hull (old scenes keep working and get real physics).
const ALIAS = { boat: "speedboat", jetski: "speedboat", sailboat: "yacht", catamaran: "yacht" };
export const hullOf = (kind) => HULLS[kind] || HULLS[ALIAS[kind]] || null;
export const isBoatKind = (kind) => !!hullOf(kind);
export const WATERCRAFT = Object.keys(HULLS);

/** Scaled hull: a library object made bigger or smaller keeps its proportions and scales its mass by k³. */
export function hullFor(kind, k = 1) {
  const H = hullOf(kind);
  if (!H) return null;
  if (k === 1) return H;
  const s = (v) => v * k;
  return { ...H, L: s(H.L), B: s(H.B), D: s(H.D), zcg: s(H.zcg), lcg: s(H.lcg), rocker: s(H.rocker || 0), sheer: s(H.sheer || 0), mass: H.mass * k ** 3,
    power: H.power ? H.power * k ** 3.5 : H.power, bollard: H.bollard ? H.bollard * k ** 3 : H.bollard };
}

// ------------------------------------------------------------------ hull geometry (shared with the clay mesh)

/** Half-breadth at the sheer, keel height and sheer height at u (0 = stern, 1 = bow). */
export function station(H, u) {
  const Bh = H.B / 2, D = H.D;
  let b;
  if (H.plan === "double") b = Bh * Math.pow(Math.max(0, Math.sin(Math.PI * clamp(u, 0, 1))), H.style === "kayak" ? 0.95 : 0.7);
  else if (H.plan === "raft") { const e = Math.abs(u - 0.5) - 0.33; b = e <= 0 ? Bh : Bh * Math.sqrt(Math.max(0, 1 - (e / 0.17) ** 2)) * 0.7 + (e < 0.17 ? Bh * 0.3 : 0); }
  else if (H.plan === "logs") b = Bh;
  else {
    const tr = H.transom ?? 0.8;
    const aft = tr + (1 - tr) * Math.sin((Math.PI / 2) * Math.min(1, u / 0.42));
    const fwd = u <= 0.52 ? 1 : Math.pow(Math.max(0, 1 - ((u - 0.52) / 0.48) ** 2), 0.62);
    b = Bh * Math.min(aft, fwd);
  }
  let zk = 0;
  if (H.plan === "double" || H.plan === "raft") zk = (H.rocker || 0) * (2 * u - 1) ** 2;
  else if (H.plan !== "logs") zk = u > 0.55 ? D * (H.forefoot ?? 0.4) * Math.pow((u - 0.55) / 0.45, 2.2) + (H.rocker || 0) * 0.3 * ((u - 0.55) / 0.45) ** 2 : (H.rocker || 0) * 0.25 * ((0.55 - u) / 0.55) ** 2;
  const zs = H.plan === "double" ? D + (H.sheer || 0) * (2 * u - 1) ** 4 : D + (H.sheer || 0) * u * u;
  const beta = ((H.deadrise ?? 10) + ((H.deadriseBow ?? 30) - (H.deadrise ?? 10)) * sstep(0.45, 1, u)) * D2R;
  return { b, zk, zs, beta };
}

/** Bottom height above the keel datum at lateral offset y (|y| <= b) of a station. */
export function bottomAt(H, st, y) {
  const a = Math.min(1, Math.abs(y) / Math.max(1e-3, st.b));
  if (H.section === "vee") { const chine = 0.86; return st.zk + Math.min(a, chine) * st.b * Math.tan(st.beta) + (a > chine ? (a - chine) / (1 - chine) * 0.18 * H.D : 0); }
  // Round bilge: a flat-ish bottom turning up into the topsides; `bilge` sets how hard the turn is (a Laser's hard
  // bilge ~6, a canoe's or kayak's ~3.5, a deep yacht body 2.5).
  if (H.section === "round") return st.zk + Math.min(a, 0.93) * st.b * Math.tan(st.beta) + 0.55 * H.D * (1 - Math.sqrt(Math.max(0, 1 - a ** (H.bilge || 2.2))));
  if (H.section === "tube") { const R = H.tubeR || 0.25, yy = Math.abs(y) - (st.b - R); return st.zk + (yy > 0 ? R - Math.sqrt(Math.max(0, R * R - yy * yy)) : 0.06); }
  if (H.section === "logs") { const r = H.logR || 0.15, n = H.logs || 8, w = H.B / n, c = ((y + H.B / 2) % w) - w / 2; return r - Math.sqrt(Math.max(0, r * r - c * c)) * 0.98; }
  return st.zk + a * 0.05;
}

/** The hull's sample points: [{x, y, z0 (bottom), top (sheer), A (m²), transom (0..1 share of aft)}]. */
export function hullPoints(H, nx = 15, ny = 7) {
  const pts = [];
  const dx = H.L / nx;
  for (let i = 0; i < nx; i++) {
    const u = (i + 0.5) / nx, x = (u - 0.5) * H.L, st = station(H, u);
    if (st.b < 0.02) continue;
    const dy = (2 * st.b * 0.96) / ny;
    for (let j = 0; j < ny; j++) {
      const y = -st.b * 0.96 + (j + 0.5) * dy;
      const z0 = bottomAt(H, st, y);
      pts.push({ x, y, z0, top: Math.max(z0 + 0.05, st.zs), A: dx * dy, u, keel: j === (ny >> 1) });
    }
  }
  return pts;
}

// ------------------------------------------------------------------ hydrostatics

/** Weight, buoyancy and their centres at rest: the draft (keel depth) where the hull floats level in still water. */
export function restDraft(H, rho = RHO_FRESH) {
  const pts = hullPoints(H);
  const W = H.mass;
  const disp = (T) => pts.reduce((m, p) => m + rho * p.A * clamp(T - p.z0, 0, p.top - p.z0), 0);
  let lo = 0, hi = H.D * 1.5;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (disp(m) > W) hi = m; else lo = m; }
  const T = (lo + hi) / 2;
  let vol = 0, xb = 0;
  for (const p of pts) { const d = clamp(T - p.z0, 0, p.top - p.z0); vol += p.A * d; xb += p.A * d * p.x; }
  return { T, lcb: vol ? xb / vol : 0, vol, freeboard: H.D - T };
}

/** Skin friction coefficient (ITTC-57) plus a roughness allowance. */
export const ittc = (V, L) => 0.075 / (Math.log10(Math.max(1e5, (Math.abs(V) * L) / NU)) - 2) ** 2 + 0.0004;

// ------------------------------------------------------------------ sail aerodynamics

/** Soft-sail lift and drag at an angle of attack α (rad). Stall past ~22°, luffing (no lift) under ~6°. */
export function sailCoef(alpha) {
  const a = Math.abs(alpha) / D2R;
  let cl;
  if (a < 6) cl = 1.45 * (a / 22) * sstep(2, 6, a);           // luffing: the sail flaps, little lift
  else if (a <= 22) cl = 1.45 * Math.sin((Math.PI / 2) * (a / 22));
  else cl = Math.max(0, 1.45 - 1.45 * ((a - 22) / 68) ** 1.2);
  const cd = 0.04 + 0.075 * cl * cl + 1.2 * Math.sin(Math.min(Math.PI / 2, a * D2R)) ** 2 * sstep(18, 60, a);
  return { cl: cl * Math.sign(alpha || 1), cd, luff: 1 - sstep(3, 8, a) };
}

// ------------------------------------------------------------------ paddle strokes

/** A stroke's blade speed aft relative to the boat (m/s) at phase u of the cycle (drive share d), and in-water flag. */
export function strokeSpeed(u, d, peak) {
  const v = ((u % 1) + 1) % 1;
  if (v >= d) return { s: 0, wet: false };
  return { s: peak * Math.sin((Math.PI * v) / d) ** 0.8, wet: true };
}

/** Phase of each paddler: kayak strokes alternate sides each half cycle; the rest pull together (the bow paddler sets the
 *  pace, the stern follows half a beat later on a canoe). Returns [{seat, u, side}]. */
export function paddlePhases(H, cyc) {
  const out = [];
  (H.paddlers || []).forEach((p, i) => {
    let u = cyc, side = p.side;
    if (H.style === "kayak") { const half = (cyc * 2) % 2; side = half < 1 ? -1 : 1; u = half % 1; }
    else if (H.style === "canoe" && p.stern) u = cyc - 0.04;
    else if (p.guide) u = cyc - 0.1;
    out.push({ seat: i, u: ((u % 1) + 1) % 1, side, x: p.x });
  });
  return out;
}

// ------------------------------------------------------------------ the body

const PADDLE_FMAX = 320;   // N, one person's peak blade force at full effort
const isSail = (H) => H.drive === "sail";
const isPaddle = (H) => ["paddle", "oars", "raft", "pole"].includes(H.drive);

/**
 * A boat: state + one physics step. opts: {waves (a waves.mjs field), rho, wind ([vx, vz] m/s, toward), kind}.
 * State: x, z, h (heading), u, v (body forward / left speed through the water), r (yaw rate), y (keel height),
 * vy, pitch, q (pitch rate), roll, p (roll rate), all SI and radians.
 */
export class Boat {
  constructor(kind, { x = 0, z = 0, heading = 0, speed = 0, waves = null, rho = null, scale = 1, level = 0, wind = null, t0 = 0 } = {}) {
    this.kind = kind;
    this.H = hullFor(kind, scale);
    if (!this.H) throw new Error(`not a boat: ${kind}`);
    const H = this.H;
    this.waves = waves;
    this.rho = rho ?? (waves && !waves.standing && waves.id !== "calm_lake" && waves.id !== "glassy" ? RHO_SEA : RHO_FRESH);
    this.level = level;
    this.pts = hullPoints(H);
    const rest = restDraft(H, this.rho);
    this.rest = rest;
    // Designers trim a boat to float level loaded: the CG sits over the centre of buoyancy (plus any trim bias).
    this.lcg = rest.lcb + (H.trimBias || 0);
    this.ycg = 0;
    this.t = t0;
    // Inertias: radii of gyration (k_pitch ≈ 0.26 L, k_roll ≈ 0.35 B) and the added mass of the water that moves with it.
    this.m = H.mass;
    this.Iyy = this.m * (H.kp * H.L) ** 2;
    // Roll: the hull's own radius of gyration, plus a rig's mast and sail aloft and a hiking sailor out at the rail.
    this.Ixx = this.m * (H.kr * H.B) ** 2 + (H.rigI || 0) + (H.crewMass ? H.crewMass * H.hike ** 2 : 0);
    this.Izz = this.m * (0.27 * H.L) ** 2;
    this.mz = this.m * 1.6; this.Ip = this.Iyy * 1.7; this.Ir = this.Ixx * 1.25;    // + added mass / inertia
    this.mx = this.m * 1.05; this.my = this.m * 1.8; this.Iz = this.Izz * 1.5;
    // Static stiffnesses (for the damping to critical): ρ g Awp, ρ g IL, ρ g IT.
    let Awp = 0, IL = 0, IT = 0;
    for (const p of this.pts) if (p.z0 < rest.T) { Awp += p.A; IL += p.A * (p.x - rest.lcb) ** 2; IT += p.A * p.y * p.y; }
    this.k = { heave: this.rho * G * Awp, pitch: this.rho * G * IL, roll: Math.max(this.rho * G * IT - this.m * G * Math.max(0, H.zcg - rest.T * 0.5), this.rho * G * IT * 0.25) };
    this.c = {
      heave: 2 * 0.22 * Math.sqrt(this.k.heave * this.mz),
      pitch: 2 * 0.25 * Math.sqrt(this.k.pitch * this.Ip),
      roll: 2 * (H.drive === "raft" || H.plan === "logs" ? 0.2 : H.foil ? 0.16 : H.section === "vee" ? 0.17 : 0.1) * Math.sqrt(this.k.roll * this.Ir),   // chines damp roll like bilge keels
    };
    this.x = x; this.z = z; this.h = heading; this.u = speed; this.v = 0; this.r = 0;
    this.y = level - rest.T; this.vy = 0; this.pitch = 0; this.q = 0; this.roll = 0; this.p = 0;
    this.wind = wind || (waves ? [waves.windDir[0] * waves.wind, waves.windDir[1] * waves.wind] : [0, 0]);
    this.ctl = { throttle: 0, steer: 0, trim: 0, sheet: null, effort: 0, cadence: null, hike: null, reverse: false };
    this.cyc = 0;                 // stroke cycle (paddles)
    this.boom = {};
    this.crewY = 0;               // the crew's hike out (+ = to the left)
    this.out = {};
    this.settle();
  }

  /** Find the waterline at the current spot (heave only), so a boat placed on the water starts floating, not dropped. */
  settle() {
    const t = this.t;
    let lo = this.level - this.H.D * 2, hi = this.level + this.H.D;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      this.y = m;
      const f = this._hydro(t, true).Fz - this.m * G;
      if (f > 0) lo = m; else hi = m;
    }
    this.y = (lo + hi) / 2;
    this.vy = 0;
  }

  /** World position of a body point (bx forward, by left, bz up from the keel): small-angle pitch and roll. */
  _world(bx, by, bz) {
    const sh = Math.sin(this.h), ch = Math.cos(this.h);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    // pitch about the lateral axis (bow up), then roll about the fore-aft axis (+ = right side down).
    const fx = bx * cp - bz * sp, fz0 = bx * sp + bz * cp;
    const ly = by * cr - fz0 * sr * 0 + bz * 0, up = fz0 * cr + by * sr;
    const side = by * cr - fz0 * sr;
    void ly;
    return [this.x + fx * sh + side * ch, this.y + up, this.z + fx * ch - side * sh];
  }

  /** Hydrostatics + planing over the hull points: {Fz, My (pitch, bow up +), Mx (roll, right down +), wet, lambda...}. */
  _hydro(t, still = false) {
    const H = this.H, rho = this.rho, F = this.waves;
    const V = Math.max(0, this.u), Fn = V / Math.sqrt(G * H.L);
    // The transom ventilates past Fn ≈ 0.35: the aft ~15 % of the bottom loses its hydrostatic pressure.
    const vent = H.plan === "transom" ? sstep(0.32, 0.62, Fn) : 0;
    let Fz = 0, My = 0, Mx = 0, wetA = 0, imm = 0;
    const sh = Math.sin(this.h), ch = Math.cos(this.h);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    // The hull's own waves (Kelvin's transverse system, wavelength 2πV²/g): a crest at the bow and the troughs behind.
    // Past hull speed (Fn ≈ 0.4) the stern sits in the first trough and squats, so the bow climbs: the hump. The
    // amplitude grows with the hull's fullness and fades once it planes over its own bow wave (Fn > 1).
    const kw = V > 0.3 ? G / (V * V) : 0, Aself = still ? 0 : (H.wave || 0.05) * 1.6 * H.D * sstep(0.3, 0.48, Fn) * (1 - sstep(0.85, 1.5, Fn));
    // At planing speed the bottom's pressure is dynamic: Savitsky's hydrostatic term is a small share of Archimedes'
    // (≈ 0.0055 λ^2.5 / Cv² against the wedge's full buoyancy), so the static support fades as Cv rises.
    const Cvh = V / Math.sqrt(G * H.B * 0.86);
    const kHyd = H.planing && !still ? 1 - 0.9 * sstep(0.9, 3.4, Cvh) : 1;
    const keel = [], chine = [];
    for (const p of this.pts) {
      const fx = p.x * cp - p.z0 * sp, fzb = p.x * sp + p.z0 * cp;
      const side = p.y * cr - fzb * sr;
      const zw = this.y + fzb * cr + p.y * sr;
      const wx = this.x + fx * sh + side * ch, wz = this.z + fx * ch - side * sh;
      let eta = this.level + (F ? heightAt(F, wx, wz, t) : 0);
      if (Aself) eta += Aself * Math.cos(kw * (H.L / 2 - p.x)) * (0.55 + 0.45 * (p.x + H.L / 2) / H.L);
      const raw = eta - zw;
      if (p.keel) keel.push([p.x, raw]);
      else if (Math.abs(p.y) > 0.62 * H.B / 2) chine.push([p.x, raw]);
      const col = p.top - p.z0;
      const d = clamp(raw, 0, col);
      if (d <= 0) continue;
      const aft = (p.x + H.L / 2) / H.L;
      const vk = still ? 1 : (1 - vent * (1 - sstep(0.0, 0.16, aft))) * kHyd;
      const f = rho * G * p.A * d * vk;
      Fz += f;
      // Moments about the CG: the column's buoyancy acts at the middle of its wet part, vertical in the world.
      const zr = p.z0 + d / 2 - H.zcg, xr = p.x - this.lcg, yr = p.y - this.ycg;
      My += f * (xr * cp - zr * sp);
      Mx += f * (yr * cr - zr * sr);
      wetA += p.A; imm += p.A * d;
    }
    // Wetted lengths from the transom: where the keel (and the chine) come out of the water, interpolated.
    const wetLen = (arr) => {
      arr.sort((a, b) => a[0] - b[0]);
      let last = null;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i][1] > 0) last = i;
      }
      if (last == null) return 0;
      const xa = -H.L / 2;
      if (last === arr.length - 1) return arr[last][0] - xa + H.L / 30;
      const [x0, d0] = arr[last], [x1, d1] = arr[last + 1];
      return x0 + (x1 - x0) * (d0 / Math.max(1e-6, d0 - d1)) - xa;
    };
    const Lk = wetLen(keel), Lc = wetLen(chine);
    return { Fz, My, Mx, wetA, imm, Lk, Lc, Fn, vent };
  }


  /** One step of dt seconds. */
  step(dt) {
    const H = this.H, rho = this.rho, ctl = this.ctl, F = this.waves;
    const t = this.t;
    const hy = this._hydro(t);
    const sh = Math.sin(this.h), ch = Math.cos(this.h);
    // Water velocity here (current + orbital) in the body frame: the hull moves through the water, not over the bed.
    const wv = F ? velocityAt(F, this.x, this.z, t) : [0, 0];
    const wu = wv[0] * sh + wv[1] * ch, wl = wv[0] * ch - wv[1] * sh;
    const ur = this.u - wu, vr = this.v - wl;
    const V = Math.hypot(ur, vr), Fn = Math.max(0, ur) / Math.sqrt(G * H.L);
    let X = 0, Y = 0, N = 0, Z = hy.Fz - this.m * G, MY = hy.My, MX = hy.Mx;
    const out = { Fn, vent: hy.vent };
    // --- planing lift (Savitsky) on the wetted bottom
    let Ldyn = 0, tau = 0, lam = 0;
    if (H.planing && ur > 0.5 && hy.Lk > 0.05) {
      const b = H.B * 0.86;
      lam = clamp((hy.Lk + Math.min(hy.Lc, hy.Lk)) / (2 * b), 0, 4.5);
      tau = clamp(this.pitch / D2R + 0.5, 0, 12);          // keel angle to the flow (deg): the trim plus a 0.5° run
      const Cv = ur / Math.sqrt(G * b);
      const CL0 = Math.pow(tau, 1.1) * 0.012 * Math.sqrt(lam);
      const beta = H.deadrise;
      const CLb = Math.max(0, CL0 - 0.0065 * beta * Math.pow(CL0, 0.6));
      Ldyn = 0.5 * rho * ur * ur * b * b * CLb * sstep(0.6, 1.6, Cv) * sstep(0.15, 0.4, lam);
      const lp = lam * b * (0.75 - 1 / (5.21 * Cv * Cv / (lam * lam) + 2.39));
      const xcp = -H.L / 2 + lp;
      Z += Ldyn * Math.cos(tau * D2R);
      MY += Ldyn * (xcp - this.lcg);
      X -= Ldyn * Math.sin(tau * D2R);                  // the lift leans back: trim drag
      // A deep-V banks into a turn: the inside chine digs in and the lift moves outboard.
      MX += -Ldyn * 0.12 * H.B * clamp(this.r * ur / G, -1, 1) * (H.section === "vee" ? 1 : 0.3);
      // Heeled, the low side's bottom meets the flow at a steeper angle and lifts harder (the dynamic roll stiffness
      // that keeps a planing hull upright once the static support has faded): the lift shifts ~0.6 b per radian.
      MX += -Ldyn * 0.6 * b * Math.sin(this.roll) * (1 + Math.tan(H.deadrise * D2R));
      out.Cv = Cv;
    }
    out.tau = tau; out.lambda = lam; out.Ldyn = Ldyn;
    // --- resistance: skin friction on the wetted area, the wave-making hump, air
    const Swet = hy.wetA * 1.25 + hy.imm * 2.2;
    const Rf = 0.5 * rho * ur * Math.abs(ur) * Swet * ittc(ur, H.L);
    const hump = (H.wave || 0.05) * this.m * G * (Fn / 0.42) ** 4 / (1 + (Fn / 0.46) ** 7) * (H.planing ? 1 - sstep(0.9, 1.6, Fn) * 0.85 : 1);
    X -= Rf + hump * Math.sign(ur);
    const aw = [this.wind[0] - (this.u * sh + this.v * ch), this.wind[1] - (this.u * ch - this.v * sh)];
    const awu = aw[0] * sh + aw[1] * ch, awl = aw[0] * ch - aw[1] * sh, Aw = Math.hypot(awu, awl);
    X += 0.5 * RHO_AIR * (H.windage || 1) * 0.6 * awu * Aw;
    Y += 0.5 * RHO_AIR * (H.windage || 1) * 0.9 * awl * Aw;
    // --- lateral: the hull (and keel) resists sideslip; its yaw damping
    const latA = H.L * Math.max(0.06, this.rest.T) * (H.plan === "raft" || H.plan === "logs" ? 2.2 : 1);
    Y -= 0.5 * rho * latA * 1.1 * vr * Math.abs(vr) + 0.5 * rho * latA * 0.9 * Math.max(0.3, Math.abs(ur)) * vr;
    N -= 0.5 * rho * latA * H.L * H.L * 0.045 * Math.max(0.4, Math.abs(ur)) * this.r + this.Izz * 0.4 * this.r * (H.plan === "raft" ? 1.5 : 0.3);
    // the Munk moment of a hull in sideslip (unstable: it wants to turn broadside) is what the keel / rudder balance.
    N += 0.5 * rho * latA * H.L * 0.08 * ur * vr;
    // --- propulsion
    if (H.drive === "outboard" || H.drive === "inboard" || (isSail(H) && H.engine && ctl.throttle > 0.01)) {
      const P = (H.power || H.engine) * clamp(ctl.throttle, 0, 1);
      const Tmax = (H.bollard || P / 2.5) * clamp(ctl.throttle, 0, 1);
      let T = Math.min(Tmax, (P * (H.eta || 0.5)) / Math.max(1.5, Math.abs(ur)));
      if (ctl.reverse) T = -0.45 * Tmax;
      const d = clamp(ctl.steer, -1, 1) * (H.steerMax || 30) * D2R;
      const trimRad = (ctl.trim || 0) * D2R;
      const xs = -H.L / 2, zs = -0.25;
      if (H.drive === "outboard") {
        X += T * Math.cos(d) * Math.cos(trimRad); Y -= T * Math.sin(d); N += xs * -T * Math.sin(d);
        // The gearcase and skeg are a foil in the flow: at speed their lift, not the thrust vector, is what turns an
        // outboard boat (∝ V², stalls past ~17° of effective angle; ~0.05 m² of gearcase and skeg on a 150-250 hp lower unit).
        const Ag = H.gearcase ?? 0.05, ag = clamp(d - Math.atan2(vr - this.r * xs, Math.max(0.5, ur)), -0.3, 0.3);
        const Fg = 0.5 * rho * ur * Math.abs(ur) * Ag * 3.2 * ag;
        Y -= Fg; N += xs * -Fg;
        // The thrust line under the CG, tilted by the motor trim. Trimmed out (+) the lower unit swings aft, the prop
        // shaft points forward-down and its thrust pulls the transom down: the bow rises. Trimmed in (-) it lifts the
        // transom: the bow goes down (the hole shot).
        Z -= T * Math.sin(trimRad);
        MY += -T * Math.cos(trimRad) * (zs - H.zcg) * 0.35 - T * Math.sin(trimRad) * (xs - this.lcg);
      } else {
        X += T; MY += -T * (zs - H.zcg) * 0.25;
      }
      out.thrust = T;
      // An inboard (and the yacht's) rudder: lift from the flow over it (plus the prop wash).
      if (H.drive !== "outboard") {
        const Ar = H.rudderArea || 0.25, uw = Math.max(Math.abs(ur), Math.sqrt(Math.abs(T) / (rho * 0.6)) * 0.8);
        // Lift slope ~3.5 / rad, stalling near 17° (C_L ≈ 1.05): a hard-over rudder doesn't keep pulling.
        const Fr = 0.5 * rho * uw * uw * Ar * 2 * Math.PI * 0.55 * clamp(d - Math.atan2(vr - this.r * xs, Math.max(0.5, ur)), -0.3, 0.3);
        Y -= Fr; N += xs * -Fr;
      }
    }
    if (isSail(H)) this._sail(aw, awu, awl, ur, vr, dt, out, (fx, fy, fz, mz, my, mx) => { X += fx; Y += fy; Z += fz; N += mz; MY += my; MX += mx; });
    if (isPaddle(H)) this._paddles(ur, vr, dt, out, (fx, fy, mz) => { X += fx; Y += fy; N += mz; });
    // --- integrate (semi-implicit Euler): planar in the body frame, then heave, pitch and roll
    const du = (X / this.mx) + this.v * this.r, dv = (Y / this.my) - this.u * this.r;
    this.u += du * dt; this.v += dv * dt; this.r += (N / this.Iz) * dt;
    this.h = wrap(this.h + this.r * dt);
    const s2 = Math.sin(this.h), c2 = Math.cos(this.h);
    this.x += (this.u * s2 + this.v * c2) * dt; this.z += (this.u * c2 - this.v * s2) * dt;
    // Hydrodynamic damping grows with speed (a planing bottom's heave and pitch damping ∝ ρ V b²).
    const cdyn = H.planing ? rho * Math.max(0, ur) * (H.B * 0.86) ** 2 * 0.9 * sstep(0.3, 1, Fn) : 0;
    const wlen = Math.max(0.5, (hy.Lk || H.L * 0.6));
    this.vy += ((Z - (this.c.heave + cdyn) * this.vy) / this.mz) * dt; this.y += this.vy * dt;
    this.q += ((MY - (this.c.pitch + cdyn * wlen * wlen * 0.12) * this.q) / this.Ip) * dt; this.pitch = clamp(this.pitch + this.q * dt, -0.6, 0.6);
    this.p += ((MX - this.c.roll * this.p) / this.Ir) * dt; this.roll = clamp(this.roll + this.p * dt, -1.2, 1.2);
    this.t += dt;
    out.ur = ur; out.wetA = hy.wetA;
    this.out = out;
  }

  /** Sails: apparent wind → lift and drag per sail; the keel as a foil; the crew hikes out (a dinghy). */
  _sail(aw, awu, awl, ur, vr, dt, out, add) {
    const H = this.H, ctl = this.ctl, rho = this.rho;
    const Aw = Math.hypot(awu, awl) || 1e-6;
    // Apparent wind angle from the bow (where it comes from): 0 = head to wind, ±180 = dead downwind, + = from the left.
    const awa = Math.atan2(-awl, -awu);
    const from = Math.abs(awa);
    // Leeward (-1 = the right side). Running dead downwind the boom stays where it is until the wind is clearly on
    // the other quarter (15° by the lee): then it gybes.
    let lee = awa >= 0 ? -1 : 1;
    const bm = this.boom.main;
    if (from > 165 * D2R && Math.abs(bm || 0) > 2 * D2R && Math.sign(bm) !== lee) lee = Math.sign(bm);
    this.lee = lee;
    const d = [awu / Aw, awl / Aw];                // the air's direction of travel (body frame)
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    let fx = 0, fy = 0, nz = 0, mx = 0, my = 0;
    out.sails = {};
    for (const s of H.sails) {
      // The sheet: auto trims to ~16° angle of attack (as far as the sheet lets it out); a keyed sheet (0 = hard in,
      // 1 = fully eased) sets how far the boom may open, and the wind pushes it there.
      const maxOpen = (s.id === "jib" ? 32 : 85) * D2R, minOpen = (s.id === "jib" ? 7 : 3) * D2R;
      const limit = ctl.sheet == null ? maxOpen : minOpen + clamp(ctl.sheet, 0, 1) * (maxOpen - minOpen);
      // Auto trim also spills wind when it heels past 12° (a sailor eases the sheet in a gust rather than capsize).
      // A Laser sailor depowers (sheet, vang, cunningham) to sail flat: past ~7°; a keelboat is built to heel to ~20°.
      const heelX = Math.max(0, Math.abs(this.roll) / D2R - (H.heelEase ?? 12));
      const aoa = (16 - Math.min(12, heelX * 0.9)) * D2R;
      const open = clamp(ctl.sheet == null ? from - aoa : Math.min(limit, Math.max(0, from - 1 * D2R)), minOpen, limit);
      const target = lee * open;
      // The boom swings across with the wind (rate-limited: a tack carries it over in about a second, a gybe slams).
      const cur = this.boom[s.id] ?? target;
      const rate = (s.id === "jib" ? 2.6 : from > 150 * D2R ? 3.5 : 1.4) * dt;
      this.boom[s.id] = cur + clamp(target - cur, -rate, rate);
      const boom = this.boom[s.id];
      // The sail's chord runs from the mast aft along the boom; the flow meets it at the angle of attack α. Lift is
      // perpendicular to the flow, toward the sail's leeward (convex) face; drag along the flow. Eased out on a broad
      // reach that face looks forward, so the sail still drives; a backed sail (wind on its wrong face) pushes astern.
      const c = [-Math.cos(boom), Math.sin(boom)];
      const dot = c[0] * d[0] + c[1] * d[1], crs = c[0] * d[1] - c[1] * d[0];
      const alpha = Math.min(Math.PI / 2, Math.atan2(Math.abs(crs), Math.max(1e-6, Math.abs(dot))));
      let n = [-c[1], c[0]];
      if (n[0] * d[0] + n[1] * d[1] < 0) n = [c[1], -c[0]];
      let pl = [-d[1], d[0]];
      if (pl[0] * n[0] + pl[1] * n[1] < 0) pl = [d[1], -d[0]];
      const backed = Math.sign(n[1]) !== lee && Math.abs(boom) > 4 * D2R && from < 150 * D2R;
      const co = sailCoef(alpha);
      // A heeled sail only sees the wind across its mast: force ∝ cos² of the heel.
      const q = 0.5 * RHO_AIR * Aw * Aw * cr * cr * s.area;
      const L = q * Math.abs(co.cl), Dd = q * co.cd;
      const Fu = L * pl[0] + Dd * d[0], Fl = L * pl[1] + Dd * d[1];
      fx += Fu; fy += Fl;
      // Where it acts: the centre of effort, s.ce = [ahead of midship, above the deck].
      const zce = this.H.D + s.ce[1] - H.zcg, xce = s.ce[0];
      mx += -Fl * zce * cr;                                   // side force aloft heels the boat
      // Aerodynamic roll damping: rolling, the rig swings the sail sideways through the air (p·z at the CE), which
      // changes its angle of attack against the motion. On a dinghy it is the largest roll damper there is.
      mx += -0.5 * RHO_AIR * Aw * s.area * 3 * zce * zce * this.p * cr * cr;
      my += -Fu * zce * 0.15;                                  // the drive aloft pushes the bow down a little
      nz += Fl * (xce - this.lcg) + Fu * zce * sr;             // CE ahead / astern of the CG, and heeled: weather helm
      out.sails[s.id] = { boom: boom / D2R, alpha: alpha / D2R, luff: co.luff, cl: co.cl, force: Math.hypot(Fu, Fl), backed };
    }
    // The keel / centreboard: a foil lifting against leeway (lift slope 2πAR/(AR+2) per rad, stalls past 12°), at
    // half its depth below the hull; that couple against the sail's side force is the heeling arm.
    const leeway = Math.atan2(vr, Math.max(0.3, Math.abs(ur)));
    const f = H.foil, aSlope = (2 * Math.PI * f.AR) / (f.AR + 2);
    const Vk2 = ur * ur + vr * vr;
    const Fk = -0.5 * rho * Vk2 * f.area * aSlope * clamp(leeway, -12 * D2R, 12 * D2R) * cr;
    const zk = -(f.depth * 0.5) - H.zcg;
    fy += Fk; mx += -Fk * zk * cr;
    // The rudder at the stern.
    const xs = -H.L / 2 + 0.15, dr = clamp(ctl.steer, -1, 1) * 30 * D2R;
    const Fr = 0.5 * rho * Vk2 * (H.rudderArea || 0.2) * 2 * Math.PI * 0.6 * clamp(dr - Math.atan2(vr - this.r * xs, Math.max(0.3, ur)), -0.4, 0.4);
    fy -= Fr; nz += xs * -Fr;
    nz += Fk * ((f.x ?? 0) - this.lcg);                        // the keel's lift at the CLR: CE vs CLR sets the helm
    // The crew hikes out to windward to hold the boat flat (a dinghy): auto, or keyed 0..1.
    if (H.crewMass) {
      const wind = awa >= 0 ? 1 : -1;
      // Auto: sit out on the windward side as far as the sail's heeling moment needs, plus a correction on the heel
      // (so through a tack the crew crosses with the boom instead of waiting to be tipped over).
      const need = clamp((this._heelM || 0) / (H.crewMass * G * H.hike), 0, 1) * sstep(12, 30, Math.abs(awa) / D2R);
      const wantY = ctl.hike != null ? clamp(ctl.hike, 0, 1) * H.hike * wind
        : clamp(wind * need + clamp((this.roll + 0.5 * this.p) / (6 * D2R), -0.9, 0.9), -1, 1) * H.hike;
      // A sailor crosses the boat in well under a second in a tack.
      this.crewY += clamp(wantY - this.crewY, -2.2 * dt, 2.2 * dt);
      this.ycg = (this.crewY * H.crewMass) / this.m;
    }
    this._heelM = Math.abs(mx);
    add(fx, fy, 0, nz, my, mx);
    out.leeway = leeway / D2R; out.awa = awa / D2R; out.aws = Aw; out.heel = this.roll / D2R; out.crewY = this.crewY;
  }

  /** Paddles and oars: thrust during each drive phase; a single blade yaws the boat; the stern paddler corrects. */
  _paddles(ur, vr, dt, out, add) {
    const H = this.H, ctl = this.ctl, rho = this.rho;
    const eff = clamp(ctl.effort, 0, 1.4);
    const spm = (ctl.cadence || H.spm) * (eff > 0 ? 0.7 + 0.3 * Math.min(1, eff) : 0);
    if (eff > 0.01) this.cyc += (spm / 60) * dt;
    const ph = paddlePhases(H, this.cyc);
    let fx = 0, fy = 0, mz = 0;
    const strokes = [];
    const steer = clamp(ctl.steer, -1, 1);
    const reach = H.style === "row" ? H.B * 0.5 * (H.oarRatio || 2.3) : H.B * 0.5 + 0.2;
    for (const s of ph) {
      const p = H.paddlers[s.seat];
      const pk = H.stroke * (0.55 + 0.45 * Math.min(1, eff)) * (eff > 0.01 ? 1 : 0);
      const { s: bs, wet } = strokeSpeed(s.u, H.drivePhase, pk);
      let f = 0;
      // A stroke on the side you're turning toward is eased, the other side pulls harder (sweep strokes). side +1 is
      // the boat's left (a forward stroke there pushes the bow right), steer + is a turn to the left. A raft crew
      // turns hard by back-paddling the inside ("left back, right forward"): the gain goes negative.
      let sideGain = 1;
      if (s.side !== 0 && H.style === "raft") sideGain = clamp(1 - 1.6 * steer * s.side, -0.7, 1.6);
      else if (s.side !== 0 && H.style !== "canoe") sideGain = clamp(1 - 0.9 * steer * s.side, 0.1, 1.9);
      if (wet && bs > ur) f = 0.5 * rho * 1.9 * H.blade * (bs - ur) ** 2 * sideGain * Math.min(1.2, eff + 0.2);
      // A person, not a winch: a strong paddler's peak blade force is ~300-350 N (sprint kayakers reach ~400 N), so
      // a hull drifting slower than the water (blade far faster than the flow) can't be yanked ahead.
      f = Math.min(f, PADDLE_FMAX * Math.min(1.2, eff + 0.2) * (H.style === "row" ? 1.6 : 1));
      if (H.style === "row") {
        // Two oars at once (both sides): no yaw from the pair, differential effort steers.
        // Turning left (steer +) the right oar pulls harder and the left one eases (or backs, hard over).
        const fl = f * (1 - 0.9 * steer), fr = f * (1 + 0.9 * steer);
        fx += (fl + fr) * (p.facing === -1 ? 1 : 1); mz += -(H.B * 0.5) * (fl - fr);
      } else if (H.style === "kayak") {
        // A sweep stroke: the blade swings wide from the bow to the stern, so its yaw arm is far longer than the hull's half beam.
        fx += f; mz += -s.side * (0.45 + 0.9 * Math.abs(steer)) * f;
      } else if (H.style === "pole") {
        fx += f * 1.8; mz += steer * f * 0.6;
      } else {
        fx += f; mz += -s.side * (H.B * 0.5 + 0.1) * f;
      }
      strokes.push({ seat: s.seat, u: s.u, side: s.side, force: f, wet, blade: bs });
    }
    // Corrective strokes: the canoe's stern paddler (a J-stroke), the raft guide's rudder and the kayak's sweeps hold
    // the heading the helm asks for (steer -1..1 is the turn wanted).
    const corr = H.paddlers.find((p) => p.stern || p.guide);
    if (corr) {
      const want = steer * 0.55 - this.r * 1.6;           // yaw-rate demand, rad/s
      const Fj = clamp(want, -1, 1) * (H.style === "raft" ? 120 : 45) * Math.min(1, eff + 0.3) * clamp(Math.abs(ur) + 0.4, 0, 1.6);
      fy += -Fj * 0.2; mz += Fj * Math.abs(corr.x);
    }
    add(fx, fy, mz);
    out.strokes = strokes; out.cycle = this.cyc;
  }

  /** A snapshot for the output track. */
  sample() {
    const o = this.out, F = this.waves, H = this.H;
    const sh = Math.sin(this.h), ch = Math.cos(this.h);
    return {
      t: this.t, x: this.x, z: this.z, h: this.h, y: this.y, pitch: this.pitch / D2R, roll: this.roll / D2R,
      u: this.u, v: this.v, r: this.r / D2R, speed: Math.hypot(this.u, this.v), vel: [this.u * sh + this.v * ch, this.u * ch - this.v * sh],
      Fn: o.Fn || 0, tau: o.tau || 0, lambda: o.lambda || 0, Cv: o.Cv || 0, thrust: o.thrust || 0, heel: this.roll / D2R,
      draft: this.level + (F ? heightAt(F, this.x, this.z, this.t) : 0) - this.y,
      sails: o.sails ? JSON.parse(JSON.stringify(o.sails)) : null, awa: o.awa, aws: o.aws, leeway: o.leeway, crewY: this.crewY,
      strokes: o.strokes ? o.strokes.map((s) => ({ ...s })) : null, cycle: o.cycle, ctl: { ...this.ctl },
      planing: H.planing ? sstep(1.2, 2.2, o.Cv || 0) : 0,
    };
  }
}

// ------------------------------------------------------------------ scripts (the presets) and the run

/**
 * Helm scripts. Each step's `set` moves the controls toward new targets over `ramp` seconds: throttle 0..1, steer -1..1
 * (+ = turn left) or "aim" (hold aim_deg of turn from the start heading), trim (deg, outboards), sheet (null = auto
 * trim, 0..1 = eased), effort 0..1.4 (paddlers), cadence (strokes / min), hike (0..1). Triggers as vehsim:
 * at (s), after (s after the step before), when {turned_deg, speed_above, speed_below}.
 */
export function boatScript(kind, p = {}) {
  if (kind === "speedboat_run") return { boat: "speedboat", start: { kmh: 0 }, steps: [
    { at: 0, set: { throttle: 0.05, steer: 0, trim: -3 } },
    // The hole shot: trimmed in, full throttle: the bow climbs, then it levels as it planes; trim out once up.
    { at: p.go_s ?? 0.5, set: { throttle: 1, ramp: 0.6 } },
    { when: { speed_above: p.trim_at_ms ?? 11 }, set: { trim: p.trim_deg ?? 3.5, ramp: 1.2 } },
    { at: p.turn_s ?? 6.5, set: { steer: "aim", aim_deg: p.turn_deg ?? 50, ramp: 0.5 } },
  ] };
  if (kind === "sailing_tack") return { boat: p.boat || "dinghy", start: { kmh: p.entry_kmh ?? 9 }, steps: [
    // Close-hauled on starboard, then through the wind onto port: the boom crosses, the crew moves across.
    { at: 0, set: { steer: "twa", twa: p.twa ?? 48, sheet: null } },
    { at: p.tack_s ?? 2.5, set: { steer: "twa", twa: -(p.twa ?? 48), aim_rate: p.turn_rate ?? 32, ramp: 0.3 } },
  ] };
  if (kind === "canoe_lake") return { boat: "canoe", start: { kmh: 2 }, steps: [
    { at: 0, set: { effort: p.effort ?? 0.6, steer: "aim", aim_deg: 0 } },
    { at: p.turn_s ?? 5, set: { steer: "aim", aim_deg: p.turn_deg ?? 15, ramp: 1 } },
  ] };
  if (kind === "whitewater_raft") return { boat: "raft", start: { kmh: 4, water: true }, steps: [
    { at: 0, set: { effort: 0.9, cadence: 54, steer: "aim", aim_deg: 0 } },
    { at: p.ferry_s ?? 2.4, set: { steer: "aim", aim_deg: p.ferry_deg ?? -25, ramp: 0.8 } },
    { at: (p.ferry_s ?? 2.4) + 2.2, set: { steer: "aim", aim_deg: 8, effort: 1.1, ramp: 0.8 } },
  ] };
  if (kind === "kayak_paddle") return { boat: "kayak", start: { kmh: 4 }, steps: [{ at: 0, set: { effort: 0.75, steer: "aim", aim_deg: 0 } }] };
  if (kind === "rowboat_row") return { boat: "rowboat", start: { kmh: 2 }, steps: [{ at: 0, set: { effort: 0.7, steer: "aim", aim_deg: 0 } }] };
  if (kind === "fishing_cruise") return { boat: "fishing_boat", start: { kmh: 12 }, steps: [{ at: 0, set: { throttle: 0.45, steer: 0 } }] };
  if (kind === "drift") return { boat: p.boat || "rowboat", start: { kmh: 0 }, steps: [{ at: 0, set: {} }] };
  return null;
}
export const BOAT_PRESETS = ["speedboat_run", "sailing_tack", "canoe_lake", "whitewater_raft"];

const NUM = ["throttle", "trim", "effort", "cadence", "hike"];

/**
 * Run a script. Returns {frames: [sample per output frame], boat, params}. opts: {waves, frames, fps, x, z, heading
 * (rad), level (still-water height), wind, kind (overrides the script's boat), scale, hz}.
 */
export function simulateBoat(script, opts = {}) {
  const frames = opts.frames ?? 121, fps = opts.fps ?? 24, hz = opts.hz ?? 240, dt = 1 / hz;
  const kind = opts.kind || script.boat;
  // start.water: the speed is through the water (a raft already riding the river), so the current along the heading adds.
  let u0 = (script.start?.kmh ?? 0) / 3.6;
  if (script.start?.water && opts.waves) {
    const hd = opts.heading ?? 0, c = velocityAt(opts.waves, opts.x ?? 0, opts.z ?? 0, 0);
    u0 += c[0] * Math.sin(hd) + c[1] * Math.cos(hd);
  }
  const b = new Boat(kind, { x: opts.x ?? 0, z: opts.z ?? 0, heading: opts.heading ?? 0, speed: u0, waves: opts.waves || null,
    level: opts.level ?? 0, wind: opts.wind || null, scale: opts.scale ?? 1 });
  const h0 = b.h;
  warmUp(b, script.steps?.[0]?.set || {});
  const cur = { throttle: 0, steer: 0, trim: 0, sheet: null, effort: 0, cadence: null, hike: null };
  const from = {}, to = {}, rampT = {}, rampS = {};
  let aim = null, aimRate = 60;
  let si = 0, lastFire = 0, turned = 0, prevH = b.h;
  const steps = script.steps || [];
  const out = [];
  const perFrame = Math.round(hz / fps);
  for (let f = 0; f < frames; f++) {
    out.push(b.sample());
    for (let k = 0; k < perFrame; k++) {
      const t = b.t;
      // fire steps
      while (si < steps.length) {
        const s = steps[si];
        let go = false;
        if (s.at != null) go = t >= s.at;
        else if (s.after != null) go = t >= lastFire + s.after;
        else if (s.when) go = (s.when.turned_deg != null && Math.abs(turned) / D2R >= s.when.turned_deg) || (s.when.speed_above != null && b.u > s.when.speed_above) || (s.when.speed_below != null && b.u < s.when.speed_below);
        if (!go) break;
        const ramp = s.set.ramp ?? 0.25;
        for (const [key, v] of Object.entries(s.set)) {
          if (key === "ramp" || key === "aim_deg" || key === "aim_rate" || key === "twa") continue;
          if (key === "steer" && v === "aim") { aim = h0 + (s.set.aim_deg ?? 0) * D2R; aimRate = s.set.aim_rate ?? 60; continue; }
          // Sail to a true wind angle (+ = wind over the starboard side, the starboard tack; - = port tack).
          if (key === "steer" && v === "twa") { aim = windFrom(b) + (s.set.twa ?? 45) * D2R; aimRate = s.set.aim_rate ?? 40; continue; }
          if (key === "steer") aim = null;
          if (key === "sheet") { cur.sheet = v; continue; }
          from[key] = cur[key] ?? 0; to[key] = v; rampT[key] = t; rampS[key] = Math.max(1e-3, ramp);
        }
        lastFire = t; si++;
      }
      for (const key of Object.keys(to)) {
        if (to[key] == null) { cur[key] = null; continue; }
        const u = clamp((t - rampT[key]) / rampS[key], 0, 1);
        cur[key] = (from[key] ?? 0) + (to[key] - (from[key] ?? 0)) * u;
      }
      if (aim != null) {
        // The helm: steer to the aimed heading, with a rate limit on how fast the target swings (a tack is a turn, not a snap).
        const tgt = aim;
        const err = wrap(tgt - b.h);
        const lim = aimRate * D2R;
        const rateWant = clamp(err * 1.4, -lim, lim);
        cur.steer = clamp((rateWant - b.r) * (isPaddle(b.H) ? 2.2 : 1.6) + err * 0.4, -1, 1);
      }
      Object.assign(b.ctl, cur);
      for (const n of NUM) if (cur[n] == null && n !== "cadence" && n !== "hike") b.ctl[n] = 0;
      b.step(dt);
      turned += wrap(b.h - prevH); prevH = b.h;
    }
  }
  return { frames: out, boat: kind, hull: b.H, rest: b.rest };
}

/** The heading the true wind comes from (stage convention). */
export const windFrom = (b) => Math.atan2(-b.wind[0], -b.wind[1]);

/** The heading that sails at a true wind angle twa (deg, + = starboard tack) in wind [wx, wz]. */
export const headingForTwa = (wind, twa) => wrap(Math.atan2(-wind[0], -wind[1]) + twa * D2R);

/**
 * Settle a boat into its first steady state before frame 0 (heave, pitch, heel, the boom, the crew's hike), holding
 * its place, heading and speed: a shot starts mid-voyage, not with the boat dropped onto the water.
 */
export function warmUp(b, set = {}, seconds = 3) {
  const keep = { x: b.x, z: b.z, h: b.h, u: b.u, t: b.t };
  for (const k of ["throttle", "trim", "effort", "cadence", "hike"]) if (Number.isFinite(set[k])) b.ctl[k] = set[k];
  if ("sheet" in set) b.ctl.sheet = set.sheet;
  const n = Math.round(seconds * 240);
  for (let i = 0; i < n; i++) { b.step(1 / 240); b.x = keep.x; b.z = keep.z; b.h = keep.h; b.u = keep.u; b.v = 0; b.r = 0; }
  b.t = keep.t; b.cyc = 0;
}

/** Bake a run into stage keys every `every` frames: position (keel height in y), heading, roll, pitch. */
export function boatKeys(run, { every = 2, origin = [0, 0, 0] } = {}) {
  const keys = [];
  const n = run.frames.length;
  let prev = null;
  for (let f = 0; f < n; f++) {
    const s = run.frames[f];
    let hd = s.h / D2R;
    if (prev != null) hd = prev + wrap((hd - prev) * D2R) / D2R;
    prev = hd;
    if (f % every && f !== n - 1) continue;
    keys.push({ frame: f, position: [+(s.x + origin[0]).toFixed(3), 0, +(s.z + origin[2]).toFixed(3)], heading_deg: +hd.toFixed(2) });
  }
  return keys;
}

/** Strokes of a run as compact spans per seat: [{seat, side, from, to}] (the drive phase, frame numbers). */
export function strokeSpans(run) {
  const spans = [];
  const open = new Map();
  run.frames.forEach((s, f) => {
    for (const st of s.strokes || []) {
      const k = st.seat;
      const o = open.get(k);
      if (st.wet && !o) open.set(k, { seat: k, side: st.side, from: f });
      if (!st.wet && o) { spans.push({ ...o, to: f }); open.delete(k); }
      if (st.wet && o && o.side !== st.side) { spans.push({ ...o, to: f }); open.set(k, { seat: k, side: st.side, from: f }); }
    }
  });
  for (const o of open.values()) spans.push({ ...o, to: run.frames.length });
  return spans.sort((a, b) => a.from - b.from || a.seat - b.seat);
}

// ------------------------------------------------------------------ playback: a keyed path floated on the waves

/**
 * Float a prescribed planar path: the stage's playback for any boat (keyed by hand, baked from a preset, recorded in
 * Drive). track: {x[], z[], h[] (rad), fps}; controls per frame (optional): {throttle[], trim[], sheet[], effort[]}.
 * The planar motion is given; heave, pitch and roll are integrated against the waves, the planing lift at the path's
 * speed, the sails' heel and the strokes, so the same path on a rougher sea pitches harder.
 * Returns per frame {y, pitch, roll, speed, Fn, Cv, planing, tau, sails, strokes, cycle, bowSpray, wake}.
 */
export function floatTrack(kind, track, opts = {}) {
  const fps = track.fps || 24, n = track.x.length, hz = opts.hz ?? 240, sub = Math.round(hz / fps), dt = 1 / (fps * sub);
  const b = new Boat(kind, { x: track.x[0], z: track.z[0], heading: track.h[0], waves: opts.waves || null, level: opts.level ?? 0, wind: opts.wind || null, scale: opts.scale ?? 1 });
  const H = b.H;
  const out = [];
  // Body-frame velocities from the path (central differences), smoothed a little.
  const vel = (i) => { const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1); if (a === c) return [0, 0, 0];
    const vx = (track.x[c] - track.x[a]) * fps / (c - a), vz = (track.z[c] - track.z[a]) * fps / (c - a), r = wrap(track.h[c] - track.h[a]) * fps / (c - a);
    return [vx, vz, r]; };
  // Speed → controls for a path that has none: the throttle (or the paddlers' effort) that holds it.
  const ctlAt = (i, u) => {
    const c = opts.controls || {};
    const pick = (k, d) => (Array.isArray(c[k]) ? c[k][Math.min(i, c[k].length - 1)] : c[k] ?? d);
    const vmax = H.drive === "outboard" ? 19 : H.drive === "inboard" ? 11 : 2.2;
    return { throttle: pick("throttle", clamp(u / vmax, 0, 1) ** 0.7), trim: pick("trim", u > 11 ? 3 : -2), sheet: pick("sheet", null),
      effort: pick("effort", clamp(u / 1.8, 0, 1.2) + (u > 0.25 ? 0.15 : 0)), steer: 0 };
  };
  let cycOverride = opts.strokes ? 0 : null;
  for (let i = 0; i < n; i++) {
    const [vx, vz, r] = vel(i);
    for (let k = 0; k < sub; k++) {
      const w = k / sub, j = Math.min(n - 1, i + 1);
      b.x = track.x[i] + (track.x[j] - track.x[i]) * w; b.z = track.z[i] + (track.z[j] - track.z[i]) * w;
      b.h = track.h[i] + wrap(track.h[j] - track.h[i]) * w;
      const sh = Math.sin(b.h), ch = Math.cos(b.h);
      b.u = vx * sh + vz * ch; b.v = vx * ch - vz * sh; b.r = r;
      Object.assign(b.ctl, ctlAt(i, b.u));
      const x0 = b.x, z0 = b.z, h0 = b.h, u0 = b.u, v0 = b.v, r0 = b.r;
      b.step(dt);
      // The planar motion is the path's: put it back (only heave, pitch and roll are the sim's).
      b.x = x0; b.z = z0; b.h = h0; b.u = u0; b.v = v0; b.r = r0;
    }
    const s = b.sample();
    s.x = track.x[i]; s.z = track.z[i]; s.h = track.h[i];
    s.speed = Math.hypot(vx, vz);
    // Spray at the bow: the stagnation line throws a sheet when it slams a wave or planes; wake from the speed.
    const slam = Math.max(0, -b.vy) * 0.5 + Math.max(0, b.q) * 0.2;
    s.bowSpray = clamp((H.planing ? sstep(3, 9, s.speed) * (1 - 0.5 * s.planing) : sstep(1.5, 4, s.speed) * 0.4) + slam, 0, 1.5);
    s.wake = clamp(s.speed / Math.max(1, Math.sqrt(G * H.L)) * 1.2, 0, 1.5);
    s.propWash = H.drive === "outboard" || H.drive === "inboard" ? clamp((s.ctl.throttle || 0) * 1.2, 0, 1) : 0;
    if (cycOverride != null) void cycOverride;
    out.push(s);
  }
  return out;
}

/** Stroke state for a seat at frame f from recorded spans ({seat, side, from, to}): {u (0..1 drive, then recovery), side, wet}. */
export function strokeAt(spans, seat, f, drivePhase = 0.45) {
  let best = null;
  for (const s of spans || []) { if (s.seat !== seat) continue; if (s.from <= f) best = s; else break; }
  if (!best) return null;
  const dur = Math.max(1, best.to - best.from);
  if (f < best.to) return { u: ((f - best.from) / dur) * drivePhase, side: best.side, wet: true };
  // Recovery until the next catch (or a resting hold after ~1 s).
  const next = (spans || []).find((s) => s.seat === seat && s.from > best.from);
  const gap = next ? next.from - best.to : dur * 1.2;
  const w = clamp((f - best.to) / Math.max(1, gap), 0, 1);
  if (!next && f - best.to > gap) return { u: 0.75, side: best.side, wet: false, rest: true };
  return { u: drivePhase + (1 - drivePhase) * w, side: next && w > 0.5 ? next.side : best.side, wet: false };
}

// ------------------------------------------------------------------ live (Drive mode)

/** A boat driven by hand: one Boat stepped at the sim rate. inp: {throttle 0..1, brake 0..1, steer -1..1, trim, sheet, paddle}. */
export class LiveBoat {
  constructor(kind, { x = 0, z = 0, heading = 0, waves = null, level = 0, wind = null, scale = 1, t0 = 0 } = {}) {
    this.b = new Boat(kind, { x, z, heading, waves, level, wind, scale, t0 });
    this.H = this.b.H;
    this.strokes = [];   // the spans as they happen, for the take
    this._open = new Map();
    this.frameAt = 0;
  }
  get X() { return this.b.x; } get Z() { return this.b.z; } get Hd() { return this.b.h; }
  get speed() { return this.b.u; }
  step(inp, dt, frame = null) {
    const H = this.H, b = this.b;
    if (isPaddle(H)) {
      b.ctl.effort = clamp(Math.max(inp.throttle || 0, inp.paddle || 0), 0, 1.3) * (inp.sprint ? 1.25 : 1);
      b.ctl.steer = clamp(inp.steer || 0, -1, 1);
      if ((inp.brake || 0) > 0.3) { b.ctl.effort = 0; b.u *= Math.max(0, 1 - 0.8 * dt); }   // back-paddling: a brace
    } else if (isSail(H)) {
      b.ctl.steer = clamp(inp.steer || 0, -1, 1);
      b.ctl.sheet = inp.sheet ?? null;
      b.ctl.throttle = clamp(inp.throttle || 0, 0, 1) * (inp.motor ? 1 : 0);
    } else {
      b.ctl.throttle = clamp(Math.max(inp.throttle || 0, 0), 0, 1) * (inp.sprint ? 1 : 0.85);
      b.ctl.reverse = (inp.brake || 0) > 0.3 && b.u < 1.5;
      if ((inp.brake || 0) > 0.3 && b.u >= 1.5) b.ctl.throttle = 0;
      b.ctl.steer = clamp(inp.steer || 0, -1, 1);
      if (Number.isFinite(inp.trim)) b.ctl.trim = clamp(inp.trim, ...(H.trimRange || [-4, 6]));
      else b.ctl.trim = b.u > 10 ? 3 : -2;   // auto trim: in for the hole shot, out once planing
    }
    const n = Math.max(1, Math.round(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) b.step(h);
    const s = b.sample();
    if (frame != null) for (const st of s.strokes || []) {
      const o = this._open.get(st.seat);
      if (st.wet && !o) this._open.set(st.seat, { seat: st.seat, side: st.side, from: frame });
      if (!st.wet && o) { this.strokes.push({ ...o, to: frame }); this._open.delete(st.seat); }
    }
    return s;
  }
}

// ------------------------------------------------------------------ metrics (tests and the panel readout)

/** Planing curve: trim and rise against speed for a steady run at each throttle. Returns [{throttle, speed, trim, rise}]. */
export function planingCurve(kind = "speedboat", { throttles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1], seconds = 25 } = {}) {
  const out = [];
  for (const th of throttles) {
    const b = new Boat(kind, {});
    const y0 = b.y;
    b.ctl.throttle = th; b.ctl.trim = 0;
    const n = seconds * 240;
    let tr = 0, ri = 0, sp = 0, m = 0;
    for (let i = 0; i < n; i++) { b.step(1 / 240); if (i > n * 0.75) { tr += b.pitch; ri += b.y - y0; sp += b.u; m++; } }
    out.push({ throttle: th, speed: sp / m, trim: tr / m / D2R, rise: ri / m });
  }
  return out;
}
