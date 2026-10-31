// QA round 02 layout fixes. The rules live in CSS strings (soundstage.js imports ComfyUI's app and cannot load in
// Node), so they are checked as text; tools/qa/visual_baseline.mjs checks them on screen at three window sizes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
const canvas = readFileSync(new URL("../../web/ui/canvasui.mjs", import.meta.url), "utf8");

// 1. The narrow App panel showed two identical "Import video" buttons 200 px apart.
test("Import video: the header copy hides in the wide / full workspace", () => {
  assert.match(main, /\.ss-stage\[data-ws=wide\] \.ss-vi-tabbtn, \.ss-stage\.ss-full \.ss-vi-tabbtn \{ display:none !important; \}/);
});
test("Import video: the viewport header's copy hides exactly where the header copy shows", () => {
  assert.match(main, /\.ss-stage:not\(\[data-ws=wide\]\):not\(\.ss-full\) \.ss-vi-head:not\(\.ss-vi-tabbtn\) \{ display:none !important; \}/);
});
test("Import video: the Guide's first step points at whichever copy is visible", () => {
  assert.match(main, /S\.start\.target = .*vis\(importHead\) \|\| vis\(importTab\)/);
});

// 2. "Physics: CPU" sat on the status line, over "Man 3 climbs onto Crate 1".
test("physics badge: hidden for the default CPU solver, bottom-right (off the status text) for the GPU one", () => {
  assert.match(main, /\.ss-stage > \.ss-phys-badge\[data-backend=xpbd\] \{ display:none !important; \}/);
  assert.match(main, /\.ss-stage > \.ss-phys-badge \{ left:auto !important; right:10px !important; \}/);
});

// 3. With a render queued, Stop squeezed the step names to "Scri…", "C…", "S…" at 1440 px.
test("top row: while Stop shows, the wordmark and the Guide / Done words make room, not the step names", () => {
  const has = ".ss-stage.ss-cl .ss-tabs.ss-toprow:has(.ss-stop:not([hidden]))";
  for (const part of ["> .ss-brand .ss-wordmark { display:none; }", "> .ss-guidebtn .lbl { display:none; }", "> .ss-expand { font-size:0 !important;"])
    assert.ok(canvas.includes(`${has} ${part}`), part);
});

// 4. In the narrow App panel the "Drop a video here → 3D" pill ran under the "Coach · 1" pill.
test("narrow view: the small drop-a-video pill gives way (the big Import video is just above); the empty-stage one stays", () => {
  assert.match(main, /\.ss-stageview\[data-narrow=true\] > \.ss-vi-cta:not\(\[data-big=true\]\) \{ display:none !important; \}/);
});
