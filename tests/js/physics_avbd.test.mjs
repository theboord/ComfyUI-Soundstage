// GPU physics backend (Milestone 10): three-avbd behind physengine.mjs. Node has no WebGPU, so these cover the adapter's
// mapping, poses, picking, the backend choice and the fallback; the solver itself is browser-verified (see
// share/Milestone10_AVBD/README.md: metrics and side-by-side videos against XPBD on an AMD Vega 56 / Metal).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as AV from "../../web/stage/physics_avbd.mjs";
import * as PE from "../../web/stage/physengine.mjs";

const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const qy = (deg) => { const r = (deg * Math.PI) / 180; return [0, Math.sin(r / 2), 0, Math.cos(r / 2)]; };
const qrot = (q, v) => {
  const [x, y, z, w] = q, tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

test("a crate maps to an AVBD box: grown by the contact margin, real mass as density, placed at its collision centre", () => {
  const o = AV.avbdOptions({ shape: "box", half: [0.4, 0.4, 0.4], center: [0, 0.4, 0], type: "dynamic", mass: 25, friction: 0.75, pos: [1, 0, 2], quat: qy(90) });
  assert.equal(o.shape, "box");
  assert.equal(o.fixed, false);
  assert.ok(near(o.size, [0.81, 0.81, 0.81]), `size ${o.size}`);
  assert.ok(Math.abs(o.density * o.size[0] * o.size[1] * o.size[2] - 25) < 1e-9, "density x volume = the crate's 25 kg");
  assert.ok(near(o.position, [1, 0.4, 2]));
  assert.equal(o.friction, 0.75);
  // An off-centre box (a car body sits forward of its origin) turns with the object.
  const c = AV.avbdOptions({ half: [1, 0.3, 2], center: [0, 0.5, 0.4], type: "kinematic", pos: [0, 0, 0], quat: qy(90) });
  assert.ok(near(c.position, [0.4, 0.5, 0], 1e-9), `${c.position}`);
  assert.equal(c.fixed, true);
});

test("types: dynamic, static and kinematic (and the physics.mjs spec's dynamic flag); asleep starts pinned", () => {
  assert.equal(AV.modeOf({ type: "static" }), "static");
  assert.equal(AV.modeOf({ type: "kinematic" }), "kinematic");
  assert.equal(AV.modeOf({ type: "dynamic" }), "dynamic");
  assert.equal(AV.modeOf({ dynamic: false }), "kinematic");
  assert.equal(AV.modeOf({ dynamic: true }), "dynamic");
  assert.equal(AV.modeOf({}), "dynamic", "physengine's default type");
  assert.equal(AV.avbdOptions({ type: "static" }).fixed, true);
  assert.equal(AV.avbdOptions({ type: "dynamic", asleep: true }).fixed, true, "a sleeping prop is pinned until woken");
});

test("spheres, bad input and the mass floor", () => {
  const s = AV.avbdOptions({ shape: "sphere", radius: 0.5, mass: 6, type: "dynamic" });
  assert.equal(s.shape, "sphere");
  assert.ok(Math.abs(s.radius - (0.5 + AV.AVBD_MARGIN / 2)) < 1e-12);
  assert.ok(Math.abs(s.density * (4 / 3) * Math.PI * s.radius ** 3 - 6) < 1e-9);
  const junk = AV.avbdOptions({ half: [NaN, -1, "x"], pos: [NaN, 0], quat: [0, 0, 0, 0], mass: -3, friction: 9 });
  assert.ok(junk.size.every(Number.isFinite) && junk.size.every((v) => v > 0));
  assert.ok(near(junk.rotation, [0, 0, 0, 1]));
  assert.ok(junk.mass >= 0.05 && junk.mass === 20, "no mass: the CPU solver's 20 kg default");
  assert.equal(junk.friction, 1.5);
});

test("originPose undoes the placement; extrapolate carries a pose forward by its velocity", () => {
  const center = [0.2, 0.4, -0.1], quat = qy(37), pos = [3, 1, -2];
  const o = AV.avbdOptions({ half: [0.3, 0.4, 0.5], center, pos, quat });
  const back = AV.originPose(o.position, o.rotation, center);
  assert.ok(near(back.pos, pos, 1e-9) && near(back.quat, quat, 1e-9));
  const moved = AV.extrapolate({ pos: [0, 0, 0], quat: [0, 0, 0, 1] }, [2, 0, 0], [0, 0, 0], 0.5);
  assert.ok(near(moved.pos, [1, 0, 0]));
  // Spinning about +Y by pi rad/s for half a second: a quarter turn, about its centre of mass (not its origin).
  const spun = AV.extrapolate({ pos: [0, 0, 0], quat: [0, 0, 0, 1] }, [0, 0, 0], [0, Math.PI, 0], 0.5, [1, 0, 0]);
  assert.ok(near(spun.quat, qy(90), 1e-9), `${spun.quat}`);
  const com = qrot(spun.quat, [1, 0, 0]).map((v, k) => v + spun.pos[k]);
  assert.ok(near(com, [1, 0, 0], 1e-9), "the centre of mass stays put");
});

test("bounds and the CPU raycast (boxes, spheres, rotated, nearest wins)", () => {
  const box = AV.aabbOf("box", [0, 1, 0], qy(45), [2, 2, 2]);
  assert.ok(Math.abs(box.max[0] - Math.SQRT2) < 1e-9 && Math.abs(box.max[1] - 2) < 1e-9);
  assert.ok(AV.aabbOverlap(box, AV.aabbOf("sphere", [1.5, 1, 0], null, 0.2)));
  assert.ok(!AV.aabbOverlap(box, AV.aabbOf("sphere", [3, 1, 0], null, 0.2)));
  const shapes = [
    { id: "far", shape: "box", pos: [0, 0.5, -5], rot: [0, 0, 0, 1], size: [1, 1, 1] },
    { id: "near", shape: "box", pos: [0, 0.5, 0], rot: qy(45), size: [1, 1, 1] },
    { id: "ball", shape: "sphere", pos: [3, 0.5, 0], radius: 0.5 },
  ];
  const hit = AV.raycastShapes(shapes, [0, 0.5, 5], [0, 0, -1]);
  assert.equal(hit.id, "near");
  assert.ok(Math.abs(hit.distance - (5 - Math.SQRT1_2)) < 1e-9, `${hit.distance}`);
  const top = AV.raycastShapes(shapes, [0, 10, 0], [0, -1, 0]);
  assert.equal(top.id, "near");
  assert.ok(near(top.normal, [0, 1, 0], 1e-9));
  const ball = AV.raycastShapes(shapes, [3, 10, 0], [0, -1, 0]);
  assert.equal(ball.id, "ball");
  assert.ok(Math.abs(ball.point[1] - 1) < 1e-9);
  assert.equal(AV.raycastShapes(shapes, [0, 0.5, 5], [0, 0, -1], 1), null, "maxDistance");
  assert.equal(AV.raycastShapes(shapes, [10, 10, 10], [0, 1, 0]), null);
});

test("backend choice: XPBD unless AVBD is switched on and WebGPU came up", () => {
  assert.equal(AV.chooseBackend({}), "xpbd");
  assert.equal(AV.chooseBackend({ gpu: true, device: true }), "xpbd", "the CPU solver stays the default");
  assert.equal(AV.chooseBackend({ gpu: true, device: true, pref: "avbd" }), "avbd");
  assert.equal(AV.chooseBackend({ gpu: true, device: true, pref: "auto" }), "avbd");
  assert.equal(AV.chooseBackend({ gpu: true, device: false, pref: "avbd" }), "xpbd", "no device: CPU");
  assert.equal(AV.chooseBackend({ gpu: false, device: false, pref: "avbd" }), "xpbd", "no WebGPU: CPU");
  assert.equal(AV.chooseBackend({ gpu: true, device: true, lost: true, pref: "avbd" }), "xpbd", "device lost: CPU");
  assert.equal(AV.backendLabel("avbd"), "Physics: GPU (AVBD)");
  assert.equal(AV.backendLabel("xpbd"), "Physics: CPU");
  assert.equal(AV.backendLabel("?"), "Physics: CPU");
});

test("the toggle: ?physics= wins over localStorage, anything else is the CPU", () => {
  const store = (v) => ({ getItem: () => v, setItem() {} });
  assert.equal(AV.readPref({}), "xpbd");
  assert.equal(AV.readPref({ localStorage: store("avbd") }), "avbd");
  assert.equal(AV.readPref({ localStorage: store("nonsense") }), "xpbd");
  assert.equal(AV.readPref({ location: { search: "?physics=auto" }, localStorage: store("xpbd") }), "auto");
  assert.equal(AV.readPref({ location: { search: "?physics=bogus" }, localStorage: store("avbd") }), "avbd");
  assert.equal(AV.readPref({ localStorage: { getItem() { throw new Error("blocked"); } } }), "xpbd", "blocked storage");
});

test("no WebGPU (Node): not supported, createWorld throws, and physengine falls back to XPBD", async () => {
  assert.equal(AV.supported(), false);
  assert.equal(AV.engine.supported(), false);
  assert.equal(await AV.init(), false);
  assert.equal(AV.status().ready, false);
  assert.throws(() => AV.createWorld(), /not available/);
  PE.registerEngine(AV.engine, { prefer: true });
  assert.equal(PE.pickEngine().name, "xpbd");
  assert.equal(PE.pickEngine("avbd").name, "xpbd");
  const w = PE.createWorld({ floor: true });
  assert.equal(w.engine, "xpbd");
  const id = w.addBody({ shape: "box", half: [0.4, 0.4, 0.4], center: [0, 0.4, 0], type: "dynamic", mass: 25, pos: [0, 1, 0] });
  for (let i = 0; i < 90; i++) w.step(1 / 60);
  assert.ok(Math.abs(w.getPose(id).pos[1]) < 0.02, "the CPU world still works");
  w.dispose();
  assert.ok(PE.engines().some((e) => e.name === "avbd" && e.supported === false));
});

test("the badge: one per stage, says which solver runs", () => {
  const made = [];
  const el = () => ({ style: {}, dataset: {}, textContent: "", className: "" });
  const container = { kids: [], querySelector(sel) { return this.kids.find((k) => sel === `.${k.className}`) || null; }, append(k) { this.kids.push(k); } };
  const doc = { createElement: () => { const e = el(); made.push(e); return e; } };
  const a = AV.mountBadge(container, "avbd", doc);
  assert.equal(a.textContent, "Physics: GPU (AVBD)");
  const b = AV.mountBadge(container, "xpbd", doc);
  assert.equal(a, b, "reused, not stacked");
  assert.equal(b.textContent, "Physics: CPU");
  assert.equal(made.length, 1);
  assert.equal(AV.mountBadge(null, "avbd", doc), null);
});

test("vendored three-avbd: MIT licence kept, .mjs only (ComfyUI loads every .js under web/), no three/webgpu import", () => {
  const root = new URL("../../web/vendor/three-avbd/", import.meta.url).pathname;
  assert.match(readFileSync(join(root, "LICENSE"), "utf8"), /MIT License[\s\S]*Steven Bobyn/);
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const files = walk(root);
  assert.ok(!files.some((f) => f.endsWith(".js")), "no .js files");
  for (const f of files.filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/from\s+['"]three/.test(src), `${f} imports three`);
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) assert.ok(m[1].endsWith(".mjs"), `${f}: ${m[1]}`);
  }
  assert.match(readFileSync(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"), /three-avbd/);
});

test("the vendored module imports in Node (no GPU touched at import)", async () => {
  const m = await import("../../web/vendor/three-avbd/index.mjs");
  assert.equal(typeof m.World, "function");
  assert.equal(typeof m.World.create, "function");
  assert.equal(typeof m.convexHull, "function");
});
