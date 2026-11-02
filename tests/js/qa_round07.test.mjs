// QA round 07 regressions (the rotate-bar, tilt-drag and screen-box ones are in rotate.test.mjs).
//
// Night prompts said "night, cool moonlight, low sun 0° above the horizon …, 4100K warm sunlight": skyFor() gives the
// night sky a dim key (the moon), and describeLighting read any key > 0 as a sun. A Milestone-26 proof draft of the
// night car chase came back with a sunset glow on the horizon.
// Physics › Feel: "Breakable" was cut off at the panel's edge (three nowrap buttons in 200 px); the row now wraps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeLighting } from "../../web/stage/lighting.mjs";

const cam = { position: [0, 1.5, -10], target: [0, 1, 0] };

test("QA07: a night prompt has moonlight and no sun", () => {
  const t = describeLighting({ lights: [{ type: "practical", kelvin: 2100, softness: 1 }] }, { elevation_deg: -50.5, azimuth_deg: 292 }, cam);
  assert.match(t, /^night, cool moonlight/);
  assert.doesNotMatch(t, /sun/, t);
});

test("QA07: daytime and dusk prompts still place the sun", () => {
  assert.match(describeLighting({}, { elevation_deg: 12, azimuth_deg: 90 }, cam), /sun 12° above the horizon .*sunlight/);
  assert.match(describeLighting({}, { elevation_deg: 4, azimuth_deg: 90 }, cam), /low sun 4° above the horizon/);
});

test("QA07: Physics › Feel buttons wrap instead of clipping", () => {
  const src = readFileSync(new URL("../../web/stage/physpanel.mjs", import.meta.url), "utf8");
  assert.match(src, /\.ph-fx \.ss-views \{[^}]*flex-wrap:wrap/);
});

// The Outliner kept showing the last object after a deselect (Esc, a click on empty floor, the guard's select(null)),
// and never showed a light picked on the canvas.
test("QA07: the Outliner follows a deselect and a light pick", () => {
  const src = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
  assert.match(src, /if \(!info\) \{ try \{ outlineSelEl\.value = stage\.selectedLight \? `light\|\$\{stage\.selectedLight\}` : ""/);
  assert.match(src, /if \(l\) try \{ syncOutline\(\); outlineSelEl\.value = `light\|\$\{l\.id\}`/);
});

// Parts labels were cut to "Passenger …", "Rear right …", "Head up / …" in the 78 px label column: they wrap now.
test("QA07: Parts labels wrap instead of an ellipsis", () => {
  const src = readFileSync(new URL("../../web/stage/partspanel.mjs", import.meta.url), "utf8");
  assert.match(src, /\.ss-parts \.row > span:first-child \{ white-space:normal; overflow-wrap:anywhere/);
});

// Parts: selecting a second untouched object (a crate, then a car) left the new rows unset: the range inputs sat at
// their midpoint (doors looked half open) and the numbers were blank, because refresh() skipped on the same frame and
// the same parts JSON ("[null,null,null]" for both).
test("QA07: Parts rows get their values when another untouched object is selected", async () => {
  const had = globalThis.document;
  globalThis.document = { activeElement: null, getElementById: () => null, head: { append() {} }, createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }) };
  try {
    const { PartsPanel } = await import("../../web/stage/partspanel.mjs");
    const spec = { type: "num", min: 0, max: 70, step: 1, label: "Driver door", unit: "°" };
    const stage = { frame: 0, partChannels: (id) => [{ ch: "door_fl", spec, value: id === "crate" ? undefined : 0, keys: [], here: false, auto: false }],
      _partsSig: () => "[null,null,null]", state: { actors: [] } };
    const mkRow = () => ({ input: { value: "" }, num: { value: "" }, out: {}, key: { dataset: {} }, nav: { style: {} }, row: {} });
    const panel = Object.create(PartsPanel.prototype);
    Object.assign(panel, { stage, el: { hidden: false }, rows: new Map(), _isPerson: () => false,
      _build(chans) { this.rows.clear(); for (const c of chans) this.rows.set(c.ch, mkRow()); } });
    panel.bind("crate");
    panel.bind("car");
    const r = panel.rows.get("door_fl");
    assert.equal(+r.input.value, 0, "the door slider shows closed");
    assert.equal(r.num.value, 0, "and its number says 0");
  } finally { globalThis.document = had; }
});

// The Director's Book sidebar cut every slugline to one line ("EXT. DESERT OUTSIDE DRY CR…") even at 1920 wide.
test("QA07: the Book's scene list shows sluglines on up to two lines", () => {
  const src = readFileSync(new URL("../../web/book/view.mjs", import.meta.url), "utf8");
  assert.match(src, /\.ss-bk \.ri \.t b \{ display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2;/);
});

// The visual guard ran every screen's after() even when --only skipped its run(): canvas_hidden's after() pressed H
// and hid every panel, so an --only physics_panel capture had no Physics panel.
test("QA07: the visual guard undoes only the screens it ran", () => {
  const src = readFileSync(new URL("../../tools/qa/visual_baseline.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(sc\.after && \(ran \|\| !sc\.run\)\) await sc\.after/);
});

// Pitch Mode with the browser's speech recognition and a denied mic: onerror said "Speech recognition stopped
// (not-allowed)…" and onend restarted it, so the Director filled with the same line a dozen times a second.
test("QA07: a denied mic stops Pitch listening and says so once", () => {
  const src = readFileSync(new URL("../../web/agent/directorpanel.mjs", import.meta.url), "utf8");
  const i = src.indexOf("function startPitchListen()");
  const body = src.slice(i, src.indexOf("function stopPitchListen()", i));
  assert.match(body, /const fatal = \/not-allowed\|service-not-allowed\|audio-capture\/\.test\(ev\.error\);/);
  assert.match(body, /if \(fatal\) \{ alive = false;/, "no restart after a fatal error");
  assert.match(body, /if \(!told\) \{ told = true; say\(/, "the message once per listen");
});
