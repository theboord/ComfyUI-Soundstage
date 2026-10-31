// node --test tests/js/firstrun.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { tourSeen, markTourSeen, TOUR_STEPS, isBrandNewStage, placeCard, unionRect, outOfView } from "../../web/ui/firstrun.mjs";
import { clipText } from "../../web/ui/canvasui.mjs";
import { pickInfo } from "../../web/script/scenestrip.mjs";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

// The default stage (stage.mjs DEFAULT_SCENE) as a fresh App workflow saves it, plus the Master camera.
const fresh = () => ({
  version: 2, shot: { frames: 97, fps: 24 },
  actors: [
    { id: "actor_a", name: "Actor A", position: [-0.6, 0, -6], keys: [{ frame: 0, position: [-0.6, 0, -6] }, { frame: 96, position: [-0.6, 0, 12.5] }] },
    { id: "actor_b", name: "Actor B", position: [0.6, 0, -6], keys: [{ frame: 0, position: [0.6, 0, -6] }, { frame: 96, position: [0.6, 0, 12.5] }] },
  ],
  props: [{ id: "building" }, { id: "planter_l" }, { id: "planter_r" }, { id: "lamp" }],
  environment: { set: "plaza", weather: "none" },
  lighting: { mode: "manual", lights: [] },
  shots: [{ id: "master", name: "Master" }],
});

test("the tour shows once: remembered, and blocked storage counts as seen (no nagging)", () => {
  const s = mem();
  assert.equal(tourSeen(s), false);
  markTourSeen(s);
  assert.equal(tourSeen(s), true);
  assert.equal(tourSeen(broken), true);
  assert.doesNotThrow(() => markTourSeen(broken));
  assert.equal(tourSeen(undefined), false);
});

test("the tour is 4-6 steps, one sentence each, covering start → deliver", () => {
  assert.ok(TOUR_STEPS.length >= 4 && TOUR_STEPS.length <= 6);
  assert.deepEqual(TOUR_STEPS.map((s) => s.id), ["start", "scene", "block", "frame", "motion", "finish"]);
  for (const s of TOUR_STEPS) {
    assert.ok(s.title && s.text, s.id);
    assert.equal((s.text.match(/[.!?](\s|$)/g) || []).length, 1, `${s.id}: one sentence`);
    assert.ok(s.text.length <= 170, `${s.id}: short`);
  }
  assert.match(TOUR_STEPS[0].text, /script/i);
  assert.match(TOUR_STEPS[0].text, /video/i);
  assert.match(TOUR_STEPS[0].text, /demo/i);
  assert.match(TOUR_STEPS.find((s) => s.id === "motion").text, /Draft.*Final/);
});

test("a brand-new stage: the default scene, no script, nothing rendered", () => {
  assert.equal(isBrandNewStage(fresh()), true);
  assert.equal(isBrandNewStage({ ...fresh(), shots: [] }), true);
  assert.equal(isBrandNewStage(fresh(), { hasScript: true }), false);
  assert.equal(isBrandNewStage(fresh(), { renders: 1 }), false);
  assert.equal(isBrandNewStage(null), false);
});

test("anything the user did makes the stage not new", () => {
  const added = fresh(); added.actors.push({ id: "horse_1", kind: "horse" });
  const moved = fresh(); moved.actors[0].keys.push({ frame: 40, position: [0, 0, 0] });
  const posed = fresh(); posed.actors[1].pose = "sit";
  const set = fresh(); set.environment.set = "desert";
  const prop = fresh(); prop.props.pop();
  const shots = fresh(); shots.shots.push({ id: "b", name: "B" });
  const light = fresh(); light.lighting.lights.push({ id: "l1" });
  const mocap = fresh(); mocap.actors[0].mocap = { clip: "x" };
  for (const [name, sc] of Object.entries({ added, moved, posed, set, prop, shots, light, mocap })) assert.equal(isBrandNewStage(sc), false, name);
});

test("coach-mark card placement: below, above, beside, centred; always on screen", () => {
  const view = { w: 1280, h: 800 }, card = { w: 340, h: 160 };
  const at = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });
  assert.equal(placeCard(at(100, 20, 200, 30), card, view).side, "below");                  // a top-row button
  assert.equal(placeCard(at(10, 740, 400, 40), card, view).side, "above");                  // a bottom bar
  const r = placeCard(at(10, 80, 60, 700), card, view);                                     // the tool rail
  assert.equal(r.side, "right");
  assert.ok(r.left >= 70 + 14);
  const c = placeCard(null, card, view);
  assert.deepEqual([c.side, c.left, c.top], ["center", 470, 320]);
  const full = placeCard(at(0, 0, 1280, 800), card, view);                                   // the whole canvas
  assert.equal(full.side, "inside");
  for (const p of [placeCard(at(1200, 10, 70, 30), card, view), placeCard(at(-50, 790, 30, 30), card, view), full]) {
    assert.ok(p.left >= 12 && p.left + card.w <= view.w - 12, JSON.stringify(p));
    assert.ok(p.top >= 12 && p.top + card.h <= view.h - 12, JSON.stringify(p));
  }
});

test("unionRect: the box around the visible targets", () => {
  const r = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  assert.equal(unionRect([]), null);
  assert.equal(unionRect([r(0, 0, 0, 0), null]), null);
  assert.deepEqual(unionRect([r(10, 20, 30, 40), r(100, 5, 10, 10), r(0, 0, 0, 0)]), { left: 10, top: 5, right: 110, bottom: 60, width: 100, height: 55 });
});

test("clipText: whitespace collapsed, an ellipsis past n", () => {
  assert.equal(clipText("  engine   roaring  ", 40), "engine roaring");
  assert.equal(clipText("sports car engine roaring, tyres on asphalt", 20), "sports car engine r…");
  assert.equal(clipText("", 10), "");
  assert.equal(clipText(null, 10), "");
});

test("the compact scene button: the scene on the stage and its shot; without a script, the stage", () => {
  const scenes = [
    { id: "sc_1", number: "1", heading: "EXT. DESERT - DUSK", int_ext: "EXT", location: "DESERT", time: "DUSK" },
    { id: "sc_2", number: "2", heading: "EXT. DRY CREEK - MAIN STREET - NIGHT", int_ext: "EXT", location: "DRY CREEK - MAIN STREET", time: "NIGHT" },
  ];
  const shots = [{ id: "a", name: "Wide crane" }, { id: "b", name: "Tracking" }];
  const p = pickInfo(scenes, "sc_2", shots, "b");
  assert.equal(p.num, "2");
  assert.equal(p.where, "EXT. Dry Creek - Main Street");
  assert.equal(p.time, "night");
  assert.equal(p.shot, "Tracking");
  assert.equal(p.scenes, 2);
  const none = pickInfo(scenes, null, shots, "a");
  assert.equal(none.where, "Pick a scene");
  assert.equal(none.sub, "2 scenes");
  const stage = pickInfo([], null, [shots[0]], "a");
  assert.deepEqual([stage.num, stage.where, stage.sub, stage.shot], ["", "The stage", "1 shot", "Wide crane"]);
  assert.equal(pickInfo(null, null, null, null).sub, "0 shots");
});

test("tour: a control hidden by a scrolling panel is scrolled into view first (QA round 01)", () => {
  const box = { top: 85, bottom: 740 };   // the App's side panel, above ComfyUI's Run section
  // The empty-state card below the fold of the narrow App panel (seen at y 768..1321 in a 900 px window).
  assert.equal(outOfView({ top: 768, bottom: 1321 }, box), true);
  // Fully inside: leave the page alone.
  assert.equal(outOfView({ top: 200, bottom: 400 }, box), false);
  // Cut at the top or the bottom.
  assert.equal(outOfView({ top: 60, bottom: 120 }, box), true);
  assert.equal(outOfView({ top: 700, bottom: 760 }, box), true);
  // Taller than the panel: shown once its top is in view.
  assert.equal(outOfView({ top: 120, bottom: 1200 }, box), false);
  assert.equal(outOfView({ top: 730, bottom: 1600 }, box), true);
  assert.equal(outOfView(null, box), false);
});
