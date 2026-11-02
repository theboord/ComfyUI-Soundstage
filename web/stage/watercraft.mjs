// Watercraft on the stage: the wave-field water the boats float on (clay, Color, depth), each boat floated by its
// physics every frame (boatsim.mjs floatTrack: heave, pitch and roll on the waves, planing trim, heel), its moving
// parts (outboard trim and steering, rudder, boom and sails, paddles and oars), the people aboard pulling their
// strokes in sync (seated paddling poses with two-bone arm IK onto the paddle's grips), the wakes (Kelvin arms and the
// prop-wash track as foam ribbons on the surface) and the spray (bow sheets, prop wash and paddle drips through the
// shared particle system).
//
// installWatercraft(Stage, deps) adds the hooks; stage.mjs calls three of them (_boatFloat from its water physics,
// _boatRider from its rider pass, and the render wrap is installed here). Everything is a pure function of the frame
// and the scene, cached by a signature, so a capture is repeatable.
import * as THREE from "../vendor/three.module.min.mjs";
import * as W from "./waves.mjs";
import * as BS from "./boatsim.mjs";
import { shapeSail } from "./boatmesh.mjs";
import { applyPose } from "./humans.mjs";

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

/** Sets whose water gets the wave field (the tank stays glassy, the beach rides its swell). */
export const WAVE_SETS = new Set(["open_water", "lake", "beach", "river_rapids", "water_tank"]);

// ------------------------------------------------------------------ the wave mesh

/** A grid around a centre, fine near it (15 cm) and coarse far out (exponential spacing, out to `reach` m). */
export function waveGrid(n = 100, reach = 450, first = 0.15) {
  // s(i) = a (e^{b i} - 1) with s(1) ≈ first and s(n) = reach.
  let b = 0.05;
  for (let it = 0; it < 60; it++) { const r = (Math.exp(b * n) - 1) / (Math.exp(b) - 1); b *= r > reach / first ? 0.995 : 1.005; }
  const a = first / (Math.exp(b) - 1);
  const s = [];
  for (let i = -n; i <= n; i++) s.push(Math.sign(i) * a * (Math.exp(b * Math.abs(i)) - 1));
  return s;
}

function buildWaveMesh(water) {
  const s = waveGrid(96, Math.max(water.size[0], water.size[1]));
  const N = s.length;
  const pos = new Float32Array(N * N * 3), idx = [];
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) {
    const a = i * N + j, b2 = a + 1, c = a + N, d = c + 1;
    idx.push(a, c, b2, b2, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({ color: 0x5f7f92, roughness: 0.22, metalness: 0.0, transparent: true, opacity: 0.88, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.receiveShadow = true;
  m.userData.water = true;
  m.userData.waves = true;
  m.userData.grid = s;
  return m;
}

/** Displace the wave mesh around (cx, cz) at time t: each vertex at its world point, waves too fine for the local
 *  grid spacing left out (no shimmer), the field faded into the still level at the water's edge. */
export function updateWaveMesh(m, F, level, cx, cz, t, extent) {
  const s = m.userData.grid, N = s.length, P = m.geometry.attributes.position.array;
  const C = F.comps;
  const [hx, hz, ox, oz] = extent;
  for (let i = 0; i < N; i++) {
    const x = cx + s[i];
    const di = i > 0 ? Math.abs(s[i] - s[i - 1]) : Math.abs(s[1] - s[0]);
    for (let j = 0; j < N; j++) {
      const z = cz + s[j];
      const dj = j > 0 ? Math.abs(s[j] - s[j - 1]) : Math.abs(s[1] - s[0]);
      const sp = Math.max(di, dj);
      const xc = clamp(x, ox - hx, ox + hx), zc = clamp(z, oz - hz, oz + hz);
      let h = 0;
      const xs = xc - F.current[0] * t, zs = zc - F.current[1] * t;
      for (let k = 0; k < F.n; k++) {
        const o = k * 5;
        const kk = Math.abs(C[o + 1]) + Math.abs(C[o + 2]);
        if (kk * sp > 1.4) continue;          // shorter than ~4 grid cells: leave it out here
        h += C[o] * Math.cos(C[o + 1] * xs + C[o + 2] * zs - C[o + 3] * t + C[o + 4]);
      }
      if (F.chop) h += W.heightAt(F.chop, xc, zc, t) * (sp < 1.5 ? 1 : 0);
      if (F.standing && sp < 1.2) h += W.heightAt({ ...F, comps: new Float64Array(0), n: 0, chop: null }, xc, zc, t);
      const o3 = (i * N + j) * 3;
      P[o3] = xc; P[o3 + 1] = level + h; P[o3 + 2] = zc;
    }
  }
  m.geometry.attributes.position.needsUpdate = true;
  m.geometry.computeVertexNormals();
  m.position.set(0, 0, 0);
}

// ------------------------------------------------------------------ wakes

/** Kelvin wake arms half-angle (rad): 19.47° in deep water; narrower for a fast planing hull (Rabaud & Moisy 2013:
 *  the visible angle falls ≈ 1/Fr once the hull Froude number passes ~0.6). */
export function wakeAngle(Fn) { return Fn < 0.55 ? 19.47 * D2R : Math.max(5 * D2R, Math.atan(1 / (2 * Math.sqrt(2) * Math.max(1, Fn * 1.8 - 0.0)) * 1)); }

/**
 * Wake ribbons for a track: two arm crests (and the prop-wash / centre foam track) as triangle strips. Each sample j
 * of the last `secs` seconds emitted at the stern then; now its arm points sit V τ tan α out to each side, its crest
 * height decays as (1 + τ/τ0)^-½. Returns {pos: Float32Array, col: Float32Array, n} (vertices), for a mesh update.
 */
export function wakeRibbons(track, f, { secs = 9, fps = 24, L = 6, B = 2, level = 0, F = null, t = 0, planing = false } = {}) {
  const verts = [], cols = [];
  const N = Math.min(f, Math.round(secs * fps));
  const step = 2;
  const arms = [[], []], centre = [];
  for (let j = 0; j <= N; j += step) {
    const s = track[f - j];
    if (!s) break;
    const tau = j / fps, V = s.speed || 0;
    if (V < 0.25) continue;
    const Fn = V / Math.sqrt(9.81 * L), al = wakeAngle(Fn);
    const sh = Math.sin(s.h), ch = Math.cos(s.h);
    // the stern at that moment
    const ex = s.x - sh * L * 0.5, ez = s.z - ch * L * 0.5;
    const w = B * 0.4 + V * tau * Math.tan(al);
    const amp = clamp(0.04 + 0.025 * V, 0, 0.45) * Math.pow(1 + tau / 1.2, -0.5) * sstep(0.2, 1.5, V);
    for (const [k, sd] of [[0, 1], [1, -1]]) arms[k].push({ x: ex + sd * ch * w, z: ez - sd * sh * w, amp, tau, dir: s.h, wid: 0.25 + 0.05 * V * Math.min(tau, 3) });
    centre.push({ x: ex, z: ez, amp: amp * 0.5, tau, dir: s.h, wid: B * (0.35 + 0.08 * tau) * (planing ? 1 : 0.7), foam: s.propWash ?? 0.5 });
  }
  const strip = (pts, foamK) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const nx = Math.cos(a.dir), nz = -Math.sin(a.dir), mx = Math.cos(b.dir), mz = -Math.sin(b.dir);
      const ya = level + (F ? W.heightAt(F, a.x, a.z, t) : 0) + a.amp, yb = level + (F ? W.heightAt(F, b.x, b.z, t) : 0) + b.amp;
      const q = [[a.x + nx * a.wid, ya - a.amp * 0.6, a.z + nz * a.wid], [a.x - nx * a.wid, ya - a.amp * 0.6, a.z - nz * a.wid],
        [b.x + mx * b.wid, yb - b.amp * 0.6, b.z + mz * b.wid], [b.x - mx * b.wid, yb - b.amp * 0.6, b.z - mz * b.wid]];
      const ca = clamp((1 - a.tau / secs) * foamK, 0, 1), cb = clamp((1 - b.tau / secs) * foamK, 0, 1);
      // The crest line is the middle: lift it so the ribbon reads as a ridge, not a flat stripe.
      const mid = (p, r, y) => [(p[0] + r[0]) / 2, y, (p[2] + r[2]) / 2];
      const am = mid(q[0], q[1], ya + 0.02), bm = mid(q[2], q[3], yb + 0.02);
      for (const [p1, p2, p3, c1, c2, c3] of [[q[0], am, q[2], ca, ca, cb], [am, bm, q[2], ca, cb, cb], [am, q[1], bm, ca, ca, cb], [q[1], q[3], bm, ca, cb, cb]]) {
        verts.push(...p1, ...p2, ...p3); cols.push(c1, c2, c3);
      }
    }
  };
  strip(arms[0], 0.9); strip(arms[1], 0.9); strip(centre, 1.0);
  return { pos: new Float32Array(verts), foam: new Float32Array(cols), n: verts.length / 3 };
}

// ------------------------------------------------------------------ paddles and the people's strokes

/** The paddle's blade and grip points (boat-local, hull-size metres) for a stroke state, and where the hands go. */
export function paddlePose(H, seat, st, style, side, wl) {
  const [sx, sy, sz] = seat;
  const s = side || 1;
  const d = H.drivePhase || 0.45;
  const u = st ? st.u : 0.75, wet = st ? st.wet : false;
  const bAt = (z) => BS.station(H, z / H.L + 0.5).b;
  if (style === "kayak") {
    const v = u < d ? (1 - Math.cos((Math.PI * u) / d)) / 2 : 1 - (1 - Math.cos((Math.PI * (u - d)) / (1 - d))) / 2;
    const C = [0, sy + 0.42, sz + 0.38];
    const bz = sz + 0.95 - 1.15 * v, by = wet ? wl - 0.12 - 0.08 * Math.sin(Math.PI * v) : wl + 0.25;
    const tgt = [s * 0.92, by, bz];
    const dir = new THREE.Vector3(tgt[0] - C[0], tgt[1] - C[1], tgt[2] - C[2]).normalize();
    return { centre: C, dir, hands: { l: [C[0] + dir.x * 0.38 * s, C[1] + dir.y * 0.38 * s, C[2] + dir.z * 0.38 * s], r: [C[0] - dir.x * 0.38 * s, C[1] - dir.y * 0.38 * s, C[2] - dir.z * 0.38 * s] },
      twist: s * 22 * Math.cos(Math.PI * v), bend: 14 - 8 * v, active: s };
  }
  if (style === "pole") {
    const v = u < d ? u / d : 1 - (u - d) / (1 - d);
    const top = [sx + 0.1, sy + 1.25 - 0.3 * v, sz + 0.35 - 0.7 * v];
    const bot = [sx + 0.35, -1.6, sz + 0.5 - 2.2 * v + (wet ? 0 : 0.6)];
    const dir = new THREE.Vector3(bot[0] - top[0], bot[1] - top[1], bot[2] - top[2]).normalize();
    return { grip: top, dir, hands: { l: [top[0] + dir.x * 0.05, top[1] + dir.y * 0.05, top[2] + dir.z * 0.05], r: [top[0] + dir.x * 0.6, top[1] + dir.y * 0.6, top[2] + dir.z * 0.6] }, twist: 10, bend: 15 + 25 * v };
  }
  // Single blade (canoe, raft): catch ahead, pull to the hip, lift and swing forward (feathered).
  let bz, by, bx, feather = 0;
  const b0 = bAt(sz);
  if (u < d) {
    const v = (1 - Math.cos((Math.PI * u) / d)) / 2;
    bz = sz + 0.62 - 1.0 * v; by = wl - 0.28 - 0.1 * Math.sin((Math.PI * u) / d); bx = s * (b0 + 0.16);
  } else {
    const w = (u - d) / (1 - d), v = (1 - Math.cos(Math.PI * w)) / 2;
    bz = sz - 0.38 + 1.0 * v; by = wl + 0.08 + 0.2 * Math.sin(Math.PI * w); bx = s * (b0 + 0.26); feather = Math.sin(Math.PI * w);
  }
  const gripGuess = [s * 0.04, sy + 0.78, bz - 0.05];
  const dir = new THREE.Vector3(bx - gripGuess[0], by - gripGuess[1], bz - gripGuess[2]).normalize();
  const grip = [bx - dir.x * 1.18, by - dir.y * 1.18, bz - dir.z * 1.18];
  const lower = [grip[0] + dir.x * 0.62, grip[1] + dir.y * 0.62, grip[2] + dir.z * 0.62];
  const v = u < d ? u / d : 1 - (u - d) / (1 - d);
  // Top hand on the grip is the hand away from the water (a right-side stroke: left hand on top).
  const hands = s > 0 ? { r: grip, l: lower } : { l: grip, r: lower };
  return { grip, dir, hands, feather, twist: -s * 24 * Math.cos(Math.PI * v), bend: 20 - 12 * v };
}

/** An oar (rowboat): sweep angle and lift through the stroke; the handle point for each hand. */
export function oarPose(st, d = 0.38) {
  const u = st ? st.u : 0.7;
  let th, e;
  if (u < d) { const v = (1 - Math.cos((Math.PI * u) / d)) / 2; th = 40 - 75 * v; e = 0.2; }
  else { const w = (u - d) / (1 - d), v = (1 - Math.cos(Math.PI * w)) / 2; th = -35 + 75 * v; e = -0.18 * Math.sin(Math.PI * w) - 0.05; }
  const bend = u < d ? 28 - 46 * ((1 - Math.cos((Math.PI * u) / d)) / 2) : -18 + 46 * ((1 - Math.cos(Math.PI * (u - d) / (1 - d))) / 2);
  return { th: th * D2R, e, bend };
}

/** Two-bone arm IK: bend the elbow so shoulder-to-wrist spans the target, then swing the shoulder onto it. */
export function armIK(g, lr, target) {
  const J = g.userData.joints;
  const sh = J?.[`${lr}_shoulder`], el = J?.[`${lr}_elbow`], wr = J?.[`${lr}_wrist`];
  if (!sh || !el || !wr) return false;
  g.updateMatrixWorld(true);
  const S = sh.getWorldPosition(new THREE.Vector3());
  const want = target.clone().sub(S);
  const dist = want.length();
  if (dist < 1e-4) return false;
  const sc = new THREE.Vector3(); g.getWorldScale(sc);
  const upper = el.position.clone().multiply(sc), lower = wr.position.clone().multiply(sc);
  const spanAt = (th) => upper.clone().add(lower.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -th)).length();
  let lo = 0, hi = 2.5, th;
  if (dist >= spanAt(lo)) th = lo; else if (dist <= spanAt(hi)) th = hi;
  else { for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (spanAt(m) > dist) lo = m; else hi = m; } th = (lo + hi) / 2; }
  el.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -th);
  sh.quaternion.identity();
  sh.updateMatrixWorld(true);
  const cur = wr.getWorldPosition(new THREE.Vector3()).sub(S);
  if (cur.lengthSq() > 1e-10) {
    const swing = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want.clone().normalize());
    const shW = sh.getWorldQuaternion(new THREE.Quaternion());
    const parentW = sh.parent.getWorldQuaternion(new THREE.Quaternion());
    sh.quaternion.copy(parentW.invert().multiply(swing.multiply(shW)));
  }
  g.updateMatrixWorld(true);
  return true;
}

/** The seated pose for a seat on a boat: "paddle" (low seat, knees up), "kayak", "row" (facing aft), "stand", "sit". */
export function seatPoseFor(kind, seat) {
  const H = BS.HULLS[kind];
  if (!H) return "sit";
  const p = H.paddlers?.[seat];
  if (kind === "kayak") return "kayak";
  if (kind === "rowboat" && seat === 0) return "row";
  if (kind === "log_raft" && seat === 0) return "stand";
  if (p && (kind === "canoe" || kind === "raft")) return "paddle";
  if (kind === "dinghy" || kind === "canoe" || kind === "rowboat") return "paddle";
  return "sit";
}

// ------------------------------------------------------------------ install

export function installWatercraft(Stage, deps = {}) {
  const { LIBRARY } = deps;
  const P = Stage.prototype;

  /** The wave field for the stage's environment (cached by its settings). */
  P.waveField = function () {
    const env = this.state.environment || {};
    if (!this.water || !WAVE_SETS.has(env.set)) return null;
    const sig = JSON.stringify([env.set, env.sea_state, env.wind_mps, env.wind_deg, env.flow_deg, env.sea_seed]);
    if (this._wf?.sig !== sig) this._wf = { sig, F: W.fieldFor(env) };
    return this._wf.F;
  };
  P.setSeaState = function (id, extra = {}) {
    if (!W.SEA_STATES[id]) return null;
    this.state.environment = { ...(this.state.environment || {}), sea_state: id, ...extra };
    this._boatTracks = new Map();
    this.setFrame(this.frame); this.onChange?.(this.toJSON());
    return this.waveField();
  };

  /** Hull scale of an actor's boat (library height and the object's scale). */
  P._boatScale = function (a, g) { return (g?.userData.boatK || 1) * (a.scale || 1); };

  /** The floated track of a boat over the whole shot (cached by its path, parts, the sea and the water level). */
  P._boatTrack = function (a, g, level) {
    const kind = a.kind, F = this.waveField(), last = this._lastFrame(), fps = this.state.shot?.fps || 24;
    const keys = this._actorKeys(a);
    const sig = JSON.stringify([kind, keys, a.rotation_deg || 0, a.parts || null, a.boat || null, this._wf?.sig || "", level, last, fps, a.scale || 1, a.height_m || 0]);
    const cache = (this._boatTracks ||= new Map());
    const c = cache.get(a.id);
    if (c?.sig === sig) return c.track;
    const x = [], z = [], h = [];
    for (let f = 0; f <= last; f++) { const p = this._actorPosAt(a, f); x.push(p[0]); z.push(p[2]); h.push(this._headingAt(a, f)); }
    const ctl = {};
    const chan = (ch, conv = (v) => v) => {
      const k = a.parts?.[ch];
      if (!k?.length) return null;
      const arr = [];
      for (let f = 0; f <= last; f++) arr.push(conv(this.partValue?.(a.id, ch, f)));
      return arr;
    };
    ctl.throttle = chan("throttle") ?? undefined; ctl.trim = chan("motor_trim") ?? undefined;
    const sheet = chan("sheet"); if (sheet) ctl.sheet = sheet;
    const eff = chan("effort"); if (eff) ctl.effort = eff;
    for (const k of Object.keys(ctl)) if (ctl[k] === undefined) delete ctl[k];
    const wind = F ? [F.windDir[0] * F.wind, F.windDir[1] * F.wind] : [0, 0];
    let track;
    try { track = BS.floatTrack(kind, { x, z, h, fps }, { waves: F, level, wind, scale: this._boatScale(a, g), controls: ctl }); }
    catch (err) { console.warn("Soundstage boat float", err); track = x.map((_, i) => ({ y: level - 0.3, pitch: 0, roll: 0, speed: 0, x: x[i], z: z[i], h: h[i] })); }
    // Recorded strokes (a preset's sim or a Drive take) replace the inferred ones, so the people pull exactly when the
    // hull surged.
    if (a.boat?.strokes?.length) {
      const H = BS.hullOf(kind);
      track.forEach((s, f) => { s.strokes = (H.paddlers || []).map((p, seat) => ({ seat, ...(BS.strokeAt(a.boat.strokes, seat, f, H.drivePhase) || { u: 0.75, side: p.side, wet: false, rest: true }) })); });
    }
    cache.set(a.id, { sig, track });
    return track;
  };

  /** Water physics hook for boats (stage.mjs _waterPhysics): float the hull on the waves at this frame. */
  P._boatFloat = function (a, g, level) {
    if (!BS.isBoatKind(a.kind)) return false;
    const tr = this._boatTrack(a, g, level);
    const s = tr[clamp(this.frame, 0, tr.length - 1)];
    if (!s) return false;
    g.rotation.order = "YXZ";
    g.rotation.x = -s.pitch * D2R;
    g.rotation.z = s.roll * D2R;
    g.position.y = s.y;
    g.userData.inWater = true;
    g.userData.speed = s.speed;
    g.userData.boatState = s;
    this._boatParts(a, g, s);
    return true;
  };

  /** Pose the boat's own moving parts from its state at this frame. */
  P._boatParts = function (a, g, s) {
    const R = g.userData.boat;
    if (!R) return;
    const H = BS.hullOf(a.kind), t = this.frame / (this.state.shot?.fps || 24);
    const pv = (ch) => this.partValue?.(a.id, ch);
    if (R.motor) {
      const trim = Number.isFinite(pv("motor_trim")) ? pv("motor_trim") : s.ctl?.trim ?? 0;
      const steer = Number.isFinite(pv("rudder")) ? pv("rudder") : clamp((s.r || 0) * -0.9, -30, 30);
      R.motor.pivot.rotation.x = -trim * D2R;
      R.motor.steer.rotation.y = -steer * D2R;
      R.motor.prop.rotation.z = t * (s.ctl?.throttle || 0) * 90;
    }
    if (R.rudder) R.rudder.rotation.y = -(Number.isFinite(pv("rudder")) ? pv("rudder") : clamp((s.r || 0) * -1.2, -32, 32)) * D2R;
    for (const r of R.rig) {
      const sl = s.sails?.[r.id];
      if (!sl) continue;
      const boom = Number.isFinite(pv("boom")) ? pv("boom") : sl.boom;
      r.pivot.rotation.y = boom * D2R;
      const lee = boom >= 0 ? 1 : -1;
      shapeSail(r.geom, sl.luff > 0.5 ? 0.03 : 0.11 * clamp(Math.abs(sl.cl || 0.8), 0.3, 1.3), lee, sl.luff || 0, t);
    }
    // Paddles / oars from the stroke state (the people's hands are put on them in the rider pass).
    const wl = this._boatWl(a, g);
    for (const pd of R.paddles) {
      const st = s.strokes?.find((x) => x.seat === pd.seat) || null;
      if (pd.style === "row") {
        const o = BS.HULLS[a.kind] ? oarPose(st, H.drivePhase) : null;
        if (!o) continue;
        // +Y of the oar group is the handle: point it inboard (toward the centreline), swept fore and aft by th.
        const hd = new THREE.Vector3(-pd.side * Math.cos(o.th), o.e, -Math.sin(o.th)).normalize();
        pd.oar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hd);
        pd.handle = pd.group.position.clone().add(hd.clone().multiplyScalar(0.84));
        pd.bend = o.bend;
        continue;
      }
      const side = st?.side ?? pd.side ?? 1;
      const pp = paddlePose(H, R.seats[pd.seat], st, pd.style, side || 1, wl);
      if (pd.style === "kayak") {
        pd.group.position.set(...pp.centre);
        pd.group.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), pp.dir.clone().multiplyScalar(pp.active));
      } else {
        pd.group.position.set(...pp.grip);
        pd.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), pp.dir);
        if (pp.feather) pd.group.rotateY(pp.feather * Math.PI / 2);
      }
      pd.pose = pp;
    }
    // Lamps: nav lights (red to port, green to starboard, white stern and masthead), the anchor light, deck floods.
    // Lit lamps glow in the clay guide too (allowOverride off), so the video model sees them.
    const inner = g.userData.boatInner || g;
    if (!R.lampMeshes) {
      R.lampMeshes = {};
      const COL = { nav_l: 0xff2a1a, nav_r: 0x1aff5a, stern: 0xfff6e0, mast: 0xfff6e0, anchor: 0xfff6e0, deck: 0xfff2d0 };
      for (const [name, p] of Object.entries(R.lamps)) {
        const mat = new THREE.MeshBasicMaterial({ color: COL[name] || 0xffffff });
        mat.allowOverride = false;
        const m = new THREE.Mesh(new THREE.SphereGeometry(name === "deck" ? 0.09 : 0.05, 10, 8), mat);
        m.position.set(...p); m.visible = false; m.userData.lamp = name; m.castShadow = false;
        inner.add(m);
        R.lampMeshes[name] = m;
        if (name === "deck" || name === "anchor") { const l = new THREE.PointLight(COL[name], 0, name === "deck" ? 18 : 6, 1.6); l.position.set(...p); inner.add(l); R.lampMeshes[name + "_light"] = l; }
      }
    }
    const nav = pv("navlights"), anc = pv("anchor_light"), dk = pv("deck_lights");
    const L = R.lampMeshes;
    for (const n of ["nav_l", "nav_r", "stern", "mast"]) if (L[n]) L[n].visible = nav === "on" || nav === "strobe";
    if (L.anchor) L.anchor.visible = anc === "on";
    if (L.anchor_light) L.anchor_light.intensity = anc === "on" ? 2.5 : 0;
    if (L.deck) L.deck.visible = dk === "on";
    if (L.deck_light) L.deck_light.intensity = dk === "on" ? 30 : 0;
  };

  /** The still waterline height on the hull (local, hull-size metres). */
  P._boatWl = function (a) { const H = BS.hullOf(a.kind); return H ? BS.restDraft(H).T : 0.2; };

  /**
   * Rider pass hook: someone seated on a boat rides its full motion (heave, pitch, roll), sits in the pose of their
   * seat and, at a paddling seat, pulls the stroke with their hands on the paddle. Returns true when it placed them.
   */
  P._boatRider = function (a, g, host, hg) {
    const R = hg.userData.boat;
    if (!R || !BS.isBoatKind(host.kind)) return false;
    if (a.mount_at > 0 && this.frame < a.mount_at) return false;     // climbing in: the stage's hop
    const inner = hg.userData.boatInner || hg;
    const seats = R.seats || [];
    const si = clamp(a.seat ?? 0, 0, Math.max(0, seats.length - 1));
    const seat = seats[si] || [0, R.D * 0.6, 0];
    const h = (a.height_m || 1.8) * (a.scale || 1);
    const pose = a.pose && a.pose !== "sit" ? a.pose : seatPoseFor(host.kind, si);
    const drop = applyPose(g, pose, h);
    for (const jn of ["spine", "neck", "head"]) g.userData.joints?.[jn]?.rotation.set(0, 0, 0);
    inner.updateMatrixWorld(true);
    const seatW = inner.localToWorld(new THREE.Vector3(...seat));
    const facing = host.kind === "rowboat" && si === 0 ? Math.PI : 0;
    const q = hg.getWorldQuaternion(new THREE.Quaternion()).multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    g.quaternion.copy(q);
    g.position.copy(seatW).addScaledVector(up, -drop);
    // The stroke: the trunk winds and unwinds, the hands go to the paddle.
    const pd = R.paddles.filter((p) => p.seat === si);
    const s = hg.userData.boatState;
    if (pd.length && s && g.userData.joints) {
      const J = g.userData.joints;
      if (pd[0].style === "row") {
        const bend = pd[0].bend ?? 0;
        J.spine?.rotation.set(bend * D2R, 0, 0);
        for (const o of pd) { const w = inner.localToWorld(o.handle.clone()); armIK(g, o.side > 0 ? "r" : "l", w); }   // facing aft: his right hand takes the left oar
      } else if (pd[0].pose) {
        const pp = pd[0].pose;
        J.spine?.rotation.set((pp.bend || 0) * D2R, (pp.twist || 0) * D2R, 0);
        g.updateMatrixWorld(true);
        for (const lr of ["l", "r"]) if (pp.hands[lr]) armIK(g, lr, inner.localToWorld(new THREE.Vector3(...pp.hands[lr])));
      }
    }
    return true;
  };

  // ---- the water and the wakes, every render
  const render0 = P._renderMode;
  P._renderMode = function (mode, forCapture = false) {
    try { this._waterAt(forCapture ? this.camera : this._viewportCamera?.() || this.camera); } catch (err) { if (!this._wcWarned) { this._wcWarned = true; console.warn("Soundstage water", err); } }
    // On the water the horizon is far: the shot camera's 200 m far plane would cut the lake off in a hard wedge and
    // hide the far shore. Clay and Color see to 1.2 km; depth keeps its 200 m scale (the guide's contrast is unchanged).
    const cam = this.camera, far = cam?.far;
    const extend = !!this._waveMesh?.visible && cam && far < 1200 && mode !== "depth";
    if (extend) { cam.far = 1200; cam.updateProjectionMatrix(); }
    try { return render0.call(this, mode, forCapture); } finally { if (extend) { cam.far = far; cam.updateProjectionMatrix(); } }
  };

  P._waterAt = function (cam) {
    const F = this.waveField();
    if (!F) { if (this._waveMesh) this._waveMesh.visible = false; for (const m of this._wakeMeshes?.values() || []) m.visible = false; return; }
    const w = this.water, geo = w.geometry.parameters;
    if (!this._waveMesh || this._waveMesh.userData.forWater !== w) {
      if (this._waveMesh) this._waveMesh.parent?.remove(this._waveMesh);
      this._waveMesh = buildWaveMesh({ size: [geo.width, geo.height] });
      this._waveMesh.userData.forWater = w;
      this.root.add(this._waveMesh);
      w.layers.set(2);                 // the flat plane stays for the "over the water?" tests, but is never drawn
    }
    const m = this._waveMesh;
    m.visible = true;
    if (m.parent !== this.root) this.root.add(m);
    const fps = this.state.shot?.fps || 24, t = this.frame / fps;
    const c = cam?.position || new THREE.Vector3();
    // Fine grid under the camera's look point (half way to what it frames), snapped to 0.5 m.
    const dir = new THREE.Vector3(); cam?.getWorldDirection?.(dir);
    const ahead = clamp(c.y / Math.max(0.05, -dir.y || 0.05), 0, 40) * 0.5;
    const cx = Math.round((c.x + dir.x * ahead) * 2) / 2, cz = Math.round((c.z + dir.z * ahead) * 2) / 2;
    const key = `${cx},${cz},${this.frame},${this._wf.sig},${w.position.y}`;
    if (m.userData.key !== key) {
      updateWaveMesh(m, F, w.position.y, cx, cz, t, [geo.width / 2, geo.height / 2, w.position.x, w.position.z]);
      m.userData.key = key;
    }
    // Wakes behind every moving boat.
    const live = new Set();
    for (const a of this.state.actors) {
      if (!BS.isBoatKind(a.kind)) continue;
      const g = this.actorMeshes.get(a.id), tr = this._boatTracks?.get(a.id)?.track;
      if (!g || !tr) continue;
      live.add(a.id);
      const H = BS.hullFor(a.kind, this._boatScale(a, g));
      let wm = (this._wakeMeshes ||= new Map()).get(a.id);
      if (!wm) {
        const mat = new THREE.MeshStandardMaterial({ color: 0xf4f7f8, roughness: 0.65, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, vertexColors: true });
        mat.allowOverride = false;   // white foam in the clay guide too: the video model reads a wake
        wm = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        wm.frustumCulled = false; wm.userData.water = true; wm.userData.wake = a.id; wm.renderOrder = 2;
        this._wakeMeshes.set(a.id, wm);
      }
      if (wm.parent !== this.root) this.root.add(wm);
      const wkey = `${this.frame}|${this._boatTracks.get(a.id).sig.length}|${this._wf.sig}`;
      if (wm.userData.key !== wkey) {
        const r = wakeRibbons(tr, clamp(this.frame, 0, tr.length - 1), { fps, L: H.L, B: H.B, level: w.position.y, F, t, planing: !!H.planing });
        const col = new Float32Array(r.n * 3);
        for (let i = 0; i < r.n; i++) { const k = r.foam[i]; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.55 + 0.45 * k; }
        wm.geometry.setAttribute("position", new THREE.BufferAttribute(r.pos, 3));
        wm.geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
        wm.geometry.computeVertexNormals();
        wm.userData.key = wkey;
      }
      wm.visible = true;
    }
    for (const [id, wm] of this._wakeMeshes || []) if (!live.has(id)) wm.visible = false;
  };

  // ---- spray, prop wash and paddle drips through the shared particle system
  const em0 = P._secondaryEmitters;
  if (em0) P._secondaryEmitters = function () {
    const em = em0.call(this);
    try { em.push(...this._boatEmitters()); } catch (err) { if (!this._wcWarnedE) { this._wcWarnedE = true; console.warn("Soundstage boat spray", err); } }
    return em;
  };
  P._boatEmitters = function () {
    const out = [];
    if (!this.water) return out;
    const fps = this.state.shot?.fps || 24, level = this.water.position.y;
    for (const a of this.state.actors) {
      if (!BS.isBoatKind(a.kind)) continue;
      const g = this.actorMeshes.get(a.id), tr = this._boatTracks?.get(a.id)?.track;
      if (!g || !tr) continue;
      const H = BS.hullFor(a.kind, this._boatScale(a, g));
      out.push(...boatEmitters(tr, H, { fps, level, id: a.id }));
    }
    return out;
  };
  P._boatFloor = function () { return this._boatTracks?.size && this.water ? this.water.position.y : null; };

  /** What the panel and the Director read: kind, speed, trim, heel, planing, sea. */
  P.boatInfo = function (id) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a || !BS.isBoatKind(a.kind)) return null;
    const s = this.actorMeshes.get(id)?.userData.boatState;
    const F = this.waveField();
    return { kind: a.kind, hull: BS.hullOf(a.kind).label, speed_kn: s ? +(s.speed * 1.944).toFixed(1) : 0, trim_deg: s ? +s.pitch.toFixed(1) : 0, heel_deg: s ? +s.roll.toFixed(1) : 0,
      planing: s ? +(s.planing || 0).toFixed(2) : 0, sea: F ? F.label : null, sea_words: W.seaWords(F) };
  };
  void LIBRARY;
}

/**
 * Particle emitters for one boat's track: the bow sheet (spray thrown out and up both sides at the stem when it
 * slams or before it planes), the prop wash (white churn behind the transom with the throttle), wake foam along the
 * stern, and drips off the paddles at each catch and exit. Pure: the stage turns them into particles (particles.mjs).
 */
export function boatEmitters(track, H, { fps = 24, level = 0, id = "boat", every = 2 } = {}) {
  const out = [];
  const seed0 = [...String(id)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 9973, 7);
  for (let f = 0; f < track.length; f += every) {
    const s = track[f];
    if (!s) continue;
    const sh = Math.sin(s.h), ch = Math.cos(s.h);
    const V = s.speed || 0;
    const vel = [sh * V, 0, ch * V];
    const at = (fx, lx) => [s.x + sh * fx + ch * lx, level + 0.05, s.z + ch * fx - sh * lx];
    // Bow sheet: from the stem, out to each side and up.
    if ((s.bowSpray || 0) > 0.08) {
      const k = s.bowSpray;
      for (const sd of [1, -1]) {
        const p = at(H.L * (H.planing ? 0.12 + 0.18 * (1 - (s.planing || 0)) : 0.42), sd * H.B * 0.35);
        out.push({ src: "boat", t: f / fps, pos: p, vel: [vel[0] * 0.6 + ch * sd * (1.5 + V * 0.25), 1.2 + V * 0.18, vel[2] * 0.6 - sh * sd * (1.5 + V * 0.25)], normal: [ch * sd, 0.8, -sh * sd],
          k, dust: Math.round(2 + 5 * k), debris: Math.round(4 + 10 * k), sparks: 0, preset: "wet_spray", debrisPreset: "wet_spray", size: 0.6 + 0.4 * k, spread: 0.3, kick: 1.2 + V * 0.12,
          seed: seed0 * 13.7 + f * 0.37 + sd, density: Math.min(1, 0.5 + 0.4 * k) });
      }
    }
    // Prop wash and stern foam.
    if ((s.propWash || 0) > 0.05 && V > 0.5) {
      const p = at(-H.L * 0.52, 0);
      out.push({ src: "boat", t: f / fps, pos: p, vel: [vel[0] * 0.2, 0.5, vel[2] * 0.2], normal: [0, 1, 0], k: s.propWash, dust: Math.round(3 + 5 * s.propWash), debris: Math.round(3 * s.propWash),
        sparks: 0, preset: "foam", debrisPreset: "wet_spray", size: 0.8, spread: H.B * 0.3, kick: 0.6, seed: seed0 * 7.1 + f * 0.53, density: 0.85 });
    }
    // Paddle drips: at the catch and the exit of each stroke.
    for (const st of s.strokes || []) {
      const prev = track[f - every]?.strokes?.find((x) => x.seat === st.seat);
      if (!prev || prev.wet === st.wet) continue;
      const pd = H.paddlers?.[st.seat];
      if (!pd) continue;
      const side = st.side || 1;
      const p = at(pd.x + (st.wet ? 0.6 : -0.35), side * (H.B * 0.5 + 0.2));
      out.push({ src: "boat", t: f / fps, pos: p, vel: [vel[0], 0.6, vel[2]], normal: [0, 1, 0], k: 0.4, dust: 1, debris: st.wet ? 3 : 6, sparks: 0, preset: "wet_spray", debrisPreset: "wet_spray",
        size: 0.25, spread: 0.1, kick: 0.4, seed: seed0 * 3.3 + f * 0.71 + st.seat, density: 0.4 });
    }
  }
  return out;
}
