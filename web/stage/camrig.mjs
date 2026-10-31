// Camera rigs: the shot's keys say where the camera should be; the rig says how a real camera support gets there.
// A dolly sits on a straight track, takes a moment to push off, overshoots and settles when it stops and rumbles a
// little over the rail joints; a slider is a short, smooth dolly; a jib swings on an arm around its post and sways when
// it stops; a tripod only pans and tilts on a fluid head; a Steadicam floats and bobs with the operator's steps;
// handheld breathes, shakes and corrects late; a drone banks into turns. Everything is deterministic per frame (seeded
// noise), so the clay previz, the first frame and the video model all see the same camera.

export const RIGS = {
  free: { label: "Free (keys as set)" },
  tripod: { label: "Tripod (pan / tilt)" },
  dolly: { label: "Dolly on track" },
  chapman: { label: "Chapman dolly (track + boom)" },
  slider: { label: "Slider" },
  jib: { label: "Jib / crane arm" },
  steadicam: { label: "Steadicam" },
  handheld: { label: "Handheld" },
  drone: { label: "Drone" },
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));

// Smooth value noise (deterministic): sum of a few sines with seeded phases, good enough for camera shake.
function noise(seed, t) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < 3; o++) {
    const ph = Math.sin(seed * 12.9898 + o * 78.233) * 43758.5453;
    v += amp * Math.sin(t * f * 2 * Math.PI + (ph - Math.floor(ph)) * 6.283);
    norm += amp; amp *= 0.5; f *= 2.13;
  }
  return v / norm;
}

/**
 * Follow a keyed signal x[f] like a mass on a spring (critically under-damped): it lags at the start (inertia),
 * overshoots slightly and settles at the stop. omega = stiffness (rad/s), zeta = damping (1 = no overshoot).
 */
export function springFollow(xs, fps, omega, zeta) {
  const dt = 1 / fps, out = new Array(xs.length);
  let x = xs[0].slice(), v = [0, 0, 0];
  const sub_steps = 4, h = dt / sub_steps;
  for (let f = 0; f < xs.length; f++) {
    for (let s = 0; s < sub_steps; s++) {
      const a = sub(mul(sub(xs[f], x), omega * omega), mul(v, 2 * zeta * omega));
      v = add(v, mul(a, h));
      x = add(x, mul(v, h));
    }
    out[f] = x.slice();
  }
  return out;
}

/**
 * Apply a rig to a sampled camera path. path: [{position, target, focal_mm}] for every frame of the shot (keys only,
 * no rig). rig: {type, amount (0..2, default 1)}. Returns the same shape plus roll (radians).
 */
export function applyRig(path, rig, fps = 24) {
  const type = rig?.type || "free";
  if (type === "free" || !path.length) return path;
  const k = rig.amount ?? 1;
  const n = path.length;
  const P = path.map((c) => c.position), T = path.map((c) => c.target);
  let pos = P.map((p) => p.slice()), tgt = T.map((t) => t.slice());
  const roll = new Array(n).fill(0);
  const t = (f) => f / fps;
  const seed = (rig.seed ?? 7) + type.length;

  if (type === "tripod") {
    // Locked off: the head stays put; pan / tilt through a fluid head (eased, a hair of settle).
    pos = P.map(() => P[0].slice());
    tgt = springFollow(T, fps, 6, 0.85);
  } else if (type === "dolly" || type === "chapman" || type === "slider") {
    // On a straight track from the first mark toward the last: project the path onto that line.
    const a = P[0], b = P[n - 1];
    let dir = sub(b, a); dir[1] = type === "chapman" ? dir[1] : 0;
    const L = len(dir) || 1; dir = mul(dir, 1 / L);
    const maxRun = type === "slider" ? 1.2 : Infinity;
    const onTrack = P.map((p) => {
      const s = Math.max(0, Math.min(Math.min(L, maxRun), dot(sub(p, a), dir)));
      const q = add(a, mul(dir, s));
      if (type === "chapman") q[1] = p[1];          // the Chapman's boom arm lifts / lowers the camera
      else q[1] = a[1];
      return q;
    });
    // Grips push a few hundred kilos: slow to start, a little overshoot and settle at the mark.
    const omega = type === "slider" ? 7 : 4.2, zeta = type === "slider" ? 0.8 : 0.62;
    pos = springFollow(onTrack, fps, omega, zeta);
    tgt = springFollow(T, fps, omega * 1.4, 0.75);
    // Rumble: rail joints every ~1.2 m on a track, tiny on a slider; only while moving.
    for (let f = 1; f < n; f++) {
      const speed = len(sub(pos[f], pos[f - 1])) * fps;
      const travelled = dot(sub(pos[f], a), dir);
      const jd = (((travelled % 1.2) + 1.2) % 1.2) - 0.6;
      const joint = type === "slider" ? 0 : Math.exp(-(jd * jd) / 0.004) * 0.004;
      const rumble = Math.min(1, speed / 0.8) * (type === "slider" ? 0.0006 : 0.0018);
      const j = (noise(seed, t(f) * 9) * rumble + joint * Math.min(1, speed)) * k;
      pos[f] = add(pos[f], [0, j, 0]);
      tgt[f] = add(tgt[f], [0, j * 1.6, 0]);
    }
  } else if (type === "jib") {
    // A camera on an arm: the post stands behind the first mark; the camera moves on a sphere around the post's
    // pivot, so moves arc (rise and swing) instead of sliding. Heavy arm: lag + slow sway at the stop.
    const arm = Math.max(2.5, len(sub(P[n - 1], P[0])) * 0.9);
    const fwd0 = sub(T[0], P[0]); fwd0[1] = 0;
    const fl = len(fwd0) || 1;
    const pivot = add(P[0], [-fwd0[0] / fl * arm * 0.6, -0.4, -fwd0[2] / fl * arm * 0.6]);
    const onArm = P.map((p) => { const d = sub(p, pivot); return add(pivot, mul(d, arm / (len(d) || 1))); });
    pos = springFollow(onArm, fps, 3.2, 0.55);
    tgt = springFollow(T, fps, 4.0, 0.7);
  } else if (type === "steadicam") {
    pos = springFollow(P, fps, 3.0, 0.9);
    tgt = springFollow(T, fps, 2.6, 0.9);
    for (let f = 0; f < n; f++) {
      const moving = f ? Math.min(1, len(sub(P[f], P[f - 1])) * fps / 1.2) : 0;
      const bob = Math.abs(Math.sin(t(f) * Math.PI * 1.8)) * 0.012 * moving;      // operator's steps
      const drift = [noise(seed, t(f) * 0.3) * 0.02, noise(seed + 1, t(f) * 0.25) * 0.012, noise(seed + 2, t(f) * 0.3) * 0.02];
      pos[f] = add(pos[f], mul(add(drift, [0, bob, 0]), k));
      roll[f] = noise(seed + 3, t(f) * 0.2) * 0.012 * k;
    }
  } else if (type === "handheld") {
    // The operator reframes late (the frame lags the action), breathes, shakes, and steps when walking.
    pos = springFollow(P, fps, 5.5, 0.7);
    tgt = springFollow(T, fps, 4.5, 0.6);
    for (let f = 0; f < n; f++) {
      const moving = f ? Math.min(1, len(sub(P[f], P[f - 1])) * fps / 1.0) : 0;
      const breath = [noise(seed, t(f) * 0.22) * 0.01, Math.sin(t(f) * 2 * Math.PI * 0.25) * 0.008, noise(seed + 1, t(f) * 0.2) * 0.01];
      const shake = [noise(seed + 2, t(f) * 6) * 0.0035, noise(seed + 3, t(f) * 7) * 0.0035, noise(seed + 4, t(f) * 5) * 0.003];
      const step = [0, -Math.abs(Math.sin(t(f) * Math.PI * 1.9)) * 0.025 * moving, 0];
      pos[f] = add(pos[f], mul(add(add(breath, shake), step), k));
      // The aim wanders more than the body: small pan/tilt errors at the target distance.
      const d = len(sub(tgt[f], pos[f]));
      const aim = [noise(seed + 5, t(f) * 0.6) * 0.012 * d, noise(seed + 6, t(f) * 0.5) * 0.009 * d, 0];
      const jitter = [noise(seed + 7, t(f) * 8) * 0.0025 * d, noise(seed + 8, t(f) * 9) * 0.0025 * d, 0];
      tgt[f] = add(tgt[f], mul(add(aim, jitter), k));
      roll[f] = (noise(seed + 9, t(f) * 0.4) * 0.02 + noise(seed + 10, t(f) * 6) * 0.004) * k;
    }
  } else if (type === "drone") {
    pos = springFollow(P, fps, 2.4, 0.95);
    tgt = springFollow(T, fps, 2.4, 0.95);
    for (let f = 1; f < n - 1; f++) {
      // Bank into turns: roll with the sideways acceleration of the flight path.
      const v0 = sub(pos[f], pos[f - 1]), v1 = sub(pos[f + 1], pos[f]);
      const turn = v0[0] * v1[2] - v0[2] * v1[0];
      roll[f] = Math.max(-0.25, Math.min(0.25, -turn * fps * fps * 0.6)) * k;
      pos[f] = add(pos[f], mul([noise(seed, t(f) * 0.5) * 0.015, noise(seed + 1, t(f) * 0.4) * 0.01, 0], k));
    }
  }
  return path.map((c, f) => ({ ...c, position: pos[f], target: tgt[f], roll: roll[f] }));
}
