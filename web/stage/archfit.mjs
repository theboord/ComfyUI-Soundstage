// Wheels inside their arches (README media v2 QC, 2026-11-02): in the J-turn the front wheel stood out of the fender at
// full lock (f76, f100), in the clay and so in the final. Two causes, both measured on the car models themselves:
//
// 1. Steering lock. The Quaternius bodies wrap their wheels tightly: the tyre's outer face is flush with the flank and
//    the arch is only a few centimetres longer than the tyre. Turned further, one edge of the tyre swings out past the
//    bodywork (13-14 cm at 35°, 9 cm at 24°: still visible at f76 of the J-turn), which reads as a wheel through the
//    fender. measureLock() finds, on the GLB, the largest angle at which the top half of the tread stays within 0.4 of
//    a tyre width (~7 cm) of where it stands at rest outside the body's plan outline: 18-19° on all three models.
//    library.mjs carries it as steer_lock and the Parts rig clamps every steer to it (path, keyed, driven live).
// 2. Body roll and pitch. The sprung body rolls about a pivot at 0.3 x height, so on the outside of a 7° stunt lean
//    the arch lip drops ~10 cm onto a tyre it clears by ~0-2 cm. archLift() raises the body by however far its
//    lowest arch lip would sink into its tyre: the car leans about its outside wheels, the inside lifts (as a stunt
//    car does) and no tyre ever goes up through a fender.
//
// Pure functions, no three.js (geometry as plain arrays), so tests run them on the GLB files under node.

const DEG = Math.PI / 180;

/** The front-left wheel of a model from its parts: {c: [x, y, z] hub, r radius, w width} in model units. */
export function wheelOf(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], positions[i + k]); hi[k] = Math.max(hi[k], positions[i + k]);
  }
  return { c: lo.map((v, k) => (v + hi[k]) / 2), r: (hi[1] - lo[1]) / 2, w: hi[0] - lo[0] };
}

/**
 * The body's plan outline on the wheel's side: for z cells of `cell` metres, the outermost skin x between heights
 * y0 and y1 (left side, x > 0). tris: flat array of triangles [x, y, z] x 3 per triangle, in model units.
 */
export function planOutline(tris, { y0, y1, z0 = -4, z1 = 4, cell = 0.005 } = {}) {
  const n = Math.ceil((z1 - z0) / cell), out = new Float64Array(n).fill(-Infinity);
  for (let t = 0; t < tris.length; t += 9) {
    // clip the triangle against the height band by sampling it (low-poly bodies: a few thousand triangles)
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    if (Math.max(ax, bx, cx) <= 0) continue;
    if (Math.max(ay, by, cy) < y0 || Math.min(ay, by, cy) > y1) continue;
    const span = Math.max(Math.abs(bz - az), Math.abs(cz - az), Math.abs(cz - bz), Math.abs(by - ay), Math.abs(cy - ay), Math.abs(cy - by));
    const N = Math.max(2, Math.min(80, Math.ceil(span / cell)));
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N - i; j++) {
      const u = i / N, v = j / N, w = 1 - u - v;
      const y = ay * w + by * u + cy * v;
      if (y < y0 || y > y1) continue;
      const z = az * w + bz * u + cz * v, x = ax * w + bx * u + cx * v;
      const k = Math.floor((z - z0) / cell);
      if (k >= 0 && k < n && x > out[k]) out[k] = x;
    }
  }
  return { at: (z) => { const k = Math.floor((z - z0) / cell); return k >= 0 && k < n ? out[k] : -Infinity; } };
}

/**
 * How far (model units) the top half of the tread stands outside the body's plan outline with the wheel steered
 * `deg` (+ = its front toward +x). The top half is what the arch has to hide; the bottom sits in the open.
 */
export function excursion(outline, wheel, deg) {
  const { c, r, w } = wheel, d = deg * DEG, cs = Math.cos(d), sn = Math.sin(d);
  let worst = -Infinity;
  for (let a = 0; a <= 90; a++) {
    const th = (a / 90) * Math.PI, ly = r * Math.sin(th), lz = r * Math.cos(th);
    for (let s = 0; s <= 8; s++) {
      const lx = (s / 8 - 0.5) * w;
      const x = c[0] + lx * cs + lz * sn, z = c[2] - lx * sn + lz * cs;
      const edge = outline.at(z);
      if (edge > -Infinity) worst = Math.max(worst, x - edge);
    }
  }
  return worst;
}

/**
 * The steering lock (whole degrees, both ways) at which the tread's outer excursion stays within `allow` x tyre
 * width of where it is at rest. tris / wheelPositions: the body's triangles and the front-left wheel's vertices.
 */
export function measureLock(tris, wheelPositions, { allow = 0.4, max = 60 } = {}) {
  const wheel = wheelOf(wheelPositions);
  const outline = planOutline(tris, { y0: wheel.c[1], y1: wheel.c[1] + 1.55 * wheel.r });   // hub height to just above the arch
  const rest = excursion(outline, wheel, 0), limit = rest + allow * wheel.w;
  const side = (sgn) => { let ok = 0; for (let deg = 1; deg <= max; deg++) { if (excursion(outline, wheel, sgn * deg) > limit) break; ok = deg; } return ok; };
  return { lock: Math.min(side(1), side(-1)), left: side(1), right: side(-1), rest, limit, wheel };
}

/**
 * How far to raise a rolled / pitched body so no arch lip sinks into its tyre. wheels: [{x, y, z, r}] hub and
 * radius in the car's space (metres); pivotY: the body pivot's height there; roll / pitch: the body's rotation.z /
 * rotation.x (radians, three's XYZ order); tuck: how far a tyre may tuck up behind its lip (m).
 */
export function archLift(wheels, pivotY, roll, pitch, tuck = 0.02) {
  if (!wheels?.length || (!roll && !pitch)) return 0;
  const cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
  let drop = 0;
  for (const w of wheels) {
    const px = w.x, py = w.y + w.r - pivotY, pz = w.z;
    // Euler XYZ: v' = Rx(pitch) * Ry(0) * Rz(roll) * v
    const y1 = px * sz + py * cz, z1 = pz;
    const y2 = y1 * cx - z1 * sx;
    drop = Math.max(drop, py - y2);
  }
  return Math.max(0, drop - tuck);
}
