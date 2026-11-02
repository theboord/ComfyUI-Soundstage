// Soundstage lighting: a solar-accurate time of day plus a kit of placeable film lights.
// The sun position comes from hour + day of year + latitude (NOAA-style approximation), so
// "Magic hour" means the sun really sits a few degrees above the horizon for that place and date.
import * as THREE from "../vendor/three.module.min.mjs";

export const TIME_PRESETS = {
  dawn: { label: "Dawn", sunElevation: -3, side: "east" },
  golden_am: { label: "Golden hour AM", sunElevation: 6, side: "east" },
  midday: { label: "Midday", sunElevation: null, side: "noon" },
  overcast: { label: "Overcast", sunElevation: null, side: "noon", overcast: true },
  magic_hour: { label: "Magic hour", sunElevation: 3, side: "west" },
  blue_hour: { label: "Blue hour", sunElevation: -4, side: "west" },
  night: { label: "Night (moonlight)", sunElevation: -18, side: "west" },
};

export const LIGHT_TYPES = {
  key: { label: "Key", kelvin: 4300, intensity: 3.2, height: 2.6, angle: 40, softness: 0.6 },
  fill: { label: "Fill", kelvin: 5200, intensity: 1.0, height: 1.8, angle: 60, softness: 0.9 },
  rim: { label: "Rim / back", kelvin: 5600, intensity: 2.6, height: 2.8, angle: 30, softness: 0.4 },
  practical: { label: "Practical (lamp)", kelvin: 2700, intensity: 1.4, height: 1.4, angle: 180, softness: 1.0 },
  spot: { label: "Spot", kelvin: 3200, intensity: 4.0, height: 4.0, angle: 18, softness: 0.2 },
  neon: { label: "Neon", kelvin: 12000, intensity: 1.6, height: 2.2, angle: 180, softness: 1.0 },
};

const D2R = Math.PI / 180;

/** Sun azimuth (deg, clockwise from north) and elevation (deg) for a local solar hour. */
export function solarPosition(hour, dayOfYear = 300, latitude = 34.05) {
  const decl = -23.44 * Math.cos(((360 / 365) * (dayOfYear + 10)) * D2R);
  const ha = (hour - 12) * 15; // hour angle, degrees
  const lat = latitude * D2R, dec = decl * D2R, h = ha * D2R;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(dec) - Math.sin(el) * Math.sin(lat)) / (Math.cos(el) * Math.cos(lat));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / D2R;
  if (ha > 0) az = 360 - az;
  return { azimuth: az, elevation: el / D2R };
}

/** Find the local hour (morning or evening) when the sun reaches a given elevation. */
export function hourForElevation(targetEl, side, dayOfYear = 300, latitude = 34.05) {
  if (side === "noon") return 12.5;
  let best = side === "east" ? 7 : 17.5, bestErr = 1e9;
  const [a, b] = side === "east" ? [3, 12] : [12, 22];
  for (let h = a; h <= b; h += 0.02) {
    const err = Math.abs(solarPosition(h, dayOfYear, latitude).elevation - targetEl);
    if (err < bestErr) { bestErr = err; best = h; }
  }
  return +best.toFixed(2);
}

/** Black-body colour (approximate) for a colour temperature in kelvin. */
export function kelvinToColor(k) {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  return new THREE.Color(c(r), c(g), c(b));
}

/** Sun + sky settings for an elevation: colour temperature, intensity, sky and ground fill. */
export function skyFor(elevation, overcast = false) {
  if (overcast) return { phase: "overcast", sunK: 6500, sun: 0.35, sky: 1.25, skyK: 7000, ground: 0x5a5a5a, shadowSoft: 1 };
  if (elevation < -12) return { phase: "night", sunK: 4100, sun: 0.18, sky: 0.25, skyK: 12000, ground: 0x10141c, shadowSoft: 0.5, moon: true };
  if (elevation < -2) return { phase: "blue hour", sunK: 9000, sun: 0.0, sky: 0.55, skyK: 14000, ground: 0x1c2333, shadowSoft: 1 };
  if (elevation < 0.5) return { phase: "dawn/dusk", sunK: 2000, sun: 0.6, sky: 0.6, skyK: 9000, ground: 0x2a2630, shadowSoft: 0.7 };
  if (elevation < 8) return { phase: "magic hour", sunK: 2300 + elevation * 120, sun: 1.6, sky: 0.7, skyK: 8000, ground: 0x3a3028, shadowSoft: 0.35 };
  if (elevation < 20) return { phase: "golden hour", sunK: 3400 + (elevation - 8) * 120, sun: 2.2, sky: 0.85, skyK: 7500, ground: 0x3d3a34, shadowSoft: 0.25 };
  return { phase: "daylight", sunK: 5600, sun: 2.6, sky: 0.95, skyK: 7000, ground: 0x3a3a3a, shadowSoft: 0.15 };
}

/** Clock text for an hour value, e.g. 18.4 -> "18:24". */
export function clock(hour) {
  const h = Math.floor(hour), m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m === 60 ? 0 : m).padStart(2, "0")}`;
}

/**
 * Plain-language lighting for prompts, written like a DP's note.
 * cam: {position, target} of the shot camera; sun: {azimuth_deg, elevation_deg} in stage terms.
 */
export function describeLighting(lighting, sun, cam) {
  const parts = [];
  const sky = skyFor(sun.elevation_deg, lighting?.overcast);
  const phase = { "magic hour": "magic hour", "golden hour": "golden hour", daylight: "bright daylight",
    "blue hour": "blue hour twilight", "dawn/dusk": "first light at the horizon", night: "night, cool moonlight",
    overcast: "soft overcast daylight" }[sky.phase];
  parts.push(phase);
  // At night the key is the moon (skyFor's sun > 0 with moon): no "low sun 0° above the horizon, 4100K warm sunlight"
  // after "night, cool moonlight" (QA round 07: it put a sunset glow on the horizon of a night draft).
  if (sky.sun > 0 && !sky.moon && cam) {
    // Where the sun comes from relative to the camera: front, side, back; left or right.
    const az = sun.azimuth_deg * D2R;
    const sunDir = new THREE.Vector3(Math.sin(az), 0, Math.cos(az));
    const view = new THREE.Vector3(cam.target[0] - cam.position[0], 0, cam.target[2] - cam.position[2]).normalize();
    const right = new THREE.Vector3(view.z, 0, -view.x);
    const f = sunDir.dot(view), r = sunDir.dot(right);
    const where = f > 0.5 ? "behind the subjects (backlight, rim on hair and shoulders)" :
      f < -0.5 ? "behind the camera (front light)" : `from camera ${r > 0 ? "right" : "left"} (side light, long shadows)`;
    parts.push(`low sun ${Math.max(0, Math.round(sun.elevation_deg))}° above the horizon ${where}`.replace(/^low sun (\d{2,})/, "sun $1"));
    parts.push(`${Math.round(sky.sunK / 100) * 100}K ${sky.sunK < 3500 ? "warm amber" : sky.sunK < 5000 ? "warm" : "neutral"} sunlight`);
  }
  for (const l of lighting?.lights || []) {
    const t = LIGHT_TYPES[l.type]?.label.toLowerCase() || l.type;
    const tone = l.kelvin < 3300 ? "warm tungsten" : l.kelvin > 9000 ? "cool blue" : l.kelvin > 6000 ? "cool" : "neutral";
    parts.push(`${tone} ${t}${l.softness > 0.7 ? ", soft" : l.softness < 0.3 ? ", hard" : ""}`);
  }
  // Five street lamps of one kind are one phrase, not "warm tungsten practical" five times over in the prompt.
  return [...new Set(parts)].join(", ");
}
