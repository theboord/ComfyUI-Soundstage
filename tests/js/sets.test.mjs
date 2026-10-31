// Milestone 11 sets (web/stage/sets): every set builds deterministically with no NaNs, animates as a pure function of
// the frame, registers in the set picker, and scene setup picks it for its locations.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { SETS, WEATHER, buildSet, buildWeather } from "../../web/stage/environments.mjs";
import { LIBRARY, SEATS, buildObject, resolveKind } from "../../web/stage/library.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";
import { cabinSlots, PLANE_SEATS } from "../../web/stage/sets/airplane.mjs";
import { carSlots, stationFloor, STATION, TRAIN_SEATS } from "../../web/stage/sets/train.mjs";
import { seabedHeight } from "../../web/stage/sets/underwater.mjs";
import { planSceneSetup, newSetForScene, seatRowsForSet } from "../../web/script/scenesetup.mjs";

const NEW = ["underwater", "burning_building", "airplane_cabin", "runway", "above_clouds", "train_car", "train_station"];
const mesh = (g, c) => new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c || "#999" }));

/** A hash of every vertex in a group (world space), plus a NaN count. */
function digest(group) {
  group.updateMatrixWorld(true);
  let h = 0, n = 0, nan = 0;
  const v = new THREE.Vector3();
  group.traverse((o) => {
    if (!(o.isMesh || o.isPoints) || !o.visible) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      if (!Number.isFinite(v.x + v.y + v.z)) { nan++; continue; }
      h = (h + Math.round(v.x * 100) * 31 + Math.round(v.y * 100) * 17 + Math.round(v.z * 100) * 7) % 1000000007;
      n++;
    }
  });
  return { h, n, nan };
}

test("the new sets are in the set picker and the Fire atmospheric is in Elements", () => {
  for (const id of NEW) assert.ok(SETS[id]?.label, id);
  assert.ok(WEATHER.fire?.label);
});

for (const id of NEW) {
  test(`${id}: builds the same twice, no NaNs, animates as a pure function of the frame`, () => {
    clearSetCache();
    const a = buildSet(id, mesh, {});
    assert.ok(a.group && a.group.children.length > 0);
    a.fx?.update?.(0, null);
    const d1 = digest(a.group);
    assert.equal(d1.nan, 0);
    assert.ok(d1.n > 100);
    clearSetCache();
    const b = buildSet(id, mesh, {});
    b.fx?.update?.(0, null);
    assert.deepEqual(digest(b.group), d1);
    if (a.fx?.update) {
      a.fx.update(30, null);
      const at30 = digest(a.group);
      assert.equal(at30.nan, 0);
      a.fx.update(77, null);
      a.fx.update(30, null);
      assert.deepEqual(digest(a.group), at30);
    }
  });
}

test("the Fire atmospheric burns anywhere, deterministically", () => {
  const w = buildWeather("fire", 0.6);
  w.update(12, { x: 0, z: 0 }, null);
  const d = digest(w.object);
  assert.equal(d.nan, 0);
  w.update(40, { x: 0, z: 0 }, null); w.update(12, { x: 0, z: 0 }, null);
  assert.deepEqual(digest(w.object), d);
});

test("the airliner, the train and the seat rows are library objects (nose / front +Z, seats to sit in)", () => {
  for (const k of ["airliner", "train", "plane_seats", "train_seats"]) {
    const g = buildObject(k, null, mesh);
    const box = new THREE.Box3().setFromObject(g);
    assert.ok(Number.isFinite(box.min.x) && box.min.y > -0.05, k);
    assert.ok(Math.abs(box.max.y - LIBRARY[k].height) < 0.25, `${k} height ${box.max.y}`);
  }
  const jet = new THREE.Box3().setFromObject(buildObject("airliner", null, mesh));
  assert.ok(jet.max.z > 15 && jet.min.z < -18);                 // nose forward
  const train = new THREE.Box3().setFromObject(buildObject("train", null, mesh));
  assert.ok(train.max.z > 9 && train.min.z < -75);               // locomotive leads, carriages trail behind
  assert.deepEqual(SEATS.plane_seats, PLANE_SEATS);
  assert.deepEqual(SEATS.train_seats, TRAIN_SEATS);
  assert.equal(resolveKind("airplane"), "airliner");
  assert.equal(resolveKind("locomotive"), "train");
});

test("a seat-row object on a cabin slot takes that dressing row out", () => {
  clearSetCache();
  const b = buildSet("airplane_cabin", mesh, {});
  const slot = cabinSlots()[24];
  const before = digest(b.group);
  b.fx.update(0, { state: { actors: [{ id: "r", kind: "plane_seats", position: [slot.x, 0, slot.z] }], shot: { fps: 24 } } });
  assert.notEqual(digest(b.group).h, before.h);
  assert.deepEqual(b.fx.seatBank.hidden, new Set([24]));
  b.fx.update(0, { state: { actors: [], shot: { fps: 24 } } });
  assert.equal(digest(b.group).h, before.h);
  assert.equal(carSlots().length, 36);
});

test("walkable floors: the platforms and the seabed", () => {
  assert.equal(stationFloor(5, 0), STATION.platformTop);
  assert.equal(stationFloor(0, 0), 0);
  assert.equal(stationFloor(-9, 10), STATION.platformTop);
  for (const [x, z] of [[0, 0], [12, 20], [-30, 50]]) { const y = seabedHeight(x, z); assert.ok(y >= 0.06 && y < 6, `${x},${z}: ${y}`); }
});

const scene = (int_ext, location, characters = ["MARA"], time = "DAY") =>
  ({ number: "1", int_ext, location, heading: `${int_ext}. ${location} - ${time}`, time, characters, elements: [], stage_hint: { objects: [] } });

test("scene setup picks the new sets from the location", () => {
  const cases = [
    ["INT", "AIRPLANE CABIN", "airplane_cabin"], ["INT", "PLANE", "airplane_cabin"], ["EXT", "UNDERWATER", "underwater"],
    ["EXT", "CORAL REEF", "underwater"], ["INT", "WATER TANK", null], ["INT", "TRAIN", "train_car"], ["INT", "TRAIN - DINING CAR", "train_car"],
    ["EXT", "TRAIN STATION", "train_station"], ["EXT", "RAILWAY PLATFORM", "train_station"], ["EXT", "BURNING BUILDING", "burning_building"],
    ["EXT", "AIRPORT RUNWAY", "runway"], ["EXT", "SKY - AIRLINER", "above_clouds"], ["EXT", "MAIN STREET", null], ["INT", "DINER", null],
  ];
  for (const [ie, loc, want] of cases) assert.equal(newSetForScene(scene(ie, loc)), want, `${ie}. ${loc}`);
  for (const [ie, loc, want] of cases) if (want) assert.equal(planSceneSetup(scene(ie, loc)).env.set, want, `${ie}. ${loc}`);
  assert.equal(planSceneSetup({ ...scene("INT", "WATER TANK"), stage_hint: { set: "water_tank", objects: [] } }).env.set, "water_tank");
});

test("INT. AIRPLANE CABIN: the cast sits by the window in a cabin seat row; no airliner parked in the aisle", () => {
  const sc = { ...scene("INT", "AIRPLANE CABIN", ["MARA", "EZRA"]), stage_hint: { objects: ["airliner"] } };
  const p = planSceneSetup(sc, { fresh: true });
  assert.equal(p.env.set, "airplane_cabin");
  assert.equal(p.vehicle, null);
  assert.deepEqual(p.objects, []);
  assert.equal(p.hosts.length, 1);
  assert.equal(p.hosts[0].kind, "plane_seats");
  const slot = cabinSlots().find((q) => Math.abs(q.x - p.hosts[0].at.position[0]) < 1e-6 && Math.abs(q.z - p.hosts[0].at.position[2]) < 1e-6);
  assert.ok(slot, "the seat row stands on a cabin slot");
  assert.deepEqual(p.people.map((x) => x.mount), [{ host: 0, seat: 0 }, { host: 0, seat: 1 }]);
  assert.ok(p.stage.camera);
});

test("INT. TRAIN: two passengers face each other at the window across a table", () => {
  const p = planSceneSetup(scene("INT", "TRAIN", ["MARA", "EZRA"]), { fresh: true });
  assert.equal(p.env.set, "train_car");
  assert.equal(p.hosts.length, 2);
  assert.deepEqual(p.hosts.map((h) => h.at.rotation_deg), [0, 180]);
  assert.deepEqual(p.people.map((x) => x.mount), [{ host: 0, seat: 0 }, { host: 1, seat: 1 }]);
  for (const h of p.hosts) assert.ok(carSlots().some((q) => Math.hypot(q.x - h.at.position[0], q.z - h.at.position[2]) < 1e-6));
  assert.equal(seatRowsForSet("train_car", 1).length, 1);
});

test("EXT. TRAIN STATION: the train drives in along the track, forward (+Z), never backwards", () => {
  const p = planSceneSetup(scene("EXT", "TRAIN STATION"), { fresh: true, last: 120 });
  assert.equal(p.env.set, "train_station");
  assert.ok(p.objects.includes("train"));
  const k = p.stage.place.train.keys;
  assert.equal(k[k.length - 1].frame, 120);
  assert.ok(k[k.length - 1].position[2] > k[0].position[2]);
  assert.equal(p.stage.place.train.rotation_deg, 0);
  assert.ok(stationFloor(p.stage.center[0], p.stage.center[1]) > 0, "the cast stands on the platform");
  const r = planSceneSetup(scene("EXT", "AIRPORT RUNWAY"), { fresh: true });
  assert.ok(r.objects.includes("airliner"));
  const u = planSceneSetup(scene("EXT", "UNDERWATER"), { fresh: true });
  assert.ok(u.stage.lift > 1, "underwater, people swim");
});

test("the clouds past the cabin and the land past the carriage scroll on the set the stage shows (a clone), aft", () => {
  for (const id of ["airplane_cabin", "train_car"]) {
    const b = buildSet(id, mesh, {});
    const tiles = b.group.children.filter((o) => o.userData.scroll);
    assert.equal(tiles.length, 2, id);
    const stage = { _setGroup: b.group, state: { actors: [], shot: { fps: 24 } } };
    b.fx.update(0, stage);
    const z0 = tiles[0].position.z;
    b.fx.update(6, stage);
    const z6 = tiles[0].position.z;
    assert.ok(z6 < z0 && z0 - z6 < 10, `${id}: ${z0} -> ${z6}`);   // moves toward the back (-Z), a few metres in 6 frames
    b.fx.update(0, stage);
    assert.equal(tiles[0].position.z, z0);
  }
});
