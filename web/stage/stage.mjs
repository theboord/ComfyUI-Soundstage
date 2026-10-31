// Soundstage 3D stage: a small three.js set (actors, props, building, sun) seen through the
// shot camera. The viewport IS the shot camera, so what you frame is what gets rendered.
// Drag empty space = orbit (look around in place when close in or inside a car; Alt+drag anywhere), Shift+drag = pan,
// wheel = dolly (proportional, flies through the target), drag an actor = move it on the floor.
import * as THREE from "../vendor/three.module.min.mjs";
import { LIBRARY, SEATS, buildObject, buildFromRecipe, resolveKind, resolveCompound, makeGlass } from "./library.mjs";
import { applyPose, MOUNTS, applyJoints, mirrorPose, POSE_PRESETS } from "./humans.mjs";
import * as Mocap from "./mocap.mjs";
import { applyRig, RIGS } from "./camrig.mjs";
import { PoseGizmo } from "./posegizmo.mjs";
import { buildSet, buildWater, buildWeather } from "./environments.mjs";
import { buildCard, loadBackdrop, coverFit } from "./cards.mjs";
import { buildInterior, fixtureActors, interiorCamera, normalizeSpec, toStage } from "./interior.mjs";
import { GLTFLoader } from "../vendor/addons/GLTFLoader.mjs";
import { GLTFExporter } from "../vendor/addons/GLTFExporter.mjs";
import { FBXLoader } from "../vendor/addons/FBXLoader.mjs";
import { OBJLoader } from "../vendor/addons/OBJLoader.mjs";
import { PLYLoader } from "../vendor/addons/PLYLoader.mjs";
import { STLLoader } from "../vendor/addons/STLLoader.mjs";
import * as SkeletonUtils from "../vendor/addons/SkeletonUtils.mjs";
import { TransformControls } from "../vendor/addons/TransformControls.mjs";
import { simulate, bakeTrack, physicsOf, samplePos, sampleQuat, checkTracks } from "./physics.mjs";
import { LiveEdit } from "./live.mjs";
import { Highlighter } from "./outline.mjs";
import { zoomAt, frameSphere, easeInOut, decay } from "./manip.mjs";
import { WorldMount } from "./interop/importworld.mjs";

/**
 * Video → Stage: the set mesh is the first frame's depth, so the person in the shot is frozen into it. The clay actor
 * replaces them: drop the triangles that land inside their box in that frame at their distance. Mesh vertices are in
 * glTF camera axes (x right, y up, looking down -z) and depth units; cut = {box, K: [fx/w, fy/h, cx/w, cy/h], min_depth, max_depth}.
 */
function cutPerformer(model, cut) {
  const [fx, fy, cx, cy] = cut.K, [u0, v0, u1, v1] = cut.box;
  model.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const geo = o.geometry, pos = geo.attributes.position;
    const idx = geo.index ? geo.index.array : Array.from({ length: pos.count }, (_, i) => i);
    const keep = [];
    const v = new THREE.Vector3();
    for (let t = 0; t + 2 < idx.length; t += 3) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) { v.fromBufferAttribute(pos, idx[t + k]).applyMatrix4(o.matrix); x += v.x / 3; y += v.y / 3; z += v.z / 3; }
      const d = -z;
      const u = cx + (fx * x) / d, w = cy - (fy * y) / d;
      const hit = d > 0 && d < cut.max_depth * 2.5 && u > u0 && u < u1 && w > v0 && w < v1;
      if (!hit) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    geo.setIndex(keep);
  });
}

/** File extensions the stage can import. Gaussian splats render with Spark (loaded on first use). */
export const MESH_FORMATS = ["glb", "gltf", "fbx", "obj", "ply", "stl"];
export const SPLAT_FORMATS = ["spz", "splat", "ksplat", "sog"];
export const IMPORT_ACCEPT = [...MESH_FORMATS, ...SPLAT_FORMATS].map((x) => "." + x).join(",");
export const formatOf = (name) => (/\.([a-z0-9]+)(?:$|\?)/i.exec(name || "")?.[1] || "glb").toLowerCase();

let sparkModule = null;
const loadSpark = () => (sparkModule ??= import("../vendor/spark.module.min.mjs"));

/** A PLY can hold a mesh/point cloud or a 3D Gaussian splat; splats carry f_dc_* / scale_* properties. */
async function plyIsSplat(url) {
  const head = new TextDecoder().decode(await (await fetch(url, { headers: { Range: "bytes=0-4095" } })).arrayBuffer());
  return /property \w+ (f_dc_0|scale_0|opacity)\b/.test(head.split("end_header")[0]);
}

// Imported models are loaded once per URL and cloned per use. Resolves {scene, animations} or {splat: true}.
const assetCache = new Map();
function loadAsset(url, format) {
  const key = `${format}|${url}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const neutral = (geom) => {
    const nrm = geom.attributes.normal;
    if (!nrm || !nrm.array.some((v) => v !== 0)) geom.computeVertexNormals();
    const vc = !!geom.attributes.color;
    return new THREE.MeshStandardMaterial({ color: vc ? 0xffffff : 0xb9b4ac, vertexColors: vc, roughness: 0.8 });
  };
  const p = (async () => {
    if (SPLAT_FORMATS.includes(format) || (format === "ply" && await plyIsSplat(url))) return { splat: true };
    if (format === "glb" || format === "gltf") {
      const g = await new GLTFLoader().loadAsync(url);
      return { scene: g.scene, animations: g.animations || [] };
    }
    if (format === "fbx") { // Mixamo clips and characters included
      const o = await new FBXLoader().loadAsync(url);
      return { scene: o, animations: o.animations || [] };
    }
    if (format === "obj") return { scene: await new OBJLoader().loadAsync(url), animations: [] };
    const geom = await (format === "stl" ? new STLLoader() : new PLYLoader()).loadAsync(url);
    const obj = geom.index || format === "stl" ? new THREE.Mesh(geom, neutral(geom))
      : new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.02, vertexColors: !!geom.attributes.color }));
    const scene = new THREE.Group();
    scene.add(obj);
    return { scene, animations: [] };
  })();
  assetCache.set(key, p);
  p.catch(() => assetCache.delete(key));
  return p;
}
import { LIGHT_TYPES, TIME_PRESETS, solarPosition, hourForElevation, kelvinToColor, skyFor, describeLighting } from "./lighting.mjs";

/** Rigged CC0 horse (Quaternius, poly.pizza): Idle / Walk / Gallop skeletal cycles. */
const HORSE_GLB = new URL("./models/horse.glb", import.meta.url).href;
const HORSE_HEAD_RATIO = 1.42;   // ear-tip height / withers height for a horse standing head-up
const HORSE_BODY_Z = 0.53;       // barrel centre as a fraction of tail->nose length (the head reaches further forward)

/** Flashlight output 0..1 at a frame: steady, a nervous flicker, a slow blink, or off. */
function beamLevel(mode, f) {
  if (mode === "off") return 0;
  if (mode === "blink") return Math.floor(f / 10) % 2 ? 0 : 1;
  if (mode === "flicker") {
    const n = Math.sin(f * 12.9898) * 43758.5453;
    const r = n - Math.floor(n);
    return r < 0.12 ? 0.05 : 0.7 + 0.3 * r;
  }
  return 1;
}

/** Frames a timed mount takes to hop from standing into the saddle. */
const HOP_FRAMES = 10;

export const FRAME_W = 960;
export const FRAME_H = 512;
/** Delivery frame sizes: every side a multiple of 64 (LTX Layout-To-Render requirement). */
export const ASPECTS = {
  "1.85": { label: "1.85:1 (flat)", size: [960, 512] },
  "16:9": { label: "16:9", size: [1024, 576] },
  "2.39": { label: "2.39:1 (scope)", size: [1216, 512] },
  "9:16": { label: "9:16 (vertical)", size: [576, 1024] },
  "1:1": { label: "1:1", size: [768, 768] },
  "4:3": { label: "4:3", size: [768, 576] },
  "3:4": { label: "3:4", size: [576, 768] },
};
const SENSOR_W_MM = 36; // full-frame width; vertical FOV derives from the frame aspect
const DEPTH_NEAR = 1.0;
const DEPTH_FAR = 40.0;

/** Max turn rate (degrees per second) by kind: big animals and vehicles can't spin on the spot. */
const PERSON_KINDS = new Set(["man", "woman", "child"]);
/** In-car camera placements (car space, metres; +Z forward, +X = the car's left, driver on the left). */
export const CAR_SHOTS = {
  windshield: { label: "Through the windshield (two-shot)", position: [0, 1.22, 2.45], target: [0, 1.05, 0], focal_mm: 30 },
  driver_pov: { label: "Driver's POV (road ahead)", position: [0.37, 1.2, 0.38], target: [0.37, 1.02, 8], focal_mm: 24 },
  passenger_on_driver: { label: "From the passenger seat, on the driver", position: [-0.38, 1.16, 0.42], target: [0.37, 1.1, -0.05], focal_mm: 32 },
  back_seat: { label: "From the back seat (both front seats + road)", position: [0, 1.2, -1.15], target: [0, 1.05, 2], focal_mm: 22 },
  dash_two_shot: { label: "Dashboard, looking back at both front seats", position: [0, 1.12, 0.78], target: [0, 1.1, -0.3], focal_mm: 20 },
  back_seat_single: { label: "Between the front seats, back at the back seat", position: [0, 1.18, 0.15], target: [0, 1.0, -1.0], focal_mm: 24 },
  side_tracking: { label: "Tracking alongside (outside)", position: [3.2, 1.2, 0.2], target: [0, 1.0, 0.2], focal_mm: 35 },
  top_down: { label: "Top down (overhead)", position: [0, 9, 0.01], target: [0, 0, 0], focal_mm: 24 },
};
const LIFT_FRAMES = 8;
const RIDEABLE = new Set(["horse", "bicycle", "motorcycle"]);
const SITTABLE = new Set(["chair", "bench", "sofa", "armchair", "couch", "stool"]);
const NEVER_CARRIED = new Set(["horse", "cow", "car", "police_car", "sports_car", "hatchback", "truck", "bus", "bicycle", "motorcycle", "tree", "house", "building", "wall",
  "fridge", "wardrobe", "kitchen_counter", "bath", "bookshelf", "bed", "single_bed", "sofa", "door", "lamp_post", "post"]);
// Physics: kinds that never collide (foliage, rugs, fire, lights) and cars that collide as a body plus a cabin.
const NO_COLLIDE = new Set(["tree", "bush", "rug", "fire", "flashlight", "bird", "ufo", "houseplant", "lamp"]);
const CAR_BODIES = new Set(["car", "police_car", "sports_car", "hatchback"]);
const TURN_RATE = { horse: 150, cow: 120, dog: 400, cat: 500, car: 90, police_car: 90, sports_car: 110, hatchback: 90, truck: 60, bus: 45, bicycle: 200, motorcycle: 160 };

export const DEFAULT_SCENE = {
  version: 2,
  shot: { frames: 97, fps: 24 },
  camera: { position: [-7.0, 1.7, -14.0], target: [0, 1.3, -4.0], focal_mm: 35 },
  camera_end: { position: [-3.0, 1.7, -2.0], target: [0, 1.3, 11.5], focal_mm: 35 },
  sun: { azimuth_deg: 235, elevation_deg: 18 },
  environment: { set: "plaza", weather: "none", density: 0.5, water_level: 2.5 },
  lighting: { mode: "manual", hour: 17.6, day_of_year: 300, latitude: 34.05, north_deg: 0, overcast: false, preset: null, lights: [] },
  actors: [
    { id: "actor_a", name: "Man", kind: "man", position: [-0.6, 0, -6], position_end: [-0.6, 0, 12.5], height_m: 1.78 },
    { id: "actor_b", name: "Woman", kind: "woman", position: [0.6, 0, -6], position_end: [0.6, 0, 12.5], height_m: 1.68 },
  ],
  props: [
    { id: "building", kind: "building", position: [0, 0, 15], size: [21, 8, 9], door: [3, 5] },
    { id: "planter_l", kind: "box", position: [-3.5, 0, 6], size: [1.2, 1.0, 1.2] },
    { id: "planter_r", kind: "box", position: [3.5, 0, 6], size: [1.2, 1.0, 1.2] },
    { id: "lamp", kind: "post", position: [-8, 0, 2], size: [0.15, 4, 0.15] },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Yield one task without setTimeout, which hidden tabs throttle to 1 s or more. */
const yieldToBrowser = () => new Promise((resolve) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => resolve();
  ch.port2.postMessage(0);
});

function vfovFromFocal(focalMm, aspect) {
  const sensorH = SENSOR_W_MM / aspect;
  return THREE.MathUtils.radToDeg(2 * Math.atan(sensorH / (2 * focalMm)));
}

const depthMaterial = new THREE.ShaderMaterial({
  uniforms: { uNear: { value: DEPTH_NEAR }, uFar: { value: DEPTH_FAR } },
  vertexShader: `varying float vViewZ;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uNear; uniform float uFar; varying float vViewZ;
    void main(){ float d = clamp((vViewZ - uNear)/(uFar - uNear), 0.0, 1.0); gl_FragColor = vec4(vec3(1.0 - d), 1.0); }`,
});

let wheelRouterInstalled = false;
/** One capture-phase listener for the whole page: wheel over a stage dollies that stage only. */
function installWheelRouter() {
  if (wheelRouterInstalled) return;
  wheelRouterInstalled = true;
  window.addEventListener(
    "wheel",
    (e) => {
      const stage = e.target?.__soundstage;
      if (!stage) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stage._onWheel(e);
    },
    { capture: true, passive: false },
  );
}

const _tiltQ = new THREE.Quaternion();

/** The kind tables live editing needs (exported for the tests). */
export const liveKinds = () => ({ PERSON_KINDS, RIDEABLE, SITTABLE, SEATS, NO_COLLIDE, CAR_BODIES, NEVER_CARRIED, LIBRARY, MOUNTS });

export class Stage {
  /** Current delivery size from the shot's aspect ratio. */
  get fw() {
    return (ASPECTS[this.state?.shot?.aspect] || ASPECTS["1.85"]).size[0];
  }

  get fh() {
    return (ASPECTS[this.state?.shot?.aspect] || ASPECTS["1.85"]).size[1];
  }

  setAspect(key) {
    if (!ASPECTS[key]) return;
    this.state.shot = { ...(this.state.shot || {}), aspect: key };
    this.camera.aspect = this.fw / this.fh;
    this.viewCam.aspect = this.fw / this.fh;
    this.viewCam.updateProjectionMatrix();
    this._snap = null;
    this.resize();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  constructor(container, onChange) {
    const userChange = onChange || (() => {});
    this.onChange = (st) => { if (!this._muteRecord) this._record(); userChange(st); };
    this.state = clone(DEFAULT_SCENE);
    this.view = "clay";
    this.key = "start";
    this.frame = 0;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, stencil: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(1);
    this.canvas = this.renderer.domElement;
    this.canvas.style.cssText = "display:block;width:100%;height:auto;border-radius:4px;cursor:grab;touch-action:none";
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, this.fw / this.fh, 0.1, 200);
    this.clayMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 });
    this.wireMat = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, wireframe: true });

    this.hemi = new THREE.HemisphereLight(0xdfe6ef, 0x3a3a3a, 0.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 120 });
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.actorMeshes = new Map();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this._buildSet();
    this._applySun();
    this.highlight = new Highlighter(this);
    this.live = new LiveEdit(this, liveKinds());
    this.setFrame(0);
    this._bindControls();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.render();
    this._record();
  }

  // ---------- scene graph ----------
  _mesh(geom, color) {
    this._mats = this._mats || new Map();
    const key = color || "#9a9a9a";
    if (!this._mats.has(key)) this._mats.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(key), roughness: 0.85 }));
    const m = new THREE.Mesh(geom, this._mats.get(key));
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  _buildSet() {
    this.root.clear();
    this.actorMeshes.clear();
    const ground = this._mesh(new THREE.PlaneGeometry(80, 80));
    ground.rotation.x = -Math.PI / 2;
    ground.castShadow = false;
    ground.userData.ground = true;
    this.ground = ground;
    this.root.add(ground);

    // A true-scale interior from a floor plan / dimension spec (walls, openings, floors, removable ceilings).
    this.interiorGroup = null;
    if (this.state.interior?.rooms?.length) {
      this.interiorGroup = buildInterior(this.state.interior, (geom, color) => this._mesh(geom, color));
      this.root.add(this.interiorGroup);
    }
    // An imported world (Blender / Unreal / Maya / Sketchfab file or a splat) as the location: interop/importworld.mjs.
    (this.worldMount ||= new WorldMount(this)).attach();

    const env = this.state.environment || { set: "plaza", weather: "none", density: 0.5 };
    const clean = this._cleanStreetSig();
    const built = buildSet(env.set || "plaza", (geom) => this._mesh(geom), { water_level: env.water_level, ...(clean ? JSON.parse(clean) : {}) });
    if (built.group) this.root.add(built.group);
    this._setGroup = built.group;
    this._setCleanSig = clean;
    this.setFx = built.fx || null;   // Milestone 11 sets (web/stage/sets): animation per frame + per-pass look
    ground.visible = !this.setFx?.hideGround;
    ground.scale.set(clean ? 6 : 1, clean ? 6 : 1, 1);   // the clean street runs a long way: so does the road
    this.water = built.water ? buildWater(built.water) : null;
    if (this.water) this.root.add(this.water);
    this.weather = buildWeather(env.weather || "none", env.density ?? 0.5);
    if (this.weather) this.root.add(this.weather.object);
    for (const p of (env.set || "plaza") === "plaza" ? this.state.props : []) {
      const [x, y, z] = p.position;
      if (p.kind === "building") {
        const [w, h, d] = p.size;
        const [dw, dh] = p.door;
        const front = z - d / 2;
        const side = (w - dw) / 2;
        const g = new THREE.Group();
        const wallL = this._mesh(new THREE.BoxGeometry(side, h, 0.6));
        wallL.position.set(x - dw / 2 - side / 2, h / 2, front);
        const wallR = wallL.clone();
        wallR.position.x = x + dw / 2 + side / 2;
        const lintel = this._mesh(new THREE.BoxGeometry(dw, h - dh, 0.6));
        lintel.position.set(x, dh + (h - dh) / 2, front);
        const back = this._mesh(new THREE.BoxGeometry(w, h, 0.6));
        back.position.set(x, h / 2, z + d / 2);
        const roof = this._mesh(new THREE.BoxGeometry(w, 0.6, d));
        roof.position.set(x, h, z);
        const sideL = this._mesh(new THREE.BoxGeometry(0.6, h, d));
        sideL.position.set(x - w / 2, h / 2, z);
        const sideR = sideL.clone();
        sideR.position.x = x + w / 2;
        g.add(wallL, wallR, lintel, back, roof, sideL, sideR);
        g.userData.setPiece = true;
        this.root.add(g);
      } else if (p.kind === "post") {
        const m = this._mesh(new THREE.CylinderGeometry(p.size[0], p.size[0], p.size[1], 12));
        m.position.set(x, p.size[1] / 2, z);
        this.root.add(m);
      } else {
        const m = this._mesh(new THREE.BoxGeometry(...p.size));
        m.position.set(x, p.size[1] / 2, z);
        m.userData.setPiece = true;
        this.root.add(m);
      }
    }

    for (const a of this.state.actors) {
      const g = a.kind === "glb" ? this._glbPlaceholder(a)
        : a.kind === "card" ? this._cardPlaceholder(a)
        : a.kind === "custom" && a.recipe
        ? buildFromRecipe(a.recipe, (geom, color) => this._mesh(geom, color || a.appearance?.color))
        : buildObject(a.kind || "man", a.height_m, (geom, color) => this._mesh(geom, color), a.appearance);
      g.position.set(...a.position);
      g.userData.actorId = a.id;
      g.scale.setScalar(a.scale || 1);
      g.traverse((o) => (o.userData.actorId = a.id));
      this.actorMeshes.set(a.id, g);
      this.root.add(g);
      if (a.kind === "horse" && !a.simple_model) this._upgradeHorse(a, g);
      else if (LIBRARY[a.kind]?.model) this._upgradeVehicle(a, g, LIBRARY[a.kind]);
    }
    this._buildLights();
    // Selection ring (viewport only; hidden in captures).
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 40),
      new THREE.MeshBasicMaterial({ color: 0xe39a40, side: THREE.DoubleSide }));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.visible = false;
    this.root.add(this.selRing);
  }

  // ---------- clean street for ride-along shots ----------
  /**
   * Clean street (experimental, off unless environment.clean_street is true): the city street as one smooth facade a
   * side with an even roofline and no lamp posts, long enough for the whole drive. Built to stop LTX reading the
   * blocks and gaps sliding past a ride-along shot as traffic (Milestone 5), but on the In-the-Car windshield draft
   * (seeds 42 and 7, Milestone 7) it traded the early passing car for parked cars along both kerbs from frame ~72, so
   * it is not automatic. Returns the build options as a string signature (null = the ordinary set), so the set is
   * rebuilt only when it changes.
   */
  _cleanStreetSig() {
    const env = this.state.environment || {};
    if ((env.set || "plaza") !== "street_night" || env.clean_street !== true) return null;
    let z0 = 0, z1 = 0;
    for (const a of this.state.actors || []) for (const k of a.keys || [{ position: a.position || [0, 0, 0] }]) {
      z0 = Math.min(z0, k.position[2]); z1 = Math.max(z1, k.position[2]);
    }
    // Round out to 50 m so scrubbing a key doesn't rebuild the set; the camera sees 150 m past either end.
    return JSON.stringify({ clean: true, span: [Math.floor(z0 / 50) * 50 - 150, Math.ceil(z1 / 50) * 50 + 150] });
  }

  _swapSetGroup() {
    const env = this.state.environment || {};
    if (this._setGroup) this.root.remove(this._setGroup);
    const clean = this._cleanStreetSig();
    const built = buildSet(env.set || "plaza", (geom) => this._mesh(geom), { water_level: env.water_level, ...(clean ? JSON.parse(clean) : {}) });
    if (built.group) this.root.add(built.group);
    this._setGroup = built.group;
    this._setCleanSig = clean;
    this.setFx = built.fx || null;
    this.ground?.scale.set(clean ? 6 : 1, clean ? 6 : 1, 1);
  }

  // ---------- physics: simulate, then bake into ordinary keys ----------
  /** Can this object fall and tumble? Props and set dressing yes; people, animals, vehicles, riders and sets no. */
  _physCanMove(a) {
    if (!a || a.mount_id || a.carry_id || a.set_xform || a.kind === "card" || PERSON_KINDS.has(a.kind)) return false;
    const rig = a.kind === "custom" ? a.recipe?.rig || "static" : LIBRARY[a.kind]?.rig || "static";
    return rig === "static" && !LIBRARY[a.kind]?.flies && !NO_COLLIDE.has(a.kind) && (LIBRARY[a.kind]?.height || 0) <= 4;
  }

  /** Physics settings of an object (defaults filled in), plus whether it is baked. */
  physicsInfo(id = this.selected) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a) return null;
    const p = physicsOf(a);
    if (!a.physics?.mode && (NO_COLLIDE.has(a.kind) || a.kind === "card" || a.mount_id || a.carry_id)) p.mode = "off";   // never collides
    return { id: a.id, name: a.name, kind: a.kind, ...p, baked: !!a.physics?.baked, canMove: this._physCanMove(a),
      kindCount: this.state.actors.filter((x) => x.kind === a.kind && this._physCanMove(x)).length,
      dynamicCount: this.state.actors.filter((x) => x.physics?.mode === "dynamic" && this._physCanMove(x)).length };
  }

  /** Change physics settings on objects (one id, or every object of `kind`). Returns how many changed. */
  setPhysics(ids, patch) {
    const list = this.state.actors.filter((a) => (Array.isArray(ids) ? ids.includes(a.id) : a.id === ids));
    let n = 0;
    for (const a of list) {
      const next = { ...(a.physics || {}), ...patch };
      if (!next.mode) next.mode = this.physicsInfo(a.id).mode;
      if (next.mode === "dynamic" && !this._physCanMove(a)) next.mode = "static";
      a.physics = next;
      n++;
    }
    if (n) { this.setFrame(this.frame); this.onChange(this.toJSON()); }
    return n;
  }

  /** Every movable object of a kind (Physics panel: "all 6 crates"). */
  physicsKindIds(kind) {
    return this.state.actors.filter((a) => a.kind === kind && this._physCanMove(a)).map((a) => a.id);
  }

  /** An object's own local box: [half extents, centre relative to its origin], in its own (scaled) frame. */
  _localBox(g) {
    const p = g.position.clone(), q = g.quaternion.clone();
    g.position.set(0, 0, 0);
    g.quaternion.identity();
    g.updateMatrixWorld(true);
    const box = new THREE.Box3();
    g.traverseVisible((o) => {   // only what you see (a car's built stand-in hides under its real model)
      if (!o.isMesh || !o.geometry?.attributes?.position || o.userData.noCollide || o.material?.transparent) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    });
    g.position.copy(p); g.quaternion.copy(q);
    g.updateMatrixWorld(true);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    return { half: [size.x / 2, size.y / 2, size.z / 2], center: [c.x, c.y, c.z] };
  }

  /** The set's boxes (street blocks, kerbs, plaza building and planters, interior walls) as fixed colliders. */
  _setColliders() {
    const out = [];
    const groups = [this._setGroup, this.interiorGroup, ...this.root.children.filter((o) => o.userData.setPiece)].filter(Boolean);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const grp of groups) {
      grp.updateMatrixWorld(true);
      grp.traverse((o) => {
        if (!o.isMesh || o.geometry?.type !== "BoxGeometry" || o.userData.ground) return;
        const prm = o.geometry.parameters;
        o.matrixWorld.decompose(pos, quat, sc);
        const half = [prm.width * Math.abs(sc.x) / 2, prm.height * Math.abs(sc.y) / 2, prm.depth * Math.abs(sc.z) / 2];
        if (Math.min(...half) <= 0) return;
        out.push({ id: `set_${out.length}`, shape: "box", half, center: [0, 0, 0], dynamic: false,
          poses: [{ pos: [pos.x, pos.y, pos.z], quat: [quat.x, quat.y, quat.z, quat.w] }] });
      });
    }
    for (const c of this.worldMount?.colliders() || []) out.push(c);   // an imported world's box proxies
    return out;
  }

  /** _setColliders(), cached until the set is rebuilt (the live world asks for it on every drag). */
  _setCollidersCached() {
    const key = [this._setGroup?.uuid, this.interiorGroup?.uuid, this.root.children.filter((o) => o.userData.setPiece).map((o) => o.uuid).join(), this.worldMount?.sig || ""].join("|");
    if (this._setColCache?.key !== key) this._setColCache = { key, list: this._setColliders().map((c) => ({ id: c.id, half: c.half, pos: c.poses[0].pos, quat: c.poses[0].quat })) };
    return this._setColCache.list;
  }

  /**
   * Simulate every Dynamic object over the whole shot and bake the result into its keys (a key per frame while it
   * moves, holds where it rests). Static objects, the set, the floor, and people and vehicles (on their keyed
   * motion) are what it hits. A dynamic object with several keys moves on them and is let go at its last key with
   * the speed it had (a throw). Re-simulating starts again from the keys it had before the first bake.
   */
  simulatePhysics(opts = {}) {
    const t0 = performance.now();
    const last = this._lastFrame(), fps = this.state.shot?.fps || 24;
    const dynamic = this.state.actors.filter((a) => a.physics?.mode === "dynamic" && this._physCanMove(a));
    if (!dynamic.length) return { ok: false, message: "Nothing is Dynamic yet: select a prop and set Physics to Dynamic." };
    // Back to the authored keys (and the start height) before sampling.
    for (const a of dynamic) if (a.physics.baked) { a.keys = clone(a.physics.source?.keys || this._actorKeys(a)); a.physics.baked = false; }
    const keep = this.frame;
    const colliders = this.state.actors.filter((a) => a.physics?.mode !== "dynamic" && a.physics?.mode !== "off" && !a.mount_id && !a.carry_id
      && a.kind !== "card" && !NO_COLLIDE.has(a.kind) && !a.set_xform && this.actorMeshes.has(a.id));
    const sampled = [...dynamic, ...colliders];
    const poses = new Map(sampled.map((a) => [a.id, []]));
    for (let f = 0; f <= last; f++) {
      this.setFrameSilent(f);
      for (const a of sampled) {
        const g = this.actorMeshes.get(a.id);
        poses.get(a.id).push({ pos: [g.position.x, g.position.y, g.position.z], quat: [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w] });
      }
    }
    this.setFrameSilent(0);
    const specs = [];
    for (const a of dynamic) {
      const g = this.actorMeshes.get(a.id), box = g && this._localBox(g);
      if (!box) continue;
      const p = physicsOf(a), keys = this._actorKeys(a);
      const moves = keys.length > 1 && keys.some((k) => Math.hypot(k.position[0] - keys[0].position[0], k.position[2] - keys[0].position[2]) > 0.01);
      const sphere = a.kind === "sphere";
      specs.push({ id: a.id, shape: sphere ? "sphere" : "box", half: box.half, center: box.center, radius: sphere ? Math.min(...box.half) : 0,
        dynamic: true, mass: p.mass, bounce: p.bounce, friction: p.friction, poses: poses.get(a.id), release: moves ? keys[keys.length - 1].frame : 0 });
    }
    for (const a of colliders) {
      const g = this.actorMeshes.get(a.id), box = g && this._localBox(g);
      if (!box) continue;
      const p = physicsOf(a);
      const base = { dynamic: false, bounce: p.bounce, friction: p.friction, poses: poses.get(a.id) };
      if (PERSON_KINDS.has(a.kind)) {   // a body, not its outstretched arms
        specs.push({ ...base, id: a.id, shape: "box", half: [box.half[0] * 0.6, box.half[1], box.half[2] * 0.75], center: box.center });
      } else if (CAR_BODIES.has(a.kind)) {   // a car is a low body and a cabin, so a crate goes over the bonnet, not up a wall
        const [hx, hy, hz] = box.half, [cx, cy, cz] = box.center, y0 = cy - hy, H = 2 * hy;
        specs.push({ ...base, id: `${a.id}#body`, shape: "box", half: [hx, H * 0.24, hz], center: [cx, y0 + H * 0.32, cz] });
        specs.push({ ...base, id: `${a.id}#cabin`, shape: "box", half: [hx * 0.9, H * 0.22, hz * 0.5], center: [cx, y0 + H * 0.78, cz - hz * 0.08] });
      } else specs.push({ ...base, id: a.id, shape: "box", half: box.half, center: box.center });
    }
    specs.push(...this._setColliders());
    const res = simulate(specs, last + 1, { fps, substeps: opts.substeps || 20 });
    const qa = checkTracks(specs, res, fps);
    for (const a of dynamic) {
      const tr = res.tracks[a.id];
      if (!tr) continue;
      if (!a.physics.source) a.physics.source = { keys: clone(this._actorKeys(a)) };
      a.keys = bakeTrack(tr);
      a.position = [...a.keys[0].position];
      a.physics.baked = true;
    }
    this.setFrame(keep);
    this.onChange(this.toJSON());
    const moving = dynamic.filter((a) => a.keys.length > 2).length;
    const restless = dynamic.filter((a) => res.settled[a.id] == null).map((a) => a.name);
    const ms = Math.round(performance.now() - t0);
    return { ok: true, bodies: dynamic.length, colliders: specs.length - dynamic.length, moving, restless, ms, ...qa,
      message: `Simulated ${dynamic.length} object${dynamic.length === 1 ? "" : "s"} over ${last + 1} frames in ${(ms / 1000).toFixed(1)} s` +
        ` and baked ${moving} into keys${restless.length ? `; still moving at the end: ${restless.slice(0, 3).join(", ")}` : "; everything comes to rest"}.` };
  }

  /** Put objects back on the keys they had before the bake (every baked object, or the given ids). */
  clearPhysics(ids = null) {
    let n = 0;
    for (const a of this.state.actors) {
      if (!a.physics?.baked || (ids && !ids.includes(a.id))) continue;
      a.keys = clone(a.physics.source?.keys || [{ frame: 0, position: [...this._actorKeys(a)[0].position] }]);
      a.position = [...a.keys[0].position];
      a.physics.baked = false;
      delete a.physics.source;
      n++;
    }
    if (n) { this.setFrame(this.frame); this.onChange(this.toJSON()); }
    return n;
  }

  // ---------- time & keyframes ----------
  _lastFrame() {
    return Math.max(1, (this.state.shot?.frames || 97) - 1);
  }

  // ---------- coverage: several camera setups on one set ----------
  /** Shots share actors, set, lighting and timing; each has its own camera keys. */
  _shots() {
    if (!this.state.shots?.length) {
      this.state.shots = [{ id: "shot_1", name: "Master", setup: "master", camera_keys: this._legacyCamKeys() }];
      this.state.active_shot = "shot_1";
    }
    return this.state.shots;
  }

  activeShot() {
    const shots = this._shots();
    return shots.find((x) => x.id === this.state.active_shot) || shots[0];
  }

  setActiveShot(id) {
    if (!this._shots().some((x) => x.id === id)) return;
    this.state.active_shot = id;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onShots?.();
  }

  /** New camera setup starting from what the current camera sees at the playhead. */
  addShot(setup = "single") {
    const shots = this._shots();
    const cam = this._cameraAt(this.frame);
    const label = { master: "Master", wide: "Wide", ots_a: "Over-the-shoulder A", ots_b: "Over-the-shoulder B",
      single_a: "Single A", single_b: "Single B", insert: "Insert", pov: "POV", two_shot: "Two-shot" }[setup] || "Setup";
    const n = shots.filter((x) => x.setup === setup).length + 1;
    const shot = { id: `shot_${Date.now().toString(36)}`, name: n > 1 ? `${label} ${n}` : label, setup,
      camera_keys: [{ frame: 0, ...clone(cam) }] };
    shots.push(shot);
    this.state.active_shot = shot.id;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onShots?.();
    return shot.name;
  }

  removeShot() {
    const shots = this._shots();
    if (shots.length < 2) return;
    this.state.shots = shots.filter((x) => x.id !== this.state.active_shot);
    this.state.active_shot = this.state.shots[0].id;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onShots?.();
  }

  /** Camera keys of the active shot. */
  _camKeys() {
    const shot = this.activeShot();
    if (!shot.camera_keys?.length) shot.camera_keys = [{ frame: 0, ...clone(this._cameraAt0Legacy()) }];
    this.state.camera_keys = shot.camera_keys; // keep the flat field for older readers
    return shot.camera_keys;
  }

  _cameraAt0Legacy() {
    return this.state.camera || DEFAULT_SCENE.camera;
  }

  /** Camera keys [{frame, position, target, focal_mm}], migrated from the old start/end pair. */
  _legacyCamKeys() {
    if (!this.state.camera_keys?.length) {
      const a = this.state.camera, b = this.state.camera_end;
      this.state.camera_keys = [{ frame: 0, ...clone(a) }];
      if (b && JSON.stringify(b) !== JSON.stringify(a)) this.state.camera_keys.push({ frame: this._lastFrame(), ...clone(b) });
    }
    return this.state.camera_keys;
  }

  /** Object position keys [{frame, position}], migrated from position / position_end. */
  _actorKeys(a) {
    if (!a.keys?.length) {
      a.keys = [{ frame: 0, position: [...a.position] }];
      if (a.position_end && JSON.stringify(a.position_end) !== JSON.stringify(a.position)) {
        a.keys.push({ frame: this._lastFrame(), position: [...a.position_end] });
      }
    }
    return a.keys;
  }

  /** Find the segment around a frame and its 0..1 progress; also the 4 Catmull-Rom neighbours. */
  static _segment(keys, frame) {
    if (keys.length === 1 || frame <= keys[0].frame) return { i: 0, j: 0, u: 0 };
    const n = keys.length - 1;
    if (frame >= keys[n].frame) return { i: n, j: n, u: 0 };
    let i = 0;
    while (keys[i + 1].frame < frame) i++;
    const u = (frame - keys[i].frame) / Math.max(1e-6, keys[i + 1].frame - keys[i].frame);
    return { i, j: i + 1, u };
  }

  /** Centripetal-ish Catmull-Rom between p1 and p2 (p0/p3 neighbours), per component. */
  static _cr(p0, p1, p2, p3, u) {
    const u2 = u * u, u3 = u2 * u;
    return p1.map((_, k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3));
  }

  /** Interpolated value of `field` along keys at a frame (smooth path through every key). */
  static _sample(keys, frame, field, ease = true) {
    const { i, j, u } = Stage._segment(keys, frame);
    if (i === j) return [...keys[i][field]];
    // A hold (two keys at the same spot) stays still: the spline would otherwise bow backwards toward the next
    // key, so a horse waiting to gallop off drifted back and swung its head round before leaving.
    const a = keys[i][field], b = keys[j][field];
    if (Array.isArray(a) && a.every((x, k) => Math.abs(x - b[k]) < 1e-4)) return [...a];
    const n = keys.length - 1;
    // Ease out of the first key and into the last; constant speed through the middle keys.
    let w = u;
    if (ease && n === 1) w = u * u * (3 - 2 * u);
    else if (ease && i === 0) w = (u * u * (3 - 2 * u) + u) / 2;
    else if (ease && j === n) w = (u * u * (3 - 2 * u) + u) / 2;
    const P = (k) => keys[Math.max(0, Math.min(n, k))][field];
    return Stage._cr(P(i - 1), P(i), P(j), P(j + 1), w);
  }

  /** Shot camera at any frame (interpolated through all camera keys). */
  _cameraAt(frame) {
    const keys = this._camKeys();
    const { i, j, u } = Stage._segment(keys, frame);
    const fa = keys[i].focal_mm, fb = keys[j].focal_mm;
    const cam = {
      position: Stage._sample(keys, frame, "position"),
      target: Stage._sample(keys, frame, "target"),
      focal_mm: fa + (fb - fa) * (i === j ? 0 : u * u * (3 - 2 * u)),
    };
    // Ride-along: the shot's keys are in a vehicle's (or rider's) own space, so the world moves past outside.
    const host = this._followActor?.();
    if (host) {
      const toWorld = this._actorFrame(host, frame);
      cam.position = toWorld(cam.position);
      cam.target = toWorld(cam.target);
    }
    return cam;
  }

  /**
   * The camera as the shot actually sees it: the keys run through the shot's camera rig (dolly inertia and settle,
   * jib arc, handheld shake...). Keys / editing use _cameraAt; display, capture and exports use this.
   */
  _shotCameraAt(frame) {
    const shot = this.activeShot?.();
    const rig = shot?.rig;
    if (!rig?.type || rig.type === "free") return this._cameraAt(frame);
    const last = this._lastFrame();
    const sig = JSON.stringify([shot.id, this._camKeys(), rig, last, shot.camera_follow || "", this.state.shot?.fps]);
    if (this._rigCache?.sig !== sig) {
      const path = [];
      for (let f = 0; f <= last; f++) path.push(this._cameraAt(f));
      this._rigCache = { sig, path: applyRig(path, rig, this.state.shot?.fps || 24) };
    }
    const p = this._rigCache.path;
    return p[Math.max(0, Math.min(p.length - 1, Math.round(frame)))];
  }

  /** Put the active shot's camera on a rig: free, tripod, dolly, chapman, slider, jib, steadicam, handheld, drone. */
  setRig(type, amount) {
    const shot = this.activeShot?.();
    if (!shot || !RIGS[type]) return;
    shot.rig = { type, amount: amount ?? shot.rig?.amount ?? 1 };
    this._rigCache = null;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  rigInfo() {
    const r = this.activeShot?.()?.rig;
    return { type: r?.type || "free", amount: r?.amount ?? 1, options: Object.entries(RIGS).map(([id, v]) => ({ id, label: v.label })) };
  }

  _followActor() {
    const id = this.activeShot?.()?.camera_follow;
    return id ? this.state.actors.find((x) => x.id === id) || null : null;
  }

  /** Local → world transform for an actor at a frame (position + heading, no bounce). */
  _actorFrame(a, frame) {
    const p = this._actorPosAt(a, frame), yaw = this._headingAt(a, frame);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return (v) => [p[0] + v[0] * c + v[2] * s, v[1], p[2] - v[0] * s + v[2] * c];
  }

  _actorFrameInverse(a, frame) {
    const p = this._actorPosAt(a, frame), yaw = this._headingAt(a, frame);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return (v) => { const dx = v[0] - p[0], dz = v[2] - p[2]; return [dx * c - dz * s, v[1], dx * s + dz * c]; };
  }

  /**
   * Make the active shot's camera ride with an actor (null = back to the world). Keys are converted so the view
   * doesn't jump. `preset` puts the camera somewhere useful inside a vehicle at the same time.
   */
  setCameraFollow(actorId, preset = null) {
    const shot = this.activeShot();
    const keys = this._camKeys();
    const old = this._followActor();
    const world = keys.map((k) => {
      const tw = old ? this._actorFrame(old, k.frame) : null;
      return { ...k, position: tw ? tw(k.position) : k.position, target: tw ? tw(k.target) : k.target };
    });
    const host = actorId ? this.state.actors.find((x) => x.id === actorId) : null;
    if (!host) { delete shot.camera_follow; shot.camera_keys = world; }
    else {
      shot.camera_follow = host.id;
      if (preset && CAR_SHOTS[preset]) {
        const s = (host.height_m || LIBRARY[host.kind]?.height || 1.45) / (LIBRARY[host.kind]?.height || 1.45);
        const q = CAR_SHOTS[preset];
        shot.camera_keys = [{ frame: 0, position: q.position.map((v) => v * s), target: q.target.map((v) => v * s), focal_mm: q.focal_mm }];
      } else {
        shot.camera_keys = world.map((k) => { const inv = this._actorFrameInverse(host, k.frame); return { ...k, position: inv(k.position), target: inv(k.target) }; });
      }
    }
    this.state.camera_keys = shot.camera_keys;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /**
   * One click for car-dialogue coverage: a shot per interior angle, each riding with the vehicle (the street goes by
   * outside). The back-seat single only when someone sits in the back. Returns the new shot names.
   */
  addInteriorShots(vehicleId) {
    const host = this.state.actors.find((x) => x.id === vehicleId);
    if (!host || LIBRARY[host.kind]?.rig !== "vehicle") return [];
    const s = (host.height_m || LIBRARY[host.kind]?.height || 1.45) / (LIBRARY[host.kind]?.height || 1.45);
    const riders = this.state.actors.filter((a) => a.mount_id === host.id);
    const backSeat = riders.some((a) => (a.seat ?? 0) >= 2);
    const plan = [["dash_two_shot", "Dashboard two-shot", "two_shot"], ...(backSeat ? [["back_seat_single", "Back seat single", "single_b"]] : []),
      ["passenger_on_driver", "Driver profile", "single_a"], ["back_seat", "Over the shoulders", "ots_a"], ["driver_pov", "Driver's POV", "pov"]];
    const shots = this._shots();
    const names = [];
    for (const [preset, name, setup] of plan) {
      const q = CAR_SHOTS[preset];
      const id = `car_${preset}_${Date.now().toString(36)}`;
      shots.push({ id, name, setup, camera_follow: host.id,
        camera_keys: [{ frame: 0, position: q.position.map((v) => v * s), target: q.target.map((v) => v * s), focal_mm: q.focal_mm }] });
      names.push(name);
      if (names.length === 1) this.state.active_shot = id;
    }
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onShots?.();
    return names;
  }

  _actorPosAt(a, frame) {
    return Stage._sample(this._actorKeys(a), frame, "position", false);
  }

  /**
   * Heading (radians) of an actor at a frame, rate-limited like a real body: a horse can't spin 180° in one frame.
   * Desired heading = direction of travel while moving, else the last heading (or its Turn before it ever moves).
   * A forward pass limits the turn rate; a backward pass makes it ANTICIPATE (turn in place before setting off).
   */
  _headingAt(a, frame) {
    const keys = this._actorKeys(a);
    const last = this._lastFrame();
    const sig = JSON.stringify([keys, a.rotation_deg || 0, last, a.kind]);
    this._headCache = this._headCache || new WeakMap();
    let hd = this._headCache.get(a);
    if (!hd || hd.sig !== sig) {
      const fps = this.state.shot?.fps || 24;
      const rateDeg = TURN_RATE[a.kind] ?? (["man", "woman", "child"].includes(a.kind) ? 540 : 360);
      const step = THREE.MathUtils.degToRad(rateDeg) / fps;
      const rest = THREE.MathUtils.degToRad(a.rotation_deg || 0);
      const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
      const toward = (from, to) => { const d = wrap(to - from); return from + Math.max(-step, Math.min(step, d)); };
      const desired = [];
      let lastMove = null;
      for (let f = 0; f <= last; f++) {
        const p0 = this._actorPosAt(a, f - 1), p1 = this._actorPosAt(a, f + 1);
        const vx = p1[0] - p0[0], vz = p1[2] - p0[2];
        // Real travel only (> ~0.25 m/s): the spline drifts a few mm between two keys at the same spot.
        if (keys.length > 1 && Math.hypot(vx, vz) * fps / 2 > 0.25) lastMove = Math.atan2(vx, vz);
        desired.push(lastMove ?? null);
      }
      // Before it ever moves, it faces its Turn.
      for (let f = 0; f <= last; f++) if (desired[f] === null) desired[f] = rest;
      // Backward pass (anticipation), then forward pass (inertia) from that.
      const back = new Array(last + 1);
      back[last] = desired[last];
      for (let f = last - 1; f >= 0; f--) back[f] = toward(back[f + 1], desired[f]);
      const out = new Array(last + 1);
      out[0] = back[0];
      for (let f = 1; f <= last; f++) out[f] = toward(out[f - 1], back[f]);
      hd = { sig, out };
      this._headCache.set(a, hd);
    }
    const out = hd.out;
    return out[Math.max(0, Math.min(out.length - 1, Math.round(frame)))];
  }

  /** Static things a person can stand on / must clear: world boxes of parked, non-person actors. */
  _obstacles() {
    const sig = JSON.stringify(this.state.actors.map((o) => [o.id, o.kind, o.keys?.length > 1 ? "moving" : o.keys?.[0]?.position || o.position, o.rotation_deg, o.scale, o.height_m, o.carry_id, o.mount_id]));
    if (this._obsCache?.sig === sig) return this._obsCache.list;
    const list = [];
    for (const o of this.state.actors) {
      if (PERSON_KINDS.has(o.kind) || o.mount_id || o.carry_id || (o.keys?.length > 1 && o.keys.some((k) => Math.hypot(k.position[0] - o.keys[0].position[0], k.position[2] - o.keys[0].position[2]) > 0.05))) continue;
      const g = this.actorMeshes.get(o.id);
      if (!g) continue;
      const box = new THREE.Box3().setFromObject(g);
      if (!isFinite(box.max.y) || box.max.y < 0.15) continue;
      list.push({ id: o.id, kind: o.kind, box, top: box.max.y });
    }
    this._obsCache = { sig, list };
    return list;
  }

  /**
   * A person's feet height at a frame: the key height (standing on something), lifted over anything in the way,
   * as the upper envelope of gravity parabolas. Hops up, vaults and drops all come out as real ballistic arcs
   * (g = 9.8 m/s²), starting before the obstacle and landing after it. Vehicles/animals stay on the ground.
   */
  _heightAt(a, frame) {
    if (LIBRARY[a.kind]?.flies) return this._actorPosAt(a, frame)[1] || 0;   // aircraft hover at their keyed height
    // A prop set on something (a crate on a table, Milestone 9) keeps its keyed height; older scenes have none.
    if (!PERSON_KINDS.has(a.kind)) return a.key_y ? Math.max(0, this._actorPosAt(a, frame)[1] || 0) : 0;
    const keys = this._actorKeys(a);
    const obs = this._obstacles();
    const last = this._lastFrame();
    const floor = this.setFx?.floorAt || null;   // a set's walkable surface: station platforms, the seabed
    const sig = JSON.stringify([keys, last, this._obsCache?.sig, this.setFx?.id || null]);
    this._yCache = this._yCache || new WeakMap();
    let c = this._yCache.get(a);
    if (!c || c.sig !== sig) {
      const fps = this.state.shot?.fps || 24, kk = 0.5 * 9.8 / (fps * fps), R = 0.18;
      const S = [];
      for (let f = 0; f <= last; f++) {
        const p = this._actorPosAt(a, f);
        let s = Math.max(0, p[1] || 0, floor ? floor(p[0], p[2]) : 0);
        for (const o of obs) {
          if (o.top > 1.7) continue;                         // walls and cars aren't climbed by walking into them
          if (p[0] > o.box.min.x - R && p[0] < o.box.max.x + R && p[2] > o.box.min.z - R && p[2] < o.box.max.z + R) s = Math.max(s, o.top);
        }
        S.push(s);
      }
      const Y = S.map((_, f) => {
        let y = 0;
        for (let q = 0; q <= last; q++) { const d = f - q; const v = S[q] - kk * d * d; if (v > y) y = v; }
        return +y.toFixed(3);
      });
      c = { sig, Y, S };
      this._yCache.set(a, c);
    }
    return c.Y[Math.max(0, Math.min(c.Y.length - 1, Math.round(frame)))] || 0;
  }

  /** Is a person in the air (mid-jump) at this frame? */
  _airborne(a, frame) {
    const c = this._yCache?.get(a);
    if (!c) return false;
    const f = Math.max(0, Math.min(c.Y.length - 1, Math.round(frame)));
    return c.Y[f] - c.S[f] > 0.06;
  }

  /**
   * After dragging a person onto something, make them use it: hop onto a horse or bike, get into a car (nearest
   * seat), or climb onto a low prop (crate, box, rock, bench, table, AC unit...). At the playhead, so the earlier
   * keys walk them there. Returns a sentence for the status line (also sent to onInteract).
   */
  /** The object whose on-screen box is within `pad` px of the pointer (smallest box wins), or null. */
  _nearOnScreen(e, pad = 12, exclude = null) {
    const r = this.canvas.getBoundingClientRect();
    const cam = this._viewportCamera();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null;
    const v = new THREE.Vector3();
    for (const [id, g] of this.actorMeshes) {
      if (id === exclude) continue;
      const a = this.state.actors.find((q) => q.id === id);
      if (!a || a.set_xform || (LIBRARY[a.kind]?.rig === "static" && (LIBRARY[a.kind]?.height || 0) > 3)) continue;  // not whole sets/buildings
      const box = new THREE.Box3().setFromObject(g);
      if (box.isEmpty()) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
        if (v.z > 1) { behind = true; break; }
        const sx = (v.x + 1) / 2 * r.width, sy = (1 - v.y) / 2 * r.height;
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      if (behind || x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
      const area = (x1 - x0) * (y1 - y0);
      if (!best || area < best.area) best = { id, area };
    }
    return best?.id || null;
  }

  _dropInteract(id, underId = null) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a) return null;
    if (!PERSON_KINDS.has(a.kind)) return this._dropProp(a, underId);
    if (a.mount_id) return null;
    let p = this._actorPosAt(a, this.frame);
    let best = null;
    // Dropped right onto something you can see: that's the target, wherever the feet ended up.
    const under = underId && this.state.actors.find((x) => x.id === underId && !PERSON_KINDS.has(x.kind));
    if (under) {
      const g = this.actorMeshes.get(under.id);
      if (g) {
        best = { o: under, d: 0, box: new THREE.Box3().setFromObject(g), g };
        // Seat choice and climb height use the drop point on the target, not the floor behind it.
        const c = best.box.getCenter(new THREE.Vector3());
        p = [c.x, p[1], c.z];
      }
    }
    for (const o of this.state.actors) {
      if (o === a || PERSON_KINDS.has(o.kind)) continue;
      const g = this.actorMeshes.get(o.id);
      if (!g) continue;
      const box = new THREE.Box3().setFromObject(g);
      const dx = Math.max(box.min.x - p[0], 0, p[0] - box.max.x), dz = Math.max(box.min.z - p[2], 0, p[2] - box.max.z);
      const d = Math.hypot(dx, dz);
      if (d <= 0.3 && (!best || d < best.d)) best = { o, d, box, g };   // (an under-cursor target already has d = 0)
    }
    if (!best) return null;
    const { o, box, g } = best;
    const name = (x) => x.name || LIBRARY[x.kind]?.label || x.kind;
    const at = this.frame > 0 ? this.frame : 0;
    let msg = null;
    if (RIDEABLE.has(o.kind)) {
      this.mount(a.id, o.id, null, at);
      msg = `${name(a)} ${at ? "hops onto" : "is on"} ${name(o)}${at ? ` at ${(at / (this.state.shot?.fps || 24)).toFixed(1)} s` : ""}.`;
    } else if (SEATS[o.kind]) {
      // Nearest seat to where they were dropped.
      const ref = LIBRARY[o.kind]?.height || 1, k = (o.scale || 1) * ((o.height_m || ref) / ref);
      let si = 0, sd = Infinity;
      SEATS[o.kind].forEach((s, i) => {
        const w = new THREE.Vector3(s.pos[0] * k, 0, s.pos[2] * k).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(g.position);
        const d = Math.hypot(w.x - p[0], w.z - p[2]);
        if (d < sd) { sd = d; si = i; }
      });
      this.mount(a.id, o.id, "sit", at, si);
      msg = `${name(a)} gets into ${name(o)}: ${SEATS[o.kind][si].name} seat. Change it in the selection bar.`;
    } else if (SITTABLE.has(o.kind)) {
      this.mount(a.id, o.id, "sit", at);
      msg = `${name(a)} sits on ${name(o)}.`;
    } else if (box.max.y <= 1.7) {
      const key = this._editActorKey(a);
      key.position = [key.position[0], +box.max.y.toFixed(2), key.position[2]];
      this._yCache?.delete(a);
      this.setFrame(this.frame);
      this.onChange(this.toJSON());
      msg = `${name(a)} climbs onto ${name(o)} (${box.max.y.toFixed(2)} m up).`;
    }
    if (msg) this.onInteract?.(msg);
    return msg;
  }

  /** A prop dropped onto a person is picked up and carried from the playhead; dragged away, it's put down. */
  _dropProp(o, underId = null) {
    const g = this.actorMeshes.get(o.id);
    if (!g || NEVER_CARRIED.has(o.kind)) return null;
    const box = new THREE.Box3().setFromObject(g), size = box.getSize(new THREE.Vector3());
    const name = (x) => x.name || LIBRARY[x.kind]?.label || x.kind;
    if (o.carry_id) {                                        // dragged out of someone's hands: put it down here
      const c = this.state.actors.find((x) => x.id === o.carry_id);
      delete o.carry_id; delete o.carry_at;
      this.setFrame(this.frame);
      this.onChange(this.toJSON());
      const msg = `${name(o)} is put down${c ? ` by ${name(c)}` : ""}.`;
      this.onInteract?.(msg);
      return msg;
    }
    if (size.y > 1.0 || Math.max(size.x, size.z) > 1.6) return null;   // too big to carry
    const p = [(box.min.x + box.max.x) / 2, (box.min.z + box.max.z) / 2];
    let best = null;
    const under = underId && this.state.actors.find((x) => x.id === underId && PERSON_KINDS.has(x.kind) && !x.mount_id);
    if (under) best = { c: under, d: 0 };                    // dropped right onto a person
    for (const c of under ? [] : this.state.actors) {
      if (!PERSON_KINDS.has(c.kind) || c.mount_id) continue;
      const q = this._actorPosAt(c, this.frame), d = Math.hypot(q[0] - p[0], q[2] - p[1]);
      if (d < 0.9 && (!best || d < best.d)) best = { c, d };
    }
    if (!best) return null;
    o.carry_id = best.c.id;
    o.carry_at = Math.max(LIFT_FRAMES, this.frame);
    // Leave it where it was before the pick-up (its own key), so it sits there until lifted.
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    const msg = `${name(best.c)} picks up ${name(o)} at ${(o.carry_at / (this.state.shot?.fps || 24)).toFixed(1)} s and carries it. Drag it away to put it down.`;
    this.onInteract?.(msg);
    return msg;
  }

  /** Pose the whole set at a frame: camera, object positions, heading and walk cycle. */
  setFrame(frame) {
    // Scrubbing or any edit while dropped things are still settling: write them down first.
    if (this.live?.settling && !this.live.drag && !this.live.internal) this.live.finish();
    this.frame = Math.max(0, Math.min(this._lastFrame(), Math.round(frame)));
    this.worldMount?.setTime(this.frame / (this.state.shot?.fps || 24));
    if (this._setGroup !== undefined && this._cleanStreetSig() !== this._setCleanSig) this._swapSetGroup();
    // The set may have been rebuilt (new meshes): keep the gizmo on the selected object.
    if (this.tc && this.tc.object !== (this.poser?.target() ?? (this.selected ? this.actorMeshes.get(this.selected) : undefined))) this._attachGizmo();
    for (const a of this.state.actors) {
      const g = this.actorMeshes.get(a.id);
      if (!g) continue;
      if (a.mount_id && !(a.mount_at > this.frame)) continue; // placed on its mount below (a timed mount walks free until mount_at)
      const keys = this._actorKeys(a);
      const p = this._actorPosAt(a, this.frame);
      g.position.set(p[0], this._heightAt(a, this.frame), p[2]);
      // Heading follows the path at a real turning rate (no instant flips); parked objects keep their own Turn.
      const pa = this._actorPosAt(a, this.frame - 1), pb = this._actorPosAt(a, this.frame + 1);
      const vx = pb[0] - pa[0], vz = pb[2] - pa[2];
      const moving = keys.length > 1 && Math.hypot(vx, vz) > 0.004;
      g.rotation.y = this._headingAt(a, this.frame);
      // Walk cycle from distance travelled so far (stride scales with body size).
      const rig = a.kind === "custom" ? a.recipe?.rig || "static" : LIBRARY[a.kind || "man"]?.rig || "biped";
      const stride = rig === "quadruped" ? 1.6 * (a.height_m || 0.6) : 0.78 * (a.height_m || 1.8);
      let dist = 0;
      if (keys.length > 1) {
        let prev = this._actorPosAt(a, 0);
        for (let f = 1; f <= this.frame; f++) {
          const q = this._actorPosAt(a, f);
          dist += Math.hypot(q[0] - prev[0], q[2] - prev[2]);
          prev = q;
        }
      }
      const cycle = (dist / stride) * Math.PI * 2;
      // Speed in m/s (pa and pb are two frames apart).
      const speed = moving ? (Math.hypot(vx, vz) / 2) * (this.state.shot?.fps || 24) : 0;
      g.userData.speed = speed;
      g.rotation.order = "YXZ";
      g.rotation.x = 0;
      if (g.userData.tilted) { g.rotation.z = 0; g.userData.tilted = false; }
      if (rig === "quadruped" && speed > 4) {
        // Gallop: four-beat rotary gait (hind-hind-fore-fore), long stride, the body rocks and bounds.
        const gs = 2.6 * (a.height_m || 1.6);
        const gc = (dist / gs) * Math.PI * 2;
        const beat = [2.2, 2.9, 0, 0.7]; // limb order: front-left, front-right, hind-left, hind-right
        g.userData.limbs.forEach((l, i) => { l.pivot.rotation.x = 0.85 * Math.sin(gc + beat[i % 4]); });
        g.rotation.x = 0.07 * Math.sin(gc + 1.2);
        g.position.y = 0.06 * (a.height_m || 1.6) * Math.abs(Math.sin(gc));
        g.userData.gaitCycle = gc;
      } else {
        for (const l of g.userData.limbs) l.pivot.rotation.x = moving ? l.amp * Math.sin(cycle + l.phase) : 0;
        const air = this._airborne(a, this.frame);
        if (air) for (const l of g.userData.limbs) {   // mid-jump: knees tucked, arms up for balance
          if (l.part === "hip") l.pivot.rotation.x = -0.7;
          if (l.part === "knee") l.pivot.rotation.x = 1.1;
          if (l.part === "shoulder") l.pivot.rotation.x = -1.2;
        }
        g.position.y = this._heightAt(a, this.frame) +
          (moving && !air && rig !== "vehicle" ? 0.014 * (a.height_m || 1.8) * Math.abs(Math.sin(cycle)) : 0);
        g.userData.gaitCycle = cycle;
        if (rig === "biped" && g.userData.joints && !air) this._bodyMotion(g, a, moving, speed, cycle);
      }
      if (this.water) this._waterPhysics(a, g);
      if (g.userData.flames) this._animateFire(g, a);
      if (g.userData.mixer) g.userData.mixer.setTime(this.frame / (this.state.shot?.fps || 24));
      if (g.userData.horseRig) this._driveHorse(g, a, speed, dist);
      if (g.userData.wheelRig) for (const w of g.userData.wheelRig) w.rotation.x = dist / w.userData.radius;
      if (g.userData.beam) g.userData.beam.intensity = g.userData.beamBase * beamLevel(a.beam, this.frame);
      // Physics: a simulated object plays its baked keys (position with height, full rotation); before a bake, a
      // dynamic or static object stands at its start height.
      if (a.physics?.baked) {
        g.position.set(...samplePos(keys, this.frame));
        const q = sampleQuat(keys, this.frame);
        if (q) g.quaternion.set(q[0], q[1], q[2], q[3]);
      } else {
        if (a.physics?.lift > 0 && (a.physics.mode === "dynamic" || a.physics.mode === "static")) g.position.y += a.physics.lift;
        // Knocked over while editing (Milestone 9): the lean it came to rest with, on top of its heading.
        if (Array.isArray(a.tilt) && a.tilt.length === 4) { g.quaternion.multiply(_tiltQ.set(a.tilt[0], a.tilt[1], a.tilt[2], a.tilt[3])); g.userData.tilted = true; }
      }
    }
    // Riders follow their mounts (man on a horse, driver in a car, someone on a bench).
    for (const a of this.state.actors) {
      if (!a.mount_id) continue;
      const g = this.actorMeshes.get(a.id), host = this.state.actors.find((x) => x.id === a.mount_id);
      const hg = host && this.actorMeshes.get(host.id);
      if (!g || !hg) continue;
      const m = MOUNTS[host.kind] || { pose: "sit", seat: [0, (host.height_m || 1) * 0.6, 0] };
      let k = (host.scale || 1) * (m.scaleWithHeight ? (host.height_m || m.refHeight) / m.refHeight : 1);
      let sp = m.seat;
      const seats = SEATS[host.kind];
      if (seats) {   // vehicles: the rider's chosen seat (driver by default)
        sp = seats[Math.max(0, Math.min(seats.length - 1, a.seat ?? 0))].pos;
        const ref = LIBRARY[host.kind]?.height || 1;
        k = (host.scale || 1) * ((host.height_m || ref) / ref);
      }
      const seat = new THREE.Vector3(sp[0] * k, sp[1] * k, sp[2] * k).applyAxisAngle(new THREE.Vector3(0, 1, 0), hg.rotation.y);
      const h = (a.height_m || 1.8) * (a.scale || 1);
      const hopStart = (a.mount_at || 0) - HOP_FRAMES;
      if (a.mount_at > 0 && this.frame < hopStart) { applyPose(g, "stand", h); continue; } // still on foot
      const drop = applyPose(g, a.pose || m.pose, h);
      for (const jn of ["spine", "neck", "head"]) g.userData.joints?.[jn]?.rotation.set(0, 0, 0);   // seated: no walk / idle sway left over
      // The driver of a car holds the wheel (both hands forward and up), so the clay reads as driving.
      if (seats && (a.seat ?? 0) === 0 && ["car", "police_car", "sports_car", "hatchback"].includes(host.kind) && !a.pose)
        for (const l of g.userData.limbs || []) {
          if (l.part === "shoulder") { l.pivot.rotation.x = -1.05; l.pivot.rotation.z = -l.side * 0.12; }
          if (l.part === "elbow") l.pivot.rotation.x = -0.55;
        }
      const seatPos = new THREE.Vector3(hg.position.x + seat.x, hg.position.y + seat.y - drop, hg.position.z + seat.z);
      if (a.mount_at > 0 && this.frame < a.mount_at) {
        // Hop on: arc from where they stand up into the saddle, turning to face the mount's way.
        const t = (this.frame - hopStart) / HOP_FRAMES;
        const e = t * t * (3 - 2 * t);
        if (t < 0.5) applyPose(g, "stand", h);
        const from = g.position.clone(); // standing spot, set by the free-actor pass above
        g.position.lerpVectors(from, seatPos, e);
        g.position.y += Math.sin(Math.PI * t) * 0.35 * h / 1.8;
        const dy = Math.atan2(Math.sin(hg.rotation.y - g.rotation.y), Math.cos(hg.rotation.y - g.rotation.y));
        g.rotation.y += dy * e;
        continue;
      }
      g.position.copy(seatPos);
      g.rotation.order = "YXZ";
      g.rotation.y = hg.rotation.y;
      // Ride the motion: lean into speed, rise and fall with the stride (the host's bounce is in its y already).
      const hs = hg.userData.speed || 0;
      // Only riders lean and post; someone sitting in a vehicle seat stays upright however fast it goes.
      const seated = !!SEATS[host.kind] || (a.pose || m.pose) === "sit";
      const lean = seated ? 0 : Math.max(0, Math.min(1, (hs - 2) / 6));
      // At a gallop: a two-point crouch over the neck, up off the seat, pumping with each stride (LTX copies it).
      const ph = (hg.userData.gaitCycle || 0) + 0.6;
      g.rotation.x = (0.42 + 0.06 * Math.sin(ph * 2)) * lean + (hg.rotation.x || 0);
      g.position.y += h * lean * (0.035 + 0.05 * Math.abs(Math.sin(ph)));
      g.position.z += 0.06 * h * lean * Math.cos(hg.rotation.y);
      g.position.x += 0.06 * h * lean * Math.sin(hg.rotation.y);
    }
    // Carried things ride in the carrier's hands from carry_at (lifted over a few frames); the carrier's arms hold it.
    for (const o of this.state.actors) {
      if (!o.carry_id) continue;
      const og = this.actorMeshes.get(o.id), c = this.state.actors.find((x) => x.id === o.carry_id);
      const cg = c && this.actorMeshes.get(c.id);
      if (!og || !cg) continue;
      const at = o.carry_at || 0;
      if (this.frame < at - LIFT_FRAMES) continue;           // still where it was put down
      const t = Math.min(1, (this.frame - (at - LIFT_FRAMES)) / LIFT_FRAMES);
      const e = t * t * (3 - 2 * t);
      const ch = (c.height_m || 1.8) * (c.scale || 1);
      og.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(og).getSize(new THREE.Vector3());
      const reach = 0.25 + Math.min(size.x, size.z) / 2;
      const fwd = new THREE.Vector3(Math.sin(cg.rotation.y), 0, Math.cos(cg.rotation.y));
      const hold = new THREE.Vector3(cg.position.x, cg.position.y + 0.62 * ch - size.y / 2, cg.position.z).addScaledVector(fwd, reach);
      const rest = this._actorPosAt(o, this.frame);
      og.position.set(rest[0] + (hold.x - rest[0]) * e, hold.y * e, rest[2] + (hold.z - rest[2]) * e);
      og.rotation.y = cg.rotation.y * e + og.rotation.y * (1 - e);
      if (t >= 0.5) for (const l of cg.userData.limbs || []) {   // arms forward, elbows bent around the load
        if (l.part === "shoulder") l.pivot.rotation.x = -1.15;
        if (l.part === "elbow") l.pivot.rotation.x = -0.6;
      }
    }
    // Pose Studio keys last: they override the walk cycle / seat pose for the joints they name.
    for (const a of this.state.actors) {
      if (!a.pose_keys?.length) continue;
      const g = this.actorMeshes.get(a.id);
      if (g) applyJoints(g, this.poseAt(a, this.frame));
    }
    // Motion capture last: a take recorded from video drives the whole body (and its path) while it plays, and holds
    // its first / last pose before and after.
    const mocapIds = new Set();
    for (const a of this.state.actors) {
      if (!a.mocap || a.mount_id) continue;
      const take = Mocap.takeFor(a.mocap);
      if (!take) { this._loadMocap(a); continue; }
      const g = this.actorMeshes.get(a.id);
      if (!g) continue;
      const p = this._actorPosAt(a, this.frame);
      Mocap.apply(g, take, a.mocap, this.frame, { x: p[0], y: this._heightAt(a, this.frame), z: p[2], yaw: this._headingAt(a, this.frame) },
        (a.height_m || 1.8) * (a.scale || 1), this.state.shot?.fps || 24);
      mocapIds.add(a.id);
    }
    // Look at: the head and neck turn toward a target every frame (from look_at_frame on), within a natural range.
    for (const a of this.state.actors) {
      if (mocapIds.has(a.id)) continue;
      if (!a.look_at || this.frame < (a.look_at_frame || 0) - 8) continue;
      if (a.look_until != null && this.frame > a.look_until + 8) continue;
      // Ease in over 8 frames from look_at_frame, and back out over 8 frames after look_until.
      const ease = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
      const w = ease((this.frame - (a.look_at_frame || 0) + 8) / 8) * (a.look_until != null ? ease((a.look_until + 8 - this.frame) / 8) : 1);
      const g = this.actorMeshes.get(a.id), t = this.actorMeshes.get(a.look_at);
      if (!g?.userData?.joints?.head || !t) continue;
      g.updateMatrixWorld(true);
      const head = new THREE.Vector3(); g.userData.joints.head.getWorldPosition(head);
      const box = new THREE.Box3().setFromObject(t), tgt = box.getCenter(new THREE.Vector3());
      tgt.y = Math.min(box.max.y - 0.12, PERSON_KINDS.has(this.state.actors.find((x) => x.id === a.look_at)?.kind) ? box.max.y - 0.12 : tgt.y);
      const local = g.worldToLocal(tgt.clone()), lh = g.worldToLocal(head.clone());
      const dx = local.x - lh.x, dy = local.y - lh.y, dz = local.z - lh.z;
      let yaw = Math.atan2(dx, dz) * 180 / Math.PI;               // + = toward the figure's left
      const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
      yaw = Math.max(-150, Math.min(150, yaw));
      const spine = Math.max(-40, Math.min(40, yaw - Math.max(-110, Math.min(110, yaw))));   // past 110 the chest turns too
      const rest = yaw - spine, neckY = rest * 0.3, headY = rest * 0.7;
      const cur = this.poseAt(a, this.frame) || {};
      const mix = (base, v) => base + (v - base) * w;
      applyJoints(g, { head: [mix(cur.head?.[0] || 0, Math.max(-40, Math.min(40, pitch * 0.7))), mix(cur.head?.[1] || 0, Math.max(-80, Math.min(80, headY))), cur.head?.[2] || 0],
        neck: [mix(cur.neck?.[0] || 0, Math.max(-20, Math.min(20, pitch * 0.3))), mix(cur.neck?.[1] || 0, Math.max(-35, Math.min(35, neckY))), cur.neck?.[2] || 0],
        ...(spine ? { spine: [cur.spine?.[0] || 0, mix(cur.spine?.[1] || 0, spine), cur.spine?.[2] || 0] } : {}) });
    }
    if (this.weather) {
      const cam = this._cameraAt(this.frame);
      this.weather.update(this.frame, { x: cam.target[0], z: cam.target[2] }, this);
    }
    try { this.setFx?.update?.(this.frame, this); } catch (err) { console.warn("Soundstage set", err); }
    if (this.selRing) {
      const sel = this.actorMeshes.get(this.selected);
      this.selRing.visible = !!sel;
      if (sel) {
        const a = this.state.actors.find((x) => x.id === this.selected);
        const r = Math.max(0.4, Math.min(3.5, (a?.height_m || 1) * (LIBRARY[a?.kind]?.rig === "vehicle" ? 1.6 : 0.4)));
        this.selRing.scale.setScalar(r / 0.6);
        this.selRing.position.set(sel.position.x, 0.02, sel.position.z);
      }
    }
    try { this.poser?.update(); } catch { /* not built yet */ }
    this._applyCamera();
    this.render();
  }

  /** Pose in 3D on / off for the selected person (P). Returns whether it is on. */
  setPoseMode(on) { return this.poser?.setActive(on ?? !this.poser.active) || false; }

  /** Jump to the first ("start") or last ("end") camera key. Kept for the Start/End buttons. */
  setKey(key) {
    const keys = this._camKeys();
    this.key = key;
    this.setFrame(key === "end" ? keys[keys.length - 1].frame : keys[0].frame);
  }

  /** Camera key at the playhead, created on first edit (auto-key, like Blender). */
  _editCamera() {
    const keys = this._camKeys();
    let k = keys.find((x) => x.frame === this.frame);
    if (!k) {
      k = { frame: this.frame, ...clone(this._cameraAt(this.frame)) };
      const host = this._followActor();
      if (host) { const inv = this._actorFrameInverse(host, this.frame); k.position = inv(k.position); k.target = inv(k.target); }
      keys.push(k);
      keys.sort((a, b) => a.frame - b.frame);
    }
    return k;
  }

  /** Object key at the playhead (auto-key). */
  _editActorKey(a) {
    const keys = this._actorKeys(a);
    let k = keys.find((x) => x.frame === this.frame);
    if (!k) {
      k = { frame: this.frame, position: this._actorPosAt(a, this.frame) };
      keys.push(k);
      keys.sort((x, y) => x.frame - y.frame);
    }
    return k;
  }

  /** Key frames for the timeline: camera, and the selected object if any. */
  keyInfo() {
    const a = this.state.actors.find((x) => x.id === this.selected);
    return { camera: this._camKeys().map((k) => k.frame), object: a ? this._actorKeys(a).map((k) => k.frame) : [],
      objectName: a?.name || null, last: this._lastFrame() };
  }

  /** Set a camera key (and the selected object's key) at the playhead from what you see now. */
  setKeyHere() {
    this._editCamera();
    const a = this.state.actors.find((x) => x.id === this.selected);
    if (a) this._editActorKey(a);
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Delete keys at the playhead (never the last remaining key). */
  deleteKeyHere() {
    const keys = this._camKeys();
    if (keys.length > 1) this.activeShot().camera_keys = keys.filter((k) => k.frame !== this.frame);
    const a = this.state.actors.find((x) => x.id === this.selected);
    if (a) {
      const ak = this._actorKeys(a);
      if (ak.length > 1) a.keys = ak.filter((k) => k.frame !== this.frame);
    }
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Jump to the previous (-1) or next (+1) key of the camera or the selected object. */
  gotoKey(dir) {
    const info = this.keyInfo();
    const frames = [...new Set([...info.camera, ...info.object])].sort((a, b) => a - b);
    const f = dir > 0 ? frames.find((x) => x > this.frame) : [...frames].reverse().find((x) => x < this.frame);
    if (f !== undefined) this.setFrame(f);
  }

  /** Per-frame shot camera (for exports: Layer Pack camera, Nuke .chan, etc.). */
  cameraTrack() {
    const out = [];
    for (let f = 0; f <= this._lastFrame(); f++) out.push({ frame: f, ...this._shotCameraAt(f) });
    return out;
  }

  _applyCamera() {
    const c = this._preview || this._shotCameraAt(this.frame || 0);
    this.camera.position.set(...c.position);
    this.camera.fov = vfovFromFocal(c.focal_mm, this.fw / this.fh);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(new THREE.Vector3(...c.target));
    if (c.roll) this.camera.rotateZ(c.roll);
  }

  _applySun() {
    const L = this.state.lighting || (this.state.lighting = clone(DEFAULT_SCENE.lighting));
    if (L.mode === "time") {
      // Real sun position for that hour, date and latitude; North rotates the set under the sky.
      const sp = solarPosition(L.hour, L.day_of_year, L.latitude);
      this.state.sun = { azimuth_deg: Math.round(((sp.azimuth + (L.north_deg || 0)) % 360 + 360) % 360),
        elevation_deg: Math.round(sp.elevation * 10) / 10 };
    }
    const { azimuth_deg, elevation_deg } = this.state.sun;
    const sky = skyFor(elevation_deg, L.overcast);
    // Below the horizon the key light becomes moonlight from the opposite side.
    const el = THREE.MathUtils.degToRad(sky.moon ? 35 : Math.max(elevation_deg, 1));
    const az = THREE.MathUtils.degToRad(sky.moon ? azimuth_deg + 180 : azimuth_deg);
    const r = 60;
    this.sun.position.set(r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.copy(kelvinToColor(sky.sunK));
    this.sun.intensity = sky.sun * (L.mode === "time" || L.overcast ? 1 : 1);
    this.sun.shadow.radius = 1 + sky.shadowSoft * 10;
    this.hemi.color.copy(kelvinToColor(sky.skyK));
    this.hemi.groundColor.set(sky.ground);
    this.hemi.intensity = sky.sky;
    this.skyPhase = sky.phase;
  }

  /** Time of day: set the clock (sun follows the real solar path). */
  setTimeOfDay(hour, extra = {}) {
    this.state.lighting = { ...(this.state.lighting || {}), ...extra, mode: "time", hour, preset: extra.preset ?? null };
    this._applySun();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Presets like Magic hour pick the hour when the sun is at the right height for this place and date. */
  applyTimePreset(key) {
    const p = TIME_PRESETS[key];
    if (!p) return;
    const L = this.state.lighting || {};
    const hour = p.sunElevation === null ? 12.5 : hourForElevation(p.sunElevation, p.side, L.day_of_year ?? 300, L.latitude ?? 34.05);
    this.setTimeOfDay(hour, { preset: key, overcast: !!p.overcast });
  }

  setNorth(deg) {
    this.state.lighting = { ...(this.state.lighting || {}), north_deg: deg };
    this._applySun();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Manual sun (the Sun/Height sliders) switches time-of-day off. */
  setSun(azimuth, elevation) {
    this.state.lighting = { ...(this.state.lighting || {}), mode: "manual", preset: null };
    this.state.sun = { azimuth_deg: azimuth, elevation_deg: elevation };
    this._applySun();
    this.render();
    this.onChange(this.toJSON());
  }

  // ---------- film lights ----------
  _buildLights() {
    for (const o of this.lightObjs || []) { this.scene.remove(o.light, o.light.target, o.handle); o.light.dispose?.(); }
    this.lightObjs = [];
    this.lightHandles = new Map();
    for (const l of this.state.lighting?.lights || []) {
      const spec = LIGHT_TYPES[l.type] || LIGHT_TYPES.key;
      const color = kelvinToColor(l.kelvin ?? spec.kelvin);
      const point = l.type === "practical" || l.type === "neon";
      const light = point ? new THREE.PointLight(color, (l.intensity ?? spec.intensity) * 3, 14, 2)
        : new THREE.SpotLight(color, (l.intensity ?? spec.intensity) * 5, 40, THREE.MathUtils.degToRad(l.angle ?? spec.angle),
            l.softness ?? spec.softness, 1.6);
      light.position.set(...l.position);
      light.castShadow = !point;
      if (!point) {
        light.target.position.set(...(l.target || [0, 1.2, 0]));
        light.shadow.mapSize.set(1024, 1024);
      }
      // A visible handle (viewport only) you can grab and drag, like an object.
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color }));
      handle.position.copy(light.position);
      handle.userData.lightId = l.id;
      this.scene.add(...[light, light.target, handle].filter(Boolean)); // point lights have no target
      this.lightObjs.push({ id: l.id, light, handle });
      this.lightHandles.set(l.id, handle);
    }
  }

  _subjectPoint() {
    const a = this.state.actors.find((x) => x.id === this.selected) || this.state.actors[0];
    const p = a ? this._actorPosAt(a, this.frame) : this._cameraAt(this.frame).target;
    return [p[0], (a?.height_m || 1.7) * 0.75, p[2]];
  }

  /** Add a film light near the subject, aimed at it. */
  addLight(type) {
    const spec = LIGHT_TYPES[type];
    if (!spec) return null;
    const L = this.state.lighting || (this.state.lighting = clone(DEFAULT_SCENE.lighting));
    const subj = this._subjectPoint();
    const cam = this._cameraAt(this.frame);
    const view = new THREE.Vector3(subj[0] - cam.position[0], 0, subj[2] - cam.position[2]).normalize();
    const right = new THREE.Vector3(view.z, 0, -view.x);
    // Classic placements relative to the camera: key 45° camera-left, fill camera-right, rim behind.
    const off = {
      key: right.clone().multiplyScalar(-2.4).add(view.clone().multiplyScalar(-2.4)),
      fill: right.clone().multiplyScalar(2.6).add(view.clone().multiplyScalar(-2.0)),
      rim: right.clone().multiplyScalar(1.2).add(view.clone().multiplyScalar(3.0)),
      practical: right.clone().multiplyScalar(-1.5).add(view.clone().multiplyScalar(0.8)),
      spot: view.clone().multiplyScalar(-1.0),
      neon: right.clone().multiplyScalar(2.0).add(view.clone().multiplyScalar(1.5)),
    }[type];
    const n = (L.lights || []).filter((x) => x.type === type).length + 1;
    const light = { id: `light_${Date.now().toString(36)}${n}`, type, name: `${spec.label} ${n}`,
      position: [+(subj[0] + off.x).toFixed(2), spec.height, +(subj[2] + off.z).toFixed(2)], target: subj,
      kelvin: spec.kelvin, intensity: spec.intensity, softness: spec.softness, angle: spec.angle };
    L.lights = [...(L.lights || []), light];
    this._buildLights();
    this.selectLight(light.id);
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return light.name;
  }

  /**
   * Light the subject with a named setup (Rembrandt, book light, low-key noir…). Each light is given relative to
   * the subject and camera: azimuth 0 = from the camera, +90 = camera-left, -90 = camera-right, 180 = behind;
   * elevation above the subject's eyes; distance in metres. Replaces the previous setup's lights (keeps others).
   */
  applyLightingSetup(setup) {
    if (!setup?.lights?.length) return 0;
    const L = this.state.lighting || (this.state.lighting = clone(DEFAULT_SCENE.lighting));
    const subj = this._subjectPoint();
    const cam = this._cameraAt(this.frame);
    const view = new THREE.Vector3(subj[0] - cam.position[0], 0, subj[2] - cam.position[2]);
    if (view.lengthSq() < 1e-6) view.set(0, 0, -1);
    view.normalize();
    const right = new THREE.Vector3(view.z, 0, -view.x);
    const eye = Math.max(1.0, (subj[1] || 0) + 1.55);
    L.lights = (L.lights || []).filter((l) => !l.from_setup);
    setup.lights.forEach((l, i) => {
      const type = LIGHT_TYPES[l.type] ? l.type : "key";
      const spec = LIGHT_TYPES[type];
      const a = THREE.MathUtils.degToRad(+l.azimuth_deg || 0), e = THREE.MathUtils.degToRad(+l.elevation_deg || 0);
      const d = Math.max(0.6, +l.distance_m || 2.5);
      const dir = view.clone().multiplyScalar(-Math.cos(a)).add(right.clone().multiplyScalar(-Math.sin(a)));
      const pos = [subj[0] + dir.x * d * Math.cos(e), Math.max(0.2, eye + d * Math.sin(e)), subj[2] + dir.z * d * Math.cos(e)];
      L.lights.push({ id: `light_${setup.id || "setup"}_${i}_${Date.now().toString(36)}`, type, from_setup: setup.id || true,
        name: `${(l.role || type).replace(/^./, (c) => c.toUpperCase())} (${setup.label || "setup"})`,
        position: pos.map((v) => +v.toFixed(2)), target: [subj[0], eye - 0.15, subj[2]],
        kelvin: +l.kelvin || spec.kelvin, intensity: +l.intensity || spec.intensity,
        softness: l.softness ?? spec.softness, angle: spec.angle });
    });
    L.setup = setup.id || null;
    L.setup_prompt = setup.prompt_words || "";
    this._buildLights();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return setup.lights.length;
  }

  /** Key + fill + rim around the selected (or first) subject, relative to the camera. */
  autoThreePoint() {
    const L = this.state.lighting || (this.state.lighting = clone(DEFAULT_SCENE.lighting));
    L.lights = (L.lights || []).filter((l) => !["key", "fill", "rim"].includes(l.type));
    for (const t of ["key", "fill", "rim"]) this.addLight(t);
  }

  selectLight(id) {
    this.selectedLight = id && this.lightHandles?.has(id) ? id : null;
    for (const [lid, h] of this.lightHandles || []) h.scale.setScalar(lid === this.selectedLight ? 1.6 : 1);
    this.render();
    this.onSelectLight?.(this.selectedLightInfo());
  }

  selectedLightInfo() {
    return (this.state.lighting?.lights || []).find((l) => l.id === this.selectedLight) || null;
  }

  updateLight(patch) {
    const l = this.selectedLightInfo();
    if (!l) return;
    Object.assign(l, patch);
    if (patch.height !== undefined) l.position = [l.position[0], patch.height, l.position[2]];
    this._buildLights();
    this.selectLight(l.id);
    this.onChange(this.toJSON());
  }

  removeLight() {
    const L = this.state.lighting;
    if (!L || !this.selectedLight) return;
    L.lights = L.lights.filter((l) => l.id !== this.selectedLight);
    this.selectedLight = null;
    this._buildLights();
    this.render();
    this.onSelectLight?.(null);
    this.onChange(this.toJSON());
  }

  /** DP-style lighting note for prompts. */
  lightingPrompt() {
    const base = describeLighting(this.state.lighting, this.state.sun, this._cameraAt(0));
    const setup = this.state.lighting?.setup_prompt;
    const name = (x) => (x.name || LIBRARY[x.kind]?.label || x.kind).toLowerCase();
    const torches = this.state.actors.filter((x) => x.kind === "flashlight" && (x.beam || "steady") !== "off").map((t) => {
      const who = this.state.actors.find((x) => x.id === t.carry_id);
      const how = { flicker: "a flickering", blink: "a blinking, on-and-off" }[t.beam] || "a hard, narrow";
      return who ? `the ${name(who)} sweeps ${how} flashlight beam ahead, a bright pool of cool white light moving across the surfaces`
        : `${how} flashlight beam cuts across the scene, a bright pool of cool white light`;
    });
    return [...torches, setup, base].filter(Boolean).join("; ");
  }

  /** Flashlight beam: steady, flicker, blink or off. */
  setBeam(id, mode) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a || a.kind !== "flashlight") return;
    if (mode === "steady") delete a.beam; else a.beam = mode;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }


  // ---------- interaction ----------
  /** True when a camera sits inside the water volume (above the floor, below the surface, inside the tank). */
  _isUnderwater(cam) {
    if (!this.water) return false;
    const w = this.water, p = cam.position;
    const half = w.geometry.parameters;
    return p.y < w.position.y && p.y > 0 &&
      Math.abs(p.x - w.position.x) < half.width / 2 && Math.abs(p.z - w.position.z) < half.height / 2;
  }

  // ---------- navigation ----------
  /** Orbit state being edited: the free viewport, or the shot camera's current key. */
  _activeOrbit() {
    return this.freeView ? this.free : this._editCamera();
  }

  /** Camera the viewport looks through (captures always use the shot camera). */
  _viewportCamera() {
    return this.freeView ? this.viewCam : this.camera;
  }

  _applyActive() {
    if (this.freeView) {
      this.viewCam.position.set(...this.free.position);
      this.viewCam.lookAt(new THREE.Vector3(...this.free.target));
      this.camHelper?.update();
      this.render();
    } else {
      this.setFrame(this.frame);
    }
  }

  /** Show a live camera (e.g. the virtual camera) without changing any keys; null clears it. */
  previewCamera(cam) {
    this._preview = cam || null;
    this._applyCamera();
    this.render();
  }

  /** Replace the active shot's camera keys (e.g. a stabilized virtual-camera take). */
  setCameraKeys(keys) {
    if (!keys?.length) return;
    this.activeShot().camera_keys = keys.map((k) => ({ frame: k.frame, position: [...k.position], target: [...k.target],
      focal_mm: k.focal_mm ?? this._cameraAt(this.frame).focal_mm }));
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Free view = fly around the whole set without touching the shot (Blender's viewport vs camera). */
  setFreeView(on) {
    this.freeView = !!on;
    if (this.freeView && !this.freeInit) {
      // Start behind and above the shot camera so you can see it and what it frames.
      const c = this._cameraAt(this.frame);
      const pos = new THREE.Vector3(...c.position), tgt = new THREE.Vector3(...c.target);
      const back = pos.clone().sub(tgt).setLength(8).add(new THREE.Vector3(0, 4, 0));
      this.free = { position: pos.clone().add(back).toArray(), target: tgt.toArray() };
      this.freeInit = true;
    }
    this._applyActive();
    this.onView?.(this.freeView);
  }

  /** Snap the active view to look along an axis ("+x", "-y", ...), keeping its distance. */
  snapView(axis) {
    const o = this._activeOrbit();
    const tgt = new THREE.Vector3(...o.target);
    const dist = new THREE.Vector3(...o.position).distanceTo(tgt);
    const dir = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0.0001], "-y": [0, -1, 0.0001],
      "+z": [0, 0, 1], "-z": [0, 0, -1] }[axis];
    o.position = tgt.clone().add(new THREE.Vector3(...dir).normalize().multiplyScalar(dist)).toArray().map((v) => +v.toFixed(3));
    this._applyActive();
    if (!this.freeView) this.onChange(this.toJSON());
  }

  _bindControls() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let drag = null;

    this.freeView = false;
    this.free = null;
    this.viewCam = new THREE.PerspectiveCamera(50, this.fw / this.fh, 0.05, 600);
    this.camHelper = new THREE.CameraHelper(this.camera);
    this.camHelper.visible = false;
    this.scene.add(this.camHelper);

    // Move / rotate / scale gizmo on the selected object (NKD / Blender style): G move, R rotate, T scale.
    // Constrained to the stage's model: move on the floor, turn about the vertical, scale uniformly.
    this.tc = new TransformControls(this.camera, this.canvas);
    this.tc.setSpace("world");
    this.tc.setSize(1.15);
    this.tcHelper = this.tc.getHelper();
    this.tcHelper.visible = false;
    // Its own scene, drawn on top after the main pass, so Clay / Depth / Wire material overrides can't hide it.
    this.gizmoScene = new THREE.Scene();
    this.gizmoScene.add(this.tcHelper);
    this.setGizmoMode("translate");
    this.tc.addEventListener("change", () => { if (!this._inRender) this.render(); });
    this.tc.addEventListener("objectChange", () => this._gizmoToActor());
    this.poser = new PoseGizmo(this);   // pose in 3D: click a body part, turn it; drag a hand / foot dot (IK)
    this.tc.addEventListener("dragging-changed", (e) => {
      this._gizmoDragging = e.value;
      if (e.value) { this.live?.finish(); this._gizmoScale0 = this.tc.object?.scale.x || 1; }
      // A prop moved with the arrows falls onto whatever is under it and settles (one undo step with the move).
      else if (!(this.gizmoMode === "translate" && !this.poser?.target() && this.selected && this.live?.settle(this.selected))) this.onChange(this.toJSON());
    });

    const pick = (e) => {
      const r = this.canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this._viewportCamera());
    };

    this.canvas.tabIndex = 0; // so W/A/S/D/Q/E reach the stage
    this.canvas.addEventListener("pointerenter", () => this.canvas.focus({ preventScroll: true }));
    this.canvas.addEventListener("pointerleave", () => { if (this._hoverId) { this._hoverId = null; this.render(); } });
    this._pickRay = (e) => { pick(e); return ray; };

    this.canvas.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.canvas.focus({ preventScroll: true });
      if (this.live?.busy) this.live.finish();   // things still settling from the last drop: write them down first
      if (this._glideRaf) { cancelAnimationFrame(this._glideRaf); this._glideRaf = 0; if (!this.freeView) this.onChange(this.toJSON()); }
      if (this._flyRaf) { cancelAnimationFrame(this._flyRaf); this._flyRaf = 0; }
      if (this.tcHelper.visible && (this.tc.axis || this.tc.dragging)) return; // the gizmo has this drag
      pick(e);
      if (this.poser?.active && !e.altKey && this.poser.pointerDown(e, ray)) {
        drag = { mode: "pose" };
        this.canvas.setPointerCapture(e.pointerId);
        this._dragging = true;
        return;
      }
      const lhit = ray.intersectObjects([...(this.lightHandles?.values() || [])], false)[0];
      if (lhit && !e.altKey) {
        drag = { mode: "light", id: lhit.object.userData.lightId };
        this.selectLight(drag.id);
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      let hitId = ray.intersectObjects([...this.actorMeshes.values()], true)[0]?.object?.userData?.actorId || null;
      // Far-away people are a few pixels wide: a click within ~12 px of an object's on-screen outline still grabs it.
      if (!hitId && !e.altKey) hitId = this._nearOnScreen(e, 12);
      // From inside a car (or any object the camera sits in), a drag is the camera's, never the car's: everything
      // around you is the car. A seated rider can still be clicked to select (pose them), but not dragged off the seat.
      const camPos = this._viewportCamera().getWorldPosition(new THREE.Vector3());
      const inside = (id) => { const g = this.actorMeshes.get(id); return !!g && new THREE.Box3().setFromObject(g).expandByScalar(0.05).containsPoint(camPos); };
      const hitActor = hitId && this.state.actors.find((x) => x.id === hitId);
      if (hitId && !e.altKey && (inside(hitId) || (hitActor?.mount_id && inside(hitActor.mount_id)))) {
        if (hitActor?.mount_id) this.select(hitId);
        drag = { mode: e.shiftKey || e.button === 1 ? "pan" : "orbit", look: true, x: e.clientX, y: e.clientY };
      } else if (hitId && !e.altKey && e.button === 0 && !this._isSetPiece(hitId) && (hitId === this.selected || this._grabbable(hitActor))) {
        // Grab it (Milestone 9): press on an object and drag = it follows the cursor, live, colliding with the set.
        // Small things go straight away; whole buildings and big set dressing need a click to select first.
        if (hitId !== this.selected) this.select(hitId);
        drag = { mode: "pending", id: hitId, x0: e.clientX, y0: e.clientY, e, ray: { ray: ray.ray.clone() } };
      } else {
        // Anything else is the camera's: a drag orbits (or pans), and a click without a drag selects what was under it.
        // So nothing moves by accident while you look around.
        drag = { mode: e.shiftKey || e.button === 1 ? "pan" : "orbit", look: e.altKey, x: e.clientX, y: e.clientY,
          x0: e.clientX, y0: e.clientY, pickId: e.altKey ? null : hitId };
      }
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      this.canvas.style.cursor = "grabbing";
      this._dragging = true;
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (!drag) { this._hoverMove(e); return; }
      e.stopPropagation();
      if (drag.mode === "pending") {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
        this._hoverId = null;
        const ok = !this.freeze3d && this.live.begin(drag.id, drag.e, drag.ray);
        drag = ok ? { mode: "live", id: drag.id } : { mode: "actor", id: drag.id };
        this.canvas.style.cursor = "grabbing";
      }
      if (drag.mode === "live") { pick(e); this.live.move(e, ray); return; }
      if (drag.mode === "pose") { pick(e); this.poser.pointerMove(ray); return; }
      if (drag.mode === "light") {
        pick(e);
        const l = (this.state.lighting?.lights || []).find((x) => x.id === drag.id);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -l.position[1]);
        const p = new THREE.Vector3();
        if (l && ray.ray.intersectPlane(plane, p)) {
          l.position = [+p.x.toFixed(2), l.position[1], +p.z.toFixed(2)];
          const o = this.lightObjs.find((x) => x.id === l.id);
          o.light.position.set(...l.position);
          o.handle.position.set(...l.position);
          this.render();
        }
        return;
      }
      if (drag.mode === "actor") {
        pick(e);
        const p = new THREE.Vector3();
        if (ray.ray.intersectPlane(floor, p)) {
          const a = this.state.actors.find((x) => x.id === drag.id);
          this._editActorKey(a).position = [+p.x.toFixed(2), 0, +p.z.toFixed(2)];
          this.setFrame(this.frame);
        }
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      // Remember how fast it was going, for the glide after you let go (inertia).
      const now = performance.now(), dtm = Math.max(1, now - (drag.t || now - 16));
      drag.vx = (drag.vx || 0) * 0.5 + (dx / dtm) * 0.5; drag.vy = (drag.vy || 0) * 0.5 + (dy / dtm) * 0.5; drag.t = now;
      this._navDrag(drag.mode, drag.look, dx, dy);
    });

    const end = (e) => {
      this._dragging = false;
      if (!drag) return;
      if (drag.mode === "pose") { this.poser.pointerUp(); drag = null; return; }
      if (drag.mode === "pending") {   // a click on an object: it is selected (on press)
        const id = drag.id;
        drag = null;
        this.canvas.style.cursor = "grab";
        if (id && !this._isSetPiece(id)) this.onInteract?.("Selected. Drag it to move it (it bumps into things); Alt+drag turns it, the wheel lifts a prop, F frames it.");
        return;
      }
      if (drag.mode === "live") {
        drag = null;
        this.canvas.style.cursor = "grab";
        this.live.end();
        return;
      }
      if ((drag.mode === "orbit" || drag.mode === "pan") && e?.clientX != null && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) {
        // A click, not a drag: select what was under the pointer (or clear the selection on empty space).
        const id = drag.pickId;
        drag = null;
        this._dragging = false;
        this.canvas.style.cursor = "grab";
        this.select(id || null);
        if (id && !this._isSetPiece(id)) this.onInteract?.("Selected. Drag it (or its arrows) to move it; drag anywhere else to look around.");
        return;
      }
      if ((drag.mode === "orbit" || drag.mode === "pan") && performance.now() - (drag.t || 0) < 70 && Math.hypot(drag.vx || 0, drag.vy || 0) > 0.15) {
        const { mode, look, vx, vy } = drag;
        drag = null;
        this.canvas.style.cursor = "grab";
        this._glide(mode, look, vx, vy);
        return;
      }
      if (drag.mode === "actor") {
        // What's under the cursor on release is what you dropped onto (the floor point can land metres behind a car).
        let under = null;
        if (e?.clientX != null) {
          pick(e);
          const meshes = [];
          for (const [id, g] of this.actorMeshes) if (id !== drag.id) g.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
          under = ray.intersectObjects(meshes, false)[0]?.object?.userData?.actorId || this._nearOnScreen(e, 8, drag.id);
        }
        try { this._dropInteract(drag.id, under); } catch (err) { console.warn("Soundstage interact", err); }
      }
      drag = null;
      this.canvas.style.cursor = "grab";
      if (!this.freeView) this.onChange(this.toJSON());
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);

    // Fly: W/S forward/back, A/D strafe, Q/E down/up (Shift = 4x). 0 toggles shot cam / free view.
    this.canvas.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      if (this.live?.drag && this.live.key(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if ((e.metaKey || e.ctrlKey) && k === "z") {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && k === "d") { e.preventDefault(); e.stopPropagation(); this.duplicateSelected(); return; }
      if (k === "f" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        this.frameSelected();
        return;
      }
      if (k === "0") {
        e.preventDefault(); e.stopPropagation();
        this.setFreeView(!this.freeView);
        return;
      }
      if (k === "p" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); e.stopPropagation();
        const on = this.setPoseMode();
        this.onInteract?.(on ? "Pose in 3D: click a body part and turn the ring; drag a yellow dot to move a hand or foot. P or Esc to finish." :
          (this.selected ? "Pose mode off." : "Select a person first, then press P to pose them in 3D."));
        return;
      }
      if (k === "escape" && this.poser?.active) { e.preventDefault(); e.stopPropagation(); this.setPoseMode(false); this.onInteract?.("Pose mode off."); return; }
      if ((k === "g" || k === "r" || k === "t") && !e.metaKey && !e.ctrlKey && this.selected) {
        e.preventDefault(); e.stopPropagation();
        this.setGizmoMode({ g: "translate", r: "rotate", t: "scale" }[k]);
        return;
      }
      if (!"wasdqe".includes(k) || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const c = this._activeOrbit();
      const cam = this._viewportCamera();
      const pos = new THREE.Vector3(...c.position), tgt = new THREE.Vector3(...c.target);
      const fwd = tgt.clone().sub(pos).normalize();
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      const stepLen = (e.shiftKey ? 4 : 1) * THREE.MathUtils.clamp(pos.distanceTo(tgt) * 0.06, this._tightCamera(pos, tgt) ? 0.03 : 0.1, 1.5);
      const move = { w: fwd, s: fwd.clone().negate(), d: right, a: right.clone().negate(),
        e: new THREE.Vector3(0, 1, 0), q: new THREE.Vector3(0, -1, 0) }[k].clone().multiplyScalar(stepLen);
      c.position = pos.add(move).toArray().map((v) => +v.toFixed(3));
      c.target = tgt.add(move).toArray().map((v) => +v.toFixed(3));
      this._applyActive();
      if (!this.freeView) { clearTimeout(this._keyT); this._keyT = setTimeout(() => this.onChange(this.toJSON()), 250); }
    });
    for (const t of ["keyup", "keypress"]) this.canvas.addEventListener(t, (e) => e.stopPropagation());

    // Scroll wheel = dolly. ComfyUI's canvas listens for the wheel before this element does
    // (that's why scrolling zoomed the graph), so a window-level capture listener routes wheel
    // events that happen over a stage straight to it. See installWheelRouter() below.
    this.canvas.__soundstage = this;
    this._onWheel = (e) => {
      if (this.live?.drag && this.live.wheel(e)) return;   // holding a prop: the wheel lifts / lowers it
      // Smooth zoom (Milestone 9): notches add up and are eased in over a few frames, toward what's under the cursor.
      this._zoomAcc = (this._zoomAcc || 0) + THREE.MathUtils.clamp(e.deltaY * (e.deltaMode === 1 ? 33 : 1), -300, 300);
      this._zoomEv = { clientX: e.clientX, clientY: e.clientY };
      if (!this._zoomRaf) this._zoomRaf = requestAnimationFrame(() => this._zoomStep());
    };
    this._zoomStep = () => {
      this._zoomRaf = 0;
      const take = Math.abs(this._zoomAcc) < 3 ? this._zoomAcc : this._zoomAcc * 0.4;
      this._zoomAcc -= take;
      const c = this._activeOrbit();
      const pos = new THREE.Vector3(...c.position);
      const tgt = new THREE.Vector3(...c.target);
      const dir = tgt.clone().sub(pos);
      const dist = dir.length();
      const P = this._tightCamera(pos, tgt) ? null : this._zoomPoint(this._zoomEv, pos, tgt);
      if (P && !(take < 0 && P.distanceTo(pos) < 0.5)) {
        // Scale about the point under the cursor: it stays put on screen and the view direction is kept.
        const z = zoomAt(pos.toArray(), tgt.toArray(), P.toArray(), Math.exp(take * 0.0018));
        c.position = z.pos.map((v) => +v.toFixed(3));
        c.target = z.tgt.map((v) => +v.toFixed(3));
      } else {
        // Proportional dolly (inside a car, close in): near the target, fly on through it (the target moves ahead too).
        const step = Math.max(dist, 0.6) * (Math.exp(take * 0.0018) - 1);   // + = back off
        const move = dir.normalize().multiplyScalar(-step);
        pos.add(move);
        if (step < 0 && (pos.distanceTo(tgt) < 0.25 || move.dot(tgt.clone().sub(pos)) < 0)) tgt.add(move);
        c.position = pos.toArray().map((v) => +v.toFixed(3));
        c.target = tgt.toArray().map((v) => +v.toFixed(3));
      }
      this._applyActive();
      if (!this.freeView) { clearTimeout(this._wheelT); this._wheelT = setTimeout(() => this.onChange(this.toJSON()), 250); }
      if (Math.abs(this._zoomAcc) > 0.5) this._zoomRaf = requestAnimationFrame(() => this._zoomStep());
      else this._zoomAcc = 0;
    };
    installWheelRouter();
  }

  /** Orbit / pan / look-around by a pointer delta (px). Shared by the drag and its glide afterwards. */
  _navDrag(mode, look, dx, dy) {
    const c = this._activeOrbit();
    const cam = this._viewportCamera();
    const pos = new THREE.Vector3(...c.position);
    const tgt = new THREE.Vector3(...c.target);
    if (mode === "orbit" && (look || this._tightCamera(pos, tgt))) {
      // Look around in place (a tripod head): inside a car or close in, orbiting would swing the camera out through
      // the doors. Alt+drag does this anywhere.
      const off = tgt.clone().sub(pos);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta -= dx * 0.003;
      sph.phi = THREE.MathUtils.clamp(sph.phi + dy * 0.003, 0.05, Math.PI - 0.05);
      tgt.copy(pos).add(new THREE.Vector3().setFromSpherical(sph));
    } else if (mode === "orbit") {
      // Turntable orbit with no floor limit: go under, over, all the way round.
      const off = pos.clone().sub(tgt);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta -= dx * 0.005;
      sph.phi = THREE.MathUtils.clamp(sph.phi - dy * 0.005, 0.001, Math.PI - 0.001);
      pos.copy(tgt).add(new THREE.Vector3().setFromSpherical(sph));
    } else {
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
      const k = pos.distanceTo(tgt) * 0.0015;
      const move = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
      pos.add(move);
      tgt.add(move);
    }
    // Stay above the floor (a far camera swings metres for a small drag); the water tank lets you go under.
    if (this.state.environment?.set !== "water_tank" && pos.y < 0.15) {
      if (mode !== "orbit") tgt.y += 0.15 - pos.y;
      pos.y = 0.15;
    }
    c.position = pos.toArray().map((v) => +v.toFixed(3));
    c.target = tgt.toArray().map((v) => +v.toFixed(3));
    this._applyActive();
  }

  /** Glide on after a flick (orbit / pan inertia), decaying to a stop; the shot key is saved once it stops. */
  _glide(mode, look, vx, vy) {
    cancelAnimationFrame(this._glideRaf);
    let t = performance.now();
    const step = () => {
      const now = performance.now(), dt = Math.min(50, now - t);
      t = now;
      [vx, vy] = decay([vx, vy], dt / 1000, 0.16);
      if (Math.hypot(vx, vy) < 0.02 || this._dragging) { this._glideRaf = 0; if (!this.freeView) this.onChange(this.toJSON()); return; }
      this._navDrag(mode, look, vx * dt, vy * dt);
      this._glideRaf = requestAnimationFrame(step);
    };
    this._glideRaf = requestAnimationFrame(step);
  }

  /** Fly the active view to a new position / target, eased (~0.45 s). */
  _flyTo(pos, tgt, ms = 450) {
    cancelAnimationFrame(this._flyRaf);
    const c = this._activeOrbit();
    const p0 = [...c.position], t0 = [...c.target], start = performance.now();
    const step = () => {
      const u = Math.min(1, (performance.now() - start) / ms), e = easeInOut(u);
      const o = this._activeOrbit();
      o.position = p0.map((v, i) => +(v + (pos[i] - v) * e).toFixed(3));
      o.target = t0.map((v, i) => +(v + (tgt[i] - v) * e).toFixed(3));
      this._applyActive();
      if (u < 1) this._flyRaf = requestAnimationFrame(step);
      else { this._flyRaf = 0; if (!this.freeView) this.onChange(this.toJSON()); }
    };
    this._flyRaf = requestAnimationFrame(step);
  }

  /** The point a zoom closes in on: the nearest object box or the floor under the cursor, else the target's depth. */
  _zoomPoint(ev, pos, tgt) {
    if (!ev || !this._pickRay) return null;
    const ray = this._pickRay(ev).ray;
    let best = null;
    const box = new THREE.Box3(), hit = new THREE.Vector3();
    for (const g of this.actorMeshes.values()) {
      if (!g.visible) continue;
      box.setFromObject(g);
      if (box.isEmpty() || box.containsPoint(ray.origin)) continue;
      const p = ray.intersectBox(box, hit);
      if (p && (!best || p.distanceTo(ray.origin) < best.distanceTo(ray.origin))) best = p.clone();
    }
    const floor = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (floor && floor.distanceTo(ray.origin) < 400 && (!best || floor.distanceTo(ray.origin) < best.distanceTo(ray.origin))) best = floor;
    if (best) return best;
    const n = tgt.clone().sub(pos).normalize();
    return ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, tgt), new THREE.Vector3());
  }

  /** F: frame the selection (or the whole set when nothing is selected) without changing the view direction. */
  frameSelected() {
    const box = new THREE.Box3();
    const sel = this.selected && this.actorMeshes.get(this.selected);
    if (sel) box.setFromObject(sel);
    else for (const g of this.actorMeshes.values()) if (g.visible) box.expandByObject(g);
    if (box.isEmpty()) return false;
    const sph = box.getBoundingSphere(new THREE.Sphere());
    const c = this._activeOrbit(), cam = this._viewportCamera();
    const f = frameSphere(c.position, c.target, sph.center.toArray(), sph.radius, THREE.MathUtils.degToRad(cam.fov), cam.aspect || this.fw / this.fh);
    this._flyTo(f.pos, f.tgt);
    return true;
  }

  /** Set dressing that shouldn't move from a drag: the rebuilt location, walls, sidewalks, big set pieces. */
  _isSetPiece(id) {
    const a = this.state.actors.find((x) => x.id === id);
    return !!a && (a.set_piece || a.set_xform || a.locked);
  }

  /** Can a press-and-drag grab it straight away (without selecting first)? Everything but buildings and big set dressing. */
  _grabbable(a) {
    if (!a || a.set_piece || a.set_xform || a.locked || a.kind === "interior") return false;
    const L = LIBRARY[a.kind];
    return !(L?.rig === "static" && (L?.height || 0) > 4);
  }

  /** Hover: what a press would grab gets a thin outline (picked once a frame). */
  _hoverMove(e) {
    this._hoverEv = { clientX: e.clientX, clientY: e.clientY };
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      if (this._dragging || this.live?.drag || !this._hoverEv) return;
      const ray = this._pickRay(this._hoverEv);
      const id = this._pickActor(ray);
      const a = id && this.state.actors.find((x) => x.id === id);
      const next = a && (this._grabbable(a) || id === this.selected) && !this._isSetPiece(id) ? id : null;
      this.canvas.style.cursor = next ? "move" : "grab";
      if (next !== this._hoverId) { this._hoverId = next; this.render(); }
    });
  }

  /** The actor under a ray: boxes first (cheap), then the real meshes of the nearest few. */
  _pickActor(ray) {
    const cand = [];
    const box = new THREE.Box3(), hit = new THREE.Vector3();
    for (const [id, g] of this.actorMeshes) {
      if (!g.visible) continue;
      box.setFromObject(g);
      if (box.isEmpty()) continue;
      const p = ray.ray.intersectBox(box, hit);
      if (p) cand.push({ id, g, d: p.distanceTo(ray.ray.origin) });
    }
    cand.sort((x, y) => x.d - y.d);
    let best = null;
    for (const c of cand.slice(0, 6)) {
      const h = ray.intersectObject(c.g, true)[0];
      if (h && (!best || h.distance < best.distance)) best = { id: c.id, distance: h.distance };
    }
    return best?.id || null;
  }

  /** Close in (target within ~2.5 m) or inside a vehicle / building: drag looks around instead of orbiting. */
  _tightCamera(pos, tgt) {
    if (pos.distanceTo(tgt) < 2.5) return true;
    for (const [id, g] of this.actorMeshes) {
      const a = this.state.actors.find((x) => x.id === id);
      const rig = a && LIBRARY[a.kind]?.rig;
      if (rig !== "vehicle" && !a?.set_xform && a?.kind !== "interior") continue;
      const box = new THREE.Box3().setFromObject(g);
      if (box.containsPoint(pos)) return true;
    }
    return false;
  }

  // ---------- public API ----------
  /** Add an object by typed name ("dog", "a red car"). Returns its label, or null if unknown. */
  addObject(text) {
    const combo = resolveCompound(text);
    if (combo) {
      const hostName = this.addObject(combo.mount);
      const host = this.state.actors[this.state.actors.length - 1];
      const riderName = this.addObject(combo.rider);
      const rider = this.state.actors[this.state.actors.length - 1];
      this.mount(rider.id, host.id);
      this.select(host.id);
      return `${riderName} on ${hostName}`;
    }
    const kind = resolveKind(text);
    if (!kind) return null;
    const spec = LIBRARY[kind];
    const n = this.state.actors.filter((a) => a.kind === kind).length + 1;
    const id = `${kind}_${Date.now().toString(36)}`;
    // Drop it on the floor a few metres in front of the current camera.
    const cam = this._cameraAt(this.frame);
    const pos = new THREE.Vector3(...cam.position);
    const dir = new THREE.Vector3(...cam.target).sub(pos).setY(0).normalize();
    // Fan new objects out left/right of the camera's line so they don't land on each other.
    const k = this.state.actors.length;
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(((k % 5) - 2) * (spec.rig === "static" ? 4 : 2.4));
    // Where the centre of the frame meets the floor (a crane looking down the street sees that spot), else ahead.
    const look = new THREE.Vector3(...cam.target).sub(new THREE.Vector3(...cam.position));
    const tFloor = look.y < -0.05 ? -cam.position[1] / look.y : Infinity;
    const ahead = tFloor * Math.hypot(look.x, look.z);
    const spot = ahead > 2 && ahead < 40
      ? new THREE.Vector3(...cam.position).addScaledVector(look, tFloor).setY(0).add(side.multiplyScalar(0.5))
      : pos.add(dir.multiplyScalar(spec.rig === "static" ? 14 : 7 + (k % 3) * 1.5)).add(side);
    const p = [+spot.x.toFixed(2), 0, +spot.z.toFixed(2)];
    this.state.actors.push({ id, name: `${spec.label} ${n}`, kind, position: p, keys: [{ frame: 0, position: [...p] }],
      height_m: spec.height, rotation_deg: 0 });
    this._buildSet();
    this.select(id);
    this.onChange(this.toJSON());
    return `${spec.label} ${n}`;
  }

  // ---------- the rigged horse (CC0, Quaternius) ----------
  /** Swap the built horse's look for the rigged CC0 horse: the built one stays (hidden) for its pivots and
   *  seat; the rigged one walks, trots and gallops with real skeletal cycles locked to distance travelled. */
  _upgradeHorse(a, g) {
    loadAsset(HORSE_GLB, "glb").then((asset) => {
      if (this.actorMeshes.get(a.id) !== g || g.userData.horseRig) return;
      const model = SkeletonUtils.clone(asset.scene);
      const h = a.height_m || 1.6;
      const tint = a.appearance?.color ? new THREE.Color(a.appearance.color) : null;
      model.traverse((o) => {
        o.userData.actorId = a.id;
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        o.frustumCulled = false;                                   // skinned bounds don't follow the gallop
        if (tint && /^Main/.test(o.material?.name || "")) { o.material = o.material.clone(); o.material.color.lerp(tint, 0.85); }
      });
      for (const ch of g.children) ch.visible = false;
      const holder = new THREE.Group();
      holder.add(model);
      g.add(holder);
      const mixer = new THREE.AnimationMixer(model);
      const clip = (n) => asset.animations.find((x) => x.name === n) || asset.animations.find((x) => x.name.endsWith("|" + n));
      const actions = {};
      for (const n of ["Idle", "Walk", "Gallop"]) {
        const cl = clip(n);
        if (cl) { actions[n] = mixer.clipAction(cl); actions[n].play(); actions[n].enabled = n === "Idle"; }
      }
      mixer.update(0);
      // Measure the POSED skin (the raw geometry sits under a scaled armature), in the holder's space.
      holder.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(model, true).applyMatrix4(holder.matrixWorld.clone().invert());
      const k = (h * HORSE_HEAD_RATIO) / Math.max(1e-6, bb.max.y - bb.min.y);   // withers h -> ears at ~1.42 h
      holder.scale.setScalar(k);
      holder.position.set(-k * (bb.min.x + bb.max.x) / 2, -k * bb.min.y, -k * (bb.min.z + HORSE_BODY_Z * (bb.max.z - bb.min.z)));
      g.userData.horseRig = { mixer, actions, holder };
      this.setFrame(this.frame);
    }).catch((err) => console.warn("Soundstage: rigged horse failed, keeping the built one", err));
  }

  /** Pick Idle / Walk / Gallop by speed; the clip time follows distance so hooves don't skate. */
  _driveHorse(g, a, speed, dist) {
    const R = g.userData.horseRig;
    const h = a.height_m || 1.6;
    const fps = this.state.shot?.fps || 24;
    const name = speed < 0.3 ? "Idle" : speed < 3.2 ? "Walk" : "Gallop";
    const stride = name === "Gallop" ? 3.2 * h : 1.1 * h;          // metres per full cycle
    for (const [n, act] of Object.entries(R.actions)) {
      act.enabled = n === name;
      act.setEffectiveWeight(n === name ? 1 : 0);
      if (n !== name) continue;
      const d = act.getClip().duration || 1;
      act.time = name === "Idle" ? (this.frame / fps) % d : ((dist / stride) % 1) * d;
    }
    R.mixer.update(0);
    g.rotation.x = 0;                                              // the gallop clip rocks the body itself
    g.position.y = this._heightAt(a, this.frame);
  }

  // ---------- real-car bodies (CC0, Quaternius) ----------
  /** Put a car model over the built sedan (kept hidden for its seats and pivots), sized bumper to bumper; the
   *  wheels are re-pivoted on their hubs so they roll with the distance driven. */
  _upgradeVehicle(a, g, spec) {
    loadAsset(new URL(`./models/${spec.model}`, import.meta.url).href, "glb").then((asset) => {
      if (this.actorMeshes.get(a.id) !== g || g.userData.vehicleBody) return;
      const model = asset.scene.clone(true);
      model.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(model);
      const k = (spec.length * ((a.height_m || spec.height) / spec.height)) / Math.max(1e-6, bb.max.z - bb.min.z);
      const holder = new THREE.Group();
      holder.scale.setScalar(k);
      holder.position.set(-k * (bb.min.x + bb.max.x) / 2, -k * bb.min.y, -k * (bb.min.z + bb.max.z) / 2);
      // Wheels: each wheel group sits at the model origin; give it a pivot at its own hub.
      const wheels = [];
      const groups = [];
      model.traverse((o) => { if (/Wheel/i.test(o.name) && !o.isMesh && o.children.length) groups.push(o); });
      for (const w of groups) {
        const c = new THREE.Box3().setFromObject(w).getCenter(new THREE.Vector3());
        const wb = new THREE.Box3().setFromObject(w);
        const pivot = new THREE.Group();
        pivot.position.copy(c);
        pivot.userData.radius = Math.max(0.05, (wb.max.y - wb.min.y) / 2) * k;
        w.parent.add(pivot);
        pivot.add(w);
        w.position.sub(c);
        wheels.push(pivot);
      }
      const tint = a.appearance?.color ? new THREE.Color(a.appearance.color) : null;
      model.traverse((o) => {
        o.userData.actorId = a.id;
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (/^(Windows?|Glass)$/i.test(o.material?.name || "")) { makeGlass(o); return; }   // the models' opaque black glass: see-through
        // Lit lamps (Color pass): warm-white headlights lead, red tail lights trail, so the guide and the look still
        // read which end of the car is the front (an unlit car looks the same both ways round in depth and colour).
        const lamp = { Headlights: [0xfff2dc, 1.8], TailLights: [0xff1a0e, 1.4] }[o.material?.name];
        if (lamp) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(lamp[0]); o.material.emissiveIntensity = lamp[1]; o.userData.lamp = o.material.name; return; }
        if (tint && /^(Blue|White|Red|Body|Main)/.test(o.material?.name || "")) { o.material = o.material.clone(); o.material.color.copy(tint); }
      });
      for (const ch of g.children) ch.visible = spec.cabin !== false && !!ch.userData.cabin;   // seats, dash, wheel show through the glass
      // A soft cabin light from the dash onto the front seats (the roof shades the cabin), so the people seated
      // behind the glass read in Clay and Color, even at night. Short range, no shadow: it stays inside the car.
      const seat = g.userData.seats?.[0]?.pos;
      if (seat) {
        const lamp = new THREE.SpotLight(0xfff1dc, 0.9, 2.0, THREE.MathUtils.degToRad(60), 0.7, 2);
        lamp.position.set(0, seat[1] + 0.45, seat[2] + 0.55);
        lamp.target.position.set(0, seat[1] + 0.3, seat[2] - 0.4);
        lamp.castShadow = false;
        lamp.userData.cabinLight = true;
        g.add(lamp, lamp.target);
      }
      holder.add(model);
      g.add(holder);
      g.userData.vehicleBody = holder;
      g.userData.wheelRig = wheels;
      this.setFrame(this.frame);
    }).catch((err) => console.warn("Soundstage: car model failed, keeping the built one", err));
  }

  // ---------- imported models (GLB / glTF) ----------
  _glbPlaceholder(a) {
    const g = new THREE.Group();
    g.userData.limbs = [];
    const box = this._mesh(new THREE.BoxGeometry(0.6, a.height_m || 1.7, 0.6));
    box.position.y = (a.height_m || 1.7) / 2;
    g.add(box);
    const format = a.format || formatOf(a.url);
    const fit = (obj, size) => {
      // Sit on the floor, centred; keep real size unless it's clearly in the wrong units (cm, mm).
      let k = 1;
      if (size.y > 60 || size.y < 0.05) k = (a.height_m || 1.7) / Math.max(1e-6, size.y);
      return k;
    };
    loadAsset(a.url, format).then(async (asset) => {
      if (this.actorMeshes.get(a.id) !== g) return; // set rebuilt meanwhile
      if (asset.splat) return this._attachSplat(a, g, fit);
      const model = SkeletonUtils.clone(asset.scene);
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); // generated meshes often lack normals
        }
        o.userData.actorId = a.id; // ID pass / picking; Clay view uses the clay override, Color keeps the real materials
      });
      if (a.set_xform) {
        // A location rebuilt from a photo (DA3): stage = flip * v * scale + offset, no centring or fitting.
        const { scale = 1, offset = [0, 0, 0] } = a.set_xform;
        const flip = a.set_xform.flip_xyz || a.set_xform.flip || [1, 1, 1];
        model.scale.set(flip[0] * scale, flip[1] * scale, flip[2] * scale);
        model.position.set(...offset);
        if (a.set_xform.quat) model.quaternion.set(...a.set_xform.quat); // Video → Stage: the first camera's tilt
        model.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        if (a.set_xform.cut) cutPerformer(model, a.set_xform.cut);
        g.clear();
        g.add(model);
        this.setFrame(this.frame);
        return;
      }
      const bb = new THREE.Box3().setFromObject(model);
      const size = bb.getSize(new THREE.Vector3());
      const k = fit(model, size);
      model.scale.multiplyScalar(k);
      bb.setFromObject(model);
      const c = bb.getCenter(new THREE.Vector3());
      model.position.x -= c.x;
      model.position.z -= c.z;
      model.position.y -= bb.min.y;
      if (!a.height_m_set) { a.height_m = +(size.y * k).toFixed(2); a.height_m_set = true; }
      g.clear();
      g.add(model);
      if (asset.animations?.length) {
        g.userData.mixer = new THREE.AnimationMixer(model);
        const clip = asset.animations.find((x) => x.name === a.clip) || asset.animations[0];
        g.userData.mixer.clipAction(clip).play();
        g.userData.clips = asset.animations.map((x) => x.name);
      }
      this.setFrame(this.frame);
    }).catch((err) => { console.warn("Soundstage: model load failed", a.url, err); this.onStatus?.(`Couldn't load ${a.name}: ${err.message}`); });
    return g;
  }

  /** A Gaussian splat (Spark) shown in Color view, plus a clay stand-in that drives clay, depth and ID passes. */
  async _attachSplat(a, g, fit) {
    const { SparkRenderer, SplatMesh } = await loadSpark();
    if (!this._spark) {
      this._spark = new SparkRenderer({ renderer: this.renderer });
      this.scene.add(this._spark);
    }
    const splat = new SplatMesh({ url: a.url });
    await splat.initialized;
    if (this.actorMeshes.get(a.id) !== g) { splat.dispose?.(); return; }
    // Most splat files are Y-down (COLMAP/3DGS convention); flip upright unless told otherwise.
    if (a.splat_up !== "y") splat.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
    splat.updateMatrixWorld(true);
    const local = splat.getBoundingBox?.() || new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    const bb = local.clone().applyMatrix4(splat.matrix);
    const size = bb.getSize(new THREE.Vector3());
    const k = fit(splat, size);
    const holder = new THREE.Group();
    holder.add(splat);
    holder.scale.setScalar(k);
    const c = bb.getCenter(new THREE.Vector3());
    holder.position.set(-c.x * k, -bb.min.y * k, -c.z * k);
    splat.userData.splatOnly = true;
    // Clay stand-in: the splat's own mesh (SplatToMesh GLB, same frame) when there is one, else an ellipsoid.
    let proxy;
    if (a.proxy_url) {
      try {
        const gl = await loadAsset(a.proxy_url, "glb");
        proxy = SkeletonUtils.clone(gl.scene);
        proxy.quaternion.copy(splat.quaternion);
        holder.add(proxy);
        proxy.traverse((o) => {
          o.userData.actorId = a.id;
          if (!o.isMesh) return;
          o.castShadow = true; o.receiveShadow = true;
          if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); // SplatToMesh GLBs ship without normals
        });
      } catch (err) { console.warn("Soundstage: splat proxy failed", err); proxy = null; }
    }
    if (!proxy) {
      proxy = this._mesh(new THREE.SphereGeometry(0.5, 24, 16));
      proxy.scale.copy(size).multiplyScalar(k);
      proxy.position.set(0, (size.y * k) / 2, 0);
      proxy.userData.actorId = a.id;
    }
    proxy.userData.proxyOnly = true;
    if (!a.height_m_set) { a.height_m = +(size.y * k).toFixed(2); a.height_m_set = true; }
    g.clear();
    g.add(holder);
    if (!proxy.parent) g.add(proxy);
    this._applySplatVisibility(this.view);
    this.setFrame(this.frame);
    this._kickSplats();
  }

  _hasSplats() {
    let any = false;
    this.root?.traverse((o) => { if (o.userData.splatOnly) any = true; });
    return any;
  }

  /** Spark sorts splats in a worker; give it a few renders (with yields) to catch up with the camera. */
  async _settleSplats(mode, n, waitMs = 0) {
    for (let i = 0; i < n; i++) {
      this._renderMode(mode, true);
      await (waitMs ? new Promise((r) => setTimeout(r, waitMs)) : yieldToBrowser());
    }
  }

  /** After a splat loads (or the view changes to Color), keep rendering briefly so it appears sorted. */
  _kickSplats() {
    if (this._kickT) return;
    let n = 0;
    const tick = () => {
      this.render();
      if (++n < 20) this._kickT = setTimeout(tick, 50);
      else this._kickT = null;
    };
    tick();
  }

  /** Splats render only in Color view; their clay stand-ins render everywhere else (clay, depth, ID, wire). */
  _applySplatVisibility(mode) {
    const color = mode === "color";
    // Spark draws from its last sorted state, so hiding a splat alone lags a frame: hide the renderer too.
    if (this._spark) this._spark.visible = color;
    this.root?.traverse((o) => {
      if (o.userData.splatOnly) o.visible = color;
      else if (o.userData.proxyOnly) o.visible = !color;
    });
  }

  // ---------- interiors (floor plan / dimensions) and measurement ----------
  /**
   * Build a true-scale interior from a plan spec (see interior.mjs). Fixtures become ordinary,
   * editable actors; the camera moves to eye height in the largest room unless camera:false.
   */
  setInterior(spec, { fixtures = true, camera = true } = {}) {
    if (!spec?.rooms?.length) { delete this.state.interior; this._buildSet(); this.setFrame(this.frame); this.onChange(this.toJSON()); return; }
    const s = normalizeSpec({ ...spec, north_up: true });
    this.state.interior = { units: "m", ceiling_m: s.ceiling_m, wall_thickness_m: s.wall_thickness_m, rooms: s.rooms,
      openings: s.openings, fixtures: s.fixtures, warnings: spec.warnings || [], north_up: true };
    this.state.environment = { ...(this.state.environment || {}), set: "empty" };
    if (fixtures) {
      this.state.actors = this.state.actors.filter((a) => !a.from_interior);
      for (const f of fixtureActors(this.state.interior)) {
        const kind = resolveKind(f.kind) || f.kind;
        if (!LIBRARY[kind]) continue;
        const spec = LIBRARY[kind];
        const id = `${kind}_${Math.random().toString(36).slice(2, 8)}`;
        this.state.actors.push({ id, name: f.name || spec.label || kind, kind, height_m: spec.height || 1, from_interior: true,
          position: f.position, keys: [{ frame: 0, position: [...f.position] }], rotation_deg: f.rotation_deg });
      }
    }
    // A warm ceiling practical in every room, so interiors aren't lit only through the windows.
    const L = this.state.lighting || (this.state.lighting = clone(DEFAULT_SCENE.lighting));
    L.lights = (L.lights || []).filter((l) => !l.from_interior);
    for (const r of this.state.interior.rooms) {
      const [cx, cz] = toStage(s, r.x + r.w / 2, r.z + r.d / 2);
      L.lights.push({ id: `light_room_${Math.random().toString(36).slice(2, 7)}`, type: "practical", name: `${r.name} ceiling light`,
        position: [+cx.toFixed(2), +(s.ceiling_m - 0.15).toFixed(2), +cz.toFixed(2)], target: [+cx.toFixed(2), 0, +cz.toFixed(2)],
        kelvin: 3300, intensity: 1.2 + Math.min(1.5, (r.w * r.d) / 20), softness: 1, angle: 170, from_interior: true });
    }
    this._buildLights?.();
    if (camera) {
      const cam = interiorCamera(this.state.interior);
      if (cam) this.activeShot().camera_keys = [{ frame: 0, ...cam }];
    }
    this._buildSet();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return this.state.interior;
  }

  /** Measure overlay: W×D×H of the selection, a 1.75 m ghost for scale, and the floor grid (viewport only). */
  setMeasure(on) { this.measure = !!on; this.render(); }
  /** Snap the gizmo: 0.1 m moves, 15° turns, 0.05 scale steps. */
  setSnap(on) {
    this.snap = !!on;
    this.tc.setTranslationSnap(on ? 0.1 : null);
    this.tc.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.tc.setScaleSnap(on ? 0.05 : null);
  }

  _measureOverlay(cam, show) {
    if (!this.gizmoScene || !this.canvas?.parentElement) return; // not built yet (first render happens in the constructor)
    if (!this._measureEl) {
      this._measureEl = Object.assign(document.createElement("div"), { className: "ss-measure" });
      this._measureEl.style.cssText = "position:absolute;pointer-events:none;transform:translate(-50%,-100%);padding:3px 8px;border-radius:999px;" +
        "background:rgba(33,25,39,.8);color:#f2ff59;font:600 11px/1.3 'Soundstage Grotesk',system-ui,sans-serif;white-space:nowrap;border:1px solid rgba(255,255,255,.12);display:none;z-index:3";
      this.canvas.parentElement?.appendChild(this._measureEl);
      this._ghost = new THREE.Group();
      const ghostMat = new THREE.MeshBasicMaterial({ color: 0xf2ff59, transparent: true, opacity: 0.22, depthWrite: false });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.75 - 0.4 - 0.24, 4, 12), ghostMat);
      body.position.y = (1.75 - 0.24) / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), ghostMat);
      head.position.y = 1.75 - 0.12;
      this._ghost.add(body, head);
      this.gizmoScene.add(this._ghost);
      this._grid = new THREE.GridHelper(40, 40, 0x6f6280, 0x3b3345);
      this._grid.material.transparent = true;
      this._grid.material.opacity = 0.55;
      this._grid.position.y = 0.003;
      this.scene.add(this._grid);
    }
    this._grid.visible = show;
    const g = show && this.selected ? this.actorMeshes.get(this.selected) : null;
    if (!g) { this._measureEl.style.display = "none"; this._ghost.visible = false; return; }
    const bb = new THREE.Box3().setFromObject(g);
    const size = bb.getSize(new THREE.Vector3());
    const top = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y, (bb.min.z + bb.max.z) / 2).project(cam);
    const r = this.canvas.getBoundingClientRect(), pr = this.canvas.parentElement.getBoundingClientRect();
    const f = (v) => (v >= 10 ? v.toFixed(1) : v.toFixed(2));
    this._measureEl.textContent = `W ${f(size.x)} · D ${f(size.z)} · H ${f(size.y)} m`;
    this._measureEl.style.left = `${r.left - pr.left + ((top.x + 1) / 2) * r.width}px`;
    this._measureEl.style.top = `${r.top - pr.top + ((1 - top.y) / 2) * r.height - 6}px`;
    this._measureEl.style.display = top.z < 1 ? "block" : "none";
    this._ghost.visible = true;
    this._ghost.position.set(bb.max.x + 0.45, 0, (bb.min.z + bb.max.z) / 2);
  }

  // ---------- 2.5D cards and the backdrop plate ----------
  _cardPlaceholder(a) {
    const g = new THREE.Group();
    g.userData.limbs = [];
    const h = a.height_m || 1.7;
    const tmp = this._mesh(new THREE.BoxGeometry(h * 0.5, h, 0.02));
    tmp.position.y = h / 2;
    g.add(tmp);
    buildCard(a.url, h).then(({ mesh }) => {
      if (this.actorMeshes.get(a.id) !== g) return;
      mesh.userData.actorId = a.id;
      g.clear();
      g.add(mesh);
      this.setFrame(this.frame);
    }).catch((err) => { console.warn("Soundstage: card load failed", a.url, err); this.onStatus?.(`Couldn't load ${a.name}: ${err.message}`); });
    return g;
  }

  /** Stand an image up in the set as a card (cut-out PNG = silhouette card; opaque image = flat), facing the camera. */
  addCard(name, url, heightM = 1.7) {
    const id = `card_${Date.now().toString(36)}`;
    const cam = this._cameraAt(this.frame);
    const pos = new THREE.Vector3(...cam.position);
    const dir = new THREE.Vector3(...cam.target).sub(pos).setY(0).normalize();
    const spot = pos.clone().add(dir.multiplyScalar(6));
    const p = [+spot.x.toFixed(2), 0, +spot.z.toFixed(2)];
    const face = THREE.MathUtils.radToDeg(Math.atan2(cam.position[0] - p[0], cam.position[2] - p[2]));
    this.state.actors.push({ id, name, kind: "card", url, position: p, keys: [{ frame: 0, position: [...p] }],
      height_m: heightM, rotation_deg: Math.round(face) });
    this._buildSet();
    this.select(id);
    this.onChange(this.toJSON());
    return name;
  }

  /** A photo behind everything (Color view, and the viewport while blocking). Never in the clay/depth/ID passes. */
  setBackdrop(url) {
    if (url) this.state.backdrop = { url }; else delete this.state.backdrop;
    this._backdropTex = null;
    if (url) {
      loadBackdrop(url).then((tex) => {
        if (this.state.backdrop?.url !== url) return;
        this._backdropTex = tex;
        this.render();
      }).catch((err) => this.onStatus?.(`Couldn't load the backdrop: ${err.message}`));
    }
    this.render();
    this.onChange(this.toJSON());
  }

  /** Add an uploaded model or splat by URL (served by ComfyUI /view). format: glb, fbx, obj, ply, stl, spz, splat… */
  addModel(name, url, format = formatOf(name), extra = {}) {
    const id = `glb_${Date.now().toString(36)}`;
    const cam = this._cameraAt(this.frame);
    const pos = new THREE.Vector3(...cam.position);
    const dir = new THREE.Vector3(...cam.target).sub(pos).setY(0).normalize();
    const spot = pos.add(dir.multiplyScalar(7));
    const p = [+spot.x.toFixed(2), 0, +spot.z.toFixed(2)];
    if (extra.set_xform) p.splice(0, 3, 0, 0, 0); // a photo-built set sits where its camera says
    this.state.actors.push({ id, name, kind: "glb", format, url, position: p, keys: [{ frame: 0, position: [...p] }], height_m: 1.7,
      rotation_deg: 0, ...extra });
    this._buildSet();
    this.select(id);
    this.onChange(this.toJSON());
    return name;
  }

  /** The whole set (objects, set, lights) as a binary glTF Blob. */
  async exportGLB() {
    const keep = this.selRing?.visible;
    if (this.selRing) this.selRing.visible = false;
    const blob = await new Promise((resolve, reject) => new GLTFExporter().parse(this.root,
      (glb) => resolve(new Blob([glb], { type: "model/gltf-binary" })), reject, { binary: true, onlyVisible: true }));
    if (this.selRing) this.selRing.visible = keep;
    return blob;
  }

  // ---------- undo / redo ----------
  /** Record the current state (called after every edit; consecutive edits within 400 ms merge). */
  _record() {
    const snap = JSON.stringify(this.state);
    this._hist = this._hist || [];
    this._redo = [];
    if (this._hist[this._hist.length - 1] === snap) return;
    // Merge only a continuous gesture (a drag or slider move): same kind of edit, < 300 ms apart.
    const now = performance.now();
    const gesture = this._dragging || window.__ssSliding;
    if (gesture && this._hist.length > 1 && now - (this._lastRec || 0) < 300) this._hist[this._hist.length - 1] = snap;
    else this._hist.push(snap);
    this._lastRec = now;
    if (this._hist.length > 120) this._hist.shift();
  }

  _restore(snap) {
    this._lastRec = 0;
    this.state = JSON.parse(snap);
    this.camera.aspect = this.fw / this.fh;
    this._buildSet();
    this._applySun();
    this.setFrame(this.frame);
    this._muteRecord = true;
    this.onChange(this.toJSON());
    this._muteRecord = false;
    this.onShots?.();
    this.onSelect?.(this.selectedInfo());
  }

  /** True when the active shot's camera rides in or on a vehicle (in-car, hood, bumper): long lenses make no sense there. */
  cameraInsideVehicle(frame = this.frame) {
    const host = this._followActor?.();
    if (!host || LIBRARY[host.kind]?.rig !== "vehicle") return false;
    const g = this.actorMeshes.get(host.id);
    if (!g) return false;
    const cam = this._cameraAt(frame);
    // Inside, or mounted on it (hood / bumper cams sit just outside the body): both are tight, wide-lens spaces.
    return new THREE.Box3().setFromObject(g).expandByScalar(0.6).containsPoint(new THREE.Vector3(...cam.position));
  }

  /** A style's suggested lens for the current shot; in or on a vehicle the shot keeps its own (cabin) lens. */
  styleFocal(mm) {
    return this.cameraInsideVehicle() ? this._cameraAt(this.frame).focal_mm : mm;
  }

  /** Start the undo history at the current scene (a freshly opened workflow or preset: Undo never goes past it). */
  resetHistory() {
    this._hist = [JSON.stringify(this.state)];
    this._redo = [];
    this._lastRec = 0;
  }

  undo() {
    this.live?.finish();
    if (!this._hist || this._hist.length < 2) return false;
    this._redo.push(this._hist.pop());
    this._restore(this._hist[this._hist.length - 1]);
    return true;
  }

  redo() {
    this.live?.finish();
    if (!this._redo?.length) return false;
    const snap = this._redo.pop();
    this._hist.push(snap);
    this._restore(snap);
    return true;
  }

  duplicateSelected() {
    const a = this.state.actors.find((x) => x.id === this.selected);
    if (!a) return null;
    const c = clone(a);
    c.id = `${a.kind || "obj"}_${Date.now().toString(36)}`;
    c.name = `${a.name} copy`;
    const off = Math.max(1, (a.height_m || 1) * 0.8);
    c.keys = this._actorKeys(c).map((k) => ({ ...k, position: [k.position[0] + off, k.position[1], k.position[2]] }));
    c.position = c.keys[0].position;
    this.state.actors.push(c);
    this._buildSet();
    this.select(c.id);
    this.onChange(this.toJSON());
    return c.name;
  }

  scaleSelected(factor) {
    const a = this.state.actors.find((x) => x.id === this.selected);
    if (!a) return;
    a.scale = Math.max(0.05, Math.min(20, factor));
    this.actorMeshes.get(a.id)?.scale.setScalar(a.scale);
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Everything on the stage, for the outliner. */
  outline() {
    return [
      ...this.state.actors.map((a) => ({ id: a.id, type: "object", name: a.name, kind: a.kind })),
      ...(this.state.lighting?.lights || []).map((l) => ({ id: l.id, type: "light", name: l.name, kind: l.type })),
    ];
  }

  /** Change set / weather / density / water level, e.g. setEnvironment({ set: "water_tank" }). */
  setEnvironment(patch) {
    this.state.environment = { ...(this.state.environment || {}), ...patch };
    this._buildSet();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Add an LLM-designed stand-in (recipe from /soundstage/object). */
  addCustom(name, recipe) {
    const n = this.state.actors.filter((a) => a.name?.startsWith(name)).length + 1;
    const id = `custom_${Date.now().toString(36)}`;
    const cam = this._cameraAt(this.frame);
    const pos = new THREE.Vector3(...cam.position);
    const dir = new THREE.Vector3(...cam.target).sub(pos).setY(0).normalize();
    const k = this.state.actors.length;
    const footprint = Math.max(recipe.size_m?.[0] || 1, recipe.size_m?.[2] || 1);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(((k % 5) - 2) * Math.max(2.4, footprint));
    const spot = pos.add(dir.multiplyScalar(Math.max(7, footprint * 2.5))).add(side);
    const p = [+spot.x.toFixed(2), 0, +spot.z.toFixed(2)];
    const label = n > 1 ? `${name} ${n}` : name;
    this.state.actors.push({ id, name: label, kind: "custom", recipe, position: p, keys: [{ frame: 0, position: [...p] }],
      height_m: recipe.size_m?.[1] || 1, rotation_deg: 0 });
    this._buildSet();
    this.select(id);
    this.onChange(this.toJSON());
    return label;
  }

  /** Put the selected character (or `riderId`) on another object: horse, bike, car, bench… */
  mount(riderId, hostId, pose = null, atFrame = 0, seat = null) {
    const r = this.state.actors.find((x) => x.id === riderId), h = this.state.actors.find((x) => x.id === hostId);
    if (!r || !h || r.id === h.id) return false;
    r.mount_id = h.id;
    if (seat != null && SEATS[h.kind]) r.seat = seat; else delete r.seat;
    r.pose = pose || MOUNTS[h.kind]?.pose || "sit";
    if (atFrame > 0) r.mount_at = Math.round(atFrame); else delete r.mount_at; // timed: on foot until then, then hops on
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return true;
  }

  unmount(riderId) {
    const r = this.state.actors.find((x) => x.id === riderId);
    if (!r?.mount_id) return;
    const g = this.actorMeshes.get(r.id);
    const p = [+g.position.x.toFixed(2), 0, +(g.position.z + 1.2).toFixed(2)];
    delete r.mount_id; delete r.pose; delete r.mount_at;
    r.keys = [{ frame: 0, position: p }];
    applyPose(g, "stand");
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Change how a character or object looks (wardrobe, hair, colours…). */
  setAppearance(patch) {
    const a = this.state.actors.find((x) => x.id === this.selected);
    if (!a) return;
    a.appearance = { ...(a.appearance || {}), ...patch };
    this._buildSet();
    this.select(a.id);
    this.onChange(this.toJSON());
  }

  select(id) {
    const prev = this.selected;
    this.selected = id && this.actorMeshes.has(id) ? id : null;
    if (this.poser?.active && prev !== this.selected) {
      this.poser.joint = null;
      const a = this.state.actors.find((x) => x.id === this.selected);
      if (!a || !PERSON_KINDS.has(a.kind)) this.poser.setActive(false);
    }
    this._attachGizmo();
    this.setFrame(this.frame);
    this.onSelect?.(this.selectedInfo());
  }

  /** "translate" | "rotate" | "scale" */
  setGizmoMode(mode) {
    this.gizmoMode = mode;
    this.tc.setMode(mode);
    this.tc.showX = mode !== "rotate";
    this.tc.showY = mode !== "translate";
    this.tc.showZ = mode !== "rotate";
    this.render?.();
    this.onGizmoMode?.(mode);
  }

  _attachGizmo() {
    const pj = this.poser?.target();
    if (pj) {   // pose mode: the ring sits on the picked joint, turning in its own axes
      this.tc.attach(pj); this._gizmoOn = true;
      this.tc.setMode("rotate"); this.tc.setSpace("local"); this.tc.showX = this.tc.showY = this.tc.showZ = true;
      this.tcHelper.visible = true;
      return;
    }
    if (this.tc.space === "local") { this.tc.setSpace("world"); this.setGizmoMode(this.gizmoMode || "translate"); }
    const a = this.state.actors.find((x) => x.id === this.selected);
    const g = a && this.actorMeshes.get(a.id);
    if (g && !a.mount_id && !a.set_xform) { this.tc.attach(g); this._gizmoOn = true; }
    else { this.tc.detach(); this._gizmoOn = false; }
  }

  _gizmoToActor() {
    if (this.poser?.target() && this.tc.object === this.poser.target()) { this.poser.fromGizmo(); return; }
    const a = this.state.actors.find((x) => x.id === this.selected);
    const g = this.tc.object;
    if (!a || !g) return;
    if (this.gizmoMode === "translate") {
      const k = this._editActorKey(a);
      k.position = [+g.position.x.toFixed(2), a.physics?.baked || a.key_y ? (k.position?.[1] ?? 0) : 0, +g.position.z.toFixed(2)];
    } else if (this.gizmoMode === "rotate") {
      a.rotation_deg = Math.round(THREE.MathUtils.radToDeg(g.rotation.y));
    } else {
      // Uniform: follow whichever handle moved most.
      const s0 = this._gizmoScale0 || 1;
      const s = [g.scale.x, g.scale.y, g.scale.z].reduce((m, v) => (Math.abs(v - s0) > Math.abs(m - s0) ? v : m), s0);
      a.scale = +Math.max(0.05, Math.min(20, s)).toFixed(3);
      g.scale.setScalar(a.scale);
    }
    this.setFrame(this.frame);
    this.onSelect?.(this.selectedInfo());
  }

  selectedInfo() {
    const a = this.state.actors.find((x) => x.id === this.selected);
    return a ? { id: a.id, name: a.name, kind: a.kind, rotation_deg: a.rotation_deg || 0, height_m: a.height_m, scale: a.scale || 1,
      appearance: a.appearance || null, mount_id: a.mount_id || null, pose: a.pose || null, seat: a.seat ?? null,
      beam: a.beam || "steady" } : null;
  }

  /**
   * Secondary motion for people (the rig's spine, neck, head and elbows), so the clay reads like a person and the
   * video copies a believable body: walk = chest counter-twist, soft swinging elbows, head bob; run (> ~3 m/s) =
   * forward lean, elbows ~85° pumping, high knees and heel kick; idle = breathing, weight shift, small head moves.
   * Pose Studio keys run after this and override any joint they name.
   */
  _bodyMotion(g, a, moving, speed, cycle) {
    const J = g.userData.joints, D = Math.PI / 180;
    const fps = this.state.shot?.fps || 24, t = this.frame / fps;
    const seed = [...String(a.id)].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 97;   // people don't breathe in sync
    const set = (j, x, y, z) => { if (j) { j.rotation.order = "XYZ"; j.rotation.set(x * D, y * D, z * D); } };
    const limbs = g.userData.limbs || [];
    const run = moving && speed > 3;
    if (moving) {
      const sw = Math.sin(cycle);
      if (run) {
        const k = Math.min(1, (speed - 3) / 3);
        for (const l of limbs) {
          const ph = Math.sin(cycle + l.phase);
          if (l.part === "shoulder") l.pivot.rotation.x = 0.75 * ph;
          if (l.part === "elbow") l.pivot.rotation.x = -(1.35 + 0.15 * ph);
          if (l.part === "hip") l.pivot.rotation.x = (0.55 + 0.25 * k) * ph - 0.15;
          if (l.part === "knee") l.pivot.rotation.x = 0.25 + (1.1 + 0.4 * k) * Math.max(0, Math.sin(cycle + l.phase));
        }
        set(J.spine, 10 + 8 * k, -8 * sw, 0);
        set(J.neck, -6 - 4 * k, 4 * sw, 0);
        set(J.head, -4, 0, 0);
      } else {
        for (const l of limbs) {
          const ph = Math.sin(cycle + l.phase);
          if (l.part === "elbow") l.pivot.rotation.x = -(0.25 + 0.2 * Math.max(0, ph));
          if (l.part === "knee") l.pivot.rotation.x = 0.08 + 0.6 * Math.max(0, Math.sin(cycle + l.phase));   // knees bend backward only
        }
        set(J.spine, 3, -5 * sw, 1.5 * Math.cos(cycle * 2));
        set(J.neck, 0, 3 * sw, 0);
        set(J.head, 1.5 * Math.sin(cycle * 2), 0, 0);
      }
    } else if (!limbs.some((l) => Math.abs(l.pivot.rotation.x) > 0.3)) {
      // Standing (not seated or posed by a mount): breathe, shift weight, look around a little.
      const br = Math.sin((t + seed * 0.13) * 2 * Math.PI / 3.6), sh = Math.sin((t + seed) * 2 * Math.PI / 7.5);
      set(J.spine, 1.2 * br, 1.5 * sh, 1.2 * sh);
      set(J.neck, 0.5 * br, 2 * Math.sin((t + seed * 0.7) * 2 * Math.PI / 5.3), 0);
      set(J.head, 0, 3 * Math.sin((t + seed * 0.3) * 2 * Math.PI / 6.1), 0);
      for (const l of limbs) if (l.part === "elbow") l.pivot.rotation.x = -(0.14 + 0.03 * br);
    }
  }

  // ------------------------------------------------------------------ physics: water, fire
  /** Is a world (x, z) over the water surface? */
  _overWater(x, z) {
    const w = this.water;
    if (!w) return false;
    const geo = w.geometry.parameters, cx = w.position.x, cz = w.position.z;
    return Math.abs(x - cx) < geo.width / 2 && Math.abs(z - cz) < geo.height / 2;
  }

  /**
   * Buoyancy, deterministic per frame. Something over the water that starts above the surface falls in (gravity),
   * splashes, then either floats (dips with the impact, bobs and settles at its own waterline) or sinks (slows to a
   * terminal speed and settles on the bottom). Something placed in the water starts already floating / on the bottom.
   * People and animals tread water with their head above the surface.
   */
  _waterPhysics(a, g) {
    if (a.mount_id || a.carry_id || LIBRARY[a.kind]?.flies) return;
    const level = this.water.position.y;
    if (level < 0.3) return;                                    // the beach's sea is a surface, not a pool
    const p = this._actorPosAt(a, this.frame);
    if (!this._overWater(p[0], p[2])) { g.userData.inWater = false; return; }
    const fps = this.state.shot?.fps || 24, G = 9.8;
    const box = new THREE.Box3().setFromObject(g), h = Math.max(0.05, box.max.y - box.min.y);
    const kind = a.kind;
    if (LIBRARY[kind]?.boat) {
      // A boat sits at its waterline and rides the swell: heave, pitch and roll, the bow lifting with speed.
      const t = this.frame / fps, seed2 = [...String(a.id)].reduce((n, ch) => n + ch.charCodeAt(0), 0);
      const draft = kind === "jetski" ? 0.3 : kind === "boat" ? 0.45 : 0.6;
      const sp = g.userData.speed || 0, plane = Math.min(1, sp / 8);
      g.position.y = level - draft + 0.06 * Math.sin(2 * Math.PI * t / 3.1 + seed2) + 0.12 * plane;
      g.rotation.order = "YXZ";
      g.rotation.x = -0.035 * Math.sin(2 * Math.PI * t / 2.7 + seed2) - 0.09 * plane * (kind === "sailboat" || kind === "catamaran" ? 0.3 : 1);
      g.rotation.z = (kind === "sailboat" ? 0.12 : 0.04) * Math.sin(2 * Math.PI * t / 4.3 + seed2 * 0.7) + (kind === "sailboat" ? 0.1 : 0);
      g.userData.inWater = true;
      return;
    }
    const swimmer = PERSON_KINDS.has(kind) || ["dog", "horse", "cat", "bird"].includes(kind);
    const SINK = ["rock", "car", "police_car", "sports_car", "hatchback", "truck", "motorcycle", "bicycle", "flashlight", "lamp", "wall", "pyramid", "cube", "fire"];
    const sinks = !swimmer && (SINK.includes(kind) || a.buoyancy === "sink");
    // Fraction of its height that sits under water when floating (wood ~0.5, a ball ~0.2, a bird ~0.3).
    const sub = { crate: 0.55, sphere: 0.25, bird: 0.3, tree: 0.35, bush: 0.4, chair: 0.6, table: 0.6, bench: 0.6, cylinder: 0.5 }[kind] ?? 0.55;
    const seed = [...String(a.id)].reduce((n, ch) => n + ch.charCodeAt(0), 0);
    // When does it enter, and from how high? (first frame over the water; keyed height = drop height)
    const keys = this._actorKeys(a);
    let f0 = 0;
    for (let f = 0; f <= this.frame; f++) { const q = this._actorPosAt(a, f); if (this._overWater(q[0], q[2])) { f0 = f; break; } }
    const y0 = Math.max(0, this._actorPosAt(a, f0)[1] || 0);
    const t = (this.frame - f0) / fps;
    const yEq = swimmer ? level - (PERSON_KINDS.has(kind) ? 0.84 : 0.7) * h : sinks ? 0 : level - sub * h;
    let y;
    const dropping = y0 > level + 0.05;
    const tHit = dropping ? Math.sqrt(2 * (y0 - level) / G) : 0;
    if (dropping && t < tHit) {
      y = y0 - 0.5 * G * t * t;                                  // falling toward the surface
    } else {
      const ti = t - tHit;                                      // time since it hit (or was placed in) the water
      const vImp = dropping ? G * tHit : 0;
      if (sinks) {
        const vt = { rock: 1.4, flashlight: 0.9 }[kind] ?? 0.55;  // terminal speed in water (m/s)
        const tau = 0.35;
        const start = dropping ? level : Math.min(level, y0 || level);
        const dist = vt * ti + (vImp - vt) * tau * (1 - Math.exp(-ti / tau));
        y = Math.max(0, (dropping || y0 > 0 ? start : 0) - dist - (dropping ? 0 : 0));
        if (!dropping && !(y0 > 0)) y = 0;                        // placed in the tank: already on the bottom
      } else {
        const w0 = 2 * Math.PI / 1.6, z = 0.28;                   // ~1.6 s bob, under-damped
        const dip = dropping ? Math.min(0.9 * h + 0.4, vImp / w0) : 0;
        const bob = 0.025 * Math.sin(2 * Math.PI * (this.frame / fps) / 2.4 + seed);
        y = yEq - dip * Math.exp(-z * w0 * ti) * Math.sin(w0 * Math.sqrt(1 - z * z) * ti) + bob;
        const wob = Math.exp(-0.6 * ti) * 0.15 + 0.03;          // a settling rock-and-roll, then a gentle sway
        if (!swimmer) { g.rotation.x = wob * Math.sin(2.1 * ti + seed); g.rotation.z = wob * Math.cos(1.7 * ti + seed * 0.3); }
      }
    }
    g.position.y = y - (box.min.y - g.position.y);                // put the object's bottom at y
    g.userData.inWater = true;
    // Splash ring on entry: expands and fades over ~1.2 s.
    const ring = this._splash?.get(a.id);
    if (ring) {
      const tr = (this.frame - f0) / fps - tHit;
      ring.visible = dropping && tr >= 0 && tr < 1.2;
      if (ring.visible) {
        ring.position.set(p[0], level + 0.01, p[2]);
        const r = 0.3 + 1.6 * tr;
        ring.scale.set(r, r, 1);
        ring.material.opacity = 0.75 * (1 - tr / 1.2);
      }
    } else if (dropping) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.userData.splash = true;
      this.root.add(m);
      (this._splash = this._splash || new Map()).set(a.id, m);
      m.visible = false;
    }
  }

  /** Flames flicker, the fire light breathes, embers rise, drift and fade: all a pure function of the frame. */
  _animateFire(g, a) {
    const f = this.frame, fps = this.state.shot?.fps || 24, t = f / fps;
    const seed = [...String(a.id)].reduce((n, ch) => n + ch.charCodeAt(0), 0);
    const n1 = (x) => Math.sin(x * 12.9898 + seed) * 0.5 + Math.sin(x * 4.1 + seed * 0.7) * 0.3 + Math.sin(x * 23.3) * 0.2;
    g.userData.flames.forEach((fl, i) => {
      const k = 1 + 0.22 * n1(t * 3 + i * 1.7);
      fl.scale.set(1 + 0.08 * n1(t * 5 + i), k, 1 + 0.08 * n1(t * 4.3 + i * 2.1));
      fl.rotation.z = 0.08 * n1(t * 2.2 + i * 3.1);
    });
    if (g.userData.fireLight) g.userData.fireLight.intensity = g.userData.fireBase * (0.82 + 0.18 * n1(t * 7));
    const em = g.userData.embers;
    if (em) {
      const pos = em.geometry.attributes.position, N = pos.count, H = g.userData.fireH || 1;
      for (let i = 0; i < N; i++) {
        const life = 1.6 + (i % 7) * 0.25, age = ((t + i * 0.37) % life) / life;   // 0..1, staggered
        const ang = i * 2.399, r = 0.15 * H + 0.25 * H * age;
        pos.setXYZ(i, Math.cos(ang + age * 3) * r * 0.6 + 0.12 * Math.sin(t * 2 + i), 0.3 * H + age * 2.6 * H, Math.sin(ang + age * 3) * r * 0.6);
      }
      pos.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ Pose Studio
  /** The actor's pose at a frame: each joint eased between its neighbouring keys (held before the first / after the last). */
  poseAt(a, frame) {
    const keys = (a?.pose_keys || []).slice().sort((x, y) => x.frame - y.frame);
    if (!keys.length) return null;
    if (frame <= keys[0].frame) return keys[0].joints || {};
    const last = keys[keys.length - 1];
    if (frame >= last.frame) return last.joints || {};
    const i = keys.findIndex((k) => k.frame > frame);
    const k0 = keys[i - 1], k1 = keys[i];
    let t = (frame - k0.frame) / Math.max(1, k1.frame - k0.frame);
    t = t * t * (3 - 2 * t);
    const out = {}, ids = new Set([...Object.keys(k0.joints || {}), ...Object.keys(k1.joints || {})]);
    for (const id of ids) {
      const v0 = k0.joints?.[id] || [0, 0, 0], v1 = k1.joints?.[id] || [0, 0, 0];
      out[id] = [0, 1, 2].map((n) => (v0[n] || 0) + ((v1[n] || 0) - (v0[n] || 0)) * t);
    }
    return out;
  }

  /** The pose key at the playhead, created from the current pose when there is none. */
  _poseKeyHere(a) {
    a.pose_keys = a.pose_keys || [];
    let k = a.pose_keys.find((x) => x.frame === this.frame);
    if (!k) {
      k = { frame: this.frame, joints: JSON.parse(JSON.stringify(this.poseAt(a, this.frame) || {})) };
      a.pose_keys.push(k);
      a.pose_keys.sort((x, y) => x.frame - y.frame);
    }
    return k;
  }

  /** Set one joint (degrees, plain-word axes) at the playhead; with one key the pose holds for the whole shot. */
  setJoint(id, joint, value) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a) return;
    this._poseKeyHere(a).joints[joint] = value.map((v) => Math.round(v * 10) / 10);
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Apply a gallery pose (merged over the current one) at the playhead. */
  applyPosePreset(id, name) {
    const a = this.state.actors.find((x) => x.id === id), p = POSE_PRESETS[name];
    if (!a || !p) return;
    Object.assign(this._poseKeyHere(a).joints, JSON.parse(JSON.stringify(p)));
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  mirrorPoseAt(id) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a) return;
    const k = this._poseKeyHere(a);
    k.joints = mirrorPose(k.joints);
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Remove the key at the playhead (all keys = back to the plain walk / seat pose). */
  clearPose(id, all = false) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a?.pose_keys) return;
    a.pose_keys = all ? [] : a.pose_keys.filter((k) => k.frame !== this.frame);
    if (!a.pose_keys.length) delete a.pose_keys;
    this._buildSet();
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  /** Person-to-person / person-to-animal / look-at interactions, built from positions + Pose Studio keys. */
  interact(id, targetId, action) {
    const a = this.state.actors.find((x) => x.id === id), b = this.state.actors.find((x) => x.id === targetId);
    if (!a || !b || a === b) return null;
    const name = (x) => x.name || LIBRARY[x.kind]?.label || x.kind;
    const fps = this.state.shot?.fps || 24, when = this.frame > 0 ? ` from ${(this.frame / fps).toFixed(1)} s` : "";
    if (action === "look_at") {
      a.look_at = b.id; a.look_at_frame = this.frame; delete a.look_until;
      this.setFrame(this.frame); this.onChange(this.toJSON());
      return `${name(a)} looks at ${name(b)}${when}.`;
    }
    if (action === "stop_look") {
      // From the playhead on they look away again (eased); before it, the look stays.
      if (a.look_at && this.frame > (a.look_at_frame || 0)) a.look_until = this.frame;
      else { delete a.look_at; delete a.look_at_frame; delete a.look_until; this._buildSet(); }
      this.setFrame(this.frame); this.onChange(this.toJSON());
      return `${name(a)} looks away at ${(this.frame / fps).toFixed(1)} s.`;
    }
    const pa = this._actorPosAt(a, this.frame), pb = this._actorPosAt(b, this.frame);
    const dir = new THREE.Vector2(pb[0] - pa[0], pb[2] - pa[2]);
    if (dir.length() < 1e-3) dir.set(0, 1);
    dir.normalize();
    // Place A at a set distance from B, facing B (and B facing A for two people), at the playhead.
    const face = (who, toX, toZ) => { const p = this._actorPosAt(who, this.frame); who.rotation_deg = Math.round(Math.atan2(toX - p[0], toZ - p[2]) * 180 / Math.PI); };
    // Distances are surface to surface: a non-person target adds its own half-length along the approach.
    const reach = (() => {
      if (PERSON_KINDS.has(b.kind)) return 0;
      const g = this.actorMeshes.get(b.id);
      if (!g) return 0.5;
      const sz = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
      return Math.abs(dir.x) * sz.x / 2 + Math.abs(dir.y) * sz.z / 2;
    })();
    const place = (dist) => {
      dist += reach;
      const k = this._editActorKey(a);
      k.position = [+(pb[0] - dir.x * dist).toFixed(2), k.position[1], +(pb[2] - dir.y * dist).toFixed(2)];
      face(a, pb[0], pb[2]);
      if (PERSON_KINDS.has(b.kind)) face(b, k.position[0], k.position[2]);
    };
    const poseBoth = (pa2, pb2) => {
      Object.assign(this._poseKeyHere(a).joints, pa2);
      if (pb2 && PERSON_KINDS.has(b.kind)) Object.assign(this._poseKeyHere(b).joints, pb2);
    };
    const grip = (lr) => Object.fromEntries(["index", "middle", "ring", "pinky"].flatMap((f) => [1, 2, 3].map((i) => [`${lr}_${f}_${i}`, [45, 0]])));
    let msg = null;
    switch (action) {
      case "talk":
        place(1.0); poseBoth({ r_shoulder: [25, 10, 0], r_elbow: [60, 0] }, { l_shoulder: [10, 8, 0], l_elbow: [30, 0] });
        a.look_at = b.id; a.look_at_frame = this.frame; if (PERSON_KINDS.has(b.kind)) { b.look_at = a.id; b.look_at_frame = this.frame; }
        msg = `${name(a)} and ${name(b)} talk face to face${when}.`; break;
      case "handshake":
        place(0.8); poseBoth({ r_shoulder: [45, 8, 0], r_elbow: [40, 0], ...grip("r") }, { r_shoulder: [45, 8, 0], r_elbow: [40, 0], ...grip("r") });
        msg = `${name(a)} shakes hands with ${name(b)}${when}.`; break;
      case "hug":
        // Arms raised forward and turned in (negative twist) so the forearms wrap around the other person's back.
        place(0.3); poseBoth({ l_shoulder: [70, 22, -70], r_shoulder: [70, 22, -70], l_elbow: [70, 0], r_elbow: [70, 0], head: [0, 30, 0] },
          { l_shoulder: [62, 26, -65], r_shoulder: [62, 26, -65], l_elbow: [75, 0], r_elbow: [75, 0], head: [0, -30, 0] });
        msg = `${name(a)} hugs ${name(b)}${when}.`; break;
      case "hold_hands": {
        const k = this._editActorKey(a), side = new THREE.Vector2(-dir.y, dir.x);
        k.position = [+(pb[0] - side.x * 0.55).toFixed(2), k.position[1], +(pb[2] - side.y * 0.55).toFixed(2)];
        a.rotation_deg = b.rotation_deg || 0;
        poseBoth({ l_shoulder: [10, 22, 0], l_elbow: [15, 0], ...grip("l") }, { r_shoulder: [10, 22, 0], r_elbow: [15, 0], ...grip("r") });
        msg = `${name(a)} holds hands with ${name(b)}${when}.`; break;
      }
      case "point_at":
        face(a, pb[0], pb[2]);
        Object.assign(this._poseKeyHere(a).joints, POSE_PRESETS.Point);
        a.look_at = b.id; a.look_at_frame = this.frame;
        msg = `${name(a)} points at ${name(b)}${when}.`; break;
      case "pet":
        place(0.55); Object.assign(this._poseKeyHere(a).joints, { spine: [40, 0, 0], r_shoulder: [60, 5, 0], r_elbow: [20, 0], l_hip: [20, 0, 0], r_hip: [20, 0, 0], l_knee: [35], r_knee: [35] });
        a.look_at = b.id; a.look_at_frame = this.frame;
        msg = `${name(a)} pets ${name(b)}${when}.`; break;
      case "lead": {
        const k = this._editActorKey(a), side = new THREE.Vector2(-dir.y, dir.x);
        k.position = [+(pb[0] + side.x * 0.7 + dir.x * 0.6).toFixed(2), k.position[1], +(pb[2] + side.y * 0.7 + dir.y * 0.6).toFixed(2)];
        a.rotation_deg = b.rotation_deg || 0;
        Object.assign(this._poseKeyHere(a).joints, { r_shoulder: [35, 25, 0], r_elbow: [25, 0], ...grip("r") });
        msg = `${name(a)} leads ${name(b)} by the reins${when}: walk them together with the same path.`; break;
      }
      default: return null;
    }
    this._yCache?.delete(a);
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return msg;
  }

  // ------------------------------------------------------------------ motion capture
  /** Fetch a take the scene names but this page has not loaded yet; redraw when it arrives. */
  _loadMocap(a) {
    const file = a.mocap?.file;
    if (!file || a.mocap.data) return;
    this._mocapLoading = this._mocapLoading || new Set();
    if (this._mocapLoading.has(file)) return;
    this._mocapLoading.add(file);
    Mocap.load(file, { fetchApi: this.fetchApi || ((u) => fetch(u)) })
      .then(() => { this.setFrame(this.frame); this.onMocap?.(a.id); })
      .catch((e) => { this.onInteract?.(`Couldn't load the motion take ${file}: ${e.message}`); })
      .finally(() => this._mocapLoading.delete(file));
  }

  /**
   * Put a captured take on a person. take: {file, data?} (data = the take JSON, cached so playback is instant).
   * It starts at the playhead unless opts.start is given; it plays from where they stand, turned to their facing.
   */
  setMocap(id, take, opts = {}) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a || !PERSON_KINDS.has(a.kind)) return "Pick a person first.";
    if (take.data && take.file) Mocap.remember(take.file, take.data);
    a.mocap = { file: take.file, start: opts.start ?? this.frame, travel: opts.travel ?? true, speed: opts.speed || 1,
      loop: !!opts.loop, ...(take.file ? {} : { data: take.data }), name: take.name || take.file?.split("/").pop()?.replace(/_\d{8}_\d{6}\.json$/, "") };
    const t = Mocap.takeFor(a.mocap);
    // A take longer than the shot: stretch the shot so the whole performance fits (up to 20 s). A take named by file
    // that is not loaded yet is stretched for when it arrives (otherwise setFrame clamps it at the old shot end).
    const fit = (tk) => {
      if (a.mocap?.file !== take.file && take.file) return;
      const fps = this.state.shot?.fps || 24;
      const need = Math.ceil((a.mocap?.start || 0) + (tk.n - 1) * fps / tk.fps / (a.mocap?.speed || 1)) + 1;
      if (need > (this.state.shot?.frames || 97) && need <= fps * 20) { this.state.shot.frames = need; return true; }
    };
    if (t) fit(t);
    else if (take.file) {
      Mocap.load(take.file, { fetchApi: this.fetchApi || ((u) => fetch(u)) })
        .then((tk) => { if (fit(tk)) { this.setFrame(this.frame); this.onChange(this.toJSON()); } })
        .catch(() => { /* reported by _loadMocap */ });
    }
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return t ? `Motion take on ${a.name || a.kind}: ${t.n} frames (${(t.n / t.fps).toFixed(1)} s) from frame ${a.mocap.start}.` : "Motion take added (loading…).";
  }

  /** Change a take's start frame, travel (move through the set) or speed. */
  setMocapOption(id, key, value) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a?.mocap) return;
    if (key === "start") a.mocap.start = Math.max(0, Math.round(value));
    else if (key === "travel") a.mocap.travel = !!value;
    else if (key === "loop") a.mocap.loop = !!value;
    else if (key === "speed") a.mocap.speed = Math.max(0.25, Math.min(4, +value || 1));
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  clearMocap(id) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a?.mocap) return;
    delete a.mocap;
    for (const j of Object.values(this.actorMeshes.get(id)?.userData?.joints || {})) j.rotation.set(...(j.userData.rest || [0, 0, 0]));
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  mocapInfo(id) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a?.mocap) return null;
    const t = Mocap.takeFor(a.mocap), fps = this.state.shot?.fps || 24;
    return { name: a.mocap.name || "take", file: a.mocap.file, start: a.mocap.start || 0, travel: a.mocap.travel !== false,
      speed: a.mocap.speed || 1, loop: !!a.mocap.loop, loaded: !!t, frames: t?.n || 0, seconds: t ? t.n / t.fps : 0,
      end: t ? Math.round((a.mocap.start || 0) + (t.n - 1) * fps / t.fps / (a.mocap.speed || 1)) : null };
  }

  poseInfo(id) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a) return null;
    return { pose: this.poseAt(a, this.frame) || {}, keys: (a.pose_keys || []).map((k) => k.frame), here: !!a.pose_keys?.some((k) => k.frame === this.frame) };
  }

  /** Which seat a rider takes in a vehicle (index into SEATS[kind]). */
  setSeat(id, seat) {
    const a = this.state.actors.find((x) => x.id === id);
    if (!a?.mount_id) return;
    a.seat = seat;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  removeSelected() {
    if (!this.selected) return;
    this.state.actors = this.state.actors.filter((a) => a.id !== this.selected);
    this.selected = null;
    this._buildSet();
    this.setFrame(this.frame);
    this.onSelect?.(null);
    this.onChange(this.toJSON());
  }

  rotateSelected(deg) {
    const a = this.state.actors.find((x) => x.id === this.selected);
    if (!a) return;
    a.rotation_deg = deg;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }

  setFocal(mm) {
    this._editCamera().focal_mm = mm;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
  }



  setView(mode) {
    this.view = mode;
    if (mode === "color" && this._hasSplats()) this._kickSplats();
    this.render();
  }

  load(scene) {
    if (!scene || typeof scene !== "object" || !scene.camera) return;
    this.state = clone(scene);
    if (!this.state.shot) this.state.shot = { frames: 97, fps: 24 };
    for (const a of this.state.actors || []) if (!a.kind) a.kind = "man";   // older scenes: drawn as a man, so a person
    this.camera.aspect = this.fw / this.fh;
    if (this.viewCam) { this.viewCam.aspect = this.fw / this.fh; this.viewCam.updateProjectionMatrix(); }
    this._snap = null;
    if (!this.state.lighting) this.state.lighting = clone(DEFAULT_SCENE.lighting);
    if (!this.state.environment) this.state.environment = { set: "plaza", weather: "none", density: 0.5, water_level: 2.5 };
    this._buildSet();
    this._applySun();
    this._backdropTex = null;
    const bd = this.state.backdrop?.url;
    if (bd) loadBackdrop(bd).then((tex) => { if (this.state.backdrop?.url === bd) { this._backdropTex = tex; this.render(); } }).catch(() => {});
    this.setKey("start");
  }

  toJSON() {
    return clone(this.state);
  }

  resize() {
    // A capture owns the renderer size; a layout change mid-capture (progress text, App panel) must
    // not shrink it, or every frame after the first yield comes out tiny. Re-fit once it's done.
    if (this._capturing) { this._resizePending = true; return; }
    const w = Math.max(240, this.canvas.parentElement?.clientWidth || this.fw);
    this.renderer.setSize(w, Math.round((w * this.fh) / this.fw), false);
    this.render();
  }

  /** Flat, distinct colour per object for the ID (matte) pass. */
  idColors() {
    const out = {};
    this.state.actors.forEach((a, i) => {
      const hue = (i * 0.6180339887) % 1; // golden-ratio hues stay far apart
      const c = new THREE.Color().setHSL(hue, 1, 0.5);
      out[a.id] = [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
    });
    return out;
  }

  /** Render the ID pass: each object its own flat colour, everything else black. */
  _renderId(cam) {
    const colors = this.idColors();
    const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const saved = [];
    this.scene.traverse((o) => {
      if (o.userData.splatOnly || o.userData.glass) { saved.push([o, o.material, o.visible]); o.visible = false; return; }   // riders show through glass
      if (o.isMesh || o.isPoints || o.isLineSegments) {
        saved.push([o, o.material, o.visible]);
        const id = o.userData.actorId;
        if (id && colors[id]) {
          o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(...colors[id].map((v) => v / 255)) });
        } else if (o.userData.lightId || o.isPoints || o.isLineSegments || o.userData.water) {
          o.visible = false;
        } else {
          o.material = black;
        }
      }
    });
    const bg = this.scene.background, fog = this.scene.fog, ov = this.scene.overrideMaterial;
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = null;
    this.scene.overrideMaterial = null;
    if (this.camHelper) this.camHelper.visible = false;
    this.renderer.render(this.scene, cam);
    for (const [o, m, v] of saved) { if (o.material !== m) o.material.dispose?.(); o.material = m; o.visible = v; }
    this.scene.background = bg; this.scene.fog = fog; this.scene.overrideMaterial = ov;
  }

  _renderMode(mode, forCapture = false) {
    this._applySplatVisibility(mode);
    if (this.tcHelper) {
      this.tcHelper.visible = !forCapture && !!this._gizmoOn && mode !== "id";
      if (!forCapture) this.tc.camera = this._viewportCamera?.() || this.camera;
    }
    if (mode === "id") return this._renderId(this.camera);
    if (this.selRing) this.selRing.visible = !forCapture && !!this.actorMeshes.get(this.selected);
    for (const h of this.lightHandles?.values() || []) h.visible = !forCapture && mode !== "depth";
    const env = this.state.environment || {};
    const viewCam = forCapture ? this.camera : this._viewportCamera?.() || this.camera;
    const underwater = this._isUnderwater(viewCam);
    if (this.weather) this.weather.object.visible = mode !== "depth";
    if (this.water) this.water.visible = true;
    if (mode === "clay" && underwater) {
      this.scene.fog = new THREE.FogExp2(0x2f4a5c, 0.06);
    } else if (mode === "clay" && env.weather === "fog") {
      this.scene.fog = new THREE.Fog(0x9aa3ad, 2, 12 + (1 - (env.density ?? 0.5)) * 60);
    } else {
      this.scene.fog = null;
    }
    // The backdrop plate is the shot camera's picture: it only lines up when looking through that camera. In Free view
    // it would hang behind the orbiting set as a giant flat photo, so the set is shown on its own there.
    const plate = !!this._backdropTex && (forCapture || !this.freeView);
    if (mode === "depth") {
      this.scene.background = new THREE.Color(0x000000);
      this.scene.overrideMaterial = depthMaterial;
    } else if (mode === "wire") {
      this.scene.background = new THREE.Color(0x0d1117);
      this.scene.overrideMaterial = this.wireMat;
    } else if (mode === "color") {
      const env = this.state.environment || {};
      const vc = forCapture ? this.camera : this._viewportCamera?.() || this.camera;
      const underwater = this._isUnderwater(vc);
      const sky = { night: 0x0b1020, "blue hour": 0x26324d, "dawn/dusk": 0x4a3a44, "magic hour": 0xd9a46a,
        "golden hour": 0xc9b89a, overcast: 0xb9bec4, daylight: 0x9cc3e6 }[this.skyPhase] ?? 0x9cc3e6;
      this.scene.background = new THREE.Color(underwater ? 0x1f4256 : env.set === "studio" ? 0xd8d8d8 : sky);
      if (plate) { coverFit(this._backdropTex, this.renderer.domElement.width / this.renderer.domElement.height); this.scene.background = this._backdropTex; }
      this.scene.overrideMaterial = null;
    } else {
      const env = this.state.environment || {};
      const vc = forCapture ? this.camera : this._viewportCamera?.() || this.camera;
      const underwater = this._isUnderwater(vc);
      this.scene.background = new THREE.Color(underwater ? 0x2f4a5c : env.set === "studio" ? 0x8e9298 : 0x2b2f36);
      // While blocking, show the plate behind the clay so actors can be placed in it; captures stay clean.
      if (plate && !forCapture) { coverFit(this._backdropTex, this.renderer.domElement.width / this.renderer.domElement.height); this.scene.background = this._backdropTex; }
      this.scene.overrideMaterial = this.clayMat;
    }
    const cam = forCapture ? this.camera : this._viewportCamera?.() || this.camera;
    if (this.camHelper) {
      this.camHelper.visible = !forCapture && !!this.freeView;
      if (this.camHelper.visible) this.camHelper.update();
    }
    // Interiors: in the viewport (never in captures) hide the ceilings when looking from above or in Free view,
    // and cut away the exterior walls between the camera and the rooms, like a dollhouse.
    const cutaway = [];
    if (this.interiorGroup && !forCapture && this.cutaway !== false) {
      const bb = new THREE.Box3().setFromObject(this.interiorGroup);
      const p = cam.position;
      for (const m of this.interiorGroup.children) {
        let hide = false;
        if (m.userData.ceiling) hide = this.freeView || p.y > (this.state.interior?.ceiling_m || 2.4);
        else if (m.userData.wall) {
          const w = m.userData.wall;
          if (w.axis === "z") hide = (p.z < bb.min.z && w.at <= bb.min.z + 0.2) || (p.z > bb.max.z && w.at >= bb.max.z - 0.2);
          else hide = (p.x < bb.min.x && w.at <= bb.min.x + 0.2) || (p.x > bb.max.x && w.at >= bb.max.x - 0.2);
        }
        if (hide && m.visible) { m.visible = false; cutaway.push(m); }
      }
    }
    // Depth sees through vehicle glass (like an open window), so the riders behind it keep their depth.
    if (mode === "depth") this.root.traverse((o) => { if (o.userData.glass && o.visible) { o.visible = false; cutaway.push(o); } });
    // Measurement aids are for the viewport only.
    if (!forCapture) this._measureOverlay(cam, this.measure !== false);
    if (this.poser?.active && this._ghost) this._ghost.visible = false;   // posing: the scale figure would sit beside them
    else { if (this._grid) this._grid.visible = false; if (this._ghost) this._ghost.visible = false; }
    // With a backdrop plate the photo is the ground: the floor becomes a shadow catcher in Color, and is
    // hidden behind the clay while blocking in the viewport (the clay/depth captures keep the real floor).
    let groundMat = null, groundVis = null;
    if (plate && this.ground) {
      if (mode === "color") {
        groundMat = this.ground.material;
        this.ground.material = this._shadowCatcher ||= new THREE.ShadowMaterial({ opacity: 0.38 });
      } else if (mode === "clay" && !forCapture) {
        groundVis = this.ground.visible;
        this.ground.visible = false;
      }
    }
    try { this.setFx?.pass?.(mode, { stage: this, cam, forCapture }); } catch (err) { console.warn("Soundstage set pass", err); }
    this._inRender = true;
    this.renderer.render(this.scene, cam);
    if (!forCapture && this.highlight) {
      try { this.highlight.render(this.renderer, cam, { hoverId: this._dragging ? null : this._hoverId, selectedId: this.selected }); }
      catch (err) { this.highlight.enabled = false; console.warn("Soundstage outline", err); }
    }
    if (!forCapture && (this.tcHelper?.visible || this.poser?.active)) {
      const auto = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.gizmoScene, cam);
      this.renderer.autoClear = auto;
    }
    this._inRender = false;
    if (groundMat) this.ground.material = groundMat;
    if (groundVis !== null) this.ground.visible = groundVis;
    for (const m of cutaway) m.visible = true;
    if (!forCapture) this.onRendered?.(cam);
  }

  render() {
    this._renderMode(this.view);
  }

  /** Render one pass at the delivery frame size and return it as a PNG Blob. */
  async capture(mode) {
    const prev = new THREE.Vector2();
    this.renderer.getSize(prev);
    this.renderer.setSize(this.fw, this.fh, false);
    this._renderMode(mode, true);
    const blob = await new OffscreenCanvas(this.fw, this.fh).getContext("2d").canvas.convertToBlob
      ? await (async () => { const oc = new OffscreenCanvas(this.fw, this.fh); oc.getContext("2d").drawImage(this.canvas, 0, 0); return oc.convertToBlob({ type: "image/png" }); })()
      : await new Promise((res) => this.canvas.toBlob(res, "image/png"));
    this.renderer.setSize(prev.x, prev.y, false);
    this.render();
    return blob;
  }

  /**
   * Render every frame of the shot for one pass and pack them into a single sprite sheet
   * (row-major grid of this.fw x this.fh tiles), so a whole shot uploads as one image.
   * Returns {blob, cols, rows, frames}.
   */
  async captureSequence(mode, onProgress) {
    const frames = Math.max(1, this.state.shot?.frames || 97);
    const cols = Math.min(frames, Math.floor(16000 / this.fw));
    const rows = Math.ceil(frames / cols);
    // OffscreenCanvas + convertToBlob keep working when the browser tab is in the background
    // (a hidden tab defers HTMLCanvasElement.toBlob callbacks indefinitely).
    const sheet = new OffscreenCanvas(cols * this.fw, rows * this.fh);
    const ctx = sheet.getContext("2d");
    const prev = new THREE.Vector2();
    this.renderer.getSize(prev);
    const keepFrame = this.frame;
    this._capturing = true;
    try {
      this.renderer.setSize(this.fw, this.fh, false);
      const splats = mode === "color" && this._hasSplats();
      if (splats) await this._settleSplats(mode, 24, 25); // first load + sort for this view (worker time, not just yields)
      for (let f = 0; f < frames; f++) {
        this.setFrameSilent(f);
        if (this.canvas.width !== this.fw || this.canvas.height !== this.fh) this.renderer.setSize(this.fw, this.fh, false);
        if (splats) await this._settleSplats(mode, 3); // re-sort for this frame's camera
        this._renderMode(mode, true);
        ctx.drawImage(this.canvas, (f % cols) * this.fw, Math.floor(f / cols) * this.fh);
        if (onProgress && f % 8 === 0) {
          onProgress(f / frames);
          await yieldToBrowser(); // let the UI breathe (not throttled in background tabs)
        }
      }
    } finally {
      this._capturing = false;
      this.renderer.setSize(prev.x, prev.y, false);
      this.setFrame(keepFrame);
      if (this._resizePending) { this._resizePending = false; this.resize(); }
    }
    const lossless = mode === "depth" || mode === "id";
    const type = lossless ? "image/png" : "image/jpeg";
    const blob = await sheet.convertToBlob({ type, quality: 0.95 });
    return { blob, cols, rows, frames, ext: lossless ? "png" : "jpg", tile: [this.fw, this.fh] };
  }

  /**
   * Render one frame in one view mode into a reusable 2D canvas (for the ladder viewer)
   * and put the viewport back the way it was.
   */
  renderFrameTo(mode, frame) {
    if (!this._snap) this._snap = document.createElement("canvas");
    // Follow the shot's aspect: a snapshot canvas kept at the first aspect crops every later render.
    if (this._snap.width !== this.fw || this._snap.height !== this.fh) { this._snap.width = this.fw; this._snap.height = this.fh; }
    const prev = new THREE.Vector2();
    this.renderer.getSize(prev);
    const keep = this.frame;
    this.renderer.setSize(this.fw, this.fh, false);
    this.setFrameSilent(frame);
    this._renderMode(mode, true);
    this._snap.getContext("2d").drawImage(this.canvas, 0, 0);
    this.renderer.setSize(prev.x, prev.y, false);
    this.setFrameSilent(keep);
    this._renderMode(this.view);
    return this._snap;
  }

  /** setFrame without the final viewport render (used while capturing). */
  setFrameSilent(frame) {
    const r = this.render;
    this.render = () => {};
    try {
      this.setFrame(frame);
    } finally {
      this.render = r;
    }
  }

  dispose() {
    this._ro?.disconnect();
    this.renderer.dispose();
  }
}
