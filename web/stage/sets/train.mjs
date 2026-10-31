// Train sets: a passenger car interior (facing seat bays with tables, luggage racks, big windows on a landscape that
// streams past) and a station platform (two tracks, canopy, footbridge, station building), plus the train itself as a
// library vehicle: a locomotive and three carriages that drive along the track on keys. No text anywhere (no
// destination boards, no car numbers, no station names: signs garble in AI renders).
//
// Axes: the train runs +Z (forward), +X is its left; rail top is y = 0 on the station set; the car floor is y = 0
// on the interior set.
import * as THREE from "../../vendor/three.module.min.mjs";
import { rng, Batch, glow, lightish, memoSet, wrap, skyDome, batchToMeshes, roundedBox, sweepProfile, flipFaces } from "./common.mjs";
import { SeatBank } from "./seatbank.mjs";

// ------------------------------------------------------------------ the double seat (set dressing + library)
/** Seats of one double seat (library kind train_seats): +Z forward, +X = the seat's left. */
export const TRAIN_SEATS = [
  { name: "Left seat", pos: [0.25, 0.49, -0.04] },
  { name: "Right seat", pos: [-0.25, 0.49, -0.04] },
];
const MOQUETTE = "#3d4b5f", HEAD = "#52617a", FRAME = "#55595e", GRAB = "#a9adb1";

/** A high-backed double seat facing +Z, origin on the floor at its centre (adds to a Batch). */
export function trainSeat(B) {
  const box = (w, h, d, x, y, z, color, rx = 0) => B.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx);
  const soft = (w, h, d, r, x, y, z, color, rx = 0, seg = 1) => B.add(roundedBox(w, h, d, r, seg), color, x, y, z, rx);
  for (const x of [0.25, -0.25]) {
    soft(0.46, 0.13, 0.5, 0.05, x, 0.44, 0.04, MOQUETTE, 0, 2);
    soft(0.46, 0.74, 0.13, 0.055, x, 0.88, -0.24, MOQUETTE, -0.12, 2);
    soft(0.43, 0.22, 0.14, 0.06, x, 1.28, -0.29, HEAD, -0.12, 2);     // headrest wing
  }
  soft(1.0, 1.04, 0.04, 0.015, 0, 0.84, -0.33, "#2f353d", -0.12);    // the seat's hard back shell
  soft(0.05, 0.05, 0.42, 0.02, 0.5, 0.65, 0.02, FRAME);              // outer armrests
  soft(0.05, 0.05, 0.42, 0.02, -0.5, 0.65, 0.02, FRAME);
  box(0.96, 0.03, 0.03, 0, 1.44, -0.37, GRAB);                        // grab rail along the top
  box(0.9, 0.36, 0.42, 0, 0.18, -0.02, "#2b3036");                    // plinth
  return B;
}

/** The library double seat (kind train_seats). */
export function buildTrainSeats(mesh) {
  const g = new THREE.Group();
  batchToMeshes(trainSeat(new Batch()), mesh, g);
  g.userData.limbs = [];
  g.userData.seats = TRAIN_SEATS;
  return g;
}

// ------------------------------------------------------------------ passenger car interior
export const CAR = { z0: -11.5, z1: 11.5, half: 1.38, bay: 1.95, firstBay: -8.8, bays: 9, bank: 0.86 };
/** Seat slots: per bay, a forward-facing and a rear-facing double seat each side ({x, z, ry}). */
export function carSlots() {
  const out = [];
  for (let i = 0; i < CAR.bays; i++) {
    const zb = CAR.firstBay + i * CAR.bay;
    for (const s of [1, -1]) {
      out.push({ x: s * CAR.bank, z: +(zb - 0.66).toFixed(3), ry: 0 });         // faces forward, toward the table
      out.push({ x: s * CAR.bank, z: +(zb + 0.66).toFixed(3), ry: Math.PI });   // faces back across the table
    }
  }
  return out;
}

/** A wall panel with rounded window holes (local x along the car, local y up). */
function windowWall(z0, z1, h, holes, r) {
  const s = new THREE.Shape();
  s.moveTo(z0, 0); s.lineTo(z1, 0); s.lineTo(z1, h); s.lineTo(z0, h); s.lineTo(z0, 0);
  for (const [cz, cy, w, hh] of holes) {
    const p = new THREE.Path(), x0 = cz - w / 2, x1 = cz + w / 2, y0 = cy - hh / 2, y1 = cy + hh / 2;
    p.moveTo(x0 + r, y0); p.lineTo(x1 - r, y0); p.quadraticCurveTo(x1, y0, x1, y0 + r); p.lineTo(x1, y1 - r);
    p.quadraticCurveTo(x1, y1, x1 - r, y1); p.lineTo(x0 + r, y1); p.quadraticCurveTo(x0, y1, x0, y1 - r); p.lineTo(x0, y0 + r);
    p.quadraticCurveTo(x0, y0, x0 + r, y0);
    s.holes.push(p);
  }
  return new THREE.ShapeGeometry(s, 6);
}

export function buildTrainCar(opts = {}) {
  return memoSet("train_car", () => makeTrainCar(opts));
}

function makeTrainCar() {
  const g = new THREE.Group();
  g.userData.set = "train_car";
  const B = new Batch();
  const { z0, z1, half } = CAR, L = z1 - z0, zc = (z0 + z1) / 2;
  const WALL = "#d9d6cf", CEIL = "#e6e4de", FLOOR = "#4a4743", TABLE = "#6a5a48";
  B.add(new THREE.BoxGeometry(half * 2, 0.04, L), FLOOR, 0, -0.02, zc, 0, 0, 0, 1, 1, 1, { rough: 0.95 });
  B.add(new THREE.BoxGeometry(0.62, 0.01, L), "#3a3836", 0, 0.004, zc);                       // aisle runner
  const winY = 1.33, winH = 0.84, winW = 1.5, bandY0 = 0.7, bandY1 = 1.95;
  const holes = [];
  for (let i = 0; i < CAR.bays; i++) holes.push([CAR.firstBay + i * CAR.bay, winY - bandY0, winW, winH]);
  // the shell: lower walls, the window band (a panel with rounded holes), the upper wall and ceiling swept as one
  const upperL = [[half, bandY1], [half - 0.03, 2.12], [half - 0.16, 2.3], [0.9, 2.42], [0.45, 2.47], [0, 2.48]];
  const upper = [...upperL, ...upperL.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
  B.addMatrix(sweepProfile(upper, z0, z1, [0, 1.2]), CEIL, new THREE.Matrix4());
  for (const s of [1, -1]) {
    B.addMatrix(sweepProfile([[s * (half - 0.02), 0], [s * half, bandY0]], z0, z1, [0, 1.2]), WALL, new THREE.Matrix4());
    B.add(new THREE.BoxGeometry(0.06, 0.08, L), "#77736c", s * (half - 0.03), 0.68, zc);       // heater / sill trim
    const wall = windowWall(z0, z1, bandY1 - bandY0, holes, 0.16).toNonIndexed();
    const ax = new THREE.Vector3(0, 0, 1), ay = new THREE.Vector3(0, 1, 0);
    const basis = new THREE.Matrix4().makeBasis(ax, ay, new THREE.Vector3().crossVectors(ax, ay));
    if (s < 0) flipFaces(wall);                    // front face into the car (Clay and Depth cull back faces)
    B.addMatrix(wall, WALL, new THREE.Matrix4().makeTranslation(s * half, bandY0, 0).multiply(basis));
    wall.dispose();
    for (const [cz] of holes) {   // window frame: a dark rubber surround and a reveal inside the opening
      for (const [w, h, dy, dz] of [[winW, 0.05, -winH / 2, 0], [winW, 0.05, winH / 2, 0], [0.05, winH, 0, -winW / 2], [0.05, winH, 0, winW / 2]])
        B.add(new THREE.BoxGeometry(0.16, h, w === winW ? w : 0.05), "#2a2c2f", s * (half + 0.07), winY + dy, cz + dz);
    }
    // luggage rack: brackets and rails above the windows
    for (let z = z0 + 0.6; z < z1 - 0.3; z += 1.3) B.add(new THREE.BoxGeometry(0.42, 0.04, 0.04), GRAB, s * (half - 0.22), 1.98, z, 0, 0, s * -0.12);
    for (let k = 0; k < 4; k++) B.add(new THREE.BoxGeometry(0.025, 0.025, L - 0.4), GRAB, s * (half - 0.08 - k * 0.11), 2.0 - k * 0.012, zc);
    B.add(new THREE.BoxGeometry(0.4, 0.02, L - 0.4), "#9fa4a8", s * (half - 0.23), 1.955, zc, 0, 0, 0, 1, 1, 1, { metal: 0.3, rough: 0.5 });
    // tables between facing seats, on a pedestal
    for (const [cz] of holes) {
      B.add(roundedBox(0.8, 0.035, 0.68, 0.015, 1), TABLE, s * (half - 0.43), 0.74, cz);
      B.add(new THREE.BoxGeometry(0.06, 0.7, 0.06), FRAME, s * (half - 0.55), 0.37, cz);
    }
  }
  // vestibule end walls with a door (glazed upper half) each end
  for (const [z, dir] of [[z1, -1], [z0, 1]]) {
    B.add(new THREE.BoxGeometry(half * 2 + 0.1, 2.5, 0.08), WALL, 0, 1.25, z);
    B.add(new THREE.BoxGeometry(0.85, 2.0, 0.03), "#8c9095", 0, 1.0, z + dir * 0.05);
    B.add(new THREE.BoxGeometry(0.55, 0.7, 0.035), "#20262d", 0, 1.45, z + dir * 0.06);
  }
  // bags on the racks
  const br = rng(19);
  for (let i = 0; i < 7; i++) {
    const s = br() < 0.5 ? 1 : -1, z = z0 + 1.5 + br() * (L - 3), h = 0.22 + br() * 0.1;
    B.add(roundedBox(0.32, h, 0.5 + br() * 0.2, 0.05, 1), ["#3b2f27", "#26303a", "#5a3a2a", "#2e2e30"][i % 4], s * (half - 0.25), 1.97 + h / 2, z, 0, br() * 0.3, 0);
  }
  B.build(g);
  const bank = new SeatBank("train_seats", trainSeat, carSlots()).addTo(g);
  // ceiling light strip and a few soft lamps
  const strip = lightish(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, L - 0.6), glow("#fff3df", 0.95, { additive: false })));
  strip.position.set(0, 2.465, zc);
  g.add(strip);
  const fill = new THREE.HemisphereLight(0x8a8780, 0xe0d9cc, 2.6);   // bounce onto the ceiling and the rack undersides
  fill.userData.lightId = "car_fill";
  g.add(fill);
  for (const z of [-7, 0, 7]) {
    const pl = new THREE.PointLight(0xffecd4, 2.6, 8, 1.6);
    pl.position.set(0, 2.2, z); pl.userData.lightId = `car_${z}`;
    g.add(pl);
  }
  // the landscape outside, two tiles streaming aft
  const land = landscapeTile();
  const land2 = land.clone(true);
  g.add(land, land2, skyDome(180, "#6d9bd0", "#dfe8ee", "#9aa77f"));
  const fx = {
    id: "train_car",
    hideGround: true,
    seatBank: bank,
    update(f, stage) {
      const t = f / (stage?.state?.shot?.fps || 24);
      const z = wrap(-t * LAND.speed, LAND.tile);   // the train runs +Z: the land goes past toward the back
      land.position.z = z; land2.position.z = z + (z < 0 ? LAND.tile : -LAND.tile);
      if (stage?.state?.actors) bank.sync(stage.state.actors, f);
    },
    pass(mode, { stage }) { if (mode === "color") stage.scene.fog = LAND_HAZE; },
  };
  fx.update(0, null);
  return { group: g, water: null, fx };
}
const LAND = { tile: 240, speed: 24 };   // 24 m/s ~ 86 km/h
const LAND_HAZE = new THREE.Fog(0xd9e2e8, 60, 192);

/** One 240 m tile of countryside around a track bed 1.25 m below the car floor (both sides). */
function landscapeTile() {
  const g = new THREE.Group();
  const B = new Batch(), r = rng(808), T = LAND.tile, Y = -1.25;
  // ground: a displaced strip each side (fields rolling into hills)
  for (const s of [1, -1]) {
    const geo = new THREE.PlaneGeometry(190, T, 38, 48);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + 98, z = p.getZ(i);
      const zz = ((z / T) * Math.PI * 2);           // periodic in z, so the tiles join
      const hill = Math.max(0, x - 30) / 160;
      const h = 0.8 * Math.sin(zz * 2 + x * 0.05) + hill * (14 * (0.5 + 0.5 * Math.sin(zz + x * 0.02)) + 6 * Math.sin(zz * 3 + 1.3));
      p.setX(i, s * x); p.setY(i, Y + Math.max(-0.3, h * Math.min(1, (x - 4) / 20)));
    }
    if (s < 0) { const ix = geo.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } }
    geo.computeVertexNormals();
    B.addMatrix(geo, s > 0 ? "#6e7f45" : "#74833f", new THREE.Matrix4(), { rough: 1 });
    geo.dispose();
    // the embankment and ballast shoulder close by
    B.add(new THREE.BoxGeometry(3.2, 0.3, T), "#7b7468", s * 2.6, Y - 0.05, 0, 0, 0, 0, 1, 1, 1, { rough: 1 });
    // line-side poles every 40 m (the strongest speed cue), a cable between them
    for (let z = -T / 2; z < T / 2; z += 40) {
      B.add(new THREE.CylinderGeometry(0.1, 0.13, 7, 6), "#4a3d30", s * 4.6, Y + 3.5, z);
      B.add(new THREE.BoxGeometry(1.2, 0.08, 0.08), "#4a3d30", s * 4.6, Y + 6.6, z);
    }
    // hedgerows and trees along field edges; copses further out
    for (let i = 0; i < 46; i++) {
      const x = s * (9 + r() * 70), z = (r() - 0.5) * T, h = 5 + r() * 7;
      B.add(new THREE.CylinderGeometry(0.15, 0.25, h * 0.45, 6), "#4b3a2a", x, Y + h * 0.22, z);
      B.add(new THREE.IcosahedronGeometry(1, 1), r() < 0.5 ? "#3f5a30" : "#4b6634", x, Y + h * 0.62, z, 0, r() * 6, 0, h * 0.32, h * 0.36, h * 0.32);
    }
    for (let k = 0; k < 5; k++) {
      const x0 = s * (16 + k * 14);
      for (let z = -T / 2; z < T / 2; z += 9 + r() * 6) B.add(new THREE.IcosahedronGeometry(1, 1), "#4d6a35", x0, Y + 0.9, z, 0, r() * 6, 0, 2.2 + r(), 1.2 + r() * 0.5, 2.6 + r());
    }
    // a farmhouse and a barn now and then (no signs)
    for (let i = 0; i < 2; i++) {
      const x = s * (45 + r() * 50), z = (r() - 0.5) * T * 0.8;
      B.add(new THREE.BoxGeometry(9, 5, 7), i ? "#b9a88f" : "#8a4a36", x, Y + 2.5, z);
      B.add(new THREE.CylinderGeometry(0.01, 6.2, 3, 4, 1), "#4a4440", x, Y + 6.5, z, 0, Math.PI / 4, 0, 1.05, 1, 0.8);
    }
  }
  B.build(g, { shadows: false });
  g.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });
  return g;
}

// ------------------------------------------------------------------ station platform
export const STATION = { platformTop: 0.92, edgeA: 1.62, backA: 9.4, edgeB: -6.22, backB: -12.5, z0: -70, z1: 95, track2: -4.6 };
/** Height of the walkable surface at (x, z): the platforms, else rail level. */
export function stationFloor(x, z) {
  const S = STATION;
  if (z < S.z0 || z > S.z1) return 0;
  if (x >= S.edgeA && x <= 16) return S.platformTop;
  if (x <= S.edgeB && x >= -18) return S.platformTop;
  return 0;
}

export function buildTrainStation() {
  return memoSet("train_station", () => {
    const g = new THREE.Group();
    g.userData.set = "train_station";
    const B = new Batch(), r = rng(313), S = STATION, PL = S.z1 - S.z0, PZ = (S.z0 + S.z1) / 2;
    const CONC = "#a9a49a", EDGE = "#d7d2c4", BRICK = "#7a4a38", STEEL = "#3e4650";
    // track beds: ballast, sleepers, rails, for both tracks, running well past the platforms
    for (const tx of [0, S.track2]) {
      B.add(new THREE.BoxGeometry(4, 0.36, 380), "#6d665c", tx, -0.42, 40, 0, 0, 0, 1, 1, 1, { rough: 1 });
      for (let z = -150; z < 230; z += 0.65) B.add(new THREE.BoxGeometry(2.5, 0.12, 0.24), "#4f463d", tx, -0.21, z);
      for (const rx of [0.7175, -0.7175]) {
        B.add(new THREE.BoxGeometry(0.07, 0.15, 380), "#8a8d90", tx + rx, -0.075, 40, 0, 0, 0, 1, 1, 1, { metal: 0.6, rough: 0.35 });
      }
    }
    B.add(new THREE.BoxGeometry(60, 0.2, 380), "#5f5a50", -2, -0.62, 40, 0, 0, 0, 1, 1, 1, { rough: 1 });           // ground under it all
    // platform A (+X) and platform B (-X): concrete with a light coping edge, a tactile strip and a painted line
    for (const [e, back, sg] of [[S.edgeA, S.backA + 6.6, 1], [S.edgeB, S.backB - 5.5, -1]]) {
      const w = Math.abs(back - e), cx = (e + back) / 2;
      B.add(new THREE.BoxGeometry(w, S.platformTop + 0.6, PL), CONC, cx, (S.platformTop - 0.6) / 2, PZ);
      B.add(new THREE.BoxGeometry(0.45, 0.04, PL), EDGE, e + sg * 0.22, S.platformTop + 0.01, PZ);                   // coping
      B.add(new THREE.BoxGeometry(0.5, 0.02, PL), "#c7c1ae", e + sg * 0.85, S.platformTop + 0.005, PZ);            // tactile strip
      B.add(new THREE.BoxGeometry(0.1, 0.012, PL), "#e2c34a", e + sg * 1.25, S.platformTop + 0.007, PZ);           // safety line
      B.add(new THREE.BoxGeometry(0.2, S.platformTop + 0.4, PL), "#8c877c", e - sg * 0.05, (S.platformTop - 0.4) / 2, PZ);   // the platform wall face
      // ramps at the ends
      B.add(new THREE.BoxGeometry(w, 0.1, 8), CONC, cx, S.platformTop / 2 - 0.05, S.z0 - 3.6, Math.atan2(S.platformTop, 8), 0, 0);
    }
    // the station building behind platform A: brick, tall arched-top windows (dark), doors, a cornice
    const BX = S.backA + 1.2;
    B.add(new THREE.BoxGeometry(2.4, 9, 70), BRICK, BX, S.platformTop + 4.5, 15);
    for (let z = -16; z <= 46; z += 4.4) {
      B.add(new THREE.BoxGeometry(0.1, 2.6, 1.6), "#1f2328", BX - 1.2, S.platformTop + 2.2, z);
      B.add(new THREE.CylinderGeometry(0.8, 0.8, 0.1, 16, 1, false, 0, Math.PI), "#1f2328", BX - 1.2, S.platformTop + 3.5, z, 0, 0, Math.PI / 2, 1, 1, 1);
      B.add(new THREE.BoxGeometry(0.18, 0.2, 1.9), "#c9bfa9", BX - 1.25, S.platformTop + 0.85, z);                   // sill
      B.add(new THREE.BoxGeometry(0.1, 2.0, 1.6), "#1f2328", BX - 1.2, S.platformTop + 6.3, z);                      // upper floor windows
    }
    B.add(new THREE.BoxGeometry(2.8, 0.5, 70.4), "#c9bfa9", BX, S.platformTop + 8.9, 15);
    B.add(new THREE.BoxGeometry(2.6, 0.3, 70.2), "#c9bfa9", BX, S.platformTop + 4.6, 15);
    // canopy over platform A: columns, roof slab with a deep fascia, hanging lamps, benches and bins
    for (let z = -40; z <= 70; z += 9) {
      B.add(new THREE.CylinderGeometry(0.14, 0.16, 4.6, 10), STEEL, 6.2, S.platformTop + 2.3, z, 0, 0, 0, 1, 1, 1, { metal: 0.5, rough: 0.5 });
      B.add(new THREE.BoxGeometry(5.6, 0.12, 0.14), STEEL, 4.9, S.platformTop + 4.4, z, 0, 0, -0.12);
      B.add(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 5), STEEL, 4.2, S.platformTop + 4.05, z + 4.5);
      if ((z / 9) % 2 === 0) {
        B.add(new THREE.BoxGeometry(0.5, 0.45, 1.8), "#6b4a2f", 7.4, S.platformTop + 0.45, z + 4.5);                  // bench
        B.add(new THREE.BoxGeometry(0.08, 0.5, 1.8), "#6b4a2f", 7.66, S.platformTop + 0.8, z + 4.5, 0, 0, -0.15);
        B.add(new THREE.CylinderGeometry(0.22, 0.2, 0.8, 12), "#2f3a33", 7.6, S.platformTop + 0.4, z + 7.2);           // bin
      }
    }
    B.add(new THREE.BoxGeometry(8.6, 0.2, 116), "#9aa0a5", 5.6, S.platformTop + 4.75, 15, 0, 0, -0.12);
    B.add(new THREE.BoxGeometry(0.12, 0.9, 116), "#e4e1da", 1.45, S.platformTop + 4.75, 15);                          // fascia (plain)
    // platform B: a glazed shelter, a fence and trees behind
    B.add(new THREE.BoxGeometry(2.2, 2.6, 7), "#3e4650", -9.4, S.platformTop + 1.3, 24, 0, 0, 0, 1, 1, 1, { metal: 0.4, rough: 0.4 });
    B.add(new THREE.BoxGeometry(2.6, 0.12, 7.6), "#2d343b", -9.4, S.platformTop + 2.66, 24);
    for (let z = S.z0; z < S.z1; z += 2.5) B.add(new THREE.BoxGeometry(0.06, 1.3, 0.06), STEEL, S.backB - 5.2, S.platformTop + 0.65, z);
    B.add(new THREE.BoxGeometry(0.05, 0.05, PL), STEEL, S.backB - 5.2, S.platformTop + 1.25, PZ);
    for (let i = 0; i < 40; i++) { const z = S.z0 + r() * PL, h = 6 + r() * 6; B.add(new THREE.IcosahedronGeometry(1, 1), "#465f36", S.backB - 9 - r() * 10, S.platformTop + h * 0.6, z, 0, r() * 6, 0, h * 0.35, h * 0.4, h * 0.35); }
    // a footbridge across both tracks
    const FZ = 52, top = 6.4;
    for (const x of [7.5, -10]) B.add(new THREE.BoxGeometry(3, top + 1.6, 3.2), "#8a8f94", x, (S.platformTop + top + 1.6) / 2, FZ);
    B.add(new THREE.BoxGeometry(17.5, 0.5, 2.6), "#8a8f94", -1.25, top + 0.3, FZ);
    B.add(new THREE.BoxGeometry(17.5, 1.3, 0.12), "#6f757b", -1.25, top + 1.15, FZ - 1.25);
    B.add(new THREE.BoxGeometry(17.5, 1.3, 0.12), "#6f757b", -1.25, top + 1.15, FZ + 1.25);
    B.add(new THREE.BoxGeometry(17.5, 0.12, 2.8), "#5a6067", -1.25, top + 2.4, FZ);
    // signal posts at the platform ends (dark heads)
    for (const [x, z] of [[-2.4, S.z1 + 6], [S.track2 - 2.3, S.z0 - 8]]) {
      B.add(new THREE.CylinderGeometry(0.1, 0.12, 4.5, 8), STEEL, x, 2.25, z);
      B.add(new THREE.BoxGeometry(0.5, 1.1, 0.3), "#16191c", x, 4.6, z);
    }
    // the town beyond: plain blocks
    for (let i = 0; i < 22; i++) {
      const x = (i % 2 ? 1 : -1) * (40 + r() * 70), z = -60 + r() * 220, h = 8 + r() * 26;
      B.add(new THREE.BoxGeometry(14 + r() * 12, h, 12 + r() * 10), ["#8e8a82", "#7c7f84", "#9a8f80"][i % 3], x, h / 2 - 0.5, z);
    }
    B.build(g);
    // canopy lamps (warm) and the signal aspects
    for (let z = -35.5; z <= 70; z += 18) {
      const lamp = lightish(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.18), glow("#fff1d6", 1, { additive: false })));
      lamp.position.set(4.2, S.platformTop + 3.73, z); g.add(lamp);
    }
    for (const [x, z, c] of [[-2.4, S.z1 + 6, "#ff3a2a"], [S.track2 - 2.3, S.z0 - 8, "#3aff7a"]]) {
      const a = lightish(new THREE.Mesh(new THREE.CircleGeometry(0.11, 14), glow(c, 1, { additive: false })));
      a.position.set(x, 4.8, z + 0.16 * (z > 0 ? -1 : 1)); a.rotation.y = z > 0 ? Math.PI : 0;
      g.add(a);
    }
    g.add(skyDome(180, "#6d9bd0", "#dfe7ee", "#8d8f86"));
    const fill = new THREE.HemisphereLight(0x9aa4ad, 0xb8b0a0, 2.6);   // bounce off the platforms into the canopy's underside
    fill.userData.lightId = "station_fill";
    g.add(fill);
    return { group: g, water: null, fx: { id: "train_station", hideGround: true, floorAt: stationFloor,
      pass(mode, { stage }) { if (mode === "color") stage.scene.fog = STATION_HAZE; } } };
  });
}
const STATION_HAZE = new THREE.Fog(0xd8dee3, 70, 198);

// ------------------------------------------------------------------ the train (library vehicle "train")
const CARS = 3, LOCO = 20, COACH = 23, GAP = 1.1;
/** Locomotive + three carriages, nose +Z at z = LOCO / 2, rail top y = 0, wheels spin with distance (wheelRig). */
export function buildTrain(mesh, { main = "#d9dcde", accent = "#1f4e79", height = 4.0 } = {}) {
  const g = new THREE.Group();
  const s = height / 4.0;
  const body = new THREE.Group();
  const B = new Batch();
  const wheels = [];
  const axle = (z) => {
    const geo = new THREE.CylinderGeometry(0.46, 0.46, 0.14, 18);
    geo.rotateZ(Math.PI / 2);
    const wb = new Batch();
    wb.add(geo.clone(), "#2a2b2d", 0.72, 0, 0);
    wb.add(geo, "#2a2b2d", -0.72, 0, 0);
    wb.add(new THREE.CylinderGeometry(0.08, 0.08, 1.5, 8), "#3a3b3d", 0, 0, 0, 0, 0, Math.PI / 2);
    wb.add(new THREE.BoxGeometry(0.1, 0.5, 0.1), "#55575a", 0.72, 0, 0);   // a spoke-like web so the spin reads
    wb.add(new THREE.BoxGeometry(0.1, 0.5, 0.1), "#55575a", -0.72, 0, 0);
    const holder = new THREE.Group();
    holder.position.set(0, 0.46, z);
    batchToMeshes(wb, mesh, holder);
    holder.userData.radius = 0.46;
    body.add(holder);
    wheels.push(holder);
  };
  const bogie = (z) => {
    B.add(new THREE.BoxGeometry(2.1, 0.5, 2.9), "#2c2e31", 0, 0.62, z);
    B.add(new THREE.BoxGeometry(0.2, 0.32, 0.5), "#3a3d40", 1.08, 0.5, z);
    B.add(new THREE.BoxGeometry(0.2, 0.32, 0.5), "#3a3d40", -1.08, 0.5, z);
    axle(z - 1.25); axle(z + 1.25);
  };
  // ---- locomotive: an extruded side profile with a raked cab front
  const prof = new THREE.Shape();
  const zf = LOCO / 2, zb = -LOCO / 2;
  prof.moveTo(zb, 1.05); prof.lineTo(zf - 0.4, 1.05); prof.lineTo(zf, 1.35); prof.lineTo(zf, 2.25); prof.lineTo(zf - 1.25, 3.3);
  prof.quadraticCurveTo(zf - 1.9, 3.85, zf - 2.8, 3.88); prof.lineTo(zb, 3.88); prof.lineTo(zb, 1.05);
  const loco = new THREE.ExtrudeGeometry(prof, { depth: 2.86, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 2, curveSegments: 8 });
  loco.rotateY(-Math.PI / 2); loco.translate(1.43, 0, 0);     // shape x -> world z, extrude depth -> world x (centred)
  B.add(loco, main);
  B.add(new THREE.BoxGeometry(2.9, 1.2, 0.12), "#e1b51e", 0, 1.8, zf + 0.04);                           // yellow warning front
  B.add(new THREE.BoxGeometry(2.92, 0.5, 0.1), "#e1b51e", 0, 2.42, zf - 0.12, -0.87, 0, 0);              // ...wrapping onto the rake
  B.add(new THREE.BoxGeometry(2.5, 1.05, 0.08), "#10151b", 0, 2.86, zf - 0.66, -0.87, 0, 0);             // windscreen on the rake
  B.add(new THREE.BoxGeometry(0.06, 1.05, 0.1), "#2a2d31", 0, 2.86, zf - 0.68, -0.87, 0, 0);             // centre pillar
  B.add(new THREE.BoxGeometry(2.6, 0.55, 0.5), "#202224", 0, 0.62, zf - 0.05, 0.35, 0, 0);               // plough / skirt
  B.add(new THREE.BoxGeometry(0.3, 0.3, 0.45), "#3a3c3f", 0, 1.05, zf + 0.25);                           // coupler
  for (const x of [1.46, -1.46]) {
    B.add(new THREE.BoxGeometry(0.06, 0.7, 1.3), "#151a20", x, 2.85, zf - 2.4);                          // cab side window
    B.add(new THREE.BoxGeometry(0.06, 1.9, 0.75), "#b8bcc0", x, 2.1, zf - 3.4);                          // cab door (plain)
    B.add(new THREE.BoxGeometry(0.06, 0.18, LOCO - 4.2), accent, x, 1.7, -1.6);                            // livery band (as the coaches)
    B.add(new THREE.BoxGeometry(0.07, 0.06, LOCO - 1), "#9ca1a6", x, 3.55, -0.5);                            // roof edge trim
    for (let z = zb + 2; z < zf - 5; z += 1.4) B.add(new THREE.BoxGeometry(0.07, 0.9, 0.9), "#5c6268", x, 2.7, z);   // grille panels
  }
  B.add(new THREE.BoxGeometry(2.4, 0.25, 0.3), "#2b2d30", 0, 1.15, zf + 0.15);                            // buffer beam
  B.add(new THREE.BoxGeometry(2.6, 0.5, LOCO - 6), "#2b2d30", 0, 0.88, -1.5);                            // underframe tanks
  bogie(zf - 4.2); bogie(zb + 4.0);
  // ---- carriages
  const coachShape = new THREE.Shape();
  coachShape.moveTo(-1.43, 1.05); coachShape.lineTo(1.43, 1.05); coachShape.lineTo(1.43, 3.05);
  coachShape.quadraticCurveTo(1.38, 3.72, 0, 3.86); coachShape.quadraticCurveTo(-1.38, 3.72, -1.43, 3.05); coachShape.lineTo(-1.43, 1.05);
  let z = zb - GAP;
  for (let c = 0; c < CARS; c++) {
    const cz = z - COACH / 2;
    const geo = new THREE.ExtrudeGeometry(coachShape, { depth: COACH, bevelEnabled: false, curveSegments: 10 });
    geo.translate(0, 0, cz - COACH / 2);
    B.add(geo, main);
    for (const x of [1.44, -1.44]) {
      for (let k = 0; k < 9; k++) B.add(new THREE.BoxGeometry(0.06, 0.8, 1.45), "#18202a", x, 2.35, cz - 7.8 + k * 1.95);   // windows
      for (const dz of [COACH / 2 - 1.3, -COACH / 2 + 1.3]) {
        B.add(new THREE.BoxGeometry(0.065, 2.0, 1.15), "#b9bdc1", x, 2.05, cz + dz);                         // doors
        B.add(new THREE.BoxGeometry(0.07, 0.6, 0.55), "#18202a", x, 2.55, cz + dz);
      }
      B.add(new THREE.BoxGeometry(0.06, 0.18, COACH - 0.4), accent, x, 1.7, cz);                               // livery band
    }
    B.add(new THREE.BoxGeometry(2.5, 0.45, COACH - 8), "#2b2d30", 0, 0.85, cz);                                // underframe boxes
    for (let k = 0; k < 4; k++) B.add(new THREE.BoxGeometry(0.9, 0.18, 0.7), "#9ea3a8", 0, 3.85, cz - 7.5 + k * 5);   // roof vents
    bogie(cz + COACH / 2 - 3.2); bogie(cz - COACH / 2 + 3.2);
    B.add(new THREE.BoxGeometry(2.0, 2.4, GAP + 0.2), "#1e2124", 0, 2.35, z + GAP / 2);                       // gangway bellows
    z -= COACH + GAP;
  }
  batchToMeshes(B, mesh, body);
  // headlights and tail lamps (self-lit dots, no text)
  for (const x of [0.95, -0.95]) {
    const hl = lightish(new THREE.Mesh(new THREE.CircleGeometry(0.13, 14), glow("#fff6dc", 1, { additive: false })));
    hl.position.set(x, 1.65, zf + 0.11); body.add(hl);
    const tl = lightish(new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), glow("#ff2a1a", 1, { additive: false })));
    tl.position.set(x, 1.6, z + GAP - 0.02); tl.rotation.y = Math.PI; body.add(tl);
  }
  body.scale.setScalar(s);
  g.add(body);
  g.userData.limbs = [];
  g.userData.wheelRig = wheels;
  return g;
}
export const TRAIN_LENGTH = LOCO + CARS * (COACH + GAP);
