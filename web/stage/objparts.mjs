// Parts: pro-grade, keyframeable control over every object on the stage (Milestone 26), the way Unreal Sequencer,
// Maya and Cinema 4D give every rig its own animated channels. Each object (and each film light, and the shot camera)
// can carry `parts = { channel: [{ frame, v, i? }] }`: one key list per channel, sorted by frame, a single key = a
// constant. Numbers ease between keys (i: "ease" default | "linear" | "step"); switches and modes hold (step).
// A channel with no keys plays its default (often "auto": steering follows the path, brake lights come on as the
// car slows, the horse picks its gait from its speed).
//
//   vehicles  steering, ride height / roll / pitch, every door, hood, trunk, headlights, brake lights, indicators,
//             police light bar, wipers, window tint, paint finish, dirt, damage (+ side)
//   horses    head pitch / turn, neck, tail lift and swish, gait override
//   people    expression, eyes (gaze keys, web/stage/gaze.mjs), the hands and props in hand (Pose Studio / carry)
//   props     pivot point, finish, glow, the named sub-parts of an imported model (rotation per part)
//   lights    intensity, colour temperature (K), cone angle, softness, flicker; practical vs motivated
//   camera    focal length, focus distance, T-stop, roll (the shot's keys), shutter angle, sensor
//
// Pure data and maths here (tested in tests/js/objparts.test.mjs). installParts(Stage) adds the Stage API
// (setPart, keyPartHere, partChannels...) and the per-frame hooks; vehicleparts.mjs and lightrig.mjs build and drive
// the geometry and lights. One undo step per change (each call ends in one stage.onChange).

export const PART_ENUMS = {
  headlights: { auto: "Auto", off: "Off", low: "Dipped", high: "Full beam" },
  brake: { auto: "Auto (braking)", off: "Off", on: "On" },
  indicator: { off: "Off", left: "Left", right: "Right", hazard: "Hazards" },
  lightbar: { off: "Off", flash: "Flashing", steady: "Steady" },
  wipers: { off: "Off", intermittent: "Intermittent", normal: "Normal", fast: "Fast" },
  finish: { factory: "As modelled", matte: "Matte", satin: "Satin", gloss: "Gloss", metallic: "Metallic", chrome: "Chrome" },
  damage_side: { front: "Front", rear: "Rear", left: "Left side", right: "Right side" },
  navlights: { off: "Off", on: "On", strobe: "+ strobes" },
  gait: { auto: "Auto (speed)", idle: "Stand", walk: "Walk", trot: "Trot", canter: "Canter", gallop: "Gallop" },
  expression: { neutral: "Neutral", smile: "Smile", laugh: "Laugh", frown: "Frown", angry: "Angry", sad: "Sad",
    surprised: "Surprised", afraid: "Afraid", disgust: "Disgust", talking: "Talking", shouting: "Shouting", eyes_closed: "Eyes closed" },
  flicker: { off: "Steady", candle: "Candle / fire", fluorescent: "Failing fluorescent", tv: "TV glow", lightning: "Lightning",
    strobe: "Strobe", police: "Police red / blue", pulse: "Slow pulse" },
  motivation: { film: "Film light (unseen)", motivated: "Motivated (by a source in frame)", practical: "Practical (in frame)" },
  sensor: { ff: "Full frame 36 mm", s35: "Super 35 24.9 mm", lf: "ARRI LF 36.7 mm", a65: "ALEXA 65 54.1 mm",
    mft: "Micro 4/3 17.3 mm", imax: "IMAX 70 mm 70.4 mm" },
};
export const SENSOR_W = { ff: 36, s35: 24.9, lf: 36.7, a65: 54.12, mft: 17.3, imax: 70.41 };

// type: num | enum. def: the value with no keys. auto: the default is computed (steer, brake, gait).
// key: a shortcut the Parts panel answers (with the selection). static: not keyable (a setting, not a channel).
const N = (group, label, min, max, step, unit, def, tip, extra = {}) => ({ type: "num", group, label, min, max, step, unit, def, tip, ...extra });
const E = (group, label, def, tip, extra = {}) => ({ type: "enum", group, label, def, tip, ...extra });

export const CHANNELS = {
  // ---- vehicles
  steer: N("Wheels", "Steering", -40, 40, 0.5, "°", 0, "Front wheels' steering angle (+ = left). Until you key it, the wheels steer along the path", { auto: true }),
  susp_h: N("Suspension", "Ride height", -0.15, 0.2, 0.005, " m", 0, "Raise or lower the body on its springs"),
  susp_roll: N("Suspension", "Body roll", -12, 12, 0.5, "°", 0, "Lean the body (+ = right side down), on top of the automatic weight transfer"),
  susp_pitch: N("Suspension", "Body pitch", -8, 8, 0.25, "°", 0, "Nose up (+) or down (-) on the springs, on top of braking and launch dive"),
  door_fl: N("Doors", "Driver door", 0, 70, 1, "°", 0, "Front-left (driver's) door, degrees open", { key: "O" }),
  door_fr: N("Doors", "Passenger door", 0, 70, 1, "°", 0, "Front-right door, degrees open"),
  door_rl: N("Doors", "Rear left door", 0, 70, 1, "°", 0, "Rear-left door, degrees open"),
  door_rr: N("Doors", "Rear right door", 0, 70, 1, "°", 0, "Rear-right door, degrees open"),
  hood: N("Doors", "Hood", 0, 75, 1, "°", 0, "Hood (bonnet), degrees open"),
  trunk: N("Doors", "Trunk", 0, 80, 1, "°", 0, "Trunk, hatch or cargo doors, degrees open"),
  headlights: E("Lights", "Headlights", "auto", "Off, dipped or full beam: the beams light the set and the lamps glow in the clay guide. Auto = lamps marked, no beams", { key: "L" }),
  brake: E("Lights", "Brake lights", "auto", "Brake lights: on, off, or automatic while the car slows"),
  indicator: E("Lights", "Indicators", "off", "Turn signals or hazards, blinking at 1.5 Hz", { key: "I" }),
  lightbar: E("Lights", "Light bar", "off", "Police light bar: red and blue flashing, the same at every render", { key: "Shift+L" }),
  navlights: E("Lights", "Nav lights", "off", "Navigation lights: red port, green starboard, white strobes"),
  wipers: E("Glass", "Wipers", "off", "Windscreen wipers"),
  tint: N("Glass", "Window tint", 0, 1, 0.05, "", 0, "0 = clear glass, 1 = limo-black"),
  finish: E("Paint", "Finish", "factory", "Paint finish: matte, satin, gloss, metallic or chrome", { static: true }),
  dirt: N("Paint", "Dirt", 0, 1, 0.05, "", 0, "Road grime and dust on the paint"),
  damage: N("Paint", "Damage", 0, 1, 0.02, "", 0, "Crumple the body (key it from 0 to animate a hit)"),
  damage_side: E("Paint", "Damage side", "front", "Where the damage is", { static: true }),
  // ---- horses
  head_pitch: N("Head & neck", "Head up / down", -40, 35, 1, "°", 0, "Lift (+) or drop (-) the head"),
  head_yaw: N("Head & neck", "Head turn", -60, 60, 1, "°", 0, "Turn the head and neck (+ = to its left)"),
  neck: N("Head & neck", "Neck arch", -30, 30, 1, "°", 0, "Arch (+) or stretch (-) the neck"),
  tail_lift: N("Tail", "Tail lift", -20, 60, 1, "°", 0, "Carry the tail high (+) or clamp it (-)"),
  tail_swish: N("Tail", "Tail swish", 0, 1, 0.05, "", 0, "Swish the tail side to side (flies, nerves)"),
  gait: E("Gait", "Gait", "auto", "Force a gait (walk, trot, canter, gallop); Auto picks it from the speed"),
  // ---- people
  expression: E("Face", "Expression", "neutral", "The face the actor makes from this key on (the prompt says it at its time)"),
  // ---- props and imported models
  pivot_x: N("Pivot", "Pivot X", -5, 5, 0.01, " m", 0, "Move the point it turns around (left / right)", { static: true }),
  pivot_y: N("Pivot", "Pivot Y", -5, 5, 0.01, " m", 0, "Move the point it turns around (up / down)", { static: true }),
  pivot_z: N("Pivot", "Pivot Z", -5, 5, 0.01, " m", 0, "Move the point it turns around (front / back)", { static: true }),
  glow: N("Material", "Glow", 0, 4, 0.05, "", 0, "Self-lit (a screen, a sign, a lit window)"),
  // ---- film lights
  intensity: N("Light", "Intensity", 0, 12, 0.05, "", null, "Brightness (key it for a dimmer move)"),
  kelvin: N("Light", "Colour temp", 1800, 12000, 50, " K", null, "Colour temperature: 2700 K tungsten, 5600 K daylight, 3200 K stage"),
  angle: N("Light", "Cone angle", 4, 120, 1, "°", null, "Beam width (spots)"),
  softness: N("Light", "Softness", 0, 1, 0.02, "", null, "Edge softness: hard fresnel (0) to a big soft source (1)"),
  flicker: E("Light", "Flicker", "off", "Flicker pattern, deterministic (every render the same)"),
  flicker_amt: N("Light", "Flicker amount", 0, 1, 0.05, "", 0.6, "How deep the flicker goes"),
  motivation: E("Light", "Source", "film", "Practical (the lamp is in shot), motivated (by a window, a fire), or an unseen film light", { static: true }),
  // ---- the shot camera (focal / focus / T-stop / roll write the shot's own camera and lens keys)
  focal_mm: N("Lens", "Focal length", 8, 400, 1, " mm", null, "Zoom / prime focal length, keyed on the camera"),
  focus_m: N("Lens", "Focus distance", 0.3, 120, 0.05, " m", null, "Where focus sits (a rack focus is two keys)"),
  t_stop: N("Lens", "T-stop", 0.7, 22, 0.1, "", null, "Iris: T1.4 is shallow, T8 deep"),
  roll_deg: N("Lens", "Roll (dutch)", -45, 45, 0.5, "°", 0, "Dutch angle"),
  shutter_deg: N("Lens", "Shutter angle", 11.25, 360, 0.25, "°", 180, "180° = normal motion blur; 45° = staccato, crisp (Saving Private Ryan); 360° = smeared"),
  sensor: E("Lens", "Sensor", "ff", "Sensor size: a smaller sensor crops the same lens tighter", { static: true }),
};

const CAR_KINDS = new Set(["car", "police_car", "sports_car", "hatchback"]);
const DOORS = { car: 4, police_car: 4, sports_car: 2, hatchback: 4, truck: 2 };

/** Channel names for an object kind (+ the model's named sub-parts, for imported models). */
export function channelsFor(kind, opts = {}) {
  const veh = ["susp_h", "susp_roll", "susp_pitch"];
  if (CAR_KINDS.has(kind) || kind === "truck") {
    const doors = ["door_fl", "door_fr", "door_rl", "door_rr"].slice(0, DOORS[kind] || 4);
    return ["steer", ...veh, ...doors, ...(kind === "truck" ? [] : ["hood"]), "trunk", "headlights", "brake", "indicator",
      ...(kind === "police_car" ? ["lightbar"] : []), "wipers", "tint", "finish", "dirt", "damage", "damage_side"];
  }
  if (kind === "motorcycle") return ["steer", "headlights", "brake", "indicator", "finish", "dirt", "damage", "damage_side"];
  if (kind === "bicycle") return ["steer", "finish", "dirt"];
  if (["boat", "jetski", "sailboat", "catamaran"].includes(kind)) return ["headlights", "navlights", "finish", "dirt", "damage", "damage_side"];
  if (kind === "airliner") return ["headlights", "navlights", "finish", "dirt"];
  if (kind === "train") return ["headlights", "finish", "dirt"];
  if (kind === "horse") return ["head_pitch", "head_yaw", "neck", "tail_lift", "tail_swish", "gait"];
  if (["man", "woman", "child"].includes(kind)) return ["expression"];
  if (kind === "__light__") return ["intensity", "kelvin", "angle", "softness", "flicker", "flicker_amt", "motivation"];
  if (kind === "__camera__") return ["focal_mm", "focus_m", "t_stop", "roll_deg", "shutter_deg", "sensor"];
  if (["dog", "cat", "cow", "bird"].includes(kind)) return [];
  const sub = (opts.subparts || []).flatMap((n) => [`sub:${n}:rx`, `sub:${n}:ry`, `sub:${n}:rz`]);
  return ["pivot_x", "pivot_y", "pivot_z", "finish", "glow", ...sub];
}

/** Spec of a channel (sub-part rotations are generated). */
export function specOf(ch) {
  if (CHANNELS[ch]) return CHANNELS[ch];
  const m = /^sub:(.+):r([xyz])$/.exec(ch || "");
  if (m) return N(`Part: ${m[1]}`, { x: "Tilt (X)", y: "Turn (Y)", z: "Roll (Z)" }[m[2]], -180, 180, 1, "°", 0, `Rotate the model's "${m[1]}" part`);
  return null;
}

export const optionsOf = (ch) => PART_ENUMS[ch] || null;

const smooth = (u) => u * u * (3 - 2 * u);

/** Clamp / validate a value for a channel; null if it can't be used. */
export function coerce(ch, v) {
  const s = specOf(ch);
  if (!s) return null;
  if (s.type === "enum") {
    const o = PART_ENUMS[ch];
    if (v === true) v = ch === "headlights" ? "low" : ch === "lightbar" ? "flash" : ch === "brake" ? "on" : ch === "wipers" ? "normal" : ch === "navlights" ? "on" : "on";
    if (v === false) v = ch === "headlights" || ch === "brake" ? "off" : "off";
    const t = String(v ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    const alias = { on: ch === "headlights" ? "low" : ch === "lightbar" ? "flash" : ch === "wipers" ? "normal" : "on", dipped: "low", low_beam: "low", full: "high",
      high_beam: "high", full_beam: "high", brights: "high", flashing: "flash", hazards: "hazard", run: "gallop", stand: "idle", still: "idle", smiling: "smile" }[t];
    const k = o[t] ? t : alias && o[alias] ? alias : null;
    return k;
  }
  const n = +v;
  if (!Number.isFinite(n)) return null;
  return Math.max(s.min, Math.min(s.max, n));
}

/** Value of a key list at a frame (keys sorted by frame). Missing → undefined. */
export function sampleKeys(keys, frame, type = "num") {
  if (!keys?.length) return undefined;
  if (frame <= keys[0].frame || keys.length === 1) return keys[0].v;
  const n = keys.length - 1;
  if (frame >= keys[n].frame) return keys[n].v;
  let i = 0;
  while (keys[i + 1].frame <= frame) i++;
  const a = keys[i], b = keys[i + 1];
  if (type !== "num" || a.i === "step" || typeof a.v !== "number" || typeof b.v !== "number") return a.v;
  const u = (frame - a.frame) / Math.max(1e-6, b.frame - a.frame);
  return a.v + (b.v - a.v) * (a.i === "linear" ? u : smooth(u));
}

/** A channel's value at a frame: its keys, else the default (undefined = "auto" for the caller to compute). */
export function partAt(obj, ch, frame) {
  const s = specOf(ch);
  if (!s) return undefined;
  const v = sampleKeys(obj?.parts?.[ch], frame, s.type);
  if (v !== undefined) return v;
  if (s.auto) return undefined;
  return s.def;
}

/** Write a key (frame, value) into obj.parts[ch]: replaces a key on that frame, keeps the list sorted. */
export function writeKey(obj, ch, frame, v, interp) {
  const keys = ((obj.parts ||= {})[ch] ||= []);
  const f = Math.max(0, Math.round(frame));
  let k = keys.find((x) => x.frame === f);
  if (!k) { k = { frame: f, v }; keys.push(k); keys.sort((p, q) => p.frame - q.frame); }
  k.v = v;
  if (interp) { if (interp === "ease") delete k.i; else k.i = interp; }
  return k;
}

/** Remove the key on a frame (and the channel when it was the last one). */
export function dropKey(obj, ch, frame) {
  const keys = obj?.parts?.[ch];
  if (!keys) return false;
  const n = keys.length;
  obj.parts[ch] = keys.filter((k) => k.frame !== frame);
  if (!obj.parts[ch].length) delete obj.parts[ch];
  if (obj.parts && !Object.keys(obj.parts).length) delete obj.parts;
  return (obj.parts?.[ch]?.length ?? 0) !== n;
}

export function clearChannel(obj, ch) {
  if (!obj?.parts?.[ch]) return false;
  delete obj.parts[ch];
  if (!Object.keys(obj.parts).length) delete obj.parts;
  return true;
}

// ------------------------------------------------------------------ deterministic blink / flash / flicker patterns

const frac = (x) => x - Math.floor(x);
const hash = (n) => frac(Math.sin(n * 12.9898 + 78.233) * 43758.5453);

/** Turn signal: 1.5 Hz, on for the first half of each cycle. */
export const blinkOn = (t) => frac(t * 1.5) < 0.5;

/** Police light bar at time t (s): {left, right} 0..1, a double-flash wig-wag (left red, right blue). */
export function lightbarAt(mode, t) {
  if (mode === "steady") return { left: 1, right: 1 };
  if (mode !== "flash") return { left: 0, right: 0 };
  const c = frac(t / 0.6);
  const left = (c < 0.08 || (c >= 0.13 && c < 0.21)) ? 1 : 0;
  const right = ((c >= 0.5 && c < 0.58) || (c >= 0.63 && c < 0.71)) ? 1 : 0;
  return { left, right };
}

/** Aircraft / boat nav lights: steady red and green, white strobes double-flashing once a second. */
export function navAt(mode, t) {
  if (mode === "off" || !mode) return { nav: 0, strobe: 0 };
  const c = frac(t);
  return { nav: 1, strobe: mode === "strobe" && (c < 0.05 || (c > 0.12 && c < 0.17)) ? 1 : 0 };
}

/** Light output multiplier for a flicker pattern at frame f (fps), depth amt 0..1. Always the same for a frame. */
export function flickerAt(mode, f, fps = 24, amt = 0.6, seed = 0) {
  const t = f / fps, a = Math.max(0, Math.min(1, amt));
  switch (mode) {
    case "candle": { // layered slow + fast noise around ~0.8
      const n = 0.55 * Math.sin(t * 7.3 + seed) + 0.3 * Math.sin(t * 17.1 + 1.7 * seed) + 0.15 * (hash(f + seed * 31) * 2 - 1);
      return Math.max(0, 1 - a * 0.45 * (1 - n));
    }
    case "fluorescent": { // mostly on, with dropouts and a stutter
      const r = hash(Math.floor(t * 9) + seed * 7);
      if (r < 0.18) return 1 - a * (hash(f + seed) < 0.5 ? 1 : 0.7);
      return 1 - a * 0.04 * hash(f * 3 + seed);
    }
    case "tv": return Math.max(0, 1 - a * 0.6 * hash(Math.floor(t * 6) + seed * 13));
    case "lightning": { // rare double strikes
      const k = Math.floor(t / 2.7), c = t - k * 2.7, at = 0.4 + 1.8 * hash(k + seed);
      const on = (c > at && c < at + 0.06) || (c > at + 0.13 && c < at + 0.2);
      return on ? 1 + a * 3 : 1 - a;
    }
    case "strobe": return frac(t * 8) < 0.25 ? 1 : 1 - a;
    case "police": { const lb = lightbarAt("flash", t); return lb.left || lb.right ? 1 : 1 - a; }
    case "pulse": return 1 - a * 0.5 * (1 - Math.cos(t * Math.PI));
    default: return 1;
  }
}

/** Police flicker colour (a light set to "police" alternates red and blue). */
export function policeColourAt(t) {
  const lb = lightbarAt("flash", t);
  return lb.left ? 0xff2a1a : lb.right ? 0x2a5cff : null;
}

/** Wiper sweep angle 0..1 (0 = parked) at time t. */
export function wiperAt(mode, t) {
  const rate = { normal: 0.75, fast: 1.25, intermittent: 0.75 }[mode];
  if (!rate) return 0;
  if (mode === "intermittent") { const c = t % 4; return c < 1 / rate ? (1 - Math.cos(2 * Math.PI * c * rate)) / 2 : 0; }
  return (1 - Math.cos(2 * Math.PI * t * rate)) / 2;
}

/** Steering angle (deg, + = left) from a path: Ackermann / bicycle model, delta = atan(wheelbase * yawRate / v). */
export function autoSteer(pos, yaw, fps, wheelbase = 2.7, max = 35) {
  const n = pos.length, out = new Array(n).fill(0);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - 2), b = Math.min(n - 1, f + 2);
    if (b === a) continue;
    const dt = (b - a) / fps;
    let dy = yaw[b] - yaw[a];
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const vx = (pos[b][0] - pos[a][0]) / dt, vz = (pos[b][2] - pos[a][2]) / dt;
    const fwd = vx * Math.sin(yaw[f]) + vz * Math.cos(yaw[f]);   // signed: negative in reverse
    if (Math.abs(fwd) < 0.6) { out[f] = f ? out[f - 1] : 0; continue; }
    const d = Math.atan((wheelbase * (dy / dt)) / fwd) * 180 / Math.PI;
    out[f] = Math.max(-max, Math.min(max, d));
  }
  return out;
}

// ------------------------------------------------------------------ words (the prompt and the Director's replies)

const DOOR_WORDS = { door_fl: "the driver's door", door_fr: "the passenger door", door_rl: "the rear left door", door_rr: "the rear right door",
  hood: "the hood", trunk: "the trunk" };

/** What a viewer sees of an object's parts at a frame: ["headlights on", "the driver's door open"]. */
export function stateWords(obj, frame, kind) {
  const out = [];
  const v = (ch) => partAt(obj, ch, frame);
  const has = (ch) => channelsFor(kind).includes(ch);
  if (has("headlights")) { const h = v("headlights"); if (h === "low") out.push("headlights on"); if (h === "high") out.push("headlights on full beam"); if (h === "off") out.push("headlights off"); }
  if (has("lightbar")) { const l = v("lightbar"); if (l === "flash") out.push("red and blue roof lights flashing"); if (l === "steady") out.push("roof light bar lit"); }
  if (has("indicator")) { const i = v("indicator"); if (i === "hazard") out.push("hazard lights blinking"); else if (i !== "off") out.push(`${i} turn signal blinking`); }
  if (has("brake") && v("brake") === "on") out.push("brake lights glowing red");
  if (has("navlights") && v("navlights") !== "off") out.push(v("navlights") === "strobe" ? "navigation lights and white strobes flashing" : "red and green navigation lights on");
  for (const ch of ["door_fl", "door_fr", "door_rl", "door_rr", "hood", "trunk"]) {
    if (!has(ch)) continue;
    const d = v(ch);
    if (d > 45) out.push(`${DOOR_WORDS[ch]} wide open`);
    else if (d > 8) out.push(`${DOOR_WORDS[ch]} open`);
    else if (d > 1.5) out.push(`${DOOR_WORDS[ch]} ajar`);
  }
  if (has("wipers") && v("wipers") !== "off") out.push("windscreen wipers sweeping");
  if (has("tint") && v("tint") > 0.6) out.push("dark tinted windows");
  if (has("finish")) { const f = v("finish"); if (f && f !== "factory") out.push(`${{ matte: "matte", satin: "satin", gloss: "glossy", metallic: "metallic", chrome: "mirror-chrome" }[f]} paint`); }
  if (has("dirt")) { const d = v("dirt"); if (d > 0.6) out.push("caked in mud and road dirt"); else if (d > 0.25) out.push("dusty, road-dirty paint"); }
  if (has("damage")) { const d = v("damage"); if (d > 0.08) out.push(`${d > 0.5 ? "a badly crumpled" : "a dented"} ${{ front: "front end", rear: "rear end", left: "left side", right: "right side" }[v("damage_side") || "front"]}`); }
  if (has("steer")) { const s = obj?.parts?.steer?.length ? v("steer") : 0; if (Math.abs(s) > 12) out.push(`front wheels turned hard ${s > 0 ? "left" : "right"}`); }
  if (kind === "horse") {
    const hp = v("head_pitch"), hy = v("head_yaw"), tl = v("tail_lift"), g = v("gait");
    if (hp > 15) out.push("head held high"); else if (hp < -20) out.push("head low");
    if (Math.abs(hy) > 20) out.push(`head turned to its ${hy > 0 ? "left" : "right"}`);
    if (tl > 25) out.push("tail carried high");
    if (v("tail_swish") > 0.3) out.push("tail swishing");
    if (g && g !== "auto") out.push({ idle: "standing", walk: "at a walk", trot: "trotting", canter: "cantering", gallop: "galloping" }[g]);
  }
  if (["man", "woman", "child"].includes(kind)) {
    const e = v("expression");
    if (e && e !== "neutral") out.push({ smile: "smiling", laugh: "laughing", frown: "frowning", angry: "angry", sad: "sad", surprised: "surprised",
      afraid: "afraid", disgust: "disgusted", talking: "talking", shouting: "shouting", eyes_closed: "eyes closed" }[e]);
  }
  return out;
}

/** Timed changes for the motion prompt: [{frame, words}] ("the driver's door swings open"). */
export function partEvents(obj, kind, last) {
  const out = [];
  const chs = channelsFor(kind);
  for (const ch of chs) {
    const keys = obj?.parts?.[ch];
    if (!keys || keys.length < 2) continue;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1].v, b = keys[i].v, f = keys[i - 1].i === "step" || typeof b !== "number" ? keys[i].frame : keys[i - 1].frame;
      if (a === b || f > last) continue;
      let w = null;
      if (DOOR_WORDS[ch]) w = b > a + 5 ? `${DOOR_WORDS[ch]} swings open` : a > b + 5 ? `${DOOR_WORDS[ch]} closes` : null;
      else if (ch === "headlights") w = b === "off" ? "the headlights switch off" : a === "off" || a === "auto" ? "the headlights snap on" : b === "high" ? "the headlights flick to full beam" : null;
      else if (ch === "lightbar") w = b === "off" ? "the roof lights go dark" : "the red and blue roof lights start flashing";
      else if (ch === "indicator") w = b === "off" ? "the turn signal stops" : b === "hazard" ? "the hazard lights start blinking" : `the ${b} turn signal starts blinking`;
      else if (ch === "brake") w = b === "on" ? "the brake lights flare red" : null;
      else if (ch === "wipers") w = b === "off" ? "the wipers stop" : "the wipers start sweeping";
      else if (ch === "damage") w = b > a + 0.1 ? "the body crumples" : null;
      else if (ch === "expression") w = b === "neutral" ? "the face relaxes" : `starts ${stateWords({ parts: { expression: [{ frame: 0, v: b }] } }, 0, kind)[0]}`;
      else if (ch === "gait") w = b === "auto" ? null : `breaks into a ${b === "idle" ? "halt" : b}`;
      else if (ch === "head_pitch") w = b > a + 15 ? "throws its head up" : a > b + 15 ? "drops its head" : null;
      if (w) out.push({ frame: f, ch, words: w });
    }
  }
  return out.sort((p, q) => p.frame - q.frame);
}

// ------------------------------------------------------------------ Stage integration

const LIGHT_DEF = { intensity: (l, spec) => l.intensity ?? spec.intensity, kelvin: (l, spec) => l.kelvin ?? spec.kelvin,
  angle: (l, spec) => l.angle ?? spec.angle, softness: (l, spec) => l.softness ?? spec.softness };

/**
 * Add the Parts API and per-frame hooks to the Stage class. The one hook stage.mjs calls itself is
 * _partsApply(a, g), at the end of each object's per-frame pose (after its physics, tilt and gait); the render,
 * camera and gizmo hooks are wrappers installed here.
 */
export function installParts(Stage, deps) {
  const { vehicle, light, horse, prop, LIGHT_TYPES, LIBRARY } = deps;
  const P = Stage.prototype;

  /** The thing a part id names: an object, a film light ("light:<id>") or the active shot's camera ("__camera__"). */
  P._partObj = function (id) {
    if (id === "__camera__") return { kind: "__camera__", obj: this.activeShot() };
    if (String(id).startsWith("light:")) {
      const l = (this.state.lighting?.lights || []).find((x) => x.id === String(id).slice(6));
      return l ? { kind: "__light__", obj: l } : null;
    }
    const a = this.state.actors.find((x) => x.id === id);
    return a ? { kind: a.kind, obj: a } : null;
  };

  P._subparts = function (id) {
    const g = this.actorMeshes.get(id);
    return g?.userData.subparts ? Object.keys(g.userData.subparts) : [];
  };

  /** Camera channels live in the shot's own keys: focal in camera_keys, focus / T-stop / roll in lens_keys. */
  P._camValue = function (ch, frame) {
    const sh = this.activeShot();
    if (ch === "shutter_deg") return partAt(sh, ch, frame);
    if (ch === "sensor") return sh.sensor || "ff";
    const c = this._cameraAt(frame);
    if (ch === "focal_mm") return c.focal_mm;
    if (ch === "focus_m") return c.focus_m ?? null;
    if (ch === "t_stop") return c.t_stop ?? null;
    if (ch === "roll_deg") return c.roll ? +(c.roll * 180 / Math.PI).toFixed(2) : 0;
    return undefined;
  };

  P._camKeyFrames = function (ch) {
    const sh = this.activeShot();
    if (ch === "focal_mm") return this._camKeys().map((k) => k.frame);
    if (ch === "shutter_deg") return (sh.parts?.shutter_deg || []).map((k) => k.frame);
    const field = { focus_m: "focus_m", t_stop: "t_stop", roll_deg: "roll" }[ch];
    return field ? (sh.lens_keys || []).filter((k) => k[field] != null).map((k) => k.frame) : [];
  };

  /** The value a channel plays at a frame (auto channels computed). */
  P.partValue = function (id, ch, frame = this.frame) {
    const t = this._partObj(id);
    if (!t) return undefined;
    if (t.kind === "__camera__") return this._camValue(ch, frame);
    const v = partAt(t.obj, ch, frame);
    if (v !== undefined && v !== null) return v;
    if (t.kind === "__light__") { const spec = LIGHT_TYPES[t.obj.type] || LIGHT_TYPES.key; return LIGHT_DEF[ch]?.(t.obj, spec) ?? v; }
    if (ch === "steer") return +(vehicle.autoSteerAt(this, t.obj, frame) || 0).toFixed(1);
    return v;
  };

  /** Every channel of an object for the Parts panel: [{ch, spec, value, keys: [frames], here, auto}]. */
  P.partChannels = function (id) {
    const t = this._partObj(id);
    if (!t) return [];
    const chs = channelsFor(t.kind, { subparts: this._subparts(id) });
    return chs.map((ch) => {
      const spec = specOf(ch);
      const keys = t.kind === "__camera__" ? this._camKeyFrames(ch) : (t.obj.parts?.[ch] || []).map((k) => k.frame);
      const key = t.kind === "__camera__" ? null : (t.obj.parts?.[ch] || []).find((k) => k.frame === this.frame);
      return { ch, spec, value: this.partValue(id, ch), keys, here: keys.includes(this.frame), interp: key?.i || "ease",
        auto: !!spec.auto && !keys.length, options: optionsOf(ch) };
    });
  };

  /** Set a channel. Animated channels (or opts.key) key the playhead; static ones set the value. One undo step. */
  P.setPart = function (id, ch, value, opts = {}) {
    const t = this._partObj(id);
    const spec = specOf(ch);
    if (!t || !spec) return null;
    const v = coerce(ch, value);
    if (v === null) return null;
    const frame = Math.round(opts.frame ?? this.frame);
    if (t.kind === "__camera__") this._setCamPart(ch, v, frame);
    else if (spec.static) { (t.obj.parts ||= {})[ch] = [{ frame: 0, v }]; }
    else if (t.kind === "__light__" && LIGHT_DEF[ch] && !t.obj.parts?.[ch]?.length && opts.frame == null && !opts.key) t.obj[ch] = v;   // the light's own value
    else {
      const keys = t.obj.parts?.[ch];
      // Not animated yet (like Sequencer / Maya with auto-key off): a constant for the whole shot, unless a key is
      // asked for (the key button, auto-key, or a time: "open the door at 2 s"). Once animated, edits key the playhead.
      if (!keys?.length && opts.frame == null && !opts.key) writeKey(t.obj, ch, 0, v, opts.interp);
      else {
        // Keying a channel for the first time away from frame 0: hold its current value until then.
        if (!keys?.length && frame > 0) writeKey(t.obj, ch, 0, this.partValue(id, ch, 0) ?? spec.def, spec.type === "enum" ? "step" : opts.interp);
        writeKey(t.obj, ch, frame, v, opts.interp ?? (spec.type === "enum" ? "step" : undefined));
      }
    }
    this._partsDirty(t);
    return v;
  };

  /** Several channels at once (a preset, a Director call): one undo step. */
  P.setParts = function (id, patch, opts = {}) {
    const done = {};
    this._partsBatch = true;
    try { for (const [ch, v] of Object.entries(patch || {})) { const r = this.setPart(id, ch, v, opts); if (r !== null) done[ch] = r; } }
    finally { this._partsBatch = false; }
    const t = this._partObj(id);
    if (t?.kind === "__light__") { this._buildLights?.(); if (this.selectedLight && this.lightHandles?.has(this.selectedLight)) for (const [lid, h] of this.lightHandles) h.scale.setScalar(lid === this.selectedLight ? 1.6 : 1); }
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onParts?.();
    return done;
  };

  P._setCamPart = function (ch, v, frame) {
    const sh = this.activeShot();
    const was = this.frame;
    this.frame = frame;
    if (ch === "focal_mm") { this._editCamera().focal_mm = v; }
    else if (ch === "shutter_deg") writeKey(sh, ch, frame, v);
    else if (ch === "sensor") sh.sensor = v;
    else {
      const field = { focus_m: "focus_m", t_stop: "t_stop", roll_deg: "roll" }[ch];
      const lk = (sh.lens_keys ||= []);
      let k = lk.find((x) => x.frame === frame);
      if (!k) {
        // Seed a new lens key with what plays there now, so the other lens channels don't jump.
        const c = this._cameraAt(frame);
        k = { frame, ...(c.focus_m ? { focus_m: +c.focus_m.toFixed(3) } : {}), ...(c.t_stop ? { t_stop: +c.t_stop.toFixed(2) } : {}),
          ...(c.roll ? { roll: c.roll } : {}) };
        lk.push(k);
        lk.sort((p, q) => p.frame - q.frame);
      }
      k[field] = ch === "roll_deg" ? v * Math.PI / 180 : v;
      // A lens channel used for the first time: every other lens key needs it too (they interpolate in pairs).
      for (const o of lk) if (o[field] == null) o[field] = k[field];
    }
    this.frame = was;
  };

  /** Toggle a key on the playhead: add one with the value playing now, or remove the key that is there. */
  P.keyPartHere = function (id, ch) {
    const t = this._partObj(id);
    if (!t || !specOf(ch) || specOf(ch).static) return false;
    if (t.kind === "__camera__") {
      const here = this._camKeyFrames(ch).includes(this.frame);
      if (here) this._dropCamKey(ch, this.frame); else this._setCamPart(ch, this._camValue(ch, this.frame) ?? specOf(ch).def, this.frame);
      this._partsDirty(t);
      return !here;
    }
    const keys = t.obj.parts?.[ch] || [];
    const here = keys.some((k) => k.frame === this.frame);
    if (here) dropKey(t.obj, ch, this.frame);
    else {
      const v = this.partValue(id, ch);
      writeKey(t.obj, ch, this.frame, v ?? specOf(ch).def, specOf(ch).type === "enum" ? "step" : undefined);
    }
    this._partsDirty(t);
    return !here;
  };

  P._dropCamKey = function (ch, frame) {
    const sh = this.activeShot();
    if (ch === "focal_mm") { const k = this._camKeys(); if (k.length > 1) sh.camera_keys = k.filter((x) => x.frame !== frame); }
    else if (ch === "shutter_deg") dropKey(sh, ch, frame);
    else { const field = { focus_m: "focus_m", t_stop: "t_stop", roll_deg: "roll" }[ch]; sh.lens_keys = (sh.lens_keys || []).filter((k) => k.frame !== frame || Object.keys(k).some((q) => q !== "frame" && q !== field)); }
  };

  /** Key every animatable channel of an object at the playhead (K). */
  P.keyAllParts = function (id) {
    const t = this._partObj(id);
    if (!t || t.kind === "__camera__") return 0;
    let n = 0;
    for (const c of this.partChannels(id)) {
      if (c.spec.static || c.here || c.value === undefined || c.value === null) continue;
      writeKey(t.obj, c.ch, this.frame, c.value, c.spec.type === "enum" ? "step" : undefined);
      n++;
    }
    this._partsDirty(t);
    return n;
  };

  P.clearPart = function (id, ch) {
    const t = this._partObj(id);
    if (!t) return false;
    const ok = t.kind === "__camera__" ? false : clearChannel(t.obj, ch);
    this._partsDirty(t);
    return ok;
  };

  P.setPartInterp = function (id, ch, interp) {
    const t = this._partObj(id);
    const k = t?.obj.parts?.[ch]?.find((x) => x.frame === this.frame);
    if (!k) return false;
    if (interp === "ease") delete k.i; else k.i = interp;
    this._partsDirty(t);
    return true;
  };

  /** Jump to the previous (-1) / next (+1) key of one channel. */
  P.gotoPartKey = function (id, ch, dir) {
    const c = this.partChannels(id).find((x) => x.ch === ch);
    const f = dir > 0 ? c?.keys.find((x) => x > this.frame) : [...(c?.keys || [])].reverse().find((x) => x < this.frame);
    if (f !== undefined) this.setFrame(f);
    return f;
  };

  P._partsDirty = function (t) {
    if (this._partsBatch) return;   // setParts: one setFrame, one change, one undo step at the end
    if (t?.kind === "__light__") { this._buildLights?.(); if (this.selectedLight && this.lightHandles?.has(this.selectedLight)) for (const [lid, h] of this.lightHandles) h.scale.setScalar(lid === this.selectedLight ? 1.6 : 1); }
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onParts?.();
  };

  /** Cheap change signature of one target's parts (the panel refreshes when it changes). */
  P._partsSig = function (id) {
    const t = this._partObj(id);
    if (!t) return "";
    if (t.kind === "__camera__") return JSON.stringify([t.obj.camera_keys?.length, t.obj.lens_keys, t.obj.parts, t.obj.sensor]);
    if (t.kind === "__light__") return JSON.stringify([t.obj.parts, t.obj.intensity, t.obj.kelvin, t.obj.angle, t.obj.softness]);
    return JSON.stringify([t.obj.parts, t.obj.gaze, this.state.actors.find((x) => x.carry_id === id)?.id]);
  };

  /** Props a person could hold (not people, animals, vehicles or set pieces). */
  P.holdableIds = function (personId) {
    return this.state.actors.filter((x) => x.id !== personId && !x.mount_id && LIBRARY[x.kind]?.rig !== "vehicle" && !["biped", "quadruped"].includes(LIBRARY[x.kind]?.rig)
      && !["house", "tree", "wall", "flat", "lamp", "building"].includes(x.kind) && !this._isSetPiece?.(x.id)).map((x) => x.id);
  };

  /** A prop in a person's hands from the playhead on (null: their hands are empty). Returns the prop's name. */
  P.holdProp = function (personId, propId) {
    for (const o of this.state.actors) if (o.carry_id === personId && o.id !== propId) { delete o.carry_id; delete o.carry_at; }
    const o = propId && this.state.actors.find((x) => x.id === propId);
    if (o) { o.carry_id = personId; o.carry_at = Math.max(8, this.frame); }
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    this.onParts?.();
    return o ? o.name || LIBRARY[o.kind]?.label || o.kind : null;
  };

  /** Words for the prompt and the Director: visible state of every object at a frame. */
  P.partsPrompt = function (frame = this.frame) {
    const out = [];
    for (const a of this.state.actors) {
      const w = stateWords(a, frame, a.kind).filter((x) => !/^headlights off$/.test(x) || a.parts?.headlights);
      if (w.length) out.push(`the ${(a.name || LIBRARY[a.kind]?.label || a.kind).toLowerCase()}: ${w.join(", ")}`);
    }
    return out.join("; ");
  };

  /** Timeline rows for the selected object's (or light's) animated channels. */
  P.partRows = function (ownerId) {
    const t = this._partObj(ownerId);
    if (!t || t.kind === "__camera__" || !t.obj.parts) return [];
    return Object.entries(t.obj.parts).filter(([ch, keys]) => keys?.length && specOf(ch) && !specOf(ch).static).map(([ch, keys]) => ({
      kind: "part", id: `part:${ownerId}:${ch}`, ownerId, ch, name: `↳ ${specOf(ch).label}`, keys, color: "#8bd4a8",
      drop: (k) => { dropKey(t.obj, ch, k.frame); },
      addKey: (f) => { const was = this.frame; this.frame = f; writeKey(t.obj, ch, f, this.partValue(ownerId, ch, f) ?? specOf(ch).def, specOf(ch).type === "enum" ? "step" : undefined); this.frame = was; },
    }));
  };

  // ---- per-frame hooks
  P._partsApply = function (a, g) {
    try {
      const rig = LIBRARY[a.kind]?.rig;
      if (rig === "vehicle") vehicle.apply(this, a, g);
      else if (a.kind === "horse") horse.apply(this, a, g);
      if (rig !== "vehicle" && !["man", "woman", "child", "horse"].includes(a.kind)) prop.apply(this, a, g);
    } catch (err) { if (!this._partsWarned) { this._partsWarned = true; console.warn("Soundstage parts", err); } }
  };
  // Wrapped, not edited: before every render the film lights take their keyed values and lit lamps leave the clay
  // override; after the camera is placed, the sensor crops the lens; a translate drag ignores the pivot shift.
  const render0 = P._renderMode;
  P._renderMode = function (mode, forCapture = false) {
    try { light.apply(this); } catch (err) { if (!this._partsWarnedL) { this._partsWarnedL = true; console.warn("Soundstage light rig", err); } }
    try { vehicle.pass(this, mode); } catch (err) { if (!this._partsWarnedO) { this._partsWarnedO = true; console.warn("Soundstage lamp pass", err); } }
    return render0.call(this, mode, forCapture);
  };
  const cam0 = P._applyCamera;
  P._applyCamera = function (...args) {
    const r = cam0.apply(this, args);
    const crop = this._sensorCrop();
    if (crop !== 1 && this.camera) {
      this.camera.fov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) / crop) * 180 / Math.PI;
      this.camera.updateProjectionMatrix();
    }
    return r;
  };
  const giz0 = P._gizmoToActor;
  if (giz0) P._gizmoToActor = function (...args) {
    const g = this.tc?.object, sh = g?.userData?.pivotShift;
    if (sh && this.gizmoMode === "translate") g.position.sub(sh);
    return giz0.apply(this, args);
  };
  /** Sensor crop: the FOV of the shot's lens on its sensor, as a full-frame focal length. */
  P._sensorCrop = function () {
    const s = this.activeShot?.()?.sensor;
    return s && SENSOR_W[s] ? 36 / SENSOR_W[s] : 1;
  };
}
