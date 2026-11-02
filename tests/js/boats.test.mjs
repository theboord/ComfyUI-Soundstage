// Watercraft (web/stage/boatsim.mjs, waves.mjs, boatmesh.mjs, watercraft.mjs): buoyancy finds the real waterline, a
// planing hull climbs the hump and levels, sails heel more in more wind and less when eased, the people's strokes
// are the thrust that surges the hull, runs repeat exactly, and the wave field has the sea state's height.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../web/vendor/three.module.min.mjs";
import * as BS from "../../web/stage/boatsim.mjs";
import * as W from "../../web/stage/waves.mjs";
import { buildObject, LIBRARY, SEATS, resolveKind } from "../../web/stage/library.mjs";
import { seatPositions } from "../../web/stage/boatmesh.mjs";
import { wakeRibbons, boatEmitters, paddlePose, oarPose, wakeAngle, waveGrid } from "../../web/stage/watercraft.mjs";
import { BOAT_PRESETS, boatCameraKeys } from "../../web/presets/boatpresets.mjs";
import { channelsFor } from "../../web/stage/objparts.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ± ${tol}`);
const D2R = Math.PI / 180;

test("buoyancy equilibrium: every hull floats level at the draft where its displaced water weighs what it does", () => {
  for (const kind of BS.WATERCRAFT) {
    const H = BS.HULLS[kind], rest = BS.restDraft(H, W.RHO_FRESH);
    // Archimedes: ρ V = m, to within the column sampling.
    near(rest.vol * W.RHO_FRESH, H.mass, H.mass * 0.01, `${kind} displacement`);
    assert.ok(rest.freeboard > 0.15, `${kind} has freeboard (${rest.freeboard.toFixed(2)} m)`);
    const b = new BS.Boat(kind, { waves: null });
    for (let i = 0; i < 240 * 6; i++) b.step(1 / 240);
    near(b.y, -rest.T, 0.01, `${kind} keel at -draft`);
    near(b.pitch / D2R, 0, 0.3, `${kind} level fore and aft`);
    near(b.roll / D2R, 0, 0.3, `${kind} upright`);
  }
  // Real drafts: a canoe floats in ~12 cm, a 21 ft bowrider ~35 cm, the 32 ft cruiser's canoe body ~45 cm.
  near(BS.restDraft(BS.HULLS.canoe).T, 0.12, 0.04, "canoe draft");
  near(BS.restDraft(BS.HULLS.speedboat).T, 0.35, 0.08, "speedboat draft");
});

test("buoyancy rights a heeled hull and damps it; a pushed-down hull bobs back up to the same waterline", () => {
  for (const kind of ["canoe", "speedboat", "yacht", "raft"]) {
    const b = new BS.Boat(kind, {});
    const y0 = b.y;
    b.roll = 12 * D2R; b.y -= 0.05;
    let maxBack = 0;
    for (let i = 0; i < 240 * 12; i++) { b.step(1 / 240); maxBack = Math.min(maxBack, b.roll); }
    near(b.roll / D2R, 0, 0.5, `${kind} rights itself`);
    near(b.y, y0, 0.01, `${kind} back at its waterline`);
    assert.ok(maxBack < 0, `${kind} overshoots (a real roll oscillation, not a snap back)`);
  }
});

test("planing curve: the bow climbs to a hump trim of 4–8° near 4–7 m/s, then levels to 1–4° as the speedboat planes", () => {
  const c = BS.planingCurve("speedboat", { throttles: [0.1, 0.25, 0.32, 0.35, 0.4, 0.5, 0.7, 1], seconds: 20 });
  const hump = c.reduce((m, r) => (r.trim > m.trim ? r : m), c[0]);
  assert.ok(hump.trim >= 4 && hump.trim <= 8.5, `hump trim ${hump.trim.toFixed(2)}°`);
  assert.ok(hump.speed >= 3.5 && hump.speed <= 7.5, `hump at ${hump.speed.toFixed(1)} m/s`);
  const top = c[c.length - 1];
  assert.ok(top.speed > 15 && top.speed < 23, `top speed ${top.speed.toFixed(1)} m/s (30–45 kn for 220 hp on a 21 ft hull)`);
  assert.ok(top.trim >= 0.8 && top.trim <= 4.5 && top.trim < hump.trim - 1.5, `planing trim ${top.trim.toFixed(2)}° below the hump`);
  assert.ok(top.rise > 0.03, `the hull rises out on the plane (${top.rise.toFixed(3)} m)`);
  // Below hull speed it sits nearly level.
  assert.ok(Math.abs(c[0].trim) < 2, `slow trim ${c[0].trim.toFixed(2)}°`);
  // The hump is a barrier: a little more throttle past it jumps the speed (the classic step).
  const i = c.indexOf(hump);
  assert.ok(c[c.length - 1].speed / hump.speed > 2.4, "planing speed well above the hump");
  assert.ok(i > 0 && i < c.length - 2, "the hump is in the middle of the curve");
});

test("heel against wind: more wind heels a sailboat more, easing the sheet spills it, heeled sails lose drive (cos²)", () => {
  const run = (kind, ws, sheet = null, twa = 60) => {
    const b = new BS.Boat(kind, { heading: BS.headingForTwa([0, ws], twa), wind: [0, ws], speed: 1.5 });
    const h0 = b.h;
    b.ctl.sheet = sheet;
    let heel = 0, u = 0, n = 0;
    for (let i = 0; i < 240 * 30; i++) {
      b.ctl.steer = Math.max(-1, Math.min(1, Math.atan2(Math.sin(h0 - b.h), Math.cos(h0 - b.h)) * 3 - b.r));
      b.step(1 / 240);
      if (i > 240 * 20) { heel += b.roll; u += b.u; n++; }
    }
    return { heel: heel / n / D2R, u: u / n };
  };
  const y4 = run("yacht", 4), y7 = run("yacht", 7), y10 = run("yacht", 10);
  // Starboard tack (wind over the right): it heels to the left side (roll < 0), more with more wind.
  assert.ok(y4.heel < 0 && y7.heel < y4.heel && y10.heel < y7.heel, `yacht heel ${y4.heel.toFixed(1)} / ${y7.heel.toFixed(1)} / ${y10.heel.toFixed(1)}°`);
  assert.ok(Math.abs(y10.heel) < 32, "the ballast keel holds it below 32° at 20 kn");
  assert.ok(y7.u > 2.2 && y7.u < 4.2, `yacht close reach ${y7.u.toFixed(2)} m/s (4–8 kn)`);
  const eased = run("yacht", 10, 1.0);
  assert.ok(Math.abs(eased.heel) < Math.abs(y10.heel), `easing the sheet spills wind: ${eased.heel.toFixed(1)} vs ${y10.heel.toFixed(1)}°`);
  // Dinghy: the sailor hikes out and keeps it within ~25°; the cos² law: the same sail heeled 30° gives 75 % force.
  const d = run("dinghy", 6);
  assert.ok(Math.abs(d.heel) < 26 && d.u > 2, `dinghy ${d.heel.toFixed(1)}°, ${d.u.toFixed(2)} m/s`);
  near(Math.cos(30 * D2R) ** 2, 0.75, 1e-9, "cos² heel law");
  // No sail drives head to wind (in irons): the sail luffs.
  const c = BS.sailCoef(3 * D2R);
  assert.ok(c.luff > 0.5 && Math.abs(c.cl) < 0.3, "luffing at 3°");
  assert.ok(BS.sailCoef(20 * D2R).cl > 1.3 && BS.sailCoef(45 * D2R).cl < BS.sailCoef(20 * D2R).cl, "stalls past ~22°");
});

test("tack: the boom swings across and the crew moves over within a few seconds; the boat slows through the wind", () => {
  const wind = [0, 6];
  const run = BS.simulateBoat(BS.boatScript("sailing_tack", { tack_s: 3 }), { frames: 240, fps: 24, wind, heading: BS.headingForTwa(wind, 48), kind: "dinghy" });
  const F = run.frames;
  const before = F[60], after = F[230];
  assert.ok(Math.sign(before.sails.main.boom) !== Math.sign(after.sails.main.boom), `boom crossed ${before.sails.main.boom.toFixed(0)} → ${after.sails.main.boom.toFixed(0)}°`);
  assert.ok(Math.sign(before.crewY) !== Math.sign(after.crewY), "the sailor crossed the boat");
  assert.ok(Math.sign(before.roll) !== Math.sign(after.roll), "it heels the other way");
  const minU = Math.min(...F.slice(60, 230).map((s) => s.u));
  assert.ok(minU < before.u * 0.8, `it slows through the wind (${before.u.toFixed(2)} → ${minU.toFixed(2)} m/s)`);
  assert.ok(Math.abs(BS.headingForTwa(wind, 48) - BS.headingForTwa(wind, -48)) > 1.5, "a 96° tack");
});

test("stroke sync: the crew's strokes are the hull's thrust: each catch surges it, single blades yaw it, phases are output", () => {
  const run = BS.simulateBoat(BS.boatScript("canoe_lake", {}), { frames: 240, fps: 24 });
  const F = run.frames;
  const spans = BS.strokeSpans(run);
  const bow = spans.filter((s) => s.seat === 0 && s.from > 48);
  assert.ok(bow.length >= 5, `${bow.length} bow strokes in 8 s (~40 strokes / min)`);
  // Speed rises during each drive and falls in the recovery: the surge lines up with the blade in the water.
  let up = 0, down = 0;
  for (const s of bow) {
    if (s.to >= F.length) continue;
    const du = F[s.to].u - F[s.from].u;
    if (du > 0) up++;
    const next = spans.find((x) => x.seat === 0 && x.from > s.to);
    if (next && F[next.from].u < F[s.to].u) down++;
  }
  assert.ok(up >= bow.length - 2 && down >= bow.length - 3, `surge with the drive (${up} up, ${down} glide down of ${bow.length})`);
  // The bow paddler is on the right, the stern on the left: the samples carry each seat's phase and side.
  const s = F[120].strokes;
  assert.equal(s.length, 2);
  assert.equal(s[0].side, -1); assert.equal(s[1].side, 1);
  for (const x of s) assert.ok(x.u >= 0 && x.u < 1);
  // strokeAt (playback) agrees with the sim's own wet flag.
  for (let f = 60; f < 230; f += 7) {
    const st = BS.strokeAt(spans, 0, f, BS.HULLS.canoe.drivePhase);
    assert.ok(st, `stroke state at ${f}`);
    assert.equal(st.wet, !!F[f].strokes[0].wet, `frame ${f} wet`);
  }
  // Kayak: alternating sides; the heading wags with each stroke but holds on average.
  const k = BS.simulateBoat(BS.boatScript("kayak_paddle", {}), { frames: 240, fps: 24 });
  const sides = BS.strokeSpans(k).map((x) => x.side);
  assert.ok(sides.slice(2, 10).every((v, i, a) => i === 0 || v !== a[i - 1]), "kayak strokes alternate left, right");
  const hd = k.frames.map((x) => x.h / D2R);
  assert.ok(Math.abs(hd[239]) < 3, `kayak holds its line (${hd[239].toFixed(2)}°)`);
  // A paddle pose has the blade in the water during the drive and out in the recovery.
  const H = BS.HULLS.canoe, wl = BS.restDraft(H).T;
  const inWater = paddlePose(H, SEATS.canoe[0].pos, { u: 0.2, wet: true }, "canoe", -1, wl);
  const out = paddlePose(H, SEATS.canoe[0].pos, { u: 0.7, wet: false }, "canoe", -1, wl);
  const bladeY = (pp) => pp.grip[1] + pp.dir.y * 1.18;
  assert.ok(bladeY(inWater) < wl - 0.1 && bladeY(out) > wl, "blade in the water on the drive, out on the recovery");
  assert.ok(oarPose({ u: 0 }).th > 0.5 && oarPose({ u: 0.37 }).th < -0.4, "oars sweep from the catch to the finish");
});

test("determinism: the same script on the same sea gives the same run, frame for frame", () => {
  const F = W.makeField("moderate", { wind_deg: 30, seed: 3 });
  for (const id of BS.BOAT_PRESETS) {
    const sc = BS.boatScript(id, {});
    const a = BS.simulateBoat(sc, { frames: 72, fps: 24, waves: F, level: 1.5 });
    const b = BS.simulateBoat(sc, { frames: 72, fps: 24, waves: F, level: 1.5 });
    assert.deepEqual(a.frames.map((s) => [s.x, s.z, s.h, s.y, s.pitch, s.roll]), b.frames.map((s) => [s.x, s.z, s.h, s.y, s.pitch, s.roll]), id);
  }
  const tr = { x: [...Array(48)].map((_, i) => i * 0.3), z: Array(48).fill(0), h: Array(48).fill(Math.PI / 2), fps: 24 };
  assert.deepEqual(BS.floatTrack("canoe", tr, { waves: F, level: 1 }).map((s) => s.y), BS.floatTrack("canoe", tr, { waves: F, level: 1 }).map((s) => s.y));
});

test("waves: the field has the sea state's significant height; boats ride it (a bigger sea pitches a hull harder)", () => {
  for (const id of ["calm_lake", "breeze", "moderate", "rough"]) {
    const F = W.makeField(id, { seed: 2 });
    let s = 0, s2 = 0, n = 0;
    for (let x = 0; x < 240; x += 3.7) for (let z = 0; z < 240; z += 2.9) { const h = W.heightAt(F, x, z, 7.1); s += h; s2 += h * h; n++; }
    near(4 * Math.sqrt(s2 / n - (s / n) ** 2), F.hs, F.hs * 0.15, `${id} Hs`);
  }
  // Deep-water dispersion: ω² = g k for every train.
  const F = W.makeField("moderate");
  for (let i = 0; i < F.n; i++) { const o = i * 5; near(F.comps[o + 3] ** 2, 9.81 * Math.hypot(F.comps[o + 1], F.comps[o + 2]), 1e-6, "dispersion"); }
  const tr = { x: Array(96).fill(0), z: [...Array(96)].map((_, i) => i * 0.15), h: Array(96).fill(0), fps: 24 };
  const span = (id) => { const r = BS.floatTrack("speedboat", tr, { waves: W.makeField(id), level: 0 }); const p = r.slice(24).map((s) => s.pitch); return Math.max(...p) - Math.min(...p); };
  assert.ok(span("moderate") > 2 * span("calm_lake") && span("calm_lake") < 1.5, `pitching ${span("calm_lake").toFixed(2)}° calm vs ${span("moderate").toFixed(2)}° moderate`);
  // Whitewater: standing waves at λ = 2πU²/g that stay put while the current runs.
  const R = W.makeField("whitewater");
  near(2 * Math.PI / R.standing.k, 2 * Math.PI * 3.2 ** 2 / 9.81, 1e-6, "standing wavelength");
  assert.ok(R.current[1] > 3, "the river flows");
});

test("clay hulls: lofted at the physics' size, seats inside the hull, parts the poser drives, words resolve", () => {
  const mesh = (g, c) => new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c }));
  for (const kind of BS.WATERCRAFT) {
    const g = buildObject(kind, null, mesh);
    const R = g.userData.boat;
    assert.ok(R && R.hull, `${kind} hull`);
    const bb = new THREE.Box3().setFromObject(R.hull);
    const H = BS.HULLS[kind], sz = bb.getSize(new THREE.Vector3());
    near(sz.z, H.L, H.L * 0.08, `${kind} length`);
    near(sz.x, H.B, H.B * 0.12 + 0.05, `${kind} beam`);
    near(LIBRARY[kind].length, H.L, 0.01, `${kind} library length`);
    assert.deepEqual(SEATS[kind].map((s) => s.pos), seatPositions(kind).map((p) => p.map((v) => +v.toFixed(2))), `${kind} SEATS match the mesh`);
    for (const s of SEATS[kind]) { const st = BS.station(H, s.pos[2] / H.L + 0.5); assert.ok(Math.abs(s.pos[0]) <= st.b + 0.05, `${kind} ${s.name} inside the beam`); }
    if (H.paddlers) assert.ok(R.paddles.length >= H.paddlers.length, `${kind} has its paddles`);
    if (H.sails) assert.equal(R.rig.length, H.sails.length);
    assert.ok(channelsFor(kind).length >= 3, `${kind} Parts`);
  }
  assert.ok(channelsFor("speedboat").includes("motor_trim") && channelsFor("yacht").includes("sheet") && channelsFor("canoe").includes("effort"));
  for (const [w, k] of [["speedboat", "speedboat"], ["a sailboat", "yacht"], ["canoe", "canoe"], ["white water raft", "raft"], ["fishing boat", "fishing_boat"], ["log raft", "log_raft"], ["kayak", "kayak"], ["rowing boat", "rowboat"]])
    assert.equal(resolveKind(w), k, w);
});

test("wakes and spray: Kelvin arms at 19.5° slow, narrower fast; spray at the bow, wash at the stern, drips at the strokes", () => {
  near(wakeAngle(0.3) / D2R, 19.47, 0.01, "Kelvin angle");
  assert.ok(wakeAngle(2) < wakeAngle(0.8) && wakeAngle(2) / D2R > 4, "planing wakes narrow");
  const run = BS.simulateBoat(BS.boatScript("speedboat_run", {}), { frames: 168, fps: 24 });
  const tr = BS.floatTrack("speedboat", { x: run.frames.map((s) => s.x), z: run.frames.map((s) => s.z), h: run.frames.map((s) => s.h), fps: 24 }, {});
  const r = wakeRibbons(tr, 160, { L: 6.4, B: 2.44 });
  assert.ok(r.n > 300, `${r.n} wake vertices`);
  const em = boatEmitters(tr, BS.HULLS.speedboat, { level: 0 });
  assert.ok(em.some((e) => e.preset === "wet_spray") && em.some((e) => e.preset === "foam"), "bow spray and prop wash");
  const c = BS.simulateBoat(BS.boatScript("canoe_lake", {}), { frames: 120, fps: 24 });
  const ct = BS.floatTrack("canoe", { x: c.frames.map((s) => s.x), z: c.frames.map((s) => s.z), h: c.frames.map((s) => s.h), fps: 24 }, {});
  ct.forEach((s, f) => { s.strokes = c.frames[f].strokes; });
  assert.ok(boatEmitters(ct, BS.HULLS.canoe, { level: 0 }).length >= 6, "paddle drips at catches and exits");
  const g = waveGrid(96, 450);
  near(g[96 + 1] - g[96], 0.15, 0.02, "fine grid under the camera"); near(g[g.length - 1], 450, 9, "out to the horizon");
});

test("presets: four cards, each a boat on its water with its crew and a camera on the run", () => {
  assert.deepEqual(Object.keys(BOAT_PRESETS), BS.BOAT_PRESETS);
  for (const id of BS.BOAT_PRESETS) {
    const sp = BOAT_PRESETS[id];
    assert.ok(BS.HULLS[sp.boat] && W.SEA_STATES[sp.sea] && sp.crew.length, id);
    const run = BS.simulateBoat(BS.boatScript(id, {}), { frames: 97, fps: 24, wind: [0, 6], heading: id === "sailing_tack" ? BS.headingForTwa([0, 6], 48) : 0 });
    const cam = boatCameraKeys(id, run, 96);
    assert.ok(cam.length >= 16 && cam.every((k) => k.position.every(Number.isFinite) && k.target.every(Number.isFinite)), `${id} camera`);
    assert.ok(run.frames[96].speed > 0.5, `${id} moves`);
  }
});
