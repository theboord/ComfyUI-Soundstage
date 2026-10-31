// Fire: flame clusters (self-lit tongues that lick and sway), embers, smoke and flickering firelight, all a pure
// function of the frame. Used by the Burning building set and by the "Fire" atmospheric, which can go on any set
// (a campfire glow in the forest, a burning car on the street: environment.fire_at = [[x, z, size], ...]).
import * as THREE from "../../vendor/three.module.min.mjs";
import { mergeGeometries } from "../../vendor/addons/BufferGeometryUtils.mjs";
import { rng, Batch, glow, lightish, softPoints, flicker } from "./common.mjs";

// A flame tongue: wide at the root, pinched waist, pointed tip (a lathe profile), unit height, coloured by height
// (white-yellow root, orange body, dark red tip that fades out under additive blending).
let TONGUE = null, TONGUE_MAT = null;
function tongueGeo() {
  if (TONGUE) return TONGUE;
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const v = i / 12;
    const r = 0.3 * Math.sin(Math.PI * Math.pow(v, 0.5)) * Math.pow(1 - v, 0.35) + 0.001;   // full root, long licking tip
    pts.push(new THREE.Vector2(r, v));
  }
  TONGUE = new THREE.LatheGeometry(pts, 14);
  const p = TONGUE.attributes.position, col = new Float32Array(p.count * 3);
  // additive and overlapping: each tongue is dim on its own, so cores sum to yellow-white and the edges stay orange
  const stops = [[0, [0.62, 0.5, 0.3]], [0.25, [0.66, 0.4, 0.12]], [0.6, [0.55, 0.18, 0.03]], [1, [0.12, 0.02, 0.0]]];
  for (let i = 0; i < p.count; i++) {
    const v = p.getY(i);
    let k = 0; while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [a, ca] = stops[k], [b, cb] = stops[k + 1], u = Math.min(1, Math.max(0, (v - a) / (b - a)));
    col.set(ca.map((c, j) => c + (cb[j] - c) * u), i * 3);
  }
  TONGUE.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return TONGUE;
}
// Soft, licking flames: bright where the tongue faces the camera and fading at its silhouette (no hard cut-out edge),
// the upper part rippling sideways with a travelling wave. uTime is set from the frame, so it is deterministic.
function tongueMat() {
  if (!TONGUE_MAT) {
    TONGUE_MAT = new THREE.ShaderMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      vertexColors: true, uniforms: { uTime: { value: 0 } },
      vertexShader: `uniform float uTime; varying vec3 vC; varying float vF;
        void main(){
          vec3 p = position; float y = p.y;
          float ph = modelMatrix[3].x * 2.3 + modelMatrix[3].z * 1.7 + modelMatrix[3].y * 0.9;
          p.x += sin(y * 7.0 - uTime * 9.0 + ph) * 0.07 * y + sin(y * 13.0 - uTime * 15.0 + ph * 2.0) * 0.025 * y;
          p.z += cos(y * 6.0 - uTime * 8.0 + ph * 1.3) * 0.06 * y;
          vC = color;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vF = pow(abs(dot(n, normalize(-mv.xyz))), 1.4);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: "varying vec3 vC; varying float vF; void main(){ gl_FragColor = vec4(vC * (0.25 + 0.95 * vF), 1.0); }" });
    TONGUE_MAT.allowOverride = false;
  }
  return TONGUE_MAT;
}

/**
 * A cluster of flame tongues about `size` metres tall, with its own ember stream and smoke. Returns
 * {group, animate(t)}; t in seconds. seed varies the shape. light: a flickering point light (null = none).
 */
export function flameCluster(size = 1.5, seed = 1, { light = true, embers = 60, smoke = 24, spread = 0.6, lean = [0, 0] } = {}) {
  const g = new THREE.Group();
  const r = rng(seed * 7919 + 3);
  const tongues = [];
  const n = Math.max(5, Math.round((8 + r() * 4) * Math.min(1.4, 0.6 + size * 0.3)));
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread * size * 0.5;
    const h = size * (0.35 + r() * 0.7) * (i < 2 ? 1.25 : 1) * (1 - 0.35 * d / (spread * size * 0.5 + 0.01)), w = h * (0.28 + r() * 0.22);
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    const t = lightish(new THREE.Mesh(tongueGeo(), tongueMat()));
    t.scale.set(w, h, w);
    t.renderOrder = 2;
    pivot.add(t);
    g.add(pivot);
    tongues.push({ pivot, h, ph: r() * 10, sp: 0.8 + r() * 0.6 });
  }
  // a bed of glowing coals at the root
  const bed = lightish(new THREE.Mesh(new THREE.CircleGeometry(size * spread * 0.55 + 0.15, 16), glow("#ff4a10", 0.5)));
  bed.rotation.x = -Math.PI / 2; bed.position.y = 0.03;
  g.add(bed);
  let pl = null;
  if (light) {
    pl = new THREE.PointLight(0xff8a3a, 14 * size, 9 + size * 6, 1.7);
    pl.position.set(0, size * 0.55, 0);
    pl.castShadow = false;
    pl.userData.lightId = `fire_${seed}`;
    g.add(pl);
  }
  const E = embers, em = E ? lightish(softPoints(E, 0xffb050, 0.05 + size * 0.015, { opacity: 0.95, additive: true, fog: false })) : null;
  if (em) { em.material.allowOverride = false; g.add(em); }
  const S = smoke, sm = S ? lightish(softPoints(S, 0x2c2a28, 1.1 + size * 0.7, { opacity: 0.42 })) : null;
  if (sm) { sm.material.allowOverride = false; sm.renderOrder = 1; g.add(sm); }
  const animate = (t) => {
    tongueMat().uniforms.uTime.value = t;
    for (const q of tongues) {
      const f = flicker(t * q.sp, q.ph + seed);
      q.pivot.scale.set(1 + 0.1 * flicker(t * 1.3, q.ph * 2), 1 + 0.28 * f, 1 + 0.1 * flicker(t * 1.1, q.ph * 3));
      q.pivot.rotation.z = 0.12 * flicker(t * 0.7, q.ph + 4) + lean[0];
      q.pivot.rotation.x = 0.1 * flicker(t * 0.6, q.ph + 9) + lean[1];
    }
    if (pl) pl.intensity = 14 * size * (0.78 + 0.22 * flicker(t * 1.6, seed));
    if (em) {
      const pos = em.geometry.attributes.position;
      for (let i = 0; i < E; i++) {
        const life = 1.4 + (i % 7) * 0.22, age = ((t + i * 0.311) % life) / life;
        const ang = i * 2.399 + age * 2.2, rad = 0.15 * size + 0.5 * size * age;
        pos.setXYZ(i, Math.cos(ang) * rad + Math.sin(t * 1.7 + i) * 0.15 * age + lean[0] * -2 * age * size,
          0.2 * size + age * 2.8 * size, Math.sin(ang) * rad + lean[1] * 2 * age * size);
      }
      pos.needsUpdate = true;
    }
    if (sm) {
      const pos = sm.geometry.attributes.position;
      for (let i = 0; i < S; i++) {
        const life = 5 + (i % 5) * 0.8, age = ((t + i * 0.73) % life) / life;
        pos.setXYZ(i, Math.sin(i * 1.7 + t * 0.3) * (0.3 + age * 1.6) + age * 1.8 + lean[0] * -3 * age,
          size * 1.1 + age * 6 * size, Math.cos(i * 2.3 + t * 0.25) * (0.3 + age * 1.2) + lean[1] * 3 * age);
      }
      pos.needsUpdate = true;
    }
  };
  animate(0);
  return { group: g, animate, light: pl };
}

/** A self-lit window-room panel, bottom colour fading to top colour (kept in Clay, hidden in Depth / ID). */
const GRADS = new Map();
function gradGlow(bottom, top, additive = false) {
  const key = [bottom, top, additive].join("|");
  if (GRADS.has(key)) return GRADS.get(key);
  const m = new THREE.ShaderMaterial({ transparent: additive, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: !additive,
    side: THREE.DoubleSide, uniforms: { uB: { value: new THREE.Color(bottom) }, uT: { value: new THREE.Color(top) } },
    vertexShader: "varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 uB; uniform vec3 uT; varying vec2 vU; void main(){ gl_FragColor = vec4(mix(uB, uT, smoothstep(0.05, 0.95, vU.y)), 1.0); }" });
  m.allowOverride = false;
  GRADS.set(key, m);
  return m;
}

// ------------------------------------------------------------------ the "Fire" atmospheric (any set)
/**
 * Fire on any set. Where: environment.fire_at ([[x, z, size?], ...]) or, by default, a line of fires across the
 * ground point the shot camera looks at on frame 0, pushed 2.5 m further away. density 0..1 = how many and how big.
 */
export function buildFireWeather(density = 0.5) {
  const object = new THREE.Group();
  object.userData.weather = "fire";
  object.frustumCulled = false;
  const n = 1 + Math.round(density * 3);
  const clusters = [];
  for (let i = 0; i < 5; i++) {
    const c = flameCluster(1.0 + density * 1.6 * (i === 0 ? 1 : 0.7), 31 + i * 13, { light: i < 2, embers: 50, smoke: 18 });
    c.group.visible = false;
    object.add(c.group);
    clusters.push(c);
  }
  const update = (frame, center, stage) => {
    const t = frame / (stage?.state?.shot?.fps || 24);
    const env = stage?.state?.environment || {};
    let spots = Array.isArray(env.fire_at) && env.fire_at.length ? env.fire_at.slice(0, 5) : null;
    if (!spots) {
      let gx = center?.x ?? 0, gz = (center?.z ?? 0), dx = 0, dz = 1;
      try {
        const c0 = stage._cameraAt(0), p = c0.position, q = c0.target;
        const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        const tt = d[1] < -0.02 ? Math.min(25 / Math.hypot(...d), -p[1] / d[1]) : 1;
        gx = p[0] + d[0] * tt; gz = p[2] + d[2] * tt;
        const L = Math.hypot(d[0], d[2]) || 1; dx = d[0] / L; dz = d[2] / L;
      } catch { /* no stage: around the centre */ }
      gx += dx * 2.5; gz += dz * 2.5;
      spots = [];
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 2.6 + (i % 2 ? 0.6 : -0.4);
        spots.push([gx + -dz * off, gz + dx * off + (i % 2) * 1.2, i === 0 ? 1 : 0.75]);
      }
    }
    clusters.forEach((c, i) => {
      const s = spots[i];
      c.group.visible = !!s;
      if (!s) return;
      const k = s[2] ?? 1;
      c.group.position.set(s[0], 0, s[1]);
      c.group.scale.setScalar(k);
      c.animate(t);
    });
  };
  return { object, update };
}

// ------------------------------------------------------------------ Burning building set
/** Night street in front of a three-storey building on fire, with burning debris and a burnt-out car on the road. */
export function buildBurningBuilding(opts = {}) {
  return makeBurning(opts);   // not memoised: its flames are animated transforms, which clones would not share
}

function makeBurning() {
  const g = new THREE.Group();
  g.userData.set = "burning_building";
  const B = new Batch();
  const r = rng(29);
  // street surface, kerbs and sidewalk
  B.add(new THREE.BoxGeometry(70, 0.02, 60), "#2c2d30", 0, 0.01, 4, 0, 0, 0, 1, 1, 1, { rough: 0.6 });
  B.add(new THREE.BoxGeometry(60, 0.16, 4.2), "#77736c", 0, 0.08, 10.1);
  B.add(new THREE.BoxGeometry(60, 0.16, 3.2), "#77736c", 0, 0.08, -9.6);
  // the burning building: brick facade with 3 floors x 7 windows, front at z = 12.2
  const FZ = 12.2, W = 26, H = 11.5, floors = [1.2, 4.6, 8.0], wx = [-10.5, -7, -3.5, 0, 3.5, 7, 10.5], ww = 1.5, wh = 2.1;
  const brick = "#5a3a2e", trim = "#3a2a24";
  const box = (w, h, d, x, y, z, color = brick) => B.add(new THREE.BoxGeometry(w, h, d), color, x, y, z);
  // horizontal bands between windows
  let y0 = 0;
  for (const fy of floors) { box(W, fy - y0, 0.5, 0, (y0 + fy) / 2, FZ); y0 = fy + wh; }
  box(W, H - y0, 0.5, 0, (y0 + H) / 2, FZ);
  // piers between windows on each floor
  for (const fy of floors) {
    let x0 = -W / 2;
    for (const x of wx) { const a = x - ww / 2; box(a - x0, wh, 0.5, (x0 + a) / 2, fy + wh / 2, FZ); x0 = x + ww / 2; }
    box(W / 2 - x0, wh, 0.5, (x0 + W / 2) / 2, fy + wh / 2, FZ);
    for (const x of wx) { box(ww + 0.25, 0.12, 0.7, x, fy - 0.05, FZ - 0.1, trim); box(ww + 0.2, 0.18, 0.6, x, fy + wh + 0.08, FZ - 0.05, trim); }
  }
  box(W + 0.6, 0.5, 0.9, 0, H + 0.25, FZ, trim);                 // cornice
  box(0.5, H, 9, -W / 2, H / 2, FZ + 4.5); box(0.5, H, 9, W / 2, H / 2, FZ + 4.5);   // side walls
  box(W, H, 0.5, 0, H / 2, FZ + 9);                                                    // back wall
  for (const fy of floors) box(W, 0.25, 9, 0, fy - 0.15, FZ + 4.5, "#2a2422");       // floor slabs (dark rooms)
  box(W, 0.3, 9, 0, H, FZ + 4.5, "#2a2422");
  // neighbours: dark, unburnt, set back a little
  for (const [x, w, h] of [[-21.5, 16, 14], [21, 15, 9.5], [-33, 9, 18], [32, 10, 12]]) {
    box(w, h, 10, x, h / 2, FZ + 6, x < 0 ? "#3f4146" : "#4a443d");
    for (let fy = 1.4; fy < h - 1.5; fy += 3.3) for (let i = 0; i < Math.floor(w / 3.2); i++)
      box(1.2, 1.7, 0.08, x - w / 2 + 1.8 + i * 3.2, fy + 0.85, FZ + 0.96, "#1d1f24");
  }
  // street furniture: hydrant, a lamp post (lamp off), a fallen beam, rubble
  B.add(new THREE.CylinderGeometry(0.14, 0.16, 0.7, 10), "#9a2a22", 5.5, 0.35, 8.6);
  B.add(new THREE.CylinderGeometry(0.09, 0.11, 4.6, 8), "#2f3236", -12, 2.3, 8.4);
  for (let i = 0; i < 26; i++) { const s = 0.15 + r() * 0.35; B.add(new THREE.BoxGeometry(s, s * 0.6, s * 1.3), r() < 0.5 ? "#4a3a32" : "#2b2725", -9 + r() * 18, s * 0.3, 7 + r() * 4, r(), r() * 3, r()); }
  // burning debris piles on the road: charred beams criss-crossed
  const piles = [[-5.2, 4.2, 1.5], [3.8, 5.6, 1.9], [8.6, 2.6, 1.1], [-9.5, 6.4, 1.3]];
  for (const [x, z, s] of piles) {
    for (let i = 0; i < 5; i++) B.add(new THREE.BoxGeometry(0.22 * s, 0.2 * s, 2.0 * s), "#1e1a18", x + (r() - 0.5) * 0.4 * s, 0.12 * s + i * 0.12 * s, z + (r() - 0.5) * 0.4 * s, (r() - 0.5) * 0.5, r() * 3.14, (r() - 0.5) * 0.4);
  }
  // a burnt-out car shell, fire in its cabin
  const car = [13.5, 0, -1.5];
  B.add(new THREE.BoxGeometry(1.8, 0.7, 4.3), "#24201e", car[0], 0.55, car[2]);
  B.add(new THREE.BoxGeometry(1.6, 0.55, 2.2), "#1b1817", car[0], 1.15, car[2] - 0.2);
  for (const [dx, dz] of [[0.85, 1.35], [-0.85, 1.35], [0.85, -1.35], [-0.85, -1.35]]) B.add(new THREE.CylinderGeometry(0.33, 0.33, 0.22, 12), "#111", car[0] + dx, 0.33, car[2] + dz, 0, 0, Math.PI / 2);
  B.build(g);
  // the window glow: rooms full of fire behind every opening (self-lit panels set back in the rooms, bright low down,
  // smoke-dark at the top), and soot licking up the brick above each burning window
  const fireRoom = gradGlow("#ff8c2e", "#3a0d04"), hot = gradGlow("#c45a14", "#000000", true);
  const soot = [];
  const burning = new Set(["0,2", "0,3", "1,1", "1,2", "1,3", "1,4", "2,2", "2,3", "2,4", "2,5", "0,4", "2,1"]);
  const fires = [];
  floors.forEach((fy, fi) => wx.forEach((x, wi) => {
    const lit = burning.has(`${fi},${wi}`);
    const back = lightish(new THREE.Mesh(new THREE.PlaneGeometry(ww * 1.6, wh * 1.2), lit ? fireRoom : glow("#3a1a10", 1, { additive: false })));
    back.position.set(x, fy + wh / 2, FZ + 2.6); back.rotation.y = Math.PI;
    g.add(back);
    if (lit) {
      const haze = lightish(new THREE.Mesh(new THREE.PlaneGeometry(ww * 0.98, wh * 0.98), hot));
      haze.position.set(x, fy + wh / 2, FZ + 0.3); haze.rotation.y = Math.PI;
      g.add(haze);
      const sg = new THREE.PlaneGeometry(ww * 1.5, 1.15);     // a soft smudge of soot up the brick (alpha in the shader)
      sg.rotateY(Math.PI);
      sg.translate(x, fy + wh + 0.62, FZ - 0.265);
      soot.push(sg);
      // flames licking out of the upper half of the window, up the facade
      if ((fi + wi) % 2 === 0 || fi === 2) {
        const c = flameCluster(fi === 2 ? 2.2 : 1.6, 100 + fi * 10 + wi, { light: false, embers: 30, smoke: fi === 2 ? 10 : 0, spread: 0.9, lean: [0, -0.25] });
        c.group.position.set(x, fy + wh * 0.35, FZ - 0.35);
        c.group.scale.set(1, 1, 0.55);
        g.add(c.group); fires.push(c);
      }
    }
  }));
  if (soot.length) {
    const sm = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: "varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "varying vec2 vU; void main(){ float x = abs(vU.x * 2.0 - 1.0); float a = 0.7 * pow(1.0 - vU.y, 1.2) * (1.0 - x * x * (0.6 + 0.4 * vU.y)); gl_FragColor = vec4(0.04, 0.03, 0.025, a); }" });
    sm.allowOverride = false;
    g.add(lightish(new THREE.Mesh(mergeGeometries(soot), sm)));
  }
  // roofline fire and the street fires
  for (const [x, s] of [[-2.5, 3.2], [4, 2.6], [8.5, 2.2]]) {
    const c = flameCluster(s, 300 + x * 3, { light: false, embers: 90, smoke: 40, spread: 1.4 });
    c.group.position.set(x, H + 0.5, FZ + 1.5); g.add(c.group); fires.push(c);
  }
  piles.forEach(([x, z, s], i) => { const c = flameCluster(s, 500 + i, { light: i < 2, embers: 60, smoke: 20 }); c.group.position.set(x, 0.25 * s, z); g.add(c.group); fires.push(c); });
  { const c = flameCluster(1.4, 777, { light: true, embers: 50, smoke: 26, spread: 0.9 }); c.group.position.set(car[0], 1.1, car[2] - 0.3); g.add(c.group); fires.push(c); }
  // the big firelight from the building: a broad warm light on the street (casts shadows: the silhouette shot)
  const key = new THREE.PointLight(0xff7a30, 260, 40, 1.5);
  key.position.set(0, 5.5, FZ - 2.5); key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  key.userData.lightId = "building_fire";
  g.add(key);
  const fx = {
    id: "burning_building",
    update(f, stage) {
      const t = f / (stage?.state?.shot?.fps || 24);
      for (const c of fires) c.animate(t);
      key.intensity = 260 * (0.82 + 0.18 * flicker(t * 1.2, 5));
      key.position.x = 0.6 * flicker(t * 0.5, 9);
    },
  };
  fx.update(0, null);
  return { group: g, fx };
}
