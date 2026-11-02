// Every menu in the App goes through the pop-over layer (web/ui/popover.mjs), and the headless sweep
// (tools/qa/popover_sweep.mjs) walks each of them at every window size with every big panel open.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CASES } from "../../tools/qa/popover_sweep.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const files = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  if (f === "vendor" || f === "demo_media") return [];
  return statSync(p).isDirectory() ? files(p) : /\.(m?js)$/.test(f) ? [p] : [];
});

test("a file that builds a menu (role=menu) opens it in the pop-over layer", () => {
  const menu = /role["']?\s*[:=]\s*["']menu["']|setAttribute\(\s*["']role["']\s*,\s*["']menu["']/;
  const bad = [];
  for (const f of files(WEB)) {
    const src = readFileSync(f, "utf8");
    if (!menu.test(src) || f.endsWith(join("ui", "popover.mjs"))) continue;
    if (!/from\s+["'][./]*(ui\/)?popover\.mjs["']/.test(src)) bad.push(relative(WEB, f));
  }
  assert.deepEqual(bad, [], `menus outside the pop-over layer: ${bad.join(", ")}`);
});

test("the menus once cut off by a scrolling box use the layer, not position:absolute inside their panel", () => {
  const strip = readFileSync(join(WEB, "cut", "strip.mjs"), "utf8");
  assert.match(strip, /openPopover\(m,/);
  assert.doesNotMatch(strip, /\.ss-strip-menu\{position:absolute/);
  assert.doesNotMatch(strip, /this\.root\.append\(m\)/);
  const app = readFileSync(join(WEB, "soundstage.js"), "utf8");
  assert.match(app, /openPopover\(pop,/);   // the scene picker and Tools ▾
  for (const f of ["script/panel.mjs", "dailies/bin.mjs", "cut/cut.mjs", "vcam/desk.mjs", "takecheck/takecheck.mjs"]) {
    assert.match(readFileSync(join(WEB, f), "utf8"), /openPopover\(/, f);
  }
});

test("the headless sweep walks every menu, drop-down, context menu and pop-over", () => {
  const names = CASES.map((c) => c.name);
  for (const n of ["scene_picker", "tools_menu", "look_pop", "strip_add", "strip_clip_more", "strip_clip_ctx", "phone_pop",
    "script_scenes", "frame_pops", "motion_pops", "dailies_arrange", "cut_ctx", "advisor_strip_add"]) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length);
  for (const c of CASES) assert.ok(c.pop && (c.trigger || c.open), c.name);
});
