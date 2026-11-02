// Soundstage water optics and currents: one wave field shared by everything that shows the surface.
//
//  - The surface is a sum of deep-water waves (dispersion w^2 = g k): short wind chop over a longer swell. The same
//    waves displace the surface mesh, shimmer Snell's window, focus the caustics on the seabed and flicker the light
//    shafts, so they all move together.
//  - Caustics (Color guide only): light refracted by a sloped surface lands shifted by D (1 - 1/n) grad h, where D is
//    the distance below the surface. The brightness at a point is 1 / |det J| of that mapping, J = I + D' Hess(h):
//    where neighbouring rays cross the light piles up into the bright, moving network. The CPU function (tests) and
//    the GLSL patch are the same math.
//  - Snell's window: looking up from below, the sky is squeezed into a cone of 48.6 degrees half-angle
//    (asin(1 / 1.333)); outside it the surface is a mirror of the deep water (total internal reflection).
//  - The current: a slow mean drift plus the to-and-fro surge of a long ocean swell's orbital motion, which at depth d
//    decays as exp(-k d). Kelp, sea fans, hair, straps, bubbles, marine snow and stirred sand all drift with it.
// Pure functions of position and time (and the sun), so every frame of a capture is repeatable.
import * as THREE from "../vendor/three.module.min.mjs";

export const N_WATER = 1.333;
export const G = 9.81;
export const SNELL_DEG = Math.asin(1 / N_WATER) * 180 / Math.PI;   // 48.6

const TAU = Math.PI * 2;
const wave = (deg, lambda, amp, phase) => {
  const k = TAU / lambda, a = deg * Math.PI / 180;
  return { dx: Math.cos(a), dz: Math.sin(a), k, amp, w: Math.sqrt(G * k), phase };
};
/**
 * The surface: three swell / wind-wave components and five short ripples (wavelengths 0.6-14 m). Heights are kept
 * small enough that the caustic focus (D' a k^2 ~ 1) falls near the 8-10 m seabed, as it does on a sunny reef.
 */
export const WAVES = Object.freeze([
  wave(18, 14, 0.12, 0.0), wave(-27, 7.5, 0.06, 1.7), wave(64, 4.1, 0.03, 4.1),
  wave(8, 1.9, 0.009, 2.2), wave(-51, 1.45, 0.007, 0.6), wave(117, 1.1, 0.005, 5.3), wave(203, 0.82, 0.0035, 3.4), wave(151, 0.63, 0.0025, 1.1),
]);

/** Surface height (m, about the mean level) and its gradient and Hessian at (x, z), time t. */
export function waveAt(x, z, t) {
  let h = 0, hx = 0, hz = 0, hxx = 0, hzz = 0, hxz = 0;
  for (const W of WAVES) {
    const th = W.k * (W.dx * x + W.dz * z) - W.w * t + W.phase;
    const s = Math.sin(th), c = Math.cos(th);
    h += W.amp * s;
    hx += W.amp * W.k * W.dx * c; hz += W.amp * W.k * W.dz * c;
    const k2 = W.amp * W.k * W.k * s;
    hxx -= k2 * W.dx * W.dx; hzz -= k2 * W.dz * W.dz; hxz -= k2 * W.dx * W.dz;
  }
  return { h, hx, hz, hxx, hzz, hxz };
}

/** The sun's light direction in the water (unit, pointing down), refracted at the flat surface (Snell). */
export function refractedSun(sun = { azimuth_deg: 190, elevation_deg: 42 }) {
  const el = Math.max(2, +sun.elevation_deg || 42) * Math.PI / 180, az = (+sun.azimuth_deg || 0) * Math.PI / 180;
  const sinW = Math.cos(el) / N_WATER, cosW = Math.sqrt(1 - sinW * sinW);
  // towards the sun is (cos el sin az, sin el, cos el cos az); light travels the other way
  return [-sinW * Math.sin(az), -cosW, -sinW * Math.cos(az)];
}

/**
 * Caustic brightness (1 = the flat-surface level) at a point `depth` metres under the surface, lit along `dir`
 * (refractedSun). Blurred and weakened with depth (the sun is half a degree wide, the water scatters).
 */
export function causticAt(x, z, depth, t, dir = [0, -1, 0]) {
  const d = Math.max(0, depth);
  // where the ray that reaches (x, z) crossed the surface
  const sx = x - dir[0] / -dir[1] * d, sz = z - dir[2] / -dir[1] * d;
  const w = waveAt(sx, sz, t), D = d * (1 - 1 / N_WATER);
  const det = (1 + D * w.hxx) * (1 + D * w.hzz) - D * D * w.hxz * w.hxz;
  const raw = 1 / Math.max(0.16, Math.abs(det));
  const k = Math.exp(-d / 16);                       // contrast fades with depth
  return 1 + (Math.min(raw, 4.5) - 1) * k;
}

/**
 * The ocean swell that drives the surge on a reef: long (110 m, ~8.4 s period) and 0.35 m high, so it hardly changes
 * the look of the surface locally but its orbital motion reaches the bottom: at depth d the water moves to and fro
 * with speed a w e^(-k d) (linear wave theory), ~0.17 m/s and ~0.2 m each way at 8 m.
 */
export const SWELL = Object.freeze((() => { const w = wave(18, 110, 0.35, 0.9); return { ...w }; })());

/**
 * Water velocity (m/s) at a point and time: a mean drift plus the swell's orbital surge, which decays with depth.
 * `surface` is the surface height (the reef: 10 m), `drift` the mean current [x, z].
 */
export function currentAt(x, y, z, t, { surface = 10, drift = [0.05, 0.02] } = {}) {
  const sw = SWELL, depth = Math.max(0, surface - y);
  const orb = sw.amp * sw.w * Math.exp(-sw.k * depth);
  const th = sw.k * (sw.dx * x + sw.dz * z) - sw.w * t + sw.phase;
  const u = orb * Math.sin(th);
  return [drift[0] + u * sw.dx, orb * Math.cos(th), drift[1] + u * sw.dz];
}
/** The orbital surge displacement (m) at a point: the integral of currentAt's oscillating part (kelp, fans). */
export function surgeAt(x, y, z, t, { surface = 10 } = {}) {
  const sw = SWELL, depth = Math.max(0, surface - y);
  const orb = sw.amp * Math.exp(-sw.k * depth);
  const th = sw.k * (sw.dx * x + sw.dz * z) - sw.w * t + sw.phase;
  const s = -orb * Math.cos(th);
  return [s * sw.dx, s * sw.dz];
}

// ---------------------------------------------------------------------------------------------------- GLSL
const GLSL_WAVES = WAVES.map((W) => `  th = ${W.k.toFixed(5)} * dot(vec2(${W.dx.toFixed(5)}, ${W.dz.toFixed(5)}), p) - ${W.w.toFixed(5)} * t + ${W.phase.toFixed(4)};
  s = sin(th); c = cos(th);
  h += ${W.amp.toFixed(5)} * s; g += ${(W.amp * W.k).toFixed(6)} * vec2(${W.dx.toFixed(5)}, ${W.dz.toFixed(5)}) * c;
  H -= ${(W.amp * W.k * W.k).toFixed(6)} * s * vec3(${(W.dx * W.dx).toFixed(5)}, ${(W.dz * W.dz).toFixed(5)}, ${(W.dx * W.dz).toFixed(5)});`).join("\n");

/** GLSL: void ssWave(vec2 p, float t, out float h, out vec2 g, out vec3 H) (H = hxx, hzz, hxz) and ssCaustic. */
export const WAVE_GLSL = `
void ssWave(vec2 p, float t, out float h, out vec2 g, out vec3 H) {
  float th, s, c; h = 0.0; g = vec2(0.0); H = vec3(0.0);
${GLSL_WAVES}
}
float ssCaustic(vec3 wp, float surf, vec3 dir, float t) {
  float d = max(0.0, surf - wp.y);
  vec2 sp = wp.xz - dir.xz / -dir.y * d;
  float h; vec2 g; vec3 H; ssWave(sp, t, h, g, H);
  float D = d * ${(1 - 1 / N_WATER).toFixed(5)};
  float det = (1.0 + D * H.x) * (1.0 + D * H.y) - D * D * H.z * H.z;
  float raw = 1.0 / max(0.16, abs(det));
  return 1.0 + (min(raw, 4.5) - 1.0) * exp(-d / 16.0);
}`;

/** Shared uniforms for every caustic-patched material. uCauK = strength (0 = off: the stage resets it every render). */
export const CAUSTIC_U = { uCauT: { value: 0 }, uCauK: { value: 0 }, uCauSurf: { value: 10 }, uCauDir: { value: new THREE.Vector3(0, -1, 0) }, uSunAir: { value: new THREE.Vector3(0, 1, 0) } };

/**
 * Add caustics to a lit material (Color only: Clay and Depth draw with override materials). The light lands on
 * surfaces that face the refracted sun, scaled by the material's own colour, so a dark wetsuit shows little.
 */
export function patchCaustics(m) {
  if (!m || m.userData?.ssCaustics || !m.isMeshStandardMaterial) return m;
  m.userData.ssCaustics = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    Object.assign(sh.uniforms, CAUSTIC_U);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSsWorld;\nvarying vec3 vSsNormal;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvSsWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSsNormal = normalize(mat3(modelMatrix) * objectNormal);");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vSsWorld;
varying vec3 vSsNormal;
uniform float uCauT; uniform float uCauK; uniform float uCauSurf; uniform vec3 uCauDir;
${WAVE_GLSL}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
if (uCauK > 0.0 && vSsWorld.y < uCauSurf) {
  float lit = max(0.0, dot(normalize(vSsNormal), -uCauDir));
  float cau = ssCaustic(vSsWorld, uCauSurf, uCauDir, uCauT) - 0.75;
  totalEmissiveRadiance += diffuseColor.rgb * vec3(0.78, 0.95, 1.0) * uCauK * lit * max(0.0, cau);
}`);
  };
  const key = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => `${key ? key() : ""}|ssCaustics`;
  m.needsUpdate = true;
  return m;
}

/**
 * The surface seen from below: displaced by the wave field, bright inside Snell's window (the sky, rippling), and a dim
 * mirror of the deep water outside it. Vertex colours are not used; the brightness is all optics.
 */
export function underSurfaceMaterial({ water = new THREE.Color(0x1a5a66), deep = new THREE.Color(0x0f3d4c) } = {}) {
  const m = new THREE.ShaderMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false,
    uniforms: { uT: CAUSTIC_U.uCauT, uWater: { value: water }, uDeep: { value: deep }, uSunAir: CAUSTIC_U.uSunAir },
    vertexShader: `${WAVE_GLSL}
uniform float uT; varying vec3 vW; varying vec3 vN;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float h; vec2 g; vec3 H; ssWave(wp.xz, uT, h, g, H);
  wp.y += h;
  vW = wp.xyz; vN = normalize(vec3(-g.x, 1.0, -g.y));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: `${WAVE_GLSL}
uniform float uT; uniform vec3 uWater; uniform vec3 uDeep; uniform vec3 uSunAir; varying vec3 vW; varying vec3 vN;
void main() {
  float h; vec2 g; vec3 H; ssWave(vW.xz, uT, h, g, H);
  vec3 n = normalize(vec3(-g.x * 1.6, 1.0, -g.y * 1.6));      // ripple normals (the fine waves, exaggerated slightly)
  vec3 v = normalize(vW - cameraPosition);                      // looking up through the surface
  float cosI = dot(v, n);                                       // > 0: the ray leaves the water
  float sinT = ${N_WATER.toFixed(3)} * sqrt(max(0.0, 1.0 - cosI * cosI));
  float win = smoothstep(1.04, 0.96, sinT) * step(0.0, cosI);   // inside Snell's window: the sky
  vec3 rr = refract(v, -n, ${N_WATER.toFixed(3)});              // the ray out into the air (zero past the window)
  float sun = win * pow(max(0.0, dot(rr, uSunAir) / max(1e-4, length(rr))), 300.0);
  vec3 sky = vec3(0.80, 0.93, 1.0) * (0.85 + 0.25 * (1.0 - abs(g.x + g.y) * 8.0)) + vec3(1.0, 0.97, 0.9) * sun * 3.0;
  float dist = length(vW - cameraPosition);
  vec3 mirror = mix(uDeep, uWater, 0.35 + 0.3 * clamp(n.x * 4.0 + 0.5, 0.0, 1.0));
  vec3 col = mix(mirror, sky, win);
  col = mix(uWater, col, exp(-dist * 0.04));
  gl_FragColor = vec4(col, mix(0.75, 0.95, win));
}` });
  m.allowOverride = false;
  return m;
}
