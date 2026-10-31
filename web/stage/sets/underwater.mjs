// Underwater set: a reef channel 10 m down. Sandy seabed with rock outcrops, coral (branching, brain, fan, table,
// tube sponges), swaying kelp, the rippling surface seen from below, slanting light shafts, marine snow and bubbles,
// blue-green depth fog. People off the seabed swim (body level, flutter kick) instead of walking.
// Deterministic: every moving part is a pure function of the frame (and the shot camera, for particles).
import * as THREE from "../../vendor/three.module.min.mjs";
import { mergeVertices } from "../../vendor/addons/BufferGeometryUtils.mjs";
import { rng, fbm, noise2, Batch, lightish, softPoints, wrap, memoSet, PERSON } from "./common.mjs";

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
  const bedMesh = new THREE.Mesh(bed, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95 }));
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
  // branching (staghorn) coral: tapered cylinders, two levels of branches, round tips
  const branchy = (x, y, z, r, color) => {
    const twig = (bx, by, bz, len, rad, yaw, pitch, depth) => {
      const dir = new THREE.Vector3(Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), Math.sin(pitch) * Math.cos(yaw));
      const mid = new THREE.Vector3(bx, by, bz).addScaledVector(dir, len / 2);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      B.addMatrix(new THREE.CylinderGeometry(rad * 0.7, rad, len, 6, 1, true), color, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
      const tip = new THREE.Vector3(bx, by, bz).addScaledVector(dir, len);
      if (depth <= 0) { B.add(new THREE.SphereGeometry(rad * 0.85, 5, 3), color, tip.x, tip.y, tip.z); return; }
      const k = 2 + Math.floor(r() * 2);
      for (let i = 0; i < k; i++) twig(tip.x, tip.y, tip.z, len * (0.55 + r() * 0.25), rad * 0.7, yaw + (i - (k - 1) / 2) * 1.3 + r() * 0.6, 0.35 + r() * 0.5, depth - 1);
    };
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) twig(x + (r() - 0.5) * 0.4, y, z + (r() - 0.5) * 0.4, 0.35 + r() * 0.35, 0.06 + r() * 0.03, r() * 6.3, 0.15 + r() * 0.5, 2);
  };
  const corals = ["#d07a4f", "#b3618f", "#d9b36c", "#c9504c", "#e0a14e"];
  place(34, (x, y, z, r) => branchy(x, y, z, r, corals[Math.floor(r() * corals.length)]), { minAx: 2.8, maxAx: 18, z0: -18, z1: 40 });
  // brain coral: squashed lumpy spheres
  place(30, (x, y, z, r) => { const s = 0.35 + r() * 0.7; B.add(rockGeo(s, Math.floor(r() * 1e6)), r() < 0.5 ? "#b9a36a" : "#9aa060", x, y + s * 0.2, z, 0, r() * 6, 0, 1, 0.75, 1); },
    { minAx: 2.6, maxAx: 20, z0: -18, z1: 40 });
  // sea fans (gorgonians): a lattice of fine branches spreading in one plane from a short trunk
  const fan = (x, y, z, r, color) => {
    const yaw = r() * Math.PI, ux = Math.cos(yaw), uz = Math.sin(yaw), size = 0.5 + r() * 0.8;
    const stick = (ax, ay, len, ang, rad, depth) => {
      const dx = Math.sin(ang), dy = Math.cos(ang);
      const mid = new THREE.Vector3(x + ux * (ax + dx * len / 2), y + ay + dy * len / 2, z + uz * (ax + dx * len / 2));
      const dir = new THREE.Vector3(ux * dx, dy, uz * dx).normalize();
      B.addMatrix(new THREE.CylinderGeometry(rad * 0.75, rad, len, 4, 1, true), color, new THREE.Matrix4().compose(mid,
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir), new THREE.Vector3(1, 1, 1)));
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
  place(40, (x, y, z, r) => { for (let i = 0; i < 4; i++) B.add(new THREE.ConeGeometry(0.03, 0.25 + r() * 0.25, 4), "#7c9a52", x + (r() - 0.5) * 0.3, y + 0.15, z + (r() - 0.5) * 0.3, (r() - 0.5) * 0.4, 0, (r() - 0.5) * 0.4); },
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
  B.build(g);

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
  const kelp = new THREE.Mesh(kelpGeo, new THREE.MeshStandardMaterial({ color: 0x6b7a33, roughness: 0.8, side: THREE.DoubleSide }));
  kelp.castShadow = true; kelp.receiveShadow = true;
  g.add(kelp);

  // ---- the surface from below: a rippling silver-blue sheet (vertex brightness = the ripple), seen through fog
  const surf = new THREE.PlaneGeometry(240, 240, 56, 56);
  surf.rotateX(Math.PI / 2);              // facing down
  surf.translate(0, SURFACE, 20);
  surf.setAttribute("color", new THREE.BufferAttribute(new Float32Array(surf.attributes.position.count * 3), 3));
  // the underside of the surface: bright, rippling silver right overhead, fading into the blue-green with distance
  // (its own falloff, not the scene fog, which would swallow it whole at 10 m up)
  const surfMat = new THREE.ShaderMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false, vertexColors: true,
    uniforms: { uWater: { value: new THREE.Color(WATER_COLOR) } },
    vertexShader: "varying vec3 vC; varying float vD; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); vD = length(mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "uniform vec3 uWater; varying vec3 vC; varying float vD; void main(){ float k = exp(-vD * 0.045); gl_FragColor = vec4(mix(uWater, vC * 1.15, k), 0.92); }" });
  surfMat.allowOverride = false;
  const surface = lightish(new THREE.Mesh(surf, surfMat));
  surface.userData.water = true;            // ID pass hides water
  g.add(surface);

  // ---- light shafts: slanted cones from the surface, bright at the top and fading down (additive, one mesh)
  const rays = [], rayBase = [];
  const rr = rng(5);
  const slant = new THREE.Vector3(0.28, -1, 0.12).normalize();
  for (let i = 0; i < 14; i++) {
    const L = SURFACE + 2, w = 0.5 + rr() * 1.6;
    const cone = new THREE.CylinderGeometry(w * 0.7, w * 1.4, L, 10, 6, true);
    cone.translate(0, -L / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), slant);
    cone.applyQuaternion(q);
    const x = -16 + rr() * 30, z = -6 + rr() * 34;
    cone.translate(x, SURFACE + 0.5, z);
    const gc = cone.toNonIndexed(), qp = gc.attributes.position, cc = new Float32Array(qp.count * 3);
    const I = 0.07 + rr() * 0.1;
    for (let v = 0; v < qp.count; v++) {
      const k = Math.max(0, Math.min(1, (qp.getY(v) - 0.5) / (SURFACE + 0.5)));   // 1 at the surface, 0 at the bottom
      const a = I * Math.pow(k, 1.6);
      cc.set([a * 0.75, a * 0.95, a], v * 3);
      rayBase.push(a, i);
    }
    gc.setAttribute("color", new THREE.BufferAttribute(cc, 3));
    rays.push(gc);
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
  g.add(rayMesh);

  // ---- marine snow (drifting specks) and bubbles
  const SNOW = 900, snow = lightish(softPoints(SNOW, 0xdfeff0, 0.05, { opacity: 0.7 }));
  const BUB = 260, bubbles = lightish(softPoints(BUB, 0xe8fbff, 0.07, { opacity: 0.85 }));
  snow.userData.weather = "marine_snow"; bubbles.userData.weather = "bubbles";
  g.add(snow, bubbles);
  const sr = rng(91), snowSeed = Float32Array.from({ length: SNOW * 3 }, () => sr());
  const vents = [[-4.5, 6], [5.2, 14], [-6, 22]].map(([x, z]) => [x, seabedHeight(x, z), z]);

  const _fog = { clay: new THREE.FogExp2(WATER_CLAY, 0.038), color: new THREE.FogExp2(WATER_COLOR, 0.05) };
  const _bg = { clay: new THREE.Color(WATER_CLAY), color: new THREE.Color(DEEP_COLOR) };
  const fps = () => 24;

  const fx = {
    id: "underwater",
    underwater: true,
    floorAt: seabedHeight,
    surface: SURFACE,
    /** Animate everything for frame f (the stage calls this from setFrame). */
    update(f, stage) {
      const t = f / (stage?.state?.shot?.fps || fps());
      // surface ripples: brightness from a few travelling waves
      const sp = surf.attributes.position, sc = surf.attributes.color;
      for (let i = 0; i < sp.count; i++) {
        const x = sp.getX(i), z = sp.getZ(i);
        const w = Math.sin(x * 0.55 + t * 1.3) * 0.5 + Math.sin(z * 0.43 - t * 1.1 + x * 0.2) * 0.35 + Math.sin((x + z) * 1.1 + t * 2.3) * 0.15;
        const b = 0.62 + 0.28 * w;
        sc.setXYZ(i, b * 0.78, b * 0.93, b);
      }
      sc.needsUpdate = true;
      // kelp sways from the root (the tip moves most)
      const kp = kelpGeo.attributes.position;
      for (let v = 0; v < kp.count; v++) {
        const o = v * 6, h = kelpBase[o + 3], ph = kelpBase[o + 4], H = kelpBase[o + 5];
        const sway = Math.sin(t * 0.7 + ph + h * 1.6) * 0.55 * h * h * (H / 6);
        kp.setXYZ(v, kelpBase[o] + sway, kelpBase[o + 1], kelpBase[o + 2] + 0.4 * Math.sin(t * 0.5 + ph * 1.3) * h * h);
      }
      kp.needsUpdate = true;
      kelpGeo.computeVertexNormals();
      // light shafts breathe
      const rc = rayGeo.attributes.color;
      for (let v = 0; v < rc.count; v++) {
        const a = rayBase[v * 2], id = rayBase[v * 2 + 1];
        const k = a * (0.7 + 0.3 * Math.sin(t * 0.6 + id * 1.9));
        rc.setXYZ(v, k * 0.75, k * 0.95, k);
      }
      rc.needsUpdate = true;
      // marine snow drifts in a box in front of the shot camera
      const cam = stage?._cameraAt ? stage._cameraAt(f) : { position: [0, 2, -10], target: [0, 2, 0] };
      const cp = cam.position, ct = cam.target;
      const dx = ct[0] - cp[0], dz = ct[2] - cp[2], dl = Math.hypot(dx, dz) || 1;
      const cx = cp[0] + dx / dl * 7, cz = cp[2] + dz / dl * 7;
      const pp = snow.geometry.attributes.position;
      for (let i = 0; i < SNOW; i++) {
        const a = snowSeed[i * 3], b = snowSeed[i * 3 + 1], d = snowSeed[i * 3 + 2];
        const x = cx + wrap((a - 0.5) * 22 + Math.sin(t * 0.3 + b * 30) * 0.3 + t * 0.12, 22);
        const y = 0.3 + ((b * 9.5 - t * 0.05) % 9.5 + 9.5) % 9.5;
        const z = cz + wrap((d - 0.5) * 22 + Math.cos(t * 0.25 + a * 20) * 0.3, 22);
        pp.setXYZ(i, x, y, z);
      }
      pp.needsUpdate = true;
      // bubbles: streams from seabed vents and from each swimmer's head (exhaled), rising and wobbling
      const swimmers = fx.swim(f, stage, t);
      const sources = [...vents, ...swimmers];
      const bp = bubbles.geometry.attributes.position;
      for (let i = 0; i < BUB; i++) {
        const s = sources[i % Math.max(1, sources.length)] || [0, -50, 0];
        const life = 3.2 + (i % 5) * 0.4, age = ((t + i * 0.23) % life) / life;
        const rise = age * (SURFACE - s[1]) * 0.9;
        bp.setXYZ(i, s[0] + Math.sin(t * 3 + i) * 0.06 + age * 0.3 * Math.sin(i), s[1] + rise, s[2] + Math.cos(t * 2.6 + i * 1.3) * 0.06);
      }
      bp.needsUpdate = true;
    },
    /**
     * Swimmers: people off the seabed (feet more than 0.35 m up) lie level along their heading and flutter-kick.
     * Returns head positions (bubble sources).
     */
    swim(f, stage, t) {
      const heads = [];
      if (!stage?.state?.actors || !stage.actorMeshes) return heads;
      for (const a of stage.state.actors) {
        if (!PERSON.has(a.kind) || a.mount_id || a.mocap) continue;
        const gm = stage.actorMeshes.get(a.id);
        if (!gm) continue;
        const ground = seabedHeight(gm.position.x, gm.position.z);
        if (gm.position.y - ground < 0.35) continue;
        const s = (a.height_m || 1.8) * (a.scale || 1) / 1.8;
        const moving = (gm.userData.speed || 0) > 0.15;
        const th = moving ? 1.3 : 0.55;                                 // level when swimming, upright-ish when hovering
        const yaw = gm.rotation.y;
        gm.rotation.order = "YXZ";
        gm.rotation.x = th + 0.04 * Math.sin(t * 1.7 + s);
        gm.position.y += 0.95 * s * (1 - Math.cos(th)) + 0.05 * Math.sin(t * 1.1 + gm.position.x);
        gm.position.x -= 0.95 * s * Math.sin(th) * Math.sin(yaw);
        gm.position.z -= 0.95 * s * Math.sin(th) * Math.cos(yaw);
        const kick = moving ? 2 * Math.PI * 1.1 : 2 * Math.PI * 0.5;
        const stroke = a.swim === "stroke";
        if (!a.pose_keys?.length) for (const l of gm.userData.limbs || []) {
          l.pivot.rotation.set(0, 0, 0);
          const ph = (l.side || 1) > 0 ? 0 : Math.PI;
          if (l.part === "hip") l.pivot.rotation.x = 0.32 * Math.sin(t * kick + ph) - 0.05;
          if (l.part === "knee") l.pivot.rotation.x = 0.28 + 0.22 * Math.sin(t * kick + ph + 0.9);
          if (l.part === "shoulder") {
            if (stroke) { l.pivot.rotation.x = -2.7 + 0.5 * Math.sin(t * 1.2 + ph); l.pivot.rotation.z = -(l.side || 1) * 0.25; }
            else { l.pivot.rotation.x = 0.15; l.pivot.rotation.z = -(l.side || 1) * 0.12; }
          }
          if (l.part === "elbow") l.pivot.rotation.x = stroke ? -0.15 : -0.35;
        }
        const j = gm.userData.joints || {};
        j.spine?.rotation.set(-0.12, 0, 0);
        j.neck?.rotation.set(-0.35 * th, 0, 0);
        j.head?.rotation.set(-0.45 * th, 0, 0);
        gm.updateMatrixWorld(true);
        const hp = new THREE.Vector3();
        if (j.head) j.head.getWorldPosition(hp); else hp.set(gm.position.x, gm.position.y + 1.6 * s, gm.position.z);
        heads.push([hp.x, hp.y + 0.12, hp.z]);
      }
      return heads;
    },
    /** Per pass, just before the stage renders: water fog and colour in Clay and Color, shorter Depth. */
    pass(mode, { stage, cam }) {
      if (!stage?.scene || !cam || cam.position.y >= SURFACE) return;
      if (mode === "clay") { stage.scene.fog = _fog.clay; stage.scene.background = _bg.clay; }
      else if (mode === "color") { stage.scene.fog = _fog.color; stage.scene.background = _bg.color; }
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
