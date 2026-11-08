// Eighth water pass, close-out (2026-11-08): regressions found in review of the eighth pass (7eafe37) against b1f6d51,
// and two first fixes the pass left open. Each regression test fails on 7eafe37, each other test on b1f6d51. Invented
// test scenes only. node --test tests/js/water_pass9.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";
import { DriveMode } from "../../web/stage/drive.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";
import { personKeypoints } from "../../web/stage/posepass.mjs";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };
globalThis.requestAnimationFrame ||= () => 0;
globalThis.cancelAnimationFrame ||= () => {};
globalThis.addEventListener ||= () => {};
globalThis.removeEventListener ||= () => {};
globalThis.ProgressEvent ??= class extends Event {};   // the rigged horse's model loads in the background

const LEVEL = 2.5;   // the Water tank's level (environments.mjs)
function tank(actors, { frames = 121, keepSet = false } = {}) {
  clearSetCache();
  const st = Object.create(Stage.prototype);
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), shot: { frames, fps: 24 }, actors: structuredClone(actors), environment: { set: "water_tank" } },
    view: "clay", key: "start", frame: 0, actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract(m) { st.said = m; }, onSelect() {}, _buildLights() {},
    canvas: { addEventListener() {}, removeEventListener() {}, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });
  st.scene.add(st.root); st._buildSet(); if (!keepSet) st._setGroup = undefined; st.live = new LiveEdit(st, liveKinds()); st.setFrame(0);
  return st;
}
const man = (id, y = 0, extra = {}) => ({ id, name: id, kind: "man", height_m: 1.8, position: [extra.x ?? 0, y, extra.z ?? 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const prop = (id, kind, y = 0, extra = {}) => ({ id, name: id, kind, position: [extra.x ?? 0, y, extra.z ?? 0], keys: [{ frame: 0, position: [extra.x ?? 0, y, extra.z ?? 0] }], rotation_deg: 0, ...extra });
const keyed = (id, kind, keys, extra = {}) => ({ id, name: id, kind, height_m: kind === "man" ? 1.8 : undefined, position: keys[0][1], keys: keys.map(([frame, position]) => ({ frame, position })), rotation_deg: 0, ...extra });
const wp = (o) => o.getWorldPosition(new THREE.Vector3());
const headY = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return wp(g.userData.joints.head).y; };
const lowest = (g) => { g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(g).min.y; };

const hipW = (st, id) => { const g = st.actorMeshes.get(id); g.updateMatrixWorld(true); return wp(g.userData.joints.l_hip); };
// Every joint's world position and the root's orientation: the whole pose, to compare two evaluations of one frame.
function poseOf(st, id) {
  const g = st.actorMeshes.get(id);
  g.updateMatrixWorld(true);
  const out = [g.position.x, g.position.y, g.position.z, g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w];
  for (const k of Object.keys(g.userData.joints || {}).sort()) { const p = wp(g.userData.joints[k]); out.push(p.x, p.y, p.z); }
  return out;
}
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const ride = (kind, keys, frames, extra = {}) => tank([keyed("h", kind, keys, { key_y: false }), { ...man("r", 0, { x: keys[0][1][0], z: keys[0][1][2] }), mount_id: "h", ...extra }], { frames });

// ------------------------------------------------------------------ 1. Scrub order and riders (regression)
// At 7eafe37: f0, then f120, then f9 left a bicycle or horse rider ridden into the tank rolled -1.48 rad on the seat,
// lying on the dry floor (the head 1.4 m lower than a fresh f9): the rider pass set only rotation.y, and the swim's
// roll from the let-go frame shown before stayed. b1f6d51 scrubbed identically. The Pose pass read the same pose.
test("a rider ridden into the tank: any frame gives the same pose whatever was shown before, in the shot and the Pose pass", () => {
  for (const kind of ["bicycle", "horse"]) {
    const mk = () => ride(kind, [[0, [-12, 0, 0]], [120, [0, 0, 0]]], 121);
    const ref = mk(), fresh = {}, kp = {};
    for (const f of [0, 9, 40, 60, 90, 120]) { ref.setFrame(f); fresh[f] = poseOf(ref, "r"); kp[f] = personKeypoints(ref.actorMeshes.get("r")).body.flatMap((p) => [p.x, p.y, p.z]); }
    for (const order of [[0, 120, 9], [0, 90, 40], [0, 120, 60, 9], [120, 0], [90, 9, 120, 40]]) {
      const st = mk();
      for (const f of order) {
        st.setFrame(f);
        const d = maxDiff(poseOf(st, "r"), fresh[f]);
        assert.ok(d < 1e-6, `${kind}: f${f} after ${order.join(" -> ")} is the fresh pose (off by ${d.toFixed(3)})`);
        const k = personKeypoints(st.actorMeshes.get("r")).body.flatMap((p) => [p.x, p.y, p.z]);
        assert.ok(maxDiff(k, kp[f]) < 1e-6, `${kind}: the Pose pass at f${f} after ${order.join(" -> ")} is the fresh one`);
      }
    }
  }
});
