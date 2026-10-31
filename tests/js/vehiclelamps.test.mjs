// Cars face the way they drive (red_car_backwards): the real-car bodies light their lamps in the Color pass (warm-white
// headlights, red tail lights) so the guide and the look still show which end is the front, and on the Car Chase set
// every car's headlights lead its motion. Headless Stage (no WebGL), the real GLBs read from disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";

// GLTFLoader fetches the models; node's fetch has no file: scheme, so serve those from disk.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};

const chase = () => {
  const wf = JSON.parse(readFileSync(new URL("../../example_workflows/Soundstage_Car_Chase.json", import.meta.url), "utf8"));
  return JSON.parse(wf.nodes.find((n) => n.type === "SoundstageStage").widgets_values[0]);
};

function headless(actors) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: { set: "studio" } }, view: "color", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}

/** Wait for the async GLB bodies to land on every vehicle. */
async function bodies(st, ids) {
  for (let i = 0; i < 400; i++) {
    if (ids.every((id) => st.actorMeshes.get(id)?.userData.vehicleBody)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`car bodies never loaded: ${ids.filter((id) => !st.actorMeshes.get(id)?.userData.vehicleBody)}`);
}

const lamps = (g, which) => { const out = []; g.userData.vehicleBody.traverse((o) => { if (o.isMesh && o.userData.lamp === which) out.push(o); }); return out; };
const centre = (meshes) => { const b = new THREE.Box3(); for (const m of meshes) b.expandByObject(m); return b.getCenter(new THREE.Vector3()); };

test("the car bodies light their lamps: warm-white headlights, red tail lights, own material copies", async () => {
  const st = headless(chase().actors);
  const ids = ["sports_car", "police_car"];
  await bodies(st, ids);
  for (const id of ids) {
    const g = st.actorMeshes.get(id);
    const head = lamps(g, "Headlights"), tail = lamps(g, "TailLights");
    assert.ok(head.length && tail.length, `${id}: has headlight and tail-light meshes`);
    for (const m of [...head, ...tail]) assert.ok(m.material.emissiveIntensity > 1, `${id} ${m.userData.lamp}: emissive ${m.material.emissiveIntensity}`);
    const hc = head[0].material.emissive, tc = tail[0].material.emissive;
    assert.ok(hc.r > 0.9 && hc.g > 0.85 && hc.b > 0.7, `${id}: headlights are warm white (${hc.getHexString()})`);
    assert.ok(tc.r > 0.9 && tc.g < 0.2 && tc.b < 0.2, `${id}: tail lights are red (${tc.getHexString()})`);
  }
  // Cloned per car: lighting one car's lamps never touches the shared cached GLB material.
  const a = lamps(st.actorMeshes.get("sports_car"), "Headlights")[0].material, b = lamps(st.actorMeshes.get("police_car"), "Headlights")[0].material;
  assert.notEqual(a, b);
});

test("Car Chase: every car's headlights lead its motion (headlight - tail light . velocity > 0.95)", async () => {
  const st = headless(chase().actors);
  const ids = st.state.actors.filter((a) => a.kind === "sports_car" || a.kind === "police_car").map((a) => a.id);
  assert.equal(ids.length, 2);
  await bodies(st, ids);
  const at = (f) => { st.setFrame(f); st.root.updateMatrixWorld(true); };
  let checked = 0;
  for (let f = 4; f <= 116; f += 8) {
    for (const id of ids) {
      const g = st.actorMeshes.get(id);
      at(f - 2); const p0 = g.getWorldPosition(new THREE.Vector3());
      at(f + 2); const p1 = g.getWorldPosition(new THREE.Vector3());
      const v = p1.sub(p0).setY(0);
      if (v.length() < 0.05) continue;   // parked
      at(f);
      const nose = centre(lamps(g, "Headlights")).sub(centre(lamps(g, "TailLights"))).setY(0).normalize();
      const dot = nose.dot(v.normalize());
      assert.ok(dot > 0.95, `${id} @ frame ${f}: lamps . velocity = ${dot.toFixed(3)} (driving backwards?)`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} moving car-frames`);
});
