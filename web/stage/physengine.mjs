// Soundstage physics engine interface (Milestone 9). The stage talks to physics ONLY through this file, so a backend
// can be swapped without touching stage.mjs. The default backend is the XPBD solver in physics.mjs (pure JS, runs
// everywhere); a WebGPU AVBD backend (physics_avbd.mjs, Milestone 10) registers itself here and is used when
// supported. Live worlds are an editing aid: what ends up in a shot is still Simulate & bake (deterministic keys).
//
// Interface every backend implements (a "world"):
//   createWorld(opts)                     -> world      opts: {gravity = 9.81, floor = true (plane y = 0), substeps}
//   world.addBody(desc)                   -> id         desc: {id?, shape: "box"|"sphere", half: [hx,hy,hz],
//                                                        center: [cx,cy,cz] (box centre from the origin, local), radius,
//                                                        type: "dynamic"|"static"|"kinematic", mass (kg), friction,
//                                                        restitution, pos: [x,y,z], quat: [x,y,z,w] (origin pose), asleep}
//   world.removeBody(id)
//   world.setKinematicTarget(id, pos, quat)  kinematic: moves there over the next step (pushes dynamic bodies);
//                                            dynamic: a grab (chases it, gravity off, blocked by static things and the
//                                            floor, shoves dynamic bodies); pos = null lets go
//   world.setBodyProps(id, {mass, friction, restitution, type, pos, quat})
//   world.step(dt)                           advance dt seconds (real time; the backend substeps)
//   world.getPose(id)                     -> {pos, quat} origin pose
//   world.raycast(origin, dir, maxDist, {exclude}) -> {id ("__ground" = floor), point, normal, distance} | null
//   world.dispose()
// Optional helpers the stage uses when present: world.awakeCount() (dynamic bodies still moving), world.isAsleep(id),
// world.getVelocity(id) -> {v, w}.
// A backend module exports { name, supported() -> bool, createWorld(opts) }.

import { createXpbdWorld } from "./physics.mjs";

export const xpbd = { name: "xpbd", supported: () => true, createWorld: (opts = {}) => createXpbdWorld(opts) };

const registry = new Map([["xpbd", xpbd]]);
let preferred = null;

/** Add a backend ({name, supported, createWorld}); `prefer` makes it the default whenever it is supported. */
export function registerEngine(engine, { prefer = false } = {}) {
  if (!engine?.name || typeof engine.createWorld !== "function") throw new Error("physengine: a backend needs name and createWorld");
  registry.set(engine.name, engine);
  if (prefer) preferred = engine.name;
}

export function engines() {
  return [...registry.values()].map((e) => ({ name: e.name, supported: !!safe(() => e.supported?.() ?? true) }));
}

const safe = (f) => { try { return f(); } catch { return false; } };

/** The backend to use: opts.engine if named and supported, else the preferred one if supported, else XPBD. */
export function pickEngine(name = null) {
  for (const n of [name, preferred]) {
    const e = n && registry.get(n);
    if (e && safe(() => e.supported?.() ?? true)) return e;
  }
  return xpbd;
}

/** True when the chosen (or default) backend can run here. XPBD always can. */
export function supported(name = null) {
  return !!safe(() => pickEngine(name).supported?.() ?? true);
}

/** Make a live world on the chosen backend (falls back to XPBD). world.engine names the backend in use. */
export function createWorld(opts = {}) {
  const e = pickEngine(opts.engine);
  const w = e.createWorld(opts);
  if (w && !w.engine) w.engine = e.name;
  return w;
}
