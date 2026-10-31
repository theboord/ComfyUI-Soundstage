// Airplane sets: an airliner cabin interior (seat rows, aisle, overhead bins, oval windows with clouds streaming past),
// a runway and a sky above the clouds, and the airliner itself as a library vehicle. Clay-simple, merged by colour,
// deterministic per frame. Nothing carries text: no row numbers, no placards, no livery lettering (signs garble in
// AI renders).
//
// Axes: the aircraft's nose points +Z (the stage's forward), +X is its left, the cabin floor is y = 0.
import * as THREE from "../../vendor/three.module.min.mjs";
import { rng, Batch, glow, lightish, memoSet, wrap, skyDome, cloudPuff, batchToMeshes, roundedBox, sweepProfile, flipFaces } from "./common.mjs";
import { SeatBank } from "./seatbank.mjs";

// ------------------------------------------------------------------ the airliner seat row (set dressing + library)
export const PLANE_ROW = { pitch: 0.81, width: 1.5 };
/** Seats of one airliner seat row (library kind plane_seats): local metres, +Z forward, +X = the row's left. */
export const PLANE_SEATS = [
  { name: "Left seat", pos: [0.49, 0.5, -0.02] },
  { name: "Middle seat", pos: [0, 0.5, -0.02] },
  { name: "Right seat", pos: [-0.49, 0.5, -0.02] },
];
const FABRIC = "#27344d", COVER = "#d9d6ce", SHELL = "#b9bdc1", METAL = "#5f6366", ARM = "#8d9296";

/** Three seats on one frame, facing +Z, origin on the floor at the row's centre (adds to a Batch). */
export function planeRow(B) {
  const box = (w, h, d, x, y, z, color, rx = 0) => B.add(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx);
  const soft = (w, h, d, r, x, y, z, color, rx = 0, seg = 1) => B.add(roundedBox(w, h, d, r, seg), color, x, y, z, rx);
  for (const x of [0.49, 0, -0.49]) {
    soft(0.44, 0.12, 0.48, 0.045, x, 0.45, 0.04, FABRIC, 0, 2);          // cushion
    soft(0.44, 0.66, 0.12, 0.05, x, 0.84, -0.24, FABRIC, -0.16, 2);      // back
    soft(0.4, 0.2, 0.12, 0.05, x, 1.1, -0.28, FABRIC, -0.16, 2);         // headrest
    soft(0.34, 0.17, 0.02, 0.008, x, 1.1, -0.215, COVER, -0.16);         // headrest cover (front face)
    soft(0.45, 0.74, 0.04, 0.018, x, 0.81, -0.315, SHELL, -0.16);        // back shell
    soft(0.33, 0.26, 0.015, 0.006, x, 0.86, -0.338, "#9ea3a8", -0.16);   // stowed tray table
    box(0.4, 0.16, 0.04, x, 0.33, 0.27, METAL);                          // seat pan front skirt
  }
  for (const x of [0.735, 0.245, -0.245, -0.735]) {
    soft(0.05, 0.05, 0.44, 0.02, x, 0.66, 0.0, ARM);                     // armrests
    box(0.035, 0.16, 0.04, x, 0.57, 0.17, ARM);
  }
  for (const x of [0.55, -0.55]) {                                       // legs and the floor track feet
    box(0.045, 0.4, 0.045, x, 0.2, 0.18, METAL);
    box(0.045, 0.4, 0.045, x, 0.2, -0.2, METAL);
    box(0.06, 0.035, 0.58, x, 0.02, -0.01, METAL);
  }
  box(1.44, 0.05, 0.05, 0, 0.36, -0.18, METAL);                          // beam
  return B;
}

/** The library seat row (kind plane_seats), built with the stage's mesh(geom, color). */
export function buildPlaneSeats(mesh) {
  const g = new THREE.Group();
  batchToMeshes(planeRow(new Batch()), mesh, g);
  g.userData.limbs = [];
  g.userData.seats = PLANE_SEATS;
  return g;
}

// ------------------------------------------------------------------ cabin
export const CABIN = { z0: -12.4, z1: 13.2, rows: 28, firstRow: -10.6, bank: 1.03, half: 1.84 };
/** Where the cabin's seat rows stand: [{x, z, ry}] (both banks, front to back). Scene setup seats the cast on these. */
export function cabinSlots() {
  const out = [];
  for (let i = 0; i < CABIN.rows; i++) for (const side of [1, -1]) out.push({ x: side * CABIN.bank, z: +(CABIN.firstRow + i * PLANE_ROW.pitch).toFixed(3), ry: 0 });
  return out;
}

/** A thin wall panel with oval window holes: local x = along the cabin (z0..z1), local y = up the panel (0..h). */
function windowPanel(z0, z1, h, holes) {
  const s = new THREE.Shape();
  s.moveTo(z0, 0); s.lineTo(z1, 0); s.lineTo(z1, h); s.lineTo(z0, h); s.lineTo(z0, 0);
  for (const [cz, cy, rx, ry] of holes) {
    const p = new THREE.Path();
    p.absellipse(cz, cy, rx, ry, 0, Math.PI * 2, true, 0);
    s.holes.push(p);
  }
  return new THREE.ShapeGeometry(s, 10);
}
/** An oval ring tube (the window reveal) of depth d along local +Z. */
function ovalReveal(rx, ry, w, d) {
  const s = new THREE.Shape();
  s.absellipse(0, 0, rx + w, ry + w, 0, Math.PI * 2, false, 0);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, rx, ry, 0, Math.PI * 2, true, 0);
  s.holes.push(hole);
  return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 18 });
}

export function buildAirplaneCabin(opts = {}) {
  return memoSet("airplane_cabin", () => makeCabin(opts));
}

// Cross-section of the cabin's left side (x >= 0), floor to the ceiling centre. The window band (bandY0..bandY1,
// leaning in by TILT) is a separate panel with holes; everything else is one swept shell per side, so no gaps.
const BAND = { y0: 0.6, y1: 1.62, tilt: 0.075 };
const WIN = { y: 1.13, rx: 0.135, ry: 0.19 };   // oval window ~27 x 38 cm, centre 1.13 m up (seen over the seat backs)

function makeCabin() {
  const g = new THREE.Group();
  g.userData.set = "airplane_cabin";
  const B = new Batch();
  const { z0, z1, half } = CABIN, L = z1 - z0, zc = (z0 + z1) / 2;
  const WALL = "#dcdcd7", BIN = "#e6e6e1", CEIL = "#efeee9", CARPET = "#384356", AISLE = "#465062";
  const bandTopX = half - (BAND.y1 - BAND.y0) * Math.tan(BAND.tilt);
  B.add(new THREE.BoxGeometry(half * 2 + 0.1, 0.04, L), CARPET, 0, -0.02, zc, 0, 0, 0, 1, 1, 1, { rough: 1 });
  B.add(new THREE.BoxGeometry(0.5, 0.012, L), AISLE, 0, 0.006, zc, 0, 0, 0, 1, 1, 1, { rough: 1 });
  // the shell: lower sidewalls; the upper wall, bins and ceiling as one swept profile across the cabin
  const upperL = [[bandTopX, BAND.y1], [bandTopX - 0.05, 1.68], [1.08, 1.68], [1.02, 1.74], [0.98, 2.04], [0.9, 2.1],
    [0.62, 2.2], [0.3, 2.25], [0, 2.26]];
  const upper = [...upperL, ...upperL.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
  B.addMatrix(sweepProfile(upper, z0, z1, [0, 1.2], { smooth: false }), BIN, new THREE.Matrix4());
  for (const s of [1, -1]) {
    B.addMatrix(sweepProfile([[s * (half - 0.04), 0], [s * (half - 0.01), 0.3], [s * half, BAND.y0]], z0, z1, [0, 1.2]), WALL, new THREE.Matrix4());
    B.add(new THREE.BoxGeometry(0.02, 0.06, L), "#8a8d90", s * (half - 0.035), 0.12, zc);                       // air-return grille
    // the window band: a panel with oval holes, a reveal per window, the outer pane (glass), the shade pulled up
    const winZ = [];
    for (let z = CABIN.firstRow + 0.3; z < z1 - 1.4; z += PLANE_ROW.pitch) winZ.push(+z.toFixed(3));
    const bandH = (BAND.y1 - BAND.y0) / Math.cos(BAND.tilt);
    const panel = windowPanel(z0, z1, bandH, winZ.map((z) => [z, (WIN.y - BAND.y0) / Math.cos(BAND.tilt), WIN.rx + 0.035, WIN.ry + 0.035])).toNonIndexed();
    const ax = new THREE.Vector3(0, 0, 1), ay = new THREE.Vector3(-s * Math.sin(BAND.tilt), Math.cos(BAND.tilt), 0);
    const basis = new THREE.Matrix4().makeBasis(ax, ay, new THREE.Vector3().crossVectors(ax, ay));
    if (s < 0) flipFaces(panel);                       // its front face must look into the cabin (Clay and Depth cull backs)
    B.addMatrix(panel, WALL, new THREE.Matrix4().makeTranslation(s * half, BAND.y0, 0).multiply(basis));
    panel.dispose();
    for (const z of winZ) {
      const xx = s * (half - (WIN.y - BAND.y0) * Math.tan(BAND.tilt));
      const rv = ovalReveal(WIN.rx, WIN.ry, 0.04, 0.2);
      if (s > 0) flipFaces(rv);
      B.addMatrix(rv, "#cfd0cc", new THREE.Matrix4().compose(new THREE.Vector3(xx - s * 0.03, WIN.y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s * Math.PI / 2, 0, "YXZ")), new THREE.Vector3(1, 1, 1)));
      rv.dispose();
      B.add(new THREE.BoxGeometry(0.012, 0.05, WIN.rx * 1.7), "#c4c5c1", xx + s * 0.05, WIN.y + WIN.ry - 0.025, z);   // shade lip
    }
    // the bins' door seams (dark shadow lines) and latch lips over the swept bin face
    for (let z = z0 + 0.1; z < z1 - 0.2; z += 1.62) {
      B.add(new THREE.BoxGeometry(0.03, 0.3, 0.012), "#7c7f82", s * 1.0, 1.89, z, 0, 0, s * 0.13);
      B.add(new THREE.BoxGeometry(0.03, 0.035, 1.0), "#b4b6b5", s * 1.025, 1.77, z + 0.81);
    }
    // passenger-service units under the bins: a light strip of reading-light dots and air vents per row
    for (let i = 0; i < CABIN.rows; i++) {
      const z = CABIN.firstRow + i * PLANE_ROW.pitch + 0.25;
      B.add(new THREE.BoxGeometry(0.52, 0.015, 0.3), "#d0d2d1", s * 1.42, 1.672, z);
      for (const dx of [-0.16, 0, 0.16]) B.add(new THREE.CylinderGeometry(0.025, 0.025, 0.01, 10), "#9a9da0", s * 1.42 + dx, 1.662, z - 0.06);
    }
  }
  // bulkheads: the forward one with a curtained galley opening, the aft one with a lavatory door shape
  for (const [z, dir] of [[z1, -1], [z0, 1]]) {
    B.add(new THREE.BoxGeometry(half * 2 + 0.2, 2.4, 0.08), WALL, 0, 1.2, z);
    B.add(new THREE.BoxGeometry(0.86, 1.95, 0.02), dir < 0 ? "#2f3746" : "#c5c6c2", 0, 0.98, z + dir * 0.05);
    if (dir < 0) for (let i = 0; i < 9; i++) B.add(new THREE.BoxGeometry(0.03, 1.92, 0.03), "#28303d", -0.4 + i * 0.1, 0.98, z + dir * 0.065);
  }
  B.build(g);

  // seat rows: the bank (merged), from which a seat-row object standing on a slot takes its row out
  const bank = new SeatBank("plane_seats", planeRow, cabinSlots()).addTo(g);

  // light: a warm cove strip along each bin top, the overhead fill (bounce off the ceiling), soft cabin lamps
  for (const s of [1, -1]) {
    const strip = lightish(new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.02, L - 0.4), glow("#ffe9c9", 0.95, { additive: false })));
    strip.position.set(s * 0.94, 2.075, zc);
    g.add(strip);
  }
  const fill = new THREE.HemisphereLight(0x8a8780, 0xe8e0d0, 2.6);   // ceilings and bin undersides catch the cabin's bounce
  fill.userData.lightId = "cabin_fill";
  g.add(fill);
  for (const z of [-8, -1.5, 5, 11]) {
    const pl = new THREE.PointLight(0xffe2bf, 1.6, 9, 1.6);
    pl.position.set(0, 2.0, z);
    pl.userData.lightId = `cabin_${z}`;
    g.add(pl);
  }

  // the sky outside: a gradient dome and a cloud deck below, streaming aft (the aircraft flies +Z)
  g.add(skyDome(180, "#4d7fbf", "#c9dcef", "#e8eef4"));
  const CL = new Batch(), cr = rng(404);
  const TILE = 300;
  for (let i = 0; i < 170; i++) {
    const x = (cr() - 0.5) * 380, z = (cr() - 0.5) * TILE;
    if (Math.abs(x) < 30) continue;               // nothing right under the fuselage (never seen; saves fill)
    cloudPuff(CL, i % 3 ? "#f4f6f8" : "#e6eaee", x, -22 - cr() * 6, z, 8 + cr() * 13, cr, CLOUD_MAT);
  }
  const deck = new THREE.Group();
  for (const m of CL.build(deck, { shadows: false })) { m.receiveShadow = false; m.userData.clouds = true; }
  const deck2 = deck.clone(true);
  g.add(deck, deck2);

  const fx = {
    id: "airplane_cabin",
    hideGround: true,
    seatBank: bank,
    update(f, stage) {
      const t = f / (stage?.state?.shot?.fps || 24);
      const z = wrap(-t * 22, TILE);               // 22 m/s apparent drift of a deck ~50 m below: cruise, seen from a seat
      deck.position.z = z; deck2.position.z = z + (z < 0 ? TILE : -TILE);
      if (stage?.state?.actors) bank.sync(stage.state.actors, f);
    },
    pass(mode, { stage }) {
      if (mode === "color") stage.scene.fog = HAZE;
    },
  };
  fx.update(0, null);
  return { group: g, water: null, fx };
}
const HAZE = new THREE.Fog(0xdde7f1, 70, 195);
// Clouds scatter light: matte and softly self-lit, so their shaded sides stay bright instead of turning rock-grey.
const CLOUD_MAT = { rough: 1, emissive: "#c9d3dd", ei: 0.45 };

// ------------------------------------------------------------------ the airliner (library vehicle "airliner")
/** A twin-engine narrow-body airliner, nose +Z, wheels on the ground, ~37.6 m long, fin top 11.8 m. Plain livery. */
export function buildAirliner(mesh, { main = "#eef0f2", accent = "#25406c", height = 11.8 } = {}) {
  const g = new THREE.Group();
  const s = height / 11.8;
  const B = new Batch(), G = new Batch();
  const AX = 3.45;                                   // fuselage axis height
  // fuselage: a lathe along the axis, nose round, tail cone tapering and lifting
  const prof = [];
  const R = 1.98, zN = 17.6, zT = -20.0;
  const rAt = (z) => {
    if (z > 12.2) { const u = (z - 12.2) / (zN - 12.2); return R * Math.sqrt(Math.max(0, 1 - Math.pow(u, 2.1))); }
    if (z < -9.5) { const u = (-9.5 - z) / (-9.5 - zT); return R * (1 - 0.82 * Math.pow(u, 1.25)); }
    return R;
  };
  for (let i = 0; i <= 64; i++) { const z = zT + (zN - zT) * (i / 64); prof.push(new THREE.Vector2(Math.max(0.001, rAt(z)), z)); }
  prof[0].x = 0.001; prof[64].x = 0.001;
  const fus = new THREE.LatheGeometry(prof, 28);
  fus.rotateX(Math.PI / 2); fus.scale(1, 1, 1);
  // tail cone lift: shift vertices up the further aft they are
  { const p = fus.attributes.position; for (let i = 0; i < p.count; i++) { const z = p.getZ(i); if (z < -9.5) p.setY(i, p.getY(i) + 0.95 * Math.pow((-9.5 - z) / 10.5, 1.6)); } fus.computeVertexNormals(); }
  B.add(fus, main, 0, AX, 0);
  // belly fairing and the cheatline-free plain livery: a light-grey belly band
  B.add(new THREE.CylinderGeometry(1.9, 1.9, 21, 24, 1, false, Math.PI * 0.72, Math.PI * 0.56), "#c7cbd0", 0, AX - 0.08, 0.5, Math.PI / 2, 0, 0);
  // windows: a row of small dark ports each side, the cockpit glazing
  for (const x of [1, -1]) {
    for (let z = -12.2; z <= 10.6; z += 0.53) B.add(new THREE.BoxGeometry(0.05, 0.3, 0.21), "#1c232c", x * 1.955, AX + 0.36, z);
    for (const [dz, w] of [[13.9, 0.62], [14.55, 0.58]]) B.add(new THREE.BoxGeometry(0.06, 0.42, w), "#141a21", x * (rAt(dz) - 0.06), AX + 0.78, dz, 0, x * 0.35, 0);
    B.add(new THREE.BoxGeometry(0.06, 1.6, 0.8), "#d9dcdf", x * 1.955, AX - 0.05, 11.6);    // forward door outline (a lighter plate, no text)
    B.add(new THREE.BoxGeometry(0.06, 1.6, 0.8), "#d9dcdf", x * 1.955, AX - 0.05, -11.9);
  }
  B.add(new THREE.BoxGeometry(1.25, 0.32, 0.5), "#141a21", 0, AX + 0.98, 14.95, -0.85, 0, 0);   // windscreen
  // wings: a swept planform, extruded thin, with dihedral; winglets
  const wing = new THREE.Shape();
  wing.moveTo(0, 3.6); wing.lineTo(15.8, -4.6); wing.lineTo(16.4, -6.0); wing.lineTo(0, -3.6); wing.lineTo(0, 3.6);
  for (const x of [1, -1]) {
    const wg = new THREE.ExtrudeGeometry(wing, { depth: 0.34, bevelEnabled: false });
    wg.rotateX(Math.PI / 2);                            // shape XY -> XZ (thickness down)
    wg.translate(0, 0.17, 0);
    if (x < 0) { wg.scale(-1, 1, 1); flipFaces(wg); }
    const dih = new THREE.Matrix4().compose(new THREE.Vector3(x * 1.4, AX - 1.25, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, x * 0.09)), new THREE.Vector3(1, 1, 1));
    B.addMatrix(wg, main, dih); wg.dispose();
    const tipX = x * (1.4 + 16.1 * Math.cos(0.09)), tipY = AX - 1.25 + 16.1 * Math.sin(0.09);
    B.add(new THREE.BoxGeometry(0.12, 2.1, 1.1), accent, tipX, tipY + 1.0, -5.6, -0.35, 0, x * 0.12);   // winglet
    // engine: nacelle, dark intake, exhaust cone, pylon
    const ex = x * 5.75, ey = AX - 2.25, ez = 3.6;
    B.add(new THREE.CylinderGeometry(1.0, 0.86, 4.2, 24, 1, true), main, ex, ey, ez, Math.PI / 2, 0, 0);
    B.add(new THREE.CylinderGeometry(1.0, 1.0, 0.25, 24), accent, ex, ey, ez + 2.0, Math.PI / 2, 0, 0);   // intake lip
    B.add(new THREE.CircleGeometry(0.88, 24), "#16191d", ex, ey, ez + 2.08);                            // fan face
    B.add(new THREE.ConeGeometry(0.55, 1.2, 18), "#8f959b", ex, ey, ez - 2.5, -Math.PI / 2, 0, 0);       // exhaust
    B.add(new THREE.BoxGeometry(0.32, 1.05, 3.4), main, ex, ey + 1.0, ez - 0.6);                         // pylon
  }
  // tail: fin and tailplanes
  const fin = new THREE.Shape();
  fin.moveTo(-12.8, 0); fin.lineTo(-19.6, 0); fin.lineTo(-20.6, 6.7); fin.lineTo(-18.5, 6.7); fin.lineTo(-12.8, 0);
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.3, bevelEnabled: false });
  fg.rotateY(-Math.PI / 2); fg.translate(-0.15, 0, 0);    // shape x -> world z, shape y -> world y
  B.addMatrix(fg, accent, new THREE.Matrix4().makeTranslation(0, AX + 1.55, 0)); fg.dispose();
  const tp = new THREE.Shape();
  tp.moveTo(0, -15.6); tp.lineTo(6.1, -18.9); tp.lineTo(6.2, -19.9); tp.lineTo(0, -19.4); tp.lineTo(0, -15.6);
  for (const x of [1, -1]) {
    const tg = new THREE.ExtrudeGeometry(tp, { depth: 0.2, bevelEnabled: false });
    tg.rotateX(Math.PI / 2); tg.translate(0, 0.1, 0);   // shape y (-15.6..-19.9) -> world z: aft
    if (x < 0) { tg.scale(-1, 1, 1); flipFaces(tg); }
    B.addMatrix(tg, main, new THREE.Matrix4().makeTranslation(x * 0.6, AX + 1.25, 0)); tg.dispose();
  }
  // landing gear (hidden in flight): nose gear and two main bogies
  const gearY = 0.56;
  G.add(new THREE.CylinderGeometry(0.09, 0.09, AX - 1.6, 10), "#8d9399", 0, (AX - 1.6) / 2 + 0.4, 13.2);
  for (const x of [0.22, -0.22]) G.add(new THREE.CylinderGeometry(0.38, 0.38, 0.26, 20), "#1b1b1d", x, 0.38, 13.2, 0, 0, Math.PI / 2);
  for (const x of [3.8, -3.8]) {
    G.add(new THREE.CylinderGeometry(0.14, 0.14, AX - 1.9, 10), "#8d9399", x, (AX - 1.9) / 2 + gearY, -0.6);
    for (const dx of [0.33, -0.33]) G.add(new THREE.CylinderGeometry(gearY, gearY, 0.36, 22), "#1b1b1d", x + dx, gearY, -0.6, 0, 0, Math.PI / 2);
  }
  const body = new THREE.Group();
  batchToMeshes(B, mesh, body);
  const gear = new THREE.Group();
  batchToMeshes(G, mesh, gear);
  gear.userData.gear = true;
  body.add(gear);
  // the Batch built wings/fin at the right side of 0; flip X for all: +X is the aircraft's left (consistent anyway)
  body.scale.setScalar(s);
  g.add(body);
  g.userData.limbs = [];
  g.userData.gear = gear;
  return g;
}
// ------------------------------------------------------------------ runway and sky sets
/** A runway at an airport: asphalt with plain white markings (no numbers), grass, edge lights, distant hangars. */
export function buildRunway() {
  return memoSet("runway", () => {
    const g = new THREE.Group();
    g.userData.set = "runway";
    const B = new Batch(), r = rng(61);
    const RW = 45, RL = 380, ZC = 60;
    B.add(new THREE.BoxGeometry(400, 0.02, 400), "#6f7a4f", 0, -0.012, ZC, 0, 0, 0, 1, 1, 1, { rough: 1 });          // grass
    B.add(new THREE.BoxGeometry(RW, 0.02, RL), "#3b3d40", 0, 0.004, ZC, 0, 0, 0, 1, 1, 1, { rough: 0.9 });            // runway
    B.add(new THREE.BoxGeometry(23, 0.02, 160), "#424448", -62, 0.004, ZC + 40);                                      // taxiway
    for (let i = 0; i < 3; i++) B.add(new THREE.BoxGeometry(20, 0.021, 23), "#424448", -33, 0.004, ZC - 20 + i * 70, 0, 0.35, 0);   // links
    B.add(new THREE.BoxGeometry(110, 0.02, 90), "#55585c", -125, 0.003, ZC + 50);                                    // apron
    const paint = (w, d, x, z, color = "#e9e9e4") => B.add(new THREE.BoxGeometry(w, 0.012, d), color, x, 0.018, z);
    for (let z = ZC - RL / 2 + 70; z < ZC + RL / 2 - 20; z += 50) paint(0.9, 30, 0, z);                              // centreline dashes
    for (const x of [RW / 2 - 1.2, -RW / 2 + 1.2]) paint(0.9, RL - 6, x, ZC);                                         // edge lines
    for (let i = 0; i < 8; i++) for (const sd of [1, -1]) paint(1.8, 30, sd * (3.2 + i * 2.6), ZC - RL / 2 + 22);     // threshold bars
    for (const sd of [1, -1]) paint(6, 45, sd * 9.5, ZC - RL / 2 + 120);                                              // aiming point
    for (const x of [RW / 2 + 1.5, -RW / 2 - 1.5]) for (let z = ZC - RL / 2; z <= ZC + RL / 2; z += 30) {
      B.add(new THREE.CylinderGeometry(0.06, 0.08, 0.35, 6), "#cfcfcf", x, 0.17, z);
    }
    paint(1.5, 160, -62, ZC + 40, "#d7b23a");                                                                        // taxiway line (yellow)
    // hangars and a control tower far off; terminal blocks
    for (let i = 0; i < 4; i++) {
      const x = -150 - r() * 20, z = ZC + 10 + i * 34;
      B.add(new THREE.BoxGeometry(34, 14, 30), "#a9adb1", x, 7, z);
      B.add(new THREE.CylinderGeometry(15.5, 15.5, 30, 16, 1, false, -Math.PI / 2, Math.PI), "#9aa0a5", x, 14, z, Math.PI / 2, 0, Math.PI / 2, 1, 1, 0.38);
    }
    B.add(new THREE.CylinderGeometry(2.4, 3.2, 34, 12), "#c7c9c6", -118, 17, ZC + 120);
    B.add(new THREE.CylinderGeometry(5.4, 4.2, 4.5, 12), "#2d3742", -118, 36, ZC + 120);
    B.add(new THREE.CylinderGeometry(5.8, 5.8, 0.6, 12), "#c7c9c6", -118, 38.5, ZC + 120);
    B.add(new THREE.BoxGeometry(70, 12, 26), "#bfc3c6", -150, 6, ZC + 175);
    B.add(new THREE.BoxGeometry(70, 2.5, 18), "#2f3a45", -150, 8, ZC + 161.5);
    // distant tree line and low hills on the other side
    for (let i = 0; i < 60; i++) { const z = -120 + i * 7 + r() * 4, h = 6 + r() * 6; B.add(new THREE.ConeGeometry(2.4 + r(), h, 7), "#4c5e3b", 120 + r() * 30, h / 2, z); }
    B.build(g);
    g.add(skyDome(180, "#6f9fd6", "#dbe6ee", "#9aa584"));
    return { group: g, water: null, fx: { id: "runway", hideGround: true, pass(mode, { stage }) { if (mode === "color") stage.scene.fog = RUNWAY_HAZE; } } };
  });
}
const RUNWAY_HAZE = new THREE.Fog(0xd6e0e8, 80, 198);

/** Above the clouds: a cloud sea below cruise altitude (the stage floor is in the air), sun and sky. */
export function buildAboveClouds() {
  return memoSet("above_clouds", () => {
    const g = new THREE.Group();
    g.userData.set = "above_clouds";
    const B = new Batch(), r = rng(777);
    for (let i = 0; i < 420; i++) {
      const a = r() * Math.PI * 2, d = 12 + Math.sqrt(r()) * 180;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      cloudPuff(B, i % 4 ? "#f5f7f9" : "#e3e8ee", x, -24 - r() * 5 + (d > 120 ? -4 : 0), z, 6 + r() * 10 + d * 0.04, r, CLOUD_MAT, d < 90 ? 2 : 1);
    }
    B.add(new THREE.CircleGeometry(200, 48), "#dfe5ec", 0, -27, 0, -Math.PI / 2, 0, 0, 1, 1, 1, CLOUD_MAT);   // the deck's floor
    const meshes = B.build(g, { shadows: false });
    for (const m of meshes) { m.userData.clouds = true; m.receiveShadow = false; }
    g.add(skyDome(180, "#3d70b6", "#d4e3f1", "#eef2f6"));
    const fx = {
      id: "above_clouds",
      hideGround: true,
      update(f, stage) {   // aircraft fly with their gear up
        if (!stage?.actorMeshes) return;
        for (const a of stage.state.actors || []) if (a.kind === "airliner") { const gm = stage.actorMeshes.get(a.id); if (gm?.userData.gear) gm.userData.gear.visible = false; }
      },
      pass(mode, { stage }) { if (mode === "color") stage.scene.fog = CLOUD_HAZE; },
    };
    return { group: g, water: null, fx };
  });
}
const CLOUD_HAZE = new THREE.Fog(0xe2eaf2, 90, 198);
