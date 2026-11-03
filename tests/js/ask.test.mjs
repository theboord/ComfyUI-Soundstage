// node --test tests/js/ask.test.mjs
// Ask (web/agent/ask.mjs): the assistant's button is always there (pinned beside Guide / Expand, never folded into "⋯",
// in every step, at 1024 / 1280 / 1920), it reads where you are, questions get recipes whose Show me controls exist
// in the App, and the step screens never hide the chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { foldUntilFits, PINNED } from "../../web/ui/toprow.mjs";
import { HOWTO, isQuestion, matchHowto, doItCommand, contextLine, uiForPlanner, teachNext, contextRecipe, needsFab, fabPos,
  parseAnswer, isAskKey, askContext, ASK_STEPS } from "../../web/agent/ask.mjs";
import { visibleRect } from "../../web/agent/directorpanel.mjs";

const WEB = new URL("../../web/", import.meta.url).pathname;
const read = (p) => readFileSync(join(WEB, p), "utf8");
const main = read("soundstage.js"), panel = read("agent/directorpanel.mjs"), toprow = read("ui/toprow.mjs"), canvasui = read("ui/canvasui.mjs");

test("the Ask button is the Director's button, pinned: ss-pin, sparkles, labelled Ask, before Guide", () => {
  assert.match(panel, /class: "ss-btn ss-dirbtn ss-askbtn ss-pin"/);
  assert.match(panel, /icon\("sparkles", 15\), h\("span", \{ class: "lbl" \}, "Ask"\)/);
  assert.match(main, /mountDirector\(\{ root: el, topBar: tabs, before: guideBtn/);
  assert.equal(PINNED, "ss-pin");
  assert.match(toprow, /!b\.classList\.contains\(PINNED\)/, "topRowFit skips pinned buttons");
  const order = main.match(/order: \(\) => \[([^\n]+)\]/)?.[1] || "";
  assert.ok(!/dirbtn|askbtn/.test(order), "Ask is not in the fold order");
  assert.match(canvasui, /:is\(\.ss-presetsbtn, \.ss-dirbtn:not\(\.ss-askbtn\)\) \.lbl/, "its label never hides");
});

// The real row's widths (QA sweep 2026-11-02, toprow_fit.test.mjs) with Ask labelled (~58 px), at three window widths.
const ROW = { brand: 20, steps: 549, scene: 96, undo: 36, redo: 36, presets: 33, tools: 46, keys: 33, book: 33, ask: 58, guide: 36, done: 32 };
for (const room of [982, 1238, 1878]) {
  test(`at ${room + 42} px wide the row fits and Ask stays in it`, () => {
    const items = Object.entries(ROW).map(([name, w]) => ({ name, w, folded: false, pin: name === "ask" }));
    let more = false;
    const width = () => items.filter((b) => !b.folded).reduce((a, b) => a + b.w + 6, 0) + (more ? 39 : 0);
    // the App's order, with Ask listed too: the pin must still keep it out
    const order = ["keys", "book", "guide", "presets", "ask", "redo", "undo"].map((n) => items.find((b) => b.name === n)).filter((b) => !b.pin);
    foldUntilFits({ order, overflows: () => width() > room, fold: (b) => { b.folded = true; }, unfoldAll: () => items.forEach((b) => { b.folded = false; }), showMore: (on) => { more = on; } });
    assert.ok(width() <= room, `fits: ${width()} in ${room}`);
    assert.equal(items.find((b) => b.name === "ask").folded, false);
  });
}

test("no step screen hides the chat (each mode's hide-everything-else rule exempts .ss-dir)", () => {
  const modes = [...main.matchAll(/\.ss-stage\.ss-(\w+mode) > ([^{]+)\{ display:none !important; \}/g)];
  assert.ok(modes.length >= 7);
  for (const [, m, sel] of modes) assert.match(sel, /:not\(\.ss-dir\)/, m);
});

test("context: the step, selection, shot and panel reach the chat and the planner", () => {
  assert.match(main, /node\.ssAsk = mountAsk\(/);
  for (const k of ["step", "selected", "shot", "panel"]) assert.match(main.slice(main.indexOf("node.ssAsk = mountAsk(")), new RegExp(`\\b${k}\\b`));
  const ctx = askContext({ context: () => ({ step: "set", view: "stage", selected: { id: "c1", name: "Red car", kind: "car" }, shot: { id: "s2", name: "Tracking", n: 2 }, panel: "Physics" }) });
  assert.equal(contextLine(ctx), "You're on ③ Set · shot 2 (Tracking) · Red car selected · Physics open");
  assert.deepEqual(uiForPlanner(ctx), { step: "set", selected: { id: "c1", name: "Red car", kind: "car" }, shot: { id: "s2", n: 2 }, panel: "Physics" });
  assert.deepEqual(askContext({ context: () => { throw new Error("x"); } }).step, null);
  assert.match(read("agent/director.mjs"), /this\.host\.ui\?\.\(\)/, "Director.context() carries ui");
});

test("questions are answered, orders go to the planner", () => {
  for (const q of ["how do I make the car crash into the boxes?", "what should I do next", "where is physics", "help"]) assert.ok(isQuestion(q), q);
  for (const o of ["make it rain", "Use the J-turn stunt", "put Mara in the car"]) assert.ok(!isQuestion(o), o);
  const m = matchHowto("how do I make the car crash into the boxes?");
  assert.equal(m.recipe.id, "crash");
  assert.match(doItCommand(m.recipe, "", null), /crate stack/);
  assert.equal(matchHowto("how do I add rain?").recipe.id, "weather");
  assert.equal(doItCommand(matchHowto("how do I add a dog?").recipe, "how do I add a dog?"), "add a dog");
  assert.equal(doItCommand(HOWTO.find((r) => r.id === "frame"), "", { shot: { n: 3 } }), "paint frames for shot 3");
  assert.equal(contextRecipe("what should I do next?", { step: "frame" }).id, "motion");
  assert.equal(contextRecipe("what can I do with this?", { selected: { kind: "car" } }).id, "stunt");
  assert.ok(teachNext({ step: "set" }).length > 0);
});

test("Show me points at real controls: every selector and label exists in the App's source", () => {
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!/vendor/.test(p)) walk(p); } else if (/\.(m?js)$/.test(f)) files.push(readFileSync(p, "utf8")); } };
  walk(WEB);
  const src = files.join("\n");
  const steps = new Set(ASK_STEPS.map((s) => s.k));
  for (const r of HOWTO) for (const s of r.steps) {
    if (!s.show) continue;
    if (s.show.step) assert.ok(steps.has(s.show.step), `${r.id}: step ${s.show.step}`);
    for (const cls of (s.show.sel || "").match(/\.ss-[\w-]+/g) || []) assert.ok(src.includes(cls.slice(1)), `${r.id}: ${cls}`);
    const tool = /data-tool=(\w+)/.exec(s.show.sel || "")?.[1];
    if (tool) assert.match(main, new RegExp(`\\{ k: "${tool}", ic:`), `${r.id}: tool ${tool}`);
    if (s.show.text) {
      const lit = s.show.text.replace(/^\^|\$$/g, "").replace(/\\(.)/g, "$1");
      assert.ok(src.includes(lit), `${r.id}: a control says "${lit}"`);
    }
  }
  assert.match(read("pipeline/pipeline.mjs"), /"data-step": s\.k/, "[data-step=…] is the step bar");
});

test("floating fallback: shown when the pinned button is off screen or folded, at the visible corner", () => {
  const root = { left: 0, top: -400, right: 400, bottom: 900, width: 400, height: 1300 };
  assert.equal(needsFab({ btn: { left: 300, top: -380, right: 360, bottom: -350, width: 60, height: 30 }, root, vw: 1024, vh: 640 }), true);
  assert.equal(needsFab({ btn: { left: 300, top: 10, right: 360, bottom: 40, width: 60, height: 30 }, root, vw: 1024, vh: 640 }), false);
  assert.equal(needsFab({ btn: { left: 300, top: 10, right: 360, bottom: 40, width: 60, height: 30 }, root, vw: 1024, vh: 640, folded: true }), true);
  assert.equal(needsFab({ btn: null, root, vw: 1024, vh: 640, tour: true }), false);
  const p = fabPos(root, 1024, 640);
  assert.ok(p.left + 40 <= 400 && p.top + 40 <= 640 && p.top >= 0);
  const v = visibleRect(root, 1024, 640);
  assert.deepEqual([v.top, v.bottom], [0, 640]);
});

test("Cmd/Ctrl+K opens it; the model's free answer parses", () => {
  assert.ok(isAskKey({ metaKey: true, key: "k" }) && isAskKey({ ctrlKey: true, key: "K" }));
  assert.ok(!isAskKey({ key: "k" }) && !isAskKey({ ctrlKey: true, shiftKey: true, key: "k" }));
  assert.deepEqual(parseAnswer('ok {"answer":"Open Set.","steps":["Press Lighting"],"command":"make it night"}'), { answer: "Open Set.", steps: ["Press Lighting"], command: "make it night" });
  assert.equal(parseAnswer("1. Go to Set\n2. Press Add object").steps[0], "Press Add object");
  assert.equal(parseAnswer(""), null);
});
