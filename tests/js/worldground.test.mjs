// An imported world's "hide ground" survived only until the next set rebuild: _buildSet() ran WorldMount.attach()
// (which hides the clay floor) and then set ground.visible from the set's fx alone, so adding an object or changing
// the weather brought the 80 m floor back at y = 0 through the imported world's own floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 });
  return realFetch(input, init);
};
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, o = {}) { super(type); Object.assign(this, { lengthComputable: false, loaded: 0, total: 0, ...o }); }
};

function headless(actors, extra = {}) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), shot: { frames: 97, fps: 24 }, actors: structuredClone(actors), environment: { set: "studio" }, ...extra },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onSelect() {}, onInteract() {}, _buildLights() {},
  });
  st.changes = 0;
  st.onChange = () => { st.changes++; };
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.setFrame(0);
  return st;
}

test("an imported world keeps the clay ground hidden through a set rebuild", () => {
  const st = headless([]);
  st.state.world = { url: "file:///w.glb", name: "w", format: "glb", hide_ground: true, colliders: false };
  st.state.environment = { set: "empty" };
  const wm = st.worldMount;
  wm.prep = { soup: [], cameras: [] }; wm.url = "file:///w.glb"; wm.group = new THREE.Group(); wm.xform = new THREE.Group();
  wm._apply = () => {};
  wm._ground(true);
  assert.equal(st.ground.visible, false);
  st._buildSet();
  assert.equal(st.ground.visible, false, "hide_ground is still on");
  st.state.world = null;                        // world removed: the floor comes back
  st._buildSet();
  assert.equal(st.ground.visible, true);
});
