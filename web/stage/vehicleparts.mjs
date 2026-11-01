// Vehicle parts (Milestone 26): the moving and lit parts of every car, truck, bike, boat, airliner and train, driven by
// the Parts channels in objparts.mjs. The car models (Quaternius CC0) are one body mesh plus wheels, so doors, hood
// and trunk are clean separate panels measured off the body with rays (flush with its sides and hood line, painted
// with the body's own paint); a dark aperture shows where an open door was. Everything lives in the body's own space
// (the sprung body pivot, so panels roll and pitch with it).
//
//   steering   the front wheel pivots turn (yaw before spin); "auto" = Ackermann from the path (objparts.autoSteer)
//   suspension ride height, roll and pitch on top of the weight transfer (stunts.mjs)
//   lamps      headlights (beams = real spot lights, lit in Clay and Color), brake, indicators (1.5 Hz), police light
//              bar (red / blue wig-wag + coloured point lights), nav lights + strobes on boats and the airliner.
//              A lit lamp's material is kept out of the Clay override, so the clay guide shows it glowing.
//   glass      tint (per-vehicle glass copy); wipers sweep on the windscreen plane
//   paint      finish (roughness / metalness), dirt, damage (a seeded crumple of the body vertices, one side)
// The procedural sedan and truck get the same sprung body and wheel pivots as the real models.
import * as THREE from "../vendor/three.module.min.mjs";
import { partAt, autoSteer, blinkOn, lightbarAt, navAt, wiperAt } from "./objparts.mjs";
import { glassMaterial, LIBRARY } from "./library.mjs";

const DEG = Math.PI / 180;
const CAR = new Set(["car", "police_car", "sports_car", "hatchback"]);
const PAINT_RE = /^(Blue|White|Red|Body|Main)/;
const DIRT = new THREE.Color(0x6b5a45);
const FINISH = { matte: [0.88, 0], satin: [0.5, 0.1], gloss: [0.16, 0.05], metallic: [0.3, 0.8], chrome: [0.04, 1] };
const LAMP_COL = { head: 0xfff4e0, tail: 0xff1a0e, brake: 0xff2414, amber: 0xffa21a, red: 0xff2a1a, blue: 0x2a5cff, green: 0x2aff6a, white: 0xffffff };

const lampMat = (hex) => {
  const m = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 2.2, roughness: 0.4 });
  m.userData.partLamp = true;
  return m;
};

/** Is o visible all the way up to root? */
function shown(o, root) {
  for (let p = o; p && p !== root.parent; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Meshes of the body (visible, not wheels, not ours). */
function bodyMeshes(root, g, wheels) {
  const skip = new Set();
  for (const w of wheels) w.traverse((o) => skip.add(o));
  const out = [];
  root.traverse((o) => { if (o.isMesh && !skip.has(o) && !o.userData.partProxy && !o.userData.cabinLight && shown(o, g)) out.push(o); });
  return out;
}

/** Rig the procedural sedan / truck / bikes like the real models: a sprung body pivot and wheel pivots that spin and steer. */
function rigProcedural(a, g, h) {
  const kids = [...g.children];
  const isBike = a.kind === "bicycle" || a.kind === "motorcycle";
  const wheels = [];
  if (isBike) {
    // Torus wheels at z = +-0.55: a steer group (fork, bars, front wheel) turns about the head; each wheel spins.
    const steer = new THREE.Group();
    steer.position.set(0, 0, 0.5);
    g.add(steer);
    for (const m of kids) {
      if (!m.isMesh) continue;
      const tor = m.geometry?.type === "TorusGeometry";
      if (tor) {
        const piv = new THREE.Group();
        piv.position.set(0, m.position.y, m.position.z);
        piv.userData.radius = m.geometry.parameters.radius + m.geometry.parameters.tube;
        (m.position.z > 0 ? steer : g).attach(piv);
        if (m.position.z > 0) piv.position.set(0, m.position.y, m.position.z - 0.5);
        piv.attach(m);
        wheels.push(piv);
      } else if (m.position.z > 0.3) steer.attach(m);
    }
    for (const w of wheels) w.rotation.order = "YXZ";
    g.userData.wheelRig = wheels;
    return { wheels, steerNodes: [steer], body: null };
  }
  const groups = new Map();
  for (const m of kids) {
    if (!m.isMesh || m.geometry?.type !== "CylinderGeometry" || Math.abs(Math.abs(m.rotation.z) - Math.PI / 2) > 0.01) continue;
    if (m.position.y > 0.8) continue;
    const key = `${Math.round(m.position.x * 10)}_${Math.round(m.position.z * 10)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const ms of groups.values()) {
    const piv = new THREE.Group();
    piv.position.copy(ms[0].position);
    piv.userData.radius = Math.max(...ms.map((m) => m.geometry.parameters.radiusTop || 0.3));
    piv.rotation.order = "YXZ";
    g.add(piv);
    for (const m of ms) piv.attach(m);
    wheels.push(piv);
  }
  const body = new THREE.Group();
  body.userData.bodyPivot = true;
  body.position.y = 0.3 * h;
  g.add(body);
  for (const c of kids) if (c.parent === g && !wheels.includes(c)) body.attach(c);
  g.userData.vehicleBody = body;
  g.userData.wheelRig = wheels;
  const front = wheels.filter((w) => w.position.z > 0.2);
  return { wheels, steerNodes: front, body };
}

/** Build (or reuse) the parts rig of a vehicle mesh group. null while a real-car model is still loading. */
function rigFor(st, a, g, spec) {
  const body0 = g.userData.vehicleBody || null;
  if (spec.model && !body0) return null;
  let R = g.userData.partsRig;
  if (R && R.bodyRef === (g.userData.vehicleBody || null)) return R;
  if (R) disposeRig(R);
  const h = a.height_m || spec.height || 1.45;
  let wheels = g.userData.wheelRig || [], steerNodes = [], body = body0;
  if (!spec.model && !g.userData.vehicleBody && (CAR.has(a.kind) || a.kind === "truck" || a.kind === "bicycle" || a.kind === "motorcycle")) {
    ({ wheels, steerNodes, body } = rigProcedural(a, g, h));
  } else {
    steerNodes = wheels.filter((w) => w.position.z > 0 && Math.abs(w.position.x) > 0.15);
    for (const w of steerNodes) w.rotation.order = "YXZ";
  }
  const space = body || g;
  R = { bodyRef: g.userData.vehicleBody || null, space, wheels, steerNodes, kind: a.kind, id: a.id, g, baseY: body ? body.position.y : 0,
    proxies: new THREE.Group(), lamps: [], last: {} };
  R.proxies.userData.partProxy = true;
  space.add(R.proxies);
  measure(R, a, g, h);
  g.userData.partsRig = R;
  (st._partRigs ||= new Map()).set(a.id, R);
  return R;
}

function disposeRig(R) {
  R.proxies.removeFromParent();
  for (const l of R.lights || []) { l.removeFromParent(); l.target?.removeFromParent(); }
}

/** Measure the body with rays and lay out doors, hood, trunk, wipers and lamps in body space. */
function measure(R, a, g, h) {
  const space = R.space;
  g.updateMatrixWorld(true);
  const toLocal = space.matrixWorld.clone().invert();
  const meshes = bodyMeshes(space, g, R.wheels);
  R.meshes = meshes;
  const bb = new THREE.Box3();
  for (const m of meshes) {
    m.geometry.computeBoundingBox?.();
    if (!m.geometry.boundingBox) continue;
    bb.union(m.geometry.boundingBox.clone().applyMatrix4(toLocal.clone().multiply(m.matrixWorld)));
  }
  if (bb.isEmpty()) bb.setFromCenterAndSize(new THREE.Vector3(0, h / 2, 0), new THREE.Vector3(1.8, h, 4.4));
  R.bb = bb;
  const solid = meshes.filter((m) => !m.userData.glass);
  const ray = new THREE.Raycaster();
  const hit = (o, d) => {
    const O = new THREE.Vector3(...o).applyMatrix4(space.matrixWorld), D = new THREE.Vector3(...d).transformDirection(space.matrixWorld);
    ray.set(O, D); ray.near = 0; ray.far = 100;
    const x = ray.intersectObjects(solid, false)[0];
    return x ? { p: x.point.clone().applyMatrix4(toLocal), m: x.object } : null;
  };
  const L = bb.max.z - bb.min.z, W = bb.max.x - bb.min.x, H = bb.max.y - bb.min.y;
  R.dims = { L, W, H };
  const topAt = (z, x = 0) => hit([x, bb.max.y + 1, z], [0, -1, 0])?.p.y ?? null;
  const sideAt = (y, z, s) => hit([s * (bb.max.x + 1), y, z], [-s, 0, 0]) || null;
  const frontAt = (y, x, s = 1) => hit([x, y, s > 0 ? bb.max.z + 1 : bb.min.z - 1], [0, 0, -s])?.p.z ?? (s > 0 ? bb.max.z : bb.min.z);
  // Paint: the body's own materials (a copy per vehicle, so dirt and finish never touch the shared ones).
  const mainHex = a.appearance?.color ? new THREE.Color(a.appearance.color).getHex() : null;
  const clones = new Map();
  R.paint = [];
  for (const m of meshes) {
    if (m.userData.glass || m.userData.lamp) continue;
    const name = m.material?.name || "";
    const isPaint = PAINT_RE.test(name) || (!name && mainHex != null && m.material?.color?.getHex() === mainHex);
    if (!isPaint || !m.material?.isMeshStandardMaterial) continue;
    if (!clones.has(m.material)) {
      const c = m.material.clone();
      c.userData.base = { color: c.color.clone(), roughness: c.roughness, metalness: c.metalness };
      clones.set(m.material, c);
      R.paint.push(c);
    }
    m.material = clones.get(m.material);
  }
  // Procedural bodies have no named paint: the mesh a side ray hits is the body colour.
  if (!R.paint.length) {
    const s = sideAt(bb.min.y + 0.45 * H, 0, 1);
    if (s?.m?.material?.isMeshStandardMaterial) {
      const src = s.m.material, c = src.clone();
      c.userData.base = { color: c.color.clone(), roughness: c.roughness, metalness: c.metalness };
      R.paint.push(c);
      for (const m of meshes) if (m.material === src) m.material = c;
    }
  }
  const paint = R.paint[0] || new THREE.MeshStandardMaterial({ color: mainHex ?? 0x9a9a9a, roughness: 0.5 });
  R.glass = meshes.filter((m) => m.userData.glass);
  const proxy = (geom, mat, parent = R.proxies) => {
    const m = new THREE.Mesh(geom, mat);
    m.userData.partProxy = true; m.userData.actorId = a.id;
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const isCar = CAR.has(a.kind) || a.kind === "truck";
  R.doors = {};
  if (isCar) {
    // Hood line and windscreen base: walk back from the nose along the solid top until it jumps up, drops into an
    // open cabin, or the rays fall through the glass (the windscreen). The same from the tail for the rear deck.
    const step = 0.02 * L, thr = 0.14 * (H / 1.3);
    const deckEnd = (z0, dir, yRef) => {
      let last = null;
      for (let z = z0; dir < 0 ? z > bb.min.z + 0.35 * L : z < bb.max.z - 0.35 * L; z += dir * step) {
        const y = topAt(z);
        if (y == null || y > yRef + thr || y < yRef - 0.15) return last;
        last = { z, y };
      }
      return null;
    };
    const yHood = topAt(bb.max.z - 0.12 * L) ?? bb.min.y + 0.6 * H;
    const hoodEnd = deckEnd(bb.max.z - 0.06 * L, -1, yHood);
    const zWs = hoodEnd?.z ?? null, yWs = hoodEnd?.y ?? null;
    // The roof: the first solid top well above the hood line behind the windscreen (not a light bar's peak).
    let zRoofF = null, yRoof = bb.max.y;
    if (zWs != null) for (let z = zWs - step; z > bb.min.z + 0.2 * L; z -= step) {
      const y = topAt(z);
      if (y != null && y > yWs + 0.3 * (bb.max.y - yWs)) { zRoofF = z; yRoof = y; break; }
    }
    const yTrunk = topAt(bb.min.z + 0.1 * L) ?? bb.min.y + 0.6 * H;
    const deck = deckEnd(bb.min.z + 0.06 * L, 1, yTrunk);
    const zRw = deck?.z ?? null, yRw = deck?.y ?? null;
    const hatch = zRw == null || zRw - bb.min.z < 0.1 * L;
    const belt = Math.min(yRoof - 0.3 * H, (zWs != null ? yWs : yHood) + 0.02);
    const sill = bb.min.y + 0.06 * H;
    const top = yRoof - 0.06 * H;
    // Door spans from the seats (the doors open where people get in), else from the length.
    const seats = (g.userData.seats || []).map((s) => [s.pos[0], s.pos[1] - R.baseY, s.pos[2]]);
    const fz = seats.length ? seats[0][2] : bb.min.z + 0.55 * L;
    const rear = seats.find((s) => s[2] < fz - 0.4);
    const k = h / 1.45;
    const twoDoor = a.kind === "sports_car" || a.kind === "truck";
    const spans = twoDoor ? [[fz + 0.78 * k, fz - 0.55 * k]] : [[fz + 0.66 * k, fz - 0.36 * k], [fz - 0.37 * k, (rear ? rear[2] : fz - 0.9 * k) - 0.42 * k]];
    const lim = (z) => Math.max(bb.min.z + 0.12 * L, Math.min(zWs != null ? zWs - 0.02 : bb.max.z - 0.15 * L, z));
    const mkDoor = (ch, side, z0, z1) => {
      z0 = lim(z0); z1 = lim(z1);
      const len = z0 - z1;
      if (len < 0.3) return;
      const zc = (z0 + z1) / 2, ym = (sill + belt) / 2;
      const s = sideAt(ym, zc, side);
      const sx = s ? Math.abs(s.p.x) : W / 2;
      const hinge = new THREE.Group();
      hinge.position.set(side * (sx - 0.02), 0, z0);
      R.proxies.add(hinge);
      const lower = proxy(new THREE.BoxGeometry(0.045, belt - sill, len), paint, hinge);
      lower.position.set(0, (sill + belt) / 2, -len / 2);
      const win = proxy(new THREE.BoxGeometry(0.025, Math.max(0.05, top - belt), len * 0.9), glassMaterial(), hinge);
      win.position.set(-side * 0.03, (belt + top) / 2, -len * 0.48);
      win.userData.glass = true; win.castShadow = false;
      const hole = proxy(new THREE.BoxGeometry(0.004, belt - sill, len * 0.98), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 }));
      hole.position.set(side * (sx + 0.003), (sill + belt) / 2, zc);
      hinge.visible = hole.visible = false;
      R.doors[ch] = { hinge, hole, side, axis: "y", sign: side > 0 ? -1 : 1 };
    };
    mkDoor("door_fl", 1, ...spans[0]); mkDoor("door_fr", -1, ...spans[0]);
    if (spans[1]) { mkDoor("door_rl", 1, ...spans[1]); mkDoor("door_rr", -1, ...spans[1]); }
    // A lid from its hinge to its tip in the y-z plane, turning about X.
    const lid = (ch, hy, hz, ty, tz, wid, sign) => {
      const hinge = new THREE.Group();
      hinge.position.set(0, hy, hz);
      R.proxies.add(hinge);
      const dy = ty - hy, dz = tz - hz, len = Math.hypot(dy, dz);
      const m = proxy(new THREE.BoxGeometry(wid, 0.035, len), paint, hinge);
      m.position.set(0, dy / 2 + 0.02, dz / 2);
      m.rotation.x = Math.atan2(-dy, dz);            // the box's long axis (+Z) along hinge -> tip
      // The opening it leaves stays on the body (it doesn't swing with the lid).
      const rest = new THREE.Group();
      rest.position.copy(hinge.position);
      R.proxies.add(rest);
      const hole = proxy(new THREE.BoxGeometry(wid * 0.96, 0.004, len * 0.96), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 }), rest);
      hole.position.copy(m.position); hole.rotation.copy(m.rotation);
      hole.position.y -= 0.012;
      hinge.visible = hole.visible = false;
      R.doors[ch] = { hinge, lid: m, hole, axis: "x", sign };
    };
    if (a.kind !== "truck" && zWs != null && bb.max.z - zWs > 0.12 * L) lid("hood", yWs + 0.005, zWs, yHood + 0.005, bb.max.z - 0.04 * L, 0.84 * W, -1);
    if (!hatch) lid("trunk", yRw + 0.005, zRw, yTrunk + 0.005, bb.min.z + 0.03 * L, 0.84 * W, 1);
    else {
      let zh = bb.min.z + 0.1 * L;
      for (let z = bb.min.z + 0.02 * L; z < bb.max.z; z += step) { const y = topAt(z); if (y != null && y > yRoof - 0.1) { zh = z; break; } }
      const yt = bb.min.y + 0.42 * H;
      lid("trunk", yRoof - 0.03, zh, yt, frontAt(yt, 0, -1) - 0.01, 0.84 * W, 1);
    }
    // Wipers on the windscreen plane: parked along its base, sweeping up.
    if (zWs != null && zRoofF != null) {
      const B = new THREE.Vector3(0, yWs + 0.02, zWs - 0.03), T = new THREE.Vector3(0, yRoof - 0.04, zRoofF);
      const v = T.clone().sub(B).normalize(), u = new THREE.Vector3(1, 0, 0), n = new THREE.Vector3().crossVectors(u, v).normalize();
      R.wipers = [[0.3, 0.44], [-0.04, 0.38]].map(([fx, fl]) => {
        const arm = proxy(new THREE.BoxGeometry(fl * W, 0.012, 0.022), new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 }));
        return { arm, pivot: B.clone().add(new THREE.Vector3(fx * W, 0, 0)).addScaledVector(n, 0.02), len: fl * W, u, v, n };
      });
    }
    R.layout = { yHood, zWs, yWs, zRw, yRw, hatch, belt, sill, top, yRoof, zRoofF };
  }
  // Lamps: the models' own lamp meshes where they have them, else measured on the front and rear faces.
  const own = { Headlights: [], TailLights: [], Lights: [] };
  for (const m of meshes) {
    const n = m.material?.name || m.userData.lamp || "";
    if (n === "Headlights" || n === "TailLights") own[n].push(m);
    if (n === "WhiteLights" || n === "BlueLights") own.Lights.push(m);
  }
  R.ownLamps = own;
  const boxOf = (ms) => { const b = new THREE.Box3(); for (const m of ms) { m.geometry.computeBoundingBox(); b.union(m.geometry.boundingBox.clone().applyMatrix4(toLocal.clone().multiply(m.matrixWorld))); } return b; };
  const yl = bb.min.y + 0.36 * H;
  let head, tail;
  if (own.Headlights.length) { const b = boxOf(own.Headlights); head = { x: b.max.x - 0.12 * (b.max.x - b.min.x), y: (b.min.y + b.max.y) / 2, z: b.max.z }; }
  else { const x = 0.36 * W; head = { x, y: yl, z: frontAt(yl, x) }; }
  if (own.TailLights.length) { const b = boxOf(own.TailLights); tail = { x: b.max.x - 0.12 * (b.max.x - b.min.x), y: (b.min.y + b.max.y) / 2, z: b.min.z }; }
  else { const x = 0.36 * W, y = yl + 0.06 * H; tail = { x, y, z: frontAt(y, x, -1) }; }
  if (a.kind === "motorcycle" || a.kind === "bicycle") { head.x = 0; tail.x = 0; }
  R.head = head; R.tail = tail;
  const lw = Math.min(0.22, 0.11 * W), lh = Math.min(0.1, 0.05 * H);
  const lamp = (role, hex, x, y, z, wx = lw, wy = lh) => {
    const m = proxy(new THREE.BoxGeometry(wx, wy, 0.025), lampMat(hex));
    m.position.set(x, y, z);
    m.castShadow = false;
    m.visible = false;
    m.userData.role = role;
    R.lamps.push(m);
    return m;
  };
  const sides = head.x ? [1, -1] : [1];
  for (const s of sides) {
    lamp("head", LAMP_COL.head, s * head.x, head.y, head.z + 0.012);
    lamp("tail", LAMP_COL.tail, s * tail.x, tail.y, tail.z - 0.012);
    const ix = Math.min(W / 2 - 0.04, Math.abs(head.x) + lw * 0.85) * (head.x ? s : 0) || s * 0.12;
    lamp(s > 0 ? "ind_l" : "ind_r", LAMP_COL.amber, ix, head.y - lh * 0.9, head.z + 0.01, lw * 0.5, lh * 0.7);
    const rx = Math.min(W / 2 - 0.04, Math.abs(tail.x) + lw * 0.85) * (tail.x ? s : 0) || s * 0.12;
    lamp(s > 0 ? "ind_l" : "ind_r", LAMP_COL.amber, rx, tail.y - lh * 0.9, tail.z - 0.01, lw * 0.5, lh * 0.7);
  }
  // Police light bar: red over the left half, blue over the right, on the model's bar (or a bar on the roof).
  if (a.kind === "police_car") {
    let b = own.Lights.length ? boxOf(own.Lights) : null;
    if (!b || b.isEmpty()) { const y = bb.max.y; b = new THREE.Box3(new THREE.Vector3(-0.42 * W / 2, y, -0.1), new THREE.Vector3(0.42 * W / 2, y + 0.1, 0.1)); }
    const c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    lamp("bar_l", LAMP_COL.red, c.x + sz.x / 4, c.y, c.z, sz.x / 2 * 1.04, sz.y * 1.08).scale.z = (sz.z * 1.08) / 0.025;
    lamp("bar_r", LAMP_COL.blue, c.x - sz.x / 4, c.y, c.z, sz.x / 2 * 1.04, sz.y * 1.08).scale.z = (sz.z * 1.08) / 0.025;
    R.barAt = c;
  }
  if (["boat", "jetski", "sailboat", "catamaran", "airliner"].includes(a.kind)) {
    const air = a.kind === "airliner";
    const y = air ? bb.min.y + 0.35 * H : bb.min.y + 0.55 * H, z = air ? (bb.min.z + bb.max.z) / 2 - 0.05 * L : bb.max.z - 0.2 * L;
    lamp("nav_l", LAMP_COL.red, bb.max.x - 0.05, y, z, 0.12, 0.12);
    lamp("nav_r", LAMP_COL.green, bb.min.x + 0.05, y, z, 0.12, 0.12);
    lamp("strobe", LAMP_COL.white, 0, air ? bb.max.y - 0.2 : bb.max.y, (bb.min.z + bb.max.z) / 2, 0.14, 0.14);
    lamp("strobe", LAMP_COL.white, 0, bb.min.y + 0.1 * H, bb.max.z - 0.3 * L, 0.14, 0.14);
  }
}

/** Spot lights for the beams and coloured lights for the bar: made on first use, then only their intensity changes
 *  (switching lights on and off would recompile every material in the scene). */
function ensureLights(R, need) {
  R.lights ||= [];
  if (need.beams && !R.beams) {
    R.beams = (R.head.x ? [1, -1] : [1]).map((s) => {
      const l = new THREE.SpotLight(0xfff1d8, 0, 60, 26 * DEG, 0.55, 1.4);
      l.position.set(s * R.head.x, R.head.y, R.head.z + 0.05);
      l.target.position.set(s * R.head.x * 1.6, R.head.y - 0.9, R.head.z + 18);
      l.castShadow = false;
      l.userData.partProxy = true;
      R.space.add(l, l.target);
      R.lights.push(l);
      return l;
    });
  }
  if (need.bar && !R.barLights && R.barAt) {
    R.barLights = [[1, LAMP_COL.red], [-1, LAMP_COL.blue]].map(([s, hex]) => {
      const l = new THREE.PointLight(hex, 0, 16, 1.6);
      l.position.set(R.barAt.x + s * 0.35, R.barAt.y + 0.25, R.barAt.z);
      l.userData.partProxy = true;
      R.space.add(l);
      R.lights.push(l);
      return l;
    });
  }
}

const speedCache = new WeakMap();
/** Signed forward speed (m/s) and auto steering per frame over the shot, cached until the path changes. */
function pathInfo(st, a, R) {
  const keys = st._actorKeys(a), last = st._lastFrame(), fps = st.state.shot?.fps || 24;
  const sig = JSON.stringify([keys, a.rotation_deg || 0, last, fps, a.drive || "", R?.wb]);
  const c = speedCache.get(a);
  if (c?.sig === sig) return c;
  const pos = [], yaw = [];
  for (let f = 0; f <= last; f++) { pos.push(st._actorPosAt(a, f)); yaw.push(st._headingAt(a, f)); }
  const speed = pos.map((_, f) => {
    const i = Math.max(0, f - 1), j = Math.min(last, f + 1);
    if (i === j) return 0;
    const dx = pos[j][0] - pos[i][0], dz = pos[j][2] - pos[i][2];
    return (dx * Math.sin(yaw[f]) + dz * Math.cos(yaw[f])) * fps / (j - i);
  });
  const steer = keys.length > 1 ? autoSteer(pos, yaw, fps, R?.wb || 2.7) : pos.map(() => 0);
  const out = { sig, speed, steer, fps };
  speedCache.set(a, out);
  return out;
}

/** Auto steering at a frame (deg), for the Parts panel readout. */
export function autoSteerAt(st, a, frame) {
  const g = st.actorMeshes.get(a.id), R = g?.userData.partsRig;
  const p = pathInfo(st, a, R);
  return p.steer[Math.max(0, Math.min(p.steer.length - 1, Math.round(frame)))] || 0;
}

function setLamp(m, on, intensity = 2.2) {
  m.userData.lvl = on;
  m.visible = on > 0;
  if (on > 0) m.material.emissiveIntensity = intensity * on;
}

/** Pose and light a vehicle's parts at the stage's frame. */
export function apply(st, a, g) {
  const R = rigFor(st, a, g, LIBRARY[a.kind] || {});
  if (!R) return;
  const f = st.frame, fps = st.state.shot?.fps || 24, t = f / fps;
  const v = (ch) => partAt(a, ch, f);
  if (R.wb == null) { const fz = R.wheels.filter((w) => w.position.z > 0), rz = R.wheels.filter((w) => w.position.z < 0);
    R.wb = fz.length && rz.length ? Math.abs(fz[0].position.z - rz[0].position.z) : 0.6 * R.dims.L; }
  const path = pathInfo(st, a, R);
  const fi = Math.max(0, Math.min(path.speed.length - 1, f));
  // Steering: keyed, else from the path.
  const steer = a.parts?.steer?.length ? v("steer") : path.steer[fi] || 0;
  for (const n of R.steerNodes) n.rotation.y = steer * DEG;
  // Suspension offsets on the sprung body (its roll / pitch were just set from the weight transfer).
  const body = g.userData.vehicleBody;
  if (body?.userData.bodyPivot && R.space === body) {
    body.position.y = R.baseY + (v("susp_h") || 0);
    body.rotation.x -= (v("susp_pitch") || 0) * DEG;
    body.rotation.z += (v("susp_roll") || 0) * DEG;
  }
  // Doors, hood, trunk.
  for (const [ch, d] of Object.entries(R.doors || {})) {
    const ang = Math.max(0, v(ch) || 0);
    d.hinge.visible = ang > 0.5;
    if (d.hole) d.hole.visible = ang > 0.5;
    if (d.axis === "y") d.hinge.rotation.y = d.sign * ang * DEG;
    else d.hinge.rotation.x = d.sign * ang * DEG;
  }
  // Wipers.
  const wm = v("wipers") || "off";
  for (const [i, w] of (R.wipers || []).entries()) {
    const s = wiperAt(wm, t + i * 0.03) * 100 * DEG;
    const dir = w.u.clone().multiplyScalar(-Math.cos(s)).addScaledVector(w.v, Math.sin(s));
    const m = new THREE.Matrix4().makeBasis(dir, w.n, dir.clone().cross(w.n));
    w.arm.quaternion.setFromRotationMatrix(m);
    w.arm.position.copy(w.pivot).addScaledVector(dir, w.len / 2);
  }
  // Lamps.
  const hl = v("headlights") || "auto", br = v("brake") || "auto", ind = v("indicator") || "off", bar = v("lightbar") || "off", nav = v("navlights") || "off";
  const sp = path.speed[fi], sp2 = path.speed[Math.min(path.speed.length - 1, fi + 3)];
  const decel = (Math.abs(sp) - Math.abs(sp2)) * fps / 3;           // m/s² over the next 3 frames
  const braking = br === "on" || (br === "auto" && Math.abs(sp) > 1 && decel > 2);
  const blink = blinkOn(t);
  const lb = lightbarAt(bar, t), nv = navAt(nav, t);
  const on = hl === "low" || hl === "high";
  ensureLights(R, { beams: on || !!a.parts?.headlights?.some((k) => k.v === "low" || k.v === "high"), bar: bar !== "off" || !!a.parts?.lightbar });
  const ownHead = R.ownLamps.Headlights.length > 0, ownTail = R.ownLamps.TailLights.length > 0;
  R.lit = [];
  for (const m of R.lamps) {
    const r = m.userData.role;
    let lvl = 0;
    if (r === "head") lvl = ownHead ? 0 : on ? (hl === "high" ? 1.4 : 1) : 0;
    else if (r === "tail") lvl = ownTail ? 0 : braking ? 1.6 : on ? 0.6 : 0;
    else if (r === "ind_l") lvl = (ind === "left" || ind === "hazard") && blink ? 1 : 0;
    else if (r === "ind_r") lvl = (ind === "right" || ind === "hazard") && blink ? 1 : 0;
    else if (r === "bar_l") lvl = lb.left * 1.6;
    else if (r === "bar_r") lvl = lb.right * 1.6;
    else if (r === "nav_l" || r === "nav_r") lvl = nv.nav;
    else if (r === "strobe") lvl = nv.strobe * 2;
    setLamp(m, lvl);
    if (lvl > 0) R.lit.push(m.material);
  }
  // The models' own lamp materials: off, the old Color-only marker (auto), or lit for every pass.
  for (const m of R.ownLamps.Headlights) {
    m.material.emissiveIntensity = hl === "off" ? 0 : hl === "high" ? 3.2 : on ? 2.6 : 1.8;
    if (on) R.lit.push(m.material);
  }
  for (const m of R.ownLamps.TailLights) {
    m.material.emissiveIntensity = braking ? 4.2 : hl === "off" && br !== "on" ? 0.35 : 1.4;
    if (braking || on) R.lit.push(m.material);
  }
  for (const b of R.beams || []) { b.intensity = on ? (hl === "high" ? 26 : 16) : 0; b.angle = (hl === "high" ? 20 : 28) * DEG; b.distance = hl === "high" ? 90 : 55; }
  for (const [i, l] of (R.barLights || []).entries()) l.intensity = (i ? lb.right : lb.left) * 12;
  // Glass tint (a copy of the shared glass for this vehicle).
  const tint = v("tint") || 0;
  if (tint !== R.last.tint) {
    R.last.tint = tint;
    if (!R.tintMat && tint > 0) { R.tintMat = glassMaterial().clone(); R.tintMat.allowOverride = false; }
    const gm = tint > 0 ? R.tintMat : glassMaterial();
    if (tint > 0) { gm.color.set(0xd4e4ee).lerp(new THREE.Color(0x07090b), Math.min(1, tint * 1.1)); gm.opacity = 0.22 + 0.7 * tint; }
    for (const m of R.glass) m.material = gm;
    for (const d of Object.values(R.doors || {})) d.hinge.traverse((o) => { if (o.userData.glass) o.material = gm; });
  }
  // Paint: finish and dirt.
  const fin = v("finish") || "factory", dirt = v("dirt") || 0;
  const pk = `${fin}|${dirt}`;
  if (pk !== R.last.paint) {
    R.last.paint = pk;
    for (const m of R.paint) {
      const b = m.userData.base;
      const [ro, me] = FINISH[fin] || [b.roughness, b.metalness];
      m.color.copy(b.color).lerp(DIRT, 0.55 * dirt);
      m.roughness = ro + (1 - ro) * 0.8 * dirt;
      m.metalness = me * (1 - 0.7 * dirt);
    }
  }
  // Damage: crumple the body on one side (geometry copies, seeded).
  const dmg = Math.round((v("damage") || 0) * 50) / 50, side = v("damage_side") || "front";
  if (`${dmg}|${side}` !== R.last.damage) { R.last.damage = `${dmg}|${side}`; crumple(R, dmg, side, a.id); }
}

function crumple(R, amt, side, id) {
  if (!amt && !R.dmg) return;
  const toLocal = R.space.matrixWorld.clone().invert();
  if (!R.dmg) {
    R.dmg = R.meshes.filter((m) => m.geometry?.attributes?.position && !m.userData.partProxy).map((m) => {
      m.geometry = m.geometry.clone();
      const M = toLocal.clone().multiply(m.matrixWorld);
      return { m, base: Float32Array.from(m.geometry.attributes.position.array), M, Minv: M.clone().invert() };
    });
  }
  const { bb } = R, L = bb.max.z - bb.min.z, W = bb.max.x - bb.min.x;
  const seed = [...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % 17;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const d of R.dmg) {
    const pos = d.m.geometry.attributes.position, arr = pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      p.set(d.base[i], d.base[i + 1], d.base[i + 2]).applyMatrix4(d.M);
      let w = 0, dir = [0, 0, 0];
      if (side === "front") { w = (p.z - (bb.max.z - 0.32 * L)) / (0.32 * L); dir = [0, -0.12, -1]; }
      else if (side === "rear") { w = ((bb.min.z + 0.32 * L) - p.z) / (0.32 * L); dir = [0, -0.12, 1]; }
      else {
        const s = side === "left" ? 1 : -1;
        w = (s * p.x - (W / 2 - 0.3 * W)) / (0.3 * W) * Math.exp(-((p.z - (bb.min.z + bb.max.z) / 2) ** 2) / (2 * (0.2 * L) ** 2));
        dir = [-s, -0.08, 0];
      }
      w = Math.max(0, Math.min(1, w));
      const n = Math.sin(p.x * 7.1 + p.y * 3.3 + seed) * Math.sin(p.z * 5.7 + p.y * 2.1 + seed * 0.7);
      const k = amt * 0.26 * Math.pow(w, 1.4) * (0.65 + 0.35 * n);
      q.copy(p).add(new THREE.Vector3(dir[0] * k + n * 0.15 * k, dir[1] * k + n * 0.2 * k, dir[2] * k)).applyMatrix4(d.Minv);
      arr[i] = q.x; arr[i + 1] = q.y; arr[i + 2] = q.z;
    }
    pos.needsUpdate = true;
    d.m.geometry.computeVertexNormals();
    d.m.geometry.computeBoundingBox();
    d.m.geometry.computeBoundingSphere();
  }
}

/** Before a render: lit lamps glow in Clay and Color (kept out of the clay override); hidden from the Depth pass. */
export function pass(st, mode) {
  for (const [id, R] of st._partRigs || []) {
    if (st.actorMeshes.get(id) !== R.g) { st._partRigs.delete(id); continue; }
    const glow = mode === "clay" || mode === "color";
    const lit = new Set(R.lit || []);
    for (const m of R.lamps) { m.material.allowOverride = !glow; m.visible = glow && m.userData.lvl > 0; }
    for (const k of ["Headlights", "TailLights"]) for (const m of R.ownLamps[k]) m.material.allowOverride = !(glow && lit.has(m.material));
  }
}

/** The headless overlay hook kept for the stage's post-render call (nothing to draw: pass() does it up front). */
export function overlay() {}
