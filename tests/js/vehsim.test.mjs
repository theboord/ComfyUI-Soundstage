// Stunt-car vehicle dynamics (web/stage/vehsim.mjs). The tests cover the tyre model, that runs are deterministic, and
// that the driven stunts land inside the ranges in share/Stunt_Dynamics/RESEARCH.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SURFACES, CAR, carParams, magic, tyreForce, simulate, driverScript, metrics } from "../../web/stage/vehsim.mjs";
import { stuntKeys, stuntRun } from "../../web/stage/stunts.mjs";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ± ${tol}`);

test("magic formula: peak near 5° on wet and 8–10° on dry, sliding grip 75–95 % of peak, never negative", () => {
  for (const [name, lo, hi] of [["wet", 3, 8], ["dry", 6, 12]]) {
    const surf = SURFACES[name];
    let best = 0, at = 0;
    for (let d = 0; d <= 90; d += 0.25) { const v = magic(d * Math.PI / 180, surf); assert.ok(v >= 0, `${name} ${d}°: ${v}`); if (v > best) { best = v; at = d; } }
    near(best, 1, 1e-3, `${name} peak`);
    assert.ok(at >= lo && at <= hi, `${name} peak at ${at}°`);
    const slide = magic(Math.PI / 2, surf);
    assert.ok(slide > 0.74 && slide < 0.95, `${name} sliding share ${slide}`);
  }
  // The coefficients are the published typical sets (MathWorks Tire-Road Interaction, Magic Formula).
  assert.deepEqual([SURFACES.dry.B, SURFACES.dry.C, SURFACES.dry.E], [10, 1.9, 0.97]);
  assert.deepEqual([SURFACES.wet.B, SURFACES.wet.C, SURFACES.wet.E], [12, 2.3, 1]);
  assert.ok(SURFACES.wet.mu >= 0.5 && SURFACES.wet.mu <= 0.7, "wet-asphalt peak μ 0.5–0.7");
});

test("tyre: slip angle → lateral force, slip ratio → longitudinal, a locked wheel slides, all inside the friction ellipse", () => {
  const wet = SURFACES.wet, Fz = 4000, v = 15;
  // Pure slip angle α: lateral force against the slide, = μ·Fz·MF(α) (× the ellipse's lateral 0.95).
  for (const deg of [2, 5, 10, 30, 80]) {
    const a = deg * Math.PI / 180, f = tyreForce(v * Math.cos(a), v * Math.sin(a), v * Math.cos(a), Fz, wet);
    near(f.s, deg, 0.01, "slip = α");
    assert.ok(f.fy < 0 && Math.abs(f.fx) < 1e-6, "pushes back against the sideways slide");
    near(-f.fy, 0.95 * wet.mu * Fz * magic(a, wet), 1e-6, `|Fy| at ${deg}°`);
  }
  // Slip ratio: a driven wheel 10 % faster than the road pushes forward, a braked one pulls back; symmetric.
  const drive = tyreForce(v, 0, 1.1 * v, Fz, wet), brake = tyreForce(v, 0, 0.9 * v, Fz, wet);
  assert.ok(drive.fx > 0.9 * wet.mu * Fz && brake.fx < 0);
  near(drive.fx, -brake.fx, 0.02 * Fz, "drive / brake symmetric about free rolling");
  assert.equal(tyreForce(v, 0, v, Fz, wet).fx, 0, "free rolling: no force");
  // Locked: slides against the travel at the sliding share of μ.
  const lock = tyreForce(v, 0, 0, Fz, wet);
  assert.ok(lock.fx < 0 && -lock.fx / (wet.mu * Fz) > 0.7 && -lock.fx / (wet.mu * Fz) < 0.95, `locked ${lock.fx}`);
  // Combined slip never exceeds μ·Fz, and lateral grip falls away when the wheel spins (the friction ellipse).
  for (let i = 0; i < 200; i++) {
    const vx = Math.sin(i) * 20, vy = Math.cos(i * 1.7) * 8, wR = Math.sin(i * 0.37) * 25;
    const f = tyreForce(vx, vy, wR, Fz, wet);
    assert.ok(Math.hypot(f.fx, f.fy) <= wet.mu * Fz + 1e-6);
  }
  const grip = Math.abs(tyreForce(v, 2, v, Fz, wet).fy), spin = Math.abs(tyreForce(v, 2, 2.5 * v, Fz, wet).fy);
  assert.ok(spin < 0.5 * grip, `a spinning tyre loses its side grip: ${spin} vs ${grip}`);
  assert.deepEqual(tyreForce(5, 1, 5, 0, wet), { fx: 0, fy: 0, s: 0, vs: 0 }, "an unloaded tyre gives nothing");
});

test("deterministic: the same script and car give identical runs; keys are the same every time", () => {
  const a = simulate(driverScript("reverse_jturn", {}), { car: CAR, surface: "wet" });
  const b = simulate(driverScript("reverse_jturn", {}), { car: CAR, surface: "wet" });
  assert.deepEqual(a, b);
  assert.deepEqual(stuntKeys("reverse_jturn", { start: [1, 0, 2], dirDeg: 30 }), stuntKeys("reverse_jturn", { start: [1, 0, 2], dirDeg: 30 }));
});

test("a car at rest stays put; a straight launch squats the rear and braking dives the nose, with no roll", () => {
  const rest = simulate({ start: { kmh: 0 }, steps: [{ at: 0, set: { gear: "N" } }] }, { frames: 48 });
  assert.ok(rest.every((o) => Math.hypot(o.x, o.z) < 1e-6 && Math.abs(o.roll) < 1e-9));
  const run = simulate({ start: { kmh: 0 }, steps: [{ at: 0, set: { gear: "D", throttle: 1, ramp: 0.2 } }, { at: 2.5, set: { throttle: 0, brake: 0.8, gear: "N", ramp: 0.1 } }] },
    { surface: "dry", frames: 120 });
  assert.ok(run[30].pitch > 0.5, `squat on the launch: ${run[30].pitch}`);
  assert.ok(Math.min(...run.slice(62, 90).map((o) => o.pitch)) < -1, "dives on the brakes");
  assert.ok(run.every((o) => Math.abs(o.roll) < 1e-3 && Math.abs(o.x) < 1e-3), "straight: no roll, no drift");
  assert.ok(run[60].speed > 9 && run[60].speed < 25, `0-60 frames: ${run[60].speed} m/s`);
});

test("the body is a damped oscillator at its natural frequency: a step in lateral g rings at ~1.3 Hz and settles", () => {
  // Steady circle at full lock, then wheel straight: the roll springs back through zero and rings down.
  const run = simulate({ start: { kmh: 30 }, steps: [{ at: 0, set: { gear: "D", hold_kmh: 30, steer: 8, ramp: 0.3 } }, { at: 2.5, set: { steer: 0, ramp: 0.05 } }] },
    { surface: "dry", frames: 168 });
  const r = run.slice(60).map((o) => o.roll);
  const cross = [];
  for (let i = 1; i < r.length; i++) if (Math.sign(r[i]) !== Math.sign(r[i - 1])) cross.push(i);
  assert.ok(cross.length >= 2, `rings: ${cross.length} zero crossings`);
  const hz = (cross.length - 1) / 2 / ((cross[cross.length - 1] - cross[0]) / 24);
  if (cross.length >= 3) assert.ok(hz > 1.0 && hz < 1.7, `${hz} Hz`);
  assert.ok(Math.abs(r[r.length - 1]) < 0.3, "settles");
  assert.ok(Math.abs(run[50].roll) > 1.5 && Math.abs(run[50].roll) < 6, `steady lean ${run[50].roll}°`);
});

test("reverse J-turn at 40 km/h on a wet road: rotation, slide, yaw rate and roll inside the researched ranges", () => {
  const { metrics: m, run } = stuntRun("reverse_jturn", { params: { entry_kmh: 40, surface: "wet" } });
  near(m.entry_kmh, 40, 1, "entry speed");
  assert.ok(m.rotation_s >= 1.2 && m.rotation_s <= 2.2, `rotation ${m.rotation_s} s`);
  // At μ 0.62 the car can't shed 11 m/s in less than v²/2μg ≈ 10 m.
  assert.ok(m.slide_m >= 10 && m.slide_m <= 25, `slide ${m.slide_m} m`);
  assert.ok(m.peak_yaw_rate >= 70 && m.peak_yaw_rate <= 200, `yaw ${m.peak_yaw_rate}°/s`);
  assert.ok(m.peak_roll >= 2.5 && m.peak_roll <= 7, `roll ${m.peak_roll}°`);
  assert.ok(m.peak_beta > 70, `goes sideways: body slip ${m.peak_beta}°`);
  assert.ok(m.peak_slip > 45, "the tyres slide");
  near(m.turned_deg, 180, 15, "ends nose first");
  // It starts tail first, finishes nose first and drives away.
  assert.ok(run[0].controls.gear === "R" && run[run.length - 1].controls.gear === "D");
  assert.ok(run[run.length - 1].speed > 5);
  // Smoke comes from the slip: none on the straight reverse, plenty through the slide.
  assert.ok(run.slice(0, 20).every((o) => o.smoke.amount === 0));
  assert.ok(Math.max(...run.map((o) => o.smoke.amount)) > 0.4);
});

test("dry vs wet, light vs heavy, faster entry: the physics moves the stunt the right way", () => {
  const J = (p) => stuntRun("reverse_jturn", { params: p }).metrics;
  const wet = J({ surface: "wet" }), dry = J({ surface: "dry" });
  assert.ok(dry.rotation_s < wet.rotation_s && dry.slide_m < wet.slide_m, "more grip: quicker and shorter");
  assert.ok(dry.peak_roll > wet.peak_roll, "more grip: more lean");
  assert.ok(dry.roll_hz > 1.0 && dry.roll_hz < 1.7, `the wobble rings at ${dry.roll_hz} Hz`);
  const fast = J({ entry_kmh: 50 });
  assert.ok(fast.slide_m > wet.slide_m, "faster: slides further");
  const heavy = J({ mass_kg: 2000 });
  assert.ok(heavy.slide_m >= wet.slide_m - 1, `heavier: slides as far or further (${heavy.slide_m} vs ${wet.slide_m})`);
});

test("handbrake 180 and donut run on the same simulation", () => {
  const h = stuntRun("handbrake_180", {}).metrics;
  assert.ok(h.rotation_s >= 1.2 && h.rotation_s <= 2.8, `handbrake rotation ${h.rotation_s} s`);
  assert.ok(h.slide_m >= 12 && h.slide_m <= 35, `handbrake slide ${h.slide_m} m`);
  near(h.turned_deg, 180, 20, "ends facing back");
  const d = stuntRun("donut", {});
  assert.ok(d.metrics.turned_deg > 250, `the donut swings the tail round: ${d.metrics.turned_deg}°`);
  assert.ok(d.run.slice(30).some((o) => o.smoke.wheels === "rear" && o.smoke.amount > 0.3), "rear tyres smoke");
  assert.equal(carParams("police_car").mass, 1800);
  assert.equal(carParams("sports_car", 1700).mass, 1700);
});
