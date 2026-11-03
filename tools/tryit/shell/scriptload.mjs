// Load a script in the try-it demo: the bundled sample scripts, pasted text turned into a file the App's own importer
// reads, and the closest recorded example for a shot the demo never rendered (a scene from the visitor's script).
// The breakdown itself is the real App code (web/script/parse.mjs + breakdown.mjs, run in the browser); nothing here
// parses a script. Pure (no DOM), so tests/js/tryit_scriptload.test.mjs checks it in Node.

// The samples are original short scripts written for Soundstage (free to use). The host serves web media types only,
// so the text formats ship as .txt and the shell names the File the way the importer expects (.fountain, .fdx).
export const SAMPLES = [
  { id: "low_tide", title: "Low Tide", format: "Fountain", file: "samples/low_tide.fountain.txt", name: "low_tide.fountain",
    type: "text/plain", blurb: "A beach at sunset, a diner in the rain, a cliff-road chase. 4 scenes." },
  { id: "night_train", title: "The Night Train", format: "Final Draft (.fdx)", file: "samples/night_train.fdx.txt", name: "night_train.fdx",
    type: "application/xml", blurb: "A train carriage, a foggy platform, a pine forest at night. 3 scenes." },
  { id: "brush_fire", title: "Brush Fire", format: "PDF", file: "samples/brush_fire.pdf", name: "brush_fire.pdf",
    type: "application/pdf", blurb: "A desert highway, a burning hotel, an airplane cabin. 3 scenes, read from the PDF's text in your browser." },
];

/** Pasted text -> the file name that sends it down the right importer path: Final Draft XML, else Fountain. */
export function pastedName(text) {
  return /<FinalDraft[\s>]/i.test(String(text || "").slice(0, 4000)) ? "pasted.fdx" : "pasted.fountain";
}

// ---------------------------------------------------------------- the closest recorded example
// A shot from the visitor's own script was never rendered, so ④ Frame and ⑤ Motion replay the recorded render of the
// demo scene whose set is closest, and say so (provenance.mjs exampleNote). Set ids are the stage's (SETS in
// web/stage/environments.mjs and the Milestone 11 sets in web/stage/sets/). Every entry must name a shot with recorded
// renders in tools/tryit/scenes/<scene>.json (the test checks).
export const EXAMPLES = {
  desert: { scene: "western", shot: "shot_1", label: "Western: riders on horses" },
  beach: { scene: "romance", shot: "silhouette", label: "Romance: beach at sunset" },
  forest: { scene: "horror", shot: "close", label: "Horror: haunted woods" },
  underwater: { scene: "underwater", shot: "sc_1__shot_1", label: "Underwater reef" },
  water_tank: { scene: "underwater", shot: "sc_1__shot_1", label: "Underwater reef" },
  lake: { scene: "lake", shot: "boat_a", label: "Lake: speedboat run" },
  open_water: { scene: "lake", shot: "boat_a", label: "Lake: speedboat run" },
  burning_building: { scene: "fire", shot: "sc_1__shot_1", label: "Burning building" },
  airplane_cabin: { scene: "airplane", shot: "sc_1__shot_1", label: "Airplane cabin" },
  train_car: { scene: "train", shot: "sc_1__shot_1", label: "Train carriage" },
};
// The street at night: a car chase when the scene has a vehicle, else the chase's crane wide of the street.
export const STREET_CAR = { scene: "chase", shot: "tracking", label: "Night car chase" };
export const STREET = { scene: "chase", shot: "crane", label: "Night car chase" };
// No recorded render on a set like this one (an interior, a platform, a runway...): the nearest in kind.
export const NEAREST = {
  interior: { scene: "train", shot: "sc_1__shot_1", label: "Train carriage" },
  train_station: { scene: "train", shot: "sc_1__shot_1", label: "Train carriage" },
  runway: { scene: "airplane", shot: "sc_1__shot_1", label: "Airplane cabin" },
  above_clouds: { scene: "airplane", shot: "sc_1__shot_1", label: "Airplane cabin" },
};
const VEHICLE = /^(car|truck|police_car|sports_car|hatchback|motorcycle|bicycle)$/;

/** The stage (stage.toJSON()) -> {scene, shot, label, set, exact}: the recorded example to replay for a shot that has none. */
export function closestExample(state) {
  const set = state?.environment?.set || "street_night";
  const hasCar = (state?.actors || []).some((a) => VEHICLE.test(a?.kind || ""));
  if (EXAMPLES[set]) return { ...EXAMPLES[set], set, exact: true };
  if (set === "street_night") return { ...(hasCar ? STREET_CAR : STREET), set, exact: true };
  return { ...(NEAREST[set] || (hasCar ? STREET_CAR : STREET)), set, exact: false };
}

/** A script's identity, to tell the visitor's own script from the one a demo scene shipped with. */
export function scriptSig(saved) {
  const s = saved?.script;
  if (!s?.scenes?.length) return "";
  return JSON.stringify([s.title || "", s.source_name || "", s.scenes.length, s.scenes.map((x) => x.heading || "")]);
}
