// node --test tests/js/mediafix.test.mjs
// README media v2 QC fixes (2026-11-02): every set's ground and backdrop carry their real colour in the Color pass
// (setlook.mjs), the dust is a lit volume (secondary.mjs), and the wheels stay inside the car models' arches at full
// lock and in a stunt lean (archfit.mjs, measured on the GLBs themselves).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { SETS, buildSet } from "../../web/stage/environments.mjs";
import { SET_LOOK, SAND, SNOW, groundColor, groundReach, dressColor } from "../../web/stage/setlook.mjs";
import { GROUND_PRESETS } from "../../web/stage/particles.mjs";
import { LIBRARY } from "../../web/stage/library.mjs";
import { measureLock, archLift, wheelOf } from "../../web/stage/archfit.mjs";
import { buildSecondaryFx } from "../../web/stage/secondary.mjs";
import { steerLock } from "../../web/stage/vehicleparts.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};

function headless(actors = [], environment = { set: "studio" }) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames: 97, fps: 24 }, actors: structuredClone(actors), environment },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.onChange = () => {};
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}
const hexOf = (m) => "#" + m.color.getHexString(THREE.SRGBColorSpace);

// ------------------------------------------------------------------ 1. set colours in the Color pass

test("every set has a real ground colour; the desert is the sand its dust is made of", () => {
  for (const id of Object.keys(SETS)) assert.match(SET_LOOK[id]?.ground || "", /^#[0-9a-f]{6}$/, id);
  const sand = GROUND_PRESETS.desert_sand.dust.color.map((v) => Math.round(v * 255));
  assert.deepEqual([1, 3, 5].map((i) => parseInt(SAND.slice(i, i + 2), 16)), sand);
  assert.equal(groundColor({ set: "desert" }), SAND);
  // Real albedos: sand light and warm, grass green, asphalt dark, snow near white.
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [sr, sg, sb] = rgb(SAND); assert.ok(sr > sg && sg > sb && sr > 0.6, "warm sand");
  const [gr, gg, gb] = rgb(SET_LOOK.stadium.ground); assert.ok(gg > gr && gg > gb, "green grass");
  assert.ok(Math.max(...rgb(SET_LOOK.street_night.ground)) < 0.4 && Math.max(...rgb(SET_LOOK.street_night.ground)) < Math.min(...rgb(SAND).slice(0, 2)), "dark asphalt");
  assert.ok(Math.min(...rgb(SNOW)) > 0.85, "white snow");
  // Snow lies on the outdoor sets, not indoors or on the seabed.
  assert.equal(groundColor({ set: "desert", weather: "snow" }), SNOW);
  assert.equal(groundColor({ set: "forest", weather: "snow" }), SNOW);
  assert.notEqual(groundColor({ set: "interior", weather: "snow" }), SNOW);
  assert.notEqual(groundColor({ set: "underwater", weather: "snow" }), SNOW);
  // No set is left on the clay default.
  for (const id of Object.keys(SETS)) assert.notEqual(groundColor({ set: id }), "#9a9a9a", id);
});

test("the stage floor and the set dressing carry the set's colour; Clay still overrides every material", () => {
  for (const id of Object.keys(SETS)) {
    const st = headless([], { set: id, weather: "none" });
    assert.equal(hexOf(st.ground.material), groundColor({ set: id }), `${id} floor`);
    assert.equal(st.ground.scale.x, groundReach(id), `${id} reach`);
  }
  // Open land runs out toward the horizon; enclosed sets keep the 80 m floor.
  assert.ok(groundReach("desert") >= 10 && groundReach("beach") >= 10 && groundReach("interior") === 1 && groundReach("studio") === 1);
  const st = headless([], { set: "desert", weather: "dust" });
  const dunes = [];
  st.root.traverse((o) => { if (o.isMesh && o.geometry.type === "SphereGeometry" && !o.userData.actorId) dunes.push(hexOf(o.material)); });
  assert.ok(dunes.length >= 10 && dunes.every((h) => h === dressColor("desert", "dune")), "the dunes are sand");
  // Weather change rebuilds the floor: snow on the desert.
  st.setEnvironment({ weather: "snow" });
  assert.equal(hexOf(st.ground.material), SNOW);
  // Every role the basic sets use has a colour (no dressing left clay grey in Color).
  for (const id of ["street_night", "interior", "studio", "forest", "desert", "water_tank", "stadium", "open_water"]) {
    const seen = new Set();
    buildSet(id, (g, c) => { seen.add(c); return new THREE.Mesh(g, new THREE.MeshBasicMaterial()); }, {});
    assert.ok(![...seen].includes(undefined), `${id}: every piece of dressing has a colour`);
  }
  // Water surfaces: the set's sea / tank colour.
  const beach = headless([], { set: "beach" });
  assert.equal(hexOf(beach.water.material), SET_LOOK.beach.water);
  // Clay: the override material replaces the colours (the layout guide stays grey).
  st.renderer = { domElement: { width: 640, height: 360 }, render() {} };
  st._renderMode("clay", true);
  assert.equal(st.scene.overrideMaterial, st.clayMat);
});

// ------------------------------------------------------------------ 2. dust as a lit volume

test("dust is lit by the set's sun, sky and lamps, in linear colour, and sits on the ground instead of being sliced by it", () => {
  const fx = buildSecondaryFx();
  const sim = { frames: [{ n: { dust: 2, debris: 0, sparks: 0 }, dust: new Float32Array([
    0, 0.1, 5, 2.0, 0.6, 0.76, 0.62, 0.45, 0, 0,     // a 2 m sand puff whose centre is 10 cm off the ground
    3, 1.5, 5, 1.0, 0.5, 0.76, 0.62, 0.45, 0, 1]), debris: [], sparks: [] }] };
  fx.set(sim, 0);
  const pos = fx.dust.geometry.attributes.position.array, col = fx.dust.geometry.attributes.color.array;
  assert.ok(Math.abs(pos[1] - 0.8) < 1e-6, `lifted to 0.4 x its size: ${pos[1]}`);
  assert.ok(Math.abs(pos[4] - 1.5) < 1e-6, "a puff in the air stays where it is");
  const lin = new THREE.Color().setRGB(0.76, 0.62, 0.45, THREE.SRGBColorSpace);
  assert.ok(Math.abs(col[0] - lin.r) < 1e-6 && Math.abs(col[2] - lin.b) < 1e-6, "sRGB sand -> linear (it rendered near-white)");
  // Lights: the sun direction in view space, its colour x intensity, the sky, and a street lamp at one puff.
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 1.5, 0.1, 100);
  cam.position.set(0, 1.5, 0); cam.lookAt(0, 1.5, 10); cam.updateMatrixWorld();
  const sun = new THREE.DirectionalLight(0xffd8a0, 2.0); sun.position.set(0, 10, 40); scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xa0c0ff, 0x403020, 0.8); scene.add(hemi);
  const lamp = new THREE.PointLight(0xffa040, 30, 0, 2); lamp.position.set(3, 3, 5); scene.add(lamp);
  scene.updateMatrixWorld();
  fx.lightFrom({ sun, hemi, scene }, cam);
  const U = fx.uniforms;
  assert.ok(U.uSunV.value.z < -0.9, "sun ahead of the camera (backlit dust): view-space -z");
  assert.ok(Math.abs(U.uSunCol.value.r - sun.color.r * 2) < 1e-6);
  assert.ok(Math.abs(U.uSky.value.b - hemi.color.b * 0.8) < 1e-6);
  const lit = fx.dust.geometry.attributes.pLit.array;
  assert.ok(lit[3] > lit[0] * 3 && lit[3] > 5, `the puff under the lamp is lit by it: ${lit[0].toFixed(2)} vs ${lit[3].toFixed(2)}`);
  // The shader carries the lighting terms (not an unlit cut-out).
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.points.vertexShader, fragmentShader: THREE.ShaderLib.points.fragmentShader };
  fx.dust.material.onBeforeCompile(sh);
  for (const w of ["uSunV", "uSunCol", "uSky", "uGnd", "vLit", "exp(-tx.a"]) assert.ok(sh.fragmentShader.includes(w), w);
  assert.ok(sh.uniforms.uSunV === U.uSunV);
});

// ------------------------------------------------------------------ 3. wheels inside the arches

/** Minimal GLB reader: {nodeName: {positions, tris}} with each node's translation and scale applied. */
function readGlb(path) {
  const b = readFileSync(path);
  const jl = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + jl).toString("utf8"));
  const off = 20 + jl, bin = b.subarray(off + 8, off + 8 + b.readUInt32LE(off));
  const acc = (i) => {
    const a = j.accessors[i], bv = j.bufferViews[a.bufferView], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const T = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
    const st = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
    return new T(bin.buffer.slice(st, st + a.count * n * T.BYTES_PER_ELEMENT));
  };
  const out = {};
  for (const node of j.nodes) {
    if (node.mesh == null) continue;
    const t = node.translation || [0, 0, 0], s = node.scale || [1, 1, 1], pos = [], tris = [];
    for (const p of j.meshes[node.mesh].primitives) {
      const P = acc(p.attributes.POSITION), I = acc(p.indices);
      const v = (k) => [P[k * 3] * s[0] + t[0], P[k * 3 + 1] * s[1] + t[1], P[k * 3 + 2] * s[2] + t[2]];
      for (let k = 0; k < P.length / 3; k++) pos.push(...v(k));
      for (let k = 0; k < I.length; k++) tris.push(...v(I[k]));
    }
    out[node.name] = { positions: Float32Array.from(pos), tris: Float32Array.from(tris) };
  }
  return out;
}

for (const kind of ["sports_car", "police_car", "hatchback"]) {
  test(`${kind}: the steering lock is measured on its GLB's arches, and the stage never turns the wheels past it`, () => {
    const g = readGlb(fileURLToPath(new URL(`../../web/stage/models/${LIBRARY[kind].model}`, import.meta.url)));
    const names = Object.keys(g), body = names.find((n) => !/Wheel/i.test(n)), fl = names.find((n) => /FrontLeft/i.test(n));
    const m = measureLock(g[body].tris, g[fl].positions);
    const lock = LIBRARY[kind].steer_lock;
    assert.ok(Number.isFinite(lock), "the library carries the measured lock");
    assert.ok(lock <= m.lock, `${kind}: steer_lock ${lock} <= measured ${m.lock}`);
    assert.ok(lock >= m.lock - 2, `${kind}: and not needlessly small (${lock} vs ${m.lock})`);
    assert.ok(lock < 35, "tighter than the old 35° path lock and the sim's 52° stunt lock: those stood out of the fender");
    assert.equal(steerLock({ kind }), lock);
    const w = wheelOf(g[fl].positions);
    assert.ok(w.r > 0.2 && w.r < 0.4 && w.w > 0.1, JSON.stringify(w));
  });
}

test("a keyed 52° stunt lock is clamped on screen; a rolled body is lifted off its outside tyres", async () => {
  const st = headless([{ id: "c", name: "c", kind: "sports_car", height_m: 1.2, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] }]);
  let g;
  for (let i = 0; i < 400 && !(g = st.actorMeshes.get("c"))?.userData.vehicleBody; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(g?.userData.vehicleBody, "the model loaded");
  st.setFrame(0);
  const R = g.userData.partsRig;
  st.setPart("c", "steer", 52);
  for (const n of R.steerNodes) assert.ok(Math.abs(n.rotation.y - LIBRARY.sports_car.steer_lock * Math.PI / 180) < 1e-6, `clamped: ${n.rotation.y}`);
  st.setPart("c", "steer", -52);
  for (const n of R.steerNodes) assert.ok(Math.abs(n.rotation.y + LIBRARY.sports_car.steer_lock * Math.PI / 180) < 1e-6);
  // A 7° stunt lean (the J-turn's peak): no arch lip ends up lower than its tyre top, give or take the 2 cm tuck.
  const body = g.userData.vehicleBody;
  st.setParts("c", { susp_roll: 7, susp_pitch: 2.5 });
  body.updateMatrixWorld(true);
  g.updateMatrixWorld(true);
  let worst = -Infinity;
  for (const w of R.wheels) {
    const lip = new THREE.Vector3(w.position.x, w.position.y + w.userData.radius, w.position.z);   // car space, at rest
    const rel = lip.clone().sub(new THREE.Vector3(0, R.baseY, 0));
    const now = rel.clone().applyEuler(body.rotation).add(body.position);                         // the same body point now
    worst = Math.max(worst, lip.y - now.y);
  }
  assert.ok(worst <= 0.02 + 1e-6, `the lowest lip sinks ${worst.toFixed(3)} m into its tyre`);
  // archLift itself: nothing to lift at rest, more for more roll, symmetric left / right.
  const hubs = R.wheels.map((w) => ({ x: w.position.x, y: w.position.y, z: w.position.z, r: w.userData.radius }));
  assert.equal(archLift(hubs, R.baseY, 0, 0), 0);
  const a4 = archLift(hubs, R.baseY, 4 * Math.PI / 180, 0), a8 = archLift(hubs, R.baseY, 8 * Math.PI / 180, 0);
  assert.ok(a8 > a4 && a4 > 0, `${a4} < ${a8}`);
  assert.ok(Math.abs(archLift(hubs, R.baseY, -8 * Math.PI / 180, 0) - a8) < 0.01, "either way round");
});
