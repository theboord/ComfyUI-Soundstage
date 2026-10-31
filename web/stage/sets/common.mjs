// Shared helpers for the Milestone 11 sets (underwater, fire, airplane, train): a deterministic PRNG and value noise,
// cached materials, merge-by-colour builders (few draw calls, so the stage holds 60 fps), soft particle sprites and
// the "glow" material for flames, light shafts and lit sky. No DOM: everything also builds under node --test.
import * as THREE from "../../vendor/three.module.min.mjs";
import { mergeGeometries, mergeVertices } from "../../vendor/addons/BufferGeometryUtils.mjs";

/** Tiny deterministic PRNG (same as environments.mjs): identical set dressing on every build. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [-1, 1], deterministic (hash of the lattice). */
export function noise2(x, z, seed = 1) {
  const h = (i, j) => {
    let n = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295 * 2 - 1;
  };
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Fractal value noise (octaves), roughly in [-1, 1]. */
export function fbm(x, z, seed = 1, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * noise2(x * f, z * f, seed + i * 17); f *= 2.03; amp *= 0.5; }
  return v;
}

const MATS = new Map();
/** A shared MeshStandardMaterial per look (colour + roughness + metalness + emissive). Clay overrides it. */
export function mat(color, { rough = 0.85, metal = 0, emissive = null, ei = 1, side = THREE.FrontSide, vc = false } = {}) {
  const key = [color, rough, metal, emissive, ei, side, vc].join("|");
  let m = MATS.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, metalness: metal, side, vertexColors: vc });
    if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = ei; }
    MATS.set(key, m);
  }
  return m;
}

const GLOWS = new Map();
/**
 * Self-lit, see-through glow (flames, light shafts, lit sky, cabin light strips). allowOverride = false keeps it in
 * the Clay pass too (like vehicle glass), so the layout guide shows where the light is. Meshes using it are tagged
 * userData.glass, which the stage hides in Depth and ID (they are light, not surfaces).
 */
export function glow(color, opacity = 1, { additive = true, side = THREE.DoubleSide, depthWrite = false, map = null } = {}) {
  const key = [color, opacity, additive, side, depthWrite, map?.uuid || ""].join("|");
  let m = GLOWS.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: opacity < 1 || additive, opacity, side, depthWrite,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: !additive, map });
    m.allowOverride = false;
    GLOWS.set(key, m);
  }
  return m;
}

/** Tag a mesh as light / atmosphere (no shadows; hidden in Depth and ID by the stage's glass rule). */
export function lightish(o) {
  o.userData.glass = true;
  o.castShadow = false;
  o.receiveShadow = false;
  return o;
}

/** A shadowed mesh with a cached material. */
export function solid(geom, color, opts) {
  const m = new THREE.Mesh(geom, mat(color, opts));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Collects primitives and merges them into one mesh per colour (one draw call each). add(geom, color, x, y, z, rx, ry,
 * rz, sx, sy, sz) bakes the transform into the geometry. build(group) adds the merged meshes and returns them.
 */
export class Batch {
  constructor() { this.parts = new Map(); }
  add(geom, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, opts = null) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")),
      new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(m);
    const key = JSON.stringify([color, opts || {}]);
    if (!this.parts.has(key)) this.parts.set(key, { color, opts, list: [] });
    this.parts.get(key).list.push(g);
    if (g !== geom) geom.dispose();
    return this;
  }
  /** A pre-built geometry with its own transform matrix. */
  addMatrix(geom, color, matrix, opts = null) {
    const g = geom.index ? geom.toNonIndexed() : geom.clone();
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(matrix);
    const key = JSON.stringify([color, opts || {}]);
    if (!this.parts.has(key)) this.parts.set(key, { color, opts, list: [] });
    this.parts.get(key).list.push(g);
    return this;
  }
  build(group, { shadows = true } = {}) {
    const out = [];
    for (const { color, opts, list } of this.parts.values()) {
      const merged = mergeGeometries(list.map((g) => { for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k); return g; }));
      list.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, mat(color, opts || undefined));
      m.castShadow = shadows; m.receiveShadow = true;
      group.add(m);
      out.push(m);
    }
    this.parts.clear();
    return out;
  }
}

let SPRITE = null;
/** A soft round particle sprite (radial falloff) as a DataTexture: no canvas needed. */
export function softSprite() {
  if (SPRITE) return SPRITE;
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5) / N * 2 - 1, dy = (y + 0.5) / N * 2 - 1, r = Math.min(1, Math.hypot(dx, dy));
    const a = Math.pow(1 - r, 1.8);
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(a * 255);
  }
  SPRITE = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  SPRITE.needsUpdate = true;
  SPRITE.magFilter = THREE.LinearFilter; SPRITE.minFilter = THREE.LinearFilter;
  return SPRITE;
}

/** Points with the soft sprite (embers, bubbles, marine snow, smoke). */
export function softPoints(n, color, size, { opacity = 0.9, additive = false, fog = true } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const m = new THREE.PointsMaterial({ color, size, map: softSprite(), transparent: true, opacity, depthWrite: false, fog,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true });
  m.allowOverride = false;   // Clay would draw them as black squares; they stay soft specks in every view
  const p = new THREE.Points(geo, m);
  p.frustumCulled = false;
  return p;
}

/** Deterministic flicker in roughly [-1, 1] at time t for a seed (sum of incommensurate sines). */
export function flicker(t, seed = 0) {
  return Math.sin(t * 13.1 + seed * 1.7) * 0.45 + Math.sin(t * 7.3 + seed * 3.1) * 0.35 + Math.sin(t * 23.7 + seed) * 0.2;
}

/** Wrap v into [-L/2, L/2). */
export const wrap = (v, L) => ((((v + L / 2) % L) + L) % L) - L / 2;

/** Seated / standing helpers: is this actor a person? */
export const PERSON = new Set(["man", "woman", "child"]);

/** Keyed position of an actor at a frame without the stage (first key, or linear between keys). */
export function keyedAt(a, frame) {
  const keys = (a.keys && a.keys.length ? a.keys : [{ frame: 0, position: a.position || [0, 0, 0] }]).slice().sort((p, q) => p.frame - q.frame);
  if (frame <= keys[0].frame) return keys[0].position;
  for (let i = 1; i < keys.length; i++) {
    if (frame <= keys[i].frame) {
      const k0 = keys[i - 1], k1 = keys[i], t = (frame - k0.frame) / Math.max(1, k1.frame - k0.frame);
      return k0.position.map((v, j) => v + (k1.position[j] - v) * t);
    }
  }
  return keys[keys.length - 1].position;
}

const BUILT = new Map();
/**
 * Build a set once per key and hand out cheap clones (shared geometry and materials): the stage rebuilds its set on
 * many edits, and the heavy sets take a few hundred ms to make. build() returns {group, fx}; fx animates the shared
 * geometry, so every clone moves together.
 */
export function memoSet(key, build) {
  let b = BUILT.get(key);
  if (!b) { b = build(); BUILT.set(key, b); }
  const group = b.group.clone(true);
  group.traverse((o) => { if (o.userData.sky) o.onBeforeRender = followCamera; });
  return { group, water: b.water || null, fx: b.fx || null };
}

/**
 * Library objects (web/stage/library.mjs) build with the stage's mesh(geom, color) so they take the stage's clay and
 * ID handling: merge a Batch per colour and hand each merged geometry to mesh(). Returns the meshes.
 */
export function batchToMeshes(B, mesh, group) {
  const out = [];
  for (const { color, list } of B.parts.values()) {
    const merged = mergeGeometries(list.map((g) => { for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k); return g; }));
    list.forEach((g) => g.dispose());
    if (!merged) continue;
    merged.computeBoundingSphere();
    const m = mesh(merged, color);
    group.add(m);
    out.push(m);
  }
  B.parts.clear();
  return out;
}

/** Sky domes ride with the camera (centred on it every render), so they never meet the 200 m far plane. */
function followCamera(renderer, scene, camera) {
  this.position.copy(camera.position);
  if (this.parent) this.position.sub(this.parent.getWorldPosition(_v)).applyQuaternion(_q.copy(this.parent.getWorldQuaternion(_q2)).invert());
  this.updateMatrixWorld(true);
}
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/** A vertical-gradient sky dome (self-lit, kept in Clay, hidden in Depth / ID): zenith, horizon, below-horizon colours. */
export function skyDome(radius, top, horizon, bottom = horizon) {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const p = geo.attributes.position, col = new Float32Array(p.count * 3);
  const ct = new THREE.Color(top), ch = new THREE.Color(horizon), cb = new THREE.Color(bottom), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i) / radius;
    if (v >= 0) c.copy(ch).lerp(ct, Math.pow(v, 0.55)); else c.copy(ch).lerp(cb, Math.min(1, -v * 3));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
  m.allowOverride = false;
  const dome = lightish(new THREE.Mesh(geo, m));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.userData.sky = true;
  dome.onBeforeRender = followCamera;
  return dome;
}

/** A soft cloud: a few merged, squashed, jittered icospheres (add to a Batch). */
export function cloudPuff(B, color, x, y, z, size, r, opts = null, detail = 1) {
  const n = 4 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const s = size * (0.45 + r() * 0.55);
    B.add(new THREE.IcosahedronGeometry(1, detail), color, x + (r() - 0.5) * size * 2.2, y + s * 0.25 + r() * size * 0.3, z + (r() - 0.5) * size * 1.4,
      0, r() * 6, 0, s * (1.1 + r() * 0.5), s * (0.55 + r() * 0.25), s * (0.9 + r() * 0.4), opts);
  }
}

/** Reverse the triangle winding of a geometry (indexed or not); normals are recomputed / negated to match. */
export function flipFaces(geo) {
  if (geo.index) {
    const a = geo.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    geo.computeVertexNormals();
    return geo;
  }
  for (const a of [geo.attributes.position, geo.attributes.normal, geo.attributes.uv].filter(Boolean)) {
    const k = a.itemSize, arr = a.array;
    for (let i = 0; i < a.count; i += 3) for (let j = 0; j < k; j++) { const t = arr[(i + 1) * k + j]; arr[(i + 1) * k + j] = arr[(i + 2) * k + j]; arr[(i + 2) * k + j] = t; }
  }
  if (geo.attributes.normal) { const n = geo.attributes.normal.array; for (let i = 0; i < n.length; i++) n[i] = -n[i]; }
  return geo;
}

const RB = new Map();
/** A box with rounded edges and corners (radius r), smooth-shaded: upholstery, bins, panels. Cached per size. */
export function roundedBox(w, h, d, r = 0.03, seg = 3) {
  const key = [w, h, d, r, seg].join(",");
  let base = RB.get(key);
  if (!base) {
    const box = new THREE.BoxGeometry(w, h, d, seg * 2, seg * 2, seg * 2);
    box.deleteAttribute("normal"); box.deleteAttribute("uv");
    base = mergeVertices(box);
    box.dispose();
    const p = base.attributes.position, hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r, v = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
      v.sub(c);
      if (v.lengthSq() > 1e-12) v.setLength(r);
      p.setXYZ(i, c.x + v.x, c.y + v.y, c.z + v.z);
    }
    base.computeVertexNormals();
    RB.set(key, base);
  }
  return base.clone();
}

/**
 * Sweep a 2D cross-section (points [x, y], in order) along z0..z1 as a ribbon whose faces look toward `inside`
 * ([x, y], e.g. the cabin's centre line): a continuous shell with no gaps. Shared vertices per profile corner only
 * where `smooth` (curved ceilings); hard corners otherwise.
 */
export function sweepProfile(points, z0, z1, inside = [0, 1.2], { smooth = true } = {}) {
  const pos = [], idx = [];
  const n = points.length;
  if (smooth) {
    for (const [x, y] of points) pos.push(x, y, z0, x, y, z1);
    for (let i = 0; i < n - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  } else {
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = points[i], [x1, y1] = points[i + 1], o = pos.length / 3;
      pos.push(x0, y0, z0, x0, y0, z1, x1, y1, z0, x1, y1, z1);
      idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // face the inside: test the first quad's normal against the direction to `inside`
  const p = geo.attributes.position, nn = geo.attributes.normal;
  const mx = (p.getX(0) + p.getX(2)) / 2, my = (p.getY(0) + p.getY(2)) / 2;
  if (nn.getX(0) * (inside[0] - mx) + nn.getY(0) * (inside[1] - my) < 0) flipFaces(geo);
  return geo;
}

/** Drop the built-set cache (tests: build twice from scratch and compare). */
export function clearSetCache() { BUILT.clear(); }

/**
 * Scrolling scenery (clouds past the cabin, countryside past the carriage): two copies of a tile tagged
 * userData.scroll = {speed, tile, k: 0 | 1}, moved along -Z (the vehicle runs +Z). The stage shows a clone of the set
 * (memoSet), so this walks the group actually on stage, not the one the set was built as.
 */
export function scrollTiles(root, t) {
  for (const o of root?.children || []) {
    const sc = o.userData.scroll;
    if (!sc) continue;
    const z = wrap(-t * sc.speed, sc.tile);
    o.position.z = sc.k === 0 ? z : z + (z < 0 ? sc.tile : -sc.tile);
  }
}
