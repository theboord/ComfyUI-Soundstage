// D12 key maps (web/cut/keymap.mjs, nle_design_v1.md §9): map × context × key event -> the action that runs.
// node --test tests/js/cut_keymap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as KM from "../../web/cut/keymap.mjs";
import { avidShuttle, avidShuttleStep, bigStep } from "../../web/cut/nle_core.mjs";

const ev = (code, { key = null, ctrl = false, meta = false, shift = false, alt = false, repeat = false } = {}) => ({
  code, key: key ?? (code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code),
  ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt, repeat,
});
const act = (map, e, ctx = {}) => {
  const b = KM.resolve(map, e, ctx);
  return b ? (b.arg != null ? `${b.action}:${b.arg}` : b.action) : null;
};

test("the picker lists Avid first, then Premiere; Soundstage stays the default", () => {
  assert.deepEqual(KM.PICKER, ["avid", "premiere", "soundstage"]);
  assert.equal(KM.DEFAULT_KEYMAP, "soundstage");
  const src = readFileSync(new URL("../../web/cut/cut.mjs", import.meta.url), "utf8");
  const i = src.indexOf('[["avid", "Avid keys"], ["premiere", "Premiere keys"], ["soundstage", "Soundstage keys"]]');
  assert.ok(i > 0, "the key-map select offers Avid, Premiere, Soundstage in that order");
  const core = readFileSync(new URL("../../web/cut/nle_core.mjs", import.meta.url), "utf8");
  assert.ok(core.indexOf('"Use Avid keys"') < core.indexOf('"Premiere keys"'), "the first-Edit offer puts Avid first");
});

test("Avid map: Media Composer's default keys (§9.3a)", () => {
  const rows = [
    [ev("Digit1"), "stepBig:-1"], [ev("Digit2"), "stepBig:1"], [ev("Digit3"), "step:-1"], [ev("Digit4"), "step:1"],
    [ev("Digit5"), "togglePlay"], [ev("Digit6"), "playInOut"], [ev("Digit6", { alt: true }), "loopInOut"],
    [ev("KeyQ"), "gotoIn"], [ev("KeyW"), "gotoOut"], [ev("KeyE"), "markIn"], [ev("KeyR"), "markOut"], [ev("KeyT"), "markClip"],
    [ev("KeyI"), "markIn"], [ev("KeyO"), "markOut"], [ev("Backslash", { key: "\\" }), "dissolve"],
    [ev("KeyA"), "prevEdit"], [ev("KeyS"), "nextEdit"], [ev("KeyD"), "clearIn"], [ev("KeyF"), "clearOut"], [ev("KeyG"), "clearMarks"],
    [ev("KeyH"), "focus"], [ev("KeyJ"), "shuttleRev"], [ev("KeyK"), "pause"], [ev("KeyL"), "shuttleFwd"],
    [ev("KeyX"), "extract"], [ev("KeyZ"), "later"], [ev("KeyV"), "later"], [ev("KeyB"), "later"],
    [ev("Space", { key: " " }), "togglePlay"], [ev("Escape", { key: "Escape" }), "escape"],
    [ev("ArrowLeft", { key: "ArrowLeft" }), "step:-1"], [ev("ArrowUp", { key: "ArrowUp" }), "prevEdit"],
    [ev("Delete", { key: "Delete" }), "legacy"],
    [ev("KeyJ", { alt: true, key: "∆" }), "shuttleDown"], [ev("KeyL", { alt: true, key: "¬" }), "shuttleUp"],   // ⌥ on a US Mac
    [ev("KeyQ", { alt: true, key: "œ" }), "markIn"], [ev("KeyI", { alt: true }), "gotoIn"], [ev("KeyE", { alt: true }), "gotoIn"],
    [ev("Digit3", { alt: true }), "stepBig:-1"], [ev("KeyT", { alt: true }), "markClip"],
    [ev("KeyZ", { ctrl: true }), "undo"], [ev("KeyZ", { ctrl: true, shift: true }), "redo"], [ev("Slash", { meta: true, key: "/" }), "fit"],
    [ev("KeyB", { ctrl: true }), "split"], [ev("KeyM", { alt: true }), "matchAction"],
    [ev("Period", { shift: true, key: ">" }), "later"], [ev("Quote", { shift: true, key: '"' }), "keysMode"],
  ];
  for (const [e, want] of rows) assert.equal(act("avid", e), want, `${e.code} alt=${e.altKey} shift=${e.shiftKey}`);
});

test("browser keys a page can take bind only while the Cut itself has focus (root)", () => {
  for (const e of [ev("KeyR", { ctrl: true }), ev("BracketRight", { ctrl: true, key: "]" }), ev("KeyJ", { meta: true }), ev("Tab", { key: "Tab" })]) {
    assert.equal(act("avid", e, {}), null, e.code);
    assert.ok(act("avid", e, { root: true }), e.code);
  }
});

test("AltGr never matches; ⌥ on macOS matches on the physical key", () => {
  assert.equal(act("avid", ev("Digit8", { key: "[", ctrl: true, alt: true })), null);
  assert.equal(act("avid", ev("Comma", { key: "≤", alt: true })), null, "⌥, is a Trim Mode key: unbound outside it");
  assert.equal(act("avid", ev("ArrowLeft", { key: "ArrowLeft", alt: true }), { mac: true }), "stepBig:-1");
  assert.equal(act("avid", ev("ArrowLeft", { key: "ArrowLeft", alt: true }), { mac: false }), null, "Windows: Alt+← is the browser's back");
});

test("Mod+letter follows the printed letter (AZERTY), with e.code as the fallback", () => {
  assert.equal(act("avid", ev("KeyQ", { key: "a", ctrl: true }), { root: true }), "later", "AZERTY A on the Q key is Mod+A");
  assert.equal(act("avid", ev("KeyW", { key: "z", ctrl: true })), "undo", "AZERTY Z on the W key is Mod+Z");
  assert.equal(act("avid", ev("KeyZ", { key: "я", ctrl: true })), "undo", "non-Latin layout: the physical key");
});

test("Premiere map (§9.3b)", () => {
  const rows = [
    [ev("KeyK"), "stop"], [ev("KeyX"), "markClip"], [ev("KeyI", { alt: true }), "clearIn"], [ev("KeyI", { shift: true }), "gotoIn"],
    [ev("Quote", { key: "'" }), "extract"], [ev("KeyK", { ctrl: true }), "split"], [ev("Delete", { key: "Delete", shift: true }), "rippleDelete"],
    [ev("KeyD", { meta: true }), "dissolve"], [ev("ArrowRight", { key: "ArrowRight", shift: true }), "stepSecond:1"],
    [ev("Comma", { key: "<", alt: true, shift: true }), "slip:-1"], [ev("KeyP"), "keysMode"], [ev("Digit2", { shift: true, key: "@" }), "monSrc"],
    [ev("Comma", { key: "," }), "later"], [ev("Period", { key: "." }), "later"],
  ];
  for (const [e, want] of rows) assert.equal(act("premiere", e), want, e.code);
  assert.equal(act("premiere", ev("KeyE")), null, "E stays C's Edit in… until Extend lands");
});

test("the Soundstage map never takes a key today's switch handles, and V and / stay the App's", () => {
  const legacy = [...KM.LEGACY_KEYS.plain.map((k) => ({ key: k, code: "X" })), ...KM.LEGACY_KEYS.mod.map((k) => ({ key: k, code: "X", ctrlKey: true }))];
  for (const e of legacy) {
    assert.ok(KM.legacyClaims(e), e.key);
    assert.equal(KM.resolve("soundstage", e, {}), null, e.key);
  }
  for (const e of [ev("KeyV"), ev("Slash", { key: "/" })]) {
    assert.equal(KM.legacyClaims(e), false);
    assert.equal(KM.claimsKey("soundstage", e, {}), false, `${e.code}: Presets / the Director keep it`);
  }
  assert.equal(KM.claimsKey("avid", ev("KeyV"), {}), true, "Avid's V is splice-in, so Presets steps aside");
  assert.equal(KM.claimsKey("avid", ev("Slash", { key: "/" }), {}), false, "/ outside Trim Mode still opens the Director");
});

test("no map binds a reserved key or C's Edit in… keys, on either platform", () => {
  for (const [name, map] of Object.entries(KM.MAPS)) {
    for (const mac of [false, true]) {
      const specs = new Set(map.bindings.map((b) => KM.specFor(b.key, mac)).filter(Boolean));
      for (const r of [...KM.RESERVED, ...KM.C_KEYS]) {
        const spec = KM.specFor(r, mac);
        if (spec) assert.ok(!specs.has(spec), `${name} (${mac ? "mac" : "win"}) binds reserved ${spec}`);
      }
    }
  }
});

test("no two bindings in a map share a key and a context (an unconditional one overlaps every context)", () => {
  for (const [name, map] of Object.entries(KM.MAPS)) {
    for (const mac of [false, true]) {
      const seen = new Map();
      for (const b of map.bindings) {
        const spec = KM.specFor(b.key, mac);
        if (!spec) continue;
        const ctx = (b.when || []).slice().sort().join(",");
        const k = `${spec}|${ctx}`;
        assert.ok(!seen.has(k), `${name}: ${k} bound twice`);
        seen.set(k, b);
      }
    }
  }
});

test("every action a map names exists in nle_core.mjs (or is later / legacy)", () => {
  const core = readFileSync(new URL("../../web/cut/nle_core.mjs", import.meta.url), "utf8");
  const block = core.slice(core.indexOf("Object.assign(A, {"));
  const names = new Set([...block.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]));
  for (const [name, map] of Object.entries(KM.MAPS)) {
    for (const b of map.bindings) assert.ok(names.has(b.action), `${name}: ${b.action} has no core action`);
    for (const b of map.bindings.filter((x) => x.action === "later")) assert.ok(b.note, `${name}: ${KM.specFor(b.key, false)} later without a note`);
  }
  assert.ok(KM.helpLines("avid").length > 5 && KM.helpLines("premiere").length > 5);
});

test("Avid transport maths: shuttle 1 2 3 5 8, the speed steps, 8-frame steps at 24-based rates", () => {
  let s = 0;
  const seq = [];
  for (let i = 0; i < 6; i++) { s = avidShuttle(s, 1); seq.push(s); }
  assert.deepEqual(seq, [1, 2, 3, 5, 8, 8]);
  assert.equal(avidShuttle(5, -1), -1, "the other way plays 1x that way");
  assert.equal(avidShuttleStep(5, false), 3);
  assert.equal(avidShuttleStep(-3, true), -5);
  assert.equal(avidShuttleStep(0, true), 0);
  assert.equal(bigStep({ fi: { base: 24 } }), 8);
  assert.equal(bigStep({ fi: { base: 25 } }), 10);
  assert.equal(bigStep({ fi: { base: 30 } }), 10);
});

test("labels name keys the US way", () => {
  assert.equal(KM.keyLabel("Mod+Shift+KeyZ", true), "⌘⇧Z");
  assert.equal(KM.keyLabel("Mod+Shift+KeyZ", false), "Ctrl+Shift+Z");
  assert.equal(KM.keyLabel("Alt+Digit6", false), "Alt+6");
});
