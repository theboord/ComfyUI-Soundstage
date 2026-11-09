// The ID (matte) pass draws each object in EXACTLY its declared scene.id_colors value (stage.idColors()). It used to be
// sRGB-encoded on output (255,0,223 drawn as 255,0,240; 0,255,212 as 0,255,235), so every mask built from the declared
// colour (App attention / people masks, the frame check, nodes_matte, layerpack) came out empty.
// Unit: _renderId renders with a linear output (screen and the offscreen "XR" capture target) and no tone mapping, then
// puts the renderer back. Browser: tests/browser/idpass.html renders seven crates in real WebGL, both paths, and
// asserts declared == rendered pixel for pixel (skipped, saying so, without a headless Chromium).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage } from "../../web/stage/stage.mjs";
import { idMaterial } from "../../web/stage/people/cutout.mjs";
import { runShaders, findBrowser } from "../browser/run_shaders.mjs";

function fakeStage(rt = null) {
  const st = Object.create(Stage.prototype);
  const seen = [];
  const renderer = {
    outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping,
    getRenderTarget: () => rt,
    render(scene) {
      const mats = [];
      scene.traverse((o) => { if (o.isMesh) mats.push(o.material); });
      seen.push({ ocs: this.outputColorSpace, tm: this.toneMapping, tcs: rt?.texture.colorSpace, mats });
    },
  };
  const scene = new THREE.Scene();
  const person = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  person.userData.actorId = "p3";
  scene.add(person);
  Object.assign(st, { renderer, scene, state: { actors: [0, 1, 2, 3, 4].map((i) => ({ id: `p${i}` })) } });
  return { st, seen, renderer };
}

test("idColors gives the mid values the bug report named (index 3 = 255,0,223, index 4 = 0,255,212)", () => {
  const { st } = fakeStage();
  const c = st.idColors();
  assert.deepEqual(c.p3, [255, 0, 223]);
  assert.deepEqual(c.p4, [0, 255, 212]);
});

test("_renderId renders with a linear output and no tone mapping, and puts the renderer back", () => {
  const { st, seen, renderer } = fakeStage();
  st._renderId(new THREE.PerspectiveCamera());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ocs, THREE.LinearSRGBColorSpace, "no sRGB encode on the ID pass");
  assert.equal(seen[0].tm, THREE.NoToneMapping);
  const m = seen[0].mats[0];
  assert.equal(m.toneMapped, false);
  assert.deepEqual([m.color.r, m.color.g, m.color.b].map((v) => Math.round(v * 255)), [255, 0, 223], "the material holds the declared value");
  assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace, "restored for the Color pass");
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
});

test("_renderId into the offscreen capture target (isXRRenderTarget: three reads the target texture's colour space) is linear too, then restored", () => {
  const rt = { isXRRenderTarget: true, texture: { colorSpace: THREE.SRGBColorSpace } };
  const { st, seen } = fakeStage(rt);
  st._renderId(new THREE.PerspectiveCamera());
  assert.equal(seen[0].tcs, THREE.LinearSRGBColorSpace);
  assert.equal(rt.texture.colorSpace, THREE.SRGBColorSpace);
});

test("_renderId restores the renderer even when the render throws", () => {
  const { st, renderer } = fakeStage();
  renderer.render = () => { throw new Error("lost context"); };
  assert.throws(() => st._renderId(new THREE.PerspectiveCamera()));
  assert.equal(renderer.outputColorSpace, THREE.SRGBColorSpace);
});

test("idMaterial (cut-out cards too) is never tone mapped", () => {
  const c = new THREE.Color(1, 0, 223 / 255);
  assert.equal(idMaterial(new THREE.MeshStandardMaterial(), c).toneMapped, false);
  const card = new THREE.MeshStandardMaterial({ alphaTest: 0.5, map: new THREE.Texture() });
  for (const m of [].concat(idMaterial([card, new THREE.MeshBasicMaterial()], c))) assert.equal(m.toneMapped, false);
});

const browser = findBrowser();
test("real WebGL: the ID pass draws every declared colour exactly (canvas and offscreen), and Color is unchanged after it", { skip: browser ? false : "no headless Chromium / Chrome on this machine", timeout: 150000 }, async () => {
  const r = await runShaders({ page: "idpass.html", timeoutMs: 120000 });
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.errors, []);
  for (const [path, per] of Object.entries(r.paths)) {
    for (const [id, row] of Object.entries(per)) {
      if (id === "_top") continue;
      assert.ok(row.exactPx > 200, `${path} ${id}: declared ${row.declared} drawn on ${row.exactPx} px; most drawn: ${JSON.stringify(per._top.slice(0, 8))}`);
    }
  }
  assert.equal(r.colourChangedAfterId, 0, "the Color pass is the same before and after an ID render");
  assert.equal(r.outputColorSpace, THREE.SRGBColorSpace);
});
