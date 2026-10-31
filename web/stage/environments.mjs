// Soundstage sets, water and atmospherics. Everything is clay-simple and deterministic per
// frame (particles are a pure function of the frame number), so captures are repeatable and
// the preview ladder can cache them.
import * as THREE from "../vendor/three.module.min.mjs";

export const SETS = {
  plaza: { label: "Plaza exterior" },
  street_night: { label: "City street" },
  interior: { label: "Interior room" },
  studio: { label: "Studio cyc / green screen" },
  forest: { label: "Forest" },
  desert: { label: "Desert" },
  beach: { label: "Beach & ocean" },
  water_tank: { label: "Water tank" },
  open_water: { label: "Open water (sea / lake)" },
  stadium: { label: "Stadium / ballfield" },
  empty: { label: "Empty stage" },
};

export const WEATHER = {
  none: { label: "Clear" },
  rain: { label: "Rain" },
  snow: { label: "Snow" },
  fog: { label: "Fog / haze" },
  smoke: { label: "Smoke" },
  dust: { label: "Dust" },
  sparks: { label: "Fire sparks" },
};

/** Tiny deterministic PRNG so "random" set dressing and particles are identical every render. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296;
}

/**
 * Build the static set for a preset. `mesh(geom)` returns a shadowed clay mesh.
 * opts: { seed, water_level, clean: a smooth empty streetscape (street sets), span: [z0, z1] it must cover }.
 * Returns {group, water: {level, size} | null}.
 */
export function buildSet(preset, mesh, opts = {}) {
  const g = new THREE.Group();
  const box = (w, h, d, x, y, z) => {
    const m = mesh(new THREE.BoxGeometry(w, h, d));
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const rand = rng(opts.seed || 7);
  let water = null;
  switch (preset) {
    case "street_night":
      if (opts.clean) {
        // Clean street (ride-along shots on an empty road): one smooth, unbroken facade a side, an even roofline,
        // kerbs and nothing else, as far as the drive goes and beyond. Building blocks with gaps sliding past the
        // frame edge read to LTX as passing cars and trucks (Milestone 5); a featureless wall can't.
        const [z0, z1] = opts.span || [-200, 200];
        const L = z1 - z0, zc = (z0 + z1) / 2;
        for (const side of [-1, 1]) {
          box(9, 12, L, side * 11.5, 6, zc);           // facade front at 7 m from the centre line
          box(1.6, 0.18, L, side * 6.2, 0.09, zc);     // kerb + sidewalk edge
        }
        break;
      }
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const h = 8 + rand() * 14;
          box(9, h, 10, side * 11, h / 2, -25 + i * 11);
        }
        for (let i = 0; i < 5; i++) {
          const p = mesh(new THREE.CylinderGeometry(0.1, 0.12, 4.5, 10));
          p.position.set(side * 5.6, 2.25, -22 + i * 11);
          g.add(p);
        }
      }
      box(1.6, 0.18, 70, -6.2, 0.09, 8); // kerbs
      box(1.6, 0.18, 70, 6.2, 0.09, 8);
      break;
    case "interior": {
      const W = 8, D = 10, H = 3.2;
      box(W, H, 0.2, 0, H / 2, D / 2); // back wall
      box(0.2, H, D, -W / 2, H / 2, 0);
      box(0.2, H, D, W / 2, H / 2, 0);
      const win = box(2.2, 1.4, 0.25, -1.5, 1.7, D / 2 - 0.05); // window frame reads as a lighter patch
      win.scale.z = 0.5;
      box(W, 0.2, D, 0, H, 0); // ceiling
      box(1.0, 2.1, 0.25, 2.5, 1.05, D / 2 - 0.1); // door
      break;
    }
    case "studio": {
      // Curved cyc wall: a quarter-cylinder sweep into the floor plus a tall back plane.
      const cyc = mesh(new THREE.CylinderGeometry(4, 4, 24, 24, 1, true, Math.PI, Math.PI / 2));
      cyc.rotation.z = Math.PI / 2;
      cyc.position.set(0, 4, 12);
      g.add(cyc);
      box(24, 12, 0.2, 0, 10, 16.1);
      break;
    }
    case "forest":
      for (let i = 0; i < 60; i++) {
        const x = (rand() - 0.5) * 70, z = (rand() - 0.2) * 70;
        if (Math.abs(x) < 3 && z < 14) continue; // keep a clearing for the action
        const h = 7 + rand() * 9;
        const t = mesh(new THREE.CylinderGeometry(0.18, 0.3, h * 0.55, 8));
        t.position.set(x, (h * 0.55) / 2, z);
        const c = mesh(new THREE.ConeGeometry(h * 0.18, h * 0.6, 10));
        c.position.set(x, h * 0.7, z);
        g.add(t, c);
      }
      break;
    case "desert":
      for (let i = 0; i < 14; i++) {
        const d = mesh(new THREE.SphereGeometry(1, 20, 12));
        const r = 8 + rand() * 18;
        d.scale.set(r, 1.2 + rand() * 3, r * (0.6 + rand() * 0.6));
        d.position.set((rand() - 0.5) * 120, 0, 25 + rand() * 80);
        g.add(d);
      }
      break;
    case "beach":
      water = { level: 0.05, size: [400, 300], center: [0, 160] };
      break;
    case "water_tank": {
      const W = 16, D = 16, H = 4;
      box(W, H, 0.4, 0, H / 2, D / 2);
      box(W, H, 0.4, 0, H / 2, -D / 2);
      box(0.4, H, D, -W / 2, H / 2, 0);
      box(0.4, H, D, W / 2, H / 2, 0);
      water = { level: opts.water_level ?? 2.5, size: [W - 0.4, D - 0.4], center: [0, 0] };
      break;
    }
    case "stadium": {
      // A ballfield: grass, an infield diamond (home plate at the origin, facing +Z), bases and a mound,
      // tiered stands around the outfield and light towers. Real-ish scale: 27.4 m between bases.
      const flat = (w, d, x, z, y = 0.01, rot = 0) => { const m = box(w, 0.02, d, x, y, z); m.rotation.y = rot; return m; };
      flat(140, 140, 0, 45);                                            // field
      flat(27.4 * 1.45, 27.4 * 1.45, 0, 19.4, 0.02, Math.PI / 4);       // infield dirt
      flat(19, 19, 0, 19.4, 0.03, Math.PI / 4);                         // infield grass
      for (const [x, z] of [[0, 0], [19.4, 19.4], [0, 38.8], [-19.4, 19.4]]) box(0.4, 0.08, 0.4, x, 0.05, z);   // bases
      const mound = mesh(new THREE.CylinderGeometry(2.7, 2.9, 0.25, 24)); mound.position.set(0, 0.12, 18.4); g.add(mound);
      for (let i = 0; i < 9; i++) {                                     // stands: three tiers on an arc behind the field
        const ang = -Math.PI * 0.42 + (i / 8) * Math.PI * 0.84, R = 92;
        for (let t = 0; t < 3; t++) {
          const m = box(26, 3 + t * 3, 6, Math.sin(ang) * (R + t * 6), (3 + t * 3) / 2, 30 + Math.cos(ang) * (R + t * 6));
          m.rotation.y = ang;
        }
      }
      for (const [x, z] of [[-60, 10], [60, 10], [-55, 95], [55, 95]]) {
        box(1, 38, 1, x, 19, z);
        box(8, 3, 1, x, 38, z);
      }
      break;
    }
    case "open_water": {
      // Sea to the horizon over a seabed 1.5 m down; a few low headlands far off give the eye a horizon line.
      for (let i = 0; i < 5; i++) {
        const d = mesh(new THREE.SphereGeometry(1, 18, 10));
        d.scale.set(40 + rand() * 60, 6 + rand() * 10, 30 + rand() * 30);
        d.position.set((rand() - 0.5) * 700, 0, 260 + rand() * 120);
        g.add(d);
      }
      water = { level: opts.water_level ?? 1.5, size: [900, 900], center: [0, 0] };
      break;
    }
    case "empty":
      break;
    default: // plaza
      return { group: null, water: null }; // the plaza is built from the scene's own props
  }
  return { group: g, water };
}

/** A water surface: translucent in clay, opaque-ish in depth (so the model sees the waterline). */
export function buildWater(water) {
  const geo = new THREE.PlaneGeometry(water.size[0], water.size[1], 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x7f97a8, roughness: 0.15, metalness: 0.0,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(water.center[0], water.level, water.center[1]);
  m.receiveShadow = true;
  m.userData.water = true;
  return m;
}

/**
 * Particle field around a point. Positions are a pure function of `frame`, so every capture of
 * the same shot is identical. Returns {object, update(frame, center)} or null for "none"/"fog".
 */
export function buildWeather(kind, density = 0.5) {
  if (kind === "none" || kind === "fog") return null;
  const N = Math.round(400 + density * 5600);
  const rand = rng(1234);
  const seeds = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) seeds[i] = rand();
  const span = { x: 30, y: 14, z: 40 };
  const pos = new Float32Array(N * (kind === "rain" ? 6 : 3));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const color = { rain: 0xc9d3dc, snow: 0xf2f4f7, smoke: 0x8c8c8c, dust: 0xb9ab95, sparks: 0xffe2b0 }[kind] || 0xffffff;
  const size = { snow: 0.09, smoke: 0.9, dust: 0.03, sparks: 0.05 }[kind] || 0.05;
  const object = kind === "rain"
    ? new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }))
    : new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true,
        opacity: kind === "smoke" ? 0.18 : 0.85, depthWrite: kind !== "smoke" }));
  object.userData.weather = kind;
  object.frustumCulled = false;

  const update = (frame, center) => {
    const t = frame / 24;
    for (let i = 0; i < N; i++) {
      const sx = seeds[i * 3], sy = seeds[i * 3 + 1], sz = seeds[i * 3 + 2];
      let x = center.x + (sx - 0.5) * span.x;
      let z = center.z + (sz - 0.5) * span.z;
      let y;
      if (kind === "rain") {
        y = ((sy * span.y - t * 9.0) % span.y + span.y) % span.y;
        pos.set([x, y, z, x + 0.03, y + 0.45, z], i * 6);
        continue;
      } else if (kind === "snow") {
        y = ((sy * span.y - t * 0.9) % span.y + span.y) % span.y;
        x += Math.sin(t * 1.3 + sx * 40) * 0.4;
      } else if (kind === "smoke") {
        y = ((sy * 6 + t * 0.6) % 6);
        x = center.x + (sx - 0.5) * (2 + y * 1.2) + Math.sin(t + sz * 9) * 0.5;
        z = center.z + 6 + (sz - 0.5) * (2 + y * 1.2);
      } else if (kind === "sparks") {
        y = ((sy * 4 + t * 2.5) % 4);
        x = center.x + (sx - 0.5) * (1 + y * 0.8);
        z = center.z + 6 + (sz - 0.5) * (1 + y * 0.8);
      } else { // dust
        y = sy * 4 + Math.sin(t * 0.7 + sx * 20) * 0.3;
        x += Math.sin(t * 0.4 + sz * 30) * 0.8;
      }
      pos.set([x, y, z], i * 3);
    }
    geo.attributes.position.needsUpdate = true;
  };
  return { object, update };
}
