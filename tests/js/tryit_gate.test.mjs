// Every shipped try-it scene passes the render's consequence check (world collisions) as it ships: the Director's draft
// render goes ahead, with nothing passing through anything and no auto-bake needed to get there (an auto-bake would
// change the shot: a runner knocked down that nobody wrote). Scenes: tools/tryit/scenes/*.json (what the demo
// publishes) and web/tryit/scenes.mjs PRESETS (the in-app try-it list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import { PRESETS } from "../../web/tryit/scenes.mjs";

globalThis.window ||= {};
globalThis.localStorage ||= { getItem: () => null, setItem() {} };
const _warn = console.warn;
console.warn = (...a) => { if (!/model failed|rigged .* failed/.test(String(a[0]))) _warn(...a); };   // no model files headless

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tools/tryit/scenes");

function headless(scene) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), ...structuredClone(scene) }, view: "clay", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onInteract() {}, onSelect() {}, onShots() {}, onChange() {}, _buildLights() {}, _applySun() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;
  st.live = new LiveEdit(st, liveKinds());
  st.setFrame(0);
  return st;
}

async function gate(scene) {
  const { Director, EXEC } = await import("../../web/agent/director.mjs");
  const st = headless(scene);
  let rendered = 0;
  const d = new Director({ api: { fetchApi: async () => ({ ok: false }) }, stage: st, host: { pipeline: { _render: async () => { rendered++; } } } });
  const r = await EXEC.render.call(d, { kind: "draft", shots: [scene.active_shot || scene.shots?.[0]?.id || "s1"] });
  return { r, rendered, baked: st.state.actors.filter((a) => a.physics?.baked).map((a) => a.id) };
}

const shipped = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => {
  const s = JSON.parse(readFileSync(join(DIR, f), "utf8")).scene;
  return [f, typeof s === "string" ? JSON.parse(s) : s];
}).filter(([, s]) => s?.actors);

test("try-it: there are shipped scenes to check (aliens among them)", () => {
  assert.ok(shipped.length >= 15, `${shipped.length} scenes`);
  assert.ok(shipped.some(([f]) => f === "aliens.json"));
});

for (const [f, scene] of shipped) {
  test(`try-it ${f}: the draft render passes the consequence check as shipped`, async () => {
    const { r, rendered, baked } = await gate(scene);
    assert.ok(r.ok && rendered === 1, JSON.stringify(r));
    assert.deepEqual(baked, [], "no auto-bake needed (nothing in it passes through anything)");
  });
}

for (const p of PRESETS) {
  test(`try-it preset ${p.id}: the draft render passes the consequence check as made`, async () => {
    const { r, rendered, baked } = await gate(p.make());
    assert.ok(r.ok && rendered === 1, JSON.stringify(r));
    assert.deepEqual(baked, [], "no auto-bake needed (nothing in it passes through anything)");
  });
}
