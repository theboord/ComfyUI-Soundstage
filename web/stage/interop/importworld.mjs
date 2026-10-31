// Bring your world in (Milestone 12): a whole environment from Blender, Unreal, Maya or Sketchfab (GLB / glTF / FBX /
// OBJ / PLY / STL), or a Gaussian splat (.spz .splat .ksplat .sog, or a splat .ply), becomes the Set.
//
//   * units and up axis: read from the file where it says (glTF = metres, Y up; FBX GlobalSettings UpAxis and
//     UnitScaleFactor), else worked out from the geometry (floors are the biggest flat area; pieces are human-sized);
//     a one-click fix when the size looks wrong ("This world is 4 km × 3 km, 300 m tall: probably centimetres");
//   * the main floor lands on y = 0 (the stage floor and the physics floor);
//   * static meshes merge by material into a few spatial chunks (draw calls drop from thousands to tens), and big
//     chunks get a decimated far LOD, so heavy worlds stay interactive;
//   * the meshes become static box colliders (colliders.mjs) for live physics and Simulate & bake;
//   * cameras in the file become shots (animated ones keyed per frame, focal length from their FOV);
//   * animated objects keep their own keys and play on the shot timeline (frame / fps), holding the last pose.
//
// State lives in stage.state.world: {url, name, format, files?, source, up, units, scale_mul, lift, recenter,
// hide_ground, colliders}. stage.mjs only calls attach() from _buildSet, colliders() from _setColliders, setTime() from
// setFrame. Everything else is here.
import * as THREE from "../../vendor/three.module.min.mjs";
import { GLTFLoader } from "../../vendor/addons/GLTFLoader.mjs";
import { FBXLoader } from "../../vendor/addons/FBXLoader.mjs";
import { OBJLoader } from "../../vendor/addons/OBJLoader.mjs";
import { PLYLoader } from "../../vendor/addons/PLYLoader.mjs";
import { STLLoader } from "../../vendor/addons/STLLoader.mjs";
import { mergeGeometries, deinterleaveGeometry } from "../../vendor/addons/BufferGeometryUtils.mjs";
import * as U from "./units.mjs";
import { worldColliders } from "./colliders.mjs";

export const WORLD_MESH_FORMATS = ["glb", "gltf", "fbx", "obj", "ply", "stl"];
export const WORLD_SPLAT_FORMATS = ["spz", "splat", "ksplat", "sog"];
/** Extensions the world importer accepts as the main file; .bin and textures may come along with a .gltf / .obj. */
export const WORLD_ACCEPT = [...WORLD_MESH_FORMATS, ...WORLD_SPLAT_FORMATS, "bin", "mtl", "png", "jpg", "jpeg", "webp", "ktx2"]
  .map((x) => "." + x).join(",");
export const extOf = (name) => (/\.([a-z0-9]+)(?:$|\?)/i.exec(name || "")?.[1] || "").toLowerCase();

const NO_COLLIDE_NAME = /(sky|dome|cloud|leaf|leaves|foliage|grass|decal|water|glass|window_glass|fog|light_?beam|volumetric)/i;

// ---------------------------------------------------------------- FBX header (units and up axis)

/**
 * UpAxis / UpAxisSign / UnitScaleFactor from an FBX file's GlobalSettings (binary or ASCII). three's FBXLoader keeps
 * the raw numbers, so a Z-up centimetre FBX from Unreal comes in lying down and 100x too big without this.
 * Returns {up: "y"|"z"|"x"|"-y"..., unitScale: cm per unit} with nulls for what the file doesn't say.
 */
export function fbxGlobalSettings(buffer) {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 32));
  const out = { up: null, unitScale: null };
  const axis = (a, s) => (a == null ? null : (s < 0 ? "-" : "") + ["x", "y", "z"][a]);
  if (!head.startsWith("Kaydara FBX Binary")) {
    const txt = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4 << 20)));
    const num = (name, last = false) => {
      const re = new RegExp(`"${name}",\\s*"[^"]*",\\s*"[^"]*",\\s*"[^"]*",\\s*(-?[\\d.eE+-]+)`, "g");
      let m, v = null;
      while ((m = re.exec(txt))) { v = +m[1]; if (!last) break; }
      return v;
    };
    const a = num("UpAxis"), s = num("UpAxisSign");
    out.up = axis(a, s ?? 1);
    out.unitScale = num("UnitScaleFactor");
    const fw = num("FilmWidth", true);
    if (fw > 0) out.filmWidthMm = fw * 25.4;
    return out;
  }
  const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : bytes.buffer);
  const find = (name, last = false) => {
    const pat = [0x53, name.length, 0, 0, 0, ...[...name].map((c) => c.charCodeAt(0))];
    let found = null;
    outer: for (let i = 0; i + pat.length < bytes.length; i++) {
      for (let k = 0; k < pat.length; k++) if (bytes[i + k] !== pat[k]) continue outer;
      // The property record: name, type, label, flags (all strings), then the value.
      let o = i + pat.length;
      for (let n = 0; n < 3; n++) { if (bytes[o] !== 0x53) return null; o += 5 + dv.getUint32(o + 1, true); }
      const t = String.fromCharCode(bytes[o]);
      const v = t === "I" ? dv.getInt32(o + 1, true) : t === "D" ? dv.getFloat64(o + 1, true) : t === "F" ? dv.getFloat32(o + 1, true)
        : t === "L" ? Number(dv.getBigInt64(o + 1, true)) : t === "Y" ? dv.getInt16(o + 1, true) : null;
      if (!last) return v;
      found = v;
    }
    return found;
  };
  const a = find("UpAxis"), s = find("UpAxisSign");
  out.up = axis(a, s ?? 1);
  out.unitScale = find("UnitScaleFactor");
  const fw = find("FilmWidth", true);   // inches; the last camera's (the Definitions template comes first)
  if (fw > 0) out.filmWidthMm = fw * 25.4;
  return out;
}

// ---------------------------------------------------------------- loading

/** Load a world file. files: {basename: url} for a .gltf's .bin / textures or an .obj's .mtl. Resolves raw = {scene, animations, declared}. */
export async function loadWorldFile(url, format, { files = {} } = {}) {
  const manager = new THREE.LoadingManager();
  const mapped = (u) => { const b = decodeURIComponent(String(u).split(/[?#]/)[0].split("/").pop() || ""); return files[b] || u; };
  manager.setURLModifier((u) => (files && Object.keys(files).length ? mapped(u) : u));
  const buf = async () => { const r = await fetch(url); if (!r.ok) throw new Error(`fetch failed (${r.status})`); return r.arrayBuffer(); };
  const base = url.startsWith("blob:") || url.startsWith("data:") ? "" : url.replace(/[^/]*$/, "");
  if (format === "glb" || format === "gltf") {
    const g = await new GLTFLoader(manager).parseAsync(await buf(), base);
    await readFovAnimation(g);
    return { scene: g.scene, animations: g.animations || [], declared: { up: "y", units: "m", source: g.asset?.generator || "" } };
  }
  if (format === "fbx") {
    const data = await buf();
    const hdr = fbxGlobalSettings(data);
    const o = new FBXLoader(manager).parse(data, base);
    // FBX cameras look down their local +X (three's FBX reader keeps that), and three reads the lens on a 35 mm gauge.
    o.traverse((c) => { if (c.isCamera) Object.assign(c.userData, { forwardX: true, fbxFocal: c.getFocalLength?.(), filmWidthMm: hdr.filmWidthMm || null }); });
    o.animations = pickTakes(o, o.animations || []);
    const usf = hdr.unitScale ?? o.userData?.unitScaleFactor ?? null;
    const units = usf == null ? null : Math.abs(usf - 1) < 1e-6 ? "cm" : Math.abs(usf - 100) < 1e-4 ? "m" : Math.abs(usf - 2.54) < 1e-4 ? "in" : Math.abs(usf - 0.1) < 1e-6 ? "mm" : null;
    return { scene: o, animations: o.animations || [], declared: { up: hdr.up, units, unitScale: usf, source: "FBX" } };
  }
  if (format === "obj") {
    const txt = new TextDecoder().decode(await buf());
    return { scene: new OBJLoader(manager).parse(txt), animations: [], declared: { up: null, units: null, source: "OBJ" } };
  }
  const geom = (format === "stl" ? new STLLoader(manager) : new PLYLoader(manager)).parse(await buf());
  if (!geom.attributes.normal) geom.computeVertexNormals();
  const vc = !!geom.attributes.color;
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: vc ? 0xffffff : 0xb9b4ac, vertexColors: vc, roughness: 0.85 }));
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, animations: [], declared: { up: null, units: null, source: format.toUpperCase() } };
}

/**
 * glTF can't animate a lens in core; Blender writes it with KHR_animation_pointer (/cameras/N/perspective/yfov), which
 * three's loader skips. Read those channels and hang {times, values} (yfov, radians) on each camera.
 */
async function readFovAnimation(g) {
  const json = g.parser?.json;
  if (!json?.animations?.length || !json.cameras?.length) return;
  const camNode = new Map();
  for (const [obj, a] of g.parser.associations) if (obj.isCamera && a?.nodes !== undefined && json.nodes[a.nodes]?.camera !== undefined) camNode.set(json.nodes[a.nodes].camera, obj);
  for (const anim of json.animations) for (const ch of anim.channels || []) {
    const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer || "";
    const m = /^\/cameras\/(\d+)\/perspective\/yfov$/.exec(ptr);
    const cam = m && camNode.get(+m[1]);
    if (!cam) continue;
    const smp = anim.samplers[ch.sampler];
    const [ti, vo] = await Promise.all([g.parser.getDependency("accessor", smp.input), g.parser.getDependency("accessor", smp.output)]);
    cam.userData.yfovTrack = { times: Array.from(ti.array), values: Array.from(vo.array), step: smp.interpolation === "STEP" };
  }
}

/** yfov (deg) of a camera at time t from its pointer track, or its static fov. */
export function fovAt(cam, t) {
  const tr = cam.userData?.yfovTrack;
  if (!tr?.times?.length) return cam.fov;
  const T = tr.times, V = tr.values;
  if (t <= T[0]) return V[0] * 180 / Math.PI;
  for (let i = 0; i + 1 < T.length; i++) if (t <= T[i + 1]) {
    const u = tr.step ? 0 : (t - T[i]) / Math.max(1e-9, T[i + 1] - T[i]);
    return (V[i] + (V[i + 1] - V[i]) * u) * 180 / Math.PI;
  }
  return V[V.length - 1] * 180 / Math.PI;
}

/**
 * An FBX often carries several takes that each animate the same nodes (Blender's "all actions" export applies every
 * action to every object). Playing them together mixes them up; keep one take per node, preferring the take named
 * after the node it moves ("crate|crateAction" over "crate|ShotCamAction"), else the first.
 */
export function pickTakes(root, clips) {
  if (clips.length < 2) return clips;
  const targets = clips.map((c) => new Set(c.tracks.map((t) => THREE.PropertyBinding.parseTrackName(t.name).nodeName)));
  const score = (c, set) => { let n = 0; for (const name of set) { const k = name && c.name.split(name).length - 1; n += k || 0; } return n; };
  const order = clips.map((c, i) => i).sort((a, b) => score(clips[b], targets[b]) - score(clips[a], targets[a]) || a - b);
  const taken = new Set(), keep = [];
  for (const i of order) {
    if ([...targets[i]].some((n) => taken.has(n))) continue;
    for (const n of targets[i]) taken.add(n);
    keep.push(clips[i]);
  }
  return keep;
}

/** A .ply may be a mesh or a Gaussian splat (f_dc_* / scale_* / opacity properties). */
export async function plyIsSplat(url) {
  try {
    const head = new TextDecoder().decode(await (await fetch(url, { headers: { Range: "bytes=0-4095" } })).arrayBuffer());
    return /property \w+ (f_dc_0|scale_0|opacity)\b/.test(head.split("end_header")[0]);
  } catch { return false; }
}

// ---------------------------------------------------------------- processing (once per file)

function animatedNodes(scene, clips) {
  const set = new Set();
  for (const clip of clips) for (const t of clip.tracks) {
    const b = THREE.PropertyBinding.parseTrackName(t.name);
    const n = THREE.PropertyBinding.findNode(scene, b.nodeName);
    if (n) set.add(n);
  }
  return set;
}

const underAnimated = (o, set, root) => { for (let p = o; p && p !== root.parent; p = p.parent) if (set.has(p)) return true; return false; };

/** Every attribute as a plain Float32 (quantized / interleaved glTF data can't be baked or merged as is). */
function plainGeometry(g) {
  let geo = g.clone();
  if (Object.values(geo.attributes).some((a) => a.isInterleavedBufferAttribute)) geo = deinterleaveGeometry(geo) || geo;
  for (const [name, a] of Object.entries(geo.attributes)) {
    if (a.array instanceof Float32Array && !a.normalized && !a.isInterleavedBufferAttribute) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
    geo.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  for (const k of Object.keys(geo.morphAttributes)) delete geo.morphAttributes[k];
  if (!geo.index) {
    const n = geo.attributes.position.count;
    geo.setIndex(n > 65535 ? new THREE.BufferAttribute(Uint32Array.from({ length: n }, (_, i) => i), 1) : Array.from({ length: n }, (_, i) => i));
  }
  return geo;
}

const KEEP_ATTRS = new Set(["position", "normal", "uv", "uv1", "color"]);
const attrSig = (geo) => Object.entries(geo.attributes).map(([n, a]) => `${n}:${a.itemSize}`).sort().join(",");

/** Vertex-clustering decimation (far LOD): vertices snap to a grid of `cell`, collapsed triangles drop. */
export function clusterSimplify(geo, cell) {
  const pos = geo.attributes.position, idx = geo.index ? geo.index.array : null;
  const ids = new Map(), map = new Int32Array(pos.count), reps = [], sum = [];
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    let c = ids.get(key);
    if (c === undefined) { c = reps.length; ids.set(key, c); reps.push(v); sum.push([0, 0, 0, 0]); }
    map[v] = c;
    const s = sum[c]; s[0] += x; s[1] += y; s[2] += z; s[3]++;
  }
  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) {
    const arr = new Float32Array(reps.length * a.itemSize);
    reps.forEach((v, c) => {
      for (let k = 0; k < a.itemSize; k++) arr[c * a.itemSize + k] = name === "position" ? sum[c][k] / sum[c][3] : a.getComponent(v, k);
    });
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  const tri = [];
  const n = idx ? idx.length : pos.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = map[idx ? idx[t] : t], b = map[idx ? idx[t + 1] : t + 1], c = map[idx ? idx[t + 2] : t + 2];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  out.setIndex(tri);
  return out;
}

/** Raw triangles of a mesh in the world root's frame (flat 9 floats a triangle). */
function rawTriangles(mesh, toRoot) {
  const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
  const n = idx ? idx.count : pos.count;
  const out = new Float32Array(Math.floor(n / 3) * 9);
  const v = new THREE.Vector3();
  for (let t = 0; t + 2 < n; t += 3) for (let k = 0; k < 3; k++) {
    v.fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(toRoot);
    out.set([v.x, v.y, v.z], (t / 3) * 9 + k * 3);
  }
  return out;
}

/**
 * Prepare a loaded world once: find animated nodes, cameras, lights and sky domes; collect triangles for colliders and
 * statistics; merge the static meshes by material into spatial chunks with far LODs. Independent of units / up axis
 * (those are a transform on top, so changing them later is instant).
 */
export function prepareWorld(raw, { merge = true, lodTris = 60000 } = {}) {
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const scene = raw.scene;
  scene.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(scene.matrixWorld).invert();
  const anim = animatedNodes(scene, raw.animations || []);
  const cameras = [], lights = [], meshes = [];
  scene.traverse((o) => {
    if (o.isCamera) cameras.push(o);
    else if (o.isLight) lights.push(o);
    else if (o.isMesh || o.isPoints) meshes.push(o);
  });
  for (const l of lights) l.visible = false;   // the stage lights the set; file lights would double it
  // Raw bounds of every mesh (root frame).
  const info = meshes.map((m) => {
    const bb = new THREE.Box3();
    if (m.geometry?.attributes?.position) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      bb.copy(m.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, m.matrixWorld));
    }
    return { m, bb };
  });
  // Sky domes / backdrops: a mesh that encloses everything else and dwarfs it. Not part of the world's size.
  const sky = new Set(info.filter((x) => /sky|dome/i.test(x.m.name || "")).map((x) => x.m));
  const byDiag = [...info].filter((x) => !x.bb.isEmpty()).sort((a, b) => b.bb.getSize(new THREE.Vector3()).length() - a.bb.getSize(new THREE.Vector3()).length());
  for (const cand of byDiag.slice(0, 3)) {
    const rest = new THREE.Box3();
    for (const x of info) if (x !== cand && !sky.has(x.m) && !x.bb.isEmpty()) rest.union(x.bb);
    if (rest.isEmpty()) break;
    const big = cand.bb.getSize(new THREE.Vector3()), small = rest.getSize(new THREE.Vector3());
    if (cand.bb.containsBox(rest) && big.x > 2.5 * small.x && big.z > 2.5 * small.z && big.y > 2.5 * small.y) sky.add(cand.m);
  }
  const bounds = new THREE.Box3();
  for (const x of info) if (!sky.has(x.m) && !x.bb.isEmpty()) bounds.union(x.bb);
  // Collider sources: solid, static, opaque meshes. Statistics use every triangle that isn't sky.
  const soup = [];
  let tris = 0;
  for (const { m } of info) {
    if (!m.isMesh || !m.geometry?.attributes?.position || sky.has(m)) continue;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const t = rawTriangles(m, new THREE.Matrix4().multiplyMatrices(toRoot, m.matrixWorld));
    tris += t.length / 9;
    const animated = underAnimated(m, anim, scene) || m.isSkinnedMesh;
    const solid = !animated && !mat?.transparent && !(mat?.alphaTest > 0) && !NO_COLLIDE_NAME.test(`${m.name} ${mat?.name || ""}`);
    soup.push({ name: m.name, tris: t, solid });
  }
  for (const m of sky) { m.castShadow = false; m.receiveShadow = false; m.userData.worldSky = true; }
  // Merge static meshes by material into chunks (3D cells of ~1/6 of the world).
  let drawsBefore = 0, drawsAfter = 0, lods = 0;
  const diag = bounds.isEmpty() ? 1 : bounds.getSize(new THREE.Vector3()).length();
  // Small worlds merge into one draw per material; big ones into spatial chunks (~1/5 of the world) so the camera
  // still culls what it can't see.
  const cell = tris < 300000 ? Infinity : Math.max(1e-6, diag / 5);
  const chunks = new THREE.Group();
  chunks.name = "merged_static";
  for (const { m } of info) if (m.isMesh) drawsBefore++;
  if (merge) {
    const buckets = new Map();
    for (const { m, bb } of info) {
      if (!m.isMesh || m.isSkinnedMesh || m.isInstancedMesh || Array.isArray(m.material) || sky.has(m)) continue;
      if (underAnimated(m, anim, scene) || m.morphTargetInfluences?.length || !m.geometry?.attributes?.position) continue;
      if (m.material?.transparent) continue;   // keep sorting right for glass / foliage
      const geo = plainGeometry(m.geometry);
      for (const n of Object.keys(geo.attributes)) if (!KEEP_ATTRS.has(n)) geo.deleteAttribute(n);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const mat = new THREE.Matrix4().multiplyMatrices(toRoot, m.matrixWorld);
      geo.applyMatrix4(mat);
      if (mat.determinant() < 0) {   // mirrored: baking the transform turns the faces inside out, so flip the winding
        const ix = geo.index.array;
        for (let t = 0; t + 2 < ix.length; t += 3) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; }
      }
      const c = bb.getCenter(new THREE.Vector3());
      const key = `${m.material.uuid}|${attrSig(geo)}|${isFinite(cell) ? [c.x, c.y, c.z].map((v) => Math.floor(v / cell)).join() : 0}`;
      if (!buckets.has(key)) buckets.set(key, { material: m.material, geos: [], cast: false, recv: false });
      const b = buckets.get(key);
      b.geos.push(geo);
      b.cast ||= m.castShadow !== false; b.recv ||= m.receiveShadow !== false;
      m.userData.mergedAway = true;
    }
    for (const m of meshes) if (m.userData.mergedAway) m.removeFromParent();
    for (const b of buckets.values()) {
      const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = b.material.name ? `world_${b.material.name}` : "world_chunk";
      mesh.userData.worldChunk = true;
      const nt = geo.index.count / 3;
      if (nt > lodTris) {
        const r = geo.boundingSphere.radius;
        const far = clusterSimplify(geo, Math.max(r / 60, 1e-6));
        far.computeBoundingSphere();
        const farMesh = new THREE.Mesh(far, b.material);
        farMesh.castShadow = true; farMesh.receiveShadow = true;
        farMesh.userData.worldChunk = true;
        const lod = new THREE.LOD();
        lod.name = mesh.name;
        lod.addLevel(mesh, 0);
        lod.addLevel(farMesh, 1);
        lod.userData.lodRaw = Math.max(r * 2.5, 1e-6);   // switch distance in file units (scaled with the world)
        lod.userData.worldChunk = true;
        chunks.add(lod);
        lods++;
      } else chunks.add(mesh);
      drawsAfter++;
    }
    scene.add(chunks);
  }
  scene.traverse((o) => { if (o.isMesh && !o.userData.worldChunk && !o.userData.worldSky) { o.castShadow = true; o.receiveShadow = true; drawsAfter += o.userData.mergedAway ? 0 : 1; } });
  if (!merge) drawsAfter = drawsBefore;
  // Area-weighted normals (up-axis vote) and per-mesh heights (unit vote), both in raw units.
  const area = { x: [0, 0], y: [0, 0], z: [0, 0] };
  for (const s of soup) {
    const t = s.tris;
    for (let o = 0; o < t.length; o += 9) {
      const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2], vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const l = Math.hypot(cx, cy, cz);
      if (!(l > 0)) continue;
      const ax = Math.abs(cx), ay = Math.abs(cy), az = Math.abs(cz);
      if (ax >= ay && ax >= az) area.x[cx > 0 ? 0 : 1] += l / 2;
      else if (ay >= az) area.y[cy > 0 ? 0 : 1] += l / 2;
      else area.z[cz > 0 ? 0 : 1] += l / 2;
    }
  }
  const sizes = info.filter((x) => !sky.has(x.m) && !x.bb.isEmpty()).map((x) => x.bb.getSize(new THREE.Vector3()));
  const now = (typeof performance !== "undefined" ? performance : Date).now();
  return {
    scene, animations: raw.animations || [], declared: raw.declared || {}, cameras, anim, sky, soup, bounds, area, sizes,
    stats: { meshes: drawsBefore, draws: drawsAfter, tris, lods, lights: lights.length, cameras: cameras.length,
      animated: anim.size, materials: new Set(meshes.map((m) => (Array.isArray(m.material) ? m.material[0] : m.material)?.uuid)).size,
      sky: sky.size, prepMs: Math.round(now - t0) },
  };
}

// ---------------------------------------------------------------- settings (units, up, floor) -> transform

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * Resolve the import transform for a prepared world and the user's settings. Returns {up, units, factor, quat, offset,
 * size (stage m), suggest, reasons}.
 */
export function resolveTransform(prep, w = {}) {
  const fmt = w.format === "gltf" ? "glb" : w.format;
  const preset = w.source && w.source !== "auto" ? U.SOURCE_PRESETS[w.source]?.[fmt === "glb" || fmt === "fbx" ? fmt : "obj"] : null;
  const vote = U.upFromNormals(prep.area);
  const declaredUp = prep.declared?.up || null;
  let up, upReason;
  if (w.up && w.up !== "auto") { up = w.up; upReason = "set by you"; }
  else if (preset) { up = preset.up; upReason = `${U.SOURCE_PRESETS[w.source].label} convention`; }
  else if (declaredUp) { up = declaredUp; upReason = fmt === "glb" ? "glTF is Y up" : "the file says"; }
  else { up = vote.up; upReason = "from the floors"; }
  const ax = up.replace("-", "");
  const hIdx = { x: 0, y: 1, z: 2 }[ax];
  const rawSize = prep.bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : prep.bounds.getSize(new THREE.Vector3());
  const comps = [rawSize.x, rawSize.y, rawSize.z];
  const height = comps[hIdx], span = Math.max(...comps.filter((_, i) => i !== hIdx));
  const meshHeight = median(prep.sizes.map((s) => [s.x, s.y, s.z][hIdx]).filter((v) => v > 0));
  let units, unitsReason, suggest = null;
  const declaredUnits = prep.declared?.units || null;
  if (w.units && w.units !== "auto") { units = w.units; unitsReason = "set by you"; }
  else if (preset) { units = preset.units; unitsReason = `${U.SOURCE_PRESETS[w.source].label} convention`; }
  else {
    const g = U.guessUnits({ declared: declaredUnits, height, span, meshHeight });
    units = g.units; unitsReason = g.reason;
    if (g.suggest) suggest = { factor: g.suggest / g.factor, text: g.reason };
  }
  const factor = (U.UNIT_TO_M[units] || 1) * (w.scale_mul || 1);
  if (!suggest && (!w.up || w.up === "auto") && !preset && declaredUp && vote.confident && vote.share > 0.5 && vote.up.replace("-", "") !== ax) {
    suggest = { up: vote.up, text: `most of its flat area faces ${vote.up.toUpperCase()}: it may be lying on its side` };
  }
  const quat = U.upAxisQuat(up);
  // Stage-space bounds: rotate the raw box corners, scale.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  if (!prep.bounds.isEmpty()) for (const cx of [prep.bounds.min.x, prep.bounds.max.x]) for (const cy of [prep.bounds.min.y, prep.bounds.max.y]) for (const cz of [prep.bounds.min.z, prep.bounds.max.z]) {
    const p = U.qrot(quat, [cx, cy, cz]).map((v) => v * factor);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  }
  // Main floor: up-facing area per 5 cm height bin.
  const bins = new Map();
  for (const s of prep.soup) {
    const t = s.tris;
    for (let o = 0; o < t.length; o += 9) {
      const a = U.qrot(quat, [t[o], t[o + 1], t[o + 2]]), b = U.qrot(quat, [t[o + 3], t[o + 4], t[o + 5]]), c = U.qrot(quat, [t[o + 6], t[o + 7], t[o + 8]]);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, l = Math.hypot(cx, cy, cz);
      if (!(l > 0) || cy / l < 0.9) continue;
      const y = ((a[1] + b[1] + c[1]) / 3) * factor, k = Math.round(y / 0.05);
      bins.set(k, (bins.get(k) || 0) + (l / 2) * factor * factor);
    }
  }
  const floor = bins.size ? U.floorFromBins([...bins].map(([k, v]) => [k * 0.05, v])) : (isFinite(min[1]) ? min[1] : 0);
  // Keep the file's own origin when it is inside the world (round trips land where they started); else centre it.
  const inside = isFinite(min[0]) && min[0] <= 0 && max[0] >= 0 && min[2] <= 0 && max[2] >= 0;
  const recenter = w.recenter === true || (w.recenter !== false && !inside);
  const cx = recenter && isFinite(min[0]) ? (min[0] + max[0]) / 2 : 0, cz = recenter && isFinite(min[2]) ? (min[2] + max[2]) / 2 : 0;
  const offset = [-cx, -floor + (w.lift || 0), -cz];
  const size = isFinite(min[0]) ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0];
  return { up, units, factor, quat, offset, size, floor, suggest, reasons: { up: upReason, units: unitsReason }, sig: JSON.stringify([up, factor, offset]) };
}

/** Stage-space collider boxes for a prepared world under a transform (in the stage's _setColliders format). */
export function collidersFor(prep, xf, opts = {}) {
  const meshes = [];
  for (const s of prep.soup) {
    if (!s.solid) continue;
    const t = s.tris, out = new Float32Array(t.length);
    for (let o = 0; o < t.length; o += 3) {
      const p = U.qrot(xf.quat, [t[o], t[o + 1], t[o + 2]]);
      out[o] = p[0] * xf.factor + xf.offset[0]; out[o + 1] = p[1] * xf.factor + xf.offset[1]; out[o + 2] = p[2] * xf.factor + xf.offset[2];
    }
    meshes.push({ name: s.name, tris: out });
  }
  const { boxes, dropped } = worldColliders(meshes, opts);
  return {
    list: boxes.map((b, i) => ({ id: `world_${i}`, shape: "box", half: b.half, center: [0, 0, 0], dynamic: false, kind: b.kind,
      poses: [{ pos: b.pos, quat: b.quat }] })),
    dropped,
  };
}

/** Soundstage camera keys for a camera object, sampled at `frames` frames of `fps` (setTime moves the animation). */
export function cameraKeys(cam, { frames = 1, fps = 24, setTime = null, stageAspect = 1.85, root = null } = {}) {
  const keys = [];
  let roll = 0;
  for (let f = 0; f < frames; f++) {
    if (setTime) setTime(f / fps);
    (root || cam).updateMatrixWorld(true);
    const k = U.keyFromMatrix(cam.matrixWorld.elements, 10, { forwardX: !!cam.userData?.forwardX });
    const aspect = cam.aspect && Math.abs(cam.aspect - 1) > 1e-3 ? cam.aspect : stageAspect;
    const ud = cam.userData || {};
    const focal = ud.fbxFocal && ud.filmWidthMm ? (ud.fbxFocal * U.SENSOR_W_MM) / ud.filmWidthMm : U.focalFromVfov(fovAt(cam, f / fps) || 40, aspect);
    roll = Math.max(roll, Math.abs(k.roll_deg));
    const r = (v) => +v.toFixed(4);
    keys.push({ frame: f, position: k.position.map(r), target: k.target.map(r), focal_mm: +focal.toFixed(2) });
  }
  return { keys, roll };
}

// ---------------------------------------------------------------- the mount (one per stage)

export class WorldMount {
  constructor(stage) {
    this.s = stage;
    this.prep = null;        // prepared mesh world or {splat}
    this.url = null;
    this.group = null;       // stage-space root: group > xform > file scene
    this.xform = null;
    this.mixer = null;
    this.xf = null;          // resolved transform
    this.info = null;
    this._col = { sig: "", list: [], dropped: 0 };
    this._loading = null;
    this.onInfo = null;      // UI callback(info)
  }

  get sig() { return this.group?.parent ? `${this.url}|${this.xf?.sig || ""}|${this.s.state.world?.colliders !== false}` : ""; }

  /** stage._buildSet hook: (re)attach the world after the set rebuilds. */
  attach() {
    const w = this.s.state.world;
    if (!w?.url) { this._drop(); this._ground(false); return; }
    if (this.prep && this.url === w.url) {
      this.s.root.add(this.group);
      this._apply(true);
      this._ground(w.hide_ground !== false);
      return;
    }
    this._ground(w.hide_ground !== false);
    this._load(w);
  }

  _ground(hide) { if (this.s.ground) this.s.ground.visible = !hide || !this.group; }

  _drop() {
    if (this.group) this.group.removeFromParent();
    this.prep = null; this.url = null; this.group = null; this.xform = null; this.mixer = null; this.xf = null; this.info = null;
    this._col = { sig: "", list: [], dropped: 0 };
  }

  _load(w) {
    if (this._loading?.url === w.url) return this._loading.p;
    const url = w.url;
    this.s.onStatus?.(`Loading the world ${w.name || ""}…`);
    const p = (async () => {
      const fmt = w.format || extOf(w.name || url) || "glb";
      const splat = WORLD_SPLAT_FORMATS.includes(fmt) || (fmt === "ply" && await plyIsSplat(url));
      const prep = splat ? await this._prepSplat(url) : prepareWorld(await loadWorldFile(url, fmt, { files: w.files || {} }), { merge: w.merge !== false });
      if (this.s.state.world?.url !== url) return null;   // replaced meanwhile
      this._drop();
      this.prep = prep; this.url = url;
      this.group = new THREE.Group();
      this.group.name = "world";
      this.group.userData.world = true;
      this.xform = new THREE.Group();
      this.xform.name = "world_xform";
      this.group.add(this.xform);
      this.xform.add(prep.scene);
      if (prep.animations?.length) {
        this.mixer = new THREE.AnimationMixer(prep.scene);
        this.actions = prep.animations.map((clip) => {
          const a = this.mixer.clipAction(clip);
          a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
          return a;
        });
        this.setTime(0);
      }
      this.s.root.add(this.group);
      this._apply();
      this._ground(w.hide_ground !== false);
      this._importCameras(true);
      this.s.setFrame(this.s.frame);
      this.s._applySplatVisibility?.(this.s.view);
      this.s._kickSplats?.();
      this.s.onChange(this.s.toJSON());
      this.s.onStatus?.(this.info?.readout ? `${this.info.readout}.` : "World loaded.");
      return this.info;
    })().catch((err) => {
      console.warn("Soundstage: world load failed", err);
      this.s.onStatus?.(`Couldn't load the world: ${err.message}`);
      this.onInfo?.({ error: err.message });
      return null;
    }).finally(() => { if (this._loading?.p === p) this._loading = null; });
    this._loading = { url, p };
    return p;
  }

  async _prepSplat(url) {
    const { SparkRenderer, SplatMesh } = await import("../../vendor/spark.module.min.mjs");
    if (!this.s._spark) { this.s._spark = new SparkRenderer({ renderer: this.s.renderer }); this.s.scene.add(this.s._spark); }
    const splat = new SplatMesh({ url });
    await splat.initialized;
    splat.userData.splatOnly = true;
    const scene = new THREE.Group();
    scene.add(splat);
    const bb = splat.getBoundingBox?.() || new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    return { splat: true, scene, animations: [], declared: { up: "-y", units: null }, cameras: [], anim: new Set(), sky: new Set(), soup: [],
      bounds: bb, area: { x: [0, 0], y: [1, 0], z: [0, 0] }, sizes: [], stats: { meshes: 0, draws: 1, tris: 0, lods: 0, lights: 0, cameras: 0, animated: 0, materials: 0, sky: 0 } };
  }

  /** Apply units / up / floor to the transform; rebuild colliders and the readout when they changed. */
  _apply(cached = false) {
    const w = this.s.state.world || {};
    if (!this.prep) return;
    // _buildSet runs on most edits: skip the work when nothing about the world changed.
    const key = JSON.stringify([w.source, w.up, w.units, w.scale_mul, w.lift, w.recenter, w.colliders, this.s.fw / this.s.fh]);
    if (cached && key === this._applyKey && this.xf) { this.s.live?.invalidate?.(); return; }
    this._applyKey = key;
    const auto = (v) => !v || v === "auto";
    const xf = resolveTransform(this.prep, this.prep.splat ? { ...w, up: auto(w.up) ? "-y" : w.up, units: auto(w.units) ? "m" : w.units } : w);
    if (this.prep.splat && auto(w.units)) xf.reasons.units = "splats carry no units: set a known height";
    this.xf = xf;
    this.xform.quaternion.set(...xf.quat);
    this.xform.scale.setScalar(xf.factor);
    this.xform.position.set(...xf.offset);
    this.group.updateMatrixWorld(true);
    this.group.traverse((o) => { if (o.isLOD && o.userData.lodRaw) { o.levels[1].distance = o.userData.lodRaw * xf.factor; o.autoUpdate = true; } });
    // A big world needs a longer camera reach.
    const reach = Math.hypot(...xf.size) * 1.6;
    for (const cam of [this.s.camera, this.s.viewCam].filter(Boolean)) if (cam.far < reach) { cam.far = Math.min(20000, reach); cam.updateProjectionMatrix(); }
    const colSig = `${xf.sig}|${w.colliders !== false}`;
    if (this._col.sig !== colSig) {
      const t0 = performance.now();
      const c = w.colliders === false || this.prep.splat ? { list: [], dropped: 0 } : collidersFor(this.prep, xf);
      this._col = { sig: colSig, list: c.list, dropped: c.dropped, ms: Math.round(performance.now() - t0) };
      this.s._setColCache = null;
      this.s.live?.invalidate?.();
    }
    const st = this.prep.stats;
    const fixes = [];
    if (xf.suggest?.factor) fixes.push({ kind: "scale", factor: xf.suggest.factor, label: `Fix scale ×${+xf.suggest.factor.toPrecision(3)}`, text: xf.suggest.text });
    if (xf.suggest?.up) fixes.push({ kind: "up", up: xf.suggest.up, label: `Stand it up (${xf.suggest.up.toUpperCase()} up)`, text: xf.suggest.text });
    const kinds = {};
    for (const c of this._col.list) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    this.info = {
      name: w.name || "world", splat: !!this.prep.splat, format: w.format, size: xf.size.map((v) => +v.toFixed(2)),
      readout: U.sizeReadout(xf.size), up: xf.up, units: xf.units, factor: xf.factor, reasons: xf.reasons, floor: +xf.floor.toFixed(3), offset: xf.offset.map((v) => +v.toFixed(3)),
      fixes, ...st, colliders: this._col.list.length, colliderKinds: kinds, collidersDropped: this._col.dropped, colliderMs: this._col.ms,
      shots: (this.s.state.shots || []).filter((x) => x.from_world === this.url).map((x) => x.name),
    };
    this.onInfo?.(this.info);
  }

  /** Cameras in the file -> shots (re-keyed when units / axes change, so they stay locked to the world). */
  _importCameras(first) {
    const w = this.s.state.world;
    if (!this.prep?.cameras?.length || !w) return;
    const sig = this.xf?.sig || "";
    if (!first && w.cam_sig === sig) return;
    if (first && w.cam_sig === sig && (this.s.state.shots || []).some((x) => x.from_world === this.url)) return;   // a saved scene: keys already there
    const fps = this.s.state.shot?.fps || 24;
    const clipLen = Math.max(0, ...(this.prep.animations || []).map((c) => c.duration || 0));
    const shots = this.s._shots();
    let firstId = null, longest = 1;
    this.prep.cameras.forEach((cam, i) => {
      const animated = underAnimated(cam, this.prep.anim, this.prep.scene);
      const frames = animated ? Math.min(1440, Math.max(1, Math.round(clipLen * fps) + 1)) : 1;
      longest = Math.max(longest, frames);
      const { keys, roll } = cameraKeys(cam, { frames, fps, root: this.group, stageAspect: this.s.fw / this.s.fh,
        setTime: animated && this.mixer ? (t) => this.setTime(t) : null });
      const id = `shot_world_${i}`;
      const name = `${cam.name || "Camera"} (from ${w.name || "file"})`;
      let shot = shots.find((x) => x.id === id);
      if (!shot) { shot = { id, name, setup: "imported" }; shots.push(shot); }
      Object.assign(shot, { camera_keys: keys, from_world: this.url, roll_deg_dropped: +roll.toFixed(2) });
      if (!firstId) firstId = id;
    });
    this.setTime(this.s.frame / fps);
    if (first && w.cam_sig == null) {
      if (firstId) this.s.state.active_shot = firstId;
      if (longest > (this.s.state.shot?.frames || 97)) this.s.state.shot = { ...(this.s.state.shot || {}), frames: longest };
    }
    w.cam_sig = sig;
    this.s._rigCache = null;
    this.s.onShots?.();
  }

  /** setFrame hook: file animation plays on the shot timeline. */
  setTime(t) {
    if (!this.mixer) return;
    // A once-through clip that ran to its end pauses itself; wake every action so scrubbing back works.
    for (const a of this.actions || []) { a.enabled = true; a.paused = false; }
    this.mixer.setTime(t);
  }

  /** _setColliders hook. */
  colliders() { return this.group?.parent ? this._col.list : []; }

  // ---------------------------------------------------------------- public API (the import panel and the agent)

  /** Make a file the Set. opts: {name, format, files, source}. Resolves the readout info. */
  importWorld(url, opts = {}) {
    const s = this.s;
    const name = opts.name || decodeURIComponent(String(url).split(/[?#]/)[0].split("/").pop() || "world");
    s.state.world = { url, name: name.replace(/\.[a-z0-9]+$/i, ""), format: opts.format || extOf(name) || "glb", files: opts.files || {},
      source: opts.source || "auto", up: opts.up || "auto", units: opts.units || "auto", scale_mul: 1, lift: 0, hide_ground: true, colliders: true,
      ...(opts.temporary ? { temporary: true } : {}) };
    s.state.environment = { ...(s.state.environment || {}), set: "empty" };
    s._buildSet();
    s.setFrame(s.frame);
    s.onChange(s.toJSON());
    return this._loading?.p || Promise.resolve(this.info);
  }

  /** Change world settings: {source, up, units, scale_mul, lift, recenter, hide_ground, colliders}. */
  setWorld(patch) {
    const w = this.s.state.world;
    if (!w) return null;
    Object.assign(w, patch);
    if (this.prep) {
      this._apply();
      this._ground(w.hide_ground !== false);
      this._importCameras(false);
      this.s.setFrame(this.s.frame);
    }
    this.s.onChange(this.s.toJSON());
    return this.info;
  }

  /** One-click fix from info.fixes. */
  applyFix(fix) {
    const w = this.s.state.world;
    if (!w || !fix) return null;
    if (fix.kind === "scale") return this.setWorld({ scale_mul: (w.scale_mul || 1) * fix.factor });
    if (fix.kind === "up") return this.setWorld({ up: fix.up });
    return null;
  }

  /** Scale the world so it is `metres` tall (a splat, or a world you know the size of). */
  setHeight(metres) {
    if (!this.info || !(metres > 0) || !(this.info.size[1] > 0)) return null;
    return this.setWorld({ scale_mul: (this.s.state.world.scale_mul || 1) * (metres / this.info.size[1]) });
  }

  /** Match the shot length to the file's animation. */
  matchShotLength() {
    const fps = this.s.state.shot?.fps || 24;
    const len = Math.max(0, ...(this.prep?.animations || []).map((c) => c.duration || 0));
    if (!len) return false;
    this.s.state.shot = { ...(this.s.state.shot || {}), frames: Math.round(len * fps) + 1 };
    this.s.setFrame(Math.min(this.s.frame, this.s.state.shot.frames - 1));
    this.s.onChange(this.s.toJSON());
    return true;
  }

  removeWorld() {
    const s = this.s;
    delete s.state.world;
    s.state.shots = (s.state.shots || []).filter((x) => !x.from_world);
    if (!s.state.shots.length) delete s.state.shots;
    if (!s.state.shots?.some((x) => x.id === s.state.active_shot)) delete s.state.active_shot;
    this._drop();
    s._setColCache = null;
    s._buildSet();
    s.setFrame(s.frame);
    s.onShots?.();
    s.onChange(s.toJSON());
  }
}
