// Practical effects (sfx.mjs) as pure functions, and the blast in the physics bake: impulse falloff by distance and
// mass, triggers (time, contact, chain, manual), the manual cue recorded as a key, fire spread, hit reactions by where
// the hit lands, determinism, and nothing changing before a cue (scrub back = the untouched scene).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as X from "../../web/stage/sfx.mjs";
import { simulate } from "../../web/stage/physics.mjs";
import { worldSpecs } from "../../web/stage/world.mjs";
import { simulateParticles } from "../../web/stage/particles.mjs";

const rig = (kind, id, sfx = {}, position = [0, 0, 0]) => X.makeRig(kind, { id, position, sfx });

test("sfx: the blast falls off with distance, is zero past its radius and moves heavy things less", () => {
  const B = { pos: [0, 0.4, 0], power: 1, radius: 9, lift: X.BLAST_LIFT };
  const crate = (x) => X.blastImpulse(B, { pos: [x, 0.3, 0], mass: 25, half: [0.3, 0.3, 0.3] });
  const dvs = [1, 2, 3, 4, 6, 8].map((x) => crate(x).dv);
  for (let i = 1; i < dvs.length; i++) assert.ok(dvs[i] < dvs[i - 1], `falls off: ${dvs.map((v) => v.toFixed(2)).join(" > ")}`);
  assert.equal(crate(9.5), null, "nothing past the radius");
  assert.equal(X.blastFalloff(9, 9), 0);
  assert.ok(X.blastFalloff(0, 9) > 0.99, "full strength at the charge");
  // A heavier body of the same size: the same impulse, less speed.
  const light = X.blastImpulse(B, { pos: [3, 0.3, 0], mass: 25, half: [0.3, 0.3, 0.3] }), heavy = X.blastImpulse(B, { pos: [3, 0.3, 0], mass: 250, half: [0.3, 0.3, 0.3] });
  assert.ok(Math.abs(light.impulse - heavy.impulse) < 1e-9 && heavy.dv < light.dv / 9);
  // Twice the power, twice the push (below the cap).
  const twice = X.blastImpulse({ ...B, power: 2 }, { pos: [4, 0.3, 0], mass: 25, half: [0.3, 0.3, 0.3] });
  assert.ok(Math.abs(twice.dv - 2 * crate(4).dv) < 1e-9);
  // Up and out, never down; capped.
  assert.ok(crate(2).J[0] > 0 && crate(2).J[1] > 0);
  assert.ok(X.blastImpulse({ ...B, power: 4 }, { pos: [0.5, 0.3, 0], mass: 1, half: [0.1, 0.1, 0.1] }).dv <= X.BLAST_MAX_DV + 1e-9);
  // It acts at the side facing the charge (the near side lifts).
  assert.ok(crate(3).r[0] < 0);
});

test("sfx: in the bake, a power-1 blast rocks a parked car, power 2 rolls or flips it; the man goes down; frames before the cue are untouched", () => {
  const N = 120, hold = (p) => Array.from({ length: N }, () => ({ pos: p, quat: [0, 0, 0, 1] }));
  const crate = { id: "crate", shape: "box", half: [0.3, 0.3, 0.3], center: [0, 0.3, 0], dynamic: true, mass: 25, bounce: 0.2, friction: 0.6, poses: hold([4, 0, 0]), release: 0, material: "wood" };
  const specs = () => [crate, ...worldSpecs({ id: "car", kind: "car", half: [0.9, 0.72, 2.3], center: [0, 0.72, 0], poses: hold([-2.2, 0, 0]), physics: {} }),
    ...worldSpecs({ id: "man", kind: "man", half: [0.3, 0.9, 0.15], center: [0, 0.9, 0], poses: hold([0, 0, 4]), physics: {} })];
  const run = (power) => simulate(specs(), N, { blasts: power ? [{ id: "b", frame: 24, pos: [0, 0.4, 0], power, radius: 9, lift: X.BLAST_LIFT }] : [] });
  const upY = (r, id) => { const q = r.tracks[id][N - 1].quat; return 1 - 2 * (q[0] * q[0] + q[2] * q[2]); };
  const none = run(0), one = run(1), two = run(2);
  assert.deepEqual(none.blasted, {});
  assert.ok(one.takeovers.car?.reason === "blast" && one.takeovers.man?.reason === "blast");
  assert.ok(upY(one, "car") > 0.9, "power 1: rocks and lands back on its wheels");
  assert.ok(Math.abs(one.tracks.car[N - 1].pos[0] - -2.2) < 1.5);
  assert.ok(upY(two, "car") < 0.5, "power 2: rolls or flips");
  assert.ok(upY(one, "man") < 0.3, "the man is knocked down");
  assert.ok(two.blasted.crate > one.blasted.crate && one.blasted.crate > 1);
  for (const id of ["crate", "car", "man"]) assert.deepEqual(one.tracks[id].slice(0, 24), none.tracks[id].slice(0, 24), `${id}: identical before the cue`);
  assert.deepEqual(run(1).tracks, one.tracks, "deterministic");
});

test("sfx: time, chain and manual cues; a loop of chains and a chain on a disarmed rig never fire", () => {
  const rigs = [rig("squib", "a", { trigger: { type: "time", at: 1 } }), rig("explosion", "b", { trigger: { type: "chain", after: "a", delay: 0.5 } }),
    rig("smoke_bomb", "c", { trigger: { type: "chain", after: "b", delay: 0.25 } }),
    rig("fire", "d", { trigger: { type: "chain", after: "e" } }), rig("fire", "e", { trigger: { type: "chain", after: "d" } }),
    rig("flare", "f", { trigger: { type: "chain", after: "g" } }), rig("sparks", "g", { armed: false, trigger: { type: "time", at: 0.5 } }),
    rig("explosion", "h", { trigger: { type: "manual" }, keys: [50, 70] })];
  const F = X.resolveFires(rigs, { fps: 24, frames: 97 });
  assert.deepEqual(F.map((f) => [f.id, f.frame, f.by]), [["a", 24, "time"], ["b", 36, "chain:a"], ["c", 42, "chain:b"], ["h", 70, "manual"]]);
  // A cue past the end of the shot doesn't fire.
  assert.deepEqual(X.resolveFires([rig("squib", "late", { trigger: { type: "time", at: 9 } })], { fps: 24, frames: 97 }), []);
});

test("sfx: Fire records the moment as a key: a one-shot keeps the newest, a squib adds each press (pure)", () => {
  const boom = rig("explosion", "boom");
  const s1 = X.recordManualFire(boom, 30.4);
  assert.deepEqual(s1.keys, [30]);
  assert.equal(s1.trigger.type, "manual");
  assert.equal(boom.sfx.trigger.type, "time", "the rig itself is untouched");
  const s2 = X.recordManualFire({ ...boom, sfx: s1 }, 44);
  assert.deepEqual(s2.keys, [44]);
  const sq = rig("squib", "sq");
  const k1 = X.recordManualFire(sq, 12), k2 = X.recordManualFire({ ...sq, sfx: k1 }, 5);
  assert.deepEqual(k2.keys, [5, 12]);
  assert.deepEqual(X.resolveFires([{ ...sq, sfx: k2 }], { fps: 24 }).map((f) => f.frame), [5, 12]);
});

test("sfx: a contact cue fires at the first hard hit on what it watches (or within its reach)", () => {
  const events = [{ frame: 20, t: 0.833, pos: [5, 0.2, 5], speed: 4, a: "crate", b: "__ground" }, { frame: 31, t: 1.29, pos: [0.2, 0.3, 0], speed: 3, a: "car", b: "wall" },
    { frame: 40, t: 1.67, pos: [0, 0, 0], speed: 0.4, a: "x", b: "y" }];
  const watch = rig("explosion", "w", { trigger: { type: "contact", watch: "car" } }, [9, 0, 9]);
  const near = rig("breakaway_glass", "n", { trigger: { type: "contact" } }, [0, 0, 0]);
  const F = X.resolveFires([watch, near], { fps: 24, events });
  assert.deepEqual(F.map((f) => [f.id, f.frame, f.by]), [["n", 31, "contact:car"], ["w", 31, "contact:car"]]);
  // Proximity (a body through the pane) can fire it earlier.
  assert.equal(X.resolveFires([near], { fps: 24, events, proximity: () => 12 })[0].frame, 12);
});

test("sfx: fire spreads along flammable props in order of distance; metal and far things don't catch", () => {
  const fire = rig("fire", "fire", { trigger: { type: "time", at: 0.5 } }, [0, 0, 0]);
  const box = (id, x, material = "cardboard") => ({ id, pos: [x, 0.3, 0], half: [0.3, 0.3, 0.3], material });
  const fl = [box("b1", 0.6), box("b2", 1.3), box("b3", 2.0), box("w", 2.6, "wood"), box("m", 0.5, "metal"), box("far", 9)];
  const F = X.resolveFires([fire], { fps: 24 });
  const B = X.burnSchedule([fire], F, fl, { fps: 24, frames: 400 });
  assert.ok(B.b1 && B.b2 && B.b3 && B.w);
  assert.ok(B.b1.frame < B.b2.frame && B.b2.frame < B.b3.frame && B.b3.frame < B.w.frame, JSON.stringify(B));
  assert.equal(B.b2.by, "b1");
  assert.ok(!B.m && !B.far);
  assert.deepEqual(X.burnSchedule([fire], F, fl, { fps: 24, frames: 400 }), B, "deterministic");
});

test("sfx: hit reactions by where the hit lands: chest falls back, an arm flinches and stays up, a leg buckles to the knee", () => {
  const chest = X.hitReaction("chest", 1), arm = X.hitReaction("arm_l", 1), leg = X.hitReaction("leg_r", 1), back = X.hitReaction("back", 1);
  assert.equal(chest.fall, "back"); assert.equal(chest.clutch, "both"); assert.ok(chest.lean > 0);
  assert.equal(arm.fall, null); assert.equal(arm.clutch, "r", "the other hand goes to a left-arm hit");
  assert.equal(leg.fall, "knee");
  assert.equal(back.fall, "forward"); assert.ok(back.lean > 0, "pushed away from the hit");
  assert.equal(X.hitReaction("chest", 0.5).fall, null, "a light gag staggers but stays up");
  assert.equal(X.hitReaction("chest", 0.5, { fall: true }).fall, "back", "unless the fall is asked for");
  assert.ok(X.hitReaction("chest", 2).jolt > chest.jolt, "a harder hit snaps harder");
  const stab = X.hitReaction("belly", 1, { kind: "stab" });
  assert.ok(stab.lean < 0 && stab.clutch === "both", "a stab doubles him over");
  // Over time: nothing before, a fast snap, then the fall.
  assert.deepEqual(X.reactionAt(chest, -0.01), { lean: 0, twist: 0, drop: 0, back: 0, clutch: 0, down: 0, fall: "back" });
  assert.ok(X.reactionAt(chest, 0.1).lean > 0.8 * chest.lean, "the snap reads in 2-3 frames");
  assert.equal(X.reactionAt(chest, 0.3).down, 0);
  assert.equal(X.reactionAt(chest, 2).down, 1);
});

test("sfx: wounds persist from the hit; before it there are none (scrub back = clean wardrobe)", () => {
  const sq = rig("body_squib", "sq", { target: "man", point: "shoulder_l", trigger: { type: "time", at: 1 } });
  const stab = rig("stab", "kn", { target: "man", trigger: { type: "time", at: 2 } });
  const F = X.resolveFires([sq, stab], { fps: 24 });
  assert.deepEqual(X.woundsAt([sq, stab], F, 23, { fps: 24 }), []);
  const w = X.woundsAt([sq, stab], F, 90, { fps: 24 });
  assert.deepEqual(w.map((x) => [x.point, x.kind]), [["shoulder_l", "squib"], ["belly", "slash"]]);
  assert.ok(w[0].stain > 0.9 && w[0].trickle > 0.05, "the stain spread and the blood ran");
  const H = X.bodyHits([sq, stab], F);
  assert.deepEqual(H.man.map((h) => h.point), ["shoulder_l", "belly"]);
  assert.deepEqual(X.personReactionAt(H.man, 23, { fps: 24 }).lean, 0);
});

test("sfx: the effects are deterministic and nothing shows before a cue (emitters, particles, light, shake, scorch)", () => {
  const rigs = [rig("explosion", "boom", { trigger: { type: "time", at: 1 }, power: 1.4 }), rig("squib", "sq", { surface: "water", trigger: { type: "time", at: 0.5 } }, [2, 0, 1]),
    rig("smoke_bomb", "sb", { color: "red", trigger: { type: "time", at: 1.5 } }, [-3, 0, 0]), rig("sparks", "sp", { trigger: { type: "time", at: 2 } }, [0, 3, 2]),
    rig("flare", "fl", { trigger: { type: "time", at: 0.2 } }, [1, 0, -2]), rig("breakaway_glass", "gl", { trigger: { type: "time", at: 2.5 } }, [0, 0, 3])];
  const F = X.resolveFires(rigs, { fps: 24 });
  const em1 = X.sfxEmitters(rigs, F, { fps: 24, frames: 97 }), em2 = X.sfxEmitters(rigs, F, { fps: 24, frames: 97 });
  assert.deepEqual(em1, em2);
  assert.ok(em1.every((e) => e.t >= 0.2 - 1e-9), "no emitter before the first cue");
  const sim = simulateParticles(em1, { frames: 97, fps: 24 }), sim2 = simulateParticles(em2, { frames: 97, fps: 24 });
  assert.deepEqual(sim.frames.map((f) => f.n), sim2.frames.map((f) => f.n));
  assert.equal(sim.frames[3].n.dust + sim.frames[3].n.debris + sim.frames[3].n.sparks, 0, "frame 3: nothing yet");
  assert.ok(sim.frames[30].n.dust > 60, "the fireball at 1.25 s");
  assert.ok(sim.frames[30].dust.some((_, i) => i % 10 === 9 && sim.frames[30].dust[i] >= 4), "and it is self-lit (glow flag)");
  assert.deepEqual(X.sfxLightsAt(rigs, F, 3, { fps: 24 }), []);
  assert.ok(X.sfxLightsAt(rigs, F, 25, { fps: 24 })[0].intensity > 40, "the flash");
  assert.deepEqual(X.sfxShakeAt(rigs, F, 20, [0, 1.6, 8], { fps: 24 }), { pos: [0, 0, 0], aim: [0, 0, 0] });
  const sh = X.sfxShakeAt(rigs, F, 27, [0, 1.6, 8], { fps: 24 });
  assert.ok(Math.hypot(...sh.pos) > 0.005, "the camera shakes once the shockwave arrives");
  const sc = X.scorchMarks(rigs, F);
  assert.deepEqual(sc.map((m) => m.id), ["fl", "boom"], "the flare and the explosion mark the ground; the water squib doesn't");
});

test("sfx: settings are clamped and defaulted; an unknown kind is not a rig", () => {
  const a = rig("explosion", "x", { power: 99, trigger: { type: "bogus", at: -3 } });
  const s = X.sfxOf(a);
  assert.equal(s.power, 4); assert.equal(s.trigger.type, "time"); assert.equal(s.trigger.at, 0);
  assert.equal(X.sfxOf({ kind: "sfx_nuke" }), null);
  assert.equal(X.isSfxRig({ kind: "crate" }), false);
  assert.throws(() => X.makeRig("nuke"));
  for (const k of Object.keys(X.SFX_KINDS)) assert.ok(X.sfxOf(rig(k, k)), k);
});
