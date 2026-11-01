// Stunt-car vehicle dynamics (web/stage/vehsim.mjs). The tests cover the tyre model, that runs are deterministic, and
// that the driven stunts land inside the ranges in share/Stunt_Dynamics/RESEARCH.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SURFACES, CAR, carParams, magic, tyreForce, simulate, driverScript, metrics, STUNT_SUSPENSION } from "../../web/stage/vehsim.mjs";
import { stuntKeys, stuntRun, smokeParticles } from "../../web/stage/stunts.mjs";

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
  assert.ok(m.peak_roll >= 6 && m.peak_roll <= 9, `stunt-softened roll ${m.peak_roll}°`);
  assert.ok(m.peak_beta > 70, `goes sideways: body slip ${m.peak_beta}°`);
  assert.ok(m.peak_slip > 45, "the tyres slide");
  near(m.turned_deg, 180, 15, "ends nose first");
  // It starts tail first, finishes nose first and drives away.
  assert.ok(run[0].controls.gear === "R" && run[run.length - 1].controls.gear[0] === "D");
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
  assert.ok(dry.roll_hz > 0.8 && dry.roll_hz < 1.3, `the stunt-sprung wobble rings at ${dry.roll_hz} Hz`);
  const fast = J({ entry_kmh: 50 });
  assert.ok(fast.slide_m > wet.slide_m, "faster: slides further");
  const heavy = J({ mass_kg: 2000 });
  assert.ok(heavy.slide_m >= wet.slide_m - 1, `heavier: slides as far or further (${heavy.slide_m} vs ${wet.slide_m})`);
});

test("handbrake 180 and donut run on the same simulation", () => {
  const h = stuntRun("handbrake_180", {}).metrics;
  assert.ok(h.rotation_s >= 1.2 && h.rotation_s <= 2.6, `handbrake rotation ${h.rotation_s} s`);
  assert.ok(h.slide_m >= 12 && h.slide_m <= 35, `handbrake slide ${h.slide_m} m`);
  near(h.turned_deg, 180, 20, "ends facing back");
  const d = stuntRun("donut", {});
  assert.ok(d.metrics.turned_deg > 300, `the donut holds to the end of a 5 s shot: ${d.metrics.turned_deg}°`);
  assert.ok(d.run.slice(30).some((o) => o.smoke.wheels === "rear" && o.smoke.amount > 0.3), "rear tyres smoke");
  assert.equal(carParams("police_car").mass, 1800);
  assert.equal(carParams("sports_car", 1700).mass, 1700);
});

// ---------- round 2: stunt suspension, the launch, the donut hold, the handbrake drive-off, smoke vs spray ----------
const turnedAt = (run) => run.map((o) => Math.abs(o.h - run[0].h));
const extrema = (xs, min = 0.4) => { const pk = []; for (let i = 1; i < xs.length - 1; i++) if ((xs[i] - xs[i - 1]) * (xs[i + 1] - xs[i]) < 0 && Math.abs(xs[i]) > min) pk.push(xs[i]); return pk; };

test("stunt suspension: softer than stock, and the presets use it unless asked for stock", () => {
  const stock = carParams("sports_car"), stunt = carParams("sports_car", null, "stunt");
  assert.ok(stunt.roll.grad > stock.roll.grad * 1.4 && stunt.roll.hz <= 1.05 && stunt.roll.zeta < stock.roll.zeta);
  assert.ok(stunt.pitch.grad > stock.pitch.grad * 1.5 && stunt.steerMax === STUNT_SUSPENSION.steerMax);
  const s = stuntRun("reverse_jturn", {}).metrics, k = stuntRun("reverse_jturn", { params: { suspension: "stock" } }).metrics;
  assert.ok(s.peak_roll > k.peak_roll * 1.5, `stunt ${s.peak_roll}° vs stock ${k.peak_roll}°`);
});

test("J-turn body: a visible 6–9° lean in the flick, rocking through at least one more peak, dive and squat", () => {
  const { run } = stuntRun("reverse_jturn", {});
  const rolls = run.map((o) => o.roll), pk = extrema(rolls, 1.5);
  assert.ok(Math.max(...rolls.map(Math.abs)) >= 6 && Math.max(...rolls.map(Math.abs)) <= 9);
  assert.ok(pk.length >= 3, `the body rocks: ${pk.map((x) => x.toFixed(1))}`);
  const done = turnedAt(run).findIndex((x) => x >= 170);
  assert.ok(Math.max(...run.slice(done).map((o) => o.pitch)) > 2, "squats on the launch");
  assert.ok(Math.min(...run.map((o) => o.pitch)) < -1.2, "dives as the reverse slide brakes");
  // Dry: more grip, more lean, but the bump stops hold it near 10°.
  const dry = stuntRun("reverse_jturn", { params: { surface: "dry" } }).metrics;
  assert.ok(dry.peak_roll > 8 && dry.peak_roll < 11.5, `dry roll ${dry.peak_roll}`);
});

test("J-turn launch: first gear, full throttle, the rears spin, the tail fishtails once and settles", () => {
  const { run } = stuntRun("reverse_jturn", {});
  const t = turnedAt(run), done = t.findIndex((x) => x >= 170), after = run.slice(done);
  assert.ok(after.some((o) => o.controls.gear === "D1" && o.controls.throttle > 0.95), "floored in first");
  assert.ok(Math.max(...after.map((o) => Math.max(o.slipSpeed[2], o.slipSpeed[3]))) > 5, "wheelspin");
  const wag = extrema(t.slice(done).map((x) => x - 180), 0.3);
  assert.ok(wag.length >= 2 && wag[0] > 3 && Math.sign(wag[1]) !== Math.sign(wag[0]), `fishtail ${wag.map((x) => x.toFixed(1))}`);
  assert.ok(Math.abs(t.at(-1) - 180) < 4, "settles straight");
  assert.ok(run.at(-1).speed * 3.6 > 35, `drives off: ${run.at(-1).speed * 3.6} km/h`);
  assert.ok(after.slice(0, 24).every((o) => o.smoke.amount > 0.3), "smoke / spray through the launch");
});

test("donut: the closed loop holds a steady rotation and steady smoke, two full turns in a 10 s shot", () => {
  for (const surface of ["wet", "dry"]) {
    const { run, metrics: m } = stuntRun("donut", { last: 240, params: { surface } });
    const t = turnedAt(run), end = t.findIndex((x) => x >= 720), hold = run.slice(48, end > 0 ? end : 200), yr = hold.map((o) => Math.abs(o.yawRate)), mean = yr.reduce((a, b) => a + b, 0) / yr.length;
    const cv = Math.sqrt(yr.reduce((a, b) => a + (b - mean) ** 2, 0) / yr.length) / mean;
    assert.ok(m.turned_deg >= 700, `${surface}: ${m.turned_deg}°`);
    assert.ok(mean > 65 && cv < 0.2, `${surface}: steady yaw ${mean.toFixed(0)}°/s, cv ${cv.toFixed(2)}`);
    assert.ok(hold.every((o) => o.smoke.amount > 0.15 && o.smoke.wheels !== "front"), `${surface}: the rears never stop smoking`);
    const xs = hold.map((o) => o.x), zs = hold.map((o) => o.z);
    const box = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    assert.ok(box < 14, `${surface}: circles one spot (${box.toFixed(1)} m across)`);
  }
});

test("handbrake 180: a sharp entry, rotation under 2.5 s, and it drives away the other way", () => {
  for (const surface of ["wet", "dry"]) {
    const { run, metrics: m } = stuntRun("handbrake_180", { params: { surface } });
    assert.ok(m.rotation_s < (surface === "dry" ? 2.0 : 2.5), `${surface}: ${m.rotation_s} s`);
    near(m.turned_deg, 180, 22, `${surface}: ends facing back`);
    assert.ok(run.at(-1).speed * 3.6 > (surface === "dry" ? 25 : 5), `${surface}: drives away at ${(run.at(-1).speed * 3.6).toFixed(0)} km/h`);
    assert.ok(run.some((o) => o.controls.steer < -3), "the feint away before the turn-in");
  }
});

test("smoke vs spray: density follows the slip energy; wet throws low, short-lived, tinted spray", () => {
  const wet = stuntRun("reverse_jturn", {}).run, dry = stuntRun("reverse_jturn", { params: { surface: "dry" } }).run;
  assert.ok(wet.every((o) => o.smoke.kind === "spray") && dry.every((o) => o.smoke.kind === "smoke"));
  assert.ok(wet.slice(0, 24).every((o) => o.smoke.amount === 0), "no slip, no smoke");
  const n = 61, track = { pos: [], yaw: [], vel: [], smoke: [] };
  for (let f = 0; f < n; f++) { track.pos.push([0, 0, f * 0.3]); track.yaw.push(0); track.vel.push([0, 7.2]); track.smoke.push({ amount: f >= 10 && f < 40 ? 1 : 0, wheels: "rear" }); }
  const wheels = [{ x: 0.8, z: -1.3, front: false }, { x: -0.8, z: -1.3, front: false }];
  const sm = smokeParticles(track, wheels, 39, 24, 3, "dry"), sp = smokeParticles(track, wheels, 39, 24, 3, "wet");
  const avg = (a, f) => a.reduce((s, q) => s + f(q), 0) / a.length;
  assert.ok(sp.length && sm.length && sp.every((q) => q.tint) && sm.every((q) => !q.tint));
  assert.ok(avg(sp, (q) => q.p[1]) < avg(sm, (q) => q.p[1]) && avg(sp, (q) => q.size) < avg(sm, (q) => q.size), "spray stays low and small");
  const half = { ...track, smoke: track.smoke.map((s) => ({ ...s, amount: s.amount * 0.4 })) };
  assert.ok(smokeParticles(half, wheels, 39, 24, 3, "dry").length < 0.6 * sm.length, "less slip energy, thinner smoke");
});
