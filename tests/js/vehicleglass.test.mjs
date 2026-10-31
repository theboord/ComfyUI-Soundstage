// Vehicle glass: people seated in a vehicle show through its glass (Clay and Color), the cabin fittings ride under
// the real-car bodies, and glass never casts a shadow into the cabin.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { LIBRARY, buildObject, glassMaterial, makeGlass } from "../../web/stage/library.mjs";

const mesh = (geom, color) => new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: new THREE.Color(color || "#9a9a9a") }));
const meshes = (g, pred) => { const out = []; g.traverse((o) => { if (o.isMesh && pred(o)) out.push(o); }); return out; };

test("glass is a light, see-through tint that Clay's override material leaves alone", () => {
  const m = glassMaterial();
  assert.equal(m.transparent, true);
  assert.ok(m.opacity > 0 && m.opacity <= 0.35, `opacity ${m.opacity}`);
  assert.equal(m.allowOverride, false);
  assert.equal(m.depthWrite, false);
  assert.ok(new THREE.Color(m.color).getHSL({}).l > 0.6, "a light tint, not the models' black glass");
  const g = makeGlass(mesh(new THREE.BoxGeometry(1, 1, 1)));
  assert.equal(g.userData.glass, true);
  assert.equal(g.castShadow, false);
  assert.equal(g.material, m);
});

test("the truck's cab is glass under a roof, so its driver shows", () => {
  const g = buildObject("truck", null, mesh);
  const glass = meshes(g, (o) => o.userData.glass);
  assert.equal(glass.length, 1);
  const cab = new THREE.Box3().setFromObject(glass[0]);
  const driver = [0.5, 1.25 + 0.6, 2.3];   // the driver's seat, chest height
  assert.ok(cab.containsPoint(new THREE.Vector3(...driver)), "the driver sits inside the glass cab");
});

test("the motorboat's windscreen is glass", () => {
  assert.equal(meshes(buildObject("boat", null, mesh), (o) => o.userData.glass).length, 1);
});

test("the sedan tags its seats, dash and wheel as cabin (kept under the real-car bodies)", () => {
  for (const kind of ["car", "sports_car", "police_car", "hatchback"]) {
    const cabin = buildObject(kind, null, mesh).children.filter((o) => o.userData.cabin);
    assert.equal(cabin.length, 10, kind);   // 4 cushions + 4 backs + dash + wheel
  }
  assert.equal(LIBRARY.hatchback.cabin, false, "the hatchback's low roof hides the built cabin");
  assert.notEqual(LIBRARY.sports_car.cabin, false);
  assert.notEqual(LIBRARY.police_car.cabin, false);
});
