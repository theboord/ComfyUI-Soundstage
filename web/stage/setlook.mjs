// The real colours of every set, for the Color pass (README media v2 QC, 2026-11-02).
//
// The Color pass is the picture the ④ Frame still is painted from, so the ground and the backdrop must already carry
// their real colour there: the desert western came out of it flat grey-blue (the ground and the dunes were the clay
// default #9a9a9a under a blue sky light) and FLUX painted a grey-blue desert. Clay, Depth and the ID matte never see
// these colours (Clay and Depth override every material, the ID pass paints ids), so only the Color pass changes.
//
// Colours are sRGB albedos a camera would see in daylight: dry sand ~0.45-0.55 reflectance, grass ~0.2, worn asphalt
// ~0.08-0.1 (darker reads as a black hole at night), fresh snow ~0.85. The desert sand is the dust colour the hooves and tyres already throw
// (particles.mjs desert_sand), so the dust and the ground it comes off are the same sand.
import { GROUND_PRESETS } from "./particles.mjs";

const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

/** The desert's sand, shared with the dust it throws up. */
export const SAND = hex(GROUND_PRESETS.desert_sand.dust.color);
/** Fresh snow lying on the ground (weather "snow" on an outdoor set). */
export const SNOW = "#e9edf1";

/**
 * Per set: ground (the floor plane), dress (the backdrop and set dressing, by role), water (the surface colour in
 * the Color pass), reach (how many times the 80 m floor is scaled so open land runs out to the horizon instead of
 * stopping 40 m out against the sky colour), indoor (no snow cover).
 */
export const SET_LOOK = Object.freeze({
  plaza: { ground: "#8e8a83", dress: { building: "#a59b8d", post: "#3f4246", box: "#8d8478" } },                 // concrete paving, stone
  street_night: { ground: "#54565a", dress: { facade: "#71655b", kerb: "#8b8882", post: "#3c3f43" } },          // asphalt, brick, concrete kerbs
  interior: { ground: "#7a5a3d", indoor: true, dress: { wall: "#d9d2c5", ceiling: "#e8e4dc", window: "#b9c8d4", door: "#6b4a30" } },
  studio: { ground: "#dcdcdc", indoor: true, dress: { cyc: "#e4e4e4" } },                                        // painted cyc
  forest: { ground: "#4b4930", reach: 8, dress: { trunk: "#4a3727", canopy: "#2d4a2a" } },                      // leaf litter and moss
  desert: { ground: SAND, reach: 12, dress: { dune: "#c9a576" } },
  beach: { ground: "#d4bc90", reach: 12, water: "#2f6c7a" },                                                     // dry beach sand, sea
  water_tank: { ground: "#9db6bc", indoor: true, dress: { wall: "#c7d5d9" }, water: "#4f98aa" },                  // pale tiled tank
  open_water: { ground: "#8b7b58", reach: 12, dress: { headland: "#5b6447" }, water: "#285a6c" },               // seabed, green headlands
  lake: { ground: "#6b6450", reach: 12, water: "#2f5a5c" },                                                      // silty lakebed, green-brown lake water
  river_rapids: { ground: "#7a7466", reach: 8, water: "#456f6b" },                                               // cobbled riverbed, clear snowmelt
  stadium: { ground: "#3e6a2d", reach: 8, dress: { field: "#3e6a2d", dirt: "#9b6b44", infield: "#4b7b35", base: "#f1f1ee",
    mound: "#a06f46", stand: "#71767c", tower: "#8b8f94", lamp: "#ece8db" } },                                  // grass, clay infield, concrete
  underwater: { ground: "#b8a67e" },                                                                              // the reef's sand floor
  burning_building: { ground: "#4f4d4a" },                                                                        // night asphalt
  airplane_cabin: { ground: "#4a4b4d", indoor: true },                                                           // the next four hide the floor
  runway: { ground: "#4a4b4d" },
  above_clouds: { ground: "#4a4b4d" },
  train_car: { ground: "#4a4b4d", indoor: true },
  train_station: { ground: "#5d5d5b" },
  empty: { ground: "#8c8c8c", indoor: true },                                                                    // a neutral stage floor
  void: { ground: "#000000", indoor: true },                                                                     // no floor at all (hidden)
});

const CLAY = "#9a9a9a";

/** The floor colour of a set in the Color pass; snow lies on every outdoor set when it snows. */
export function groundColor(env = {}) {
  const look = SET_LOOK[env.set || "plaza"];
  if (env.weather === "snow" && look && !look.indoor && env.set !== "underwater") return SNOW;
  return look?.ground || CLAY;
}

/** The colour of one role of set dressing (dunes, trunks, facades...), or undefined for the clay default. */
export function dressColor(set, role) {
  return SET_LOOK[set || "plaza"]?.dress?.[role];
}

/** The water surface colour of a set in the Color pass (null: the default grey-blue). */
export function waterColor(set) {
  return SET_LOOK[set || "plaza"]?.water || null;
}

/** How many times the 80 m floor is scaled out (open land to the horizon); 1 for enclosed sets. */
export function groundReach(set) {
  return SET_LOOK[set || "plaza"]?.reach || 1;
}
