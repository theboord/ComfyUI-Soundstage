// Soundstage physics on the GPU: three-avbd (Augmented Vertex Block Descent, Giles, Diaz and Yuksel, SIGGRAPH 2025)
// as the live solver of the stage, behind the same small engine interface as the CPU XPBD solver (physics.mjs).
//
// How it runs: the solver lives on its own WebGPU device (navigator.gpu), next to the stage's WebGLRenderer. Nothing is
// shared with WebGL: each frame the stage hands in kinematic targets (cars, people, a dragged prop), `step(dt)` runs
// fixed 1/60 s steps with bounded catch-up, and an async readback (mapAsync, one frame behind, at most two) brings the
// poses back to the CPU, where `getPose(id)` gives them to the stage's own meshes.
//
// What the adapter adds over the bare library, for real-world feel:
//  - real masses: a body's density is its mass over its collision volume, so a 2 kg carton and a 30 kg crate push
//    each other the way they should (AVBD is good at big mass ratios);
//  - the 1 cm contact margin the solver rests at is taken back: every collision shape is grown by AVBD_MARGIN, so a
//    resting stack shows no overlap and doesn't sink 1 cm per box;
//  - no bounce: AVBD's contacts are inelastic (no restitution), which is what crates and cartons do; `bounce` is kept
//    on the description for the CPU solver and ignored here;
//  - light air and rolling damping, applied as impulses from the last readback (the solver has none of its own);
//  - sleeping: a body still for half a second is pinned (made fixed) where it lies, so a stack at rest has no jitter
//    and no creep; anything coming near it (a moving body's or a kinematic target's box) wakes it first.
//
// Pure helpers (mapping a description to solver options, poses, the backend choice, a CPU raycast over the poses) are
// exported for tests; everything that needs WebGPU is inside createWorld and is verified in the browser.

export const NAME = "avbd";
/** The solver's contact margin (three-avbd COLLISION_MARGIN): contacts come to rest this far into each other. */
export const AVBD_MARGIN = 0.01;
export const FIXED_DT = 1 / 60;
/** Steps one frame may run to catch up (time owed past them is dropped: no spiral of death). */
export const MAX_SUBSTEPS = 3;
/** Solver iterations per step. The paper's 10 costs ~2.7 ms per iteration on a Radeon Pro Vega 56 (Metal) once a pile
 *  is in contact (a dispatch per colour per iteration), which outruns a 60 Hz frame; 6 keeps stacks stiff and fits. */
export const ITERATIONS = 6;
export const MIN_ITERATIONS = 4;
/** Steps the GPU may fall behind the readbacks before steps are skipped (slow motion beats a world seconds late). */
export const MAX_BACKLOG = 6;
/** Error-correction blend (the paper's alpha): the library's 0.99 leaves an impact's overlap in for seconds (a crate
 *  dropped 30 cm stays 25 mm into the floor after a second); 0.9 takes it out in about half a second, without pops. */
export const ALPHA = 0.9;
/** Sleep: below these speeds for SLEEP_TIME seconds. Wake: a moving box comes within WAKE_GAP (m) of it. */
export const SLEEP = Object.freeze({ linear: 0.04, angular: 0.08, time: 0.5, wakeGap: 0.04 });
/** Damping per second: air drag on everything, rolling resistance on spheres. */
export const DAMPING = Object.freeze({ linear: 0.02, angular: 0.08, rolling: 1.2 });
/** Speeds (m/s) past which a kinematic target is a jump (a scrub, a teleport), set there rather than slid there. */
export const TELEPORT_SPEED = 60;
export const LABELS = Object.freeze({ avbd: "Physics: GPU (AVBD)", xpbd: "Physics: CPU" });

// ---------- small vector / quaternion kit (arrays; quaternions are [x, y, z, w]) ----------
const qrot = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const qnorm = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const finite3 = (v, d) => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [+v[0], +v[1], +v[2]] : d);
const finiteQ = (q) => (Array.isArray(q) && q.length >= 4 && q.slice(0, 4).every(Number.isFinite) && Math.hypot(...q.slice(0, 4)) > 1e-9 ? qnorm(q) : [0, 0, 0, 1]);

/**
 * A body's type: "dynamic" (falls, tumbles, is pushed), "static" (set dressing, never moves unless placed) or
 * "kinematic" (moves where it's told: cars, people, a climbing person). From desc.type (physengine.mjs), desc.mode, or
 * the physics.mjs spec's `dynamic` flag. Static and kinematic bodies are both fixed bodies in the solver.
 */
export function modeOf(desc) {
  const m = desc?.type ?? desc?.mode;
  if (m === "dynamic" || m === "kinematic" || m === "static") return m;
  if (desc?.dynamic === false) return "kinematic";
  return desc?.dynamic || m == null ? "dynamic" : "kinematic";
}

/**
 * A body description (the physics.mjs spec: { id, shape: "box" | "sphere", half, center, radius, mass, friction,
 * dynamic | mode, pos, quat, velocity }) as three-avbd World.addBox / addSphere options. pos/quat are the object's
 * origin pose; the solver body sits at the collision shape's centre, grown by the contact margin.
 */
export function avbdOptions(desc, margin = AVBD_MARGIN) {
  const mode = modeOf(desc);
  const sphere = desc?.shape === "sphere";
  const half = finite3(desc?.half, [0.5, 0.5, 0.5]).map((h) => Math.max(0.01, Math.abs(h)));
  const center = finite3(desc?.center, [0, 0, 0]);
  const quat = finiteQ(desc?.quat);
  const origin = finite3(desc?.pos, [0, 0, 0]);
  const c = qrot(quat, center);
  const position = [origin[0] + c[0], origin[1] + c[1], origin[2] + c[2]];
  const mass = Math.max(0.05, Number.isFinite(+desc?.mass) && +desc.mass > 0 ? +desc.mass : 20);
  const friction = Math.max(0, Math.min(1.5, Number.isFinite(+desc?.friction) ? +desc.friction : 0.6));
  const out = { mode, position, rotation: quat, friction, fixed: mode !== "dynamic" || !!desc?.asleep, mass };
  if (sphere) {
    const r = Math.max(0.01, Number.isFinite(+desc?.radius) && +desc.radius > 0 ? +desc.radius : Math.min(...half));
    out.shape = "sphere";
    out.radius = r + margin / 2;
    out.density = mass / ((4 / 3) * Math.PI * out.radius ** 3);
    out.inertia = [0.4 * mass * r * r, 0.4 * mass * r * r, 0.4 * mass * r * r];
  } else {
    out.shape = "box";
    out.size = half.map((h) => 2 * h + margin);
    out.density = mass / (out.size[0] * out.size[1] * out.size[2]);
    const e = half.map((h) => 2 * h);
    out.inertia = [mass / 12 * (e[1] ** 2 + e[2] ** 2), mass / 12 * (e[0] ** 2 + e[2] ** 2), mass / 12 * (e[0] ** 2 + e[1] ** 2)];
  }
  const v = finite3(desc?.velocity, null);
  if (v && mode === "dynamic") out.velocity = v;
  return out;
}

/** The object's origin pose from the solver body's pose (the inverse of avbdOptions' placement). */
export function originPose(bodyPos, bodyRot, center = [0, 0, 0]) {
  const q = finiteQ(bodyRot), c = qrot(q, center);
  return { pos: [bodyPos[0] - c[0], bodyPos[1] - c[1], bodyPos[2] - c[2]], quat: q };
}

/** Steps a readback pose is carried forward at most (past that the readback is late, and guessing further is worse). */
export const MAX_EXTRAPOLATE = 4;

/** An origin pose moved on by `age` seconds at linear velocity v and angular velocity w (both of the centre of mass). */
export function extrapolate(pose, v, w, age, center = [0, 0, 0]) {
  const c0 = qrot(pose.quat, center);
  const com = [pose.pos[0] + c0[0] + v[0] * age, pose.pos[1] + c0[1] + v[1] * age, pose.pos[2] + c0[2] + v[2] * age];
  const ang = Math.hypot(w[0], w[1], w[2]) * age;
  let q = pose.quat;
  if (ang > 1e-9) {
    const s = Math.sin(ang / 2) / (ang / age), dq = [w[0] * s, w[1] * s, w[2] * s, Math.cos(ang / 2)];
    q = qnorm([dq[3] * q[0] + dq[0] * q[3] + dq[1] * q[2] - dq[2] * q[1], dq[3] * q[1] - dq[0] * q[2] + dq[1] * q[3] + dq[2] * q[0],
      dq[3] * q[2] + dq[0] * q[1] - dq[1] * q[0] + dq[2] * q[3], dq[3] * q[3] - dq[0] * q[0] - dq[1] * q[1] - dq[2] * q[2]]);
  }
  const c1 = qrot(q, center);
  return { pos: [com[0] - c1[0], com[1] - c1[1], com[2] - c1[2]], quat: q };
}

/** World-space axis-aligned bounds of a box (centre, rotation, full size) or a sphere (radius), grown by `pad`. */
export function aabbOf(shape, pos, rot, sizeOrRadius, pad = 0) {
  let e;
  if (shape === "sphere") e = [sizeOrRadius, sizeOrRadius, sizeOrRadius];
  else {
    const h = sizeOrRadius.map((s) => s / 2);
    const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((u) => qrot(rot, u));
    e = [0, 1, 2].map((k) => Math.abs(ax[0][k]) * h[0] + Math.abs(ax[1][k]) * h[1] + Math.abs(ax[2][k]) * h[2]);
  }
  return { min: [0, 1, 2].map((k) => pos[k] - e[k] - pad), max: [0, 1, 2].map((k) => pos[k] + e[k] + pad) };
}
export const aabbOverlap = (a, b) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
  && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];

/**
 * Nearest hit of a ray on boxes and spheres (the solver bodies as last read): [{ id, shape, pos, rot, size | radius }].
 * Sync and on the CPU, so a click can pick a prop at once. Returns { id, distance, point, normal } or null.
 */
export function raycastShapes(shapes, origin, direction, maxDistance = Infinity) {
  const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const d = direction.map((v) => v / dl);
  let best = null;
  for (const s of shapes) {
    let t = null, n = null;
    if (s.shape === "sphere") {
      const oc = [origin[0] - s.pos[0], origin[1] - s.pos[1], origin[2] - s.pos[2]];
      const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2], c = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - s.radius ** 2;
      const disc = b * b - c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      t = -b - sq >= 0 ? -b - sq : -b + sq >= 0 ? 0 : null;
      if (t === null) continue;
      const p = origin.map((o, k) => o + d[k] * t);
      const nl = Math.hypot(p[0] - s.pos[0], p[1] - s.pos[1], p[2] - s.pos[2]) || 1;
      n = [(p[0] - s.pos[0]) / nl, (p[1] - s.pos[1]) / nl, (p[2] - s.pos[2]) / nl];
    } else {
      // Slab test in the box's own frame.
      const iq = qconj(s.rot);
      const o = qrot(iq, [origin[0] - s.pos[0], origin[1] - s.pos[1], origin[2] - s.pos[2]]), dd = qrot(iq, d);
      let t0 = -Infinity, t1 = Infinity, axis = -1, sign = 0;
      let miss = false;
      for (let k = 0; k < 3; k++) {
        const h = s.size[k] / 2;
        if (Math.abs(dd[k]) < 1e-12) { if (o[k] < -h || o[k] > h) { miss = true; break; } continue; }
        let a = (-h - o[k]) / dd[k], b = (h - o[k]) / dd[k], sg = -1;
        if (a > b) { [a, b] = [b, a]; sg = 1; }
        if (a > t0) { t0 = a; axis = k; sign = sg; }
        t1 = Math.min(t1, b);
        if (t0 > t1) { miss = true; break; }
      }
      if (miss || t1 < 0) continue;
      t = Math.max(0, t0);
      const ln = [0, 0, 0];
      if (axis >= 0 && t0 >= 0) ln[axis] = sign; else ln[1] = 1;
      n = qrot(s.rot, ln);
    }
    if (t <= maxDistance && (!best || t < best.distance)) best = { id: s.id, distance: t, point: origin.map((o, k) => o + d[k] * t), normal: n };
  }
  return best;
}

/**
 * Which backend the stage should use. AVBD only when it's switched on (the experimental toggle: `pref` "avbd"), WebGPU
 * is there and a device came up; otherwise the CPU solver. `pref` "auto" picks AVBD whenever it can run.
 */
export function chooseBackend({ gpu = false, device = false, lost = false, pref = "xpbd" } = {}) {
  const can = gpu && device && !lost;
  return can && (pref === "avbd" || pref === "auto") ? "avbd" : "xpbd";
}
export const backendLabel = (backend) => LABELS[backend] || LABELS.xpbd;

/** A tiny on-canvas badge ("Physics: GPU (AVBD)" / "Physics: CPU") in the stage's corner. Returns the element. */
export function mountBadge(container, backend, doc = globalThis.document) {
  if (!container || !doc) return null;
  let el = container.querySelector?.(".ss-phys-badge");
  if (!el) {
    el = doc.createElement("div");
    el.className = "ss-phys-badge";
    el.style.cssText = "position:absolute;left:8px;bottom:8px;z-index:5;pointer-events:none;font:600 10px/1.2 system-ui,sans-serif;" +
      "letter-spacing:.02em;padding:3px 6px;border-radius:4px;background:rgba(0,0,0,.45);color:#e8e6ef";
    container.append(el);
  }
  el.textContent = backendLabel(backend);
  el.dataset.backend = backend;
  return el;
}


// ---------- the experimental toggle ----------
/** Where the choice lives: ?physics=avbd|xpbd|auto in the page URL wins, else localStorage "ss_physics". */
export const PREF_KEY = "ss_physics";
export function readPref(env = globalThis) {
  try {
    const q = new URLSearchParams(env.location?.search || "").get("physics");
    if (q === "avbd" || q === "xpbd" || q === "auto") return q;
  } catch {}
  try { const v = env.localStorage?.getItem(PREF_KEY); if (v === "avbd" || v === "xpbd" || v === "auto") return v; } catch {}
  return "xpbd";
}
/** Switch it (the Physics panel or the console: `soundstagePhysics("avbd")`). Takes effect at the next live world. */
export function setPref(v, env = globalThis) {
  const val = v === "avbd" || v === "auto" ? v : "xpbd";
  try { env.localStorage?.setItem(PREF_KEY, val); } catch {}
  state.pref = val;
  syncRegistration();
  refreshBadges();
  return val;
}

// ---------- device and module, made once, ahead of time (physengine's createWorld is synchronous) ----------
const state = { pref: "xpbd", gpu: false, device: null, World: null, lost: false, error: null, ready: null, registered: false, worlds: 0 };

/** Bring up WebGPU and the solver module. Resolves true when AVBD can run here; never throws. */
export function init({ device = null } = {}) {
  state.ready ??= (async () => {
    try {
      const gpu = globalThis.navigator?.gpu;
      state.gpu = !!gpu || !!device;
      if (!device) {
        if (!gpu) return false;
        const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter || adapter.isFallbackAdapter) { state.error = "no hardware WebGPU adapter"; return false; }
        state.adapter = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null;
        // Hulls need a ninth storage buffer per stage; ask for it where the adapter has it (boxes and spheres don't).
        const want = Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage);
        device = await adapter.requestDevice({ requiredLimits: want > 8 ? { maxStorageBuffersPerShaderStage: want } : {} });
      }
      device.lost?.then((info) => {
        state.lost = true; state.error = `GPU device lost: ${info?.message || info?.reason || "?"}`;
        for (const w of live) w.onDeviceLost(info);
        syncRegistration(); refreshBadges();
      });
      state.World = (await import("../vendor/three-avbd/index.mjs")).World;
      state.device = device;
      return true;
    } catch (err) { state.error = String(err?.message || err); return false; }
    finally { syncRegistration(); refreshBadges(); }
  })();
  return state.ready;
}

/** Can a live AVBD world be made right now (sync: the device is up and wasn't lost)? */
export function supported() { return !!(state.device && state.World && !state.lost); }
/** Whether the stage should use AVBD now (supported and switched on). */
export const active = () => chooseBackend({ gpu: state.gpu, device: !!state.device && !!state.World, lost: state.lost, pref: state.pref }) === "avbd";
export const status = () => ({ pref: state.pref, gpu: state.gpu, ready: supported(), lost: state.lost, error: state.error, adapter: state.adapter || null, worlds: state.worlds, active: active() });

const live = new Set();

/**
 * Make a live AVBD world (synchronously: init() must have resolved). opts: { gravity (9.81), floor (true: a floor at
 * y = 0), groundY, groundFriction (0.7), maxBodies (512), iterations (6), dt (1/60), maxSubsteps (3), sleep (true),
 * damping (DAMPING), alpha (ALPHA) }. Throws when AVBD can't run (physengine falls back to XPBD before that).
 */
export function createWorld(opts = {}) {
  if (!supported()) throw new Error(`physics_avbd: not available (${state.error || "WebGPU not initialised"})`);
  const maxBodies = Math.max(16, Math.min(65536, opts.maxBodies || 512));
  const dt = opts.dt || FIXED_DT;
  const world = new state.World(state.device, { maxBodies, dt, iterations: opts.iterations || ITERATIONS, gravity: [0, -(opts.gravity ?? 9.81), 0] }, null, undefined);
  world.maxSubsteps = opts.maxSubsteps || MAX_SUBSTEPS;
  world.solver.params.alpha = opts.alpha ?? ALPHA;
  if (opts.betaLin) world.solver.params.betaLin = opts.betaLin;
  if (opts.betaAng) world.solver.params.betaAng = opts.betaAng;
  state.worlds++;
  const w = new AvbdWorld(state.device, world, { ...opts, maxBodies, dt });
  live.add(w);
  return w;
}

/** The backend as physengine.mjs takes it: { name, supported, createWorld }. */
export const engine = Object.freeze({ name: NAME, supported: () => supported() && active(), createWorld });

let physengine = null;
/** Register with physengine.mjs (preferred while the toggle is on and WebGPU is up; XPBD otherwise). */
function syncRegistration() {
  if (!physengine) return;
  try { physengine.registerEngine(engine, { prefer: active() }); state.registered = true; } catch {}
}

/** The badge on every stage canvas in the page: "Physics: GPU (AVBD)" or "Physics: CPU". */
function refreshBadges() {
  const doc = globalThis.document;
  if (!doc?.querySelectorAll) return;
  for (const el of doc.querySelectorAll(".ss-stage")) mountBadge(el, active() ? "avbd" : "xpbd", doc);
}

// In the browser: read the toggle, register, bring the GPU up in the background, keep the badge on new stages.
if (typeof window !== "undefined" && globalThis.document) {
  state.pref = readPref();
  import("./physengine.mjs").then((m) => { physengine = m; syncRegistration(); }).catch(() => {});
  if (state.pref !== "xpbd") init();
  globalThis.soundstagePhysics = (v) => { const r = setPref(v); if (r !== "xpbd") init(); return status(); };
  try {
    let queued = false;   // new stages get the badge (checked at most twice a second)
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; if (globalThis.document.querySelector(".ss-stage:not(:has(> .ss-phys-badge))")) refreshBadges(); }, 500);
    }).observe(globalThis.document.documentElement, { childList: true, subtree: true });
  } catch {}
  refreshBadges();
}

let nextId = 1;
const HAND_GROUP = 0x40000000;   // grab handles: collide with nothing
/** Steps between letting go of a grab and the body getting its own mass back (see letGo). */
export const RELEASE_STEPS = 4;
/** How far ahead of a held body its handle may run (m): a drag into a wall pulls with a bounded force. */
export const HAND_LEAD = 0.15;

export class AvbdWorld {
  constructor(device, world, opts) {
    this.engine = NAME;
    this.backend = NAME;
    this.label = LABELS.avbd;
    this.device = device;
    this.world = world;
    this.opts = opts;
    this.sleepOn = opts.sleep !== false;
    this.damping = { ...DAMPING, ...(opts.damping || {}) };
    this.entries = new Map();          // id -> entry
    this.lost = false;
    this.errors = [];
    this.frames = 0;
    this.reads = 0;
    this.reading = null;
    this.readSteps = 0;                // world steps the last landed readback saw
    this.readIssued = 0;
    this.iterations = world.iterations;
    this.calm = 0;
    this.stats = { steps: 0, lastFrameSteps: 0, readLatency: 0, asleep: 0, awake: 0, skipped: 0 };
    this.floor = opts.floor !== false;
    this.groundY = opts.groundY || 0;
    if (this.floor) {
      // A thick slab whose top (grown by half the margin, as every shape is) sits at groundY.
      this.groundBody = world.addBox({ size: [2000, 2 + AVBD_MARGIN, 2000], position: [0, this.groundY - 1, 0], fixed: true, friction: opts.groundFriction ?? 0.7 });
    }
  }

  onDeviceLost(info) {
    this.lost = true;
    this.errors.push(`device lost: ${info?.message || info?.reason || "?"}`);
    try { this.opts.onLost?.(info); } catch {}
  }
  supported() { return !this.lost && !this.disposed; }
  has(id) { return this.entries.has(id); }
  ids() { return [...this.entries.keys()]; }

  /**
   * Add a body (physengine desc: { id, shape, half, center, radius, type, mass, friction, restitution, pos, quat, asleep,
   * linearDamping, angularDamping }; `parts`: [{ half, center }] for a fixed collider of several boxes). Returns its id.
   * restitution is kept but not used: AVBD's contacts are inelastic.
   */
  addBody(desc = {}) {
    if (this.disposed) return null;
    const id = desc.id ?? `avbd${nextId++}`;
    if (this.entries.has(id)) this.removeBody(id);
    const mode = modeOf(desc);
    const parts = Array.isArray(desc.parts) && desc.parts.length && mode !== "dynamic" ? desc.parts : [desc];
    const entry = { id, desc: { ...desc }, mode, parts: [], pose: { pos: finite3(desc.pos, [0, 0, 0]), quat: finiteQ(desc.quat) },
      still: 0, asleep: mode === "dynamic" && !!desc.asleep, held: null, holdVel: [0, 0, 0], lastTarget: null, v: [0, 0, 0], w: [0, 0, 0] };
    for (const p of parts) {
      const o = avbdOptions({ ...desc, ...p, parts: undefined, pos: entry.pose.pos, quat: entry.pose.quat, type: mode, asleep: entry.asleep });
      const common = { position: o.position, rotation: o.rotation, friction: o.friction, fixed: o.fixed, density: o.density, velocity: o.velocity };
      const body = o.shape === "sphere" ? this.world.addSphere({ ...common, radius: o.radius }) : this.world.addBox({ ...common, size: o.size });
      if (!body) { this.errors.push(`world full (${this.opts.maxBodies} bodies): ${id} not added`); break; }
      entry.parts.push({ body, center: finite3(p.center ?? desc.center, [0, 0, 0]), opts: o });
    }
    if (!entry.parts.length) return null;
    entry.mass = entry.parts[0].opts.mass;
    entry.inertia = entry.parts[0].opts.inertia;
    entry.lin = Number.isFinite(+desc.linearDamping) ? +desc.linearDamping : this.damping.linear;
    entry.ang = Number.isFinite(+desc.angularDamping) ? +desc.angularDamping : this.damping.angular;
    this.entries.set(id, entry);
    if (!entry.asleep) this.wakeNear(entry);
    return id;
  }

  removeBody(id) {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.held) this.letGo(e, false);
    this.wakeNear(e);
    for (const p of e.parts) p.body.remove();
    this.entries.delete(id);
    return true;
  }

  /** Put an entry's bodies at an origin pose now (a teleport: no sliding, no speed). */
  place(e, pos, quat) {
    for (const part of e.parts) {
      const c = qrot(quat, part.center);
      part.body.set({ position: [pos[0] + c[0], pos[1] + c[1], pos[2] + c[2]], rotation: quat, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    }
    e.pose = { pos: [...pos], quat: [...quat] };
    e.readStep = null;
    e.v = [0, 0, 0]; e.w = [0, 0, 0];
    e.hist = [];
  }

  /**
   * Kinematic (or static) body: slides to this origin pose over the next step, pushing and carrying what it meets.
   * Dynamic body: a grab. It stays a solid body (heavy while held, gravity off) pulled to the target by stiff springs
   * from an invisible handle, so walls, cars, tables and the floor stop it and it shoves other props. pos = null lets go.
   */
  setKinematicTarget(id, pos, quat = null) {
    const e = this.entries.get(id);
    if (!e) return false;
    if (pos == null) { if (e.held) this.letGo(e, true); e.lastTarget = null; return true; }
    const p = finite3(pos, e.pose.pos), q = finiteQ(quat || e.lastTarget?.quat || e.pose.quat);
    const prev = e.lastTarget || e.pose;
    const dtFrame = Math.max(1e-3, this.lastDt || FIXED_DT);
    const jump = Math.hypot(p[0] - prev.pos[0], p[1] - prev.pos[1], p[2] - prev.pos[2]);
    const teleport = jump / dtFrame > TELEPORT_SPEED;
    e.holdVel = teleport ? [0, 0, 0] : e.holdVel.map((v, k) => v * 0.5 + ((p[k] - prev.pos[k]) / dtFrame) * 0.5);
    e.lastTarget = { pos: p, quat: q };
    e.targetMoved = jump > 1e-5 || teleport;
    if (e.mode === "dynamic") {
      if (!e.held) this.grab(e, p, q);
      if (teleport) this.place(e, p, q);
      e.held.vel = e.holdVel;
      // The handle leads the body by at most HAND_LEAD: dragged into a wall, it presses, it doesn't wind up a spring.
      const part = e.parts[0], c = qrot(q, part.center), cur = this.getPose(id).pos;
      let t = [p[0] + c[0], p[1] + c[1], p[2] + c[2]];
      const cc = qrot(this.getPose(id).quat, part.center), body = [cur[0] + cc[0], cur[1] + cc[1], cur[2] + cc[2]];
      const d = [t[0] - body[0], t[1] - body[1], t[2] - body[2]], dl = Math.hypot(...d);
      if (dl > HAND_LEAD && !teleport) t = body.map((x, k) => x + (d[k] / dl) * HAND_LEAD);
      e.held.hand.moveTo(t, q);
      return true;
    }
    for (const part of e.parts) {
      const c = qrot(q, part.center), at = [p[0] + c[0], p[1] + c[1], p[2] + c[2]];
      if (teleport) part.body.set({ position: at, rotation: q, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
      else part.body.moveTo(at, q);
    }
    e.pose = { pos: p, quat: q };
    return true;
  }

  /** Take hold of a dynamic body: heavy (as the CPU solver's grab: 40x, at least 2 t), floating, on three springs. */
  grab(e, p, q) {
    this.wake(e);
    const part = e.parts[0], b = part.body, m = Math.max(2000, e.mass * 40);
    const c = qrot(q, part.center), at = [p[0] + c[0], p[1] + c[1], p[2] + c[2]];
    const hand = this.world.addBox({ size: [0.02, 0.02, 0.02], position: at, rotation: q, fixed: true, group: HAND_GROUP, collidesWith: 0 });
    // Three anchors (the centre and two arms) hold the position and the turn; ~4 Hz at the held mass.
    const k = m * (2 * Math.PI * 4) ** 2, arm = 0.25;
    const springs = [[0, 0, 0], [arm, 0, 0], [0, arm, 0]].map((a) => this.world.addSpring(hand, b, { anchorA: a, anchorB: a, stiffness: k, rest: 0 }));
    b.density = m / part.opts.size.reduce((x, y) => x * y, 1);
    b.set({ velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    b.applyForce([0, m * (this.opts.gravity ?? 9.81), 0]);   // gravity off while held
    e.held = { hand, springs, mass: m, vel: [0, 0, 0] };
    e.releasing = null;
  }

  /**
   * Let go of a grab. Two stages: the springs and handle go at once (it starts to fall, still heavy), and only a few
   * steps later does it get its own mass back, with a quarter of the drag's speed. Done in one step, the force the wall
   * or crate it was pushed against had built up (sized for the 2 t grab) would fire a 25 kg crate off at 17 m/s.
   */
  letGo(e, keepSpeed) {
    const h = e.held;
    if (!h) return;
    e.held = null;
    for (const s of h.springs) s.remove();
    h.hand.remove();
    const part = e.parts[0], b = part.body;
    b.clearForces();
    b.set({ velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
    e.releasing = { at: this.world.stepCount + RELEASE_STEPS, v: keepSpeed ? h.vel.map((x) => x * 0.25) : [0, 0, 0] };
    e.still = 0;
  }

  /** Second stage of a let-go: its own mass back. */
  finishRelease(e) {
    const r = e.releasing;
    e.releasing = null;
    if (!r || e.mode !== "dynamic" || e.held) return;
    const part = e.parts[0];
    part.body.density = part.opts.density;
    part.body.set({ velocity: r.v, angularVelocity: [0, 0, 0] });
  }

  /** Change mass, friction, type ("dynamic" | "static" | "kinematic"), or place it (pos / quat: a teleport). */
  setBodyProps(id, props = {}) {
    const e = this.entries.get(id);
    if (!e) return false;
    if (props.half || props.center || props.radius || props.shape || props.parts) {
      const pose = this.getPose(id) || e.pose;
      this.removeBody(id);
      return !!this.addBody({ ...e.desc, ...props, id, pos: props.pos || pose.pos, quat: props.quat || pose.quat, asleep: false });
    }
    const type = props.type ?? props.mode;
    if (type && modeOf({ type }) !== e.mode) {
      const mode = modeOf({ type });
      if (e.held) this.letGo(e, false);
      if (e.releasing) this.finishRelease(e);
      e.mode = mode;
      e.desc.type = mode;
      e.asleep = false; e.still = 0;
      for (const part of e.parts) part.body.setFixed(mode !== "dynamic");
    }
    if (props.mass != null || props.friction != null) {
      if (props.mass != null) e.desc.mass = props.mass;
      if (props.friction != null) e.desc.friction = props.friction;
      for (const part of e.parts) {
        const o = avbdOptions({ ...e.desc, half: part.opts.size ? part.opts.size.map((s) => (s - AVBD_MARGIN) / 2) : e.desc.half, pos: e.pose.pos, quat: e.pose.quat });
        part.opts = { ...part.opts, density: o.density, friction: o.friction, mass: o.mass, inertia: o.inertia };
        if (!e.held) part.body.density = o.density;
        part.body.friction = o.friction;
        part.body.set({});   // rewritten at the next step with the new density and friction
      }
      e.mass = e.parts[0].opts.mass;
      e.inertia = e.parts[0].opts.inertia;
    }
    if (props.restitution != null || props.bounce != null) e.desc.restitution = props.restitution ?? props.bounce;
    if (props.pos || props.quat) { this.wakeNear(e); this.place(e, finite3(props.pos, e.pose.pos), finiteQ(props.quat || e.pose.quat)); }
    if (e.mode === "dynamic") this.wake(e);
    this.wakeNear(e);
    return true;
  }

  /** Run the fixed steps `dt` seconds owe (at most maxSubsteps), then start a readback if none is in flight. */
  step(dt = FIXED_DT) {
    if (this.lost || this.disposed) return 0;
    this.lastDt = Math.max(0, Math.min(0.25, +dt || 0));
    this.frames++;
    if (this.sleepOn) this.sleepPass();
    this.dampPass();
    // GPU governor: when the readback in flight is MAX_BACKLOG steps old the GPU is behind; skip this frame's steps
    // (drop the time) and ease the iterations down, then back up once it keeps up again.
    const backlog = this.reading ? this.world.stepCount - this.readIssued : 0;
    if (backlog >= MAX_BACKLOG) {
      this.stats.skipped++;
      this.calm = 0;
      if (this.world.iterations > MIN_ITERATIONS) this.world.iterations = this.world.iterations - 1;
      this.world.owed = 0;
      return 0;
    }
    if (++this.calm > 120 && this.world.iterations < this.iterations) { this.world.iterations++; this.calm = 0; }
    for (const e of this.entries.values()) if (e.releasing && this.world.stepCount >= e.releasing.at) this.finishRelease(e);
    let n = 0;
    try { n = this.world.update(this.lastDt); } catch (err) { this.errors.push(String(err?.message || err).slice(0, 300)); return 0; }
    this.stats.steps += n;
    this.stats.lastFrameSteps = n;
    for (const e of this.entries.values()) {
      e.targetMoved = false;
      if (e.mode !== "dynamic") {   // where movers were at this step, for synced poses
        (e.hist ??= []).push({ step: this.world.stepCount, pos: e.pose.pos, quat: e.pose.quat });
        if (e.hist.length > 16) e.hist.shift();
      }
    }
    if (!this.reading && n > 0) {
      const issued = this.readIssued = this.world.stepCount;
      this.reading = this.world.read().then(() => this.landRead(issued)).catch((err) => this.errors.push(String(err).slice(0, 300)))
        .finally(() => (this.reading = null));
    }
    return n;
  }

  /** A readback landed: cache each dynamic body's origin pose and speeds, and count who has come to rest. */
  landRead(issued) {
    if (this.disposed) return;
    this.reads++;
    const span = Math.max(0, issued - this.readSteps) * this.world.dt;   // sim time this readback covers
    this.readSteps = issued;
    this.stats.readLatency = this.world.stepCount - issued;
    let asleep = 0, awake = 0;
    for (const e of this.entries.values()) {
      if (e.mode !== "dynamic") continue;
      const part = e.parts[0], b = part.body;
      if (!b.alive) continue;
      const p = b.position, q = b.rotation;
      if (!p.every(Number.isFinite) || !q.every(Number.isFinite)) continue;
      e.pose = originPose(p, q, part.center);
      e.v = b.velocity; e.w = b.angularVelocity;
      e.readStep = issued;
      if (e.asleep) { asleep++; continue; }
      awake++;
      if (e.held) { e.still = 0; continue; }
      const sv = Math.hypot(...e.v), sw = Math.hypot(...e.w);
      e.still = sv < SLEEP.linear && sw < SLEEP.angular ? e.still + span : 0;
    }
    this.stats.asleep = asleep; this.stats.awake = awake;
  }

  /** Bounds of an entry's bodies at their current (cached or targeted) pose. */
  boundsOf(e, pad = 0) {
    let box = null;
    for (const part of e.parts) {
      const c = qrot(e.pose.quat, part.center), at = [e.pose.pos[0] + c[0], e.pose.pos[1] + c[1], e.pose.pos[2] + c[2]];
      const b = part.opts.shape === "sphere" ? aabbOf("sphere", at, e.pose.quat, part.opts.radius, pad) : aabbOf("box", at, e.pose.quat, part.opts.size, pad);
      box = box ? { min: box.min.map((v, k) => Math.min(v, b.min[k])), max: box.max.map((v, k) => Math.max(v, b.max[k])) } : b;
    }
    return box;
  }

  wake(e) {
    if (!e.asleep) return;
    e.asleep = false;
    e.still = 0;
    for (const part of e.parts) part.body.setFixed(false);
  }

  /** Wake sleepers touching an entry's bounds (it moved, changed or went). */
  wakeNear(e) {
    if (!e.parts?.length) return;
    const box = this.boundsOf(e, SLEEP.wakeGap);
    for (const o of this.entries.values()) if (o !== e && o.asleep && aabbOverlap(box, this.boundsOf(o))) this.wake(o);
  }

  /** Put still bodies to sleep (pinned where they lie); wake sleepers that something moving comes near. */
  sleepPass() {
    const movers = [];
    for (const e of this.entries.values()) {
      if (e.mode === "dynamic" && !e.held && !e.asleep) {
        const speed = Math.hypot(...e.v);
        if (e.still >= SLEEP.time) {
          e.asleep = true;
          for (const part of e.parts) part.body.setFixed(true);
          continue;
        }
        // Only a body that is really moving wakes others (a still neighbour about to sleep must not keep it awake).
        if (speed > SLEEP.linear * 2 || Math.hypot(...e.w) > SLEEP.angular * 2) movers.push(this.boundsOf(e, SLEEP.wakeGap + speed * this.lastDt * 4));
      } else if (e.targetMoved || e.held) {
        const lead = Math.hypot(...(e.holdVel || [0, 0, 0])) * this.lastDt * 4;
        movers.push(this.boundsOf(e, SLEEP.wakeGap + Math.max(lead, 0.25)));
        if (e.held && e.lastTarget) {   // where it's being pulled to, too
          const t = { ...e, pose: e.lastTarget };
          movers.push(this.boundsOf(t, SLEEP.wakeGap + 0.1));
        }
      }
    }
    if (!movers.length) return;
    // A few rounds, so a wake spreads through a stack the same frame.
    for (let round = 0; round < 3; round++) {
      let woke = 0;
      for (const e of this.entries.values()) {
        if (!e.asleep) continue;
        const box = this.boundsOf(e);
        if (movers.some((m) => aabbOverlap(m, box))) { this.wake(e); woke++; movers.push(this.boundsOf(e, SLEEP.wakeGap)); }
      }
      if (!woke) break;
    }
  }

  /** Air drag and tumbling resistance (desc linearDamping / angularDamping, per second), rolling resistance on spheres. */
  dampPass() {
    const h = this.lastDt;
    if (!(h > 0)) return;
    for (const e of this.entries.values()) {
      if (e.mode !== "dynamic" || e.held || e.asleep) continue;
      const b = e.parts[0].body, sv = Math.hypot(...e.v), sw = Math.hypot(...e.w);
      if (sv < 1e-3 && sw < 1e-3) continue;
      const kl = Math.min(0.5, e.lin * h), ka = Math.min(0.5, (e.ang + (e.parts[0].opts.shape === "sphere" ? this.damping.rolling : 0)) * h);
      if (kl > 0 && sv > 1e-3) b.applyImpulse(e.v.map((v) => -v * e.mass * kl));
      if (ka > 0 && sw > 1e-3) {
        // I·ω in world axes: the inertia is diagonal in the body's frame.
        const q = e.pose.quat, wl = qrot(qconj(q), e.w), Iw = qrot(q, wl.map((x, k) => x * e.inertia[k]));
        b.applyAngularImpulse(Iw.map((v) => -v * ka));
      }
    }
  }

  /**
   * Latest origin pose of a body: { pos, quat } (a kinematic body's last target; a dynamic body's last readback,
   * carried forward by its velocity over the readback's age, so a crate a car is shoving doesn't trail the car by the
   * one to three steps a readback takes). { raw: true }: the readback as it is, with `step`, the solver step it is of.
   * { synced: true }: every body as of the last readback, kinematic ones included (consistent, a few steps late).
   */
  getPose(id, { raw = false, synced = false } = {}) {
    const e = this.entries.get(id);
    if (!e) return null;
    const out = { pos: [...e.pose.pos], quat: [...e.pose.quat], asleep: e.asleep, held: !!e.held };
    if (synced) {
      if (e.mode === "dynamic") return { ...out, step: e.readStep ?? this.readSteps };
      const h = e.hist?.findLast((x) => x.step <= this.readSteps) || e.hist?.[0];
      return h ? { ...out, pos: [...h.pos], quat: [...h.quat], step: h.step } : out;
    }
    if (e.mode !== "dynamic" || e.readStep == null) return out;
    if (raw) return { ...out, step: e.readStep };
    const age = Math.min(MAX_EXTRAPOLATE, Math.max(0, this.world.stepCount - e.readStep)) * this.world.dt;
    if (!(age > 0) || e.asleep) return out;
    const p = extrapolate(e.pose, e.v, e.w, age, e.parts[0].center);
    out.pos = p.pos; out.quat = p.quat;
    return out;
  }

  /** Every body's pose at once: Map id -> { pos, quat } (as getPose). */
  poses(opts = {}) {
    const out = new Map();
    for (const id of this.entries.keys()) out.set(id, this.getPose(id, opts));
    return out;
  }

  getVelocity(id) { const e = this.entries.get(id); return e ? { v: [...e.v], w: [...e.w] } : null; }
  isAsleep(id) { const e = this.entries.get(id); return !e || e.mode !== "dynamic" || (e.asleep && !e.held); }
  /** Dynamic bodies still moving (a held body counts while it is held). */
  awakeCount() { let n = 0; for (const e of this.entries.values()) if (e.mode === "dynamic" && (!e.asleep || e.held)) n++; return n; }

  /** The bodies as shapes for raycastShapes (centre poses, grown sizes). */
  shapes(filter = null) {
    const out = [];
    for (const [id, e] of this.entries) {
      if (filter && !filter(id, e)) continue;
      const pose = this.getPose(id);
      for (const part of e.parts) {
        const c = qrot(pose.quat, part.center), pos = [pose.pos[0] + c[0], pose.pos[1] + c[1], pose.pos[2] + c[2]];
        out.push(part.opts.shape === "sphere" ? { id, shape: "sphere", pos, rot: pose.quat, radius: part.opts.radius }
          : { id, shape: "box", pos, rot: pose.quat, size: part.opts.size });
      }
    }
    return out;
  }

  /**
   * First body along a ray at the poses as last read (sync, CPU), or the floor: { id ("__ground" for the floor),
   * point, normal, distance } or null. opts.exclude: an id, a Set or an array of ids to see through.
   */
  raycast(origin, direction, maxDistance = 1e4, { exclude = null } = {}) {
    const skip = (id) => exclude != null && (exclude === id || exclude.has?.(id) || (Array.isArray(exclude) && exclude.includes(id)));
    let best = raycastShapes(this.shapes((id) => !skip(id)), origin, direction, maxDistance);
    if (this.floor) {
      const dl = Math.hypot(direction[0], direction[1], direction[2]) || 1, dy = direction[1] / dl;
      if (dy < -1e-6) {
        const t = (this.groundY - origin[1]) / dy;
        if (t > 0 && t < maxDistance && (!best || t < best.distance)) best = { id: "__ground", distance: t, point: origin.map((o, k) => o + (direction[k] / dl) * t), normal: [0, 1, 0] };
      }
    }
    return best;
  }

  /** The same on the GPU, where the bodies are now (async: a frame or two later). */
  async raycastGpu(origin, direction, maxDistance = Infinity) {
    const hit = await this.world.raycast(origin, direction, { maxDistance });
    if (!hit?.body) return null;
    for (const [id, e] of this.entries) if (e.parts.some((p) => p.body === hit.body)) return { id, distance: hit.distance, point: hit.point, normal: hit.normal };
    return null;
  }

  /** Wait for the readback in flight (tests, recordings). */
  async settle() { while (this.reading) await this.reading; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    const done = () => { try { this.world.destroy(); } catch {} };
    // Free the GPU buffers once the readback in flight (if any) has landed.
    if (this.reading) this.reading.finally(done); else done();
    this.entries.clear();
  }
}
