// Soundstage Script import: the scene breakdown and the stage hint, lifted from the words on the page.
// Everything here is extractive keyword work (no model, nothing written): what a 1st AD marks up with highlighters
// (cast, extras, props, vehicles, animals, wardrobe, SFX, sound, music, set dressing, stunts) and what the 3D stage needs
// to start a set (set id, time of day, weather, library objects). Pure functions, no DOM.
import { LIBRARY, resolveKind } from "../stage/library.mjs";

export const CATEGORIES = ["cast", "extras", "props", "vehicles", "animals", "wardrobe", "sfx", "sound", "music", "set_dressing", "stunts"];

export function emptyBreakdown() {
  return Object.fromEntries(CATEGORIES.map((c) => [c, []]));
}

// ---------------------------------------------------------------------------------------------- stage tables

/** Stage set ids: mirror of SETS in soundstage/agent/catalog.py. */
export const SET_IDS = ["plaza", "street_night", "interior", "studio", "forest", "desert", "beach", "water_tank", "open_water", "stadium", "empty"];

/** Copied from SET_WORDS in soundstage/agent/catalog.py (first match wins; specific before generic). Keep in sync. */
export const SET_WORDS = [
  ["water_tank", ["underwater", "water tank", "tank", "pool", "submerged", "diver", "scuba"]],
  ["beach", ["beach", "shore", "seaside", "surf", "coast", "pier", "sand"]],
  ["open_water", ["open water", "out on the water", "on the water", "out at sea", "at sea", "ocean", "sea", "lake",
    "water", "boat", "sailboat", "sailing", "catamaran", "jet ski", "jetski", "yacht", "speedboat", "fishing"]],
  ["stadium", ["stadium", "ballpark", "ballfield", "baseball", "football field", "soccer field", "pitch", "arena", "field",
    "bleachers", "home plate", "pitcher", "batter", "touchdown", "goal"]],
  ["studio", ["studio", "green screen", "greenscreen", "cyc", "product shot", "photo shoot", "soundstage"]],
  ["forest", ["forest", "woods", "jungle", "trees", "woodland", "glade"]],
  ["desert", ["desert", "dunes", "wasteland", "badlands", "sahara"]],
  ["interior", ["office", "diner", "living room", "bedroom", "kitchen", "apartment", "room", "bar", "restaurant",
    "cafe", "café", "motel", "hallway", "corridor", "precinct", "classroom", "couch", "sofa", "inside",
    "interior", "int.", "saloon", "booth", "lobby", "loft", "basement", "attic", "hospital"]],
  ["empty", ["rooftop", "roof", "void", "empty stage", "black void", "nowhere"]],
  ["street_night", ["street", "alley", "road", "avenue", "boulevard", "main street", "town", "city", "downtown",
    "sidewalk", "crosswalk", "western", "intersection"]],
  ["plaza", ["plaza", "square", "courtyard", "piazza", "campus", "park", "outside a building"]],
];

/** WEATHER_WORDS from soundstage/agent/catalog.py, rain/snow/fog only. "wet" and "winter" are dropped: in screenplay
 *  prose they are usually about hair or the calendar, not the sky. */
export const WEATHER_WORDS = [
  ["rain", ["rain", "rainy", "raining", "storm", "downpour", "drizzle"]],
  ["snow", ["snow", "snowy", "snowing", "blizzard"]],
  ["fog", ["fog", "foggy", "mist", "misty", "haze", "hazy"]],
];

// Heading time -> stage time of day. Dawn/dusk are tested before day/night ("PRE-DAWN", "NIGHTFALL").
const HEADING_TIMES = [
  ["dawn", /\b(PRE-?DAWN|DAWN|SUNRISE|DAYBREAK|FIRST LIGHT)\b/],
  ["dusk", /\b(DUSK|SUNSET|SUNDOWN|EVENING|TWILIGHT|NIGHTFALL|MAGIC HOUR|GOLDEN HOUR|BLUE HOUR)\b/],
  ["night", /\b(NIGHT|MIDNIGHT|NIGHTTIME|LATE NIGHT)\b/],
  ["day", /\b(DAY|DAYTIME|MORNING|AFTERNOON|NOON|MIDDAY|HIGH NOON)\b/],
];
// Action-text fallback: only unambiguous words (the catalog's TIME_WORDS also has "dark", "bright", "day", which misfire on prose).
const ACTION_TIMES = [
  ["dawn", ["dawn", "sunrise", "daybreak", "first light"]],
  ["dusk", ["dusk", "sunset", "sundown", "twilight", "nightfall"]],
  ["night", ["midnight", "moonlight", "moonlit", "night sky"]],
  ["day", ["noon", "midday", "high noon", "broad daylight"]],
];

const wordRes = new Map();
/** Same matching rule as _has() in soundstage/agent/plan.py: the phrase, not inside a longer word. */
export function hasWord(text, w) {
  let re = wordRes.get(w);
  if (!re) wordRes.set(w, (re = new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`)));
  return re.test(text);
}

export function pickFrom(table, text) {
  const t = String(text || "").toLowerCase();
  for (const [key, words] of table) if (words.some((w) => hasWord(t, w))) return key;
  return null;
}

/** "NIGHT" -> "night"; CONTINUOUS / LATER / "" -> null (the caller carries the previous scene's time). */
export function timeOfDay(time) {
  const t = String(time || "").toUpperCase();
  for (const [key, re] of HEADING_TIMES) if (re.test(t)) return key;
  return null;
}

const EXTERIOR_SETS = new Set(["street_night", "plaza", "forest", "desert", "beach", "open_water", "stadium"]);

const INHERIT_TIME = /^(|CONTINUOUS|LATER|MOMENTS LATER|A MOMENT LATER|SECONDS LATER|MINUTES LATER|SAME|SAME TIME|SIMULTANEOUS)$/;

// ---------------------------------------------------------------------------------------------- breakdown tables

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// [label, [words]] -> [label, RegExp]; a word may take a plural s/es. Longer phrases first so "police car" beats "car".
// A hyphen glues words: "coin-op" is not a coin, "horse-drawn" is listed on its own.
function table(rows, { plural = true } = {}) {
  const out = [];
  for (const [label, words] of rows) for (const w of words) out.push([label, w]);
  out.sort((a, b) => b[1].length - a[1].length);
  return out.map(([label, w]) => [label, new RegExp(`(?<![a-z]|[a-z]-)${esc(w)}${plural ? "(?:e?s)?" : ""}(?![a-z]|-[a-z])`, "g")]);
}

const VEHICLES = table([
  ["police car", ["police car", "squad car", "cop car", "patrol car", "cruiser"]], ["fire truck", ["fire truck", "fire engine"]],
  ["pickup truck", ["pickup truck", "pick-up truck", "pickup"]], ["ice cream truck", ["ice cream truck"]], ["golf cart", ["golf cart"]],
  ["station wagon", ["station wagon"]], ["stagecoach", ["stagecoach", "stage coach"]], ["wagon", ["wagon", "covered wagon", "buckboard"]],
  ["carriage", ["carriage", "buggy"]], ["cart", ["cart", "handcart"]], ["car", ["car"]], ["sedan", ["sedan"]], ["coupe", ["coupe"]],
  ["convertible", ["convertible"]], ["hatchback", ["hatchback"]], ["suv", ["suv"]], ["jeep", ["jeep"]], ["limousine", ["limo", "limousine"]],
  ["taxi", ["taxi", "cab", "taxicab"]], ["truck", ["truck", "big rig", "semi truck", "18-wheeler"]], ["van", ["van", "minivan"]],
  ["bus", ["bus", "school bus"]], ["ambulance", ["ambulance"]], ["hearse", ["hearse"]], ["motorcycle", ["motorcycle", "motorbike", "dirt bike"]],
  ["scooter", ["scooter", "moped", "vespa"]], ["bicycle", ["bicycle", "bike"]], ["trailer", ["trailer", "horse trailer"]],
  ["boat", ["boat", "motorboat", "speedboat", "rowboat", "dinghy", "canoe", "kayak", "trawler", "tugboat"]], ["yacht", ["yacht"]],
  ["sailboat", ["sailboat"]], ["car ferry", ["car ferry"]], ["ferry", ["ferry"]], ["ship", ["ship", "cargo ship"]], ["jet ski", ["jet ski", "jetski"]],
  ["helicopter", ["helicopter", "chopper"]], ["plane", ["plane", "airplane", "biplane", "seaplane", "jet plane"]],
  ["train", ["train", "locomotive", "subway train"]], ["tram", ["tram", "trolley", "streetcar"]], ["tractor", ["tractor"]],
  ["forklift", ["forklift"]], ["spaceship", ["spaceship", "starship", "spacecraft"]], ["shuttle", ["shuttle"]],
]);

const ANIMALS = table([
  ["horse", ["horse", "horse-drawn", "pony", "ponies", "stallion", "mare", "mustang"]], ["dog", ["dog", "puppy", "puppies", "hound", "mutt"]],
  ["cat", ["cat", "kitten"]], ["seagull", ["seagull", "gull"]], ["crow", ["crow", "raven"]], ["pigeon", ["pigeon"]], ["owl", ["owl"]],
  ["hawk", ["hawk"]], ["eagle", ["eagle"]], ["vulture", ["vulture", "buzzard"]], ["bird", ["bird"]],
  ["cattle", ["cow", "cattle", "bull", "longhorn"]], ["chicken", ["chicken", "hen", "rooster"]], ["goat", ["goat"]],
  ["sheep", ["sheep"]], ["pig", ["pig", "hog"]], ["mule", ["mule", "donkey"]], ["rat", ["rat", "mice"]], ["mouse", ["mouse"]],
  ["snake", ["snake", "rattlesnake", "rattler"]], ["fish", ["fish", "goldfish"]], ["shark", ["shark"]], ["dolphin", ["dolphin"]],
  ["coyote", ["coyote"]], ["wolf", ["wolf", "wolves"]], ["deer", ["deer"]], ["lizard", ["lizard", "iguana"]], ["monkey", ["monkey"]],
  ["parrot", ["parrot"]],
]);

const EXTRAS = table([
  ["crowd", ["crowd"]], ["tourists", ["tourist"]], ["patrons", ["patron"]], ["passers-by", ["passers-by", "passersby", "passer-by"]],
  ["pedestrians", ["pedestrian"]], ["waiters", ["waiter", "waitress", "waitstaff"]], ["customers", ["customer"]], ["diners", ["diners"]],
  ["onlookers", ["onlooker"]], ["bystanders", ["bystander"]], ["spectators", ["spectator"]], ["townsfolk", ["townsfolk", "townspeople"]],
  ["shoppers", ["shopper"]], ["commuters", ["commuter"]], ["dancers", ["dancers"]], ["revelers", ["reveler", "reveller", "partygoer"]],
  ["passengers", ["passengers"]], ["soldiers", ["soldiers"]], ["workers", ["workers", "dockworkers", "crew members"]],
  ["students", ["students"]], ["guards", ["guards"]], ["deputies", ["deputies"]], ["cops", ["cops", "police officers"]],
  ["kids", ["kids", "children"]], ["families", ["families"]], ["couples", ["couples"]], ["audience", ["audience"]],
  ["extras", ["extras", "background players"]],
], { plural: true });

const WARDROBE = table([
  ["ski mask", ["ski mask", "balaclava"]], ["mask", ["mask"]], ["cowboy hat", ["cowboy hat", "stetson"]], ["top hat", ["top hat"]],
  ["baseball cap", ["baseball cap"]], ["hat", ["hat", "bowler", "fedora"]], ["beanie", ["beanie"]], ["helmet", ["helmet"]],
  ["trench coat", ["trench coat", "trenchcoat"]], ["overcoat", ["overcoat"]], ["oilskin coat", ["oilskin coat", "oilskin"]], ["coat", ["coat"]], ["duster", ["duster"]],
  ["denim jacket", ["denim jacket", "jean jacket"]], ["leather jacket", ["leather jacket"]], ["jacket", ["jacket"]],
  ["flight suit", ["flight suit"]], ["spacesuit", ["spacesuit", "space suit"]], ["wetsuit", ["wetsuit"]], ["jumpsuit", ["jumpsuit"]],
  ["overalls", ["overalls"]], ["uniform", ["uniform"]], ["tuxedo", ["tuxedo", "tux"]], ["gown", ["gown", "ball gown"]],
  ["apron", ["apron"]], ["vest", ["vest", "waistcoat"]], ["hoodie", ["hoodie"]], ["sweater", ["sweater"]], ["poncho", ["poncho"]],
  ["cloak", ["cloak", "cape"]], ["robe", ["robe", "bathrobe"]], ["pajamas", ["pajamas", "pyjamas"]], ["boots", ["boots"]],
  ["spurs", ["spurs"]], ["gloves", ["gloves"]], ["sunglasses", ["sunglasses"]], ["scarf", ["scarf"]], ["bandana", ["bandana"]],
  ["wig", ["wig"]], ["costume", ["costume"]], ["sneakers", ["sneakers"]], ["heels", ["high heels", "heels"]], ["bow tie", ["bow tie"]],
  ["beehive hairdo", ["beehive hairdo", "beehive"]],
]);

const PROPS = table([
  ["gun", ["gun", "handgun"]], ["pistol", ["pistol"]], ["revolver", ["revolver", "six-shooter"]], ["rifle", ["rifle"]],
  ["shotgun", ["shotgun"]], ["knife", ["knife", "knives"]], ["sword", ["sword"]], ["crowbar", ["crowbar"]], ["hammer", ["hammer"]],
  ["wrench", ["wrench"]], ["rope", ["rope", "mooring line"]], ["handcuffs", ["handcuffs"]], ["key", ["key", "keycard"]],
  ["map", ["map"]], ["letter", ["letter"]], ["envelope", ["envelope"]], ["photograph", ["photograph", "photo"]],
  ["briefcase", ["briefcase"]], ["suitcase", ["suitcase"]], ["duffel bag", ["duffel bag", "duffel"]], ["backpack", ["backpack"]],
  ["purse", ["purse"]], ["wallet", ["wallet"]], ["cash", ["cash", "money"]], ["coin", ["coin"]], ["strongbox", ["strongbox", "lockbox"]],
  ["phone", ["phone", "cellphone", "cell phone"]], ["radio", ["radio", "walkie-talkie", "collar mic"]], ["binoculars", ["binoculars"]],
  ["camera", ["camera"]], ["laptop", ["laptop"]], ["flashlight", ["flashlight"]], ["lantern", ["lantern"]], ["lighter", ["lighter"]],
  ["cigarette", ["cigarette"]], ["cigar", ["cigar"]], ["bottle", ["bottle"]], ["whiskey", ["whiskey"]], ["mug", ["mug"]], ["cup", ["cup"]],
  ["coffee pot", ["coffee pot"]], ["coffee", ["coffee"]], ["pie", ["pie"]], ["plate", ["plate"]], ["tray", ["tray"]],
  ["ticket", ["ticket", "ticket roll"]], ["newspaper", ["newspaper"]], ["notebook", ["notebook"]], ["clipboard", ["clipboard"]],
  ["badge", ["badge", "tin star"]], ["sack", ["sack"]], ["dynamite", ["dynamite"]], ["bomb", ["bomb"]], ["umbrella", ["umbrella"]],
  ["steering wheel", ["steering wheel"]], ["funnel cake", ["funnel cake"]], ["ledger", ["ledger"]],
]);

const SET_DRESSING = table([
  ["neon sign", ["neon sign", "neon tubes", "neon"]], ["jukebox", ["jukebox"]], ["booth", ["booth"]], ["counter", ["counter"]],
  ["stool", ["stool", "barstool", "bar stool"]], ["table", ["table"]], ["chair", ["chair"]], ["ferris wheel", ["ferris wheel"]],
  ["carousel", ["carousel", "merry-go-round"]], ["roller coaster", ["roller coaster"]], ["turnstile", ["turnstile"]],
  ["pinball machine", ["pinball machine"]], ["slot machine", ["slot machine"]], ["vending machine", ["vending machine"]],
  ["water trough", ["water trough", "trough"]], ["hitching post", ["hitching post"]], ["swinging doors", ["swinging doors", "saloon doors"]],
  ["wanted poster", ["wanted poster"]], ["poster", ["poster"]], ["billboard", ["billboard"]], ["chandelier", ["chandelier"]],
  ["curtains", ["curtains", "drapes"]], ["mirror", ["mirror"]], ["clock", ["clock"]], ["painting", ["painting"]], ["rug", ["rug"]],
  ["bookshelf", ["bookshelf", "bookshelves", "shelves"]], ["bed", ["bed"]], ["sofa", ["sofa", "couch"]], ["desk", ["desk"]],
  ["fridge", ["fridge", "refrigerator"]], ["stove", ["stove"]], ["grill", ["grill"]], ["telescope", ["coin-op telescope", "telescope"]],
  ["railing", ["railing", "rail"]], ["bench", ["bench", "benches"]], ["street lamp", ["street lamp", "streetlamp", "lamppost"]],
  ["lamp", ["lamp"]], ["porthole", ["porthole"]], ["crate", ["crate"]], ["barrel", ["barrel"]], ["shutters", ["shutters"]],
  ["service door", ["service door"]], ["pilings", ["pilings"]],
]);

// Practical / special effects: [label, RegExp] on lowercased action text.
const SFX = [
  ["explosion", /(?<![a-z])(explosions?|explodes?|exploding|blows up|detonat\w*|kaboom)(?![a-z])/g],
  ["fireworks", /(?<![a-z])(fireworks?)(?![a-z])/g],
  ["gunfire", /(?<![a-z])(gunshots?|gunfire|shots? rings? out|opens? fire|(?:gun|pistol|revolver|rifle|shotgun)s? (?:fires?|goes off|cracks?))(?![a-z])/g],
  ["fire", /(?<![a-z])(?<!opens? )(?<!cease )(fire|flames?|blaze|ablaze|burning|on fire)(?![a-z])(?! (?:escape|truck|engine|alarm|hydrant|exit|department|station|door))/g],
  ["smoke", /(?<![a-z])(smoke|smoky|smoking)(?![a-z])/g],
  ["rain", /(?<![a-z])(rain|rains|rainy|raining|downpour|drizzle|storm)(?![a-z])/g],
  ["snow", /(?<![a-z])(snow|snows|snowy|snowing|blizzard)(?![a-z])/g],
  ["fog", /(?<![a-z])(fog|foggy|mist|misty|haze|hazy)(?![a-z])/g],
  ["sparks", /(?<![a-z])(sparks?|sparking)(?![a-z])/g],
  ["blood", /(?<![a-z])(blood|bloody|bleeds?|bleeding)(?![a-z])/g],
  ["breaking glass", /(?<![a-z])(shatter\w*|smash(?:es|ed)? (?:through )?(?:the |a )?(?:window|glass|bottle))(?![a-z])/g],
  ["wind", /(?<![a-z])(wind howls|howling wind|gusts? of wind|gale)(?![a-z])/g],
  ["lightning", /(?<![a-z])(lightning)(?![a-z])/g],
  ["steam", /(?<![a-z])(steam|steams|steaming)(?![a-z])/g],
  ["dust", /(?<![a-z])(dust (?:devils?|clouds?|storms?|swirls?|kicks up)|dust-storm|sandstorm)(?![a-z])/g],
];

const SOUND = [
  ["siren", /(?<![a-z])(sirens?)(?![a-z])/g], ["alarm", /(?<![a-z])(alarms?)(?![a-z])(?! clock)/g],
  ["thunder", /(?<![a-z])(thunder\w*)(?![a-z])/g], ["footsteps", /(?<![a-z])(footsteps)(?![a-z])/g],
  ["gunshot", /(?<![a-z])(gunshots?|shots? rings? out)(?![a-z])/g], ["knocking", /(?<![a-z])(knocks? (?:on|at)|knocking)(?![a-z])/g],
  ["phone ringing", /(?<![a-z])(phone rings|ringing phone|phone ringing)(?![a-z])/g],
  ["car horn", /(?<![a-z])(horns? (?:honks?|blares?|blasts?)|honks?|honking)(?![a-z])/g], ["bell", /(?<![a-z])(bells?)(?![a-z])/g],
  ["radio static", /(?<![a-z])(static)(?![a-z])/g], ["radio chatter", /(?<![a-z])(radio chatter)(?![a-z])/g],
  ["scream", /(?<![a-z])(screams?|screaming)(?![a-z])/g], ["whistle", /(?<![a-z])(whistles?|whistling)(?![a-z])/g],
  ["crickets", /(?<![a-z])(crickets)(?![a-z])/g], ["foghorn", /(?<![a-z])(foghorns?)(?![a-z])/g],
  ["engine", /(?<![a-z])(engines? (?:roars?|revs?|idles?|sputters?)|revs? the engine)(?![a-z])/g],
  ["tires screeching", /(?<![a-z])(tires? (?:screech|squeal)\w*)(?![a-z])/g], ["beeping", /(?<![a-z])(beeps?|beeping)(?![a-z])/g],
  ["dog barking", /(?<![a-z])(barks?|barking)(?![a-z])/g],
];

const MUSIC = [
  ["jukebox", /(?<![a-z])(jukebox)(?![a-z])/g], ["calliope", /(?<![a-z])(calliope)(?![a-z])/g], ["piano", /(?<![a-z])(piano)(?![a-z])/g],
  ["band", /(?<![a-z])(band (?:plays|strikes up)|brass band|mariachi band|string quartet)(?![a-z])/g],
  ["radio music", /(?<![a-z])(radio (?:plays|blares))(?![a-z])/g], ["guitar", /(?<![a-z])(guitar)(?![a-z])/g],
  ["harmonica", /(?<![a-z])(harmonica)(?![a-z])/g], ["fiddle", /(?<![a-z])(fiddle)(?![a-z])/g],
  ["singing", /(?<![a-z])(sings|singing|hums|humming)(?![a-z])/g], ["music", /(?<![a-z])(music)(?![a-z])/g],
];
// A song title is the quoted text right after a playing verb: `the jukebox plays "Moonlight on the Midway"`.
const SONG_RE = /\b(?:plays?|playing|sings?|singing|hums?|humming|blares?|blaring|croons?)\s+(?:(?:an?|the|some|her|his|their|an old|a slow)\s+)?(?:[a-z-]+\s+){0,2}?["“]([^"”]{2,80})["”]/gi;

const STUNTS = [
  ["fight", /(?<![a-z])(fist ?fights?|fight breaks out|fights? (?:him|her|them|back|off)|brawl\w*|punch(?:es|ed)?|throws? a punch|scuffle\w*|wrestl\w*)(?![a-z])/g],
  ["fall", /(?<![a-z])(falls? (?:off|from|down|backward|backwards|through|into|over)|tumbles|plummets|thrown (?:off|from|through|across))(?![a-z])/g],
  ["leap", /(?<![a-z])(leaps?|leaping|jumps? (?:off|from|over|onto|through|down|across)|vaults?|dives? (?:off|for|into|through|behind))(?![a-z])/g],
  ["tackle", /(?<![a-z])(tackles?|tackled)(?![a-z])/g],
  ["chase", /(?<![a-z])(chases?|chasing|pursues?|pursuit)(?![a-z])/g],
  ["vehicle crash", /(?<![a-z])(crash(?:es|ed)? into|collides?|collision|rams? into|wrecks?)(?![a-z])/g],
  ["horse work", /(?<![a-z])(gallops?|galloping|horses? rears?|rears up|bucks? off)(?![a-z])/g],
  ["wire work", /(?<![a-z])(dangles?|dangling|hangs? from|rappels?|abseils?)(?![a-z])/g],
];

// Kept in front of a vehicle / wardrobe / prop label when it sits right before the keyword ("red convertible").
const DESCRIPTORS = new Set(("red black white blue green yellow silver grey gray brown gold golden orange pink purple old rusty rusted " +
  "battered beat-up vintage sleek armored armoured getaway horse-drawn delivery unmarked dusty brass leather wooden " +
  "tin rusty-red chrome cargo battered police").split(" "));

// ---------------------------------------------------------------------------------------------- ALL-CAPS highlights

// Screenwriters capitalise sounds ("the door SLAMS") and key props ("a BRASS KEY") in action.
const SOUND_WORDS = new Set(("BANG BOOM CRASH SLAM THUD THUMP CREAK RING BUZZ HUM CLICK CLANG CLANK CLATTER CRACK CRACKLE SNAP POP " +
  "WHOOSH SCREECH HONK KNOCK BEEP WAIL ROAR RUMBLE ECHO BLARE CHIME TICK HISS SCREAM SHRIEK WHISTLE THUNDER JINGLE SQUEAL " +
  "GROWL BARK WHINNY NEIGH CAW SPLASH SHATTER WHEEZE SILENCE BLAST ZAP WHIR WHIRR DING CLAP STOMP THWACK SMACK WHACK SIZZLE " +
  "GURGLE DRIP RATTLE SCRAPE CHIRP HOWL BELLOW SPUTTER WHINE GROAN BLEEP SLURP CRUNCH").split(" "));
const IGNORE_CAPS = new Set(("INT EXT EST I/E POV CU ECU MCU OTS OS VO O.S V.O CONT'D CONT’D MORE CONTINUED SUPER TITLE CARD DAY NIGHT " +
  "CONTINUOUS LATER BEAT END FADE IN OUT CUT TO INSERT ANGLE CLOSE ON WIDE BACK SCENE MONTAGE FLASHBACK SERIES OF SHOTS " +
  "INTERCUT PRELAP QUICK CUTS SFX VFX MOS DR MR MRS MS ST JR SR AM PM AKA OK OKAY THE AND AN A AT WITH FOR FROM BY " +
  "FBI CIA NYPD LAPD NASA USA UK US " +
  // Screenplay conventions, not things: "We HEAR", "We SEE", left-over "SMASH CUT:" / "MATCH CUT.", and job initialisms.
  "HEAR HEARS HEARD SEE SEES SAW SMASH JUMP MATCH CUT CUTS CEO CFO COO CTO EMT EMS DJ MC VP PA ER ICU DA ADA DMV IRS ID HQ " +
  "DNA ATM GPS ASAP RIP SOS").split(" "));
// On-screen words are not props: SUPER: / TITLE: / CARD: text, quoted lines ("WHERE ARE YOU"), and what a sign "reads".
const ONSCREEN = /\b(?:SUPER|SUPERIMPOSE|TITLE|CARD|CHYRON|CAPTION|SUBTITLE)\s*:\s*(?:"[^"\n]*"?|“[^”\n]*”?|[^\n.!?]*[.!?]?)/g;
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const READS = /\b(?:reads|read|says|spells|spelling|marked|labeled|labelled|stenciled|stencilled)\s*:?\s+((?:[A-Z][A-Z0-9'’\-]*[A-Z0-9!]?\s*)+)/g;
// Titles and numbers inside character names: "DR. SMITH" is SMITH, "COP #2" is COP, "MRS. O'HARA" is O'HARA.
const NAME_TITLES = new Set("MR MRS MS MISS DR ST JR SR SGT CAPT LT COL GEN DET OFFICER AGENT SIR LADY LORD THE OLD YOUNG BIG LITTLE".split(" "));
// Character names that are also everyday words: "Will she wake?" or "Hope fades." at a sentence start is not WILL or HOPE.
const COMMON_NAMES = new Set(("will hope may grace faith joy june april august rose lily ivy iris hazel amber ruby pearl penny dawn " +
  "summer autumn winter sky storm river mark bill frank pat sue art gene ray rich grant chase hunter jack drew bob sunny " +
  "honey angel destiny patience prudence constance victor guy major king duke earl rex max").split(" "));
const ARTICLE_BEFORE = /(?:^|\s)(a|an|the|his|her|their|its|my|your|our|this|that|these|those|one|two|three|some|another|each|every|no)\s*$/i;
const NOT_NOUN = new Set("a an the and or but of to in on at with from into onto over by for as his her their its my your our this that then".split(" "));

const CAPS_RUN = /(?<![A-Za-z0-9'’])[A-Z][A-Z0-9'’\-]*[A-Z0-9](?:\s+[A-Z][A-Z0-9'’\-]*[A-Z0-9])*(?![a-z0-9])/g;
const INTRO_RE = /(?<![A-Za-z])([A-Z][A-Z'’.\-]*[A-Z.](?:\s+[A-Z][A-Z'’.\-]*[A-Z.]){0,3})\s*\((?:early |mid-?|late )?\d{1,2}s?\)/g;

/** Character introductions in action: `SHERIFF ADA COLE (60s)` -> ["SHERIFF ADA COLE"]. */
export function introducedNames(text) {
  const out = [];
  for (const m of String(text || "").matchAll(INTRO_RE)) out.push(m[1].replace(/\s+/g, " ").trim());
  return out;
}

/** An introduced name that contains a speaking name is that character ("SHERIFF ADA COLE" -> "ADA"). */
export function mapIntroduced(name, known) {
  const n = String(name || "").toUpperCase();
  if (known.has(n)) return n;
  const words = n.split(/\s+/);
  let best = "";
  for (const k of known) {
    const kw = k.split(/\s+/);
    for (let i = 0; i + kw.length <= words.length; i++) {
      if (kw.every((w, j) => words[i + j] === w) && k.length > best.length) best = k;
    }
  }
  return best || n;
}

function soundWord(w) {
  const u = w.toUpperCase().replace(/[^A-Z]/g, "");
  return [u, u.replace(/S$/, ""), u.replace(/ES$/, ""), u.replace(/ING$/, ""), u.replace(/ING$/, "E"), u.replace(/IES$/, "Y"), u.replace(/ED$/, ""), u.replace(/D$/, "")]
    .some((v) => v && SOUND_WORDS.has(v));
}

function prevNoun(before) {
  const m = String(before).match(/([A-Za-z][A-Za-z-]*)\s*$/);
  if (!m || /[,;:.!?]\s*$/.test(before)) return "";
  const w = m[1].toLowerCase();
  return NOT_NOUN.has(w) ? "" : w;
}

function anyMatch(rows, low) {
  return rows.some(([, re]) => { re.lastIndex = 0; return re.test(low); });
}

// ---------------------------------------------------------------------------------------------- extraction helpers

function push(list, label) {
  const l = String(label || "").replace(/\s+/g, " ").trim();
  if (l && !list.includes(l)) list.push(l);
}

// Run a [label, RegExp] table over text; matched spans are blanked so a generic row cannot re-count them.
function scanTable(rows, text, list, { descriptors = false } = {}) {
  let t = text;
  for (const [label, re] of rows) {
    re.lastIndex = 0;
    t = t.replace(re, (m, ...args) => {
      const offset = args[args.length - 2];
      let out = label;
      if (descriptors) {
        const prev = (t.slice(0, offset).match(/([a-z][a-z-]*)\s+$/) || [])[1];
        if (prev && DESCRIPTORS.has(prev) && !label.includes(prev)) out = `${prev} ${label}`;
      }
      push(list, out);
      return " ".repeat(m.length);
    });
  }
  return t;
}

// "brass key" makes a bare "key" redundant; "red car" makes "car" redundant.
function dropGeneric(list) {
  return list.filter((l) => !list.some((o) => o !== l && (o.endsWith(` ${l}`) || o.endsWith(` ${l}s`))));
}

const elText = (scene, types) => (scene.elements || []).filter((e) => types.includes(e.type)).map((e) => String(e.text || "")).join("\n");

/** Action text of a scene (the breakdown source); shot lines are included for keyword scans. */
export function actionText(scene, { shots = true } = {}) {
  return elText(scene, shots ? ["action", "shot"] : ["action"]);
}

const blankOut = (m) => " ".repeat(m.length);
const titleOf = (name) => name.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

function namePattern(name) {
  const alts = [...new Set([name, titleOf(name)])].map(esc).join("|");
  return new RegExp(`(?<![A-Za-z])(?:${alts})(?![A-Za-z])`);
}

// The upper-case name with an optional possessive, as a whole token ("COP #2" not "COP #23").
const nameCapsRe = (name) => new RegExp(`(?<![A-Za-z0-9'’])${esc(name)}(?:['’]S)?(?![A-Za-z0-9])`, "g");

/** Is this character named in the text? Upper case anywhere; Title Case too, except an everyday-word name ("Will",
 *  "Hope") at the start of a sentence. */
function namedIn(name, text) {
  if (!COMMON_NAMES.has(name.toLowerCase())) return namePattern(name).test(text);
  if (new RegExp(`(?<![A-Za-z])${esc(name)}(?![A-Za-z])`).test(text)) return true;
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z])${esc(titleOf(name))}(?![A-Za-z])`, "g"))) {
    if (!/(?:^|[.!?…]["'”’)]*\s+|\n\s*)$/.test(text.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * The breakdown sheet for one scene, from its action lines (dialogue is never mined).
 * `known` = every character name in the script (speaking cues + introductions), upper case.
 */
export function breakdownScene(scene, { known = new Set() } = {}) {
  const b = emptyBreakdown();
  const knownSet = known instanceof Set ? known : new Set(known);
  const action = actionText(scene, { shots: false });
  const withShots = actionText(scene);
  const low = withShots.toLowerCase();
  const loc = String(scene.location || "").toLowerCase();

  // Cast: who speaks, who is introduced, and known characters named in action ("Teddy sinks low").
  for (const c of scene.characters || []) push(b.cast, c);
  let capsText = action;
  for (const m of action.matchAll(INTRO_RE)) {
    push(b.cast, mapIntroduced(m[1].replace(/\s+/g, " ").trim(), knownSet));
    capsText = capsText.replace(m[0], " ".repeat(m[0].length));
  }
  const names = [...knownSet].filter((n) => n.length >= 3).sort((a, z) => z.length - a.length);
  for (const n of names) if (!b.cast.includes(n) && namedIn(n, withShots)) push(b.cast, n);
  // The ALL-CAPS scan below only sees what is left: on-screen text goes, and every spelling of a known name ("DR. SMITH",
  // "COP #2", "O'HARA" for MRS. O'HARA) is blanked so it is not filed as a prop.
  capsText = capsText.replace(ONSCREEN, blankOut).replace(QUOTED, blankOut).replace(READS, (m, w) => m.slice(0, m.length - w.length) + blankOut(w));
  for (const n of names) capsText = capsText.replace(nameCapsRe(n), blankOut);
  const nameWords = new Set();
  for (const n of knownSet) for (const w of n.split(/\s+/)) {
    const c = w.replace(/[.#]+$/g, "").replace(/^#/, "");
    if (c.length >= 2 && !/^\d+$/.test(c) && !NAME_TITLES.has(c)) nameWords.add(c);
  }

  // Keyword tables over lowercased action (+ the heading location for picture vehicles: INT. GETAWAY VAN).
  scanTable(VEHICLES, `${loc}\n${low}`, b.vehicles, { descriptors: true });
  scanTable(ANIMALS, low, b.animals);
  scanTable(EXTRAS, low, b.extras);
  scanTable(WARDROBE, low, b.wardrobe, { descriptors: true });
  scanTable(SFX, low, b.sfx);
  scanTable(SOUND, low, b.sound);
  scanTable(STUNTS, low, b.stunts);
  for (const m of withShots.matchAll(SONG_RE)) push(b.music, `"${m[1].trim()}"`);
  scanTable(MUSIC, low, b.music);
  if ((scene.elements || []).some((e) => e.type === "lyric")) push(b.music, "song (lyrics in script)");
  scanTable(SET_DRESSING, low, b.set_dressing);
  const capsProps = [];

  // ALL-CAPS highlights: known names -> cast, sound words -> sound, the rest -> props.
  for (const m of capsText.matchAll(CAPS_RUN)) {
    const words = m[0].split(/\s+/);
    const before = capsText.slice(0, m.index);
    let chunk = [], chunkStart = before;
    const flush = (pre) => {
      const bare = chunk.map((w) => w.replace(/['’]S$/, "").replace(/^['’\-]+|['’\-]+$/g, ""));
      if (chunk.length && !bare.every((w) => nameWords.has(w) || IGNORE_CAPS.has(w))) classifyCaps(chunk, pre, b, capsProps);
      chunk = [];
    };
    for (let i = 0; i < words.length;) {
      let hit = null;
      for (const n of names) {
        const nw = n.split(" ");
        if (nw.every((w, j) => (words[i + j] || "").replace(/['’]S$/, "") === w)) { hit = n; i += nw.length; break; }
      }
      if (hit) {
        flush(chunkStart);
        push(b.cast, hit);
        chunkStart = "";
        continue;
      }
      if (!chunk.length && i > 0) chunkStart = `${before} ${words.slice(0, i).join(" ")}`;
      chunk.push(words[i]);
      i++;
    }
    flush(chunkStart);
  }
  b.props = capsProps;
  scanTable(PROPS, low, b.props, { descriptors: true });

  for (const k of ["props", "vehicles", "wardrobe", "set_dressing", "sound"]) b[k] = dropGeneric(b[k]);
  // A prop already listed as set dressing or a vehicle is one thing, not two.
  b.props = b.props.filter((p) => !b.vehicles.includes(p) && !b.set_dressing.includes(p) && !b.wardrobe.includes(p));
  return b;
}

function classifyCaps(words, before, b, props) {
  const clean = words.map((w) => w.replace(/^['’\-]+|['’\-]+$/g, "")).filter(Boolean);
  if (!clean.length || clean.every((w) => IGNORE_CAPS.has(w))) return;
  // Leading articles are layout, not part of the thing ("THE FOGHORN BLASTS").
  while (clean.length > 1 && IGNORE_CAPS.has(clean[0])) clean.shift();
  const low = clean.join(" ").toLowerCase();
  if (clean.some(soundWord)) {
    const noun = prevNoun(before);
    push(b.sound, noun && !low.startsWith(noun) ? `${noun} ${low}` : low);
    return;
  }
  // The keyword tables already file vehicles, animals, extras and effects.
  if ([VEHICLES, ANIMALS, EXTRAS].some((t) => anyMatch(t, low)) || SFX.some(([, re]) => { re.lastIndex = 0; return re.test(low); })) return;
  if (ARTICLE_BEFORE.test(before) || clean.length > 1) { push(props, low); return; }
  if (/(?:S|ES|ED|ING)$/.test(clean[0])) { push(b.sound, (prevNoun(before) ? `${prevNoun(before)} ` : "") + low); return; }
  push(props, low);
}

// ---------------------------------------------------------------------------------------------- stage hint

const SKIP_KINDS = new Set(["man", "woman", "child", "cube", "sphere", "pyramid", "cylinder", "cone", "flat", "wall"]);
// Words resolveKind() maps that are mostly something else in screenplay prose ("police officer", "sinks low", "fires").
const SKIP_TOKENS = new Set(["police", "block", "ball", "column", "pillar", "home", "seat", "box", "plant", "stone", "sink", "sinks",
  "basin", "fires", "fired", "firing", "rocks", "rocking", "kitchen", "torch", "torches", "lady", "boy", "girl", "kid",
  "kids", "guy", "person", "driver", "rider", "alien", "invader", "shelf", "tub", "hob"]);
// Multi-word keys of SYNONYMS in web/stage/library.mjs (not exported); resolveKind() still does the mapping. Keep in sync.
const COMPOUNDS = ["police car", "cop car", "squad car", "sports car", "race car", "compact car", "small car", "pickup truck",
  "speed boat", "fishing boat", "sail boat", "sailing boat", "jet ski", "camp fire", "fire pit", "flying saucer", "space ship",
  "alien ship", "flash light", "electric torch", "street lamp", "double bed", "queen bed", "king bed", "single bed",
  "coffee table", "tv stand", "kitchen counter", "dining table", "house plant"];

/** Library kinds (web/stage/library.mjs) named in the text, in order of first mention. */
export function libraryObjects(text) {
  let t = ` ${String(text || "").toLowerCase()} `;
  const hits = []; // [position, kind]
  for (const c of COMPOUNDS) {
    const re = new RegExp(`(?<![a-z])${esc(c)}(?![a-z])`, "g");
    t = t.replace(re, (m, at) => { hits.push([at, resolveKind(c)]); return " ".repeat(m.length); });
  }
  for (const m of t.matchAll(/[a-z']+/g)) {
    const tok = m[0];
    if (tok.length < 3 || SKIP_TOKENS.has(tok)) continue;
    hits.push([m.index, resolveKind(tok.replace(/'s$/, ""))]);
  }
  const found = [];
  for (const [, k] of hits.sort((a, b) => a[0] - b[0])) if (k && LIBRARY[k] && !SKIP_KINDS.has(k) && !found.includes(k)) found.push(k);
  return found;
}

/**
 * Hints for building this scene on the 3D stage. `prevTime` is the previous scene's time_of_day, carried into
 * CONTINUOUS / LATER / no-time headings so a run of scenes keeps its light.
 */
export function stageHint(scene, { prevTime = null } = {}) {
  const loc = String(scene.location || (scene.int_ext ? "" : scene.heading) || "").toLowerCase();
  const action = actionText(scene).toLowerCase();
  let set = pickFrom(SET_WORDS, loc);
  // The outside of a diner is not the diner set.
  if (set === "interior" && scene.int_ext === "EXT") set = null;
  // ...and the inside of a town hall is not the street set. A vehicle in the heading (INT. BOAT, INT. HELICOPTER) keeps it.
  if (scene.int_ext === "INT" && EXTERIOR_SETS.has(set) && !anyMatch(VEHICLES, loc)) set = "interior";
  if (!set) set = scene.int_ext === "INT" ? "interior" : pickFrom(SET_WORDS, action);
  if (set === "interior" && scene.int_ext === "EXT") set = null;

  const time = String(scene.time || "").toUpperCase();
  let tod = timeOfDay(time);
  if (!tod && !INHERIT_TIME.test(time)) tod = pickFrom(ACTION_TIMES, action);
  if (!tod && time === "") tod = pickFrom(ACTION_TIMES, action);
  if (!tod && INHERIT_TIME.test(time)) tod = prevTime || null;

  const weather = pickFrom(WEATHER_WORDS, `${loc}\n${action}`);
  return { set: set || null, time_of_day: tod || null, weather: weather || null, objects: libraryObjects(`${loc}\n${action}`) };
}
