// node --test tests/js/script.test.mjs
// Script import: Fountain, Final Draft, PDF copy/paste text and PDF lines all land on the same Script model; the breakdown
// and stage hints are extractive; a revised draft keeps the director's notes. Fixtures are original sample scripts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PDFJS_URL, PDFJS_WORKER_URL, buildPromptForScene, compactScript, detectFormat, formatEighths, hydrateScript, importScriptFile, loadPdfJs,
  matchSlug, mergeNotes, stageSetupForScene,
  normalizeCharacter, parseEighths, parseHeading, parseScript, sceneSummaryLine, stripEmphasis, textItemsToLines,
} from "../../web/script/parse.mjs";
import { CATEGORIES, SET_IDS, SET_WORDS, breakdownScene, libraryObjects, stageHint, timeOfDay } from "../../web/script/breakdown.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/script/${name}`, import.meta.url), "utf8");
const FOUNTAIN = fixture("boardwalk.fountain");
const FDX = fixture("stagecoach.fdx");
const TEXT = fixture("orbital_diner.txt");
const PDF_LINES = JSON.parse(fixture("night_ferry_pdf_lines.json"));

const fountain = () => parseScript(FOUNTAIN, { name: "boardwalk.fountain" });
const fdx = () => parseScript(FDX, { name: "stagecoach.fdx" });
const text = () => parseScript(TEXT, { name: "orbital_diner.txt" });
const pdf = () => parseScript({ lines: PDF_LINES.lines }, { format: "pdf", name: "night_ferry.pdf" });
const byNum = (s, n) => s.scenes.find((x) => x.number === n);
const types = (sc) => sc.elements.map((e) => e.type);
const allText = (s) => s.scenes.flatMap((sc) => sc.elements.map((e) => e.text)).join("\n");

const ELEMENT_TYPES = new Set(["action", "character", "dialogue", "parenthetical", "transition", "shot", "note", "centered", "lyric"]);

function assertScriptShape(s) {
  assert.equal(s.version, 1);
  for (const k of ["title", "author", "format", "source_name"]) assert.equal(typeof s[k], "string", k);
  assert.ok(["fountain", "fdx", "text", "pdf"].includes(s.format), s.format);
  assert.ok(Array.isArray(s.scenes) && s.scenes.length >= 1);
  assert.ok(Array.isArray(s.characters));
  assert.ok(Number.isFinite(s.page_count_est) && s.page_count_est >= 1);
  const ids = new Set();
  s.scenes.forEach((sc, i) => {
    assert.match(sc.id, /^sc_[A-Za-z0-9_]+$/);
    assert.ok(!ids.has(sc.id), `duplicate id ${sc.id}`);
    ids.add(sc.id);
    assert.ok(typeof sc.number === "string" && sc.number.length > 0);
    assert.equal(sc.index, i);
    assert.ok(["INT", "EXT", "INT/EXT", ""].includes(sc.int_ext));
    for (const k of ["heading", "location", "time", "synopsis", "outline", "notes"]) assert.equal(typeof sc[k], "string", k);
    assert.equal(sc.notes, "");
    assert.ok(sc.outline.length <= 181, sc.outline);
    assert.ok(Number.isInteger(sc.eighths) && sc.eighths >= 1);
    for (const e of sc.elements) {
      assert.ok(ELEMENT_TYPES.has(e.type), e.type);
      assert.equal(typeof e.text, "string");
    }
    assert.ok(Array.isArray(sc.characters));
    assert.deepEqual(Object.keys(sc.breakdown).sort(), [...CATEGORIES].sort());
    for (const c of CATEGORIES) assert.ok(Array.isArray(sc.breakdown[c]));
    const h = sc.stage_hint;
    assert.ok(h.set === null || SET_IDS.includes(h.set), h.set);
    assert.ok([null, "day", "night", "dawn", "dusk"].includes(h.time_of_day));
    assert.ok([null, "rain", "snow", "fog"].includes(h.weather));
    assert.ok(Array.isArray(h.objects));
  });
  for (const c of s.characters) {
    assert.equal(typeof c.name, "string");
    assert.ok(Number.isInteger(c.lines) && c.lines >= 0);
    for (const id of c.scenes) assert.ok(ids.has(id));
  }
}

// ---------------------------------------------------------------- helpers

test("detectFormat: extension first, then a sniff", () => {
  assert.equal(detectFormat("a.fountain", ""), "fountain");
  assert.equal(detectFormat("a.spmd", ""), "fountain");
  assert.equal(detectFormat("a.FDX", ""), "fdx");
  assert.equal(detectFormat("a.pdf", ""), "pdf");
  assert.equal(detectFormat("", "%PDF-1.7 ..."), "pdf");
  assert.equal(detectFormat("draft.txt", FDX), "fdx");
  assert.equal(detectFormat("draft.txt", FOUNTAIN), "fountain");
  assert.equal(detectFormat("draft.txt", TEXT), "text");
  assert.equal(detectFormat("", "INT. ROOM - DAY\n\nNothing happens."), "text");
  assert.equal(detectFormat(undefined, undefined), "text");
});

test("formatEighths / parseEighths: stripboard page lengths", () => {
  assert.equal(formatEighths(1), "1/8");
  assert.equal(formatEighths(4), "4/8");
  assert.equal(formatEighths(8), "1");
  assert.equal(formatEighths(11), "1 3/8");
  assert.equal(formatEighths(0), "0");
  assert.equal(formatEighths("x"), "0");
  assert.equal(parseEighths("1 3/8"), 11);
  assert.equal(parseEighths("4/8"), 4);
  assert.equal(parseEighths("2"), 16);
  assert.equal(parseEighths(""), 0);
  assert.equal(parseEighths("junk"), 0);
});

test("parseHeading splits INT/EXT, location and time", () => {
  assert.deepEqual(parseHeading("INT. DINER - NIGHT"), { int_ext: "INT", location: "DINER", time: "NIGHT" });
  assert.deepEqual(parseHeading("EXT. DRY CREEK - MAIN STREET - HIGH NOON"), { int_ext: "EXT", location: "DRY CREEK - MAIN STREET", time: "HIGH NOON" });
  assert.deepEqual(parseHeading("INT./EXT. GETAWAY VAN - CONTINUOUS"), { int_ext: "INT/EXT", location: "GETAWAY VAN", time: "CONTINUOUS" });
  assert.deepEqual(parseHeading("I/E. FUNHOUSE - MOMENTS LATER"), { int_ext: "INT/EXT", location: "FUNHOUSE", time: "MOMENTS LATER" });
  assert.deepEqual(parseHeading("EST. HARBOR LIGHTHOUSE - NIGHT"), { int_ext: "EXT", location: "HARBOR LIGHTHOUSE", time: "NIGHT" });
  assert.deepEqual(parseHeading("INT. HOUSE - KITCHEN"), { int_ext: "INT", location: "HOUSE - KITCHEN", time: "" });
  assert.deepEqual(parseHeading("EXT. ROAD—DAWN"), { int_ext: "EXT", location: "ROAD", time: "DAWN" });
  assert.deepEqual(parseHeading("INSIDE THE VAN"), { int_ext: "", location: "INSIDE THE VAN", time: "" });
});

test("normalizeCharacter strips extensions and markers", () => {
  assert.equal(normalizeCharacter("ALEX (V.O.)"), "ALEX");
  assert.equal(normalizeCharacter("ALEX (O.S.)"), "ALEX");
  assert.equal(normalizeCharacter("ALEX (O.C.)"), "ALEX");
  assert.equal(normalizeCharacter("ALEX (CONT'D)"), "ALEX");
  assert.equal(normalizeCharacter("ALEX (CONT’D)"), "ALEX");
  assert.equal(normalizeCharacter("ALEX (V.O.) (CONT'D)"), "ALEX");
  assert.equal(normalizeCharacter("KIM ^"), "KIM");
  assert.equal(normalizeCharacter("@McCLANE"), "MCCLANE");
  assert.equal(normalizeCharacter("HANS (on the radio)"), "HANS");
  assert.equal(normalizeCharacter("DR. VOSS CONT'D"), "DR. VOSS");
});

test("stripEmphasis removes Fountain markers, keeps escaped stars", () => {
  assert.equal(stripEmphasis("our *window* and **parked** and ***both*** and _Nobody_"), "our window and parked and both and Nobody");
  assert.equal(stripEmphasis("_**TITLE**_"), "TITLE");
  assert.equal(stripEmphasis("a \\*literal\\* star"), "a *literal* star");
  assert.equal(stripEmphasis("snake_case_name stays"), "snake_case_name stays");
});

test("matchSlug: scene numbers on both sides, wide gaps, and a time that is not a number", () => {
  assert.deepEqual(matchSlug("12   INT. GARAGE - DAY   12"), { heading: "INT. GARAGE - DAY", number: "12" });
  assert.deepEqual(matchSlug("12A INT. GARAGE - DAY 12A"), { heading: "INT. GARAGE - DAY", number: "12A" });
  assert.deepEqual(matchSlug("A7 EXT. ROOF - NIGHT"), { heading: "EXT. ROOF - NIGHT", number: "A7" });
  assert.deepEqual(matchSlug("INT. GARAGE - DAY      14"), { heading: "INT. GARAGE - DAY", number: "14" });
  assert.deepEqual(matchSlug("INT. BUNKER - DAY 2"), { heading: "INT. BUNKER - DAY 2", number: null });
  assert.equal(matchSlug("Interior design is hard."), null);
  assert.equal(matchSlug("Int. lowercase words here"), null);
});

// ---------------------------------------------------------------- Fountain

test("Fountain: title page, scene numbers, forced and special headings", () => {
  const s = fountain();
  assertScriptShape(s);
  assert.equal(s.format, "fountain");
  assert.equal(s.title, "LAST RIDE ON THE BOARDWALK");
  assert.equal(s.author, "Jane Doe");
  assert.equal(s.source_name, "boardwalk.fountain");
  assert.deepEqual(s.scenes.map((x) => x.number), ["1", "2", "2A", "2B", "3", "4"]);
  assert.deepEqual(s.scenes.map((x) => x.id), ["sc_1", "sc_2", "sc_2A", "sc_2B", "sc_3", "sc_4"]);
  assert.deepEqual(s.scenes.map((x) => x.numbered), [true, true, true, false, true, true]);
  assert.deepEqual(s.scenes.map((x) => x.int_ext), ["EXT", "EXT", "INT/EXT", "", "INT/EXT", "INT"]);
  assert.equal(byNum(s, "1").heading, "EXT. SEASIDE AMUSEMENT PIER - NIGHT");  // #1# removed
  assert.equal(byNum(s, "2").heading, "EST. HARBOR LIGHTHOUSE - NIGHT");
  assert.equal(byNum(s, "2A").location, "GETAWAY VAN");
  assert.equal(byNum(s, "2A").time, "CONTINUOUS");
  assert.equal(byNum(s, "2B").heading, "INSIDE THE VAN");                     // .INSIDE THE VAN, forced
  assert.equal(byNum(s, "3").time, "MOMENTS LATER");
});

test("Fountain: sections, synopses, notes, boneyard, page breaks, emphasis", () => {
  const s = fountain();
  const sc1 = byNum(s, "1");
  assert.equal(sc1.section, "ACT ONE / The Setup");
  assert.equal(byNum(s, "2B").section, "ACT ONE / The Setup");
  assert.equal(byNum(s, "3").section, "ACT TWO");
  assert.equal(sc1.synopsis, "The crew blends into the closing-night crowd.");
  assert.equal(byNum(s, "2").synopsis, "");                                   // the section synopsis is not a scene's
  const body = allText(s);
  assert.doesNotMatch(body, /cases the pier/);                                 // '=' before the first scene
  assert.doesNotMatch(body, /rowboat|We cut it/);                              // boneyard
  assert.doesNotMatch(body, /\[\[|\]\]|ACT ONE|The Setup|===/);
  assert.doesNotMatch(body, /\*|(?<![A-Za-z])_[A-Za-z]/);                     // emphasis markers
  assert.ok(sc1.elements.some((e) => e.type === "dialogue" && e.text === "Lights on the wheel just went out. That's our window."));
  assert.ok(byNum(s, "2A").elements.some((e) => e.text === "Nobody ever looks at the van."));
  // A note on its own line, and an inline note lifted out of an action line (it follows that line).
  assert.ok(sc1.elements.some((e) => e.type === "note" && e.text === "Need a practical rain rig for this one."));
  const sc2 = byNum(s, "2");
  assert.deepEqual(sc2.elements.map((e) => [e.type, e.text]), [
    ["action", "Fog rolls across the water. The beam sweeps the pier."],
    ["note", "VFX: the beam could be a practical."],
  ]);
  // The === page break between 2A and 2B does not split or add anything.
  assert.deepEqual(types(byNum(s, "2B")), ["action", "character", "dialogue"]);
});

test("Fountain: dialogue, parentheticals, extensions, dual, forced elements, transitions, centered, lyrics", () => {
  const s = fountain();
  const sc1 = byNum(s, "1");
  assert.deepEqual(types(sc1), ["transition", "action", "action", "note", "action", "character", "parenthetical", "dialogue",
    "character", "parenthetical", "dialogue", "character", "dialogue", "transition"]);
  assert.equal(sc1.elements[0].text, "FADE IN:");                               // before the first heading -> scene 1
  assert.equal(sc1.elements.at(-1).text, "CUT TO:");
  const teddy = sc1.elements.find((e) => e.type === "character" && e.character === "TEDDY");
  assert.equal(teddy.text, "TEDDY (V.O.)");
  assert.equal(sc1.elements.find((e) => e.type === "parenthetical").character, "MARGO");
  assert.deepEqual(sc1.characters, ["MARGO", "TEDDY"]);

  const van = byNum(s, "2A");
  assert.equal(van.elements.filter((e) => e.type === "character").map((e) => e.text).join("|"), "TEDDY|TEDDY (CONT'D)");
  assert.deepEqual(van.characters, ["TEDDY"]);

  const inside = byNum(s, "2B");
  assert.equal(inside.elements[0].text, "SILENCE. Then the radio CRACKLES.");   // !forced action, not a cue
  assert.equal(inside.elements[1].text, "MARGO (O.S.)");

  const fun = byNum(s, "3");
  const mc = fun.elements.find((e) => e.type === "character" && e.text === "McCLANE"); // @forced character
  assert.ok(mc);
  assert.equal(mc.character, "MCCLANE");
  assert.deepEqual(fun.characters, ["GUARD", "MARGO", "MCCLANE"]);

  const booth = byNum(s, "4");
  const cues = booth.elements.filter((e) => e.type === "character");
  assert.deepEqual(cues.map((e) => [e.character, !!e.dual]), [["BRODY", false], ["KIM", true]]);
  assert.equal(cues[1].text, "KIM");                                            // ^ removed
  const lyric = booth.elements.find((e) => e.type === "lyric");
  assert.equal(lyric.text, "Moonlight on the midway,\nmeet me where the lights go down.");
  assert.deepEqual(booth.elements.slice(-2).map((e) => [e.type, e.text]), [["transition", "FADE OUT."], ["centered", "THE END"]]);
});

test("Fountain: characters list counts speeches and scenes", () => {
  const s = fountain();
  const by = Object.fromEntries(s.characters.map((c) => [c.name, c]));
  assert.equal(s.characters[0].name, "MARGO");
  assert.equal(by.MARGO.lines, 4);
  assert.deepEqual(by.MARGO.scenes, ["sc_1", "sc_2B", "sc_3"]);
  assert.equal(by.TEDDY.lines, 3);
  assert.deepEqual(by.TEDDY.scenes, ["sc_1", "sc_2A"]);
  for (const n of ["GUARD", "MCCLANE", "BRODY", "KIM"]) assert.equal(by[n].lines, 1);
});

// ---------------------------------------------------------------- Final Draft

test("FDX: title page, numbered headings, scene lengths, runs and entities", () => {
  const s = fdx();
  assertScriptShape(s);
  assert.equal(s.format, "fdx");
  assert.equal(s.title, "THE LAST STAGECOACH");
  assert.equal(s.author, "John Doe");
  assert.deepEqual(s.scenes.map((x) => x.number), ["1", "2", "3", "3A"]);
  assert.deepEqual(s.scenes.map((x) => x.numbered), [true, true, true, true]);
  assert.equal(s.scenes[0].heading, "EXT. DRY CREEK - MAIN STREET - HIGH NOON");
  assert.equal(s.scenes[0].eighths, 10);                                        // SceneProperties Length="1 2/8"
  assert.equal(s.scenes[1].eighths, 4);                                         // "4/8"
  assert.equal(sceneSummaryLine(s.scenes[0]), "Sc 1 · EXT. DRY CREEK - MAIN STREET - HIGH NOON · 1 2/8 pg");
  const sc1 = s.scenes[0];
  assert.equal(sc1.elements[0].type, "transition");
  assert.equal(sc1.elements[1].text, "Dust devils skitter down an empty street. A horse-drawn STAGECOACH rattles to a stop outside the Dry Creek Savings & Loan. Townsfolk duck behind shutters.");
  assert.match(sc1.elements[2].text, /Her spurs JINGLE\.$/);                     // Style="AllCaps"
  assert.equal(sc1.elements.find((e) => e.type === "dialogue").text, "Step down from the coach, Mister Vance.");
  assert.equal(sc1.elements.find((e) => e.type === "parenthetical").text, "(calm)");
  assert.equal(s.scenes[1].elements.find((e) => e.type === "dialogue").text, "When I say jump, you jump. That’s the deal.");
  assert.ok(s.scenes[1].elements.some((e) => e.type === "shot" && e.text === "CLOSE ON THE STRONGBOX"));
  assert.ok(sc1.elements.some((e) => e.type === "character" && e.text === "VANCE (O.S.)" && e.character === "VANCE"));
});

test("FDX: dual dialogue order, General -> THE END, header/title/SmartType text kept out", () => {
  const s = fdx();
  const sc3 = byNum(s, "3");
  assert.deepEqual(sc3.elements.map((e) => [e.type, e.text, !!e.dual]), [
    ["action", "The door flies open. Vance leaps from the coach and tackles a deputy into the water trough. A gunshot cracks. The horses rear.", false],
    ["character", "ADA", false], ["dialogue", "Drop it!", false],
    ["character", "VANCE", true], ["dialogue", "You first!", false],
    ["transition", "SMASH CUT TO:", false],
  ]);
  assert.deepEqual(byNum(s, "3A").elements.at(-1), { type: "centered", text: "THE END" });
  const body = allText(s);
  assert.doesNotMatch(body, /HEADER TEXT|john@example\.com|Written by/);
  assert.equal(s.scenes.length, 4);
  const by = Object.fromEntries(s.characters.map((c) => [c.name, c]));
  assert.equal(by.VANCE.lines, 3);
  assert.equal(by.ADA.lines, 2);
});

// ---------------------------------------------------------------- PDF copy/paste text

test("Text: title page, page furniture removed, numbers on both sides", () => {
  const s = text();
  assertScriptShape(s);
  assert.equal(s.format, "text");
  assert.equal(s.title, "ORBITAL DINER");
  assert.equal(s.author, "Jane Doe");
  assert.deepEqual(s.scenes.map((x) => [x.number, x.heading]), [
    ["1", "INT. ORBITAL DINER - NIGHT"], ["2", "EXT. ORBITAL DINER - CONTINUOUS"], ["12", "INT. CARGO GARAGE - DAY"],
  ]);
  assert.deepEqual(s.scenes.map((x) => x.id), ["sc_1", "sc_2", "sc_12"]);
  const body = allText(s);
  assert.doesNotMatch(body, /CONTINUED|\(MORE\)|Rev\.|jane@example\.com|Written by/);
  for (const sc of s.scenes) for (const e of sc.elements) assert.doesNotMatch(e.text, /^\d+\.$/);
});

test("Text: (MORE)/(CONT'D) across a page break is one speech; cues, shots, transitions", () => {
  const s = text();
  const sc1 = s.scenes[0];
  assert.deepEqual(types(sc1), ["transition", "action", "action", "character", "parenthetical", "dialogue", "character", "dialogue",
    "action", "character", "dialogue", "shot", "action"]);
  const dots = sc1.elements.filter((e) => e.type === "character" && e.character === "DOT");
  assert.equal(dots.length, 2);                                                 // the (CONT'D) cue was absorbed
  assert.equal(sc1.elements[10].text, "Coming, coming. Keep your helmet on.");
  assert.equal(sc1.elements[5].text, "Refill, hon? Last one before the shift change.");  // wrapped dialogue joined
  assert.equal(sc1.elements[1].text, "Neon tubes BUZZ over a chrome counter. Through the porthole windows, Earth hangs blue and silent. A handful of PATRONS hunch over their coffee.");
  assert.equal(sc1.elements[11].text, "ANGLE ON THE PORTHOLE");
  assert.deepEqual(s.scenes[1].elements.at(-1), { type: "transition", text: "CUT TO:" });
  assert.deepEqual(s.scenes[2].elements.slice(-2).map((e) => [e.type, e.text]), [["transition", "FADE TO BLACK."], ["centered", "THE END"]]);
  const by = Object.fromEntries(s.characters.map((c) => [c.name, c]));
  assert.equal(by.DOT.lines, 3);
  assert.equal(by.RIGGS.lines, 2);
});

// ---------------------------------------------------------------- PDF lines {text, x}

test("PDF lines: x positions classify cues, dialogue and caps action lines", () => {
  const s = pdf();
  assertScriptShape(s);
  assert.equal(s.format, "pdf");
  assert.equal(s.title, "THE NIGHT FERRY");
  assert.equal(s.author, "John Doe");
  assert.equal(s.page_count_est, 3);
  assert.deepEqual(s.scenes.map((x) => [x.number, x.heading]), [
    ["5", "EXT. FERRY DOCK - DAWN"], ["6", "INT. FERRY - CAR DECK - CONTINUOUS"], ["6A", "EXT. FERRY - UPPER DECK - DAY"],
  ]);
  const sc5 = s.scenes[0];
  assert.deepEqual(types(sc5), ["transition", "action", "action", "character", "parenthetical", "dialogue", "character", "dialogue",
    "action", "character", "dialogue", "transition"]);
  // OTTO's cue follows MAREN's line with no blank: x says it is a new cue.
  assert.equal(sc5.elements[6].text, "OTTO (O.S.)");
  // An all-caps line at the action margin followed by more action is action, not a character.
  assert.match(sc5.elements[8].text, /^THE FOGHORN BLASTS/);
  assert.ok(!s.characters.some((c) => /FOGHORN/.test(c.name)));
  assert.equal(sc5.elements[10].text, "Ferry's leaving with or without you, kid.");  // (MORE) / (CONT'D) on page 3
  assert.equal(sc5.elements.at(-1).text, "CUT TO:");
  assert.doesNotMatch(allText(s), /CONTINUED|\(MORE\)|^3\.$/m);
  const by = Object.fromEntries(s.characters.map((c) => [c.name, c]));
  assert.equal(by.MAREN.lines, 2);
  assert.equal(by.OTTO.lines, 2);
  assert.deepEqual(by.MAREN.scenes, ["sc_5", "sc_6", "sc_6A"]);                 // named in 6A's action, not speaking
});

test("Plain text with screenplay indentation uses it like PDF x", () => {
  const src = [
    "INT. LAB - NIGHT",
    "",
    "Monitors hum. A centrifuge spins.",
    "",
    "                      DR. VOSS",
    "          Write this down.",
    "                      LEE",
    "          Already am.",
    "",
    "THE POWER DIES",
    "Emergency lights flicker on.",
  ].join("\n");
  const s = parseScript(src, { name: "lab.txt" });
  assert.deepEqual(types(s.scenes[0]), ["action", "character", "dialogue", "character", "dialogue", "action"]);
  assert.deepEqual(s.scenes[0].characters, ["DR. VOSS", "LEE"]);
});

// ---------------------------------------------------------------- pdf.js path

const item = (str, x, y) => ({ str, transform: [12, 0, 0, 12, x, y], width: str.length * 7.2, height: 12 });
const PAGES = [
  [
    item("7", 72, 700), item("EXT. LIGHTHOUSE - NIGHT", 108, 700), item("7", 533, 700),
    item("Waves hammer ", 108, 676), item("the rocks below.", 108 + 13 * 7.2, 676),
    item(" ", 300, 676), { type: "beginMarkedContent" },
    item("A lamp turns in the gallery.", 108, 664),
    item("KEEPER", 252, 640), item("(hoarse)", 223, 628), item("Light's still burning.", 180, 616), item("(MORE)", 252, 604),
  ],
  [item("2.", 504, 750), item("KEEPER (CONT'D)", 252, 720), item("Always is.", 180, 708), item("FADE OUT.", 470, 684)],
];

function fakePdfjs(pages) {
  const lib = {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument({ data }) {
      lib.lastData = data;
      return { promise: Promise.resolve({ numPages: pages.length, getPage: async (n) => ({ getTextContent: async () => ({ items: pages[n - 1] }) }), destroy() {} }) };
    },
  };
  return lib;
}

test("textItemsToLines: baselines join left to right, x kept, scene numbers skipped, gaps become blanks", () => {
  const lines = textItemsToLines(PAGES[0], 1);
  assert.match(lines[0].text, /^7\s+EXT\. LIGHTHOUSE - NIGHT\s{2,}7$/);
  assert.deepEqual(lines.slice(1).map((l) => l.text), [
    "", "Waves hammer the rocks below.", "A lamp turns in the gallery.", "", "KEEPER", "(hoarse)", "Light's still burning.", "(MORE)",
  ]);
  assert.equal(lines[0].x, 108);                                                // not the margin scene number at 72
  assert.equal(lines[2].x, 108);
  assert.equal(lines[5].x, 252);
  assert.equal(lines[7].x, 180);
  assert.ok(lines.every((l) => l.page === 1));
  assert.deepEqual(textItemsToLines(null), []);
  assert.deepEqual(textItemsToLines([{ str: 5 }, { str: "x" }]), []);
});

test("importScriptFile: a PDF goes through pdf.js (stubbed) into the same model", async () => {
  const lib = fakePdfjs(PAGES);
  globalThis.pdfjsLib = lib;
  try {
    const file = new File([new TextEncoder().encode("%PDF-1.4 stub")], "lighthouse.pdf", { type: "application/pdf" });
    const s = await importScriptFile(file);
    assertScriptShape(s);
    assert.equal(lib.GlobalWorkerOptions.workerSrc, PDFJS_WORKER_URL);
    assert.ok(lib.lastData instanceof Uint8Array);
    assert.equal(s.format, "pdf");
    assert.equal(s.source_name, "lighthouse.pdf");
    assert.equal(s.title, "lighthouse");
    assert.equal(s.page_count_est, 2);
    assert.equal(s.scenes.length, 1);
    const sc = s.scenes[0];
    assert.equal(sc.number, "7");
    assert.equal(sc.heading, "EXT. LIGHTHOUSE - NIGHT");
    assert.deepEqual(sc.elements.map((e) => [e.type, e.text]), [
      ["action", "Waves hammer the rocks below. A lamp turns in the gallery."],
      ["character", "KEEPER"], ["parenthetical", "(hoarse)"], ["dialogue", "Light's still burning. Always is."],
      ["transition", "FADE OUT."],
    ]);
    // A PDF with no text layer still imports, with a warning.
    const scan = await importScriptFile(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "scan", {}));
    globalThis.pdfjsLib = fakePdfjs([[], []]);
    const empty = await importScriptFile(new File(["%PDF"], "scan.pdf"));
    assertScriptShape(empty);
    assert.equal(empty.scenes[0].heading, "Whole script");
    assert.match(empty.warnings[0], /no text layer/);
    assert.equal(scan.format, "pdf");                                           // sniffed by magic bytes, no extension
  } finally {
    delete globalThis.pdfjsLib;
  }
});

test("loadPdfJs: exact cdnjs URLs; without a browser it rejects instead of fetching", async () => {
  assert.equal(PDFJS_URL, "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  assert.equal(PDFJS_WORKER_URL, "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");
  await assert.rejects(loadPdfJs(), /needs the browser/);
  const lib = { GlobalWorkerOptions: { workerSrc: "keep-me.js" } };
  globalThis.pdfjsLib = lib;
  try {
    assert.equal(await loadPdfJs(), lib);
    assert.equal(lib.GlobalWorkerOptions.workerSrc, "keep-me.js");              // a host's own worker is left alone
  } finally {
    delete globalThis.pdfjsLib;
  }
});

test("importScriptFile: text formats from File and Blob, encodings", async () => {
  const f = await importScriptFile(new File([FOUNTAIN], "boardwalk.fountain"));
  assert.equal(f.format, "fountain");
  assert.equal(f.scenes.length, 6);
  const blob = new Blob([FDX]);
  blob.name = "stagecoach.fdx";
  const x = await importScriptFile(blob);
  assert.equal(x.format, "fdx");
  assert.equal(x.scenes.length, 4);
  const t = await importScriptFile(new File([TEXT], "orbital_diner.txt"));
  assert.equal(t.format, "text");
  // UTF-8 BOM and Latin-1 bytes both decode.
  const bom = await importScriptFile(new File([new Uint8Array([0xef, 0xbb, 0xbf]), "INT. CAFÉ - DAY\n\nSteam."], "cafe.txt"));
  assert.equal(bom.scenes[0].heading, "INT. CAFÉ - DAY");
  const latin = await importScriptFile(new File([new Uint8Array([...new TextEncoder().encode("INT. CAF"), 0xc9, ...new TextEncoder().encode(" - DAY\n\nSteam.")])], "cafe2.txt"));
  assert.equal(latin.scenes[0].heading, "INT. CAFÉ - DAY");
  await assert.rejects(importScriptFile(null), /File or Blob/);
});

// ---------------------------------------------------------------- breakdown & stage hints

test("Breakdown: cast, extras, vehicles, animals, wardrobe, props from the page", () => {
  const s = fountain();
  const b1 = byNum(s, "1").breakdown;
  assert.deepEqual(b1.cast, ["MARGO", "TEDDY"]);
  assert.deepEqual(b1.extras.sort(), ["crowd", "tourists"]);
  assert.deepEqual(b1.animals, ["seagull"]);
  assert.deepEqual(b1.wardrobe, ["denim jacket"]);
  assert.ok(b1.props.includes("funnel cake"));
  assert.ok(!b1.props.includes("coin"));                                        // "coin-op telescope" is not a coin
  assert.ok(b1.set_dressing.includes("ferris wheel") && b1.set_dressing.includes("carousel") && b1.set_dressing.includes("telescope"));
  assert.deepEqual(b1.stunts, []);                                              // seagulls fighting is not a stunt

  const b2a = byNum(s, "2A").breakdown;
  assert.deepEqual(b2a.vehicles.sort(), ["getaway van", "police car"]);         // heading location counts: INT./EXT. GETAWAY VAN
  assert.deepEqual(b2a.animals, ["dog"]);
  assert.deepEqual(b2a.wardrobe, ["ski mask"]);
  assert.ok(b2a.sound.includes("dog thumps"));                                  // ALL-CAPS sound verb + its noun

  const b3 = byNum(s, "3").breakdown;
  assert.deepEqual(b3.cast, ["GUARD", "MARGO", "MCCLANE"]);
  assert.ok(b3.props.includes("brass key"));                                    // ALL-CAPS prop after an article
  assert.ok(!b3.props.includes("key"));                                         // the generic key folds into it
  assert.ok(b3.props.includes("crowbar") && b3.props.includes("flashlight"));
  assert.deepEqual(b3.stunts, ["leap"]);

  const b2b = byNum(s, "2B").breakdown;
  assert.deepEqual(b2b.sound.sort(), ["radio crackles", "silence"]);
});

test("Breakdown: sfx, sound, music, introduced and silent cast", () => {
  const f = fountain();
  const b4 = byNum(f, "4").breakdown;
  assert.deepEqual(b4.sfx.sort(), ["fireworks", "smoke"]);
  assert.deepEqual(b4.sound, ["firework booms"]);
  assert.deepEqual(b4.music, ['"Moonlight on the Midway"', "jukebox", "song (lyrics in script)"]);
  assert.deepEqual(byNum(f, "1").breakdown.sfx, ["rain"]);
  assert.deepEqual(byNum(f, "2").breakdown.sfx, ["fog"]);
  assert.deepEqual(byNum(f, "1").breakdown.music, ["calliope"]);

  const d = fdx();
  const s1 = d.scenes[0].breakdown;
  assert.deepEqual(s1.cast, ["ADA", "VANCE"]);                                  // SHERIFF ADA COLE (60s) is ADA, not new cast
  assert.ok(!s1.props.includes("sheriff") && !s1.props.includes("cole"));
  assert.deepEqual(s1.vehicles, ["horse-drawn stagecoach"]);
  assert.deepEqual(s1.animals, ["horse"]);
  assert.deepEqual(s1.extras, ["townsfolk"]);
  assert.deepEqual(s1.wardrobe.sort(), ["duster", "spurs"]);
  assert.deepEqual(s1.sound, ["spurs jingle"]);
  assert.deepEqual(s1.props, ["badge"]);                                        // "tin star"
  assert.deepEqual(s1.sfx, ["dust"]);
  const s2 = d.scenes[1].breakdown;
  assert.deepEqual(s2.wardrobe, ["black hat"]);
  assert.deepEqual(s2.props.sort(), ["revolver", "strongbox"]);
  assert.deepEqual(s2.vehicles, ["stagecoach"]);
  const s3 = d.scenes[2].breakdown;
  assert.deepEqual(s3.sfx, ["gunfire"]);
  assert.deepEqual(s3.stunts, ["leap", "tackle", "horse work"]);
  assert.deepEqual(s3.set_dressing, ["water trough"]);
  assert.deepEqual(d.scenes[3].breakdown.sfx, ["rain"]);

  const t = text();
  const t1 = t.scenes[0].breakdown;
  assert.deepEqual(t1.extras, ["patrons"]);
  assert.deepEqual(t1.wardrobe.sort(), ["beehive hairdo", "flight suit"]);
  assert.deepEqual(t1.sound, ["tubes buzz"]);
  assert.ok(!t1.props.includes("pie"));                                         // dialogue is never mined
  assert.deepEqual(t.scenes[1].breakdown.vehicles, ["battered shuttle"]);
  assert.deepEqual(t.scenes[1].breakdown.sound, ["clang"]);
  assert.deepEqual(t.scenes[2].breakdown.animals, ["cat"]);
  assert.deepEqual(t.scenes[2].breakdown.vehicles, ["forklift"]);

  const p = pdf();
  assert.deepEqual(p.scenes[2].breakdown.cast, ["MAREN"]);                       // silent in 6A, named in action
  assert.deepEqual(p.scenes[2].breakdown.stunts, ["leap"]);
  assert.ok(p.scenes[0].breakdown.vehicles.includes("rusted car ferry"));
  assert.deepEqual(p.scenes[0].breakdown.wardrobe, ["oilskin coat"]);
  assert.ok(p.scenes[1].breakdown.sound.includes("whinnies"));
});

test("Stage hints: set id, time of day (carried through CONTINUOUS), weather, library objects", () => {
  const f = fountain();
  const hints = f.scenes.map((x) => x.stage_hint);
  assert.deepEqual(hints.map((h) => h.set), ["beach", "beach", null, "interior", null, "interior"]);
  assert.deepEqual(hints.map((h) => h.time_of_day), ["night", "night", "night", "night", "night", "night"]);
  assert.deepEqual(hints.map((h) => h.weather), ["rain", "fog", null, null, null, null]);
  assert.deepEqual(hints[0].objects, ["bird"]);
  assert.deepEqual(hints[2].objects, ["truck", "dog", "police_car"]);           // van (heading), dog, police car: library.mjs kinds

  const d = fdx();
  assert.deepEqual(d.scenes.map((x) => x.stage_hint.set), ["street_night", "interior", "street_night", "street_night"]);
  assert.deepEqual(d.scenes.map((x) => x.stage_hint.time_of_day), ["day", "day", "day", "dusk"]);
  assert.deepEqual(d.scenes.map((x) => x.stage_hint.weather), [null, null, null, "rain"]);

  const t = text();
  assert.deepEqual(t.scenes.map((x) => x.stage_hint.set), ["interior", null, "interior"]);  // the outside of a diner is not the diner
  assert.deepEqual(t.scenes.map((x) => x.stage_hint.time_of_day), ["night", "night", "day"]);

  const p = pdf();
  assert.deepEqual(p.scenes.map((x) => x.stage_hint.time_of_day), ["dawn", "dawn", "day"]);
  assert.deepEqual(p.scenes.map((x) => x.stage_hint.weather), ["fog", null, "snow"]);
  assert.equal(p.scenes[0].stage_hint.set, "beach");
  assert.ok(p.scenes[1].stage_hint.objects.includes("horse"));

  assert.equal(timeOfDay("PRE-DAWN"), "dawn");
  assert.equal(timeOfDay("NIGHTFALL"), "dusk");
  assert.equal(timeOfDay("LATE AFTERNOON"), "day");
  assert.equal(timeOfDay("CONTINUOUS"), null);
  const lone = { location: "", int_ext: "", time: "", heading: "", elements: [{ type: "action", text: "Dawn breaks over the dunes." }] };
  assert.deepEqual(stageHint(lone, { prevTime: "night" }), { set: "desert", time_of_day: "dawn", weather: null, objects: [] });
  assert.equal(stageHint({ ...lone, elements: [], time: "LATER" }, { prevTime: "night" }).time_of_day, "night");
});

test("Breakdown tables mirror the catalog and library", () => {
  // Same set ids and first-match order as soundstage/agent/catalog.py SET_WORDS.
  assert.deepEqual(SET_WORDS.map(([id]) => id), ["water_tank", "beach", "open_water", "stadium", "studio", "forest", "desert", "interior", "empty", "street_night", "plaza"]);
  for (const [id] of SET_WORDS) assert.ok(SET_IDS.includes(id));
  assert.deepEqual(libraryObjects("A police officer sinks into a sofa next to the squad car. Gunfire. He fires twice."), ["sofa", "police_car"]);
  assert.deepEqual(libraryObjects("A man and a woman ride a horse past the street lamp."), ["horse", "lamp"]);
  // breakdownScene works on a bare scene object too.
  const b = breakdownScene({ elements: [{ type: "action", text: "The TRAIN WHISTLE blows. A crowd waves." }], characters: [] });
  assert.deepEqual(b.extras, ["crowd"]);
  assert.ok(b.sound.includes("train whistle"));
});

// ---------------------------------------------------------------- outline, prompt, summary

test("Outline is extractive: the first action sentences, trimmed", () => {
  const f = fountain();
  assert.equal(byNum(f, "1").outline, "Rain spits on the boardwalk. A Ferris wheel turns, half its bulbs dead.");
  for (const sc of [...f.scenes, ...fdx().scenes, ...text().scenes, ...pdf().scenes]) {
    const source = sc.elements.filter((e) => e.type === "action").map((e) => e.text.replace(/\s+/g, " ")).join(" ");
    const o = sc.outline.replace(/…$/, "");
    if (source) assert.ok(source.startsWith(o), `${sc.id}: ${o}`);
  }
  const long = parseScript(`INT. HALL - DAY\n\n${"Word ".repeat(80)}ends here.`, { name: "x.txt" });
  assert.ok(long.scenes[0].outline.length <= 180);
  assert.match(long.scenes[0].outline, /…$/);
  const talk = parseScript("INT. CAR - NIGHT\n\nBOB\nWe should go.\n", { name: "x.txt" });
  assert.equal(talk.scenes[0].outline, 'BOB: "We should go."');
});

test("sceneSummaryLine and buildPromptForScene", () => {
  const f = fountain();
  assert.equal(sceneSummaryLine({ number: "12A", heading: "INT. DINER - NIGHT", eighths: 11 }), "Sc 12A · INT. DINER - NIGHT · 1 3/8 pg");
  assert.match(sceneSummaryLine(byNum(f, "2A")), /^Sc 2A · INT\.\/EXT\. GETAWAY VAN - CONTINUOUS · (?:\d+(?: \d\/8)?|\d\/8) pg$/);
  const p = buildPromptForScene(byNum(f, "1"));
  assert.match(p, /^Location: seaside amusement pier \(exterior\)\./);   // place first; no raw "EXT." (reads as a set keyword)
  assert.doesNotMatch(p, /\b(?:INT|EXT)\./);
  assert.match(p, /Time: night\./);
  assert.match(p, /Weather: rain\./);
  assert.match(p, /Cast: two people \(Margo, Teddy\)\./);                     // counted, so the rules agent makes two figures
  assert.match(p, /Rain spits on the boardwalk\./);
  assert.doesNotMatch(p, /Lights on the wheel/);                                // dialogue stays out
  const q = buildPromptForScene(byNum(f, "2A"));
  assert.match(q, /Time: night \(continuous\)\./);
  const d = buildPromptForScene(fdx().scenes[0]);
  assert.match(d, /Time: day \(high noon\)\./);
  const long = parseScript(`EXT. FIELD - DAY\n\n${"Grass sways in the wind. ".repeat(60)}`, { name: "x.txt" });
  const lp = buildPromptForScene(long.scenes[0]);
  const actionPart = lp.split("\n").at(-1);
  assert.ok(actionPart.length <= 300 && actionPart.endsWith("…"));
  assert.equal(typeof buildPromptForScene(null), "string");
});

// ---------------------------------------------------------------- revised drafts

test("mergeNotes: numbered drafts match by scene number; notes, shot links and app keys carry; lost notes are kept", () => {
  const v1 = fountain();
  const set = (n, patch) => Object.assign(byNum(v1, n), patch);
  set("1", { notes: "Wide on the wheel first.", shots: ["shot_a", "shot_b"] });
  set("2B", { notes: "Keep it dark." });
  set("3", { notes: "Mirror gag: three setups.", color: "blue" });
  set("4", { notes: "Cut if long.", shots: ["shot_z"] });

  const revised = FOUNTAIN
    .replace("EST. HARBOR LIGHTHOUSE - NIGHT #2#", "EXT. PIER - SNACK BAR - NIGHT #1A#\n\nA vendor pulls down the shutter.\n\nEST. HARBOR LIGHTHOUSE - NIGHT #2#")
    .replace("I/E. FUNHOUSE - MOMENTS LATER #3#", "INT. FUNHOUSE - HALL OF MIRRORS - MOMENTS LATER #3#")
    .replace(/INT\. TICKET BOOTH[\s\S]*?(?=> FADE OUT\.)/, "");
  const v2 = parseScript(revised, { name: "boardwalk_v2.fountain" });
  assert.deepEqual(v2.scenes.map((x) => x.number), ["1", "1A", "2", "2A", "2B", "3"]);
  const m = mergeNotes(v1, v2);
  assertScriptShape({ ...m, scenes: m.scenes.map((x) => ({ ...x, notes: "" })) });
  const by = (n) => m.scenes.find((x) => x.number === n);
  assert.equal(by("1").notes, "Wide on the wheel first.");
  assert.deepEqual(by("1").shots, ["shot_a", "shot_b"]);
  assert.equal(by("1A").notes, "");
  assert.equal(by("1A").shots, undefined);
  assert.equal(by("2B").notes, "Keep it dark.");                               // unnumbered: matched by heading
  assert.equal(by("3").notes, "Mirror gag: three setups.");                    // heading changed, number kept
  assert.equal(by("3").color, "blue");
  assert.deepEqual(m.orphans, [{ id: "sc_4", number: "4", heading: "INT. TICKET BOOTH - NIGHT", notes: "Cut if long.", shots: ["shot_z"] }]);
  assert.deepEqual(m.scenes.map((x) => x.id), ["sc_1", "sc_1A", "sc_2", "sc_2A", "sc_2B", "sc_3"]);
  // Inputs are not mutated.
  assert.equal(v2.scenes[0].notes, "");
  assert.equal(v2.orphans, undefined);
});

test("mergeNotes: unnumbered drafts match by heading and action, not by position", () => {
  const v1 = parseScript([
    "INT. KITCHEN - DAY", "", "Jane Doe burns the toast.", "",
    "EXT. GARDEN - NIGHT", "", "John Doe digs a hole under the apple tree.", "",
    "INT. KITCHEN - NIGHT", "", "The toaster sits in the bin.",
  ].join("\n"), { name: "v1.txt" });
  v1.scenes[0].notes = "Toast close-up.";
  v1.scenes[1].notes = "Dig in one take.";
  v1.scenes[2].notes = "Empty kitchen.";
  v1.scenes[2].shots = ["s9"];
  const v2 = parseScript([
    "EXT. STREET - DAY", "", "A mail truck rattles past.", "",
    "INT. KITCHEN - DAY", "", "Jane Doe burns the toast again.", "",
    "EXT. BACK GARDEN - NIGHT", "", "John Doe digs a hole under the apple tree.", "",
    "INT. KITCHEN - NIGHT", "", "The toaster sits in the bin.",
  ].join("\n"), { name: "v2.txt" });
  assert.deepEqual(v2.scenes.map((x) => x.id), ["sc_1", "sc_2", "sc_3", "sc_4"]);  // index ids shift when a scene is inserted
  const m = mergeNotes(v1, v2);
  assert.deepEqual(m.scenes.map((x) => x.notes), ["", "Toast close-up.", "Dig in one take.", "Empty kitchen."]);
  // ...so matched scenes keep their old ids (host shots linked by scene_id stay put) and the new scene takes a fresh one.
  assert.deepEqual(m.scenes.map((x) => x.id), ["sc_1_2", "sc_1", "sc_2", "sc_3"]);
  assert.equal(new Set(m.scenes.map((x) => x.id)).size, 4);
  assert.deepEqual(m.scenes[3].shots, ["s9"]);
  assert.deepEqual(m.orphans, []);
  assert.deepEqual(mergeNotes(null, v2).scenes.map((x) => x.notes), ["", "", "", ""]);
  assert.deepEqual(mergeNotes(v1, null).orphans.length, 3);
});

// ---------------------------------------------------------------- robustness

test("Never throws: odd inputs, broken files, no sluglines", () => {
  const odd = [null, undefined, 42, {}, [], { lines: null }, { lines: [null, 3, { text: null }, { text: "INT. X - DAY", x: "nope" }] },
    "", "   \n\n  ", "\u0000\u0001\u0002 binary �", "[[ unclosed note", "/* unclosed boneyard", "Title: Only a title page",
    '<FinalDraft><Paragraph Type="Scene Heading"><Text>INT. X', "<FinalDraft></FinalDraft>", "%PDF-1.4 binary-ish",
    "INT.\n\nEXT.\n\n.\n\n@\n\n~\n\n>\n\n<\n\n=\n\n#\n\n===", "A\n".repeat(5000), "(MORE)\n(CONTINUED)\n23.\n"];
  for (const input of odd) {
    let s;
    assert.doesNotThrow(() => { s = parseScript(input, { name: "odd" }); }, String(input).slice(0, 40));
    assertScriptShape(s);
  }
  for (const fmt of ["fountain", "fdx", "text", "pdf", "weird"]) assertScriptShape(parseScript("INT. A - DAY\n\nB.", { format: fmt }));

  const whole = parseScript("Jane Doe walks to the window.\n\nShe waits.\n\nJOHN\nAre you coming?", { name: "notes.txt" });
  assert.equal(whole.scenes.length, 1);
  assert.equal(whole.scenes[0].heading, "Whole script");
  assert.equal(whole.scenes[0].id, "sc_1");
  assert.deepEqual(whole.scenes[0].characters, ["JOHN"]);
  assert.equal(whole.title, "notes");

  const broken = parseScript('<FinalDraft><Content><Paragraph Type="Action"><Text>INT. CELLAR - NIGHT', { name: "broken.fdx" });
  assert.equal(broken.format, "text");                                          // not readable FDX: the words, as text
  assert.equal(broken.scenes[0].heading, "INT. CELLAR - NIGHT");

  // Seeded fuzz over screenplay-ish fragments.
  const parts = ["INT. ROOM - DAY", "EXT. ROAD #3#", ".FORCED", "BOB", "BOB ^", "(beat)", "Hi.", "", "CUT TO:", "> X <", "> Y", "~la",
    "= syn", "# Act", "[[n]]", "/*", "*/", "===", "(MORE)", "12 INT. A - B 12", "CONTINUED:", "2.", "@x", "!LOUD", "*a* _b_ **c**"];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 0; n < 150; n++) {
    const src = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => parts[Math.floor(rnd() * parts.length)]).join("\n");
    for (const fmt of ["fountain", "text"]) assertScriptShape(parseScript(src, { format: fmt }));
    assertScriptShape(parseScript({ lines: src.split("\n").map((t) => ({ text: t, x: 60 + rnd() * 400 })) }));
  }
});

test("mergeNotes: character scene lists follow the kept ids; an orphan's id is never reused", () => {
  const v1 = parseScript("INT. A - DAY\n\nBOB\nOne.\n\nINT. B - DAY\n\nBOB\nTwo.\n\nINT. C - DAY\n\nNobody here.", { name: "v1.txt" });
  v1.scenes[2].notes = "Lose this?";
  const v2 = parseScript("INT. NEW - DAY\n\nBOB\nZero.\n\nINT. A - DAY\n\nBOB\nOne.\n\nINT. B - DAY\n\nBOB\nTwo.", { name: "v2.txt" });
  const m = mergeNotes(v1, v2);
  assert.deepEqual(m.scenes.map((x) => x.id), ["sc_1_2", "sc_1", "sc_2"]);
  assert.deepEqual(m.characters.find((c) => c.name === "BOB").scenes, ["sc_1_2", "sc_1", "sc_2"]);
  assert.deepEqual(m.orphans.map((o) => [o.id, o.notes]), [["sc_3", "Lose this?"]]);
  assert.ok(!m.scenes.some((x) => x.id === "sc_3"));
  assert.deepEqual(v2.characters.find((c) => c.name === "BOB").scenes, ["sc_1", "sc_2", "sc_3"]);  // input untouched
});

// ---------------------------------------------------------------- review regressions

const F = (t) => parseScript(t, { format: "fountain" });
const els = (sc) => sc.elements.map((e) => `${e.type}${e.character ? `(${e.character})` : ""}:${e.text}`);

test("mergeNotes: a new scene never takes an orphan's id, even a draft later", () => {
  const d1 = F("INT. KITCHEN - DAY\n\nJane cooks eggs.\n\nEXT. GARDEN - DAY\n\nJohn digs a hole.\n\nINT. GARAGE - NIGHT\n\nThe car is covered in dust.\n");
  Object.assign(d1.scenes[2], { notes: "Garage: low angle", shots: ["shot_9"] });
  const m2 = mergeNotes(d1, F("INT. KITCHEN - DAY\n\nJane cooks eggs.\n\nEXT. GARDEN - DAY\n\nJohn digs a hole.\n"));
  assert.deepEqual(m2.orphans.map((o) => o.id), ["sc_3"]);
  const m3 = mergeNotes(m2, F("INT. KITCHEN - DAY\n\nJane cooks eggs.\n\nEXT. GARDEN - DAY\n\nJohn digs a hole.\n\nEXT. BEACH - SUNSET\n\nWaves crash.\n"));
  assert.deepEqual(m3.scenes.map((x) => x.id), ["sc_1", "sc_2", "sc_3_2"]);
  assert.deepEqual(m3.orphans.map((o) => [o.id, o.shots]), [["sc_3", ["shot_9"]]]);
});

test("mergeNotes: a scene number only matches when the scene still looks the same", () => {
  const a = F("INT. KITCHEN - DAY #1#\n\nJane cooks eggs.\n\nEXT. GARDEN - DAY #2#\n\nJohn digs a hole.\n");
  a.scenes[0].notes = "kitchen note"; a.scenes[1].notes = "garden note";
  const b = F("EXT. HIGHWAY - NIGHT #1#\n\nA truck roars past.\n\nINT. KITCHEN - DAY #2#\n\nJane cooks eggs.\n\nEXT. GARDEN - DAY #3#\n\nJohn digs a hole.\n");
  const m = mergeNotes(a, b);
  assert.deepEqual(m.scenes.map((x) => [x.heading, x.notes]),
    [["EXT. HIGHWAY - NIGHT", ""], ["INT. KITCHEN - DAY", "kitchen note"], ["EXT. GARDEN - DAY", "garden note"]]);
  assert.deepEqual(m.scenes.map((x) => x.id), ["sc_1_2", "sc_1", "sc_2"]);   // notes and ids follow the scene, not the number
  // Repeated numbers: the best match among them wins, not the first.
  const c = F("INT. A - DAY #4#\n\nx.\n\nINT. B - DAY #4#\n\ny.\n");
  c.scenes[1].notes = "B note";
  const swapped = mergeNotes(c, F("INT. B - DAY #4#\n\ny.\n\nINT. A - DAY #4#\n\nx.\n"));
  assert.deepEqual(swapped.scenes.map((x) => [x.heading, x.notes]), [["INT. B - DAY", "B note"], ["INT. A - DAY", ""]]);
});

test("mergeNotes stays fast on a long unnumbered script", () => {
  let t = "";
  for (let i = 0; i < 600; i++) t += `INT. ROOM ${i} - NIGHT\n\nMaya crosses to window ${i}. A dog barks.\n\nMAYA\nWho's there?\n\n`;
  const a = F(t), b = F(t);
  a.scenes[300].notes = "middle";
  const t0 = performance.now();
  const m = mergeNotes(a, b);
  assert.ok(performance.now() - t0 < 2000, "merge took too long");
  assert.equal(m.scenes[300].notes, "middle");
  assert.equal(m.scenes[300].id, a.scenes[300].id);
});

test("plain text: a number spoken as dialogue is not a page number", () => {
  const s = parseScript("INT. BAR - NIGHT\n\nAna counts the cash.\n\nBOB\nHow much?\n\nANA\n400.\n\nBOB\nAnd the year?\n\nANA\n1985\n\nBob nods.\n\n12.\n", { format: "text" });
  assert.deepEqual(els(s.scenes[0]), ["action:Ana counts the cash.", "character(BOB):BOB", "dialogue(BOB):How much?", "character(ANA):ANA",
    "dialogue(ANA):400.", "character(BOB):BOB", "dialogue(BOB):And the year?", "character(ANA):ANA", "dialogue(ANA):1985", "action:Bob nods."]);
  assert.deepEqual(s.characters.map((c) => c.name).sort(), ["ANA", "BOB"]);
  assert.deepEqual(s.scenes[0].breakdown.props, ["cash"]);
  // PDF lines: in the dialogue column it is speech; at the top right of a page it is the page number.
  const L = (text, x, page = 1) => ({ text, x, page });
  const p = parseScript({ lines: [L("2.", 500), { text: "", page: 1 }, L("INT. BAR - NIGHT", 108), { text: "", page: 1 }, L("ANA", 252),
    L("400.", 180), { text: "", page: 1 }, L("Bob nods.", 108)] }, { format: "pdf" });
  assert.deepEqual(els(p.scenes[0]), ["character(ANA):ANA", "dialogue(ANA):400.", "action:Bob nods."]);
});

test("Fountain: a heading needs a blank line before it, so 'Est. 1892' in a paragraph stays action", () => {
  const s = F("INT. TOWN HALL - DAY\n\nA plaque on the wall.\nEst. 1892 by the founders.\n\nShe reads it.\n");
  assert.equal(s.scenes.length, 1);
  assert.deepEqual(els(s.scenes[0]), ["action:A plaque on the wall.\nEst. 1892 by the founders.", "action:She reads it."]);
  assert.equal(s.scenes[0].stage_hint.set, "interior");          // INT scenes never get an exterior set ("town" -> street)
  assert.equal(F("INT. LAKE HOUSE - NIGHT\n\nQuiet.\n").scenes[0].stage_hint.set, "interior");
  assert.equal(F("INT. FISHING BOAT - NIGHT\n\nWaves.\n").scenes[0].stage_hint.set, "open_water");  // a vehicle keeps its set
  assert.equal(F("EXT. TOWN SQUARE - DAY\n\nPigeons.\n").scenes[0].stage_hint.set, "street_night");
  // A real heading right after action (no blank after) still counts when it looks like one.
  assert.equal(F("INT. A - DAY\n\nShe waits.\n\nEXT. ROAD - NIGHT\nCars pass.\n").scenes.length, 2);
});

test("breakdown: short forms of speaking characters' names are cast, not props", () => {
  const s = F(`INT. PRECINCT - NIGHT\n\nO'HARA enters. COP #2 nods. GUARD 2 yawns. DR. SMITH waves. The SHERIFF'S BADGE glints. BIG TONY sits.\n\n` +
    `MRS. O'HARA\nEvening.\n\nCOP #2\nMa'am.\n\nGUARD 2\nYo.\n\nDR. SMITH\nHm.\n\nBIG TONY (V.O.)\nHey.\n`);
  assert.deepEqual(s.scenes[0].breakdown.props, ["sheriff's badge"]);
  assert.deepEqual(s.scenes[0].breakdown.cast, ["MRS. O'HARA", "COP #2", "GUARD 2", "DR. SMITH", "BIG TONY"]);
});

test("PDF: a title-page contact block at the left edge does not shift the dialogue bands", () => {
  const L = (text, x, page = 1) => ({ text, x, page });
  const B = (page = 1) => ({ text: "", page });
  const lines = [L("SHORT ONE", 250), B(), L("Written by", 270), B(), L("Jane Doe", 276), B(),
    L("Jane Doe Productions", 72), L("123 Fake Street", 72), L("Springfield", 72), L("jane@example.com", 72), B(2),
    L("1     INT. OFFICE - DAY     1", 72, 2), B(2), L("Ana reads a file.", 108, 2), B(2),
    L("BEN", 252, 2), L("(beat)", 223, 2), L("WHY ME", 180, 2), L("of all people?", 180, 2), B(2), L("Ben leaves.", 108, 2)];
  const s = parseScript({ lines }, { format: "pdf" });
  assert.deepEqual(els(s.scenes[0]), ["action:Ana reads a file.", "character(BEN):BEN", "parenthetical(BEN):(beat)",
    "dialogue(BEN):WHY ME of all people?", "action:Ben leaves."]);
  assert.deepEqual(s.characters.map((c) => c.name), ["BEN"]);
});

test("parseHeading: trailing qualifiers and unspaced dashes", () => {
  assert.deepEqual(parseHeading("EXT. STREET - DAY - FLASHBACK"), { int_ext: "EXT", location: "STREET", time: "DAY - FLASHBACK" });
  assert.deepEqual(parseHeading("INT. BAR - NIGHT - CONTINUOUS"), { int_ext: "INT", location: "BAR", time: "NIGHT - CONTINUOUS" });
  assert.deepEqual(parseHeading("EXT. ROOFTOP-NIGHT"), { int_ext: "EXT", location: "ROOFTOP", time: "NIGHT" });
  assert.deepEqual(parseHeading("INT. X-RAY ROOM - DAY"), { int_ext: "INT", location: "X-RAY ROOM", time: "DAY" });
  assert.deepEqual(parseHeading("INT. DAY CARE CENTER - DAY"), { int_ext: "INT", location: "DAY CARE CENTER", time: "DAY" });
  assert.deepEqual(parseHeading("INT. DINER - MORNING SHOW SET - DAY"), { int_ext: "INT", location: "DINER - MORNING SHOW SET", time: "DAY" });
  const s = F("EXT. A - NIGHT\n\nDark.\n\nEXT. STREET - DAY - FLASHBACK\n\nKids play.\n");
  assert.equal(s.scenes[1].stage_hint.time_of_day, "day");
});

test("plain text: lower-case sluglines on their own line start scenes", () => {
  const s = parseScript("int. house - day\n\nShe waits.\n\nint. barn - night\n\nHe waits.\n", { format: "text" });
  assert.deepEqual(s.scenes.map((x) => [x.heading, x.time]), [["INT. HOUSE - DAY", "DAY"], ["INT. BARN - NIGHT", "NIGHT"]]);
  assert.equal(matchSlug("int. house - day"), null);                    // only when the caller knows it stands alone
  assert.deepEqual(matchSlug("int. house - day", { alone: true }), { heading: "INT. HOUSE - DAY", number: null });
  assert.equal(matchSlug("Int. trouble is coming - she knows it", { alone: true }), null);
  assert.equal(parseScript("INT. A - DAY\n\nInt. design is her passion.\n", { format: "text" }).scenes.length, 1);
});

test("breakdown: screenplay conventions and on-screen text are not props; CUT lines are transitions", () => {
  const s = F(`INT. LOBBY - NIGHT\n\nWe HEAR footsteps. We SEE a shadow. The CEO enters. SUPER: "NEW YORK, 1985". A text message: "WHERE ARE YOU". ` +
    `She shouts "HELP!" The sign reads EXIT. He's an EMT. A BRASS KEY glints.\n\nSMASH CUT:\n\nINT. ROOF - NIGHT\n\nWind.\n\nJUMP CUT.\n`);
  assert.deepEqual(s.scenes[0].breakdown.props, ["brass key"]);
  assert.deepEqual(s.scenes[0].breakdown.sound, ["footsteps"]);
  assert.equal(s.scenes[0].elements.at(-1).type, "transition");
  assert.equal(s.scenes[1].elements.at(-1).type, "transition");
  const t = parseScript("INT. HALL - NIGHT\n\nShe runs.\n\nMATCH CUT:\n\nINT. ROOF - NIGHT\n\nWind.\n", { format: "text" });
  assert.deepEqual(types(t.scenes[0]), ["action", "transition"]);
});

test("breakdown: a name that is an everyday word is not cast from a sentence start", () => {
  const s = F("INT. A - DAY\n\nWILL\nHi.\n\nINT. B - NIGHT\n\nMay sleeps. Will she wake? Hope fades.\n\nMAY\nZzz.\n\n" +
    "INT. C - NIGHT\n\nNobody here. Later, Will knocks. HOPE waits.\n\nMAY\nHm.\n\nINT. D - NIGHT\n\nNo hope left.\n\nHOPE\nOk.\n");
  assert.deepEqual(s.scenes.map((x) => x.breakdown.cast), [["WILL"], ["MAY"], ["MAY", "WILL", "HOPE"], ["HOPE"]]);
  assert.deepEqual(s.characters.find((c) => c.name === "WILL").scenes, ["sc_1", "sc_3"]);
});

test("compactScript drops what hydrateScript re-derives; the round trip is the same Script", () => {
  for (const s of [fountain(), fdx(), text(), pdf()]) {
    const m = mergeNotes(s, s);
    m.scenes[0].notes = "Keep me.";
    m.scenes[0].shots = ["shot_1"];
    const c = compactScript(m);
    assert.equal(c.characters, undefined);
    for (const sc of c.scenes) for (const k of ["breakdown", "stage_hint", "outline", "characters"]) assert.equal(sc[k], undefined, k);
    assert.ok(JSON.stringify(c).length < JSON.stringify(m).length * 0.8);
    assert.deepEqual(hydrateScript(JSON.parse(JSON.stringify(c))), m);
    assert.equal(m.scenes[0].breakdown != null, true);               // input untouched
  }
  assert.equal(hydrateScript(null), null);
});

test("stageSetupForScene and a prompt the rules agent can count", () => {
  const f = fountain();
  const sc = byNum(f, "1");
  assert.deepEqual(stageSetupForScene(sc), { set: sc.stage_hint.set, weather: "rain", time_preset: "night" });
  assert.deepEqual(stageSetupForScene({ stage_hint: { set: "beach", time_of_day: "dusk", weather: null } }), { set: "beach", weather: "none", time_preset: "magic_hour" });
  assert.deepEqual(stageSetupForScene({ stage_hint: { set: null, time_of_day: "day" } }).time_preset, "midday");
  assert.deepEqual(stageSetupForScene(null), { set: null, weather: "none", time_preset: null });
  const one = buildPromptForScene(F("INT. CAR - NIGHT\n\nBOB\nGo.\n").scenes[0]);
  assert.match(one, /Cast: one person \(Bob\)\./);
  const song = buildPromptForScene(F('EXT. MAIN STREET - NIGHT\n\nThe jukebox plays "Blue Desert Rain" through the door.\n').scenes[0]);
  assert.doesNotMatch(song, /Desert|Rain/);                       // quoted titles do not pick the set or the weather
});
