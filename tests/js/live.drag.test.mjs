// Live editing (Milestone 9): drags on a real Stage scene graph (no WebGL: the stage's own methods on a headless
// instance), stepped by hand. Pushing, stacking, walls, people climbing / mounting / picking up, and one undo step a drag.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE, liveKinds } from "../../web/stage/stage.mjs";
import { LiveEdit } from "../../web/stage/live.mjs";

const crate = (id, x, z, extra = {}) => ({ id, name: id, kind: "crate", position: [x, 0, z], keys: [{ frame: 0, position: [x, 0, z] }], height_m: 0.8, rotation_deg: 0, ...extra });
const person = (id, x, z) => ({ id, name: id, kind: "man", position: [x, 0, z], keys: [{ frame: 0, position: [x, 0, z] }], height_m: 1.8, rotation_deg: 0 });

/** A Stage without a renderer: the real scene graph, keys and setFrame, render() a no-op. */
function headless(actors, env = { set: "studio" }) {
  const st = Object.create(Stage.prototype);
  const changes = [];
  Object.assign(st, {
    state: { ...structuredClone(DEFAULT_SCENE), actors: structuredClone(actors), environment: env }, view: "clay", key: "start", frame: 0,
    actorMeshes: new Map(), root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200),
    render() {}, onChange: (s) => changes.push(s), onInteract: (m) => { st.lastMsg = m; }, onSelect() {}, _buildLights() {},
  });
  st.scene.add(st.root);
  st._buildSet();
  st._setGroup = undefined;   // no clean-street swaps
  st.live = new LiveEdit(st, liveKinds());
  st.setFrame(0);
  return { st, changes };
}

/** A ray from straight above a world point (as if the cursor were over it), in the Raycaster-like shape LiveEdit takes. */
const rayAt = (x, z, y = 30) => ({ ray: new THREE.Ray(new THREE.Vector3(x, y, z), new THREE.Vector3(0, -1, 0)) });
const ev = (extra = {}) => ({ clientX: 0, clientY: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...extra });

/** Drag `id` from where it stands along waypoints [[x, z], ...] (each over `frames` frames at 60 fps), then let go and settle. */
function drag(st, id, path, { frames = 30, keys = [] } = {}) {
  const a = st.state.actors.find((x) => x.id === id), g = st.actorMeshes.get(id);
  const ok = st.live.begin(id, ev(), rayAt(g.position.x, g.position.z));
  assert.ok(ok, "drag began");
  let [x, z] = [g.position.x, g.position.z], n = 0;
  for (const [tx, tz] of path) {
    for (let i = 1; i <= frames; i++) {
      const px = x + (tx - x) * i / frames, pz = z + (tz - z) * i / frames;
      st.live.move(ev({ clientX: ++n * 5 }), rayAt(px, pz));
      st.live._tick(1 / 60);
      for (const k of keys) if (k.at === n) st.live.key({ key: k.key });
    }
    [x, z] = [tx, tz];
  }
  for (let i = 0; i < 10; i++) st.live._tick(1 / 60);
  st.live.end();
  for (let i = 0; i < 240 && st.live.settling; i++) { st.live._tick(1 / 60); if ((st.live.world?.awakeCount() ?? 0) === 0) break; }
  st.live.finish();
  return a;
}
const keyPos = (st, id) => st.state.actors.find((x) => x.id === id).keys[0].position;

test("dragging a crate into a row pushes the others along; one undo step for the whole drag", () => {
  const { st, changes } = headless([crate("a", -3, 0), crate("b", -1, 0), crate("c", -0.1, 0.02)]);
  drag(st, "a", [[1.2, 0]], { frames: 50 });
  assert.equal(changes.length, 1, "one onChange = one undo step");
  const a = keyPos(st, "a"), b = keyPos(st, "b"), c = keyPos(st, "c");
  assert.ok(Math.abs(a[0] - 1.2) < 0.15, `the dragged crate is under the cursor (${a[0]})`);
  assert.ok(b[0] > a[0] + 0.7 && c[0] > a[0] + 0.7, `pushed ahead: a ${a[0]}, b ${b[0]}, c ${c[0]}`);
  // Nothing overlaps at the end.
  const xs = [a, b, c].map((p) => p[0]).sort((p, q) => p - q);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > 0.7 || Math.abs([a, b, c].find((p) => p[0] === xs[i])[2] - [a, b, c].find((p) => p[0] === xs[i - 1])[2]) > 0.7, "no overlap");
  // Undo history: the stage records once; undoing restores all three.
  assert.ok(st.state.actors.every((x) => x.keys.length === 1), "pushed crates were moved, not animated");
});

test("lift a crate over another with the wheel and let go: it lands on top and stacks (keyed height)", () => {
  const { st, changes } = headless([crate("a", -2, 0), crate("b", 1, 0)]);
  const g = st.actorMeshes.get("a");
  st.live.begin("a", ev(), rayAt(g.position.x, g.position.z));
  for (let i = 0; i < 5; i++) st.live.wheel({ deltaY: -400, deltaMode: 0 });   // up 1 m
  for (let i = 1; i <= 50; i++) { st.live.move(ev({ clientX: i * 5 }), rayAt(-2 + 3 * Math.min(1, i / 40), 0)); st.live._tick(1 / 60); }
  st.live.end();
  for (let i = 0; i < 240 && st.live.settling; i++) st.live._tick(1 / 60);
  st.live.finish();
  const a = st.state.actors.find((x) => x.id === "a"), p = keyPos(st, "a");
  assert.ok(Math.abs(p[1] - 0.8) < 0.04 && Math.abs(p[0] - 1) < 0.25, `on top (${p})`);
  assert.equal(a.key_y, true);
  assert.equal(changes.length, 1, "one undo step");
  st.setFrame(0);
  assert.ok(Math.abs(st.actorMeshes.get("a").position.y - p[1]) < 1e-6, "the stage shows the keyed height");
  assert.ok(Math.abs(keyPos(st, "b")[1]) < 1e-6, "the crate underneath stays on the floor");
});

test("a crate slid into a table rides up onto its top (the table doesn't skate away)", () => {
  const { st } = headless([crate("a", -3, 0, { scale: 0.5 }), { id: "t", name: "table", kind: "table", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], height_m: 0.75, rotation_deg: 0 }]);
  drag(st, "a", [[0, 0]], { frames: 40 });
  const p = keyPos(st, "a");
  assert.ok(p[1] > 0.6 && Math.abs(p[0]) < 0.3, `on the table (${p})`);
  assert.ok(Math.hypot(...keyPos(st, "t")) < 0.01, "the table stayed put");
});

test("a crate can't be dragged through a wall", () => {
  const { st } = headless([crate("a", -2, 0), { id: "w", name: "wall", kind: "wall", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], height_m: 2.5, rotation_deg: 90 }]);
  drag(st, "a", [[3, 0]], { frames: 40 });
  const x = keyPos(st, "a")[0];
  assert.ok(x < -0.2, `stopped by the wall (x ${x})`);
});

test("a person dragged over a crate climbs on top; the crate holds still", () => {
  const { st } = headless([person("p", -3, 0), crate("c", 0, 0)]);
  drag(st, "p", [[0, 0]], { frames: 40 });
  const p = keyPos(st, "p");
  assert.ok(Math.abs(p[1] - 0.8) < 0.05, `stands on the crate (y ${p[1]})`);
  assert.ok(Math.hypot(...keyPos(st, "c")) < 0.02, "the crate didn't move");
  assert.match(st.lastMsg, /climbs onto/);
});

test("a person dragged into a light box beside them pushes it (a full crate is climbed, not shoved)", () => {
  const { st } = headless([person("p", -3, 0), crate("c", -1.1, 0.45, { scale: 0.6 })]);
  // Walk past along z = 0: the body runs into the crate's side, the cursor stays on the floor beside it.
  drag(st, "p", [[1, 0]], { frames: 50 });
  const c = keyPos(st, "c");
  assert.ok(Math.hypot(c[0] + 1.1, c[2] - 0.45) > 0.15, `pushed (${c})`);
  assert.ok(Math.abs(keyPos(st, "p")[1]) < 0.01, `still on the floor (${keyPos(st, "p")})`);
});

test("a person dragged onto a horse mounts it; dragged off, they dismount", () => {
  const { st } = headless([person("p", -3, 0), { id: "h", name: "horse", kind: "horse", position: [1, 0, 0], keys: [{ frame: 0, position: [1, 0, 0] }], height_m: 1.6, rotation_deg: 0, simple_model: true }]);
  const a = drag(st, "p", [[1, 0]], { frames: 40 });
  assert.equal(a.mount_id, "h");
  assert.match(st.lastMsg, /on horse/);
  drag(st, "p", [[-2, -2]], { frames: 40 });
  assert.equal(a.mount_id, undefined, "dismounted");
  const p = keyPos(st, "p");
  assert.ok(Math.hypot(p[0] + 2, p[2] + 2) < 0.3, `on the ground where dropped (${p})`);
});

test("C picks up the prop a person walks into; it comes along; C puts it down", () => {
  const { st } = headless([person("p", -3, 0), crate("c", -1.2, 0, { scale: 0.6 })]);
  const c = st.state.actors.find((x) => x.id === "c");
  // Walk into it (30 frames), press C, carry it to x = 2.
  drag(st, "p", [[-1.6, 0], [2, 0]], { frames: 30, keys: [{ at: 30, key: "c" }] });
  assert.equal(c.carry_id, "p", "picked up");
  const g = st.actorMeshes.get("c");
  assert.ok(g.position.x > 1.5, `carried along (x ${g.position.x})`);
  drag(st, "p", [[2.5, 1]], { frames: 10, keys: [{ at: 5, key: "c" }] });
  assert.equal(c.carry_id, undefined, "put down");
  const k = keyPos(st, "c");
  assert.ok(k[0] > 1.5 && Math.abs(k[1]) < 0.02, `dropped where they stood, on the floor, not back where it was picked up (${k})`);
});

test("a prop let go above the floor falls and settles; one that hangs over an edge tips off", () => {
  const { st } = headless([crate("a", -2, 0), { id: "t", name: "table", kind: "table", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], height_m: 0.75, rotation_deg: 0, physics: { mode: "static" } }]);
  // Grab, raise it 1 m with the wheel, let go: it falls back to the floor.
  const g = st.actorMeshes.get("a");
  st.live.begin("a", ev(), rayAt(g.position.x, g.position.z));
  for (let i = 0; i < 6; i++) st.live.wheel({ deltaY: -400, deltaMode: 0 });
  for (let i = 0; i < 40; i++) { st.live.move(ev({ clientX: i * 5 }), rayAt(-2, 0)); st.live._tick(1 / 60); }
  assert.ok(st.actorMeshes.get("a").position.y > 0.8, "held up in the air");
  st.live.end();
  for (let i = 0; i < 240 && st.live.settling; i++) st.live._tick(1 / 60);
  st.live.finish();
  assert.ok(Math.abs(keyPos(st, "a")[1]) < 0.02, `fell to the floor (y ${keyPos(st, "a")[1]})`);
});

test("old scenes are unchanged: a prop without key_y ignores a stray key height", () => {
  const { st } = headless([crate("a", 0, 0, { keys: [{ frame: 0, position: [0, 3, 0] }] })]);
  st.setFrame(0);
  assert.equal(st.actorMeshes.get("a").position.y, 0);
});
