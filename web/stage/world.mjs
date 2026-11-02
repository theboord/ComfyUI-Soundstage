// World collisions (Milestone 28): everything on the stage collides in the bake, by real masses, speeds and strengths.
//
// A keyed car keyed through another car becomes a crash; a car into a street lamp knocks it down; into a solid wall
// it stops and crumples, through a weak one it breaks a hole and carries on; a person in the way is knocked over
// instead of being driven through. The solver side is physics.mjs simulate() (takeover, anchor, aniso, crush specs);
// this file is the world model on top of it, pure JS with no three.js, so all of it runs and is tested in Node:
//
//   WORLD_KINDS / worldRole(actor)        what each kind of thing is in the real world (mass, anchoring, crush)
//   worldSpecs(body, opts)                the simulate() specs for one actor (a car: chassis, cabin and wheels; a
//                                         person: a body that falls; a lamp: a breakaway pole; a weak wall: blocks)
//   wallPieces(...)                       a broken weak wall's blocks as the stage's fracture pieces (clay render)
//   interpenetrations(items, frames)      every pair of solid things that pass through each other, frame by frame
//   consequences(overlaps, names, fps)    the same in plain words, with one-click fixes (Director commands)
//   planRam(rammer, victim, into, opts)   "the police car rams the red car into the boxes": keys whose crash, by
//                                         momentum, carries the victim into the target; the physics does the rest
//   rerouteKeys(keys, frame, offset)      the other fix: the mover swerves round the thing it would pass through
//   mergeEdits(source, baked, current)    a key edited on a baked object goes into its authored keys (re-bake)
//   inputSig(actors)                      what a bake depends on (auto re-bake when it changes)
//   rebaker(run, {delay})                 debounced re-bake: editing keys or dragging keeps the world fluid
//
// Keyed actors keep their keys until their first real contact, then the physics takes over (the bake reports
// "physics took over at f N"); physics.keepKeyed on an actor keeps it on its keys (the consequence check then
// reports anything it passes through). The bake is deterministic, so scrubbing back shows exactly what was there and
// one Undo restores the scene from before the bake.

import { qrot, qslerp, qnorm, samplePos, sampleQuat, TAKEOVER_DV } from "./physics.mjs";
import { vehicleBodyPoints, gjk, epa } from "./convex.mjs";

export { TAKEOVER_DV };
export const G = 9.81;

export const VEHICLE_KINDS = new Set(["car", "police_car", "sports_car", "hatchback", "truck", "motorcycle"]);
export const PERSON_KINDS = new Set(["man", "woman", "child"]);

/**
 * The real world, per kind. role: "vehicle" (keyed until contact, tyres, crush), "person" (keyed until contact, falls),
 * "anchored" (bolted or buried: stands until a hit's force passes its strength, then is a loose body), "wall" (solid
 * unless weak). mass kg; crush N/m (frontal crush stiffness, NHTSA-style linear model: ~1e6 for a car); force N and
 * energy J: an anchor's strength and the energy its failure takes from whatever broke it.
 * Sources for the orders of magnitude: curb weights (a police interceptor ~1.9 t, a compact ~1.2 t), AASHTO breakaway
 * supports (a breakaway lamp base costs a car 1-3 m/s), a dry-stack block garden wall vs a concrete wall.
 */
export const WORLD_KINDS = {
  car: { role: "vehicle", mass: 1450, crush: 1.0e6 },
  hatchback: { role: "vehicle", mass: 1200, crush: 0.9e6 },
  sports_car: { role: "vehicle", mass: 1500, crush: 1.1e6 },
  police_car: { role: "vehicle", mass: 1900, crush: 1.2e6 },
  truck: { role: "vehicle", mass: 2700, crush: 1.6e6 },
  motorcycle: { role: "vehicle", mass: 230, crush: 2.5e5 },
  man: { role: "person", mass: 80 },
  woman: { role: "person", mass: 65 },
  child: { role: "person", mass: 30 },
  lamp: { role: "anchored", mass: 140, force: 4e4, energy: 3000, pole: 0.11, material: "metal", what: "street lamp" },
  hydrant: { role: "anchored", mass: 120, force: 1.5e5, energy: 5000, material: "metal", what: "hydrant" },
  sign: { role: "anchored", mass: 25, force: 1.2e4, energy: 600, pole: 0.04, material: "metal", what: "sign" },
  bollard: { role: "anchored", mass: 150, force: 6e5, energy: 2e4, material: "metal", what: "bollard" },
  bench: { role: "anchored", mass: 45, force: 1.5e4, energy: 800, material: "wood", what: "bench" },
  tree: { role: "anchored", mass: 700, force: 1.2e6, energy: 6e4, pole: 0.2, trunk: 1.5, material: "wood", what: "tree" },
  wall: { role: "wall", material: "concrete", what: "wall" },
};
/** Walls of these materials (or physics.weak: true) are weak: block or board walls a car breaks through. */
export const WEAK_WALL = { wood: 520, cardboard: 150, plastic: 300, glass: 2500, stone: 1400 };   // kg / m^3 of the blocks
/** A weak wall's blocks (m) and each block's strength: a car breaks through above ~1.7 m/s, stops below. */
export const WALL_BLOCK = { w: 0.6, h: 0.5, force: 6e4, energy: 1500, max: 48 };
/** After the hit (Milestone 28): "brake" (the driver stands on it: 0.55 g along the tyre), "coast" (rolling resistance). */
export const AFTER_CONTACT = { brake: 0.55, coast: 0.02 };

/** An actor's role in the world bake, null when it isn't a world body (props keep the stage's own specs). */
export function worldRole(a) {
  if (!a) return null;
  const k = WORLD_KINDS[a.kind];
  if (!k) return a.physics?.anchor ? "anchored" : null;
  return k.role;
}

/** A car's collision shape in its own frame (+Z forward, y up, wheels on y = box bottom): chassis, cabin, 4 wheels. */
export function vehicleHulls(half, center) {
  const [hx, hy, hz] = half, [cx, cy, cz] = center, H = 2 * hy, y0 = cy - hy;
  const r = Math.min(0.45, Math.max(0.12, 0.22 * H));
  const cb = y0 + 0.55 * r, ct = y0 + 0.62 * H;   // chassis bottom (ground clearance) and top (the waist)
  const chassis = vehicleBodyPoints([hx, (ct - cb) / 2, hz], [cx, (cb + ct) / 2, cz]);
  const cabin = [];
  for (const x of [-1, 1]) for (const y of [ct, y0 + H]) for (const z of [-1, 1]) {
    const top = y > ct + 1e-6;
    cabin.push([cx + x * hx * (top ? 0.78 : 0.92), y, cz - 0.08 * hz + z * hz * (top ? 0.38 : 0.55)]);
  }
  const wheels = [];
  const ww = Math.min(0.12, 0.08 * hx * 2), wx = hx - ww - 0.02, wz = hz * 0.64;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, y = y0 + r + r * Math.cos(a), z = cz + sz * wz + r * Math.sin(a);
      for (const dx of [-ww, ww]) pts.push([cx + sx * wx + dx, y, z]);
    }
    wheels.push(pts);
  }
  return { hulls: [chassis, cabin, ...wheels], wheelRadius: r };
}

/** A car's mass properties: centre of mass at 0.38 of its height, inertia of real cars (roll ~550, yaw ~2400 kg m^2 at 1.5 t). */
export function vehicleMass(half, center, mass) {
  const [hx, hy, hz] = half, W = 2 * hx, H = 2 * hy, L = 2 * hz;
  const pitch = 0.8 * (H * H + L * L) / 12, yaw = 0.8 * (W * W + L * L) / 12, roll = 0.75 * (W * W + H * H) / 12;
  return { volume: 1, com: [center[0], center[1] - hy + 0.38 * H, center[2]], inertia: [[pitch, 0, 0], [0, yaw, 0], [0, 0, roll]] };
}

const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== "" ? +v : d);

/**
 * A person's body box from its mesh's half extents (a body, not its outstretched arms or running stride). The bake and
 * the consequence check both use it, so what the bake resolves the check does not report.
 */
export function personHalf([hx, hy, hz]) {
  return [Math.max(0.17, Math.min(0.3, hx * 0.6)), hy, Math.max(0.11, Math.min(0.2, hz * 0.75))];
}

/**
 * simulate() specs for one actor in the world bake. body: {id, kind, half, center, poses, physics (the actor's), material,
 * name}. opts: {afterContact: "brake" | "coast"}. Returns [] when the actor isn't a world body (the stage keeps its own spec).
 * A keepKeyed actor stays on its keys (a keyed collider, as before Milestone 28).
 */
export function worldSpecs(body, opts = {}) {
  const role = worldRole(body);
  if (!role) return [];
  const K = WORLD_KINDS[body.kind] || {}, ph = body.physics || {}, keep = !!ph.keepKeyed;
  const base = { id: body.id, kind: body.kind, poses: body.poses, material: ph.material || K.material || body.material };
  const [hx, hy, hz] = body.half, [cx, cy, cz] = body.center;
  if (role === "vehicle") {
    const mass = num(ph.mass, K.mass), { hulls } = vehicleHulls(body.half, body.center);
    const after = AFTER_CONTACT[ph.afterContact || opts.afterContact] ?? AFTER_CONTACT.brake;
    return [{ ...base, material: base.material || "metal", shape: "hull", hulls, massProps: vehicleMass(body.half, body.center, mass), half: body.half, center: body.center,
      dynamic: !keep, mass, bounce: 0.12, friction: 0.45, ...(keep ? {} : { takeover: { dv: num(ph.takeoverDv, TAKEOVER_DV) },
        aniso: { axis: [0, 0, 1], roll: after, side: 0.85 }, crush: K.crush || 1e6 }), stiffness: K.crush || 1e6 }];
  }
  if (role === "person") {
    const half = personHalf(body.half);
    return [{ ...base, material: "flesh", shape: "box", half, center: body.center, dynamic: !keep, mass: num(ph.mass, K.mass),
      bounce: 0.05, friction: 0.7, stiffness: 5e4, ...(keep ? {} : { takeover: { dv: num(ph.takeoverDv, 0.6) } }) }];
  }
  if (role === "anchored") {
    const mass = num(ph.mass, K.mass ?? 50);
    // impulse: the momentum a hit must bring (10 x its mass, N s): a person running into a lamp post doesn't fell it.
    const an = { force: num(ph.anchor?.force, K.force ?? 2e4), energy: num(ph.anchor?.energy, K.energy ?? 0), impulse: num(ph.anchor?.impulse, 10 * mass) };
    let half = body.half, center = body.center;
    if (K.pole) {   // a lamp or a sign is its pole; a tree, its trunk (the crown is not what a car hits)
      const top = K.trunk ? Math.min(2 * hy, 2 * K.trunk) : 2 * hy, y0 = cy - hy;
      half = [K.pole, top / 2, K.pole]; center = [0, y0 + top / 2, 0];
    }
    return [{ ...base, shape: "box", half, center, dynamic: true, mass, bounce: 0.1, friction: 0.55, stiffness: 1e7, anchor: an }];
  }
  if (role === "wall") {
    const mat = ph.material || body.material || "concrete";
    const weak = ph.weak === true || (ph.weak !== false && mat in WEAK_WALL);
    if (!weak) return [{ ...base, material: mat, shape: "box", half: body.half, center: body.center, dynamic: false, bounce: 0.05, friction: 0.7, stiffness: 2e7 }];
    return wallBlocks(body, mat);
  }
  return [];
}

/** A weak wall as a grid of anchored blocks; each block is held up by the one under it (knock one out, the ones above fall). */
export function wallBlocks(body, mat = "wood") {
  const [hx, hy, hz] = body.half, [cx, cy, cz] = body.center;
  const alongX = hx >= hz, len2 = 2 * (alongX ? hx : hz), H = 2 * hy, t = 2 * (alongX ? hz : hx);
  let nu = Math.max(1, Math.round(len2 / WALL_BLOCK.w)), nv = Math.max(1, Math.round(H / WALL_BLOCK.h));
  while (nu * nv > WALL_BLOCK.max) { if (nu >= nv) nu--; else nv--; }
  const bw = len2 / nu, bh = H / nv, rho = WEAK_WALL[mat] ?? 520, out = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const u = -len2 / 2 + (i + 0.5) * bw, v = cy - hy + (j + 0.5) * bh;
    const center = alongX ? [cx + u, v, cz] : [cx, v, cz + u];
    const half = alongX ? [bw / 2 - 0.004, bh / 2 - 0.004, t / 2] : [t / 2, bh / 2 - 0.004, bw / 2 - 0.004];
    out.push({ id: `${body.id}~b${j}.${i}`, poses: body.poses, material: mat, shape: "box", half, center, dynamic: true,
      mass: Math.max(1, rho * bw * bh * t), bounce: 0.1, friction: 0.7, stiffness: 5e6,
      anchor: { force: WALL_BLOCK.force, energy: WALL_BLOCK.energy, impulse: 10 * Math.max(1, rho * bw * bh * t), supports: j + 1 < nv ? [`${body.id}~b${j + 1}.${i}`] : [] },
      wallOf: body.id, block: [j, i] });
  }
  return out;
}

/**
 * A broken weak wall's blocks as the stage's fracture record (physics.fracture: the whole wall shows until the first
 * block goes, then every block plays its own keys; the clay renders them as boxes). tracks: simulate() tracks (origin
 * poses); specs: the wall's block specs; bakeTrack: physics.mjs bakeTrack. Null when no block moved.
 */
export function wallPieces(specs, tracks, takeovers, bakeTrack) {
  const frames = specs.map((sp) => takeovers[sp.id]?.frame).filter((f) => f != null);
  if (!frames.length) return null;
  const frame = Math.min(...frames), from = Math.max(0, frame - 1);
  const pieces = specs.map((sp) => {
    const tr = (tracks[sp.id] || []).map((p) => ({ pos: p.pos.map((v, k) => v + qrot(p.quat, sp.center)[k]), quat: p.quat }));
    return { kind: "block", half: sp.half.map((v) => +v.toFixed(4)), center: sp.center.map((v) => +v.toFixed(4)),
      keys: bakeTrack(tr.slice(from)).map((k) => ({ ...k, frame: k.frame + from })) };
  });
  return { frame, split: frame, cracks: frames.length, material: specs[0].material, pieces, wall: true };
}

// ---------- the consequence check ----------
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const E3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Deepest overlap of two oriented boxes {c, ax, h} (separating axis test): 0 when apart. */
export function obbOverlap(a, b) {
  const t = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
  const axes = [...a.ax, ...b.ax];
  for (const u of a.ax) for (const v of b.ax) { const c = cross(u, v), l = Math.hypot(c[0], c[1], c[2]); if (l > 1e-6) axes.push([c[0] / l, c[1] / l, c[2] / l]); }
  let min = Infinity;
  for (const L of axes) {
    const ra = a.h[0] * Math.abs(dot(a.ax[0], L)) + a.h[1] * Math.abs(dot(a.ax[1], L)) + a.h[2] * Math.abs(dot(a.ax[2], L));
    const rb = b.h[0] * Math.abs(dot(b.ax[0], L)) + b.h[1] * Math.abs(dot(b.ax[1], L)) + b.h[2] * Math.abs(dot(b.ax[2], L));
    const o = ra + rb - Math.abs(dot(t, L));
    if (o <= 0) return 0;
    if (o < min) min = o;
  }
  return min;
}

function poseAt(P, t) {
  const n = P.length - 1;
  if (n <= 0) return P[0];
  if (t <= 0) return P[0];
  if (t >= n) return P[n];
  const i = Math.floor(t), u = t - i;
  if (u < 1e-9) return P[i];
  return { pos: P[i].pos.map((v, k) => v + (P[i + 1].pos[k] - v) * u), quat: qslerp(P[i].quat, P[i + 1].quat, u) };
}
const obbAt = (it, pose) => {
  const q = qnorm(pose.quat), c = qrot(q, it.center);
  return { c: [pose.pos[0] + c[0], pose.pos[1] + c[1], pose.pos[2] + c[2]], ax: E3.map((e) => qrot(q, e)), h: it.half };
};

/** A car's check shape: the body to the waist and the narrower cabin (its bounding box would put the cabin over the bonnet). */
export function vehicleParts(half, center) {
  const [hx, hy, hz] = half, [cx, cy, cz] = center, H = 2 * hy, y0 = cy - hy, r = Math.min(0.45, Math.max(0.12, 0.22 * H));
  const cb = y0 + 0.55 * r, ct = y0 + 0.62 * H;
  return [{ half: [hx, (ct - cb) / 2, hz], center: [cx, (cb + ct) / 2, cz] },
    { half: [hx * 0.85, (y0 + H - ct) / 2, hz * 0.47], center: [cx, (ct + y0 + H) / 2, cz - 0.08 * hz] }];
}
// The check runs on the shapes the bake collides: a car's hulls (chassis with its raked nose, cabin, wheels), boxes
// for the rest. it.hulls: point lists in the object's frame (relative to its origin).
const partsOf = (it) => it.parts || (it.hulls ? it.hulls.map((pts) => ({ pts })) :
  VEHICLE_KINDS.has(it.kind) ? vehicleHulls(it.half, it.center).hulls.map((pts) => ({ pts })) : [{ half: it.half, center: it.center }]);
const cornersOf = (b) => { const o = []; for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) o.push([b.center[0] + i * b.half[0], b.center[1] + j * b.half[1], b.center[2] + k * b.half[2]]); return o; };
function partDepth(pa, qa, pb, qb) {
  if (!pa.pts && !pb.pts) return obbOverlap(obbAt(pa, qa), obbAt(pb, qb));
  const world = (part, pose) => { const q = qnorm(pose.quat); return (part.pts || cornersOf(part)).map((v) => { const r = qrot(q, v); return [r[0] + pose.pos[0], r[1] + pose.pos[1], r[2] + pose.pos[2]]; }); };
  const A = world(pa, qa), B = world(pb, qb), g = gjk(A, B);
  if (!g?.hit) return 0;
  return epa(A, B, g.simplex)?.depth ?? 0;
}

/**
 * Every pair of solid things that pass through each other. items: [{id, name, kind, half, center (box centre from the
 * origin, own frame), poses: [{pos, quat}] per frame (one pose = it stands still), parts?: [{half, center}] (its shape as
 * boxes; a car's default: vehicleParts)}].
 * Fast movers are checked between frames too (a car at 30 m/s moves 1.25 m a frame). opts: {tol (m, 0.04), skip:
 * (a, b) => bool}. An item's `until` frame ends its checks (a wall or crate that broke: its pieces carry on).
 * Returns [{a, b, frame, t, end, depth}], one per pair (its first frame), soonest first.
 */
export function interpenetrations(items, frames, { fps = 24, tol = 0.04, skip = null } = {}) {
  const out = [], n = items.length;
  const reach = items.map((it) => Math.hypot(...it.half) + Math.hypot(...it.center));
  const parts = items.map(partsOf);
  const still = items.map((it) => it.poses.length <= 1 || it.poses.every((p) => p.pos.every((v, k) => Math.abs(v - it.poses[0].pos[k]) < 1e-6)));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = items[i], B = items[j];
    if (still[i] && still[j]) continue;   // two things standing still: the set dresser's business, not a consequence
    if (skip?.(A, B)) continue;
    let first = null, end = null, depth = 0;
    const stop = Math.min(frames, A.until ?? frames, B.until ?? frames);   // until: it broke (its pieces take over)
    for (let f = 0; f < stop; f++) {
      const pa = poseAt(A.poses, f), pb = poseAt(B.poses, f);
      const pa1 = poseAt(A.poses, f + 1), pb1 = poseAt(B.poses, f + 1);
      const move = Math.max(Math.hypot(...pa1.pos.map((v, k) => v - pa.pos[k])), Math.hypot(...pb1.pos.map((v, k) => v - pb.pos[k])));
      const sub = f < stop - 1 ? Math.min(8, Math.max(1, Math.ceil(move / 0.25))) : 1;
      let hit = 0;
      for (let s = 0; s < sub && !hit; s++) {
        const t = f + s / sub, qa = s ? poseAt(A.poses, t) : pa, qb = s ? poseAt(B.poses, t) : pb;
        const d2 = qa.pos.reduce((acc, v, k) => acc + (v - qb.pos[k]) ** 2, 0), R = reach[i] + reach[j];
        if (d2 > R * R) continue;
        for (const pa2 of parts[i]) for (const pb2 of parts[j]) {
          const o = partDepth(pa2, qa, pb2, qb);
          if (o > tol && o > hit) hit = o;
        }
      }
      if (hit) { if (first == null) first = f; end = f; depth = Math.max(depth, hit); }
    }
    if (first != null) out.push({ a: A.id, b: B.id, frame: first, t: +(first / fps).toFixed(2), end, depth: +depth.toFixed(3) });
  }
  return out.sort((p, q) => p.frame - q.frame || (p.a < q.a ? -1 : 1));
}

const VERB = { vehicle: "passes through", person: "walks through", anchored: "stands inside", wall: "stands inside" };

/**
 * The overlaps in plain words, with one-click fixes the Director runs as commands. who: {id: {name, kind, moving}}.
 * Returns [{a, b, frame, t, text, fixes: [{id, label, command}]}].
 */
export function consequences(overlaps, who, { fps = 24 } = {}) {
  // One line per mover and kind of thing within a second: "passes through 6 crates", not six lines.
  const rank0 = (id) => (worldRole(who[id]) === "vehicle" ? 3 : worldRole(who[id]) === "person" ? 2 : who[id]?.moving ? 1 : 0);
  const groups = [];
  for (const o of overlaps) {
    const [m, x] = rank0(o.b) > rank0(o.a) ? [o.b, o.a] : [o.a, o.b];
    const k = who[x]?.kind, g = !worldRole(who[x]) && groups.find((G) => G.m === m && G.kind === k && Math.abs(G.frame - o.frame) <= fps);
    if (g) { g.ids.push(x); g.depth = Math.max(g.depth, o.depth); } else groups.push({ ...o, a: m, b: x, m, kind: k, ids: [x] });
  }
  const many = groups.filter((g) => g.ids.length > 1);
  if (many.length) {
    const rest = consequences(groups.filter((g) => g.ids.length === 1), who, { fps });
    const lines = many.map((g) => {
      const M = (() => { const w = who[g.m] || {}; const nm = w.name || g.m; return /^[A-Z]/.test(nm) && PERSON_KINDS.has(w.kind) ? nm : `the ${String(nm).toLowerCase()}`; })();
      const what = `${g.ids.length} ${String(g.kind || "thing").replace(/_/g, " ")}${/s$/.test(g.kind || "") ? "" : g.kind === "box" ? "es" : "s"}`;
      return { a: g.m, b: g.ids[0], ids: g.ids, frame: g.frame, t: +(g.frame / fps).toFixed(1), depth: g.depth,
        text: `${M[0].toUpperCase()}${M.slice(1)} passes through ${what} at ${(g.frame / fps).toFixed(1)} s: make them collide, or reroute?`,
        fixes: [{ id: "crash", label: "Make them collide", command: "bake the physics" }, { id: "reroute", label: "Reroute", command: `reroute ${M} around the ${String(who[g.ids[0]]?.name || g.ids[0]).toLowerCase()}` }] };
    });
    return [...rest, ...lines].sort((p, q) => p.frame - q.frame);
  }
  const word = (id) => { const w = who[id] || {}; const nm = w.name || id; return /^[A-Z]/.test(nm) && PERSON_KINDS.has(w.kind) ? nm : `the ${String(nm).toLowerCase()}`; };
  return overlaps.map((o) => {
    let [m, x] = [o.a, o.b];
    const rank = (id) => (worldRole(who[id]) === "vehicle" ? 3 : worldRole(who[id]) === "person" ? 2 : who[id]?.moving ? 1 : 0);
    if (rank(x) > rank(m)) [m, x] = [x, m];
    const rm = worldRole(who[m]), rx = worldRole(who[x]);
    const t = (o.frame / fps).toFixed(1), M = word(m), X = word(x);
    const verb = rm === "vehicle" ? (rx === "person" ? "drives through" : "passes through") : VERB[rm] || "passes through";
    let ask, fix;
    if (rx === "vehicle") { ask = "crash them, or reroute?"; fix = { id: "crash", label: "Crash them", command: `crash ${M} into ${X}` }; }
    else if (rx === "person") { ask = `knock ${X} down, or reroute?`; fix = { id: "crash", label: `Knock ${X} down`, command: `crash ${M} into ${X}` }; }
    else if (rx === "wall") { ask = "crash into it, or reroute?"; fix = { id: "crash", label: "Crash into it", command: `crash ${M} into ${X}` }; }
    else if (rx === "anchored") { ask = "knock it down, or reroute?"; fix = { id: "crash", label: "Knock it down", command: `crash ${M} into ${X}` }; }
    else { ask = "make it collide, or reroute?"; fix = { id: "crash", label: "Collide", command: `crash ${M} into ${X}` }; }
    const text = `${M[0].toUpperCase()}${M.slice(1)} ${verb} ${X} at ${t} s: ${ask}`;
    return { a: m, b: x, frame: o.frame, t: +t, depth: o.depth, text,
      fixes: [fix, { id: "reroute", label: "Reroute", command: `reroute ${M} around ${X}` }] };
  });
}

// ---------- "the police car rams the red car into the boxes" ----------
/**
 * Keys for a ram whose outcome, by momentum, carries the victim into the target. rammer / victim: {pos [x,y,z], mass,
 * half [hx,hy,hz], heading (rad, the victim's: its tyres roll along it and grip across it)}; into: [x, y, z] or null
 * (just the hit). opts: {frames, fps, e (restitution, 0.1: car crashes are nearly plastic), mu (post-hit drag: AFTER_CONTACT
 * brake along, 0.85 across), hitAt (share of the shot, 0.4), minSpeed (8 m/s: a ram, not a nudge), maxSpeed (35 m/s)}.
 * The victim, at rest, leaves the hit at v2 = (1 + e) m1 v / (m1 + m2) and slides v2^2 / (2 mu g) under its tyres'
 * grip; the rammer's speed is the one that slides it to the target with 25 % to spare (it arrives still moving).
 * Returns {keys, hitFrame, speed (m/s), kmh, push (m the victim is expected to slide), dir, words}.
 */
export function planRam(rammer, victim, into = null, opts = {}) {
  const frames = opts.frames || 97, fps = opts.fps || 24, last = frames - 1, e = opts.e ?? 0.1;
  const m1 = rammer.mass, m2 = victim.mass;
  let dir = into ? [into[0] - victim.pos[0], 0, into[2] - victim.pos[2]] : [victim.pos[0] - rammer.pos[0], 0, victim.pos[2] - rammer.pos[2]];
  let dl = Math.hypot(dir[0], dir[2]);
  if (dl < 1e-6) { dir = [Math.sin(rammer.heading || 0), 0, Math.cos(rammer.heading || 0)]; dl = 1; }
  dir = [dir[0] / dl, 0, dir[2] / dl];
  const hv = [Math.sin(victim.heading || 0), 0, Math.cos(victim.heading || 0)], c = Math.abs(dot(hv, dir));
  const muAlong = opts.muAlong ?? AFTER_CONTACT.brake, muSide = opts.muSide ?? 0.85;
  const mu = Math.hypot(muAlong * c, muSide * Math.sqrt(Math.max(0, 1 - c * c)));
  // How far the victim's centre must travel to reach the target (its own reach towards it, from its footprint).
  const reachV = Math.abs(victim.half[2] * c) + Math.abs(victim.half[0] * Math.sqrt(Math.max(0, 1 - c * c)));
  const push = into ? Math.max(0.5, dl - reachV - 0.4) : 0;
  const v2 = into ? 1.25 * Math.sqrt(2 * mu * G * push) : 0;
  let v = into ? v2 * (m1 + m2) / ((1 + e) * m1) : 0;
  v = Math.max(opts.minSpeed ?? 8, Math.min(opts.maxSpeed ?? 35, v || 0));
  const reach = rammer.half[2] + reachV;   // the rammer's nose touches the victim's side
  const contact = [victim.pos[0] - dir[0] * reach, 0, victim.pos[2] - dir[2] * reach];
  let hitFrame = Math.round(last * (opts.hitAt ?? 0.4));
  hitFrame = Math.max(Math.ceil(fps * 0.6), Math.min(last - 6, hitFrame));
  const before = v * hitFrame / fps, after = v * (last - hitFrame) / fps;
  const p0 = [contact[0] - dir[0] * before, 0, contact[2] - dir[2] * before], p1 = [contact[0] + dir[0] * after, 0, contact[2] + dir[2] * after];
  const r3 = (a) => a.map((x) => Math.round(x * 1000) / 1000);
  const slide = into ? ((1 + e) * m1 * v / (m1 + m2)) ** 2 / (2 * mu * G) : 0;
  const kmh = Math.round(v * 3.6);
  return { keys: [{ frame: 0, position: r3(p0) }, { frame: last, position: r3(p1) }], hitFrame, speed: +v.toFixed(2), kmh, dir,
    push: +slide.toFixed(1), heading: Math.atan2(dir[0], dir[2]),
    words: `hits at ${(hitFrame / fps).toFixed(1)} s doing ${kmh} km/h` +
      (into ? `; by momentum (${Math.round(m1)} kg into ${Math.round(m2)} kg) that shoves it about ${slide.toFixed(0)} m` : "") };
}

/**
 * The other fix: the mover swerves round what it would pass through. keys: stage keys [{frame, position}]; frame: the
 * first frame of the overlap; offset: [dx, dz] (sideways, clear of the other thing). Adds a key there (and eases back to
 * the path a second later). Returns new keys.
 */
export function rerouteKeys(keys, frame, offset, { fps = 24 } = {}) {
  const ks = [...keys].sort((a, b) => a.frame - b.frame);
  const at = (f) => { const p = samplePos(ks.map((k) => ({ ...k, position: [k.position[0], k.position[1] ?? 0, k.position[2]] })), f); return p; };
  const out = ks.filter((k) => Math.abs(k.frame - frame) > 2);
  const p = at(frame);
  out.push({ frame, position: [+(p[0] + offset[0]).toFixed(3), p[1] ?? 0, +(p[2] + offset[1]).toFixed(3)] });
  return out.sort((a, b) => a.frame - b.frame);
}

/** Sideways offset that clears B's footprint when A crosses it: perpendicular to A's motion, to the roomier side. */
export function clearOffset(aPos, aDir, aHalf, bPos, bHalf) {
  const side = [aDir[2], -aDir[0]], rel = [bPos[0] - aPos[0], bPos[2] - aPos[2]];
  const s = rel[0] * side[0] + rel[1] * side[1] > 0 ? -1 : 1;   // away from B
  const clear = Math.max(aHalf[0], aHalf[2]) * 0.6 + Math.max(bHalf[0], bHalf[2]) + 0.6;
  return [side[0] * s * clear, side[1] * s * clear];
}

// ---------- fluid editing ----------
/**
 * Edits made on a baked object go into its authored keys, so the re-bake starts from what was meant: a key that
 * differs from the bake (or is new) is the director's. A resting prop (one source key) moves with the drag instead.
 * Returns the new source keys, or null when nothing was edited.
 */
export function mergeEdits(source, baked, current) {
  if (!Array.isArray(source) || !Array.isArray(current)) return null;
  const same = (a, b) => a && b && a.position.every((v, i) => Math.abs(v - (b.position[i] ?? 0)) < 5e-4);
  const bakedAt = new Map((baked || []).map((k) => [k.frame, k]));
  const edits = current.filter((k) => !same(k, bakedAt.get(k.frame)));
  if (!edits.length && current.length === (baked || []).length) return null;
  if (!edits.length) return null;
  if (source.length <= 1) {
    const e = edits[0], b = bakedAt.get(e.frame) || { position: samplePos(baked, e.frame) };
    const d = e.position.map((v, i) => v - (b.position[i] ?? 0)), s0 = source[0] || { frame: 0, position: [0, 0, 0] };
    return [{ ...s0, position: s0.position.map((v, i) => +(v + (i === 1 ? 0 : d[i])).toFixed(4)) }];
  }
  const byF = new Map(source.map((k) => [k.frame, { ...k }]));
  for (const e of edits) byF.set(e.frame, { ...(byF.get(e.frame) || {}), frame: e.frame, position: [...e.position] });
  return [...byF.values()].map((k) => { const { quat, ...rest } = k; return rest; }).sort((a, b) => a.frame - b.frame);
}

/**
 * What a bake depends on: each actor's authored motion, placement and physics settings, not the bake's own results. A
 * key edited on a baked object (its keys no longer the ones the bake wrote) counts as a change.
 */
export function inputSig(actors) {
  return JSON.stringify((actors || []).map((a) => {
    const p = a.physics || {};
    const { baked, source, fracture, dents, takeover, crush, bakedKeys, world, ...settings } = p;
    const edited = baked && bakedKeys && JSON.stringify(a.keys) !== JSON.stringify(bakedKeys) ? a.keys : 0;
    const motion = baked ? ["baked", source?.keys ?? source?.position ?? null, edited] : ["keys", a.keys || null, a.position || null];
    return [a.id, a.kind, a.rotation_deg ?? 0, a.scale ?? 1, a.height_m ?? null, a.mount_id || null, motion, settings];
  }));
}

/**
 * A debounced re-bake: poke() on every edit, run() fires once the edits stop for `delay` ms. setTimer / clearTimer are
 * injectable (tests). Returns {poke, cancel, pending}.
 */
export function rebaker(run, { delay = 450, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let id = null;
  return {
    poke() { if (id != null) clearTimer(id); id = setTimer(() => { id = null; run(); }, delay); },
    cancel() { if (id != null) clearTimer(id); id = null; },
    pending: () => id != null,
  };
}

/** The bake's takeover markers in words: "physics took over at f 49 (2.0 s): the police car hit the red car". */
export function takeoverWords(takeovers, who = {}) {
  return Object.entries(takeovers || {}).filter(([, t]) => t.reason !== "unsupported").sort((a, b) => a[1].frame - b[1].frame).map(([id, t]) => {
    const nm = (x) => String(who[x]?.name || x.split("~")[0]).toLowerCase();
    const how = t.reason === "anchor" ? `knocked loose by the ${nm(t.by)}` : `hit the ${nm(t.by)}`;
    return `${nm(id)}: physics took over at f ${t.frame} (${(t.frame / (who.__fps || 24)).toFixed(1)} s), ${how} at ${(t.speed * 3.6).toFixed(0)} km/h`;
  });
}

/** Sample a baked actor at a frame (position and rotation), the same way the stage plays it back. */
export function sampleBaked(keys, frame) { return { pos: samplePos(keys, frame), quat: sampleQuat(keys, frame) }; }

/**
 * A loose prop at rest (a crate nobody set to Dynamic or Static): it stays exactly where it was put until something
 * touches it (static friction, ~30 x its mass in N, is all that holds it), then it is a dynamic body. What stands on it
 * goes with it. spec: the stage's dynamic spec for the prop; returns it with the hold.
 */
export function restingSpec(spec, supports = []) {
  return { ...spec, dynamic: true, release: 0, anchor: { force: Math.max(150, 30 * (spec.mass || 20)), energy: 0, supports } };
}

/**
 * Which resting things stand on which: list [{id, box: {min, max}}] (world AABBs at frame 0). B rests on A when B's
 * bottom is within 4 cm of A's top and their footprints overlap. Returns {id: [ids resting on it]}.
 */
export function restingSupports(list) {
  const out = {};
  for (const A of list) for (const B of list) {
    if (A === B) continue;
    const gap = B.box.min[1] - A.box.max[1];
    if (Math.abs(gap) > 0.04) continue;
    const ox = Math.min(A.box.max[0], B.box.max[0]) - Math.max(A.box.min[0], B.box.min[0]);
    const oz = Math.min(A.box.max[2], B.box.max[2]) - Math.max(A.box.min[2], B.box.min[2]);
    if (ox > 0.02 && oz > 0.02) (out[A.id] ||= []).push(B.id);
  }
  return out;
}

/**
 * Bake an actor's world result into it, keeping everything needed to undo it exactly (unbakeActor): its keys, its
 * position and its physics settings from before. keys: baked stage keys (null: keep its keys, e.g. a wall that broke);
 * info: {takeover, dents, fracture}.
 */
export function bakeActor(a, keys, info = {}) {
  const cl = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const src = { keys: cl(a.keys), position: cl(a.position), physics: cl(a.physics) };
  a.physics = { ...(a.physics || {}), source: src, baked: true, world: true };
  if (keys) { a.keys = keys; a.position = [...keys[0].position]; a.physics.bakedKeys = cl(keys); }
  if (info.takeover) a.physics.takeover = { ...info.takeover };
  if (info.dents?.length) a.physics.dents = info.dents.map(({ frame, p, n, depth, radius }) => ({ frame, p, n, depth, radius }));
  if (info.fracture) a.physics.fracture = info.fracture;
  return a;
}

/** Undo bakeActor exactly; merge: keep key edits made on the baked object (mergeEdits) in its authored keys. */
export function unbakeActor(a, { merge = false } = {}) {
  const src = a.physics?.source;
  if (!src || !a.physics.world) return false;
  const base = src.keys || (src.position ? [{ frame: 0, position: src.position }] : null);
  const merged = merge && a.physics.bakedKeys ? mergeEdits(base, a.physics.bakedKeys, a.keys) : null;
  const restore = (k, v) => { if (v === undefined) delete a[k]; else a[k] = v; };
  restore("keys", merged || src.keys);
  restore("position", merged ? [...merged[0].position] : src.position);
  restore("physics", src.physics);
  return true;
}
