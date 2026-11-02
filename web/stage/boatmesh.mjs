// Watercraft clay: every hull is lofted from the same stations the physics floats (boatsim.mjs HULLS), so the
// silhouette, the waterline and the freeboard are the real ones. Then the boat's own parts: console and windscreen,
// wheelhouse, outboard (tilts with the motor trim, swings with the steering), rudder, mast, boom and sails (the boom
// swings on its gooseneck, the sail bellies to leeward and luffs), thwarts and seats, paddles and oars (posed per frame
// from the stroke phase so the people pull them), raft tubes and log lashings, and the lamps the Parts panel lights.
//
// Local frame as every library object: +Z forward, +X the boat's left, +Y up, origin on the keel's lowest point at
// midship. Built at the hull's own size, then scaled by k = height / library height.
import * as THREE from "../vendor/three.module.min.mjs";
import { HULLS, station, bottomAt } from "./boatsim.mjs";

const D2R = Math.PI / 180;

/** The hull skin as one BufferGeometry: sheer to sheer through the bottom at each station, plus a transom panel. */
export function hullGeometry(H, { nu = 30, nv = 16 } = {}) {
  const pos = [], idx = [];
  const ring = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu, st = station(H, u), x = (u - 0.5) * H.L;
    const row = [];
    const b = Math.max(st.b, 0.002);
    // left sheer (a little flare: the sheer is the widest), then the bottom from +0.97b to -0.97b, then right sheer.
    const pts = [[b, st.zs]];
    for (let j = 0; j <= nv; j++) {
      const y = b * (H.section === "vee" ? 0.88 : 0.93) * (1 - (2 * j) / nv);   // the topsides flare out to the sheer
      pts.push([y, bottomAt(H, { ...st, b }, y)]);
    }
    pts.push([-b, st.zs]);
    for (const [y, z] of pts) { row.push(pos.length / 3); pos.push(y, z, x); }
    ring.push(row);
  }
  const m = ring[0].length;
  for (let i = 0; i < nu; i++) for (let j = 0; j < m - 1; j++) {
    const a = ring[i][j], b = ring[i + 1][j], c = ring[i + 1][j + 1], d = ring[i][j + 1];
    idx.push(a, b, c, a, c, d);
  }
  // Transom (and a log raft's or raft's square-ish ends): close the stern with a fan.
  if (station(H, 0).b > 0.05) {
    const c0 = pos.length / 3, st = station(H, 0);
    pos.push(0, st.zs * 0.95, -H.L / 2);
    for (let j = 0; j < m - 1; j++) idx.push(c0, ring[0][j + 1], ring[0][j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A sail: a triangle (luff, foot, leech) as a cambered grid, so it can belly out and flutter. */
export function sailGeometry(luff, foot, { rows = 10, cols = 6, roach = 0.08 } = {}) {
  const g = new THREE.PlaneGeometry(1, 1, cols, rows);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const a = P.getX(i) + 0.5, h = P.getY(i) + 0.5;       // a: 0 luff .. 1 leech, h: 0 foot .. 1 head
    const chord = foot * (1 - h) * (1 + roach * Math.sin(Math.PI * h));
    P.setXYZ(i, 0, h * luff, -a * chord);
  }
  g.computeVertexNormals();
  g.userData.base = Float32Array.from(P.array);
  g.userData.luff = luff; g.userData.foot = foot;
  return g;
}

/** Bend a sail grid: camber (belly to leeward, m per m of chord) and a luffing flutter (0..1) at time t. */
export function shapeSail(geom, camber, side, luff = 0, t = 0) {
  const P = geom.attributes.position, B = geom.userData.base;
  for (let i = 0; i < P.count; i++) {
    const y = B[i * 3 + 1], z = B[i * 3 + 2];
    const h = y / geom.userData.luff, chord = Math.max(1e-3, geom.userData.foot * (1 - h) * 1.1);
    const a = Math.min(1, -z / chord);
    // A sail's draft sits ~40 % back: camber as a sin² hump over the chord; the luff flutters near the leading edge.
    let x = side * camber * chord * Math.sin(Math.PI * Math.pow(a, 0.85)) ** 1.0;
    if (luff > 0.02) x += luff * 0.06 * chord * Math.sin(18 * t - 9 * a + 5 * h) * Math.sin(Math.PI * a) * (1 - 0.5 * h);
    P.setX(i, x);
  }
  P.needsUpdate = true;
  geom.computeVertexNormals();
}

const tube = (mesh, r1, r2, a, b, color, seg = 10) => {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b), len = A.distanceTo(Bv);
  const m = mesh(new THREE.CylinderGeometry(r2, r1, len, seg), color);
  m.position.copy(A).add(Bv).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), Bv.clone().sub(A).normalize());
  return m;
};

/** A paddle / oar group with its shaft along -Y from the origin (the top grip or the oarlock): its parts for the poser. */
function paddleGroup(mesh, style, color, blade) {
  const g = new THREE.Group();
  if (style === "kayak") {
    // A 2.2 m double paddle, shaft along X (centred), feathered blades at both ends.
    g.add(tube(mesh, 0.016, 0.016, [-1.05, 0, 0], [1.05, 0, 0], color));
    for (const s of [-1, 1]) { const b = mesh(new THREE.BoxGeometry(0.42, 0.012, 0.17), blade); b.position.set(s * 1.0, 0, 0); b.rotation.x = s * 0.35; g.add(b); }
    g.userData.len = 2.1;
  } else if (style === "row") {
    // An oar: the origin at the oarlock pin; inboard to the handle along -X... the poser turns it. Loom along +Y here:
    // handle at +0.82, blade at -1.55.
    g.add(tube(mesh, 0.022, 0.018, [0, 0.82, 0], [0, -1.35, 0], color));
    const b = mesh(new THREE.BoxGeometry(0.16, 0.48, 0.014), blade); b.position.set(0, -1.55, 0); g.add(b);
    g.add(tube(mesh, 0.02, 0.02, [0, 0.82, 0], [0, 0.96, 0], "#3b2c20"));
    g.userData.inboard = 0.86; g.userData.outboard = 1.6;
  } else if (style === "pole") {
    g.add(tube(mesh, 0.025, 0.022, [0, 0.3, 0], [0, -3.4, 0], color));
    g.userData.len = 3.7;
  } else {
    // A single-blade canoe / raft paddle, 1.45 m: T-grip at the origin, shaft down -Y, blade at the end.
    g.add(tube(mesh, 0.016, 0.017, [0, 0, 0], [0, -0.92, 0], color));
    const grip = mesh(new THREE.BoxGeometry(0.11, 0.03, 0.035), color); grip.position.set(0, 0.01, 0); g.add(grip);
    const b = mesh(new THREE.BoxGeometry(0.2, 0.55, 0.014), blade); b.position.set(0, -1.18, 0); g.add(b);
    g.userData.len = 1.45;
  }
  g.userData.style = style;
  return g;
}

/** Seat positions (local, metres at the hull's size) for a kind: from the hull's paddlers / helm. */
export function seatPositions(kind) {
  const H = HULLS[kind];
  if (!H) return [];
  const st = (x) => station(H, x / H.L + 0.5);
  switch (kind) {
    case "speedboat": return [[-0.5, 0.62, 0.25], [0.5, 0.62, 0.25], [0.55, 0.6, -1.7], [0, 0.6, -1.75], [-0.55, 0.6, -1.7]];
    case "fishing_boat": return [[0.45, 1.25, -0.6], [-0.45, 1.25, -0.6], [0.7, 1.0, -2.6], [-0.7, 1.0, -2.6]];
    case "dinghy": return [[0, 0.33, -0.95], [0, 0.33, -0.3]];
    case "yacht": return [[0, 1.1, -4.05], [0.75, 1.0, -3.1], [-0.75, 1.0, -3.1], [0.7, 1.0, -2.3], [-0.7, 1.0, -2.3], [0, 1.6, 2.6]];
    case "kayak": return [[0, 0.1, -0.15]];
    default: return (H.paddlers || []).map((p) => {
      const s = st(p.x);
      const y = p.guide || p.side === 0 ? 0 : p.side * (H.drive === "raft" ? s.b - (H.tubeR || 0.25) * 0.9 : Math.min(0.18, s.b * 0.25));
      const z = H.drive === "raft" ? 0.45 : H.drive === "pole" ? H.D : kind === "canoe" ? 0.24 : kind === "rowboat" ? 0.33 : 0.2;
      return [y, z, p.x];
    }).concat(kind === "rowboat" ? [[0, 0.33, -1.25], [0, 0.4, 1.2]] : kind === "log_raft" ? [[0.5, H.D, 0.6]] : []);
  }
}

/**
 * Build a watercraft. mesh(geom, color) -> a clay mesh; colors {main, accent, deck}. Returns a Group whose
 * userData.boat holds the moving parts for the poser: {motor, rudder, rig: [{id, pivot, sail, geom}], paddles:
 * [{seat, group, style, base}], lamps: {nav_l, nav_r, stern, mast, anchor, deck, head}, hull, waterline}.
 */
export function buildBoat(kind, mesh, { main = "#f2f0ea", accent = "#1f3b5c", deck = "#d8d2c4" } = {}) {
  const H = HULLS[kind];
  const g = new THREE.Group();
  g.userData.limbs = [];
  const R = (g.userData.boat = { kind, paddles: [], rig: [], lamps: {} });
  const add = (o, x = 0, y = 0, z = 0) => { o.position.set(x, y, z); g.add(o); return o; };
  const box = (w, h, d, x, y, z, color = accent, rx = 0, ry = 0, rz = 0) => { const m = mesh(new THREE.BoxGeometry(w, h, d), color); m.rotation.set(rx, ry, rz); return add(m, x, y, z); };
  const cyl = (r1, r2, h, x, y, z, color = accent, rx = 0, ry = 0, rz = 0) => { const m = mesh(new THREE.CylinderGeometry(r1, r2, h, 14), color); m.rotation.set(rx, ry, rz); return add(m, x, y, z); };
  const st = (x) => station(H, x / H.L + 0.5);
  const wood = "#8a6a44", metal = "#9aa1a8", dark = "#2b2d31", sailCol = "#f3f1ea", blade = "#e2a23a";

  // ---- the hull (tubes and logs are their own shapes)
  if (H.section === "tube") {
    // A self-bailing raft: a tube ring around the plan form, two cross tubes (thwarts), a floor.
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2, u = 0.5 + 0.5 * Math.cos(a), s = station(H, u);
      const R0 = H.tubeR;
      pts.push(new THREE.Vector3(Math.sin(a) >= 0 ? s.b - R0 : -(s.b - R0), R0 + s.zk, (u - 0.5) * (H.L - 2 * R0)));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    R.hull = add(mesh(new THREE.TubeGeometry(curve, 96, H.tubeR, 14, true), main));
    for (const x of [0.65, -0.45]) { const s = st(x); g.add(tube(mesh, H.tubeR * 0.75, H.tubeR * 0.75, [s.b - H.tubeR, H.tubeR * 0.9, x], [-(s.b - H.tubeR), H.tubeR * 0.9, x], main, 12)); }
    box(H.B - 2 * H.tubeR, 0.06, H.L - 2 * H.tubeR - 0.3, 0, 0.05, 0, accent);
    // the perimeter grab line
    const line = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x * 1.02, p.y + H.tubeR * 0.55, p.z * 1.01)), true);
    add(mesh(new THREE.TubeGeometry(line, 96, 0.008, 5, true), dark));
  } else if (H.section === "logs") {
    const n = H.logs, r = H.logR, w = H.B / n, raft = new THREE.Group();
    for (let i = 0; i < n; i++) {
      const y = -H.B / 2 + w * (i + 0.5), len = H.L * (0.92 + 0.08 * Math.sin(i * 2.3));
      const lg = mesh(new THREE.CylinderGeometry(r * (0.92 + 0.1 * Math.cos(i * 1.7)), r, len, 14), i % 2 ? "#7a5b3a" : "#8a6845");
      lg.rotation.x = Math.PI / 2; lg.position.set(y, r, Math.sin(i * 3.1) * 0.08); lg.userData.log = true;
      raft.add(lg);
    }
    g.add(raft);
    for (const x of [-H.L * 0.36, 0, H.L * 0.36]) { box(H.B * 1.04, 0.09, 0.12, 0, 2 * r + 0.03, x, "#6a4e32"); for (let i = 0; i < n; i += 2) box(0.03, 0.05, 0.16, -H.B / 2 + w * (i + 0.5), 2 * r + 0.02, x, "#b8a27a"); }
    R.hull = raft;
  } else {
    R.hull = add(mesh(hullGeometry(H), main));
    R.hull.userData.hullSkin = true;
    // A rubbing strake along the sheer.
    const sheer = [];
    for (let i = 0; i <= 30; i++) { const u = i / 30, s = station(H, u); sheer.push(new THREE.Vector3(s.b + 0.01, s.zs - 0.02, (u - 0.5) * H.L)); }
    for (const sx of [1, -1]) add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sheer.map((p) => new THREE.Vector3(p.x * sx, p.y, p.z))), 40, Math.max(0.012, H.D * 0.025), 5), accent));
  }

  // ---- per kind: decks, cabins, rigs, seats, propulsion
  const sp = seatPositions(kind);
  if (kind === "speedboat") {
    const D = H.D;
    // Bow deck over the front 35 %, cockpit sole, side decks, a console with a raked windscreen, bench seats, an outboard.
    const bowDeck = new THREE.Shape();
    const xs = [];
    for (let i = 0; i <= 12; i++) { const x = H.L * 0.1 + (i / 12) * (H.L * 0.4 - 0.05); xs.push([x, st(x).b * 0.97]); }
    bowDeck.moveTo(-xs[0][1], xs[0][0]);
    for (const [x, b] of xs) bowDeck.lineTo(-b, x);
    for (const [x, b] of [...xs].reverse()) bowDeck.lineTo(b, x);
    const bd = mesh(new THREE.ShapeGeometry(bowDeck), deck); bd.rotation.x = Math.PI / 2; bd.position.y = D + 0.03; g.add(bd);
    bd.material = bd.material.clone(); bd.material.side = THREE.DoubleSide;
    box(st(0).b * 1.75, 0.04, H.L * 0.58, 0, D * 0.42, -H.L * 0.18, deck);                                  // cockpit sole
    for (const sx of [1, -1]) box(0.16, 0.05, H.L * 0.6, sx * (st(-0.5).b - 0.08), D + 0.02, -H.L * 0.2, deck);   // side decks
    // Console (starboard helm) and windscreen across the cockpit front.
    box(0.62, 0.62, 0.55, -0.5, D * 0.42 + 0.31, 0.95, deck);
    box(0.5, 0.05, 0.35, -0.5, D * 0.42 + 0.66, 0.92, dark, -0.5);
    const ws = new THREE.Mesh(new THREE.BoxGeometry(st(1.1).b * 1.8, 0.42, 0.02));
    ws.material = new THREE.MeshStandardMaterial({ color: 0xd4e4ee, roughness: 0.08, transparent: true, opacity: 0.25, depthWrite: false });
    ws.material.allowOverride = false; ws.userData.glass = true; ws.castShadow = false;
    ws.rotation.x = -0.55; add(ws, 0, D + 0.2, 1.22);
    box(st(1.1).b * 1.8, 0.03, 0.03, 0, D + 0.4, 1.12, metal);
    cyl(0.17, 0.17, 0.03, -0.5, D * 0.42 + 0.78, 0.68, dark, -1.0);                                       // wheel
    for (const z of [0.25, -1.75]) box(st(z).b * 1.7, 0.18, 0.55, 0, D * 0.42 + 0.12, z - 0.05, "#c9c2b2");   // seats
    box(st(0.25).b * 1.7, 0.45, 0.12, 0, D * 0.42 + 0.4, 0.0 - 0.1, "#c9c2b2");
    // The outboard on the transom: a pivot at the clamp bracket (trim tilts it about X, steering swings it about Y).
    const motor = new THREE.Group(); motor.position.set(0, D * 0.92, -H.L / 2 - 0.08);
    const steerP = new THREE.Group(); motor.add(steerP);
    // The powerhead cowl: a tall rounded box (a 200 hp V6 cowl is ~0.45 m wide, 0.7 m long, 0.6 m tall), wider at the
    // top and tapering aft, on a narrower midsection (the exhaust housing) down to the leg.
    const cowlG = new THREE.BoxGeometry(0.44, 0.5, 0.68, 2, 3, 3);
    { const P = cowlG.attributes.position;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i), up = (y + 0.25) / 0.5, aft = (0.34 - z) / 0.68;
        P.setX(i, x * (0.82 + 0.18 * up) * (1 - 0.18 * aft));
        P.setY(i, y + (up > 0.99 ? -0.06 * (Math.abs(z) / 0.34) ** 2 - 0.04 * (Math.abs(x) / 0.22) ** 2 : 0));
      }
      cowlG.computeVertexNormals(); }
    const cowl = mesh(cowlG, dark); cowl.position.set(0, 0.32, -0.22); steerP.add(cowl);
    const mid = mesh(new THREE.BoxGeometry(0.26, 0.2, 0.34), dark); mid.position.set(0, 0.0, -0.16); steerP.add(mid);
    const leg = mesh(new THREE.BoxGeometry(0.14, 0.95, 0.24), dark); leg.position.set(0, -0.45, -0.12); steerP.add(leg);
    const cav = mesh(new THREE.BoxGeometry(0.3, 0.03, 0.42), dark); cav.position.set(0, -0.82, -0.12); steerP.add(cav);
    const prop = new THREE.Group(); prop.position.set(0, -0.95, -0.28); steerP.add(prop);
    for (let i = 0; i < 3; i++) { const b = mesh(new THREE.BoxGeometry(0.03, 0.17, 0.07), metal); b.position.y = 0.08; const pv = new THREE.Group(); pv.rotation.z = (i * 2 * Math.PI) / 3; pv.add(b); prop.add(pv); }
    g.add(motor);
    R.motor = { pivot: motor, steer: steerP, prop };
    R.lamps.nav_l = [0.35, D + 0.06, H.L / 2 - 0.25]; R.lamps.nav_r = [-0.35, D + 0.06, H.L / 2 - 0.25];
    R.lamps.stern = [0, D + 0.95, -H.L / 2 + 0.3];
    cyl(0.012, 0.012, 0.9, 0, D + 0.5, -H.L / 2 + 0.3, metal);                                             // the stern light pole
  } else if (kind === "fishing_boat") {
    const D = H.D;
    box(st(0).b * 1.85, 0.05, H.L * 0.9, 0, D * 0.55, -H.L * 0.04, deck);                                   // deck
    // Wheelhouse amidships-forward, a trunk cabin ahead of it, a mast with work lights, a rail, a stern gantry.
    box(st(0.6).b * 1.6, 1.15, 2.1, 0, D * 0.55 + 0.6, 0.6, main);
    box(st(0.6).b * 1.66, 0.08, 2.3, 0, D * 0.55 + 1.2, 0.6, accent);
    const wgl = new THREE.MeshStandardMaterial({ color: 0xd4e4ee, roughness: 0.08, transparent: true, opacity: 0.25, depthWrite: false }); wgl.allowOverride = false;
    for (const [w, x, z, ry] of [[st(1.6).b * 1.5, 0, 1.66, 0], [1.4, st(0.6).b * 0.81, 0.6, Math.PI / 2], [1.4, -st(0.6).b * 0.81, 0.6, Math.PI / 2]]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.45), wgl); p.userData.glass = true; p.rotation.y = ry; add(p, x, D * 0.55 + 0.95, z);
    }
    box(st(2.4).b * 1.4, 0.5, 1.6, 0, D * 0.55 + 0.25, 2.45, main);
    cyl(0.04, 0.05, 2.4, 0, D * 0.55 + 2.4, 0.3, metal);
    box(1.0, 0.05, 0.05, 0, D * 0.55 + 3.1, 0.3, metal);
    for (const sx of [1, -1]) for (let z = -3.6; z < 3.2; z += 0.9) cyl(0.012, 0.012, 0.5, sx * st(z).b * 0.95, D + 0.25, z, metal);
    box(0.06, 1.6, 0.06, 0.9, D * 0.55 + 0.8, -3.7, metal); box(0.06, 1.6, 0.06, -0.9, D * 0.55 + 0.8, -3.7, metal); box(1.86, 0.06, 0.06, 0, D * 0.55 + 1.6, -3.7, metal);
    for (const x of [0.7, -0.7]) box(0.5, 0.45, 0.6, x, D * 0.55 + 0.25, -2.6, "#3f6f8a");                // fish boxes
    const rud = new THREE.Group(); rud.position.set(0, 0.25, -H.L / 2 + 0.25);
    const rb = mesh(new THREE.BoxGeometry(0.04, 0.6, 0.45), dark); rb.position.set(0, -0.25, -0.2); rud.add(rb); g.add(rud);
    R.rudder = rud;
    R.lamps.nav_l = [st(0.6).b * 0.84, D * 0.55 + 1.0, 1.0]; R.lamps.nav_r = [-st(0.6).b * 0.84, D * 0.55 + 1.0, 1.0];
    R.lamps.mast = [0, D * 0.55 + 3.5, 0.3]; R.lamps.deck = [0, D * 0.55 + 3.05, 0.0]; R.lamps.stern = [0, D * 0.55 + 1.62, -3.7];
  } else if (kind === "dinghy" || kind === "yacht") {
    const D = H.D;
    // Deck (flush on a dinghy with a small cockpit; a yacht's coachroof and cockpit), mast, boom, sails, rudder, foil.
    if (kind === "dinghy") {
      box(st(0.4).b * 1.9, 0.03, H.L * 0.55, 0, D + 0.01, 0.55, deck);
      box(0.7, 0.03, 1.2, 0, D * 0.55, -0.9, deck);
    } else {
      box(st(0).b * 1.9, 0.05, H.L * 0.92, 0, D - 0.02, 0, deck);
      box(st(0.6).b * 1.15, 0.42, 3.2, 0, D + 0.2, 0.6, main);                                              // coachroof
      const wgl = new THREE.MeshStandardMaterial({ color: 0x2a3a48, roughness: 0.1, transparent: true, opacity: 0.6, depthWrite: false }); wgl.allowOverride = false;
      for (const sx of [1, -1]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.14), wgl); p.userData.glass = true; p.rotation.y = sx * Math.PI / 2; add(p, sx * st(0.6).b * 0.58, D + 0.24, 0.6); }
      box(st(-3).b * 1.3, 0.5, 2.4, 0, D - 0.15, -3.1, "#c9c2b2");                                           // cockpit well
      for (const sx of [1, -1]) for (let z = -4.2; z <= 3.4; z += 1.2) cyl(0.012, 0.012, 0.6, sx * st(z).b * 0.93, D + 0.3, z, metal);
      cyl(0.32, 0.32, 0.03, 0, D + 0.55, -4.0, metal, Math.PI / 2 - 0.2);                                   // the wheel
      // The fin keel with its lead bulb and the spade rudder, below the canoe body.
      box(0.12, 1.25, 1.1, 0, -0.62, -0.35, dark);
      cyl(0.17, 0.17, 1.2, 0, -1.3, -0.4, dark, Math.PI / 2);
    }
    const s0 = H.sails[0];
    const mast = cyl(kind === "yacht" ? 0.07 : 0.035, kind === "yacht" ? 0.09 : 0.04, s0.mastH, 0, D + s0.mastH / 2, s0.tack, "#c7ccd1");
    mast.userData.mast = true;
    // Shrouds and forestay as thin lines.
    if (kind === "yacht") for (const [a, b] of [[[st(0.9).b * 0.95, D, 0.9], [0, D + s0.mastH * 0.97, 0.9]], [[-st(0.9).b * 0.95, D, 0.9], [0, D + s0.mastH * 0.97, 0.9]], [[0, D + 0.1, H.L / 2 - 0.15], [0, D + H.sails[1].mastH, 0.9]], [[0, D + 0.3, -H.L / 2 + 0.3], [0, D + s0.mastH, 0.9]]])
      g.add(tube(mesh, 0.006, 0.006, a, b, metal, 4));
    for (const s of H.sails) {
      const pivot = new THREE.Group();
      const isJib = s.id === "jib";
      pivot.position.set(0, D + (isJib ? 0.15 : 0.6), isJib ? H.L / 2 - 0.3 : s.tack);
      g.add(pivot);
      const luff = isJib ? s.mastH * 0.92 : s.mastH - 0.85, foot = isJib ? s.foot : s.boomLen;
      const geom = sailGeometry(luff, foot, { roach: isJib ? 0.0 : 0.1 });
      const sail = mesh(geom, sailCol);
      sail.material = sail.material.clone(); sail.material.side = THREE.DoubleSide;
      if (isJib) { sail.rotation.x = Math.atan2(H.L / 2 - 0.3 - 0.9, s.mastH) * -1; }
      pivot.add(sail);
      if (!isJib) { const boom = tube(mesh, kind === "yacht" ? 0.05 : 0.025, kind === "yacht" ? 0.05 : 0.025, [0, 0, 0], [0, 0, -s.boomLen], "#c7ccd1", 8); pivot.add(boom); }
      R.rig.push({ id: s.id, pivot, sail, geom, foot, luff });
    }
    const rud = new THREE.Group(); rud.position.set(0, kind === "yacht" ? 0.4 : D * 0.7, -H.L / 2 + (kind === "yacht" ? 0.9 : -0.02));
    const rb = mesh(new THREE.BoxGeometry(0.03, kind === "yacht" ? 1.5 : 0.95, kind === "yacht" ? 0.45 : 0.24), dark); rb.position.set(0, kind === "yacht" ? -0.75 : -0.42, -0.12); rud.add(rb);
    if (kind === "dinghy") { const tiller = mesh(new THREE.BoxGeometry(0.03, 0.03, 0.9), wood); tiller.position.set(0, 0.06, 0.45); rud.add(tiller); }
    g.add(rud); R.rudder = rud;
    if (kind === "dinghy") box(0.03, 0.85, 0.3, 0, -0.35, 0.3, dark);                                         // the daggerboard
    R.lamps.nav_l = [st(H.L / 2 - 0.4).b + 0.02, D + 0.1, H.L / 2 - 0.4]; R.lamps.nav_r = [-st(H.L / 2 - 0.4).b - 0.02, D + 0.1, H.L / 2 - 0.4];
    R.lamps.stern = [0, D + 0.2, -H.L / 2 + 0.05]; R.lamps.mast = [0, D + s0.mastH + 0.05, s0.tack]; R.lamps.anchor = [0, D + s0.mastH + 0.12, s0.tack];
  } else if (kind === "canoe" || kind === "kayak" || kind === "rowboat") {
    const D = H.D;
    if (kind === "kayak") {
      // A closed deck with the cockpit coaming; deck lines.
      const top = [];
      for (let i = 0; i <= 30; i++) { const u = i / 30, s = station(H, u); top.push([s.b * 0.99, s.zs, (u - 0.5) * H.L]); }
      const pos = [], idx = [];
      for (const [b, z, x] of top) pos.push(b, z, x, 0, z + 0.06 * Math.sin(Math.PI * ((x / H.L) + 0.5)), x, -b, z, x);
      for (let i = 0; i < 30; i++) for (let j = 0; j < 2; j++) { const a = i * 3 + j, b = (i + 1) * 3 + j; idx.push(a, b, b + 1, a, b + 1, a + 1); }
      const dg = new THREE.BufferGeometry(); dg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); dg.setIndex(idx); dg.computeVertexNormals();
      const dm = mesh(dg, main); dm.material = dm.material.clone(); dm.material.side = THREE.DoubleSide; g.add(dm);
      const coam = mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 24), accent); coam.scale.set(0.75, 1.35, 1); coam.rotation.x = Math.PI / 2; add(coam, 0, D + 0.05, -0.1);
      box(0.42, 0.02, 0.85, 0, D + 0.055, -0.1, dark);
    } else {
      // Open hull: gunwales, thwarts, seats.
      for (const x of kind === "canoe" ? [0] : [0.45, -0.4]) box(st(x).b * 1.95, 0.03, 0.09, 0, D - 0.04, x, wood);
      for (const p of sp.slice(0, kind === "rowboat" ? 3 : 2)) box(st(p[2]).b * 1.9, 0.03, kind === "canoe" ? 0.28 : 0.3, 0, p[1] - 0.02, p[2], wood);
      if (kind === "rowboat") { box(st(-1.6).b * 1.8, 0.03, 0.5, 0, 0.36, -1.45, wood); for (const sx of [1, -1]) cyl(0.012, 0.012, 0.09, sx * st(-0.25).b, D + 0.05, -0.25, metal); }
    }
  } else if (kind === "log_raft") {
    // A short mast with a lantern, a crate of gear.
    cyl(0.04, 0.05, 1.8, -0.7, H.D + 0.9, -0.9, "#6a4e32");
    box(0.5, 0.35, 0.4, -0.4, H.D + 0.2, 0.9, "#8a6a44");
    R.lamps.anchor = [-0.7, H.D + 1.85, -0.9];
  }

  // ---- paddles, oars, the pole: one per paddling seat, posed every frame by the stroke
  const style = H.style;
  if (style) {
    (H.paddlers || []).forEach((p, i) => {
      if (style === "row") {
        for (const sx of [1, -1]) {
          const ol = new THREE.Group(); ol.position.set(sx * station(H, (p.x - 0.35) / H.L + 0.5).b, H.D + 0.08, p.x - 0.35);
          const oar = paddleGroup(mesh, "row", wood, wood);
          ol.add(oar); g.add(ol);
          R.paddles.push({ seat: i, side: sx, group: ol, oar, style });
        }
        return;
      }
      const grp = paddleGroup(mesh, style, style === "pole" ? "#6a4e32" : dark, style === "kayak" || style === "canoe" ? blade : "#2f6f9a");
      g.add(grp);
      R.paddles.push({ seat: i, side: p.side, group: grp, style, seatPos: sp[i] });
    });
  }
  R.seats = sp;
  R.D = H.D;
  return g;
}
