// Clean street: in ride-along car shots on an empty road the city street is one unbroken facade a side (no gaps or
// blocks sliding past the frame edge for LTX to read as traffic), long enough for the whole drive.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { buildSet } from "../../web/stage/environments.mjs";

const mesh = (g) => new THREE.Mesh(g);
const boxes = (group) => group.children.filter((m) => m.geometry?.type === "BoxGeometry").map((m) => {
  const p = m.geometry.parameters;
  return { x0: m.position.x - p.width / 2, x1: m.position.x + p.width / 2, h: p.height, z0: m.position.z - p.depth / 2, z1: m.position.z + p.depth / 2 };
});

test("the ordinary street has separate blocks with gaps and lamp posts", () => {
  const { group } = buildSet("street_night", mesh);
  const tall = boxes(group).filter((b) => b.h > 2 && b.x0 > 0).sort((a, b) => a.z0 - b.z0);
  assert.ok(tall.length > 3);
  assert.ok(tall.some((b, i) => i && b.z0 > tall[i - 1].z1), "gaps between blocks");
  assert.ok(new Set(tall.map((b) => b.h.toFixed(1))).size > 1, "uneven roofline");
  assert.ok(group.children.some((m) => m.geometry?.type === "CylinderGeometry"), "lamp posts");
});

test("the clean street is one smooth facade a side over the whole span, kerbs, and nothing else", () => {
  const span = [-200, 200];
  const { group } = buildSet("street_night", mesh, { clean: true, span });
  const all = boxes(group);
  assert.equal(group.children.length, all.length, "only boxes: no lamp posts");
  for (const side of [-1, 1]) {
    const walls = all.filter((b) => b.h > 2 && Math.sign(b.x0 + b.x1) === side);
    assert.equal(walls.length, 1, "one facade");
    const w = walls[0];
    assert.ok(w.z0 <= span[0] + 1e-6 && w.z1 >= span[1] - 1e-6, "covers the drive and beyond");
    assert.ok(Math.min(Math.abs(w.x0), Math.abs(w.x1)) >= 6.9, "clear of the road and sidewalk");
    const kerb = all.filter((b) => b.h < 0.5 && Math.sign(b.x0 + b.x1) === side);
    assert.equal(kerb.length, 1);
  }
});
