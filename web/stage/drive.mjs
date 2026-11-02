// Drive mode (Milestone 29): control any object like a video game, and record it as animation.
//
// Select an object and press D (or 🎮 Drive on its bar or in Parts). From then on the keyboard, the mouse and any
// game controller (the Gamepad API: Xbox, PlayStation, Switch Pro) drive it:
//   people   third-person: move relative to the camera, stick deflection sets the speed and the speed picks the gait
//            (walk, jog, run: gait.mjs plans the footsteps live), turn, stop, jump, climb onto a box; E gets into the
//            nearest car (the driver's door opens, they climb in and control passes to the car), mounts a horse or a
//            bike, sits on a bench; C picks up a prop, F throws it (hold the right mouse button or LT to aim), X drops
//            it, C again sets it down. Gaze follows the camera (look at someone and they look back at them).
//   vehicles the real car (vehsim.mjs LiveCar: Pacejka tyres, weight transfer, the sprung body): throttle, brake,
//            steering and handbrake by hand, so J-turns and drifts are driven, not keyed. Bikes lean, boats glide.
//   horses   ridden or loose: the speed picks walk, trot, canter and gallop with planted hooves.
//   props    fly them (Q / E or Space down / up) or nudge them.
// The camera chases the controlled object (or holds the shot camera, or orbits), and switches smoothly when control
// passes from a person to the car they got into.
//
// ● REC records a take with a 3-2-1 countdown: the timeline plays (everything already animated plays back) while you
// drive, and every object you touched gets ordinary keys on the current shot: position and heading (people, horses,
// vehicles, props), a car's body roll, pitch and steering, gaze keys, part toggles (lights, doors), mount spans (in
// and out of cars and saddles, with the door opening), and a thrown prop's whole flight as a baked track. Takes layer
// like Sequencer's Take Recorder: drive A, rewind, drive B while A plays back. Keep / Discard / Again, one undo step
// per kept take, and a choice of smoothing. Nothing changes the shot until you keep a take.
//
// Everything that decides behaviour is a pure function here (input mapping, speed from the stick, the person, horse,
// bike and prop steps, the projectile, take -> keys), so the tests drive it without a browser.
import * as THREE from "../vendor/three.module.min.mjs";
import * as Gait from "./gait.mjs";
import { LiveCar, carParams } from "./vehsim.mjs";
import { applyPose, MOUNTS } from "./humans.mjs";
import { SEATS, LIBRARY } from "./library.mjs";
import { writeKey } from "./objparts.mjs";
import { setGazeKey } from "./gaze.mjs";

const DEG = Math.PI / 180;
const G = 9.81;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
const sstep = (t) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Frames the stage's own timed mount takes (stage.mjs HOP_FRAMES / Gait.MOUNT_FRAMES): the live climb-in matches it. */
export const HOP_FRAMES = 10;
export const hopFrames = (hostKind, pose) => (hostKind === "horse" && (pose || MOUNTS.horse.pose) === "ride" ? Gait.MOUNT_FRAMES : HOP_FRAMES);
/** Frames getting out (or down) takes, and the door's lead before it. */
export const exitFrames = (hostKind) => (hostKind === "horse" ? 20 : SEATS[hostKind] ? 14 : 10);
export const DOOR_LEAD = 6;
export const JUMP_H = 0.55;           // m: a standing jump clears a kerb, a running one a low crate
export const STEP_UP = 0.45;          // m: walked up onto without a jump
export const CLIMB_MAX = 1.75;        // m: the highest box a person climbs onto (jump next to it)
export const SIM_HZ = 60;
const CAR_SIM = new Set(["car", "police_car", "sports_car", "hatchback", "truck", "van", "bus", "taxi"]);
const BIKES = new Set(["bicycle", "motorcycle"]);

// ------------------------------------------------------------------ what drives how

/** How an object is driven: "person" | "horse" | "animal" | "car" | "bike" | "boat" | "prop", or null (not drivable). */
export function driveKind(a, K = {}) {
  if (!a) return null;
  const L = LIBRARY[a.kind] || {};
  const persons = K.PERSON_KINDS || new Set(["man", "woman", "child"]);
  if (a.set_xform || a.kind === "building" || a.kind === "card" || a.kind === "custom_set") return null;
  if (persons.has(a.kind)) return "person";
  if (a.kind === "horse") return "horse";
  if (L.rig === "quadruped") return "animal";
  if (L.rig === "vehicle") {
    if (L.boat) return "boat";
    if (BIKES.has(a.kind)) return "bike";
    if (L.flies || a.kind === "train") return "prop";
    return "car";
  }
  if (L.rig === "static" && (L.height || 0) > 3) return null;   // whole buildings and big set dressing stay put
  return "prop";
}

// ------------------------------------------------------------------ input

/** Every action, its label for the bindings sheet, and the default keys (KeyboardEvent.code) and pad buttons. */
export const ACTIONS = [
  { id: "forward", label: "Forward / throttle", keys: ["KeyW", "ArrowUp"], pad: [] },
  { id: "back", label: "Back / brake, reverse", keys: ["KeyS", "ArrowDown"], pad: [] },
  { id: "left", label: "Left / steer left", keys: ["KeyA", "ArrowLeft"], pad: [] },
  { id: "right", label: "Right / steer right", keys: ["KeyD", "ArrowRight"], pad: [] },
  { id: "sprint", label: "Run / gallop / boost", keys: ["ShiftLeft", "ShiftRight"], pad: [10, 4] },
  { id: "jump", label: "Jump · climb (on foot) · rise (props)", keys: ["Space"], pad: [0] },
  { id: "handbrake", label: "Handbrake", keys: ["Space"], pad: [0, 5] },
  { id: "throttle", label: "Throttle (analog)", keys: [], pad: [7] },
  { id: "brake", label: "Brake / reverse (analog)", keys: [], pad: [6] },
  { id: "interact", label: "Get in / out · mount · sit", keys: ["KeyE"], pad: [3] },
  { id: "pickup", label: "Pick up / set down", keys: ["KeyC"], pad: [2] },
  { id: "throw", label: "Throw what you carry", keys: ["KeyF"], pad: [7] },
  { id: "aim", label: "Aim a throw (hold)", keys: [], pad: [6] },
  { id: "drop", label: "Drop what you carry · sink (props)", keys: ["KeyX"], pad: [1] },
  { id: "descend", label: "Sink (props)", keys: ["KeyQ"], pad: [1] },
  { id: "turnLeft", label: "Turn left (props)", keys: ["KeyZ"], pad: [4] },
  { id: "turnRight", label: "Turn right (props)", keys: ["KeyX"], pad: [5] },
  { id: "lights", label: "Headlights", keys: ["KeyL"], pad: [12] },
  { id: "indicator", label: "Indicators", keys: ["KeyI"], pad: [14] },
  { id: "door", label: "Driver's door", keys: ["KeyO"], pad: [13] },
  { id: "lightbar", label: "Police light bar", keys: ["KeyB"], pad: [15] },
  { id: "camera", label: "Camera: chase · shot · orbit", keys: ["KeyV"], pad: [8] },
  { id: "record", label: "● REC / stop", keys: ["KeyR"], pad: [9] },
  { id: "keep", label: "Keep the take", keys: ["Enter"], pad: [] },
  { id: "discard", label: "Discard the take", keys: ["Backspace"], pad: [] },
  { id: "exit", label: "Leave Drive mode", keys: ["Escape"], pad: [] },
];

export const DEFAULT_BINDINGS = Object.freeze({
  keys: Object.fromEntries(ACTIONS.map((a) => [a.id, a.keys])),
  pad: Object.fromEntries(ACTIONS.map((a) => [a.id, a.pad])),
});

const STORE = "ss_drive_bindings";
/** Bindings with the user's remaps on top of the defaults (remaps live in localStorage). */
export function loadBindings(store = globalThis.localStorage) {
  const b = clone(DEFAULT_BINDINGS);
  try {
    const u = JSON.parse(store?.getItem(STORE) || "null");
    if (u?.keys) for (const [k, v] of Object.entries(u.keys)) if (b.keys[k] && Array.isArray(v)) b.keys[k] = v.map(String);
    if (u?.pad) for (const [k, v] of Object.entries(u.pad)) if (b.pad[k] && Array.isArray(v)) b.pad[k] = v.map(Number).filter(Number.isFinite);
  } catch { /* storage blocked or bad JSON: the defaults */ }
  return b;
}

/** Remap one action to a key code (or a pad button number). Returns the new bindings; saves them. */
export function remap(bindings, action, { key = null, button = null } = {}, store = globalThis.localStorage) {
  const b = clone(bindings);
  if (!b.keys[action]) return b;
  if (key) b.keys[action] = [key];
  if (Number.isFinite(button)) b.pad[action] = [button];
  try { store?.setItem(STORE, JSON.stringify(b)); } catch { /* storage blocked */ }
  return b;
}

export function resetBindings(store = globalThis.localStorage) {
  try { store?.removeItem(STORE); } catch { /* */ }
  return clone(DEFAULT_BINDINGS);
}

/** A stick with a radial dead zone, rescaled so it still reaches 1. */
export function stick(x = 0, y = 0, dz = 0.15) {
  const m = Math.hypot(x, y);
  if (!(m > dz)) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

const btn = (b) => (b == null ? 0 : typeof b === "number" ? b : (b.value || 0) > 0.02 ? b.value : b.pressed ? 1 : 0);

/**
 * One frame of input, from the keys held (a Set of KeyboardEvent.code), the first gamepad (Gamepad API, "standard"
 * mapping) and the mouse look delta. Returns values only (edges are worked out by the caller against the last frame):
 * {move: [x right, y forward] (|move| <= 1), mag, look: [x, y] (stick, -1..1), lookPx: [dx, dy] (mouse), throttle,
 * brake (0..1), steer (-1 left .. 1 right), and every action's 0..1 value under its id}.
 */
export function readInput({ down = new Set(), pad = null, mouse = [0, 0], buttons = new Set(), bindings = DEFAULT_BINDINGS, deadzone = 0.15 } = {}) {
  const K = (act) => (bindings.keys[act] || []).some((c) => down.has(c)) ? 1 : 0;
  const B = (act) => (pad ? Math.max(0, ...(bindings.pad[act] || []).map((i) => btn(pad.buttons?.[i]))) : 0);
  const ax = pad?.axes || [];
  const ls = stick(ax[0] || 0, ax[1] || 0, deadzone), rs = stick(ax[2] || 0, ax[3] || 0, deadzone);
  let mx = K("right") - K("left"), my = K("forward") - K("back");
  const km = Math.hypot(mx, my);
  if (km > 1) { mx /= km; my /= km; }
  if (Math.hypot(ls[0], ls[1]) > Math.hypot(mx, my)) { mx = ls[0]; my = -ls[1]; }
  const out = { move: [mx, my], mag: Math.min(1, Math.hypot(mx, my)), look: [rs[0], rs[1]], lookPx: [mouse[0] || 0, mouse[1] || 0], pad: !!pad };
  for (const a of ACTIONS) out[a.id] = Math.max(K(a.id), B(a.id));
  // Analog pedals: a trigger or the forward / back keys; the stick's x (or A / D) steers.
  out.throttle = Math.max(out.throttle, K("forward"));
  out.brake = Math.max(out.brake, K("back"));
  out.steer = clamp(mx, -1, 1);
  if (buttons.has(2)) out.aim = 1;                 // right mouse button held: aim
  if (buttons.has("click")) out.throw = 1;         // a click (no drag) while carrying: throw
  return out;
}

/** Which actions went down this frame: {id: true}. */
export function pressed(prev, cur) {
  const out = {};
  for (const a of ACTIONS) out[a.id] = (cur[a.id] || 0) > 0.5 && !((prev?.[a.id] || 0) > 0.5);
  return out;
}

// ------------------------------------------------------------------ speeds from the stick

/** A person's speed (m/s) from stick deflection: half = a walk, full = a jog, + run = a run (scaled by leg length). */
export function personSpeed(mag, sprint = false, height = 1.8) {
  if (!(mag > 0.05)) return 0;
  const k = Math.sqrt(height / 1.8), m = Math.min(1, mag);
  let v = m <= 0.7 ? 1.6 * m / 0.7 : 1.6 + 1.6 * (m - 0.7) / 0.3;
  if (sprint) v = Math.max(v, 6.2 * m);
  return v * k;
}

/** A horse's target speed: a quarter stick walks, half trots, full canters, + gallop (sprint) gallops. */
export function horseSpeed(mag, sprint = false, height = 1.6) {
  if (!(mag > 0.05)) return 0;
  const k = Math.sqrt(height / 1.6), m = Math.min(1, mag);
  let v = m <= 0.4 ? 1.7 * m / 0.4 : m <= 0.8 ? 1.7 + 2.6 * (m - 0.4) / 0.4 : 4.3 + 2.7 * (m - 0.8) / 0.2;
  if (sprint) v = Math.max(v, 12.5 * m);
  return v * k;
}

/** The gait a speed gives (for the HUD and the tests). */
export const gaitFor = (kind, v, height) => Gait.gaitName(kind === "horse" ? "horse" : "human", Math.abs(v), height);

/** World direction [dx, dz] of a stick (x right, y forward) seen from a camera looking along heading camYaw. */
export function moveDir(mx, my, camYaw) {
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw), rx = -fz, rz = fx;   // +x is a figure's left, so right = (-cos, sin)
  const dx = fx * my + rx * mx, dz = fz * my + rz * mx, n = Math.hypot(dx, dz) || 1;
  return [dx / n, dz / n];
}

// ------------------------------------------------------------------ collision

/**
 * Push a circle (x, z, radius r) out of every box it overlaps. Boxes: {cx, cz, hx, hz, yaw, bottom, top} (yaw as a
 * three.js rotation.y); a box lower than feet + step (a kerb, a crate top you can step onto) or above the head is passed.
 * Returns {x, z, hit, nx, nz} (the summed push direction).
 */
export function collideCircle(x, z, r, list, { feet = 0, head = 2, step = STEP_UP } = {}) {
  let hit = false, nx = 0, nz = 0;
  for (let it = 0; it < 2; it++) {
    for (const b of list) {
      if (b.top <= feet + step || b.bottom >= head) continue;
      if (b.circle) {
        const dx = x - b.cx, dz = z - b.cz, d = Math.hypot(dx, dz), R = r + b.circle;
        if (d < R && d > 1e-6) { x = b.cx + dx / d * R; z = b.cz + dz / d * R; hit = true; nx += dx / d; nz += dz / d; }
        continue;
      }
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const wx = x - b.cx, wz = z - b.cz;
      const lx = wx * c - wz * s, lz = wx * s + wz * c;            // world -> box (inverse of rotation.y)
      const qx = clamp(lx, -b.hx, b.hx), qz = clamp(lz, -b.hz, b.hz);
      let dx = lx - qx, dz = lz - qz, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      let px, pz;
      if (d < 1e-6) {                                               // centre inside: out through the nearest side
        const ex = b.hx - Math.abs(lx), ez = b.hz - Math.abs(lz);
        if (ex < ez) { px = Math.sign(lx || 1) * (b.hx + r); pz = lz; dx = Math.sign(lx || 1); dz = 0; }
        else { px = lx; pz = Math.sign(lz || 1) * (b.hz + r); dx = 0; dz = Math.sign(lz || 1); }
        d = 1;
      } else { px = qx + dx / d * r; pz = qz + dz / d * r; }
      x = b.cx + px * c + pz * s; z = b.cz - px * s + pz * c;        // box -> world
      const ux = dx / d, uz = dz / d;
      nx += ux * c + uz * s; nz += -ux * s + uz * c;
      hit = true;
    }
  }
  const n = Math.hypot(nx, nz) || 1;
  return { x, z, hit, nx: nx / n, nz: nz / n };
}

// ------------------------------------------------------------------ the bodies

/** A person on foot: {x, y, z, yaw, speed, vy, air, height}. env: {camYaw, ground(x, z, y), collide(x, z, feet, head, r), climb(b)}. */
export function personStep(b, inp, env, dt) {
  const h = b.height || 1.8;
  if (b.climb) {                                                  // up onto a box: a hop, the hands, the knee, stand
    const c = b.climb;
    c.t += dt / c.dur;
    const u = sstep(c.t), up = sstep(c.t / 0.7);
    b.x = lerp(c.from[0], c.to[0], u); b.z = lerp(c.from[2], c.to[2], u);
    b.y = lerp(c.from[1], c.to[1], up) + Math.sin(Math.PI * clamp(c.t, 0, 1)) * 0.12;
    if (c.t >= 1) { b.y = c.to[1]; b.climb = null; b.speed = 0; }
    return b;
  }
  const mag = Math.min(1, inp.mag ?? Math.hypot(...inp.move));
  const target = personSpeed(mag, inp.sprint > 0.5, h);
  let want = b.yaw;
  if (mag > 0.05) { const [dx, dz] = moveDir(inp.move[0], inp.move[1], env.camYaw ?? 0); want = Math.atan2(dx, dz); }
  if (inp.aim > 0.5 && Number.isFinite(env.camYaw)) want = env.camYaw;   // aiming: face where the camera looks
  const rate = b.air ? 3 : lerp(12, 6.5, clamp(b.speed / 6, 0, 1));
  const err = wrap(want - b.yaw);
  b.yaw += clamp(err, -rate * dt, rate * dt);
  const align = Math.max(0, Math.cos(err));
  const tv = target * (0.3 + 0.7 * align);
  if (!b.air) b.speed += clamp(tv - b.speed, -11 * dt, 6.5 * dt);
  // Jump (or climb onto a box right in front).
  if (!b.air && inp.jumpPressed) {
    const cl = env.climb?.(b);
    if (cl) { b.climb = { t: 0, dur: 0.45 + 0.25 * cl.rise, from: [b.x, b.y, b.z], to: cl.to }; b.speed = 0; return b; }
    b.vy = Math.sqrt(2 * G * JUMP_H); b.air = true;
  }
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
  let nx = b.x + fx * b.speed * dt, nz = b.z + fz * b.speed * dt;
  const res = env.collide ? env.collide(nx, nz, b.y, b.y + h, 0.28) : { x: nx, z: nz, hit: false };
  nx = res.x; nz = res.z;
  if (res.hit) b.speed *= Math.max(0, 1 - 8 * dt);
  const ground = env.ground ? env.ground(nx, nz, b.y) : 0;
  if (b.air) {
    b.vy -= G * dt; b.y += b.vy * dt;
    if (b.y <= ground && b.vy <= 0) { b.y = ground; b.air = false; b.vy = 0; }
  } else if (ground > b.y + STEP_UP) {                             // a wall the box test missed: stay put
    nx = b.x; nz = b.z; b.speed = 0;
  } else if (ground < b.y - 0.08) { b.air = true; b.vy = 0; }      // walked off an edge: fall
  else b.y = ground;
  b.x = nx; b.z = nz;
  return b;
}

/** A horse (or another animal), ridden like a horse: forward / back is the pace, left / right turns. */
export function horseStep(b, inp, env, dt) {
  const fwd = inp.move[1], turn = inp.move[0];
  const h = b.height || 1.6;
  const target = fwd > 0.05 ? horseSpeed(Math.max(fwd, Math.hypot(fwd, turn) * (fwd > 0 ? 1 : 0)), inp.sprint > 0.5, h) * (b.scaleSpeed || 1)
    : fwd < -0.3 && b.speed < 0.3 ? -0.9 : 0;
  const acc = target > b.speed ? (b.speed < 4 ? 3.6 : 3.0) : fwd < -0.3 ? 8 : 4.5;
  b.speed += clamp(target - b.speed, -acc * dt, acc * dt);
  const rate = lerp(1.7, 0.75, clamp(Math.abs(b.speed) / 12, 0, 1)) * (Math.abs(b.speed) < 0.2 ? 0.8 : 1);
  b.yaw -= turn * rate * dt;
  return moveBody(b, env, dt, b.radius || 0.55);
}

/** A bicycle / motorcycle: a kinematic bicycle model that leans into its turns. */
export function bikeStep(b, inp, env, dt) {
  const vmax = b.kind === "motorcycle" ? (inp.sprint > 0.5 ? 38 : 26) : (inp.sprint > 0.5 ? 10 : 7);
  const thr = Math.max(inp.throttle, inp.move[1] > 0 ? inp.move[1] : 0), brk = Math.max(inp.brake, inp.move[1] < 0 ? -inp.move[1] : 0);
  const a = thr * (b.kind === "motorcycle" ? 5 : 1.6) - brk * 6 - 0.15 * b.speed;
  b.speed = Math.max(b.speed < 0.3 && brk > 0.5 ? -1 : 0, b.speed + a * dt);
  b.speed = Math.min(vmax, b.speed);
  const lock = lerp(30, 6, clamp(Math.abs(b.speed) / 20, 0, 1)) * DEG;
  b.steer = lerp(b.steer || 0, -inp.steer * lock, clamp(8 * dt, 0, 1));
  const yawRate = b.speed * Math.tan(b.steer) / (b.wheelbase || 1.3);
  b.yaw += yawRate * dt;
  b.lean = lerp(b.lean || 0, clamp(Math.atan2(b.speed * yawRate, G), -0.7, 0.7), clamp(6 * dt, 0, 1));
  return moveBody(b, env, dt, b.radius || 0.4);
}

/** A boat: thrust and rudder, a slow turn that needs way on, and it carries its speed. */
export function boatStep(b, inp, env, dt) {
  const thr = Math.max(inp.throttle, inp.move[1] > 0 ? inp.move[1] : 0), rev = Math.max(inp.brake, inp.move[1] < 0 ? -inp.move[1] : 0);
  const vmax = b.kind === "jetski" ? 20 : 14;
  b.speed += ((thr - 0.6 * rev) * (inp.sprint > 0.5 ? 4 : 2.5) - 0.12 * b.speed) * dt;
  b.speed = clamp(b.speed, -3, vmax);
  b.yaw -= inp.steer * 0.7 * clamp(Math.abs(b.speed) / 3, 0.15, 1) * Math.sign(b.speed || 1) * dt;
  return moveBody(b, env, dt, b.radius || 1.0);
}

/** A prop flown by hand: move relative to the camera, rise / sink, turn. */
export function propStep(b, inp, env, dt) {
  const v = inp.sprint > 0.5 ? 6 : 2;
  if (inp.mag > 0.05) {
    const [dx, dz] = moveDir(inp.move[0], inp.move[1], env.camYaw ?? 0);
    b.x += dx * v * inp.mag * dt; b.z += dz * v * inp.mag * dt;
  }
  const up = (inp.jump || 0) - Math.max(inp.descend || 0, inp.drop || 0);
  b.y = Math.max(0, b.y + up * v * 0.6 * dt);
  b.yaw += ((inp.turnLeft || 0) - (inp.turnRight || 0)) * 1.6 * dt;
  b.speed = inp.mag * v;
  return b;
}

function moveBody(b, env, dt, r) {
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
  let nx = b.x + fx * b.speed * dt, nz = b.z + fz * b.speed * dt;
  if (env.collide) {
    const half = b.halfLen || 0;
    // Two circles along the body (nose and tail) for anything long.
    let res = env.collide(nx + fx * half, nz + fz * half, b.y || 0, (b.y || 0) + (b.height || 1.5), r);
    nx = res.x - fx * half; nz = res.z - fz * half;
    const res2 = half ? env.collide(nx - fx * half, nz - fz * half, b.y || 0, (b.y || 0) + (b.height || 1.5), r) : { hit: false };
    if (half) { nx = res2.x + fx * half; nz = res2.z + fz * half; }
    if (res.hit || res2.hit) b.speed *= Math.max(0, 1 - 6 * dt);
  }
  b.x = nx; b.z = nz;
  return b;
}

/**
 * A car's pedals and wheel from the input, as a GTA-style driver expects: the brake brings it to a stop and then
 * reverses; in reverse the throttle brakes. The steering lock eases off with speed (so a keyboard can drive at 100 km/h)
 * but keeps enough to flick a J-turn. state: {gear, steer (deg, + left), revT}. Returns the controls for LiveCar.step.
 */
export function carControls(inp, v, car, state, dt) {
  const thrIn = Math.max(inp.throttle || 0, 0), brkIn = Math.max(inp.brake || 0, 0);
  state.gear ||= "D";
  if (state.gear === "D" && v < 0.6 && brkIn > 0.2 && thrIn < 0.1) { state.revT = (state.revT || 0) + dt; if (state.revT > 0.22) state.gear = "R"; }
  else if (state.gear === "R" && v > -0.6 && thrIn > 0.2 && brkIn < 0.1) { state.revT = (state.revT || 0) + dt; if (state.revT > 0.22) state.gear = "D"; }
  else state.revT = 0;
  const rev = state.gear === "R";
  const throttle = rev ? brkIn : thrIn, brake = rev ? thrIn : brkIn;
  const lock = car.steerMax * Math.max(0.45, 1 - Math.abs(v) / 45);
  const want = -clamp(inp.steer || 0, -1, 1) * lock;              // stick right = turn right = negative (vehsim: + left)
  const rate = (inp.pad ? 9 : 3.2) * car.steerMax;                 // deg/s: a keyboard winds it on, a stick is direct
  const d = want - (state.steer || 0);
  state.steer = (state.steer || 0) + clamp(d, -rate * dt, rate * dt);
  return { throttle, brake, handbrake: inp.handbrake || 0, steer: state.steer, gear: state.gear };
}

// ------------------------------------------------------------------ throws

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
/** Lowest point of a box (half extents) about its centre, rotated by quaternion q (array). */
function lowest(half, q) {
  _q.set(q[0], q[1], q[2], q[3]);
  let m = Infinity;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? half[0] : -half[0], i & 2 ? half[1] : -half[1], i & 4 ? half[2] : -half[2]).applyQuaternion(_q);
    m = Math.min(m, _v.y);
  }
  return m;
}

/** The nearest resting orientation: the box face closest to down, keeping the yaw. */
export function restQuat(q) {
  _q.set(q[0], q[1], q[2], q[3]);
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let best = null, bd = -2;
  for (const a of axes) { _v.set(...a).applyQuaternion(_q); if (_v.y > bd) { bd = _v.y; best = _v.clone(); } }
  _q2.setFromUnitVectors(best, _v2.set(0, 1, 0));
  const out = _q2.multiply(_q);
  return [out.x, out.y, out.z, out.w];
}

/**
 * One step of a thrown (or dropped) prop: gravity, tumbling, the ground (env.ground), walls (env.collide), a bounce,
 * sliding friction and settling onto a face. p: {c: [x, y, z] (centre), v: [3], q: [4], w: [3] (rad/s), half: [3],
 * still}. Returns p with p.rest once it has come to rest.
 */
export function projectileStep(p, env, dt) {
  if (p.rest) return p;
  p.v[1] -= G * dt;
  for (let k = 0; k < 3; k++) p.c[k] += p.v[k] * dt;
  const wl = Math.hypot(...p.w);
  if (wl > 1e-5) {
    _q2.setFromAxisAngle(_v.set(p.w[0] / wl, p.w[1] / wl, p.w[2] / wl), wl * dt);
    _q.set(...p.q).premultiply(_q2).normalize();
    p.q = [_q.x, _q.y, _q.z, _q.w];
  }
  if (env.collide) {
    const r = Math.max(p.half[0], p.half[2]) * 0.9;
    const res = env.collide(p.c[0], p.c[2], p.c[1] - p.half[1], p.c[1] + p.half[1], r);
    if (res.hit) {
      const into = p.v[0] * res.nx + p.v[2] * res.nz;
      if (into < 0) { p.v[0] -= 1.35 * into * res.nx; p.v[2] -= 1.35 * into * res.nz; }
      p.c[0] = res.x; p.c[2] = res.z;
    }
  }
  const ground = env.ground ? env.ground(p.c[0], p.c[2], p.c[1]) : 0;
  const low = lowest(p.half, p.q);
  if (p.c[1] + low <= ground) {
    p.c[1] = ground - low;
    if (p.v[1] < -1.2) { p.v[1] = -p.v[1] * 0.28; p.v[0] *= 0.62; p.v[2] *= 0.62; p.w = p.w.map((x) => x * 0.55); }
    else {
      p.v[1] = 0;
      const f = Math.max(0, 1 - 5.5 * dt);
      p.v[0] *= f; p.v[2] *= f;
      p.w = p.w.map((x) => x * Math.max(0, 1 - 7 * dt));
      // Tip onto the nearest face (a crate lands on an edge and falls flat).
      const rq = restQuat(p.q);
      _q.set(...p.q).slerp(_q2.set(...rq), clamp(9 * dt, 0, 1));
      p.q = [_q.x, _q.y, _q.z, _q.w];
      p.c[1] = ground - lowest(p.half, p.q);
    }
    p.ground = true;
  } else p.ground = false;
  const moving = Math.hypot(...p.v) > 0.06 || Math.hypot(...p.w) > 0.15;
  p.still = p.ground && !moving ? (p.still || 0) + dt : 0;
  if (p.still > 0.3) { p.q = restQuat(p.q); p.c[1] = ground - lowest(p.half, p.q); p.v = [0, 0, 0]; p.w = [0, 0, 0]; p.rest = true; }
  return p;
}

/** The launch of a throw: the thrower's facing (or aim), 9 m/s and a lift, plus the thrower's own speed. */
export function throwVelocity(yaw, pitch = 0.18, speed = 9, carrierVel = [0, 0]) {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c * speed + carrierVel[0], Math.sin(pitch) * speed + 2.6, Math.cos(yaw) * c * speed + carrierVel[1]];
}

/** The arc a throw will fly (for the aim line): points until it falls below y = 0. */
export function throwArc(c0, v0, n = 40, dt = 0.05) {
  const pts = [];
  const c = [...c0], v = [...v0];
  for (let i = 0; i < n && c[1] > -0.05; i++) { pts.push([...c]); v[1] -= G * dt; for (let k = 0; k < 3; k++) c[k] += v[k] * dt; }
  return pts;
}

// ------------------------------------------------------------------ takes -> keys

export const SMOOTHING = { none: 0, light: 1, smooth: 2.5, heavy: 4.5 };

/** Zero-phase Gaussian smoothing of a series (sigma in samples). */
export function smoothSeries(v, sigma) {
  if (!(sigma > 0.3) || v.length < 3) return v.slice();
  const r = Math.ceil(sigma * 3), out = [];
  for (let i = 0; i < v.length; i++) {
    let s = 0, w = 0;
    for (let k = -r; k <= r; k++) { const j = clamp(i + k, 0, v.length - 1), g = Math.exp(-(k * k) / (2 * sigma * sigma)); s += v[j] * g; w += g; }
    out.push(s / w);
  }
  return out;
}

/** Unwrap a list of headings (radians) into a continuous track. */
export function unwrapAll(yaws) {
  const out = [];
  for (const y of yaws) out.push(out.length ? out[out.length - 1] + wrap(y - out[out.length - 1]) : y);
  return out;
}

/**
 * A path track (one sample per frame: {f, p: [x, y, z], yaw, roll?, pitch?, steer?, air?}) -> stage keys: a key every
 * `every` frames (and the last), position (with height) and heading_deg, plus a car's roll_deg / pitch_deg. Smoothing
 * filters x, z and the heading (not the height, so a jump keeps its arc).
 */
export function pathKeys(samples, { smoothing = "light", every = 2 } = {}) {
  if (!samples.length) return [];
  const sig = SMOOTHING[smoothing] ?? (Number(smoothing) || 0);
  const xs = smoothSeries(samples.map((s) => s.p[0]), sig), zs = smoothSeries(samples.map((s) => s.p[2]), sig);
  const ys = unwrapAll(samples.map((s) => s.yaw));
  const yaw = smoothSeries(ys, sig);
  const keys = [];
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (i % every && i !== n - 1 && !s.keep) continue;
    const k = { frame: s.f, position: [r3(xs[i]), r3(Math.max(0, s.p[1])), r3(zs[i])], heading_deg: Math.round(yaw[i] / DEG * 100) / 100 };
    if (Number.isFinite(s.roll)) k.roll_deg = Math.round(s.roll * 100) / 100;
    if (Number.isFinite(s.pitch)) k.pitch_deg = Math.round(s.pitch * 100) / 100;
    // A car's tyre smoke from its own slip energy (the stage's smoke plays these instead of guessing from the path).
    if (s.smoke) { const near = samples.slice(Math.max(0, i - 1), i + 2).reduce((m, x) => (x.smoke?.amount > m.amount ? x.smoke : m), s.smoke); k.fx = { tire_smoke: near.amount, wheels: near.wheels }; }
    if (s.keep) k.keep = true;
    keys.push(k);
  }
  return dropHolds(keys).map((k) => { delete k.keep; return k; });
}

/** Keys in the middle of a hold (the same as both neighbours) add nothing: a parked car keeps two keys, not hundreds. */
export function dropHolds(keys, same = (a, b) => JSON.stringify({ ...a, frame: 0, keep: 0 }) === JSON.stringify({ ...b, frame: 0, keep: 0 })) {
  return keys.filter((k, i) => i === 0 || i === keys.length - 1 || k.keep || !same(keys[i - 1], k) || !same(k, keys[i + 1]));
}

/**
 * A person's track -> mount spans: [{host, seat, pose, from, to}] (from = the frame they are seated, to = the frame they
 * start to get out). Samples carry mode "foot" | "hop" | "mounted" | "exit" and the host.
 */
export function mountSpans(samples) {
  const spans = [];
  let cur = null;
  for (const s of samples) {
    const on = s.mode === "mounted" || s.mode === "exit";
    if (on && (!cur || cur.host !== s.host)) {
      if (cur) spans.push(cur);
      cur = { host: s.host, seat: s.seat ?? null, pose: s.pose ?? null, from: s.f, to: null };
      if (s === samples[0]) cur.noHop = true;   // already seated when the take began
    }
    if (cur && s.mode === "exit" && cur.to == null) cur.to = s.f;
    if (cur && !on) { if (cur.to == null) cur.to = s.f; spans.push(cur); cur = null; }
  }
  if (cur) { if (cur.to == null) cur.to = 1e9; spans.push(cur); }
  // A blip of a frame or two between two stretches on the same seat (a hand-over glitch) is one span.
  for (let i = spans.length - 1; i > 0; i--) {
    const p = spans[i - 1], c = spans[i];
    if (p.host === c.host && c.from - p.to <= 2) { p.to = c.to; spans.splice(i, 1); }
  }
  return spans;
}

/** Heading (deg, unwrapped near prev) of an actor's existing keys, so the keys kept before a take match its heading. */
function annotateHeading(stage, a, keys) {
  let prev = null;
  for (const k of keys) {
    if (!Number.isFinite(k.heading_deg)) {
      const d = stage._headingAt(a, k.frame) / DEG;
      k.heading_deg = Math.round((prev == null ? d : prev + wrap((d - prev) * DEG) / DEG) * 100) / 100;
    }
    prev = k.heading_deg;
  }
  return keys;
}

/**
 * Write a take onto the scene (the actors the take touched). take: {start, end, fps, tracks: {id: {type, samples,
 * events}}}. Old keys before each track's first frame stay; from there on the take replaces them (and the last pose
 * holds to the end of the shot). Returns a short summary per actor.
 */
export function applyTake(stage, take, { smoothing = "light" } = {}) {
  const out = [];
  for (const [id, tr] of Object.entries(take.tracks || {})) {
    const a = stage.state.actors.find((x) => x.id === id);
    if (!a || !tr.samples?.length) continue;
    const f0 = tr.samples[0].f, f1 = tr.samples[tr.samples.length - 1].f;
    const name = a.name || LIBRARY[a.kind]?.label || a.kind;
    if (tr.type === "baked") {
      const before = (stage._actorKeys(a) || []).filter((k) => k.frame < f0).map((k) => ({ ...k, quat: k.quat || (() => {
        const g = stage.actorMeshes.get(id); return g ? [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w] : [0, 0, 0, 1]; })() }));
      const keys = tr.samples.map((s) => ({ frame: s.f, position: s.p.map(r3), quat: s.q.map((v) => Math.round(v * 1e5) / 1e5) }));
      // Dense while it moves, one key where it holds still.
      const same = (p, q) => p && q && p.position.every((v, i) => v === q.position[i]) && p.quat.every((v, i) => v === q.quat[i]);
      const dense = keys.filter((k, i) => i === 0 || i === keys.length - 1 || !same(keys[i - 1], k) || !same(k, keys[i + 1]));
      if (before.length && f0 > 0 && !before.some((k) => k.frame === f0 - 1)) before.push({ ...before[before.length - 1], frame: f0 - 1 });
      a.keys = [...before, ...dense];
      a.physics = { ...(a.physics || {}), mode: a.physics?.mode === "static" ? "dynamic" : a.physics?.mode || "dynamic", baked: true, driven: true };
      a.key_y = true;
      delete a.position_end; delete a.carry_id; delete a.carry_at;
      // Who held it when (the carrier's arms hold it in playback: Drive.post).
      const spans = [];
      for (const s of tr.samples) {
        const last = spans[spans.length - 1];
        if (s.by && last?.by === s.by && last.to === s.f) last.to = s.f + 1;
        else if (s.by) spans.push({ by: s.by, from: s.f, to: s.f + 1 });
      }
      a.carry_spans = [...(a.carry_spans || []).filter((s) => s.to <= f0), ...spans];
      out.push(`${name}: ${dense.length} keys (carried and thrown)`);
      continue;
    }
    // A path: people, horses, vehicles, props.
    const spans = tr.type === "person" ? mountSpans(tr.samples) : [];
    const samples = tr.samples.map((s) => ({ ...s }));
    // While mounted the figure is placed by the seat; its own keys wait where it got on (and jump, hidden, to where it
    // gets off a few frames in), so the walk before and after plays from the right spots.
    for (const sp of spans) {
      const after = samples.find((s) => s.f >= sp.to && s.mode === "foot");
      const exitAt = after?.p || samples.find((s) => s.f === sp.from)?.p;
      const exitYaw = after?.yaw;
      for (const s of samples) {
        if (s.f < sp.from || s.f >= sp.to) continue;
        if (s.f >= sp.from + 3 && exitAt) { s.p = [...exitAt]; if (Number.isFinite(exitYaw)) s.yaw = exitYaw; }
        s.keep = s.f === sp.from || s.f === sp.from + 3 || s.f === sp.to - 1;
      }
    }
    const fresh = pathKeys(samples, { smoothing: tr.type === "person" ? smoothing : smoothing, every: tr.type === "car" ? 2 : 2 });
    const before = annotateHeading(stage, a, (stage._actorKeys(a) || []).filter((k) => k.frame < f0).map((k) => ({ ...k })));
    a.keys = [...before, ...fresh];
    delete a.position_end;
    if (tr.type === "prop" && samples.some((s) => s.p[1] > 0.01)) a.key_y = true;
    if (tr.type === "car") {
      a.stunt_sim = { ...(a.stunt_sim || {}), surface: tr.surface || "dry", driven: true };
      delete a.stunt; delete a.drive;
      // The wheel as you turned it (opposite lock and all), keyed linear every 2 frames.
      const st0 = samples.filter((s, i) => Number.isFinite(s.steer) && (i % 2 === 0 || i === samples.length - 1)).map((s) => ({ f: s.f, v: Math.round(s.steer * 10) / 10 }));
      const st = dropHolds(st0, (p, q) => p.v === q.v);
      if (st.length) {
        const keep = (a.parts?.steer || []).filter((k) => k.frame < f0);
        a.parts = { ...(a.parts || {}), steer: keep };
        for (const s of st) writeKey(a, "steer", s.f, s.v, "linear");
      }
    }
    if (spans.length) {
      // The person's mount spans (in and out of the car, up onto the horse): played by the stage hook (Drive.pre).
      const old = (a.mount_spans || []).filter((s) => s.from < f0).map((s) => ({ ...s }));
      const fresh = spans.map((s) => ({ host: s.host, seat: s.seat, pose: s.pose, from: s.from, to: Math.min(s.to, 1e9), ...(s.noHop ? { noHop: true } : {}) }));
      // Still in the same seat from an earlier take: one span, from when they got in then.
      const prev = old[old.length - 1];
      if (prev && prev.to > f0 && fresh[0]?.noHop && fresh[0].host === prev.host) { fresh[0].from = prev.from; delete fresh[0].noHop; if (prev.noHop) fresh[0].noHop = true; old.pop(); }
      else if (prev && prev.to > f0) prev.to = f0;
      a.mount_spans = [...old, ...fresh];
      delete a.mount_id; delete a.mount_at; delete a.pose; delete a.seat;
    } else if (tr.type === "person" && a.mount_spans) a.mount_spans = a.mount_spans.filter((s) => s.to <= f0);
    out.push(`${name}: ${fresh.length} keys${spans.length ? `, ${spans.length} mount${spans.length > 1 ? "s" : ""}` : ""}`);
  }
  // Events: part toggles (lights, doors, indicators) and gaze, on whichever object they belong to.
  for (const ev of take.events || []) {
    const a = stage.state.actors.find((x) => x.id === ev.id);
    if (!a) continue;
    if (ev.type === "part") {
      const keys = a.parts?.[ev.ch];
      if (!keys?.length && ev.frame > 0) writeKey(a, ev.ch, 0, ev.prev ?? (ev.ch.startsWith("door") ? 0 : "off"), ev.ch.startsWith("door") ? undefined : "step");
      writeKey(a, ev.ch, ev.frame, ev.v, ev.ch.startsWith("door") ? undefined : "step");
    } else if (ev.type === "gaze") setGazeKey(a, ev.frame, ev.target);
  }
  stage._obsCache = null;
  return out;
}

/** The door's angle over a climb-in (frames relative to the take): opens before, shuts after. */
export function doorKeys(hopStart, seated, open = 65) {
  return [{ f: hopStart - 4, v: 0 }, { f: hopStart + 3, v: open }, { f: seated + 2, v: open }, { f: seated + 10, v: 0 }];
}
export function exitDoorKeys(to, exitN, open = 65) {
  return [{ f: to - DOOR_LEAD, v: 0 }, { f: to, v: open }, { f: to + exitN + 2, v: open }, { f: to + exitN + 10, v: 0 }];
}
const doorAt = (keys, f) => {
  if (f <= keys[0].f) return keys[0].v;
  for (let i = 1; i < keys.length; i++) if (f <= keys[i].f) return lerp(keys[i - 1].v, keys[i].v, sstep((f - keys[i - 1].f) / (keys[i].f - keys[i - 1].f)));
  return keys[keys.length - 1].v;
};

// ------------------------------------------------------------------ the stage side

/**
 * Drive mode on a Stage. The stage calls three hooks from setFrame: pre() (mount spans for this frame), pose(a, g)
 * (a live, driven object: true = posed here) and post() (getting out of seats and saddles). Everything else (keys,
 * pointer, gamepad, camera, recording) runs while drive mode is on.
 */
export class DriveMode {
  constructor(stage, K = {}) {
    this.s = stage;
    this.K = K;
    this.on = false;
    this.live = new Map();        // id -> live body (posed by pose())
    this.involved = new Set();    // ids whose mount / carry / parts fields drive mode is setting live
    this.bindings = loadBindings();
    this.cam = { mode: "chase", yaw: 0, pitch: -0.18, dist: 4, pos: null, tgt: null, idle: 0 };
    this.smoothing = "light";
    this.fromStart = true;
    this.down = new Set();
    this.mouse = [0, 0];
    this.mbuttons = new Set();
    this.prevIn = {};
    this.vclock = 0;              // seconds of live time (drives the live gait buffers)
    this.rec = null;              // {phase: "count" | "rec", t0, f0, take}
    this.pending = null;          // a recorded take, applied for review: {take, snap}
    this.events = [];
    this.say = (m) => this.s.onInteract?.(m);
  }

  // ---------- what can be driven
  canDrive(id) { const a = this.s.state.actors.find((x) => x.id === id); return !!driveKind(a, this.K); }
  _actor(id) { return this.s.state.actors.find((x) => x.id === id); }
  _name(a) { return a?.name || LIBRARY[a?.kind]?.label || a?.kind || "it"; }
  get fps() { return this.s.state.shot?.fps || 24; }

  // ---------- start / stop
  start(id = this.s.selected) {
    const a = this._actor(id);
    const kind = driveKind(a, this.K);
    if (!kind) { this.say("Select a person, a vehicle, a horse or a prop first, then press D to drive it."); return false; }
    if (this.on) this.stop();
    this.s.live?.finish?.();
    if (this.s.poser?.active) this.s.setPoseMode(false);
    this.snap = clone(this.s.state.actors);
    this.on = true;
    this.down.clear(); this.mbuttons.clear(); this.prevIn = {};
    this.prevSel = id;
    this.s.select(null);
    this._take(id);
    const g = this.s.actorMeshes.get(id);
    this.cam.yaw = g ? g.rotation.y : 0;
    this.cam.pos = null;
    this._bind();
    this.hud = null;
    import("../ui/drivehud.mjs").then(({ DriveHud }) => { if (this.on && !this.hud && typeof document !== "undefined") this.hud = new DriveHud(this); })
      .catch((err) => console.warn("Soundstage drive HUD", err));
    this._last = performance.now();
    this._raf = requestAnimationFrame((t) => this._tick(t));
    this.say(`Driving ${this._name(a)}. ${kind === "person" ? "WASD or the left stick to move, Shift to run, Space to jump, E to get into a car or onto a horse." : kind === "car" ? "W throttle, S brake / reverse, A D steer, Space handbrake." : "WASD to move."} R records a take, Esc leaves.`);
    return true;
  }

  stop() {
    if (!this.on) return;
    cancelAnimationFrame(this._raf);
    if (this.pending) this.discard(true);
    this.rec = null;
    this._unbind();
    this._restore(this.snap);
    this.live.clear(); this.involved.clear();
    this.ctl = null; this.avatar = null;
    this.on = false;
    this._aimLine(null);
    this.s.previewCamera(null);
    this.hud?.close?.();
    this.hud = null;
    this.s._obsCache = null;
    this.s.setFrame(this.s.frame);
    if (this.prevSel && this.s.actorMeshes.has(this.prevSel)) this.s.select(this.prevSel);
    this.say("Drive mode off. Kept takes are on the timeline; anything not recorded is back where it was.");
  }

  /** Put the actors back as they were in a snapshot (same objects, so the stage's caches and meshes stay valid). */
  _restore(snap) {
    if (!snap) return;
    const byId = new Map(snap.map((a) => [a.id, a]));
    for (const a of this.s.state.actors) {
      const b = byId.get(a.id);
      if (!b) continue;
      for (const k of Object.keys(a)) delete a[k];
      Object.assign(a, clone(b));
    }
  }

  // ---------- live bodies
  /** Make an object live (posed from its body every frame) at the pose it has now. */
  _make(id) {
    const a = this._actor(id), g = this.s.actorMeshes.get(id);
    if (!a || !g) return null;
    const kind = driveKind(a, this.K);
    g.updateMatrixWorld(true);
    const box = this._box(a, g);
    const b = { id, kind, akind: a.kind, x: g.position.x, y: kind === "prop" ? g.position.y : Math.max(0, g.position.y), z: g.position.z,
      yaw: g.rotation.y, speed: 0, vy: 0, air: false, height: (a.height_m || LIBRARY[a.kind]?.height || 1.6) * (a.scale || 1),
      hist: [], halfLen: box ? Math.max(0, box.hz - box.hx) : 0, radius: box ? Math.min(box.hx, box.hz) : 0.4, box };
    if (kind === "person") b.y = this.s._supportAt?.(b.x, b.z, b.y) ?? b.y;
    if (kind === "car") {
      const surface = /rain|snow|storm/.test(this.s.state.environment?.weather || "") ? "wet" : "dry";
      b.surface = surface;
      b.carp = carParams(CAR_SIM.has(a.kind) && a.kind !== "van" && a.kind !== "bus" && a.kind !== "taxi" ? a.kind : "car", null, "stunt");
      b.car = new LiveCar({ car: b.carp, surface, x: b.x, z: b.z, heading: b.yaw, fps: this.fps, substeps: 50 });
      b.cs = { gear: "D", steer: 0 };
      b.dist = 0;
    }
    if (kind === "bike") { b.wheelbase = a.kind === "motorcycle" ? 1.45 : 1.05; b.dist = 0; }
    if (kind === "animal") b.scaleSpeed = clamp((a.height_m || 0.6) / 1.6, 0.35, 1);
    this.live.set(id, b);
    this.involved.add(id);
    return b;
  }

  _take(id) {
    const b = this.live.get(id) || this._make(id);
    if (!b) return null;
    this.ctl = b;
    if (b.kind === "person") this.avatar = b;
    this.cam.idle = 0;
    return b;
  }

  /** Local box of an object in its own frame: {cx, cy, cz, hx, hy, hz} (cached per mesh and size). */
  _box(a, g) {
    const sig = `${a.scale || 1}|${a.height_m || 0}|${g.uuid}|${g.children.length}`;
    if (g.userData._driveBox?.sig === sig) return g.userData._driveBox.box;
    const lb = this.s._localBox?.(g);
    const box = lb ? { cx: lb.center[0], cy: lb.center[1], cz: lb.center[2], hx: lb.half[0], hy: lb.half[1], hz: lb.half[2] } : null;
    g.userData._driveBox = { sig, box };
    return box;
  }

  /** Everything a live body can run into, as it stands this frame: the set's boxes, parked and moving objects, people. */
  _obstacles(skip) {
    const out = [];
    for (const c of this.s._setCollidersCached?.() || []) {
      const yaw = 2 * Math.atan2(c.quat[1], c.quat[3]);
      out.push({ id: c.id, cx: c.pos[0], cz: c.pos[2], hx: c.half[0], hz: c.half[2], yaw, bottom: c.pos[1] - c.half[1], top: c.pos[1] + c.half[1] });
    }
    for (const a of this.s.state.actors) {
      if (skip.has(a.id) || a.mount_id || a.carry_id) continue;
      const g = this.s.actorMeshes.get(a.id);
      if (!g || !g.visible) continue;
      const L = LIBRARY[a.kind] || {};
      if (a.kind === "card" || L.flies || (this.K.NO_COLLIDE && this.K.NO_COLLIDE.has(a.kind)) || a.physics?.mode === "off") continue;
      if (this.K.PERSON_KINDS?.has(a.kind)) { out.push({ id: a.id, circle: 0.28, cx: g.position.x, cz: g.position.z, bottom: g.position.y, top: g.position.y + 1.7, noClimb: true }); continue; }
      const noClimb = L.rig === "vehicle" || L.rig === "quadruped";
      const b = this._box(a, g);
      if (!b) continue;
      const c = Math.cos(g.rotation.y), s = Math.sin(g.rotation.y), k = g.scale.x || 1;
      out.push({ id: a.id, cx: g.position.x + (b.cx * c + b.cz * s) * k, cz: g.position.z + (-b.cx * s + b.cz * c) * k, hx: b.hx * k, hz: b.hz * k, yaw: g.rotation.y,
        bottom: g.position.y + (b.cy - b.hy) * k, top: g.position.y + (b.cy + b.hy) * k, noClimb });
    }
    return out;
  }

  _env(b) {
    const skip = new Set([b.id]);
    if (this.avatar) skip.add(this.avatar.id);
    for (const a of this.s.state.actors) if (a.mount_id === b.id || a.carry_id === b.id || a.carry_id === this.avatar?.id) skip.add(a.id);
    if (this._carry) skip.add(this._carry.id);
    const list = this._obstacles(skip);
    // A thrown prop lands on the floor, the set's boxes and other objects, never on itself (or on who threw it).
    const propGround = (x, z, y) => {
      let g = Math.max(0, this.s.setFx?.floorAt?.(x, z) || 0);
      for (const o of list) {
        if (o.circle || o.top > y + 0.05 || o.top <= g) continue;
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw), wx = x - o.cx, wz = z - o.cz;
        if (Math.abs(wx * c - wz * s) <= o.hx && Math.abs(wx * s + wz * c) <= o.hz) g = o.top;
      }
      return g;
    };
    return {
      camYaw: this.cam.mode === "shot" ? this._shotYaw() : this.cam.yaw,
      ground: b.kind === "prop" ? propGround : (x, z, y) => this.s._supportAt ? this.s._supportAt(x, z, Math.max(0, y)) : 0,
      collide: (x, z, feet, head, r) => collideCircle(x, z, r, list, { feet, head, step: b.kind === "person" ? STEP_UP : 0.25 }),
      climb: (p) => {
        const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
        for (const o of list) {
          if (o.circle || o.noClimb) continue;
          const rise = o.top - p.y;
          if (rise <= STEP_UP || rise > CLIMB_MAX) continue;
          const t = collideCircle(p.x + fx * 0.55, p.z + fz * 0.55, 0.25, [o], { feet: p.y, head: p.y + 2 });
          if (!t.hit) continue;
          const tx = p.x + fx * 0.75, tz = p.z + fz * 0.75;
          const top = this.s._supportAt ? this.s._supportAt(tx, tz, o.top - 0.1) : o.top;
          if (top < p.y + STEP_UP) continue;
          return { rise, to: [tx, top, tz] };
        }
        return null;
      },
      list,
    };
  }

  _shotYaw() { const c = this.s._shotCameraAt?.(this.s.frame); return c ? Math.atan2(c.target[0] - c.position[0], c.target[2] - c.position[2]) : 0; }

  // ---------- the stage hooks
  /** setFrame hook, before the objects: recorded mount spans set who sits where at this frame. */
  pre() {
    const f = this.s.frame;
    for (const a of this.s.state.actors) {
      if (!a.mount_spans?.length || this.involved.has(a.id)) continue;
      let on = null;
      for (const sp of a.mount_spans) {
        const host = this._actor(sp.host);
        if (!host) continue;
        const hop = hopFrames(host.kind, sp.pose), ex = exitFrames(host.kind);
        if (f >= sp.from - hop && f < sp.to + ex) { on = sp; break; }
      }
      if (on) {
        a.mount_id = on.host;
        if (on.seat != null) a.seat = on.seat; else delete a.seat;
        if (on.pose) a.pose = on.pose; else delete a.pose;
        if (on.from > 0 && !on.noHop) a.mount_at = on.from; else delete a.mount_at;
      } else { delete a.mount_id; delete a.mount_at; delete a.seat; delete a.pose; }
    }
  }

  /** setFrame hook, per object: pose a live (driven) object from its body. Returns true when it did. */
  pose(a, g) {
    const b = this.on && !this.pending ? this.live.get(a.id) : null;
    if (!b) return false;
    if (a.mount_id && !(a.mount_at > this.s.frame)) return false;   // seated: the stage's rider pass places them
    g.rotation.order = "YXZ";
    g.rotation.set(0, b.yaw, 0);
    g.position.set(b.x, b.y, b.z);
    g.userData.speed = Math.abs(b.speed);
    if (b.kind === "person") this._posePerson(a, g, b);
    else if (b.kind === "horse" || b.kind === "animal") this._poseHorse(a, g, b);
    else if (b.kind === "car") this._poseCar(a, g, b);
    else if (b.kind === "bike") { this._wheels(g, b.dist); g.rotation.z = -(b.lean || 0); }
    else if (b.kind === "boat") { g.rotation.x = -clamp(b.speed / 40, 0, 0.12); g.rotation.z = clamp(-(b.turnRate || 0) * 0.04, -0.15, 0.15); }
    else if (b.kind === "prop" && b.q) g.quaternion.set(...b.q);
    try { this.s._partsApply?.(a, g); } catch { /* parts not installed */ }
    return true;
  }

  _livePlan(b, kind, legs, sweep = null) {
    if (!legs || b.hist.length < 2) return null;
    // The live path so far plus a short look-ahead at the current velocity: the planner plants the next steps ahead.
    const H = b.hist, last = H[H.length - 1], prev = H[H.length - 2];
    const pos = H.map((h) => h.p), yaw = H.map((h) => h.yaw);
    const vx = last.p[0] - prev.p[0], vz = last.p[2] - prev.p[2];
    for (let i = 1; i <= 14; i++) { pos.push([last.p[0] + vx * i, 0, last.p[2] + vz * i]); yaw.push(last.yaw); }
    const plan = Gait.planGait({ pos, yaw, fps: SIM_HZ / 2, kind, height: b.height, legs, sweep });
    return { plan, at: H.length - 1 };
  }

  _posePerson(a, g, b) {
    if (a.mount_id && a.mount_at > this.s.frame) { Gait.release(g); applyPose(g, "stand", b.height); return; }   // climbing in: the stage's arc
    if (b.air || b.climb) {
      Gait.release(g);
      applyPose(g, "stand", b.height);
      for (const l of g.userData.limbs || []) {
        if (l.part === "hip") l.pivot.rotation.x = b.climb ? -1.1 : -0.7;
        if (l.part === "knee") l.pivot.rotation.x = b.climb ? 1.4 : 1.1;
        if (l.part === "shoulder") l.pivot.rotation.x = b.climb ? -2.2 : -1.2;
      }
      return;
    }
    if (!g.userData.joints) return;
    const rest = Gait.humanFootRest(g);
    if (rest) for (const r of rest) { r.x *= g.scale.x; r.z *= g.scale.z; }
    const lp = this._livePlan(b, "human", rest);
    if (!lp) return;
    Gait.applyHuman(g, lp.plan, lp.at, { yaw: b.yaw, baseY: b.y, support: (x, z) => this.s._supportAt?.(x, z, b.y) ?? 0 });
  }

  _poseHorse(a, g, b) {
    const R = g.userData.horseRig;
    if (R?.gait) {
      const lp = this._livePlan(b, "horse", Gait.horseFootRest(R, g.scale.x), R.gait.sweep);
      if (lp) { Gait.applyHorse(g, R, lp.plan, lp.at, { yaw: b.yaw, baseY: 0, support: (x, z) => this.s._supportAt?.(x, z, 0) ?? 0 }); return; }
    }
    // The built quadruped: swing the limbs from the distance walked.
    const cyc = (b.walked || 0) / (1.6 * (a.height_m || 0.6)) * Math.PI * 2;
    for (const l of g.userData.limbs || []) l.pivot.rotation.x = b.speed > 0.1 ? 0.6 * Math.sin(cyc + (l.phase || 0)) : 0;
  }

  _wheels(g, dist) { if (g.userData.wheelRig) for (const w of g.userData.wheelRig) w.rotation.x = dist / (w.userData.radius || 0.33); }

  _poseCar(a, g, b) {
    const c = b.car;
    g.position.set(c.X, 0, c.Z);
    g.rotation.y = c.H;
    this._wheels(g, b.dist);
    const body = g.userData.vehicleBody;
    if (body?.userData.bodyPivot) body.rotation.set(-c.pitch * DEG, 0, c.roll * DEG);
    // The wheel and the brake lights, as live parts (put back when drive mode ends).
    a.parts = { ...(a.parts || {}), steer: [{ frame: 0, v: Math.round(c.ctl.steer * 10) / 10 }], brake: [{ frame: 0, v: c.ctl.brake > 0.1 ? "on" : "off" }] };
  }

  /** setFrame hook, after the riders: getting out of a seat or down from a saddle (recorded spans and live exits). */
  post() {
    const f = this.s.frame;
    // A recorded carry: the carrier's arms forward around the load (as the stage's own carry pose).
    for (const o of this.s.state.actors) {
      const sp = o.carry_spans?.find((s) => f >= s.from && f < s.to);
      const cg = sp && this.s.actorMeshes.get(sp.by);
      if (cg) for (const l of cg.userData.limbs || []) {
        if (l.part === "shoulder") l.pivot.rotation.x = -1.15;
        if (l.part === "elbow") l.pivot.rotation.x = -0.6;
      }
    }
    for (const a of this.s.state.actors) {
      const g = this.s.actorMeshes.get(a.id);
      if (!g || !a.mount_id) continue;
      const host = this._actor(a.mount_id);
      if (!host) continue;
      // Into a car seat: the stage's hop arcs up over the sill; through an open door it's a duck in, kept low.
      if (SEATS[host.kind] && a.mount_at > f && a.pose !== "ride") {
        const t = clamp((f - (a.mount_at - HOP_FRAMES)) / HOP_FRAMES, 0, 1), h = (a.height_m || 1.8) * (a.scale || 1);
        g.position.y -= Math.sin(Math.PI * t) * (0.35 - 0.05) * h / 1.8;
      }
      let t = null, stand = null;
      const lx = this.exiting?.id === a.id ? this.exiting : null;
      if (lx) { t = lx.t; stand = lx.stand; }
      else if (a.mount_spans?.length && !this.involved.has(a.id)) {
        const sp = a.mount_spans.find((s) => s.host === a.mount_id && f >= s.to && f < s.to + exitFrames(host.kind));
        if (sp) {
          t = (f - sp.to) / exitFrames(host.kind);
          const p = this.s._actorPosAt(a, f);
          stand = { x: p[0], y: this.s._heightAt?.(a, f) ?? 0, z: p[2], yaw: this.s._headingAt(a, f) };
        }
      }
      if (t == null || !stand) continue;
      const e = sstep(t), h = (a.height_m || 1.8) * (a.scale || 1);
      if (t > 0.35) { Gait.release(g); applyPose(g, "stand", h); for (const l of g.userData.limbs || []) if (l.part === "knee") l.pivot.rotation.x = 0.5 * (1 - e); }
      const from = g.position.clone();
      g.position.set(lerp(from.x, stand.x, e), lerp(from.y, stand.y, e) + Math.sin(Math.PI * t) * (host.kind === "horse" ? 0.25 : 0.12) * h / 1.8, lerp(from.z, stand.z, e));
      g.rotation.x *= 1 - e; g.rotation.z *= 1 - e;
      g.rotation.y += wrap(stand.yaw - g.rotation.y) * e;
    }
  }

  // ---------- input plumbing
  _bind() {
    const s = this.s, cv = s.canvas;
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
    this._onKey = (e) => {
      if (typing(e) || this.hud?.capturing) return;
      const bound = Object.values(this.bindings.keys).some((l) => l.includes(e.code));
      if (e.type === "keydown") {
        // Undo / redo wait until you leave: a take is one undo step once kept, and the live set would fight it.
        if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") { e.preventDefault(); e.stopImmediatePropagation(); this.say("Undo works once you leave Drive mode (Esc); a kept take is one undo step."); return; }
        if ((e.metaKey || e.ctrlKey) && !bound) return;
        if (e.key === "?") return;   // the shortcut sheet still opens
        this.down.add(e.code);
      } else this.down.delete(e.code);
      if (bound || e.code === "Tab" || /^Key[A-Z]$/.test(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    this._onBlur = () => this.down.clear();
    let drag = null;
    this._onDown = (e) => {
      if (e.target !== cv) return;
      e.preventDefault(); e.stopImmediatePropagation();
      drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button };
      this.mbuttons.add(e.button);
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      cv.focus({ preventScroll: true });
    };
    this._onMove = (e) => {
      if (!drag) return;
      e.stopImmediatePropagation();
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      this.mouse[0] += dx; this.mouse[1] += dy;
    };
    this._onUp = (e) => {
      if (!drag) return;
      e.stopImmediatePropagation();
      if (drag.moved < 5 && drag.button === 0) this._click = true;
      this.mbuttons.delete(drag.button);
      drag = null;
    };
    this._onCtx = (e) => { if (e.target === cv) e.preventDefault(); };
    this._wheel0 = s._onWheel;
    s._onWheel = (e) => { this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.0012), 1.5, 40); this.cam.userDist = this.cam.dist; };
    addEventListener("keydown", this._onKey, true);
    addEventListener("keyup", this._onKey, true);
    addEventListener("blur", this._onBlur);
    cv.addEventListener("pointerdown", this._onDown, true);
    addEventListener("pointermove", this._onMove, true);
    addEventListener("pointerup", this._onUp, true);
    cv.addEventListener("contextmenu", this._onCtx);
  }

  _unbind() {
    removeEventListener("keydown", this._onKey, true);
    removeEventListener("keyup", this._onKey, true);
    removeEventListener("blur", this._onBlur);
    this.s.canvas.removeEventListener("pointerdown", this._onDown, true);
    removeEventListener("pointermove", this._onMove, true);
    removeEventListener("pointerup", this._onUp, true);
    this.s.canvas.removeEventListener("contextmenu", this._onCtx);
    if (this._wheel0) this.s._onWheel = this._wheel0;
  }

  /** The first connected controller (tests override navigator.getGamepads). */
  _pad() {
    try {
      const pads = navigator.getGamepads?.() || [];
      for (const p of pads) if (p && p.connected !== false) return p;
    } catch { /* not allowed */ }
    return null;
  }

  // ---------- the loop
  _tick(now) {
    if (!this.on) return;
    this._raf = requestAnimationFrame((t) => this._tick(t));
    const dt = clamp((now - this._last) / 1000, 0, 0.1);
    this._last = now;
    const t0 = performance.now();
    try { this.step(dt); } catch (err) { console.warn("Soundstage drive", err); }
    const S = this.stats ||= { ticks: 0, ms: 0, worst: 0 };
    const ms = performance.now() - t0;
    S.ticks++; S.ms += ms; S.worst = Math.max(S.worst, ms);
  }

  /** Advance drive mode by dt seconds (the rAF loop, or a test calling it directly). */
  step(dt) {
    const pad = this._pad();
    const buttons = new Set(this.mbuttons);
    if (this._click) { buttons.add("click"); this._click = false; }
    const inp = readInput({ down: this.down, pad, mouse: this.mouse, buttons, bindings: this.bindings });
    this.mouse = [0, 0];
    const hit = pressed(this.prevIn, inp);
    this.prevIn = inp;
    this.lastInput = inp;
    this._buttons(hit, inp);
    if (this.pending) { this._hud(inp); return; }
    // Fixed simulation steps, the same live or recording.
    this._acc = (this._acc || 0) + dt;
    let n = 0;
    const h = 1 / SIM_HZ;
    // A press waits for the next simulation step (a short tap between two steps is not lost).
    const P = this._hits ||= {};
    for (const k of ["jump", "interact", "pickup", "throw", "drop"]) P[k] = P[k] || hit[k];
    while (this._acc >= h && n < 12) { this._sim(inp, { ...hit, ...P }, h); for (const k in P) P[k] = false; this._acc -= h; n++; }
    if (n === 12) this._acc = 0;
    this._clock(dt);
    this._camera(inp, dt);
    this._hud(inp);
  }

  _buttons(hit, inp) {
    if (hit.exit) { if (this.rec) this.stopRec(); else if (this.pending) this.discard(); else { this.stop(); return; } }
    if (hit.record) { if (this.pending) this.again(); else if (this.rec) this.stopRec(); else this.record(); }
    if (hit.keep && this.pending) this.keep();
    if (hit.discard && this.pending) this.discard();
    if (hit.camera) this.cycleCamera();
    const b = this.ctl;
    if (!b || this.pending) return;
    if (hit.lights) this._toggle(b, "headlights", { off: "low", low: "high", high: "off", auto: "low" });
    if (hit.indicator) this._toggle(b, "indicator", { off: "left", left: "right", right: "hazard", hazard: "off" });
    if (hit.lightbar) this._toggle(b, "lightbar", { off: "flash", flash: "off", steady: "off" });
    if (hit.door && b.kind === "car") this._toggle(b, "door_fl", null);
  }

  _toggle(b, ch, next) {
    const a = this._actor(b.id);
    const chans = this.s.partChannels?.(b.id)?.map((c) => c.ch) || [];
    if (!a || !chans.includes(ch)) return;
    const cur = this.s.partValue?.(b.id, ch);
    const v = next ? next[cur] ?? Object.values(next)[0] : (cur || 0) < 5 ? 65 : 0;
    a.parts = { ...(a.parts || {}), [ch]: [{ frame: 0, v }] };
    this._event({ type: "part", id: b.id, ch, v, prev: cur });
    this.say(`${ch === "door_fl" ? "Driver's door" : ch === "headlights" ? "Headlights" : ch === "indicator" ? "Indicators" : "Light bar"}: ${v}${this.rec?.phase === "rec" ? " (recorded)" : ""}.`);
  }

  _event(ev) { if (this.rec?.phase === "rec") this.rec.take.events.push({ ...ev, frame: this._recFrame() }); }

  /** One fixed step of whatever is under control (and of whatever is in the air). */
  _sim(inp, hit, dt) {
    this.vclock += dt;
    const b = this.ctl;
    const frozen = this.rec?.phase === "count";
    if (b && !frozen) {
      const env = this._env(b);
      const I = { ...inp, jumpPressed: hit.jump };
      if (this._wantOut) { I.move = [0, 0]; I.mag = 0; I.throttle = 0; I.sprint = 0; I.brake = 1; }
      if (this.seated && b.kind === "person") { if (hit.interact) this._getOut({ id: this.seated, speed: 0, kind: "seat" }); }
      else if (this._auto) this._autopilot(b, env, dt);
      else if (this.entering || this.exiting) { b.speed *= Math.max(0, 1 - 10 * dt); if (b.car) b.car.step({ throttle: 0, brake: 1, handbrake: 0, steer: b.cs.steer }, dt); }
      else if (b.kind === "person") {
        personStep(b, I, env, dt);
        this._personActions(b, hit, inp, env);
      } else if (b.kind === "horse" || b.kind === "animal") horseStep(b, I, env, dt);
      else if (b.kind === "bike") bikeStep(b, I, env, dt);
      else if (b.kind === "boat") { const y0 = b.yaw; boatStep(b, I, env, dt); b.turnRate = (b.yaw - y0) / dt; }
      else if (b.kind === "prop") propStep(b, I, env, dt);
      else if (b.kind === "car") this._carStep(b, I, env, dt);
      if (b.kind !== "person" && b.kind !== "prop" && (hit.interact || this._wantOut) && this.avatar) this._getOut(b);
      b.walked = (b.walked || 0) + Math.abs(b.speed) * dt;
      if (b.kind === "bike") b.dist = (b.dist || 0) + b.speed * dt;
    }
    this._sequences(dt);
    // Thrown things fly on while you do something else.
    for (const p of this.flying || []) this._flyStep(p, dt);
    // The live gait buffer: half the sim rate (30 Hz), two seconds and a half.
    this._gaitT = (this._gaitT || 0) + dt;
    if (this._gaitT >= 2 / SIM_HZ - 1e-9) {
      this._gaitT = 0;
      for (const lb of this.live.values()) {
        if (lb.kind !== "person" && lb.kind !== "horse" && lb.kind !== "animal") continue;
        lb.hist.push({ p: [lb.x, 0, lb.z], yaw: lb.yaw });
        if (lb.hist.length > 75) lb.hist.shift();
      }
    }
  }

  _carStep(b, inp, env, dt) {
    const c = b.car;
    // Asked to get out while moving: stand on the brake (no automatic reverse) until it has all but stopped.
    const ctl = this._wantOut ? { throttle: 0, brake: 1, handbrake: 0, steer: b.cs.steer || 0, gear: b.cs.gear || "D" } : carControls(inp, c.forward, b.carp, b.cs, dt);
    c.step(ctl, dt);
    b.dist += c.forward * dt;
    // Into a wall, a parked car, a person: two circles along the body, pushed out, the velocity into the wall taken off.
    const fx = Math.sin(c.H), fz = Math.cos(c.H), r = b.box ? b.box.hx : 0.9, half = b.halfLen || 1.3;
    for (const sgn of [1, -1]) {
      const cx = c.X + fx * half * sgn, cz = c.Z + fz * half * sgn;
      const res = env.collide(cx, cz, 0, 1.4, r);
      if (res.hit) { c.X += res.x - cx; c.Z += res.z - cz; c.bump(res.nx, res.nz); }
    }
    b.x = c.X; b.z = c.Z; b.yaw = c.H; b.speed = c.forward;
  }

  // ---------- people: get in, get out, pick up, throw
  /** What the person could do here: [{key, label, id, at: [x, y, z], act}]. */
  nearby(b = this.avatar) {
    if (!b || this.ctl !== b || this.entering || this.exiting) return [];
    const out = [];
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    let bestIn = null, bestUp = null;
    for (const a of this.s.state.actors) {
      if (a.id === b.id || a.mount_id || a.carry_id) continue;
      const g = this.s.actorMeshes.get(a.id);
      if (!g) continue;
      const kind = driveKind(a, this.K);
      const seats = SEATS[a.kind];
      if ((kind === "car" || kind === "boat" || seats) && seats?.length) {
        const spot = this._doorSpot(a, g, 0, [b.x, 0, b.z]);
        const d = Math.hypot(spot[0] - b.x, spot[2] - b.z);
        if (d < 2.6 && (!bestIn || d < bestIn.d) && !this.s.state.actors.some((x) => x.mount_id === a.id && (x.seat ?? 0) === 0))
          bestIn = { d, key: "E", label: kind === "boat" ? "Take the helm" : "Get in", id: a.id, at: [g.position.x, (this._box(a, g)?.hy || 0.7) * 2 + 0.3, g.position.z], act: "enter" };
      } else if (a.kind === "horse" || (this.K.RIDEABLE?.has(a.kind))) {
        const spot = this._mountSpot(a, g);
        const d = Math.hypot(spot[0] - b.x, spot[2] - b.z);
        if (d < 2.4 && (!bestIn || d < bestIn.d)) bestIn = { d, key: "E", label: a.kind === "horse" ? "Mount" : "Get on", id: a.id, at: [g.position.x, (a.height_m || 1.6) * 1.15, g.position.z], act: "mount" };
      } else if (this.K.SITTABLE?.has(a.kind)) {
        const d = Math.hypot(g.position.x - b.x, g.position.z - b.z);
        if (d < 1.4 && (!bestIn || d < bestIn.d)) bestIn = { d, key: "E", label: "Sit", id: a.id, at: [g.position.x, 1.2, g.position.z], act: "sit" };
      }
      if (!this._carry && this._carryable(a, g)) {
        const box = this._box(a, g);
        const dx = g.position.x - b.x, dz = g.position.z - b.z, d = Math.hypot(dx, dz) - Math.max(box?.hx || 0.2, box?.hz || 0.2);
        const ahead = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1);
        if (d < 0.9 && ahead > -0.2 && (!bestUp || d < bestUp.d)) bestUp = { d, key: "C", label: "Pick up", id: a.id, at: [g.position.x, (box ? (box.cy + box.hy) * g.scale.y : 0.5) + 0.35, g.position.z], act: "pickup" };
      }
    }
    if (bestIn) out.push(bestIn);
    if (bestUp) out.push(bestUp);
    if (this._carry) out.push({ key: "F", label: "Throw (hold right mouse / LT to aim)", act: "throw" }, { key: "X", label: "Drop", act: "drop" }, { key: "C", label: "Set down", act: "setdown" });
    if (!this._carry && !b.air && this._env(b).climb(b)) out.push({ key: "Space", label: "Climb", act: "climb" });
    return out;
  }

  _carryable(a, g) {
    if (this.K.NEVER_CARRIED?.has(a.kind) || this.K.PERSON_KINDS?.has(a.kind) || driveKind(a, this.K) !== "prop" || a.mount_id) return false;
    const box = this._box(a, g);
    if (!box) return false;
    const k = g.scale.x || 1;
    return box.hy * 2 * k <= 1.05 && Math.max(box.hx, box.hz) * 2 * k <= 1.6;
  }

  _personActions(b, hit, inp, env) {
    if (hit.interact) {
      const n = this.nearby(b).find((x) => x.key === "E");
      if (n) this._approach(b, n);
    }
    if (this._carry) {
      if (hit.throw) this._release("throw", inp);
      else if (hit.drop) this._release("drop", inp);
      else if (hit.pickup) this._release("setdown", inp);
    } else if (hit.pickup) {
      const n = this.nearby(b).find((x) => x.act === "pickup");
      if (n) this._pickUp(b, n.id);
    }
    this._aimLine(this._carry && inp.aim > 0.5 ? this._throwPreview(b) : null);
    // Gaze: the head follows the camera (or the person the camera is on).
    this._gaze(b);
  }

  _seatLocal(host, seat = 0) {
    const m = MOUNTS[host.kind] || { seat: [0, (host.height_m || 1) * 0.6, 0] };
    const seats = SEATS[host.kind];
    if (seats) { const ref = LIBRARY[host.kind]?.height || 1, k = (host.scale || 1) * ((host.height_m || ref) / ref); const sp = seats[clamp(seat, 0, seats.length - 1)].pos; return [sp[0] * k, sp[1] * k, sp[2] * k]; }
    const k = (host.scale || 1) * (m.scaleWithHeight ? (host.height_m || m.refHeight) / m.refHeight : 1);
    return m.seat.map((v) => v * k);
  }
  _toWorld(g, l) { const c = Math.cos(g.rotation.y), s = Math.sin(g.rotation.y); return [g.position.x + l[0] * c + l[2] * s, g.position.y + l[1], g.position.z - l[0] * s + l[2] * c]; }
  /** Where a person stands to get in at a seat: beside its door, outside the body. */
  _doorSpot(host, g, seat = 0, near = null) {
    const sl = this._seatLocal(host, seat), box = this._box(host, g);
    const out = (box ? box.hx * (g.scale.x || 1) : 0.9) + 0.42;
    const own = Math.sign(sl[0] || 1);
    const spots = [own, -own].map((side) => ({ side, p: this._toWorld(g, [side * out, 0, sl[2] + 0.1]) }));
    // From the far side they get in through the other front door and slide across (the passenger door opens).
    const pick = near ? spots.reduce((a, b) => (Math.hypot(b.p[0] - near[0], b.p[2] - near[2]) < Math.hypot(a.p[0] - near[0], a.p[2] - near[2]) - 0.5 ? b : a)) : spots[0];
    const spot = pick.p;
    spot.door = (pick.side > 0) === (own > 0) ? (own > 0 ? "door_fl" : "door_fr") : (own > 0 ? "door_fr" : "door_fl");
    return spot;
  }
  _mountSpot(host, g) { const sl = this._seatLocal(host, 0); return this._toWorld(g, [0.75 * Math.sqrt((host.height_m || 1.6) / 1.6), 0, sl[2]]); }

  /** Walk over to the door (or the stirrup), then climb in. */
  _approach(b, n) {
    const host = this._actor(n.id), g = this.s.actorMeshes.get(n.id);
    if (!host || !g) return;
    const spot = n.act === "enter" ? this._doorSpot(host, g, 0, [b.x, 0, b.z]) : n.act === "mount" ? this._mountSpot(host, g) : [g.position.x + Math.sin(g.rotation.y) * 0.55, 0, g.position.z + Math.cos(g.rotation.y) * 0.55];
    this._auto = { to: spot, host: n.id, act: n.act, door: spot.door || "door_fl", face: n.act === "sit" ? g.rotation.y + Math.PI : g.rotation.y };
  }

  _autopilot(b, env, dt) {
    const A = this._auto;
    const dx = A.to[0] - b.x, dz = A.to[2] - b.z, d = Math.hypot(dx, dz);
    if (d > 0.08) {
      const want = Math.atan2(dx, dz);
      b.yaw += clamp(wrap(want - b.yaw), -10 * dt, 10 * dt);
      b.speed = Math.min(d / 0.25, Math.max(b.speed, 1.5));
      const step = Math.min(d, b.speed * dt);
      b.x += Math.sin(b.yaw) * step * Math.max(0.2, Math.cos(wrap(want - b.yaw)));
      b.z += Math.cos(b.yaw) * step * Math.max(0.2, Math.cos(wrap(want - b.yaw)));
      A.t = (A.t || 0) + dt;
      if (A.t < 2.5) return;
    }
    // At the door: turn to the way the car faces, then climb in.
    b.speed = 0;
    const err = wrap(A.face - b.yaw);
    if (Math.abs(err) > 0.12 && (A.turnT = (A.turnT || 0) + dt) < 0.6) { b.yaw += clamp(err, -9 * dt, 9 * dt); return; }
    this._auto = null;
    this._enter(b, A.host, A.act, A.door);
  }

  _enter(b, hostId, act, doorCh = "door_fl") {
    const a = this._actor(b.id), host = this._actor(hostId);
    if (!a || !host) return;
    a.mount_id = hostId;
    if (SEATS[host.kind]) a.seat = 0; else delete a.seat;
    if (act === "sit") a.pose = "sit"; else delete a.pose;
    const hop = hopFrames(host.kind, a.pose);
    this.involved.add(hostId);
    this.entering = { id: b.id, host: hostId, act, t: 0, dur: hop / this.fps, hop, door: !!SEATS[host.kind] && this.s.partChannels?.(hostId)?.some((c) => c.ch === doorCh) ? doorCh : null };
    this.entering.f0 = this._recFrame();
    if (this.rec?.phase === "rec" && this.entering.door) for (const k of doorKeys(this.entering.f0, this.entering.f0 + hop)) this.rec.take.events.push({ type: "part", id: hostId, ch: this.entering.door, v: k.v, frame: Math.max(0, k.f), prev: 0 });
    this.say(act === "enter" ? `${this._name(a)} opens the door and gets into ${this._name(host)}.` : act === "mount" ? `${this._name(a)} climbs onto ${this._name(host)}.` : `${this._name(a)} sits down.`);
  }

  /** Climbing in and getting out, frame by frame (the door, the arc, the hand-over of control). */
  _sequences(dt) {
    const E = this.entering;
    if (E) {
      E.t += dt / E.dur;
      const a = this._actor(E.id), host = this._actor(E.host);
      const door = E.door ? doorAt(doorKeys(0, E.hop), E.t * E.hop) : null;
      if (door != null) host.parts = { ...(host.parts || {}), [E.door]: [{ frame: 0, v: door }] };
      if (E.t < 1) a.mount_at = this.s.frame + E.hop * (1 - E.t);   // the stage's own climb-in arc, at this moment of it
      else {
        delete a.mount_at;

        E.closing = 0;
        this.entering = null;
        if (E.act !== "sit") {
          const hb = this._take(E.host);
          if (hb) { this.cam.idle = 0; this.say(`${host.kind === "horse" ? "Riding" : "Driving"} ${this._name(host)}. E ${host.kind === "horse" ? "dismounts" : "gets out"}.`); }
        } else this.ctl = this.live.get(E.id) || this.ctl;
        if (E.act === "sit") { this.seated = E.host; }
        this._shutDoor = E.door ? { id: E.host, t: 0, ch: E.door } : null;
      }
    }
    if (this._shutDoor) {   // the door swings shut behind them
      const S = this._shutDoor; S.t += dt;
      const host = this._actor(S.id), v = 65 * (1 - sstep(S.t / (8 / this.fps)));
      if (host) host.parts = { ...(host.parts || {}), [S.ch || "door_fl"]: [{ frame: 0, v }] };
      if (S.t > 8 / this.fps) this._shutDoor = null;
    }
    const X = this.exiting;
    if (X) {
      X.t0 += dt;
      const lead = X.door ? DOOR_LEAD / this.fps : 0;
      const host = this._actor(X.host), a = this._actor(X.id);
      if (X.door) host.parts = { ...(host.parts || {}), door_fl: [{ frame: 0, v: 65 * sstep(X.t0 / Math.max(lead, 1e-3)) }] };
      X.t = clamp((X.t0 - lead) / X.dur, 0, 1);
      if (X.t0 >= lead && !X.marked) { X.marked = true; X.f = this._recFrame(); if (this.rec?.phase === "rec" && X.door) for (const k of exitDoorKeys(X.f, X.n)) this.rec.take.events.push({ type: "part", id: X.host, ch: "door_fl", v: k.v, frame: Math.max(0, k.f), prev: 0 }); }
      if (X.t0 < lead) X.t = 0;
      if (X.t >= 1) {
        delete a.mount_id; delete a.mount_at; delete a.seat; delete a.pose;
        const pb = this.avatar;
        Object.assign(pb, { x: X.stand.x, y: X.stand.y, z: X.stand.z, yaw: X.stand.yaw, speed: 0, air: false, hist: [] });
        this.exiting = null;
        this.ctl = pb;
        this.cam.idle = 0;
        this._shutDoor = X.door ? { id: X.host, t: 0, ch: "door_fl" } : null;
        this.say(`${this._name(a)} is on foot again.`);
      }
    }
  }

  _getOut(b) {
    this._wantOut = false;
    const p = this.avatar, a = p && this._actor(p.id);
    if (!a || a.mount_id !== b.id) return;
    if (Math.abs(b.speed) > 2.2) { this._wantOut = true; return; }   // slow down first (it brakes for you)
    const host = this._actor(b.id), g = this.s.actorMeshes.get(b.id);
    const spot = host.kind === "horse" || this.K.RIDEABLE?.has(host.kind) ? this._mountSpot(host, g) : SEATS[host.kind] ? this._doorSpot(host, g, a.seat ?? 0) : this._toWorld(g, [0, 0, 0.8]);
    const y = this.s._supportAt?.(spot[0], spot[2], 0) ?? 0;
    const n = exitFrames(host.kind);
    const door = !!SEATS[host.kind] && (a.seat ?? 0) === 0 && this.s.partChannels?.(b.id)?.some((c) => c.ch === "door_fl");
    this.exiting = { id: a.id, host: b.id, t: 0, t0: 0, dur: n / this.fps, n, door, stand: { x: spot[0], y, z: spot[2], yaw: g.rotation.y } };
    Object.assign(p, { x: spot[0], y, z: spot[2], yaw: g.rotation.y, speed: 0 });   // (recorded as where they step out to)
    this.seated = null;
    this.say(host.kind === "horse" ? `${this._name(a)} swings down from ${this._name(host)}.` : `${this._name(a)} opens the door and gets out.`);
  }

  _pickUp(b, id) {
    const o = this._actor(id);
    if (!o) return;
    o.carry_id = b.id;
    o.carry_at = 0;
    this.involved.add(id);
    this._carry = { id, t: 0 };
    this.say(`${this._name(this._actor(b.id))} picks up ${this._name(o)}. F throws it (hold the right mouse button to aim), X drops it, C sets it down.`);
  }

  _release(how, inp) {
    const C = this._carry, o = this._actor(C?.id), g = o && this.s.actorMeshes.get(o.id), b = this.avatar;
    if (!o || !g || !b) return;
    g.updateMatrixWorld(true);
    const box = this._box(o, g) || { cx: 0, cy: 0.3, cz: 0, hx: 0.3, hy: 0.3, hz: 0.3 };
    const k = g.scale.x || 1;
    const q = [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w];
    const c = new THREE.Vector3(box.cx * k, box.cy * k, box.cz * k).applyQuaternion(g.quaternion).add(g.position);
    delete o.carry_id; delete o.carry_at;
    this._carry = null;
    const yaw = inp.aim > 0.5 ? this.cam.yaw : b.yaw;
    const bv = [Math.sin(b.yaw) * b.speed, Math.cos(b.yaw) * b.speed];
    const p = { id: o.id, c: c.toArray(), q, half: [box.hx * k, box.hy * k, box.hz * k], local: [box.cx * k, box.cy * k, box.cz * k], w: [0, 0, 0] };
    if (how === "throw") {
      const pitch = inp.aim > 0.5 ? clamp(-this.cam.pitch + 0.25, 0.05, 0.9) : 0.22;
      p.v = throwVelocity(yaw, pitch, 9, bv);
      p.w = [Math.cos(yaw) * 7, 1.5, -Math.sin(yaw) * 7];   // end over end
      this.say(`${this._name(this._actor(b.id))} throws ${this._name(o)}.`);
    } else if (how === "drop") { p.v = [bv[0], 0, bv[1]]; p.w = [0.8, 0, 0.5]; this.say(`${this._name(o)} is dropped.`); }
    else {   // set down: in front, on whatever is there
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw), d = 0.45 + Math.max(p.half[0], p.half[2]);
      const x = b.x + fx * d, z = b.z + fz * d, y = this.s._supportAt?.(x, z, b.y + 0.3) ?? 0;
      p.c = [x, y + p.half[1], z];
      p.q = restQuat([0, Math.sin(b.yaw / 2), 0, Math.cos(b.yaw / 2)]);
      p.v = [0, 0, 0];
      p.rest = false; p.still = 0.25;
      this.say(`${this._name(o)} is set down.`);
    }
    const lb = this.live.get(o.id) || this._make(o.id);
    if (lb) { lb.kind = "prop"; lb.thrown = p; this._flyApply(lb, p); }
    (this.flying ||= []).push(p);
    this._aimLine(null);
  }

  _flyStep(p, dt) {
    if (p.rest) return;
    const lb = this.live.get(p.id);
    projectileStep(p, this._env({ id: p.id, kind: "prop" }), dt);
    if (lb) this._flyApply(lb, p);
  }

  _flyApply(lb, p) {
    _q.set(...p.q);
    const o = new THREE.Vector3(...p.local).applyQuaternion(_q);
    lb.x = p.c[0] - o.x; lb.y = p.c[1] - o.y; lb.z = p.c[2] - o.z;
    lb.q = [...p.q];
    lb.yaw = new THREE.Euler().setFromQuaternion(_q, "YXZ").y;
  }

  _throwPreview(b) {
    const o = this._actor(this._carry.id), g = o && this.s.actorMeshes.get(o.id);
    if (!g) return null;
    const pitch = clamp(-this.cam.pitch + 0.25, 0.05, 0.9);
    const v = throwVelocity(this.cam.yaw, pitch, 9, [Math.sin(b.yaw) * b.speed, Math.cos(b.yaw) * b.speed]);
    const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3());
    return throwArc(c.toArray(), v);
  }

  _aimLine(pts) {
    const scene = this.s.gizmoScene;
    if (!scene) return;
    if (!pts) { if (this._arc) this._arc.visible = false; return; }
    if (!this._arc) {
      this._arc = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xf2ff59, dashSize: 0.18, gapSize: 0.12, depthTest: false }));
      this._arc.renderOrder = 998;
      scene.add(this._arc);
    }
    this._arc.geometry.setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
    this._arc.computeLineDistances();
    this._arc.visible = true;
  }

  _gaze(b) {
    const a = this._actor(b.id);
    if (!a) return;
    const rel = wrap(this.cam.yaw - b.yaw) / DEG;
    let target = Math.abs(rel) > 110 ? "ahead" : rel > 35 ? "left" : rel < -35 ? "right" : "ahead";
    // Someone the camera is on (within 10° of its line, 20 m): look at them.
    let best = null;
    for (const o of this.s.state.actors) {
      if (o.id === b.id || !this.K.PERSON_KINDS?.has(o.kind) || o.id === this.avatar?.id) continue;
      const g = this.s.actorMeshes.get(o.id);
      if (!g) continue;
      const dx = g.position.x - b.x, dz = g.position.z - b.z, d = Math.hypot(dx, dz);
      const off = Math.abs(wrap(Math.atan2(dx, dz) - this.cam.yaw)) / DEG, rb = Math.abs(wrap(Math.atan2(dx, dz) - b.yaw)) / DEG;
      if (d < 20 && off < 10 && rb < 110 && (!best || off < best.off)) best = { id: o.id, off };
    }
    if (best && this.cam.mode !== "shot") target = best.id;
    // A new look has to hold for a beat before the head goes (no flicker while the camera swings round behind).
    if (target !== this._gazeNow?.target) {
      if (this._gazeWant?.target !== target) this._gazeWant = { target, t: this.vclock };
      if (this._gazeNow && this.vclock - this._gazeWant.t < 0.45) target = this._gazeNow.target;
    } else this._gazeWant = null;
    if (target === this._gazeNow?.target) {
      const kf = Math.max(0, Math.round(this.s.frame - (this.vclock - this._gazeNow.t) * this.fps));
      a.gaze = [{ frame: this.rec?.phase === "rec" ? this._gazeNow.f : kf, target }];
      return;
    }
    this._gazeNow = { target, t: this.vclock, f: this._recFrame() };
    a.gaze = [{ frame: this.s.frame, target }];
    this._event({ type: "gaze", id: b.id, target });
  }

  // ---------- time and recording
  _recFrame() { return this.rec?.phase === "rec" ? Math.floor(this.rec.f) : this.s.frame; }

  /** ● REC: a 3-2-1 countdown at the start frame, then the timeline plays while you drive. */
  record() {
    if (this.rec || this.pending) return;
    const f0 = this.fromStart ? 0 : this.s.frame;
    this.rec = { phase: "count", left: 3, f0, f: f0, take: { start: f0, fps: this.fps, tracks: {}, events: [], ctl: this.ctl?.id } };
    this.s.setFrame(f0);
    this.say(`Recording from frame ${f0} in 3…`);
  }

  stopRec() {
    const R = this.rec;
    if (!R) return;
    this.rec = null;
    if (R.phase !== "rec" || !Object.keys(R.take.tracks).length) { this.say("Recording cancelled."); return; }
    R.take.end = Math.floor(R.f);
    this._review(R.take);
  }

  _clock(dt) {
    const R = this.rec;
    if (!R) { this.s._obsCache = null; this.s.setFrame(this.s.frame); return; }
    if (R.phase === "count") {
      R.left -= dt;
      if (R.left <= 0) { R.phase = "rec"; R.f = R.f0; this._sample(R.f0); this.say("● Recording. R (or Start) stops; the take ends at the end of the shot."); }
      this.s.setFrame(R.f0);
      return;
    }
    const last = this.s._lastFrame();
    const prev = Math.floor(R.f);
    R.f = Math.min(last, R.f + dt * this.fps);
    this.s._obsCache = null;
    for (let f = prev + 1; f <= Math.floor(R.f); f++) { this.s.setFrame(f); this._sample(f); }
    if (Math.floor(R.f) === prev) this.s.setFrame(prev);
    this.s.onDriveFrame?.(Math.floor(R.f));
    if (R.f >= last) this.stopRec();
  }

  /** One recorded frame: every live object, from the stage as it was just posed. */
  _sample(f) {
    const T = this.rec.take.tracks;
    const add = (id, type, s) => { (T[id] ||= { type, samples: [] }).samples.push({ f, ...s }); };
    for (const [id, b] of this.live) {
      const a = this._actor(id), g = this.s.actorMeshes.get(id);
      if (!a || !g) continue;
      if (b.thrown || a.carry_id) { add(id, "baked", { p: g.position.toArray(), q: g.quaternion.toArray(), by: a.carry_id || null }); continue; }
      if (b.kind === "person") {
        // From the live sequence itself (not mount_at, which is set against the frame before this one).
        let mode = "foot";
        if (this.entering?.id === id) mode = "hop";
        else if (this.exiting?.id === id) mode = this.exiting.marked ? "exit" : "mounted";
        else if (a.mount_id) mode = "mounted";
        const s = { p: [b.x, b.y, b.z], yaw: b.yaw, mode, air: b.air };
        if (mode !== "foot") { s.host = a.mount_id || this.entering?.host; s.seat = a.seat ?? null; s.pose = a.pose ?? null; }
        add(id, "person", s);
        continue;
      }
      if (b.kind === "car") { add(id, "car", { p: [b.car.X, 0, b.car.Z], yaw: b.car.H, roll: b.car.roll, pitch: b.car.pitch, steer: b.car.ctl.steer, smoke: b.car.smokeInfo }); T[id].surface = b.surface; continue; }
      add(id, b.kind === "prop" ? "prop" : "path", { p: [b.x, b.y, b.z], yaw: b.yaw });
    }
    // Something carried by the person (not live itself): its place in their hands.
    for (const a of this.s.state.actors) {
      if (!a.carry_id || this.live.has(a.id) || !this.involved.has(a.id)) continue;
      const g = this.s.actorMeshes.get(a.id);
      if (g) add(a.id, "baked", { p: g.position.toArray(), q: g.quaternion.toArray(), by: a.carry_id });
    }
  }

  /** The take is on the timeline for review (played back once); Keep, Discard or Again. */
  _review(take) {
    // Gather the pick-up's frames for a carried prop that was then thrown: one baked track from first touch to rest.
    const snap = this.snap;
    this._restore(snap);
    const mute = this.s._muteRecord;
    this.s._muteRecord = true;
    let summary;
    try { summary = applyTake(this.s, take, { smoothing: this.smoothing }); } finally { this.s._muteRecord = mute; }
    this.pending = { take, snap, summary };
    this.s.setFrame(take.start);
    this._playback(take.start, take.end);
    this.say(`Take: ${summary.join("; ")}. Enter keeps it, Backspace discards, R records it again.`);
  }

  _playback(f0, f1) {
    const t0 = performance.now();
    const tick = () => {
      if (!this.pending) return;
      const f = Math.min(f1, f0 + Math.floor((performance.now() - t0) / 1000 * this.fps));
      this.s.setFrame(f);
      this.s.onDriveFrame?.(f);
      this._camFollowPlayback();
      if (f < f1) this._pbRaf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this._pbRaf);
    this._pbRaf = requestAnimationFrame(tick);
  }

  _camFollowPlayback() {
    const id = this.ctl?.id, g = id && this.s.actorMeshes.get(id);
    if (!g || this.cam.mode === "shot") return;
    this._camUpdate({ x: g.position.x, y: g.position.y, z: g.position.z, yaw: g.rotation.y, kind: this.ctl.kind, speed: g.userData.speed || 0 }, 1 / 60, [0, 0], [0, 0]);
  }

  /** Re-apply the pending take with another smoothing. */
  setSmoothing(name) {
    this.smoothing = name;
    if (!this.pending) return;
    this._restore(this.pending.snap);
    const mute = this.s._muteRecord; this.s._muteRecord = true;
    try { this.pending.summary = applyTake(this.s, this.pending.take, { smoothing: name }); } finally { this.s._muteRecord = mute; }
    this.s.setFrame(this.s.frame);
  }

  keep() {
    const P = this.pending;
    if (!P) return;
    cancelAnimationFrame(this._pbRaf);
    this.pending = null;
    this.s.onChange(this.s.toJSON());           // ONE undo step for the whole take
    this.snap = clone(this.s.state.actors);     // the next take layers on this one
    this.takes = (this.takes || 0) + 1;
    this._resume(P.take.end);
    this.say(`Take ${this.takes} kept (${P.summary.join("; ")}). Rewind and drive someone else to layer another take.`);
  }

  discard(silent = false) {
    const P = this.pending;
    if (!P) return;
    cancelAnimationFrame(this._pbRaf);
    this.pending = null;
    this._restore(P.snap);
    this._resume(this.s.frame);
    if (!silent) this.say("Take discarded.");
  }

  again() {
    const P = this.pending;
    if (!P) return;
    this.discard(true);
    this.record();
  }

  /** After a take: everything plays from its keys; control picks up the controlled object where it now stands. */
  _resume(frame) {
    const ctlId = this.ctl?.id;
    this.live.clear(); this.involved.clear();
    this.flying = []; this._carry = null; this.entering = null; this.exiting = null; this._auto = null;
    this.s.setFrame(frame);
    const a = this._actor(ctlId);
    // In a car at the end of the take: carry on driving it (the driver stays in their seat).
    const rider = this.avatar && this._actor(this.avatar.id);
    this.avatar = null;
    if (rider?.mount_id && this._actor(rider.mount_id)) {
      this.avatar = this._make(rider.id);
      this._take(rider.mount_id);
    } else if (a) this._take(a.id);
  }

  // ---------- camera
  cycleCamera() {
    const order = ["chase", "shot", "orbit"];
    this.cam.mode = order[(order.indexOf(this.cam.mode) + 1) % order.length];
    if (this.cam.mode === "shot") this.s.previewCamera(null);
    this.say(`Camera: ${{ chase: "follow (chase)", shot: "the shot camera, fixed", orbit: "orbit (drag or right stick)" }[this.cam.mode]}.`);
  }

  setCamera(mode) { if (["chase", "shot", "orbit"].includes(mode)) { this.cam.mode = mode; if (mode === "shot") this.s.previewCamera(null); } }

  _camera(inp, dt) {
    const b = this.ctl;
    if (!b) return;
    const g = this.s.actorMeshes.get(b.id);
    const pos = g ? { x: g.position.x, y: b.kind === "prop" ? g.position.y : b.y || 0, z: g.position.z, yaw: g.rotation.y, kind: b.kind, speed: b.speed } : b;
    this._camUpdate(pos, dt, inp.look, inp.lookPx);
  }

  _camUpdate(p, dt, look, px) {
    const C = this.cam;
    if (C.mode === "shot") return;
    const big = p.kind === "car" || p.kind === "boat";
    const dist = C.userDist ?? (p.kind === "person" ? 3.8 : p.kind === "horse" ? 5.6 : big ? 7.5 : p.kind === "bike" ? 4.5 : 4.5);
    C.dist += (dist - C.dist) * clamp(3 * dt, 0, 1);
    const lx = (look?.[0] || 0) * 2.6 * dt + (px?.[0] || 0) * 0.005, ly = (look?.[1] || 0) * 1.6 * dt + (px?.[1] || 0) * 0.004;
    if (Math.abs(lx) + Math.abs(ly) > 1e-4) C.idle = 0; else C.idle += dt;
    C.yaw -= lx;
    C.pitch = clamp(C.pitch - ly, -1.2, 0.5);
    // Chase: it swings back in behind a moving object after a moment without looking (vehicles faster, and not in reverse).
    if (C.mode === "chase" && C.idle > (big ? 0.6 : 1.4) && Math.abs(p.speed) > 0.6 && !(big && p.speed < 0)) {
      C.yaw += wrap(p.yaw - C.yaw) * clamp((big ? 2.2 : 1.2) * dt, 0, 1);
      C.pitch += (-0.2 - C.pitch) * clamp(dt, 0, 1);
    }
    const ty = p.y + (p.kind === "person" ? 1.45 : p.kind === "horse" ? 2.0 : big ? 1.1 : 0.9);
    const tgt = new THREE.Vector3(p.x, ty, p.z);
    const f = new THREE.Vector3(Math.sin(C.yaw) * Math.cos(C.pitch), Math.sin(C.pitch), Math.cos(C.yaw) * Math.cos(C.pitch));
    const want = tgt.clone().addScaledVector(f, -C.dist);
    want.y = Math.max(0.3, want.y);
    if (!C.pos) { C.pos = want.clone(); C.tgt = tgt.clone(); }
    const k = 1 - Math.exp(-dt * 9), kt = 1 - Math.exp(-dt * 14);
    C.pos.lerp(want, k); C.tgt.lerp(tgt, kt);
    this.s.previewCamera({ position: C.pos.toArray(), target: C.tgt.toArray(), focal_mm: big ? 28 : 30 });
  }

  // ---------- HUD
  info(inp = this.lastInput || {}) {
    const b = this.ctl, a = b && this._actor(b.id);
    const speed = b ? (b.kind === "car" ? b.car.forward : b.speed) : 0;
    const R = this.rec;
    return {
      name: this._name(a), kind: b?.kind || null, speed, kmh: Math.abs(speed) * 3.6,
      gear: b?.kind === "car" ? b.car.gearLabel : null,
      gait: b && (b.kind === "person" || b.kind === "horse") ? (b.air ? "jump" : b.climb ? "climb" : gaitFor(b.kind, speed, b.height)) : null,
      slip: b?.kind === "car" ? Math.round(Math.abs(b.car.beta)) : null,
      rec: R ? { phase: R.phase, count: Math.ceil(R.left || 0), frame: Math.floor(R.f), fps: this.fps } : null,
      pending: this.pending ? { summary: this.pending.summary, start: this.pending.take.start, end: this.pending.take.end } : null,
      camera: this.cam.mode, smoothing: this.smoothing, fromStart: this.fromStart, takes: this.takes || 0,
      prompts: this.pending || !b ? [] : this.seated && b.kind === "person" ? [{ key: "E", label: "Stand up", act: "exit" }] : b.kind === "person" ? this.nearby(b) : this.avatar ? [{ key: "E", label: b.kind === "horse" ? "Dismount" : "Get out", act: "exit" }] : [],
      busy: this.entering ? "Getting in" : this.exiting ? "Getting out" : this._auto ? "Walking over" : null,
      input: inp, pad: !!inp.pad, frame: this.s.frame, last: this.s._lastFrame(),
    };
  }

  _hud(inp) { try { this.hud?.update?.(this.info(inp)); } catch (err) { console.warn("Soundstage drive HUD", err); } }

  /** Screen position (canvas px) of a world point, for the context prompts. */
  project(p) {
    const cam = this.s._viewportCamera?.() || this.s.camera;
    const v = new THREE.Vector3(...p).project(cam);
    const r = this.s.canvas.getBoundingClientRect();
    return v.z > 1 ? null : [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height];
  }
}

/** Add "🎮 Drive" to the stage's floating object bar and keep it shown only for drivable selections. */
export function installDriveButton(stage) {
  const tick = () => {
    const bar = stage.rotTools?.bar;
    if (bar && !bar.querySelector("[data-drive]")) {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.drive = "1";
      b.title = "Drive it like a video game: keyboard, mouse or a game controller; ● REC records it as keys (D)";
      b.setAttribute("aria-label", "Drive (D)");
      b.textContent = "🎮 Drive";
      b.addEventListener("click", () => stage.drive?.start(stage.selected));
      bar.append(Object.assign(document.createElement("i"), { className: "sep" }), b);
    }
    const btnEl = bar?.querySelector("[data-drive]");
    if (btnEl) { const ok = !!stage.selected && stage.drive?.canDrive(stage.selected); btnEl.style.display = ok ? "" : "none"; if (btnEl.previousSibling) btnEl.previousSibling.style.display = ok ? "" : "none"; }
  };
  const id = setInterval(() => { if (!stage.canvas?.isConnected && stage._driveBtnStarted) { clearInterval(id); return; } stage._driveBtnStarted = true; tick(); }, 400);
  return () => clearInterval(id);
}
