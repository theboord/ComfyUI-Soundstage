// A small, ORIGINAL sample screenplay, already parsed into the Script model (see parse.mjs), so the offline App demo
// can show the Script panel without a server or a file. Four scenes that match the demo's stage scenes: riders at
// sunset in the desert, a police car chasing a sports car down a night street, inside the car, a beach at sunset.
// Written for Soundstage; the names are placeholders. Director's notes are left empty: they belong to the user.
//
//   import { DEMO_SCRIPT, demoScript } from "./script/demo_script.mjs";
//   panel host: getScript: () => script ?? (script = demoScript())   // demoScript() is a fresh copy to edit

// Element shorthands; dialogue and parentheticals carry the speaker like the parser's output.
const A = (text) => ({ type: "action", text });
const C = (character, ext = "") => ({ type: "character", text: ext ? `${character} ${ext}` : character, character });
const P = (character, text) => ({ type: "parenthetical", text, character });
const D = (character, text) => ({ type: "dialogue", text, character });
const T = (text) => ({ type: "transition", text });

const NO_BREAKDOWN = { cast: [], extras: [], props: [], vehicles: [], animals: [], wardrobe: [], sfx: [], sound: [], music: [],
  set_dressing: [], stunts: [] };
const breakdown = (b) => ({ ...structuredClone(NO_BREAKDOWN), ...b });

const SCENES = [
  {
    id: "sc_1", number: "1", heading: "EXT. DESERT OUTSIDE DRY CREEK - DUSK", int_ext: "EXT", location: "DESERT OUTSIDE DRY CREEK",
    time: "DUSK", index: 0, eighths: 10,
    elements: [
      A("Heat shimmer over the scrub. The sun sits low and orange on the ridge line."),
      A("Two RIDERS walk their horses in from opposite directions and stop forty paces apart."),
      A("EZRA HALE (60s, sheriff's star long since pawned) rests a hand near his holster. Across from him, MARA VOSS (30s, dust-caked duster) does not blink."),
      C("EZRA"), D("EZRA", "You rode a long way to stand in the dirt."),
      C("MARA"), P("MARA", "(evenly)"), D("MARA", "I rode a long way for the key, Ezra. That car was my father's."),
      A("Wind HOWLS across the flats. A HAWK cries somewhere overhead."),
      C("EZRA"), D("EZRA", "Then come and take it."),
      A("He tosses a brass KEY into the dirt between them. Neither draws. Mara spurs her horse forward, leans down at a gallop and snatches it up."),
      T("CUT TO:"),
    ],
    characters: ["EZRA", "MARA"],
    synopsis: "Mara faces down the old sheriff for her father's car key.",
    outline: "Heat shimmer over the scrub. The sun sits low and orange on the ridge line. Two riders walk their horses in from opposite directions and stop forty paces apart.",
    breakdown: breakdown({ cast: ["EZRA", "MARA"], props: ["holster", "sheriff's star", "brass key"], animals: ["horses", "hawk"],
      wardrobe: ["duster"], sfx: ["heat shimmer"], sound: ["wind howls", "hawk cries"], set_dressing: ["scrub"], stunts: ["gallop pick-up"] }),
    stage_hint: { set: "desert", time_of_day: "dusk", weather: null, objects: ["horse"] },
    notes: "",
  },
  {
    id: "sc_2", number: "2", heading: "EXT. DRY CREEK - MAIN STREET - NIGHT", int_ext: "EXT", location: "DRY CREEK - MAIN STREET",
    time: "NIGHT", index: 1, eighths: 5,
    elements: [
      A("Rain slicks the empty street. A vintage SPORTS CAR tears past the shuttered storefronts, headlights blazing."),
      A("A POLICE CAR swings out of a side road behind it, SIREN WAILING, lights strobing red and blue across the wet asphalt."),
      A("A few late PATRONS spill out of the bar to watch."),
      C("DEPUTY COLE", "(V.O.)"), P("DEPUTY COLE", "(over the radio)"), D("DEPUTY COLE", "Unit four in pursuit, eastbound on Main. She's running without plates."),
    ],
    characters: ["DEPUTY COLE"],
    synopsis: "",
    outline: "Rain slicks the empty street. A vintage sports car tears past the shuttered storefronts, headlights blazing.",
    breakdown: breakdown({ cast: ["DEPUTY COLE"], extras: ["patrons"], props: ["police radio"], vehicles: ["sports car", "police car"],
      sfx: ["rain"], sound: ["siren wailing"], set_dressing: ["shuttered storefronts", "bar"], stunts: ["car chase"] }),
    stage_hint: { set: "street_night", time_of_day: "night", weather: "rain", objects: ["sports_car", "police_car"] },
    notes: "",
  },
  {
    id: "sc_2A", number: "2A", heading: "INT. SPORTS CAR (MOVING) - CONTINUOUS", int_ext: "INT", location: "SPORTS CAR (MOVING)",
    time: "CONTINUOUS", index: 2, eighths: 4,
    elements: [
      A("Mara grips the wheel, knuckles white. The brass key swings from the ignition."),
      A("The radio plays \"Blue Desert Rain\", an old country song, far too loud."),
      C("MARA"), D("MARA", "Come on, old girl."),
      A("She kills the headlights and cuts hard into an alley. Behind her, the police car ROARS straight past the turn."),
      A("Mara lets out a breath. Turns the music down."),
    ],
    characters: ["MARA"],
    synopsis: "",
    outline: "Mara grips the wheel, knuckles white. The brass key swings from the ignition.",
    breakdown: breakdown({ cast: ["MARA"], props: ["brass key", "car radio"], vehicles: ["sports car", "police car"],
      sound: ["engine roars"], music: ["\"Blue Desert Rain\""], stunts: ["hard turn into alley"] }),
    stage_hint: { set: "street_night", time_of_day: "night", weather: "rain", objects: ["sports_car", "police_car"] },
    notes: "",
  },
  {
    id: "sc_3", number: "3", heading: "EXT. PACIFIC BEACH - SUNSET", int_ext: "EXT", location: "PACIFIC BEACH", time: "SUNSET",
    index: 3, eighths: 6,
    elements: [
      A("Waves fold onto wet sand. The sports car sits at the edge of the dunes, still caked in desert dust."),
      A("Mara walks barefoot along the waterline, boots in one hand, the brass key in the other. A FEW SURFERS paddle out beyond the break. Gulls wheel overhead."),
      A("She stops. Looks at the key for a long moment."),
      C("MARA", "(V.O.)"), D("MARA", "Some things you carry. Some things you set down."),
      A("She throws the key into the surf and keeps walking."),
      T("FADE OUT."),
    ],
    characters: ["MARA"],
    synopsis: "Mara lets the key go.",
    outline: "Waves fold onto wet sand. The sports car sits at the edge of the dunes, still caked in desert dust.",
    breakdown: breakdown({ cast: ["MARA"], extras: ["surfers"], props: ["brass key", "boots"], vehicles: ["sports car"],
      animals: ["gulls"], wardrobe: ["barefoot"], sound: ["waves"], set_dressing: ["dunes"] }),
    stage_hint: { set: "beach", time_of_day: "dusk", weather: null, objects: ["sports_car", "bird"] },
    notes: "",
  },
];

export const DEMO_SCRIPT = {
  version: 1,
  title: "Last Light on Route 9",
  author: "Jane Doe",
  format: "fountain",
  source_name: "last_light_on_route_9.fountain",
  // Numbered like a production draft, so a revised draft matches scenes by number (parse.mjs mergeNotes).
  scenes: SCENES.map((sc) => ({ ...sc, numbered: true, section: "" })),
  characters: [
    { name: "MARA", scenes: ["sc_1", "sc_2A", "sc_3"], lines: 3 },
    { name: "EZRA", scenes: ["sc_1"], lines: 2 },
    { name: "DEPUTY COLE", scenes: ["sc_2"], lines: 1 },
  ],
  page_count_est: 3,
  warnings: [],
};

/** A fresh deep copy of the sample, safe to edit (notes) and persist. */
export const demoScript = () => structuredClone(DEMO_SCRIPT);
