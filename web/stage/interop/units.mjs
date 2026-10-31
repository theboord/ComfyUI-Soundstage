// Interop maths shared by world import (importworld.mjs) and DCC export (exportdcc.mjs). Pure functions, no three.js,
// so node tests exercise exactly what the App runs.
//
// Soundstage world: right-handed, Y up, metres. A camera looks down its local -Z with +Y up, and its lens is
// focal_mm on a 36 mm wide sensor (horizontal fit), the same convention as soundstage/layerpack/camera.py.
//
// What the apps hand us:
//   Blender   metres, Z up (its glTF exporter already writes Y up; FBX export defaults to Y up too)
//   Unreal    centimetres, Z up, left-handed in the editor; its FBX and glTF exporters write right-handed files
//             (FBX: Z up, cm; glTF: Y up, metres)
//   Maya      centimetres, Y up (FBX / OBJ keep cm)
//   Sketchfab glTF, Y up, metres (a root node often carries the Z-up fix and a unit scale)

/** Metres per file unit. */
export const UNIT_TO_M = Object.freeze({ m: 1, cm: 0.01, mm: 0.001, km: 1000, in: 0.0254, ft: 0.3048 });

/** Typical conventions per source app and format (what "Came from" in the import panel sets). */
export const SOURCE_PRESETS = Object.freeze({
  blender: { label: "Blender", glb: { up: "y", units: "m" }, fbx: { up: "y", units: "m" }, obj: { up: "y", units: "m" } },
  unreal: { label: "Unreal Engine", glb: { up: "y", units: "m" }, fbx: { up: "z", units: "cm" }, obj: { up: "z", units: "cm" } },
  maya: { label: "Maya", glb: { up: "y", units: "m" }, fbx: { up: "y", units: "cm" }, obj: { up: "y", units: "cm" } },
  sketchfab: { label: "Sketchfab", glb: { up: "y", units: "m" }, fbx: { up: "y", units: "cm" }, obj: { up: "y", units: "m" } },
});

const DEG = Math.PI / 180;

/** Quaternion [x, y, z, w] that turns a file whose up axis is `up` ("y", "z", "x", "-y", "-z", "-x") into Y up. */
export function upAxisQuat(up = "y") {
  const h = Math.SQRT1_2;
  switch (String(up).toLowerCase()) {
    case "z": return [-h, 0, 0, h];   // Rx(-90): (x, y, z) -> (x, z, -y)
    case "-z": return [h, 0, 0, h];   // Rx(+90): (x, y, z) -> (x, -z, y)
    case "-y": return [1, 0, 0, 0];   // Rx(180)
    case "x": return [0, 0, h, h];    // Rz(+90): +X -> +Y
    case "-x": return [0, 0, -h, h];  // Rz(-90)
    default: return [0, 0, 0, 1];
  }
}

/** Rotate a vector by a quaternion [x, y, z, w]. */
export function qrot(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** File point -> stage point for an import transform {up, scale, offset}. */
export function toStage(p, { up = "y", scale = 1, offset = [0, 0, 0] } = {}) {
  const r = qrot(upAxisQuat(up), p);
  return [r[0] * scale + offset[0], r[1] * scale + offset[1], r[2] * scale + offset[2]];
}

/**
 * Up axis from area-weighted face normals: area[axis] = triangle area facing +axis / -axis, e.g.
 * {x: [a+, a-], y: [...], z: [...]}. Floors (and ceilings) are the biggest flat area in nearly every world; walls split
 * over the two horizontal axes. Ties go to the + side (floors face up, ceilings down, so a closed room ties).
 */
export function upFromNormals(area) {
  const tot = (k) => (area[k]?.[0] || 0) + (area[k]?.[1] || 0);
  const axes = ["y", "z", "x"].sort((a, b) => tot(b) - tot(a));
  const best = axes[0], [pos, neg] = area[best] || [0, 0];
  const all = tot("x") + tot("y") + tot("z") || 1;
  const sign = neg > pos * 1.5 ? "-" : "";
  return { up: sign + best, share: tot(best) / all, confident: tot(best) > 1.4 * tot(axes[1]) };
}

/**
 * Units of a world from its size. `declared` is what the file says ("m" for glTF, from UnitScaleFactor for FBX, null
 * for OBJ/PLY/STL). height / span are the world's vertical and largest horizontal extent in file units (sky domes
 * left out); meshHeight is the median height of its meshes (furniture, doors, walls are 0.3 - 3 m in any real place).
 * Returns {units, factor (metres per unit), suggest (a better factor, or null), reason}.
 */
export function guessUnits({ declared = null, height = 0, span = 0, meshHeight = 0 } = {}) {
  const typical = meshHeight || height;
  if (declared && UNIT_TO_M[declared]) {
    const k = UNIT_TO_M[declared];
    const h = typical * k, s = span * k;
    // The file says one thing, the size says another (a cm scene written as metres is the classic).
    if (h > 40 && s > 400) return { units: declared, factor: k, suggest: k * 0.01, reason: `the file says ${declared}, but its pieces are ${fmtLen(h)} tall: probably centimetres` };
    if (s > 0 && s < 0.3 && h < 0.05) return { units: declared, factor: k, suggest: k * 100, reason: `the file says ${declared}, but the whole world is only ${fmtLen(s)} across` };
    return { units: declared, factor: k, suggest: null, reason: `the file says ${declared}` };
  }
  // No units in the file: pick the scale that makes its pieces human-sized.
  const cands = [["m", 1], ["cm", 0.01], ["mm", 0.001]];
  let best = cands[0], err = Infinity;
  for (const c of cands) {
    const h = typical * c[1];
    if (!(h > 0)) continue;
    const e = Math.abs(Math.log10(h / 1.2));   // ~1.2 m: between a table and a door
    if (e < err) { err = e; best = c; }
  }
  return { units: best[0], factor: best[1], suggest: null, reason: typical ? `no units in the file; pieces read as ${best[0]}` : "no units in the file" };
}

export function fmtLen(m) {
  const a = Math.abs(m);
  if (a >= 1000) return `${(m / 1000).toFixed(a >= 10000 ? 0 : 1)} km`;
  if (a >= 10) return `${Math.round(m)} m`;
  if (a >= 1) return `${m.toFixed(1)} m`;
  if (a >= 0.01) return `${Math.round(m * 100)} cm`;
  return `${Math.round(m * 1000)} mm`;
}

/** "This world is 120 m × 80 m, 15 m tall". size = [x, y, z] in metres (Y up). */
export function sizeReadout(size) {
  const [x, y, z] = size;
  return `This world is ${fmtLen(x)} × ${fmtLen(z)}, ${fmtLen(y)} tall`;
}

/**
 * Main floor height from up-facing area per height bin ([[y, area], ...]): the lowest level holding at least 30% of
 * the biggest one (a ground floor, not a roof or a table top).
 */
export function floorFromBins(bins) {
  if (!bins?.length) return 0;
  const max = Math.max(...bins.map((b) => b[1]));
  const big = bins.filter((b) => b[1] >= 0.3 * max).sort((a, b) => a[0] - b[0]);
  return big[0][0];
}

// ---------------------------------------------------------------- cameras

export const SENSOR_W_MM = 36;

/** Lens (mm, 36 mm horizontal sensor) from a vertical FOV and the frame aspect it was made for. */
export function focalFromVfov(vfovDeg, aspect) {
  const hfov = 2 * Math.atan(Math.tan((vfovDeg * DEG) / 2) * aspect);
  return SENSOR_W_MM / (2 * Math.tan(hfov / 2));
}

/** Vertical FOV (deg) of a lens on the 36 mm horizontal sensor at a frame aspect (stage.mjs vfovFromFocal). */
export function vfovFromFocal(focalMm, aspect) {
  return (2 * Math.atan(SENSOR_W_MM / aspect / (2 * focalMm))) / DEG;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

/** Camera-to-world 4x4 (rows) looking from position at target, world +Y up, optional roll (deg). camera.py look_at. */
export function lookAt(position, target, rollDeg = 0) {
  const f = norm(sub(target, position));
  let right = cross(f, [0, 1, 0]);
  if (Math.hypot(...right) < 1e-8) right = [1, 0, 0];
  right = norm(right);
  let up = cross(right, f);
  if (rollDeg) {
    const r = rollDeg * DEG, c = Math.cos(r), s = Math.sin(r);
    const r2 = right.map((v, i) => v * c + up[i] * s), u2 = up.map((v, i) => v * c - right[i] * s);
    right = r2; up = u2;
  }
  return [
    [right[0], up[0], -f[0], position[0]],
    [right[1], up[1], -f[1], position[1]],
    [right[2], up[2], -f[2], position[2]],
    [0, 0, 0, 1],
  ];
}

/** Nuke / Maya rotate order ZXY (R = Ry · Rx · Rz) Euler angles (deg) of a 4x4 (rows). camera.py euler_zxy_deg. */
export function eulerZXY(m) {
  const rx = Math.asin(Math.max(-1, Math.min(1, -m[1][2])));
  let ry, rz;
  if (Math.abs(Math.cos(rx)) > 1e-6) { ry = Math.atan2(m[0][2], m[2][2]); rz = Math.atan2(m[1][0], m[1][1]); }
  else { ry = Math.atan2(-m[2][0], m[0][0]); rz = 0; }
  return [rx / DEG, ry / DEG, rz / DEG];
}

/** R = Ry(ry) · Rx(rx) · Rz(rz) as a 3x3 (rows). */
export function rotZXY(rx, ry, rz) {
  const [a, b, c] = [rx * DEG, ry * DEG, rz * DEG];
  const Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  return matmul3(Ry, matmul3(Rx, Rz));
}

export function matmul3(A, B) {
  return A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
}

/** Keep Euler keys continuous (no 179 -> -179 flips). */
export function unwrap(prev, angle) {
  if (prev == null) return angle;
  while (angle - prev > 180) angle -= 360;
  while (angle - prev < -180) angle += 360;
  return angle;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r9 = (v) => Math.round(v * 1e9) / 1e9;

/**
 * Per-frame camera records, field for field what soundstage/layerpack/camera.py build_frames writes into camera.json:
 * frame, position, target, focal_mm, fx_px, hfov_deg, vfov_deg, rotate_zxy_deg, cam_to_world.
 * track: [{position, target, focal_mm, roll_deg?}] one per stage frame.
 */
export function cameraFrames(track, width, height, frameStart = 1001, sensorW = SENSOR_W_MM) {
  const out = [];
  let prev = [null, null, null];
  track.forEach((c, i) => {
    const m = lookAt(c.position, c.target, c.roll_deg || 0);
    let [rx, ry, rz] = eulerZXY(m);
    rx = unwrap(prev[0], rx); ry = unwrap(prev[1], ry); rz = unwrap(prev[2], rz);
    prev = [rx, ry, rz];
    const fx = (c.focal_mm * width) / sensorW;
    out.push({
      frame: frameStart + i,
      position: c.position.map(r6),
      target: c.target.map(r6),
      focal_mm: r6(c.focal_mm),
      fx_px: r6(fx),
      hfov_deg: r6((2 * Math.atan(width / (2 * fx))) / DEG),
      vfov_deg: r6((2 * Math.atan(height / (2 * fx))) / DEG),
      rotate_zxy_deg: [r6(rx), r6(ry), r6(rz)],
      cam_to_world: m.map((row) => row.map(r9)),
    });
  });
  return out;
}

/** camera.json for the DCC kit (the Layer Pack's format, so every builder reads either). */
export function cameraJSON(frames, { width, height, fps, frameStart, sensorW = SENSOR_W_MM }) {
  return {
    convention: "world Y-up right-handed, metres; camera looks down its local -Z, +Y up; cam_to_world is row-major 4x4",
    sensor_width_mm: sensorW,
    resolution: [width, height],
    fps,
    frame_start: frameStart,
    frame_end: frameStart + frames.length - 1,
    nuke_rot_order: "ZXY",
    maya_rotate_order: "zxy",
    blender_lens_mm: "focal_mm with sensor_fit HORIZONTAL, sensor_width 36",
    unreal: "location cm = (x, z, y) * 100 by default (the glTF importer's axes); build_unreal.py measures the real mapping from the axis probes",
    frames,
  };
}

/** Nuke / Maya .chan: frame tx ty tz rx ry rz vfov (rotate order ZXY). */
export function chanText(frames) {
  return frames.map((c) => {
    const [tx, ty, tz] = c.position, [rx, ry, rz] = c.rotate_zxy_deg;
    return [c.frame, tx, ty, tz, rx, ry, rz, c.vfov_deg].map((v, i) => (i ? v.toFixed(6) : String(v))).join("\t");
  }).join("\n") + "\n";
}

/**
 * A camera node's world matrix (column-major 16, three.js Matrix4.elements) -> a Soundstage camera key.
 * The view axis is -Z (+X for FBX cameras); the target sits `dist` metres ahead. Returns {position, target, roll_deg}.
 */
export function keyFromMatrix(e, dist = 10, { forwardX = false } = {}) {
  const pos = [e[12], e[13], e[14]];
  const fwd = forwardX ? norm([e[0], e[1], e[2]]) : norm([-e[8], -e[9], -e[10]]);   // FBX cameras look down +X
  const up = norm([e[4], e[5], e[6]]);
  // Roll: the camera's up against the up it would have with no roll (world Y projected off the view axis).
  let ref = cross(cross(fwd, [0, 1, 0]), fwd);
  let roll = 0;
  if (Math.hypot(...ref) > 1e-6) {
    ref = norm(ref);
    const s = cross(ref, up), sinr = s[0] * fwd[0] + s[1] * fwd[1] + s[2] * fwd[2];
    const cosr = ref[0] * up[0] + ref[1] * up[1] + ref[2] * up[2];
    roll = Math.atan2(-sinr, cosr) / DEG;
  }
  return { position: pos, target: pos.map((v, i) => v + fwd[i] * dist), roll_deg: roll };
}
