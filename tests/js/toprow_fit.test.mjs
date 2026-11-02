// The App at 1024 pt wide (Mike's iMac), QA 2026-11-02:
//  1. the full workspace's top row held 1127 px in a 982 px row: Director, Guide and Done ran past the window's edge.
//     Now it folds the least used buttons into a "⋯" menu (web/ui/toprow.mjs) until it fits.
//  2. the open Physics panel covered the shot strip's clips at 1024x640 and 1280x800: it now ends above the timeline
//     bar, or docks over the Properties column (and the bar ends where that column starts).
//  3. "+ Shot" (.ss-primary) turned dark with dark text on hover: ".ss-stage button:hover:not(:disabled)" out-ranked
//     ".ss-stage .ss-primary:hover".
// The live check is tools/qa/toprow_check.mjs (hidden Chrome at 1024x640 and 1280x800).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { foldUntilFits, buttonName, buttonDesc, FOLDED } from "../../web/ui/toprow.mjs";
import { STEPS, TOOLS } from "../../tools/qa/toprow_check.mjs";
import { CASES } from "../../tools/qa/popover_sweep.mjs";

const read = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), "utf8");
const theme = read("ui/theme.mjs"), canvasui = read("ui/canvasui.mjs"), phys = read("stage/physpanel.mjs"), main = read("soundstage.js");
const rules = (css, sel) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].trim().split(/\s*,\s*/).some((s) => s.replace(/\s+/g, " ").trim() === sel)).map((m) => m[2]);

/** A row of fixed-width buttons in `room` px (gap 6): what foldUntilFits does with it. */
function row(widths, room, moreW = 33, gap = 6) {
  const items = Object.entries(widths).map(([name, w]) => ({ name, w, folded: false }));
  let more = false;
  const width = () => items.filter((b) => !b.folded).reduce((a, b) => a + b.w + gap, 0) + (more ? moreW + gap : 0);
  return {
    items,
    run: (order) => foldUntilFits({
      order: order.map((n) => items.find((b) => b.name === n)),
      overflows: () => width() > room,
      fold: (b) => { b.folded = true; },
      unfoldAll: () => { for (const b of items) b.folded = false; },
      showMore: (on) => { more = on; },
    }).map((b) => b.name),
    width,
    get more() { return more; },
  };
}

// the 1024-wide row as measured before the fix (QA sweep 2026-11-02): 1127 px of content, 982 px of room
const ROW = { brand: 20, steps: 549, scene: 96, undo: 36, redo: 36, presets: 33, tools: 46, keys: 33, book: 33, director: 33, guide: 36, done: 32 };
const ORDER = ["keys", "book", "guide", "presets", "director", "redo", "undo"];

test("the 1024 row folds the least used buttons, and only as many as it must", () => {
  const r = row(ROW, 980);
  const folded = r.run(ORDER);
  assert.ok(r.width() <= 980, `the row fits (${r.width()} px in 980)`);
  assert.ok(r.more, "the ⋯ button shows");
  assert.deepEqual(folded, ORDER.slice(0, folded.length), "they fold in priority order");
  assert.ok(folded.length < ORDER.length, "undo stays in the row");
  for (const keep of ["steps", "scene", "tools", "done"]) assert.ok(!folded.includes(keep));
  // one button fewer would not fit
  const r2 = row(ROW, 980);
  r2.run(ORDER.slice(0, folded.length - 1));
  assert.ok(r2.width() > 980, "no button folds that did not have to");
});

test("a wide window folds nothing and hides ⋯; a re-fit after a resize starts from scratch", () => {
  const r = row(ROW, 1600);
  assert.deepEqual(r.run(ORDER), []);
  assert.equal(r.more, false);
  const n = row(ROW, 900);
  const a = n.run(ORDER);
  assert.ok(a.length > 0);
  n.items.forEach((b) => { if (b.name === "steps") b.w = 300; });   // a shorter row (another step's names)
  const b = n.run(ORDER);
  assert.ok(b.length < a.length, "buttons come back when there is room");
});

test("menu words come from the button: its label, else its tooltip up to ':' or the shortcut hint", () => {
  const btn = (title, lbl) => ({ title, getAttribute: (k) => (k === "aria-label" ? null : null), textContent: lbl || "",
    querySelector: (q) => (q === ".lbl" && lbl ? { textContent: ` ${lbl}` } : null) });
  assert.equal(buttonName(btn("Presets: one-click camera moves (P)", "Presets")), "Presets");
  assert.equal(buttonName(btn("Keyboard shortcuts: every key and mouse move in one list (?)")), "Keyboard shortcuts");
  assert.equal(buttonName(btn("Redo (Shift+Ctrl+Z)")), "Redo");
  assert.equal(buttonDesc(btn("Keyboard shortcuts: every key and mouse move in one list (?)")), "every key and mouse move in one list (?)");
  assert.equal(buttonDesc(btn("Redo (Shift+Ctrl+Z)")), "");
});

test("the App wires it: ⋯ before Done, folded buttons hidden, steps / scene / Tools / Done never in the fold order", () => {
  assert.match(main, /import \{ topRowFit \} from "\.\/ui\/toprow\.mjs"/);
  assert.match(main, /tabs\.insertBefore\(moreBtn, expand\)/);
  const order = main.match(/order: \(\) => \[([^\n]+)\]/)?.[1] || "";
  for (const k of ["ss-keysbtn", "ss-bookbtn", "ss-guidebtn", "ss-presetsbtn", "ss-dirbtn", "redoBtn", "undoBtn"]) assert.ok(order.includes(k), k);
  for (const k of ["ss-pipe", "ss-topscene", "toolsBtn", "expand"]) assert.ok(!order.includes(k), `${k} never folds`);
  assert.match(rules(canvasui, `.ss-stage .ss-tabs > .${FOLDED}`).join(";"), /display\s*:\s*none\s*!important/);
  assert.match(rules(canvasui, ".ss-stage.ss-cl[data-tw=s] .ss-tabs.ss-toprow > .ss-bookbtn .lbl").join(";"), /display\s*:\s*none/, "Book is icon-only below 1400 px");
  // the menu is built in the pop-over layer, like every other menu
  assert.match(read("ui/toprow.mjs"), /openPopover\(menu, \{ anchor: more/);
});

test("Physics never covers the strip: it ends above the timeline bar or docks over the Properties column", () => {
  const body = rules(phys, ".ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-phys").join(";");
  assert.match(body, /max-height\s*:\s*calc\(100% - 6px - var\(--ph-bottom/);
  assert.match(rules(phys, ".ss-stage.ss-cl[data-ws=wide] .ss-clarea[data-phys=dock] > .ss-phys").join(";"), /right\s*:\s*6px/);
  // docked: the bar (and the picture) end where the Properties column starts
  assert.match(rules(canvasui, ".ss-stage:not(.ss-cl-hide) .ss-clarea[data-phys=dock]").join(";"), /--cv-r\s*:\s*calc\(var\(--ss-insp-w/);
  assert.match(main, /const dock = room < 340;/);
  assert.match(main, /--ph-bottom/);
});

test("the accent buttons keep dark text on a light background on hover", () => {
  // the generic hover is (0,3,1): ".ss-stage button:hover:not(:disabled)"
  assert.ok(rules(theme, ".ss-stage button:hover:not(:disabled)").length);
  const hov = rules(theme, ".ss-stage button.ss-primary:hover:not(:disabled)").join(";");   // (0,4,1): out-ranks it
  assert.match(hov, /background\s*:\s*#f6ff8a\s*!important/);
  assert.match(hov, /color\s*:\s*var\(--ss-accent-ink\)\s*!important/);
});

test("the transport wraps instead of running under the Properties; Paint Studio's tool rail scrolls when short", () => {
  assert.match(rules(canvasui, ".ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-bottom > .ss-time").join(";"), /flex-wrap\s*:\s*wrap\s*!important/);
  assert.match(rules(canvasui, ".ss-stage.ss-cl[data-ws=wide] .ss-canvasview > .ss-cv:not(.ss-cv-narrow) .ss-cv-rail").join(";"), /overflow-y\s*:\s*auto/);
  assert.match(rules(canvasui, ".ss-stage.ss-cl[data-ws=wide][data-xs=true] .ss-vphead .ss-dispviews button").join(";"), /font-size\s*:\s*0/);
  assert.match(main, /title: tip \}\);\n\s*b\.setAttribute\("aria-label", label\);/, "icon-only display modes keep their words in the tooltip");
});

test("the headless checks know every step and tool, and the sweep opens the ⋯ menu", () => {
  assert.deepEqual(STEPS, ["script", "cast", "set", "frame", "motion", "review", "deliver"]);
  assert.deepEqual(TOOLS, ["canvas", "advisor", "look", "dailies", "cut"]);
  assert.ok(CASES.some((c) => c.name === "more_menu" && c.pop === ".ss-moremenu"));
});
