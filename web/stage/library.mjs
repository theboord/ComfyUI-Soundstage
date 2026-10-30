// Soundstage object library: type a word, get a real-scale clay stand-in.
// Shapes are deliberately simple (previz only needs silhouette and size) and are built from
// primitives, so there are no asset downloads and no licensing questions.
import * as THREE from "../vendor/three.module.min.mjs";
import { buildHuman } from "./humans.mjs";

/** kind -> default real-world size and how it moves. */
export const LIBRARY = {
  man: { label: "Man", height: 1.8, rig: "biped" },
  woman: { label: "Woman", height: 1.68, rig: "biped" },
  child: { label: "Child", height: 1.2, rig: "biped" },
  dog: { label: "Dog", height: 0.6, rig: "quadruped" },
  horse: { label: "Horse", height: 1.6, rig: "quadruped" },
  cat: { label: "Cat", height: 0.3, rig: "quadruped" },
  bird: { label: "Bird", height: 0.35, rig: "static" },
  car: { label: "Car", height: 1.45, rig: "vehicle" },
  truck: { label: "Truck", height: 2.6, rig: "vehicle" },
  // Real-car looks (CC0, Quaternius): closed bodies over the built sedan's seats. `length` is bumper to bumper.
  police_car: { label: "Police car", height: 1.6, rig: "vehicle", model: "police_car.glb", length: 4.8 },
  sports_car: { label: "Sports car", height: 1.2, rig: "vehicle", model: "sports_car.glb", length: 4.5 },
  hatchback: { label: "Hatchback", height: 1.5, rig: "vehicle", model: "car.glb", length: 4.2 },
  bicycle: { label: "Bicycle", height: 1.05, rig: "vehicle" },
  motorcycle: { label: "Motorcycle", height: 1.15, rig: "vehicle" },
  tree: { label: "Tree", height: 6.5, rig: "static" },
  bush: { label: "Bush", height: 1.1, rig: "static" },
  house: { label: "House", height: 6.0, rig: "static" },
  bench: { label: "Bench", height: 0.85, rig: "static" },
  table: { label: "Table", height: 0.75, rig: "static" },
  chair: { label: "Chair", height: 0.9, rig: "static" },
  lamp: { label: "Street lamp", height: 4.2, rig: "static" },
  rock: { label: "Rock", height: 0.8, rig: "static" },
  crate: { label: "Crate", height: 0.8, rig: "static" },
  flashlight: { label: "Flashlight", height: 0.08, rig: "static", light: true },
  ufo: { label: "Flying saucer", height: 3, rig: "static", light: true, flies: true },
  wall: { label: "Wall", height: 2.4, rig: "static" },
  cube: { label: "Cube", height: 1, rig: "static" },
  sphere: { label: "Sphere", height: 1, rig: "static" },
  pyramid: { label: "Pyramid", height: 1, rig: "static" },
  cylinder: { label: "Cylinder", height: 1, rig: "static" },
  cone: { label: "Cone", height: 1, rig: "static" },
  flat: { label: "Set flat", height: 3, rig: "static" },
  // Interior furniture at real dimensions (metres), so floor-plan rooms read at true scale.
  bed: { label: "Double bed", height: 1.0, rig: "static" },
  single_bed: { label: "Single bed", height: 1.0, rig: "static" },
  sofa: { label: "Sofa", height: 0.85, rig: "static" },
  armchair: { label: "Armchair", height: 0.85, rig: "static" },
  coffee_table: { label: "Coffee table", height: 0.42, rig: "static" },
  tv: { label: "TV on stand", height: 1.3, rig: "static" },
  kitchen_counter: { label: "Kitchen counter", height: 0.9, rig: "static" },
  fridge: { label: "Fridge", height: 1.8, rig: "static" },
  bath: { label: "Bathtub", height: 0.55, rig: "static" },
  toilet: { label: "Toilet", height: 0.8, rig: "static" },
  washbasin: { label: "Washbasin", height: 0.85, rig: "static" },
  wardrobe: { label: "Wardrobe", height: 2.0, rig: "static" },
  bookshelf: { label: "Bookshelf", height: 1.9, rig: "static" },
  desk: { label: "Desk", height: 0.75, rig: "static" },
  dining_table: { label: "Dining table", height: 0.75, rig: "static" },
  rug: { label: "Rug", height: 0.01, rig: "static" },
  door: { label: "Door", height: 2.05, rig: "static" },
  houseplant: { label: "House plant", height: 1.2, rig: "static" },
};

/** Furniture as true-size boxes: [width x, height y, depth z, centre x, centre y, centre z, accent?]. */
const FURNITURE = {
  bed: [[1.6, 0.35, 2.0, 0, 0.2, 0], [1.56, 0.18, 1.96, 0, 0.46, 0, 1], [1.6, 1.0, 0.08, 0, 0.5, -0.98], [0.6, 0.12, 0.35, -0.38, 0.6, -0.75, 1], [0.6, 0.12, 0.35, 0.38, 0.6, -0.75, 1]],
  single_bed: [[0.9, 0.35, 2.0, 0, 0.2, 0], [0.86, 0.18, 1.96, 0, 0.46, 0, 1], [0.9, 1.0, 0.08, 0, 0.5, -0.98], [0.6, 0.12, 0.35, 0, 0.6, -0.75, 1]],
  sofa: [[2.1, 0.42, 0.9, 0, 0.21, 0], [2.1, 0.45, 0.2, 0, 0.62, -0.35], [0.2, 0.62, 0.9, -0.95, 0.31, 0], [0.2, 0.62, 0.9, 0.95, 0.31, 0], [0.82, 0.12, 0.62, -0.42, 0.48, 0.06, 1], [0.82, 0.12, 0.62, 0.42, 0.48, 0.06, 1]],
  armchair: [[0.9, 0.42, 0.85, 0, 0.21, 0], [0.9, 0.45, 0.18, 0, 0.62, -0.33], [0.16, 0.62, 0.85, -0.37, 0.31, 0], [0.16, 0.62, 0.85, 0.37, 0.31, 0]],
  coffee_table: [[1.1, 0.05, 0.6, 0, 0.4, 0], [1.0, 0.03, 0.5, 0, 0.12, 0], [0.05, 0.38, 0.05, -0.5, 0.19, -0.25], [0.05, 0.38, 0.05, 0.5, 0.19, -0.25], [0.05, 0.38, 0.05, -0.5, 0.19, 0.25], [0.05, 0.38, 0.05, 0.5, 0.19, 0.25]],
  tv: [[1.5, 0.5, 0.45, 0, 0.25, 0], [1.4, 0.8, 0.06, 0, 0.92, -0.05, 1]],
  kitchen_counter: [[2.4, 0.86, 0.6, 0, 0.43, 0], [2.42, 0.04, 0.62, 0, 0.88, 0, 1], [0.6, 0.02, 0.5, 0.6, 0.91, 0, 1]],
  fridge: [[0.7, 1.8, 0.7, 0, 0.9, 0], [0.02, 0.5, 0.04, 0.3, 1.2, 0.36, 1]],
  bath: [[1.7, 0.55, 0.75, 0, 0.275, 0], [1.5, 0.05, 0.55, 0, 0.53, 0, 1]],
  toilet: [[0.38, 0.4, 0.5, 0, 0.2, 0.05], [0.4, 0.42, 0.18, 0, 0.6, -0.27]],
  washbasin: [[0.6, 0.8, 0.45, 0, 0.4, 0], [0.48, 0.06, 0.34, 0, 0.83, 0.02, 1]],
  wardrobe: [[1.2, 2.0, 0.6, 0, 1.0, 0], [0.02, 1.8, 0.02, 0, 1.0, 0.31, 1]],
  bookshelf: [[0.9, 1.9, 0.35, 0, 0.95, 0], [0.86, 0.02, 0.3, 0, 0.5, 0.03, 1], [0.86, 0.02, 0.3, 0, 0.95, 0.03, 1], [0.86, 0.02, 0.3, 0, 1.4, 0.03, 1]],
  desk: [[1.4, 0.04, 0.7, 0, 0.73, 0], [0.04, 0.71, 0.66, -0.66, 0.355, 0], [0.04, 0.71, 0.66, 0.66, 0.355, 0]],
  dining_table: [[1.6, 0.05, 0.9, 0, 0.73, 0], [0.06, 0.7, 0.06, -0.72, 0.35, -0.38], [0.06, 0.7, 0.06, 0.72, 0.35, -0.38], [0.06, 0.7, 0.06, -0.72, 0.35, 0.38], [0.06, 0.7, 0.06, 0.72, 0.35, 0.38]],
  rug: [[2.4, 0.01, 1.7, 0, 0.005, 0]],
  door: [[0.9, 2.05, 0.05, 0, 1.025, 0], [0.12, 0.02, 0.06, 0.34, 1.0, 0.05, 1]],
  houseplant: [[0.36, 0.38, 0.36, 0, 0.19, 0], [0.7, 0.8, 0.7, 0, 0.78, 0, 1]],
};

const SYNONYMS = {
  person: "man", guy: "man", male: "man", driver: "man", rider: "man", cowboy: "man", cyclist: "man", boy: "child", girl: "child", kid: "child", female: "woman",
  lady: "woman", puppy: "dog", pony: "horse", kitten: "cat", sedan: "car", suv: "car", taxi: "car",
  police: "police_car", "police car": "police_car", "cop car": "police_car", "squad car": "police_car", cruiser: "police_car",
  "sports car": "sports_car", supercar: "sports_car", racecar: "sports_car", "race car": "sports_car", coupe: "sports_car",
  hatchback: "hatchback", "compact car": "hatchback", "small car": "hatchback",
  van: "truck", lorry: "truck", bus: "truck", "pickup truck": "truck", pickup: "truck", bike: "bicycle", motorbike: "motorcycle",
  scooter: "motorcycle", vespa: "motorcycle", shrub: "bush", hedge: "bush", plant: "bush",
  home: "house", cabin: "house", hut: "house", seat: "chair", lamppost: "lamp",
  crow: "bird", raven: "bird", eagle: "bird", hawk: "bird", owl: "bird", pigeon: "bird", seagull: "bird", gull: "bird", parrot: "bird",
  saucer: "ufo", "flying saucer": "ufo", spaceship: "ufo", "space ship": "ufo", mothership: "ufo", "alien ship": "ufo",
  alien: "man", martian: "man", invader: "man",
  torch: "flashlight", "flash light": "flashlight", "electric torch": "flashlight", "maglite": "flashlight",
  streetlight: "lamp", "street lamp": "lamp", boulder: "rock", stone: "rock", box: "crate",
  fence: "wall", palm: "tree", oak: "tree", pine: "tree", ball: "sphere", block: "cube", column: "cylinder",
  pillar: "cylinder", "set wall": "flat", backdrop: "flat",
  couch: "sofa", settee: "sofa", "double bed": "bed", "queen bed": "bed", "king bed": "bed", "single bed": "single_bed",
  "coffee table": "coffee_table", television: "tv", "tv stand": "tv", kitchen: "kitchen_counter", counter: "kitchen_counter",
  "kitchen counter": "kitchen_counter", hob: "kitchen_counter", stove: "kitchen_counter", refrigerator: "fridge",
  bathtub: "bath", tub: "bath", wc: "toilet", sink: "washbasin", basin: "washbasin", closet: "wardrobe", cupboard: "wardrobe",
  shelf: "bookshelf", bookcase: "bookshelf", "dining table": "dining_table", carpet: "rug", "house plant": "houseplant",
};

/**
 * "man on a horse", "woman riding a bicycle", "a driver in a red car", "kid sitting on a bench"
 * → {rider: kind, mount: kind} when both parts resolve, else null.
 */
export function resolveCompound(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/^(.*?)\s+(?:on|riding|astride|in|inside|driving|sitting on|seated on|on top of)\s+(?:a |an |the )?(.*)$/);
  if (!m) return null;
  const riderWord = m[1].replace(/^(a|an|the)\s+/, "").replace(/\bdriver\b/, "man").replace(/\brider\b/, "man");
  const rider = resolveKind(riderWord), mount = resolveKind(m[2]);
  if (!rider || !mount || rider === mount) return null;
  return { rider, mount };
}

/** Map free text ("a big dog", "Woman", "bikes") to a library kind, or null. */
export function resolveKind(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;
  const words = t.replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  const candidates = [t, ...words, ...words.map((w) => w.replace(/s$/, ""))];
  for (const c of candidates) {
    if (LIBRARY[c]) return c;
    if (SYNONYMS[c]) return SYNONYMS[c];
  }
  return null;
}

/**
 * Build a clay stand-in. `mesh(geom)` makes a shadowed clay mesh. Returns a Group whose
 * origin sits on the floor at the object's centre, facing +Z. Movable rigs expose
 * userData.limbs = [{pivot, phase, amp}] for a simple gait.
 */
/** Default colours per kind: [main, accent]. Users can override the main colour per object. */
export const OBJECT_COLORS = {
  dog: ["#b08455", "#5a3d26"], horse: ["#6b4430", "#2a1b12"], cat: ["#8a8a8a", "#3b3b3b"],
  car: ["#a8231f", "#1b1b1d"], truck: ["#e5e2da", "#1b1b1d"], bicycle: ["#c9302c", "#1b1b1d"],
  police_car: ["#f0f0f0", "#1b1b1d"], sports_car: ["#f0f0f0", "#1b1b1d"], hatchback: ["#2f5fa8", "#1b1b1d"],
  motorcycle: ["#1f2a44", "#1b1b1d"], tree: ["#3e6b35", "#5b4029"], bush: ["#4a7a3e", "#4a7a3e"],
  house: ["#d8cbb2", "#7a3b2e"], bench: ["#8a5a35", "#2d2d2d"], table: ["#8a5a35", "#8a5a35"],
  chair: ["#7a5232", "#7a5232"], lamp: ["#2f3236", "#f3e3b0"], rock: ["#8c877e", "#8c877e"],
  crate: ["#a7814f", "#a7814f"], flashlight: ["#2b2d31", "#d9dde2"], bird: ["#1d1d22", "#c9a227"], ufo: ["#8d949c", "#b8f5c4"], wall: ["#bdb7ad", "#bdb7ad"], flat: ["#cfc8bb", "#7a6a55"],
  bed: ["#8a6a4c", "#e9e4da"], single_bed: ["#8a6a4c", "#e9e4da"], sofa: ["#5d6b78", "#7d8a96"], armchair: ["#8a5a3c", "#8a5a3c"],
  coffee_table: ["#6e4f35", "#6e4f35"], tv: ["#3a3a3c", "#111214"], kitchen_counter: ["#e8e4dc", "#9a9590"], fridge: ["#d9dcdf", "#8a8d90"],
  bath: ["#f1f1ee", "#dfe7ea"], toilet: ["#f3f3f0", "#f3f3f0"], washbasin: ["#e8e4dc", "#f3f3f0"], wardrobe: ["#a8865f", "#5a4630"],
  bookshelf: ["#7a5a3e", "#b9a27f"], desk: ["#8a6a4c", "#8a6a4c"], dining_table: ["#7a5232", "#7a5232"], rug: ["#9a6b4f", "#9a6b4f"],
  door: ["#b48a5c", "#c0c0c0"], houseplant: ["#c9b9a2", "#4a7a3e"],
};
const GLASS = "#5d7180";

/** Seats in vehicles (local metres, +Z forward, +X = the vehicle's left). A rider is placed at pos, facing forward. */
export const SEATS = {
  car: [
    { name: "Driver", pos: [0.37, 0.52, 0.05] },
    { name: "Front passenger", pos: [-0.37, 0.52, 0.05] },
    { name: "Rear left", pos: [0.37, 0.52, -0.85] },
    { name: "Rear right", pos: [-0.37, 0.52, -0.85] },
  ],
  police_car: null, sports_car: null, hatchback: null,   // filled below: the sedan's seats
  truck: [
    { name: "Driver", pos: [0.5, 1.25, 2.3] },
    { name: "Passenger", pos: [-0.5, 1.25, 2.3] },
  ],
};SEATS.police_car = SEATS.sports_car = SEATS.hatchback = SEATS.car;


export function buildObject(kind, height, mesh, appearance = null) {
  const spec = LIBRARY[kind];
  const h = height || spec?.height || 1;
  if (kind === "man" || kind === "woman" || kind === "child") return buildHuman(kind, h, appearance, mesh);
  const [main, accent] = OBJECT_COLORS[kind] || ["#9a9a9a", "#6a6a6a"];
  const mainCol = appearance?.color || main;
  const g = new THREE.Group();
  g.userData.limbs = [];
  const add = (geom, x, y, z, rx = 0, ry = 0, rz = 0, color = mainCol) => {
    const m = mesh(geom, color);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };
  const limb = (x, y, z, len, r, phase, amp = 0.42) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const m = mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mainCol);
    m.position.y = -len / 2 - r;
    pivot.add(m);
    g.add(pivot);
    g.userData.limbs.push({ pivot, phase, amp });
  };

  switch (kind) {
    case "man":
    case "woman":
    case "child": {
      const s = h / 1.8;
      add(new THREE.CapsuleGeometry(0.2 * s, 0.55 * s, 4, 12), 0, 1.25 * s, 0);
      add(new THREE.SphereGeometry(0.13 * s, 16, 12), 0, 1.72 * s, 0);
      for (const [i, sx] of [-0.11, 0.11].entries()) {
        limb(sx * s, 0.88 * s, 0, 0.7 * s, 0.075 * s, i ? Math.PI : 0);
        limb(sx * 2.7 * s, 1.52 * s, 0, 0.5 * s, 0.055 * s, i ? 0 : Math.PI, 0.34);
      }
      break;
    }
    case "horse": {
      // Withers height h (default 1.6 m). Built to read from ANY side, so the video model never guesses which
      // way it faces: broad rounded rump + hanging tail behind, deep chest, arched neck, long head and ears in
      // front. Legs: forearm/gaskin, cannon, hoof (one rigid pivot each, animated by the gait).
      const s = h / 1.6;
      const legL = 0.95 * s, bodyY = legL + 0.28 * s;
      const tube = (r1, r2, a, b, col = mainCol, seg = 14) => {           // tapered cylinder from point a to b (y, z)
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const m = add(new THREE.CylinderGeometry(r2, r1, len, seg), 0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
          Math.atan2(b[1] - a[1], b[0] - a[0]), 0, 0, col);
        return m;
      };
      add(new THREE.CapsuleGeometry(0.3 * s, 0.85 * s, 8, 20), 0, bodyY, 0.02 * s, Math.PI / 2).scale.set(0.95, 1, 1.08);  // barrel
      add(new THREE.SphereGeometry(0.34 * s, 20, 16), 0, bodyY + 0.03 * s, 0.55 * s).scale.set(0.9, 1.05, 1);              // chest
      add(new THREE.SphereGeometry(0.37 * s, 20, 16), 0, bodyY + 0.06 * s, -0.55 * s).scale.set(1.08, 1, 1);               // rump (wide)
      add(new THREE.SphereGeometry(0.2 * s, 14, 10), 0, bodyY + 0.28 * s, 0.42 * s).scale.set(0.7, 0.8, 1.2);              // withers
      // Neck rising forward, then the head angled down to the muzzle.
      const neckBase = [bodyY + 0.2 * s, 0.62 * s], poll = [bodyY + 0.78 * s, 1.05 * s];
      tube(0.22 * s, 0.12 * s, neckBase, poll);
      add(new THREE.BoxGeometry(0.05 * s, 0.6 * s, 0.1 * s), 0, (neckBase[0] + poll[0]) / 2 + 0.08 * s, (neckBase[1] + poll[1]) / 2 - 0.1 * s,
        Math.atan2(poll[1] - neckBase[1], poll[0] - neckBase[0]), 0, 0, accent);                                           // mane
      const muzzle = [poll[0] - 0.42 * s, poll[1] + 0.3 * s];
      tube(0.12 * s, 0.075 * s, poll, muzzle);
      add(new THREE.SphereGeometry(0.085 * s, 12, 10), 0, muzzle[0], muzzle[1]).scale.set(0.9, 0.85, 1.1);                // nose
      for (const x of [-0.06, 0.06]) add(new THREE.ConeGeometry(0.035 * s, 0.14 * s, 8), x * s, poll[0] + 0.1 * s, poll[1] - 0.02 * s, -0.15, 0, 0, accent); // ears
      // Tail: thick dock, then a long plume hanging down and back (unmistakable from behind).
      tube(0.07 * s, 0.05 * s, [bodyY + 0.2 * s, -0.86 * s], [bodyY - 0.05 * s, -0.98 * s], accent);
      tube(0.055 * s, 0.13 * s, [bodyY - 0.05 * s, -0.98 * s], [bodyY - 0.72 * s, -1.05 * s], accent, 12);
      // Legs: [x, z, front?] — forelegs under the chest, hind legs under the rump with a hock.
      for (const [i, [x, z, front]] of [[-0.17, 0.5, 1], [0.17, 0.5, 1], [-0.17, -0.55, 0], [0.17, -0.55, 0]].entries()) {
        const pivot = new THREE.Group();
        pivot.position.set(x * s, legL + 0.08 * s, z * s);
        const upper = mesh(new THREE.CylinderGeometry(front ? 0.075 * s : 0.1 * s, front ? 0.1 * s : 0.13 * s, 0.48 * s, 12), mainCol);
        upper.position.set(0, -0.24 * s, front ? 0 : -0.04 * s);
        upper.rotation.x = front ? 0 : 0.12;
        const lower = mesh(new THREE.CylinderGeometry(0.045 * s, 0.05 * s, 0.46 * s, 10), mainCol);
        lower.position.set(0, -0.7 * s, front ? 0 : -0.02 * s);
        const hoof = mesh(new THREE.CylinderGeometry(0.065 * s, 0.075 * s, 0.09 * s, 12), accent);
        hoof.position.set(0, -0.98 * s, 0.01 * s);
        pivot.add(upper, lower, hoof);
        g.add(pivot);
        g.userData.limbs.push({ pivot, phase: i === 0 || i === 3 ? 0 : Math.PI, amp: 0.42 });
      }
      break;
    }
    case "dog":
    case "cat": {
      const s = h / 0.6; // proportions of a 0.6 m dog
      const bodyL = kind === "horse" ? 0.75 * s : 0.55 * s;
      const legL = 0.28 * s;
      add(new THREE.CapsuleGeometry(0.12 * s, bodyL, 4, 12), 0, legL + 0.16 * s, 0, Math.PI / 2);
      add(new THREE.SphereGeometry(0.1 * s, 14, 10), 0, legL + 0.3 * s, bodyL / 2 + 0.17 * s); // head
      add(new THREE.CapsuleGeometry(0.04 * s, 0.12 * s, 4, 6), 0, legL + 0.24 * s, bodyL / 2 + 0.07 * s, -0.7); // neck
      add(new THREE.CapsuleGeometry(0.02 * s, 0.2 * s, 4, 6), 0, legL + 0.22 * s, -bodyL / 2 - 0.1 * s, 0.9); // tail
      for (const [i, [x, z]] of [[-0.08, 0.26], [0.08, 0.26], [-0.08, -0.26], [0.08, -0.26]].entries()) {
        limb(x * s, legL + 0.06 * s, (z * bodyL) / 0.55, legL - 0.06 * s, 0.035 * s, i === 0 || i === 3 ? 0 : Math.PI);
      }
      break;
    }
    case "police_car":
    case "sports_car":
    case "hatchback":
    case "car": {
      // A real sedan, front = +Z: curved body from a side profile (wheel arches cut in), open windows so riders
      // show (clay has no glass; the image model adds it), pillars + roof, seats, dash, wheel, tyres with rims.
      const s = h / 1.45, L = 4.6 * s, W = 1.82 * s, belt = 0.95 * s, roofY = 1.43 * s, r = 0.34 * s;
      const wf = 1.4 * s, wr = -1.35 * s;                       // front / rear axle (z)
      const prof = new THREE.Shape();
      const fz = L / 2, rz = -L / 2, sill = 0.3 * s, arch = r + 0.07 * s;
      prof.moveTo(rz + 0.12 * s, sill);
      prof.lineTo(wr - arch, sill);
      prof.absarc(wr, r, arch, Math.PI - Math.asin((sill - r) / arch), Math.asin((sill - r) / arch), true);
      prof.lineTo(wf - arch, sill);
      prof.absarc(wf, r, arch, Math.PI - Math.asin((sill - r) / arch), Math.asin((sill - r) / arch), true);
      prof.lineTo(fz - 0.1 * s, sill);
      prof.quadraticCurveTo(fz, sill, fz, sill + 0.18 * s);          // front bumper
      prof.lineTo(fz, 0.68 * s);
      prof.quadraticCurveTo(fz - 0.05 * s, 0.8 * s, fz - 0.35 * s, 0.82 * s);
      prof.quadraticCurveTo(1.2 * s, 0.9 * s, 0.95 * s, belt);         // hood up to the windshield base
      prof.lineTo(-1.6 * s, belt + 0.02 * s);                            // beltline
      prof.quadraticCurveTo(-1.9 * s, 0.98 * s, -2.15 * s, 0.93 * s);   // trunk lid
      prof.quadraticCurveTo(rz, 0.9 * s, rz, 0.7 * s);
      prof.lineTo(rz, sill + 0.15 * s);
      prof.quadraticCurveTo(rz, sill, rz + 0.12 * s, sill);
      const bodyGeom = new THREE.ExtrudeGeometry(prof, { depth: W - 0.08 * s, bevelEnabled: true, bevelThickness: 0.04 * s,
        bevelSize: 0.04 * s, bevelSegments: 3, curveSegments: 18 });
      bodyGeom.translate(0, 0, -(W - 0.08 * s) / 2);
      add(bodyGeom, 0, 0, 0, 0, -Math.PI / 2, 0);
      // Greenhouse frame: A, B, C pillars and the roof (both sides), no glass.
      const strut = (x, y1, z1, y2, z2, th = 0.1 * s) => {
        const len = Math.hypot(y2 - y1, z2 - z1);
        add(new THREE.BoxGeometry(th, len, th * 1.6), x, (y1 + y2) / 2, (z1 + z2) / 2, Math.atan2(z2 - z1, y2 - y1));
      };
      const px = W / 2 - 0.08 * s;
      for (const x of [-px, px]) {
        strut(x, belt, 0.95 * s, roofY, 0.2 * s);                       // A pillar (raked windshield)
        strut(x, belt, -0.4 * s, roofY, -0.4 * s, 0.11 * s);            // B pillar
        strut(x, belt + 0.02 * s, -1.6 * s, roofY, -0.95 * s, 0.2 * s); // C pillar (wide, like a real sail panel)
        add(new THREE.BoxGeometry(0.1 * s, 0.09 * s, 1.2 * s), x, roofY - 0.02 * s, -0.38 * s);   // roof rail
      }
      const roof = new THREE.BoxGeometry(W - 0.1 * s, 0.08 * s, 1.24 * s);
      add(roof, 0, roofY, -0.38 * s);
      add(new THREE.BoxGeometry(W - 0.2 * s, 0.035 * s, 0.05 * s), 0, roofY - 0.02 * s, 0.2 * s, 0, 0, 0, accent); // header
      // Interior: seats (cushion + back), dashboard, steering wheel on the driver's side (+X = car's left).
      for (const z of [0.05 * s, -0.85 * s]) for (const x of [0.37 * s, -0.37 * s]) {
        add(new THREE.BoxGeometry(0.5 * s, 0.12 * s, 0.5 * s), x, 0.46 * s, z, 0, 0, 0, accent);
        add(new THREE.BoxGeometry(0.5 * s, 0.62 * s, 0.1 * s), x, 0.8 * s, z - 0.28 * s, -0.18, 0, 0, accent);
      }
      add(new THREE.BoxGeometry(W - 0.2 * s, 0.22 * s, 0.35 * s), 0, 0.88 * s, 0.75 * s, 0, 0, 0, accent);  // dash
      add(new THREE.TorusGeometry(0.19 * s, 0.022 * s, 8, 24), 0.37 * s, 0.98 * s, 0.52 * s, -0.45, 0, 0, accent);
      // Wheels: tyre + rim + hub, inside the arches.
      for (const x of [-(W / 2 - 0.12 * s), W / 2 - 0.12 * s]) for (const z of [wf, wr]) {
        add(new THREE.CylinderGeometry(r, r, 0.24 * s, 28), x, r, z, 0, 0, Math.PI / 2, "#1b1b1d");
        add(new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.25 * s, 20), x, r, z, 0, 0, Math.PI / 2, "#8d9096");
      }
      // Lights.
      for (const x of [-0.6 * s, 0.6 * s]) {
        add(new THREE.BoxGeometry(0.34 * s, 0.09 * s, 0.05 * s), x, 0.72 * s, fz - 0.01 * s, 0, 0, 0, "#e9e6d8");
        add(new THREE.BoxGeometry(0.34 * s, 0.09 * s, 0.05 * s), x, 0.82 * s, rz + 0.01 * s, 0, 0, 0, "#7a1b1b");
      }
      g.userData.seats = SEATS.car.map((q) => ({ ...q, pos: q.pos.map((v) => v * s) }));
      break;
    }
    case "truck": {
      const L = kind === "truck" ? 6.5 : 4.5, W = kind === "truck" ? 2.3 : 1.8;
      const body = h * 0.45;
      add(new THREE.BoxGeometry(W, body, L), 0, 0.3 + body / 2, 0);
      const cabL = kind === "truck" ? 1.8 : 2.4;
      add(new THREE.BoxGeometry(W * 0.92, h - body - 0.3, cabL), 0, 0.3 + body + (h - body - 0.3) / 2,
        kind === "truck" ? L / 2 - cabL / 2 : -0.2, 0, 0, 0, GLASS);
      for (const x of [-W / 2, W / 2]) for (const z of [-L * 0.33, L * 0.33]) {
        add(new THREE.CylinderGeometry(0.34, 0.34, 0.25, 18), x, 0.34, z, 0, 0, Math.PI / 2, accent);
      }
      break;
    }
    case "bicycle":
    case "motorcycle": {
      const r = kind === "motorcycle" ? 0.33 : 0.34;
      for (const z of [-0.55, 0.55]) add(new THREE.TorusGeometry(r, 0.035, 8, 24), 0, r, z, 0, Math.PI / 2);
      add(new THREE.BoxGeometry(0.06, 0.06, 1.0), 0, r + 0.25, 0, 0.25);
      add(new THREE.BoxGeometry(0.06, 0.5, 0.06), 0, r + 0.35, -0.3);
      const bar = kind === "motorcycle" ? h - 0.05 : Math.max(1.0, h + 0.05); // handlebar height
      add(new THREE.BoxGeometry(0.5, 0.04, 0.04), 0, bar, 0.45);
      const fy = bar - r, fz = -0.1; // fork/stem from the front hub up to the bars
      add(new THREE.BoxGeometry(0.05, Math.hypot(fy, fz), 0.05), 0, r + fy / 2, 0.55 + fz / 2, Math.atan2(fz, fy));
      if (kind === "bicycle") add(new THREE.BoxGeometry(0.15, 0.05, 0.26), 0, r + 0.62, -0.32, 0, 0, 0, accent); // saddle
      if (kind === "motorcycle") add(new THREE.BoxGeometry(0.35, 0.35, 0.7), 0, r + 0.2, 0);
      break;
    }
    case "tree": {
      add(new THREE.CylinderGeometry(0.18, 0.28, h * 0.45, 10), 0, (h * 0.45) / 2, 0, 0, 0, 0, accent);
      add(new THREE.SphereGeometry(h * 0.28, 14, 10), 0, h * 0.68, 0);
      add(new THREE.SphereGeometry(h * 0.2, 12, 8), h * 0.15, h * 0.55, h * 0.08);
      break;
    }
    case "bush":
      add(new THREE.SphereGeometry(h * 0.6, 14, 10), 0, h * 0.45, 0);
      break;
    case "house": {
      add(new THREE.BoxGeometry(8, h * 0.6, 7), 0, (h * 0.6) / 2, 0);
      const roof = add(new THREE.ConeGeometry(6.2, h * 0.4, 4), 0, h * 0.6 + (h * 0.4) / 2, 0, 0, Math.PI / 4, 0, accent);
      roof.scale.set(1, 1, 0.85);
      add(new THREE.BoxGeometry(1.1, 2.1, 0.1), 0, 1.05, 3.52, 0, 0, 0, "#5b3a24"); // door
      break;
    }
    case "bench":
      add(new THREE.BoxGeometry(1.8, 0.08, 0.45), 0, 0.45, 0);
      add(new THREE.BoxGeometry(1.8, 0.4, 0.06), 0, 0.68, -0.2);
      for (const x of [-0.8, 0.8]) add(new THREE.BoxGeometry(0.08, 0.45, 0.45), x, 0.225, 0);
      break;
    case "table":
      add(new THREE.BoxGeometry(1.4, 0.06, 0.8), 0, h, 0);
      for (const x of [-0.62, 0.62]) for (const z of [-0.33, 0.33]) add(new THREE.BoxGeometry(0.06, h, 0.06), x, h / 2, z);
      break;
    case "chair":
      add(new THREE.BoxGeometry(0.45, 0.05, 0.45), 0, 0.46, 0);
      add(new THREE.BoxGeometry(0.45, 0.45, 0.05), 0, 0.7, -0.2);
      for (const x of [-0.2, 0.2]) for (const z of [-0.2, 0.2]) add(new THREE.BoxGeometry(0.04, 0.46, 0.04), x, 0.23, z);
      break;
    case "flashlight": {
      // A 26 cm torch lying along +Z (the beam), with a real spotlight: it lights whatever it points at in every
      // pass, follows the hands that carry it, and can flicker or blink (actor.beam).
      add(new THREE.CylinderGeometry(0.019, 0.019, 0.2, 14), 0, 0.04, -0.03, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.036, 0.022, 0.07, 16), 0, 0.04, 0.1, Math.PI / 2);
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.004, 16), 0, 0.04, 0.136, Math.PI / 2, 0, 0, accent);
      const beam = new THREE.SpotLight(0xf3f6ff, 30, 30, THREE.MathUtils.degToRad(13), 0.45, 1.5);
      beam.position.set(0, 0.04, 0.14);
      beam.castShadow = true;
      beam.shadow.mapSize.set(1024, 1024);
      beam.target.position.set(0, -0.9, 4);      // angled down, like someone sweeping the floor ahead
      g.add(beam, beam.target);
      g.userData.beam = beam;
      g.userData.beamBase = 30;
      break;
    }
    case "bird": {
      // A perched bird about h tall: body, head, beak, folded wings, tail, two legs.
      const k = h / 0.35;
      const body = add(new THREE.SphereGeometry(0.09 * k, 14, 10), 0, 0.15 * k, 0); body.scale.set(0.8, 0.85, 1.35);
      add(new THREE.SphereGeometry(0.055 * k, 12, 10), 0, 0.25 * k, 0.09 * k);
      add(new THREE.ConeGeometry(0.018 * k, 0.06 * k, 8), 0, 0.245 * k, 0.16 * k, Math.PI / 2, 0, 0, accent);
      for (const sx of [-1, 1]) { const w = add(new THREE.SphereGeometry(0.07 * k, 10, 8), sx * 0.06 * k, 0.16 * k, -0.02 * k); w.scale.set(0.3, 0.7, 1.5); }
      add(new THREE.BoxGeometry(0.08 * k, 0.012 * k, 0.12 * k), 0, 0.13 * k, -0.15 * k, -0.35);
      for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.006 * k, 0.006 * k, 0.07 * k, 6), sx * 0.025 * k, 0.035 * k, 0, 0, 0, 0, accent);
      break;
    }
    case "ufo": {
      // A flying saucer about 4x as wide as it is tall: hull, dome, glowing rim lights and a tractor beam pointing down.
      // It hovers wherever its keys put it (key Y is height), so it can drop in over a set.
      const r = h * 2;
      const hull = add(new THREE.SphereGeometry(r, 40, 14), 0, 0, 0);
      hull.scale.set(1, 0.18, 1);
      add(new THREE.SphereGeometry(r * 0.38, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), 0, r * 0.12, 0, 0, 0, 0, accent);
      add(new THREE.TorusGeometry(r * 0.98, h * 0.05, 8, 48), 0, 0, 0, Math.PI / 2, 0, 0, accent);
      for (let i = 0; i < 12; i++) {
        const t = (i / 12) * Math.PI * 2;
        add(new THREE.SphereGeometry(h * 0.06, 10, 8), Math.cos(t) * r * 0.82, -r * 0.08, Math.sin(t) * r * 0.82, 0, 0, 0, accent);
      }
      const beam = new THREE.SpotLight(0xb8ffc8, 400, 80, THREE.MathUtils.degToRad(16), 0.35, 1.2);
      beam.position.set(0, -r * 0.15, 0);
      beam.castShadow = true;
      beam.target.position.set(0, -50, 0);
      g.add(beam, beam.target);
      g.userData.beam = beam;
      g.userData.beamBase = 400;
      break;
    }
    case "lamp":
      add(new THREE.CylinderGeometry(0.08, 0.12, h, 10), 0, h / 2, 0);
      add(new THREE.BoxGeometry(0.25, 0.25, 0.6), 0, h, 0.2, 0, 0, 0, accent);
      break;
    case "rock": {
      const m = add(new THREE.DodecahedronGeometry(h * 0.7, 0), 0, h * 0.4, 0);
      m.scale.set(1.3, 0.75, 1);
      break;
    }
    case "wall":
      add(new THREE.BoxGeometry(6, h, 0.25), 0, h / 2, 0);
      break;
    case "cube":
      add(new THREE.BoxGeometry(h, h, h), 0, h / 2, 0);
      break;
    case "sphere":
      add(new THREE.SphereGeometry(h / 2, 24, 16), 0, h / 2, 0);
      break;
    case "pyramid":
      add(new THREE.ConeGeometry(h * 0.7, h, 4), 0, h / 2, 0, 0, Math.PI / 4);
      break;
    case "cylinder":
      add(new THREE.CylinderGeometry(h / 2, h / 2, h, 24), 0, h / 2, 0);
      break;
    case "cone":
      add(new THREE.ConeGeometry(h / 2, h, 24), 0, h / 2, 0);
      break;
    case "flat":
      add(new THREE.BoxGeometry(4, h, 0.1), 0, h / 2, 0);
      add(new THREE.BoxGeometry(0.08, h * 0.7, 1.2), -1.6, h * 0.35, -0.6, 0.6);
      break;
    case "bed": case "single_bed": case "sofa": case "armchair": case "coffee_table": case "tv": case "kitchen_counter":
    case "fridge": case "bath": case "toilet": case "washbasin": case "wardrobe": case "bookshelf": case "desk":
    case "dining_table": case "rug": case "door": case "houseplant": {
      const k = h / (LIBRARY[kind].height || h || 1); // true size by default; Scale stretches uniformly
      for (const [w, hh, d, x, y, z, acc] of FURNITURE[kind]) {
        add(new THREE.BoxGeometry(w * k, Math.max(0.005, hh * k), d * k), x * k, y * k, z * k, 0, 0, 0, acc ? accent : undefined);
      }
      break;
    }
    default: // crate and anything unknown
      add(new THREE.BoxGeometry(h, h, h), 0, h / 2, 0);
  }
  return g;
}

/**
 * Build a clay stand-in from an LLM-designed recipe (see soundstage/object_designer.py):
 * parts of simple shapes in metres, Y up, +Z front, origin on the floor at the centre.
 */
export function buildFromRecipe(recipe, mesh) {
  const g = new THREE.Group();
  g.userData.limbs = [];
  const D = THREE.MathUtils.degToRad;
  for (const p of recipe?.parts || []) {
    const [sx, sy, sz] = p.size;
    let geom;
    let scale = [1, 1, 1];
    switch (p.shape) {
      case "cylinder":
        geom = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
        scale = [sx, sy, sz];
        break;
      case "sphere":
        geom = new THREE.SphereGeometry(0.5, 20, 14);
        scale = [sx, sy, sz];
        break;
      case "cone":
        geom = new THREE.ConeGeometry(0.5, 1, 20);
        scale = [sx, sy, sz];
        break;
      case "capsule": {
        const r = Math.min(sx, sz) / 2;
        geom = new THREE.CapsuleGeometry(r, Math.max(0.001, sy - 2 * r), 6, 14);
        break;
      }
      case "torus": {
        const tube = Math.max(0.005, sy / 2);
        geom = new THREE.TorusGeometry(Math.max(tube, sx / 2 - tube), tube, 10, 28);
        break;
      }
      default:
        geom = new THREE.BoxGeometry(sx, sy, sz);
    }
    const m = mesh(geom, p.color || recipe.color); // per-part colour (Video → Stage set pieces); clay otherwise
    m.scale.set(...scale);
    m.position.set(...p.pos);
    m.rotation.set(D(p.rot?.[0] || 0), D(p.rot?.[1] || 0), D(p.rot?.[2] || 0));
    g.add(m);
  }
  return g;
}
