// node --test tests/js/   (the start screen's pure half, web/project/home.mjs: when it shows on its own, sorting and
// search, the thumbnail fallback, the counts line, arrow keys across the grid)
import test from "node:test";
import assert from "node:assert/strict";

import { shouldShowHome, launchEnabled, setLaunchEnabled, sortProjects, filterProjects, thumbFallback, countsLine, gridMove } from "../../web/project/home.mjs";
import { splashMs } from "../../web/project/splash.mjs";

const BLANK = { nodes: [{ type: "SoundstageStage" }], extra: {} };

test("when to show: the App always opens on the project screen, once per page load, never in the try-it demo", () => {
  assert.equal(shouldShowHome(), true);                                  // a new page load, any workflow (blank or a restored project)
  assert.equal(shouldShowHome({ shown: true }), false);                  // already shown on this page load
  assert.equal(shouldShowHome({ tryit: true }), false);                  // the demo has its own front door
  assert.equal(shouldShowHome({ launch: false }), false);                // "Show this screen when Soundstage opens" is off
  assert.equal(shouldShowHome({ launch: true }), true);
});

test("the launch preference defaults on and survives a blocked localStorage", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(launchEnabled(), true);
  setLaunchEnabled(false);
  assert.equal(launchEnabled(), false);
  setLaunchEnabled(true);
  assert.equal(launchEnabled(), true);
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(launchEnabled(), true);
  assert.doesNotThrow(() => setLaunchEnabled(false));
  delete globalThis.localStorage;
});

test("the splash is a beat, shorter with reduced motion", () => {
  assert.equal(splashMs(), 1600);
  assert.equal(splashMs({ reduced: true }), 600);
});

const LIST = [
  { name: "beta", saved_at: 3 }, { name: "Alpha", saved_at: 1 }, { name: "Film 10", saved_at: 2 }, { name: "Film 2", saved_at: 2 },
];

test("sort: recent (newest first, ties by name) and name (A→Z, numbers in order); the input is left alone", () => {
  assert.deepEqual(sortProjects(LIST).map((p) => p.name), ["beta", "Film 2", "Film 10", "Alpha"]);
  assert.deepEqual(sortProjects(LIST, "name").map((p) => p.name), ["Alpha", "beta", "Film 2", "Film 10"]);
  assert.equal(LIST[0].name, "beta");
  assert.deepEqual(sortProjects(null), []);
});

test("search: every word, any case, accents folded", () => {
  assert.deepEqual(filterProjects(LIST, "film").map((p) => p.name), ["Film 10", "Film 2"]);
  assert.deepEqual(filterProjects(LIST, "FILM 10").map((p) => p.name), ["Film 10"]);
  assert.deepEqual(filterProjects([{ name: "Café Noir" }], "cafe").length, 1);
  assert.equal(filterProjects(LIST, "").length, 4);
  assert.equal(filterProjects(LIST, "zzz").length, 0);
});

test("thumbnail fallback: the first letter or digit, a stable colour", () => {
  const a = thumbFallback("my film"), b = thumbFallback("my film");
  assert.equal(a.initial, "M");
  assert.equal(a.color, b.color);
  assert.match(a.color, /^#[0-9a-f]{6}$/);
  assert.equal(thumbFallback("  (2) take").initial, "2");
  assert.equal(thumbFallback("").initial, "?");
  assert.equal(thumbFallback("élan").initial, "É");
});

test("counts line", () => {
  assert.equal(countsLine({ scenes: 3, shots: 12, takes: 40 }), "3 scenes · 12 shots · 40 takes");
  assert.equal(countsLine({ scenes: 1, shots: 1, takes: 0 }), "1 scene · 1 shot");
  assert.equal(countsLine({}), "Empty");
});

test("arrow keys across the grid", () => {
  // 7 cards, 3 across:  0 1 2 / 3 4 5 / 6
  assert.equal(gridMove(0, "ArrowRight", 3, 7), 1);
  assert.equal(gridMove(0, "ArrowLeft", 3, 7), 0);
  assert.equal(gridMove(1, "ArrowDown", 3, 7), 4);
  assert.equal(gridMove(4, "ArrowDown", 3, 7), 4);     // nothing under it: stays
  assert.equal(gridMove(3, "ArrowDown", 3, 7), 6);
  assert.equal(gridMove(1, "ArrowUp", 3, 7), 1);
  assert.equal(gridMove(6, "ArrowRight", 3, 7), 6);
  assert.equal(gridMove(5, "Home", 3, 7), 0);
  assert.equal(gridMove(0, "End", 3, 7), 6);
  assert.equal(gridMove(2, "Enter", 3, 7), 2);
  assert.equal(gridMove(0, "ArrowDown", 3, 0), -1);
});
