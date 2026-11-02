// Underwater set: a reef channel 10 m down. Sandy seabed with rock outcrops, coral (branching, brain, fan, table,
// tube sponges), swaying kelp, the rippling surface seen from below, slanting light shafts, marine snow and bubbles,
// blue-green depth fog. People off the seabed swim (web/stage/swim.mjs: flutter or frog kick, trim, buoyancy, the
// regulator's exhaled bubbles) instead of walking.
// The water (web/stage/water.mjs): one wave field moves the surface (displaced, with Snell's window seen from below),
// focuses the caustics on the seabed, coral and divers (Color guide), and flickers the light shafts, which fall along
// the refracted sun. A current (mean drift + the swell's orbital surge) sways the kelp, sea fans and sea grass, and
// carries the marine snow, bubbles and stirred sand.
// Deterministic: every moving part is a pure function of the frame (and the shot camera, for particles).
import * as THREE from "../../vendor/three.module.min.mjs";
import { mergeVertices } from "../../vendor/addons/BufferGeometryUtils.mjs";
import { rng, fbm, noise2, Batch, lightish, softPoints, wrap, memoSet } from "./common.mjs";
import { CAUSTIC_U, patchCaustics, underSurfaceMaterial, refractedSun, currentAt, surgeAt, causticAt } from "../water.mjs";
import { exhaleBubbles, bodyAt, poseAt } from "../swim.mjs";

export const SURFACE = 10;          // the water surface, metres above the seabed datum
const WATER_CLAY = 0x34585f;        // depth fog in Clay: the layout guide fades to water, not to a grey void
const WATER_COLOR = 0x1a5a66;       // blue-green falloff in Color
const DEEP_COLOR = 0x0f3d4c;
const DEPTH_FAR = 22;               // Depth pass: far = 22 m (water swallows distance), vs 40 m on dry sets

/** Seabed height at (x, z): a channel between two reef walls, dropping off into blue far ahead. Never below 0.06. */
export function seabedHeight(x, z) {
  const ax = Math.abs(x);
  const wall = 2.6 * smooth(5.5, 15, ax) + 1.2 * smooth(16, 30, ax);
  const drop = -1.2 * smooth(28, 55, z);
  const n = 0.32 * fbm(x * 0.09 + 3.1, z * 0.09 - 1.7, 11) + 0.12 * fbm(x * 0.4, z * 0.4, 5, 2);
  return Math.max(0.06, 0.28 + wall + drop + n + (ax > 5 ? 0.6 * fbm(x * 0.2, z * 0.2, 23, 3) : 0));
}
function smooth(a, b, v) { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); }

let depthMat = null;
function underwaterDepth() {
  if (!depthMat) depthMat = new THREE.ShaderMaterial({
    uniforms: { uNear: { value: 1.0 }, uFar: { value: DEPTH_FAR } },
    vertexShader: "varying float vViewZ; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }",
    fragmentShader: "uniform float uNear; uniform float uFar; varying float vViewZ; void main(){ float d = clamp((vViewZ - uNear)/(uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - d), 1.0); }",
  });
  return depthMat;
}

export function buildUnderwater(opts = {}) {
  return memoSet(`underwater:${opts.seed || 11}`, () => makeUnderwater(opts));
}

function makeUnderwater(opts) {
  const g = new THREE.Group();
  g.userData.set = "underwater";
  const rand = rng(opts.seed || 11);

  // ---- seabed: a displaced grid with sand colour variation (one mesh)
  const SB = 170, SEG = 110;
  const bed = new THREE.PlaneGeometry(SB, SB, SEG, SEG);
  bed.rotateX(-Math.PI / 2);
  const p = bed.attributes.position, col = new Float32Array(p.count * 3);
  const sand = new THREE.Color("#c8b994"), dark = new THREE.Color("#8d8a72"), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i) + 20;
    const y = seabedHeight(x, z);
    p.setY(i, y); p.setZ(i, z);
    const k = Math.max(0, Math.min(1, 0.5 + 0.9 * fbm(x * 0.15, z * 0.15, 41, 3) + (y > 1.2 ? 0.35 : 0)));
    c.copy(sand).lerp(dark, k);
    col.set([c.r, c.g, c.b], i * 3);
  }
  bed.setAttribute("color", new THREE.BufferAttribute(col, 3));
  bed.computeVertexNormals();
  const bedMesh = new THREE.Mesh(bed, patchCaustics(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95 })));
  bedMesh.receiveShadow = true;
  bedMesh.userData.seabed = true;
  g.add(bedMesh);

  // ---- rocks, coral and sponges, merged by colour
  const B = new Batch();
  const clear = (x, z) => Math.abs(x) < 3.2 && z > -9 && z < 14;    // the swim lane stays open
  const place = (n, fn, { minAx = 0, maxAx = 40, z0 = -30, z1 = 60, lane = true } = {}) => {
    for (let i = 0, tries = 0; i < n && tries < n * 8; tries++) {
      const side = rand() < 0.5 ? -1 : 1, x = side * (minAx + rand() * (maxAx - minAx)), z = z0 + rand() * (z1 - z0);
      if (lane && clear(x, z)) continue;
      fn(x, seabedHeight(x, z), z, rand);
      i++;
    }
  };
  // rocks: a welded icosphere pushed out by noise, smooth-shaded (weathered, not faceted), flattened underneath
  const rockGeo = (r, seed, rough = 1) => {
    const ico = new THREE.IcosahedronGeometry(1, r > 1.1 ? 3 : 2);
    ico.deleteAttribute("normal"); ico.deleteAttribute("uv");
    const geo = mergeVertices(ico), q = geo.attributes.position;
    ico.dispose();
    const o = (seed % 997) * 0.37;
    for (let i = 0; i < q.count; i++) {
      const x = q.getX(i), y = q.getY(i), z = q.getZ(i);
      const n = 0.78 + 0.32 * rough * fbm(x * 1.3 + o, z * 1.3 + y * 0.9 - o, seed % 89 + 1, 3) + 0.06 * rough * noise2(x * 5 + o, y * 5 + z * 3, seed % 53 + 2);
      q.setXYZ(i, x * r * n, Math.max(-0.25, y) * r * n * 0.72, z * r * n);
    }
    geo.computeVertexNormals();
    return geo;
  };
  place(46, (x, y, z, r) => { const s = 0.5 + r() * 1.9; B.add(rockGeo(s, Math.floor(r() * 1e6)), r() < 0.5 ? "#6f6a5e" : "#5d5a52", x, y + s * 0.15, z, 0, r() * 6, 0); }, { minAx: 3.5 });
  // branching (staghorn) coral: a colony of tapered, slightly curving branches that grow up toward the light and
  // fork irregularly (some branches stop short, some fork three ways), knobbed with corallites, the growing tips pale
  const branchy = (x, y, z, r, color) => {
    const tipCol = "#" + new THREE.Color(color).lerp(new THREE.Color("#f2e6cf"), 0.45).getHexString();
    const twig = (bx, by, bz, len, rad, yaw, pitch, depth) => {
      const dir = new THREE.Vector3(Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), Math.sin(pitch) * Math.cos(yaw));
      const mid = new THREE.Vector3(bx, by, bz).addScaledVector(dir, len / 2);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      B.addMatrix(new THREE.CylinderGeometry(rad * 0.72, rad, len, 7, 1, true), depth > 0 ? color : tipCol, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
      // corallites: a few knobs along the branch
      for (let c = 0; c < (depth > 0 ? 2 : 1); c++) {
        const u = 0.25 + r() * 0.6, side = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).cross(dir).normalize().multiplyScalar(rad * 0.85);
        const kp = new THREE.Vector3(bx, by, bz).addScaledVector(dir, len * u).add(side);
        B.add(new THREE.SphereGeometry(rad * 0.38, 4, 3), color, kp.x, kp.y, kp.z);
      }
      const tip = new THREE.Vector3(bx, by, bz).addScaledVector(dir, len);
      if (depth <= 0 || r() < 0.12) { B.add(new THREE.SphereGeometry(rad * 0.8, 6, 4), tipCol, tip.x, tip.y, tip.z); return; }
      const k = r() < 0.25 ? 1 : r() < 0.8 ? 2 : 3;
      for (let i = 0; i < k; i++) {
        const turn = yaw + (k === 1 ? (r() - 0.5) * 0.8 : (i - (k - 1) / 2) * (0.9 + r() * 0.9) + (r() - 0.5) * 0.7);
        twig(tip.x, tip.y, tip.z, len * (0.5 + r() * 0.45), rad * (0.66 + r() * 0.12), turn, Math.max(0.08, pitch * (0.55 + r() * 0.5) + (r() - 0.5) * 0.3), depth - 1);
      }
    };
    const n = 3 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) twig(x + (r() - 0.5) * 0.5, y, z + (r() - 0.5) * 0.5, 0.25 + r() * 0.4, 0.045 + r() * 0.035, r() * 6.3, 0.2 + r() * 0.75, 2 + (r() < 0.4 ? 1 : 0));
  };
  const corals = ["#d07a4f", "#b3618f", "#d9b36c", "#c9504c", "#e0a14e"];
  place(34, (x, y, z, r) => branchy(x, y, z, r, corals[Math.floor(r() * corals.length)]), { minAx: 2.8, maxAx: 18, z0: -18, z1: 40 });
  // brain coral: squashed lumpy spheres
  place(30, (x, y, z, r) => { const s = 0.35 + r() * 0.7; B.add(rockGeo(s, Math.floor(r() * 1e6)), r() < 0.5 ? "#b9a36a" : "#9aa060", x, y + s * 0.2, z, 0, r() * 6, 0, 1, 0.75, 1); },
    { minAx: 2.6, maxAx: 20, z0: -18, z1: 40 });
  // sea fans, sea grass and anemone tufts sway with the surge: they go into their own mesh, moved on the CPU (so the
  // motion is in Clay and Depth too), each vertex by its height above its holdfast
  const SW = { geos: [], meta: [] };
  const swayAdd = (geo, color, matrix, base, height, stiff) => {
    const gg = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
    geo.dispose();
    for (const k of Object.keys(gg.attributes)) if (k !== "position") gg.deleteAttribute(k);
    const c = new THREE.Color(color), pa = gg.attributes.position, col = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) col.set([c.r, c.g, c.b], i * 3);
    gg.setAttribute("color", new THREE.BufferAttribute(col, 3));
    SW.geos.push(gg); SW.meta.push({ n: pa.count, base, height, stiff });
  };
  // sea fans (gorgonians): a lattice of fine branches spreading in one plane from a short trunk
  const fan = (x, y, z, r, color) => {
    const yaw = r() * Math.PI, ux = Math.cos(yaw), uz = Math.sin(yaw), size = 0.5 + r() * 0.8;
    const stick = (ax, ay, len, ang, rad, depth) => {
      const dx = Math.sin(ang), dy = Math.cos(ang);
      const mid = new THREE.Vector3(x + ux * (ax + dx * len / 2), y + ay + dy * len / 2, z + uz * (ax + dx * len / 2));
      const dir = new THREE.Vector3(ux * dx, dy, uz * dx).normalize();
      swayAdd(new THREE.CylinderGeometry(rad * 0.75, rad, len, 4, 1, true), color, new THREE.Matrix4().compose(mid,
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir), new THREE.Vector3(1, 1, 1)), [x, y, z], size, 1);
      if (depth <= 0) return;
      const tx = ax + dx * len, ty = ay + dy * len;
      for (const s of [-1, 1]) stick(tx, ty, len * (0.72 + r() * 0.15), ang + s * (0.28 + r() * 0.25), rad * 0.72, depth - 1);
    };
    stick(0, 0, size * 0.22, 0, 0.035, 0);
    for (const a of [-0.55, -0.15, 0.2, 0.6]) stick(0, size * 0.2, size * 0.3, a + (r() - 0.5) * 0.2, 0.022, 4);
  };
  place(18, (x, y, z, r) => fan(x, y, z, r, r() < 0.5 ? "#9b3b5a" : "#c25f3c"), { minAx: 4, maxAx: 18, z0: -14, z1: 40 });
  // table coral: a flat plate on a stalk
  place(12, (x, y, z, r) => { const s = 0.6 + r() * 0.9; B.add(new THREE.CylinderGeometry(0.08, 0.14, 0.45, 6), "#a88f6a", x, y + 0.22, z);
    B.add(new THREE.CylinderGeometry(s, s * 0.85, 0.08, 16), "#b59a70", x, y + 0.48, z, r() * 0.15, 0, r() * 0.15); }, { minAx: 5, maxAx: 22, z0: -10, z1: 45 });
  // tube sponges: open cylinders in clumps
  place(16, (x, y, z, r) => { const color = r() < 0.5 ? "#8a4fa0" : "#d0843a";
    for (let i = 0; i < 3 + Math.floor(r() * 3); i++) { const h = 0.4 + r() * 0.8; B.add(new THREE.CylinderGeometry(0.09, 0.07, h, 8, 1, true), color, x + (r() - 0.5) * 0.4, y + h / 2, z + (r() - 0.5) * 0.4, (r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3); } },
    { minAx: 3, maxAx: 16, z0: -12, z1: 36 });
  // little anemone tufts and sea grass on the open sand
  place(40, (x, y, z, r) => { for (let i = 0; i < 4; i++) { const h = 0.25 + r() * 0.25, bx = x + (r() - 0.5) * 0.3, bz = z + (r() - 0.5) * 0.3;
    swayAdd(new THREE.ConeGeometry(0.03, h, 4), "#7c9a52", new THREE.Matrix4().compose(new THREE.Vector3(bx, y + h / 2 - 0.02, bz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, 0, (r() - 0.5) * 0.4)), new THREE.Vector3(1, 1, 1)), [bx, y - 0.02, bz], h, 0.35); } },
    { minAx: 0, maxAx: 14, z0: -12, z1: 30, lane: false });
  // the reef proper: dense coral along both sides of the swim lane, where the camera looks (a diver swims past it)
  const reef = { minAx: 3.0, maxAx: 11, z0: -10, z1: 26 };
  place(70, (x, y, z, r) => branchy(x, y, z, r, corals[Math.floor(r() * corals.length)]), reef);
  place(55, (x, y, z, r) => { const s = 0.3 + r() * 0.6; B.add(rockGeo(s, Math.floor(r() * 1e6)), ["#b9a36a", "#9aa060", "#c48a5a", "#8f7fa8"][Math.floor(r() * 4)], x, y + s * 0.2, z, 0, r() * 6, 0, 1, 0.75, 1); }, reef);
  place(30, (x, y, z, r) => fan(x, y, z, r, ["#9b3b5a", "#c25f3c", "#b8475e"][Math.floor(r() * 3)]), { ...reef, minAx: 3.6 });
  place(26, (x, y, z, r) => { const color = ["#8a4fa0", "#d0843a", "#c9b23a"][Math.floor(r() * 3)];
    for (let i = 0; i < 3 + Math.floor(r() * 4); i++) { const h = 0.3 + r() * 0.7; B.add(new THREE.CylinderGeometry(0.08, 0.06, h, 8, 1, true), color, x + (r() - 0.5) * 0.45, y + h / 2, z + (r() - 0.5) * 0.45, (r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3); } }, reef);
  place(16, (x, y, z, r) => { const s = 0.5 + r() * 0.8; B.add(new THREE.CylinderGeometry(0.07, 0.12, 0.4, 6), "#a88f6a", x, y + 0.2, z);
    B.add(new THREE.CylinderGeometry(s, s * 0.85, 0.07, 16), "#b59a70", x, y + 0.43, z, r() * 0.15, 0, r() * 0.15); }, { ...reef, minAx: 4 });
  const reefMeshes = B.build(g);
  for (const m of reefMeshes) patchCaustics(m.material);
  // the swaying sea fans and grass: one vertex-coloured mesh; per vertex its rest position, its height share and phase
  const swayGeo = mergeKelp(SW.geos, true);
  const swayBase = Float32Array.from(swayGeo.attributes.position.array), swayW = new Float32Array(swayBase.length / 3), swayPh = new Float32Array(swayW.length);
  {
    let o = 0;
    for (const m of SW.meta) {
      const ph = (m.base[0] * 0.37 + m.base[2] * 0.53) % 6.28;
      for (let i = 0; i < m.n; i++, o++) {
        const u = Math.max(0, Math.min(1, (swayBase[o * 3 + 1] - m.base[1]) / Math.max(0.05, m.height)));
        swayW[o] = u * u * m.height * 0.12 / m.stiff; swayPh[o] = ph;
      }
    }
  }
  const sway = new THREE.Mesh(swayGeo, patchCaustics(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85 })));
  sway.castShadow = true; sway.receiveShadow = true; sway.frustumCulled = false;
  g.add(sway);

  // ---- kelp: tall ribbons in stands on the reef walls; one mesh, swayed on the CPU each frame
  const kelpParts = [], kelpBase = [];
  const kr = rng(77);
  for (let s = 0; s < 9; s++) {
    const side = s % 2 ? 1 : -1, cx = side * (9 + kr() * 10), cz = -8 + s * 6 + kr() * 4;
    for (let i = 0; i < 6; i++) {
      const x = cx + (kr() - 0.5) * 3, z = cz + (kr() - 0.5) * 3, y = seabedHeight(x, z), h = 4 + kr() * 4.5;
      const blade = new THREE.PlaneGeometry(0.22 + kr() * 0.12, h, 1, 10);
      blade.translate(0, h / 2, 0);
      blade.rotateY(kr() * Math.PI);
      blade.translate(x, y, z);
      const ph = kr() * 6.28;
      const flat = blade.toNonIndexed();
      blade.dispose();
      const q = flat.attributes.position;
      for (let v = 0; v < q.count; v++) kelpBase.push(q.getX(v), q.getY(v), q.getZ(v), (q.getY(v) - y) / h, ph, h);
      kelpParts.push(flat);
    }
  }
  const kelpGeo = mergeKelp(kelpParts);
  const kelp = new THREE.Mesh(kelpGeo, patchCaustics(new THREE.MeshStandardMaterial({ color: 0x6b7a33, roughness: 0.8, side: THREE.DoubleSide })));
  kelp.castShadow = true; kelp.receiveShadow = true;
  g.add(kelp);

  // ---- the surface from below: displaced by the wave field, bright inside Snell's window, a dim mirror outside it
  const surf = new THREE.PlaneGeometry(240, 240, 120, 120);
  surf.rotateX(Math.PI / 2);              // facing down
  surf.translate(0, SURFACE, 20);
  const surfMat = underSurfaceMaterial({ water: new THREE.Color(WATER_COLOR), deep: new THREE.Color(DEEP_COLOR) });
  const surface = lightish(new THREE.Mesh(surf, surfMat));
  surface.userData.water = true;            // ID pass hides water
  surface.frustumCulled = false;
  g.add(surface);

  // ---- light shafts: cones hanging from the surface along the refracted sun, bright at the top and fading down, each
  // flickering with the focus of the waves above it (additive, one mesh, aimed every frame from the sun)
  const rays = [], rayBase = [], rayRoots = [];
  const rr = rng(5);
  for (let i = 0; i < 18; i++) {
    const L = SURFACE + 2, w = 0.35 + rr() * 1.3;
    const cone = new THREE.CylinderGeometry(w * 0.7, w * 1.35, L, 10, 6, true);
    cone.translate(0, -L / 2, 0);
    const x = -18 + rr() * 34, z = -8 + rr() * 38;
    cone.translate(x, 0.5, z);
    const gc = cone.toNonIndexed(), qp = gc.attributes.position, cc = new Float32Array(qp.count * 3);
    const I = 0.06 + rr() * 0.1;
    for (let v = 0; v < qp.count; v++) {
      const k = Math.max(0, Math.min(1, (qp.getY(v) + SURFACE) / (SURFACE + 0.5)));   // 1 at the surface, 0 at the bottom
      const a = I * Math.pow(k, 1.6);
      cc.set([a * 0.75, a * 0.95, a], v * 3);
      rayBase.push(a, i);
    }
    gc.setAttribute("color", new THREE.BufferAttribute(cc, 3));
    rays.push(gc); rayRoots.push([x, z]);
  }
  const rayGeo = mergeKelp(rays, true, true);
  // soft-edged shafts: brightest where the cone faces the camera, fading to nothing at its silhouette (no hard edges)
  const rayMat = new THREE.ShaderMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    vertexColors: true,
    vertexShader: "varying vec3 vC; varying float vF; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); vec3 n = normalize(normalMatrix * normal); vF = pow(abs(dot(n, normalize(-mv.xyz))), 2.2); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "varying vec3 vC; varying float vF; void main(){ gl_FragColor = vec4(vC * vF, 1.0); }" });
  rayMat.allowOverride = false;
  const rayMesh = lightish(new THREE.Mesh(rayGeo, rayMat));
  rayMesh.frustumCulled = false;
  rayMesh.position.y = SURFACE;
  g.add(rayMesh);

  // ---- marine snow (drifting specks) and bubbles
  const SNOW = 900, snow = lightish(softPoints(SNOW, 0xdfeff0, 0.05, { opacity: 0.7 }));
  const BUB = 1400, bubbles = lightish(bubblePoints(BUB));
  snow.userData.weather = "marine_snow"; bubbles.userData.weather = "bubbles";
  g.add(snow, bubbles);
  const sr = rng(91), snowSeed = Float32Array.from({ length: SNOW * 3 }, () => sr());
  const vents = [[-4.5, 6], [5.2, 14], [-6, 22]].map(([x, z]) => [x, seabedHeight(x, z), z]);

  const _fog = { clay: new THREE.FogExp2(WATER_CLAY, 0.038), color: new THREE.FogExp2(WATER_COLOR, 0.05) };
  const DRIFT = [0.05, 0.02];
  const currentAtFn = (x, y, z, t) => currentAt(x, y, z, t, { surface: SURFACE, drift: DRIFT });
  const _bg = { clay: new THREE.Color(WATER_CLAY), color: new THREE.Color(DEEP_COLOR) };
  const fps = () => 24;

  const fx = {
    id: "underwater",
    underwater: true,
    floorAt: seabedHeight,
    surface: SURFACE,
    drift: DRIFT,
    /** Water velocity (m/s) at a point and time: the mean drift plus the swell's surge (water.mjs). */
    currentAt: currentAtFn,
    /** Animate everything for frame f (the stage calls this from setFrame). */
    update(f, stage) {
      const t = f / (stage?.state?.shot?.fps || fps());
      const sunDir = refractedSun(stage?.state?.sun);
      CAUSTIC_U.uCauT.value = t; CAUSTIC_U.uCauSurf.value = SURFACE; CAUSTIC_U.uCauDir.value.set(...sunDir);
      const sa = stage?.state?.sun || { azimuth_deg: 190, elevation_deg: 42 }, el = Math.max(2, sa.elevation_deg) * Math.PI / 180, az = sa.azimuth_deg * Math.PI / 180;
      CAUSTIC_U.uSunAir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      // kelp: the stipe leans with the current and is carried to and fro by the surge, the motion travelling up the
      // blade (the tip lags the root), plus a fast flutter of the ribbon edges
      const kp = kelpGeo.attributes.position;
      for (let v = 0; v < kp.count; v++) {
        const o = v * 6, h = kelpBase[o + 3], ph = kelpBase[o + 4], H = kelpBase[o + 5];
        const x0 = kelpBase[o], z0 = kelpBase[o + 2];
        const lag = h * 0.9;                                          // seconds: the wave climbs the blade
        const sg = surgeAt(x0, kelpBase[o + 1], z0, t - lag, { surface: SURFACE });
        const k = h * h * (H / 6);
        const flutter = 0.05 * h * Math.sin(t * 2.3 + ph * 3 + h * 7);
        kp.setXYZ(v, x0 + (sg[0] * 1.1 + DRIFT[0] * 9) * k + 0.18 * Math.sin(t * 0.21 + ph) * k + flutter,
          kelpBase[o + 1] - 0.08 * k * k, z0 + (sg[1] * 1.1 + DRIFT[1] * 9) * k + 0.12 * Math.sin(t * 0.17 + ph * 1.3) * k);
      }
      kp.needsUpdate = true;
      kelpGeo.computeVertexNormals();
      // sea fans and grass: bend with the surge about their holdfasts (soft, flexible: the top moves most)
      const sp = swayGeo.attributes.position;
      for (let i = 0; i < swayW.length; i++) {
        const w = swayW[i];
        if (w <= 0) continue;
        const bx = swayBase[i * 3], bz = swayBase[i * 3 + 2];
        const sg = surgeAt(bx, swayBase[i * 3 + 1], bz, t - 0.25, { surface: SURFACE });
        const jit = 0.25 * Math.sin(t * 0.9 + swayPh[i]);
        sp.setXYZ(i, bx + (sg[0] * 3 + DRIFT[0] * 2 + jit * 0.12) * w, swayBase[i * 3 + 1] - 0.15 * w * w, bz + (sg[1] * 3 + DRIFT[1] * 2 + jit * 0.09) * w);
      }
      sp.needsUpdate = true;
      // light shafts: aimed down the refracted sun; each breathes with the wave focus over its root
      const dirV = new THREE.Vector3(...sunDir);
      rayMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirV);
      const rc = rayGeo.attributes.color, foc = rayRoots.map(([x, z]) => causticAt(x, z, 1.5, t, sunDir));
      for (let v = 0; v < rc.count; v++) {
        const a = rayBase[v * 2], id = rayBase[v * 2 + 1];
        const k = a * Math.min(1.6, 0.55 + 0.45 * foc[id]) * (0.85 + 0.15 * Math.sin(t * 0.5 + id * 1.9));
        rc.setXYZ(v, k * 0.75, k * 0.95, k);
      }
      rc.needsUpdate = true;
      // marine snow drifts with the current (and the surge) in a box in front of the shot camera, sinking very slowly
      const cam = stage?._cameraAt ? stage._cameraAt(f) : { position: [0, 2, -10], target: [0, 2, 0] };
      const cp = cam.position, ct = cam.target;
      const dx = ct[0] - cp[0], dz = ct[2] - cp[2], dl = Math.hypot(dx, dz) || 1;
      const cx = cp[0] + dx / dl * 7, cz = cp[2] + dz / dl * 7;
      const pp = snow.geometry.attributes.position;
      const sg0 = surgeAt(cx, 2, cz, t, { surface: SURFACE });
      for (let i = 0; i < SNOW; i++) {
        const a = snowSeed[i * 3], b = snowSeed[i * 3 + 1], d = snowSeed[i * 3 + 2];
        const x = cx + wrap((a - 0.5) * 22 + DRIFT[0] * t + sg0[0] + Math.sin(t * 0.3 + b * 30) * 0.12, 22);
        const y = 0.3 + ((b * 9.5 - t * 0.012 + 0.05 * Math.sin(t * 0.4 + a * 40)) % 9.5 + 9.5) % 9.5;
        const z = cz + wrap((d - 0.5) * 22 + DRIFT[1] * t + sg0[1] + Math.cos(t * 0.25 + a * 20) * 0.12, 22);
        pp.setXYZ(i, x, y, z);
      }
      pp.needsUpdate = true;
      // bubbles: each diver's exhaled bursts (swim.mjs) and a few seeps from the reef, rising, growing and drifting
      const bp = bubbles.geometry.attributes.position, bs = bubbles.geometry.attributes.size;
      let n = 0;
      const push = (x, y, z, d) => { if (n < BUB) { bp.setXYZ(n, x, y, z); bs.setX(n, d); n++; } };
      for (const s of stage?._swimNow || []) {
        if (s.plan.gear !== "scuba" || !s.g.userData.swimKit?.userData.exhaust) continue;
        const off = regulatorOffset(s);
        if (!off) continue;
        const fpsS = s.plan.fps;
        // before the shot the diver was already swimming: older breaths left from further back along the path
        const p0 = s.plan.pos[0], p1 = s.plan.pos[Math.min(s.plan.n - 1, 4)], back = Math.min(s.plan.n - 1, 4) / fpsS;
        const emitAt = (te) => {
          const fq = Math.max(0, te * fpsS);
          const pose = poseAt(s.plan, fq), B = bodyAt(s.plan, fq, pose, { ...s.ctx, hipY: off.hipY });
          const v = off.v.clone().applyQuaternion(B.q);
          const pre = Math.min(0, te) / back;
          return [B.hips[0] + v.x + (p1[0] - p0[0]) * pre, B.hips[1] + v.y, B.hips[2] + v.z + (p1[2] - p0[2]) * pre];
        };
        const out = exhaleBubbles(s.plan.seed, t, emitAt, { surface: SURFACE, current: currentAtFn });
        for (let i = 0; i < out.size.length; i++) push(out.pos[i * 3], out.pos[i * 3 + 1], out.pos[i * 3 + 2], out.size[i]);
      }
      for (const [vi, s] of vents.entries()) for (let i = 0; i < 24; i++) {
        const life = 26, age = ((t + i * 1.07 + vi * 3.1) % life + life) % life, d = 0.002 + 0.004 * ((i * 7) % 5) / 5;
        const y = s[1] + 0.1 + age * 0.24;
        if (y > SURFACE - 0.05) continue;
        push(s[0] + Math.sin(t * 3 + i) * 0.03 + DRIFT[0] * age, y, s[2] + Math.cos(t * 2.6 + i * 1.3) * 0.03 + DRIFT[1] * age, d);
      }
      for (let i = n; i < BUB; i++) { bp.setXYZ(i, 0, -100, 0); bs.setX(i, 0); }
      bp.needsUpdate = true; bs.needsUpdate = true;
      bubbles.geometry.setDrawRange(0, Math.max(1, n));
    },
    /** Per pass, just before the stage renders: water fog and colour in Clay and Color, shorter Depth, caustics. */
    pass(mode, { stage, cam }) {
      if (!stage?.scene || !cam || cam.position.y >= SURFACE) return;
      // bubbles are drawn at their true size: pixels per metre at 1 m for this camera and canvas
      const H = stage.renderer?.domElement?.height || 512;
      bubbles.material.uniforms.uScale.value = (H / 2) / Math.tan(((cam.fov || 40) * Math.PI / 180) / 2);
      if (mode === "clay") { stage.scene.fog = _fog.clay; stage.scene.background = _bg.clay; }
      else if (mode === "color") { stage.scene.fog = _fog.color; stage.scene.background = _bg.color; CAUSTIC_U.uCauK.value = 0.85; }
      else if (mode === "depth") stage.scene.overrideMaterial = underwaterDepth();
    },
  };
  fx.update(0, null);
  return { group: g, water: null, fx };
}

/** Merge non-indexed geometries keeping position (+ colour when asked); recomputes normals unless keepNormals. */
function mergeKelp(list, withColor = false, keepNormals = false) {
  let n = 0;
  for (const gm of list) n += gm.attributes.position.count;
  const pos = new Float32Array(n * 3), colr = withColor ? new Float32Array(n * 3) : null, nor = keepNormals ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const gm of list) {
    pos.set(gm.attributes.position.array, o * 3);
    if (colr) colr.set(gm.attributes.color.array, o * 3);
    if (nor) nor.set(gm.attributes.normal.array, o * 3);
    o += gm.attributes.position.count;
    gm.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (colr) out.setAttribute("color", new THREE.BufferAttribute(colr, 3));
  if (nor) out.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); else out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

/** Where a diver's regulator exhaust sits in their body frame (measured on the posed figure, updated each frame). */
function regulatorOffset(s) {
  const kit = s.g.userData.swimKit, J = s.g.userData.joints;
  if (!kit?.userData.exhaust || !J?.head || !s.out?.body) return null;
  s.g.updateMatrixWorld(true);
  const w = J.head.localToWorld(kit.userData.exhaust.clone());
  const B = s.out.body, v = w.sub(new THREE.Vector3(...B.hips)).applyQuaternion(B.q.clone().invert());
  return { v, hipY: (J.l_hip?.position.y || 0.9 * s.plan.height) * (s.g.scale.y || 1) };
}

/**
 * Bubbles as round, rim-lit points sized by their real diameter (a bubble under water shows as a bright silver ring:
 * total internal reflection at its edge), visible in every pass but Depth and the ID matte.
 */
function bubblePoints(n) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("size", new THREE.BufferAttribute(new Float32Array(n), 1));
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
    uniforms: { uScale: { value: 900 } },
    vertexShader: "attribute float size; uniform float uScale; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); float px = uScale * max(size, 0.0) * 2.2 / max(0.3, -mv.z); gl_PointSize = clamp(px, 1.5, 64.0); vA = clamp(px / 3.0, 0.25, 1.0) * clamp(1.0 - (-mv.z - 6.0) / 18.0, 0.0, 1.0); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "varying float vA; void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; float r = length(c); if (r > 1.0) discard; float rim = smoothstep(0.55, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r)); float body = 0.18 + 0.5 * pow(max(0.0, 1.0 - length(c - vec2(-0.35, -0.35)) * 2.2), 2.0); gl_FragColor = vec4(vec3(0.88, 0.97, 1.0), (rim * 0.95 + body * 0.6) * vA); }" });
  m.allowOverride = false;
  const p = new THREE.Points(geo, m);
  p.frustumCulled = false;
  return p;
}
