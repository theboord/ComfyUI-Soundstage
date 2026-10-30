// True-scale interiors from a plan spec (rooms as metre rectangles, doors/windows on walls), the way
// Higgsfield 3D Jutsu builds an apartment from a floor plan. Plan coordinates: +x right, +z down the page.
// The stage turns the plan 180° so the top of the page is north (+Z, the Top view's "N ↑", where the sun's
// azimuth is measured from) and the drawing reads the same way up in the Top view. A rotation, never a mirror.
// Interiors saved before that carry no north_up flag and keep the old mapping, so they reload unchanged.
// The spec comes from /soundstage/plan (image or text) or the scene agent; see docs/interior.md.
import * as THREE from "../vendor/three.module.min.mjs";

export const DEFAULT_SPEC = { units: "m", ceiling_m: 2.4, wall_thickness_m: 0.12, rooms: [], openings: [], fixtures: [] };

const EPS = 1e-3;
const key = (v) => Math.round(v * 1000) / 1000;

/** Merge [a,b] intervals. */
function union(intervals) {
  const s = intervals.filter(([a, b]) => b - a > EPS).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Subtract openings [a,b] from a wall run [lo,hi]; returns solid pieces. */
function subtract([lo, hi], holes) {
  let pieces = [[lo, hi]];
  for (const [a, b] of holes) {
    pieces = pieces.flatMap(([p, q]) => (b <= p || a >= q) ? [[p, q]] : [[p, Math.max(p, a)], [Math.min(q, b), q]].filter(([x, y]) => y - x > EPS));
  }
  return pieces;
}

/** Normalise a spec: numbers, defaults, plan bounds and the centre the stage builds around. */
export function normalizeSpec(spec) {
  const s = { ...DEFAULT_SPEC, ...(spec || {}) };
  s.ceiling_m = Math.max(2, Math.min(8, +s.ceiling_m || 2.4));
  s.wall_thickness_m = Math.max(0.05, Math.min(0.5, +s.wall_thickness_m || 0.12));
  s.rooms = (s.rooms || []).map((r, i) => ({ name: r.name || `Room ${i + 1}`, x: +r.x || 0, z: +r.z || 0,
    w: Math.max(0.6, +r.w || 3), d: Math.max(0.6, +r.d || 3) }));
  s.openings = (s.openings || []).filter((o) => s.rooms.some((r) => r.name === o.room));
  s.fixtures = s.fixtures || [];
  const xs = s.rooms.flatMap((r) => [r.x, r.x + r.w]), zs = s.rooms.flatMap((r) => [r.z, r.z + r.d]);
  s.bounds = s.rooms.length ? { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) } : { x0: 0, x1: 0, z0: 0, z1: 0 };
  s.center = [(s.bounds.x0 + s.bounds.x1) / 2, (s.bounds.z0 + s.bounds.z1) / 2];
  s.north_up = !!s.north_up;
  return s;
}

/** Plan point (metres) → stage point: centred on the plan, page-top to +Z (north) for north_up specs. */
export const toStage = (s, x, z) => (s.north_up ? [s.center[0] - x, s.center[1] - z] : [x - s.center[0], z - s.center[1]]);

/**
 * Build the interior. mk(geometry, colourHex) returns a mesh in the stage's material system.
 * Walls are tagged userData.wall = {axis:"x"|"z", at, side} so the stage can cut away the near ones;
 * ceilings are tagged userData.ceiling = true.
 */
export function buildInterior(spec, mk) {
  const s = normalizeSpec(spec);
  const g = new THREE.Group();
  g.name = "interior";
  const H = s.ceiling_m, T = s.wall_thickness_m;

  // Wall lines: every room edge, merged along shared lines so neighbouring rooms share one wall.
  const lines = new Map(); // "z|3.2" -> {axis:"z", at, runs:[], holes:[], sides:Set}
  const addRun = (axis, at, a, b, side) => {
    const k = `${axis}|${key(at)}`;
    if (!lines.has(k)) lines.set(k, { axis, at, runs: [], holes: [], sides: new Set() });
    const L = lines.get(k);
    L.runs.push([a, b]);
    L.sides.add(side);
  };
  for (const r of s.rooms) {
    addRun("z", r.z, r.x, r.x + r.w, "N"); // a wall along x at constant z
    addRun("z", r.z + r.d, r.x, r.x + r.w, "S");
    addRun("x", r.x, r.z, r.z + r.d, "W"); // a wall along z at constant x
    addRun("x", r.x + r.w, r.z, r.z + r.d, "E");
  }
  // Openings cut holes in the wall line they sit on (offset measured from the wall's west/north end).
  for (const o of s.openings) {
    const r = s.rooms.find((q) => q.name === o.room);
    const wall = (o.wall || "S").toUpperCase();
    const width = Math.max(0.3, +o.width_m || (o.type === "window" ? 1.2 : 0.9));
    const off = Math.max(0, +o.offset_m || 0);
    const axis = wall === "N" || wall === "S" ? "z" : "x";
    const at = wall === "N" ? r.z : wall === "S" ? r.z + r.d : wall === "W" ? r.x : r.x + r.w;
    const start = (axis === "z" ? r.x : r.z) + off;
    const L = lines.get(`${axis}|${key(at)}`);
    if (!L) continue;
    const type = o.type || "door";
    const h = Math.min(H - 0.05, +o.height_m || (type === "window" ? 1.2 : 2.05));
    const sill = type === "window" ? Math.max(0, +o.sill_m || 0.9) : 0;
    L.holes.push({ a: start, b: start + width, type, h, sill });
  }

  const wallCol = 0xd9d4cb, floorCols = [0xb9a993, 0xa89a86, 0xc2b6a2, 0xb0a48f];
  const segment = (L, a, b, y0, y1) => {
    if (b - a < EPS || y1 - y0 < EPS) return;
    const len = b - a, mid = (a + b) / 2;
    const geom = L.axis === "z" ? new THREE.BoxGeometry(len + T, y1 - y0, T) : new THREE.BoxGeometry(T, y1 - y0, len + T);
    const m = mk(geom, wallCol);
    const [sx, sz] = L.axis === "z" ? toStage(s, mid, L.at) : toStage(s, L.at, mid);
    m.position.set(sx, (y0 + y1) / 2, sz);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.wall = { axis: L.axis, at: L.axis === "z" ? sz : sx, sides: [...L.sides] };
    g.add(m);
  };
  for (const L of lines.values()) {
    const runs = union(L.runs);
    const holes = L.holes.map((h) => [h.a, h.b]);
    for (const run of runs) {
      for (const [a, b] of subtract(run, holes)) segment(L, a, b, 0, H);
      // Lintels above doors and windows, sills below windows.
      for (const h of L.holes) {
        const a = Math.max(run[0], h.a), b = Math.min(run[1], h.b);
        if (b - a < EPS) continue;
        segment(L, a, b, h.sill + h.h, H);
        if (h.sill > 0) segment(L, a, b, 0, h.sill);
      }
    }
  }
  // Floors (slightly above the stage ground) and removable ceilings, one per room.
  s.rooms.forEach((r, i) => {
    const [cx, cz] = toStage(s, r.x + r.w / 2, r.z + r.d / 2);
    const f = mk(new THREE.BoxGeometry(r.w, 0.02, r.d), floorCols[i % floorCols.length]);
    f.position.set(cx, 0.01, cz);
    f.receiveShadow = true;
    f.userData.floor = r.name;
    g.add(f);
    const c = mk(new THREE.BoxGeometry(r.w + T, 0.06, r.d + T), 0xeeeeea);
    c.position.set(cx, H + 0.03, cz);
    c.userData.ceiling = true;
    c.name = `NV_${r.name.replace(/\W+/g, "_")}_ceiling_removable`;
    g.add(c);
  });
  g.userData.spec = s;
  return g;
}

/** Fixtures → stage actors. Fixture x/z are absolute plan coordinates; without them, the room's centre. */
export function fixtureActors(spec) {
  const s = normalizeSpec(spec);
  return (s.fixtures || []).map((f) => {
    const r = s.rooms.find((q) => q.name === f.room);
    const x = f.x != null ? +f.x : r ? r.x + r.w / 2 : 0;
    const z = f.z != null ? +f.z : r ? r.z + r.d / 2 : 0;
    const [sx, sz] = toStage(s, x, z);
    // Plan rotation 0 = back to the north wall, facing down the page; the 180° turn above flips that facing.
    const rot = ((((+f.rotation_deg || 0) + (s.north_up ? 180 : 0)) % 360) + 360) % 360;
    return { kind: f.kind, name: f.name, position: [+sx.toFixed(2), 0, +sz.toFixed(2)], rotation_deg: rot > 180 ? rot - 360 : rot };
  });
}

/** A good first camera: eye height 1.5 m in the largest room, looking down its long axis. */
export function interiorCamera(spec, focal_mm = 24) {
  const s = normalizeSpec(spec);
  const r = [...s.rooms].sort((a, b) => b.w * b.d - a.w * a.d)[0];
  if (!r) return null;
  const long = r.d >= r.w;
  const [ax, az] = toStage(s, long ? r.x + r.w / 2 : r.x + 0.4, long ? r.z + 0.4 : r.z + r.d / 2);
  const [bx, bz] = toStage(s, long ? r.x + r.w / 2 : r.x + r.w, long ? r.z + r.d : r.z + r.d / 2);
  return { position: [ax, 1.5, az], target: [bx, 1.3, bz], focal_mm };
}

/** Parse quick text specs without an LLM: "studio 6x4 m, ceiling 2.7" -> one room. */
export function quickSpec(text) {
  const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*m?/i.exec(text || "");
  if (!m) return null;
  const c = /ceiling\s*(\d+(?:\.\d+)?)/i.exec(text || "");
  return { ...DEFAULT_SPEC, ceiling_m: c ? +c[1] : 2.4, rooms: [{ name: "Room", x: 0, z: 0, w: +m[1], d: +m[2] }],
    openings: [{ type: "door", room: "Room", wall: "S", offset_m: 0.4, width_m: 0.9 }, { type: "window", room: "Room", wall: "N", offset_m: Math.max(0.3, +m[1] / 2 - 0.6), width_m: 1.2 }] };
}
