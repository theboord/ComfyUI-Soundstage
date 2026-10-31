// Send it back out (Milestone 12): the staged shot as a kit Blender, Unreal, Maya and Nuke can open.
//
//   scene.glb          the whole stage (set or imported world, props, actors, lights) with every move baked to keys
//                      (one key a frame for whatever moves), plus the shot camera "shot_cam" keyed per frame; its lens
//                      animation rides along as KHR_animation_pointer (/cameras/N/perspective/yfov) and as extras
//   set_frame1001.obj  frame-one geometry in world space (Nuke ReadGeo, Maya without a glTF importer)
//   camera.json        the exact camera per frame (the Layer Pack's format: cam_to_world, focal, Nuke/Maya ZXY angles)
//   shot_cam.chan      Nuke / Maya .chan
//   shot.json          fps, frame range, resolution, sensor, file names, axis-probe positions
//   blender/ unreal/ maya/ nuke/   builder scripts that read the above (interop/dcc/*.py)
//   README.txt
// World convention throughout: metres, Y up, right-handed (glTF's own), frames numbered from 1001 (Layer Pack).
import * as THREE from "../../vendor/three.module.min.mjs";
import { GLTFExporter } from "../../vendor/addons/GLTFExporter.mjs";
import { zipSync, strToU8 } from "../../vendor/addons/fflate.module.mjs";
import * as U from "./units.mjs";

export const KIT_FRAME_START = 1001;
export const BUILDERS = { blender: "build_blender.py", unreal: "build_unreal.py", maya: "build_maya.py", nuke: "build_nuke.py" };
/** Axis probes: tiny marker cubes at known stage points, so an importer's axis / unit mapping can be measured. */
export const PROBES = { ss_probe_o: [0, 0, 0], ss_probe_x: [1, 0, 0], ss_probe_y: [0, 1, 0], ss_probe_z: [0, 0, 1] };

const safeName = (s) => String(s || "obj").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "obj";

/**
 * Local TRS of `nodes` over `frames` frames: pose(f) poses the scene at frame f. Returns a Map node ->
 * {pos?, quat?, scale?} (Float32Arrays, frames x 3 / 4) holding only the channels that change.
 */
export function sampleNodeTracks(nodes, frames, pose, eps = 1e-6) {
  const base = nodes.map((o) => ({ p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() }));
  const out = new Map();
  const chan = (o, i, key, size) => {
    let e = out.get(o);
    if (!e) out.set(o, (e = {}));
    if (!e[key]) {   // backfill: unchanged until now means equal to frame 0
      const b = key === "pos" ? base[i].p : key === "quat" ? base[i].q : base[i].s;
      e[key] = new Float32Array(frames * size);
      for (let f = 0; f < frames; f++) e[key].set(b, f * size);
    }
    return e[key];
  };
  const differs = (a, b) => { for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > eps) return true; return false; };
  for (let f = 0; f < frames; f++) {
    pose(f);
    nodes.forEach((o, i) => {
      const p = o.position.toArray(), q = o.quaternion.toArray(), s = o.scale.toArray();
      const e = out.get(o);
      if (e?.pos || differs(p, base[i].p)) chan(o, i, "pos", 3).set(p, f * 3);
      if (e?.quat || differs(q, base[i].q)) {
        const arr = chan(o, i, "quat", 4);
        if (f > 0) {   // keep quaternions on one hemisphere so keys never spin the long way round
          const d = arr[(f - 1) * 4] * q[0] + arr[(f - 1) * 4 + 1] * q[1] + arr[(f - 1) * 4 + 2] * q[2] + arr[(f - 1) * 4 + 3] * q[3];
          if (d < 0) for (let k = 0; k < 4; k++) q[k] = -q[k];
        }
        arr.set(q, f * 4);
      }
      if (e?.scale || differs(s, base[i].s)) chan(o, i, "scale", 3).set(s, f * 3);
    });
  }
  return out;
}

/** An AnimationClip from sampled tracks (bound by uuid, which GLTFExporter resolves). */
export function clipFromTracks(name, tracks, frames, fps) {
  const times = Float32Array.from({ length: frames }, (_, f) => f / fps);
  const list = [];
  for (const [o, e] of tracks) {
    if (e.pos) list.push(new THREE.VectorKeyframeTrack(`${o.uuid}.position`, times, e.pos));
    if (e.quat) list.push(new THREE.QuaternionKeyframeTrack(`${o.uuid}.quaternion`, times, e.quat));
    if (e.scale) list.push(new THREE.VectorKeyframeTrack(`${o.uuid}.scale`, times, e.scale));
  }
  return new THREE.AnimationClip(name, frames > 1 ? (frames - 1) / fps : 0, list);
}

// ---------------------------------------------------------------- GLB post-processing

/** Split a GLB into {json, bin}. */
export function readGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  let o = 12, json = null, bin = new Uint8Array(0);
  while (o < buf.byteLength) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    const chunk = new Uint8Array(buf, o + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk.slice();
    o += 8 + len;
  }
  return { json, bin };
}

export function writeGLB(json, bin) {
  const pad = (n) => (4 - (n % 4)) % 4;
  let jb = new TextEncoder().encode(JSON.stringify(json));
  const jp = pad(jb.length);
  const jsonChunk = new Uint8Array(jb.length + jp).fill(0x20);
  jsonChunk.set(jb);
  const bp = pad(bin.length);
  const binChunk = new Uint8Array(bin.length + bp);
  binChunk.set(bin);
  const total = 12 + 8 + jsonChunk.length + (bin.length ? 8 + binChunk.length : 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  if (bin.length) {
    const o = 20 + jsonChunk.length;
    dv.setUint32(o, binChunk.length, true); dv.setUint32(o + 4, 0x004e4942, true);
    out.set(binChunk, o + 8);
  }
  return out.buffer;
}

/**
 * Add a KHR_animation_pointer channel animating a camera's yfov (radians, one value a frame) to the first animation,
 * reusing the camera node's own time accessor. Returns the new GLB (or the input when there is nothing to add).
 */
export function addFovAnimation(glb, camNodeName, yfovs) {
  const { json, bin } = readGLB(glb);
  const ni = (json.nodes || []).findIndex((n) => n.name === camNodeName);
  const ci = ni >= 0 ? json.nodes[ni].camera : undefined;
  const anim = json.animations?.[0];
  if (ci === undefined || !anim) return glb;
  const ch = anim.channels.find((c) => c.target.node === ni) || anim.channels[0];
  const input = anim.samplers[ch.sampler].input;
  if (json.accessors[input].count !== yfovs.length) return glb;
  const vals = new Float32Array(yfovs);
  const off = Math.ceil(bin.length / 4) * 4;
  const nb = new Uint8Array(off + vals.byteLength);
  nb.set(bin);
  nb.set(new Uint8Array(vals.buffer), off);
  json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: vals.byteLength });
  json.buffers[0].byteLength = nb.length;
  json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: vals.length, type: "SCALAR",
    min: [Math.min(...vals)], max: [Math.max(...vals)] });
  anim.samplers.push({ input, output: json.accessors.length - 1, interpolation: "LINEAR" });
  anim.channels.push({ sampler: anim.samplers.length - 1,
    target: { path: "pointer", extensions: { KHR_animation_pointer: { pointer: `/cameras/${ci}/perspective/yfov` } } } });
  json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), "KHR_animation_pointer"])];
  return writeGLB(json, nb);
}

// ---------------------------------------------------------------- OBJ

/** World-space OBJ (+ MTL) of the visible meshes under root. Returns {obj, mtl, tris, skipped}. */
export function sceneOBJ(root, { name = "set", maxTris = 1500000, skip = () => false } = {}) {
  root.updateMatrixWorld(true);
  const lines = [`# Soundstage set, metres, Y up (frame ${KIT_FRAME_START})`, `mtllib ${name}.mtl`];
  const mats = new Map(), mtl = [];
  let vBase = 1, tris = 0, skipped = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  const used = new Map();
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || skip(o)) return;
    const g = o.geometry, pos = g.attributes.position, idx = g.index, nrm = g.attributes.normal;
    const n = idx ? idx.count : pos.count;
    if (tris + n / 3 > maxTris) { skipped++; return; }
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    let mname = mats.get(mat);
    if (!mname) {
      mname = `${safeName(mat?.name || "mat")}_${mats.size}`;
      mats.set(mat, mname);
      const c = mat?.color || new THREE.Color(0.6, 0.6, 0.6);
      mtl.push(`newmtl ${mname}`, `Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`, "");
    }
    let label = safeName(o.name || o.parent?.name || "mesh");
    used.set(label, (used.get(label) || 0) + 1);
    if (used.get(label) > 1) label += `_${used.get(label)}`;
    lines.push(`o ${label}`, `usemtl ${mname}`);
    nm.getNormalMatrix(o.matrixWorld);
    const flip = o.matrixWorld.determinant() < 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      lines.push(`v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${v.z.toFixed(5)}`);
      lo[0] = Math.min(lo[0], v.x); lo[1] = Math.min(lo[1], v.y); lo[2] = Math.min(lo[2], v.z);
      hi[0] = Math.max(hi[0], v.x); hi[1] = Math.max(hi[1], v.y); hi[2] = Math.max(hi[2], v.z);
    }
    if (nrm) for (let i = 0; i < nrm.count; i++) { v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize(); lines.push(`vn ${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}`); }
    for (let t = 0; t + 2 < n; t += 3) {
      let a = (idx ? idx.getX(t) : t) + vBase, b = (idx ? idx.getX(t + 1) : t + 1) + vBase, c = (idx ? idx.getX(t + 2) : t + 2) + vBase;
      if (flip) [b, c] = [c, b];
      lines.push(nrm ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
    }
    vBase += pos.count;
    tris += n / 3;
  });
  const bounds = isFinite(lo[0]) ? { min: lo.map((x) => +x.toFixed(4)), max: hi.map((x) => +x.toFixed(4)) } : null;
  return { obj: lines.join("\n") + "\n", mtl: mtl.join("\n"), tris, skipped, bounds };
}

// ---------------------------------------------------------------- the animated GLB of the stage

/**
 * The whole stage as one animated GLB. Returns {glb (ArrayBuffer), frames, fps, moving (node count), names, focal}.
 */
export async function stageAnimatedGLB(stage, { probes = true } = {}) {
  const s = stage, root = s.root;
  const keep = s.frame, last = s._lastFrame(), N = last + 1, fps = s.state.shot?.fps || 24;
  const aspect = s.fw / s.fh;
  const undo = [];
  const hide = (o) => { if (o && o.visible) { o.visible = false; undo.push(() => { o.visible = true; }); } };
  const rename = (o, n) => { if (!o) return; const old = o.name; o.name = n; undo.push(() => { o.name = old; }); };
  // Viewport helpers and what glTF can't carry stay out: selection ring, light handles, weather particles, splats.
  hide(s.selRing);
  for (const h of s.lightHandles?.values() || []) hide(h);
  hide(s.weather?.object);
  root.traverse((o) => { if (o.userData.splatOnly) hide(o); });
  root.traverse((o) => { if (o.userData.proxyOnly && !o.visible) { o.visible = true; undo.push(() => { o.visible = false; }); } });
  // Readable names in the DCC outliners.
  const taken = new Set();
  const uniq = (n) => { let k = safeName(n), i = 2; while (taken.has(k)) k = `${safeName(n)}_${i++}`; taken.add(k); return k; };
  const names = {};
  for (const a of s.state.actors || []) { const g = s.actorMeshes.get(a.id); if (g) { const n = uniq(a.name || a.id); rename(g, n); names[a.id] = n; } }
  rename(s.ground, uniq("ground"));
  if (s._setGroup) rename(s._setGroup, uniq("set"));
  if (s.interiorGroup) rename(s.interiorGroup, uniq("interior"));
  if (s.worldMount?.group) rename(s.worldMount.group, uniq("world"));
  // The shot camera and the axis probes.
  const c0 = s._shotCameraAt(0);
  const cam = new THREE.PerspectiveCamera(U.vfovFromFocal(c0.focal_mm, aspect), aspect, 0.1, 2000);
  cam.name = "shot_cam";
  root.add(cam);
  undo.push(() => cam.removeFromParent());
  if (probes) {
    const pg = new THREE.Group();
    pg.name = "soundstage_axis_probes";
    const geo = new THREE.BoxGeometry(0.02, 0.02, 0.02), mat = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    for (const [n, p] of Object.entries(PROBES)) { const m = new THREE.Mesh(geo, mat); m.name = n; m.position.set(...p); pg.add(m); }
    root.add(pg);
    undo.push(() => pg.removeFromParent());
  }
  const focal = [];
  const pose = (f) => {
    s.setFrameSilent(f);
    const c = s._shotCameraAt(f);
    cam.position.set(...c.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(new THREE.Vector3(...c.target));
    if (c.roll) cam.rotateZ(c.roll);
    cam.fov = U.vfovFromFocal(c.focal_mm, aspect);
    cam.updateProjectionMatrix();
    focal[f] = c.focal_mm;
  };
  let glb;
  try {
    pose(0);
    const nodes = [];
    root.traverseVisible((o) => { if (o !== root) nodes.push(o); });
    const tracks = sampleNodeTracks(nodes, N, pose);
    pose(0);
    cam.fov = U.vfovFromFocal(focal[0], aspect);
    cam.updateProjectionMatrix();
    cam.userData = { soundstage: { focal_mm: focal.map((v) => +v.toFixed(4)), frame_start: KIT_FRAME_START, fps, sensor_width_mm: U.SENSOR_W_MM } };
    const clip = clipFromTracks("soundstage_shot", tracks, N, fps);
    glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, trs: true, animations: clip.tracks.length ? [clip] : [] });
    if (focal.some((v) => Math.abs(v - focal[0]) > 1e-4) && clip.tracks.length) {
      glb = addFovAnimation(glb, "shot_cam", focal.map((f) => (U.vfovFromFocal(f, aspect) * Math.PI) / 180));
    }
    return { glb, frames: N, fps, moving: tracks.size, names, focal };
  } finally {
    for (const f of undo.reverse()) f();
    s.setFrame(keep);
  }
}

// ---------------------------------------------------------------- the kit

async function builderText(file) {
  const r = await fetch(new URL(`./dcc/${file}`, import.meta.url));
  if (!r.ok) throw new Error(`builder ${file} missing (${r.status})`);
  return r.text();
}

export function kitReadme({ shot, fps, frameStart, frameEnd, width, height, obj }) {
  return `Soundstage -> Blender · Unreal · Maya · Nuke   (shot "${shot}", ${width}x${height}, ${fps} fps, frames ${frameStart}-${frameEnd})

Everything is in metres, Y up, right-handed (glTF's convention). The camera is "shot_cam": a 36 mm wide sensor,
horizontal fit, keyed every frame. Frame ${frameStart} is Soundstage frame 0.

  scene.glb            the whole stage, every move baked to keys (one a frame), plus shot_cam
  ${obj ? `${obj.padEnd(20)} frame-${frameStart} geometry in world space (for Nuke ReadGeo / Maya without glTF)` : "(no OBJ: the set is too heavy; use scene.glb)"}
  camera.json          the exact camera per frame (cam_to_world, focal_mm, Nuke/Maya ZXY rotations)
  shot_cam.chan        Nuke / Maya .chan (tx ty tz rx ry rz vfov, rotate order ZXY)
  shot.json            fps, frame range, resolution, sensor, file names

BLENDER (verified headless in Blender 4.3: camera framing matches the Soundstage clay frame)
  blender --python blender/build_blender.py
  or Scripting tab > Open > blender/build_blender.py > Run. Imports scene.glb, builds shot_cam from camera.json
  (sensor 36 mm, lens keyed), sets fps, frame range and resolution. Optional: put the Layer Pack plates next to the
  kit in plates/ and they show as the camera background.  Headless check render:
  blender --background --python blender/build_blender.py -- --render check.png --frame ${frameStart}

UNREAL ENGINE 5.x (NOT tested in Unreal: written against the UE 5 Python API)
  Enable the Python Editor Script plugin (and glTF / Interchange, on by default in 5.x).
  Tools > Execute Python Script... > unreal/build_unreal.py  (or: py "<kit>/unreal/build_unreal.py" in the console)
  Imports scene.glb into the open level, spawns a CineCameraActor with a 36 mm filmback, builds a Level Sequence at
  ${fps} fps over frames ${frameStart}-${frameEnd} with the camera's transform and focal length keyed, and a camera cut.
  Unreal is centimetres, Z up, left-handed: the script measures the importer's axes from the four ss_probe_* markers.

MAYA (NOT tested in Maya)
  Script Editor (Python) > File > Source Script... > maya/build_maya.py
  Imports scene.glb when a glTF importer is loaded, else the OBJ; creates shot_cam keyed from camera.json
  (rotate order zxy, focal length, 36 mm film back) in your scene's working units; sets fps and range.

NUKE 13+ (NOT tested in Nuke)
  Script Editor > File > Source... > nuke/build_nuke.py   (or: nuke -t nuke/build_nuke.py)
  Camera keyed from camera.json (rot order ZXY, haperture 36 mm), ReadGeo of the OBJ, Scene and ScanlineRender.
`;
}

/**
 * Build the whole kit. Returns {zip (Uint8Array), name, files: {path: Uint8Array}, report}.
 * opts: {frameStart, obj (true), onProgress}
 */
export async function exportForDCC(stage, { frameStart = KIT_FRAME_START, obj = true, onProgress = null } = {}) {
  const s = stage;
  const shotName = s.activeShot?.()?.name || "shot";
  const base = `soundstage_${safeName(shotName)}`;
  const fps = s.state.shot?.fps || 24, W = s.fw, H = s.fh;
  onProgress?.("Baking the moves…");
  const g = await stageAnimatedGLB(s);
  onProgress?.("Writing the camera and builders…");
  const track = s.cameraTrack().map((c) => ({ position: c.position, target: c.target, focal_mm: c.focal_mm, roll_deg: c.roll ? (c.roll * 180) / Math.PI : 0 }));
  const frames = U.cameraFrames(track, W, H, frameStart);
  const camJson = U.cameraJSON(frames, { width: W, height: H, fps, frameStart });
  const files = {};
  const put = (p, data) => { files[`${base}/${p}`] = typeof data === "string" ? strToU8(data) : new Uint8Array(data); };
  put("scene.glb", g.glb);
  put("camera.json", JSON.stringify(camJson, null, 1));
  put("shot_cam.chan", U.chanText(frames));
  let objName = null, objInfo = null;
  if (obj) {
    s.setFrameSilent(0);
    const handles = new Set(s.lightHandles?.values() || []);
    objInfo = sceneOBJ(s.root, { name: `set_frame${frameStart}`, skip: (o) => o.userData.worldSky || o.userData.splatOnly || o === s.selRing || handles.has(o) });
    s.setFrame(s.frame);
    if (objInfo.tris > 0) {
      objName = `set_frame${frameStart}.obj`;
      put(objName, objInfo.obj);
      put(`set_frame${frameStart}.mtl`, objInfo.mtl);
    }
  }
  const shot = {
    soundstage_kit: 1, shot: shotName, fps, frame_start: frameStart, frame_end: frameStart + g.frames - 1, frames: g.frames,
    resolution: [W, H], sensor_width_mm: U.SENSOR_W_MM, units: "m", up: "y", handedness: "right",
    scene_glb: "scene.glb", scene_obj: objName, bounds_m: objInfo?.bounds || null, camera_json: "camera.json", chan: "shot_cam.chan", camera_node: "shot_cam",
    probes: PROBES, objects: (s.state.actors || []).map((a) => ({ id: a.id, name: g.names[a.id] || a.name, kind: a.kind })),
    world: s.state.world ? { name: s.state.world.name, url: s.state.world.temporary ? null : s.state.world.url } : null,
  };
  put("shot.json", JSON.stringify(shot, null, 1));
  for (const [app, file] of Object.entries(BUILDERS)) put(`${app}/${file}`, await builderText(file));
  put("README.txt", kitReadme({ shot: shotName, fps, frameStart, frameEnd: shot.frame_end, width: W, height: H, obj: objName }));
  const zip = zipSync(files, { level: 6 });
  return { zip, name: `${base}.zip`, files, report: { frames: g.frames, moving: g.moving, glbBytes: g.glb.byteLength, objTris: objInfo?.tris || 0, objSkipped: objInfo?.skipped || 0 } };
}

/** Download the kit (browser). */
export async function downloadDCCKit(stage, opts = {}) {
  const kit = await exportForDCC(stage, opts);
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([kit.zip], { type: "application/zip" })), download: kit.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  return kit;
}
