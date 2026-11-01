// Soundstage phone viewfinder: the pure parts (no DOM, no three.js), shared by the phone page (viewfinder.mjs),
// the desktop hook (desk.mjs) and the tests (tests/js/viewfinder.test.mjs).
//
//   lens maths      primes, zoom (pinch / rocker / smoothing), focus ring (diopters), T-stops, depth of field, CoC
//   framing         the delivery frame inside the phone screen, aspect masks, thirds, timecode
//   orientation     DeviceOrientation -> camera quaternion, yaw / pitch / roll, level
//   VfRig           phone motion + sticks + drag -> the shot camera on the set (re-centre = back to the shot camera)
//   recording       TakeRecorder (samples at the screen rate) -> takeToKeys (stabilized stage keys with lens channels)
//   protocol        the WebSocket messages between the phone, soundstage/vcam.py and the desktop
//
// Conventions: metres, Y up, a camera looks down its local -Z (three.js), quaternions [x, y, z, w], angles in degrees
// unless the name says rad. Stage camera keys: {frame, position, target, focal_mm}; a shot's lens_keys: {frame, focus_m, t_stop, roll? (rad)}.

import { stabilize, stageCameraAt, qmul, qrotate, forwardOf, eulerOf, qlookZeroRoll } from "../movefit/stabilize.mjs";

export const PRIMES = [14, 18, 24, 35, 50, 85, 135];          // the App's lens picker (web/ui/cinegear.mjs lensCards)
export const FULL_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
export const SENSOR_W_MM = 36;                                  // full frame, as the stage (vfovFromFocal)
export const COC_MM = 0.03;                                     // full-frame circle of confusion
export const FOCAL_MIN = 10, FOCAL_MAX = 300;
export const FOCUS_MIN = 0.3, FOCUS_INF = 1000;                 // metres; 1000 m reads as infinity
export const STOP_MIN = 1.4, STOP_MAX = 22;
export const ASPECT_RATIO = { "2.39": 2.39, "1.85": 1.85, "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4 };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- lens maths

export const clampFocal = (mm) => clamp(+mm || 35, FOCAL_MIN, FOCAL_MAX);
export const clampFocus = (m) => clamp(+m || 3, FOCUS_MIN, FOCUS_INF);
export const clampStop = (n) => clamp(+n || 2.8, STOP_MIN, STOP_MAX);

/** The prime closest to mm (in log space, like the lens cards). */
export function nearestPrime(mm, list = PRIMES) {
  return list.reduce((a, b) => (Math.abs(Math.log(b / mm)) < Math.abs(Math.log(a / mm)) ? b : a), list[0]);
}

/** Pinch: the focal length scales with the finger spread (spread 2x = twice the focal length). */
export const pinchFocal = (f0, d0, d) => clampFocal(f0 * (Math.max(1, d) / Math.max(1, d0)));

/** Zoom rocker held for dt seconds: dir +1 = tele, -1 = wide; speed in e-folds per second (0.7 = about 2x in 1 s). */
export const rockerFocal = (f, dir, dt, speed = 0.7) => clampFocal(f * Math.exp(dir * speed * dt));

/** Frame-rate independent exponential approach (tau seconds). log=true smooths ratios (focal, focus, stops). */
export function approach(x, target, dt, tau, log = false) {
  if (!(tau > 0) || !Number.isFinite(x)) return target;
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  if (log && x > 0 && target > 0) return x * Math.pow(target / x, k);
  return x + (target - x) * k;
}

/**
 * Focus ring 0..1 <-> distance: 0 = 0.3 m, 1 = infinity. In diopters (1/m) like a real ring, with the close end opened up
 * (diopters = (1 - u)^2 / 0.3) so a thumb can land 1 m, 2 m and 5 m: they sit at about 0.45, 0.61 and 0.76.
 */
export const ringToFocus = (u) => { const d = (1 - clamp(u, 0, 1)) ** 2 / FOCUS_MIN; return d <= 1 / FOCUS_INF ? FOCUS_INF : 1 / d; };
export const focusToRing = (m) => clamp(1 - Math.sqrt(FOCUS_MIN / clampFocus(m)), 0, 1);
/** Marks drawn on the focus ring. */
export const FOCUS_MARKS = [0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5, 10, FOCUS_INF];

/** T-stop slider 0..1 <-> T-number, in stops (T1.4 .. T22 is 8 stops), snapped to thirds. */
export const STOP_SPAN = Math.log2((STOP_MAX / STOP_MIN) ** 2);    // 8 stops
export function sliderToStop(u) {
  const s = Math.round(clamp(u, 0, 1) * STOP_SPAN * 3) / 3;
  return snapStop(Math.SQRT2 * Math.pow(2, s / 2));      // exact powers of sqrt(2): T1.4 is really 1.414, T2.8 is 2.83
}
export const stopToSlider = (n) => clamp(Math.log2((clampStop(n) / Math.SQRT2) ** 2) / STOP_SPAN, 0, 1);
/** Engraved values read better than 2.83: a value within 3% of a full stop takes its name. */
export function snapStop(n) {
  const full = FULL_STOPS.find((f) => Math.abs(f / n - 1) < 0.03);
  return full ?? Math.round(n * 10) / 10;
}

export const fmtStop = (n) => `T${snapStop(n)}`;
export function fmtFocus(m) {
  if (!(m > 0) || m >= 200) return "∞";
  if (m < 1) return `${Math.round(m * 100)} cm`;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
}

/** Depth of field for focal f (mm), T-stop N, focus s (m): {near, far, hyper} in metres (far = Infinity past hyperfocal). */
export function dofLimits(f, N, s, coc = COC_MM) {
  const fm = f / 1000, H = (fm * fm) / (N * coc / 1000) + fm;
  const near = (s * (H - fm)) / (H + s - 2 * fm);
  const far = s >= H ? Infinity : (s * (H - fm)) / (H - s);
  return { near, far, hyper: H };
}

/**
 * Blur circle (pixels across a frame frameW px wide) of a point at distance d (m) when focused at s (m).
 * Thin lens: c = f^2 / (N (s - f)) * |d - s| / d on the sensor, scaled from the 36 mm sensor to the frame.
 */
export function cocPx(f, N, s, d, frameW) {
  const fm = f / 1000;
  if (!(d > 0) || s <= fm) return 0;
  const cMm = ((f * f) / (N * (s * 1000 - f))) * Math.abs(d - s) / d;
  return (cMm / SENSOR_W_MM) * frameW;
}
/** The constant K of cocPx for a shader: coc(d) = K * |d - s| / d. */
export const cocScale = (f, N, s, frameW) => (s * 1000 <= f ? 0 : ((f * f) / (N * (s * 1000 - f)) / SENSOR_W_MM) * frameW);

/** Horizontal angle of view of a focal length on the 36 mm sensor (degrees). */
export const hfovOf = (mm) => 2 * Math.atan(SENSOR_W_MM / 2 / mm) / DEG;
/** Vertical field of view of the delivery frame (same formula as the stage's vfovFromFocal). */
export const vfovOf = (mm, aspect) => 2 * Math.atan(SENSOR_W_MM / aspect / (2 * mm)) / DEG;

// ---------------------------------------------------------------- framing

/**
 * Fit the delivery frame (aspect) inside a sw x sh screen and give the vertical FOV to render the screen with,
 * so the frame area shows exactly what the shot camera sees and the rest is the surround (like a cine viewfinder).
 * `fill` (0..1) is how much of the tight screen dimension the frame takes.
 */
export function viewRect(sw, sh, aspect, focal, fill = 1) {
  const sa = sw / sh;
  let w, h;
  if (sa >= aspect) { h = sh * fill; w = h * aspect; } else { w = sw * fill; h = w / aspect; }
  const vf = vfovOf(focal, aspect) * DEG;
  const vfov = (2 * Math.atan(Math.tan(vf / 2) * (sh / h))) / DEG;
  return { vfov, aspect: sa, rect: { x: (sw - w) / 2, y: (sh - h) / 2, w, h } };
}

/** The largest rect of `aspect` centred inside rect r (frame lines for another delivery ratio). */
export function innerAspect(r, aspect) {
  let w = r.w, h = r.w / aspect;
  if (h > r.h) { h = r.h; w = h * aspect; }
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** SMPTE-style timecode for a frame count: HH:MM:SS:FF. */
export function timecode(frames, fps = 24) {
  const f = Math.max(0, Math.floor(frames)), r = Math.round(fps);
  const s = Math.floor(f / r), ff = f % r;
  const p = (x) => String(x).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

// ---------------------------------------------------------------- orientation

export const qaxis = (axis, deg) => { const h = (deg * DEG) / 2, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; };
export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qn = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };

/** Euler (radians, three.js order 'YXZ') -> quaternion. */
function quatYXZ(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
}

/**
 * DeviceOrientation (alpha, beta, gamma in degrees) + screen angle (0 portrait, 90 / -90 landscape) -> the quaternion of a
 * camera looking out of the phone's back, Y up (the maths of three.js DeviceOrientationControls).
 */
export function gyroQuat(alpha, beta, gamma, screenAngle = 0) {
  let q = quatYXZ((beta || 0) * DEG, (alpha || 0) * DEG, -(gamma || 0) * DEG);
  q = qmul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);      // the camera looks out of the back, not the top
  q = qmul(q, qaxis([0, 0, 1], -(screenAngle || 0)));     // the screen's rotation
  return qn(q);
}

/** Camera quaternion from yaw (0 = looking -Z, + = turning left) and pitch (+ = up), no roll. */
export const quatYawPitch = (yaw, pitch) => qmul(qaxis([0, 1, 0], yaw), qaxis([1, 0, 0], pitch));

/** Roll (radians, the stage's c.roll: camera.lookAt(target) then rotateZ(roll)) of a camera quaternion. */
export function rollRad(q) {
  const level = qlookZeroRoll(forwardOf(q));
  if (!level) return 0;
  const r = qmul(qconj(level), q);
  let a = 2 * Math.atan2(r[2], r[3]);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** {yaw, pitch} of a stage camera {position, target}. */
export function camAngles(cam) {
  const d = [0, 1, 2].map((k) => cam.target[k] - cam.position[k]);
  const l = Math.hypot(...d) || 1;
  return { yaw: Math.atan2(-d[0], -d[2]) / DEG, pitch: Math.asin(clamp(d[1] / l, -1, 1)) / DEG };
}

// ---------------------------------------------------------------- the rig: phone -> shot camera

/**
 * Turns phone input into the shot camera on the set.
 *  - anchor: where the shot camera is (re-centre puts the view back there).
 *  - gyro: the phone's orientation. Heading is relative (the phone's heading at re-centre = the shot camera's heading);
 *    tilt and roll are absolute, so a level phone is a level camera.
 *  - drag: pan / tilt trim with a finger (the only way to look around without motion sensors).
 *  - stick: walk (truck / dolly along the camera's heading), rise: crane up / down. Velocity is eased, never jerky.
 *  - xr: a WebXR viewer pose (6-DoF): hand-space position since re-centre, times `scale`.
 */
export class VfRig {
  constructor({ speed = 1.2, scale = 1 } = {}) {
    this.speed = speed;
    this.scale = scale;
    this.level = true;
    this.recenter({ position: [0, 1.6, 6], target: [0, 1.4, 0] });
  }

  recenter(cam) {
    const a = camAngles(cam);
    this.anchor = { position: [...cam.position], yaw: a.yaw, pitch: a.pitch };
    this.offset = [0, 0, 0];
    this.vel = [0, 0, 0];
    this.yawTrim = 0;
    this.pitchTrim = 0;
    this.gyroRef = null;
    this.xrRef = null;
  }

  /** Drag in degrees (from a finger). */
  look(dYaw, dPitch) {
    this.yawTrim += dYaw;
    this.pitchTrim = clamp(this.pitchTrim + dPitch, -89 - this.anchor.pitch, 89 - this.anchor.pitch);
  }

  /** One step. input: {gyro?: quat, stick?: [x, y] (-1..1, y up = forward), rise?: -1..1, xr?: {position, quaternion}}. */
  step(dt, input = {}) {
    let q;
    if (input.xr) {
      if (!this.xrRef) this.xrRef = { position: [...input.xr.position], yaw: eulerOf(input.xr.quaternion).yaw };
      const yq = qaxis([0, 1, 0], this.anchor.yaw - this.xrRef.yaw + this.yawTrim);
      q = qmul(yq, input.xr.quaternion);
      const rel = input.xr.position.map((v, k) => (v - this.xrRef.position[k]) * this.scale);
      const off = qrotate(yq, rel);
      this.handOffset = off;
    } else if (input.gyro) {
      const e = eulerOf(input.gyro);
      if (this.gyroRef === null) this.gyroRef = e.yaw;
      q = qmul(qaxis([0, 1, 0], this.anchor.yaw - this.gyroRef + this.yawTrim), input.gyro);
      if (this.pitchTrim) q = qmul(q, qaxis([1, 0, 0], this.pitchTrim));
      this.handOffset = null;
    } else {
      q = quatYawPitch(this.anchor.yaw + this.yawTrim, this.anchor.pitch + this.pitchTrim);
      this.handOffset = null;
    }
    if (this.level) q = qlookZeroRoll(forwardOf(q)) || q;
    q = qn(q);
    // Walk / crane: the stick moves along the camera's heading (flattened), eased so starts and stops are smooth.
    const [sx, sy] = input.stick || [0, 0];
    const yaw = eulerOf(q).yaw * DEG;
    const fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)], right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const want = [0, 1, 2].map((k) => (right[k] * sx + fwd[k] * sy) * this.speed + (k === 1 ? (input.rise || 0) * this.speed * 0.6 : 0));
    this.vel = this.vel.map((v, k) => approach(v, want[k], dt, 0.18));
    this.offset = this.offset.map((v, k) => v + this.vel[k] * dt);
    const position = this.anchor.position.map((v, k) => v + this.offset[k] + (this.handOffset ? this.handOffset[k] : 0));
    const f = forwardOf(q);
    return { position, quaternion: q, target: position.map((v, k) => v + f[k] * 5), roll: this.level ? 0 : rollRad(q) };
  }
}

// ---------------------------------------------------------------- recording

/** Collects the viewfinder's camera every rendered frame while REC is on: set-space samples for a take. */
export class TakeRecorder {
  constructor() { this.samples = []; this.on = false; }
  start(t, frame0 = 0, fps = 24) { this.samples = []; this.on = true; this.t0 = t; this.frame0 = frame0; this.fps = fps; }
  /** Seconds since start and the stage frame they map to. */
  clock(t) { const s = Math.max(0, t - this.t0); return { s, frame: this.frame0 + s * this.fps }; }
  add(t, cam) {
    if (!this.on) return;
    const s = t - this.t0;
    if (this.samples.length && s <= this.samples[this.samples.length - 1].t) return;
    this.samples.push({ t: Math.round(s * 1e5) / 1e5, position: cam.position.map((v) => +v.toFixed(5)), quaternion: cam.quaternion.map((v) => +v.toFixed(6)),
      focal_mm: +cam.focal_mm.toFixed(3), focus_m: +clampFocus(cam.focus_m).toFixed(4), t_stop: +clampStop(cam.t_stop).toFixed(3) });
  }
  stop() { this.on = false; return this.samples; }
  get seconds() { return this.samples.length ? this.samples[this.samples.length - 1].t : 0; }
}

/** Light filtering by default; "Stabilize" on = a gimbal. */
export const SMOOTH_LIGHT = 0.25, SMOOTH_STABILIZE = 0.75;

/** Sample a channel at time t (linear between samples). */
function channelAt(samples, field, t) {
  if (!samples.length) return undefined;
  if (t <= samples[0].t) return samples[0][field];
  const n = samples.length - 1;
  if (t >= samples[n].t) return samples[n][field];
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].t <= t) lo = m; else hi = m; }
  const a = samples[lo], b = samples[hi], u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return a[field] + (b[field] - a[field]) * u;
}

/** Zero-phase Gaussian smoothing of a per-frame series (sigma in frames); log=true for ratios. */
function smoothSeries(v, sigma, log = false) {
  if (!(sigma > 0.3) || v.length < 3) return v.slice();
  const x = log ? v.map(Math.log) : v, r = Math.ceil(sigma * 3), out = [];
  for (let i = 0; i < x.length; i++) {
    let s = 0, w = 0;
    for (let k = -r; k <= r; k++) {
      const j = clamp(i + k, 0, x.length - 1), g = Math.exp(-(k * k) / (2 * sigma * sigma));
      s += x[j] * g; w += g;
    }
    out.push(log ? Math.exp(s / w) : s / w);
  }
  return out;
}

/**
 * The stage's playback of the lens channels between lens keys (Stage._cameraAt mirrors this): focus eases in diopters (a pull
 * on a ring), T-stop in stops, roll linearly, all with the same smoothstep the stage uses for the focal length.
 */
export function lensAt(keys, frame) {
  const n = keys.length - 1;
  let i = 0, j = 0, u = 0;
  if (n > 0 && frame > keys[0].frame) {
    if (frame >= keys[n].frame) { i = j = n; }
    else { while (keys[i + 1].frame < frame) i++; j = i + 1; u = (frame - keys[i].frame) / Math.max(1e-6, keys[j].frame - keys[i].frame); }
  }
  const e = i === j ? 0 : u * u * (3 - 2 * u), a = keys[i], b = keys[j], out = {};
  if (a.focus_m > 0 && b.focus_m > 0) out.focus_m = 1 / (1 / a.focus_m + (1 / b.focus_m - 1 / a.focus_m) * e);
  if (a.t_stop > 0 && b.t_stop > 0) out.t_stop = a.t_stop * Math.pow(b.t_stop / a.t_stop, e);
  if (Number.isFinite(a.roll) || Number.isFinite(b.roll)) out.roll = (a.roll || 0) + ((b.roll || 0) - (a.roll || 0)) * e;
  return out;
}

/** How far lens keys play back from the recorded lens at one frame (1 = at tolerance). */
function lensErr(keys, fr, tol) {
  const l = lensAt(keys, fr.frame);
  let e = 0;
  if (l.focus_m) e = Math.max(e, Math.abs(1 / l.focus_m - 1 / fr.focus_m) / tol.diopters);
  if (l.t_stop) e = Math.max(e, Math.abs(Math.log2(l.t_stop / fr.t_stop)) / tol.stops);
  if (fr.roll !== undefined) e = Math.max(e, Math.abs((l.roll || 0) - fr.roll) / tol.roll);
  return e;
}

/**
 * The lens channels of a take as their own keys (a shot's `lens_keys`, played by Stage._cameraAt): focus distance, T-stop
 * and roll. They are separate from the camera's position keys on purpose: a focus pull or an iris change lands exactly
 * where it happened without adding position keys (uneven position keys would kink the move's Catmull-Rom path).
 * Greedy: start from the first and last frame, add a key at the worst frame until everything plays back within tolerance.
 */
export function reduceLensKeys(frames, { diopters = 0.03, stops = 1 / 6, roll = 0.4 * DEG, maxKeys = 64 } = {}) {
  if (!frames.length) return [];
  const tol = { diopters, stops, roll };
  const key = (f) => {
    const k = { frame: f.frame, focus_m: +f.focus_m.toFixed(4), t_stop: +f.t_stop.toFixed(3) };
    if (f.roll !== undefined) k.roll = +f.roll.toFixed(5);
    return k;
  };
  const ks = [key(frames[0])];
  if (frames.length > 1) ks.push(key(frames[frames.length - 1]));
  while (ks.length < maxKeys) {
    let worst = 1, at = null;
    for (const fr of frames) { const e = lensErr(ks, fr, tol); if (e > worst) { worst = e; at = fr; } }
    if (!at || ks.some((k) => k.frame === at.frame)) break;
    ks.push(key(at));
    ks.sort((a, b) => a.frame - b.frame);
  }
  return ks;
}

/**
 * A recorded viewfinder take -> stage camera keys.
 * take: {samples: [{t, position, quaternion, focal_mm, focus_m, t_stop}], settings: {startFrame, fps, stabilize, horizonLock, lastFrame?}}
 * (set space: the phone already placed the camera). Position / rotation / focal length go through the stabilizer (light
 * filtering, or a gimbal with "Stabilize" on) and its key reducer; focus, T-stop and roll get a light zero-phase smooth
 * and their own keys (lensKeys, for the shot's lens_keys). Returns {keys, lensKeys, frames, info}.
 */
export function takeToKeys(take, opts = {}) {
  const st = { ...(take.settings || {}), ...opts };
  const fps = st.fps || 24, startFrame = Math.round(st.startFrame || 0);
  const strength = st.strength ?? (st.stabilize ? SMOOTH_STABILIZE : SMOOTH_LIGHT);
  const samples = take.samples || [];
  const res = stabilize(samples, { strength, horizonLock: !!st.horizonLock, fps, startFrame, scale: 1, anchor: null, focusDistance: 5, keyTolerance: 0.012 });
  let frames = res.frames;
  if (Number.isFinite(st.lastFrame)) frames = frames.filter((f) => f.frame <= st.lastFrame);
  if (!frames.length) return { keys: [], frames: [], info: { ...res.info, keys: 0 } };
  const t0 = samples.length ? Math.min(...samples.map((s) => s.t)) : 0;
  const sig = Math.max(0.6, fps * 0.04);
  const focus = smoothSeries(frames.map((f) => 1 / clampFocus(channelAt(samples, "focus_m", t0 + f.t) ?? 3)), sig);   // in diopters
  const stopsS = smoothSeries(frames.map((f) => clampStop(channelAt(samples, "t_stop", t0 + f.t) ?? 2.8)), sig, true);
  const rolls = frames.map((f) => (st.horizonLock ? 0 : rollRad(f.quaternion)));
  const rolled = rolls.some((r) => Math.abs(r) > 0.2 * DEG);
  frames.forEach((f, i) => {
    f.focus_m = clampFocus(1 / Math.max(1 / FOCUS_INF, focus[i]));
    f.t_stop = stopsS[i];
    if (rolled) f.roll = rolls[i];
  });
  let keys = res.keys.filter((k) => frames.some((f) => f.frame === k.frame));
  if (keys.length < 2 && frames.length >= 2) keys = [frames[0], frames[frames.length - 1]].map((f) => ({ frame: f.frame, position: f.position, target: f.target, focal_mm: f.focal_mm }));
  const lensKeys = reduceLensKeys(frames);
  return { keys, lensKeys, frames, info: { ...res.info, keys: keys.length, lensKeys: lensKeys.length, frames: frames.length, startFrame, fps, strength, seconds: +(frames.length / fps).toFixed(2) } };
}

// ---------------------------------------------------------------- protocol

export const VF_EVENT = "soundstage.vcam";   // what the desktop listens to (api.addEventListener)

/** Phone -> server: the live viewfinder camera (set space), ~30 Hz. */
export function vfMessage(cam, { frame = 0, recording = false, t = 0, view = "clay" } = {}) {
  const r = (v, d = 4) => +(+v).toFixed(d);
  return { type: "vf", t: r(t, 3), frame: r(frame, 2), recording: !!recording, view,
    cam: { position: cam.position.map((v) => r(v)), target: cam.target.map((v) => r(v)), focal_mm: r(cam.focal_mm, 2),
      focus_m: r(cam.focus_m, 3), t_stop: r(cam.t_stop, 2), roll: r(cam.roll || 0, 5) } };
}

/** Phone -> server: an event (hello, record, stop, keep, discard, bye). */
export const vfState = (event, data = {}) => ({ type: "vfstate", event, data });

/** The scene without its camera keys: when only this changes, the phone rebuilds its set; camera edits are patched in. */
export function sceneSig(scene) {
  if (!scene) return "";
  const s = { ...scene, camera: undefined, camera_end: undefined, camera_keys: undefined, camera_track: undefined,
    shots: (scene.shots || []).map((sh) => ({ ...sh, camera_keys: undefined, lens_keys: undefined, rig: undefined })) };
  return JSON.stringify(s);
}

/** Copy the shots' camera keys / rigs / active shot of `scene` into a stage state already showing the same set. */
export function patchCameras(state, scene) {
  for (const k of ["camera", "camera_end", "camera_keys", "active_shot"]) if (scene[k] !== undefined) state[k] = JSON.parse(JSON.stringify(scene[k]));
  const byId = new Map((scene.shots || []).map((s) => [s.id, s]));
  if (Array.isArray(state.shots)) for (const sh of state.shots) {
    const src = byId.get(sh.id);
    if (!src) continue;
    sh.camera_keys = JSON.parse(JSON.stringify(src.camera_keys || []));
    for (const k of ["rig", "lens_keys"]) if (src[k] !== undefined) sh[k] = JSON.parse(JSON.stringify(src[k])); else delete sh[k];
  }
  return state;
}

/** Validate a server -> phone message; returns it, or null. */
export function parseServer(raw) {
  let m = raw;
  if (typeof raw === "string") { try { m = JSON.parse(raw); } catch { return null; } }
  if (!m || typeof m !== "object" || typeof m.type !== "string") return null;
  if (m.type === "scene" && (typeof m.scene !== "object" || !m.scene)) return null;
  if (m.type === "sync" && m.frame !== undefined && !Number.isFinite(+m.frame)) return null;
  return ["hello", "pong", "scene", "sync"].includes(m.type) ? m : null;
}

/** The phone-facing URL of the viewfinder for the QR code (a registered LAN bridge wins over this page's own origin). */
export function viewfinderUrl(origin, pair = null) {
  if (pair?.url && /^https?:\/\//.test(pair.url)) return pair.url;
  return `${String(origin).replace(/\/$/, "")}/soundstage/vcam/viewfinder`;
}

/** Is a URL one a phone can't open (this computer's loopback)? */
export const isLoopback = (url) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:|\/|$)/i.test(String(url));
