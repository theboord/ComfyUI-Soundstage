// Finding your way back on the stage (web/stage/viewnav.mjs): ⌂ Back to the set frames the whole set, ↶ Last view steps
// back through the views that settled (and the ones before a jump or a drive), and a camera far off or inside a wall
// is "lost". node --test tests/js/viewnav.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { setBounds, homeView, lostReason, ViewHistory, installViewNav } from "../../web/stage/viewnav.mjs";

const street = [{ pos: [-11, 5, 0], half: [4.5, 5, 30] }, { pos: [11, 5, 0], half: [4.5, 5, 30] }];

test("home view: the whole set fits, seen from the front-right and above, looking at its centre", () => {
  const b = setBounds(street, [[0, 0, 5]]);
  assert.deepEqual(b.center.map((v) => +v.toFixed(2)), [0, 5, 0]);
  assert.ok(b.radius > 30 && b.radius < 40, `radius ${b.radius}`);
  const h = homeView(b, { fovDeg: 50, aspect: 16 / 9 });
  const d = Math.hypot(...h.position.map((v, i) => v - h.target[i]));
  assert.ok(d * Math.sin(25 * Math.PI / 180) >= b.radius, "the set's sphere fits the frame");
  assert.ok(h.position[1] > h.target[1] && h.position[0] > 0 && h.position[2] < 0, "above, front-right");
  assert.deepEqual(setBounds(), { center: [0, 1, 0], radius: 15 }, "an empty stage still has somewhere to go");
});

test("lost: more than 3 set radii away, or inside a building; the home view itself is not lost", () => {
  const b = setBounds(street);
  assert.equal(lostReason([0, 2, 0], b, street), null);
  assert.equal(lostReason([0, 2, 4 * b.radius], b, street), "far");
  assert.equal(lostReason([-11, 3, 4], b, street), "inside");
  assert.equal(lostReason(homeView(b).position, b, street), null);
});

test("history: a view is remembered after resting half a second, near-duplicates once; back steps through them", () => {
  const H = new ViewHistory(3);
  const v = (x) => ({ free: true, position: [x, 3, 10], target: [0, 1, 0] });
  H.watch(v(1), 0); H.watch(v(1), 200);
  assert.equal(H.list.length, 0, "not rested yet");
  H.watch(v(1), 600);
  assert.equal(H.list.length, 1);
  H.watch(v(1), 900); H.mark(v(1.01));
  assert.equal(H.list.length, 1, "the same view isn't stored twice");
  for (const x of [2, 3, 4]) H.mark(v(x));
  assert.equal(H.list.length, 3, "only the last few are kept");
  assert.equal(H.back(v(4)).position[0], 3, "from the newest, back to the one before");
  assert.equal(H.back(v(3)).position[0], 2);
  assert.equal(H.back(v(2)), null, "nothing older");
});

test("installed on a stage: Back to the set flies the free view home (shot camera untouched); Last view returns; jumps and Drive mark", () => {
  const flown = [];
  const st = {
    freeView: false, free: { position: [500, 40, 500], target: [480, 0, 480] }, actorMeshes: new Map(), camera: { fov: 50, aspect: 1.6 },
    _setCollidersCached: () => street, _viewportCamera() { return this.camera; }, _activeOrbit() { return this.freeView ? this.free : { position: [0, 2, 10], target: [0, 1, 0] }; },
    setFreeView(on) { this.freeView = on; }, _flyTo(p, t) { flown.push([p, t]); this.free = { position: p, target: t }; },
    frameSelected() { this.free = { position: [1, 1, 1], target: [0, 0, 0] }; return true; },
  };
  const nav = installViewNav(st);
  st.freeView = true;
  assert.equal(nav.lost(), "far", "500 m out over a 35 m set");
  const home = nav.backToSet();
  assert.deepEqual(flown[0], [home.position, home.target]);
  assert.equal(nav.lost(), null);
  st.frameSelected();                                     // a jump remembers where it came from
  assert.deepEqual(nav.lastView().position, home.position, "↶ back to the home view");
  assert.deepEqual(nav.lastView().position, [500, 40, 500], "↶ and before that, where you were lost");
  st.drive = { on: true };
  assert.equal(nav.lost(), null, "while driving the drive camera is in charge");
});
