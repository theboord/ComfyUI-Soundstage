// Three preset scenes for the browser-only "try the stage" page. Plain Stage scene JSON (version 2), the same
// schema the ComfyUI node saves: actors with position keys, timed mounts (mount_id / mount_at), carried props
// (carry_id / carry_at), and several camera setups in shots[] sharing one scene clock.

const key = (frame, position, target, focal_mm = 35) => ({ frame, position, target, focal_mm });
const at = (frame, position) => ({ frame, position });

function finish(scene) {
  // Stage.load() wants a top-level camera; the active shot's first key stands in for it.
  const shot = scene.shots.find((s) => s.id === scene.active_shot) || scene.shots[0];
  scene.camera = { ...shot.camera_keys[0] };
  delete scene.camera.frame;
  for (const a of scene.actors) if (!a.position) a.position = [...a.keys[0].position];
  return scene;
}

/** Slide a whole scene along Z (actors, cameras) so the action sits on open ground. */
function shiftZ(scene, dz) {
  const mv = (v) => [v[0], v[1], +(v[2] + dz).toFixed(2)];
  for (const a of scene.actors) for (const k of a.keys) k.position = mv(k.position);
  for (const sh of scene.shots) for (const k of sh.camera_keys) { k.position = mv(k.position); k.target = mv(k.target); }
  return scene;
}

/** (a) Two riders sprint to their horses, hop on and gallop off into the low sun. */
export function ridersAtSunset() {
  // The desert's nearest dune starts ~12 m out, so the mount-up happens 22 m back and the gallop ends at its foot.
  return finish(shiftZ({
    version: 2,
    shot: { frames: 121, fps: 24 },
    environment: { set: "desert", weather: "none", density: 0.5, water_level: 2.5 },
    lighting: { mode: "manual", hour: 18.5, day_of_year: 300, latitude: 34.05, north_deg: 0, overcast: false, preset: null, lights: [] },
    sun: { azimuth_deg: 12, elevation_deg: 6 },
    actors: [
      { id: "rider_a", name: "Rider A", kind: "man", height_m: 1.8,
        keys: [at(0, [-2.5, 0, -9.5]), at(40, [-2.4, 0, -0.3])], mount_id: "horse_a", pose: "ride", mount_at: 50 },
      { id: "rider_b", name: "Rider B", kind: "woman", height_m: 1.7,
        keys: [at(0, [2.6, 0, -10.5]), at(44, [2.4, 0, -0.3])], mount_id: "horse_b", pose: "ride", mount_at: 54 },
      { id: "horse_a", name: "Bay horse", kind: "horse", height_m: 1.6, rotation_deg: 0, appearance: { color: "#6b4430" },
        keys: [at(0, [-1.5, 0, 0]), at(56, [-1.5, 0, 0]), at(72, [-1.5, 0, 4]), at(120, [-1.7, 0, 31])] },
      { id: "horse_b", name: "Grey horse", kind: "horse", height_m: 1.6, rotation_deg: 0, appearance: { color: "#9a958e" },
        keys: [at(0, [1.5, 0, 0]), at(60, [1.5, 0, 0]), at(76, [1.5, 0, 4]), at(120, [1.8, 0, 28])] },
    ],
    props: [],
    shots: [
      { id: "wide", name: "Wide", setup: "wide",
        camera_keys: [key(0, [10, 1.8, -13], [0, 1.1, -3], 28), key(120, [7, 2.3, -3], [0, 1.4, 22], 32)] },
      { id: "track", name: "Low tracking", setup: "master",
        camera_keys: [key(0, [0, 0.9, -15], [0, 1.0, -2], 24), key(60, [0, 1.0, -7.5], [0, 1.3, 2], 24), key(120, [0, 1.6, 12], [0, 1.6, 30], 35)] },
      { id: "long", name: "Long lens", setup: "single_a",
        camera_keys: [key(0, [-16, 1.5, 4], [-1.5, 1.2, -3], 50), key(56, [-16, 1.5, 4], [-1.5, 1.3, 0], 50),
          key(84, [-16, 1.5, 4], [-1.5, 1.5, 10], 50), key(120, [-16, 1.5, 4], [-1.5, 1.5, 30], 50)] },
    ],
    active_shot: "wide",
  }, -22));
}

/** (b) A police car chases a sports car down a night street; both have a driver seated. */
export function policeChase() {
  const lamp = (x, z, i) => ({ id: `sodium_${i}`, type: "practical", name: `Street lamp ${i + 1}`, position: [x, 4.3, z],
    target: [x, 0, z], kelvin: 2100, intensity: 2.2, softness: 1, angle: 180 });
  return finish({
    version: 2,
    shot: { frames: 121, fps: 24 },
    environment: { set: "street_night", weather: "none", density: 0.5, water_level: 2.5 },
    lighting: { mode: "time", hour: 21.5, day_of_year: 300, latitude: 34.05, north_deg: 0, overcast: false, preset: "night",
      lights: [lamp(-5.4, -22, 0), lamp(5.4, -11, 1), lamp(-5.4, 0, 2), lamp(5.4, 11, 3), lamp(-5.4, 22, 4)] },
    sun: { azimuth_deg: 250, elevation_deg: -18 },
    actors: [
      { id: "getaway", name: "Getaway driver", kind: "man", height_m: 1.8, keys: [at(0, [1.6, 0, -24])],
        mount_id: "sports_car", seat: 0, pose: "sit" },
      { id: "cop", name: "Officer", kind: "woman", height_m: 1.72, keys: [at(0, [1.6, 0, -36])],
        mount_id: "police_car", seat: 0, pose: "sit" },
      { id: "sports_car", name: "Sports car", kind: "sports_car", height_m: 1.2, appearance: { color: "#c23b2a" },
        keys: [at(0, [1.6, 0, -24]), at(40, [-1.4, 0, -5]), at(80, [1.6, 0, 15]), at(120, [0, 0, 35])] },
      { id: "police_car", name: "Police car", kind: "police_car", height_m: 1.6,
        keys: [at(0, [1.6, 0, -36]), at(40, [1.0, 0, -16]), at(80, [-1.0, 0, 4]), at(120, [0.8, 0, 24])] },
    ],
    props: [],
    shots: [
      { id: "crane", name: "Wide crane", setup: "wide",
        camera_keys: [key(0, [-5, 6, -40], [1.2, 0.8, -28], 28), key(60, [-5, 5.5, -18], [0, 0.8, -6], 28),
          key(120, [-5, 5, 4], [0.4, 0.8, 22], 28)] },   // travels with the chase, always looking down the street
      { id: "tracking", name: "Tracking, front 3/4", setup: "single_a", camera_follow: "sports_car",
        camera_keys: [key(0, [2.8, 1.05, 4.6], [0, 0.7, 0], 30)] },
      { id: "chase", name: "Chase cam (police hood)", setup: "pov", camera_follow: "police_car",
        camera_keys: [key(0, [0.2, 1.45, 2.2], [0, 1.0, 16], 35)] },
    ],
    active_shot: "crane",
  });
}

/** (c) Someone searches a dark room with a flashlight; a dropped torch on the floor blinks. */
export function flashlightSearch() {
  return finish({
    version: 2,
    shot: { frames: 145, fps: 24 },
    environment: { set: "interior", weather: "none", density: 0.5, water_level: 2.5 },
    lighting: { mode: "time", hour: 23, day_of_year: 300, latitude: 34.05, north_deg: 0, overcast: false, preset: "night", lights: [] },
    sun: { azimuth_deg: 250, elevation_deg: -30 },
    actors: [
      { id: "searcher", name: "Searcher", kind: "man", height_m: 1.8,
        keys: [at(0, [-2.6, 0, -3.8]), at(70, [-1.2, 0, 0.4]), at(144, [1.3, 0, 3.4])] },
      { id: "torch", name: "Flashlight", kind: "flashlight", height_m: 0.08, keys: [at(0, [-2.6, 0, -3.4])],
        carry_id: "searcher", carry_at: 0 },
      { id: "dropped_torch", name: "Dropped flashlight", kind: "flashlight", height_m: 0.08, rotation_deg: -125,
        keys: [at(0, [2.4, 0, 0.9])], beam: "blink" },
      { id: "sofa", name: "Sofa", kind: "sofa", height_m: 0.85, rotation_deg: 90, keys: [at(0, [-3.1, 0, 2.6])] },
      { id: "coffee_table", name: "Coffee table", kind: "coffee_table", height_m: 0.42, rotation_deg: 90, keys: [at(0, [-2.0, 0, 2.6])] },
      { id: "bookshelf", name: "Bookshelf", kind: "bookshelf", height_m: 1.9, rotation_deg: 180, keys: [at(0, [2.9, 0, 4.7])] },
      { id: "armchair", name: "Armchair", kind: "armchair", height_m: 0.85, rotation_deg: -60, keys: [at(0, [3.0, 0, -2.4])] },
      { id: "dining_table", name: "Dining table", kind: "dining_table", height_m: 0.75, keys: [at(0, [0.2, 0, -2.6])] },
    ],
    props: [],
    shots: [
      { id: "wide", name: "Wide", setup: "wide",
        camera_keys: [key(0, [3.4, 2.2, -4.7], [-1, 0.8, 0.6], 18)] },
      { id: "follow", name: "Follow", setup: "ots_a",
        camera_keys: [key(0, [-3.3, 1.75, -6.0], [-2.2, 1.2, -2.5], 28), key(70, [-2.3, 1.75, -2.1], [-0.6, 1.1, 2], 28),
          key(144, [0.1, 1.75, 1.0], [1.8, 1.0, 4.5], 28)] },
      { id: "floor", name: "Torch on the floor", setup: "insert",
        camera_keys: [key(0, [1.5, 0.4, -0.5], [2.5, 0.05, 1.1], 32)] },
    ],
    active_shot: "wide",
  });
}

/** (d) Interior car driving: two people in the built sedan (open interior) cruise down a street at golden hour; the
 *  cameras ride inside the car while the street slides past. */
export function inTheCar() {
  const ride = (id, name, setup, pos, target, mm) => ({ id, name, setup, camera_follow: "car", camera_keys: [key(0, pos, target, mm)] });
  return finish({
    version: 2,
    shot: { frames: 121, fps: 24 },
    environment: { set: "street_night", weather: "none", density: 0.5, water_level: 2.5 },
    lighting: { mode: "time", hour: 16.4, day_of_year: 300, latitude: 34.05, north_deg: 0, overcast: false, preset: "golden", lights: [] },
    sun: { azimuth_deg: 240, elevation_deg: 12 },
    actors: [
      { id: "driver", name: "Driver", kind: "man", height_m: 1.8, keys: [at(0, [0, 0, -40])], mount_id: "car", seat: 0, pose: "sit" },
      { id: "passenger", name: "Passenger", kind: "woman", height_m: 1.7, keys: [at(0, [0, 0, -40])], mount_id: "car", seat: 1, pose: "sit" },
      { id: "car", name: "Sedan", kind: "car", height_m: 1.45, appearance: { color: "#2f5f86" },
        keys: [at(0, [1.6, 0, -40]), at(60, [1.6, 0, -6]), at(120, [1.2, 0, 30])] },
    ],
    props: [],
    shots: [
      ride("windshield", "Through the windshield", "two_shot", [0, 1.22, 2.45], [0, 1.05, 0], 30),
      ride("pov", "Driver's POV", "pov", [0.37, 1.2, 0.38], [0.37, 1.02, 8], 24),
      ride("passenger", "Passenger on driver", "single_a", [-0.38, 1.16, 0.42], [0.37, 1.1, -0.05], 32),
      ride("back", "Back seat", "ots_a", [0, 1.2, -1.15], [0, 1.05, 2], 22),
    ],
    active_shot: "windshield",
  });
}

/** (e) Three in a car: driver, front passenger and someone in the back seat on a sunny city street; the cameras sit
 *  inside and look back at them (dashboard two-shot, back-seat single, driver profile, over the shoulders). */
export function threeInACar() {
  const ride = (id, name, setup, pos, target, mm) => ({ id, name, setup, camera_follow: "car", camera_keys: [key(0, pos, target, mm)] });
  return finish({
    version: 2,
    shot: { frames: 121, fps: 24 },
    environment: { set: "street_night", weather: "none", density: 0.5, water_level: 2.5 },
    lighting: { mode: "manual", hour: 13.5, day_of_year: 200, latitude: 34.05, north_deg: 0, overcast: false, preset: "day", lights: [] },
    sun: { azimuth_deg: 200, elevation_deg: 55 },
    actors: [
      { id: "driver", name: "Driver", kind: "man", height_m: 1.82, keys: [at(0, [0, 0, -40])], mount_id: "car", seat: 0, pose: "sit",
        appearance: { top: "suit", top_color: "#1c1c1f", bottom_color: "#1c1c1f", hair: "long" } },
      { id: "front", name: "Front passenger", kind: "man", height_m: 1.8, keys: [at(0, [0, 0, -40])], mount_id: "car", seat: 1, pose: "sit",
        appearance: { top: "suit", top_color: "#1c1c1f", bottom_color: "#1c1c1f", hair: "short" } },
      { id: "back", name: "Back-seat passenger", kind: "man", height_m: 1.78, keys: [at(0, [0, 0, -40])], mount_id: "car", seat: 3, pose: "sit",
        appearance: { top: "shirt", top_color: "#c9b48a", hair: "short" } },
      { id: "car", name: "Sedan", kind: "car", height_m: 1.45, appearance: { color: "#c8c2b4" },
        keys: [at(0, [1.6, 0, -40]), at(60, [1.6, 0, -8]), at(120, [1.4, 0, 24])] },
    ],
    props: [],
    shots: [
      ride("dash", "Dashboard two-shot", "two_shot", [0, 1.12, 0.78], [0, 1.1, -0.3], 20),
      ride("backsingle", "Back seat single", "single_b", [0, 1.18, 0.15], [0, 1.0, -1.0], 24),
      ride("profile", "Driver profile", "single_a", [-0.38, 1.16, 0.42], [0.37, 1.1, -0.05], 32),
      ride("overshoulder", "Over the shoulders", "ots_a", [0, 1.2, -1.15], [0, 1.05, 2], 22),
    ],
    active_shot: "dash",
  });
}


/** (f) Alien invasion: a saucer drops out of the night sky over a city street; people run, a squad car skids to a stop. */
export function alienInvasion() {
  const lamp = (x, z, i) => ({ id: `sodium_${i}`, type: "practical", name: `Street lamp ${i + 1}`, position: [x, 4.3, z],
    target: [x, 0, z], kelvin: 2100, intensity: 2.2, softness: 1, angle: 180 });
  return finish({
    version: 2,
    shot: { frames: 121, fps: 24 },
    environment: { set: "street_night", weather: "none", density: 0.5, water_level: 2.5 },
    lighting: { mode: "time", hour: 20.6, day_of_year: 200, latitude: 34.05, north_deg: 0, overcast: false, preset: "night",
      lights: [lamp(-5.4, -11, 0), lamp(5.4, 0, 1), lamp(-5.4, 11, 2)] },
    sun: { azimuth_deg: 290, elevation_deg: -8 },
    actors: [
      { id: "saucer", name: "Flying saucer", kind: "ufo", height_m: 3,
        keys: [at(0, [0, 26, -26]), at(70, [0, 12, -12]), at(120, [0, 10, -9])] },
      { id: "runner_a", name: "Woman running", kind: "woman", height_m: 1.68,
        keys: [at(0, [-1.2, 0, -6]), at(120, [-2.4, 0, 12])] },
      { id: "runner_b", name: "Man running", kind: "man", height_m: 1.8,
        keys: [at(0, [1.4, 0, -8]), at(120, [0.8, 0, 11])] },
      { id: "kid", name: "Kid", kind: "child", height_m: 1.2, keys: [at(0, [-0.6, 0, -5]), at(120, [-1.6, 0, 10])] },
      { id: "officer", name: "Officer", kind: "man", height_m: 1.82, keys: [at(0, [3.2, 0, 2.5])], mount_id: "squad", seat: 0, pose: "sit" },
      { id: "squad", name: "Police car", kind: "police_car", height_m: 1.6, rotation_deg: 60,
        keys: [at(0, [4, 0, -14]), at(60, [2.6, 0, 1.5]), at(120, [2.6, 0, 2.2])] },
      { id: "parked", name: "Parked car", kind: "hatchback", height_m: 1.5, appearance: { color: "#6d7f8f" }, keys: [at(0, [-4.2, 0, 4])] },
    ],
    props: [],
    shots: [
      { id: "low_wide", name: "Low wide, looking up", setup: "wide",
        camera_keys: [key(0, [1.5, 0.5, 15], [0, 9, -14], 16), key(120, [1.5, 0.5, 13], [0, 7, -8], 16)] },
      { id: "run", name: "Runners, front tracking", setup: "single_a",
        camera_keys: [key(0, [0.4, 1.5, 4], [0, 1.4, -6], 28), key(120, [0, 1.5, 20], [-1, 1.6, 10], 28)] },
      { id: "sky", name: "POV: the sky opens", setup: "pov",
        camera_keys: [key(0, [-1, 1.6, 3], [0, 22, -24], 24), key(120, [-1.4, 1.6, 6], [0, 10, -9], 24)] },
    ],
    active_shot: "low_wide",
  });
}

export const PRESETS = [
  { id: "riders", label: "Riders at sunset", make: ridersAtSunset, view: "color" },
  { id: "chase", label: "Police chase", make: policeChase, view: "color" },
  { id: "car", label: "In the car", make: inTheCar, view: "color" },
  { id: "three", label: "Three in a car", make: threeInACar, view: "color" },
  { id: "torch", label: "Flashlight search", make: flashlightSearch, view: "color" },
  { id: "aliens", label: "Alien invasion", make: alienInvasion, view: "color" },
];
