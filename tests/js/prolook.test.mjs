// Milestone 14: the pro look. Design tokens (one type scale, legible text), the shortcut list and its cheat sheet.
// node --test tests/js/prolook.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TOKENS, TYPE, SPACE, RADIUS, PRO_CSS, contrast, flatten } from "../../web/ui/theme.mjs";
import { SHORTCUTS, keyLabel, comboText, withKeys, allCombos, isCheatSheetKey, isMac } from "../../web/ui/shortcuts.mjs";
import { ICONS } from "../../web/ui/icons.mjs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("tokens: one type scale, nothing under 11 px; a 4 px spacing grid", () => {
  assert.deepEqual(Object.values(TYPE), [11, 12, 13, 15, 18]);
  for (const v of Object.values(SPACE)) assert.equal(v % 4, 0, `${v} is on the 4 px grid`);
  assert.ok(RADIUS.sm < RADIUS.md && RADIUS.md < RADIUS.lg && RADIUS.lg < RADIUS.xl);
});

test("tokens: body, secondary and hint text all pass WCAG AA (4.5:1) on the ground, raised cards and the glass panels", () => {
  for (const k of ["text", "muted", "faint"]) {
    assert.ok(contrast(TOKENS[k]) >= 4.5, `${k} on bg: ${contrast(TOKENS[k]).toFixed(2)}`);
    assert.ok(contrast(TOKENS[k], TOKENS.raised) >= 4.5, `${k} on raised`);
    // A glass panel over the light clay set (the worst case): still readable.
    assert.ok(contrast(TOKENS[k], TOKENS.glass, "#a0a0a0") >= 4.5, `${k} on glass over clay`);
  }
  // The accent's ink on the accent (the one main button) is strong.
  assert.ok(contrast(TOKENS.accentInk, TOKENS.accent) >= 7);
});

test("contrast helper: known values", () => {
  assert.equal(Math.round(contrast("#ffffff", "#000000")), 21);
  assert.equal(contrast("#777777", "#777777"), 1);
  assert.deepEqual(flatten("rgba(255,255,255,0.5)", "#000000"), [128, 128, 128]);
});

test("pro layer: picked options are neutral segments, not a second yellow; the step's way on is quiet", () => {
  assert.match(PRO_CSS, /\.ss-lcmp\) button\[aria-pressed=true\]:not\(:disabled\) \{\s*background:var\(--ss-selected\) !important/);
  assert.match(PRO_CSS, /button\.go\.next \{ background:transparent !important/);
  assert.match(PRO_CSS, /\.ss-stage > \.ss-status, \.ss-stage \.ss-status \{ color:var\(--ss-muted\) !important; \}/);
  // Every interactive thing gets the same focus ring.
  assert.match(PRO_CSS, /:focus-visible \{\s*outline:2px solid var\(--ss-accent\) !important/);
  // No font size under the scale.
  assert.doesNotMatch(PRO_CSS, /font-size:(?:[0-9]|10(?:\.5)?)px/);
});

test("Review's compare chips are styled by aria-pressed, not an inline yellow", () => {
  const lad = read("web/ladder/ladder.mjs");
  assert.doesNotMatch(lad, /btn\.style\.cssText = `background:\$\{YELLOW\}/);
  assert.match(lad, /btn\.setAttribute\("aria-pressed", String\(!!on\)\)/);
});

test("panel folds use chevron icons, not '+' / '–' text", () => {
  const cv = read("web/ui/canvasui.mjs");
  assert.match(cv, /lucide\(c \? "chevron-down" : "chevron-up", 15\)/);
  assert.doesNotMatch(cv, /btn\.textContent = c \? "\+" : "–"/);
  assert.doesNotMatch(read("web/soundstage.js"), /inspTog\.textContent = c \? "\+" : "–"/);
  for (const n of ["keyboard", "chevron-up", "chevron-down", "chevron-left", "chevron-right", "x", "ellipsis"]) assert.ok(ICONS[n], n);
});

test("shortcuts: Mod is ⌘ on a Mac and Ctrl elsewhere; combos read naturally", () => {
  assert.equal(keyLabel("Mod", true), "⌘");
  assert.equal(keyLabel("Mod", false), "Ctrl");
  assert.equal(keyLabel("c", false), "C");
  assert.equal(comboText(["Shift", "Mod", "Z"], true), "⇧⌘Z");
  assert.equal(comboText(["Shift", "Mod", "Z"], false), "Shift+Ctrl+Z");
  assert.equal(comboText(["Alt", "Drag"], true), "⌥+Drag");
  assert.equal(withKeys("Undo", ["Mod", "Z"], false), "Undo (Ctrl+Z)");
  assert.equal(withKeys("Hide panels", [["H"], ["Tab"]], false), "Hide panels (H or Tab)");
  assert.equal(withKeys("Plain", null), "Plain");
  assert.equal(isMac({ platform: "MacIntel" }), true);
  assert.equal(isMac({ platform: "Win32" }), false);
});

test("shortcuts: the cheat sheet lists every key the App answers, Milestone 9's 3D drags included", () => {
  const all = allCombos(false);
  for (const k of ["?", "H", "Tab", "Ctrl+Z", "Shift+Ctrl+Z", "Esc", "Drag", "Shift+Drag", "Alt+Drag", "Wheel", "C", "F", "G", "R", "T", "P",
    "Ctrl+D", "0", "W", "Q", "E"]) assert.ok(all.includes(k), `missing ${k}`);
  // One sentence each, grouped, no empty group.
  for (const g of SHORTCUTS) {
    assert.ok(g.items.length > 0, g.group);
    for (const it of g.items) { assert.ok(it.what.length > 3 && it.what.length < 110, it.what); assert.ok(Array.isArray(it.keys) && it.keys.length); }
  }
});

test("shortcuts: the keys the sheet promises are the keys the code handles", () => {
  const stage = read("web/stage/stage.mjs"), live = read("web/stage/live.mjs"), main = read("web/soundstage.js");
  assert.match(stage, /k === "f" && !e\.metaKey/);                       // F frames the selection
  assert.match(stage, /k === "0"/);                                       // 0: shot camera / free view
  assert.match(stage, /\(k === "g" \|\| k === "r" \|\| k === "t"\)/);     // gizmo modes
  assert.match(stage, /k === "p" && !e\.metaKey/);                         // pose
  assert.match(stage, /\(e\.metaKey \|\| e\.ctrlKey\) && k === "d"/);     // duplicate
  assert.match(live, /e\.key\.toLowerCase\(\) !== "c"/);                  // C picks up
  assert.match(live, /if \(e\.altKey\) \{/);                               // Alt turns
  assert.match(live, /if \(!e\.shiftKey\) d\.axis = null/);                // Shift locks an axis
  assert.match(live, /wheel\(e\) \{/);                                     // the wheel lifts
  assert.match(main, /const isH = e\.key === "h" \|\| e\.key === "H", isTab = e\.key === "Tab"/);
  assert.match(main, /window\.addEventListener\("keydown", onHelpKey, true\)/);
});

test("the '?' key: opens the sheet, never while typing, never with a modifier", () => {
  assert.equal(isCheatSheetKey({ key: "?", target: { tagName: "CANVAS" } }), true);
  assert.equal(isCheatSheetKey({ key: "?", target: { tagName: "INPUT" } }), false);
  assert.equal(isCheatSheetKey({ key: "?", target: { tagName: "DIV", isContentEditable: true } }), false);
  assert.equal(isCheatSheetKey({ key: "?", metaKey: true, target: null }), false);
  assert.equal(isCheatSheetKey({ key: "/", target: null }), false);
});

test("first impression: the empty card has one yellow way in, a shortcut hint, and calms the header's Import video", () => {
  const fr = read("web/ui/firstrun.mjs");
  assert.match(fr, /mk\("span", "keys", "Shortcuts", mk\("kbd", "", "\?"\)\)/);
  assert.match(fr, /:has\(\.ss-vpcell > \.ss-empty:not\(\[hidden\]\)\) button\.ss-vi-head/);
  assert.match(fr, /prefers-reduced-motion: reduce\) \{ \.ss-stage \.ss-empty \{ animation:none/);
  assert.match(fr, /\[data-ws=narrow\] \.ss-empty \{[^}]*animation:none/);
});

test("Set › Object: the rarely used import / export controls sit behind More, and Photo → 3D opens it", () => {
  const main = read("web/soundstage.js");
  assert.match(main, /objMoreBody\.append\(importBtn, fileIn, worldUi\.button, worldUi\.input, photoSel\.wrap, photoIn, videoIn, exportBtn\)/);
  assert.match(main, /objMore\.open = true;\s*\n\s*spotlight\(photoSel\.wrap/);
});

test("⑦ Deliver: one main button (the cut); each way out is its own card", () => {
  const pipe = read("web/pipeline/pipeline.mjs");
  assert.equal((pipe.match(/main: true/g) || []).length, 1);
  assert.match(pipe, /class: "card ss-deliver-card"/);
  assert.match(pipe, /"Download the DCC kit"/);   // tools/qa finds the DCC card by this text
});

// ---- QA round 02's design notes, fixed in this pass ----
import { fitTile, fitLayout } from "../../web/cast/cast.mjs";

test("② Cast › Fit: the largest thumbnail at which every section fits; short sections share a line", () => {
  const counts = [3, 4, 4, 9];   // the demo: characters, locations, wardrobe, props
  const room = { width: 1400, height: 786, extra: 32, head: 74 };
  const fit = fitLayout(counts, room);
  assert.ok(fit.tile >= 56 && fit.tile <= 210, `tile ${fit.tile}`);
  assert.deepEqual(fit.lines[0], [0, 1], "characters and locations side by side");
  // Every line fits the width; a little less height means smaller tiles.
  for (const ln of fit.lines) assert.ok(ln.reduce((a, i) => a + fit.widths[i], 0) + (ln.length - 1) * 24 <= room.width);
  assert.ok(fitTile(counts, { ...room, height: room.height - 60 }) < fit.tile);
  // More room, bigger tiles; less room, smaller; never under the floor, never over M.
  assert.ok(fitTile(counts, { ...room, height: 690, width: 1236 }) <= fit.tile);
  assert.ok(fitTile(counts, { ...room, height: 960, width: 1880 }) >= fit.tile);
  assert.equal(fitTile([1, 1, 0, 0], { width: 1900, height: 1000 }), 210);
  assert.equal(fitTile([3], { width: 0, height: 0 }), 150);
  assert.equal(fitTile([400], { width: 600, height: 300 }), 56);
});

test("② Cast: Fit is the default size and is offered first", () => {
  const cast = read("web/cast/cast.mjs");
  assert.match(cast, /const SIZES = \[\["Fit", 0\], \["S", 150\]/);
  assert.match(cast, /localStorage\.getItem\("ss-cast-size"\) \|\| "Fit"/);
});

test("④ Frame: Style and Camera open full-height pop-overs with a search box; ⑤ Motion's Follow modes leave them alone", () => {
  const pipe = read("web/pipeline/pipeline.mjs"), cv = read("web/ui/canvasui.mjs");
  assert.match(pipe, /_cvPicker\(wrap, key, ic, title, tip, nodes, placeholder\)/);
  assert.match(pipe, /q\.placeholder = placeholder/);
  assert.match(pipe, /if \(pp\.btn && !pp\.frame\)/);
  assert.match(cv, /\.ss-clpop2\.ss-tallpop \{ bottom:8px;/);
  assert.match(cv, /\.ss-tallpop \.ss-styles \{ max-height:none !important; overflow:visible !important;/);
});

test("⑤ Motion and ⑦ Deliver: no empty black player before a render, the start frame or the clay instead", () => {
  const pipe = read("web/pipeline/pipeline.mjs");
  assert.match(pipe, /this\._mStill = this\._cvStillPair\(media\)/);
  assert.match(pipe, /this\._dStill = this\._cvStillPair\(media\)/);
  assert.match(pipe, /_syncStill\(pair, video, hasVid, url\) \{\s*if \(!pair \|\| !video\) return;\s*video\.hidden = !hasVid;/);
  assert.match(pipe, /this\._syncStill\(this\._dStill, v, !!src, this\.chosen\[sid\]\?\.url \|\| r\.look \|\| ""\)/);
});

test("⑤ Motion: the VIDEO MODEL heading is the only 'Video model' line; ③ Set's selection is one compact tool row", () => {
  const pipe = read("web/pipeline/pipeline.mjs"), cv = read("web/ui/canvasui.mjs");
  assert.match(pipe, /mv\.addClass\(m\.engine\.parentElement, "ss-cl-bare"\)/);
  assert.match(cv, /label\.f\.ss-cl-bare \{ font-size:0 !important;/);
  assert.match(PRO_CSS, /\.ss-insp \.ss-sel > \.ss-views button, \.ss-stage \.ss-insp \.ss-sel > button\.ss-btn \{ font-size:0 !important;/);
});

test("canvasui: the Lucide helper is imported under its own name (hudPanel's `icon` argument shadowed it: every step panel failed)", () => {
  const cv = read("web/ui/canvasui.mjs");
  assert.match(cv, /import \{ icon as lucide \} from "\.\/icons\.mjs"/);
  assert.doesNotMatch(cv, /[^.\w]icon\("/);
});
