// Parts (Milestone 26): keyframeable channels on every object. Pure maths (keys, patterns, auto steering, words) and a
// headless Stage (no WebGL; the real car GLBs read from disk) for the vehicle rig: steering, suspension, doors and
// lids that really swing out of the body, lamps, the light bar, wipers, tint, damage; horse bones; prop pivots;
// film-light keys and flicker; the camera's lens channels; undo; the timeline rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { CHANNELS, PART_ENUMS, channelsFor, specOf, coerce, sampleKeys, partAt, writeKey, dropKey, blinkOn, lightbarAt, flickerAt,
  wiperAt, autoSteer, stateWords, partEvents, navAt } from "../../web/stage/objparts.mjs";
import { lightAt, lightWords } from "../../web/stage/lightrig.mjs";
import * as VehicleParts from "../../web/stage/vehicleparts.mjs";

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

async function loaded(st, id) {
  for (let i = 0; i < 400; i++) {
    const g = st.actorMeshes.get(id);
    if (g?.userData.vehicleBody) { st.setFrame(st.frame); return g; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`${id}: body never loaded`);
}

const car = (id, kind, extra = {}) => ({ id, name: id, kind, height_m: { police_car: 1.6, sports_car: 1.2, hatchback: 1.5, car: 1.45, truck: 2.6 }[kind] || 1.45,
  position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], ...extra });
const world = (o) => { o.updateWorldMatrix(true, true); return new THREE.Box3().setFromObject(o); };

// ------------------------------------------------------------------ pure

test("every channel has a spec, a group, a label and a tooltip; every enum default is one of its options", () => {
  for (const [ch, s] of Object.entries(CHANNELS)) {
    assert.ok(s.group && s.label && s.tip, ch);
    if (s.type === "enum") assert.ok(PART_ENUMS[ch] && (s.def in PART_ENUMS[ch]), `${ch}: default ${s.def}`);
    else assert.ok(s.min < s.max && s.step > 0, ch);
  }
  for (const k of ["car", "police_car", "sports_car", "hatchback", "truck", "motorcycle", "bicycle", "boat", "airliner", "train", "horse", "man", "crate", "glb", "__light__", "__camera__"])
    for (const ch of channelsFor(k)) assert.ok(specOf(ch), `${k}: ${ch}`);
  assert.ok(channelsFor("police_car").includes("lightbar") && !channelsFor("car").includes("lightbar"));
  assert.equal(channelsFor("sports_car").filter((c) => c.startsWith("door_")).length, 2);
  assert.equal(channelsFor("car").filter((c) => c.startsWith("door_")).length, 4);
  assert.deepEqual(channelsFor("glb", { subparts: ["Lid"] }).slice(-3), ["sub:Lid:rx", "sub:Lid:ry", "sub:Lid:rz"]);
});

test("keys: numbers ease between keys (linear / step per key), enums hold; writeKey replaces, dropKey removes", () => {
  const o = {};
  writeKey(o, "door_fl", 0, 0); writeKey(o, "door_fl", 48, 60);
  assert.equal(partAt(o, "door_fl", 0), 0);
  assert.equal(partAt(o, "door_fl", 24), 30);
  assert.ok(partAt(o, "door_fl", 12) < 15, "eased: slow out of the first key");
  assert.equal(partAt(o, "door_fl", 90), 60);
  o.parts.door_fl[0].i = "linear";
  assert.equal(partAt(o, "door_fl", 12), 15);
  o.parts.door_fl[0].i = "step";
  assert.equal(partAt(o, "door_fl", 47), 0);
  writeKey(o, "door_fl", 48, 45);
  assert.equal(o.parts.door_fl.length, 2);
  assert.equal(partAt(o, "door_fl", 60), 45);
  writeKey(o, "headlights", 0, "off"); writeKey(o, "headlights", 30, "high");
  assert.equal(partAt(o, "headlights", 29), "off");
  assert.equal(partAt(o, "headlights", 30), "high");
  assert.equal(partAt({}, "headlights", 5), "auto", "the default with no keys");
  assert.equal(partAt({}, "steer", 5), undefined, "steering is automatic until keyed");
  dropKey(o, "headlights", 0); dropKey(o, "headlights", 30);
  assert.equal(o.parts.headlights, undefined);
  assert.equal(sampleKeys([{ frame: 10, v: 3 }], 0), 3, "one key is a constant");
});

test("coerce: ranges clamp, enum words and booleans map onto options", () => {
  assert.equal(coerce("door_fl", 120), 70);
  assert.equal(coerce("headlights", true), "low");
  assert.equal(coerce("headlights", "on"), "low");
  assert.equal(coerce("headlights", "full beam"), "high");
  assert.equal(coerce("lightbar", "on"), "flash");
  assert.equal(coerce("lightbar", false), "off");
  assert.equal(coerce("indicator", "hazards"), "hazard");
  assert.equal(coerce("gait", "run"), "gallop");
  assert.equal(coerce("headlights", "purple"), null);
  assert.equal(coerce("nope", 1), null);
});

test("blink, light bar, nav, wiper and flicker patterns are deterministic and shaped right", () => {
  let on = 0;
  for (let f = 0; f < 240; f++) on += blinkOn(f / 24) ? 1 : 0;
  assert.ok(Math.abs(on / 240 - 0.5) < 0.05, "indicators on half the time");
  let l = 0, r = 0, both = 0;
  for (let f = 0; f < 240; f++) { const b = lightbarAt("flash", f / 24); l += b.left; r += b.right; both += b.left && b.right ? 1 : 0; }
  assert.ok(l > 20 && r > 20 && both === 0, `wig-wag: left ${l}, right ${r}, never both`);
  assert.deepEqual(lightbarAt("off", 1), { left: 0, right: 0 });
  assert.deepEqual(lightbarAt("steady", 1), { left: 1, right: 1 });
  assert.equal(navAt("on", 0.5).nav, 1);
  assert.equal(wiperAt("off", 1), 0);
  assert.ok(wiperAt("normal", 1 / 1.5) > 0.99, "a full sweep at half a cycle");
  for (const m of Object.keys(PART_ENUMS.flicker)) for (let f = 0; f < 50; f++) {
    const a = flickerAt(m, f, 24, 0.7, 3), b = flickerAt(m, f, 24, 0.7, 3);
    assert.equal(a, b, `${m} frame ${f} repeats`);
    assert.ok(a >= 0 && Number.isFinite(a));
  }
  const candle = Array.from({ length: 48 }, (_, f) => flickerAt("candle", f, 24, 0.8));
  assert.ok(Math.max(...candle) - Math.min(...candle) > 0.15, "a candle visibly flickers");
  assert.equal(flickerAt("off", 7), 1);
});

test("auto steering: Ackermann from the path, + = left, zero on a straight, flips sign in reverse", () => {
  const fps = 24, R = 10, v = 8;
  const pos = [], yaw = [];
  for (let f = 0; f < 60; f++) { const th = (v * f / fps) / R; pos.push([R - R * Math.cos(th), 0, R * Math.sin(th)]); yaw.push(th); }
  const s = autoSteer(pos, yaw, fps, 2.7);
  const want = Math.atan(2.7 / R) * 180 / Math.PI;
  assert.ok(Math.abs(s[30] - want) < 0.5, `left turn on a 10 m circle: ${s[30].toFixed(2)} vs ${want.toFixed(2)}`);
  const straight = autoSteer(pos.map((_, f) => [0, 0, f * 0.3]), pos.map(() => 0), fps);
  assert.ok(straight.every((x) => Math.abs(x) < 1e-9));
  const rev = autoSteer([...pos].map((p) => p), yaw.map((y) => y + Math.PI), fps, 2.7);
  assert.ok(rev[30] < -want + 0.5, "the same arc driven backwards steers the other way");
});

test("words: visible state and timed changes for the prompt", () => {
  const p = { parts: { headlights: [{ frame: 0, v: "low" }], door_fl: [{ frame: 0, v: 0 }, { frame: 48, v: 60 }], lightbar: [{ frame: 0, v: "flash" }] } };
  const w0 = stateWords(p, 0, "police_car"), w1 = stateWords(p, 96, "police_car");
  assert.ok(w0.includes("headlights on") && w0.some((x) => /red and blue/.test(x)));
  assert.ok(!w0.some((x) => /door/.test(x)) && w1.includes("the driver's door wide open"));
  const ev = partEvents(p, "police_car", 96);
  assert.deepEqual(ev.map((e) => [e.frame, e.words]), [[0, "the driver's door swings open"]]);
  assert.deepEqual(stateWords({ parts: { expression: [{ frame: 0, v: "smile" }] } }, 0, "woman"), ["smiling"]);
  assert.ok(stateWords({ parts: { gait: [{ frame: 0, v: "trot" }], head_pitch: [{ frame: 0, v: 20 }] } }, 0, "horse").includes("trotting"));
  assert.deepEqual(stateWords({}, 0, "car"), [], "nothing said for a car left alone");
});

// ------------------------------------------------------------------ vehicles on a headless stage

test("police car: doors, hood and trunk swing out of the body on the right side; aperture shows; one undo step each", async () => {
  const st = headless([car("cop", "police_car")]);
  const g = await loaded(st, "cop");
  const R = g.userData.partsRig;
  assert.ok(R && R.doors.door_fl && R.doors.door_fr && R.doors.door_rl && R.doors.door_rr && R.doors.hood && R.doors.trunk, `parts: ${Object.keys(R?.doors || {})}`);
  const body = world(g.userData.vehicleBody);
  assert.equal(R.doors.door_fl.hinge.visible, false, "closed doors are the body's own");
  const before = st.changes;
  st.setPart("cop", "door_fl", 65);
  assert.equal(st.changes, before + 1, "one change = one undo step");
  const d = world(R.doors.door_fl.hinge);
  assert.ok(R.doors.door_fl.hinge.visible && R.doors.door_fl.hole.visible);
  assert.ok(d.max.x > body.max.x + 0.4, `the driver's door (car's left, +X) swings out: ${d.max.x.toFixed(2)} vs body ${body.max.x.toFixed(2)}`);
  st.setPart("cop", "door_fr", 65);
  assert.ok(world(R.doors.door_fr.hinge).min.x < body.min.x - 0.4, "the passenger door swings out to the right");
  const hood0 = world(g.userData.vehicleBody);
  st.setPart("cop", "hood", 70);
  const hood = world(R.doors.hood.hinge);
  assert.ok(hood.max.y > hood0.max.y - 0.25 && hood.max.z < hood0.max.z, `the hood lifts toward the windscreen: top ${hood.max.y.toFixed(2)}`);
  st.setPart("cop", "trunk", 70);
  assert.ok(world(R.doors.trunk.hinge).max.y > hood0.min.y + 1.0, "the trunk lid lifts");
  // Front = +Z: the hood is at the headlight end.
  assert.ok(world(R.doors.hood.hinge).getCenter(new THREE.Vector3()).z > world(R.doors.trunk.hinge).getCenter(new THREE.Vector3()).z);
  // Undo the last edit: trunk closes again.
  st.state.actors[0].parts.trunk = [{ frame: 0, v: 0 }];
  st.setFrame(0);
  assert.equal(R.doors.trunk.hinge.visible, false);
});

test("police car: the light bar wig-wags red / blue lamps and lights, the guide shows them lit (no clay override)", async () => {
  const st = headless([car("cop", "police_car")]);
  const g = await loaded(st, "cop");
  st.setPart("cop", "lightbar", "flash");
  const R = g.userData.partsRig;
  const bl = R.lamps.filter((m) => m.userData.role === "bar_l"), br = R.lamps.filter((m) => m.userData.role === "bar_r");
  assert.ok(bl.length && br.length && R.barLights?.length === 2);
  let left = 0, right = 0;
  for (let f = 0; f < 48; f++) {
    st.setFrame(f);
    VehicleParts.pass(st, "clay");
    if (bl[0].visible) { left++; assert.equal(bl[0].material.allowOverride, false, "lit lamp keeps its own material in Clay"); assert.ok(R.barLights[0].intensity > 0); }
    if (br[0].visible) right++;
    assert.ok(!(bl[0].visible && br[0].visible));
  }
  assert.ok(left >= 6 && right >= 6, `flashes: ${left} / ${right}`);
  st.setFrame(2);
  VehicleParts.pass(st, "depth");
  assert.equal(bl[0].visible, false, "lamps are hidden from the Depth pass");
  VehicleParts.pass(st, "clay");
  st.setFrame(2);
  const a = bl[0].visible;
  st.setFrame(2);
  assert.equal(bl[0].visible, a, "the same frame flashes the same");
});

test("headlights: off / dipped / full beam drive the model's lamps, real spot lights and the clay glow", async () => {
  const st = headless([car("sc", "sports_car")]);
  const g = await loaded(st, "sc");
  const R = g.userData.partsRig;
  const head = R.ownLamps.Headlights[0];
  assert.ok(head);
  assert.ok(head.material.emissiveIntensity > 1, "auto: the old Color-pass marker");
  VehicleParts.pass(st, "clay");
  assert.equal(head.material.allowOverride, true, "auto: unlit in the clay guide (as before)");
  st.setPart("sc", "headlights", "off");
  assert.equal(head.material.emissiveIntensity, 0);
  st.setPart("sc", "headlights", "high");
  VehicleParts.pass(st, "clay");
  assert.equal(head.material.allowOverride, false, "on: lit in the clay guide");
  assert.equal(R.beams.length, 2);
  assert.ok(R.beams.every((b) => b.intensity > 0));
  const tgt = R.beams[0].target.getWorldPosition(new THREE.Vector3()), src = R.beams[0].getWorldPosition(new THREE.Vector3());
  assert.ok(tgt.z > src.z + 10, "the beams point ahead of the car");
  st.setPart("sc", "headlights", "off");
  assert.ok(R.beams.every((b) => b.intensity === 0), "off: the lights stay in the scene at zero (no shader recompiles)");
});

test("indicators blink one side; hazards both; brake lights auto-on while slowing", async () => {
  const st = headless([car("c", "hatchback", { keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 30, position: [0, 0, 15] }, { frame: 60, position: [0, 0, 30] }, { frame: 96, position: [0, 0, 32] }] })]);
  const g = await loaded(st, "c");
  const R = g.userData.partsRig;
  st.setPart("c", "indicator", "left");
  const lit = (role) => R.lamps.filter((m) => m.userData.role === role && m.visible).length;
  let l = 0, r = 0;
  for (let f = 0; f < 48; f++) { st.setFrame(f); l += lit("ind_l") ? 1 : 0; r += lit("ind_r") ? 1 : 0; }
  assert.ok(l > 15 && r === 0, `left only: ${l} / ${r}`);
  st.setFrame(0);
  st.clearPart("c", "indicator");
  st.setPart("c", "indicator", "hazard");
  st.setFrame(1);
  assert.equal(lit("ind_l"), lit("ind_r"));
  const tail = R.ownLamps.TailLights[0];
  st.setFrame(34);
  const cruise = tail.material.emissiveIntensity;
  st.setFrame(72);
  assert.ok(tail.material.emissiveIntensity > cruise + 1, `auto brake while it slows: ${tail.material.emissiveIntensity} vs ${cruise}`);
  st.setPart("c", "brake", "off");
  st.setFrame(72);
  assert.ok(tail.material.emissiveIntensity <= cruise);
});

test("steering turns the front wheels (keyed, or along the path), spin is kept; suspension offsets move the body", async () => {
  const st = headless([car("cop", "police_car")]);
  const g = await loaded(st, "cop");
  const R = g.userData.partsRig;
  assert.equal(R.steerNodes.length, 2, "two front wheels steer");
  st.setPart("cop", "steer", 25);
  for (const w of R.steerNodes) assert.ok(Math.abs(w.rotation.y - 25 * Math.PI / 180) < 1e-6);
  assert.ok(!R.wheels.filter((w) => !R.steerNodes.includes(w)).some((w) => Math.abs(w.rotation.y) > 1e-9), "rear axle stays straight");
  const body = g.userData.vehicleBody, y0 = body.position.y;
  st.setParts("cop", { susp_h: -0.1, susp_roll: 6, susp_pitch: -3 });
  assert.ok(Math.abs(body.position.y - (y0 - 0.1)) < 1e-6);
  assert.ok(Math.abs(body.rotation.z - 6 * Math.PI / 180) < 1e-6);
  assert.ok(Math.abs(body.rotation.x - 3 * Math.PI / 180) < 1e-6, "pitch - = nose down");
  // A car driving a curve steers by itself.
  const keys = []; for (let f = 0; f <= 96; f += 8) { const th = f / 96 * 1.5; keys.push({ frame: f, position: [12 - 12 * Math.cos(th), 0, 12 * Math.sin(th)] }); }
  const st2 = headless([car("c", "police_car", { keys, position: keys[0].position })]);
  const g2 = await loaded(st2, "c");
  st2.setFrame(48);
  const s = g2.userData.partsRig.steerNodes[0].rotation.y * 180 / Math.PI;
  assert.ok(s > 4 && s < 25, `auto steer into a left-hand curve: ${s.toFixed(1)}°`);
  assert.ok(st2.partValue("c", "steer") > 4, "the Parts readout shows the auto angle");
});

test("procedural sedan and truck get a sprung body, wheel pivots, steering and doors too", () => {
  const st = headless([car("s", "car"), car("t", "truck", { position: [6, 0, 0], keys: [{ frame: 0, position: [6, 0, 0] }] })]);
  const gs = st.actorMeshes.get("s"), gt = st.actorMeshes.get("t");
  for (const [g, n] of [[gs, 4], [gt, 4]]) {
    assert.ok(g.userData.vehicleBody?.userData.bodyPivot, "a body pivot");
    assert.equal(g.userData.wheelRig.length, n);
    assert.equal(g.userData.partsRig.steerNodes.length, 2);
  }
  const R = gs.userData.partsRig;
  assert.ok(R.doors.door_fl && R.doors.hood && R.doors.trunk);
  const b = world(gs.userData.vehicleBody);
  st.setPart("s", "door_fl", 60);
  assert.ok(world(R.doors.door_fl.hinge).max.x > b.max.x + 0.3);
  assert.ok(gt.userData.partsRig.doors.door_fl && !gt.userData.partsRig.doors.hood, "a cab-over truck has no hood");
  // The driver still sits in the sedan (the seat follows the sprung body).
  st.state.actors.push({ id: "d", kind: "man", name: "Driver", height_m: 1.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], mount_id: "s", seat: 0 });
  st._buildSet(); st.setFrame(0);
  const dw = st.actorMeshes.get("d").getWorldPosition(new THREE.Vector3());
  const sb = world(st.actorMeshes.get("s").userData.vehicleBody);
  assert.ok(sb.containsPoint(new THREE.Vector3(dw.x, sb.min.y + 0.3, dw.z)), "driver inside the car's footprint");
});

test("wipers sweep on the windscreen; tint darkens this car's glass only; dirt and finish copy the paint; damage crumples the nose", async () => {
  const st = headless([car("a", "police_car"), car("b", "police_car", { position: [5, 0, 0], keys: [{ frame: 0, position: [5, 0, 0] }] })]);
  const ga = await loaded(st, "a"); await loaded(st, "b");
  const R = ga.userData.partsRig, Rb = st.actorMeshes.get("b").userData.partsRig;
  assert.ok(R.wipers?.length === 2);
  st.setPart("a", "wipers", "normal");
  const at = (f) => { st.setFrame(f); return R.wipers[0].arm.getWorldPosition(new THREE.Vector3()).y; };
  assert.ok(at(Math.round(24 / 1.5)) > at(0) + 0.1, "the arm rises up the glass mid-sweep");
  st.setPart("a", "tint", 0.9);
  assert.ok(R.glass.length && R.glass[0].material.opacity > 0.8);
  assert.ok(Rb.glass[0].material.opacity < 0.3, "the other car's glass is untouched");
  const c0 = R.paint[0].color.clone();
  st.setPart("a", "dirt", 1);
  assert.ok(R.paint[0].color.r !== c0.r && R.paint[0].roughness > 0.8);
  assert.notEqual(R.paint[0], Rb.paint[0]);
  st.setPart("a", "finish", "chrome");
  st.setPart("a", "dirt", 0);
  assert.ok(R.paint[0].metalness > 0.9 && R.paint[0].roughness < 0.1);
  const nose0 = world(ga.userData.vehicleBody).max.z;
  st.setPart("a", "damage", 1);
  const nose1 = world(ga.userData.vehicleBody).max.z;
  assert.ok(nose1 < nose0 - 0.08, `the front end crumples: ${nose0.toFixed(2)} -> ${nose1.toFixed(2)}`);
  st.setPart("a", "damage", 0);
  assert.ok(Math.abs(world(ga.userData.vehicleBody).max.z - nose0) < 1e-3, "and comes back at 0");
});

test("setPart keys: a constant until animated; a time keys it (holding the value before); keyAllParts; clearPart; timeline rows", async () => {
  const st = headless([car("cop", "police_car")]);
  await loaded(st, "cop");
  st.frame = 40;
  st.setPart("cop", "door_fl", 30);
  assert.deepEqual(st.state.actors[0].parts.door_fl, [{ frame: 0, v: 30 }], "no keys yet: a constant");
  st.setPart("cop", "headlights", "high", { frame: 48 });
  assert.deepEqual(st.state.actors[0].parts.headlights.map((k) => [k.frame, k.v]), [[0, "auto"], [48, "high"]]);
  assert.equal(st.partValue("cop", "headlights", 47), "auto");
  st.setFrame(60);
  st.setPart("cop", "door_fl", 0, { key: true });
  assert.equal(st.state.actors[0].parts.door_fl.length, 2);
  st.setFrame(70);
  st.setPart("cop", "door_fl", 10);
  assert.equal(st.state.actors[0].parts.door_fl.length, 3, "animated: an edit keys the playhead");
  assert.ok(st.keyPartHere("cop", "susp_h"));
  assert.ok(st.partChannels("cop").find((c) => c.ch === "susp_h").here);
  assert.equal(st.keyPartHere("cop", "susp_h"), false, "toggle off");
  st.setFrame(80);
  const n = st.keyAllParts("cop");
  assert.ok(n > 10, `keyed ${n} channels`);
  const rows = st.partRows("cop");
  assert.ok(rows.some((r) => r.ch === "door_fl") && rows.every((r) => r.kind === "part" && r.keys.length));
  rows[0].addKey(5);
  assert.ok(st.state.actors[0].parts[rows[0].ch].some((k) => k.frame === 5));
  assert.ok(st.clearPart("cop", "door_fl"));
  assert.equal(st.state.actors[0].parts.door_fl, undefined);
  assert.ok(/the police car|cop/.test(st.partsPrompt(60)) || st.partsPrompt(60).includes("cop"));
});

test("film lights: keyed values; dimmer key and candle flicker reach the three.js light; practical gets a bulb", async () => {
  const LightRig = await import("../../web/stage/lightrig.mjs");
  const st = headless([]);
  const l0 = { id: "K", type: "key", kelvin: 4300, intensity: 3.2, softness: 0.6, angle: 40 };
  writeKey(l0, "intensity", 0, 1); writeKey(l0, "intensity", 48, 8); writeKey(l0, "kelvin", 0, 2700);
  assert.equal(lightAt(l0, 0).intensity, 1);
  assert.equal(lightAt(l0, 48).intensity, 8);
  assert.equal(lightAt(l0, 10).kelvin, 2700);
  assert.equal(lightAt(l0, 10).angle, 40, "unkeyed channels play the light's own value");
  const light = new THREE.SpotLight(0xffffff, 1, 40, 0.5, 0.5, 1.6);
  st.state.lighting = { lights: [{ id: "L1", type: "practical", position: [2, 1.4, 2], kelvin: 2700, intensity: 1.4, softness: 1, angle: 180,
    parts: { intensity: [{ frame: 0, v: 1 }, { frame: 48, v: 4 }], flicker: [{ frame: 0, v: "candle" }], motivation: [{ frame: 0, v: "practical" }] } }] };
  st.lightObjs = [{ id: "L1", light, handle: new THREE.Mesh() }];
  const lv = [];
  for (const f of [0, 1, 2, 3, 48]) { st.frame = f; LightRig.apply(st); lv.push(light.intensity); }
  assert.ok(new Set(lv.slice(0, 4).map((x) => x.toFixed(3))).size > 1, "the candle flickers frame to frame");
  assert.ok(lv[4] > lv[0] * 2, "the dimmer key brings it up");
  st.frame = 2; LightRig.apply(st); const again = light.intensity;
  assert.equal(again, lv[2], "frame 2 always flickers the same");
  const bulb = st._bulbs.get("L1");
  assert.ok(bulb && bulb.visible && bulb.material.allowOverride === false, "a practical shows a lit bulb in the guide");
  assert.match(lightWords(st.state.lighting.lights[0]), /practical lamp in shot, flickering like a candle flame/);
  st.state.lighting.lights[0].parts.flicker = [{ frame: 0, v: "police" }];
  const cols = new Set();
  for (let f = 0; f < 24; f++) { st.frame = f; LightRig.apply(st); cols.add(light.color.getHexString()); }
  assert.ok(cols.size >= 2, "police: red and blue");
});

test("camera channels: focal keys the camera, focus / T-stop / roll the shot's lens keys, shutter keys, sensor crops the FOV", () => {
  const st = headless([]);
  st.setPart("__camera__", "focal_mm", 85);
  assert.equal(st._cameraAt(0).focal_mm, 85);
  st.setPart("__camera__", "focus_m", 2, { frame: 0 });
  st.setPart("__camera__", "focus_m", 8, { frame: 48 });
  st.setPart("__camera__", "t_stop", 2.8, { frame: 0 });
  assert.ok(Math.abs(st._cameraAt(48).focus_m - 8) < 1e-6 && Math.abs(st._cameraAt(0).focus_m - 2) < 1e-6);
  assert.ok(st._cameraAt(24).focus_m > 2 && st._cameraAt(24).focus_m < 8);
  assert.equal(st.activeShot().lens_keys.every((k) => k.t_stop === 2.8), true, "a new lens channel fills every lens key");
  st.setPart("__camera__", "roll_deg", 10);
  assert.ok(Math.abs(st._cameraAt(0).roll - 10 * Math.PI / 180) < 1e-6);
  st.setPart("__camera__", "shutter_deg", 45);
  assert.equal(st.partValue("__camera__", "shutter_deg"), 45);
  const chans = st.partChannels("__camera__").map((c) => c.ch);
  assert.deepEqual(chans, ["focal_mm", "focus_m", "t_stop", "roll_deg", "shutter_deg", "sensor"]);
  st._applyCamera();
  const ff = st.camera.fov;
  st.setPart("__camera__", "sensor", "s35");
  st._applyCamera();
  assert.ok(st.camera.fov < ff * 0.75, `Super 35 crops the same lens tighter: ${ff.toFixed(1)} -> ${st.camera.fov.toFixed(1)}`);
});

test("horse: head, neck and tail offsets turn the bones; forced gait picks the clip", async () => {
  const st = headless([{ id: "h", name: "Horse", kind: "horse", height_m: 1.6, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] }]);
  let g;
  for (let i = 0; i < 400; i++) { g = st.actorMeshes.get("h"); if (g?.userData.horseRig) break; await new Promise((r) => setTimeout(r, 10)); }
  assert.ok(g.userData.horseRig, "rigged horse loaded");
  const head = () => { let b; g.traverse((o) => { if (o.isBone && o.name === "Head") b = o; }); g.updateMatrixWorld(true); return b.getWorldPosition(new THREE.Vector3()); };
  st.setFrame(0);
  const h0 = head();
  st.setPart("h", "head_pitch", 30);
  const h1 = head();
  assert.ok(h1.y > h0.y + 0.03, `head up: ${h0.y.toFixed(3)} -> ${h1.y.toFixed(3)}`);
  st.setPart("h", "head_pitch", 0);
  st.setPart("h", "head_yaw", 45);
  const h2 = head();
  assert.ok(h2.x > h0.x + 0.1, `head turned to its left (+X): ${h0.x.toFixed(2)} -> ${h2.x.toFixed(2)}`);
  st.setPart("h", "gait", "gallop");
  const R = g.userData.horseRig;
  if (!R.gait) assert.ok(R.actions.Gallop.enabled && !R.actions.Idle.enabled, "a standing horse forced to gallop plays the gallop");
});

test("props: a pivot turns the object about that point; finish and glow use the object's own materials", () => {
  const st = headless([{ id: "c", name: "Crate", kind: "crate", height_m: 0.8, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 90 }]);
  const g = st.actorMeshes.get("c");
  const p0 = g.position.clone();
  st.setParts("c", { pivot_x: 0.4, pivot_z: 0 });
  // Turned 90° about a point 0.4 m along its own +X: the origin moves to keep that point still.
  const piv = new THREE.Vector3(0.4, 0, 0).applyQuaternion(g.quaternion).add(g.position);
  assert.ok(piv.distanceTo(new THREE.Vector3(0.4, 0, 0).add(p0)) < 1e-6, "the pivot stays put in the world");
  assert.ok(g.position.distanceTo(p0) > 0.3);
  st.setPart("c", "glow", 2);
  const m = g.userData.partsMats[0];
  assert.equal(m.emissiveIntensity, 2);
  st.setPart("c", "finish", "metallic");
  assert.ok(m.metalness > 0.8);
});

test("Director: the part call is one setParts (one undo step), keyed at its time; 'doors' opens every door", async () => {
  const { EXEC } = await import("../../web/agent/director.mjs");
  const st = headless([car("cop", "police_car")]);
  await loaded(st, "cop");
  const host = { stage: st };
  const n0 = st.changes;
  const r = await EXEC.part.call(host, { part: "door_fl", value: 65, at: 2, target: "Police car", target_id: "cop" });
  assert.ok(r.ok, r.said);
  assert.equal(st.changes, n0 + 1, "one undo step");
  assert.deepEqual(st.state.actors[0].parts.door_fl.map((k) => [k.frame, k.v]), [[0, 0], [48, 65]]);
  const r2 = await EXEC.part.call(host, { part: "doors", value: 65, target: "Police car", target_id: "cop" });
  assert.ok(r2.ok);
  for (const d of ["door_fr", "door_rl", "door_rr"]) assert.equal(st.partValue("cop", d, 10), 65);
  const r3 = await EXEC.part.call(host, { part: "lightbar", value: "flash", target: "Police car", target_id: "cop" });
  assert.match(r3.said, /red and blue roof lights flashing/);
});
