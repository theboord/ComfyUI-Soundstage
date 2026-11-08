// node --test tests/js/shaders_browser.test.mjs
// The Depth pass shader (web/stage/depthshader.mjs: skinned, unskinned, cut-out) and the selection outline
// (web/stage/outline.mjs: stencil mask + hull, skinned) compiled and rendered in real WebGL, in a headless Chromium
// already on this machine (tests/browser/run_shaders.mjs installs nothing). Node alone can't compile GLSL, so before
// this neither shader had ever been compiled by a test. Skipped, saying so, when no browser is found.
import test from "node:test";
import assert from "node:assert/strict";
import { runShaders, findBrowser } from "../browser/run_shaders.mjs";

const browser = findBrowser();

test("Depth and outline shaders compile and render in WebGL: a posed skinned mesh's Depth silhouette matches its colour silhouette; the outline rings it", { skip: browser ? false : "no headless Chromium / Chrome on this machine (run tests/browser/run_shaders.mjs where one is)", timeout: 90000 }, async () => {
  const r = await runShaders();
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.errors, [], "no shader compile / link errors, no exceptions");
  const c = r.checks;
  for (const k of ["depth_skinned", "depth_unskinned", "depth_cutout"]) {
    assert.ok(c[k].colourPx > 200, `${k}: the mesh is on screen (${c[k].colourPx} px)`);
    assert.ok(c[k].iou >= 0.9, `${k}: Depth silhouette vs colour silhouette overlap ${c[k].iou}`);
  }
  // the bend matters: the bind pose covers different pixels, so a Depth pass that ignored skinning would fail above
  assert.ok(c.depth_skinned.bindVsPosedIou < 0.7, `posed vs bind pose overlap ${c.depth_skinned.bindVsPosedIou}`);
  const o = c.outline_skinned;
  assert.equal(o.insidePx, 0, "the outline draws nothing over the object (stencil mask)");
  assert.ok(o.ringPx > 40, `an outline ring outside the silhouette (${o.ringPx} px)`);
  assert.ok(o.ringNearSilhouette >= 0.95, `the ring hugs the posed silhouette (${o.ringNearSilhouette} within 4 px)`);
});
