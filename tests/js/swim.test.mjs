// Swimming and water (web/stage/swim.mjs, web/stage/water.mjs, the reef set): cadence from the Strouhal number, surge
// and glide from thrust against drag, breathing buoyancy and the exhaled bubbles, the figure's strokes, the regulator in
// the mouth, fins that bend against the water, caustics, Snell's window, the current, stirred sand and the wake.
// node --test tests/js/swim.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import { buildHuman } from "../../web/stage/humans.mjs";
import * as Swim from "../../web/stage/swim.mjs";
import * as W from "../../web/stage/water.mjs";
import { Stage, DEFAULT_SCENE } from "../../web/stage/stage.mjs";
import { seabedHeight } from "../../web/stage/sets/underwater.mjs";
import { clearSetCache } from "../../web/stage/sets/common.mjs";
import { simulateParticles } from "../../web/stage/particles.mjs";
import { loadCatalog, validateCatalog, swimKeys } from "../../web/presets/engine.mjs";
import { PresetRunner } from "../../web/presets/runner.mjs";

const FPS = 24;
const mesh = (g, c) => new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c || "#999" }));

/** A straight swim along +Z at v m/s, n frames, keyed origin height y. */
function path(v, { n = 97, y = 1.2, mode = "under", yawRate = 0 } = {}) {
  const pos = [], yaw = [], modes = [];
  let h = 0, x = 0, z = 0;
  for (let f = 0; f < n; f++) { pos.push([x, y, z]); yaw.push(h); modes.push(mode); h += yawRate / FPS; x += Math.sin(h) * v / FPS; z += Math.cos(h) * v / FPS; }
  return { pos, yaw, mode: modes };
}
function swimmer(v, opts = {}) {
  const g = buildHuman(opts.kind || "man", 1.8, opts.appearance || {}, mesh);
  const plan = Swim.planSwim({ ...path(v, opts), fps: FPS, height: 1.8, seed: 5, style: opts.style || null });
  Swim.ensureKit(g, { gear: opts.gear || (opts.mode === "surface" ? "none" : "scuba"), kind: opts.kind || "man" });
  return { g, plan };
}
const wpos = (o) => o.getWorldPosition(new THREE.Vector3());

// ------------------------------------------------------------------ the physics tables
test("flutter cadence comes from the Strouhal number and stays in 0.5-1 Hz; the kick grows before it quickens", () => {
  let lastTip = 0;
  for (const v of [0.25, 0.4, 0.5, 0.7, 1.0, 1.4]) {
    const g = Swim.swimGait("flutter", v);
    assert.ok(g.freq >= 0.5 - 1e-9 && g.freq <= 1.0 + 1e-9, `${v} m/s -> ${g.freq} Hz`);
    assert.ok(g.tip >= lastTip - 1e-9, "fin sweep never shrinks with speed");
    lastTip = g.tip;
    if (g.freq > 0.5 && g.freq < 1) assert.ok(Math.abs(g.freq * g.tip / v - Swim.STROUHAL) < 1e-6, "St = f A / v");
  }
  const cruise = Swim.swimGait("flutter", 0.5);
  assert.ok(cruise.freq > 0.6 && cruise.freq < 0.8 && cruise.tip > 0.35 && cruise.tip < 0.5, JSON.stringify(cruise));
  assert.ok(Swim.swimGait("frog", 0.4).freq < cruise.freq, "a frog kick is slower than a flutter");
});

test("style follows the place and the speed; the actor's choice wins where it fits", () => {
  assert.equal(Swim.styleWeights("under", 0).main, "hover");
  assert.equal(Swim.styleWeights("under", 0.5).main, "flutter");
  assert.equal(Swim.styleWeights("under", 0.5, "frog").main, "frog");
  assert.equal(Swim.styleWeights("surface", 0).main, "tread");
  assert.equal(Swim.styleWeights("surface", 0.5).main, "breaststroke");
  assert.equal(Swim.styleWeights("surface", 1.2).main, "freestyle");
  assert.equal(Swim.styleWeights("surface", 0.5, "freestyle").main, "freestyle");
  const mid = Swim.styleWeights("under", 0.13).weights;
  assert.ok(mid.flutter > 0 && mid.hover > 0 && Math.abs(mid.flutter + mid.hover - 1) < 1e-9, "styles cross-fade");
});

test("surge: thrust pulses against v^2 drag - the frog kick lunges and coasts, the flutter is nearly steady", () => {
  const frog = Swim.surgeProfile("frog", 0.4), flutter = Swim.surgeProfile("flutter", 0.5), br = Swim.surgeProfile("breaststroke", 0.8);
  const range = (d) => Math.max(...d) - Math.min(...d);
  assert.ok(frog.vmin < 0.4 && frog.vmax > 0.4, `${frog.vmin}..${frog.vmax}`);
  assert.ok(frog.vmax / frog.vmin > 1.25, "the speed rises on the kick and decays through the glide");
  assert.ok(range(frog.disp) > 4 * range(flutter.disp), "a frog kick moves the body in pulses");
  assert.ok(br.vmax / br.vmin > frog.vmax / frog.vmin * 0.9, "breaststroke surges hard too");
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  assert.ok(Math.abs(mean(frog.disp)) < 0.002, "zero mean: the keyed path is still met");
  assert.equal(Swim.surgeProfile("frog", 0.4), frog, "cached");
});

test("breathing: a 3-5 s cycle per diver, and the buoyancy lags the lungs", () => {
  const periods = new Set();
  for (let s = 1; s < 30; s++) { const b = Swim.breathAt(0, s); assert.ok(b.period >= 3 && b.period <= 5); periods.add(b.period.toFixed(2)); }
  assert.ok(periods.size > 20, "divers don't breathe in step");
  // the heave peaks after the lungs fill
  let tl = 0, td = 0, bl = -1, bd = -1;
  const P = Swim.breathAt(0, 7).period;
  for (let t = 0; t < P; t += 0.02) {
    const l = Swim.breathAt(t, 7).lung, d = Swim.buoyancyAt(t, 7).dy;
    if (l > bl) { bl = l; tl = t; }
    if (d > bd) { bd = d; td = t; }
  }
  const lag = ((td - tl) % P + P) % P;
  assert.ok(lag > 0.4 && lag < 1.6, `lag ${lag}`);
  assert.ok(bd > 0.01 && bd < 0.05, "a few centimetres");
});

test("bubbles: rise speed by size (Davies-Taylor caps), Boyle growth to the surface", () => {
  assert.ok(Math.abs(Swim.bubbleRise(0.001) - 0.11) < 1e-9);
  assert.ok(Math.abs(Swim.bubbleRise(0.005) - 0.24) < 1e-9);
  assert.ok(Math.abs(Swim.bubbleRise(0.04) - 0.711 * Math.sqrt(9.81 * 0.04)) < 1e-9);
  const g = Swim.bubbleGrow(0.01, 10, 0) / 0.01;
  assert.ok(g > 1.24 && g < 1.27, `10 m to the surface: x${g} (about 2^(1/3))`);
});

test("exhaled bubbles: bursts that start at an exhale, rise, never pass the surface, and are deterministic", () => {
  const emit = () => [0, 2, 0];
  const b0 = Swim.breathAt(0, 3);
  const exStart = b0.start;                                          // this breath's exhale start (may be in the past)
  const out1 = Swim.exhaleBubbles(3, 20, emit, { surface: 10 }), out2 = Swim.exhaleBubbles(3, 20, emit, { surface: 10 });
  assert.deepEqual(out1, out2);
  assert.ok(out1.size.length > 30, `${out1.size.length} bubbles in the water`);
  for (let i = 0; i < out1.size.length; i++) assert.ok(out1.pos[i * 3 + 1] >= 2 && out1.pos[i * 3 + 1] < 10);
  // during an inhale no new bubbles are born at the regulator
  const P = b0.period, inhaleMid = exStart + P * (1 - 0.6) * 0.5 + P * 0.6 + P;   // inside the next inhale
  const near = (o) => { let n = 0; for (let i = 0; i < o.size.length; i++) if (o.pos[i * 3 + 1] < 2.05) n++; return n; };
  assert.equal(near(Swim.exhaleBubbles(3, inhaleMid + 0.2, emit, { surface: 10 })), 0, "the inhale is silent");
  assert.ok(near(Swim.exhaleBubbles(3, exStart + 2 * P + 0.15, emit, { surface: 10 })) > 3, "the exhale starts with a gush");
});

// ------------------------------------------------------------------ the figure
test("a diver lies level, kicks from the hips, hands folded under the chest; every frame is a pure function", () => {
  const { g, plan } = swimmer(0.5);
  const seen = [];
  for (let f = 0; f < 97; f++) {
    const r = Swim.applySwim(g, plan, f, { surface: 10 });
    assert.ok(r.pose.pitch > 1.3 && r.pose.pitch < 1.6, `pitch ${r.pose.pitch}`);
    g.updateMatrixWorld(true);
    const J = g.userData.joints, head = wpos(J.head), hip = wpos(J.l_hip);
    assert.ok(head.z - hip.z > 0.5 && Math.abs(head.y - hip.y) < 0.25, "level, head first");
    const wl = wpos(J.l_wrist), wr = wpos(J.r_wrist);
    assert.ok(wl.distanceTo(wr) < 0.35 && wl.y < head.y, "hands together, under the chin/chest");
    seen.push(g.position.toArray().concat(J.l_hip.rotation.toArray().slice(0, 3)));
  }
  Swim.applySwim(g, plan, 70, { surface: 10 });
  Swim.applySwim(g, plan, 30, { surface: 10 });
  const again = g.position.toArray().concat(g.userData.joints.l_hip.rotation.toArray().slice(0, 3));
  again.forEach((x, i) => assert.ok(Math.abs(x - seen[30][i]) < 1e-9));
  let nan = 0;
  g.traverse((o) => { const p = o.geometry?.attributes?.position; if (p) for (const x of p.array) if (!Number.isFinite(x)) nan++; });
  assert.equal(nan, 0);
});

test("the fin blades bend against their own motion through the water and snap through at each reversal", () => {
  const { g, plan } = swimmer(0.5);
  const fin = g.userData.swimKit.userData.fins.find((x) => x.lr === "l").blade;
  const tips = [], bends = [];
  let ymin = Infinity, ymax = -Infinity;
  for (let f = 0; f < 97; f++) {
    const r = Swim.applySwim(g, plan, f, { surface: 10 });
    g.updateMatrixWorld(true);
    const straight = new THREE.Vector3(0, 0, fin.userData.L).applyMatrix4(fin.matrixWorld);
    const pa = fin.geometry.attributes.position;
    let far = 0;
    for (let i = 0; i < pa.count; i++) if (pa.getZ(i) > pa.getZ(far)) far = i;
    const bent = new THREE.Vector3(pa.getX(far), pa.getY(far), pa.getZ(far)).applyMatrix4(fin.matrixWorld);
    tips.push(straight); bends.push({ d: bent.sub(straight), b: r.pose.legs.l.bend });
    ymin = Math.min(ymin, straight.y); ymax = Math.max(ymax, straight.y);
  }
  let agree = 0, n = 0, maxB = 0;
  for (let f = 1; f < 96; f++) {
    const vel = tips[f + 1].clone().sub(tips[f - 1]);
    maxB = Math.max(maxB, Math.abs(bends[f].b));
    if (vel.length() < 0.01 || bends[f].d.length() < 0.01) continue;
    n++; if (vel.dot(bends[f].d) < 0) agree++;
  }
  assert.ok(n > 60 && agree / n > 0.75, `${agree}/${n} frames the blade trails its motion`);
  assert.ok(maxB > 0.2 && maxB <= 0.6, `peak bend ${maxB} rad`);
  assert.ok(ymax - ymin > 0.35 && ymax - ymin < 0.8, `fin tip sweep ${(ymax - ymin).toFixed(2)} m peak to peak`);
});

test("the regulator is IN the mouth: the mouthpiece enters the face at mouth height, the hose runs to the first stage", () => {
  const { g, plan } = swimmer(0.5);
  Swim.applySwim(g, plan, 20, { surface: 10 });
  g.updateMatrixWorld(true);
  const kit = g.userData.swimKit, J = g.userData.joints;
  const parts = kit.userData.parts.filter((m) => m.userData.part === "regulator");
  assert.ok(parts.length >= 3);
  // in the head's frame (written at 1.8 m around the head centre): the mouth is below the nose (-0.03) above the chin (-0.084)
  const headY = 1.67, absY = J.head.userData.absY;
  const mp = parts[0];
  const local = mp.position.clone(); local.y -= headY - absY;
  assert.ok(local.y < -0.04 && local.y > -0.08, `mouthpiece height ${local.y}`);
  const box = new THREE.Box3().setFromObject(mp);
  // the face surface at that height (head ellipsoid 0.9 x 1.08 x 1 of r = 0.105, centred 0.005 forward)
  const faceZ = 0.005 + 0.105 * Math.sqrt(1 - (local.y / (0.105 * 1.08)) ** 2);
  const inHead = J.head.worldToLocal(box.min.clone()).z, out = J.head.worldToLocal(box.max.clone()).z;
  assert.ok(Math.min(inHead, out) < faceZ && Math.max(inHead, out) > faceZ, "the mouthpiece passes through the lips");
  const hose = kit.userData.hose.geometry.attributes.position;
  assert.ok(hose.count > 50, "hose built");
  const ends = [0, hose.count - 1].map((i) => new THREE.Vector3(hose.getX(i), hose.getY(i), hose.getZ(i)).applyMatrix4(g.matrixWorld));
  const port = J.head.localToWorld(kit.userData.regPort.clone()), stage1 = J.spine.localToWorld(kit.userData.firstStage.clone());
  assert.ok(Math.min(ends[0].distanceTo(port), ends[1].distanceTo(port)) < 0.03, "hose starts at the second stage");
  assert.ok(Math.min(ends[0].distanceTo(stage1), ends[1].distanceTo(stage1)) < 0.03, "and ends at the first stage on the tank");
  const ex = Swim.exhaustWorld(g);
  assert.ok(ex && ex.distanceTo(wpos(J.head)) < 0.25, "bubbles leave the exhaust tee by the chin");
});

test("freestyle: the body rolls toward the pulling arm, one arm recovers over the water, the head turns to breathe", () => {
  const { g, plan } = swimmer(1.1, { mode: "surface" });
  let rollMax = 0, above = 0, breaths = 0;
  for (let f = 0; f < 97; f++) {
    const r = Swim.applySwim(g, plan, f, { surface: 1.5 });
    g.updateMatrixWorld(true);
    assert.equal(r.style, "freestyle");
    rollMax = Math.max(rollMax, Math.abs(r.pose.roll));
    const J = g.userData.joints;
    if (Math.max(wpos(J.l_wrist).y, wpos(J.r_wrist).y) > 1.5) above++;
    if (r.pose.neck[1] < -0.4 && r.pose.roll < -0.3) breaths++;
  }
  assert.ok(rollMax > 0.5 && rollMax < 0.75, `roll ${rollMax} rad (35-45 degrees)`);
  assert.ok(above > 25, `${above} frames with a hand out of the water`);
  assert.ok(breaths > 5, "breathes to the side as the right shoulder comes up");
});

test("treading water keeps the head above the surface; breaststroke lifts the head on the pull", () => {
  const t = swimmer(0, { mode: "surface" });
  for (const f of [0, 30, 60]) { Swim.applySwim(t.g, t.plan, f, { surface: 1.5 }); t.g.updateMatrixWorld(true); assert.ok(wpos(t.g.userData.joints.head).y > 1.5 + 0.03, "head out"); }
  const b = swimmer(0.6, { mode: "surface" });
  let lo = Infinity, hi = -Infinity;
  for (let f = 0; f < 97; f++) { const r = Swim.applySwim(b.g, b.plan, f, { surface: 1.5 }); assert.equal(r.style, "breaststroke"); lo = Math.min(lo, r.pose.pitch); hi = Math.max(hi, r.pose.pitch); }
  assert.ok(hi - lo > 0.2, "pitches up to breathe and back down into the glide");
});

test("a turning diver banks into the turn; a climbing diver pitches up", () => {
  const turn = swimmer(0.6, { yawRate: 0.5 });
  const r = Swim.applySwim(turn.g, turn.plan, 48, { surface: 10 });
  assert.ok(r.pose.roll > 0.03, `bank ${r.pose.roll}`);
  const pos = [], yaw = [], mode = [];
  for (let f = 0; f < 97; f++) { pos.push([0, 1 + f / 96, f / 24 * 0.5]); yaw.push(0); mode.push("under"); }
  const climb = Swim.planSwim({ pos, yaw, mode, fps: FPS, height: 1.8, seed: 2 });
  const level = Swim.poseAt(Swim.planSwim({ ...path(0.5), fps: FPS, height: 1.8, seed: 2 }), 48).pitch;
  assert.ok(Swim.poseAt(climb, 48).pitch < level - 0.1, "head up when climbing");
});

test("long hair floats and streams back under water", () => {
  const { g, plan } = swimmer(0.4, { kind: "woman", appearance: { hair: "long" } });
  Swim.applySwim(g, plan, 10, { surface: 10 });
  const hair = g.userData._hair;
  assert.ok(hair.length >= 1);
  assert.ok(hair.every((m) => m.rotation.x > 0.15), "lifted off the back");
  Swim.unswim(g);
  assert.ok(hair.every((m) => m.rotation.x === 0) && !g.userData.swimKit.visible, "out of the water: as built");
});

// ------------------------------------------------------------------ the water
test("Snell's window, the refracted sun, the current and its surge", () => {
  assert.ok(Math.abs(W.SNELL_DEG - 48.6) < 0.1);
  const d = W.refractedSun({ azimuth_deg: 190, elevation_deg: 41.7 });
  const sinW = Math.hypot(d[0], d[2]), sinA = Math.cos(41.7 * Math.PI / 180);
  assert.ok(Math.abs(sinA / sinW - W.N_WATER) < 1e-6 && d[1] < 0, "Snell: sin(air) = n sin(water), light going down");
  for (const w of W.WAVES) assert.ok(Math.abs(w.w * w.w - 9.81 * w.k) < 1e-9, "deep-water dispersion");
  const amp = (y) => { let m = 0; for (let t = 0; t < 12; t += 0.1) m = Math.max(m, Math.abs(W.currentAt(0, y, 0, t, { surface: 10, drift: [0, 0] })[0])); return m; };
  assert.ok(amp(8) > amp(1) * 1.3, "the surge decays with depth");
  assert.ok(amp(2) > 0.08 && amp(2) < 0.3, `surge ${amp(2)} m/s near the bottom`);
});

test("caustics conserve the light on average and focus it into a moving network that softens with depth", () => {
  const dir = W.refractedSun({ azimuth_deg: 190, elevation_deg: 42 });
  const stats = (depth, t = 3) => {
    let s = 0, mx = 0, n = 0;
    for (let x = 0; x < 12; x += 0.07) for (let z = 0; z < 6; z += 0.07) { const c = W.causticAt(x, z, depth, t, dir); s += c; mx = Math.max(mx, c); n++; }
    return { mean: s / n, max: mx };
  };
  const shallow = stats(4), deep = stats(9.5);
  assert.ok(deep.mean > 0.8 && deep.mean < 1.4, `mean ${deep.mean}`);
  assert.ok(deep.max > 1.8, "bright focal lines");
  assert.ok(shallow.max > 1 && deep.max < shallow.max * 1.6, "no runaway brightness with depth");
  assert.notEqual(W.causticAt(3, 3, 9, 1, dir), W.causticAt(3, 3, 9, 1.5, dir), "they move with the waves");
  assert.match(W.WAVE_GLSL, /ssCaustic/);
  const m = W.patchCaustics(new THREE.MeshStandardMaterial());
  assert.ok(m.userData.ssCaustics && /ssCaustics/.test(m.customProgramCacheKey()));
});

test("fin wash stirs sand only when the fins kick down close to the bottom", () => {
  const high = [], low = [];
  for (let f = 0; f < 97; f++) {
    const y = 0.5 + 0.25 * Math.sin(f / 24 * Math.PI * 2 * 0.7);
    high.push([[0, 2 + y, f * 0.02]]); low.push([[0, y, f * 0.02]]);
  }
  assert.equal(Swim.finWashEmitters(high, () => 0).length, 0, "fins 2 m up leave the sand alone");
  const em = Swim.finWashEmitters(low, () => 0, { id: "d" });
  assert.ok(em.length > 5 && em.every((e) => e.preset === "seabed_silt" && e.pos[1] < 0.1));
  const sim = simulateParticles(em, { frames: 97, fps: FPS, wind: [0.05, 0.02], floorAt: () => 0.3 });
  const last = sim.frames[96];
  assert.ok(last.n.dust > 0, "silt hangs in the water for seconds");
  for (let i = 0; i < last.n.dust; i++) assert.ok(last.dust[i * 10 + 1] >= 0.3, "and never sinks through the seabed");
});

test("the wake: foam spreads in the Kelvin wedge behind a surface swimmer", () => {
  const { plan } = swimmer(1.1, { mode: "surface" });
  const at = (fq) => (fq < 0 ? null : { x: plan.pos[Math.min(96, Math.round(fq))][0], z: plan.pos[Math.min(96, Math.round(fq))][2], yaw: 0, v: 1.1 });
  const foam = Swim.wakeFoam(at, 90, plan);
  assert.ok(foam.length > 20);
  const head = at(90);
  const arms = foam.filter((p) => p.z < head.z - 1.5);
  const angs = arms.map((p) => Math.atan2(Math.abs(p.x) - 0.25, head.z - p.z) * 180 / Math.PI).sort((a, b) => a - b);
  const angle = angs[Math.floor(angs.length * 0.9)];   // the wedge's edge (the 90th percentile of the scattered foam)
  assert.ok(angle > 12 && angle < 22, `wake half-angle ${angle.toFixed(1)} degrees`);
});

// ------------------------------------------------------------------ on the stage
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => { const url = typeof input === "string" ? input : input.url; if (url.startsWith("file:")) return new Response(readFileSync(fileURLToPath(url)), { status: 200 }); return realFetch(input, init); };
function headless(scene) {
  const st = Object.create(Stage.prototype);
  Object.assign(st, { state: { ...structuredClone(DEFAULT_SCENE), ...structuredClone(scene) }, view: "clay", key: "start", frame: 0, actorMeshes: new Map(),
    root: new THREE.Group(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(40, 1.85, 0.1, 200), render() {}, onChange() {}, onInteract() {}, onSelect() {}, _buildLights() {} });
  st.scene.add(st.root); st._buildSet(); st._setGroup = undefined; st._buildActors?.(); st.setFrame(0);
  return st;
}
const reefScene = (y = 1.25, z1 = 2.4) => ({ shot: { frames: 97, fps: 24 }, environment: { set: "underwater", weather: "none" },
  camera: { position: [-3, 1.5, 0.6], target: [6, 1.9, 2.2], focal_mm: 28 }, sun: { azimuth_deg: 190, elevation_deg: 41.7 },
  actors: [{ id: "diver", name: "Diver", kind: "man", height_m: 1.8, position: [2.2, y, 0], keys: [{ frame: 0, position: [2.2, y, 0] }, { frame: 96, position: [2.3, y + 0.1, z1] }] }] });

test("on the reef set a diver swims (no footsteps), breathes bubbles from the regulator, and plays the same in any order", () => {
  clearSetCache();
  const st = headless(reefScene());
  const g = st.actorMeshes.get("diver");
  st.setFrame(60);
  assert.equal(st._swimNow.length, 1);
  assert.ok(!g.userData.gaitOn && g.userData.swimOn, "swimming, not walking");
  assert.ok(g.userData.swimKit.visible && g.userData.swimKit.userData.exhaust);
  const pos60 = g.position.toArray(), q60 = g.quaternion.toArray();
  st.setFrame(10); st.setFrame(90); st.setFrame(60);
  g.position.toArray().forEach((x, i) => assert.ok(Math.abs(x - pos60[i]) < 1e-9));
  g.quaternion.toArray().forEach((x, i) => assert.ok(Math.abs(x - q60[i]) < 1e-9));
  // the bubbles are drawn: count the points above the regulator in the set's bubble layer
  let pts = null;
  st.scene.traverse((o) => { if (o.isPoints && o.userData.weather === "bubbles") pts = o; });
  assert.ok(pts, "bubble layer");
  const ex = Swim.exhaustWorld(g), pa = pts.geometry.attributes.position;
  let above = 0;
  for (let i = 0; i < pts.geometry.drawRange.count && i < pa.count; i++) if (pa.getY(i) > ex.y && Math.hypot(pa.getX(i) - ex.x, pa.getZ(i) - ex.z) < 1.5) above++;
  assert.ok(above > 10, `${above} bubbles rising from the diver`);
});

test("a diver close to the bottom stirs the sand (the particle system); one cruising higher does not", () => {
  clearSetCache();
  const bed = seabedHeight(2.2, 0);
  const low = headless(reefScene(bed + 0.4, 3.5));
  low.setFrame(80);
  const em = low._swimEmitters();
  assert.ok(em.length > 0 && em.every((e) => e.src === "finwash"));
  clearSetCache();
  const high = headless(reefScene(bed + 1.6, 3.5));
  high.setFrame(80);
  assert.equal(high._swimEmitters().length, 0);
});

test("in open water a person swims at the surface and leaves a wake; the Director's words follow", () => {
  clearSetCache();
  const st = headless({ shot: { frames: 97, fps: 24 }, environment: { set: "open_water", water_level: 1.5 },
    actors: [{ id: "s", name: "Swimmer", kind: "woman", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }, { frame: 96, position: [0, 0, 4.4] }] }] });
  st.setFrame(70);
  const g = st.actorMeshes.get("s");
  assert.equal(st._swimNow[0]?.plan.main[70], "freestyle");
  g.updateMatrixWorld(true);
  const head = wpos(g.userData.joints.head);
  assert.ok(head.y > 1.2 && head.y < 1.75, `head at the surface (${head.y})`);
  assert.ok(st._wakeFx?.visible, "foam on the water");
  assert.equal(g.userData.swimKit.visible, false, "no scuba kit at the surface");
});

// ------------------------------------------------------------------ the preset
test("Diver swim preset: scuba kit, a swim path over the reef, the set moved to the reef", async () => {
  const cat = await loadCatalog();
  assert.deepEqual(validateCatalog(cat), []);
  assert.ok(cat.presets.some((p) => p.id === "diver_swim" && p.apply.swim === "flutter"));
  const keys = swimKeys([0, 0.3, 0], 90, { speed: 0.5, last: 96, fps: 24, lift: 0.5 });
  assert.equal(keys.length, 3);
  assert.ok(Math.abs(keys[2].position[0] - 2) < 1e-6 && Math.abs(keys[0].position[1] - 0.8) < 1e-6);
  const state = { shot: { frames: 97, fps: 24 }, environment: { set: "plaza" }, camera: { position: [0, 1.6, -6], target: [0, 1, 0] },
    actors: [{ id: "m", name: "Maya", kind: "woman", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0 }], shots: [{ id: "a", name: "A", camera_keys: [] }], active_shot: "a" };
  const stage = { state: structuredClone(state), frame: 0, selected: null, _hist: [], toJSON() { return structuredClone(this.state); }, load(s) { this.state = structuredClone(s); },
    setFrame() {}, select() {}, onChange() {}, _lastFrame: () => 96 };
  const runner = new PresetRunner({ stage, host: {}, catalog: cat });
  const r = await runner.apply("diver_swim");
  assert.equal(r.ok, true, r.said);
  const m = stage.state.actors[0];
  assert.equal(stage.state.environment.set, "underwater");
  assert.equal(m.swim, "flutter"); assert.equal(m.gear, "scuba");
  assert.ok(m.keys[0].position[1] - seabedHeight(0, 0) > 0.35, "off the seabed: the stage swims her");
  assert.match(r.said, /regulator in the mouth/);
});
