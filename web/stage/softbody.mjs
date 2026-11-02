// Soundstage soft bodies (Milestone 28): Vellum-style cloth, ropes, cardboard and grains on XPBD particles.
//
// One particle solver (small-steps XPBD: many substeps, one constraint pass each, Macklin et al. 2019) runs four kinds:
//   - cloth:     a sheet of particles with stretch + shear (triangle edges) and bending (the distance across each pair
//                of triangles) constraints, pins (fixed in place or riding an actor: a flag on its pole, a cape on a
//                rider), and aerodynamic wind per triangle with seeded gust fronts. Tarps, flags, curtains, capes and
//                the deck of a rope bridge.
//   - rope:      a chain with stretch and bending (i, i+2) constraints; cables are heavier and stiffer.
//   - cardboard: a closed box shell, stiff in stretch and bending, with plasticity: a bend or a squash past the yield
//                strain creeps its rest length, so a crushed box stays crushed and folds along creases (seeded weak
//                lines, so no two boxes fold the same).
//   - grains:    sand and gravel as spheres with grain-to-grain contacts and position-based static friction, so a
//                heap slumps to its angle of repose and spills when something drives through it.
// Everything collides with the ground and with the stage's props, people and vehicles (oriented boxes on their
// keyed / baked motion, the same proxies the rigid bake uses). The bake is deterministic (no randomness beyond the
// seed, fixed step, fixed order) and is a vertex cache: one Float32Array of world positions per frame, which the
// stage plays back in the clay, Color, Depth and ID passes (soft bodies are real objects on the set).
// Pure functions, no three.js.

export const SOFT_TYPES = ["cloth", "rope", "cardboard", "grains"];
const GRAV = 9.81;
/** Fastest a soft particle may move (m/s): faster than any thrown sand or flapping hem, slower than an explosion. */
const VMAX = 18;

/**
 * Soft-body kinds (library kinds): their type and default shape. Sizes in metres; `h` is the height of the top
 * (cloth / rope) or of the box. pins: "top_corners" | "top_edge" | "left_edge" | "ends" | "end" | "bridge" | "none".
 */
export const SOFT_KINDS = Object.freeze({
  tarp: { type: "cloth", label: "Tarp", w: 3, l: 2, h: 2.4, res: 0.15, density: 0.35, pins: "top_corners", wind: 7, stiff: 0.9, bend: 0.02 },
  flag: { type: "cloth", label: "Flag", w: 1.5, l: 1.0, h: 3.2, res: 0.1, density: 0.15, pins: "left_edge", wind: 6, stiff: 0.9, bend: 0.01 },
  curtain: { type: "cloth", label: "Curtain", w: 2.4, l: 2.4, h: 2.5, res: 0.15, density: 0.4, pins: "top_edge", wind: 1.2, stiff: 0.85, bend: 0.03 },
  cape: { type: "cloth", label: "Clothing panel", w: 0.55, l: 0.9, h: 1.45, res: 0.07, density: 0.3, pins: "top_edge", wind: 1, stiff: 0.9, bend: 0.03 },
  rope: { type: "rope", label: "Rope", len: 4, h: 2.0, res: 0.1, density: 0.25, pins: "ends", slack: 0.08, bend: 0.002 },
  cable: { type: "rope", label: "Cable", len: 5, h: 3.0, res: 0.12, density: 1.2, pins: "ends", slack: 0.05, bend: 0.05 },
  rope_bridge: { type: "cloth", label: "Rope bridge", shape: "bridge", w: 1.0, l: 8, h: 1.6, res: 0.25, density: 6, pins: "bridge", wind: 0.5, stiff: 1, bend: 0.0, slack: 0.04 },
  cardboard: { type: "cardboard", label: "Cardboard box", size: [0.6, 0.45, 0.45], res: 0.075, density: 0.6, yield: 0.06, creep: 0.6 },
  sand_pile: { type: "grains", label: "Sand pile", material: "sand", radius: 0.6, height: 0.9, grain: 0.035, friction: 0.85 },
  gravel_pile: { type: "grains", label: "Gravel pile", material: "gravel", radius: 0.7, height: 0.8, grain: 0.05, friction: 0.75 },
});
export const isSoftKind = (k) => Object.prototype.hasOwnProperty.call(SOFT_KINDS, k);

/** An actor's soft-body settings: the kind's defaults with a.physics.soft overrides. null when it isn't a soft body. */
export function softSpecOf(a) {
  const base = SOFT_KINDS[a?.physics?.soft?.kind] || SOFT_KINDS[a?.kind];
  if (!base) return null;
  const o = a?.physics?.soft || {};
  const spec = { ...base, ...o, kind: a.kind };
  for (const k of ["wind", "stiff", "bend", "density", "friction", "slack"]) if (o[k] != null && !Number.isFinite(+o[k])) delete spec[k];
  spec.seed = Number.isFinite(+o.seed) ? +o.seed : seedOf(a.id || "soft");
  spec.wind_deg = Number.isFinite(+o.wind_deg) ? +o.wind_deg : 90;   // the wind blows towards +X by default
  spec.gust = Number.isFinite(+o.gust) ? +o.gust : 0.6;
  return spec;
}

export function hash01(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
export function seedOf(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100003;
}

// ---------- building the particle systems (local frame: origin on the floor, Y up, +Z front) ----------
/**
 * The soft body's topology in its own frame: {type, n, rest (Float64Array 3n), inv (inverse masses), radius,
 * tris (render triangles), lines ([[i...]] rope polylines to draw), dist ([i, j, rest, compliance, plastic?]),
 * pins ([i]), cells (grains: per-particle radius)}.
 */
export function buildSoft(spec) {
  if (spec.type === "cloth") return spec.shape === "bridge" ? buildBridge(spec) : buildCloth(spec);
  if (spec.type === "rope") return buildRope(spec);
  if (spec.type === "cardboard") return buildCardboard(spec);
  if (spec.type === "grains") return buildGrains(spec);
  throw new Error(`unknown soft type ${spec.type}`);
}

function sys(type, n) {
  return { type, n, rest: new Float64Array(3 * n), inv: new Float64Array(n), radius: 0.02, tris: [], lines: [], dist: [], bend: [], pins: [] };
}
const d3 = (r, i, j) => Math.hypot(r[3 * i] - r[3 * j], r[3 * i + 1] - r[3 * j + 1], r[3 * i + 2] - r[3 * j + 2]);

/** Stretch + shear on every triangle edge, bending across every shared edge, from a triangle list (shared verts). */
function meshConstraints(S, compliance, bendCompliance, plastic = null, weak = null) {
  const edges = new Map();
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [a, b, c] of S.tris) for (const [p, q, o] of [[a, b, c], [b, c, a], [c, a, b]]) {
    const k = key(p, q);
    if (!edges.has(k)) edges.set(k, { p, q, opp: [o] });
    else edges.get(k).opp.push(o);
  }
  for (const e of edges.values()) {
    S.dist.push([e.p, e.q, d3(S.rest, e.p, e.q), compliance, plastic]);
    if (e.opp.length === 2) {
      const w = weak ? weak(e) : 1;
      S.bend.push([e.opp[0], e.opp[1], d3(S.rest, e.opp[0], e.opp[1]), bendCompliance * w, plastic && { ...plastic, yield: plastic.yield / Math.sqrt(w) }]);
    }
  }
}

function buildCloth(spec) {
  const res = Math.max(0.04, spec.res || 0.15);
  const nx = Math.max(2, Math.round(spec.w / res) + 1), ny = Math.max(2, Math.round(spec.l / res) + 1);
  const S = sys("cloth", nx * ny);
  const dm = (spec.density || 0.3) * (spec.w * spec.l) / S.n;   // kg per particle
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    // A vertical sheet in the XY plane hanging from y = h; a flag runs from its pole (x = 0) towards +X.
    const x = spec.pins === "left_edge" ? (i / (nx - 1)) * spec.w : (i / (nx - 1) - 0.5) * spec.w;
    S.rest[3 * k] = x; S.rest[3 * k + 1] = spec.h - (j / (ny - 1)) * spec.l; S.rest[3 * k + 2] = 0;
    S.inv[k] = 1 / dm;
  }
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    // Alternate the diagonal so the sheet has no grain.
    if ((i + j) % 2) S.tris.push([a, c, b], [b, c, d]); else S.tris.push([a, c, d], [a, d, b]);
  }
  const stiff = Math.max(0.05, Math.min(1, spec.stiff ?? 0.9));
  meshConstraints(S, (1 - stiff) * 2e-5 + 1e-7, Math.max(1e-6, (0.02 / Math.max(0.0005, spec.bend ?? 0.02)) * 2e-3));
  const pin = (k) => { S.inv[k] = 0; S.pins.push(k); };
  if (spec.pins === "top_corners") { pin(0); pin(nx - 1); }
  else if (spec.pins === "top_edge") for (let i = 0; i < nx; i += spec.kind === "curtain" ? 2 : 1) pin(i);
  else if (spec.pins === "left_edge") for (let j = 0; j < ny; j++) pin(j * nx);
  S.radius = Math.min(0.04, res * 0.35);
  S.grid = [nx, ny];
  return S;
}

function buildBridge(spec) {
  // The deck: a strip 3 particles wide along X (length l, width w, at height h), planks between the rails; two hand
  // ropes 0.9 m above its edges, tied to the deck edge every other particle. Pinned at both ends (the anchor posts).
  const res = Math.max(0.15, spec.res || 0.25), nl = Math.max(4, Math.round(spec.l / res) + 1), nw = 3;
  const deckN = nl * nw, railN = nl * 2;
  const S = sys("cloth", deckN + railN);
  const slack = 1 + (spec.slack ?? 0.04);
  const dm = (spec.density || 6) * spec.l * spec.w / deckN;
  for (let i = 0; i < nl; i++) for (let j = 0; j < nw; j++) {
    const k = i * nw + j;
    S.rest[3 * k] = (i / (nl - 1) - 0.5) * spec.l; S.rest[3 * k + 1] = spec.h; S.rest[3 * k + 2] = (j / (nw - 1) - 0.5) * spec.w;
    S.inv[k] = 1 / dm;
  }
  for (let i = 0; i < nl - 1; i++) for (let j = 0; j < nw - 1; j++) {
    const a = i * nw + j, b = a + 1, c = a + nw, d = c + 1;
    S.tris.push([a, c, d], [a, d, b]);
  }
  meshConstraints(S, 2e-7, 4e-3);
  // Slack: every deck rest length a few percent long, so the deck hangs in a catenary under its own weight.
  for (const c of S.dist) c[2] *= slack;
  for (let side = 0; side < 2; side++) {
    const line = [];
    for (let i = 0; i < nl; i++) {
      const k = deckN + side * nl + i, deck = i * nw + (side ? nw - 1 : 0);
      S.rest[3 * k] = S.rest[3 * deck]; S.rest[3 * k + 1] = spec.h + 0.9; S.rest[3 * k + 2] = S.rest[3 * deck + 2] * 1.05;
      S.inv[k] = 1 / 0.6;
      line.push(k);
      if (i) S.dist.push([k - 1, k, d3(S.rest, k - 1, k) * (1 + (spec.slack ?? 0.04) * 0.6), 1e-7, null]);
      if (i % 2 === 0) { S.dist.push([k, deck, 0.9, 1e-6, null]); line.hangers = (line.hangers || []).concat([[k, deck]]); }
    }
    S.lines.push(line);
  }
  // Hangers drawn too.
  for (const line of [...S.lines]) for (const h of line.hangers || []) S.lines.push(h);
  for (const k of [0, 1, 2, deckN - 1, deckN - 2, deckN - 3, deckN, deckN + nl - 1, deckN + nl, deckN + 2 * nl - 1]) { S.inv[k] = 0; S.pins.push(k); }
  S.radius = 0.06;
  S.deck = [nl, nw];
  return S;
}

function buildRope(spec) {
  const n = Math.max(4, Math.round(spec.len / Math.max(0.04, spec.res || 0.1)) + 1);
  const S = sys("rope", n);
  const dm = (spec.density || 0.25) * spec.len / n;
  const hang = spec.pins === "end";
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    if (hang) { S.rest[3 * i] = 0; S.rest[3 * i + 1] = spec.h - u * Math.min(spec.len, spec.h - 0.05); S.rest[3 * i + 2] = 0; }
    else { S.rest[3 * i] = (u - 0.5) * spec.len / (1 + (spec.slack ?? 0.08)); S.rest[3 * i + 1] = spec.h; S.rest[3 * i + 2] = 0; }
    S.inv[i] = 1 / dm;
  }
  const seg = spec.len / (n - 1);
  for (let i = 1; i < n; i++) S.dist.push([i - 1, i, seg, 1e-8, null]);
  for (let i = 2; i < n; i++) S.bend.push([i - 2, i, 2 * seg, Math.max(1e-6, 1e-4 / Math.max(1e-4, spec.bend ?? 0.002)) * 1e-3, null]);
  S.lines.push([...Array(n).keys()]);
  if (hang) { S.inv[0] = 0; S.pins.push(0); }
  else if (spec.pins === "ends") { S.inv[0] = 0; S.inv[n - 1] = 0; S.pins.push(0, n - 1); }
  S.radius = spec.kind === "cable" ? 0.025 : 0.015;
  return S;
}

function buildCardboard(spec) {
  const [W, H, D] = spec.size || [0.6, 0.45, 0.45], res = Math.max(0.03, spec.res || 0.075);
  const map = new Map(), pos = [], tris = [];
  const vid = (x, y, z) => {
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    if (!map.has(k)) { map.set(k, pos.length / 3); pos.push(x, y, z); }
    return map.get(k);
  };
  // Six faces, each a grid; shared edge vertices are welded so the shell is closed.
  const face = (o, u, v, nu, nv, flip) => {
    const ids = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) ids.push(vid(o[0] + u[0] * i / nu + v[0] * j / nv, o[1] + u[1] * i / nu + v[1] * j / nv, o[2] + u[2] * i / nu + v[2] * j / nv));
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = ids[j * (nu + 1) + i], b = ids[j * (nu + 1) + i + 1], c = ids[(j + 1) * (nu + 1) + i], d = ids[(j + 1) * (nu + 1) + i + 1];
      if (flip) tris.push([a, c, b], [b, c, d]); else tris.push([a, b, c], [b, d, c]);
    }
  };
  const nw = Math.max(2, Math.round(W / res)), nh = Math.max(2, Math.round(H / res)), nd = Math.max(2, Math.round(D / res));
  const x0 = -W / 2, z0 = -D / 2;
  face([x0, 0, z0], [W, 0, 0], [0, 0, D], nw, nd, false);        // bottom
  face([x0, H, z0], [W, 0, 0], [0, 0, D], nw, nd, true);         // top
  face([x0, 0, z0], [W, 0, 0], [0, H, 0], nw, nh, true);         // back
  face([x0, 0, -z0], [W, 0, 0], [0, H, 0], nw, nh, false);       // front
  face([x0, 0, z0], [0, 0, D], [0, H, 0], nd, nh, false);        // left
  face([-x0, 0, z0], [0, 0, D], [0, H, 0], nd, nh, true);        // right
  const n = pos.length / 3, S = sys("cardboard", n);
  S.rest.set(pos);
  const area = 2 * (W * H + W * D + H * D), dm = (spec.density || 0.6) * area / n;
  for (let i = 0; i < n; i++) S.inv[i] = 1 / dm;
  S.tris = tris;
  // Seeded weak lines (creases): a few bands across the faces where the board bends and yields first.
  const seed = spec.seed || 1;
  const bands = [0, 1, 2].map((k) => ({ ax: Math.floor(hash01(seed, k, 1) * 3), at: hash01(seed, k, 2) - 0.5, w: 0.25 + 0.3 * hash01(seed, k, 3) }));
  const weak = (e) => {
    const m = [(S.rest[3 * e.p] + S.rest[3 * e.q]) / 2, (S.rest[3 * e.p + 1] + S.rest[3 * e.q + 1]) / 2 - H / 2, (S.rest[3 * e.p + 2] + S.rest[3 * e.q + 2]) / 2];
    const ext = [W, H, D];
    let w = 1;
    for (const b of bands) if (Math.abs(m[b.ax] / ext[b.ax] - b.at * 0.6) < 0.06) w += 6 * b.w;
    return w;
  };
  meshConstraints(S, 1e-8, 2e-6, { yield: spec.yield ?? 0.06, creep: spec.creep ?? 0.6 }, weak);
  // Stretch plasticity too (a squashed panel buckles and keeps its shorter edges), with a higher yield.
  for (const c of S.dist) c[4] = { yield: (spec.yield ?? 0.06) * 1.8, creep: (spec.creep ?? 0.6) * 0.5 };
  S.radius = 0.012;
  return S;
}

function buildGrains(spec) {
  const r = Math.max(0.015, spec.grain || 0.035), R = spec.radius || 0.6, Hh = spec.height || 0.9;
  const pts = [];
  // A steep heap (a cone higher than sand can hold: it slumps from frame 0), hexagonal-ish packing with seeded jitter.
  const step = 2 * r * 1.02, seed = spec.seed || 1;
  for (let y = r, layer = 0; y < Hh; y += step * 0.88, layer++) {
    const rr = R * (1 - y / (Hh * 1.05));
    if (rr < r) break;
    const off = layer % 2 ? step / 2 : 0;
    for (let x = -rr + off; x <= rr; x += step) for (let z = -rr + off; z <= rr; z += step) {
      if (x * x + z * z > rr * rr) continue;
      const i = pts.length / 3;
      pts.push(x + (hash01(seed, i, 1) - 0.5) * r * 0.5, y + hash01(seed, i, 3) * r * 0.3, z + (hash01(seed, i, 2) - 0.5) * r * 0.5);
    }
  }
  const n = Math.min(3000, pts.length / 3), S = sys("grains", n);
  S.rest.set(pts.slice(0, 3 * n));
  const m = (spec.material === "gravel" ? 2600 : 1600) * (4 / 3) * Math.PI * r ** 3 * 0.6;
  for (let i = 0; i < n; i++) S.inv[i] = 1 / m;
  S.radius = r;
  S.friction = spec.friction ?? 0.55;
  return S;
}

// ---------- poses (quaternions [x, y, z, w]) ----------
const qrot = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnl = (a, b, t) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = d < 0 ? -1 : 1;
  const q = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t];
  const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const poseAt = (poses, f) => {
  if (!poses?.length) return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 };
  const i = Math.max(0, Math.min(poses.length - 1, Math.floor(f))), j = Math.min(poses.length - 1, i + 1), t = Math.max(0, Math.min(1, f - i));
  const a = poses[i], b = poses[j];
  return { pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * t, a.pos[1] + (b.pos[1] - a.pos[1]) * t, a.pos[2] + (b.pos[2] - a.pos[2]) * t], quat: qnl(a.quat, b.quat, t), scale: a.scale ?? 1 };
};
const toWorld = (P, v) => { const s = P.scale ?? 1, r = qrot(P.quat, [v[0] * s, v[1] * s, v[2] * s]); return [r[0] + P.pos[0], r[1] + P.pos[1], r[2] + P.pos[2]]; };

// ---------- wind ----------
/** The wind at a point and time: a base speed along wind_deg with gust fronts that travel downwind (seeded). */
export function windAt(spec, p, t) {
  const sp = spec.wind || 0, a = (spec.wind_deg ?? 90) * Math.PI / 180, dx = Math.sin(a), dz = Math.cos(a);
  if (!sp) return [0, 0, 0];
  const s = spec.seed || 1, along = p[0] * dx + p[2] * dz, x = along - sp * t;
  const g = 0.55 * Math.sin(x * 0.9 + s) + 0.3 * Math.sin(x * 2.3 + s * 1.7 + p[1] * 0.8) + 0.15 * Math.sin(x * 5.1 + s * 2.9 + (p[0] * dz - p[2] * dx) * 1.3);
  const m = sp * (1 + (spec.gust ?? 0.6) * g);
  const side = 0.18 * sp * Math.sin(x * 1.7 + s * 3.1), up = 0.08 * sp * Math.sin(x * 1.3 + s * 0.7);
  return [dx * m + dz * side, up, dz * m - dx * side];
}

// ---------- the solver ----------
/**
 * Bake one soft body. spec: softSpecOf(); opts: {frames, fps = 24, poses (the actor's own [{pos, quat, scale}] per
 * frame: where the rest shape and the pins sit), attach ({poses} of the actor the pins ride, e.g. a cape's rider),
 * colliders ([{id, half, center, poses}] oriented boxes per frame), substeps (default per type), preroll (frames of
 * settling before frame 0, colliders and pins held at frame 0), gravity}.
 * Returns {frames: [Float32Array(3n)] world positions per frame, sys (the topology), stats {ms, maxStretch,
 * maxSpeed, finite, settledFrame, minY}}.
 */
export function simulateSoft(spec, opts = {}) {
  const t0 = Date.now();
  const S = buildSoft(spec);
  const frames = Math.max(1, opts.frames || 97), fps = opts.fps || 24;
  const sub = opts.substeps || { cloth: 16, rope: 16, cardboard: 20, grains: 6 }[S.type];
  const dt = 1 / (fps * sub), g = opts.gravity ?? GRAV, n = S.n;
  const own = opts.poses?.length ? opts.poses : [{ pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 }];
  const att = opts.attach?.poses?.length ? opts.attach.poses : null;
  const P0 = poseAt(own, 0);
  const x = new Float64Array(3 * n), v = new Float64Array(3 * n), px = new Float64Array(3 * n), wv = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) { const w = toWorld(P0, [S.rest[3 * i], S.rest[3 * i + 1], S.rest[3 * i + 2]]); x[3 * i] = w[0]; x[3 * i + 1] = w[1]; x[3 * i + 2] = w[2]; }
  const scale = P0.scale ?? 1;
  const dist = S.dist.map((c) => [c[0], c[1], c[2] * scale, c[3], c[4], c[2] * scale]);
  const bend = S.bend.map((c) => [c[0], c[1], c[2] * scale, c[3], c[4], c[2] * scale]);
  // Pins: their frame-0 world point, carried by the pose track they ride (own keys, or the attached actor).
  const pinTrack = att || own, A0 = poseAt(pinTrack, 0), A0i = qinv(A0.quat);
  const pinLocal = S.pins.map((i) => { const d = [x[3 * i] - A0.pos[0], x[3 * i + 1] - A0.pos[1], x[3 * i + 2] - A0.pos[2]]; return qrot(A0i, d); });
  const pinAt = (f) => { const A = poseAt(pinTrack, f); return pinLocal.map((l) => { const r = qrot(A.quat, l); return [r[0] + A.pos[0], r[1] + A.pos[1], r[2] + A.pos[2]]; }); };
  const cols = (opts.colliders || []).filter((c) => c?.poses?.length && c.half).map((c) => ({ ...c, bound: Math.hypot(c.half[0], c.half[1], c.half[2]) }));
  const rad = S.radius, fr = S.type === "grains" ? S.friction : S.type === "cardboard" ? 0.7 : 0.5;
  const out = [];
  let maxStretch = 0, maxSpeed = 0, finite = true, settledFrame = null;
  const rest0 = dist.map((c) => c[5]);
  const preroll = Math.max(0, Math.round(opts.preroll ?? spec.preroll ?? { cloth: 36, rope: 36, cardboard: 6, grains: 0 }[S.type]));
  // Grains: a uniform hash grid for neighbour contacts.
  const cell = 2 * rad, hashT = new Map(), nc = new Int32Array(n), sleepV = S.type === "grains" ? 0.05 + 0.08 * (S.friction || 0.6) : 0;
  const ckey = (ix, iy, iz) => (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);

  const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const colliderPosesOf = (list, f) => list.map((c) => {
    const P0 = poseAt(c.poses, f), Pp = poseAt(c.poses, Math.max(0, f - 1 / sub));
    // A collider may sit at an angle on its body (c.rot, local quaternion): a car's raked nose.
    const P = c.rot ? { ...P0, quat: qmul(P0.quat, c.rot) } : P0;
    const cen = qrot(P0.quat, c.center || [0, 0, 0]), cenp = qrot(Pp.quat, c.center || [0, 0, 0]);
    const pos = [P.pos[0] + cen[0], P.pos[1] + cen[1], P.pos[2] + cen[2]];
    return { pos, quat: P.quat, qi: qinv(P.quat), half: c.half, vel: [(pos[0] - Pp.pos[0] - cenp[0]) * fps * sub, (pos[1] - Pp.pos[1] - cenp[1]) * fps * sub, (pos[2] - Pp.pos[2] - cenp[2]) * fps * sub] };
  });

  const step = (f) => {
    // f: shot time in frames (negative during the preroll: everything held at frame 0).
    const fc = Math.max(0, f), t = f / fps;
    // 1. Predict: gravity, wind drag on triangles (cloth), a little air damping.
    for (let i = 0; i < n; i++) {
      if (!S.inv[i]) continue;
      v[3 * i + 1] -= g * dt;
    }
    if (S.type === "cloth" && spec.wind) for (let i = 0; i < n; i++) {
      const w = windAt(spec, [x[3 * i], x[3 * i + 1], x[3 * i + 2]], t);
      wv[3 * i] = w[0]; wv[3 * i + 1] = w[1]; wv[3 * i + 2] = w[2];
    }
    if (S.type === "cloth" && spec.wind) for (const [a, b, c] of S.tris) {
      const ax = x[3 * a], ay = x[3 * a + 1], az = x[3 * a + 2];
      const e1 = [x[3 * b] - ax, x[3 * b + 1] - ay, x[3 * b + 2] - az], e2 = [x[3 * c] - ax, x[3 * c + 1] - ay, x[3 * c + 2] - az];
      const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const A2 = Math.hypot(...nn);
      if (A2 < 1e-9) continue;
      const nu = [nn[0] / A2, nn[1] / A2, nn[2] / A2];
      const w = [(wv[3 * a] + wv[3 * b] + wv[3 * c]) / 3, (wv[3 * a + 1] + wv[3 * b + 1] + wv[3 * c + 1]) / 3, (wv[3 * a + 2] + wv[3 * b + 2] + wv[3 * c + 2]) / 3];
      const vr = [w[0] - (v[3 * a] + v[3 * b] + v[3 * c]) / 3, w[1] - (v[3 * a + 1] + v[3 * b + 1] + v[3 * c + 1]) / 3, w[2] - (v[3 * a + 2] + v[3 * b + 2] + v[3 * c + 2]) / 3];
      const vn = vr[0] * nu[0] + vr[1] * nu[1] + vr[2] * nu[2];
      // Pressure drag on the face (0.5 ρ Cd A |vn| vn) plus a little skin friction along it; split over the 3 corners.
      const F = 0.5 * 1.2 * 1.1 * (A2 / 2) * vn * Math.abs(vn) / 3, sk = 0.02 * (A2 / 2) / 3;
      for (const k of [a, b, c]) {
        if (!S.inv[k]) continue;
        v[3 * k] += (F * nu[0] + sk * vr[0]) * S.inv[k] * dt; v[3 * k + 1] += (F * nu[1] + sk * vr[1]) * S.inv[k] * dt; v[3 * k + 2] += (F * nu[2] + sk * vr[2]) * S.inv[k] * dt;
      }
    }
    const damp = S.type === "grains" ? 0.993 : 0.9995;
    for (let i = 0; i < 3 * n; i++) { px[i] = x[i]; if (S.inv[(i / 3) | 0]) { v[i] *= damp; x[i] += v[i] * dt; } }
    // 2. Pins.
    const pt = pinAt(fc);
    S.pins.forEach((i, k) => { x[3 * i] = pt[k][0]; x[3 * i + 1] = pt[k][1]; x[3 * i + 2] = pt[k][2]; });
    // 3. Constraints (XPBD, one pass per small step; compliance α / dt²).
    const solve = (list, plasticOK) => {
      for (const c of list) {
        const i = c[0], j = c[1], wi = S.inv[i], wj = S.inv[j], W = wi + wj;
        if (!W) continue;
        const dx = x[3 * i] - x[3 * j], dy = x[3 * i + 1] - x[3 * j + 1], dz = x[3 * i + 2] - x[3 * j + 2];
        const L = Math.hypot(dx, dy, dz);
        if (L < 1e-9) continue;
        const C = L - c[2], al = c[3] / (dt * dt);
        const lam = -C / (W + al);
        const sx = dx / L * lam, sy = dy / L * lam, sz = dz / L * lam;
        x[3 * i] += sx * wi; x[3 * i + 1] += sy * wi; x[3 * i + 2] += sz * wi;
        x[3 * j] -= sx * wj; x[3 * j + 1] -= sy * wj; x[3 * j + 2] -= sz * wj;
        // Plasticity: strain past the yield creeps the rest length (a fold that stays folded).
        const pl = c[4];
        if (plasticOK && pl) {
          const strain = (L - c[2]) / c[5];
          if (Math.abs(strain) > pl.yield) {
            const target = L - Math.sign(strain) * pl.yield * c[5];
            c[2] += (target - c[2]) * pl.creep * 0.05;
            c[2] = Math.max(0.25 * c[5], Math.min(1.6 * c[5], c[2]));
          }
        }
      }
    };
    const iters = S.type === "cloth" || S.type === "rope" ? 2 : 1;
    for (let it = 0; it < iters; it++) { solve(dist, f >= 0 && it === 0); solve(bend, f >= 0 && it === 0); }
    // 4. Grains: contacts between neighbours (hash grid), with static friction.
    if (S.type === "grains") {
      hashT.clear();
      for (let i = 0; i < n; i++) {
        const k = ckey(Math.floor(x[3 * i] / cell), Math.floor(x[3 * i + 1] / cell), Math.floor(x[3 * i + 2] / cell));
        let b = hashT.get(k); if (!b) hashT.set(k, (b = [])); b.push(i);
      }
      const d2 = (2 * rad) ** 2, gdt2 = g * dt * dt;
      nc.fill(0);
      for (let i = 0; i < n; i++) {
        const cx = Math.floor(x[3 * i] / cell), cy = Math.floor(x[3 * i + 1] / cell), cz = Math.floor(x[3 * i + 2] / cell);
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
          const b = hashT.get(ckey(cx + ox, cy + oy, cz + oz));
          if (!b) continue;
          for (const j of b) {
            if (j <= i) continue;
            const dx = x[3 * i] - x[3 * j], dy = x[3 * i + 1] - x[3 * j + 1], dz = x[3 * i + 2] - x[3 * j + 2];
            const q = dx * dx + dy * dy + dz * dz;
            if (q >= d2 || q < 1e-12) continue;
            const L = Math.sqrt(q), pen = 2 * rad - L, nx = dx / L, ny = dy / L, nz = dz / L;
            nc[i]++; nc[j]++;
            x[3 * i] += nx * pen * 0.5; x[3 * i + 1] += ny * pen * 0.5; x[3 * i + 2] += nz * pen * 0.5;
            x[3 * j] -= nx * pen * 0.5; x[3 * j + 1] -= ny * pen * 0.5; x[3 * j + 2] -= nz * pen * 0.5;
            // Static friction (PBD): cancel the relative tangential slide this step if it is within μ·penetration.
            const rx = (x[3 * i] - px[3 * i]) - (x[3 * j] - px[3 * j]), ry = (x[3 * i + 1] - px[3 * i + 1]) - (x[3 * j + 1] - px[3 * j + 1]), rz = (x[3 * i + 2] - px[3 * i + 2]) - (x[3 * j + 2] - px[3 * j + 2]);
            const rn = rx * nx + ry * ny + rz * nz, tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz, tl = Math.hypot(tx, ty, tz);
            if (tl > 1e-12) {
              const lim = fr * Math.max(pen, gdt2) * 2.5, k = tl < lim ? 1 : Math.min(1, lim / tl);
              x[3 * i] -= tx * 0.5 * k; x[3 * i + 1] -= ty * 0.5 * k; x[3 * i + 2] -= tz * 0.5 * k;
              x[3 * j] += tx * 0.5 * k; x[3 * j + 1] += ty * 0.5 * k; x[3 * j + 2] += tz * 0.5 * k;
            }
          }
        }
      }
    }
    // 5. Collisions: the ground and every collider box (on its motion at this time), with friction against its motion.
    // Broad phase: only the colliders whose bounding sphere reaches the body's box this step.
    let cp = [];
    if (cols.length) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const a = x[3 * i], b = x[3 * i + 1], c = x[3 * i + 2];
        if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b; if (c < z0) z0 = c; if (c > z1) z1 = c;
      }
      const near = cols.filter((c) => {
        const P = poseAt(c.poses, fc), cen = qrot(P.quat, c.center || [0, 0, 0]), R = c.bound + rad + 0.05;
        const px_ = P.pos[0] + cen[0], py_ = P.pos[1] + cen[1], pz_ = P.pos[2] + cen[2];
        const dx = Math.max(x0 - px_, 0, px_ - x1), dy = Math.max(y0 - py_, 0, py_ - y1), dz = Math.max(z0 - pz_, 0, pz_ - z1);
        return dx * dx + dy * dy + dz * dz < R * R;
      });
      cp = near.length ? colliderPosesOf(near, fc) : [];
    }
    for (let i = 0; i < n; i++) {
      if (!S.inv[i]) continue;
      let hit = null, cv = null;
      if (x[3 * i + 1] < rad) { x[3 * i + 1] = rad; hit = [0, 1, 0]; cv = [0, 0, 0]; }
      for (const b of cp) {
        const l = qrot(b.qi, [x[3 * i] - b.pos[0], x[3 * i + 1] - b.pos[1], x[3 * i + 2] - b.pos[2]]);
        const pen = [b.half[0] + rad - Math.abs(l[0]), b.half[1] + rad - Math.abs(l[1]), b.half[2] + rad - Math.abs(l[2])];
        if (pen[0] <= 0 || pen[1] <= 0 || pen[2] <= 0) continue;
        const ax = pen[0] < pen[1] ? (pen[0] < pen[2] ? 0 : 2) : (pen[1] < pen[2] ? 1 : 2);
        const nl = [0, 0, 0]; nl[ax] = Math.sign(l[ax]) || 1;
        l[ax] += nl[ax] * pen[ax];
        const w = qrot(b.quat, l);
        x[3 * i] = w[0] + b.pos[0]; x[3 * i + 1] = w[1] + b.pos[1]; x[3 * i + 2] = w[2] + b.pos[2];
        hit = qrot(b.quat, nl); cv = b.vel;
      }
      if (x[3 * i + 1] < rad) { x[3 * i + 1] = rad; if (!hit) { hit = [0, 1, 0]; cv = [0, 0, 0]; } }
      if (hit) {
        // Friction: remove part of the slide relative to the surface's own motion this step.
        const mx = x[3 * i] - px[3 * i] - cv[0] * dt, my = x[3 * i + 1] - px[3 * i + 1] - cv[1] * dt, mz = x[3 * i + 2] - px[3 * i + 2] - cv[2] * dt;
        const mn = mx * hit[0] + my * hit[1] + mz * hit[2];
        const tx = mx - mn * hit[0], ty = my - mn * hit[1], tz = mz - mn * hit[2];
        // The ground grips; a moving body mostly slides over what it squashes (a car leaves the crushed box behind).
        const onGround = x[3 * i + 1] <= rad + 1e-4, still = !cv[0] && !cv[1] && !cv[2];
        const k = S.type === "grains" ? Math.min(1, fr * 1.4) : onGround || still ? fr * 0.5 : fr * 0.12;
        x[3 * i] -= tx * k; x[3 * i + 1] -= ty * k; x[3 * i + 2] -= tz * k;
      }
    }
    // Grains at rest stay at rest: a grain held by 3+ neighbours (or the ground) creeping slower than the sleep speed
    // keeps its place this step (particle sleeping; frictional spheres would otherwise roll down to ~20°).
    if (S.type === "grains") for (let i = 0; i < n; i++) {
      if ((nc[i] + (x[3 * i + 1] <= rad + 1e-4 ? 2 : 0)) < 4) continue;
      const dx = x[3 * i] - px[3 * i], dy = x[3 * i + 1] - px[3 * i + 1], dz = x[3 * i + 2] - px[3 * i + 2];
      if (Math.hypot(dx, dy, dz) < sleepV * dt) { x[3 * i] = px[3 * i]; x[3 * i + 1] = Math.max(px[3 * i + 1], rad); x[3 * i + 2] = px[3 * i + 2]; }
    }
    // 6. Velocities from positions.
    for (let i = 0; i < 3 * n; i++) v[i] = (x[i] - px[i]) / dt;
    // A collider can shove a particle a long way in one step (a car through sand): cap the speed it leaves with.
    for (let i = 0; i < n; i++) {
      const sp = Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]);
      if (sp > VMAX) { const k = VMAX / sp; v[3 * i] *= k; v[3 * i + 1] *= k; v[3 * i + 2] *= k; }
    }
  };

  for (let f = -preroll; f < 0; f++) for (let s = 0; s < sub; s++) step(f + s / sub);
  for (let f = 0; f < frames; f++) {
    if (f > 0) for (let s = 0; s < sub; s++) step(f - 1 + (s + 1) / sub);
    const fr32 = new Float32Array(3 * n);
    let sp = 0;
    for (let i = 0; i < 3 * n; i++) { fr32[i] = x[i]; if (!Number.isFinite(x[i])) finite = false; }
    for (let i = 0; i < n; i++) sp = Math.max(sp, Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]));
    maxSpeed = Math.max(maxSpeed, sp);
    if (sp < 0.05 && settledFrame == null) settledFrame = f;
    if (sp >= 0.05) settledFrame = null;
    out.push(fr32);
  }
  // Stretch at the end, against the original rest lengths (plasticity excluded: that is the board's own crushing).
  dist.forEach((c, k) => { if (c[4]) return; const L = Math.hypot(x[3 * c[0]] - x[3 * c[1]], x[3 * c[0] + 1] - x[3 * c[1] + 1], x[3 * c[0] + 2] - x[3 * c[1] + 2]); maxStretch = Math.max(maxStretch, L / rest0[k] - 1); });
  let minY = Infinity;
  for (let i = 0; i < n; i++) minY = Math.min(minY, x[3 * i + 1]);
  return { frames: out, sys: S, stats: { ms: Date.now() - t0, n, maxStretch: +maxStretch.toFixed(4), maxSpeed: +maxSpeed.toFixed(3), finite, settledFrame, minY: +minY.toFixed(4), substeps: sub } };
}

/** Grains: the pile's height and its slope angle (deg, height over base radius at the 95th percentile). */
export function pileShape(positions, centre = [0, 0]) {
  const n = positions.length / 3;
  let top = 0;
  const rs = [];
  for (let i = 0; i < n; i++) { top = Math.max(top, positions[3 * i + 1]); rs.push(Math.hypot(positions[3 * i] - centre[0], positions[3 * i + 2] - centre[1])); }
  rs.sort((a, b) => a - b);
  const r95 = rs[Math.floor(rs.length * 0.95)] || 1e-6;
  return { height: top, radius: r95, slope: Math.atan2(top, r95) * 180 / Math.PI };
}

/** A soft body's signature for the vertex-cache (spec + the collider motion it saw). */
export function softSig(spec, opts = {}) {
  let h = 2166136261;
  const mix = (v) => { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 16777619); };
  for (const [k, v] of Object.entries(spec).sort()) { if (typeof v === "number") mix(v); else if (Array.isArray(v)) v.forEach((x) => typeof x === "number" && mix(x)); else if (typeof v === "string") for (const ch of v) mix(ch.charCodeAt(0)); mix(k.length); }
  mix(opts.frames || 0); mix(opts.fps || 24);
  for (const P of [opts.poses, opts.attach?.poses, ...(opts.colliders || []).map((c) => c.poses)]) {
    if (!P?.length) continue;
    for (let f = 0; f < P.length; f += 4) { mix(P[f].pos[0]); mix(P[f].pos[1]); mix(P[f].pos[2]); mix(P[f].quat[1]); }
  }
  return (h >>> 0).toString(36);
}
