// Drive mode and the open shortcut sheet own the keyboard. Their window-capture guards are added after the App's own
// key handlers (Presets V, Director "/" and Space, H/Tab hides the panels), so stopImmediatePropagation can't stop
// those: V in Drive opened Presets and the next W A S D typed into its search box. Each handler checks appKeysHeld().
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");

test("appKeysHeld covers Drive mode and the shortcut sheet", () => {
  assert.match(src, /const appKeysHeld = \(\) => keySheet\.isOpen \|\| !!stage\?\.drive\?\.on;/);
});

test("Presets, Director and the H/Tab panel toggle all defer to it", () => {
  const presets = src.slice(src.indexOf("node.ssPresets = mountPresets("), src.indexOf("host:", src.indexOf("node.ssPresets = mountPresets(")));
  const director = src.slice(src.indexOf("node.ssDirector = mountDirector("), src.indexOf("host:", src.indexOf("node.ssDirector = mountDirector(")));
  const hkey = src.slice(src.indexOf("const onKey = (e) => {"), src.indexOf("const isH", src.indexOf("const onKey = (e) => {")));
  for (const [name, s] of [["Presets", presets], ["Director", director], ["H/Tab", hkey]]) assert.match(s, /appKeysHeld\(\)/, name);
});
